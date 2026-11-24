/**
 * SkyHighlight.js — the pure half of the highlight engine on the floor 4 globe and page 1 (Sky 23, lane H2; DECISIONS §95;
 * `docs/research/2026-11-floor4-hook.md`). No DOM, no scene: RealSkyLayer owns the buffers and the elements and calls these.
 *
 *   mask:   a set of NORAD numbers -> one byte per catalogue row (1 = lit);
 *   fade:   every row that is not lit mixes `fade` (default 0.7) of the way toward Starlink's grey `#3f4a58`, in LINEAR light, the space
 *           the dot colour buffer is in. It is a mix, never a darkening: no channel goes below the lower of the dot's own and the grey's;
 *   names:  at most 8 (mouse) / 6 (touch) name boxes, placed greedily in the order given, never over each other, over a ring, or over the
 *           keep-out rectangle (the side panel).
 *
 * @module ui/SkyHighlight
 */

import * as THREE from 'three';

/** Starlink's grey (the fade's target, DECISIONS §95: "fade B = 70 % toward #3f4a58"). */
export const FADE_GREY = '#3f4a58';
/** How far a faded dot mixes toward the grey. */
export const FADE_DEFAULT = 0.7;
/** Name boxes on screen at most: mouse / touch. */
export const NAMES_MAX = 8;
export const NAMES_MAX_GLASS = 6;
/** A lit set over this many objects rings only the named ones (2,234 rings would be clutter). */
export const RING_CAP = 100;
/** The ring's outer diameter, CSS px: mouse / touch (2 px in the kind's colour, 1 px dark outline). */
export const HL_RING_PX = 16;
export const HL_RING_PX_GLASS = 20;
/** A name box's height, CSS px (the hover label's 12 px text, 3 px padding), and the gap between a ring and its name. */
export const NAME_BOX_H = 22;
export const NAME_GAP = 6;
/** The hover label's width rule (RealSkyLayer `_placeHover`): 14 px of padding and 7.5 px a character, at most 260. */
export const nameWidthPx = (text) => Math.min(260, 14 + String(text).length * 7.5);

const _c = new THREE.Color();

/** A colour string as linear RGB [r, g, b] (what `THREE.Color.setStyle` gives, the buffer's own space). */
export function linearRgb(style) { _c.setStyle(style); return [_c.r, _c.g, _c.b]; }

/** The fade's grey in linear light. */
export function greyLinear() { return linearRgb(FADE_GREY); }

/** Mix of `rgb` toward `grey` by `fade` (0 = unchanged, 1 = the grey), into `out` at offset k. Linear light, so never below min(own, grey) per channel. */
export function fadeInto(out, k, r, g, b, fade, grey) {
  const keep = 1 - fade;
  out[k] = r * keep + grey[0] * fade;
  out[k + 1] = g * keep + grey[1] * fade;
  out[k + 2] = b * keep + grey[2] * fade;
}

/** A kind's canvas colour (sRGB hex string like '#e8923a') faded the same way, for page 1's painter: the mix is done in linear light too. */
export function fadedHex(hex, fade = FADE_DEFAULT) {
  const [r, g, b] = linearRgb(hex), grey = greyLinear(), o = [0, 0, 0];
  fadeInto(o, 0, r, g, b, fade, grey);
  _c.setRGB(o[0], o[1], o[2]);
  return `#${_c.getHexString()}`;
}

/** One byte per row: 1 when the row's NORAD number (column 0) is in the set. @param {Array<Array>} rows @param {Set<number>} norads */
export function maskOf(rows, norads) {
  const m = new Uint8Array(rows.length);
  if (!norads || norads.size === 0) return m;
  for (let i = 0; i < rows.length; i++) if (norads.has(rows[i][0])) m[i] = 1;
  return m;
}

/** The row indexes of a mask, ascending. */
export function litIndexes(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1) n++;
  const out = new Int32Array(n);
  let k = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1) out[k++] = i;
  return out;
}

/**
 * Which group each row belongs to (the first group that lists it), -1 for none.
 * @param {Array<Array>} rows @param {Array<{norads: Iterable<number>}>|undefined} groups @returns {Int16Array|null} null with no groups
 */
export function groupIndexOf(rows, groups) {
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const at = new Map();
  groups.forEach((g, k) => { for (const n of (g && g.norads) || []) if (!at.has(n)) at.set(n, k); });
  const out = new Int16Array(rows.length).fill(-1);
  for (let i = 0; i < rows.length; i++) { const k = at.get(rows[i][0]); if (k !== undefined) out[i] = k; }
  return out;
}

/**
 * One row's colour into `out` (3 floats a row, linear) from `src`: a lit row keeps its colour, any other is faded. A group's `color` replaces the
 * colour of its lit STARLINK rows only (the one exception to "highlight, don't recolour").
 * @param {Float32Array} out @param {Float32Array} src @param {number} i row @param {boolean} lit
 * @param {{fade:number, grey:number[], cls:Uint8Array, starlinkCls:number, groupIdx:(Int16Array|null), groupRgb:(Array<number[]|null>|null)}} o
 */
export function rowColourInto(out, src, i, lit, o) {
  const k = 3 * i;
  if (lit) {
    const gi = o.groupIdx;
    const rgb = gi !== null && o.groupRgb && o.cls[i] === o.starlinkCls && gi[i] >= 0 ? o.groupRgb[gi[i]] : null;
    if (rgb) { out[k] = rgb[0]; out[k + 1] = rgb[1]; out[k + 2] = rgb[2]; }
    else { out[k] = src[k]; out[k + 1] = src[k + 1]; out[k + 2] = src[k + 2]; }
  } else fadeInto(out, k, src[k], src[k + 1], src[k + 2], o.fade, o.grey);
}

/**
 * Fill `out` for every row: lit = mask 1 or the selected row (see `rowColourInto`).
 * @param {Float32Array} out @param {Float32Array} src @param {Uint8Array} mask
 * @param {{fade:number, grey:number[], selected:number, cls:Uint8Array, starlinkCls:number, groupIdx:(Int16Array|null), groupRgb:(Array<number[]|null>|null)}} o
 */
export function fillHighlightColours(out, src, mask, o) {
  const sel = o.selected;
  for (let i = 0; i < mask.length; i++) rowColourInto(out, src, i, mask[i] === 1 || i === sel, o);
}

/** True when two axis-aligned boxes {x, y, w, h} overlap by more than an edge touch. */
function boxesOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

/**
 * Where a name box's top-left sits relative to its ring centre, CSS px, for a side (0 right, 1 left, 2 above, 3 below): the one rule
 * `placeNames` places by and RealSkyLayer's side slide eases between. Writes into `out` (no allocation when one is given).
 * @param {number} side @param {number} w box width @param {number} h box height @param {number} ringPx ring diameter @param {number} gap
 * @param {{x:number, y:number}} [out] @returns {{x:number, y:number}} out
 */
export function sideOffset(side, w, h, ringPx, gap, out = { x: 0, y: 0 }) {
  const r = ringPx / 2;
  if (side === 0) { out.x = r + gap; out.y = -h / 2; }
  else if (side === 1) { out.x = -r - gap - w; out.y = -h / 2; }
  else if (side === 2) { out.x = -w / 2; out.y = -r - gap - h; }
  else { out.x = -w / 2; out.y = r + gap; }
  return out;
}

const _off = { x: 0, y: 0 };
/** The one side a name sits on: the left of its ring (`sideOffset` side 1). */
export const SIDE_LEFT = 1;

/** Scratch for `placeNames`: each placed box's smooth (unsnapped) left / top, which every test uses; grown only when `n` exceeds the length. */
let rawX = new Float64Array(64), rawY = new Float64Array(64);

/**
 * Place name boxes to the LEFT of their rings (owner 2026-11-24, DECISIONS §102 row 6: "stay on left"; vertically centred on the ring),
 * greedily in the order given (the order is the priority). A name whose left box stays on screen and clear of the keep-out rectangles,
 * of every box already placed and of every ring already placed is placed; any other name is skipped (it never moves to another side);
 * placing stops at `max`. No allocation: the results go into the arrays given. `o.snap` (device px per CSS px, default 1) is the grid the results (`outX`, `outY`) are rounded to; every test uses the smooth positions, so
 * a box edge does not step 1 px at a time against a moving ring, and two drawn boxes may touch by under 1 / snap px.
 * `o.keepOut` (the side panel) and `o.keepOut2` (the time buttons) are rectangles {x0, y0, x1, y1} a box never enters.
 * `o.side` (one per candidate), if given, gets SIDE_LEFT (1) for a placed name and -1 otherwise.
 * `o.hold` (one byte per candidate, 1 = shown last frame and appeared under HL_HOLD_MS ago) puts those names first in the cap: they are placed
 * in the order given before the rest, so a young name is not pushed out by a higher-priority one that turned up later, and a held name
 * keeps its place even where it brushes another name or ring (it must still be on screen and out of the keep-outs). Without `o.hold`
 * the result is the plain greedy pass.
 * @param {number} n candidates
 * @param {ArrayLike<number>} sx ring centres, CSS px (NaN = not visible, skipped)
 * @param {ArrayLike<number>} sy
 * @param {ArrayLike<number>} wid box widths, CSS px
 * @param {{max:number, boxH?:number, ringPx:number, gap?:number, vw:number, vh:number, keepOut?:({x0:number,y0:number,x1:number,y1:number}|null), keepOut2?:({x0:number,y0:number,x1:number,y1:number}|null), snap?:number, side?:Int8Array, hold?:Uint8Array}} o
 * @param {Float32Array|number[]} outX box left @param {Float32Array|number[]} outY box top @param {Uint8Array|number[]} outOk 1 = placed
 * @returns {number} how many were placed
 */
export function placeNames(n, sx, sy, wid, o, outX, outY, outOk) {
  const h = o.boxH || NAME_BOX_H, gap = o.gap === undefined ? NAME_GAP : o.gap, r = o.ringPx / 2;
  const ko = o.keepOut || null, ko2 = o.keepOut2 || null, snap = o.snap > 0 ? o.snap : 1, side = o.side || null;
  if (rawX.length < n) { rawX = new Float64Array(n); rawY = new Float64Array(n); }   // grows only when the list is longer than ever before
  const hold = o.hold || null;
  let placed = 0;
  for (let j = 0; j < n; j++) outOk[j] = 0;
  // pass 0 places the held names (when `o.hold` is given), pass 1 the rest; without `o.hold` there is one pass over everything, as always
  for (let pass = hold ? 0 : 1; pass < 2; pass++) {
    for (let i = 0; i < n && placed < o.max; i++) {
      if (hold && (hold[i] === 1) !== (pass === 0)) continue;
      if (side) side[i] = -1;
      const cx = sx[i], cy = sy[i];
      if (!(cx === cx) || !(cy === cy)) continue;
      const w = wid[i];
      // a name shown less than the hold ago keeps its place even where it brushes another name or ring (owner 2026-11-24, §102 row 6)
      const held = hold !== null && hold[i] === 1;
      // the ring itself must not sit under a box already placed (every test below meets every box and ring placed so far, in either pass)
      let ringFree = true;
      for (let j = 0; j < n && ringFree && !held; j++) {
        if (outOk[j] === 1 && boxesOverlap(cx - r, cy - r, o.ringPx, o.ringPx, rawX[j], rawY[j], wid[j], h)) ringFree = false;
      }
      if (!ringFree) continue;
      // the LEFT of the ring only, never another side: no spot there = the name is not shown (it does not jump to the other side)
      sideOffset(SIDE_LEFT, w, h, o.ringPx, gap, _off);
      const bx = cx + _off.x, by = cy + _off.y;
      // every test uses the smooth position; only the output is snapped (a snapped edge steps 1 px and flipped a name on and off)
      if (bx < 4 || by < 4 || bx + w > o.vw - 4 || by + h > o.vh - 4) continue;
      if (ko && boxesOverlap(bx, by, w, h, ko.x0, ko.y0, ko.x1 - ko.x0, ko.y1 - ko.y0)) continue;
      if (ko2 && boxesOverlap(bx, by, w, h, ko2.x0, ko2.y0, ko2.x1 - ko2.x0, ko2.y1 - ko2.y0)) continue;
      let free = true;
      for (let j = 0; j < n && free && !held; j++) {
        if (outOk[j] !== 1) continue;
        if (boxesOverlap(bx, by, w, h, rawX[j], rawY[j], wid[j], h)) free = false;
        else if (boxesOverlap(bx, by, w, h, sx[j] - r, sy[j] - r, o.ringPx, o.ringPx)) free = false;
      }
      if (!free) continue;
      rawX[i] = bx; rawY[i] = by;
      outX[i] = Math.round(bx * snap) / snap; outY[i] = Math.round(by * snap) / snap; outOk[i] = 1; placed++;
      if (side) side[i] = SIDE_LEFT;
    }
  }
  if (side) for (let i = 0; i < n; i++) if (outOk[i] !== 1) side[i] = -1;   // not placed (no spot, or past the cap)
  return placed;
}
