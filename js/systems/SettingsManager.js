/**
 * SettingsManager.js — Lightweight persistent user preferences.
 *
 * Stored in its OWN localStorage key (`sc_settings_v1`), deliberately separate
 * from the game save (`spacecowboy_save_v1`). That save is wiped by
 * `persistenceManager.deleteSave()` on every New Game, so a preference like the
 * chosen language must NOT live there — it belongs to the player, not the run.
 *
 * Mirrors the small self-persisting pattern used by CityLabels (load in ctor,
 * save on change). Singleton export `settingsManager`.
 *
 * @module systems/SettingsManager
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { DEFAULT_LANGUAGE, isSupportedLanguage, getLanguage } from '../core/Languages.js';
import { StorageKeys } from '../core/StorageKeys.js';

const SETTINGS_KEY = StorageKeys.SETTINGS;

/** Guidance preference values. 'auto' = behavior-driven (GuidanceDirector). */
const GUIDANCE_VALUES = ['auto', 'GUIDED', 'POINTERS', 'MINIMAL'];

class SettingsManager {
  constructor() {
    /** @type {{ language: string, guidance: string, autolock: boolean }} */
    this._settings = { language: DEFAULT_LANGUAGE, guidance: 'auto', autolock: true };
    this._load();
  }

  /** @private Load + validate from localStorage (private-mode safe). */
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
      }
    } catch (_) { /* corrupt / blocked storage — keep defaults */ }
  }

  /** @private Persist current settings (non-fatal on failure). */
  _save() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this._settings));
    } catch (_) { /* private mode / quota — ignore */ }
  }

  /** @returns {string} The active language code (always a supported code). */
  getLanguage() {
    return this._settings.language;
  }

  /**
   * @returns {import('../core/Languages.js').LanguageEntry} Full active entry
   *          (flag + start city + labels).
   */
  getLanguageEntry() {
    return getLanguage(this._settings.language);
  }

  /**
   * Set the active language. Persists and (when it actually changed) emits
   * Events.LANGUAGE_CHANGED with the resolved entry.
   * @param {string} code
   * @returns {boolean} true if the value changed
   */
  setLanguage(code) {
    if (!isSupportedLanguage(code) || code === this._settings.language) return false;
    this._settings.language = code;
    this._save();
    eventBus.emit(Events.LANGUAGE_CHANGED, { code, lang: getLanguage(code) });
    return true;
  }

  /**
   * @returns {string} Guidance preference: 'auto' (behavior-driven) or a pinned
   *          level ('GUIDED' | 'POINTERS' | 'MINIMAL').
   */
  getGuidance() {
    return this._settings.guidance || 'auto';
  }

  /**
   * Set the guidance preference. 'auto' returns control to the behavior-driven
   * GuidanceDirector; a level pins it. Persists + emits GUIDANCE_LEVEL_CHANGED.
   * @param {string} value
   * @returns {boolean} true if the value changed
   */
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

  /** @returns {boolean} whether the front-arc autolock assist is enabled. */
  getAutolock() {
    return this._settings.autolock !== false;
  }

  /**
   * Enable/disable the front-arc autolock assist. Persists + emits a settings
   * event the AutoLockController honors.
   * @param {boolean} on
   * @returns {boolean} true if the value changed
   */
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
}

export const settingsManager = new SettingsManager();
export default settingsManager;
