/**
 * Pure left-arm chain layout. The left HUD arm is Mother → Daughters in `#hud-left-column`, then overlay riders
 * Cargo → Orbit → Autopilot → Pin stacked under the column down to the footer band. This is the ONE allocator:
 * given a ceiling (column bottom, 1 Hz cached as `_leftColumnBottom` in main.js) and a floor (footer band top minus
 * the stack gap), it places riders greedily top-down and the bottom rider yields first
 * (natural → compact → trimmed → layout-hidden). Vertical order is priority order: Pin sheds first, then
 * Autopilot, Orbit, then Cargo trims.
 *
 * Density-hidden riders (`hidden()` true) take no room, are not placed, and `apply` is not called. The stack never
 * writes `data-density-hidden`; a layout-hidden rider collapses via its own `apply` (e.g. `data-stack-hidden`).
 *
 * Big screen: every rider is drawn HUD_SCALE (1.25) x bigger from its top-left corner (CSS `scale`), so the stack
 * works in SCREEN px: each rider's natural / compact / min height is multiplied by the scale before packing, and
 * `apply` gets the rider's LAYOUT height (screen px / scale) so a trimmed rider's max-height lands on the screen
 * height placed here. Ceiling and floor are screen px already.
 *
 * Pure / Node-testable: no DOM, no timers.
 *
 * @module ui/hud/LeftStack
 */

import { currentHudScale } from '../HudScale.js';

/**
 * @typedef {Object} LeftStackRider
 * @property {string} id
 * @property {() => boolean} hidden        // density-hidden / not present → takes NO room, not placed, apply() NOT called
 * @property {() => number} naturalPx      // preferred height
 * @property {() => (number|null)} [compactPx] // fixed alternate presentation height (Autopilot single line, Orbit one row) or null
 * @property {() => (number|null)} [minPx]     // smallest useful TRIMMED height for list-like panes (Cargo rows); null = cannot trim
 * @property {(top:number, height:number, mode:'natural'|'compact'|'trimmed'|'hidden') => void} [apply]
 */

/**
 * @typedef {Object} LeftStackPlacement
 * @property {string} id
 * @property {number} top
 * @property {number} height
 * @property {'natural'|'compact'|'trimmed'|'hidden'} mode
 */

/** Gap between placed riders (px). */
export const LEFT_STACK_GAP_PX = 8;

/** @returns {number|null} a finite px value (times k), else null */
function callPx(fn, k = 1) {
  if (typeof fn !== 'function') return null;
  try {
    const v = fn();
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n * k : null;
  } catch (_e) {
    return null;
  }
}

function isDensityHidden(rider) {
  if (!rider || typeof rider.hidden !== 'function') return true;
  try { return !!rider.hidden(); } catch (_e) { return true; }
}

function applyRider(rider, rec, k = 1) {
  if (!rider || typeof rider.apply !== 'function') return;
  try { rider.apply(rec.top, k === 1 ? rec.height : rec.height / k, rec.mode); } catch (_e) { /* never throw */ }
}

/** Packed height of non-hidden items (heights + gaps between them). */
function packedHeight(items, gap) {
  let sum = 0;
  let n = 0;
  for (const it of items) {
    if (it.mode === 'hidden') continue;
    if (n) sum += gap;
    sum += it.height;
    n++;
  }
  return sum;
}

/** Leftover px for `items[i]` if every rider above keeps its mode and this one may take the rest of the span. */
function leftoverFor(items, i, span, gap) {
  let aboveH = 0;
  let aboveN = 0;
  for (let j = 0; j < i; j++) {
    if (items[j].mode === 'hidden') continue;
    if (aboveN) aboveH += gap;
    aboveH += items[j].height;
    aboveN++;
  }
  return span - aboveH - (aboveN ? gap : 0);
}

/** One step down the ladder for `item`, first mode that fits in `avail`: compact → trimmed → hidden. */
function shed(item, avail, k = 1) {
  if (item.mode === 'natural') {
    const c = callPx(item.rider.compactPx, k);
    if (c != null && c >= 0 && c <= avail) {
      item.mode = 'compact';
      item.height = c;
      return;
    }
  }
  if (item.mode === 'natural' || item.mode === 'compact') {
    const m = callPx(item.rider.minPx, k);
    if (m != null && m >= 0 && m <= avail) {
      item.mode = 'trimmed';
      item.height = avail;
      return;
    }
    item.mode = 'hidden';
    item.height = 0;
    return;
  }
  item.mode = 'hidden';
  item.height = 0;
}

function plan(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const k = (Number.isFinite(a.scale) && a.scale > 0) ? a.scale : currentHudScale();
  const riders = Array.isArray(a.riders) ? a.riders : [];
  const gap = Number.isFinite(a.gapPx) ? a.gapPx : LEFT_STACK_GAP_PX;
  const ceiling = Number(a.ceilingPx);
  const floor = Number(a.floorPx);
  const visible = [];
  for (const r of riders) {
    if (isDensityHidden(r)) continue;
    visible.push(r);
  }
  const degenerate = !Number.isFinite(ceiling) || !Number.isFinite(floor) || floor <= ceiling;
  const span = degenerate ? 0 : floor - ceiling;
  const items = visible.map((rider) => {
    const nat = callPx(rider.naturalPx, k);
    if (nat != null && nat >= 0) return { rider, id: rider.id, mode: 'natural', height: nat };
    const c = callPx(rider.compactPx, k);
    if (c != null && c >= 0) return { rider, id: rider.id, mode: 'compact', height: c };
    return { rider, id: rider.id, mode: 'hidden', height: 0 };
  });
  if (degenerate) {
    for (const it of items) { it.mode = 'hidden'; it.height = 0; }
    return { ok: false, ceiling: Number.isFinite(ceiling) ? ceiling : 0, span: 0, gap, items, k };
  }
  // Bottom rider yields first: shed from the tail until the stack fits in `span`.
  let guard = items.length * 4 + 2;
  while (packedHeight(items, gap) > span && guard-- > 0) {
    let i = items.length - 1;
    while (i >= 0 && items[i].mode === 'hidden') i--;
    if (i < 0) break;
    shed(items[i], leftoverFor(items, i, span, gap), k);
  }
  return { ok: true, ceiling, span, gap, items, k };
}

/**
 * Place the left-arm overlay riders between `ceilingPx` and `floorPx`.
 * @param {Object} args
 * @param {number} args.ceilingPx   top of the chain (Daughters / column bottom)
 * @param {number} args.floorPx     exclusive bottom (footer band top − gap)
 * @param {number} [args.gapPx=8]
 * @param {LeftStackRider[]} args.riders  vertical order top→bottom
 * @param {number} [args.scale]  the HUD scale the riders are drawn at (default: the installed one, 1 off a big screen)
 * @returns {LeftStackPlacement[]}
 */
export function layout(args) {
  const { ceiling, gap, items, k } = plan(args);
  const out = [];
  let y = ceiling;
  for (const it of items) {
    const top = Math.round(y);
    const hidden = it.mode === 'hidden';
    const height = hidden ? 0 : Math.round(it.height);
    const rec = { id: it.id, top, height, mode: it.mode };
    applyRider(it.rider, rec, k);
    out.push(rec);
    if (!hidden) y = top + height + gap;
  }
  return out;
}

/** True when every non-density-hidden rider fits at natural height. Does not call `apply`. */
export function fitsAll(args) {
  const { items } = plan(args);
  for (const it of items) {
    if (it.mode !== 'natural') return false;
  }
  return true;
}

export default { layout, fitsAll };
