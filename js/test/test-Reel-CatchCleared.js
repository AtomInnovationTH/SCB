/**
 * test-Reel-CatchCleared.js — catch-cleared-mid-reel guard
 * (reel-in-redock-inertia plan, FEATURE_FLAGS.REEL_PROFILE_V2).
 *
 * If a captured debris is destroyed/removed during REELING the FSM must not be
 * stranded holding a stale "loaded" profile — it converts to an empty return
 * (warns once) and keeps reeling home. Mirrors the HOLDING_CATCH→RELOADING
 * fallback philosophy.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

const S = Constants.ARM_STATES;
const M = 0.00001;

function makeArm() {
  const scene = { add: () => {}, remove: () => {} };
  const arm = new ArmUnit('Weaver-1', 'weaver', new THREE.Vector3(M, 0, 0), scene);
  arm.index = 0;
  arm.state = S.REELING;
  arm.isDetached = false;
  arm._netRatedMass = 500;
  arm._netDiameter = 5;
  return arm;
}

function makeDebris(mass) {
  return { id: 7, mass, sizeMeter: 1, _captured: true, _capturedByArm: null, alive: true };
}

function captureEvent(evt, fn) {
  const got = [];
  const h = (d) => got.push(d);
  eventBus.on(evt, h);
  try { fn(); } finally { eventBus.off(evt, h); }
  return got;
}

function withFlag(on, fn) {
  const prev = Constants.FEATURE_FLAGS.REEL_PROFILE_V2;
  Constants.FEATURE_FLAGS.REEL_PROFILE_V2 = on;
  try { return fn(); } finally { Constants.FEATURE_FLAGS.REEL_PROFILE_V2 = prev; }
}

describe('Reel catch-cleared mid-reel', () => {
  it('catch nulled during REELING → warns once, stays in the reel/dock flow', () => {
    withFlag(true, () => {
      const arm = makeArm();
      const debris = makeDebris(300);
      arm.capturedDebris = debris;
      debris._capturedByArm = arm;
      arm.position.set(1, 0, 0);

      // First frame: has a payload (arms the guard).
      arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null);
      assert.equal(arm._reelHadPayload, true, 'guard armed while loaded');

      // Catch vanishes — the FSM must not be stranded.
      arm.capturedDebris = null;
      const msgs = captureEvent(Events.COMMS_MESSAGE,
        () => arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null));
      assert.ok(arm.state === S.REELING || arm.state === S.DOCKING,
        'continues reeling/docking — not stranded');
      const lost = msgs.filter(m => /lost mid-reel/i.test(m.text || ''));
      assert.equal(lost.length, 1, 'warns once about the lost catch');
    });
  });

  it('a genuinely empty reel (never had a catch) does not warn', () => {
    withFlag(true, () => {
      const arm = makeArm();
      arm.capturedDebris = null;
      arm.position.set(1, 0, 0);
      const msgs = captureEvent(Events.COMMS_MESSAGE,
        () => arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null));
      const lost = msgs.filter(m => /lost mid-reel/i.test(m.text || ''));
      assert.equal(lost.length, 0, 'no spurious lost-catch warning for an empty reel');
    });
  });
});
