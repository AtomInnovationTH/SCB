/**
 * SettingsManager.js — persistent user preferences (load in ctor, save on change). Singleton `settingsManager`.
 *
 * Stored in its OWN localStorage key (`sc_settings_v1`), separate from the game save (`spacecowboy_save_v1`):
 * `persistenceManager.deleteSave()` wipes the save on every New Game, and a preference like language belongs to
 * the player, not the run.
 *
 * @module systems/SettingsManager
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { DEFAULT_LANGUAGE, isSupportedLanguage, getLanguage } from '../core/Languages.js';
import { StorageKeys } from '../core/StorageKeys.js';

const SETTINGS_KEY = StorageKeys.SETTINGS;

/** 'auto' = behavior-driven (GuidanceDirector). */
const GUIDANCE_VALUES = ['auto', 'GUIDED', 'POINTERS', 'MINIMAL'];

class SettingsManager {
  constructor() {
    /** @type {{ language: string, guidance: string, autolock: boolean, constellations: boolean }} */
    this._settings = { language: DEFAULT_LANGUAGE, guidance: 'auto', autolock: true, constellations: false };
    this._load();
  }

  /** @private Validated load; private-mode safe. */
  _load() {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (isSupportedLanguage(parsed.language)) {
          this._settings.language = parsed.language;
        }
        if (GUIDANCE_VALUES.includes(parsed.guidance)) {
          this._settings.guidance = parsed.guidance;
        }
        if (typeof parsed.autolock === 'boolean') {
          this._settings.autolock = parsed.autolock;
        }
        // owner 2026-09-07: constellations default OFF (same as the Starfield ships); only real booleans accepted,
        // anything else keeps the OFF default (a fresh profile starts clean).
        if (typeof parsed.constellations === 'boolean') {
          this._settings.constellations = parsed.constellations;
        }
      }
    } catch (_) { /* corrupt / blocked storage — keep defaults */ }
  }

  /** @private Non-fatal on failure. */
  _save() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this._settings));
    } catch (_) { /* private mode / quota — ignore */ }
  }

  /** @returns {string} Active language code (always a supported code). */
  getLanguage() {
    return this._settings.language;
  }

  /** @returns {import('../core/Languages.js').LanguageEntry} Full active entry (flag + start city + labels). */
  getLanguageEntry() {
    return getLanguage(this._settings.language);
  }

  /** Persists; emits Events.LANGUAGE_CHANGED (with the resolved entry) only on a change. @returns {boolean} changed */
  setLanguage(code) {
    if (!isSupportedLanguage(code) || code === this._settings.language) return false;
    this._settings.language = code;
    this._save();
    eventBus.emit(Events.LANGUAGE_CHANGED, { code, lang: getLanguage(code) });
    return true;
  }

  /** @returns {string} 'auto' (behavior-driven) or a pinned level ('GUIDED' | 'POINTERS' | 'MINIMAL'). */
  getGuidance() {
    return this._settings.guidance || 'auto';
  }

  /** 'auto' returns control to GuidanceDirector; a level pins it. Persists + emits GUIDANCE_LEVEL_CHANGED. @returns {boolean} changed */
  setGuidance(value) {
    if (!GUIDANCE_VALUES.includes(value) || value === this._settings.guidance) return false;
    this._settings.guidance = value;
    this._save();
    eventBus.emit(Events.GUIDANCE_LEVEL_CHANGED, {
      level: value === 'auto' ? null : value,
      reason: 'settings',
    });
    return true;
  }

  /** @returns {boolean} whether the front-arc autolock assist is enabled (missing value = true). */
  getAutolock() {
    return this._settings.autolock !== false;
  }

  /** Persists + emits AUTOLOCK_SETTING_CHANGED (AutoLockController honors it). @returns {boolean} changed */
  setAutolock(on) {
    const v = !!on;
    if (v === this._settings.autolock) return false;
    this._settings.autolock = v;
    this._save();
    if (Events.AUTOLOCK_SETTING_CHANGED) {
      eventBus.emit(Events.AUTOLOCK_SETTING_CHANGED, { enabled: v });
    }
    return true;
  }

  /**
   * @returns {boolean} whether the constellation outlines + labels are shown. The OFF default matches what Starfield
   *  ships (objects born hidden), so the menu backdrop (the same live sky) is clean too. Unlike getAutolock there is
   *  no missing-value fallback to true.
   */
  getConstellations() {
    return !!this._settings.constellations;
  }

  /** Persists. Emits NO event (nothing listens). @returns {boolean} changed */
  setConstellations(on) {
    const v = !!on;
    if (v === this._settings.constellations) return false;
    this._settings.constellations = v;
    this._save();
    return true;
  }
}
export const settingsManager = new SettingsManager();
export default settingsManager;
