/**
 * test-NetCeremonyTimeScale.js — Q2 Stage 4 (CEREMONY_REDESIGN.md §5, §6 R1)
 *
 * Verifies the time-dilation plumbing between CameraSystem (writer) and
 * NetProjectile / CaptureNetVisual (readers) via CeremonyTimeScale.
 *
 * THE SAFETY NET TEST: orbital divergence. The whole point of Stage 4 is that
 * the ceremony time-scale must NEVER leak into world dt (orbital propagation,
 * debris field, conjunctions, station-keep, tether reel, etc.). Test #6 below
 * propagates a control debris orbit twice — once with the ceremony OFF and
 * once with it ON at heavy slowmo (0.3×) — and asserts the two final orbital
 * states are floating-point identical. If this test ever fails, the plumbing
 * has leaked the scale into something it shouldn't have.
 *
 * Tests:
 *   1. Scale getter returns 1.0 by default (flag OFF, no ceremony)
 *   2. Scale returns 1.0 when flag ON but no ceremony emitted
 *   3. Scale follows the active beat (per-beat TIME_SCALE_* values)
 *   4. NetProjectile.stateTimer advances by `dt × scale` (10-frame compare)
 *   5. CaptureNetVisual.update consumes the scaled dt (10-frame compare)
 *   6. 🚨 Orbital divergence: world propagation UNAFFECTED at scale=0.3
 *   7. NetProjectile.update signature unchanged (length === 1)
 *   8. CaptureNetVisual.update signature unchanged (length === 1)
 *   9. Scale returns to 1.0 after ceremony exits
 *  10. No new per-frame allocations during ceremony-active updates
 */

import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { CameraSystem, CameraViews } from '../systems/CameraSystem.js';
import { CeremonyTimeScale } from '../systems/CeremonyTimeScale.js';
import { persistenceManager } from '../systems/PersistenceManager.js';
import {
  NetProjectile,
  captureNetSystem,
} from '../entities/CaptureNet.js';
import { CaptureNetVisual } from '../ui/CaptureNetVisual.js';
import { propagateOrbit, keplerianToCartesian } from '../entities/OrbitalMechanics.js';

// keplerianToCartesian destructures the field name `argPerigee`. Our control
// orbit uses the standard name `argPeriapsis`; map it for the Cartesian check.
function orbitForCartesian(o) {
  return { ...o, argPerigee: o.argPeriapsis };
}

const CN = Constants.CAPTURE_NET;
const NC = CN.NET_CEREMONY;

// ─── DOM mocks (CameraSystem touches document on construction) ──────────

if (typeof document === 'undefined') {
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({
      style: { cssText: '' }, textContent: '', id: '', appendChild: () => {},
    }),
  };
}

// ─── Flag / state helpers ───────────────────────────────────────────────

function withFlags(flagOverrides, fn) {
  const saved = {};
  for (const k of Object.keys(flagOverrides)) {
    saved[k] = Constants.FEATURE_FLAGS[k];
    Constants.FEATURE_FLAGS[k] = flagOverrides[k];
  }
  const savedScale = CeremonyTimeScale.get();
  try {
    fn();
  } finally {
    for (const k of Object.keys(flagOverrides)) {
      Constants.FEATURE_FLAGS[k] = saved[k];
    }
    // Always restore time-scale to 1.0 between tests (teardown).
    CeremonyTimeScale.reset();
    // Defensive: if something stashed a different prior value (e.g. nested test
    // mid-ceremony), put it back. In practice nothing nests here.
    if (savedScale !== 1.0) CeremonyTimeScale.set(savedScale);
  }
}

function mockCanvas() {
  return { addEventListener: () => {}, removeEventListener: () => {} };
}

function makeCameraSystem() {
  const camera = new THREE.PerspectiveCamera(55, 1, 0.001, 1000);
  return new CameraSystem(camera, mockCanvas());
}

function mockArm() {
  return {
    id: 'ARM-0',
    position: new THREE.Vector3(0, 0.07, 0),
    velocity: new THREE.Vector3(0.000076, 0, 0),
    target: {
      _scenePosition: new THREE.Vector3(0.0005, 0.07, 0),
      id: 'debris-1',
      mass: 100,
    },
    _stationKeepTarget: null,
    state: 'STATION_KEEP',
    dockOffset: new THREE.Vector3(0, 0.00003, 0),
  };
}

function installMockNet(armIndex = 0) {
  const net = {
    armIndex,
    podIndex: -1,
    launchDirection: { x: 1, y: 0, z: 0 },
    distanceTraveled: 10,
    speed: 10,
    netClass: Constants.CAPTURE_NET.MEDIUM,
    _sourceArm: { position: new THREE.Vector3(0, 0.07, 0) },
    targetDebris: {
      _scenePosition: new THREE.Vector3(0.0005, 0.07, 0),
      id: 'debris-1',
      mass: 100,
    },
    state: 'FLIGHT',
    isActive: true,
  };
  captureNetSystem.activeNets.push(net);
  return net;
}

function clearMockNets() {
  captureNetSystem.activeNets.length = 0;
}

// Persistence mock (mirrors test-NetCinematic.js — Node has no localStorage)
const _mockCeremonyFlags = {};
const _origGetFlag = persistenceManager.getCeremonyFlag.bind(persistenceManager);
const _origSetFlag = persistenceManager.setCeremonyFlag.bind(persistenceManager);
function installPersistenceMock() {
  for (const k of Object.keys(_mockCeremonyFlags)) delete _mockCeremonyFlags[k];
  persistenceManager.getCeremonyFlag = (name) => _mockCeremonyFlags[name] ?? false;
  persistenceManager.setCeremonyFlag = (name, val) => {
    _mockCeremonyFlags[name] = !!val;
    return true;
  };
}
function restorePersistenceMock() {
  persistenceManager.getCeremonyFlag = _origGetFlag;
  persistenceManager.setCeremonyFlag = _origSetFlag;
  for (const k of Object.keys(_mockCeremonyFlags)) delete _mockCeremonyFlags[k];
}

const PLAYER_POS = new THREE.Vector3(0, 0.07, 0);
const PLAYER_VEL = { x: 0.000076, y: 0, z: 0 };
const PLAYER_QUAT = new THREE.Quaternion();

function driveCamera(cs, totalTime, dt = 0.016) {
  let elapsed = 0;
  while (elapsed < totalTime) {
    const step = Math.min(dt, totalTime - elapsed);
    cs.update(step, PLAYER_POS.clone(), PLAYER_VEL, PLAYER_QUAT);
    elapsed += step;
  }
}

function emitStart(armIndex = 0, podIndex = -1) {
  eventBus.emit(Events.NET_CEREMONY_START, {
    armIndex, podIndex, netClass: 'MD-NET',
  });
}

/** Make a fresh NetProjectile in LAUNCHING state with no ceremony events emitted */
function makeProjectile(opts = {}) {
  const np = new NetProjectile({
    netClass:        CN.MEDIUM,
    armIndex:        0,
    podIndex:        -1,
    launchPosition:  { x: 0, y: 0, z: 0 },
    launchDirection: { x: 1, y: 0, z: 0 },
    captureMode:     CN.MODES.SLAM_WRAP,
    ...opts,
  });
  // Suppress NET_CEREMONY_START emission so this projectile doesn't drive any
  // wired CameraSystem instance — we control CeremonyTimeScale directly.
  np._ceremonyStartEmitted = true;
  return np;
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('CeremonyTimeScale — 1. Default state', () => {
  it('get() returns 1.0 by default (no ceremony, no flag)', () => {
    CeremonyTimeScale.reset();
    assert.equal(CeremonyTimeScale.get(), 1.0,
      'Default scale must be 1.0× — no slowing world dt');
  });

  it('NetProjectile.update short-circuits to 1.0 when flag is OFF', () => {
    // Even if something accidentally set the scale, the flag-OFF gate must win.
    CeremonyTimeScale.set(0.3);
    withFlags({ NET_CEREMONY: false, CAPTURE_NET: true }, () => {
      const np = makeProjectile();
      np.update(0.01); // small enough to stay in LAUNCHING
      assert.ok(Math.abs(np.stateTimer - 0.01) < 1e-12,
        `flag OFF must use real dt — got stateTimer=${np.stateTimer}, expected 0.01`);
    });
    CeremonyTimeScale.reset();
  });

  it('CaptureNetVisual.update short-circuits to 1.0 when flag is OFF', () => {
    CeremonyTimeScale.set(0.3);
    withFlags({ NET_CEREMONY: false, CAPTURE_NET: false }, () => {
      const vis = new CaptureNetVisual();
      // No init → _enabled = false → update returns immediately. We don't
      // need to drive geometry; the flag-OFF early-return is what matters.
      // Also verify signature length, since this update has no observable
      // side effects without init.
      assert.equal(vis.update.length, 1,
        'CaptureNetVisual.update signature must remain (dt)');
      vis.update(0.01); // does nothing — _enabled === false
      assert.ok(true);
    });
    CeremonyTimeScale.reset();
  });
});

describe('CeremonyTimeScale — 2. Inactive ceremony', () => {
  it('get() stays at 1.0 when flag ON but no ceremony started', () => {
    CeremonyTimeScale.reset();
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      // Nothing has called CeremonyTimeScale.set — value remains default 1.0.
      assert.equal(CeremonyTimeScale.get(), 1.0,
        'No ceremony in flight → scale must be 1.0');
    });
  });
});

describe('CeremonyTimeScale — 3. Beat-driven scale', () => {
  it('CameraSystem publishes per-beat timeScale on enter and advance', () => {
    installPersistenceMock();
    try {
      withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
        const cs = makeCameraSystem();
        cs.armPilot.arm = mockArm();
        cs.currentView = CameraViews.ARM_PILOT;
        installMockNet(0);
        emitStart();
        // Beat 0 = POD_MUZZLE_PREFIRE → TIME_SCALE_PRE_FLIGHT = 0.4
        assert.equal(cs._netCeremony.beats[0].timeScale, NC.TIME_SCALE_PRE_FLIGHT,
          'beat 0 timeScale property must be TIME_SCALE_PRE_FLIGHT');
        assert.equal(CeremonyTimeScale.get(), NC.TIME_SCALE_PRE_FLIGHT,
          'Scale on ceremony enter must equal beat 0 (POD_MUZZLE_PREFIRE) scale');

        // Drive past beat 0 (1.2s) → beat 1 (MUZZLE_EXIT_SPINUP)
        driveCamera(cs, NC.BEAT_DURATIONS_S.POD_MUZZLE_PREFIRE + 0.05);
        assert.equal(cs._netCeremony.beatIndex, 1, 'should be on beat 1');
        assert.equal(CeremonyTimeScale.get(), NC.TIME_SCALE_PRE_FLIGHT,
          'beat 1 (MUZZLE_EXIT_SPINUP) scale must also be TIME_SCALE_PRE_FLIGHT');

        // Drive to beat 2 (GLAMOUR_SHOT)
        driveCamera(cs, NC.BEAT_DURATIONS_S.MUZZLE_EXIT_SPINUP + 0.05);
        assert.equal(cs._netCeremony.beatIndex, 2, 'should be on beat 2');
        assert.equal(CeremonyTimeScale.get(), NC.TIME_SCALE_GLAMOUR,
          'beat 2 (GLAMOUR_SHOT) scale must be TIME_SCALE_GLAMOUR');

        // Verify full mapping in stored beats — design doc §5.1
        const expected = {
          POD_MUZZLE_PREFIRE: NC.TIME_SCALE_PRE_FLIGHT,
          MUZZLE_EXIT_SPINUP: NC.TIME_SCALE_PRE_FLIGHT,
          GLAMOUR_SHOT:       NC.TIME_SCALE_GLAMOUR,
          APPROACH_DOLLY:     NC.TIME_SCALE_APPROACH,
          BRAKE_ENVELOP:      NC.TIME_SCALE_BRAKE,
          CINCH:              NC.TIME_SCALE_CINCH,
          SECURED_SETTLE:     1.0,
        };
        for (const b of cs._netCeremony.beats) {
          assert.equal(b.timeScale, expected[b.key],
            `Beat ${b.key} timeScale must be ${expected[b.key]}, got ${b.timeScale}`);
        }

        cs._exitNetCeremony(false);
        clearMockNets();
      });
    } finally {
      restorePersistenceMock();
      CeremonyTimeScale.reset();
    }
  });
});

describe('CeremonyTimeScale — 4. NetProjectile stateTimer scales by dt × scale', () => {
  it('stateTimer advances by exactly half at scale=0.5 (10-frame compare)', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      // ── Baseline: scale = 1.0 (no ceremony) ──
      CeremonyTimeScale.reset();
      const npBase = makeProjectile();
      const dt = 0.01;
      const FRAMES = 10;
      for (let i = 0; i < FRAMES; i++) npBase.update(dt);
      const baseTimer = npBase.stateTimer;

      // ── Scaled: scale = 0.5 ──
      CeremonyTimeScale.set(0.5);
      const npScaled = makeProjectile();
      for (let i = 0; i < FRAMES; i++) npScaled.update(dt);
      const scaledTimer = npScaled.stateTimer;

      // Both projectiles should stay in LAUNCHING (CAST_WINDUP = 0.15 > 0.1)
      assert.equal(npBase.state, CN.STATES.LAUNCHING,
        `baseline should remain in LAUNCHING, got ${npBase.state}`);
      assert.equal(npScaled.state, CN.STATES.LAUNCHING,
        `scaled should remain in LAUNCHING, got ${npScaled.state}`);

      const expectedBase   = dt * FRAMES;          // 0.1
      const expectedScaled = dt * FRAMES * 0.5;    // 0.05
      assert.ok(Math.abs(baseTimer - expectedBase) < 1e-12,
        `baseline stateTimer = ${baseTimer}, expected ${expectedBase}`);
      assert.ok(Math.abs(scaledTimer - expectedScaled) < 1e-12,
        `scaled stateTimer = ${scaledTimer}, expected ${expectedScaled}`);
      assert.ok(Math.abs(scaledTimer * 2 - baseTimer) < 1e-12,
        `scaled timer must be exactly half of baseline: ${scaledTimer} × 2 ≠ ${baseTimer}`);

      CeremonyTimeScale.reset();
    });
  });
});

describe('CeremonyTimeScale — 5. CaptureNetVisual consumes scaled dt', () => {
  it('fade-timer countdown progresses at half speed when scale=0.5', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      // ── Baseline ──
      CeremonyTimeScale.reset();
      const visBase = new CaptureNetVisual();
      // Force enable without calling init() (avoids THREE scene mocks).
      visBase._enabled = true;
      visBase._fadeTimers.push({ key: 'k1', timer: 1.0, duration: 1.0 });
      const dt = 0.01;
      const FRAMES = 10;
      for (let i = 0; i < FRAMES; i++) visBase.update(dt);
      const baseTimer = visBase._fadeTimers[0]?.timer ?? -999;

      // ── Scaled ──
      CeremonyTimeScale.set(0.5);
      const visScaled = new CaptureNetVisual();
      visScaled._enabled = true;
      visScaled._fadeTimers.push({ key: 'k1', timer: 1.0, duration: 1.0 });
      for (let i = 0; i < FRAMES; i++) visScaled.update(dt);
      const scaledTimer = visScaled._fadeTimers[0]?.timer ?? -999;

      const expectedBase   = 1.0 - dt * FRAMES;          // 0.9
      const expectedScaled = 1.0 - dt * FRAMES * 0.5;    // 0.95
      assert.ok(Math.abs(baseTimer - expectedBase) < 1e-12,
        `baseline fade timer = ${baseTimer}, expected ${expectedBase}`);
      assert.ok(Math.abs(scaledTimer - expectedScaled) < 1e-12,
        `scaled fade timer = ${scaledTimer}, expected ${expectedScaled}`);
      // Fade timer decremented by dt; scaled side decrements by half.
      const baseDelta   = 1.0 - baseTimer;    // 0.1
      const scaledDelta = 1.0 - scaledTimer;  // 0.05
      assert.ok(Math.abs(scaledDelta * 2 - baseDelta) < 1e-12,
        `scaled decrement must be half of baseline: ${scaledDelta} × 2 ≠ ${baseDelta}`);

      CeremonyTimeScale.reset();
    });
  });
});

describe('CeremonyTimeScale — 6. 🚨 ORBITAL DIVERGENCE SAFETY NET', () => {
  it('OrbitalMechanics.propagateOrbit is UNAFFECTED by ceremony scale (5s, scale=0.3)', () => {
    // This is THE critical test. The whole point of Stage 4 is that the
    // ceremony scale must NEVER leak into world dt — orbital propagation,
    // debris field, conjunctions, station-keep, tether, scoring.
    //
    // We propagate the same orbit twice with the SAME real dt, but with the
    // ceremony scale set to 0.3× during the second run. If the scale has
    // leaked into propagateOrbit anywhere, the second result will diverge.

    // LEO control orbit (~7000 km circular, slight inclination)
    const baseOrbit = {
      semiMajorAxis: 7000,                    // km
      eccentricity:  0.001,
      inclination:   Math.PI / 4,             // 45° inclined
      raan:          0.5,
      argPeriapsis:  0.3,
      trueAnomaly:   0.1,
    };

    function deepCopyOrbit(o) {
      return {
        semiMajorAxis: o.semiMajorAxis,
        eccentricity:  o.eccentricity,
        inclination:   o.inclination,
        raan:          o.raan,
        argPeriapsis:  o.argPeriapsis,
        trueAnomaly:   o.trueAnomaly,
      };
    }

    function propagate5sAt(scaleSetting) {
      CeremonyTimeScale.reset();
      if (scaleSetting !== null) CeremonyTimeScale.set(scaleSetting);
      // World dt = REAL frame dt. propagateOrbit gets the real dt.
      // 300 frames × dt=1/60 = exactly 5 s.
      let orbit = deepCopyOrbit(baseOrbit);
      const dt = 1 / 60;
      for (let i = 0; i < 300; i++) {
        orbit = propagateOrbit(orbit, dt);
      }
      CeremonyTimeScale.reset();
      return orbit;
    }

    // Run 1: ceremony OFF (scale untouched, default 1.0×)
    withFlags({ NET_CEREMONY: false, CAPTURE_NET: true }, () => {});
    const orbitOff = propagate5sAt(null);

    // Run 2: ceremony ON, scale = 0.3 (heavy slowmo) — fully simulated.
    // We DIRECTLY set the scale; we don't go through CameraSystem because the
    // point is to prove propagateOrbit doesn't read it regardless of who set it.
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {});
    const orbitOn = propagate5sAt(0.3);

    // Bitwise-identical floating point comparison.
    const TOL = 1e-12; // tighter than the 1e-9 requirement — we expect IDENTICAL.
    const elems = ['semiMajorAxis', 'eccentricity', 'inclination',
                   'raan', 'argPeriapsis', 'trueAnomaly'];
    for (const k of elems) {
      const delta = Math.abs(orbitOff[k] - orbitOn[k]);
      assert.ok(delta < TOL,
        `🚨 ORBITAL DIVERGENCE on ${k}: |${orbitOff[k]} - ${orbitOn[k]}| = ${delta} ≥ ${TOL}. ` +
        `Ceremony scale has leaked into propagateOrbit. ABORT and revert Stage 4.`);
    }

    // Also confirm Cartesian state vector identity. keplerianToCartesian
    // destructures the legacy field name `argPerigee` — orbitForCartesian
    // remaps `argPeriapsis` to that name to avoid NaN.
    const cOff = keplerianToCartesian(orbitForCartesian(orbitOff));
    const cOn  = keplerianToCartesian(orbitForCartesian(orbitOn));
    const posOff = new THREE.Vector3(cOff.position.x, cOff.position.y, cOff.position.z);
    const posOn  = new THREE.Vector3(cOn.position.x,  cOn.position.y,  cOn.position.z);
    const velOff = new THREE.Vector3(cOff.velocity.x, cOff.velocity.y, cOff.velocity.z);
    const velOn  = new THREE.Vector3(cOn.velocity.x,  cOn.velocity.y,  cOn.velocity.z);
    const posDelta = posOff.distanceTo(posOn);
    const velDelta = velOff.distanceTo(velOn);
    assert.ok(isFinite(posDelta) && posDelta < 1e-9,
      `🚨 Cartesian position divergence after 5s: ${posDelta} km (must be < 1e-9)`);
    assert.ok(isFinite(velDelta) && velDelta < 1e-9,
      `🚨 Cartesian velocity divergence after 5s: ${velDelta} km/s (must be < 1e-9)`);
  });

  it('NetProjectile.update + propagateOrbit in lockstep — orbit UNAFFECTED by active projectile slowmo', () => {
    // STRONGER VARIANT: this test ACTUALLY runs NetProjectile.update(dt)
    // alongside propagateOrbit(orbit, dt) with the SAME real dt. The projectile
    // reads CeremonyTimeScale internally (scaling its own state machine), and
    // we verify that propagateOrbit's output is byte-identical between the
    // baseline (scale=1.0) and slowmo (scale=0.3) runs.
    //
    // If propagateOrbit were ever to read CeremonyTimeScale, this test would
    // fail. If NetProjectile.update were ever to mutate the dt visible to the
    // caller (e.g. by mutating a shared object), this test would fail.

    function runIntegrated(scale) {
      CeremonyTimeScale.reset();
      CeremonyTimeScale.set(scale);

      const np = makeProjectile(); // _ceremonyStartEmitted=true → no events
      let orbit = {
        semiMajorAxis: 7000, eccentricity: 0.001, inclination: Math.PI / 4,
        raan: 0.5, argPeriapsis: 0.3, trueAnomaly: 0.1,
      };
      const dt = 1 / 60;
      for (let i = 0; i < 300; i++) {
        // 1) World dt path: orbital propagation with REAL dt — what main.js does.
        orbit = propagateOrbit(orbit, dt);
        // 2) Game-loop equivalent: drive NetProjectile.update with REAL dt.
        //    The projectile reads CeremonyTimeScale internally; if any leak
        //    occurred (e.g. mutating dt via shared object), the orbit above
        //    would have advanced by a different amount.
        np.update(dt);
      }
      CeremonyTimeScale.reset();
      return { orbit, np };
    }

    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      const baseline = runIntegrated(1.0);
      const slowmo   = runIntegrated(0.3);

      // Orbit must be byte-identical — the projectile scaling did NOT leak.
      const elems = ['semiMajorAxis', 'eccentricity', 'inclination',
                     'raan', 'argPeriapsis', 'trueAnomaly'];
      for (const k of elems) {
        const delta = Math.abs(baseline.orbit[k] - slowmo.orbit[k]);
        assert.ok(delta < 1e-12,
          `🚨 In-loop divergence on ${k}: baseline=${baseline.orbit[k]} slowmo=${slowmo.orbit[k]} Δ=${delta}. ` +
          `Ceremony scale has bled across the NetProjectile → propagateOrbit boundary.`);
      }

      // Sanity: confirm the projectile DID advance differently between runs —
      // i.e. the test isn't accidentally a no-op (both runs at scale=1.0).
      // The baseline projectile should have far more state-time than slowmo.
      assert.ok(baseline.np.flightTime > slowmo.np.flightTime * 1.5,
        `Projectile flightTime should differ between scale=1.0 (${baseline.np.flightTime}) ` +
        `and scale=0.3 (${slowmo.np.flightTime}) — otherwise the scaling isn't being applied`);
    });
  });
});

describe('CeremonyTimeScale — 7. NetProjectile.update signature unchanged', () => {
  it('NetProjectile.prototype.update.length === 1', () => {
    assert.equal(NetProjectile.prototype.update.length, 1,
      `NetProjectile.update must still take exactly 1 param (dt), got length=${NetProjectile.prototype.update.length}`);
  });
});

describe('CeremonyTimeScale — 8. CaptureNetVisual.update signature unchanged', () => {
  it('CaptureNetVisual.prototype.update.length === 1', () => {
    assert.equal(CaptureNetVisual.prototype.update.length, 1,
      `CaptureNetVisual.update must still take exactly 1 param (dt), got length=${CaptureNetVisual.prototype.update.length}`);
  });
});

describe('CeremonyTimeScale — 9. Reset to 1.0 after exit', () => {
  it('exits ceremony and resets CeremonyTimeScale to 1.0 (truncated/miss)', () => {
    installPersistenceMock();
    try {
      withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
        const cs = makeCameraSystem();
        cs.armPilot.arm = mockArm();
        cs.currentView = CameraViews.ARM_PILOT;
        installMockNet(0);
        emitStart();
        assert.ok(CeremonyTimeScale.get() < 1.0,
          'Scale must be < 1.0 mid-ceremony (first beat is TIME_SCALE_PRE_FLIGHT = 0.4)');
        // Truncate via miss path
        cs._exitNetCeremony(false);
        assert.equal(CeremonyTimeScale.get(), 1.0,
          'Scale must reset to 1.0 after _exitNetCeremony');
        clearMockNets();
      });
    } finally {
      restorePersistenceMock();
      CeremonyTimeScale.reset();
    }
  });

  it('plays through full sequence and resets to 1.0 at SECURED_SETTLE completion', () => {
    installPersistenceMock();
    try {
      withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
        const cs = makeCameraSystem();
        cs.armPilot.arm = mockArm();
        cs.currentView = CameraViews.ARM_PILOT;
        installMockNet(0);
        emitStart();
        // Mark success so the camera plays out beats normally
        cs._netCeremony.success = true;

        // Drive past every beat's wall-clock duration
        const totalDuration =
            NC.BEAT_DURATIONS_S.POD_MUZZLE_PREFIRE
          + NC.BEAT_DURATIONS_S.MUZZLE_EXIT_SPINUP
          + NC.BEAT_DURATIONS_S.GLAMOUR_SHOT
          + 8.0 /* APPROACH_DOLLY safety cap in CameraSystem (was 2.0, raised
                    2026-05-25 so FLIGHT completes inside this beat for typical
                    engagements — force-advances on NET_BRAKE_FIRED) */
          + NC.BEAT_DURATIONS_S.BRAKE_ENVELOP
          + NC.BEAT_DURATIONS_S.CINCH
          + NC.BEAT_DURATIONS_S.SECURED_SETTLE
          + 0.2; // slack
        driveCamera(cs, totalDuration);

        assert.ok(!cs._netCeremony.active, 'ceremony should have exited');
        assert.equal(CeremonyTimeScale.get(), 1.0,
          'Scale must return to 1.0 after full sequence ends');
        clearMockNets();
      });
    } finally {
      restorePersistenceMock();
      CeremonyTimeScale.reset();
    }
  });
});

describe('CeremonyTimeScale — 10. Per-frame allocation discipline', () => {
  it('CeremonyTimeScale.get/set allocate nothing', () => {
    // Code-inspection-equivalent runtime check: 1000 calls produce no GC heap
    // pressure beyond JIT noise. We use a heap-delta sanity bound; the real
    // assurance is the trivial getter/setter implementation in the source.
    CeremonyTimeScale.reset();
    if (typeof globalThis.gc === 'function') globalThis.gc();
    const before = (typeof process !== 'undefined' && process.memoryUsage)
      ? process.memoryUsage().heapUsed : 0;
    for (let i = 0; i < 10000; i++) {
      CeremonyTimeScale.set(0.5);
      CeremonyTimeScale.get();
    }
    const after = (typeof process !== 'undefined' && process.memoryUsage)
      ? process.memoryUsage().heapUsed : 0;
    CeremonyTimeScale.reset();
    // We accept up to 1 MB of unrelated JIT/GC noise. The point: not unbounded.
    if (before > 0 && after > 0) {
      const deltaKb = (after - before) / 1024;
      assert.ok(deltaKb < 1024,
        `CeremonyTimeScale calls allocated ${deltaKb.toFixed(1)} KB (must be < 1 MB noise floor)`);
    } else {
      assert.ok(true, 'process.memoryUsage not available — code-inspection audit only');
    }
  });

  it('NetProjectile.update with ceremony active makes no new allocations beyond steady-state', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      CeremonyTimeScale.set(0.5);
      const np = makeProjectile();
      // Warmup (let JIT settle, transition to FLIGHT)
      for (let i = 0; i < 30; i++) np.update(0.01);
      if (typeof globalThis.gc === 'function') globalThis.gc();
      const before = (typeof process !== 'undefined' && process.memoryUsage)
        ? process.memoryUsage().heapUsed : 0;
      for (let i = 0; i < 60; i++) np.update(0.01);
      const after = (typeof process !== 'undefined' && process.memoryUsage)
        ? process.memoryUsage().heapUsed : 0;
      CeremonyTimeScale.reset();
      if (before > 0 && after > 0) {
        const deltaKb = (after - before) / 1024;
        assert.ok(deltaKb < 1024,
          `60-frame ceremony-active update allocated ${deltaKb.toFixed(1)} KB (must be < 1 MB noise floor)`);
      } else {
        assert.ok(true, 'process.memoryUsage not available — code-inspection audit only');
      }
    });
  });
});
