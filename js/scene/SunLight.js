/**
 * Sun lighting: orbital day/night cycle, sun disc, lens flare, moon and planet sprites, auto-exposure.
 * @module scene/SunLight
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { TimeAuthority } from '../systems/TimeAuthority.js';
import { createLabelTexture } from './labelTexture.js';
import { sunEphemeris, moonEphemeris, latLonToUnitVec } from './Ephemeris.js';
import { stagedSunYaw, rotateAboutY, OPENING_SUN_TARGET_DOT } from './sunStaging.js';
import { bodyByName, ladderBloomBodies } from './bodyCatalog.js';
import {
  sunGeometry, moonGeometry, planetGeometry, SUN_GLARE_STOPS, SATURN_RING,
} from './bodyGeometry.js';
import { skyBrightness } from './starCatalog.js';
import { DEG2RAD, degToRad, clamp } from '../core/MathUtil.js';

// Tilt (rad, ~23.5°) of the stylized cycle's sun circle vs the equator. Shared by
// the per-frame sun motion and the real-clock seeding; exported so the eclipse
// predictor's pins can evaluate the closed form.
export const SUN_CYCLE_TILT = 0.41;

/**
 * Radial gradient for the sun disc: white-hot core (~60% of sprite width) plus a
 * short glow skirt. The alpha profile comes from bodyGeometry.SUN_GLARE_STOPS,
 * not from here: the depth mask is sized to this gradient's visible extent and
 * the two must never drift apart.
 * @param {number} size — canvas pixel dimensions
 */
export function createSunDiscTexture(size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  const RGB = ['255, 255, 255', '255, 255, 238', '255, 250, 205', '255, 250, 190'];
  SUN_GLARE_STOPS.forEach((stop, i) => {
    gradient.addColorStop(stop.r, `rgba(${RGB[Math.min(i, RGB.length - 1)]}, ${stop.a})`);
  });
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function createPlanetLabelTexture(text) {
  // Dim grey so the caption doesn't compete with the disc.
  return createLabelTexture(text, { color: '#8f9aa6' });
}

/**
 * Erase the rim of a procedural body texture to transparency (soft limb).
 * destination-out, so it works over any already-drawn detail.
 * @param {number} inner — normalized radius where the fade begins
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

// MOON MARIA — derived at module load from REAL selenographic coordinates by
// orthographic projection. The "man/rabbit in the moon" is pareidolia of the
// real maria, so positions must never be invented.
//
// Sources:
//   - Coordinates and diameters: IAU / Wikipedia, "List of plains on the Moon"
//   - Face identification: Wikipedia, "Man in the Moon" — eyes Imbrium and
//     Serenitatis, nose Sinus Aestuum, mouth Nubium and Cognitum.
//
// Projection: orthographic near side, north up, +y = south (down), lunar EAST
// (+lon) to the RIGHT (IAU / naked-eye convention, matches a full-moon photo).
export const MOON_RADIUS_KM = 1737.4;

// Global shrink on every extent: a catalogued mare "diameter" is its MAXIMUM
// extent, so full-size ellipses overlap neighbours that have real highland
// between them. Opens those gaps without moving any feature.
//
// 0.90 is MEASURED: the union of footprints covers 26.0% of the near-side
// HEMISPHERE, matching the published ~26% basalt (1.0 reads 31.3%). The
// hemisphere weights limb regions by 1/cos θ; the same layout covers 34% of the
// visible DISC. Tune against the hemisphere figure; check the disc looks right.
export const MOON_MARIA_SHRINK = 0.90;
export const MOON_MARIA_HEMISPHERE_COVERAGE = 0.26; // published near-side basalt fraction

// Real maria differ in albedo (Tranquillitatis is titanium-rich: darker, bluer),
// so tiered shading is real structure and separates Imbrium from Procellarum.
// Tiers checked against real normal albedo (highlands ~0.12) through the ladder
// multiplier + ACES + sRGB, as test-bodyDetail.js does:
//
//   tier    hex        on screen   real ratio   exaggeration
//   DARK    #62687a     1.82:1      1.60:1        1.14x     high-Ti mare, albedo ~0.075
//   MID     #6a707c     1.66:1      1.26:1        1.31x     typical mare, albedo ~0.095
//   FAINT   #878da0     1.17:1      1.14:1        1.02x     thin flooding, albedo ~0.105
//
// Exaggeration is 1.0–1.3×, inside the ~2× contrast licence; ordering follows
// titanium content. If restyled, keep the ordering and re-check the ratios: the
// highland base is near the top of the tone curve, so contrast comes only from
// darkening the mare, never brightening the ground.
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

// Elongated regions as real lat/lon FOOTPRINTS: the catalogued diameter is the
// long axis, so a circle would hang Procellarum off the west limb and blob Frigoris.
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

function moonProject(latDeg, lonDeg) {
  const lat = latDeg * DEG2RAD, lon = lonDeg * DEG2RAD;
  return { x: Math.cos(lat) * Math.sin(lon), y: -Math.sin(lat) };
}

/**
 * Project the real maria data into drawable ellipses. Exported so a test can
 * re-derive the layout and assert it still matches the published coordinates.
 * @returns {Array<{name,cx,cy,rx,ry,rot,color,alpha}>}
 */
export function projectMoonMaria(shrink = MOON_MARIA_SHRINK) {
  const out = [];
  for (const b of MOON_BASINS) {
    const { x, y } = moonProject(b.lat, b.lon);
    const d = Math.min(1, Math.hypot(x, y));
    // A circular feature at angular distance theta from the sub-Earth point is an
    // ellipse: full width tangentially, foreshortened by cos(theta) radially.
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
 * Opaque Moon disc with the real nearside maria (MOON_MARIA). Contrast is ~2×
 * real so the maria survive the ~1.5° apparent size. Deterministic (no
 * Math.random). The material MUST use NormalBlending (maria read as dark surface).
 * @param {number} size — canvas pixel dimensions
 */
export function createMoonDiscTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const R = half;

  // Base disc: alpha fades only in the outer ~8% of the radius (crisp edge).
  const base = ctx.createRadialGradient(half, half, 0, half, half, R);
  base.addColorStop(0.0,  'rgba(222, 222, 202, 1.0)');
  base.addColorStop(0.55, 'rgba(216, 216, 196, 1.0)');
  base.addColorStop(0.85, 'rgba(205, 205, 186, 1.0)');
  base.addColorStop(0.92, 'rgba(198, 198, 180, 1.0)');
  base.addColorStop(1.0,  'rgba(190, 190, 172, 0.0)');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  ctx.save();
  ctx.beginPath();
  ctx.arc(half, half, R * 0.995, 0, Math.PI * 2);
  ctx.clip();

  // Normalized coord (-1..1, +y down/south) → canvas px.
  const P = (n) => half + n * R;

  ctx.filter = `blur(${Math.round(R * MOON_MARIA_BLUR)}px)`; // soften mare edges

  // Ellipse rotated to its radial direction so limb features show foreshortening.
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

  // Tycho: bright southern crater with faint rays.
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

// Planet halo glow: white gradient fading to transparent at the edge (a flat
// additive disc gave a hard "black ring"); tinted per planet via material color.
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

// JUPITER BANDS + GREAT RED SPOT — exported so tests can measure feature sizes.
//
// Belts north→south. Each band is defined by its (wavy) TOP edge y0 (fraction
// of canvas height) and fills DOWN to the bottom; the next band overpaints it.
//
// Three bands, not eight: at Jupiter's 9 px disc a stripe needs 2 px, so each
// band is 0.22 of the disc height ≈ 2.0 px (eight bands averaged to a flat
// cream disc, 1.08:1 measured).
//
// Belt colours are DARKER than the real ones on purpose: between the ladder
// multiplier (×2.39) and ACES the authored contrast evaporates (real #b9835a
// lands at 1.17:1 against the zone). The zone is already at the top of the tone
// curve, so all contrast comes from darkening the belts: #74513a gives 1.6:1
// in the captured screenshot.
export const JUPITER_BASE = '#f2e6cf'; // polar/northern cream base
export const JUPITER_BANDS = [
  { y0: 0.215, color: '#74513a', amp: 0.0, freq: 0.0, ph: 0.0 }, // NEB (dark, prominent)
  { y0: 0.44, color: '#f6ecd6', amp: 0.0, freq: 0.0, ph: 0.0 }, // EZ (brightest, wide)
  { y0: 0.665, color: '#6a4832', amp: 0.0, freq: 0.0, ph: 0.0 }, // SEB (dark; same darkening ratio as NEB)
];
// Great Red Spot: centre (dx from disc centre, cy from canvas top) and radii as
// fractions of canvas size. 22% of the disc across (oversized vs real ~0.12) so
// it reaches 2.0 × 2.0 px at the 9.06 px disc; sits inside the SEB (cy 0.74;
// disc spans x 0.06–0.94 there, spot 0.55–0.77). No pale collar (it would be a
// 0.70 px ring); the spot reads by HUE (colour distance 75 of 441).
export const JUPITER_GRS = {
  dx: 0.16, cy: 0.74, rx: 0.115, ry: 0.115,
  collarColor: null, // dropped — sub-pixel at this budget
  stops: [0.0, 0.6, 1.0],
  colors: ['#cf6146', '#c04e34', '#9f4029'],
};

/**
 * Banded Jupiter disc with a Great Red Spot. Deterministic. For a CircleGeometry
 * disc (samples the inscribed circle), so detail is drawn inside a clipped circle.
 * @param {number} size — canvas pixel dimensions
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

  ctx.fillStyle = JUPITER_BASE;
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

  // Great Red Spot: inside the SEB, east of center; reads by hue, no clear space needed.
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
 * Ringed Saturn on a transparent square (for a PlaneGeometry billboard, so rings
 * can extend past the globe). Ring/globe overlap is faked by draw order: far ring
 * half → globe → near ring half, split along the tilted ring plane. Only two bands are drawn (bright inner, dimmer
 * outer) at the real outer extent: the four real parts (C ring, B ring, Cassini Division, A ring) are each under a
 * pixel at the 14 px span. Deterministic.
 * @param {number} size — canvas pixel dimensions
 */
export function createSaturnTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2;
  // Ring proportions come from bodyGeometry.SATURN_RING, which also derives the
  // elliptical depth mask, so the mask always matches the drawn rings.
  const globeR = size * SATURN_RING.globeFraction;  // ~2.27× ring span fits the square
  const rot = SATURN_RING.tilt;                     // ring-plane tilt (~ -19°, "wide open")
  const squash = SATURN_RING.squash;                // ring opening (minor/major)

  // Two bands (bright B ring, dimmer A ring) from the real B-ring inner edge (see SATURN_RING).
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

  drawRings(false); // far half, behind the globe

  // Globe: pale gold, soft shading, faint bands.
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
  // Ring shadow on the globe.
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#5f4e30';
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.ellipse(0, globeR * 0.16, globeR * 1.15, globeR * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1.0;

  drawRings(true); // near half, in front of the globe

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// MARS FEATURES — exported so tests can measure feature sizes.
//
// Mars is too small for spots (at radius 3.1 px a 2 px clear gap costs 0.64 of
// the radius; cap + patch + gap needs 1.93 radii, 1.70 available). It gets
// STRIPES, which need no clear space: zones of a third of the disc ≈ 2.07 px. Left out as under a pixel: the south
// cap, Hellas basin, Mare Erythraeum, the Acidalium hint, and the Syrtis flare.
//
// The dark band is DARKER than the real albedo feature (as Jupiter's belts):
// through the ×2.28 ladder multiplier and ACES, real #7c4a2c lands at 1.43:1
// against the rust base; #6f4229 lands at 1.5:1.
export const MARS_ZONES = [
  // No polar cap zone: authored '#f2f4fb' rendered rgb(255,191,242) (pink) because
  // ×2.28 clips red at 255 through ACES while blue survives. Solve any future cap
  // through the pipeline first.
  { y0: 1 / 3, y1: 2 / 3, color: '#6f4229' }, // dark albedo band (Syrtis Major)
  // below 2/3: the rust base shows through (the southern hemisphere)
];

/**
 * Rust-orange Mars disc with horizontal albedo zones. Deterministic; for a
 * CircleGeometry disc (detail clipped to inscribed circle).
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

  const base = ctx.createRadialGradient(half - R * 0.25, half - R * 0.25, R * 0.1, half, half, R);
  base.addColorStop(0.0, '#ff7a45');
  base.addColorStop(0.6, '#ef6234');
  base.addColorStop(1.0, '#cf4d28');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

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

// textureKey → factory lives HERE, not in bodyCatalog.js: the factories call
// document.createElement('canvas'), which would make the catalogue un-loadable in node.
// Mars/Jupiter are parked (kept exported).
const TEXTURE_FACTORIES = {
  mars: () => createMarsTexture(128),
  jupiter: () => createJupiterTexture(128),
  saturn: () => createSaturnTexture(256),
};
// Bodies whose HDR peak crosses the bloom threshold, derived from the pass's own
// curve and threshold (bodyCatalog.ladderBloomBodies), never a hardcoded "Venus".
// They keep the bloom gate alive independently of the sun.
const BLOOM_SOURCE_BODIES = new Set(ladderBloomBodies(
  Constants.BLOOM_THRESHOLD,
  Constants.STAR_MAG_BRIGHT_MIN, Constants.STAR_MAG_BRIGHT_MAX, Constants.STAR_MAG_BRIGHT_FLOOR_SOFT));
// Planet definitions: name, `hex` (tints disc and glow halo), angle from sun (deg).
// Every dimension (disc, halo, depth mask, Saturn ring + mask ellipse) is derived
// in bodyGeometry.planetGeometry from BODY_CATALOG's displayAngularDeg, so sizes
// have one source. Planets sit on the star size ladder (Venus ~9–10 px down to
// Mercury ~5 px); Saturn's small ringed disc is the ONE licensed size inversion.
const PLANET_DEFS = [
  { name: 'Mercury', hex: '#c7bfad', deg: Constants.PLANET_MERCURY_DEG },
  { name: 'Venus',   hex: '#ffffcc', deg: Constants.PLANET_VENUS_DEG },
  // #9c3133, not #ff6633: through the ×2.28 ladder multiplier + ACES, #ff6633 washes
  // out to rgb(255,172,111) (pale apricot); this lands at rgb(232,118,70).
  { name: 'Mars',    hex: '#9c3133', deg: Constants.PLANET_MARS_DEG },
  { name: 'Jupiter', hex: '#ffd699', deg: Constants.PLANET_JUPITER_DEG },
  { name: 'Saturn',  hex: '#f5e6c8', deg: Constants.PLANET_SATURN_DEG },
].map((def) => {
  const cat = bodyByName(def.name);
  const geo = planetGeometry({
    displayAngularDeg: cat.displayAngularDeg,
    dist: Constants.PLANET_DIST,
    maskDist: Constants.BODY_DEPTH_MASK_DIST,
    haloFactor: Constants.PLANET_GLOW_RADIUS_FACTOR,
    ringSpanAngularDeg: cat.ringSpanAngularDeg,
  });
  // HDR color multiplier B(mag) on the same skyBrightness curve as the stars,
  // applied to the tint; opacity is 1.0 (Constants.PLANET_DISC_OPACITY).
  const brightB = skyBrightness(cat.magnitude,
    Constants.STAR_MAG_BRIGHT_MIN, Constants.STAR_MAG_BRIGHT_MAX, Constants.STAR_MAG_BRIGHT_FLOOR_SOFT);
  return Object.assign({}, def, {
    geo,
    radius: geo.radius,
    brightB,
    bloomSource: BLOOM_SOURCE_BODIES.has(def.name),
    makeTexture: cat.textureKey ? TEXTURE_FACTORIES[cat.textureKey] : undefined,
  });
});

/** Shared material for depth-only occlusion masks (invisible, writes depth). */
const DEPTH_MASK_MAT = new THREE.MeshBasicMaterial({
  colorWrite: false,
  depthWrite: true,
});

// Depth-mask distance: must be slightly INSIDE the star sphere (STAR_SPHERE_RADIUS = 400)
// so masks occlude stars.

const DEPTH_MASK_DIST = Constants.BODY_DEPTH_MASK_DIST;

export class SunLight {
  /**
   * @param {import('./SceneManager.js').SceneManager} [sceneManager] — needed for bloom, camera, renderer
   */
  constructor(scene, sceneManager) {
    this.scene = scene;
    this.camera = sceneManager ? sceneManager.getCamera() : null;
    this.renderer = sceneManager ? sceneManager.getRenderer() : null;
    this.elapsedTime = 0;

    this.sunOrbitPeriod = Constants.ORBITAL_PERIOD_400KM;

    this.directionalLight = new THREE.DirectionalLight(0xffffff, 2.0);
    this.directionalLight.name = 'SunLight';

    this.sunDirection = new THREE.Vector3(1, 0.3, 0.5).normalize();

    // Real-clock sky seeding: these defaults are the fallback sky; _seedSkyFromClock()
    // overrides them so sun + moon match the player's actual date/time (sub-solar
    // point from UTC, today's lunar phase). The stylized 92-min cycle runs on from there.
    this._sunPhase0 = 0;                        // parametric start angle on the sun circle
    this._sunYaw0 = 0;                          // yaw (about +Y) to the real sub-solar longitude
    this._moonAzOffset = degToRad(110);   // legacy fixed elongation fallback
    this._moonTanDecl = 0.25;                   // legacy y-lift fallback (≈14°)
    this._seedSkyFromClock(new Date());

    this._updateLightPosition();
    scene.add(this.directionalLight);

    // Subtle hemisphere light for night-side / eclipse readability; preferred over
    // flat ambient because it keeps up/down shaping.
    this.hemiLight = new THREE.HemisphereLight(
      0x4488bb, // sky color
      0x111122, // ground color
      0.10
    );
    scene.add(this.hemiLight);

    this._createSunDisc(sceneManager);
    this._createLensFlare(sceneManager);
    this._createMoon();
    this._createPlanets();

    this._currentExposure = 1.0;
    this._inShadow = false;

    this._camForward = new THREE.Vector3();

    this._occToEarth = new THREE.Vector3();
    this._occToBody = new THREE.Vector3();

    // Hot-path temps (no per-frame allocation). Reuse is safe: every consumer
    // .copy()s out of a temp before the next method reuses it.
    this._bodyPos = new THREE.Vector3();   // sun/moon/planet world-pos temp
    this._bodyDir = new THREE.Vector3();   // moon direction temp
    this._downTmp = new THREE.Vector3();   // camera-relative "below" temp
    this._labelTmp = new THREE.Vector3();  // per-label offset temp
    this._sunDirView = new THREE.Vector3(); // sun dir in view space (moon shader)
    this._camQuatInv = new THREE.Quaternion(); // inverse camera quat (moon shader)
  }

  _createSunDisc(sceneManager) {
    const texture = createSunDiscTexture(256);

    // Sun/Moon parity, glare/mask reconciliation and bloom all derive from ONE
    // catalogue angular size via bodyGeometry.sunGeometry.
    const sunGeo = sunGeometry({
      displayAngularDeg: bodyByName('Sun').displayAngularDeg,   // 1.49°, Moon parity
      dist: Constants.SUN_DIST,
      maskDist: DEPTH_MASK_DIST,
      visibleAlpha: Constants.SUN_GLARE_VISIBLE_ALPHA,
    });

    // HDR core so the Sun blooms (an LDR sprite cannot reach the 2.5 threshold).
    // Divide the tint by its own peak channel so the rendered peak lands EXACTLY on
    // SUN_HDR_PEAK with hue preserved; additive blending contributes
    // colour × texture.a × opacity, hence the /opacity.
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
      depthTest: false,          // the mask is closer than the body; don't self-occlude
    }));
    this.sunSprite.scale.set(sunGeo.spriteScale, sunGeo.spriteScale, 1);   // sprite scale = full width
    this.sunSprite.name = 'SunDisc';
    this.scene.add(this.sunSprite);

    // Depth mask: sized to the VISIBLY GLOWING extent (0.90 of the sprite = 1.341°),
    // not the sprite square: the texture reaches alpha 0 at its rim, so a full-sprite
    // mask deleted stars from a ring of empty sky.
    this._sunDepthMask = new THREE.Mesh(
      new THREE.CircleGeometry(sunGeo.maskRadius, 32),
      DEPTH_MASK_MAT
    );
    this._sunDepthMask.renderOrder = -1;
    this._sunDepthMask.onBeforeRender = (_r, _s, cam) => this._sunDepthMask.lookAt(cam.position);
    this.scene.add(this._sunDepthMask);

    this._sunLabel = new THREE.Sprite(new THREE.SpriteMaterial({
      map: createPlanetLabelTexture('Sun'),
      transparent: true, opacity: Constants.BODY_LABEL_OPACITY, depthWrite: false, depthTest: true,
    }));
    this._sunLabel.scale.set(Constants.BODY_LABEL_SCALE_X, Constants.BODY_LABEL_SCALE_Y, 1);
    this._sunLabel.renderOrder = 10;
    this._sunLabel.frustumCulled = false;
    this.scene.add(this._sunLabel);

    if (sceneManager) sceneManager.enableBloom(this.sunSprite);
  }

  /** 3 lens flare sprites along the sun→camera line. */
  _createLensFlare(sceneManager) {
    this.flareGroup = new THREE.Group();
    this.flareGroup.name = 'LensFlareGroup';

    // Eyeball-tuned so flares aren't lost next to the ~15-unit sun disc; the
    // flare/sun ratio is intentionally subtle.
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

  /** Moon disc (CircleGeometry, not Sprite: no billboard rectangle artifacts); no bloom. */
  _createMoon() {
    // The ShaderMaterial shades the maria texture with a reconstructed sphere
    // normal, so crescent horns, the elliptical terminator and the gibbous bulge
    // fall out of the dot product. Radius + mask derive from BODY_CATALOG via bodyGeometry.
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
        // Sun direction in VIEW space: the mesh copies the camera quaternion, so its
        // local axes ARE the view axes.
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
      depthTest: false,          // the mask is closer than the body; don't self-occlude
      side: THREE.DoubleSide,
    });
    this.moonMesh = new THREE.Mesh(moonGeoBuf, this._moonMaterial);
    this.moonMesh.name = 'Moon';
    // Roll-compensated billboard: copy the camera's orientation so the maria stay
    // upright to the viewer (lookAt() would anchor up to world +Y, but the
    // gameplay camera's up is Earth-radial, so the moon would appear rolled).
    // LICENSED: real libration would tilt the maria; upright is a readability
    // choice. It also makes the shader's view-space sun direction correct.
    //
    // uSunDirView is computed HERE, not in _updateMoon: the quaternion copy and the
    // uniform must read the SAME camera quaternion in the SAME frame, or the
    // terminator lags the texture by a frame. onBeforeRender runs with the exact camera.
    this.moonMesh.onBeforeRender = (renderer, scene, camera) => {
      this.moonMesh.quaternion.copy(camera.quaternion);
      this._camQuatInv.copy(camera.quaternion).invert();
      this._sunDirView.copy(this.sunDirection).applyQuaternion(this._camQuatInv);
      this._moonMaterial.uniforms.uSunDirView.value.copy(this._sunDirView);
    };
    this.scene.add(this.moonMesh);

    // Depth mask radius matches the moon's opaque core at DEPTH_MASK_DIST.
    this._moonDepthMask = new THREE.Mesh(
      new THREE.CircleGeometry(moonGeo.maskRadius, 32),
      DEPTH_MASK_MAT
    );
    this._moonDepthMask.renderOrder = -1;
    this._moonDepthMask.onBeforeRender = (_r, _s, cam) => this._moonDepthMask.lookAt(cam.position);
    this.scene.add(this._moonDepthMask);

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

  /**
   * Seed the stylized sky from the real one: the sun starts over the actual
   * sub-solar point for `now`; the moon starts at its real elongation +
   * declination (today's phase falls out of _updateMoon's dot product).
   * The per-frame model is unchanged (circle tilted SUN_CYCLE_TILT, ~92-min
   * period). Solves it for (a) the phase whose declination matches today's, on
   * the branch matching the seasonal trend, and (b) a fixed yaw about +Y to the
   * real sub-solar longitude. A seed, not a live ephemeris: game and wall clock
   * diverge immediately (TIME_SCALE_GAMEPLAY).
   * Failure-safe: an exception leaves the fixed-sky defaults intact.
   * @param {Date} now — real wall-clock time (UTC-based internally)
   */
  _seedSkyFromClock(now) {
    try {
      const sun = sunEphemeris(now);
      const moon = moonEphemeris(now);
      const s = latLonToUnitVec(sun.declDeg, sun.subLonEastDeg);

      // (a) Real |declination| ≤ 23.44° < SUN_CYCLE_TILT (23.49°): the clamp never bites in practice.
      const ratio = clamp(s.y / Math.sin(SUN_CYCLE_TILT), -1, 1);
      let a0 = Math.asin(ratio);
      const declTomorrow =
        sunEphemeris(new Date(now.getTime() + 86400000)).declDeg;
      if (declTomorrow < sun.declDeg) a0 = Math.PI - a0; // southbound branch

      // (b) Azimuth is atan2(z, x) in the equatorial plane.
      const bx = Math.cos(a0);
      const bz = Math.sin(a0) * Math.cos(SUN_CYCLE_TILT);
      this._sunPhase0 = a0;
      this._sunYaw0 = Math.atan2(s.z, s.x) - Math.atan2(bz, bx);
      this.sunDirection.set(s.x, s.y, s.z).normalize();

      // Moon: azimuth offset from the sun + tan(declination) y-lift; _updateMoon()
      // keeps this offset, so today's phase persists all session.
      const m = latLonToUnitVec(moon.declDeg, moon.subLonEastDeg);
      this._moonAzOffset =
        Math.atan2(m.z, m.x) - Math.atan2(s.z, s.x);
      this._moonTanDecl = Math.tan(degToRad(moon.declDeg));
    } catch (e) {
      console.warn('[SunLight] Real-clock sky seeding failed; using stylized defaults:', e);
    }
  }

  /**
   * Stage the opening light for a FRESH game start only (GameFlowManager's
   * MENU_START / MENU_FAST_START; never saved-game loads, later missions or
   * mid-session). One-time yaw offset on the real-clock seed so the spawn starts
   * on the day side (math in sunStaging.js). Only _sunYaw0 moves; phase, cycle
   * speed and the moon's elongation are untouched and the sun keeps cycling.
   * LAUNCH_CAMEO is unaffected: its gates are pure camera geometry and its plume
   * brightness handles day and night.
   * @param {{x:number,y:number,z:number}} spawnPos — spawn scene position (direction matters, not length)
   */
  stageOpeningLight(spawnPos) {
    if (!spawnPos) return;
    const yaw = stagedSunYaw(this.sunDirection, spawnPos, OPENING_SUN_TARGET_DOT);
    if (!Number.isFinite(yaw) || yaw === 0) return;
    this._sunYaw0 += yaw;
    // Rotate the live direction now so same-frame consumers agree; the next
    // update() recomputes the identical direction (rotateAboutY IS update()'s yaw).
    const d = rotateAboutY(this.sunDirection, yaw);
    this.sunDirection.set(d.x, d.y, d.z).normalize();
    this._updateLightPosition();
  }

  _updateLightPosition() {
    const sunDistance = 200;
    this.directionalLight.position.copy(
      this.sunDirection.clone().multiplyScalar(sunDistance)
    );
    this.directionalLight.target.position.set(0, 0, 0);
  }

  /**
   * Sun direction `aheadRealS` REAL seconds from now: the per-frame formula at
   * elapsedTime + aheadRealS. PURE (no state changes); the ONE formula shared by
   * update() and the eclipse predictor (OrbitalMechanics.nextShadowTransition).
   * REAL seconds because update(dt) gets the real frame dt: the sun never warps
   * with the floor's time cap (the orbit does: dtWorld = realDt × BASE_SCALE × rate).
   *
   * @param {number} aheadRealS  real seconds ahead (0 = now)
   * @param {THREE.Vector3|{x:number,y:number,z:number}} [out]  written and
   *   returned (a plain {x,y,z} is written directly); absent → new THREE.Vector3
   * @returns {THREE.Vector3|{x:number,y:number,z:number}} the unit direction
   */
  directionAt(aheadRealS, out) {
    const ahead = Number.isFinite(aheadRealS) ? aheadRealS : 0;
    // Stylized ~92-min circle: phase starts at _sunPhase0 (today's declination),
    // yawed by _sunYaw0 (today's sub-solar longitude); see _seedSkyFromClock().
    const angularSpeed = (2 * Math.PI) / this.sunOrbitPeriod;
    const angle = this._sunPhase0 +
      (this.elapsedTime + ahead) * angularSpeed * TimeAuthority.BASE_SCALE;

    const bx = Math.cos(angle);
    const by = Math.sin(SUN_CYCLE_TILT) * Math.sin(angle);
    const bz = Math.sin(angle) * Math.cos(SUN_CYCLE_TILT);
    const cy = Math.cos(this._sunYaw0);
    const sy = Math.sin(this._sunYaw0);
    const x = bx * cy - bz * sy, y = by, z = bx * sy + bz * cy;
    const o = out || new THREE.Vector3();
    if (typeof o.set === 'function' && typeof o.normalize === 'function') {
      return o.set(x, y, z).normalize();
    }
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    o.x = x / len; o.y = y / len; o.z = z / len;
    return o;
  }

  /**
   * @param {number} dt — real frame delta (s)
   * @param {THREE.Vector3} [cameraPos] — player camera position for eclipse check
   * @returns {THREE.Vector3} current sun direction (normalized)
   */
  update(dt, cameraPos) {
    this.elapsedTime += dt;

    this.directionAt(0, this.sunDirection);

    this._updateLightPosition();

    this._inShadow = false;
    if (cameraPos) {
      this._inShadow = this._isInEarthShadow(cameraPos);
      const targetIntensity = this._inShadow ? 0.05 : 1.5;
      this.directionalLight.intensity +=
        (targetIntensity - this.directionalLight.intensity) * Math.min(1, dt * 3);
    }

    this._updateSunDisc();
    this._updateLensFlare();
    this._updateMoon();
    this._updatePlanets();
    this._updateAutoExposure(dt);

    return this.sunDirection;
  }

  _updateSunDisc() {
    // Camera-relative placement: the disc sits along the sun direction *from the
    // camera*, so its apparent direction equals the lighting's uSunDirection
    // (no parallax toward Earth); the disc breaches the limb exactly when the
    // ocean-glint NdotL gate turns on. Origin-relative when the camera is null
    // (menu/first frames); occlusion then uses _inShadow. Only the sun is
    // special-cased: moon/planets stay origin-centered.
    const sunPos = this.camera
      ? this._bodyPos.copy(this.sunDirection).multiplyScalar(Constants.SUN_DIST).add(this.camera.position)
      : this._bodyPos.copy(this.sunDirection).multiplyScalar(Constants.SUN_DIST);
    this.sunSprite.position.copy(sunPos);

    const sunHidden = this.camera
      ? this._isOccludedByEarth(this.sunSprite.position, this.camera.position)
      : this._inShadow;
    this.sunSprite.visible = !sunHidden;

    // Depth mask is camera-relative: a fixed origin-centered DEPTH_MASK_DIST fails
    // at altitude (stars along the sun direction can be as close as R − camDist,
    // *in front of* the mask). Solve the camera→star-shell ray for length t, place
    // the mask at 0.98·t, rescale to keep the angular size (built for DEPTH_MASK_DIST).
    if (this._sunDepthMask) {
      if (this.camera) {
        const R = Constants.STAR_SPHERE_RADIUS;
        const cam = this.camera.position;
        const s = cam.dot(this.sunDirection);
        const disc = R * R - cam.lengthSq() + s * s;
        if (disc <= 0) {
          // Camera at/outside the star shell (not expected in gameplay).
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

    if (this._sunLabel) {
      const down = this._downTmp.set(0, -1, 0);
      if (this.camera) down.applyQuaternion(this.camera.quaternion);
      this._sunLabel.position.copy(sunPos).add(down.multiplyScalar(Constants.SUN_LABEL_OFFSET));
      this._sunLabel.visible = !sunHidden && !this._labelsHidden;
    }
  }

  _updateLensFlare() {
    if (!this.camera) {
      this.flareGroup.visible = false;
      return;
    }

    if (this._inShadow || !this.sunSprite.visible) {
      this.flareGroup.visible = false;
      return;
    }
    this.flareGroup.visible = true;

    // Camera-relative sun position, as in _updateSunDisc.
    const camPos = this.camera.position;
    const sunPos = this._bodyPos.copy(this.sunDirection).multiplyScalar(Constants.SUN_DIST).add(camPos);

    this._camForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const sunDot = this._camForward.dot(this.sunDirection);

    const flareFade = THREE.MathUtils.smoothstep(sunDot, 0.3, 0.9);

    this.flareSprites.forEach(sprite => {
      const t = sprite.userData.fraction;
      sprite.position.lerpVectors(sunPos, camPos, t);
      sprite.material.opacity = sprite.userData.baseOpacity * flareFade;
    });
  }

  _updateMoon() {
    // Real elongation + declination captured at startup (_seedSkyFromClock) ride
    // the sun's fast cycle, so the phase is constant all session. Near full moon
    // the elongation approaches 180° (opposite the sun): correct, the Earth
    // occlusion check below hides it when Earth is in the way. The fixed 110°
    // offset is the fallback if seeding failed.
    const sunAngle = Math.atan2(this.sunDirection.z, this.sunDirection.x);
    const moonAngle = sunAngle + this._moonAzOffset;
    const moonDir = this._bodyDir.set(
      Math.cos(moonAngle),
      // tan(declination) lift (normalized below) + slow libration-like wobble
      this._moonTanDecl + Math.sin(this.elapsedTime * 0.0001) * 0.05,
      Math.sin(moonAngle)
    ).normalize();

    // Origin-centered (not camera-relative like the sun); parallax is negligible.
    const moonPos = this._bodyPos.copy(moonDir).multiplyScalar(Constants.MOON_DIST);
    this.moonMesh.position.copy(moonPos);

    if (this._moonDepthMask) {
      this._moonDepthMask.position.copy(moonDir).multiplyScalar(DEPTH_MASK_DIST);
    }

    // Phase is rendered by the shader from uSunDirView (set in onBeforeRender), not
    // by dimming the disc; the unlit limb gets MOON_EARTHSHINE, not an opacity floor.
    // sunDir·moonDir = cos(elongation): +1 beside the sun (new), −1 opposite (full).

    // Label is camera-relative "below": no parallax at any orbital orientation.
    if (this._moonLabel) {
      const down = this._downTmp.set(0, -1, 0);
      if (this.camera) down.applyQuaternion(this.camera.quaternion);
      this._moonLabel.position.copy(moonPos).add(down.multiplyScalar(Constants.MOON_LABEL_OFFSET));  // ≈ radius + 8, matches planet convention
      if (!this._moonLabelLogged) {
        console.log('[SunLight] Moon label pos:', this._moonLabel.position.toArray().map(v => v.toFixed(1)), 'visible:', this._moonLabel.visible);
        this._moonLabelLogged = true;
      }
    }

    // Earth occlusion: opacity carries only the LIMB FADE near Earth's angular
    // edge; mask/label keep binary visibility.
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

  /**
   * 5 planets as billboard discs with glow halos and labels. Flat-tinted
   * CircleGeometry, except Saturn (its rings need a full-square PlaneGeometry,
   * `def.geo.planeSize`). Each disc carries the HDR ladder B(mag) as a color
   * multiplier, so Venus blooms and the rest stay under the threshold.
   */
  _createPlanets() {
    this._planets = PLANET_DEFS.map(def => {
      // Flat bodies tint with their hex; textured Saturn uses a white base. The
      // multiplier is brightB / maxChannel: the peak channel lands EXACTLY on B(mag)
      // with hue preserved (a dark tint like Mercury's #c7bfad would otherwise
      // render dimmer than Rigel despite being brighter, mag −0.4 vs +0.13).
      // Saturn: maxChannel is 1, so the peak is B(mag) × texture peak.
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
          depthTest: false,      // the mask is closer than the body; don't self-occlude
        })
      );
      // Roll-compensated billboard (see the Moon note in _createMoon).
      disc.onBeforeRender = (_r, _s, cam) => disc.quaternion.copy(cam.quaternion);
      this.scene.add(disc);

      // Glow halo radius derives from the body (1.25×); for Saturn it spans the rings.
      const haloRadius = def.geo.haloRadius;
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(haloRadius * 2, haloRadius * 2),
        new THREE.MeshBasicMaterial({
          map: _planetGlowTex || (_planetGlowTex = createPlanetGlowTexture()),
          color: new THREE.Color(def.hex), transparent: true, opacity: Constants.PLANET_GLOW_OPACITY,
          side: THREE.DoubleSide, depthWrite: false,
          depthTest: false,      // as the disc
          blending: THREE.AdditiveBlending,
        })
      );
      glow.renderOrder = -1;
      glow.onBeforeRender = (_r, _s, cam) => glow.quaternion.copy(cam.quaternion);
      this.scene.add(glow);

      const label = new THREE.Sprite(new THREE.SpriteMaterial({
        map: createPlanetLabelTexture(def.name),
        transparent: true, opacity: Constants.BODY_LABEL_OPACITY, depthWrite: false,
      }));
      label.scale.set(Constants.BODY_LABEL_SCALE_X, Constants.BODY_LABEL_SCALE_Y, 1);
      label.frustumCulled = false;
      this.scene.add(label);

      // Depth mask: circular for normal planets. Saturn's must cover the RING
      // PLANE or stars shine through the rings: an ELLIPSE matching the texture's
      // tilt/squash, billboarded with the camera quaternion like the disc (a
      // lookAt() mask would roll away from the rings).
      let depthMask;
      if (def.geo.planeSize) {
        const maskGeo = new THREE.CircleGeometry(def.geo.ringMaskMajor, 24);
        // The minor axis is FLOORED at the globe radius in bodyGeometry: a pure ring
        // ellipse is thinner than the globe and would leave slivers unmasked.
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

  _updatePlanets() {
    if (!this._planets) return;

    // Planets sit on the ecliptic (XZ plane) at fixed angles from the sun.
    const sunAngle = Math.atan2(this.sunDirection.z, this.sunDirection.x);
    const _pos = this._bodyPos;

    // Camera-relative "below": no parallax between disc and label.
    const _down = this._downTmp.set(0, -1, 0);
    if (this.camera) _down.applyQuaternion(this.camera.quaternion);

    for (const p of this._planets) {
      const angle = sunAngle + p.deg * DEG2RAD;
      _pos.set(Math.cos(angle), 0, Math.sin(angle));

      p.disc.position.copy(_pos).multiplyScalar(Constants.PLANET_DIST);
      if (p.depthMask) p.depthMask.position.copy(_pos).multiplyScalar(DEPTH_MASK_DIST);
      p.glow.position.copy(_pos).multiplyScalar(Constants.PLANET_GLOW_DIST);  // slightly behind disc
      _pos.multiplyScalar(Constants.PLANET_DIST);  // restore for label calc

      const labelOffset = p.radius + Constants.PLANET_LABEL_OFFSET;
      p.label.position.copy(_pos).add(this._labelTmp.copy(_down).multiplyScalar(labelOffset));

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
   * Pane-density "sky labels" rung: show/hide the name labels (Sun, Moon,
   * planets; discs stay). Hiding is immediate; showing is re-derived on the next update.
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
   * Sun disc not occluded by Earth (set each frame by _updateSunDisc). NOT the
   * bloom gate: use isBloomSourceVisible(), since the sun is no longer the only
   * thing that can bloom (Venus, B 2.74).
   */
  isSunVisible() {
    return !!(this.sunSprite && this.sunSprite.visible);
  }

  /**
   * Whether ANY source that can cross the bloom threshold is on screen: the
   * input to SceneManager.setBloomEnabled(). Two independent families:
   *  1. sun-driven (atmosphere Mie limb ≈ 2.7, ocean glint ≈ 2.2–2.7), gated by
   *     the sun's visibility;
   *  2. laddered BODIES above Constants.BLOOM_THRESHOLD (Venus, B 2.74), visible
   *     independently of the sun (Venus at a fixed 40° elongation can be clear
   *     of the limb while the sun is behind it). The list derives from the curve
   *     and threshold (BLOOM_SOURCE_BODIES), so a retune cannot desync it.
   * The gate still saves ~1.35 ms (mip-chain skip) when neither is up (deep night, eclipse).
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

  /** Eases renderer exposure by camera-sun alignment (looking at the sun → dimmer). */
  _updateAutoExposure(dt) {
    if (!this.camera || !this.renderer) return;

    this._camForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const sunDot = this._camForward.dot(this.sunDirection);

    // Under ACES the filmic shoulder makes values >1 usable. Away-from-sun is only
    // 1.05: a bigger boost fires exactly when the day-side disc is fully lit and
    // washes the frame; 1.05 keeps metallic ship/debris readable.
    let targetExposure;
    if (this._inShadow) {
      targetExposure = 1.25;  // in Earth's shadow: eye adaptation
    } else if (sunDot > 0.85) {
      targetExposure = 0.85;  // facing the sun
    } else if (sunDot < 0.3) {
      targetExposure = 1.05;  // facing away
    } else {
      // transition zone [0.3, 0.85]
      const t = (sunDot - 0.3) / (0.85 - 0.3);
      targetExposure = THREE.MathUtils.lerp(1.05, 0.85, t);
    }

    // dt-normalized exponential decay, k = 1.2/s: adaptation is refresh-rate independent.
    const adapt = 1 - Math.exp(-1.2 * dt);
    this._currentExposure = THREE.MathUtils.lerp(
      this._currentExposure, targetExposure, adapt
    );
    this.renderer.toneMappingExposure = this._currentExposure;
  }

  /**
   * True if `bodyPos` is behind Earth's angular disc from `cameraPos` (world).
   * Geometric CPU-side test: bodies with depthTest:false (moon, planets) cannot
   * be occluded by the depth buffer.
   */
  _isOccludedByEarth(bodyPos, cameraPos) {
    const earthRadius = Constants.EARTH_RADIUS;
    const camDist = cameraPos.length(); // camera to Earth center (origin)
    if (camDist <= earthRadius) return false;

    const earthAngularRadius = Math.asin(earthRadius / camDist);

    const toEarth = this._occToEarth.copy(cameraPos).negate().normalize();

    // length before normalizing
    const toBody = this._occToBody.subVectors(bodyPos, cameraPos);
    const bodyDist = toBody.length();
    toBody.normalize();

    const angle = Math.acos(Math.max(-1, Math.min(1, toEarth.dot(toBody))));

    // Occluded: inside Earth's angular disc AND farther than the Earth surface.
    const earthSurfaceDist = camDist - earthRadius;
    return angle < earthAngularRadius && bodyDist > earthSurfaceDist;
  }

  /**
   * Fade factor in [0, 1]: 1 while the body is clear of Earth's disc, ramping to
   * 0 as its angular separation from Earth-center drops from 1.3× to 1.0× Earth's
   * angular radius (where _isOccludedByEarth takes over; avoids a pop). Reuses
   * the occlusion temp vectors (safe: only called adjacent to the occlusion test).
   */
  _earthLimbFadeFactor(bodyPos, cameraPos) {
    const earthRadius = Constants.EARTH_RADIUS;
    const camDist = cameraPos.length();
    if (camDist <= earthRadius) return 1;
    const earthAngularRadius = Math.asin(earthRadius / camDist);
    const toEarth = this._occToEarth.copy(cameraPos).negate().normalize();
    const toBody = this._occToBody.subVectors(bodyPos, cameraPos).normalize();
    const angle = Math.acos(Math.max(-1, Math.min(1, toEarth.dot(toBody))));
    return THREE.MathUtils.clamp((angle - earthAngularRadius) / (0.3 * earthAngularRadius), 0, 1);
  }

  /** Earth's shadow, cylindrical approximation; `pos` is world. */
  _isInEarthShadow(pos) {
    const sunDot = pos.dot(this.sunDirection);
    if (sunDot > 0) return false;

    const projOnSun = this.sunDirection.clone().multiplyScalar(sunDot);
    const perpendicular = pos.clone().sub(projOnSun);
    return perpendicular.length() < Constants.EARTH_RADIUS;
  }

  getSunDirection() {
    return this.sunDirection.clone();
  }
}

export default SunLight;
