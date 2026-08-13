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
// S11(a) — REGIME-FIRST FIELD ASSEMBLY (plan 1786401864178-cargo-continuity §5
// S11; register item 38). A field is ONE orbital regime: an altitude cell × an
// inclination/RAAN band centred on the player's start orbit. The catalogue
// half is ADMITTED by the band (TLE alt+inc in range) and then picked by a
// seeded, deterministic weighted sampler — replacing the file-order slice
// (`catalogue[0 … interactiveCount)`) that landed Envisat in the fourth slot of
// every game. Procedural filler is drawn in-band by the factory (DebrisField
// owns the orbit draws). Node-safe like the rest of this module.
// ============================================================================

/** Deterministic PRNG (mulberry32) — one stream per field assembly.
 *  Exported for DebrisField's background cloud (S11(b)) so the whole field —
 *  cast, hazards AND sky — is reproducible from the one logged boot seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * S11(b) — the hazard cloud's power-law size draw. NASA Standard Breakup
 * Model: cumulative fragment counts go as N(≥Lc) ∝ Lc^−lambda (collision
 * 1.71 / explosion 1.6) over characteristic length Lc. This is the plain
 * inverse CDF of that law (Lc = min · u^(−1/lambda)) with a hard cap at
 * `max`: the empirical cumulative below `max` recovers lambda EXACTLY (the
 * cap only piles the (min/max)^lambda ≈ 6 % top tail AT max — the practical
 * upper size for "shard"), so the test-pinned measured exponent sits inside
 * the SBM band instead of being biased by a truncation constant. Node-safe
 * pure function of one uniform u∈[0,1).
 *
 * @param {number} u — one uniform draw (e.g. from mulberry32)
 * @param {number} min — minimum characteristic length (m)
 * @param {number} max — maximum characteristic length (m)
 * @param {number} lambda — the cumulative-law exponent (SBM: 1.6–1.71)
 * @returns {number} characteristic length in [min, max]
 */
export function samplePowerLawSize(u, min, max, lambda) {
  const uu = Math.min(1 - 1e-12, Math.max(1e-12, u));
  return Math.min(max, min * Math.pow(uu, -1 / lambda));
}

/**
 * Derive the field regime from the player's start orbit (the SSOT read shared
 * with GameFlowManager._applyStartLocation: main.js computes the start orbit
 * from the boot language via computeStartOrbit and passes it here).
 * Altitude comes from Constants.START_ALTITUDE_KM (350 — language-independent)
 * mapped to its containing DEBRIS.ALT_BANDS cell, so the regime carries the
 * named cell's identity (e.g. VLEO 180–400 km). A null start orbit yields the
 * ISS-band default (51.6°, RAAN 0) — deterministic for tests and legacy
 * constructions.
 *
 * @param {{inclination:number, raan:number}|null} startOrbit — radians.
 * @returns {{altMinKm:number, altMaxKm:number, altLabel:string,
 *   incCenterDeg:number, incTolDeg:number, raanCenterRad:number, raanTolDeg:number}}
 */
export function regimeFromStartOrbit(startOrbit) {
  const C = Constants;
  const tol = (C.DEBRIS && C.DEBRIS.FIELD_REGIME) || { INC_TOL_DEG: 0.5, RAAN_TOL_DEG: 0.5 };
  const altKm = C.START_ALTITUDE_KM || 350;
  const bands = (C.DEBRIS && Array.isArray(C.DEBRIS.ALT_BANDS)) ? C.DEBRIS.ALT_BANDS : [];
  const cell = bands.find(b => altKm >= b.min && altKm < b.max)
    || { min: 180, max: 400, label: 'VLEO' };
  return {
    altMinKm: cell.min,
    altMaxKm: cell.max,
    altLabel: cell.label || `${cell.min}`,
    incCenterDeg: startOrbit ? startOrbit.inclination * 180 / Math.PI : 51.6,
    incTolDeg: tol.INC_TOL_DEG,
    raanCenterRad: startOrbit ? startOrbit.raan : 0,
    raanTolDeg: tol.RAAN_TOL_DEG,
  };
}

/**
 * Regime-first sibling of buildHybridDebrisSeeds: admit only catalogue entries
 * whose TLE lies in the regime band (alt in [altMinKm, altMaxKm), |inc −
 * incCenterDeg| ≤ incTolDeg, never `active`), then pick up to
 * `interactiveCount` of them with a seeded weighted sampler (Efraimidis–
 * Spirakis key = u^(1/w), weight hook `entry.weight ?? 1` — uniform today;
 * S11(b)/(c) own any real weighting). Remaining slots come from
 * `proceduralFactory(id, rng)` — the shared rng stream keeps the whole
 * assembly deterministic from `seed`.
 *
 * Real entries keep their real TLE orbits (RAAN included) — admission is the
 * filter, not a re-seat; the RAAN band binds only the procedural filler.
 *
 * S11(b) — `opts.foreground = { count, finaleMassKg }` switches the assembly
 * to TWO POPULATIONS: the first `count` slots are the authored FOREGROUND
 * cast (factory called with `info = { role:'foreground', slot }`), every
 * remaining slot is a HAZARD shard (`info = { role:'hazard' }`). Among the
 * sampled in-band entries, the first one over `finaleMassKg` SUBSTITUTES the
 * finale slot (the last foreground slot — "the intact body"); no other real
 * entries spawn (a field is five authored targets + the cloud — the richer
 * catalogue integration is S11(c)'s data pass; at the 350 km start regime
 * the in-band yield is zero — register item 51 — so the cast is honestly
 * all-procedural today). When `opts.foreground` is absent the behaviour is
 * exactly the S11(a) assembly (real pick + procedural fill, factory called
 * as `factory(id, rng)` with no `info`).
 *
 * @param {object} catalogLoader — must expose isReady() + getAllDebris().
 * @param {number} interactiveCount — total interactive slots.
 * @param {(id:number, rng:()=>number, info:?object)=>object} proceduralFactory — in-band filler.
 * @param {{regime:object, seed:number, foreground:?{count:number, finaleMassKg:number}}} opts
 * @returns {{ real: object[], procedural: object[], seed: number,
 *   debug: { realCount: number, proceduralCount: number, eligibleCount: number,
 *            foregroundCount: number, hazardCount: number, finaleReal: string|null } }}
 */
export function buildRegimeDebrisSeeds(catalogLoader, interactiveCount, proceduralFactory, opts = {}) {
  const { regime, seed = 0, foreground = null } = opts;
  const rng = mulberry32(seed);
  const real = [];
  const procedural = [];
  let nextId = 0;
  let eligibleCount = 0;
  let hazardCount = 0;
  let finaleReal = null;

  const useCatalog = catalogLoader && typeof catalogLoader.isReady === 'function' && catalogLoader.isReady();
  if (useCatalog && typeof catalogLoader.getAllDebris === 'function' && regime) {
    const eligible = [];
    for (const entry of catalogLoader.getAllDebris()) {
      if (!entry || !entry.tle) continue;
      if (String(entry.type).toLowerCase() === 'active') continue;
      const alt = Number(entry.tle.alt_km);
      const inc = Number(entry.tle.inc_deg);
      if (!Number.isFinite(alt) || !Number.isFinite(inc)) continue;
      if (alt < regime.altMinKm || alt >= regime.altMaxKm) continue;
      if (Math.abs(inc - regime.incCenterDeg) > regime.incTolDeg) continue;
      eligible.push(entry);
    }
    eligibleCount = eligible.length;
    // Seeded weighted pick, no replacement: sort by key u^(1/w) descending and
    // take the first `interactiveCount`. With uniform weights this is a plain
    // seeded shuffle — the file order no longer decides the cast.
    const keyed = eligible.map(entry => {
      const w = Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 1;
      return { entry, key: Math.pow(rng() || 1e-12, 1 / w) };
    });
    keyed.sort((a, b) => b.key - a.key);
    if (foreground) {
      // S11(b): only the finale slot accepts a real entry — the first sampled
      // in-band whale over the mass gate ("the field's finale is the intact
      // body"). Everything else real stays unspawned.
      const finaleMassKg = Number.isFinite(foreground.finaleMassKg) ? foreground.finaleMassKg : 500;
      const pick = keyed.find(k => Number(k.entry.mass_kg) > finaleMassKg);
      if (pick) finaleReal = pick.entry;
    } else {
      for (const { entry } of keyed) {
        if (nextId >= interactiveCount) break;
        const data = catalogEntryToDebrisData(entry, nextId);
        if (!data) continue;
        real.push(data);
        nextId++;
      }
    }
  }

  if (foreground) {
    const count = Math.min(Math.max(0, foreground.count | 0), interactiveCount);
    for (let slot = 0; slot < count && nextId < interactiveCount; slot++) {
      if (slot === count - 1 && finaleReal) {
        const data = catalogEntryToDebrisData(finaleReal, nextId);
        // The substituted finale is a cast member: mark it foreground and
        // pre-discovered like the authored rows (a catalogued body the field
        // is known to hold — five pieces around a ~42 000 km ring can never
        // be scan-found at 500 km reveal range).
        if (data) { data.foreground = true; data.discovered = true; real.push(data); nextId++; continue; }
      }
      const d = proceduralFactory(nextId, rng, { role: 'foreground', slot });
      if (!d) break;
      d.isReal = false;
      procedural.push(d);
      nextId++;
    }
  }

  while (nextId < interactiveCount) {
    const d = foreground
      ? proceduralFactory(nextId, rng, { role: 'hazard' })
      : proceduralFactory(nextId, rng);
    if (!d) break;
    d.isReal = false;
    if (foreground) hazardCount++;
    procedural.push(d);
    nextId++;
  }

  return {
    real,
    procedural,
    seed,
    debug: {
      realCount: real.length,
      proceduralCount: procedural.length,
      eligibleCount,
      foregroundCount: foreground ? (procedural.length + real.length) - hazardCount : 0,
      hazardCount,
      finaleReal: finaleReal ? (finaleReal.name || String(finaleReal.norad)) : null,
    },
  };
}

// ============================================================================
// CJS GUARD
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { catalogEntryToDebrisData, buildHybridDebrisSeeds, buildRegimeDebrisSeeds, regimeFromStartOrbit, mulberry32, samplePowerLawSize };
}
