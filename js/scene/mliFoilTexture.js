/**
 * mliFoilTexture.js — MLI (Multi-Layer Insulation) blanket maps, v7 — BAKED.
 *
 * v7 (2026-10-13, lane v2-foil-mli) replaces the v5/v6 "draped crumpled gold"
 * look with a BLANKET: aluminised-Kapton panels sewn together, not one crumpled
 * sheet. Owner: "3 have gold mylar foil to wrap mother body". Real hardware
 * (NASA JPL Cassini thermal-blanket page; SAOCOM-1B blanket photo; Spacecraft
 * Thermal Control Handbook ch. 5 — see the plan Log): amber-gold Kapton panels
 * ~0.4–0.6 m wide, closed along every seam with edge-binding tape (12 mm band,
 * darker orange, stitched), tie-down buttons (white/cream) on a sparse grid, broad
 * soft billows between the seams and a fine continuous crinkle. All of it is in
 * the BAKED maps — no extra meshes.
 *
 * ── MAPS (3 per variant; PNGs in `textures/mli_foil_v7_*.png`) ────────────────
 *   albedo : RGB sRGB. The amber foil tint (`MLI_FOIL_LOOK.color`) is BAKED into
 *            the map (the THREE material colour is white), so the tie-down
 *            buttons can be white/light grey; binding tape carries a darker
 *            orange; stitches are dark thread.
 *   normal : RGB tangent-space, from the gradient of a metre-scaled height field.
 *   rm     : RGB, G = roughness (relative; the material roughness multiplies it),
 *            B = metalness (relative; foil 1.0, binding tape ~0.45, buttons ~0).
 *            ONE texture serves both `roughnessMap` (reads G) and `metalnessMap`
 *            (reads B).
 *
 * ── TWO VARIANTS (see FOIL_VARIANTS) ──────────────────────────────────────────
 *   `crumpled` — barrel skin. The tile is the 2.513 m × 2.0 m barrel UV (one
 *     un-tiled [1,1] wrap; u = 1 is an integer wrap so the cylinder is seamless).
 *     4 bands × 5 panels, band seams jittered ±6 cm, panel columns staggered per
 *     band; every panel centre carries a tie-down button on a tape patch.
 *   `flat`     — instrument box (IR sensor). The tile is mapped onto every face
 *     (BoxGeometry UVs), so it is ONE taut panel: tape along the tile border (=
 *     the box edges), one button, almost no crinkle. Same colour/metal/rough
 *     family as the barrel (D3).
 *
 * ── BAKE PIPELINE (this module is the SOURCE OF TRUTH) ────────────────────────
 * `buildFoilPixels` is deterministic (hash-based, no time/random seed) and pure
 * JS with NO DOM, so it runs identically in Node. `node scripts/bake-foil-maps.mjs`
 * encodes the result to lossless PNGs and the RUNTIME loads those instead of
 * generating pixels. The hash bottoms out in `Math.sin`, whose last-ULP behaviour
 * is engine-specific — bake on Node/V8 only; re-bakes on the same toolchain are
 * byte-stable.
 *
 * ⚠ DEPLOY NOTE: sw.js serves `/textures/` CACHE-FIRST, so an in-place edit never
 * reaches a returning player until CACHE_NAME bumps. That is why v7 uses NEW file
 * names (`mli_foil_v7_*`): a new name is a cache miss. A future re-bake that
 * changes the look MUST also take a new name (v8…).
 *
 * ── TRAPS (kept from v5) ──────────────────────────────────────────────────────
 *  - Resolution independence: slopes are computed from a height in METRES with the
 *    metre pixel pitch, so the look does not depend on the bake size.
 *  - No data-dependent normalisation, no blur.
 *  - SIGN: canvas rows run top-down while UV v runs bottom-up, so the byte write
 *    NEGATES ny (G = (−ny)·0.5+0.5). `THREE.Texture`/`ImageLoader` default
 *    `flipY = true` like `CanvasTexture`; do NOT touch flipY or use
 *    ImageBitmapLoader.
 *  - Placeholder size: r184 uploads regular textures through IMMUTABLE
 *    `texStorage2D`; the placeholder canvas MUST be the same size as the PNG that
 *    replaces it (see `FOIL_BAKE_SIZE`, per variant).
 *
 * **Returns null in headless/no-DOM environments** (tests instantiate
 * PlayerSatellite in node with no document).
 *
 * @module scene/mliFoilTexture
 */

import * as THREE from 'three';

/**
 * The foil's material look — the ONE place PlayerSatellite reads it from, so the
 * scan-flash restore can never drift from the build default again (the v6 bug:
 * restore 0x4a3008 vs build 0x4a3d12).
 *
 * COLOUR (D1): aluminised-Kapton amber-gold. NASA JPL: the gold is "amber-coloured
 * Kapton over an aluminised layer, not gold metal" (Cassini thermal-blankets page).
 * The old lemon 0xe3c24d (R:G 1.16, saturation 0.66) read as toy yellow and, in
 * shadow (a metal reflecting black space), olive. 0xd9b062 (v7.0; now 0xd9a052) is warmer (hue ~40°
 * vs 46°) and LESS saturated (0.55 vs 0.66), R:G 1.23 — between lemon and the
 * rejected copper (0xd6a43e, R:G 1.30, saturation 0.71). The reference photo base
 * is ~#C98A2B with orange in the shade; the shade is carried by the warm emissive
 * (0x5c3a12) rather than by a more orange metal colour.
 *
 * roughness 0.88 × the rm-map G (foil 0.55–0.85) ⇒ effective ~0.48–0.75: broad,
 * soft highlights, no mirror blotches.
 *
 * v7.1 highlight-wash fix (owner review of frames 19/14): the lit foil washed to pale
 * cream (top-10 % brightest foil pixels in frame 19: hue 43.8°, sat 0.337). Material
 * roughness 0.60 → 0.88 (frame 14 also washed: 0.80 left its set at sat 0.27) and the tint 0xd9b062 → 0xd9a052 (a slightly warmer,
 * more orange amber, = the old tint × 0xffe9d8) lift that set to hue ~39°, sat ~0.50
 * without browning the shade. metalness 1.0 × the rm-map B.
 */
export const MLI_FOIL_LOOK = Object.freeze({
  color: 0xd9a052,            // foil TINT: baked into the albedo map (buildFoilPixels), NOT the material colour
  materialColor: 0xffffff,    // THREE material .color: white, so the tie-down buttons stay white
  metalness: 1.0,
  roughness: 0.88,
  emissive: 0x5c3a12,
  emissiveIntensity: 0.16,
});

/** Deterministic 2-D hash → 0..1 (wrapped integer lattice coordinates only). */
function _hash01(x, y, salt) {
  const s = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

const _quint = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Seamless value noise on the unit square with independent lattice periods per
 * axis (`pu`, `pv` — integers). Quintic interpolation ⇒ C2-continuous, so the
 * normal map has no facet edges. Any (u, v) is valid (wraps), which lets the
 * domain warp push samples outside [0,1).
 */
function _vn(u, v, pu, pv, salt) {
  const x = u * pu, y = v * pv;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = _quint(x - x0), fy = _quint(y - y0);
  const wx0 = ((x0 % pu) + pu) % pu, wx1 = (wx0 + 1) % pu;
  const wy0 = ((y0 % pv) + pv) % pv, wy1 = (wy0 + 1) % pv;
  const n00 = _hash01(wx0, wy0, salt), n10 = _hash01(wx1, wy0, salt);
  const n01 = _hash01(wx0, wy1, salt), n11 = _hash01(wx1, wy1, salt);
  const a = n00 + (n10 - n00) * fx, b = n01 + (n11 - n01) * fx;
  return a + (b - a) * fy;
}

const _smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * v7 VARIANT TABLE. Lengths are METRES (the tile's real-world size is `W`×`H`).
 *
 *  - `bands`,`cols`: blanket panel layout (cols per band; each band's column seams
 *    are staggered by a hashed offset when `stagger`).
 *  - `bandJit` (m) jitters the band seams; `colJit` (column units) the column seams.
 *  - `tapeHalf`: binding-tape half-width (v7.1 owner-review cut: 12 mm band = 0.006 on the barrel, 7 mm = 0.0035 on the IR box; was 24 mm / 14 mm).
 *  - `tapeLift`: tape thickness above the foil. `stitchPitch`: dash period.
 *  - `pillowAmp` (m) / `pillowRamp` (m): the taut-at-the-seam, billowing-in-the-
 *    middle panel bulge.
 *  - `octaves`: [wavelength m, half-amplitude m] fine-continuous crinkle (value
 *    noise, C2) — the finest is ~20 mm so a bake pixel (~2 mm) resolves it.
 *    `creases`: ridged noise ([wavelength, half-amp]) = soft handling creases.
 *  - `warp` (m): domain-warp displacement (breaks the lattice grid).
 *  - `gain`: slope multiplier on the normal map (a look dial; geometry is in m).
 *  - `button`: {r, patch, lift} radius / tape-patch half-size / dome height (m);
 *    null for none. One button at each panel centre.
 *  - `rough`/`toneSpan`/`creaseDarken`: per-pixel rm/albedo mapping.
 */
const FOIL_VARIANTS = {
  crumpled: {                       // barrel skin: 2.513 m × 2.0 m tile
    W: 2.513, H: 2.0,
    bands: 4, cols: 5, bandJit: 0.12, colJit: 0.18, stagger: true,
    tapeHalf: 0.006, tapeLift: 0.0015, stitchPitch: 0.012,
    pillowAmp: 0.008, pillowRamp: 0.20,
    octaves: [[0.40, 0.0050], [0.18, 0.0034], [0.085, 0.0020], [0.04, 0.00110], [0.02, 0.00055]],
    creases: [[0.60, 0.0040], [0.25, 0.0022], [0.12, 0.0010]],
    warp: 0.02,
    gain: 2.3,
    button: { r: 0.013, patch: 0.028, lift: 0.0035 },
    rough: { base: 0.60, span: 0.08, crease: 0.14, lo: 0.55, hi: 0.85 },
    toneSpan: 0.03, creaseDarken: 0.05, slopeRef: 0.35,
  },
  flat: {                           // IR box: one taut panel, 0.2 m × 0.2 m tile
    W: 0.2, H: 0.2,
    bands: 1, cols: 1, bandJit: 0, colJit: 0, stagger: false,
    tapeHalf: 0.0035, tapeLift: 0.0012, stitchPitch: 0.008,
    pillowAmp: 0.0006, pillowRamp: 0.05,
    octaves: [[0.2, 0.0004], [0.1, 0.00018], [0.05, 0.00008]],
    creases: [],
    warp: 0.004,
    gain: 1.2,
    button: { r: 0.013, patch: 0.028, lift: 0.0035 },
    rough: { base: 0.66, span: 0.0, crease: 0.06, lo: 0.60, hi: 0.78 },
    toneSpan: 0.0, creaseDarken: 0.03, slopeRef: 0.20,
  },
};

/** Bake size (px, square) per variant. The loader's placeholder canvases use it. */
export const FOIL_BAKE_SIZE = Object.freeze({ crumpled: 1024, flat: 512 });

/** Binding-tape / button-patch albedo (sRGB bytes/255); × the foil tint ⇒ dark orange. */
const TAPE_ALBEDO = [0.80, 0.62, 0.50];
/** Tie-down buttons are WHITE/light grey plastic (SAOCOM-1B photo): NOT tinted by the foil colour. */
const BUTTON_ALBEDO = [0.90, 0.90, 0.88];
const _srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const _linToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
/** Foil tint (MLI_FOIL_LOOK.color) as linear-RGB multipliers; baked into the albedo so buttons can stay white. */
const FOIL_TINT_LIN = [16, 8, 0].map((sh) => _srgbToLin(((MLI_FOIL_LOOK.color >> sh) & 255) / 255));
const THREAD_ALBEDO = 0.28;
/** Relative metalness of the tape (aluminised Kapton tape is still partly metallic) and buttons (matte). */
const TAPE_METAL = 0.45;
const BUTTON_METAL = 0.05;
const TAPE_ROUGH = 0.95;
const BUTTON_ROUGH = 0.90;

/** Precompute the panel layout: band seams, per-band stagger offsets and column seam jitter. */
function _buildLayout(vp) {
  const bnd = new Float64Array(vp.bands + 1);
  const off = new Float64Array(vp.bands);
  const colJ = [];
  for (let k = 0; k < vp.bands; k++) {
    bnd[k] = (k / vp.bands) * vp.H + (vp.bandJit ? (_hash01(k, 0, 201) - 0.5) * vp.bandJit : 0);
    off[k] = vp.stagger ? _hash01(k, 0, 202) : 0;
    const row = new Float64Array(vp.cols);
    for (let c = 0; c < vp.cols; c++) row[c] = vp.colJit ? (_hash01(k * 17 + c, 3, 203) - 0.5) * vp.colJit : 0;
    colJ.push(row);
  }
  bnd[vp.bands] = bnd[0] + vp.H;
  return { bnd, off, colJ };
}

/**
 * Locate the panel containing metre coordinate (x, y): returns the seam distance
 * (metres), which kind of seam is nearest, the panel id and the offset to the
 * panel centre.
 */
function _locate(x, y, vp, lay, out) {
  const { bnd, off, colJ } = lay;
  let yy = y;
  if (yy < bnd[0]) yy += vp.H;
  let k = 0;
  while (k + 1 < vp.bands && yy >= bnd[k + 1]) k++;
  const dH = Math.min(yy - bnd[k], bnd[k + 1] - yy);
  const colW = vp.W / vp.cols;
  const t = x / colW - off[k];
  const c0 = Math.floor(t);
  let c = c0, Bc = 0, Bn = 1;
  for (let cc = c0 - 1; cc <= c0 + 1; cc++) {
    const bcc = cc + colJ[k][((cc % vp.cols) + vp.cols) % vp.cols];
    const bnn = cc + 1 + colJ[k][(((cc + 1) % vp.cols) + vp.cols) % vp.cols];
    if (t >= bcc && t < bnn) { c = cc; Bc = bcc; Bn = bnn; break; }
  }
  const dV = Math.min(t - Bc, Bn - t) * colW;
  const horiz = dH <= dV;
  out.d = horiz ? dH : dV;
  out.dH = dH; out.dV = dV;
  out.horiz = horiz;
  out.s = horiz ? x : yy;                                  // coordinate ALONG the seam
  out.id = _hash01(((c % vp.cols) + vp.cols) % vp.cols, k, 204);
  out.dxc = (t - (Bc + Bn) / 2) * colW;                    // offset to the panel centre
  out.dyc = yy - (bnd[k] + bnd[k + 1]) / 2;
}

/**
 * Build the metre-scaled height field + feature masks for one variant (row-major,
 * size×size). Returns { h, tape, stitch, patch, btn, id } Float32Arrays.
 */
function _buildFields(size, vp) {
  const N = size * size;
  const h = new Float32Array(N), tape = new Float32Array(N), stitch = new Float32Array(N);
  const patch = new Float32Array(N), btn = new Float32Array(N), id = new Float32Array(N);
  const lay = _buildLayout(vp);
  const loc = { d: 0, dH: 0, dV: 0, horiz: true, s: 0, id: 0, dxc: 0, dyc: 0 };
  const per = (len, span) => Math.max(1, Math.round(span / len));
  const oct = vp.octaves.map(([lam, a], i) => ({ pu: per(lam, vp.W), pv: per(lam, vp.H), a, salt: 10 + i }));
  const cre = vp.creases.map(([lam, a], i) => ({ pu: per(lam, vp.W), pv: per(lam, vp.H), a, salt: 40 + i }));
  const wpu = per(0.25, vp.W), wpv = per(0.25, vp.H);
  const lpu = per(0.9, vp.W), lpv = per(0.9, vp.H);
  const tw = vp.tapeHalf, aa = Math.max(0.0012, vp.W / size * 0.8);
  const stRow = tw * 0.62, stHalf = Math.max(0.0007, vp.W / size * 0.7);
  const btn_ = vp.button;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = px / size, v = py / size;
      const x = u * vp.W, y = v * vp.H;
      _locate(x, y, vp, lay, loc);
      const d = loc.d;

      // Domain warp (periodic noise ⇒ still tileable) + low-frequency "how
      // crumpled is this area" modulation.
      const wu = u + (_vn(u, v, wpu, wpv, 31) - 0.5) * 2 * vp.warp / vp.W;
      const wv = v + (_vn(u, v, wpu, wpv, 32) - 0.5) * 2 * vp.warp / vp.H;
      const busy = 0.55 + 0.9 * _vn(u, v, lpu, lpv, 33);

      let crinkle = 0;
      for (const o of oct) crinkle += o.a * (2 * _vn(wu, wv, o.pu, o.pv, o.salt) - 1);
      for (const o of cre) {
        const q = 2 * _vn(wu, wv, o.pu, o.pv, o.salt) - 1;
        crinkle += o.a * (0.5 - Math.sqrt(q * q + 0.04));   // soft ridged crease
      }
      // Blanket is pinned (taut) at the tape, free in the panel middle.
      // (separable product, NOT min(): a min() of the two edge distances puts a
      // diagonal crease in every panel — the "pyramid facet" read.)
      crinkle *= (0.2 + 0.8 * _smooth(tw, tw + 0.08, loc.dH) * _smooth(tw, tw + 0.08, loc.dV)) * busy;

      const tmask = 1 - _smooth(tw - aa, tw + aa, d);
      let hh = crinkle;
      hh += vp.pillowAmp * (0.5 + 0.5 * loc.id) *
        _smooth(tw, tw + vp.pillowRamp, loc.dH) * _smooth(tw, tw + vp.pillowRamp, loc.dV);
      hh += vp.tapeLift * tmask;

      // Stitches: two dashed rows inside the tape.
      const ph = ((loc.s % vp.stitchPitch) + vp.stitchPitch) % vp.stitchPitch / vp.stitchPitch;
      const st = (Math.abs(d - stRow) < stHalf && ph < 0.6) ? tmask : 0;
      hh -= 0.0004 * st;

      // Tie-down button: dome on a tape patch, at the panel centre.
      let pmask = 0, bmask = 0;
      if (btn_) {
        const ax = Math.abs(loc.dxc), ay = Math.abs(loc.dyc);
        pmask = (1 - _smooth(btn_.patch - aa, btn_.patch + aa, ax)) *
                (1 - _smooth(btn_.patch - aa, btn_.patch + aa, ay));
        const q = Math.hypot(loc.dxc, loc.dyc) / btn_.r;
        bmask = 1 - _smooth(0.92, 1.0, q);
        if (pmask > 0) hh += 0.0010 * pmask;
        if (q < 1) hh += btn_.lift * Math.pow(1 - q * q, 0.7);
        hh -= crinkle * 0.85 * Math.max(pmask, bmask);        // patch/button are flat-ish
      }

      const i = py * size + px;
      h[i] = hh; tape[i] = tmask; stitch[i] = st; patch[i] = pmask; btn[i] = bmask; id[i] = loc.id;
    }
  }
  return { h, tape, stitch, patch, btn, id };
}

/**
 * Normals from the height gradient (wrapped central differences) — `h` is in
 * METRES and the pixel pitch in metres, so the result is resolution-independent.
 * ny is NOT negated here (the byte write negates it).
 */
function _normalsFromHeight(h, size, vp) {
  const n = new Float32Array(size * size * 3);
  const dxm = vp.W / size, dym = vp.H / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const ym = (y - 1 + size) % size, yp = (y + 1) % size;
      const gx = (h[y * size + xp] - h[y * size + xm]) / (2 * dxm) * vp.gain;
      const gy = (h[yp * size + x] - h[ym * size + x]) / (2 * dym) * vp.gain;
      const inv = 1 / Math.hypot(gx, gy, 1);
      const i = (y * size + x) * 3;
      n[i] = -gx * inv; n[i + 1] = -gy * inv; n[i + 2] = inv;
    }
  }
  return n;
}

/**
 * Build the MLI maps as raw RGBA buffers for one variant — PURE JS, NO DOM. The
 * bake script encodes them; the unit test pins their statistics at a small size.
 *
 * @param {number} [size]  default = FOIL_BAKE_SIZE[variant]
 * @param {'crumpled'|'flat'} [variant='crumpled']
 * @returns {{ size:number, variant:string, normal:Uint8ClampedArray,
 *             rm:Uint8ClampedArray, albedo:Uint8ClampedArray }}
 *   rm: G = relative roughness, B = relative metalness (R = G for any grey reader).
 */
export function buildFoilPixels(size, variant = 'crumpled') {
  const vp = FOIL_VARIANTS[variant];
  if (!vp) throw new Error(`buildFoilPixels: unknown variant '${variant}'`);
  if (!size) size = FOIL_BAKE_SIZE[variant];

  const F = _buildFields(size, vp);
  const nrm = _normalsFromHeight(F.h, size, vp);

  const N = size * size;
  const normal = new Uint8ClampedArray(N * 4);
  const rm = new Uint8ClampedArray(N * 4);
  const albedo = new Uint8ClampedArray(N * 4);
  const R = vp.rough;

  for (let p = 0; p < N; p++) {
    const idx = p * 4;
    const nx = nrm[p * 3], ny = nrm[p * 3 + 1], nz = nrm[p * 3 + 2];
    normal[idx] = Math.round((nx * 0.5 + 0.5) * 255);
    normal[idx + 1] = Math.round((-ny * 0.5 + 0.5) * 255);   // NEGATE ny (canvas-y-down vs UV-v-up)
    normal[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    normal[idx + 3] = 255;

    // Crease mask: local slope / slopeRef.
    const c = Math.min(1, Math.hypot(nx, ny) / Math.max(1e-6, nz) / vp.slopeRef);
    const tp = Math.max(F.tape[p], F.patch[p]);             // tape-like coverage
    const bt = F.btn[p];
    const th = F.stitch[p];

    // ── roughness (G) / metalness (B)
    let rg = R.base + F.id[p] * R.span + c * R.crease;
    rg = Math.max(R.lo, Math.min(R.hi, rg));
    rg = rg + (TAPE_ROUGH - rg) * tp;
    rg = rg + (BUTTON_ROUGH - rg) * bt;
    rg = rg + (TAPE_ROUGH - rg) * th;
    let mt = 1 + (TAPE_METAL - 1) * tp;
    mt = mt + (BUTTON_METAL - mt) * bt;
    const gv = Math.round(rg * 255), bv = Math.round(mt * 255);
    rm[idx] = gv; rm[idx + 1] = gv; rm[idx + 2] = bv; rm[idx + 3] = 255;

    // ── albedo
    const tone = 0.95 + (F.id[p] - 0.5) * vp.toneSpan;
    const fl = Math.min(1, tone * (1 - c * vp.creaseDarken));
    let r = fl, g = fl, b = fl;
    r += (TAPE_ALBEDO[0] - r) * tp; g += (TAPE_ALBEDO[1] - g) * tp; b += (TAPE_ALBEDO[2] - b) * tp;
    r += (THREAD_ALBEDO - r) * th; g += (THREAD_ALBEDO - g) * th; b += (THREAD_ALBEDO - b) * th;
    // Bake the foil tint (the material colour is white now), then lay the white button on top.
    r = _linToSrgb(_srgbToLin(r) * FOIL_TINT_LIN[0]);
    g = _linToSrgb(_srgbToLin(g) * FOIL_TINT_LIN[1]);
    b = _linToSrgb(_srgbToLin(b) * FOIL_TINT_LIN[2]);
    r += (BUTTON_ALBEDO[0] - r) * bt; g += (BUTTON_ALBEDO[1] - g) * bt; b += (BUTTON_ALBEDO[2] - b) * bt;
    albedo[idx] = Math.round(r * 255); albedo[idx + 1] = Math.round(g * 255);
    albedo[idx + 2] = Math.round(b * 255); albedo[idx + 3] = 255;
  }
  return { size, variant, normal, rm, albedo };
}

/** Baked map files, relative paths (Earth.js / textures/ convention). v7 = NEW names (cache-first sw). */
export const FOIL_FILES = Object.freeze({
  normal: 'textures/mli_foil_v7_normal.png',
  rm: 'textures/mli_foil_v7_rough_metal.png',
  albedo: 'textures/mli_foil_v7_albedo.png',
  flatNormal: 'textures/mli_foil_v7_flat_normal.png',
  flatRm: 'textures/mli_foil_v7_flat_rough_metal.png',
  flatAlbedo: 'textures/mli_foil_v7_flat_albedo.png',
});

/** Which variant (⇒ bake size) each map key belongs to. */
const FOIL_KEY_VARIANT = {
  normal: 'crumpled', rm: 'crumpled', albedo: 'crumpled',
  flatNormal: 'flat', flatRm: 'flat', flatAlbedo: 'flat',
};

/**
 * Neutral solid fill per map for the placeholder (the look before the PNG
 * decodes): normal flat-up, rm = mid roughness / full metal, albedo = the foil tint (the tint is baked into the albedo map).
 */
const FOIL_NEUTRAL = {
  normal: 'rgb(128,128,255)',
  rm: 'rgb(178,178,255)',
  albedo: 'rgb(214,172,94)',
  flatNormal: 'rgb(128,128,255)',
  flatRm: 'rgb(176,176,255)',
  flatAlbedo: 'rgb(214,172,94)',
};

/**
 * Per-map master texture records: `{ texture, loaded, clones[] }`. The texture
 * starts on a same-size neutral placeholder and swaps in the decoded PNG. Clones
 * issued before load are tracked so they can be version-bumped on swap.
 */
const _masters = new Map();

/** Build a solid-neutral placeholder canvas of the key's bake size (immutable-storage trap). */
function _makePlaceholderCanvas(fill, px) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  // Some test harnesses stub `document.createElement` with a bare object (no
  // canvas API); treat that as headless — return null so the caller degrades.
  if (typeof c.getContext !== 'function') return null;
  const ctx = c.getContext('2d');
  if (!ctx || typeof ctx.fillRect !== 'function') return null;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, px, px);
  return c;
}

/**
 * Get (or lazily create) the master texture for a map key. The master owns the
 * shared `Source`; `getMLIFoilMaps` returns `.clone()`s of it. The PNG loads once
 * per key and swaps into the shared Source via a same-size texSubImage2D.
 */
function _getMaster(key, colorSpace) {
  let rec = _masters.get(key);
  if (rec) return rec;

  const placeholder = _makePlaceholderCanvas(FOIL_NEUTRAL[key], FOIL_BAKE_SIZE[FOIL_KEY_VARIANT[key]]);
  if (!placeholder) return null;

  // Plain Texture (not CanvasTexture): this texture later carries an <img>.
  const texture = new THREE.Texture(placeholder);
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  rec = { texture, loaded: false, clones: [] };
  _masters.set(key, rec);

  new THREE.ImageLoader().load(
    FOIL_FILES[key],
    (image) => {
      // Same-size texSubImage2D re-upload into the pre-allocated storage.
      rec.texture.image = image;
      rec.texture.needsUpdate = true;
      // Each clone gates on its OWN version; bump the ones issued pre-load.
      for (const c of rec.clones) c.needsUpdate = true;
      rec.clones.length = 0;
      rec.loaded = true;
    },
    undefined,
    () => {
      // Offline first visit: keep the neutral placeholder, warn once, no crash.
      console.warn(`[mliFoilTexture] failed to load ${FOIL_FILES[key]}; using neutral placeholder`);
    }
  );
  return rec;
}

/**
 * Get the MLI blanket maps (albedo + normal + rough/metal), backed by the baked
 * PNGs in `textures/`.
 *  - default → `crumpled` (barrel skin).
 *  - `variant: 'flat'` → instrument-box single-panel variant.
 *
 * Returns freshly-cloned Texture objects on every call (sharing the cached master
 * Source) so each material part can set its own `repeat`. `roughnessMap` and
 * `metalnessMap` are the SAME texture object (G / B channels of one PNG). Returns
 * `null` in headless/no-DOM environments.
 *
 * @param {object} [opts]
 * @param {number|[number,number]} [opts.repeat=1]   UV repeat (scalar or [u,v])
 * @param {'flat'|string} [opts.variant]             'flat' → box variant
 * @returns {{ normalMap, roughnessMap, metalnessMap, albedoMap }|null}
 */
export function getMLIFoilMaps(opts = {}) {
  if (typeof document === 'undefined') return null;

  const ru = Array.isArray(opts.repeat) ? opts.repeat[0] : (opts.repeat ?? 1);
  const rv = Array.isArray(opts.repeat) ? opts.repeat[1] : (opts.repeat ?? 1);
  const flat = opts.variant === 'flat';

  const clone = (rec) => {
    if (!rec) return null;
    const t = rec.texture.clone();      // shares Source; copy() forces version 1
    t.repeat.set(ru, rv);
    // Only pre-load clones need the registry: post-load the Source is already
    // uploaded and copy()'s version bump uploads them on first bind.
    if (!rec.loaded) rec.clones.push(t);
    return t;
  };

  const normalMap = clone(_getMaster(flat ? 'flatNormal' : 'normal', THREE.NoColorSpace));
  const roughnessMap = clone(_getMaster(flat ? 'flatRm' : 'rm', THREE.NoColorSpace));
  const albedoMap = clone(_getMaster(flat ? 'flatAlbedo' : 'albedo', THREE.SRGBColorSpace));

  if (!normalMap || !roughnessMap || !albedoMap) return null;
  return { normalMap, roughnessMap, metalnessMap: roughnessMap, albedoMap };
}

/** Test/teardown hook — dispose the master textures and drop the cache. */
export function _resetMLIFoilTextureCache() {
  for (const rec of _masters.values()) {
    if (rec.texture) rec.texture.dispose();
  }
  _masters.clear();
}
