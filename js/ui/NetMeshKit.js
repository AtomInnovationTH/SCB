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
function drapeRingRadius(t, spokeAngle, mouthRadius, drape, cinch, closed, jigA, jigP) {
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
function drapeRingZ(t, coneHeight, drape) {
  let z = -coneHeight * t;
  if (drape > 0) {
    // Push the mouth-side rings forward past the mouth plane (engulf).
    z -= drape * coneHeight * (1 - t) * 0.9 * t;
  }
  return z;
}

function buildWebPositionsDraped(out, p) {
  const { mouthRadius, coneHeight, radialSpokes, rings } = p;
  const drape = Math.max(0, Math.min(1, p.drape ?? 0));
  const cinch = Math.max(0, Math.min(1, p.cinchFrac ?? 0));
  const jigP = p.jigglePhase ?? 0;
  const jigA = p.jiggleAmp ?? 0;
  const closed = NET_CER.DRAWSTRING_RADIUS_FRAC_CLOSED;   // SSOT (was hardcoded 0.15)
  // P2: per-spoke cos/sin/angle are fixed for the life of the handle (radialSpokes
  // never changes), so the consumer passes cached tables in. When absent (a test
  // calling this directly), fall back to computing them — correctness over speed.
  const cosA = (p.cosA && p.cosA.length === radialSpokes) ? p.cosA : null;
  const sinA = (p.sinA && p.sinA.length === radialSpokes) ? p.sinA : null;
  const angA = (p.angA && p.angA.length === radialSpokes) ? p.angA : null;
  let idx = 0;

  // Radial spokes: apex → rim (t = 1; the drape z-term vanishes at the mouth).
  const zRim = drapeRingZ(1, coneHeight, drape);
  for (let s = 0; s < radialSpokes; s++) {
    const a  = angA ? angA[s] : (2 * Math.PI * s) / radialSpokes;
    const ca = cosA ? cosA[s] : Math.cos(a);
    const sa = sinA ? sinA[s] : Math.sin(a);
    const r = drapeRingRadius(1, a, mouthRadius, drape, cinch, closed, jigA, jigP);
    out[idx++] = 0; out[idx++] = 0; out[idx++] = 0;
    out[idx++] = ca * r; out[idx++] = sa * r; out[idx++] = zRim;
  }
  // Rings.
  for (let k = 1; k <= rings; k++) {
    const t = k / rings;
    const z = drapeRingZ(t, coneHeight, drape);
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
      const r0 = drapeRingRadius(t, a0, mouthRadius, drape, cinch, closed, jigA, jigP);
      const r1 = drapeRingRadius(t, a1, mouthRadius, drape, cinch, closed, jigA, jigP);
      out[idx++] = c0 * r0; out[idx++] = n0 * r0; out[idx++] = z;
      out[idx++] = c1 * r1; out[idx++] = n1 * r1; out[idx++] = z;
    }
  }
  return out;
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
  const cosA = (p.cosA && p.cosA.length === radialSpokes) ? p.cosA : null;
  const sinA = (p.sinA && p.sinA.length === radialSpokes) ? p.sinA : null;
  const angA = (p.angA && p.angA.length === radialSpokes) ? p.angA : null;
  let idx = 0;
  for (let k = 0; k <= rings; k++) {
    const t = k / rings;
    const z = drapeRingZ(t, coneHeight, drape);
    for (let s = 0; s < radialSpokes; s++) {
      const a  = angA ? angA[s] : (2 * Math.PI * s) / radialSpokes;
      const ca = cosA ? cosA[s] : Math.cos(a);
      const sa = sinA ? sinA[s] : Math.sin(a);
      const r = drapeRingRadius(t, a, mouthRadius, drape, cinch, closed, jigA, jigP);
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
    {
      // Static index buffer (topology never changes; only positions/norms move).
      const memIndex = [];
      for (let k = 0; k < rings; k++) {
        for (let s = 0; s < radialSpokes; s++) {
          const s1 = (s + 1) % radialSpokes;
          const a = k * radialSpokes + s, b = k * radialSpokes + s1;
          const c = (k + 1) * radialSpokes + s, d = (k + 1) * radialSpokes + s1;
          memIndex.push(a, c, b, b, c, d);
        }
      }
      membraneGeo.setIndex(memIndex);
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
        emissiveIntensity: 0.6,
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
      // P2: cached per-spoke trig (projection is fixed; only jiggle recomputes)
      _cosA,
      _sinA,
      _angA,
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
    const r = h.mouthRadius * f;
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
    for (let i = 0; i < h.weightCount; i++) {
      const a = h._rimAngles[i] + h._spinAngle;
      h.rimWeights[i].position.set(
        Math.cos(a) * h.closedRadius,
        Math.sin(a) * h.closedRadius,
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
   * material. Null/undefined is a no-op — headless builds leave envMap unset
   * and scene.environment applies instead. Mirrors setResolution.
   * @param {THREE.Texture|null} tex
   */
  setEnvTexture(tex) {
    if (!tex) return;
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
   * @param {THREE.Vector3} [drapeState.localCamPos] camera position in the kit's
   *   LOCAL frame (consumer world→local transforms it and passes it in as data,
   *   preserving the kit's pure-local-space rule). When present, V4 depth
   *   shading rewrites the vertex colours: the far side of the bag recedes.
   */
  updateWebDrape(h, { drape = 0, cinchFrac = 0, jigglePhase = 0, jiggleAmp = 0, localCamPos } = {}) {
    if (!h || !h.webPositions || !h.coneMesh) return;
    h._drape = drape;
    h._cinchFrac = cinchFrac;
    h._jigglePhase = jigglePhase;
    h._jiggleAmp = jiggleAmp;
    buildWebPositionsDraped(h.webPositions, {
      mouthRadius: h.mouthRadius,
      coneHeight: h.coneHeight,
      radialSpokes: h.radialSpokes,
      rings: h.rings,
      drape,
      cinchFrac,
      jigglePhase,
      jiggleAmp,
      cosA: h._cosA,
      sinA: h._sinA,
      angA: h._angA,
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
        cosA: h._cosA,
        sinA: h._sinA,
        angA: h._angA,
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
