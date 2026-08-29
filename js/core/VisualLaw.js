/**
 * VisualLaw.js — the Zoom Ladder's visual constitution (M0 stub constants).
 *
 * PURE DATA: colors, icon grammar, the one easing curve, ride/fade timings,
 * alarm caps, label budgets, rail + reduced-motion rules. No imports, no
 * behavior. Floors and mechanics live in js/core/FloorContract.js; prose in
 * docs/ladder/00-spec.md ("Visual law"). test-FloorContract.js pins the
 * invariants (5 distinct colors, sizes 12-24 px, one curve, 450-650 ms rides,
 * label budget 7, klaxon flash <= 3 Hz).
 *
 * Law summary:
 *   - heritage green = player/systems; gold = mass/value (steady); red-orange
 *     = threat (ALWAYS pulses); cyan = info; white = selection ONLY.
 *   - Color is never the sole channel (shape/size/motion double-encode).
 *   - Fragments render as dust shimmer, never icons (mass-honesty rule).
 *   - ONE easing curve everywhere. Camera never rolls.
 *
 * @module core/VisualLaw
 */

export const VisualLaw = {
  COLORS: {
    PLAYER: '#00ff88',     // heritage green — player/systems (COMMS nominal, LEDs)
    VALUE: '#ffd166',      // gold — mass/value, STEADY (never pulses)
    THREAT: '#ff4422',     // red-orange — threat, ALWAYS pulses
    INFO: '#00ccff',       // cyan — informational (matches TEACHING overlay family)
    SELECTION: '#ffffff',  // white — selection ONLY, no other use
  },
  /** Color is never the sole channel: every color-coded meaning must also be
   *  encoded in shape, size, or motion. */
  COLOR_NEVER_SOLE_CHANNEL: true,

  ICONS: {
    /** World-icon grammar. Gold shapes carry VALUE color; ship chevron points
     *  along velocity; clusters render ring+count. */
    SHAPES: {
      ship: 'chevron',          // points along velocity
      debris: 'diamond',
      rocketBody: 'gold-oblong',
      deadGeoSat: 'gold-square',
      cluster: 'ring-count',
      fragments: 'dust',        // dust shimmer, NEVER icons (mass-honesty rule)
    },
    SIZES_PX: [12, 18, 24],     // exactly 3 sizes, all within 12-24 px
    MIN_PX: 12,
    MAX_PX: 24,
  },

  /** The one easing curve. Every ride, fade, costume change, and rail motion. */
  EASING: 'cubic-in-out',

  TIMINGS: {
    RIDE_MIN_MS: 450,           // crossing ride duration window
    RIDE_MAX_MS: 650,
    HOTKEY_MINI_RIDE_MS: 200,   // instant jumps still ride (subject reframe needs time)
    SUBJECT_REAIM_MS: 300,      // re-aim / subject-loss fallback — soft, never a cut
    PEEK_GHOST_OPACITY: 0.15,   // next floor's UI ghost while spring charge > peek threshold
  },

  /** Alarm escalation: knock (rail notch flash + sound) -> klaxon -> auto-ride. */
  KLAXON: {
    AUTO_RIDE_DELAY_S: 3,       // klaxon -> auto-ride after this; Esc/scroll cancels
    FLASH_HZ_MAX: 3,            // flash rate cap (reduced-motion confines flashes to rail)
    FLASH_RAIL_ONLY_REDUCED: true,
  },

  LABELS: {
    MAX_WORLD: 7,               // max simultaneous world labels, priority-ranked
    HOVER_REVEALS: true,        // hover reveals suppressed labels
  },

  /** Rail indicator: right edge, 7 notches, instrument names, charge fill,
   *  subject name, warp readout; clickable notches, draggable scrub. */
  RAIL: {
    SIDE: 'right',
    NOTCHES: 7,
    SHOWS: ['instrument-names', 'charge-fill', 'subject-name', 'warp-readout'],
    CLICKABLE: true,
    DRAGGABLE: true,
  },

  /** Reduced-motion setting: crossfades replace rides, no FOV squeeze,
   *  flashes <= 3 Hz confined to the rail. */
  REDUCED_MOTION: {
    CROSSFADE_REPLACES_RIDES: true,
    NO_FOV_SQUEEZE: true,
    FLASH_HZ_MAX: 3,
  },

  /** Floor-7 visual defaults — REVISIT AFTER M4 (docs/ladder/00-spec.md §3 F7). */
  FLOOR7_DEFAULTS: {
    RAIL_SIDE: 'right',
    CHART_EARTH: 'chart-blue flat overlay sphere (overlay mesh, not a shader swap)',
    TERMINATOR_LIGHTING: true,
    SELF_LIT_BANDS: true,
  },
};
