/**
 * test-ArmUnit-LeadAim.js — first-order launch lead-aim (Item 2).
 *
 * ArmUnit._updateNettingFSM aims the net not at the target's CURRENT position but
 * at where it will be after the net's time-of-flight: targetPos + relVel × (dist /
 * LAUNCH_SPEED). Relative velocity is estimated each frame from the target's scene
 * position delta (_leadTargetVel), built up during STATION_KEEP so it's ready when
 * NETTING fires on its first frame.
 *
 * We monkey-patch the captureNetSystem singleton's fireDaughterNet to capture the
 * launchDir the FSM computes, with a moving mock target.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { captureNetSystem } from '../entities/CaptureNet.js';

const S = Constants.ARM_STATES;
const M = 0.00001;

function makeArm() {
  const scene = { add: () => {}, remove: () => {} };
  const arm = new ArmUnit('weaver-1', 'weaver', new THREE.Vector3(0, 0, 0), scene);
  arm.index = 0;
  arm.isDetached = false;
  return arm;
}

// Capture the launchDir passed to fireDaughterNet without firing a real net.
function withFireSpy(fn) {
  const orig = captureNetSystem.fireDaughterNet;
  let captured = null;
  captureNetSystem.fireDaughterNet = (arm, armIndex, launchPos, launchDir) => {
    captured = { launchPos, launchDir };
    // Return a stub "active net" so the FSM treats the fire as successful.
    return { state: Constants.CAPTURE_NET.STATES.LAUNCHING, netClass: Constants.CAPTURE_NET.LARGE };
  };
  try { fn(); } finally { captureNetSystem.fireDaughterNet = orig; }
  return captured;
}

describe('ArmUnit lead-aim — net launch direction leads a moving target (Item 2)', () => {
  it('aims directly at a stationary target (no lead offset)', () => {
    const arm = makeArm();
    arm.position.set(0, 0, 0);
    const target = { id: 7, _scenePosition: { x: 50 * M, y: 0, z: 0 } };
    arm.target = target;
    arm._leadTargetVelValid = false;        // no velocity estimate
    arm.state = S.NETTING;
    arm._firedNet = null;

    const cap = withFireSpy(() => arm._updateNettingFSM(0.016));
    assert.ok(cap, 'fireDaughterNet was called');
    // Pure +X aim.
    assert.ok(Math.abs(cap.launchDir.x - 1) < 1e-6, 'aims +X at stationary target');
    assert.ok(Math.abs(cap.launchDir.y) < 1e-6 && Math.abs(cap.launchDir.z) < 1e-6, 'no lateral aim');
  });

  it('leads a crossing target — aim deflects toward the target velocity', () => {
    const arm = makeArm();
    arm.position.set(0, 0, 0);
    // Target 50 m downrange (+X), crossing in +Y.
    const target = { id: 8, _scenePosition: { x: 50 * M, y: 0, z: 0 } };
    arm.target = target;
    // Inject a known relative velocity estimate (scene-units/s): +Y crossing.
    arm._leadTargetVel = new THREE.Vector3(0, 5 * M, 0);   // 5 m/s in +Y
    arm._leadTargetVelValid = true;
    arm.state = S.NETTING;
    arm._firedNet = null;

    const cap = withFireSpy(() => arm._updateNettingFSM(0.016));
    assert.ok(cap, 'fireDaughterNet was called');
    // With a +Y crossing the aim must gain a +Y component (lead ahead of target).
    assert.ok(cap.launchDir.y > 1e-4, `aim should lead in +Y, got ${cap.launchDir.y}`);
    assert.ok(cap.launchDir.x > 0, 'still mostly downrange (+X)');
    // Direction stays a unit vector.
    const len = Math.hypot(cap.launchDir.x, cap.launchDir.y, cap.launchDir.z);
    assert.ok(Math.abs(len - 1) < 1e-6, 'launchDir is normalized');
  });

  it('estimates target scene velocity across frames (_leadTargetVel)', () => {
    const arm = makeArm();
    arm.state = S.STATION_KEEP;
    arm._stationKeepTarget = null;
    // Target moving +X at 4 m/s; step two frames so the estimator populates.
    const target = { id: 9, _scenePosition: { x: 0, y: 0, z: 0 } };
    arm.target = target;
    const parent = new THREE.Vector3(0, 0, 0);

    arm.update(0.1, parent, null);                      // frame 1: prime prev pos
    target._scenePosition.x += 4 * M * 0.1;             // advance 4 m/s for 0.1 s
    arm.update(0.1, parent, null);                      // frame 2: compute vel

    assert.ok(arm._leadTargetVelValid, 'velocity estimate becomes valid');
    assert.ok(Math.abs(arm._leadTargetVel.x - 4 * M) < 1e-7,
      `vx ≈ 4 m/s in scene units, got ${arm._leadTargetVel.x / M} m/s`);
  });
});
