/**
 * test-CeremonyAlpha.js — Regression tests for launch ceremony strut-alpha formula.
 *
 * The ceremony code in CameraSystem._updateLaunchCeremony Phase 1 computes
 * strut-alpha in the PlayerSatellite MODEL frame:
 *   - Model barrel axis = Z (forward/aft)
 *   - Model collar radial plane = XY
 *   - _dockOutward stores (cos θ, 0, sin θ) in AimDecomposition's XZ convention,
 *     so _dockOutward.z = sin(θ) maps to the model's Y-radial component.
 *
 * Formula (model-frame adapted):
 *   sin(α) = localDir.x · _dockOutward.x + localDir.y · _dockOutward.z
 *   cos(α) = -localDir.z
 *   α = atan2(|sin(α)|, cos(α))
 *
 * This differs from AimDecomposition.js which uses Y-up/XZ-collar convention.
 * The ceremony formula correctly bridges the two frames.
 */
import { describe, it, assert } from './TestRunner.js';

// ── Helper: model-frame strut-alpha (matches CameraSystem ceremony code) ──
// _dockOutward uses AimDecomposition convention: (cos θ, 0, sin θ) in XZ
// but localDir is in model frame: barrel=Z, collar=XY
function computeStrutAlphaModelFrame(localDir, dockOutward) {
  // dockOutward.x = cos(θ), dockOutward.z = sin(θ) which maps to model Y
  const sinA = localDir.x * dockOutward.x + localDir.y * dockOutward.z;
  const cosA = -localDir.z;
  return Math.atan2(Math.abs(sinA), cosA);
}

// ── Helper: AimDecomposition convention (Y-up barrel, XZ collar) ──
function computeStrutAlphaAimDecomp(localDir, dockOutward) {
  const sinA = localDir.x * dockOutward.x + localDir.z * dockOutward.z;
  const cosA = -localDir.y;
  return Math.atan2(Math.abs(sinA), cosA);
}

describe('Launch ceremony strut alpha — model frame', () => {

  it('target ahead (+Z barrel) yields α ≈ π (opens fully forward)', () => {
    // Target straight ahead in model frame: +Z = forward (prograde)
    const localDir = { x: 0, y: 0, z: 1 };
    // Arm at azimuth 60°: dockOutward = (cos60°, 0, sin60°) = (0.5, 0, 0.866)
    const dockOutward = { x: 0.5, y: 0, z: 0.866 };

    const alpha = computeStrutAlphaModelFrame(localDir, dockOutward);
    // sinA = 0*0.5 + 0*0.866 = 0, cosA = -1 → atan2(0, -1) = π
    assert.closeTo(alpha, Math.PI, 0.01,
      `Target ahead should yield α≈π (zenith/forward), got ${alpha.toFixed(4)}`);
  });

  it('target radially outward (+X,+Y in model) yields α ≈ π/2', () => {
    // Target in the collar plane along the arm's outward direction
    // For azimuth 60°: model outward = (cos60°, sin60°, 0) = (0.5, 0.866, 0)
    const localDir = { x: 0.5, y: 0.866, z: 0 };
    const dockOutward = { x: 0.5, y: 0, z: 0.866 };

    const alpha = computeStrutAlphaModelFrame(localDir, dockOutward);
    // sinA = 0.5*0.5 + 0.866*0.866 = 0.25 + 0.75 = 1.0, cosA = 0
    // atan2(1, 0) = π/2
    assert.closeTo(alpha, Math.PI / 2, 0.01,
      `Radially outward target should yield α≈π/2, got ${alpha.toFixed(4)}`);
  });

  it('target aft (−Z barrel) yields α ≈ 0 (stowed)', () => {
    // Target behind the satellite: −Z
    const localDir = { x: 0, y: 0, z: -1 };
    const dockOutward = { x: 0.5, y: 0, z: 0.866 };

    const alpha = computeStrutAlphaModelFrame(localDir, dockOutward);
    // sinA = 0, cosA = -(-1) = 1 → atan2(0, 1) = 0
    assert.closeTo(alpha, 0, 0.01,
      `Target aft should yield α≈0 (stowed), got ${alpha.toFixed(4)}`);
  });

  it('diagonal target (forward + radial) yields intermediate α', () => {
    // Target at 45° between forward (+Z) and radial outward
    const s = Math.SQRT1_2;
    // For arm at azimuth 0°: dockOutward = (1, 0, 0), model outward = (1, 0, 0)
    const localDir = { x: s, y: 0, z: s };
    const dockOutward = { x: 1, y: 0, z: 0 };

    const alpha = computeStrutAlphaModelFrame(localDir, dockOutward);
    // sinA = s*1 + 0*0 = s, cosA = -s → atan2(s, -s) = 3π/4
    assert.closeTo(alpha, 3 * Math.PI / 4, 0.01,
      `Diagonal target should yield α≈3π/4 (135°), got ${(alpha * 180 / Math.PI).toFixed(1)}°`);
  });

  it('azimuth 90° arm with +Z target gives α ≈ π', () => {
    const localDir = { x: 0, y: 0, z: 1 };
    // azimuth 90°: dockOutward = (cos90°, 0, sin90°) = (0, 0, 1)
    const dockOutward = { x: 0, y: 0, z: 1 };

    const alpha = computeStrutAlphaModelFrame(localDir, dockOutward);
    // sinA = 0*0 + 0*1 = 0, cosA = -1 → atan2(0, -1) = π
    assert.closeTo(alpha, Math.PI, 0.01,
      `Az=90° arm, +Z target → α≈π, got ${alpha.toFixed(4)}`);
  });
});

describe('Launch ceremony strut alpha — frame convention difference', () => {

  it('model-frame and AimDecomp formulas give DIFFERENT results for +Z target', () => {
    // This documents the intentional Y↔Z frame difference
    const localDir = { x: 0, y: 0, z: 1 };
    const dockOutward = { x: 0.5, y: 0, z: 0.866 };

    const alphaModel = computeStrutAlphaModelFrame(localDir, dockOutward);
    const alphaDecomp = computeStrutAlphaAimDecomp(localDir, dockOutward);

    // Model: sinA=0, cosA=-1 → π
    // AimDecomp: sinA=0*0.5+1*0.866=0.866, cosA=0 → π/2
    assert.ok(Math.abs(alphaModel - alphaDecomp) > 0.1,
      `Model-frame (${alphaModel.toFixed(2)}) should differ from AimDecomp (${alphaDecomp.toFixed(2)}) ` +
      `due to Y↔Z frame convention`);
  });

  it('model-frame formula converts _dockOutward.z → model Y correctly', () => {
    // _dockOutward = (cos θ, 0, sin θ) in AimDecomp convention
    // In model frame, outward at θ is (cos θ, sin θ, 0)
    // Formula bridges by using localDir.y * _dockOutward.z
    const theta = 60 * Math.PI / 180;
    const dockOutward = { x: Math.cos(theta), y: 0, z: Math.sin(theta) };

    // Target purely along model outward = (cos θ, sin θ, 0)
    const localDir = { x: Math.cos(theta), y: Math.sin(theta), z: 0 };

    const alpha = computeStrutAlphaModelFrame(localDir, dockOutward);
    // sinA = cos²θ + sin²θ = 1, cosA = 0 → π/2 (equatorial)
    assert.closeTo(alpha, Math.PI / 2, 0.01,
      `Pure radial target → equatorial α≈π/2, got ${alpha.toFixed(4)}`);
  });

  it('model-frame formula handles all 4 Y0 azimuths consistently', () => {
    const azimuths = [60, 120, 240, 300];
    const localDir = { x: 0, y: 0, z: 1 }; // target ahead

    for (const azDeg of azimuths) {
      const theta = azDeg * Math.PI / 180;
      const dockOutward = { x: Math.cos(theta), y: 0, z: Math.sin(theta) };
      const alpha = computeStrutAlphaModelFrame(localDir, dockOutward);
      // All arms: sinA = 0, cosA = -1 → α = π
      assert.closeTo(alpha, Math.PI, 0.01,
        `Az=${azDeg}° arm, +Z target → α≈π, got ${alpha.toFixed(4)}`);
    }
  });
});
