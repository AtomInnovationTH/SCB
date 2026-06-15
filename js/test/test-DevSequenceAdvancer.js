/**
 * test-DevSequenceAdvancer.js — Space "do the next thing" resolver coverage.
 *
 * Verifies the pure step-resolution order for the rapid-advance Space key:
 *   capture (piloting) > scan > target > autopilot > deploy (daughter-first) > net
 * and that nothing-actionable resolves to null.
 */
import { describe, it, assert } from './TestRunner.js';
import { DEV_ACTIONS, resolveNextDevAction } from '../systems/DevSequenceAdvancer.js';

// Baseline: target selected, in range, daughter available (the "deploy" case).
function base(overrides = {}) {
  return Object.assign({
    armPilotMode: false,
    pilotedArmState: null,
    hasTarget: true,
    trackedContacts: 3,
    inCaptureRange: true,
    canDeployDaughter: true,
    autopilotActive: false,
  }, overrides);
}

describe('DevSequenceAdvancer — step resolution', () => {
  it('empty field → scan', () => {
    assert.equal(resolveNextDevAction(base({ trackedContacts: 0, hasTarget: false })),
      DEV_ACTIONS.SCAN);
  });

  it('contacts but no target → target', () => {
    assert.equal(resolveNextDevAction(base({ hasTarget: false })),
      DEV_ACTIONS.TARGET);
  });

  it('target out of range, autopilot off → autopilot', () => {
    assert.equal(resolveNextDevAction(base({ inCaptureRange: false, autopilotActive: false })),
      DEV_ACTIONS.AUTOPILOT);
  });

  it('target out of range, autopilot already running → null (no double-engage)', () => {
    assert.equal(resolveNextDevAction(base({ inCaptureRange: false, autopilotActive: true })),
      null);
  });

  it('target in range, daughter available → deploy (daughter-first)', () => {
    assert.equal(resolveNextDevAction(base({ canDeployDaughter: true })),
      DEV_ACTIONS.DEPLOY);
  });

  it('target in range, no daughter → net (fallback)', () => {
    assert.equal(resolveNextDevAction(base({ canDeployDaughter: false })),
      DEV_ACTIONS.NET);
  });

  it('piloting a daughter in STATION_KEEP → capture (highest priority)', () => {
    assert.equal(resolveNextDevAction(base({
      armPilotMode: true, pilotedArmState: 'STATION_KEEP',
    })), DEV_ACTIONS.CAPTURE);
  });

  it('piloting a daughter in TRANSIT → capture', () => {
    assert.equal(resolveNextDevAction(base({
      armPilotMode: true, pilotedArmState: 'TRANSIT',
    })), DEV_ACTIONS.CAPTURE);
  });

  it('piloting a daughter in APPROACH → capture', () => {
    assert.equal(resolveNextDevAction(base({
      armPilotMode: true, pilotedArmState: 'APPROACH',
    })), DEV_ACTIONS.CAPTURE);
  });

  it('capture beats deploy when both could apply', () => {
    // Piloting + in-range + daughter available: capture must win.
    assert.equal(resolveNextDevAction(base({
      armPilotMode: true, pilotedArmState: 'STATION_KEEP',
      inCaptureRange: true, canDeployDaughter: true,
    })), DEV_ACTIONS.CAPTURE);
  });

  it('piloting but arm in a non-capture state → falls through to loop steps', () => {
    // e.g. arm is RETURNING; no contacts → scan.
    assert.equal(resolveNextDevAction(base({
      armPilotMode: true, pilotedArmState: 'RETURNING',
      trackedContacts: 0, hasTarget: false,
    })), DEV_ACTIONS.SCAN);
  });

  it('empty / undefined snapshot → scan (safe default)', () => {
    assert.equal(resolveNextDevAction(undefined), DEV_ACTIONS.SCAN);
    assert.equal(resolveNextDevAction({}), DEV_ACTIONS.SCAN);
  });
});
