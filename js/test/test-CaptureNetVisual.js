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
 *   - NET_CEREMONY flag-ON: cone, rim weights, drawstring, apex hub
 *   - Per-frame allocation audit (Stage 2 §2.4.5)
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

/** Toggle both CAPTURE_NET and NET_CEREMONY flags for ceremony tests. */
function withCeremony(fn) {
  const prevCap = Constants.FEATURE_FLAGS.CAPTURE_NET;
  const prevCer = Constants.FEATURE_FLAGS.NET_CEREMONY;
  Constants.FEATURE_FLAGS.CAPTURE_NET = true;
  Constants.FEATURE_FLAGS.NET_CEREMONY = true;
  try { fn(); } finally {
    Constants.FEATURE_FLAGS.CAPTURE_NET = prevCap;
    Constants.FEATURE_FLAGS.NET_CEREMONY = prevCer;
  }
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
    netClass: { DIAMETER: 8, SPIN_HZ: 2, LAUNCH_SPEED: 10, RIM_WEIGHT_COUNT: 8 },
    position: { x: 100, y: 200, z: 300 },
    launchDirection: { x: 0, y: 0, z: 1 },
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

// ─── Suites (flag-OFF — original visual path) ───────────────────────────

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

  // 2026-05-25 retune: COL_CONTACT changed 0xffaa00 → 0xffdd44 (yellow) to
  // distinguish CONTACT from BRAKE (which now gets its own orange COL_BRAKE).
  // Legacy disc-mesh path inherits the new colour.
  it('CONTACT: disc yellow (COL_CONTACT)', () => {
    withFlag(true, () => {
      const net = mockNet({ state: 'CONTACT' });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      assert.equal(entry.discMesh.material.color.getHex(), 0xffdd44, 'disc is yellow (CONTACT)');
      vis.dispose();
    });
  });

  // 2026-05-25 retune: COL_CINCH changed 0x00aaff → 0xff44dd (magenta) to
  // separate CINCH visually from CAPTURED green and to make the drawstring
  // close unmistakable. Legacy disc-mesh path inherits the new colour.
  it('CINCH_CLOSING: disc magenta (COL_CINCH)', () => {
    withFlag(true, () => {
      const net = mockNet({ state: 'CINCH_CLOSING', tangleQuality: 0.5 });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      assert.equal(entry.discMesh.material.color.getHex(), 0xff44dd, 'disc is magenta (CINCH)');
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
      vis._createNetVisual('arm_1', 1, -1, mockNet({ netClass: { DIAMETER: 5, SPIN_HZ: 3, LAUNCH_SPEED: 12, RIM_WEIGHT_COUNT: 4 } }));
      assert.equal(vis._activeVisuals.size, 2, 'two visuals before dispose');

      vis.dispose();
      assert.equal(vis._activeVisuals.size, 0, 'all visuals cleared');
      assert.equal(vis._enabled, false, 'disabled after dispose');
    });
  });
});

// ─── Suites (NET_CEREMONY flag-ON — ceremony visual path) ───────────────

describe('CaptureNetVisual — ceremony visual creation (flag ON)', () => {
  it('creates cone mesh, rim weights, drawstring, and apex hub', () => {
    withCeremony(() => {
      const scene = mockScene();
      const net = mockNet();
      const vis = new CaptureNetVisual();
      vis.init(scene, mockPlayer(), mockCNS());
      vis._createNetVisual('arm_0', 0, -1, net);

      const entry = vis._activeVisuals.get('arm_0');
      assert.ok(entry.useCeremony, 'useCeremony flag set on entry');
      assert.ok(entry.coneMesh, 'coneMesh exists');
      assert.ok(entry.coneMesh.geometry, 'cone has geometry');
      assert.equal(entry.rimWeights.length, 8, '8 rim weights for LARGE net');
      assert.ok(entry.drawstringLine, 'drawstring line exists');
      assert.ok(entry.apexHub, 'apex hub exists');
      assert.ok(entry.tetherLine, 'tether line exists');
      // Drawstring has (N*2+2)*3 position float elements
      assert.equal(entry.drawstringPositions.length, (8 * 2 + 2) * 3, 'drawstring buffer correct size');
      vis.dispose();
    });
  });

  it('discMesh aliases coneMesh for flash-timer compat', () => {
    withCeremony(() => {
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), mockCNS());
      vis._createNetVisual('arm_0', 0, -1, mockNet());

      const entry = vis._activeVisuals.get('arm_0');
      assert.equal(entry.discMesh, entry.coneMesh, 'discMesh === coneMesh');
      vis.dispose();
    });
  });

  it('reads RIM_WEIGHT_COUNT from netClass (MEDIUM=4)', () => {
    withCeremony(() => {
      const net = mockNet({
        netClass: { DIAMETER: 4, SPIN_HZ: 4, LAUNCH_SPEED: 10, RIM_WEIGHT_COUNT: 4 },
      });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), mockCNS());
      vis._createNetVisual('arm_0', 0, -1, net);

      const entry = vis._activeVisuals.get('arm_0');
      assert.equal(entry.rimWeights.length, 4, '4 rim weights for MEDIUM net');
      assert.equal(entry.weightCount, 4, 'weightCount cached');
      assert.equal(entry.drawstringPositions.length, (4 * 2 + 2) * 3, 'drawstring sized for 4 weights');
      vis.dispose();
    });
  });

  it('caches mouthRadius and coneHeight from NET_CEREMONY constants', () => {
    withCeremony(() => {
      const net = mockNet(); // DIAMETER=8
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), mockCNS());
      vis._createNetVisual('arm_0', 0, -1, net);

      const entry = vis._activeVisuals.get('arm_0');
      const M = 1e-5;
      const NC = Constants.CAPTURE_NET.NET_CEREMONY;
      const expectedR = M * 4 * NC.CONE_OPEN_RADIUS_FRAC;
      const expectedH = expectedR * 2 * NC.CONE_LENGTH_FRAC;
      assert.ok(Math.abs(entry.mouthRadius - expectedR) < 1e-12, 'mouthRadius correct');
      assert.ok(Math.abs(entry.coneHeight - expectedH) < 1e-12, 'coneHeight correct');
      assert.ok(Math.abs(entry.closedRadius - expectedR * NC.DRAWSTRING_RADIUS_FRAC_CLOSED) < 1e-12, 'closedRadius correct');
      vis.dispose();
    });
  });
});

describe('CaptureNetVisual — ceremony state-driven visibility (flag ON)', () => {
  it('FOLDED: canister visible, cone/weights/drawstring hidden', () => {
    withCeremony(() => {
      const net = mockNet({ state: 'FOLDED' });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      assert.equal(entry.canisterMesh.visible, true, 'canister visible');
      assert.equal(entry.coneMesh.visible, false, 'cone hidden');
      assert.equal(entry.apexHub.visible, false, 'apex hub hidden');
      assert.equal(entry.drawstringLine.visible, false, 'drawstring hidden');
      for (const w of entry.rimWeights) {
        assert.equal(w.visible, false, 'weight hidden in FOLDED');
      }
      vis.dispose();
    });
  });

  it('FLIGHT: cone visible, weights at mouth radius', () => {
    withCeremony(() => {
      const net = mockNet({ state: 'FLIGHT', spinRate: 2 });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      assert.equal(entry.coneMesh.visible, true, 'cone visible in FLIGHT');
      assert.equal(entry.canisterMesh.visible, false, 'canister hidden');
      assert.equal(entry.apexHub.visible, true, 'apex hub visible');
      assert.equal(entry.drawstringLine.visible, true, 'drawstring visible');
      // All weights visible
      for (const w of entry.rimWeights) {
        assert.equal(w.visible, true, 'weight visible in FLIGHT');
      }
      // Weights should be at approximately mouthRadius from origin (in XY plane)
      const w0 = entry.rimWeights[0];
      const dist = Math.sqrt(w0.position.x * w0.position.x + w0.position.y * w0.position.y);
      assert.ok(Math.abs(dist - entry.mouthRadius) < 1e-12, 'weight at mouth radius');
      vis.dispose();
    });
  });

  it('ENVELOP: cone scale is NOT shrunk (replaces old behavior)', () => {
    withCeremony(() => {
      const net = mockNet({ state: 'ENVELOP', spinRate: 2, tangleQuality: 0.5 });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      // First do FLIGHT to set cone scale to 1
      net.state = 'FLIGHT';
      vis.update(0.016);
      // Now switch to ENVELOP
      net.state = 'ENVELOP';
      net.tangleQuality = 0.5;
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      // Cone scale must NOT have shrunk — verify scale.x === 1
      assert.equal(entry.coneMesh.scale.x, 1, 'cone scale.x === 1 (no shrink)');
      assert.equal(entry.coneMesh.scale.y, 1, 'cone scale.y === 1');
      assert.equal(entry.coneMesh.scale.z, 1, 'cone scale.z === 1');
      vis.dispose();
    });
  });

  // 2026-05-26 GEOMETRY FIX (Option A — "cinch over debris"):
  // ENVELOP weights now OVERSHOOT the mouth (z=-coneH → -2×coneH) so the
  // bag physically envelops the target (which sits at z ≈ -mouthRadius,
  // ~0.4 m short of the mouth plane). Previously z swept -coneH → 0
  // (retract toward daughter), which both looked wrong AND placed the
  // weights on the wrong side of the target. The 2026-05-25 stateTimer
  // interpolant fix is preserved — only the DIRECTION reverses.
  it('ENVELOP: weights OVERSHOOT the mouth (sweep z from -coneH toward -2×coneH)', () => {
    withCeremony(() => {
      const net = mockNet({ state: 'FLIGHT', spinRate: 2 });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      const flightZ = entry.rimWeights[0].position.z; // should be -coneHeight

      // Switch to ENVELOP at 50% of ENVELOP_TIME (the correct interpolant).
      // tangleQuality is intentionally NOT used — it's a capture probability
      // outcome set only on CAPTURED, NOT an animation progress signal.
      net.state = 'ENVELOP';
      net.stateTimer = Constants.CAPTURE_NET.ENVELOP_TIME * 0.5;
      vis.update(0.016);

      const envZ = entry.rimWeights[0].position.z;
      // envZ should move PAST flightZ in the -Z direction (target-ward).
      // Old (buggy) code moved toward 0 (daughter-ward); new code moves
      // toward -2×coneHeight.
      assert.ok(envZ < flightZ,
        `weight z must overshoot past the mouth (z became MORE negative); got envZ=${envZ}, flightZ=${flightZ}`);
      // At 50% progress, z should be -coneHeight * 1.5
      const expectedZ = -entry.coneHeight * 1.5;
      assert.ok(Math.abs(envZ - expectedZ) < 1e-12,
        `weight z at expected envelop position; got ${envZ}, expected ${expectedZ}`);
      vis.dispose();
    });
  });

  // 2026-05-25 CRITICAL FIX: was driven by `net.tangleQuality` (=0 until
  // CAPTURED), now driven by `net.stateTimer / CN.CINCH_CLOSE_TIME`.
  it('CINCH_CLOSING: weights radial position decreases toward closedRadius — driven by stateTimer', () => {
    withCeremony(() => {
      // 80% of CINCH_CLOSE_TIME → expected progress 0.8 (matches old assertion).
      const net = mockNet({
        state: 'CINCH_CLOSING',
        spinRate: 2,
        stateTimer: Constants.CAPTURE_NET.CINCH_CLOSE_TIME * 0.8,
      });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      const w0 = entry.rimWeights[0];
      const dist = Math.sqrt(w0.position.x * w0.position.x + w0.position.y * w0.position.y);
      // At progress=0.8, radius should be mouthR + (closedR - mouthR) * 0.8
      const expectedR = entry.mouthRadius + (entry.closedRadius - entry.mouthRadius) * 0.8;
      assert.ok(Math.abs(dist - expectedR) < 1e-12,
        `weight radial position matches cinch progress; got dist=${dist}, expected=${expectedR}`);
      // 2026-05-26 GEOMETRY FIX: weight z is now at MOUTH plane (z=-coneHeight),
      // not apex plane (z=0). The closing ring is positioned at the target's
      // local z-position (target sits at z ≈ -mouthRadius, ~0.4 m short of
      // the mouth). Old assertion `z ≈ 0` pinned the bug — cinch was
      // contracting 4 m behind the target on the daughter side.
      assert.ok(Math.abs(w0.position.z - (-entry.coneHeight)) < 1e-12,
        `weight at mouth plane during cinch (z=-coneHeight=${-entry.coneHeight}); got z=${w0.position.z}`);
      vis.dispose();
    });
  });

  // ─── 2026-05-25 anti-regression for the tangleQuality interpolant bug ───
  //
  // `tangleQuality` is a CAPTURE PROBABILITY ROLL OUTCOME — it's 0 throughout
  // ENVELOP and CINCH_CLOSING and is only set in CaptureNet.js:555 when the
  // FSM transitions to CAPTURED. Using it as an animation interpolant froze
  // the engulf at z = -coneHeight (mouth plane) and froze the cinch at
  // radius = mouthRadius for the entire state — the user saw a static cone
  // for ~7 s, then a single-frame snap to closed when CAPTURED hit.
  //
  // The correct interpolant is `stateTimer / state-duration`. These tests
  // pin that decision so any future "cleanup" can't silently revert.
  it('ENVELOP animation is independent of tangleQuality (uses stateTimer)', () => {
    withCeremony(() => {
      // High tangleQuality, ZERO stateTimer — must read as 0% progress.
      const net = mockNet({
        state: 'ENVELOP',
        spinRate: 0,
        stateTimer: 0,
        tangleQuality: 0.99,  // intentionally high — must be IGNORED
      });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      const zAt0 = entry.rimWeights[0].position.z;
      // At stateTimer=0, envProgress=0 → envZ = -coneHeight (mouth plane).
      // If tangleQuality was the interpolant, envZ would be -coneHeight × 2 (full overshoot).
      assert.ok(Math.abs(zAt0 - (-entry.coneHeight)) < 1e-12,
        `ENVELOP at stateTimer=0 must place weights at mouth plane (z=-coneHeight); ` +
        `got z=${zAt0}. If this fails, the animation is keyed to tangleQuality again.`);

      // 2026-05-26 GEOMETRY FIX: at full state-time, weights OVERSHOOT to
      // z=-2×coneHeight (was z=0). Direction reversal — see ENVELOP fix.
      net.stateTimer = Constants.CAPTURE_NET.ENVELOP_TIME;
      vis.update(0.016);
      const zAtFull = entry.rimWeights[0].position.z;
      assert.ok(Math.abs(zAtFull - (-2 * entry.coneHeight)) < 1e-12,
        `ENVELOP at stateTimer=ENVELOP_TIME must place weights at z=-2×coneHeight ` +
        `(overshoot endpoint = ${-2 * entry.coneHeight}); got z=${zAtFull}`);
      vis.dispose();
    });
  });

  it('CINCH_CLOSING animation is independent of tangleQuality (uses stateTimer)', () => {
    withCeremony(() => {
      const net = mockNet({
        state: 'CINCH_CLOSING',
        spinRate: 0,
        stateTimer: 0,
        tangleQuality: 0.99,  // must be IGNORED
      });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      const w0 = entry.rimWeights[0];
      const r0 = Math.sqrt(w0.position.x * w0.position.x + w0.position.y * w0.position.y);
      // At stateTimer=0, cinchProgress=0 → radius = mouthRadius (open mouth).
      assert.ok(Math.abs(r0 - entry.mouthRadius) < 1e-12,
        `CINCH_CLOSING at stateTimer=0 must keep weights at mouth radius; ` +
        `got r=${r0}, expected=${entry.mouthRadius}. ` +
        `If this fails, the animation is keyed to tangleQuality again.`);

      // Full state-time → closedRadius.
      net.stateTimer = Constants.CAPTURE_NET.CINCH_CLOSE_TIME;
      vis.update(0.016);
      const rFull = Math.sqrt(w0.position.x * w0.position.x + w0.position.y * w0.position.y);
      assert.ok(Math.abs(rFull - entry.closedRadius) < 1e-12,
        `CINCH_CLOSING at stateTimer=CINCH_CLOSE_TIME must close to closedRadius; ` +
        `got r=${rFull}, expected=${entry.closedRadius}`);
      vis.dispose();
    });
  });

  // Per-state colour identification (2026-05-25 retune).
  // The user explicitly requested colour-coding so they can identify which
  // FSM state is visible during the cinematic. Each ceremony state must
  // produce a DISTINCT cone hue.
  it('Ceremony FSM states each render with a distinct cone colour', () => {
    withCeremony(() => {
      const vis = new CaptureNetVisual();
      const net = mockNet({ state: 'CONTACT', spinRate: 0 });
      const cns = mockCNS({ 0: net });
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);

      const stateColours = new Map();
      const states = ['CONTACT', 'BRAKE', 'ENVELOP', 'CINCH_CLOSING', 'SECURE_CHECK'];
      for (const s of states) {
        net.state = s;
        net.stateTimer = 0;
        vis.update(0.016);
        const entry = vis._activeVisuals.get('arm_0');
        stateColours.set(s, entry.coneMesh.material.color.getHex());
      }

      // Every state must have a unique colour
      const colours = Array.from(stateColours.values());
      const uniqueColours = new Set(colours);
      assert.equal(uniqueColours.size, states.length,
        `Each of [${states.join(', ')}] must render with a unique cone colour. ` +
        `Got: ${states.map((s, i) => `${s}=0x${colours[i].toString(16)}`).join(', ')}. ` +
        `If two share a colour, the user cannot identify which FSM state is active.`);
      vis.dispose();
    });
  });

  it('BRAKE: weight emissive set to RIM_WEIGHT_EMISSIVE_BRAKE', () => {
    withCeremony(() => {
      const net = mockNet({ state: 'BRAKE', spinRate: 2 });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      const expected = Constants.CAPTURE_NET.NET_CEREMONY.RIM_WEIGHT_EMISSIVE_BRAKE;
      for (const mat of entry.rimWeightMats) {
        assert.equal(mat.emissive.getHex(), expected, 'weight emissive set on BRAKE');
      }
      vis.dispose();
    });
  });

  it('CAPTURED: cone turns green (0x00ff44)', () => {
    withCeremony(() => {
      const net = mockNet({ state: 'CAPTURED', catchResult: 'success' });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      assert.equal(entry.coneMesh.material.color.getHex(), 0x00ff44, 'cone is green');
      vis.dispose();
    });
  });

  it('STOWED/RELEASED: visual removed', () => {
    withCeremony(() => {
      const net = mockNet({ state: 'FLIGHT', spinRate: 2 });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);
      assert.equal(vis._activeVisuals.size, 1, 'visual exists');

      net.state = 'STOWED';
      vis.update(0.016);
      assert.equal(vis._activeVisuals.size, 0, 'visual removed on STOWED');
      vis.dispose();
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2026-05-26 GEOMETRY FIX — "cinch over debris" world-coordinate invariant.
// ════════════════════════════════════════════════════════════════════════
//
// Pins the local-frame geometry that puts the closing drawstring AT the
// target (not 4 m behind it on the daughter side). The "between daughter
// and debris" symptom the user reported was: cone apex at local z=0 (which
// is net.position in world space), mouth at z=-coneH, target at z≈-mouthR
// (= -0.5×D, ~0.4 m short of the mouth plane), CINCH ring contracting at
// z=0 → ring was coneH (=4.4 m for LARGE D=8) BEHIND the target. Fix moves
// CINCH ring to z=-coneH (mouth plane = target's z within mouth half-thick)
// and reverses ENVELOP direction so weights OVERSHOOT past the target.
//
// Invariant pinned: with CONE_OPEN_RADIUS_FRAC=1.0 and CONE_LENGTH_FRAC=0.55,
// the gap |z_ring − z_target| during CINCH = |−coneH − (−mouthR)| = D×0.05
// (= 0.4 m for D=8). For any reasonable cone geometry, the gap must be
// strictly less than the mouth radius (so the target is inside the ring
// when viewed along the launch axis).
// ════════════════════════════════════════════════════════════════════════

describe('CaptureNetVisual — Option A geometry invariant (cinch over debris)', () => {
  const M_SCENE = 1e-5;
  const NET_CER = Constants.CAPTURE_NET.NET_CEREMONY;

  it('CINCH ring centerline sits within mouth-radius of the target', () => {
    withCeremony(() => {
      const D = 8; // LARGE net diameter (m)
      const net = mockNet({
        netClass: { DIAMETER: D, SPIN_HZ: 2, LAUNCH_SPEED: 10, RIM_WEIGHT_COUNT: 8 },
        state: 'CINCH_CLOSING',
        spinRate: 0,
        stateTimer: 0,
      });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      // Closing ring local z (= weight z during CINCH_CLOSING)
      const ringZ = entry.rimWeights[0].position.z;
      // Target's local z = -mouthRadius_scene_units (contact fires when target
      // is within (DIAMETER/2) of net.position, i.e. mouthR away along -Z).
      const mouthR_scene = M_SCENE * (D / 2) * NET_CER.CONE_OPEN_RADIUS_FRAC;
      const targetLocalZ = -mouthR_scene;
      // Gap between the ring and the target along the launch axis
      const gap = Math.abs(ringZ - targetLocalZ);
      // Pin: ring is within the mouth radius of the target (i.e. the target
      // sits inside the closing ring as seen down the launch axis).
      assert.ok(gap < mouthR_scene,
        `CINCH ring must close on target: |ringZ − targetZ|=${gap} < mouthRadius=${mouthR_scene}. ` +
        `If this fails, the cinch is happening somewhere other than at the target.`);
      // Tighter pin: the gap is exactly D × |CONE_LENGTH_FRAC − 0.5 × CONE_OPEN_RADIUS_FRAC| × M.
      const expectedGap = M_SCENE * D *
        Math.abs(NET_CER.CONE_LENGTH_FRAC - 0.5 * NET_CER.CONE_OPEN_RADIUS_FRAC);
      assert.ok(Math.abs(gap - expectedGap) < 1e-12,
        `Geometric gap formula: expected ${expectedGap}, got ${gap}`);
      vis.dispose();
    });
  });

  it('ENVELOP weights overshoot past the target (z more negative than target z)', () => {
    withCeremony(() => {
      const D = 8;
      const net = mockNet({
        netClass: { DIAMETER: D, SPIN_HZ: 2, LAUNCH_SPEED: 10, RIM_WEIGHT_COUNT: 8 },
        state: 'ENVELOP',
        spinRate: 0,
        stateTimer: Constants.CAPTURE_NET.ENVELOP_TIME, // full progress
      });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      const wZ = entry.rimWeights[0].position.z;
      const mouthR_scene = M_SCENE * (D / 2) * NET_CER.CONE_OPEN_RADIUS_FRAC;
      const targetLocalZ = -mouthR_scene;
      // Endpoint must be PAST the target in the launch direction (-Z).
      // Newton's first law: weights overshoot the mouth, wrapping the target.
      assert.ok(wZ < targetLocalZ,
        `ENVELOP endpoint must overshoot the target: wZ=${wZ} should be < targetLocalZ=${targetLocalZ}. ` +
        `If this fails, weights are retracting toward the daughter (the bug).`);
      // Specifically: endpoint = -2 × coneHeight.
      assert.ok(Math.abs(wZ - (-2 * entry.coneHeight)) < 1e-12,
        `ENVELOP overshoot endpoint must equal -2×coneHeight (${-2 * entry.coneHeight}); got ${wZ}`);
    });
  });

  // 2026-05-28 (Item 1 regression): CONE_LENGTH_FRAC bumped 0.55 → 0.85 so
  // the cinch ring closes past the debris's forward leading edge (gap ≈
  // 0.35 × D) instead of through the debris midpoint (gap = 0.05 × D).
  // This test pins the gap-to-target ratio as a band so any future retune
  // that drops below the "clears leading edge" threshold fails loudly.
  it('CINCH gap past target ≥ D × 0.2 (clears debris leading edge for typical bins)', () => {
    withCeremony(() => {
      const D = 8;
      const net = mockNet({
        netClass: { DIAMETER: D, SPIN_HZ: 2, LAUNCH_SPEED: 10, RIM_WEIGHT_COUNT: 8 },
        state: 'CINCH_CLOSING',
        spinRate: 0,
        stateTimer: 0,
      });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      const ringZ = entry.rimWeights[0].position.z;
      const mouthR_scene = M_SCENE * (D / 2) * NET_CER.CONE_OPEN_RADIUS_FRAC;
      const targetLocalZ = -mouthR_scene;
      // Gap MUST be at least D × 0.2 × M_SCENE (the typical LARGE-bin debris
      // half-extent threshold; debris radii are 1-2 m for D=8 nets).  If
      // CONE_LENGTH_FRAC slips back below ~0.7, this test catches it.
      const gap = Math.abs(ringZ - targetLocalZ);
      const minGap = M_SCENE * D * 0.2;
      assert.ok(gap >= minGap - 1e-15,
        `CINCH gap past target = ${(gap / M_SCENE).toFixed(2)} m for D=${D}; ` +
        `must be ≥ ${(minGap / M_SCENE).toFixed(2)} m (D × 0.2) so the ring ` +
        `closes past the debris leading edge.  Lower-bound the cone length ` +
        `at CONE_LENGTH_FRAC ≥ 0.7 (currently ${NET_CER.CONE_LENGTH_FRAC}).`);
    });
  });

  it('CINCH ring lies on the FORWARD side of the apex (target-side)', () => {
    withCeremony(() => {
      const net = mockNet({
        state: 'CINCH_CLOSING',
        spinRate: 0,
        stateTimer: Constants.CAPTURE_NET.CINCH_CLOSE_TIME * 0.5,
      });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      // The apex sits at z=0 (= net.position in world). Forward (target-side)
      // is -Z. The ring must be on the target side, i.e. z < 0. Old (buggy)
      // code had z = 0 (at the apex itself).
      assert.ok(entry.rimWeights[0].position.z < 0,
        `CINCH ring must be forward of apex (z<0); got z=${entry.rimWeights[0].position.z}. ` +
        `If this fails, the ring is contracting AT or BEHIND the apex.`);
      vis.dispose();
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2026-05-27 LOOKAT-CONVENTION FIX — world-frame cinch invariant.
// ════════════════════════════════════════════════════════════════════════
//
// Diagnosis (via NET_CINEMATIC_DEBUG-gated instrumentation):
//   [NETSTATE] state=CINCH_CLOSING ... tgtLocalZ=-0.74m (expect=-0.75) — physics OK
//   [NETVIS]   state=CINCH_CLOSING ... ringLocalZ_m=+0.83 (expect=-0.83) — visual FLIPPED
//                                       ringFwdPastTgt_m=-1.57 — ring on daughter side
//
// Root cause: THREE.js Object3D.lookAt uses the OPPOSITE convention from
// Camera.lookAt. For Object3D (not Camera/Light), local +Z points TOWARD the
// lookAt target (NOT local -Z). The cone-build code at CaptureNetVisual.js
// line ~298 was written assuming camera convention (mouth=-Z). The previous
// lookAt call `group.lookAt(group.position + launchDir × ε)` made local +Z =
// launchDir, which rendered every `z = -coneH` placement on the DAUGHTER side
// of net.position — i.e. all rim-weight, mouth, and cinch-ring geometry was
// 4.4 m (for D=8) behind where it was supposed to be.
//
// Fix: pass `group.position - launchDir × ε` to lookAt instead. Object3D.lookAt
// then sets local +Z = -launchDir, hence local -Z = +launchDir, matching the
// camera-style convention all the geometry assumes.
//
// Existing tests at line 728 ("Option A geometry invariant") only inspected
// LOCAL z coordinates on the rimWeight meshes — they never called
// getWorldPosition() and never went through the group quaternion. So they
// passed for every prior buggy state. The tests below pin the WORLD-FRAME
// invariant the prior tests missed:
//
//   (rimWeight.getWorldPosition() − group.position) · launchDir > 0
//
// I.e. the ring sits on the target-far side of the group along launchDir.
// ════════════════════════════════════════════════════════════════════════

describe('CaptureNetVisual — world-frame cinch invariant (Object3D.lookAt convention)', () => {
  const M_SCENE = 1e-5;
  const NET_CER = Constants.CAPTURE_NET.NET_CEREMONY;
  // Use the actual THREE.Vector3 from the same instance the module uses.
  // We need this for getWorldPosition() output — the module uses a private
  // THREE import, but we just need a scratch container.
  // (THREE is exposed transitively via CaptureNetVisual's import; reusing the
  // rimWeight's own getWorldPosition return makes this allocation-free in
  // tests, but for clarity we import directly.)

  // Helper: normalize a launchDir vector for the mock net.
  function normDir(x, y, z) {
    const m = Math.sqrt(x * x + y * y + z * z) || 1;
    return { x: x / m, y: y / m, z: z / m };
  }

  it('CINCH_CLOSING rim weight world-position projects POSITIVELY along launchDir', () => {
    withCeremony(() => {
      // Non-axis-aligned launchDir so any sign error doesn't accidentally
      // cancel out via coordinate-axis coincidence.
      const launchDir = normDir(0.6, 0.5, -0.4);
      const D = 8; // LARGE
      const net = mockNet({
        netClass: { DIAMETER: D, SPIN_HZ: 2, LAUNCH_SPEED: 10, RIM_WEIGHT_COUNT: 8 },
        position: { x: 100, y: 200, z: 300 },
        launchDirection: launchDir,
        state: 'CINCH_CLOSING',
        spinRate: 0,
        stateTimer: Constants.CAPTURE_NET.CINCH_CLOSE_TIME * 0.3,
      });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      const ring = entry.rimWeights[0];
      // Get the world position of the first rim weight after the group
      // transform (lookAt + position) has been applied.
      const ringWorld = ring.getWorldPosition(ring.position.clone());
      // The world projection along launchDir, relative to the group center.
      // POSITIVE = ring is on the target-far side (correct).
      // NEGATIVE = ring is on the daughter side (the historic bug).
      const dx = ringWorld.x - entry.group.position.x;
      const dy = ringWorld.y - entry.group.position.y;
      const dz = ringWorld.z - entry.group.position.z;
      const fwdProj = dx * launchDir.x + dy * launchDir.y + dz * launchDir.z;
      assert.ok(fwdProj > 0,
        `Ring must be on target-far side of group along launchDir. ` +
        `Got (ring−group)·launchDir = ${fwdProj} (scene units). ` +
        `If this is negative, the Object3D.lookAt convention has been ` +
        `re-broken (see CaptureNetVisual.js line ~944).`);
      // Tighter pin: the projection is exactly +coneHeight (in scene units),
      // because the rim weight is at local z = -coneHeight and local -Z =
      // launchDir under the corrected lookAt convention.
      const expected = entry.coneHeight;
      assert.ok(Math.abs(fwdProj - expected) < 1e-12,
        `Ring forward projection: expected +coneHeight=${expected}, got ${fwdProj}`);
      vis.dispose();
    });
  });

  it('ENVELOP rim weight world-position projects POSITIVELY along launchDir (overshoot)', () => {
    withCeremony(() => {
      const launchDir = normDir(-0.3, 0.8, 0.5);
      const D = 8;
      const net = mockNet({
        netClass: { DIAMETER: D, SPIN_HZ: 2, LAUNCH_SPEED: 10, RIM_WEIGHT_COUNT: 8 },
        position: { x: 0, y: 0, z: 0 },
        launchDirection: launchDir,
        state: 'ENVELOP',
        spinRate: 0,
        stateTimer: Constants.CAPTURE_NET.ENVELOP_TIME, // full overshoot
      });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      const ring = entry.rimWeights[0];
      const ringWorld = ring.getWorldPosition(ring.position.clone());
      const fwdProj =
        (ringWorld.x - entry.group.position.x) * launchDir.x +
        (ringWorld.y - entry.group.position.y) * launchDir.y +
        (ringWorld.z - entry.group.position.z) * launchDir.z;
      // Endpoint of ENVELOP overshoot is local z = -2 × coneHeight ⇒ world
      // projection = +2 × coneHeight (under fixed lookAt convention).
      const expected = 2 * entry.coneHeight;
      assert.ok(fwdProj > 0,
        `ENVELOP endpoint must overshoot to target-far side: ` +
        `(ring−group)·launchDir = ${fwdProj} should be > 0.`);
      assert.ok(Math.abs(fwdProj - expected) < 1e-12,
        `ENVELOP overshoot: expected +2×coneHeight=${expected}, got ${fwdProj}`);
      vis.dispose();
    });
  });

  it('Apex hub stays at the group center (apex world == group.position)', () => {
    withCeremony(() => {
      const launchDir = normDir(0.1, 0.2, 0.97);
      const net = mockNet({
        position: { x: 50, y: -25, z: 75 },
        launchDirection: launchDir,
        state: 'CINCH_CLOSING',
        spinRate: 0,
        stateTimer: 0.1,
      });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      // Apex is at local (0,0,0), so its world position equals group position.
      // This invariant is unaffected by the lookAt-convention fix, but pinning
      // it here lets us localize regressions: if this fails, the apex moved;
      // if the rim test fails, the rotation flipped.
      const apexWorld = entry.apexHub.getWorldPosition(entry.apexHub.position.clone());
      const expectedX = net.position.x * M_SCENE;
      const expectedY = net.position.y * M_SCENE;
      const expectedZ = net.position.z * M_SCENE;
      assert.ok(Math.abs(apexWorld.x - expectedX) < 1e-12, `apex.x: expected ${expectedX}, got ${apexWorld.x}`);
      assert.ok(Math.abs(apexWorld.y - expectedY) < 1e-12, `apex.y: expected ${expectedY}, got ${apexWorld.y}`);
      assert.ok(Math.abs(apexWorld.z - expectedZ) < 1e-12, `apex.z: expected ${expectedZ}, got ${apexWorld.z}`);
      vis.dispose();
    });
  });

  it('CONTACT/BRAKE rim weight world-position is mouthR-radius around launch axis at z=-coneH', () => {
    // Verifies the rotational placement is correct too: rim weights form a
    // circle of radius mouthR in the plane perpendicular to launchDir, at a
    // distance coneH PAST the group center along launchDir.
    withCeremony(() => {
      const launchDir = normDir(0.4, -0.5, 0.7);
      const D = 8;
      const net = mockNet({
        netClass: { DIAMETER: D, SPIN_HZ: 0, LAUNCH_SPEED: 10, RIM_WEIGHT_COUNT: 8 },
        position: { x: 10, y: 20, z: 30 },
        launchDirection: launchDir,
        state: 'BRAKE',
        spinRate: 0, // freeze spin so weight angles are deterministic
        stateTimer: 0,
      });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      const mouthR = entry.mouthRadius;
      const coneH = entry.coneHeight;
      // Each weight must:
      //  (a) project to +coneH along launchDir (target-far side),
      //  (b) have radial offset (perpendicular to launchDir) equal to mouthR.
      for (let i = 0; i < entry.rimWeights.length; i++) {
        const w = entry.rimWeights[i];
        const wWorld = w.getWorldPosition(w.position.clone());
        const dx = wWorld.x - entry.group.position.x;
        const dy = wWorld.y - entry.group.position.y;
        const dz = wWorld.z - entry.group.position.z;
        const fwdProj = dx * launchDir.x + dy * launchDir.y + dz * launchDir.z;
        // Radial component
        const perpX = dx - fwdProj * launchDir.x;
        const perpY = dy - fwdProj * launchDir.y;
        const perpZ = dz - fwdProj * launchDir.z;
        const radial = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);
        assert.ok(Math.abs(fwdProj - coneH) < 1e-12,
          `weight ${i} forward projection: expected +coneH=${coneH}, got ${fwdProj}`);
        assert.ok(Math.abs(radial - mouthR) < 1e-12,
          `weight ${i} radial: expected mouthR=${mouthR}, got ${radial}`);
      }
      vis.dispose();
    });
  });
});

describe('CaptureNetVisual — ceremony drawstring update (flag ON)', () => {
  it('drawstring positions updated with spoke pattern on FLIGHT', () => {
    withCeremony(() => {
      const net = mockNet({ state: 'FLIGHT', spinRate: 2 });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      const ds = entry.drawstringPositions;
      // First vertex: apex at (0,0,0)
      assert.equal(ds[0], 0, 'ds[0] = apex x = 0');
      assert.equal(ds[1], 0, 'ds[1] = apex y = 0');
      assert.equal(ds[2], 0, 'ds[2] = apex z = 0');
      // Second vertex: weight 0 position (Float32Array truncates to 32-bit)
      const w0 = entry.rimWeights[0];
      assert.equal(ds[3], Math.fround(w0.position.x), 'ds[3] = w0.x');
      assert.equal(ds[4], Math.fround(w0.position.y), 'ds[4] = w0.y');
      assert.equal(ds[5], Math.fround(w0.position.z), 'ds[5] = w0.z');
      // Last two vertices: apex then w0 again (close pattern)
      const n = entry.weightCount;
      const lastApexIdx = n * 2 * 3;
      assert.equal(ds[lastApexIdx], 0, 'final apex x = 0');
      assert.equal(ds[lastApexIdx + 1], 0, 'final apex y = 0');
      assert.equal(ds[lastApexIdx + 2], 0, 'final apex z = 0');
      vis.dispose();
    });
  });
});

describe('CaptureNetVisual — ceremony dispose (flag ON)', () => {
  it('dispose releases ceremony geometries without error', () => {
    withCeremony(() => {
      const scene = mockScene();
      const vis = new CaptureNetVisual();
      vis.init(scene, mockPlayer(), mockCNS());
      vis._createNetVisual('arm_0', 0, -1, mockNet());
      assert.equal(vis._activeVisuals.size, 1, 'visual exists');

      // No errors on dispose
      vis.dispose();
      assert.equal(vis._activeVisuals.size, 0, 'all cleared after dispose');
      assert.equal(scene._children.length, 0, 'scene cleared');
    });
  });

  it('_removeNetVisual cleans up ceremony entries', () => {
    withCeremony(() => {
      const scene = mockScene();
      const vis = new CaptureNetVisual();
      vis.init(scene, mockPlayer(), mockCNS());
      vis._createNetVisual('arm_0', 0, -1, mockNet());
      assert.equal(scene._children.length, 1, 'group in scene');

      vis._removeNetVisual('arm_0');
      assert.equal(vis._activeVisuals.size, 0, 'entry removed');
      assert.equal(scene._children.length, 0, 'group removed from scene');
      vis.dispose();
    });
  });
});

describe('CaptureNetVisual — per-frame allocation audit (flag ON)', () => {
  it('no geometry/material churn across 100 update frames in FLIGHT', () => {
    withCeremony(() => {
      const net = mockNet({ state: 'FLIGHT', spinRate: 2 });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);

      const entry = vis._activeVisuals.get('arm_0');
      const refs = {
        coneGeo: entry.coneMesh.geometry,
        coneMat: entry.coneMesh.material,
        dsGeo: entry.drawstringLine.geometry,
        dsArr: entry.drawstringPositions,
        tetherGeo: entry.tetherLine.geometry,
        childCount: entry.group.children.length,
      };

      for (let i = 0; i < 100; i++) {
        vis.update(0.016);
      }

      assert.equal(entry.coneMesh.geometry, refs.coneGeo, 'cone geometry not recreated');
      assert.equal(entry.coneMesh.material, refs.coneMat, 'cone material not recreated');
      assert.equal(entry.drawstringLine.geometry, refs.dsGeo, 'drawstring geometry not recreated');
      assert.equal(entry.drawstringPositions, refs.dsArr, 'drawstring positions array not recreated');
      assert.equal(entry.tetherLine.geometry, refs.tetherGeo, 'tether geometry not recreated');
      assert.equal(entry.group.children.length, refs.childCount, 'no children added/removed');
      vis.dispose();
    });
  });

  it('no object churn through FLIGHT→BRAKE→ENVELOP→CINCH state transitions', () => {
    withCeremony(() => {
      const net = mockNet({ state: 'FLIGHT', spinRate: 2 });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);

      const entry = vis._activeVisuals.get('arm_0');
      const refs = {
        coneGeo: entry.coneMesh.geometry,
        coneMat: entry.coneMesh.material,
        dsArr: entry.drawstringPositions,
        childCount: entry.group.children.length,
        weightGeo: entry.weightGeo,
      };

      // Advance through states with multiple frames each
      const transitions = [
        ['FLIGHT', 0],
        ['BRAKE', 0],
        ['ENVELOP', 0.5],
        ['CINCH_CLOSING', 0.5],
        ['CINCH_CLOSING', 1.0],
      ];
      for (const [s, tq] of transitions) {
        net.state = s;
        net.tangleQuality = tq;
        for (let i = 0; i < 25; i++) vis.update(0.016);
      }

      assert.equal(entry.coneMesh.geometry, refs.coneGeo, 'geometry stable through transitions');
      assert.equal(entry.coneMesh.material, refs.coneMat, 'material stable');
      assert.equal(entry.drawstringPositions, refs.dsArr, 'drawstring buffer stable');
      assert.equal(entry.group.children.length, refs.childCount, 'children count stable');
      assert.equal(entry.weightGeo, refs.weightGeo, 'weight geometry stable');
      vis.dispose();
    });
  });
});

describe('CaptureNetVisual — getTetherAttachPoint (Stage 3 prep)', () => {
  it('returns apex hub world position when ceremony ON', () => {
    withCeremony(() => {
      const net = mockNet({ state: 'FLIGHT', spinRate: 2 });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const pt = vis.getTetherAttachPoint('arm_0');
      assert.ok(pt, 'returned a vector');
      // Should be a Vector3 (has x, y, z)
      assert.ok(typeof pt.x === 'number', 'has numeric x');
      assert.ok(typeof pt.y === 'number', 'has numeric y');
      assert.ok(typeof pt.z === 'number', 'has numeric z');
      vis.dispose();
    });
  });

  it('returns group position when ceremony OFF', () => {
    withFlag(true, () => {
      const net = mockNet({ state: 'FLIGHT', spinRate: 2 });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      const entry = vis._activeVisuals.get('arm_0');
      const pt = vis.getTetherAttachPoint('arm_0');
      assert.ok(pt, 'returned a vector');
      // Should match group position (center of flat disc)
      assert.equal(pt.x, entry.group.position.x, 'x matches group');
      assert.equal(pt.y, entry.group.position.y, 'y matches group');
      assert.equal(pt.z, entry.group.position.z, 'z matches group');
      vis.dispose();
    });
  });

  it('returns zero vector for unknown key', () => {
    withFlag(true, () => {
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), mockCNS());
      const pt = vis.getTetherAttachPoint('nonexistent');
      assert.equal(pt.x, 0, 'x=0 for unknown');
      assert.equal(pt.y, 0, 'y=0 for unknown');
      assert.equal(pt.z, 0, 'z=0 for unknown');
      vis.dispose();
    });
  });
});

// ─── UX-11 #2/#3: park freeze + chop hand-off ───────────────────────────

describe('CaptureNetVisual — UX-11 #3: captured/parked bag is frozen (no pulse)', () => {
  it('REELING (success): steady opacity, frozen spinAngle, rim at closed radius across frames', () => {
    withCeremony(() => {
      const net = mockNet({ state: 'REELING', spinRate: 2, catchResult: 'success', _heldByArm: true });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);

      vis.update(0.016);
      const entry = vis._activeVisuals.get('arm_0');
      const spinAfter1 = entry.spinAngle;
      const op1 = entry.coneMesh.material.opacity;
      const w0a = entry.rimWeights[0].position.clone();

      // Simulate a multi-second park — many frames
      for (let i = 0; i < 60; i++) vis.update(0.05);

      assert.equal(entry.spinAngle, spinAfter1, 'spinAngle must not advance during park');
      assert.equal(entry.coneMesh.material.opacity, op1, 'opacity must be steady (no pulse)');
      const w0b = entry.rimWeights[0].position;
      assert.ok(w0a.distanceTo(w0b) < 1e-12, 'rim weights must be static');
      // Rim ring sits at the CLOSED (cinched) radius
      const r = Math.sqrt(w0b.x * w0b.x + w0b.y * w0b.y);
      assert.ok(Math.abs(r - entry.closedRadius) < 1e-12,
        `rim radius must equal closedRadius (${entry.closedRadius}), got ${r}`);
      assert.equal(entry.coneMesh.material.opacity, 0.55, 'fixed 0.55 opacity');
      vis.dispose();
    });
  });

  it('CAPTURED: rim weights render the static cinched ring', () => {
    withCeremony(() => {
      const net = mockNet({ state: 'CAPTURED', spinRate: 2, catchResult: 'success' });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);
      const entry = vis._activeVisuals.get('arm_0');
      assert.equal(entry.coneMesh.visible, true);
      for (const w of entry.rimWeights) assert.equal(w.visible, true, 'cinched ring visible');
      assert.equal(entry.drawstringLine.visible, true, 'drawstring visible');
      vis.dispose();
    });
  });

  it('REELING (miss): cone hidden and rim/drawstring furniture hidden too', () => {
    withCeremony(() => {
      const net = mockNet({ state: 'REELING', spinRate: 2, catchResult: 'miss' });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      // Pre-show the furniture via FLIGHT, then switch to miss-reel
      net.state = 'FLIGHT';
      vis.update(0.016);
      net.state = 'REELING';
      vis.update(0.016);
      const entry = vis._activeVisuals.get('arm_0');
      assert.equal(entry.coneMesh.visible, false, 'empty bag hidden during miss reel');
      for (const w of entry.rimWeights) assert.equal(w.visible, false, 'weights hidden');
      assert.equal(entry.drawstringLine.visible, false, 'drawstring hidden');
      vis.dispose();
    });
  });
});

describe('CaptureNetVisual — UX-11 #2: chop hand-off fade (no pop)', () => {
  it('NET_REEL_COMPLETED with capturedMass > 0 detaches + fades instead of instant removal', () => {
    withCeremony(() => {
      const net = mockNet({ state: 'REELING', spinRate: 2, catchResult: 'success' });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis.update(0.016);

      vis._onReelCompleted({ armIndex: 0, capturedMass: 120 });
      assert.equal(vis._activeVisuals.size, 1, 'visual must survive the chop boundary');
      const entry = vis._activeVisuals.get('arm_0');
      assert.equal(entry.detached, true, 'entry marked detached');
      assert.equal(vis._fadeTimers.length, 1, 'fade timer started');

      // Net gone from the system (stowed) — detached visual must NOT be culled mid-fade
      cns._armNets = {};
      vis.update(0.1);
      assert.equal(vis._activeVisuals.size, 1, 'still fading');

      // Fade completes → removed
      vis.update(1.0);
      assert.equal(vis._activeVisuals.size, 0, 'removed after fade');
      vis.dispose();
    });
  });

  it('NET_REEL_COMPLETED with no catch removes immediately (miss path unchanged)', () => {
    withCeremony(() => {
      const net = mockNet({ state: 'REELING', spinRate: 2, catchResult: 'miss' });
      const cns = mockCNS({ 0: net });
      const vis = new CaptureNetVisual();
      vis.init(mockScene(), mockPlayer(), cns);
      vis._createNetVisual('arm_0', 0, -1, net);
      vis._onReelCompleted({ armIndex: 0, capturedMass: 0 });
      assert.equal(vis._activeVisuals.size, 0, 'empty net removed at once');
      vis.dispose();
    });
  });
});
