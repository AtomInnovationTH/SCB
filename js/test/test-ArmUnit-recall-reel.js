/**
 * test-ArmUnit-recall-reel.js — Mother-initiated reel-in for stuck / out-of-fuel
 * daughters (guidance/onboarding fixes §4).
 *
 * A daughter recalled by its own FEEP burn at low fuel is EXPENDED (cannot make
 * it home). But a daughter recalled FROM the mothership is pulled home on the
 * mothership's zero-fuel strut/tether reel motor, so it must enter REELING even
 * when out of fuel — it should never be abandoned as EXPENDED.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

const S = Constants.ARM_STATES;
const M = 0.00001; // scene-scale factor (1 unit = 100km), as in other ArmUnit tests

function makeArm(state = S.TRANSIT) {
  const scene = { add: () => {}, remove: () => {} };
  const offset = new THREE.Vector3(M, 0, 0);
  const arm = new ArmUnit('Weaver-1', 'weaver', offset, scene);
  arm.index = 0;
  arm.state = state;
  arm.isDetached = false;
  return arm;
}

/** Capture COMMS_MESSAGE emissions during fn(). */
function captureComms(fn) {
  const msgs = [];
  const handler = (d) => msgs.push(d);
  eventBus.on(Events.COMMS_MESSAGE, handler);
  try {
    fn();
  } finally {
    eventBus.off(Events.COMMS_MESSAGE, handler);
  }
  return msgs;
}

describe('ArmUnit.recall — mother-initiated reel of out-of-fuel daughter', () => {
  it('low-fuel daughter recalled by its OWN FEEP burn is EXPENDED', () => {
    eventBus.clear();
    const arm = makeArm(S.TRANSIT);
    arm.fuel = 1; // below the <=2 threshold
    arm.recall(); // default = NOT mother-initiated
    assert.equal(arm.state, S.EXPENDED, 'self-recall at low fuel expends the arm');
  });

  it('low-fuel daughter recalled FROM the mother is REELED home (zero-fuel), not EXPENDED', () => {
    eventBus.clear();
    const arm = makeArm(S.TRANSIT);
    arm.fuel = 1;
    const msgs = captureComms(() => arm.recall({ motherInitiated: true }));
    assert.equal(arm.state, S.REELING, 'mother-initiated recall reels a stuck daughter home');
    const reelMsg = msgs.find(m => m.text && m.text.includes('Reeling') && m.text.includes('tether'));
    assert.ok(reelMsg, 'posts a plain-language "Reeling ... home on the tether" comms');
    assert.ok(reelMsg.text.includes('Weaver-1'), 'names the daughter');
  });

  it('fuelled daughter recalled from the mother reels home without the low-fuel comms', () => {
    eventBus.clear();
    const arm = makeArm(S.TRANSIT);
    arm.fuel = 80;
    const msgs = captureComms(() => arm.recall({ motherInitiated: true }));
    assert.equal(arm.state, S.REELING, 'a healthy daughter reels home too');
    const reelMsg = msgs.find(m => m.text && m.text.includes('Reeling') && m.text.includes('tether'));
    assert.equal(reelMsg, undefined, 'no stuck-daughter tether comms when fuel is healthy');
  });

  it('STATION_KEEP daughter recalled from the mother exits SK cleanly into REELING', () => {
    eventBus.clear();
    const arm = makeArm(S.STATION_KEEP);
    arm.fuel = 1;
    // Fake an SK target with the flag the reel path is expected to clear.
    const skTarget = { _isStationKeepTarget: true };
    arm._stationKeepTarget = skTarget;
    arm.recall({ motherInitiated: true });
    assert.equal(arm.state, S.REELING, 'SK recall transitions to REELING');
    assert.equal(arm._stationKeepTarget, null, 'SK target reference cleared');
    assert.equal(skTarget._isStationKeepTarget, false, 'SK target flag cleared on the debris');
  });

  it('detached daughter cannot be reeled (tether severed) regardless of mother-initiation', () => {
    eventBus.clear();
    const arm = makeArm(S.TRANSIT);
    arm.fuel = 1;
    arm.isDetached = true;
    arm.recall({ motherInitiated: true });
    assert.notEqual(arm.state, S.REELING, 'detached arm is not reeled');
    assert.notEqual(arm.state, S.EXPENDED, 'detached recall is a guarded no-op (state unchanged)');
    assert.equal(arm.state, S.TRANSIT, 'state unchanged for detached arm');
  });
});
