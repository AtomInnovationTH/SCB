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
 *   SLOP_PX        tap hit slop (Apple HIG 44 pt): a pointerdown→pointerup pair
 *                  further apart than this is a drag, never a tap
 *   THUMB_REST_PX  the bottom band both rails must clear (two-thumb grip)
 *   IDLE_FADE      resting opacity after IDLE_FADE_MS without interaction
 *   IDLE_FADE_MS   the idle window (any tap / hover / populate wakes the rail)
 *   TOUCH_PITCH_PX the WHAT rail's notch HIT BOX height on GLASS (Apple HIG
 *                  44 pt minimum): the compact 17 pt plate sits centred in a
 *                  transparent 44 pt row, boxes tile with no gap, so every y
 *                  on the rail is a reliable thumb target while the rail still
 *                  LOOKS like the WHERE rail's rows. Desktop (fine pointer)
 *                  keeps the tight 5 px-gap rows — a mouse hits 17 pt fine.
 *   MAX_NOTCHES    the WHAT rail's height cap: the listed rows before the rest
 *                  folds behind ONE `MORE` notch (8 keeps the rail a glance,
 *                  not a menu; the rows themselves are the WHERE rail's
 *                  compact text rows — owner 2026-09-06 — so height is no
 *                  longer the constraint it was at 40 pt per row)
 *
 * (NOTCH_PX 40 — the fixed 40 pt WHAT-rail row — was RETIRED 2026-09-06: the
 * WHAT rail now wears the WHERE rail's rows, which have no fixed height. The
 * touch hit height of a notch is its text row, ~17 px + the 5 px gap — see
 * the 03-plan Job 1 follow-up FINDINGS for the glass hit-size question.)
 */
export const RAIL_GEOMETRY = Object.freeze({
  EDGE_PX: 10,
  SLOP_PX: 44,
  THUMB_REST_PX: 100,
  IDLE_FADE: 0.35,
  IDLE_FADE_MS: 4000,
  MAX_NOTCHES: 8,
  DODGE_GAP_PX: 8,
  TOUCH_PITCH_PX: 44,
});

/**
 * THE DODGE (owner, 2026-09-06: "the floor pane and the pane selector are
 * overlapping other panes"). Mid-height is the DESIGN anchor (D-H, thumb
 * reach), but the HUD columns on each side are top-anchored stacks whose
 * height depends on the room (nav orb on, discoveries on, a long fleet…), so
 * on a short screen a tall column reaches the rail's band. Rule: when the
 * column on the rail's side ends below where the mid-height rail would START,
 * the rail slides DOWN to sit DODGE_GAP_PX under the column — clamped so its
 * bottom never enters the THUMB_REST_PX band. Returns the CSS `top` in px, or
 * null = "mid-height as designed" (the column ends above the rail, or there
 * is no room to dodge at all — then the rail stays put and the overlap is the
 * lesser evil against a rail in the thumb rest). PURE: the caller measures.
 *
 *   dodgeTop({ railH:135, colBottom:480, innerH:800 })  → 488   (mid would be 332.5)
 *   dodgeTop({ railH:223, colBottom:220, innerH:800 })  → null  (mid 288.5 already clears it)
 *   dodgeTop({ railH:135, colBottom:700, innerH:800 })  → null  (708+135 > 700: no room)
 *
 * @param {{railH:number, colBottom:number, innerH:number}} m  measured px
 *   (colBottom = the side column's bottom edge; pass -Infinity when the column
 *   is absent / empty)
 * @returns {number|null}
 */
export function dodgeTop({ railH, colBottom, innerH } = {}) {
  const h = Number(railH), cb = Number(colBottom), ih = Number(innerH);
  if (!(h > 0) || !(ih > 0) || Number.isNaN(cb)) return null;
  const midTop = (ih - h) / 2;
  const want = cb + RAIL_GEOMETRY.DODGE_GAP_PX;
  if (!(want > midTop)) return null;                           // mid-height clears the column
  const floor = ih - RAIL_GEOMETRY.THUMB_REST_PX - h;          // the lowest top that keeps the thumb rest
  if (want > floor) return null;                               // cannot CLEAR the column above the thumb rest: stay mid
  return Math.round(want);
}

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
