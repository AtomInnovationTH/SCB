/**
 * test-InputManager-Hotkeys.js — hotkey cleanup tests.
 *
 * Recall-all moved to Shift+R ONLY (2026-06-12, plan item 7):
 *   • Shift+R          → emits ARM_RECALL_ALL
 *   • Shift+O          → no-op (recall-all branch removed)
 *   • O                → deploy-all unchanged
 *   • R (no shift)     → context chain unchanged (recall closest / abort AP)
 *
 * De-spin laser remap (2026-06-13, "H = Hold"):
 *   • H                → de-spin laser (no-target warning when nothing selected)
 *   • U                → inert (freed; was the de-spin laser)
 *
 * Hotkey cleanup 2026-06-13b (fewer keys):
 *   • Shift+D          → deploy-all-to-target (folded from the freed O key)
 *   • O                → inert (removed)
 *   • T                → emits TOOL_CYCLE (was TOOL_DEPLOY; Shift+` freed)
 *
 * Hotkey pane pass 2026-06-13c:
 *   • O                → toggle NavSphere (moved off Shift+N)
 *   • Shift+N          → no longer toggles NavSphere
 */
import { describe, it, assert } from './TestRunner.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { InputManager } from '../systems/InputManager.js';

function makeIM(overrides = {}) {
  const im = new InputManager();
  im._firstGestureHandled = true;     // skip audio unlock path (Node)
  const calls = {
    recallClosest: 0, deployAll: 0, navToggle: 0,
    targetCycle: 0, constellation: 0, debrisPane: 0, targetPane: 0,
  };
  im._deps = {
    gameState: { currentState: 'ORBITAL_VIEW', isGameplay: () => true },
    player: { getPosition: () => ({ x: 0, y: 0, z: 0 }), getOrbitalElements: () => ({}) },
    armManager: {
      arms: [],
      selectedArmIndex: -1,
      recallClosestDeployed: () => { calls.recallClosest++; return 0; },
      deployAllToTarget: () => { calls.deployAll++; },
    },
    targetSelector: { getActiveTarget: () => null, setTarget: () => {} },
    debrisField: {
      getEnhancedTargetList: () => { calls.targetCycle++; return []; },
      getDebrisById: () => null,
    },
    debrisWireframe: { setTarget: () => {}, toggleMinimized: () => { calls.debrisPane++; } },
    hud: { setSelectedTarget: () => {}, targetPanel: { toggleVisible: () => { calls.targetPane++; } } },
    navSphere: { toggle: () => { calls.navToggle++; }, toggleMinimized: () => { calls.navMin = (calls.navMin || 0) + 1; }, setSelectedTarget: () => {} },
    starfield: { toggleConstellations: () => { calls.constellation++; } },
    debrisMap: { isVisible: () => false, toggle: () => { calls.mapToggle = (calls.mapToggle || 0) + 1; }, engageSelectedCluster: () => { calls.cluster = (calls.cluster || 0) + 1; } },
    targetReticle: { setSelectedTarget: () => {} },
    sensorSystem: { canDetectUntracked: false },
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

describe('InputManager hotkeys — recall = Shift+R; de-spin laser = H (2026-06-13)', () => {
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

  it('H no longer recalls — it is the de-spin laser (2026-06-13)', () => {
    const { im, calls } = makeIM();
    const got = captureEvent(Events.ARM_RECALL_ALL, () => {
      im._handleKeyDown(key('KeyH'));
    });
    assert.equal(got.length, 0, 'H must not emit ARM_RECALL_ALL');
    assert.equal(calls.recallClosest, 0, 'H must not recall anything');
  });

  it('H with no target emits the de-spin warning (mother mode)', () => {
    let failClicks = 0;
    const { im } = makeIM({
      audioSystem: { playClick: () => {}, playClickFail: () => { failClicks++; } },
    });
    const got = captureEvent(Events.COMMS_MESSAGE, () => {
      im._handleKeyDown(key('KeyH'));
    });
    const warned = got.some(m => m && /de-spin/i.test(m.text || ''));
    assert.ok(warned, 'H with no target warns to select a tumbling target');
    assert.equal(failClicks, 1, 'H with no target plays the fail click');
  });

  it('U is now inert (freed — was the de-spin laser, now on H)', () => {
    let failClicks = 0;
    const { im, calls } = makeIM({
      audioSystem: { playClick: () => {}, playClickFail: () => { failClicks++; } },
    });
    const got = captureEvent(Events.COMMS_MESSAGE, () => {
      im._handleKeyDown(key('KeyU'));
    });
    assert.equal(got.length, 0, 'U emits no comms message');
    assert.equal(failClicks, 0, 'U plays no fail click');
    assert.equal(calls.recallClosest, 0, 'U recalls nothing');
  });

  it('Shift+O does not deploy-all or recall (O is freed in the revamp)', () => {
    const { im, calls } = makeIM();
    const got = captureEvent(Events.ARM_RECALL_ALL, () => {
      im._handleKeyDown(key('KeyO', { shiftKey: true }));
    });
    assert.equal(got.length, 0, 'Shift+O must not emit ARM_RECALL_ALL');
    assert.equal(calls.deployAll, 0, 'Shift+O must not deploy-all');
  });

  it('O is freed — no longer toggles the NavSphere (moved to 8, 2026-06-14)', () => {
    const { im, calls } = makeIM();
    im._handleKeyDown(key('KeyO'));
    assert.equal(calls.navToggle, 0, 'O must not toggle NavSphere anymore');
  });

  it('Digit8 minimizes the NavSphere to a lat/long/alt one-liner', () => {
    const { im, calls } = makeIM();
    im._handleKeyDown(key('Digit8'));
    assert.equal(calls.navMin, 1, '8 toggles the NavSphere minimized readout');
    assert.equal(calls.navToggle, 0, '8 does not full-hide the NavSphere');
  });

  it('Shift+N auto-targets + launches all (no NavSphere toggle)', () => {
    const { im, calls } = makeIM();
    im._handleKeyDown(key('KeyN', { shiftKey: true }));
    assert.equal(calls.navToggle, 0, 'Shift+N must not toggle NavSphere');
    // No debris in range (stub returns []) → deployAll is skipped, but the
    // target list was consulted (auto-acquire attempt).
    assert.equal(calls.targetCycle, 1, 'Shift+N consults the target list to auto-acquire');
  });

  it('Shift+D deploys all docked arms to target', () => {
    const { im, calls } = makeIM();
    im._handleKeyDown(key('KeyD', { shiftKey: true }));
    assert.equal(calls.deployAll, 1, 'Shift+D deploy-all');
  });

  it('Ctrl+Shift+D does NOT deploy-all (deorbit path)', () => {
    const { im, calls } = makeIM();
    const got = captureEvent(Events.ARM_DEORBIT_CMD, () => {
      im._handleKeyDown(key('KeyD', { shiftKey: true, ctrlKey: true }));
    });
    assert.equal(calls.deployAll, 0, 'Ctrl+Shift+D must not deploy-all');
    assert.equal(got.length, 1, 'Ctrl+Shift+D emits ARM_DEORBIT_CMD');
  });

  it('T = "Target debris" — cycles target, not TOOL_CYCLE (removed TOOL_DEPLOY gone)', () => {
    const { im, calls } = makeIM();
    assert.equal(Events.TOOL_DEPLOY, undefined, 'TOOL_DEPLOY constant must be removed');
    const cyc = captureEvent(Events.TOOL_CYCLE, () => {
      im._handleKeyDown(key('KeyT'));
    });
    assert.equal(cyc.length, 0, 'T must NOT emit TOOL_CYCLE anymore (it targets debris)');
    assert.equal(calls.targetCycle, 1, 'T cycles the target list (like Tab)');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Hotkey revamp 2026-06-14 — "spinning plates" daughter model:
//   • 1-4 is the single select/pilot verb (P / Shift+P removed & inert).
//   • Docked digit → SELECT only (glow), no deploy, no camera switch.
//   • Deployed digit → SELECT + pilot camera.
//   • Re-press the active digit → back out (exit pilot + deselect, NO recall).
//   • Q / E no longer thrust; Digit7 return-to-mother removed.
// ───────────────────────────────────────────────────────────────────────────

const ARM_STATES = {
  DOCKED: 'DOCKED', EXPENDED: 'EXPENDED', STATION_KEEP: 'STATION_KEEP',
  TRANSIT: 'TRANSIT',
};

function makeArm(state) {
  return {
    state, id: `arm-${state}`,
    enableManual() { this._manual = true; },
    disableManual() { this._manual = false; },
    setSelectedHighlight(on) { this._hl = !!on; },
  };
}

function makeArmIM(arms, overrides = {}) {
  const im = new InputManager();
  im._firstGestureHandled = true;
  const calls = {
    selectArm: [], deselectArm: 0, setPilotArm: [], clearPilotArm: 0,
    recallClosest: 0, recallAll: 0,
  };
  let piloted = null;
  const armManager = {
    arms,
    selectedArmIndex: -1,
    selectArm(i) {
      if (this.selectedArmIndex === i) { this.deselectArm(); return; }
      this.selectedArmIndex = i; calls.selectArm.push(i);
      if (arms[i]?.setSelectedHighlight) arms[i].setSelectedHighlight(true);
    },
    deselectArm() {
      this.selectedArmIndex = -1; calls.deselectArm++;
    },
    recallClosestDeployed() { calls.recallClosest++; return 0; },
  };
  im._deps = {
    gameState: { currentState: 'ORBITAL_VIEW', isGameplay: () => true },
    armManager,
    targetSelector: { getActiveTarget: () => null },
    audioSystem: { playClick() {}, playClickFail() {} },
    autopilotSystem: { engaged: false },
    cameraSystem: {
      getPilotedArm: () => piloted,
      setPilotArm: (a) => { piloted = a; calls.setPilotArm.push(a); },
      clearPilotArm: () => { piloted = null; calls.clearPilotArm++; },
    },
    ...overrides,
  };
  return { im, calls, armManager };
}

describe('InputManager hotkeys — daughter select/pilot (2026-06-14 revamp)', () => {
  it('digit on a DOCKED daughter selects only — no camera switch', () => {
    const arms = [makeArm(ARM_STATES.DOCKED)];
    const { im, calls } = makeArmIM(arms);
    im._handleKeyDown(key('Digit1'));
    assert.deepEqual(calls.selectArm, [0], 'docked digit selects index 0');
    assert.equal(calls.setPilotArm.length, 0, 'docked digit must NOT enter pilot camera');
    assert.equal(arms[0]._hl, true, 'docked daughter is highlighted (glow)');
    assert.equal(im.armPilotMode, false, 'docked select does not enter arm-pilot mode');
  });

  it('digit on a DEPLOYED daughter selects + pilots (camera follows)', () => {
    const arms = [makeArm(ARM_STATES.STATION_KEEP)];
    const { im, calls } = makeArmIM(arms);
    im._handleKeyDown(key('Digit1'));
    assert.deepEqual(calls.selectArm, [0], 'deployed digit selects index 0');
    assert.equal(calls.setPilotArm.length, 1, 'deployed digit enters pilot camera');
    assert.equal(im.armPilotMode, true, 'deployed select enters arm-pilot mode');
  });

  it('re-pressing the active digit backs out WITHOUT recalling', () => {
    const arms = [makeArm(ARM_STATES.STATION_KEEP)];
    const { im, calls } = makeArmIM(arms);
    im._handleKeyDown(key('Digit1'));   // select + pilot
    im._handleKeyDown(key('Digit1'));   // re-press → back out
    assert.equal(calls.clearPilotArm, 1, 're-press exits the pilot camera');
    assert.equal(calls.deselectArm, 1, 're-press deselects');
    assert.equal(calls.recallClosest, 0, 're-press must NOT recall the daughter');
    assert.equal(im.armPilotMode, false, 're-press leaves arm-pilot mode');
  });

  it('digit on an EXPENDED daughter warns, does not select or pilot', () => {
    const arms = [makeArm(ARM_STATES.EXPENDED)];
    const { im, calls } = makeArmIM(arms);
    const got = captureEvent(Events.COMMS_MESSAGE, () => {
      im._handleKeyDown(key('Digit1'));
    });
    assert.equal(calls.selectArm.length, 0, 'expended digit does not select');
    assert.equal(calls.setPilotArm.length, 0, 'expended digit does not pilot');
    assert.ok(got.some(m => /expended/i.test(m.text || '')), 'warns expended');
  });

  it('P and Shift+P are now inert (removed in the revamp)', () => {
    const arms = [makeArm(ARM_STATES.STATION_KEEP)];
    const { im, calls } = makeArmIM(arms);
    im._handleKeyDown(key('KeyP'));
    im._handleKeyDown(key('KeyP', { shiftKey: true }));
    assert.equal(calls.selectArm.length, 0, 'P does not select');
    assert.equal(calls.setPilotArm.length, 0, 'P does not enter pilot');
    assert.equal(im.armPilotMode, false, 'P does not toggle arm-pilot mode');
    assert.equal(typeof im._cyclePilotedArm, 'undefined', '_cyclePilotedArm removed');
  });

  it('Digit7 is "Comms" toggle now (not return-to-mother)', () => {
    const arms = [makeArm(ARM_STATES.STATION_KEEP)];
    const { im, calls } = makeArmIM(arms);
    im._handleKeyDown(key('Digit1'));   // pilot first
    const got = captureEvent(Events.COMMS_FOCUS, () => {
      im._handleKeyDown(key('Digit7'));
    });
    assert.equal(got.length, 1, 'Digit7 emits COMMS_FOCUS');
    assert.equal(calls.clearPilotArm, 0, 'Digit7 does not exit pilot');
    assert.equal(calls.deselectArm, 0, 'Digit7 does not deselect');
    assert.equal(im.armPilotMode, true, 'Digit7 leaves arm-pilot mode unchanged');
  });

  it('Q and E no longer feed daughter thrust (processInput ionDir.y stays 0)', () => {
    const arms = [makeArm(ARM_STATES.STATION_KEEP)];
    const thrusts = [];
    const { im } = makeArmIM(arms, {
      audioSystem: { playClick() {}, startThrusterHum() {}, stopThrusterHum() {}, playClickFail() {} },
    });
    im._handleKeyDown(key('Digit1'));   // enter arm-pilot
    im.keys['KeyQ'] = true;
    im.keys['KeyE'] = true;
    const got = captureEvent(Events.ARM_MANUAL_THRUST, () => im.processInput(0.016));
    thrusts.push(...got);
    // No WASD held → Q/E alone must produce no thrust command.
    assert.equal(thrusts.length, 0, 'Q/E alone emit no ARM_MANUAL_THRUST');
  });

  it('bare D launches the SELECTED docked daughter by index', () => {
    const arms = [makeArm(ARM_STATES.DOCKED), makeArm(ARM_STATES.DOCKED)];
    let deployArmAutoCalls = 0;
    const deployByIdx = [];
    const { im, armManager } = makeArmIM(arms, {
      deployArm: () => { deployArmAutoCalls++; },
    });
    armManager.deployArmByIndex = (i) => { deployByIdx.push(i); return true; };
    im._handleKeyDown(key('Digit2'));   // select docked arm index 1
    im._handleKeyDown(key('KeyD'));     // launch selected
    assert.deepEqual(deployByIdx, [1], 'D launches the selected docked arm by index');
    assert.equal(deployArmAutoCalls, 0, 'D does not fall back to auto-pick when a docked arm is selected');
  });

  it('bare D falls back to auto-pick when no docked arm is selected', () => {
    const arms = [makeArm(ARM_STATES.STATION_KEEP)];
    let deployArmAutoCalls = 0;
    const { im, armManager } = makeArmIM(arms, {
      deployArm: () => { deployArmAutoCalls++; },
    });
    armManager.deployArmByIndex = () => { throw new Error('should not be called'); };
    im._handleKeyDown(key('KeyD'));
    assert.equal(deployArmAutoCalls, 1, 'D auto-picks when nothing docked is selected');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Hotkey revamp 2026-06-14 — code matched to the help menu (single source of
// truth). Letter/number reassignments:
//   E=EDT (off Y) · F=Forge (off 5) · M=Map/debris (off MFD) · T=target ·
//   Shift+S=wide scan (off W) · 5=City names · 6=Constellation names ·
//   7=Comms · 8=NavSphere · 9=Debris pane · 0=Target pane · W/Y/O/Shift+C freed.
// ───────────────────────────────────────────────────────────────────────────
describe('InputManager hotkeys — help-menu remap (2026-06-14)', () => {
  it('E toggles the Electrodynamic Tether (moved off Y)', () => {
    const edt = captureEvent(Events.EDT_DEPLOY, () => {
      const { im } = makeIM();
      im._handleKeyDown(key('KeyE'));
    });
    assert.equal(edt.length, 1, 'E emits EDT_DEPLOY');
  });

  it('Y is freed — no longer toggles EDT', () => {
    const edt = captureEvent(Events.EDT_DEPLOY, () => {
      const { im } = makeIM();
      im._handleKeyDown(key('KeyY'));
    });
    assert.equal(edt.length, 0, 'Y must not emit EDT_DEPLOY anymore');
  });

  it('F toggles the Forge (moved off 5)', () => {
    const forge = captureEvent(Events.FORGE_TOGGLE, () => {
      const focus = captureEvent(Events.FOCUS_ACTION, () => {
        const { im } = makeIM();
        im._handleKeyDown(key('KeyF'));
      });
      assert.equal(focus.length, 0, 'F must not emit FOCUS_ACTION anymore');
    });
    assert.equal(forge.length, 1, 'F emits FORGE_TOGGLE');
  });

  it('M opens the Debris Map (off the MFD role)', () => {
    const { im, calls } = makeIM();
    im._handleKeyDown(key('KeyM'));
    assert.equal(calls.mapToggle, 1, 'M toggles the debris map');
  });

  it('Shift+S = wide scan; bare W is freed (no scan)', () => {
    const wide = captureEvent(Events.SCAN_WIDE, () => {
      const { im } = makeIM();
      im._handleKeyDown(key('KeyS', { shiftKey: true }));
    });
    assert.equal(wide.length, 1, 'Shift+S emits SCAN_WIDE');
    const wFromW = captureEvent(Events.SCAN_WIDE, () => {
      const { im } = makeIM();
      im._handleKeyDown(key('KeyW'));
    });
    assert.equal(wFromW.length, 0, 'bare W no longer wide-scans');
  });

  it('bare S still quick-scans', () => {
    const quick = captureEvent(Events.SCAN_QUICK, () => {
      const { im } = makeIM();
      im._handleKeyDown(key('KeyS'));
    });
    assert.equal(quick.length, 1, 'S emits SCAN_QUICK');
  });

  it('5 = City names, 6 = Constellation names', () => {
    const city = captureEvent(Events.CITY_LABELS_TOGGLE, () => {
      const { im } = makeIM();
      im._handleKeyDown(key('Digit5'));
    });
    assert.equal(city.length, 1, '5 toggles city labels');
    const { im, calls } = makeIM();
    im._handleKeyDown(key('Digit6'));
    assert.equal(calls.constellation, 1, '6 toggles constellation labels');
  });

  it('9 = Debris pane (minimize), 0 = Target pane', () => {
    const { im, calls } = makeIM();
    im._handleKeyDown(key('Digit9'));
    im._handleKeyDown(key('Digit0'));
    assert.equal(calls.debrisPane, 1, '9 minimizes the debris pane');
    assert.equal(calls.targetPane, 1, '0 toggles the target pane');
  });

  it('Shift+C is freed (no city-labels toggle — moved to 5)', () => {
    const city = captureEvent(Events.CITY_LABELS_TOGGLE, () => {
      const { im } = makeIM();
      im._handleKeyDown(key('KeyC', { shiftKey: true }));
    });
    assert.equal(city.length, 0, 'Shift+C must not toggle city labels anymore');
  });
});
