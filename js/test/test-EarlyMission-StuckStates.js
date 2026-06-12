/**
 * test-EarlyMission-StuckStates.js — learning-mission anti-dead-end audit
 * (plan items 5 & 6, 2026-06-12).
 *
 * The beginner loop (D deploy → ceremony → autopilot → SK → F/N net → R reel)
 * must NEVER dead-end. Each suite scripts one known trap and asserts:
 *   (1) the system lands in a RECOVERABLE state, and
 *   (2) at least one guidance emission names the next verb.
 *
 * Rows (from the audit table):
 *   a — deploy refused (spring / fuel / range / mass) → comms + HintTicker entry
 *   b — fireDaughterNet returns null → comms names the reason, arm → SK
 *   d — mission-1 tether overload → warning, NO snap (covered in depth in
 *       test-ArmUnit-CaptureFailure; smoke-checked here)
 *   e — HOLDING_CATCH furnace transfer completes → CATCH_PROCESSED + RELOADING
 *   f — target dies mid-net-flight → RETURNING (not SK on a corpse) + comms
 *   g — Esc/R from SK → recallFromStationKeep / reelFromStationKeep
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { captureNetSystem } from '../entities/CaptureNet.js';
import { gameState } from '../core/GameState.js';

const S = Constants.ARM_STATES;
const M = 0.00001;

function makeArm(type = 'weaver') {
  const scene = { add: () => {}, remove: () => {} };
  const arm = new ArmUnit(`${type}-1`, type, new THREE.Vector3(M, 0, 0), scene);
  arm.index = 0;
  arm.isDetached = false;
  return arm;
}

function makeTarget(id = 'debris-1', mass = 5) {
  return {
    id, mass, alive: true, type: 'fragment', tumbleRate: 0,
    _scenePosition: new THREE.Vector3(50 * M, 0, 0),
  };
}

function collect(evt, fn) {
  const got = [];
  const h = (d) => got.push(d);
  eventBus.on(evt, h);
  try { fn(); } finally { eventBus.off(evt, h); }
  return got;
}

// ── Row a: deploy refusals name the next verb ─────────────────────────────
describe('EarlyMission stuck-states (a) — deploy refusals post guidance', () => {
  it('spring not charged → refused, DOCKED retained, hint names the next verb', () => {
    eventBus.clear();
    const arm = makeArm();
    arm.springCharged = false;
    let hints;
    const comms = collect(Events.COMMS_MESSAGE, () => {
      hints = collect(Events.HINT_POSTED, () => {
        assert.equal(arm.deploy(makeTarget()), false, 'deploy refused');
      });
    });
    assert.equal(arm.state, S.DOCKED, 'arm stays DOCKED (recoverable)');
    assert.ok(comms.length >= 1, 'comms warning emitted');
    assert.equal(hints.length, 1, 'HintTicker entry posted');
    assert.equal(hints[0].id, 'deploy_refused_spring');
    assert.ok(/\[1-4\]|wait/i.test(hints[0].text), 'hint names a next action');
  });

  it('no fuel → refused with hint', () => {
    eventBus.clear();
    const arm = makeArm();
    arm.fuel = 0;
    const hints = collect(Events.HINT_POSTED, () => {
      assert.equal(arm.deploy(makeTarget()), false);
    });
    assert.equal(hints.length, 1);
    assert.equal(hints[0].id, 'deploy_refused_fuel');
  });

  it('too massive → refused with hint naming [Tab]', () => {
    eventBus.clear();
    const arm = makeArm();
    const heavy = makeTarget('big-1', (arm.config.maxCaptureMass || 500) + 1);
    const hints = collect(Events.HINT_POSTED, () => {
      assert.equal(arm.deploy(heavy), false);
    });
    assert.equal(hints.length, 1);
    assert.equal(hints[0].id, 'deploy_refused_mass');
    assert.ok(/\[Tab\]/.test(hints[0].text), 'hint points at target cycling');
  });

  it('out of range → refused with hint naming [A] autopilot', () => {
    eventBus.clear();
    const arm = makeArm();
    const far = makeTarget('far-1', 5);
    far._scenePosition = new THREE.Vector3(2000 * M, 0, 0);   // 2 km away
    const hints = collect(Events.HINT_POSTED, () => {
      assert.equal(arm.deploy(far), false);
    });
    assert.equal(arm.state, S.DOCKED, 'still DOCKED');
    assert.equal(hints.length, 1);
    assert.equal(hints[0].id, 'deploy_refused_range');
    assert.ok(/\[A\]/.test(hints[0].text), 'hint names autopilot');
  });
});

// ── Row b: net-fire refusal names the actual reason ───────────────────────
describe('EarlyMission stuck-states (b) — net-fire refusal reasons', () => {
  it('magazine empty → comms says so, arm falls back to STATION_KEEP', () => {
    eventBus.clear();
    const arm = makeArm();
    arm.state = S.NETTING;
    arm._firedNet = null;
    arm.target = makeTarget('sk-1');
    arm._netInventory = 0;
    if (typeof arm.getNetInventory !== 'function') arm.getNetInventory = () => 0;

    const comms = collect(Events.COMMS_MESSAGE, () => arm._updateNettingFSM(0.016));
    assert.equal(arm.state, S.STATION_KEEP, 'recoverable fallback to SK');
    assert.ok(comms.some(c => /magazine empty/i.test(c.text || '')),
      'reason (magazine empty) reaches the player');
    assert.ok(comms.some(c => /reel|reload|\bR\b/i.test(c.text || '')),
      'refusal names the next verb (reel home / reload)');
  });

  it('launcher cooldown → comms names the remaining seconds', () => {
    eventBus.clear();
    const arm = makeArm();
    arm.state = S.NETTING;
    arm._firedNet = null;
    arm.target = makeTarget('sk-2');
    // Inventory present, but the launcher is cooling down.
    arm._netInventory = 2;
    captureNetSystem._cooldownTimers.set('arm_0', 7.4);
    let comms;
    try {
      comms = collect(Events.COMMS_MESSAGE, () => arm._updateNettingFSM(0.016));
    } finally {
      captureNetSystem._cooldownTimers.delete('arm_0');
    }
    assert.equal(arm.state, S.STATION_KEEP, 'recoverable fallback to SK');
    assert.ok(comms.some(c => /cooling down.*8s/i.test(c.text || '')),
      `cooldown reason with seconds shown; got: ${comms.map(c => c.text).join(' | ')}`);
  });
});

// ── Row d: mission-1 tether overload smoke test ────────────────────────────
describe('EarlyMission stuck-states (d) — mission-1 snap guard (smoke)', () => {
  it('mission 1 overload warns instead of snapping', () => {
    eventBus.clear();
    const arm = makeArm();
    arm.state = S.REELING;
    arm._netRatedMass = 500;
    const debris = { id: 7, mass: 5000, sizeMeter: 2, _captured: true, _capturedByArm: null };
    arm.capturedDebris = debris;
    debris._capturedByArm = arm;
    arm.position.set(1, 0, 0);
    const orig = gameState.debrisCleared;
    gameState.debrisCleared = 0;        // mission 1
    let snaps;
    try {
      snaps = collect(Events.TETHER_SNAP, () =>
        arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null));
    } finally {
      gameState.debrisCleared = orig;
    }
    assert.equal(snaps.length, 0, 'no snap in mission 1');
    assert.notEqual(arm.state, S.EXPENDED, 'daughter not expended');
  });
});

// ── Row e: furnace transfer completes end-to-end ───────────────────────────
describe('EarlyMission stuck-states (e) — HOLDING_CATCH drains via FEED_S', () => {
  it('crossing FEED_S emits CATCH_PROCESSED and reloads (deploy pool recovers)', () => {
    eventBus.clear();
    const arm = makeArm();
    const debris = { id: 42, mass: 100, sizeMeter: 1, _captured: true, _capturedByArm: arm };
    arm.capturedDebris = debris;
    arm.state = S.HOLDING_CATCH;
    arm.stateTimer = Constants.FURNACE_TRANSFER.FEED_S + 0.1;

    const processed = collect(Events.CATCH_PROCESSED, () =>
      arm._updateHoldingCatch(0.016, new THREE.Vector3(0, 0, 0), null));

    assert.equal(processed.length, 1, 'CATCH_PROCESSED fired exactly once');
    assert.equal(processed[0].debrisId, 42);
    assert.equal(arm.state, S.RELOADING, 'daughter rejoins the deploy pool via RELOADING');
    assert.equal(arm.capturedDebris, null, 'catch handed to the mother');
    assert.equal(debris._capturedByArm, null, 'pin released');
  });
});

// ── Row f: target dies mid-net-flight ──────────────────────────────────────
describe('EarlyMission stuck-states (f) — target dies mid-flight', () => {
  it('MISSED with a dead committed target → RETURNING + comms (no SK on a corpse)', () => {
    eventBus.clear();
    const arm = makeArm();
    arm.state = S.NETTING;
    arm.target = makeTarget('dead-1');
    arm._netCommittedTarget = { id: 'dead-1', alive: false };
    arm._firedNet = { state: Constants.CAPTURE_NET.STATES.MISSED, netClass: Constants.CAPTURE_NET.MEDIUM };

    const comms = collect(Events.COMMS_MESSAGE, () => arm._updateNettingFSM(0.016));
    assert.equal(arm.state, S.RETURNING, 'daughter returns instead of SK-ing a corpse');
    assert.ok(comms.some(c => /target lost/i.test(c.text || '')), 'player told why');
  });

  it('MISSED with a live target → SK + retry guidance', () => {
    eventBus.clear();
    const arm = makeArm();
    arm.state = S.NETTING;
    const t = makeTarget('alive-1');
    arm.target = t;
    arm._netCommittedTarget = t;
    arm._firedNet = { state: Constants.CAPTURE_NET.STATES.MISSED, netClass: Constants.CAPTURE_NET.MEDIUM };

    const comms = collect(Events.COMMS_MESSAGE, () => arm._updateNettingFSM(0.016));
    assert.equal(arm.state, S.STATION_KEEP, 'holds standoff for a retry');
    assert.ok(comms.some(c => /press f to retry/i.test(c.text || '')), 'retry verb named');
  });
});

// ── Row g: SK exits stay available ─────────────────────────────────────────
describe('EarlyMission stuck-states (g) — Esc/R exits from STATION_KEEP', () => {
  it('recallFromStationKeep leaves SK', () => {
    eventBus.clear();
    const arm = makeArm();
    arm.state = S.STATION_KEEP;
    assert.equal(arm.recallFromStationKeep(), true);
    assert.notEqual(arm.state, S.STATION_KEEP, 'no longer station-keeping');
  });

  it('reelFromStationKeep → REELING (zero-fuel recovery)', () => {
    eventBus.clear();
    const arm = makeArm();
    arm.state = S.STATION_KEEP;
    assert.equal(arm.reelFromStationKeep(), true);
    assert.equal(arm.state, S.REELING, 'strut motor reels her home');
  });

  it('both are no-ops outside SK (no state corruption)', () => {
    eventBus.clear();
    const arm = makeArm();
    arm.state = S.TRANSIT;
    assert.equal(arm.recallFromStationKeep(), false);
    assert.equal(arm.reelFromStationKeep(), false);
    assert.equal(arm.state, S.TRANSIT, 'state untouched');
  });
});
