/**
 * starCatalog.js — the 49 named bright stars that sit at the constellation
 * vertices, plus the stick-figure table that joins them.
 *
 * Pure data, no `three` import — this module is the single source of truth for
 * both the star positions (Starfield writes them into the main Points) and the
 * constellation lines (Starfield reads the same coordinates), so a line can
 * never miss its star. Keeping it `three`-free lets the data-integrity test
 * run as a plain node test.
 *
 * RA/Dec are the existing approximate pattern-forming positions (lifted
 * verbatim from Starfield.js so the figures do not change shape); absolute
 * astrometric accuracy is deferred to Stage 7. Magnitudes / spectral classes
 * are the spec's Stage 1a table with three corrections applied (see notes
 * below). The variables and doubles are called out in comments so nobody
 * "corrects" them back to a single canonical value later.
 *
 * @module scene/starCatalog
 */

// { ra: hours (0–24), dec: degrees (-90..+90), mag: visual magnitude, spec: spectral class }
export const BRIGHT_STARS = {
  // ── ORION (7) ────────────────────────────────────────────────────────────
  Betelgeuse:   { ra: 5.92,  dec: 7.41,   mag: 0.45, spec: 'M2' }, // variable 0.0–1.3
  Bellatrix:    { ra: 5.42,  dec: 6.35,   mag: 1.64, spec: 'B2' },
  Mintaka:      { ra: 5.53,  dec: -0.30,  mag: 2.25, spec: 'O9' }, // multiple; mag is the combined light
  Alnilam:      { ra: 5.60,  dec: -1.20,  mag: 1.69, spec: 'B0' },
  Alnitak:      { ra: 5.68,  dec: -1.94,  mag: 1.74, spec: 'O9' }, // multiple; mag is the combined light
  Saiph:        { ra: 5.80,  dec: -9.67,  mag: 2.07, spec: 'B0' },
  Rigel:        { ra: 5.24,  dec: -8.20,  mag: 0.13, spec: 'B8' }, // corrected 0.18 → 0.13

  // ── URSA MAJOR (7) ───────────────────────────────────────────────────────
  Alkaid:       { ra: 13.79, dec: 49.31,  mag: 1.86, spec: 'B3' },
  Mizar:        { ra: 13.40, dec: 54.93,  mag: 2.23, spec: 'A2' }, // double (Mizar A/B + Alcor); mag is combined
  Alioth:       { ra: 12.90, dec: 55.96,  mag: 1.77, spec: 'A0' },
  Megrez:       { ra: 12.26, dec: 57.03,  mag: 3.31, spec: 'A3' },
  Phecda:       { ra: 11.90, dec: 53.69,  mag: 2.44, spec: 'A0' },
  Merak:        { ra: 11.03, dec: 56.38,  mag: 2.37, spec: 'A1' },
  Dubhe:        { ra: 11.06, dec: 61.75,  mag: 1.79, spec: 'K0' },

  // ── CASSIOPEIA (5) ───────────────────────────────────────────────────────
  Caph:         { ra: 0.15,  dec: 59.15,  mag: 2.27, spec: 'F2' },
  Schedar:      { ra: 0.68,  dec: 56.54,  mag: 2.24, spec: 'K0' },
  'Gamma Cas':  { ra: 0.95,  dec: 60.72,  mag: 2.47, spec: 'B0.5' }, // corrected 2.15 → 2.47; variable 1.6–3.0 (B0.5IVe)
  Ruchbah:      { ra: 1.43,  dec: 60.24,  mag: 2.68, spec: 'A5' },
  Segin:        { ra: 1.91,  dec: 63.67,  mag: 3.35, spec: 'B3' },

  // ── SCORPIUS (7) ─────────────────────────────────────────────────────────
  Graffias:     { ra: 16.09, dec: -19.81, mag: 2.62, spec: 'B1' },
  Dschubba:     { ra: 16.01, dec: -22.62, mag: 2.32, spec: 'B0' },
  Antares:      { ra: 16.49, dec: -26.43, mag: 1.09, spec: 'M1' }, // corrected 1.06 → 1.09; variable 0.6–1.6
  'Epsilon Sco':{ ra: 16.84, dec: -34.29, mag: 2.29, spec: 'K2' },
  'Mu1 Sco':    { ra: 16.86, dec: -38.05, mag: 3.00, spec: 'B1' },
  Shaula:       { ra: 17.56, dec: -37.10, mag: 1.62, spec: 'B2' },
  Lesath:       { ra: 17.53, dec: -37.29, mag: 2.70, spec: 'B2' },

  // ── LEO (8) ──────────────────────────────────────────────────────────────
  Regulus:      { ra: 10.14, dec: 11.97,  mag: 1.36, spec: 'B8' },
  'Eta Leo':    { ra: 10.12, dec: 16.76,  mag: 3.49, spec: 'A0' },
  Algieba:      { ra: 10.33, dec: 19.84,  mag: 2.08, spec: 'K1' }, // double; mag is combined
  'Zeta Leo':   { ra: 10.28, dec: 23.42,  mag: 3.44, spec: 'F0' },
  'Epsilon Leo':{ ra: 9.76,  dec: 23.77,  mag: 2.98, spec: 'G1' },
  Zosma:        { ra: 11.24, dec: 20.52,  mag: 2.56, spec: 'A4' },
  Denebola:     { ra: 11.82, dec: 14.57,  mag: 2.11, spec: 'A3' },
  'Theta Leo':  { ra: 11.24, dec: 15.43,  mag: 3.32, spec: 'A2' },

  // ── CRUX (4) ─────────────────────────────────────────────────────────────
  Acrux:        { ra: 12.44, dec: -63.10, mag: 0.77, spec: 'B0' }, // double; mag is combined
  Mimosa:       { ra: 12.79, dec: -59.69, mag: 1.25, spec: 'B0' },
  Gacrux:       { ra: 12.52, dec: -57.11, mag: 1.63, spec: 'M3' },
  'Delta Cru':  { ra: 12.25, dec: -58.75, mag: 2.79, spec: 'B2' },

  // ── CYGNUS (5) ───────────────────────────────────────────────────────────
  Deneb:        { ra: 20.69, dec: 45.28,  mag: 1.25, spec: 'A2' },
  Sadr:         { ra: 20.37, dec: 40.26,  mag: 2.23, spec: 'F8' },
  Albireo:      { ra: 19.51, dec: 27.96,  mag: 3.05, spec: 'K3' }, // double (gold/blue); mag is the K3 primary
  'Epsilon Cyg':{ ra: 20.77, dec: 33.97,  mag: 2.48, spec: 'K0' },
  'Delta Cyg':  { ra: 19.75, dec: 45.13,  mag: 2.87, spec: 'B9' },

  // ── GEMINI (6) ───────────────────────────────────────────────────────────
  Castor:       { ra: 7.58,  dec: 31.89,  mag: 1.58, spec: 'A1' }, // double (Castor A/B); mag is combined
  Pollux:       { ra: 7.76,  dec: 28.03,  mag: 1.14, spec: 'K0' },
  Alhena:       { ra: 6.63,  dec: 16.40,  mag: 1.93, spec: 'A0' },
  Tejat:        { ra: 6.38,  dec: 22.51,  mag: 2.87, spec: 'M3' },
  Mebsuta:      { ra: 6.73,  dec: 25.13,  mag: 3.06, spec: 'G8' },
  Propus:       { ra: 6.25,  dec: 22.51,  mag: 3.28, spec: 'M3' },
};

/**
 * The 8 stick figures. `stars` are keys into BRIGHT_STARS (quoted for the
 * two-word names); `lines` are index pairs into that figure's own `stars`
 * array. Named CONSTELLATION_FIGURES, not CONSTELLATIONS — the bare name is
 * already taken in this codebase by satellite constellations
 * (data/constellations.json, CatalogLoader.js), and two unrelated meanings
 * under one grep is a comprehension trap.
 */
export const CONSTELLATION_FIGURES = [  { // Orion — distinctive hourglass with belt
    name: 'ORION',
    stars: ['Betelgeuse', 'Bellatrix', 'Mintaka', 'Alnilam', 'Alnitak', 'Saiph', 'Rigel'],
    lines: [[0,1],[2,3],[3,4],[0,4],[1,2],[5,4],[6,2]],
  },
  { // Ursa Major (Big Dipper) — 7-star dipper with bowl closed
    name: 'URSA MAJOR',
    stars: ['Alkaid', 'Mizar', 'Alioth', 'Megrez', 'Phecda', 'Merak', 'Dubhe'],
    lines: [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,3]],
  },
  { // Cassiopeia — distinctive W shape
    name: 'CASSIOPEIA',
    stars: ['Caph', 'Schedar', 'Gamma Cas', 'Ruchbah', 'Segin'],
    lines: [[0,1],[1,2],[2,3],[3,4]],
  },
  { // Scorpius — curved tail with Antares
    name: 'SCORPIUS',
    stars: ['Graffias', 'Dschubba', 'Antares', 'Epsilon Sco', 'Mu1 Sco', 'Shaula', 'Lesath'],
    lines: [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6]],
  },
  { // Leo — sickle/hook + body
    name: 'LEO',
    stars: ['Regulus', 'Eta Leo', 'Algieba', 'Zeta Leo', 'Epsilon Leo', 'Zosma', 'Denebola', 'Theta Leo'],
    lines: [[4,3],[3,2],[2,1],[1,0],[0,7],[7,5],[5,6]],
  },
  { // Crux (Southern Cross) — 4 stars in cross
    name: 'CRUX',
    stars: ['Acrux', 'Mimosa', 'Gacrux', 'Delta Cru'],
    lines: [[0,2],[1,3]],
  },
  { // Cygnus (Northern Cross) — cross shape
    name: 'CYGNUS',
    stars: ['Deneb', 'Sadr', 'Albireo', 'Epsilon Cyg', 'Delta Cyg'],
    lines: [[0,1],[1,2],[4,1],[1,3]],
  },
  { // Gemini — two parallel figures (Castor & Pollux)
    name: 'GEMINI',
    stars: ['Castor', 'Pollux', 'Alhena', 'Tejat', 'Mebsuta', 'Propus'],
    lines: [[0,1],[0,4],[4,3],[3,5],[1,2]],
  },
];

// ============================================================================
// Faint-field magnitude model (Stage 2) — pure math, kept three-free so the
// data-integrity test can exercise it as a plain node test. Starfield._create
// uses these to build the random field; keeping them here means the field and
// its test share one source of truth.
// ============================================================================

/**
 * Inverse-CDF sample of the field magnitude distribution. Counts rise toward
 * the faint end (log N ∝ 0.6·m, the real sky's roughly exponential star-count
 * law), so most field stars are near-invisible.
 * @param {number} u — uniform random in [0,1)
 * @param {number} mMin — brightest field magnitude
 * @param {number} mMax — faintest field magnitude
 * @returns {number} magnitude in [mMin, mMax]
 */
export function sampleFieldMagnitude(u, mMin, mMax) {
  const denom = Math.pow(10, 0.6 * (mMax - mMin)) - 1;
  return mMin + Math.log10(1 + u * denom) / 0.6;
}

/**
 * Catalogue-star brightness: the visual-magnitude curve with a soft knee at
 * the floor. Exported so Starfield and the test share one source of truth —
 * the field brightness constant (Constants.STAR_FIELD_BRIGHT) must stay
 * strictly below the faintest catalogue star's peak, and the test can only
 * assert that if it can evaluate the same formula Starfield uses.
 *
 * Above the knee (`min`) the raw exponential is used verbatim (Rigel 2.0,
 * Deneb 0.79, …). Below it a hard clamp would flatten every star fainter than
 * mag ~1.87 — 32 of the 49 — to identical brightness, and "brightness carries
 * the truth" would hold for only a third of the catalogue. Instead the soft
 * knee maps raw ∈ (0, min) onto [min·soft, min): continuous at the knee,
 * strictly monotone everywhere (ordering is never lost), and asymptotic to
 * min·soft = 0.3825, which stays strictly above the field's 0.32 with margin.
 *
 * @param {number} mag — visual magnitude
 * @param {number} min — knee (Constants.STAR_MAG_BRIGHT_MIN)
 * @param {number} max — ceiling (Constants.STAR_MAG_BRIGHT_MAX, bloom-coupled)
 * @param {number} soft — sub-knee asymptote ratio (Constants.STAR_MAG_BRIGHT_FLOOR_SOFT)
 * @returns {number} brightness multiplier in [min·soft, max]
 */
export function magnitudeBrightness(mag, min, max, soft) {
  const raw = Math.pow(10, -0.4 * (mag - 1.0));
  if (raw >= min) return Math.min(raw, max);
  return min * (soft + (1 - soft) * (raw / min));
}

// ============================================================================
// THE ONE BRIGHTNESS CURVE FOR THE WHOLE SKY (stars AND bodies)
// ============================================================================
//
// magnitudeBrightness owns the bottom half: raw 10^(−0.4(m−1)), a soft knee
// below `min`, and a ceiling at `max`. That ceiling was a HARD clamp — fine
// while only stars used it (the brightest star, Rigel, sits at raw 2.23, barely
// past the 2.0 ceiling), but the planets live far above it: Venus raw 145,
// Jupiter 19, Mars 10, Mercury 3.6. A hard clamp flattens all five to 2.0 —
// the exact "flatten a population with a hard clamp" defect class the doctrine
// forbids (F5).
//
// The soft ceiling is the mirror image of the soft knee: above `max`, grow
// logarithmically so ordering survives without letting anything run away:
//
//     B(m) = max · (1 + hardness · log10(raw / max))      for raw > max
//
// With hardness = 0.20 the whole sky lands on one strictly-monotone curve:
//
//     Venus −4.4 → 2.74 (blooms — the ONLY planet allowed to, D3)
//     Jupiter −2.2 → 2.39
//     Mars −1.5 → 2.28
//     Mercury −0.4 → 2.10
//     Rigel +0.13 → 2.019 (was hard-clamped to exactly 2.0)
//     Saturn +0.5 → 1.58
//     Eta Leo +3.49 → 0.398
//     field 4.4–7.0 → 0.32 constant
//
// Bloom coupling: the threshold is 2.5 (SceneManager). Only the Sun and Venus
// may cross it — Venus lands at 2.74, everything else stays under. Rigel's
// 2.019 × uOpacity 0.95 = 1.92, still safely below.
//
/** Soft-ceiling hardness: how fast brightness grows past `max` (log10 slope). */
export const SKY_BRIGHT_CEILING_HARDNESS = 0.20;

/**
 * The whole-sky brightness function: magnitudeBrightness plus the soft ceiling.
 * Identical to magnitudeBrightness below `max`, logarithmic above it — so stars
 * and bodies can never diverge onto two curves. Starfield uses this for the
 * catalogue stars (Rigel 2.019, not a hard 2.0); the body ladder uses it for
 * the planets (Venus 2.74 blooms, Jupiter 2.39 does not).
 *
 * @param {number} mag — visual magnitude
 * @param {number} min — soft-knee floor (Constants.STAR_MAG_BRIGHT_MIN)
 * @param {number} max — soft ceiling (Constants.STAR_MAG_BRIGHT_MAX, bloom-coupled)
 * @param {number} soft — sub-knee asymptote ratio (Constants.STAR_MAG_BRIGHT_FLOOR_SOFT)
 * @param {number} [hardness] — ceiling slope (SKY_BRIGHT_CEILING_HARDNESS)
 * @returns {number} brightness multiplier in (min·soft, ∞), strictly monotone in mag
 */
export function skyBrightness(mag, min, max, soft, hardness = SKY_BRIGHT_CEILING_HARDNESS) {
  const raw = Math.pow(10, -0.4 * (mag - 1.0));
  if (raw > max) return max * (1 + hardness * Math.log10(raw / max));
  return magnitudeBrightness(mag, min, max, soft);
}

/**
 * Map a magnitude to a size attribute and alpha on the shared magnitude curve.
 * Size follows `base − slope·mag` but never drops below `floor`; once pinned at
 * the floor, alpha carries the remaining faintness (linear from 1.0 at the
 * floor crossing to `alphaMin` at `mMax`).
 * @returns {{ size: number, alpha: number }}
 */
export function fieldSizeAlpha(mag, mMax, { base, slope, floor, alphaMin }) {
  const curveSize = base - slope * mag;
  if (curveSize >= floor) return { size: curveSize, alpha: 1.0 };
  const magAtFloor = (base - floor) / slope;
  const t = Math.min(1, Math.max(0, (mag - magAtFloor) / (mMax - magAtFloor)));
  return { size: floor, alpha: 1.0 + (alphaMin - 1.0) * t };
}
