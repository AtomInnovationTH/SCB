/**
 * test-NetCeremonyFirstDeploy.js — Q2 Stage 5: First-deploy persistence + E2E wire
 *
 * Verifies the end-to-end persistence wiring for the Q2 Net-Launch Ceremony
 * (CEREMONY_REDESIGN.md §5.6), covering:
 *
 *   1. Cold-start default — getCeremonyFlag('FIRST_NET_DEPLOY') === false
 *   2. First ceremony plays the full 7-beat sequence (FIRST_NET_DEPLOY=false)
 *   3. Successful first ceremony sets FIRST_NET_DEPLOY=true (via _exitNetCeremony)
 *   4. Save round-trip preserves the flag through localStorage JSON serialization
 *   5. Second ceremony uses the highlights-cut (3 beats)
 *   6. Miss does NOT set FIRST_NET_DEPLOY
 *   7. External mode switch (setView) — documents CURRENT BEHAVIOR (see TODO note)
 *   8. Save while ceremony is active does NOT corrupt persistence
 *   9. Two successful ceremonies in the same session — idempotent set
 *  10. Flag-OFF byte-identicality — no camera-mode change, no flag write
 *
 * Stage 5 contract: read-only against Stages 0–4 source. This test file adds
 * coverage only; no production code is modified.
 */

import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { CameraSystem, CameraViews } from '../systems/CameraSystem.js';
import { persistenceManager } from '../systems/PersistenceManager.js';
import { captureNetSystem } from '../entities/CaptureNet.js';
import { CeremonyTimeScale } from '../systems/CeremonyTimeScale.js';

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

// ─── localStorage Mock (REAL round-trip via in-memory store) ────────────
//
// Test-NetCinematic stubs getCeremonyFlag/setCeremonyFlag at the API level,
// which bypasses the JSON serialization layer. For Stage 5's round-trip
// assertions (tests 4 + 8), we need the real save()/load() path to execute,
// so we install a localStorage shim and flip persistenceManager._storageAvailable
// to true per test via try/finally.

class MockLocalStorage {
  constructor() { this._store = {}; }
  getItem(k) {
    return Object.prototype.hasOwnProperty.call(this._store, k) ? this._store[k] : null;
  }
  setItem(k, v) { this._store[k] = String(v); }
  removeItem(k) { delete this._store[k]; }
  clear() { this._store = {}; }
  key(i) { return Object.keys(this._store)[i] ?? null; }
  get length() { return Object.keys(this._store).length; }
}

if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = new MockLocalStorage();
}

// ─── Constants ──────────────────────────────────────────────────────────

// Must match the private SAVE_KEY in PersistenceManager.js (line 11). Kept
// inline so a rename surfaces here loudly as a test failure rather than a
// silent drift.
const SAVE_KEY = 'spacecowboy_save_v1';

const BD  = Constants.CAPTURE_NET.NET_CEREMONY.BEAT_DURATIONS_S;
const HCB = Constants.CAPTURE_NET.NET_CEREMONY.HIGHLIGHTS_CUT_BEATS;
const HTS = Constants.CAPTURE_NET.NET_CEREMONY.HIGHLIGHTS_TIME_SCALE;

// Total wall-clock duration of the full 7-beat ceremony (cf. CameraSystem
// beat construction; APPROACH_DOLLY is a hardcoded 8.0 s safety cap as of
// 2026-05-25 — was 2.0 s, raised so FLIGHT phase can complete inside the
// beat for typical 30–80 m engagements. NET_BRAKE_FIRED force-advances out
// of the beat as soon as contact occurs).
const FULL_DURATION = BD.POD_MUZZLE_PREFIRE + BD.MUZZLE_EXIT_SPINUP +
                      BD.GLAMOUR_SHOT + 8.0 + BD.BRAKE_ENVELOP +
                      BD.CINCH + BD.SECURED_SETTLE;

const FULL_7_BEAT_KEYS = [
  'POD_MUZZLE_PREFIRE',
  'MUZZLE_EXIT_SPINUP',
  'GLAMOUR_SHOT',
  'APPROACH_DOLLY',
  'BRAKE_ENVELOP',
  'CINCH',
  'SECURED_SETTLE',
];

// ─── Helpers ────────────────────────────────────────────────────────────

/** Save and restore feature flags across a test. */
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

/**
 * Force PersistenceManager to use the real save/load path through our
 * localStorage mock, with a clean store at start and end. Wraps `fn` in
 * try/finally so storage and the _storageAvailable flag are restored even
 * on assertion failure.
 */
function withRealPersistence(fn) {
  const prevAvail = persistenceManager._storageAvailable;
  persistenceManager._storageAvailable = true;
  try {
    globalThis.localStorage.clear();
    fn();
  } finally {
    globalThis.localStorage.clear();
    persistenceManager._storageAvailable = prevAvail;
    // Ensure CeremonyTimeScale is reset between tests (a hung ceremony
    // could leave it non-1.0×).
    CeremonyTimeScale.reset();
  }
}

function mockCanvas() {
  return { addEventListener: () => {}, removeEventListener: () => {} };
}

function makeCameraSystem() {
  const camera = new THREE.PerspectiveCamera(55, 1, 0.001, 1000);
  return new CameraSystem(camera, mockCanvas());
}

function mockArm(overrides = {}) {
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
    ...overrides,
  };
}

function installMockNet(armIndex, overrides = {}) {
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
    ...overrides,
  };
  captureNetSystem.activeNets.push(net);
  return net;
}

function clearMockNets() {
  captureNetSystem.activeNets.length = 0;
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

/** Build a CameraSystem in ARM_PILOT with a mock arm + a mock net registered. */
function setupCeremonyReady() {
  const cs = makeCameraSystem();
  const arm = mockArm();
  cs.armPilot.arm = arm;
  cs.currentView = CameraViews.ARM_PILOT;
  installMockNet(0);
  return { cs, arm };
}

/** Drive the full 7-beat sequence to completion (success path). */
function driveFullCeremony(cs) {
  cs._netCeremony.success = true;
  driveCamera(cs, FULL_DURATION + 0.1);
}

// ═════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ═════════════════════════════════════════════════════════════════════════

describe('NetCeremonyFirstDeploy — 1. Cold-start default', () => {
  it('getCeremonyFlag returns false on a fresh save store', () => {
    withRealPersistence(() => {
      // Fresh localStorage; no save data written.
      const flag = persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY');
      assert.equal(flag, false,
        `FIRST_NET_DEPLOY should default to false, got ${flag}`);
    });
  });

  it('getCeremonyFlag returns false when save exists but flag field is absent (legacy save compat)', () => {
    withRealPersistence(() => {
      // Simulate a pre-Stage-0 save that lacks ceremonyFlags entirely.
      globalThis.localStorage.setItem(SAVE_KEY, JSON.stringify({
        version: 1, timestamp: 0,
      }));
      const flag = persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY');
      assert.equal(flag, false,
        `Legacy save without ceremonyFlags should yield false, got ${flag}`);
    });
  });
});

describe('NetCeremonyFirstDeploy — 2. First ceremony plays full 7 beats', () => {
  it('enters NET_CINEMATIC with 7 beats whose keys match the canonical full sequence', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      withRealPersistence(() => {
        const { cs } = setupCeremonyReady();
        // Sanity: flag is false at start
        assert.equal(persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY'), false,
          'Pre-condition: flag must be false');

        emitStart();

        assert.ok(cs._netCeremony.active, '_netCeremony should be active');
        assert.equal(cs.currentView, CameraViews.NET_CINEMATIC,
          `View should be NET_CINEMATIC, got ${cs.currentView}`);
        assert.equal(cs._netCeremony.beats.length, 7,
          `Expected 7 beats, got ${cs._netCeremony.beats.length}`);
        for (let i = 0; i < FULL_7_BEAT_KEYS.length; i++) {
          assert.equal(cs._netCeremony.beats[i].key, FULL_7_BEAT_KEYS[i],
            `Beat ${i} key mismatch — expected ${FULL_7_BEAT_KEYS[i]}, got ${cs._netCeremony.beats[i].key}`);
        }
        assert.equal(cs._netCeremony.isFirstEver, true,
          'isFirstEver should be true on first-ever deploy');

        // Cleanup
        cs._exitNetCeremony(false);
        clearMockNets();
      });
    });
  });
});

describe('NetCeremonyFirstDeploy — 3. Successful first ceremony sets FIRST_NET_DEPLOY=true', () => {
  it('drives all 7 beats with success=true and writes the persistence flag', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      withRealPersistence(() => {
        const { cs } = setupCeremonyReady();
        emitStart();
        assert.ok(cs._netCeremony.active, 'Ceremony must be active');
        assert.equal(persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY'), false,
          'Pre-condition: flag must be false');

        // Mark success (CameraSystem reads this in _exitNetCeremony)
        driveFullCeremony(cs);

        assert.ok(!cs._netCeremony.active,
          'Ceremony should be inactive after all beats complete');
        assert.equal(persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY'), true,
          'FIRST_NET_DEPLOY should be true after successful first ceremony');

        clearMockNets();
      });
    });
  });
});

describe('NetCeremonyFirstDeploy — 4. Save round-trip preserves the flag', () => {
  it('persists FIRST_NET_DEPLOY=true through localStorage JSON across save() → load()', () => {
    withRealPersistence(() => {
      // Set via the typed API (which writes through save())
      const setOk = persistenceManager.setCeremonyFlag('FIRST_NET_DEPLOY', true);
      assert.equal(setOk, true, 'setCeremonyFlag should return true on success');

      // Read raw localStorage and verify the JSON contains the flag
      const raw = globalThis.localStorage.getItem(SAVE_KEY);
      assert.ok(raw, 'Save data should exist in localStorage');
      const parsed = JSON.parse(raw);
      assert.ok(parsed.ceremonyFlags,
        `Parsed save should contain ceremonyFlags, got ${JSON.stringify(parsed.ceremonyFlags)}`);
      assert.equal(parsed.ceremonyFlags.FIRST_NET_DEPLOY, true,
        'Raw JSON should show FIRST_NET_DEPLOY: true');

      // Round-trip via load() (which re-parses from localStorage)
      const loaded = persistenceManager.load();
      assert.ok(loaded, 'load() should return parsed save data');
      assert.equal(loaded.ceremonyFlags?.FIRST_NET_DEPLOY, true,
        'load() should yield FIRST_NET_DEPLOY: true');

      // getCeremonyFlag (which uses peek()) confirms the same
      assert.equal(persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY'), true,
        'getCeremonyFlag should agree after round-trip');
    });
  });

  it('round-trips false correctly when explicitly written', () => {
    withRealPersistence(() => {
      persistenceManager.setCeremonyFlag('FIRST_NET_DEPLOY', true);
      persistenceManager.setCeremonyFlag('FIRST_NET_DEPLOY', false);
      assert.equal(persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY'), false,
        'Overwriting true→false should round-trip correctly');
    });
  });
});

describe('NetCeremonyFirstDeploy — 5. Second ceremony uses highlights-cut', () => {
  it('emits NET_CEREMONY_START with FIRST_NET_DEPLOY=true → 3 highlight beats', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      withRealPersistence(() => {
        // Pre-set the flag (simulating a prior successful ceremony)
        persistenceManager.setCeremonyFlag('FIRST_NET_DEPLOY', true);
        assert.equal(persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY'), true,
          'Pre-condition: flag must be true');

        const { cs } = setupCeremonyReady();
        emitStart();

        assert.ok(cs._netCeremony.active, 'Ceremony should be active');
        // 2026-05-25: highlights cut expanded from 3 → 5 beats. Old 3-beat
        // cut (GLAMOUR + BRAKE_ENVELOP + CINCH at 0.7×) ended BEFORE the FSM
        // contacted the target on subsequent deploys — user saw the camera
        // rotate to the front view, then STOP, then exit before any engulf
        // or cinch animation played. Adding APPROACH_DOLLY (FLIGHT-framing,
        // force-advances on NET_BRAKE_FIRED) and SECURED_SETTLE (captured
        // hold beat) and setting HIGHLIGHTS_TIME_SCALE=1.0 fixed it.
        assert.equal(cs._netCeremony.beats.length, 5,
          `Expected 5 highlight beats, got ${cs._netCeremony.beats.length}`);
        const expectedKeys = ['GLAMOUR_SHOT', 'APPROACH_DOLLY', 'BRAKE_ENVELOP', 'CINCH', 'SECURED_SETTLE'];
        for (let i = 0; i < expectedKeys.length; i++) {
          assert.equal(cs._netCeremony.beats[i].key, expectedKeys[i],
            `Beat ${i} key should be ${expectedKeys[i]}, got ${cs._netCeremony.beats[i].key}`);
        }
        assert.equal(cs._netCeremony.isFirstEver, false,
          'isFirstEver should be false on repeat deploy');

        // Verify highlight durations are scaled by HIGHLIGHTS_TIME_SCALE.
        // APPROACH_DOLLY is a special case: it has no single BEAT_DURATIONS_S
        // entry (only _MIN/_MAX), so CameraSystem uses the hardcoded 8.0 s
        // safety cap (force-advances on NET_BRAKE_FIRED). Highlights cut
        // applies HTS to that cap too.
        for (let i = 0; i < expectedKeys.length; i++) {
          const expected = expectedKeys[i] === 'APPROACH_DOLLY'
            ? 8.0 * HTS
            : BD[expectedKeys[i]] * HTS;
          assert.closeTo(cs._netCeremony.beats[i].duration, expected, 0.0001,
            `Beat ${i} duration should be ${expected.toFixed(3)}, got ${cs._netCeremony.beats[i].duration.toFixed(3)}`);
        }

        cs._exitNetCeremony(false);
        clearMockNets();
      });
    });
  });
});

describe('NetCeremonyFirstDeploy — 6. Miss does NOT set FIRST_NET_DEPLOY', () => {
  it('NET_CEREMONY_COMPLETE with success=false exits without writing the flag', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      withRealPersistence(() => {
        const { cs } = setupCeremonyReady();
        emitStart();
        assert.ok(cs._netCeremony.active, 'Ceremony must start');
        assert.equal(persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY'), false,
          'Pre-condition: flag must be false');

        // Drive partway
        driveCamera(cs, 0.5);
        assert.ok(cs._netCeremony.active, 'Ceremony still active mid-flight');

        // Miss path
        eventBus.emit(Events.NET_CEREMONY_COMPLETE, {
          armIndex: 0, podIndex: -1, mode: 'CINCH', success: false,
        });

        assert.ok(!cs._netCeremony.active,
          'Ceremony should be inactive after miss');
        assert.equal(persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY'), false,
          'FIRST_NET_DEPLOY should remain false after miss');

        clearMockNets();
      });
    });
  });
});

describe('NetCeremonyFirstDeploy — 7. External abort path is clean', () => {
  // Stage 6 patch: cameraSystem.setView(NEW_VIEW) called during an ACTIVE
  // ceremony aborts the ceremony cleanly via _abortNetCeremony (FOV restored,
  // time-scale reset, FIRST_NET_DEPLOY NOT written). The new view is then set
  // by setView's normal flow. NET_CINEMATIC entries from the ceremony itself
  // are exempt from the abort branch.

  it('setView() during active ceremony aborts cleanly (no flag write, time-scale reset)', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      withRealPersistence(() => {
        const { cs } = setupCeremonyReady();
        emitStart();
        assert.ok(cs._netCeremony.active, 'Ceremony must start');

        // Drive partway, then call external setView
        driveCamera(cs, 0.3);
        cs.setView(CameraViews.ARM_PILOT);

        // Stage 6: setView during an active ceremony aborts cleanly.
        assert.ok(!cs._netCeremony.active,
          'setView during active ceremony aborts the ceremony cleanly');
        assert.equal(CeremonyTimeScale.get(), 1.0,
          `CeremonyTimeScale should be reset to 1.0 after abort, got ${CeremonyTimeScale.get()}`);
        assert.equal(persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY'), false,
          'FIRST_NET_DEPLOY must NOT be written on abort (≠ normal completion)');
        assert.equal(cs.currentView, CameraViews.ARM_PILOT,
          `setView's requested view should win after abort, got ${cs.currentView}`);

        clearMockNets();
      });
    });
  });

  it('production abort path (NET_CEREMONY_COMPLETE success=false) restores FOV and clears time-scale', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      withRealPersistence(() => {
        const { cs } = setupCeremonyReady();
        const savedFov = cs._baseFov;
        emitStart();

        // Confirm time-scale was set by Stage 4 on entry
        const scaleDuringCeremony = CeremonyTimeScale.get();
        assert.ok(scaleDuringCeremony > 0 && scaleDuringCeremony <= 1.0,
          `CeremonyTimeScale should be in (0, 1] during ceremony, got ${scaleDuringCeremony}`);

        driveCamera(cs, 0.2);

        // Miss → clean abort
        eventBus.emit(Events.NET_CEREMONY_COMPLETE, {
          armIndex: 0, podIndex: -1, mode: 'CINCH', success: false,
        });

        assert.ok(!cs._netCeremony.active, 'Ceremony should be inactive');
        assert.closeTo(cs._baseFov, savedFov, 0.5,
          `FOV should restore to ~${savedFov}, got ${cs._baseFov}`);
        assert.equal(CeremonyTimeScale.get(), 1.0,
          `CeremonyTimeScale should be reset to 1.0, got ${CeremonyTimeScale.get()}`);
        clearMockNets();
      });
    });
  });
});

describe('NetCeremonyFirstDeploy — 8. Save during ceremony preserves persistence', () => {
  it('writing to save() mid-ceremony does NOT prematurely set FIRST_NET_DEPLOY=true', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      withRealPersistence(() => {
        const { cs } = setupCeremonyReady();
        assert.equal(persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY'), false,
          'Pre-condition');

        emitStart();
        assert.ok(cs._netCeremony.active, 'Ceremony active');

        // Drive partway — _exitNetCeremony has NOT run yet
        driveCamera(cs, 0.5);

        // Mid-ceremony save (simulating an autosave triggered by some other system)
        const saveOk = persistenceManager.save({});
        assert.equal(saveOk, true, 'save() should succeed');

        // Read raw JSON: FIRST_NET_DEPLOY should be false because the
        // success-end transition has not fired.
        const raw = globalThis.localStorage.getItem(SAVE_KEY);
        const parsed = JSON.parse(raw);
        assert.equal(parsed.ceremonyFlags?.FIRST_NET_DEPLOY, false,
          'Saved JSON should show FIRST_NET_DEPLOY: false (no premature write)');

        // Load and verify
        const loaded = persistenceManager.load();
        assert.equal(loaded.ceremonyFlags?.FIRST_NET_DEPLOY, false,
          'load() after mid-ceremony save: flag remains false');

        // Cleanup
        cs._exitNetCeremony(false);
        clearMockNets();
      });
    });
  });
});

describe('NetCeremonyFirstDeploy — 9. Two successful ceremonies in same session', () => {
  it('first ceremony writes flag; second (highlights) is idempotent — flag stays true', () => {
    withFlags({ NET_CEREMONY: true, CAPTURE_NET: true }, () => {
      withRealPersistence(() => {
        const { cs, arm } = setupCeremonyReady();
        assert.equal(persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY'), false,
          'Pre-condition');

        // ── First ceremony (full 7 beats, success) ──
        emitStart();
        assert.equal(cs._netCeremony.beats.length, 7,
          'First ceremony should be 7 beats');
        assert.equal(cs._netCeremony.isFirstEver, true,
          'isFirstEver should be true');
        driveFullCeremony(cs);
        assert.equal(persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY'), true,
          'After first ceremony: flag should be true');

        // ── Second ceremony (highlights, success) ──
        // CameraSystem reads the flag at the start of each ceremony,
        // so we need a fresh emit. The mock net must also be re-installed
        // (it was popped or stale from the prior cycle).
        clearMockNets();
        installMockNet(0);
        cs.armPilot.arm = arm;
        cs.currentView = CameraViews.ARM_PILOT;

        emitStart();
        assert.equal(cs._netCeremony.beats.length, 5,
          'Second ceremony should be 5 highlight beats (2026-05-25 retune: ' +
          'added APPROACH_DOLLY + SECURED_SETTLE so engulf+cinch play inside ceremony)');
        assert.equal(cs._netCeremony.isFirstEver, false,
          'isFirstEver should be false on repeat');

        // Drive through highlights — total wall-clock duration.
        // APPROACH_DOLLY uses CameraSystem's 8.0 s safety cap (not BD), so
        // special-case it here.
        const HIGHLIGHT_TOTAL = HCB.reduce(
          (a, k) => a + (k === 'APPROACH_DOLLY' ? 8.0 : BD[k]) * HTS,
          0,
        );
        cs._netCeremony.success = true;
        driveCamera(cs, HIGHLIGHT_TOTAL + 0.1);

        // Flag should still be true (no regression to false; no double-write
        // assertion error — _exitNetCeremony's `c.isFirstEver` guard prevents
        // setCeremonyFlag from being called twice in the same session).
        assert.equal(persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY'), true,
          'After second ceremony: flag should still be true');
        assert.ok(!cs._netCeremony.active, 'Second ceremony should be inactive');

        clearMockNets();
      });
    });
  });

  it('setCeremonyFlag(true) when already true is idempotent', () => {
    withRealPersistence(() => {
      persistenceManager.setCeremonyFlag('FIRST_NET_DEPLOY', true);
      const raw1 = globalThis.localStorage.getItem(SAVE_KEY);
      persistenceManager.setCeremonyFlag('FIRST_NET_DEPLOY', true);
      const raw2 = globalThis.localStorage.getItem(SAVE_KEY);
      const p1 = JSON.parse(raw1);
      const p2 = JSON.parse(raw2);
      // The two writes should produce semantically identical ceremonyFlags
      assert.equal(p1.ceremonyFlags.FIRST_NET_DEPLOY, p2.ceremonyFlags.FIRST_NET_DEPLOY,
        'Two consecutive setCeremonyFlag(true) calls should yield identical flag values');
      assert.equal(p2.ceremonyFlags.FIRST_NET_DEPLOY, true,
        'Final value should be true');
    });
  });
});

describe('NetCeremonyFirstDeploy — 10. OFF byte-identicality', () => {
  it('flag OFF: NET_CEREMONY_START is a no-op for camera mode + persistence', () => {
    withFlags({ NET_CEREMONY: false }, () => {
      withRealPersistence(() => {
        const cs = makeCameraSystem();
        const arm = mockArm();
        cs.armPilot.arm = arm;
        cs.currentView = CameraViews.ARM_PILOT;
        const beforeView = cs.currentView;
        const beforeFlag = persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY');

        // No mock net installed (would be wasteful — handler early-exits at line 1324)
        emitStart();

        assert.ok(!cs._netCeremony.active,
          'OFF: _netCeremony.active must stay false');
        assert.equal(cs.currentView, beforeView,
          `OFF: currentView must stay ${beforeView}, got ${cs.currentView}`);
        const afterFlag = persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY');
        assert.equal(afterFlag, beforeFlag,
          `OFF: FIRST_NET_DEPLOY must stay ${beforeFlag}, got ${afterFlag}`);
        assert.equal(CeremonyTimeScale.get(), 1.0,
          `OFF: CeremonyTimeScale must remain 1.0, got ${CeremonyTimeScale.get()}`);

        clearMockNets();
      });
    });
  });
});
