/**
 * bodyGeometry.js — every DERIVED dimension of the naked-eye bodies: disc radii,
 * depth-mask radii, glow-halo radii, and Saturn's ring-mask ellipse.
 *
 * Pure arithmetic over plain numbers (no `three`, no DOM, no canvas) so the
 * body/mask couplings are assertable in a node test (test-bodyGeometry.js).
 * SunLight only constructs meshes from these.
 *
 * The rule enforced:  visibleExtent ≤ maskExtent ≤ geometricExtent
 * Too small a mask lets stars shine through solid bodies; too large deletes stars
 * from empty sky (subtler: a "zero stars inside the mask" test passes trivially).
 *
 * @module scene/bodyGeometry
 */

import { angularToRadius, radiusToAngular } from './bodyCatalog.js';

// Radial alpha stops of createSunDiscTexture's gradient, kept HERE (the texture
// factory reads them) because the depth mask must know how far the sprite really
// glows: the sprite square reaches r=1.0 where alpha is ZERO, so sizing the mask
// to it would over-mask a ring of empty sky.
/** @type {{r: number, a: number}[]} radial alpha stops, r normalized to the sprite half-width */
export const SUN_GLARE_STOPS = [
  { r: 0.00, a: 1.00 },
  { r: 0.55, a: 0.95 },   // white-hot core edge
  { r: 0.75, a: 0.25 },   // glow skirt
  { r: 1.00, a: 0.00 },   // transparent rim
];

/** Glare alpha at normalized radius `r` (0 = centre, 1 = sprite half-width), linear between stops like a canvas radial gradient. */
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
 * Normalized radius at which the glare's alpha falls to `alphaFloor`: the VISIBLY
 * glowing extent, the right size for the depth mask (shipped stops, 0.10 floor →
 * 0.90).
 *
 * @param {number} alphaFloor — Constants.SUN_GLARE_VISIBLE_ALPHA
 * @returns {number} normalized radius in (0, 1]
 */
export function glareVisibleFraction(alphaFloor, stops = SUN_GLARE_STOPS) {
  // Profile is monotone decreasing: the first crossing is the answer.
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    if (b.a <= alphaFloor && a.a > alphaFloor) {
      const t = (a.a - alphaFloor) / (a.a - b.a);
      return a.r + (b.r - a.r) * t;
    }
  }
  return stops[stops.length - 1].r;
}

// Real ring proportions in globe radii. createSaturnTexture draws with these AND
// the elliptical depth mask is built from them: one definition, or the mask stops
// matching the drawn rings.
export const SATURN_RING = {
  globeFraction: 0.19,   // globe radius as a fraction of the texture's half-width
  outer: 2.27,           // A ring outer edge, in globe radii (real value)
  inner: 1.52,           // B ring INNER edge, in globe radii (real value). The C ring's 1.24 hid the ring hole behind the globe (squash 0.36) and Saturn read as a solid diamond.
  tilt: -0.34,           // ring-plane tilt (rad) — "wide open" classic view
  squash: 0.36,          // ring opening (minor/major)
  // Two bands, inner→outer, in globe radii: bright B ring and dimmer A ring split
  // at the midpoint (the real four parts are sub-pixel). Contrast comes from
  // DARKENING the outer band; the inner is already near the top of the tone curve.
  get bands() {
    const mid = (this.inner + this.outer) / 2;
    return [
      { rIn: this.inner, rOut: mid,        rgb: '232, 214, 176', alpha: 0.92 }, // B ring
      { rIn: mid,        rOut: this.outer, rgb: '138, 122,  94', alpha: 0.45 }, // A ring
    ];
  },
  // Fraction of the square texture the drawn rings span: 2 × outer × globeFraction.
  // The rings do NOT fill the texture, so the plane is sized larger than the ring span.
  get spanFraction() { return 2 * this.outer * this.globeFraction; },
};

/**
 * Sun: glare sprite + depth mask derived from one angular size, the mask trimmed
 * to the visibly glowing extent rather than the sprite square.
 * @param {number} p.displayAngularDeg — from BODY_CATALOG
 * @param {number} p.dist — Constants.SUN_DIST
 * @param {number} p.maskDist — Constants.BODY_DEPTH_MASK_DIST
 * @param {number} p.visibleAlpha — Constants.SUN_GLARE_VISIBLE_ALPHA
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
    // TRUE angular diameter of the glowing part: NOT displayAngularDeg × visibleFraction
    // (θ = 2·atan(r/d) is nonlinear), else this disagrees with the mask it describes.
    visibleAngularDeg: radiusToAngular(visibleRadius, dist),
    maskAngularDeg: radiusToAngular(maskRadius, maskDist),
  };
}

/**
 * Moon: disc + full-disc depth mask. The mask stays full-disc at every phase (the
 * unlit limb is solid rock) but sits just inside the geometric disc because the
 * texture's limb fade makes the rim translucent.
 * @param {number} p.dist — Constants.MOON_DIST
 * @param {number} p.maskFraction — Constants.MOON_MASK_FRACTION
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
 * the mask is an ELLIPSE over the ring plane, and the plane is sized UP from the
 * intended ring span because the drawn rings fill only SATURN_RING.spanFraction
 * of the texture. The ellipse's minor semi-axis is floored at the globe radius,
 * else the globe's top and bottom slivers go unmasked.
 *
 * @param {number} p.displayAngularDeg — the GLOBE's angular diameter
 * @param {number} p.dist — Constants.PLANET_DIST
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

  const planeAngularDeg = ringSpanAngularDeg / SATURN_RING.spanFraction;
  g.planeSize = 2 * angularToRadius(planeAngularDeg, dist);   // PlaneGeometry takes full width
  g.planeAngularDeg = planeAngularDeg;
  const scale = maskDist / dist;
  const ringMajor = radius * SATURN_RING.outer * scale;
  g.ringMaskMajor = ringMajor;
  g.ringMaskMinor = Math.max(ringMajor * SATURN_RING.squash, radius * scale);
  g.ringMaskSquash = g.ringMaskMinor / ringMajor;
  g.ringMaskTilt = SATURN_RING.tilt;
  g.ringSpanAngularDeg = radiusToAngular(ringMajor, maskDist);
  g.maskAngularDeg = g.ringSpanAngularDeg;
  return g;
}
