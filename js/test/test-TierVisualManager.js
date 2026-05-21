/**
 * test-TierVisualManager.js — V-9 Tier Progression Visual tests
 *
 * Verifies TierVisualManager logic:
 *   - Feature flag gating (init does nothing when off)
 *   - Enable + initial tier read
 *   - Transition lifecycle (start, timer advance, completion)
 *   - Flash mesh creation
 *   - End-face group creation for Y3_OCTO
 *   - Collar geometry replacement
 *   - Dispose cleanup
 */

import { describe, it, assert } from './TestRunner.js';
import { TierVisualManager } from '../scene/TierVisualManager.js';
import { Constants } from '../core/Constants.js';

// ─── Helpers ────────────────────────────────────────────────────────────

function withFlag(value, fn) {
  const prev = Constants.FEATURE_FLAGS.TIER_UPGRADES;
  Constants.FEATURE_FLAGS.TIER_UPGRADES = value;
  try { fn(); } finally { Constants.FEATURE_FLAGS.TIER_UPGRADES = prev; }
}

/** Minimal scene mock */
function mockScene() {
  return {
    _children: [],
    add(obj)    { this._children.push(obj); },
    remove(obj) {
      const i = this._children.indexOf(obj);
      if (i >= 0) this._children.splice(i, 1);
    },
  };
}

/** Minimal player mock with collarRing + strutGroups + add/remove */
function mockPlayer() {
  return {
    _children: [],
    add(obj)    { this._children.push(obj); },
    remove(obj) {
      const i = this._children.indexOf(obj);
      if (i >= 0) this._children.splice(i, 1);
    },
    collarRing: {
      geometry: { dispose() { this._disposed = true; }, _disposed: false },
      position: { y: 0, z: 0 },
    },
    strutGroups: [],
    strutPivots: [],
    strutMeshes: [],
    strutTipNodes: [],
    hingeMounts: [],
    hingeLEDs: [],
  };
}

/** Minimal armManager mock */
function mockArmManager(tier) {
  return { getCurrentTier() { return tier || 'Y0_QUAD'; } };
}

// ─── Suite ──────────────────────────────────────────────────────────────

describe('TierVisualManager', () => {

  it('init does nothing when TIER_UPGRADES flag is false', () => {
    withFlag(false, () => {
      const tvm = new TierVisualManager();
      tvm.init(mockScene(), mockPlayer(), mockArmManager());
      assert.equal(tvm._enabled, false, 'should remain disabled');
    });
  });

  it('init enables and reads initial tier when flag is true', () => {
    withFlag(true, () => {
      const tvm = new TierVisualManager();
      tvm.init(mockScene(), mockPlayer(), mockArmManager('Y0_QUAD'));
      assert.equal(tvm._enabled, true, 'should be enabled');
      assert.equal(tvm._currentTier, 'Y0_QUAD', 'should read initial tier');
      tvm.dispose();
    });
  });

  it('_onTierUpgraded starts transition', () => {
    withFlag(true, () => {
      const tvm = new TierVisualManager();
      tvm.init(mockScene(), mockPlayer(), mockArmManager());
      tvm._onTierUpgraded({
        fromTier: 'Y0_QUAD', toTier: 'Y1_HEX',
        newArmCount: 6, newMassDryKg: 208,
      });
      assert.equal(tvm._transitioning, true, 'should be transitioning');
      assert.equal(tvm._currentTier, 'Y1_HEX', 'tier should update');
      tvm.dispose();
    });
  });

  it('update advances transition timer', () => {
    const tvm = new TierVisualManager();
    tvm._enabled = true;
    tvm._transitioning = true;
    tvm._transitionTimer = 0;
    tvm._transitionDuration = 2.0;
    // Provide empty arrays so iteration doesn't fail
    tvm._flashMeshes = [];
    tvm._addedStruts = [];
    tvm._endFaceGroups = [];
    tvm.update(0.5);
    assert.closeTo(tvm._transitionTimer, 0.5, 0.001, 'timer should advance');
    assert.equal(tvm._transitioning, true, 'should still be transitioning');
  });

  it('update completes transition after duration', () => {
    const tvm = new TierVisualManager();
    tvm._enabled = true;
    tvm._transitioning = true;
    tvm._transitionTimer = 1.5;
    tvm._transitionDuration = 2.0;
    tvm._flashMeshes = [];
    tvm._addedStruts = [];
    tvm._endFaceGroups = [];
    tvm.update(1.0);   // timer → 2.5, past 2.0
    assert.equal(tvm._transitioning, false, 'should finish transition');
  });

  it('_createUpgradeFlash creates flash mesh', () => {
    withFlag(true, () => {
      const tvm = new TierVisualManager();
      const player = mockPlayer();
      tvm.init(mockScene(), player, mockArmManager());
      tvm._createUpgradeFlash();
      assert.ok(tvm._flashMeshes.length >= 1, 'should create at least 1 flash mesh');
      assert.ok(player._children.length >= 1, 'flash should be added to player');
      tvm.dispose();
    });
  });

  it('_onTierUpgraded to Y3_OCTO creates end-face groups', () => {
    withFlag(true, () => {
      const tvm = new TierVisualManager();
      tvm.init(mockScene(), mockPlayer(), mockArmManager());
      tvm._onTierUpgraded({
        fromTier: 'Y1_HEX', toTier: 'Y3_OCTO',
        newArmCount: 8, newMassDryKg: 222,
      });
      assert.equal(tvm._endFaceGroups.length, 2,
        'Y3_OCTO should create 2 end-face mount groups');
      tvm.dispose();
    });
  });

  it('getCurrentTier returns current tier', () => {
    const tvm = new TierVisualManager();
    tvm._currentTier = 'Y1_HEX';
    assert.equal(tvm.getCurrentTier(), 'Y1_HEX');
  });

  it('dispose clears state', () => {
    withFlag(true, () => {
      const tvm = new TierVisualManager();
      tvm.init(mockScene(), mockPlayer(), mockArmManager());
      tvm._onTierUpgraded({
        fromTier: 'Y0_QUAD', toTier: 'Y1_HEX',
        newArmCount: 6, newMassDryKg: 208,
      });
      tvm.dispose();
      assert.equal(tvm._enabled, false, 'should be disabled');
      assert.equal(tvm._flashMeshes.length, 0, 'flash meshes cleared');
      assert.equal(tvm._addedStruts.length, 0, 'added struts cleared');
      assert.equal(tvm._endFaceGroups.length, 0, 'end-face groups cleared');
    });
  });

  it('Y0_QUAD to Y1_HEX replaces collar geometry', () => {
    withFlag(true, () => {
      const tvm = new TierVisualManager();
      const player = mockPlayer();
      const oldGeo = player.collarRing.geometry;
      tvm.init(mockScene(), player, mockArmManager());
      tvm._rebuildVisuals('Y1_HEX', 6);
      assert.ok(oldGeo._disposed, 'old geometry should be disposed');
      assert.ok(player.collarRing.geometry !== oldGeo,
        'collar geometry should be replaced');
      tvm.dispose();
    });
  });

  it('Y1_HEX upgrade adds strut visuals for new azimuths', () => {
    withFlag(true, () => {
      const tvm = new TierVisualManager();
      const player = mockPlayer();
      // Simulate 4 existing struts at Y0_QUAD azimuths
      player.strutGroups = [
        { azRad: 60 * Math.PI / 180 },
        { azRad: 120 * Math.PI / 180 },
        { azRad: 240 * Math.PI / 180 },
        { azRad: 300 * Math.PI / 180 },
      ];
      tvm.init(mockScene(), player, mockArmManager());
      tvm._rebuildVisuals('Y1_HEX', 6);
      // Y1_HEX azimuths [30,90,150,210,270,330] — none match Y0 [60,120,240,300]
      // so all 6 should be added as new struts
      assert.equal(tvm._addedStruts.length, 6,
        'should add 6 new struts for Y1_HEX azimuths');
      tvm.dispose();
    });
  });
});
