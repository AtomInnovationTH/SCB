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
//   laddered          — whether the body's RENDERED peak follows the brightness
//                       ladder B(mag) as an HDR colour multiplier. True for the
//                       five planets (Stage 5). FALSE for the Sun and Moon: both
//                       are deliberately OFF the ladder and render LDR (sun
//                       sprite ≤ 0.95 additive, moon disc ≤ 0.85), because their
//                       true magnitudes (−26.7, −12.7) would put them at B 6.3
//                       and 4.1 — enough to blow the frame and to make the Moon
//                       bloom, which it must never do. Their magnitudes are kept
//                       for truthfulness and for the phase/ladder tests, NOT as
//                       a render input. This flag is what lets the bloom gate ask
//                       "which bodies can actually cross the threshold?" without
//                       hardcoding a body name (see ladderBloomBodies below).
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
    laddered: false,              // LDR sprite (0.95 additive) — see the `laddered` note
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
    laddered: false,              // LDR disc (0.85) — the Moon must never bloom
    displayAngularDeg: 1.49,      // D2: stays ~1.5° — fix contrast and phase, not size
    textureKey: 'moon',
  },
  {
    name: 'Venus',
    magnitude: -4.4,              // at greatest elongation; the brightest planet
    realAngularDeg: 0.008,
    laddered: true,
    displayAngularDeg: 0.58,      // Stage 5 (D1): ~9–10 px, the only blooming planet
    textureKey: null,             // flat warm-white disc
  },
  {
    name: 'Jupiter',
    magnitude: -2.2,
    realAngularDeg: 0.008,
    laddered: true,
    displayAngularDeg: 0.54,      // 9.06 px — the Red Spot (drawn 22% of the disc
                                  // width) reaches 2.0 px and the three bands 2.0 px
                                  // each. Still under Venus 0.58, so no ladder rule
                                  // breaks. Was 0.43 ("band detail can't survive
                                  // 7 px" — true of the OLD 8-band texture, not the
                                  // 3-band one).
    textureKey: 'jupiter',
  },
  {
    name: 'Mars',
    magnitude: -1.5,              // favourable opposition; varies widely
    realAngularDeg: 0.004,
    laddered: true,
    displayAngularDeg: 0.37,      // Stage 5 (D1): ~6 px
    textureKey: null,             // DELIBERATELY FLAT — and this was re-confirmed the
                                  // hard way. A three-stripe version (polar cap / dark
                                  // band / rust) was switched on and rejected on sight
                                  // as "red and yellow": at 6 px the stripes read as a
                                  // garish two-tone flag, and worse, the ×2.28 ladder
                                  // multiplier drove the blue-white cap through ACES to
                                  // rgb(255,191,242) — PINK, because red clips at 255
                                  // while blue survives. Mars has no naked-eye detail to
                                  // show; the honest render is a single red ember, so the
                                  // original author's null here was right. createMarsTexture
                                  // stays exported but parked (telescope-view material).
  },
  {
    name: 'Mercury',
    magnitude: -0.4,              // at greatest elongation
    realAngularDeg: 0.002,
    laddered: true,
    displayAngularDeg: 0.31,      // Stage 5 (D1): ~5 px
    textureKey: null,             // already flat
  },
  {
    name: 'Saturn',
    magnitude: 0.5,               // DIMMER than Rigel (+0.13) — truthfully so
    realAngularDeg: 0.005,
    laddered: true,
    displayAngularDeg: 0.4846,    // globe ~8 px. NOT independently chosen — the
                                  // REAL ring radii (A ring outer = 2.27 Saturn
                                  // radii) fix globe = span/2.27, so the 1.1°
                                  // span lands the globe here. Still under
                                  // Jupiter's 0.54°, so no ordering breaks.
    textureKey: 'saturn',         // rings are low-frequency and survive minification
    // Ring span 1.1° (~18.5 px) — the ONE licensed size inversion (span is ring
    // geometry, not body size, and Saturn's brightness stays truthfully below
    // Rigel). Grown from 0.85°: at 0.85° each ring was 1.6 px and, with the ring
    // hole hidden behind the globe, the whole planet read as a solid bright
    // diamond. 1.1° opens the hole at the ansae and gives ~1.5 px rings.
    ringSpanAngularDeg: 1.1,
  },
];

/** Look up a body by name. @returns {object|undefined} */
export function bodyByName(name) {
  return BODY_CATALOG.find((b) => b.name === name);
}

/**
 * Names of the bodies that can actually cross the bloom threshold — i.e. the
 * bodies whose rendered peak rides the ladder (`laddered`) AND whose B(mag)
 * exceeds `threshold`. With the shipped constants this is exactly `['Venus']`
 * (B 2.74 > 2.5); every other rung stays under (D3).
 *
 * This exists so the BLOOM GATE can be derived instead of hardcoded. The gate
 * (SunLight.isBloomSourceVisible → SceneManager.setBloomEnabled) skips the whole
 * UnrealBloom mip chain when nothing above the threshold is on screen. It was
 * originally sun-only, on the premise that "every source that can cross the
 * threshold is sun-driven" — true until Stage 5 gave the planets HDR
 * multipliers, at which point Venus became a threshold-crossing source whose
 * visibility is INDEPENDENT of the sun's. A sun-only gate therefore switched
 * bloom off in exactly the case D3 exists for: Venus clear of the limb with the
 * sun behind it (the evening/morning-star case).
 *
 * Deriving the list from the curve + the threshold means a magnitude retune, a
 * curve change or a threshold change automatically extends or shrinks the gate:
 * push Jupiter past 2.5 and it becomes a gate source without touching SunLight.
 *
 * The Sun is handled separately by the gate (it is `laddered: false` and LDR, so
 * it never appears here) because its own visibility already drives the
 * sun-driven sources that DO bloom — the atmosphere's Mie limb and ocean glint.
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
