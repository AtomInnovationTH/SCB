/**
 * Starfield.js — 10,000 background stars (size-honoring ShaderMaterial with
 * round soft sprites; the 49 named catalogue stars sit at the constellation
 * vertices in the same Points), a faint procedural Milky Way band, an
 * occasional shooting star, plus 8 major constellation outlines and
 * planetarium-style labels.
 *
 * The whole sky lives in one group ('StarfieldGroup'), world-fixed at the
 * origin by default. setFollowCamera(true) re-centers that shell on the camera
 * every update() — the Zoom Ladder F4/F5 (NAVCOM/SDA) BLACK-SKY fix (see setFollowCamera).
 * @module scene/Starfield
 */

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { Constants } from '../core/Constants.js';
import { BRIGHT_STARS, CONSTELLATION_FIGURES, sampleFieldMagnitude, fieldSizeAlpha, skyBrightness, galacticBasis, mwCenterProfile, mwGreatRiftMask, mwDensity, raDecToUnit } from './starCatalog.js';

// ============================================================================
// RA/Dec → Cartesian conversion
// ============================================================================

/**
 * Convert Right Ascension (hours) and Declination (degrees) to 3D cartesian
 * coordinates on the star sphere.
 *
 * Convention: +Y is celestial north, RA 0 at +X, with Z negated. Exported so
 * the `?shot=1` sky-pose hook in main.js can reuse it rather than re-deriving
 * (this basis is easy to get subtly wrong).
 *
 * @param {number} raHours — RA in hours (0–24)
 * @param {number} decDeg  — Dec in degrees (-90 to +90)
 * @param {number} radius  — sphere radius
 * @returns {THREE.Vector3}
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

// ============================================================================
// CONSTELLATION LABEL — canvas-based text texture (planetarium style)
// ============================================================================

/**
 * Create a subtle planetarium-style label texture for a constellation name.
 * Matches the thin-font aesthetic from planet labels (Sprint C4).
 *
 * Sprint 3 GPU profiling — Phase C.5 (2026-05-23, rev. 2): canvas resolution
 * quadrupled (original 512×128 → 2048×512) and font / shadow scaled 4×
 * proportionally. First attempt (1024×256) was still soft per user smoke test.
 * The label sprite occupies ~80–150 screen pixels of width at typical camera
 * distances; at pr=1.5 retina (≈225 physical pixels) the GPU samples the
 * texture's mip1 or mip2 level. A 2048-px-wide base texture means mip1 is
 * still 1024 px wide — plenty of detail headroom. Cost: 16 MB total VRAM
 * across 8 constellations (vs 4 MB at 1024×256, 256 KB original) — well
 * within budget for fixed scene chrome.
 *
 * @param {string} text — constellation name (e.g. "ORION")
 * @returns {THREE.CanvasTexture}
 */
function createConstellationLabel(text) {
  const c = document.createElement('canvas');
  c.width = 2048; c.height = 512;
  const ctx = c.getContext('2d');
  // Sprint 3 GPU profiling — Phase C.5 (2026-05-23, rev. 4): font weight
  // bumped to 700 and shadow glow removed entirely. The first three revs
  // progressively raised texel density (512→1024→2048) and font weight
  // (400→600) but text was still soft. Root cause: at pr=1.5 + no SMAA,
  // mip-level sampling averages adjacent texels and the planetarium-soft
  // shadow was bleeding into the glyph silhouette, blurring the perceived
  // edge. 700-weight strokes (~80% thicker than original 400) survive any
  // mip sampling, and removing the shadow lets the glyph edge stay crisp.
  // Fill color brightened from #aabbdd → #cce0ff to keep readability after
  // losing the bluish glow.
  ctx.font = '700 224px Arial, "Helvetica Neue", Helvetica, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#8792a8';
  ctx.globalAlpha = 1.0;
  ctx.fillText(text, 1024, 256);
  return new THREE.CanvasTexture(c);
}

// ============================================================================
// STEADY SPRITE PROFILE (st10, 2026-10-19)
// ============================================================================
// A point sprite narrower than ~2 device px is rasterized on a fragment lattice:
// as a star slides sub-pixel its pixel centres move in and out of the bright
// core, so its summed light swings by 100 %+ (measured on the menu sky, DPR 2 /
// renderer ratio 1.5: field-star p50 (max-min)/mean 0.62; DPR 1: 3.2). The cure
// is a Gaussian footprint whose sigma is >= ~0.6 canvas px (a unit-lattice sum
// of a Gaussian is constant to 2*exp(-2*pi^2*sigma^2) per axis; 0.9 px when the
// browser stretches the canvas by a non-integer factor), drawn at a minimum
// diameter, with alpha scaled by (size / drawn size)^2 so the star's
// TOTAL light stays what the old sprite delivered. Faintness stays in aAlpha.
// One more factor, per star (aGain): the stars sit in the toe of the ACES tone
// curve, which is convex, so the same linear light spread over more pixels shows
// DIMMER (measured: field stars at 0.40x on DPR 1, 0.83x on DPR 2 without it).
// steadyGain() matches each star's DISPLAYED light (ACES + sRGB + the browser's
// stretch of the canvas to the screen) to the old sprite's average over sub-pixel
// positions — the same stars, the same brightness, just steady.
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
 * Tone-mapping exposure the per-star gain is calibrated at: the menu's, 1.05 —
 * the away-from-sun target of SunLight._updateAutoExposure (SunLight.js:1654,
 * `targetExposure = 1.05`; the menu looks away from the sun; measured 1.05 on the
 * live menu, tmp/probes/st10/data/after2-d2.log). Fixed, not tracked per frame.
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
 * three.js ACESFilmicToneMapping on a grey value at exposure 1 — the curve the
 * game's OutputPass applies (SceneManager: renderer.toneMapping = ACES). The
 * input and output matrices map grey to grey, so only the RRT/ODT fit matters.
 * Exposure is a separate input: the gains are calibrated at STEADY_GAIN_EXPOSURE
 * (the menu's), see below. Gameplay auto-exposure runs 0.85-1.25 (SunLight), which
 * moves the displayed light of the steady stars against the old sprite's by about
 * -3 % (median; p10 -6 %) at 0.85 and +5 % (median; p90 +13 %) at 1.25, measured
 * with this JS twin (stars 1.8-3.6 px, level 0.02-0.3, stretch 1 and 4/3); before
 * the calibration it was -1 % / +7 % (p90 +15 %). Stars stay steady at any exposure.
 * COUPLED: if SceneManager stops using ACES, steadyGain() is matching the wrong
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
 * Displayed light of one sprite at one sub-pixel offset: canvas pixels
 * (fragment at the pixel centre) -> ACES -> sRGB; when `stretch` > 1 the encoded
 * image is bilinearly stretched (what the browser does to a canvas drawn below
 * devicePixelRatio), then decoded and summed. Units cancel in ratios.
 * @param {Float64Array} base  scene-linear values on an n x n pixel grid
 * @param {number} n  grid side
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
 * Displayed light of one star over a k x k grid of sub-pixel positions — the
 * JS twin of the sprite shaders, for tests and probes. 'old' = the pre-st10
 * smoothstep-squared sprite at its wanted width; 'steady' = the current sprite
 * (minimum width, (wanted/drawn)^2, Gaussian) times `gain`. `span` spreads the
 * sampled positions over that many canvas px.
 * @returns {{mean:number, min:number, max:number, range:number}} range = (max-min)/mean
 */
export function spriteDisplayedLight(kind, wanted, level, { stretch = 1, gain = 1, grid = 8, span = 1 } = {}) {
  let sum = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < grid; i++) for (let j = 0; j < grid; j++) {
    // positions over `span` canvas px (3 covers the whole beat of a 4/3 stretch)
    const { g, n } = spriteGrid(kind === 'old' ? 'old' : 'new', wanted, ((i + 0.5) / grid - 0.5) * span, ((j + 0.5) / grid - 0.5) * span, stretch);
    const v = displayedLight(g, n, level * (kind === 'old' ? 1 : gain), stretch);
    sum += v; if (v < min) min = v; if (v > max) max = v;
  }
  const mean = sum / (grid * grid);
  return { mean, min, max, range: mean > 0 ? (max - min) / mean : 0 };
}

/**
 * LUT axes: wanted sprite width (canvas px) and peak scene level (colour
 * luminance x alpha x opacity). No star is drawn narrower than the 1.2 size
 * floor x 1.5 at ratio 1 = 1.8 px (1.45 covers a browser zoomed out to 0.8).
 */
export const STEADY_GAIN_W = [1.45, 1.75, 2.1, 2.5, 3.0, 3.6, 4.4, 5.4, 8.0];
export const STEADY_GAIN_L = [0.003, 0.008, 0.02, 0.05, 0.12, 0.3, 0.7, 1.5, 3.2];
const _gainLUTs = new Map();

/**
 * The gain that gives the steady sprite the old sprite's average DISPLAYED light
 * (ACES toe, sRGB, browser stretch) over sub-pixel positions. Exported for tests.
 * @param {number} wanted  sprite width the old shader drew, canvas px
 * @param {number} level   peak scene-linear value (colour luminance x alpha x opacity), times the tone-mapping exposure it is calibrated at (STEADY_GAIN_EXPOSURE)
 * @param {number} [stretch=1]  devicePixelRatio / renderer pixel ratio
 * @param {number} [k=6]  sub-pixel grid side for the old sprite's average
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

/** Gain table for one stretch (cached). */
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
 * Per-star display gain: bilinear lookup of log(gain) over log(width), log(level) in the table for `stretch`,
 * clamped to its edges. The Milky Way haze does not use it (its sprites overlap
 * and sum before the tone curve, so the per-sprite model does not apply).
 */
export function steadyGain(wanted, level, stretch = 1) {
  if (!(wanted > 0) || !(level > 0)) return 1;
  const lut = steadyGainLUT(stretch), n = STEADY_GAIN_L.length;
  const wi = _axisPos(_LOG_W, Math.log(wanted)), li = _axisPos(_LOG_L, Math.log(level));
  const i = wi | 0, ti = wi - i, j = li | 0, tj = li - j;
  const i1 = Math.min(i + 1, _LOG_W.length - 1), j1 = Math.min(j + 1, n - 1);
  // log-gain interpolation: the gain is close to a power law in width
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

// ============================================================================
// STARFIELD CLASS
// ============================================================================

export class Starfield {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'StarfieldGroup';

    // Accumulated time for the star twinkle shader uniform.
    this._time = 0;
    // Camera-follow mode (Zoom Ladder F4/F5 BLACK-SKY fix) — OFF by default:
    // the shipped shell is world-fixed at the origin and update() never touches
    // the group transform. See setFollowCamera().
    this._followCamera = false;
    // Constellation figures — TWO bits, one effective flag (2026-09-09, plan
    // 1788926404388 §1.19): `_constellationsVisible` is the player's INTENT
    // (the 6 key / the Sky-labels rung / the F5 SDA prior all read and write
    // it through setConstellationsVisible / isConstellationsVisible — three
    // prior-based writers already share it); `_menuSuppressed` is the hub's
    // MENU MASK (setMenuSuppressed — the figures distract from the hero
    // mother). Effective `obj.visible` = intent && !mask, applied by
    // _applyConstellationVisibility() from both setters. A mask, not a fourth
    // prior: a prior-based writer would race the disengage restore across the
    // MENU frame; a mask composes. Both default false = born-hidden objects
    // (Session O D11) until main.js boot-applies a stored intent.
    this._constellationsVisible = false;
    this._menuSuppressed = false;
    // Reusable temporaries for the shooting-star update (no per-frame alloc).
    this._tmpMeteorA = new THREE.Vector3();
    this._tmpMeteorB = new THREE.Vector3();

    // Steady-star display gains (aGain) are filled lazily by update() for the
    // renderer's real pixel ratio; the pixel ratio and devicePixelRatio they
    // were last filled for (numbers, so the per-frame check allocates nothing).
    this._steadyGainPR = 0;
    this._steadyGainDPR = 0;

    this.mesh = this._create();
    this.group.add(this.mesh);
    this._createMilkyWay();
    this._createConstellations();
    this._initShootingStar();

    scene.add(this.group);
  }

  /**
   * Build the star Points object
   * @returns {THREE.Points}
   * @private
   */
  _create() {
    const count = Constants.STAR_COUNT;
    const radius = Constants.STAR_SPHERE_RADIUS;

    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    // Per-star alpha (0..1) so the faint field can fade below the size floor
    // without hue-shifting — alpha carries faintness once size is pinned at the
    // 1.2 px floor. Catalogue stars stay at 1.
    const alphas = new Float32Array(count);
    // Twinkle amplitude per star (0 = steady). The whole field is steady today
    // — the catalogue stars are real sky and do not shimmer, and the old fake
    // "prominent" block that twinkled is gone. Kept as an attribute so the
    // vertex shader can modulate size over time without touching the CPU each
    // frame; Stage 5 repurposes it.
    const twinkle = new Float32Array(count);
    // Random per-star phase so twinkles don't beat in unison.
    const phase = new Float32Array(count);

    // Star color palette (spectral types)
    const STAR_COLORS = [
      new THREE.Color(1.0, 1.0, 1.0),       // White (A-type)
      new THREE.Color(0.8, 0.85, 1.0),      // Blue-white (B-type)
      new THREE.Color(1.0, 0.95, 0.8),      // Yellow-white (F-type)
      new THREE.Color(1.0, 0.85, 0.6),      // Orange (K-type)
      new THREE.Color(0.7, 0.8, 1.0),       // Cool blue (O-type)
      new THREE.Color(1.0, 0.92, 0.85),     // Warm white (G-type / solar)
    ];

    // --- Faint random field: the tail of the same magnitude curve ---
    // The field is the faint end (mag MAG_MIN..MAG_MAX) of the SAME
    // magnitude→size curve the catalogue stars use, so the two populations sit
    // on one curve. Brightness is the exception: it is a CONSTANT
    // (STAR_FIELD_BRIGHT), not the curve — pow(10, -0.4*(mag-1)) yields
    // 0.044..0.004 across the field's range, far below any floor that would
    // keep it visible, so the curve cannot carry brightness information here.
    // Size (via the 1.2 px floor) and aAlpha carry the magnitude instead — the
    // same division of labour the catalogue stars use. The constant MUST stay
    // strictly below the catalogue soft-knee asymptote (STAR_MAG_BRIGHT_MIN ×
    // STAR_MAG_BRIGHT_FLOOR_SOFT = 0.3825, the faintest catalogue star's peak)
    // or a field star ties the named stars in peak luminance and breaks
    // Stage 1's hierarchy. The magnitude sample and size/alpha map are shared
    // helpers from starCatalog.js (single source of truth with the test).
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
      // Random point on a sphere using spherical coordinates
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      const x = radius * Math.sin(phi) * Math.cos(theta);
      const y = radius * Math.sin(phi) * Math.sin(theta);
      const z = radius * Math.cos(phi);

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      // Magnitude — exponential counts toward the faint end (log N ∝ 0.6·m).
      const mag = sampleFieldMagnitude(Math.random(), FMN, FMX);

      // Star color — weighted toward white/blue-white
      const colorIndex = Math.floor(Math.random() * STAR_COLORS.length);
      const color = STAR_COLORS[colorIndex];

      // Brightness is constant across the field (see header comment).
      colors[i * 3] = color.r * fieldBright;
      colors[i * 3 + 1] = color.g * fieldBright;
      colors[i * 3 + 2] = color.b * fieldBright;

      // Size on the same curve, floored at 1.2 px; alpha carries the faintness
      // below the floor. This cures sub-pixel crawl — no 0.5 px specks at full
      // alpha shimmering as they cross texel centres.
      const { size, alpha } = fieldSizeAlpha(mag, FMX, FIELD_CURVE);
      sizes[i] = size;
      alphas[i] = alpha;

      twinkle[i] = 0.0;
      phase[i] = Math.random() * Math.PI * 2;
    }

    // Named bright stars at the constellation vertices — the 49 catalogue
    // stars, written into indices 0..48 of the SAME buffers (same Points, zero
    // new draw calls). Position, size, brightness and colour all read from
    // starCatalog.js, so a star and its constellation line share one source of
    // truth and can never desync. Size carries the magnitude range (stars are
    // capped at 2.0 to stay under the bloom threshold, so brightness alone
    // cannot separate mag 0.1 from mag 3.5 under ACES); brightness carries the
    // truth. Both are monotone in magnitude. twinkle = 0 — these are real sky
    // and do not shimmer (Stage 5 repurposes aTwinkle; the attribute and shader
    // path stay in place).
    //
    // Colour-space: the spectral swatches are display-referred hex, so use
    // `new THREE.Color(0x…)` (applies sRGB→linear under three r155+ colour
    // management), NOT the raw-linear `new THREE.Color(r,g,b)` the random
    // palette above uses. Every swatch has one channel at 0xff, so the max
    // linear channel is 1.0 and no renormalization is needed; peak fragment
    // value is then 1.0 × 2.0 × uOpacity 0.95 = 1.9, safely under the 2.5
    // bloom threshold.
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

    // sizeBase/sizeSlope/brightMin/brightMax are shared with the field loop
    // above; only the catalogue-specific floor is needed here.
    const sizeMin = Constants.STAR_MAG_SIZE_MIN;

    // Buffer index = position in the flat traversal (figures in array order,
    // stars in array order) → 0..48. The test asserts the flat count is 49.
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
        // One curve for the whole sky: skyBrightness adds the soft ceiling to
        // the star curve, so Rigel (raw 2.23) reads 2.019 instead of a hard-
        // clamped 2.0 — still bloom-safe (2.019 × uOpacity 0.95 = 1.92 < 2.5),
        // and the planets share the exact same function (bodyCatalog).
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
    // Steady-star display gain (see steadyGain); 1 until update() knows the
    // renderer's pixel ratio.
    geometry.setAttribute('aGain', new THREE.BufferAttribute(new Float32Array(count).fill(1), 1));

    // ShaderMaterial — honors the per-star `size` attribute (PointsMaterial
    // could not), draws round soft-edged sprites via gl_PointCoord instead of
    // hard 1.5 px squares, and keeps the twinkle shader path in place (dormant
    // — every aTwinkle is 0 until Stage 5 repurposes it). Keeps
    // vertex colors + additive blending + depthWrite:false like before.
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: (typeof window !== 'undefined' && window.devicePixelRatio) || 1 },
        uSizeScale: { value: 1.5 },   // matches the old PointsMaterial base size
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
    points.frustumCulled = false; // Always render — surrounds the scene
    this._starMaterial = material;

    return points;
  }

  /**
   * Build the Milky Way band: MW_COUNT points scattered on the REAL galactic
   * frame (starCatalog.galacticBasis — pole RA 12.85h Dec +27.13°, centre RA
   * 17.76h Dec −28.9°), so it runs through Sagittarius, Cygnus and Cassiopeia as
   * it really does rather than on an invented tilt.
   *
   * Longitude is rejection-sampled against mwDensity (centre profile × Cygnus
   * cloud, normalized to 1.0 at the galactic centre), latitude gets a triangular
   * spread that widens toward the centre, and the Great Rift is carved as
   * NEGATIVE SPACE — points are skipped inside the lane rather than painted dark.
   *
   * Presence comes from DENSITY, the 1.2 px size floor (the same sub-pixel crawl
   * cure the field stars use) and collective additive overlap — never from
   * per-point peak, which stays below STAR_FIELD_BRIGHT so no band point can
   * out-shine an actual star. Sizes spread 1.2→4.5 px biased small to keep a
   * starry texture instead of blobs. Reuses the star ShaderMaterial (a clone with
   * lower opacity and no twinkle) for a single extra draw call.
   * @private
   */
  _createMilkyWay() {
    // TWO populations in one buffer. Raising the point count alone does NOT make
    // a band — it makes spray-paint speckle, because discrete dots stay discrete
    // however many you add. Haze needs OVERLAP: a few very large, very dim,
    // additively-blended sprites whose soft falloff (Gaussian, sigma 0.3 of the
    // radius for these big sprites, in the fragment shader) sums into continuous glow. The grain points then sit on top to keep
    // it from looking like an airbrushed smear.
    //   - HAZE  : MW_HAZE_COUNT points, ~45-105 px across, alpha ~0.05
    //   - GRAIN : MW_COUNT points, 1.2-4.5 px, the starry texture
    const count = Constants.MW_COUNT + Constants.MW_HAZE_COUNT;
    const radius = Constants.STAR_SPHERE_RADIUS * 0.985; // just inside the star shell
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    // Per-point aAlpha carries faintness variation across the band (was a flat
    // fill(1.0)) — the haze gets texture from brighter/dimmer regions.
    const alphas = new Float32Array(count);
    const twinkle = new Float32Array(count); // all 0 (band doesn't twinkle)
    const phase = new Float32Array(count);

    // REAL galactic basis (Stage 6): the band is built from the galactic frame
    // (galacticBasis() in starCatalog.js), NOT an invented tilt, so it runs
    // through the galactic center (Sagittarius), Cygnus and Cassiopeia as it
    // really does. center = l=0 (Sgr), e2 = l=90 (Cygnus), pole = +b.
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

    // Milky-Way palette — faint warm-white with a few dusty blue.
    const c0 = new THREE.Color(0.85, 0.86, 0.95);
    const c1 = new THREE.Color(0.95, 0.92, 0.85);

    // Published star clouds → unit directions plus two tangent vectors, so points
    // can be scattered in a disc on the sky around each centre.
    const clouds = (C.MW_STAR_CLOUDS || []).map((cd) => {
      const u = raDecToUnit(cd.ra, cd.dec);
      const dir = new THREE.Vector3(u.x, u.y, u.z).normalize();
      const t1 = new THREE.Vector3();
      // Any vector not parallel to dir gives a stable tangent frame.
      t1.copy(Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0))
        .cross(dir).normalize();
      const t2 = new THREE.Vector3().crossVectors(dir, t1).normalize();
      const D = Math.PI / 180;
      return { dir, t1, t2, a: Math.tan(cd.aDeg * D), b: Math.tan(cd.bDeg * D) };
    });

    const tmp = new THREE.Vector3();
    let placed = 0;
    let guard = 0;
    // Rejection-sample longitude so DENSITY peaks at the galactic center and
    // falls toward the anticenter (the real band is brightest/widest near Sgr);
    // the Great Rift and Cygnus cloud modulate acceptance further.
    // mwDensity composes the centre profile with the Cygnus boost and normalizes
    // the galactic centre to exactly 1.0, so it is directly usable as the
    // acceptance probability. It is the SAME function the test asserts against —
    // composing these terms here while the test checked only the profile is how
    // the band ended up 1.35× denser at Cygnus than at Sagittarius.
    while (placed < count && guard < count * 40) {
      guard++;
      const L = Math.random() * Math.PI * 2 - Math.PI;   // [−π, π]
      const density = mwDensity(L, C.MW_CENTER_CONTRAST, cygnusParams);   // (0, 1]
      if (Math.random() > density) continue;
      // Structure (centre-weighted, no Cygnus term) still drives WIDTH and
      // per-point BRIGHTNESS: the Cygnus cloud is a density feature, and pushing
      // it into brightness too would break the per-point peak cap.
      const structure = mwCenterProfile(L, C.MW_CENTER_CONTRAST) / C.MW_CENTER_CONTRAST;

      // Latitude spread: the band is widest near the galactic center. A quarter
      // of the points go into a wide faint halo (3× width, 0.8× brightness) so
      // the band reads as a bright core in a broad glow and thins out smoothly
      // instead of stopping dead at the core's edge.
      // Haze sprites stay in the CORE width. Given the 3x-wide halo they became
      // isolated 100 px smudges far off the band — the grain points supply the
      // wide faint fringe instead, where a stray dot reads as a star, not a smear.
      const isHaze = placed < C.MW_HAZE_COUNT;
      const halo = !isHaze && Math.random() < C.MW_HALO_FRACTION;
      const width = C.MW_BAND_WIDTH * (1 + (C.MW_BAND_WIDTH_CENTER - 1) * structure)
        * (halo ? C.MW_HALO_WIDTH_MULT : 1);
      // Three uniforms summed → bell-ish spread that arrives at zero smoothly
      // (two uniforms give a triangular spread with a hard stop and a steep
      // slope into it — that hard stop was the visible band edge).
      const spread = ((Math.random() + Math.random() + Math.random()) - 1.5) / 1.5 * width;

      // Great Rift: carve the dark lane (negative space). Published extent runs
      // Cygnus → Aquila → Ophiuchus (broadening) → Sagittarius → Centaurus.
      if (Math.random() > mwGreatRiftMask(L, spread, riftParams)) continue;

      // Point in the galactic plane at longitude L, lifted off-plane by `spread`.
      tmp.copy(center).multiplyScalar(Math.cos(L))
        .addScaledVector(e2, Math.sin(L));
      tmp.multiplyScalar(Math.cos(spread))
        .addScaledVector(pole, Math.sin(spread))
        .normalize();

      // BRIGHT STAR CLOUDS. The real band is patchy — its naked-eye character comes
      // from discrete bright knots flanking the rift, not from an even glow. A
      // fraction of points is redirected into the published clouds (see
      // MW_STAR_CLOUDS). This is a DENSITY concentration, so the per-point peak cap
      // is untouched; boosting brightness instead would break the star hierarchy.
      if (clouds.length && Math.random() < C.MW_CLOUD_EXTRA_FRACTION) {
        const cl = clouds[(Math.random() * clouds.length) | 0];
        // Centre-weighted with a SOFT taper, not a uniform disc: a uniform fill put
        // a hard rim on each cloud and read as a cluster with an edge. Three summed
        // uniforms give a bell that fades out with no boundary.
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

      // Brightness peaks at the center too, with per-point variation. Halo
      // points are dimmed (the two brightness tiers — core at full, halo at
      // 0.8× — are the brightness fade; do not add a per-star fade on top,
      // which measurably worsens the profile by dimming the halo that does
      // the smoothing).
      const b = C.MW_BRIGHT_MIN + (C.MW_BRIGHT_MAX - C.MW_BRIGHT_MIN) * structure * (0.55 + 0.45 * Math.random())
        * (halo ? C.MW_HALO_BRIGHT_MULT : 1);
      const col = Math.random() < 0.8 ? c0 : c1;
      // Haze keeps its own brightness level. Grain and haze must NOT share one
      // brightness: dimming grain to stop it rivalling real stars would otherwise
      // dim the glow by the same factor, which is exactly what happened once.
      // Haze stays safe because its per-point contribution is gated by its tiny
      // alpha (~0.024), not by this colour.
      const bp = isHaze ? b * C.MW_HAZE_BRIGHT_MULT : b;
      colors[placed * 3] = col.r * bp;
      colors[placed * 3 + 1] = col.g * bp;
      colors[placed * 3 + 2] = col.b * bp;

      // The first MW_HAZE_COUNT placed points are the haze layer. They share the
      // band's structure (density, width, Great Rift, Sagittarius bulge) so the
      // glow follows the real geometry — only their size and alpha differ.
      if (isHaze) {
        sizes[placed] = C.MW_HAZE_SIZE_MIN + Math.random() * (C.MW_HAZE_SIZE_MAX - C.MW_HAZE_SIZE_MIN);
        alphas[placed] = C.MW_HAZE_ALPHA * (0.6 + 0.4 * (b / C.MW_BRIGHT_MAX));
      } else {
        sizes[placed] = C.MW_SIZE_FLOOR + Math.pow(Math.random(), 1.8) * C.MW_SIZE_VAR; // biased small (starry texture, not blobs)
        alphas[placed] = 0.6 + 0.4 * (b / C.MW_BRIGHT_MAX);              // faintness variation
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
    // Steady-star display gain — grain only; the haze keeps 1 (see steadyGain).
    geometry.setAttribute('aGain', new THREE.BufferAttribute(new Float32Array(count).fill(1), 1));
    this._mwHazeCount = Math.min(placed, Constants.MW_HAZE_COUNT);

    // Same shader as the main stars but lower overall opacity for a haze read.
    // Presence comes from DENSITY + the size floor + collective additive overlap,
    // not from per-point peak (which stays < STAR_FIELD_BRIGHT — see MW_OPACITY).
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
   * Initialize the shooting-star system: a single reusable 2-vertex additive
   * line (LineSegments) that stays hidden until a meteor fires. One meteor
   * every 60–120 s, streaking for ~0.35 s across a random arc of the sky.
   * Cheap: one line, no per-frame allocation.
   * @private
   */
  _initShootingStar() {
    const geom = new THREE.BufferGeometry();
    // 2 vertices (head, tail); positions updated per active frame.
    this._meteorPos = new Float32Array(6);
    geom.setAttribute('position', new THREE.BufferAttribute(this._meteorPos, 3));
    // Per-vertex color so the tail fades to black (streak look).
    this._meteorCol = new Float32Array([1, 1, 1, 0, 0, 0]);
    geom.setAttribute('color', new THREE.BufferAttribute(this._meteorCol, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      // B1: depthTest ON (matches the star/Milky Way materials). The meteor
      // lives on the star shell (r≈392); with depthTest:false a far-side meteor
      // drew OVER the opaque Earth (only ~0.6 units away, writes depth) — a
      // white streak across the day disc. depthTest lets the Earth occlude it.
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

  /**
   * Advance the shooting-star scheduler + active streak.
   * @param {number} dt — seconds
   * @private
   */
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
      // Head advances along the arc; tail trails behind by a fixed fraction.
      const head = Math.min(1, t * 1.15);
      const tail = Math.max(0, head - 0.12);
      const hv = this._tmpMeteorA.copy(this._meteorStart).lerp(this._meteorEnd, head);
      const tv = this._tmpMeteorB.copy(this._meteorStart).lerp(this._meteorEnd, tail);
      this._meteorPos[0] = hv.x; this._meteorPos[1] = hv.y; this._meteorPos[2] = hv.z;
      this._meteorPos[3] = tv.x; this._meteorPos[4] = tv.y; this._meteorPos[5] = tv.z;
      this._meteor.geometry.attributes.position.needsUpdate = true;
      // Fade in fast, out slow (ease the whole streak's opacity by a sine).
      this._meteorMat.opacity = Math.sin(t * Math.PI) * 0.9;
      return;
    }
    this._meteorTimer -= dt;
    if (this._meteorTimer <= 0) this._fireShootingStar();
  }

  /** Launch a shooting star along a random short arc. @private */
  _fireShootingStar() {
    const radius = Constants.STAR_SPHERE_RADIUS * 0.98;
    // Random start direction on the sphere.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    this._meteorStart.set(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi)
    );
    // End point: a short random offset direction, re-projected to the shell.
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

  /**
   * Build constellation line outlines and planetarium-style name labels.
   * Lines and labels are added to the star group so they co-rotate.
   * @private
   */
  _createConstellations() {
    const radius = Constants.STAR_SPHERE_RADIUS;
    // Hotkey revamp 2026-06-14: collect constellation line + label objects so
    // the 6 key ("Constellation names" toggle) can show/hide them without
    // affecting the star field itself.
    this._constellationObjects = this._constellationObjects || [];
    // Label sprites also tracked on their own: the lines get their limb fade
    // in-shader, the sprites get the CPU twin in update().
    this._constellationLabels = this._constellationLabels || [];
    // Scratch vectors for _limbFadeFactor — allocated once, never per frame.
    this._limbScratchA = this._limbScratchA || new THREE.Vector3();
    this._limbScratchB = this._limbScratchB || new THREE.Vector3();
    this._limbScratchC = this._limbScratchC || new THREE.Vector3();

    // Shared Line2 material — screenspace-width lines that stay visible at any distance.
    // LineMaterial renders sub-pixel-to-few-pixel lines via geometry shaders,
    // bypassing the WebGL 1px lineWidth hardware clamp that made
    // LineBasicMaterial invisible.
    //
    // Styling lives in Constants.CONSTELLATION_* so it can be tuned in one
    // place. NOTE: do NOT enable alphaToCoverage here — the renderer runs
    // antialias:false behind an EffectComposer (SceneManager), so there is no
    // MSAA for it to resolve against; thin lines rely on the SMAA/FXAA pass.
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

    // Trim each line segment back from its endpoints so it stops short of the
    // star core instead of ending on top of it — a normal-blended line over an
    // additive star dims the core. The trim is the larger of a fixed gap
    // (Constants.CONSTELLATION_LINE_GAP, ≈6 px) and 2% of the segment length,
    // capped at 25% of the length so the short Shaula–Lesath arm (~2.9 units)
    // is not inverted.
    const GAP = Constants.CONSTELLATION_LINE_GAP;
    const _trimDir = new THREE.Vector3();

    for (const cst of CONSTELLATION_FIGURES) {
      // Resolve the figure's star names → 3D vectors on the sphere, reading the
      // SAME catalogue the rendered stars use so a line can never miss its star.
      const stars3d = cst.stars.map((n) => raDec2xyz(BRIGHT_STARS[n].ra, BRIGHT_STARS[n].dec, radius));

      // Build line segment pairs (flat array for LineSegmentsGeometry), with
      // both ends of every segment trimmed back toward the interior.
      const verts = [];
      for (const [a, b] of cst.lines) {
        const pa = stars3d[a];
        const pb = stars3d[b];
        const L = pa.distanceTo(pb);
        const trim = Math.min(Math.max(0.02 * L, GAP), 0.25 * L);
        // pa + (pb - pa) * (trim / L)  and  pb + (pa - pb) * (trim / L)
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
      // Session O (plan D11, owner 2026-09-07): constellations ship OFF — the
      // effective default is false, so every figure is BORN hidden and the very
      // first frame is already clean. That includes the MENU backdrop, which is
      // this same live sky seen through the transparent menu canvas (main.js
      // backdrop-reveal note). main.js restores a stored `true` (veteran) at
      // boot — and since 2026-09-09 ALSO masks the figures while the game
      // state is MENU (setMenuSuppressed), so a veteran's ON setting no longer
      // paints figures over the hero mother.
      lineObj.visible = false;
      this.group.add(lineObj);
      this._constellationObjects.push(lineObj);

      // Compute centroid for label placement, re-project onto sphere
      const center = new THREE.Vector3();
      for (const p of stars3d) center.add(p);
      center.divideScalar(stars3d.length).normalize().multiplyScalar(radius);

      // Planetarium-style text label sprite — subtle, matches original aesthetic
      const label = new THREE.Sprite(new THREE.SpriteMaterial({
        map: createConstellationLabel(cst.name),
        transparent: true,
        opacity: Constants.CONSTELLATION_LABEL_OPACITY,
        depthWrite: false,
        depthTest: true,         // occlude behind Earth mesh and celestial body depth masks
      }));
      // Nudge the label sideways (tangent to the star sphere) so the glyphs sit
      // beside the constellation lines instead of on top of them — e.g. Orion's
      // "i" previously landed directly over the belt line.
      const tangent = new THREE.Vector3()
        .crossVectors(center, new THREE.Vector3(0, 1, 0));
      // Fall back to world X if the centroid is near the poles (degenerate cross).
      if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0);
      tangent.normalize().multiplyScalar(-30); // shift toward screen-left
      label.position.copy(center).add(tangent);
      label.scale.set(50, 12, 1);
      label.frustumCulled = false;
      // Born hidden — same Session O (plan D11) reasoning as the line objects
      // above: OFF is the shipped default, so the sprites must not flash in
      // either on the first gameplay frame or behind the menu backdrop.
      label.visible = false;
      this.group.add(label);
      this._constellationObjects.push(label);
      // Also tracked separately so update() can apply the same limb fade the
      // lines get in-shader (8 sprites — negligible per-frame cost).
      this._constellationLabels.push(label);
    }
  }

  /**
   * Inject a soft Earth-limb fade into the constellation LineMaterial.
   *
   * WHY: with depthTest:true a constellation edge crossing the Earth limb is
   * chopped dead at the silhouette, leaving a straight saturated line with a
   * hard endpoint apparently ON the surface — which reads unmistakably as a
   * rocket launch plume. Fading the lines out BEFORE they reach the limb glow
   * removes that cue entirely (the z-test then only ever hides already-invisible
   * pixels).
   *
   * HOW: per-fragment angular fade. Earth sits at the world origin (Earth.js
   * never moves its group; the floating origin is DebrisField-local), so
   * Earth's view-space centre is just viewMatrix[3].xyz — no per-frame uniform
   * plumbing needed. A varying carries each fragment's view-space position;
   * because varyings interpolate perspective-correctly along the segment, every
   * fragment gets the true 3D point beneath it without subdividing the geometry.
   * Chord-vs-great-circle error is a couple of degrees and irrelevant to a soft
   * ramp.
   *
   * The fade reference radius is ATMOSPHERE_RADIUS (not EARTH_RADIUS) so the
   * ramp completes outside the visible airglow band — the atmosphere shell is
   * depthWrite:false, so lines would otherwise punch straight through it.
   * @param {LineMaterial} material
   * @private
   */
  _installLimbFade(material) {
    const uniforms = {
      uLimbRadius:    { value: Constants.ATMOSPHERE_RADIUS },
      uLimbFadeScale: { value: Constants.CONSTELLATION_LIMB_FADE_SCALE },
      uLimbFadeMin:   { value: Constants.CONSTELLATION_LIMB_FADE_MIN },
      uLimbFadeMax:   { value: Constants.CONSTELLATION_LIMB_FADE_MAX },
    };

    // Anchors below are tied to vendored three r184
    // (vendor/three/examples/jsm/lines/LineMaterial.js). A silently-missed
    // replace would drop the fade with no error, so each one is asserted.
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

      // position.y < 0.5 is the same start/end selector the stock shader
      // already uses for instanceColorStart/End. Use the raw endpoint (not the
      // screen-space-expanded quad corner) so the fade varies ALONG the line
      // rather than across its width.
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

      // Injected after the endcap discards so it modulates the final alpha.
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

    // Keep the injected variant from sharing a compiled program with a stock
    // LineMaterial (ShaderMaterial cache keys ignore onBeforeCompile).
    material.customProgramCacheKey = () => 'constellationLimbFade';
  }

  /**
   * CPU-side twin of the in-shader limb fade, for the name-label sprites.
   * Returns the 0..1 ramp for a world-space point as seen from `camera`.
   * @param {THREE.Vector3} worldPos
   * @param {THREE.Camera} camera
   * @returns {number}
   * @private
   */
  _limbFadeFactor(worldPos, camera) {
    // Earth is at the world origin, so camera.position doubles as the
    // camera→Earth-centre vector (negated).
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
    // smoothstep(thetaLimb, thetaLimb + band, theta)
    const t = Math.max(0, Math.min(1, (theta - thetaLimb) / band));
    return t * t * (3 - 2 * t);
  }

  /**
   * Show/hide the constellation outlines + name labels (hotkey revamp
   * 2026-06-14 — the 6 key). Leaves the star field untouched. This is the
   * player's INTENT bit; the objects' `visible` also honours the MENU mask
   * (setMenuSuppressed) — under the mask a `true` here is remembered, not
   * shown, and appears the moment the mask lifts.
   * @param {boolean} visible
   */
  setConstellationsVisible(visible) {
    this._constellationsVisible = !!visible;
    this._applyConstellationVisibility();
  }

  /** Toggle constellation outlines + labels (6 key).
   *  @returns {boolean} the NEW visibility state — the INTENT (for reactive
   *  comms feedback), whether or not the MENU mask is currently hiding it. */
  toggleConstellations() {
    this.setConstellationsVisible(!(this._constellationsVisible ?? false));
    return this._constellationsVisible;
  }

  /** @returns {boolean} whether constellation outlines + labels are visible —
   *  the player's INTENT (never the menu mask's effect), so the 6 key, the
   *  Sky-labels rung prior and the F5 SDA prior read the same bit they write.
   *  Session O (plan D11, owner 2026-09-07): the effective default is
   *  OFF (false) until the player first toggles — the figures are born
   *  hidden so the first frame, incl. the menu backdrop (same live sky),
   *  is clean. main.js boot-applies a stored `true` (veteran) after
   *  construction. */
  isConstellationsVisible() {
    return this._constellationsVisible ?? false;
  }

  /**
   * The MENU mask (2026-09-09, owner: "constellation figures must not show on
   * the MENU — they distract from the hero mother"): while `true` every
   * figure object is hidden regardless of intent; `false` restores whatever
   * the intent says. Written by the hub (main.js) from the game state — MENU
   * only — once at wiring and on every GAME_STATE_CHANGE; never by a key, a
   * rung or the F5 chart, so it cannot race their capture/restore priors.
   * Idempotent; a no-op re-apply is cheap (8 figures + 8 sprites).
   * @param {boolean} suppressed
   */
  setMenuSuppressed(suppressed) {
    this._menuSuppressed = !!suppressed;
    this._applyConstellationVisibility();
  }

  /** @returns {boolean} whether the MENU mask is currently hiding the figures. */
  isMenuSuppressed() {
    return !!this._menuSuppressed;
  }

  /**
   * The ONE writer of the figure objects' `visible`: intent AND NOT mask.
   * Both setters route here so the two bits can never disagree with the scene
   * objects. The label opacity fade in update() is opacity only and reads
   * nothing here.
   * @private
   */
  _applyConstellationVisibility() {
    const on = !!this._constellationsVisible && !this._menuSuppressed;
    for (const obj of (this._constellationObjects || [])) {
      obj.visible = on;
    }
  }

  /**
   * Enable/disable camera-follow mode (Zoom Ladder F4/F5 BLACK-SKY fix).
   *
   * The starfield is a world-fixed shell of radius STAR_SPHERE_RADIUS (400 u)
   * centered on Earth. A world-fixed shell is only fully visible while
   * far >= D_max + R, where D is the camera's distance from Earth center —
   * a star directly behind Earth sits at camera distance D + R, NOT R. The
   * shipped pairing (far 500) therefore only covers D <= 100 u, which the
   * Earth-anchored ladder floors exceed: on F4 (D ∈ [70, 255], far 500)
   * far-plane point clipping opens a black annulus around Earth's disk
   * (appearing at D ≈ 123, swallowing the whole sky by D ≈ 167 — F4 max is
   * 255), and on F5 (D ∈ [500, 1300], far 2000) the camera EXITS the 400 u
   * shell entirely, leaving stars only in an 18–53° cap.
   *
   * Following re-centers the shell on the camera's WORLD position every
   * update(): stars become pure DIRECTION chrome at camera distance exactly R,
   * inside every floor's far plane by construction. This is safe because every
   * starfield child is frustumCulled:false (no culling desync), all materials
   * are transparent + AdditiveBlending + depthWrite:false (no z-fight from the
   * moved group), the constellation-line limb fade is computed in VIEW space
   * from the view matrix (parenting-independent), the label limb fade resolves
   * labels' ACTUAL world positions via getWorldPosition, and Earth still
   * occludes stars correctly via depthTest (its limb is always far closer than
   * R camera-relative).
   *
   * Disabled (the default) is exactly the shipped behavior: update() never
   * touches the group transform. Disabling AFTER following restores the
   * shipped Earth-centered pose (group back to the origin) so a ladder
   * disengage cannot strand the shell off-center.
   *
   * Known follow-mode limits (cosmetic/dev-only, owned by the ladder wiring):
   * the SunLight body depth masks (BODY_DEPTH_MASK_DIST, coupled to the
   * world-fixed shell) can sit beyond the followed stars for far-side bodies,
   * letting stars show through a body disc at F4/F5 ranges. (The ?shot=1
   * harness hooks — __scbSkyPose/__scbProject, main.js — add the shell
   * group's offset since the serial hub wiring, so they stay in sync in
   * follow mode.)
   *
   * @param {boolean} enabled
   * @returns {boolean} the NEW follow state
   */
  setFollowCamera(enabled) {
    const on = !!enabled;
    if (on !== this.isFollowingCamera() && !on) {
      // Follow → world-fixed: restore the shipped Earth-centered pose now
      // rather than leaving the shell parked at the last camera position.
      this.group.position.set(0, 0, 0);
      this.group.updateMatrixWorld(true);
    }
    this._followCamera = on;
    return on;
  }

  /** @returns {boolean} whether the shell follows the camera (default false). */
  isFollowingCamera() {
    return this._followCamera === true;
  }

  /**
   * Fill the aGain attribute of the stars and the Milky Way grain for one pixel
   * ratio / browser stretch (see steadyGain): each star's level is its colour
   * luminance x aAlpha x its material's uOpacity. Called by update() when either
   * changes; a few ms (plus one table build per new stretch).
   * @param {number} pixelRatio  renderer pixel ratio
   * @param {number} stretch     devicePixelRatio / pixelRatio
   * @private
   */
  _applySteadyGains(pixelRatio, stretch) {
    stretch = Math.min(3, Math.max(1, stretch));   // a ?pixelRatio override above DPR reads as 1:1
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
    // Sprite width for this stretch (wider under a non-integer stretch).
    for (const mat of [this._starMaterial, this._milkyWayMaterial]) {
      if (!mat) continue;
      mat.uniforms.uMinDia.value = steadyMinDia(stretch);
      mat.uniforms.uSigmaPx.value = steadySigmaPx(stretch);
    }
    fill(this.mesh, this._starMaterial.uniforms.uOpacity.value, 0);
    fill(this._milkyWay, this._milkyWayMaterial ? this._milkyWayMaterial.uniforms.uOpacity.value : 1, this._mwHazeCount || 0);
  }

  /**
   * Per-frame update: apply camera-follow (when enabled), advance twinkle time,
   * keep pixel-ratio + Line2 material resolution in sync with the viewport.
   * @param {number} _dt — delta time (seconds)
   * @param {number} [pixelRatio] — the RENDERER's capped pixel ratio (B2). Falls
   *   back to window.devicePixelRatio when undefined so the class stays usable
   *   standalone (e.g. in tests / menu preview).
   * @param {THREE.Camera} [camera] — active camera, used to apply the Earth-limb
   *   fade to the constellation name sprites (the lines do it in-shader) and, in
   *   follow mode (setFollowCamera), as the position the shell re-centers on.
   *   When omitted the sprites keep their static opacity and a following shell
   *   holds its last pose — same defensive style as pixelRatio above, so the
   *   class stays usable standalone (older call shapes pass no camera).
   */
  update(_dt, pixelRatio, camera) {
    const dt = (typeof _dt === 'number' && isFinite(_dt)) ? _dt : 0;
    // B3: wrap the accumulator to keep float32 precision. 251.327 = 100 twinkle
    // periods (2π / 2.5 ≈ 2.51327 s); wrapping on a whole multiple keeps
    // sin(uTime*2.5 + phase) continuous across the wrap so twinkle never jumps.
    this._time = (this._time + dt) % 251.327;

    // Camera-follow (F4/F5 BLACK-SKY fix — rationale in setFollowCamera): copy
    // the camera's WORLD position into the group BEFORE anything below derives
    // world poses this frame (the label limb fade reads label.getWorldPosition).
    // Duck-typed cameras without getWorldPosition (tests / older call shapes)
    // fall back to .position; no camera at all simply holds the last pose.
    // Disabled (default) this block never touches the group — byte-identical
    // rendering to the shipped world-fixed shell.
    if (this._followCamera && camera) {
      if (typeof camera.getWorldPosition === 'function') {
        camera.getWorldPosition(this.group.position); // writes the target Vector3 — no alloc
      } else if (camera.position) {
        this.group.position.copy(camera.position);
      }
      // Necessary matrix update: keep the group's matrixWorld coherent for any
      // same-frame reader (label fade below, external world-pose queries)
      // instead of waiting for the renderer's scene.updateMatrixWorld().
      this.group.updateMatrixWorld(true);
    }

    // Drive the star time uniform (the twinkle path is dormant — every
    // aTwinkle is 0 — until Stage 5 repurposes it).
    if (this._starMaterial) {
      this._starMaterial.uniforms.uTime.value = this._time;
      // Keep pixelRatio current for correct on-screen star size after a
      // window move between displays of different density. B2: prefer the
      // renderer's capped ratio passed in; fall back to devicePixelRatio.
      const pr = (typeof pixelRatio === 'number' && isFinite(pixelRatio) && pixelRatio > 0)
        ? pixelRatio
        : ((typeof window !== 'undefined' && window.devicePixelRatio) || 1);
      this._starMaterial.uniforms.uPixelRatio.value = pr;
      if (this._milkyWayMaterial) this._milkyWayMaterial.uniforms.uPixelRatio.value = pr;
      // Steady-star gains depend on the drawn width (pixel ratio) and on how far
      // the browser stretches the canvas (devicePixelRatio / pixel ratio): refill
      // only when either changes (boot, tier change, display move).
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || pr;
      if (pr !== this._steadyGainPR || dpr !== this._steadyGainDPR) {
        this._applySteadyGains(pr, dpr / pr);
        this._steadyGainPR = pr;
        this._steadyGainDPR = dpr;
      }
    }

    // Shooting-star scheduler + active streak.
    this._updateShootingStar(dt);

    // Line2 LineMaterial needs current viewport resolution for correct screenspace width
    if (this._constellationLineMaterial) {
      this._constellationLineMaterial.resolution.set(
        window.innerWidth, window.innerHeight
      );
    }

    // Match the in-shader limb fade on the name sprites so a label does not
    // hang crisply over the airglow band after its lines have dissolved.
    // Opacity only — `visible` stays owned by _applyConstellationVisibility()
    // (intent && !menu mask; see setConstellationsVisible / setMenuSuppressed).
    if (camera && this._constellationLabels && this._constellationLabels.length) {
      const base = Constants.CONSTELLATION_LABEL_OPACITY;
      for (const label of this._constellationLabels) {
        // The star group is never transformed today, but resolve world space
        // anyway so a future sky rotation cannot silently desync the fade.
        const worldPos = label.getWorldPosition(this._limbScratchC);
        label.material.opacity = base * this._limbFadeFactor(worldPos, camera);
      }
    }
  }
}

export default Starfield;
