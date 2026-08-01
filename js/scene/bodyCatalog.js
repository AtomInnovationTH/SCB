/**
 * bodyCatalog.js — the Sun, Moon and five naked-eye planets as pure data plus
 * the math that turns their angular sizes and magnitudes into world radii and
 * HDR brightness multipliers.
 *
 * Pure data, no `three` import, no DOM — the same contract that keeps
 * starCatalog.js testable as a plain node module. The texture factories
 * (createMoonDiscTexture and friends) call document.createElement('canvas'),
 * so they must NEVER be imported here: bodies carry a string `textureKey` and
 * SunLight maps key → factory. One reference would make this module
 * un-loadable in node and kill the tests.
 *
 * This module is the single source of truth for the body half of the sky
 * ladder: the planets' magnitudes, their real and displayed angular sizes, and
 * (via the shared brightness curve below) their place on the one brightness
 * function the whole sky shares with the stars.
 *
 * @module scene/bodyCatalog
 */

import { skyBrightness } from './starCatalog.js';

// ============================================================================
// THE ONE BRIGHTNESS CURVE FOR THE WHOLE SKY
// ============================================================================
//
// The shared curve lives in starCatalog.js as `skyBrightness` (soft knee at the
// bottom, soft ceiling at the top, hardness 0.20) — one home so stars and
// bodies can never diverge. This module re-exports it so the body ladder and
// its test read it from the catalogue they already import. See starCatalog.js
// for the full derivation and the rung table (Venus 2.74 blooms, Jupiter 2.39,
// Mars 2.28, Mercury 2.10, Rigel 2.019, Saturn 1.58).
export { skyBrightness };

// ============================================================================
// GEOMETRY / PHASE HELPERS
// ============================================================================

/**
 * World-space radius for a body of angular diameter `deg` at distance `dist`.
 * radius = dist · tan(θ/2). The one formula every body size derives from, so a
 * size change can never silently desync disc, glow, depth mask and label.
 * @param {number} deg — angular diameter in degrees
 * @param {number} dist — world distance to the body
 * @returns {number} world radius
 */
export function angularToRadius(deg, dist) {
  return dist * Math.tan((deg * Math.PI / 180) / 2);
}

/**
 * Angular diameter in degrees for a world radius at a distance — the inverse
 * of angularToRadius, for tests and the capture hooks.
 * @param {number} radius — world radius
 * @param {number} dist — world distance to the body
 * @returns {number} angular diameter in degrees
 */
export function radiusToAngular(radius, dist) {
  return 2 * Math.atan(radius / dist) * 180 / Math.PI;
}

/**
 * Illuminated fraction of the Moon's disc from the Sun–Moon elongation cosine.
 * elongationCos = sunDir · moonDir: +1 with the Moon beside the Sun (new, dark),
 * −1 opposite (full, lit). fraction = (1 − cosθ) / 2.
 * @param {number} elongationCos — cos of the Sun–Moon elongation
 * @returns {number} illuminated fraction in [0, 1]
 */
export function phaseIlluminatedFraction(elongationCos) {
  return (1 - elongationCos) * 0.5;
}

// ============================================================================
// THE BODY CATALOGUE
// ============================================================================
//
// { name, magnitude, realAngularDeg, displayAngularDeg, textureKey }
//
//   magnitude         — representative visual magnitude. Licensed: planets vary
//                       with elongation and ring tilt; the chosen value is the
//                       typical favourable one, documented per body.
//   realAngularDeg    — the true angular diameter from LEO (truthful; the
//                       exaggeration factor lives in the ratio, not hidden).
//   displayAngularDeg — the on-screen angular diameter (licensed exaggeration,
//                       monotone in the underlying quantity per doctrine B).
//   textureKey        — string key SunLight maps to a texture factory; NEVER
//                       the factory itself (see the module header).
//
// Stage 1 note: `displayAngularDeg` records the CURRENT rendered sizes (the
// inverted ladder — planets out-size the Moon, F4) so SunLight behaves
// identically when it switches to this table. Stage 5 rewrites the display
// column to the resolved D1 ladder (Moon stays ~1.5° per D2; Saturn keeps a
// small ringed disc as the ONE licensed size inversion; the other four planets
// drop onto the extended star size ladder) and parks the jupiter/mars detail
// textures (their detail cannot survive 6–7 px — telescope-feature material).
export const BODY_CATALOG = [
  {
    name: 'Sun',
    magnitude: -26.74,
    realAngularDeg: 0.533,
    displayAngularDeg: 1.49,      // Stage 4: parity with the Moon (real 0.533° vs
                                  // 0.518° = within 3%). The glare sprite AND the
                                  // depth mask both derive from this one value so
                                  // they can never desync (that desync was F6:
                                  // glare 1.91° vs mask 1.15° let stars show
                                  // inside the glare). Was 1.15° (core only).
    textureKey: 'sun',
  },
  {
    name: 'Moon',
    magnitude: -12.7,             // full moon
    realAngularDeg: 0.518,
    displayAngularDeg: 1.49,      // D2: stays ~1.5° — fix contrast and phase, not size
    textureKey: 'moon',
  },
  {
    name: 'Venus',
    magnitude: -4.4,              // at greatest elongation; the brightest planet
    realAngularDeg: 0.008,
    displayAngularDeg: 0.58,      // Stage 5 (D1): ~9–10 px, the only blooming planet
    textureKey: null,             // flat warm-white disc
  },
  {
    name: 'Jupiter',
    magnitude: -2.2,
    realAngularDeg: 0.008,
    displayAngularDeg: 0.43,      // Stage 5 (D1): ~7 px
    textureKey: null,             // PARKED — band detail can't survive 7 px
                                  // (createJupiterTexture stays exported as
                                  // telescope-feature material, unused here)
  },
  {
    name: 'Mars',
    magnitude: -1.5,              // favourable opposition; varies widely
    realAngularDeg: 0.004,
    displayAngularDeg: 0.37,      // Stage 5 (D1): ~6 px
    textureKey: null,             // PARKED — cap/detail can't survive 6 px
                                  // (createMarsTexture stays exported, unused)
  },
  {
    name: 'Mercury',
    magnitude: -0.4,              // at greatest elongation
    realAngularDeg: 0.002,
    displayAngularDeg: 0.31,      // Stage 5 (D1): ~5 px
    textureKey: null,             // already flat
  },
  {
    name: 'Saturn',
    magnitude: 0.5,               // DIMMER than Rigel (+0.13) — truthfully so
    realAngularDeg: 0.005,
    displayAngularDeg: 0.374,     // Stage 5 (D1): globe ~6 px. NOT independently
                                  // chosen — the REAL ring radii (A ring outer =
                                  // 2.27 Saturn radii) fix globe = span/2.27, so
                                  // a 0.85° span lands the globe here. (The plan
                                  // table's "globe 0.19°" is incompatible with
                                  // span 0.85° under real ratios; D1's "globe
                                  // ~0.2° (a 3 px dot would waste it)" is the
                                  // floor, and 6 px clears it.)
    textureKey: 'saturn',         // rings are low-frequency and survive minification
    // Ring span ~0.85° (~14 px) — the ONE licensed size inversion (span is ring
    // geometry, not body size, and Saturn's brightness stays truthfully below
    // Rigel). Rendered on a planeSize-7.6 plane; the drawn rings fill 0.86 of it.
    ringSpanAngularDeg: 0.85,
  },
];

/** Look up a body by name. @returns {object|undefined} */
export function bodyByName(name) {
  return BODY_CATALOG.find((b) => b.name === name);
}
