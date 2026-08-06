/**
 * NetMeshKit.js — shared "web in space" net-mesh factory for BOTH capture nets.
 *
 * One mesh vocabulary, parameterized by diameter, used by the Mother net
 * ([`LassoSystem`](../systems/LassoSystem.js)) and the Daughter nets
 * ([`CaptureNetVisual`](./CaptureNetVisual.js)). Unifies the capture-net look
 * (handoff option B) so both read as the same elegant, translucent web.
 *
 * ── Strictly local-space (see plan §1.6) ─────────────────────────────────────
 * The kit ONLY builds geometry around a local origin and exposes LOCAL setters
 * (mouth fraction, colour, opacity, spin angle, cinched rim, drawstring rebuild)
 * + the meshes/params each consumer's animation needs. It NEVER touches
 * `group.position`, `group.quaternion`, `lookAt`, `net.position`, `_projOffset`,
 * `_armPinned`, `_scenePosition`, `distanceTraveled`, `CeremonyTimeScale`, or any
 * orbit/debris data. All of the solved frame/motion machinery (F1–F12) stays in
 * the consumers; the kit only swaps the mesh-construction source + the low-level
 * mesh setters.
 *
 * ── Geometry convention ──────────────────────────────────────────────────────
 * Apex at the local origin `(0,0,0)` (tether/hub side); mouth at local **−Z**
 * (forward / target side). This matches the daughter's existing camera-style
 * `lookAt` convention ([`CaptureNetVisual.js`](./CaptureNetVisual.js):969–1001),
 * so the daughter's envelop/cinch math is untouched. The Mother orients its
 * group via its own quaternion path (it just feeds the kit a group).
 *
 * Stage B reproduces a fine orb-weaver **spoke + ring web** (radial spokes from
 * apex to rim + concentric "spiral thread" rings), a single `THREE.LineSegments`
 * with optional additive shimmer — the owner's "beautiful web". The cone
 * envelope (apex at origin, mouth ring at local −Z, `mouthRadius` / `coneHeight`)
 * is identical to Stage A, so every consumer animation (scale, mouth-fraction,
 * rim-node placement, colour-by-phase, cinch) and all geometry invariants are
 * preserved — only the line topology + material changed. The handle still
 * exposes the web as `coneMesh` (alias `webLines`) for byte-compatible consumers.
 *
 * @module ui/NetMeshKit
 */

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { Constants } from '../core/Constants.js';

/** 1 metre in scene units (1 scene unit = 100 km). Matches both consumers. */
const M = 1e-5;

const NET_CER = Constants.CAPTURE_NET.NET_CEREMONY;
const NET_WEB = Constants.NET_WEB;

// ── Fat-line resolution sync (plan §3 / §11 Phase B) ────────────────────────
// LineMaterial computes screen-space width from `resolution` (the DRAWING-BUFFER
// size in px, i.e. CSS px × pixelRatio). Every live web LineMaterial is
// registered here; SceneManager drives `NetMeshKit.setResolution(w, h)` with the
// renderer's real drawing-buffer size on init + resize (so Retina threads aren't
// rendered at half width). The window value below is only a pre-SceneManager
// fallback. Pure-local-space rule (§1.6) preserved: this only touches material
// resolution, never any transform / world / frame state. Guarded for Node.
const _liveLineMats = new Set();
const _liveMembraneMats = new Set();
// V2 membrane env map (HDR sun disk + Earth hemisphere), baked once per renderer
// by getOrbitalFoilEnv and handed over by SceneManager. CACHED at module scope
// for the same reason `_resolution` is: SceneManager calls setEnvTexture in its
// CONSTRUCTOR, long before any net exists, so `_liveMembraneMats` is empty at
// that moment and a set-only-live-materials implementation silently reached
// nothing for the whole session (every membrane then fell back to
// scene.environment, masquerading as the intended headless path). build() reads
// this so materials created later still get the env. Stays null headless.
let _envTexture = null;
const _resolution = { w: 1, h: 1 };
if (typeof window !== 'undefined') {
  _resolution.w = window.innerWidth || 1;
  _resolution.h = window.innerHeight || 1;
}

// ── Default look (shared web vocabulary) ────────────────────────────────────
// Ivory Dyneema thread — fat-line, soft + legible (replaces the rejected cold
// 1-px cyan LineSegments).
// C0: read Constants.NET_WEB DIRECTLY — the old `|| <fallback>` defaults had
// drifted from the SSOT (WEB_COLOR, WEB_OPACITY, RADIAL_SPOKES, LINE_WIDTH_PX
// were all stale) and were an active trap for anyone reading the kit for the
// net's look (they already misled one planning pass). NET_WEB is always
// supplied by Constants; a missing key must throw loudly at import, never
// silently fall back to a made-up value.
const DEFAULT_WEB_COLOR     = NET_WEB.WEB_COLOR;
const DEFAULT_WEB_OPACITY   = NET_WEB.WEB_OPACITY;
const DEFAULT_DRAWSTRING_COLOR = 0xffaa44;
const DEFAULT_WEIGHT_COLOR  = 0xeef4ff;   // ivory tungsten edge-node glint
const DEFAULT_APEX_COLOR    = 0x665544;
const DEFAULT_APEX_RADIUS_M = 0.05;
// Fat-line web fineness (orb-weaver spoke + ring). Shared source of truth in
// Constants.NET_WEB so Mother + Daughter render the same web.
const DEFAULT_RADIAL_SPOKES = NET_WEB.RADIAL_SPOKES;
const DEFAULT_RING_COUNT    = NET_WEB.RING_COUNT;
const DEFAULT_LINE_WIDTH_PX = NET_WEB.LINE_WIDTH_PX;
const DEFAULT_NODE_ADDITIVE = NET_WEB.NODE_ADDITIVE;

/**
 * Build the orb-weaver spoke+ring web vertex positions for a single
 * THREE.LineSegments. Apex at local origin; mouth ring at z = −coneHeight,
 * radius = mouthRadius. The cone is linear (at axial fraction t: z = −coneHeight·t,
 * radius = mouthRadius·t), so radial spokes are straight apex→rim threads and
 * each ring is a polygon at fraction t. No per-frame use — construction only.
 * @returns {Float32Array}
 */
function buildWebPositions(mouthRadius, coneHeight, radialSpokes, rings) {
  const positions = [];
  // Radial spokes: apex (0,0,0) → rim point on the mouth plane.
  for (let s = 0; s < radialSpokes; s++) {
    const a = (2 * Math.PI * s) / radialSpokes;
    positions.push(0, 0, 0, Math.cos(a) * mouthRadius, Math.sin(a) * mouthRadius, -coneHeight);
  }
  // Concentric "spiral thread" rings at axial fractions t = 1/rings … 1.
  for (let k = 1; k <= rings; k++) {
    const t = k / rings;
    const z = -coneHeight * t;
    const r = mouthRadius * t;
    for (let s = 0; s < radialSpokes; s++) {
      const a0 = (2 * Math.PI * s) / radialSpokes;
      const a1 = (2 * Math.PI * (s + 1)) / radialSpokes;
      positions.push(
        Math.cos(a0) * r, Math.sin(a0) * r, z,
        Math.cos(a1) * r, Math.sin(a1) * r, z,
      );
    }
  }
  return new Float32Array(positions);
}

/**
 * Phase D.5 (mother-net-reel plan §11.5) — rebuild the web vertex positions
 * per-frame with a drape/shrink-wrap deformation. The kit's `setPositions` is
 * construction-time only; this is the per-frame update path the plan calls
 * the largest new-code item. Pure-local-space rule preserved: the deformation
 * is a function of (mouthRadius, coneHeight, drape) only — no world/frame
 * state, no group transforms.
 *
 * Three phases (driven by the consumer from the net FSM):
 *   flight  (drape ≈ 0)  — straight cone, slight cone bow at the mouth.
 *   envelop (0 < drape < 1) — the web drapes onto the debris ellipsoid: each
 *     ring's radius is pulled in toward the catch silhouette and its z is
 *     pushed forward past the mouth plane, with a decaying 2–3 Hz settle-jiggle.
 *   cinch   (drape → 1, cinchFrac 0→1) — the web shrink-wraps: rings collapse
 *     toward the closed (bunched) radius at the mouth plane.
 *
 * @param {Float32Array} out — target buffer (same length as buildWebPositions)
 * @param {object} p
 * @param {number} p.mouthRadius   open mouth radius (scene units)
 * @param {number} p.coneHeight    apex→mouth axial length (scene units)
 * @param {number} p.radialSpokes
 * @param {number} p.rings
 * @param {number} p.drape         0 = flight cone, 1 = fully draped on the catch
 * @param {number} [p.cinchFrac=0] 0 = open, 1 = bunched point (shrink-wrap)
 * @param {number} [p.jigglePhase=0] settle-jiggle phase (rad) — decaying 2–3 Hz
 * @param {number} [p.jiggleAmp=0]   settle-jiggle amplitude (scene units)
 */
// ── Drape deformation math (module-scope — defined once, no per-frame closure) ─
// P2 (visual-centerpiece plan §6): these were per-call arrow closures allocated
// inside buildWebPositionsDraped on every frame. Hoisted to module scope so the
// per-frame update path allocates nothing. Pure functions of their arguments.

// Drape profile: at drape d, a ring at axial fraction t is pulled inward by
// d·(0.45+0.55·(1−t)) and pushed forward past the mouth by d·coneHeight·(1−t)·0.9
// — the bag engulfs the catch (weights overshoot the mouth plane, matching the
// rim-weight envZ sweep in CaptureNetVisual). The settle-jiggle is a radial
// ripple, strongest at the mouth, decaying toward the apex.
// Whale-in-cone phase 3 (Task 1): drapeRingRadius / drapeRingZ are EXPORTED so
// the probe, the harness gates and the unit tests compute the SAME drawn-bag
// geometry the mesh deforms to — never a re-derived copy. Bodies unchanged.
export function drapeRingRadius(t, spokeAngle, mouthRadius, drape, cinch, closed, jigA, jigP) {
  let r = mouthRadius * t;
  if (drape > 0) {
    // Pull toward the catch silhouette: the draped radius shrinks toward
    // ~55% of open at the mouth (the catch is smaller than the 8 m mouth),
    // less toward the apex (the bag necks down behind the catch).
    const pull = drape * (0.45 + 0.55 * (1 - t));
    r *= (1 - pull * 0.45);
  }
  if (cinch > 0) {
    // Shrink-wrap: collapse every ring toward the closed radius fraction.
    r = r + (mouthRadius * closed * t - r) * cinch;
  }
  if (jigA > 0) {
    r += jigA * t * Math.sin(jigP + spokeAngle * 3);
  }
  return r;
}
export function drapeRingZ(t, coneHeight, drape) {
  let z = -coneHeight * t;
  if (drape > 0) {
    // Push the mouth-side rings forward past the mouth plane (engulf).
    z -= drape * coneHeight * (1 - t) * 0.9 * t;
  }
  return z;
}

// ── Whale-in-cone phase 3 (Task 1): shared drawn-bag geometry ───────────────
// Three more pure named exports, all scene units (matching mouthRadius /
// coneHeight). No behaviour change: they only expose and invert maths that
// already runs per frame.

/**
 * Invert drapeRingZ: which ring index t sits at `axialDepth` (scene units,
 * positive = ahead of the apex) for a given drape?  z(t) = −H·(t + k·t·(1−t))
 * with k = 0.9·drape, so with u = axialDepth/coneHeight:  k·t² − (1+k)·t + u = 0.
 * Returns the root in [0,1] (clamped); returns u directly when drape === 0.
 * Ring index t IS the depth fraction only at drape 0 — once the bag engulfs,
 * every "radius at the whale's depth" must go through this inversion.
 * @param {number} axialDepth — scene units ahead of the apex (≥ 0)
 * @param {number} coneHeight — apex→mouth axial length (scene units)
 * @param {number} drape — 0 = flight cone, 1 = fully draped
 * @returns {number} ring index t ∈ [0,1]
 */
export function depthToRingT(axialDepth, coneHeight, drape) {
  if (!(coneHeight > 0)) return 0;
  const u = Math.max(0, Math.min(1, axialDepth / coneHeight));
  const k = 0.9 * Math.max(0, Math.min(1, drape ?? 0));
  if (k === 0) return u;
  const disc = (1 + k) * (1 + k) - 4 * k * u;
  const t = ((1 + k) - Math.sqrt(Math.max(0, disc))) / (2 * k);
  return Math.max(0, Math.min(1, t));
}

/**
 * The DRAWN rim radius at a given axial depth: drapeRingRadius evaluated at
 * the ring index drapeRingZ places there. The settle-jiggle is deliberately
 * excluded — it is a ±ripple around this radius, not a systematic one.
 * Pure; scene units.
 * @param {number} axialDepth — scene units ahead of the apex (≥ 0)
 * @param {number} mouthRadius — open mouth radius (scene units)
 * @param {number} coneHeight — apex→mouth axial length (scene units)
 * @param {number} drape — 0 = flight cone, 1 = fully draped
 * @param {number} cinch — 0 = open, 1 = bunched point
 * @param {number} closedFrac — DRAWSTRING_RADIUS_FRAC_CLOSED
 * @returns {number} drawn radius (scene units)
 */
export function drawnRimRadiusAtDepth(axialDepth, mouthRadius, coneHeight, drape, cinch, closedFrac) {
  const t = depthToRingT(axialDepth, coneHeight, drape);
  return drapeRingRadius(t, 0, mouthRadius, drape, cinch, closedFrac, 0, 0);
}

/**
 * Whale-in-cone phase 3 (D2): spherical-envelope floor around the bag's
 * contents. A net wrapping a ball bulges around the ball and is free to close
 * everywhere else, so the floor is the ball's cross-section radius at z,
 * fattened by `margin`:  margin·√(Rc² − (z − zc)²)  for |z − zc| < Rc, else 0.
 * (A flat floor would balloon the apex and undo the drape's necking behind the
 * catch.) `contentsRadius` 0 — a miss / no target — floors at 0 everywhere: an
 * empty net SHOULD bunch to a point; that contrast is what sells a real catch.
 * Pure; scene units.
 * @param {number} z — ring axial position (negative = ahead of the apex)
 * @param {number} contentsZ — contents centre axial position (same frame)
 * @param {number} contentsRadius — contents rendered radius (scene units)
 * @param {number} [margin=NET_CER.CONTENTS_FLOOR_MARGIN]
 * @returns {number} floor radius (scene units), ≥ 0
 */
export function contentsFloorRadius(z, contentsZ, contentsRadius, margin = NET_CER.CONTENTS_FLOOR_MARGIN) {
  if (!(contentsRadius > 0)) return 0;
  const dz = z - contentsZ;
  const rr = contentsRadius * contentsRadius - dz * dz;
  if (rr <= 0) return 0;
  return margin * Math.sqrt(rr);
}

/**
 * v_box = R·(v_kit − c) — the ONE point transform into box space (the stored
 * rows of the contentsBox spec). Shared by contentsFloorRadiusBox (ray origin)
 * and _edgeBoxDepth (chord samples) so the floor envelope and the chord metric
 * can never desync on the rotation/origin convention (review, follow-up 4).
 * Writes the module scratch `_bs` (mutated per call, never retained — the
 * builders' per-frame path stays allocation-free, B8/P2). The DIRECTION
 * transform (R·v, no origin shift) and the corner transform (Rᵀ) stay inline
 * at their call sites — different operations, not this contract.
 */
const _bs = [0, 0, 0];
function _toBoxSpace(box, x, y, z) {
  const px = x - box.ox, py = y - box.oy, pz = z - box.oz;
  _bs[0] = box.r00 * px + box.r01 * py + box.r02 * pz;
  _bs[1] = box.r10 * px + box.r11 * py + box.r12 * pz;
  _bs[2] = box.r20 * px + box.r21 * py + box.r22 * pz;
  return _bs;
}

/**
 * Balloon→fabric (F1): oriented-BOX floor around the bag's contents. The sphere
 * above hugs the catch's bounding sphere, which is set by its extreme points
 * (the cubesat's wingtips) and floats ~0.7–1.0 m off the hull everywhere else —
 * the "translucent balloon" of the Task-6.5 verdict. The box floor settles the
 * film onto the catch's real extents, in two parts:
 *
 * 1. IN-SPAN — the spoke ray (from the bag axis at height z, horizontal along
 *    (cosA, sinA)) meets the box in box space: origin inside ⇒ margin × tExit
 *    (wrap out from the centre); origin outside and the ray hits ⇒ margin ×
 *    tEnter (drape onto the near face).
 * 2. CORNER-CONE (bicone) — when the ray MISSES, the film is past one of the
 *    box's caps, and the floor must NOT vanish: the chord from a floored wrap
 *    ring to an unfloored natural ring tunnels straight through the hull
 *    (measured up to 570 mm at the flat-cap orientation, 2026-08-06). The taut
 *    film is modelled as a cone from the apex over the box's silhouette, and
 *    an anti-cone from the drawstring (mouthZ) back to it. Each corner
 *    contributes its PROJECTED extent u = cx·cosA + cy·sinA in the spoke's
 *    vertical plane (never the 3-D radius — a revolution cone bulges past the
 *    face at the centre plane), scaled by z/z_C for deeper corners and
 *    (mouthZ−z)/(mouthZ−z_C) for shallower ones; the floor takes the max.
 *    Applied ONLY on a miss — the slab hit is the exact surface, the cone is
 *    the tent past the caps; they meet at the cap plane. The bicone contains
 *    the box from both sides, so chords can't tunnel; it reads as the gathered
 *    neck/shoulder of a real bag, and it stays per-angle honest for an
 *    off-axis box (the empty side still closes).
 *
 * The box is convex, so "film vertex radius ≥ this floor" keeps every vertex
 * outside the margined hull by construction (ring-continuous; chords between
 * vertices are the chordcheck instrument's domain). Scene units; pure; no
 * allocations.
 * @param {number} z — ring axial position in kit space (negative = ahead of the apex)
 * @param {number} cosA @param {number} sinA — spoke direction (unit, horizontal in kit space)
 * @param {object} box — {ox,oy,oz, r00…r22, hx,hy,hz}: box centre in kit space,
 *   kit→box rotation rows (v_box = R·v_kit), half extents; all scene units
 * @param {number} [margin=NET_CER.CONTENTS_FLOOR_MARGIN]
 * @param {number} [mouthZ] — kit mouth plane z (drawstring side); enables the
 *   far anti-cone. Omitted ⇒ the far cap closes freely (legacy behaviour).
 * @returns {number} floor radius (scene units), ≥ 0
 */
export function contentsFloorRadiusBox(z, cosA, sinA, box, margin = NET_CER.CONTENTS_FLOOR_MARGIN, mouthZ = null) {
  if (!contentsBoxValid(box)) return 0;
  // Ray origin: the point on the bag axis at ring height z, in box space (the
  // shared point transform — one home of the convention). Read by index, not by
  // destructuring: item 12's elbow scan calls this ~3.3k times per frame
  // (20 spokes × the coarse+refine scan), so an iterator allocation here would
  // be a per-frame allocation on the builders' path (P2/B8).
  const bs = _toBoxSpace(box, 0, 0, z);
  const ox = bs[0], oy = bs[1], oz = bs[2];
  // Spoke direction in box space.
  const dx = box.r00 * cosA + box.r01 * sinA;
  const dy = box.r10 * cosA + box.r11 * sinA;
  const dz = box.r20 * cosA + box.r21 * sinA;
  // Slab interval [tN, tF] over the three axes (enter = max of enters, exit = min of exits).
  let tN = -Infinity, tF = Infinity;
  if (dx > 1e-12 || dx < -1e-12) {
    let t1 = (-box.hx - ox) / dx, t2 = (box.hx - ox) / dx;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
    if (t1 > tN) tN = t1; if (t2 < tF) tF = t2;
  } else if (ox > box.hx || ox < -box.hx) {
    tN = Infinity; tF = -Infinity;   // parallel ray outside the slab ⇒ miss (cone below)
  }
  if (dy > 1e-12 || dy < -1e-12) {
    let t1 = (-box.hy - oy) / dy, t2 = (box.hy - oy) / dy;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
    if (t1 > tN) tN = t1; if (t2 < tF) tF = t2;
  } else if (oy > box.hy || oy < -box.hy) {
    tN = Infinity; tF = -Infinity;
  }
  if (dz > 1e-12 || dz < -1e-12) {
    let t1 = (-box.hz - oz) / dz, t2 = (box.hz - oz) / dz;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
    if (t1 > tN) tN = t1; if (t2 < tF) tF = t2;
  } else if (oz > box.hz || oz < -box.hz) {
    tN = Infinity; tF = -Infinity;
  }
  const t = (tN <= tF && tF >= 0) ? (tN > 0 ? tN : tF) : 0;   // outside → near face; inside → far face
  // Bicone: corners in KIT space (v_kit = Rᵀ·v_box — the stored rows transposed),
  // constrained in the spoke's vertical plane by their PROJECTED extent u.
  // Evaluated ONLY on a slab miss — the slab hit is the exact surface.
  if (t > 0) return margin * t;
  let cone = 0;
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        const bx = sx * box.hx, by = sy * box.hy, bz = sz * box.hz;
        const cx = box.ox + box.r00 * bx + box.r10 * by + box.r20 * bz;
        const cy = box.oy + box.r01 * bx + box.r11 * by + box.r21 * bz;
        const cz = box.oz + box.r02 * bx + box.r12 * by + box.r22 * bz;
        const u = cx * cosA + cy * sinA;
        if (u <= 0) continue;             // this corner is behind the spoke direction
        if (cz <= z && cz < -1e-12 && z < 0) {
          const v = u * (z / cz);                    // apex-side cone (both negative ⇒ ratio ∈ (0,1])
          if (v > cone) cone = v;
        } else if (cz > z && mouthZ != null && z > mouthZ && cz > mouthZ) {
          const v = u * ((mouthZ - z) / (mouthZ - cz));  // drawstring-side anti-cone
          if (v > cone) cone = v;
        }
      }
    }
  }
  return margin * cone;
}

/**
 * The contents floor the mesh actually DRAWS at one (ring z, spoke angle):
 * the box floor when a valid contentsBox is supplied, else the sphere floor;
 * the result clamped to `openConeRadius` (the ring's own open-cone radius
 * `mouthRadius·t` — Task 7: ring 0's clamp is 0 so the apex can never balloon
 * off the threads (R1), and no ring can exceed the cone the kit actually has
 * (R2)). This is the ONE home of floor + precedence + clamp: the mesh builders
 * AND the main.js probe/recorder call it, so they can never drift.
 * Pure; scene units; no allocations.
 * @param {number} z — ring axial position in kit space (negative = ahead of the apex)
 * @param {number} cosA @param {number} sinA — spoke direction
 * @param {number} openConeRadius — the cone radius at the ring's DRAPED z
 *   (`mouthRadius·(−z/H)`; `mouthRadius·t` only at drape 0), scene units
 * @param {number} contentsZ — sphere-floor centre z (kit space, scene units)
 * @param {number} contentsRadius — sphere-floor radius (scene units; 0 = no contents)
 * @param {object|null} contentsBox — box-floor spec (null/invalid ⇒ sphere path)
 * @param {number} [margin=NET_CER.CONTENTS_FLOOR_MARGIN]
 * @param {number} [mouthZ] — kit mouth plane z, forwarded to the box floor's
 *   far anti-cone (the kit and the probe both supply it; tests may omit it)
 * @returns {number} floor radius (scene units), ≥ 0
 */
export function contentsFloorClamped(z, cosA, sinA, openConeRadius, contentsZ, contentsRadius, contentsBox, margin = NET_CER.CONTENTS_FLOOR_MARGIN, mouthZ = null) {
  let f = 0;
  if (contentsBoxValid(contentsBox)) {
    f = contentsFloorRadiusBox(z, cosA, sinA, contentsBox, margin, mouthZ);
  } else if (contentsRadius > 0) {
    // F4 legacy sphere fallback — unreachable from the production drivers
    // (CaptureNetVisual always supplies a valid contentsBox whenever it
    // supplies contentsRadius; the lasso path supplies neither). Kept for the
    // Task-5/7 sphere test contract; main.js's probe fallback mirrors it.
    f = contentsFloorRadius(z, contentsZ, contentsRadius, margin);
  }
  return f > 0 ? Math.min(f, openConeRadius) : 0;
}

/**
 * Whether a contents-BOX spec is usable for the box floor (all half extents
 * positive). THE one home of the box-validity predicate — the kit builders,
 * contentsFloorClamped AND the main.js probe helper all decide box-vs-sphere
 * through it, so the floor decision can never drift between probe and mesh.
 */
export function contentsBoxValid(box) {
  return !!(box && box.hx > 0 && box.hy > 0 && box.hz > 0);
}

/**
 * Whale-in-cone follow-up 4: does the DRAWN polyline touch the catch? The
 * vertex rule (B7) keeps every lattice VERTEX outside the margined hull by
 * construction, but the mesh draws CHORDS between vertices, and a chord
 * spanning an envelope ridge sags inside it. Measured classes (plan
 * `.kilo/plans/1785984523699-chord-pierce-gate.md`, Finding 3): the
 * azimuthal-corner graze (+71.3 mm at identity rotation) and the dominant
 * MERIDIONAL cap-elbow chord (tent→slab handoff, rings 2→3; 0.243–0.583 m
 * live, harness-labile; 0.665 m over the tumble sweep — register item 12).
 * This is the ONE home of that measurement — the main.js probe (metres
 * gate) and the tmp chordcheck instrument both call it, so instrument ≡
 * gate.
 *
 * Signed inside-depth of the UNMARGINED box at samplesPerEdge points per
 * edge: depth(p) = min(hx−|px|, hy−|py|, hz−|pz|) in box space (rotation
 * rows honoured); > 0 ⇒ the drawn film is that deep INSIDE the true hull —
 * genuine contact, not margin erosion (same reference pierceM uses at the
 * whale's depth: the margin-1 surface). Sampled, not exact: a ridge maximum
 * can sit between samples (resolution ≈ edge/samplesPerEdge ≈ 1–2 cm on the
 * 6×20 lattice) — the gate's tolerance absorbs this. Membrane and thread
 * chords are the SAME lattice (vertices welded on thread intersections), so
 * one sweep covers both.
 *
 * Pure read of the positions the builders produced (the bicone tents are
 * drawn geometry ⇒ included by construction); no allocations; scene units.
 * @param {Float32Array} positions — (rings+1) × radialSpokes × 3 lattice
 *   (the handle's membranePositions — the actual drawn vertices)
 * @param {number} rings @param {number} radialSpokes — lattice topology
 * @param {object} box — the handle's stored contentsBox (kit space)
 * @param {number} [samplesPerEdge=64]
 * @returns {number|null} worst signed inside-depth (scene units), or null
 *   when no valid box is supplied (sphere-fallback / flight — the metric is
 *   box-era)
 */
export function chordBoxPenetration(positions, rings, radialSpokes, box, samplesPerEdge = 64) {
  if (!contentsBoxValid(box)) return null;
  let worst = -Infinity;
  for (let k = 0; k <= rings; k++) {
    for (let s = 0; s < radialSpokes; s++) {
      const i0 = (k * radialSpokes + s) * 3;
      const i1 = (k * radialSpokes + ((s + 1) % radialSpokes)) * 3;
      worst = _edgeBoxDepth(positions, i0, i1, box, samplesPerEdge, worst);
      if (k < rings) {
        worst = _edgeBoxDepth(positions, i0, i0 + radialSpokes * 3, box, samplesPerEdge, worst);
      }
    }
  }
  return worst;
}

/** One chord's worst signed inside-depth (module-private; see above). */
function _edgeBoxDepth(pos, i0, i1, box, n, worst) {
  const ax = pos[i0], ay = pos[i0 + 1], az = pos[i0 + 2];
  const bx = pos[i1], by = pos[i1 + 1], bz = pos[i1 + 2];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    // Sample point in box space (the shared point transform).
    const [qx, qy, qz] = _toBoxSpace(box, ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f);
    const d = Math.min(box.hx - Math.abs(qx), box.hy - Math.abs(qy), box.hz - Math.abs(qz));
    if (d > worst) worst = d;
  }
  return worst;
}

// ── Register item 12: meridional ring redistribution onto the floor's elbows ──
// Plan: .kilo/plans/1786029954098-cap-elbow-ring-redistribution.md.
//
// The cap-elbow chord class (item-4 Finding 3): the drawn film's meridional
// ring-to-ring chords straight-line the convex elbow where the apex-side tent
// hands off to the box's slab faces, cutting up to 0.666 m into the catch's
// true box while every vertex stays outside it. No floor SHAPE can fix it: the
// film is anchored at the apex (radius 0), so any envelope reaching the slab
// has a convex bend somewhere, and a straight chord of a convex bend always
// sags inside (measured and rejected: margin ≥ 1.22, per-vertex lifts, uniform
// density to 24 rings, envelope re-seaming — plan FALSIFIED table). The only
// honest lever is VERTEX PLACEMENT — and the tent (apex→near elbow) and
// anti-cone (far elbow→mouth) are each a SINGLE straight line, so they need no
// intermediate rings at all. The rings are therefore REDISTRIBUTED per spoke:
// ring 1 onto the near elbow, ring rings−1 onto the far elbow, the rest spread
// across the box's span — no drawn chord spans a convex ridge.
//
// The elbows are found by a RATIO-DEPARTURE scan of contentsFloorRadiusBox
// itself (the one home of the floor maths — nothing re-derived): the tent is a
// max of corner lines through the origin, so f(z)/z is constant on the tent;
// the anti-cone is a max of corner lines through the mouth point, so
// f(z)/(mouthZ−z) is constant there. The elbow is where the floor departs the
// ratio (the grazing dive and the slab crossing both depart). Coarse scan +
// binary refine: ~100–160 floor evaluations per spoke — per-frame affordable.

const _ELBOW_COARSE = 64;
const _ELBOW_REFINE = 16;
const _ELBOW_BAND = 0.02;              // ratio-departure tolerance (2%)
// Degenerate-span guard: a redistribution needs a span worth spreading rings
// across. 0.74% of the bag length ≈ 5 cm on the D=8 kit (coneHeight 6.8 m) —
// expressed as a FRACTION so it scales with the kit instead of hiding a
// scene-units conversion inside a magic divisor.
const _ELBOW_MIN_SPAN_FRAC = 0.0074;
// P2/B8: the elbow pair is returned in a module scratch — `_floorElbows` runs
// radialSpokes times per frame, so neither an array return nor a destructuring
// iterator may allocate there.
const _elbowScratch = new Float64Array(2);

/**
 * The two meridional elbows of the box floor at one spoke angle, written into
 * the module scratch `_elbowScratch` ([0] = near/apex-side, [1] = far/mouth-side
 * kit z; NaN when not found). Returns the scratch for convenience — never
 * retain it (mutated on the next call).
 *
 * NaN outcomes are all safe: the spoke's ray never meets the box (the empty
 * side), or the tent/anti-cone run is thinner than one coarse step so the first
 * in-floor sample already sits past the elbow. The caller then keeps that
 * spoke's natural ring z's, i.e. the pre-item-12 geometry.
 */
function _floorElbows(cosA, sinA, box, mouthZ) {
  let eN = NaN, eF = NaN;
  // Near elbow: scan apex → mouth; the tent ratio f(z)/z is constant on the tent.
  {
    let r0 = NaN, prevZ = 0;
    for (let i = 1; i <= _ELBOW_COARSE; i++) {
      const z = mouthZ * (i / _ELBOW_COARSE);
      const fz = contentsFloorRadiusBox(z, cosA, sinA, box, 1, mouthZ);
      if (fz <= 1e-9) { prevZ = z; continue; }
      const r = fz / z;
      if (Number.isNaN(r0)) { r0 = r; prevZ = z; continue; }
      if (Math.abs(r - r0) > _ELBOW_BAND * Math.abs(r0)) {
        let lo = prevZ, hi = z;                       // lo on-ratio, hi departed
        for (let j = 0; j < _ELBOW_REFINE; j++) {
          const mid = (lo + hi) / 2;
          const fm = contentsFloorRadiusBox(mid, cosA, sinA, box, 1, mouthZ);
          const rm = fm > 1e-9 ? fm / mid : r0;       // below-floor ⇒ still on the tent
          if (Math.abs(rm - r0) > _ELBOW_BAND * Math.abs(r0)) hi = mid; else lo = mid;
        }
        eN = hi;
        break;
      }
      prevZ = z;
    }
  }
  // Far elbow: scan mouth → apex; the anti-cone ratio f(z)/(mouthZ−z) is
  // constant on the anti-cone.
  {
    let r0 = NaN, prevZ = mouthZ;
    for (let i = 1; i <= _ELBOW_COARSE; i++) {
      const z = mouthZ * (1 - i / _ELBOW_COARSE);
      const fz = contentsFloorRadiusBox(z, cosA, sinA, box, 1, mouthZ);
      if (fz <= 1e-9) { prevZ = z; continue; }
      const r = fz / (mouthZ - z);
      if (Number.isNaN(r0)) { r0 = r; prevZ = z; continue; }
      if (Math.abs(r - r0) > _ELBOW_BAND * Math.abs(r0)) {
        let lo = z, hi = prevZ;                       // lo departed, hi on-ratio
        for (let j = 0; j < _ELBOW_REFINE; j++) {
          const mid = (lo + hi) / 2;
          const fm = contentsFloorRadiusBox(mid, cosA, sinA, box, 1, mouthZ);
          const rm = fm > 1e-9 ? fm / (mouthZ - mid) : r0;
          if (Math.abs(rm - r0) > _ELBOW_BAND * Math.abs(r0)) lo = mid; else hi = mid;
        }
        eF = lo;
        break;
      }
      prevZ = z;
    }
  }
  _elbowScratch[0] = eN;
  _elbowScratch[1] = eF;
  return _elbowScratch;
}

/**
 * Fill the per-handle ring-z table for one update: per (ring, spoke) z, with
 * the meridional rings redistributed onto the floor's elbows (D1). Spokes
 * whose ray never meets the box (no elbows, or a span thinner than
 * `_ELBOW_MIN_SPAN_FRAC` of the bag) keep their natural drapeRingZ z's; every
 * z is lerped from natural to redistributed BY DRAPE, so the ENVELOP
 * transition cannot pop. Ring 0 stays at the apex (R1: z = 0, clamp 0) and
 * ring `rings` stays at the mouth (R2: mouthZ = drapeRingZ(1) at every drape)
 * — both checked FIRST so no ring count can redistribute them away.
 * Reads cos/sin from the cached handle tables; writes `out` in place
 * ((rings+1) × radialSpokes, per-handle scratch — no per-frame allocation).
 */
function _ringZGrid(out, p) {
  const { coneHeight, radialSpokes, rings, contentsBox } = p;
  const drape = Math.max(0, Math.min(1, p.drape ?? 0));
  const mouthZ = -coneHeight;
  const cosA = p.cosA, sinA = p.sinA;
  const minSpan = coneHeight * _ELBOW_MIN_SPAN_FRAC;
  for (let s = 0; s < radialSpokes; s++) {
    const e = _floorElbows(cosA[s], sinA[s], contentsBox, mouthZ);
    const eN = e[0], eF = e[1];
    const redis = Number.isFinite(eN) && Number.isFinite(eF) && eN > eF + minSpan;
    for (let k = 0; k <= rings; k++) {
      const zNat = drapeRingZ(k / rings, coneHeight, drape);
      let zR = zNat;
      if (redis) {
        // R1/R2 first: the apex weld and the mouth plane are never moved, for
        // ANY ring count (a 1- or 2-ring kit must not hand the mouth to eN).
        if (k === 0) zR = 0;
        else if (k === rings) zR = mouthZ;
        else if (k === 1) zR = eN;
        else if (k === rings - 1) zR = eF;
        else zR = eN + (eF - eN) * ((k - 1) / (rings - 2));
      }
      out[k * radialSpokes + s] = zNat + (zR - zNat) * drape;
    }
  }
  return out;
}

/**
 * The single mouth-plane ring radius the contents floor demands, given that a
 * box floor varies with angle: the MAX over the spoke directions (the exact
 * angles the drawn film's vertices sit at, so nothing the film needs is
 * missed). Sphere-floor / no-contents cases collapse to the old behaviour
 * (0 whenever the contents' far face is short of the mouth plane).
 * Module-scope, allocation-free; reads the handle's stored contents fields.
 */
function _mouthFloorMax(h) {
  const cR = h._contentsR ?? 0;
  const cB = h._contentsBox ?? null;
  if (!(cR > 0) && !contentsBoxValid(cB)) return 0;
  const cZ = h._contentsZ ?? 0;
  let f = 0;
  for (let s = 0; s < h.radialSpokes; s++) {
    const v = contentsFloorClamped(h._mouthZ, h._cosA[s], h._sinA[s], h.mouthRadius, cZ, cR, cB, NET_CER.CONTENTS_FLOOR_MARGIN, h._mouthZ);
    if (v > f) f = v;
  }
  return f;
}

function buildWebPositionsDraped(out, p) {
  const { mouthRadius, coneHeight, radialSpokes, rings } = p;
  const drape = Math.max(0, Math.min(1, p.drape ?? 0));
  const cinch = Math.max(0, Math.min(1, p.cinchFrac ?? 0));
  const jigP = p.jigglePhase ?? 0;
  const jigA = p.jiggleAmp ?? 0;
  const closed = NET_CER.DRAWSTRING_RADIUS_FRAC_CLOSED;   // SSOT (was hardcoded 0.15)
  // Whale-in-cone phase 3 (D2): floor the drawn bag on a spherical envelope
  // around its contents, so the cinch tightens ONTO the catch and stops
  // instead of closing to 0.27 m regardless. Drape-gated: during FLIGHT the
  // catch is not in the bag and a floor would inflate the flight cone.
  // Balloon→fabric (F1): a valid contentsBox takes precedence — the film then
  // floors on the catch's REAL oriented box per (ring, spoke), which is what
  // kills the balloon silhouette.
  const contentsR = p.contentsRadius ?? 0;
  const contentsZ = p.contentsZ ?? 0;
  const contentsBox = p.contentsBox ?? null;
  const floorOn = drape > 0 && (contentsR > 0 || contentsBoxValid(contentsBox));
  // P2: per-spoke cos/sin/angle are fixed for the life of the handle (radialSpokes
  // never changes), so the consumer passes cached tables in. When absent (a test
  // calling this directly), fall back to computing them — correctness over speed.
  const cosA = (p.cosA && p.cosA.length === radialSpokes) ? p.cosA : null;
  const sinA = (p.sinA && p.sinA.length === radialSpokes) ? p.sinA : null;
  const angA = (p.angA && p.angA.length === radialSpokes) ? p.angA : null;
  let idx = 0;

  // Radial spokes: apex → rim (t = 1; the drape z-term vanishes at the mouth).
  const zRim = drapeRingZ(1, coneHeight, drape);
  // D2/F1: the floor at the RIM's z (not a ring z) — evaluates to 0 whenever the
  // contents' far face is short of the mouth plane, so the drawstring still
  // closes; structural insurance against a deeper catch. Per-spoke (the box
  // floor varies with angle). The open-cone clamp lives in contentsFloorClamped
  // (at the rim it clamps to mouthRadius — an oversized catch can never inflate
  // the bag past its own mouth, Task 7 R2).
  for (let s = 0; s < radialSpokes; s++) {
    const a  = angA ? angA[s] : (2 * Math.PI * s) / radialSpokes;
    const ca = cosA ? cosA[s] : Math.cos(a);
    const sa = sinA ? sinA[s] : Math.sin(a);
    const rimFloor = floorOn
      ? contentsFloorClamped(zRim, ca, sa, mouthRadius, contentsZ, contentsR, contentsBox, NET_CER.CONTENTS_FLOOR_MARGIN, -coneHeight)
      : 0;
    const r = Math.max(
      drapeRingRadius(1, a, mouthRadius, drape, cinch, closed, jigA, jigP),
      rimFloor);
    out[idx++] = 0; out[idx++] = 0; out[idx++] = 0;
    out[idx++] = ca * r; out[idx++] = sa * r; out[idx++] = zRim;
  }
  // Rings.
  const ringZ = p.ringZ ?? null;   // item 12: redistributed per-(ring,spoke) z (box floor on)
  for (let k = 1; k <= rings; k++) {
    const t = k / rings;
    const z = drapeRingZ(t, coneHeight, drape);
    // Task 7 (R1/R2) + balloon→fabric: the floor clamps to the cone radius at
    // the ring's DRAPED z (mouthRadius·(−z/H) = mouthRadius·t·(1+0.9·d·(1−t)))
    // — the cone the kit actually has at that z. Ring 0's clamp is still 0, so
    // the apex can never balloon off the threads (R1); at t = 1 it is exactly
    // mouthRadius, so no ring exceeds the kit's own mouth (R2); and at drape 0
    // it reduces to Task 7's mouthRadius·t. (The bare mouthRadius·t form was
    // TIGHTER than the true cone under drape — it clipped a contained catch's
    // hull corner at the 4.22 m seat, measured pierceM +0.095 on 2026-08-05.)
    const openCone = mouthRadius * (-z / coneHeight);
    for (let s = 0; s < radialSpokes; s++) {
      const s1 = (s + 1) % radialSpokes;
      const a0 = angA ? angA[s]  : (2 * Math.PI * s) / radialSpokes;
      // a1 is spoke s+1; its jiggle phase (a1·3) is 2π·3-periodic, so the wrapped
      // index (angle 0 for the seam spoke) yields the identical sine as 2π.
      const a1 = angA ? angA[s1] : (2 * Math.PI * (s + 1)) / radialSpokes;
      const c0 = cosA ? cosA[s]  : Math.cos(a0);
      const n0 = sinA ? sinA[s]  : Math.sin(a0);
      const c1 = cosA ? cosA[s1] : Math.cos(a1);
      const n1 = sinA ? sinA[s1] : Math.sin(a1);
      // Item 12: per-spoke z (the elbow redistribution) with the clamp at each
      // vertex's OWN z — identical rule, per-spoke arguments. The ring slides
      // ALONG the drape surface, so the natural radius follows the ring's own
      // z: t' = the natural-ring t at that depth (identity when ringZ is null).
      const z0 = ringZ ? ringZ[k * radialSpokes + s]  : z;
      const z1 = ringZ ? ringZ[k * radialSpokes + s1] : z;
      const t0 = ringZ ? depthToRingT(-z0, coneHeight, drape) : t;
      const t1 = ringZ ? depthToRingT(-z1, coneHeight, drape) : t;
      const open0 = ringZ ? mouthRadius * (-z0 / coneHeight) : openCone;
      const open1 = ringZ ? mouthRadius * (-z1 / coneHeight) : openCone;
      const f0 = floorOn ? contentsFloorClamped(z0, c0, n0, open0, contentsZ, contentsR, contentsBox, NET_CER.CONTENTS_FLOOR_MARGIN, -coneHeight) : 0;
      const f1 = floorOn ? contentsFloorClamped(z1, c1, n1, open1, contentsZ, contentsR, contentsBox, NET_CER.CONTENTS_FLOOR_MARGIN, -coneHeight) : 0;
      const r0 = Math.max(drapeRingRadius(t0, a0, mouthRadius, drape, cinch, closed, jigA, jigP), f0);
      const r1 = Math.max(drapeRingRadius(t1, a1, mouthRadius, drape, cinch, closed, jigA, jigP), f1);
      out[idx++] = c0 * r0; out[idx++] = n0 * r0; out[idx++] = z0;
      out[idx++] = c1 * r1; out[idx++] = n1 * r1; out[idx++] = z1;
    }
  }
  return out;
}

/** Membrane triangle index buffer for a (rings+1) × radialSpokes lattice.
 *  Module-scope so build() shares it. */
function buildMembraneIndex(radialSpokes, rings) {
  const memIndex = [];
  for (let k = 0; k < rings; k++) {
    for (let s = 0; s < radialSpokes; s++) {
      const s1 = (s + 1) % radialSpokes;
      const a = k * radialSpokes + s, b = k * radialSpokes + s1;
      const c = (k + 1) * radialSpokes + s, d = (k + 1) * radialSpokes + s1;
      memIndex.push(a, c, b, b, c, d);
    }
  }
  return memIndex;
}

/**
 * V2 — membrane lattice rebuild (the lit film UNDER the threads). Uses the
 * same `drapeRingRadius` / `drapeRingZ` pure functions and exactly
 * (rings + 1) × radialSpokes vertices so membrane vertices land ON thread
 * intersections: the jiggle term is `jigA · t · sin(jigP + spokeAngle·3)`, so
 * sampling at any other angular resolution makes the membrane crawl out from
 * under the threads. Module-scope (allocation invariant); writes `out` in
 * place. Ring k = axial fraction t = k/rings; ring 0 collapses to the apex.
 *
 * @param {Float32Array} out — (rings + 1) × radialSpokes × 3
 * @param {object} p — same params object as buildWebPositionsDraped
 */
function updateMembraneLattice(out, p) {
  const { mouthRadius, coneHeight, radialSpokes, rings } = p;
  const drape = Math.max(0, Math.min(1, p.drape ?? 0));
  const cinch = Math.max(0, Math.min(1, p.cinchFrac ?? 0));
  const jigP = p.jigglePhase ?? 0;
  const jigA = p.jiggleAmp ?? 0;
  const closed = NET_CER.DRAWSTRING_RADIUS_FRAC_CLOSED;
  // V8: contact compression — an inward dent where the catch presses into the
  // bag, peaked at the catch's seat (p.contactT, default ¾ toward the mouth)
  // and scaled by the same drape parameter driving ENVELOP.
  const compressM = p.compressM ?? 0;
  const contactT = p.contactT ?? 0.75;
  // Whale-in-cone phase 3 (D2): same contents floor as the threads, applied
  // AFTER the compression dent so the floor always wins — the film can dent
  // toward the catch but never through it. Drape-gated like the web path.
  // Balloon→fabric (F1): box floor per (ring, spoke) when a contentsBox rides
  // along — the film wraps the catch's real extents, not its bounding sphere.
  const contentsR = p.contentsRadius ?? 0;
  const contentsZ = p.contentsZ ?? 0;
  const contentsBox = p.contentsBox ?? null;
  const floorOn = drape > 0 && (contentsR > 0 || contentsBoxValid(contentsBox));
  const cosA = (p.cosA && p.cosA.length === radialSpokes) ? p.cosA : null;
  const sinA = (p.sinA && p.sinA.length === radialSpokes) ? p.sinA : null;
  const angA = (p.angA && p.angA.length === radialSpokes) ? p.angA : null;
  const ringZ = p.ringZ ?? null;   // item 12: same per-(ring,spoke) z as the web (the weld)
  let idx = 0;
  for (let k = 0; k <= rings; k++) {
    const t = k / rings;
    const zNat = drapeRingZ(t, coneHeight, drape);
    // Task 7 (R1): same open-cone clamp as the web path (inside
    // contentsFloorClamped) — the cone radius at the ring's DRAPED z. Ring 0's
    // clamp is 0, so the membrane apex stays welded to the spoke apex even when
    // the contents envelope peaks at z = 0 (the REELING/BERTHED co-location).
    const openCone = mouthRadius * (-zNat / coneHeight);
    for (let s = 0; s < radialSpokes; s++) {
      const a  = angA ? angA[s] : (2 * Math.PI * s) / radialSpokes;
      const ca = cosA ? cosA[s] : Math.cos(a);
      const sa = sinA ? sinA[s] : Math.sin(a);
      const z = ringZ ? ringZ[k * radialSpokes + s] : zNat;
      const openK = ringZ ? mouthRadius * (-z / coneHeight) : openCone;
      // Item 12: the ring slides along the drape surface — the natural radius
      // and the V8 dent follow the ring's own z (t' = the natural-ring t at
      // that depth; identity when ringZ is null).
      const tK = ringZ ? depthToRingT(-z, coneHeight, drape) : t;
      let r = drapeRingRadius(tK, a, mouthRadius, drape, cinch, closed, jigA, jigP);
      if (compressM > 0 && drape > 0) {
        const g = (tK - contactT) / 0.18;
        r = Math.max(0, r - drape * compressM * Math.exp(-g * g));
      }
      if (floorOn) r = Math.max(r, contentsFloorClamped(z, ca, sa, openK, contentsZ, contentsR, contentsBox, NET_CER.CONTENTS_FLOOR_MARGIN, -coneHeight));
      out[idx++] = ca * r; out[idx++] = sa * r; out[idx++] = z;
    }
  }
  return out;
}

export const NetMeshKit = {
  /**
   * Build a net-mesh handle. Apex at local origin, mouth along local −Z.
   *
   * @param {object} opts
   * @param {number} opts.diameter            logical mouth diameter (m)
   * @param {number} [opts.weightCount=4]      edge-node count (0 = none)
   * @param {number} [opts.weightRadiusM]      node sphere radius (m)
   * @param {number} [opts.coneOpenRadiusFrac] mouth radius / (D/2)
   * @param {number} [opts.coneLengthFrac]     apex→mouth axial length / (D/2)
   * @param {number} [opts.closedRadiusFrac]   cinch radius / open radius
   * @param {number} [opts.radialSpokes]       fat-line web fineness (radial threads)
   * @param {number} [opts.rings]              concentric ring count
   * @param {number} [opts.lineWidth]          fat-line thread width (screen px)
   * @param {boolean} [opts.nodeAdditive]      additive-blend glint for the edge nodes
   * @param {number} [opts.color]              base web colour (hex)
   * @param {number} [opts.opacity]            base web opacity (cone + nodes + apex)
   * @param {number} [opts.drawstringOpacity=0.8] drawstring line opacity
   * @param {boolean} [opts.weightTransparent=false] make node material fade-able
   * @param {boolean} [opts.apexTransparent=false]   make apex-hub material fade-able
   * @param {boolean} [opts.childrenVisible=false]   initial visibility of all meshes
   * @param {number} [opts.apexHubRadiusM]     apex-hub sphere radius (m)
   * @returns {object} handle
   */
  build(opts = {}) {
    const {
      diameter,
      weightCount = 4,
      weightRadiusM = NET_CER.RIM_WEIGHT_RENDER_RADIUS_M,
      coneOpenRadiusFrac = NET_CER.CONE_OPEN_RADIUS_FRAC,
      coneLengthFrac = NET_CER.CONE_LENGTH_FRAC,
      closedRadiusFrac = NET_CER.DRAWSTRING_RADIUS_FRAC_CLOSED,
      radialSpokes = DEFAULT_RADIAL_SPOKES,
      rings = DEFAULT_RING_COUNT,
      lineWidth = DEFAULT_LINE_WIDTH_PX,
      nodeAdditive = DEFAULT_NODE_ADDITIVE,
      color = DEFAULT_WEB_COLOR,
      opacity = DEFAULT_WEB_OPACITY,
      drawstringOpacity = 0.8,
      weightTransparent = false,
      apexTransparent = false,
      childrenVisible = false,
      apexHubRadiusM = DEFAULT_APEX_RADIUS_M,
      membraneOpacity = NET_WEB.MEMBRANE_OPACITY,
      membraneRoughness = NET_WEB.MEMBRANE_ROUGHNESS,
      membraneTransmission = NET_WEB.MEMBRANE_TRANSMISSION,
      membraneSheen = NET_WEB.MEMBRANE_SHEEN,
      membraneEnvIntensity = NET_WEB.MEMBRANE_ENV_INTENSITY,
    } = opts;

    const D = diameter || 8;
    const group = new THREE.Group();
    group.name = 'NetMeshKit';

    // ── Spoke + ring "web" (apex at origin, mouth ring at local −Z) ──
    // Fat-line orb-weaver web: radial spokes + concentric rings rendered as a
    // LineSegments2 + LineMaterial (three/addons/lines), so the threads carry
    // real screen-space width + built-in AA — the fix for the rejected cold
    // 1-px aliased GL line. The envelope (mouthRadius / coneHeight) is identical
    // to the old wireframe, so every consumer animation + invariant holds.
    // Threads are flat-translucent (NormalBlending, no depth write) so the web
    // reveals the catch through it without occluding or harsh additive glint.
    const mouthRadius = M * (D / 2) * coneOpenRadiusFrac;
    const coneHeight  = mouthRadius * 2 * coneLengthFrac;
    const webPositions = buildWebPositions(mouthRadius, coneHeight, radialSpokes, rings);
    const webGeo = new LineSegmentsGeometry();
    webGeo.setPositions(webPositions);
    // V4: per-thread vertex colours for view-depth shading (the far side of the
    // bag recedes) — depthWrite stays false by design. Seeded white; written in
    // place per frame from the kit-LOCAL camera position (the kit stays pure
    // local-space: the consumer world→local transforms the camera and passes it
    // in as data, like the cached trig tables).
    webGeo.setColors(new Float32Array(webPositions.length).fill(1));
    const coneMat = new LineMaterial({
      color,
      transparent: true,
      opacity,
      linewidth: lineWidth,    // screen-space pixels (worldUnits:false)
      worldUnits: false,
      vertexColors: true,
      dashed: false,
      alphaToCoverage: false,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
    coneMat.resolution.set(_resolution.w, _resolution.h);
    _liveLineMats.add(coneMat);
    const coneMesh = new LineSegments2(webGeo, coneMat);
    coneMesh.name = 'cone';
    coneMesh.visible = childrenVisible;
    coneMesh.frustumCulled = false;   // scaled per-frame; avoid stale-bounds cull
    coneMesh.renderOrder = 1;         // threads render OVER the membrane film
    group.add(coneMesh);

    // ── V2 lit membrane (the hybrid web): a drape-driven film UNDER the threads ──
    // A MeshPhysicalMaterial (roughness/sheen/low transmission, DoubleSide) so the
    // bag responds to sun + earthshine — the spike's unlit ShaderMaterial could
    // never satisfy that (plan V2). Inherits the threads' reveal rule:
    // transparent + depthWrite:false, so the catch reads through it. Driven by the
    // same drapeRingRadius/drapeRingZ pure functions at exactly
    // (rings+1) × radialSpokes so membrane vertices land ON thread intersections
    // (the jiggle term is a function of t and spokeAngle — any other resolution
    // crawls out from under the threads). envMap arrives via setEnvTexture (null
    // headless → scene.environment applies). Positions + normals are written in
    // place per frame — no per-frame allocations.
    const membranePositions = new Float32Array((rings + 1) * radialSpokes * 3);
    const membraneGeo = new THREE.BufferGeometry();
    membraneGeo.setAttribute('position', new THREE.BufferAttribute(membranePositions, 3));
    membraneGeo.setIndex(buildMembraneIndex(radialSpokes, rings));
    const membraneMat = new THREE.MeshPhysicalMaterial({
      color,
      transparent: true,
      opacity: membraneOpacity,
      roughness: membraneRoughness,
      transmission: membraneTransmission,
      sheen: membraneSheen,
      side: THREE.DoubleSide,
      depthWrite: false,
      envMapIntensity: membraneEnvIntensity,
      // Null until SceneManager has handed over the baked orbital env (and null
      // for good headless) — three.js treats a null envMap as "use
      // scene.environment", which is the intended fallback.
      envMap: _envTexture,
    });
    _liveMembraneMats.add(membraneMat);
    const membraneMesh = new THREE.Mesh(membraneGeo, membraneMat);
    membraneMesh.name = 'membrane';
    membraneMesh.visible = childrenVisible;
    membraneMesh.frustumCulled = false;   // deforms per-frame; avoid stale-bounds cull
    membraneMesh.renderOrder = 0;         // film UNDER the threads
    group.add(membraneMesh);
    // Seed the static flight cone and allocate the normal attribute once — the
    // per-frame computeVertexNormals in updateWebDrape then writes in place.
    updateMembraneLattice(membranePositions, { mouthRadius, coneHeight, radialSpokes, rings });
    membraneGeo.attributes.position.needsUpdate = true;
    membraneGeo.computeVertexNormals();

    // ── Rim weight spheres (tungsten edge-node glints) ──
    // Weights sit at the mouth plane (z = −coneHeight) at the open radius. Ivory
    // emissive glints (canon §2.6 edge nodes) — tiny, lead the unfurl + cinch.
    const mouthZ = -coneHeight;
    const weightGeo = (weightCount > 0)
      ? new THREE.SphereGeometry(M * weightRadiusM, 8, 8)
      : null;
    const rimWeights = [];
    const rimWeightMats = [];
    const rimAngles = [];
    for (let i = 0; i < weightCount; i++) {
      const angle = (2 * Math.PI * i) / weightCount;
      const mat = new THREE.MeshStandardMaterial({
        color: DEFAULT_WEIGHT_COLOR,
        metalness: 0.4,
        roughness: 0.25,
        emissive: new THREE.Color(DEFAULT_WEIGHT_COLOR),
        // SSOT (C0): the same resting glint V6's flash ramps away from and back
        // to. This was a duplicated `0.6` literal that happened to agree with
        // the constant — the exact drift trap C0 deleted elsewhere in this file,
        // and it is the ONLY value the non-draping lasso net's nodes ever show.
        emissiveIntensity: NET_WEB.NODE_EMISSIVE_BASE,
        transparent: weightTransparent,
        opacity,
        blending: nodeAdditive ? THREE.AdditiveBlending : THREE.NormalBlending,
        depthWrite: !nodeAdditive,
      });
      const w = new THREE.Mesh(weightGeo, mat);
      w.name = `weight_${i}`;
      w.visible = childrenVisible;
      w.position.set(Math.cos(angle) * mouthRadius, Math.sin(angle) * mouthRadius, mouthZ);
      rimWeights.push(w);
      rimWeightMats.push(mat);
      rimAngles.push(angle);
      group.add(w);
    }

    // ── Drawstring — spoke pattern: apex→w0→apex→w1→…→apex→wN-1→apex→w0 ──
    const dsVertexCount = weightCount * 2 + 2;
    const drawstringPositions = new Float32Array(dsVertexCount * 3);
    const drawstringGeo = new THREE.BufferGeometry();
    drawstringGeo.setAttribute('position', new THREE.BufferAttribute(drawstringPositions, 3));
    const drawstringMat = new THREE.LineBasicMaterial({
      color: DEFAULT_DRAWSTRING_COLOR,
      transparent: true,
      opacity: drawstringOpacity,
    });
    const drawstringLine = new THREE.Line(drawstringGeo, drawstringMat);
    drawstringLine.name = 'drawstring';
    drawstringLine.visible = childrenVisible;
    drawstringLine.frustumCulled = false;
    group.add(drawstringLine);

    // ── Apex hub — small sphere at tether termination ──
    const apexGeo = new THREE.SphereGeometry(M * apexHubRadiusM, 8, 8);
    const apexMat = new THREE.MeshStandardMaterial({
      color: DEFAULT_APEX_COLOR,
      metalness: 0.7,
      roughness: 0.4,
      transparent: apexTransparent,
      opacity,
    });
    const apexHub = new THREE.Mesh(apexGeo, apexMat);
    apexHub.name = 'apexHub';
    apexHub.visible = childrenVisible;
    group.add(apexHub);

    // P2: cache per-spoke cos/sin/angle once (radialSpokes is fixed for the life
    // of the handle), so the per-frame drape rebuild does no projection trig.
    const _cosA = new Float32Array(radialSpokes);
    const _sinA = new Float32Array(radialSpokes);
    const _angA = new Float32Array(radialSpokes);
    for (let s = 0; s < radialSpokes; s++) {
      const a = (2 * Math.PI * s) / radialSpokes;
      _angA[s] = a; _cosA[s] = Math.cos(a); _sinA[s] = Math.sin(a);
    }

    // P1: `webPositions` IS the backing store of the web's instanced-interleaved
    // buffer (LineSegmentsGeometry.setPositions wrapped it at construction — no
    // copy), so the per-frame drape path writes it in place and flags this buffer
    // dirty instead of re-running setPositions (which reallocates the buffer, both
    // interleaved attributes, and both bounding volumes every frame).
    const webBuffer = coneMesh.geometry.attributes.instanceStart.data;
    // V4: same in-place pattern for the vertex-colour buffer (setColors wrapped
    // the seed array at construction; instanceColorStart/End share one buffer).
    const webColorBuffer = coneMesh.geometry.attributes.instanceColorStart.data;

    const handle = {
      group,
      coneMesh,
      webLines: coneMesh,   // alias — the cone IS the fat-line spoke+ring web
      webPositions,         // raw Float32Array of web segment endpoints (apex→rim + rings)
      webBuffer,            // InstancedInterleavedBuffer whose .array === webPositions
      webColorBuffer,       // vertex-colour buffer (V4 depth shading), same layout
      lineMaterial: coneMat, // the web's LineMaterial (resolution-synced)
      membraneMesh,
      membraneMat,
      membranePositions,    // (rings+1) × radialSpokes × 3, written in place per frame
      // Membrane opacity as a fraction of the WEB's canonical full opacity, so
      // setOpacity(o) fades the film proportionally (o × this) instead of
      // slamming it to the thread value.
      _membraneOpacityFrac: membraneOpacity / Math.max(1e-9, DEFAULT_WEB_OPACITY),
      rimWeights,
      rimWeightMats,
      weightGeo,
      drawstringLine,
      drawstringPositions,
      apexHub,
      // params consumers' animation needs
      mouthRadius,
      coneHeight,
      closedRadius: mouthRadius * closedRadiusFrac,
      weightCount,
      radialSpokes,
      rings,
      // kit-internal layout state (used by setMouthFraction / setSpinAngle)
      _rimAngles: rimAngles,
      _mouthZ: mouthZ,
      _spinAngle: 0,
      // Phase D.5 drape state (per-frame update path)
      _drape: 0,
      _cinchFrac: 0,
      _jigglePhase: 0,
      _jiggleAmp: 0,
      _flashPeakT: null,   // V6: wall-clock when cinchFrac first reached 0.85
      _contactFlashT: null, // V8: wall-clock of the drape's rising edge (first touch)
      _drapePrev: 0,       // V8: previous frame's drape (rising-edge detect)
      // P2: cached per-spoke trig (projection is fixed; only jiggle recomputes)
      _cosA,
      _sinA,
      _angA,
      // Item 12: per-(ring,spoke) ring-z scratch for the elbow redistribution —
      // allocated once, refilled per updateWebDrape, read by BOTH builders (the
      // membrane/thread weld consumes the identical z's by construction).
      _ringZ: new Float32Array((rings + 1) * radialSpokes),
    };

    // Seed the drawstring from the initial rim layout.
    if (weightCount > 0) this.updateDrawstring(handle);

    return handle;
  },

  /**
   * Set the net MOUTH radius as a fraction of the full open radius — the
   * parameterized open / cinch animation (Mother). Scales the rim nodes' XY and
   * the cone's XY, keeping the apex + axial length; rebuilds the drawstring.
   * @param {object} h handle
   * @param {number} frac mouth radius fraction in [0.05, 1]
   */
  setMouthFraction(h, frac) {
    const f = Math.max(0.05, Math.min(1, frac));
    // Whale-in-cone phase 3 (D2): never place the rim inside the contents
    // envelope. Evaluates to 0 whenever the contents are absent or their far
    // face is short of the mouth plane — structural insurance, not a behaviour
    // change for the lasso path (which never sets _contentsR).
    // Task 7 (R2): clamp to the mouth plane's own open radius (inside
    // contentsFloorClamped) — the rim can never be floored past the mouth the
    // kit actually has. F1: max over the spoke angles (a box floor varies
    // with angle; the ring must clear every one).
    const r = Math.max(h.mouthRadius * f, _mouthFloorMax(h));
    for (let i = 0; i < h.weightCount; i++) {
      const a = h._rimAngles[i] + h._spinAngle;
      h.rimWeights[i].position.set(Math.cos(a) * r, Math.sin(a) * r, h._mouthZ);
    }
    if (h.coneMesh) h.coneMesh.scale.set(f, f, 1);
    if (h.membraneMesh) h.membraneMesh.scale.set(f, f, 1);
    if (h.weightCount > 0) this.updateDrawstring(h);
  },

  /**
   * Tint the web (+ optional node emissive stays untouched). Sets the cone
   * colour; leaves drawstring/hub at their fixed hues.
   * @param {object} h handle
   * @param {number} hex colour
   */
  setColor(h, hex) {
    if (h.coneMesh && h.coneMesh.material) h.coneMesh.material.color.setHex(hex);
    if (h.membraneMat) h.membraneMat.color.setHex(hex);
  },

  /**
   * Set opacity on the web cone + drawstring, and on the (fade-able) nodes +
   * apex hub. Materials built non-transparent (e.g. the daughter's opaque nodes
   * / hub) are left untouched, since opacity has no render effect there.
   * @param {object} h handle
   * @param {number} o opacity
   */
  setOpacity(h, o) {
    if (h.coneMesh && h.coneMesh.material) h.coneMesh.material.opacity = o;
    if (h.membraneMat) h.membraneMat.opacity = o * h._membraneOpacityFrac;
    if (h.drawstringLine && h.drawstringLine.material) h.drawstringLine.material.opacity = o;
    for (const mat of h.rimWeightMats) { if (mat.transparent) mat.opacity = o; }
    if (h.apexHub && h.apexHub.material && h.apexHub.material.transparent) {
      h.apexHub.material.opacity = o;
    }
  },

  /**
   * Rotate the web about its local Z axis by repositioning the rim nodes (used
   * when the consumer drives spin per-node rather than via the group quaternion).
   * @param {object} h handle
   * @param {number} angle radians
   */
  setSpinAngle(h, angle) {
    h._spinAngle = angle;
    const r = Math.hypot(
      h.weightCount > 0 ? h.rimWeights[0].position.x : 0,
      h.weightCount > 0 ? h.rimWeights[0].position.y : 0,
    ) || h.mouthRadius;
    for (let i = 0; i < h.weightCount; i++) {
      const a = h._rimAngles[i] + angle;
      h.rimWeights[i].position.set(Math.cos(a) * r, Math.sin(a) * r, h.rimWeights[i].position.z);
    }
    if (h.weightCount > 0) this.updateDrawstring(h);
  },

  /**
   * Render the rim nodes + drawstring as a STATIC fully-cinched ring at the
   * closed radius on the mouth plane (frozen, no spin advance).
   * @param {object} h handle
   */
  setCinchedRim(h) {
    // Whale-in-cone phase 3 (D2): floor the cinched ring at the contents
    // envelope evaluated on the mouth plane. For the ceremony geometry the
    // whale's far face stops short of the mouth, so this evaluates to 0 and the
    // ring still closes to closedRadius — structural, not lucky.
    // Task 7 (R2): clamp to mouthRadius (inside contentsFloorClamped) — the
    // cinched rim can never be held open past the kit's own mouth by an
    // oversized catch. F1: max over the spoke angles (box floor).
    const r = Math.max(h.closedRadius, _mouthFloorMax(h));
    for (let i = 0; i < h.weightCount; i++) {
      const a = h._rimAngles[i] + h._spinAngle;
      h.rimWeights[i].position.set(
        Math.cos(a) * r,
        Math.sin(a) * r,
        h._mouthZ,
      );
    }
    if (h.weightCount > 0) this.updateDrawstring(h);
  },

  /**
   * Rebuild drawstring vertex positions from current rim-node positions.
   * Spoke pattern: apex→w0→apex→w1→…→apex→wN-1→apex→w0. No allocations.
   * @param {object} h handle
   */
  updateDrawstring(h) {
    const { rimWeights, drawstringPositions, drawstringLine, weightCount } = h;
    if (weightCount <= 0) return;
    let idx = 0;
    for (let i = 0; i < weightCount; i++) {
      drawstringPositions[idx++] = 0;
      drawstringPositions[idx++] = 0;
      drawstringPositions[idx++] = 0;
      drawstringPositions[idx++] = rimWeights[i].position.x;
      drawstringPositions[idx++] = rimWeights[i].position.y;
      drawstringPositions[idx++] = rimWeights[i].position.z;
    }
    drawstringPositions[idx++] = 0;
    drawstringPositions[idx++] = 0;
    drawstringPositions[idx++] = 0;
    drawstringPositions[idx++] = rimWeights[0].position.x;
    drawstringPositions[idx++] = rimWeights[0].position.y;
    drawstringPositions[idx++] = rimWeights[0].position.z;
    drawstringLine.geometry.attributes.position.needsUpdate = true;
  },

  /**
   * Explicitly set the fat-line resolution (px) for all live web materials.
   * Optional — the kit already syncs on window resize. Consumers with a custom
   * render target (or tests) may call this directly. Pure-local-space safe.
   * @param {number} w viewport width px
   * @param {number} h viewport height px
   */
  setResolution(w, hgt) {
    if (w > 0 && hgt > 0) {
      _resolution.w = w; _resolution.h = hgt;
      for (const m of _liveLineMats) m.resolution.set(w, hgt);
    }
  },

  /**
   * Register an external fat-line LineMaterial (e.g. a tether) so it shares the
   * web's resolution sync. Seeds it with the current resolution immediately.
   * @param {import('three/addons/lines/LineMaterial.js').LineMaterial} mat
   */
  registerLineMaterial(mat) {
    if (mat) { mat.resolution.set(_resolution.w, _resolution.h); _liveLineMats.add(mat); }
  },

  /**
   * V2: apply the synthetic orbital env texture (sun disk + Earth hemisphere,
   * baked once per renderer by getOrbitalFoilEnv) to every live membrane
   * material, AND cache it so membranes built later get it too. That cache is
   * the load-bearing part: SceneManager calls this from its constructor, before
   * any net has been built, so the live-material loop alone reached zero
   * materials and the env never applied in a real session. Null/undefined is a
   * no-op — headless builds leave envMap null and scene.environment applies
   * instead. Mirrors setResolution / `_resolution`.
   * @param {THREE.Texture|null} tex
   */
  setEnvTexture(tex) {
    if (!tex) return;
    _envTexture = tex;
    for (const m of _liveMembraneMats) { m.envMap = tex; m.needsUpdate = true; }
  },

  /** Stop syncing a previously-registered LineMaterial (call on dispose). */
  unregisterLineMaterial(mat) {
    if (mat) _liveLineMats.delete(mat);
  },

  /**
   * Phase D.5 (mother-net-reel plan §11.5) — per-frame drape/shrink-wrap
   * update. Rebuilds the web vertex positions from the drape state and pushes
   * them into the fat-line geometry.
   *
   * P1 (visual-centerpiece plan §6): fully allocation-free. `h.webPositions` is
   * the backing `.array` of the instanced-interleaved buffer captured at build
   * (`h.webBuffer`), so we write it in place and flag the buffer dirty. This
   * replaces the old `geometry.setPositions(webPositions)` call, which allocated
   * a fresh `InstancedInterleavedBuffer` + two `InterleavedBufferAttribute`s and
   * recomputed both bounding volumes on every frame. Frustum culling is unaffected
   * because `coneMesh.frustumCulled = false` (set at build) — the dropped
   * per-frame `computeBoundingSphere()` would otherwise be required for culling.
   *
   * @param {object} h handle
   * @param {object} drapeState
   * @param {number} drapeState.drape       0 = flight cone, 1 = draped on catch
   * @param {number} [drapeState.cinchFrac] 0 = open, 1 = bunched point
   * @param {number} [drapeState.jigglePhase] settle-jiggle phase (rad)
   * @param {number} [drapeState.jiggleAmp]   settle-jiggle amplitude (scene units)
   * @param {number} [drapeState.contentsRadius] whale-in-cone D2 — rendered
   *   radius of the bag's contents (scene units). The drawn web + membrane floor
   *   on a spherical envelope around the contents (contentsFloorRadius) once
   *   drape > 0, so the cinch tightens ONTO the catch and stops. 0 = no
   *   contents (a miss still bunches to a point — that contrast sells a catch).
   * @param {number} [drapeState.contentsZ] contents centre in kit-local z
   *   (scene units, negative = ahead of the apex). Also re-aims the membrane's
   *   V8 contact dent to the actual seat (W9) instead of the fixed t = 0.75.
   * @param {object} [drapeState.contentsBox] balloon→fabric F1 — the catch's
   *   oriented-box spec {ox,oy,oz, r00…r22, hx,hy,hz} (kit space, scene units;
   *   see contentsFloorRadiusBox). Takes precedence over the sphere floor when
   *   valid: the film wraps the catch's REAL extents, not its bounding sphere.
   *   The kit COPIES the 15 numbers into a per-handle spec (allocated once per
   *   handle) — the consumer may reuse a scratch object across visuals/frames.
   * @param {THREE.Vector3} [drapeState.localCamPos] camera position in the kit's
   *   LOCAL frame (consumer world→local transforms it and passes it in as data,
   *   preserving the kit's pure-local-space rule). When present, V4 depth
   *   shading rewrites the vertex colours: the far side of the bag recedes.
   */
  updateWebDrape(h, { drape = 0, cinchFrac = 0, jigglePhase = 0, jiggleAmp = 0,
                      contentsRadius = 0, contentsZ = 0, contentsBox = null, localCamPos } = {}) {
    if (!h || !h.webPositions || !h.coneMesh) return;
    h._drape = drape;
    h._cinchFrac = cinchFrac;
    h._jigglePhase = jigglePhase;
    h._jiggleAmp = jiggleAmp;
    // D2: stored on the handle so the probe (main.js) and setCinchedRim read
    // the SAME values the mesh deformed to — never a re-derived copy.
    h._contentsR = contentsRadius;
    h._contentsZ = contentsZ;
    // F1: the box spec likewise — COPIED into a per-handle object (allocated
    // once, then mutated) so several live nets never share a driver scratch
    // (B8) and the probe reads the identical numbers the mesh deformed to.
    if (contentsBoxValid(contentsBox)) {
      if (!h._contentsBox) {
        h._contentsBox = { ox: 0, oy: 0, oz: 0,
          r00: 1, r01: 0, r02: 0, r10: 0, r11: 1, r12: 0, r20: 0, r21: 0, r22: 1,
          hx: 0, hy: 0, hz: 0 };
      }
      const b = h._contentsBox;
      b.ox = contentsBox.ox; b.oy = contentsBox.oy; b.oz = contentsBox.oz;
      b.r00 = contentsBox.r00; b.r01 = contentsBox.r01; b.r02 = contentsBox.r02;
      b.r10 = contentsBox.r10; b.r11 = contentsBox.r11; b.r12 = contentsBox.r12;
      b.r20 = contentsBox.r20; b.r21 = contentsBox.r21; b.r22 = contentsBox.r22;
      b.hx = contentsBox.hx; b.hy = contentsBox.hy; b.hz = contentsBox.hz;
    } else {
      h._contentsBox = null;
    }
    // Item 12 (D1/D3): when the BOX floor is active, redistribute the meridional
    // ring z's onto the floor's cap elbows — ONE table, filled here once, read by
    // BOTH builders so film and threads deform identically (the weld). Sphere
    // floor / flight / no-contents ⇒ null ⇒ the builders take the natural
    // drapeRingZ z's, bit-identical to the pre-item-12 path.
    const ringZ = (drape > 0 && contentsBoxValid(h._contentsBox))
      ? _ringZGrid(h._ringZ, {
        coneHeight: h.coneHeight, radialSpokes: h.radialSpokes, rings: h.rings,
        drape, contentsBox: h._contentsBox, cosA: h._cosA, sinA: h._sinA,
      })
      : null;
    buildWebPositionsDraped(h.webPositions, {
      mouthRadius: h.mouthRadius,
      coneHeight: h.coneHeight,
      radialSpokes: h.radialSpokes,
      rings: h.rings,
      drape,
      cinchFrac,
      jigglePhase,
      jiggleAmp,
      contentsRadius,
      contentsZ,
      contentsBox: h._contentsBox,
      cosA: h._cosA,
      sinA: h._sinA,
      angA: h._angA,
      ringZ,
    });
    // In-place GPU push: no new geometry/attribute/buffer, no bounds recompute.
    const buf = h.webBuffer || h.coneMesh.geometry.attributes.instanceStart.data;
    buf.needsUpdate = true;
    // V2: the membrane film rebuilds from the SAME drape state + cached trig, so
    // film and threads deform identically by construction. Normals recomputed in
    // place (the attribute was allocated once at build).
    if (h.membraneMesh) {
      updateMembraneLattice(h.membranePositions, {
        mouthRadius: h.mouthRadius,
        coneHeight: h.coneHeight,
        radialSpokes: h.radialSpokes,
        rings: h.rings,
        drape,
        cinchFrac,
        jigglePhase,
        jiggleAmp,
        contentsRadius,
        contentsZ,
        contentsBox: h._contentsBox,
        // W9: aim the contact dent at the ACTUAL seat — the ring index of the
        // contents' depth — instead of the fixed 0.75, which peaked the dent
        // ~1.4 m ahead of the catch. depthToRingT already clamps to [0,1].
        contactT: contentsRadius > 0
          ? depthToRingT(-contentsZ, h.coneHeight, drape)
          : 0.75,
        cosA: h._cosA,
        sinA: h._sinA,
        angA: h._angA,
        ringZ,
        // V8: contact compression — the film (not the threads) dents where the
        // catch presses, depth from the SSOT fraction of the mouth radius.
        compressM: NET_WEB.CONTACT_COMPRESS_FRAC * h.mouthRadius,
      });
      h.membraneMesh.geometry.attributes.position.needsUpdate = true;
      h.membraneMesh.geometry.computeVertexNormals();
    }
    // V6: cinch flash — the rim-node emissive ramps briefly past the 2.5 bloom
    // threshold as the bag seats, then settles back down. Driven from the same
    // cinchFrac state the threads get, so both drape-driven consumers flash by
    // construction: ramp in over [0.6, 0.85], PEAK from 0.85 (the cinch snap
    // lands ≥ 0.85), then decay over NODE_FLASH_SETTLE_S of wall clock.
    {
      const baseEI = NET_WEB.NODE_EMISSIVE_BASE;
      const peakEI = NET_WEB.NODE_EMISSIVE_CINCH_PEAK;
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
      let ei = baseEI;
      if (cinchFrac >= 0.85) {
        if (h._flashPeakT == null) h._flashPeakT = now;
        const settle = Math.max(0, 1 - (now - h._flashPeakT) / NET_WEB.NODE_FLASH_SETTLE_S);
        ei = baseEI + (peakEI - baseEI) * settle;
      } else if (cinchFrac >= 0.6) {
        h._flashPeakT = null;
        ei = baseEI + (peakEI - baseEI) * ((cinchFrac - 0.6) / 0.25);
      } else {
        h._flashPeakT = null;
      }
      // V8: contact rim light — the drape's rising edge marks the bag's first
      // touch of the catch; a brief sub-bloom bump settles over
      // CONTACT_FLASH_SETTLE_S (V6's cinch flash owns the bloom crossing).
      // Cleared at drape 0 so the next touch re-arms cleanly.
      if (drape <= 0) h._contactFlashT = null;
      if (drape > 0 && (h._drapePrev ?? 0) <= 0) h._contactFlashT = now;
      h._drapePrev = drape;
      if (h._contactFlashT != null) {
        const settle = Math.max(0, 1 - (now - h._contactFlashT) / NET_WEB.CONTACT_FLASH_SETTLE_S);
        if (settle <= 0) h._contactFlashT = null;
        else ei = Math.max(ei, baseEI + (NET_WEB.CONTACT_FLASH_PEAK - baseEI) * settle);
      }
      for (const m of h.rimWeightMats) m.emissiveIntensity = ei;
    }
    // V4: per-thread depth shading — dim each vertex toward DEPTH_DIM_FRACTION of
    // the base colour across the bag's OWN view-depth extent (self-normalizing,
    // so the gradient reads at any camera range). depthWrite stays false; this
    // is the viable path to "the far side of the bag recedes". In-place write,
    // aligned element-for-element with the position buffer.
    if (localCamPos && h.webColorBuffer) {
      const base = h.coneMesh.material.color;
      const dim = NET_WEB.DEPTH_DIM_FRACTION;
      const pos = h.webPositions, col = h.webColorBuffer.array;
      const cx = localCamPos.x, cy = localCamPos.y, cz = localCamPos.z;
      let dMin = Infinity, dMax = -Infinity;
      for (let i = 0; i < pos.length; i += 3) {
        const dx = pos[i] - cx, dy = pos[i + 1] - cy, dz = pos[i + 2] - cz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < dMin) dMin = d;
        if (d > dMax) dMax = d;
      }
      const d0 = Math.sqrt(dMin);
      const span = Math.max(1e-12, Math.sqrt(dMax) - d0);
      for (let i = 0; i < pos.length; i += 3) {
        const dx = pos[i] - cx, dy = pos[i + 1] - cy, dz = pos[i + 2] - cz;
        const t = Math.min(1, (Math.sqrt(dx * dx + dy * dy + dz * dz) - d0) / span);
        const s = 1 - dim * t;
        col[i] = base.r * s; col[i + 1] = base.g * s; col[i + 2] = base.b * s;
      }
      h.webColorBuffer.needsUpdate = true;
    }
  },

  /**
   * Free all geometry + materials owned by the handle. The caller owns removing
   * `handle.group` from the scene.
   * @param {object} h handle
   */
  dispose(h) {
    if (!h) return;
    if (h.coneMesh) {
      h.coneMesh.geometry.dispose();
      h.coneMesh.material.dispose();
      _liveLineMats.delete(h.coneMesh.material);
    }
    if (h.membraneMesh) {
      h.membraneMesh.geometry.dispose();
      h.membraneMesh.material.dispose();
      _liveMembraneMats.delete(h.membraneMesh.material);
    }
    if (h.weightGeo) h.weightGeo.dispose();
    for (const mat of h.rimWeightMats) mat.dispose();
    if (h.drawstringLine) {
      h.drawstringLine.geometry.dispose();
      h.drawstringLine.material.dispose();
    }
    if (h.apexHub) {
      h.apexHub.geometry.dispose();
      h.apexHub.material.dispose();
    }
  },
};

export default NetMeshKit;
