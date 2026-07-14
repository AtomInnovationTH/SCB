/**
 * mliFoilTexture.js — Crumpled gold MLI (Multi-Layer Insulation) foil maps, v3
 * (crumpled-mylar facet mosaic). BAKED-TEXTURE pipeline.
 *
 * ── BAKE PIPELINE (this module is the SOURCE OF TRUTH for the maps) ───────────
 * The v3 generator (`buildFoilPixels` + its helpers) is the canonical definition
 * of the foil look. It is deterministic (hash-based, no time/random seed) and
 * pure JS with NO DOM, so it runs identically in Node. The four maps are BAKED
 * to static lossless PNGs in `textures/` by `node scripts/bake-foil-maps.mjs`,
 * and the RUNTIME loads those PNGs instead of generating pixels — killing the
 * one-time ~0.8–1s (fast desktop) to ~2–4s+ (low-end) main-thread build stall.
 * After a knob tweak here, RE-RUN the bake script to regenerate the PNGs.
 *
 * Why baking is lossless & MORE consistent: the hash bottoms out in `Math.sin`,
 * whose last-ULP behaviour is engine-specific (stable within V8, but Safari/JSC
 * or Firefox could flip an occasional hash bucket). Runtime generation was never
 * strictly bit-identical across browsers; shipping baked PNGs makes it so. Bake
 * on Node/V8 only — re-bakes on the same toolchain are sha256-stable.
 *
 * ⚠ RE-BAKE DEPLOY NOTE: sw.js serves `/textures/` CACHE-FIRST, so re-baked PNGs
 * only reach returning players via a release (Constants.VERSION + sw.js
 * CACHE_NAME bumped together, per the pairing rule). No per-file version suffix
 * (matches the Earth textures).
 *
 * ── THE LOOK ──────────────────────────────────────────────────────────────────
 * Tileable normal + roughness + albedo maps that read as real lemon-gold
 * aluminized-Kapton foil — a thin, highly-reflective metallized film CRUMPLED
 * into a mosaic of large flat mirror facets separated by razor-sharp fold creases
 * (MOM/Chandrayaan-2/MRO flight & cleanroom photos). Adjacent facets jump tens of
 * degrees, so the environment reflects off each one at a wildly different angle →
 * a high-contrast patchwork of near-white specular tiles next to deep shadow
 * tiles. The variation is SPECULAR (facet normal + IBL), not albedo, so this must
 * be paired with a metallic, low-roughness material (PlayerSatellite
 * `_matGoldMLI`: metalness 1.0, roughness ≈0.45) under the scenes' PMREM IBL.
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
 * The baked PNGs write rows top-down exactly like the old canvas, and
 * `THREE.Texture`/`ImageLoader` default `flipY = true` just like `CanvasTexture`
 * — identical orientation, so the ny negation stays correct. Do NOT touch flipY,
 * and do NOT switch to ImageBitmapLoader (it flips at decode).
 *
 * ── RUNTIME LOADER (full-size-placeholder swap) ───────────────────────────────
 * `getMLIFoilMaps` clones from per-map "master" textures that start life showing
 * a FULL-SIZE (`FOIL_SIZE`²) solid-neutral placeholder canvas, then swap in the
 * decoded PNG via `texture.image = img; needsUpdate = true`. The placeholder MUST
 * be full-size: r184 uploads regular textures through IMMUTABLE `texStorage2D`,
 * allocating storage ONCE at the first upload's dimensions; a 1×1 placeholder
 * swapped to 1024² would `texSubImage2D` out of bounds (GL error, texture stuck
 * at 1×1). Full-size placeholder ⇒ first upload allocates 1024² immutable storage
 * + mips, and the PNG arrival is a same-size `texSubImage2D` re-upload — the only
 * supported swap path. The placeholder fill is ~1–3 ms and is GC'd after the swap.
 * Cost: a brief pop-in (plain lemon-gold neutral for <~300 ms until the PNG
 * decodes) on a cold first visit — matches the Earth texture loads; the service
 * worker makes repeat visits instant.
 *
 * Clones share the master's `Source`, and `Texture.copy()` forces version 1, so
 * a clone issued before the PNG arrives is registered and gets `needsUpdate` on
 * swap; clones issued after are already backed by uploaded storage. Per-part
 * scale works because each clone carries an independent `repeat`. Two roughness
 * masters exist: the default and a `smallPart` variant (higher floor) for
 * cm-scale clones (aperture ring, IR box) that would otherwise clip to white
 * under bloom.
 *
 * **Returns null in headless/no-DOM environments** (tests instantiate
 * PlayerSatellite in node with no document; ImageLoader needs DOM anyway).
 *
 * @module scene/mliFoilTexture
 */

import * as THREE from 'three';

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
 * Build the v3 crumpled-mylar maps as raw RGBA pixel buffers — PURE JS, NO DOM.
 * This is the BAKE SOURCE OF TRUTH: `scripts/bake-foil-maps.mjs` calls it in Node
 * and encodes the result to the static PNGs the runtime loads. Direct per-pixel
 * normal write (no Sobel/blur). Rows top-down (canvas/flipY-true parity).
 *
 * Four `Uint8ClampedArray(size*size*4)` RGBA buffers:
 *  - `normal`     : facet normal, ny negated (canvas-y-down vs UV-v-up), α=255.
 *  - `rough`      : default roughness, R=G=B, α=255 (multiplies material 0.45).
 *  - `roughSmall` : higher-floor roughness for cm-scale clones, R=G=B, α=255.
 *  - `albedo`     : near-neutral/near-white, R=G=B, α=255 (hue lives in material).
 *
 * @param {number} [size=1024]
 * @returns {{ size:number, normal:Uint8ClampedArray, rough:Uint8ClampedArray,
 *             roughSmall:Uint8ClampedArray, albedo:Uint8ClampedArray }}
 */
export function buildFoilPixels(size = 1024) {
  // ~14 cm square-ish facets on the 2.51×2.0 m barrel at repeat [1,1]:
  // 18 along u (circumference), 14 along v (height).
  const cellsU = 18, cellsV = 14;
  const { nx, ny, nz, crease, id: idField, tone } = _buildFields(size, cellsU, cellsV);

  const N = size * size;
  const normal = new Uint8ClampedArray(N * 4);
  const rough = new Uint8ClampedArray(N * 4);
  const roughSmall = new Uint8ClampedArray(N * 4);
  const albedo = new Uint8ClampedArray(N * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      const idx = p * 4;

      // ── Normal map v3 ─── direct write; NEGATE ny (canvas-y-down vs UV-v-up).
      normal[idx + 0] = Math.round((nx[p] * 0.5 + 0.5) * 255);
      normal[idx + 1] = Math.round((-ny[p] * 0.5 + 0.5) * 255);
      normal[idx + 2] = Math.round((nz[p] * 0.5 + 0.5) * 255);
      normal[idx + 3] = 255;

      const facetId = idField[p];
      const c = crease[p];

      // ── Roughness v3 ─── per-facet 0.30 + variantId·0.30 (0.30–0.60) +
      // crease·0.10. Sparkle REMOVED (large facets glint on their own). This map
      // MULTIPLIES material.roughness (≈0.45) → effective ~0.13–0.32.
      let r = 0.30 + facetId * 0.30 + c * 0.10;
      r = Math.max(0.30, Math.min(0.70, r));
      const rv = Math.round(r * 255);
      rough[idx + 0] = rv; rough[idx + 1] = rv; rough[idx + 2] = rv; rough[idx + 3] = 255;

      // smallPart roughness: same facets, higher floor (0.50) so cm-scale clones
      // (aperture ring, IR box) don't clip to white under bloom.
      let roughS = 0.50 + facetId * 0.20 + c * 0.08;
      roughS = Math.max(0.50, Math.min(0.80, roughS));
      const rsv = Math.round(roughS * 255);
      roughSmall[idx + 0] = rsv; roughSmall[idx + 1] = rsv; roughSmall[idx + 2] = rsv; roughSmall[idx + 3] = 255;

      // ── Albedo v3 ─── near-neutral/near-white; hue lives in the material
      // color so the gold reads LEMON, not amber. Faint per-facet tone jitter
      // (±3.5%); crease darkens only slightly (·0.05 max), NO red-shift, NO grout.
      const toneV = 0.95 + (tone[p] - 0.5) * 0.07;      // ±3.5% per facet
      const luma = toneV * (1 - c * 0.05);              // crease ≤5%
      const lv = Math.round(Math.min(1, luma) * 255);
      albedo[idx + 0] = lv; albedo[idx + 1] = lv; albedo[idx + 2] = lv; albedo[idx + 3] = 255;
    }
  }
  return { size, normal, rough, roughSmall, albedo };
}

/**
 * MUST match the baked PNG dimensions (`scripts/bake-foil-maps.mjs` bakes at this
 * size). Used only for full-size placeholder allocation (the immutable-storage
 * trap). A re-bake at a different size MUST update this constant too.
 */
const FOIL_SIZE = 1024;

/** Baked map files, relative paths (Earth.js / textures/ convention). */
const FOIL_FILES = {
  normal: 'textures/mli_foil_normal.png',
  rough: 'textures/mli_foil_roughness.png',
  roughSmall: 'textures/mli_foil_roughness_small.png',
  albedo: 'textures/mli_foil_albedo.png',
};

/**
 * Neutral solid fill per map for the full-size placeholder (the color a facet
 * reads before the PNG decodes): normal flat-up, rough/roughSmall mid-grey,
 * albedo white. Ensures the pre-load look degrades to plain lemon-gold, not a
 * black or broken material.
 */
const FOIL_NEUTRAL = {
  normal: 'rgb(128,128,255)',
  rough: 'rgb(128,128,128)',
  roughSmall: 'rgb(153,153,153)',
  albedo: 'rgb(255,255,255)',
};

/**
 * Per-map master texture records: `{ texture, loaded, clones[] }`. The texture
 * starts on a full-size neutral placeholder and swaps in the decoded PNG. Clones
 * issued before load are tracked so they can be version-bumped on swap.
 */
const _masters = new Map();

/** Build a full-size solid-neutral placeholder canvas (immutable-storage trap). */
function _makePlaceholderCanvas(fill) {
  const c = document.createElement('canvas');
  c.width = c.height = FOIL_SIZE;
  // Some test harnesses stub `document.createElement` with a bare object (no
  // canvas API); treat that as headless — return null so the caller degrades
  // to the null contract instead of throwing (matches the old _buildCanvases
  // `getContext !== 'function'` guard).
  if (typeof c.getContext !== 'function') return null;
  const ctx = c.getContext('2d');
  if (!ctx || typeof ctx.fillRect !== 'function') return null;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, FOIL_SIZE, FOIL_SIZE);
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

  const placeholder = _makePlaceholderCanvas(FOIL_NEUTRAL[key]);
  if (!placeholder) return null;

  // Plain Texture (not CanvasTexture): r184 never reads isCanvasTexture, and this
  // texture later carries an <img>. Full-size placeholder ⇒ first upload
  // allocates FOIL_SIZE² immutable storage; the PNG swap is a same-size re-upload.
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
      // Offline first visit: keep the neutral placeholder, warn once, no crash
      // and no per-frame renderer spam (the placeholder is a valid image).
      console.warn(`[mliFoilTexture] failed to load ${FOIL_FILES[key]}; using neutral placeholder`);
    }
  );
  return rec;
}

/**
 * Get crinkled-MLI normal + roughness + albedo maps (v3 crumpled mylar), backed
 * by the baked static PNGs in `textures/`.
 *
 * Returns freshly-cloned Texture objects on every call (sharing the cached master
 * Source) so each material part can set its own `repeat` without disturbing
 * others. Returns `null` in headless/no-DOM environments.
 *
 * @param {object} [opts]
 * @param {number} [opts.size]                       ignored (files are fixed size)
 * @param {number|[number,number]} [opts.repeat=1]   UV repeat (scalar or [u,v])
 * @param {boolean} [opts.smallPart=false]           use the higher-floor roughness
 *                                                    master for cm-scale clones
 * @returns {{ normalMap, roughnessMap, albedoMap }|null}
 */
export function getMLIFoilMaps(opts = {}) {
  if (typeof document === 'undefined') return null;

  const ru = Array.isArray(opts.repeat) ? opts.repeat[0] : (opts.repeat ?? 1);
  const rv = Array.isArray(opts.repeat) ? opts.repeat[1] : (opts.repeat ?? 1);

  const clone = (rec) => {
    if (!rec) return null;
    const t = rec.texture.clone();      // shares Source; copy() forces version 1
    t.repeat.set(ru, rv);
    // Only pre-load clones need the registry: post-load the Source is already
    // uploaded and copy()'s version bump uploads them on first bind.
    if (!rec.loaded) rec.clones.push(t);
    return t;
  };

  const normalMap = clone(_getMaster('normal', THREE.NoColorSpace));
  const roughnessMap = clone(_getMaster(
    opts.smallPart ? 'roughSmall' : 'rough',
    THREE.NoColorSpace
  ));
  const albedoMap = clone(_getMaster('albedo', THREE.SRGBColorSpace));

  if (!normalMap || !roughnessMap || !albedoMap) return null;
  return { normalMap, roughnessMap, albedoMap };
}

/** Test/teardown hook — dispose the master textures and drop the cache. */
export function _resetMLIFoilTextureCache() {
  for (const rec of _masters.values()) {
    if (rec.texture) rec.texture.dispose();
  }
  _masters.clear();
}
