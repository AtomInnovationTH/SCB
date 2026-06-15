/**
 * test-CameraView.js — V-key view toggle tests (2026-06-15 2-cycle revamp)
 *
 * Verifies the V key toggles exactly two views (FLY ↔ LOOK AROUND), exposes the
 * friendly labels, wraps back to FLY from the legacy discrete INSPECTION view,
 * and drives the persistent-vs-fading view indicator badge.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { CameraSystem, CameraViews } from '../systems/CameraSystem.js';

// ─── DOM mocks for Node ────────────────────────────────────────────────────
if (typeof document === 'undefined') {
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ style: { cssText: '' }, textContent: '', id: '', appendChild: () => {} }),
  };
}

function mockCanvas() {
  return { addEventListener: () => {}, removeEventListener: () => {} };
}

function makeCameraSystem() {
  const camera = new THREE.PerspectiveCamera(55, 1, 0.001, 1000);
  return new CameraSystem(camera, mockCanvas());
}

/** Stub a minimal indicator element so badge behaviour is observable in Node. */
function stubIndicator(cs) {
  cs._viewIndicator = { style: { opacity: '0' }, textContent: '' };
  return cs._viewIndicator;
}

describe('CameraSystem — V toggles FLY ↔ LOOK AROUND (2-cycle)', () => {
  it('starts in FLY (CHASE)', () => {
    const cs = makeCameraSystem();
    assert.equal(cs.currentView, CameraViews.CHASE, 'default view should be CHASE (FLY)');
  });

  it('V toggles CHASE → ORBIT → CHASE (exactly two stops)', () => {
    const cs = makeCameraSystem();
    cs.cycleView();
    assert.equal(cs.currentView, CameraViews.ORBIT, 'first V → ORBIT (LOOK AROUND)');
    cs.cycleView();
    assert.equal(cs.currentView, CameraViews.CHASE, 'second V wraps back to CHASE (FLY)');
  });

  it('never lands on INSPECTION via the V cycle', () => {
    const cs = makeCameraSystem();
    for (let i = 0; i < 6; i++) {
      cs.cycleView();
      assert.notEqual(cs.currentView, CameraViews.INSPECTION,
        'INSPECTION must not be a V-cycle stop');
    }
  });

  it('exposes friendly labels', () => {
    const cs = makeCameraSystem();
    assert.equal(cs.getViewLabel(), '🛰 FLY', 'CHASE label should be "🛰 FLY"');
    cs.cycleView();
    assert.equal(cs.getViewLabel(), '🔭 LOOK AROUND', 'ORBIT label should be "🔭 LOOK AROUND"');
  });

  it('V from the legacy discrete INSPECTION view wraps back to FLY', () => {
    const cs = makeCameraSystem();
    cs.enterInspection('mother', null);
    assert.equal(cs.currentView, CameraViews.INSPECTION, 'enterInspection sets INSPECTION');
    cs.cycleView();
    assert.equal(cs.currentView, CameraViews.CHASE, 'V from INSPECTION returns to FLY');
  });
});

describe('CameraSystem — view indicator badge (anti-stuck guidance)', () => {
  it('FLY badge is non-persistent and fades after ~2.5s', () => {
    const cs = makeCameraSystem();
    stubIndicator(cs);
    cs._showViewIndicator(CameraViews.CHASE);
    assert.equal(cs._viewIndicatorPersistent, false, 'FLY badge should not be persistent');
    assert.ok(cs._viewIndicatorTimer > 0, 'FLY badge should arm a fade timer');
    assert.ok(cs._viewIndicator.textContent.includes('FLY'), 'badge names FLY');
  });

  it('LOOK AROUND badge is persistent with a "[V] to fly" return hint', () => {
    const cs = makeCameraSystem();
    stubIndicator(cs);
    cs._showViewIndicator(CameraViews.ORBIT);
    assert.equal(cs._viewIndicatorPersistent, true, 'LOOK AROUND badge should persist');
    assert.equal(cs._viewIndicatorTimer, 0, 'persistent badge should not arm a fade timer');
    assert.ok(cs._viewIndicator.textContent.includes('[V] to fly'),
      'off-default badge should show the return hint');
  });

  it('returning to FLY clears the persistent flag (badge fades again)', () => {
    const cs = makeCameraSystem();
    stubIndicator(cs);
    cs._showViewIndicator(CameraViews.ORBIT);
    assert.equal(cs._viewIndicatorPersistent, true, 'persistent while in LOOK AROUND');
    cs._showViewIndicator(CameraViews.CHASE);
    assert.equal(cs._viewIndicatorPersistent, false, 'cleared on return to FLY');
    assert.ok(cs._viewIndicatorTimer > 0, 'fade timer re-armed for FLY');
  });

  it('transition to ARM_PILOT clears a persistent LOOK AROUND badge', () => {
    const cs = makeCameraSystem();
    const ind = stubIndicator(cs);
    // Enter LOOK AROUND → persistent badge engaged.
    cs.setView(CameraViews.ORBIT);
    assert.equal(cs._viewIndicatorPersistent, true, 'persistent after LOOK AROUND');
    // Now pilot a daughter (ARM_PILOT skips the camera view indicator).
    cs.setView(CameraViews.ARM_PILOT);
    assert.equal(cs._viewIndicatorPersistent, false,
      'persistent flag cleared on ARM_PILOT transition');
    assert.equal(ind.style.opacity, '0',
      'stale LOOK AROUND badge hidden during piloting');
  });
});
