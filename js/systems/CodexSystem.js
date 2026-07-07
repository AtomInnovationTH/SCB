/**
 * CodexSystem.js — ambient learning encyclopedia that unlocks entries as the
 * player encounters aerospace concepts during gameplay.
 *
 * Three-Beat Pattern: ENCOUNTER → REACT → UNDERSTAND (codex entry unlocks).
 *
 * Phase 1 (data-driven): entry CONTENT lives in data/codex.json (offline-first,
 * i18n-ready). Unlock PREDICATES — which can't be JSON — live in
 * codex/codexTriggers.js keyed by id (multi-trigger). Live-value prose
 * (`{{ Constants.path }}`) is resolved at load via codex/codexInterpolate.js.
 * The system is constructed with the parsed data injected:
 *     const data = await loadCodexData();   // browser
 *     new CodexSystem(data);
 * Node tests read the JSON and pass it the same way.
 *
 * @module systems/CodexSystem
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants, trlToBadgeColor, trlToLabel } from '../core/Constants.js';
import { persistenceManager } from './PersistenceManager.js';
import { CODEX_TRIGGERS } from './codex/codexTriggers.js';
import { interpolate } from './codex/codexInterpolate.js';

// ============================================================================
// CATEGORIES (logic enum — labels/icons/colours live in data/codex.json meta)
// ============================================================================

export const CodexCategory = {
  PLAYBOOK:          'PLAYBOOK',
  ORBITAL_MECHANICS: 'ORBITAL_MECHANICS',
  PROPULSION:        'PROPULSION',
  POWER:             'POWER',
  SPACE_ENVIRONMENT: 'SPACE_ENVIRONMENT',
  MATERIALS:         'MATERIALS',
  TETHERS:           'TETHERS',
  DEBRIS:            'DEBRIS',
  SENSORS:           'SENSORS',
  ATTITUDE:          'ATTITUDE',
  AVIONICS:          'AVIONICS',
  COMMS:             'COMMS',
  CATALOG:           'CATALOG',
  HERITAGE:          'HERITAGE',
  WORLD_INDUSTRY:    'WORLD_INDUSTRY',
  NEWS:              'NEWS',
};

// ============================================================================
// SAVE MIGRATION ALIASES
// Maps retired/merged entry ids → surviving id so pre-dedupe saves restore.
// Populated from data/codex.json at construction (kept module-level so the
// PERSISTENCE_LOADED restore path and Node tests can read it). Not the global
// SAVE_VERSION: bumping that would discard ALL state (credits/upgrades) — the
// alias migrates only the codex slice in place.
// ============================================================================
// Null-prototype so JSON-sourced keys (incl. a literal "__proto__") become
// plain own keys and lookups can't traverse Object.prototype.
export const ALIASES = Object.create(null);

/**
 * Pure search predicate — case-insensitive substring on
 * title / shortText / fullText / category. Exported for the viewer + tests.
 * @param {object} entry
 * @param {string} query
 * @returns {boolean}
 */
export function entryMatchesQuery(entry, query) {
  if (!query) return true;
  const q = String(query).toLowerCase();
  return (entry.title || '').toLowerCase().includes(q)
    || (entry.shortText || '').toLowerCase().includes(q)
    || (entry.fullText || '').toLowerCase().includes(q)
    || (entry.category || '').toLowerCase().replace(/_/g, ' ').includes(q);
}

// ============================================================================
// CODEX SYSTEM
// ============================================================================

export class CodexSystem {
  /**
   * @param {object|null} codexData  parsed data/codex.json
   *   ({ version, categories, tracks, aliases, entries }). If null/omitted the
   *   system constructs empty (graceful) — mirrors CatalogLoader's fallback.
   */
  constructor(codexData = null) {
    const data = (codexData && Array.isArray(codexData.entries))
      ? codexData
      : { version: 0, categories: {}, tracks: {}, aliases: {}, entries: [] };

    /** @type {Object<string,{label,icon,color,order}>} */
    this._categoryMeta = data.categories || {};
    /** @type {Object<string,{label,color,order}>} */
    this._tracks = data.tracks || {};

    // Populate the module-level ALIASES from data (idempotent across instances).
    Object.assign(ALIASES, data.aliases || {});

    /** @type {Array<object>} flattened, interpolated, trigger-attached entries */
    this.entries = (data.entries || []).map(e => this._buildEntry(e));

    /** @type {Map<string, object>} fast lookup by id */
    this._byId = new Map();
    this.entries.forEach(e => this._byId.set(e.id, e));

    /** @type {Array<object>} unlocks waiting for cooldown */
    this._unlockQueue = [];
    /** @type {number} cooldown timer (seconds remaining) */
    this._cooldownTimer = 0;
    /** @type {Set<string>} event names already subscribed */
    this._subscribedEvents = new Set();

    // Slice 7 — unlock anchoring: mission clock (accumulated in update, reset on
    // MISSION_START/GAME_RESET) + latest mothership altitude cached from
    // telemetry, stamped onto each entry as it unlocks.
    /** @type {number} seconds since mission start */
    this._missionTime = 0;
    /** @type {number|null} last known mothership altitude (km) */
    this._lastAltKm = null;
    /** @type {Set<string>} category/track keys whose first-100% comms already fired */
    this._completionsFired = new Set();

    this._setupListeners();

    console.log(`[CodexSystem] Initialized with ${this.entries.length} entries across ${Object.keys(this._categoryMeta).length || Object.keys(CodexCategory).length} categories`);
  }

  /**
   * Flatten one data entry into the runtime shape the viewer/API expect,
   * resolving i18n + live-value placeholders and attaching its triggers.
   * @private
   */
  _buildEntry(e) {
    const i = e.i18n || {};
    const hasTrl = (typeof e.trl === 'number');
    return {
      id: e.id,
      category: e.category,
      subcategory: e.subcategory || null,
      trl: hasTrl ? e.trl : null,         // PLAYBOOK/CATALOG/WORLD_INDUSTRY → null
      icon: e.icon || '📄',
      related: Array.isArray(e.related) ? e.related : [],
      track: e.track || null,
      trackOrder: (typeof e.trackOrder === 'number') ? e.trackOrder : null,
      // Currency stamp (WORLD_INDUSTRY/NEWS/CATALOG). "YYYY-MM" or null.
      lastVerified: (typeof e.lastVerified === 'string') ? e.lastVerified : null,
      // translatable fields (interpolated against live Constants)
      title: i.title || e.id,
      shortText: interpolate(i.shortText || '', Constants),
      fullText: interpolate(i.fullText || '', Constants),
      realWorld: i.realWorld ? interpolate(i.realWorld, Constants) : null,
      formula: i.formula || null,
      unlockHint: i.unlockHint || 'Discover through gameplay.',
      trlRationale: hasTrl ? (i.trlRationale || 'Established science (default)') : null,
      // runtime state. `startUnlocked` entries are readable immediately: PLAYBOOK
      // quick-start + WORLD_INDUSTRY exposition (onboarding/reference material, not
      // a gameplay "discovery"), plus one per-category "cornerstone" briefing so
      // every tech category shows its value from the first library open.
      unlocked: e.startUnlocked === true,
      seen: false,
      // unlock predicates (multi-trigger). Inert for startUnlocked entries (they
      // are already unlocked, so _checkUnlocks skips them) but kept for cornerstones
      // to preserve the entryUnlocksOn contract tests.
      _triggers: CODEX_TRIGGERS[e.id] || [],
    };
  }

  // ==========================================================================
  // EVENT SUBSCRIPTION
  // ==========================================================================

  /** @private Subscribe once to every distinct event referenced by triggers. */
  _setupListeners() {
    for (const entry of this.entries) {
      for (const trig of entry._triggers) {
        const evt = trig.event;
        if (!evt || this._subscribedEvents.has(evt)) continue;
        this._subscribedEvents.add(evt);
        eventBus.on(evt, (payload) => this._checkUnlocks(evt, payload));
      }
    }

    // Codex persistence — self-managed, mirroring SubsystemEvents. On save,
    // attach state to the bundle; on load, read via peek() (load() re-emits
    // PERSISTENCE_LOADED and would recurse).
    eventBus.on(Events.PERSISTENCE_GATHER, (saveData) => {
      if (!saveData) return;
      // Data-loss guard: if codex.json failed to load this session we have zero
      // entries. Writing getState() would persist an EMPTY codex and clobber a
      // prior save's earned unlocks. Preserve whatever was already persisted.
      if (this.entries.length === 0) {
        const prev = persistenceManager.peek();
        if (prev && prev.codex) saveData.codex = prev.codex;
        return;
      }
      saveData.codex = this.getState();
    });
    eventBus.on(Events.PERSISTENCE_LOADED, () => {
      const save = persistenceManager.peek();
      if (save && save.codex) this.restore(save.codex);
    });

    // Mark-seen when the viewer opens an entry.
    eventBus.on(Events.CODEX_VIEWED, (data) => {
      if (data && data.id) this.markSeen(data.id);
    });

    // Explicit unlock requests (e.g. TutorialSystem / deep-link grants).
    eventBus.on(Events.CODEX_UNLOCK_REQUEST, (data) => {
      if (data && data.id) {
        const entry = this._byId.get(data.id);
        if (entry && !entry.unlocked) this._queueUnlock(entry);
      }
    });

    // Slice 7 — cache the latest mothership altitude so _performUnlock can stamp
    // an unlock's location. Passive listener, independent of the trigger checks.
    eventBus.on(Events.PLAYER_TELEMETRY, (p) => {
      if (p && Number.isFinite(p.altitude)) this._lastAltKm = p.altitude;
    });
    // Reset the mission clock (and per-mission completion latches) on a new run.
    const resetMissionClock = () => { this._missionTime = 0; this._completionsFired.clear(); };
    eventBus.on(Events.MISSION_START, resetMissionClock);
    eventBus.on(Events.GAME_RESET, resetMissionClock);
  }

  // ==========================================================================
  // UNLOCK MECHANISM
  // ==========================================================================

  /**
   * Check all locked entries whose triggers include the fired event.
   * @private
   */
  _checkUnlocks(eventName, payload) {
    // GAME_WIN is terminal (update() stops draining the queue on the win
    // screen) — unlock matching entries immediately so a simultaneous endgame
    // batch all lands. _performUnlock guards !unlocked, so this stays safe.
    const immediate = (eventName === Events.GAME_WIN);
    const p = payload || {};
    for (const entry of this.entries) {
      if (entry.unlocked) continue;
      for (const trig of entry._triggers) {
        if (trig.event !== eventName) continue;
        let hit = false;
        try { hit = trig.match(p) === true; } catch (e) { hit = false; }
        if (hit) {
          if (immediate) this._performUnlock(entry);
          else this._queueUnlock(entry);
          break; // one matching trigger is enough
        }
      }
    }
  }

  /** @private Queue an entry for unlock (respecting cooldown). */
  _queueUnlock(entry) {
    if (entry.unlocked) return;
    if (this._unlockQueue.some(e => e.id === entry.id)) return;
    if (this._cooldownTimer <= 0 && this._unlockQueue.length === 0) {
      this._performUnlock(entry);
    } else {
      this._unlockQueue.push(entry);
    }
  }

  /** @private Perform the actual unlock — set flag, emit events, start cooldown. */
  _performUnlock(entry) {
    entry.unlocked = true;
    this._cooldownTimer = Constants.CODEX.UNLOCK_COOLDOWN;

    // Slice 7 — anchor the unlock in mission time + place. altKm may be null
    // (no telemetry yet, e.g. a headless test or the very first frame).
    entry.unlockContext = {
      tSim: Math.max(0, Math.round(this._missionTime)),
      altKm: Number.isFinite(this._lastAltKm) ? Math.round(this._lastAltKm) : null,
    };

    eventBus.emit(Events.CODEX_UNLOCKED, {
      id: entry.id, title: entry.title, shortText: entry.shortText,
      icon: entry.icon, category: entry.category,
    });
    eventBus.emit(Events.TECH_UNLOCKED, {
      id: entry.id, title: entry.title, shortText: entry.shortText,
      category: entry.category,
    });

    console.log(`[CodexSystem] Unlocked: ${entry.icon} ${entry.title}`);

    // Slice 7 — first-100% completion comms for the entry's category and track.
    this._checkCompletion(entry);
  }

  /**
   * @private Emit a single Houston line the first time the unlocked entry's
   * category or track reaches 100%. Arbiter-gated and reward-free: it rides the
   * decoupled COMMS_MESSAGE path (`_postOnboarding` passes at suppression tiers
   * ≥ 1), never `_critical`, and grants no credits/XP.
   * @param {object} entry the entry just unlocked
   */
  _checkCompletion(entry) {
    const catKey = `cat:${entry.category}`;
    if (!this._completionsFired.has(catKey)) {
      const p = this.getCategoryProgress(entry.category);
      if (p.total > 0 && p.unlocked === p.total) {
        this._completionsFired.add(catKey);
        const label = (this._categoryMeta[entry.category] && this._categoryMeta[entry.category].label) || entry.category;
        this._emitCompletionComms(`Full ${label} file logged. Good work up there, Cowboy.`);
      }
    }
    if (entry.track) {
      const tKey = `track:${entry.track}`;
      if (!this._completionsFired.has(tKey)) {
        const t = this.getTrack(entry.track);
        if (t && t.entries.length > 0 && t.entries.every(e => e.unlocked)) {
          this._completionsFired.add(tKey);
          const label = (t.meta && t.meta.label) || entry.track;
          this._emitCompletionComms(`That's the whole ${label} track, start to finish. Nicely done.`);
        }
      }
    }
  }

  /** @private Post a completion line on the decoupled, arbiter-gated comms path. */
  _emitCompletionComms(text) {
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'HOUSTON',
      text,
      channel: 'MISSION',
      priority: 'info',
      _postOnboarding: true,   // rides the CP-4 suppression ramp at tiers ≥ 1
      _codexCompletion: true,  // tag for tests / downstream filters
    });
  }

  // ==========================================================================
  // UPDATE (called every frame from the game loop)
  // ==========================================================================

  /** Tick the unlock cooldown and process queued unlocks. */
  update(dt) {
    // Slice 7 — advance the mission clock (only ticks during active play, since
    // the game loop calls this with the sim dt). Mirrors ConjunctionSystem.
    if (Number.isFinite(dt)) this._missionTime += dt;

    if (this._cooldownTimer > 0) this._cooldownTimer -= dt;

    if (this._cooldownTimer <= 0 && this._unlockQueue.length > 0) {
      const next = this._unlockQueue.shift();
      if (!next.unlocked) this._performUnlock(next);
      else if (this._unlockQueue.length > 0) this._cooldownTimer = 0;
    }
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /** @param {string} id @returns {object|null} */
  getEntry(id) { return this._byId.get(id) || null; }

  /**
   * The unlock triggers for an entry (multi-trigger). Exposed for tests +
   * tooling; each is `{ event, match(payload)→bool }`.
   * @param {string} id
   * @returns {Array<{event:string, match:(p:object)=>boolean}>}
   */
  getTriggers(id) {
    const entry = this._byId.get(id);
    return entry ? entry._triggers.slice() : [];
  }

  /**
   * True if any of an entry's triggers fires for the given event + payload.
   * @param {string} id
   * @param {string} eventName
   * @param {object} [payload]
   * @returns {boolean}
   */
  entryUnlocksOn(id, eventName, payload = {}) {
    const entry = this._byId.get(id);
    if (!entry) return false;
    return entry._triggers.some(t => {
      if (t.event !== eventName) return false;
      try { return t.match(payload) === true; } catch (e) { return false; }
    });
  }

  /**
   * TRL badge info for an entry.
   * @param {string} id
   * @returns {{trl:number, color:string, label:string, rationale:string}|null}
   */
  getEntryTRL(id) {
    const entry = this._byId.get(id);
    if (!entry || typeof entry.trl !== 'number') return null;   // no badge for non-tech entries
    const trl = entry.trl;
    return {
      trl,
      color: trlToBadgeColor(trl, Constants.TRL),
      label: trlToLabel(trl, Constants.TRL),
      rationale: entry.trlRationale || '',
    };
  }

  /** @param {string} category @returns {Array<object>} */
  getCategory(category) { return this.entries.filter(e => e.category === category); }

  /**
   * Per-category unlock progress.
   * @param {string} category
   * @returns {{ unlocked:number, total:number }}
   */
  getCategoryProgress(category) {
    const list = this.getCategory(category);
    return { unlocked: list.filter(e => e.unlocked).length, total: list.length };
  }

  /**
   * Ordered category metadata for the sidebar.
   * @returns {Array<{ key:string, label:string, icon:string, color:string, order:number }>}
   */
  getCategories() {
    const meta = this._categoryMeta;
    const keys = Object.keys(meta).length ? Object.keys(meta) : Object.keys(CodexCategory);
    return keys.map(key => ({
      key,
      label: (meta[key] && meta[key].label) || key,
      icon: (meta[key] && meta[key].icon) || '📄',
      color: (meta[key] && meta[key].color) || '#00d4ff',
      order: (meta[key] && typeof meta[key].order === 'number') ? meta[key].order : 999,
    })).sort((a, b) => a.order - b.order);
  }

  /** @param {string} key @returns {{label,icon,color,order}|null} */
  getCategoryMeta(key) { return this._categoryMeta[key] || null; }

  /** @returns {Object<string,{label,color,order}>} all track definitions */
  getTracks() { return this._tracks; }

  /**
   * A track's metadata + its entries in trackOrder.
   * @param {string} trackId
   * @returns {{ id:string, meta:object, entries:Array<object> }|null}
   */
  getTrack(trackId) {
    const meta = this._tracks[trackId];
    if (!meta) return null;
    const entries = this.entries
      .filter(e => e.track === trackId)
      .sort((a, b) => (a.trackOrder ?? 999) - (b.trackOrder ?? 999));
    return { id: trackId, meta, entries };
  }

  /**
   * Resolve an entry's related ids to entry objects (dangling ids dropped).
   * @param {string} id
   * @returns {Array<object>}
   */
  getRelated(id) {
    const entry = this._byId.get(id);
    if (!entry) return [];
    return entry.related.map(rid => this._byId.get(rid)).filter(Boolean);
  }

  /** @param {string} id @returns {string} */
  getUnlockHint(id) {
    const entry = this._byId.get(id);
    return entry ? (entry.unlockHint || 'Discover through gameplay.') : '';
  }

  /** Live search across ALL categories. @param {string} query @returns {Array<object>} */
  searchEntries(query) {
    if (!query) return this.entries;
    return this.entries.filter(e => entryMatchesQuery(e, query));
  }

  /** @returns {Array<object>} */
  getUnlockedEntries() { return this.entries.filter(e => e.unlocked); }

  /** @returns {{ unlocked:number, total:number, percentage:number }} */
  getProgress() {
    const unlocked = this.entries.filter(e => e.unlocked).length;
    const total = this.entries.length;
    return { unlocked, total, percentage: total > 0 ? Math.round((unlocked / total) * 100) : 0 };
  }

  /** @param {string} id mark an entry as seen (full text viewed). */
  markSeen(id) {
    const entry = this._byId.get(id);
    if (entry && entry.unlocked) entry.seen = true;
  }

  // ==========================================================================
  // PERSISTENCE
  // ==========================================================================

  /**
   * Serializable state for save game (versioned envelope so the codex slice can
   * migrate without touching the global SAVE_VERSION).
   * @returns {{ v:number, entries:Array<{id,unlocked,seen}> }}
   */
  getState() {
    return {
      v: 2,
      entries: this.entries.map(e => {
        const o = { id: e.id, unlocked: e.unlocked, seen: e.seen };
        // Slice 7 — additive: persist unlock context when present. Old (v1)
        // saves simply lack `ctx`; the restore path tolerates its absence.
        if (e.unlockContext) o.ctx = e.unlockContext;
        return o;
      }),
    };
  }

  /**
   * Restore from save data. Accepts the versioned envelope `{ v, entries }` or a
   * legacy bare array; retired ids migrate through ALIASES; union semantics so a
   * merged-away id can't clobber a survivor already unlocked by an earlier line.
   * @param {{ v?:number, entries?:Array }|Array} data
   */
  restore(data) {
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.entries) ? data.entries : null);
    if (!list) return;

    let restored = 0;
    for (const saved of list) {
      if (!saved || !saved.id) continue;
      const id = ALIASES[saved.id] || saved.id;
      const entry = this._byId.get(id);
      if (!entry) continue;
      entry.unlocked = entry.unlocked || !!saved.unlocked;
      entry.seen = entry.seen || !!saved.seen;
      // Slice 7 — restore unlock context if the save carried it (v2+); old saves
      // and startUnlocked entries simply have none.
      if (saved.ctx && typeof saved.ctx === 'object' && !entry.unlockContext) {
        entry.unlockContext = saved.ctx;
      }
      if (saved.unlocked) restored++;
    }
    console.log(`[CodexSystem] Restored ${restored} unlocked entries from save`);
  }
}

export default CodexSystem;
