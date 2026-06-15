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

const SETTINGS_KEY = 'sc_settings_v1';

class SettingsManager {
  constructor() {
    /** @type {{ language: string }} */
    this._settings = { language: DEFAULT_LANGUAGE };
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
}

export const settingsManager = new SettingsManager();
export default settingsManager;
