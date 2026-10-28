/**
 * NetMeshKit.js — shared "web in space" net-mesh factory for BOTH capture nets: the Mother net
 * ([`LassoSystem`](../systems/LassoSystem.js)) and the Daughter nets ([`CaptureNetVisual`](./CaptureNetVisual.js)),
 * so both read as the same translucent web.
 *
 * Strictly local-space (plan §1.6): the kit ONLY builds geometry around a local origin and exposes LOCAL setters
 * (mouth fraction, colour, opacity, spin angle, cinched rim, drawstring rebuild) + the meshes/params each consumer's
 * animation needs. It NEVER touches `group.position`, `group.quaternion`, `lookAt`, `net.position`, `_projOffset`,
 * `_armPinned`, `_scenePosition`, `distanceTraveled`, `CeremonyTimeScale`, or any orbit/debris data; the solved
 * frame/motion machinery (F1–F12) stays in the consumers.
 *
 * Geometry convention: apex at the local origin (tether/hub side); mouth at local **−Z** (target side), the
 * daughter's camera-style `lookAt` convention in CaptureNetVisual, so its envelop/cinch math is untouched. The Mother
 * orients its group via its own quaternion path.
 *
 * The web is an orb-weaver spoke + ring pattern (radial spokes apex→rim + concentric "spiral thread" rings) in a
 * single fat-line `LineSegments2` with optional additive shimmer. Cone envelope: apex at origin, mouth ring at local
 * −Z (`mouthRadius` / `coneHeight`). The handle exposes the web as `coneMesh` (alias `webLines`).
 *
 * @module ui/NetMeshKit
 */

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { Constants } from '../core/Constants.js';
import { clamp01, clamp, lerp } from '../core/MathUtil.js';

/** 1 metre in scene units (1 scene unit = 100 km). */
const M = 1e-5;

const NET_CER = Constants.CAPTURE_NET.NET_CEREMONY;
const NET_WEB = Constants.NET_WEB;

// LineMaterial computes screen-space width from `resolution` (the DRAWING-BUFFER size in px = CSS px × pixelRatio).
// Every live web LineMaterial is registered here; SceneManager drives `NetMeshKit.setResolution(w, h)` with the
// renderer's real buffer size on init + resize (Retina threads must not render at half width). The window value is
// only a pre-SceneManager fallback. Touches only material resolution, never transform/world/frame state. Guarded for
// Node.
const _liveLineMats = new Set();
const _liveMembraneMats = new Set();
// V2 membrane env map (HDR sun disk + Earth hemisphere), baked once per renderer by getOrbitalFoilEnv and handed over
// by SceneManager. CACHED at module scope like `_resolution`: SceneManager calls setEnvTexture in its CONSTRUCTOR,
// before any net exists, so `_liveMembraneMats` is empty then; build() reads this so later materials still get the
// env. Null headless.
let _envTexture = null;
const _resolution = { w: 1, h: 1 };
if (typeof window !== 'undefined') {
  _resolution.w = window.innerWidth || 1;
  _resolution.h = window.innerHeight || 1;
}

// Ivory Dyneema thread (fat-line, soft + legible). Read Constants.NET_WEB DIRECTLY: it is always supplied, and a
// missing key must throw loudly at import, never fall back to a made-up value.
const DEFAULT_WEB_COLOR     = NET_WEB.WEB_COLOR;
const DEFAULT_WEB_OPACITY   = NET_WEB.WEB_OPACITY;
const DEFAULT_DRAWSTRING_COLOR = 0xffaa44;
const DEFAULT_WEIGHT_COLOR  = 0xeef4ff;   // ivory tungsten edge-node glint
const DEFAULT_APEX_COLOR    = 0x665544;
const DEFAULT_APEX_RADIUS_M = 0.05;
// Fat-line web fineness (orb-weaver spoke + ring): Constants.NET_WEB, shared by Mother + Daughter.
const DEFAULT_RADIAL_SPOKES = NET_WEB.RADIAL_SPOKES;
const DEFAULT_RING_COUNT    = NET_WEB.RING_COUNT;
const DEFAULT_LINE_WIDTH_PX = NET_WEB.LINE_WIDTH_PX;
const DEFAULT_NODE_ADDITIVE = NET_WEB.NODE_ADDITIVE;

/**
 * Orb-weaver spoke+ring web vertex positions (one line-segments buffer). Apex at local origin; mouth ring at
 * z = −coneHeight, radius = mouthRadius. Linear cone (at axial fraction t: z = −coneHeight·t, radius = mouthRadius·t),
 * so spokes are straight apex→rim threads and each ring is a polygon at t. Construction only.
 * @returns {Float32Array}
 */
function buildWebPositions(mouthRadius, coneHeight, radialSpokes, rings) {
  const positions = [];
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
 * Per-frame rebuild of the web vertex positions with a drape/shrink-wrap deformation (the kit's `setPositions` is
 * construction-time only). A function of (mouthRadius, coneHeight, drape) only: no world/frame state, no group
 * transforms.
 *
 * Phases (driven by the consumer from the net FSM):
 *   flight  (drape ≈ 0)  — straight cone, slight cone bow at the mouth.
 *   envelop (0 < drape < 1) — the web drapes onto the debris ellipsoid: each ring's radius is pulled in toward the
 *     catch silhouette and its z pushed forward past the mouth plane, with a decaying 2–3 Hz settle-jiggle.
 *   cinch   (drape → 1, cinchFrac 0→1) — shrink-wrap: rings collapse toward the closed (bunched) radius at the mouth.
 *
 * @param {Float32Array} out — target buffer (same length as buildWebPositions)
 * @param {object} p  mouthRadius / coneHeight (scene units, open mouth radius / apex→mouth length), radialSpokes,
 *   rings, drape (0 = flight cone, 1 = fully draped), [cinchFrac=0] (0 open … 1 bunched point), [jigglePhase=0] (rad),
 *   [jiggleAmp=0] (scene units)
 */
// Drape deformation math: module scope, defined once so the per-frame path allocates nothing. Pure.
// Profile: at drape d a ring at axial fraction t is pulled inward by d·(0.45+0.55·(1−t)) and pushed forward past the
// mouth by d·coneHeight·(1−t)·0.9 (the bag engulfs the catch; matches the rim-weight envZ sweep in CaptureNetVisual).
// The settle-jiggle is a radial ripple, strongest at the mouth. drapeRingRadius / drapeRingZ are EXPORTED so the probe,
// harness gates and unit tests compute the SAME drawn-bag geometry, never a re-derived copy.
export function drapeRingRadius(t, spokeAngle, mouthRadius, drape, cinch, closed, jigA, jigP) {
  let r = mouthRadius * t;
  if (drape > 0) {
    // Pull toward the catch silhouette: ~55% of open at the mouth (the catch is smaller than the 8 m mouth), less
    // toward the apex (the bag necks down behind the catch).
    const pull = drape * (0.45 + 0.55 * (1 - t));
    r *= (1 - pull * 0.45);
  }
  if (cinch > 0) {
    r = lerp(r, mouthRadius * closed * t, cinch);
  }
  if (jigA > 0) {
    r += jigA * t * Math.sin(jigP + spokeAngle * 3);
  }
  return r;
}
export function drapeRingZ(t, coneHeight, drape) {
  let z = -coneHeight * t;
  if (drape > 0) {
    z -= drape * coneHeight * (1 - t) * 0.9 * t;
  }
  return z;
}

// Shared drawn-bag geometry: pure exports, scene units; they only expose/invert maths that already runs per frame.

/**
 * Invert drapeRingZ: which ring index t sits at `axialDepth` (scene units ahead of the apex, ≥ 0) for a given drape.
 * z(t) = −H·(t + k·t·(1−t)), k = 0.9·drape; with u = axialDepth/coneHeight: k·t² − (1+k)·t + u = 0. Returns the root
 * in [0,1] (clamped); u when drape === 0. t IS the depth fraction only at drape 0: once the bag engulfs, every
 * "radius at the whale's depth" must go through this inversion.
 */
export function depthToRingT(axialDepth, coneHeight, drape) {
  if (!(coneHeight > 0)) return 0;
  const u = clamp01(axialDepth / coneHeight);
  const k = 0.9 * clamp01(drape ?? 0);
  if (k === 0) return u;
  const disc = (1 + k) * (1 + k) - 4 * k * u;
  const t = ((1 + k) - Math.sqrt(Math.max(0, disc))) / (2 * k);
  return clamp01(t);
}

/**
 * The DRAWN rim radius at an axial depth (scene units ahead of the apex): drapeRingRadius at the ring index
 * drapeRingZ places there. The settle-jiggle is excluded (a ±ripple, not systematic). Pure; scene units.
 * `closedFrac` = DRAWSTRING_RADIUS_FRAC_CLOSED.
 */
export function drawnRimRadiusAtDepth(axialDepth, mouthRadius, coneHeight, drape, cinch, closedFrac) {
  const t = depthToRingT(axialDepth, coneHeight, drape);
  return drapeRingRadius(t, 0, mouthRadius, drape, cinch, closedFrac, 0, 0);
}

/**
 * Spherical-envelope floor around the bag's contents. A net wrapping a ball bulges around the ball and is free to
 * close everywhere else, so the floor is the ball's cross-section radius at z, fattened by `margin`:
 * margin·√(Rc² − (z − zc)²) for |z − zc| < Rc, else 0. (A flat floor would balloon the apex and undo the drape's
 * necking behind the catch.) `contentsRadius` 0 (a miss / no target) floors at 0: an empty net SHOULD bunch to a
 * point; that contrast is what sells a real catch. Pure; scene units; z/contentsZ in the same frame (negative z =
 * ahead of the apex).
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
 * v_box = R·(v_kit − c): the ONE point transform into box space (the stored rows of the contentsBox spec), shared by
 * contentsFloorRadiusBox (ray origin) and _edgeBoxDepth (chord samples) so the floor envelope and the chord metric
 * can never desync. Writes the module scratch `_bs` (mutated per call, never retained: the per-frame path stays
 * allocation-free). The DIRECTION transform (R·v) and the corner transform (Rᵀ) stay inline: different operations.
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
 * Oriented-BOX floor around the bag's contents. The sphere above hugs the catch's bounding sphere, set by its extreme
 * points (the cubesat's wingtips), and floats ~0.7–1.0 m off the hull elsewhere (a "translucent balloon"). The box
 * floor settles the film onto the catch's real extents, in two parts:
 *
 * 1. IN-SPAN — the spoke ray (from the bag axis at height z, horizontal along (cosA, sinA)) meets the box in box
 *    space: origin inside ⇒ margin × tExit (wrap out from the centre); origin outside and the ray hits ⇒ margin ×
 *    tEnter (drape onto the near face).
 * 2. CORNER-CONE (bicone) — when the ray MISSES, the film is past one of the box's caps and the floor must NOT
 *    vanish: the chord from a floored wrap ring to an unfloored natural ring tunnels straight through the hull
 *    (measured up to 570 mm at the flat-cap orientation). The taut film is modelled as a cone from the apex over the
 *    box's silhouette, and an anti-cone from the drawstring (mouthZ) back to it. Each corner contributes its
 *    PROJECTED extent u = cx·cosA + cy·sinA in the spoke's vertical plane (never the 3-D radius: a revolution cone
 *    bulges past the face at the centre plane), scaled by z/z_C for deeper corners and (mouthZ−z)/(mouthZ−z_C) for
 *    shallower ones; the floor takes the max. Applied ONLY on a miss: the slab hit is the exact surface, the cone is
 *    the tent past the caps; they meet at the cap plane. It stays per-angle honest for an off-axis box.
 *
 * The box is convex, so "film vertex radius ≥ this floor" keeps every vertex outside the margined hull by
 * construction (ring-continuous; chords between vertices are the chordcheck instrument's domain). Scene units; pure;
 * no allocations.
 * @param {number} z — ring axial position in kit space (negative = ahead of the apex)
 * @param {number} cosA @param {number} sinA — spoke direction (unit, horizontal in kit space)
 * @param {object} box — {ox,oy,oz, r00…r22, hx,hy,hz}: box centre in kit space, kit→box rotation rows
 *   (v_box = R·v_kit), half extents; all scene units
 * @param {number} [margin=NET_CER.CONTENTS_FLOOR_MARGIN]
 * @param {number} [mouthZ] — kit mouth plane z (drawstring side); enables the far anti-cone. Omitted ⇒ the far cap
 *   closes freely.
 * @returns {number} floor radius (scene units), ≥ 0
 */
export function contentsFloorRadiusBox(z, cosA, sinA, box, margin = NET_CER.CONTENTS_FLOOR_MARGIN, mouthZ = null) {
  if (!contentsBoxValid(box)) return 0;
  // Ray origin: the bag-axis point at ring height z, in box space (shared transform). Read by index, not
  // destructuring: the elbow scan calls this ~3.3k times per frame (20 spokes × coarse+refine), so an iterator
  // allocation would be per-frame garbage on the builders' path.
  const bs = _toBoxSpace(box, 0, 0, z);
  const ox = bs[0], oy = bs[1], oz = bs[2];
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
  // Bicone: corners in KIT space (v_kit = Rᵀ·v_box), constrained in the spoke's vertical plane by their PROJECTED
  // extent u. Evaluated ONLY on a slab miss.
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
        if (u <= 0) continue;
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
 * The contents floor the mesh actually DRAWS at one (ring z, spoke angle): the box floor when a valid contentsBox is
 * supplied, else the sphere floor; clamped to `openConeRadius` (ring 0's clamp is 0 so the apex never balloons off the
 * threads, R1; no ring exceeds the cone the kit has, R2). The ONE home of floor + precedence + clamp: the mesh
 * builders AND the main.js probe/recorder call it, so they can never drift. Pure; scene units; no allocations.
 * @param {number} z — ring axial position in kit space (negative = ahead of the apex)
 * @param {number} cosA @param {number} sinA — spoke direction
 * @param {number} openConeRadius — cone radius at the ring's DRAPED z (`mouthRadius·(−z/H)`; `mouthRadius·t` only at
 *   drape 0), scene units
 * @param {number} contentsZ @param {number} contentsRadius — sphere-floor centre z (kit space) and radius (0 = no
 *   contents), scene units
 * @param {object|null} contentsBox — box-floor spec (null/invalid ⇒ sphere path)
 * @param {number} [margin=NET_CER.CONTENTS_FLOOR_MARGIN]
 * @param {number} [mouthZ] — kit mouth plane z, forwarded to the box floor's far anti-cone (tests may omit it)
 * @returns {number} floor radius (scene units), ≥ 0
 */
export function contentsFloorClamped(z, cosA, sinA, openConeRadius, contentsZ, contentsRadius, contentsBox, margin = NET_CER.CONTENTS_FLOOR_MARGIN, mouthZ = null) {
  let f = 0;
  if (contentsBoxValid(contentsBox)) {
    f = contentsFloorRadiusBox(z, cosA, sinA, contentsBox, margin, mouthZ);
  } else if (contentsRadius > 0) {
    // Legacy sphere fallback: unreachable from the production drivers (CaptureNetVisual always supplies a valid
    // contentsBox with contentsRadius; the lasso supplies neither). Kept for the sphere test contract; main.js's probe
    // fallback mirrors it.
    f = contentsFloorRadius(z, contentsZ, contentsRadius, margin);
  }
  return f > 0 ? Math.min(f, openConeRadius) : 0;
}

/**
 * Whether a contents-BOX spec is usable (all half extents positive). THE one home of the box-validity predicate: kit
 * builders, contentsFloorClamped and the main.js probe all decide box-vs-sphere through it.
 */
export function contentsBoxValid(box) {
  return !!(box && box.hx > 0 && box.hy > 0 && box.hz > 0);
}

/**
 * Does the DRAWN polyline touch the catch? The vertex rule keeps every lattice VERTEX outside the margined hull, but
 * the mesh draws CHORDS, and a chord spanning an envelope ridge sags inside it (dominant class: the MERIDIONAL
 * cap-elbow chord, tent→slab handoff). The ONE home of that measurement: the main.js probe (metres gate) and the tmp
 * chordcheck instrument both call it, so instrument ≡ gate.
 *
 * Signed inside-depth of the UNMARGINED box at samplesPerEdge points per edge: depth(p) = min(hx−|px|, hy−|py|,
 * hz−|pz|) in box space; > 0 ⇒ the drawn film is that deep INSIDE the true hull (genuine contact, not margin erosion;
 * the same margin-1 reference pierceM uses). Sampled, not exact: a ridge maximum can sit between samples (≈ 1–2 cm on
 * the 6×20 lattice), which the gate's tolerance absorbs. Membrane and thread chords are the SAME lattice (welded
 * vertices), so one sweep covers both.
 *
 * Pure read of the builders' positions (bicone tents are drawn geometry, so included); no allocations; scene units.
 * @param {Float32Array} positions — (rings+1) × radialSpokes × 3 lattice (the handle's membranePositions)
 * @param {object} box — the handle's stored contentsBox (kit space)
 * @param {number} [samplesPerEdge=64]
 * @returns {number|null} worst signed inside-depth (scene units), or null when no valid box is supplied
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

/** One chord's worst signed inside-depth. */
function _edgeBoxDepth(pos, i0, i1, box, n, worst) {
  const ax = pos[i0], ay = pos[i0 + 1], az = pos[i0 + 2];
  const bx = pos[i1], by = pos[i1 + 1], bz = pos[i1 + 2];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const [qx, qy, qz] = _toBoxSpace(box, lerp(ax, bx, f), lerp(ay, by, f), lerp(az, bz, f));
    const d = Math.min(box.hx - Math.abs(qx), box.hy - Math.abs(qy), box.hz - Math.abs(qz));
    if (d > worst) worst = d;
  }
  return worst;
}

// Meridional ring redistribution onto the floor's elbows.
//
// The film's meridional ring-to-ring chords straight-line the convex elbow where the apex-side tent hands off to the
// box's slab faces, cutting up to ~0.67 m into the catch's true box while every vertex stays outside it. No floor
// SHAPE can fix it: the film is anchored at the apex (radius 0), so any envelope reaching the slab has a convex bend,
// and a straight chord of a convex bend always sags inside (rejected: margin ≥ 1.22, per-vertex lifts, uniform density
// to 24 rings, envelope re-seaming). The honest lever is VERTEX PLACEMENT: the tent (apex→near elbow) and anti-cone
// (far elbow→mouth) are each ONE straight line and need no intermediate rings. Rings are REDISTRIBUTED per spoke:
// ring 1 onto the near elbow, ring rings−1 onto the far elbow, the rest spread across the box's span.
//
// Elbows come from a RATIO-DEPARTURE scan of contentsFloorRadiusBox itself (nothing re-derived): the tent is a max of
// corner lines through the origin, so f(z)/z is constant on it; the anti-cone is a max of corner lines through the
// mouth point, so f(z)/(mouthZ−z) is constant there. The elbow is where the floor departs the ratio. Coarse scan +
// binary refine: ~100–160 floor evaluations per spoke, per-frame affordable.


const _ELBOW_COARSE = 64;
const _ELBOW_REFINE = 16;
const _ELBOW_BAND = 0.02;              // ratio-departure tolerance (2%)
// Degenerate-span guard: a redistribution needs a span worth spreading rings across. 0.74% of the bag length ≈ 5 cm on
// the D=8 kit (coneHeight 6.8 m), a FRACTION so it scales with the kit.
const _ELBOW_MIN_SPAN_FRAC = 0.0074;
// P2/B8: the elbow pair is returned in a module scratch: `_floorElbows` runs radialSpokes times per frame, so no array
// return or destructuring iterator may allocate there.
const _elbowScratch = new Float64Array(2);

/**
 * The two meridional elbows of the box floor at one spoke angle, written into the module scratch `_elbowScratch`
 * ([0] = near/apex-side, [1] = far/mouth-side kit z; NaN when not found). Never retain it (mutated on the next call).
 * NaN is safe: the spoke's ray never meets the box (the empty side), or the tent/anti-cone run is thinner than one
 * coarse step; the caller then keeps that spoke's natural ring z's.
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
 * Fill the per-handle ring-z table: per (ring, spoke) z, with the meridional rings redistributed onto the floor's
 * elbows. Spokes whose ray never meets the box (no elbows, or a span thinner than `_ELBOW_MIN_SPAN_FRAC` of the bag)
 * keep their natural drapeRingZ z's; every z is lerped from natural to redistributed BY DRAPE, so ENVELOP cannot pop.
 * Ring 0 stays at the apex (R1: z = 0, clamp 0) and ring `rings` at the mouth (R2: mouthZ = drapeRingZ(1) at every
 * drape), both checked FIRST so no ring count can redistribute them away. Reads cos/sin from the cached handle tables;
 * writes `out` in place ((rings+1) × radialSpokes per-handle scratch).
 */
function _ringZGrid(out, p) {
  const { coneHeight, radialSpokes, rings, contentsBox } = p;
  const drape = clamp01(p.drape ?? 0);
  const mouthZ = -coneHeight;
  const cosA = p.cosA, sinA = p.sinA;
  const minSpan = coneHeight * _ELBOW_MIN_SPAN_FRAC;
  // V3 sock gather: when `mouthGather` > 0 the MOUTH ring gathers toward the contents' mouth-side face (drawstring-rosette
  // language) instead of trailing at the mouth plane as an empty sock. The face plane is CLOSED-FORM from the oriented
  // box (extent along kit z), deliberately NOT the elbow scan's far elbow: sub-metre pieces (the lasso class) fail the
  // `redis` min-span threshold, and the drawstring gathers ALL fabric. 0 (default) is byte-identical: R2 (mouth ring ON
  // the mouth plane) is untouched for existing callers; the lasso wrap opts in.
  const gather = clamp01(p.mouthGather ?? 0);
  for (let s = 0; s < radialSpokes; s++) {
    const e = _floorElbows(cosA[s], sinA[s], contentsBox, mouthZ);
    const eN = e[0], eF = e[1];
    const redis = Number.isFinite(eN) && Number.isFinite(eF) && eN > eF + minSpan;
    for (let k = 0; k <= rings; k++) {
      const zNat = drapeRingZ(k / rings, coneHeight, drape);
      let zR = zNat;
      if (redis) {
        // R1/R2 first: the apex weld and the mouth plane never move, for ANY ring count (a 1- or 2-ring kit must not
        // hand the mouth to eN).
        if (k === 0) zR = 0;
        else if (k === rings) zR = mouthZ;
        else if (k === 1) zR = eN;
        else if (k === rings - 1) zR = eF;
        else zR = lerp(eN, eF, (k - 1) / (rings - 2));
      }
      out[k * radialSpokes + s] = lerp(zNat, zR, drape);
    }
  }
  // Gather pass: pull the WHOLE mouth ring (every spoke: a drawstring pulls all fabric, box-hit or not) onto ONE common
  // plane between the mouth and the contents' far face, lerped by drape so it cannot pop. The float64 plane is reported
  // via p.mouthPlaneOut (NaN = not applied): the grid is float32 storage, and the byte law `_mouthZEff === _mouthZ` for
  // gather-off callers must never depend on a float32 round-trip.
  p.mouthPlaneOut = NaN;
  if (gather > 0 && contentsBox) {
    const zExt = Math.abs(contentsBox.r02) * contentsBox.hx
               + Math.abs(contentsBox.r12) * contentsBox.hy
               + Math.abs(contentsBox.r22) * contentsBox.hz;
    const zFace = contentsBox.oz - zExt;             // mouth-side face plane
    if (zFace > mouthZ && zFace < 0) {
      const zGather = lerp(mouthZ, zFace, gather);
      const zNatM = drapeRingZ(1, coneHeight, drape);   // == mouthZ (R2)
      const zRow = lerp(zNatM, zGather, drape);
      for (let s = 0; s < radialSpokes; s++) out[rings * radialSpokes + s] = zRow;
      p.mouthPlaneOut = zRow;
    }
  }
  return out;
}

/**
 * The single mouth-plane ring radius the contents floor demands: a box floor varies with angle, so the MAX over the
 * spoke directions (the angles the film's vertices sit at). Sphere-floor / no-contents → 0 whenever the contents'
 * far face is short of the mouth plane. Module-scope, allocation-free; reads the handle's stored contents fields.
 */
function _mouthFloorMax(h) {
  const cR = h._contentsR ?? 0;
  const cB = h._contentsBox ?? null;
  if (!(cR > 0) && !contentsBoxValid(cB)) return 0;
  const cZ = h._contentsZ ?? 0;
  // Evaluate at the EFFECTIVE mouth plane: the rosette plane when the sock gather moved the mouth ring toward the piece
  // (the ring must clear the contents at ITS OWN z, or the gathered beads would sit inside the catch). `_mouthZEff` is
  // h._mouthZ whenever the gather is off.
  const zEff = h._mouthZEff ?? h._mouthZ;
  let f = 0;
  for (let s = 0; s < h.radialSpokes; s++) {
    const v = contentsFloorClamped(zEff, h._cosA[s], h._sinA[s], h.mouthRadius, cZ, cR, cB, NET_CER.CONTENTS_FLOOR_MARGIN, h._mouthZ);
    if (v > f) f = v;
  }
  return f;
}

function buildWebPositionsDraped(out, p) {
  const { mouthRadius, coneHeight, radialSpokes, rings } = p;
  const drape = clamp01(p.drape ?? 0);
  const cinch = clamp01(p.cinchFrac ?? 0);
  const jigP = p.jigglePhase ?? 0;
  const jigA = p.jiggleAmp ?? 0;
  const closed = NET_CER.DRAWSTRING_RADIUS_FRAC_CLOSED;
  // Floor the drawn bag on the contents (spherical envelope) so the cinch tightens ONTO the catch and stops instead of
  // closing to 0.27 m. Drape-gated: in FLIGHT the catch is not in the bag. A valid contentsBox takes precedence: the
  // film then floors on the catch's REAL oriented box per (ring, spoke).
  const contentsR = p.contentsRadius ?? 0;
  const contentsZ = p.contentsZ ?? 0;
  const contentsBox = p.contentsBox ?? null;
  const floorOn = drape > 0 && (contentsR > 0 || contentsBoxValid(contentsBox));
  // Per-spoke cos/sin/angle are fixed for the handle's life, so the consumer passes cached tables; absent (a test
  // calling this directly) → compute them.
  const cosA = (p.cosA && p.cosA.length === radialSpokes) ? p.cosA : null;
  const sinA = (p.sinA && p.sinA.length === radialSpokes) ? p.sinA : null;
  const angA = (p.angA && p.angA.length === radialSpokes) ? p.angA : null;
  let idx = 0;

  // Radial spokes: apex → rim (t = 1; the drape z-term vanishes at the mouth).
  const zRim = drapeRingZ(1, coneHeight, drape);
  const ringZ = p.ringZ ?? null;   // redistributed per-(ring,spoke) z (box floor on)
  // V3 sock gather: when the mouth ring gathered (ringZ carries the rosette plane on ring `rings`), the spoke TIPS ride
  // the same plane so the threads end on the rosette.
  const gatherRim = !!p.gatherRim && !!ringZ;
  // The floor at the RIM's z (not a ring z): 0 whenever the contents' far face is short of the mouth plane, so the
  // drawstring still closes. Per-spoke (the box floor varies with angle). The open-cone clamp lives in
  // contentsFloorClamped (at the rim it clamps to mouthRadius: an oversized catch can never inflate the bag past its
  // own mouth, R2).
  for (let s = 0; s < radialSpokes; s++) {
    const a  = angA ? angA[s] : (2 * Math.PI * s) / radialSpokes;
    const ca = cosA ? cosA[s] : Math.cos(a);
    const sa = sinA ? sinA[s] : Math.sin(a);
    const zTip = gatherRim ? ringZ[rings * radialSpokes + s] : zRim;
    const rimFloor = floorOn
      ? contentsFloorClamped(zTip, ca, sa, mouthRadius, contentsZ, contentsR, contentsBox, NET_CER.CONTENTS_FLOOR_MARGIN, -coneHeight)
      : 0;
    const r = Math.max(
      drapeRingRadius(1, a, mouthRadius, drape, cinch, closed, jigA, jigP),
      rimFloor);
    out[idx++] = 0; out[idx++] = 0; out[idx++] = 0;
    out[idx++] = ca * r; out[idx++] = sa * r; out[idx++] = zTip;
  }
  for (let k = 1; k <= rings; k++) {
    const t = k / rings;
    const z = drapeRingZ(t, coneHeight, drape);
    // The floor clamps to the cone radius at the ring's DRAPED z (mouthRadius·(−z/H) = mouthRadius·t·(1+0.9·d·(1−t))),
    // the cone the kit actually has there: ring 0 clamps to 0 (apex can't balloon off the threads, R1), t = 1 gives
    // exactly mouthRadius (R2), drape 0 gives mouthRadius·t. (The bare mouthRadius·t form is TIGHTER than the true cone
    // under drape and clipped a contained catch's hull corner.)
    const openCone = mouthRadius * (-z / coneHeight);
    for (let s = 0; s < radialSpokes; s++) {
      const s1 = (s + 1) % radialSpokes;
      const a0 = angA ? angA[s]  : (2 * Math.PI * s) / radialSpokes;
      // a1 is spoke s+1; its jiggle phase (a1·3) is 2π·3-periodic, so the wrapped index yields the same sine as 2π.
      const a1 = angA ? angA[s1] : (2 * Math.PI * (s + 1)) / radialSpokes;
      const c0 = cosA ? cosA[s]  : Math.cos(a0);
      const n0 = sinA ? sinA[s]  : Math.sin(a0);
      const c1 = cosA ? cosA[s1] : Math.cos(a1);
      const n1 = sinA ? sinA[s1] : Math.sin(a1);
      // Per-spoke z (elbow redistribution) with the clamp at each vertex's OWN z. The ring slides ALONG the drape surface,
      // so the natural radius follows its own z: t' = the natural-ring t at that depth (identity when ringZ is null). The
      // GATHERED mouth ring keeps t = 1: it carries the cinched drawstring radius onto the rosette plane (re-deriving t
      // from its gathered depth would re-OPEN it to the cone radius, undoing the cinch).
      const z0 = ringZ ? ringZ[k * radialSpokes + s]  : z;
      const z1 = ringZ ? ringZ[k * radialSpokes + s1] : z;
      const gRim = gatherRim && k === rings;
      const t0 = ringZ && !gRim ? depthToRingT(-z0, coneHeight, drape) : t;
      const t1 = ringZ && !gRim ? depthToRingT(-z1, coneHeight, drape) : t;
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

/** Membrane triangle index buffer for a (rings+1) × radialSpokes lattice. Module-scope so build() shares it. */
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
 * Membrane lattice rebuild (the lit film UNDER the threads): exactly (rings + 1) × radialSpokes vertices so membrane
 * vertices land ON thread intersections. The jiggle term is `jigA · t · sin(jigP + spokeAngle·3)`, so any other
 * angular resolution makes the membrane crawl out from under the threads. Module-scope (allocation invariant);
 * writes `out` in place. Ring k = axial fraction t = k/rings; ring 0 collapses to the apex.
 *
 * @param {Float32Array} out — (rings + 1) × radialSpokes × 3
 * @param {object} p — same params object as buildWebPositionsDraped
 */
function updateMembraneLattice(out, p) {
  const { mouthRadius, coneHeight, radialSpokes, rings } = p;
  const drape = clamp01(p.drape ?? 0);
  const cinch = clamp01(p.cinchFrac ?? 0);
  const jigP = p.jigglePhase ?? 0;
  const jigA = p.jiggleAmp ?? 0;
  const closed = NET_CER.DRAWSTRING_RADIUS_FRAC_CLOSED;
  // Contact compression: an inward dent where the catch presses into the bag, peaked at the catch's seat (p.contactT,
  // default ¾ toward the mouth) and scaled by the drape parameter driving ENVELOP.
  const compressM = p.compressM ?? 0;
  const contactT = p.contactT ?? 0.75;
  // Same contents floor as the threads, applied AFTER the compression dent so the floor always wins (the film can dent
  // toward the catch but never through it). Drape-gated; box floor per (ring, spoke) when a contentsBox rides along.
  const contentsR = p.contentsRadius ?? 0;
  const contentsZ = p.contentsZ ?? 0;
  const contentsBox = p.contentsBox ?? null;
  const floorOn = drape > 0 && (contentsR > 0 || contentsBoxValid(contentsBox));
  const cosA = (p.cosA && p.cosA.length === radialSpokes) ? p.cosA : null;
  const sinA = (p.sinA && p.sinA.length === radialSpokes) ? p.sinA : null;
  const angA = (p.angA && p.angA.length === radialSpokes) ? p.angA : null;
  const ringZ = p.ringZ ?? null;   // same per-(ring,spoke) z as the web (the weld)
  const gatherRim = !!p.gatherRim && !!ringZ;   // rosette plane on ring `rings`
  let idx = 0;
  for (let k = 0; k <= rings; k++) {
    const t = k / rings;
    const zNat = drapeRingZ(t, coneHeight, drape);
    // Same open-cone clamp as the web path (inside contentsFloorClamped): ring 0 clamps to 0, so the membrane apex stays
    // welded to the spoke apex even when the contents envelope peaks at z = 0 (REELING/BERTHED co-location).
    const openCone = mouthRadius * (-zNat / coneHeight);
    for (let s = 0; s < radialSpokes; s++) {
      const a  = angA ? angA[s] : (2 * Math.PI * s) / radialSpokes;
      const ca = cosA ? cosA[s] : Math.cos(a);
      const sa = sinA ? sinA[s] : Math.sin(a);
      const z = ringZ ? ringZ[k * radialSpokes + s] : zNat;
      const openK = ringZ ? mouthRadius * (-z / coneHeight) : openCone;
      // The ring slides along the drape surface: the natural radius and the dent follow its own z (t' = natural-ring t at
      // that depth; identity when ringZ is null). The gathered mouth ring keeps t = 1 so the rim carries the cinched
      // radius onto the rosette plane (same rule as the thread builder: the weld).
      const tK = ringZ && !(gatherRim && k === rings)
        ? depthToRingT(-z, coneHeight, drape) : t;
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
   * @param {number} [opts.opacity]            base web opacity (cone + nodes; the apex hub too, unless apexOpacity is given)
   * @param {number} [opts.drawstringOpacity=0.8] drawstring line opacity
   * @param {boolean} [opts.weightTransparent=false] make node material fade-able
   * @param {boolean} [opts.apexTransparent=false]   make apex-hub material fade-able
   * @param {number} [opts.apexOpacity=opacity] apex-hub opacity rest: the fade-able hub rests at 1.0 (transparent + 1.0
   *                  renders identically to the opaque build; the shared 0.8 would make the hub 20 % see-through in
   *                  every gated beat)
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
      apexOpacity = opacity,
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

    // Spoke + ring "web": fat-line orb-weaver LineSegments2 + LineMaterial (three/addons/lines) for real screen-space
    // width + built-in AA. Same envelope (mouthRadius / coneHeight) as the old wireframe. Threads are flat-translucent
    // (NormalBlending, no depth write) so the web reveals the catch without occluding it.
    const mouthRadius = M * (D / 2) * coneOpenRadiusFrac;
    const coneHeight  = mouthRadius * 2 * coneLengthFrac;
    const webPositions = buildWebPositions(mouthRadius, coneHeight, radialSpokes, rings);
    const webGeo = new LineSegmentsGeometry();
    webGeo.setPositions(webPositions);
    // Per-thread vertex colours for view-depth shading (far side recedes); depthWrite stays false. Seeded white, written
    // in place per frame from the kit-LOCAL camera position (the consumer transforms world→local and passes it in as
    // data, like the cached trig tables).
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

    // V2 lit membrane: a drape-driven film UNDER the threads, MeshPhysicalMaterial (roughness/sheen/low transmission,
    // DoubleSide) so the bag responds to sun + earthshine. transparent + depthWrite:false like the threads so the catch
    // reads through it. (rings+1) × radialSpokes vertices so they land ON thread intersections (any other resolution
    // crawls out from under the threads). envMap arrives via setEnvTexture (null headless → scene.environment applies).
    // Positions + normals are written in place per frame.
    const membranePositions = new Float32Array((rings + 1) * radialSpokes * 3);
    const membraneGeo = new THREE.BufferGeometry();
    membraneGeo.setAttribute('position', new THREE.BufferAttribute(membranePositions, 3));
    membraneGeo.setIndex(buildMembraneIndex(radialSpokes, rings));
    // Night-readability emissive floor: the film is the bag's only LIT surface; in Earth shadow (sun lerps to 0.05) it went
    // black and a capture read as bare threads. A heavily desaturated tint of the web colour at MEMBRANE_EMISSIVE_FLOOR
    // keeps the silhouette readable at night and vanishes into the lit response by day (DebrisField night-side
    // precedent: s × 0.25, l capped 0.30, sub-bloom by an order of magnitude).
    const membraneEmissive = new THREE.Color(color);
    {
      const hsl = { h: 0, s: 0, l: 0 };
      membraneEmissive.getHSL(hsl);
      membraneEmissive.setHSL(hsl.h, hsl.s * 0.25, Math.min(hsl.l, 0.30));
    }
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
      emissive: membraneEmissive,
      emissiveIntensity: NET_WEB.MEMBRANE_EMISSIVE_FLOOR,
      // Null until SceneManager hands over the baked orbital env (null for good headless); three.js reads a null
      // envMap as "use scene.environment", the intended fallback.
      envMap: _envTexture,
    });
    _liveMembraneMats.add(membraneMat);
    const membraneMesh = new THREE.Mesh(membraneGeo, membraneMat);
    membraneMesh.name = 'membrane';
    membraneMesh.visible = childrenVisible;
    membraneMesh.frustumCulled = false;   // deforms per-frame; avoid stale-bounds cull
    membraneMesh.renderOrder = 0;         // film UNDER the threads
    group.add(membraneMesh);
    // Seed the static flight cone and allocate the normal attribute once; the per-frame computeVertexNormals in
    // updateWebDrape then writes in place.
    updateMembraneLattice(membranePositions, { mouthRadius, coneHeight, radialSpokes, rings });
    membraneGeo.attributes.position.needsUpdate = true;
    membraneGeo.computeVertexNormals();

    // Rim weight spheres (tungsten edge-node glints, canon §2.6): at the mouth plane (z = −coneHeight), open radius; tiny,
    // lead the unfurl + cinch.
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
        // The same resting glint V6's flash ramps away from and back to (no literal); the ONLY value the non-draping
        // lasso net's nodes ever show.
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

    // Drawstring spoke pattern: apex→w0→apex→w1→…→apex→wN-1→apex→w0
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

    const apexGeo = new THREE.SphereGeometry(M * apexHubRadiusM, 8, 8);
    const apexMat = new THREE.MeshStandardMaterial({
      color: DEFAULT_APEX_COLOR,
      metalness: 0.7,
      roughness: 0.4,
      transparent: apexTransparent,
      opacity: apexOpacity,
    });
    const apexHub = new THREE.Mesh(apexGeo, apexMat);
    apexHub.name = 'apexHub';
    apexHub.visible = childrenVisible;
    group.add(apexHub);

    // Per-spoke cos/sin/angle cached once (radialSpokes is fixed), so the per-frame drape rebuild does no projection trig.
    const _cosA = new Float32Array(radialSpokes);
    const _sinA = new Float32Array(radialSpokes);
    const _angA = new Float32Array(radialSpokes);
    for (let s = 0; s < radialSpokes; s++) {
      const a = (2 * Math.PI * s) / radialSpokes;
      _angA[s] = a; _cosA[s] = Math.cos(a); _sinA[s] = Math.sin(a);
    }

    // `webPositions` IS the backing store of the web's instanced-interleaved buffer (setPositions wrapped it, no copy), so
    // the per-frame drape path writes it in place and flags the buffer dirty instead of re-running setPositions (which
    // reallocates the buffer, both interleaved attributes and both bounding volumes every frame).
    const webBuffer = coneMesh.geometry.attributes.instanceStart.data;
    // Same in-place pattern for the vertex-colour buffer (instanceColorStart/End share one buffer).
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
      // Membrane opacity as a fraction of the WEB's canonical full opacity, so setOpacity(o) fades the film proportionally.
      _membraneOpacityFrac: membraneOpacity / Math.max(1e-9, DEFAULT_WEB_OPACITY),
      // The consumer's build-time film rest: updateWebDrape lerps from THIS toward MEMBRANE_OPACITY_WELDED by cinchFrac.
      _membraneBaseOpacity: membraneOpacity,
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
      // The EFFECTIVE mouth plane: the sock-gather rosette plane while the lasso wrap gathers, h._mouthZ otherwise.
      // Maintained by updateWebDrape; read by setRimCinch and _mouthFloorMax.
      _mouthZEff: mouthZ,
      _spinAngle: 0,
      // drape state (per-frame update path)
      _drape: 0,
      _cinchFrac: 0,
      _jigglePhase: 0,
      _jiggleAmp: 0,
      _flashPeakT: null,   // wall-clock when cinchFrac first reached 0.85
      _contactFlashT: null, // wall-clock of the drape's rising edge (first touch)
      _drapePrev: 0,       // previous frame's drape (rising-edge detect)
      // cached per-spoke trig (projection is fixed; only jiggle recomputes)
      _cosA,
      _sinA,
      _angA,
      // Per-(ring,spoke) ring-z scratch for the elbow redistribution: allocated once, refilled per updateWebDrape, read by
      // BOTH builders (the membrane/thread weld).
      _ringZ: new Float32Array((rings + 1) * radialSpokes),
    };

    if (weightCount > 0) this.updateDrawstring(handle);

    return handle;
  },

  /**
   * Set the net MOUTH radius as a fraction of the full open radius (Mother's open / cinch animation). Scales the rim
   * nodes' XY and the cone's XY, keeping the apex + axial length; rebuilds the drawstring.
   * @param {number} frac mouth radius fraction in [0.05, 1]
   */
  setMouthFraction(h, frac) {
    const f = clamp(frac, 0.05, 1);
    // Never place the rim inside the contents envelope (0 when contents are absent or their far face is short of the
    // mouth plane; no change for the lasso, which never sets _contentsR). Clamped to the mouth plane's own open radius
    // (inside contentsFloorClamped); max over the spoke angles (a box floor varies with angle; the ring must clear
    // every one).
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
   * Sweep the RIM WEIGHTS (+ drawstring) from the open mouth toward the kit's closed radius WITHOUT touching the
   * cone/membrane meshes: the rim-only counterpart of setMouthFraction for consumers whose web vertices are owned by
   * updateWebDrape (lasso wrap-as-cloth). Under the drape driver the threads/film bunch onto the contents, so the mesh
   * scale must stay (1,1,1) while the weights still cinch. Same sweep curve as CaptureNetVisual's CINCH_CLOSING
   * (mouthRadius → closedRadius, floored at the mouth-plane contents floor), same weight plane (h._mouthZ) as
   * setMouthFraction.
   * @param {number} t cinch fraction in [0, 1] — 0 = open rim, 1 = closed rim
   */
  setRimCinch(h, t) {
    const tc = clamp01(t);
    const r = Math.max(
      lerp(h.mouthRadius, h.closedRadius, tc),
      _mouthFloorMax(h),
    );
    // Beads + drawstring ride the EFFECTIVE mouth plane: the sock-gather rosette when the lasso wrap pulled the mouth
    // ring toward the piece, else the kit mouth plane (`_mouthZEff` === `_mouthZ` whenever the gather is off).
    const zEff = h._mouthZEff ?? h._mouthZ;
    for (let i = 0; i < h.weightCount; i++) {
      const a = h._rimAngles[i] + h._spinAngle;
      h.rimWeights[i].position.set(Math.cos(a) * r, Math.sin(a) * r, zEff);
    }
    if (h.weightCount > 0) this.updateDrawstring(h);
  },

  /**
   * Re-size the LIVE bag. Every per-frame consumer (the web and film builders in updateWebDrape, mouthFloorRadius,
   * setRimCinch, the contents-floor clamps) reads the handle's `coneHeight`, `mouthRadius`, `closedRadius` and
   * `_mouthZ`, so writing them is the whole change: a held mother bag shrinks onto its catch instead of keeping the
   * 6.8 m flight cone. Nothing is rebuilt (vertex counts don't depend on size). Build-time values are remembered for
   * resetBagShape; `closedRadius` keeps the build-time ratio to the mouth (DRAWSTRING_RADIUS_FRAC_CLOSED).
   * @param {number} coneHeight apex -> mouth plane, scene units (> 0)
   * @param {number} mouthRadius open-mouth radius, scene units (> 0)
   */
  setBagShape(h, coneHeight, mouthRadius) {
    if (!h || !(coneHeight > 0) || !(mouthRadius > 0)) return;
    if (!h._bagBase) {
      h._bagBase = { coneHeight: h.coneHeight, mouthRadius: h.mouthRadius, closedRadius: h.closedRadius, mouthZ: h._mouthZ };
    }
    const frac = h._bagBase.closedRadius / h._bagBase.mouthRadius;
    h.coneHeight = coneHeight;
    h.mouthRadius = mouthRadius;
    h.closedRadius = mouthRadius * frac;
    h._mouthZ = -coneHeight;
    h._mouthZEff = -coneHeight;     // updateWebDrape re-derives it every frame; this keeps a pre-draw read consistent
  },

  /** Put the build-time bag size back (no-op when setBagShape never ran). */
  resetBagShape(h) {
    const b = h && h._bagBase;
    if (!b) return;
    h.coneHeight = b.coneHeight;
    h.mouthRadius = b.mouthRadius;
    h.closedRadius = b.closedRadius;
    h._mouthZ = b.mouthZ;
    h._mouthZEff = b.mouthZ;
    h._bagBase = null;
  },

  /** Tint the web (cone colour); drawstring/hub keep their fixed hues. @param {number} hex colour */
  setColor(h, hex) {
    if (h.coneMesh && h.coneMesh.material) h.coneMesh.material.color.setHex(hex);
    if (h.membraneMat) h.membraneMat.color.setHex(hex);
  },

  /**
   * Opacity on the web cone + drawstring and on the (fade-able) nodes + apex hub. Non-transparent materials (e.g. the
   * daughter's opaque nodes / hub) are left untouched: opacity has no render effect there.
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
   * Capture the handle's live per-surface opacities as a fade SEED. The fade's first frame must equal the last
   * state-driven frame on every faded surface (never a pop): the ceremony state machine holds the cone at 0.55 (or the
   * SECURE_CHECK pulse's last sample) while membrane / drawstring / weights / apex hub rest at their build values, so
   * no single scalar seed is continuous everywhere. One allocation per capture; setOpacityScaled allocates nothing.
   * @returns {{cone:number, membrane:number|null, drawstring:number|null,
   *            weights:number[], apex:number|null}}
   */
  captureOpacity(h) {
    return {
      cone: (h.coneMesh && h.coneMesh.material) ? h.coneMesh.material.opacity : 1,
      membrane: h.membraneMat ? h.membraneMat.opacity : null,
      drawstring: (h.drawstringLine && h.drawstringLine.material) ? h.drawstringLine.material.opacity : null,
      weights: h.rimWeightMats.map(m => m.opacity),
      apex: (h.apexHub && h.apexHub.material) ? h.apexHub.material.opacity : null,
    };
  },

  /**
   * Fade every fade-able surface from its captured seed by s ∈ [0,1] (1 = the live frame, 0 = gone): the seeded
   * counterpart of setOpacity (absolute, for the lasso's fade driver). Non-transparent weight/hub materials are
   * skipped as in setOpacity. The membrane fades from ITS OWN live value, so the membrane:web ratio holds through the
   * fade instead of snapping to _membraneOpacityFrac at fade start. No allocations.
   * @param {object} seed — a captureOpacity() snapshot
   */
  setOpacityScaled(h, seed, s) {
    if (h.coneMesh && h.coneMesh.material) h.coneMesh.material.opacity = seed.cone * s;
    if (h.membraneMat && seed.membrane != null) h.membraneMat.opacity = seed.membrane * s;
    if (h.drawstringLine && h.drawstringLine.material && seed.drawstring != null) {
      h.drawstringLine.material.opacity = seed.drawstring * s;
    }
    for (let i = 0; i < h.rimWeightMats.length; i++) {
      const mat = h.rimWeightMats[i];
      if (mat.transparent) mat.opacity = seed.weights[i] * s;
    }
    if (h.apexHub && h.apexHub.material && h.apexHub.material.transparent && seed.apex != null) {
      h.apexHub.material.opacity = seed.apex * s;
    }
  },

  /** Rotate the web about its local Z axis by repositioning the rim nodes (the consumer drives spin per-node, not via the
   *  group quaternion). @param {number} angle radians */
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
   * The radius the contents floor demands at the MOUTH plane: max over the spokes of the clamped floor at `h._mouthZ`
   * (0 when no contents reach it). The SAME value the kit's own `setCinchedRim` / `setMouthFraction` floor at, exposed
   * so CaptureNetVisual's cinch furniture (`_setCinchedRim`, the CINCH_CLOSING sweep) can ride it instead of closing
   * THROUGH a catch whose silhouette reaches the mouth plane. Reads the handle's stored contents spec, never a
   * re-derived floor. Pure; no allocations. Null-safe (a handle-less consumer reads 0).
   * @returns {number} floor radius at the mouth plane (scene units), ≥ 0
   */
  mouthFloorRadius(h) {
    if (!h) return 0;
    return _mouthFloorMax(h);
  },

  /** Render the rim nodes + drawstring as a STATIC fully-cinched ring at the closed radius on the mouth plane (frozen, no
   *  spin advance). */
  setCinchedRim(h) {
    // Floor the cinched ring at the contents envelope on the mouth plane (0 when the far face stops short of the mouth, so
    // the ring still closes to closedRadius). Clamped to mouthRadius (inside contentsFloorClamped); max over the spoke
    // angles (box floor).
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

  /** Rebuild drawstring vertices from the rim-node positions (apex→w0→apex→w1→…→apex→wN-1→apex→w0). No allocations. */
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
   * Set the fat-line resolution (px) for all live web materials. Optional (the kit already syncs on window resize); for
   * consumers with a custom render target, or tests.
   * @param {number} w viewport width px
   * @param {number} hgt viewport height px
   */
  setResolution(w, hgt) {
    if (w > 0 && hgt > 0) {
      _resolution.w = w; _resolution.h = hgt;
      for (const m of _liveLineMats) m.resolution.set(w, hgt);
    }
  },

  /** Register an external fat-line LineMaterial (e.g. a tether) so it shares the web's resolution sync; seeded with the
   *  current resolution immediately. */
  registerLineMaterial(mat) {
    if (mat) { mat.resolution.set(_resolution.w, _resolution.h); _liveLineMats.add(mat); }
  },

  /**
   * Apply the synthetic orbital env texture (sun disk + Earth hemisphere, baked once per renderer by getOrbitalFoilEnv)
   * to every live membrane material AND cache it for membranes built later. The cache is the load-bearing part:
   * SceneManager calls this from its constructor, before any net exists. Null/undefined is a no-op (headless leaves
   * envMap null, so scene.environment applies). Mirrors setResolution / `_resolution`.
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
   * Per-frame drape/shrink-wrap update: rebuilds the web vertex positions from the drape state into the fat-line
   * geometry. Allocation-free: `h.webPositions` is the backing `.array` of the instanced-interleaved buffer captured at
   * build (`h.webBuffer`), so it is written in place and the buffer flagged dirty (no `geometry.setPositions`, which
   * reallocates buffers and recomputes both bounding volumes every frame). Frustum culling is unaffected:
   * `coneMesh.frustumCulled = false` (set at build).
   *
   * @param {object} h handle
   * @param {object} drapeState
   * @param {number} drapeState.drape       0 = flight cone, 1 = draped on catch
   * @param {number} [drapeState.cinchFrac] 0 = open, 1 = bunched point
   * @param {number} [drapeState.jigglePhase] settle-jiggle phase (rad)
   * @param {number} [drapeState.jiggleAmp]   settle-jiggle amplitude (scene units)
   * @param {number} [drapeState.contentsRadius] rendered radius of the bag's contents (scene units). The drawn web +
   *   membrane floor on a spherical envelope around the contents (contentsFloorRadius) once drape > 0, so the cinch
   *   tightens ONTO the catch and stops. 0 = no contents (a miss still bunches to a point: that contrast sells a catch).
   * @param {number} [drapeState.contentsZ] contents centre in kit-local z (scene units, negative = ahead of the apex).
   *   Also re-aims the membrane's contact dent to the actual seat instead of the fixed t = 0.75.
   * @param {object} [drapeState.contentsBox] the catch's oriented-box spec {ox,oy,oz, r00…r22, hx,hy,hz} (kit space,
   *   scene units; see contentsFloorRadiusBox). Takes precedence over the sphere floor when valid: the film wraps the
   *   catch's REAL extents. The kit COPIES the 15 numbers into a per-handle spec (allocated once per handle), so the
   *   consumer may reuse a scratch object across visuals/frames.
   * @param {THREE.Vector3} [drapeState.localCamPos] camera position in the kit's LOCAL frame (the consumer transforms
   *   world→local and passes it in as data, preserving the pure-local-space rule). When present, depth shading
   *   rewrites the vertex colours: the far side of the bag recedes.
   * @param {number} [drapeState.catchSizeM] the catch's LOGICAL size in metres (debris.sizeMeter; NOT the floored
   *   rendered radius, which pops at reel entry). Drives the size-aware welded film rest: ≤ 0 / absent keeps the plain
   *   MEMBRANE_OPACITY_WELDED fade.
   */
  updateWebDrape(h, { drape = 0, cinchFrac = 0, jigglePhase = 0, jiggleAmp = 0,
                      contentsRadius = 0, contentsZ = 0, contentsBox = null, localCamPos,
                      catchSizeM = 0, mouthGather = 0 } = {}) {
    if (!h || !h.webPositions || !h.coneMesh) return;
    h._drape = drape;
    h._cinchFrac = cinchFrac;
    h._jigglePhase = jigglePhase;
    h._jiggleAmp = jiggleAmp;
    h._catchSizeM = catchSizeM;
    // 0 (default) is byte-identical everywhere; the LASSO wrap ramps it after the cinch so the mouth-side fabric gathers
    // toward the piece (drawstring-rosette language) instead of trailing as an empty sock. Ring-z lever only.
    h._mouthGather = mouthGather;
    // Fade the film toward the welded rest as the drawstring closes, so the catch reads through its own wrap instead of
    // vanishing behind an opaque tent (the closed DoubleSide film at 0.28 compounds to ~0.5 over its own back face).
    // Driven by cinchFrac (smooth; a failure release ramps it home). Written only while the bag is DRIVEN (drape/cinch
    // > 0): the relax-home call after a miss passes (0, 0), and writing base there would fight the fade timer that owns
    // opacity from the miss on (test-CaptureNetVisual pins that ordering).
    // The welded rest is size-aware: a sub-metre catch's closed bag is a thin near-axis bundle whose film at 0.13 is
    // effectively invisible, so the rest lerps 0.13 → MEMBRANE_OPACITY_WELDED_SMALL across the
    // [LARGE_SIZE_M … SMALL_SIZE_M] logical-size band. catchSizeM ≤ 0 (miss bags, legacy mocks, no-target drivers) keeps
    // the plain welded rest. No geometry change either way.
    if (h.membraneMat && h._membraneBaseOpacity != null && (drape > 0 || cinchFrac > 0)) {
      let welded = NET_WEB.MEMBRANE_OPACITY_WELDED ?? h._membraneBaseOpacity;
      const small = NET_WEB.MEMBRANE_OPACITY_WELDED_SMALL;
      const szHi = NET_WEB.MEMBRANE_WELDED_LARGE_SIZE_M ?? 2.0;
      const szLo = NET_WEB.MEMBRANE_WELDED_SMALL_SIZE_M ?? 0.8;
      if (small != null && catchSizeM > 0 && szHi > szLo) {
        const st = clamp01((szHi - catchSizeM) / (szHi - szLo));
        welded += (small - welded) * st;
      }
      const k = clamp01(cinchFrac);
      h.membraneMat.opacity = lerp(h._membraneBaseOpacity, welded, k);
    }
    // Stored on the handle so the probe (main.js) and setCinchedRim read the SAME values the mesh deformed to, never a
    // re-derived copy.
    h._contentsR = contentsRadius;
    h._contentsZ = contentsZ;
    // The box spec likewise, COPIED into a per-handle object (allocated once, then mutated) so live nets never share a
    // driver scratch and the probe reads the identical numbers.
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
    // When the BOX floor is active, redistribute the meridional ring z's onto the floor's cap elbows: ONE table, filled
    // here, read by BOTH builders so film and threads deform identically (the weld). Sphere floor / flight / no-contents
    // ⇒ null ⇒ the natural drapeRingZ z's.
    const gridP = (drape > 0 && contentsBoxValid(h._contentsBox))
      ? {
        coneHeight: h.coneHeight, radialSpokes: h.radialSpokes, rings: h.rings,
        drape, contentsBox: h._contentsBox, cosA: h._cosA, sinA: h._sinA,
        mouthGather,
      }
      : null;
    const ringZ = gridP ? _ringZGrid(h._ringZ, gridP) : null;
    // The EFFECTIVE mouth plane: the float64 rosette plane when the gather moved ring `rings` (reported by the grid pass;
    // never a float32 read-back), else the kit mouth plane. setRimCinch and _mouthFloorMax read it so the drawstring
    // beads ride the gathered fabric; with gather 0 it IS h._mouthZ.
    h._mouthZEff = (gridP && Number.isFinite(gridP.mouthPlaneOut))
      ? gridP.mouthPlaneOut : h._mouthZ;
    const gatherRim = mouthGather > 0 && !!ringZ;
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
      gatherRim,
    });
    // In-place GPU push: no new geometry/attribute/buffer, no bounds recompute.
    const buf = h.webBuffer || h.coneMesh.geometry.attributes.instanceStart.data;
    buf.needsUpdate = true;
    // The membrane film rebuilds from the SAME drape state + cached trig, so film and threads deform identically.
    // Normals recomputed in place.
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
        // Aim the contact dent at the ACTUAL seat (ring index of the contents' depth) instead of the fixed 0.75, which
        // peaked the dent ~1.4 m ahead of the catch. depthToRingT clamps to [0,1].
        contactT: contentsRadius > 0
          ? depthToRingT(-contentsZ, h.coneHeight, drape)
          : 0.75,
        cosA: h._cosA,
        sinA: h._sinA,
        angA: h._angA,
        ringZ,
        gatherRim,
        // Contact compression: the film (not the threads) dents where the catch presses; depth = SSOT fraction of the
        // mouth radius.
        compressM: NET_WEB.CONTACT_COMPRESS_FRAC * h.mouthRadius,
      });
      h.membraneMesh.geometry.attributes.position.needsUpdate = true;
      h.membraneMesh.geometry.computeVertexNormals();
    }
    // Cinch flash: the rim-node emissive ramps briefly past the 2.5 bloom threshold as the bag seats, then settles. Driven
    // from the same cinchFrac as the threads: ramp in over [0.6, 0.85], PEAK from 0.85 (the cinch snap lands ≥ 0.85),
    // then decay over NODE_FLASH_SETTLE_S of wall clock.
    {
      const baseEI = NET_WEB.NODE_EMISSIVE_BASE;
      const peakEI = NET_WEB.NODE_EMISSIVE_CINCH_PEAK;
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
      let ei = baseEI;
      if (cinchFrac >= 0.85) {
        if (h._flashPeakT == null) h._flashPeakT = now;
        const settle = Math.max(0, 1 - (now - h._flashPeakT) / NET_WEB.NODE_FLASH_SETTLE_S);
        ei = lerp(baseEI, peakEI, settle);
      } else if (cinchFrac >= 0.6) {
        h._flashPeakT = null;
        ei = lerp(baseEI, peakEI, (cinchFrac - 0.6) / 0.25);
      } else {
        h._flashPeakT = null;
      }
      // Contact rim light: the drape's rising edge marks the bag's first touch of the catch; a brief sub-bloom bump
      // settles over CONTACT_FLASH_SETTLE_S (the cinch flash owns the bloom crossing). Cleared at drape 0 to re-arm.
      if (drape <= 0) h._contactFlashT = null;
      if (drape > 0 && (h._drapePrev ?? 0) <= 0) h._contactFlashT = now;
      h._drapePrev = drape;
      if (h._contactFlashT != null) {
        const settle = Math.max(0, 1 - (now - h._contactFlashT) / NET_WEB.CONTACT_FLASH_SETTLE_S);
        if (settle <= 0) h._contactFlashT = null;
        else ei = Math.max(ei, lerp(baseEI, NET_WEB.CONTACT_FLASH_PEAK, settle));
      }
      for (const m of h.rimWeightMats) m.emissiveIntensity = ei;
    }
    // Per-thread depth shading: dim each vertex toward DEPTH_DIM_FRACTION of the base colour across the bag's OWN
    // view-depth extent (self-normalizing, so it reads at any camera range); depthWrite stays false. In-place write,
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
   * Tear a wedge of spokes out of the web (boost-reel RIP staging): zeroes the per-vertex colours of the radial spoke
   * segments AND their ring segments across [spokeStart, +spokeCount), so those threads render black (invisible against
   * the sky): a hole the released catch drifts out of. One in-place write on the buffer the depth pass would otherwise
   * rewrite per frame; safe because a torn bag is DETACHED (CaptureNetVisual) and never re-runs updateWebDrape.
   * Segment layout (buildWebPositions): radialSpokes apex→rim segments first (6 floats each), then `rings` rings of
   * radialSpokes rim-neighbour segments. The membrane (one mesh, no per-face colour) is not torn.
   * @param {number} spokeStart first torn spoke index
   * @param {number} spokeCount wedge width (spokes)
   */
  tearWedge(h, spokeStart, spokeCount) {
    if (!h || !h.webColorBuffer) return;
    const col = h.webColorBuffer.array;
    const spokes = h.radialSpokes, rings = h.rings;
    for (let w = 0; w < spokeCount; w++) {
      const s = (((spokeStart + w) % spokes) + spokes) % spokes;
      col.fill(0, 6 * s, 6 * s + 6);                       // radial spoke segment
      for (let k = 0; k < rings; k++) {
        const seg = spokes + k * spokes + s;               // ring k, spoke s→s+1
        col.fill(0, 6 * seg, 6 * seg + 6);
      }
    }
    h.webColorBuffer.needsUpdate = true;
  },

  /** Free all geometry + materials owned by the handle; the caller removes `handle.group` from the scene. */
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
