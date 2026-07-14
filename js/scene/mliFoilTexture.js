/**
 * mliFoilTexture.js — Procedural crumpled gold MLI (Multi-Layer Insulation)
 * foil maps, v3 (crumpled-mylar facet mosaic).
 *
 * Generates tileable normal + roughness + albedo maps that read as real
 * lemon-gold aluminized-Kapton foil — a thin, highly-reflective metallized film
 * that is CRUMPLED into a mosaic of large flat mirror facets separated by
 * razor-sharp fold creases (MOM/Chandrayaan-2/MRO flight & cleanroom photos).
 * The signature look: adjacent facets jump tens of degrees, so the environment
 * reflects off each one at a wildly different angle → a high-contrast patchwork
 * of near-white specular tiles right next to deep shadow tiles. The variation is
 * SPECULAR (facet normal + IBL), not albedo, so this must be paired with a
 * metallic, low-roughness material (PlayerSatellite `_matGoldMLI`: metalness 1.0,
 * roughness ≈0.45) under the scenes' PMREM IBL — the reflection is the effect.
 *
 * History: v1 (fBm value noise) → hammered/blobby metal. v2 (dense isotropic
 * cellular facets, deep V grooves) → "gold nuggets" (cobblestone + grout). v2.1
 * (anisotropic near-coplanar "draped sheets") → too soft / quilted. v2.2 (flat
 * Voronoi facets, tilt encoded in HEIGHT then recovered via Sobel) → "gold
 * pebbles / rounded stones": the Sobel÷global-normalization crushed facet-
 * interior tilt to ~5–10° while only the crease WALLS hit ~75°, so every facet
 * reflected from nearly the same angle (uniform mid-gold) with a lit/shadowed
 * OUTLINE = pebble shading; the box blur rounded the crease rims.
 *
 * v3 INVERTS the encoding. There is no height field, no Sobel, no blur. Each
 * Voronoi facet carries a PRECOMPUTED strong tilt (α ≈ 8–40°, mean ~20°) and its
 * normal is written DIRECTLY per pixel, so facet interiors carry the tilt and
 * facet borders are 1-px normal discontinuities (hairline creases, no rims).
 * Facets are large (~14 cm on the 2.5×2.0 m barrel), irregular/elongated
 * (per-cell stretch 1–2×), and ~30% split by a sub-crease into two half-facets
 * at slightly different tilts — the high-contrast light/dark mirror mosaic of
 * real crumpled foil. A tiny fBm perturbation (±3–5°) keeps interiors from being
 * dead-flat without softening the borders. Roughness is per-facet (0.30–0.60)
 * with a hairline crease bump; sparkle removed (large facets glint on their own).
 * Albedo is near-neutral/near-white (hue lives in the material color) so the gold
 * reads lemon, not amber.
 *
 * SIGN TRAP: canvas rows run top-down while UV v runs bottom-up. v2.2 handled
 * this implicitly via the Sobel `−dy` term; v3 writes normals directly and so
 * NEGATES ny on write (G = (−ny)·0.5+0.5) or every facet lights upside-down.
 *
 * Follows the solarCellTexture.js convention: one-shot cached generation and
 * **returns null in headless/no-DOM environments** (tests instantiate
 * PlayerSatellite in node with no document). Because material `.clone()` shares
 * texture references, per-part scale requires cloned texture objects (they share
 * the backing canvas but carry an independent `repeat`), so getMLIFoilMaps()
 * returns freshly-cloned textures on every call. Two roughness canvases are
 * cached: the default and a `smallPart` variant (higher floor) for cm-scale
 * clones (aperture ring, IR box) that would otherwise clip to white under bloom.
 *
 * @module scene/mliFoilTexture
 */

import * as THREE from 'three';

/** Cached master canvases keyed by resolution (backing pixels are shared). */
const _canvasCache = new Map();

/**
 * Deterministic 2-D hash → 0..1. Used for feature-point jitter, per-cell tilt,
 * elongation, split flags and tone jitter. All callers must feed wrapped lattice
 * coordinates so the field tiles.
 */
function _hash01(x, y, salt) {
  const s = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Seamless multi-octave value noise on the unit square, wrapping on both axes
 * (`period` divides evenly so the lattice tiles). Low-amplitude wobble only —
 * used ONLY for the tiny per-pixel facet-interior normal perturbation (±3–5°).
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
 * Precompute a wrapped jittered lattice's per-cell attributes with INDEPENDENT
 * u/v cell counts (so facets can be square-ish on a non-square barrel UV).
 * Lattices are tiny (≤ ~22 cells/axis) so a full table is cheap and lets the
 * per-pixel scan avoid recomputing trig/hashes. Indexed `[ly * cellsU + lx]`.
 *
 * Each cell carries:
 *  - jitter (jx, jy) placing the feature point inside the cell;
 *  - a PRECOMPUTED facet normal (nx, ny, nz): tilt azimuth θ∈[0,2π), tilt angle
 *    α = 8° + 32°·hash^1.5 (power bias → mean ≈20°, occasional 40°). This strong,
 *    fully-random per-facet tilt makes each facet a flat mirror facing a
 *    distinctly different way → the broken high-contrast glint mosaic of real
 *    crumpled foil (v2.2's tilt-via-height collapsed this to ~5–10°);
 *  - elongation: stretch s∈[1,2] along direction φ (stored cos φ, sin φ, 1/s) so
 *    facets are irregular/elongated, not a cobblestone grid;
 *  - sub-crease split: ~30% of cells split into two half-facets across a random
 *    line; the far half carries a SECOND normal (θ±15–25°, α±5–12°) → intra-facet
 *    fold lines. `split` = 1/0, `sdx,sdy` = split-line direction (dot sign picks
 *    the half), `nx2,ny2,nz2` = far-half normal;
 *  - id (0..1) → per-facet roughness/albedo jitter.
 *
 * @param {number} cellsU   lattice count along u
 * @param {number} cellsV   lattice count along v
 * @param {number} salt     separates lattices so they don't correlate
 */
function _buildCellTable(cellsU, cellsV, salt) {
  const n = cellsU * cellsV;
  const jx = new Float32Array(n), jy = new Float32Array(n);
  const nx = new Float32Array(n), ny = new Float32Array(n), nz = new Float32Array(n);
  const cphi = new Float32Array(n), sphi = new Float32Array(n), invs = new Float32Array(n);
  const split = new Uint8Array(n);
  const sdx = new Float32Array(n), sdy = new Float32Array(n);
  const nx2 = new Float32Array(n), ny2 = new Float32Array(n), nz2 = new Float32Array(n);
  const id = new Float32Array(n);
  const DEG = Math.PI / 180;
  for (let ly = 0; ly < cellsV; ly++) {
    for (let lx = 0; lx < cellsU; lx++) {
      const i = ly * cellsU + lx;
      jx[i] = _hash01(lx, ly, salt + 1.0);
      jy[i] = _hash01(lx, ly, salt + 2.0);

      // Precomputed facet normal: azimuth + power-biased tilt angle.
      const theta = _hash01(lx, ly, salt + 3.0) * Math.PI * 2;
      const alpha = (8 + 32 * Math.pow(_hash01(lx, ly, salt + 4.0), 1.5)) * DEG;
      const sa = Math.sin(alpha), ca = Math.cos(alpha);
      nx[i] = sa * Math.cos(theta);
      ny[i] = sa * Math.sin(theta);
      nz[i] = ca;

      // Elongation: stretch 1–2 along random direction φ.
      const phi = _hash01(lx, ly, salt + 5.0) * Math.PI;   // 0..π (axis, sign-free)
      const s = 1 + _hash01(lx, ly, salt + 6.0);           // 1..2
      cphi[i] = Math.cos(phi);
      sphi[i] = Math.sin(phi);
      invs[i] = 1 / s;

      // Sub-crease split (~30%): second normal for the far half.
      const sp = _hash01(lx, ly, salt + 7.0) < 0.30;
      split[i] = sp ? 1 : 0;
      if (sp) {
        const psi = _hash01(lx, ly, salt + 8.0) * Math.PI * 2;
        sdx[i] = Math.cos(psi);
        sdy[i] = Math.sin(psi);
        // Perturb azimuth ±(15–25°) and tilt ±(5–12°) for the far half.
        const dth = (15 + 10 * _hash01(lx, ly, salt + 9.0)) * DEG *
          (_hash01(lx, ly, salt + 10.0) < 0.5 ? -1 : 1);
        const da = (5 + 7 * _hash01(lx, ly, salt + 11.0)) * DEG *
          (_hash01(lx, ly, salt + 12.0) < 0.5 ? -1 : 1);
        const th2 = theta + dth;
        let a2 = alpha + da;
        if (a2 < 4 * DEG) a2 = 4 * DEG;
        if (a2 > 46 * DEG) a2 = 46 * DEG;
        const sa2 = Math.sin(a2), ca2 = Math.cos(a2);
        nx2[i] = sa2 * Math.cos(th2);
        ny2[i] = sa2 * Math.sin(th2);
        nz2[i] = ca2;
      } else {
        nx2[i] = nx[i]; ny2[i] = ny[i]; nz2[i] = nz[i];
        sdx[i] = 1; sdy[i] = 0;
      }

      id[i] = _hash01(lx, ly, salt + 13.0);
    }
  }
  return {
    cellsU, cellsV, jx, jy, nx, ny, nz,
    cphi, sphi, invs, split, sdx, sdy, nx2, ny2, nz2, id,
  };
}

/**
 * Wrapped ANISOTROPIC Voronoi sample using a precomputed cell table. Distance to
 * each candidate is measured in that candidate's OWN frame: the offset (dx,dy) is
 * rotated by −φ and scaled by (1/s, 1) before hypot, so cells stretch by up to 2×
 * along φ → irregular/elongated facets (not a cobblestone grid). Stretch ≤2 keeps
 * a `rad=2` neighbour scan sufficient.
 *
 * Returns the winner index + the RAW (unrotated) offset to the winner's feature
 * point plus f1/f2 — the caller resolves the split side via
 * sign(dot((dx1,dy1), splitDir)) and reads normal A or B from the table, and uses
 * (f2−f1) for the hairline crease mask.
 *
 * @returns {{f1:number, f2:number, i1:number, dx1:number, dy1:number}}
 */
function _voronoi(u, v, tbl, rad) {
  const cu = tbl.cellsU, cv = tbl.cellsV;
  const gx = u * cu, gy = v * cv;
  const cx = Math.floor(gx), cy = Math.floor(gy);
  let f1 = Infinity, f2 = Infinity;
  let i1 = 0, dx1 = 0, dy1 = 0;
  for (let oy = -rad; oy <= rad; oy++) {
    for (let ox = -rad; ox <= rad; ox++) {
      const wx = cx + ox, wy = cy + oy;               // (may be out of range)
      const lx = ((wx % cu) + cu) % cu;               // wrapped lattice id
      const ly = ((wy % cv) + cv) % cv;
      const i = ly * cu + lx;
      // Feature point jittered inside the cell (unwrapped coords so distance is
      // continuous across the seam).
      const fx = wx + tbl.jx[i];
      const fy = wy + tbl.jy[i];
      const dx = gx - fx, dy = gy - fy;
      // Rotate into the cell frame (−φ) and scale by (1/s, 1), then hypot.
      const rc = tbl.cphi[i], rs = tbl.sphi[i];
      const px = dx * rc + dy * rs;                   // along φ
      const py = -dx * rs + dy * rc;                  // perp φ
      const d = Math.hypot(px * tbl.invs[i], py);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        i1 = i;
        dx1 = dx; dy1 = dy;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return { f1, f2, i1, dx1, dy1 };
}

/**
 * Build the v3 crumpled-mylar fields in ONE coarse Voronoi pass. Emits, per
 * pixel: the winner facet/half NORMAL (with a tiny fBm perturbation, NO blur, so
 * borders stay 1-px discontinuities), a hairline CREASE mask (roughness/albedo
 * only), a winner ID (split half XORed in) for per-facet jitter, and a coarse
 * TONE (0..1) for a whisper of albedo variation. No height field, no Sobel.
 *
 * @param {number} size
 * @param {number} cellsU
 * @param {number} cellsV
 * @returns {{ nx,ny,nz:Float32Array, crease:Float32Array, id:Float32Array,
 *             tone:Float32Array }} row-major (size*size)
 */
function _buildFields(size, cellsU, cellsV) {
  const tbl = _buildCellTable(cellsU, cellsV, 10.0);
  const N = size * size;
  const outNx = new Float32Array(N), outNy = new Float32Array(N), outNz = new Float32Array(N);
  const crease = new Float32Array(N);
  const idF = new Float32Array(N);
  const tone = new Float32Array(N);
  const DEG = Math.PI / 180;
  const PERT = Math.tan(4 * DEG);   // ±~4° interior perturbation magnitude

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const vo = _voronoi(u, v, tbl, 2);
      const i = vo.i1;

      // Resolve split side: which half of the facet owns this pixel.
      let nx, ny, nz, halfBit = 0;
      if (tbl.split[i] && (vo.dx1 * tbl.sdx[i] + vo.dy1 * tbl.sdy[i]) > 0) {
        nx = tbl.nx2[i]; ny = tbl.ny2[i]; nz = tbl.nz2[i]; halfBit = 1;
      } else {
        nx = tbl.nx[i]; ny = tbl.ny[i]; nz = tbl.nz[i];
      }

      // Tiny fBm interior perturbation (±~4°): two channels nudge nx/ny, then
      // renormalize. Kept small so facets stay mirror-flat but not dead-flat.
      const p1 = (_valueNoise(u, v, 24) - 0.5) * 2 * PERT;
      const p2 = (_valueNoise(u + 0.37, v + 0.19, 24) - 0.5) * 2 * PERT;
      let fx = nx + p1, fy = ny + p2, fz = nz;
      const len = Math.hypot(fx, fy, fz) || 1;
      const idx = y * size + x;
      outNx[idx] = fx / len;
      outNy[idx] = fy / len;
      outNz[idx] = fz / len;

      // Hairline crease: (1 − min(1,(f2−f1)·k))^3, k≈6 → ~1–2 px at 1024.
      const e = 1 - Math.min(1, (vo.f2 - vo.f1) * 6.0);
      crease[idx] = e * e * e;

      // Winner id with split half XORed in (so the two halves get distinct
      // roughness/albedo jitter), wrapped back into 0..1.
      let fid = tbl.id[i];
      if (halfBit) fid = fid > 0.5 ? fid - 0.5 : fid + 0.5;
      idF[idx] = fid;
      tone[idx] = tbl.id[i];
    }
  }
  return { nx: outNx, ny: outNy, nz: outNz, crease, id: idF, tone };
}

/**
 * Build the shared master canvases at `size`: normal + default roughness +
 * smallPart roughness + albedo. Direct per-pixel normal write (no Sobel/blur).
 * @param {number} size
 * @returns {{ normalCanvas, roughCanvas, roughSmallCanvas, albedoCanvas }|null}
 */
function _buildCanvases(size) {
  if (typeof document === 'undefined') return null;
  const normalCanvas = document.createElement('canvas');
  const roughCanvas = document.createElement('canvas');
  const roughSmallCanvas = document.createElement('canvas');
  const albedoCanvas = document.createElement('canvas');
  normalCanvas.width = normalCanvas.height = size;
  roughCanvas.width = roughCanvas.height = size;
  roughSmallCanvas.width = roughSmallCanvas.height = size;
  albedoCanvas.width = albedoCanvas.height = size;
  if (typeof normalCanvas.getContext !== 'function') return null;
  const nctx = normalCanvas.getContext('2d');
  const rctx = roughCanvas.getContext('2d');
  const rsctx = roughSmallCanvas.getContext('2d');
  const actx = albedoCanvas.getContext('2d');
  if (!nctx || !rctx || !rsctx || !actx) return null;

  // ~14 cm square-ish facets on the 2.51×2.0 m barrel at repeat [1,1]:
  // 18 along u (circumference), 14 along v (height).
  const cellsU = 18, cellsV = 14;
  const { nx, ny, nz, crease, id: idField, tone } = _buildFields(size, cellsU, cellsV);

  const nImg = nctx.createImageData(size, size);
  const rImg = rctx.createImageData(size, size);
  const rsImg = rsctx.createImageData(size, size);
  const aImg = actx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      const idx = p * 4;

      // ── Normal map v3 ─── direct write; NEGATE ny (canvas-y-down vs UV-v-up).
      nImg.data[idx + 0] = Math.round((nx[p] * 0.5 + 0.5) * 255);
      nImg.data[idx + 1] = Math.round((-ny[p] * 0.5 + 0.5) * 255);
      nImg.data[idx + 2] = Math.round((nz[p] * 0.5 + 0.5) * 255);
      nImg.data[idx + 3] = 255;

      const facetId = idField[p];
      const c = crease[p];

      // ── Roughness v3 ─── per-facet 0.30 + variantId·0.30 (0.30–0.60) +
      // crease·0.10. Sparkle REMOVED (large facets glint on their own). This map
      // MULTIPLIES material.roughness (≈0.45) → effective ~0.13–0.32.
      let rough = 0.30 + facetId * 0.30 + c * 0.10;
      rough = Math.max(0.30, Math.min(0.70, rough));
      const rv = Math.round(rough * 255);
      rImg.data[idx + 0] = rv; rImg.data[idx + 1] = rv; rImg.data[idx + 2] = rv; rImg.data[idx + 3] = 255;

      // smallPart roughness: same facets, higher floor (0.50) so cm-scale clones
      // (aperture ring, IR box) don't clip to white under bloom.
      let roughS = 0.50 + facetId * 0.20 + c * 0.08;
      roughS = Math.max(0.50, Math.min(0.80, roughS));
      const rsv = Math.round(roughS * 255);
      rsImg.data[idx + 0] = rsv; rsImg.data[idx + 1] = rsv; rsImg.data[idx + 2] = rsv; rsImg.data[idx + 3] = 255;

      // ── Albedo v3 ─── near-neutral/near-white; hue lives in the material
      // color so the gold reads LEMON, not amber. Faint per-facet tone jitter
      // (±3.5%); crease darkens only slightly (·0.05 max), NO red-shift, NO grout.
      const toneV = 0.95 + (tone[p] - 0.5) * 0.07;      // ±3.5% per facet
      const luma = toneV * (1 - c * 0.05);              // crease ≤5%
      const lv = Math.round(Math.min(1, luma) * 255);
      aImg.data[idx + 0] = lv; aImg.data[idx + 1] = lv; aImg.data[idx + 2] = lv; aImg.data[idx + 3] = 255;
    }
  }
  nctx.putImageData(nImg, 0, 0);
  rctx.putImageData(rImg, 0, 0);
  rsctx.putImageData(rsImg, 0, 0);
  actx.putImageData(aImg, 0, 0);
  return { normalCanvas, roughCanvas, roughSmallCanvas, albedoCanvas };
}

/**
 * Get crinkled-MLI normal + roughness + albedo maps (v3 crumpled mylar).
 *
 * Returns freshly-cloned CanvasTexture objects on every call (sharing the
 * cached backing canvas) so each material part can set its own `repeat` without
 * disturbing others. Returns `null` in headless/no-DOM environments.
 *
 * @param {object} [opts]
 * @param {number} [opts.size=1024]                 canvas pixel dimension (power of two)
 * @param {number|[number,number]} [opts.repeat=1]  UV repeat (scalar or [u,v])
 * @param {boolean} [opts.smallPart=false]          use the higher-floor roughness
 *                                                   canvas for cm-scale clones
 * @returns {{ normalMap, roughnessMap, albedoMap }|null}
 */
export function getMLIFoilMaps(opts = {}) {
  const size = opts.size || 1024;
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
    // Normal map is vector data, not color — must be NoColorSpace. Roughness
    // stays linear (NoColorSpace). Albedo is color (SRGB).
    normalMap: mk(master.normalCanvas, THREE.NoColorSpace),
    roughnessMap: mk(
      opts.smallPart ? master.roughSmallCanvas : master.roughCanvas,
      THREE.NoColorSpace
    ),
    albedoMap: mk(master.albedoCanvas, THREE.SRGBColorSpace),
  };
}

/** Test/teardown hook — drop the cached master canvases. */
export function _resetMLIFoilTextureCache() {
  _canvasCache.clear();
}
