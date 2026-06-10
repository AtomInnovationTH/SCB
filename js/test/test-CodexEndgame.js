/**
 * test-CodexEndgame.js — outcome-gated codex entries for the boss events and the
 * elevator (anchor-run) win. CodexSystem is Node-safe (no hard DOM/THREE at load).
 */
import { describe, it, assert } from './TestRunner.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { CodexSystem } from '../systems/CodexSystem.js';

const codex = new CodexSystem();

describe('Codex — ISS boss outcome entries', () => {
  const cases = [
    ['iss_saver', 'intercept'],
    ['iss_pdam', 'decline'],
    ['iss_hydrazine_burn', 'miss'],
  ];
  for (const [id, outcome] of cases) {
    it(`${id} gates on ISS_BOSS_RESOLVED{outcome:'${outcome}'}`, () => {
      const e = codex.getEntry(id);
      assert.ok(e, `${id} exists`);
      assert.equal(e.triggerEvent, Events.ISS_BOSS_RESOLVED);
      assert.equal(e.triggerCondition({ outcome }), true);
      assert.equal(!!e.triggerCondition({ outcome: 'other' }), false);
    });
  }
});

describe('Codex — Starlink boss outcome entries', () => {
  it('starlink_contained gates on contained, starlink_cascade on cascade', () => {
    const contained = codex.getEntry('starlink_contained');
    const cascade = codex.getEntry('starlink_cascade');
    assert.ok(contained && cascade);
    assert.equal(contained.triggerEvent, Events.STARLINK_BOSS_RESOLVED);
    assert.equal(contained.triggerCondition({ outcome: 'contained' }), true);
    assert.equal(!!contained.triggerCondition({ outcome: 'partial' }), false);
    assert.equal(cascade.triggerCondition({ outcome: 'cascade' }), true);
    assert.equal(!!cascade.triggerCondition({ outcome: 'contained' }), false);
  });
});

describe('Codex — Phase E endgame entries (elevator win)', () => {
  const ids = ['space_elevator', 'what_10000kg_buys', 'jwst_horizon'];
  it('all three exist and gate on GAME_WIN{winType:elevator}', () => {
    for (const id of ids) {
      const e = codex.getEntry(id);
      assert.ok(e, `${id} exists`);
      assert.equal(e.triggerEvent, Events.GAME_WIN);
      assert.equal(e.triggerCondition({ winType: 'elevator' }), true,
        `${id} unlocks on the elevator win`);
      assert.equal(!!e.triggerCondition({ winType: 'debris' }), false,
        `${id} does NOT unlock on the 50-debris win`);
    }
  });

  it('a single elevator GAME_WIN unlocks ALL three immediately (terminal — no staggered queue)', () => {
    // GAME_WIN is a terminal event: CodexSystem.update() won't run on the win
    // screen, so the batch must unlock synchronously rather than queue.
    const fresh = new CodexSystem();
    eventBus.emit(Events.GAME_WIN, { winType: 'elevator', totalMassKg: 10000 });
    for (const id of ids) {
      assert.equal(fresh.getEntry(id).unlocked, true, `${id} unlocked on the win event`);
    }
  });

  it('the 50-debris GAME_WIN does NOT unlock the elevator endgame entries', () => {
    const fresh = new CodexSystem();
    eventBus.emit(Events.GAME_WIN, { winType: 'debris', debrisCleared: 50 });
    for (const id of ids) {
      assert.equal(fresh.getEntry(id).unlocked, false, `${id} stays locked on the debris win`);
    }
  });
});
