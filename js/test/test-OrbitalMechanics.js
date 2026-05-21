/**
 * OrbitalMechanics unit tests — pure math, no Three.js dependency.
 */
import { describe, it, assert } from './TestRunner.js';
import { 
    solveKepler, 
    meanToTrueAnomaly,
    trueToMeanAnomaly,
    keplerianToCartesian,
    cartesianToKeplerian,
    propagateOrbit,
    orbitalVelocity,
    hohmannDeltaV,
    kmToScene,
    sceneToKm,
    computeSalvageDeltaV,
    isInShadow,
} from '../entities/OrbitalMechanics.js';
import { Constants } from '../core/Constants.js';

// ============================================================================
// Kepler Solver
// ============================================================================

describe('OrbitalMechanics - Kepler Solver', () => {
    
    it('circular orbit (e=0): E equals M', () => {
        assert.closeTo(solveKepler(1.0, 0), 1.0, 1e-10);
        assert.closeTo(solveKepler(Math.PI, 0), Math.PI, 1e-10);
    });
    
    it('low eccentricity (e=0.1): Kepler equation holds', () => {
        const E = solveKepler(1.0, 0.1);
        // Verify: M = E - e*sin(E)
        const M_check = E - 0.1 * Math.sin(E);
        assert.closeTo(M_check, 1.0, 1e-8, 'Kepler equation should hold');
    });
    
    it('M=0 gives E=0', () => {
        assert.closeTo(solveKepler(0, 0.5), 0, 1e-10);
    });
    
    it('high eccentricity (e=0.9): still converges', () => {
        const E = solveKepler(1.0, 0.9);
        const M_check = E - 0.9 * Math.sin(E);
        assert.closeTo(M_check, 1.0, 1e-6, 'Should converge even at high e');
    });
    
    it('M=π gives E=π for any eccentricity', () => {
        // At M=π, E=π is the exact solution (sin(π)=0)
        assert.closeTo(solveKepler(Math.PI, 0.3), Math.PI, 1e-10);
        assert.closeTo(solveKepler(Math.PI, 0.9), Math.PI, 1e-10);
    });
});

// ============================================================================
// Mean/True Anomaly Conversion
// ============================================================================

describe('OrbitalMechanics - Mean/True Anomaly Conversion', () => {
    
    it('circular orbit: mean anomaly equals true anomaly', () => {
        const nu = meanToTrueAnomaly(1.0, 0);
        assert.closeTo(nu, 1.0, 1e-8);
    });
    
    it('round-trip: mean → true → mean', () => {
        const M = 2.0;
        const e = 0.3;
        const nu = meanToTrueAnomaly(M, e);
        const M_back = trueToMeanAnomaly(nu, e);
        assert.closeTo(M_back, M, 1e-6, `Round trip failed: ${M} → ${nu} → ${M_back}`);
    });
    
    it('round-trip at small M and moderate e', () => {
        const M = 0.5;
        const e = 0.2;
        const nu = meanToTrueAnomaly(M, e);
        const M_back = trueToMeanAnomaly(nu, e);
        assert.closeTo(M_back, M, 1e-6);
    });
    
    it('M=0 → ν=0 for any eccentricity', () => {
        assert.closeTo(meanToTrueAnomaly(0, 0.5), 0, 1e-10);
    });
});

// ============================================================================
// Vis-Viva (orbitalVelocity)
// ============================================================================

describe('OrbitalMechanics - Vis-Viva (orbitalVelocity)', () => {
    
    it('circular orbit: v = sqrt(mu/r)', () => {
        // ISS-like orbit: r = a = 6771 km (400 km altitude)
        const r = Constants.EARTH_RADIUS_KM + 400;
        const a = r; // circular
        const v = orbitalVelocity(a, r);
        const expected = Math.sqrt(Constants.MU_EARTH / r);
        assert.closeTo(v, expected, 1e-6, `Circular velocity at 400km should be ~${expected.toFixed(3)} km/s`);
    });
    
    it('ISS circular velocity ≈ 7.67 km/s', () => {
        const r = 6771; // km
        const v = orbitalVelocity(r, r);
        assert.closeTo(v, 7.67, 0.02, `ISS velocity should be ~7.67 km/s, got ${v.toFixed(3)}`);
    });
    
    it('elliptical orbit: perigee velocity > circular', () => {
        const rPeri = 6771;       // perigee at 400 km
        const rApo = 42164;       // apogee at GEO
        const a = (rPeri + rApo) / 2;
        const vPeri = orbitalVelocity(a, rPeri);
        const vCirc = orbitalVelocity(rPeri, rPeri);
        assert.ok(vPeri > vCirc, 'Perigee velocity of ellipse should exceed circular velocity');
    });
});

// ============================================================================
// Hohmann Transfer
// ============================================================================

describe('OrbitalMechanics - Hohmann Transfer', () => {
    
    it('LEO to GEO: ΔV₁ ≈ 2.4 km/s', () => {
        const r1 = 6771;   // LEO (400 km alt)
        const r2 = 42164;  // GEO
        const result = hohmannDeltaV(r1, r2);
        assert.closeTo(result.dv1, 2.4, 0.1, `ΔV₁ should be ~2.4, got ${result.dv1.toFixed(3)}`);
    });
    
    it('LEO to GEO: ΔV₂ ≈ 1.47 km/s', () => {
        const r1 = 6771;
        const r2 = 42164;
        const result = hohmannDeltaV(r1, r2);
        assert.closeTo(result.dv2, 1.47, 0.05, `ΔV₂ should be ~1.47, got ${result.dv2.toFixed(3)}`);
    });
    
    it('total ΔV = ΔV₁ + ΔV₂', () => {
        const r1 = 6771;
        const r2 = 42164;
        const result = hohmannDeltaV(r1, r2);
        assert.closeTo(result.total, result.dv1 + result.dv2, 1e-10);
    });
    
    it('same orbit: zero ΔV', () => {
        const r = 7000;
        const result = hohmannDeltaV(r, r);
        assert.closeTo(result.total, 0, 1e-10, 'Same orbit should need zero ΔV');
    });
    
    it('transfer time is positive', () => {
        const result = hohmannDeltaV(6771, 42164);
        assert.ok(result.transferTime > 0, 'Transfer time must be positive');
    });
});

// ============================================================================
// Keplerian ↔ Cartesian Round-Trip  
// ============================================================================

describe('OrbitalMechanics - Keplerian ↔ Cartesian Round-Trip', () => {
    
    it('near-circular orbit: all elements survive round-trip', () => {
        // cartesianToKeplerian and keplerianToCartesian share the same
        // Y-up Three.js scene frame (see OrbitalMechanics.js §123 docstring).
        // A full round-trip of (a, e, i, Ω, ω, ν) must be self-consistent —
        // this is the guard that would have caught the Y-up/Z-up frame bug
        // that caused the autopilot to diverge (see AUTOPILOT_ANALYSIS.md
        // Implementation Retrospective).
        const orbit = {
            semiMajorAxis: 7000,        // km
            eccentricity: 0.001,        // near-circular (avoid e=0 edge case)
            inclination: 0.5,           // ~28.6°
            raan: 1.0,
            argPerigee: 0.5,
            trueAnomaly: 1.0,
        };
        const cart = keplerianToCartesian(orbit);
        const back = cartesianToKeplerian(cart.position, cart.velocity);

        assert.closeTo(back.semiMajorAxis, orbit.semiMajorAxis, 0.1,
            `SMA: expected ${orbit.semiMajorAxis}, got ${back.semiMajorAxis}`);
        assert.closeTo(back.eccentricity, orbit.eccentricity, 1e-4,
            `Ecc: expected ${orbit.eccentricity}, got ${back.eccentricity}`);
        assert.closeTo(back.inclination, orbit.inclination, 1e-6,
            `Inc: expected ${orbit.inclination}, got ${back.inclination}`);

        // Position round-trip — the key invariant the autopilot relies on.
        const cart2 = keplerianToCartesian(back);
        const dx = cart2.position.x - cart.position.x;
        const dy = cart2.position.y - cart.position.y;
        const dz = cart2.position.z - cart.position.z;
        const drift = Math.sqrt(dx * dx + dy * dy + dz * dz);
        assert.ok(drift < 1e-3,
            `position round-trip drift must be < 1e-3 km (was ~1500 km pre-fix); got ${drift.toExponential(3)}`);
    });
    
    it('elliptical orbit (e=0.3) survives round-trip', () => {
        const orbit = {
            semiMajorAxis: 10000,
            eccentricity: 0.3,
            inclination: 0.8,
            raan: 2.0,
            argPerigee: 1.5,
            trueAnomaly: 0.7,
        };
        const cart = keplerianToCartesian(orbit);
        const back = cartesianToKeplerian(cart.position, cart.velocity);
        
        assert.closeTo(back.semiMajorAxis, orbit.semiMajorAxis, 1.0,
            `SMA mismatch: ${back.semiMajorAxis} vs ${orbit.semiMajorAxis}`);
        assert.closeTo(back.eccentricity, orbit.eccentricity, 1e-3,
            `Ecc mismatch: ${back.eccentricity} vs ${orbit.eccentricity}`);
    });
});

// ============================================================================
// Orbit Propagation
// ============================================================================

describe('OrbitalMechanics - Orbit Propagation', () => {
    
    it('one full period returns to same true anomaly', () => {
        const a = 7000; // km
        const e = 0.01;
        const period = 2 * Math.PI * Math.sqrt(a * a * a / Constants.MU_EARTH);
        
        const orbit = {
            semiMajorAxis: a,
            eccentricity: e,
            inclination: 0.5,
            raan: 0,
            argPerigee: 0,
            trueAnomaly: 1.0,
        };
        const initialTrueAnomaly = orbit.trueAnomaly;
        
        propagateOrbit(orbit, period);
        
        // After one full period, true anomaly should return to start
        // Wrap both to [0, 2π) for comparison
        const wrapAngle = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        assert.closeTo(wrapAngle(orbit.trueAnomaly), wrapAngle(initialTrueAnomaly), 1e-4,
            `After one period: expected ν≈${initialTrueAnomaly.toFixed(4)}, got ${orbit.trueAnomaly.toFixed(4)}`);
    });
    
    it('half period: true anomaly shifts by ~π', () => {
        const a = 7000;
        const e = 0.001; // near-circular for clean π shift
        const period = 2 * Math.PI * Math.sqrt(a * a * a / Constants.MU_EARTH);
        
        const orbit = {
            semiMajorAxis: a,
            eccentricity: e,
            inclination: 0.5,
            raan: 0,
            argPerigee: 0,
            trueAnomaly: 0,
        };
        
        propagateOrbit(orbit, period / 2);
        
        const wrapAngle = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        assert.closeTo(wrapAngle(orbit.trueAnomaly), Math.PI, 0.01,
            `After half period: expected ν≈π, got ${orbit.trueAnomaly.toFixed(4)}`);
    });
    
    it('dt=0 does not change true anomaly', () => {
        const orbit = {
            semiMajorAxis: 7000,
            eccentricity: 0.1,
            inclination: 0.5,
            raan: 0,
            argPerigee: 0,
            trueAnomaly: 1.5,
        };
        const before = orbit.trueAnomaly;
        propagateOrbit(orbit, 0);
        assert.closeTo(orbit.trueAnomaly, before, 1e-8);
    });
});

// ============================================================================
// Scene-Unit Helpers
// ============================================================================

describe('OrbitalMechanics - Scene-Unit Helpers', () => {
    
    it('kmToScene: 6371 km → EARTH_RADIUS', () => {
        assert.closeTo(kmToScene(Constants.EARTH_RADIUS_KM), Constants.EARTH_RADIUS, 0.01);
    });
    
    it('sceneToKm: EARTH_RADIUS → 6371 km', () => {
        assert.closeTo(sceneToKm(Constants.EARTH_RADIUS), Constants.EARTH_RADIUS_KM, 1);
    });
    
    it('round-trip: km → scene → km', () => {
        const km = 450;
        assert.closeTo(sceneToKm(kmToScene(km)), km, 1e-6);
    });
});

// ============================================================================
// Salvage ΔV (Tsiolkovsky)
// ============================================================================

describe('OrbitalMechanics - Salvage ΔV', () => {
    
    it('zero propellant → zero ΔV', () => {
        assert.equal(computeSalvageDeltaV(0, 1000, 200), 0);
    });
    
    it('zero Isp → zero ΔV', () => {
        assert.equal(computeSalvageDeltaV(10, 0, 200), 0);
    });
    
    it('positive propellant and Isp → positive ΔV', () => {
        const dv = computeSalvageDeltaV(5, 800, 200);
        assert.ok(dv > 0, `ΔV should be positive, got ${dv}`);
    });
    
    it('Tsiolkovsky: ΔV = Ve × ln(m0/mf)', () => {
        const metalMass = 10;  // kg
        const isp = 1000;      // s
        const dryMass = 200;   // kg
        const dv = computeSalvageDeltaV(metalMass, isp, dryMass);
        
        const ve = isp * 9.80665;
        const expected = ve * Math.log((dryMass + metalMass) / dryMass);
        assert.closeTo(dv, expected, 1e-6);
    });
});

// ============================================================================
// Shadow / Eclipse Check  
// ============================================================================

describe('OrbitalMechanics - Shadow Check', () => {
    
    it('position on sunlit side is not in shadow', () => {
        const pos = { x: 100, y: 0, z: 0 };
        const sunDir = { x: 1, y: 0, z: 0 }; // sun is in +x direction
        assert.equal(isInShadow(pos, sunDir, 63.71), false);
    });
    
    it('position directly behind Earth is in shadow', () => {
        const pos = { x: -100, y: 0, z: 0 };
        const sunDir = { x: 1, y: 0, z: 0 };
        assert.equal(isInShadow(pos, sunDir, 63.71), true);
    });
    
    it('position behind Earth but offset far from line is not in shadow', () => {
        const pos = { x: -100, y: 200, z: 0 };
        const sunDir = { x: 1, y: 0, z: 0 };
        assert.equal(isInShadow(pos, sunDir, 63.71), false);
    });
});
