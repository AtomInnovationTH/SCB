/**
 * Starfield.js — 10,000 background stars (the 49 named catalogue stars sit at
 * the constellation vertices in the same Points), a procedural Milky Way band,
 * a shooting star, 8 constellation outlines and labels.
 *
 * The whole sky lives in one group ('StarfieldGroup'), world-fixed at the
 * origin by default; see setFollowCamera.
 * @module scene/Starfield
 */

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { Constants } from '../core/Constants.js';
import { BRIGHT_STARS, CONSTELLATION_FIGURES, sampleFieldMagnitude, fieldSizeAlpha, skyBrightness, galacticBasis, mwCenterProfile, mwGreatRiftMask, mwDensity, raDecToUnit } from './starCatalog.js';

/**
 * RA (hours, 0–24) and Dec (degrees) to cartesian on the star sphere.
 * Convention: +Y is celestial north, RA 0 at +X, Z negated. Exported so the
 * `?shot=1` sky-pose hook in main.js reuses it (this basis is easy to get wrong).
 */
export function raDec2xyz(raHours, decDeg, radius) {
  const ra = raHours * (Math.PI / 12);   // hours → radians
  const dec = decDeg * (Math.PI / 180);  // degrees → radians
  return new THREE.Vector3(
    radius * Math.cos(dec) * Math.cos(ra),
    radius * Math.sin(dec),
    -radius * Math.cos(dec) * Math.sin(ra)
  );
}

/**
 * Planetarium-style label texture for a constellation name. 2048×512: the
 * sprite spans ~80–150 screen px and the GPU samples mip1/mip2 at pr=1.5, so a
 * 2048-px base keeps mip1 at 1024 px. Cost 16 MB VRAM across 8 labels.
 */
function createConstellationLabel(text) {
  const c = document.createElement('canvas');
  c.width = 2048; c.height = 512;
  const ctx = c.getContext('2d');
  // Weight 700 and no shadow: at pr=1.5 without SMAA, mip sampling plus a glow
  // shadow blurred the glyph edge; thick strokes survive mip sampling.
  ctx.font = '700 224px Arial, "Helvetica Neue", Helvetica, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#8792a8';
  ctx.globalAlpha = 1.0;
  ctx.fillText(text, 1024, 256);
  return new THREE.CanvasTexture(c);
}

// STEADY SPRITE PROFILE
// A point sprite narrower than ~2 device px is rasterized on a fragment lattice:
// as a star slides sub-pixel its pixel centres move in and out of the bright
// core, so its summed light swings by 100 %+ (measured on the menu sky, DPR 2 /
// renderer ratio 1.5: field-star p50 (max-min)/mean 0.62; DPR 1: 3.2). The cure
// is a Gaussian footprint whose sigma is >= ~0.6 canvas px (a unit-lattice sum
// of a Gaussian is constant to 2*exp(-2*pi^2*sigma^2) per axis; 0.9 px when the
// browser stretches the canvas by a non-integer factor), drawn at a minimum
// diameter, with alpha scaled by (size / drawn size)^2 so TOTAL light is
// unchanged. Faintness stays in aAlpha.
// Per-star aGain: stars sit in the convex toe of the ACES curve, so the same
// light spread over more pixels shows DIMMER (field stars 0.40x on DPR 1, 0.83x
// on DPR 2 without it). steadyGain() matches each star's DISPLAYED light (ACES +
// sRGB + the browser's canvas stretch) to the old sprite's sub-pixel average.
/** Smallest Gaussian sigma in canvas px when the canvas reaches the screen 1:1 (or 2:1, 3:1). */
export const STAR_SIGMA_PX = 0.6;
/**
 * Smallest sigma when the browser stretches the canvas by a NON-integer factor
 * (DPR 2 drawn at the 1.5 cap = 4/3): its bilinear stretch, done on sRGB values,
 * beats with the star's motion; 0.6 px still swings ~25 %, 0.9 px ~10 % (model,
 * tmp/probes/st10/scan3.mjs; whole-number stretches behave like 1:1).
 */
export const STAR_SIGMA_PX_BEAT = 0.9;
/** Sigma as a fraction of the minimum sprite radius: the sprite square holds +-2.67 sigma. */
export const STAR_SPRITE_SPAN = 0.375;
/** Minimum drawn sprite diameter in canvas px for a 1:1 canvas (3.2); 4.8 under a 4/3 stretch. */
export const STAR_MIN_DRAWN_PX = 2 * STAR_SIGMA_PX / STAR_SPRITE_SPAN;
/** Smallest sigma (canvas px) for a browser stretch = devicePixelRatio / renderer pixel ratio. */
export function steadySigmaPx(stretch = 1) { return Math.abs(stretch - Math.round(stretch)) < 0.02 ? STAR_SIGMA_PX : STAR_SIGMA_PX_BEAT; }
/** Minimum drawn diameter (canvas px) for a browser stretch. */
export function steadyMinDia(stretch = 1) { return 2 * steadySigmaPx(stretch) / STAR_SPRITE_SPAN; }
/** Sigma (fraction of the radius) of the Gaussian that has the old sprite's total light at peak 1 — the large-star shape. */
export const STAR_SIGMA_MATCH = 0.3;
/**
 * Tone-mapping exposure the per-star gain is calibrated at: the menu's 1.05,
 * the away-from-sun `targetExposure` of SunLight._updateAutoExposure
 * (test-StarSteady.js pins it). Fixed, not tracked per frame.
 */
export const STEADY_GAIN_EXPOSURE = 1.05;

/** The old sprite profile: smoothstep(1,0,r) squared (the hard core). */
export function oldProfile(r) { const t = Math.min(1, Math.max(0, 1 - r)); const s = t * t * (3 - 2 * t); return s * s; }
/** Total light of the old profile over the unit disc (midpoint rule). */
export function oldProfileLight() { let a = 0; const n = 4000; for (let i = 0; i < n; i++) { const r = (i + 0.5) / n; a += oldProfile(r) * r; } return 2 * Math.PI * a / n; }
/** Gaussian fraction-of-radius sigma for a sprite drawn `drawnPx` wide: >= sigmaPx canvas px, never narrower than the old-shape match. */
export function steadySigma(drawnPx, sigmaPx = STAR_SIGMA_PX) { return Math.max(STAR_SIGMA_MATCH, sigmaPx / (0.5 * drawnPx)); }
/** The steady profile (peak 1 before amplitude), truncated to reach exactly 0 at r = 1. */
export function steadyProfile(r, sigma) {
  const e0 = Math.exp(-1 / (2 * sigma * sigma));
  return Math.max(0, (Math.exp(-(r * r) / (2 * sigma * sigma)) - e0) / (1 - e0));
}
/** Peak scale giving the steady profile the SAME total light as the old one at equal size (closed form; the shader repeats it). */
export function steadyAmplitude(sigma) {
  const e0 = Math.exp(-1 / (2 * sigma * sigma));
  const lightUnit = 2 * Math.PI * (sigma * sigma - e0 / (2 * (1 - e0)));   // integral of steadyProfile over the unit disc
  return oldProfileLight() / lightUnit;
}

/**
 * three.js ACESFilmicToneMapping on a grey value at exposure 1 (the game's
 * OutputPass curve). Exposure is separate: gains are calibrated at
 * STEADY_GAIN_EXPOSURE. Gameplay auto-exposure runs 0.85-1.25 (SunLight), which
 * shifts steady-star light against the old sprite by about -3 % (median) at
 * 0.85 and +5 % at 1.25 (measured with this JS twin).
 * COUPLED: if SceneManager stops using ACES, steadyGain() matches the wrong
 * curve (test-StarSteady.js pins the pairing).
 */
export function acesFilmic(x) {
  const v = x / 0.6;
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return Math.min(1, Math.max(0, a / b));
}
const _srgbEnc = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
const _srgbDec = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * Displayed light of one sprite at one sub-pixel offset: canvas pixels -> ACES
 * -> sRGB; when `stretch` > 1 the encoded image is bilinearly stretched (what
 * the browser does to a canvas drawn below devicePixelRatio), decoded, summed.
 * @param {Float64Array} base  scene-linear values on an n x n pixel grid
 * @param {number} scale  multiplier applied to `base` (the gain being solved)
 * @param {number} stretch  devicePixelRatio / renderer pixel ratio (>= 1)
 */
function displayedLight(base, n, scale, stretch) {
  let sum = 0;
  if (stretch <= 1.0001) { for (let i = 0; i < base.length; i++) sum += acesFilmic(base[i] * scale); return sum; }
  const img = new Float64Array(base.length);
  for (let i = 0; i < base.length; i++) img[i] = _srgbEnc(acesFilmic(base[i] * scale));
  const m = Math.floor(n * stretch);
  const at = (x, y) => (x < 0 || y < 0 || x >= n || y >= n ? 0 : img[y * n + x]);
  for (let oy = 0; oy < m; oy++) {
    const sy = (oy + 0.5) / stretch - 0.5, y0 = Math.floor(sy), ay = sy - y0;
    for (let ox = 0; ox < m; ox++) {
      const sx = (ox + 0.5) / stretch - 0.5, x0 = Math.floor(sx), ax = sx - x0;
      const e = (1 - ay) * ((1 - ax) * at(x0, y0) + ax * at(x0 + 1, y0)) + ay * ((1 - ax) * at(x0, y0 + 1) + ax * at(x0 + 1, y0 + 1));
      if (e > 0) sum += _srgbDec(e);
    }
  }
  return sum / (stretch * stretch);
}

/** Scene-linear pixel grid of a sprite (peak 1) centred at sub-pixel offset (ox, oy); the steady one sized for `stretch`. */
function spriteGrid(kind, wanted, ox, oy, stretch = 1) {
  const D = kind === 'old' ? wanted : Math.max(wanted, steadyMinDia(stretch)), R = D / 2;
  const n = 2 * (Math.ceil(R) + 2), c0 = n / 2, g = new Float64Array(n * n);
  const sg = steadySigma(D, steadySigmaPx(stretch)), amp = kind === 'old' ? 1 : steadyAmplitude(sg) * (wanted * wanted) / (D * D);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = x + 0.5 - c0 - ox, dy = y + 0.5 - c0 - oy;
    if (Math.abs(dx) >= R || Math.abs(dy) >= R) continue;   // outside the point square
    const r = Math.sqrt(dx * dx + dy * dy) / R;
    g[y * n + x] = kind === 'old' ? oldProfile(r) : amp * steadyProfile(r, sg);
  }
  return { g, n };
}

/**
 * Displayed light of one star over a grid x grid of sub-pixel positions — the
 * JS twin of the sprite shaders, for tests and probes. 'old' = the
 * smoothstep-squared sprite at its wanted width; 'steady' = the current sprite
 * times `gain`. `span` spreads the sampled positions over that many canvas px.
 * @returns {{mean:number, min:number, max:number, range:number}} range = (max-min)/mean
 */
export function spriteDisplayedLight(kind, wanted, level, { stretch = 1, gain = 1, grid = 8, span = 1 } = {}) {
  let sum = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < grid; i++) for (let j = 0; j < grid; j++) {
    // span 3 covers the whole beat of a 4/3 stretch
    const { g, n } = spriteGrid(kind === 'old' ? 'old' : 'new', wanted, ((i + 0.5) / grid - 0.5) * span, ((j + 0.5) / grid - 0.5) * span, stretch);
    const v = displayedLight(g, n, level * (kind === 'old' ? 1 : gain), stretch);
    sum += v; if (v < min) min = v; if (v > max) max = v;
  }
  const mean = sum / (grid * grid);
  return { mean, min, max, range: mean > 0 ? (max - min) / mean : 0 };
}

/**
 * LUT axes: wanted sprite width (canvas px) and peak scene level (colour
 * luminance x alpha x opacity). No star is narrower than 1.2 size floor x 1.5
 * = 1.8 px (1.45 covers a browser zoomed out to 0.8).
 */
export const STEADY_GAIN_W = [1.45, 1.75, 2.1, 2.5, 3.0, 3.6, 4.4, 5.4, 8.0];
export const STEADY_GAIN_L = [0.003, 0.008, 0.02, 0.05, 0.12, 0.3, 0.7, 1.5, 3.2];
const _gainLUTs = new Map();

/**
 * The gain that gives the steady sprite the old sprite's average DISPLAYED light
 * (ACES toe, sRGB, browser stretch) over sub-pixel positions.
 * @param {number} wanted  sprite width the old shader drew, canvas px
 * @param {number} level   peak scene-linear value times the exposure it is calibrated at (STEADY_GAIN_EXPOSURE)
 * @param {number} [stretch=1]  devicePixelRatio / renderer pixel ratio
 */
export function solveSteadyGain(wanted, level, stretch = 1, k = 6) {
  // The old sprite's average over sub-pixel positions; a non-integer stretch
  // beats over 3 canvas px, so its positions span 3 px there.
  const span = Math.abs(stretch - Math.round(stretch)) < 0.02 ? 1 : 3;
  let target = 0; const kk = wanted < 5 ? k : 2;
  for (let i = 0; i < kk; i++) for (let j = 0; j < kk; j++) {
    const { g, n } = spriteGrid('old', wanted, ((i + 0.5) / kk - 0.5) * span, ((j + 0.5) / kk - 0.5) * span, stretch);
    target += displayedLight(g, n, level, stretch);
  }
  target /= kk * kk;
  if (!(target > 0)) return 1;
  const { g, n } = spriteGrid('new', wanted, -0.2, 0.1, stretch);   // steady: any offset reads the same
  // Bisection on log(gain) in [-1, 3.5] (0.37x .. 33x); light(gain) is monotone.
  let lo = -1, hi = 3.5;
  for (let it = 0; it < 16; it++) {
    const mid = 0.5 * (lo + hi);
    if (displayedLight(g, n, level * Math.exp(mid), stretch) < target) lo = mid; else hi = mid;
  }
  return Math.exp(0.5 * (lo + hi));
}

export function steadyGainLUT(stretch = 1) {
  const key = Math.round(Math.min(3, Math.max(1, stretch)) * 1000) / 1000;
  let lut = _gainLUTs.get(key);
  if (!lut) {
    lut = new Float32Array(STEADY_GAIN_W.length * STEADY_GAIN_L.length);
    STEADY_GAIN_W.forEach((w, i) => STEADY_GAIN_L.forEach((l, j) => { lut[i * STEADY_GAIN_L.length + j] = solveSteadyGain(w, l, key); }));
    _gainLUTs.set(key, lut);
  }
  return lut;
}

/**
 * Per-star display gain: bilinear lookup of log(gain) over log(width), log(level)
 * for `stretch`, clamped to the table edges. Not used by the Milky Way haze
 * (its sprites overlap and sum before the tone curve).
 */
export function steadyGain(wanted, level, stretch = 1) {
  if (!(wanted > 0) || !(level > 0)) return 1;
  const lut = steadyGainLUT(stretch), n = STEADY_GAIN_L.length;
  const wi = _axisPos(_LOG_W, Math.log(wanted)), li = _axisPos(_LOG_L, Math.log(level));
  const i = wi | 0, ti = wi - i, j = li | 0, tj = li - j;
  const i1 = Math.min(i + 1, _LOG_W.length - 1), j1 = Math.min(j + 1, n - 1);
  // the gain is close to a power law in width, so interpolate log-gain
  const lg = (k) => Math.log(lut[k]);
  return Math.exp((1 - ti) * ((1 - tj) * lg(i * n + j) + tj * lg(i * n + j1)) + ti * ((1 - tj) * lg(i1 * n + j) + tj * lg(i1 * n + j1)));
}
const _LOG_W = STEADY_GAIN_W.map(Math.log), _LOG_L = STEADY_GAIN_L.map(Math.log);
/** Fractional index of x in an ascending axis, clamped to its ends. */
function _axisPos(axis, x) {
  if (x <= axis[0]) return 0;
  const last = axis.length - 1;
  if (x >= axis[last]) return last;
  let i = 0; while (axis[i + 1] < x) i++;
  return i + (x - axis[i]) / (axis[i + 1] - axis[i]);
}

export class Starfield {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'StarfieldGroup';

    this._time = 0;   // star twinkle shader uniform
    // OFF by default: update() never touches the group transform. See setFollowCamera().
    this._followCamera = false;
    // Constellation figures: TWO bits, one effective flag. `_constellationsVisible`
    // is the player's INTENT (the 6 key / Sky-labels rung / F5 SDA prior share it
    // via setConstellationsVisible); `_menuSuppressed` is the hub's MENU MASK
    // (setMenuSuppressed). Effective `obj.visible` = intent && !mask, applied by
    // _applyConstellationVisibility() from both setters. A mask, not a fourth
    // prior: a prior-based writer would race the disengage restore across the
    // MENU frame. Both default false = born-hidden until main.js applies a stored intent.
    this._constellationsVisible = false;
    this._menuSuppressed = false;
    // Reusable temporaries for the shooting-star update.
    this._tmpMeteorA = new THREE.Vector3();
    this._tmpMeteorB = new THREE.Vector3();

    // aGain is filled lazily by update() for the renderer's real pixel ratio;
    // these are the ratios it was last filled for.
    this._steadyGainPR = 0;
    this._steadyGainDPR = 0;

    this.mesh = this._create();
    this.group.add(this.mesh);
    this._createMilkyWay();
    this._createConstellations();
    this._initShootingStar();

    scene.add(this.group);
  }

  _create() {
    const count = Constants.STAR_COUNT;
    const radius = Constants.STAR_SPHERE_RADIUS;

    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    // Per-star alpha (0..1): carries faintness once size is pinned at the 1.2 px floor.
    const alphas = new Float32Array(count);
    // Twinkle amplitude per star (0 = steady). All stars are steady today; the
    // attribute lets the vertex shader modulate size without CPU work per frame.
    const twinkle = new Float32Array(count);
    // Random per-star phase so twinkles don't beat in unison.
    const phase = new Float32Array(count);

    const STAR_COLORS = [
      new THREE.Color(1.0, 1.0, 1.0),       // White (A-type)
      new THREE.Color(0.8, 0.85, 1.0),      // Blue-white (B-type)
      new THREE.Color(1.0, 0.95, 0.8),      // Yellow-white (F-type)
      new THREE.Color(1.0, 0.85, 0.6),      // Orange (K-type)
      new THREE.Color(0.7, 0.8, 1.0),       // Cool blue (O-type)
      new THREE.Color(1.0, 0.92, 0.85),     // Warm white (G-type / solar)
    ];

    // Faint random field: the faint end (FIELD_MAG_MIN..MAX) of the same
    // magnitude→size curve as the catalogue stars. Brightness is the exception,
    // a CONSTANT (STAR_FIELD_BRIGHT): the curve yields 0.044..0.004 here, too
    // dim to be visible, so size (1.2 px floor) and aAlpha carry magnitude. The
    // constant MUST stay strictly below the catalogue soft-knee asymptote
    // (STAR_MAG_BRIGHT_MIN × STAR_MAG_BRIGHT_FLOOR_SOFT = 0.3825) or a field
    // star ties the named stars in peak luminance.
    const FMN = Constants.STAR_FIELD_MAG_MIN;
    const FMX = Constants.STAR_FIELD_MAG_MAX;
    const brightMin = Constants.STAR_MAG_BRIGHT_MIN;
    const brightMax = Constants.STAR_MAG_BRIGHT_MAX;
    const brightSoft = Constants.STAR_MAG_BRIGHT_FLOOR_SOFT;
    const fieldBright = Constants.STAR_FIELD_BRIGHT;
    const sizeBase = Constants.STAR_MAG_SIZE_BASE;
    const sizeSlope = Constants.STAR_MAG_SIZE_SLOPE;
    const FIELD_CURVE = {
      base: sizeBase,
      slope: sizeSlope,
      floor: Constants.STAR_FIELD_SIZE_FLOOR,
      alphaMin: Constants.STAR_FIELD_ALPHA_MIN,
    };

    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      const x = radius * Math.sin(phi) * Math.cos(theta);
      const y = radius * Math.sin(phi) * Math.sin(theta);
      const z = radius * Math.cos(phi);

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      const mag = sampleFieldMagnitude(Math.random(), FMN, FMX);

      const colorIndex = Math.floor(Math.random() * STAR_COLORS.length);
      const color = STAR_COLORS[colorIndex];

      colors[i * 3] = color.r * fieldBright;
      colors[i * 3 + 1] = color.g * fieldBright;
      colors[i * 3 + 2] = color.b * fieldBright;

      // Floored at 1.2 px, alpha carries faintness below it: avoids sub-pixel crawl.
      const { size, alpha } = fieldSizeAlpha(mag, FMX, FIELD_CURVE);
      sizes[i] = size;
      alphas[i] = alpha;

      twinkle[i] = 0.0;
      phase[i] = Math.random() * Math.PI * 2;
    }

    // The 49 catalogue stars go into indices 0..48 of the SAME buffers (one
    // draw call), read from starCatalog.js so a star and its constellation line
    // never desync. Size carries the magnitude range (stars are capped at 2.0
    // under the bloom threshold, so brightness alone can't separate mag 0.1 from
    // 3.5 under ACES); both are monotone in magnitude.
    //
    // Colour-space: the swatches are display-referred hex, so use
    // `new THREE.Color(0x…)` (sRGB→linear), NOT the raw-linear `Color(r,g,b)` of
    // the random palette above. Each swatch has one channel at 0xff, so peak
    // fragment value is 1.0 × 2.0 × uOpacity 0.95 = 1.9, under the 2.5 bloom threshold.
    const SPECTRAL_COLORS = {
      OB: new THREE.Color(0xaabfff), // Rigel, Mimosa, Acrux
      A:  new THREE.Color(0xcad7ff), // Deneb, Castor, Denebola
      F:  new THREE.Color(0xf8f7ff), // Caph, Sadr
      G:  new THREE.Color(0xfff4e8), // Epsilon Leo, Mebsuta
      K:  new THREE.Color(0xffd2a1), // Pollux, Dubhe, Albireo
      M:  new THREE.Color(0xffb46b), // Betelgeuse, Antares, Gacrux
    };
    const spectralColorFor = (spec) => {
      const c = spec.charAt(0);
      return (c === 'O' || c === 'B') ? SPECTRAL_COLORS.OB : SPECTRAL_COLORS[c];
    };

    const sizeMin = Constants.STAR_MAG_SIZE_MIN;

    // Buffer index = flat traversal order of figures then stars (0..48).
    let catalogIndex = 0;
    for (const fig of CONSTELLATION_FIGURES) {
      for (const name of fig.stars) {
        const star = BRIGHT_STARS[name];
        const i = catalogIndex++;
        const p = raDec2xyz(star.ra, star.dec, radius);
        positions[i * 3] = p.x;
        positions[i * 3 + 1] = p.y;
        positions[i * 3 + 2] = p.z;

        sizes[i] = Math.max(sizeMin, Math.min(sizeBase, sizeBase - sizeSlope * star.mag));
        // skyBrightness: the one curve shared with the planets (bodyCatalog); Rigel reads 2.019, bloom-safe.
        const brightness = skyBrightness(star.mag, brightMin, brightMax, brightSoft);
        const c = spectralColorFor(star.spec);
        colors[i * 3] = c.r * brightness;
        colors[i * 3 + 1] = c.g * brightness;
        colors[i * 3 + 2] = c.b * brightness;
        alphas[i] = 1.0;   // catalogue stars never fade below the floor

        twinkle[i] = 0.0;
        phase[i] = 0.0;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    geometry.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkle, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    // 1 until update() knows the renderer's pixel ratio (see steadyGain).
    geometry.setAttribute('aGain', new THREE.BufferAttribute(new Float32Array(count).fill(1), 1));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: (typeof window !== 'undefined' && window.devicePixelRatio) || 1 },
        uSizeScale: { value: 1.5 },
        uOpacity: { value: 0.95 },
        uMinDia: { value: STAR_MIN_DRAWN_PX },       // minimum drawn diameter, canvas px (update() sets it per stretch)
        uSigmaPx: { value: STAR_SIGMA_PX },          // smallest Gaussian sigma, canvas px (ditto)
        uSigmaMatch: { value: STAR_SIGMA_MATCH },    // large-star sigma (fraction of radius)
        uOldLight: { value: oldProfileLight() },     // total light of the old sprite; amplitude keeps it
      },
      // NOTE: no `vertexColors: true` — raw ShaderMaterial would then inject its
      // own `attribute vec3 color` and collide with the manual declaration
      // below. We declare and consume `color` ourselves.
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute vec3 color;
        attribute float size;
        attribute float aAlpha;
        attribute float aTwinkle;
        attribute float aPhase;
        attribute float aGain;
        uniform float uTime;
        uniform float uPixelRatio;
        uniform float uSizeScale;
        uniform float uMinDia;
        uniform float uSigmaPx;
        uniform float uSigmaMatch;
        uniform float uOldLight;
        varying vec3 vColor;
        varying float vBright;
        varying float vAlpha;
        varying float vLight;
        varying float vK;
        varying float vE0;
        varying float vNorm;
        void main() {
          vColor = color;
          vAlpha = aAlpha;
          // Twinkle: gentle sine shimmer, only where aTwinkle > 0. Modulates
          // both point size and a brightness varying used in the fragment.
          float tw = 1.0 + aTwinkle * sin(uTime * 2.5 + aPhase);
          vBright = tw;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // sizeAttenuation:false — constant screen size, scaled for retina.
          // Steady stars: never draw narrower than uMinDia device px, and scale
          // alpha by (wanted / drawn)^2 so the star's total light is unchanged;
          // aGain then matches the DISPLAYED light through the ACES toe.
          float wanted = size * uSizeScale * uPixelRatio * tw;
          float drawn = max(wanted, uMinDia);
          gl_PointSize = drawn;
          vLight = (wanted * wanted) / (drawn * drawn) * aGain;
          // Gaussian sprite: sigma >= uSigmaPx device px; amplitude keeps the old
          // sprite's total light (closed-form disc integral of the truncated Gaussian).
          float sg = max(uSigmaMatch, uSigmaPx / (0.5 * drawn));
          vK = 0.5 / (sg * sg);
          vE0 = exp(-vK);
          float lightUnit = 6.2831853 * (sg * sg - vE0 / (2.0 * (1.0 - vE0)));
          vNorm = (uOldLight / lightUnit) / (1.0 - vE0);
        }
      `,
      fragmentShader: `
        uniform float uOpacity;
        varying vec3 vColor;
        varying float vBright;
        varying float vAlpha;
        varying float vLight;
        varying float vK;
        varying float vE0;
        varying float vNorm;
        void main() {
          // Round Gaussian sprite (steady under sub-pixel motion): radial falloff
          // from the point centre, truncated to exactly 0 at the sprite edge.
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d) * 2.0;              // 0 at center -> 1 at edge
          float alpha = max(exp(-r * r * vK) - vE0, 0.0) * vNorm * vLight;
          // aAlpha carries faintness for field stars pinned at the size floor.
          gl_FragColor = vec4(vColor * vBright, alpha * uOpacity * vAlpha);
        }
      `,
    });

    const points = new THREE.Points(geometry, material);
    points.name = 'Starfield';
    points.frustumCulled = false;
    this._starMaterial = material;

    return points;
  }

  /**
   * Milky Way band on the REAL galactic frame (starCatalog.galacticBasis).
   * Longitude is rejection-sampled against mwDensity, latitude gets a triangular
   * spread widening toward the centre, and the Great Rift is NEGATIVE SPACE
   * (points skipped in the lane). Presence comes from density, the 1.2 px size
   * floor and additive overlap, never per-point peak, which stays below
   * STAR_FIELD_BRIGHT so no band point out-shines a star. Reuses the star
   * ShaderMaterial (a clone, lower opacity, no twinkle): one extra draw call.
   * @private
   */
  _createMilkyWay() {
    // TWO populations in one buffer. More points alone make speckle, not a band;
    // haze needs OVERLAP: few very large, very dim additive sprites (Gaussian,
    // sigma 0.3 of the radius) that sum into continuous glow, with grain on top.
    //   - HAZE  : MW_HAZE_COUNT points, ~45-105 px across, alpha ~0.05
    //   - GRAIN : MW_COUNT points, 1.2-4.5 px, the starry texture
    const count = Constants.MW_COUNT + Constants.MW_HAZE_COUNT;
    const radius = Constants.STAR_SPHERE_RADIUS * 0.985; // just inside the star shell
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    // aAlpha varies across the band, giving the haze texture.
    const alphas = new Float32Array(count);
    const twinkle = new Float32Array(count); // all 0 (band doesn't twinkle)
    const phase = new Float32Array(count);

    // center = l=0 (Sgr), e2 = l=90 (Cygnus), pole = +b.
    const basis = galacticBasis();
    const pole = new THREE.Vector3(basis.pole.x, basis.pole.y, basis.pole.z);
    const center = new THREE.Vector3(basis.center.x, basis.center.y, basis.center.z);
    const e2 = new THREE.Vector3(basis.e2.x, basis.e2.y, basis.e2.z);

    const C = Constants;
    const riftParams = {
      longMin: C.MW_RIFT_LONG_MIN, longMax: C.MW_RIFT_LONG_MAX,
      offset: C.MW_RIFT_OFFSET, width: C.MW_RIFT_WIDTH, edge: C.MW_RIFT_EDGE,
      broaden: C.MW_RIFT_BROADEN, broadenLong: C.MW_RIFT_BROADEN_LONG,
      broadenWidth: C.MW_RIFT_BROADEN_WIDTH, depth: C.MW_RIFT_DEPTH,
    };
    const cygnusParams = { long: C.MW_CYGNUS_LONG, width: C.MW_CYGNUS_WIDTH, boost: C.MW_CYGNUS_BOOST };

    const c0 = new THREE.Color(0.85, 0.86, 0.95);
    const c1 = new THREE.Color(0.95, 0.92, 0.85);

    // Published star clouds → unit direction plus two tangents, to scatter points around each centre.
    const clouds = (C.MW_STAR_CLOUDS || []).map((cd) => {
      const u = raDecToUnit(cd.ra, cd.dec);
      const dir = new THREE.Vector3(u.x, u.y, u.z).normalize();
      const t1 = new THREE.Vector3();
      t1.copy(Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0))
        .cross(dir).normalize();
      const t2 = new THREE.Vector3().crossVectors(dir, t1).normalize();
      const D = Math.PI / 180;
      return { dir, t1, t2, a: Math.tan(cd.aDeg * D), b: Math.tan(cd.bDeg * D) };
    });

    const tmp = new THREE.Vector3();
    let placed = 0;
    let guard = 0;
    // Rejection-sample longitude: mwDensity is normalized to 1.0 at the galactic
    // centre, so it is directly the acceptance probability (the same function
    // the test asserts against).
    while (placed < count && guard < count * 40) {
      guard++;
      const L = Math.random() * Math.PI * 2 - Math.PI;   // [−π, π]
      const density = mwDensity(L, C.MW_CENTER_CONTRAST, cygnusParams);   // (0, 1]
      if (Math.random() > density) continue;
      // Centre-weighted structure (no Cygnus term) drives WIDTH and per-point
      // BRIGHTNESS: Cygnus is density only, or it would break the per-point peak cap.
      const structure = mwCenterProfile(L, C.MW_CENTER_CONTRAST) / C.MW_CENTER_CONTRAST;

      // The band is widest near the galactic center. A fraction of grain points
      // form a wide faint halo (MW_HALO_*) so the band thins out smoothly. Haze
      // sprites stay in the CORE width: in the halo they became isolated 100 px
      // smudges off the band.
      const isHaze = placed < C.MW_HAZE_COUNT;
      const halo = !isHaze && Math.random() < C.MW_HALO_FRACTION;
      const width = C.MW_BAND_WIDTH * (1 + (C.MW_BAND_WIDTH_CENTER - 1) * structure)
        * (halo ? C.MW_HALO_WIDTH_MULT : 1);
      // Three uniforms summed: a bell that reaches zero smoothly (two give a
      // hard stop, a visible band edge).
      const spread = ((Math.random() + Math.random() + Math.random()) - 1.5) / 1.5 * width;

      // Great Rift: carve the dark lane (negative space).
      if (Math.random() > mwGreatRiftMask(L, spread, riftParams)) continue;

      // Galactic plane at longitude L, lifted off-plane by `spread`.
      tmp.copy(center).multiplyScalar(Math.cos(L))
        .addScaledVector(e2, Math.sin(L));
      tmp.multiplyScalar(Math.cos(spread))
        .addScaledVector(pole, Math.sin(spread))
        .normalize();

      // BRIGHT STAR CLOUDS: a fraction of points is redirected into the
      // published MW_STAR_CLOUDS knots. Density only; boosting brightness would
      // break the star hierarchy.
      if (clouds.length && Math.random() < C.MW_CLOUD_EXTRA_FRACTION) {
        const cl = clouds[(Math.random() * clouds.length) | 0];
        // Soft bell taper, not a uniform disc (which gave each cloud a hard rim).
        const bell = Math.abs((Math.random() + Math.random() + Math.random() - 1.5) / 1.5);
        const th = Math.random() * Math.PI * 2;
        tmp.copy(cl.dir)
          .addScaledVector(cl.t1, Math.cos(th) * bell * cl.a)
          .addScaledVector(cl.t2, Math.sin(th) * bell * cl.b)
          .normalize();
      }
      tmp.multiplyScalar(radius);
      positions[placed * 3] = tmp.x;
      positions[placed * 3 + 1] = tmp.y;
      positions[placed * 3 + 2] = tmp.z;

      // Halo points are dimmed (MW_HALO_BRIGHT_MULT). Two tiers are the whole
      // fade; a per-star fade on top measurably worsens the profile.
      const b = C.MW_BRIGHT_MIN + (C.MW_BRIGHT_MAX - C.MW_BRIGHT_MIN) * structure * (0.55 + 0.45 * Math.random())
        * (halo ? C.MW_HALO_BRIGHT_MULT : 1);
      const col = Math.random() < 0.8 ? c0 : c1;
      // Grain and haze must NOT share one brightness: dimming grain below real
      // stars would dim the glow equally. Haze is gated by its tiny alpha (~0.024).
      const bp = isHaze ? b * C.MW_HAZE_BRIGHT_MULT : b;
      colors[placed * 3] = col.r * bp;
      colors[placed * 3 + 1] = col.g * bp;
      colors[placed * 3 + 2] = col.b * bp;

      // The first MW_HAZE_COUNT placed points are the haze layer; same structure
      // as the grain, only size and alpha differ.
      if (isHaze) {
        sizes[placed] = C.MW_HAZE_SIZE_MIN + Math.random() * (C.MW_HAZE_SIZE_MAX - C.MW_HAZE_SIZE_MIN);
        alphas[placed] = C.MW_HAZE_ALPHA * (0.6 + 0.4 * (b / C.MW_BRIGHT_MAX));
      } else {
        sizes[placed] = C.MW_SIZE_FLOOR + Math.pow(Math.random(), 1.8) * C.MW_SIZE_VAR; // biased small
        alphas[placed] = 0.6 + 0.4 * (b / C.MW_BRIGHT_MAX);
      }
      twinkle[placed] = 0.0;
      phase[placed] = 0.0;
      placed++;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    geometry.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkle, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    // Grain only; the haze keeps 1 (see steadyGain).
    geometry.setAttribute('aGain', new THREE.BufferAttribute(new Float32Array(count).fill(1), 1));
    this._mwHazeCount = Math.min(placed, Constants.MW_HAZE_COUNT);

    // Per-point peak stays < STAR_FIELD_BRIGHT (see MW_OPACITY).
    const material = this._starMaterial.clone();
    material.uniforms.uOpacity.value = Constants.MW_OPACITY;
    material.uniforms.uSizeScale.value = 1.5;

    const points = new THREE.Points(geometry, material);
    points.name = 'MilkyWay';
    points.frustumCulled = false;
    this._milkyWay = points;
    this._milkyWayMaterial = material;
    this.group.add(points);
  }

  /**
   * One reusable 2-vertex additive line, hidden until a meteor fires (every
   * 60–120 s, ~0.35 s streak).
   * @private
   */
  _initShootingStar() {
    const geom = new THREE.BufferGeometry();
    // head, tail
    this._meteorPos = new Float32Array(6);
    geom.setAttribute('position', new THREE.BufferAttribute(this._meteorPos, 3));
    // Tail fades to black.
    this._meteorCol = new Float32Array([1, 1, 1, 0, 0, 0]);
    geom.setAttribute('color', new THREE.BufferAttribute(this._meteorCol, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      // depthTest ON: the meteor sits on the star shell (r≈392); without it a
      // far-side meteor drew over the opaque Earth.
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this._meteor = new THREE.LineSegments(geom, mat);
    this._meteor.name = 'ShootingStar';
    this._meteor.frustumCulled = false;
    this._meteor.visible = false;
    this._meteorMat = mat;
    this.group.add(this._meteor);

    this._meteorTimer = 8 + Math.random() * 20; // first one within ~8–28 s
    this._meteorActive = false;
    this._meteorElapsed = 0;
    this._meteorDur = 0.35;
    this._meteorStart = new THREE.Vector3();
    this._meteorEnd = new THREE.Vector3();
  }

  /** @param {number} dt — seconds */
  _updateShootingStar(dt) {
    if (!this._meteor) return;
    if (this._meteorActive) {
      this._meteorElapsed += dt;
      const t = this._meteorElapsed / this._meteorDur;
      if (t >= 1) {
        this._meteorActive = false;
        this._meteor.visible = false;
        this._meteorMat.opacity = 0;
        this._meteorTimer = 60 + Math.random() * 60; // next in 60–120 s
        return;
      }
      const head = Math.min(1, t * 1.15);
      const tail = Math.max(0, head - 0.12);
      const hv = this._tmpMeteorA.copy(this._meteorStart).lerp(this._meteorEnd, head);
      const tv = this._tmpMeteorB.copy(this._meteorStart).lerp(this._meteorEnd, tail);
      this._meteorPos[0] = hv.x; this._meteorPos[1] = hv.y; this._meteorPos[2] = hv.z;
      this._meteorPos[3] = tv.x; this._meteorPos[4] = tv.y; this._meteorPos[5] = tv.z;
      this._meteor.geometry.attributes.position.needsUpdate = true;
      this._meteorMat.opacity = Math.sin(t * Math.PI) * 0.9;
      return;
    }
    this._meteorTimer -= dt;
    if (this._meteorTimer <= 0) this._fireShootingStar();
  }

  _fireShootingStar() {
    const radius = Constants.STAR_SPHERE_RADIUS * 0.98;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    this._meteorStart.set(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi)
    );
    const off = this._tmpMeteorA.set(
      (Math.random() - 0.5),
      (Math.random() - 0.5),
      (Math.random() - 0.5)
    ).normalize().multiplyScalar(radius * 0.18);
    this._meteorEnd.copy(this._meteorStart).add(off).normalize().multiplyScalar(radius);
    this._meteorActive = true;
    this._meteorElapsed = 0;
    this._meteor.visible = true;
  }


  _createConstellations() {
    const radius = Constants.STAR_SPHERE_RADIUS;
    // Lines + labels, so the 6 key can toggle them without touching the stars.
    this._constellationObjects = this._constellationObjects || [];
    // Sprites also tracked alone: lines fade at the limb in-shader, sprites on the CPU in update().
    this._constellationLabels = this._constellationLabels || [];
    // Scratch vectors for _limbFadeFactor.
    this._limbScratchA = this._limbScratchA || new THREE.Vector3();
    this._limbScratchB = this._limbScratchB || new THREE.Vector3();
    this._limbScratchC = this._limbScratchC || new THREE.Vector3();

    // Shared Line2 material: screen-space width, bypassing the WebGL 1px
    // lineWidth clamp. Do NOT enable alphaToCoverage: the renderer runs
    // antialias:false behind an EffectComposer, so there is no MSAA to resolve
    // against; thin lines rely on the SMAA/FXAA pass.
    this._constellationLineMaterial = new LineMaterial({
      color: Constants.CONSTELLATION_LINE_COLOR,
      transparent: true,
      opacity: Constants.CONSTELLATION_LINE_OPACITY,
      linewidth: Constants.CONSTELLATION_LINE_WIDTH,
      depthWrite: false,
      depthTest: true,           // occlude behind Earth mesh and celestial body depth masks
      resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
    });
    this._installLimbFade(this._constellationLineMaterial);

    // Trim each segment back from its endpoints: a normal-blended line over an
    // additive star dims the core. Trim = larger of CONSTELLATION_LINE_GAP (≈6 px)
    // and 2% of the length, capped at 25% so the short Shaula–Lesath arm (~2.9
    // units) is not inverted.
    const GAP = Constants.CONSTELLATION_LINE_GAP;
    const _trimDir = new THREE.Vector3();

    for (const cst of CONSTELLATION_FIGURES) {
      const stars3d = cst.stars.map((n) => raDec2xyz(BRIGHT_STARS[n].ra, BRIGHT_STARS[n].dec, radius));

      // Flat segment-pair array for LineSegmentsGeometry, both ends trimmed.
      const verts = [];
      for (const [a, b] of cst.lines) {
        const pa = stars3d[a];
        const pb = stars3d[b];
        const L = pa.distanceTo(pb);
        const trim = Math.min(Math.max(0.02 * L, GAP), 0.25 * L);
        _trimDir.subVectors(pb, pa);
        const t0 = trim / L;
        const ax = pa.x + _trimDir.x * t0;
        const ay = pa.y + _trimDir.y * t0;
        const az = pa.z + _trimDir.z * t0;
        const bx = pb.x - _trimDir.x * t0;
        const by = pb.y - _trimDir.y * t0;
        const bz = pb.z - _trimDir.z * t0;
        verts.push(ax, ay, az);
        verts.push(bx, by, bz);
      }

      const lineGeom = new LineSegmentsGeometry();
      lineGeom.setPositions(verts);
      const lineObj = new LineSegments2(lineGeom, this._constellationLineMaterial);
      lineObj.computeLineDistances();
      lineObj.frustumCulled = false;
      // owner 2026-09-07: constellations ship OFF, born hidden so the first
      // frame (incl. the MENU backdrop, this same sky) is clean. main.js
      // restores a stored `true` at boot and masks the figures in MENU
      // (setMenuSuppressed).
      lineObj.visible = false;
      this.group.add(lineObj);
      this._constellationObjects.push(lineObj);

      // Label at the centroid, re-projected onto the sphere
      const center = new THREE.Vector3();
      for (const p of stars3d) center.add(p);
      center.divideScalar(stars3d.length).normalize().multiplyScalar(radius);

      const label = new THREE.Sprite(new THREE.SpriteMaterial({
        map: createConstellationLabel(cst.name),
        transparent: true,
        opacity: Constants.CONSTELLATION_LABEL_OPACITY,
        depthWrite: false,
        depthTest: true,         // occlude behind Earth mesh and celestial body depth masks
      }));
      // Nudge sideways (tangent to the sphere) so glyphs sit beside the lines, not on them.
      const tangent = new THREE.Vector3()
        .crossVectors(center, new THREE.Vector3(0, 1, 0));
      // Centroid near the poles: degenerate cross, fall back to world X.
      if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0);
      tangent.normalize().multiplyScalar(-30); // shift toward screen-left
      label.position.copy(center).add(tangent);
      label.scale.set(50, 12, 1);
      label.frustumCulled = false;
      // Born hidden, like the lines above.
      label.visible = false;
      this.group.add(label);
      this._constellationObjects.push(label);
      this._constellationLabels.push(label);
    }
  }

  /**
   * Inject a soft Earth-limb fade into the constellation LineMaterial.
   *
   * WHY: with depthTest:true an edge crossing the limb is chopped dead at the
   * silhouette, a straight line with a hard endpoint ON the surface, which
   * reads as a rocket launch plume. Fading before the limb glow removes that cue.
   *
   * HOW: per-fragment angular fade. Earth sits at the world origin (Earth.js
   * never moves its group), so its view-space centre is viewMatrix[3].xyz. A
   * varying carries each fragment's view-space position (interpolated
   * perspective-correctly along the segment). Chord-vs-great-circle error is a
   * couple of degrees, irrelevant to a soft ramp.
   *
   * The reference radius is ATMOSPHERE_RADIUS (not EARTH_RADIUS) so the ramp
   * ends outside the airglow band; the atmosphere shell is depthWrite:false, so
   * lines would otherwise punch through it.
   * @private
   */
  _installLimbFade(material) {
    const uniforms = {
      uLimbRadius:    { value: Constants.ATMOSPHERE_RADIUS },
      uLimbFadeScale: { value: Constants.CONSTELLATION_LIMB_FADE_SCALE },
      uLimbFadeMin:   { value: Constants.CONSTELLATION_LIMB_FADE_MIN },
      uLimbFadeMax:   { value: Constants.CONSTELLATION_LIMB_FADE_MAX },
    };

    // Anchors are tied to vendored three r184 (vendor/three/examples/jsm/lines/
    // LineMaterial.js); a silently-missed replace would drop the fade, so each is checked.
    const VERT_DECL_ANCHOR = 'uniform float linewidth;\n\t\tuniform vec2 resolution;';
    const VERT_BODY_ANCHOR = 'vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );';
    const FRAG_DECL_ANCHOR = 'uniform vec3 diffuse;';
    const FRAG_BODY_ANCHOR = 'gl_FragColor = vec4( diffuseColor.rgb, alpha );';

    const warn = (what) => {
      if (this._limbFadeWarned) return;
      this._limbFadeWarned = true;
      console.warn(
        `[Starfield] Constellation limb-fade injection failed (${what} anchor not ` +
        'found in LineMaterial). Lines will hard-clip at the Earth limb. The ' +
        'vendored three.js LineMaterial shader has probably changed.'
      );
    };

    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      const vertDecl = /* glsl */`
        uniform float linewidth;
        uniform vec2 resolution;
        varying vec3 vLimbViewPos;
        varying vec3 vLimbEarthView;`;

      // position.y < 0.5 is the stock start/end selector. Use the raw endpoint
      // (not the expanded quad corner) so the fade varies ALONG the line.
      const vertBody = /* glsl */`${VERT_BODY_ANCHOR}
			vec4 limbEnd = modelViewMatrix * vec4( instanceEnd, 1.0 );
			vLimbViewPos = ( position.y < 0.5 ) ? start.xyz : limbEnd.xyz;
			vLimbEarthView = viewMatrix[ 3 ].xyz;`;

      const fragDecl = /* glsl */`
        uniform vec3 diffuse;
        uniform float uLimbRadius;
        uniform float uLimbFadeScale;
        uniform float uLimbFadeMin;
        uniform float uLimbFadeMax;
        varying vec3 vLimbViewPos;
        varying vec3 vLimbEarthView;`;

      // After the endcap discards, so it modulates the final alpha.
      const fragBody = /* glsl */`
			float limbDist  = length( vLimbEarthView );
			float sinLimb   = clamp( uLimbRadius / max( limbDist, uLimbRadius + 1e-3 ), 0.0, 1.0 );
			float thetaLimb = asin( sinLimb );
			float theta     = acos( clamp( dot( normalize( vLimbViewPos ), normalize( vLimbEarthView ) ), -1.0, 1.0 ) );
			float limbBand  = clamp( uLimbFadeScale * thetaLimb, uLimbFadeMin, uLimbFadeMax );
			alpha *= smoothstep( thetaLimb, thetaLimb + limbBand, theta );
			${FRAG_BODY_ANCHOR}`;

      if (shader.vertexShader.includes(VERT_DECL_ANCHOR)) {
        shader.vertexShader = shader.vertexShader.replace(VERT_DECL_ANCHOR, vertDecl);
      } else warn('vertex declaration');

      if (shader.vertexShader.includes(VERT_BODY_ANCHOR)) {
        shader.vertexShader = shader.vertexShader.replace(VERT_BODY_ANCHOR, vertBody);
      } else warn('vertex body');

      if (shader.fragmentShader.includes(FRAG_DECL_ANCHOR)) {
        shader.fragmentShader = shader.fragmentShader.replace(FRAG_DECL_ANCHOR, fragDecl);
      } else warn('fragment declaration');

      if (shader.fragmentShader.includes(FRAG_BODY_ANCHOR)) {
        shader.fragmentShader = shader.fragmentShader.replace(FRAG_BODY_ANCHOR, fragBody);
      } else warn('fragment body');
    };

    // Cache keys ignore onBeforeCompile: keep this variant off a stock LineMaterial's program.
    material.customProgramCacheKey = () => 'constellationLimbFade';
  }

  /** CPU twin of the in-shader limb fade (labels): 0..1 ramp for a world-space point seen from `camera`. */
  _limbFadeFactor(worldPos, camera) {
    // Earth is at the world origin: camera.position is the negated camera→Earth vector.
    const limbRadius = Constants.ATMOSPHERE_RADIUS;
    const camDist = camera.position.length();
    if (!(camDist > limbRadius)) return 1; // inside the shell: no meaningful limb
    const thetaLimb = Math.asin(Math.min(1, limbRadius / camDist));

    const toPoint = this._limbScratchA.copy(worldPos).sub(camera.position);
    const toEarth = this._limbScratchB.copy(camera.position).negate();
    const lp = toPoint.length();
    if (lp < 1e-6) return 1;
    const cos = toPoint.dot(toEarth) / (lp * camDist);
    const theta = Math.acos(Math.max(-1, Math.min(1, cos)));

    const band = Math.min(
      Constants.CONSTELLATION_LIMB_FADE_MAX,
      Math.max(Constants.CONSTELLATION_LIMB_FADE_MIN,
        Constants.CONSTELLATION_LIMB_FADE_SCALE * thetaLimb)
    );
    const t = Math.max(0, Math.min(1, (theta - thetaLimb) / band));
    return t * t * (3 - 2 * t);
  }

  /**
   * Show/hide the constellation outlines + labels (the 6 key). Sets the
   * player's INTENT bit; under the MENU mask (setMenuSuppressed) a `true` is
   * remembered, not shown, until the mask lifts.
   */
  setConstellationsVisible(visible) {
    this._constellationsVisible = !!visible;
    this._applyConstellationVisibility();
  }

  /** Toggle (6 key). @returns {boolean} the NEW INTENT, whether or not the MENU mask hides it. */
  toggleConstellations() {
    this.setConstellationsVisible(!(this._constellationsVisible ?? false));
    return this._constellationsVisible;
  }

  /** @returns {boolean} the player's INTENT (never the menu mask's effect), so
   *  the 6 key, Sky-labels rung prior and F5 SDA prior read the bit they write.
   *  Default OFF (owner 2026-09-07; see _createConstellations). */
  isConstellationsVisible() {
    return this._constellationsVisible ?? false;
  }

  /**
   * The MENU mask (owner 2026-09-09: constellation figures must not show on the
   * MENU, they distract from the hero mother): while `true` every figure is
   * hidden regardless of intent. Written only by the hub (main.js) from the
   * game state, never by a key, rung or the F5 chart, so it cannot race their
   * capture/restore priors. Idempotent.
   */
  setMenuSuppressed(suppressed) {
    this._menuSuppressed = !!suppressed;
    this._applyConstellationVisibility();
  }

  isMenuSuppressed() {
    return !!this._menuSuppressed;
  }

  /** The ONE writer of the figure objects' `visible`: intent AND NOT mask. */
  _applyConstellationVisibility() {
    const on = !!this._constellationsVisible && !this._menuSuppressed;
    for (const obj of (this._constellationObjects || [])) {
      obj.visible = on;
    }
  }

  /**
   * Enable/disable camera-follow mode (Zoom Ladder F4/F5 BLACK-SKY fix).
   *
   * The shell (radius STAR_SPHERE_RADIUS, 400 u, centered on Earth) is fully
   * visible only while far >= D_max + R, D = camera distance from Earth centre
   * (a star behind Earth sits at D + R). Far 500 covers only D <= 100 u: on F4
   * (D ∈ [70, 255], far 500) far-plane clipping opens a black annulus around
   * Earth's disk (from D ≈ 123, whole sky gone by D ≈ 167); on F5 (D ∈ [500,
   * 1300], far 2000) the camera EXITS the shell, leaving stars in an 18–53° cap.
   *
   * Following re-centers the shell on the camera's WORLD position every
   * update(): stars become pure DIRECTION chrome at distance exactly R. Safe
   * because every child is frustumCulled:false, all materials are transparent +
   * additive + depthWrite:false (no z-fight), the line limb fade is computed in
   * VIEW space (parenting-independent), the label fade uses getWorldPosition,
   * and Earth still occludes via depthTest.
   *
   * Disabled (default): update() never touches the group transform. Disabling
   * AFTER following restores the group to the origin so a ladder disengage
   * cannot strand the shell off-center.
   *
   * Known limit (cosmetic/dev-only): the SunLight body depth masks
   * (BODY_DEPTH_MASK_DIST, coupled to the world-fixed shell) can sit beyond the
   * followed stars for far-side bodies, so stars can show through a body disc
   * at F4/F5 ranges. The ?shot=1 hooks (__scbSkyPose/__scbProject, main.js) add
   * the group offset, so they stay in sync.
   *
   * @returns {boolean} the NEW follow state
   */
  setFollowCamera(enabled) {
    const on = !!enabled;
    if (on !== this.isFollowingCamera() && !on) {
      this.group.position.set(0, 0, 0);
      this.group.updateMatrixWorld(true);
    }
    this._followCamera = on;
    return on;
  }

  isFollowingCamera() {
    return this._followCamera === true;
  }

  /**
   * Fill aGain for the stars and Milky Way grain at one pixel ratio / browser
   * stretch (see steadyGain): level = colour luminance x aAlpha x uOpacity.
   * Called by update() when either changes.
   * @param {number} pixelRatio  renderer pixel ratio
   * @param {number} stretch     devicePixelRatio / pixelRatio
   * @private
   */
  _applySteadyGains(pixelRatio, stretch) {
    stretch = Math.min(3, Math.max(1, stretch));   // ?pixelRatio above DPR reads as 1:1
    const fill = (points, opacity, skip) => {
      if (!points) return;
      const g = points.geometry.attributes;
      const col = g.color.array, size = g.size.array, alpha = g.aAlpha.array, gain = g.aGain.array;
      const scale = points.material.uniforms.uSizeScale.value * pixelRatio;
      for (let i = 0; i < gain.length; i++) {
        if (i < skip) { gain[i] = 1; continue; }
        const lum = 0.2126 * col[3 * i] + 0.7152 * col[3 * i + 1] + 0.0722 * col[3 * i + 2];
        gain[i] = steadyGain(size[i] * scale, lum * alpha[i] * opacity * STEADY_GAIN_EXPOSURE, stretch);
      }
      g.aGain.needsUpdate = true;
    };
    for (const mat of [this._starMaterial, this._milkyWayMaterial]) {
      if (!mat) continue;
      mat.uniforms.uMinDia.value = steadyMinDia(stretch);
      mat.uniforms.uSigmaPx.value = steadySigmaPx(stretch);
    }
    fill(this.mesh, this._starMaterial.uniforms.uOpacity.value, 0);
    fill(this._milkyWay, this._milkyWayMaterial ? this._milkyWayMaterial.uniforms.uOpacity.value : 1, this._mwHazeCount || 0);
  }

  /**
   * @param {number} _dt — seconds
   * @param {number} [pixelRatio] — the RENDERER's capped ratio; falls back to window.devicePixelRatio
   * @param {THREE.Camera} [camera] — limb-fades the label sprites and, in follow
   *   mode, is where the shell re-centers. Omitted: sprites keep static opacity
   *   and a following shell holds its last pose.
   */
  update(_dt, pixelRatio, camera) {
    const dt = (typeof _dt === 'number' && isFinite(_dt)) ? _dt : 0;
    // Wrap for float32 precision. 251.327 = 100 twinkle periods (2π / 2.5 s), so
    // sin(uTime*2.5 + phase) stays continuous across the wrap.
    this._time = (this._time + dt) % 251.327;

    // Camera-follow (see setFollowCamera): copy the camera's WORLD position into
    // the group BEFORE anything below derives world poses (the label limb fade
    // reads label.getWorldPosition). Cameras without getWorldPosition fall back
    // to .position; no camera holds the last pose.
    if (this._followCamera && camera) {
      if (typeof camera.getWorldPosition === 'function') {
        camera.getWorldPosition(this.group.position);
      } else if (camera.position) {
        this.group.position.copy(camera.position);
      }
      // Keep matrixWorld coherent for same-frame readers (label fade below, external queries).
      this.group.updateMatrixWorld(true);
    }

    if (this._starMaterial) {
      this._starMaterial.uniforms.uTime.value = this._time;
      // Current ratio keeps star size right after a window move between displays.
      const pr = (typeof pixelRatio === 'number' && isFinite(pixelRatio) && pixelRatio > 0)
        ? pixelRatio
        : ((typeof window !== 'undefined' && window.devicePixelRatio) || 1);
      this._starMaterial.uniforms.uPixelRatio.value = pr;
      if (this._milkyWayMaterial) this._milkyWayMaterial.uniforms.uPixelRatio.value = pr;
      // Gains depend on pixel ratio and on the browser stretch (DPR / pixel ratio): refill only on change.
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || pr;
      if (pr !== this._steadyGainPR || dpr !== this._steadyGainDPR) {
        this._applySteadyGains(pr, dpr / pr);
        this._steadyGainPR = pr;
        this._steadyGainDPR = dpr;
      }
    }

    this._updateShootingStar(dt);

    // Line2 needs the viewport resolution for screen-space width.
    if (this._constellationLineMaterial) {
      this._constellationLineMaterial.resolution.set(
        window.innerWidth, window.innerHeight
      );
    }

    // Match the in-shader limb fade on the sprites. Opacity only: `visible` is
    // owned by _applyConstellationVisibility().
    if (camera && this._constellationLabels && this._constellationLabels.length) {
      const base = Constants.CONSTELLATION_LABEL_OPACITY;
      for (const label of this._constellationLabels) {
        // World space, so a transformed group (follow mode) can't desync the fade.
        const worldPos = label.getWorldPosition(this._limbScratchC);
        label.material.opacity = base * this._limbFadeFactor(worldPos, camera);
      }
    }
  }
}

export default Starfield;
