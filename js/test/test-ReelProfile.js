/**
 * test-ReelProfile.js — Q1 trapezoidal reel-in velocity profile
 * (reel-in-redock-inertia plan, FEATURE_FLAGS.REEL_PROFILE_V2).
 *
 * Coverage: light catch reaches the cruise cap; a near-rated catch is
 * power/tension throttled below it; the speed ramps DOWN to V_DOCK inside
 * DECEL_DISTANCE_M; an in-spec catch never exceeds the tether break strength at
 * full cruise (the snap invariant); boost is locked out inside the decel band;
 * the legacy constant-speed path is unchanged when the flag is OFF.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { ArmUnit } from '../entities/ArmUnit.js';

const S = Constants.ARM_STATES;
const M = 0.00001;

function makeArm() {
  const scene = { add: () => {}, remove: () => {} };
  const arm = new ArmUnit('Weaver-1', 'weaver', new THREE.Vector3(M, 0, 0), scene);
  arm.index = 0;
  arm.state = S.REELING;
  arm.isDetached = false;
  arm._netRatedMass = 500;
  arm._netDiameter = 5;
  return arm;
}

function makeDebris(mass, sizeMeter = 1) {
  return { id: 7, mass, sizeMeter, _captured: true, _capturedByArm: null, _netted: false,
    _isStationKeepTarget: false, _committedNetArmId: null };
}

function withFlag(on, fn) {
  const prev = Constants.FEATURE_FLAGS.REEL_PROFILE_V2;
  Constants.FEATURE_FLAGS.REEL_PROFILE_V2 = on;
  try { return fn(); } finally { Constants.FEATURE_FLAGS.REEL_PROFILE_V2 = prev; }
}

describe('ReelProfile — cruise throttle', () => {
  it('a light/empty catch reaches V_CRUISE_MAX far from the dock', () => {
    withFlag(true, () => {
      const arm = makeArm();
      const armMass = Constants.V5_WEAVER_MASS;
      // far out, empty (no payload) → cruise cap
      const v = arm._computeReelProfileSpeed(2000, armMass, false, 1);
      assert.ok(Math.abs(v - Constants.REEL_PROFILE.V_CRUISE_MAX) < 1e-6,
        `empty haul cruises at V_CRUISE_MAX (got ${v})`);
    });
  });

  it('a near-rated heavy catch is throttled well below V_CRUISE_MAX', () => {
    withFlag(true, () => {
      const arm = makeArm();
      arm.capturedDebris = makeDebris(500);
      const armMass = Constants.V5_WEAVER_MASS;
      const v = arm._computeReelProfileSpeed(2000, armMass, true, 1);
      assert.ok(v < Constants.REEL_PROFILE.V_CRUISE_MAX,
        `heavy catch throttled (got ${v})`);
      assert.ok(v > (Constants.REEL_PROFILE.V_DOCK),
        `but still above V_DOCK (got ${v})`);
    });
  });
});

describe('ReelProfile — ramp-down to dock', () => {
  it('speed eases toward V_DOCK as distance closes inside DECEL_DISTANCE_M', () => {
    withFlag(true, () => {
      const arm = makeArm();
      const armMass = Constants.V5_WEAVER_MASS;
      const dd = Constants.REEL_PROFILE.DECEL_DISTANCE_M;
      const vFar = arm._computeReelProfileSpeed(dd, armMass, false, 1);
      const vMid = arm._computeReelProfileSpeed(dd * 0.5, armMass, false, 1);
      const vNear = arm._computeReelProfileSpeed(0.001, armMass, false, 1);
      assert.ok(vFar > vMid && vMid > vNear, `monotone ramp-down (${vFar} > ${vMid} > ${vNear})`);
      assert.ok(Math.abs(vNear - Constants.REEL_PROFILE.V_DOCK) < 0.5,
        `bottoms out near V_DOCK (got ${vNear})`);
    });
  });
});

describe('ReelProfile — snap invariant', () => {
  it('a max in-spec Weaver catch (500 kg) stays under break strength at full cruise', () => {
    withFlag(true, () => {
      const arm = makeArm();
      arm.capturedDebris = makeDebris(500);
      arm.position.set(2000 * M + arm.position.x, 0, 0);
      // one reel step far from dock (cruise), no boost
      arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null);
      assert.ok(arm.tetherTension < arm.tetherBreakStrength,
        `in-spec catch never snaps at cruise (tension ${arm.tetherTension} < break ${arm.tetherBreakStrength})`);
    });
  });
});

describe('ReelProfile — boost lockout in decel', () => {
  it('boost multiplies cruise far out but is suppressed inside DECEL_DISTANCE_M', () => {
    withFlag(true, () => {
      const arm = makeArm();
      arm.capturedDebris = makeDebris(50);   // light enough not to dominate
      const armMass = Constants.V5_WEAVER_MASS;
      const dd = Constants.REEL_PROFILE.DECEL_DISTANCE_M;
      const vCruiseBoost = arm._computeReelProfileSpeed(2000, armMass, true, 2);
      const vCruiseNoBoost = arm._computeReelProfileSpeed(2000, armMass, true, 1);
      assert.ok(vCruiseBoost >= vCruiseNoBoost, 'boost does not slow cruise');
      // inside the decel band boost is locked out → no ×2
      const vInBoost = arm._computeReelProfileSpeed(dd * 0.5, armMass, true, 2);
      const vInNoBoost = arm._computeReelProfileSpeed(dd * 0.5, armMass, true, 1);
      assert.ok(Math.abs(vInBoost - vInNoBoost) < 1e-6,
        `boost locked out inside decel (got ${vInBoost} vs ${vInNoBoost})`);
    });
  });
});

describe('ReelProfile — flag OFF keeps legacy constant speed', () => {
  it('with the flag OFF the tension matches the legacy linear model exactly', () => {
    withFlag(false, () => {
      const arm = makeArm();
      arm.capturedDebris = makeDebris(400);
      arm.capturedDebris._capturedByArm = arm;
      arm.position.set(1, 0, 0);
      arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null);
      const armMass = Constants.V5_WEAVER_MASS;
      const expected = (armMass + 400) * Constants.REEL_IN_SPEED_LOADED * (Constants.REEL_TENSION_COEFF ?? 0.04);
      assert.ok(Math.abs(arm.tetherTension - expected) < 1e-6,
        `legacy tension preserved (got ${arm.tetherTension}, want ${expected})`);
    });
  });
});
