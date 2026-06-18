/**
 * test-AutoLockController.js — front-arc autolock + net-range tracking.
 * (.kilo/plans/new-player-onboarding-flow.md Phase 1)
 *
 * @module test/test-AutoLockController
 */

import { describe, it, assert } from './TestRunner.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { AutoLockController } from '../systems/AutoLockController.js';
import { targetSelector } from '../systems/TargetSelector.js';

const M = Constants.SCENE_SCALE / 1000; // metres → scene units

// A player at origin moving +X (prograde/forward = +X).
function mockPlayer() {
  return {
    getPosition: () => ({ x: 0, y: 0, z: 0 }),
    getVelocity: () => ({ x: 1, y: 0, z: 0 }),
  };
}

// debrisField returning a fixed candidate list; getDebrisById echoes by id.
function mockField(list) {
  return {
    getDebrisNear: () => list,
    getDebrisById: (id) => list.find(d => d.id === id) || null,
  };
}

function debrisAt(id, xM, { alive = true } = {}) {
  return {
    id, alive, _captured: false,
    _scenePosition: { x: xM * M, y: 0, z: 0 },
    distance: Math.abs(xM) * M,
    orbit: { semiMajorAxis: 1, eccentricity: 0, inclination: 0, raan: 0, argPerigee: 0, trueAnomaly: 0, meanMotion: 0 },
  };
}

describe('AutoLockController — front-arc acquisition', () => {
  it('auto-selects the nearest forward in-range debris', () => {
    eventBus.clear();
    targetSelector.reset();
    const ctrl = new AutoLockController({
      player: mockPlayer(),
      debrisField: mockField([debrisAt(1, 40), debrisAt(2, 70)]),
    });
    ctrl.update(0.016);
    const t = targetSelector.getActiveTarget();
    assert.ok(t, 'a target was auto-selected');
    assert.equal(t.id, 1, 'nearest forward candidate picked');
    ctrl.dispose();
    targetSelector.reset();
  });

  it('ignores debris behind the player (outside the forward arc)', () => {
    eventBus.clear();
    targetSelector.reset();
    const ctrl = new AutoLockController({
      player: mockPlayer(),
      debrisField: mockField([debrisAt(9, -40)]), // behind (−X)
    });
    ctrl.update(0.016);
    assert.equal(targetSelector.getActiveTarget(), null, 'nothing locked behind the ship');
    ctrl.dispose();
    targetSelector.reset();
  });

  it('does not acquire when disabled', () => {
    eventBus.clear();
    targetSelector.reset();
    const ctrl = new AutoLockController({
      player: mockPlayer(),
      debrisField: mockField([debrisAt(1, 40)]),
    });
    ctrl.setEnabled(false);
    ctrl.update(0.016);
    assert.equal(targetSelector.getActiveTarget(), null);
    ctrl.dispose();
    targetSelector.reset();
  });
});

describe('AutoLockController — range crossing events', () => {
  it('emits TARGET_IN_RANGE for an in-range selected target', () => {
    eventBus.clear();
    targetSelector.reset();
    const inRange = [];
    eventBus.on(Events.TARGET_IN_RANGE, (d) => inRange.push(d));
    const ctrl = new AutoLockController({
      player: mockPlayer(),
      debrisField: mockField([debrisAt(1, 40)]), // 40 m < 90 m lock range
    });
    ctrl.update(0.016); // acquires id 1
    ctrl.update(0.016); // tracks range → IN_RANGE
    assert.ok(inRange.length >= 1, 'TARGET_IN_RANGE fired');
    assert.equal(inRange[0].id, 1);
    ctrl.dispose();
    targetSelector.reset();
  });

  it('emits TARGET_OUT_OF_RANGE for a far selected target', () => {
    eventBus.clear();
    targetSelector.reset();
    const outOfRange = [];
    eventBus.on(Events.TARGET_OUT_OF_RANGE, (d) => outOfRange.push(d));
    const ctrl = new AutoLockController({
      player: mockPlayer(),
      debrisField: mockField([debrisAt(1, 160)]), // 160 m > 90 m lock range
    });
    ctrl.update(0.016); // acquires id 1
    ctrl.update(0.016); // tracks range → OUT_OF_RANGE
    assert.ok(outOfRange.length >= 1, 'TARGET_OUT_OF_RANGE fired');
    assert.equal(outOfRange[0].id, 1);
    ctrl.dispose();
    targetSelector.reset();
  });
});

describe('AutoLockController — manual override', () => {
  it('a manual TARGET_SELECTED suppresses autolock reacquire', () => {
    eventBus.clear();
    targetSelector.reset();
    const ctrl = new AutoLockController({
      player: mockPlayer(),
      debrisField: mockField([debrisAt(1, 40)]),
    });
    // Simulate a manual selection (no autoLock flag), then clear it.
    eventBus.emit(Events.TARGET_SELECTED, { id: 99 });
    targetSelector.reset(); // active target null again
    ctrl.update(0.016);
    assert.equal(targetSelector.getActiveTarget(), null, 'autolock stays hands-off after manual override');
    ctrl.dispose();
    targetSelector.reset();
  });
});
