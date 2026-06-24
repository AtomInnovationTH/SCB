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
const _resolution = { w: 1, h: 1 };
if (typeof window !== 'undefined') {
  _resolution.w = window.innerWidth || 1;
  _resolution.h = window.innerHeight || 1;
}

// ── Default look (shared web vocabulary) ────────────────────────────────────
// Ivory Dyneema thread — fat-line, soft + legible (replaces the rejected cold
// 1-px cyan LineSegments).
const DEFAULT_WEB_COLOR     = (NET_WEB && NET_WEB.WEB_COLOR) || 0xcfeaff;
const DEFAULT_WEB_OPACITY   = (NET_WEB && NET_WEB.WEB_OPACITY) || 0.6;
const DEFAULT_DRAWSTRING_COLOR = 0xffaa44;
const DEFAULT_WEIGHT_COLOR  = 0xeef4ff;   // ivory tungsten edge-node glint
const DEFAULT_APEX_COLOR    = 0x665544;
const DEFAULT_APEX_RADIUS_M = 0.05;
// Fat-line web fineness (orb-weaver spoke + ring). Shared source of truth in
// Constants.NET_WEB so Mother + Daughter render the same web.
const DEFAULT_RADIAL_SPOKES = (NET_WEB && NET_WEB.RADIAL_SPOKES) || 22;
const DEFAULT_RING_COUNT    = (NET_WEB && NET_WEB.RING_COUNT) || 6;
const DEFAULT_LINE_WIDTH_PX = (NET_WEB && NET_WEB.LINE_WIDTH_PX) || 2.0;
const DEFAULT_NODE_ADDITIVE = (NET_WEB && NET_WEB.NODE_ADDITIVE) !== false;

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
    const coneMat = new LineMaterial({
      color,
      transparent: true,
      opacity,
      linewidth: lineWidth,    // screen-space pixels (worldUnits:false)
      worldUnits: false,
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
    group.add(coneMesh);

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

    const handle = {
      group,
      coneMesh,
      webLines: coneMesh,   // alias — the cone IS the fat-line spoke+ring web
      webPositions,         // raw Float32Array of web segment endpoints (apex→rim + rings)
      lineMaterial: coneMat, // the web's LineMaterial (resolution-synced)
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
      // kit-internal layout state (used by setMouthFraction / setSpinAngle)
      _rimAngles: rimAngles,
      _mouthZ: mouthZ,
      _spinAngle: 0,
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

  /** Stop syncing a previously-registered LineMaterial (call on dispose). */
  unregisterLineMaterial(mat) {
    if (mat) _liveLineMats.delete(mat);
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
