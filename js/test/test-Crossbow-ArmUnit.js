/**
 * test-Crossbow-ArmUnit.js — V5 Crossbow ArmUnit behavior tests
 * Requires Three.js (installed via package.json for Node, import map for browser).
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { ArmUnit } from '../entities/ArmUnit.js';

const { ARM_STATES, SPRING_TIERS, TETHER_TIERS, CROSSBOW_LAUNCH_SPEED_MIN,
        CROSSBOW_LAUNCH_SPEED_MAX, V5_WEAVER_MASS, V5_SPINNER_MASS,
        CROSSBOW_LAUNCH_SPEED_DEFAULT, CROSSBOW_UNDOCK_TIME } = Constants;
const M = 0.00001;

/** Create a fresh ArmUnit with stub scene */
function makeArm(type = 'weaver', id = 'test-weaver-1') {
  const scene = { add: () => {}, remove: () => {} };
  const offset = new THREE.Vector3(M, 0, 0);
  const arm = new ArmUnit(id, type, offset, scene);
  arm.index = 0;
  eventBus.clear();
  return arm;
}

/** Create a stub debris target */
function makeTarget(id = 'debris-1', mass = 5) {
  return {
    id, mass, alive: true, type: 'fragment', tumbleRate: 0,
    _scenePosition: new THREE.Vector3(0.001, 0, 0),
    mesh: { position: new THREE.Vector3(0.001, 0, 0) },
  };
}

// ── Suite 8: ArmUnit V5 — Constructor Defaults ─────────────────────────
describe('ArmUnit V5 — Constructor Defaults', () => {
  const arm = makeArm();

  it('springTier defaults to 0', () => {
    assert.equal(arm.springTier, 0);
  });

  it('tetherTier defaults to 0', () => {
    assert.equal(arm.tetherTier, 0);
  });

  it('springCharged defaults to true', () => {
    assert.equal(arm.springCharged, true);
  });

  it('reloadProgress defaults to 0', () => {
    assert.equal(arm.reloadProgress, 0);
  });

  it('launchSpeed defaults to CROSSBOW_LAUNCH_SPEED_DEFAULT', () => {
    assert.equal(arm.launchSpeed, CROSSBOW_LAUNCH_SPEED_DEFAULT);
  });

  it('tetherTension defaults to 0', () => {
    assert.equal(arm.tetherTension, 0);
  });

  it('tetherLength defaults to 0', () => {
    assert.equal(arm.tetherLength, 0);
  });

  it('reeling defaults to false', () => {
    assert.equal(arm.reeling, false);
  });

  it('ablationTarget defaults to null', () => {
    assert.equal(arm.ablationTarget, null);
  });

  it('tangleTimer defaults to 0', () => {
    assert.equal(arm.tangleTimer, 0);
  });

  it('state defaults to DOCKED', () => {
    assert.equal(arm.state, ARM_STATES.DOCKED);
  });
});

// ── Suite 9: ArmUnit V5 — setLaunchSpeed() ─────────────────────────────
describe('ArmUnit V5 — setLaunchSpeed()', () => {

  it('setting speed within tier limits works', () => {
    const arm = makeArm();
    arm.setLaunchSpeed(5);
    assert.equal(arm.launchSpeed, 5);
  });

  it('speed clamped to tier max', () => {
    const arm = makeArm();
    // T1 (Steel T1) maxSpeed = 7.1
    arm.setLaunchSpeed(100);
    assert.equal(arm.launchSpeed, SPRING_TIERS[0].maxSpeed);
  });

  it('speed clamped to min', () => {
    const arm = makeArm();
    arm.setLaunchSpeed(0.1);
    assert.equal(arm.launchSpeed, CROSSBOW_LAUNCH_SPEED_MIN);
  });
});

// ── Suite 10: ArmUnit V5 — Spring Tier Upgrades ────────────────────────
describe('ArmUnit V5 — Spring Tier Upgrades', () => {

  it('setSpringTier(0) sets tier to 0', () => {
    const arm = makeArm();
    arm.setSpringTier(0);
    assert.equal(arm.springTier, 0);
  });

  it('setSpringTier(4) sets tier to 4 (T5)', () => {
    const arm = makeArm();
    arm.setSpringTier(4);
    assert.equal(arm.springTier, 4);
  });

  it('setSpringTier(99) clamped to max (4)', () => {
    const arm = makeArm();
    arm.setSpringTier(99);
    assert.equal(arm.springTier, 4);
  });

  it('setSpringTier(-1) clamped to min (0)', () => {
    const arm = makeArm();
    arm.setSpringTier(-1);
    assert.equal(arm.springTier, 0);
  });

  it('downgrading tier clamps launchSpeed to new max', () => {
    const arm = makeArm();
    // Upgrade to T5 (maxSpeed 25.0) and set speed high
    arm.setSpringTier(4);
    arm.setLaunchSpeed(15);
    assert.equal(arm.launchSpeed, 15);
    // Now downgrade to T1 (maxSpeed 7.1) — speed should clamp
    arm.setSpringTier(0);
    assert.ok(arm.launchSpeed <= SPRING_TIERS[0].maxSpeed,
      `launchSpeed (${arm.launchSpeed}) should be <= T1 maxSpeed (${SPRING_TIERS[0].maxSpeed})`);
  });
});

// ── Suite 11: ArmUnit V5 — Tether Tier Upgrades ────────────────────────
describe('ArmUnit V5 — Tether Tier Upgrades', () => {

  it('setTetherTier(0) sets breakStrength to T1 value', () => {
    const arm = makeArm();
    arm.setTetherTier(0);
    assert.equal(arm.tetherBreakStrength, TETHER_TIERS[0].breakStrength);
  });

  it('setTetherTier(4) sets breakStrength to 800', () => {
    const arm = makeArm();
    arm.setTetherTier(4);
    assert.equal(arm.tetherBreakStrength, 800);
  });

  it('setTetherTier(4) sets maxLength to 10000', () => {
    const arm = makeArm();
    arm.setTetherTier(4);
    assert.equal(arm.tetherMaxLength, 10000);
  });
});

// ── Suite 12: ArmUnit V5 — Deploy Requires Spring Charge ───────────────
describe('ArmUnit V5 — Deploy Requires Spring Charge', () => {

  it('charged arm deploys successfully → LAUNCHING', () => {
    const arm = makeArm();
    arm.springCharged = true;
    const result = arm.deploy(makeTarget());
    assert.ok(result !== false, 'deploy should not return false');
    assert.equal(arm.state, ARM_STATES.LAUNCHING);
  });

  it('uncharged arm fails to deploy → stays DOCKED', () => {
    const arm = makeArm();
    arm.springCharged = false;
    arm.deploy(makeTarget());
    assert.equal(arm.state, ARM_STATES.DOCKED);
  });
});

// ── Suite 13: ArmUnit V5 — State Transitions: Deploy → LAUNCHING ──────
describe('ArmUnit V5 — State Transitions: Deploy → LAUNCHING', () => {

  it('deploy(target) transitions to LAUNCHING', () => {
    const arm = makeArm();
    arm.deploy(makeTarget());
    assert.equal(arm.state, ARM_STATES.LAUNCHING);
  });

  it('deployFreefly() transitions to LAUNCHING', () => {
    const arm = makeArm();
    arm.springCharged = true;
    arm.deployFreefly();
    assert.equal(arm.state, ARM_STATES.LAUNCHING);
  });
});

// ── Suite 14: ArmUnit V5 — CROSSBOW_FIRE Event Emission ───────────────
describe('ArmUnit V5 — CROSSBOW_FIRE Event Emission', () => {

  it('CROSSBOW_FIRE emitted during launch sequence with correct fields', () => {
    const arm = makeArm();
    arm.index = 3;
    let received = null;
    eventBus.on(Events.CROSSBOW_FIRE, (data) => { received = data; });

    arm.deploy(makeTarget());
    assert.equal(arm.state, ARM_STATES.LAUNCHING);

    // Simulate update with dt > CROSSBOW_UNDOCK_TIME to trigger spring fire
    const parentPos = new THREE.Vector3(0, 0, 0);
    arm.update(CROSSBOW_UNDOCK_TIME + 0.01, parentPos);

    assert.ok(received !== null, 'CROSSBOW_FIRE event should have been emitted');
    assert.equal(received.armIndex, 3, 'armIndex should match');
    assert.isType(received.speed, 'number', 'speed should be a number');
    assert.ok(received.speed > 0, `speed should be > 0, got ${received.speed}`);
    eventBus.clear();
  });
});

// ── Suite 15: ArmUnit V5 — startAblation() ─────────────────────────────
describe('ArmUnit V5 — startAblation()', () => {

  it('from DOCKED: should fail (wrong state)', () => {
    const arm = makeArm();
    const result = arm.startAblation({ id: 'target-1' });
    assert.equal(result, false);
    assert.equal(arm.state, ARM_STATES.DOCKED);
  });

  it('from TRANSIT: should succeed → ABLATING', () => {
    const arm = makeArm();
    // Manually set state to TRANSIT for testing
    arm.state = ARM_STATES.TRANSIT;
    const result = arm.startAblation({ id: 'target-1' });
    assert.equal(result, true);
    assert.equal(arm.state, ARM_STATES.ABLATING);
  });

  it('emits ABLATION_START event', () => {
    const arm = makeArm();
    arm.index = 2;
    arm.state = ARM_STATES.TRANSIT;
    let received = null;
    eventBus.on(Events.ABLATION_START, (data) => { received = data; });
    arm.startAblation({ id: 'debris-99' });
    assert.ok(received !== null, 'ABLATION_START event should fire');
    assert.equal(received.armIndex, 2);
    assert.equal(received.targetId, 'debris-99');
    eventBus.clear();
  });
});

// ── Suite 16: ArmUnit V5 — enterTangle() ───────────────────────────────
describe('ArmUnit V5 — enterTangle()', () => {

  it('transitions to TANGLED state', () => {
    const arm = makeArm();
    arm.enterTangle({ index: 1 });
    assert.equal(arm.state, ARM_STATES.TANGLED);
  });

  it('sets tanglePartner', () => {
    const arm = makeArm();
    arm.enterTangle({ index: 1 });
    assert.equal(arm.tanglePartner.index, 1);
  });

  it('emits TETHER_TANGLE event', () => {
    const arm = makeArm();
    arm.index = 0;
    let received = null;
    eventBus.on(Events.TETHER_TANGLE, (data) => { received = data; });
    arm.enterTangle({ index: 1 });
    assert.ok(received !== null, 'TETHER_TANGLE event should fire');
    assert.ok(Array.isArray(received.armIndices), 'armIndices should be array');
    assert.equal(received.armIndices.length, 2);
    eventBus.clear();
  });
});

// ── Suite 17: ArmUnit V5 — startScan() ─────────────────────────────────
describe('ArmUnit V5 — startScan()', () => {

  it('from DOCKED: succeeds → SCANNING', () => {
    const arm = makeArm();
    const result = arm.startScan();
    assert.equal(result, true);
    assert.equal(arm.state, ARM_STATES.SCANNING);
  });

  it('from TRANSIT: fails (wrong state)', () => {
    const arm = makeArm();
    arm.state = ARM_STATES.TRANSIT;
    const result = arm.startScan();
    assert.equal(result, false);
    assert.equal(arm.state, ARM_STATES.TRANSIT);
  });
});

// ── Suite 18: ArmUnit V5 — getStatus() includes V5 fields ─────────────
describe('ArmUnit V5 — getStatus() includes V5 fields', () => {
  const arm = makeArm();
  const status = arm.getStatus();

  it('status has springCharged', () => {
    assert.ok('springCharged' in status, 'springCharged should be in status');
  });

  it('status has reloadProgress', () => {
    assert.ok('reloadProgress' in status, 'reloadProgress should be in status');
  });

  it('status has tetherTension', () => {
    assert.ok('tetherTension' in status, 'tetherTension should be in status');
  });

  it('status has launchSpeed', () => {
    assert.ok('launchSpeed' in status, 'launchSpeed should be in status');
  });

  it('status has springTier', () => {
    assert.ok('springTier' in status, 'springTier should be in status');
  });

  it('status has tetherTier', () => {
    assert.ok('tetherTier' in status, 'tetherTier should be in status');
  });
});

// ── Suite 19: ArmUnit V5 — reset() preserves tiers ────────────────────
describe('ArmUnit V5 — reset() preserves tiers', () => {

  it('springTier preserved after reset', () => {
    const arm = makeArm();
    arm.setSpringTier(3);
    arm.setTetherTier(2);
    arm.reset();
    assert.equal(arm.springTier, 3);
  });

  it('tetherTier preserved after reset', () => {
    const arm = makeArm();
    arm.setSpringTier(3);
    arm.setTetherTier(2);
    arm.reset();
    assert.equal(arm.tetherTier, 2);
  });

  it('springCharged reset to true', () => {
    const arm = makeArm();
    arm.springCharged = false;
    arm.reset();
    assert.equal(arm.springCharged, true);
  });

  it('reloadProgress reset to 0', () => {
    const arm = makeArm();
    arm.reloadProgress = 0.75;
    arm.reset();
    assert.equal(arm.reloadProgress, 0);
  });
});

// ── Suite 20: ArmUnit V6 — detach() from valid state ──────────────────
describe('ArmUnit V6 — detach() from valid state (TRANSIT)', () => {

  it('detach() from TRANSIT returns true', () => {
    const arm = makeArm();
    arm.state = ARM_STATES.TRANSIT;
    const result = arm.detach();
    assert.equal(result, true);
  });

  it('isDetached is true after detach()', () => {
    const arm = makeArm();
    arm.state = ARM_STATES.TRANSIT;
    arm.detach();
    assert.equal(arm.isDetached, true);
  });

  it('ARM_DETACHED event emitted with correct fields', () => {
    const arm = makeArm();
    arm.index = 2;
    arm.state = ARM_STATES.TRANSIT;
    let received = null;
    eventBus.on(Events.ARM_DETACHED, (data) => { received = data; });
    arm.detach();
    assert.ok(received !== null, 'ARM_DETACHED event should fire');
    assert.equal(received.armId, 2);
    assert.isType(received.fuelRemaining, 'number');
    assert.equal(received.wasTangled, false);
    eventBus.clear();
  });
});

// ── Suite 21: ArmUnit V6 — detach() from invalid state (DOCKED) ───────
describe('ArmUnit V6 — detach() from invalid state (DOCKED)', () => {

  it('detach() from DOCKED returns false', () => {
    const arm = makeArm();
    assert.equal(arm.state, ARM_STATES.DOCKED);
    const result = arm.detach();
    assert.equal(result, false);
  });

  it('isDetached remains false after failed detach()', () => {
    const arm = makeArm();
    arm.detach();
    assert.equal(arm.isDetached, false);
  });

  it('no ARM_DETACHED event emitted on failure', () => {
    const arm = makeArm();
    let received = null;
    eventBus.on(Events.ARM_DETACHED, (data) => { received = data; });
    arm.detach();
    assert.equal(received, null, 'ARM_DETACHED should NOT fire from DOCKED');
    eventBus.clear();
  });
});

// ── Suite 22: ArmUnit V6 — detach() from TANGLED state ────────────────
describe('ArmUnit V6 — detach() from TANGLED state', () => {

  it('detach() from TANGLED returns true', () => {
    const arm = makeArm();
    arm.enterTangle({ index: 1 });
    assert.equal(arm.state, ARM_STATES.TANGLED);
    const result = arm.detach();
    assert.equal(result, true);
  });

  it('ARM_DETACHED event has wasTangled=true', () => {
    const arm = makeArm();
    arm.index = 4;
    arm.enterTangle({ index: 1 });
    let received = null;
    eventBus.on(Events.ARM_DETACHED, (data) => { received = data; });
    arm.detach();
    assert.ok(received !== null, 'ARM_DETACHED event should fire');
    assert.equal(received.wasTangled, true, 'wasTangled should be true');
    eventBus.clear();
  });
});

// ── Suite 24: ArmUnit V6 — _worldDockDirection() parent-rotation fix ──
// Regression tests for the HANDOFF §4.6 "arms fire inward when ship rotated
// 180°" bug. _worldDockDirection(parentQuat) must rotate the LOCAL dockOffset
// by the parent ship's world quaternion so arms always deploy OUTWARD.
describe('ArmUnit V6 — _worldDockDirection() parent-rotation fix', () => {

  /** Floating-point vector comparison helper (per-component tolerance) */
  function assertVecClose(actual, expected, eps = 1e-6, msg = '') {
    assert.ok(Math.abs(actual.x - expected.x) < eps,
      `${msg} x: ${actual.x} ≉ ${expected.x}`);
    assert.ok(Math.abs(actual.y - expected.y) < eps,
      `${msg} y: ${actual.y} ≉ ${expected.y}`);
    assert.ok(Math.abs(actual.z - expected.z) < eps,
      `${msg} z: ${actual.z} ≉ ${expected.z}`);
  }

  it('identity quaternion → world dir equals normalized local dockOffset', () => {
    // dockOffset = (+M, 0, 0) → outward along +X in both local and world frames
    const arm = makeArm();
    const q = new THREE.Quaternion(); // identity
    const dir = arm._worldDockDirection(q);
    assertVecClose(dir, new THREE.Vector3(1, 0, 0), 1e-6, 'identity');
    // Vector should be unit length
    assert.ok(Math.abs(dir.length() - 1) < 1e-6, 'unit length');
  });

  it('null quaternion → falls back to normalized local dockOffset', () => {
    const arm = makeArm();
    const dir = arm._worldDockDirection(null);
    assertVecClose(dir, new THREE.Vector3(1, 0, 0), 1e-6, 'null parentQuat');
  });

  it('90° yaw about +Y → +X local rotates to -Z world', () => {
    // Rotating +X by 90° about +Y (right-hand rule) yields -Z
    const arm = makeArm();
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), Math.PI / 2,
    );
    const dir = arm._worldDockDirection(q);
    assertVecClose(dir, new THREE.Vector3(0, 0, -1), 1e-6, '90° yaw');
  });

  it('180° yaw about +Y → +X local rotates to -X world (bug case)', () => {
    // This is the bug scenario from HANDOFF §4.6: without the fix, the arm
    // would still launch toward +X in world (back into the ship). With the
    // fix, it launches toward -X (truly outward from the rotated hull).
    const arm = makeArm();
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), Math.PI,
    );
    const dir = arm._worldDockDirection(q);
    assertVecClose(dir, new THREE.Vector3(-1, 0, 0), 1e-6, '180° yaw');
  });

  it('180° roll about +Z → +X local stays at +X, +Y would flip (sanity)', () => {
    // +X rotated 180° about +Z = -X. Confirms rotation axis matters.
    const arm = makeArm();
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1), Math.PI,
    );
    const dir = arm._worldDockDirection(q);
    assertVecClose(dir, new THREE.Vector3(-1, 0, 0), 1e-6, '180° roll');
  });

  it('_updateDocked caches parentQuat into _lastParentQuat', () => {
    const arm = makeArm();
    // Initial state: cache empty
    assert.equal(arm._lastParentQuat, null);
    const parentPos = new THREE.Vector3(0, 0, 0);
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), Math.PI,
    );
    arm._updateDocked(0.016, parentPos, q);
    assert.ok(arm._lastParentQuat !== null, 'cache populated');
    assert.ok(Math.abs(arm._lastParentQuat.w - q.w) < 1e-6, 'w matches');
    assert.ok(Math.abs(arm._lastParentQuat.y - q.y) < 1e-6, 'y matches');
  });

  it('_updateDocked with null parentQuat caches null', () => {
    const arm = makeArm();
    // Prime with non-null first
    arm._lastParentQuat = new THREE.Quaternion();
    const parentPos = new THREE.Vector3(0, 0, 0);
    arm._updateDocked(0.016, parentPos, null);
    assert.equal(arm._lastParentQuat, null, 'null passthrough');
  });

  it('deployFreefly() uses world dock direction when parent rotated 180°', () => {
    // Regression for §4.6: launchDirection must NOT equal raw local dockOffset
    // after parent rotates 180°.
    const arm = makeArm();
    const parentPos = new THREE.Vector3(0, 0, 0);
    const q180 = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), Math.PI,
    );
    // Simulate one DOCKED frame so _lastParentQuat is cached
    arm._updateDocked(0.016, parentPos, q180);

    const ok = arm.deployFreefly();
    assert.equal(ok, true, 'deploy succeeds');
    // Local dockOffset was (+M, 0, 0). After 180° yaw, world dir = (-1, 0, 0).
    assertVecClose(arm.launchDirection, new THREE.Vector3(-1, 0, 0), 1e-6,
      'launchDirection after 180°');
  });

  it('deployFreefly() uses world dock direction when parent at identity', () => {
    const arm = makeArm();
    const parentPos = new THREE.Vector3(0, 0, 0);
    arm._updateDocked(0.016, parentPos, new THREE.Quaternion());

    const ok = arm.deployFreefly();
    assert.equal(ok, true, 'deploy succeeds');
    assertVecClose(arm.launchDirection, new THREE.Vector3(1, 0, 0), 1e-6,
      'launchDirection at identity');
  });
});

// ── Suite 23: ArmUnit V6 — detached arm fuel depletion → ARM_LOST ─────
describe('ArmUnit V6 — detached arm fuel depletion', () => {

  it('ARM_LOST emitted when detached arm fuel reaches 0', () => {
    const arm = makeArm();
    arm.state = ARM_STATES.TRANSIT;
    arm.detach();
    eventBus.clear();

    // Set fuel very low — TRANSIT burns 1.5%/sec, so dt=1.0 drains 1.5%
    arm.fuel = 0.5;
    let lostEvent = null;
    eventBus.on(Events.ARM_LOST, (data) => { lostEvent = data; });

    // Update will call _consumeFuel → fuel goes to 0 → ARM_LOST emitted
    const parentPos = new THREE.Vector3(0, 0, 0);
    arm.update(1.0, parentPos);

    assert.ok(lostEvent !== null, 'ARM_LOST event should fire on fuel depletion');
    assert.equal(lostEvent.armId, arm.id, 'armId should match');
    assert.equal(arm.fuel, 0, 'fuel should be 0');
    eventBus.clear();
  });
});

// ── Suite 24: ArmUnit — Orbital Frame Correction ──────────────────────
describe('ArmUnit — Orbital Frame Correction', () => {

  it('frame correction applied during LAUNCHING', () => {
    const arm = makeArm();
    // Put arm in LAUNCHING state with a launch direction so _updateLaunching doesn't crash
    arm.state = ARM_STATES.LAUNCHING;
    arm.launchDirection = new THREE.Vector3(1, 0, 0).normalize();
    arm.springCharged = false; // already fired
    arm.position.set(0.001, 0, 0);
    arm.velocity.set(0, 0, 0);

    // Set _prevParentPos to origin — ship was at (0,0,0) last frame
    arm._prevParentPos = new THREE.Vector3(0, 0, 0);

    // Ship moved +X by 0.1 scene units (= 10 km) this frame
    const parentPos = new THREE.Vector3(0.1, 0, 0);
    const startX = arm.position.x;
    arm.update(0.016, parentPos);

    // Arm position should have shifted by at least the parent delta (0.1)
    // (may also include velocity integration, so check >= delta)
    const delta = arm.position.x - startX;
    assert.ok(delta >= 0.09, `arm should shift by parent delta; got delta=${delta.toFixed(6)}`);
  });

  it('frame correction applied during TRANSIT', () => {
    const arm = makeArm();
    arm.state = ARM_STATES.TRANSIT;
    arm.target = makeTarget('debris-transit', 5);
    arm.position.set(0.001, 0, 0);
    arm.velocity.set(0, 0, 0);

    arm._prevParentPos = new THREE.Vector3(0, 0, 0);
    const parentPos = new THREE.Vector3(0, 0.05, 0);
    const startY = arm.position.y;
    arm.update(0.016, parentPos);

    const delta = arm.position.y - startY;
    assert.ok(delta >= 0.04, `TRANSIT arm should shift by parent Y delta; got delta=${delta.toFixed(6)}`);
  });

  it('frame correction NOT applied during DOCKED', () => {
    const arm = makeArm();
    arm.state = ARM_STATES.DOCKED;
    arm._prevParentPos = new THREE.Vector3(0, 0, 0);

    // Parent at a known position — DOCKED sets arm to parentPos + dockOffset
    const parentPos = new THREE.Vector3(1, 0, 0);
    arm.update(0.016, parentPos, new THREE.Quaternion());

    // DOCKED arm should be exactly at parentPos + dockOffset (no frame delta added)
    const expectedX = parentPos.x + arm.dockOffset.x;
    assert.ok(Math.abs(arm.position.x - expectedX) < 1e-8,
      `DOCKED arm should be at dock pos (${expectedX}), got ${arm.position.x}`);
  });

  it('first frame after deploy — no _prevParentPos — no crash, sets _prevParentPos', () => {
    const arm = makeArm();
    arm.state = ARM_STATES.LAUNCHING;
    arm.launchDirection = new THREE.Vector3(1, 0, 0).normalize();
    arm.springCharged = false;
    arm.position.set(0.001, 0, 0);
    arm.velocity.set(0.0001, 0, 0);
    arm._prevParentPos = null; // First frame — no previous

    const parentPos = new THREE.Vector3(0, 0, 0);
    // Should not throw or produce NaN
    arm.update(0.016, parentPos);

    assert.ok(!isNaN(arm.position.x), 'position.x should not be NaN');
    assert.ok(!isNaN(arm.position.y), 'position.y should not be NaN');
    assert.ok(!isNaN(arm.position.z), 'position.z should not be NaN');
    assert.ok(arm._prevParentPos !== null, '_prevParentPos should be set after first frame');
    assert.ok(Math.abs(arm._prevParentPos.x - parentPos.x) < 1e-10,
      '_prevParentPos should equal parentPos');
  });

  it('multiple frames accumulate parent motion correctly', () => {
    const arm = makeArm();
    arm.state = ARM_STATES.TRANSIT;
    arm.target = makeTarget('debris-accum', 5);
    arm.position.set(0.005, 0, 0);
    arm.velocity.set(0, 0, 0); // Zero own velocity to isolate frame correction
    arm._manualMode = true;    // Bypass autopilot drift correction — test frame correction only
    arm._prevParentPos = new THREE.Vector3(0, 0, 0);

    const startX = arm.position.x;
    const step = 0.01; // parent moves 0.01 per frame in X

    // Frame 1: parent moves to (0.01, 0, 0)
    arm.update(0.016, new THREE.Vector3(step * 1, 0, 0));
    // Frame 2: parent moves to (0.02, 0, 0)
    arm.update(0.016, new THREE.Vector3(step * 2, 0, 0));
    // Frame 3: parent moves to (0.03, 0, 0)
    arm.update(0.016, new THREE.Vector3(step * 3, 0, 0));

    // Total parent displacement = 0.03
    // Arm should have accumulated at least 0.03 of parent motion
    const totalDelta = arm.position.x - startX;
    assert.ok(totalDelta >= 0.029,
      `3 frames of parent motion (0.03 total) should accumulate; got delta=${totalDelta.toFixed(6)}`);
  });

  it('frame correction applied during RELOADING (arm stays near dock)', () => {
    const arm = makeArm();
    // Simulate arm at dock position entering RELOADING
    arm.state = ARM_STATES.RELOADING;
    arm.reloadDuration = 2.0; // 2 second reload
    arm.reloadProgress = 0;
    arm.position.set(1.0, 0, 0); // at parent dock area
    arm._prevParentPos = new THREE.Vector3(1.0, 0, 0);

    // Ship moves +X by 0.05 (orbital motion)
    const parentPos = new THREE.Vector3(1.05, 0, 0);
    arm.update(0.016, parentPos);

    // Arm should have shifted by the parent delta (0.05)
    assert.ok(Math.abs(arm.position.x - 1.05) < 0.01,
      `RELOADING arm should co-orbit with ship; got x=${arm.position.x.toFixed(6)}`);
  });

  it('_prevParentPos cleared by reset()', () => {
    const arm = makeArm();
    arm._prevParentPos = new THREE.Vector3(1, 2, 3);
    arm.reset();
    assert.equal(arm._prevParentPos, null, '_prevParentPos should be null after reset');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2026-05-26 ISSUE 1 FIX — Daughter docks at STRUT TIP (not mother centre).
// ════════════════════════════════════════════════════════════════════════
//
// Before this fix, _updateReeling pulled the daughter to `parentPos`
// (mother core), then _updateDocking lerped the last few metres over to
// the strut tip. The user saw the daughter slide INTO the bus, then back
// out to the strut. Fix: REELING target is now the strut-tip world pos
// (parentPos + parentQuat × dockOffset), matching DOCKING.
// ════════════════════════════════════════════════════════════════════════

describe('ArmUnit V5 — REELING docks at strut-tip (Issue 1 fix, 2026-05-26)', () => {
  it('REELING target is parentPos + parentQuat × dockOffset, not parentPos', () => {
    const arm = makeArm();
    // Distinctive dockOffset so we can verify the target — 1 m along local +X.
    arm.dockOffset = new THREE.Vector3(M, 0, 0);
    arm.state = ARM_STATES.REELING;
    arm.capturedDebris = null;

    // Identity quaternion → world dock position = parentPos + (M, 0, 0).
    const parentPos = new THREE.Vector3(0, 0, 0);
    const parentQuat = new THREE.Quaternion(); // identity

    // Start the arm 10 m offset along +Y. With parentPos at origin and
    // dockOffset = (M, 0, 0), the strut-tip world pos is (M, 0, 0).
    // Mother centre is (0, 0, 0). These are distinguishable along the
    // displacement-to-arm vector — arm should move toward (M, 0, 0), not (0, 0, 0).
    arm.position.set(0, 10 * M, 0);
    arm._prevParentPos = parentPos.clone();

    // Run a single frame
    arm.update(0.016, parentPos, parentQuat);

    // Direction of motion: subtract starting position. With the fix, the
    // arm should move along (toward (M, 0, 0)) — has both an X component
    // (toward dock) AND a -Y component (closing the gap).
    // OLD (buggy) behaviour: motion vector pointed exactly along -Y (toward
    // mother centre) with no X component.
    const startPos = new THREE.Vector3(0, 10 * M, 0);
    const moveVec = arm.position.clone().sub(startPos);
    assert.ok(moveVec.x > 0,
      `REELING must move toward strut-tip dock (dockOffset=(M,0,0)). ` +
      `Expected positive X motion; got moveVec.x=${moveVec.x}. ` +
      `If this is 0, the daughter is still aiming at mother centre.`);
  });

  it('REELING snaps to dockWorldPos (not parentPos) at the final step', () => {
    const arm = makeArm();
    arm.dockOffset = new THREE.Vector3(M, 0, 0);
    arm.state = ARM_STATES.REELING;
    arm.capturedDebris = null;
    arm._dbgReelLogged = true; // suppress one-shot debug warn

    const parentPos = new THREE.Vector3(0, 0, 0);
    const parentQuat = new THREE.Quaternion(); // identity

    // Position arm at 0.5 m from the strut-tip dock (well above the 1e-7
    // zero-vector guard at line 3535 AND well within one frame's reel
    // step for dt=100, so the snap path fires deterministically regardless
    // of REEL_IN_SPEED_EMPTY's tuned value).
    arm.position.set(M + 0.5 * M, 0, 0); // 1.5 m from origin, 0.5 m from dock
    arm._prevParentPos = parentPos.clone();

    // Big dt to guarantee moveDistance >= dist for any reasonable reelSpeed.
    arm.update(100.0, parentPos, parentQuat);

    // After snap, arm.position must equal dockWorldPos = (M, 0, 0) exactly
    // (within float epsilon), NOT parentPos = (0, 0, 0). The OLD code did
    // `this.position.copy(parentPos)`; new code does `this.position.copy(dockWorldPos)`.
    const dockTarget = new THREE.Vector3(M, 0, 0);
    const distToDock   = arm.position.distanceTo(dockTarget);
    const distToMother = arm.position.distanceTo(parentPos);
    // Snap must land at dock (within tight tolerance — set by copy, no lerp).
    assert.ok(distToDock < 1e-12,
      `After REELING snap, arm.position must equal dockWorldPos (M,0,0). ` +
      `Got position=(${arm.position.x}, ${arm.position.y}, ${arm.position.z}), ` +
      `distToDock=${distToDock}. If this fails, the snap target is not the strut tip.`);
    // And explicitly, must be FAR from parentPos (the buggy target).
    assert.ok(distToMother > 0.9 * M,
      `After REELING snap, arm.position must NOT be near mother centre (0,0,0). ` +
      `Got distToMother=${distToMother}. If this fails, the snap is still landing at parentPos (the bug).`);
    // And state must have advanced to DOCKING.
    assert.equal(arm.state, ARM_STATES.DOCKING, 'REELING snap transitions to DOCKING');
  });
});
