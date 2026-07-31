/**
 * SunLight.js — Dynamic sun lighting with orbital day/night cycle,
 * sun disc sprite, lens flare artifacts, moon sprite, and auto-exposure
 * @module scene/SunLight
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { createLabelTexture } from './labelTexture.js';
import { sunEphemeris, moonEphemeris, latLonToUnitVec } from './Ephemeris.js';
import { BODY_CATALOG, bodyByName, angularToRadius } from './bodyCatalog.js';

// Tilt of the stylized day/night cycle's sun circle vs the equator (~23.5°,
// mirroring Earth's axial tilt). Module-level because both the per-frame sun
// motion and the real-clock seeding solve against the same circle.
const SUN_CYCLE_TILT = 0.41;

// ============================================================================
// CANVAS TEXTURE HELPERS
// ============================================================================

/**
 * Create a soft radial gradient canvas texture for the sun disc.
 * Defined white-hot core (~60% of sprite width) plus a short glow skirt, so the
 * enlarged sun (size-parity with the Moon) reads as a crisp disc rather than a
 * diffuse blob. Tightened from the old wide-glow stops when the sprite grew.
 * @param {number} size — canvas pixel dimensions
 * @returns {THREE.CanvasTexture}
 */
export function createSunDiscTexture(size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  gradient.addColorStop(0.55, 'rgba(255, 255, 238, 0.95)');
  gradient.addColorStop(0.75, 'rgba(255, 250, 205, 0.25)');
  gradient.addColorStop(1.0, 'rgba(255, 250, 190, 0.0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/**
 * Create a canvas-based text texture for planetarium-style labels.
 * Thin wrapper over the shared label recipe (scene/labelTexture.js).
 * @param {string} text — label text (e.g. "♀ Venus")
 * @returns {THREE.CanvasTexture}
 */
function createPlanetLabelTexture(text) {
  // Dim grey glyphs (not pure white) so the label reads as a quiet caption
  // under the planet rather than competing with the disc for attention.
  return createLabelTexture(text, { color: '#8f9aa6' });
}

/**
 * Erase the outer rim of a procedural body texture into transparency so the
 * hard clipped-circle edge reads as a soft photographic limb. Uses
 * destination-out so it works over arbitrary already-drawn detail (bands,
 * patches). `inner` is the normalized radius where the fade begins.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} size — canvas pixel dimensions (square)
 * @param {number} [inner=0.92] — normalized radius where the limb fade starts
 * @private
 */
function applyLimbFade(ctx, size, inner = 0.92) {
  const half = size / 2;
  const fade = ctx.createRadialGradient(half, half, 0, half, half, half);
  fade.addColorStop(0.0, 'rgba(0, 0, 0, 0)');
  fade.addColorStop(inner, 'rgba(0, 0, 0, 0)');
  fade.addColorStop(1.0, 'rgba(0, 0, 0, 1)');
  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = prev;
}

/**
 * Create an opaque Moon disc with a stylized nearside maria pattern.
 *
 * Deliberately exaggerated (~2× real contrast) so the dark maria read as a lunar
 * surface at the game's ~1.5° apparent size, and arranged like the real nearside
 * (Procellarum west, Imbrium upper-left, Serenitatis/Tranquillitatis center,
 * Fecunditatis/Nectaris lower-right, Crisium a distinct oval on the east limb) so
 * both the "man in the moon" and "rabbit in the moon" read. Fully deterministic —
 * no Math.random — so the texture is identical every load. NormalBlending is
 * required on the material (the maria must read as *dark* surface, not glow).
 * @param {number} size — canvas pixel dimensions
 * @returns {THREE.CanvasTexture}
 */
export function createMoonDiscTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const R = half;

  // --- Base disc: near-opaque warm gray, defined limb (alpha fades only in the
  //     outer ~8% of the radius so the disc has a crisp edge, not a glow blob). ---
  const base = ctx.createRadialGradient(half, half, 0, half, half, R);
  base.addColorStop(0.0,  'rgba(222, 222, 202, 1.0)');
  base.addColorStop(0.55, 'rgba(216, 216, 196, 1.0)');
  base.addColorStop(0.85, 'rgba(205, 205, 186, 1.0)');
  base.addColorStop(0.92, 'rgba(198, 198, 180, 1.0)');
  base.addColorStop(1.0,  'rgba(190, 190, 172, 0.0)');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // Clip surface detail to the disc so nothing spills past the limb.
  ctx.save();
  ctx.beginPath();
  ctx.arc(half, half, R * 0.995, 0, Math.PI * 2);
  ctx.clip();

  // Normalized coord → canvas px (nx,ny in [-1,1]; +y is downward / south).
  const P = (n) => half + n * R;
  // A mare is a cluster of overlapping soft ellipses → irregular natural edge.
  const mare = (cx, cy, lobes, color, alpha) => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    for (const [dx, dy, rx, ry, rot] of lobes) {
      ctx.save();
      ctx.translate(P(cx + dx), P(cy + dy));
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.ellipse(0, 0, rx * R, ry * R, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1.0;
  };

  const dark = '#6a707c'; // deep mare — blue-gray, ~1.9:1 against the base (real
                          // mare/highland albedo ratio 0.07 vs 0.12). Was #767c8a
                          // (~1.7:1); pushed to the real ratio for Stage 3 (F3).
  const mid  = '#8f95a2'; // lighter mare / basin fringe

  ctx.filter = `blur(${Math.round(R * 0.022)}px)`; // soften mare edges

  // Oceanus Procellarum — large, western (left)
  mare(-0.50, -0.02, [
    [0, 0, 0.20, 0.34, 0.15],
    [0.03, -0.24, 0.14, 0.17, 0],
    [-0.02, 0.26, 0.13, 0.20, 0.2],
    [0.11, 0.02, 0.12, 0.24, 0],
  ], dark, 0.9);

  // Mare Imbrium — round, upper-left
  mare(-0.16, -0.42, [
    [0, 0, 0.19, 0.17, 0],
    [0.08, 0.05, 0.11, 0.10, 0],
    [-0.08, 0.03, 0.10, 0.10, 0],
  ], dark, 0.9);

  // Mare Serenitatis — center, upper
  mare(0.15, -0.22, [
    [0, 0, 0.13, 0.14, 0.1],
    [0.05, 0.05, 0.08, 0.08, 0],
  ], dark, 0.88);

  // Mare Tranquillitatis — adjoins Serenitatis to the right / below
  mare(0.34, 0.03, [
    [0, 0, 0.14, 0.16, -0.2],
    [-0.08, -0.08, 0.09, 0.09, 0],
    [0.06, 0.09, 0.10, 0.10, 0],
  ], dark, 0.86);

  // Mare Fecunditatis — lower-right
  mare(0.41, 0.34, [
    [0, 0, 0.11, 0.16, 0.15],
    [-0.04, -0.07, 0.08, 0.09, 0],
  ], dark, 0.85);

  // Mare Nectaris — below Tranquillitatis, lower-center-right
  mare(0.22, 0.35, [
    [0, 0, 0.08, 0.10, 0],
  ], dark, 0.84);

  // Mare Crisium — small distinct oval on the east (right) limb
  mare(0.62, -0.16, [
    [0, 0, 0.10, 0.08, -0.3],
  ], dark, 0.94);

  // Mare Nubium / Humorum hint — lower-left, ties Procellarum southward
  mare(-0.30, 0.36, [
    [0, 0, 0.10, 0.12, 0.1],
  ], mid, 0.7);

  ctx.filter = 'none';

  // --- Subtle mottling: a few deterministic light/dark specks for texture ---
  const specks = [
    [-0.32, -0.10, 0.020, '#c8c8b4', 0.5],
    [0.28, -0.42, 0.016, '#c8c8b4', 0.5],
    [-0.10, 0.14, 0.014, '#6f7482', 0.4],
    [0.48, -0.02, 0.013, '#6f7482', 0.4],
    [0.05, -0.55, 0.012, '#c8c8b4', 0.4],
    [-0.55, 0.28, 0.012, '#6f7482', 0.35],
  ];
  for (const [nx, ny, r, col, a] of specks) {
    ctx.globalAlpha = a;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(P(nx), P(ny), r * R, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1.0;

  // --- Tycho: bright southern crater with a few faint rays ---
  const tycX = P(-0.05), tycY = P(0.60);
  const rays = [[0.0, -0.95], [-0.52, -0.62], [0.50, -0.58], [0.20, -0.88], [-0.28, -0.80]];
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = '#e9e9dc';
  ctx.lineWidth = Math.max(1, R * 0.01);
  for (const [rx, ry] of rays) {
    ctx.beginPath();
    ctx.moveTo(tycX, tycY);
    ctx.lineTo(tycX + rx * R, tycY + ry * R);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.6;
  ctx.fillStyle = '#ededde';
  ctx.beginPath();
  ctx.arc(tycX, tycY, R * 0.035, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1.0;

  ctx.restore(); // drop clip

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Create a soft white radial-gradient glow texture for planet halos. Using a gradient that
 * fades to fully transparent at the edge avoids the hard-edged "black ring"
 * artifact produced by a flat additive CircleGeometry, where the uniform-alpha
 * disc cut off abruptly between the planet body and its label.
 * @param {number} size — canvas pixel dimensions
 * @returns {THREE.CanvasTexture}
 */
// Shared singleton glow texture (white gradient; tinted per-planet via material color)
let _planetGlowTex = null;
function createPlanetGlowTexture(size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  gradient.addColorStop(0.35, 'rgba(255, 255, 255, 0.45)');
  gradient.addColorStop(0.7, 'rgba(255, 255, 255, 0.12)');
  gradient.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/**
 * Create a soft radial gradient texture for lens flare elements.
 * Avoids the visible square-edge artifact of untextured Sprites.
 * @param {number} size — canvas pixel dimensions
 * @returns {THREE.CanvasTexture}
 */
function createFlareTexture(size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0.0, 'rgba(255, 255, 255, 0.6)');
  gradient.addColorStop(0.4, 'rgba(255, 255, 255, 0.2)');
  gradient.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/**
 * Create a banded Jupiter disc with a Great Red Spot.
 * Cream / tan / brown-orange belts with slightly wavy edges and a rust GRS
 * (~60% down, offset right of center) with a pale collar; soft alpha limb.
 * Deterministic. Intended for a CircleGeometry disc (samples the inscribed
 * circle), so all detail is drawn inside a clipped circle filling the canvas.
 * @param {number} size — canvas pixel dimensions
 * @returns {THREE.CanvasTexture}
 */
export function createJupiterTexture(size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(half, half, half * 0.995, 0, Math.PI * 2);
  ctx.clip();

  const cream = '#f2e6cf', zone = '#ecdcbe', beltTan = '#c9a877', neb = '#b9835a', seb = '#b07a53';
  // Belt/zone structure north→south. Each band is defined by its (wavy) TOP edge
  // and fills DOWN to the canvas bottom; the next band overpaints it, so no gaps
  // open between wavy boundaries. The three dominant bands read at a glance: the
  // dark North & South Equatorial Belts (NEB/SEB) bracketing the bright
  // Equatorial Zone (EZ). The Great Red Spot sits at the south edge of the SEB.
  ctx.fillStyle = cream; // base = polar/northern cream
  ctx.fillRect(0, 0, size, size);
  const bands = [
    { y0: 0.12, color: beltTan, amp: 0.016, freq: 4.5, ph: 0.4 }, // N temperate belt
    { y0: 0.20, color: zone,    amp: 0.016, freq: 6.0, ph: 2.6 }, // N tropical zone
    { y0: 0.31, color: neb,     amp: 0.020, freq: 3.5, ph: 0.9 }, // NEB (dark, prominent)
    { y0: 0.43, color: '#f6ecd6', amp: 0.018, freq: 4.0, ph: 3.0 }, // EZ (brightest, wide)
    { y0: 0.55, color: seb,     amp: 0.022, freq: 3.2, ph: 1.4 }, // SEB (dark, prominent)
    { y0: 0.66, color: zone,    amp: 0.018, freq: 5.0, ph: 2.3 }, // S tropical zone
    { y0: 0.77, color: beltTan, amp: 0.016, freq: 4.5, ph: 0.7 }, // S temperate belt
    { y0: 0.87, color: cream,   amp: 0.014, freq: 5.5, ph: 1.1 }, // S polar region
  ];
  const step = Math.max(2, Math.round(size / 48));
  for (const b of bands) {
    const yt = (x) => b.y0 * size + Math.sin(x / size * Math.PI * 2 * b.freq + b.ph) * b.amp * size;
    ctx.beginPath();
    ctx.moveTo(0, yt(0));
    for (let x = step; x <= size; x += step) ctx.lineTo(x, yt(x));
    ctx.lineTo(size, size);
    ctx.lineTo(0, size);
    ctx.closePath();
    ctx.fillStyle = b.color;
    ctx.fill();
  }

  // Great Red Spot — at ~22°S (south edge of the SEB), east of center, in a pale
  // "Red Spot Hollow" collar. Oval (wider than tall); ~0.2 of the disk across
  // (exaggerated a touch from the real ~0.12 so it reads at small on-screen size).
  const grsX = half + size * 0.16, grsY = size * 0.60;
  const grsRx = size * 0.11, grsRy = size * 0.072;
  ctx.save();
  ctx.translate(grsX, grsY);
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = '#efd8b0';
  ctx.beginPath();
  ctx.ellipse(0, 0, grsRx * 1.35, grsRy * 1.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1.0;
  const grs = ctx.createRadialGradient(-grsRx * 0.2, -grsRy * 0.2, grsRx * 0.15, 0, 0, grsRx);
  grs.addColorStop(0.0, '#cf6146');
  grs.addColorStop(0.6, '#c04e34');
  grs.addColorStop(1.0, '#9f4029');
  ctx.fillStyle = grs;
  ctx.beginPath();
  ctx.ellipse(0, 0, grsRx, grsRy, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.restore(); // drop clip
  applyLimbFade(ctx, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Create a ringed Saturn on a transparent square (for a PlaneGeometry billboard,
 * which samples the full square so the rings can extend past the globe). Correct
 * ring/globe overlap is faked by draw order: far ring half → globe → near ring
 * half, split along the tilted ring plane. Ring geometry uses real proportions
 * (radii in units of Saturn radius: C 1.24–1.52, B 1.53–1.95, Cassini gap
 * 1.95–2.03, A 2.03–2.27) with the bright B ring, dimmer A ring, faint C ring,
 * the signature Cassini Division, and a subtle ring shadow on the globe.
 * Deterministic.
 * @param {number} size — canvas pixel dimensions
 * @returns {THREE.CanvasTexture}
 */
export function createSaturnTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const globeR = size * 0.19;    // shrunk so the ~2.27× ring span fits the square
  const rot = -0.34;             // ring-plane tilt (~ -19°, "wide open" classic view)
  const squash = 0.36;           // ring opening (minor/major)

  // Ring bands, radii in units of the globe radius (≈ Saturn radii), matching
  // the real ring system so the Cassini Division and A/B contrast read true.
  const R = (m) => globeR * m;
  const bands = [
    { rIn: R(1.24), rOut: R(1.52), style: 'rgba(196, 182, 154, 0.26)' }, // C ring (faint, translucent)
    { rIn: R(1.53), rOut: R(1.95), style: 'rgba(232, 214, 176, 0.95)' }, // B ring (brightest)
    // Cassini Division 1.95 → 2.03 left transparent — the signature dark gap
    { rIn: R(2.03), rOut: R(2.27), style: 'rgba(198, 182, 150, 0.55)' }, // A ring (dimmer)
  ];

  const drawRings = (frontOnly) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.scale(1, squash);
    // Clip to the near (local y>0) or far (local y<0) half of the ring plane.
    ctx.beginPath();
    if (frontOnly) ctx.rect(-size * 2, 0, size * 4, size * 2);
    else ctx.rect(-size * 2, -size * 2, size * 4, size * 2);
    ctx.clip();
    for (const b of bands) {
      ctx.beginPath();
      ctx.arc(0, 0, b.rOut, 0, Math.PI * 2, false);
      ctx.arc(0, 0, b.rIn, 0, Math.PI * 2, true);
      ctx.fillStyle = b.style;
      ctx.fill();
    }
    ctx.restore();
  };

  // 1. Far ring half (behind the globe).
  drawRings(false);

  // 2. Globe — pale gold with soft shading + faint low-contrast band hints.
  const g = ctx.createRadialGradient(cx - globeR * 0.3, cy - globeR * 0.3, globeR * 0.1, cx, cy, globeR);
  g.addColorStop(0.0, '#faf0d8');
  g.addColorStop(1.0, '#e2c894');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, globeR, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, globeR, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalAlpha = 0.20;
  ctx.fillStyle = '#d0ac7c';
  ctx.fillRect(cx - globeR, cy - globeR * 0.40, globeR * 2, globeR * 0.13);
  ctx.fillRect(cx - globeR, cy - globeR * 0.02, globeR * 2, globeR * 0.11);
  ctx.fillRect(cx - globeR, cy + globeR * 0.34, globeR * 2, globeR * 0.12);
  // Ring shadow cast on the globe — a soft dark band along the ring plane.
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#5f4e30';
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.ellipse(0, globeR * 0.16, globeR * 1.15, globeR * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1.0;

  // 3. Near ring half (in front of the globe).
  drawRings(true);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Create a rust-orange Mars disc with recognizable albedo features and polar caps.
 * Deterministic; for a CircleGeometry disc (detail clipped to inscribed circle).
 * Iconic markings (north up): Syrtis Major (dark wedge just north of center),
 * the bright Hellas basin below it, and Mare Erythraeum (dark, southern), with a
 * larger north polar cap and a smaller south cap.
 * @param {number} size — canvas pixel dimensions
 * @returns {THREE.CanvasTexture}
 */
export function createMarsTexture(size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const R = half;
  const P = (n) => half + n * R;

  ctx.save();
  ctx.beginPath();
  ctx.arc(half, half, R * 0.995, 0, Math.PI * 2);
  ctx.clip();

  // Base rust-orange globe with gentle shading toward the limb.
  const base = ctx.createRadialGradient(half - R * 0.25, half - R * 0.25, R * 0.1, half, half, R);
  base.addColorStop(0.0, '#ff7a45');
  base.addColorStop(0.6, '#ef6234');
  base.addColorStop(1.0, '#cf4d28');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // Dark albedo features (grey-brown against the rust). Syrtis Major is the
  // dominant wedge just north of the equator; Erythraeum trails to the SW.
  ctx.filter = `blur(${Math.round(R * 0.018)}px)`;
  const patches = [
    { cx: 0.14, cy: -0.12, rx: 0.15, ry: 0.30, rot: 0.35, col: '#7c4a2c', a: 0.6 },  // Syrtis Major (wedge)
    { cx: 0.24, cy: -0.24, rx: 0.10, ry: 0.12, rot: 0.2, col: '#7c4a2c', a: 0.5 },   // Syrtis Major (flare)
    { cx: -0.34, cy: 0.20, rx: 0.20, ry: 0.13, rot: -0.15, col: '#834326', a: 0.5 }, // Mare Erythraeum
    { cx: -0.10, cy: -0.36, rx: 0.13, ry: 0.10, rot: 0.1, col: '#8a4a2a', a: 0.4 },  // Mare Acidalium hint
  ];
  for (const p of patches) {
    ctx.globalAlpha = p.a;
    ctx.fillStyle = p.col;
    ctx.save();
    ctx.translate(P(p.cx), P(p.cy));
    ctx.rotate(p.rot);
    ctx.beginPath();
    ctx.ellipse(0, 0, p.rx * R, p.ry * R, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // Hellas basin — bright pale oval south-east of Syrtis Major.
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#f0c896';
  ctx.beginPath();
  ctx.ellipse(P(0.06), P(0.34), R * 0.20, R * 0.15, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.filter = 'none';
  ctx.globalAlpha = 1.0;

  // Polar caps — north (top) larger, south (bottom) smaller. Blue-white.
  ctx.fillStyle = '#f2f4fb';
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.ellipse(P(0.0), P(-0.83), R * 0.34, R * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.ellipse(P(-0.03), P(0.87), R * 0.17, R * 0.08, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1.0;

  ctx.restore(); // drop clip
  applyLimbFade(ctx, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Planet definitions: name, hex color, glow radius, angle from sun (degrees),
 *  optional procedural `makeTexture` factory, and optional `planeSize` (Saturn's rings need a
 *  full-square PlaneGeometry billboard rather than a CircleGeometry disc).
 *  Disc radii are DERIVED from BODY_CATALOG's displayAngularDeg via angularToRadius
 *  (radius = dist·tan(θ/2)) so the catalogue is the single source of truth for body
 *  sizes — change a size there and disc, glow, depth mask and label offset cannot
 *  silently desync. The textureKey → factory mapping lives HERE, not in the
 *  catalogue: the factories call document.createElement('canvas'), so importing
 *  them into bodyCatalog.js would make that module un-loadable in node and kill
 *  its tests (the same contract that keeps starCatalog.js testable).
 *  Sizes are exaggerated planetarium markers (real planets are point sources from LEO). The
 *  hierarchy is Sun≈Moon > Jupiter > Venus > Saturn(+rings) > Mars > Mercury; the Moon reads
 *  as clearly the largest body. `hex` still tints each planet's glow halo. */
const TEXTURE_FACTORIES = {
  mars: () => createMarsTexture(128),
  jupiter: () => createJupiterTexture(128),
  saturn: () => createSaturnTexture(256),
};
const PLANET_DEFS = [
  { name: 'Mercury', hex: '#c7bfad', glow: Constants.PLANET_MERCURY_GLOW, deg: Constants.PLANET_MERCURY_DEG },
  { name: 'Venus',   hex: '#ffffcc', glow: Constants.PLANET_VENUS_GLOW,   deg: Constants.PLANET_VENUS_DEG },
  { name: 'Mars',    hex: '#ff6633', glow: Constants.PLANET_MARS_GLOW,    deg: Constants.PLANET_MARS_DEG },
  { name: 'Jupiter', hex: '#ffd699', glow: Constants.PLANET_JUPITER_GLOW, deg: Constants.PLANET_JUPITER_DEG },
  { name: 'Saturn',  hex: '#f5e6c8', glow: Constants.PLANET_SATURN_GLOW,  deg: Constants.PLANET_SATURN_DEG, planeSize: Constants.PLANET_SATURN_PLANE_SIZE },
].map((def) => {
  const cat = bodyByName(def.name);
  const radius = angularToRadius(cat.displayAngularDeg, Constants.PLANET_DIST);
  return Object.assign({}, def, {
    radius,
    makeTexture: cat.textureKey ? TEXTURE_FACTORIES[cat.textureKey] : undefined,
  });
});

/** Shared material for depth-only occlusion masks — invisible but writes depth */
const DEPTH_MASK_MAT = new THREE.MeshBasicMaterial({
  colorWrite: false,
  depthWrite: true,
});

/**
 * Distance from origin at which depth masks are placed.
 * Must be slightly INSIDE the star sphere (STAR_SPHERE_RADIUS = 400) so that
 * masks have smaller depth values than stars and can occlude them.
 * Centralized as Constants.BODY_DEPTH_MASK_DIST (coupled to STAR_SPHERE_RADIUS).
 */
const DEPTH_MASK_DIST = Constants.BODY_DEPTH_MASK_DIST;

// ============================================================================
// SUN LIGHT CLASS
// ============================================================================

export class SunLight {
  /**
   * @param {THREE.Scene} scene
   * @param {import('./SceneManager.js').SceneManager} [sceneManager] — needed for bloom, camera, renderer
   */
  constructor(scene, sceneManager) {
    this.scene = scene;
    this.camera = sceneManager ? sceneManager.getCamera() : null;
    this.renderer = sceneManager ? sceneManager.getRenderer() : null;
    this.elapsedTime = 0;

    // Orbital period for the sun position (visual day/night cycle)
    this.sunOrbitPeriod = Constants.ORBITAL_PERIOD_400KM;

    // --- Directional Light (the Sun) ---
    this.directionalLight = new THREE.DirectionalLight(0xffffff, 2.0);
    this.directionalLight.name = 'SunLight';

    this.sunDirection = new THREE.Vector3(1, 0.3, 0.5).normalize();

    // --- Real-clock sky seeding ---
    // Defaults reproduce the legacy stylized sky; _seedSkyFromClock() then
    // overrides them so the sun + moon at startup match the player's actual
    // date/time (sub-solar point from UTC, today's lunar phase). The stylized
    // 92-min day/night cycle proceeds forward from that seed.
    this._sunPhase0 = 0;                        // parametric start angle on the sun circle
    this._sunYaw0 = 0;                          // yaw (about +Y) to the real sub-solar longitude
    this._moonAzOffset = 110 * Math.PI / 180;   // legacy fixed elongation fallback
    this._moonTanDecl = 0.25;                   // legacy y-lift fallback (≈14°)
    this._seedSkyFromClock(new Date());

    this._updateLightPosition();
    scene.add(this.directionalLight);

    // Subtle hemisphere light for indirect illumination. Lifted 0.03 → 0.10 to
    // help restore night-side / eclipse readability after the camera fill light
    // was corrected from its accidental ~35× flood (see CameraSystem fill-light
    // fix). Hemisphere (sky/ground gradient) is preferred over more flat ambient
    // because it preserves up/down shaping instead of washing the ship flat.
    this.hemiLight = new THREE.HemisphereLight(
      0x4488bb, // sky color
      0x111122, // ground color
      0.10
    );
    scene.add(this.hemiLight);

    // --- Visual elements ---
    this._createSunDisc(sceneManager);
    this._createLensFlare(sceneManager);
    this._createMoon();
    this._createPlanets();

    // Auto-exposure state
    this._currentExposure = 1.0;
    this._inShadow = false;

    // Reusable vector to avoid per-frame allocations
    this._camForward = new THREE.Vector3();

    // Pre-allocated vectors for Earth occlusion checks (avoid per-frame GC)
    this._occToEarth = new THREE.Vector3();
    this._occToBody = new THREE.Vector3();

    // P2 (2026-07-20): hot-path temps — update() previously allocated ~15-20
    // Vector3/frame across _updateSunDisc/_updateLensFlare/_updateMoon/
    // _updatePlanets (GC churn). Reuse order is safe: every consumer .copy()s
    // out of the temp before the next method reuses it.
    this._bodyPos = new THREE.Vector3();   // sun/moon/planet world-pos temp
    this._bodyDir = new THREE.Vector3();   // moon direction temp
    this._downTmp = new THREE.Vector3();   // camera-relative "below" temp
    this._labelTmp = new THREE.Vector3();  // per-label offset temp
    this._sunDirView = new THREE.Vector3(); // sun dir in view space (moon shader)
    this._camQuatInv = new THREE.Quaternion(); // inverse camera quat (moon shader)
  }

  // ==========================================================================
  // SUN DISC SPRITE
  // ==========================================================================

  /**
   * Create the main sun disc sprite with canvas gradient texture.
   * @param {import('./SceneManager.js').SceneManager} [sceneManager]
   * @private
   */
  _createSunDisc(sceneManager) {
    const texture = createSunDiscTexture(256);

    this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture,
      color: 0xffffee,
      transparent: true,
      opacity: Constants.SUN_GLARE_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,          // Mask is closer than body — skip depth test so body isn't self-occluded
    }));

    // Sun/Moon parity + glare/mask reconciliation (Stage 4, F6). The glare
    // sprite's visible disc and the depth mask BOTH derive from the catalogue's
    // Sun displayAngularDeg (1.49°, matching the Moon — reality is within 3%),
    // so they can never desync. Before, the glare (1.91°) was far wider than the
    // mask (1.15°) and background stars showed inside the glare ring. The
    // texture's own radial falloff provides the glow skirt INSIDE this disc; the
    // bloom pass adds the outer halo (stars shine through bloom — physically
    // correct for instrumental glow, and outside the geometry disc the
    // acceptance scans). Stays within CAMERA_FAR (500).
    const sunAngular = bodyByName('Sun').displayAngularDeg;
    const sunRadius = angularToRadius(sunAngular, Constants.SUN_DIST);  // half-extent at SUN_DIST
    this.sunSprite.scale.set(sunRadius * 2, sunRadius * 2, 1);          // sprite scale = full width
    this.sunSprite.name = 'SunDisc';
    this.scene.add(this.sunSprite);

    // Depth mask — invisible disc placed inside the star sphere to occlude stars/lines.
    // Sized to the SAME displayAngularDeg as the glare (rescaled to DEPTH_MASK_DIST),
    // so it covers the entire visible glare disc — zero star pixels inside it.
    this._sunDepthMask = new THREE.Mesh(
      new THREE.CircleGeometry(sunRadius * (DEPTH_MASK_DIST / Constants.SUN_DIST), 32),
      DEPTH_MASK_MAT
    );
    this._sunDepthMask.renderOrder = -1;
    this._sunDepthMask.onBeforeRender = (_r, _s, cam) => this._sunDepthMask.lookAt(cam.position);
    this.scene.add(this._sunDepthMask);

    // --- Sun label (planetarium-style, centered below disc) ---
    this._sunLabel = new THREE.Sprite(new THREE.SpriteMaterial({
      map: createPlanetLabelTexture('Sun'),
      transparent: true, opacity: Constants.BODY_LABEL_OPACITY, depthWrite: false, depthTest: true,
    }));
    this._sunLabel.scale.set(Constants.BODY_LABEL_SCALE_X, Constants.BODY_LABEL_SCALE_Y, 1);
    this._sunLabel.renderOrder = 10;
    this._sunLabel.frustumCulled = false;
    this.scene.add(this._sunLabel);

    // Add to selective bloom layer
    if (sceneManager) sceneManager.enableBloom(this.sunSprite);
  }

  // ==========================================================================
  // LENS FLARE ARTIFACTS
  // ==========================================================================

  /**
   * Create 3 lens flare sprites positioned along the sun→camera line.
   * @param {import('./SceneManager.js').SceneManager} [sceneManager]
   * @private
   */
  _createLensFlare(sceneManager) {
    this.flareGroup = new THREE.Group();
    this.flareGroup.name = 'LensFlareGroup';

    // Flare sprites bumped ~2× from their original 4-unit-sun tuning so they
    // aren't lost next to the enlarged (~15-unit) sun disc. This is an
    // eyeball-tuned value, not a strict match to the sun's growth factor —
    // the flare/sun ratio is intentionally kept subtle.
    const flareDefs = [
      { fraction: 0.3, scale: 2.4, color: 0xffffaa, opacity: 0.12 },
      { fraction: 0.6, scale: 1.6, color: 0xaaffff, opacity: 0.08 },
      { fraction: 0.85, scale: 3.0, color: 0xffeeaa, opacity: 0.15 },
    ];

    const flareTexture = createFlareTexture(64);

    this.flareSprites = flareDefs.map(def => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flareTexture,
        color: def.color,
        transparent: true,
        opacity: def.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      sprite.scale.set(def.scale, def.scale, 1);
      sprite.userData.fraction = def.fraction;
      sprite.userData.baseOpacity = def.opacity;
      this.flareGroup.add(sprite);
      if (sceneManager) sceneManager.enableBloom(sprite);
      return sprite;
    });

    this.scene.add(this.flareGroup);
  }

  // ==========================================================================
  // MOON SPRITE
  // ==========================================================================

  /**
   * Create a subtle moon mesh (circle geometry) — no bloom, phase-variable opacity.
   * Uses CircleGeometry instead of Sprite to avoid billboard rectangle artifacts.
   * @private
   */
  _createMoon() {
    // Opaque maria-patterned disc with a REAL terminator (Stage 3). The old
    // MeshBasicMaterial dimmed the WHOLE disc with phase (F1) — you never saw
    // a crescent, only a dim grey coin. This ShaderMaterial samples the maria
    // texture, then shades it with a reconstructed sphere normal so the lit
    // fraction falls out of the geometry: crescent horns, the elliptical
    // terminator and the gibbous bulge all come free from the dot product.
    // Radius derived from BODY_CATALOG's displayAngularDeg (~1.5° at MOON_DIST).
    const moonTexture = createMoonDiscTexture(256);
    const moonRadius = angularToRadius(bodyByName('Moon').displayAngularDeg, Constants.MOON_DIST);
    const moonGeo = new THREE.CircleGeometry(moonRadius, 32);
    this._moonMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: moonTexture },
        // Sun direction in VIEW space. The mesh copies the camera quaternion
        // (below), so its local axes ARE the view axes — no extra basis math.
        uSunDirView: { value: new THREE.Vector3(0, 0, 1) },
        uEarthshine: { value: Constants.MOON_EARTHSHINE },
        uTermSoft: { value: Constants.MOON_TERMINATOR_SOFTNESS },
        uOpacity: { value: Constants.MOON_BASE_OPACITY },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        uniform vec3 uSunDirView;
        uniform float uEarthshine;
        uniform float uTermSoft;
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          vec4 tex = texture2D(uMap, vUv);
          // Rebuild the near-hemisphere normal from the disc's local coords:
          // p = (uv − 0.5) × 2 maps the inscribed circle to the unit disc, and
          // n = (p.x, p.y, sqrt(1 − |p|²)) is the sphere normal there. The
          // terminator dot(n, sunDir) is then an ELLIPSE on the disc — correct
          // at crescent and gibbous, where a straight-line split reads wrong.
          vec2 p = (vUv - 0.5) * 2.0;
          float r2 = dot(p, p);
          vec3 n = vec3(p, sqrt(max(0.0, 1.0 - r2)));
          float lit = smoothstep(-uTermSoft, uTermSoft, dot(n, uSunDirView));
          // Earthshine on the unlit fraction only — NOT a floor under the whole
          // disc (that was F2). A new moon is a faint ashen disc for real reasons.
          vec3 color = tex.rgb * (lit + uEarthshine * (1.0 - lit));
          gl_FragColor = vec4(color, tex.a * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,          // Mask is closer than body — skip depth test so body isn't self-occluded
      side: THREE.DoubleSide,
    });
    this.moonMesh = new THREE.Mesh(moonGeo, this._moonMaterial);
    this.moonMesh.name = 'Moon';
    // Screen-aligned billboard (roll-compensated): copy the camera's orientation
    // so the maria stay upright to the *viewer*. A plain lookAt() anchors the
    // texture's up to world +Y, but the gameplay camera's up is the Earth-radial
    // direction (CameraSystem), so world-up billboards appear rolled by the
    // orbital angle. Aligning to the camera keeps the classic recognizable view.
    // LICENSED: real libration would tilt the maria; the upright billboard is a
    // deliberate readability choice. It is ALSO what makes the shader's view-space
    // sun direction correct — the mesh's local axes are the camera's view axes.
    //
    // uSunDirView is computed HERE, not in _updateMoon: the mesh quaternion copy
    // and the uniform must read the SAME camera quaternion in the SAME frame, or
    // a moving camera leaves the texture and its lighting one frame apart (the
    // terminator lands in the wrong place). onBeforeRender runs at render time
    // with the exact camera, so the two are frame-consistent by construction.
    this.moonMesh.onBeforeRender = (renderer, scene, camera) => {
      this.moonMesh.quaternion.copy(camera.quaternion);
      this._camQuatInv.copy(camera.quaternion).invert();
      this._sunDirView.copy(this.sunDirection).applyQuaternion(this._camQuatInv);
      this._moonMaterial.uniforms.uSunDirView.value.copy(this._sunDirView);
    };
    this.scene.add(this.moonMesh);

    // Depth mask — invisible disc placed inside the star sphere to occlude stars/lines.
    // Radius scaled to match angular size of moon's opaque core at DEPTH_MASK_DIST.
    this._moonDepthMask = new THREE.Mesh(
      new THREE.CircleGeometry(Constants.MOON_DEPTH_MASK_RADIUS * (DEPTH_MASK_DIST / Constants.MOON_DIST), 32),
      DEPTH_MASK_MAT
    );
    this._moonDepthMask.renderOrder = -1;
    this._moonDepthMask.onBeforeRender = (_r, _s, cam) => this._moonDepthMask.lookAt(cam.position);
    this.scene.add(this._moonDepthMask);

    // --- Moon label (planetarium-style, centered below disc) ---
    this._moonLabel = new THREE.Sprite(new THREE.SpriteMaterial({
      map: createPlanetLabelTexture('Moon'),
      transparent: true, opacity: Constants.BODY_LABEL_OPACITY, depthWrite: false, depthTest: true,
    }));
    this._moonLabel.scale.set(Constants.BODY_LABEL_SCALE_X, Constants.BODY_LABEL_SCALE_Y, 1);
    this._moonLabel.renderOrder = 10;
    this._moonLabel.frustumCulled = false;
    this.scene.add(this._moonLabel);
    console.log('[SunLight] Moon label created, id:', this._moonLabel.id);
  }

  // ==========================================================================
  // REAL-CLOCK SKY SEEDING
  // ==========================================================================

  /**
   * Align the stylized sky with the real one at startup: the sun starts over
   * the actual sub-solar point for `now` (so a player launching over Bangkok
   * at 07:44 local sees morning light on Thailand) and the moon starts at its
   * real elongation + declination, which makes today's phase fall out of the
   * existing dot-product phase math in _updateMoon().
   *
   * The per-frame model is unchanged — the sun still rides a circle tilted
   * SUN_CYCLE_TILT from the equator with a ~92-min period. Seeding solves that
   * circle for (a) the parametric phase whose declination matches today's,
   * picking the branch that matches the real seasonal trend, and (b) a fixed
   * yaw about +Y that carries the whole circle to the real sub-solar
   * longitude. Wall-clock and game-clock diverge immediately after start
   * (TIME_SCALE_GAMEPLAY compresses a day into ~9 min) — this is a seed, not
   * a live ephemeris.
   *
   * Failure-safe: any exception leaves the legacy fixed-sky defaults intact.
   *
   * @param {Date} now — real wall-clock time (UTC-based internally)
   * @private
   */
  _seedSkyFromClock(now) {
    try {
      const sun = sunEphemeris(now);
      const moon = moonEphemeris(now);
      const s = latLonToUnitVec(sun.declDeg, sun.subLonEastDeg);

      // (a) Phase whose declination matches today's. Real |declination| ≤
      // 23.44° < SUN_CYCLE_TILT (23.49°), so the clamp never bites in practice.
      const ratio = Math.max(-1, Math.min(1, s.y / Math.sin(SUN_CYCLE_TILT)));
      let a0 = Math.asin(ratio);
      const declTomorrow =
        sunEphemeris(new Date(now.getTime() + 86400000)).declDeg;
      if (declTomorrow < sun.declDeg) a0 = Math.PI - a0; // southbound branch

      // (b) Yaw the circle so the seeded point sits at the real sub-solar
      // longitude (azimuth measured atan2(z, x) in the equatorial plane).
      const bx = Math.cos(a0);
      const bz = Math.sin(a0) * Math.cos(SUN_CYCLE_TILT);
      this._sunPhase0 = a0;
      this._sunYaw0 = Math.atan2(s.z, s.x) - Math.atan2(bz, bx);
      this.sunDirection.set(s.x, s.y, s.z).normalize();

      // Moon: azimuth offset from the sun + tan(declination) y-lift, both
      // captured from the real sky. _updateMoon() keeps the moon locked to the
      // sun's fast cycle at this offset, so today's phase persists all session.
      const m = latLonToUnitVec(moon.declDeg, moon.subLonEastDeg);
      this._moonAzOffset =
        Math.atan2(m.z, m.x) - Math.atan2(s.z, s.x);
      this._moonTanDecl = Math.tan(moon.declDeg * Math.PI / 180);
    } catch (e) {
      console.warn('[SunLight] Real-clock sky seeding failed; using stylized defaults:', e);
    }
  }

  // ==========================================================================
  // LIGHT POSITION
  // ==========================================================================

  /**
   * Update directional light position from the current direction vector.
   * @private
   */
  _updateLightPosition() {
    const sunDistance = 200;
    this.directionalLight.position.copy(
      this.sunDirection.clone().multiplyScalar(sunDistance)
    );
    this.directionalLight.target.position.set(0, 0, 0);
  }

  // ==========================================================================
  // PER-FRAME UPDATE
  // ==========================================================================

  /**
   * Per-frame update: orbits the sun, updates visuals, auto-exposure.
   * @param {number} dt — delta time in seconds
   * @param {THREE.Vector3} [cameraPos] — player camera position for eclipse check
   * @returns {THREE.Vector3} current sun direction (normalized)
   */
  update(dt, cameraPos) {
    this.elapsedTime += dt;

    // --- Sun orbital motion ---
    // Stylized ~92-min day/night circle, seeded from the real clock: phase
    // starts at _sunPhase0 (today's declination) and the whole circle is yawed
    // by _sunYaw0 (today's sub-solar longitude). See _seedSkyFromClock().
    const angularSpeed = (2 * Math.PI) / this.sunOrbitPeriod;
    const angle = this._sunPhase0 +
      this.elapsedTime * angularSpeed * Constants.TIME_SCALE_GAMEPLAY;

    const bx = Math.cos(angle);
    const by = Math.sin(SUN_CYCLE_TILT) * Math.sin(angle);
    const bz = Math.sin(angle) * Math.cos(SUN_CYCLE_TILT);
    const cy = Math.cos(this._sunYaw0);
    const sy = Math.sin(this._sunYaw0);
    this.sunDirection.set(bx * cy - bz * sy, by, bx * sy + bz * cy).normalize();

    this._updateLightPosition();

    // --- Eclipse / shadow check ---
    this._inShadow = false;
    if (cameraPos) {
      this._inShadow = this._isInEarthShadow(cameraPos);
      const targetIntensity = this._inShadow ? 0.05 : 1.5;
      this.directionalLight.intensity +=
        (targetIntensity - this.directionalLight.intensity) * Math.min(1, dt * 3);
    }

    // --- Update visual elements ---
    this._updateSunDisc();
    this._updateLensFlare();
    this._updateMoon();
    this._updatePlanets();
    this._updateAutoExposure(dt);

    return this.sunDirection;
  }

  // ==========================================================================
  // SUN DISC UPDATE
  // ==========================================================================

  /** @private */
  _updateSunDisc() {
    // Camera-relative placement: the disc sits at a fixed distance along the
    // sun direction *from the camera*, so its apparent direction equals the
    // lighting's uSunDirection exactly (no finite-distance parallax toward
    // Earth). This is what makes the disc breach the limb precisely when the
    // ocean-glint NdotL gate turns on. Fall back to origin-relative when the
    // camera is null (menu/first frames); the occlusion path then uses
    // _inShadow. The sun is special-cased this way because lighting depends on
    // it — the moon/planets stay origin-centered (tiny, arguably-realistic
    // parallax) and are left untouched.
    const sunPos = this.camera
      ? this._bodyPos.copy(this.sunDirection).multiplyScalar(Constants.SUN_DIST).add(this.camera.position)
      : this._bodyPos.copy(this.sunDirection).multiplyScalar(Constants.SUN_DIST);
    this.sunSprite.position.copy(sunPos);

    // Geometric Earth-occlusion: hide sun when behind Earth's disc from camera POV
    const sunHidden = this.camera
      ? this._isOccludedByEarth(this.sunSprite.position, this.camera.position)
      : this._inShadow;
    this.sunSprite.visible = !sunHidden;

    // Update sun depth mask — camera-relative, placed just inside the star shell
    // along the sun direction so it occludes stars behind the disc. A fixed
    // origin-centered DEPTH_MASK_DIST breaks at altitude: stars along the sun
    // direction can be as close as (R − camDist), which would leave the mask
    // *behind* them. Solve the camera→star-shell ray for its length t, place the
    // mask at 0.98·t, and rescale so its angular size (geometry built for
    // DEPTH_MASK_DIST) is preserved.
    if (this._sunDepthMask) {
      if (this.camera) {
        const R = Constants.STAR_SPHERE_RADIUS;
        const cam = this.camera.position;
        const s = cam.dot(this.sunDirection);
        const disc = R * R - cam.lengthSq() + s * s;
        if (disc <= 0) {
          // Camera at/outside the star shell (shouldn't happen in gameplay).
          this._sunDepthMask.visible = false;
        } else {
          const t = (-s + Math.sqrt(disc)) * 0.98;
          this._sunDepthMask.position.copy(this.sunDirection).multiplyScalar(t).add(cam);
          this._sunDepthMask.scale.setScalar(t / DEPTH_MASK_DIST);
          this._sunDepthMask.visible = !sunHidden;
        }
      } else {
        this._sunDepthMask.position.copy(this.sunDirection).multiplyScalar(DEPTH_MASK_DIST);
        this._sunDepthMask.scale.setScalar(1);
        this._sunDepthMask.visible = !sunHidden;
      }
    }

    // Sun label: camera-relative "below"
    if (this._sunLabel) {
      const down = this._downTmp.set(0, -1, 0);
      if (this.camera) down.applyQuaternion(this.camera.quaternion);
      this._sunLabel.position.copy(sunPos).add(down.multiplyScalar(Constants.SUN_LABEL_OFFSET));
      this._sunLabel.visible = !sunHidden && !this._labelsHidden;
    }
  }

  // ==========================================================================
  // LENS FLARE UPDATE
  // ==========================================================================

  /** @private */
  _updateLensFlare() {
    if (!this.camera) {
      this.flareGroup.visible = false;
      return;
    }

    // Hide flares when sun is occluded (geometric Earth-occlusion or shadow)
    if (this._inShadow || !this.sunSprite.visible) {
      this.flareGroup.visible = false;
      return;
    }
    this.flareGroup.visible = true;

    // Camera-relative sun position (matches _updateSunDisc) so flare sprites
    // lerp along the true camera→sun axis.
    const camPos = this.camera.position;
    const sunPos = this._bodyPos.copy(this.sunDirection).multiplyScalar(Constants.SUN_DIST).add(camPos);

    // Camera forward vector
    this._camForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const sunDot = this._camForward.dot(this.sunDirection);

    // Fade flare opacity based on how directly we face the sun
    const flareFade = THREE.MathUtils.smoothstep(sunDot, 0.3, 0.9);

    this.flareSprites.forEach(sprite => {
      const t = sprite.userData.fraction;
      // Position at fraction t along sun→camera line
      sprite.position.lerpVectors(sunPos, camPos, t);
      sprite.material.opacity = sprite.userData.baseOpacity * flareFade;
    });
  }

  // ==========================================================================
  // MOON UPDATE
  // ==========================================================================

  /** @private */
  _updateMoon() {
    // Moon direction: real elongation + declination captured at startup
    // (_seedSkyFromClock), so the moon sits where it actually is in today's
    // sky and shows today's phase. The offset then rides the sun's fast
    // stylized cycle, keeping the phase constant for the whole session.
    // Near full moon the real elongation approaches 180° (opposite the sun);
    // that's correct — it's visible from the orbit's night side, and the
    // Earth-occlusion check below hides it when Earth is in the way. The
    // legacy fixed 110° offset remains the fallback if seeding failed.
    const sunAngle = Math.atan2(this.sunDirection.z, this.sunDirection.x);
    const moonAngle = sunAngle + this._moonAzOffset;
    const moonDir = this._bodyDir.set(
      Math.cos(moonAngle),
      // tan(declination) lift (normalized below) + slow libration-ish wobble
      this._moonTanDecl + Math.sin(this.elapsedTime * 0.0001) * 0.05,
      Math.sin(moonAngle)
    ).normalize();

    // Origin-centered (not camera-relative like the sun): the small finite-
    // distance parallax is visually negligible and arguably realistic. Only the
    // sun is special-cased, because the lighting direction depends on it.
    const moonPos = this._bodyPos.copy(moonDir).multiplyScalar(Constants.MOON_DIST);
    this.moonMesh.position.copy(moonPos);

    // Update moon depth mask — placed at DEPTH_MASK_DIST along moon direction (inside star sphere)
    if (this._moonDepthMask) {
      this._moonDepthMask.position.copy(moonDir).multiplyScalar(DEPTH_MASK_DIST);
    }

    // Phase is now rendered by the SHADER, not by dimming the whole disc (F1/F2
    // fixed). The lit fraction still comes from the same elongation — but instead
    // of scaling opacity, the shader shades a reconstructed sphere normal with
    // uSunDirView (the sun direction in view space), so the terminator is a real
    // ellipse with crescent horns and a gibbous bulge. uSunDirView is updated in
    // the mesh's onBeforeRender so it stays frame-consistent with the billboard
    // quaternion copy. The unlit limb gets the ashen MOON_EARTHSHINE term instead
    // of a hard opacity floor: a new moon is a faint disc for real reasons. With
    // the elongation seeded from the real sky (_seedSkyFromClock), the rendered
    // phase IS today's real lunar phase.
    // sunDir·moonDir = cos(elongation): +1 beside the sun (new), −1 opposite (full).

    // Moon label: camera-relative "below" — no parallax regardless of orbital orientation
    if (this._moonLabel) {
      const down = this._downTmp.set(0, -1, 0);
      if (this.camera) down.applyQuaternion(this.camera.quaternion);
      this._moonLabel.position.copy(moonPos).add(down.multiplyScalar(Constants.MOON_LABEL_OFFSET));  // ≈ radius + 8, matches planet convention
      // One-time diagnostic
      if (!this._moonLabelLogged) {
        console.log('[SunLight] Moon label pos:', this._moonLabel.position.toArray().map(v => v.toFixed(1)), 'visible:', this._moonLabel.visible);
        this._moonLabelLogged = true;
      }
    }

    // Earth occlusion — hide moon when behind Earth's disc from camera POV.
    // The only opacity the disc still carries is the LIMB FADE as it nears
    // Earth's angular edge (phase dimming is gone — the shader owns phase).
    // Mask/label keep the binary visibility.
    let opacity = Constants.MOON_BASE_OPACITY;
    if (this.camera) {
      const moonOccluded = this._isOccludedByEarth(this.moonMesh.position, this.camera.position);
      opacity *= this._earthLimbFadeFactor(this.moonMesh.position, this.camera.position);
      this.moonMesh.visible = !moonOccluded;
      if (this._moonDepthMask) this._moonDepthMask.visible = !moonOccluded;
      if (this._moonLabel) this._moonLabel.visible = !moonOccluded && !this._labelsHidden;
    }

    this._moonMaterial.uniforms.uOpacity.value = opacity;
  }

  // ==========================================================================
  // PLANETS — EXAGGERATED DISCS WITH PLANETARIUM LABELS
  // ==========================================================================

  /**
   * Create 5 visible planets as billboard discs with glow halos and canvas-based
   * planetarium-style text labels. Mercury/Venus stay flat-tinted CircleGeometry
   * discs (bright featureless discs are accurate); Mars/Jupiter/Saturn carry
   * procedural surface textures (`def.makeTexture`). Saturn's rings need a
   * full-square PlaneGeometry billboard (`def.planeSize`) rather than a disc.
   * @private
   */
  _createPlanets() {
    this._planets = PLANET_DEFS.map(def => {
      const color = new THREE.Color(def.hex);

      // --- Main disc ---
      // Textured bodies use a white base so the texture carries its own colour;
      // Saturn additionally swaps CircleGeometry for a PlaneGeometry so the rings
      // (which extend past the globe) aren't clipped to the inscribed circle.
      const discGeo = def.planeSize
        ? new THREE.PlaneGeometry(def.planeSize, def.planeSize)
        : new THREE.CircleGeometry(def.radius, 24);
      const disc = new THREE.Mesh(
        discGeo,
        new THREE.MeshBasicMaterial({
          color: def.makeTexture ? 0xffffff : color,
          map: def.makeTexture ? def.makeTexture() : null,
          transparent: true, opacity: Constants.PLANET_DISC_OPACITY,
          side: THREE.DoubleSide, depthWrite: false,
          depthTest: false,      // Mask is closer than body — skip depth test so body isn't self-occluded
        })
      );
      // Screen-aligned billboard (roll-compensated): copy the camera orientation
      // so textured patterns (Jupiter belts, Saturn rings, Mars features) stay
      // upright to the viewer. See the Moon billboard note — the gameplay camera
      // up is Earth-radial, so world-up lookAt() would roll the patterns.
      disc.onBeforeRender = (_r, _s, cam) => disc.quaternion.copy(cam.quaternion);
      this.scene.add(disc);

      // --- Glow halo (soft radial-gradient texture behind disc) ---
      // Use a textured PlaneGeometry with a gradient that fades to transparent
      // rather than a flat CircleGeometry. The old solid additive circle had a
      // hard outer edge that, drawn behind the opaque disc, read as a dark ring
      // between the planet and its label.
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(def.glow * Constants.PLANET_GLOW_SCALE, def.glow * Constants.PLANET_GLOW_SCALE),
        new THREE.MeshBasicMaterial({
          map: _planetGlowTex || (_planetGlowTex = createPlanetGlowTexture()),
          color, transparent: true, opacity: Constants.PLANET_GLOW_OPACITY,
          side: THREE.DoubleSide, depthWrite: false,
          depthTest: false,      // match disc — avoid self-occlusion against mask
          blending: THREE.AdditiveBlending,
        })
      );
      glow.renderOrder = -1;
      glow.onBeforeRender = (_r, _s, cam) => glow.quaternion.copy(cam.quaternion);
      this.scene.add(glow);

      // --- Planetarium text label (sprite — centered directly under planet) ---
      const label = new THREE.Sprite(new THREE.SpriteMaterial({
        map: createPlanetLabelTexture(def.name),
        transparent: true, opacity: Constants.BODY_LABEL_OPACITY, depthWrite: false,
      }));
      label.scale.set(Constants.BODY_LABEL_SCALE_X, Constants.BODY_LABEL_SCALE_Y, 1);
      label.frustumCulled = false;
      this.scene.add(label);

      // --- Depth mask (invisible, placed inside star sphere to occlude stars/lines) ---
      // Radius scaled to match angular size of planet disc at DEPTH_MASK_DIST.
      const depthMask = new THREE.Mesh(
        new THREE.CircleGeometry(def.radius * (DEPTH_MASK_DIST / 440), 24),
        DEPTH_MASK_MAT
      );
      depthMask.renderOrder = -1;
      depthMask.onBeforeRender = (_r, _s, cam) => depthMask.lookAt(cam.position);
      this.scene.add(depthMask);

      return { name: def.name, disc, glow, label, depthMask, deg: def.deg, radius: def.radius };
    });
  }

  /**
   * Per-frame planet update: reposition on ecliptic plane relative to sun,
   * center labels directly beneath each planet disc.
   * @private
   */
  _updatePlanets() {
    if (!this._planets) return;

    // Sun angle on the ecliptic (XZ plane)
    const sunAngle = Math.atan2(this.sunDirection.z, this.sunDirection.x);
    const _pos = this._bodyPos;

    // Camera-relative "below" direction — eliminates parallax between disc and label
    const _down = this._downTmp.set(0, -1, 0);
    if (this.camera) _down.applyQuaternion(this.camera.quaternion);

    for (const p of this._planets) {
      const angle = sunAngle + p.deg * (Math.PI / 180);
      _pos.set(Math.cos(angle), 0, Math.sin(angle));

      p.disc.position.copy(_pos).multiplyScalar(Constants.PLANET_DIST);
      if (p.depthMask) p.depthMask.position.copy(_pos).multiplyScalar(DEPTH_MASK_DIST);
      p.glow.position.copy(_pos).multiplyScalar(Constants.PLANET_GLOW_DIST);  // slightly behind disc
      _pos.multiplyScalar(Constants.PLANET_DIST);  // restore for label calc

      // Label: camera-relative below — always visually centered under disc
      const labelOffset = p.radius + Constants.PLANET_LABEL_OFFSET;
      p.label.position.copy(_pos).add(this._labelTmp.copy(_down).multiplyScalar(labelOffset));

      // Earth occlusion — hide planet when behind Earth's disc from camera POV
      if (this.camera) {
        const occluded = this._isOccludedByEarth(p.disc.position, this.camera.position);
        p.disc.visible = !occluded;
        p.glow.visible = !occluded;
        p.label.visible = !occluded && !this._labelsHidden;
        if (p.depthMask) p.depthMask.visible = !occluded;
      }
    }
  }

  /**
   * Pane-density "sky labels" rung: show/hide the planetarium NAME labels for
   * the Sun, Moon, and planets (the discs themselves stay — they are scenery).
   * A master flag gates the per-frame occlusion logic; hiding is applied
   * immediately, showing is re-derived on the next update tick.
   * @param {boolean} visible
   */
  setBodyLabelsVisible(visible) {
    this._labelsHidden = !visible;
    if (this._labelsHidden) {
      if (this._sunLabel) this._sunLabel.visible = false;
      if (this._moonLabel) this._moonLabel.visible = false;
      if (this._planets) for (const p of this._planets) { if (p.label) p.label.visible = false; }
    }
  }

  /**
   * Whether the sun disc is currently visible (not geometrically occluded by
   * Earth from the camera POV). Updated every frame by _updateSunDisc().
   * Drives SceneManager's bloom pass gate (P2): every scene source that can
   * cross the 2.5 bloom threshold is sun-driven (limb Mie, ocean glint), so
   * bloom is pure cost while the sun is behind the planet.
   * @returns {boolean}
   */
  isSunVisible() {
    return !!(this.sunSprite && this.sunSprite.visible);
  }

  // ==========================================================================
  // AUTO-EXPOSURE
  // ==========================================================================

  /**
   * Smoothly adjust renderer tone-mapping exposure based on camera-sun alignment.
   * Looking toward sun → reduce exposure (simulates eye/camera adaptation).
   * @param {number} dt
   * @private
   */
  _updateAutoExposure(dt) {
    if (!this.camera || !this.renderer) return;

    this._camForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const sunDot = this._camForward.dot(this.sunDirection);

    // Gentle auto-exposure (now live — the gameplay OutputPass finally applies it).
    // T2.1 retune under ACES: away 1.05→1.12, sun-facing 0.8→0.85, eclipse 1.3→1.25.
    // The filmic shoulder means values >1 are usable without washing out.
    // B4 (2026-07-20): away-from-sun 1.12 → 1.05. The boost fired precisely when
    // looking away from the sun — i.e. when the day-side disc is fully lit — and
    // scaled up the whole washed frame. 1.05 keeps a slight lift for metallic
    // ship/debris readability while removing most of the full-phase disc wash.
    // (Sun-facing 0.85 and eclipse 1.25 unchanged.)
    let targetExposure;
    if (this._inShadow) {
      targetExposure = 1.25;  // Boost when in Earth's shadow — simulate eye adaptation
    } else if (sunDot > 0.85) {
      targetExposure = 0.85;  // Looking directly at sun — slight dim
    } else if (sunDot < 0.3) {
      targetExposure = 1.05;  // Looking away from sun — subtle boost without washing out metallic surfaces
    } else {
      // Smooth interpolation in the transition zone [0.3, 0.85]
      const t = (sunDot - 0.3) / (0.85 - 0.3);
      targetExposure = THREE.MathUtils.lerp(1.05, 0.85, t);
    }

    // B4.1 (2026-07-20): adaptation speed is dt-normalized. The fixed 0.02
    // per-frame lerp made eye adaptation frame-rate dependent (120 Hz adapted
    // 2× faster than 60 Hz). Exponential decay, k = 1.2/s, matches the old
    // feel at 60 fps exactly and is identical at any refresh rate.
    const adapt = 1 - Math.exp(-1.2 * dt);
    this._currentExposure = THREE.MathUtils.lerp(
      this._currentExposure, targetExposure, adapt
    );
    this.renderer.toneMappingExposure = this._currentExposure;
  }

  // ==========================================================================
  // EARTH OCCLUSION (GEOMETRIC)
  // ==========================================================================

  /**
   * Check if a celestial body position is occluded by Earth from camera's POV.
   * Uses geometric angular-disc test — no depth buffer involved.
   * Bodies with depthTest:false (moon, planets) can't be occluded by the depth
   * buffer, so this provides a CPU-side visibility check instead.
   * @param {THREE.Vector3} bodyPos - World position of the celestial body
   * @param {THREE.Vector3} cameraPos - World position of the camera
   * @returns {boolean} true if occluded (behind Earth's disc)
   * @private
   */
  _isOccludedByEarth(bodyPos, cameraPos) {
    const earthRadius = Constants.EARTH_RADIUS; // shared with _earthLimbFadeFactor (matches Earth.js)
    const camDist = cameraPos.length(); // Distance from camera to Earth center (origin)
    if (camDist <= earthRadius) return false; // Inside Earth — shouldn't happen

    // Angular radius of Earth as seen from camera
    const earthAngularRadius = Math.asin(earthRadius / camDist);

    // Direction from camera to Earth center (origin)
    const toEarth = this._occToEarth.copy(cameraPos).negate().normalize();

    // Vector from camera to body — compute length before normalizing
    const toBody = this._occToBody.subVectors(bodyPos, cameraPos);
    const bodyDist = toBody.length();
    toBody.normalize();

    // Angle between the two directions
    const angle = Math.acos(Math.max(-1, Math.min(1, toEarth.dot(toBody))));

    // Body is occluded if within Earth's angular disc AND farther than Earth surface
    const earthSurfaceDist = camDist - earthRadius;
    return angle < earthAngularRadius && bodyDist > earthSurfaceDist;
  }

  /**
   * Soft-visibility ramp for a body approaching Earth's angular limb, to avoid a
   * hard pop when _isOccludedByEarth flips. Returns 1 while the body is well clear
   * of Earth's disc and ramps to 0 as its angular separation from Earth-center
   * drops from 1.3× to 1.0× Earth's angular radius (where binary occlusion takes
   * over). Same geometry as _isOccludedByEarth; reuses the occlusion temp vectors
   * (safe: called adjacent to the occlusion test, never interleaved).
   * @param {THREE.Vector3} bodyPos - World position of the celestial body
   * @param {THREE.Vector3} cameraPos - World position of the camera
   * @returns {number} fade factor in [0, 1]
   * @private
   */
  _earthLimbFadeFactor(bodyPos, cameraPos) {
    const earthRadius = Constants.EARTH_RADIUS; // same geometry as _isOccludedByEarth
    const camDist = cameraPos.length();
    if (camDist <= earthRadius) return 1;
    const earthAngularRadius = Math.asin(earthRadius / camDist);
    const toEarth = this._occToEarth.copy(cameraPos).negate().normalize();
    const toBody = this._occToBody.subVectors(bodyPos, cameraPos).normalize();
    const angle = Math.acos(Math.max(-1, Math.min(1, toEarth.dot(toBody))));
    // 0 at the limb (1.0×), 1 once clear (1.3×).
    return THREE.MathUtils.clamp((angle - earthAngularRadius) / (0.3 * earthAngularRadius), 0, 1);
  }

  // ==========================================================================
  // SHADOW / ECLIPSE DETECTION
  // ==========================================================================

  /**
   * Check if a position is in Earth's shadow (cylindrical approximation).
   * @param {THREE.Vector3} pos — world position to test
   * @returns {boolean}
   * @private
   */
  _isInEarthShadow(pos) {
    const sunDot = pos.dot(this.sunDirection);
    if (sunDot > 0) return false;

    const projOnSun = this.sunDirection.clone().multiplyScalar(sunDot);
    const perpendicular = pos.clone().sub(projOnSun);
    return perpendicular.length() < Constants.EARTH_RADIUS;
  }

  // ==========================================================================
  // PUBLIC ACCESSORS
  // ==========================================================================

  /** @returns {THREE.Vector3} */
  getSunDirection() {
    return this.sunDirection.clone();
  }

  /** @returns {THREE.DirectionalLight} */
  getLight() {
    return this.directionalLight;
  }
}

export default SunLight;
