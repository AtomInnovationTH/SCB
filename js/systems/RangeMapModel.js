/**
 * RangeMapModel - the numbers behind the orbital range map (range-map lane, 2026-10-25; owner: "an orbital map to clearly understand
 * their range and choices with current fuel and salvage fuel"; "rings around Earth"; plan D1-D6). Pure: no DOM, no events, no game state.
 * The view (js/ui/RangeMap.js) draws what this says.
 *
 *   rangeMapRect(viewW, viewH, mode)     where the square panel sits on the left of the screen, clear of the list, the floor rail and the footer band
 *   buildLayout({rows, herKm, side})     the rings: one per distinct height of the where-next rows (+ hers), radius by RANK of height (not
 *                                        to scale) with a visible break at a big height gap, every ring's label box placed so no two overlap
 *   reachBand(layout)                    the annulus from the lowest to the highest ring she can reach now (the rows in state 'ok')
 *   spiralAt / spiralPoints              her path from her ring to the picked one: radius follows the real climb (the profile's samples),
 *                                        two stylised turns over the trip
 *   orbitCount(samples) / orbitLine(n)   "She circles Earth about N times on the way": the sum of dt / period(a), computed
 *   hitTest(layout, x, y)                the ring a tap is nearest to
 *   gasAboardLine / catchesLine / movesLine / tripDayText / textLines   the words (the lines under the canvas: short, 0.1 kg)
 *
 * A ring is made by a field row, a satellite row or the Stay row (her own field); the call row (a satellite's trip to her) and the push-down
 * rows (a height of their own) make none: the call is drawn as an arrow between rings. Her own ring exists even when no row carries it
 * (berthed at a satellite).
 *
 * @module systems/RangeMapModel
 */

import { Constants } from '../core/Constants.js';
import { profileAt } from './TripProfile.js';
import { kgText } from './WhereNextRows.js';

const DOT = '\u00b7';
const R = () => Constants.RANGE_MAP;

// ── The panel ────────────────────────────────────────────────────────────────

/**
 * @private The floor rail's box for the clearance: the live `left` / `bottom` edges when given (RailIndicator.leftPx() / bottomPx()), else the
 * rail at its design place (RANGE_MAP.RAIL_*: RAIL_EDGE_PX in from the right edge, mid-height). `false` = no rail. A missing edge reads as the design one.
 */
function railBox(viewW, viewH, rail) {
  if (rail === false) return null;
  const c = R();
  const r = rail && typeof rail === 'object' ? rail : {};
  const left = Number.isFinite(r.left) ? r.left : viewW - c.RAIL_EDGE_PX - c.RAIL_W_PX;
  const bottom = Number.isFinite(r.bottom) ? r.bottom : viewH / 2 + c.RAIL_H_PX / 2;
  const top = Number.isFinite(r.top) ? r.top : bottom - c.RAIL_H_PX;
  return { left, top, bottom };
}

/**
 * The square the map takes, in CSS px (D5, moved to the left in F1.1: the height column's place). Left edge LEFT_PX, top at TOP_PX (below the
 * top HUD strip). `mode` 'choose': the where-next list is open, so the map stays left of its x-span (the list is bottom centre, its top never
 * above y 280: their y-spans always overlap, so the clearance is in x) and is at most SIDE_CHOOSE_PX; 'trip': the list is closed and the map may
 * be SIDE_TRIP_PX. The text lines under the canvas (TEXT_PX) count against the room below, which ends BOTTOM_PX above the screen's bottom (the
 * footer band). In both modes it stays left of the floor rail (`opts.rail`: `{left, bottom}` live edges, nothing = the rail at its design place,
 * `false` = none) whenever their y-spans can meet. The open drawer (x 0 to 440, z 35) may cover it; the height column yields while it shows.
 * Null when it would be narrower than MIN_SIDE_PX (then the map is not shown).
 * @param {number} viewW @param {number} viewH @param {'choose'|'trip'} [mode]
 * @param {{rail?: ({left?: number, bottom?: number, top?: number}|false|null)}} [opts]
 * @returns {{x: number, y: number, w: number, h: number, side: number}|null}
 */
export function rangeMapRect(viewW, viewH, mode = 'choose', opts = {}) {
  const c = R();
  if (!(viewW > 0) || !(viewH > 0)) return null;
  const trip = mode === 'trip';
  const left = c.LEFT_PX;
  let side = Math.min(trip ? c.SIDE_TRIP_PX : c.SIDE_CHOOSE_PX, viewH - c.BOTTOM_PX - c.TOP_PX - c.TEXT_PX);
  if (!trip) {
    const listW = Math.min(c.LIST_WIDTH_PX, viewW - 2 * c.LIST_SIDE_PX);        // the list's CSS: min(580px, 100vw - 24px), centred
    side = Math.min(side, (viewW - listW) / 2 - c.LIST_GAP_PX - left);
  }
  const rail = railBox(viewW, viewH, opts ? opts.rail : undefined);
  if (rail && rail.top < c.TOP_PX + side + c.TEXT_PX && rail.bottom > c.TOP_PX) side = Math.min(side, rail.left - c.RAIL_GAP_PX - left);
  if (!(side >= c.MIN_SIDE_PX)) return null;
  return { x: left, y: c.TOP_PX, w: side, h: side, side };
}

// ── The rings ────────────────────────────────────────────────────────────────

/** @private how a row's state reads on its ring */
function ringState(row) {
  if (!row) return 'here';
  switch (row.state) {
    case 'ok': return 'ok';
    case 'cleared': return 'cleared';
    case 'stay': case 'here': return 'here';
    default: return 'grey';            // short, cannot, mission, poor
  }
}

/** @private "3 d" / "<1 d" */
function daysShort(days) {
  if (!(days >= 1)) return '<1 d';
  return `${Math.round(days)} d`;
}

/**
 * The words on a ring: "750 km · 4.7 kg · 43 d", or the reason when it cannot be reached ("750 km · short 1.2 kg"). A satellite starts "sat".
 * @param {{altKm: number}} ring @param {object|null} row the ring's row @param {boolean} here her own ring
 * @returns {string}
 */
export function ringLabel(ring, row, here) {
  const km = `${Math.round(ring.altKm)} km`;
  const head = row && row.kind === 'satellite' ? `sat ${km}` : km;
  if (here || !row) return `${head} ${DOT} here`;
  switch (row.state) {
    case 'ok': return `${head} ${DOT} ${kgText(row.gasKg)} kg ${DOT} ${daysShort(row.days)}`;
    case 'short': return `${head} ${DOT} short ${kgText(row.shortKg)} kg`;
    case 'cannot': return `${head} ${DOT} too far`;
    case 'cleared': return `${head} ${DOT} cleared`;
    case 'mission': return `${head} ${DOT} later`;
    default: return head;
  }
}

/** @private the width of a label box for this text */
const boxWidth = (text) => Math.ceil(text.length * R().LABEL_CHAR_PX + 2 * R().LABEL_PAD_PX);

/** @private do two boxes overlap (a 1 px air gap counts as overlap) */
function overlaps(a, b) {
  return a.x < b.x + b.w + 1 && b.x < a.x + a.w + 1 && a.y < b.y + b.h + 1 && b.y < a.y + a.h + 1;
}

/**
 * Build the rings and place their labels. Rows: `buildWhereNextRows(...).rows` (or `list.rowData()`), every one, not the top five.
 * @param {{rows: object[], herKm: (number|null), side: number}} p
 * @returns {{side: number, cx: number, cy: number, earthR: number, outerR: number, stepPx: number, herKm: (number|null), hereIndex: number,
 *   rings: Array<object>, breaks: Array<object>}} each ring: `{index, altKm, radius, rowId, row, kind, state, here, label, box:{x,y,w,h}, angleDeg, spacingPx}`;
 *   each break: `{between:[i,i+1], gapKm, innerR, outerR, midR, label, box}`
 */
export function buildLayout({ rows, herKm, side }) {
  const c = R();
  const all = Array.isArray(rows) ? rows : [];
  const her = Number.isFinite(herKm) ? herKm : null;
  const cx = side / 2;
  const cy = side / 2;
  // one entry per distinct height, from the rows that make a ring
  const byHeight = [];
  const at = (km) => byHeight.find((e) => Math.abs(e.altKm - km) < 0.5);
  const rank = { satellite: 3, field: 3, stay: 2 };
  for (const r of all) {
    if (!r || !Number.isFinite(r.altKm) || rank[r.kind] === undefined) continue;
    let e = at(r.altKm);
    if (!e) { e = { altKm: r.altKm, row: null }; byHeight.push(e); }
    if (!e.row || rank[r.kind] > rank[e.row.kind]) e.row = r;
  }
  // her own ring: the Stay row's, else the ring within 5 km of her height, else one of its own
  const stayEntry = byHeight.find((e) => e.row && e.row.kind === 'stay') || null;
  let hereEntry = stayEntry;
  if (!hereEntry && her !== null) {
    hereEntry = byHeight.find((e) => Math.abs(e.altKm - her) <= 5) || null;
    if (!hereEntry) { hereEntry = { altKm: her, row: null }; byHeight.push(hereEntry); }
  }
  byHeight.sort((a, b) => a.altKm - b.altKm);
  const n = byHeight.length;

  // radii: by rank of height; a gap of BREAK_KM or more gets BREAK_EXTRA spacings more
  const f = c.EARTH_FRAC;
  const maxOuter = side / 2 - c.PAD_PX - c.LABEL_H_PX / 2;
  const units = [];
  let total = 0;
  for (let k = 0; k < n; k++) {
    const u = k === 0 ? 1 : 1 + (byHeight[k].altKm - byHeight[k - 1].altKm >= c.BREAK_KM ? c.BREAK_EXTRA : 0);
    units.push(u); total += u;
  }
  let outerR = Math.max(1, maxOuter);
  let step = n ? outerR * (1 - f) / total : 0;
  if (step > c.RING_MAX_STEP_PX) { step = c.RING_MAX_STEP_PX; outerR = total * step / (1 - f); }
  const earthR = f * outerR;
  const rings = [];
  let rad = earthR;
  for (let k = 0; k < n; k++) {
    rad += units[k] * step;
    const e = byHeight[k];
    const here = e === hereEntry;
    const state = here ? 'here' : ringState(e.row);
    const ring = {
      index: k, altKm: e.altKm, radius: rad, rowId: e.row ? e.row.id : null, row: e.row, kind: e.row ? e.row.kind : null,
      state, rowState: e.row ? e.row.state : null, here, label: '', box: null, angleDeg: 0, spacingPx: step,
    };
    ring.label = ringLabel(ring, e.row, here);
    rings.push(ring);
  }
  for (let k = 0; k < n; k++) {
    const up = k + 1 < n ? rings[k + 1].radius - rings[k].radius : Infinity;
    const down = k > 0 ? rings[k].radius - rings[k - 1].radius : rings[k].radius - earthR;
    rings[k].spacingPx = Math.min(up, down);
  }
  const breaks = [];
  for (let k = 1; k < n; k++) {
    if (rings[k].altKm - rings[k - 1].altKm < c.BREAK_KM) continue;
    const gapKm = rings[k].altKm - rings[k - 1].altKm;
    const label = `${Math.round(gapKm)} km`;
    const midR = (rings[k - 1].radius + rings[k].radius) / 2;
    breaks.push({ between: [k - 1, k], gapKm, innerR: rings[k - 1].radius, outerR: rings[k].radius, midR, label, box: null });
  }
  const layout = {
    side, cx, cy, earthR, outerR: n ? rings[n - 1].radius : earthR, stepPx: step, herKm: her,
    hereIndex: hereEntry ? byHeight.indexOf(hereEntry) : -1, rings, breaks,
  };
  placeLabels(layout);
  return layout;
}

/** @private clamp a box inside the canvas (shifts it; never shrinks it) */
function clampBox(b, side) {
  return { x: Math.max(0, Math.min(side - b.w, b.x)), y: Math.max(0, Math.min(side - b.h, b.y)), w: b.w, h: b.h };
}

/**
 * @private Put every label box on its ring at an angle where it overlaps no other box and stays inside the canvas. A ring's label is
 * centred where the ring crosses the preferred radial: straight up for every other ring and straight down for the others, so
 * neighbouring labels sit on opposite sides and a label's neighbour on its own side is two ring spacings away; when that spot is taken
 * (a tight map) the angle fans out in 10 degree steps, then the least overlapping spot is kept. The break labels go first, on the right.
 */
function placeLabels(layout) {
  const c = R();
  const { cx, cy, side } = layout;
  const placed = [];
  for (const b of layout.breaks) {
    const w = boxWidth(b.label);
    const box = clampBox({ x: cx + b.midR - w / 2, y: cy - c.LABEL_H_PX / 2, w, h: c.LABEL_H_PX }, side);
    b.box = box;
    placed.push(box);
  }
  for (let i = layout.rings.length - 1; i >= 0; i--) {
    const ring = layout.rings[i];
    const w = boxWidth(ring.label);
    const pref = i % 2 === 0 ? -90 : 90;                    // canvas degrees: y grows downward, so -90 is straight up
    const tries = [pref];
    for (let d = 10; d <= 180; d += 10) tries.push(pref + d, pref - d);
    let best = null;
    for (const deg of tries) {
      const rad = deg * Math.PI / 180;
      const px = cx + ring.radius * Math.cos(rad);
      const py = cy + ring.radius * Math.sin(rad);
      const box = clampBox({ x: px - w / 2, y: py - c.LABEL_H_PX / 2, w, h: c.LABEL_H_PX }, side);
      const hits = placed.reduce((s, p) => s + (overlaps(box, p) ? 1 : 0), 0);
      if (!best || hits < best.hits) best = { box, deg, hits };
      if (hits === 0) break;
    }
    ring.box = best.box;
    ring.angleDeg = best.deg;
    placed.push(best.box);
  }
}

/**
 * The radius a height is drawn at: straight lines between the rings (so a climb that lingers between two heights shows as a slow stretch),
 * held at the first and last ring beyond them, never inside the Earth disc.
 * @param {object} layout @param {number} altKm @returns {number}
 */
export function radiusOf(layout, altKm) {
  const rings = layout.rings;
  if (!rings.length || !Number.isFinite(altKm)) return layout.earthR;
  if (altKm <= rings[0].altKm) return rings[0].radius;
  const last = rings[rings.length - 1];
  if (altKm >= last.altKm) return last.radius;
  for (let k = 1; k < rings.length; k++) {
    if (altKm <= rings[k].altKm) {
      const a = rings[k - 1];
      const b = rings[k];
      const w = (altKm - a.altKm) / (b.altKm - a.altKm);
      return a.radius + w * (b.radius - a.radius);
    }
  }
  return last.radius;
}

/**
 * Her reach now: the rings whose row can be flown (state 'ok'), as one band from the lowest to the highest, a half ring spacing wider on each side
 * so a lone ring has a body. Null when nothing can be flown.
 * @param {object} layout
 * @returns {{innerR: number, outerR: number, innerAltKm: number, outerAltKm: number, altKms: number[], ids: string[]}|null}
 */
export function reachBand(layout) {
  const ok = layout.rings.filter((r) => r.state === 'ok');
  if (!ok.length) return null;
  const half = layout.stepPx / 2;
  return {
    innerR: Math.max(layout.earthR, ok[0].radius - half), outerR: ok[ok.length - 1].radius + half,
    innerAltKm: ok[0].altKm, outerAltKm: ok[ok.length - 1].altKm, altKms: ok.map((r) => r.altKm), ids: ok.map((r) => r.rowId),
  };
}

/**
 * The ring a row belongs to: a field, satellite or Stay row its own; the call row its satellite's; a push-down row none.
 * @param {object} layout @param {string|null} rowId @param {object[]} [rows] the rows (to find a call row's satellite)
 * @returns {object|null}
 */
export function ringOfRow(layout, rowId, rows) {
  if (rowId == null) return null;
  const own = layout.rings.find((r) => r.rowId === rowId);
  if (own) return own;
  const row = Array.isArray(rows) ? rows.find((r) => r && r.id === rowId) : null;
  if (row && row.kind === 'call') return layout.rings.find((r) => r.rowId === row.satId) || null;
  return null;
}

// ── Her path ─────────────────────────────────────────────────────────────────

/**
 * Where she is on the path at `f` (0..1 of the trip's time): the radius is the real climb's height (the profile's samples) through the
 * ring scale, the angle advances `turns` stylised turns over the trip, counter-clockwise on screen from `startRad`.
 * @param {object} layout
 * @param {{profile?: object|null, fromKm: number, toKm: number, turns?: number, startRad?: number}} plan `profile`: `planTo(id).profile`;
 *   without samples the height goes straight from `fromKm` to `toKm`
 * @param {number} f
 * @returns {{x: number, y: number, radius: number, angle: number, altKm: number}}
 */
export function spiralAt(layout, plan, f) {
  const turns = Number.isFinite(plan.turns) ? plan.turns : R().SPIRAL_TURNS;
  const start = Number.isFinite(plan.startRad) ? plan.startRad : Math.PI;
  const g = Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0;
  const prof = plan.profile;
  const altKm = prof && Array.isArray(prof.samples) && prof.samples.length >= 2
    ? profileAt(prof, g).altKm
    : plan.fromKm + g * (plan.toKm - plan.fromKm);
  const radius = radiusOf(layout, altKm);
  const angle = start + turns * 2 * Math.PI * g;
  return { x: layout.cx + radius * Math.cos(angle), y: layout.cy - radius * Math.sin(angle), radius, angle, altKm };
}

/** @param {object} layout @param {object} plan see spiralAt @param {number} [n] points (default SPIRAL_POINTS) @returns {Array<{x:number,y:number,radius:number,angle:number,altKm:number,f:number}>} */
export function spiralPoints(layout, plan, n = R().SPIRAL_POINTS) {
  const out = [];
  const m = Math.max(2, Math.round(n));
  for (let k = 0; k <= m; k++) out.push({ ...spiralAt(layout, plan, k / m), f: k / m });
  return out;
}

/**
 * The arrow of a called satellite (no burn: it comes to her): straight along one radial from its ring to hers.
 * @param {object} layout @param {number} satKm @param {number} herKm @param {number} [angle] radians, default straight right
 * @returns {{from: {x: number, y: number}, to: {x: number, y: number}}}
 */
export function callArrow(layout, satKm, herKm, angle = 0) {
  const at = (km) => { const r = radiusOf(layout, km); return { x: layout.cx + r * Math.cos(angle), y: layout.cy - r * Math.sin(angle) }; };
  return { from: at(satKm), to: at(herKm) };
}

/**
 * How many times she goes round Earth on a trip: the sum over the profile's samples of dt / period(a), with a the semi-major axis in km and
 * period = 2 pi sqrt(a^3 / mu). A computed number, not a constant: a slow climb through thick air goes round more.
 * @param {Array<{t: number, a: number}>} samples @returns {number}
 */
export function orbitCount(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return 0;
  const mu = Constants.MU_EARTH;
  let n = 0;
  for (let i = 1; i < samples.length; i++) {
    const A = samples[i - 1];
    const B = samples[i];
    const dt = B.t - A.t;
    if (!(dt > 0)) continue;
    const a = (A.a + B.a) / 2;
    n += dt / (2 * Math.PI * Math.sqrt(a * a * a / mu));
  }
  return n;
}

/** @param {number} n orbits @returns {string} "She circles Earth about 15 times on the way" ("about once" below 1.5) */
export function orbitLine(n) {
  const k = Math.round(n);
  if (!(n > 0)) return '';
  return k <= 1 ? 'She circles Earth about once on the way' : `She circles Earth about ${k} times on the way`;
}

// ── Taps ─────────────────────────────────────────────────────────────────────

/**
 * The ring a tap is nearest to, by distance from its circle, when within max(HIT_MIN_PX, half the ring's spacing); a tie goes to the lower ring.
 * @param {object} layout @param {number} x canvas px @param {number} y canvas px
 * @returns {object|null} the ring (its `rowId` may be null: her own ring while berthed)
 */
export function hitTest(layout, x, y) {
  if (!layout || !layout.rings.length || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const d = Math.hypot(x - layout.cx, y - layout.cy);
  let best = null;
  let bestDist = Infinity;
  for (const ring of layout.rings) {
    const dist = Math.abs(d - ring.radius);
    if (dist < bestDist - 1e-9) { best = ring; bestDist = dist; }
  }
  if (!best) return null;
  return bestDist <= Math.max(R().HIT_MIN_PX, best.spacingPx / 2) ? best : null;
}

// ── Words ────────────────────────────────────────────────────────────────────

/** @param {number} day @param {number} days @returns {string} "Day 3 of 43" */
export function tripDayText(day, days) {
  return `Day ${day} of ${days}`;
}

/** @private one decimal always (the owner's 0.1 kg; the where-next rows' `kgText` writes 0.05 below 0.1, these lines do not) */
const kg1 = (kg) => Math.max(0, Number.isFinite(kg) ? kg : 0).toFixed(1);

/** @param {number} aboardKg @param {number} tankKg @returns {string} "Gas aboard 9.8 of 20.8 kg" */
export function gasAboardLine(aboardKg, tankKg) {
  return `Gas aboard ${kg1(aboardKg)} of ${kg1(tankKg)} kg`;
}

/** @param {number} gainedKg gas her catches gave this mission @returns {string} "Catches this mission: +0.4 kg" ("0.0 kg" when it rounds to nothing: no sign on zero) */
export function catchesLine(gainedKg) {
  const t = kg1(gainedKg);
  return `Catches this mission: ${Number(t) > 0 ? '+' : ''}${t} kg`;
}

/** @param {number} usedKg gas her own moves used this mission @returns {string} "Her own moves: -1.3 kg" ("0.0 kg" when it rounds to nothing) */
export function movesLine(usedKg) {
  const t = kg1(usedKg);
  return `Her own moves: ${Number(t) > 0 ? '-' : ''}${t} kg`;
}

/** The line a called satellite shows where the day would be (nothing burns). */
export const CALL_LINE = 'The resupply satellite is on its way';

/**
 * The lines under the canvas, packed top-down and padded with '' to TEXT_LINES: the gas aboard, then (choosing, not berthed) what her catches gave
 * and what her own moves used, then how often she circles Earth on the chosen path, then the day of the trip (or the called satellite's note).
 * Each line is short enough for the smallest canvas (test-RangeMapModel pins the widest case).
 * @param {{aboardKg?: number, tankKg?: number, gainedKg?: number, usedKg?: number, showMission?: boolean, orbits?: number, day?: number, days?: number, called?: boolean}} [p]
 * @returns {string[]}
 */
export function textLines(p = {}) {
  const out = [];
  if (Number.isFinite(p.aboardKg) && Number.isFinite(p.tankKg)) out.push(gasAboardLine(p.aboardKg, p.tankKg));
  if (p.showMission && Number.isFinite(p.gainedKg) && Number.isFinite(p.usedKg)) { out.push(catchesLine(p.gainedKg)); out.push(movesLine(p.usedKg)); }
  const orbit = p.orbits > 0 ? orbitLine(p.orbits) : '';
  if (orbit) out.push(orbit);
  if (p.called) out.push(CALL_LINE);
  else if (Number.isFinite(p.day) && Number.isFinite(p.days)) out.push(tripDayText(p.day, p.days));
  const n = R().TEXT_LINES;
  while (out.length < n) out.push('');
  return out.slice(0, n);
}
