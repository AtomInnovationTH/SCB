/**
 * Languages.js — Supported menu languages and the player identity each one
 * carries: the astronaut shoulder-patch flag and the home region the mission
 * starts over (the "mother passes over your cities" touch).
 *
 * Pure data + Node-safe helpers — no DOM/THREE dependency, so it can be unit
 * tested headless and imported by both UI (MenuScreen / MenuScene3D) and
 * gameplay (GameFlowManager start-orbit placement).
 *
 * NOTE ON SCOPE: this is currently an identity/region selector, not a full
 * string-translation layer (the game UI is still authored in English). The
 * selector persists the choice, swaps the EVA suit flag and sets the starting
 * ground track; a future i18n layer can subscribe to Events.LANGUAGE_CHANGED
 * and translate strings against these same `code`s.
 *
 * @module core/Languages
 */

/**
 * @typedef {Object} LanguageEntry
 * @property {string} code     BCP-47-ish short code ('en','hi','ta','ja','th','es')
 * @property {string} label    English name of the language
 * @property {string} native   Endonym (the language's own name)
 * @property {string} flag     Flag code understood by FlagDecalSystem painters
 *                             (USA/IND/JPN/THA/ESP …) — drawn on the EVA patch
 * @property {{ name:string, lat:number, lon:number }} start
 *                             Representative home city the mission starts over.
 *                             lat in degrees N, lon in degrees E (negative = W).
 */

/**
 * Supported languages, in menu display order.
 *
 * Start cities are all below the player's default 51.6° orbital inclination, so
 * the regional start only needs RAAN + true-anomaly placement (no plane change)
 * — see GameFlowManager._applyStartLocation / OrbitalMechanics.subPointToOrbit.
 *
 * @type {LanguageEntry[]}
 */
export const LANGUAGES = [
  { code: 'en', label: 'English',  native: 'English',  flag: 'USA',
    start: { name: 'Houston',   lat: 29.76, lon: -95.37 } },   // Mission Control
  { code: 'hi', label: 'Hindi',    native: 'हिन्दी',   flag: 'IND',
    start: { name: 'New Delhi', lat: 28.61, lon: 77.21 } },
  { code: 'ta', label: 'Tamil',    native: 'தமிழ்',    flag: 'IND',
    start: { name: 'Chennai',   lat: 13.08, lon: 80.27 } },     // ISRO / Sriharikota region
  { code: 'ja', label: 'Japanese', native: '日本語',    flag: 'JPN',
    start: { name: 'Tokyo',     lat: 35.68, lon: 139.69 } },
  { code: 'th', label: 'Thai',     native: 'ไทย',      flag: 'THA',
    start: { name: 'Bangkok',   lat: 13.75, lon: 100.49 } },
  { code: 'es', label: 'Spanish',  native: 'Español',  flag: 'ESP',
    start: { name: 'Madrid',    lat: 40.42, lon: -3.70 } },
];

/** Default language code when nothing is stored / an unknown code is supplied. */
export const DEFAULT_LANGUAGE = 'en';

const _BY_CODE = LANGUAGES.reduce((m, l) => { m[l.code] = l; return m; }, {});

/**
 * Resolve a language entry by code, falling back to the default.
 * @param {string} code
 * @returns {LanguageEntry}
 */
export function getLanguage(code) {
  return _BY_CODE[code] || _BY_CODE[DEFAULT_LANGUAGE];
}

/**
 * Whether a code maps to a supported language.
 * @param {string} code
 * @returns {boolean}
 */
export function isSupportedLanguage(code) {
  return Object.prototype.hasOwnProperty.call(_BY_CODE, code);
}

// CJS guard so Node test runner can require() these pure helpers.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LANGUAGES, DEFAULT_LANGUAGE, getLanguage, isSupportedLanguage };
}

export default LANGUAGES;
