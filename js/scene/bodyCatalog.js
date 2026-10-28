/**
 * bodyCatalog.js — the Sun, Moon and five naked-eye planets as pure data, plus
 * the math from angular sizes and magnitudes to world radii.
 *
 * Pure data, no `three` import, no DOM (so it loads in node like starCatalog.js).
 * The texture factories call document.createElement('canvas') and must NEVER be
 * imported here: bodies carry a string `textureKey` and SunLight maps key →
 * factory.
 *
 * @module scene/bodyCatalog
 */

import { skyBrightness } from './starCatalog.js';

// The shared brightness curve lives in starCatalog.js as `skyBrightness` (one
// home so stars and bodies can't diverge); re-exported for the body ladder.
export { skyBrightness };

/**
 * World radius for a body of angular diameter `deg` at distance `dist`:
 * dist · tan(θ/2). Every body size derives from this, so disc, glow, depth mask
 * and label can't desync.
 */
export function angularToRadius(deg, dist) {
  return dist * Math.tan((deg * Math.PI / 180) / 2);
}

/** Inverse of angularToRadius: angular diameter in degrees. */
export function radiusToAngular(radius, dist) {
  return 2 * Math.atan(radius / dist) * 180 / Math.PI;
}

/**
 * Illuminated fraction of the Moon's disc from the Sun–Moon elongation cosine
 * (sunDir · moonDir: +1 new, −1 full): (1 − cosθ) / 2.
 */
export function phaseIlluminatedFraction(elongationCos) {
  return (1 - elongationCos) * 0.5;
}

// { name, magnitude, realAngularDeg, displayAngularDeg, laddered, textureKey }
//
//   magnitude         — representative visual magnitude (planets vary with
//                       elongation and ring tilt; the typical favourable value).
//   realAngularDeg    — true angular diameter from LEO.
//   displayAngularDeg — on-screen angular diameter (licensed exaggeration).
//   laddered          — whether the RENDERED peak follows the brightness ladder
//                       B(mag) as an HDR multiplier. True for the five planets.
//                       FALSE for Sun and Moon: deliberately OFF the ladder, since
//                       their true magnitudes (−26.7, −12.7) would give B 6.3 and
//                       4.1 and make the Moon bloom, which it must never do. The
//                       Moon is an LDR disc (opacity ≤ 0.85, Constants.MOON_BASE_OPACITY);
//                       the Sun has a fixed HDR core (Constants.SUN_HDR_PEAK 3.0, see
//                       SunLight._createSunDisc) so it blooms. Their magnitudes are
//                       not a render input. The bloom gate reads this flag instead
//                       of hardcoding names (ladderBloomBodies).
//   textureKey        — string key SunLight maps to a texture factory; NEVER the
//                       factory itself.
//
// Display sizes: the Moon stays ~1.5°; Saturn keeps a small ringed disc as the
// ONE licensed size inversion; the other planets sit on the extended star size
// ladder. Jupiter/Mars detail textures are parked (detail can't survive 6–7 px).
export const BODY_CATALOG = [
  {
    name: 'Sun',
    magnitude: -26.74,
    realAngularDeg: 0.533,
    laddered: false,              // off the ladder; fixed HDR core (SUN_HDR_PEAK)
    displayAngularDeg: 1.49,      // parity with the Moon (real 0.533° vs 0.518°); glare sprite AND depth mask derive from this one value
    textureKey: 'sun',
  },
  {
    name: 'Moon',
    magnitude: -12.7,             // full moon
    realAngularDeg: 0.518,
    laddered: false,              // LDR disc (0.85) — the Moon must never bloom
    displayAngularDeg: 1.49,
    textureKey: 'moon',
  },
  {
    name: 'Venus',
    magnitude: -4.4,              // at greatest elongation; the brightest planet
    realAngularDeg: 0.008,
    laddered: true,
    displayAngularDeg: 0.58,      // ~9–10 px, the only blooming planet
    textureKey: null,             // flat warm-white disc
  },
  {
    name: 'Jupiter',
    magnitude: -2.2,
    realAngularDeg: 0.008,
    laddered: true,
    displayAngularDeg: 0.54,      // 9.06 px: Red Spot 2.0 px, each of 3 bands 2.0 px; under Venus 0.58
    textureKey: 'jupiter',
  },
  {
    name: 'Mars',
    magnitude: -1.5,              // favourable opposition; varies widely
    realAngularDeg: 0.004,
    laddered: true,
    displayAngularDeg: 0.37,      // ~6 px
    textureKey: null,             // DELIBERATELY FLAT: a striped texture read as a garish two-tone flag at 6 px, and the ×2.28 ladder multiplier drove the blue-white cap through ACES to PINK (rgb 255,191,242: red clips, blue survives). createMarsTexture stays exported but parked.
  },
  {
    name: 'Mercury',
    magnitude: -0.4,              // at greatest elongation
    realAngularDeg: 0.002,
    laddered: true,
    displayAngularDeg: 0.31,      // ~5 px
    textureKey: null,             // already flat
  },
  {
    name: 'Saturn',
    magnitude: 0.5,               // DIMMER than Rigel (+0.13) — truthfully so
    realAngularDeg: 0.005,
    laddered: true,
    displayAngularDeg: 0.4846,    // globe ~8 px; NOT independent: real A-ring outer = 2.27 globe radii, so the 1.1° span fixes globe = span/2.27
    textureKey: 'saturn',         // rings are low-frequency and survive minification
    // Ring span 1.1° (~18.5 px): the ONE licensed size inversion. Smaller spans
    // hid the ring hole behind the globe and Saturn read as a solid diamond.
    ringSpanAngularDeg: 1.1,
  },
];

export function bodyByName(name) {
  return BODY_CATALOG.find((b) => b.name === name);
}

/**
 * Names of the bodies that can cross the bloom threshold: `laddered` AND
 * B(mag) > `threshold`. Shipped constants give exactly `['Venus']` (B 2.74 > 2.5).
 *
 * Derives the BLOOM GATE (SunLight.isBloomSourceVisible →
 * SceneManager.setBloomEnabled) instead of hardcoding it: Venus is a
 * threshold-crosser whose visibility is independent of the sun's, so a sun-only
 * gate would switch bloom off for an evening star. A retune of magnitudes, curve
 * or threshold extends or shrinks the list automatically. The Sun is handled
 * separately (`laddered: false`, never listed here).
 *
 * @param {number} threshold — Constants.BLOOM_THRESHOLD
 * @param {number} min — Constants.STAR_MAG_BRIGHT_MIN
 * @param {number} max — Constants.STAR_MAG_BRIGHT_MAX
 * @param {number} soft — Constants.STAR_MAG_BRIGHT_FLOOR_SOFT
 * @returns {string[]} body names, brightest first
 */
export function ladderBloomBodies(threshold, min, max, soft) {
  return BODY_CATALOG
    .filter((b) => b.laddered && skyBrightness(b.magnitude, min, max, soft) > threshold)
    .sort((a, b) => a.magnitude - b.magnitude)
    .map((b) => b.name);
}
