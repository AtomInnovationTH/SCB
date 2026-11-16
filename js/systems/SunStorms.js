/**
 * SunStorms.js - the Sun's level and storm days, and what they do to the air (plan sky-1116, DECISIONS §72/§73).
 *
 * Pure part (no game state, no THREE): a game DATE gives the Sun's level (the smoothed 10.7 cm radio flux, "F10.7") and a
 * storm calendar gives each day's storm strength (Kp). Both become one multiplier on the game's air (Vallado's mean-Sun
 * table, `OrbitalMechanics.atmosphericDensity`): `sunMultiplier(altKm, f107) x stormMultiplier(altKm, f107, kp)`.
 *
 * Sources (read 2026-11-16, docs/research/2026-11-sky-and-storms.md):
 *  - Air by Sun level: ECSS-E-ST-10-04C Annex G tables G-1..G-3 (NRLMSISE-00, day/night and season mean, equatorial),
 *    F10.7 65 / 140 / 250, Ap 0 / 15 / 45; https://www.spenvis.oma.be/ecss/e_st_10_04c/ecss_18_09_01.htm (_02, _03 for the
 *    others). The game's own air is the mean-Sun air, so the multiplier is each column over the MODERATE one (exactly 1 at 140).
 *    Harris-Priester was rejected: its min/max columns are night side and day bulge at an average Sun, not Sun levels.
 *    Rows above 880 km are held at the 880 km ratio (the high column's 900 km row may be a misprint).
 *  - Sun by date: NOAA's predicted smoothed monthly table, 2026-05 to 2030-12
 *    (https://services.swpc.noaa.gov/json/solar-cycle/predicted-solar-cycle.json, read 2026-11-16), then Hathaway's cycle shape
 *    (Hathaway, Wilson and Reichmann 1994; refit in Upton and Hathaway 2023, https://arxiv.org/html/2305.06516v2): R(t) =
 *    A (t-t0)^3 / (exp((t-t0)^2/B^2) - 0.70), t in months, B = 36.3 + 0.72/sqrt(A); a new cycle every 11 years; peak sunspot
 *    number 135 (an ESTIMATE: cycle 25's fit, Rmax 135 +-10). Sunspot number to F10.7 from NOAA's own pairs, then slope 0.97.
 *  - Storm days: the measured record (GFZ Kp 1996-2025, 393 days per 11 years with Kp >= 5) split by NOAA's level ratios, see
 *    `STORM_DAYS_PER_CYCLE`; each day's chance follows the smoothed sunspot number. Storm strength: the Jacchia
 *    exospheric temperature term above 350 km, dT = 28 Kp + 0.03 e^Kp kelvin (pytcl port of Jacchia 1971 after Montenbruck and
 *    Gill; Jacchia-Roberts, hdl.handle.net/2060/19910007770). The storm's air is the same ECSS table read by temperature
 *    (696 / 1020 / 1310 K, log-linear beyond), at T + K_STORM x dT; K_STORM is calibrated to May 2024 (see below).
 *
 * Gate: with no date (a test, the menu) or in training missions 1-3 the multiplier is exactly 1 and no storm ever comes.
 *
 * @module systems/SunStorms
 */

import { gameState } from '../core/GameState.js';
import { isTrainingNow } from './TrainingHintGate.js';
import { setAirModel } from '../entities/OrbitalMechanics.js';

const DAY_MS = 86400000;
const YEAR_MS = 365.2425 * DAY_MS;

// ---------------------------------------------------------------------------------------------------------------------------
// The air by Sun level (ECSS-E-ST-10-04C Annex G, kg/m3, every 20 km from 100 to 900 km)
// ---------------------------------------------------------------------------------------------------------------------------

export const F107_LOW = 65;
export const F107_MOD = 140;
export const F107_HIGH = 250;
/** Exospheric temperature of the three columns, K (ECSS tables, the 400-900 km rows). */
export const T_LOW_K = 696;
export const T_MOD_K = 1020;
export const T_HIGH_K = 1310;
/** First and last row heights of the table and the step, km. Heights outside 100..880 hold the nearest row's ratio. */
export const ROW0_KM = 100;
export const ROW_STEP_KM = 20;
/** Last row height whose ratio is used (above it the 880 km ratio is held). */
export const ROW_TOP_KM = 880;

// [km, rho low (F10.7 65), rho moderate (140), rho high (250)]
const ECSS = [
  [100, 6.18e-07, 5.73e-07, 5.64e-07], [120, 1.88e-08, 2.03e-08, 2.22e-08], [140, 3.08e-09, 3.44e-09, 3.93e-09],
  [160, 9.49e-10, 1.20e-09, 1.54e-09], [180, 3.70e-10, 5.46e-10, 7.87e-10], [200, 1.63e-10, 2.84e-10, 4.57e-10],
  [220, 7.80e-11, 1.61e-10, 2.86e-10], [240, 3.97e-11, 9.60e-11, 1.87e-10], [260, 2.13e-11, 5.97e-11, 1.27e-10],
  [280, 1.18e-11, 3.83e-11, 8.87e-11], [300, 6.80e-12, 2.52e-11, 6.31e-11], [320, 4.01e-12, 1.69e-11, 4.56e-11],
  [340, 2.41e-12, 1.16e-11, 3.34e-11], [360, 1.47e-12, 7.99e-12, 2.47e-11], [380, 9.14e-13, 5.60e-12, 1.85e-11],
  [400, 5.75e-13, 3.96e-12, 1.40e-11], [420, 3.66e-13, 2.83e-12, 1.06e-11], [440, 2.35e-13, 2.03e-12, 8.13e-12],
  [460, 1.53e-13, 1.47e-12, 6.26e-12], [480, 1.01e-13, 1.07e-12, 4.84e-12], [500, 6.79e-14, 7.85e-13, 3.76e-12],
  [520, 4.63e-14, 5.78e-13, 2.94e-12], [540, 3.21e-14, 4.29e-13, 2.31e-12], [560, 2.28e-14, 3.19e-13, 1.82e-12],
  [580, 1.65e-14, 2.39e-13, 1.43e-12], [600, 1.23e-14, 1.80e-13, 1.14e-12], [620, 9.37e-15, 1.36e-13, 9.06e-13],
  [640, 7.33e-15, 1.04e-13, 7.23e-13], [660, 5.88e-15, 7.98e-14, 5.79e-13], [680, 4.83e-15, 6.16e-14, 4.65e-13],
  [700, 4.04e-15, 4.80e-14, 3.75e-13], [720, 3.44e-15, 3.76e-14, 3.03e-13], [740, 2.98e-15, 2.98e-14, 2.46e-13],
  [760, 2.61e-15, 2.38e-14, 2.00e-13], [780, 2.31e-15, 1.92e-14, 1.63e-13], [800, 2.06e-15, 1.57e-14, 1.34e-13],
  [820, 1.85e-15, 1.29e-14, 1.10e-13], [840, 1.67e-15, 1.07e-14, 9.06e-14], [860, 1.51e-15, 9.03e-15, 7.50e-14],
  [880, 1.38e-15, 7.67e-15, 6.23e-14],
];
const ROWS = ECSS.length;   // 39 rows, 100..880 km (the 900 km row is not used: held at 880)
const LN_LOW = new Float64Array(ROWS);    // ln rho
const LN_MOD = new Float64Array(ROWS);
const LN_HIGH = new Float64Array(ROWS);
for (let i = 0; i < ROWS; i++) {
  LN_LOW[i] = Math.log(ECSS[i][1]);
  LN_MOD[i] = Math.log(ECSS[i][2]);
  LN_HIGH[i] = Math.log(ECSS[i][3]);
}

/** Row position of a height: [index of the lower row, 0..1 along to the next], held at the first and last row. */
function rowAt(altKm) {
  const x = (Math.min(Math.max(altKm, ROW0_KM), ROW_TOP_KM) - ROW0_KM) / ROW_STEP_KM;
  const i = Math.min(ROWS - 2, Math.floor(x));
  return [i, x - i];
}

/** Clamp a Sun level to the table's range (F10.7 65..250). */
function clampF107(f) { return Math.min(Math.max(f, F107_LOW), F107_HIGH); }

/**
 * How much thicker (or thinner) the air is at this height and Sun level than the game's mean-Sun air: ECSS columns over the
 * moderate one, ln-linear in F10.7 between 65 / 140 / 250 and in height between rows. Exactly 1 at F10.7 140.
 * @param {number} altKm @param {number} f107 @returns {number}
 */
export function sunMultiplier(altKm, f107) {
  const f = clampF107(f107);
  const [i, w] = rowAt(altKm);
  const lnr = (k) => (f <= F107_MOD
    ? (LN_LOW[k] - LN_MOD[k]) * ((F107_MOD - f) / (F107_MOD - F107_LOW))
    : (LN_HIGH[k] - LN_MOD[k]) * ((f - F107_MOD) / (F107_HIGH - F107_MOD)));
  return Math.exp(lnr(i) * (1 - w) + lnr(i + 1) * w);
}

/** The exospheric temperature the Sun level gives, K: linear in F10.7 through (65, 696), (140, 1020), (250, 1310). */
export function exoTempK(f107) {
  const f = clampF107(f107);
  return f <= F107_MOD
    ? T_LOW_K + (T_MOD_K - T_LOW_K) * (f - F107_LOW) / (F107_MOD - F107_LOW)
    : T_MOD_K + (T_HIGH_K - T_MOD_K) * (f - F107_MOD) / (F107_HIGH - F107_MOD);
}

/** ln rho (kg/m3) at a row-interpolated height and an exospheric temperature, log-linear in T through the three columns and beyond. */
function lnRhoAtT(i, w, tK) {
  const lo = LN_LOW[i] * (1 - w) + LN_LOW[i + 1] * w;
  const mo = LN_MOD[i] * (1 - w) + LN_MOD[i + 1] * w;
  const hi = LN_HIGH[i] * (1 - w) + LN_HIGH[i + 1] * w;
  if (tK <= T_MOD_K) return mo + (mo - lo) * (tK - T_MOD_K) / (T_MOD_K - T_LOW_K);
  return mo + (hi - mo) * (tK - T_MOD_K) / (T_HIGH_K - T_MOD_K);
}

/**
 * Calibration of the storm's heating (a share of Jacchia's exospheric temperature term that reaches the density at the heights
 * the game flies), chosen so a Kp 9 day at F10.7 180 gives x3.2 at 425 km (the 11 May 2024 storm, both values estimates;
 * ESA Swarm density sinking, day against the 1-9 May median, computed in the Swarm note). Checked, not fitted, against
 * x2.4 at 325 km and x2.6 at 375 km (the same note, day by day). Solved by `calibrateStormK` (a test re-derives it).
 */
export const K_STORM = 0.5095;

/** Jacchia's exospheric temperature rise for a Kp (K), the form above 350 km. */
export function jacchiaDeltaT(kp) { return 28 * kp + 0.03 * Math.exp(kp); }

/**
 * How much thicker the air is on a storm day than on a quiet one at the same Sun level (the same table read by temperature at
 * T + K_STORM x dT(Kp)). 1 for no storm (Kp below 5).
 * @param {number} altKm @param {number} f107 @param {number} kp @param {number} [k] heating share (default K_STORM)
 * @returns {number}
 */
export function stormMultiplier(altKm, f107, kp, k = K_STORM) {
  if (!(kp >= 5)) return 1;
  const [i, w] = rowAt(altKm);
  const t0 = exoTempK(f107);
  return Math.exp(lnRhoAtT(i, w, t0 + k * jacchiaDeltaT(kp)) - lnRhoAtT(i, w, t0));
}

/** Solve the heating share so a Kp 9 day at F10.7 180 reads x3.2 at 425 km (bisection). */
export function calibrateStormK() {
  let lo = 0;
  let hi = 2;
  for (let n = 0; n < 60; n++) {
    const mid = (lo + hi) / 2;
    if (stormMultiplier(425, 180, 9, mid) < 3.2) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The whole multiplier on the game's air: Sun level times storm. */
export function airMultiplier(altKm, f107, kp) {
  return sunMultiplier(altKm, f107) * stormMultiplier(altKm, f107, kp);
}

// ---------------------------------------------------------------------------------------------------------------------------
// The Sun by date
// ---------------------------------------------------------------------------------------------------------------------------

// NOAA predicted-solar-cycle.json, smoothed monthly, 2026-05 .. 2030-12 (56 months): sunspot number, F10.7.
const NOAA_FIRST = [2026, 5];
const NOAA_SSN = [
  86.7, 86.9, 84.4, 82.4, 83.1, 82.9, 83.2, 83.8, 84.3, 84.2, 83.4, 81.8, 79.6, 77.0, 74.2, 71.3, 68.4, 65.7, 63.0, 60.5,
  57.9, 55.5, 53.3, 51.0, 48.8, 46.6, 44.5, 42.4, 40.4, 38.5, 36.6, 34.8, 33.1, 31.3, 29.8, 28.2, 26.8, 25.3, 23.9, 22.5,
  21.2, 20.0, 18.9, 17.8, 16.7, 15.6, 14.8, 13.8, 13.0, 12.1, 11.4, 10.6, 9.9, 9.2, 8.6, 8.0,
];
const NOAA_F107 = [
  130.8, 129.7, 127.1, 124.9, 123.8, 122.9, 123.0, 123.2, 122.9, 122.1, 120.8, 118.7, 116.3, 113.7, 111.1, 108.5, 106.0, 103.8, 101.7, 99.8,
  98.0, 96.2, 94.7, 93.1, 91.6, 90.1, 88.8, 87.5, 86.2, 85.1, 84.0, 82.9, 81.9, 81.0, 80.2, 79.3, 78.6, 77.8, 77.1, 76.5,
  75.8, 75.3, 74.7, 74.2, 73.8, 73.3, 72.9, 72.6, 72.2, 71.9, 71.6, 71.3, 71.0, 70.8, 70.5, 70.3,
];
/** Mid-month (the 15th, UTC) of table index i, ms. */
const noaaMs = (i) => Date.UTC(NOAA_FIRST[0], NOAA_FIRST[1] - 1 + i, 15);
const NOAA_START_MS = noaaMs(0);
const NOAA_END_MS = noaaMs(NOAA_SSN.length - 1);

// Hathaway cycle shape. Peak sunspot number 135 (estimate); B depends on A, so A is found by fixed-point iteration.
const HATHAWAY_C = 0.70;
const PEAK_SSN = 135;
const CYCLE_MONTHS = 132;
function hathawayB(A) { return 36.3 + 0.72 / Math.sqrt(A); }
function shapeWith(A, dm) {
  if (!(dm > 0)) return 0;
  const B = hathawayB(A);
  return A * dm * dm * dm / (Math.exp(dm * dm / (B * B)) - HATHAWAY_C);
}
const HATHAWAY_A = (() => {
  let A = 0.005;
  for (let n = 0; n < 40; n++) {
    const B = hathawayB(A);
    let peak = 0;      // the shape's maximum per unit A at this B
    for (let dm = 1; dm <= 140; dm += 0.25) peak = Math.max(peak, dm * dm * dm / (Math.exp(dm * dm / (B * B)) - HATHAWAY_C));
    A = PEAK_SSN / peak;
  }
  return A;
})();
/** The sunspot number of one cycle, `dm` months after its start. */
export function hathawayShape(dm) { return shapeWith(HATHAWAY_A, dm); }

/** The month (months since year 0) the cycle after NOAA's table starts, found so its shape reads the table's last value there. */
const NOAA_END_MONTHS = (() => { const d = new Date(NOAA_END_MS); return d.getUTCFullYear() * 12 + d.getUTCMonth() + 14 / 30; })();
const CYCLE26_T0_MONTHS = (() => {
  const target = NOAA_SSN[NOAA_SSN.length - 1];
  let lo = 0;
  let hi = 40;
  for (let n = 0; n < 60; n++) {
    const mid = (lo + hi) / 2;
    if (hathawayShape(mid) < target) lo = mid; else hi = mid;
  }
  return NOAA_END_MONTHS - (lo + hi) / 2;
})();
/** Mean sunspot number over a whole cycle (the shape summed over all time, per cycle length): the storm calendar's normaliser. */
export const MEAN_SSN = (() => {
  let s = 0;
  for (let dm = 0.5; dm < 600; dm += 1) s += hathawayShape(dm);
  return s / CYCLE_MONTHS;
})();

function monthsOf(ms) { return 1970 * 12 + ms / YEAR_MS * 12; }

/** Smoothed sunspot number on a date (ms, UTC). NOAA's table (linear between mid-months), then Hathaway cycles every 11 years. */
export function ssnForMs(ms) {
  if (ms <= NOAA_START_MS) return NOAA_SSN[0];
  if (ms <= NOAA_END_MS) {
    const x = (ms - NOAA_START_MS) / (NOAA_END_MS - NOAA_START_MS) * (NOAA_SSN.length - 1);
    const i = Math.min(NOAA_SSN.length - 2, Math.floor(x));
    return NOAA_SSN[i] + (NOAA_SSN[i + 1] - NOAA_SSN[i]) * (x - i);
  }
  const m = monthsOf(ms);
  let s = 0;
  for (let k = 0; CYCLE26_T0_MONTHS + CYCLE_MONTHS * k < m; k++) s += hathawayShape(m - CYCLE26_T0_MONTHS - CYCLE_MONTHS * k);
  return s;
}

// Sunspot number -> F10.7 from NOAA's own pairs (the table's months), then the high-end slope 0.97 per sunspot.
const SSN_KNOTS = [[0, 67.1], [8.0, 70.3], [16.7, 73.8], [33.1, 81.9], [57.9, 98.0], [83.8, 123.2]];
export function f107ForSsn(ssn) {
  const k = SSN_KNOTS;
  if (ssn <= 0) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (ssn <= k[i][0]) return k[i - 1][1] + (k[i][1] - k[i - 1][1]) * (ssn - k[i - 1][0]) / (k[i][0] - k[i - 1][0]);
  }
  return k[k.length - 1][1] + 0.97 * (ssn - k[k.length - 1][0]);
}

/** The smoothed F10.7 (solar flux units) on a date (ms, UTC): NOAA's table until 2030-12, then the cycle shape. */
export function f107ForMs(ms) {
  if (ms <= NOAA_START_MS) return NOAA_F107[0];
  if (ms <= NOAA_END_MS) {
    const x = (ms - NOAA_START_MS) / (NOAA_END_MS - NOAA_START_MS) * (NOAA_F107.length - 1);
    const i = Math.min(NOAA_F107.length - 2, Math.floor(x));
    return NOAA_F107[i] + (NOAA_F107[i + 1] - NOAA_F107[i]) * (x - i);
  }
  return f107ForSsn(ssnForMs(ms));
}

// ---------------------------------------------------------------------------------------------------------------------------
// The storm calendar
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * Storm days per 11-year cycle by level, CUMULATIVE: a day with Kp 7 is also a day with Kp >= 5 and >= 6, so each entry counts every
 * day at that level or stronger. Recalibrated 2026-11-16 (the first version summed NOAA's per-level counts as separate days and
 * gave 44 % of days stormy in 2026 and 70 % in 2034, 4-7 times the record; even NOAA's own table runs above it).
 * Anchor: the measured record, GFZ definitive Kp 1996-2025, mean 35.7 days a year with Kp >= 5, i.e. 393 per 11 years
 * (third-party table of GFZ Kp: https://auroraforecast.me/data/research/aurora-2026-11/annual-kp-1996-2025.csv; 2003 120 days,
 * 2015 56, 2024 36, 2009 and 2020 3). The levels are split by NOAA's ratios (https://www.swpc.noaa.gov/noaa-scales-explanation,
 * days per cycle G1 900 / G2 360 / G3 130 / G4 60 / G5 4): Kp >= 6 is 0.40, >= 7 0.144, >= 8 0.067 and Kp 9 0.0044 of the
 * Kp >= 5 days, giving 393 / 157 / 57 / 26 / 1.7. The exact-level days are the differences.
 */
export const STORM_DAYS_PER_CYCLE = { 5: 393, 6: 393 * 0.40, 7: 393 * 0.144, 8: 393 * 0.067, 9: 393 * 0.0044 };
const CYCLE_DAYS = 11 * 365.25;
const KP_LEVELS = [9, 8, 7, 6, 5];

/** A deterministic uniform number in [0, 1) from a seed and a number (a 32-bit integer hash). */
export function hash01(seed, n) {
  let h = (seed ^ Math.imul(n | 0, 0x9E3779B1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** The chance that a day has a storm of AT LEAST this Kp level (each level's days scale with the smoothed sunspot number). */
function levelChance(kp, ssn) { return STORM_DAYS_PER_CYCLE[kp] * ssn / (MEAN_SSN * CYCLE_DAYS); }

/**
 * The strongest storm on a calendar day: 0 (none) or Kp 5..9. One draw per day against the cumulative chances, so a day holds one level (its strongest). The same seed and day
 * always give the same answer.
 * @param {number} seed the save's calendar seed @param {number} dayIdx whole days since 1970-01-01 (UTC)
 * @returns {number}
 */
export function kpOnDay(seed, dayIdx) {
  const ssn = ssnForMs((dayIdx + 0.5) * DAY_MS);
  const u = hash01(seed >>> 0, dayIdx);
  for (const kp of KP_LEVELS) if (u < levelChance(kp, ssn)) return kp;      // nested: the cumulative chance, strongest first
  return 0;
}

/** @param {number} ms @returns {number} whole days since 1970-01-01 (UTC) */
export function dayOf(ms) { return Math.floor(ms / DAY_MS); }

/** One day's Sun level and storm. @param {number} seed @param {number} dayIdx @returns {{dayIdx: number, f107: number, kp: number}} */
export function dayState(seed, dayIdx) {
  return { dayIdx, f107: f107ForMs((dayIdx + 0.5) * DAY_MS), kp: kpOnDay(seed, dayIdx) };
}

// Per-row ln multiplier of a day, cached: the game asks for the air many times a frame, the trip pricing walks many days.
const _tables = new Map();
const TABLE_MAX = 256;
function tableFor(seed, dayIdx, storms) {
  // a number, not a string: the debris loop asks for the air hundreds of times a frame (day + 65536 < 2^17 and seed < 2^32 keep it under 2^50, exact)
  const key = ((dayIdx + 65536) * 4294967296 + (seed >>> 0)) * 2 + (storms ? 1 : 0);
  let t = _tables.get(key);
  if (t === undefined) {
    const s = dayState(seed, dayIdx);
    const ln = new Float64Array(ROWS);
    for (let i = 0; i < ROWS; i++) {
      const h = ROW0_KM + i * ROW_STEP_KM;
      ln[i] = Math.log(sunMultiplier(h, s.f107) * (storms ? stormMultiplier(h, s.f107, s.kp) : 1));
    }
    t = { ln, f107: s.f107, kp: s.kp };
    if (_tables.size >= TABLE_MAX) _tables.delete(_tables.keys().next().value);
    _tables.set(key, t);
  }
  return t;
}

/**
 * The multiplier on the game's air at a height on one calendar day (Sun level times that day's storm).
 * @param {number} seed @param {number} dayIdx @param {number} altKm @param {boolean} [storms=true] false = the quiet-day comparison (Sun level only)
 * @returns {number}
 */
export function dayAirMultiplier(seed, dayIdx, altKm, storms = true) {
  const ln = tableFor(seed, dayIdx, storms).ln;
  const [i, w] = rowAt(altKm);
  return Math.exp(ln[i] * (1 - w) + ln[i + 1] * w);
}

// ---------------------------------------------------------------------------------------------------------------------------
// The game's clock and the hook into the air
// ---------------------------------------------------------------------------------------------------------------------------

/** How busy the Sun is, in two words. @param {number} f107 @returns {string} */
export function sunWord(f107) { return f107 < 95 ? 'quiet' : (f107 < 150 ? 'middling' : 'busy'); }

/** Round a multiplier to two figures for a line ("0.65", "3.4", "12"). */
export function multText(m) {
  if (!Number.isFinite(m)) return '1';
  if (m >= 10) return String(Math.round(m));
  return (Math.round(m * (m >= 1 ? 10 : 100)) / (m >= 1 ? 10 : 100)).toString();
}

export class SunStorms {
  /** @param {{state?: object, now?: () => number}} [opts] `state` the game state holding `skyStartMs`, `skySeed`, `shipDays` (default the game's) */
  constructor(opts = {}) {
    this._state = opts.state || gameState;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.installed = false;
  }

  /** Put the multiplier into the game's air (OrbitalMechanics.atmosphericDensity) and the real per-piece drag on. */
  install() { this.installed = true; setAirModel(this); }

  /** Take it out again (tests). */
  uninstall() { this.installed = false; setAirModel(null); }

  /** True while the calendar rules: installed and not in training missions 1-3. */
  live() { return this.installed && !isTrainingNow(); }

  /** Air-model hook (OrbitalMechanics): real per-piece drag instead of keep-together. */
  realDrag() { return this.live(); }

  /** Air-model hook: the multiplier at a height today (1 when the calendar is not live). */
  multiplier(altKm) {
    if (!this.live()) return 1;
    const s = this._state;
    if (!Number.isFinite(s.skyStartMs)) this.ensureStart();
    return dayAirMultiplier(s.skySeed >>> 0, dayOf(this.dateMs()), altKm);
  }

  /** Stamp the first start (the real date) and the calendar seed once, on first use. Returns false when it already was. */
  ensureStart() {
    const s = this._state;
    let stamped = false;
    if (!Number.isFinite(s.skyStartMs)) { s.skyStartMs = this._now(); stamped = true; }
    if (!Number.isFinite(s.skySeed)) { s.skySeed = Math.floor(Math.random() * 4294967296) >>> 0; stamped = true; }
    return stamped;
  }

  /** The game date, ms: the real date of her first start plus the days the ship has lived. NaN before the first start. */
  dateMs() {
    const s = this._state;
    return s.skyStartMs + (Number.isFinite(s.shipDays) ? s.shipDays : 0) * DAY_MS;
  }

  /** @returns {{dayIdx: number, ms: number, f107: number, kp: number}|null} today's Sun and storm; null when the calendar is not live */
  today() {
    if (!this.live()) return null;
    this.ensureStart();
    const ms = this.dateMs();
    const d = dayState(this._state.skySeed >>> 0, dayOf(ms));
    return { dayIdx: d.dayIdx, ms, f107: d.f107, kp: d.kp };
  }

  /** @returns {{startMs: number, seed: number}|null} what a trip walks the calendar with (departure date and seed); null when not live */
  sky() {
    if (!this.live()) return null;
    this.ensureStart();
    return { startMs: this.dateMs(), seed: this._state.skySeed >>> 0 };
  }

  /**
   * The one map line on how busy the Sun is and what the air is like at her height ("Sun middling, air x0.65 here"; on a storm day
   * "Storm Kp 7, air x3.4 here"). Empty when the calendar is not live.
   * @param {number} altKm her height
   * @returns {string}
   */
  sunLine(altKm) {
    const t = this.today();
    if (!t || !Number.isFinite(altKm)) return '';
    const m = airMultiplier(altKm, t.f107, t.kp);
    return t.kp >= 5 ? `Storm Kp ${t.kp}, air x${multText(m)} here` : `Sun ${sunWord(t.f107)}, air x${multText(m)} here`;
  }
}

/** The game's one calendar. main.js installs it; tests that set no game date never do, so the air is the table as ever. */
export const sunStorms = new SunStorms();

/** What a trip plans with right now: `{startMs, seed}` or null (not installed, or training). */
export function currentSky() { return sunStorms.sky(); }
