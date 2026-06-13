/**
 * test-EddyDamp.js — eddy-current detumble (MAGNET secondary)
 * (capture-feedback overhaul Phase 3c, Constants.EDDY_DAMP).
 *
 * Coverage: damp rate on conductive hulls, material + range + tool gates,
 * DESPIN_IN_SPEC crossing announcement (same loop as the mother laser).
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

const S = Constants.ARM_STATES;
const DEG = Math.PI / 180;

function makeArm() {
  const scene = { add: () => {}, remove: () => {} };
  const arm = new ArmUnit('Weaver-1', 'weaver', new THREE.Vector3(0.00001, 0, 0), scene);
  arm.index = 0;
  arm.state = S.STATION_KEEP;
  arm.selectedTool = 'MAGNET';
  arm._standoffR = 20;   // inside EDDY_DAMP.RANGE_M (30)
  return arm;
}

function makeTarget(over = {}) {
  return { id: 5, material: 'aluminum', tumbleRate: 20 * DEG, ...over };
}

function captureEvent(evt, fn) {
  const got = [];
  const h = (d) => got.push(d);
  eventBus.on(evt, h);
  try { fn(); } finally { eventBus.off(evt, h); }
  return got;
}

describe('EddyDamp — MAGNET secondary detumble', () => {
  it('bleeds tumble at EDDY_DAMP rate on a conductive hull within range', () => {
    const arm = makeArm();
    const t = makeTarget();
    const before = t.tumbleRate;
    arm._updateEddyDamp(1.0, t);
    const expected = before - Constants.EDDY_DAMP.DESPIN_RATE_RAD_S2;
    assert.ok(Math.abs(t.tumbleRate - expected) < 1e-9, 'rate matches constants');
    assert.equal(t._eddyDamping, true, 'HUD flag set while damping');
    assert.equal(arm._eddyActive, true);
  });

  it('non-conductive material → no damping', () => {
    const arm = makeArm();
    const t = makeTarget({ material: 'composite' });
    const before = t.tumbleRate;
    arm._updateEddyDamp(1.0, t);
    assert.equal(t.tumbleRate, before);
    assert.ok(!t._eddyDamping);
  });

  it('out of range or wrong tool → no damping', () => {
    const arm = makeArm();
    arm._standoffR = 45;   // beyond 30 m
    const t = makeTarget();
    const before = t.tumbleRate;
    arm._updateEddyDamp(1.0, t);
    assert.equal(t.tumbleRate, before, 'out of range');

    arm._standoffR = 20;
    arm.selectedTool = 'NET';
    arm._updateEddyDamp(1.0, t);
    assert.equal(t.tumbleRate, before, 'NET selected → magnet field idle');
  });

  it('crossing below the net-safe spin emits DESPIN_IN_SPEC once', () => {
    const arm = makeArm();
    const t = makeTarget({ tumbleRate: 10.5 * DEG });   // just above 10°/s spec
    const got = captureEvent(Events.DESPIN_IN_SPEC, () => {
      for (let i = 0; i < 30; i++) arm._updateEddyDamp(0.1, t);
    });
    assert.equal(got.length, 1, 'announced exactly once on the crossing');
    assert.equal(got[0].targetId, 5);
    assert.ok(t.tumbleRate <= 10 * DEG, 'tumble now in spec');
  });

  it('deactivation clears the HUD flag (target leaves range)', () => {
    const arm = makeArm();
    const t = makeTarget();
    arm._updateEddyDamp(0.5, t);
    assert.equal(t._eddyDamping, true);
    arm._standoffR = 100;
    arm._updateEddyDamp(0.5, t);
    assert.equal(t._eddyDamping, false, 'flag cleared on deactivate');
    assert.equal(arm._eddyActive, false);
  });

  it('deactivation also clears _despinning (B2: no permanent de-spin label)', () => {
    const arm = makeArm();
    const t = makeTarget();
    arm._updateEddyDamp(0.5, t);
    assert.equal(t._despinning, true, 'shared HUD hint set while damping');

    // Tool switch deactivates → both flags drop.
    arm.selectedTool = 'NET';
    arm._updateEddyDamp(0.5, t);
    assert.equal(t._despinning, false, '_despinning cleared on tool switch');
    assert.equal(t._eddyDamping, false);
  });

  it('_exitStationKeep clears _despinning on the eddy target (B2)', () => {
    const arm = makeArm();
    const t = makeTarget();
    arm._updateEddyDamp(0.5, t);
    assert.equal(t._despinning, true);
    arm._exitStationKeep('test');
    assert.equal(t._despinning, false, '_despinning cleared on SK exit');
    assert.equal(t._eddyDamping, false);
    assert.equal(arm._eddyActive, false);
  });
});
