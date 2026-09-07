/**
 * RailGeometry.js — the shared geometry of the Zoom Ladder's EDGE CHROME
 * (plan D-H, Session J item 1: "Both rails move to mid-height (RailIndicator
 * bottom anchor → shared rail geometry constant)").
 *
 * The WHERE rail (RailIndicator — floors) sits MID-HEIGHT on the right edge
 * so it stays clear of the bottom ~100 pt THUMB REST an iPad held in two
 * hands needs (D-H "Both rails mid-height, clear of the bottom ~100 pt thumb
 * rest"). The left DISPLAY rail (PaneRail — the WHAT rail) that shared this
 * table RETIRED in Session P (plan D5) for the DETAIL slider, which lives in
 * the FOOTER BAND below; the table stays ONE so the rail, the slider and the
 * footer's occupants can never drift apart on the inset or the hit sizes.
 *
 * Session P (plan D2/D3/D7, owner 2026-09-07 — the dark cockpit): the table
 * also carries the EDGE-CHROME law's numbers (rest = vanish, the fade, the
 * Airbus box, the edge wake bands — consumed by js/ui/EdgeChrome.js) and the
 * FOOTER BAND (`footerBand()`), the one fixed strip above the transient band
 * that replaced the three edge dodge chains.
 *
 * PURE DATA + pure functions (`dodgeTop`, `midHeightCss`, `footerBand`). No
 * DOM, no imports — safe at import in Node (the RailIndicator law: every rail
 * module is headless-inert).
 *
 * @module ui/RailGeometry
 */

/**
 * The shared rail geometry (px = CSS px; on glass 1 CSS px = 1 pt).
 *
 *   EDGE_PX        inset from the screen edge (left:10px / right:10px)
 *   THUMB_REST_PX  the bottom band the rail must clear (two-thumb grip); on
 *                  glass the footer band sits above it too
 *   IDLE_FADE      resting opacity of EDGE CHROME after IDLE_FADE_MS without a
 *                  wake (Session P, plan D2 — the dark cockpit: 0 = vanish; the
 *                  "ghost tier" fallback is this ONE number, 0.12, if the P
 *                  playtest asks for it). Was 0.35 (Session J's fade-never-vanish
 *                  law, which 08-workbench §2 keeps for PANES — edge chrome is
 *                  the amendment).
 *   IDLE_FADE_MS   the idle window (a wake source resets it — EdgeChrome.wake)
 *   EDGE_FADE_MS   the opacity ramp when edge chrome sleeps (CSS transition);
 *                  `visibility:hidden` lands only AFTER it (0 under reduced motion)
 *   BOX_MS         the Airbus "box" (A4): a changed mode (the arrival floor's
 *                  notch, the rate label) wears a 1 px outline this long
 *   EDGE_WAKE_PX   the side EDGE BANDS (full height, each side) a touch / hover
 *                  in which wakes that side's chrome (plan D3 — edge-scoped, not
 *                  any-touch: a centre tap wakes nothing)
 *   FOOTER_BAND_PX the FOOTER BAND's height (plan D7): one fixed strip directly
 *                  above the bottom TRANSIENT band (toasts 48 px, hint ticker
 *                  88–124 px) — REFIT tab / DETAIL slider on the left, SPECS tab
 *                  on the right; every other rider's floor is the footer's top
 *   FOOTER_GAP_PX  the gap between the transient band and the footer's bottom
 *                  (the house GAP_PX 8 of CARGO/NEXT/ORBIT/OVERRIDE, so the
 *                  footer's bottom edge IS the OVERRIDE button's 132 baseline)
 *   TOUCH_PITCH_PX the GLASS hit-box height (Apple HIG 44 pt minimum): the
 *                  DETAIL slider's 32 px band sits centred in a transparent
 *                  44 pt row on glass (was the DISPLAY rail's notch pitch —
 *                  owner 2026-09-06). Desktop (fine pointer) keeps the visual
 *                  32 px.
 *
 * (NOTCH_PX 40, SLOP_PX 44 and MAX_NOTCHES 8 — the DISPLAY rail's row height,
 * tap slop and height cap — RETIRED with the rail: 2026-09-06 and Session P.)
 */
export const RAIL_GEOMETRY = Object.freeze({
  EDGE_PX: 10,
  THUMB_REST_PX: 100,
  IDLE_FADE: 0,
  IDLE_FADE_MS: 4000,
  EDGE_FADE_MS: 300,
  BOX_MS: 4000,
  EDGE_WAKE_PX: 40,
  FOOTER_BAND_PX: 32,
  FOOTER_GAP_PX: 8,
  DODGE_GAP_PX: 8,
  TOUCH_PITCH_PX: 44,
});

/**
 * THE FOOTER BAND (Session P, plan D7; owner 2026-09-07: "consistent place
 * directly above right thumb area"): one fixed 32 px strip that replaces the
 * three dodge chains (tab-under-rail, cargo-under-tab, orbit-under-rail).
 * Returns the band's `bottom` and `top` as OFFSETS FROM THE VIEWPORT BOTTOM
 * (CSS `bottom:` values), so a caller writes `bottom:${bottom}px` for a footer
 * occupant and `innerHeight - top` for a rider's floor. PURE.
 *
 * The vertical stacking law (plan §0): from the bottom up — the TRANSIENT band
 * (toasts at 48 px, the hint ticker 88–124 px; on glass the thumb rest 100 px
 * sits inside it) → FOOTER_GAP_PX → the FOOTER band → panes and the world.
 *
 *   bottom = max(glass ? THUMB_REST_PX : 0, hintBandPx) + FOOTER_GAP_PX
 *   top    = bottom + FOOTER_BAND_PX
 *
 *   footerBand({ glass: true,  hintBandPx: 124 })  → { bottom: 132, top: 164 }
 *   footerBand({ glass: false, hintBandPx: 124 })  → { bottom: 132, top: 164 }
 *   (the same numbers on both surfaces: 124 ≥ 100, so the thumb rest collapses)
 *
 * A non-finite `hintBandPx` reads as 0 (a boot without the ticker constants
 * still gets a footer above the thumb rest / the screen bottom).
 *
 * @param {{glass?:boolean, hintBandPx?:number}} [m]
 * @returns {{bottom:number, top:number}}
 */
export function footerBand({ glass = false, hintBandPx = 0 } = {}) {
  const hint = Number.isFinite(Number(hintBandPx)) ? Math.max(0, Number(hintBandPx)) : 0;
  const rest = glass ? RAIL_GEOMETRY.THUMB_REST_PX : 0;
  const bottom = Math.max(rest, hint) + RAIL_GEOMETRY.FOOTER_GAP_PX;
  return { bottom, top: bottom + RAIL_GEOMETRY.FOOTER_BAND_PX };
}

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
 * Anything that is not the string 'right' anchors LEFT (the DISPLAY rail's side).
 * @param {'left'|'right'} side
 * @returns {string}
 */
export function midHeightCss(side) {
  const edge = side === 'right' ? 'right' : 'left';
  return `position:absolute;top:50%;transform:translateY(-50%);${edge}:${RAIL_GEOMETRY.EDGE_PX}px;`;
}
