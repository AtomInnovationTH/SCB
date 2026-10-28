/**
 * starCatalog.js — the 49 named bright stars at the constellation vertices,
 * the stick-figure table, and the pure-math sky helpers (magnitude curve,
 * galactic frame).
 *
 * No `three` import: one source of truth for star positions and constellation
 * lines (a line can never miss its star), and plain-node testable.
 *
 * RA/Dec are approximate pattern-forming positions, not astrometric. Magnitudes and spectral classes are the
 * spec's Stage 1a table with three deliberate corrections (Rigel, Gamma Cas, Antares), noted at each star.
 * Variables and doubles are annotated so nobody "corrects" them to one value.
 *
 * @module scene/starCatalog
 */

import { DEG2RAD, clamp01, lerp, smoothstep01 } from '../core/MathUtil.js';

// { ra: hours (0–24), dec: degrees (-90..+90), mag: visual magnitude, spec: spectral class }
export const BRIGHT_STARS = {
  // ── ORION (7) ────────────────────────────────────────────────────────────
  Betelgeuse:   { ra: 5.92,  dec: 7.41,   mag: 0.45, spec: 'M2' }, // variable 0.0–1.3
  Bellatrix:    { ra: 5.42,  dec: 6.35,   mag: 1.64, spec: 'B2' },
  Mintaka:      { ra: 5.53,  dec: -0.30,  mag: 2.25, spec: 'O9' }, // multiple; mag is the combined light
  Alnilam:      { ra: 5.60,  dec: -1.20,  mag: 1.69, spec: 'B0' },
  Alnitak:      { ra: 5.68,  dec: -1.94,  mag: 1.74, spec: 'O9' }, // multiple; mag is the combined light
  Saiph:        { ra: 5.80,  dec: -9.67,  mag: 2.07, spec: 'B0' },
  Rigel:        { ra: 5.24,  dec: -8.20,  mag: 0.13, spec: 'B8' }, // differs from the spec table (corrected)

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
  'Gamma Cas':  { ra: 0.95,  dec: 60.72,  mag: 2.47, spec: 'B0.5' }, // differs from the spec table (corrected); variable 1.6–3.0 (B0.5IVe)
  Ruchbah:      { ra: 1.43,  dec: 60.24,  mag: 2.68, spec: 'A5' },
  Segin:        { ra: 1.91,  dec: 63.67,  mag: 3.35, spec: 'B3' },

  // ── SCORPIUS (7) ─────────────────────────────────────────────────────────
  Graffias:     { ra: 16.09, dec: -19.81, mag: 2.62, spec: 'B1' },
  Dschubba:     { ra: 16.01, dec: -22.62, mag: 2.32, spec: 'B0' },
  Antares:      { ra: 16.49, dec: -26.43, mag: 1.09, spec: 'M1' }, // differs from the spec table (corrected); variable 0.6–1.6
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
 * The 8 stick figures. `stars` are keys into BRIGHT_STARS; `lines` are index
 * pairs into that figure's own `stars` array. Not named CONSTELLATIONS: that
 * name means satellite constellations (data/constellations.json, CatalogLoader.js).
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

// Faint-field magnitude model: Starfield._create and its test share these.

/**
 * Inverse-CDF sample of the field magnitude distribution. Counts rise toward
 * the faint end (log N ∝ 0.6·m, the real star-count law).
 * @param {number} u — uniform random in [0,1)
 * @returns {number} magnitude in [mMin, mMax]
 */
export function sampleFieldMagnitude(u, mMin, mMax) {
  const denom = Math.pow(10, 0.6 * (mMax - mMin)) - 1;
  return mMin + Math.log10(1 + u * denom) / 0.6;
}

/**
 * Catalogue-star brightness: the visual-magnitude curve with a soft knee at
 * the floor. Shared with the test: Constants.STAR_FIELD_BRIGHT must stay
 * strictly below the faintest catalogue star's peak.
 *
 * Above the knee (`min`) the raw exponential is used verbatim (Rigel 2.0,
 * Deneb 0.79, …). A hard clamp below it would flatten 32 of the 49 stars
 * (fainter than mag ~1.87) to one brightness, so the soft knee maps
 * raw ∈ (0, min) onto [min·soft, min): continuous at the knee, strictly
 * monotone, asymptotic to min·soft = 0.3825 (above the field's 0.32).
 *
 * ⚠ INTERNAL HALF OF THE CURVE — DO NOT CALL FROM RENDERING CODE.
 * Its ceiling is a HARD clamp, which flattens bright bodies (it flattened the
 * planets, F5). Rendering code must call `skyBrightness`. test-sky-one-curve.js
 * fails if any non-test module outside this file calls this function.
 *
 * @param {number} mag — visual magnitude
 * @param {number} min — knee (Constants.STAR_MAG_BRIGHT_MIN)
 * @param {number} max — HARD ceiling (Constants.STAR_MAG_BRIGHT_MAX, bloom-coupled)
 * @param {number} soft — sub-knee asymptote ratio (Constants.STAR_MAG_BRIGHT_FLOOR_SOFT)
 * @returns {number} brightness multiplier in [min·soft, max] — CLAMPED at max
 */
export function magnitudeBrightnessBelowCeiling(mag, min, max, soft) {
  const raw = Math.pow(10, -0.4 * (mag - 1.0));
  if (raw >= min) return Math.min(raw, max);
  return min * lerp(soft, 1, raw / min);
}

// THE ONE BRIGHTNESS CURVE FOR THE WHOLE SKY (stars AND bodies)
//
// The hard ceiling of magnitudeBrightnessBelowCeiling flattens the planets
// (raw Venus 145, Jupiter 19, Mars 10, Mercury 3.6) to 2.0 (F5). Soft ceiling:
// above `max`, grow logarithmically so ordering survives:
//
//     B(m) = max · (1 + hardness · log10(raw / max))      for raw > max
//
// With hardness = 0.20 (values from the curve):
//
//     Venus −4.4 → 2.74 (blooms — the ONLY planet allowed to, D3)
//     Jupiter −2.2 → 2.39
//     Mars −1.5 → 2.28
//     Mercury −0.4 → 2.10
//     Rigel +0.13 → 2.019
//     Saturn +0.5 → 1.58
//     Eta Leo +3.49 → 0.398
//     field 4.4–7.0 → 0.32 constant
//
// Bloom coupling: the threshold is 2.5 (SceneManager). Only the Sun and Venus
// may cross it. Rigel's 2.019 × uOpacity 0.95 = 1.92, safely below.
//
/** Soft-ceiling hardness: log10 slope of growth past `max`. */
export const SKY_BRIGHT_CEILING_HARDNESS = 0.20;

/**
 * The whole-sky brightness function — THE ONE RENDERING CODE MUST USE.
 * Identical to magnitudeBrightnessBelowCeiling below `max`, logarithmic above,
 * so stars and bodies (Starfield, the body ladder) share one curve.
 *
 * @param {number} min — soft-knee floor (Constants.STAR_MAG_BRIGHT_MIN)
 * @param {number} max — soft ceiling (Constants.STAR_MAG_BRIGHT_MAX, bloom-coupled)
 * @param {number} soft — sub-knee asymptote ratio (Constants.STAR_MAG_BRIGHT_FLOOR_SOFT)
 * @returns {number} brightness multiplier in (min·soft, ∞), strictly monotone in mag
 */
export function skyBrightness(mag, min, max, soft, hardness = SKY_BRIGHT_CEILING_HARDNESS) {
  const raw = Math.pow(10, -0.4 * (mag - 1.0));
  if (raw > max) return max * (1 + hardness * Math.log10(raw / max));
  return magnitudeBrightnessBelowCeiling(mag, min, max, soft);
}

/**
 * Size follows `base − slope·mag` but never below `floor`; once pinned, alpha
 * carries the faintness (linear from 1.0 at the floor crossing to `alphaMin`
 * at `mMax`).
 */
export function fieldSizeAlpha(mag, mMax, { base, slope, floor, alphaMin }) {
  const curveSize = base - slope * mag;
  if (curveSize >= floor) return { size: curveSize, alpha: 1.0 };
  const magAtFloor = (base - floor) / slope;
  const t = clamp01((mag - magAtFloor) / (mMax - magAtFloor));
  return { size: floor, alpha: lerp(1.0, alphaMin, t) };
}

// GALACTIC FRAME — pure {x,y,z} math on the REAL galactic basis, so the band
// runs through the galactic center (Sagittarius), Cygnus and Cassiopeia.

// Same convention as Starfield.raDec2xyz: +Y celestial north, RA 0 at +X, Z negated.
function raDecToUnit(raHours, decDeg) {
  const ra = raHours * (Math.PI / 12);
  const dec = decDeg * DEG2RAD;
  return {
    x: Math.cos(dec) * Math.cos(ra),
    y: Math.sin(dec),
    z: -Math.cos(dec) * Math.sin(ra),
  };
}
export { raDecToUnit };
const vdot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const vcross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const vlen = (a) => Math.hypot(a.x, a.y, a.z);
const vnorm = (a) => { const l = vlen(a) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };

/** Galactic north pole, J2000 (RA 12.85h, Dec +27.13°). */
export const GALACTIC_NORTH_POLE = { ra: 12.85, dec: 27.13 };
/** Galactic center, J2000 (RA 17.76h, Dec −28.9°, in Sagittarius). Longitude 0. */
export const GALACTIC_CENTER = { ra: 17.76, dec: -28.9 };

/**
 * The galactic frame: three orthonormal unit vectors as plain {x,y,z}.
 *   pole   — galactic north pole (+b)
 *   center — galactic center direction (l = 0)
 *   e2     — l = 90°, toward Cygnus (band: center → Cygnus → anticenter → Cassiopeia)
 * Right-handed: center × e2 = pole.
 */
export function galacticBasis() {
  const pole = vnorm(raDecToUnit(GALACTIC_NORTH_POLE.ra, GALACTIC_NORTH_POLE.dec));
  const center = vnorm(raDecToUnit(GALACTIC_CENTER.ra, GALACTIC_CENTER.dec));
  const e2 = vnorm(vcross(pole, center));   // l=90 direction (toward Cygnus)
  return { pole, center, e2 };
}

/**
 * Galactic longitude of a unit {x,y,z} direction, from the galactic center
 * toward e2 (Cygnus). Radians in (−π, π].
 */
export function galacticLongitude(dir, basis = galacticBasis()) {
  return Math.atan2(vdot(dir, basis.e2), vdot(dir, basis.center));
}

/** Galactic latitude of a unit {x,y,z} direction, radians (−π/2..π/2). */
export function galacticLatitude(dir, basis = galacticBasis()) {
  return Math.asin(Math.max(-1, Math.min(1, vdot(dir, basis.pole))));
}

/**
 * Longitudinal density profile: peaks at the galactic center (L=0), fades to
 * the anticenter (L=π, Gemini). profile(0) = contrast, profile(π) = 1. The real
 * contrast is larger; `contrast` (~2) is a LICENSED exaggeration so the
 * structure reads at a glance without the anticenter vanishing.
 * @param {number} L — galactic longitude (radians)
 * @param {number} contrast — center:anticenter ratio (≥1)
 * @returns {number} profile value in [1, contrast]
 */
export function mwCenterProfile(L, contrast) {
  return ((contrast + 1) + (contrast - 1) * Math.cos(L)) / 2;
}

/**
 * Great Rift density mask: a dark lane along the band from Cygnus to
 * Sagittarius; points are SKIPPED inside it (negative space beats painted
 * black). 1 outside the lane, ramping to p.depth at its centre. The lane sits
 * `offset` radians off the plane and spans `longMin..longMax`.
 * @param {number} L — galactic longitude (radians, in [−π,π])
 * @param {number} latOff — latitude offset of the point off the plane (radians)
 * @param {{ longMin: number, longMax: number, offset: number, width: number, edge: number }} p
 * @returns {number} density multiplier in [0,1]
 */
export function mwGreatRiftMask(L, latOff, p) {
  if (L < p.longMin || L > p.longMax) return 1;
  // The rift broadens from the compact Northern Coalsack (Cygnus) to widest
  // near l ≈ 15° (Ophiuchus/Sagittarius); a fixed width can't express that.
  const g = (L - p.broadenLong) / Math.max(1e-6, p.broadenWidth);
  const width = p.width * lerp(1, p.broaden, Math.exp(-g * g));
  const d = Math.abs(latOff - p.offset) / width;
  if (d >= 1) return 1;
  // `depth` is the residual core density: dust obscuration, not a hole.
  const t = Math.min(1, d / Math.max(1e-6, p.edge));
  const ramp = smoothstep01(t);   // smoothstep
  return lerp(p.depth, 1, ramp);
}

/**
 * Cygnus star-cloud density boost around the Cygnus longitude.
 * @param {number} L — galactic longitude (radians)
 * @returns {number} density multiplier ≥ 1
 */
export function mwCygnusBoost(L, p) {
  const d = (L - p.long) / p.width;
  return lerp(1, p.boost, Math.exp(-d * d));
}

/**
 * The band's COMPOSED longitudinal density (profile × Cygnus boost),
 * normalized so the galactic centre is exactly 1.0 and the value is directly a
 * rejection-sampling acceptance probability. The builder and test-milkyway
 * both use this one function, so the test checks the composed density, not one
 * factor of it.
 *
 * It is ≤ 1 everywhere IFF the centre is the maximum, so "Sagittarius is the
 * brightest part of the band" and the sampler's correctness are one condition.
 * That pins the constants: the profile has already fallen to ~0.79 at the
 * Cygnus longitude, so a boost above 1/0.79 ≈ 1.26 out-densifies the centre.
 * Raising MW_CENTER_CONTRAST can't help (that term asymptotes near 0.585
 * there; it would need contrast above 130).
 *
 * @param {number} L — galactic longitude (radians, in [−π, π])
 * @param {number} contrast — Constants.MW_CENTER_CONTRAST
 * @param {{ long: number, width: number, boost: number }} cygnus — the Cygnus params
 * @returns {number} density in (0, 1], equal to 1 at the galactic centre
 */
export function mwDensity(L, contrast, cygnus) {
  const structure = mwCenterProfile(L, contrast) / contrast;   // (1/contrast .. 1]
  return structure * mwCygnusBoost(L, cygnus);
}
