/**
 * CatalogConverter.js — ST-6.1 pure helpers that convert catalogue entries
 * (e.g. from [`CatalogLoader`](js/systems/CatalogLoader.js:1)) into debris data
 * objects compatible with [`DebrisField`](js/entities/DebrisField.js:1).
 *
 * **Node-safe:** no THREE.js, no DOM. Exists as a separate module so unit
 * tests can verify the hybrid-mode split (real entries + procedural filler)
 * without importing [`DebrisField`](js/entities/DebrisField.js:1) (which pulls
 * in Three.js).
 *
 * The helper performs the cheap TLE-stub → Keplerian conversion ONCE per
 * entry at boot; DebrisField then owns propagation on the normal update tick.
 *
 * @module entities/CatalogConverter
 */

import { Constants } from '../core/Constants.js';
import { deriveCaptureFlags } from './debrisFerrous.js';

// ============================================================================
// TYPE MAPPING: catalogue "type" → internal debris type key
// (matches DEBRIS_TYPES in DebrisField.js)
// ============================================================================

/** @type {Object<string,string>} */
const TYPE_MAP = {
  debris:        'fragment',
  rocket_body:   'rocketBody',
  inactive:      'defunctSat',
  active:        'defunctSat',   // never spawned into DebrisField anyway
  mission_debris:'missionDebris',
};

/** Shape hint per type — mirrors DebrisField's DEBRIS_TYPES.shape values. */
const SHAPE_MAP = {
  fragment:     'icosahedron',
  rocketBody:   'cylinder',
  defunctSat:   'box',
  missionDebris:'sphere',
  cubesat:      'box',
};

/** Material pool — mirrors the `MATERIALS` array in DebrisField.js. */
const MATERIALS = ['aluminum', 'titanium', 'composite', 'mli_mylar', 'solar_cell', 'steel'];

/** Per-type material weights — mirrors MATERIAL_WEIGHTS_BY_TYPE in DebrisField.js.
 *  Keeps gold MLI / blue solar cells rare and concentrated on satellites so the
 *  catalogue half of the field matches the procedural half visually. */
const MATERIAL_WEIGHTS_BY_TYPE = {
  fragment:      { aluminum: 0.36, titanium: 0.21, composite: 0.31, steel: 0.05, mli_mylar: 0.06, solar_cell: 0.06 },
  rocketBody:    { aluminum: 0.45, titanium: 0.25, composite: 0.12, steel: 0.18 },
  defunctSat:    { aluminum: 0.30, titanium: 0.12, composite: 0.18, mli_mylar: 0.16, solar_cell: 0.14, steel: 0.10 },
  missionDebris: { aluminum: 0.30, titanium: 0.16, composite: 0.30, mli_mylar: 0.14, solar_cell: 0.10 },
  cubesat:       { aluminum: 0.42, composite: 0.18, titanium: 0.08, solar_cell: 0.20, mli_mylar: 0.12 },
};

/** Deterministically pick a type-weighted material from a seed (no random()). */
function _weightedMaterial(type, seed) {
  const weights = MATERIAL_WEIGHTS_BY_TYPE[type];
  if (!weights) return MATERIALS[seed % MATERIALS.length];
  let total = 0;
  for (const k in weights) total += weights[k];
  // Map the high bits of the seed to [0,total) so it decorrelates from other
  // seed-derived choices (tumble/axis use low bits).
  let roll = (((seed >>> 8) & 0xffff) / 0x10000) * total;
  for (const k in weights) {
    roll -= weights[k];
    if (roll <= 0) return k;
  }
  return 'aluminum';
}

// ============================================================================
// HELPERS
// ============================================================================

/** Deterministic hash of a string → unsigned 32-bit int.
 *  Used so real entries get a stable material / variant from boot to boot. */
function _hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Clamp + default for a numeric field. */
function _num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Convert a catalogue debris entry into a DebrisField-compatible data object.
 * Preserves the real norad + name + country as metadata; the orbit field
 * uses the same Keplerian shape the rest of the game expects (semiMajorAxis
 * in scene units).
 *
 * @param {object} entry — One entry from /data/debris-catalog.json.
 * @param {number} id — Numeric id for the debris slot (DebrisField-assigned).
 * @returns {object} debris data — isReal:true, includes norad/name/country.
 */
export function catalogEntryToDebrisData(entry, id) {
  if (!entry || !entry.tle) return null;

  const kind = String(entry.type || 'debris').toLowerCase();
  const type = TYPE_MAP[kind] || 'fragment';
  const shape = SHAPE_MAP[type] || 'icosahedron';

  const noradStr = String(entry.norad || `cat_${id}`);
  const seed = _hash(noradStr);

  const material = _weightedMaterial(type, seed);

  // ----- Physical properties (pulled from catalogue, with safe defaults) -----
  const sizeMeter = _num(entry.size_m, 1.0);
  const mass = _num(entry.mass_kg, 10);
  // Fragments tumble faster; rocket bodies slow. Use deterministic pseudo-random.
  const tumbleDeg = type === 'rocketBody' ? (2 + (seed % 10))
                  : type === 'defunctSat' ? (5 + (seed % 20))
                  : (15 + (seed % 120));
  const tumbleRate = tumbleDeg * Math.PI / 180;

  // Deterministic unit tumble axis from seed (avoids random())
  const th = (seed & 0xffff) / 0xffff * 2 * Math.PI;
  const ph = Math.acos(((seed >>> 16) & 0xffff) / 0xffff * 2 - 1);
  const tumbleAxis = {
    x: Math.sin(ph) * Math.cos(th),
    y: Math.sin(ph) * Math.sin(th),
    z: Math.cos(ph),
    isUnit: true,
  };

  // ----- Orbital elements from TLE stub -----
  const tle = entry.tle;
  const altKm = _num(tle.alt_km, 500);
  const incDeg = _num(tle.inc_deg, 0);
  const raanDeg = _num(tle.raan_deg, 0);
  const ecc = _num(tle.ecc, 0);
  const argDeg = _num(tle.arg_perigee_deg, 0);
  const maDeg = _num(tle.mean_anomaly_deg, 0);

  // Scene-scale semi-major axis: (Earth radius + alt) × SCENE_SCALE
  const smaKm = Constants.EARTH_RADIUS_KM + altKm;
  const smaScene = smaKm * Constants.SCENE_SCALE;

  // Catalogue stores mean_anomaly, not true_anomaly. For low-eccentricity orbits
  // they're nearly identical, and DebrisField's propagator normalises on the
  // first tick. Passing mean_anomaly as trueAnomaly is a safe seed value for
  // the initial render; the next propagateOrbit() corrects to true-anomaly.
  const orbit = {
    semiMajorAxis: smaScene,
    eccentricity: ecc,
    inclination: incDeg * Math.PI / 180,
    raan: raanDeg * Math.PI / 180,
    argPerigee: argDeg * Math.PI / 180,
    trueAnomaly: maDeg * Math.PI / 180,
    meanMotion: 0,
  };

  // Scene-scale size (1 m = 1e-5 scene units, same as DebrisField.js)
  const sceneSize = sizeMeter * 0.00001;

  return {
    id,
    isReal: true,
    norad: noradStr,
    name: entry.name || `Cataloged-${noradStr}`,
    country: entry.country || '---',
    launch_year: entry.launch_year || null,
    catalogType: kind,          // original string ("rocket_body", "debris", ...)
    trl: entry.trl != null ? entry.trl : 9,
    notable: entry.notable || '',

    type,                       // internal DEBRIS_TYPES key
    orbit,
    sizeMeter,
    sceneSize,
    mass,
    // Phase 2 (ASPECT_CAPTURE): same aspect derivation as procedural debris,
    // keyed by the internal type (rocket bodies are long; sats are wide-ish).
    lengthM: sizeMeter,
    widthM: sizeMeter / (((Constants.ASPECT_CAPTURE || {}).ASPECT_BY_TYPE || {})[type] || 1.0),
    tumbleRate,
    tumbleAxis,
    tumbleAngle: ((seed >>> 8) & 0xffff) / 0xffff * 2 * Math.PI,
    material,
    brittleness: ((seed >>> 4) & 0xff) / 255,
    tracked: true,              // real catalogue entries are tracked by definition
    shape,
    alive: true,
    salvage: { xenon: 0, indium: 0, gaAs: 0, battery: 0, hydrazine: 0, lithium: 0, metals: [] },
    hasSalvage: false,
    metalMassKg: 0,
    // DAUGHTER_MULTITOOL_SPEC §6 — capture recommender inputs (shared SSOT)
    ...deriveCaptureFlags(material, type, mass),
  };
}

/**
 * Build a hybrid debris seed list from a ready CatalogLoader.
 *
 * Strategy:
 *   - Pull `catalogLoader.getAllDebris()` (skipping `type:"active"` entries).
 *   - Emit up to `interactiveCount` real entries (via catalogEntryToDebrisData).
 *   - Each remaining slot is filled by calling `proceduralFactory(id)` (which
 *     should return a {isReal:false, …} object — DebrisField owns this path).
 *
 * @param {object} catalogLoader — must expose isReady() + getAllDebris().
 * @param {number} interactiveCount — total number of interactive debris slots.
 * @param {(id:number)=>object} proceduralFactory — fallback factory for filler.
 * @returns {{ real: object[], procedural: object[], debug: { realCount: number, proceduralCount: number } }}
 */
export function buildHybridDebrisSeeds(catalogLoader, interactiveCount, proceduralFactory) {
  const real = [];
  const procedural = [];
  let nextId = 0;

  const useCatalog = catalogLoader && typeof catalogLoader.isReady === 'function' && catalogLoader.isReady();

  if (useCatalog && typeof catalogLoader.getAllDebris === 'function') {
    const catalogue = catalogLoader.getAllDebris();
    const maxReal = Math.min(catalogue.length, interactiveCount);
    for (let i = 0; i < maxReal; i++) {
      const entry = catalogue[i];
      // Safety: skip empty entries or explicitly-active types
      if (!entry) continue;
      if (String(entry.type).toLowerCase() === 'active') continue;
      const data = catalogEntryToDebrisData(entry, nextId);
      if (!data) continue;
      real.push(data);
      nextId++;
    }
  }

  while (nextId < interactiveCount) {
    const d = proceduralFactory(nextId);
    if (!d) break;
    d.isReal = false;
    procedural.push(d);
    nextId++;
  }

  return {
    real,
    procedural,
    debug: { realCount: real.length, proceduralCount: procedural.length },
  };
}

// ============================================================================
// CJS GUARD
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { catalogEntryToDebrisData, buildHybridDebrisSeeds };
}
