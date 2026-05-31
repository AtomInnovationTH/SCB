/**
 * test-RotationLock.js — FIX_PLAN §3 rotation-lock tier tests
 *
 * Verifies:
 *   1. State→tier mapping for every ARM_STATES value (§3.1 table)
 *   2. isDetached overrides any state → tier 'none'
 *   3. Multi-arm escalation: soft + block → 'block'
 *   4. hasTetheredArm() reports correctly
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { ArmManager } from '../entities/ArmManager.js';

const S = Constants.ARM_STATES;

// ── Helper ───────────────────────────────────────────────────────────────

/** Minimal ArmManager stub (no scene geometry, no physics). */
function makeManager() {
  const scene  = { add() {}, remove() {} };
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

/**
 * Force the first arm in an ArmManager to `state` and `isDetached`.
 * Returns the manager for chaining.
 */
function withArmState(mgr, state, isDetached = false) {
  const arm = mgr.arms[0];
  arm.state      = state;
  arm.isDetached = isDetached;
  return mgr;
}

// ══════════════════════════════════════════════════════════════════════════
// Suite 1 — 'none' tier states (in-pocket / gone)
// ══════════════════════════════════════════════════════════════════════════
describe('RotationLock — tier=none states', () => {
  const noneStates = [S.DOCKED, S.RELOADING, S.EXPENDED];

  for (const state of noneStates) {
    it(`${state} → tier 'none'`, () => {
      const mgr = withArmState(makeManager(), state);
      assert.equal(mgr.getRotationLockTier(), 'none',
        `${state} arm should not constrain rotation`);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 2 — 'soft' tier states
// ══════════════════════════════════════════════════════════════════════════
describe('RotationLock — tier=soft states', () => {
  const softStates = [
    S.UNDOCKING, S.LAUNCHING, S.WEB_SHOT,
    S.TRANSIT, S.APPROACH,
    S.FISHING, S.TRAWLING,
    S.SCANNING, S.ABLATING,
  ];

  for (const state of softStates) {
    it(`${state} → tier 'soft'`, () => {
      const mgr = withArmState(makeManager(), state);
      assert.equal(mgr.getRotationLockTier(), 'soft',
        `${state} arm should soft-cap rotation`);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 3 — 'block' tier states
// ══════════════════════════════════════════════════════════════════════════
describe('RotationLock — tier=block states', () => {
  const blockStates = [
    S.NETTING,
    S.GRAPPLED, S.STATION_KEEP,
    S.REELING,  S.HAULING,
    S.RETURNING, S.DOCKING,
    S.TANGLED,   S.DEORBITING,
  ];

  for (const state of blockStates) {
    it(`${state} → tier 'block'`, () => {
      const mgr = withArmState(makeManager(), state);
      assert.equal(mgr.getRotationLockTier(), 'block',
        `${state} arm should hard-block rotation`);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 4 — isDetached overrides
// ══════════════════════════════════════════════════════════════════════════
describe('RotationLock — isDetached overrides any state → none', () => {
  // A detached arm has its tether severed — no shear risk regardless of state.
  const representativeStates = [
    S.TRANSIT, S.GRAPPLED, S.REELING, S.STATION_KEEP, S.HAULING,
  ];

  for (const state of representativeStates) {
    it(`${state} with isDetached=true → tier 'none'`, () => {
      const mgr = withArmState(makeManager(), state, /* isDetached= */ true);
      assert.equal(mgr.getRotationLockTier(), 'none',
        `detached arm in ${state} should not constrain rotation`);
    });
  }

  it('all arms detached → tier none even if states are block', () => {
    const mgr = makeManager();
    for (const arm of mgr.arms) {
      arm.state      = S.GRAPPLED;
      arm.isDetached = true;
    }
    assert.equal(mgr.getRotationLockTier(), 'none');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 5 — Multi-arm escalation
// ══════════════════════════════════════════════════════════════════════════
describe('RotationLock — multi-arm escalation', () => {
  it('one TRANSIT (soft) + all others DOCKED → soft', () => {
    const mgr = makeManager();
    mgr.arms[0].state = S.TRANSIT;
    // Remaining arms are DOCKED by default
    assert.equal(mgr.getRotationLockTier(), 'soft');
  });

  it('one TRANSIT (soft) + one REELING (block) → block', () => {
    const mgr = makeManager();
    mgr.arms[0].state = S.TRANSIT;
    mgr.arms[1].state = S.REELING;
    assert.equal(mgr.getRotationLockTier(), 'block',
      'block tier should dominate soft');
  });

  it('early exit on first block state — order independence', () => {
    // Put block arm last; tier must still be 'block'
    const mgr = makeManager();
    mgr.arms[0].state = S.TRANSIT;
    mgr.arms[1].state = S.APPROACH;
    const lastIdx = mgr.arms.length - 1;
    mgr.arms[lastIdx].state = S.NETTING;
    assert.equal(mgr.getRotationLockTier(), 'block');
  });

  it('block arm detached + remaining TRANSIT → soft (detached exempted)', () => {
    const mgr = makeManager();
    mgr.arms[0].state      = S.REELING;
    mgr.arms[0].isDetached = true;   // severed — exempt
    mgr.arms[1].state      = S.TRANSIT;
    assert.equal(mgr.getRotationLockTier(), 'soft');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 6 — hasTetheredArm()
// ══════════════════════════════════════════════════════════════════════════
describe('RotationLock — hasTetheredArm()', () => {
  it('all arms DOCKED → false', () => {
    const mgr = makeManager();
    for (const arm of mgr.arms) arm.state = S.DOCKED;
    assert.equal(mgr.hasTetheredArm(), false);
  });

  it('all arms EXPENDED → false', () => {
    const mgr = makeManager();
    for (const arm of mgr.arms) arm.state = S.EXPENDED;
    assert.equal(mgr.hasTetheredArm(), false);
  });

  it('one TRANSIT → true', () => {
    const mgr = makeManager();
    mgr.arms[0].state = S.TRANSIT;
    assert.equal(mgr.hasTetheredArm(), true);
  });

  it('one GRAPPLED → true', () => {
    const mgr = makeManager();
    mgr.arms[0].state = S.GRAPPLED;
    assert.equal(mgr.hasTetheredArm(), true);
  });

  it('TRANSIT arm with isDetached=true → false (no live tether)', () => {
    const mgr = makeManager();
    for (const arm of mgr.arms) arm.state = S.DOCKED;
    mgr.arms[0].state      = S.TRANSIT;
    mgr.arms[0].isDetached = true;
    assert.equal(mgr.hasTetheredArm(), false,
      'detached arm has no live tether');
  });

  it('RELOADING arms excluded — false', () => {
    const mgr = makeManager();
    for (const arm of mgr.arms) arm.state = S.RELOADING;
    assert.equal(mgr.hasTetheredArm(), false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite 7 — TETHER_ROTATION constants present and sane
// ══════════════════════════════════════════════════════════════════════════
describe('RotationLock — TETHER_ROTATION constants', () => {
  const TR = Constants.TETHER_ROTATION;

  it('TETHER_ROTATION block exists', () => {
    assert.ok(TR && typeof TR === 'object', 'Constants.TETHER_ROTATION must be an object');
  });

  it('MAX_DISPLACEMENT_SOFT > MAX_DISPLACEMENT_BLOCK', () => {
    assert.ok(TR.MAX_DISPLACEMENT_SOFT > TR.MAX_DISPLACEMENT_BLOCK,
      'soft limit must be more permissive than block limit');
  });

  it('STIFFNESS_EXPONENT is a positive integer ≥ 1', () => {
    assert.ok(Number.isInteger(TR.STIFFNESS_EXPONENT) && TR.STIFFNESS_EXPONENT >= 1);
  });

  it('SPRINGBACK_RATE_SOFT > 0', () => {
    assert.ok(TR.SPRINGBACK_RATE_SOFT > 0);
  });

  it('SPRINGBACK_RATE_BLOCK > 0', () => {
    assert.ok(TR.SPRINGBACK_RATE_BLOCK > 0);
  });

  it('SATURATION_THRESHOLD is in (0, 1)', () => {
    assert.ok(TR.SATURATION_THRESHOLD > 0 && TR.SATURATION_THRESHOLD < 1);
  });

  it('COMMS_THROTTLE_MS is a positive number', () => {
    assert.ok(TR.COMMS_THROTTLE_MS > 0);
  });
});
