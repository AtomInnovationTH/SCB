/**
 * test-CodexPersistence.js — Codex Overhaul Phase 0b regression guard.
 *
 * The codex save/restore wiring (PERSISTENCE_GATHER → saveData.codex →
 * PersistenceManager.save → peek → restore) was initially INERT because
 * PersistenceManager.save() rebuilds a closed envelope and only persists
 * whitelisted keys — the `codex` key was dropped, so unlocks were still lost on
 * reload. This suite drives a real save()→peek() round-trip through an
 * in-memory localStorage stub so that regression can never return silently.
 *
 * All imports are static and every test is synchronous: the harness runs
 * describe/it bodies in order only when nothing yields the event loop, so we
 * avoid dynamic import() (which would interleave the teardown early).
 *
 * @module test/test-CodexPersistence
 */

import { describe, it, assert } from './TestRunner.js';
import { persistenceManager } from '../systems/PersistenceManager.js';
import { CodexSystem } from '../systems/CodexSystem.js';
import { CODEX_DATA } from './_codexFixture.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

// Install a minimal in-memory localStorage on globalThis. Static imports above
// have already constructed the PersistenceManager singleton (in Node, with no
// storage), so we re-run its own storage check now that the stub exists.
const _store = new Map();
const _hadLS = typeof globalThis.localStorage !== 'undefined';
const _prevLS = _hadLS ? globalThis.localStorage : undefined;
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
  clear: () => { _store.clear(); },
};
const _prevAvail = persistenceManager._storageAvailable;
persistenceManager._storageAvailable = persistenceManager._checkStorage();

describe('Codex Phase 0 — save() persists the codex slice (regression)', () => {
  it('localStorage stub is active for this suite', () => {
    assert.ok(persistenceManager._storageAvailable, 'storage detected via stub');
  });

  it('save() round-trips the codex key through peek()', () => {
    _store.clear();
    const codexState = {
      v: 1,
      entries: [
        { id: 'feep_indium', unlocked: true, seen: true },
        { id: 'delta_v', unlocked: true, seen: false },
      ],
    };
    const ok = persistenceManager.save({
      credits: 10, totalScore: 0, debrisCleared: 0,
      codex: codexState,
    });
    assert.ok(ok, 'save() returned true');

    const back = persistenceManager.peek();
    assert.ok(back, 'peek() returned a save bundle');
    assert.ok(back.codex, 'codex key survived the save envelope (was dropped before the fix)');
    assert.deepEqual(back.codex, codexState, 'codex slice round-trips intact');
  });

  it('save() without a codex key stores null (additive, no crash)', () => {
    _store.clear();
    persistenceManager.save({ credits: 1 });
    const back = persistenceManager.peek();
    assert.ok(back, 'peek() returned a bundle');
    assert.equal(back.codex, null, 'absent codex contribution persists as null');
  });
});

describe('Codex Phase 0 — full getState→save→peek→restore cycle', () => {
  it('an unlocked entry survives a save/reload cycle', () => {
    _store.clear();

    // Source system: unlock a discovery (locked) entry, then persist its state.
    const src = new CodexSystem(CODEX_DATA);
    const targetEntry = src.entries.find(e => !e.unlocked);
    const target = targetEntry.id;
    targetEntry.unlocked = true;
    targetEntry.seen = true;
    persistenceManager.save({ credits: 0, codex: src.getState() });

    // Destination system: simulate reload by restoring from the persisted bundle.
    const dst = new CodexSystem(CODEX_DATA);
    assert.ok(!dst.getEntry(target).unlocked, 'fresh instance starts locked');
    const persisted = persistenceManager.peek();
    assert.ok(persisted && persisted.codex, 'persisted bundle carried the codex slice');
    dst.restore(persisted.codex);

    assert.ok(dst.getEntry(target).unlocked, 'unlock survived the save/reload cycle');
    assert.ok(dst.getEntry(target).seen, 'seen flag survived too');
  });
});

// Restore global state so later suites are unaffected by the stub.
// Restore global state so later suites are unaffected by the stub.
describe('Codex Phase 1 — empty-codex load failure does NOT clobber saved unlocks', () => {
  it('PERSISTENCE_GATHER preserves the prior codex when the system loaded empty', () => {
    _store.clear();
    // 1) A healthy session persisted real unlocks.
    const good = { v: 1, entries: [{ id: 'delta_v', unlocked: true, seen: true }] };
    persistenceManager.save({ credits: 5, codex: good });

    // 2) Next session, codex.json failed to load → empty system (0 entries).
    const empty = new CodexSystem(null);
    assert.equal(empty.entries.length, 0, 'system constructed empty (load failure)');

    // 3) A gameplay save fires PERSISTENCE_GATHER. The empty system (subscribed
    //    last) must preserve the prior codex, not overwrite with [].
    const saveData = { credits: 6 };
    eventBus.emit(Events.PERSISTENCE_GATHER, saveData);
    assert.ok(saveData.codex, 'codex slice present');
    assert.ok(saveData.codex.entries.length > 0,
      'prior unlocks preserved (NOT clobbered with an empty list)');
    assert.ok(saveData.codex.entries.some(e => e.id === 'delta_v' && e.unlocked),
      'the earned delta_v unlock survives a codex load failure');
  });
});

describe('Codex Phase 7 — unlock context anchoring (Slice 7)', () => {
  it('_performUnlock stamps { tSim, altKm } from the mission clock + telemetry', () => {
    const sys = new CodexSystem(CODEX_DATA);
    sys._missionTime = 134;                 // T+02:14
    eventBus.emit(Events.PLAYER_TELEMETRY, { altitude: 782.4 });
    const target = sys.entries.find(e => !e.unlocked);
    sys._performUnlock(target);
    assert.ok(target.unlockContext, 'context stamped on unlock');
    assert.equal(target.unlockContext.tSim, 134, 'mission time captured');
    assert.equal(target.unlockContext.altKm, 782, 'altitude captured (rounded)');
  });

  it('update(dt) advances the mission clock; MISSION_START resets it', () => {
    const sys = new CodexSystem(CODEX_DATA);
    sys.update(10); sys.update(5);
    assert.equal(sys._missionTime, 15, 'clock accumulates dt');
    eventBus.emit(Events.MISSION_START, {});
    assert.equal(sys._missionTime, 0, 'MISSION_START zeroes the clock');
  });

  it('unlock context survives a getState → restore cycle (additive, v2)', () => {
    _store.clear();
    const src = new CodexSystem(CODEX_DATA);
    src._missionTime = 90;
    eventBus.emit(Events.PLAYER_TELEMETRY, { altitude: 500 });
    const t = src.entries.find(e => !e.unlocked);
    src._performUnlock(t);
    const state = src.getState();
    assert.equal(state.v, 2, 'codex slice version bumped to 2');
    const saved = state.entries.find(e => e.id === t.id);
    assert.ok(saved.ctx && saved.ctx.tSim === 90 && saved.ctx.altKm === 500, 'ctx serialized');

    const dst = new CodexSystem(CODEX_DATA);
    dst.restore(state);
    assert.deepEqual(dst.getEntry(t.id).unlockContext, { tSim: 90, altKm: 500 }, 'ctx restored');
  });

  it('restore tolerates a legacy v1 save with no ctx', () => {
    const dst = new CodexSystem(CODEX_DATA);
    const legacy = { v: 1, entries: [{ id: 'delta_v', unlocked: true, seen: true }] };
    dst.restore(legacy);
    assert.ok(dst.getEntry('delta_v').unlocked, 'unlock restored');
    assert.equal(dst.getEntry('delta_v').unlockContext, undefined, 'no ctx invented for old saves');
  });
});

describe('Codex Phase 7 — first-completion comms (Slice 7)', () => {
  // Smallest category that still has a gated entry, so we can drive it to 100%.
  function pickCategory(sys) {
    const counts = {};
    for (const e of sys.entries) counts[e.category] = (counts[e.category] || 0) + 1;
    return Object.keys(counts).sort((a, b) => counts[a] - counts[b])
      .find(c => sys.getCategory(c).some(e => !e.unlocked));
  }

  it('emits ONE arbiter-gated Houston line when a category first hits 100%, no rewards', () => {
    const sys = new CodexSystem(CODEX_DATA);
    const cat = pickCategory(sys);
    const list = sys.getCategory(cat);

    const fired = [];
    const off = eventBus.on(Events.COMMS_MESSAGE, (m) => { if (m && m._codexCompletion) fired.push(m); });
    try {
      for (let i = 0; i < list.length - 1; i++) sys._performUnlock(list[i]);
      assert.equal(fired.length, 0, 'no completion line before 100%');
      sys._performUnlock(list[list.length - 1]);
      const catLines = fired.filter(m => /file logged/i.test(m.text));
      assert.equal(catLines.length, 1, 'exactly one category completion line');
      const line = catLines[0];
      assert.equal(line.source, 'HOUSTON');
      assert.equal(line._postOnboarding, true, 'rides the arbiter-gated post-onboarding path');
      assert.ok(!line._critical, 'never critical');
      assert.equal(line.credits, undefined, 'no reward grammar (credits)');
      assert.equal(line.xp, undefined, 'no reward grammar (xp)');
    } finally { off(); }
  });

  it('does not re-fire completion for an already-complete category', () => {
    const sys = new CodexSystem(CODEX_DATA);
    const cat = pickCategory(sys);
    const list = sys.getCategory(cat);
    list.forEach(e => sys._performUnlock(e));

    const fired = [];
    const off = eventBus.on(Events.COMMS_MESSAGE, (m) => { if (m && m._codexCompletion) fired.push(m); });
    try {
      sys._checkCompletion(list[0]);
      assert.equal(fired.length, 0, 'completion latch prevents a re-fire');
    } finally { off(); }
  });
});

describe('Codex Phase 0 — persistence test teardown', () => {
  it('restores prior localStorage + storage flag', () => {
    _store.clear();
    persistenceManager._storageAvailable = _prevAvail;
    if (_hadLS) globalThis.localStorage = _prevLS;
    else delete globalThis.localStorage;
    assert.ok(true, 'teardown complete');
  });
});
