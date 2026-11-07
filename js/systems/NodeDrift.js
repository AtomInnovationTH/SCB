/**
 * NodeDrift - how Earth's bulge (J2) turns an orbit's node, and the node gap between her and the space station (route-1101 lane S2,
 * DECISIONS §62 row 2; docs/research/2026-11-station-drift.md §1, §2, §5 "a smaller first step").
 *
 * Pure: numbers in, numbers out; no game state, no events, no DOM.
 *
 * "Node" is the angle where an orbit crosses the equator going north. The bulge turns it backwards for a prograde orbit, faster the lower
 * the orbit (exact secular J2 rate for a circular orbit: dOmega/dt = -1.5 n J2 (Re / a)^2 cos i). The station flies at 408 km, 51.6 deg,
 * node 123.4 deg (`Constants.ISS_BOSS.ORBIT`); the GAP is the station's node minus hers, wrapped to (-180, 180]. Each day the gap changes
 * by the station's rate minus hers: higher than the station she turns slower, so the gap falls (she gains on the station).
 *
 * The first step (station-drift doc §5): only the gap moves, with ship days. Her tilt and her scene orbit stay as they are (D6). Every
 * start has a station object (route-1107-d2): New York the ISS (408 km, 51.6 deg), each of the six cities its real object
 * (`Constants.CITY_STATIONS`, picked by her tilt: `cityStation`); the station pieces are built in the object's own plane (her node + the
 * gap) and the finish burn that closes the gap is billed (`RouteCost.finishBurn`). Every function that reads the station's orbit takes
 * her tilt (for the ones that already took `incDeg`, that is it); with none, the ISS.
 * @module systems/NodeDrift
 */

import { Constants } from '../core/Constants.js';
import { LANGUAGES } from '../core/Languages.js';

/** The J2 formula's equatorial radius (WGS-84, km): `a = 6378.137 + height`, as the station-drift doc's probe (its line 4). */
export const J2_RADIUS_KM = 6378.137;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const SECONDS_PER_DAY = 86400;

/**
 * The exact secular J2 node rate of a circular orbit (deg per day; negative = the node turns west, as for every prograde orbit).
 * `Constants.J2` and `Constants.MU_EARTH` (the game's gravity constant).
 * @param {number} altKm height above the surface @param {number} incDeg tilt @returns {number}
 */
export function nodeRateDegPerDay(altKm, incDeg) {
  const a = J2_RADIUS_KM + altKm;
  const n = Math.sqrt(Constants.MU_EARTH / (a * a * a));            // rad/s
  return -1.5 * n * Constants.J2 * (J2_RADIUS_KM / a) ** 2 * Math.cos(incDeg * D2R) * SECONDS_PER_DAY * R2D;
}

/**
 * The city whose start tilt is her tilt, within 0.05 deg (`Languages.js`), for the six starts that protect a real object other than the
 * ISS (`Constants.CITY_STATIONS`, route-1107-d2). Null for New York's 51.6 deg, for any other tilt and for a tilt that is not finite.
 * @param {number} [herIncDeg] @returns {string|null} the start language code ('th', 'ja', ...)
 */
export function cityStationKey(herIncDeg) {
  if (!Number.isFinite(herIncDeg)) return null;
  const cities = Constants.CITY_STATIONS || {};
  for (const l of LANGUAGES) {
    if (cities[l.code] && Math.abs(herIncDeg - l.incDeg) <= 0.05) return l.code;
  }
  return null;
}

/**
 * The object her start protects: its `Constants.CITY_STATIONS` entry `{ name, short, satcat, altKm, incDeg, massKg, canDodge }`, or null
 * for New York (the ISS), for any other tilt and for a tilt that is not finite (route-1107-d2 D-A4).
 * @param {number} [herIncDeg] @returns {object|null}
 */
export function cityStation(herIncDeg) {
  const k = cityStationKey(herIncDeg);
  return k ? Constants.CITY_STATIONS[k] : null;
}

/**
 * The station's orbit for her start: the city's real object (`Constants.CITY_STATIONS`: its height and tilt; the node is the ISS
 * constant's, GCAT has none, route-1107-d2 D-A4) or, for New York and for no tilt, the ISS (`Constants.ISS_BOSS.ORBIT`: 408 km, 51.6 deg,
 * node 123.4 deg).
 * @param {number} [herIncDeg] her tilt @returns {{altKm: number, incDeg: number, nodeDeg: number}}
 */
export function stationOrbit(herIncDeg) {
  const o = (Constants.ISS_BOSS && Constants.ISS_BOSS.ORBIT) || {};
  const nodeDeg = o.raanDeg ?? 123.4;
  const c = cityStation(herIncDeg);
  if (c) return { altKm: c.altKm, incDeg: c.incDeg, nodeDeg };
  return { altKm: o.altKm ?? 408, incDeg: o.incDeg ?? 51.6, nodeDeg };
}

/**
 * Is the station in a plane she can be put in by the finish burn? True for the seven start tilts (New York's 51.6 deg and the six
 * cities': each protects its own real object, route-1107-d2), false for any other tilt and for a tilt that is not finite.
 * @param {number} herIncDeg @returns {boolean} within 0.05 deg
 */
export function stationInOwnPlane(herIncDeg) {
  if (!Number.isFinite(herIncDeg)) return false;
  return Math.abs(herIncDeg - stationOrbit().incDeg) <= 0.05 || cityStationKey(herIncDeg) !== null;
}

/**
 * The station object's own node rate (deg/day): -4.98 at 408 km, 51.6 deg for the ISS (doc §1); a city's object at its height and tilt.
 * @param {number} [herIncDeg] her tilt (none: the ISS)
 */
export function stationRateDegPerDay(herIncDeg) {
  const s = stationOrbit(herIncDeg);
  return nodeRateDegPerDay(s.altKm, s.incDeg);
}


/** An angle wrapped to (-180, 180]. @param {number} deg @returns {number} */
export function wrapDeg(deg) {
  if (!Number.isFinite(deg)) return deg;
  let x = ((deg % 360) + 360) % 360;                                  // [0, 360)
  if (x > 180) x -= 360;
  return x;
}

/** An angle wrapped to [0, 360). @private */
function wrap360(deg) { return ((deg % 360) + 360) % 360; }

/**
 * The gap at a new game: the station's node minus hers, wrapped (the English start: 123.4 - 293.0 = -169.6 deg, doc §4 line 108).
 * @param {number} herNodeDeg @returns {number}
 */
export function initialGapDeg(herNodeDeg) {
  return wrapDeg(stationOrbit().nodeDeg - herNodeDeg);
}

/** How far the gap may be from 0 for the station to count as lined up: 0.346 deg, a finish of at most 57 m/s (doc §2). */
export function linedUpDeg() {
  const v = Constants.ISS_BOSS && Constants.ISS_BOSS.LINED_UP_DEG;
  return Number.isFinite(v) && v > 0 ? v : 0.346;
}

/** @param {number} gapDeg @returns {boolean} the gap is within `linedUpDeg()` of 0 */
export function isLinedUp(gapDeg) {
  return Number.isFinite(gapDeg) && Math.abs(wrapDeg(gapDeg)) <= linedUpDeg() + 1e-12;
}

/**
 * The gap's change over `days` spent at one height (a wait): (the station object's rate - her rate) x days; `incDeg` is her tilt, which
 * also picks the station object (`stationOrbit`).
 * @param {number} altKm @param {number} incDeg her tilt @param {number} days @returns {number} deg
 */
export function gapChangeAtHeight(altKm, incDeg, days) {
  if (!(days > 0)) return 0;
  return (stationRateDegPerDay(incDeg) - nodeRateDegPerDay(altKm, incDeg)) * days;
}

/**
 * Her mean node rate along a trip profile's samples (`TripProfile.tripProfile`: `{t}` game seconds, `{a}` semi-major axis km), time
 * weighted (trapezoid). Heights are `a - Constants.EARTH_RADIUS_KM` (the game's radius, as the profile's), the rate uses the J2 radius,
 * as the doc's probe. Null with fewer than two samples or no time span.
 * @param {Array<{t: number, a: number}>} samples @param {number} incDeg @returns {number|null}
 */
export function meanRateOverSamples(samples, incDeg) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const RE = Constants.EARTH_RADIUS_KM;
  let sum = 0;
  let span = 0;
  for (let k = 1; k < samples.length; k++) {
    const s0 = samples[k - 1];
    const s1 = samples[k];
    const dt = s1.t - s0.t;
    if (!(dt > 0) || !Number.isFinite(s0.a) || !Number.isFinite(s1.a)) continue;
    sum += 0.5 * (nodeRateDegPerDay(s0.a - RE, incDeg) + nodeRateDegPerDay(s1.a - RE, incDeg)) * dt;
    span += dt;
  }
  return span > 0 ? sum / span : null;
}

/**
 * The gap's change over one leg (a trip, a push-down, a called satellite, a wait): the station's rate minus her mean rate, times the
 * leg's days. Her mean rate: from the leg's height samples when it has them (a trip; the samples cover the profile, and a pause with
 * her nose off counts at that same mean, as the leg's days include it), else the mean of `fromKm` and `altKm` (a leg with both ends and
 * no samples), else her height `altKm` (a wait, a called satellite: she holds where she is).
 * @param {{days: number, altKm?: number, fromKm?: number, samples?: Array<{t: number, a: number}>}} leg
 * @param {number} incDeg her tilt
 * @returns {number} deg (0 for a leg with no days or no height)
 */
export function gapChangeOverLeg(leg, incDeg) {
  if (!leg || !(leg.days > 0) || !Number.isFinite(incDeg)) return 0;
  let herRate = meanRateOverSamples(leg.samples, incDeg);
  if (herRate == null) {
    const to = leg.altKm;
    const from = Number.isFinite(leg.fromKm) ? leg.fromKm : to;
    if (!Number.isFinite(to)) return 0;
    herRate = from === to ? nodeRateDegPerDay(to, incDeg) : 0.5 * (nodeRateDegPerDay(from, incDeg) + nodeRateDegPerDay(to, incDeg));
  }
  return (stationRateDegPerDay(incDeg) - herRate) * leg.days;
}

/**
 * The days she must wait at `waitKm` so that the trip to the station field (gap change `tripChangeDeg`, its descent's own drift
 * included) arrives with the gap at 0: the smallest N >= 0 with gap + trip + (station rate - her rate at waitKm) x N = 0 (mod 360).
 * 0 when the trip alone already arrives lined up; Infinity at the station's own rate (she never gains).
 * @param {{gapDeg: number, waitKm: number, incDeg: number, tripChangeDeg?: number}} p
 * @returns {number} days
 */
export function waitDaysToLineUp({ gapDeg, waitKm, incDeg, tripChangeDeg = 0 }) {
  if (!Number.isFinite(gapDeg) || !Number.isFinite(waitKm) || !Number.isFinite(incDeg)) return Infinity;
  const x = gapDeg + (Number.isFinite(tripChangeDeg) ? tripChangeDeg : 0);
  if (isLinedUp(x)) return 0;
  const d = stationRateDegPerDay(incDeg) - nodeRateDegPerDay(waitKm, incDeg);  // deg/day the gap moves while she waits
  if (Math.abs(d) < 1e-9) return Infinity;
  return d < 0 ? wrap360(x) / -d : wrap360(-x) / d;
}

/**
 * The station field (lane S2 task 3). The boss takes its pieces from the live debris around her at the field she is in
 * (`DebrisField._spawnThreatField`, DebrisField.js:4434-4440, `Constants.ISS_BOSS.FRAG_COUNT` of them), and she can only fly to a field
 * that still has rows. Rule: the first of `Constants.ISS_BOSS.STATION_FIELDS` (f400, f425, f375, f450: nearest to the station's 408 km
 * first) whose remaining rows are at least FRAG_COUNT; if all four are short, the field nearest to 408 km with at least that many; if
 * none has that many, the nearest with any rows left; null when every field is cleared.
 * For a city (`herIncDeg` picks one, route-1107-d2 D-A4) the fields are taken by height gap to its real object (`Constants.CITY_STATIONS`;
 * ties: the lower field): the first with at least FRAG_COUNT rows, else the nearest with any, else null. No tilt: New York's rule.
 * @param {{fields: function, fieldById: function, remainingCount: function}} reg the field registry
 * @param {number} [herIncDeg] her tilt
 * @returns {string|null} the field id
 */
export function stationFieldId(reg, herIncDeg) {
  if (!reg || typeof reg.remainingCount !== 'function') return null;
  const cfg = Constants.ISS_BOSS || {};
  const need = cfg.FRAG_COUNT || 6;
  const city = cityStation(herIncDeg);
  const list = city ? [] : (Array.isArray(cfg.STATION_FIELDS) ? cfg.STATION_FIELDS : ['f400', 'f425', 'f375', 'f450']);
  for (const id of list) {
    if (typeof reg.fieldById === 'function' && !reg.fieldById(id)) continue;
    if (reg.remainingCount(id) >= need) return id;
  }
  const stKm = stationOrbit(herIncDeg).altKm;
  const all = (typeof reg.fields === 'function' ? reg.fields() : [])
    .slice().sort((a, b) => Math.abs(a.altKm - stKm) - Math.abs(b.altKm - stKm) || a.altKm - b.altKm);
  const enough = all.find((f) => reg.remainingCount(f.id) >= need);
  if (enough) return enough.id;
  const any = all.find((f) => reg.remainingCount(f.id) > 0);
  return any ? any.id : null;
}
