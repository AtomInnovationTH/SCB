/**
 * bodyGeometry.js — every DERIVED dimension of the naked-eye bodies: disc radii,
 * depth-mask radii, glow-halo radii, and Saturn's ring-mask ellipse.
 *
 * WHY THIS MODULE EXISTS
 * The sky cleanup's worst recurring defect class was a mask and its body drifting
 * apart: F6 was the Sun's glare (1.91°) sitting far outside its depth mask
 * (1.15°) so stars showed inside the glare, and F7 was Saturn's mask covering
 * only the globe while stars shone through the rings. Both were fixed by hand,
 * one body at a time — and a later audit found the same class still latent in
 * two more places (the Moon's mask radius was an independent literal, and the
 * sun mask was sized to the sprite SQUARE rather than to the visibly glowing
 * part of its texture) because nothing could assert the relationships. The
 * numbers lived inline in a 1500-line renderer module that imports `three` and
 * builds canvas textures, so no test could reach them.
 *
 * Everything here is pure arithmetic over plain numbers: no `three`, no DOM, no
 * canvas. That is the whole point — `SunLight` becomes a consumer that only
 * constructs meshes, and the couplings ("a mask must cover its body's visible
 * extent but never exceed its geometric disc") are finally assertable in a plain
 * node test. See test-bodyGeometry.js.
 *
 * The rule this module enforces, stated once:
 *
 *   visibleExtent ≤ maskExtent ≤ geometricExtent
 *
 * Too small a mask lets stars shine through solid bodies. Too large a mask
 * deletes stars from empty sky — an invisible hole, which is the subtler bug
 * because a "zero stars inside the mask" acceptance test passes trivially once
 * the mask covers everything.
 *
 * @module scene/bodyGeometry
 */

import { angularToRadius, radiusToAngular } from './bodyCatalog.js';

// ============================================================================
// SUN GLARE TEXTURE PROFILE — the ONE definition
// ============================================================================
//
// The radial alpha stops of createSunDiscTexture's gradient. They live HERE, not
// only inside the texture factory, because the depth mask has to know how far
// the sprite actually glows: the sprite's geometric square extends to r=1.0
// where alpha is ZERO, so sizing the mask to the sprite over-masks a ring of
// empty sky. Keeping the stops next to the mask math means changing the gradient
// automatically moves the mask (and fails a test if it stops covering the glare).
//
// createSunDiscTexture reads these to draw the gradient, so there is exactly one
// copy of the numbers.
/** @type {{r: number, a: number}[]} radial alpha stops, r normalized to the sprite half-width */
export const SUN_GLARE_STOPS = [
  { r: 0.00, a: 1.00 },
  { r: 0.55, a: 0.95 },   // white-hot core edge
  { r: 0.75, a: 0.25 },   // glow skirt
  { r: 1.00, a: 0.00 },   // fully transparent rim — masking out here hides stars for nothing
];

/**
 * Alpha of the glare texture at normalized radius `r`, by linear interpolation
 * between the stops (exactly what a canvas radial gradient does).
 * @param {number} r — normalized radius (0 = centre, 1 = sprite half-width)
 * @param {{r: number, a: number}[]} [stops]
 * @returns {number} alpha in [0, 1]
 */
export function glareAlphaAt(r, stops = SUN_GLARE_STOPS) {
  if (r <= stops[0].r) return stops[0].a;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    if (r <= b.r) {
      const t = (r - a.r) / (b.r - a.r);
      return a.a + (b.a - a.a) * t;
    }
  }
  return stops[stops.length - 1].a;
}

/**
 * The normalized radius at which the glare's alpha falls to `alphaFloor` — i.e.
 * how much of the sprite is VISIBLY glowing. This is the correct extent for the
 * depth mask: beyond it the sprite contributes less than a perceptible amount,
 * so occluding stars there would be masking empty sky.
 *
 * With the shipped stops and a 0.10 floor this returns 0.90, so the mask covers
 * 90% of the sprite instead of 100% — the trim that removes the starless ring.
 *
 * @param {number} alphaFloor — the perceptibility floor (Constants.SUN_GLARE_VISIBLE_ALPHA)
 * @param {{r: number, a: number}[]} [stops]
 * @returns {number} normalized radius in (0, 1]
 */
export function glareVisibleFraction(alphaFloor, stops = SUN_GLARE_STOPS) {
  // Walk outward and find where the profile crosses the floor. Monotone
  // decreasing by construction, so the first crossing is the answer.
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    if (b.a <= alphaFloor && a.a > alphaFloor) {
      const t = (a.a - alphaFloor) / (a.a - b.a);
      return a.r + (b.r - a.r) * t;
    }
  }
  return stops[stops.length - 1].r;
}

// ============================================================================
// SATURN RING SYSTEM — the ONE definition
// ============================================================================
//
// Real ring proportions in units of the globe radius. createSaturnTexture draws
// with these AND the elliptical depth mask is built from them (F7), so they must
// be one definition or the mask stops matching the drawn rings.
export const SATURN_RING = {
  globeFraction: 0.19,   // globe radius as a fraction of the texture's half-width
  outer: 2.27,           // A ring outer edge, in globe radii (real value)
  inner: 1.52,           // B ring INNER edge, in globe radii (real value). Was 1.24 —
                         // the C ring's inner edge — which was left behind when the
                         // faint C ring was dropped as sub-pixel. That inconsistency is
                         // what made Saturn read as a solid diamond: with the ring plane
                         // squashed to 0.36, an annulus starting at 1.24 has its hole
                         // (1.24 × 0.36 = 0.45 globe radii tall) entirely hidden behind
                         // the globe, so globe and rings fused into one convex lozenge.
                         // At the real B-ring edge the hole clears the globe and the
                         // ansae show sky — the strongest "this is a ring" cue there is.
  tilt: -0.34,           // ring-plane tilt (rad) — "wide open" classic view
  squash: 0.36,          // ring opening (minor/major)
  // Two bands, inner→outer, in globe radii. The real system has four parts (C
  // ring, B ring, Cassini Division, A ring) and all four are sub-pixel at this
  // size, so they averaged into one flat smear. Kept: the bright B ring and the
  // dimmer A ring, split at the midpoint. The contrast comes from DARKENING the
  // outer band — the inner one is already near the top of the tone curve, where
  // an opacity change of 0.92 → 1.0 moves it by about one byte value.
  get bands() {
    const mid = (this.inner + this.outer) / 2;
    return [
      { rIn: this.inner, rOut: mid,        rgb: '232, 214, 176', alpha: 0.92 }, // B ring
      { rIn: mid,        rOut: this.outer, rgb: '138, 122,  94', alpha: 0.45 }, // A ring
    ];
  },
  // Fraction of the square texture the drawn rings actually span:
  // 2 × outer × globeFraction. The plan's trap 2 — the rings do NOT fill the
  // texture, so the plane must be sized larger than the intended ring span.
  get spanFraction() { return 2 * this.outer * this.globeFraction; },
};

// ============================================================================
// PER-BODY DERIVED GEOMETRY
// ============================================================================

/**
 * Sun: glare sprite + depth mask, both derived from one angular size (F6) with
 * the mask trimmed to the visibly glowing extent rather than the sprite square.
 * @param {object} p
 * @param {number} p.displayAngularDeg — from BODY_CATALOG
 * @param {number} p.dist — Constants.SUN_DIST
 * @param {number} p.maskDist — Constants.BODY_DEPTH_MASK_DIST
 * @param {number} p.visibleAlpha — Constants.SUN_GLARE_VISIBLE_ALPHA
 * @returns {{radius: number, spriteScale: number, maskRadius: number,
 *            visibleFraction: number, visibleAngularDeg: number, maskAngularDeg: number}}
 */
export function sunGeometry({ displayAngularDeg, dist, maskDist, visibleAlpha }) {
  const radius = angularToRadius(displayAngularDeg, dist);
  const visibleFraction = glareVisibleFraction(visibleAlpha);
  const visibleRadius = radius * visibleFraction;
  const maskRadius = visibleRadius * (maskDist / dist);
  return {
    radius,
    spriteScale: radius * 2,                 // Sprite.scale is the FULL width
    maskRadius,
    visibleFraction,
    // The TRUE angular diameter of the visibly glowing part. Note this is NOT
    // displayAngularDeg × visibleFraction: θ = 2·atan(r/d) is nonlinear, so a
    // fraction of the RADIUS is not the same fraction of the ANGLE. The
    // difference is ~1e-5° here, but reporting the linear approximation would
    // make this field disagree with the mask it is supposed to describe.
    visibleAngularDeg: radiusToAngular(visibleRadius, dist),
    maskAngularDeg: radiusToAngular(maskRadius, maskDist),
  };
}

/**
 * Moon: disc + full-disc depth mask. The mask stays full-disc at every phase —
 * the unlit limb is still solid rock and really does occlude stars — but sits
 * just inside the geometric disc because the texture's limb fade makes the outer
 * rim translucent. Derived from the catalogue so it cannot drift (it used to be
 * an independent literal).
 * @param {object} p
 * @param {number} p.displayAngularDeg
 * @param {number} p.dist — Constants.MOON_DIST
 * @param {number} p.maskDist
 * @param {number} p.maskFraction — Constants.MOON_MASK_FRACTION
 * @returns {{radius: number, maskRadius: number, maskAngularDeg: number, labelOffset: number}}
 */
export function moonGeometry({ displayAngularDeg, dist, maskDist, maskFraction, labelGap = 8 }) {
  const radius = angularToRadius(displayAngularDeg, dist);
  const maskRadius = radius * maskFraction * (maskDist / dist);
  return {
    radius,
    maskRadius,
    maskAngularDeg: radiusToAngular(maskRadius, maskDist),
    labelOffset: radius + labelGap,
  };
}

/**
 * Planet: disc, glow halo and depth mask. For Saturn (`ringSpanAngularDeg` set)
 * the mask is an ELLIPSE covering the ring plane, and the plane must be sized
 * UP from the intended ring span because the drawn rings fill only
 * SATURN_RING.spanFraction of the texture.
 *
 * The ellipse's minor semi-axis is floored at the globe radius: a pure ring
 * ellipse is thinner than the globe is tall, which would leave the globe's top
 * and bottom slivers unmasked.
 *
 * @param {object} p
 * @param {number} p.displayAngularDeg — the GLOBE's angular diameter
 * @param {number} p.dist — Constants.PLANET_DIST
 * @param {number} p.maskDist
 * @param {number} p.haloFactor — Constants.PLANET_GLOW_RADIUS_FACTOR
 * @param {number} [p.ringSpanAngularDeg] — Saturn only: intended visible ring span
 * @returns {object} radii plus, for Saturn, planeSize and the mask ellipse
 */
export function planetGeometry({ displayAngularDeg, dist, maskDist, haloFactor, ringSpanAngularDeg }) {
  const radius = angularToRadius(displayAngularDeg, dist);
  const ringed = typeof ringSpanAngularDeg === 'number' && ringSpanAngularDeg > 0;
  const haloRadius = haloFactor * (ringed ? radius * SATURN_RING.outer : radius);
  const g = { radius, haloRadius };

  if (!ringed) {
    g.maskRadius = radius * (maskDist / dist);
    g.maskAngularDeg = radiusToAngular(g.maskRadius, maskDist);
    return g;
  }

  // Size the billboard plane so the DRAWN rings land on the intended span.
  const planeAngularDeg = ringSpanAngularDeg / SATURN_RING.spanFraction;
  g.planeSize = 2 * angularToRadius(planeAngularDeg, dist);   // PlaneGeometry takes full width
  g.planeAngularDeg = planeAngularDeg;
  // Ring-plane mask ellipse, scaled to the mask distance.
  const scale = maskDist / dist;
  const ringMajor = radius * SATURN_RING.outer * scale;
  g.ringMaskMajor = ringMajor;
  // Floor the minor axis at the globe so the globe is never left uncovered.
  g.ringMaskMinor = Math.max(ringMajor * SATURN_RING.squash, radius * scale);
  g.ringMaskSquash = g.ringMaskMinor / ringMajor;
  g.ringMaskTilt = SATURN_RING.tilt;
  g.ringSpanAngularDeg = radiusToAngular(ringMajor, maskDist);
  g.maskAngularDeg = g.ringSpanAngularDeg;
  return g;
}
