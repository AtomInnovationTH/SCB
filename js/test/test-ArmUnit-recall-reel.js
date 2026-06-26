/**
 * test-ArmUnit-recall-reel.js — Mother reel-in for stuck / out-of-fuel daughters.
 *
 * Design (Adrift rework): a TETHERED daughter is NEVER abandoned as EXPENDED for
 * low fuel — the strut/tether reel motor lives on the mothership, so she is
 * always pulled home on the zero-fuel winch (her emergency FEEP reserve funds
 * the soft-dock arrest). Only a DETACHED daughter (severed tether) is beyond
 * reel-in. EXPENDED is reserved for genuinely-lost daughters (tether snapped,
 * detached & out of range/fuel, deorbit complete).
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

describe('ArmUnit.recall — mother reel of out-of-fuel daughter', () => {
  it('low-fuel TETHERED daughter is REELED home (never EXPENDED), self-recall too', () => {
    eventBus.clear();
    const arm = makeArm(S.TRANSIT);
    arm.fuel = 1; // below the reserve floor
    const msgs = captureComms(() => arm.recall()); // default = NOT mother-initiated
    assert.equal(arm.state, S.REELING, 'a tethered daughter is winched home, not abandoned');
    assert.notEqual(arm.state, S.EXPENDED, 'tethered low-fuel daughter is never EXPENDED');
    const reelMsg = msgs.find(m => m.text && m.text.includes('Reeling') && m.text.includes('tether'));
    assert.ok(reelMsg, 'posts a plain-language reel-home comms');
  });

  it('low-fuel daughter recalled FROM the mother is REELED home (zero-fuel), not EXPENDED', () => {
    eventBus.clear();
    const arm = makeArm(S.TRANSIT);
    arm.fuel = 1;
    const msgs = captureComms(() => arm.recall({ motherInitiated: true }));
    assert.equal(arm.state, S.REELING, 'mother-initiated recall reels a stuck daughter home');
    const reelMsg = msgs.find(m => m.text && m.text.includes('Reeling') && m.text.includes('tether'));
    assert.ok(reelMsg, 'posts a plain-language "Reeling ... home on the tether" comms');
    assert.ok(reelMsg.text.includes('Large 1'), 'names the daughter');
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

describe('ArmUnit — emergency FEEP reserve / ADRIFT (tethered, recoverable)', () => {
  const RESERVE = Constants.ARM_RESERVE_FUEL ?? 5;

  it('a TETHERED working daughter that runs dry goes ADRIFT (not EXPENDED) and holds the reserve', () => {
    eventBus.clear();
    const arm = makeArm(S.TRANSIT);
    arm.fuel = RESERVE + 0.1; // one tick from the floor
    const msgs = captureComms(() => arm._consumeFuel(10)); // big dt drives fuel through the floor
    assert.equal(arm.state, S.ADRIFT, 'working daughter holds on the tether, not abandoned');
    assert.notEqual(arm.state, S.EXPENDED, 'never expended while tethered');
    assert.ok(Math.abs(arm.fuel - RESERVE) < 1e-9, 'the emergency reserve is preserved');
    const adriftMsg = msgs.find(m => m.text && m.text.toLowerCase().includes('tether'));
    assert.ok(adriftMsg, 'posts a clear, plain-language adrift comms (mentions the tether)');
  });

  it('a DETACHED daughter that runs dry is genuinely lost (ARM_LOST + EXPENDED)', () => {
    eventBus.clear();
    const arm = makeArm(S.TRANSIT);
    arm.isDetached = true;
    arm.fuel = 0.2;
    let lost = false;
    eventBus.on(Events.ARM_LOST, () => { lost = true; });
    arm._consumeFuel(10);
    assert.equal(arm.state, S.EXPENDED, 'no winch for a severed tether — she is lost');
    assert.ok(lost, 'ARM_LOST fires for the detached daughter');
  });

  it('an ADRIFT daughter can be reeled home on the winch', () => {
    eventBus.clear();
    const arm = makeArm(S.ADRIFT);
    arm.fuel = RESERVE;
    arm.recall();
    assert.equal(arm.state, S.REELING, 'the mother winches an adrift daughter home');
  });

  it('an ADRIFT daughter can be disconnected (detach severs the tether)', () => {
    eventBus.clear();
    const arm = makeArm(S.ADRIFT);
    arm.fuel = RESERVE;
    const ok = arm.detach();
    assert.equal(ok, true, 'detach succeeds from ADRIFT');
    assert.equal(arm.isDetached, true, 'tether severed');
  });

  it('deorbit is disabled for an out-of-fuel daughter (suggests reel-in)', () => {
    eventBus.clear();
    const arm = makeArm(S.ADRIFT);
    arm.fuel = RESERVE;
    const msgs = captureComms(() => {
      const res = arm.startDeorbit();
      assert.equal(res.success, false, 'no deorbit burn without usable FEEP');
    });
    const hint = msgs.find(m => m.text && m.text.toLowerCase().includes('reel her in'));
    assert.ok(hint, 'comms steers the player to reel her in instead');
  });
});
