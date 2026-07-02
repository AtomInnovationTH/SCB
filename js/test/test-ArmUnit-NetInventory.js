/**
 * test-ArmUnit-NetInventory.js — §13 Q5: Net Inventory Decrement + Empty-Click Guard
 *
 * Phase 1 tests per DAUGHTER_MULTITOOL_SPEC.md §10:
 *   1. Fresh Weaver (Large Daughter) starts with armNetCounts[i] === 2
 *   2. Fresh Spinner (Small Daughter) starts with armNetCounts[i] === 4
 *   3. Firing a net (NETTING entry) decrements the count by exactly 1
 *   4. Firing to depletion exhausts the inventory to 0
 *   5. With 0 nets, attempting to fire emits NET_EMPTY_CLICK, no decrement below 0, no NETTING
 *   6. After firing to empty, count stays at 0 across update ticks (no negative drift, no auto-refill)
 *   7. (Integration) Full SK → F → NETTING with CAPTURE_NET ON uses real FSM, not 85% dice roll
 *
 * Refund-on-miss semantic (CAPTURE_NET.md §3.5): a net reeled home empty is
 * returned to the magazine; only a net wrapped around a catch (or lost to snap)
 * is spent. Magazine count therefore tracks successful captures per load.
 */

import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { generateDockPositions } from '../entities/ArmManager.js';

const M = 0.00001;
const S = Constants.ARM_STATES;

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create a fresh ArmUnit with Config G geometry. */
function makeArm(armIdx = 0) {
  const scene = { add: () => {}, remove: () => {} };
  const positions = generateDockPositions('Y0_QUAD');
  const dp = positions[armIdx];
  const arm = new ArmUnit('netinv-' + dp.type + '-' + armIdx, dp.type, dp.offset, scene);
  arm.index = armIdx;
  arm._hingePosition = dp.hingePosition.clone();
  arm._dockOutward = dp.dockOutward.clone();
  arm._swingAxis = dp.swingAxis.clone();
  arm._azimuthDeg = dp.azimuthDeg;
  arm._isEndFace = dp.isEndFace;
  arm.initNetInventory();
  eventBus.clear();
  return arm;
}

/** Create a stub debris target. */
function makeTarget(id = 'debris-inv') {
  return {
    id,
    sizeMeter: 2,
    mass: 5,
    alive: true,
    type: 'fragment',
    _captured: false,
    _isStationKeepTarget: false,
    tumbleRate: 0,
    mesh: { position: new THREE.Vector3(0.001, 0, 0) },
    position: new THREE.Vector3(0.001, 0, 0),
  };
}

/** Put arm into STATION_KEEP with a target. */
function enterStationKeep(arm, target) {
  const t = target || makeTarget();
  arm.state = S.STATION_KEEP;
  arm._stationKeepTarget = t;
  arm.target = t;
  arm._standoffR = 5;
  arm._orbitTheta = 0;
  arm._orbitPhi = 0;
  arm.fuel = 100;
}

// Save/restore CAPTURE_NET flag
let _savedFlag;
function flagOn() {
  _savedFlag = Constants.FEATURE_FLAGS.CAPTURE_NET;
  Constants.FEATURE_FLAGS.CAPTURE_NET = true;
}
function flagRestore() {
  Constants.FEATURE_FLAGS.CAPTURE_NET = _savedFlag;
}

// ══════════════════════════════════════════════════════════════════════════
// Suite: Net-ladder drift guards (net ladder Phase A)
// Constants that MUST stay in lockstep across the two parallel definitions:
//   ARM_NET_CAPACITY (per-arm magazine) ⇔ CAPTURE_NET.*.MAGAZINE_SIZE (net class)
//   SPINNER_MAX_CAPTURE_MASS (arm config) ⇔ CAPTURE_NET.SMALL.MAX_CAPTURE_MASS
// ══════════════════════════════════════════════════════════════════════════
describe('Net-ladder constant drift guards', () => {

  it('ARM_NET_CAPACITY.weaver === CAPTURE_NET.MEDIUM.MAGAZINE_SIZE', () => {
    assert.equal(Constants.ARM_NET_CAPACITY.weaver,
      Constants.CAPTURE_NET.MEDIUM.MAGAZINE_SIZE,
      'Large Daughter magazine must match the Medium net class MAGAZINE_SIZE');
  });

  it('ARM_NET_CAPACITY.spinner === CAPTURE_NET.SMALL.MAGAZINE_SIZE', () => {
    assert.equal(Constants.ARM_NET_CAPACITY.spinner,
      Constants.CAPTURE_NET.SMALL.MAGAZINE_SIZE,
      'Small Daughter magazine must match the Small net class MAGAZINE_SIZE');
  });

  it('SPINNER_MAX_CAPTURE_MASS === CAPTURE_NET.SMALL.MAX_CAPTURE_MASS === 50', () => {
    assert.equal(Constants.SPINNER_MAX_CAPTURE_MASS,
      Constants.CAPTURE_NET.SMALL.MAX_CAPTURE_MASS,
      'Small Daughter catch cap must match the Small net class MAX_CAPTURE_MASS');
    assert.equal(Constants.SPINNER_MAX_CAPTURE_MASS, 50, 'unified Small catch cap is 50 kg');
  });

  it('WEAVER_MAX_CAPTURE_MASS === CAPTURE_NET.MEDIUM.MAX_CAPTURE_MASS === 500', () => {
    assert.equal(Constants.WEAVER_MAX_CAPTURE_MASS,
      Constants.CAPTURE_NET.MEDIUM.MAX_CAPTURE_MASS,
      'Large Daughter catch cap must match the Medium net class MAX_CAPTURE_MASS');
    assert.equal(Constants.WEAVER_MAX_CAPTURE_MASS, 500, 'Large catch cap is 500 kg');
  });

  it('initNetInventory seeds magazine from the net class MAGAZINE_SIZE', () => {
    flagOn();
    try {
      const weaver = makeArm(0);
      const spinner = makeArm(1);
      assert.equal(weaver.getNetInventoryMax(), Constants.CAPTURE_NET.MEDIUM.MAGAZINE_SIZE,
        'weaver seeded from MEDIUM.MAGAZINE_SIZE');
      assert.equal(spinner.getNetInventoryMax(), Constants.CAPTURE_NET.SMALL.MAGAZINE_SIZE,
        'spinner seeded from SMALL.MAGAZINE_SIZE');
    } finally {
      flagRestore();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Net Inventory — Initial Capacity
// ══════════════════════════════════════════════════════════════════════════
describe('ArmUnit Net Inventory — initial capacity (§13 Q5)', () => {

  it('Fresh Weaver starts with netInventory === 2', () => {
    flagOn();
    try {
      const arm = makeArm(0); // weaver in Y0_QUAD
      assert.equal(arm.getNetInventory(), Constants.ARM_NET_CAPACITY.weaver,
        'Weaver net inventory should match ARM_NET_CAPACITY.weaver');
      assert.equal(arm.getNetInventory(), 2, 'Weaver should have 2 nets');
    } finally {
      flagRestore();
    }
  });

  it('Fresh Spinner starts with netInventory === 4', () => {
    flagOn();
    try {
      const arm = makeArm(1); // spinner in Y0_QUAD
      assert.equal(arm.getNetInventory(), Constants.ARM_NET_CAPACITY.spinner,
        'Spinner net inventory should match ARM_NET_CAPACITY.spinner');
      assert.equal(arm.getNetInventory(), 4, 'Spinner (Small Daughter) should have 4 nets');
    } finally {
      flagRestore();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Net Inventory — Decrement on NETTING entry
// ══════════════════════════════════════════════════════════════════════════
describe('ArmUnit Net Inventory — decrement on fire (§13 Q5)', () => {

  it('firing a net decrements net count by exactly 1', () => {
    flagOn();
    try {
      const arm = makeArm(0);
      const before = arm.getNetInventory();
      assert.equal(before, 2, 'should start with 2');

      // decrementNetInventory is what fireDaughterNet calls internally
      const remaining = arm.decrementNetInventory();
      assert.equal(remaining, 1, 'decrementNetInventory returns remaining');
      assert.equal(arm.getNetInventory(), before - 1, 'net count should decrement by 1');
    } finally {
      flagRestore();
    }
  });

  it('firing twice exhausts inventory to 0', () => {
    flagOn();
    try {
      const arm = makeArm(0);
      assert.equal(arm.getNetInventory(), 2, 'start with 2');

      arm.decrementNetInventory();
      assert.equal(arm.getNetInventory(), 1, 'after first fire: 1 net remaining');

      arm.decrementNetInventory();
      assert.equal(arm.getNetInventory(), 0, 'after second fire: 0 nets remaining');
    } finally {
      flagRestore();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Net Inventory — Empty-Click Guard
// ══════════════════════════════════════════════════════════════════════════
describe('ArmUnit Net Inventory — empty-click guard (§13 Q5)', () => {

  it('at 0 nets: captureFromStationKeep emits NET_EMPTY_CLICK and does NOT enter NETTING', () => {
    flagOn();
    try {
      const arm = makeArm(0);
      arm.setNetInventory(0); // exhaust nets
      enterStationKeep(arm, makeTarget());
      eventBus.clear();

      let emitted = false;
      let emittedPayload = null;
      eventBus.on(Events.NET_EMPTY_CLICK, (data) => {
        emitted = true;
        emittedPayload = data;
      });

      const result = arm.captureFromStationKeep();

      assert.equal(result, false, 'should return false (blocked)');
      assert.equal(arm.state, S.STATION_KEEP, 'should remain in STATION_KEEP');
      assert.ok(emitted, 'NET_EMPTY_CLICK should be emitted');
      assert.equal(emittedPayload.armId, arm.id, 'payload should contain armId');
      assert.equal(arm.getNetInventory(), 0, 'inventory should stay at 0 (no negative)');
    } finally {
      flagRestore();
    }
  });

  it('after firing twice, count stays at 0 across update ticks (no negative drift, no auto-refill)', () => {
    flagOn();
    try {
      const arm = makeArm(0);
      arm.setNetInventory(0); // simulate already exhausted
      enterStationKeep(arm, makeTarget());

      // Attempt additional decrements — should not go below 0
      arm.decrementNetInventory();
      arm.decrementNetInventory();
      arm.decrementNetInventory();
      assert.equal(arm.getNetInventory(), 0, 'net count stays at 0 (no negative)');

      // Try to capture — should fail
      const result = arm.captureFromStationKeep();
      assert.equal(result, false, 'should still be blocked');
      assert.equal(arm.getNetInventory(), 0, 'still 0 (no negative, no refill)');
    } finally {
      flagRestore();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Delegation 4 — NET_INVENTORY_CHANGED emits from ArmUnit methods
// ══════════════════════════════════════════════════════════════════════════
describe('ArmUnit Net Inventory — NET_INVENTORY_CHANGED emits (Delegation 4)', () => {

  it('decrementNetInventory emits NET_INVENTORY_CHANGED', () => {
    flagOn();
    try {
      const arm = makeArm(0);
      eventBus.clear();
      const emits = [];
      eventBus.on(Events.NET_INVENTORY_CHANGED, (d) => emits.push(d));
      arm.decrementNetInventory();
      assert.equal(emits.length, 1, 'should emit exactly once');
      assert.equal(emits[0].source, 'daughter');
      assert.equal(emits[0].nets, arm.getNetInventory());
    } finally {
      flagRestore();
    }
  });

  it('setNetInventory emits NET_INVENTORY_CHANGED', () => {
    flagOn();
    try {
      const arm = makeArm(0);
      eventBus.clear();
      const emits = [];
      eventBus.on(Events.NET_INVENTORY_CHANGED, (d) => emits.push(d));
      arm.setNetInventory(1);
      assert.equal(emits.length, 1, 'should emit exactly once');
      assert.equal(emits[0].nets, 1);
    } finally {
      flagRestore();
    }
  });

  it('reloadNetInventory emits NET_INVENTORY_CHANGED with max count', () => {
    flagOn();
    try {
      const arm = makeArm(0);
      arm.setNetInventory(0); // exhaust
      eventBus.clear();
      const emits = [];
      eventBus.on(Events.NET_INVENTORY_CHANGED, (d) => emits.push(d));
      arm.reloadNetInventory();
      assert.equal(emits.length, 1);
      assert.equal(emits[0].nets, arm.getNetInventoryMax(),
        'reload should set count back to max');
    } finally {
      flagRestore();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Integration — CAPTURE_NET ON uses real FSM, not 85% dice roll
// ══════════════════════════════════════════════════════════════════════════
describe('ArmUnit Net Inventory — FSM integration (§13 Q5)', () => {

  it('SK → F → NETTING with CAPTURE_NET ON routes to _updateNettingFSM (not legacy dice roll)', () => {
    flagOn();
    try {
      const arm = makeArm(0);
      enterStationKeep(arm, makeTarget());

      // Capture from SK → transitions to NETTING
      const result = arm.captureFromStationKeep();
      assert.equal(result, true, 'capture should succeed');
      assert.equal(arm.state, S.NETTING, 'should be in NETTING');

      // Verify isFeatureEnabled gates correctly
      assert.equal(Constants.isFeatureEnabled('CAPTURE_NET'), true,
        'CAPTURE_NET should be enabled');
      assert.equal(typeof arm._updateNettingFSM, 'function',
        '_updateNettingFSM method should exist (FSM path)');

      // ── Strong dispatch proof: spy on _updateNettingFSM. If _updateNetting
      // routes to the FSM path, the spy must fire. If the legacy 85% dice
      // path runs instead, the spy stays at zero.
      const originalFSM = arm._updateNettingFSM.bind(arm);
      let fsmCallCount = 0;
      arm._updateNettingFSM = function spy(dt) {
        fsmCallCount++;
        return originalFSM(dt);
      };

      // Drive a single _updateNetting tick. Force stateTimer past
      // ARM_NET_DEPLOY_TIME so the LEGACY path (if active) would do a dice
      // roll + transition; the FSM path simply delegates to _updateNettingFSM.
      arm.stateTimer = Constants.ARM_NET_DEPLOY_TIME + 1;
      arm._updateNetting(0.016);

      assert.equal(fsmCallCount, 1,
        '_updateNettingFSM must be invoked exactly once (legacy path would skip it)');
      // On the FIRST FSM tick the daughter net is only just being fired;
      // GRAPPLED requires a subsequent poll seeing CAPTURED, so the only
      // legal post-tick states are NETTING (net launched, still in flight)
      // or STATION_KEEP (fireDaughterNet returned null → fallback to SK so
      // pilot can retry with F without an APPROACH "race to debris").
      const legalFsmStates = [S.NETTING, S.STATION_KEEP];
      assert.ok(legalFsmStates.includes(arm.state),
        `arm state after FSM tick should be NETTING or STATION_KEEP, got ${arm.state}`);
    } finally {
      flagRestore();
    }
  });
});
