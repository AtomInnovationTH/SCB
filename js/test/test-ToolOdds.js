/**
 * test-ToolOdds.js — unified live capture-tool odds model
 * (capture-feedback overhaul Phase 1a).
 *
 * Honest-numbers contract: every % the HUD shows must be the % the resolve
 * rolls. Coverage: monotonicity (odds rise as tumble falls / range closes),
 * width gate, strain band, magnet ferrous forks, pad mode forks, ▶ selection.
 */
import { describe, it, assert } from './TestRunner.js';
import {
  computeToolOdds,
  computeBestTool,
  computeStrainFailProbability,
  estimateSpinFractionAtContact,
  resolveCaptureModeForOdds,
  resolvePadModeForOdds,
} from '../systems/ToolOdds.js';
import { Constants } from '../core/Constants.js';

const CN = Constants.CAPTURE_NET;

const baseTarget = (over = {}) => ({
  mass: 200, sizeMeter: 3, type: 'defunctSat',
  surfaceRoughness: 1.0,
  ...over,
});

describe('ToolOdds — NET monotonicity (the feedback loop)', () => {
  it('odds RISE as tumble falls (de-spin lever)', () => {
    const at = (tumbleDeg) => computeToolOdds({
      armType: 'weaver', range: 25,
      target: baseTarget({ tumbleRate: tumbleDeg * Math.PI / 180 }),
    }).NET.p;
    const fast = at(40);
    const mid = at(20);
    const slow = at(8);
    assert.ok(fast < mid, `40°/s (${fast}) < 20°/s (${mid})`);
    assert.ok(mid < slow, `20°/s (${mid}) < in-spec (${slow})`);
  });

  it('odds RISE as range closes (close-in lever)', () => {
    const at = (range) => computeToolOdds({
      armType: 'weaver', range, target: baseTarget(),
    }).NET.p;
    assert.ok(at(70) < at(45), 'closing 70→45 m raises odds');
    assert.ok(at(45) < at(20), 'closing 45→20 m raises odds');
  });

  it('tumble blocker + de-spin hint on a fast spinner', () => {
    const o = computeToolOdds({
      armType: 'weaver', range: 20,
      target: baseTarget({ tumbleRate: 40 * Math.PI / 180 }),
    }).NET;
    assert.equal(o.blocker, 'TUMBLE');
    assert.ok(o.hint.includes('de-spin'), `hint offers the lever: ${o.hint}`);
  });
});

describe('ToolOdds — NET width gate', () => {
  it('wider than the mouth → 0% with WIDE blocker (deterministic)', () => {
    const o = computeToolOdds({
      armType: 'weaver', range: 20, target: baseTarget({ sizeMeter: 6 }),
    }).NET;
    assert.equal(o.p, 0);
    assert.equal(o.blocker, 'WIDE');
  });

  it('Phase 2 seam: presentedWidthM overrides the scalar sizeMeter', () => {
    // 7 m long body presented end-on (2 m) fits the 5 m mouth.
    const o = computeToolOdds({
      armType: 'weaver', range: 20,
      target: baseTarget({ sizeMeter: 7 }),
      presentedWidthM: 2.0,
    }).NET;
    assert.ok(o.p > 0, 'end-on presentation unlocks the shot');
    const broadside = computeToolOdds({
      armType: 'weaver', range: 20,
      target: baseTarget({ sizeMeter: 7 }),
      presentedWidthM: 7.0,
    }).NET;
    assert.equal(broadside.p, 0, 'broadside presentation stays gated');
  });

  it('beyond net reach → 0% RANGE (deterministic timeout miss)', () => {
    const o = computeToolOdds({
      armType: 'weaver', range: 200, target: baseTarget(),
    }).NET;
    assert.equal(o.p, 0);
    assert.equal(o.blocker, 'RANGE');
  });

  it('empty magazine → p null (display --), EMPTY blocker', () => {
    const o = computeToolOdds({
      armType: 'weaver', range: 20, target: baseTarget(), netCount: 0,
    }).NET;
    assert.equal(o.p, null);
    assert.equal(o.blocker, 'EMPTY');
  });
});

describe('ToolOdds — NET strain band (mirrors _checkNetIntegrityOnReel)', () => {
  it('strainFailP is 0 at/below the safe fraction', () => {
    assert.equal(computeStrainFailProbability(400, 500), 0, '80% rated → safe');
    assert.equal(computeStrainFailProbability(100, 500), 0);
  });

  it('strainFailP ramps linearly to FAIL_PROB_MAX at 100% rated', () => {
    const pMax = Constants.NET_STRAIN_FAIL_PROB_MAX;
    const p90 = computeStrainFailProbability(450, 500);
    const p100 = computeStrainFailProbability(500, 500);
    assert.ok(Math.abs(p90 - pMax * 0.5) < 1e-9, '90% rated → half of pMax');
    assert.ok(Math.abs(p100 - pMax) < 1e-9, '100% rated → pMax');
    assert.ok(Math.abs(computeStrainFailProbability(900, 500) - pMax) < 1e-9, 'clamped above rated');
  });

  it('NET odds are multiplied by strain survival; STRAIN blocker names the %', () => {
    const light = computeToolOdds({
      armType: 'weaver', range: 20, target: baseTarget({ mass: 100 }),
    }).NET;
    const heavy = computeToolOdds({
      armType: 'weaver', range: 20, target: baseTarget({ mass: 480 }),
    }).NET;
    assert.ok(heavy.p < light.p, 'near-rated catch suppresses odds');
    assert.ok(/^STRAIN \d+%$/.test(heavy.blocker), `blocker names the strain %: ${heavy.blocker}`);
  });
});

describe('ToolOdds — honest pre-fire estimates', () => {
  it('spin fraction at contact mirrors the flight decay model', () => {
    const f0 = estimateSpinFractionAtContact(0, CN.MEDIUM);
    const f50 = estimateSpinFractionAtContact(50, CN.MEDIUM);
    assert.equal(f0, 1, 'point-blank: no decay');
    const expected = 1 - CN.SPIN_DECAY_PER_S * (50 / CN.MEDIUM.LAUNCH_SPEED);
    assert.ok(Math.abs(f50 - expected) < 1e-9, 'tof × SPIN_DECAY_PER_S');
  });

  it('capture-mode resolution mirrors fire-time forcing (NET_CEREMONY → CINCH)', () => {
    const prev = Constants.FEATURE_FLAGS.NET_CEREMONY;
    try {
      Constants.FEATURE_FLAGS.NET_CEREMONY = true;
      assert.equal(resolveCaptureModeForOdds({ }), CN.MODES.CINCH, 'ceremony forces CINCH');
      Constants.FEATURE_FLAGS.NET_CEREMONY = false;
      assert.equal(resolveCaptureModeForOdds({ }), CN.MODES.SLAM_WRAP, 'durable target → slam');
      assert.equal(resolveCaptureModeForOdds({ hasSolarPanels: true }), CN.MODES.CINCH, 'fragile → cinch');
    } finally {
      Constants.FEATURE_FLAGS.NET_CEREMONY = prev;
    }
  });
});

describe('ToolOdds — MAGNET ferrous forks (mirrors _resolveMagnetGrip)', () => {
  it('ferrous hull → P_GRIP_FERROUS', () => {
    const o = computeToolOdds({
      armType: 'weaver', target: baseTarget({ ferromagnetic: true }),
    }).MAGNET;
    assert.equal(o.p, Constants.MAGNETIC_GRAPPLE.P_GRIP_FERROUS);
    assert.equal(o.blocker, null);
  });

  it('fastener-only → P_GRIP_FASTENERS', () => {
    const o = computeToolOdds({
      armType: 'weaver', target: baseTarget({ hasFerrousFasteners: true }),
    }).MAGNET;
    assert.equal(o.p, Constants.MAGNETIC_GRAPPLE.P_GRIP_FASTENERS);
  });

  it('non-ferrous → P_GRIP_NON_FERROUS with NON-FERR blocker', () => {
    const o = computeToolOdds({ armType: 'weaver', target: baseTarget() }).MAGNET;
    assert.equal(o.p, Constants.MAGNETIC_GRAPPLE.P_GRIP_NON_FERROUS);
    assert.equal(o.blocker, 'NON-FERR');
  });

  it('beyond EPM mass limit → 0% HEAVY', () => {
    const o = computeToolOdds({
      armType: 'weaver', target: baseTarget({ mass: 900, ferromagnetic: true }),
    }).MAGNET;
    assert.equal(o.p, 0);
    assert.equal(o.blocker, 'HEAVY');
  });
});

describe('ToolOdds — GRIPPER / PAD gates', () => {
  it('fixtured gripper → P_GRIP_FIXTURED; unfixtured → P_GRIP_UNFIXTURED with NO-FIX', () => {
    const fixed = computeToolOdds({
      armType: 'weaver', target: baseTarget({ hasGrappleFixture: true }),
    }).GRIPPER;
    assert.equal(fixed.p, Constants.GRIPPER_GRAPPLE.P_GRIP_FIXTURED);
    const bare = computeToolOdds({ armType: 'weaver', target: baseTarget() }).GRIPPER;
    assert.equal(bare.p, Constants.GRIPPER_GRAPPLE.P_GRIP_UNFIXTURED);
    assert.equal(bare.blocker, 'NO-FIX');
  });

  it('pad: contact too fast → 0% FAST (deterministic bounce)', () => {
    const o = computeToolOdds({
      armType: 'spinner', target: baseTarget({ mass: 5, type: 'fragment' }),
      contactVel: 0.5,
    }).PAD;
    assert.equal(o.p, 0);
    assert.equal(o.blocker, 'FAST');
  });

  it('pad mode resolution mirrors _resolvePadMode priority', () => {
    assert.equal(resolvePadModeForOdds({ material: 'steel' }, 10), 'magnet');
    assert.equal(resolvePadModeForOdds({ material: 'mli_mylar' }, 10), 'hooks');
    assert.equal(resolvePadModeForOdds({ surfaceRoughness: 0.9 }, 10), 'hooks');
    assert.equal(resolvePadModeForOdds({ material: 'aluminum' }, 10), 'gecko');
    assert.equal(resolvePadModeForOdds({ material: 'composite' }, 10), 'electrostatic');
    assert.equal(resolvePadModeForOdds({ material: 'unobtainium' }, 3), 'uv_cure');
    assert.equal(resolvePadModeForOdds({ material: 'unobtainium' }, 0), null, 'doses spent → NO_MODE');
  });

  it('pad p comes from P_GRIP_BY_MODE for the resolved mode', () => {
    // Smooth aluminum (roughness ≤ 0.7 so hooks doesn't pre-empt) → gecko.
    const o = computeToolOdds({
      armType: 'spinner',
      target: baseTarget({ mass: 5, type: 'fragment', material: 'aluminum', surfaceRoughness: 0.4 }),
    }).PAD;
    assert.equal(o.p, Constants.PAD_CONTACT.P_GRIP_BY_MODE.gecko);
  });
});

describe('ToolOdds — ▶ selection (computeBestTool)', () => {
  it('ferrous hull: MAGNET 95% beats the net shot', () => {
    const odds = computeToolOdds({
      armType: 'weaver', range: 50, target: baseTarget({ ferromagnetic: true }),
    });
    assert.equal(computeBestTool(odds, ['NET', 'GRIPPER', 'MAGNET']), 'MAGNET');
  });

  it('too-wide body: GRIPPER takes the ▶ over residual-flux magnet', () => {
    const odds = computeToolOdds({
      armType: 'weaver', range: 50, target: baseTarget({ sizeMeter: 6 }),
    });
    assert.equal(odds.NET.p, 0);
    assert.equal(computeBestTool(odds, ['NET', 'GRIPPER', 'MAGNET']), 'GRIPPER');
  });

  it('near-tie stays on the earlier-preference tool (no flip-flop)', () => {
    // NET ~0.88 at 20 m vs fixtured GRIPPER 0.90 — within the margin → NET keeps ▶.
    const odds = computeToolOdds({
      armType: 'weaver', range: 20, target: baseTarget({ hasGrappleFixture: true }),
    });
    assert.ok(Math.abs(odds.NET.p - odds.GRIPPER.p) < 0.1, 'sanity: genuinely close');
    assert.equal(computeBestTool(odds, ['NET', 'GRIPPER', 'MAGNET']), 'NET');
  });

  it('uv_cure-resolved PAD never takes the ▶ (finite consumable)', () => {
    // Exotic smooth surface: no deterministic mode → uv_cure last resort.
    const odds = computeToolOdds({
      armType: 'spinner', range: 20,
      target: baseTarget({ mass: 5, sizeMeter: 0.5, type: 'fragment', material: 'unobtainium', surfaceRoughness: 0.4 }),
    });
    assert.equal(odds.PAD.mode, 'uv_cure', 'sanity: uv-cure resolves');
    assert.ok(odds.PAD.p > odds.NET.p, 'sanity: uv-cure % is nominally higher');
    assert.equal(computeBestTool(odds, ['NET', 'PAD', 'MAGNET']), 'NET');
  });

  it('empty net magazine: next-best rollable tool takes the ▶', () => {
    const odds = computeToolOdds({
      armType: 'weaver', range: 20, netCount: 0,
      target: baseTarget({ hasGrappleFixture: true }),
    });
    assert.equal(odds.NET.p, null);
    assert.equal(computeBestTool(odds, ['NET', 'GRIPPER', 'MAGNET']), 'GRIPPER');
  });
});
