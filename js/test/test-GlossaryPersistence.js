/**
 * test-GlossaryPersistence.js — Codex Overhaul Step 4 persistence guard (§11.8).
 *
 * GlossaryState contributes a `glossary` slice ({ v, seen }) via
 * PERSISTENCE_GATHER and restores it via peek() on PERSISTENCE_LOADED. Like the
 * codex slice, `save()` rebuilds a closed whitelist envelope, so the slice is
 * inert unless PersistenceManager whitelists the `glossary` key. This suite
 * drives a real gather → save() → peek() → restore() round-trip through an
 * in-memory localStorage stub so that wiring can't silently regress.
 *
 * @module test/test-GlossaryPersistence
 */

import { describe, it, assert } from './TestRunner.js';
import { persistenceManager } from '../systems/PersistenceManager.js';
import { GlossaryState } from '../systems/codex/GlossaryState.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

// In-memory localStorage stub (re-detected after install — see CodexPersistence).
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

describe('Glossary persistence — save() whitelists the glossary slice', () => {
  it('localStorage stub is active for this suite', () => {
    assert.ok(persistenceManager._storageAvailable, 'storage detected via stub');
  });

  it('save() round-trips the glossary key through peek()', () => {
    _store.clear();
    const ok = persistenceManager.save({
      credits: 0,
      glossary: { v: 1, seen: ['LEO', 'ΔV'] },
    });
    assert.ok(ok, 'save() returned true');
    const back = persistenceManager.peek();
    assert.ok(back && back.glossary, 'glossary slice survived save→peek');
    assert.deepEqual(back.glossary.seen.sort(), ['LEO', 'ΔV'].sort(), 'seen list intact');
  });
});

describe('Glossary persistence — seen-state survives gather→save→restore', () => {
  it('a fresh GlossaryState restores seen terms from a prior save', () => {
    _store.clear();
    // 1) Session A marks two terms seen and gathers + saves.
    const a = new GlossaryState();
    a.markSeen('LEO');
    a.markSeen('TRL');
    const saveData = { credits: 1 };
    eventBus.emit(Events.PERSISTENCE_GATHER, saveData);
    assert.ok(saveData.glossary, 'gather attached the glossary slice');
    assert.deepEqual(saveData.glossary.seen.sort(), ['LEO', 'TRL'].sort());
    persistenceManager.save(saveData);
    a.dispose();

    // 2) Session B: a fresh state restores from the persisted slice.
    const b = new GlossaryState();
    b.restore(persistenceManager.peek().glossary);
    assert.ok(b.hasSeen('LEO'), 'LEO restored');
    assert.ok(b.hasSeen('TRL'), 'TRL restored');
    assert.ok(b.isNew('ΔV'), 'an unseen term is still new');
    b.dispose();
  });

  it('restore ignores legacy / mismatched-version shapes', () => {
    const s = new GlossaryState();
    s.restore(undefined);
    s.restore({ v: 99, seen: ['LEO'] });   // wrong version
    s.restore(['LEO']);                      // bare array (legacy)
    s.restore({ v: 1, seen: 'nope' });       // bad shape
    assert.ok(s.isNew('LEO'), 'nothing restored from invalid data');
    s.dispose();
  });

  it('restore unions (never un-sees) and ignores non-string entries', () => {
    const s = new GlossaryState();
    s.markSeen('LEO');
    s.restore({ v: 1, seen: ['TRL', 42, null, 'GEO'] });
    assert.ok(s.hasSeen('LEO'), 'pre-existing seen kept');
    assert.ok(s.hasSeen('TRL') && s.hasSeen('GEO'), 'valid entries added');
    assert.equal(s.serialize().seen.length, 3, 'only the 3 string terms tracked');
    s.dispose();
  });
});

describe('Glossary persistence — empty-state data-loss guard', () => {
  it('an unused GlossaryState preserves a richer prior save on gather', () => {
    _store.clear();
    // A prior save holds real seen-state.
    persistenceManager.save({ credits: 0, glossary: { v: 1, seen: ['LEO', 'GEO'] } });

    // A freshly-constructed state (nothing seen yet) must NOT clobber it.
    const fresh = new GlossaryState();
    const saveData = { credits: 1 };
    eventBus.emit(Events.PERSISTENCE_GATHER, saveData);
    assert.ok(saveData.glossary, 'glossary slice present');
    assert.deepEqual(saveData.glossary.seen.sort(), ['GEO', 'LEO'].sort(),
      'prior seen-state preserved (not overwritten with an empty set)');
    fresh.dispose();
  });
});

describe('Glossary persistence — test teardown', () => {
  it('restores prior localStorage + storage flag', () => {
    _store.clear();
    persistenceManager._storageAvailable = _prevAvail;
    if (_hadLS) globalThis.localStorage = _prevLS;
    else delete globalThis.localStorage;
    assert.ok(true, 'teardown complete');
  });
});
