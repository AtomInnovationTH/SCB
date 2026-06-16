/**
 * test-CatchSnug.js — Q3 SNUG rigidize sub-phase
 * (reel-in-redock-inertia plan, FEATURE_FLAGS.REEL_PROFILE_V2).
 *
 * Coverage: GRAPPLED→(SNUG settle)→REELING with a CATCH_SNUGGED event carrying
 * m_unit; the held net is asked for the snug tension target; an empty reel (no
 * catch) skips SNUG entirely; the flag OFF transitions immediately as before.
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
  arm.state = S.GRAPPLED;
  arm.isDetached = false;
  arm._netRatedMass = 500;
  arm._netDiameter = 5;
  arm.tetherLength = 100;
  return arm;
}

function makeDebris(mass, sizeMeter = 1) {
  return { id: 7, mass, sizeMeter, _scenePosition: new THREE.Vector3(M, 0, 0),
    _captured: true, _capturedByArm: null, alive: true };
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

describe('CatchSnug — GRAPPLED settles before reeling', () => {
  it('holds through the settle window then emits CATCH_SNUGGED and enters REELING', () => {
    withFlag(true, () => {
      const arm = makeArm();
      const debris = makeDebris(200);
      arm.capturedDebris = debris;
      arm.target = debris;
      const net = {};
      arm._firedNet = net;

      // Just past the stabilize hold but inside the SNUG settle window → still GRAPPLED.
      arm.stateTimer = Constants.ARM_GRAPPLE_STABILIZE + 0.05;
      arm._updateGrappled(0.016);
      assert.equal(arm.state, S.GRAPPLED, 'still settling — held in GRAPPLED');
      assert.equal(net._snugTargetN, Constants.CATCH_SNUG.TENSION_TARGET_N,
        'held net asked for the snug tension target');

      // Past the settle window → snug completes, enters REELING.
      arm.stateTimer = Constants.ARM_GRAPPLE_STABILIZE + Constants.CATCH_SNUG.SETTLE_S + 0.05;
      const snugged = captureEvent(Events.CATCH_SNUGGED, () => arm._updateGrappled(0.016));
      assert.equal(arm.state, S.REELING, 'enters REELING after the settle');
      assert.equal(snugged.length, 1, 'CATCH_SNUGGED emitted once');
      assert.equal(snugged[0].debrisId, debris.id);
      const expectedMUnit = Constants.V5_WEAVER_MASS + 200 + Constants.CAPTURE_NET.MEDIUM.MASS;
      assert.ok(Math.abs(snugged[0].mUnit - expectedMUnit) < 1e-6,
        `m_unit = daughter + debris + net (got ${snugged[0].mUnit}, want ${expectedMUnit})`);
    });
  });
});

describe('CatchSnug — empty reel skips SNUG', () => {
  it('no catch → no settle hold, no CATCH_SNUGGED, straight to REELING', () => {
    withFlag(true, () => {
      const arm = makeArm();
      arm.capturedDebris = null;
      arm.stateTimer = Constants.ARM_GRAPPLE_STABILIZE + 0.05;
      const snugged = captureEvent(Events.CATCH_SNUGGED, () => arm._updateGrappled(0.016));
      assert.equal(arm.state, S.REELING, 'empty reel enters REELING immediately');
      assert.equal(snugged.length, 0, 'no SNUG event for an empty reel');
    });
  });
});

describe('CatchSnug — flag OFF is legacy', () => {
  it('with the flag OFF a catch enters REELING immediately (no settle hold)', () => {
    withFlag(false, () => {
      const arm = makeArm();
      const debris = makeDebris(200);
      arm.capturedDebris = debris;
      arm.target = debris;
      arm.stateTimer = Constants.ARM_GRAPPLE_STABILIZE + 0.05;
      const snugged = captureEvent(Events.CATCH_SNUGGED, () => arm._updateGrappled(0.016));
      assert.equal(arm.state, S.REELING, 'legacy: immediate REELING');
      assert.equal(snugged.length, 0, 'no SNUG event when flag OFF');
    });
  });
});
