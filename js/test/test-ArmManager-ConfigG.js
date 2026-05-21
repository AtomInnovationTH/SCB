/**
 * test-ArmManager-ConfigG.js — ST-9.2 Config G geometry tests
 * Tests: collar hinge positions, azimuth-based docking, strut tip math,
 *        antipodal pair lookup, tier management, mass budget.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { persistenceManager } from '../systems/PersistenceManager.js';
import { generateDockPositions, ArmManager } from '../entities/ArmManager.js';

const M = 0.00001; // 1 meter in scene units
const V5 = Constants.OCTOPUS_V5;
const EPS = 1e-6;

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create a minimal ArmManager with stubs (no real scene or player). */
function makeManager(tierOverride) {
  const scene = { add() {}, remove() {} };
  const player = {
    safeMode: false,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    resources: {},
  };
  // If a tier override is needed, we temporarily set persistenceManager
  // to return that value. Since Node has no localStorage, _resolveActiveTierKey
  // will always fall back to 'Y0_QUAD' — which is what we want for default tests.
  const mgr = new ArmManager(scene, player);
  eventBus.clear();
  return mgr;
}

// ══════════════════════════════════════════════════════════════════════════
// Suite: generateDockPositions — Y0 Quad
// ══════════════════════════════════════════════════════════════════════════
describe('Config G generateDockPositions — Y0 Quad', () => {
  const positions = generateDockPositions(4);

  it('returns 4 positions', () => {
    assert.equal(positions.length, 4);
  });

  it('azimuths are [60°, 120°, 240°, 300°]', () => {
    const expected = [60, 120, 240, 300];
    for (let i = 0; i < 4; i++) {
      assert.equal(positions[i].azimuthDeg, expected[i],
        `arm ${i} azimuth should be ${expected[i]}°`);
    }
  });

  it('all ring arms (isEndFace = false)', () => {
    for (const p of positions) {
      assert.equal(p.isEndFace, false);
    }
  });

  it('collar hinge Y = COLLAR_Y in scene units', () => {
    const expectedY = V5.COLLAR_Y * M;
    for (const p of positions) {
      assert.closeTo(p.hingePosition.y, expectedY, EPS,
        `hinge Y should be ${expectedY}`);
    }
  });

  it('offset Y = 0 (XZ-only for deploy direction compat)', () => {
    for (const p of positions) {
      assert.closeTo(p.offset.y, 0, EPS, 'offset.y should be 0');
    }
  });

  it('offset XZ magnitude = COLLAR_RADIUS in scene units', () => {
    const expectedR = V5.COLLAR_RADIUS * M;
    for (const p of positions) {
      const r = Math.sqrt(p.offset.x ** 2 + p.offset.z ** 2);
      assert.closeTo(r, expectedR, EPS,
        `XZ radius should be ${expectedR}, got ${r}`);
    }
  });

  it('dockOutward is unit vector in XZ plane', () => {
    for (const p of positions) {
      assert.closeTo(p.dockOutward.length(), 1, EPS, 'unit length');
      assert.closeTo(p.dockOutward.y, 0, EPS, 'y should be 0');
    }
  });

  it('swingAxis is perpendicular to dockOutward', () => {
    for (const p of positions) {
      const dot = p.dockOutward.dot(p.swingAxis);
      assert.closeTo(dot, 0, EPS, 'swing ⊥ outward');
    }
  });

  it('types alternate weaver/spinner', () => {
    assert.equal(positions[0].type, 'weaver');
    assert.equal(positions[1].type, 'spinner');
    assert.equal(positions[2].type, 'weaver');
    assert.equal(positions[3].type, 'spinner');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: generateDockPositions — Y1 Hex
// ══════════════════════════════════════════════════════════════════════════
describe('Config G generateDockPositions — Y1 Hex', () => {
  const positions = generateDockPositions(6);

  it('returns 6 positions', () => {
    assert.equal(positions.length, 6);
  });

  it('azimuths are [30°, 90°, 150°, 210°, 270°, 330°]', () => {
    const expected = [30, 90, 150, 210, 270, 330];
    for (let i = 0; i < 6; i++) {
      assert.equal(positions[i].azimuthDeg, expected[i]);
    }
  });

  it('all ring arms (isEndFace = false)', () => {
    for (const p of positions) assert.equal(p.isEndFace, false);
  });

  it('collar hinge Y matches COLLAR_Y', () => {
    for (const p of positions) {
      assert.closeTo(p.hingePosition.y, V5.COLLAR_Y * M, EPS);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: generateDockPositions — Y3 Octo
// ══════════════════════════════════════════════════════════════════════════
describe('Config G generateDockPositions — Y3 Octo', () => {
  const positions = generateDockPositions(8);

  it('returns 8 positions (6 ring + 2 end-face)', () => {
    assert.equal(positions.length, 8);
  });

  it('first 6 are ring arms', () => {
    for (let i = 0; i < 6; i++) {
      assert.equal(positions[i].isEndFace, false, `arm ${i} should be ring`);
    }
  });

  it('last 2 are end-face arms', () => {
    assert.equal(positions[6].isEndFace, true, 'arm 6 end-face');
    assert.equal(positions[7].isEndFace, true, 'arm 7 end-face');
  });

  it('end-face arms at azimuths 0° (+Z) and 180° (−Z)', () => {
    assert.equal(positions[6].azimuthDeg, 0, '+Z face arm');
    assert.equal(positions[7].azimuthDeg, 180, '−Z face arm');
  });

  it('end-face arm dockOutward points ±Z', () => {
    assert.closeTo(positions[6].dockOutward.z, 1, EPS, '+Z outward');
    assert.closeTo(positions[7].dockOutward.z, -1, EPS, '−Z outward');
  });

  it('ring arm azimuths match Y3 ladder', () => {
    const expected = Constants.ARM_LADDER.Y3_OCTO.azimuths;
    for (let i = 0; i < 6; i++) {
      assert.equal(positions[i].azimuthDeg, expected[i]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Strut tip math at α = 0, π/2, π
// ══════════════════════════════════════════════════════════════════════════
describe('Config G Strut Tip Math', () => {
  // Direct formula verification using arm 0 of Y0 (60°)
  const positions = generateDockPositions('Y0_QUAD');
  const dp = positions[0]; // 60°
  const L = V5.STRUT_LENGTH; // 1.60 m

  // hinge in meters (convert from scene units)
  const hx = dp.hingePosition.x / M;
  const hy = dp.hingePosition.y / M;
  const hz = dp.hingePosition.z / M;
  const ox = dp.dockOutward.x; // cos(60°) = 0.5
  const oz = dp.dockOutward.z; // sin(60°) ≈ 0.866

  it('α=0 (STOWED): tip directly below hinge by STRUT_LENGTH', () => {
    const alpha = 0;
    const tipX = hx + L * Math.sin(alpha) * ox;
    const tipY = hy + L * (Math.sin(alpha) * 0 - Math.cos(alpha));
    const tipZ = hz + L * Math.sin(alpha) * oz;

    assert.closeTo(tipX, hx, 0.001, 'stowed X ≈ hinge X');
    assert.closeTo(tipY, hy - L, 0.001, 'stowed Y = hinge Y − L');
    assert.closeTo(tipZ, hz, 0.001, 'stowed Z ≈ hinge Z');
  });

  it('α=π/2 (EQUATORIAL): tip is STRUT_LENGTH radially outward', () => {
    const alpha = Math.PI / 2;
    const tipX = hx + L * Math.sin(alpha) * ox;
    const tipY = hy + L * (Math.sin(alpha) * 0 - Math.cos(alpha));
    const tipZ = hz + L * Math.sin(alpha) * oz;

    assert.closeTo(tipX, hx + L * ox, 0.001, 'equatorial X += L·cos(θ)');
    assert.closeTo(tipY, hy, 0.001, 'equatorial Y ≈ hinge Y');
    assert.closeTo(tipZ, hz + L * oz, 0.001, 'equatorial Z += L·sin(θ)');
  });

  it('α=π (ZENITH): tip directly above hinge by STRUT_LENGTH', () => {
    const alpha = Math.PI;
    const tipX = hx + L * Math.sin(alpha) * ox;
    const tipY = hy + L * (Math.sin(alpha) * 0 - Math.cos(alpha));
    const tipZ = hz + L * Math.sin(alpha) * oz;

    assert.closeTo(tipX, hx, 0.001, 'zenith X ≈ hinge X');
    assert.closeTo(tipY, hy + L, 0.001, 'zenith Y = hinge Y + L');
    assert.closeTo(tipZ, hz, 0.001, 'zenith Z ≈ hinge Z');
  });

  it('tip distance from hinge always equals STRUT_LENGTH', () => {
    for (const alpha of [0, Math.PI / 6, Math.PI / 4, Math.PI / 3, Math.PI / 2, Math.PI]) {
      const dx = L * Math.sin(alpha) * ox;
      const dy = L * (Math.sin(alpha) * 0 - Math.cos(alpha));
      const dz = L * Math.sin(alpha) * oz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      assert.closeTo(dist, L, 0.001,
        `at α=${(alpha * 180 / Math.PI).toFixed(0)}°, dist=${dist.toFixed(4)} should be ${L}`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: ArmManager.getStrutTipPosition (instance method)
// ══════════════════════════════════════════════════════════════════════════
describe('Config G ArmManager.getStrutTipPosition()', () => {
  const mgr = makeManager();
  const L = V5.STRUT_LENGTH;

  it('returns non-null for valid armIndex', () => {
    const tip = mgr.getStrutTipPosition(0, Math.PI / 2);
    assert.ok(tip !== null, 'tip should not be null');
  });

  it('returns null for invalid armIndex', () => {
    assert.equal(mgr.getStrutTipPosition(-1, 0), null);
    assert.equal(mgr.getStrutTipPosition(99, 0), null);
  });

  it('α=0: tip Y ≈ hingeY − STRUT_LENGTH', () => {
    const tip = mgr.getStrutTipPosition(0, 0);
    assert.closeTo(tip.y, V5.COLLAR_Y - L, 0.001);
  });

  it('α=π/2: tip Y ≈ hingeY (equatorial — same height as hinge)', () => {
    const tip = mgr.getStrutTipPosition(0, Math.PI / 2);
    assert.closeTo(tip.y, V5.COLLAR_Y, 0.001);
  });

  it('α=π: tip Y ≈ hingeY + STRUT_LENGTH', () => {
    const tip = mgr.getStrutTipPosition(0, Math.PI);
    assert.closeTo(tip.y, V5.COLLAR_Y + L, 0.001);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: ArmManager.getDualFirePair (antipodal lookup)
// ══════════════════════════════════════════════════════════════════════════
describe('Config G ArmManager.getDualFirePair()', () => {
  const mgr = makeManager();

  it('arm 0 (60°) pairs with arm 2 (240°)', () => {
    assert.equal(mgr.getDualFirePair(0), 2);
  });

  it('arm 1 (120°) pairs with arm 3 (300°)', () => {
    assert.equal(mgr.getDualFirePair(1), 3);
  });

  it('arm 2 (240°) pairs with arm 0 (60°) — symmetric', () => {
    assert.equal(mgr.getDualFirePair(2), 0);
  });

  it('arm 3 (300°) pairs with arm 1 (120°) — symmetric', () => {
    assert.equal(mgr.getDualFirePair(3), 1);
  });

  it('invalid indices return null', () => {
    assert.equal(mgr.getDualFirePair(-1), null);
    assert.equal(mgr.getDualFirePair(99), null);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: ArmManager.getOppositeArm (backward-compat wrapper)
// ══════════════════════════════════════════════════════════════════════════
describe('Config G ArmManager.getOppositeArm()', () => {
  const mgr = makeManager();

  it('arm 0 → 2 (same as getDualFirePair)', () => {
    assert.equal(mgr.getOppositeArm(0), 2);
  });

  it('arm 1 → 3', () => {
    assert.equal(mgr.getOppositeArm(1), 3);
  });

  it('invalid index returns -1', () => {
    assert.equal(mgr.getOppositeArm(-1), -1);
    assert.equal(mgr.getOppositeArm(99), -1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Tier management API
// ══════════════════════════════════════════════════════════════════════════
describe('Config G Tier Management', () => {

  it('generateDockPositions("Y0_QUAD") returns 4 positions', () => {
    assert.equal(generateDockPositions('Y0_QUAD').length, 4);
  });

  it('generateDockPositions("Y1_HEX") returns 6 positions', () => {
    assert.equal(generateDockPositions('Y1_HEX').length, 6);
  });

  it('generateDockPositions("Y3_OCTO") returns 8 positions', () => {
    assert.equal(generateDockPositions('Y3_OCTO').length, 8);
  });

  it('generateDockPositions(unknown) falls back to Y0_QUAD (4)', () => {
    assert.equal(generateDockPositions('UNKNOWN_TIER').length, 4);
  });

  it('generateDockPositions() with no arg falls back to Y0_QUAD (4)', () => {
    assert.equal(generateDockPositions().length, 4);
  });

  it('ArmManager.getCurrentTier() returns "Y0_QUAD" by default', () => {
    const mgr = makeManager();
    assert.equal(mgr.getCurrentTier(), 'Y0_QUAD');
  });

  it('ArmManager.setCurrentTier sets internal tier key', () => {
    const mgr = makeManager();
    mgr.setCurrentTier('Y1_HEX');
    assert.equal(mgr.getCurrentTier(), 'Y1_HEX');
  });

  it('ArmManager.setCurrentTier ignores invalid tier name', () => {
    const mgr = makeManager();
    mgr.setCurrentTier('INVALID');
    assert.equal(mgr.getCurrentTier(), 'Y0_QUAD');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: PersistenceManager armTier API
// ══════════════════════════════════════════════════════════════════════════
describe('Config G PersistenceManager armTier API', () => {

  it('getArmTier returns string', () => {
    const tier = persistenceManager.getArmTier();
    assert.isType(tier, 'string');
  });

  it('getArmTier defaults to "Y0_QUAD" (no localStorage in Node)', () => {
    assert.equal(persistenceManager.getArmTier(), 'Y0_QUAD');
  });

  it('setArmTier is a function', () => {
    assert.isType(persistenceManager.setArmTier, 'function');
  });

  it('setArmTier returns false when no storage available', () => {
    // In Node, localStorage is unavailable → setArmTier returns false
    const result = persistenceManager.setArmTier('Y1_HEX');
    assert.equal(result, false, 'setArmTier should return false (no storage)');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: Config G Mass Budget (Y0)
// ══════════════════════════════════════════════════════════════════════════
describe('Config G Mass Budget (Y0)', () => {

  it('Y0 dry mass = 196.4 ± 0.1', () => {
    assert.closeTo(Constants.ARM_LADDER.Y0_QUAD.dryMass, 196.4, 0.1);
  });

  it('Y0 wet mass = 242.4 ± 0.1', () => {
    assert.closeTo(Constants.ARM_LADDER.Y0_QUAD.wetMass, 242.4, 0.1);
  });

  it('OCTOPUS_V5.TOTAL_DRY_MASS matches Y0 ladder', () => {
    assert.equal(V5.TOTAL_DRY_MASS, Constants.ARM_LADDER.Y0_QUAD.dryMass);
  });

  it('OCTOPUS_V5.TOTAL_WET_MASS matches Y0 ladder', () => {
    assert.equal(V5.TOTAL_WET_MASS, Constants.ARM_LADDER.Y0_QUAD.wetMass);
  });

  it('Default fleet: 2 weavers + 2 spinners = 4 arms', () => {
    const tier = Constants.ARM_LADDER.Y0_QUAD;
    assert.equal(tier.weaverCount, 2);
    assert.equal(tier.spinnerCount, 2);
    assert.equal(tier.armCount, 4);
  });

  it('Config G mass decomposition: bus + struts + daughters = TOTAL_DRY', () => {
    const busDry = V5.CORE_DRY_MASS;     // 161.0
    const struts = V5.STRUT_MASS * 4;     // 4.5 × 4 = 18.0
    const daughters = Constants.V5_WEAVER_MASS * 2 + Constants.V5_SPINNER_MASS * 2;
    const total = busDry + struts + daughters;
    assert.closeTo(total, V5.TOTAL_DRY_MASS, 0.1,
      `${busDry} + ${struts} + ${daughters} = ${total} should ≈ ${V5.TOTAL_DRY_MASS}`);
  });

  it('getMassBudget().coreDry = bus + struts = 179.0 (not old V3 170)', () => {
    const mgr = makeManager();
    const budget = mgr.getMassBudget();
    const expected = V5.CORE_DRY_MASS + V5.STRUT_MASS * 4; // 161.0 + 18.0 = 179.0
    assert.closeTo(budget.coreDry, expected, 0.1,
      `coreDry should be ${expected}, got ${budget.coreDry}`);
  });

  it('getMassBudget().dryMass = coreDry + dockedArmMass ≈ 196.4', () => {
    const mgr = makeManager();
    const budget = mgr.getMassBudget();
    // All 4 arms docked → dockedArmMass = 2×6.6 + 2×2.1 = 17.4
    assert.closeTo(budget.dryMass, 196, 1, // rounded — exact is 196.4
      `dryMass should be ~196, got ${budget.dryMass}`);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Suite: ArmManager arm Config G properties
// ══════════════════════════════════════════════════════════════════════════
describe('Config G ArmManager arm properties', () => {
  const mgr = makeManager();

  it('each arm has _hingePosition (Vector3)', () => {
    for (const arm of mgr.arms) {
      assert.ok(arm._hingePosition instanceof THREE.Vector3,
        `${arm.id} should have _hingePosition`);
    }
  });

  it('each arm has _dockOutward (Vector3)', () => {
    for (const arm of mgr.arms) {
      assert.ok(arm._dockOutward instanceof THREE.Vector3,
        `${arm.id} should have _dockOutward`);
    }
  });

  it('each arm has _swingAxis (Vector3)', () => {
    for (const arm of mgr.arms) {
      assert.ok(arm._swingAxis instanceof THREE.Vector3,
        `${arm.id} should have _swingAxis`);
    }
  });

  it('each arm has _azimuthDeg (number)', () => {
    for (const arm of mgr.arms) {
      assert.isType(arm._azimuthDeg, 'number',
        `${arm.id} should have numeric _azimuthDeg`);
    }
  });

  it('each arm has _isEndFace (boolean)', () => {
    for (const arm of mgr.arms) {
      assert.isType(arm._isEndFace, 'boolean',
        `${arm.id} should have boolean _isEndFace`);
    }
  });

  it('arm azimuths match Y0 Quad [60, 120, 240, 300]', () => {
    const expected = [60, 120, 240, 300];
    for (let i = 0; i < mgr.arms.length; i++) {
      assert.equal(mgr.arms[i]._azimuthDeg, expected[i],
        `arm ${i} azimuth should be ${expected[i]}°`);
    }
  });
});
