/**
 * LeftStack.js — pure left-arm chain layout (plan Task 8, hud-pane-ladder-reorder).
 *
 * The left HUD arm is Mother → Daughters in `#hud-left-column`, then overlay
 * riders Cargo → Orbit → Autopilot → Pin stacked under the column down to the
 * footer band. This module is the ONE allocator: given a ceiling (the column
 * bottom, 1 Hz cached as `_leftColumnBottom` in main.js) and a floor (footer
 * band top minus the stack gap), it places riders greedily top-down and lets
 * the bottom rider yield first (natural → compact → trimmed → layout-hidden).
 * Vertical order is priority order: Pin sheds first, then Autopilot, then
 * Orbit, then Cargo trims.
 *
 * Density-hidden riders (`hidden()` true) take no room, are not placed, and
 * `apply` is not called. The stack never writes `data-density-hidden`; a
 * layout-hidden rider collapses via its own `apply` (e.g. `data-stack-hidden`).
 *
 * Pure / Node-testable: no DOM, no timers. Wiring lives in a later wave.
 *
 * @module ui/hud/LeftStack
 */

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

/** Gap between placed riders (px). Plan locked decision #8 / layout target. */
export const LEFT_STACK_GAP_PX = 8;

/**
 * @param {any} fn
 * @returns {number|null} a finite px value, else null
 */
function callPx(fn) {
  if (typeof fn !== 'function') return null;
  try {
    const v = fn();
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch (_e) {
    return null;
  }
}

/**
 * @param {any} rider
 * @returns {boolean}
 */
function isDensityHidden(rider) {
  if (!rider || typeof rider.hidden !== 'function') return true;
  try { return !!rider.hidden(); } catch (_e) { return true; }
}

/**
 * @param {any} rider
 * @param {LeftStackPlacement} rec
 */
function applyRider(rider, rec) {
  if (!rider || typeof rider.apply !== 'function') return;
  try { rider.apply(rec.top, rec.height, rec.mode); } catch (_e) { /* never throw */ }
}

/**
 * Packed height of non-hidden items (heights + gaps between them).
 * @param {{mode:string, height:number}[]} items
 * @param {number} gap
 * @returns {number}
 */
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

/**
 * Leftover px for `items[i]` if every rider above keeps its current mode
 * and this rider may consume the rest of the span.
 * @param {{mode:string, height:number}[]} items
 * @param {number} i
 * @param {number} span
 * @param {number} gap
 * @returns {number}
 */
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

/**
 * One step down the presentation ladder for `item`, picking the first
 * mode that fits in `avail`: compact → trimmed → hidden.
 * @param {{rider:LeftStackRider, mode:string, height:number}} item
 * @param {number} avail
 */
function shed(item, avail) {
  if (item.mode === 'natural') {
    const c = callPx(item.rider.compactPx);
    if (c != null && c >= 0 && c <= avail) {
      item.mode = 'compact';
      item.height = c;
      return;
    }
  }
  if (item.mode === 'natural' || item.mode === 'compact') {
    const m = callPx(item.rider.minPx);
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

/**
 * @param {any} args
 * @returns {{ok:boolean, ceiling:number, span:number, gap:number, items:object[]}}
 */
function plan(args) {
  const a = (args && typeof args === 'object') ? args : {};
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
    const nat = callPx(rider.naturalPx);
    if (nat != null && nat >= 0) return { rider, id: rider.id, mode: 'natural', height: nat };
    const c = callPx(rider.compactPx);
    if (c != null && c >= 0) return { rider, id: rider.id, mode: 'compact', height: c };
    return { rider, id: rider.id, mode: 'hidden', height: 0 };
  });
  if (degenerate) {
    for (const it of items) { it.mode = 'hidden'; it.height = 0; }
    return { ok: false, ceiling: Number.isFinite(ceiling) ? ceiling : 0, span: 0, gap, items };
  }
  // Bottom rider yields first (locked decision #5): shed from the tail until
  // the remaining stack fits in `span`. Placement itself is greedy top-down.
  let guard = items.length * 4 + 2;
  while (packedHeight(items, gap) > span && guard-- > 0) {
    let i = items.length - 1;
    while (i >= 0 && items[i].mode === 'hidden') i--;
    if (i < 0) break;
    shed(items[i], leftoverFor(items, i, span, gap));
  }
  return { ok: true, ceiling, span, gap, items };
}

/**
 * Place the left-arm overlay riders between `ceilingPx` and `floorPx`.
 *
 * @param {Object} args
 * @param {number} args.ceilingPx   top of the chain (Daughters / column bottom)
 * @param {number} args.floorPx     exclusive bottom (footer band top − gap)
 * @param {number} [args.gapPx=8]
 * @param {LeftStackRider[]} args.riders  vertical order top→bottom
 * @returns {LeftStackPlacement[]}
 */
export function layout(args) {
  const { ceiling, gap, items } = plan(args);
  const out = [];
  let y = ceiling;
  for (const it of items) {
    const top = Math.round(y);
    const hidden = it.mode === 'hidden';
    const height = hidden ? 0 : Math.round(it.height);
    const rec = { id: it.id, top, height, mode: it.mode };
    applyRider(it.rider, rec);
    out.push(rec);
    if (!hidden) y = top + height + gap;
  }
  return out;
}

/**
 * Cheap witness: every non-density-hidden rider is placed at natural height.
 * Does not call `apply`.
 *
 * @param {Object} args  same shape as layout()
 * @returns {boolean}
 */
export function fitsAll(args) {
  const { items } = plan(args);
  for (const it of items) {
    if (it.mode !== 'natural') return false;
  }
  return true;
}

export default { layout, fitsAll };
