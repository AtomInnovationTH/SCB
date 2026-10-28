/**
 * CatalogConverter.js - pure helpers that convert catalogue entries (from `CatalogLoader`) into debris data objects compatible with
 * `DebrisField`.
 *
 * **Node-safe:** no THREE.js, no DOM. A separate module so unit tests can verify the hybrid-mode split (real entries + procedural filler)
 * without importing `DebrisField` (which pulls in Three.js). The cheap TLE-stub → Keplerian conversion happens ONCE per entry at boot;
 * DebrisField then owns propagation on the normal update tick.
 *
 * @module entities/CatalogConverter
 */

import { Constants } from '../core/Constants.js';
import { deriveCaptureFlags } from './debrisFerrous.js';
import { degToRad, radToDeg } from '../core/MathUtil.js';

// Type mapping: catalogue "type" → internal debris type key (matches DEBRIS_TYPES in DebrisField.js).

/** @type {Object<string,string>} */
const TYPE_MAP = {
  debris:        'fragment',
  rocket_body:   'rocketBody',
  inactive:      'defunctSat',
  active:        'defunctSat',  // never spawned into DebrisField anyway
  mission_debris:'missionDebris',
};

/** Shape hint per type; mirrors DebrisField's DEBRIS_TYPES.shape values. */
const SHAPE_MAP = {
  fragment:     'icosahedron',
  rocketBody:   'cylinder',
  defunctSat:   'box',
  missionDebris:'sphere',
  cubesat:      'box',
};

/** Material pool; mirrors the `MATERIALS` array in DebrisField.js. */
const MATERIALS = ['aluminum', 'titanium', 'composite', 'mli_mylar', 'solar_cell', 'steel'];

/** Per-type material weights; mirrors MATERIAL_WEIGHTS_BY_TYPE in DebrisField.js. Keeps gold MLI / blue solar cells rare and concentrated
 *  on satellites so the catalogue half of the field matches the procedural half visually. */
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
  // the high bits of the seed map to [0,total), decorrelating from other seed-derived choices (tumble/axis use low bits)
  let roll = (((seed >>> 8) & 0xffff) / 0x10000) * total;
  for (const k in weights) {
    roll -= weights[k];
    if (roll <= 0) return k;
  }
  return 'aluminum';
}

/** Deterministic hash of a string → unsigned 32-bit int, so real entries get a stable material / variant from boot to boot. */
function _hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function _num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Convert a catalogue debris entry (one entry of /data/debris-catalog.json) into a DebrisField-compatible data object (isReal:true, with the
 * real norad + name + country as metadata). The orbit uses the same Keplerian shape the rest of the game expects (semiMajorAxis in scene units).
 * @param {object} entry One entry from /data/debris-catalog.json.
 * @param {number} id Numeric id for the debris slot (DebrisField-assigned).
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

  const sizeMeter = _num(entry.size_m, 1.0);
  const mass = _num(entry.mass_kg, 10);
  const tumbleDeg = type === 'rocketBody' ? (2 + (seed % 10))
                  : type === 'defunctSat' ? (5 + (seed % 20))
                  : (15 + (seed % 120));
  const tumbleRate = degToRad(tumbleDeg);

  const th = (seed & 0xffff) / 0xffff * 2 * Math.PI;
  const ph = Math.acos(((seed >>> 16) & 0xffff) / 0xffff * 2 - 1);
  const tumbleAxis = {
    x: Math.sin(ph) * Math.cos(th),
    y: Math.sin(ph) * Math.sin(th),
    z: Math.cos(ph),
    isUnit: true,
  };

  const tle = entry.tle;
  const altKm = _num(tle.alt_km, 500);
  const incDeg = _num(tle.inc_deg, 0);
  const raanDeg = _num(tle.raan_deg, 0);
  const ecc = _num(tle.ecc, 0);
  const argDeg = _num(tle.arg_perigee_deg, 0);
  const maDeg = _num(tle.mean_anomaly_deg, 0);

  // semi-major axis in scene units: (Earth radius + alt) × SCENE_SCALE
  const smaKm = Constants.EARTH_RADIUS_KM + altKm;
  const smaScene = smaKm * Constants.SCENE_SCALE;

  // The catalogue stores mean_anomaly, not true_anomaly. For low-eccentricity orbits they are nearly identical, and DebrisField's propagator
  // normalises on the first tick, so mean_anomaly is a safe seed value as trueAnomaly for the initial render.
  const orbit = {
    semiMajorAxis: smaScene,
    eccentricity: ecc,
    inclination: degToRad(incDeg),
    raan: degToRad(raanDeg),
    argPerigee: degToRad(argDeg),
    trueAnomaly: degToRad(maDeg),
    meanMotion: 0,
  };

  // size in scene units (1 m = 1e-5 scene units, same as DebrisField.js)
  const sceneSize = sizeMeter * 0.00001;

  return {
    id,
    isReal: true,
    norad: noradStr,
    name: entry.name || `Cataloged-${noradStr}`,
    country: entry.country || '---',
    launch_year: entry.launch_year || null,
    catalogType: kind,
    trl: entry.trl != null ? entry.trl : 9,
    notable: entry.notable || '',

    type,
    orbit,
    sizeMeter,
    sceneSize,
    mass,
    // aspect derived as for procedural debris, keyed by the internal type (rocket bodies are long; sats are wide-ish)
    lengthM: sizeMeter,
    widthM: sizeMeter / (((Constants.ASPECT_CAPTURE || {}).ASPECT_BY_TYPE || {})[type] || 1.0),
    tumbleRate,
    tumbleAxis,
    tumbleAngle: ((seed >>> 8) & 0xffff) / 0xffff * 2 * Math.PI,
    material,
    brittleness: ((seed >>> 4) & 0xff) / 255,
    tracked: true,
    shape,
    alive: true,
    salvage: { xenon: 0, indium: 0, gaAs: 0, battery: 0, hydrazine: 0, lithium: 0, metals: [] },
    hasSalvage: false,
    metalMassKg: 0,
    // DAUGHTER_MULTITOOL_SPEC §6: capture recommender inputs (shared SSOT)
    ...deriveCaptureFlags(material, type, mass),
  };
}

/**
 * Build a hybrid debris seed list from a ready CatalogLoader.
 *
 * Strategy:
 *   - Pull `catalogLoader.getAllDebris()` (skipping `type:"active"` entries).
 *   - Emit up to `interactiveCount` real entries (via catalogEntryToDebrisData).
 *   - Fill each remaining slot with `proceduralFactory(id)` (which should return a {isReal:false, …} object;
 *     DebrisField owns this path).
 *
 * @param {object} catalogLoader must expose isReady() + getAllDebris().
 * @param {number} interactiveCount total number of interactive debris slots
 * @param {(id:number)=>object} proceduralFactory fallback factory for the filler slots
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

// Regime-first field assembly (register item 38). A field is ONE orbital regime: an altitude cell
// × an inclination/RAAN band centred on the player's start orbit. The catalogue half is ADMITTED by the band (TLE alt+inc in range), then
// picked by a seeded, deterministic weighted sampler (not the file order, which put Envisat in the fourth slot of every game). Procedural
// filler is drawn in-band by the factory (DebrisField owns the orbit draws).

/** Deterministic PRNG (mulberry32), one stream per field assembly. Exported for DebrisField's background cloud so the whole field (cast,
 *  hazards AND sky) is reproducible from the one logged boot seed. */
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
 * The hazard cloud's power-law size draw. NASA Standard Breakup Model: cumulative fragment counts go as N(≥Lc) ∝ Lc^−lambda (collision 1.71 /
 * explosion 1.6) over characteristic length Lc. This is the plain inverse CDF of that law (Lc = min · u^(−1/lambda)) with a hard cap at `max`:
 * the empirical cumulative below `max` recovers lambda EXACTLY (the cap only piles the (min/max)^lambda ≈ 6 % top tail AT max), so the
 * test-pinned measured exponent sits inside the SBM band instead of being biased by a truncation constant. Pure function of one uniform u∈[0,1).
 *
 * @param {number} u one uniform draw (e.g. from mulberry32)
 * @param {number} min minimum characteristic length (m)
 * @param {number} max maximum characteristic length (m)
 * @param {number} lambda the cumulative-law exponent (SBM: 1.6–1.71)
 * @returns {number} characteristic length in [min, max]
 */
export function samplePowerLawSize(u, min, max, lambda) {
  const uu = Math.min(1 - 1e-12, Math.max(1e-12, u));
  return Math.min(max, min * Math.pow(uu, -1 / lambda));
}

/**
 * The SBM area→mass chain (register item 39). Given a fragment's characteristic length Lc (see samplePowerLawSize), derive its mass as the
 * NASA Standard Breakup Model does: cross-sectional area A = AREA_COEF·Lc^AREA_EXP, then mass = A / (A/M) with the area-to-mass ratio
 * log-normal in χ = log10(A/M [m²/kg]) ~ N(AM_LOG10_MEAN, AM_LOG10_SIGMA) (collision fragments; Constants.DEBRIS.MASS_LAW). Two uniform draws
 * → one standard normal via Box–Muller (the same transform as DebrisField's gaussRandomRng, kept local so this module stays THREE-free), so
 * the chain is deterministic on the assembly's seeded stream. Over the hazard cloud's 0.1–0.5 m range the measured cumulative mass exponent
 * lands ≈0.6, inside the SBM band 0.6–0.85 (the log-normal scatter flattens the λ/AREA_EXP ≈ 0.853 asymptote over the narrow range).
 *
 * @param {number} lc characteristic length (m)
 * @param {number} u1 uniform draw ∈ [0,1) (normal magnitude)
 * @param {number} u2 uniform draw ∈ [0,1) (normal phase)
 * @param {{AREA_COEF:number, AREA_EXP:number, AM_LOG10_MEAN:number, AM_LOG10_SIGMA:number}} ml
 * @returns {number} mass in kg (unclamped: the caller owns the envelope)
 */
export function sampleSbmMassKg(lc, u1, u2, ml) {
  const area = ml.AREA_COEF * Math.pow(Math.max(1e-12, lc), ml.AREA_EXP);
  const z = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
  const am = Math.pow(10, ml.AM_LOG10_MEAN + ml.AM_LOG10_SIGMA * z);
  return area / am;
}

/**
 * Intact bodies are launch history, not a power law (register item 39): build the per-type mass pools the procedural intact draw samples from
 * the REAL catalogue. Mapping follows TYPE_MAP: catalogue `rocket_body` → rocketBody, `inactive` → defunctSat, with the sub-`cubesatMaxKg`
 * inactives split off as the cubesat pool (the catalogue carries no cubesat class; the Vanguard-class microsats are the real objects that
 * live there). Fragment/missionDebris get no pool: they are power-law populations, not intacts.
 *
 * @param {object[]} entries catalogue entries (CatalogLoader.getAllDebris())
 * @param {number} [cubesatMaxKg=15] the intact/cubesat mass cut (kg)
 * @returns {{rocketBody:number[], defunctSat:number[], cubesat:number[]}}
 */
export function buildIntactMassPools(entries, cubesatMaxKg = 15) {
  const pools = { rocketBody: [], defunctSat: [], cubesat: [] };
  if (!Array.isArray(entries)) return pools;
  for (const e of entries) {
    if (!e) continue;
    const m = Number(e.mass_kg);
    if (!Number.isFinite(m) || m <= 0) continue;
    const t = String(e.type || '').toLowerCase();
    if (t === 'rocket_body') pools.rocketBody.push(m);
    else if (t === 'inactive') {
      if (m <= cubesatMaxKg) pools.cubesat.push(m);
      else pools.defunctSat.push(m);
    }
  }
  return pools;
}

/**
 * Derive the field regime from the player's start orbit (the SSOT read shared with GameFlowManager._applyStartLocation: main.js computes the
 * start orbit from the boot language via computeStartOrbit and passes it here). Altitude comes from Constants.START_ALTITUDE_KM (350,
 * language-independent) mapped to its containing DEBRIS.ALT_BANDS cell, so the regime carries the named cell's identity (e.g. VLEO 180–400 km).
 * A null start orbit yields the ISS-band default (51.6°, RAAN 0), deterministic for tests and legacy constructions.
 *
 * @param {{inclination:number, raan:number}|null} startOrbit radians.
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
    incCenterDeg: startOrbit ? radToDeg(startOrbit.inclination) : 51.6,
    incTolDeg: tol.INC_TOL_DEG,
    raanCenterRad: startOrbit ? startOrbit.raan : 0,
    raanTolDeg: tol.RAAN_TOL_DEG,
  };
}

/**
 * Regime-first sibling of buildHybridDebrisSeeds: admit only catalogue entries whose TLE lies in the regime band (alt in [altMinKm, altMaxKm),
 * |inc − incCenterDeg| ≤ incTolDeg, never `active`), then pick up to `interactiveCount` of them with a seeded weighted sampler
 * (Efraimidis–Spirakis key = u^(1/w), weight hook `entry.weight ?? 1`, uniform today). Remaining slots come from `proceduralFactory(id, rng)`;
 * the shared rng stream keeps the whole assembly deterministic from `seed`.
 *
 * Real entries keep their real TLE orbits (RAAN included): admission is the filter, not a re-seat; the RAAN band binds only the procedural filler.
 *
 * `opts.foreground = { count, finaleMassKg }` switches the assembly to TWO POPULATIONS: the first `count` slots are the authored FOREGROUND
 * cast (factory called with `info = { role:'foreground', slot }`), every remaining slot is a HAZARD shard (`info = { role:'hazard' }`).
 * Among the sampled in-band entries, the first one over `finaleMassKg` SUBSTITUTES the finale slot (the last foreground slot, "the intact
 * body"); no other real entries spawn (at the 350 km start regime the in-band yield is zero, register item 51, so the cast is honestly
 * all-procedural today). Without `opts.foreground` the assembly is real pick + procedural fill, factory called as `factory(id, rng)`
 * with no `info`.
 *
 * @param {object} catalogLoader must expose isReady() + getAllDebris().
 * @param {number} interactiveCount total interactive slots.
 * @param {(id:number, rng:()=>number, info:?object)=>object} proceduralFactory in-band filler.
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
    // Seeded weighted pick, no replacement: sort by key u^(1/w) descending, take the first `interactiveCount`. With uniform weights this is
    // a plain seeded shuffle; the file order does not decide the cast.
    const keyed = eligible.map(entry => {
      const w = Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 1;
      return { entry, key: Math.pow(rng() || 1e-12, 1 / w) };
    });
    keyed.sort((a, b) => b.key - a.key);
    if (foreground) {
      // only the finale slot accepts a real entry: the first sampled in-band whale over the mass gate. Everything else real stays unspawned.
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
        // The substituted finale is a cast member: mark it foreground and pre-discovered like the authored rows (a catalogued body the field is
        // known to hold; five pieces around a ~42 000 km ring can never be scan-found at 500 km reveal range).
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { catalogEntryToDebrisData, buildHybridDebrisSeeds, buildRegimeDebrisSeeds, regimeFromStartOrbit, mulberry32, samplePowerLawSize, sampleSbmMassKg, buildIntactMassPools };
}
