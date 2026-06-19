/**
 * test-RosaFurl.js — ROSA solar-array furl/unfurl runtime control.
 *
 * Covers the player-owned furl state machine added with the "," hotkey:
 *   - toggleRosaFurl() flips the target based on live progress
 *   - setRosaFurl() clamps + latches manual control
 *   - _updateRosaPanels() defers to LaunchSequence while active, then hands
 *     control to the player furl state once launch is READY / absent
 *   - furled state drops the ROSA power share but keeps the body-mount share
 *
 * The methods are exercised on a lightweight stub via Function.prototype.call
 * so we avoid PlayerSatellite's heavy constructor (scene-add, eventBus wiring,
 * orbital seeding). We only need the furl logic, which is self-contained.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { PlayerSatellite } from '../entities/PlayerSatellite.js';

const P = PlayerSatellite.prototype;

/**
 * Minimum self-illumination floor for the ROSA back substrate. The back
 * (BackSide) mesh is the ONLY thing rendered when the Mother is inverted and
 * the camera looks at the panel's far face; if its emissiveIntensity collapses
 * the wings read as "gone" against black space / Earth. Commit 0d5abe8 (v.99)
 * regressed this to 0.18 and the wings vanished when flipped. The live value is
 * kept modest (enough to read against black space, not so high it looks self-lit
 * in sunlight). Keep this floor below the live value but well above the 0.18
 * vanish point; do NOT lower the material below it.
 */
const ROSA_BACK_EMISSIVE_MIN = 0.24;

/** Minimal stub carrying just the fields the furl methods touch. */
function makeStub(overrides = {}) {
  const stub = {
    _rosaFurlTarget: 1.0,
    _rosaFurlProgress: 1.0,
    _rosaManualControl: false,
    _rosaFeatherTarget: 0.0,
    _rosaFeatherProgress: 0.0,
    _launchSequence: null,
    _wingProgress: { 1: null, 2: null },
    // Capture _setRosaWingProgress calls instead of touching THREE meshes.
    _setRosaWingProgress(wing, progress) { this._wingProgress[wing] = progress; },
    ...overrides,
  };
  return stub;
}

describe('ROSA furl — toggleRosaFurl / setRosaFurl', () => {
  it('toggleRosaFurl from deployed (1.0) targets furled (0) and latches manual', () => {
    const s = makeStub();
    const t = P.toggleRosaFurl.call(s);
    assert.equal(t, 0, 'target flips to 0 (furl) when currently deployed');
    assert.equal(s._rosaFurlTarget, 0, 'state stored');
    assert.equal(s._rosaManualControl, true, 'manual control latched');
  });

  it('toggleRosaFurl from furled (<0.5) targets unfurled (1)', () => {
    const s = makeStub({ _rosaFurlProgress: 0.2 });
    const t = P.toggleRosaFurl.call(s);
    assert.equal(t, 1, 'target flips to 1 (unfurl) when currently furled');
  });

  it('toggleRosaFurl reverses mid-animation based on live progress', () => {
    const s = makeStub({ _rosaFurlProgress: 0.7 }); // mostly out
    assert.equal(P.toggleRosaFurl.call(s), 0, '>=0.5 → furl');
    s._rosaFurlProgress = 0.49;
    assert.equal(P.toggleRosaFurl.call(s), 1, '<0.5 → unfurl');
  });

  it('setRosaFurl clamps to [0,1] and latches manual control', () => {
    const s = makeStub();
    assert.equal(P.setRosaFurl.call(s, 2), 1, 'clamps high to 1');
    assert.equal(P.setRosaFurl.call(s, -3), 0, 'clamps low to 0');
    assert.equal(s._rosaManualControl, true, 'manual control latched');
  });

  it('resetRosaFurlState clears manual control and re-deploys (retry guard)', () => {
    // Simulate the prior run ending furled + feathered: player toggled both.
    const s = makeStub({
      _rosaManualControl: true, _rosaFurlTarget: 0, _rosaFurlProgress: 0,
      _rosaFeatherTarget: 1, _rosaFeatherProgress: 1,
    });
    P.resetRosaFurlState.call(s);
    assert.equal(s._rosaManualControl, false, 'manual control cleared');
    assert.equal(s._rosaFurlTarget, 1.0, 'target back to deployed');
    assert.equal(s._rosaFurlProgress, 1.0, 'progress back to deployed');
    assert.equal(s._rosaFeatherTarget, 0.0, 'feather target cleared');
    assert.equal(s._rosaFeatherProgress, 0.0, 'feather progress cleared');
    // After reset, a no-launch update holds fully deployed (not the old furl).
    P._updateRosaPanels.call(s, 1.0);
    assert.equal(s._rosaFurlProgress, 1.0, 'retry starts deployed, not furled');
  });
});

describe('ROSA furl — _updateRosaPanels control handover', () => {
  it('follows LaunchSequence while it is active (player furl ignored)', () => {
    const s = makeStub({
      _rosaManualControl: true,
      _rosaFurlTarget: 0, // player wants furled, but launch is still running
      _launchSequence: {
        isActive: () => true,
        getRosaProgress: () => ({ wing1: 0.4, wing2: 0.3 }),
      },
    });
    P._updateRosaPanels.call(s, 0.016);
    assert.equal(s._wingProgress[1], 0.4, 'wing 1 follows launch progress');
    assert.equal(s._wingProgress[2], 0.3, 'wing 2 follows launch progress');
    // Furl progress syncs to the min so handover is seamless.
    assert.closeTo(s._rosaFurlProgress, 0.3, 1e-9, 'furl progress synced to launch');
  });

  it('once launch is READY, animates toward the player furl target', () => {
    const rate = Constants.OCTOPUS_V5.ROSA_FURL_RATE;
    const s = makeStub({
      _rosaManualControl: true,
      _rosaFurlTarget: 0,
      _rosaFurlProgress: 1.0,
      _launchSequence: { isActive: () => false },
    });
    P._updateRosaPanels.call(s, 1.0); // 1 second
    assert.closeTo(s._rosaFurlProgress, 1.0 - rate, 1e-9, 'moves toward 0 by rate*dt');
    assert.equal(s._wingProgress[1], s._rosaFurlProgress, 'wing 1 driven by furl progress');
    assert.equal(s._wingProgress[2], s._rosaFurlProgress, 'wing 2 driven by furl progress');
  });

  it('reaches the furl target without overshoot', () => {
    const s = makeStub({
      _rosaManualControl: true,
      _rosaFurlTarget: 0,
      _rosaFurlProgress: 0.05,
      _launchSequence: { isActive: () => false },
    });
    P._updateRosaPanels.call(s, 10.0); // huge dt
    assert.equal(s._rosaFurlProgress, 0, 'clamps exactly to target (no overshoot below 0)');
  });

  it('holds fully deployed when the player never toggled (no launch)', () => {
    const s = makeStub({ _rosaManualControl: false, _rosaFurlProgress: 1.0, _launchSequence: null });
    P._updateRosaPanels.call(s, 1.0);
    assert.equal(s._rosaFurlProgress, 1.0, 'stays deployed');
    assert.equal(s._wingProgress[1], 1.0, 'wing 1 deployed');
  });
});

describe('ROSA furl — power coupling sanity', () => {
  it('power fractions sum to ~1 and ROSA is the larger share', () => {
    const V5 = Constants.OCTOPUS_V5;
    assert.closeTo(V5.ROSA_POWER_FRACTION + V5.BODY_MOUNT_POWER_FRACTION, 1.0, 1e-9,
      'ROSA + body fractions sum to 1');
    assert.ok(V5.ROSA_POWER_FRACTION > V5.BODY_MOUNT_POWER_FRACTION,
      'ROSA share exceeds body-mount share');
  });

  it('furl multiplier model: furled keeps body share, unfurled keeps full', () => {
    const V5 = Constants.OCTOPUS_V5;
    const mult = (furl) => V5.BODY_MOUNT_POWER_FRACTION + V5.ROSA_POWER_FRACTION * furl;
    assert.closeTo(mult(1), 1.0, 1e-9, 'unfurled → full power');
    assert.closeTo(mult(0), V5.BODY_MOUNT_POWER_FRACTION, 1e-9, 'furled → body-mount only');
    assert.ok(mult(0) > 0 && mult(0) < mult(1), 'furled is reduced but non-zero');
  });

  it('feather multiplier model: edge-on attenuates ROSA share to the body floor', () => {
    const V5 = Constants.OCTOPUS_V5;
    // Mirrors _updateSolarPower: furlMult = body + rosa * furl * cos(feather·90°)
    const mult = (furl, feather) => {
      const inc = Math.cos(feather * Math.PI / 2);
      return V5.BODY_MOUNT_POWER_FRACTION + V5.ROSA_POWER_FRACTION * furl * inc;
    };
    assert.closeTo(mult(1, 0), 1.0, 1e-9, 'deployed + flat → full power');
    assert.closeTo(mult(1, 1), V5.BODY_MOUNT_POWER_FRACTION, 1e-9,
      'deployed + fully feathered → body-mount floor (ROSA share zeroed)');
    assert.ok(mult(1, 0.5) > mult(1, 1) && mult(1, 0.5) < mult(1, 0),
      'partial feather is between full and floor');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Feather (Shift+",") — manual edge-on park. Reuses the tilt pivots, animates
// at ROSA_FEATHER_RATE, and is cleared on reset. Furl takes precedence.
// ───────────────────────────────────────────────────────────────────────────
describe('ROSA feather — toggleRosaFeather / setRosaFeather', () => {
  it('toggleRosaFeather from tracking (0) targets feathered (true)', () => {
    const s = makeStub();
    const on = P.toggleRosaFeather.call(s);
    assert.equal(on, true, 'toggles to feathered when currently tracking');
    assert.equal(s._rosaFeatherTarget, 1.0, 'feather target stored');
  });

  it('toggleRosaFeather from feathered (>=0.5) targets tracking (false)', () => {
    const s = makeStub({ _rosaFeatherProgress: 0.8 });
    const on = P.toggleRosaFeather.call(s);
    assert.equal(on, false, 'toggles back to tracking when feathered');
    assert.equal(s._rosaFeatherTarget, 0.0, 'feather target cleared');
  });

  it('toggleRosaFeather reverses mid-animation based on live progress', () => {
    const s = makeStub({ _rosaFeatherProgress: 0.6 });
    assert.equal(P.toggleRosaFeather.call(s), false, '>=0.5 → un-feather');
    s._rosaFeatherProgress = 0.4;
    assert.equal(P.toggleRosaFeather.call(s), true, '<0.5 → feather');
  });

  it('setRosaFeather clamps to [0,1]', () => {
    const s = makeStub();
    assert.equal(P.setRosaFeather.call(s, 2), 1, 'clamps high to 1');
    assert.equal(P.setRosaFeather.call(s, -3), 0, 'clamps low to 0');
  });

  it('_updateRosaPanels animates feather toward target at ROSA_FEATHER_RATE', () => {
    const rate = Constants.OCTOPUS_V5.ROSA_FEATHER_RATE;
    const s = makeStub({
      _rosaFeatherTarget: 1.0, _rosaFeatherProgress: 0.0,
      _launchSequence: { isActive: () => false },
    });
    P._updateRosaPanels.call(s, 1.0); // 1 second
    assert.closeTo(s._rosaFeatherProgress, rate, 1e-9, 'feather advances by rate*dt');
  });

  it('_updateRosaPanels feather reaches target without overshoot', () => {
    const s = makeStub({
      _rosaFeatherTarget: 1.0, _rosaFeatherProgress: 0.9,
      _launchSequence: { isActive: () => false },
    });
    P._updateRosaPanels.call(s, 10.0); // huge dt
    assert.equal(s._rosaFeatherProgress, 1.0, 'clamps exactly to 1 (no overshoot)');
  });

  it('feather animates even while the launch sequence is still rolling out', () => {
    const s = makeStub({
      _rosaFeatherTarget: 1.0, _rosaFeatherProgress: 0.0,
      _launchSequence: {
        isActive: () => true,
        getRosaProgress: () => ({ wing1: 0.4, wing2: 0.4 }),
      },
    });
    P._updateRosaPanels.call(s, 1.0);
    assert.ok(s._rosaFeatherProgress > 0, 'feather advances independently of roll-out');
  });
});

describe('ROSA tier-aware tilt clamp — _rosaMaxTiltRad', () => {
  const tight = (Constants.OCTOPUS_V5.ROSA_TILT_CLAMP_TIGHT_DEG ?? 18) * Math.PI / 180;
  const loose = 30 * Math.PI / 180;

  it('Y0 (struts 60° off plane) → loose ±30° clamp', () => {
    const s = makeStub({ armManager: { getCurrentTier: () => 'Y0_QUAD' } });
    assert.closeTo(P._rosaMaxTiltRad.call(s), loose, 1e-9, 'Y0 stays loose');
  });

  it('Y1 hex (struts 30°/330° → 30° off plane) → tight clamp', () => {
    const s = makeStub({ armManager: { getCurrentTier: () => 'Y1_HEX' } });
    assert.closeTo(P._rosaMaxTiltRad.call(s), tight, 1e-9, 'Y1 tightens the clamp');
  });

  it('Y3 octo (also 30°/330°) → tight clamp', () => {
    const s = makeStub({ armManager: { getCurrentTier: () => 'Y3_OCTO' } });
    assert.closeTo(P._rosaMaxTiltRad.call(s), tight, 1e-9, 'Y3 tightens the clamp');
  });

  it('no armManager → falls back to Y0 loose clamp', () => {
    const s = makeStub({ armManager: null });
    assert.closeTo(P._rosaMaxTiltRad.call(s), loose, 1e-9, 'fallback is the loose default');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Power-flow glow — _animateRosaGlow drives the front cell emissive from the
// generated power so the wings energize in sun and go dark in shadow/feather.
// ───────────────────────────────────────────────────────────────────────────
function makeGlowMat() {
  return { emissive: { _hex: 0, setHex(h) { this._hex = h; } }, emissiveIntensity: 0 };
}
function makeGlowStub(overrides = {}) {
  return {
    _rosaGlowClock: 0,
    _rosaGlowIdleFloor: 0,
    _rosaFrontMats: [makeGlowMat()],
    resources: { solarRate: 0 },
    ...overrides,
  };
}
const PEAK = Constants.SOLAR_FLUX * Constants.SOLAR_PANEL_AREA * Constants.SOLAR_PANEL_EFFICIENCY;

describe('ROSA power-flow glow — _animateRosaGlow', () => {
  it('full generation → bright emissive', () => {
    const s = makeGlowStub({ resources: { solarRate: PEAK } });
    P._animateRosaGlow.call(s, 0.016);
    assert.ok(s._rosaFrontMats[0].emissiveIntensity > 0.5, 'bright when generating at peak');
  });

  it('shadow (no power) → dim emissive, near the dark floor', () => {
    const s = makeGlowStub({ resources: { solarRate: 0 } });
    P._animateRosaGlow.call(s, 0.016);
    assert.ok(s._rosaFrontMats[0].emissiveIntensity < 0.15, 'dim in shadow / feathered / furled');
  });

  it('generating is brighter than shadow (function is visible)', () => {
    const lit = makeGlowStub({ resources: { solarRate: PEAK } });
    const dark = makeGlowStub({ resources: { solarRate: 0 } });
    P._animateRosaGlow.call(lit, 0.016);
    P._animateRosaGlow.call(dark, 0.016);
    assert.ok(lit._rosaFrontMats[0].emissiveIntensity > dark._rosaFrontMats[0].emissiveIntensity,
      'lit wings glow brighter than shadowed wings');
  });

  it('idle floor (menu hero) glows even with zero solarRate', () => {
    const s = makeGlowStub({ _rosaGlowIdleFloor: 0.55, resources: { solarRate: 0 } });
    P._animateRosaGlow.call(s, 0.016);
    assert.ok(s._rosaFrontMats[0].emissiveIntensity > 0.3, 'idle floor keeps the hero wings energized');
  });

  it('no front mats → no-op (safe in headless)', () => {
    const s = makeGlowStub({ _rosaFrontMats: null });
    P._animateRosaGlow.call(s, 0.016); // must not throw
    assert.ok(true, 'tolerates a null _rosaFrontMats');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Inverted-visibility regression guard — when the Mother flips upside down the
// camera sees the panel BACK face. The FrontSide PV mesh back-face-culls, so the
// BackSide substrate is all that renders; if it dims to black the wings appear
// to vanish (the 0d5abe8 "v.99" regression). Assert each wing keeps a Front
// (FrontSide) + Back (BackSide) mesh and that the back substrate stays at/above
// the self-illuminating floor so it can never silently re-break.
// ───────────────────────────────────────────────────────────────────────────
describe('ROSA inverted visibility — back-face substrate stays lit', () => {
  // Build the real panel meshes on a THREE.Group-backed `this` so this.add(),
  // _buildRosaStructure() and _setRosaWingProgress() all work without the heavy
  // PlayerSatellite constructor. getSolarCellTexture() returns null in headless,
  // which the materials tolerate — we assert on material props, not the map.
  function buildPanels() {
    const ctx = new THREE.Group();
    ctx._buildRosaStructure = P._buildRosaStructure.bind(ctx);
    ctx._setRosaWingProgress = P._setRosaWingProgress.bind(ctx);
    P._buildSolarPanels.call(ctx);
    return ctx;
  }

  function findByName(root, name) {
    let hit = null;
    root.traverse((o) => { if (!hit && o.name === name) hit = o; });
    return hit;
  }

  it('builds a Front (FrontSide) + Back (BackSide) mesh for each wing', () => {
    const ctx = buildPanels();
    for (const [front, back] of [
      ['ROSA_Panel_Front_0deg',   'ROSA_Panel_Back_0deg'],
      ['ROSA_Panel_Front_180deg', 'ROSA_Panel_Back_180deg'],
    ]) {
      const f = findByName(ctx, front);
      const b = findByName(ctx, back);
      assert.ok(f, `${front} mesh exists`);
      assert.ok(b, `${back} mesh exists`);
      assert.equal(f.material.side, THREE.FrontSide, `${front} is FrontSide`);
      assert.equal(b.material.side, THREE.BackSide, `${back} is BackSide`);
    }
  });

  it('back substrate emissiveIntensity stays above the never-black floor', () => {
    const ctx = buildPanels();
    for (const name of ['ROSA_Panel_Back_0deg', 'ROSA_Panel_Back_180deg']) {
      const b = findByName(ctx, name);
      assert.ok(b.material.emissiveIntensity >= ROSA_BACK_EMISSIVE_MIN,
        `${name} emissiveIntensity (${b.material.emissiveIntensity}) >= ` +
        `${ROSA_BACK_EMISSIVE_MIN} so the inverted wing never reads as gone`);
    }
  });

  it('back mesh is coplanar with its front (no unit-error separation)', () => {
    // The back substrate must sit on the SAME plane as the front (local z≈0).
    // A prior "-0.001" offset was meant as 1 mm but 1 scene unit = 100 km, so
    // it was actually -100 m — far larger than the whole 1×2 m panel — which
    // flung the back face away and opened a dead zone where neither face
    // rendered when inverted. Guard: |local z| must be a tiny fraction of the
    // panel size (here, well under one panel width in scene units).
    const ctx = buildPanels();
    const panelW = Constants.OCTOPUS_V5.ROSA_WIDTH * 0.00001; // metre → scene (M)
    for (const [front, back] of [
      ['ROSA_Panel_Front_0deg',   'ROSA_Panel_Back_0deg'],
      ['ROSA_Panel_Front_180deg', 'ROSA_Panel_Back_180deg'],
    ]) {
      const f = findByName(ctx, front);
      const b = findByName(ctx, back);
      // Same in-plane placement as the front, and no meaningful normal offset.
      assert.closeTo(b.position.x, f.position.x, 1e-12, `${back} shares front x`);
      assert.ok(Math.abs(b.position.z) < panelW * 0.01,
        `${back} local z (${b.position.z}) must be ~coplanar with the front, ` +
        `not flung off by a unit error (panel width ${panelW} scene units)`);
    }
  });

  it('edge booms + tip spreader sit on the blanket (no raw-literal z unit error)', () => {
    // The booms (both long edges) and the tip spreader are nudged just off the
    // blanket plane to avoid z-fighting, but that nudge MUST be M-scaled. A prior
    // raw `0.0008` literal was actually ~80 m (1 scene unit = 100 km) — ~80× the
    // panel width — flinging the edge structure far off the blanket so the wings
    // lost all edge detailing. Guard: |local z| must be a tiny fraction of the
    // panel width (same class of guard as the back-face coplanar test above).
    const ctx = buildPanels();
    const panelW = Constants.OCTOPUS_V5.ROSA_WIDTH * 0.00001; // metre → scene (M)
    const structNames = [
      'ROSA_Boom_0deg_A',   'ROSA_Boom_0deg_B',   'ROSA_Spreader_0deg',
      'ROSA_Boom_180deg_A', 'ROSA_Boom_180deg_B', 'ROSA_Spreader_180deg',
    ];
    for (const name of structNames) {
      const m = findByName(ctx, name);
      assert.ok(m, `${name} mesh exists`);
      assert.ok(Math.abs(m.position.z) < panelW * 0.1,
        `${name} local z (${m.position.z}) must be a tiny M-scaled nudge off the ` +
        `blanket, not a raw literal flinging it ~80 m away (panel width ${panelW})`);
    }
  });
});
