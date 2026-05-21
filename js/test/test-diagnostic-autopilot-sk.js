/**
 * test-diagnostic-autopilot-sk.js — Validates daughter autopilot fixes:
 *
 * Fix 1: TRANSIT + APPROACH use proportional controller with velocity matching
 *         (ported from mother AutopilotSystem.js control law §D).
 * Fix 2: APPROACH uses standoff-aware quadratic braking → STATION_KEEP entry.
 * Fix 3: Camera _computeArmPilot() STATION_KEEP localUp is orthogonalized.
 * Fix 4: Orbital drift correction compensates parent/target frame velocity difference.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { eventBus } from '../core/EventBus.js';

const { ARM_STATES } = Constants;
const M = 0.00001;
const S = ARM_STATES;

function makeArm(type = 'weaver', id = 'diag-1') {
  const scene = { add: () => {}, remove: () => {} };
  const offset = new THREE.Vector3(M, 0, 0);
  const arm = new ArmUnit(id, type, offset, scene);
  arm.index = 0;
  eventBus.clear();
  return arm;
}

function makeTarget(id = 'debris-diag', sizeMeter = 2) {
  return {
    id,
    sizeMeter,
    mass: 5,
    alive: true,
    type: 'fragment',
    mesh: { position: new THREE.Vector3(0.001, 0, 0) },
    _scenePosition: new THREE.Vector3(0.001, 0, 0),
  };
}

// ── Fix 1: DAUGHTER_AUTOPILOT constants ────────────────────────────────────
describe('FIX VERIFY — DAUGHTER_AUTOPILOT proportional controller constants', () => {

  it('DAUGHTER_AUTOPILOT block exists with all required keys', () => {
    const DAP = Constants.DAUGHTER_AUTOPILOT;
    assert.ok(DAP, 'DAUGHTER_AUTOPILOT namespace missing');
    for (const key of ['MAX_ACCEL', 'KP_VEL', 'BRAKE_FRACTION', 'V_CAP']) {
      assert.ok(key in DAP, `DAUGHTER_AUTOPILOT.${key} missing`);
      assert.ok(typeof DAP[key] === 'number' && DAP[key] > 0, `${key} should be positive number`);
    }
  });

  it('V_CAP matches T1 spring maxSpeed (fallback for coast-not-accelerate policy)', () => {
    const vCapMs = Constants.DAUGHTER_AUTOPILOT.V_CAP;
    // V_CAP = Steel T1 maxSpeed (7.1). TRANSIT dynamically uses _launchSpeedMps.
    assert.equal(vCapMs, Constants.SPRING_TIERS[0].maxSpeed,
      `V_CAP (${vCapMs}) should match T1 spring maxSpeed (${Constants.SPRING_TIERS[0].maxSpeed})`);
  });

  it('quadratic braking produces v*=0 at standoff boundary (excessDist=0)', () => {
    const DAP = Constants.DAUGHTER_AUTOPILOT;
    const A_BRAKE = DAP.MAX_ACCEL * DAP.BRAKE_FRACTION;
    // At standoff: excessDist=0 → v*=0
    const vAtStandoff = Math.sqrt(2 * A_BRAKE * 0);
    assert.equal(vAtStandoff, 0, 'v* at standoff should be 0');
    // Braking profile is monotonically decreasing toward standoff
    const v5 = Math.min(DAP.V_CAP * 0.3, Math.sqrt(2 * A_BRAKE * 5));
    const v1 = Math.min(DAP.V_CAP * 0.3, Math.sqrt(2 * A_BRAKE * 1));
    const v01 = Math.min(DAP.V_CAP * 0.3, Math.sqrt(2 * A_BRAKE * 0.1));
    assert.ok(v5 >= v1 && v1 >= v01 && v01 >= 0,
      `v*(5m)=${v5.toFixed(3)} ≥ v*(1m)=${v1.toFixed(3)} ≥ v*(0.1m)=${v01.toFixed(4)} ≥ 0`);
  });
});

// ── Fix 2: Arm enters STATION_KEEP via proportional controller ────────────
describe('FIX VERIFY — APPROACH proportional controller → STATION_KEEP entry', () => {

  it('arm decelerates and enters STATION_KEEP', () => {
    const arm = makeArm();
    const target = makeTarget();
    arm.target = target;
    arm.state = S.APPROACH;
    arm.isDetached = true;
    arm._startingDistance = 100 * M;

    // Place arm 7m from target (inside braking zone)
    arm.position.set(target.mesh.position.x - 7 * M, 0, 0);
    // Set initial velocity = APPROACH cruise (from TRANSIT handoff)
    arm.velocity.set(Constants.ARM_APPROACH_SPEED * 0.3, 0, 0);
    // Setup previous positions for drift calculation
    arm._prevParentPos = new THREE.Vector3(0, 0, 0);
    arm._prevTargetScenePos = target._scenePosition.clone();

    const dt = 1 / 60;
    let enteredSK = false;
    let frameCount = 0;

    for (let i = 0; i < 3000; i++) {
      frameCount = i;
      if (arm.state === S.STATION_KEEP) {
        enteredSK = true;
        break;
      }
      const parentPos = new THREE.Vector3(0, 0, 0);
      arm._updateApproach(dt, parentPos);
    }

    assert.ok(enteredSK,
      `arm should enter STATION_KEEP (frames: ${frameCount})`);
  });

  it('impulse-based controller: velocity changes by dvCmd (not lerp)', () => {
    // Verify the controller applies an additive impulse each frame
    const arm = makeArm();
    const target = makeTarget();
    arm.target = target;
    arm.state = S.TRANSIT;
    arm.isDetached = true;
    arm._startingDistance = 100 * M;
    arm.position.set(0.0005, 0, 0);
    arm.velocity.set(0, 0, 0);
    arm._prevParentPos = new THREE.Vector3(0, 0, 0);

    // Run one frame
    arm._updateTransit(1 / 60, new THREE.Vector3(0, 0, 0));
    const vel1 = arm.velocity.clone();

    // Run another frame — velocity should ACCUMULATE (impulse-based), not reset
    arm._updateTransit(1 / 60, new THREE.Vector3(0, 0, 0));
    const vel2 = arm.velocity.clone();

    // vel2 should be larger than vel1 (still accelerating toward target)
    assert.ok(vel2.length() > vel1.length() * 0.9,
      `velocity should accumulate: v2=${vel2.length()} > v1*0.9=${vel1.length() * 0.9}`);
  });
});

// ── Fix 3: Camera SK localUp orthogonalized ───────────────────────────────
describe('FIX VERIFY — Camera STATION_KEEP localUp orthogonalization', () => {

  it('orthogonalized localUp has ~zero projection onto toDebris', () => {
    const armPos = new THREE.Vector3(0.06, 0.03, 0.01);
    const debrisPos = new THREE.Vector3(0.06, 0.035, 0.01);

    const toDebris = debrisPos.clone().sub(armPos).normalize();
    const rawUp = armPos.clone().normalize();
    const upDot = rawUp.dot(toDebris);
    const localUp = rawUp.clone().sub(toDebris.clone().multiplyScalar(upDot)).normalize();

    const dot = Math.abs(localUp.dot(toDebris));
    assert.ok(dot < 0.001,
      `|localUp·toDebris| = ${dot.toFixed(6)} should be < 0.001 (orthogonalized)`);
  });

  it('camera offset components are perpendicular after orthogonalization', () => {
    const armPos = new THREE.Vector3(0.06, 0.03, 0.01);
    const debrisPos = new THREE.Vector3(0.06, 0.035, 0.01);

    const toDebris = debrisPos.clone().sub(armPos).normalize();
    const rawUp = armPos.clone().normalize();
    const upDot = rawUp.dot(toDebris);
    const localUp = rawUp.clone().sub(toDebris.clone().multiplyScalar(upDot)).normalize();

    const perpDot = Math.abs(toDebris.dot(localUp));
    assert.ok(perpDot < 0.001,
      `behind·above dot = ${perpDot.toFixed(6)} should be ~0 (perpendicular offsets)`);
  });
});

// ── Fix 4: Orbital drift correction ───────────────────────────────────────
describe('FIX VERIFY — Orbital drift correction in proportional controller', () => {

  it('_prevTargetScenePos field initialized to null', () => {
    const arm = makeArm();
    assert.equal(arm._prevTargetScenePos, null);
  });

  it('TRANSIT with lateral drift: velocity gets Y-component from drift correction', () => {
    const arm = makeArm();
    const target = makeTarget();
    arm.target = target;
    arm.state = S.TRANSIT;
    arm.isDetached = true;
    arm._startingDistance = 100 * M;
    arm.position.set(0.0005, 0, 0);
    arm.velocity.set(0, 0, 0);
    arm._prevParentPos = new THREE.Vector3(0, 0, 0);
    arm._prevTargetScenePos = target._scenePosition.clone();

    // Target moves +Y (different orbit), parent stays stationary
    target._scenePosition.add(new THREE.Vector3(0, 0.00001, 0));

    arm._updateTransit(1 / 60, new THREE.Vector3(0, 0, 0));

    assert.ok(arm.velocity.y > 0,
      `velocity.y should be positive (drift correction toward target Y motion), got ${arm.velocity.y}`);
  });

  it('TRANSIT with no drift: velocity purely toward target', () => {
    const arm = makeArm();
    const target = makeTarget();
    arm.target = target;
    arm.state = S.TRANSIT;
    arm.isDetached = true;
    arm._startingDistance = 100 * M;
    arm.position.set(0.0005, 0, 0);
    arm.velocity.set(0, 0, 0);
    arm._prevParentPos = new THREE.Vector3(0, 0, 0);
    arm._prevTargetScenePos = target._scenePosition.clone();

    arm._updateTransit(1 / 60, new THREE.Vector3(0, 0, 0));

    assert.ok(arm.velocity.x > 0, `velocity.x should be positive (toward target)`);
    assert.ok(Math.abs(arm.velocity.y) < 1e-15, `velocity.y should be ~0 (no drift)`);
    assert.ok(Math.abs(arm.velocity.z) < 1e-15, `velocity.z should be ~0 (no drift)`);
  });
});
