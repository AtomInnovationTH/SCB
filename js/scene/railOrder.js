/**
 * railOrder.js — Pure rail-stacking order helper for the inspection callouts.
 *
 * Extracted from ui/MotherCallouts so the ordinal + hysteresis logic is
 * unit-testable without a THREE scene. Operates on lightweight records shaped
 * like `{ _anchorY: number, _railOrder: number|null }` — the same fields the
 * real recs carry, so MotherCallouts can pass its recs straight in.
 *
 * Contract (see round-2 plan §R2):
 *   - `_railOrder` is a persistent ordinal slot (0 = top). Lower ordinal = higher
 *     on the rail. `null` means "new / re-entering, needs a slot".
 *   - If ANY rec in the list has a null ordinal, the whole rail is renumbered
 *     once from a descending anchor-Y sort (0 = highest anchor). This is the only
 *     place ordinals are (re)assigned, which guarantees they are unique.
 *   - Otherwise the list is sorted by its stored ordinal, then adjacent pairs
 *     whose anchor-Y order has inverted by more than `hysteresis` are swapped.
 *     The swap exchanges the (distinct) ordinals too, so it persists across
 *     frames — which is what stops the flicker the hysteresis exists to prevent.
 *
 * The input `list` is sorted in place (top → bottom) and also returned.
 *
 * @module scene/railOrder
 */

/**
 * Order a rail's recs top → bottom with stack-order hysteresis.
 * @param {Array<{_anchorY:number,_railOrder:(number|null)}>} list
 * @param {number} [hysteresis=0.04]  anchor-Y inversion threshold before a swap
 * @returns {Array} the same list, sorted top → bottom
 */
export function orderRail(list, hysteresis = 0.04) {
  if (!Array.isArray(list) || list.length === 0) return list;

  // (Re)assign unique ordinals from anchor Y whenever any member lacks one.
  if (list.some((r) => r._railOrder == null)) {
    list.sort((a, b) => b._anchorY - a._anchorY);
    for (let i = 0; i < list.length; i++) list[i]._railOrder = i;
    return list;
  }

  // Steady state: sort by stored ordinal, then swap adjacent pairs whose
  // anchor-Y order inverted past the hysteresis threshold. Repeat (capped) so a
  // frame with several inversions settles in one call instead of drifting.
  list.sort((a, b) => a._railOrder - b._railOrder);
  for (let pass = 0; pass < 3; pass++) {
    let swapped = false;
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      // a should sit above b (higher anchorY). If b is now significantly above
      // a, swap their ordinals AND their positions so the change persists.
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
