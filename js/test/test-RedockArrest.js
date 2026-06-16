/**
 * test-RedockArrest.js — Q4 FEEP soft re-dock arrest
 * (reel-in-redock-inertia plan, FEATURE_FLAGS.REEL_PROFILE_V2).
 *
 * Coverage: entering ARREST_DISTANCE_M fires a one-shot mass-scaled fuel debit
 * and a REDOCK_ARREST_START event; a low-fuel daughter falls back to a slow
 * reel-only finish (REDOCK_FUEL_LOW, no dead-end); Mission 1 is a free pass; the
 * arrest fires once; DOCKING's per-state fuel rate is suppressed for the cycle.
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

function makeArm() {
  const scene = { add: () => {}, remove: () => {} };
  const arm = new ArmUnit('Weaver-1', 'weaver', new THREE.Vector3(M, 0, 0), scene);
  arm.index = 0;
  arm.state = S.REELING;
  arm.isDetached = false;
  arm._netRatedMass = 500;
  arm._netDiameter = 5;
  arm.fuel = 100;
  return arm;
}

function makeDebris(mass, sizeMeter = 1) {
  return { id: 7, mass, sizeMeter, _captured: true, _capturedByArm: null, alive: true };
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

// Position the arm `meters` from the dock (parentPos = origin; no dockOffset →
// dockWorldPos == parentPos, plume test degenerate-true).
function placeArm(arm, meters) {
  arm.position.set(meters * M, 0, 0);
  arm.dockOffset = null;
}

describe('RedockArrest — mass-scaled fuel debit', () => {
  it('entering ARREST_DISTANCE_M debits fuel ∝ m_unit·v_arrest and emits REDOCK_ARREST_START', () => {
    withFlag(true, () => {
      const orig = gameState.debrisCleared;
      gameState.debrisCleared = 10;   // mission > 1 (no free pass)
      try {
        const arm = makeArm();
        arm.capturedDebris = makeDebris(300);
        arm.capturedDebris._capturedByArm = arm;
        placeArm(arm, Constants.REDOCK_FEEP.ARREST_DISTANCE_M - 1);   // inside arrest window
        const fuel0 = arm.fuel;
        const starts = captureEvent(Events.REDOCK_ARREST_START,
          () => arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null));
        assert.equal(starts.length, 1, 'arrest started once');
        assert.ok(arm.fuel < fuel0, `fuel debited (${arm.fuel} < ${fuel0})`);
        assert.equal(arm._redockDebitApplied, true, 'debit marked applied (suppresses DOCKING rate)');
      } finally {
        gameState.debrisCleared = orig;
      }
    });
  });

  it('arrest fires only once even across multiple frames', () => {
    withFlag(true, () => {
      const orig = gameState.debrisCleared;
      gameState.debrisCleared = 10;
      try {
        const arm = makeArm();
        arm.capturedDebris = makeDebris(100);
        arm.capturedDebris._capturedByArm = arm;
        placeArm(arm, Constants.REDOCK_FEEP.ARREST_DISTANCE_M - 1);
        const starts = captureEvent(Events.REDOCK_ARREST_START, () => {
          for (let i = 0; i < 5 && arm.state === S.REELING; i++) {
            placeArm(arm, Constants.REDOCK_FEEP.ARREST_DISTANCE_M - 1);
            arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null);
          }
        });
        assert.equal(starts.length, 1, 'arrest is a one-shot');
      } finally {
        gameState.debrisCleared = orig;
      }
    });
  });
});

describe('RedockArrest — low-fuel fallback', () => {
  it('insufficient fuel → REDOCK_FUEL_LOW, no debit, no dead-end (stays REELING)', () => {
    withFlag(true, () => {
      const orig = gameState.debrisCleared;
      gameState.debrisCleared = 10;
      try {
        const arm = makeArm();
        arm.capturedDebris = makeDebris(500);
        arm.capturedDebris._capturedByArm = arm;
        arm.fuel = 0.0001;   // can't cover the debit
        placeArm(arm, Constants.REDOCK_FEEP.ARREST_DISTANCE_M - 1);
        const lows = captureEvent(Events.REDOCK_FUEL_LOW,
          () => arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null));
        assert.equal(lows.length, 1, 'fuel-low warning emitted');
        assert.equal(arm._redockDebitApplied, false, 'no debit applied on fallback');
        assert.ok(arm.state === S.REELING || arm.state === S.DOCKING,
          'reel continues toward dock (no dead-end)');
      } finally {
        gameState.debrisCleared = orig;
      }
    });
  });
});

describe('RedockArrest — Mission 1 free pass', () => {
  it('no fuel debit during the learning mission', () => {
    withFlag(true, () => {
      const orig = gameState.debrisCleared;
      gameState.debrisCleared = 0;   // mission 1
      try {
        const arm = makeArm();
        arm.capturedDebris = makeDebris(400);
        arm.capturedDebris._capturedByArm = arm;
        placeArm(arm, Constants.REDOCK_FEEP.ARREST_DISTANCE_M - 1);
        const fuel0 = arm.fuel;
        arm._updateReeling(0.016, new THREE.Vector3(0, 0, 0), null);
        assert.ok(Math.abs(arm.fuel - fuel0) < 1e-9, `no debit in mission 1 (fuel ${arm.fuel})`);
        assert.equal(arm._redockDebitApplied, true, 'free pass still suppresses the DOCKING rate');
      } finally {
        gameState.debrisCleared = orig;
      }
    });
  });
});

describe('RedockArrest — DOCKING fuel rate suppression', () => {
  it('the DOCKING per-state rate is zeroed for the cycle the arrest fired', () => {
    withFlag(true, () => {
      const arm = makeArm();
      arm.state = S.DOCKING;
      arm._redockDebitApplied = true;
      const fuel0 = arm.fuel;
      arm._consumeFuel(1.0);   // a full second of DOCKING
      assert.ok(Math.abs(arm.fuel - fuel0) < 1e-9, 'no double-charge: DOCKING rate suppressed');
    });
  });

  it('without the arrest flag DOCKING burns its normal rate', () => {
    const arm = makeArm();
    arm.state = S.DOCKING;
    arm._redockDebitApplied = false;
    const fuel0 = arm.fuel;
    arm._consumeFuel(1.0);
    assert.ok(arm.fuel < fuel0, 'normal DOCKING fuel burn preserved');
  });
});
