/**
 * LaunchWindow unit tests (CP-3) — pure transfer-window math, no Three.js / DOM.
 */
import { describe, it, assert } from './TestRunner.js';
import {
  wrapTwoPi,
  meanMotion,
  orbitalPeriod,
  synodicPeriod,
  trueLongitude,
  hohmannPhaseLead,
  computeTransferWindow,
  pickRepresentative,
  clusterToOrbitKm,
  detectWindowCrossing,
} from '../entities/LaunchWindow.js';
import { Constants } from '../core/Constants.js';

const TAU = Math.PI * 2;
const RAD2DEG = 180 / Math.PI;

/** Smallest absolute angular distance between two wrapped angles. */
function angularGap(a, b) {
  const d = wrapTwoPi(a - b);
  return Math.min(d, TAU - d);
}

// ============================================================================
// Period / mean motion
// ============================================================================

describe('LaunchWindow - meanMotion & period', () => {
  it('ISS-like 400 km orbit has a ~92.6 min period', () => {
    const a = Constants.EARTH_RADIUS_KM + 407; // 6778 km
    const T = orbitalPeriod(a);
    assert.closeTo(T, 5553, 30, `period was ${T}s`);
  });

  it('meanMotion = 2π / period', () => {
    const a = 6778;
    assert.closeTo(meanMotion(a), TAU / orbitalPeriod(a), 1e-12);
  });

  it('higher orbit is slower (smaller mean motion)', () => {
    assert.ok(meanMotion(7178) < meanMotion(6778), 'higher orbit should be slower');
  });

  it('non-positive axis returns 0 / Infinity defensively', () => {
    assert.equal(meanMotion(0), 0);
    assert.equal(orbitalPeriod(-5), Infinity);
  });
});

// ============================================================================
// Synodic period
// ============================================================================

describe('LaunchWindow - synodicPeriod', () => {
  it('equal orbits → Infinity (no relative drift)', () => {
    assert.equal(synodicPeriod(7000, 7000), Infinity);
  });

  it('close orbits → large but finite, longer than either orbital period', () => {
    const S = synodicPeriod(6778, 6878);
    assert.ok(Number.isFinite(S), 'synodic should be finite');
    assert.ok(S > orbitalPeriod(6778), 'synodic should exceed orbital period');
  });
});

// ============================================================================
// Hohmann phase lead (geometry only, μ-independent)
// ============================================================================

describe('LaunchWindow - hohmannPhaseLead', () => {
  it('Earth→Mars geometry gives the textbook ~44.3° lead', () => {
    const deg = hohmannPhaseLead(1.0, 1.524) * RAD2DEG;
    assert.closeTo(deg, 44.3, 0.6, `got ${deg}°`);
  });

  it('outward transfer → positive lead, inward → negative', () => {
    assert.ok(hohmannPhaseLead(6778, 7178) > 0, 'raising should be positive');
    assert.ok(hohmannPhaseLead(7178, 6778) < 0, 'lowering should be negative');
  });
});

// ============================================================================
// trueLongitude
// ============================================================================

describe('LaunchWindow - trueLongitude', () => {
  it('sums node + argP + trueAnomaly, wrapped to [0,2π)', () => {
    const v = trueLongitude({ raan: Math.PI, argPerigee: Math.PI, trueAnomaly: Math.PI });
    assert.closeTo(v, Math.PI, 1e-9); // 3π wraps to π
  });

  it('tolerates missing fields', () => {
    assert.closeTo(trueLongitude({ trueAnomaly: 1.0 }), 1.0, 1e-9);
  });
});

// ============================================================================
// computeTransferWindow
// ============================================================================

describe('LaunchWindow - computeTransferWindow', () => {
  const chaser = { semiMajorAxis: 6778, inclination: 0, raan: 0, argPerigee: 0, trueAnomaly: 0 };
  const target = { semiMajorAxis: 7178, inclination: 0, raan: 0, argPerigee: 0, trueAnomaly: 1.0 };

  it('departIn lands the relative phase exactly on the required lead', () => {
    const w = computeTransferWindow(chaser, target);
    const omegaRel = meanMotion(target.semiMajorAxis) - meanMotion(chaser.semiMajorAxis);
    const phaseAtDeparture = w.currentLead + omegaRel * w.departIn;
    assert.closeTo(angularGap(phaseAtDeparture, w.phaseLeadReq), 0, 1e-6);
  });

  it('departIn is within [0, synodic)', () => {
    const w = computeTransferWindow(chaser, target);
    assert.ok(w.departIn >= 0, 'departIn non-negative');
    assert.ok(w.departIn < w.synodic, 'departIn below one synodic period');
  });

  it('reports a positive transfer time and ΔV, and raising flag', () => {
    const w = computeTransferWindow(chaser, target);
    assert.ok(w.transferTime > 0, 'transferTime positive');
    assert.ok(w.dvTotal > 0, 'dvTotal positive (m/s)');
    assert.equal(w.raising, true);
    assert.equal(w.arriveIn, w.departIn + w.transferTime);
  });

  it('co-altitude orbits → window open now, infinite synodic', () => {
    const a = { semiMajorAxis: 7000, inclination: 0, raan: 0, argPerigee: 0, trueAnomaly: 0 };
    const b = { semiMajorAxis: 7000, inclination: 0, raan: 0, argPerigee: 0, trueAnomaly: 2.0 };
    const w = computeTransferWindow(a, b);
    assert.equal(w.departIn, 0);
    assert.equal(w.synodic, Infinity);
  });

  it('ΔV total exceeds the pure Hohmann burn when planes differ', () => {
    const inclined = { ...target, inclination: 0.2 };
    const coplanar = computeTransferWindow(chaser, target);
    const withPlane = computeTransferWindow(chaser, inclined);
    assert.ok(withPlane.dvTotal > coplanar.dvTotal, 'plane change adds ΔV');
  });
});

// ============================================================================
// Cluster → orbit helpers
// ============================================================================

describe('LaunchWindow - cluster orbit derivation', () => {
  function fakeDebris(smaScene, trueAnomaly, alive = true) {
    return {
      alive,
      orbit: {
        semiMajorAxis: smaScene, // scene units
        eccentricity: 0.001,
        inclination: 0.9,
        raan: 0.1,
        argPerigee: 0.2,
        trueAnomaly,
      },
    };
  }

  it('pickRepresentative chooses the member nearest mean altitude', () => {
    // avgAltKm 500 → mean sma 6871 km → scene 68.71
    const cluster = {
      avgAltKm: 500,
      center: null,
      targets: [
        fakeDebris(60.0, 0.0),   // 6000 km — far
        fakeDebris(68.7, 1.5),   // 6870 km — nearest
        fakeDebris(80.0, 3.0),   // 8000 km — far
      ],
    };
    const rep = pickRepresentative(cluster);
    assert.closeTo(rep.orbit.trueAnomaly, 1.5, 1e-9);
  });

  it('clusterToOrbitKm converts representative sma scene→km and preserves angles', () => {
    const cluster = { avgAltKm: 500, targets: [fakeDebris(68.71, 0.7)] };
    const o = clusterToOrbitKm(cluster);
    assert.closeTo(o.semiMajorAxis, 6871, 1, `sma was ${o.semiMajorAxis}`);
    assert.closeTo(o.trueAnomaly, 0.7, 1e-9);
    assert.closeTo(o.raan, 0.1, 1e-9);
  });

  it('clusterToOrbitKm synthesizes a circular orbit when no live members', () => {
    const cluster = { avgAltKm: 800, incCenter: 98, targets: [] };
    const o = clusterToOrbitKm(cluster);
    assert.closeTo(o.semiMajorAxis, Constants.EARTH_RADIUS_KM + 800, 1e-6);
    assert.closeTo(o.inclination, 98 * Math.PI / 180, 1e-9);
    assert.equal(o.trueAnomaly, 0);
  });

  it('ignores dead members', () => {
    const cluster = { avgAltKm: 500, targets: [fakeDebris(68.7, 1.0, false)] };
    const o = clusterToOrbitKm(cluster);
    // falls back to synthetic (no alive members)
    assert.equal(o.trueAnomaly, 0);
  });
});

// ============================================================================
// detectWindowCrossing
// ============================================================================

describe('LaunchWindow - detectWindowCrossing', () => {
  const SYN = 5000;
  const IMM = 10;

  it('first sample (null prev) fires nothing', () => {
    const r = detectWindowCrossing(null, 12, SYN, IMM);
    assert.equal(r.imminent, false);
    assert.equal(r.opened, false);
  });

  it('fires imminent exactly when crossing below the threshold', () => {
    const r = detectWindowCrossing(12, 9, SYN, IMM);
    assert.equal(r.imminent, true);
    assert.equal(r.opened, false);
  });

  it('does not re-fire imminent once already below threshold', () => {
    const r = detectWindowCrossing(9, 8, SYN, IMM);
    assert.equal(r.imminent, false);
  });

  it('detects rollover as window-open (countdown jumps back up)', () => {
    const r = detectWindowCrossing(1, 4900, SYN, IMM);
    assert.equal(r.opened, true);
    assert.equal(r.imminent, false);
  });

  it('does NOT treat a mid-flight phase jump (large prev) as window-open', () => {
    // Player burns mid-transit → departIn jumps up from a large value, not from ~0.
    const r = detectWindowCrossing(2500, 4800, SYN, IMM);
    assert.equal(r.opened, false, 'only a near-zero prev counts as a true rollover');
  });

  it('co-orbital (infinite synodic) never opens or beeps', () => {
    const r = detectWindowCrossing(0, 0, Infinity, IMM);
    assert.equal(r.opened, false);
    assert.equal(r.imminent, false);
  });
});
