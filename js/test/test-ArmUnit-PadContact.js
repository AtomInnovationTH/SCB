/**
 * test-ArmUnit-PadContact.js — multi-modal pad sub-FSM (CP-1 / P4).
 *
 * Covers the pure mode resolver (§5.3 priority table), the UV-cure magazine
 * (§13 Q3 — decrement-on-success-only, removal-at-zero), and the full
 * APPROACH_SOFT → CONTACT → grip-roll FSM (adhered / bounced).
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

const S = Constants.ARM_STATES;
const M = 0.00001;

function makeArm(type = 'spinner') {
  const scene = { add: () => {}, remove: () => {} };
  const arm = new ArmUnit(`${type}-1`, type, new THREE.Vector3(M, 0, 0), scene);
  arm.index = 0;
  arm.isDetached = false;
  arm.tetherLength = 50;
  return arm;
}

function makeTarget({ id = 61, mass = 4, material = 'aluminum', roughness = 0.4, type = 'fragment' } = {}) {
  return {
    id, mass, sizeMeter: 0.5, type, material, surfaceRoughness: roughness,
    alive: true, _captured: false, _capturedByArm: null, _armPinned: false, _armPinPos: null,
    _scenePosition: new THREE.Vector3(0, 0, 0),
  };
}

function enterSK(arm, target) {
  arm.state = S.STATION_KEEP;
  arm.target = target;
  arm._stationKeepTarget = target;
  arm.position.copy(target._scenePosition);
  arm.velocity.set(0, 0, 0);
}

/** APPROACH (instant contact at dist 0) + CONTACT hold (1.0 s). */
function drivePad(arm) {
  arm._updatePadContact(0.05);  // APPROACH → contact → resolve mode → CONTACT
  arm._updatePadContact(1.05);  // CONTACT dwell → grip roll
}

function capture(evts, fn) {
  const got = {}, handlers = {};
  for (const e of evts) { got[e] = []; handlers[e] = (d) => got[e].push(d); eventBus.on(e, handlers[e]); }
  try { fn(); } finally { for (const e of evts) eventBus.off(e, handlers[e]); }
  return got;
}

describe('ArmUnit pad — mode resolver (§5.3)', () => {
  const arm = makeArm('spinner');
  it('steel → magnet', () => assert.equal(arm._resolvePadMode(makeTarget({ material: 'steel' })), 'magnet'));
  it('mli_mylar → hooks', () => assert.equal(arm._resolvePadMode(makeTarget({ material: 'mli_mylar', roughness: 0.9 })), 'hooks'));
  it('high roughness → hooks', () => assert.equal(arm._resolvePadMode(makeTarget({ material: 'titanium', roughness: 0.8 })), 'hooks'));
  it('aluminum → gecko', () => assert.equal(arm._resolvePadMode(makeTarget({ material: 'aluminum', roughness: 0.4 })), 'gecko'));
  it('solar_cell → gecko', () => assert.equal(arm._resolvePadMode(makeTarget({ material: 'solar_cell', roughness: 0.2 })), 'gecko'));
  it('composite → electrostatic', () => assert.equal(arm._resolvePadMode(makeTarget({ material: 'composite', roughness: 0.6 })), 'electrostatic'));
  it('exotic surface with UV doses → uv_cure', () => {
    const a = makeArm('spinner');
    a._padUvCureDosesRemaining = 5;
    assert.equal(a._resolvePadMode(makeTarget({ material: 'unobtainium', roughness: 0.5 })), 'uv_cure');
  });
  it('exotic surface with 0 UV doses → NO_MODE (null)', () => {
    const a = makeArm('spinner');
    a._padUvCureDosesRemaining = 0;
    assert.equal(a._resolvePadMode(makeTarget({ material: 'unobtainium', roughness: 0.5 })), null);
  });
});

describe('ArmUnit pad — FSM resolution', () => {
  it('aluminum fragment → gecko adhered → GRAPPLED, tagged PAD', () => {
    eventBus.clear();
    const arm = makeArm('spinner');
    const target = makeTarget({ material: 'aluminum' });
    enterSK(arm, target);
    arm.selectedTool = 'PAD';
    assert.equal(arm.dispatchSelectedTool(), true);
    assert.equal(arm.state, S.PAD_CONTACT);

    arm._padRollOverride = 0;  // deterministic adhere
    const got = capture([Events.PAD_ADHERED, Events.ARM_CAPTURED, Events.PAD_CONTACT_ATTEMPT],
      () => drivePad(arm));

    assert.equal(arm.state, S.GRAPPLED);
    assert.equal(arm.capturedDebris, target);
    assert.equal(arm._captureToolKind, 'PAD');
    assert.equal(got[Events.PAD_CONTACT_ATTEMPT].length, 1);
    assert.equal(got[Events.PAD_ADHERED][0].mode, 'gecko');
    assert.equal(got[Events.ARM_CAPTURED][0].tool, 'PAD');
  });

  it('contact too fast → PAD_BOUNCED(too_fast) → RETURNING', () => {
    eventBus.clear();
    const arm = makeArm('spinner');
    const target = makeTarget({ material: 'aluminum' });
    enterSK(arm, target);
    arm.padContact();
    arm._padContactVelOverride = 0.5;  // > CONTACT_VEL_MAX_M_S (0.20)

    const got = capture([Events.PAD_BOUNCED], () => arm._updatePadContact(0.05));
    assert.equal(got[Events.PAD_BOUNCED][0].reason, 'too_fast');
    assert.equal(arm.state, S.RETURNING);
    assert.equal(arm.capturedDebris, null);
  });

  it('UV-cure adhesion decrements the magazine exactly once (on success)', () => {
    eventBus.clear();
    const arm = makeArm('spinner');
    arm._padUvCureDosesRemaining = 3;
    const target = makeTarget({ material: 'unobtainium', roughness: 0.5 });
    enterSK(arm, target);
    arm.padContact();
    arm._padRollOverride = 0;  // adhere

    const got = capture([Events.PAD_UV_DOSE_USED, Events.PAD_ADHERED], () => drivePad(arm));
    assert.equal(arm.state, S.GRAPPLED);
    assert.equal(got[Events.PAD_ADHERED][0].mode, 'uv_cure');
    assert.equal(arm._padUvCureDosesRemaining, 2, 'one dose consumed');
    assert.equal(got[Events.PAD_UV_DOSE_USED][0].dosesRemaining, 2);
  });

  it('a failed grip roll does NOT consume a UV dose', () => {
    eventBus.clear();
    const arm = makeArm('spinner');
    arm._padUvCureDosesRemaining = 3;
    const target = makeTarget({ material: 'unobtainium', roughness: 0.5 });
    enterSK(arm, target);
    arm.padContact();
    arm._padRollOverride = 0.999;  // ≥ uv_cure P (0.98) → miss

    const got = capture([Events.PAD_BOUNCED, Events.PAD_UV_DOSE_USED], () => drivePad(arm));
    assert.equal(got[Events.PAD_BOUNCED][0].reason, 'p_roll');
    assert.equal(got[Events.PAD_UV_DOSE_USED].length, 0, 'no dose burned on a fail roll');
    assert.equal(arm._padUvCureDosesRemaining, 3, 'magazine unchanged');
  });
});

describe('ArmUnit pad — feature flag', () => {
  it('PAD is not in the Weaver toolset', () => {
    const arm = makeArm('weaver');
    assert.equal(arm.toolset.includes('PAD'), false);
  });
});
