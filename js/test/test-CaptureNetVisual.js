/**
 * test-CaptureNetVisual.js — V-8 Capture Net Visual tests
 *
 * Verifies CaptureNetVisual state-machine-driven rendering logic:
 *   - Feature flag gating (init does nothing when off)
 *   - Visual creation (canister, disc, tether per arm/pod)
 *   - State-driven visibility (FOLDED/FLIGHT/CAPTURED/CONTACT/…)
 *   - Cleanup (removeNetVisual, dispose)
 *   - Null-net removal on update
 *   - Pod vs arm key resolution (mother pod nets vs daughter arm nets)
 */

import { describe, it, assert } from './TestRunner.js';
import { CaptureNetVisual } from '../ui/CaptureNetVisual.js';
import { Constants } from '../core/Constants.js';

// ─── Helpers ────────────────────────────────────────────────────────────

function withFlag(value, fn) {
  const prev = Constants.FEATURE_FLAGS.CAPTURE_NET;
  Constants.FEATURE_FLAGS.CAPTURE_NET = value;
  try { fn(); } finally { Constants.FEATURE_FLAGS.CAPTURE_NET = prev; }
}

/** Minimal scene mock — tracks add/remove calls */
function mockScene() {
  return {
    _children: [],
    add(obj)    { this._children.push(obj); },
    remove(obj) {
      const i = this._children.indexOf(obj);
      if (i >= 0) this._children.splice(i, 1);
    },
  };
}

/** Minimal player mock with strutTipNodes */
function mockPlayer() {
  return {
    strutTipNodes: [
      { getWorldPosition(v) { v.set(0, 0, 0); return v; } },
      { getWorldPosition(v) { v.set(0, 0, 0); return v; } },
    ],
  };
}

/**
 * Controllable captureNetSystem mock.
 * @param {object} [armNets] — map of armIndex → mockNet
 * @param {object} [podNets] — map of podIndex → mockNet
 */
function mockCNS(armNets, podNets) {
  return {
    _armNets: armNets || {},
    _podNets: podNets || {},
    getActiveNetForArm(armIndex) {
      return this._armNets[armIndex] || null;
    },
    getActiveNetForPod(podIndex) {
      return this._podNets[podIndex] || null;
    },
  };
}

/** Mock NetProjectile with controllable state */
function mockNet(overrides) {
  return {
    netClass: { DIAMETER: 8, SPIN_HZ: 2, LAUNCH_SPEED: 10 },
    position: { x: 100, y: 200, z: 300 },
    state: 'FOLDED',
    spinRate: 0,
    tetherPaidOut: 0,
    reelProgress: 0,
    capturedMass: 0,
    tangleQuality: 0,
    catchResult: null,
    ...overrides,
  };
}

// ─── Suites ─────────────────────────────────────────────────────────────

describe('CaptureNetVisual — feature-flag gating', () => {
  it('init does nothing when CAPTURE_NET flag is false', () => {
    withFlag(false, () => {
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), mockCNS());
      assert.equal(vis._enabled, false, 'must remain disabled');
    });
  });

  it('init enables when CAPTURE_NET flag is true', () => {
    withFlag(true, () => {
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), mockCNS());
      assert.equal(vis._enabled, true, 'must be enabled');
      vis.dispose();
    });
  });
});

describe('CaptureNetVisual — visual creation', () => {
  it('_createNetVisual creates group with canister, disc, tether', () => {
    withFlag(true, () => {
      const scene = mockScene();
      const vis = new CaptureNetVisual();
      vis.init(scene, mockPlayer(), mockCNS());

      const net = mockNet();
      vis._createNetVisual('arm_0', 0, -1, net);

      assert.equal(vis._activeVisuals.size, 1, 'one visual in map');
      const entry = vis._activeVisuals.get('arm_0');
      assert.ok(entry.group, 'group exists');
      assert.ok(entry.canisterMesh, 'canisterMesh exists');
      assert.ok(entry.discMesh, 'discMesh exists');
      assert.ok(entry.tetherLine, 'tetherLine exists');
      assert.equal(entry.armIndex, 0, 'armIndex stored');
      assert.equal(entry.podIndex, -1, 'podIndex stored');
      assert.equal(scene._children.length, 1, 'group added to scene');
      vis.dispose();
    });
  });

  it('pod key differs from arm key (no collision)', () => {
    withFlag(true, () => {
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), mockCNS());

      vis._createNetVisual('arm_0', 0, -1, mockNet());
      vis._createNetVisual('pod_0', -1, 0, mockNet());

      assert.equal(vis._activeVisuals.size, 2, 'two distinct visuals');
      assert.ok(vis._activeVisuals.has('arm_0'), 'arm_0 exists');
      assert.ok(vis._activeVisuals.has('pod_0'), 'pod_0 exists');
      vis.dispose();
    });
  });
});

describe('CaptureNetVisual — state-driven visibility', () => {
  it('FOLDED: canister visible, disc hidden, tether hidden', () => {
    withFlag(true, () => {
      const net = mockNet({ state: 'FOLDED' });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      assert.equal(entry.canisterMesh.visible, true, 'canister visible');
      assert.equal(entry.discMesh.visible, false, 'disc hidden');
      assert.equal(entry.tetherLine.visible, false, 'tether hidden');
      vis.dispose();
    });
  });

  it('FLIGHT: disc visible, canister hidden', () => {
    withFlag(true, () => {
      const net = mockNet({ state: 'FLIGHT', spinRate: 2 });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      assert.equal(entry.discMesh.visible, true, 'disc visible in FLIGHT');
      assert.equal(entry.canisterMesh.visible, false, 'canister hidden in FLIGHT');
      vis.dispose();
    });
  });

  it('CAPTURED: disc green (0x00ff44)', () => {
    withFlag(true, () => {
      const net = mockNet({ state: 'CAPTURED', catchResult: 'success' });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      assert.equal(entry.discMesh.material.color.getHex(), 0x00ff44, 'disc is green');
      vis.dispose();
    });
  });

  it('CONTACT: disc amber (0xffaa00)', () => {
    withFlag(true, () => {
      const net = mockNet({ state: 'CONTACT' });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      assert.equal(entry.discMesh.material.color.getHex(), 0xffaa00, 'disc is amber');
      vis.dispose();
    });
  });

  it('CINCH_CLOSING: disc blue (0x00aaff)', () => {
    withFlag(true, () => {
      const net = mockNet({ state: 'CINCH_CLOSING', tangleQuality: 0.5 });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      assert.equal(entry.discMesh.material.color.getHex(), 0x00aaff, 'disc is cinch blue');
      vis.dispose();
    });
  });
});

describe('CaptureNetVisual — pod-based lookup', () => {
  it('update uses getActiveNetForPod for mother pod visuals', () => {
    withFlag(true, () => {
      const net = mockNet({ state: 'FLIGHT', spinRate: 2 });
      // Net is keyed under pod, not arm
      const cns = mockCNS({}, { 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('pod_0', -1, 0, net);
      vis.update(0.016);

      // Should still be present (found via getActiveNetForPod)
      assert.equal(vis._activeVisuals.size, 1, 'pod visual still present');
      const entry = vis._activeVisuals.get('pod_0');
      assert.equal(entry.discMesh.visible, true, 'disc visible for pod net in FLIGHT');
      vis.dispose();
    });
  });

  it('update removes pod visual when getActiveNetForPod returns null', () => {
    withFlag(true, () => {
      const cns = mockCNS({}, { 0: mockNet() });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('pod_0', -1, 0, mockNet());
      assert.equal(vis._activeVisuals.size, 1, 'pod visual exists');

      cns._podNets = {}; // remove pod net
      vis.update(0.016);
      assert.equal(vis._activeVisuals.size, 0, 'pod visual removed when net null');
      vis.dispose();
    });
  });
});

describe('CaptureNetVisual — cleanup', () => {
  it('_removeNetVisual cleans up and removes from map', () => {
    withFlag(true, () => {
      const scene = mockScene();
      const vis = new CaptureNetVisual();
      vis.init(scene, mockPlayer(), mockCNS());
      vis._createNetVisual('arm_0', 0, -1, mockNet());
      assert.equal(vis._activeVisuals.size, 1, 'visual exists before removal');

      vis._removeNetVisual('arm_0');
      assert.equal(vis._activeVisuals.size, 0, 'visual removed from map');
      assert.equal(scene._children.length, 0, 'group removed from scene');
      vis.dispose();
    });
  });

  it('update removes visual when net returns null', () => {
    withFlag(true, () => {
      const cns = mockCNS({ 0: mockNet() });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, mockNet());
      assert.equal(vis._activeVisuals.size, 1, 'visual exists');

      // Make CNS return null
      cns._armNets = {};
      vis.update(0.016);
      assert.equal(vis._activeVisuals.size, 0, 'visual removed when net is null');
      vis.dispose();
    });
  });

  it('dispose clears all visuals and disables', () => {
    withFlag(true, () => {
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), mockCNS());
      vis._createNetVisual('arm_0', 0, -1, mockNet());
      vis._createNetVisual('arm_1', 1, -1, mockNet({ netClass: { DIAMETER: 5, SPIN_HZ: 3, LAUNCH_SPEED: 12 } }));
      assert.equal(vis._activeVisuals.size, 2, 'two visuals before dispose');

      vis.dispose();
      assert.equal(vis._activeVisuals.size, 0, 'all visuals cleared');
      assert.equal(vis._enabled, false, 'disabled after dispose');
    });
  });
});
