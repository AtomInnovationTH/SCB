/**
 * mliFoilTexture.js — Gold MLI (Multi-Layer Insulation) foil maps, v8 — BAKED.
 *
 * v8 (2026-10-14, lane v9-foil-crinkle) puts back the v5/v6 "draped crumpled gold"
 * look and removes the v7 sewn blanket (panels, binding tape, stitches, tie-down
 * buttons). Owner, 2026-10-14: "prefer crinkled foil, it matchs the gold mylar foil
 * for scale model better." ONE crinkled gold-mylar sheet on the barrel (`crumpled`)
 * and a taut-but-crinkled sheet on the instrument box (`flat`). The generator below
 * is the v5/v6 height-field drape (commit 0c4d38db) ported unchanged in its maths;
 * only the output packing differs (one `rm` map instead of rough + a small-part roughness).
 *
 * The lemon gold is the MATERIAL colour (`MLI_FOIL_LOOK.materialColor`); the ALBEDO
 * map is neutral grey (R = G = B), so the variation is SPECULAR (normal + roughness
 * under the orbital env map), never tint.
 *
 * ── MAPS (3 per variant; PNGs in `textures/mli_foil_v8_*.png`) ────────────────
 *   albedo : neutral grey tone (R = G = B), creases very slightly darker.
 *   normal : RGB tangent-space, from the gradient of the drape height field.
 *   rm     : RGB, G = roughness (relative; the material roughness multiplies it),
 *            B = 255 (all foil is metal). ONE texture serves both `roughnessMap`
 *            (reads G) and `metalnessMap` (reads B).
 *
 * ── TWO VARIANTS (see FOIL_VARIANTS) ──────────────────────────────────────────
 *   `crumpled` — barrel skin: one un-tiled [1,1] wrap of the barrel UV (u = 1 is
 *     an integer wrap, so the cylinder is seamless; the field tiles by construction).
 *   `flat`     — instrument box (IR sensor): a calm taut sheet, very low amplitudes
 *     (the whole tile lands on every face, so any per-panel variation reads as camo).
 *
 * ── THE v5 ARCHITECTURE (why a height field) ──────────────────────────────────
 * h(u,v) is a sum of tileable components — drape sweeps, per-panel pillow and tilt
 * (power-Voronoi lattice), pair-gated open border folds, fold CHAINS/fans, gated
 * micro-crumple — and the normals are its gradient. Sheet continuity, in-panel
 * gradients and tented bright crests come for free. History: fBm value noise
 * (hammered), dense cellular facets (gold nuggets / pebbles), constant-normal
 * facets (glitter mosaic) were all rejected.
 *
 * ⚠ TRAPS: (1) NO data-dependent normalisation (fixed per-UV `slopeGain`);
 * (2) NO blur; (3) RESOLUTION INDEPENDENCE — the central difference is scaled by
 * the pixel spacing (`·size`), so `gain` is per UV unit and a 64² test pins the
 * same texture as the 1024² bake (thin crests still alias at low res, so unit-test
 * bounds are measured at the test size only).
 * SIGN: canvas rows run top-down while UV v runs bottom-up, so the byte write
 * NEGATES ny. `THREE.Texture`/`ImageLoader` default `flipY = true`; do NOT touch
 * flipY or use ImageBitmapLoader.
 *
 * ── BAKE PIPELINE (this module is the SOURCE OF TRUTH) ────────────────────────
 * `buildFoilPixels` is deterministic (hash-based) and pure JS with NO DOM, so it
 * runs identically in Node. `node scripts/bake-foil-maps.mjs` encodes the result
 * to lossless PNGs and the RUNTIME loads those. The hash bottoms out in `Math.sin`,
 * whose last-ULP behaviour is engine-specific — bake on Node/V8 only.
 *
 * ⚠ DEPLOY NOTE: sw.js serves `/textures/` CACHE-FIRST, so an in-place edit never
 * reaches a returning player until CACHE_NAME bumps. A future re-bake that changes
 * the look MUST take a new file name (v9…).
 *
 * ── RUNTIME LOADER ────────────────────────────────────────────────────────────
 * `getMLIFoilMaps` clones per-map master textures that start on a same-size neutral
 * placeholder canvas and swap in the decoded PNG (r184 immutable `texStorage2D`:
 * the placeholder MUST be the PNG's size — see `FOIL_BAKE_SIZE`). Clones share the
 * master's `Source`; ones issued before the load are version-bumped on swap.
 *
 * **Returns null in headless/no-DOM environments.**
 *
 * @module scene/mliFoilTexture
 */

import * as THREE from 'three';

/**
 * The foil's material look — the ONE place PlayerSatellite reads it from, so the
 * scan-flash restore can never drift from the build default (the v6 bug: restore
 * 0x4a3008 vs build 0x4a3d12).
 *
 * LEMON gold aluminised-Kapton (0xe3c24d, R:G ≈ 1.16) is the MATERIAL colour; the
 * albedo map is neutral grey. roughness 0.50 × the rm-map G (crumpled 0.30–0.70)
 * ⇒ effective 0.15–0.35: glossy enough for sharp crinkle glints. metalness 1.0 × the
 * rm-map B (255 everywhere).
 */
export const MLI_FOIL_LOOK = Object.freeze({
  materialColor: 0xe3c24d,
  metalness: 1.0,
  roughness: 0.50,
  emissive: 0x4a3d12,
  emissiveIntensity: 0.16,
});

/**
 * Deterministic 2-D hash → 0..1. Used for lattice-point jitter, per-cell weight/
 * amp/id/tilt, the symmetric pair-gate, fold-chain construction and anchor
 * placement. All callers must feed wrapped lattice coordinates so the field tiles.
 * Byte-identical to v4/v3 (do not touch — the bake determinism rests on it).
 */
function _hash01(x, y, salt) {
  const s = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Seamless multi-octave value noise on the unit square, wrapping on both axes
 * (`period` divides evenly so the field tiles). In v5 this carries STRONG signal:
 * the drape sweeps (2 octaves) and the micro-crumple (ridged, 2 octaves).
 *
 * v5 adds an optional `salt` param (matching the prototype) so independent noise
 * layers can be decorrelated; `salt = 0` reproduces v4/v3's hash exactly, so old
 * callers are unaffected (additive change, byte-stable at the default).
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
 * v5 VARIANT TABLE. Two looks share one HEIGHT-FIELD generator; each part picks a
 * variant. Every field feeds `_buildHeight` (h-field components) or the byte
 * write (rough/albedo + the crease mask). These are the VALIDATED prototype knobs
 * (six iterations against `mli_ref/mro_foil_crop.png` + an in-engine IBL harness
 * replicating the menu hero rig — see the plan for the audit trail).
 *
 *  - `crumpled` (barrel + aperture ring): STRONG drape sweeps + per-panel tilt +
 *    pair-gated open border folds + fold CHAINS/fans + gated micro-crumple → the
 *    MRO drape (large near-white↔amber gradient panels, long straight bright
 *    ridge crests, radiating fans, NO closed-cell read).
 *  - `flat` (instrument boxes): very low amplitudes → a calm taut sheet with a
 *    few soft folds, matching the PRIME-1 instrument-box MLI (no glitter).
 *
 * KNOB GUARDANCE (from the iteration log — read before turning any dial):
 *  - `drapeAmp` (v6: 0.9): the smooth "mirror panels" sweep. v6 LOWERED it from
 *    v5's 1.2 so the sweep no longer dominates the raised per-panel tilt.
 *  - `pillowAmp` KEEP SMALL (≤0.15): 0.5+ reads quilted/hammered, 1.0 cracked-mud.
 *  - `panelTiltAmp` (v6: 9.0, was v5 1.1): THE v6 mid-band lever. Foil is a
 *    near-mirror, so its contrast is (env radiance contrast × NORMAL variation).
 *    Once a contrasty orbital env-map is reflected (orbitalFoilEnv.js), raising
 *    this fractures the reflection into per-panel facets — the "broken foil" read.
 *    It responds sub-linearly (the border-gate `sm` × `invCells` damp it): v5→v6
 *    1.1→9 moved the 512² 20°+ tilt share 13%→31% (target 25–40%). Re-measure via
 *    tmp/foil_v6_tilt.mjs after any change; do NOT chase the raw number blindly —
 *    too high (>11) reads glittery at hero scale.
 *  - `borderGate` (0.70): fraction of borders LEFT OPEN — this breaks the closed-
 *    cell topology into an open network of straight segments. Do not lower much.
 *  - `foldCount` [anchors, raysPerAnchorMax, looseChains]: chains are polylines
 *    (2–4 straight segments) → long CONNECTED ridges (single segments read
 *    "pick-up-sticks"). HALF-WIDTHS are thin; v6 widened them ×1.7 (in _buildFolds)
 *    so fold crests survive one mip level at hero scale (bright-line sharpness ∝
 *    amp/width, so wider ⇒ softer — foldAmp held at 3.2 keeps the crest bright).
 *  - `microAmp`: still subtle; raise first if the in-engine read lacks fine
 *    wrinkle. `microPeriods` are NON-aligned (13/29) — aligned 16/32 showed a
 *    grid-plaid artifact.
 *  - `slopeGain` is per-UV-unit (resolution-INDEPENDENT — see `_normalsFromHeight`).
 *  - `slopeRef` is the crease-mask normalizer (~tan of the "fully rough" slope):
 *    crumpled ~tan 35°≈0.70, flat ~tan 8°≈0.14. Raise if creases read too dark.
 *  - If the flat box reads too DEAD in-engine, raise flat slopeGain 0.0234→0.03
 *    or foldAmp 0.8→1.2.
 *  - `toneSpan` / `rough.span` on the FLAT variant (v6.1: 0.008 / 0.05, slashed
 *    from 0.04 / 0.20): per-panel albedo + roughness spread. On the IR box the
 *    whole 4×4 tile lands on EVERY face, so any real span reads as gold CAMO
 *    (user-rejected). Keep these tiny — the box wants near-uniform plain gold.
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
    // v6.1 CAMO FIX: the box maps the WHOLE tile onto EVERY face (BoxGeometry,
    // repeat [1,1]), so each small face shows ALL 4×4=16 panels at once. Any
    // per-panel variation (albedo tone OR roughness) therefore reads as gold
    // CAMOUFLAGE (user-rejected — "even flat gold would be better"). The box
    // must be NEAR-UNIFORM plain gold: per-panel spans are slashed to ~faint,
    // leaving only folds/creases to carry a whisper of texture.
    cellsU: 4, cellsV: 4, weightAmp: 0.3,
    drapeAmp: 0.5, drapePeriod: 2,
    pillowAmp: 0.10, pillowK: 1.6,
    panelTiltAmp: 0.25,
    borderGate: 0.75, borderK: 3.0, borderAmp: 0.5,
    foldCount: [2, 3, 4], foldAmp: 0.8,
    microAmp: 0.0, microPeriods: [13, 29], anchorRadius: 0.07,
    slopeGain: 0.0234,
    slopeRef: 0.14,                  // crease mask: ~tan 8°
    toneSpan: 0.008,                 // v6.1: 0.04→0.008 (albedo blotches gone)
    rough: { base: 0.50, span: 0.05, creaseAdd: 0.06, lo: 0.50, hi: 0.80 }, // v6.1: span 0.20→0.05 (specular blotches gone; creases keep faint texture)
    creaseDarken: 0.03,
  },
};

/**
 * v5 — Precompute a wrapped jittered POWER lattice's per-cell attributes with
 * INDEPENDENT u/v cell counts. Indexed `[ly * cellsU + lx]`. This is the panel
 * lattice for the height field's pillow + per-panel-tilt components (NOT a
 * constant-normal facet table — v5 has no such thing).
 *
 * Each cell carries: jitter (jx,jy); power weight² (w2, radius boost for panel-
 * size variety); a per-panel bulge amplitude (amp ∈ [0.35,1)); an id (0..1) for
 * per-panel roughness/albedo tone; and a per-panel PLANAR TILT — a unit direction
 * (tx,ty) and a SIGNED magnitude tm ∈ [−0.35, 0.65). The tilt gives v4's mirror-
 * mosaic panel variety but as a CONTINUOUS gradient across the panel (gated to 0
 * at the borders), not a flat fill.
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
 * v5 — Wrapped POWER (Laguerre) Voronoi sample. Distance to each candidate is the
 * power metric `d = sqrt(max(0, |offset|² − w²))`.
 *
 * WHY THE BORDERS STAY STRAIGHT (do NOT swap this for a plain/anisotropic metric):
 * the cell boundary is where `|p−f1|² − w1² = |p−f2|² − w2²`; the `|p|²` terms
 * cancel, leaving an equation LINEAR in (x,y) → a STRAIGHT LINE (the power/Laguerre
 * property). Straight borders are what feed the straight ridge segments; curved
 * bisectors were exactly v3's rejected "too organic" read.
 *
 * PAIR-GATE role: returns the winner index i1 AND runner-up i2 so `_buildHeight`
 * can hash the SYMMETRIC pair (min,max) and open only SOME borders into folds —
 * that gating is what breaks the closed-cell topology into an open network. Also
 * returns the RAW offset (dx1,dy1) to the winner feature point (the per-panel tilt
 * ramp is `dot((dx1,dy1),(tx,ty))`) and f1/f2 (the pillow/border tent profile).
 *
 * @returns {{f1:number, f2:number, i1:number, i2:number, dx1:number, dy1:number}}
 */
function _voronoi(u, v, t) {
  const gx = u * t.cu, gy = v * t.cv;
  const cx = Math.floor(gx), cy = Math.floor(gy);
  let f1 = Infinity, f2 = Infinity, i1 = 0, i2 = 0, dx1 = 0, dy1 = 0;
  for (let oy = -2; oy <= 2; oy++) {
    for (let ox = -2; ox <= 2; ox++) {
      const wx = cx + ox, wy = cy + oy;               // (may be out of range)
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
 * v5 — Build ONE fold chain: a polyline of `segs` STRAIGHT segments laid end-to-
 * end with a small (±25°) heading change per joint. End-to-end segments →
 * long CONNECTED drape ridges crossing the tile (the MRO chains); single segments
 * read "pick-up-sticks" (observed and rejected). Each segment records its global
 * t-span [t0,t1] along the whole chain so the taper runs over the full polyline.
 *
 * Wrap-safety: endpoints may walk outside [0,1) — fine, `_chainField` scans the 9
 * shifted torus copies. Keep total chain length < ~0.9 uv or the 9-wrap window
 * stops covering the chain (current max ≈ 0.70).
 */
function _buildChain(x0, y0, ang0, totalLen, segs, w, amp, fan, cSalt) {
  const segments = [];
  let x = x0, y = y0, ang = ang0;
  const segLen = totalLen / segs;
  for (let s = 0; s < segs; s++) {
    const dx = Math.cos(ang) * segLen, dy = Math.sin(ang) * segLen;
    segments.push({ x0: x, y0: y, dx, dy, t0: s / segs, t1: (s + 1) / segs });
    x += dx; y += dy;
    ang += (_hash01(s, cSalt, 91) - 0.5) * 2 * (25 * Math.PI / 180);   // ±25°/joint
  }
  return { segments, w, amp, fan };
}

/**
 * v5 — Build the fold layer: fan chains radiating from stress anchors + a few
 * loose chains. `count = [anchorCount, raysPerAnchorMax, looseCount]`.
 *
 * Each anchor spawns 3–7 ray-chains fanning out; each ray STARTS OFFSET
 * (r0 ≈ 0.012–0.032) from the anchor so the rays don't all converge into a bright
 * BLOB (observed and rejected). Ray half-widths are thin (0.0045–0.012 uv) — the
 * bright-line sharpness is ∝ amp/width. Ridge:crease sign mix ≈ 60:40. Anchors
 * are returned separately for the micro-crumple gate (crumple concentrates at the
 * stress points, like MRO — not in random patches).
 *
 * Loose chains are freestanding (no anchor), sin(πt) tapered.
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
 * v5 — Minimum distance from (u,v) to a fold chain over the 9-wrap torus, with
 * the global t at the closest point (drives the along-chain taper). Perpendicular
 * distance to each segment, minimised over all segments × 9 shifted copies.
 */
function _chainField(u, v, ch) {
  let best = Infinity, tAt = 0;
  for (const f of ch.segments) {
    const ll = f.dx * f.dx + f.dy * f.dy;
    for (let sy = -1; sy <= 1; sy++) {
      for (let sx = -1; sx <= 1; sx++) {
        const px = u + sx - f.x0, py = v + sy - f.y0;
        const tt = Math.max(0, Math.min(1, (px * f.dx + py * f.dy) / ll));
        const ex = px - tt * f.dx, ey = py - tt * f.dy;
        const d = Math.hypot(ex, ey);
        if (d < best) { best = d; tAt = f.t0 + (f.t1 - f.t0) * tt; }
      }
    }
  }
  return { d: best, t: tAt };
}

/**
 * v5 — Sum of Gaussians (radius `radius`) around the fold anchors over the 9-wrap
 * torus, clamped to 1. Gates the micro-crumple so fine wrinkle concentrates at the
 * fold-convergence stress points (like MRO), not in random patches.
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
 * v5 — Build the continuous drape HEIGHT FIELD h(u,v) for one variant. Row-major
 * (size*size). This is the whole v5 architecture: h is a sum of 6 wrapped/tileable
 * components (all salt-hashed, deterministic); normals come from ∇h in
 * `_normalsFromHeight`. Sheet continuity, in-panel gradients and tented crests all
 * fall out of taking a gradient of a continuous field — the fix for every prior
 * "flat facet fill / no crest lines / closed cells" rejection.
 *
 *  1. DRAPE (drapeAmp): 2 octaves of wrapped value noise (period p + 2p, amp 1:0.4)
 *     — the near-white↔amber panel sweeps; the dominant "mirror panels" read.
 *  2. PILLOW (pillowAmp): per-cell taut bulge, profile smoothstep'd from (f2−f1)
 *     so it is 0 at the borders (continuous). KEEP SMALL — quilted/mud otherwise.
 *  3. PER-PANEL PLANAR TILT (panelTiltAmp): each panel tilts a random direction by
 *     a signed magnitude, ramped along dot(offset, tiltDir) and gated by the same
 *     border profile (0 at borders ⇒ continuous). v4's mirror-mosaic variety, but
 *     as a smooth in-panel GRADIENT, not a flat fill.
 *  4. PAIR-GATED BORDER FOLD (borderAmp): the straightness trick. Symmetric pair
 *     hash r = hash(min(i1,i2),max(i1,i2)); only borders with r ≥ borderGate carry
 *     a tent fold (sign from r) — the rest stay smooth. Gating BREAKS the closed-
 *     cell polygon network into an OPEN network of straight segments. The
 *     i1!==i2 guard skips a cell's self-border across the seam.
 *  5. FOLD CHAINS (foldAmp): fan + loose polyline ridges/creases (see `_buildFolds`)
 *     — the long connected MRO drape ridges. Fan taper `(1−t)·min(1,12t)`; loose
 *     taper `sin(πt)`. `·0.02` unit scale.
 *  6. MICRO-CRUMPLE (microAmp): 2-octave RIDGED value noise `(1−2|vn−.5|)²`, periods
 *     NON-aligned + offset (aligned periods showed grid-plaid), gated by the anchor
 *     Gaussians so it concentrates at stress points. Subtle; raise first if needed.
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

      // 1. Drape sweeps (2 octaves).
      hh += vp.drapeAmp * (_valueNoise(u, v, vp.drapePeriod, 1) - 0.5);
      hh += vp.drapeAmp * 0.4 * (_valueNoise(u, v, vp.drapePeriod * 2, 2) - 0.5);

      const vo = _voronoi(u, v, lat);
      // Border profile: 1 in the panel interior → 0 at the border (smoothstep).
      const prof = Math.min(1, (vo.f2 - vo.f1) * vp.pillowK);
      const sm = prof * prof * (3 - 2 * prof);

      // 2. Pillow bulge (border-gated ⇒ continuous).
      hh += vp.pillowAmp * lat.amp[vo.i1] * sm * invCells;

      // 3. Per-panel planar tilt (ramp along the tilt direction, border-gated).
      const ramp = (vo.dx1 * lat.tx[vo.i1] + vo.dy1 * lat.ty[vo.i1]) * invCells;
      hh += vp.panelTiltAmp * lat.tm[vo.i1] * ramp * sm;

      // 4. Pair-gated border fold (open straight-segment network).
      const a = Math.min(vo.i1, vo.i2), b = Math.max(vo.i1, vo.i2);
      const r = _hash01(a, b, 77);
      if (r >= vp.borderGate && vo.i1 !== vo.i2) {
        const sign = r > vp.borderGate + (1 - vp.borderGate) / 2 ? 1 : -1;
        const mag = 0.4 + 0.6 * _hash01(a, b, 78);
        const tent = Math.max(0, 1 - (vo.f2 - vo.f1) * vp.borderK);
        hh += vp.borderAmp * sign * mag * tent * tent * 0.02;
      }

      // 5. Fold chains (fans + loose).
      for (const ch of folds.F) {
        const cf = _chainField(u, v, ch);
        if (cf.d < ch.w) {
          const t = cf.t;
          const taper = ch.fan ? (1 - t) * Math.min(1, t * 12) : Math.sin(Math.PI * t);
          hh += vp.foldAmp * ch.amp * (1 - cf.d / ch.w) * taper * 0.02;
        }
      }

      // 6. Micro-crumple (ridged, gated to the stress anchors).
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
 * v5 — Normals from the height gradient via wrapped central differences. Returns a
 * packed (size*size*3) Float32Array of unit normals (nx,ny,nz), rows top-down.
 *
 * ⚠ RESOLUTION INDEPENDENCE (the third trap — see the module header): the central
 * difference MUST be scaled by the pixel spacing `·size`, so `gain` is a per-UV-
 * unit constant, NOT a per-pixel one. Without `·size`, mean tilt measured 49° at
 * 64² vs 12° at 512² and the 64² unit test would pin a different texture than the
 * 1024² bake. FIXED gain (no data-dependent normalization) + NO blur are the
 * other two v2.2 traps this must never reintroduce.
 *
 * ny is NOT negated here — the byte write in `buildFoilPixels` negates it (canvas
 * rows top-down vs UV v bottom-up); keeping the raw sign here lets the shaded
 * preview / rough-mask reuse the gradient directly.
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
 * v8 — Build the MLI maps as raw RGBA pixel buffers for one VARIANT — PURE JS, NO
 * DOM. This is the BAKE SOURCE OF TRUTH: `scripts/bake-foil-maps.mjs` calls it in
 * Node and encodes the result to the static PNGs the runtime loads.
 *  - `normal` : from ∇h; ny NEGATED on write (canvas-y-down vs UV-v-up), α = 255.
 *  - `rm`     : G = roughness = base + id·span + crease·creaseAdd clamped [lo,hi]
 *               (R = G); B = 255 (all foil is metal). The crease mask `c` is the
 *               local slope / slopeRef — fold FACES and crumple zones are rougher;
 *               crest PEAKS stay bright (∇h ≈ 0 at a tent apex). Do not "fix" it.
 *  - `albedo` : neutral grey, R = G = B; faint per-panel tone, crease slightly dark.
 *               The gold hue lives in the material colour (MLI_FOIL_LOOK).
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
  // The panel lattice is cheap and deterministic; rebuild it for the per-panel
  // tone/id (same salt/params as inside _buildHeight ⇒ identical assignment).
  const lat = _buildLattice(vp.cellsU, vp.cellsV, 10, vp.weightAmp);

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
      r = Math.max(R.lo, Math.min(R.hi, r));
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

/** Bake size (px, square) per variant. The loader's placeholder canvases use it. */
export const FOIL_BAKE_SIZE = Object.freeze({ crumpled: 1024, flat: 512 });

/** Baked map files, relative paths (Earth.js / textures/ convention). v8 = NEW names (cache-first sw). */
export const FOIL_FILES = Object.freeze({
  normal: 'textures/mli_foil_v8_normal.png',
  rm: 'textures/mli_foil_v8_rough_metal.png',
  albedo: 'textures/mli_foil_v8_albedo.png',
  flatNormal: 'textures/mli_foil_v8_flat_normal.png',
  flatRm: 'textures/mli_foil_v8_flat_rough_metal.png',
  flatAlbedo: 'textures/mli_foil_v8_flat_albedo.png',
});

/** Which variant (⇒ bake size) each map key belongs to. */
const FOIL_KEY_VARIANT = {
  normal: 'crumpled', rm: 'crumpled', albedo: 'crumpled',
  flatNormal: 'flat', flatRm: 'flat', flatAlbedo: 'flat',
};

/**
 * Neutral solid fill per map for the placeholder (the look before the PNG
 * decodes): normal flat-up, rm = mid roughness / full metal, albedo = the neutral
 * grey tone (the gold is the material colour).
 */
const FOIL_NEUTRAL = {
  normal: 'rgb(128,128,255)',
  rm: 'rgb(128,128,255)',
  albedo: 'rgb(242,242,242)',
  flatNormal: 'rgb(128,128,255)',
  flatRm: 'rgb(166,166,255)',
  flatAlbedo: 'rgb(242,242,242)',
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
 * Get the MLI foil maps (albedo + normal + rough/metal), backed by the baked
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
