/**
 * Pure rail-stacking order helper for the inspection callouts (@module scene/railOrder).
 * Operates on `{ _anchorY: number, _railOrder: number|null }` records (the real
 * MotherCallouts recs fit).
 *
 *   - `_railOrder` is a persistent ordinal slot (0 = top); `null` = new, needs a slot.
 *   - If ANY rec has a null ordinal, the whole rail is renumbered from a descending
 *     anchor-Y sort. The only place ordinals are assigned, so they stay unique.
 *   - Otherwise sort by stored ordinal, then swap adjacent pairs whose anchor-Y order
 *     inverted by more than `hysteresis`. The swap exchanges ordinals too, so it
 *     persists across frames (stops flicker).
 *
 * `list` is sorted in place (top -> bottom) and returned.
 */

/**
 * @param {Array<{_anchorY:number,_railOrder:(number|null)}>} list
 * @param {number} [hysteresis=0.04]  anchor-Y inversion threshold before a swap
 */
export function orderRail(list, hysteresis = 0.04) {
  if (!Array.isArray(list) || list.length === 0) return list;

  if (list.some((r) => r._railOrder == null)) {
    list.sort((a, b) => b._anchorY - a._anchorY);
    for (let i = 0; i < list.length; i++) list[i]._railOrder = i;
    return list;
  }

  // Passes capped so a frame with several inversions settles in one call.
  list.sort((a, b) => a._railOrder - b._railOrder);
  for (let pass = 0; pass < 3; pass++) {
    let swapped = false;
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      // a should sit above b (higher anchorY); swap ordinals AND positions so it persists.
      if (b._anchorY > a._anchorY + hysteresis) {
        const tmp = a._railOrder;
        a._railOrder = b._railOrder;
        b._railOrder = tmp;
        list[i] = b;
        list[i + 1] = a;
        swapped = true;
      }
    }
    if (!swapped) break;
  }
  return list;
}
