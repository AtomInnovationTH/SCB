/**
 * test-StationKeep.js — Sprint 8.1 + 8.2: STATION_KEEP tests
 *
 * Covers: ARM_STATES.STATION_KEEP enum, ION_THRUSTER / STATION_KEEP /
 * TETHER_TENSION constant namespaces, Epic 8 events, ArmUnit STATION_KEEP
 * fields, _updateStationKeep logic (clamping, fuel, target-loss),
 * captureFromStationKeep(), recallFromStationKeep(),
 * ARM_ORBIT_ADJUST controls (theta/phi/radius rates, fine mode, gating).
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { Events } from '../core/Events.js';
import { eventBus } from '../core/EventBus.js';

const { ARM_STATES } = Constants;
const M = 0.00001;
const S = ARM_STATES;

/** Create a fresh ArmUnit with stub scene */
function makeArm(type = 'weaver', id = 'sk-test-1') {
  const scene = { add: () => {}, remove: () => {} };
  const offset = new THREE.Vector3(M, 0, 0);
  const arm = new ArmUnit(id, type, offset, scene);
  arm.index = 0;
  eventBus.clear();
  return arm;
}

/** Create a stub debris target with mesh */
function makeTarget(id = 'debris-sk', sizeMeter = 2) {
  return {
    id,
    sizeMeter,
    mass: 5,
    alive: true,
    type: 'fragment',
    mesh: { position: new THREE.Vector3(0.001, 0, 0) },
  };
}

/** Put arm into STATION_KEEP with a target */
function enterStationKeep(arm, target) {
  arm.state = S.STATION_KEEP;
  arm._stationKeepTarget = target || makeTarget();
  arm._standoffR = 5;
  arm._orbitTheta = 0;
  arm._orbitPhi = 0;
  arm.fuel = 100;
}

// ── Suite: STATION_KEEP enum ──────────────────────────────────────────────
describe('STATION_KEEP — ARM_STATES enum', () => {
  it('STATION_KEEP state exists in ARM_STATES', () => {
    assert.equal(Constants.ARM_STATES.STATION_KEEP, 'STATION_KEEP');
  });
});

// ── Suite: ION_THRUSTER constants ─────────────────────────────────────────
describe('STATION_KEEP — ION_THRUSTER constants', () => {
  it('ION_THRUSTER namespace exists with expected keys', () => {
    const IT = Constants.ION_THRUSTER;
    assert.ok(IT, 'ION_THRUSTER namespace missing');
    const expectedKeys = [
      'WEAVER_MAX_THRUST', 'SPINNER_MAX_THRUST', 'ISP_MIN', 'ISP_MAX',
      'ISP_DEFAULT', 'BEAM_POWER_WEAVER', 'BEAM_POWER_SPINNER',
      'EFFICIENCY', 'VECTOR_ANGLE_MAX', 'PROPELLANT', 'THRUSTER_COUNT',
      'ISP_TRANSIT', 'ISP_APPROACH', 'ISP_STATIONKEEP', 'ISP_TENSION',
      'ISP_RETURN', 'ISP_DEORBIT',
    ];
    for (const k of expectedKeys) {
      assert.ok(k in IT, `ION_THRUSTER.${k} missing`);
    }
  });
});

// ── Suite: STATION_KEEP constants ─────────────────────────────────────────
describe('STATION_KEEP — STATION_KEEP constants', () => {
  it('STATION_KEEP namespace exists with expected keys', () => {
    const SK = Constants.STATION_KEEP;
    assert.ok(SK, 'STATION_KEEP namespace missing');
    const expectedKeys = [
      'DEFAULT_STANDOFF_MULT', 'MIN_STANDOFF', 'MAX_STANDOFF',
      'ORBIT_RATE', 'ORBIT_RATE_FINE', 'RADIUS_RATE', 'RADIUS_RATE_FINE',
      'MAX_LATITUDE', 'TETHER_SAFETY_MARGIN', 'STATIONKEEP_LERP_RATE',
      'FUEL_RATE_STATIONKEEP', 'FUEL_RATE_MANEUVER', 'ENTRY_MAX_VELOCITY',
    ];
    for (const k of expectedKeys) {
      assert.ok(k in SK, `STATION_KEEP.${k} missing`);
    }
  });
});

// ── Suite: TETHER_TENSION constants ───────────────────────────────────────
describe('STATION_KEEP — TETHER_TENSION constants', () => {
  it('TETHER_TENSION namespace exists with expected keys', () => {
    const TT = Constants.TETHER_TENSION;
    assert.ok(TT, 'TETHER_TENSION namespace missing');
    const expectedKeys = [
      'TARGET_TENSION', 'MIN_TENSION', 'MAX_TENSION_WARNING',
      'MAX_TENSION_CRITICAL', 'FEEP_RADIAL_HOLD_OFFSET', 'FEEP_TENSION_AUTHORITY',
    ];
    for (const k of expectedKeys) {
      assert.ok(k in TT, `TETHER_TENSION.${k} missing`);
    }
  });
});

// ── Suite: Epic 8 Events ──────────────────────────────────────────────────
describe('STATION_KEEP — Epic 8 Events', () => {
  it('ARM_ORBIT_ADJUST event exists', () => {
    assert.equal(Events.ARM_ORBIT_ADJUST, 'arm:orbit_adjust');
  });

  it('STATION_KEEP_ENTERED event exists', () => {
    assert.equal(Events.STATION_KEEP_ENTERED, 'arm:stationKeepEntered');
  });

  it('STATION_KEEP_EXITED event exists', () => {
    assert.equal(Events.STATION_KEEP_EXITED, 'arm:stationKeepExited');
  });

  it('FEEP_METAL_CHANGED event exists', () => {
    assert.equal(Events.FEEP_METAL_CHANGED, 'arm:feepMetalChanged');
  });

  it('NEWS_EVENT_TRIGGERED event exists', () => {
    assert.equal(Events.NEWS_EVENT_TRIGGERED, 'mission:newsEventTriggered');
  });
});

// ── Suite: ArmUnit STATION_KEEP fields ────────────────────────────────────
describe('STATION_KEEP — ArmUnit constructor fields', () => {
  const arm = makeArm();

  it('_orbitTheta initialized to 0', () => {
    assert.equal(arm._orbitTheta, 0);
  });

  it('_orbitPhi initialized to 0', () => {
    assert.equal(arm._orbitPhi, 0);
  });

  it('_standoffR initialized to 5', () => {
    assert.equal(arm._standoffR, 5);
  });

  it('_stationKeepTarget initialized to null', () => {
    assert.equal(arm._stationKeepTarget, null);
  });

  it('_rMin equals Constants.STATION_KEEP.MIN_STANDOFF', () => {
    assert.equal(arm._rMin, Constants.STATION_KEEP.MIN_STANDOFF);
  });

  it('_rMax equals Constants.STATION_KEEP.MAX_STANDOFF', () => {
    assert.equal(arm._rMax, Constants.STATION_KEEP.MAX_STANDOFF);
  });
});

// ── Suite: _updateStationKeep logic ───────────────────────────────────────
describe('STATION_KEEP — _updateStationKeep behavior', () => {

  it('clamps phi to MAX_LATITUDE', () => {
    const arm = makeArm();
    const target = makeTarget();
    enterStationKeep(arm, target);
    // Set phi way beyond limit
    arm._orbitPhi = Math.PI; // ~180° — far beyond 80° limit
    arm._updateStationKeep(0.016);
    const phiLimit = arm._phiMax - (Constants.STATION_KEEP.TETHER_SAFETY_MARGIN * Math.PI / 180);
    assert.ok(arm._orbitPhi <= phiLimit + 0.001, `phi ${arm._orbitPhi} should be clamped to ${phiLimit}`);
  });

  it('clamps radius between MIN and MAX standoff', () => {
    const arm = makeArm();
    const target = makeTarget();
    enterStationKeep(arm, target);

    // Set radius way beyond max
    arm._standoffR = 999;
    arm._updateStationKeep(0.016);
    assert.ok(arm._standoffR <= Constants.STATION_KEEP.MAX_STANDOFF,
      `radius ${arm._standoffR} should be clamped to MAX ${Constants.STATION_KEEP.MAX_STANDOFF}`);

    // Set radius below min
    arm._standoffR = 0.01;
    arm._updateStationKeep(0.016);
    assert.ok(arm._standoffR >= Constants.STATION_KEEP.MIN_STANDOFF,
      `radius ${arm._standoffR} should be clamped to MIN ${Constants.STATION_KEEP.MIN_STANDOFF}`);
  });

  it('fuel consumption occurs during station-keep', () => {
    const arm = makeArm();
    const target = makeTarget();
    enterStationKeep(arm, target);
    const fuelBefore = arm.fuel;
    arm._updateStationKeep(1.0); // 1 second tick
    assert.ok(arm.fuel < fuelBefore, `fuel should decrease: ${arm.fuel} < ${fuelBefore}`);
  });

  it('fuel consumption is higher during maneuver', () => {
    // Station-keep (idle) fuel
    const armIdle = makeArm();
    enterStationKeep(armIdle, makeTarget());
    armIdle.fuel = 100;
    armIdle._updateStationKeep(1.0);
    const idleFuelUsed = 100 - armIdle.fuel;

    // Station-keep (maneuvering) fuel
    const armMove = makeArm();
    enterStationKeep(armMove, makeTarget());
    armMove.fuel = 100;
    armMove._thetaRate = 1.0; // nonzero rate → maneuver
    armMove._updateStationKeep(1.0);
    const moveFuelUsed = 100 - armMove.fuel;

    assert.ok(moveFuelUsed > idleFuelUsed,
      `maneuver fuel (${moveFuelUsed}) should exceed idle fuel (${idleFuelUsed})`);
  });

  it('fuel depletion causes exit to RETURNING', () => {
    const arm = makeArm();
    const target = makeTarget();
    enterStationKeep(arm, target);
    arm.fuel = 0.001; // nearly empty
    arm._updateStationKeep(1.0); // should deplete
    assert.equal(arm.state, S.RETURNING, `state should be RETURNING, got ${arm.state}`);
    assert.equal(arm.fuel, 0, 'fuel should be 0');
  });

  it('target lost (null) causes exit to RETURNING', () => {
    const arm = makeArm();
    enterStationKeep(arm, null); // null target
    arm._stationKeepTarget = null;
    arm._updateStationKeep(0.016);
    assert.equal(arm.state, S.RETURNING, `state should be RETURNING, got ${arm.state}`);
  });
});

// ── Suite: captureFromStationKeep / recallFromStationKeep ─────────────────
describe('STATION_KEEP — capture and recall transitions', () => {

  it('captureFromStationKeep transitions to NETTING', () => {
    const arm = makeArm();
    arm.initNetInventory(); // P1: CAPTURE_NET ON requires net inventory
    enterStationKeep(arm, makeTarget());
    const result = arm.captureFromStationKeep();
    assert.equal(result, true, 'should return true');
    assert.equal(arm.state, S.NETTING, `state should be NETTING, got ${arm.state}`);
  });

  it('recallFromStationKeep transitions to RETURNING', () => {
    const arm = makeArm();
    enterStationKeep(arm, makeTarget());
    const result = arm.recallFromStationKeep();
    assert.equal(result, true, 'should return true');
    assert.equal(arm.state, S.RETURNING, `state should be RETURNING, got ${arm.state}`);
  });

  it('captureFromStationKeep returns false if not in STATION_KEEP', () => {
    const arm = makeArm();
    arm.state = S.DOCKED;
    const result = arm.captureFromStationKeep();
    assert.equal(result, false, 'should return false when not in STATION_KEEP');
    assert.equal(arm.state, S.DOCKED, 'state should remain DOCKED');
  });

  it('recallFromStationKeep returns false if not in STATION_KEEP', () => {
    const arm = makeArm();
    arm.state = S.TRANSIT;
    const result = arm.recallFromStationKeep();
    assert.equal(result, false, 'should return false when not in STATION_KEEP');
    assert.equal(arm.state, S.TRANSIT, 'state should remain TRANSIT');
  });
});

// ── Suite: ST-8.2 ARM_ORBIT_ADJUST controls ───────────────────────────────

/** Create ArmUnit that retains its eventBus listeners (clear BEFORE, not after) */
function makeArmWithEvents(type = 'weaver', id = 'sk-ctrl-test') {
  eventBus.clear(); // clear BEFORE construction so ARM_ORBIT_ADJUST listener survives
  const scene = { add: () => {}, remove: () => {} };
  const offset = new THREE.Vector3(M, 0, 0);
  const arm = new ArmUnit(id, type, offset, scene);
  arm.index = 0;
  // DON'T clear after — we need the ARM_ORBIT_ADJUST listener
  return arm;
}

describe('ST-8.2 — ARM_ORBIT_ADJUST controls', () => {

  it('sets theta rate from ARM_ORBIT_ADJUST event', () => {
    const arm = makeArmWithEvents();
    enterStationKeep(arm);

    eventBus.emit(Events.ARM_ORBIT_ADJUST, {
      armId: arm.id,
      theta: 1, phi: 0, radius: 0, fine: false
    });

    assert.equal(arm._thetaRate, Constants.STATION_KEEP.ORBIT_RATE,
      'theta rate should be ORBIT_RATE');
    assert.equal(arm._phiRate, 0, 'phi rate should be 0');
    assert.equal(arm._radiusRate, 0, 'radius rate should be 0');
  });

  it('sets phi rate from ARM_ORBIT_ADJUST event', () => {
    const arm = makeArmWithEvents();
    enterStationKeep(arm);

    eventBus.emit(Events.ARM_ORBIT_ADJUST, {
      armId: arm.id,
      theta: 0, phi: -1, radius: 0, fine: false
    });

    assert.equal(arm._phiRate, -Constants.STATION_KEEP.ORBIT_RATE,
      'phi rate should be negative ORBIT_RATE');
    assert.equal(arm._thetaRate, 0, 'theta rate should be 0');
  });

  it('sets radius rate from ARM_ORBIT_ADJUST event', () => {
    const arm = makeArmWithEvents();
    enterStationKeep(arm);

    eventBus.emit(Events.ARM_ORBIT_ADJUST, {
      armId: arm.id,
      theta: 0, phi: 0, radius: 1, fine: false
    });

    assert.equal(arm._radiusRate, Constants.STATION_KEEP.RADIUS_RATE,
      'radius rate should be RADIUS_RATE');
  });

  it('fine mode reduces rates to ¼ of normal', () => {
    const arm = makeArmWithEvents();
    enterStationKeep(arm);

    eventBus.emit(Events.ARM_ORBIT_ADJUST, {
      armId: arm.id,
      theta: 1, phi: 1, radius: 1, fine: true
    });

    assert.equal(arm._thetaRate, Constants.STATION_KEEP.ORBIT_RATE_FINE,
      'theta rate should be ORBIT_RATE_FINE');
    assert.equal(arm._phiRate, Constants.STATION_KEEP.ORBIT_RATE_FINE,
      'phi rate should be ORBIT_RATE_FINE');
    assert.equal(arm._radiusRate, Constants.STATION_KEEP.RADIUS_RATE_FINE,
      'radius rate should be RADIUS_RATE_FINE');
  });

  it('ignores ARM_ORBIT_ADJUST if arm not in STATION_KEEP', () => {
    const arm = makeArmWithEvents();
    // Don't enter station keep — arm is in DOCKED state
    arm._thetaRate = 0;
    arm._phiRate = 0;
    arm._radiusRate = 0;

    eventBus.emit(Events.ARM_ORBIT_ADJUST, {
      armId: arm.id,
      theta: 1, phi: 1, radius: 1, fine: false
    });

    assert.equal(arm._thetaRate, 0, 'theta rate should remain 0');
    assert.equal(arm._phiRate, 0, 'phi rate should remain 0');
    assert.equal(arm._radiusRate, 0, 'radius rate should remain 0');
  });

  it('ignores ARM_ORBIT_ADJUST if armId does not match', () => {
    const arm = makeArmWithEvents();
    enterStationKeep(arm);

    eventBus.emit(Events.ARM_ORBIT_ADJUST, {
      armId: 'wrong-arm-id',
      theta: 1, phi: 1, radius: 1, fine: false
    });

    assert.equal(arm._thetaRate, 0, 'theta rate should remain 0');
    assert.equal(arm._phiRate, 0, 'phi rate should remain 0');
    assert.equal(arm._radiusRate, 0, 'radius rate should remain 0');
  });

  it('captureFromStationKeep transitions to NETTING', () => {
    const arm = makeArm();
    arm.initNetInventory(); // P1: CAPTURE_NET ON requires net inventory
    enterStationKeep(arm);

    const result = arm.captureFromStationKeep();

    assert.equal(result, true, 'should return true');
    assert.equal(arm.state, Constants.ARM_STATES.NETTING,
      'state should be NETTING after capture');
  });

  it('recallFromStationKeep transitions to RETURNING', () => {
    const arm = makeArm();
    enterStationKeep(arm);

    const result = arm.recallFromStationKeep();

    assert.equal(result, true, 'should return true');
    assert.equal(arm.state, Constants.ARM_STATES.RETURNING,
      'state should be RETURNING after recall');
  });
});
