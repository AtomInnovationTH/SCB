/**
 * @module core/Languages — supported menu languages and the player identity each carries: the astronaut shoulder-patch
 * flag and the home region the mission starts over ("mother passes over your cities").
 * Pure data + Node-safe helpers (no DOM/THREE), imported by UI (MenuScreen / MenuScene3D) and gameplay
 * (GameFlowManager start-orbit placement). Scope: an identity/region selector, not a string-translation layer
 * (the UI is authored in English); it persists the choice, swaps the EVA suit flag and sets the starting ground track.
 * A future i18n layer can subscribe to Events.LANGUAGE_CHANGED and translate against these `code`s.
 */

/**
 * @typedef {Object} LanguageEntry
 * @property {string} code     BCP-47-ish short code ('en','hi','ta','ja','th','es','pt')
 * @property {string} label    English name
 * @property {string} native   Endonym
 * @property {string} flag     Flag code for FlagDecalSystem painters (USA/IND/JPN/THA/ESP/BRA …), drawn on the EVA
 * patch
 * @property {{ name:string, lat:number, lon:number }} start  Anchor sub-point the opening pass is aimed over
 * (lat °N, lon °E, negative = W). ANCHOR RULE: start.lat must be ≤ incDeg, else
 *   subPointToOrbit() clamps to the highest reachable parallel and the pass misses the anchor; for homelands above the
 *   tilt the anchor is offshore at lat ≈ incDeg near the country's longitude.
 * @property {number} [incDeg] Starting orbital inclination (deg), from the nation's real launch latitude; default 51.6°
 * (ISS band). VISIBILITY RULE: a homeland reads as a usable reference
 *   when its latitude ≤ incDeg + ~10° (off-track but in view near the limb from 350 km).
 * @property {boolean} [descending] Aim the anchor on the southbound pass instead of the default northbound one
 * (when the interesting corridor lies on the descending half).
 */

/**
 * Supported languages, in menu display order.
 *
 * START-ORBIT MODEL: each language carries an `incDeg` from its nation's real launch geography
 * (Japan/Tanegashima ≈30°, Brazil/Alcântara ≈5°, India/Sriharikota Sun-synch 97.5° or low-LEO 18°). The opening pass is
 * aimed by subPointToOrbit(start.lat, start.lon, incDeg→rad), which sets RAAN + true anomaly so the ground track
 * crosses the anchor; altitude is fixed at 350 km. There is always debris to clear: the welcome field spawns in the
 * player's own orbit (inherits incDeg) and the scattered cluster seeds ~5–85°
 * (GameFlowManager._applyStartLocation / OrbitalMechanics.subPointToOrbit / DebrisField).
 *
 * English: inclination 51.6° (ISS band). The anchor is NOT Gulf of Guinea 0/0: the Earth mesh does not rotate, so that
 * corridor was ~40 % empty Pacific, touching neither USA nor Europe. Corridor: ascending node 63.0°E, opening pass Nova
 * Scotia → New York → Norfolk → New Orleans → Mexico City, later Suez/Nile → Athens → Rome → Paris → London.
 *
 * @type {LanguageEntry[]}
 */
export const LANGUAGES = [
  { code: 'en', label: 'English',  native: 'English',  flag: 'USA', incDeg: 51.6, descending: true,
    start: { name: 'New York', lat: 40.71, lon: -74.01 } },
  { code: 'th', label: 'Thai',     native: 'ไทย',      flag: 'THA', incDeg: 28.5,
    start: { name: 'Bangkok',   lat: 13.76, lon: 100.50 } }, // Thailand / GISTDA — regional low LEO
  { code: 'ja', label: 'Japanese', native: '日本語',    flag: 'JPN', incDeg: 30.0,
    start: { name: 'South of Honshu', lat: 28.0, lon: 135.0 } }, // Japan / JAXA — Tanegashima 30.4°N; anchor offshore S of Honshu (Tokyo 35.7° sits just N of track)
  { code: 'es', label: 'Spanish',  native: 'Español',  flag: 'ESP', incDeg: 45.0,
    start: { name: 'Madrid',    lat: 40.42, lon: -3.70 } },     // Spain / ESA — plausible mid-LEO over Iberia (no national pad)
  { code: 'pt', label: 'Portuguese', native: 'Português', flag: 'BRA', incDeg: 5.0,
    start: { name: 'Amazon', lat: -3.10, lon: -60.02 } },  // Brazil / AEB — Alcântara 2.3°S equatorial launch
  { code: 'hi', label: 'Hindi',    native: 'हिन्दी',   flag: 'IND', incDeg: 97.5,
    start: { name: 'New Delhi', lat: 28.61, lon: 77.21 } },    // India / ISRO — Sriharikota; Sun-synch = densest debris regime
  { code: 'ta', label: 'Tamil',    native: 'தமிழ்',    flag: 'IND', incDeg: 18.0,
    start: { name: 'Chennai',   lat: 13.08, lon: 80.27 } },     // India / ISRO — Sriharikota 13.7°N (Tamil region), low LEO
];

/** Default language when nothing is stored / an unknown code is supplied: Thai
 *  (owner 2026-10-26: "make Thai the default"): a new player starts over Bangkok at 28.5° with the Thai patch and
 *  Thailand's "(more)" open in the menu. A stored pick keeps its language. */
export const DEFAULT_LANGUAGE = 'th';

const _BY_CODE = LANGUAGES.reduce((m, l) => { m[l.code] = l; return m; }, {});

/** Resolve a language entry by code, falling back to the default. */
export function getLanguage(code) {
  return _BY_CODE[code] || _BY_CODE[DEFAULT_LANGUAGE];
}

/** Whether a code maps to a supported language. */
export function isSupportedLanguage(code) {
  return Object.prototype.hasOwnProperty.call(_BY_CODE, code);
}

// CJS guard so Node test runner can require() these pure helpers.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LANGUAGES, DEFAULT_LANGUAGE, getLanguage, isSupportedLanguage };
}

export default LANGUAGES;
