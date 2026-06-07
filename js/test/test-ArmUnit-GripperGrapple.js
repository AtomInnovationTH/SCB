/**
 * test-ArmUnit-GripperGrapple.js — 3-jaw gripper sub-FSM (CP-1 / P3).
 *
 * Drives a Weaver from STATION_KEEP through EXTEND → SEEK → CLOSE → latch roll:
 *   • fixtured target → GRIPPER_LATCHED → GRAPPLED (catch pinned, tagged GRIPPER);
 *   • unfixtured target → GRIPPER_SLIPPED(no_fixture) → RETURNING;
 *   • > 2000 kg → GRIPPER_SLIPPED(oversize);
 *   • the CA target lock is released on any exit (incl. recall).
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

function makeTarget({ id = 51, mass = 120, fixture = true, type = 'defunctSat' } = {}) {
  return {
    id, mass, sizeMeter: 4, type,
    hasGrappleFixture: fixture, alive: true,
    _captured: false, _capturedByArm: null, _armPinned: false, _armPinPos: null,
    _scenePosition: new THREE.Vector3(0, 0, 0),
  };
}

function enterSK(arm, target) {
  arm.state = S.STATION_KEEP;
  arm.target = target;
  arm._stationKeepTarget = target;
  arm.position.copy(target._scenePosition);
}

/** Pass EXTEND (0.3) + SEEK (0.4) + CLOSE (1.2). */
function driveGripper(arm) {
  arm._updateGripperGrapple(0.35);  // EXTEND → SEEK
  arm._updateGripperGrapple(0.45);  // SEEK → (latch attempt) → CLOSE
  arm._updateGripperGrapple(1.25);  // CLOSE → resolve
}

function capture(evts, fn) {
  const got = {}, handlers = {};
  for (const e of evts) { got[e] = []; handlers[e] = (d) => got[e].push(d); eventBus.on(e, handlers[e]); }
  try { fn(); } finally { for (const e of evts) eventBus.off(e, handlers[e]); }
  return got;
}

describe('ArmUnit gripper grapple — entry + resolution', () => {
  it('fixtured target → LATCHED → GRAPPLED with the catch pinned', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const target = makeTarget({ fixture: true });
    enterSK(arm, target);
    arm.selectedTool = 'GRIPPER';

    const lock = capture([Events.AUTOPILOT_TARGET_LOCK], () => {
      assert.equal(arm.dispatchSelectedTool(), true);
    });
    assert.equal(arm.state, S.GRIPPER_GRAPPLE, 'entered gripper state');
    assert.equal(lock[Events.AUTOPILOT_TARGET_LOCK].length, 1, 'CA exemption emitted');

    arm._gripRollOverride = 0;  // deterministic latch
    const got = capture([Events.GRIPPER_LATCHED, Events.ARM_CAPTURED, Events.GRIPPER_LATCH_ATTEMPT],
      () => driveGripper(arm));

    assert.equal(arm.state, S.GRAPPLED, 'latched → shared GRAPPLED path');
    assert.equal(arm.capturedDebris, target);
    assert.equal(target._armPinned, true);
    assert.equal(arm._captureToolKind, 'GRIPPER');
    assert.equal(got[Events.GRIPPER_LATCH_ATTEMPT][0].fixtured, true);
    assert.equal(got[Events.GRIPPER_LATCHED].length, 1);
    assert.equal(got[Events.ARM_CAPTURED][0].tool, 'GRIPPER');
  });

  it('unfixtured target → GRIPPER_SLIPPED(no_fixture) → RETURNING', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const target = makeTarget({ fixture: false, type: 'fragment', mass: 8 });
    enterSK(arm, target);
    arm.gripperGrapple();
    arm._gripRollOverride = 0.5;  // ≥ P_GRIP_UNFIXTURED (0.10)

    const got = capture([Events.GRIPPER_SLIPPED], () => driveGripper(arm));
    assert.equal(arm.state, S.RETURNING);
    assert.equal(arm.capturedDebris, null);
    assert.equal(got[Events.GRIPPER_SLIPPED][0].reason, 'no_fixture');
  });

  it('> 2000 kg target → GRIPPER_SLIPPED(oversize)', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const target = makeTarget({ fixture: true, mass: 2500, type: 'rocketBody' });
    enterSK(arm, target);
    arm.gripperGrapple();
    arm._gripRollOverride = 0;  // would latch if mass allowed

    const got = capture([Events.GRIPPER_SLIPPED], () => driveGripper(arm));
    assert.equal(got[Events.GRIPPER_SLIPPED][0].reason, 'oversize');
    assert.equal(arm.state, S.RETURNING);
  });

  it('recall mid-grapple releases the CA lock (no leak)', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const target = makeTarget({ fixture: true });
    enterSK(arm, target);
    arm.gripperGrapple();
    assert.equal(arm._toolLockedDebrisId, target.id);

    const got = capture([Events.AUTOPILOT_TARGET_UNLOCK], () => arm.recall());
    assert.equal(got[Events.AUTOPILOT_TARGET_UNLOCK].length, 1);
    assert.equal(arm._toolLockedDebrisId, null);
  });
});

describe('ArmUnit gripper grapple — feature flag', () => {
  it('GRIPPER is not in the Spinner toolset', () => {
    const arm = makeArm('spinner');
    assert.equal(arm.toolset.includes('GRIPPER'), false);
  });
});
