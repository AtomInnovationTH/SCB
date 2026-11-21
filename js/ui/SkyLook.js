/**
 * SkyLook.js — how HEAVY objects stand out on the floor 4 globe (look study lane sky-look-1121, owner 2026-11-20, DECISIONS §80 row 10 /
 * §81 row 1), and a clutter measure. The owner picked variant `b` (§83 row 1, 2026-11-21): it is the game's look on every host
 * (`DEFAULT_LOOK`). The other six variants, and `0` (the old fixed-size dots), stay behind the dev-host switch `?look=<id>` for comparing.
 *
 * Pure: no DOM, no scene. RealSkyLayer builds the Points from `buildLook` and installs the dev hooks through `installSkyLookHooks`.
 *
 * "Heavy" is the owner's set: mass known and over 1,000 kg, not marked working (so every class except working, which holds Starlink), and
 * mean height under 2,000 km (his numbers are for that scope). A heavy object far above it (GEO) draws as today.
 * Unknown mass (9,819 of 28,498 under 2,000 km) always draws as today.
 *
 * @module ui/SkyLook
 */

import * as THREE from 'three';
import { WGS72, GP_HEIGHT_RADIUS_KM } from '../systems/SkyPropagator.js';
import { devSearch, isDevHost } from '../core/DevHost.js';

/** Today's dot diameter, CSS px, mouse / touch: a copy of RealSkyLayer's DOT_PX / DOT_PX_GLASS (importing them would make the two modules import each other; a test pins them equal). */
export const BASE_PX = 2;
export const BASE_PX_GLASS = 3;

/** The variant ids, in the order the sheet shows them. */
export const LOOK_IDS = ['0', 'a', 'b', 'c', 'd', 'e', 'f'];
/** The look the game draws with no switch, on every host: the owner's pick (DECISIONS §83 row 1, 2026-11-21, "b: two sizes"). */
export const DEFAULT_LOOK = 'b';
/** One plain line per variant (the sheet prints these). */
export const LOOK_TEXT = {
  '0': 'Today: every dot the same small size, coloured by kind.',
  a: 'One step: objects over 1,000 kg (not working) at twice the size.',
  b: 'Two steps: 1,000-1,500 kg at 1.5 times, over 1,500 kg (she cannot catch these, only inspect) at 2.5 times.',
  c: 'Size by mass: the dot grows with the cube root of the mass (2 to 8 px), for every object whose mass is known. A design choice, not the true size.',
  d: 'Rings: today\u2019s dots, with a thin ring around each heavy object, a second ring tint over 1,500 kg.',
  e: 'Quiet background: every other dot at 60 % brightness, heavy objects at full brightness and twice the size.',
  f: 'Preview of an owed option, "colour by height" (cool low, warm high), today\u2019s sizes. It clashes with today\u2019s rule warm = she can remove it, cool = working.',
};

/** Heavy: over this mass, kg (the owner's "larger than 1000 kg"). */
export const HEAVY_KG = 1000;
/** Her catch limit, kg (DECISIONS §49 row 1): over it she can only find and inspect. */
export const CATCH_KG = 1500;
/** Class number of "working" (skyPack.CLS; Starlink is a working row, so it is not heavy either). */
export const CLS_WORKING = 3;
/** Row indexes (data/sky.json fields). */
const F_CLS = 2, F_MASS = 6, F_N = 9;

/** Variant sizes as multiples of the base dot (DOT_PX mouse / DOT_PX_GLASS touch). */
export const A_FACTOR = 2;
export const B_FACTOR_LOW = 1.5;
export const B_FACTOR_HIGH = 2.5;
export const E_FACTOR = 2;
/** Variant e: every other dot's brightness. */
export const E_DIM = 0.6;
/** Variant c: diameter = cbrt(massKg) * C_K, clamped (CSS px, rounded to whole px: one Points per px step). Mouse / touch.
 *  Mouse: 1,000 kg is 6 px, about 2,370 kg reaches the 8 px cap; unknown mass keeps the base size. */
export const C_K = 0.6;
export const C_K_GLASS = 0.75;
export const C_MIN = 2;
export const C_MAX = 8;
export const C_MIN_GLASS = 3;
export const C_MAX_GLASS = 10;
/** Variant d: ring outer diameter, CSS px (mouse / touch) and tints (heavy up to her limit / over it). */
export const RING_D = 9;
export const RING_D_GLASS = 12;
export const RING_TINT = ['#bcd0e6', '#ffe08a'];
/** Variant f: height ramp, km above Earth -> colour (below the first stop and above the last stay at that stop). */
export const HEIGHT_RAMP = [[300, '#4a90d9'], [800, '#7fb8a0'], [2000, '#e8923a']];

/** Heavy only inside the owner's scope: mean height under this, km (his numbers are for objects "under 2,000 km", her world; F1 of fix round 1). */
export const HEAVY_MAX_KM = 2000;

/** Mean height above Earth of a row (km), from its mean motion (rev/day, a Kozai value: good to a few km). NaN when the motion is missing. */
export function meanHeightKm(row) {
  const n = row[F_N] * 2 * Math.PI / 86400;
  return Math.cbrt(WGS72.MU / (n * n)) - GP_HEIGHT_RADIUS_KM;
}

/**
 * True when the object's mass is known and over 1,000 kg, the row is not a working satellite (so not Starlink), and its mean height is under
 * 2,000 km (a GEO or other high object is not heavy here: the sheet's counts are for her world). @param {Array} row data/sky.json row
 */
export function isHeavyRow(row) {
  const m = row[F_MASS];
  return m != null && m > HEAVY_KG && row[F_CLS] !== CLS_WORKING && meanHeightKm(row) < HEAVY_MAX_KM;
}

/**
 * The counts the sheet quotes, over a data/sky.json row list. "Scope" = mean height under 2,000 km, the owner's own scope.
 * @param {Array<Array>} rows
 */
export function heavyCounts(rows) {
  const o = { total: rows.length, scope: 0, massUnknown: 0, over1000: 0, over1000NotWorking: 0, over1000NotWorking400to900: 0,
    warmOnly: 0, warmOnly400to900: 0, over1500: 0, over1500NotWorking: 0, over1500NotWorking400to900: 0, heavyByClass: {} };
  for (const r of rows) {
    const h = meanHeightKm(r);
    if (!(h < 2000)) continue;
    o.scope++;
    const m = r[F_MASS];
    if (m == null) { o.massUnknown++; continue; }
    const band = h >= 400 && h <= 900;
    if (m > HEAVY_KG) {
      o.over1000++;
      if (r[F_CLS] !== CLS_WORKING) {
        o.over1000NotWorking++; if (band) o.over1000NotWorking400to900++;
        o.heavyByClass[r[F_CLS]] = (o.heavyByClass[r[F_CLS]] || 0) + 1;
        if (r[F_CLS] <= 2) { o.warmOnly++; if (band) o.warmOnly400to900++; }
      }
    }
    if (m > CATCH_KG) {
      o.over1500++;
      if (r[F_CLS] !== CLS_WORKING) { o.over1500NotWorking++; if (band) o.over1500NotWorking400to900++; }
    }
  }
  return o;
}

/** The base dot diameter, CSS px. */
export const basePx = (glass) => (glass ? BASE_PX_GLASS : BASE_PX);
/** The ring's outer diameter, CSS px. */
export const ringPx = (glass) => (glass ? RING_D_GLASS : RING_D);

/**
 * One row's dot under one variant.
 * @param {string} id variant id
 * @param {Array} row
 * @param {boolean} glass touch
 * @returns {{px:number, ring:number, dim:number}} diameter in CSS px; ring 0 none, 1 heavy, 2 over her catch limit; brightness factor
 */
export function dotSpec(id, row, glass) {
  const base = basePx(glass);
  const m = row[F_MASS];
  const heavy = isHeavyRow(row);
  let px = base, ring = 0, dim = 1;
  switch (id) {
    case 'a': if (heavy) px = base * A_FACTOR; break;
    case 'b': if (heavy) px = base * (m > CATCH_KG ? B_FACTOR_HIGH : B_FACTOR_LOW); break;
    case 'c':
      if (m != null) {
        const lo = glass ? C_MIN_GLASS : C_MIN, hi = glass ? C_MAX_GLASS : C_MAX;
        px = Math.min(hi, Math.max(lo, Math.round(Math.cbrt(Math.max(0, m)) * (glass ? C_K_GLASS : C_K))));
      }
      break;
    case 'd': if (heavy) ring = m > CATCH_KG ? 2 : 1; break;
    case 'e': if (heavy) px = base * E_FACTOR; else dim = E_DIM; break;
    default: break;
  }
  return { px, ring, dim };
}

const _c = new THREE.Color();
/** The height ramp as linear RGB triples (the same conversion the palette gets). */
function rampRgb() { return HEIGHT_RAMP.map(([km, hex]) => { _c.setStyle(hex); return [km, _c.r, _c.g, _c.b]; }); }
function rampAt(stops, km, out, k) {
  let a = stops[0], b = stops[stops.length - 1];
  if (km <= a[0]) b = a;
  else if (km >= b[0]) a = b;
  else for (let i = 0; i < stops.length - 1; i++) if (km >= stops[i][0] && km <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  const t = a === b ? 0 : (km - a[0]) / (b[0] - a[0]);
  out[k] = a[1] + (b[1] - a[1]) * t; out[k + 1] = a[2] + (b[2] - a[2]) * t; out[k + 2] = a[3] + (b[3] - a[3]) * t;
}

/**
 * Every row's dot under one variant, as flat arrays (built once per switch; about 32k rows).
 * @param {string} id @param {Array<Array>} rows @param {boolean} glass
 * @param {Float32Array} baseCol the layer's colour per row (3 per row, today's palette); never changed
 * @returns {{id:string, px:Float32Array, ring:Uint8Array, heavy:Uint8Array, col:Float32Array, ringCol:(Float32Array|null), ringPx:number}}
 */
export function buildLook(id, rows, glass, baseCol) {
  const N = rows.length;
  const px = new Float32Array(N), ring = new Uint8Array(N), heavy = new Uint8Array(N);
  const col = id === 'e' || id === 'f' ? new Float32Array(3 * N) : baseCol;
  const stops = id === 'f' ? rampRgb() : null;
  let ringCol = null;
  if (id === 'd') {
    ringCol = new Float32Array(3 * N);
  }
  const tints = RING_TINT.map((hex) => { _c.setStyle(hex); return [_c.r, _c.g, _c.b]; });
  for (let i = 0; i < N; i++) {
    const row = rows[i];
    const s = dotSpec(id, row, glass);
    px[i] = s.px; ring[i] = s.ring; heavy[i] = isHeavyRow(row) ? 1 : 0;
    if (id === 'e') { col[3 * i] = baseCol[3 * i] * s.dim; col[3 * i + 1] = baseCol[3 * i + 1] * s.dim; col[3 * i + 2] = baseCol[3 * i + 2] * s.dim; }
    else if (id === 'f') rampAt(stops, meanHeightKm(row), col, 3 * i);
    if (ringCol && s.ring) { const t = tints[s.ring - 1]; ringCol[3 * i] = t[0]; ringCol[3 * i + 1] = t[1]; ringCol[3 * i + 2] = t[2]; }
  }
  return { id, px, ring, heavy, col, ringCol, ringPx: ringPx(glass) };
}

/** A soft round ring, 32 x 32 RGBA bytes (white, alpha on an annulus between 70 % and 100 % of the radius), for the ring Points' texture. */
export function ringTextureBytes(size = 32) {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2, R = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - c, y - c) / R;
    const inner = Math.min(1, Math.max(0, (d - 0.62) / 0.08));       // fades in from 62 % to 70 %
    const outer = Math.min(1, Math.max(0, (0.97 - d) / 0.07));       // fades out from 90 % to 97 %
    const a = inner * outer;
    const k = 4 * (y * size + x);
    data[k] = 255; data[k + 1] = 255; data[k + 2] = 255; data[k + 3] = Math.round(a * 255);
  }
  return data;
}

/**
 * A round dot, size x size RGBA bytes (white; alpha 1 inside, falling to 0 over a 1 px soft edge at the rim) for a look Points larger than
 * today's (a plain `Points` draws a square). The alpha is half one half-pixel inside the texture's edge, so the dot keeps its nominal diameter.
 * @param {number} size texture side, px @param {number} px the dot's diameter on screen, CSS px (sets how wide the 1 px edge is in texture units)
 */
export function dotTextureBytes(size = 32, px = 4) {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2, R = size / 2;
  const half = Math.min(0.5, 1 / Math.max(1, px));      // half the edge width as a fraction of the radius: the edge is 1 px wide on screen
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - c, y - c) / R;
    const a = Math.min(1, Math.max(0, (0.97 - half - d) / (2 * half) + 0.5));   // 1 inside, 0.5 at 0.97 - half, 0 at 0.97: the outermost texels are clear
    const k = 4 * (y * size + x);
    data[k] = 255; data[k + 1] = 255; data[k + 2] = 255; data[k + 3] = Math.round(a * 255);
  }
  return data;
}

/**
 * The clutter measure for a list of dots as seen now.
 * @param {Array<{x:number, y:number, r:number, heavy?:boolean, ringR?:number}>} points CSS px, IN DRAW ORDER (a later dot is drawn above an earlier
 *   one); r = the dot's radius; ringR = the outer radius of a ring around it (1 px wide), counted in the screen cover but never as a dot: a ring is
 *   drawn under the dots and hides nothing
 * @param {number} w @param {number} h the screen, CSS px
 * @returns {{dots:number, coverPct:number, overlapPct:number, heavy:number, heavyHiddenPct:number, heavyOverlappedPct:number}} dots whose centre is on
 *   screen; percent of the screen the dots (and rings) cover; percent of dots that touch another dot (their discs intersect); heavy dots on screen;
 *   percent of those HIDDEN (a dot drawn above covers the heavy dot's centre: the number the study judges by); percent of those merely TOUCHED by any
 *   other dot (a heavy dot is drawn on top, so touching is not hiding: it favours small dots, kept as a second column)
 */
export function measureClutter(points, w, h) {
  const on = [];
  for (const p of points) if (p.x >= 0 && p.x < w && p.y >= 0 && p.y < h) on.push(p);
  const n = on.length;
  let heavy = 0;
  for (const p of on) if (p.heavy) heavy++;
  // overlap: a spatial hash with cells as wide as the biggest dot's diameter
  let maxR = 0.5;
  for (const p of on) if (p.r > maxR) maxR = p.r;
  const cell = 2 * maxR;
  const grid = new Map();
  const key = (cx, cy) => cx * 100003 + cy;
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(on[i].x / cell), Math.floor(on[i].y / cell));
    const a = grid.get(k);
    if (a) a.push(i); else grid.set(k, [i]);
  }
  const hit = new Uint8Array(n), hidden = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = on[i], cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const a = grid.get(key(gx, gy));
      if (!a) continue;
      for (const j of a) {
        if (j === i) continue;                              // a dot never overlaps (or hides) itself
        const q = on[j], dx = p.x - q.x, dy = p.y - q.y, rr = p.r + q.r;
        const d2 = dx * dx + dy * dy;
        if (d2 < rr * rr) hit[i] = 1;
        if (j > i && d2 < q.r * q.r) hidden[i] = 1;        // a dot drawn later (above) covers this dot's centre
      }
    }
  }
  let overlapped = 0, heavyOverlapped = 0, heavyHidden = 0;
  for (let i = 0; i < n; i++) {
    if (hit[i]) { overlapped++; if (on[i].heavy) heavyOverlapped++; }
    if (hidden[i] && on[i].heavy) heavyHidden++;
  }
  // cover: paint every disc (and ring) on a half-pixel grid, count the cells
  const S = 2, gw = Math.ceil(w * S), gh = Math.ceil(h * S);
  const cells = new Uint8Array(gw * gh);
  const paint = (x, y, rOut, rIn) => {
    const x0 = Math.max(0, Math.floor((x - rOut) * S)), x1 = Math.min(gw - 1, Math.ceil((x + rOut) * S));
    const y0 = Math.max(0, Math.floor((y - rOut) * S)), y1 = Math.min(gh - 1, Math.ceil((y + rOut) * S));
    const o2 = rOut * rOut, i2 = rIn * rIn;
    for (let gy = y0; gy <= y1; gy++) {
      const dy = (gy + 0.5) / S - y;
      for (let gx = x0; gx <= x1; gx++) {
        const dx = (gx + 0.5) / S - x;
        const d2 = dx * dx + dy * dy;
        if (d2 <= o2 && d2 >= i2) cells[gy * gw + gx] = 1;
      }
    }
  };
  for (const p of on) {
    paint(p.x, p.y, p.r, 0);
    if (p.ringR > 0) paint(p.x, p.y, p.ringR, Math.max(0, p.ringR - 1));
  }
  let covered = 0;
  for (let i = 0; i < cells.length; i++) covered += cells[i];
  const pct = (a, b) => (b > 0 ? (100 * a) / b : 0);
  return { dots: n, coverPct: pct(covered, gw * gh), overlapPct: pct(overlapped, n), heavy, heavyHiddenPct: pct(heavyHidden, heavy), heavyOverlappedPct: pct(heavyOverlapped, heavy) };
}

/** `?look=<id>` from a location, on a dev host only (`?look=0` = the old fixed-size dots); DEFAULT_LOOK for no switch, an unknown id, or a public host. */
export function lookFromSearch(loc = globalThis.location) {
  const raw = new URLSearchParams(devSearch(loc)).get('look');
  return raw !== null && LOOK_IDS.includes(raw) ? raw : DEFAULT_LOOK;
}

/**
 * Install `window.__skyLook(id)` and `window.__skyLookStats()` on a dev host only.
 * @param {{setLook:function, lookStats:function}} layer
 * @param {{protocol?:string, hostname?:string}|null|undefined} loc
 * @param {object} win the object that receives the hooks (`window`)
 * @returns {boolean} true when installed
 */
export function installSkyLookHooks(layer, loc, win) {
  // `loc` lets a test pass a stand-in location; the bare `isDevHost()` is the page's own location, the form the hook scan in
  // test-DevHost.js recognises. In the browser both are the same location.
  if (win && isDevHost(loc) && isDevHost()) {
    win.__skyLook = (id) => layer.setLook(id);
    win.__skyLookStats = () => layer.lookStats();
    return true;
  }
  return false;
}
