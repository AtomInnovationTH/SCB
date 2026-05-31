/**
 * test-WelcomeField.js — Delegation 2 (2026-05-31)
 *
 * Verifies DebrisField.spawnWelcomeField():
 *   • Returns 7–8 fragments
 *   • All fragments are tagged welcomeField: true
 *   • All distances fall within 150–1500 m of the player
 *   • All fragments share the player's orbital frame (a/e/i/RAAN/argP) —
 *     the public method only varies trueAnomaly, never the shape.
 *
 * Avoids instantiating DebrisField (which needs THREE.Scene) by calling
 * the prototype method against a minimal mock receiver.
 *
 * @module test/test-WelcomeField
 */

import { describe, it, assert } from './TestRunner.js';
import { DebrisField } from '../entities/DebrisField.js';

// Mock receiver — emulates the few fields the method touches when
// `debrisList` is empty (pure-data plan return path).
function createMockField() {
  return {
    debrisList: [],
    _welcomeFieldSpawned: false,
    _spawnWelcomeField() { /* no-op — not exercised when debrisList is empty */ },
  };
}

const playerOrbit = {
  semiMajorAxis: 6878.137,    // 500 km altitude
  eccentricity: 0.0,
  inclination: 51.6 * Math.PI / 180,
  raan: 0.0,
  argPerigee: 0.0,
  trueAnomaly: 1.234,
  meanMotion: 0.0011,
};

// ─── BASIC SHAPE ─────────────────────────────────────────────────────────

describe('DebrisField.spawnWelcomeField — basic shape', () => {
  it('returns a plan with at least 7 fragments (default)', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit);
    assert.ok(plan && Array.isArray(plan.fragments), 'plan.fragments is an array');
    assert.ok(plan.fragments.length >= 7 && plan.fragments.length <= 8,
      `expected 7–8 fragments, got ${plan.fragments.length}`);
  });

  it('honours an explicit count of 8', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit, { count: 8 });
    assert.equal(plan.fragments.length, 8);
  });

  it('clamps count to the 7–8 range', () => {
    const mock = createMockField();
    const planLow = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit, { count: 3 });
    const planHigh = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit, { count: 50 });
    assert.equal(planLow.fragments.length, 7);
    assert.equal(planHigh.fragments.length, 8);
  });
});

// ─── TAGGING ─────────────────────────────────────────────────────────────

describe('DebrisField.spawnWelcomeField — tagging', () => {
  it('every fragment has welcomeField: true', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit);
    for (const f of plan.fragments) {
      assert.equal(f.welcomeField, true, `fragment missing welcomeField tag: ${JSON.stringify(f)}`);
    }
  });
});

// ─── DISTANCE RANGE ──────────────────────────────────────────────────────

describe('DebrisField.spawnWelcomeField — offset range 150 – 1500 m', () => {
  it('all fragments fall within the 150 – 1500 m offset window', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit);
    for (const f of plan.fragments) {
      assert.ok(f.offsetM >= 150 && f.offsetM <= 1500,
        `offsetM out of range: ${f.offsetM}`);
    }
  });

  it('custom min/max offsets propagate', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit, {
      minOffsetM: 300, maxOffsetM: 900,
    });
    for (const f of plan.fragments) {
      assert.ok(f.offsetM >= 300 && f.offsetM <= 900,
        `offsetM out of custom range: ${f.offsetM}`);
    }
  });
});

// ─── MASS RANGE ──────────────────────────────────────────────────────────

describe('DebrisField.spawnWelcomeField — mass range 5 – 50 kg', () => {
  it('all masses fall within the spec window (5 – 50 kg)', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit);
    for (const f of plan.fragments) {
      assert.ok(f.massKg >= 5 && f.massKg <= 50,
        `massKg out of range: ${f.massKg}`);
    }
  });
});

// ─── ORBITAL FRAME ───────────────────────────────────────────────────────

describe('DebrisField.spawnWelcomeField — orbital frame preserved', () => {
  it('plan.playerOrbit is the same reference the caller passed in', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit);
    assert.equal(plan.playerOrbit, playerOrbit);
  });

  it('alternates ahead/behind orientation across the cluster', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit);
    const aheadCount = plan.fragments.filter(f => f.ahead).length;
    const behindCount = plan.fragments.filter(f => !f.ahead).length;
    // For a 7-frag plan we expect at least 3 of each.
    assert.ok(aheadCount >= 3, `expected ≥3 ahead, got ${aheadCount}`);
    assert.ok(behindCount >= 3, `expected ≥3 behind, got ${behindCount}`);
  });
});
