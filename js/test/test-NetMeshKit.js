/**
 * test-NetMeshKit.js — unit tests for the shared net-mesh factory.
 *
 * Verifies the strictly-local-space construction + setters that BOTH capture
 * nets (Mother LassoSystem, Daughter CaptureNetVisual) share:
 *   - build() produces cone + rim weights + drawstring + apex hub at the right
 *     counts for D = 8 / 5 / 1.5
 *   - apex at local origin, mouth at local −Z
 *   - setMouthFraction scales rim XY monotonically + clamps (no NaN)
 *   - setColor / setOpacity apply
 *   - setCinchedRim pins the rim at the closed radius on the mouth plane
 *   - dispose frees geometry + materials
 */

import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { NetMeshKit } from '../ui/NetMeshKit.js';
import { Constants } from '../core/Constants.js';

const M = 1e-5;
const NET_CER = Constants.CAPTURE_NET.NET_CEREMONY;

function maxRimRadius(h) {
  let max = 0;
  for (const w of h.rimWeights) {
    const r = Math.hypot(w.position.x, w.position.y);
    if (r > max) max = r;
  }
  return max;
}

describe('NetMeshKit — build() structure', () => {
  it('builds cone + rim weights + drawstring + apex for D=8 (8 weights)', () => {
    const h = NetMeshKit.build({ diameter: 8, weightCount: 8 });
    assert.ok(h.coneMesh, 'coneMesh exists');
    assert.ok(h.coneMesh.geometry, 'cone has geometry');
    assert.equal(h.rimWeights.length, 8, '8 rim weights');
    assert.equal(h.rimWeightMats.length, 8, '8 rim materials');
    assert.ok(h.drawstringLine, 'drawstring line exists');
    assert.ok(h.apexHub, 'apex hub exists');
    assert.equal(h.drawstringPositions.length, (8 * 2 + 2) * 3, 'drawstring buffer size');
    assert.equal(h.weightCount, 8, 'weightCount cached');
    NetMeshKit.dispose(h);
  });

  it('builds for D=5 (4 weights) and D=1.5 (4 weights)', () => {
    const h5 = NetMeshKit.build({ diameter: 5, weightCount: 4 });
    assert.equal(h5.rimWeights.length, 4, 'D=5 → 4 weights');
    assert.equal(h5.drawstringPositions.length, (4 * 2 + 2) * 3, 'drawstring sized for 4');
    NetMeshKit.dispose(h5);

    const h15 = NetMeshKit.build({ diameter: 1.5, weightCount: 4 });
    assert.equal(h15.rimWeights.length, 4, 'D=1.5 → 4 weights');
    NetMeshKit.dispose(h15);
  });

  it('caches mouthRadius / coneHeight / closedRadius from the frac knobs', () => {
    const D = 8;
    const h = NetMeshKit.build({ diameter: D, weightCount: 8 });
    const expectedR = M * (D / 2) * NET_CER.CONE_OPEN_RADIUS_FRAC;
    const expectedH = expectedR * 2 * NET_CER.CONE_LENGTH_FRAC;
    assert.ok(Math.abs(h.mouthRadius - expectedR) < 1e-12, 'mouthRadius correct');
    assert.ok(Math.abs(h.coneHeight - expectedH) < 1e-12, 'coneHeight correct');
    assert.ok(Math.abs(h.closedRadius - expectedR * NET_CER.DRAWSTRING_RADIUS_FRAC_CLOSED) < 1e-12,
      'closedRadius correct');
    NetMeshKit.dispose(h);
  });

  it('apex at local origin, mouth at local −Z', () => {
    const h = NetMeshKit.build({ diameter: 8, weightCount: 8 });
    // Apex hub sits at the group origin.
    assert.ok(h.apexHub.position.lengthSq() === 0, 'apex hub at origin');
    // Rim weights (mouth plane) sit at z = −coneHeight (negative → local −Z).
    assert.ok(Math.abs(h.rimWeights[0].position.z - (-h.coneHeight)) < 1e-12,
      'rim weights on the −Z mouth plane');
    assert.ok(h.rimWeights[0].position.z < 0, 'mouth is on local −Z');
    NetMeshKit.dispose(h);
  });

  it('builds a spoke+ring fat-line web with the expected vertex count', () => {
    const radialSpokes = 16;
    const rings = 4;
    const h = NetMeshKit.build({ diameter: 8, weightCount: 8, radialSpokes, rings });
    assert.ok(h.coneMesh.isLineSegments2, 'web is a fat-line LineSegments2');
    assert.equal(h.webLines, h.coneMesh, 'webLines aliases coneMesh');
    assert.ok(h.lineMaterial && h.lineMaterial.isLineMaterial, 'exposes the web LineMaterial');
    // spokes: radialSpokes × 2 verts; rings: rings × radialSpokes × 2 verts.
    const expectedVerts = radialSpokes * 2 + rings * radialSpokes * 2;
    // Fat-line geometry stores interleaved instance attributes, not a plain
    // 'position' — the raw endpoint buffer is exposed on the handle instead.
    assert.equal(h.webPositions.length / 3, expectedVerts, 'web vertex count = spokes + rings');
    // First spoke starts at the apex (local origin).
    assert.equal(h.webPositions[0], 0, 'spoke 0 apex x=0');
    assert.equal(h.webPositions[1], 0, 'spoke 0 apex y=0');
    assert.equal(h.webPositions[2], 0, 'spoke 0 apex z=0');
    NetMeshKit.dispose(h);
  });

  it('web threads stay flat (NormalBlending); nodeAdditive toggles edge-node glint', () => {
    // The web is always flat-translucent (additive made the threads read cold).
    const h = NetMeshKit.build({ diameter: 8, weightCount: 8, nodeAdditive: true });
    assert.equal(h.coneMesh.material.blending, THREE.NormalBlending, 'web threads NormalBlending');
    assert.equal(h.coneMesh.material.depthWrite, false, 'web does not write depth');
    assert.equal(h.rimWeightMats[0].blending, THREE.AdditiveBlending, 'node glint additive on');
    NetMeshKit.dispose(h);
    const hNorm = NetMeshKit.build({ diameter: 8, weightCount: 8, nodeAdditive: false });
    assert.equal(hNorm.rimWeightMats[0].blending, THREE.NormalBlending, 'node glint additive off');
    NetMeshKit.dispose(hNorm);
  });

  it('supports weightCount = 0 (pure-thread web, no nodes)', () => {
    const h = NetMeshKit.build({ diameter: 8, weightCount: 0 });
    assert.equal(h.rimWeights.length, 0, 'no rim weights');
    assert.equal(h.weightGeo, null, 'no shared weight geometry');
    assert.ok(h.coneMesh, 'cone still built');
    // setters must not throw with no nodes
    NetMeshKit.setMouthFraction(h, 0.5);
    NetMeshKit.setCinchedRim(h);
    NetMeshKit.dispose(h);
  });
});

describe('NetMeshKit — setMouthFraction', () => {
  it('scales rim XY monotonically with the fraction', () => {
    const h = NetMeshKit.build({ diameter: 8, weightCount: 8 });
    NetMeshKit.setMouthFraction(h, 1.0);
    const full = maxRimRadius(h);
    assert.ok(Math.abs(full - h.mouthRadius) < h.mouthRadius * 0.02, 'frac=1 → full radius');
    NetMeshKit.setMouthFraction(h, 0.5);
    const half = maxRimRadius(h);
    assert.ok(Math.abs(half - h.mouthRadius * 0.5) < h.mouthRadius * 0.02, 'frac=0.5 → half radius');
    assert.ok(half < full, 'monotonic: smaller frac → smaller radius');
    NetMeshKit.dispose(h);
  });

  it('clamps out-of-range fractions and stays finite (no NaN)', () => {
    const h = NetMeshKit.build({ diameter: 8, weightCount: 8 });
    NetMeshKit.setMouthFraction(h, -5); // clamps to 0.05 floor
    const r = maxRimRadius(h);
    assert.ok(Number.isFinite(r) && r > 0, 'clamped to small positive finite radius');
    NetMeshKit.setMouthFraction(h, 99); // clamps to 1
    assert.ok(Math.abs(maxRimRadius(h) - h.mouthRadius) < h.mouthRadius * 0.02, 'clamps high to 1');
    // Drawstring positions remain finite.
    for (let i = 0; i < h.drawstringPositions.length; i++) {
      assert.ok(Number.isFinite(h.drawstringPositions[i]), 'drawstring vertex finite');
    }
    NetMeshKit.dispose(h);
  });

  it('keeps the cone axial length intact (scales XY only)', () => {
    const h = NetMeshKit.build({ diameter: 8, weightCount: 8 });
    NetMeshKit.setMouthFraction(h, 0.3);
    assert.ok(Math.abs(h.coneMesh.scale.z - 1) < 1e-12, 'cone z-scale unchanged');
    assert.ok(Math.abs(h.coneMesh.scale.x - 0.3) < 1e-12, 'cone x-scale = frac');
    NetMeshKit.dispose(h);
  });
});

describe('NetMeshKit — setColor / setOpacity / setCinchedRim', () => {
  it('setColor tints the cone', () => {
    const h = NetMeshKit.build({ diameter: 8, weightCount: 8 });
    NetMeshKit.setColor(h, 0x00ff44);
    assert.equal(h.coneMesh.material.color.getHex(), 0x00ff44, 'cone colour applied');
    NetMeshKit.dispose(h);
  });

  it('setOpacity applies to cone + drawstring (+ fade-able nodes)', () => {
    const h = NetMeshKit.build({ diameter: 8, weightCount: 8, weightTransparent: true });
    NetMeshKit.setOpacity(h, 0.4);
    assert.ok(Math.abs(h.coneMesh.material.opacity - 0.4) < 1e-12, 'cone opacity');
    assert.ok(Math.abs(h.drawstringLine.material.opacity - 0.4) < 1e-12, 'drawstring opacity');
    assert.ok(Math.abs(h.rimWeightMats[0].opacity - 0.4) < 1e-12, 'fade-able node opacity');
    NetMeshKit.dispose(h);
  });

  it('non-transparent node material opacity is left alone', () => {
    const h = NetMeshKit.build({ diameter: 8, weightCount: 8, weightTransparent: false });
    NetMeshKit.setOpacity(h, 0.4);
    assert.equal(h.rimWeightMats[0].transparent, false, 'node stays opaque');
    NetMeshKit.dispose(h);
  });

  it('Mother-style build (transparent apex + drawstring opacity 0) fades the whole web', () => {
    const h = NetMeshKit.build({
      diameter: 5, weightCount: 6, opacity: 0,
      drawstringOpacity: 0, weightTransparent: true, apexTransparent: true,
    });
    // Whole web starts hidden (opacity 0) — no drawstring/apex flash.
    assert.equal(h.drawstringLine.material.opacity, 0, 'drawstring starts at 0');
    assert.equal(h.apexHub.material.transparent, true, 'apex hub is fade-able');
    assert.equal(h.apexHub.material.opacity, 0, 'apex hub starts at 0');
    NetMeshKit.setOpacity(h, 0.45);
    assert.ok(Math.abs(h.coneMesh.material.opacity - 0.45) < 1e-12, 'cone faded in');
    assert.ok(Math.abs(h.drawstringLine.material.opacity - 0.45) < 1e-12, 'drawstring faded in');
    assert.ok(Math.abs(h.apexHub.material.opacity - 0.45) < 1e-12, 'apex hub faded in');
    NetMeshKit.dispose(h);
  });

  it('daughter-default build keeps drawstring at 0.8 and an opaque apex hub', () => {
    const h = NetMeshKit.build({ diameter: 8, weightCount: 8 });
    assert.equal(h.drawstringLine.material.opacity, 0.8, 'drawstring default 0.8');
    assert.equal(h.apexHub.material.transparent, false, 'apex hub opaque by default');
    NetMeshKit.dispose(h);
  });

  it('setCinchedRim pins the rim at the closed radius on the mouth plane', () => {
    const h = NetMeshKit.build({ diameter: 8, weightCount: 8 });
    NetMeshKit.setCinchedRim(h);
    const r = maxRimRadius(h);
    assert.ok(Math.abs(r - h.closedRadius) < 1e-12, 'rim at closed radius');
    assert.ok(Math.abs(h.rimWeights[0].position.z - (-h.coneHeight)) < 1e-12, 'rim on mouth plane');
    NetMeshKit.dispose(h);
  });

  it('setSpinAngle rotates rim nodes about local Z, preserving radius + z', () => {
    const h = NetMeshKit.build({ diameter: 8, weightCount: 8 });
    const r0 = maxRimRadius(h);
    const z0 = h.rimWeights[0].position.z;
    const before = { x: h.rimWeights[0].position.x, y: h.rimWeights[0].position.y };
    NetMeshKit.setSpinAngle(h, Math.PI / 2);
    // Radius preserved (rotation only), z unchanged, angle actually advanced.
    assert.ok(Math.abs(maxRimRadius(h) - r0) < 1e-9, 'radius preserved under spin');
    assert.ok(Math.abs(h.rimWeights[0].position.z - z0) < 1e-12, 'z unchanged under spin');
    const moved = Math.hypot(
      h.rimWeights[0].position.x - before.x,
      h.rimWeights[0].position.y - before.y,
    );
    assert.ok(moved > 1e-9, 'node 0 actually rotated');
    // Drawstring stays finite after the spin rewrite.
    for (let i = 0; i < h.drawstringPositions.length; i++) {
      assert.ok(Number.isFinite(h.drawstringPositions[i]), 'drawstring vertex finite');
    }
    NetMeshKit.dispose(h);
  });
});

describe('NetMeshKit — dispose', () => {
  it('disposes geometries + materials without throwing', () => {
    const h = NetMeshKit.build({ diameter: 8, weightCount: 8 });
    let disposedGeo = 0;
    let disposedMat = 0;
    h.coneMesh.geometry.dispose = () => { disposedGeo++; };
    h.coneMesh.material.dispose = () => { disposedMat++; };
    h.weightGeo.dispose = () => { disposedGeo++; };
    for (const mat of h.rimWeightMats) mat.dispose = () => { disposedMat++; };
    h.drawstringLine.geometry.dispose = () => { disposedGeo++; };
    h.drawstringLine.material.dispose = () => { disposedMat++; };
    h.apexHub.geometry.dispose = () => { disposedGeo++; };
    h.apexHub.material.dispose = () => { disposedMat++; };

    NetMeshKit.dispose(h);
    // cone geo + weightGeo + drawstring geo + apex geo = 4
    assert.equal(disposedGeo, 4, 'all geometries disposed');
    // cone mat + 8 weight mats + drawstring mat + apex mat = 11
    assert.equal(disposedMat, 1 + 8 + 1 + 1, 'all materials disposed');
  });

  it('dispose(null) is a safe no-op', () => {
    NetMeshKit.dispose(null);
    NetMeshKit.dispose(undefined);
    assert.ok(true, 'no throw on null/undefined');
  });
});
