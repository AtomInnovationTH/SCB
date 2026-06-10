/**
 * test-bossLifecycle.js — shared boss primitives (ThreatSet, extractDebrisId,
 * awardElevatorMass). Pure / Node-safe.
 */
import { describe, it, assert } from './TestRunner.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { ThreatSet, extractDebrisId, awardElevatorMass } from '../systems/_bossLifecycle.js';

describe('_bossLifecycle — extractDebrisId', () => {
  it('pulls an id from each known payload shape', () => {
    assert.equal(extractDebrisId(42), 42);
    assert.equal(extractDebrisId({ id: 7 }), 7);
    assert.equal(extractDebrisId({ debrisId: 8 }), 8);
    assert.equal(extractDebrisId({ targetId: 9 }), 9);
    assert.equal(extractDebrisId({ debris: { id: 10 } }), 10);
    assert.equal(extractDebrisId({ target: { id: 11 } }), 11);
  });
  it('returns null for missing/garbage payloads', () => {
    assert.equal(extractDebrisId(null), null);
    assert.equal(extractDebrisId({}), null);
    assert.equal(extractDebrisId({ id: 'x' }), null);
  });
});

describe('_bossLifecycle — ThreatSet', () => {
  it('tracks totals, dedups clears, and ignores non-threats', () => {
    const ts = new ThreatSet([1, 2, 3]);
    assert.equal(ts.total, 3);
    assert.equal(ts.clearedCount, 0);
    assert.equal(ts.touch({ id: 1 }), true);
    assert.equal(ts.touch({ id: 1 }), false, 'dup is not a new clear');
    assert.equal(ts.touch({ id: 99 }), false, 'non-threat ignored');
    assert.equal(ts.clearedCount, 1);
    assert.closeTo(ts.fractionCleared, 1 / 3, 1e-9);
    assert.equal(ts.allCleared, false);
    ts.touch({ debrisId: 2 });
    ts.touch({ target: { id: 3 } });
    assert.equal(ts.allCleared, true);
  });
  it('empty set is never allCleared', () => {
    assert.equal(new ThreatSet([]).allCleared, false);
  });
});

describe('_bossLifecycle — awardElevatorMass', () => {
  function harness(startMass) {
    const emitted = [];
    const eb = { emit: (evt, d) => emitted.push({ evt, d }) };
    let mass = startMass;
    const shop = { getContractMass: () => mass, setContractMass: (k) => { mass = k; } };
    const scoring = { credits: 0, addCredits(n) { this.credits += n; } };
    return { emitted, eb, shop, scoring, getMass: () => mass };
  }

  it('adds mass + emits CONTRACT_UPDATE below target, no completion', () => {
    const h = harness(100);
    awardElevatorMass(h.eb, h.shop, h.scoring, 200);
    assert.equal(h.getMass(), 300);
    assert.equal(h.emitted.filter(e => e.evt === Events.CONTRACT_UPDATE).length, 1);
    assert.equal(h.emitted.some(e => e.evt === Events.CONTRACT_COMPLETE), false);
  });

  it('fires CONTRACT_COMPLETE + win bonus when crossing the target', () => {
    const target = Constants.ELEVATOR_CONTRACT.TARGET_MASS_KG;
    const h = harness(target - 50);
    awardElevatorMass(h.eb, h.shop, h.scoring, 200);
    const done = h.emitted.find(e => e.evt === Events.CONTRACT_COMPLETE);
    assert.ok(done, 'CONTRACT_COMPLETE emitted');
    assert.equal(done.d.bonusCredits, Constants.ELEVATOR_CONTRACT.WIN_BONUS);
    assert.equal(h.scoring.credits, Constants.ELEVATOR_CONTRACT.WIN_BONUS);
  });

  it('no-ops without a usable shop', () => {
    const emitted = [];
    awardElevatorMass({ emit: (e, d) => emitted.push(e) }, null, null, 200);
    assert.equal(emitted.length, 0);
  });
});
