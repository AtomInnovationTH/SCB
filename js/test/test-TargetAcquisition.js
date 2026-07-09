/**
 * test-TargetAcquisition.js — unified scan auto-select helper.
 * (.kilo/plans/1783473856741-scan-auto-select-target.md)
 *
 * Covers:
 *   (a) fill-only: no selection change when a target is already active;
 *   (b) picks eligible[0] honoring the tracked/IR filter;
 *   (c) SCAN_REVEALS_SETTLED with an empty pane list → no selection, no hint;
 *   (d) the setTarget context carries autoAcquire:true + _suppressLockSound:true;
 *   (e) verb hint branches on NET_LOCK_RANGE_M and respects cooldown / minimal gating.
 *
 * @module test/test-TargetAcquisition
 */

import { describe, it, assert } from './TestRunner.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { TargetAcquisition } from '../systems/TargetAcquisition.js';
import { targetSelector } from '../systems/TargetSelector.js';

// ── MOCK FACTORIES ──────────────────────────────────────────────────────────

function mockPlayer() {
  return {
    getPosition: () => ({ x: 0, y: 0, z: 0 }),
    getOrbitalElements: () => ({ semiMajorAxis: 1 }),
  };
}

/**
 * DebrisField mock: getEnhancedTargetList returns the given list; getDebrisById
 * resolves a debris object by id (with a _scenePosition proportional to distance).
 */
function mockField(list) {
  return {
    getEnhancedTargetList: () => list.map(e => ({ ...e })),
    getDebrisById: (id) => {
      const e = list.find(x => x.id === id);
      if (!e) return null;
      return {
        id: e.id,
        type: e.type || 'fragment',
        alive: true,
        discovered: true,
        _scenePosition: { x: (e.distanceKm || 0) * Constants.SCENE_SCALE, y: 0, z: 0 },
      };
    },
  };
}

function entry(id, distanceKm, { tracked = true, type = 'fragment', deltaV = 10 } = {}) {
  return { id, distanceKm, tracked, type, deltaV };
}

function mockSkills({ canFire = true } = {}) {
  const noted = [];
  return {
    canFireHint: () => canFire,
    noteNudgeShown: (skillId) => noted.push(skillId),
    _noted: noted,
  };
}

function mockGuidance({ minimal = false } = {}) {
  return { isMinimal: () => minimal };
}

function makeTA(opts = {}) {
  eventBus.clear();
  targetSelector.reset();
  const ta = new TargetAcquisition();
  ta.init({
    player: opts.player || mockPlayer(),
    debrisField: opts.debrisField || mockField([]),
    sensorSystem: opts.sensorSystem || { canDetectUntracked: false },
    targetSelector,
    hud: opts.hud || null,
    targetReticle: opts.targetReticle || null,
    navSphere: opts.navSphere || null,
    debrisWireframe: opts.debrisWireframe || null,
    skillsSystem: opts.skillsSystem || mockSkills(),
    guidanceDirector: opts.guidanceDirector || mockGuidance(),
  });
  return ta;
}

// ── (b) picks eligible[0], honors tracked/IR filter ─────────────────────────

describe('TargetAcquisition — eligible list + acquire', () => {
  it('picks eligible[0] and selects it', () => {
    const ta = makeTA({ debrisField: mockField([entry(1, 5), entry(2, 50)]) });
    const debris = ta.acquireBestTarget({ source: 'test' });
    assert.ok(debris, 'a debris was acquired');
    assert.equal(debris.id, 1, 'nearest/best-ranked entry chosen');
    assert.equal(targetSelector.getActiveTarget().id, 1);
    ta.dispose();
    targetSelector.reset();
  });

  it('filters out untracked debris when IR scanner is inactive', () => {
    const ta = makeTA({
      debrisField: mockField([entry(1, 5, { tracked: false }), entry(2, 50, { tracked: true })]),
      sensorSystem: { canDetectUntracked: false },
    });
    const eligible = ta.getEligibleTargets();
    assert.equal(eligible.length, 1, 'untracked entry filtered out');
    assert.equal(eligible[0].id, 2);
    const debris = ta.acquireBestTarget();
    assert.equal(debris.id, 2, 'picks the tracked entry');
    ta.dispose();
    targetSelector.reset();
  });

  it('includes untracked debris when IR scanner is active', () => {
    const ta = makeTA({
      debrisField: mockField([entry(1, 5, { tracked: false })]),
      sensorSystem: { canDetectUntracked: true },
    });
    const eligible = ta.getEligibleTargets();
    assert.equal(eligible.length, 1, 'untracked entry included under IR');
    ta.dispose();
    targetSelector.reset();
  });

  it('returns null when the eligible list is empty', () => {
    const ta = makeTA({ debrisField: mockField([]) });
    assert.equal(ta.acquireBestTarget(), null);
    assert.equal(targetSelector.getActiveTarget(), null);
    ta.dispose();
    targetSelector.reset();
  });
});

// ── (d) context flags on setTarget ──────────────────────────────────────────

describe('TargetAcquisition — setTarget context', () => {
  it('carries autoAcquire:true and _suppressLockSound:true', () => {
    const ta = makeTA({ debrisField: mockField([entry(1, 5)]) });
    let payload = null;
    eventBus.on(Events.TARGET_SELECTED, (d) => { payload = d; });
    ta.acquireBestTarget({ source: 'scan' });
    assert.ok(payload, 'TARGET_SELECTED emitted');
    assert.equal(payload.autoAcquire, true, 'autoAcquire flag set');
    assert.equal(payload._suppressLockSound, true, 'lock sound suppressed');
    assert.equal(payload.source, 'scan', 'context source forwarded');
    ta.dispose();
    targetSelector.reset();
  });

  it('syncs HUD / reticle / navSphere / wireframe consumers', () => {
    const hud = { _id: null, setSelectedTarget: (id) => { hud._id = id; } };
    const reticle = { _id: null, setSelectedTarget: (id) => { reticle._id = id; } };
    const navSphere = { _id: null, setSelectedTarget: (id) => { navSphere._id = id; } };
    const wireframe = { _t: null, setTarget: (d) => { wireframe._t = d; } };
    const ta = makeTA({
      debrisField: mockField([entry(7, 5)]),
      hud, targetReticle: reticle, navSphere, debrisWireframe: wireframe,
    });
    ta.acquireBestTarget();
    assert.equal(hud._id, 7);
    assert.equal(reticle._id, 7);
    assert.equal(navSphere._id, 7);
    assert.ok(wireframe._t && wireframe._t.id === 7);
    ta.dispose();
    targetSelector.reset();
  });
});

// ── (a) fill-only + (c) empty-pane no-op ────────────────────────────────────

describe('TargetAcquisition — scan auto-select (SCAN_REVEALS_SETTLED)', () => {
  it('fills selection when nothing is active', () => {
    const ta = makeTA({ debrisField: mockField([entry(3, 5)]) });
    eventBus.emit(Events.SCAN_REVEALS_SETTLED, { revealed: 1, scanType: 'quick' });
    assert.ok(targetSelector.getActiveTarget(), 'selection filled by scan');
    assert.equal(targetSelector.getActiveTarget().id, 3);
    ta.dispose();
    targetSelector.reset();
  });

  it('fill-only: does not stomp a live selection', () => {
    const ta = makeTA({ debrisField: mockField([entry(3, 5), entry(4, 8)]) });
    // Pre-select a different target (simulate a manual pick).
    targetSelector.setTarget({ id: 99, type: 'defunctSat', alive: true, discovered: true });
    eventBus.emit(Events.SCAN_REVEALS_SETTLED, { revealed: 2, scanType: 'quick' });
    assert.equal(targetSelector.getActiveTarget().id, 99, 'live selection untouched');
    ta.dispose();
    targetSelector.reset();
  });

  it('empty pane → no selection and no verb hint', () => {
    const hints = [];
    const ta = makeTA({ debrisField: mockField([]) });
    eventBus.on(Events.HINT_POSTED, (d) => hints.push(d));
    eventBus.emit(Events.SCAN_REVEALS_SETTLED, { revealed: 0, scanType: 'quick' });
    assert.equal(targetSelector.getActiveTarget(), null, 'nothing selected');
    assert.equal(hints.length, 0, 'no verb hint posted');
    ta.dispose();
    targetSelector.reset();
  });
});

// ── (e) verb hint branching + gating ────────────────────────────────────────

describe('TargetAcquisition — context-aware verb hint', () => {
  function hintCase(distanceKm, opts = {}) {
    const hints = [];
    const comms = [];
    const ta = makeTA({
      debrisField: mockField([entry(1, distanceKm, { type: 'defunctSat' })]),
      skillsSystem: opts.skills || mockSkills(),
      guidanceDirector: opts.guidance || mockGuidance(),
    });
    eventBus.on(Events.HINT_POSTED, (d) => hints.push(d));
    eventBus.on(Events.COMMS_MESSAGE, (d) => comms.push(d));
    eventBus.emit(Events.SCAN_REVEALS_SETTLED, { revealed: 1, scanType: 'quick' });
    return { ta, hints, comms };
  }

  it('in net range → N/D verb hint', () => {
    // 90 m lock range → 0.05 km is comfortably in range.
    const { ta, hints, comms } = hintCase(0.05);
    assert.equal(hints.length, 1, 'one verb hint chip posted');
    assert.deepEqual(hints[0].keys, ['KeyN', 'KeyD'], 'in-range keys');
    assert.equal(hints[0].skillId, 'collect_lasso');
    assert.ok(comms.some(c => c.sender === 'V5' && /\[N\] net/.test(c.text)), 'V5 net comms');
    ta.dispose();
    targetSelector.reset();
  });

  it('out of net range → A verb hint', () => {
    const { ta, hints, comms } = hintCase(10);
    assert.equal(hints.length, 1);
    assert.deepEqual(hints[0].keys, ['KeyA'], 'out-of-range key');
    assert.equal(hints[0].skillId, 'nav_autopilot');
    assert.ok(comms.some(c => c.sender === 'V5' && /\[A\]/.test(c.text)), 'V5 autopilot comms');
    ta.dispose();
    targetSelector.reset();
  });

  it('minimal guidance suppresses the verb hint (selection still happens)', () => {
    const { ta, hints } = hintCase(0.05, { guidance: mockGuidance({ minimal: true }) });
    assert.equal(hints.length, 0, 'no hint under minimal guidance');
    assert.ok(targetSelector.getActiveTarget(), 'selection still occurred');
    ta.dispose();
    targetSelector.reset();
  });

  it('canFireHint=false suppresses the verb hint', () => {
    const { ta, hints } = hintCase(0.05, { skills: mockSkills({ canFire: false }) });
    assert.equal(hints.length, 0, 'gated off by skills system');
    ta.dispose();
    targetSelector.reset();
  });

  it('cooldown: a second scan within the window posts no second hint', () => {
    const hints = [];
    const ta = makeTA({ debrisField: mockField([entry(1, 0.05, { type: 'defunctSat' })]) });
    eventBus.on(Events.HINT_POSTED, (d) => hints.push(d));
    eventBus.emit(Events.SCAN_REVEALS_SETTLED, { revealed: 1, scanType: 'quick' });
    assert.equal(hints.length, 1, 'first hint posted');
    // Clear the selection so the fill-only guard doesn't short-circuit us,
    // then re-fire immediately — the module-local cooldown must swallow it.
    targetSelector.reset();
    eventBus.emit(Events.SCAN_REVEALS_SETTLED, { revealed: 1, scanType: 'quick' });
    assert.equal(hints.length, 1, 'second hint suppressed by cooldown');
    ta.dispose();
    targetSelector.reset();
  });
});
