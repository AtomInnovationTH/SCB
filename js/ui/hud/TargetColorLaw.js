/**
 * TargetColorLaw.js — ONE target colour law (Session Q, plan D15 / D15c,
 * owner 2026-09-07 — "reticle colours nobody understood"). The same piece of
 * debris wears the SAME colour on its bracket, its off-screen arrow and its
 * TARGETS row, and every colour means exactly one thing (Airbus A2 borrowed
 * as a practice; TCAS A6 for the shapes: thin far, thick near, amber
 * attention, red act).
 *
 * This module is the PURE CORE — numbers in, a class out. No DOM, no timers,
 * no Constants import (consumers pass the numbers in); the only import is the
 * colour alphabet (VisualLaw.COLORS). Consumers: TargetReticle (the bracket,
 * the arrow, the caution word in the DE-SPIN slot) and TargetPanel (the row,
 * the dot, the odds). Absent law → each consumer paints its shipped colours,
 * so `?ladder=0` is byte-identical.
 *
 * THE CLASSES (precedence, first match wins):
 *   danger    THREAT red      the RED-tier conjunction threat — act now; word CONJUNCTION
 *   managed   magenta         the autopilot's locked target while it flies (D15c)
 *   selected  SELECTION blue  pilot-selected — the bracket, the arrow, the row
 *   caution   CAUTION amber   abnormal, steady, with a WORD: CLOSE PASS (the
 *                             YELLOW-tier threat) · HYDRAZINE · TUMBLING (> 20 °/s)
 *                             · HEAVY (≥ 3000 kg) — finish your task first
 *   in-reach  PLAYER green    inside the ready tether — thick corners, bright row, ●
 *   tracked   PLAYER green    everything else — thin corners, dim row, ○
 *
 * COLOUR IS NEVER THE SOLE CHANNEL: every class also fixes a weight (thick /
 * thin), an alpha (0.85 / THIN_ALPHA), the word and the arrow set (off-screen
 * arrows for danger / managed / selected ONLY — the shipped "everything
 * within 50 km" arrow rule is the clutter the owner named). The caution word
 * is ALWAYS painted in its own colour (THREAT for the danger word, CAUTION
 * otherwise) so an amber word survives on a blue selected bracket.
 *
 * REACH is the TETHER reach (TargetPanel's rule, extracted verbatim in
 * `reachKmFrom`): the longest tether among arms that are DOCKED with fuel > 5
 * — weaver 2 km over spinner 0.5 km; none ready → 0 → nothing is in reach.
 * `approachLive` (D12c) is the inhibit window's trigger: the selected target
 * inside reach × APPROACH_FACTOR.
 *
 * Everything non-finite reads as ABSENT: a NaN tumble → no word; a NaN
 * distance → tracked; reach 0 → nothing in reach. Value (pts, kg, the rupee)
 * is never a colour.
 *
 * @module ui/hud/TargetColorLaw
 */

import { VisualLaw } from '../../core/VisualLaw.js';

const C = VisualLaw.COLORS;

/** The six classes in precedence order (first match wins). */
export const TARGET_CLASSES = Object.freeze(['danger', 'managed', 'selected', 'caution', 'in-reach', 'tracked']);

/** Magenta = computer-managed (Airbus A2): the AP's locked target. A module constant, never a law key, never a flag. */
export const MANAGED_MAGENTA = '#ff44ff';

/** Class → colour. Two classes share PLAYER green; weight and alpha tell them apart. */
export const TARGET_COLORS = Object.freeze({
  danger: C.THREAT,
  managed: MANAGED_MAGENTA,
  selected: C.SELECTION,
  caution: C.CAUTION,
  'in-reach': C.PLAYER,
  tracked: C.PLAYER,
});

/** The shipped "medium tumble" edge (TargetReticle._getDebrisColor's amber tier), °/s. */
export const CAUTION_TUMBLE_DEG_S = 20;

/** The shipped rocket-body mass edge, now any type, kg. */
export const HEAVY_KG = 3000;

/**
 * The words. ASCII only (the house typographic set). Precedence in classify:
 * CONJUNCTION (the danger word) > CLOSE PASS > HYDRAZINE > TUMBLING > HEAVY.
 */
export const WORDS = Object.freeze({
  closePass: 'CLOSE PASS',
  hydrazine: 'HYDRAZINE',
  tumbling: 'TUMBLING',
  heavy: 'HEAVY',
  conjunction: 'CONJUNCTION',
});

/** The inhibit window (D12c): the selected target inside reach × this. */
export const APPROACH_FACTOR = 1.5;

/** Tracked corners / dim rows. Thick (the shipped bracket alpha) is 0.85. */
export const THIN_ALPHA = 0.55;
export const THICK_ALPHA = 0.85;

/** Odds tiers: green ≥ GOOD · amber FAIR–(GOOD−1) · dim below. */
export const ODDS = Object.freeze({ GOOD: 80, FAIR: 50 });

/** The dim odds colour — equals Constants.TOOL_HUD.COLOR_ZERO (pinned equal in the test; not imported: purity). */
export const ODDS_DIM = 'rgba(180,200,210,0.45)';

/** The default tether reaches, km (Constants.WEAVER_TETHER_LENGTH / SPINNER_TETHER_LENGTH / 1000 — pinned equal). */
export const TETHER_KM = Object.freeze({ weaver: 2, spinner: 0.5 });

/** @private A finite number or NaN. */
function _fin(v) {
  const n = (typeof v === 'number') ? v : ((v == null || typeof v === 'boolean' || typeof v === 'symbol') ? NaN : Number(v));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Classify one target.
 * @param {object} [t]
 * @param {boolean} [t.selected]   pilot-selected
 * @param {boolean} [t.managed]    the autopilot's locked target (D15c)
 * @param {string}  [t.threatTier] 'RED' | 'YELLOW' | anything else (the conjunction tier of THIS target, else null)
 * @param {boolean} [t.hydrazine]  salvage.hydrazine
 * @param {number}  [t.tumbleDegS] tumble rate in °/s
 * @param {number}  [t.massKg]
 * @param {number}  [t.distanceKm]
 * @param {number}  [t.reachKm]    the ready tether reach (0 = none)
 * @returns {{cls:string, color:string, word:(string|null), wordColor:string, weight:('thick'|'thin'), alpha:number, arrow:boolean}}
 */
export function classify(t) {
  const o = (t && typeof t === 'object') ? t : {};
  const tier = (typeof o.threatTier === 'string') ? o.threatTier : null;
  const tumble = _fin(o.tumbleDegS);
  const mass = _fin(o.massKg);
  const dist = _fin(o.distanceKm);
  const reach = _fin(o.reachKm);

  const word = tier === 'RED' ? WORDS.conjunction
    : tier === 'YELLOW' ? WORDS.closePass
    : o.hydrazine ? WORDS.hydrazine
    : (tumble > CAUTION_TUMBLE_DEG_S) ? WORDS.tumbling
    : (mass >= HEAVY_KG) ? WORDS.heavy
    : null;

  const inReach = reach > 0 && dist <= reach;

  const cls = tier === 'RED' ? 'danger'
    : o.managed ? 'managed'
    : o.selected ? 'selected'
    : word ? 'caution'
    : inReach ? 'in-reach'
    : 'tracked';

  const prime = cls === 'danger' || cls === 'managed' || cls === 'selected';
  const weight = (prime || inReach) ? 'thick' : 'thin';
  return {
    cls,
    color: TARGET_COLORS[cls],
    word,
    wordColor: cls === 'danger' ? C.THREAT : C.CAUTION,
    weight,
    alpha: weight === 'thick' ? THICK_ALPHA : THIN_ALPHA,
    arrow: prime,
  };
}

/**
 * The odds tier. `overflow` (the bag-span qualifier, TargetPanel register
 * item 17) only ever DOWNGRADES a good to fair — it never lifts a poor (the
 * consumer only raises it at pct ≥ 80; the rule is pinned here anyway).
 * @param {number} pct 0–100
 * @param {boolean} [overflow]
 * @returns {'good'|'fair'|'poor'|'none'}
 */
export function oddsTier(pct, overflow = false) {
  const p = _fin(pct);
  if (!(p > 0)) return 'none';
  if (p >= ODDS.GOOD) return overflow ? 'fair' : 'good';
  if (p >= ODDS.FAIR) return 'fair';
  return 'poor';
}

/**
 * The odds colour: PLAYER (good) · CAUTION (fair, or any overflow) · ODDS_DIM (poor / none).
 * @param {number} pct
 * @param {boolean} [overflow]
 * @returns {string}
 */
export function oddsColor(pct, overflow = false) {
  const tier = oddsTier(pct, overflow);
  return tier === 'good' ? C.PLAYER : tier === 'fair' ? C.CAUTION : ODDS_DIM;
}

/**
 * The ready TETHER reach, km — TargetPanel's rule extracted verbatim: the
 * longest tether among arms that are DOCKED with fuel > 5 (weaver over
 * spinner; any non-weaver type reads as a spinner, as shipped). Not an array
 * / nothing ready → 0.
 * @param {Array<{state:string, fuel:number, type:string}>} statuses  ArmManager.getAllStatus()
 * @param {{weaver:number, spinner:number}} [tetherKm]
 * @returns {number}
 */
export function reachKmFrom(statuses, tetherKm = TETHER_KM) {
  if (!Array.isArray(statuses)) return 0;
  const w = _fin(tetherKm && tetherKm.weaver);
  const s = _fin(tetherKm && tetherKm.spinner);
  let max = 0;
  for (const arm of statuses) {
    if (!arm || arm.state !== 'DOCKED' || !(arm.fuel > 5)) continue;
    const km = arm.type === 'weaver' ? w : s;
    if (Number.isFinite(km) && km > max) max = km;
  }
  return max;
}

/**
 * The inhibit window's trigger (D12c): the selected target inside reach × APPROACH_FACTOR.
 * @param {{distanceKm:number, reachKm:number}} [o]
 * @returns {boolean}
 */
export function approachLive(o) {
  const dist = _fin(o && o.distanceKm);
  const reach = _fin(o && o.reachKm);
  return reach > 0 && dist <= reach * APPROACH_FACTOR;
}
