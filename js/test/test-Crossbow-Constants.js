/**
 * test-Crossbow-Constants.js — V5 Crossbow constants & events (Node-compatible)
 * Tests pure data from Constants.js and Events.js — no Three.js dependency.
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { Events } from '../core/Events.js';

const { ARM_STATES, SPRING_TIERS, TETHER_TIERS } = Constants;

// ── Suite 1: V5 Crossbow Constants — Existence ─────────────────────────
describe('V5 Crossbow Constants — Existence', () => {

  it('CROSSBOW_DRAW_DISTANCE is number', () => {
    assert.isType(Constants.CROSSBOW_DRAW_DISTANCE, 'number');
  });

  it('CROSSBOW_SPRING_K_WEAVER is 17600', () => {
    assert.isType(Constants.CROSSBOW_SPRING_K_WEAVER, 'number');
    assert.equal(Constants.CROSSBOW_SPRING_K_WEAVER, 17600);
  });

  it('CROSSBOW_SPRING_K_SPINNER is 5920', () => {
    assert.isType(Constants.CROSSBOW_SPRING_K_SPINNER, 'number');
    assert.equal(Constants.CROSSBOW_SPRING_K_SPINNER, 5920);
  });

  it('CROSSBOW_RELEASE_TIME is 0.05', () => {
    assert.isType(Constants.CROSSBOW_RELEASE_TIME, 'number');
    assert.equal(Constants.CROSSBOW_RELEASE_TIME, 0.05);
  });

  it('CROSSBOW_UNDOCK_TIME is 1.5', () => {
    assert.isType(Constants.CROSSBOW_UNDOCK_TIME, 'number');
    assert.equal(Constants.CROSSBOW_UNDOCK_TIME, 1.5);
  });

  it('CROSSBOW_LAUNCH_SPEED_DEFAULT is 10.0', () => {
    assert.isType(Constants.CROSSBOW_LAUNCH_SPEED_DEFAULT, 'number');
    assert.equal(Constants.CROSSBOW_LAUNCH_SPEED_DEFAULT, 10.0);
  });

  it('CROSSBOW_LAUNCH_SPEED_MIN is 3.0', () => {
    assert.isType(Constants.CROSSBOW_LAUNCH_SPEED_MIN, 'number');
    assert.equal(Constants.CROSSBOW_LAUNCH_SPEED_MIN, 3.0);
  });

  it('CROSSBOW_LAUNCH_SPEED_MAX is 20.0', () => {
    assert.isType(Constants.CROSSBOW_LAUNCH_SPEED_MAX, 'number');
    assert.equal(Constants.CROSSBOW_LAUNCH_SPEED_MAX, 20.0);
  });

  it('CROSSBOW_RELOAD_POWER is 15', () => {
    assert.isType(Constants.CROSSBOW_RELOAD_POWER, 'number');
    assert.equal(Constants.CROSSBOW_RELOAD_POWER, 15);
  });

  it('REEL_IN_SPEED_EMPTY is 2.0', () => {
    assert.isType(Constants.REEL_IN_SPEED_EMPTY, 'number');
    assert.equal(Constants.REEL_IN_SPEED_EMPTY, 2.0);
  });

  it('REEL_IN_SPEED_LOADED is 4.0', () => {
    assert.isType(Constants.REEL_IN_SPEED_LOADED, 'number');
    assert.equal(Constants.REEL_IN_SPEED_LOADED, 4.0);
  });

  it('V5_ARM_COUNT is 4 (Y0 Quad baseline — ST-9.2)', () => {
    assert.isType(Constants.V5_ARM_COUNT, 'number');
    assert.equal(Constants.V5_ARM_COUNT, 4);
  });

  it('V5_WEAVER_MASS is 6.6', () => {
    assert.isType(Constants.V5_WEAVER_MASS, 'number');
    assert.equal(Constants.V5_WEAVER_MASS, 6.6);
  });

  it('V5_SPINNER_MASS is 2.1', () => {
    assert.isType(Constants.V5_SPINNER_MASS, 'number');
    assert.equal(Constants.V5_SPINNER_MASS, 2.1);
  });

  it('DUALFIRE_SYNC_WINDOW is number', () => {
    assert.isType(Constants.DUALFIRE_SYNC_WINDOW, 'number');
  });

  it('DUALFIRE_RECOIL_WEAVER is number', () => {
    assert.isType(Constants.DUALFIRE_RECOIL_WEAVER, 'number');
  });

  it('PULSE_SCAN_DURATION is number', () => {
    assert.isType(Constants.PULSE_SCAN_DURATION, 'number');
  });

  it('PULSE_SCAN_COOLDOWN is number', () => {
    assert.isType(Constants.PULSE_SCAN_COOLDOWN, 'number');
  });

  it('ABLATION_LASER_POWER is number', () => {
    assert.isType(Constants.ABLATION_LASER_POWER, 'number');
  });

  it('TANGLE_RESOLVE_TIME is 8.0', () => {
    assert.isType(Constants.TANGLE_RESOLVE_TIME, 'number');
    assert.equal(Constants.TANGLE_RESOLVE_TIME, 8.0);
  });

  // --- Additional V5 constants (not explicitly listed but part of ~42) ---

  it('CROSSBOW_RELOAD_TIME_SPINNER_10 is number', () => {
    assert.isType(Constants.CROSSBOW_RELOAD_TIME_SPINNER_10, 'number');
  });

  it('CROSSBOW_RELOAD_TIME_WEAVER_10 is number', () => {
    assert.isType(Constants.CROSSBOW_RELOAD_TIME_WEAVER_10, 'number');
  });

  it('CROSSBOW_RELOAD_TIME_MULT is number', () => {
    assert.isType(Constants.CROSSBOW_RELOAD_TIME_MULT, 'number');
  });

  it('CROSSBOW_WORM_GEAR_EFFICIENCY is number', () => {
    assert.isType(Constants.CROSSBOW_WORM_GEAR_EFFICIENCY, 'number');
  });

  it('REEL_MOTOR_POWER is number', () => {
    assert.isType(Constants.REEL_MOTOR_POWER, 'number');
  });

  it('REEL_BRAKE_FORCE_MAX is number', () => {
    assert.isType(Constants.REEL_BRAKE_FORCE_MAX, 'number');
  });

  it('REEL_TENSION_WARNING is number', () => {
    assert.isType(Constants.REEL_TENSION_WARNING, 'number');
  });

  it('REEL_TENSION_CRITICAL is number', () => {
    assert.isType(Constants.REEL_TENSION_CRITICAL, 'number');
  });

  it('REEL_LEVEL_WIND_SPEED is number', () => {
    assert.isType(Constants.REEL_LEVEL_WIND_SPEED, 'number');
  });

  it('DUALFIRE_RECOIL_SPINNER is number', () => {
    assert.isType(Constants.DUALFIRE_RECOIL_SPINNER, 'number');
  });

  it('DUALFIRE_RCS_COMPENSATION_N2 is number', () => {
    assert.isType(Constants.DUALFIRE_RCS_COMPENSATION_N2, 'number');
  });

  it('PULSE_SCAN_RANGE_MULT is number', () => {
    assert.isType(Constants.PULSE_SCAN_RANGE_MULT, 'number');
  });

  it('PULSE_SCAN_POWER is number', () => {
    assert.isType(Constants.PULSE_SCAN_POWER, 'number');
  });

  it('ABLATION_RANGE_MAX is number', () => {
    assert.isType(Constants.ABLATION_RANGE_MAX, 'number');
  });

  it('ABLATION_DURATION_MAX is number', () => {
    assert.isType(Constants.ABLATION_DURATION_MAX, 'number');
  });

  it('ABLATION_DESPIN_RATE is number', () => {
    assert.isType(Constants.ABLATION_DESPIN_RATE, 'number');
  });

  it('V5_FRONT_ARM_TYPE is string', () => {
    assert.isType(Constants.V5_FRONT_ARM_TYPE, 'string');
  });

  it('V5_BACK_ARM_TYPE is string', () => {
    assert.isType(Constants.V5_BACK_ARM_TYPE, 'string');
  });

  it('TANGLE_DETECT_ANGLE is number', () => {
    assert.isType(Constants.TANGLE_DETECT_ANGLE, 'number');
  });

  it('TANGLE_SLACK_PULSE is number', () => {
    assert.isType(Constants.TANGLE_SLACK_PULSE, 'number');
  });
});

// ── Suite 2: V5 Crossbow Constants — ARM_STATES ────────────────────────
describe('V5 Crossbow Constants — ARM_STATES', () => {

  it("LAUNCHING equals 'LAUNCHING'", () => {
    assert.equal(ARM_STATES.LAUNCHING, 'LAUNCHING');
  });

  it("REELING equals 'REELING'", () => {
    assert.equal(ARM_STATES.REELING, 'REELING');
  });

  it("RELOADING equals 'RELOADING'", () => {
    assert.equal(ARM_STATES.RELOADING, 'RELOADING');
  });

  it("ABLATING equals 'ABLATING'", () => {
    assert.equal(ARM_STATES.ABLATING, 'ABLATING');
  });

  it("SCANNING equals 'SCANNING'", () => {
    assert.equal(ARM_STATES.SCANNING, 'SCANNING');
  });

  it("TANGLED equals 'TANGLED'", () => {
    assert.equal(ARM_STATES.TANGLED, 'TANGLED');
  });

  it('original state DOCKED still exists', () => {
    assert.equal(ARM_STATES.DOCKED, 'DOCKED');
  });

  it('original state TRANSIT still exists', () => {
    assert.equal(ARM_STATES.TRANSIT, 'TRANSIT');
  });

  it('original state APPROACH still exists', () => {
    assert.equal(ARM_STATES.APPROACH, 'APPROACH');
  });

  it('original state NETTING still exists', () => {
    assert.equal(ARM_STATES.NETTING, 'NETTING');
  });

  it('original state GRAPPLED still exists', () => {
    assert.equal(ARM_STATES.GRAPPLED, 'GRAPPLED');
  });

  it('original state DOCKING still exists', () => {
    assert.equal(ARM_STATES.DOCKING, 'DOCKING');
  });
});

// ── Suite 3: V5 Crossbow Constants — SPRING_TIERS ──────────────────────
describe('V5 Crossbow Constants — SPRING_TIERS', () => {

  it('SPRING_TIERS is an array of length 5', () => {
    assert.ok(Array.isArray(SPRING_TIERS), 'SPRING_TIERS should be an array');
    assert.equal(SPRING_TIERS.length, 5);
  });

  it('each tier has name, maxSpeed, reloadMult, cost', () => {
    for (const tier of SPRING_TIERS) {
      assert.isType(tier.name, 'string', `tier.name should be string`);
      assert.isType(tier.maxSpeed, 'number', `tier.maxSpeed should be number`);
      assert.isType(tier.reloadMult, 'number', `tier.reloadMult should be number`);
      assert.isType(tier.cost, 'number', `tier.cost should be number`);
    }
  });

  it('T1 cost is 0 (free starter)', () => {
    assert.equal(SPRING_TIERS[0].cost, 0);
  });

  it('T5 maxSpeed is 25.0', () => {
    assert.equal(SPRING_TIERS[4].maxSpeed, 25.0);
  });

  it('tiers are in ascending maxSpeed order', () => {
    for (let i = 1; i < SPRING_TIERS.length; i++) {
      assert.ok(SPRING_TIERS[i].maxSpeed > SPRING_TIERS[i - 1].maxSpeed,
        `T${i + 1} maxSpeed (${SPRING_TIERS[i].maxSpeed}) should exceed T${i} (${SPRING_TIERS[i - 1].maxSpeed})`);
    }
  });

  it('tiers are in ascending cost order', () => {
    for (let i = 1; i < SPRING_TIERS.length; i++) {
      assert.ok(SPRING_TIERS[i].cost > SPRING_TIERS[i - 1].cost,
        `T${i + 1} cost (${SPRING_TIERS[i].cost}) should exceed T${i} (${SPRING_TIERS[i - 1].cost})`);
    }
  });
});

// ── Suite 4: V5 Crossbow Constants — TETHER_TIERS ──────────────────────
describe('V5 Crossbow Constants — TETHER_TIERS', () => {

  it('TETHER_TIERS is an array of length 5', () => {
    assert.ok(Array.isArray(TETHER_TIERS), 'TETHER_TIERS should be an array');
    assert.equal(TETHER_TIERS.length, 5);
  });

  it('each tier has name, breakStrength, mass_per_km, maxLength, cost', () => {
    for (const tier of TETHER_TIERS) {
      assert.isType(tier.name, 'string', `tier.name should be string`);
      assert.isType(tier.breakStrength, 'number', `tier.breakStrength should be number`);
      assert.isType(tier.mass_per_km, 'number', `tier.mass_per_km should be number`);
      assert.isType(tier.maxLength, 'number', `tier.maxLength should be number`);
      assert.isType(tier.cost, 'number', `tier.cost should be number`);
    }
  });

  it('T1 cost is 0 (free starter)', () => {
    assert.equal(TETHER_TIERS[0].cost, 0);
  });

  it('T5 breakStrength is 800', () => {
    assert.equal(TETHER_TIERS[4].breakStrength, 800);
  });

  it('T5 maxLength is 10000', () => {
    assert.equal(TETHER_TIERS[4].maxLength, 10000);
  });

  it('tiers are in ascending breakStrength order', () => {
    for (let i = 1; i < TETHER_TIERS.length; i++) {
      assert.ok(TETHER_TIERS[i].breakStrength > TETHER_TIERS[i - 1].breakStrength,
        `T${i + 1} breakStrength (${TETHER_TIERS[i].breakStrength}) should exceed T${i} (${TETHER_TIERS[i - 1].breakStrength})`);
    }
  });
});

// ── Suite 5: V5 Crossbow Constants — Physics Validation ────────────────
describe('V5 Crossbow Constants — Physics Validation', () => {
  const d = Constants.CROSSBOW_DRAW_DISTANCE;   // 0.25 m
  const kW = Constants.CROSSBOW_SPRING_K_WEAVER;  // 17600 N/m
  const kS = Constants.CROSSBOW_SPRING_K_SPINNER;  // 5920 N/m
  const mW_orig = 11;   // Original Weaver mass (spring K calibrated for this)
  const mS_orig = 3.7;  // Original Spinner mass
  const mW_v5 = Constants.V5_WEAVER_MASS;  // 6.6
  const mS_v5 = Constants.V5_SPINNER_MASS; // 2.1

  it('Weaver spring energy E = ½kd² = 550 J', () => {
    const E = 0.5 * kW * d * d;
    assert.closeTo(E, 550, 0.1, `Weaver spring energy should be 550J, got ${E}`);
  });

  it('Spinner spring energy E = ½kd² = 185 J', () => {
    const E = 0.5 * kS * d * d;
    assert.closeTo(E, 185, 0.1, `Spinner spring energy should be 185J, got ${E}`);
  });

  it('Weaver launch speed at original mass (11kg) = 10.0 m/s', () => {
    const v = d * Math.sqrt(kW / mW_orig);
    assert.closeTo(v, 10.0, 0.05, `v = d√(k/m) should be 10.0, got ${v}`);
  });

  it('Spinner launch speed at original mass (3.7kg) = 10.0 m/s', () => {
    const v = d * Math.sqrt(kS / mS_orig);
    assert.closeTo(v, 10.0, 0.05, `v = d√(k/m) should be 10.0, got ${v}`);
  });

  it('Weaver launch speed at V5 mass (6.6kg) ≈ 12.9 m/s', () => {
    const v = d * Math.sqrt(kW / mW_v5);
    assert.closeTo(v, 12.9, 0.1, `V5 Weaver speed should be ~12.9, got ${v}`);
  });

  it('Spinner launch speed at V5 mass (2.1kg) ≈ 13.3 m/s', () => {
    const v = d * Math.sqrt(kS / mS_v5);
    assert.closeTo(v, 13.3, 0.1, `V5 Spinner speed should be ~13.3, got ${v}`);
  });

  it('Recoil speed Weaver ≈ DUALFIRE_RECOIL_WEAVER', () => {
    // p = mv/M where M=130kg mothership, m=6.6kg, v=10 m/s
    const recoil = mW_v5 * 10 / 130;
    assert.closeTo(recoil, Constants.DUALFIRE_RECOIL_WEAVER, 0.01,
      `Recoil ${recoil} should be close to ${Constants.DUALFIRE_RECOIL_WEAVER}`);
  });

  it('Reload time at 10 m/s for Weaver (original mass calibration) ≈ 45.8s', () => {
    const P = Constants.CROSSBOW_RELOAD_POWER;
    const eta = Constants.CROSSBOW_WORM_GEAR_EFFICIENCY;
    // Using original mass energy: E = ½ × 11 × 10² = 550J
    const E = 0.5 * mW_orig * 10 * 10;
    const t = E / (P * eta);
    assert.closeTo(t, 45.83, 0.1, `Reload time should be ~45.83s, got ${t}`);
  });
});

// ── Suite 6: V5 Crossbow Events — Existence ────────────────────────────
describe('V5 Crossbow Events — Existence', () => {

  it("CROSSBOW_FIRE is 'crossbow:fire'", () => {
    assert.equal(Events.CROSSBOW_FIRE, 'crossbow:fire');
  });

  it('CROSSBOW_RELOAD_START is string', () => {
    assert.isType(Events.CROSSBOW_RELOAD_START, 'string');
  });

  it('CROSSBOW_RELOAD_COMPLETE is string', () => {
    assert.isType(Events.CROSSBOW_RELOAD_COMPLETE, 'string');
  });

  it('TETHER_TENSION_UPDATE is string', () => {
    assert.isType(Events.TETHER_TENSION_UPDATE, 'string');
  });

  it('TETHER_TANGLE is string', () => {
    assert.isType(Events.TETHER_TANGLE, 'string');
  });

  it('TETHER_SNAP is string', () => {
    assert.isType(Events.TETHER_SNAP, 'string');
  });

  it('TETHER_REEL_STATE is string', () => {
    assert.isType(Events.TETHER_REEL_STATE, 'string');
  });

  it('DUAL_FIRE is string', () => {
    assert.isType(Events.DUAL_FIRE, 'string');
  });

  it('DUAL_FIRE_RECOIL is string', () => {
    assert.isType(Events.DUAL_FIRE_RECOIL, 'string');
  });

  it('PULSE_SCAN_START is string', () => {
    assert.isType(Events.PULSE_SCAN_START, 'string');
  });

  it('PULSE_SCAN_COMPLETE is string', () => {
    assert.isType(Events.PULSE_SCAN_COMPLETE, 'string');
  });

  it('ABLATION_START is string', () => {
    assert.isType(Events.ABLATION_START, 'string');
  });

  it('ABLATION_END is string', () => {
    assert.isType(Events.ABLATION_END, 'string');
  });

  it('no two V5 events share the same string value', () => {
    const v5Events = [
      Events.CROSSBOW_FIRE, Events.CROSSBOW_RELOAD_START, Events.CROSSBOW_RELOAD_COMPLETE,
      Events.TETHER_TENSION_UPDATE, Events.TETHER_TANGLE, Events.TETHER_SNAP,
      Events.TETHER_REEL_STATE, Events.DUAL_FIRE, Events.DUAL_FIRE_RECOIL,
      Events.PULSE_SCAN_START, Events.PULSE_SCAN_COMPLETE,
      Events.ABLATION_START, Events.ABLATION_END,
    ];
    const unique = new Set(v5Events);
    assert.equal(unique.size, v5Events.length,
      `Expected ${v5Events.length} unique event strings, got ${unique.size}`);
  });
});

// ── Suite 7: V5 Crossbow — Deprecated Constants ────────────────────────
describe('V5 Crossbow — Deprecated Constants', () => {

  it('ARM_GAMIFIED_THRUST_MULT still exists — value 200', () => {
    assert.equal(Constants.ARM_GAMIFIED_THRUST_MULT, 200);
  });

  it('ARM_LAUNCH_SPEED still exists — value 10.0', () => {
    assert.equal(Constants.ARM_LAUNCH_SPEED, 10.0);
  });
});
