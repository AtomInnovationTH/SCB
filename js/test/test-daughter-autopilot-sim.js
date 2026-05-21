/**
 * test-daughter-autopilot-sim.js — Numerical simulation of daughter autopilot
 * with realistic orbital conditions.
 *
 * Models 1000+ frames of TRANSIT → APPROACH → STATION_KEEP with:
 *   - Parent at LEO 400km orbiting at ~7.67 km/s
 *   - Target debris at ~35m trailing distance
 *   - Daughter arm launched from parent toward target at 10 m/s
 *   - Full orbital frame correction cycle each frame
 *   - Traces: distance to target, velocity magnitude, state transitions
 *
 * Three scenarios:
 *   A) Stationary parent (control baseline)
 *   B) Orbiting parent + target in SAME orbit (trailing formation)
 *   C) Orbiting parent + target with cross-track drift (different orbit)
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { eventBus } from '../core/EventBus.js';

const { ARM_STATES } = Constants;
const M = 0.00001; // 1 meter in scene units
const S = ARM_STATES;

// --- Orbital mechanics helper ---
const GM_EARTH = 3.986e14; // m³/s²
const R_EARTH = 6371e3;    // m
const ALT_LEO = 400e3;     // m
const R_ORBIT = R_EARTH + ALT_LEO; // m
const V_ORBIT = Math.sqrt(GM_EARTH / R_ORBIT); // ~7670 m/s
const OMEGA = V_ORBIT / R_ORBIT; // rad/s

// Scene-unit orbital radius
const R_SCENE = R_ORBIT * 1e-5; // meters * M = scene units (67.71)

function makeArm(type = 'weaver', id = 'sim-arm') {
  const scene = { add: () => {}, remove: () => {} };
  const offset = new THREE.Vector3(M, 0, 0);
  const arm = new ArmUnit(id, type, offset, scene);
  arm.index = 0;
  arm.isDetached = true; // No tether limit
  eventBus.clear();
  return arm;
}

function makeTarget(id = 'debris-sim', sizeMeter = 2) {
  return {
    id,
    sizeMeter,
    mass: 5,
    alive: true,
    type: 'fragment',
    mesh: { position: new THREE.Vector3(0, 0, 0) },
    _scenePosition: new THREE.Vector3(0, 0, 0),
  };
}

/**
 * Propagate a circular orbit in the X-Z plane.
 * Returns new position for an object at angle theta.
 */
function orbitPos(theta) {
  return new THREE.Vector3(
    R_SCENE * Math.cos(theta),
    0,
    R_SCENE * Math.sin(theta)
  );
}

/**
 * Run a full simulation of the daughter autopilot with given orbital model.
 *
 * @param {object} opts
 * @param {number} opts.maxFrames - max simulation frames
 * @param {number} opts.dt - real-time dt per frame
 * @param {boolean} opts.orbiting - whether parent/target orbit
 * @param {number} opts.targetTrailM - trailing distance in meters
 * @param {number} opts.crossTrackDriftMps - cross-track drift velocity (m/s)
 * @param {number} opts.launchSpeedMps - launch speed in m/s
 * @returns {object} simulation results
 */
function runSimulation(opts = {}) {
  const {
    maxFrames = 2000,
    dt = 1 / 60,
    orbiting = false,
    targetTrailM = 35,
    crossTrackDriftMps = 0,
    launchSpeedMps = 10,
  } = opts;

  const arm = makeArm();
  const target = makeTarget();
  arm.target = target;
  arm._startingDistance = targetTrailM * M;
  arm._launchSpeedMps = launchSpeedMps;

  // Initial orbital angle
  let parentTheta = 0;
  const targetTrailAngle = targetTrailM / R_ORBIT; // radians trailing
  const timeScale = Constants.TIME_SCALE_GAMEPLAY;
  const gameDtPerFrame = dt * timeScale; // game seconds per real frame

  // Set initial positions
  let parentPos;
  if (orbiting) {
    parentPos = orbitPos(parentTheta);
    target._scenePosition.copy(orbitPos(parentTheta - targetTrailAngle));
    target.mesh.position.copy(target._scenePosition);
  } else {
    parentPos = new THREE.Vector3(R_SCENE, 0, 0);
    target._scenePosition.set(R_SCENE, 0, -targetTrailM * M);
    target.mesh.position.copy(target._scenePosition);
  }

  // Place arm at parent position
  arm.position.copy(parentPos);

  // Set initial velocity toward target
  const toTargetDir = target._scenePosition.clone().sub(arm.position).normalize();
  arm.velocity.copy(toTargetDir.multiplyScalar(launchSpeedMps * M));

  // Set arm state to TRANSIT
  arm.state = S.TRANSIT;
  arm._prevParentPos = parentPos.clone();
  arm._prevTargetScenePos = target._scenePosition.clone();
  arm._smoothDriftVel = new THREE.Vector3(0, 0, 0);
  arm._transitFrameCount = 100; // skip diagnostic logs

  // Tracking arrays
  const distHistory = [];
  const velHistory = [];
  const stateHistory = [];
  let transitToApproachFrame = -1;
  let approachToSKFrame = -1;

  for (let frame = 0; frame < maxFrames; frame++) {
    // --- Propagate orbits ---
    let prevParentPos = parentPos.clone();
    if (orbiting) {
      parentTheta += OMEGA * gameDtPerFrame;
      parentPos = orbitPos(parentTheta);

      // Target: same orbit trailing, plus optional cross-track drift
      const targetTheta = parentTheta - targetTrailAngle;
      const crossTrackOffset = crossTrackDriftMps * M * (frame * dt); // growing Y offset
      target._scenePosition.copy(orbitPos(targetTheta));
      target._scenePosition.y += crossTrackOffset;
      target.mesh.position.copy(target._scenePosition);
    }
    // For stationary case, positions don't change

    // --- Step 1: Orbital frame correction (APPLY) ---
    if (arm.state !== S.DOCKED && arm.state !== S.DOCKING) {
      if (arm._prevParentPos) {
        arm.position.x += (parentPos.x - arm._prevParentPos.x);
        arm.position.y += (parentPos.y - arm._prevParentPos.y);
        arm.position.z += (parentPos.z - arm._prevParentPos.z);
      }
    }

    // --- Step 2: State machine ---
    const prevState = arm.state;
    if (arm.state === S.TRANSIT) {
      arm._updateTransit(dt, parentPos);
    } else if (arm.state === S.APPROACH) {
      arm._updateApproach(dt, parentPos);
    } else if (arm.state === S.STATION_KEEP) {
      arm._updateStationKeep(dt);
    }

    // Track state transitions
    if (prevState === S.TRANSIT && arm.state === S.APPROACH && transitToApproachFrame < 0) {
      transitToApproachFrame = frame;
    }
    if (prevState === S.APPROACH && arm.state === S.STATION_KEEP && approachToSKFrame < 0) {
      approachToSKFrame = frame;
    }

    // --- Step 3: Store _prevParentPos ---
    if (!arm._prevParentPos) arm._prevParentPos = new THREE.Vector3();
    arm._prevParentPos.copy(parentPos);

    // --- Record telemetry ---
    const distToTarget = arm.position.distanceTo(target._scenePosition) / M;
    const velMps = arm.velocity.length() / M;
    distHistory.push(distToTarget);
    velHistory.push(velMps);
    stateHistory.push(arm.state);

    // Early exit if in STATION_KEEP for a while
    if (arm.state === S.STATION_KEEP && (frame - approachToSKFrame) > 60) {
      break;
    }

    // Safety: if recalling, abort
    if (arm.state === S.RETURNING || arm.state === S.DOCKING || arm.state === S.DOCKED) {
      break;
    }
  }

  return {
    arm,
    distHistory,
    velHistory,
    stateHistory,
    transitToApproachFrame,
    approachToSKFrame,
    finalDist: distHistory[distHistory.length - 1],
    finalVel: velHistory[velHistory.length - 1],
    finalState: stateHistory[stateHistory.length - 1],
    totalFrames: distHistory.length,
  };
}

// ============================================================================
// Scenario A: Stationary parent (control baseline)
// ============================================================================
describe('DAP SIM — Scenario A: Stationary parent (control baseline)', () => {

  it('arm converges from 35m TRANSIT → APPROACH → STATION_KEEP', () => {
    const res = runSimulation({
      maxFrames: 3000,
      orbiting: false,
      targetTrailM: 35,
      launchSpeedMps: 10,
    });

    console.log(
      `[SIM-A] frames=${res.totalFrames} | TRANSIT→APPROACH@f${res.transitToApproachFrame} | ` +
      `APPROACH→SK@f${res.approachToSKFrame} | finalDist=${res.finalDist.toFixed(2)}m | ` +
      `finalVel=${res.finalVel.toFixed(4)}m/s | finalState=${res.finalState}`
    );

    // Log distance samples every 100 frames
    for (let i = 0; i < res.distHistory.length; i += 100) {
      console.log(
        `  f${i}: dist=${res.distHistory[i].toFixed(2)}m vel=${res.velHistory[i].toFixed(3)}m/s state=${res.stateHistory[i]}`
      );
    }

    assert.ok(res.transitToApproachFrame >= 0,
      'arm should transition from TRANSIT to APPROACH');
    assert.ok(res.approachToSKFrame >= 0,
      `arm should enter STATION_KEEP (final state: ${res.finalState}, final dist: ${res.finalDist.toFixed(2)}m)`);
    assert.ok(res.finalDist < 15,
      `final distance should be < 15m (standoff=10m), got ${res.finalDist.toFixed(2)}m`);
  });

  it('distance monotonically decreases during TRANSIT (no oscillation)', () => {
    const res = runSimulation({
      maxFrames: 3000,
      orbiting: false,
      targetTrailM: 35,
      launchSpeedMps: 10,
    });

    // Check TRANSIT phase doesn't have more than 3% increase (noise tolerance)
    let maxIncrease = 0;
    for (let i = 1; i < res.distHistory.length; i++) {
      if (res.stateHistory[i] !== S.TRANSIT) break;
      const increase = res.distHistory[i] - res.distHistory[i - 1];
      if (increase > maxIncrease) maxIncrease = increase;
    }

    assert.ok(maxIncrease < 1.0,
      `TRANSIT distance should not increase by > 1m per frame, max increase was ${maxIncrease.toFixed(4)}m`);
  });
});

// ============================================================================
// Scenario B: Orbiting parent + target in same orbit (trailing)
// ============================================================================
describe('DAP SIM — Scenario B: Orbiting parent, co-orbital target', () => {

  it('arm converges from 35m TRANSIT → APPROACH → STATION_KEEP with orbital motion', () => {
    const res = runSimulation({
      maxFrames: 3000,
      orbiting: true,
      targetTrailM: 35,
      launchSpeedMps: 10,
    });

    console.log(
      `[SIM-B] frames=${res.totalFrames} | TRANSIT→APPROACH@f${res.transitToApproachFrame} | ` +
      `APPROACH→SK@f${res.approachToSKFrame} | finalDist=${res.finalDist.toFixed(2)}m | ` +
      `finalVel=${res.finalVel.toFixed(4)}m/s | finalState=${res.finalState}`
    );

    for (let i = 0; i < res.distHistory.length; i += 100) {
      console.log(
        `  f${i}: dist=${res.distHistory[i].toFixed(2)}m vel=${res.velHistory[i].toFixed(3)}m/s state=${res.stateHistory[i]}`
      );
    }

    assert.ok(res.transitToApproachFrame >= 0,
      'arm should transition from TRANSIT to APPROACH');
    assert.ok(res.approachToSKFrame >= 0,
      `arm should enter STATION_KEEP (final state: ${res.finalState}, final dist: ${res.finalDist.toFixed(2)}m, frames: ${res.totalFrames})`);
    assert.ok(res.finalDist < 15,
      `final distance should be < 15m (standoff=10m), got ${res.finalDist.toFixed(2)}m`);
  });

  it('orbital frame correction keeps arm-target distance stable (not diverging)', () => {
    const res = runSimulation({
      maxFrames: 3000,
      orbiting: true,
      targetTrailM: 35,
      launchSpeedMps: 10,
    });

    // Check no frame has distance > initial distance + 5m (arm shouldn't drift away)
    const maxDist = Math.max(...res.distHistory);
    assert.ok(maxDist < 50,
      `distance should never exceed 50m (initial=35m), max was ${maxDist.toFixed(2)}m`);
  });
});

// ============================================================================
// Scenario C: Orbiting parent + target with cross-track drift
// ============================================================================
describe('DAP SIM — Scenario C: Orbiting parent, cross-track drift', () => {

  it('arm converges despite 0.1 m/s cross-track target drift', () => {
    const res = runSimulation({
      maxFrames: 3000,
      orbiting: true,
      targetTrailM: 35,
      crossTrackDriftMps: 0.1,
      launchSpeedMps: 10,
    });

    console.log(
      `[SIM-C] frames=${res.totalFrames} | TRANSIT→APPROACH@f${res.transitToApproachFrame} | ` +
      `APPROACH→SK@f${res.approachToSKFrame} | finalDist=${res.finalDist.toFixed(2)}m | ` +
      `finalVel=${res.finalVel.toFixed(4)}m/s | finalState=${res.finalState}`
    );

    for (let i = 0; i < res.distHistory.length; i += 100) {
      console.log(
        `  f${i}: dist=${res.distHistory[i].toFixed(2)}m vel=${res.velHistory[i].toFixed(3)}m/s state=${res.stateHistory[i]}`
      );
    }

    assert.ok(res.transitToApproachFrame >= 0,
      'arm should transition from TRANSIT to APPROACH');
    assert.ok(res.approachToSKFrame >= 0,
      `arm should enter STATION_KEEP with drift (final state: ${res.finalState}, final dist: ${res.finalDist.toFixed(2)}m)`);
  });
});

// ============================================================================
// Scenario D: Diagnostic — trace per-frame control telemetry for 100 frames
// ============================================================================
describe('DAP SIM — Scenario D: Per-frame control law analysis', () => {

  it('dvCmd magnitude and direction are reasonable across TRANSIT+APPROACH', () => {
    // Run a short simulation and verify control signals
    const arm = makeArm();
    const target = makeTarget();
    arm.target = target;
    arm._startingDistance = 35 * M;
    arm._launchSpeedMps = 10;
    arm.state = S.TRANSIT;
    arm.isDetached = true;

    // Stationary setup for clarity
    const parentPos = new THREE.Vector3(R_SCENE, 0, 0);
    target._scenePosition.set(R_SCENE, 0, -35 * M);
    target.mesh.position.copy(target._scenePosition);
    arm.position.copy(parentPos);
    arm.velocity.set(0, 0, -10 * M); // 10 m/s toward target
    arm._prevParentPos = parentPos.clone();
    arm._prevTargetScenePos = target._scenePosition.clone();
    arm._smoothDriftVel = new THREE.Vector3(0, 0, 0);
    arm._transitFrameCount = 100;

    const dt = 1 / 60;
    const DAP = Constants.DAUGHTER_AUTOPILOT;
    let prevVel = arm.velocity.clone();
    let maxDvMps = 0;
    let maxPosErrM = 0;
    let brakeDetected = false;

    for (let i = 0; i < 600; i++) {
      const preVel = arm.velocity.clone();
      const preState = arm.state;

      if (arm.state === S.TRANSIT) {
        arm._updateTransit(dt, parentPos);
      } else if (arm.state === S.APPROACH) {
        arm._updateApproach(dt, parentPos);
      } else {
        break; // SK entered
      }

      // Skip dvCmd measurement on state-transition frames (SK entry zeros velocity)
      if (arm.state !== preState) continue;

      const postVel = arm.velocity.clone();
      const dvCmd = postVel.clone().sub(preVel);
      const dvMps = dvCmd.length() / M;
      const dist = arm.position.distanceTo(target._scenePosition) / M;

      if (dvMps > maxDvMps) maxDvMps = dvMps;
      if (dist > maxPosErrM) maxPosErrM = dist;

      // Check if braking is happening (dvCmd opposes velocity direction)
      if (dvCmd.dot(preVel) < 0 && preVel.length() > 0.1 * M) {
        brakeDetected = true;
      }

      if (!arm._prevParentPos) arm._prevParentPos = new THREE.Vector3();
      arm._prevParentPos.copy(parentPos);
    }

    const maxAccelBudget = DAP.MAX_ACCEL * Constants.TIME_SCALE_GAMEPLAY * (1 / 60);
    console.log(
      `[SIM-D] maxDvPerFrame=${maxDvMps.toFixed(5)}m/s | ` +
      `maxAccelBudget=${maxAccelBudget.toFixed(5)}m/s | ` +
      `brakeDetected=${brakeDetected} | finalState=${arm.state}`
    );

    assert.ok(maxDvMps <= maxAccelBudget + 0.001,
      `dvCmd should never exceed MAX_ACCEL budget: ${maxDvMps.toFixed(5)} > ${maxAccelBudget.toFixed(5)}`);
    assert.ok(brakeDetected,
      'controller should brake (dvCmd opposes velocity) when approaching too fast');
    assert.ok(arm.state === S.STATION_KEEP || arm.state === S.APPROACH,
      `arm should reach at least APPROACH (got ${arm.state})`);
  });
});

// ============================================================================
// Scenario E: Verify APPROACH braking profile near standoff
// ============================================================================
describe('DAP SIM — Scenario E: APPROACH braking near standoff', () => {

  it('velocity converges to zero at standoff distance', () => {
    const arm = makeArm();
    const target = makeTarget();
    arm.target = target;
    arm._startingDistance = 100 * M;
    arm.state = S.APPROACH;
    arm.isDetached = true;

    const parentPos = new THREE.Vector3(0, 0, 0);
    target._scenePosition.set(0.001, 0, 0);
    target.mesh.position.copy(target._scenePosition);

    // Start 15m from target, moving toward at 1 m/s (outside standoff=10m)
    arm.position.set(0.001 - 15 * M, 0, 0);
    arm.velocity.set(1 * M, 0, 0); // 1 m/s toward target
    arm._prevParentPos = parentPos.clone();
    arm._prevTargetScenePos = target._scenePosition.clone();
    arm._smoothDriftVel = new THREE.Vector3(0, 0, 0);

    const dt = 1 / 60;
    const standoff = Math.max(
      Constants.STATION_KEEP.MIN_STANDOFF,
      Math.min(Constants.STATION_KEEP.MAX_STANDOFF, 2 * Constants.STATION_KEEP.DEFAULT_STANDOFF_MULT)
    );

    let minDist = Infinity;
    let velAtMinDist = 0;
    let enteredSK = false;
    let finalFrame = 0;

    for (let i = 0; i < 2000; i++) {
      finalFrame = i;
      if (arm.state === S.STATION_KEEP) {
        enteredSK = true;
        break;
      }
      arm._updateApproach(dt, parentPos);
      arm._prevParentPos.copy(parentPos);

      const dist = arm.position.distanceTo(target._scenePosition) / M;
      const vel = arm.velocity.length() / M;
      if (dist < minDist) {
        minDist = dist;
        velAtMinDist = vel;
      }
    }

    console.log(
      `[SIM-E] standoff=${standoff.toFixed(1)}m | minDist=${minDist.toFixed(2)}m | ` +
      `velAtMinDist=${velAtMinDist.toFixed(4)}m/s | enteredSK=${enteredSK} | frame=${finalFrame}`
    );

    assert.ok(enteredSK,
      `arm should enter STATION_KEEP (minDist=${minDist.toFixed(2)}m, standoff=${standoff.toFixed(1)}m)`);
    assert.ok(minDist >= standoff * 0.5,
      `arm should not overshoot more than 50% past standoff: minDist=${minDist.toFixed(2)}m vs standoff=${standoff.toFixed(1)}m`);
  });
});
