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
 * @property {string} code     BCP-47-ish short code ('en','hi','ta','ja','th','es','pt')
 * @property {string} label    English name of the language
 * @property {string} native   Endonym (the language's own name)
 * @property {string} flag     Flag code understood by FlagDecalSystem painters
 *                             (USA/IND/JPN/THA/ESP/BRA …) — drawn on the EVA patch
 * @property {{ name:string, lat:number, lon:number }} start
 *                             Anchor sub-point the opening pass is aimed over.
 *                             lat in degrees N, lon in degrees E (negative = W).
 *                             ANCHOR RULE: start.lat must be ≤ incDeg, else
 *                             subPointToOrbit() clamps to the highest reachable
 *                             parallel and the pass misses the anchor. For
 *                             homelands above the tilt the anchor is offshore at
 *                             lat ≈ incDeg near the country's longitude.
 * @property {number} [incDeg] Starting orbital inclination (degrees), derived
 *                             from the nation's real launch latitude. Default
 *                             51.6° (ISS band) when omitted. VISIBILITY RULE: a
 *                             homeland reads as a usable reference when its
 *                             latitude ≤ incDeg + ~10° (off-track but in view
 *                             near the limb from 350 km).
 * @property {string} [sight]  Iconic landmark called out in opening comms as the
 *                             player's reference point. Omitted → no callout.
 */

/**
 * Supported languages, in menu display order.
 *
 * START-ORBIT MODEL: each language carries an `incDeg` derived from its nation's
 * real launch geography (e.g. Japan/Tanegashima ≈30°, Brazil/Alcântara ≈5°,
 * India/Sriharikota Sun-synch 97.5° or low-LEO 18°). The opening pass is aimed
 * by subPointToOrbit(start.lat, start.lon, incDeg→rad), which sets RAAN + true
 * anomaly so the ground track crosses the anchor sub-point; inclination is set
 * to incDeg. Altitude is fixed at 350 km for all starts. There is always debris
 * to clear: the welcome field spawns in the player's own orbit (inherits incDeg)
 * and the scattered debris cluster seeds ~5–85° — see GameFlowManager.
 * _applyStartLocation / OrbitalMechanics.subPointToOrbit / DebrisField.
 *
 * English is LOCKED to the original default route (Gulf of Guinea 0°N/0°E,
 * 51.6°, raan=0, ν=0) — do not change it.
 *
 * @type {LanguageEntry[]}
 */
export const LANGUAGES = [
  { code: 'en', label: 'English',  native: 'English',  flag: 'USA', incDeg: 51.6,
    start: { name: 'Gulf of Guinea', lat: 0, lon: 0 }, sight: 'West African coast' },  // LOCKED original default route: ascending node at 0°N 0°E (raan=0, ν=0); first labeled city the ground track climbs over is Abidjan
  { code: 'th', label: 'Thai',     native: 'ไทย',      flag: 'THA', incDeg: 28.5,
    start: { name: 'Bangkok',   lat: 13.76, lon: 100.50 }, sight: 'Gulf of Thailand' }, // Thailand / GISTDA — regional low LEO
  { code: 'ja', label: 'Japanese', native: '日本語',    flag: 'JPN', incDeg: 30.0,
    start: { name: 'South of Honshu', lat: 28.0, lon: 135.0 }, sight: 'Mt Fuji' },      // Japan / JAXA — Tanegashima 30.4°N; anchor offshore S of Honshu (Tokyo 35.7° sits just N of track)
  { code: 'es', label: 'Spanish',  native: 'Español',  flag: 'ESP', incDeg: 45.0,
    start: { name: 'Madrid',    lat: 40.42, lon: -3.70 }, sight: 'Pyrenees' },          // Spain / ESA — plausible mid-LEO over Iberia (no national pad)
  { code: 'pt', label: 'Portuguese', native: 'Português', flag: 'BRA', incDeg: 5.0,
    start: { name: 'Amazon', lat: -3.10, lon: -60.02 }, sight: 'Amazon Rainforest' },   // Brazil / AEB — Alcântara 2.3°S equatorial launch
  { code: 'hi', label: 'Hindi',    native: 'हिन्दी',   flag: 'IND', incDeg: 97.5,
    start: { name: 'New Delhi', lat: 28.61, lon: 77.21 }, sight: 'Himalayas' },         // India / ISRO — Sriharikota; Sun-synch = densest debris regime
  { code: 'ta', label: 'Tamil',    native: 'தமிழ்',    flag: 'IND', incDeg: 18.0,
    start: { name: 'Chennai',   lat: 13.08, lon: 80.27 }, sight: 'Western Ghats' },     // India / ISRO — Sriharikota 13.7°N (Tamil region), low LEO
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
