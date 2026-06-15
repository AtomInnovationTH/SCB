/**
 * CatalogLoader.js — ST-6.1 offline data-catalogue service
 *
 * Boots by fetching `/data/META.json` then pulling the listed files in
 * parallel. Caches results in Maps keyed by norad/id for O(1) lookup so
 * hot-path callers (DebrisField, ArmManager, SpaceWeatherSystem) can read
 * without re-parsing JSON.
 *
 * **Back-compat invariant:** if initialization fails (offline mode, 404,
 * reject) the loader resolves anyway with empty catalogues. Every getter
 * returns null / [] gracefully so downstream modules can fall back to their
 * pre-ST-6.1 procedural/random behaviour.
 *
 * **Node-safe:** no THREE.js, no DOM. `init()` accepts an optional
 * `fetchImpl` dependency-injection so unit tests can stub network I/O.
 *
 * @module systems/CatalogLoader
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/** Minimal timeout wrapper around a fetch promise.
 *  @param {Promise} p
 *  @param {number} ms
 *  @returns {Promise}
 */
function _withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`CatalogLoader: fetch timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** Resolve a fetch implementation: injected > global > throw.
 *  @param {Function|null} injected
 *  @returns {Function}
 */
function _resolveFetch(injected) {
  if (typeof injected === 'function') return injected;
  if (typeof fetch === 'function') return fetch;
  // Last-ditch: node's global may still be undefined — caller should inject.
  throw new Error('CatalogLoader: no fetch implementation available (inject fetchImpl for Node).');
}

// ============================================================================
// CATALOG LOADER
// ============================================================================

export class CatalogLoader {
  constructor() {
    this._ready = false;
    this._meta = null;

    /** @type {Map<string, object>} norad → debris entry */
    this._debrisByNorad = new Map();
    /** @type {object[]} */
    this._debrisList = [];

    /** @type {Map<string, object>} norad → active-sat entry */
    this._activeByNorad = new Map();
    /** @type {object[]} */
    this._activeList = [];

    /** @type {Map<string, object>} id → launch entry */
    this._launchById = new Map();
    /** @type {object[]} */
    this._launchList = [];

    /** @type {Map<string, object>} id → ground-station entry */
    this._groundById = new Map();
    /** @type {object[]} */
    this._groundList = [];

    /** @type {Map<string, object>} id → constellation entry */
    this._constellationById = new Map();

    /** @type {object} Space-weather payload { cycle_start_game_hour, cycle_length_game_hours, events[] } */
    this._weather = { cycle_start_game_hour: 0, cycle_length_game_hours: 0, events: [] };
  }

  // --------------------------------------------------------------------------
  // INIT
  // --------------------------------------------------------------------------

  /**
   * Fetch META + all listed files. Always resolves (never rejects).
   * @param {{ fetchImpl?: Function, basePath?: string }} [opts]
   * @returns {Promise<boolean>} true on success, false on any fetch failure.
   */
  async init(opts = {}) {
    const C = Constants.CATALOG || {};
    const basePath = opts.basePath || C.BASE_PATH || './data/';
    const metaFile = C.META_FILE || 'META.json';
    const timeoutMs = C.LOAD_TIMEOUT_MS || 10000;
    let fetchFn;
    try {
      fetchFn = _resolveFetch(opts.fetchImpl);
    } catch (e) {
      console.error('[CatalogLoader]', e.message, '. Falling back to empty catalogue.');
      this._ready = false;
      this._emitLoaded(false);
      return false;
    }

    const fetchJson = async (path) => {
      const res = await _withTimeout(fetchFn(path), timeoutMs);
      if (!res || typeof res.json !== 'function') {
        throw new Error(`CatalogLoader: bad response from ${path}`);
      }
      if (res.ok === false) {
        throw new Error(`CatalogLoader: ${res.status || 'HTTP error'} for ${path}`);
      }
      return res.json();
    };

    try {
      this._meta = await fetchJson(basePath + metaFile);
      const files = Array.isArray(this._meta.files) ? this._meta.files.slice() : [];
      // Drop META itself if it's listed (defensive)
      const payloadFiles = files.filter(f => f && f !== metaFile);

      // Parallel fetch — Promise.all resolves with array in order.
      const results = await Promise.all(
        payloadFiles.map(f => fetchJson(basePath + f)
          .then(j => ({ file: f, data: j }))
          .catch(err => ({ file: f, data: null, error: err })))
      );

      for (const r of results) {
        if (!r.data) {
          console.warn(`[CatalogLoader] Failed to load ${r.file}:`, r.error && r.error.message);
          continue;
        }
        this._ingest(r.file, r.data);
      }

      this._ready = true;
      this._emitLoaded(true);
      console.log(`[CatalogLoader] OK. ${this._debrisList.length} debris, ${this._activeList.length} active sats, ${this._launchList.length} launches, ${this._weather.events.length} weather events, ${this._groundList.length} ground stations, ${this._constellationById.size} constellations.`);
      return true;
    } catch (e) {
      console.error('[CatalogLoader] init failed:', e.message, '. Falling back to empty catalogue.');
      this._ready = false;
      this._emitLoaded(false);
      return false;
    }
  }

  /** @private Route a parsed JSON payload to the correct index. */
  _ingest(fileName, data) {
    switch (fileName) {
      case 'debris-catalog.json':
        if (!Array.isArray(data)) return;
        for (const e of data) {
          if (e && e.norad) this._debrisByNorad.set(String(e.norad), e);
          this._debrisList.push(e);
        }
        break;

      case 'active-sats.json':
        if (!Array.isArray(data)) return;
        for (const e of data) {
          if (e && e.norad) this._activeByNorad.set(String(e.norad), e);
          this._activeList.push(e);
        }
        break;

      case 'launches.json':
        if (!Array.isArray(data)) return;
        for (const e of data) {
          if (e && e.id) this._launchById.set(String(e.id), e);
          this._launchList.push(e);
        }
        break;

      case 'space-weather.json':
        if (data && Array.isArray(data.events)) {
          // Sort by game_hour ascending — guarantees chronological replay
          const sorted = data.events.slice().sort((a, b) => (a.game_hour || 0) - (b.game_hour || 0));
          this._weather = {
            cycle_start_game_hour: data.cycle_start_game_hour || 0,
            cycle_length_game_hours: data.cycle_length_game_hours || 0,
            events: sorted,
          };
        }
        break;

      case 'ground-stations.json':
        if (!Array.isArray(data)) return;
        for (const e of data) {
          if (e && e.id) this._groundById.set(String(e.id), e);
          this._groundList.push(e);
        }
        break;

      case 'constellations.json':
        if (!Array.isArray(data)) return;
        for (const e of data) {
          if (e && e.id) this._constellationById.set(String(e.id), e);
        }
        break;

      default:
        // Unknown file — store raw on meta for future readers.
        break;
    }
  }

  /** @private */
  _emitLoaded(ok) {
    const counts = {
      debris: this._debrisList.length,
      active_sats: this._activeList.length,
      launches: this._launchList.length,
      weather_events: this._weather.events.length,
      ground_stations: this._groundList.length,
      constellations: this._constellationById.size,
    };
    const version = this._meta && this._meta.version ? this._meta.version : null;
    try {
      eventBus.emit(Events.CATALOG_LOADED, { ready: ok, counts, version });
    } catch (_) {
      // eventBus may be absent in some test harnesses — safe to swallow.
    }
  }

  // --------------------------------------------------------------------------
  // STATE
  // --------------------------------------------------------------------------

  /** @returns {boolean} */
  isReady() { return this._ready; }

  /** @returns {object|null} META object or null if not loaded. */
  getMeta() { return this._meta; }

  // --------------------------------------------------------------------------
  // DEBRIS
  // --------------------------------------------------------------------------

  /** @param {string|number} noradId @returns {object|null} */
  getDebrisByNorad(noradId) {
    if (noradId == null) return null;
    return this._debrisByNorad.get(String(noradId)) || null;
  }

  /** @returns {object[]} */
  getAllDebris() { return this._debrisList.slice(); }

  // --------------------------------------------------------------------------
  // ACTIVE SATELLITES
  // --------------------------------------------------------------------------

  /** @param {string|number} noradId @returns {object|null} */
  getActiveSat(noradId) {
    if (noradId == null) return null;
    return this._activeByNorad.get(String(noradId)) || null;
  }

  /** @returns {object[]} */
  getAllActiveSats() { return this._activeList.slice(); }

  // --------------------------------------------------------------------------
  // LAUNCHES
  // --------------------------------------------------------------------------

  /** @param {string} id @returns {object|null} */
  getLaunch(id) {
    if (id == null) return null;
    return this._launchById.get(String(id)) || null;
  }

  /** @returns {object[]} */
  getAllLaunches() { return this._launchList.slice(); }

  // --------------------------------------------------------------------------
  // GROUND STATIONS
  // --------------------------------------------------------------------------

  /** @param {string} id @returns {object|null} */
  getGroundStation(id) {
    if (id == null) return null;
    return this._groundById.get(String(id)) || null;
  }

  /** @returns {object[]} */
  getAllGroundStations() { return this._groundList.slice(); }

  // --------------------------------------------------------------------------
  // CONSTELLATIONS
  // --------------------------------------------------------------------------

  /** @param {string} id @returns {object|null} */
  getConstellation(id) {
    if (id == null) return null;
    return this._constellationById.get(String(id)) || null;
  }

  // --------------------------------------------------------------------------
  // SPACE WEATHER (seeded timeline)
  // --------------------------------------------------------------------------

  /** @returns {object[]} All weather events (sorted by game_hour ascending). */
  getAllWeatherEvents() { return this._weather.events.slice(); }

  /** Return events scheduled at or before a given game hour.
   *  @param {number} gameHour
   *  @returns {object[]} */
  getWeatherEventsUpTo(gameHour) {
    if (gameHour == null || gameHour < 0) return [];
    return this._weather.events.filter(e => (e.game_hour || 0) <= gameHour);
  }

  /** Return the next scheduled event strictly after gameHour (or null if past end).
   *  @param {number} gameHour
   *  @returns {object|null} */
  getNextWeatherEvent(gameHour) {
    if (gameHour == null) return null;
    for (const e of this._weather.events) {
      if ((e.game_hour || 0) > gameHour) return e;
    }
    return null;
  }

  /** @returns {{ cycle_start_game_hour: number, cycle_length_game_hours: number }} */
  getWeatherCycle() {
    return {
      cycle_start_game_hour: this._weather.cycle_start_game_hour,
      cycle_length_game_hours: this._weather.cycle_length_game_hours,
    };
  }
}

// ============================================================================
// SINGLETON (imported directly, matches the project's singleton pattern)
// ============================================================================
export const catalogLoader = new CatalogLoader();

// ============================================================================
// CJS GUARD — expose for Node tests (can stub fetchImpl)
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CatalogLoader, catalogLoader };
}
