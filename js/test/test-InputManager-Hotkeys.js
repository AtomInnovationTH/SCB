/**
 * test-InputManager-Hotkeys.js — hotkey cleanup tests.
 *
 * Recall-all moved to Shift+R ONLY (2026-06-12, plan item 7):
 *   • Shift+R          → emits ARM_RECALL_ALL
 *   • Shift+O          → no-op (recall-all branch removed)
 *   • O                → deploy-all unchanged
 *   • R (no shift)     → context chain unchanged (recall closest / abort AP)
 *
 * De-spin laser remap (2026-06-15, laser H → L):
 *   • L                → de-spin laser (no-target warning when nothing selected)
 *   • I                → Info / Codex toggle (was L)
 *   • H                → inert (freed; the laser moved to L)
 *   • U                → inert (freed earlier; was the de-spin laser before H)
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

  it('bare R reels the closest daughter even while autopilot is engaged (reel wins over AP-abort)', () => {
    let disengaged = 0;
    const { im, calls } = makeIM({
      autopilotSystem: { engaged: true, disengage: () => { disengaged++; } },
    });
    // recallClosestDeployed() returns 0 (a valid index) → a daughter was reeled.
    im._handleKeyDown(key('KeyR'));
    assert.equal(calls.recallClosest, 1, 'R reels the closest daughter first');
    assert.equal(disengaged, 0, 'R does NOT abort the autopilot when a daughter was reeled');
  });

  it('bare R falls back to aborting autopilot only when there is nothing to reel', () => {
    let disengaged = 0;
    const { im, calls } = makeIM({
      armManager: {
        arms: [],
        selectedArmIndex: -1,
        // No deployed daughter → recallClosestDeployed returns null.
        recallClosestDeployed: () => { calls.recallClosest++; return null; },
        deployAllToTarget: () => { calls.deployAll++; },
      },
      autopilotSystem: { engaged: true, disengage: () => { disengaged++; } },
    });
    im._handleKeyDown(key('KeyR'));
    assert.equal(calls.recallClosest, 1, 'R attempts a reel first');
    assert.equal(disengaged, 1, 'R aborts autopilot only after finding nothing to reel');
  });

  it('L does not recall — it is the de-spin laser (2026-06-15)', () => {
    const { im, calls } = makeIM();
    const got = captureEvent(Events.ARM_RECALL_ALL, () => {
      im._handleKeyDown(key('KeyL'));
    });
    assert.equal(got.length, 0, 'L must not emit ARM_RECALL_ALL');
    assert.equal(calls.recallClosest, 0, 'L must not recall anything');
  });

  it('L with no target emits the de-spin warning (mother mode)', () => {
    let failClicks = 0;
    const { im } = makeIM({
      audioSystem: { playClick: () => {}, playClickFail: () => { failClicks++; } },
    });
    const got = captureEvent(Events.COMMS_MESSAGE, () => {
      im._handleKeyDown(key('KeyL'));
    });
    const warned = got.some(m => m && /de-spin/i.test(m.text || ''));
    assert.ok(warned, 'L with no target warns to select a tumbling target');
    assert.equal(failClicks, 1, 'L with no target plays the fail click');
  });

  it('H is now inert (freed — the de-spin laser moved to L in 2026-06-15)', () => {
    let failClicks = 0;
    const { im, calls } = makeIM({
      audioSystem: { playClick: () => {}, playClickFail: () => { failClicks++; } },
    });
    const got = captureEvent(Events.COMMS_MESSAGE, () => {
      im._handleKeyDown(key('KeyH'));
    });
    assert.equal(got.length, 0, 'H emits no comms message');
    assert.equal(failClicks, 0, 'H plays no fail click');
    assert.equal(calls.recallClosest, 0, 'H recalls nothing');
  });

  it('U is now inert (freed — was the de-spin laser before H, now on L)', () => {
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
// Reel-in fix (2026-06-14): R must reel in BOTH mother and daughter modes and
// must never be silent. Shift+R recall-all reports an honest count.
// ───────────────────────────────────────────────────────────────────────────
describe('InputManager hotkeys — reel-in works in both modes (2026-06-14 fix)', () => {
  it('R while piloting a daughter reels that daughter (even with AP engaged)', () => {
    let recalled = 0;
    const piloted = {
      id: 'arm-1', state: 'STATION_KEEP',
      recall: () => { recalled++; },
    };
    const { im } = makeIM({
      cameraSystem: { getPilotedArm: () => piloted },
      autopilotSystem: { engaged: true, disengage: () => {} },
    });
    im.armPilotMode = true;
    im._handleKeyDown(key('KeyR'));
    assert.equal(recalled, 1, 'piloted daughter is reeled home');
  });

  it('R while piloting with no live daughter emits a "no daughter" comms (never silent)', () => {
    const piloted = { id: 'arm-1', state: 'DOCKED', recall: () => {} };
    const { im } = makeIM({ cameraSystem: { getPilotedArm: () => piloted } });
    im.armPilotMode = true;
    const got = captureEvent(Events.COMMS_MESSAGE, () => {
      im._handleKeyDown(key('KeyR'));
    });
    assert.ok(got.some(m => /no daughter to reel/i.test(m.text || '')),
      'piloting a docked/expended daughter warns instead of going silent');
  });

  it('R in mother mode with nothing deployed and no AP still emits a comms (never silent)', () => {
    const { im } = makeIM({
      armManager: {
        arms: [], selectedArmIndex: -1,
        recallClosestDeployed: () => null,
        deployAllToTarget: () => {},
      },
      autopilotSystem: { engaged: false },
    });
    const got = captureEvent(Events.COMMS_MESSAGE, () => {
      im._handleKeyDown(key('KeyR'));
    });
    assert.ok(got.some(m => /no deployed daughters to reel/i.test(m.text || '')),
      'mother R with nothing to reel and no AP is not silent');
  });

  it('Shift+R uses recallAllDeployed and reports the count when present', () => {
    let allCount = 0;
    const { im } = makeIM({
      armManager: {
        arms: [], selectedArmIndex: -1,
        recallClosestDeployed: () => 0,
        deployAllToTarget: () => {},
        recallAllDeployed: () => { allCount++; return 3; },
      },
    });
    const recallAllEvt = captureEvent(Events.ARM_RECALL_ALL, () => {
      const comms = captureEvent(Events.COMMS_MESSAGE, () => {
        im._handleKeyDown(key('KeyR', { shiftKey: true }));
      });
      assert.ok(comms.some(m => /reeling in all daughters \(3\)/i.test(m.text || '')),
        'Shift+R reports the honest reel-all count');
    });
    assert.equal(allCount, 1, 'Shift+R calls recallAllDeployed exactly once');
    assert.equal(recallAllEvt.length, 0, 'Shift+R does not double-fire ARM_RECALL_ALL when recallAllDeployed exists');
  });

  it('Shift+R recall-all with nothing deployed reports "no deployed daughters" (never silent)', () => {
    const { im } = makeIM({
      armManager: {
        arms: [], selectedArmIndex: -1,
        recallClosestDeployed: () => 0,
        deployAllToTarget: () => {},
        recallAllDeployed: () => 0,
      },
    });
    const comms = captureEvent(Events.COMMS_MESSAGE, () => {
      im._handleKeyDown(key('KeyR', { shiftKey: true }));
    });
    assert.ok(comms.some(m => /no deployed daughters to reel/i.test(m.text || '')),
      'Shift+R with nothing out is not silent');
  });

  it('Shift+R falls back to ARM_RECALL_ALL when recallAllDeployed is unavailable', () => {
    const { im } = makeIM();   // stub armManager has no recallAllDeployed
    const recallAllEvt = captureEvent(Events.ARM_RECALL_ALL, () => {
      im._handleKeyDown(key('KeyR', { shiftKey: true }));
    });
    assert.equal(recallAllEvt.length, 1, 'legacy path still emits ARM_RECALL_ALL');
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

// ───────────────────────────────────────────────────────────────────────────
// Shift+A field-center salvage (2026-06-14 high-risk-salvage rework):
//   (1) autopilot the MOTHER to the field center (best cluster),
//   (2) fan EVERY docked daughter out to a DISTINCT debris,
//   (3) fire the MOTHER NET at a SEPARATE debris (not a daughter's target).
// ───────────────────────────────────────────────────────────────────────────
function makeSalvageIM(targetIds = [10, 11, 12, 13], dockedArms = 2) {
  const ARM_DOCKED = 'DOCKED';
  const im = new InputManager();
  im._firstGestureHandled = true;
  const calls = {
    engageBest: 0, engageSelected: 0, distinctTargets: null, distinctFallback: undefined,
    lassoFired: 0, netSetTargetId: null,
  };
  const arms = [];
  for (let i = 0; i < dockedArms; i++) arms.push({ state: ARM_DOCKED, springCharged: true });
  const enhanced = targetIds.map((id, i) => ({ id, tracked: true, distanceKm: i + 1, deltaV: i }));
  im._deps = {
    gameState: { currentState: 'ORBITAL_VIEW', isGameplay: () => true },
    player: { getPosition: () => ({ x: 0, y: 0, z: 0 }), getOrbitalElements: () => ({}), getVelocity: () => ({ x: 1, y: 0, z: 0 }) },
    debrisField: {
      getEnhancedTargetList: () => enhanced.slice(),
      getDebrisById: (id) => ({ id, type: 'debris' }),
    },
    armManager: {
      arms,
      deployAllToDistinctTargets: (t, fb) => { calls.distinctTargets = t; calls.distinctFallback = fb; return t.length; },
      deployAllToTarget: () => {},
    },
    debrisMap: {
      isVisible: () => false,
      engageBestCluster: () => { calls.engageBest++; return { id: 'c0' }; },
      engageSelectedCluster: () => { calls.engageSelected++; },
    },
    targetSelector: { getActiveTarget: () => null, setTarget: (debris) => { calls.netSetTargetId = debris ? debris.id : null; } },
    lassoSystem: { active: false, fire: () => {} },
    debrisWireframe: { setTarget: () => {} },
    hud: { setSelectedTarget: () => {} },
    targetReticle: { setSelectedTarget: () => {} },
    navSphere: { setSelectedTarget: () => {} },
    sensorSystem: { canDetectUntracked: false },
    audioSystem: { playClick: () => {}, playClickFail: () => {} },
  };
  // Count fireLasso() invocations without running the real windup timer.
  im.fireLasso = () => { calls.lassoFired++; };
  return { im, calls };
}

describe('InputManager — Shift+A field-center salvage (2026-06-14)', () => {
  it('autopilots the mother to the best cluster (field center)', () => {
    const { im, calls } = makeSalvageIM();
    im._handleKeyDown(key('KeyA', { shiftKey: true }));
    assert.equal(calls.engageBest, 1, 'Shift+A engages the best cluster (field center)');
    assert.equal(calls.engageSelected, 0, 'does not fall back to selected-cluster when engageBestCluster exists');
  });

  it('fans every docked daughter out to DISTINCT debris', () => {
    const { im, calls } = makeSalvageIM([10, 11, 12, 13], 2);
    im._handleKeyDown(key('KeyA', { shiftKey: true }));
    assert.ok(Array.isArray(calls.distinctTargets), 'deployAllToDistinctTargets called');
    assert.equal(calls.distinctTargets.length, 2, 'one distinct target per docked daughter');
    const ids = calls.distinctTargets.map(t => t.id);
    assert.deepEqual(ids, [10, 11], 'top-2 TPI debris assigned to the 2 daughters');
    assert.equal(new Set(ids).size, ids.length, 'targets are distinct');
  });

  it('fires the mother net at a SEPARATE debris not claimed by a daughter', () => {
    const { im, calls } = makeSalvageIM([10, 11, 12, 13], 2);
    im._handleKeyDown(key('KeyA', { shiftKey: true }));
    assert.equal(calls.lassoFired, 1, 'mother net fired once');
    // Daughters took ids 10 and 11 → net should target the next free one (12).
    assert.equal(calls.netSetTargetId, 12, 'mother net targets the first debris not assigned to a daughter');
  });

  it('falls back to engageSelectedCluster when engageBestCluster is unavailable', () => {
    const { im, calls } = makeSalvageIM();
    delete im._deps.debrisMap.engageBestCluster;
    im._handleKeyDown(key('KeyA', { shiftKey: true }));
    assert.equal(calls.engageSelected, 1, 'legacy DebrisMap path still engages a cluster');
  });

  it('plain A still toggles autopilot (no salvage combo)', () => {
    let toggles = 0;
    const { im, calls } = makeSalvageIM();
    im._deps.autopilotSystem = { toggle: () => { toggles++; }, engaged: false };
    im._handleKeyDown(key('KeyA'));
    assert.equal(toggles, 1, 'bare A toggles autopilot');
    assert.equal(calls.engageBest, 0, 'bare A does not run the salvage combo');
    assert.equal(calls.lassoFired, 0, 'bare A does not fire the net');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Help-pane coverage guard: every documented binding (HotkeyOverlay.HOTKEY_GROUPS)
// should still trigger its event / effect. These assertions are deliberately
// behavioral so a future re-bind that drifts from the help pane fails loudly.
// ───────────────────────────────────────────────────────────────────────────
function makeFullIM(overrides = {}) {
  const im = new InputManager();
  im._firstGestureHandled = true;
  const calls = {
    cycleView: 0, viewLockedId: undefined, mapToggle: 0, codexToggle: 0,
    hotkeyToggle: 0, detachIndex: null, exitInspection: 0, shopState: null,
    rosaFurlToggles: 0, rosaFeatherToggles: 0,
  };
  im._deps = {
    gameState: { currentState: 'ORBITAL_VIEW', isGameplay: () => true },
    player: {
      getPosition: () => ({ x: 0, y: 0, z: 0 }), getOrbitalElements: () => ({}),
      getVelocity: () => ({ x: 1, y: 0, z: 0 }),
      toggleRosaFurl: () => { calls.rosaFurlToggles++; return 0; },
      toggleRosaFeather: () => { calls.rosaFeatherToggles++; return true; },
    },
    armManager: {
      arms: [], selectedArmIndex: -1,
      getActiveDetachCandidate: () => ({ index: 2 }),
      detachArm: (i) => { calls.detachIndex = i; return true; },
    },
    targetSelector: { getActiveTarget: () => null, setTarget: () => {} },
    debrisField: { getEnhancedTargetList: () => [], getDebrisById: () => null },
    debrisWireframe: { setTarget: () => {} },
    hud: { setSelectedTarget: () => {}, showPause: () => {}, hidePause: () => {} },
    cameraSystem: {
      currentView: 'COMMAND', getPilotedArm: () => null,
      cycleView: (id) => { calls.cycleView++; calls.viewLockedId = id; },
      exitInspection: () => { calls.exitInspection++; },
    },
    debrisMap: { isVisible: () => false, toggle: () => { calls.mapToggle++; } },
    codexViewerUI: { isVisible: () => false, toggle: () => { calls.codexToggle++; } },
    hotkeyOverlay: { isVisible: () => false, toggle: () => { calls.hotkeyToggle++; } },
    strategicMap: { isOpen: () => false },
    lassoSystem: { active: false, fire: () => {} },
    sensorSystem: { canDetectUntracked: false },
    audioSystem: { playClick: () => {}, playClickFail: () => {} },
    autopilotSystem: { engaged: false },
    transitionToState: (s) => { calls.shopState = s; },
    setPaused: () => {}, getPaused: () => false, setLastTime: () => {},
    ...overrides,
  };
  return { im, calls };
}

describe('InputManager — help-pane binding coverage guard', () => {
  it('V cycles the camera view (Mother + Daughter "View")', () => {
    const { im, calls } = makeFullIM();
    im._handleKeyDown(key('KeyV'));
    assert.equal(calls.cycleView, 1, 'V cycles the view');
  });

  it('Shift+V toggles the strategic map ("View big picture")', () => {
    const got = captureEvent(Events.STRATEGIC_MAP_TOGGLE, () => {
      const { im } = makeFullIM();
      im._handleKeyDown(key('KeyV', { shiftKey: true }));
    });
    assert.equal(got.length, 1, 'Shift+V emits STRATEGIC_MAP_TOGGLE');
  });

  it('N in mother mode fires the lasso/net ("Net launch")', () => {
    const { im } = makeFullIM();
    let fired = 0;
    im.fireLasso = () => { fired++; };
    im._handleKeyDown(key('KeyN'));
    assert.equal(fired, 1, 'N fires the mother net');
  });

  it('B opens the shop ("Buy")', () => {
    const { im, calls } = makeFullIM();
    im._handleKeyDown(key('KeyB'));
    assert.equal(calls.shopState, 'SHOP', 'B transitions to SHOP');
  });

  it('I toggles the codex Info viewer', () => {
    const { im, calls } = makeFullIM();
    im._handleKeyDown(key('KeyI'));
    assert.equal(calls.codexToggle, 1, 'I toggles the codex');
  });

  it('I opens the codex from a non-gameplay screen (menu/paused/win)', () => {
    // Phase 3: the Tech Library is reference material, openable from ANY
    // screen — not gated behind isGameplay(). Simulate a non-gameplay state.
    const { im, calls } = makeFullIM({
      gameState: { currentState: 'MAIN_MENU', isGameplay: () => false },
    });
    im._handleKeyDown(key('KeyI'));
    assert.equal(calls.codexToggle, 1, 'I toggles the codex even off the gameplay screen');
  });

  it('? (Slash) toggles the hotkey help overlay', () => {
    const { im, calls } = makeFullIM();
    im._handleKeyDown(key('Slash'));
    assert.equal(calls.hotkeyToggle, 1, '? toggles the help overlay');
  });

  it('Esc pauses from ORBITAL_VIEW ("Pause / back")', () => {
    let paused = null;
    const { im } = makeFullIM({ getPaused: () => false, setPaused: (v) => { paused = v; } });
    im._handleKeyDown(key('Escape'));
    assert.equal(paused, true, 'Esc pauses gameplay');
  });

  it('X detaches the active tether candidate ("Tether detach")', () => {
    const { im, calls } = makeFullIM();
    im._handleKeyDown(key('KeyX'));
    assert.equal(calls.detachIndex, 2, 'X detaches the active candidate by index');
  });

  it('. (Period) toggles struts ("toggle: Struts")', () => {
    const got = captureEvent(Events.STRUT_DEPLOY_INPUT, () => {
      const { im } = makeFullIM({
        armManager: { arms: [{ state: 'DOCKED', _strutTargetAlpha: 0 }] },
      });
      im._handleKeyDown(key('Period'));
    });
    assert.equal(got.length, 1, 'Period drives the strut toggle');
  });

  it(', (Comma) toggles ROSA panel furl ("toggle: Panels")', () => {
    const got = captureEvent(Events.ROSA_FURL_INPUT, () => {
      const { im, calls } = makeFullIM();
      im._handleKeyDown(key('Comma'));
      assert.equal(calls.rosaFurlToggles, 1, 'Comma calls player.toggleRosaFurl');
    });
    assert.equal(got.length, 1, 'Comma emits ROSA_FURL_INPUT exactly once');
  });

  it(', (Comma) drives Debris Map "previous" when the map is open (no furl)', () => {
    let prevs = 0;
    const got = captureEvent(Events.ROSA_FURL_INPUT, () => {
      const { im, calls } = makeFullIM({
        debrisMap: { isVisible: () => true, selectPrev: () => { prevs++; }, toggle: () => {} },
      });
      im._handleKeyDown(key('Comma'));
      assert.equal(prevs, 1, 'Comma navigates the map');
      assert.equal(calls.rosaFurlToggles, 0, 'no furl while map is open');
    });
    assert.equal(got.length, 0, 'no ROSA_FURL_INPUT while map is open');
  });

  it('Shift+, (Comma) feathers ROSA instead of furling ("toggle: Feather panels")', () => {
    const got = captureEvent(Events.ROSA_FEATHER_INPUT, () => {
      const { im, calls } = makeFullIM();
      const furlEvt = captureEvent(Events.ROSA_FURL_INPUT, () => {
        im._handleKeyDown(key('Comma', { shiftKey: true }));
      });
      assert.equal(calls.rosaFeatherToggles, 1, 'Shift+Comma calls player.toggleRosaFeather');
      assert.equal(calls.rosaFurlToggles, 0, 'Shift+Comma does NOT furl');
      assert.equal(furlEvt.length, 0, 'Shift+Comma emits no ROSA_FURL_INPUT');
    });
    assert.equal(got.length, 1, 'Shift+Comma emits ROSA_FEATHER_INPUT exactly once');
  });

  it('L is the de-spin "Hold steady" laser (no recall)', () => {
    const got = captureEvent(Events.ARM_RECALL_ALL, () => {
      const { im } = makeFullIM();
      im._handleKeyDown(key('KeyL'));
    });
    assert.equal(got.length, 0, 'L does not recall — it is the de-spin laser');
  });
});
