/**
 * test-StarlinkCascadeBoss.js — CH9 race-the-cascade boss (Node-safe).
 */
import { describe, it, assert } from './TestRunner.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { StarlinkCascadeBoss } from '../systems/StarlinkCascadeBoss.js';

const CFG = Constants.STARLINK_BOSS;
const GS = Constants.TIME_SCALE_GAMEPLAY || 10;
/** Real seconds to advance `min` of game-time. */
const realSecsForMin = (min) => (min * 60) / GS;

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

function makeBoss({ mission = CFG.MISSION, spawnIds = null, contractMass = 0, pmPeek = null } = {}) {
  const eb = createMockEventBus();
  const rec = {};
  const cap = (evt, key) => eb.on(evt, (d) => (rec[key] = rec[key] || []).push(d));
  cap(Events.COMMS_MESSAGE, 'comms');
  cap(Events.STARLINK_BOSS_STARTED, 'started');
  cap(Events.STARLINK_BOSS_IMMINENT, 'imminent');
  cap(Events.STARLINK_BOSS_RESOLVED, 'resolved');
  cap(Events.SCORING_AWARD, 'award');
  cap(Events.CONTRACT_UPDATE, 'contract');

  const ids = spawnIds ?? Array.from({ length: CFG.FRAG_COUNT }, (_, i) => 5000 + i);
  const debrisField = {
    spawnCalls: [],
    spawnStarlinkField(opts) { this.spawnCalls.push(opts); return { ids: [...ids] }; },
  };
  const scoring = { getMissionNumber: () => mission, credits: 0, addCredits(n) { this.credits += n; } };
  let _mass = contractMass;
  const shopScreen = { getContractMass: () => _mass, setContractMass: (kg) => { _mass = kg; } };
  const pm = { peek: () => pmPeek };

  const boss = new StarlinkCascadeBoss({ eventBus: eb, scoringSystem: scoring, debrisField, shopScreen, persistenceManager: pm });
  boss.init();
  return { eb, boss, rec, debrisField, shopScreen, scoring, threatIds: ids };
}

const expireWindow = (boss) => boss.update(realSecsForMin(CFG.WINDOW_MIN) + 1);

describe('StarlinkCascadeBoss — trigger gating', () => {
  it('SHOP_DEPLOY into the boss mission burst-spawns + announces', () => {
    const { eb, boss, rec, debrisField } = makeBoss();
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    assert.equal(debrisField.spawnCalls.length, 1);
    assert.equal(debrisField.spawnCalls[0].count, CFG.FRAG_COUNT);
    assert.ok(boss.isActive());
    assert.equal(rec.started[0].threatIds.length, CFG.FRAG_COUNT);
    assert.equal(rec.started[0].windowMin, CFG.WINDOW_MIN);
    assert.ok(rec.comms[0]._critical === true);
  });

  it('does nothing on a non-boss mission', () => {
    const { eb, boss, debrisField } = makeBoss({ mission: 7 });
    eb.emit(Events.SHOP_DEPLOY, { mission: 7 });
    assert.equal(debrisField.spawnCalls.length, 0);
    assert.equal(boss.isActive(), false);
  });

  it('does not stage when the field has no candidates', () => {
    const { eb, boss } = makeBoss({ spawnIds: [] });
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    assert.equal(boss.isActive(), false);
    assert.equal(boss.hasCompleted(), false);
  });
});

describe('StarlinkCascadeBoss — outcomes', () => {
  it('clearing every frag resolves CONTAINED with the full award', () => {
    const { eb, boss, rec, shopScreen, threatIds } = makeBoss({ contractMass: 100 });
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    threatIds.forEach((id) => eb.emit(Events.DEBRIS_REMOVED, { id }));
    assert.equal(boss.isActive(), false);
    assert.equal(rec.resolved[0].outcome, 'contained');
    assert.equal(rec.award[0].points, CFG.CONTAIN_BONUS_CREDITS);
    assert.equal(shopScreen.getContractMass(), 100 + CFG.CONTAIN_BONUS_KG);
    assert.equal(boss.hasCompleted(), true);
  });

  it('clearing ≥ PARTIAL_FRACTION by the window resolves PARTIAL (credits, no mass bonus)', () => {
    const { eb, boss, rec, shopScreen, threatIds } = makeBoss({ contractMass: 100 });
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    const need = Math.ceil(CFG.FRAG_COUNT * CFG.PARTIAL_FRACTION);
    for (let i = 0; i < need; i++) eb.emit(Events.DEBRIS_REMOVED, { id: threatIds[i] });
    expireWindow(boss);
    assert.equal(rec.resolved[0].outcome, 'partial');
    assert.equal(rec.award[0].points, CFG.PARTIAL_CREDITS);
    assert.equal(shopScreen.getContractMass(), 100, 'no elevator mass on partial');
  });

  it('clearing too few by the window resolves CASCADE (no award)', () => {
    const { eb, boss, rec, shopScreen, threatIds } = makeBoss({ contractMass: 100 });
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    eb.emit(Events.DEBRIS_REMOVED, { id: threatIds[0] }); // 1/35 « 60%
    expireWindow(boss);
    assert.equal(rec.resolved[0].outcome, 'cascade');
    assert.equal(rec.award, undefined);
    assert.equal(shopScreen.getContractMass(), 100);
  });
});

describe('StarlinkCascadeBoss — countdown + lifecycle', () => {
  it('fires the imminent warning once near the window close', () => {
    const { eb, boss, rec } = makeBoss();
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    boss.update(realSecsForMin(CFG.WINDOW_MIN - CFG.IMMINENT_MIN + 0.2));
    assert.equal(rec.imminent.length, 1);
    boss.update(realSecsForMin(0.1));
    assert.equal(rec.imminent.length, 1, 'does not repeat');
  });

  it('does not re-run after resolving; GAME_RESET re-arms it', () => {
    const { eb, boss, debrisField, threatIds } = makeBoss();
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    threatIds.forEach((id) => eb.emit(Events.DEBRIS_REMOVED, { id }));
    eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    assert.equal(debrisField.spawnCalls.length, 1, 'no second spawn');
    eb.emit(Events.GAME_RESET);
    assert.equal(boss.hasCompleted(), false);
  });

  it('persists completion; a restored-complete boss stays idle', () => {
    const restored = makeBoss({ pmPeek: { starlinkBoss: { version: 1, completed: true } } });
    restored.eb.emit(Events.PERSISTENCE_LOADED);
    restored.eb.emit(Events.SHOP_DEPLOY, { mission: CFG.MISSION });
    assert.equal(restored.boss.isActive(), false);
  });
});
