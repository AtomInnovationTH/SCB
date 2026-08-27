/**
 * SunLight.js — Dynamic sun lighting with orbital day/night cycle,
 * sun disc sprite, lens flare artifacts, moon sprite, and auto-exposure
 * @module scene/SunLight
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { createLabelTexture } from './labelTexture.js';
import { sunEphemeris, moonEphemeris, latLonToUnitVec } from './Ephemeris.js';
import { stagedSunYaw, rotateAboutY, OPENING_SUN_TARGET_DOT } from './sunStaging.js';
import { BODY_CATALOG, bodyByName, ladderBloomBodies } from './bodyCatalog.js';
import {
  sunGeometry, moonGeometry, planetGeometry, SUN_GLARE_STOPS, SATURN_RING,
} from './bodyGeometry.js';
import { skyBrightness } from './starCatalog.js';

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
 * diffuse blob. The alpha profile is NOT defined here — it comes from
 * bodyGeometry.SUN_GLARE_STOPS, because the depth mask is sized to the extent
 * this gradient visibly glows and the two must never drift apart.
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
  // Warm tint over the shared alpha profile: white-hot core → pale yellow rim.
  const RGB = ['255, 255, 255', '255, 255, 238', '255, 250, 205', '255, 250, 190'];
  SUN_GLARE_STOPS.forEach((stop, i) => {
    gradient.addColorStop(stop.r, `rgba(${RGB[Math.min(i, RGB.length - 1)]}, ${stop.a})`);
  });
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

// ============================================================================
// MOON MARIA — projected from REAL selenographic coordinates
// ============================================================================
//
// The "man in the moon" and the "rabbit in the moon" are pareidolia OF THE REAL
// MARIA, so the layout cannot be invented — move the maria and you destroy the
// thing you are trying to reveal. An earlier attempt solved mare positions
// against a "2 px apart" constraint and produced five evenly-spaced equal blobs
// that read as a dice face; a second attempt drew a literal smiley. Both were
// legible and neither was the Moon. This list is DERIVED, at module load, from
// published coordinates by orthographic projection.
//
// Sources:
//   - Coordinates and diameters: IAU / Wikipedia, "List of plains on the Moon"
//   - Face identification: Wikipedia, "Man in the Moon" — the figure's eyes are
//     Mare Imbrium and Mare Serenitatis, its nose is Sinus Aestuum, and its open
//     mouth is Mare Nubium and Mare Cognitum.
//
// Projection: orthographic near side, north up, +y = south (down), lunar EAST
// (+lon) to the RIGHT — the modern IAU / naked-eye convention, which puts Mare
// Crisium on the upper-right limb and Oceanus Procellarum on the left, matching
// any full-moon photograph.
export const MOON_RADIUS_KM = 1737.4;

// The one licensed liberty: a global shrink on every extent. A catalogued mare
// "diameter" is its MAXIMUM extent, so an ellipse of that size overstates an
// irregular region — modelled at full size, neighbouring maria overlap (the
// Imbrium/Serenitatis pair computes to -0.25 px of gap) even though the real
// surface has visible highland between them. Shrinking opens those real gaps
// without moving a single feature off its real position.
//
// 0.90 is MEASURED, not eyeballed: at this factor the union of the projected
// footprints covers 26.0% of the near-side HEMISPHERE, matching the published
// figure that ~26% of the near side is basalt. (At 1.0 the model reads 31.3% —
// the ellipses really do overstate.) Note the two fractions are easy to
// conflate: hemisphere area weights limb regions by 1/cos θ, so the same layout
// covers 34% of the visible DISC, which is what a full-moon photograph shows.
// Tune against the hemisphere figure; check the disc figure looks right.
export const MOON_MARIA_SHRINK = 0.90;
export const MOON_MARIA_HEMISPHERE_COVERAGE = 0.26; // published near-side basalt fraction

// Real maria differ in albedo — Mare Tranquillitatis is titanium-rich and reads
// notably darker and bluer, Mare Serenitatis lighter — so shading them
// differently is real structure, not decoration. It is also what lets Imbrium
// read as its own basin against the Procellarum mass it opens into.
//
// The three tiers were checked against real normal albedo (highlands ~0.12),
// pushed through the ladder multiplier + ACES + sRGB the same way
// test-bodyDetail.js does. They land close to reality, which is why they stay:
//
//   tier    hex        on screen   real ratio   exaggeration
//   DARK    #62687a     1.82:1      1.60:1        1.14x     high-Ti mare, albedo ~0.075
//   MID     #6a707c     1.66:1      1.26:1        1.31x     typical mare, albedo ~0.095
//   FAINT   #878da0     1.17:1      1.14:1        1.02x     thin flooding, albedo ~0.105
//
// All three are modest exaggerations (1.0–1.3×), well inside the ~2× contrast
// licence this texture already takes, and the ordering follows titanium content.
// If you restyle these, keep the ordering and re-check the ratios — the
// highland base is near the top of the tone curve, so contrast can only be
// bought by darkening the mare, never by brightening the ground.
export const MOON_MARIA_DARK  = '#62687a'; // titanium-rich / deepest mare
export const MOON_MARIA_MID   = '#6a707c'; // typical mare
export const MOON_MARIA_FAINT = '#878da0'; // thin or shallow flooding (Frigoris, Vaporum)
export const MOON_MARIA_BLUR  = 0.020;     // edge-softening blur, fraction of the disc radius

// Compact, roughly circular basins: centroid + diameter is adequate.
const MOON_BASINS = [
  { name: 'Mare Imbrium',       lat:  34.72, lon: -14.91, diamKm: 1145.53, shade: 'dark'  }, // eye
  { name: 'Mare Serenitatis',   lat:  27.29, lon:  18.36, diamKm:  674.28, shade: 'mid'   }, // eye
  { name: 'Sinus Aestuum',      lat:  12.10, lon:  -8.34, diamKm:  316.50, shade: 'faint' }, // nose
  { name: 'Mare Cognitum',      lat: -10.53, lon: -22.31, diamKm:  350.01, shade: 'mid'   }, // mouth
  { name: 'Mare Humorum',       lat: -24.48, lon: -38.57, diamKm:  419.67, shade: 'mid'   },
  { name: 'Mare Insularum',     lat:   7.79, lon: -30.64, diamKm:  511.93, shade: 'mid'   },
  { name: 'Mare Nectaris',      lat: -15.19, lon:  34.60, diamKm:  339.39, shade: 'mid'   },
  { name: 'Mare Vaporum',       lat:  13.20, lon:   4.09, diamKm:  242.46, shade: 'faint' },
];

// Elongated regions, given as real lat/lon FOOTPRINTS. Centroid + diameter is
// wrong for these: the catalogued diameter is the long axis, so as a circle
// Oceanus Procellarum (2592 km) hangs off the west limb as a slab and the thin
// Mare Frigoris arc (1446 km) becomes a blob over the north pole.
const MOON_REGIONS = [
  { name: 'Oceanus Procellarum',  lat: [-15, 55], lon: [-80, -20], shade: 'mid'   },
  { name: 'Mare Frigoris',        lat: [ 50, 63], lon: [-40,  50], shade: 'faint' },
  { name: 'Mare Tranquillitatis', lat: [ -3, 18], lon: [ 20,  45], shade: 'dark'  },
  { name: 'Mare Fecunditatis',    lat: [-18,  3], lon: [ 40,  65], shade: 'mid'   },
  { name: 'Mare Crisium',         lat: [ 10, 23], lon: [ 50,  69], shade: 'dark'  },
  { name: 'Mare Nubium',          lat: [-30,-11], lon: [-28,  -6], shade: 'mid'   }, // mouth
];

const MOON_SHADES = { dark: MOON_MARIA_DARK, mid: MOON_MARIA_MID, faint: MOON_MARIA_FAINT };
const MOON_ALPHAS = { dark: 0.92, mid: 0.88, faint: 0.55 };
const D2R = Math.PI / 180;

/** Orthographic projection of a selenographic lat/lon to disc units. */
function moonProject(latDeg, lonDeg) {
  const lat = latDeg * D2R, lon = lonDeg * D2R;
  return { x: Math.cos(lat) * Math.sin(lon), y: -Math.sin(lat) };
}

/**
 * Project the real maria data into drawable ellipses.
 * Exported so a test can re-derive the layout and assert the shipped list still
 * matches the published coordinates — the invariant that stops someone
 * inventing positions again.
 * @returns {Array<{name,cx,cy,rx,ry,rot,color,alpha}>}
 */
export function projectMoonMaria(shrink = MOON_MARIA_SHRINK) {
  const out = [];
  for (const b of MOON_BASINS) {
    const { x, y } = moonProject(b.lat, b.lon);
    const d = Math.min(1, Math.hypot(x, y));
    // A circular feature at angular distance theta from the sub-Earth point
    // projects to an ellipse: full width tangentially, foreshortened by
    // cos(theta) radially. Without this, limb features are wrongly circular.
    const rho = (b.diamKm / 2) / MOON_RADIUS_KM;
    out.push({
      name: b.name,
      cx: x, cy: y,
      rx: rho * Math.sqrt(Math.max(0, 1 - d * d)) * shrink, // radial (foreshortened)
      ry: rho * shrink,                                     // tangential
      rot: Math.atan2(y, x),
      color: MOON_SHADES[b.shade],
      alpha: MOON_ALPHAS[b.shade],
    });
  }
  for (const r of MOON_REGIONS) {
    const lonMid = (r.lon[0] + r.lon[1]) / 2, latMid = (r.lat[0] + r.lat[1]) / 2;
    const north = moonProject(r.lat[1], lonMid), south = moonProject(r.lat[0], lonMid);
    const west = moonProject(latMid, r.lon[0]), east = moonProject(latMid, r.lon[1]);
    out.push({
      name: r.name,
      cx: (west.x + east.x) / 2,
      cy: (north.y + south.y) / 2,
      rx: Math.abs(east.x - west.x) / 2 * shrink,
      ry: Math.abs(north.y - south.y) / 2 * shrink,
      rot: 0, // footprint boxes are already axis-aligned in the projection
      color: MOON_SHADES[r.shade],
      alpha: MOON_ALPHAS[r.shade],
    });
  }
  return out;
}

export const MOON_MARIA = projectMoonMaria();

/**
 * Create an opaque Moon disc with the real nearside maria pattern.
 *
 * The maria are projected from published selenographic coordinates (see
 * MOON_MARIA above), not arranged by eye, because the "man in the moon" and
 * "rabbit in the moon" are pareidolia of the real surface — the pattern only
 * reads if the real geography is reproduced. Contrast is ~2× real so the maria
 * survive the game's ~1.5° apparent size. Fully deterministic — no Math.random —
 * so the texture is identical every load. NormalBlending is required on the
 * material (the maria must read as *dark* surface, not glow).
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

  ctx.filter = `blur(${Math.round(R * MOON_MARIA_BLUR)}px)`; // soften mare edges

  // Each mare is one projected ellipse, rotated to its radial direction so limb
  // features (Crisium, Fecunditatis) show their real foreshortening.
  for (const m of MOON_MARIA) {
    ctx.globalAlpha = m.alpha;
    ctx.fillStyle = m.color;
    ctx.save();
    ctx.translate(P(m.cx), P(m.cy));
    ctx.rotate(m.rot);
    ctx.beginPath();
    ctx.ellipse(0, 0, Math.max(m.rx, 0.004) * R, Math.max(m.ry, 0.004) * R, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1.0;

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

// ============================================================================
// JUPITER BANDS + GREAT RED SPOT — exported so tests can measure feature sizes
// ============================================================================
//
// Belt/zone structure north→south. Each band is defined by its (wavy) TOP edge
// y0 (fraction of the canvas height) and fills DOWN to the canvas bottom; the
// next band overpaints it, so no gaps open between wavy boundaries.
//
// Three bands, not eight: at Jupiter's 9 px disc a stripe needs 2 px, so each
// band is 0.22 of the disc height ≈ 2.0 px — the old 8-band texture drew them
// under 1 px and they averaged to a flat cream disc (1.08:1 measured). The
// three kept are the ones the code's own comment called "the three dominant
// bands that read at a glance": the dark North & South Equatorial Belts
// bracketing the bright Equatorial Zone.
//
// The belt colours are DARKER than the real ones on purpose and this is
// essential, not a style choice: between the ladder multiplier (×2.39) and
// ACES tone mapping the authored contrast largely evaporates — the real
// #b9835a belt lands on screen at only 1.17:1 against the bright zone. The
// bright zone is already at the top of the tone curve (brightening it does
// nothing), so all contrast comes from darkening the belts: #74513a lands at
// 1.6:1 in the captured screenshot.
export const JUPITER_BASE = '#f2e6cf'; // polar/northern cream base
export const JUPITER_BANDS = [
  { y0: 0.215, color: '#74513a', amp: 0.0, freq: 0.0, ph: 0.0 }, // NEB (dark, prominent)
  { y0: 0.44, color: '#f6ecd6', amp: 0.0, freq: 0.0, ph: 0.0 }, // EZ (brightest, wide)
  { y0: 0.665, color: '#6a4832', amp: 0.0, freq: 0.0, ph: 0.0 }, // SEB (dark, prominent;
                                                                 // darkened by the same
                                                                 // ratio as the NEB)
];
// Great Red Spot: centre (dx from disc centre, cy from canvas top) and radii as
// fractions of the canvas size. Drawn 22% of the disc across (oversized vs the
// real ~0.12 on purpose) so it reaches 2.0 × 2.0 px at the 9.06 px disc. It
// sits inside the South Equatorial Belt (cy 0.74; the disc spans x 0.06–0.94
// there, the spot covers 0.55–0.77). No pale collar — at 1.35× it would be a
// 0.70 px ring, invisible. The spot reads by HUE instead: orange-red against
// tan, colour distance 75 of 441, which survives the renderer with no clear
// space around it.
export const JUPITER_GRS = {
  dx: 0.16, cy: 0.74, rx: 0.115, ry: 0.115,
  collarColor: null, // dropped — sub-pixel at this budget
  stops: [0.0, 0.6, 1.0],
  colors: ['#cf6146', '#c04e34', '#9f4029'],
};

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

  ctx.fillStyle = JUPITER_BASE; // base = polar/northern cream
  ctx.fillRect(0, 0, size, size);
  const step = Math.max(2, Math.round(size / 48));
  for (const b of JUPITER_BANDS) {
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

  // Great Red Spot — inside the South Equatorial Belt, east of center. Reads
  // by hue (orange-red against tan), so it survives with no clear space around
  // it; the pale collar of the old texture would be a sub-pixel ring here.
  const grsX = half + size * JUPITER_GRS.dx, grsY = size * JUPITER_GRS.cy;
  const grsRx = size * JUPITER_GRS.rx, grsRy = size * JUPITER_GRS.ry;
  ctx.save();
  ctx.translate(grsX, grsY);
  if (JUPITER_GRS.collarColor) {
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = JUPITER_GRS.collarColor;
    ctx.beginPath();
    ctx.ellipse(0, 0, grsRx * 1.35, grsRy * 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1.0;
  }
  const grs = ctx.createRadialGradient(-grsRx * 0.2, -grsRy * 0.2, grsRx * 0.15, 0, 0, grsRx);
  JUPITER_GRS.stops.forEach((stop, i) => grs.addColorStop(stop, JUPITER_GRS.colors[i]));
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
 * half, split along the tilted ring plane. Two rings (bright inner, dimmer
 * outer) at real outer extent — the four real parts (C ring, B ring, Cassini
 * Division, A ring) are all sub-pixel at the 14 px span and smeared into one.
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
  // Ring proportions from the ONE definition — bodyGeometry.SATURN_RING. The
  // elliptical depth mask derives from the same block, so the mask can never stop
  // matching the drawn rings (F7).
  const globeR = size * SATURN_RING.globeFraction;  // ~2.27× ring span fits the square
  const rot = SATURN_RING.tilt;                     // ring-plane tilt (~ -19°, "wide open")
  const squash = SATURN_RING.squash;                // ring opening (minor/major)

  // Ring bands come from SATURN_RING — one definition, shared with the depth
  // mask. Two bands (bright B ring, dimmer A ring) starting at the real B-ring
  // inner edge; see the notes there for why the inner edge matters so much.
  const R = (m) => globeR * m;
  const bands = SATURN_RING.bands.map((b) => ({
    rIn: R(b.rIn), rOut: R(b.rOut), style: `rgba(${b.rgb}, ${b.alpha})`,
  }));

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
  g.addColorStop(0.0, '#fffbea');
  g.addColorStop(1.0, '#efd9a8');
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

// ============================================================================
// MARS FEATURES — exported so tests can measure feature sizes
// ============================================================================
//
// Mars is too small for spots: at radius 3.1 px a 2 px clear gap costs 0.64 of
// the radius, so a polar cap plus a dark patch plus the gap between them needs
// 1.93 radii of height and only 1.70 is available. It gets STRIPES, which need
// no clear space — three horizontal zones, each a third of the disc ≈ 2.07 px:
// bright blue-white north polar cap, dark albedo band (Syrtis Major flattened
// from a wedge to a band), rust south. Dropped as sub-pixel: the south cap,
// Hellas basin, Mare Erythraeum, the Acidalium hint, and the Syrtis flare.
//
// The dark band is DARKER than the real albedo feature for the same reason as
// Jupiter's belts: through the ×2.28 ladder multiplier and ACES, the real
// #7c4a2c lands at only 1.43:1 against the rust base; #6f4229 lands at 1.5:1.
// The polar cap reads by HUE (blue-white against rust), not brightness — both
// are pinned near the top of the tone curve, so it cannot be made brighter.
export const MARS_ZONES = [
  // The polar cap zone is GONE. Authored '#f2f4fb' it rendered rgb(255,191,242) —
  // pink — because the ×2.28 multiplier clips red at 255 through ACES while blue
  // survives. Any future cap here must be solved through the pipeline first.
  { y0: 1 / 3, y1: 2 / 3, color: '#6f4229' }, // dark albedo band (Syrtis Major)
  // below 2/3: the rust base shows through (the southern hemisphere)
];

/**
 * Create a rust-orange Mars disc with three horizontal albedo zones.
 * Deterministic; for a CircleGeometry disc (detail clipped to inscribed circle).
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

  // Three horizontal zones (cap / dark band / rust south). Stripes, not spots:
  // Mars is too small for spots (a 2 px clear gap costs 0.64 of the radius).
  for (const z of MARS_ZONES) {
    ctx.fillStyle = z.color;
    ctx.fillRect(0, z.y0 * size, size, (z.y1 - z.y0) * size);
  }

  ctx.restore(); // drop clip
  applyLimbFade(ctx, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Planet definitions: name, hex color, angle from sun (degrees), and an optional
 *  procedural `makeTexture` factory.
 *  Every DIMENSION (disc radius, glow halo, depth mask, and for Saturn the ring
 *  plane and its mask ellipse) is DERIVED in bodyGeometry.planetGeometry from
 *  BODY_CATALOG's displayAngularDeg, so the catalogue is the single source of truth
 *  for body sizes — change a size there and disc, glow, depth mask and label offset
 *  cannot silently desync. Keeping that math in a pure module is also what makes the
 *  couplings testable (test-bodyGeometry.js); they were previously inline literals
 *  here, which is how F6/F7 happened and stayed latent in two more places.
 *  The textureKey → factory mapping lives HERE, not in the
 *  catalogue: the factories call document.createElement('canvas'), so importing
 *  them into bodyCatalog.js would make that module un-loadable in node and kill
 *  its tests (the same contract that keeps starCatalog.js testable).
 *  Stage 5 (D1): the planets sit on the extended star size ladder (Venus ~9–10 px
 *  down to Mercury ~5 px), Saturn keeps a small ringed disc as the ONE licensed
 *  size inversion. `hex` tints the disc and its glow halo. */
const TEXTURE_FACTORIES = {
  mars: () => createMarsTexture(128),       // PARKED (Stage 5) — kept exported
  jupiter: () => createJupiterTexture(128), // PARKED (Stage 5) — kept exported
  saturn: () => createSaturnTexture(256),
};
// Saturn's ring proportions now live ONCE in bodyGeometry.SATURN_RING, shared by
// createSaturnTexture (which draws with them) and the elliptical ring depth mask
// (F7, which must match or it won't cover the visible rings). They used to be
// duplicated as literals in both places.
// Bodies whose HDR peak crosses the bloom threshold — DERIVED from the same
// curve and threshold the pass uses, never a hardcoded "Venus" (see
// bodyCatalog.ladderBloomBodies). These keep the bloom gate alive on their own,
// independently of the sun: that is the fix for a sun-only gate switching bloom
// off with Venus in plain view.
const BLOOM_SOURCE_BODIES = new Set(ladderBloomBodies(
  Constants.BLOOM_THRESHOLD,
  Constants.STAR_MAG_BRIGHT_MIN, Constants.STAR_MAG_BRIGHT_MAX, Constants.STAR_MAG_BRIGHT_FLOOR_SOFT));
const PLANET_DEFS = [
  { name: 'Mercury', hex: '#c7bfad', deg: Constants.PLANET_MERCURY_DEG },
  { name: 'Venus',   hex: '#ffffcc', deg: Constants.PLANET_VENUS_DEG },
  // #9c3133, not the obvious #ff6633: Mars carries a ×2.28 ladder multiplier, and
  // through that + ACES the bright authored value washes out to rgb(255,172,111),
  // a pale apricot. The darker, more saturated source lands at rgb(232,118,70) —
  // the red ember Mars actually looks like. Solved, not guessed.
  { name: 'Mars',    hex: '#9c3133', deg: Constants.PLANET_MARS_DEG },
  { name: 'Jupiter', hex: '#ffd699', deg: Constants.PLANET_JUPITER_DEG },
  { name: 'Saturn',  hex: '#f5e6c8', deg: Constants.PLANET_SATURN_DEG },
].map((def) => {
  const cat = bodyByName(def.name);
  // Disc, halo, mask and (for Saturn) the ring plane + mask ellipse all come from
  // bodyGeometry — one derivation, testable without `three` (see test-bodyGeometry).
  const geo = planetGeometry({
    displayAngularDeg: cat.displayAngularDeg,
    dist: Constants.PLANET_DIST,
    maskDist: Constants.BODY_DEPTH_MASK_DIST,
    haloFactor: Constants.PLANET_GLOW_RADIUS_FACTOR,
    ringSpanAngularDeg: cat.ringSpanAngularDeg,
  });
  // Stage 5 brightness ladder: HDR color multiplier B(mag) on the SAME
  // skyBrightness curve the stars use, so planets and stars share one curve
  // (F5). Applied to the tint; opacity is 1.0 (see Constants.PLANET_DISC_OPACITY).
  const brightB = skyBrightness(cat.magnitude,
    Constants.STAR_MAG_BRIGHT_MIN, Constants.STAR_MAG_BRIGHT_MAX, Constants.STAR_MAG_BRIGHT_FLOOR_SOFT);
  return Object.assign({}, def, {
    geo,
    radius: geo.radius,
    brightB,
    // Does this body keep the bloom pass alive by itself? (Venus does.)
    bloomSource: BLOOM_SOURCE_BODIES.has(def.name),
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

    // Sun/Moon parity, glare/mask reconciliation, and the Sun's bloom — all three
    // derived from ONE catalogue angular size via bodyGeometry.sunGeometry.
    const sunGeo = sunGeometry({
      displayAngularDeg: bodyByName('Sun').displayAngularDeg,   // 1.49°, Moon parity
      dist: Constants.SUN_DIST,
      maskDist: DEPTH_MASK_DIST,
      visibleAlpha: Constants.SUN_GLARE_VISIBLE_ALPHA,
    });

    // HDR core so the Sun actually blooms (it never did — the sprite was plain
    // LDR at ~0.95 and could not reach the 2.5 threshold, so the pass produced
    // nothing from the one body D3 reserves bloom for). Same mechanism as the
    // planet ladder: divide the tint by its own peak channel so the rendered peak
    // lands EXACTLY on SUN_HDR_PEAK while the hue is preserved. Additive blending
    // means the contribution is colour × texture.a × opacity, hence the /opacity.
    const sunTint = new THREE.Color(0xffffee);
    sunTint.multiplyScalar(Constants.SUN_HDR_PEAK /
      (Math.max(sunTint.r, sunTint.g, sunTint.b) * Constants.SUN_GLARE_OPACITY));

    this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture,
      color: sunTint,
      transparent: true,
      opacity: Constants.SUN_GLARE_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,          // Mask is closer than body — skip depth test so body isn't self-occluded
    }));
    this.sunSprite.scale.set(sunGeo.spriteScale, sunGeo.spriteScale, 1);   // sprite scale = full width
    this.sunSprite.name = 'SunDisc';
    this.scene.add(this.sunSprite);

    // Depth mask — invisible disc inside the star sphere to occlude stars/lines.
    // Sized to the VISIBLY GLOWING extent (0.90 of the sprite = 1.341°), not the
    // sprite square: the texture reaches alpha 0 at its rim, so a full-sprite mask
    // deleted stars from a ring of effectively empty sky. Now that the core blooms,
    // that ring is covered by real glow instead of an invisible cutout — which is
    // how a bright source should hide its neighbours.
    this._sunDepthMask = new THREE.Mesh(
      new THREE.CircleGeometry(sunGeo.maskRadius, 32),
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
    // Radius + full-disc mask derived from BODY_CATALOG via bodyGeometry.
    const moonTexture = createMoonDiscTexture(256);
    const moonGeo = moonGeometry({
      displayAngularDeg: bodyByName('Moon').displayAngularDeg,
      dist: Constants.MOON_DIST,
      maskDist: DEPTH_MASK_DIST,
      maskFraction: Constants.MOON_MASK_FRACTION,
    });
    const moonGeoBuf = new THREE.CircleGeometry(moonGeo.radius, 32);
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
    this.moonMesh = new THREE.Mesh(moonGeoBuf, this._moonMaterial);
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
      new THREE.CircleGeometry(moonGeo.maskRadius, 32),
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

  /**
   * Stage the opening light for a FRESH game start (Mission 1's first spawn).
   * Called by GameFlowManager on the new-game paths only (MENU_START /
   * MENU_FAST_START) — never on saved-game loads, later missions, or
   * mid-session, so returning players keep the pure real-clock sky.
   *
   * Applies a one-time staged yaw offset on top of the real-clock seed so the
   * spawn point starts on the day side with the sun well off the spawn zenith
   * (warm side key light on the forward welcome cluster — see sunStaging.js
   * for the targeting/clamp math). Only the cycle's longitude anchor
   * (_sunYaw0) moves: phase (_sunPhase0 — season/declination), cycle speed,
   * and the moon's sun-relative elongation (today's lunar phase) are
   * untouched, so day/night cycling continues normally from the staged offset
   * — the sun is NOT frozen. The LAUNCH_CAMEO opening cameo is unaffected by
   * construction: its fire gates are pure camera geometry (launchVisible /
   * plumeHeadVisible) and its plume brightness handles both day and night
   * (cameoIntensity) — staging only changes which branch lights the pad.
   *
   * @param {{x:number,y:number,z:number}} spawnPos — player spawn scene
   *   position (any length; direction is what matters)
   */
  stageOpeningLight(spawnPos) {
    if (!spawnPos) return;
    const yaw = stagedSunYaw(this.sunDirection, spawnPos, OPENING_SUN_TARGET_DOT);
    if (!Number.isFinite(yaw) || yaw === 0) return;
    this._sunYaw0 += yaw;
    // Rotate the live direction now so same-frame consumers (light, shadow
    // check, disc) are coherent; the next update() recomputes the identical
    // direction from the biased _sunYaw0 (rotateAboutY IS update()'s yaw).
    const d = rotateAboutY(this.sunDirection, yaw);
    this.sunDirection.set(d.x, d.y, d.z).normalize();
    this._updateLightPosition();
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
   * planetarium-style text labels. All five are now flat-tinted CircleGeometry
   * discs EXCEPT Saturn, whose rings need a full-square PlaneGeometry billboard
   * (`def.geo.planeSize`). (Jupiter/Mars detail textures are PARKED — their detail
   * can't survive 6–7 px; they stay exported as telescope-feature material.)
   * Each disc carries the HDR brightness ladder B(mag) as a color multiplier, so
   * Venus blooms and the rest stay under the threshold (see Constants.PLANET_DISC_OPACITY).
   * @private
   */
  _createPlanets() {
    this._planets = PLANET_DEFS.map(def => {
      // --- Main disc ---
      // Flat bodies tint with their hex; Saturn (textured) uses a white base so
      // the texture carries its own colour. BOTH get the HDR ladder multiplier —
      // that is the whole brightness model (F5 fixed). The multiplier is
      // brightB / maxChannel, so the peak channel lands EXACTLY on B(mag) while
      // the hue (channel ratios) is preserved: a dark tint like Mercury's
      // #c7bfad would otherwise render dimmer than Rigel despite being genuinely
      // brighter (mag −0.4 vs +0.13) — a brightness-truth violation. For Saturn
      // (white base) maxChannel is 1, so the peak is B(mag) × texture peak.
      const baseColor = def.makeTexture ? new THREE.Color(0xffffff) : new THREE.Color(def.hex);
      baseColor.multiplyScalar(def.brightB / Math.max(baseColor.r, baseColor.g, baseColor.b));
      const discGeo = def.geo.planeSize
        ? new THREE.PlaneGeometry(def.geo.planeSize, def.geo.planeSize)
        : new THREE.CircleGeometry(def.geo.radius, 24);
      const disc = new THREE.Mesh(
        discGeo,
        new THREE.MeshBasicMaterial({
          color: baseColor,
          map: def.makeTexture ? def.makeTexture() : null,
          transparent: true, opacity: Constants.PLANET_DISC_OPACITY,
          side: THREE.DoubleSide, depthWrite: false,
          depthTest: false,      // Mask is closer than body — skip depth test so body isn't self-occluded
        })
      );
      // Screen-aligned billboard (roll-compensated): copy the camera orientation
      // so Saturn's rings stay upright to the viewer. See the Moon billboard note —
      // the gameplay camera up is Earth-radial, so world-up lookAt() would roll.
      disc.onBeforeRender = (_r, _s, cam) => disc.quaternion.copy(cam.quaternion);
      this.scene.add(disc);

      // --- Glow halo (soft radial-gradient texture behind disc) ---
      // Halo radius derives from the body (1.25×), so it shrinks with the ladder.
      // For Saturn it spans the ring system, not just the globe.
      const haloRadius = def.geo.haloRadius;
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(haloRadius * 2, haloRadius * 2),
        new THREE.MeshBasicMaterial({
          map: _planetGlowTex || (_planetGlowTex = createPlanetGlowTexture()),
          color: new THREE.Color(def.hex), transparent: true, opacity: Constants.PLANET_GLOW_OPACITY,
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
      // Normal planets: a circular mask matching the disc. Saturn (F7): the mask
      // must cover the RING PLANE, not just the globe, or stars shine through the
      // rings. Build an ELLIPSE matching the texture's ring tilt/squash, and
      // billboard it with the camera quaternion (like the disc) so they stay
      // aligned — a lookAt() mask would roll away from the rings.
      let depthMask;
      if (def.geo.planeSize) {
        const maskGeo = new THREE.CircleGeometry(def.geo.ringMaskMajor, 24);
        // Squash to the ring ellipse — but the minor axis is FLOORED at the globe
        // radius in bodyGeometry, because a pure ring ellipse is thinner than the
        // globe is tall and would leave the globe's top/bottom slivers unmasked.
        maskGeo.scale(1, def.geo.ringMaskSquash, 1);
        maskGeo.rotateZ(def.geo.ringMaskTilt);     // tilt to match the texture
        depthMask = new THREE.Mesh(maskGeo, DEPTH_MASK_MAT);
        depthMask.onBeforeRender = (_r, _s, cam) => depthMask.quaternion.copy(cam.quaternion);
      } else {
        depthMask = new THREE.Mesh(
          new THREE.CircleGeometry(def.geo.maskRadius, 24),
          DEPTH_MASK_MAT
        );
        depthMask.onBeforeRender = (_r, _s, cam) => depthMask.lookAt(cam.position);
      }
      depthMask.renderOrder = -1;
      this.scene.add(depthMask);

      return { name: def.name, disc, glow, label, depthMask, deg: def.deg, radius: def.radius,
               bloomSource: def.bloomSource };
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
   *
   * This is a pure sun-geometry query — it is NOT the bloom gate. Use
   * isBloomSourceVisible() for that: the sun's own sprite is LDR (≤ 0.95) and
   * never crosses the threshold itself; what it drives are the atmosphere's Mie
   * limb and the ocean glint, and since Stage 5 it is no longer the only thing
   * that can bloom (Venus rides the ladder at 2.74).
   * @returns {boolean}
   */
  isSunVisible() {
    return !!(this.sunSprite && this.sunSprite.visible);
  }

  /**
   * Whether ANY source that can cross the bloom threshold is currently on
   * screen — the correct input to SceneManager.setBloomEnabled().
   *
   * Two independent families:
   *  1. sun-driven sources (atmosphere Mie limb ≈ 2.7, ocean glint ≈ 2.2–2.7),
   *     gated by the sun's own visibility;
   *  2. laddered BODIES whose HDR peak exceeds Constants.BLOOM_THRESHOLD —
   *     Venus at B 2.74 (D3). Their visibility is independent of the sun's.
   *
   * Family 2 is why this method exists. The gate used to be `isSunVisible()`
   * alone, on the documented premise that every threshold-crossing source was
   * sun-driven. Stage 5 broke that premise: Venus sits at a fixed 40° elongation,
   * so the evening/morning-star case — Venus clear of the limb while the sun is
   * behind it — switched the pass off precisely when the one deliberately
   * blooming planet was in view. The source list is derived from the brightness
   * curve and the threshold (BLOOM_SOURCE_BODIES), so a retune cannot desync it.
   *
   * Perf note: the gate still buys its ~1.35 ms mip-chain skip on frames where
   * neither the sun nor a blooming body is up (deep night side, eclipse). It just
   * no longer claims those savings on frames that need the pass.
   * @returns {boolean}
   */
  isBloomSourceVisible() {
    if (this.isSunVisible()) return true;
    if (this._planets) {
      for (const p of this._planets) {
        if (p.bloomSource && p.disc && p.disc.visible) return true;
      }
    }
    return false;
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
