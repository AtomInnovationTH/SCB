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
 * Stage A reproduces the daughter's cone + rim + drawstring + apex 1:1 (extracted
 * from `_createCeremonyVisual`); Stage B (browser-tuned) can upgrade the cone
 * wireframe to a finer spoke+ring web behind the same handle/API.
 *
 * @module ui/NetMeshKit
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';

/** 1 metre in scene units (1 scene unit = 100 km). Matches both consumers. */
const M = 1e-5;

const NET_CER = Constants.CAPTURE_NET.NET_CEREMONY;

// ── Default look (shared web vocabulary) ────────────────────────────────────
// COOL pre-contact tint, matching the daughter's COL_DISC so the unify is 1:1.
const DEFAULT_WEB_COLOR     = 0x88aacc;
const DEFAULT_WEB_OPACITY   = 0.55;
const DEFAULT_DRAWSTRING_COLOR = 0xffaa44;
const DEFAULT_WEIGHT_COLOR  = 0x888888;
const DEFAULT_APEX_COLOR    = 0x665544;
const DEFAULT_APEX_RADIUS_M = 0.05;

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
   * @param {number} [opts.coneRadialSegments=16]
   * @param {number} [opts.coneHeightSegments=4]
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
      coneRadialSegments = 16,
      coneHeightSegments = 4,
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

    // ── Cone "web" (apex at origin, mouth at local −Z) ──
    const mouthRadius = M * (D / 2) * coneOpenRadiusFrac;
    const coneHeight  = mouthRadius * 2 * coneLengthFrac;
    // ConeGeometry: base at y=−h/2, apex at y=+h/2; open-ended wireframe.
    const coneGeo = new THREE.ConeGeometry(
      mouthRadius, coneHeight, coneRadialSegments, coneHeightSegments, true);
    // rotateX(PI/2): (x,y,z)→(x,−z,y) → apex at z=+h/2, base at z=−h/2.
    coneGeo.rotateX(Math.PI / 2);
    // Translate so apex at origin (z=0) and mouth at z=−coneHeight.
    coneGeo.translate(0, 0, -coneHeight / 2);
    const coneMat = new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      wireframe: true,
    });
    const coneMesh = new THREE.Mesh(coneGeo, coneMat);
    coneMesh.name = 'cone';
    coneMesh.visible = childrenVisible;
    group.add(coneMesh);

    // ── Rim weight spheres (edge-node glints) ──
    // Weights sit at the mouth plane (z = −coneHeight) at the open radius.
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
        metalness: 0.9,
        roughness: 0.3,
        emissive: new THREE.Color(0x000000),
        transparent: weightTransparent,
        opacity,
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
   * Free all geometry + materials owned by the handle. The caller owns removing
   * `handle.group` from the scene.
   * @param {object} h handle
   */
  dispose(h) {
    if (!h) return;
    if (h.coneMesh) {
      h.coneMesh.geometry.dispose();
      h.coneMesh.material.dispose();
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
