/**
 * mliFoilTexture.js — Procedural crumpled gold MLI (Multi-Layer Insulation)
 * foil maps, v2.2 (crumpled mirror foil).
 *
 * Generates tileable normal + roughness + albedo maps that read as real amber
 * Kapton (polyimide) over aluminized mylar — a thin, highly-reflective
 * metallized film that is CRINKLED/EMBOSSED (Wikipedia MLI; NOAA "As Good as
 * Gold"; MRO / Huygens / Cassini flight photos). The signature look is a
 * network of SHARP fold creases enclosing FLAT MIRROR FACETS at many different
 * tilts: because each facet is a little mirror facing a different way, the
 * environment reflects off it at a different angle → broken, high-contrast gold
 * glints (some facets blazing, some dark). The variation is specular, not
 * albedo, so this must be paired with a metallic, low-roughness material
 * (PlayerSatellite `_matGoldMLI`: metalness 1.0, roughness 0.42) under the
 * scenes' PMREM IBL — the reflection is half the effect.
 *
 * History: v1 (fBm value noise) → hammered/blobby metal. v2 (dense isotropic
 * cellular facets, deep V grooves) → "gold nuggets" (cobblestone + grout). v2.1
 * (anisotropic near-coplanar "draped sheets", then raised ridges) → too soft /
 * quilted, still rejected. v2.2 rebuilds around the research target: flat
 * Voronoi facets at STRONG random tilts (mag 0.6–1.0) + sharp narrow creases +
 * only a 1-px blur, with a metallic mirror material so the IBL supplies the
 * facet glints. Roughness stays relative 0.30–1.00; albedo stays near-uniform
 * amber (variation is specular). `_buildFields` returns BOTH the height field
 * and a per-pixel owner id from the SAME coarse pass so roughness/albedo
 * per-facet jitter lines up with the height facets.
 *
 * Follows the solarCellTexture.js convention: one-shot cached generation and
 * **returns null in headless/no-DOM environments** (tests instantiate
 * PlayerSatellite in node with no document). Because material `.clone()` shares
 * texture references, per-part wrinkle scale requires cloned texture objects
 * (they share the backing canvas but carry an independent `repeat`), so
 * getMLIFoilMaps() returns freshly-cloned textures on every call.
 *
 * @module scene/mliFoilTexture
 */

import * as THREE from 'three';

/** Cached master canvases keyed by resolution (backing pixels are shared). */
const _canvasCache = new Map();

/**
 * Deterministic 2-D hash → 0..1. Used for feature-point jitter, per-cell base
 * height, tilt vectors and tone jitter. All callers must feed wrapped lattice
 * coordinates so the field tiles.
 */
function _hash01(x, y, salt) {
  const s = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Seamless multi-octave value noise on the unit square, wrapping on both axes
 * (`period` divides evenly so the lattice tiles). Low-amplitude wobble only.
 */
function _valueNoise(u, v, period) {
  const hash = (xi, yi) => {
    const x = ((xi % period) + period) % period;
    const y = ((yi % period) + period) % period;
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  const x = u * period, y = v * period;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = smoother(x - x0), fy = smoother(y - y0);
  const n00 = hash(x0, y0), n10 = hash(x0 + 1, y0);
  const n01 = hash(x0, y0 + 1), n11 = hash(x0 + 1, y0 + 1);
  return lerp(lerp(n00, n10, fx), lerp(n01, n11, fx), fy);
}

/**
 * Precompute a wrapped jittered lattice's per-cell attributes. Lattices are
 * tiny (≤ ~28 cells/axis) so a full table is cheap and lets the per-pixel scan
 * avoid recomputing trig/hashes. Indexed `[ly * cells + lx]`.
 *
 * Each cell carries: jitter (jx,jy) placing the feature point inside the cell,
 * a base height (constant within a facet → the height STEP at facet borders is
 * the sharp fold crease), a tilt vector `(tvx,tvy)` as a RANDOM DIRECTION (full
 * 2π) × strong magnitude (0.6–1.0), and an id (0..1). The strong, fully-random
 * tilt is what makes each facet a flat plane facing a distinctly different way,
 * so the PMREM environment reflects off each facet at a different angle → the
 * broken, high-contrast gold glints of real crumpled aluminized-Kapton foil (as
 * opposed to gentle draped swells, which read flat/quilted).
 *
 * @param {number} cells   lattice count per axis
 * @param {number} salt    separates lattices so they don't correlate
 * @returns {{cells:number, jx,jy,base,tvx,tvy,id:Float32Array}}
 */
function _buildCellTable(cells, salt) {
  const n = cells * cells;
  const jx = new Float32Array(n), jy = new Float32Array(n);
  const base = new Float32Array(n);
  const tvx = new Float32Array(n), tvy = new Float32Array(n);
  const id = new Float32Array(n);
  for (let ly = 0; ly < cells; ly++) {
    for (let lx = 0; lx < cells; lx++) {
      const i = ly * cells + lx;
      jx[i] = _hash01(lx, ly, salt + 1.0);
      jy[i] = _hash01(lx, ly, salt + 2.0);
      base[i] = _hash01(lx, ly, salt + 3.0);        // border step → sharp crease
      // Random facet-plane orientation: direction (full 2π) × strong magnitude.
      const ang = _hash01(lx, ly, salt + 4.0) * Math.PI * 2;
      const mag = 0.6 + _hash01(lx, ly, salt + 5.0) * 0.4; // 0.6–1.0 STRONG tilt
      tvx[i] = Math.cos(ang) * mag;
      tvy[i] = Math.sin(ang) * mag;
      id[i] = _hash01(lx, ly, salt + 6.0);
    }
  }
  return { cells, jx, jy, base, tvx, tvy, id };
}

/**
 * Wrapped isotropic Voronoi sample using a precomputed cell table.
 *
 * Compact cells (plain hypot distance), so a 3×3 neighbor scan (`rad=1`) is
 * sufficient. The owning cell (F1 winner) is a FLAT tilted plane:
 * `base·baseAmp + dot(p−feature, tiltVec)·tiltAmp`. `base·baseAmp` is constant
 * within the facet (→ the height step at the border is the crease); the dot term
 * is the facet's uniform gradient (→ one flat mirror normal for the whole
 * facet). Straight Voronoi cell edges meeting at vertices ARE the polygonal
 * facet network of crumpled foil; the strong random per-facet tilt makes each
 * facet a mirror facing a different way. F2−F1 (small at borders) drives the
 * sharp crease term in `_buildFields`.
 *
 * @returns {{f1:number, f2:number, tilt:number, id:number}}
 */
function _voronoi(u, v, tbl, rad, baseAmp, tiltAmp) {
  const cells = tbl.cells;
  const gx = u * cells, gy = v * cells;
  const cx = Math.floor(gx), cy = Math.floor(gy);
  let f1 = Infinity, f2 = Infinity;
  let tilt = 0, oid = 0;
  for (let oy = -rad; oy <= rad; oy++) {
    for (let ox = -rad; ox <= rad; ox++) {
      const wx = cx + ox, wy = cy + oy;               // (may be out of [0,cells))
      const lx = ((wx % cells) + cells) % cells;      // wrapped lattice id
      const ly = ((wy % cells) + cells) % cells;
      const i = ly * cells + lx;
      // Feature point jittered inside the cell (unwrapped coords so distance is
      // continuous across the seam).
      const fx = wx + tbl.jx[i];
      const fy = wy + tbl.jy[i];
      const dx = gx - fx, dy = gy - fy;
      const d = Math.hypot(dx, dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        oid = tbl.id[i];
        // Flat tilted facet plane (one uniform mirror normal per facet).
        tilt = tbl.base[i] * baseAmp + (dx * tbl.tvx[i] + dy * tbl.tvy[i]) * tiltAmp;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return { f1, f2, tilt, id: oid };
}

/**
 * Build the crumpled-foil height field AND per-pixel coarse-facet owner id in
 * ONE coarse pass (roughness/albedo per-facet jitter then lines up with the
 * height facets — no separate re-scan).
 *
 * Real satellite MLI is crinkled, highly-reflective aluminized-Kapton film: a
 * network of sharp fold creases enclosing flat mirror facets at many different
 * tilts. So the field is dominated by FLAT strongly-tilted Voronoi facets
 * (coarse + finer sub-facets) with a SHARP narrow crease valley at every border
 * (dark fold line), plus a trace of fBm so facet interiors aren't dead-flat.
 * Only a 1-px box blur (bevels the 1-px alias at borders while keeping facets
 * flat and creases crisp), then normalize to 0..1.
 *
 * Composition:
 *   h = facetC·0.62 + facetF·0.28 + fBm(6/12/24)·0.06 − crease·0.30
 * crease = (1 − min(1,(F2−F1)·4.5))³ blended coarse·0.6 + fine·0.4.
 *
 * @param {number} size
 * @returns {{ h:Float32Array, id:Float32Array }} row-major (size*size)
 */
function _buildFields(size) {
  const coarse = 10;   // coarse facets per tile
  const fine = 26;     // finer sub-facets per tile
  const coarseTbl = _buildCellTable(coarse, 10.0);
  const fineTbl = _buildCellTable(fine, 40.0);
  const raw = new Float32Array(size * size);
  const id = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;

      // Flat mirror facets: coarse dominant, finer sub-facets add crumple detail.
      const vc = _voronoi(u, v, coarseTbl, 1, 0.55, 0.80);
      const vf = _voronoi(u, v, fineTbl, 1, 0.35, 0.55);
      const facet = vc.tilt * 0.62 + vf.tilt * 0.28;

      // Trace of fBm so facet interiors carry faint secondary wrinkle (real foil
      // facets aren't perfectly flat) — kept tiny so facets stay mirror-like.
      const fbm =
        0.6 * _valueNoise(u, v, 6) +
        0.3 * _valueNoise(u, v, 12) +
        0.1 * _valueNoise(u, v, 24);

      // Sharp narrow crease valleys along facet borders (F2−F1 small → fold line).
      // Both scales contribute; the ·4.5 keeps the groove narrow (sharp fold).
      const edgeC = 1 - Math.min(1, (vc.f2 - vc.f1) * 4.5);
      const edgeF = 1 - Math.min(1, (vf.f2 - vf.f1) * 4.5);
      const crease = (edgeC ** 3) * 0.6 + (edgeF ** 3) * 0.4; // 1 at border →0 inside

      raw[y * size + x] = facet + fbm * 0.06 - crease * 0.30; // sunken fold lines
      id[y * size + x] = vc.id;
    }
  }

  // Box blur radius 1: bevels the 1-px gradient alias at facet borders into a
  // clean crease while keeping the facets themselves flat (mirror) and sharp.
  const blurred = _boxBlurWrap(raw, size, 1);

  // Normalize height to 0..1.
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < blurred.length; i++) {
    const n = blurred[i];
    if (n < min) min = n;
    if (n > max) max = n;
  }
  const span = max - min || 1;
  for (let i = 0; i < blurred.length; i++) blurred[i] = (blurred[i] - min) / span;
  return { h: blurred, id };
}

/** Wrapped box blur, `radius` px each side (separable). */
function _boxBlurWrap(src, size, radius) {
  const wrap = (i) => ((i % size) + size) % size;
  const tmp = new Float32Array(size * size);
  const out = new Float32Array(size * size);
  const n = radius * 2 + 1;
  // Horizontal pass.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += src[y * size + wrap(x + k)];
      tmp[y * size + x] = s / n;
    }
  }
  // Vertical pass.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += tmp[wrap(y + k) * size + x];
      out[y * size + x] = s / n;
    }
  }
  return out;
}

/**
 * Build the shared master canvases (normal + roughness + albedo) at `size`.
 * @param {number} size
 * @returns {{ normalCanvas, roughCanvas, albedoCanvas }|null}
 */
function _buildCanvases(size) {
  if (typeof document === 'undefined') return null;
  const normalCanvas = document.createElement('canvas');
  const roughCanvas = document.createElement('canvas');
  const albedoCanvas = document.createElement('canvas');
  normalCanvas.width = normalCanvas.height = size;
  roughCanvas.width = roughCanvas.height = size;
  albedoCanvas.width = albedoCanvas.height = size;
  if (typeof normalCanvas.getContext !== 'function') return null;
  const nctx = normalCanvas.getContext('2d');
  const rctx = roughCanvas.getContext('2d');
  const actx = albedoCanvas.getContext('2d');
  if (!nctx || !rctx || !actx) return null;

  const { h, id: idField } = _buildFields(size);
  const nImg = nctx.createImageData(size, size);
  const rImg = rctx.createImageData(size, size);
  const aImg = actx.createImageData(size, size);

  const at = (x, y) => {
    const xi = ((x % size) + size) % size;
    const yi = ((y % size) + size) % size;
    return h[yi * size + xi];
  };

  // Normal-map bump strength. v2.2 facets tilt strongly (mag 0.6–1.0), so the
  // Sobel gradients are larger than the v2.1 draped field — 2.0 keeps facet
  // normals distinct without over-saturating (drop toward 1.4 if the whole tile
  // reads sideways / loses the flat-facet interiors).
  const strength = 2.0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sobel gradient (wrapped) → tangent-space normal.
      const dx =
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy =
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength;
      let ny = -dy * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;

      const idx = (y * size + x) * 4;
      nImg.data[idx + 0] = Math.round((nx * 0.5 + 0.5) * 255);
      nImg.data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      nImg.data[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      nImg.data[idx + 3] = 255;

      const height = h[y * size + x];
      // Per-pixel coarse-facet owner id from the SAME coarse pass as height.
      const facetId = idField[y * size + x];

      // ── Roughness map v2.2 (crumpled mirror foil) ────────────────────
      // Encoded RELATIVE to material.roughness (which multiplies this map).
      // Effective stack: material.roughness ≈ 0.42 × map(0.30–1.00) → ~0.13–0.27
      // → reflective facets that pick up the PMREM IBL as broken glints. Whole
      // facets glint together via per-facet hashed base; crease valleys read a
      // touch rougher; ~2.5% sparkle pixels dip to the floor.
      const sheetGloss = 0.40 + facetId * 0.25;         // 0.40–0.65 per facet
      const creaseRough = (1 - height) * 0.12;          // gentle valley bump
      let rough = sheetGloss + creaseRough;
      // High-frequency sparkle speckle: ~1.5% of pixels dip to a gentle gloss
      // floor (rarer + softer than the initial 2.5%/0.30 so the sparkle reads as
      // subtle pinpricks rather than a harsh grain under bloom).
      const spk = _hash01(x * 1.37, y * 2.11, 99.0);
      if (spk > 0.985) rough = 0.36;                    // gentle sparkle floor
      rough = Math.max(0.3, Math.min(1.0, rough));      // clamp to 0.3–1.0
      const rv = Math.round(rough * 255);
      rImg.data[idx + 0] = rv;
      rImg.data[idx + 1] = rv;
      rImg.data[idx + 2] = rv;
      rImg.data[idx + 3] = 255;

      // ── Amber albedo mottle map v2.2 (near-uniform) ──────────────────
      // Near-white base (multiplies under base color 0xd6a43e). Almost
      // uniform — crumpled foil's variation is SPECULAR (facet glints), not
      // albedo. Faint per-facet tone jitter (±3.5%); creases darken only
      // slightly toward amber (luma floor ≈0.78 — NO dark grout) with a mild
      // red-shift.
      const tone = 0.95 + (facetId - 0.5) * 0.07;       // ±3.5% per-facet
      const t = Math.min(1, Math.max(0, height));       // 0 valley, 1 ridge
      const amberMix = (1 - t);                          // 1 at deepest valley
      const luma = tone * (1 - amberMix * 0.18);         // floor ≈ 0.78·tone
      // Red-shift creases slightly: boost R, drop B as amberMix rises.
      const r = luma * (1 + amberMix * 0.05);
      const g = luma;
      const b = luma * (1 - amberMix * 0.12);
      aImg.data[idx + 0] = Math.round(Math.min(1, r) * 255);
      aImg.data[idx + 1] = Math.round(Math.min(1, g) * 255);
      aImg.data[idx + 2] = Math.round(Math.min(1, b) * 255);
      aImg.data[idx + 3] = 255;
    }
  }
  nctx.putImageData(nImg, 0, 0);
  rctx.putImageData(rImg, 0, 0);
  actx.putImageData(aImg, 0, 0);
  return { normalCanvas, roughCanvas, albedoCanvas };
}

/**
 * Get crinkled-MLI normal + roughness + albedo maps.
 *
 * Returns freshly-cloned CanvasTexture objects on every call (sharing the
 * cached backing canvas) so each material part can set its own `repeat` without
 * disturbing others. Returns `null` in headless/no-DOM environments.
 *
 * @param {object} [opts]
 * @param {number} [opts.size=512]              canvas pixel dimension (power of two)
 * @param {number|[number,number]} [opts.repeat=1]  UV repeat (scalar or [u,v])
 * @returns {{ normalMap, roughnessMap, albedoMap }|null}
 */
export function getMLIFoilMaps(opts = {}) {
  const size = opts.size || 512;
  if (typeof document === 'undefined') return null;

  let master = _canvasCache.get(size);
  if (!master) {
    master = _buildCanvases(size);
    if (!master) return null;
    _canvasCache.set(size, master);
  }

  const ru = Array.isArray(opts.repeat) ? opts.repeat[0] : (opts.repeat ?? 1);
  const rv = Array.isArray(opts.repeat) ? opts.repeat[1] : (opts.repeat ?? 1);

  const mk = (canvas, colorSpace) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = colorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(ru, rv);
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  };

  return {
    // Normal map is vector data, not color — must be NoColorSpace (v1's
    // LinearSRGBColorSpace was a bug). Roughness stays linear. Albedo is color.
    normalMap: mk(master.normalCanvas, THREE.NoColorSpace),
    roughnessMap: mk(master.roughCanvas, THREE.NoColorSpace),
    albedoMap: mk(master.albedoCanvas, THREE.SRGBColorSpace),
  };
}

/** Test/teardown hook — drop the cached master canvases. */
export function _resetMLIFoilTextureCache() {
  _canvasCache.clear();
}
