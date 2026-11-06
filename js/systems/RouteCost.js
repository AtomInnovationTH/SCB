/**
 * RouteCost - what a ROUTE costs her: any order of visits (fields, pieces, the resupply satellite), priced by her changing
 * mass and the gas still aboard, plus a search for the best orders (plan route-1101, lane R1; owner 2026-11-01: she chooses
 * a route through debris "by mass changes and remaining delta-v", for any piece with credit or salvage value).
 *
 * PURE except two counters and the trip cache: numbers in, numbers out. It imports no system that has state (FieldRegistry
 * imports THIS file, never the other way round; ScoringSystem is passed in by the caller, `pieceValue`).
 *
 * LIVE in the game: `transferLeg` (FieldRegistry.planTo prices every where-next field row through it) and, since route-1101 lane
 * R2, the walk and the search (js/systems/RoutePlanner.js feeds them to the Routes section of the where-next list). They also
 * serve scripts/route-report.mjs and js/test/test-RouteCost.js.
 *
 * The rules of a route (lane R2; DECISIONS §62 rows 1-3, §49 row 2):
 *   - MISSIONS. A mission is `MISSIONS.DEBRIS_PER_MISSION` (5) credited catches (ScoringSystem.js:465 `getMissionNumber`) and she can
 *     leave a field only between missions (WhereNextRows.js:166 and :384: field and push rows are 'mission', not pickable, while one
 *     goes on; `startOwed` = `GameFlowManager.missionStartOwed` :3297). So a route is segments: the catches that finish the mission she
 *     is in (`state.catchesLeft`), one move, the next field's 5 catches, one more move. A move before the quota is full is allowed
 *     only by filling it with ordinary catches that are not priced (value 0, mass 0: "+N unscanned"). No rule ends a mission early:
 *     the list opens mid-mission only when she is out of gas (`startOwed` false), and she then goes on with Stay. At most
 *     `state.maxMoves` (default `MAX_MOVES` 2) moves: beyond that no piece is known.
 *   - FEE (D4). A big piece's removal fee is not paid at the catch (§49 row 2). The walk counts it only when the route takes that
 *     piece to a `sat` (hand-over), `push` (down to its 25-year height, let go) or `melt` (the furnaces, on the next trips); a piece
 *     still aboard at the end counts none. Hand-over adds the parts and collector pay, a melt the fee less the owner's share of the
 *     metal, and the metal it leaves in the hold is on her mass until a satellite buys it (at the in-orbit price).
 *   - HOLD (D5). A catch over `CAPTURE_NET.LARGE.CATCH_LIMIT_KG` is refused (CaptureNet.js:778-798), and a big piece needs a place to
 *     sit: the collar, a daughter's rack or a radiator tip (`state.holdSlots`; the "nose full" rule, CaptureNet.js getNoseFullLine
 *     :4407, refuses the next net while the collar holds a piece with nowhere to go). No gas reserve exists in the game.
 *
 * The legs:
 *   transferLeg   field to field, the real low-thrust profile (TripProfile.tripProfile) at her live mass; exact.
 *   planeLeg      a change of orbit plane (tilt and node, `planeAngle`), low thrust: Edelbaum, pi/2 x the impulsive price for a
 *                 small angle. Every field shares her plane today, so it answers 0 there.
 *   finishBurn    the last node gap to the station (<= 0.346 deg, <= 57 m/s), billed at the station's 408 km, only for the start whose tilt is the
 *                 station's (route-1106 lane S4; `NodeDrift.stationInOwnPlane`): the walker's station stop pays it before the part, the game's
 *                 `finishStationBurn` bills it.
 *   approachLeg   the autopilot's close-in flight to a piece, billed gas by distance and her mass (a MEASURED table below).
 *   daughterLeg   a daughter's fetch, billed from her own tank the way the game bills it (never from the mother's).
 *   pieceValue    what a piece is worth, from the game's own pay code (never copied prices).
 * `walkRoute` runs a list of stops through them; `bestRoutes` searches the orders.
 *
 * Mass: her mass on a leg is `dryMassKg + carriedKg + gasKg` (everything that is not engine gas, plus what she carries, plus the
 * engine gas aboard). A kept catch adds its mass to every later leg (the catch joins her mass, ArmManager.getCargoMassKg ->
 * getMassBudget); a hand-over at the satellite leaves it there (DECISIONS §49 row 2); a let-go bag adds nothing (§49 row 8). The metal already
 * in the hold and the part kept for the station weigh too (plan hold-mass-1106: `holdKg`, `partKg`, inside `carriedKg` from the start): the first
 * satellite stop sells the hold's metal (`holdSaleCr`) and it leaves her mass there; the kept part stays aboard through a satellite stop and
 * leaves at the station stop that pays it.
 * Feasible means every leg's gas fits what is aboard, the rule `FieldRegistry.planTo` calls `enough`; no reserve rule exists.
 * @module systems/RouteCost
 */
import { Constants } from '../core/Constants.js';
import { tripProfile } from './TripProfile.js';
import { planeAngle, planeChangeDeltaV } from '../entities/OrbitalMechanics.js';
import { pieceValues } from './BigPieceValues.js';
import { isJobPiece, jobPayCr } from './JobsBoard.js';
import { planBurn } from './BigMelt.js';
import { gapChangeOverLeg, isLinedUp, stationInOwnPlane, stationOrbit } from './NodeDrift.js';

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

/**
 * The finish burn: closing a small node gap to the station (route-1106 lane S4, D3; station-drift doc §2: 164.7 m/s per degree, so at most
 * 0.346 deg = 57 m/s). Billed only for the start whose tilt is the station's (`stationInOwnPlane`); every other tilt and a gap of 0 cost
 * nothing. Priced at the station's own height (408 km), where her node turns at the station's rate and the gap does not move during the
 * burn: an Edelbaum `planeLeg` from her plane (her tilt, node 0) to the station's (its tilt, node = the gap).
 * @param {{gapDeg: number, herIncDeg: number, massKg: number, thrustN: number, ispS: number, gasAboardKg?: number}} a
 * @returns {{dvMps: number, gasKg: number, days: number, feasible: boolean}}
 */
export function finishBurn(a) {
  const none = { dvMps: 0, gasKg: 0, days: 0, feasible: true };
  if (!stationInOwnPlane(a.herIncDeg) || !Number.isFinite(a.gapDeg) || a.gapDeg === 0) return none;
  const s = stationOrbit();
  const D2R = Math.PI / 180;
  const r = planeLeg({
    fromOrbit: { altKm: s.altKm, inclination: a.herIncDeg * D2R, raan: 0 },
    toOrbit: { altKm: s.altKm, inclination: s.incDeg * D2R, raan: a.gapDeg * D2R },
    massKg: a.massKg, thrustN: a.thrustN, ispS: a.ispS, gasAboardKg: a.gasAboardKg,
  });
  return { dvMps: r.dvMps, gasKg: r.gasKg, days: r.days, feasible: r.feasible };
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
 *              apart (`totals.feeCr`). It is not tapered (`awardDisposal`, ScoringSystem.js:336). For the piece of an open job
 *              (`ctx.jobPostings`) it is the job's pay in place of the ordinary fee: mass x 270 (A) or x 30 (B) cr/kg, or the flat press pay
 *              (`JobsBoard.jobPayCr`)
 *   kept       the catch stays aboard and joins her mass; false for a let-go bag (DECISIONS §49 row 8)
 * The callers pass the two pure pay helpers of ScoringSystem.js (importing that module here would build its singleton).
 * @param {{type: string, mass: number, tumbleRate?: number, owner?: object, salvage?: {metals?: Array<{subtype?: string, amount?: number}>}}} piece
 * @param {{scoringSystem: {calculateScore: Function}, captureTier: number, kept?: boolean, captureCreditsEarned?: number,
 *   taperMultiplier: Function, computeSaleValue: Function, jobPostings?: object[]}} ctx `captureTier`: ScoringSystem's `CAPTURE_TIERS.CAPTURE`;
 *   `taperMultiplier` and `computeSaleValue` the exports of ScoringSystem.js; `jobPostings` the board's postings (`GameFlowManager.jobPostings()`)
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
  const massKg = Number.isFinite(piece.mass) ? piece.mass : 0;
  // A removal job's stage (js/systems/JobsBoard.js; the caller passes the board's open postings): the job pays mass x its rate INSTEAD of
  // the ordinary fee, so `feeCr` is the job pay. Any other piece, or no postings, is the ordinary fee as before.
  const job = Array.isArray(ctx.jobPostings) ? ctx.jobPostings.find((p) => p && (p.kind === 'removal' || p.kind === 'press') && isJobPiece(p, piece)) : null;
  const feeCr = job ? jobPayCr(job, massKg) : pieceValues(piece).removalFeeCr;
  // The insurer's job (JobsBoard kind 'insurer', plan route-1101 J5): its flat pay comes ON TOP of a satellite hand-over of its piece, never of a push or a melt.
  // It rides on the value (`insurerCr`), not on the piece's `big` info: `RoutePlanner.bigInfo` is memoized by the piece's type and mass and would go stale.
  const ins = Array.isArray(ctx.jobPostings) ? ctx.jobPostings.find((p) => p && p.kind === 'insurer' && isJobPiece(p, piece)) : null;
  return { creditsCr, salvageCr, feeCr, massKg, kept, valueCr: creditsCr + salvageCr + feeCr, basis: PAY_BASIS, ...(ins ? { insurerCr: jobPayCr(ins, massKg) } : {}) };
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
 * @property {number} carriedKg   what she carries (its mass is on every later leg): the catches aboard, the metal in the hold and the part kept for the station
 *                                (plan hold-mass-1106: the same sources her live mass adds, so `dryMassKg` stays her true dry mass)
 * @property {number} [holdKg]    the metal already in the hold, kg (inside `carriedKg`); the route's first satellite stop sells it and it leaves her mass there
 * @property {number} [holdSaleCr] what that metal sells for at the satellite (SELL ALL, `_strandedCargoCredits`); counted in the search's value bounds until sold
 * @property {number} [partKg]    the part kept for the station's part job, kg (inside `carriedKg`, with `partAboard`): it stays aboard through a satellite stop and leaves at
 *                                the station stop that pays it
 * @property {number} altKm       her height now
 * @property {number} thrustN     `realThrustN(fuel)`
 * @property {number} ispS        the Isp the tank is billed at (the gas's, over c)
 * @property {number} [areaM2]    her drag area (`tripDragAreaM2`)
 * @property {number} [cos]       share of the push that goes the way she wants (default 1)
 * @property {string} [fieldId]   the field she is at, if any (pieces in it cost no transfer)
 * @property {{x: number, y: number, z: number}|null} [posM]  where she is inside that field, metres in the frame of her arrival (null = the arrival point)
 * @property {number} [catchesLeft]  catches that finish the mission she is in (0 = at a mission boundary, the default; a move is free then)
 * @property {number} [stepS]        game seconds per step of the exact transfer profile (default `TRIP.PROFILE_STEP_S`; a coarser step is
 *                                   cheaper and gives the same delta-v to 3 decimals: the panel uses 300)
 * @property {number} [maxMoves]     moves allowed (default `MAX_MOVES`)
 * @property {number} [holdSlots]    places a big piece can sit (collar, racks, tips); default no limit
 * @property {number} [holdRoomKg]   room in the hold for melted metal, kg; default no limit
 * @property {number} [furnaces]     free furnaces (default 4, the radiator tips)
 * @property {number} [catchLimitKg] the heaviest catch (default `CAPTURE_NET.LARGE.CATCH_LIMIT_KG`)
 * @property {number} [unscannedApproachM] the approach distance of a catch nobody priced, metres (default `UNSCANNED_APPROACH_M` by field: an estimate; 0 = free)
 * @property {Array<{id: string, massKg: number, stop: object}>} [held] big pieces she already holds (`stop` as a piece stop: `value`, `big`)
 *
 * A stop is one of:
 *   {kind: 'field', id, altKm}                         a transfer to a field (arrive at the arrival point; a mission starts there)
 *   {kind: 'sat', id?, altKm}                          the resupply satellite: a transfer; the big pieces aboard are handed over, the
 *                                                      orbit metal is sold
 *   {kind: 'piece', id, altKm, fieldId?, posM?, value, big?}  a transfer to the piece's height if she is not there, an approach, a catch
 *                                                      (`value` from `pieceValue`; its `kept` adds the mass to every later leg; `big`:
 *                                                      {pushKm, satExtraCr, melt: {partKg, metalPerKg, shareCr}} for a big piece)
 *   {kind: 'push', pieceId, pushKm}                    take that piece (aboard) down to `pushKm`, let go; pays its fee
 *   {kind: 'melt', pieceId, melt}                      mark that piece (aboard) for the furnaces: they melt it during the next transfers
 *   {kind: 'station', id, fieldId, altKm, payCr}       (route-1101 J5 Task 12) a transfer to the station field as a `field` stop is (a mission starts there);
 *                                                      if the part for the station's part job is aboard and the node gap (`state.gapDeg`, moved by every leg's days)
 *                                                      is within `linedUpDeg` on arrival, the station takes it and pays `payCr` (`totals.partCr`)
 *
 * The node gap (`state.gapDeg`, `state.incDeg`): the walker moves it by `NodeDrift.gapChangeOverLeg` for every leg that takes days (a transfer from its height
 * samples, an approach at the height she holds); without both numbers it is not tracked and a station stop pays nothing. `state.partAboard` (true: the part is
 * aboard at planning). A melt of the piece the part job names (`stop.partJob`) keeps its first part whole (`applyMelts`, as the game's `_meltKeepPart`): the part
 * is aboard from then on. NOT modelled: the turn she flies first (`daysWithTurnWait`), a wait to line up (the list's own wait row), the rest of the gap's drift
 * during a mission's catches (only approach days are counted).
 */

/** Moves a route may hold (the current mission, then at most this many moves; beyond it no piece is known). */
export const MAX_MOVES = 2;
const quotaOf = () => Constants.MISSIONS.DEBRIS_PER_MISSION;

const stopValueCr = (s) => (s && s.value ? (s.value.valueCr ?? ((s.value.creditsCr || 0) + (s.value.salvageCr || 0) + (s.value.feeCr || 0))) : 0);
/**
 * An upper bound of what taking a stop can add to any route (the exact search's ceiling): the piece's value (catch, salvage and fee) plus the
 * most its disposal can add beyond the fee: a hand-over's parts and collector pay (`satExtraCr`), or the metal of a melt at the in-orbit price
 * (a melt pays the fee less the owner's share, so the fee itself is already counted). A piece's disposal is a stop of its own with no value of
 * its own, so without this the search would cut a route whose best part is a hand-over or a melt of a piece not yet caught. The station stop's pay
 * counts in full (the part may be aboard by then).
 */
export const stopCeilingCr = (s) => {
  if (s && s.kind === 'station') return Math.max(0, s.payCr || 0);
  const base = stopValueCr(s);
  const big = s && s.big;
  if (!big) return base;
  const metal = (s.value && s.value.massKg || 0) * ((big.melt && big.melt.metalPerKg) || 0) * Constants.BIG_PIECES.IN_ORBIT_CR_PER_KG;
  const insurer = (s.value && s.value.insurerCr) || 0;                // the insurer's job pays on top of a hand-over only (JobsBoard kind 'insurer')
  return base + Math.max((big.satExtraCr || 0) + insurer, metal);
};
const stopCatchCr = (s) => (s && s.value ? (s.value.creditsCr || 0) + (s.value.salvageCr || 0) : 0);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** What taking a big piece to `fate` ('satellite' | 'push') pays: its fee as `pieceValue` says (a job's pay included), plus a hand-over's parts and collector pay. */
const disposalPay = (stop, fate) => (stop && stop.value ? (stop.value.feeCr || 0) : 0)
  + (fate === 'satellite' && stop && stop.big ? (stop.big.satExtraCr || 0) : 0)
  + (fate === 'satellite' && stop && stop.value ? (stop.value.insurerCr || 0) : 0);     // the insurer's flat pay (J5): a hand-over of its piece only
/** Metal sold at a satellite: a lot of `BULK_THRESHOLD_KG` or more nets the in-orbit price per kg (`metalListedCrPerKg`), a smaller lot loses the bulk bonus. */
function metalSaleCr(kg) {
  const price = Constants.BIG_PIECES.IN_ORBIT_CR_PER_KG;
  const m = Constants.MARKET || {};
  return kg * price * (kg >= (m.BULK_THRESHOLD_KG || 50) ? 1 : 1 / (m.BULK_BONUS_MULTIPLIER || 1.15));
}
/** What melting a piece (all of it) is worth: the fee less the owner's share of its metal, plus the metal at the in-orbit price (sold at a satellite). */
const meltPay = (stop, massKg, frac = 1) => {
  const m = stop && stop.big && stop.big.melt;
  if (!m) return 0;
  return frac * (Math.max(0, disposalPay(stop, 'push') - (m.shareCr || 0)) + massKg * (m.metalPerKg || 0) * Constants.BIG_PIECES.IN_ORBIT_CR_PER_KG);
};
/** The most a big piece still aboard can pay when it is disposed of (the search's upper bound and the beam's look-ahead). */
const potentialCr = (w) => {
  let s = w.partAboard && !w.partPaid ? (w.partCr || 0) : 0;         // the part aboard for the station's part job: the station stop pays it
  s += w.holdSaleCr || 0;                                            // the hold's metal, until a satellite stop sells it (plan hold-mass-1106): pruning must not drop the route that sells it
  for (const a of w.aboard) {
    if (a.melting) { const m = w.melts.find((x) => x.id === a.id); s += m ? meltPay(a.stop, a.massKg, m.leftKg / m.massKg) : 0; continue; }
    s += Math.max(disposalPay(a.stop, 'satellite'), disposalPay(a.stop, 'push'), meltPay(a.stop, a.massKg));
  }
  return s;
};

/**
 * The search prices transfers with `transferLegFast`, which is within `FAST_GAS_TOLERANCE` of the real profile (test (c) holds it).
 * So in the search a leg fits when it does with that much of the gas used so far given back (or taken): a route at the tank's edge
 * is kept for the exact re-price to judge, never cut on a fast price. The exact walk (`walkRoute`) allows nothing.
 */
export const FAST_GAS_TOLERANCE = 0.005;
const fitsGas = (w, gasKg, fast) => gasKg <= w.gasKg + (fast ? FAST_GAS_TOLERANCE * (w.gasUsedKg + gasKg) : 0) + 1e-9;

function freshWalk(state) {
  const held = Array.isArray(state.held) ? state.held : [];
  // a piece already marked for the furnaces starts the route melting (`h.melting`: {leftKg, wholeKg, feeCr}), as the game's next burn will treat it
  const melts = [];
  for (const h of held) {
    const m = h.melting && h.stop && h.stop.big && h.stop.big.melt;
    if (m && m.partKg > 0) melts.push({ id: h.id, massKg: h.melting.wholeKg, leftKg: h.melting.leftKg, partKg: m.partKg, metalPerKg: m.metalPerKg, feeCr: h.melting.feeCr, shareCr: m.shareCr || 0, keep: !!h.stop.partJob && h.melting.leftKg >= h.melting.wholeKg - 1e-9 });
  }
  return {
    dryMassKg: state.dryMassKg, gasKg: state.gasKg, carriedKg: state.carriedKg || 0, altKm: state.altKm,
    fieldId: state.fieldId ?? null, posM: state.posM || null,
    gasUsedKg: 0, days: 0, valueCr: 0, feeCr: 0, metalCr: 0, ok: true,
    // the station's part job (J5 Task 12): the node gap as the route's days move it (null = not tracked), the part aboard, what the station paid
    gapDeg: Number.isFinite(state.gapDeg) && Number.isFinite(state.incDeg) ? state.gapDeg : null,
    partAboard: !!state.partAboard, partPaid: false, partCr: Number.isFinite(state.partCr) ? state.partCr : 0, partPaidCr: 0,
    partKg: state.partAboard && state.partKg > 0 ? state.partKg : 0,   // the kept part's mass (in `carriedKg`): it stays aboard until the station pays it
    holdKg: state.holdKg > 0 ? state.holdKg : 0, holdSaleCr: state.holdSaleCr > 0 ? state.holdSaleCr : 0,   // the hold's metal and what the first satellite stop sells it for
    left: Math.max(0, Math.min(quotaOf(), Math.floor(Number(state.catchesLeft) || 0))),   // catches still owed to the mission she is in
    moves: 0, unscanned: 0, metalKg: 0,
    holdRoomKg: Number.isFinite(state.holdRoomKg) ? state.holdRoomKg : Infinity,
    aboard: held.map((h) => ({ id: h.id, massKg: h.massKg, stop: h.stop, melting: !!h.melting && melts.some((m) => m.id === h.id) })),   // big pieces aboard (arrays are replaced, never edited: clones share them)
    melts,                                                           // pieces marked for the furnaces: {id, massKg, leftKg, partKg, metalPerKg, feeCr, shareCr}
    sigDone: '', sigGroup: [], shape: '',                            // the route's shape (a segment's pieces as a set; the moves alone), to drop reorderings of one route
  };
}

/** The route's shape so far: finished segments (their pieces sorted) and the open one. */
const sigOf = (w) => w.sigDone + w.sigGroup.slice().sort().join(',');
function sigMove(w, token) { w.sigDone += `${w.sigGroup.slice().sort().join(',')}>${token};`; w.sigGroup = []; w.shape += `${token};`; }

/** The node gap moves by the station's rate minus hers over a leg's `days` (NodeDrift.gapChangeOverLeg); `samples` only for an exact transfer. Not tracked: nothing. */
function advanceGap(w, state, days, fromKm, altKm, samples) {
  if (w.gapDeg === null || !(days > 0)) return;
  w.gapDeg += gapChangeOverLeg({ days, fromKm, altKm, samples }, state.incDeg);
}

/**
 * The close-in approach distance a catch nobody priced is flown at, metres. ESTIMATE, not a rule of the game: the pieces of an ordinary field
 * (350-450 km) lie a median 170-238 m from where she arrives (mission 3 rig, probe tmp/route2/probe5.mjs: f375 186, f400 238, f425 170,
 * f450 224; f350 559 with the start field's few pieces), the high fields (750-900 km) a median of 620-628 m (the same rig; mission 1,
 * with only the 7 tracked rows, 988-1,083 m). `approachLeg` prices it in gas and seconds from the measured table.
 */
export const UNSCANNED_APPROACH_M = { low: 200, high: 600 };
export const HIGH_FIELD_FROM_KM = 700;

/**
 * Fill the quota with ordinary catches nobody priced ("+N unscanned"): the way a route leaves a field before its 5th catch. Each is flown
 * to at the estimated typical approach (`UNSCANNED_APPROACH_M`) at her mass then, so it costs gas and time like any catch; false when the
 * tank cannot pay it. `x` = {state, fast, legs, stopIndex} (the walk's own context).
 */
function fillQuota(w, steps, x) {
  if (w.left > 0) {
    const n = w.left;
    let ok = true;
    if (x) {
      const given = x.state && x.state.unscannedApproachM;                // a state may say its own distance (0 = the unscanned catches cost nothing: tests of the legs alone)
      const distanceM = Number.isFinite(given) ? given : (w.altKm >= HIGH_FIELD_FROM_KM ? UNSCANNED_APPROACH_M.high : UNSCANNED_APPROACH_M.low);
      for (let i = 0; i < n && ok && distanceM > 0; i++) {
        const massKg = w.dryMassKg + w.carriedKg + w.gasKg;
        const ap = approachLeg({ distanceM, massKg });
        ok = ap.ok && fitsGas(w, ap.gasKg, x.fast);
        w.gasKg -= ap.gasKg; w.gasUsedKg += ap.gasKg; w.days += ap.days; advanceGap(w, x.state, ap.days, w.altKm, w.altKm);
        if (x.legs) x.legs.push({ kind: 'approach', stop: x.stopIndex, distanceM, gasKg: ap.gasKg, days: ap.days, massKg, gasLeftKg: w.gasKg, ok, unscanned: true });
      }
    }
    if (steps) steps.push({ kind: 'fill', n, fieldId: w.fieldId });
    w.unscanned += n;
    w.left = 0;
    return ok;
  }
  return true;
}

/**
 * The furnaces work during a trip's burn (`planBurn`, BigMelt.js:91: parts of 5 kg a stage / 11 kg a satellite, delivered one at a
 * time, `FURNACE_S_PER_KG` per kg per furnace, the hold's room limits the metal). The pieces marked for melting get this transfer's
 * days. The game pays a part when it melts (`meltAccount`, BigMelt.js:148): the fee for its share of the piece, less the owner's share
 * of its metal; the metal goes into the hold, on her mass until a satellite buys it.
 */
function applyMelts(w, days, state, steps) {
  if (!w.melts.length || !(days > 0)) return;
  const furnaces = Number.isFinite(state.furnaces) ? state.furnaces : 4;
  const plan = planBurn({
    burnShipS: days * SECONDS_PER_DAY,
    pieces: w.melts.map((m) => ({ id: m.id, kg: m.leftKg, partKg: m.partKg, metalPerKg: m.metalPerKg })),
    tips: Array.from({ length: furnaces }, (_, i) => i), roomKg: w.holdRoomKg,
  });
  if (!plan.parts.length) return;
  const done = {};
  for (const p of plan.parts) done[p.pieceId] = (done[p.pieceId] || 0) + p.kg;
  let paid = 0; let meltedKg = 0; let keptKg = 0; let keptMetalKg = 0; const finished = [];
  w.melts = w.melts.map((m) => {
    const kg = done[m.id] || 0;
    if (!(kg > 0)) return m;
    const f = kg / m.massKg;
    let pay = Math.max(0, m.feeCr * f - m.shareCr * f);
    let keepNow = false;
    // The station's part job (J5, the game's `_meltKeepPart`): the posted piece's first part is set aside whole, not melted: its share of the fee is paid without the
    // owner's share of metal, no metal is made for it, and it stays aboard (it is never the piece's last part). One part per job.
    if (m.keep && !w.partAboard && m.leftKg >= m.massKg - 1e-9 && m.partKg < m.leftKg - 1e-9) {
      keepNow = true;
      const k = Math.min(m.partKg, kg);
      pay += m.shareCr * (k / m.massKg);
      keptKg = k; keptMetalKg = k * (m.metalPerKg || 0);
      w.partAboard = true; w.partKg = k;
      if (steps) steps.push({ kind: 'keep', id: m.id, kg: k });
    }
    paid += pay; meltedKg += kg;
    const left = m.leftKg - kg;
    if (left <= 1e-6) { finished.push(m.id); if (steps) steps.push({ kind: 'dispose', fate: 'melt', id: m.id, payCr: pay }); }
    return { ...m, leftKg: Math.max(0, left), ...(keepNow ? { keep: false } : {}) };
  }).filter((m) => m.leftKg > 1e-6);
  if (finished.length) w.aboard = w.aboard.filter((a) => !finished.includes(a.id));
  w.valueCr += paid; w.feeCr += paid;
  const metalKg = plan.metalKg - keptMetalKg;                         // the kept part makes no metal
  w.carriedKg = Math.max(0, w.carriedKg - (meltedKg - keptKg) + metalKg);   // (the kept part stays on her mass)
  w.metalKg += metalKg; w.holdRoomKg -= metalKg + keptKg;
}

/** Run one stop on a walk state `w` (mutated), pushing legs onto `legs` (or not, when null); false when a leg or a rule does not allow it. */
function runStop(w, stop, state, legs, fast, stopIndex, steps) {
  const transfer = fast ? transferLegFast : transferLeg;
  const cos = state.cos === undefined ? 1 : state.cos;
  const maxMoves = Number.isFinite(state.maxMoves) ? state.maxMoves : MAX_MOVES;
  const quota = quotaOf();
  const doTransfer = (toKm) => {
    const massKg = w.dryMassKg + w.carriedKg + w.gasKg;
    const args = { fromKm: w.altKm, toKm, massKg, thrustN: state.thrustN, ispS: state.ispS, areaM2: state.areaM2, cos, stepS: state.stepS };
    // a climb the engine cannot finish inside the game's own limit is not run (a heavy hold would spend seconds of CPU finding that out)
    const t = climbTooLong(args) ? { ok: false, gasKg: 0, days: 0 } : transfer(args);
    const fits = t.ok && fitsGas(w, t.gasKg, fast);
    w.gasKg -= t.gasKg; w.gasUsedKg += t.gasKg; w.days += t.days;
    advanceGap(w, state, t.days, w.altKm, toKm, t.profile && t.profile.samples);          // before `altKm` moves: the leg's own heights
    w.altKm = toKm;
    if (legs) legs.push({ kind: 'transfer', stop: stopIndex, toKm, gasKg: t.gasKg, days: t.days, massKg, gasLeftKg: w.gasKg, ok: fits });
    if (fits) applyMelts(w, t.days, state, steps);
    return fits;
  };
  /** A move is a where-next pick: only at a mission boundary (the quota is filled first), and only `maxMoves` of them. */
  const beginMove = () => {
    if (w.moves >= maxMoves) return false;
    if (!fillQuota(w, steps, { state, fast, legs, stopIndex })) return false;
    w.moves++;
    return true;
  };
  const aboardPiece = (id) => w.aboard.find((a) => a.id === id && !a.melting) || null;
  if (stop.kind === 'piece') {
    const v = stop.value || {};
    const kept = v.kept !== false;
    const limit = Number.isFinite(state.catchLimitKg) ? state.catchLimitKg : Constants.CAPTURE_NET.LARGE.CATCH_LIMIT_KG;
    if ((v.massKg || 0) > limit) return false;                       // "Too heavy for us" (CaptureNet.js:778-798)
    const slots = Number.isFinite(state.holdSlots) ? state.holdSlots : Infinity;
    if (kept && stop.big && w.aboard.length >= slots) return false;  // nowhere to hold it
    if (w.altKm !== stop.altKm || (stop.fieldId && stop.fieldId !== w.fieldId)) {
      if (!beginMove()) return false;
      if (!doTransfer(stop.altKm)) return false;
      w.posM = null; w.fieldId = stop.fieldId ?? null;
      w.left = quota;                                                // a mission starts where she arrives
      if (steps) steps.push({ kind: 'move', what: 'field', stop: stopIndex, id: w.fieldId, altKm: stop.altKm });
      sigMove(w, `f:${w.fieldId}`);
    } else if (w.left === 0) {
      w.left = quota;                                                // a Stay: the next mission here
      if (steps) steps.push({ kind: 'stay', stop: stopIndex });
    }
    const massKg = w.dryMassKg + w.carriedKg + w.gasKg;
    const here = w.posM || { x: 0, y: 0, z: 0 };
    const target = stop.posM || here;
    const distanceM = dist3(here, target);
    const ap = approachLeg({ distanceM, massKg });
    const fits = ap.ok && fitsGas(w, ap.gasKg, fast);
    w.gasKg -= ap.gasKg; w.gasUsedKg += ap.gasKg; w.days += ap.days; advanceGap(w, state, ap.days, w.altKm, w.altKm);
    if (legs) legs.push({ kind: 'approach', stop: stopIndex, distanceM, gasKg: ap.gasKg, days: ap.days, massKg, gasLeftKg: w.gasKg, ok: fits });
    if (!fits) return false;
    w.posM = { x: target.x, y: target.y, z: target.z };
    w.left -= 1;
    w.valueCr += stopCatchCr(stop);                                  // the catch pays now; a big piece's fee waits for its disposal
    if (kept) {
      w.carriedKg += v.massKg || 0;
      if (stop.big) w.aboard = w.aboard.concat({ id: stop.id, massKg: v.massKg || 0, stop, melting: false });
    }
    w.sigGroup = w.sigGroup.concat(stop.id);
    if (steps) steps.push({ kind: 'catch', stop: stopIndex, id: stop.id, fieldId: w.fieldId, big: !!stop.big });
    return true;
  }
  if (stop.kind === 'push') {
    const a = aboardPiece(stop.pieceId);
    if (!a || !Number.isFinite(stop.pushKm)) return false;
    const fromKm = w.altKm;
    // At or below the push height it is "let it go here" (WhereNextRows.js pushRow `herKm <= target + 0.5`, state 'here'; GameFlowManager._pickPush):
    // no trip, the list reopens with the same mission start, so it is not one of the moves. It still waits for a mission boundary (the row is 'mission' before).
    const trip = fromKm > stop.pushKm + 0.5;
    if (trip) {
      if (!beginMove()) return false;
      if (!doTransfer(stop.pushKm)) return false;                    // down with the piece aboard (GameFlowManager._pickPush :3470)
      // the list offers the push only when her gas also covers the climb back up without the piece (WhereNextRows.js pushRow :376-402)
      const back = { fromKm: stop.pushKm, toKm: fromKm, massKg: w.dryMassKg + w.carriedKg - a.massKg + w.gasKg, thrustN: state.thrustN, ispS: state.ispS, areaM2: state.areaM2, cos, stepS: state.stepS };
      const t = climbTooLong(back) ? { ok: false, gasKg: 0 } : transfer(back);
      if (!t.ok || !fitsGas(w, t.gasKg, fast)) return false;
      w.fieldId = null; w.posM = null;                               // the free place: no field is hers
    } else if (!fillQuota(w, steps, { state, fast, legs, stopIndex })) return false;
    const pay = disposalPay(a.stop, 'push');
    w.valueCr += pay; w.feeCr += pay;
    w.carriedKg = Math.max(0, w.carriedKg - a.massKg);
    w.aboard = w.aboard.filter((x) => x !== a);
    w.left = 0;
    if (steps) { steps.push({ kind: 'move', what: 'push', stop: stopIndex, id: a.id, altKm: w.altKm }); steps.push({ kind: 'dispose', fate: 'push', id: a.id, payCr: pay }); }
    sigMove(w, `push:${a.id}`);
    return true;
  }
  if (stop.kind === 'melt') {
    const a = aboardPiece(stop.pieceId);
    const m = stop.melt;
    if (!a || !m || !(m.partKg > 0)) return false;
    w.aboard = w.aboard.map((x) => (x === a ? { ...x, melting: true } : x));
    w.melts = w.melts.concat({ id: a.id, massKg: a.massKg, leftKg: a.massKg, partKg: m.partKg, metalPerKg: m.metalPerKg, feeCr: (a.stop.value && a.stop.value.feeCr) || 0, shareCr: m.shareCr || 0, keep: !!a.stop.partJob });
    w.sigGroup = w.sigGroup.concat(`melt:${a.id}`);
    if (steps) steps.push({ kind: 'melt', stop: stopIndex, id: a.id });
    return true;
  }
  // a field, the station field or the satellite: a move, a transfer, then she is at its arrival point
  if (!beginMove()) return false;
  const destId = stop.kind === 'station' ? stop.fieldId : stop.id;
  if (w.altKm !== stop.altKm || (destId && destId !== w.fieldId)) {
    if (!doTransfer(stop.altKm)) return false;
  } else if (legs) legs.push({ kind: 'transfer', stop: stopIndex, toKm: stop.altKm, gasKg: 0, days: 0, massKg: w.dryMassKg + w.carriedKg + w.gasKg, gasLeftKg: w.gasKg, ok: true });
  w.posM = null;
  w.fieldId = stop.kind === 'sat' ? null : (destId ?? null);
  if (stop.kind === 'sat') {
    // handed over: the big pieces aboard stay at the satellite and pay (DECISIONS §49 row 2), the orbit metal is sold; what is still in the furnaces stays aboard
    let mass = 0;
    for (const a of w.aboard) {
      if (a.melting) { mass += (w.melts.find((m) => m.id === a.id) || {}).leftKg || 0; continue; }
      const pay = disposalPay(a.stop, 'satellite');
      w.valueCr += pay; w.feeCr += pay;
      if (steps) steps.push({ kind: 'dispose', fate: 'satellite', id: a.id, payCr: pay });
    }
    w.aboard = w.aboard.filter((a) => a.melting);
    const sold = metalSaleCr(w.metalKg) + w.holdSaleCr;              // the route's own metal, and the hold's metal she already had aboard (SELL ALL: first satellite stop only)
    w.valueCr += sold; w.metalCr += sold; w.metalKg = 0; w.holdKg = 0; w.holdSaleCr = 0;
    // what stays aboard: the pieces still in the furnaces and the kept part (a satellite does not take it: only the station's part job does); the hold's metal left with the sale
    w.carriedKg = mass + (w.partAboard && !w.partPaid ? w.partKg : 0);
    w.left = 0;                                                      // berthed: the next mission starts after the next where-next pick
    if (steps) steps.push({ kind: 'move', what: 'sat', stop: stopIndex, id: stop.id ?? null, altKm: stop.altKm });
    sigMove(w, `sat:${stop.id ?? ''}`);
  } else {
    w.left = quota;
    if (steps) steps.push({ kind: 'move', what: 'field', stop: stopIndex, id: w.fieldId, altKm: stop.altKm, unscanned: true });
    // The station takes the part she carries when she arrives lined up (GameFlowManager `_stationHandOver`, on FIELD_ARRIVED): the gap as the route's own days left it
    if (stop.kind === 'station' && w.partAboard && !w.partPaid && w.gapDeg !== null && isLinedUp(w.gapDeg)) {
      // route-1106 lane S4: the finish burn closes the last gap first (the game's `finishStationBurn`: gas and days, billed at the station's
      // height; priced only for the start whose tilt is the station's, else 0); with too little gas the part stays aboard, nothing billed
      const fin = finishBurn({ gapDeg: w.gapDeg, herIncDeg: state.incDeg, massKg: w.dryMassKg + w.carriedKg + w.gasKg, thrustN: state.thrustN, ispS: state.ispS, gasAboardKg: w.gasKg });
      if (fin.feasible) {
        w.gasKg -= fin.gasKg; w.gasUsedKg += fin.gasKg; w.days += fin.days;
        if (fin.gasKg > 0) w.gapDeg = 0;
        const cr = Math.max(0, stop.payCr || 0);
        w.partPaid = true; w.partAboard = false; w.partPaidCr += cr; w.valueCr += cr;
        w.carriedKg = Math.max(0, w.carriedKg - w.partKg); w.partKg = 0;   // the part leaves her mass with the pay
        if (steps) steps.push({ kind: 'dispose', fate: 'station', id: stop.id, payCr: cr });
      }
    }
    sigMove(w, `f:${w.fieldId}`);
  }
  return true;
}

/**
 * Price a route: the stops in this order, each leg at her mass at that moment. EXACT: transfers are real `tripProfile` runs
 * (through the cache). Stops after a leg that does not fit are not walked; the failing leg is the last one listed, with the gas
 * it needed and a negative `gasLeftKg`.
 * @param {RouteState} state @param {object[]} stops
 * @returns {{legs: Array<{kind: string, stop: number, gasKg: number, days: number, massKg: number, gasLeftKg: number, ok: boolean}>,
 *   steps: Array<object>,
 *   totals: {gasKg: number, days: number, valueCr: number, feeCr: number, metalCr: number, gasLeftKg: number, carriedKg: number,
 *     feasible: boolean, moves: number, unscanned: number}}}
 * `steps` is what she does, in order, for a display: `catch` (a priced piece), `fill` (n ordinary catches nobody priced: the quota
 * of a mission), `stay`, `move` (what: field | sat | push), `dispose` (fate satellite | push | melt, payCr), `melt` (marked).
 * `totals.valueCr` is the catch pay plus every disposal pay (`feeCr`: fees, hand-over parts, the melt's net) plus the metal sold at a
 * satellite (`metalCr`); a piece still aboard at the end counts no fee (D4). `unscanned`: catches filled in, priced 0.
 */
export function walkRoute(state, stops) {
  const w = freshWalk(state);
  const legs = [];
  const steps = [];
  let feasible = true;
  for (let i = 0; i < stops.length; i++) {
    if (!runStop(w, stops[i], state, legs, false, i, steps)) { feasible = false; break; }
  }
  if (feasible && !fillQuota(w, steps, { state, fast: false, legs, stopIndex: stops.length })) feasible = false;   // the mission she is in ends with ordinary catches (unscanned, priced 0 but flown at the estimated approach)
  return {
    legs, steps,
    totals: {
      gasKg: w.gasUsedKg, days: w.days, valueCr: w.valueCr, feeCr: w.feeCr, metalCr: w.metalCr, gasLeftKg: w.gasKg, carriedKg: w.carriedKg, feasible,
      moves: w.moves, unscanned: w.unscanned, partCr: w.partPaidCr, gapDeg: w.gapDeg,
    },
  };
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

/** The ways routes are sorted (D5): the most credits, the most credits per kg of gas, the fewest days. */
export const SORTS = ['credits', 'crPerKg', 'days'];
const GAS_FLOOR_KG = 0.01;   // a route that burns nothing is not worth infinity per kg
const crPerKg = (r) => r.valueCr / Math.max(r.gasKg, GAS_FLOOR_KG);
const priced = (a, b) => (b.valueCr > 0 ? 1 : 0) - (a.valueCr > 0 ? 1 : 0);   // a route with something priced in it comes before one with nothing
/** The comparator of a sort over `{valueCr, gasKg, days}`: every sort puts a priced route first, then ties to the others. */
export function comparatorFor(sortBy) {
  if (sortBy === 'days') {
    return (a, b) => priced(a, b) || (Math.abs(a.days - b.days) > 1e-9 ? a.days - b.days : 0) || (b.valueCr - a.valueCr) || (a.gasKg - b.gasKg);
  }
  if (sortBy === 'crPerKg') {
    return (a, b) => priced(a, b) || (Math.abs(crPerKg(a) - crPerKg(b)) > 1e-9 ? crPerKg(b) - crPerKg(a) : 0) || (b.valueCr - a.valueCr) || (a.days - b.days);
  }
  return (a, b) => priced(a, b) || better(a, b);
}

export const EXACT_MAX_CANDIDATES = 10;
export const BEAM_WIDTH = 50;
/** The search gives up after this many nodes and says so (`approximate`): the panel computes while she waits, so it is bounded. */
export const MAX_NODES = 40000;

/**
 * The best routes through `candidates` (stops: pieces, fields, the satellite, push and melt of a piece), under the rules at the top of
 * this file (the mission quota, at most `state.maxMoves` moves, the hold, the fee only at a disposal). `sortBy`: `credits` (default:
 * the most value, ties to less gas, then fewer days), `crPerKg` (value per kg of gas used) or `days`; a route with nothing priced in it
 * comes after every priced one. Each top route is a different shape (the same pieces in another order within a mission are one route).
 * Up to `EXACT_MAX_CANDIDATES` candidates every order of every subset is searched (depth-first, with a value bound for `credits`, so a
 * route that cannot reach the k-th best is cut); above it, or past `MAX_NODES`, a beam search (width `BEAM_WIDTH`, ranking a partial
 * route with the fee of the big pieces aboard counted as if disposed of) and the result is marked `approximate`. The search prices
 * legs with `transferLegFast`, allowing `FAST_GAS_TOLERANCE` (0.5 %) of the gas used so far; every route it keeps is re-priced
 * exactly with `walkRoute`, those that no longer fit are dropped, and the search is repeated keeping more routes until `k` exact
 * ones are in hand (a route at the tank's edge is neither lost nor allowed to take a place); the list is sorted on the exact numbers.
 * @param {RouteState} state @param {object[]} candidates stops (a piece stop carries its `value`)
 * @param {{k?: number, maxStops?: number, sortBy?: 'credits'|'crPerKg'|'days', maxNodes?: number, beamWidth?: number}} [opts]
 * @returns {{routes: Array<{stops: object[], ids: string[], totals: object, legs: object[], steps: object[]}>, approximate: boolean, nodes: number, ms: number,
 *   searchMs: number, repriceMs: number, sortBy: string}} `searchMs` the search on the fast legs, `repriceMs` the exact re-pricing of the routes returned
 */
export function bestRoutes(state, candidates, opts = {}) {
  const t0 = Date.now();
  const k = opts.k > 0 ? opts.k : 3;
  const maxStops = Math.min(opts.maxStops > 0 ? opts.maxStops : 8, candidates.length);
  const n = candidates.length;
  const sortBy = SORTS.includes(opts.sortBy) ? opts.sortBy : 'credits';
  const cmp = comparatorFor(sortBy);
  const cap = opts.maxNodes > 0 ? opts.maxNodes : MAX_NODES;
  const beamWidth = opts.beamWidth > 0 ? opts.beamWidth : BEAM_WIDTH;
  const vals = candidates.map(stopCeilingCr);
  let exact = n <= EXACT_MAX_CANDIDATES;
  let nodes = 0;
  const found = [];                                      // {order: number[], sig, valueCr, gasKg, days}
  let pool = k;                                          // how many routes the search keeps (grown by the refill below)

  const consider = (order, w) => {
    const probe = { valueCr: w.valueCr, gasKg: w.gasUsedKg, days: w.days };
    if (found.length >= pool && cmp(probe, found[found.length - 1]) >= 0) return;      // not good enough to enter: no need to name its shape
    const sig = sortBy === 'days' ? w.shape : sigOf(w);        // by days a route is its moves: which pieces it takes on the way is not a different route
    const entry = { order: order.slice(), sig, ...probe };
    const same = found.findIndex((f) => f.sig === sig);
    if (same >= 0) { if (cmp(entry, found[same]) < 0) found[same] = entry; else return; } else found.push(entry);
    found.sort(cmp);
    if (found.length > pool) found.length = pool;
  };
  const clone = (w) => ({ ...w });

  const search = () => {
    found.length = 0;
    if (exact) {
      const used = new Array(n).fill(false);
      const order = [];
      const dfs = (w, depth) => {
        if (depth === maxStops || nodes > cap) return;
        if (sortBy === 'credits' && found.length >= pool) {
          // the best a route can still add: the biggest remaining values, as many as it may still visit, and the fees of what is aboard
          const remaining = [];
          for (let i = 0; i < n; i++) if (!used[i]) remaining.push(vals[i]);
          remaining.sort((a, b) => b - a);
          let bound = w.valueCr + potentialCr(w) + w.metalKg * Constants.BIG_PIECES.IN_ORBIT_CR_PER_KG;   // + the metal already in the hold, still to sell
          for (let j = 0; j < Math.min(maxStops - depth, remaining.length); j++) bound += remaining[j];
          if (bound < found[found.length - 1].valueCr - 1e-9) return;
        }
        for (let i = 0; i < n; i++) {
          if (used[i]) continue;
          nodes++;
          const w2 = clone(w);
          if (!runStop(w2, candidates[i], state, null, true, depth, null)) continue;
          used[i] = true; order.push(i);
          consider(order, w2);
          dfs(w2, depth + 1);
          used[i] = false; order.pop();
        }
      };
      dfs(freshWalk(state), 0);
      if (nodes > cap) exact = false;                    // gave up: what it kept is the best of what it saw
    }
    if (!exact) {
      found.length = 0;
      let layer = [{ order: [], w: freshWalk(state) }];
      for (let depth = 0; depth < maxStops; depth++) {
        const next = [];
        for (const node of layer) {
          for (let i = 0; i < n; i++) {
            if (node.order.includes(i)) continue;
            nodes++;
            const w2 = clone(node.w);
            if (!runStop(w2, candidates[i], state, null, true, depth, null)) continue;
            const order = node.order.concat(i);
            consider(order, w2);
            next.push({ order, w: w2, valueCr: w2.valueCr + potentialCr(w2), gasKg: w2.gasUsedKg, days: w2.days });
          }
        }
        next.sort(cmp);
        layer = next.slice(0, beamWidth);
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
      return { stops, ids: stops.map((s) => s.id), totals: walked.totals, legs: walked.legs, steps: walked.steps };
    }).filter((r) => r.totals.feasible);
    searchMs += tb - ta; repriceMs += Date.now() - tb;
    if (routes.length >= k || found.length < pool || nodes > cap * 3) break;
    pool *= 4;
  }
  routes.sort((a, b) => cmp(
    { valueCr: a.totals.valueCr, gasKg: a.totals.gasKg, days: a.totals.days },
    { valueCr: b.totals.valueCr, gasKg: b.totals.gasKg, days: b.totals.days },
  ));
  if (routes.length > k) routes.length = k;
  return { routes, approximate: !exact, nodes, ms: Date.now() - t0, searchMs, repriceMs, sortBy };
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
