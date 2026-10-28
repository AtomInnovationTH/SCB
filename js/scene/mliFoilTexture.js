/**
 * mliFoilTexture.js — gold MLI foil maps, BAKED: one crinkled gold-mylar sheet on the barrel (`crumpled`) and a
 * taut-but-crinkled one on the instrument box (`flat`) (DECISIONS §22). Textures: `textures/mli_foil_v8_*.png`.
 *
 * The lemon gold is the MATERIAL colour (`MLI_FOIL_LOOK.materialColor`); the ALBEDO map is neutral grey
 * (R = G = B), so the variation is SPECULAR (normal + roughness under the orbital env map), never tint.
 *
 * Maps (3 per variant):
 *   albedo : neutral grey tone (R = G = B), creases very slightly darker.
 *   normal : RGB tangent-space, from the gradient of the drape height field.
 *   rm     : G = roughness (relative; the material roughness multiplies it), B = 255 (all foil is metal).
 *            ONE texture serves both `roughnessMap` (reads G) and `metalnessMap` (reads B).
 *
 * Variants (FOIL_VARIANTS):
 *   `crumpled` — barrel skin: one un-tiled [1,1] wrap of the barrel UV (u = 1 is an integer wrap, so the
 *     cylinder is seamless; the field tiles by construction).
 *   `flat`     — instrument box: a calm taut sheet, very low amplitudes (the whole tile lands on every face,
 *     so any per-panel variation reads as camo).
 *
 * Why a height field: h(u,v) is a sum of tileable components — drape sweeps, per-panel pillow and tilt
 * (power-Voronoi lattice), pair-gated open border folds, fold CHAINS/fans, gated micro-crumple — and the
 * normals are its gradient. fBm noise, dense cellular facets and constant-normal facets were all rejected.
 *
 * TRAPS: (1) NO data-dependent normalisation (fixed per-UV `slopeGain`); (2) NO blur; (3) RESOLUTION
 * INDEPENDENCE — the central difference is scaled by the pixel spacing (`·size`), so `gain` is per UV unit and
 * a 64² test pins the same texture as the 1024² bake (thin crests still alias at low res, so unit-test bounds
 * are measured at the test size only).
 * SIGN: canvas rows run top-down while UV v runs bottom-up, so the byte write NEGATES ny. `THREE.Texture`/
 * `ImageLoader` default `flipY = true`; do NOT touch flipY or use ImageBitmapLoader.
 *
 * Bake: this module is the SOURCE OF TRUTH. `buildFoilPixels` is deterministic (hash-based), pure JS, NO DOM;
 * `node scripts/bake-foil-maps.mjs` encodes it to lossless PNGs and the RUNTIME loads those. The hash bottoms
 * out in `Math.sin`, whose last-ULP behaviour is engine-specific — bake on Node/V8 only.
 *
 * DEPLOY: sw.js serves `/textures/` CACHE-FIRST, so an in-place edit never reaches a returning player until
 * CACHE_NAME bumps. A re-bake that changes the look MUST take a new file name.
 *
 * Loader: `getMLIFoilMaps` clones per-map master textures that start on a same-size neutral placeholder canvas
 * and swap in the decoded PNG (r184 immutable `texStorage2D`: the placeholder MUST be the PNG's size — see
 * `FOIL_BAKE_SIZE`). Clones share the master's `Source`; ones issued before the load are version-bumped on swap.
 * Returns null in headless/no-DOM environments.
 *
 * @module scene/mliFoilTexture
 */

import * as THREE from 'three';
import { degToRad, clamp01, clamp, lerp, smoothstep01 } from '../core/MathUtil.js';

/**
 * The foil's material look — the ONE place PlayerSatellite reads it from, so the scan-flash restore cannot
 * drift from the build default. Lemon gold (R:G ≈ 1.16) is the MATERIAL colour. roughness 0.50 × the rm-map G
 * (crumpled 0.30–0.70) ⇒ effective 0.15–0.35: glossy enough for sharp crinkle glints. metalness 1.0 × rm-map B (255).
 */
export const MLI_FOIL_LOOK = Object.freeze({
  materialColor: 0xe3c24d,
  metalness: 1.0,
  roughness: 0.50,
  emissive: 0x4a3d12,
  emissiveIntensity: 0.16,
});

/**
 * Deterministic 2-D hash → 0..1 (lattice jitter, per-cell weight/amp/id/tilt, pair-gate, fold chains, anchors).
 * Callers must feed wrapped lattice coordinates so the field tiles. Do not touch: bake determinism rests on it.
 */
function _hash01(x, y, salt) {
  const s = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Seamless multi-octave value noise on the unit square, wrapping on both axes (`period` divides evenly so the
 * field tiles). `salt` decorrelates independent layers; `salt = 0` is the base hash.
 */
function _valueNoise(u, v, period, salt = 0) {
  const hash = (xi, yi) => {
    const x = ((xi % period) + period) % period;
    const y = ((yi % period) + period) % period;
    const s = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
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
 * VARIANT TABLE: two looks share one HEIGHT-FIELD generator. Fields feed `_buildHeight` or the byte write
 * (rough/albedo + crease mask). Validated against `mli_ref/mro_foil_crop.png` + an in-engine IBL harness.
 *
 *  - `crumpled` (barrel + aperture ring): STRONG drape sweeps + per-panel tilt + pair-gated open border folds +
 *    fold CHAINS/fans + gated micro-crumple → the MRO drape (large near-white↔amber gradient panels, long
 *    straight bright ridge crests, radiating fans, NO closed-cell read).
 *  - `flat` (instrument boxes): very low amplitudes → a calm taut sheet with a few soft folds (no glitter).
 *
 * Knobs (read before turning any dial):
 *  - `drapeAmp`: the smooth "mirror panels" sweep; keep it below the per-panel tilt.
 *  - `pillowAmp` KEEP SMALL (≤0.15): 0.5+ reads quilted/hammered, 1.0 cracked-mud.
 *  - `panelTiltAmp`: THE mid-band lever. Foil is a near-mirror, so contrast = env radiance contrast × NORMAL
 *    variation; with a contrasty orbital env-map (orbitalFoilEnv.js), raising this fractures the reflection
 *    into per-panel facets ("broken foil"). Sub-linear (border-gate `sm` × `invCells` damp it): 1.1→9 moved the
 *    512² 20°+ tilt share 13%→31% (target 25–40%). Re-measure via tmp/foil_v6_tilt.mjs after any change; >11
 *    reads glittery at hero scale.
 *  - `borderGate` (0.70): fraction of borders LEFT OPEN — breaks the closed-cell topology into an open network
 *    of straight segments. Do not lower much.
 *  - `foldCount` [anchors, raysPerAnchorMax, looseChains]: chains are polylines (2–4 straight segments) → long
 *    CONNECTED ridges (single segments read "pick-up-sticks"). Half-widths are widened ×1.7 (in _buildFolds) so
 *    crests survive one mip level at hero scale (sharpness ∝ amp/width; foldAmp 3.2 keeps the crest bright).
 *  - `microAmp`: subtle; raise first if the in-engine read lacks fine wrinkle. `microPeriods` are NON-aligned
 *    (13/29): aligned 16/32 showed a grid-plaid artifact.
 *  - `slopeGain` is per-UV-unit (resolution-INDEPENDENT — see `_normalsFromHeight`).
 *  - `slopeRef` is the crease-mask normalizer (~tan of the "fully rough" slope): crumpled ~tan 35°≈0.70, flat
 *    ~tan 8°≈0.14. Raise if creases read too dark.
 *  - If the flat box reads too DEAD in-engine, raise flat slopeGain 0.0234→0.03 or foldAmp 0.8→1.2.
 *  - FLAT `toneSpan` / `rough.span`: per-panel albedo + roughness spread. Keep them tiny: the whole 4×4 tile
 *    lands on EVERY box face, so any real span reads as gold CAMO (owner-rejected).
 */
const FOIL_VARIANTS = {
  crumpled: {                       // barrel + aperture ring
    cellsU: 11, cellsV: 9, weightAmp: 0.15,
    drapeAmp: 0.9, drapePeriod: 3,
    pillowAmp: 0.10, pillowK: 3.0,
    panelTiltAmp: 9.0,
    borderGate: 0.70, borderK: 6.5, borderAmp: 1.3,
    foldCount: [8, 4, 6],            // [anchors, raysPerAnchorMax, looseChains]
    foldAmp: 3.2,
    microAmp: 1.3, microPeriods: [13, 29], anchorRadius: 0.09,
    slopeGain: 0.082,                // per-UV-unit (resolution-independent)
    slopeRef: 0.70,                  // crease mask: ~tan 35°
    toneSpan: 0.07,
    rough:      { base: 0.30, span: 0.30, creaseAdd: 0.10, lo: 0.30, hi: 0.70 },
    creaseDarken: 0.05,
  },
  flat: {                           // IR box (taut sheet on flat faces)
    cellsU: 4, cellsV: 4, weightAmp: 0.3,
    drapeAmp: 0.5, drapePeriod: 2,
    pillowAmp: 0.10, pillowK: 1.6,
    panelTiltAmp: 0.25,
    borderGate: 0.75, borderK: 3.0, borderAmp: 0.5,
    foldCount: [2, 3, 4], foldAmp: 0.8,
    microAmp: 0.0, microPeriods: [13, 29], anchorRadius: 0.07,
    slopeGain: 0.0234,
    slopeRef: 0.14,                  // crease mask: ~tan 8°
    toneSpan: 0.008,
    rough: { base: 0.50, span: 0.05, creaseAdd: 0.06, lo: 0.50, hi: 0.80 },
    creaseDarken: 0.03,
  },
};

/**
 * Wrapped jittered POWER lattice's per-cell attributes with independent u/v cell counts, indexed
 * `[ly * cellsU + lx]`. Panel lattice for the pillow + per-panel-tilt components.
 *
 * Each cell: jitter (jx,jy); power weight² (w2); bulge amplitude amp ∈ [0.35,1); id (0..1) for per-panel
 * roughness/albedo tone; PLANAR TILT — unit direction (tx,ty) and SIGNED magnitude tm ∈ [−0.35, 0.65): a
 * CONTINUOUS gradient across the panel (gated to 0 at the borders), not a flat fill.
 *
 * @param {number} cu, cv  cell counts
 * @param {number} salt    separates this lattice from the fold layer
 * @param {number} wa      power-weight amplitude (weightAmp)
 */
function _buildLattice(cu, cv, salt, wa) {
  const n = cu * cv;
  const jx = new Float32Array(n), jy = new Float32Array(n);
  const w2 = new Float32Array(n), amp = new Float32Array(n), id = new Float32Array(n);
  const tx = new Float32Array(n), ty = new Float32Array(n), tm = new Float32Array(n);
  for (let ly = 0; ly < cv; ly++) {
    for (let lx = 0; lx < cu; lx++) {
      const i = ly * cu + lx;
      jx[i] = _hash01(lx, ly, salt + 1);
      jy[i] = _hash01(lx, ly, salt + 2);
      const wr = _hash01(lx, ly, salt + 3) * wa;   // power weight (lattice units)
      w2[i] = wr * wr;
      amp[i] = 0.35 + 0.65 * _hash01(lx, ly, salt + 4);
      id[i] = _hash01(lx, ly, salt + 5);
      const ta = _hash01(lx, ly, salt + 6) * Math.PI * 2;
      tx[i] = Math.cos(ta);
      ty[i] = Math.sin(ta);
      tm[i] = _hash01(lx, ly, salt + 7) - 0.35;    // signed tilt magnitude
    }
  }
  return { cu, cv, jx, jy, w2, amp, id, tx, ty, tm };
}

/**
 * Wrapped POWER (Laguerre) Voronoi sample: distance to each candidate is `d = sqrt(max(0, |offset|² − w²))`.
 *
 * WHY THE BORDERS STAY STRAIGHT (do NOT swap for a plain/anisotropic metric): the boundary is where
 * `|p−f1|² − w1² = |p−f2|² − w2²`; the `|p|²` terms cancel, leaving an equation LINEAR in (x,y) → a STRAIGHT
 * LINE. Straight borders feed the straight ridge segments; curved bisectors read "too organic".
 *
 * Returns winner i1 AND runner-up i2 (so `_buildHeight` can hash the SYMMETRIC pair and open only SOME borders
 * into folds), the RAW offset (dx1,dy1) to the winner feature point (tilt ramp = `dot((dx1,dy1),(tx,ty))`),
 * and f1/f2 (pillow/border tent profile).
 *
 * @returns {{f1:number, f2:number, i1:number, i2:number, dx1:number, dy1:number}}
 */
function _voronoi(u, v, t) {
  const gx = u * t.cu, gy = v * t.cv;
  const cx = Math.floor(gx), cy = Math.floor(gy);
  let f1 = Infinity, f2 = Infinity, i1 = 0, i2 = 0, dx1 = 0, dy1 = 0;
  for (let oy = -2; oy <= 2; oy++) {
    for (let ox = -2; ox <= 2; ox++) {
      const wx = cx + ox, wy = cy + oy;               // may be out of range
      const lx = ((wx % t.cu) + t.cu) % t.cu;         // wrapped lattice id
      const ly = ((wy % t.cv) + t.cv) % t.cv;
      const i = ly * t.cu + lx;
      const dx = gx - (wx + t.jx[i]);                 // unwrapped: continuous seam
      const dy = gy - (wy + t.jy[i]);
      const d = Math.sqrt(Math.max(0, dx * dx + dy * dy - t.w2[i]));
      if (d < f1) { f2 = f1; i2 = i1; f1 = d; i1 = i; dx1 = dx; dy1 = dy; }
      else if (d < f2) { f2 = d; i2 = i; }
    }
  }
  return { f1, f2, i1, i2, dx1, dy1 };
}

/**
 * Build ONE fold chain: a polyline of `segs` STRAIGHT segments laid end-to-end with a ±25° heading change per
 * joint → long CONNECTED ridges (single segments read "pick-up-sticks"). Each segment records its global t-span
 * [t0,t1] along the chain so the taper runs over the full polyline.
 *
 * Wrap-safety: endpoints may walk outside [0,1) — `_chainField` scans the 9 shifted torus copies. Keep total
 * chain length < ~0.9 uv or that window stops covering the chain (current max ≈ 0.70).
 */
function _buildChain(x0, y0, ang0, totalLen, segs, w, amp, fan, cSalt) {
  const segments = [];
  let x = x0, y = y0, ang = ang0;
  const segLen = totalLen / segs;
  for (let s = 0; s < segs; s++) {
    const dx = Math.cos(ang) * segLen, dy = Math.sin(ang) * segLen;
    segments.push({ x0: x, y0: y, dx, dy, t0: s / segs, t1: (s + 1) / segs });
    x += dx; y += dy;
    ang += (_hash01(s, cSalt, 91) - 0.5) * 2 * degToRad(25);   // ±25°/joint
  }
  return { segments, w, amp, fan };
}

/**
 * Build the fold layer: fan chains radiating from stress anchors + a few freestanding loose chains (sin(πt)
 * tapered). `count = [anchorCount, raysPerAnchorMax, looseCount]`.
 *
 * Each anchor spawns 3–7 ray-chains; each ray STARTS OFFSET (r0 ≈ 0.012–0.032) from the anchor so rays don't
 * converge into a bright BLOB. Ray half-widths 0.0045–0.012 uv (thin; sharpness ∝ amp/width). Ridge:crease sign
 * mix ≈ 60:40. Anchors are returned for the micro-crumple gate (crumple concentrates at stress points, like MRO).
 */
function _buildFolds(count, salt) {
  const A = count[0], R = count[1], L = count[2];
  const F = [];
  const anchors = [];
  for (let a = 0; a < A; a++) {
    const x0 = _hash01(a, 0, salt + 21), y0 = _hash01(a, 1, salt + 22);
    anchors.push({ x: x0, y: y0 });
    const rays = 3 + Math.floor(_hash01(a, 2, salt + 23) * R);
    for (let r = 0; r < rays; r++) {
      const ang = _hash01(a, 3 + r, salt + 24) * Math.PI * 2;
      const len = 0.25 + 0.45 * _hash01(a, 9 + r, salt + 25);
      const w = (0.0045 + 0.0075 * _hash01(a, 15 + r, salt + 26)) * 1.7;
      const amp = (0.55 + 0.45 * _hash01(a, 21 + r, salt + 27)) *
        (_hash01(a, 27 + r, salt + 28) < 0.6 ? 1 : -1);
      const r0 = 0.012 + 0.02 * _hash01(a, 33 + r, salt + 29);
      const segs = 2 + Math.floor(_hash01(a, 39 + r, salt + 30) * 3);
      F.push(_buildChain(x0 + Math.cos(ang) * r0, y0 + Math.sin(ang) * r0,
        ang, len, segs, w, amp, true, a * 61 + r));
    }
  }
  for (let k = 0; k < L; k++) {
    const x0 = _hash01(k, 40, salt + 31), y0 = _hash01(k, 41, salt + 32);
    const ang = _hash01(k, 42, salt + 33) * Math.PI * 2;
    const len = 0.25 + 0.40 * _hash01(k, 43, salt + 34);
    const w = (0.005 + 0.009 * _hash01(k, 44, salt + 35)) * 1.7;
    const amp = (0.5 + 0.5 * _hash01(k, 45, salt + 36)) *
      (_hash01(k, 46, salt + 37) < 0.5 ? 1 : -1);
    const segs = 2 + Math.floor(_hash01(k, 47, salt + 38) * 3);
    F.push(_buildChain(x0, y0, ang, len, segs, w, amp, false, 1000 + k * 17));
  }
  return { F, anchors };
}

/**
 * Minimum distance from (u,v) to a fold chain over the 9-wrap torus, with the global t at the closest point
 * (drives the along-chain taper).
 */
function _chainField(u, v, ch) {
  let best = Infinity, tAt = 0;
  for (const f of ch.segments) {
    const ll = f.dx * f.dx + f.dy * f.dy;
    for (let sy = -1; sy <= 1; sy++) {
      for (let sx = -1; sx <= 1; sx++) {
        const px = u + sx - f.x0, py = v + sy - f.y0;
        const tt = clamp01((px * f.dx + py * f.dy) / ll);
        const ex = px - tt * f.dx, ey = py - tt * f.dy;
        const d = Math.hypot(ex, ey);
        if (d < best) { best = d; tAt = lerp(f.t0, f.t1, tt); }
      }
    }
  }
  return { d: best, t: tAt };
}

/**
 * Sum of Gaussians (radius `radius`) around the fold anchors over the 9-wrap torus, clamped to 1. Gates the
 * micro-crumple to the fold-convergence stress points.
 */
function _anchorGate(u, v, anchors, radius) {
  let g = 0;
  const r2 = radius * radius;
  for (const a of anchors) {
    for (let sy = -1; sy <= 1; sy++) {
      for (let sx = -1; sx <= 1; sx++) {
        const dx = u + sx - a.x, dy = v + sy - a.y;
        g += Math.exp(-(dx * dx + dy * dy) / r2);
      }
    }
  }
  return Math.min(1, g);
}

/**
 * Build the continuous drape HEIGHT FIELD h(u,v) for one variant, row-major (size*size): a sum of 6 wrapped
 * deterministic components; normals come from ∇h in `_normalsFromHeight`.
 *
 *  1. DRAPE (drapeAmp): 2 octaves of wrapped value noise (period p + 2p, amp 1:0.4) — the dominant "mirror
 *     panels" read.
 *  2. PILLOW (pillowAmp): per-cell taut bulge, smoothstep'd from (f2−f1) so it is 0 at the borders.
 *  3. PER-PANEL PLANAR TILT (panelTiltAmp): random direction, signed magnitude, ramped along dot(offset,
 *     tiltDir) and gated by the same border profile (smooth in-panel GRADIENT, not a flat fill).
 *  4. PAIR-GATED BORDER FOLD (borderAmp): symmetric pair hash r = hash(min(i1,i2),max(i1,i2)); only borders
 *     with r ≥ borderGate carry a tent fold (sign from r), so the closed-cell network becomes an OPEN network of
 *     straight segments. The i1!==i2 guard skips a cell's self-border across the seam.
 *  5. FOLD CHAINS (foldAmp): fan + loose polyline ridges/creases (see `_buildFolds`). Fan taper
 *     `(1−t)·min(1,12t)`; loose taper `sin(πt)`. `·0.02` unit scale.
 *  6. MICRO-CRUMPLE (microAmp): 2-octave RIDGED value noise `(1−2|vn−.5|)²`, NON-aligned + offset periods,
 *     gated by the anchor Gaussians.
 *
 * @param {number} size
 * @param {object} vp   variant params (FOIL_VARIANTS entry)
 */
function _buildHeight(size, vp) {
  const lat = _buildLattice(vp.cellsU, vp.cellsV, 10, vp.weightAmp);
  const folds = _buildFolds(vp.foldCount, 30);
  const h = new Float32Array(size * size);
  const invCells = 1 / Math.max(vp.cellsU, vp.cellsV);
  const hasMicro = vp.microAmp > 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let hh = 0;

      // 1. drape sweeps
      hh += vp.drapeAmp * (_valueNoise(u, v, vp.drapePeriod, 1) - 0.5);
      hh += vp.drapeAmp * 0.4 * (_valueNoise(u, v, vp.drapePeriod * 2, 2) - 0.5);

      const vo = _voronoi(u, v, lat);
      // border profile: 1 in the panel interior → 0 at the border (smoothstep)
      const prof = Math.min(1, (vo.f2 - vo.f1) * vp.pillowK);
      const sm = smoothstep01(prof);

      // 2. pillow
      hh += vp.pillowAmp * lat.amp[vo.i1] * sm * invCells;

      // 3. per-panel tilt
      const ramp = (vo.dx1 * lat.tx[vo.i1] + vo.dy1 * lat.ty[vo.i1]) * invCells;
      hh += vp.panelTiltAmp * lat.tm[vo.i1] * ramp * sm;

      // 4. pair-gated border fold
      const a = Math.min(vo.i1, vo.i2), b = Math.max(vo.i1, vo.i2);
      const r = _hash01(a, b, 77);
      if (r >= vp.borderGate && vo.i1 !== vo.i2) {
        const sign = r > vp.borderGate + (1 - vp.borderGate) / 2 ? 1 : -1;
        const mag = 0.4 + 0.6 * _hash01(a, b, 78);
        const tent = Math.max(0, 1 - (vo.f2 - vo.f1) * vp.borderK);
        hh += vp.borderAmp * sign * mag * tent * tent * 0.02;
      }

      // 5. fold chains
      for (const ch of folds.F) {
        const cf = _chainField(u, v, ch);
        if (cf.d < ch.w) {
          const t = cf.t;
          const taper = ch.fan ? (1 - t) * Math.min(1, t * 12) : Math.sin(Math.PI * t);
          hh += vp.foldAmp * ch.amp * (1 - cf.d / ch.w) * taper * 0.02;
        }
      }

      // 6. micro-crumple
      if (hasMicro) {
        const gate = _anchorGate(u, v, folds.anchors, vp.anchorRadius);
        if (gate > 0.02) {
          let m = 0, amp = 1;
          for (const p of vp.microPeriods) {
            const vn = _valueNoise(u + 0.31, v + 0.17, p, 3 + p) - 0.5;
            const ridged = 1 - 2 * Math.abs(vn);
            m += amp * ridged * ridged;
            amp *= 0.5;
          }
          hh += vp.microAmp * gate * m * 0.01;
        }
      }

      h[y * size + x] = hh;
    }
  }
  return h;
}

/**
 * Normals from the height gradient via wrapped central differences: packed (size*size*3) Float32Array of unit
 * normals (nx,ny,nz), rows top-down.
 *
 * RESOLUTION INDEPENDENCE: the central difference MUST be scaled by the pixel spacing `·size`, so `gain` is a
 * per-UV-unit constant. Without it, mean tilt measured 49° at 64² vs 12° at 512². FIXED gain (no
 * data-dependent normalization) + NO blur must also never be reintroduced.
 *
 * ny is NOT negated here — the byte write in `buildFoilPixels` negates it (canvas rows top-down vs UV v
 * bottom-up).
 */
function _normalsFromHeight(h, size, gain) {
  const n = new Float32Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const ym = (y - 1 + size) % size, yp = (y + 1) % size;
      const gx = (h[y * size + xp] - h[y * size + xm]) * 0.5 * size * gain;
      const gy = (h[yp * size + x] - h[ym * size + x]) * 0.5 * size * gain;
      const inv = 1 / Math.hypot(gx, gy, 1);
      const i = (y * size + x) * 3;
      n[i] = -gx * inv;
      n[i + 1] = -gy * inv;
      n[i + 2] = inv;
    }
  }
  return n;
}

/**
 * Build the MLI maps as raw RGBA pixel buffers for one VARIANT — PURE JS, NO DOM. BAKE SOURCE OF TRUTH:
 * `scripts/bake-foil-maps.mjs` calls it in Node and encodes the static PNGs the runtime loads.
 *  - `normal` : from ∇h; ny NEGATED on write (canvas-y-down vs UV-v-up), α = 255.
 *  - `rm`     : G = roughness = base + id·span + crease·creaseAdd clamped [lo,hi] (R = G); B = 255. The crease
 *               mask `c` is the local slope / slopeRef — fold FACES and crumple zones are rougher; crest PEAKS
 *               stay bright (∇h ≈ 0 at a tent apex). Do not "fix" it.
 *  - `albedo` : neutral grey, R = G = B; faint per-panel tone, crease slightly dark.
 *
 * @param {number} [size]  default = FOIL_BAKE_SIZE[variant]
 * @param {'crumpled'|'flat'} [variant='crumpled']
 * @returns {{ size:number, variant:string, normal:Uint8ClampedArray,
 *             rm:Uint8ClampedArray, albedo:Uint8ClampedArray }}
 */
export function buildFoilPixels(size, variant = 'crumpled') {
  const vp = FOIL_VARIANTS[variant];
  if (!vp) throw new Error(`buildFoilPixels: unknown variant '${variant}'`);
  if (!size) size = FOIL_BAKE_SIZE[variant];

  const height = _buildHeight(size, vp);
  const nrm = _normalsFromHeight(height, size, vp.slopeGain);
  const lat = _buildLattice(vp.cellsU, vp.cellsV, 10, vp.weightAmp);   // same salt/params as in _buildHeight ⇒ identical assignment

  const N = size * size;
  const normal = new Uint8ClampedArray(N * 4);
  const rm = new Uint8ClampedArray(N * 4);
  const albedo = new Uint8ClampedArray(N * 4);
  const R = vp.rough;
  const slopeRef = vp.slopeRef;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      const idx = p * 4;
      const nx = nrm[p * 3], ny = nrm[p * 3 + 1], nz = nrm[p * 3 + 2];

      normal[idx + 0] = Math.round((nx * 0.5 + 0.5) * 255);
      normal[idx + 1] = Math.round((-ny * 0.5 + 0.5) * 255);   // NEGATE ny
      normal[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normal[idx + 3] = 255;

      // Crease mask from the local slope: |∇h| = |(-nx/nz, -ny/nz)| over slopeRef.
      const invz = 1 / Math.max(1e-6, nz);
      const c = Math.min(1, Math.hypot(-nx * invz, -ny * invz) / slopeRef);

      const vo = _voronoi(x / size, y / size, lat);
      const facetId = lat.id[vo.i1];

      let r = R.base + facetId * R.span + c * R.creaseAdd;
      r = clamp(r, R.lo, R.hi);
      const rv = Math.round(r * 255);
      rm[idx + 0] = rv; rm[idx + 1] = rv; rm[idx + 2] = 255; rm[idx + 3] = 255;

      const toneV = 0.95 + (facetId - 0.5) * vp.toneSpan;
      const luma = toneV * (1 - c * vp.creaseDarken);
      const lv = Math.round(Math.min(1, luma) * 255);
      albedo[idx + 0] = lv; albedo[idx + 1] = lv; albedo[idx + 2] = lv; albedo[idx + 3] = 255;
    }
  }
  return { size, variant, normal, rm, albedo };
}

/** Bake size (px, square) per variant; the loader's placeholder canvases use it. */
export const FOIL_BAKE_SIZE = Object.freeze({ crumpled: 1024, flat: 512 });

/** Baked map files, relative paths. */
export const FOIL_FILES = Object.freeze({
  normal: 'textures/mli_foil_v8_normal.png',
  rm: 'textures/mli_foil_v8_rough_metal.png',
  albedo: 'textures/mli_foil_v8_albedo.png',
  flatNormal: 'textures/mli_foil_v8_flat_normal.png',
  flatRm: 'textures/mli_foil_v8_flat_rough_metal.png',
  flatAlbedo: 'textures/mli_foil_v8_flat_albedo.png',
});

const FOIL_KEY_VARIANT = {
  normal: 'crumpled', rm: 'crumpled', albedo: 'crumpled',
  flatNormal: 'flat', flatRm: 'flat', flatAlbedo: 'flat',
};

/** Neutral solid fill per map for the placeholder shown before the PNG decodes (the gold is the material colour). */
const FOIL_NEUTRAL = {
  normal: 'rgb(128,128,255)',
  rm: 'rgb(128,128,255)',
  albedo: 'rgb(242,242,242)',
  flatNormal: 'rgb(128,128,255)',
  flatRm: 'rgb(166,166,255)',
  flatAlbedo: 'rgb(242,242,242)',
};

/** Per-map master texture records: `{ texture, loaded, clones[] }`. Clones issued before load are version-bumped on swap. */
const _masters = new Map();

/** Solid-neutral placeholder canvas of the key's bake size (immutable-storage trap). */
function _makePlaceholderCanvas(fill, px) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  // test harnesses may stub `document.createElement` with a bare object (no canvas API): treat as headless
  if (typeof c.getContext !== 'function') return null;
  const ctx = c.getContext('2d');
  if (!ctx || typeof ctx.fillRect !== 'function') return null;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, px, px);
  return c;
}

/** Master texture for a map key (owns the shared `Source`); the PNG loads once and swaps in via a same-size texSubImage2D. */
function _getMaster(key, colorSpace) {
  let rec = _masters.get(key);
  if (rec) return rec;

  const placeholder = _makePlaceholderCanvas(FOIL_NEUTRAL[key], FOIL_BAKE_SIZE[FOIL_KEY_VARIANT[key]]);
  if (!placeholder) return null;

  // plain Texture (not CanvasTexture): it later carries an <img>
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
      rec.texture.image = image;
      rec.texture.needsUpdate = true;
      // each clone gates on its OWN version; bump the ones issued pre-load
      for (const c of rec.clones) c.needsUpdate = true;
      rec.clones.length = 0;
      rec.loaded = true;
    },
    undefined,
    () => {
      // offline first visit: keep the neutral placeholder
      console.warn(`[mliFoilTexture] failed to load ${FOIL_FILES[key]}; using neutral placeholder`);
    }
  );
  return rec;
}

/**
 * Get the MLI foil maps (albedo + normal + rough/metal), backed by the baked PNGs. Default `crumpled` (barrel
 * skin); `variant: 'flat'` → instrument box.
 *
 * Returns freshly-cloned Textures on every call (sharing the cached master Source) so each part can set its own
 * `repeat`. `roughnessMap` and `metalnessMap` are the SAME texture object (G / B of one PNG). Null headless.
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
    // only pre-load clones need the registry: post-load, copy()'s version bump uploads them on first bind
    if (!rec.loaded) rec.clones.push(t);
    return t;
  };

  const normalMap = clone(_getMaster(flat ? 'flatNormal' : 'normal', THREE.NoColorSpace));
  const roughnessMap = clone(_getMaster(flat ? 'flatRm' : 'rm', THREE.NoColorSpace));
  const albedoMap = clone(_getMaster(flat ? 'flatAlbedo' : 'albedo', THREE.SRGBColorSpace));

  if (!normalMap || !roughnessMap || !albedoMap) return null;
  return { normalMap, roughnessMap, metalnessMap: roughnessMap, albedoMap };
}
