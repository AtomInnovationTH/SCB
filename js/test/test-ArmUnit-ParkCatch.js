/**
 * test-ArmUnit-ParkCatch.js — Park-the-catch delivery model (2026-06-06).
 *
 * A daughter that reels a catch home no longer "processes/removes" it at the
 * mother. Instead she docks at her strut tip still holding the debris cinched
 * in the net (state HOLDING_CATCH), full size, indefinitely — awaiting a future
 * furnace-transfer/breakdown step. She is OCCUPIED (not reloaded, not DOCKED),
 * so she drops out of the deploy pool while the other daughters stay available.
 *
 * Covers:
 *   • DOCKING completion WITH a catch → HOLDING_CATCH, catch retained + pinned,
 *     DEBRIS_CAPTURED still fires (parked:true) for the capture-secured signal.
 *   • DOCKING completion WITHOUT a catch → legacy RELOADING path preserved.
 *   • HOLDING_CATCH re-pins the catch at the strut every frame; empty → RELOADING.
 *   • A holding daughter reads as "home" (not tethered, no rotation lock) and is
 *     excluded from _findDockedArm, while other daughters remain selectable.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { ArmManager } from '../entities/ArmManager.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

const S = Constants.ARM_STATES;
const M = 0.00001;

function makeArm(type = 'weaver') {
  const scene = { add: () => {}, remove: () => {} };
  const offset = new THREE.Vector3(M, 0, 0);
  const arm = new ArmUnit(`${type}-1`, type, offset, scene);
  arm.index = 0;
  arm.isDetached = false;
  return arm;
}

function makeDebris(mass = 100, sizeMeter = 1) {
  return { id: 99, mass, sizeMeter, _captured: true, _capturedByArm: null,
    _armPinned: false, _armPinPos: null, _netted: false };
}

function attachCatch(arm, debris) {
  arm.capturedDebris = debris;
  debris._capturedByArm = arm;
  debris._captured = true;
}

function captureEvent(evt, fn) {
  const got = [];
  const h = (d) => got.push(d);
  eventBus.on(evt, h);
  try { fn(); } finally { eventBus.off(evt, h); }
  return got;
}

describe('ArmUnit park-the-catch — dock completion', () => {
  it('parks the catch on HOLDING_CATCH instead of removing it', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const debris = makeDebris(100);
    attachCatch(arm, debris);
    arm.state = S.DOCKING;
    arm.stateTimer = Constants.ARM_DOCK_DURATION + 0.1; // force completion

    const captured = captureEvent(Events.DEBRIS_CAPTURED, () => {
      arm._updateDocking(0.016, new THREE.Vector3(0, 0, 0), null);
    });

    assert.equal(arm.state, S.HOLDING_CATCH, 'daughter parks holding the catch');
    assert.notEqual(arm.state, S.RELOADING, 'she does NOT reload while occupied');
    assert.equal(arm.capturedDebris, debris, 'catch is retained (not cleared)');
    assert.equal(debris._capturedByArm, arm, 'debris stays pinned to the daughter');
    assert.equal(debris._armPinned, true, 'authoritative arm pin still engaged');

    assert.equal(captured.length, 1, 'DEBRIS_CAPTURED fires (capture-secured signal)');
    assert.equal(captured[0].parked, true, 'flagged parked → field removal is skipped');
    assert.equal(captured[0].debrisId, debris.id, 'names the parked debris');
  });

  it('an empty return (no catch) still reloads the spring (legacy path)', () => {
    eventBus.clear();
    const arm = makeArm('spinner');
    arm.capturedDebris = null;
    arm.state = S.DOCKING;
    arm.stateTimer = Constants.ARM_DOCK_DURATION + 0.1;

    arm._updateDocking(0.016, new THREE.Vector3(0, 0, 0), null);
    assert.equal(arm.state, S.RELOADING, 'empty daughter reloads as before');
  });
});

describe('ArmUnit park-the-catch — HOLDING_CATCH update', () => {
  it('clamps the daughter to her strut tip and re-pins the catch full size', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const debris = makeDebris(100);
    attachCatch(arm, debris);
    arm.state = S.HOLDING_CATCH;
    arm.position.set(5, 5, 5);        // off-position; should snap back to dock
    arm.velocity.set(1, 1, 1);

    const parentPos = new THREE.Vector3(0, 0, 0);
    arm._updateHoldingCatch(0.016, parentPos, null);

    const expected = parentPos.clone().add(arm.dockOffset);
    assert.ok(arm.position.distanceTo(expected) < 1e-9, 'clamped to strut-tip dock');
    assert.equal(arm.velocity.length(), 0, 'held station — zero velocity');
    assert.equal(debris._armPinned, true, 'catch re-pinned each frame');
    assert.ok(debris._armPinPos.distanceTo(arm.position) < 1e-9, 'catch welded to the strut');
  });

  it('falls back to RELOADING if the held catch is gone', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    arm.capturedDebris = null;        // catch removed (e.g. future furnace step)
    arm.state = S.HOLDING_CATCH;
    arm._updateHoldingCatch(0.016, new THREE.Vector3(0, 0, 0), null);
    assert.equal(arm.state, S.RELOADING, 'empty holding arm reloads');
  });
});

describe('ArmUnit park-the-catch — furnace transfer (CATCH_PROCESSED)', () => {
  it('holds the catch until the furnace-transfer window elapses', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const debris = makeDebris(100);
    attachCatch(arm, debris);
    arm.state = S.HOLDING_CATCH;
    arm.stateTimer = Constants.FURNACE_TRANSFER.DURATION_S - 0.5;  // not yet

    const processed = captureEvent(Events.CATCH_PROCESSED, () => {
      arm._updateHoldingCatch(0.016, new THREE.Vector3(0, 0, 0), null);
    });
    assert.equal(processed.length, 0, 'no transfer before the window elapses');
    assert.equal(arm.state, S.HOLDING_CATCH, 'still parked');
    assert.equal(arm.capturedDebris, debris, 'catch still held');
    assert.equal(debris._armPinned, true, 're-pinned each frame');
  });

  it('transfers the catch to the furnace once the window elapses → RELOADING', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const debris = makeDebris(100);
    attachCatch(arm, debris);
    arm.state = S.HOLDING_CATCH;
    arm.stateTimer = Constants.FURNACE_TRANSFER.DURATION_S + 0.1;  // window elapsed

    const processed = captureEvent(Events.CATCH_PROCESSED, () => {
      arm._updateHoldingCatch(0.016, new THREE.Vector3(0, 0, 0), null);
    });

    assert.equal(processed.length, 1, 'CATCH_PROCESSED fires exactly once on transfer');
    assert.equal(processed[0].debrisId, debris.id, 'names the processed catch');
    assert.equal(processed[0].armId, arm.id, 'names the arm');
    assert.equal(arm.state, S.RELOADING, 'daughter reloads (freed from the deploy-pool block)');
    assert.equal(arm.capturedDebris, null, 'catch cleared off the daughter');
    assert.equal(debris._armPinned, false, 'daughter pin released (furnace owns it now)');
    assert.equal(debris._capturedByArm, null, 'no longer pinned to the arm');
  });
});

describe('ArmManager — a holding daughter is occupied, others stay free', () => {
  function mgrWith(arms) {
    const mgr = Object.create(ArmManager.prototype);
    mgr.arms = arms;
    return mgr;
  }

  it('treats HOLDING_CATCH as home — no live tether, no rotation lock', () => {
    const mgr = mgrWith([
      { state: S.HOLDING_CATCH, isDetached: false },
      { state: S.DOCKED, isDetached: false },
    ]);
    assert.equal(mgr.hasTetheredArm(), false, 'holding daughter is not on a live tether');
    assert.equal(mgr.getRotationLockTier(), 'none', 'no rotation lock from a parked catch');
  });

  it('still detects a genuinely deployed arm as tethered (contrast)', () => {
    const mgr = mgrWith([{ state: S.REELING, isDetached: false }]);
    assert.equal(mgr.hasTetheredArm(), true, 'a reeling daughter IS tethered');
    assert.equal(mgr.getRotationLockTier(), 'block', 'reeling locks rotation');
  });

  it('excludes a holding daughter from the deploy pool but keeps others selectable', () => {
    const holding = { type: 'weaver', state: S.HOLDING_CATCH, springCharged: true, fuel: 100 };
    const ready = { type: 'spinner', state: S.DOCKED, springCharged: true, fuel: 100 };
    const mgr = mgrWith([holding, ready]);

    assert.equal(mgr._findDockedArm('weaver'), null, 'occupied weaver cannot be redeployed');
    assert.equal(mgr._findDockedArm('spinner'), ready, 'a free daughter is still deployable');
  });
});
