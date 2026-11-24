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
 * Place name boxes beside their rings, greedily in the order given (the order is the priority). A name tries right, left, above, below
 * of its ring; the first spot that stays on screen and clear of the keep-out rectangle, of every box already placed and of every
 * ring already placed (and does not cover its own ring's neighbours' boxes) wins. A name with no spot is skipped; placing stops at
 * `max`. No allocation: the results go into the arrays given.
 * @param {number} n candidates
 * @param {ArrayLike<number>} sx ring centres, CSS px (NaN = not visible, skipped)
 * @param {ArrayLike<number>} sy
 * @param {ArrayLike<number>} wid box widths, CSS px
 * @param {{max:number, boxH?:number, ringPx:number, gap?:number, vw:number, vh:number, keepOut?:({x0:number,y0:number,x1:number,y1:number}|null)}} o
 * @param {Float32Array|number[]} outX box left @param {Float32Array|number[]} outY box top @param {Uint8Array|number[]} outOk 1 = placed
 * @returns {number} how many were placed
 */
export function placeNames(n, sx, sy, wid, o, outX, outY, outOk) {
  const h = o.boxH || NAME_BOX_H, gap = o.gap === undefined ? NAME_GAP : o.gap, r = o.ringPx / 2;
  const ko = o.keepOut || null;
  let placed = 0;
  for (let i = 0; i < n; i++) outOk[i] = 0;
  for (let i = 0; i < n && placed < o.max; i++) {
    const cx = sx[i], cy = sy[i];
    if (!(cx === cx) || !(cy === cy)) continue;
    const w = wid[i];
    // the ring itself must not sit under a box already placed
    let ringFree = true;
    for (let j = 0; j < i && ringFree; j++) {
      if (outOk[j] === 1 && boxesOverlap(cx - r, cy - r, o.ringPx, o.ringPx, outX[j], outY[j], wid[j], h)) ringFree = false;
    }
    if (!ringFree) continue;
    for (let s = 0; s < 4; s++) {
      let bx, by;
      if (s === 0) { bx = cx + r + gap; by = cy - h / 2; }
      else if (s === 1) { bx = cx - r - gap - w; by = cy - h / 2; }
      else if (s === 2) { bx = cx - w / 2; by = cy - r - gap - h; }
      else { bx = cx - w / 2; by = cy + r + gap; }
      bx = Math.round(bx); by = Math.round(by);
      if (bx < 4 || by < 4 || bx + w > o.vw - 4 || by + h > o.vh - 4) continue;
      if (ko && boxesOverlap(bx, by, w, h, ko.x0, ko.y0, ko.x1 - ko.x0, ko.y1 - ko.y0)) continue;
      let free = true;
      for (let j = 0; j < i && free; j++) {
        if (outOk[j] !== 1) continue;
        if (boxesOverlap(bx, by, w, h, outX[j], outY[j], wid[j], h)) free = false;
        else if (boxesOverlap(bx, by, w, h, sx[j] - r, sy[j] - r, o.ringPx, o.ringPx)) free = false;
      }
      if (!free) continue;
      outX[i] = bx; outY[i] = by; outOk[i] = 1; placed++;
      break;
    }
  }
  return placed;
}
