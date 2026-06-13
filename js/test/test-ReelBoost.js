/**
 * test-ReelBoost.js — player reel-speed control
 * (capture-feedback overhaul Phase 3a, FEATURE_FLAGS.REEL_BOOST).
 *
 * Coverage: nominal reel is numerically unchanged (cautious play never
 * punished), boost multiplies speed ×2 and tension ∝ reelSpeed², boost can
 * snap an over-rated catch, the boost net-rip roll is recoverable and only
 * fires inside the strain band, ArmManager fan-out.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { gameState } from '../core/GameState.js';

const S = Constants.ARM_STATES;
const M = 0.00001;

function makeArm(state = S.REELING) {
  const scene = { add: () => {}, remove: () => {} };
  const arm = new ArmUnit('Weaver-1', 'weaver', new THREE.Vector3(M, 0, 0), scene);
  arm.index = 0;
  arm.state = state;
  arm.isDetached = false;
  arm._netRatedMass = 500;
  arm._netDiameter = 5;
  return arm;
}

function makeDebris(mass, sizeMeter = 1) {
  return { id: 7, mass, sizeMeter, _captured: true, _capturedByArm: null, _netted: false,
    _isStationKeepTarget: false, _committedNetArmId: null };
}

function attach(arm, debris) {
  arm.capturedDebris = debris;
  debris._capturedByArm = arm;
}

function captureEvent(evt, fn) {
  const got = [];
  const h = (d) => got.push(d);
  eventBus.on(evt, h);
  try { fn(); } finally { eventBus.off(evt, h); }
  return got;
}

describe('ReelBoost — nominal reel is unchanged', () => {
  it('without Shift the tension matches the legacy linear model exactly', () => {
    const arm = makeArm();
    attach(arm, makeDebris(400));
    arm.position.set(1, 0, 0);
    arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null);
    const armMass = Constants.V5_WEAVER_MASS;
    const expected = (armMass + 400) * Constants.REEL_IN_SPEED_LOADED * (Constants.REEL_TENSION_COEFF ?? 0.04);
    assert.ok(Math.abs(arm.tetherTension - expected) < 1e-6,
      `legacy tension preserved (got ${arm.tetherTension}, want ${expected})`);
    assert.equal(arm._boostReel, false);
  });
});

describe('ReelBoost — boosted reel', () => {
  it('Shift held → boost active; tension target doubles and eases toward it', () => {
    const arm = makeArm();
    attach(arm, makeDebris(100));   // light catch: no rip band, no snap
    arm.position.set(1, 0, 0);
    arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null);
    const nominal = arm.tetherTension;

    arm._boostReelHeld = true;
    for (let i = 0; i < 200; i++) {
      arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null);
    }
    assert.equal(arm._boostReel, true, 'boost active with a payload');
    const mult = Constants.REEL_BOOST.SPEED_MULT;
    assert.ok(Math.abs(arm.tetherTension - nominal * mult) < 0.5,
      `boost tension settles at nominal × ${mult} (got ${arm.tetherTension} vs ${nominal})`);
  });

  it('boosting an over-rated catch can SNAP the tether (priced impatience)', () => {
    const arm = makeArm();
    attach(arm, makeDebris(800));    // 800 kg: safe at nominal, over break when boosted
    arm.position.set(100, 0, 0);     // far out so the reel doesn't dock first
    arm._boostReelHeld = true;
    arm._boostRipRollOverride = 0.999;   // don't rip first — let tension build to snap
    const orig = gameState.debrisCleared;
    gameState.debrisCleared = 5;         // mission 2 (snap guard off)
    let snaps;
    try {
      snaps = captureEvent(Events.TETHER_SNAP, () => {
        for (let i = 0; i < 120 && arm.state === S.REELING; i++) {
          arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null);
        }
      });
    } finally {
      gameState.debrisCleared = orig;
    }
    assert.equal(snaps.length, 1, 'boost overload snaps once the eased tension crosses break');
    assert.equal(arm.state, S.EXPENDED);
  });

  it('boost net-rip: rolls only inside the strain band; recoverable NET_FAILED', () => {
    const arm = makeArm();
    attach(arm, makeDebris(480));   // 96% rated → deep in the 80-100% band
    arm.position.set(1, 0, 0);
    arm._boostReelHeld = true;
    arm._boostRipRollOverride = 0;  // force the rip roll
    const fails = captureEvent(Events.NET_FAILED, () => arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null));
    assert.equal(fails.length, 1, 'net rips under boost');
    assert.equal(fails[0].cause, 'boost_reel');
    assert.equal(fails[0].recoverable, true, 'rip is the recoverable path');
    assert.equal(arm.state, S.RETURNING, 'daughter returns to reload');
    assert.equal(arm.capturedDebris, null, 'catch released (re-capturable)');
  });

  it('no rip below the strain-safe band even with a forced roll', () => {
    const arm = makeArm();
    attach(arm, makeDebris(300));   // 60% rated → safe band
    arm.position.set(1, 0, 0);
    arm._boostReelHeld = true;
    arm._boostRipRollOverride = 0;
    const fails = captureEvent(Events.NET_FAILED, () => arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null));
    assert.equal(fails.length, 0, 'in-spec boost never rips');
    assert.equal(arm.state, S.REELING);
  });

  it('flag OFF → Shift does nothing', () => {
    const prev = Constants.FEATURE_FLAGS.REEL_BOOST;
    try {
      Constants.FEATURE_FLAGS.REEL_BOOST = false;
      const arm = makeArm();
      attach(arm, makeDebris(100));
      arm.position.set(1, 0, 0);
      arm._boostReelHeld = true;
      arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null);
      assert.equal(arm._boostReel, false);
    } finally {
      Constants.FEATURE_FLAGS.REEL_BOOST = prev;
    }
  });
});
