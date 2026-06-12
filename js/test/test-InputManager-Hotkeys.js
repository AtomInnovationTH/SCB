/**
 * test-InputManager-Hotkeys.js — hotkey cleanup (2026-06-12, plan item 7).
 *
 * Recall-all moved to Shift+R ONLY:
 *   • Shift+R          → emits ARM_RECALL_ALL
 *   • H                → no-op (freed, reserved)
 *   • Shift+O          → no-op (recall-all branch removed)
 *   • O                → deploy-all unchanged
 *   • R (no shift)     → context chain unchanged (recall closest / abort AP)
 */
import { describe, it, assert } from './TestRunner.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { InputManager } from '../systems/InputManager.js';

function makeIM(overrides = {}) {
  const im = new InputManager();
  im._firstGestureHandled = true;     // skip audio unlock path (Node)
  const calls = { recallClosest: 0, deployAll: 0 };
  im._deps = {
    gameState: { currentState: 'ORBITAL_VIEW', isGameplay: () => true },
    armManager: {
      recallClosestDeployed: () => { calls.recallClosest++; return 0; },
      deployAllToTarget: () => { calls.deployAll++; },
    },
    targetSelector: { getActiveTarget: () => null },
    audioSystem: { playClick: () => {}, playClickFail: () => {} },
    autopilotSystem: { engaged: false },
    cameraSystem: { getPilotedArm: () => null },
    ...overrides,
  };
  return { im, calls };
}

function key(code, opts = {}) {
  return {
    code,
    shiftKey: false, ctrlKey: false, metaKey: false, repeat: false,
    target: null,
    preventDefault: () => {},
    ...opts,
  };
}

function captureEvent(evt, fn) {
  const got = [];
  const h = (d) => got.push(d);
  eventBus.on(evt, h);
  try { fn(); } finally { eventBus.off(evt, h); }
  return got;
}

describe('InputManager hotkeys — recall-all = Shift+R only (2026-06-12)', () => {
  it('Shift+R emits ARM_RECALL_ALL', () => {
    const { im } = makeIM();
    const got = captureEvent(Events.ARM_RECALL_ALL, () => {
      im._handleKeyDown(key('KeyR', { shiftKey: true }));
    });
    assert.equal(got.length, 1, 'Shift+R emits ARM_RECALL_ALL exactly once');
  });

  it('Shift+R does NOT run the bare-R context chain', () => {
    const { im, calls } = makeIM();
    im._handleKeyDown(key('KeyR', { shiftKey: true }));
    assert.equal(calls.recallClosest, 0, 'recallClosestDeployed must not fire on Shift+R');
  });

  it('bare R still recalls the closest deployed daughter', () => {
    const { im, calls } = makeIM();
    const got = captureEvent(Events.ARM_RECALL_ALL, () => {
      im._handleKeyDown(key('KeyR'));
    });
    assert.equal(got.length, 0, 'bare R must not recall all');
    assert.equal(calls.recallClosest, 1, 'bare R recalls closest');
  });

  it('bare R aborts an engaged autopilot before recalling', () => {
    let disengaged = 0;
    const { im, calls } = makeIM({
      autopilotSystem: { engaged: true, disengage: () => { disengaged++; } },
    });
    im._handleKeyDown(key('KeyR'));
    assert.equal(disengaged, 1, 'R aborts autopilot');
    assert.equal(calls.recallClosest, 0, 'AP abort takes precedence over recall');
  });

  it('H emits nothing (freed key, reserved)', () => {
    const { im, calls } = makeIM();
    const got = captureEvent(Events.ARM_RECALL_ALL, () => {
      im._handleKeyDown(key('KeyH'));
    });
    assert.equal(got.length, 0, 'H must not emit ARM_RECALL_ALL');
    assert.equal(calls.recallClosest, 0, 'H must not recall anything');
  });

  it('Shift+O emits nothing (recall-all branch removed)', () => {
    const { im, calls } = makeIM();
    const got = captureEvent(Events.ARM_RECALL_ALL, () => {
      im._handleKeyDown(key('KeyO', { shiftKey: true }));
    });
    assert.equal(got.length, 0, 'Shift+O must not emit ARM_RECALL_ALL');
    assert.equal(calls.deployAll, 0, 'Shift+O must not deploy-all either');
  });

  it('bare O still deploys all docked arms', () => {
    const { im, calls } = makeIM();
    im._handleKeyDown(key('KeyO'));
    assert.equal(calls.deployAll, 1, 'O deploy-all unchanged');
  });
});
