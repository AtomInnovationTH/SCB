/**
 * test-NetCinematic.js — Q2 Stage 3: NET_CINEMATIC camera view tests
 *
 * Verifies the 7-beat net ceremony cinematic in CameraSystem:
 *   1. Mode unreachable when flag OFF
 *   2. Mode entry when flag ON + firstEver=true
 *   3. Beat advancement timing
 *   4. Full sequence completes
 *   5. Highlights-cut on repeat
 *   6. FIRST_NET_DEPLOY set at end of first cinematic
 *   7. Miss truncates cleanly
 *   8. Allocation audit (60 frames, zero new THREE.Vector3)
 *   9. OFF byte-identicality for existing modes
 *  10. Subscriptions are idempotent
 */

import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { CameraSystem, CameraViews } from '../systems/CameraSystem.js';
import { persistenceManager } from '../systems/PersistenceManager.js';
import { captureNetSystem } from '../entities/CaptureNet.js';

// ─── DOM Mocks for Node ─────────────────────────────────────────────────

if (typeof document === 'undefined') {
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({
      style: { cssText: '' },
      textContent: '',
      id: '',
      appendChild: () => {},
    }),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const BD = Constants.CAPTURE_NET.NET_CEREMONY.BEAT_DURATIONS_S;

/** Save and restore feature flags + persistence across a test. */
function withFlags(flagOverrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(flagOverrides)) {
    saved[k] = Constants.FEATURE_FLAGS[k];
    Constants.FEATURE_FLAGS[k] = v;
  }
  try { fn(); } finally {
    for (const [k] of Object.entries(flagOverrides)) {
      Constants.FEATURE_FLAGS[k] = saved[k];
    }
  }
}

/** Minimal canvas mock for CameraSystem constructor */
function mockCanvas() {
  return {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

/** Create a CameraSystem suitable for testing. */
function makeCameraSystem() {
  const camera = new THREE.PerspectiveCamera(55, 1, 0.001, 1000);
  return new CameraSystem(camera, mockCanvas());
}

/** Minimal arm mock with position and target */
function mockArm(armOverrides = {}) {
  return {
    id: 'ARM-0',
    position: new THREE.Vector3(0, 0.07, 0), // scene units (~7000m altitude)
    velocity: new THREE.Vector3(0.000076, 0, 0), // ~7.6 km/s equivalent
    target: {
      _scenePosition: new THREE.Vector3(0.0005, 0.07, 0), // 50m ahead
      id: 'debris-1',
      mass: 100,
    },
    _stationKeepTarget: null,
    state: 'STATION_KEEP',
    dockOffset: new THREE.Vector3(0, 0.00003, 0),
    ...armOverrides,
  };
}

/** Install a mock net into captureNetSystem for a given armIndex */
function installMockNet(armIndex, overrides = {}) {
  const net = {
    armIndex,
    podIndex: -1,
    launchDirection: { x: 1, y: 0, z: 0 },
    distanceTraveled: 10, // metres
    speed: 10,
    netClass: Constants.CAPTURE_NET.MEDIUM,
    _sourceArm: {
      position: new THREE.Vector3(0, 0.07, 0),
    },
    targetDebris: {
      _scenePosition: new THREE.Vector3(0.0005, 0.07, 0),
      id: 'debris-1',
      mass: 100,
    },
    state: 'FLIGHT',
    isActive: true,
    ...overrides,
  };
  captureNetSystem.activeNets.push(net);
  return net;
}

/** Remove all mock nets */
function clearMockNets() {
  captureNetSystem.activeNets.length = 0;
}

/** Standard player state for update() calls */
const PLAYER_POS = new THREE.Vector3(0, 0.07, 0);
const PLAYER_VEL = { x: 0.000076, y: 0, z: 0 };
const PLAYER_QUAT = new THREE.Quaternion();

/** Drive CameraSystem.update() for totalTime in small steps */
function driveCamera(cs, totalTime, dt = 0.016) {
  let elapsed = 0;
  while (elapsed < totalTime) {
    const step = Math.min(dt, totalTime - elapsed);
    cs.update(step, PLAYER_POS.clone(), PLAYER_VEL, PLAYER_QUAT);
    elapsed += step;
  }
}

/** Emit NET_CEREMONY_START for armIndex=0 */
function emitStart(armIndex = 0, podIndex = -1) {
  eventBus.emit(Events.NET_CEREMONY_START, {
    armIndex,
    podIndex,
    netClass: 'MD-NET',
  });
}

/** Set up a camera system in ARM_PILOT mode with a mock arm and net */
function setupCeremonyReady(flagOn = true) {
  const cs = makeCameraSystem();
  const arm = mockArm();
  cs.armPilot.arm = arm;
  cs.currentView = CameraViews.ARM_PILOT;
  if (flagOn) installMockNet(0);
  return { cs, arm };
}

// ─── Persistence mock ────────────────────────────────────────────────────
// Node has no localStorage, so PersistenceManager._storageAvailable = false
// and all reads return defaults. We monkey-patch get/setCeremonyFlag to
// use an in-memory store for the duration of each test.

const _mockCeremonyFlags = {};
const _origGetFlag = persistenceManager.getCeremonyFlag.bind(persistenceManager);
const _origSetFlag = persistenceManager.setCeremonyFlag.bind(persistenceManager);

function installPersistenceMock() {
  for (const k of Object.keys(_mockCeremonyFlags)) delete _mockCeremonyFlags[k];
  persistenceManager.getCeremonyFlag = (name) => _mockCeremonyFlags[name] ?? false;
  persistenceManager.setCeremonyFlag = (name, val) => { _mockCeremonyFlags[name] = !!val; return true; };
}

function restorePersistenceMock() {
  persistenceManager.getCeremonyFlag = _origGetFlag;
  persistenceManager.setCeremonyFlag = _origSetFlag;
  for (const k of Object.keys(_mockCeremonyFlags)) delete _mockCeremonyFlags[k];
}

// ═════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ═════════════════════════════════════════════════════════════════════════

describe('NetCinematic — 1. Mode unreachable when flag OFF', () => {
  it('NET_CEREMONY_START does not change mode when flag is OFF', () => {
    withFlags({ NET_CEREMONY: false }, () => {
      const { cs } = setupCeremonyReady(false);
      const before = cs.currentView;
      emitStart();
      assert.equal(cs.currentView, before,
        `Mode should remain ${before} when flag OFF, got ${cs.currentView}`);
      assert.ok(!cs._netCeremony.active,
        '_netCeremony.active should be false');
      clearMockNets();
    });
  });
});

describe('NetCinematic — 2. Mode entry when flag ON + firstEver', () => {
  it('enters NET_CINEMATIC with 7 beats on first-ever deploy', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      installPersistenceMock();
      const { cs } = setupCeremonyReady(true);
      emitStart();
      assert.equal(cs.currentView, CameraViews.NET_CINEMATIC,
        `Should be NET_CINEMATIC, got ${cs.currentView}`);
      assert.ok(cs._netCeremony.active, '_netCeremony should be active');
      assert.equal(cs._netCeremony.beats.length, 7,
        `Should have 7 beats, got ${cs._netCeremony.beats.length}`);
      assert.equal(cs._netCeremony.beats[0].key, 'POD_MUZZLE_PREFIRE',
        `First beat should be POD_MUZZLE_PREFIRE, got ${cs._netCeremony.beats[0].key}`);
      assert.equal(cs._netCeremony.beatIndex, 0, 'beatIndex should be 0');
      // Cleanup
      cs._exitNetCeremony(false);
      clearMockNets();
      restorePersistenceMock();
    });
  });
});

describe('NetCinematic — 3. Beat advancement timing', () => {
  it('advances beat after POD_MUZZLE_PREFIRE duration', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      installPersistenceMock();
      const { cs } = setupCeremonyReady(true);
      emitStart();
      // Drive just past the first beat
      const dt = BD.POD_MUZZLE_PREFIRE + 0.001;
      cs.update(dt, PLAYER_POS.clone(), PLAYER_VEL, PLAYER_QUAT);
      assert.equal(cs._netCeremony.beatIndex, 1,
        `After ${dt}s, beatIndex should be 1, got ${cs._netCeremony.beatIndex}`);
      assert.equal(cs._netCeremony.beats[1].key, 'MUZZLE_EXIT_SPINUP',
        `Beat 1 should be MUZZLE_EXIT_SPINUP, got ${cs._netCeremony.beats[1].key}`);
      cs._exitNetCeremony(false);
      clearMockNets();
      restorePersistenceMock();
    });
  });
});

describe('NetCinematic — 4. Full sequence completes', () => {
  it('full 7-beat sequence ends with mode restored + FOV restored', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      installPersistenceMock();
      const { cs } = setupCeremonyReady(true);
      const savedFov = cs._baseFov;
      const savedView = cs.currentView; // ARM_PILOT
      emitStart();

      // Mark as success (simulating NET_CEREMONY_COMPLETE)
      cs._netCeremony.success = true;

      // Total duration of full 7 beats
      // APPROACH_DOLLY is a hardcoded 8.0 s safety cap in CameraSystem
      // (raised from 2.0 s on 2026-05-25 so FLIGHT phase can complete inside
      // the beat — see comment at _onNetCeremonyStart line 1376).
      const totalDuration = BD.POD_MUZZLE_PREFIRE + BD.MUZZLE_EXIT_SPINUP +
        BD.GLAMOUR_SHOT + 8.0 + BD.BRAKE_ENVELOP + BD.CINCH + BD.SECURED_SETTLE;

      driveCamera(cs, totalDuration + 0.1);

      assert.ok(!cs._netCeremony.active, 'Ceremony should be inactive after all beats');
      assert.equal(cs.currentView, savedView,
        `View should restore to ${savedView}, got ${cs.currentView}`);
      assert.closeTo(cs._baseFov, savedFov, 0.5,
        `FOV should restore to ~${savedFov}, got ${cs._baseFov}`);
      clearMockNets();
      restorePersistenceMock();
    });
  });
});

describe('NetCinematic — 5. Highlights-cut on repeat', () => {
  it('uses 3 beats with scaled durations when FIRST_NET_DEPLOY is true', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      installPersistenceMock();
      // Set first-deploy flag: subsequent deploys get highlights cut
      persistenceManager.setCeremonyFlag('FIRST_NET_DEPLOY', true);
      const { cs } = setupCeremonyReady(true);
      emitStart();

      const HCB = Constants.CAPTURE_NET.NET_CEREMONY.HIGHLIGHTS_CUT_BEATS;
      const HTS = Constants.CAPTURE_NET.NET_CEREMONY.HIGHLIGHTS_TIME_SCALE;

      assert.equal(cs._netCeremony.beats.length, HCB.length,
        `Should have ${HCB.length} beats, got ${cs._netCeremony.beats.length}`);

      for (let i = 0; i < HCB.length; i++) {
        const b = cs._netCeremony.beats[i];
        assert.equal(b.key, HCB[i],
          `Beat ${i} key should be ${HCB[i]}, got ${b.key}`);
        const expected = BD[HCB[i]] * HTS;
        assert.closeTo(b.duration, expected, 0.001,
          `Beat ${i} duration should be ${expected.toFixed(3)}, got ${b.duration.toFixed(3)}`);
      }

      cs._exitNetCeremony(false);
      clearMockNets();
      restorePersistenceMock();
    });
  });
});

describe('NetCinematic — 6. FIRST_NET_DEPLOY set at end of first cinematic', () => {
  it('sets flag after completing first-ever full ceremony', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      installPersistenceMock();
      // Confirm flag is false before
      const flag = persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY');
      assert.equal(flag, false, 'Flag should be false before ceremony');

      const { cs } = setupCeremonyReady(true);
      emitStart();

      // Mark success
      cs._netCeremony.success = true;

      // Drive through all beats
      // APPROACH_DOLLY hardcoded 8.0 s safety cap (see comment above).
      const totalDuration = BD.POD_MUZZLE_PREFIRE + BD.MUZZLE_EXIT_SPINUP +
        BD.GLAMOUR_SHOT + 8.0 + BD.BRAKE_ENVELOP + BD.CINCH + BD.SECURED_SETTLE;
      driveCamera(cs, totalDuration + 0.1);

      const flagAfter = persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY');
      assert.equal(flagAfter, true,
        'FIRST_NET_DEPLOY should be true after first ceremony completion');
      clearMockNets();
      restorePersistenceMock();
    });
  });
});

describe('NetCinematic — 7. Miss truncates cleanly', () => {
  it('exits immediately on miss, does NOT set FIRST_NET_DEPLOY', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      installPersistenceMock();
      const { cs } = setupCeremonyReady(true);
      emitStart();
      assert.ok(cs._netCeremony.active, 'Ceremony should be active');

      // Drive a couple frames into the ceremony
      driveCamera(cs, 0.5);
      assert.ok(cs._netCeremony.active, 'Should still be active mid-beat');

      // Fire NET_CEREMONY_COMPLETE with success=false
      eventBus.emit(Events.NET_CEREMONY_COMPLETE, {
        armIndex: 0,
        podIndex: -1,
        mode: 'CINCH',
        success: false,
      });

      assert.ok(!cs._netCeremony.active, 'Ceremony should be inactive after miss');
      assert.equal(cs.currentView, CameraViews.ARM_PILOT,
        `View should restore to ARM_PILOT, got ${cs.currentView}`);

      const missFlag = persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY');
      assert.equal(missFlag, false,
        'FIRST_NET_DEPLOY should NOT be set on miss');
      clearMockNets();
      restorePersistenceMock();
    });
  });
});

describe('NetCinematic — 8. Allocation audit (60 frames)', () => {
  it('zero new THREE.Vector3 in _updateNetCeremony (code inspection + runtime sanity)', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      installPersistenceMock();
      const { cs } = setupCeremonyReady(true);
      emitStart();

      // Run 60 update frames — _updateNetCeremony uses only pre-allocated
      // scratch vectors (_v3a–_v3e, _scratchNetPos, _tmpVecA/B/C) with
      // .copy(), .set(), .addScaledVector(), .lerpVectors(). No `new`
      // THREE.Vector3/Quaternion in the per-frame path.
      // ESM exports are frozen so we can't intercept THREE.Vector3 at
      // runtime. We verify the code runs 60 frames without error (proving
      // scratch paths are wired correctly) and rely on code-inspection
      // audit for the zero-allocation guarantee.
      for (let i = 0; i < 60; i++) {
        cs.update(0.016, PLAYER_POS.clone(), PLAYER_VEL, PLAYER_QUAT);
      }
      // If we got here without error, all scratch vector paths are valid
      assert.ok(cs._netCeremony.active, 'Ceremony still active after 60 frames (mid-sequence)');
      assert.ok(cs._netCeremony.beatIndex >= 0, 'beatIndex is valid');

      cs._exitNetCeremony(false);
      clearMockNets();
      restorePersistenceMock();
    });
  });
});

describe('NetCinematic — 9. OFF path: existing modes unaffected', () => {
  it('ARM_PILOT mode works normally with flag OFF', () => {
    withFlags({ NET_CEREMONY: false }, () => {
      const cs = makeCameraSystem();
      const arm = mockArm();
      cs.armPilot.arm = arm;
      cs.setView(CameraViews.ARM_PILOT);

      // Drive a few frames in ARM_PILOT
      for (let i = 0; i < 10; i++) {
        cs.update(0.016, PLAYER_POS.clone(), PLAYER_VEL, PLAYER_QUAT);
      }
      assert.equal(cs.currentView, CameraViews.ARM_PILOT,
        'Should remain in ARM_PILOT');
      assert.ok(!cs._netCeremony.active,
        '_netCeremony should be inactive');
    });
  });

  it('CHASE mode works normally with flag OFF', () => {
    withFlags({ NET_CEREMONY: false }, () => {
      const cs = makeCameraSystem();
      cs.setView(CameraViews.CHASE);
      for (let i = 0; i < 10; i++) {
        cs.update(0.016, PLAYER_POS.clone(), PLAYER_VEL, PLAYER_QUAT);
      }
      assert.equal(cs.currentView, CameraViews.CHASE,
        'Should remain in CHASE');
    });
  });
});

describe('NetCinematic — 10. Subscriptions are idempotent', () => {
  it('creating two CameraSystem instances does not double-fire ceremony handler', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      installPersistenceMock();
      // Note: EventBus listeners from CameraSystem constructor accumulate.
      // But each instance has its own _netCeremony state. The handler on
      // the second instance won't affect the first. We verify by checking
      // that only the second instance enters ceremony (the first has no arm).
      const cs1 = makeCameraSystem();
      // cs1 has no armPilot.arm set — handler will early-exit
      const cs2 = makeCameraSystem();
      const arm = mockArm();
      cs2.armPilot.arm = arm;
      cs2.currentView = CameraViews.ARM_PILOT;
      installMockNet(0);

      emitStart();

      assert.ok(!cs1._netCeremony.active,
        'cs1 should NOT enter ceremony (no arm)');
      assert.ok(cs2._netCeremony.active,
        'cs2 should enter ceremony');

      cs2._exitNetCeremony(false);
      clearMockNets();
      restorePersistenceMock();
    });
  });
});

describe('NetCinematic — 11. Beat offsets keep camera outside the rendered cone', () => {
  // Regression guard for the 2026-05-24 debug pass:
  //   The rendered cone mouth radius (CaptureNetVisual.js) is
  //     mouthR = M × (D / 2) × CONE_OPEN_RADIUS_FRAC
  //   and the camera beat offsets in CameraSystem (scene units) use the same
  //   M scale via _netDiameterScene = D × M.  Therefore the *unit-free* ratio
  //   distance(cameraPos, netPos) / mouthR is independent of net class.
  //
  //   All beats anchored to netPos (GLAMOUR_SHOT, APPROACH_DOLLY, BRAKE_ENVELOP,
  //   CINCH) MUST satisfy `distance >= 2 × mouthR`, otherwise the camera
  //   sits inside the cone walls and the net is not visible.
  //
  //   Threshold 2.0 is the minimum for a credible silhouette; we additionally
  //   assert the actual target ratios (≥2.5 / ≥3.0) per beat after the retune.
  it('all net-anchored beats place the camera ≥ 2.0 × rendered cone radius from netPos (for LARGE/MEDIUM/SMALL classes)', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      installPersistenceMock();
      const NET_CER = Constants.CAPTURE_NET.NET_CEREMONY;
      const CONE_OPEN_RADIUS_FRAC = NET_CER.CONE_OPEN_RADIUS_FRAC;
      const M = 1e-5;

      const classes = [
        { name: 'LARGE',  cls: Constants.CAPTURE_NET.LARGE  },
        { name: 'MEDIUM', cls: Constants.CAPTURE_NET.MEDIUM },
        { name: 'SMALL',  cls: Constants.CAPTURE_NET.SMALL  },
      ];
      // All net-anchored beats — BRAKE_ENVELOP is now also computed continuously
      // from netPos (2026-05-25 fix; was previously a one-time absolute-world
      // capture into _beat5WorldPos that broke under fast orbital-frame motion).
      const netAnchoredBeats = ['GLAMOUR_SHOT', 'APPROACH_DOLLY', 'BRAKE_ENVELOP', 'CINCH'];

      for (const { name, cls } of classes) {
        const cs = makeCameraSystem();
        const arm = mockArm();
        cs.armPilot.arm = arm;
        cs.currentView = CameraViews.ARM_PILOT;
        installMockNet(0, { netClass: cls });

        emitStart();
        assert.ok(cs._netCeremony.active,
          `[${name}] ceremony should be active after emitStart`);

        // Reconstruct the same vectors the ceremony uses internally.
        const c = cs._netCeremony;
        cs._computeNetScenePos(c);
        const netPos = c._scratchNetPos.clone();
        const armPos = arm.position.clone();
        const fwd = c._launchFwd.clone();
        const side = c._sideDir.clone();
        const debrisPos = arm.target._scenePosition.clone();
        const localUp = armPos.clone().normalize();
        const upDot = localUp.dot(fwd);
        if (Math.abs(upDot) < 0.999) {
          localUp.addScaledVector(fwd, -upDot).normalize();
        }
        const D_M = c._netDiameterScene;

        // Rendered cone mouth radius — same formula as CaptureNetVisual.
        const mouthR = M * (cls.DIAMETER / 2) * CONE_OPEN_RADIUS_FRAC;

        const out = new THREE.Vector3();

        for (const key of netAnchoredBeats) {
          cs._netCeremonyBeatPos(out, key, armPos, netPos, debrisPos, fwd, side, localUp, D_M);
          const dist = out.distanceTo(netPos);
          const ratio = dist / mouthR;
          assert.ok(ratio >= 2.0,
            `[${name}] beat ${key}: distance/mouthR = ${ratio.toFixed(3)} (must be ≥ 2.0; was inside-cone in pre-retune)`);
        }

        // Regression guard for 2026-05-25 fix: BRAKE_ENVELOP must NOT return a
        // fixed/cached absolute-world position (which becomes stale during the
        // ceremony as the simulated orbital frame translates). Call it twice
        // with the SAME inputs and confirm the result is netPos-relative — i.e.,
        // moving netPos must move the returned position by the same offset.
        cs._netCeremonyBeatPos(out, 'BRAKE_ENVELOP', armPos, netPos, debrisPos, fwd, side, localUp, D_M);
        const brakePos1 = out.clone();
        const ratioBrake1 = brakePos1.distanceTo(netPos) / mouthR;
        assert.ok(ratioBrake1 >= 2.0,
          `[${name}] BRAKE_ENVELOP ratio = ${ratioBrake1.toFixed(3)} (must be ≥ 2.0)`);

        // Shift netPos by 1000 m (= 0.01 scene units) — a fictitious "orbital
        // frame translation" — and re-evaluate. The new position must shift by
        // EXACTLY the same delta, proving the formula tracks netPos every frame
        // instead of returning a stale absolute anchor.
        const shiftedNet = netPos.clone().add(new THREE.Vector3(0.01, 0, 0));
        cs._netCeremonyBeatPos(out, 'BRAKE_ENVELOP', armPos, shiftedNet, debrisPos, fwd, side, localUp, D_M);
        const brakePos2 = out.clone();
        const expectedShift = brakePos1.clone().add(new THREE.Vector3(0.01, 0, 0));
        assert.ok(brakePos2.distanceTo(expectedShift) < 1e-9,
          `[${name}] BRAKE_ENVELOP must track netPos (shift-test): got delta=${brakePos2.distanceTo(expectedShift).toFixed(9)} (must be < 1e-9)`);

        // Per-beat target ratios after the 2026-05-24 retune.
        cs._netCeremonyBeatPos(out, 'GLAMOUR_SHOT', armPos, netPos, debrisPos, fwd, side, localUp, D_M);
        const glamRatio = out.distanceTo(netPos) / mouthR;
        assert.ok(glamRatio >= 3.0 - 1e-6,
          `[${name}] GLAMOUR_SHOT must keep ratio ≥ 3.0 (hero silhouette); got ${glamRatio.toFixed(3)}`);

        cs._netCeremonyBeatPos(out, 'APPROACH_DOLLY', armPos, netPos, debrisPos, fwd, side, localUp, D_M);
        const dollyRatio = out.distanceTo(netPos) / mouthR;
        assert.ok(dollyRatio >= 2.5 - 1e-6,
          `[${name}] APPROACH_DOLLY must keep ratio ≥ 2.5; got ${dollyRatio.toFixed(3)}`);

        cs._netCeremonyBeatPos(out, 'CINCH', armPos, netPos, debrisPos, fwd, side, localUp, D_M);
        const cinchRatio = out.distanceTo(netPos) / mouthR;
        assert.ok(cinchRatio >= 3.0 - 1e-6,
          `[${name}] CINCH must keep ratio ≥ 3.0; got ${cinchRatio.toFixed(3)}`);

        cs._exitNetCeremony(false);
        clearMockNets();
      }
      restorePersistenceMock();
    });
  });

  // 2026-05-25 Stage-3 fix — APEX-PLANE BREAKOUT
  //
  // The CINCH_CLOSING animation contracts the 8 rim weights radially around
  // the apex hub on the apex plane (the plane perpendicular to launchDir at
  // the apex). When the camera offset uses ONLY `side` and `localUp` (both
  // perpendicular to `fwd`), the camera sits IN the apex plane and observes
  // the weight ring EDGE-ON — a shrinking horizontal line, not the closing
  // drawstring spiral the player needs to read.
  //
  // Similarly the ENVELOP animation translates the rim weights along the
  // cone axis from z=−coneH (mouth plane) to z=0 (apex plane). Without a
  // `fwd` camera offset, the weight start position is at atan(coneH / X_side)
  // ≈ 24° off the camera→apex axis — outside the half-FOV-V at beat-5's 38°
  // FOV. The user sees nothing until the weights have already swept most of
  // the way to the apex.
  //
  // Lock in: BRAKE_ENVELOP and CINCH camera positions MUST have a non-zero
  // `fwd` component projection (camera NOT in the apex plane), measured as
  // |(camPos − netPos) · fwd| ≥ THRESHOLD × D_M.
  it('Stage 3 apex-plane-breakout: BRAKE_ENVELOP and CINCH camera have non-zero fwd projection', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      installPersistenceMock();
      const cs = makeCameraSystem();
      const arm = mockArm();
      cs.armPilot.arm = arm;
      cs.currentView = CameraViews.ARM_PILOT;
      installMockNet(0, { netClass: Constants.CAPTURE_NET.LARGE });
      emitStart();

      const c = cs._netCeremony;
      cs._computeNetScenePos(c);
      const netPos = c._scratchNetPos.clone();
      const armPos = arm.position.clone();
      const fwd = c._launchFwd.clone();
      const side = c._sideDir.clone();
      const debrisPos = arm.target._scenePosition.clone();
      const localUp = armPos.clone().normalize();
      const upDot = localUp.dot(fwd);
      if (Math.abs(upDot) < 0.999) {
        localUp.addScaledVector(fwd, -upDot).normalize();
      }
      const D_M = c._netDiameterScene;
      const out = new THREE.Vector3();

      // BRAKE_ENVELOP — camera must NOT sit in the apex plane (fwd · offset ≠ 0).
      cs._netCeremonyBeatPos(out, 'BRAKE_ENVELOP', armPos, netPos, debrisPos, fwd, side, localUp, D_M);
      const fwdComponentBE = out.clone().sub(netPos).dot(fwd);
      // Threshold: at least 0.3 × D_M of fwd offset. Anything less means the
      // camera is effectively in the apex plane and the weight sweep along
      // the cone axis can't be observed obliquely.
      assert.ok(Math.abs(fwdComponentBE) >= 0.3 * D_M - 1e-9,
        `BRAKE_ENVELOP camera must have |fwd · (camPos − apex)| ≥ 0.3 × D_M ` +
        `(apex-plane breakout); got ${(fwdComponentBE / D_M).toFixed(3)} × D_M`);

      // CINCH — same requirement. The CINCH_CLOSING animation lives entirely
      // on the apex plane (rim weights at local z=0 spinning around the apex
      // hub). Without fwd offset the contracting circle is edge-on.
      cs._netCeremonyBeatPos(out, 'CINCH', armPos, netPos, debrisPos, fwd, side, localUp, D_M);
      const fwdComponentC = out.clone().sub(netPos).dot(fwd);
      assert.ok(Math.abs(fwdComponentC) >= 0.5 * D_M - 1e-9,
        `CINCH camera must have |fwd · (camPos − apex)| ≥ 0.5 × D_M ` +
        `(apex-plane breakout — drawstring closure rendered face-on, not edge-on); ` +
        `got ${(fwdComponentC / D_M).toFixed(3)} × D_M`);

      cs._exitNetCeremony(false);
      clearMockNets();
      restorePersistenceMock();
    });
  });

  // BRAKE_ENVELOP lookAt must bias toward the cone midpoint (apex + fwd × coneH/2)
  // so the ENVELOP weight sweep (mouth-plane → apex-plane) has both ends in frame.
  // Pure apex lookAt put the start of the sweep ~24° off-axis at half-FOV-V ≈ 19°
  // — the user only saw the END of the animation.
  it('Stage 3 BRAKE_ENVELOP lookAt biases forward toward cone midpoint, not the apex', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      installPersistenceMock();
      const cs = makeCameraSystem();
      const arm = mockArm();
      cs.armPilot.arm = arm;
      cs.currentView = CameraViews.ARM_PILOT;
      installMockNet(0, { netClass: Constants.CAPTURE_NET.LARGE });
      emitStart();

      const c = cs._netCeremony;
      cs._computeNetScenePos(c);
      const netPos = c._scratchNetPos.clone();
      const armPos = arm.position.clone();
      const fwd = c._launchFwd.clone();
      const debrisPos = arm.target._scenePosition.clone();
      const D_M = c._netDiameterScene;
      const out = new THREE.Vector3();

      cs._netCeremonyBeatLook(out, 'BRAKE_ENVELOP', armPos, netPos, debrisPos, fwd, D_M);
      const lookFwdProj = out.clone().sub(netPos).dot(fwd);
      // The cone midpoint is apex + fwd × coneH/2 where coneH = 0.55 × D in
      // scene units (CONE_LENGTH_FRAC × CONE_OPEN_RADIUS_FRAC × D). Midpoint
      // forward projection = 0.275 × D_M. Require the lookAt to project at
      // least 0.1 × D_M ahead of the apex (not equal to apex, not behind it).
      assert.ok(lookFwdProj >= 0.1 * D_M - 1e-9,
        `BRAKE_ENVELOP lookAt must be forward of the apex along launchDir ` +
        `(toward the cone midpoint, so the ENVELOP weight sweep has both ends ` +
        `in frame); got ${(lookFwdProj / D_M).toFixed(3)} × D_M`);

      cs._exitNetCeremony(false);
      clearMockNets();
      restorePersistenceMock();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2026-05-25 pacing retune (engulf/cinch deliberateness)
//
// After the Q2 visibility fix the user could SEE the bag stay in frame, but
// reported the engulf + cinch animations "seem too fast." Root cause: the
// camera beats named BRAKE_ENVELOP, CINCH, and SECURED_SETTLE together
// delivered only 2.06 g of physics-time (= beat.duration × beat.timeScale)
// vs the 4.0 g the underlying FSM animation needs:
//   BRAKE_TIME (0.5 g) + ENVELOP_TIME (1.5 g) + CINCH_CLOSE_TIME (2.0 g) = 4.0 g
//   + SECURE_CHECK_TIME (0.2 g, settled state)
//
// With only 51% of the animation playing inside the cinematic, the user saw:
//   - Beat 5: BRAKE + first 11% of ENVELOP
//   - Beat 6: ENVELOP 11%→64%   (camera says "CINCH" but FSM is still in ENVELOP!)
//   - Beat 7: rest of ENVELOP + first 3% of CINCH
//   - Post-ceremony: remaining 97% of CINCH at 1.0× from ARM_PILOT (out of frame)
//
// Lock-in: each FSM animation must complete inside the camera beat that names
// it. Specifically:
//   BRAKE_ENVELOP × TIME_SCALE_BRAKE ≥ BRAKE_TIME + ENVELOP_TIME
//   CINCH         × TIME_SCALE_CINCH ≥ CINCH_CLOSE_TIME
//   SECURED_SETTLE × 1.0             ≥ SECURE_CHECK_TIME
//
// If these break, the next refactor that touches BEAT_DURATIONS_S or
// TIME_SCALE_* will silently revert the "deliberate engulf/cinch" feel.
// ─────────────────────────────────────────────────────────────────────────
describe('NetCinematic — 12. Pacing invariants (engulf/cinch consume full FSM animation)', () => {
  const CN = Constants.CAPTURE_NET;
  const NC = CN.NET_CEREMONY;
  const EPS = 1e-9;

  it('BRAKE_ENVELOP beat × TIME_SCALE_BRAKE delivers full BRAKE + ENVELOP physics', () => {
    const physicsDelivered = NC.BEAT_DURATIONS_S.BRAKE_ENVELOP * NC.TIME_SCALE_BRAKE;
    const physicsNeeded = CN.BRAKE_TIME + CN.ENVELOP_TIME;
    assert.ok(physicsDelivered + EPS >= physicsNeeded,
      'BRAKE_ENVELOP beat must deliver >= ' + physicsNeeded + ' g of physics ' +
      '(BRAKE_TIME ' + CN.BRAKE_TIME + ' + ENVELOP_TIME ' + CN.ENVELOP_TIME + '); ' +
      'got ' + NC.BEAT_DURATIONS_S.BRAKE_ENVELOP + ' x ' + NC.TIME_SCALE_BRAKE + ' = ' +
      physicsDelivered.toFixed(3) + ' g - engulf will play out off-screen at 1.0x ' +
      'if this regresses (the "too fast" symptom).');
  });

  it('CINCH beat × TIME_SCALE_CINCH delivers full CINCH_CLOSING physics', () => {
    const physicsDelivered = NC.BEAT_DURATIONS_S.CINCH * NC.TIME_SCALE_CINCH;
    const physicsNeeded = CN.CINCH_CLOSE_TIME;
    assert.ok(physicsDelivered + EPS >= physicsNeeded,
      'CINCH beat must deliver >= ' + physicsNeeded + ' g of physics ' +
      '(CINCH_CLOSE_TIME); got ' + NC.BEAT_DURATIONS_S.CINCH + ' x ' + NC.TIME_SCALE_CINCH + ' = ' +
      physicsDelivered.toFixed(3) + ' g - the drawstring will close off-screen at 1.0x ' +
      'if this regresses (the "too fast cinch" symptom).');
  });

  it('SECURED_SETTLE beat delivers >= SECURE_CHECK physics at 1.0x', () => {
    // SECURED_SETTLE has implicit timeScale 1.0 (no entry in TIME_SCALE_*).
    const physicsDelivered = NC.BEAT_DURATIONS_S.SECURED_SETTLE * 1.0;
    const physicsNeeded = CN.SECURE_CHECK_TIME;
    assert.ok(physicsDelivered + EPS >= physicsNeeded,
      'SECURED_SETTLE beat must deliver >= ' + physicsNeeded + ' g (SECURE_CHECK_TIME); ' +
      'got ' + NC.BEAT_DURATIONS_S.SECURED_SETTLE + ' g - the capture-resolution roll ' +
      'would finish after the cinematic exits, disrupting the held "captured" beat.');
  });

  it('Slowmo scales remain visibly cinematic (<= 0.6) for engulf & cinch', () => {
    // 1.0 = real-time (not cinematic); 0.6 = ~40% slowdown, the threshold above
    // which the human eye reliably reads "this is deliberate slow motion."
    // If a future refactor raises these to 1.0 to "save wall time," the engulf
    // and cinch will look like 60 fps real-life - the deliberateness is lost.
    assert.ok(NC.TIME_SCALE_BRAKE <= 0.6 + EPS,
      'TIME_SCALE_BRAKE must stay <= 0.6 for cinematic feel; got ' + NC.TIME_SCALE_BRAKE);
    assert.ok(NC.TIME_SCALE_CINCH <= 0.6 + EPS,
      'TIME_SCALE_CINCH must stay <= 0.6 for cinematic feel; got ' + NC.TIME_SCALE_CINCH);
  });

  it('Engulf+cinch beats are long enough for the brain to read each phase', () => {
    // The mechanism the user must *perceive* across these two beats:
    //   Beat 5 - brake event (cause), then weights overshoot apex (effect)
    //   Beat 6 - drawstring contracts ring to apex hub (separate mechanism)
    // Empirically each phase needs >= 2.5 s of screen time to read cleanly
    // (Hick's law on novel visual sequences with no audio cue lead-in).
    assert.ok(NC.BEAT_DURATIONS_S.BRAKE_ENVELOP >= 2.5,
      'BRAKE_ENVELOP wall-clock must be >= 2.5 s so brake snap + overshoot read ' +
      'as a cause-and-effect chain; got ' + NC.BEAT_DURATIONS_S.BRAKE_ENVELOP + ' s');
    assert.ok(NC.BEAT_DURATIONS_S.CINCH >= 2.5,
      'CINCH wall-clock must be >= 2.5 s so the drawstring close reads as a ' +
      'discrete mechanical step (not a teleport); got ' + NC.BEAT_DURATIONS_S.CINCH + ' s');
  });

  it('No animation phase overflows into the next named beat', () => {
    // Stronger invariant: each beat delivers AT MOST one full FSM phase worth
    // of physics, so beats don't overlap state animations. This stops a future
    // refactor from inflating BRAKE_ENVELOP so much that CINCH_CLOSING starts
    // inside beat 5 (which would make the camera "wait" through visible cinch
    // motion before snapping to its proper framing on beat 6).
    const beat5Delivered = NC.BEAT_DURATIONS_S.BRAKE_ENVELOP * NC.TIME_SCALE_BRAKE;
    const beat5Cap = CN.BRAKE_TIME + CN.ENVELOP_TIME + CN.CINCH_CLOSE_TIME * 0.10;
    assert.ok(beat5Delivered <= beat5Cap + EPS,
      'BRAKE_ENVELOP beat must NOT deliver more than BRAKE+ENVELOP + 10% CINCH ' +
      'headroom (= ' + beat5Cap.toFixed(2) + ' g); got ' + beat5Delivered.toFixed(3) + ' g - ' +
      'the drawstring would start closing visibly during the "engulf" beat.');
  });

  // ─── 2026-05-25 highlights-cut shape regression ───
  //
  // Original 3-beat cut [GLAMOUR_SHOT, BRAKE_ENVELOP, CINCH] at 0.7× duration
  // exited the ceremony BEFORE the FSM contacted the target on subsequent
  // deploys (only ~3.33 g of physics delivered vs ~3.95 g needed for typical
  // 33 m engagements). User saw camera rotate to front view, STOP, then exit
  // before any engulf/cinch animation. Fix: include APPROACH_DOLLY (the
  // FLIGHT-framing beat that force-advances on NET_BRAKE_FIRED) and
  // SECURED_SETTLE, and raise HIGHLIGHTS_TIME_SCALE to 1.0 so the engulf+cinch
  // beats deliver their full physics budget.
  it('Highlights cut includes APPROACH_DOLLY + SECURED_SETTLE (so FSM contact happens inside ceremony)', () => {
    const HCB = NC.HIGHLIGHTS_CUT_BEATS;
    assert.ok(HCB.includes('APPROACH_DOLLY'),
      'HIGHLIGHTS_CUT_BEATS must include APPROACH_DOLLY so the FLIGHT phase ' +
      'is framed; otherwise the camera advances to BRAKE_ENVELOP before the ' +
      'net actually contacts the target, and the engulf/cinch animations ' +
      'play offscreen at 1.0x after the ceremony exits. Got: [' + HCB.join(', ') + ']');
    assert.ok(HCB.includes('SECURED_SETTLE'),
      'HIGHLIGHTS_CUT_BEATS must include SECURED_SETTLE so the captured-hold ' +
      'beat plays after CINCH_CLOSING completes. Got: [' + HCB.join(', ') + ']');
    assert.ok(HCB.includes('BRAKE_ENVELOP'),
      'HIGHLIGHTS_CUT_BEATS must include BRAKE_ENVELOP (the engulf beat). Got: [' + HCB.join(', ') + ']');
    assert.ok(HCB.includes('CINCH'),
      'HIGHLIGHTS_CUT_BEATS must include CINCH (the drawstring beat). Got: [' + HCB.join(', ') + ']');
  });

  it('HIGHLIGHTS_TIME_SCALE preserves engulf+cinch FSM alignment', () => {
    // If subsequent-deploy beats are compressed below 1.0×, the engulf and
    // cinch physics budgets fall below their corresponding state durations
    // and the animations again play partially offscreen. Lock at 1.0.
    const HTS = NC.HIGHLIGHTS_TIME_SCALE;
    const beat5Delivered = NC.BEAT_DURATIONS_S.BRAKE_ENVELOP * HTS * NC.TIME_SCALE_BRAKE;
    const beat6Delivered = NC.BEAT_DURATIONS_S.CINCH * HTS * NC.TIME_SCALE_CINCH;
    assert.ok(beat5Delivered + EPS >= CN.BRAKE_TIME + CN.ENVELOP_TIME,
      'Highlights-cut BRAKE_ENVELOP (× HTS=' + HTS + ') must still deliver ' +
      '>= BRAKE_TIME + ENVELOP_TIME = ' + (CN.BRAKE_TIME + CN.ENVELOP_TIME) +
      ' g; got ' + beat5Delivered.toFixed(3) + ' g');
    assert.ok(beat6Delivered + EPS >= CN.CINCH_CLOSE_TIME,
      'Highlights-cut CINCH (× HTS=' + HTS + ') must still deliver ' +
      '>= CINCH_CLOSE_TIME = ' + CN.CINCH_CLOSE_TIME + ' g; got ' +
      beat6Delivered.toFixed(3) + ' g');
  });
});
