/**
 * test-IssConjunctionBoss.js — CH5 protect-the-asset boss (Node-safe).
 */
import { describe, it, assert } from './TestRunner.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { IssConjunctionBoss } from '../systems/IssConjunctionBoss.js';

const CFG = Constants.ISS_BOSS;
const GS = Constants.TIME_SCALE_GAMEPLAY || 10;
/** Real seconds to advance `hours` of game-time. */
const realSecsForHours = (hours) => (hours * 3600) / GS;

function createMockEventBus() {
  const listeners = new Map();
  return {
    on(evt, handler) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(handler);
      return () => {
        const arr = listeners.get(evt);
        if (arr) { const i = arr.indexOf(handler); if (i >= 0) arr.splice(i, 1); }
      };
    },
    emit(evt, data) {
      const arr = listeners.get(evt);
      if (arr) [...arr].forEach(fn => fn(data));
    },
  };
}

/** Build an inited boss + recorder + spawn-controllable debris field. */
function makeBoss({ mission = CFG.MISSION, spawnIds = null, contractMass = 0, pmPeek = null } = {}) {
  const eb = createMockEventBus();
  const rec = {};
  const cap = (evt, key) => eb.on(evt, (d) => (rec[key] = rec[key] || []).push(d));
  cap(Events.COMMS_MESSAGE, 'comms');
  cap(Events.ISS_BOSS_STARTED, 'started');
  cap(Events.ISS_BOSS_IMMINENT, 'imminent');
  cap(Events.ISS_BOSS_RESOLVED, 'resolved');
  cap(Events.SCORING_AWARD, 'award');
  cap(Events.CONTRACT_UPDATE, 'contract');
  cap(Events.CONTRACT_COMPLETE, 'contractComplete');

  const ids = spawnIds ?? Array.from({ length: CFG.FRAG_COUNT }, (_, i) => 1000 + i);
  const debrisField = {
    spawnCalls: [],
    spawnIssThreatField(opts) { this.spawnCalls.push(opts); return { ids: [...ids] }; },
  };
  const scoring = { getMissionNumber: () => mission, credits: 0, addCredits(n) { this.credits += n; } };
  let _mass = contractMass;
  const shopScreen = { getContractMass: () => _mass, setContractMass: (kg) => { _mass = kg; } };
  const pm = { peek: () => pmPeek };

  const boss = new IssConjunctionBoss({ eventBus: eb, scoringSystem: scoring, debrisField, shopScreen, persistenceManager: pm });
  boss.init();
  return { eb, boss, rec, debrisField, shopScreen, scoring, threatIds: ids };
}

/** Expire the whole TCA window. */
function expireTca(boss) { boss.update(realSecsForHours(CFG.TCA_HOURS) + 1); }

describe('IssConjunctionBoss — trigger gating', () => {
  it('SHOP_DEPLOY into the boss mission spawns the threat field + announces', () => {
    const { eb, boss, rec, debrisField } = makeBoss();
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    assert.equal(debrisField.spawnCalls.length, 1, 'spawned once');
    assert.equal(debrisField.spawnCalls[0].count, CFG.FRAG_COUNT);
    assert.ok(boss.isActive(), 'boss running');
    assert.equal(rec.started.length, 1);
    assert.equal(rec.started[0].threatIds.length, CFG.FRAG_COUNT);
    assert.equal(rec.started[0].tcaHours, CFG.TCA_HOURS);
    assert.ok(rec.comms && rec.comms[0]._critical === true, 'boss comms are critical');
  });

  it('does nothing on a non-boss mission', () => {
    const { eb, boss, debrisField } = makeBoss({ mission: 2 });
    eb.emit(Events.SHOP_DEPLOY, { mission: 2 });
    assert.equal(debrisField.spawnCalls.length, 0);
    assert.equal(boss.isActive(), false);
  });

  it('resolves the mission via scoringSystem when payload omits it', () => {
    const { eb, boss } = makeBoss({ mission: CFG.MISSION });
    eb.emit(Events.SHOP_DEPLOY, {});
    assert.ok(boss.isActive(), 'resolved boss mission from scoring');
  });

  it('does not stage when the field has no candidates to repurpose', () => {
    const { eb, boss } = makeBoss({ spawnIds: [] });
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    assert.equal(boss.isActive(), false, 'no frags → boss not active');
    assert.equal(boss.hasCompleted(), false, 'left incomplete so it can retry');
  });
});

describe('IssConjunctionBoss — INTERCEPT (clear all)', () => {
  it('clearing every threat frag resolves intercept with the full award', () => {
    const { eb, boss, rec, shopScreen, threatIds } = makeBoss({ contractMass: 50 });
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });

    threatIds.forEach((id) => eb.emit(Events.DEBRIS_REMOVED, { id }));

    assert.equal(boss.isActive(), false, 'resolved on full sweep');
    assert.equal(rec.resolved[0].outcome, 'intercept');
    assert.equal(rec.resolved[0].cleared, CFG.FRAG_COUNT);
    // Credits award
    assert.ok(rec.award && rec.award[0].points === CFG.INTERCEPT_BONUS_CREDITS);
    // Elevator mass award
    assert.equal(shopScreen.getContractMass(), 50 + CFG.INTERCEPT_BONUS_KG);
    assert.equal(rec.contract[0].contractMassKg, 50 + CFG.INTERCEPT_BONUS_KG);
    // Well below target → no premature contract completion.
    assert.equal(rec.contractComplete, undefined, 'no CONTRACT_COMPLETE far from target');
    assert.equal(boss.hasCompleted(), true);
  });

  it('an intercept that crosses the elevator target fires CONTRACT_COMPLETE + win bonus', () => {
    const target = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.TARGET_MASS_KG) || 10000;
    const { eb, rec, shopScreen, scoring, threatIds } = makeBoss({ contractMass: target - 1 });
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    threatIds.forEach((id) => eb.emit(Events.DEBRIS_REMOVED, { id }));

    assert.ok(shopScreen.getContractMass() >= target, 'bonus crossed the contract target');
    assert.ok(rec.contractComplete && rec.contractComplete.length === 1, 'CONTRACT_COMPLETE emitted so the elevator win can arm');
    const winBonus = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.WIN_BONUS) || 50000;
    assert.equal(rec.contractComplete[0].bonusCredits, winBonus);
    assert.equal(scoring.credits, winBonus, 'win bonus credited');
  });

  it('counts a clear from any capture/removal event and de-dupes by id', () => {
    const { eb, boss, rec, threatIds } = makeBoss();
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });

    // Mixed event sources + a duplicate must not over-count.
    eb.emit(Events.ARM_CAPTURED, { debrisId: threatIds[0], manual: true });
    eb.emit(Events.ARM_CAPTURED, { debrisId: threatIds[0] }); // dup
    eb.emit(Events.CATCH_PROCESSED, { debrisId: threatIds[1] });
    eb.emit(Events.LASSO_CAPTURED, { id: threatIds[2] });
    assert.equal(boss.getProgress().cleared, 3, 'three distinct threats cleared');
    assert.ok(boss.isActive(), 'still running — not all cleared yet');

    // A non-threat id is ignored.
    eb.emit(Events.DEBRIS_REMOVED, { id: 999999 });
    assert.equal(boss.getProgress().cleared, 3);
  });
});

describe('IssConjunctionBoss — DECLINE', () => {
  it('an explicit ISS_BOSS_DECLINE resolves decline with no award', () => {
    const { eb, boss, rec, shopScreen } = makeBoss({ contractMass: 10 });
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    eb.emit(Events.ISS_BOSS_DECLINE, {});
    assert.equal(rec.resolved[0].outcome, 'decline');
    assert.equal(rec.award, undefined, 'no credits');
    assert.equal(shopScreen.getContractMass(), 10, 'no elevator mass');
    assert.equal(boss.isActive(), false);
  });

  it('letting the clock run out with zero clears is an (emergent) decline', () => {
    const { eb, boss, rec } = makeBoss();
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    expireTca(boss);
    assert.equal(rec.resolved[0].outcome, 'decline');
  });
});

describe('IssConjunctionBoss — MISS (engaged but late)', () => {
  it('clearing some but not all by TCA resolves miss with no bonus', () => {
    const { eb, boss, rec, shopScreen, threatIds } = makeBoss({ contractMass: 25 });
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    eb.emit(Events.DEBRIS_REMOVED, { id: threatIds[0] });
    eb.emit(Events.DEBRIS_REMOVED, { id: threatIds[1] });
    expireTca(boss);
    assert.equal(rec.resolved[0].outcome, 'miss');
    assert.equal(rec.resolved[0].cleared, 2);
    assert.equal(rec.award, undefined, 'bonus lost');
    assert.equal(shopScreen.getContractMass(), 25, 'no elevator bonus');
  });
});

describe('IssConjunctionBoss — countdown + imminent warning', () => {
  it('fires the imminent warning exactly once near TCA', () => {
    const { eb, boss, rec } = makeBoss();
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });

    // Advance to just inside the imminent window.
    boss.update(realSecsForHours(CFG.TCA_HOURS - CFG.IMMINENT_HOURS + 0.5));
    assert.ok(rec.imminent && rec.imminent.length === 1, 'imminent fired once');
    assert.ok(rec.imminent[0].tcaRemainingHours <= CFG.IMMINENT_HOURS);

    // Another tick (still before TCA) must not re-fire.
    boss.update(realSecsForHours(0.1));
    assert.equal(rec.imminent.length, 1, 'imminent does not repeat');
  });

  it('getTcaRemainingHours counts down while active and is 0 when idle', () => {
    const { eb, boss } = makeBoss();
    assert.equal(boss.getTcaRemainingHours(), 0, 'idle = 0');
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    assert.closeTo(boss.getTcaRemainingHours(), CFG.TCA_HOURS, 0.001);
    boss.update(realSecsForHours(10));
    assert.closeTo(boss.getTcaRemainingHours(), CFG.TCA_HOURS - 10, 0.01);
  });
});

describe('IssConjunctionBoss — lifecycle + persistence', () => {
  it('does not re-run after it has resolved', () => {
    const { eb, boss, debrisField, threatIds } = makeBoss();
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    threatIds.forEach((id) => eb.emit(Events.DEBRIS_REMOVED, { id }));
    assert.equal(boss.hasCompleted(), true);
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    assert.equal(debrisField.spawnCalls.length, 1, 'no second spawn');
  });

  it('GAME_RESET clears completion so the boss can run in a new game', () => {
    const { eb, boss, threatIds } = makeBoss();
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    threatIds.forEach((id) => eb.emit(Events.DEBRIS_REMOVED, { id }));
    assert.equal(boss.hasCompleted(), true);
    eb.emit(Events.GAME_RESET);
    assert.equal(boss.hasCompleted(), false);
  });

  it('PERSISTENCE_GATHER writes, and a restored-complete boss does not re-run', () => {
    const { eb, boss } = makeBoss();
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    boss.update(realSecsForHours(0.1));
    eb.emit(Events.ISS_BOSS_DECLINE, {});
    const save = {};
    eb.emit(Events.PERSISTENCE_GATHER, save);
    assert.ok(save.issBoss, 'wrote issBoss blob');
    assert.equal(save.issBoss.completed, true);

    const restored = makeBoss({ pmPeek: { issBoss: { version: 1, completed: true } } });
    restored.eb.emit(Events.PERSISTENCE_LOADED);
    restored.eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    assert.equal(restored.boss.isActive(), false, 'restored-complete boss stays idle');
  });
});

describe('IssConjunctionBoss — codex outcome wiring (data contract)', () => {
  it('Constants.ISS_BOSS names the three outcome codex ids', () => {
    assert.ok(CFG.CODEX.SAVER && CFG.CODEX.PDAM && CFG.CODEX.HYDRAZINE);
  });
  it('resolved payloads carry the outcome the codex entries gate on', () => {
    const outcomes = new Set();
    for (const setup of [
      (b, ids, eb) => ids.forEach((id) => eb.emit(Events.DEBRIS_REMOVED, { id })), // intercept
      (b, ids, eb) => eb.emit(Events.ISS_BOSS_DECLINE, {}),                          // decline
      (b, ids, eb) => { eb.emit(Events.DEBRIS_REMOVED, { id: ids[0] }); expireTca(b); }, // miss
    ]) {
      const { eb, boss, rec, threatIds } = makeBoss();
      eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
      setup(boss, threatIds, eb);
      outcomes.add(rec.resolved[0].outcome);
    }
    assert.deepEqual([...outcomes].sort(), ['decline', 'intercept', 'miss']);
  });
});
