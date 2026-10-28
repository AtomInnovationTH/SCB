/**
 * GlossaryState.js — first-use seen-state for the inline glossary (§11.8).
 *
 * The pure decorator (glossary.js) decides WHAT to wrap; this controller decides whether a term still deserves its first-use
 * attention cue: a term is "seen" once rendered, after which the brighter `glossary-term--new` cue drops (the hover `title`
 * always remains). Persisted so veterans aren't nagged across sessions.
 *
 * Persistence mirrors CodexSystem's self-managed slice: a versioned envelope (`{ v, seen }`), gathered on PERSISTENCE_GATHER,
 * restored via peek() on PERSISTENCE_LOADED, with a data-loss guard so an empty in-memory state can't clobber a prior save.
 * Additive slice: SAVE_VERSION is unchanged.
 *
 * @module systems/codex/GlossaryState
 */

import { eventBus } from '../../core/EventBus.js';
import { Events } from '../../core/Events.js';
import { persistenceManager } from '../PersistenceManager.js';

const SLICE_VERSION = 1;

export class GlossaryState {
  constructor() {
    /** @type {Set<string>} canonical term keys the player has already seen */
    this._seen = new Set();
    this._unsubs = [];
    this._setupListeners();
  }

  hasSeen(term) { return this._seen.has(term); }

  markSeen(term) { if (term) this._seen.add(term); }

  isNew(term) { return !this._seen.has(term); }

  /** @returns {{ v:number, seen:string[] }} */
  serialize() { return { v: SLICE_VERSION, seen: [...this._seen] }; }

  /** Restore from the persisted slice. Union semantics: never un-see a term. Mismatched/legacy shapes are ignored. */
  restore(data) {
    if (!data || data.v !== SLICE_VERSION || !Array.isArray(data.seen)) return;
    for (const term of data.seen) if (typeof term === 'string') this._seen.add(term);
  }

  _setupListeners() {
    this._unsubs.push(eventBus.on(Events.PERSISTENCE_GATHER, (saveData) => {
      if (!saveData) return;
      // Data-loss guard: if nothing was seen this session, don't overwrite a richer prior save (the state may be constructed
      // but never used).
      if (this._seen.size === 0) {
        const prev = persistenceManager.peek();
        if (prev && prev.glossary) { saveData.glossary = prev.glossary; return; }
      }
      saveData.glossary = this.serialize();
    }));
    this._unsubs.push(eventBus.on(Events.PERSISTENCE_LOADED, () => {
      const save = persistenceManager.peek();
      if (save && save.glossary) this.restore(save.glossary);
    }));
  }

  /** Detach all eventBus listeners (test cleanup / hot-reload). */
  dispose() {
    for (const off of this._unsubs) { try { off(); } catch { /* noop */ } }
    this._unsubs.length = 0;
  }
}

export default GlossaryState;
