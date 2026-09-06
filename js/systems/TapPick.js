/**
 * TapPick.js — the ONE screen-space hit-test behind the Session J tap grammar
 * (plan D-I: "tap debris = select via the ONE selection event HUD_TARGET_CLICK
 * {id}; tap empty = scan; a tap on an insertion candidate selects it").
 *
 * Pure: a list of projected points `{ x, y, visible? }` (CSS px — the space
 * touch `clientX/Y` and main.js's `navcomProject` share), a tap point and a
 * radius → the NEAREST visible point inside the radius, or null. The hub
 * decides what the points are (the TPI-sorted target list Tab/T cycles, the
 * PROX NET insertion candidates) and what the hit means; this module never
 * touches THREE, the DOM or the EventBus. `TAP_RADIUS_PX` 44 is the iPad
 * touch-target minimum (Apple HIG 44 pt; plan item 2 "within 44 pt").
 *
 * @module systems/TapPick
 */

/** The tap hit radius (CSS px): the 44 pt touch-target minimum. */
export const TAP_RADIUS_PX = 44;

/**
 * The click/tap SLOP law (Session J.5 review fix — ONE copy): a press that
 * moved more than TAP_SLOP_PX or lasted longer than TAP_SLOP_MS is a drag /
 * long-press, never a click. Shared by MotherCallouts' hull-part click
 * (euclidean move) and main.js's desktop click-to-select (per-axis move) —
 * the geometry differs by surface, the thresholds are the law.
 */
export const TAP_SLOP_PX = 5;
export const TAP_SLOP_MS = 400;

/**
 * Nearest visible point within `radiusPx` of (x, y).
 * @param {Iterable<{x:number,y:number,visible?:boolean}>|null|undefined} points
 * @param {number} x
 * @param {number} y
 * @param {number} [radiusPx=TAP_RADIUS_PX]
 * @returns {{ index: number, point: object, distPx: number }|null}
 */
export function nearestWithin(points, x, y, radiusPx = TAP_RADIUS_PX) {
  if (!points || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const r = Number.isFinite(radiusPx) && radiusPx > 0 ? radiusPx : TAP_RADIUS_PX;
  let best = null;
  let i = 0;
  for (const p of points) {
    const idx = i++;
    if (!p || p.visible === false || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= r && (best === null || d < best.distPx)) best = { index: idx, point: p, distPx: d };
  }
  return best;
}

export const TapPick = Object.freeze({ TAP_RADIUS_PX, TAP_SLOP_PX, TAP_SLOP_MS, nearestWithin });
export default TapPick;
