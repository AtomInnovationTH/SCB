/**
 * RailGeometry.js — shared geometry of the Zoom Ladder's EDGE CHROME: the WHERE rail (RailIndicator, floors) sits
 * MID-HEIGHT on the right edge, clear of the bottom ~100 pt thumb rest of an iPad held in two hands. The table also
 * carries the edge-chrome law's numbers (rest = vanish, fade, Airbus box, edge wake bands; consumed by
 * js/ui/EdgeChrome.js) and the FOOTER BAND. It stays ONE table so rails, DETAIL slider and footer occupants cannot
 * drift apart on inset or hit sizes.
 *
 * Pure data and pure functions (`dodgeTop`, `midHeightCss`, `footerBand`); no DOM, no imports, so it is safe to
 * import in Node (every rail module is headless-inert).
 *
 * @module ui/RailGeometry
 */

/**
 * The shared rail geometry (px = CSS px; on glass 1 CSS px = 1 pt).
 *
 *   EDGE_PX        inset from the screen edge. ONE number, two names (HUD_EDGE_PX === EDGE_PX): the rails, the footer
 *                  occupants (REFIT / SPECS / DETAIL slider) and the HUD arms all read it so they cannot drift.
 *   THUMB_REST_PX  the bottom band the rail must clear (two-thumb grip); on glass the footer band sits above it too
 *   IDLE_FADE      resting opacity of EDGE CHROME after IDLE_FADE_MS without a wake: 0 = vanish (dark cockpit, owner
 *                  2026-09-07; a "ghost tier" of 0.12 is the fallback). PANES keep fade-never-vanish (08-workbench §2).
 *   IDLE_FADE_MS   the idle window (a wake source resets it — EdgeChrome.wake)
 *   EDGE_FADE_MS   opacity ramp when edge chrome sleeps (CSS transition); `visibility:hidden` lands only AFTER it
 *                  (0 under reduced motion)
 *   BOX_MS         the Airbus "box": a changed mode (arrival floor's notch, rate label) wears a 1 px outline this long
 *   EDGE_WAKE_PX   side EDGE BANDS (full height, each side): a touch / hover in one wakes that side's chrome
 *                  (edge-scoped, not any-touch: a centre tap wakes nothing)
 *   FOOTER_BAND_PX the FOOTER BAND's height: one fixed strip directly above the bottom TRANSIENT band (hint ticker
 *                  88–124 px) — REFIT tab / DETAIL slider left, SPECS tab right. Its centre is free: the toast lands
 *                  on its bottom edge (132) and the ARM PILOT strip one gap above its top (172) —
 *                  `HUD.toastBottomPx` / `HUD.armPilotStripBottomPx`; the SAFETY OVERRIDE gag sits at the viewport
 *                  bottom (12–68), below the transient band
 *   FOOTER_GAP_PX  gap between the transient band and the footer's bottom (house GAP_PX 8; the ARM PILOT strip keeps
 *                  the same gap above the footer's top)
 *   TOUCH_PITCH_PX GLASS hit-box height (Apple HIG 44 pt minimum): the DETAIL slider's 32 px band sits centred in a
 *                  transparent 44 pt row on glass; desktop (fine pointer) keeps the visual 32 px
 *   HUD_EDGE_PX    alias of EDGE_PX (the HUD ARMS' inset). CSS insets read `max(16px, env(safe-area-inset-*))`.
 *                  Never give it its own literal.
 *   HUD_COLUMN_WIDTH_PX  the BASE pane width: `.hud-panel` CSS width, the Cargo / Orbit / Autopilot / Pin riders,
 *                  DISCOVERIES popover, FMA strip, Next. The two ARMS are wider (names below); this stays 280.
 *   MOTHER_PANE_WIDTH_PX   Mother (left arm's top pane): 480, as wide as the comms pane (DECISIONS §23).
 *                  Equals `Constants.COMMS.PANE_WIDTH_PX` (a test pins them equal);
 *                  index.html's `--hud-side-w` narrows both together on small screens so the centred score strip
 *                  stays clear.
 *   ARMS_PANE_WIDTH_PX     Daughters (left arm's second pane): 350
 *   TARGETS_PANE_WIDTH_PX  Targets (right arm's first pane): 350
 *   LEFT_COLUMN_WIDTH_PX   `#hud-left-column`: 480 (widest child, Mother); `align-items: flex-start`, so the 280
 *                  riders hug the left edge and the outer edges of the U stay straight at PANE_CORNER_PX (0)
 *   RIGHT_COLUMN_WIDTH_PX  `#hud-right-column`: 350 (= Targets); `align-items: flex-end` hugs the 280 Debris / Next
 *                  to the right edge. Comms stays 480 at `right: max(PANE_CORNER_PX, safe-area)`.
 *                  `OrbitPane.rightPx()` is PANE_CORNER_PX + 280 (it follows the rider); the target-law recentre
 *                  inputs (296 / W − 296) stay on the base width on purpose.
 */
const EDGE_PX = 16;
export const RAIL_GEOMETRY = Object.freeze({
  EDGE_PX,
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
  HUD_EDGE_PX: EDGE_PX,     // === EDGE_PX (one number, two names)
  HUD_COLUMN_WIDTH_PX: 280, // the BASE pane width (.hud-panel, riders, popover, Next)
  MOTHER_PANE_WIDTH_PX: 480,   // === Constants.COMMS.PANE_WIDTH_PX (a test pins it)
  ARMS_PANE_WIDTH_PX: 350,
  TARGETS_PANE_WIDTH_PX: 350,
  LEFT_COLUMN_WIDTH_PX: 480,   // = MOTHER_PANE_WIDTH_PX (the widest left child)
  RIGHT_COLUMN_WIDTH_PX: 350,  // = TARGETS_PANE_WIDTH_PX (the widest right child)
});

export const HUD_EDGE_PX = RAIL_GEOMETRY.EDGE_PX;
/**
 * Side pane stacks' inset from the screen edge (DECISIONS §28: MOTHER and COMMS sit flush in their top corners). Top and
 * side edge both read this (0); the panes stacked under them (left column children, LeftStack riders, pin widget, right
 * column) move with it so each edge stays straight. HUD_EDGE_PX (16) stays the inset of rails, tabs, footer chips, the
 * SkillsPane popover and the orb. index.html keeps a CSS copy (`#hud-left-column` left).
 */
export const PANE_CORNER_PX = 0;   // deliberately NOT in RAIL_GEOMETRY (its key list is pinned): a named export of its own
// Re-exported by name from RAIL_GEOMETRY:
export const HUD_COLUMN_WIDTH_PX = RAIL_GEOMETRY.HUD_COLUMN_WIDTH_PX;
export const MOTHER_PANE_WIDTH_PX = RAIL_GEOMETRY.MOTHER_PANE_WIDTH_PX;
export const ARMS_PANE_WIDTH_PX = RAIL_GEOMETRY.ARMS_PANE_WIDTH_PX;
export const TARGETS_PANE_WIDTH_PX = RAIL_GEOMETRY.TARGETS_PANE_WIDTH_PX;
export const LEFT_COLUMN_WIDTH_PX = RAIL_GEOMETRY.LEFT_COLUMN_WIDTH_PX;
export const RIGHT_COLUMN_WIDTH_PX = RAIL_GEOMETRY.RIGHT_COLUMN_WIDTH_PX;

/**
 * THE FOOTER BAND: one fixed 32 px strip ("consistent place directly above right thumb area", owner 2026-09-07) that
 * replaced the three dodge chains. Returns `bottom` and `top` as OFFSETS FROM THE VIEWPORT BOTTOM (CSS `bottom:`
 * values): a footer occupant writes `bottom:${bottom}px`, a rider's floor is `innerHeight - top`. PURE.
 *
 * Vertical stacking law, bottom up: SAFETY OVERRIDE gag (12–68, `OVERRIDE_GEOMETRY.BOTTOM_PX`) → TRANSIENT band (hint
 * ticker 88–124 px; on glass the 100 px thumb rest sits inside it) → FOOTER_GAP_PX → FOOTER band (toast on its bottom
 * edge, 132) → FOOTER_GAP_PX → ARM PILOT strip (172) → panes and the world.
 *
 *   bottom = max(glass ? THUMB_REST_PX : 0, hintBandPx) + FOOTER_GAP_PX
 *   top    = bottom + FOOTER_BAND_PX
 *
 *   footerBand({ glass: true,  hintBandPx: 124 })  → { bottom: 132, top: 164 }
 *   footerBand({ glass: false, hintBandPx: 124 })  → { bottom: 132, top: 164 }  (124 ≥ 100: thumb rest collapses)
 *
 * A non-finite `hintBandPx` reads as 0 (a boot without the ticker constants still clears the thumb rest).
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
 * THE DODGE (owner 2026-09-06: "the floor pane and the pane selector are overlapping other panes"). Mid-height is
 * the design anchor (thumb reach), but the top-anchored HUD columns vary in height, so on a short screen a tall
 * column reaches the rail's band. When the column on the rail's side ends below where the
 * mid-height rail would START, the rail slides DOWN to DODGE_GAP_PX under the column, clamped so its bottom never
 * enters the THUMB_REST_PX band. Returns the CSS `top` in px, or null = "mid-height as designed" (column ends above
 * the rail, or no room to dodge: the overlap is the lesser evil against a rail in the thumb rest). PURE: the caller
 * measures.
 *
 *   dodgeTop({ railH:135, colBottom:480, innerH:800 })  → 488   (mid would be 332.5)
 *   dodgeTop({ railH:223, colBottom:220, innerH:800 })  → null  (mid 288.5 already clears it)
 *   dodgeTop({ railH:135, colBottom:700, innerH:800 })  → null  (708+135 > 700: no room)
 *
 * @param {{railH:number, colBottom:number, innerH:number}} m  measured px (colBottom = the side column's bottom
 *   edge; -Infinity when the column is absent / empty)
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
 * Inline-CSS fragment anchoring a rail MID-HEIGHT on one edge: absolute, centred by top:50% / translateY(-50%) (grows
 * symmetrically, never toward the thumb rest), inset EDGE_PX. Ends with ';' so a caller can prepend it to its own
 * cssText list.
 *
 *   midHeightCss('right') → 'position:absolute;top:50%;transform:translateY(-50%);right:16px;'
 *
 * Anything that is not the string 'right' anchors LEFT.
 * @param {'left'|'right'} side
 * @returns {string}
 */
export function midHeightCss(side) {
  const edge = side === 'right' ? 'right' : 'left';
  return `position:absolute;top:50%;transform:translateY(-50%);${edge}:${RAIL_GEOMETRY.EDGE_PX}px;`;
}
