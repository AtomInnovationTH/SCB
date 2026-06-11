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

describe('ArmUnit park-the-catch — staged furnace breakdown (Item 1)', () => {
  const FT = Constants.FURNACE_TRANSFER;

  // Capture several event types across a manual HOLDING_CATCH timeline. We drive
  // stateTimer by hand (update() owns the increment in the live loop) and step in
  // small slices so the chunk-spacing logic is exercised like the real cadence.
  function runBreakdown(arm, debris, { dt = 0.25, until = FT.FEED_S + 0.3 } = {}) {
    const log = [];
    const types = [
      Events.CATCH_BREAKDOWN_START,
      Events.CATCH_BREAKDOWN_CHUNK,
      Events.NET_CONSUMED,
      Events.CATCH_PROCESSED,
    ];
    const handlers = types.map((evt) => {
      const h = (d) => log.push({ evt, d });
      eventBus.on(evt, h);
      return [evt, h];
    });
    try {
      arm.state = S.HOLDING_CATCH;
      arm.stateTimer = 0;
      arm._breakdownStarted = false;
      arm._breakdownChunksFired = 0;
      for (let t = 0; t <= until && arm.state === S.HOLDING_CATCH; t += dt) {
        arm.stateTimer = t;
        arm._updateHoldingCatch(dt, new THREE.Vector3(0, 0, 0), null);
      }
    } finally {
      handlers.forEach(([evt, h]) => eventBus.off(evt, h));
    }
    return log;
  }

  it('keeps the catch cinched (pinned + _capturedByArm) through the hold phase', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const debris = makeDebris(100);
    attachCatch(arm, debris);
    arm.state = S.HOLDING_CATCH;
    arm.stateTimer = FT.HOLD_S - 0.1;   // still holding

    arm._updateHoldingCatch(0.016, new THREE.Vector3(0, 0, 0), null);
    assert.equal(arm.state, S.HOLDING_CATCH, 'still parked during hold');
    assert.equal(debris._armPinned, true, 'catch pinned full-size during hold');
    assert.equal(debris._capturedByArm, arm, 'net stays cinched during hold');
    assert.ok(!debris._breakdownActive, 'breakdown not yet active during hold');
  });

  it('fires BREAKDOWN_START once at chop and releases the net cinch', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const debris = makeDebris(100);
    attachCatch(arm, debris);
    const log = runBreakdown(arm, debris);

    const starts = log.filter((e) => e.evt === Events.CATCH_BREAKDOWN_START);
    assert.equal(starts.length, 1, 'CATCH_BREAKDOWN_START fires exactly once');
    assert.equal(starts[0].d.chunkCount, FT.CHUNK_COUNT, 'announces the chunk count');
    assert.equal(starts[0].d.debrisId, debris.id, 'names the catch');
  });

  it('emits CHUNK_COUNT chunk events, then exactly one CATCH_PROCESSED, in order', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const debris = makeDebris(100);
    attachCatch(arm, debris);
    const log = runBreakdown(arm, debris);

    const chunks = log.filter((e) => e.evt === Events.CATCH_BREAKDOWN_CHUNK);
    const processed = log.filter((e) => e.evt === Events.CATCH_PROCESSED);
    const consumed = log.filter((e) => e.evt === Events.NET_CONSUMED);

    assert.equal(chunks.length, FT.CHUNK_COUNT, 'one event per chunk');
    chunks.forEach((c, i) => {
      assert.equal(c.d.index, i, `chunk ${i} indexed in order`);
      assert.equal(c.d.total, FT.CHUNK_COUNT, 'chunk carries the total');
    });
    assert.equal(processed.length, 1, 'CATCH_PROCESSED fires exactly once (single-fire contract)');
    assert.equal(consumed.length, 1, 'NET_CONSUMED fires once (net fed in with the catch)');

    // Ordering: START → all CHUNKs → PROCESSED (last).
    const order = log.map((e) => e.evt);
    assert.equal(order[0], Events.CATCH_BREAKDOWN_START, 'START is first');
    assert.equal(order[order.length - 1], Events.CATCH_PROCESSED, 'PROCESSED is last');
    const lastChunkIdx = order.lastIndexOf(Events.CATCH_BREAKDOWN_CHUNK);
    const processedIdx = order.indexOf(Events.CATCH_PROCESSED);
    assert.ok(lastChunkIdx < processedIdx, 'all chunks precede CATCH_PROCESSED');
  });

  it('CATCH_PROCESSED payload is unchanged (armId, debrisId, type) and single-fire', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const debris = makeDebris(100);
    attachCatch(arm, debris);
    const log = runBreakdown(arm, debris);

    const processed = log.filter((e) => e.evt === Events.CATCH_PROCESSED);
    assert.equal(processed.length, 1, 'exactly one CATCH_PROCESSED');
    assert.deepEqual(
      Object.keys(processed[0].d).sort(),
      ['armId', 'debrisId', 'type'].sort(),
      'payload keys unchanged (bosses/persistence contract)',
    );
    assert.equal(processed[0].d.armId, arm.id);
    assert.equal(processed[0].d.debrisId, debris.id);
    assert.equal(processed[0].d.type, arm.type);
    assert.equal(arm.state, S.RELOADING, 'daughter reloads at feed end');
    assert.equal(arm.capturedDebris, null, 'catch cleared');
    assert.equal(debris._armPinned, false, 'pin released to the furnace');
    assert.equal(debris._breakdownActive, false, 'breakdown flag cleared on completion');
  });

  it('flushes all chunks even if the timer jumps straight past the feed window', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const debris = makeDebris(100);
    attachCatch(arm, debris);
    arm.state = S.HOLDING_CATCH;
    arm._breakdownStarted = false;
    arm._breakdownChunksFired = 0;

    // One big frame: hold→chop is skipped (no START), jump straight to feed-end.
    // _updateHoldingCatch fires START lazily then flushes all chunks before PROCESSED.
    const log = [];
    const types = [Events.CATCH_BREAKDOWN_START, Events.CATCH_BREAKDOWN_CHUNK, Events.CATCH_PROCESSED];
    const hs = types.map((evt) => { const h = (d) => log.push({ evt, d }); eventBus.on(evt, h); return [evt, h]; });
    try {
      arm.stateTimer = FT.FEED_S + 0.5;
      arm._updateHoldingCatch(0.016, new THREE.Vector3(0, 0, 0), null);
    } finally { hs.forEach(([evt, h]) => eventBus.off(evt, h)); }

    const chunks = log.filter((e) => e.evt === Events.CATCH_BREAKDOWN_CHUNK);
    assert.equal(log.filter((e) => e.evt === Events.CATCH_BREAKDOWN_START).length, 1, 'START still fires');
    assert.equal(chunks.length, FT.CHUNK_COUNT, 'all chunks flushed before completion');
    assert.equal(log.filter((e) => e.evt === Events.CATCH_PROCESSED).length, 1, 'one CATCH_PROCESSED');
  });

  it('DURATION_S getter mirrors the feed-window end (back-compat)', () => {
    assert.equal(FT.DURATION_S, FT.FEED_S, 'DURATION_S derives from FEED_S');
  });
});

describe('ArmUnit park-the-catch — tether hidden while parked (Item 5)', () => {
  it('hides the tether in HOLDING_CATCH (no stray wrong-direction line)', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const debris = makeDebris(100);
    attachCatch(arm, debris);
    arm.state = S.HOLDING_CATCH;
    arm.tetherLine.visible = true;   // force-on; _updateTether must hide it
    const parentPos = new THREE.Vector3(0, 0, 0);
    arm._updateTether(parentPos, null, 0.016);
    assert.equal(arm.tetherLine.visible, false,
      'parked daughter shows no tether (matches DOCKED/RELOADING)');
  });

  it('still renders the tether in a genuinely deployed state (contrast)', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    arm.state = S.TRANSIT;
    arm.position.set(50 * M, 0, 0);
    arm._updateTether(new THREE.Vector3(0, 0, 0), null, 0.016);
    assert.equal(arm.tetherLine.visible, true, 'a deployed daughter keeps her tether');
  });
});

describe('ArmUnit park-the-catch — attitude deferred to postArmUpdate (Item 4)', () => {
  it('does NOT slew the daughter toward the raw mother quat in HOLDING_CATCH', () => {
    eventBus.clear();
    const arm = makeArm('weaver');
    const debris = makeDebris(100);
    attachCatch(arm, debris);
    arm.state = S.HOLDING_CATCH;
    arm.stateTimer = 0;

    // A distinct starting orientation; a mother quat far from it.
    const start = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.0);
    arm.group.quaternion.copy(start);
    const parentQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const parentPos = new THREE.Vector3(0, 0, 0);

    arm.update(0.016, parentPos, parentQuat);

    // The generic attitude branch must be SKIPPED for HOLDING_CATCH — otherwise it
    // would slerp group.quaternion toward parentQuat (the wrong-basis defect).
    // PlayerSatellite.postArmUpdate owns the strut-basis orientation instead.
    assert.ok(arm.group.quaternion.angleTo(start) < 1e-9,
      'HOLDING_CATCH leaves orientation for postArmUpdate (no parentQuat slew)');
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
