/**
 * test-GuidanceDirector.js — graduated guidance + behavior-driven auto-tuning.
 * (.kilo/plans/new-player-onboarding-flow.md §D.1 / §D.5)
 *
 * @module test/test-GuidanceDirector
 */

import { describe, it, assert } from './TestRunner.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GuidanceDirector, GuidanceLevels } from '../systems/GuidanceDirector.js';

describe('GuidanceDirector — seeding', () => {
  it('defaults to GUIDED for a new player (no skills system)', () => {
    eventBus.clear();
    const g = new GuidanceDirector({});
    assert.equal(g.getLevel(), GuidanceLevels.GUIDED);
    g.dispose();
  });

  it('seeds MINIMAL for a veteran', () => {
    eventBus.clear();
    const g = new GuidanceDirector({ skillsSystem: { isVeteran: () => true } });
    assert.equal(g.getLevel(), GuidanceLevels.MINIMAL);
    g.dispose();
  });
});

describe('GuidanceDirector — behavior de-escalation', () => {
  it('a successful capture before coaching jumps straight to MINIMAL', () => {
    eventBus.clear();
    const g = new GuidanceDirector({});
    g.setCoachingActive(false);
    eventBus.emit(Events.DEBRIS_CAPTURED, { id: 1 });
    assert.equal(g.getLevel(), GuidanceLevels.MINIMAL);
    g.dispose();
  });

  it('a capture WHILE coaching is active does NOT de-escalate', () => {
    eventBus.clear();
    const g = new GuidanceDirector({});
    g.setCoachingActive(true);
    eventBus.emit(Events.DEBRIS_CAPTURED, { id: 1 });
    assert.equal(g.getLevel(), GuidanceLevels.GUIDED);
    g.dispose();
  });

  it('a single advanced action does NOT de-escalate (stray-press guard)', () => {
    eventBus.clear();
    const g = new GuidanceDirector({});
    eventBus.emit(Events.AUTOPILOT_ENGAGE, {});
    assert.equal(g.getLevel(), GuidanceLevels.GUIDED);
    g.dispose();
  });

  it('two DISTINCT advanced actions drop one tier (GUIDED → POINTERS)', () => {
    eventBus.clear();
    const g = new GuidanceDirector({});
    eventBus.emit(Events.AUTOPILOT_ENGAGE, {});
    eventBus.emit(Events.SCAN_INITIATED, {});
    assert.equal(g.getLevel(), GuidanceLevels.POINTERS);
    g.dispose();
  });

  it('does NOT step down again on the 3rd/4th distinct action without a re-escalation in between', () => {
    eventBus.clear();
    const g = new GuidanceDirector({});
    eventBus.emit(Events.AUTOPILOT_ENGAGE, {}); // 1
    eventBus.emit(Events.SCAN_INITIATED, {});   // 2 → POINTERS (one-shot)
    assert.equal(g.getLevel(), GuidanceLevels.POINTERS);
    eventBus.emit(Events.LASSO_FIRED, {});      // 3 — must NOT step down again
    assert.equal(g.getLevel(), GuidanceLevels.POINTERS);
    eventBus.emit(Events.ARM_DEPLOYED, {});     // 4 — still no extra step down
    assert.equal(g.getLevel(), GuidanceLevels.POINTERS);
    g.dispose();
  });
});

describe('GuidanceDirector — struggle re-escalation', () => {
  it('a struggle signal bumps the level back up one tier', () => {
    eventBus.clear();
    const g = new GuidanceDirector({});
    // de-escalate to POINTERS first
    eventBus.emit(Events.AUTOPILOT_ENGAGE, {});
    eventBus.emit(Events.SCAN_INITIATED, {});
    assert.equal(g.getLevel(), GuidanceLevels.POINTERS);
    // struggle → back to GUIDED
    eventBus.emit(Events.NET_EMPTY_CLICK, {});
    assert.equal(g.getLevel(), GuidanceLevels.GUIDED);
    g.dispose();
  });

  it('noteStall() re-escalates', () => {
    eventBus.clear();
    const g = new GuidanceDirector({});
    eventBus.emit(Events.DEBRIS_CAPTURED, {}); // → MINIMAL
    assert.equal(g.getLevel(), GuidanceLevels.MINIMAL);
    g.noteStall();
    assert.equal(g.getLevel(), GuidanceLevels.POINTERS);
    g.dispose();
  });
});

describe('GuidanceDirector — Settings override + events', () => {
  it('setOverride pins the level and emits GUIDANCE_LEVEL_CHANGED', () => {
    eventBus.clear();
    const seen = [];
    eventBus.on(Events.GUIDANCE_LEVEL_CHANGED, (d) => seen.push(d.level));
    const g = new GuidanceDirector({});
    g.setOverride(GuidanceLevels.MINIMAL);
    assert.equal(g.getLevel(), GuidanceLevels.MINIMAL);
    // behavior cannot move a pinned level
    eventBus.emit(Events.NET_EMPTY_CLICK, {});
    assert.equal(g.getLevel(), GuidanceLevels.MINIMAL);
    assert.ok(seen.includes(GuidanceLevels.MINIMAL));
    g.dispose();
  });
});
