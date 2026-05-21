/**
 * test-ArmUnit-ConfigG-Aim.js — ST-9.3 C-3 Config G Aim + Hinge + DualFire tests
 *
 * Covers: setAimAlpha slew, hinge lock/unlock, fireDualPair gating,
 *         decomposeAimTarget math, recoil residual, HIGH RECOIL bands,
 *         tether anchor at strut tip, fire rate safety interlock.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { ArmManager, generateDockPositions } from '../entities/ArmManager.js';
import { decomposeAimTarget } from '../systems/AimDecomposition.js';

const M = 0.00001; // scene units per meter
const V5 = Constants.OCTOPUS_V5;
const HS = Constants.HINGE_STATES;
const DS = Constants.DEPLOY_STATES;

/** Create a fresh ArmUnit with Config G geometry from ArmManager dock positions */
function makeConfigGArm(armIdx = 0, type = 'weaver') {
  const scene = { add: () => {}, remove: () => {} };
  const positions = generateDockPositions('Y0_QUAD');
  const dp = positions[armIdx];
  const arm = new ArmUnit(`test-${type}-${armIdx}`, dp.type || type, dp.offset, scene);
  arm.index = armIdx;
  arm._hingePosition = dp.hingePosition.clone();
  arm._dockOutward = dp.dockOutward.clone();
  arm._swingAxis = dp.swingAxis.clone();
  arm._azimuthDeg = dp.azimuthDeg;
  arm._isEndFace = dp.isEndFace;
  eventBus.clear();
  return arm;
}

// ============================================================================
// Suite: setAimAlpha — meridian sweep
// ============================================================================
describe('C-3: setAimAlpha — meridian sweep', () => {

  it('default _aimAlpha is 0 (stowed)', () => {
    const arm = makeConfigGArm();
    assert.equal(arm.getAimAlpha(), 0);
  });

  it('setAimAlpha(π/2) snaps to equatorial when dt=0', () => {
    const arm = makeConfigGArm();
    arm.setAimAlpha(Math.PI / 2);
    assert.closeTo(arm.getAimAlpha(), Math.PI / 2, 1e-10);
  });

  it('setAimAlpha(π) snaps to zenith when dt=0', () => {
    const arm = makeConfigGArm();
    arm.setAimAlpha(Math.PI);
    assert.closeTo(arm.getAimAlpha(), Math.PI, 1e-10);
  });

  it('setAimAlpha clamps to [0, π]', () => {
    const arm = makeConfigGArm();
    arm.setAimAlpha(-0.5);
    assert.equal(arm.getAimAlpha(), 0, 'below 0 clamps to 0');
    arm.setAimAlpha(4.0);
    assert.closeTo(arm.getAimAlpha(), Math.PI, 1e-10, 'above π clamps to π');
  });

  it('slew rate clamping limits delta per frame', () => {
    const arm = makeConfigGArm();
    arm.setAimAlpha(0); // start at 0
    // Try to jump to π in one frame at 60fps → dt= ~0.0167s
    const dt = 1 / 60;
    arm.setAimAlpha(Math.PI, dt);
    const maxStep = V5.STRUT_SLEW_RATE * dt;
    assert.closeTo(arm.getAimAlpha(), maxStep, 1e-8, 'alpha should be clamped by slew rate');
    assert.ok(arm.getAimAlpha() < Math.PI / 2, 'should not have reached equatorial in one frame');
  });

  it('slew rate over multiple frames reaches target', () => {
    const arm = makeConfigGArm();
    const target = Math.PI / 2;
    const dt = 1 / 60;
    for (let i = 0; i < 600; i++) { // 10 seconds at 60fps
      arm.setAimAlpha(target, dt);
    }
    assert.closeTo(arm.getAimAlpha(), target, 0.01, 'should reach equatorial within 10s');
  });

  it('returns true on success, false when hinge locked (flag on)', () => {
    const arm = makeConfigGArm();
    assert.equal(arm.setAimAlpha(1.0), true, 'default: aim accepted');

    // Enable lockable hinge
    const prev = Constants.FEATURE_FLAGS.LOCKABLE_HINGE;
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = true;
    arm._hingeState = HS.LOCKED;
    assert.equal(arm.setAimAlpha(0.5), false, 'locked hinge rejects aim');
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = prev;
  });
});

// ============================================================================
// Suite: Hinge state machine
// ============================================================================
describe('C-3: Hinge state machine', () => {

  it('default hinge state is ROTATE', () => {
    const arm = makeConfigGArm();
    assert.equal(arm.getHingeState(), HS.ROTATE);
  });

  it('lockHinge is no-op when LOCKABLE_HINGE flag is false', () => {
    const arm = makeConfigGArm();
    const prev = Constants.FEATURE_FLAGS.LOCKABLE_HINGE;
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = false;
    arm.lockHinge();
    assert.equal(arm.getHingeState(), HS.ROTATE, 'hinge stays ROTATE when flag off');
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = prev;
  });

  it('isHingeLocked returns false when flag is off', () => {
    const arm = makeConfigGArm();
    arm._hingeState = HS.LOCKED;
    assert.equal(arm.isHingeLocked(), false, 'returns false when feature flag off');
  });

  it('lockHinge transitions ROTATE → LOCKED and emits event', () => {
    const arm = makeConfigGArm();
    const prev = Constants.FEATURE_FLAGS.LOCKABLE_HINGE;
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = true;
    eventBus.clear();
    let emitted = null;
    eventBus.on(Events.ARM_HINGE_LOCKED, data => { emitted = data; });
    arm.lockHinge();
    assert.equal(arm.getHingeState(), HS.LOCKED);
    assert.equal(arm.isHingeLocked(), true);
    assert.ok(emitted !== null, 'ARM_HINGE_LOCKED emitted');
    assert.equal(emitted.armIndex, arm.index);
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = prev;
  });

  it('unlockHinge transitions LOCKED → ROTATE and emits event', () => {
    const arm = makeConfigGArm();
    const prev = Constants.FEATURE_FLAGS.LOCKABLE_HINGE;
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = true;
    arm._hingeState = HS.LOCKED;
    eventBus.clear();
    let emitted = null;
    eventBus.on(Events.ARM_HINGE_UNLOCKED, data => { emitted = data; });
    arm.unlockHinge();
    assert.equal(arm.getHingeState(), HS.ROTATE);
    assert.equal(arm.isHingeLocked(), false);
    assert.ok(emitted !== null, 'ARM_HINGE_UNLOCKED emitted');
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = prev;
  });

  it('lockHinge is idempotent (no double event)', () => {
    const arm = makeConfigGArm();
    const prev = Constants.FEATURE_FLAGS.LOCKABLE_HINGE;
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = true;
    arm.lockHinge();
    eventBus.clear();
    let count = 0;
    eventBus.on(Events.ARM_HINGE_LOCKED, () => { count++; });
    arm.lockHinge(); // already locked
    assert.equal(count, 0, 'no event for redundant lock');
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = prev;
  });

  it('_autoLockForFire locks and sets settle timer', () => {
    const arm = makeConfigGArm();
    const prev = Constants.FEATURE_FLAGS.LOCKABLE_HINGE;
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = true;
    arm._autoLockForFire();
    assert.equal(arm.getHingeState(), HS.LOCKED);
    assert.ok(arm._hingeSettleTimer > 0, 'settle timer should be set');
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = prev;
  });

  it('_tickHingeSettle auto-unlocks after settle time', () => {
    const arm = makeConfigGArm();
    const prev = Constants.FEATURE_FLAGS.LOCKABLE_HINGE;
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = true;
    arm._autoLockForFire();
    assert.equal(arm.isHingeLocked(), true);
    // Tick past settle time
    arm._tickHingeSettle(V5.HINGE_SETTLE_TIME + 0.01);
    assert.equal(arm.isHingeLocked(), false, 'should auto-unlock after settle');
    assert.equal(arm._hingeSettleTimer, 0);
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = prev;
  });
});

// ============================================================================
// Suite: HIGH RECOIL zone detection
// ============================================================================
describe('C-3: HIGH RECOIL zone detection', () => {

  it('α=0 (stowed) is HIGH RECOIL', () => {
    const arm = makeConfigGArm();
    arm.setAimAlpha(0);
    assert.equal(arm.isHighRecoilZone(), true);
  });

  it('α=π (zenith) is HIGH RECOIL', () => {
    const arm = makeConfigGArm();
    arm.setAimAlpha(Math.PI);
    assert.equal(arm.isHighRecoilZone(), true);
  });

  it('α=π/2 (equatorial) is NOT high recoil', () => {
    const arm = makeConfigGArm();
    arm.setAimAlpha(Math.PI / 2);
    assert.equal(arm.isHighRecoilZone(), false);
  });

  it('α=π/4 (45°) is NOT high recoil (between 30° and 150°)', () => {
    const arm = makeConfigGArm();
    arm.setAimAlpha(Math.PI / 4);
    assert.equal(arm.isHighRecoilZone(), false);
  });

  it('α=π/7 (~25.7° < 30°) IS high recoil', () => {
    const arm = makeConfigGArm();
    arm.setAimAlpha(Math.PI / 7);
    assert.equal(arm.isHighRecoilZone(), true, 'below 30° threshold');
  });

  it('threshold constants exist and are correct', () => {
    assert.closeTo(V5.HIGH_RECOIL_ALPHA_LOW, Math.PI / 6, 1e-10, '30°');
    assert.closeTo(V5.HIGH_RECOIL_ALPHA_HIGH, 5 * Math.PI / 6, 1e-10, '150°');
  });
});

// ============================================================================
// Suite: Recoil residual computation
// ============================================================================
describe('C-3: Recoil residual computation', () => {

  it('residual = 0 at α=π/2 (equatorial)', () => {
    const arm = makeConfigGArm();
    arm.setAimAlpha(Math.PI / 2);
    const res = arm.computeRecoilResidual(10);
    assert.closeTo(res, 0, 0.01, 'cos(π/2) = 0 → zero residual');
  });

  it('residual is maximal at α=0 (stowed)', () => {
    const arm = makeConfigGArm();
    arm.setAimAlpha(0);
    const mass = arm.config.mass;
    const speed = 10;
    const expected = 2 * mass * speed * V5.COLLAR_Y; // cos(0)=1
    const res = arm.computeRecoilResidual(speed);
    assert.closeTo(res, expected, 0.1, 'maximum residual at α=0');
  });

  it('residual magnitude decreases as α → π/2', () => {
    const arm = makeConfigGArm();
    arm.setAimAlpha(Math.PI / 6); // 30°
    const r30 = Math.abs(arm.computeRecoilResidual(10));
    arm.setAimAlpha(Math.PI / 3); // 60°
    const r60 = Math.abs(arm.computeRecoilResidual(10));
    arm.setAimAlpha(Math.PI / 2); // 90°
    const r90 = Math.abs(arm.computeRecoilResidual(10));
    assert.ok(r30 > r60, '30° residual > 60° residual');
    assert.ok(r60 > r90, '60° residual > 90° residual');
  });

  it('residual is negative at α=π (zenith) — opposite direction', () => {
    const arm = makeConfigGArm();
    arm.setAimAlpha(Math.PI);
    const res = arm.computeRecoilResidual(10);
    assert.ok(res < 0, 'residual is negative at zenith (cos(π) = -1)');
  });
});

// ============================================================================
// Suite: Fire rate safety interlock
// ============================================================================
describe('C-3: Fire rate safety interlock', () => {

  it('isFireRateSafe returns true at 0 rad/s', () => {
    assert.equal(ArmUnit.isFireRateSafe(0), true);
  });

  it('isFireRateSafe returns true at exactly threshold', () => {
    assert.equal(ArmUnit.isFireRateSafe(V5.FIRE_RATE_INTERLOCK), true);
  });

  it('isFireRateSafe returns false above threshold', () => {
    assert.equal(ArmUnit.isFireRateSafe(V5.FIRE_RATE_INTERLOCK + 0.001), false);
  });

  it('FIRE_RATE_INTERLOCK constant is 0.5°/s in radians', () => {
    assert.closeTo(V5.FIRE_RATE_INTERLOCK, 0.5 * Math.PI / 180, 1e-10);
  });
});

// ============================================================================
// Suite: Tether anchor at strut tip
// ============================================================================
describe('C-3: Tether anchor at strut tip', () => {

  it('getTetherAnchorWorldPosition returns position based on aim alpha', () => {
    const arm = makeConfigGArm(0);
    arm.setAimAlpha(Math.PI / 2); // equatorial
    const motherPos = new THREE.Vector3(0, 0, 0);
    const motherQuat = new THREE.Quaternion();
    const anchor = arm.getTetherAnchorWorldPosition(motherPos, motherQuat);
    assert.ok(anchor instanceof THREE.Vector3, 'returns a Vector3');
    // At equatorial, tip should be outward from hinge (primarily in XZ plane)
    assert.ok(Math.abs(anchor.x) > 0 || Math.abs(anchor.z) > 0, 'anchor has XZ displacement');
  });

  it('anchor at α=0 (stowed) is below hinge (−Y direction)', () => {
    const arm = makeConfigGArm(0);
    arm.setAimAlpha(0);
    const motherPos = new THREE.Vector3(0, 0, 0);
    const motherQuat = new THREE.Quaternion();
    const anchor = arm.getTetherAnchorWorldPosition(motherPos, motherQuat);
    // At α=0, strut points −Y: tip_y = hinge_y − STRUT_LENGTH
    const hingeY = arm._hingePosition.y / M;
    const expectedY = (hingeY / M - V5.STRUT_LENGTH) * M * M; // This is in scene units
    assert.ok(anchor.y < arm._hingePosition.y, 'anchor should be below hinge at α=0');
  });

  it('anchor moves with aim alpha', () => {
    const arm = makeConfigGArm(0);
    const motherPos = new THREE.Vector3(0, 0, 0);
    const motherQuat = new THREE.Quaternion();
    const V5 = Constants.OCTOPUS_V5;
    const L = V5.STRUT_LENGTH;
    const R = V5.COLLAR_RADIUS;
    const CY = V5.COLLAR_Y;
    const azRad = arm._azimuthDeg * Math.PI / 180;

    // Simulate _updateStruts: compute dockOffset in PlayerSatellite local frame
    const computeDockOffset = (alpha) => {
      const sinA = Math.sin(alpha), cosA = Math.cos(alpha);
      const px = Math.cos(azRad) * R * M;
      const py = Math.sin(azRad) * R * M;
      const pz = CY * M;
      return new THREE.Vector3(
        px + sinA * Math.cos(azRad) * L * M,
        py + sinA * Math.sin(azRad) * L * M,
        pz - cosA * L * M,
      );
    };

    arm.setAimAlpha(0);
    arm.dockOffset.copy(computeDockOffset(0));
    const a0 = arm.getTetherAnchorWorldPosition(motherPos, motherQuat);

    arm.setAimAlpha(Math.PI / 2);
    arm.dockOffset.copy(computeDockOffset(Math.PI / 2));
    const a90 = arm.getTetherAnchorWorldPosition(motherPos, motherQuat);

    arm.setAimAlpha(Math.PI);
    arm.dockOffset.copy(computeDockOffset(Math.PI));
    const a180 = arm.getTetherAnchorWorldPosition(motherPos, motherQuat);

    assert.ok(a0.distanceTo(a90) > 0, 'anchor moves between stowed and equatorial');
    assert.ok(a90.distanceTo(a180) > 0, 'anchor moves between equatorial and zenith');
  });

  it('fallback: returns arm.position if no dockOffset', () => {
    const scene = { add: () => {}, remove: () => {} };
    const arm = new ArmUnit('fallback', 'weaver', new THREE.Vector3(M, 0, 0), scene);
    arm.dockOffset = null; // Force fallback path
    arm.position.set(1, 2, 3);
    const anchor = arm.getTetherAnchorWorldPosition(new THREE.Vector3(), new THREE.Quaternion());
    assert.closeTo(anchor.x, 1, 1e-6, 'fallback returns arm position');
  });
});

// ============================================================================
// Suite: decomposeAimTarget math
// ============================================================================
describe('C-3: decomposeAimTarget — two-axis decomposition', () => {

  const docks = generateDockPositions('Y0_QUAD');

  it('target in arm 0 meridian plane → zero mother rotation', () => {
    // Arm 0 at 60°: outward = (cos60°, 0, sin60°)
    const theta = 60 * Math.PI / 180;
    const targetDir = { x: Math.cos(theta), y: 0, z: Math.sin(theta) };
    const result = decomposeAimTarget(targetDir, docks);
    assert.closeTo(result.motherRotationRad, 0, 0.1, 'target in-plane → ~zero rotation');
    assert.closeTo(result.strutAlpha, Math.PI / 2, 0.1, 'equatorial target → α ≈ π/2');
  });

  it('downward target → α near 0', () => {
    const targetDir = { x: 0, y: -1, z: 0 }; // pure −Y
    const result = decomposeAimTarget(targetDir, docks);
    assert.closeTo(result.strutAlpha, 0, 0.1, 'straight down → α ≈ 0');
  });

  it('upward target → α near π', () => {
    const targetDir = { x: 0, y: 1, z: 0 }; // pure +Y
    const result = decomposeAimTarget(targetDir, docks);
    assert.closeTo(result.strutAlpha, Math.PI, 0.1, 'straight up → α ≈ π');
  });

  it('returns valid pairIndex for Y0 Quad', () => {
    const targetDir = { x: 1, y: 0, z: 0 };
    const result = decomposeAimTarget(targetDir, docks);
    assert.ok(result.pairIndex >= 0 && result.pairIndex < 4, 'pairIndex in range');
  });

  it('strutAlpha clamped to [0, π]', () => {
    // Several random directions
    for (let i = 0; i < 10; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI - Math.PI / 2;
      const target = {
        x: Math.cos(phi) * Math.cos(theta),
        y: Math.sin(phi),
        z: Math.cos(phi) * Math.sin(theta),
      };
      const res = decomposeAimTarget(target, docks);
      assert.ok(res.strutAlpha >= 0 && res.strutAlpha <= Math.PI,
        `α=${res.strutAlpha} should be in [0, π]`);
    }
  });

  it('handles empty dockPositions gracefully', () => {
    const result = decomposeAimTarget({ x: 1, y: 0, z: 0 }, []);
    assert.equal(result.pairIndex, 0);
    assert.equal(result.strutAlpha, Math.PI / 2);
  });
});

// ============================================================================
// Suite: fireDualPair gating
// ============================================================================
describe('C-3: fireDualPair — pre-fire gating', () => {

  // We need a minimal ArmManager. Can't construct full one without a real scene/player,
  // so we test the gating logic through the ArmManager method on manually wired arms.
  function makeMinimalArmManager() {
    const scene = { add: () => {}, remove: () => {} };
    const player = { position: new THREE.Vector3(), safeMode: false };
    // Can't construct normally due to PersistenceManager, so build minimal stub
    const mgr = Object.create(ArmManager.prototype);
    mgr.arms = [];
    mgr._dockPositions = generateDockPositions('Y0_QUAD');
    mgr.selectedArmIndex = -1;

    for (let i = 0; i < mgr._dockPositions.length; i++) {
      const dp = mgr._dockPositions[i];
      const arm = new ArmUnit(`arm-${i}`, dp.type, dp.offset, scene);
      arm.index = i;
      arm._hingePosition = dp.hingePosition.clone();
      arm._dockOutward = dp.dockOutward.clone();
      arm._swingAxis = dp.swingAxis.clone();
      arm._azimuthDeg = dp.azimuthDeg;
      arm._isEndFace = dp.isEndFace;
      mgr.arms.push(arm);
    }
    return mgr;
  }

  it('successful fire when both arms DOCKED + DEPLOYED + spring charged', () => {
    const mgr = makeMinimalArmManager();
    eventBus.clear();
    const result = mgr.fireDualPair(0);
    assert.equal(result.success, true, 'should succeed');
  });

  it('rejects when partner arm not DOCKED', () => {
    const mgr = makeMinimalArmManager();
    const partnerIdx = mgr.getDualFirePair(0);
    mgr.arms[partnerIdx].state = Constants.ARM_STATES.TRANSIT;
    eventBus.clear();
    let rejected = null;
    eventBus.on(Events.ARM_DUAL_FIRE_REJECTED, data => { rejected = data; });
    const result = mgr.fireDualPair(0);
    assert.equal(result.success, false);
    assert.ok(result.reason.includes('state'), 'reason mentions state');
    assert.ok(rejected !== null, 'rejection event emitted');
  });

  it('rejects when spring not charged', () => {
    const mgr = makeMinimalArmManager();
    mgr.arms[0].springCharged = false;
    const result = mgr.fireDualPair(0);
    assert.equal(result.success, false);
    assert.ok(result.reason.includes('spring'), 'reason mentions spring');
  });

  it('rejects when mother ω exceeds interlock', () => {
    const mgr = makeMinimalArmManager();
    const highOmega = 1.0 * Math.PI / 180; // 1°/s > 0.5°/s threshold
    eventBus.clear();
    let blocked = null;
    eventBus.on(Events.ARM_FIRE_BLOCKED_HIGH_RATE, data => { blocked = data; });
    const result = mgr.fireDualPair(0, highOmega);
    assert.equal(result.success, false);
    assert.ok(blocked !== null, 'FIRE_BLOCKED_HIGH_RATE emitted');
    assert.ok(blocked.omega > blocked.threshold, 'payload has omega > threshold');
  });

  it('rejects when deploy state is not DEPLOYED', () => {
    // C-4: Must enable STOW_DEPLOY_STATE_MACHINE flag — getDeployState()
    // returns 'DEPLOYED' when flag is OFF regardless of _deployState.
    const prevFlag = Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE;
    Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE = true;
    const mgr = makeMinimalArmManager();
    mgr.arms[0]._deployState = DS.STOWED;
    const result = mgr.fireDualPair(0);
    assert.equal(result.success, false);
    assert.ok(result.reason.includes('Deploy'), 'reason mentions deploy');
    Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE = prevFlag;
  });

  it('rejects for invalid partner (no antipodal)', () => {
    const mgr = makeMinimalArmManager();
    // Corrupt dockPositions to remove partner
    mgr._dockPositions = [mgr._dockPositions[0]]; // only 1 arm → no partner
    const result = mgr.fireDualPair(0);
    assert.equal(result.success, false);
    assert.ok(result.reason.includes('partner'), 'reason mentions partner');
  });

  it('emits DUAL_FIRE and DUAL_FIRE_RECOIL on success', () => {
    const mgr = makeMinimalArmManager();
    eventBus.clear();
    let dualFired = false;
    let recoilEvt = null;
    eventBus.on(Events.DUAL_FIRE, () => { dualFired = true; });
    eventBus.on(Events.DUAL_FIRE_RECOIL, data => { recoilEvt = data; });
    mgr.fireDualPair(0);
    assert.ok(dualFired, 'DUAL_FIRE emitted');
    assert.ok(recoilEvt !== null, 'DUAL_FIRE_RECOIL emitted');
    assert.isType(recoilEvt.residualDv, 'number');
  });

  it('emits ARM_RECOIL_COMPENSATED with rcsN2Used', () => {
    const mgr = makeMinimalArmManager();
    eventBus.clear();
    let compensated = null;
    eventBus.on(Events.ARM_RECOIL_COMPENSATED, data => { compensated = data; });
    mgr.fireDualPair(0);
    assert.ok(compensated !== null, 'ARM_RECOIL_COMPENSATED emitted');
    assert.isType(compensated.rcsN2Used, 'number');
    assert.isType(compensated.residualImpulse, 'number');
  });
});

// ============================================================================
// Suite: getNextDeployRecommendation
// ============================================================================
describe('C-3: getNextDeployRecommendation', () => {

  function makeMinimalArmManager() {
    const scene = { add: () => {}, remove: () => {} };
    const mgr = Object.create(ArmManager.prototype);
    mgr.arms = [];
    mgr._dockPositions = generateDockPositions('Y0_QUAD');

    for (let i = 0; i < mgr._dockPositions.length; i++) {
      const dp = mgr._dockPositions[i];
      const arm = new ArmUnit(`arm-${i}`, dp.type, dp.offset, scene);
      arm.index = i;
      arm._hingePosition = dp.hingePosition.clone();
      arm._dockOutward = dp.dockOutward.clone();
      arm._swingAxis = dp.swingAxis.clone();
      arm._azimuthDeg = dp.azimuthDeg;
      arm._isEndFace = dp.isEndFace;
      mgr.arms.push(arm);
    }
    return mgr;
  }

  it('returns null when no arms deployed', () => {
    const mgr = makeMinimalArmManager();
    const rec = mgr.getNextDeployRecommendation();
    assert.equal(rec, null);
  });

  it('recommends antipodal partner after first deploy', () => {
    const mgr = makeMinimalArmManager();
    mgr.arms[0].state = Constants.ARM_STATES.TRANSIT; // "deployed"
    const rec = mgr.getNextDeployRecommendation();
    assert.ok(rec !== null, 'should recommend');
    const partnerIdx = mgr.getDualFirePair(0);
    assert.equal(rec.armIndex, partnerIdx, 'recommends antipodal partner');
    assert.ok(rec.reason.includes('opposing'), 'reason mentions opposing arm');
  });
});

// ============================================================================
// Suite: Events exist
// ============================================================================
describe('C-3: New events exist in Events.js', () => {

  it('ARM_HINGE_LOCKED exists', () => {
    assert.isType(Events.ARM_HINGE_LOCKED, 'string');
  });

  it('ARM_HINGE_UNLOCKED exists', () => {
    assert.isType(Events.ARM_HINGE_UNLOCKED, 'string');
  });

  it('ARM_DUAL_FIRE_REJECTED exists', () => {
    assert.isType(Events.ARM_DUAL_FIRE_REJECTED, 'string');
  });

  it('ARM_FIRE_BLOCKED_HIGH_RATE exists', () => {
    assert.isType(Events.ARM_FIRE_BLOCKED_HIGH_RATE, 'string');
  });

  it('ARM_RECOIL_COMPENSATED exists', () => {
    assert.isType(Events.ARM_RECOIL_COMPENSATED, 'string');
  });
});

// ============================================================================
// Suite: Constants — C-3 additions
// ============================================================================
describe('C-3: Constants — new recoil/hinge values', () => {

  it('HIGH_RECOIL_ALPHA_LOW is π/6 (30°)', () => {
    assert.closeTo(V5.HIGH_RECOIL_ALPHA_LOW, Math.PI / 6, 1e-10);
  });

  it('HIGH_RECOIL_ALPHA_HIGH is 5π/6 (150°)', () => {
    assert.closeTo(V5.HIGH_RECOIL_ALPHA_HIGH, 5 * Math.PI / 6, 1e-10);
  });

  it('FIRE_RATE_INTERLOCK is 0.5°/s in radians', () => {
    assert.closeTo(V5.FIRE_RATE_INTERLOCK, 0.5 * Math.PI / 180, 1e-12);
  });

  it('HINGE_SETTLE_TIME is a positive number', () => {
    assert.isType(V5.HINGE_SETTLE_TIME, 'number');
    assert.ok(V5.HINGE_SETTLE_TIME > 0);
  });

  it('HINGE_STATES has ROTATE and LOCKED', () => {
    assert.equal(HS.ROTATE, 'ROTATE');
    assert.equal(HS.LOCKED, 'LOCKED');
  });

  it('DEPLOY_STATES has all five states', () => {
    assert.equal(DS.LOCKED, 'LOCKED');
    assert.equal(DS.STOWED, 'STOWED');
    assert.equal(DS.DEPLOYING, 'DEPLOYING');
    assert.equal(DS.DEPLOYED, 'DEPLOYED');
    assert.equal(DS.STOWING, 'STOWING');
  });

  it('SEMI_AUTO_AIM feature flag exists and defaults false', () => {
    assert.equal(Constants.FEATURE_FLAGS.SEMI_AUTO_AIM, false);
  });

  it('LOCKABLE_HINGE feature flag exists and defaults false', () => {
    assert.equal(Constants.FEATURE_FLAGS.LOCKABLE_HINGE, false);
  });
});

// ============================================================================
// Suite: ArmUnit reset clears C-3 state
// ============================================================================
describe('C-3: ArmUnit.reset() clears C-3 state', () => {

  it('reset clears aimAlpha to 0', () => {
    const arm = makeConfigGArm();
    arm.setAimAlpha(Math.PI / 2);
    arm.reset();
    assert.equal(arm.getAimAlpha(), 0);
  });

  it('reset clears hingeState to ROTATE', () => {
    const arm = makeConfigGArm();
    arm._hingeState = HS.LOCKED;
    arm.reset();
    assert.equal(arm.getHingeState(), HS.ROTATE);
  });

  it('reset clears hingeSettleTimer', () => {
    const arm = makeConfigGArm();
    arm._hingeSettleTimer = 5;
    arm.reset();
    assert.equal(arm._hingeSettleTimer, 0);
  });
});

// ============================================================================
// Suite: Recoil compensation — residual nulled within 2 seconds (AC-7)
// ============================================================================
describe('C-3: Recoil compensation — settle within 2 seconds', () => {

  it('HINGE_SETTLE_TIME is < 2 seconds', () => {
    assert.ok(V5.HINGE_SETTLE_TIME < 2,
      `HINGE_SETTLE_TIME (${V5.HINGE_SETTLE_TIME}s) must be < 2s`);
  });

  it('hinge auto-unlocks within 2 seconds after fire (simulated)', () => {
    const arm = makeConfigGArm();
    const prev = Constants.FEATURE_FLAGS.LOCKABLE_HINGE;
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = true;

    // Simulate fire → auto-lock
    arm._autoLockForFire();
    assert.equal(arm.isHingeLocked(), true, 'locked immediately after fire');

    // Simulate update ticks at 60fps for 2 full seconds
    const dt = 1 / 60;
    for (let i = 0; i < 120; i++) {
      arm._tickHingeSettle(dt);
    }

    assert.equal(arm.isHingeLocked(), false,
      'hinge must auto-unlock within 2 seconds of fire');
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = prev;
  });

  it('fireDualPair auto-locks both hinges during fire', () => {
    const scene = { add: () => {}, remove: () => {} };
    const mgr = Object.create(ArmManager.prototype);
    mgr.arms = [];
    mgr._dockPositions = generateDockPositions('Y0_QUAD');
    for (let i = 0; i < mgr._dockPositions.length; i++) {
      const dp = mgr._dockPositions[i];
      const arm = new ArmUnit(`arm-${i}`, dp.type, dp.offset, scene);
      arm.index = i;
      arm._hingePosition = dp.hingePosition.clone();
      arm._dockOutward = dp.dockOutward.clone();
      arm._swingAxis = dp.swingAxis.clone();
      arm._azimuthDeg = dp.azimuthDeg;
      arm._isEndFace = dp.isEndFace;
      mgr.arms.push(arm);
    }
    const prev = Constants.FEATURE_FLAGS.LOCKABLE_HINGE;
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = true;
    eventBus.clear();

    mgr.fireDualPair(0);

    const partnerIdx = mgr.getDualFirePair(0);
    // Both hinges should be locked (auto-lock for fire)
    assert.equal(mgr.arms[0].isHingeLocked(), true, 'arm 0 hinge locked after fire');
    assert.equal(mgr.arms[partnerIdx].isHingeLocked(), true, 'partner hinge locked after fire');

    // After settle time, both should auto-unlock
    for (let i = 0; i < 60; i++) {
      mgr.arms[0]._tickHingeSettle(1 / 60);
      mgr.arms[partnerIdx]._tickHingeSettle(1 / 60);
    }
    assert.equal(mgr.arms[0].isHingeLocked(), false, 'arm 0 auto-unlocked after settle');
    assert.equal(mgr.arms[partnerIdx].isHingeLocked(), false, 'partner auto-unlocked after settle');

    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = prev;
  });
});

// ============================================================================
// Suite: Tether anchor migration to strut tip
// ============================================================================
describe('C-3: Tether anchor — _updateTether uses strut tip', () => {

  it('_updateTether accepts parentQuat without error', () => {
    const arm = makeConfigGArm(0);
    arm.state = Constants.ARM_STATES.TRANSIT;
    arm.isDetached = false;
    arm.position.set(0.001, 0, 0);
    arm.tetherLength = arm.config.tetherMax * 0.5;
    const motherPos = new THREE.Vector3(0, 0, 0);
    const motherQuat = new THREE.Quaternion();
    // Should not throw
    arm._updateTether(motherPos, motherQuat);
    assert.ok(true, '_updateTether with parentQuat did not throw');
  });

  it('_updateTether without parentQuat falls back gracefully', () => {
    const arm = makeConfigGArm(0);
    arm.state = Constants.ARM_STATES.TRANSIT;
    arm.isDetached = false;
    arm.position.set(0.001, 0, 0);
    arm.tetherLength = arm.config.tetherMax * 0.5;
    const motherPos = new THREE.Vector3(0, 0, 0);
    // Should not throw (backward compat)
    arm._updateTether(motherPos);
    assert.ok(true, '_updateTether without parentQuat did not throw');
  });
});
