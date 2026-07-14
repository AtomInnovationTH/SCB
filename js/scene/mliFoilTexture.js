/**
 * mliFoilTexture.js — Gold MLI (Multi-Layer Insulation) foil maps, v5 — a
 * continuous HEIGHT-FIELD drape (drape sweeps + pillowed panels + per-panel tilt
 * + pair-gated border folds + fold CHAINS/fans + gated micro-crumple), normals
 * derived from the height gradient. A separate low-amplitude `flat` variant for
 * instrument boxes. BAKED-TEXTURE pipeline.
 *
 * TWO VARIANTS (see FOIL_VARIANTS): `crumpled` (barrel + aperture ring) and
 * `flat` (instrument boxes). `buildFoilPixels(size, variant)` bakes each; the
 * loader exposes both via `getMLIFoilMaps({ variant })`.
 *
 * ── BAKE PIPELINE (this module is the SOURCE OF TRUTH for the maps) ───────────
 * The v5 generator (`buildFoilPixels` + its helpers) is the canonical definition
 * of the foil look. It is deterministic (hash-based, no time/random seed) and
 * pure JS with NO DOM, so it runs identically in Node. The maps are BAKED
 * to static lossless PNGs in `textures/` by `node scripts/bake-foil-maps.mjs`,
 * and the RUNTIME loads those PNGs instead of generating pixels — killing the
 * one-time ~0.8–1s (fast desktop) to ~2–4s+ (low-end) main-thread build stall.
 * After a knob tweak here, RE-RUN the bake script to regenerate the PNGs.
 * (v5 bake cost: crumpled ~24 s + flat ~7 s at 1024² — offline-only, fine.)
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
 * aluminized-Kapton foil DRAPED over a 2.5 m barrel (the MRO
 * `Mars_Reconnaissance_Orbiter_fully_assembled` gold-foil target): long straight
 * SHARP bright ridge lines (fold crests catching specular streaks), fold FANS
 * radiating from stress points, LARGE smooth panels with continuous
 * near-white↔deep-amber gradient sweeps, fine micro-wrinkle concentrated near
 * fold-convergence points, almost NO closed-cell topology. The variation is
 * SPECULAR (surface normal + IBL), not albedo, so this must be paired with a
 * metallic, low-roughness material (PlayerSatellite `_matGoldMLI`: metalness 1.0,
 * roughness ≈0.45) under the scenes' PMREM IBL.
 *
 * ── WHY v5 IS A HEIGHT FIELD (root cause of every prior rejection) ────────────
 * History: v1 (fBm value noise) → hammered/blobby metal. v2 (dense isotropic
 * cellular facets, deep V grooves) → "gold nuggets" (cobblestone + grout). v2.1
 * (anisotropic near-coplanar "draped sheets") → too soft / quilted. v2.2 (flat
 * Voronoi facets, tilt encoded in HEIGHT then recovered via Sobel) → "gold
 * pebbles / rounded stones": the Sobel÷GLOBAL-normalization crushed facet-
 * interior tilt while the box blur rounded the crease rims. v3 (per-facet
 * PRECOMPUTED constant normal, no height) → organic curved creases, rejected.
 * v4 (straight-edge power-diagram facets + merged panels, still a CONSTANT normal
 * per facet) → the sun broke into a glitter/CELL MOSAIC — rejected at sign-off.
 *
 * v4's root fault: a constant normal per Voronoi facet means (1) facet interiors
 * are FLAT fills — no in-panel luminance gradients (real foil is a continuous
 * bent sheet, every panel shows a smooth sweep); (2) creases are just color-patch
 * boundaries — no bright crest lines (real fold ridges are TENTED, the crest
 * catches a bright specular streak); (3) cell borders form CLOSED polygon
 * networks — the eye reads cells/mosaic (real folds are OPEN curves that end,
 * branch, and fan from stress points).
 *
 * v5 fixes this ARCHITECTURALLY: build a continuous HEIGHT FIELD h(u,v) (see
 * `_buildHeight`) and derive normals from its gradient (`_normalsFromHeight`).
 * Sheet continuity, in-panel gradients, and tented crests all come for free.
 *
 * ⚠ TWO TRAPS from v2.2 that v5 must NOT reintroduce (both were the reason v2.2
 * failed with a height field): (1) DATA-DEPENDENT normalization — Sobel÷max
 * crushed interior tilt; v5 uses a FIXED per-UV `slopeGain` CONSTANT. (2) BLUR —
 * a box blur rounded crease rims; v5 does NO blur. Do not add either.
 *
 * ⚠ A THIRD, NEW trap (found in the v5 prototype session): RESOLUTION
 * INDEPENDENCE. Central differences MUST be scaled by the pixel spacing (`·size`)
 * or the look becomes resolution-dependent — the first prototype used a bare
 * `Δh·0.5·gain` and measured mean tilt 49° at 64² vs 12° at 512², so the 64² unit
 * test would pin a DIFFERENT texture than the 1024² bake. The correct form is
 * `gx = (h[xp]−h[xm])·0.5·size·gain` (see `_normalsFromHeight`). Even so, thin
 * sub-pixel tent crests ALIAS at low res, so their extremes still vary with
 * resolution: unit-test bounds are measured AT 64² only; the 512² sanity script
 * carries its OWN numbers; never cross-apply.
 *
 * SIGN TRAP: canvas rows run top-down while UV v runs bottom-up. `_normalsFromHeight`
 * NEGATES ny on byte-write (G = (−ny)·0.5+0.5) or every slope lights upside-down.
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
 *  - `drapeAmp` STRONG: carries the "mirror panels" read under IBL. If between
 *    folds reads too machined-smooth in-engine, raise 1.2→1.6 (and/or panelTilt).
 *  - `pillowAmp` KEEP SMALL (≤0.15): 0.5+ reads quilted/hammered, 1.0 cracked-mud.
 *  - `panelTiltAmp`: v4's mirror-mosaic variety but WITH smooth gradients.
 *  - `borderGate` (0.70): fraction of borders LEFT OPEN — this breaks the closed-
 *    cell topology into an open network of straight segments. Do not lower much.
 *  - `foldCount` [anchors, raysPerAnchorMax, looseChains]: chains are polylines
 *    (2–4 straight segments) → long CONNECTED ridges (single segments read
 *    "pick-up-sticks"). HALF-WIDTHS are thin (bright-line sharpness ∝ amp/width).
 *  - `microAmp`: still subtle; raise first if the in-engine read lacks fine
 *    wrinkle. `microPeriods` are NON-aligned (13/29) — aligned 16/32 showed a
 *    grid-plaid artifact.
 *  - `slopeGain` is per-UV-unit (resolution-INDEPENDENT — see `_normalsFromHeight`).
 *  - `slopeRef` is the crease-mask normalizer (~tan of the "fully rough" slope):
 *    crumpled ~tan 35°≈0.70, flat ~tan 8°≈0.14. Raise if creases read too dark.
 *  - If the flat box reads too DEAD in-engine, raise flat slopeGain 0.0234→0.03
 *    or foldAmp 0.8→1.2.
 */
const FOIL_VARIANTS = {
  crumpled: {                       // barrel + aperture ring
    cellsU: 11, cellsV: 9, weightAmp: 0.15,
    drapeAmp: 1.2, drapePeriod: 3,
    pillowAmp: 0.10, pillowK: 3.0,
    panelTiltAmp: 1.1,
    borderGate: 0.70, borderK: 6.5, borderAmp: 1.3,
    foldCount: [8, 4, 6],            // [anchors, raysPerAnchorMax, looseChains]
    foldAmp: 3.2,
    microAmp: 1.3, microPeriods: [13, 29], anchorRadius: 0.09,
    slopeGain: 0.082,                // per-UV-unit (resolution-independent)
    slopeRef: 0.70,                  // crease mask: ~tan 35°
    toneSpan: 0.07,
    rough:      { base: 0.30, span: 0.30, creaseAdd: 0.10, lo: 0.30, hi: 0.70 },
    roughSmall: { base: 0.50, span: 0.20, creaseAdd: 0.08, lo: 0.50, hi: 0.80 },
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
    toneSpan: 0.04,
    rough: { base: 0.50, span: 0.20, creaseAdd: 0.06, lo: 0.50, hi: 0.80 },
    roughSmall: null,               // flat has ONE roughness (high floor baked)
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
      const w = 0.0045 + 0.0075 * _hash01(a, 15 + r, salt + 26);
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
    const w = 0.005 + 0.009 * _hash01(k, 44, salt + 35);
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
 * v5 — Build the drape MLI maps as raw RGBA pixel buffers for one VARIANT — PURE
 * JS, NO DOM. This is the BAKE SOURCE OF TRUTH: `scripts/bake-foil-maps.mjs` calls
 * it in Node for each variant and encodes the result to the static PNGs the
 * runtime loads. Normals derive from the height gradient (no Sobel-of-a-tilt-field,
 * no blur). Rows top-down (canvas/flipY-true parity).
 *
 * SAME return shape as v4 so the bake script, tests and loader need no structural
 * change: `{ size, variant, normal, rough, roughSmall|null, albedo }`.
 *  - `normal`     : from ∇h; ny NEGATED on write (canvas-y-down vs UV-v-up), α=255.
 *  - `rough`      : base + id·span + crease·creaseAdd clamped [lo,hi], R=G=B.
 *                   The crease mask `c` is the local slope magnitude / slopeRef —
 *                   fold FACES and crumple zones are rougher. (It naturally leaves
 *                   crest PEAKS bright: ∇h ≈ 0 at a tent apex, so `c` ≈ 0 there —
 *                   that matches the refs, do not "fix" it.)
 *  - `roughSmall` : higher-floor roughness for cm-scale clones — ONLY when
 *                   `vp.roughSmall` is set (crumpled); `null` otherwise (flat).
 *  - `albedo`     : near-neutral/near-white per-panel tone, R=G=B (hue lives in the
 *                   material colour so the gold reads LEMON), crease slightly dark.
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

  const height = _buildHeight(size, vp);
  const nrm = _normalsFromHeight(height, size, vp.slopeGain);
  // The panel lattice is cheap and deterministic; rebuild it for the per-panel
  // tone/id (same salt/params as inside _buildHeight ⇒ identical assignment).
  const lat = _buildLattice(vp.cellsU, vp.cellsV, 10, vp.weightAmp);

  const N = size * size;
  const normal = new Uint8ClampedArray(N * 4);
  const rough = new Uint8ClampedArray(N * 4);
  const hasSmall = !!vp.roughSmall;
  const roughSmall = hasSmall ? new Uint8ClampedArray(N * 4) : null;
  const albedo = new Uint8ClampedArray(N * 4);

  const R = vp.rough, RS = vp.roughSmall;
  const slopeRef = vp.slopeRef;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      const idx = p * 4;
      const nx = nrm[p * 3], ny = nrm[p * 3 + 1], nz = nrm[p * 3 + 2];

      // ── Normal map v5 ── direct write; NEGATE ny (canvas-y-down vs UV-v-up).
      normal[idx + 0] = Math.round((nx * 0.5 + 0.5) * 255);
      normal[idx + 1] = Math.round((-ny * 0.5 + 0.5) * 255);
      normal[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normal[idx + 3] = 255;

      // Crease mask from the local slope: |∇h| = |(-nx/nz, -ny/nz)| over slopeRef.
      const invz = 1 / Math.max(1e-6, nz);
      const c = Math.min(1, Math.hypot(-nx * invz, -ny * invz) / slopeRef);

      // Per-panel id (tone patches — same role as v4).
      const vo = _voronoi(x / size, y / size, lat);
      const facetId = lat.id[vo.i1];

      // ── Roughness v5 ── base + id·span + crease·creaseAdd, clamped [lo,hi].
      let r = R.base + facetId * R.span + c * R.creaseAdd;
      r = Math.max(R.lo, Math.min(R.hi, r));
      const rv = Math.round(r * 255);
      rough[idx + 0] = rv; rough[idx + 1] = rv; rough[idx + 2] = rv; rough[idx + 3] = 255;

      // smallPart roughness: same panels, higher floor (crumpled only).
      if (hasSmall) {
        let roughS = RS.base + facetId * RS.span + c * RS.creaseAdd;
        roughS = Math.max(RS.lo, Math.min(RS.hi, roughS));
        const rsv = Math.round(roughS * 255);
        roughSmall[idx + 0] = rsv; roughSmall[idx + 1] = rsv; roughSmall[idx + 2] = rsv; roughSmall[idx + 3] = 255;
      }

      // ── Albedo v5 ── near-neutral/near-white; hue lives in the material colour
      // so the gold reads LEMON. Faint per-panel tone (±toneSpan/2); crease darkens
      // only slightly, NO red-shift, NO grout.
      const toneV = 0.95 + (facetId - 0.5) * vp.toneSpan;
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
 * Get gold-MLI normal + roughness + albedo maps (v5 drape), backed by the baked
 * static PNGs in `textures/`. Two variants:
 *  - default / anything but 'flat' → `crumpled` (barrel + aperture ring):
 *    height-field drape (sweeps + fold chains/fans); `smallPart` selects the
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
