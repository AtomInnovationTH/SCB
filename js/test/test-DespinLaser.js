/**
 * test-DespinLaser.js — CP-2 mother-mounted de-spin laser.
 *
 * Covers the pure de-spin step, the FSM behaviour (tumble bleed, in-spec event,
 * range gate, flag gate, target-switch cleanup), and the CaptureNet tumble→cling
 * coupling (computeTumbleModifier) that makes detumbling actually help capture.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { DespinLaser, applyDespin } from '../systems/DespinLaser.js';
import { computeTumbleModifier, computeClingProbability } from '../entities/CaptureNet.js';

const DEG = Math.PI / 180;

function makeTarget(tumbleDeg, id = 1) {
  return { id, tumbleRate: tumbleDeg * DEG, _despinning: false };
}
function selectorFor(target) {
  return { getActiveTarget: () => target, getActiveTargetPosition: () => null };
}
function laserOn(target) {
  const l = new DespinLaser();
  l.init({ targetSelector: selectorFor(target) });   // no scene → beam skipped
  l.setFiring(true);
  return l;
}
function capture(evts, fn) {
  const got = {}, h = {};
  for (const e of evts) { got[e] = []; h[e] = (d) => got[e].push(d); eventBus.on(e, h[e]); }
  try { fn(); } finally { for (const e of evts) eventBus.off(e, h[e]); }
  return got;
}

describe('DespinLaser — pure step', () => {
  it('bleeds rate*dt out of the tumble, clamped at 0', () => {
    assert.equal(applyDespin(1.0, 0.3, 1), 0.7);
    assert.equal(applyDespin(0.2, 0.3, 1), 0);          // clamped
    assert.equal(applyDespin(0, 0.3, 1), 0);
  });
});

describe('DespinLaser — FSM', () => {
  it('reduces the active target tumble while firing', () => {
    eventBus.clear();
    const target = makeTarget(40);
    const before = target.tumbleRate;
    const l = laserOn(target);
    l.update(0.5);
    assert.ok(target.tumbleRate < before, 'tumble bled down');
    assert.equal(target._despinning, true, 'HUD de-spin flag set');
    const expected = before - Constants.DESPIN_LASER.DESPIN_RATE_RAD_S2 * 0.5;
    assert.ok(Math.abs(target.tumbleRate - expected) < 1e-9, 'exact rate applied');
  });

  it('emits DESPIN_IN_SPEC once when crossing below the net-safe spin', () => {
    eventBus.clear();
    const target = makeTarget(11);   // just above the 10°/s in-spec threshold
    const l = laserOn(target);
    const got = capture([Events.DESPIN_IN_SPEC], () => {
      l.update(1.0);                 // 11°/s → well below 10°/s
      l.update(1.0);                 // already in spec — must NOT re-emit
    });
    assert.equal(got[Events.DESPIN_IN_SPEC].length, 1, 'fires exactly once on the crossing');
    assert.equal(got[Events.DESPIN_IN_SPEC][0].targetId, target.id);
  });

  it('does nothing when not firing', () => {
    eventBus.clear();
    const target = makeTarget(40);
    const before = target.tumbleRate;
    const l = new DespinLaser();
    l.init({ targetSelector: selectorFor(target) });
    l.setFiring(false);
    l.update(0.5);
    assert.equal(target.tumbleRate, before, 'no change while idle');
  });

  it('respects the LASER_DESPIN feature flag', () => {
    eventBus.clear();
    const target = makeTarget(40);
    const before = target.tumbleRate;
    const orig = Constants.FEATURE_FLAGS.LASER_DESPIN;
    Constants.FEATURE_FLAGS.LASER_DESPIN = false;
    try {
      const l = laserOn(target);
      l.update(0.5);
      assert.equal(target.tumbleRate, before, 'flag off → laser inert');
    } finally {
      Constants.FEATURE_FLAGS.LASER_DESPIN = orig;
    }
  });

  it('out-of-range target is not de-spun', () => {
    eventBus.clear();
    const target = makeTarget(40);
    const before = target.tumbleRate;
    const farPos = new THREE.Vector3(0, 0, 1e6);   // way beyond RANGE_M
    const l = new DespinLaser();
    l.init({
      player: { getPosition: () => new THREE.Vector3(0, 0, 0) },
      targetSelector: { getActiveTarget: () => target, getActiveTargetPosition: () => farPos },
    });
    l.setFiring(true);
    l.update(0.5);
    assert.equal(target.tumbleRate, before, 'out of range → no de-spin');
  });

  it('clears the de-spin HUD flag on the old target when the selection switches', () => {
    eventBus.clear();
    const a = makeTarget(40, 1);
    const b = makeTarget(40, 2);
    const sel = { _t: a, getActiveTarget() { return this._t; }, getActiveTargetPosition: () => null };
    const l = new DespinLaser();
    l.init({ targetSelector: sel });
    l.setFiring(true);
    l.update(0.2);
    assert.equal(a._despinning, true);
    sel._t = b;                    // player Tabs to a new target mid-fire
    l.update(0.2);
    assert.equal(a._despinning, false, 'old target de-spin flag cleared');
    assert.equal(b._despinning, true, 'new target now lit');
  });
});

describe('CaptureNet — tumble→cling coupling (CP-2)', () => {
  it('no penalty at/below the in-spec spin; absent tumble ⇒ 1.0', () => {
    assert.equal(computeTumbleModifier(null), 1.0);
    assert.equal(computeTumbleModifier(8 * DEG), 1.0);   // below 10°/s in-spec
    assert.equal(computeTumbleModifier(10 * DEG), 1.0);
  });

  it('penalises high tumble down to the floor', () => {
    const mMid = computeTumbleModifier(50 * DEG);
    assert.ok(mMid < 1.0 && mMid > Constants.NET_TUMBLE_PENALTY.FLOOR, `50°/s ⇒ ${mMid}`);
    const mHigh = computeTumbleModifier(180 * DEG);
    assert.equal(mHigh, Constants.NET_TUMBLE_PENALTY.FLOOR, 'very high tumble floors out');
  });

  it('detumbling raises the net cling probability', () => {
    const base = { pBase: 0.9, vRel: 10, vOptimal: 10, range: 50 };
    const pSpun = computeClingProbability({ ...base, targetTumbleRate: 90 * DEG });
    const pCalm = computeClingProbability({ ...base, targetTumbleRate: 8 * DEG });
    assert.ok(pCalm > pSpun, `detumble improves cling (${pCalm} > ${pSpun})`);
  });
});
