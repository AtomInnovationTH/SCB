/**
 * RailGeometry.js — the shared geometry of the two Zoom Ladder rails
 * (plan D-H, Session J item 1: "Both rails move to mid-height (RailIndicator
 * bottom anchor → shared rail geometry constant)").
 *
 * Right rail = WHERE (RailIndicator — floors). Left rail = WHAT (PaneRail —
 * the panes this floor allows). Both sit MID-HEIGHT on their screen edge so
 * they stay clear of the bottom ~100 pt THUMB REST an iPad held in two hands
 * needs (D-H "Both rails mid-height, clear of the bottom ~100 pt thumb rest")
 * and clear of the touch docks that already live in the bottom corners
 * (TouchControls `.touch-nav-dock` bottom-left / `.touch-pane-dock`
 * bottom-right). The numbers are ONE table so the two rails can never drift
 * apart on the inset, the notch pitch or the hit slop.
 *
 * PURE DATA + one pure string function. No DOM, no imports — safe at import
 * in Node (the RailIndicator law: every rail module is headless-inert).
 *
 * @module ui/RailGeometry
 */

/**
 * The shared rail geometry (px = CSS px; on glass 1 CSS px = 1 pt).
 *
 *   EDGE_PX        inset from the screen edge (left:10px / right:10px)
 *   NOTCH_PX       notch pitch — the 40 pt row an iPad thumb can hit reliably
 *   SLOP_PX        tap hit slop (Apple HIG 44 pt): a pointerdown→pointerup pair
 *                  further apart than this is a drag, never a tap
 *   THUMB_REST_PX  the bottom band both rails must clear (two-thumb grip)
 *   IDLE_FADE      resting opacity after IDLE_FADE_MS without interaction
 *   IDLE_FADE_MS   the idle window (any tap / hover / populate wakes the rail)
 *   MAX_NOTCHES    the WHAT rail's height cap (8 × 40 pt + head fits an 11"
 *                  iPad landscape with the thumb rest clear; the rest goes
 *                  behind ONE `MORE` notch)
 */
export const RAIL_GEOMETRY = Object.freeze({
  EDGE_PX: 10,
  NOTCH_PX: 40,
  SLOP_PX: 44,
  THUMB_REST_PX: 100,
  IDLE_FADE: 0.35,
  IDLE_FADE_MS: 4000,
  MAX_NOTCHES: 8,
});

/**
 * The inline-CSS fragment that anchors a rail MID-HEIGHT on one screen edge:
 * absolute, vertically centred by the top:50% / translateY(-50%) pair (so the
 * rail grows symmetrically as notches come and go, never toward the thumb
 * rest), inset RAIL_GEOMETRY.EDGE_PX from the named edge. Ends with ';' so a
 * caller can prepend it to its own `a;b;c` cssText list.
 *
 *   midHeightCss('left')  → 'position:absolute;top:50%;transform:translateY(-50%);left:10px;'
 *   midHeightCss('right') → 'position:absolute;top:50%;transform:translateY(-50%);right:10px;'
 *
 * Anything that is not the string 'right' anchors LEFT (the WHAT rail's side).
 * @param {'left'|'right'} side
 * @returns {string}
 */
export function midHeightCss(side) {
  const edge = side === 'right' ? 'right' : 'left';
  return `position:absolute;top:50%;transform:translateY(-50%);${edge}:${RAIL_GEOMETRY.EDGE_PX}px;`;
}
