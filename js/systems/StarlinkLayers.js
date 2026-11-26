/**
 * StarlinkLayers.js — the four Starlink layers of the floor 4 globe, and what SpaceX has filed to add (Sky 37 lane M; DECISIONS §93 row 3,
 * §110; docs/research/2026-11-starlink-layers.md). Pure: no DOM, no THREE.
 *
 * A layer is a tilt and a height band that data/sky.json shows clearly: the satellites of one orbit shell. Measured 2026-11-26 on the
 * snapshot of 17 Nov 2026 (11,185 Starlink rows; `tmp/sky37-starlink/b.mjs`): the tilt window is +-2 degrees (+-1 to +-3 give the same counts);
 *   53 degrees  452-478 km  4,126      43 degrees  475-495 km  3,226      97 degrees (97.3)  452-470 km  1,452      70 degrees  465-480 km  597
 *   together 9,401; every other Starlink row is "Other" (1,784).
 * The height is the Brouwer semi-major axis (SkyPropagator `recoverBrouwer`) minus the equatorial radius, as the card's heights are.
 *
 * @module systems/StarlinkLayers
 */

import { recoverBrouwer, GP_HEIGHT_RADIUS_KM } from './SkyPropagator.js';

/** The tilt window, degrees either side of a layer's tilt (measured: +-1 to +-3 give the same four counts). */
export const TILT_WINDOW_DEG = 2;
/** The first and the last launch year the "Launched by" control steps through (the catalogue's Starlink rows run 2019-2026). */
export const YEAR_MIN = 2019;
export const YEAR_MAX = 2026;
/** Other Starlink satellites' colour (the key's working-satellite slate, readable on space and on faded debris). */
export const OTHER_COLOR = '#6f8fa8';

/**
 * The four layers, in menu order. `lo`/`hi` = the height window (km). Colours: 11-23 contrast measured against space and against faded debris
 * (docs/research/2026-11-starlink-layers.md); none of them is orange or tan (warm stays for things she can remove).
 */
export const LAYER_DEFS = Object.freeze([
  Object.freeze({ id: 'sl-53', tiltDeg: 53, lo: 452, hi: 478, color: '#bfe4f5' }),
  Object.freeze({ id: 'sl-43', tiltDeg: 43, lo: 475, hi: 495, color: '#5fd7c8' }),
  Object.freeze({ id: 'sl-97', tiltDeg: 97.3, lo: 452, hi: 470, color: '#9aa6ff' }),
  Object.freeze({ id: 'sl-70', tiltDeg: 70, lo: 465, hi: 480, color: '#d2b3ff' }),
]);

/** The latitude where an orbit of this tilt turns back: the tilt, or 180 - tilt when it is over 90 (97.3 degrees -> 82.7). @param {number} tiltDeg */
export const turnBackLatDeg = (tiltDeg) => (tiltDeg > 90 ? 180 - tiltDeg : tiltDeg);

/** The middle value of a list of numbers (the average of the two middle ones when the count is even); NaN for an empty list. */
export function median(values) {
  const a = Float64Array.from(values).sort();
  const n = a.length;
  if (n === 0) return NaN;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/**
 * What SpaceX has asked the FCC for beyond what flies now, one row per filing (sources read 2026-11-26, docs/research/2026-11-starlink-layers.md §4.1).
 * `shells` = [{heightKm, tiltDeg}] the filing names; `bands` = [{loKm, hiKm}] when only a height range is public.
 */
export const STARLINK_PLANS = Object.freeze([
  Object.freeze({
    id: 'gen2-2022', short: 'Gen2 2022', title: 'Gen2, first approval', status: 'approved', date: '2022-12-01', count: 7500,
    source: 'https://docs.fcc.gov/public/attachments/FCC-22-91A1.txt',   // FCC 22-91
    shells: Object.freeze([{ heightKm: 525, tiltDeg: 53 }, { heightKm: 530, tiltDeg: 43 }, { heightKm: 535, tiltDeg: 33 }].map(Object.freeze)), bands: null,
  }),
  Object.freeze({
    id: 'gen2-2026', short: 'Gen2 2026', title: 'Gen2, second approval', status: 'approved', date: '2026-01-09', count: 7500,
    source: 'https://docs.fcc.gov/public/attachments/DA-26-36A1.txt',   // FCC DA 26-36
    shells: Object.freeze([
      { heightKm: 340, tiltDeg: 53 }, { heightKm: 345, tiltDeg: 48 }, { heightKm: 350, tiltDeg: 38 }, { heightKm: 355, tiltDeg: 43 },
      { heightKm: 360, tiltDeg: 96.9 }, { heightKm: 365, tiltDeg: 28 }, { heightKm: 365, tiltDeg: 32 }, { heightKm: 475, tiltDeg: 28 },
      { heightKm: 475, tiltDeg: 32 }, { heightKm: 480, tiltDeg: 53 }, { heightKm: 485, tiltDeg: 43 },
    ].map(Object.freeze)), bands: null,
  }),
  Object.freeze({
    id: 'phones', short: 'To phones', title: 'Direct to phones', status: 'approved', date: '2026-10-06', count: 15000,
    source: 'https://docs.fcc.gov/public/attachments/DA-26-1078A1.txt',   // FCC DA 26-1078
    shells: Object.freeze([
      { heightKm: 335, tiltDeg: 26 }, { heightKm: 334, tiltDeg: 32 }, { heightKm: 333, tiltDeg: 38 }, { heightKm: 331, tiltDeg: 48 },
      { heightKm: 330, tiltDeg: 53 }, { heightKm: 329, tiltDeg: 60 }, { heightKm: 328, tiltDeg: 69 }, { heightKm: 327, tiltDeg: 76 },
      { heightKm: 326, tiltDeg: 96.87 },
    ].map(Object.freeze)), bands: null,
  }),
  Object.freeze({
    id: 'gen3', short: 'Gen3 filed', title: 'Gen3', status: 'filed', date: '2026-07-07', count: 100000,
    source: 'https://www.advanced-television.com/2026/09/21/fcc-accepts-starlink-100000-satellite-plan-for-filing',
    shells: null, bands: Object.freeze([{ loKm: 323, hiKm: 327.5 }, { loKm: 473, hiKm: 477.5 }].map(Object.freeze)),
  }),
  Object.freeze({
    // "six orbits, ranging from 550 km to about 1,000 km"; the shells are not published, so one band. First one due by Nov 2033, 100,000 by Nov 2035, all by Nov 2040.
    id: 'datacentres', short: 'Data centres', title: 'Data centres in space', status: 'approved-conditional', date: '2026-11-25', count: 1000000,
    source: 'https://arstechnica.com/space/2026/11/the-fcc-has-authorized-spacex-to-deploy-1-million-satellites/',
    shells: null, bands: Object.freeze([{ loKm: 550, hiKm: 1000 }].map(Object.freeze)),
  }),
]);

/** The three status words a filing carries, and what the player reads. */
export const PLAN_STATUS_WORDS = Object.freeze({ approved: 'approved', 'approved-conditional': 'approved with conditions', filed: 'asked for' });

/** Column numbers by name (data/sky.json `fields`), with the shipped order as the fallback. */
function cols(cat) {
  const f = cat.fields || [];
  const at = (n, d) => { const i = f.indexOf(n); return i >= 0 ? i : d; };
  return { norad: at('norad', 0), n: at('n', 9), e: at('e', 10), inc: at('incDeg', 11), year: at('year', 7) };
}

const _cache = new WeakMap();   // cat.rows -> the result (as HighlightItems' familyRows)

/**
 * Sort the catalogue's Starlink rows into the four layers and "Other".
 * @param {{rows:Array[], fields:string[]}} cat the catalogue (`layer.catalogue()`)
 * @param {(row:Array) => boolean} isStarlink the one Starlink rule (HighlightItems `isStarlink`); passed in so this file imports nothing back
 * @returns {{layers: Array<{id:string, tiltDeg:number, latDeg:number, heightKm:number, color:string, label:string, norads:number[]}>, other:number[], yearOf:Map<number,number>}}
 *   `heightKm` is the layer's median height (exact); `label` reads "53\u00b0 \u00b7 463 km" (the median rounded); `yearOf` maps a Starlink NORAD number to its launch year
 */
export function classifyStarlink(cat, isStarlink) {
  const hit = _cache.get(cat.rows);
  if (hit && hit.isStarlink === isStarlink) return hit.out;
  const c = cols(cat);
  const layers = LAYER_DEFS.map((d) => ({ ...d, norads: [], heights: [] }));
  const other = [], yearOf = new Map();
  for (const r of cat.rows) {
    if (!isStarlink(r)) continue;
    const norad = r[c.norad];
    const year = r[c.year];
    if (Number.isFinite(year)) yearOf.set(norad, year);
    const h = recoverBrouwer(r[c.n], r[c.e], r[c.inc] * Math.PI / 180).aKm - GP_HEIGHT_RADIUS_KM;
    const inc = r[c.inc];
    const L = layers.find((l) => Math.abs(inc - l.tiltDeg) <= TILT_WINDOW_DEG && h >= l.lo && h <= l.hi);
    if (L) { L.norads.push(norad); L.heights.push(h); } else other.push(norad);
  }
  const out = {
    layers: layers.map((l) => {
      const heightKm = median(l.heights);
      return { id: l.id, tiltDeg: l.tiltDeg, latDeg: turnBackLatDeg(l.tiltDeg), heightKm, color: l.color, label: `${Math.round(l.tiltDeg)}\u00b0 \u00b7 ${Math.round(heightKm)} km`, norads: l.norads };
    }),
    other, yearOf,
  };
  _cache.set(cat.rows, { isStarlink, out });
  return out;
}

/**
 * The satellites launched in `year` or earlier that still fly (the catalogue holds only flying ones). A satellite with no known launch year is kept
 * only at the last year (it cannot be placed earlier).
 * @param {number[]} norads @param {Map<number, number>} yearOf @param {number} year @returns {number[]}
 */
export function launchedBy(norads, yearOf, year) {
  return norads.filter((n) => { const y = yearOf.get(n); return Number.isFinite(y) ? y <= year : year >= YEAR_MAX; });
}
