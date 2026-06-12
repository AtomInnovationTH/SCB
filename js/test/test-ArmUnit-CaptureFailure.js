/**
 * test-ArmUnit-CaptureFailure.js — Post-capture failure handling.
 *
 * Covers the two distinct failure modes and their (non-vanishing) aftermath:
 *   1. NET FAILURE  (recoverable): heavy near-rated catch slips the net at reel
 *      start → debris released free + re-targetable, daughter returns to reload.
 *   2. TETHER SNAP  (catastrophic): cable parts during reel → daughter EXPENDED,
 *      catch stays pinned/visible (drifts off with her), severed line hidden.
 * Also verifies the retuned reel tension so an in-spec catch never snaps.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { gameState } from '../core/GameState.js';

const S = Constants.ARM_STATES;
const M = 0.00001;

// Item 5d (2026-06-12): tether snaps are clamped to a warning during MISSION 1
// (learning-mission guard). Snap tests below run "in mission 2" by setting
// debrisCleared ≥ 5 (missionNumber = floor(cleared/5)+1).
function inMission2(fn) {
  const orig = gameState.debrisCleared;
  gameState.debrisCleared = 5;
  try { fn(); } finally { gameState.debrisCleared = orig; }
}

function makeArm(state = S.GRAPPLED) {
  const scene = { add: () => {}, remove: () => {} };
  const offset = new THREE.Vector3(M, 0, 0);
  const arm = new ArmUnit('Weaver-1', 'weaver', offset, scene);
  arm.index = 0;
  arm.state = state;
  arm.isDetached = false;
  arm._netRatedMass = 500; // Weaver Medium net rated mass
  arm._netDiameter = 5;    // Weaver Medium net mouth diameter (m)
  return arm;
}

function makeDebris(mass, sizeMeter = 1) {
  return { id: 99, mass, sizeMeter, _captured: true, _capturedByArm: null, _netted: false,
    _isStationKeepTarget: false, _committedNetArmId: null };
}

function attachCatch(arm, debris) {
  arm.capturedDebris = debris;
  debris._capturedByArm = arm;
}

function captureEvent(evt, fn) {
  const got = [];
  const h = (d) => got.push(d);
  eventBus.on(evt, h);
  try { fn(); } finally { eventBus.off(evt, h); }
  return got;
}

describe('ArmUnit capture-failure — reel tension retune', () => {
  it('an in-spec catch (rated mass) reels home WITHOUT snapping', () => {
    eventBus.clear();
    const arm = makeArm(S.REELING);
    attachCatch(arm, makeDebris(500));
    arm.position.set(1, 0, 0);
    const parentPos = new THREE.Vector3(0, 0, 0);
    const snaps = captureEvent(Events.TETHER_SNAP, () => arm._updateReeling(0.016, parentPos, null));
    assert.equal(snaps.length, 0, 'in-spec catch must not snap the tether');
    assert.equal(arm.state, S.REELING, 'arm stays in REELING');
    assert.ok(arm.tetherTension < arm.tetherBreakStrength,
      `tension ${arm.tetherTension.toFixed(1)}N should be under break ${arm.tetherBreakStrength}N`);
  });

  it('a gross overload snaps the tether (catastrophic path, mission 2+)', () => {
    eventBus.clear();
    const arm = makeArm(S.REELING);
    const debris = makeDebris(2000);
    attachCatch(arm, debris);
    arm.position.set(1, 0, 0);
    const parentPos = new THREE.Vector3(0, 0, 0);
    let snaps;
    inMission2(() => {
      snaps = captureEvent(Events.TETHER_SNAP, () => arm._updateReeling(0.016, parentPos, null));
    });
    assert.equal(snaps.length, 1, 'overload emits TETHER_SNAP');
    assert.equal(snaps[0].debrisId, 99, 'snap payload names the lost debris');
    assert.equal(snaps[0].recoverable, false, 'tether snap is not recoverable');
    assert.equal(arm.state, S.EXPENDED, 'snapped arm is EXPENDED');
  });

  it('mission 1 guard: overload is clamped to a warning — NO snap (Item 5d)', () => {
    eventBus.clear();
    const arm = makeArm(S.REELING);
    const debris = makeDebris(2000);
    attachCatch(arm, debris);
    arm.position.set(1, 0, 0);
    const parentPos = new THREE.Vector3(0, 0, 0);
    const orig = gameState.debrisCleared;
    gameState.debrisCleared = 0;        // mission 1
    let snaps, warns;
    try {
      warns = captureEvent(Events.COMMS_MESSAGE, () => {
        snaps = captureEvent(Events.TETHER_SNAP, () => arm._updateReeling(0.016, parentPos, null));
      });
    } finally {
      gameState.debrisCleared = orig;
    }
    assert.equal(snaps.length, 0, 'no TETHER_SNAP during the learning mission');
    assert.equal(arm.state, S.REELING, 'daughter keeps reeling (recoverable)');
    assert.ok(arm.tetherTension <= arm.tetherBreakStrength, 'tension clamped at the limit');
    assert.ok(warns.some(w => /rated limit/i.test(w.text || '')),
      'player is warned the winch absorbed the overload');
  });

  it('reeling drags the catch to the arm (authoritative pin) even if _capturedByArm is stale', () => {
    eventBus.clear();
    const arm = makeArm(S.REELING);
    const debris = makeDebris(100);
    attachCatch(arm, debris);
    debris._capturedByArm = null; // simulate the fragile-pin failure
    arm.position.set(1, 0, 0);
    arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null);
    assert.equal(debris._armPinned, true, 'authoritative arm pin engaged');
    assert.ok(debris._armPinPos, 'arm pin position recorded');
    // Issue 13 (2026-06-12): pin = arm.position + outboard standoff
    // (sizeMeter/2 + ARM_HOLD_CLEARANCE_M) so the daughter never renders
    // inside the catch — no longer coincident with the arm.
    const standoff = (debris.sizeMeter / 2 + Constants.ARM_HOLD_CLEARANCE_M) * M;
    assert.ok(Math.abs(debris._armPinPos.distanceTo(arm.position) - standoff) < 1e-12,
      'catch held at the standoff distance from the arm');
  });
});

describe('ArmUnit capture-failure — tether snap aftermath (no vanish)', () => {
  it('keeps the catch pinned to the drifting daughter and hides the severed line', () => {
    eventBus.clear();
    const arm = makeArm(S.REELING);
    const debris = makeDebris(2000);
    attachCatch(arm, debris);
    arm.position.set(1, 0, 0);
    arm.velocity.set(0, 0, 0);
    const parentPos = new THREE.Vector3(0, 0, 0);
    inMission2(() => arm._updateReeling(0.016, parentPos, null));

    assert.equal(arm._tetherSevered, true, 'tether marked severed');
    assert.equal(arm.isDetached, true, 'daughter is detached from mother');
    assert.equal(arm.tetherLine.visible, false, 'severed line hidden');
    // Catch is NOT removed — still pinned to the (now drifting) daughter.
    assert.equal(debris._capturedByArm, arm, 'debris stays pinned to the daughter');
    assert.equal(debris._netted, true, 'debris tagged as netted');
    assert.equal(arm.capturedDebris, null, 'daughter no longer owns the catch for docking');
    // Recoil pushed the daughter away from the mother.
    assert.ok(arm.velocity.length() > 0, 'recoil impulse applied to the daughter');
  });

  it('releases the orphaned debris pin after the drift delay (no permanent leak)', () => {
    eventBus.clear();
    const arm = makeArm(S.REELING);
    const debris = makeDebris(2000);
    attachCatch(arm, debris);
    arm.position.set(1, 0, 0);
    const parentPos = new THREE.Vector3(0, 0, 0);
    inMission2(() => arm._updateReeling(0.016, parentPos, null));
    assert.equal(debris._capturedByArm, arm, 'initially still pinned to the daughter');

    // Drift just short of the release delay — still pinned.
    const delay = Constants.TETHER_SNAP_RELEASE_DELAY_S;
    arm._updateExpended(delay - 1.0);
    assert.equal(debris._capturedByArm, arm, 'still pinned before the delay elapses');

    // Cross the delay — pin released so the debris resumes orbit + LOD.
    arm._updateExpended(2.0);
    assert.equal(debris._capturedByArm, null, 'pin released after the drift delay');
    assert.equal(arm._severedCatch, null, 'arm stops tracking the released catch');
  });

  it('stops tracking the runaway if another daughter re-captures it', () => {
    eventBus.clear();
    const arm = makeArm(S.REELING);
    const debris = makeDebris(2000);
    attachCatch(arm, debris);
    arm.position.set(1, 0, 0);
    inMission2(() => arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null));

    // Simulate another daughter grabbing the drifting debris (pin transfers).
    const other = makeArm(S.GRAPPLED);
    debris._capturedByArm = other;

    arm._updateExpended(0.5);
    assert.equal(arm._severedCatch, null, 'original arm stops tracking the transferred catch');
    assert.equal(debris._capturedByArm, other, 'pin stays with the new captor');
  });
});

describe('ArmUnit capture-failure — net integrity at reel start', () => {
  it('holds for a comfortably in-spec catch (no roll)', () => {
    eventBus.clear();
    const arm = makeArm(S.GRAPPLED);
    const debris = makeDebris(350); // strain 0.7 < SAFE_FRACTION
    attachCatch(arm, debris);
    const failed = arm._checkNetIntegrityOnReel();
    assert.equal(failed, false, 'in-spec catch holds');
    assert.equal(arm.capturedDebris, debris, 'catch retained');
  });

  it('releases the catch (recoverable) when the strain roll fails', () => {
    eventBus.clear();
    const arm = makeArm(S.GRAPPLED);
    const debris = makeDebris(500); // strain 1.0 → max fail prob
    attachCatch(arm, debris);
    const orig = Math.random;
    Math.random = () => 0; // force the roll to fail
    let failed, events;
    try {
      events = captureEvent(Events.NET_FAILED, () => { failed = arm._checkNetIntegrityOnReel(); });
    } finally {
      Math.random = orig;
    }
    assert.equal(failed, true, 'net failed');
    assert.equal(events.length, 1, 'NET_FAILED emitted');
    assert.equal(events[0].recoverable, true, 'net failure is recoverable');
    assert.equal(arm.state, S.RETURNING, 'daughter returns to reload');
    // Debris released free and re-targetable.
    assert.equal(arm.capturedDebris, null, 'daughter dropped the catch');
    assert.equal(debris._capturedByArm, null, 'pin cleared → resumes orbit + LOD');
    assert.equal(debris._captured, false, 're-targetable by the next daughter');
    assert.equal(debris._netted, true, 'drifting in a net');
  });

  it('holds when the strain roll passes', () => {
    eventBus.clear();
    const arm = makeArm(S.GRAPPLED);
    const debris = makeDebris(500);
    attachCatch(arm, debris);
    const orig = Math.random;
    Math.random = () => 0.999; // roll passes (above max prob)
    let failed;
    try { failed = arm._checkNetIntegrityOnReel(); } finally { Math.random = orig; }
    assert.equal(failed, false, 'net holds when the roll passes');
    assert.equal(arm.capturedDebris, debris, 'catch retained');
  });

  it('deterministically fails when debris is wider than the net mouth', () => {
    eventBus.clear();
    const arm = makeArm(S.GRAPPLED);
    // Light enough to never strain-fail, but physically too wide (8m > 5m mouth).
    const debris = makeDebris(50, 8);
    attachCatch(arm, debris);
    const orig = Math.random;
    Math.random = () => 0.999; // ensure no probabilistic path interferes
    let failed, events;
    try {
      events = captureEvent(Events.NET_FAILED, () => { failed = arm._checkNetIntegrityOnReel(); });
    } finally {
      Math.random = orig;
    }
    assert.equal(failed, true, 'oversized debris fails the net deterministically');
    assert.equal(events.length, 1, 'NET_FAILED emitted');
    assert.equal(events[0].oversized, true, 'flagged as oversize failure');
    assert.equal(arm.state, S.RETURNING, 'daughter returns to reload');
    assert.equal(debris._capturedByArm, null, 'debris released');
  });

  it('holds an in-mouth, in-spec catch (size + mass both fine)', () => {
    eventBus.clear();
    const arm = makeArm(S.GRAPPLED);
    const debris = makeDebris(300, 4); // 4m < 5m mouth, 300 < 0.8*500
    attachCatch(arm, debris);
    const failed = arm._checkNetIntegrityOnReel();
    assert.equal(failed, false, 'in-spec catch holds');
    assert.equal(arm.capturedDebris, debris, 'catch retained');
  });
});
