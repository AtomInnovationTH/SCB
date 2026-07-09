/**
 * test-DebrisField-MenuBackdrop.js — MENU backdrop debris boost store/restore.
 *
 * DebrisField.setMenuBackdropBoost(on) makes the faint background dust denser
 * behind the transparent menu, then restores the exact prior state on exit.
 * Restoring must re-apply whatever hidden state was active on entry — notably
 * the Mission-1 `backgroundPoints.visible = false` hide, which must survive a
 * boost→restore round-trip.
 *
 * Node-safe: uses a minimal mock backgroundPoints; calls the prototype method
 * via .call() so no full DebrisField (scene/catalog) is constructed.
 */
import { describe, it, assert } from './TestRunner.js';
import { DebrisField } from '../entities/DebrisField.js';

const boost = DebrisField.prototype.setMenuBackdropBoost;

// A minimal stand-in for the THREE.Points + PointsMaterial the method touches.
function mockField(visible) {
  return {
    backgroundPoints: {
      visible,
      material: { size: 0.0002, opacity: 0.6 },
    },
  };
}

describe('DebrisField.setMenuBackdropBoost — store/restore', () => {
  it('boosts visible/size/opacity on true', () => {
    const f = mockField(true);
    boost.call(f, true);
    assert.equal(f.backgroundPoints.visible, true, 'stays visible');
    assert.ok(Math.abs(f.backgroundPoints.material.size - 0.0004) < 1e-12, 'size doubled');
    assert.equal(f.backgroundPoints.material.opacity, 0.85, 'opacity boosted');
  });

  it('restores exact prior values on false', () => {
    const f = mockField(true);
    boost.call(f, true);
    boost.call(f, false);
    assert.equal(f.backgroundPoints.visible, true, 'visible restored');
    assert.ok(Math.abs(f.backgroundPoints.material.size - 0.0002) < 1e-12, 'size restored');
    assert.equal(f.backgroundPoints.material.opacity, 0.6, 'opacity restored');
  });

  it('re-applies Mission-1 hidden state (visible:false) on restore', () => {
    // Mission 1 hid the background points before the menu opened.
    const f = mockField(false);
    boost.call(f, true);
    assert.equal(f.backgroundPoints.visible, true, 'forced visible while boosted');
    boost.call(f, false);
    assert.equal(f.backgroundPoints.visible, false, 'Mission-1 hide restored automatically');
  });

  it('boost is idempotent — a second true does not overwrite the stored state', () => {
    const f = mockField(false);
    boost.call(f, true);
    boost.call(f, true);   // no-op: must NOT store the already-boosted size/opacity
    boost.call(f, false);
    assert.equal(f.backgroundPoints.visible, false, 'original hide restored');
    assert.ok(Math.abs(f.backgroundPoints.material.size - 0.0002) < 1e-12, 'original size restored');
    assert.equal(f.backgroundPoints.material.opacity, 0.6, 'original opacity restored');
  });

  it('restore without a prior boost is a no-op', () => {
    const f = mockField(true);
    boost.call(f, false);
    assert.equal(f.backgroundPoints.material.size, 0.0002, 'unchanged');
    assert.equal(f.backgroundPoints.material.opacity, 0.6, 'unchanged');
  });

  it('is a safe no-op when backgroundPoints is missing', () => {
    const f = {};
    boost.call(f, true);   // must not throw
    boost.call(f, false);
    assert.ok(true, 'no throw when backgroundPoints absent');
  });
});
