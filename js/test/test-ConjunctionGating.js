/**
 * test-ConjunctionGating.js — ST-2.1 Conjunction Alert Gating
 *
 * Tests capture-count gating, missionElapsed gating, first-alert GREEN forcing,
 * comms primer emission, and capture count incrementing.
 *
 * Node-safe: no DOM, no THREE.js dependencies.
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { eventBus }  from '../core/EventBus.js';
import { Events }    from '../core/Events.js';
import { ConjunctionSystem } from '../systems/ConjunctionSystem.js';

// ============================================================================
// HELPERS
// ============================================================================

/** Create a fresh ConjunctionSystem with a clean EventBus. */
function makeSystem() {
  eventBus.clear();
  const sys = new ConjunctionSystem();
  // ST-4.C: Enable conjunction alerts by default for these tests
  // (they test the capture-count/elapsed gating, not mission profile gating)
  sys._conjunctionAllowed = true;
  return sys;
}

/** Track emitted events — returns a growing array of { event, data }. */
function trackEvents(...names) {
  const log = [];
  names.forEach(n => eventBus.on(n, d => log.push({ event: n, data: d })));
  return log;
}

/** Create a minimal mock debris object. */
function mockDebris(id = 1, type = 'fragment') {
  return { id, type, alive: true };
}

const MOCK_EVASION = { x: 0, y: 1, z: 0 };
const M = 0.00001; // 1 metre in scene units (must match ConjunctionSystem)

// ============================================================================
// SUITE 1: Capture count tracking
// ============================================================================

describe('ConjunctionGating — Capture count tracking', () => {
  it('_captureCount starts at 0', () => {
    const sys = makeSystem();
    assert.equal(sys._captureCount, 0);
  });

  it('ARM_CAPTURED increments _captureCount', () => {
    const sys = makeSystem();
    eventBus.emit(Events.ARM_CAPTURED, { armId: 0, debrisId: 1 });
    assert.equal(sys._captureCount, 1);
    eventBus.emit(Events.ARM_CAPTURED, { armId: 1, debrisId: 2 });
    assert.equal(sys._captureCount, 2);
  });

  it('LASSO_CAPTURED increments _captureCount', () => {
    const sys = makeSystem();
    eventBus.emit(Events.LASSO_CAPTURED, { debrisId: 3 });
    assert.equal(sys._captureCount, 1);
  });

  it('mixed ARM + LASSO captures accumulate correctly', () => {
    const sys = makeSystem();
    eventBus.emit(Events.ARM_CAPTURED, {});
    eventBus.emit(Events.LASSO_CAPTURED, {});
    eventBus.emit(Events.ARM_CAPTURED, {});
    assert.equal(sys._captureCount, 3);
  });

  it('_firstCaptureTime set on first capture only', () => {
    const sys = makeSystem();
    assert.equal(sys._firstCaptureTime, null, 'should be null before any capture');
    sys._missionElapsed = 45;
    eventBus.emit(Events.ARM_CAPTURED, {});
    assert.equal(sys._firstCaptureTime, 45, 'should record mission time of first capture');
    // Second capture should NOT update it
    sys._missionElapsed = 60;
    eventBus.emit(Events.ARM_CAPTURED, {});
    assert.equal(sys._firstCaptureTime, 45, 'should not change on subsequent captures');
  });
});

// ============================================================================
// SUITE 2: No alert when captureCount = 0
// ============================================================================

describe('ConjunctionGating — No alert when captureCount = 0', () => {
  it('_emitAlert suppressed when _captureCount is 0', () => {
    const sys = makeSystem();
    sys._missionElapsed = 999;
    const log = trackEvents(Events.CONJUNCTION_WARNING);

    sys._emitAlert('RED', mockDebris(), 30, 100 * M, MOCK_EVASION);
    assert.equal(log.length, 0, 'should not emit when captureCount = 0');
  });

  it('_emitAlert suppressed even for close miss distance when captureCount = 0', () => {
    const sys = makeSystem();
    sys._missionElapsed = 500;
    const log = trackEvents(Events.CONJUNCTION_WARNING);

    sys._emitAlert('RED', mockDebris(), 10, 50 * M, MOCK_EVASION);
    assert.equal(log.length, 0, 'close miss with 0 captures should still be suppressed');
  });
});

// ============================================================================
// SUITE 3: Elapsed time gating (120s after first capture)
// ============================================================================

describe('ConjunctionGating — Elapsed time gating', () => {
  it('no alert before MIN_ELAPSED_S after first capture', () => {
    const sys = makeSystem();
    sys._missionElapsed = 50;
    eventBus.emit(Events.ARM_CAPTURED, {}); // capture at t=50

    // Try at t=100 → only 50s since capture, need 120s
    sys._missionElapsed = 100;
    const log = trackEvents(Events.CONJUNCTION_WARNING);
    sys._emitAlert('YELLOW', mockDebris(), 20, 300 * M, MOCK_EVASION);
    assert.equal(log.length, 0, 'should suppress alert before 120s elapsed since capture');
  });

  it('alert fires (via primer) after MIN_ELAPSED_S elapsed since capture', () => {
    const sys = makeSystem();
    sys._missionElapsed = 10;
    eventBus.emit(Events.ARM_CAPTURED, {}); // capture at t=10

    // Advance past 120s since capture → t=10+121=131
    sys._missionElapsed = 131;
    const log = trackEvents(Events.CONJUNCTION_WARNING, Events.COMMS_MESSAGE);
    sys._emitAlert('YELLOW', mockDebris(), 20, 300 * M, MOCK_EVASION);

    // First alert triggers primer, not immediate warning
    const commsMsgs = log.filter(e => e.event === Events.COMMS_MESSAGE);
    assert.equal(commsMsgs.length, 1, 'comms primer should fire for first alert');
    assert.ok(sys._primerTimer > 0, 'primer timer should be positive');
  });

  it('exact boundary: elapsed == MIN_ELAPSED_S fires (>=, not >)', () => {
    const sys = makeSystem();
    sys._missionElapsed = 0;
    eventBus.emit(Events.ARM_CAPTURED, {}); // capture at t=0

    sys._missionElapsed = Constants.CONJUNCTION.MIN_ELAPSED_S; // exactly 120s
    const log = trackEvents(Events.CONJUNCTION_WARNING, Events.COMMS_MESSAGE);
    sys._emitAlert('GREEN', mockDebris(), 30, 2000 * M, MOCK_EVASION);
    const comms = log.filter(e => e.event === Events.COMMS_MESSAGE);
    assert.equal(comms.length, 1, 'exactly MIN_ELAPSED_S should trigger primer (>= boundary)');
  });
});

// ============================================================================
// SUITE 4: First alert forced to GREEN tier
// ============================================================================

describe('ConjunctionGating — First alert forced GREEN', () => {
  it('first pending alert tier is GREEN regardless of actual RED tier', () => {
    const sys = makeSystem();
    sys._missionElapsed = 0;
    eventBus.emit(Events.ARM_CAPTURED, {}); // capture at t=0
    sys._missionElapsed = 121;

    sys._emitAlert('RED', mockDebris(), 10, 50 * M, MOCK_EVASION);
    assert.ok(sys._pendingFirstAlert, 'should have a pending first alert');
    assert.equal(sys._pendingFirstAlert.tier, 'GREEN', 'pending tier should be forced GREEN');
  });

  it('first pending alert tier is GREEN regardless of actual YELLOW tier', () => {
    const sys = makeSystem();
    sys._missionElapsed = 0;
    eventBus.emit(Events.ARM_CAPTURED, {});
    sys._missionElapsed = 121;

    sys._emitAlert('YELLOW', mockDebris(), 20, 300 * M, MOCK_EVASION);
    assert.equal(sys._pendingFirstAlert.tier, 'GREEN', 'YELLOW should be forced to GREEN');
  });

  it('second alert uses actual tier (not forced GREEN)', () => {
    const sys = makeSystem();
    sys._missionElapsed = 0;
    eventBus.emit(Events.ARM_CAPTURED, {});
    sys._missionElapsed = 200;

    // Mark first alert as complete
    sys._firstAlertFired = true;
    sys._primerSent = true;

    const log = trackEvents(Events.CONJUNCTION_WARNING);
    sys._emitAlert('RED', mockDebris(), 10, 50 * M, MOCK_EVASION);

    assert.equal(log.length, 1, 'should emit warning');
    assert.equal(log[0].data.tier, 'RED', 'second alert should use actual tier');
  });
});

// ============================================================================
// SUITE 5: Comms primer emission
// ============================================================================

describe('ConjunctionGating — Comms primer', () => {
  it('comms primer fires before first alert (CONJUNCTION_WARNING deferred)', () => {
    const sys = makeSystem();
    sys._missionElapsed = 0;
    eventBus.emit(Events.ARM_CAPTURED, {});
    sys._missionElapsed = 150;

    const log = trackEvents(Events.COMMS_MESSAGE, Events.CONJUNCTION_WARNING);
    sys._emitAlert('GREEN', mockDebris(), 30, 1000 * M, MOCK_EVASION);

    const comms = log.filter(e => e.event === Events.COMMS_MESSAGE);
    const warns = log.filter(e => e.event === Events.CONJUNCTION_WARNING);
    assert.equal(comms.length, 1, 'comms primer should fire once');
    assert.equal(warns.length, 0, 'CONJUNCTION_WARNING should NOT fire yet (primer delay)');
    assert.ok(comms[0].data.text.includes('CONJUNCTION TRACKING ONLINE'), 'primer text present');
  });

  it('primer timer set to PRIMER_LEAD_S', () => {
    const sys = makeSystem();
    sys._missionElapsed = 0;
    eventBus.emit(Events.ARM_CAPTURED, {});
    sys._missionElapsed = 150;

    sys._emitAlert('GREEN', mockDebris(), 30, 1000 * M, MOCK_EVASION);
    assert.equal(sys._primerTimer, Constants.CONJUNCTION.PRIMER_LEAD_S,
      `primerTimer should be ${Constants.CONJUNCTION.PRIMER_LEAD_S}s`);
  });

  it('additional _emitAlert calls ignored while primer is pending', () => {
    const sys = makeSystem();
    sys._missionElapsed = 0;
    eventBus.emit(Events.ARM_CAPTURED, {});
    sys._missionElapsed = 150;

    // First call triggers primer
    sys._emitAlert('RED', mockDebris(1), 30, 100 * M, MOCK_EVASION);
    assert.ok(sys._pendingFirstAlert, 'pending alert set');

    // Second call while primer pending — should be ignored
    const log = trackEvents(Events.COMMS_MESSAGE, Events.CONJUNCTION_WARNING);
    sys._emitAlert('RED', mockDebris(2), 10, 50 * M, MOCK_EVASION);
    assert.equal(log.length, 0, 'second call should be ignored while primer pending');
  });

  it('_doEmitAlert fires the stored first alert and sets firstAlertFired', () => {
    const sys = makeSystem();
    sys._missionElapsed = 0;
    eventBus.emit(Events.ARM_CAPTURED, {});
    sys._missionElapsed = 150;

    // Trigger primer
    sys._emitAlert('RED', mockDebris(42, 'rocketBody'), 25, 200 * M, MOCK_EVASION);
    const p = sys._pendingFirstAlert;
    assert.ok(p, 'pending alert should exist');

    // Simulate what update() does when timer expires
    const log = trackEvents(Events.CONJUNCTION_WARNING);
    sys._pendingFirstAlert = null;
    sys._doEmitAlert(p.tier, p.debris, p.tca, p.distScene, p.evasionVector);

    assert.equal(log.length, 1, 'should emit CONJUNCTION_WARNING');
    assert.equal(log[0].data.tier, 'GREEN', 'first alert should be GREEN');
    assert.equal(log[0].data.debrisId, 42, 'debrisId should match');
    assert.equal(sys._firstAlertFired, true, 'firstAlertFired should be true');
  });
});

// ============================================================================
// SUITE 6: Normal operation after gating
// ============================================================================

describe('ConjunctionGating — Normal operation after gating', () => {
  it('alerts fire normally after first alert is complete', () => {
    const sys = makeSystem();
    sys._missionElapsed = 0;
    eventBus.emit(Events.ARM_CAPTURED, {});
    sys._missionElapsed = 200;
    sys._firstAlertFired = true;
    sys._primerSent = true;

    const log = trackEvents(Events.CONJUNCTION_WARNING);
    sys._emitAlert('YELLOW', mockDebris(10), 15, 400 * M, MOCK_EVASION);

    assert.equal(log.length, 1, 'should emit normally after first alert');
    assert.equal(log[0].data.tier, 'YELLOW', 'tier should match actual threat');
  });

  it('alert count increments on each emission', () => {
    const sys = makeSystem();
    sys._missionElapsed = 0;
    eventBus.emit(Events.ARM_CAPTURED, {});
    sys._missionElapsed = 200;
    sys._firstAlertFired = true;
    sys._primerSent = true;

    sys._emitAlert('GREEN', mockDebris(1), 30, 2000 * M, MOCK_EVASION);
    sys._emitAlert('YELLOW', mockDebris(2), 20, 300 * M, MOCK_EVASION);

    assert.equal(sys._alertCount, 2, 'should have 2 alerts');
  });

  it('alertNumber in event payload is sequential', () => {
    const sys = makeSystem();
    sys._missionElapsed = 0;
    eventBus.emit(Events.ARM_CAPTURED, {});
    sys._missionElapsed = 200;
    sys._firstAlertFired = true;
    sys._primerSent = true;

    const log = trackEvents(Events.CONJUNCTION_WARNING);
    sys._emitAlert('GREEN', mockDebris(1), 30, 2000 * M, MOCK_EVASION);
    sys._emitAlert('YELLOW', mockDebris(2), 20, 300 * M, MOCK_EVASION);

    assert.equal(log[0].data.alertNumber, 1);
    assert.equal(log[1].data.alertNumber, 2);
  });
});

// ============================================================================
// SUITE 7: Reset clears gating state
// ============================================================================

describe('ConjunctionGating — Reset', () => {
  it('reset() clears all gating state', () => {
    const sys = makeSystem();
    sys._captureCount = 5;
    sys._missionElapsed = 300;
    sys._firstCaptureTime = 10;
    sys._firstAlertFired = true;
    sys._primerSent = true;
    sys._primerTimer = 2;
    sys._pendingFirstAlert = { tier: 'GREEN' };

    sys.reset();

    assert.equal(sys._captureCount, 0, 'captureCount should reset');
    assert.equal(sys._missionElapsed, 0, 'missionElapsed should reset');
    assert.equal(sys._firstCaptureTime, null, 'firstCaptureTime should reset');
    assert.equal(sys._firstAlertFired, false, 'firstAlertFired should reset');
    assert.equal(sys._primerSent, false, 'primerSent should reset');
    assert.equal(sys._primerTimer, 0, 'primerTimer should reset');
    assert.equal(sys._pendingFirstAlert, null, 'pendingFirstAlert should reset');
  });
});

// ============================================================================
// SUITE 8: Constants validation
// ============================================================================

describe('ConjunctionGating — Constants', () => {
  it('CONJUNCTION.MIN_CAPTURES exists and equals 1', () => {
    assert.equal(Constants.CONJUNCTION.MIN_CAPTURES, 1);
  });

  it('CONJUNCTION.MIN_ELAPSED_S exists and equals 120', () => {
    assert.equal(Constants.CONJUNCTION.MIN_ELAPSED_S, 120);
  });

  it('CONJUNCTION.PRIMER_LEAD_S exists and equals 5', () => {
    assert.equal(Constants.CONJUNCTION.PRIMER_LEAD_S, 5);
  });
});
