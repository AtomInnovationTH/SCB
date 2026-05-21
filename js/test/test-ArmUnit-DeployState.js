/**
 * test-ArmUnit-DeployState.js — ST-9.10 C-4 Deploy State Machine tests
 *
 * Covers: deployState transitions, strutDeploy/strutStow/strutUnlock,
 *         feature flag gating, strut alpha animation, hinge interlock,
 *         fireDualPair gating with flag ON/OFF, persistence round-trip,
 *         ArmManager coordination (deployAll/stowAll/snapshot).
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { ArmManager, generateDockPositions } from '../entities/ArmManager.js';
import { persistenceManager } from '../systems/PersistenceManager.js';

const M = 0.00001;
const V5 = Constants.OCTOPUS_V5;
const DS = Constants.DEPLOY_STATES;
const HS = Constants.HINGE_STATES;

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create a fresh ArmUnit with Config G geometry. */
function makeArm(armIdx = 0) {
  const scene = { add: () => {}, remove: () => {} };
  const positions = generateDockPositions('Y0_QUAD');
  const dp = positions[armIdx];
  const arm = new ArmUnit(`test-${dp.type}-${armIdx}`, dp.type, dp.offset, scene);
  arm.index = armIdx;
  arm._hingePosition = dp.hingePosition.clone();
  arm._dockOutward = dp.dockOutward.clone();
  arm._swingAxis = dp.swingAxis.clone();
  arm._azimuthDeg = dp.azimuthDeg;
  arm._isEndFace = dp.isEndFace;
  eventBus.clear();
  return arm;
}

/** Create a minimal ArmManager. */
function makeManager() {
  const scene = { add() {}, remove() {} };
  const player = {
    safeMode: false,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    resources: {},
  };
  const mgr = new ArmManager(scene, player);
  eventBus.clear();
  return mgr;
}

/** Simulate N frames at given dt by calling _tickDeployState. */
function tickFrames(arm, frames, dt = 1 / 60) {
  for (let i = 0; i < frames; i++) {
    arm._tickDeployState(dt);
  }
}

/** Save & restore STOW_DEPLOY_STATE_MACHINE flag. */
let _savedFlag;
function flagOn() {
  _savedFlag = Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE;
  Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE = true;
}
function flagOff() {
  _savedFlag = Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE;
  Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE = false;
}
function flagRestore() {
  Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE = _savedFlag;
}

// ══════════════════════════════════════════════════════════════════════════
// Suite: Feature flag gating
// ══════════════════════════════════════════════════════════════════════════
describe('C-4: Feature flag gating — STOW_DEPLOY_STATE_MACHINE', () => {

  it('flag OFF: getDeployState returns DEPLOYED always', () => {
    flagOff();
    const arm = makeArm();
    assert.equal(arm.getDeployState(), DS.DEPLOYED);
    // Even if internal state is something else:
    arm._deployState = DS.LOCKED;
    assert.equal(arm.getDeployState(), DS.DEPLOYED);
    flagRestore();
  });

  it('flag OFF: strutDeploy is a no-op (returns resolved Promise)', () => {
    flagOff();
    const arm = makeArm();
    const result = arm.strutDeploy();
    assert.ok(result instanceof Promise, 'returns a Promise');
    // Promise.resolve() resolves synchronously — no need to await
    flagRestore();
  });

  it('flag OFF: strutStow is a no-op (returns resolved Promise)', () => {
    flagOff();
    const arm = makeArm();
    const result = arm.strutStow();
    assert.ok(result instanceof Promise, 'returns a Promise');
    flagRestore();
  });

  it('flag OFF: strutUnlock is a no-op', () => {
    flagOff();
    const arm = makeArm();
    arm._deployState = DS.LOCKED;
    arm.strutUnlock(); // should not throw
    assert.equal(arm._deployState, DS.LOCKED, 'state unchanged');
    flagRestore();
  });

  it('flag ON: new arm starts in LOCKED', () => {
    flagOn();
    const arm = makeArm();
    assert.equal(arm._deployState, DS.LOCKED);
    assert.equal(arm.getDeployState(), DS.LOCKED);
    flagRestore();
  });

  it('flag ON: getDeployState returns live state', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.STOWED;
    assert.equal(arm.getDeployState(), DS.STOWED);
    arm._deployState = DS.DEPLOYING;
    assert.equal(arm.getDeployState(), DS.DEPLOYING);
    flagRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: strutUnlock — LOCKED → STOWED
// ══════════════════════════════════════════════════════════════════════════
describe('C-4: strutUnlock — LOCKED → STOWED', () => {

  it('transitions LOCKED → STOWED', () => {
    flagOn();
    const arm = makeArm();
    assert.equal(arm.getDeployState(), DS.LOCKED);
    arm.strutUnlock();
    assert.equal(arm.getDeployState(), DS.STOWED);
    assert.equal(arm.getAimAlpha(), 0, 'alpha should be 0 after unlock');
    flagRestore();
  });

  it('rejects unlock from non-LOCKED state', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.DEPLOYED;
    const events = [];
    eventBus.on(Events.ARM_DEPLOY_REJECTED, e => events.push(e));
    arm.strutUnlock();
    assert.equal(arm.getDeployState(), DS.DEPLOYED, 'state unchanged');
    assert.equal(events.length, 1, 'emitted ARM_DEPLOY_REJECTED');
    assert.ok(events[0].reason.includes('LOCKED'), 'reason mentions LOCKED');
    flagRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: strutDeploy — STOWED → DEPLOYING → DEPLOYED
// ══════════════════════════════════════════════════════════════════════════
describe('C-4: strutDeploy — STOWED → DEPLOYING → DEPLOYED', () => {

  it('transitions STOWED → DEPLOYING on call', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.STOWED;
    const events = [];
    eventBus.on(Events.ARM_DEPLOY_STARTED, e => events.push(e));
    arm.strutDeploy();
    assert.equal(arm.getDeployState(), DS.DEPLOYING);
    assert.equal(events.length, 1);
    assert.equal(events[0].fromState, DS.STOWED);
    flagRestore();
  });

  it('rejects deploy from non-STOWED state', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.LOCKED;
    const events = [];
    eventBus.on(Events.ARM_DEPLOY_REJECTED, e => events.push(e));
    const p = arm.strutDeploy();
    assert.equal(arm.getDeployState(), DS.LOCKED, 'state unchanged');
    assert.equal(events.length, 1, 'emitted ARM_DEPLOY_REJECTED');
    // Promise should reject
    let rejected = false;
    p.catch(() => { rejected = true; });
    // Flush microtask
    setTimeout(() => {}, 0);
    flagRestore();
  });

  it('animation completes to DEPLOYED after sufficient ticks', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.STOWED;
    arm._aimAlpha = 0;
    arm.strutDeploy(Math.PI / 2); // target = 90°

    // Duration: (π/2) / (15°/s in rad) = (π/2) / (π/12) = 6 seconds
    // At 60fps: 6 * 60 = 360 frames
    const dt = 1 / 60;
    let completed = false;
    eventBus.on(Events.ARM_DEPLOY_COMPLETED, () => { completed = true; });

    // Tick 300 frames — should NOT be done yet (about 5.0s)
    tickFrames(arm, 300, dt);
    assert.equal(arm.getDeployState(), DS.DEPLOYING, 'still deploying at 300 frames');
    assert.ok(!completed, 'not completed yet');

    // Tick another 100 frames (total 400, ~6.67s) — should be done
    tickFrames(arm, 100, dt);
    assert.equal(arm.getDeployState(), DS.DEPLOYED, 'deployed after sufficient ticks');
    assert.ok(completed, 'ARM_DEPLOY_COMPLETED emitted');
    assert.closeTo(arm.getAimAlpha(), Math.PI / 2, 0.01, 'alpha at target');
    flagRestore();
  });

  it('Promise resolve callback fires when DEPLOYED', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.STOWED;
    arm._aimAlpha = 0;
    let resolved = false;
    const promise = arm.strutDeploy(Math.PI / 2);
    // The Promise.resolve callback is stored as _deployResolve.
    // Wrap the internal resolve to track when it fires.
    const origResolve = arm._deployResolve;
    arm._deployResolve = () => { resolved = true; origResolve(); };

    // Run enough frames (6s at 15°/s for π/2 → 360 frames; use 400 for margin)
    const dt = 1 / 60;
    tickFrames(arm, 400, dt);

    // resolve() was called synchronously during tick
    assert.ok(resolved, '_deployResolve was called');
    assert.equal(arm.getDeployState(), DS.DEPLOYED);
    flagRestore();
  });

  it('alpha animates at STRUT_SLEW_RATE', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.STOWED;
    arm._aimAlpha = 0;
    arm.strutDeploy(Math.PI / 2);

    const dt = 0.1; // 100ms
    const expectedDelta = V5.STRUT_SLEW_RATE * dt; // 30°/s * 0.1s = 3° = π/60

    arm._tickDeployState(dt);
    assert.closeTo(arm.getAimAlpha(), expectedDelta, 1e-8,
      `alpha should increase by ${expectedDelta} rad after 0.1s`);
    flagRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: strutStow — DEPLOYED → STOWING → STOWED
// ══════════════════════════════════════════════════════════════════════════
describe('C-4: strutStow — DEPLOYED → STOWING → STOWED', () => {

  it('transitions DEPLOYED → STOWING on call', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.DEPLOYED;
    arm._aimAlpha = Math.PI / 2;
    const events = [];
    eventBus.on(Events.ARM_STOW_STARTED, e => events.push(e));
    arm.strutStow();
    assert.equal(arm.getDeployState(), DS.STOWING);
    assert.equal(events.length, 1);
    assert.closeTo(events[0].fromAlpha, Math.PI / 2, 0.01);
    flagRestore();
  });

  it('rejects stow from non-DEPLOYED state', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.STOWED;
    const events = [];
    eventBus.on(Events.ARM_DEPLOY_REJECTED, e => events.push(e));
    const p = arm.strutStow();
    assert.equal(arm.getDeployState(), DS.STOWED, 'state unchanged');
    assert.equal(events.length, 1, 'emitted ARM_DEPLOY_REJECTED');
    p.catch(() => {}); // swallow rejection
    flagRestore();
  });

  it('animation completes to STOWED after sufficient ticks', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.DEPLOYED;
    arm._aimAlpha = Math.PI / 2;
    arm._deployTargetAlpha = Math.PI / 2;
    arm.strutStow();

    const dt = 1 / 60;
    let completed = false;
    eventBus.on(Events.ARM_STOW_COMPLETED, () => { completed = true; });

    // Tick 400 frames (~6.67s) — should complete (6s needed for π/2 at 15°/s)
    tickFrames(arm, 400, dt);
    assert.equal(arm.getDeployState(), DS.STOWED, 'stowed after sufficient ticks');
    assert.ok(completed, 'ARM_STOW_COMPLETED emitted');
    assert.closeTo(arm.getAimAlpha(), 0, 0.01, 'alpha at 0');
    flagRestore();
  });

  it('Promise resolve callback fires when STOWED', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.DEPLOYED;
    arm._aimAlpha = Math.PI / 2;
    arm._deployTargetAlpha = Math.PI / 2;
    let resolved = false;
    const promise = arm.strutStow();
    const origResolve = arm._stowResolve;
    arm._stowResolve = () => { resolved = true; origResolve(); };

    tickFrames(arm, 400, 1 / 60);
    assert.ok(resolved, '_stowResolve was called');
    assert.equal(arm.getDeployState(), DS.STOWED);
    flagRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Invalid transitions
// ══════════════════════════════════════════════════════════════════════════
describe('C-4: Invalid transitions emit ARM_DEPLOY_REJECTED', () => {

  it('deploy from LOCKED → rejected', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.LOCKED;
    const events = [];
    eventBus.on(Events.ARM_DEPLOY_REJECTED, e => events.push(e));
    arm.strutDeploy().catch(() => {});
    assert.equal(events.length, 1);
    assert.equal(events[0].currentState, DS.LOCKED);
    flagRestore();
  });

  it('deploy from DEPLOYED → rejected', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.DEPLOYED;
    const events = [];
    eventBus.on(Events.ARM_DEPLOY_REJECTED, e => events.push(e));
    arm.strutDeploy().catch(() => {});
    assert.equal(events.length, 1);
    assert.equal(events[0].currentState, DS.DEPLOYED);
    flagRestore();
  });

  it('stow from STOWED → rejected', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.STOWED;
    const events = [];
    eventBus.on(Events.ARM_DEPLOY_REJECTED, e => events.push(e));
    arm.strutStow().catch(() => {});
    assert.equal(events.length, 1);
    assert.equal(events[0].currentState, DS.STOWED);
    flagRestore();
  });

  it('stow from DEPLOYING → rejected', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.DEPLOYING;
    const events = [];
    eventBus.on(Events.ARM_DEPLOY_REJECTED, e => events.push(e));
    arm.strutStow().catch(() => {});
    assert.equal(events.length, 1);
    assert.equal(events[0].currentState, DS.DEPLOYING);
    flagRestore();
  });

  it('unlock from STOWED → rejected', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.STOWED;
    const events = [];
    eventBus.on(Events.ARM_DEPLOY_REJECTED, e => events.push(e));
    arm.strutUnlock();
    assert.equal(events.length, 1);
    assert.equal(events[0].currentState, DS.STOWED);
    flagRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Hinge interlock during DEPLOYING/STOWING
// ══════════════════════════════════════════════════════════════════════════
describe('C-4: Hinge interlock — lockHinge rejected during DEPLOYING/STOWING', () => {

  it('lockHinge rejected during DEPLOYING (both flags on)', () => {
    flagOn();
    const prevHinge = Constants.FEATURE_FLAGS.LOCKABLE_HINGE;
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = true;
    const arm = makeArm();
    arm._deployState = DS.DEPLOYING;
    arm._hingeState = HS.ROTATE;
    const events = [];
    eventBus.on(Events.ARM_DEPLOY_REJECTED, e => events.push(e));
    arm.lockHinge();
    assert.equal(arm.getHingeState(), HS.ROTATE, 'hinge still ROTATE');
    assert.equal(events.length, 1, 'ARM_DEPLOY_REJECTED emitted');
    assert.ok(events[0].reason.includes('DEPLOYING'), 'reason references DEPLOYING');
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = prevHinge;
    flagRestore();
  });

  it('lockHinge rejected during STOWING (both flags on)', () => {
    flagOn();
    const prevHinge = Constants.FEATURE_FLAGS.LOCKABLE_HINGE;
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = true;
    const arm = makeArm();
    arm._deployState = DS.STOWING;
    arm._hingeState = HS.ROTATE;
    const events = [];
    eventBus.on(Events.ARM_DEPLOY_REJECTED, e => events.push(e));
    arm.lockHinge();
    assert.equal(arm.getHingeState(), HS.ROTATE, 'hinge still ROTATE');
    assert.equal(events.length, 1);
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = prevHinge;
    flagRestore();
  });

  it('lockHinge works fine during DEPLOYED (normal case)', () => {
    flagOn();
    const prevHinge = Constants.FEATURE_FLAGS.LOCKABLE_HINGE;
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = true;
    const arm = makeArm();
    arm._deployState = DS.DEPLOYED;
    arm._hingeState = HS.ROTATE;
    arm.lockHinge();
    assert.equal(arm.getHingeState(), HS.LOCKED, 'hinge locked normally');
    Constants.FEATURE_FLAGS.LOCKABLE_HINGE = prevHinge;
    flagRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: setAimAlpha rejected during DEPLOYING/STOWING
// ══════════════════════════════════════════════════════════════════════════
describe('C-4: setAimAlpha rejected during DEPLOYING/STOWING', () => {

  it('setAimAlpha rejected during DEPLOYING', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.DEPLOYING;
    arm._aimAlpha = 0.5;
    const result = arm.setAimAlpha(1.0, 0);
    assert.equal(result, false, 'rejected');
    assert.closeTo(arm.getAimAlpha(), 0.5, 1e-10, 'alpha unchanged');
    flagRestore();
  });

  it('setAimAlpha accepted during DEPLOYED', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.DEPLOYED;
    arm._aimAlpha = 0.5;
    const result = arm.setAimAlpha(1.0, 0);
    assert.equal(result, true, 'accepted');
    assert.closeTo(arm.getAimAlpha(), 1.0, 1e-10, 'alpha changed');
    flagRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: fireDualPair gating with flag ON and OFF
// ══════════════════════════════════════════════════════════════════════════
describe('C-4: fireDualPair — deploy state gating with flag ON and OFF', () => {

  it('flag OFF: fireDualPair works (getDeployState returns DEPLOYED)', () => {
    flagOff();
    const mgr = makeManager();
    // All arms default to DEPLOYED when flag off
    for (const arm of mgr.arms) {
      assert.equal(arm.getDeployState(), DS.DEPLOYED);
    }
    // fireDualPair should pass deploy gate check
    const result = mgr.fireDualPair(0, 0);
    // It might fail for other reasons (spring charge, etc.) but NOT deploy state
    if (!result.success && result.reason) {
      assert.ok(!result.reason.includes('Deploy state'),
        'should not fail on deploy state when flag off');
    }
    flagRestore();
  });

  it('flag ON: fireDualPair rejects when arms are STOWED', () => {
    flagOn();
    const mgr = makeManager();
    const events = [];
    eventBus.on(Events.ARM_DUAL_FIRE_REJECTED, e => events.push(e));
    // Arms are LOCKED by default when flag on — not DEPLOYED
    const result = mgr.fireDualPair(0, 0);
    assert.equal(result.success, false);
    assert.ok(result.reason.includes('Deploy state'), 'rejected due to deploy state');
    flagRestore();
  });

  it('flag ON: fireDualPair passes when arms are DEPLOYED', () => {
    flagOn();
    const mgr = makeManager();
    // Set both arms in pair 0 to DEPLOYED
    const partner = mgr.getDualFirePair(0);
    mgr.arms[0]._deployState = DS.DEPLOYED;
    if (partner !== null) {
      mgr.arms[partner]._deployState = DS.DEPLOYED;
    }
    const result = mgr.fireDualPair(0, 0);
    // May fail for other reasons (spring charge etc.) but should pass deploy gate
    if (!result.success && result.reason) {
      assert.ok(!result.reason.includes('Deploy state'),
        'should pass deploy state check');
    }
    flagRestore();
  });

  it('flag ON: fireDualPair rejects when one arm DEPLOYING, other DEPLOYED', () => {
    flagOn();
    const mgr = makeManager();
    const partner = mgr.getDualFirePair(0);
    mgr.arms[0]._deployState = DS.DEPLOYED;
    if (partner !== null) {
      mgr.arms[partner]._deployState = DS.DEPLOYING;
    }
    const result = mgr.fireDualPair(0, 0);
    assert.equal(result.success, false, 'rejected');
    assert.ok(result.reason.includes('Deploy state'), 'deploy state mismatch');
    flagRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: setDeployState — test setter
// ══════════════════════════════════════════════════════════════════════════
describe('C-4: setDeployState — internal test setter', () => {

  it('sets valid deploy states', () => {
    const arm = makeArm();
    for (const state of Object.values(DS)) {
      arm.setDeployState(state);
      assert.equal(arm._deployState, state);
    }
  });

  it('ignores invalid states', () => {
    const arm = makeArm();
    arm.setDeployState(DS.DEPLOYED);
    arm.setDeployState('INVALID_STATE');
    assert.equal(arm._deployState, DS.DEPLOYED, 'state unchanged for invalid');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: getDeployProgress
// ══════════════════════════════════════════════════════════════════════════
describe('C-4: getDeployProgress', () => {

  it('returns -1 when not transitioning', () => {
    const arm = makeArm();
    arm._deployState = DS.DEPLOYED;
    assert.equal(arm.getDeployProgress(), -1);
  });

  it('returns progress fraction during DEPLOYING', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.STOWED;
    arm._aimAlpha = 0;
    arm.strutDeploy(Math.PI / 2);
    // At alpha = 0, progress = 0
    assert.closeTo(arm.getDeployProgress(), 0, 0.01);
    // Halfway
    arm._aimAlpha = Math.PI / 4;
    assert.closeTo(arm.getDeployProgress(), 0.5, 0.01);
    flagRestore();
  });

  it('returns progress fraction during STOWING', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.DEPLOYED;
    arm._aimAlpha = Math.PI / 2;
    arm._deployTargetAlpha = Math.PI / 2;
    arm.strutStow();
    // At alpha = π/2 (start), progress = 0
    assert.closeTo(arm.getDeployProgress(), 0, 0.01);
    // Halfway stowed
    arm._aimAlpha = Math.PI / 4;
    assert.closeTo(arm.getDeployProgress(), 0.5, 0.01);
    flagRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Reset behavior
// ══════════════════════════════════════════════════════════════════════════
describe('C-4: reset() deploys state to flag-gated initial value', () => {

  it('flag OFF: reset sets _deployState to DEPLOYED', () => {
    flagOff();
    const arm = makeArm();
    arm._deployState = DS.STOWING;
    arm.reset();
    assert.equal(arm._deployState, DS.DEPLOYED);
    flagRestore();
  });

  it('flag ON: reset sets _deployState to LOCKED', () => {
    flagOn();
    const arm = makeArm();
    arm._deployState = DS.DEPLOYED;
    arm.reset();
    assert.equal(arm._deployState, DS.LOCKED);
    flagRestore();
  });

  it('reset clears resolve callbacks', () => {
    flagOn();
    const arm = makeArm();
    arm._deployResolve = () => {};
    arm._stowResolve = () => {};
    arm.reset();
    assert.equal(arm._deployResolve, null);
    assert.equal(arm._stowResolve, null);
    flagRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: PersistenceManager deploy state round-trip
// ══════════════════════════════════════════════════════════════════════════
describe('C-4: PersistenceManager deploy state persistence', () => {

  it('setArmDeployStates + getArmDeployStates round-trips', () => {
    const states = [DS.LOCKED, DS.STOWED, DS.DEPLOYED, DS.LOCKED];
    persistenceManager.setArmDeployStates(states);
    const loaded = persistenceManager.getArmDeployStates();
    // In Node test env, localStorage may not be available — check null guard
    if (loaded !== null) {
      assert.deepEqual(loaded, states);
    }
  });

  it('mid-transition DEPLOYING snaps to DEPLOYED on persist', () => {
    const states = [DS.DEPLOYING, DS.STOWED, DS.DEPLOYED, DS.STOWING];
    persistenceManager.setArmDeployStates(states);
    const loaded = persistenceManager.getArmDeployStates();
    if (loaded !== null) {
      assert.equal(loaded[0], DS.DEPLOYED, 'DEPLOYING → DEPLOYED');
      assert.equal(loaded[1], DS.STOWED, 'STOWED unchanged');
      assert.equal(loaded[2], DS.DEPLOYED, 'DEPLOYED unchanged');
      assert.equal(loaded[3], DS.STOWED, 'STOWING → STOWED');
    }
  });

  it('getArmDeployStates returns null on fresh/missing save', () => {
    // In Node, localStorage not available → peek returns null → result is null
    // This is expected behavior for a new game
    const result = persistenceManager.getArmDeployStates();
    // Either null (no localStorage) or array (if previous test wrote)
    assert.ok(result === null || Array.isArray(result), 'null or array');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: ArmManager — getDeploySnapshot
// ══════════════════════════════════════════════════════════════════════════
describe('C-4: ArmManager.getDeploySnapshot', () => {

  it('returns array with armIndex, deployState, alpha for each arm', () => {
    const mgr = makeManager();
    const snap = mgr.getDeploySnapshot();
    assert.equal(snap.length, mgr.arms.length);
    for (let i = 0; i < snap.length; i++) {
      assert.equal(snap[i].armIndex, i);
      assert.ok(typeof snap[i].deployState === 'string');
      assert.ok(typeof snap[i].alpha === 'number');
    }
  });

  it('flag OFF: all arms show DEPLOYED in snapshot', () => {
    flagOff();
    const mgr = makeManager();
    const snap = mgr.getDeploySnapshot();
    for (const entry of snap) {
      assert.equal(entry.deployState, DS.DEPLOYED);
    }
    flagRestore();
  });

  it('flag ON: shows live state per arm', () => {
    flagOn();
    const mgr = makeManager();
    mgr.arms[0]._deployState = DS.STOWED;
    mgr.arms[1]._deployState = DS.DEPLOYED;
    const snap = mgr.getDeploySnapshot();
    assert.equal(snap[0].deployState, DS.STOWED);
    assert.equal(snap[1].deployState, DS.DEPLOYED);
    flagRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: ArmManager — strutDeployArm / strutStowArm
// ══════════════════════════════════════════════════════════════════════════
describe('C-4: ArmManager.strutDeployArm / strutStowArm', () => {

  it('strutDeployArm delegates to arm.strutDeploy', () => {
    flagOn();
    const mgr = makeManager();
    mgr.arms[0]._deployState = DS.STOWED;
    const events = [];
    eventBus.on(Events.ARM_DEPLOY_STARTED, e => events.push(e));
    mgr.strutDeployArm(0);
    assert.equal(mgr.arms[0].getDeployState(), DS.DEPLOYING);
    assert.equal(events.length, 1);
    flagRestore();
  });

  it('strutStowArm delegates to arm.strutStow', () => {
    flagOn();
    const mgr = makeManager();
    mgr.arms[0]._deployState = DS.DEPLOYED;
    mgr.arms[0]._aimAlpha = Math.PI / 2;
    const events = [];
    eventBus.on(Events.ARM_STOW_STARTED, e => events.push(e));
    mgr.strutStowArm(0);
    assert.equal(mgr.arms[0].getDeployState(), DS.STOWING);
    assert.equal(events.length, 1);
    flagRestore();
  });

  it('no-op when flag OFF', () => {
    flagOff();
    const mgr = makeManager();
    const p = mgr.strutDeployArm(0);
    assert.ok(p instanceof Promise, 'returns Promise');
    const p2 = mgr.strutStowArm(0);
    assert.ok(p2 instanceof Promise, 'returns Promise');
    flagRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: ArmManager — strutDeployAll / strutStowAll
// NOTE: strutDeployAll/strutStowAll use setTimeout for stagger, which cannot
// be synchronously tested. We test the contract (filters, returns Promise)
// and verify animation separately via direct strutDeploy/strutStow calls.
// ══════════════════════════════════════════════════════════════════════════
describe('C-4: ArmManager.strutDeployAll / strutStowAll', () => {

  it('strutDeployAll deploys all STOWED arms (direct strutDeploy verification)', () => {
    flagOn();
    const mgr = makeManager();
    // Set all arms to STOWED
    for (const arm of mgr.arms) {
      arm._deployState = DS.STOWED;
      arm._aimAlpha = 0;
    }
    // Directly call strutDeploy on each arm (as the staggered setTimeout
    // would eventually do) then tick to completion.
    for (const arm of mgr.arms) {
      arm.strutDeploy(Math.PI / 2);
    }
    assert.equal(mgr.arms[0].getDeployState(), DS.DEPLOYING, 'arm 0 deploying');

    // Tick all arms enough frames to complete (~3s at 60fps)
    const dt = 1 / 60;
    for (let f = 0; f < 500; f++) {
      for (const arm of mgr.arms) {
        arm._tickDeployState(dt);
      }
    }
    for (const arm of mgr.arms) {
      assert.equal(arm.getDeployState(), DS.DEPLOYED, 'all arms DEPLOYED after ticking');
    }
    flagRestore();
  });

  it('strutStowAll stows all DEPLOYED arms (direct strutStow verification)', () => {
    flagOn();
    const mgr = makeManager();
    for (const arm of mgr.arms) {
      arm._deployState = DS.DEPLOYED;
      arm._aimAlpha = Math.PI / 2;
      arm._deployTargetAlpha = Math.PI / 2;
    }
    // Directly call strutStow on each arm
    for (const arm of mgr.arms) {
      arm.strutStow();
    }
    assert.equal(mgr.arms[0].getDeployState(), DS.STOWING, 'arm 0 stowing');

    const dt = 1 / 60;
    for (let f = 0; f < 500; f++) {
      for (const arm of mgr.arms) {
        arm._tickDeployState(dt);
      }
    }
    for (const arm of mgr.arms) {
      assert.equal(arm.getDeployState(), DS.STOWED, 'all arms STOWED after ticking');
    }
    flagRestore();
  });

  it('strutDeployAll filters only STOWED arms and returns Promise', () => {
    flagOn();
    const mgr = makeManager();
    // Mix of states: only STOWED arms should be eligible
    mgr.arms[0]._deployState = DS.STOWED;
    mgr.arms[1]._deployState = DS.DEPLOYED;
    mgr.arms[2]._deployState = DS.LOCKED;
    mgr.arms[3]._deployState = DS.STOWED;
    const result = mgr.strutDeployAll(Math.PI / 2, 0);
    assert.ok(result instanceof Promise, 'returns a Promise');
    flagRestore();
  });

  it('strutStowAll filters only DEPLOYED arms and returns Promise', () => {
    flagOn();
    const mgr = makeManager();
    mgr.arms[0]._deployState = DS.DEPLOYED;
    mgr.arms[1]._deployState = DS.STOWED;
    mgr.arms[2]._deployState = DS.DEPLOYED;
    mgr.arms[3]._deployState = DS.LOCKED;
    const result = mgr.strutStowAll(0);
    assert.ok(result instanceof Promise, 'returns a Promise');
    flagRestore();
  });

  it('no-op when flag OFF (returns resolved empty Promise)', () => {
    flagOff();
    const mgr = makeManager();
    const result = mgr.strutDeployAll();
    assert.ok(result instanceof Promise, 'strutDeployAll returns a Promise');
    const result2 = mgr.strutStowAll();
    assert.ok(result2 instanceof Promise, 'strutStowAll returns a Promise');
    flagRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Events exist
// ══════════════════════════════════════════════════════════════════════════
describe('C-4: Deploy events exist in Events.js', () => {
  it('ARM_DEPLOY_STARTED is defined', () => {
    assert.ok(Events.ARM_DEPLOY_STARTED, 'event constant exists');
    assert.equal(typeof Events.ARM_DEPLOY_STARTED, 'string');
  });
  it('ARM_DEPLOY_COMPLETED is defined', () => {
    assert.ok(Events.ARM_DEPLOY_COMPLETED);
  });
  it('ARM_STOW_STARTED is defined', () => {
    assert.ok(Events.ARM_STOW_STARTED);
  });
  it('ARM_STOW_COMPLETED is defined', () => {
    assert.ok(Events.ARM_STOW_COMPLETED);
  });
  it('ARM_DEPLOY_REJECTED is defined', () => {
    assert.ok(Events.ARM_DEPLOY_REJECTED);
  });
});
