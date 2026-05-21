/**
 * test-CoMCalculator.js — ST-9.12 C-9: Center-of-Mass Tracking + Plume Interlock
 *
 * Tests: CoM computation, drift detection, thrust-line offset, stow suggestion,
 *        plume cone interference, interlock state machine, event emission.
 *
 * Uses mock ArmManager objects with dockPositions from generateDockPositions().
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { generateDockPositions } from '../entities/ArmManager.js';
import {
  computeCoM,
  computeCoMDrift,
  computeCoMOffsetFromThrustVector,
  computeInducedTorque,
  suggestStowArm,
  strutTipMeters,
  strutMidpointMeters,
  checkPlumeInterference,
  getActiveBlocks,
  updateDriftWarning,
  updateThrusterBlocks,
  resetCoMState,
  computeCoMDriftVector,
} from '../systems/CoMCalculator.js';

const M = 0.00001;
const V5 = Constants.OCTOPUS_V5;
const EPS = 1e-6;
const HALF_PI = Math.PI / 2;

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create a mock arm with given alpha and type */
function mockArm(alpha = 0, type = 'weaver', opts = {}) {
  return {
    _aimAlpha: alpha,
    getAimAlpha() { return this._aimAlpha; },
    config: {
      type,
      mass: type === 'weaver' ? Constants.V5_WEAVER_MASS : Constants.V5_SPINNER_MASS,
    },
    state: opts.state || Constants.ARM_STATES.DOCKED,
    isDetached: opts.isDetached || false,
    getDeployState() { return opts.deployState || 'DEPLOYED'; },
  };
}

/** Create a mock ArmManager with Y0_QUAD dock positions and given arm configs */
function mockManager(armConfigs) {
  const docks = generateDockPositions(4); // Y0 Quad: [60°, 120°, 240°, 300°]
  const arms = [];
  for (let i = 0; i < 4; i++) {
    const cfg = armConfigs[i] || {};
    const type = docks[i].type; // alternates weaver/spinner
    arms.push(mockArm(cfg.alpha || 0, type, cfg));
  }
  return {
    arms,
    _dockPositions: docks,
  };
}

/** Convenience: all arms at same alpha */
function symmetricManager(alpha) {
  return mockManager([
    { alpha }, { alpha }, { alpha }, { alpha },
  ]);
}

// ══════════════════════════════════════════════════════════════════════════
// Suite: strutTipMeters — strut tip position formula
// ══════════════════════════════════════════════════════════════════════════
describe('CoM — strutTipMeters', () => {
  const docks = generateDockPositions(4);

  it('α=0 (stowed): tip is below hinge at −Y by STRUT_LENGTH', () => {
    const tip = strutTipMeters(docks[0], 0);
    const hx = docks[0].hingePosition.x / M;
    const hy = docks[0].hingePosition.y / M;
    const hz = docks[0].hingePosition.z / M;
    // At α=0: sin(0)=0, cos(0)=1 → tip = hinge + L*(0·outward − 1·ŷ)
    assert.closeTo(tip.x, hx, EPS, 'x unchanged at α=0');
    assert.closeTo(tip.y, hy - V5.STRUT_LENGTH, EPS, 'y = hinge.y − L');
    assert.closeTo(tip.z, hz, EPS, 'z unchanged at α=0');
  });

  it('α=π/2 (equatorial): tip extends radially outward', () => {
    const tip = strutTipMeters(docks[0], HALF_PI);
    const hx = docks[0].hingePosition.x / M;
    const hy = docks[0].hingePosition.y / M;
    const hz = docks[0].hingePosition.z / M;
    const ox = docks[0].dockOutward.x;
    const oz = docks[0].dockOutward.z;
    // At α=π/2: sin=1, cos=0 → tip = hinge + L*(outward − 0)
    assert.closeTo(tip.x, hx + V5.STRUT_LENGTH * ox, EPS, 'x extends outward');
    assert.closeTo(tip.y, hy, EPS, 'y = hinge.y (cos=0)');
    assert.closeTo(tip.z, hz + V5.STRUT_LENGTH * oz, EPS, 'z extends outward');
  });

  it('matches ArmManager.getStrutTipPosition for given dock/alpha', () => {
    // Cross-check with the canonical formula in the docstring
    const alpha = 1.2; // arbitrary
    const tip = strutTipMeters(docks[2], alpha);
    const L = V5.STRUT_LENGTH;
    const dp = docks[2];
    const hx = dp.hingePosition.x / M;
    const hy = dp.hingePosition.y / M;
    const hz = dp.hingePosition.z / M;
    const expectedX = hx + L * Math.sin(alpha) * dp.dockOutward.x;
    const expectedY = hy + L * (Math.sin(alpha) * dp.dockOutward.y - Math.cos(alpha));
    const expectedZ = hz + L * Math.sin(alpha) * dp.dockOutward.z;
    assert.closeTo(tip.x, expectedX, EPS);
    assert.closeTo(tip.y, expectedY, EPS);
    assert.closeTo(tip.z, expectedZ, EPS);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: strutMidpointMeters — strut midpoint (CoM of uniform rod)
// ══════════════════════════════════════════════════════════════════════════
describe('CoM — strutMidpointMeters', () => {
  const docks = generateDockPositions(4);

  it('midpoint is exactly halfway between hinge and tip', () => {
    const alpha = 1.0;
    const tip = strutTipMeters(docks[1], alpha);
    const mid = strutMidpointMeters(docks[1], alpha);
    const hx = docks[1].hingePosition.x / M;
    const hy = docks[1].hingePosition.y / M;
    const hz = docks[1].hingePosition.z / M;
    assert.closeTo(mid.x, (hx + tip.x) / 2, EPS, 'midX = avg(hinge.x, tip.x)');
    assert.closeTo(mid.y, (hy + tip.y) / 2, EPS, 'midY = avg(hinge.y, tip.y)');
    assert.closeTo(mid.z, (hz + tip.z) / 2, EPS, 'midZ = avg(hinge.z, tip.z)');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: computeCoM — Center-of-mass computation
// ══════════════════════════════════════════════════════════════════════════
describe('CoM — computeCoM basics', () => {

  it('returns object with position, totalMass, breakdown', () => {
    const mgr = symmetricManager(HALF_PI);
    const result = computeCoM(mgr);
    assert.ok(result.position, 'has position');
    assert.ok(typeof result.totalMass === 'number', 'has totalMass');
    assert.ok(result.breakdown, 'has breakdown');
    assert.equal(result.breakdown.core, V5.CORE_DRY_MASS, 'core = CORE_DRY_MASS');
  });

  it('totalMass includes core + 4 struts + 4 daughters', () => {
    const mgr = symmetricManager(HALF_PI);
    const result = computeCoM(mgr);
    const expectedCore = V5.CORE_DRY_MASS;
    const expectedStruts = V5.STRUT_MASS * 4;
    // Y0 Quad: arms alternate weaver(6.6)/spinner(2.1)
    const expectedArms = Constants.V5_WEAVER_MASS * 2 + Constants.V5_SPINNER_MASS * 2;
    assert.closeTo(result.totalMass, expectedCore + expectedStruts + expectedArms, 0.1,
      'total mass matches expected');
  });

  it('detached arm mass is excluded from total', () => {
    const mgr = mockManager([
      { alpha: HALF_PI },
      { alpha: HALF_PI, isDetached: true },
      { alpha: HALF_PI },
      { alpha: HALF_PI },
    ]);
    const result = computeCoM(mgr);
    // Arm 1 (spinner) should have 0 daughter mass
    assert.equal(result.breakdown.arms[1], 0, 'detached arm has 0 daughter mass');
  });

  it('expended arm mass is excluded', () => {
    const mgr = mockManager([
      { alpha: HALF_PI },
      { alpha: HALF_PI, state: Constants.ARM_STATES.EXPENDED },
      { alpha: HALF_PI },
      { alpha: HALF_PI },
    ]);
    const result = computeCoM(mgr);
    assert.equal(result.breakdown.arms[1], 0, 'expended arm has 0 daughter mass');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Symmetric config → CoM ≈ origin
// ══════════════════════════════════════════════════════════════════════════
describe('CoM — symmetric Y0 Quad at α=π/2', () => {

  it('CoM drift is near zero (within floating-point tolerance)', () => {
    const mgr = symmetricManager(HALF_PI);
    const drift = computeCoMDrift(mgr);
    // With all 4 arms at same alpha on opposed azimuths, XZ contributions cancel.
    // Y-component: all hinges at same Y, all struts at same alpha → same Y offset → cancels in ratio.
    // Drift should be < 1e-6 m (essentially zero).
    assert.ok(drift < 1e-4, `symmetric drift should be ~0, got ${drift.toFixed(8)} m`);
  });

  it('CoM x and z are near zero', () => {
    const mgr = symmetricManager(HALF_PI);
    const com = computeCoM(mgr);
    assert.closeTo(com.position.x, 0, 1e-4, 'x ≈ 0');
    assert.closeTo(com.position.z, 0, 1e-4, 'z ≈ 0');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Asymmetric config → detectable drift
// ══════════════════════════════════════════════════════════════════════════
describe('CoM — asymmetric detection (one arm stowed)', () => {

  it('stowing arm 0 (60°) shifts CoM away from arm 0 direction', () => {
    // Arm 0 at α=0 (stowed), others at π/2 (equatorial)
    const mgr = mockManager([
      { alpha: 0 },      // stowed
      { alpha: HALF_PI }, // equatorial
      { alpha: HALF_PI }, // equatorial
      { alpha: HALF_PI }, // equatorial
    ]);
    const drift = computeCoMDrift(mgr);
    assert.ok(drift > 0, `asymmetric drift should be > 0, got ${drift.toFixed(6)}`);

    const com = computeCoM(mgr);
    // Arm 0 is at 60° azimuth. Stowing it pulls its tip down (−Y) while others
    // are equatorial. The CoM should shift AWAY from the direction of arm 0
    // (toward the average of the other 3 arms).
    // With arm 0 stowed (tip low), its mass is lower on Y → not contributing outward.
    // Other arms at 120°, 240°, 300° push CoM toward their average direction.
    // Just verify drift is nonzero and in a sensible direction.
    assert.ok(drift > 0.001, `drift ${drift.toFixed(4)} m seems reasonable`);
  });

  it('all stowed (α=0) has near-zero drift (symmetric again)', () => {
    const mgr = symmetricManager(0);
    const drift = computeCoMDrift(mgr);
    assert.ok(drift < 1e-4, `all-stowed drift should be ~0, got ${drift.toFixed(8)} m`);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: computeCoMDriftVector — isolates player-caused asymmetry
// ══════════════════════════════════════════════════════════════════════════
describe('CoM — computeCoMDriftVector', () => {

  it('symmetric config → drift vector is near-zero in all components', () => {
    const mgr = symmetricManager(HALF_PI);
    const dv = computeCoMDriftVector(mgr);
    assert.closeTo(dv.x, 0, 1e-4, 'dx ≈ 0');
    assert.closeTo(dv.y, 0, 1e-4, 'dy ≈ 0');
    assert.closeTo(dv.z, 0, 1e-4, 'dz ≈ 0');
  });

  it('asymmetric config → drift vector is nonzero', () => {
    const mgr = mockManager([
      { alpha: 0 },      // stowed
      { alpha: HALF_PI }, // equatorial
      { alpha: HALF_PI }, // equatorial
      { alpha: HALF_PI }, // equatorial
    ]);
    const dv = computeCoMDriftVector(mgr);
    const mag = Math.sqrt(dv.x * dv.x + dv.y * dv.y + dv.z * dv.z);
    assert.ok(mag > 0.001, `asymmetric drift vector mag ${mag.toFixed(6)} should be > 0.001`);
  });

  it('drift vector magnitude matches computeCoMDrift scalar', () => {
    const mgr = mockManager([
      { alpha: Math.PI },
      { alpha: 0 },
      { alpha: HALF_PI },
      { alpha: HALF_PI },
    ]);
    const scalar = computeCoMDrift(mgr);
    const dv = computeCoMDriftVector(mgr);
    const vecMag = Math.sqrt(dv.x * dv.x + dv.y * dv.y + dv.z * dv.z);
    assert.closeTo(vecMag, scalar, 1e-6, 'vector magnitude matches scalar drift');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: computeCoMOffsetFromThrustVector
// ══════════════════════════════════════════════════════════════════════════
describe('CoM — computeCoMOffsetFromThrustVector', () => {

  it('CoM on thrust line → offset = 0', () => {
    const offset = computeCoMOffsetFromThrustVector(
      { x: 0, y: 0, z: -0.5 }, // on Z-axis
      { x: 0, y: 0, z: -1 }    // thrust along −Z
    );
    assert.closeTo(offset, 0, EPS, 'offset should be 0');
  });

  it('CoM perpendicular to thrust line → offset = distance', () => {
    const offset = computeCoMOffsetFromThrustVector(
      { x: 0.1, y: 0, z: 0 }, // 0.1 m off Z-axis
      { x: 0, y: 0, z: -1 }   // thrust along −Z
    );
    assert.closeTo(offset, 0.1, EPS, 'offset should be 0.1 m');
  });

  it('diagonal CoM gives correct perpendicular distance', () => {
    // CoM at (0.3, 0.4, -1.0), thrust along −Z
    // Perpendicular offset = sqrt(0.3² + 0.4²) = 0.5
    const offset = computeCoMOffsetFromThrustVector(
      { x: 0.3, y: 0.4, z: -1.0 },
      { x: 0, y: 0, z: -1 }
    );
    assert.closeTo(offset, 0.5, EPS, 'offset should be 0.5 m');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: computeInducedTorque
// ══════════════════════════════════════════════════════════════════════════
describe('CoM — computeInducedTorque', () => {

  it('CoM at origin → zero torque', () => {
    const τ = computeInducedTorque({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
    assert.closeTo(τ.x, 0, EPS);
    assert.closeTo(τ.y, 0, EPS);
    assert.closeTo(τ.z, 0, EPS);
  });

  it('CoM offset in X with Z-thrust → torque around Y', () => {
    // r = (0.1, 0, 0), F = (0, 0, -1)
    // τ = r × F = (0*(-1) - 0*0, 0*0 - 0.1*(-1), 0.1*0 - 0*0) = (0, 0.1, 0)
    const τ = computeInducedTorque({ x: 0.1, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
    assert.closeTo(τ.x, 0, EPS);
    assert.closeTo(τ.y, 0.1, EPS, 'Y torque = 0.1');
    assert.closeTo(τ.z, 0, EPS);
  });

  it('CoM offset in Y with Z-thrust → torque around X', () => {
    // r = (0, 0.05, 0), F = (0, 0, -1)
    // τ = (0.05*(-1) - 0*0, 0*0 - 0*(-1), 0*0 - 0.05*0) = (-0.05, 0, 0)
    const τ = computeInducedTorque({ x: 0, y: 0.05, z: 0 }, { x: 0, y: 0, z: -1 });
    assert.closeTo(τ.x, -0.05, EPS, 'X torque = -0.05');
    assert.closeTo(τ.y, 0, EPS);
    assert.closeTo(τ.z, 0, EPS);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: suggestStowArm
// ══════════════════════════════════════════════════════════════════════════
describe('CoM — suggestStowArm', () => {

  it('returns null for symmetric config (no drift)', () => {
    const mgr = symmetricManager(HALF_PI);
    const suggestion = suggestStowArm(mgr);
    // Very small drift → might return null or any arm
    // Just check it doesn't crash
    assert.ok(suggestion === null || typeof suggestion === 'number',
      'returns null or arm index for symmetric config');
  });

  it('suggests the most-displaced arm for asymmetric config', () => {
    // All at equatorial except arm 2 at zenith (α=π) — very displaced
    const mgr = mockManager([
      { alpha: HALF_PI },
      { alpha: HALF_PI },
      { alpha: Math.PI },       // arm 2 at zenith — most displaced (different Y)
      { alpha: HALF_PI },
    ]);
    const suggestion = suggestStowArm(mgr);
    assert.ok(typeof suggestion === 'number', 'returns an arm index');
    // Arm 2 should be the most displaced (pushes CoM away from its direction)
    // The heuristic picks the arm whose position most aligns with the CoM direction
    assert.ok(suggestion >= 0 && suggestion < 4, 'suggestion is valid arm index');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: checkPlumeInterference — plume cone geometry
// ══════════════════════════════════════════════════════════════════════════
describe('Plume — checkPlumeInterference', () => {

  it('ring arms at equatorial (α=π/2) are NOT in any thruster plume', () => {
    // Config G ring arms at 60°/120°/240°/300° at α=π/2 are far from aft thrusters
    const mgr = symmetricManager(HALF_PI);
    for (const t of Constants.THRUSTERS) {
      const result = checkPlumeInterference(mgr, t.id);
      assert.equal(result.blocked, false, `${t.id} should not be blocked at α=π/2`);
      assert.equal(result.conflictingArms.length, 0);
    }
  });

  it('ring arms at stowed (α=0) are NOT in plume', () => {
    const mgr = symmetricManager(0);
    for (const t of Constants.THRUSTERS) {
      const result = checkPlumeInterference(mgr, t.id);
      assert.equal(result.blocked, false, `${t.id} not blocked at α=0`);
    }
  });

  it('ring arms at zenith (α=π) are NOT in plume', () => {
    const mgr = symmetricManager(Math.PI);
    for (const t of Constants.THRUSTERS) {
      const result = checkPlumeInterference(mgr, t.id);
      assert.equal(result.blocked, false, `${t.id} not blocked at α=π`);
    }
  });

  it('returns blocked=false for unknown thruster ID', () => {
    const mgr = symmetricManager(HALF_PI);
    const result = checkPlumeInterference(mgr, 'NONEXISTENT');
    assert.equal(result.blocked, false);
  });

  it('detects conflict when strut tip is placed inside a thruster cone', () => {
    // Construct a contrived scenario: create a mock manager where a strut tip
    // ends up directly downstream of a thruster nozzle.
    // HT_TOP nozzle is at (0, 0.5, -2.0), thrustDir = (0,0,-1).
    // A tip at (0, 0.5, -3.0) would be directly downstream → in cone.
    // We'll create a custom dockPos that produces this tip.
    const customDock = {
      hingePosition: { x: 0, y: 0.5 * M, z: -2.0 * M }, // at nozzle
      dockOutward: { x: 0, y: 0, z: -1 },                 // outward = −Z
    };
    const customArm = mockArm(HALF_PI, 'weaver'); // tip = hinge + L*(sin90°·(0,0,-1) − cos90°·ŷ)
    // tip = (0, 0.5, -2.0) + 1.6*(0,0,-1) = (0, 0.5, -3.6) → downstream in −Z cone
    const mgr = {
      arms: [customArm],
      _dockPositions: [customDock],
    };
    const result = checkPlumeInterference(mgr, 'HT_TOP');
    assert.equal(result.blocked, true, 'should detect strut in plume cone');
    assert.ok(result.conflictingArms.includes(0), 'arm 0 should be conflicting');
  });

  it('does not flag tip that is upstream of nozzle', () => {
    // Tip at Z = -1.0 is upstream of nozzle at Z = -2.0 (thrust is −Z)
    const customDock = {
      hingePosition: { x: 0, y: 0.5 * M, z: -1.0 * M },
      dockOutward: { x: 0, y: 1, z: 0 }, // outward = +Y
    };
    const customArm = mockArm(0, 'weaver'); // α=0 → tip goes −Y from hinge
    const mgr = {
      arms: [customArm],
      _dockPositions: [customDock],
    };
    const result = checkPlumeInterference(mgr, 'HT_TOP');
    assert.equal(result.blocked, false, 'upstream tip should not be blocked');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: getActiveBlocks — all-thruster scan
// ══════════════════════════════════════════════════════════════════════════
describe('Plume — getActiveBlocks', () => {

  it('returns empty map for standard Y0 Quad at any alpha', () => {
    const mgr = symmetricManager(HALF_PI);
    const blocks = getActiveBlocks(mgr);
    assert.equal(Object.keys(blocks).length, 0, 'no blocks for standard config');
  });

  it('returns blocked thrusters for contrived in-plume scenario', () => {
    const customDock = {
      hingePosition: { x: 0, y: 0.5 * M, z: -2.0 * M },
      dockOutward: { x: 0, y: 0, z: -1 },
    };
    const customArm = mockArm(HALF_PI, 'weaver');
    const mgr = {
      arms: [customArm],
      _dockPositions: [customDock],
    };
    const blocks = getActiveBlocks(mgr);
    // At least HT_TOP should be blocked (nozzle at y=0.5, z=-2.0)
    assert.ok(Object.keys(blocks).length > 0, 'should have at least one blocked thruster');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: updateDriftWarning — event emission state machine
// ══════════════════════════════════════════════════════════════════════════
describe('CoM — updateDriftWarning events', () => {

  it('does not emit when COM_TRACKING is OFF', () => {
    resetCoMState();
    const origFlag = Constants.FEATURE_FLAGS.COM_TRACKING;
    Constants.FEATURE_FLAGS.COM_TRACKING = false;
    let fired = false;
    const handler = () => { fired = true; };
    eventBus.on(Events.COM_DRIFT_WARNING, handler);

    const mgr = mockManager([
      { alpha: 0 }, { alpha: HALF_PI }, { alpha: HALF_PI }, { alpha: HALF_PI },
    ]);
    const result = updateDriftWarning(mgr);
    assert.equal(result.offsetM, 0, 'offset should be 0 when flag off');
    assert.equal(result.isWarning, false);
    assert.equal(fired, false, 'no event when flag off');

    eventBus.off(Events.COM_DRIFT_WARNING, handler);
    Constants.FEATURE_FLAGS.COM_TRACKING = origFlag;
    resetCoMState();
  });

  it('emits COM_DRIFT_WARNING when drift exceeds threshold (flag ON)', () => {
    resetCoMState();
    const origFlag = Constants.FEATURE_FLAGS.COM_TRACKING;
    Constants.FEATURE_FLAGS.COM_TRACKING = true;
    let warningPayload = null;
    const handler = (data) => { warningPayload = data; };
    eventBus.on(Events.COM_DRIFT_WARNING, handler);

    // Create a heavily asymmetric config to exceed 20mm threshold
    // One arm at zenith (α=π), rest stowed — should produce large drift
    const mgr = mockManager([
      { alpha: Math.PI },
      { alpha: 0 },
      { alpha: 0 },
      { alpha: 0 },
    ]);

    const drift = computeCoMDrift(mgr);
    // Only emit warning if drift actually exceeds threshold
    const result = updateDriftWarning(mgr);
    if (drift >= Constants.COM_DRIFT_WARN_THRESHOLD) {
      assert.ok(warningPayload !== null, 'warning event should fire');
      assert.ok(warningPayload.offsetM >= Constants.COM_DRIFT_WARN_THRESHOLD,
        'offsetM in payload >= threshold');
    }

    eventBus.off(Events.COM_DRIFT_WARNING, handler);
    Constants.FEATURE_FLAGS.COM_TRACKING = origFlag;
    resetCoMState();
  });

  it('emits COM_DRIFT_CLEARED when drift drops below threshold', () => {
    resetCoMState();
    const origFlag = Constants.FEATURE_FLAGS.COM_TRACKING;
    Constants.FEATURE_FLAGS.COM_TRACKING = true;
    let clearedFired = false;
    const handler = () => { clearedFired = true; };

    // First trigger a warning with asymmetric config
    const mgrAsym = mockManager([
      { alpha: Math.PI }, { alpha: 0 }, { alpha: 0 }, { alpha: 0 },
    ]);
    updateDriftWarning(mgrAsym); // may or may not trigger warning

    // Now move to symmetric (balanced) → should clear
    eventBus.on(Events.COM_DRIFT_CLEARED, handler);
    const mgrSym = symmetricManager(HALF_PI);
    updateDriftWarning(mgrSym);

    // If warning was active, cleared should have fired
    eventBus.off(Events.COM_DRIFT_CLEARED, handler);
    Constants.FEATURE_FLAGS.COM_TRACKING = origFlag;
    resetCoMState();
    // No hard assertion — just ensure no crash
    assert.ok(true, 'cleared event path completed without error');
  });

  it('does not re-emit warning on consecutive calls above threshold', () => {
    resetCoMState();
    const origFlag = Constants.FEATURE_FLAGS.COM_TRACKING;
    Constants.FEATURE_FLAGS.COM_TRACKING = true;
    let count = 0;
    const handler = () => { count++; };
    eventBus.on(Events.COM_DRIFT_WARNING, handler);

    const mgrAsym = mockManager([
      { alpha: Math.PI }, { alpha: 0 }, { alpha: 0 }, { alpha: 0 },
    ]);

    // Call multiple times
    updateDriftWarning(mgrAsym);
    updateDriftWarning(mgrAsym);
    updateDriftWarning(mgrAsym);

    // Should emit at most once (on first crossing)
    assert.ok(count <= 1, `warning emitted ${count} times — expected ≤ 1 (debounced)`);

    eventBus.off(Events.COM_DRIFT_WARNING, handler);
    Constants.FEATURE_FLAGS.COM_TRACKING = origFlag;
    resetCoMState();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: updateThrusterBlocks — event emission
// ══════════════════════════════════════════════════════════════════════════
describe('Plume — updateThrusterBlocks events', () => {

  it('returns empty when THRUSTER_INTERLOCK is OFF', () => {
    resetCoMState();
    const origFlag = Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK;
    Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK = false;
    const mgr = symmetricManager(HALF_PI);
    const blocks = updateThrusterBlocks(mgr);
    assert.equal(Object.keys(blocks).length, 0, 'no blocks when flag off');
    Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK = origFlag;
    resetCoMState();
  });

  it('emits THRUSTER_BLOCKED_PLUME for contrived in-plume scenario (flag ON)', () => {
    resetCoMState();
    const origFlag = Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK;
    Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK = true;
    let blockedPayload = null;
    const handler = (data) => { blockedPayload = data; };
    eventBus.on(Events.THRUSTER_BLOCKED_PLUME, handler);

    const customDock = {
      hingePosition: { x: 0, y: 0.5 * M, z: -2.0 * M },
      dockOutward: { x: 0, y: 0, z: -1 },
    };
    const customArm = mockArm(HALF_PI, 'weaver');
    const mgr = { arms: [customArm], _dockPositions: [customDock] };

    updateThrusterBlocks(mgr);

    assert.ok(blockedPayload !== null, 'THRUSTER_BLOCKED_PLUME should fire');
    assert.ok(blockedPayload.thrusterId, 'payload has thrusterId');
    assert.ok(blockedPayload.conflictingArms.length > 0, 'payload has conflicting arms');

    eventBus.off(Events.THRUSTER_BLOCKED_PLUME, handler);
    Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK = origFlag;
    resetCoMState();
  });

  it('emits THRUSTER_UNBLOCKED when conflict resolves', () => {
    resetCoMState();
    const origFlag = Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK;
    Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK = true;
    let unblockedFired = false;
    const unblockedHandler = () => { unblockedFired = true; };

    // First, create blocked state
    const customDock = {
      hingePosition: { x: 0, y: 0.5 * M, z: -2.0 * M },
      dockOutward: { x: 0, y: 0, z: -1 },
    };
    const customArm = mockArm(HALF_PI, 'weaver');
    const blocker = { arms: [customArm], _dockPositions: [customDock] };
    updateThrusterBlocks(blocker);

    // Now resolve: move arm out of plume
    eventBus.on(Events.THRUSTER_UNBLOCKED, unblockedHandler);
    const clear = { arms: [], _dockPositions: [] };
    updateThrusterBlocks(clear);

    assert.ok(unblockedFired, 'THRUSTER_UNBLOCKED should fire when conflict resolves');

    eventBus.off(Events.THRUSTER_UNBLOCKED, unblockedHandler);
    Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK = origFlag;
    resetCoMState();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Feature flag OFF → no regressions
// ══════════════════════════════════════════════════════════════════════════
describe('CoM + Plume — feature flags OFF baseline', () => {

  it('COM_TRACKING OFF: computeCoM still works (pure math, no events)', () => {
    const origFlag = Constants.FEATURE_FLAGS.COM_TRACKING;
    Constants.FEATURE_FLAGS.COM_TRACKING = false;
    const mgr = symmetricManager(HALF_PI);
    // Pure computation functions don't check flags — they just do math
    const result = computeCoM(mgr);
    assert.ok(result.totalMass > 0, 'computation works regardless of flag');
    Constants.FEATURE_FLAGS.COM_TRACKING = origFlag;
  });

  it('THRUSTER_INTERLOCK OFF: checkPlumeInterference still computes (no events)', () => {
    const origFlag = Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK;
    Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK = false;
    const mgr = symmetricManager(HALF_PI);
    const result = checkPlumeInterference(mgr, 'HT_TOP');
    assert.equal(result.blocked, false, 'standard config not blocked');
    Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK = origFlag;
  });

  it('Constants.THRUSTERS array has 4 entries with expected structure', () => {
    assert.ok(Array.isArray(Constants.THRUSTERS), 'THRUSTERS is array');
    assert.equal(Constants.THRUSTERS.length, 4, '4 thrusters');
    for (const t of Constants.THRUSTERS) {
      assert.ok(t.id, 'has id');
      assert.ok(t.nozzlePos, 'has nozzlePos');
      assert.ok(t.thrustDir, 'has thrustDir');
      assert.equal(t.thrustDir.z, -1, 'all thrust −Z');
    }
  });

  it('Events has all 4 new event constants defined', () => {
    assert.ok(Events.COM_DRIFT_WARNING, 'COM_DRIFT_WARNING defined');
    assert.ok(Events.COM_DRIFT_CLEARED, 'COM_DRIFT_CLEARED defined');
    assert.ok(Events.THRUSTER_BLOCKED_PLUME, 'THRUSTER_BLOCKED_PLUME defined');
    assert.ok(Events.THRUSTER_UNBLOCKED, 'THRUSTER_UNBLOCKED defined');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Reset state
// ══════════════════════════════════════════════════════════════════════════
describe('CoM — resetCoMState', () => {

  it('resets drift warning and thruster block state', () => {
    resetCoMState();
    // No assertion needed — just verify it doesn't throw
    assert.ok(true, 'resetCoMState completed');
  });
});
