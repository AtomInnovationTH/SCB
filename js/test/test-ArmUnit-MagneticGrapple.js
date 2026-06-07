/**
 * test-ArmUnit-MagneticGrapple.js — EPM magnetic grapple sub-FSM (CP-1 / P2).
 *
 * Drives a daughter from STATION_KEEP through the magnetic-grapple sub-FSM
 * (ENERGIZING → CLOSING → GRIP) and asserts:
 *   • ferrous target → grip acquired → GRAPPLED, catch pinned, MAGNET tagged;
 *   • non-ferrous target → MAGNETIC_GRIP_FAILED('non_ferrous') → RETURNING;
 *   • > 500 kg target → MAGNETIC_GRIP_FAILED('too_heavy');
 *   • entry emits AUTOPILOT_TARGET_LOCK so collision-avoidance exempts the target;
 *   • a magnet catch SKIPS the net-integrity (oversize) check on reel-in.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

const S = Constants.ARM_STATES;
const M = 0.00001;

function makeArm(type = 'weaver') {
  const scene = { add: () => {}, remove: () => {} };
  const arm = new ArmUnit(`${type}-1`, type, new THREE.Vector3(M, 0, 0), scene);
  arm.index = 0;
  arm.isDetached = false;
  arm.tetherLength = 50;
  return arm;
}

function makeTarget({ id = 42, mass = 300, sizeMeter = 6, ferro = false, fasten = false } = {}) {
  return {
    id, mass, sizeMeter, type: 'rocketBody',
    ferromagnetic: ferro, hasFerrousFasteners: fasten,
    alive: true, _captured: false, _capturedByArm: null,
    _armPinned: false, _armPinPos: null,
    _scenePosition: new THREE.Vector3(0, 0, 0),
  };
}

/** Park a target in STATION_KEEP for the arm at the target's scene position. */
function enterSK(arm, target) {
  arm.state = S.STATION_KEEP;
  arm.target = target;
  arm._stationKeepTarget = target;
  arm.position.copy(target._scenePosition);  // already at contact range
}

/** Run the sub-FSM long enough to pass ENERGIZING + CLOSING + GRIP. */
function driveGrapple(arm) {
  arm._updateMagneticGrapple(0.35);  // ENERGIZING → CLOSING
  arm._updateMagneticGrapple(0.05);  // CLOSING (in contact) → GRIP
  arm._updateMagneticGrapple(0.45);  // GRIP dwell → resolve
}

function capture(evts, fn) {
  const got = {};
  const handlers = {};
  for (const e of evts) { got[e] = []; handlers[e] = (d) => got[e].push(d); eventBus.on(e, handlers[e]); }
  try { fn(); } finally { for (const e of evts) eventBus.off(e, handlers[e]); }
  return got;
}

describe('ArmUnit magnetic grapple — entry', () => {
  it('STATION_KEEP + MAGNET → MAGNETIC_GRAPPLE, emits lock + attempt', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const target = makeTarget({ ferro: true, fasten: true });
    enterSK(arm, target);
    arm.selectedTool = 'MAGNET';

    const got = capture(
      [Events.AUTOPILOT_TARGET_LOCK, Events.MAGNETIC_GRIP_ATTEMPT],
      () => assert.equal(arm.dispatchSelectedTool(), true, 'dispatch returns true'),
    );

    assert.equal(arm.state, S.MAGNETIC_GRAPPLE, 'entered the grapple state');
    assert.equal(arm._captureToolKind, 'MAGNET', 'capture verb tagged MAGNET');
    assert.equal(got[Events.AUTOPILOT_TARGET_LOCK].length, 1, 'CA exemption lock emitted');
    assert.equal(got[Events.AUTOPILOT_TARGET_LOCK][0].debrisId, target.id);
    assert.equal(got[Events.MAGNETIC_GRIP_ATTEMPT].length, 1, 'attempt announced');
  });

  it('refuses to grapple outside STATION_KEEP', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    arm.state = S.TRANSIT;
    assert.equal(arm.magneticGrapple(), false);
  });
});

describe('ArmUnit magnetic grapple — resolution', () => {
  it('ferrous target → grip acquired → GRAPPLED with the catch pinned', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const target = makeTarget({ ferro: true, mass: 300 });
    enterSK(arm, target);
    arm.magneticGrapple();
    arm._magRollOverride = 0;  // deterministic success

    const got = capture([Events.MAGNETIC_GRIP_ACQUIRED, Events.ARM_CAPTURED], () => driveGrapple(arm));

    assert.equal(arm.state, S.GRAPPLED, 'success routes into the shared GRAPPLED→REELING path');
    assert.equal(arm.capturedDebris, target, 'catch is held');
    assert.equal(target._armPinned, true, 'catch pinned to the arm');
    assert.equal(arm._captureToolKind, 'MAGNET');
    assert.equal(got[Events.MAGNETIC_GRIP_ACQUIRED].length, 1);
    assert.equal(got[Events.ARM_CAPTURED].length, 1, 'ARM_CAPTURED fires for scoring/lifecycle');
    assert.equal(got[Events.ARM_CAPTURED][0].tool, 'MAGNET');
  });

  it('non-ferrous target → MAGNETIC_GRIP_FAILED(non_ferrous) → RETURNING', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const target = makeTarget({ ferro: false, fasten: false, mass: 200 });
    enterSK(arm, target);
    arm.magneticGrapple();
    arm._magRollOverride = 0.99;  // force the residual-flux roll to miss

    const got = capture([Events.MAGNETIC_GRIP_FAILED], () => driveGrapple(arm));

    assert.equal(arm.state, S.RETURNING, 'no purchase → daughter returns to reload');
    assert.equal(arm.capturedDebris, null, 'nothing captured');
    assert.equal(got[Events.MAGNETIC_GRIP_FAILED].length, 1);
    assert.equal(got[Events.MAGNETIC_GRIP_FAILED][0].reason, 'non_ferrous');
  });

  it('> 500 kg target → MAGNETIC_GRIP_FAILED(too_heavy)', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const target = makeTarget({ ferro: true, mass: 1200 });
    enterSK(arm, target);
    arm.magneticGrapple();
    arm._magRollOverride = 0;  // would succeed if mass allowed

    const got = capture([Events.MAGNETIC_GRIP_FAILED], () => driveGrapple(arm));

    assert.equal(got[Events.MAGNETIC_GRIP_FAILED].length, 1);
    assert.equal(got[Events.MAGNETIC_GRIP_FAILED][0].reason, 'too_heavy');
    assert.equal(arm.state, S.RETURNING);
  });
});

describe('ArmUnit magnetic grapple — CA lock lifecycle', () => {
  it('success releases the CA target lock exactly once (via state exit)', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const target = makeTarget({ ferro: true, mass: 300 });
    enterSK(arm, target);
    arm.magneticGrapple();
    arm._magRollOverride = 0;
    const got = capture([Events.AUTOPILOT_TARGET_UNLOCK], () => driveGrapple(arm));
    assert.equal(arm.state, S.GRAPPLED);
    assert.equal(got[Events.AUTOPILOT_TARGET_UNLOCK].length, 1, 'one unlock on success');
    assert.equal(got[Events.AUTOPILOT_TARGET_UNLOCK][0].debrisId, target.id);
    assert.equal(arm._toolLockedDebrisId, null, 'locked-id cleared');
  });

  it('an external recall mid-grapple still releases the CA lock (no leak)', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const target = makeTarget({ ferro: true, mass: 300 });
    enterSK(arm, target);
    arm.magneticGrapple();              // lock emitted, _toolLockedDebrisId set
    assert.equal(arm._toolLockedDebrisId, target.id, 'lock recorded on entry');

    const got = capture([Events.AUTOPILOT_TARGET_UNLOCK], () => arm.recall());
    assert.equal(got[Events.AUTOPILOT_TARGET_UNLOCK].length, 1,
      'recall out of MAGNETIC_GRAPPLE releases the CA exemption');
    assert.equal(got[Events.AUTOPILOT_TARGET_UNLOCK][0].debrisId, target.id);
    assert.equal(arm._toolLockedDebrisId, null, 'locked-id cleared on exit');
  });

  it('failure releases the CA target lock exactly once', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const target = makeTarget({ ferro: false, fasten: false, mass: 200 });
    enterSK(arm, target);
    arm.magneticGrapple();
    arm._magRollOverride = 0.99;
    const got = capture([Events.AUTOPILOT_TARGET_UNLOCK], () => driveGrapple(arm));
    assert.equal(arm.state, S.RETURNING);
    assert.equal(got[Events.AUTOPILOT_TARGET_UNLOCK].length, 1, 'one unlock on failure');
    assert.equal(arm._toolLockedDebrisId, null, 'locked-id cleared');
  });
});

describe('ArmUnit magnetic grapple — net-integrity guard', () => {
  it('a MAGNET catch skips the net oversize check on reel start', () => {
    const arm = makeArm('weaver');
    // A wide catch that WOULD trip the net oversize rule if it were a net catch.
    arm._captureToolKind = 'MAGNET';
    arm._netDiameter = 5;
    arm.capturedDebris = { id: 7, mass: 100, sizeMeter: 9 };  // 9 m > 5 m net mouth
    assert.equal(arm._checkNetIntegrityOnReel(), false,
      'magnet grip has no net mouth — integrity check must not fail it');
  });
});
