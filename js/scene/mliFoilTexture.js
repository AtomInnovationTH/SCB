/**
 * mliFoilTexture.js — Crumpled gold MLI (Multi-Layer Insulation) foil maps, v4
 * (straight-edge power-diagram facets + coarse-parent panel merging + a separate
 * low-tilt `flat` variant for instrument boxes). BAKED-TEXTURE pipeline.
 *
 * TWO VARIANTS (see FOIL_VARIANTS): `crumpled` (barrel + aperture ring) and
 * `flat` (instrument boxes). `buildFoilPixels(size, variant)` bakes each; the
 * loader exposes both via `getMLIFoilMaps({ variant })`.
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
 * v4 fixes two post-ship look notes on v3:
 *  1. v3's `_voronoi` used a per-cell ANISOTROPIC metric (offset rotated by −φ,
 *     scaled 1/s before hypot); boundaries between cells with different (φ,s) are
 *     CONIC CURVES, not straight bisectors → the barrel read "too organic /
 *     smooth curves". v4 drops elongation and uses a POWER (Laguerre) metric
 *     whose bisectors are STRAIGHT LINES (see `_voronoi`), plus a coarse PARENT
 *     lattice: with prob `inheritProb` a fine cell inherits its parent's normal +
 *     id, so adjacent same-parent cells MERGE into large flat panels and their
 *     shared borders vanish (pid crease gate in `_buildFields`) while
 *     different-parent borders chain into long straight ridge lines — the
 *     MRO/MESSENGER drape (large near-white panels + straight creases + slivers).
 *  2. v3's single tile mapped onto every tiny BoxGeometry face made the IR box a
 *     glitter/disco-ball. v4 adds a `flat` variant (very low tilt 1.5–7°, high
 *     inheritance, sparse shallow folds, one high-floor roughness) → a calm taut
 *     sheet with a few soft folds, matching the PRIME-1 instrument-box MLI.
 *
 * ⚠ The v3 "frozen baselines" quoted in older plans/handovers are INVALIDATED by
 * v4 (inheritance + power weights shift every stat). Re-measure before pinning
 * any test bound; the `flat` variant has its own (much calmer) stat envelope.
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
 * v4 VARIANT TABLE. Two looks share one generator; each part picks a variant.
 *
 *  - `crumpled` (barrel + aperture ring): straight-edge power-diagram facets +
 *    coarse-parent panel MERGING → long chained straight ridges + large merged
 *    flat panels next to sliver split-folds. Matches the MRO/MESSENGER drape:
 *    STRAIGHT creases, mixed facet sizes, big near-white panels beside deep ones.
 *  - `flat` (instrument boxes): a taut near-flat sheet — very low tilt (1.5–7°),
 *    high inheritance (mostly one big panel), sparse shallow folds, ONE roughness
 *    (high floor baked in). Matches the PRIME-1 box: calm smooth face, a handful
 *    of soft folds near edges, NO glitter/disco-ball.
 *
 * Knob order if the box still reads busy at sign-off: flat cellsU/V 6→5→4, then
 * inheritProb 0.55→0.70, then tiltHi 7→5.
 */
const FOIL_VARIANTS = {
  crumpled: {                       // barrel + aperture ring
    cellsU: 20, cellsV: 16,         // ~12.5 cm square-ish facets on the 2.51×2.0 m
                                    // barrel (20/2.51 ≈ 16/2.0 ≈ 8 per metre)
    coarseU: 6, coarseV: 5,         // parent lattice for merged panels
    inheritProb: 0.55,              // tuned up from 0.40 in the Task-2 preview:
                                    // 0.40 still read cellular/uniform; 0.55
                                    // grows the dominant merged panels the MRO
                                    // drape needs (large flats + straight ridges)
    tiltLo: 8, tiltHi: 40, tiltPow: 1.5,
    clampLo: 4, clampHi: 46,        // split-half α clamp (deg)
    splitProb: 0.40,                // straight sliver folds crossing panels
    splitDth: [15, 25], splitDa: [5, 12],
    weightAmp: 0.35,                // power-diagram radius boost (lattice units)
    pertDeg: 4, pertPeriod: 24,
    creaseK: 6.0,
    toneSpan: 0.07,                 // albedo per-facet jitter (±3.5%)
    rough:      { base: 0.30, span: 0.30, creaseAdd: 0.10, lo: 0.30, hi: 0.70 },
    roughSmall: { base: 0.50, span: 0.20, creaseAdd: 0.08, lo: 0.50, hi: 0.80 },
    creaseDarken: 0.05,
  },
  flat: {                           // IR box (taut sheet on flat faces)
    cellsU: 6, cellsV: 6,           // ~3.3 cm facets on the 20 cm box face
    coarseU: 2, coarseV: 2,
    inheritProb: 0.55,
    tiltLo: 1.5, tiltHi: 7, tiltPow: 1.3,
    clampLo: 0.8, clampHi: 10,
    splitProb: 0.12,
    splitDth: [15, 25], splitDa: [1, 3],
    weightAmp: 0.35,
    pertDeg: 2, pertPeriod: 6,      // broad gentle waves, not micro-noise
    creaseK: 6.0,
    toneSpan: 0.04,                 // calmer patchwork on box faces
    rough: { base: 0.50, span: 0.20, creaseAdd: 0.06, lo: 0.50, hi: 0.80 },
    roughSmall: null,               // flat has ONE roughness (high floor baked)
    creaseDarken: 0.03,
  },
};

/**
 * v4 — Precompute a wrapped jittered POWER lattice's per-cell attributes with
 * INDEPENDENT u/v cell counts. Indexed `[ly * cellsU + lx]`.
 *
 * v4 changes vs v3 (see module header for the full v3→v4 story):
 *  - DROPS elongation (v3's per-cell anisotropic metric bent facet borders into
 *    CONIC curves → the "too organic / smooth curves" read). v4 uses a plain
 *    POWER (Laguerre) metric whose cell borders are STRAIGHT LINES.
 *  - ADDS a per-cell POWER WEIGHT `w2` (radius boost) for facet-size variety.
 *  - ADDS a COARSE PARENT lattice (coarseU×coarseV). With prob `inheritProb`, a
 *    fine cell inherits its parent's (θ, α, id) verbatim and records `pid` =
 *    parent index. Adjacent same-parent cells then carry BIT-IDENTICAL normals +
 *    id ⇒ they merge into one seamless large flat panel; borders between
 *    different parents chain into long STRAIGHT ridge lines (the MRO drape).
 *
 * Each cell carries: jitter (jx,jy); power weight² (w2); parent id (pid, −1 if
 * not inherited); facet normal (nx,ny,nz) with tilt α = tiltLo +
 * (tiltHi−tiltLo)·hash^tiltPow; a sub-crease split (`split`,`sdx`,`sdy` +
 * far-half normal nx2,ny2,nz2 clamped to [clampLo,clampHi]); and id (0..1) for
 * per-facet roughness/albedo jitter (parent id when inherited — merged panels
 * deliberately share ONE tone/roughness patch).
 *
 * @param {object} vp     variant params (FOIL_VARIANTS entry)
 * @param {number} salt   separates lattices so they don't correlate
 */
function _buildCellTable(vp, salt) {
  const cellsU = vp.cellsU, cellsV = vp.cellsV;
  const coarseU = vp.coarseU, coarseV = vp.coarseV;
  const n = cellsU * cellsV;
  const nc = coarseU * coarseV;
  const jx = new Float32Array(n), jy = new Float32Array(n);
  const nx = new Float32Array(n), ny = new Float32Array(n), nz = new Float32Array(n);
  const w2 = new Float32Array(n);
  const pid = new Int16Array(n).fill(-1);
  const split = new Uint8Array(n);
  const sdx = new Float32Array(n), sdy = new Float32Array(n);
  const nx2 = new Float32Array(n), ny2 = new Float32Array(n), nz2 = new Float32Array(n);
  const id = new Float32Array(n);
  const DEG = Math.PI / 180;

  // ── Coarse parent lattice (built first): per-parent tilt + id. ──
  const cTheta = new Float32Array(nc), cAlpha = new Float32Array(nc), cId = new Float32Array(nc);
  for (let cy = 0; cy < coarseV; cy++) {
    for (let cx = 0; cx < coarseU; cx++) {
      const ci = cy * coarseU + cx;
      cTheta[ci] = _hash01(cx, cy, salt + 21.0) * Math.PI * 2;
      cAlpha[ci] = (vp.tiltLo + (vp.tiltHi - vp.tiltLo) *
        Math.pow(_hash01(cx, cy, salt + 22.0), vp.tiltPow)) * DEG;
      cId[ci] = _hash01(cx, cy, salt + 23.0);
    }
  }

  for (let ly = 0; ly < cellsV; ly++) {
    for (let lx = 0; lx < cellsU; lx++) {
      const i = ly * cellsU + lx;
      jx[i] = _hash01(lx, ly, salt + 1.0);
      jy[i] = _hash01(lx, ly, salt + 2.0);

      // Power weight (radius boost): wr ∈ [0, weightAmp) lattice units; store w².
      // (reuses the old φ salt channel — fine, v4 is a new look.)
      const wr = _hash01(lx, ly, salt + 5.0) * vp.weightAmp;
      w2[i] = wr * wr;

      // Own (fine-cell) tilt + id.
      let theta = _hash01(lx, ly, salt + 3.0) * Math.PI * 2;
      let alpha = (vp.tiltLo + (vp.tiltHi - vp.tiltLo) *
        Math.pow(_hash01(lx, ly, salt + 4.0), vp.tiltPow)) * DEG;
      let fid = _hash01(lx, ly, salt + 13.0);

      // INHERITANCE: with prob inheritProb, replace (θ, α, id) with the parent's
      // and record pid. Parent = coarse cell containing this fine cell's CENTER.
      if (_hash01(lx, ly, salt + 14.0) < vp.inheritProb) {
        const pu = Math.floor(((lx + 0.5) / cellsU) * coarseU) % coarseU;
        const pv = Math.floor(((ly + 0.5) / cellsV) * coarseV) % coarseV;
        const pi = pv * coarseU + pu;
        theta = cTheta[pi]; alpha = cAlpha[pi]; fid = cId[pi];
        pid[i] = pi;
      }

      const sa = Math.sin(alpha), ca = Math.cos(alpha);
      nx[i] = sa * Math.cos(theta);
      ny[i] = sa * Math.sin(theta);
      nz[i] = ca;

      // Sub-crease split: a SECOND normal for the far half. Base = POST-inherit
      // θ/α, so a split on an inherited cell draws a straight fold CROSSING the
      // merged panel (the fan folds crossing big panels in the MRO ref).
      const sp = _hash01(lx, ly, salt + 7.0) < vp.splitProb;
      split[i] = sp ? 1 : 0;
      if (sp) {
        const psi = _hash01(lx, ly, salt + 8.0) * Math.PI * 2;
        sdx[i] = Math.cos(psi);
        sdy[i] = Math.sin(psi);
        const dLo = vp.splitDth[0], dHi = vp.splitDth[1];
        const aLo = vp.splitDa[0], aHi = vp.splitDa[1];
        const dth = (dLo + (dHi - dLo) * _hash01(lx, ly, salt + 9.0)) * DEG *
          (_hash01(lx, ly, salt + 10.0) < 0.5 ? -1 : 1);
        const da = (aLo + (aHi - aLo) * _hash01(lx, ly, salt + 11.0)) * DEG *
          (_hash01(lx, ly, salt + 12.0) < 0.5 ? -1 : 1);
        const th2 = theta + dth;
        let a2 = alpha + da;
        if (a2 < vp.clampLo * DEG) a2 = vp.clampLo * DEG;
        if (a2 > vp.clampHi * DEG) a2 = vp.clampHi * DEG;
        const sa2 = Math.sin(a2), ca2 = Math.cos(a2);
        nx2[i] = sa2 * Math.cos(th2);
        ny2[i] = sa2 * Math.sin(th2);
        nz2[i] = ca2;
      } else {
        nx2[i] = nx[i]; ny2[i] = ny[i]; nz2[i] = nz[i];
        sdx[i] = 1; sdy[i] = 0;
      }

      id[i] = fid;
    }
  }
  return {
    cellsU, cellsV, jx, jy, w2, pid, nx, ny, nz,
    split, sdx, sdy, nx2, ny2, nz2, id,
  };
}

/**
 * v4 — Wrapped POWER (Laguerre) Voronoi sample using a precomputed cell table.
 * Distance to each candidate is the power metric `d = sqrt(max(0, |offset|² −
 * w²))`, where w² is the candidate's per-cell weight (radius boost).
 *
 * WHY THE EDGES STAY STRAIGHT (do NOT "simplify" this back to a plain/anisotropic
 * metric — that is exactly what bent v3's borders into conic curves): the cell
 * boundary is where `d1² − w1² = d2² − w2²`, i.e. `|p−f1|² − w1² = |p−f2|² − w2²`.
 * The `|p|²` terms cancel, leaving an equation LINEAR in (x,y) → a STRAIGHT LINE
 * (the power/Laguerre diagram property). The sqrt keeps `f2−f1` in ~lattice units
 * so `creaseK≈6` still yields a 1–2 px hairline. `Math.max(0,…)` guards pixels
 * inside a weight circle (d=0 near the feature point — harmless: the crease mask
 * ≈0 there since f2 is large). weightAmp≈0.35 « cell size, so a `rad=2` scan is
 * still sufficient. Power cells can occasionally be swallowed entirely (empty) —
 * fine, that IS the facet-size variety we want.
 *
 * Returns winner index i1 + runner-up index i2 (for the pid crease gate) + the
 * RAW offset (dx1,dy1) to the winner (split side = sign(dot((dx1,dy1),splitDir)))
 * + f1/f2 for the hairline crease mask.
 *
 * @returns {{f1:number, f2:number, i1:number, i2:number, dx1:number, dy1:number}}
 */
function _voronoi(u, v, tbl, rad) {
  const cu = tbl.cellsU, cv = tbl.cellsV;
  const gx = u * cu, gy = v * cv;
  const cx = Math.floor(gx), cy = Math.floor(gy);
  let f1 = Infinity, f2 = Infinity;
  let i1 = 0, i2 = 0, dx1 = 0, dy1 = 0;
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
      // Power metric: sqrt(max(0, |offset|² − w²)). Linear bisector ⇒ straight.
      const d = Math.sqrt(Math.max(0, dx * dx + dy * dy - tbl.w2[i]));
      if (d < f1) {
        f2 = f1; i2 = i1;
        f1 = d; i1 = i;
        dx1 = dx; dy1 = dy;
      } else if (d < f2) {
        f2 = d; i2 = i;
      }
    }
  }
  return { f1, f2, i1, i2, dx1, dy1 };
}

/**
 * v4 — Build the crumpled-mylar fields in ONE power-Voronoi pass. Emits, per
 * pixel: the winner facet/half NORMAL (with a tiny fBm perturbation, NO blur, so
 * borders stay 1-px discontinuities), a hairline CREASE mask GATED by panel
 * identity (roughness/albedo only), a winner ID (split half XORed in) for
 * per-facet jitter, and a coarse TONE (0..1) for a whisper of albedo variation.
 * No height field, no Sobel. All magnitudes come from the variant params `vp`.
 *
 * PANEL-IDENTITY CREASE GATE: merged panels (same parent) must show NO phantom
 * grid where two inherited fine cells meet. If the winner and runner-up carry the
 * SAME pid, the crease is zeroed. pid equality is EXACT (no float threshold):
 * same parent ⇒ bit-identical normals ⇒ genuinely one panel. Two non-inherited
 * neighbours (pid −1/−1) fail the `>= 0` check ⇒ crease drawn. i2 = the same
 * lattice cell wrapped around the torus compares pid to itself ⇒ gated ⇒ correct
 * (no self-crease). Split-half borders are unaffected (the gate touches only the
 * roughness/albedo hairline; normal-map discontinuities render from the normals
 * themselves).
 *
 * @param {number} size
 * @param {object} vp    variant params (FOIL_VARIANTS entry)
 * @returns {{ nx,ny,nz:Float32Array, crease:Float32Array, id:Float32Array,
 *             tone:Float32Array }} row-major (size*size)
 */
function _buildFields(size, vp) {
  const tbl = _buildCellTable(vp, 10.0);
  const N = size * size;
  const outNx = new Float32Array(N), outNy = new Float32Array(N), outNz = new Float32Array(N);
  const crease = new Float32Array(N);
  const idF = new Float32Array(N);
  const tone = new Float32Array(N);
  const DEG = Math.PI / 180;
  const PERT = Math.tan(vp.pertDeg * DEG);   // interior perturbation magnitude
  const period = vp.pertPeriod;
  const creaseK = vp.creaseK;

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

      // Tiny fBm interior perturbation: two channels nudge nx/ny, then
      // renormalize. Kept small so facets stay mirror-flat but not dead-flat.
      const p1 = (_valueNoise(u, v, period) - 0.5) * 2 * PERT;
      const p2 = (_valueNoise(u + 0.37, v + 0.19, period) - 0.5) * 2 * PERT;
      let fx = nx + p1, fy = ny + p2, fz = nz;
      const len = Math.hypot(fx, fy, fz) || 1;
      const idx = y * size + x;
      outNx[idx] = fx / len;
      outNy[idx] = fy / len;
      outNz[idx] = fz / len;

      // Hairline crease: (1 − min(1,(f2−f1)·k))^3 — then GATE by panel identity
      // so merged panels (same parent) show no phantom grid.
      let c;
      if (tbl.pid[vo.i1] >= 0 && tbl.pid[vo.i1] === tbl.pid[vo.i2]) {
        c = 0;
      } else {
        const e = 1 - Math.min(1, (vo.f2 - vo.f1) * creaseK);
        c = e * e * e;
      }
      crease[idx] = c;

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
 * v4 — Build the crumpled-mylar maps as raw RGBA pixel buffers for one VARIANT —
 * PURE JS, NO DOM. This is the BAKE SOURCE OF TRUTH: `scripts/bake-foil-maps.mjs`
 * calls it in Node for each variant and encodes the result to the static PNGs the
 * runtime loads. Direct per-pixel normal write (no Sobel/blur). Rows top-down
 * (canvas/flipY-true parity).
 *
 * All per-pixel magnitudes come from `FOIL_VARIANTS[variant]`:
 *  - `normal`     : facet normal, ny negated (canvas-y-down vs UV-v-up), α=255.
 *  - `rough`      : roughness base+id·span+crease·creaseAdd clamped [lo,hi], R=G=B.
 *  - `roughSmall` : higher-floor roughness for cm-scale clones — ONLY for variants
 *                   that define `vp.roughSmall` (crumpled); `null` otherwise (flat).
 *  - `albedo`     : near-neutral/near-white, R=G=B (hue lives in the material).
 *
 * @param {number} [size=1024]
 * @param {'crumpled'|'flat'} [variant='crumpled']
 * @returns {{ size:number, variant:string, normal:Uint8ClampedArray,
 *             rough:Uint8ClampedArray, roughSmall:Uint8ClampedArray|null,
 *             albedo:Uint8ClampedArray }}
 */
export function buildFoilPixels(size = 1024, variant = 'crumpled') {
  const vp = FOIL_VARIANTS[variant];
  if (!vp) throw new Error(`buildFoilPixels: unknown variant '${variant}'`);
  const { nx, ny, nz, crease, id: idField, tone } = _buildFields(size, vp);

  const N = size * size;
  const normal = new Uint8ClampedArray(N * 4);
  const rough = new Uint8ClampedArray(N * 4);
  const hasSmall = !!vp.roughSmall;
  const roughSmall = hasSmall ? new Uint8ClampedArray(N * 4) : null;
  const albedo = new Uint8ClampedArray(N * 4);

  const R = vp.rough, RS = vp.roughSmall;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      const idx = p * 4;

      // ── Normal map v4 ─── direct write; NEGATE ny (canvas-y-down vs UV-v-up).
      normal[idx + 0] = Math.round((nx[p] * 0.5 + 0.5) * 255);
      normal[idx + 1] = Math.round((-ny[p] * 0.5 + 0.5) * 255);
      normal[idx + 2] = Math.round((nz[p] * 0.5 + 0.5) * 255);
      normal[idx + 3] = 255;

      const facetId = idField[p];
      const c = crease[p];

      // ── Roughness v4 ─── base + id·span + crease·creaseAdd, clamped [lo,hi].
      // This map MULTIPLIES material.roughness.
      let r = R.base + facetId * R.span + c * R.creaseAdd;
      r = Math.max(R.lo, Math.min(R.hi, r));
      const rv = Math.round(r * 255);
      rough[idx + 0] = rv; rough[idx + 1] = rv; rough[idx + 2] = rv; rough[idx + 3] = 255;

      // smallPart roughness: same facets, higher floor (crumpled only).
      if (hasSmall) {
        let roughS = RS.base + facetId * RS.span + c * RS.creaseAdd;
        roughS = Math.max(RS.lo, Math.min(RS.hi, roughS));
        const rsv = Math.round(roughS * 255);
        roughSmall[idx + 0] = rsv; roughSmall[idx + 1] = rsv; roughSmall[idx + 2] = rsv; roughSmall[idx + 3] = 255;
      }

      // ── Albedo v4 ─── near-neutral/near-white; hue lives in the material
      // color so the gold reads LEMON, not amber. Faint per-facet tone jitter
      // (±toneSpan/2); crease darkens only slightly, NO red-shift, NO grout.
      const toneV = 0.95 + (tone[p] - 0.5) * vp.toneSpan;
      const luma = toneV * (1 - c * vp.creaseDarken);
      const lv = Math.round(Math.min(1, luma) * 255);
      albedo[idx + 0] = lv; albedo[idx + 1] = lv; albedo[idx + 2] = lv; albedo[idx + 3] = 255;
    }
  }
  return { size, variant, normal, rough, roughSmall, albedo };
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
  // v4 `flat` variant (instrument boxes): one calm normal + one roughness +
  // albedo (no smallPart — flat's high floor is baked into its single roughness).
  flatNormal: 'textures/mli_foil_flat_normal.png',
  flatRough: 'textures/mli_foil_flat_roughness.png',
  flatAlbedo: 'textures/mli_foil_flat_albedo.png',
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
  flatNormal: 'rgb(128,128,255)',
  flatRough: 'rgb(166,166,166)',   // 0.65 mid of the flat 0.50–0.80 roughness
  flatAlbedo: 'rgb(255,255,255)',
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
 * Get crinkled-MLI normal + roughness + albedo maps (v4), backed by the baked
 * static PNGs in `textures/`. Two variants:
 *  - default / anything but 'flat' → `crumpled` (barrel + aperture ring):
 *    straight-edge power-diagram facets + merged panels; `smallPart` selects the
 *    higher-floor roughness master for cm-scale clones.
 *  - `variant: 'flat'` → instrument-box taut-sheet look: separate flat masters,
 *    ONE roughness (high floor baked in — `smallPart` is ignored for flat).
 *
 * Returns freshly-cloned Texture objects on every call (sharing the cached master
 * Source) so each material part can set its own `repeat` without disturbing
 * others. Returns `null` in headless/no-DOM environments. All 7 masters are the
 * same FOIL_SIZE, so the single placeholder size holds for every one.
 *
 * @param {object} [opts]
 * @param {number} [opts.size]                       ignored (files are fixed size)
 * @param {number|[number,number]} [opts.repeat=1]   UV repeat (scalar or [u,v])
 * @param {boolean} [opts.smallPart=false]           crumpled only: higher-floor
 *                                                    roughness master
 * @param {'flat'|string} [opts.variant]             'flat' → box variant
 * @returns {{ normalMap, roughnessMap, albedoMap }|null}
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

  const normalKey = flat ? 'flatNormal' : 'normal';
  const roughKey = flat ? 'flatRough' : (opts.smallPart ? 'roughSmall' : 'rough');
  const albedoKey = flat ? 'flatAlbedo' : 'albedo';

  const normalMap = clone(_getMaster(normalKey, THREE.NoColorSpace));
  const roughnessMap = clone(_getMaster(roughKey, THREE.NoColorSpace));
  const albedoMap = clone(_getMaster(albedoKey, THREE.SRGBColorSpace));

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
