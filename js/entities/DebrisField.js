/**
 * DebrisField.js — Manages all debris objects (interactive + background)
 * 800 interactive debris with InstancedMesh, 5000 background as Points.
 * @module entities/DebrisField
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import {
  propagateOrbit,
  orbitToSceneCartesian,
  orbitToSceneCartesianInto,
  totalDeltaV,
  kmToScene,
  orbitalVelocity,
  atmosphericDrag,
} from './OrbitalMechanics.js';
import {
  DebrisWireframe,
  initAtlases, getTypeAtlasTexture, getFlagAtlasTexture,
  getUVOffsetForType, getEmissiveForMOID,
  getUVOffsetForCountry, hasFlag as hasFlagDecal,
  getVisualMode,
} from '../ui/DebrisWireframe.js';
import { catalogEntryToDebrisData } from './CatalogConverter.js';
import { deriveCaptureFlags } from './debrisFerrous.js';
import { isFlagEligible, pickCountryForId } from '../ui/FlagDecalSystem.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

// Runtime overrides honour Constants.DEBRIS.INTERACTIVE_COUNT/BACKGROUND_COUNT
// (ST-6.1: moved from module-scope constants so hybrid-mode tests can inject).
const INTERACTIVE_COUNT = (Constants.DEBRIS && Constants.DEBRIS.INTERACTIVE_COUNT) || 800;
const BACKGROUND_COUNT  = (Constants.DEBRIS && Constants.DEBRIS.BACKGROUND_COUNT)  || 5000;

/** Debris type definitions */
// Phase 2 (ASPECT_CAPTURE): `aspect` = length:width ratio (1.0 = symmetric).
// lengthM/widthM are derived per piece in _createDebrisData; keep these in
// sync with Constants.ASPECT_CAPTURE.ASPECT_BY_TYPE.
const DEBRIS_TYPES = {
  fragment:     { weight: 0.60, sizeMin: 0.1, sizeMax: 1.0, massMin: 0.01, massMax: 5, tumbleMin: 10, tumbleMax: 180, shape: 'icosahedron', aspect: 1.0 },
  rocketBody:   { weight: 0.12, sizeMin: 5, sizeMax: 11, massMin: 500, massMax: 5000, tumbleMin: 1, tumbleMax: 20, shape: 'cylinder', aspect: 3.5 },
  defunctSat:   { weight: 0.16, sizeMin: 1, sizeMax: 8, massMin: 50, massMax: 2000, tumbleMin: 2, tumbleMax: 30, shape: 'box', aspect: 1.6 },
  missionDebris: { weight: 0.12, sizeMin: 0.05, sizeMax: 0.5, massMin: 0.001, massMax: 2, tumbleMin: 5, tumbleMax: 120, shape: 'sphere', aspect: 1.0 },
  // cubesat — small WHOLE microsat (panelled box), 0.1–0.5 m, 1–12 kg, the
  // heaviest whole thing a Mother net can take. Low tumble (intact body),
  // net-catchable, the M1 graduation catch (welcome #7) and sprinkled rarely
  // into the field. Registered so every type-keyed map resolves it.
  cubesat:      { weight: 0.02, sizeMin: 0.1, sizeMax: 0.5, massMin: 1, massMax: 10, tumbleMin: 1, tumbleMax: 15, shape: 'box', aspect: 1.1 },
};

/** 1 metre expressed in scene units (1 km = SCENE_SCALE scene units). */
const METRE_SCENE = Constants.SCENE_SCALE / 1000;

/** Material types for debris */
const MATERIALS = ['aluminum', 'titanium', 'composite', 'mli_mylar', 'solar_cell', 'steel'];

// ---------------------------------------------------------------------------
// Per-type material distribution (physical plausibility + visual variety)
// ---------------------------------------------------------------------------
// Previously every piece picked uniformly from all 5 materials, so 20% of the
// ENTIRE field was gold MLI foil and 20% blue solar cells — the field read as
// "almost all gold/blue" instead of a realistic mostly-metal debris cloud.
//
// Real orbital debris is dominated by bare/charred structural metal and dark
// composite. Gold multi-layer insulation (MLI) and blue photovoltaic cells
// only appear on (or shed from) satellites, and even then as a minority of the
// surface. We therefore weight material choice BY debris type:
//   • fragment      — explosion shards: mostly bare aluminium, titanium,
//                     charred composite. A SMALL minority (~6% each) are shed
//                     gold-MLI / blue-solar-cell shards: a shed PV/foil scrap
//                     reads as junk, not an intact panel. Kept small so the
//                     field is not "gold/blue soup". These slots also let the
//                     welcome spawn SELECT a gold/blue plate candidate (it
//                     reuses a debris' existing mesh-slot and cannot rebind).
//   • rocketBody    — large aluminium/titanium stages, some composite skirts.
//   • defunctSat    — the "variety" piece: aluminium bus + a real chance of
//                     gold MLI and blue solar arrays + composite panels.
//   • missionDebris — small operational debris (clamps, lens caps, MLI scraps,
//                     cell offcuts): a broad mix incl. occasional gold/blue.
// Weights are relative (need not sum to 1); picked via weightedMaterial().
const MATERIAL_WEIGHTS_BY_TYPE = {
  fragment:      { aluminum: 0.36, titanium: 0.21, composite: 0.31, steel: 0.05, mli_mylar: 0.06, solar_cell: 0.06 },
  rocketBody:    { aluminum: 0.45, titanium: 0.25, composite: 0.12, steel: 0.18 },
  defunctSat:    { aluminum: 0.30, titanium: 0.12, composite: 0.18, mli_mylar: 0.16, solar_cell: 0.14, steel: 0.10 },
  missionDebris: { aluminum: 0.30, titanium: 0.16, composite: 0.30, mli_mylar: 0.14, solar_cell: 0.10 },
  // cubesat — a small intact satellite: aluminium bus dominant, real chance of
  // blue solar cells + a little gold MLI (it has functioning panels/insulation).
  cubesat:       { aluminum: 0.42, composite: 0.18, titanium: 0.08, solar_cell: 0.20, mli_mylar: 0.12 },
};

/**
 * Pick a material tag for a debris piece, weighted by its type so the field
 * reads as physically-plausible (mostly metal/composite, gold & blue rare).
 * Falls back to a uniform pick if the type is unknown.
 * @param {string} type — procedural debris type
 * @returns {string} material tag from MATERIALS
 */
function weightedMaterial(type) {
  const weights = MATERIAL_WEIGHTS_BY_TYPE[type];
  if (!weights) return MATERIALS[Math.floor(Math.random() * MATERIALS.length)];
  let total = 0;
  for (const k in weights) total += weights[k];
  let roll = Math.random() * total;
  for (const k in weights) {
    roll -= weights[k];
    if (roll <= 0) return k;
  }
  return 'aluminum';
}

// ---------------------------------------------------------------------------
// Per-instance colour variation (anti-monotone)
// ---------------------------------------------------------------------------
// A whole field of debris sharing one flat tint reads as a "grey soup". To make
// the field feel like real, individually-weathered hardware we nudge each
// piece's base colour deterministically by its id: small hue shifts (sun-faded
// paint / oxidation), and brightness variation (light vs. shadow-darkened
// surfaces, scorching). Deterministic so a piece always looks the same.
//
// NOTE: Three.js colour management is enabled by default (r152+), so a
// THREE.Color built from an sRGB hex stores LINEAR values and the no-arg
// getHSL/setHSL operate in linear space. We must read/write HSL in *sRGB*
// space so the perceptual lightness varies as intended (otherwise the field
// gets darker and barely varies — the opposite of the goal). Fall back to the
// no-arg form when the constant is unavailable (older THREE / test stubs).
const _instanceHSL = { h: 0, s: 0, l: 0 };
const _SRGB = (typeof THREE !== 'undefined' && THREE.SRGBColorSpace) || undefined;

// ---------------------------------------------------------------------------
// Instance-tint base colour (3D mesh) — a near-WHITE weathering modulator.
// ---------------------------------------------------------------------------
// The instanceColor multiplies color × map in the shader. Earlier it was set
// to getBaseColorForType() — DARK type colours (#666, #333, #333366). Those
// crushed the (now bright, texture-carried) hull colour toward black and made
// the field read as a dim, low-contrast "grey soup".
//
// The type's characteristic colour already lives in the atlas texture, so the
// instanceColor's job here is ONLY weathering modulation: a bright base near
// white with a faint type-appropriate hue bias, onto which
// applyInstanceColorVariation() layers per-piece brightness/oxidation jitter.
// Real hardware tints: bare metal reads neutral-cool, charred fragments lean
// warm/sooty, solar/sat surfaces lean faintly blue.
const _INSTANCE_TINT_BASE = {
  debris:      '#cfcfcf',  // grey structural metal
  fragment:    '#b9b4ac',  // charred, slightly warm bare metal
  rocket_body: '#d6d6dc',  // bright aluminium hull
  inactive:    '#c2c6d2',  // satellite skin, faint cool blue
  active:      '#e6e6ee',  // clean spacecraft
  unknown:     '#c8bfb0',  // weathered warm
};

/**
 * Base colour for the 3D instanceColor weathering modulator (near-white).
 * Distinct from getBaseColorForType() (used for atlas/strategic-map dots),
 * which stays dark/type-coded for those purposes.
 * @param {string} catalogType
 * @returns {string} hex tint
 */
function getInstanceTintBase(catalogType) {
  return _INSTANCE_TINT_BASE[catalogType] || _INSTANCE_TINT_BASE.unknown;
}

/**
 * Apply deterministic per-instance colour variation to `out`.
 * @param {THREE.Color} out  - colour pre-set to the type base colour
 * @param {number} id        - stable debris id (variation seed)
 * @param {string} [catalogType]
 * @returns {THREE.Color} out (mutated)
 */
function applyInstanceColorVariation(out, id, catalogType) {
  // Two decorrelated hashes in [0,1)
  const h1 = (Math.sin(id * 12.9898) * 43758.5453);
  const h2 = (Math.sin(id * 78.233 + 1.7) * 24634.6345);
  const r1 = h1 - Math.floor(h1);
  const r2 = h2 - Math.floor(h2);

  // Read perceptual (sRGB) HSL so the maths matches what the eye sees.
  if (_SRGB) out.getHSL(_instanceHSL, _SRGB);
  else out.getHSL(_instanceHSL);

  // Hue drift: subtle for painted/metal, warmer scatter for raw fragments
  const isFrag = catalogType === 'fragment' || catalogType === 'debris';
  const hueRange = isFrag ? 0.05 : 0.03;
  _instanceHSL.h = (_instanceHSL.h + (r1 - 0.5) * hueRange + 1) % 1;
  // Slight saturation jitter so some pieces look more oxidised/coloured
  _instanceHSL.s = Math.max(0, Math.min(1, _instanceHSL.s * (0.75 + r2 * 0.6)));
  // Brightness variation is the big anti-monotone win. Centre the multiplier
  // on ~1.0 (range ~0.62–1.18) so on a bright base some pieces read sun-lit
  // and others shadow/scorch-darkened, without dragging the whole field dark.
  // Floor keeps near-black fragments from collapsing to a flat silhouette.
  _instanceHSL.l = Math.max(0.10, Math.min(0.97, _instanceHSL.l * (0.62 + r1 * 0.56)));

  if (_SRGB) out.setHSL(_instanceHSL.h, _instanceHSL.s, _instanceHSL.l, _SRGB);
  else out.setHSL(_instanceHSL.h, _instanceHSL.s, _instanceHSL.l);
  return out;
}

/** ST-6.2: Map procedural game-type → catalogType for atlas visuals */
const PROC_TYPE_TO_CATALOG = {
  fragment:      'debris',
  rocketBody:    'rocket_body',
  defunctSat:    'inactive',
  missionDebris: 'debris',
  cubesat:       'inactive',
};

/** Tracking probability by debris type (real-world catalog coverage) */
const TRACKING_PROB = {
  fragment: 0.40,      // Small, hard to detect
  rocketBody: 0.95,    // Large, well-cataloged
  defunctSat: 0.80,    // Medium-large, mostly tracked
  missionDebris: 0.60, // Small operational debris
  cubesat: 0.70,       // Small but a tracked whole satellite
};

/** Welcome field debris — spawned near player on first ORBITAL_VIEW for immediate gameplay.
 *  Empirically verified offset→distance scale (via OrbitalMechanics fixture):
 *     trueAnomaly Δν of 0.0000045 ≈ 30 m, 0.000028 ≈ 188 m, 0.00013 ≈ 870 m,
 *     0.00025 ≈ 1680 m.  These specs target a tight ≤1.5 km cluster so the
 *     pilot can see all 7 contacts in a single mother-ship vantage on
 *     mission 1, while still requiring autopilot to reach the deepest one. */
const WELCOME_FIELD = [
  // Reward-first onboarding spine (.kilo/plans/new-player-onboarding-flow.md
  // Phase 2). Mission 1 is NET-ONLY (every guided beat captures with the Mother
  // net; there is no Daughter beat), and the Mother net rejects anything over
  // LASSO_MAX_CAPTURE_MASS (10 kg). So EVERY welcome piece is authored ≤ 10 kg.
  //
  // APPEARANCE: all pieces are `fragment` (irregular icosahedron) so they read
  // as LOW-VALUE space debris, not intact (high-value) satellites. Candidate
  // selection also prefers fragment-shaped debris because the spawn reuses a
  // debris' existing instanced-mesh slot (the rendered shape is the candidate's,
  // not the spec's). `sizeM` scales them up so junk chunks are still visible.
  //
  // PLACEMENT (mother-local frame): #1 dead-centre ahead, #2 off to one side,
  // both PINNED (local-frame, single source of truth = _scenePosition) and in
  // net range so the two guided net catches are guaranteed. #3 is the RANGE WALL
  // — ahead but beyond NET_LOCK_RANGE_M (90 m) so the reticle flips OUT OF RANGE
  // and teaches Autopilot (A); it is a FREE co-orbital orbit (the approach
  // target), not pinned. `pin:true` pieces use fwdM/latM (metres, local frame);
  // the rest use trueAnomaly offsetMin/Max (≈ metres along-track).
  // M1 cluster (.kilo/plans/onboarding-tease-2-lateral-tune.md). Physical
  // hierarchy: every fragment renders sub-metre (sizeM ≈ radius, render ≈ 1.9×)
  // so NONE renders larger than the ~2 m mother; the cubesat #7 is the small,
  // dense, valuable "graduation" catch. Reward climbs 1→7 via mass + lowValue
  // (kept only on #1–#2) so early catches are cheap and later ones pay more —
  // progression by value, not strictly by size. All ≤10 kg (net-only on M1).
  //
  // appear/* hints drive Phase-2 candidate selection (which mesh-slot to reuse,
  // since spawn cannot rebind shape/material): plate = flat panel-shard variant,
  // material = the rendered colour (gold mli_mylar foil, blue solar_cell cell).
  { types: ['fragment'], sizeM: 0.60, lowValue: true, appearMaterial: 'aluminum', appearPlate: true,
    massMin: 3, massMax: 3,  pin: true, fwdM: 22, latM: 0 },   // #1 aluminium panel shard (flat) — dead centre, ~22 m, render ~1.15 m
  { types: ['fragment'], sizeM: 0.70, lowValue: true, appearMaterial: 'mli_mylar', appearPlate: true,
    massMin: 4, massMax: 4,  pin: true, fwdM: 45, latM: 18 },  // #2 MLI-foil scrap (gold flat) — right, in range (≈48 m), render ~1.33 m
  { types: ['fragment'], sizeM: 0.45, appearMaterial: 'solar_cell', appearPlate: true,
    massMin: 5, massMax: 5,  offsetMin: 0.0000195, offsetMax: 0.0000270 }, // #3 RANGE WALL — solar-cell shard ~130–180 m
  // Medium/far tier — still net-only on M1, so ≤10 kg; orbital placement.
  { types: ['fragment'], sizeM: 0.55, appearMaterial: 'aluminum', appearPlate: false,
    massMin: 6, massMax: 6,  offsetMin: 0.0000300, offsetMax: 0.0000600 }, // #4 aluminium fragment ~200–400m
  { types: ['fragment'], sizeM: 0.95, appearMaterial: 'solar_cell', appearPlate: true,
    massMin: 6, massMax: 6,  offsetMin: 0.0000600, offsetMax: 0.0001000 }, // #5 large thin solar-array section ~400–670m
  { types: ['fragment'], sizeM: 0.70, appearMaterial: 'mli_mylar', appearPlate: true,
    massMin: 8, massMax: 8,  offsetMin: 0.0001000, offsetMax: 0.0001600 }, // #6 foil + strut bundle ~670–1075m
  { types: ['cubesat'], sizeM: 0.30,
    massMin: 10, massMax: 10, offsetMin: 0.0001600, offsetMax: 0.0002200 }, // #7 cubesat (small whole microsat) ~1075–1475m
];

/** Altitude bands (km above surface) with percentage weights.
 *  ST-6.1: 7-band layout (added VLEO + MEO) lives in Constants.DEBRIS.ALT_BANDS.
 *  Fallback (5-band legacy shape) used only if Constants.DEBRIS is absent. */
const ALT_BANDS = (Constants.DEBRIS && Array.isArray(Constants.DEBRIS.ALT_BANDS))
  ? Constants.DEBRIS.ALT_BANDS
  : [
      { min: 200, max: 400,  weight: 0.20 },
      { min: 400, max: 600,  weight: 0.15 },
      { min: 700, max: 900,  weight: 0.30 },
      { min: 900, max: 1200, weight: 0.20 },
      { min: 1200, max: 2000, weight: 0.15 },
    ];

/** Inclination clusters (degrees) with relative weights */
const INC_CLUSTERS = [
  { center: 28.5, spread: 2.0, weight: 0.10 },   // Cape Canaveral
  { center: 51.6, spread: 1.5, weight: 0.15 },   // ISS
  { center: 65.0, spread: 3.0, weight: 0.10 },   // Russian
  { center: 72.0, spread: 2.0, weight: 0.08 },   // Russian
  { center: 82.0, spread: 2.0, weight: 0.07 },   // Russian SSO
  { center: 97.5, spread: 1.5, weight: 0.25 },   // Sun-synchronous
  { center: 45.0, spread: 40.0, weight: 0.25 },  // Random spread
];

/**
 * Named inclination clusters used for human-readable field/cluster IDs.
 * Shared by getDebrisClusters() and classifyClusterId() so the "field" a scan
 * surveys is identified identically everywhere. (id = `${incName}-${altMin}`.)
 */
const INC_NAMES = [
  { center: 28.5, spread: 2.0,  name: 'canaveral',  label: 'Cape Canaveral' },
  { center: 51.6, spread: 1.5,  name: 'iss',        label: 'ISS Band' },
  { center: 65.0, spread: 3.0,  name: 'russian65',  label: 'Russian 65°' },
  { center: 72.0, spread: 2.0,  name: 'russian72',  label: 'Russian 72°' },
  { center: 82.0, spread: 2.0,  name: 'russianSSO', label: 'Russian SSO' },
  { center: 97.5, spread: 1.5,  name: 'sso',        label: 'SSO Band' },
  { center: 45.0, spread: 40.0, name: 'scattered',  label: 'Scattered' },
];

/**
 * Classify an (altitudeKm, inclinationDeg) pair into a stable field/cluster id.
 * Returns null if the altitude is outside all tracked bands.
 * @param {number} altKm
 * @param {number} incDeg
 * @returns {string|null} e.g. 'iss-400' or null
 */
function classifyClusterId(altKm, incDeg) {
  let matchedAlt = null;
  for (const alt of ALT_BANDS) {
    if (altKm >= alt.min && altKm < alt.max) { matchedAlt = alt; break; }
  }
  if (!matchedAlt) return null;
  let bestInc = INC_NAMES[INC_NAMES.length - 1]; // default: scattered
  let bestDist = Infinity;
  for (const inc of INC_NAMES) {
    const dist = Math.abs(incDeg - inc.center);
    if (dist < inc.spread * 2 && dist < bestDist) { bestDist = dist; bestInc = inc; }
  }
  return `${bestInc.name}-${matchedAlt.min}`;
}

// ============================================================================
// HELPER: RANDOM FROM DISTRIBUTION
// ============================================================================

/** Pick a weighted random item from an array of { weight, ... } objects */
function weightedRandom(items) {
  const total = items.reduce((s, it) => s + it.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

/** Gaussian random (Box-Muller) */
function gaussRandom(mean = 0, stddev = 1) {
  const u1 = Math.random();
  const u2 = Math.random();
  return mean + stddev * Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
}

/** Random float in [min, max] */
function randRange(min, max) {
  return min + Math.random() * (max - min);
}

/** Random unit vector */
function randomUnitVector() {
  const theta = Math.random() * 2 * Math.PI;
  const phi = Math.acos(2 * Math.random() - 1);
  return new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.sin(phi) * Math.sin(theta),
    Math.cos(phi)
  );
}

// ============================================================================
// PRE-ALLOCATED ORBIT TEMPORARIES (avoids ~800 spread allocations per frame)
// ============================================================================
const _tmpKmOrbit = {
  semiMajorAxis: 0, eccentricity: 0, inclination: 0,
  raan: 0, argPerigee: 0, trueAnomaly: 0, meanMotion: 0,
};
const _tmpKmOrbit2 = {
  semiMajorAxis: 0, eccentricity: 0, inclination: 0,
  raan: 0, argPerigee: 0, trueAnomaly: 0, meanMotion: 0,
};

// ============================================================================
// DEBRIS FIELD
// ============================================================================

export class DebrisField {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts] - Options.
   * @param {object} [opts.catalogLoader] - Optional ST-6.1 catalogue source.
   *        If provided AND `.isReady()` is true, real entries populate first,
   *        with procedural entries topping up INTERACTIVE_COUNT. Null/undefined
   *        keeps pure-procedural behaviour for back-compat + unit tests.
   * @param {number} [opts.interactiveCount] - Override INTERACTIVE_COUNT (rare).
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this._catalogLoader = opts.catalogLoader || null;
    this._interactiveCount = opts.interactiveCount || INTERACTIVE_COUNT;

    /** @type {number} How many debris ended up sourced from the real catalogue. */
    this.realEntryCount = 0;
    this.group = new THREE.Group();
    this.group.name = 'DebrisField';
    scene.add(this.group);

    /** @type {Map<number, object>} All interactive debris keyed by ID */
    this.debrisMap = new Map();

    /** @type {Array<object>} Flat array of interactive debris for iteration */
    this.debrisList = [];

    /** InstancedMesh references by shape category */
    this.instancedMeshes = {}; // { fragment: InstancedMesh, rocketBody: ..., ... }

    /** Maps debris ID → { meshKey, instanceIndex } */
    this._instanceLookup = new Map();

    /** Reusable matrix for instance updates */
    this._tempMatrix = new THREE.Matrix4();
    this._tempQuat = new THREE.Quaternion();
    this._tempScale = new THREE.Vector3();
    this._tempPos = new THREE.Vector3();

    // Sprint 2 / PR A — scratch outputs for [`orbitToSceneCartesianInto`](js/entities/OrbitalMechanics.js:1).
    // Reused across every alive debris + every background-point batch each frame.
    this._tmpCartPos = { x: 0, y: 0, z: 0 };
    this._tmpCartVel = { x: 0, y: 0, z: 0 };
    // Background-orbit scratch: avoids the `{...orbit, semiMajorAxis: …}` spread
    // copy at [`DebrisField._updateBackground()`](js/entities/DebrisField.js:1322).
    this._tmpBgOrbit = {
      semiMajorAxis: 0,
      eccentricity: 0,
      inclination: 0,
      raan: 0,
      argPerigee: 0,
      trueAnomaly: 0,
    };

    /** UX-4: Floating origin reference position (camera-relative rendering) */
    this._floatingOrigin = new THREE.Vector3();
    this._floatingOriginInitialized = false;

    /** Pre-allocated colors for web shot tinting (Sprint D1) */
    this._webTintColor = new THREE.Color(0.85, 0.92, 1.0);
    this._defaultDebrisColor = new THREE.Color(1, 1, 1);
    /** Per-instance brightness boost for the pinned welcome pieces (#1/#2) so
     *  they catch the eye even on the shadow side without touching the shared
     *  (deliberately dim) material emissive. Kept modest (1.25×) so the foil /
     *  solar-cell material hue still reads as man-made debris rather than being
     *  washed to a neutral-grey "rock". See m1-debris-1-2-visibility plan. */
    this._welcomeBoostColor = new THREE.Color(1.25, 1.25, 1.25);

    /** ST-6.2: Pre-allocated temporaries for MOID colour tinting */
    this._moidTmpColor = new THREE.Color();
    this._moidTmpEmissive = new THREE.Color();

    /** ST-6.2: Flag overlay InstancedMeshes keyed by country code */
    this.flagMeshes = {};
    /** @type {Map<number, { country: string, instanceIndex: number }>} */
    this._flagLookup = new Map();
    /** Pre-allocated temporaries for surface-mounted flag placement */
    this._flagDirWorld = new THREE.Vector3();
    this._flagPos = new THREE.Vector3();
    this._flagPos2 = new THREE.Vector3();
    this._flagQuat = new THREE.Quaternion();
    this._flagScale = new THREE.Vector3();
    this._flagMatrix = new THREE.Matrix4();
    this._flagUp = new THREE.Vector3(0, 1, 0);
    this._flagAltUp = new THREE.Vector3(1, 0, 0);
    this._zeroVec = new THREE.Vector3(0, 0, 0);
    /** Plane geometry default normal (+Z) used to orient the decal outward */
    this._flagPlaneNormal = new THREE.Vector3(0, 0, 1);

    /** Background points */
    this.backgroundPoints = null;
    this._backgroundOrbits = [];

    /** @type {number} Background debris count (exposed for debug overlay) */
    this.backgroundCount = BACKGROUND_COUNT;

    this._nextId = 0;

    // --- Spatial query cache (Task 1B: avoid triple scan per frame) ---
    /** @type {Array<object>} Cached nearby debris results */
    this._cachedNearby = [];
    /** @type {number} Frame ID when cache was last computed */
    this._cacheFrame = -1;
    /** @type {THREE.Vector3} Cached query position */
    this._cachePos = new THREE.Vector3();
    /** @type {number} Cached query radius */
    this._cacheRadius = 0;
    /** @type {number} Current frame ID (set externally each frame) */
    this._frameId = -1;

    /** @type {boolean} Welcome field already spawned this game */
    this._welcomeFieldSpawned = false;
    /** @type {Set<number|string>} ids of onboarding tease pieces pinned ahead of
     *  the mother (orbit re-synced each frame) until each is caught. */
    this._onboardingPinIds = new Set();

    // ST-4.C: Mission profile state
    /** @type {object|null} Current mission profile from Constants.MISSIONS.PROFILES */
    this._currentMissionProfile = null;
    /** @type {number} Current mission number */
    this._currentMissionNumber = 1;

    // Build everything
    // §13 boot timeline (?logBoot=1) — finer-grain marks so we can attribute
    // DebrisField cost to procedural orbit generation vs. InstancedMesh build
    // vs. flag overlays vs. background Points. `window.__bootMark` is only
    // attached when `?logBoot=1` is set, and is optional-chained → zero
    // overhead by default and safe in Node test runner (no window global).
    const _bm = (typeof window !== 'undefined') ? window.__bootMark : null;
    this._generateDebris();
    _bm?.('DebrisField._generateDebris (procedural orbit gen) complete');
    initAtlases();                // ST-6.2: generate type + flag atlas textures
    _bm?.('DebrisField initAtlases (type + flag atlas textures) complete');
    this._buildInstancedMeshes();
    _bm?.('DebrisField._buildInstancedMeshes complete');
    this._buildFlagOverlays();    // ST-6.2: country flag decal overlay layer
    _bm?.('DebrisField._buildFlagOverlays complete');
    this._generateBackground();
    _bm?.('DebrisField._generateBackground (5000 Points) complete');

    // ST-6.1: hybrid-mode boot log
    if (this._catalogLoader && this._catalogLoader.isReady && this._catalogLoader.isReady()) {
      const proc = this.debrisList.length - this.realEntryCount;
      console.log(`[DebrisField] HYBRID mode. ${this.realEntryCount} real catalogue + ${proc} procedural filler`);
    }

    // Phase 6: Listen for EDT attract events to nudge small debris toward player
    eventBus.on(Events.EDT_ATTRACT, (data) => this._onEdtAttract(data));

    // Sprint D1: Listen for GSL web shot hits to apply drag multiplier
    eventBus.on(Events.WEB_SHOT_HIT, (data) => this._onWebShotHit(data));

    // Phase 3b (capture-feedback overhaul): tool-induced fragmentation — shed
    // fragments at the impact point; breakup/shatter also destroys the body.
    eventBus.on(Events.INTERACTION_FRAGMENTATION, (data) => this._onInteractionFragmentation(data));

    // ST-4.C: Listen for MISSION_START to update profile and allow re-spawn
    eventBus.on(Events.MISSION_START, (data) => {
      this._currentMissionProfile = data.profile;
      this._currentMissionNumber = data.missionNumber;
      // Reset welcome field flag so new field can spawn for this mission
      this._welcomeFieldSpawned = false;
      // Drop any stale onboarding tease pin from a prior mission/run.
      this._clearOnboardingPin();
      // 2026-05-15 polish (urgent): also reset the mission-1 hide flag so
      // the per-frame enforcement runs again if we somehow re-enter
      // mission 1 (e.g. retry / replay path).
      this._mission1HideApplied = false;
      // Restore any catalog debris that were hidden for mission 1 (only
      // applies when advancing to mission 2+).  Their orbital elements are
      // untouched; we just flip `alive`/`tracked` back on and let
      // _updateInstanceTransform repopulate the instance matrix next tick.
      if ((data.missionNumber || 1) > 1) {
        let restored = 0;
        for (const d of this.debrisList) {
          if (d._hiddenForMission1) {
            d._hiddenForMission1 = false;
            d.alive = true;
            d.tracked = true;
            restored++;
          }
        }
        if (restored > 0) {
          console.log(`[DebrisField] Mission ${data.missionNumber}: restored ${restored} previously hidden debris`);
        }
        // 2026-05-15 polish (urgent): restore the background-points cloud
        // when advancing past mission 1 — it's hidden during M1 so the
        // pilot sees a clean ≤2 km welcome cluster instead of decorative
        // dots at multi-km range that look like real debris.
        if (this.backgroundPoints) {
          this.backgroundPoints.visible = true;
        }
      } else {
        // Mission 1 (re-entry path): hide background points immediately.
        if (this.backgroundPoints) {
          this.backgroundPoints.visible = false;
        }
      }
    });

    // Welcome field: reset flag on game reset
    eventBus.on(Events.GAME_RESET, () => {
      this._welcomeFieldSpawned = false;
      this._currentMissionProfile = null;   // ST-4.C
      this._currentMissionNumber = 1;       // ST-4.C
      for (const d of this.debrisList) d.welcomeSpawn = false;
      this._clearOnboardingPin();
    });

    // Onboarding tease pin release: hand a curated piece back to normal
    // co-orbital propagation once it leaves play. Each pinned piece (#1, #2) is
    // released independently by id, so catching #1 doesn't unpin #2. Released on:
    //  • LASSO_CONTACT — the Mother net's reel-in begins. This MUST release the
    //    pin at contact (not completion): otherwise the highest-priority pin
    //    branch in _updateInstanceTransform keeps re-pinning the piece to its
    //    fixed mother-local offset every reel frame, so the net package reels in
    //    but the debris stays frozen in place, then vanishes when removeDebris
    //    zeroes its scale. The LassoSystem reel then drives the piece to the
    //    mother via the authoritative _armPinned/_armPinPos direct-copy pin.
    //  • ARM_CAPTURED — daughter-arm catch path (payload uses targetId/debrisId).
    //  • DEBRIS_REMOVED — the reliable "tease consumed" backstop (fragmentation,
    //    web de-orbit, or any catch that ends in removeDebris).
    //  • ONBOARDING_COMPLETE — player skipped/finished the guided flow (clear all).
    const _releaseIfMatch = (d) => {
      const id = d?.debrisId ?? d?.targetId ?? d?.id;
      if (id != null && this._onboardingPinIds.has(id)) this._clearOnboardingPin(id);
    };
    if (Events.ARM_CAPTURED) eventBus.on(Events.ARM_CAPTURED, _releaseIfMatch);
    if (Events.LASSO_CONTACT) eventBus.on(Events.LASSO_CONTACT, _releaseIfMatch);
    if (Events.DEBRIS_REMOVED) eventBus.on(Events.DEBRIS_REMOVED, _releaseIfMatch);
    if (Events.ONBOARDING_COMPLETE) {
      eventBus.on(Events.ONBOARDING_COMPLETE, () => this._clearOnboardingPin());
    }

    console.log(`[DebrisField] ${this.debrisList.length} interactive + ${BACKGROUND_COUNT} background debris`);
  }

  // ==========================================================================
  // GENERATION
  // ==========================================================================

  /** @private Generate all interactive debris data.
   *  ST-6.1: hybrid mode — real catalogue entries populate first, then
   *  procedural entries top up INTERACTIVE_COUNT. */
  _generateDebris() {
    const total = this._interactiveCount;

    // --- Phase 1: real catalogue entries (if loader is ready) ---
    if (this._catalogLoader && this._catalogLoader.isReady && this._catalogLoader.isReady()) {
      const catalogue = (typeof this._catalogLoader.getAllDebris === 'function')
        ? this._catalogLoader.getAllDebris() : [];
      const maxReal = Math.min(catalogue.length, total);
      for (let i = 0; i < maxReal; i++) {
        const entry = catalogue[i];
        if (!entry) continue;
        const kind = String(entry.type || '').toLowerCase();
        if (kind === 'active') continue; // never spawn active sats as debris
        const data = catalogEntryToDebrisData(entry, this._nextId);
        if (!data) continue;
        this._finaliseRealDebris(data);
        this.debrisMap.set(data.id, data);
        this.debrisList.push(data);
        this._nextId++;
        this.realEntryCount++;
      }
    }

    // --- Phase 2: procedural filler ---
    while (this.debrisList.length < total) {
      const debris = this._createDebrisData();
      debris.isReal = false;
      this.debrisMap.set(debris.id, debris);
      this.debrisList.push(debris);
    }

    // UX-3 #9: All debris starts hidden — auto-discover runs after welcome-field spawn in update()
  }

  /**
   * UX-3 #9: Auto-discover the nearest debris to the start position.
   * Called once after debris generation so the player always has at least one target.
   * @private
   */
  _autoDiscoverNearest() {
    // Use start orbit SMA as proxy for player position (center of player shell)
    const startSma = Constants.EARTH_RADIUS + Constants.START_ALTITUDE;
    let closest = null;
    let closestDist = Infinity;
    for (const d of this.debrisList) {
      if (!d.alive) continue;
      const dist = Math.abs(d.orbit.semiMajorAxis - startSma);
      if (dist < closestDist) {
        closestDist = dist;
        closest = d;
      }
    }
    if (closest) {
      closest.discovered = true;
    }
  }

  /** @private Convert CatalogConverter's Node-safe seed into THREE.js runtime form.
   *  Specifically: tumbleAxis plain {x,y,z} → THREE.Vector3, generate salvage.
   *  Does NOT mutate the catalogue entry — only the debris-data object passed in. */
  _finaliseRealDebris(data) {
    // Upgrade tumbleAxis to Vector3 (CatalogConverter returns plain obj)
    if (!data.tumbleAxis || !data.tumbleAxis.isVector3) {
      const a = data.tumbleAxis || { x: 0, y: 1, z: 0 };
      data.tumbleAxis = new THREE.Vector3(a.x || 0, a.y || 0, a.z || 0).normalize();
    }
    // Generate salvage using existing procedural heuristics (mass + material keyed)
    const sal = this._generateSalvage(data.type, data.mass, data.material);
    data.salvage = sal;
    data.hasSalvage = sal.xenon > 0 || sal.indium > 0 || sal.gaAs > 0 ||
                       sal.battery > 0 || sal.hydrazine > 0 || sal.lithium > 0 ||
                       (sal.metals && sal.metals.length > 0);
    data.metalMassKg = (sal.metals || []).reduce((s, m) => s + m.amount, 0);
    // ST-6.2: ensure moidBadge is initialised (ConjunctionSystem stamps later)
    if (data.moidBadge === undefined) data.moidBadge = null;
    // UX-3 #9: Hidden until scanned
    if (data.discovered === undefined) data.discovered = false;
    // Onboarding tease pin fields — keep the same hidden class as procedural
    // debris so the per-frame update read stays monomorphic.
    if (data._onboardingPinned === undefined) data._onboardingPinned = false;
    if (data._onboardingPinFwd === undefined) data._onboardingPinFwd = 0;
    if (data._onboardingPinLat === undefined) data._onboardingPinLat = 0;
  }

  /** @private Create a single debris data object */
  _createDebrisData() {
    const id = this._nextId++;

    // Pick type by weighted distribution
    const typeEntries = Object.entries(DEBRIS_TYPES);
    const typeItem = weightedRandom(typeEntries.map(([k, v]) => ({ key: k, ...v })));
    const type = typeItem.key;
    const typeDef = DEBRIS_TYPES[type];

    // Size & mass — debug session 2026-05-15 polish task 6:
    // sizeMeter and mass were previously **independent** uniform rolls
    // inside each type's [sizeMin..sizeMax] and [massMin..massMax]
    // ranges. The visible result was a 5 kg fragment that rendered the
    // same size as a 200 kg defunctSat, breaking the player's
    // "big-looking debris should yield big salvage" expectation
    // (salvage IS roughly linear in mass; the mismatch was upstream).
    //
    // New formula: mass is the primary random; sizeMeter follows the
    // type's mass→size envelope with a ±15 % jitter so visually-
    // similar masses still look distinct. Matches the regen path
    // already used at line ~1389 (catalog conversion to procedural).
    const mass = randRange(typeDef.massMin, typeDef.massMax);
    const _massSpan = typeDef.massMax - typeDef.massMin;
    const _massFrac = _massSpan > 0 ? (mass - typeDef.massMin) / _massSpan : 0.5;
    const _sizeSpan = typeDef.sizeMax - typeDef.sizeMin;
    const _sizeMid  = typeDef.sizeMin + _massFrac * _sizeSpan;
    const _sizeJitter = 0.85 + Math.random() * 0.30;   // ±15 %
    const sizeMeter = Math.max(
      typeDef.sizeMin * 0.7,
      Math.min(typeDef.sizeMax * 1.15, _sizeMid * _sizeJitter)
    );

    // Tumble
    const tumbleRateDeg = randRange(typeDef.tumbleMin, typeDef.tumbleMax);
    const tumbleRate = tumbleRateDeg * Math.PI / 180; // rad/s
    const tumbleAxis = randomUnitVector();

    // Material — weighted by type so gold MLI / blue solar cells stay rare and
    // concentrated on satellites (real debris is mostly metal/composite).
    const material = weightedMaterial(type);

    // Brittleness
    const brittleness = Math.random();

    // Tracked — probability based on debris type (real-world catalog coverage)
    const tracked = Math.random() < (TRACKING_PROB[type] || 0.5);

    // Orbit: pick altitude band and inclination cluster
    const altBand = weightedRandom(ALT_BANDS);
    const altKm = gaussRandom((altBand.min + altBand.max) / 2, (altBand.max - altBand.min) / 4);
    const clampedAlt = Math.max(180, Math.min(2000, altKm));

    const incCluster = weightedRandom(INC_CLUSTERS);
    const incDeg = gaussRandom(incCluster.center, incCluster.spread);
    const clampedInc = Math.max(0, Math.min(180, incDeg));

    const smaScene = Constants.EARTH_RADIUS + clampedAlt * Constants.SCENE_SCALE;

    const orbit = {
      semiMajorAxis: smaScene,
      eccentricity: Math.random() * 0.02,
      inclination: clampedInc * Math.PI / 180,
      raan: Math.random() * 2 * Math.PI,
      argPerigee: Math.random() * 2 * Math.PI,
      trueAnomaly: Math.random() * 2 * Math.PI,
      meanMotion: 0,
    };

    // Scene-scale size (meters → scene units: 1m = 0.00001 scene units)
    const sceneSize = sizeMeter * 0.00001;

    // --- Salvage generation (Session 10) ---
    const salvage = this._generateSalvage(type, mass, material);
    const hasSalvage = salvage.xenon > 0 || salvage.indium > 0 ||
                       salvage.gaAs > 0 || salvage.battery > 0 || salvage.hydrazine > 0 ||
                       salvage.lithium > 0 ||
                       (salvage.metals && salvage.metals.length > 0);

    // Total metal mass for ΔV calculations (Phase 2)
    const metalMassKg = (salvage.metals || [])
      .reduce((sum, m) => sum + m.amount, 0);

    // ST-6.2: Derive catalogType for procedural debris (real entries set this in CatalogConverter)
    const catalogType = (type === 'fragment' && mass < 1)
      ? 'fragment'
      : (PROC_TYPE_TO_CATALOG[type] || 'debris');

    return {
      id,
      type,
      orbit,
      sizeMeter,
      sceneSize,
      mass,
      // Phase 2 (ASPECT_CAPTURE): aspect-derived extents. sizeMeter remains
      // the max extent (long axis); widthM is the end-on cross-section the
      // net actually has to swallow.
      lengthM: sizeMeter,
      widthM: sizeMeter / (typeDef.aspect || 1.0),
      tumbleRate,
      tumbleAxis,
      tumbleAngle: Math.random() * 2 * Math.PI, // Current rotation
      material,
      brittleness,
      tracked,
      shape: typeDef.shape,
      alive: true,
      salvage,
      hasSalvage,
      metalMassKg,
      // DAUGHTER_MULTITOOL_SPEC §6 — capture recommender inputs (graceful).
      // ferromagnetic / hasFerrousFasteners (P2), hasGrappleFixture (P3),
      // surfaceRoughness (P4 pad-mode resolver). Shared SSOT: debrisFerrous.js.
      ...deriveCaptureFlags(material, type, mass),
      // ST-6.2: Visual data for atlas system
      isReal: false,
      country: null,
      catalogType,
      moidBadge: null,
      // UX-3 #9: Hidden until scanned — staggered reveal
      discovered: false,
      // Onboarding tease pin (init on every piece so all debris share one
      // hidden class). Only the curated M1 tease piece ever flips these on.
      _onboardingPinned: false,
      _onboardingPinFwd: 0,
      _onboardingPinLat: 0,
    };
  }

  /**
   * Generate salvage contents for a debris object based on type/mass/material.
   * @private
   * @param {string} type - debris type key
   * @param {number} mass - debris mass in kg
   * @param {string} material - material type
   * @returns {{ xenon: number, indium: number, gaAs: number, battery: number, hydrazine: number, metals: Array<{type: string, subtype: string, name: string, amount: number, unit: string, value: number, ispAsThrust: number, color: string}> }}
   */
  _generateSalvage(type, mass, material) {
    const C = Constants;
    const salvage = { xenon: 0, indium: 0, gaAs: 0, battery: 0, hydrazine: 0, lithium: 0, metals: [] };

    switch (type) {
      case 'defunctSat': {
        // Large ion-propelled satellites have more Xenon
        if (mass > 500 && Math.random() < C.SALVAGE_PROB_DEFUNCT_SAT_XENON_LARGE) {
          salvage.xenon = C.SALVAGE_XENON_LARGE_MIN +
            Math.random() * (C.SALVAGE_XENON_LARGE_MAX - C.SALVAGE_XENON_LARGE_MIN);
        } else if (Math.random() < C.SALVAGE_PROB_DEFUNCT_SAT_XENON) {
          salvage.xenon = C.SALVAGE_XENON_MIN +
            Math.random() * (C.SALVAGE_XENON_MAX - C.SALVAGE_XENON_MIN);
        }
        // Solar panel fragments
        if (Math.random() < C.SALVAGE_PROB_DEFUNCT_SAT_GAAS) {
          salvage.gaAs = C.SALVAGE_GAAS_MIN +
            Math.random() * (C.SALVAGE_GAAS_MAX - C.SALVAGE_GAAS_MIN);
        }
        // Battery charge
        if (Math.random() < C.SALVAGE_PROB_DEFUNCT_SAT_BATTERY) {
          salvage.battery = C.SALVAGE_BATTERY_MIN +
            Math.random() * (C.SALVAGE_BATTERY_MAX - C.SALVAGE_BATTERY_MIN);
        }
        // F16: Lithium from defunct satellite Li-ion batteries / propulsion systems
        if (Math.random() < (C.SALVAGE_PROB_DEFUNCT_SAT_LITHIUM || 0.25)) {
          salvage.lithium = (C.SALVAGE_LITHIUM_MIN || 5) +
            Math.random() * ((C.SALVAGE_LITHIUM_MAX || 15) - (C.SALVAGE_LITHIUM_MIN || 5));
        }
        break;
      }
      case 'rocketBody': {
        // Residual hydrazine (hazardous)
        if (Math.random() < C.SALVAGE_PROB_ROCKET_BODY_HYDRAZINE) {
          salvage.hydrazine = C.SALVAGE_HYDRAZINE_MIN +
            Math.random() * (C.SALVAGE_HYDRAZINE_MAX - C.SALVAGE_HYDRAZINE_MIN);
        }
        // Rare: electric upper stage with Xenon
        if (Math.random() < C.SALVAGE_PROB_ROCKET_BODY_XENON) {
          salvage.xenon = C.SALVAGE_XENON_LARGE_MIN +
            Math.random() * (C.SALVAGE_XENON_LARGE_MAX - C.SALVAGE_XENON_LARGE_MIN);
        }
        break;
      }
      case 'missionDebris': {
        // FEEP thruster components (Indium)
        if (Math.random() < C.SALVAGE_PROB_MISSION_DEBRIS_INDIUM) {
          salvage.indium = C.SALVAGE_INDIUM_MIN +
            Math.random() * (C.SALVAGE_INDIUM_MAX - C.SALVAGE_INDIUM_MIN);
        }
        // Small power systems
        if (Math.random() < C.SALVAGE_PROB_MISSION_DEBRIS_BATTERY) {
          salvage.battery = C.SALVAGE_BATTERY_MIN +
            Math.random() * (C.SALVAGE_BATTERY_MAX - C.SALVAGE_BATTERY_MIN) * 0.5;
        }
        break;
      }
      case 'fragment': {
        // NOTE: Fragments are now never the `solar_cell` material (see
        // MATERIAL_WEIGHTS_BY_TYPE) — intact PV cells don't survive as loose
        // explosion shards, so fragment-sourced GaAs was removed. GaAs salvage
        // still comes from defunctSat (type-based, above). The orphaned
        // SALVAGE_PROB_FRAGMENT_GAAS constant is left in Constants.js for any
        // future re-introduction.
        // Trace Indium in titanium alloys
        if (material === 'titanium' && Math.random() < C.SALVAGE_PROB_FRAGMENT_INDIUM) {
          salvage.indium = C.SALVAGE_INDIUM_MIN +
            Math.random() * (C.SALVAGE_INDIUM_MAX - C.SALVAGE_INDIUM_MIN) * 0.4;
        }
        break;
      }
    }

    // --- Metal salvage generation (Phase 2) ---
    const metalProfile = C.DEBRIS_METAL_PROFILES[type] || C.DEBRIS_METAL_PROFILES.fragment;
    const recoverableFraction = 0.3 + Math.random() * 0.4; // 30-70% of mass is recoverable
    const recoverableMass = mass * recoverableFraction;

    for (const [metalId, fraction] of Object.entries(metalProfile)) {
      const metalDef = Object.values(C.METALS).find(m => m.id === metalId);
      if (!metalDef) continue;

      const metalMass = recoverableMass * fraction;
      if (metalMass < 0.1) continue; // skip trace amounts

      // Add some randomness (±30%)
      const finalMass = metalMass * (0.7 + Math.random() * 0.6);

      salvage.metals.push({
        type: 'metal',
        subtype: metalDef.id,
        name: metalDef.name,
        amount: Math.round(finalMass * 10) / 10,
        unit: 'kg',
        value: Math.round(finalMass * metalDef.marketValue),
        ispAsThrust: metalDef.ispAsThrust,
        color: metalDef.color,
      });
    }

    return salvage;
  }

  // ==========================================================================
  // INSTANCED MESH CONSTRUCTION
  // ==========================================================================

  // TODO(PR-6/P3.15): InstancedMesh merge opportunity — currently one mesh per
  // (type, material, variant) key. Profiling with ?profile=1 will reveal if the
  // ~20-30 draw calls from debris meshes are a bottleneck. Potential merge:
  // unify materials into a single atlas-textured MeshStandardMaterial and batch
  // all fragments into one InstancedMesh. Non-trivial: requires UV remapping,
  // per-instance colour attributes, and flag overlay rewrite. Deferred.

  /** @private Build InstancedMesh per (type, material) with wireframe-derived geometry (ST-2.3) */
  _buildInstancedMeshes() {
    const N = Constants.DEBRIS_FRAGMENT_VARIANTS || 7;

    // Count per compound key and assign _meshKey to each debris
    const counts = {};
    const indexMap = {};

    for (const d of this.debrisList) {
      // Fragment variant via id % N; other types have no variant suffix
      const key = d.type === 'fragment'
        ? `${d.type}:${d.material}:${d.id % N}`
        : `${d.type}:${d.material}`;
      d._meshKey = key;
      counts[key] = (counts[key] || 0) + 1;
      indexMap[key] = 0;
    }

    // Create InstancedMesh for each compound key
    for (const [key, count] of Object.entries(counts)) {
      if (count === 0) continue;
      const parts = key.split(':');
      const type = parts[0];
      const material = parts[1];
      const variantId = parts.length > 2 ? parseInt(parts[2], 10) : 0;

      // Wireframe-derived geometry per type (fragments get per-variant geometry)
      const geo = DebrisWireframe.getGeometry(type, variantId);

      // Material properties from Constants.DEBRIS_MATERIALS
      const matDef = Constants.DEBRIS_MATERIALS[material] || Constants.DEBRIS_MATERIALS.aluminum;

      // ST-6.2: Determine visual mode — textured with atlas or wireframe
      const isTextured = getVisualMode() === 'textured';
      const catalogType = PROC_TYPE_TO_CATALOG[type] || 'debris';

      let mat;
      if (isTextured) {
        // Self-illumination (emissive) keeps debris faintly visible on the
        // night side without a sun. Previously this was the FULL material
        // colour at 0.15 — an additive glow that painted every piece its
        // material hue (gold MLI especially) and washed the whole field toward
        // a flat, uniform look, defeating the per-instance colour variation.
        //
        // Real debris is only lit by sun + earthshine, so we use a very dim,
        // heavily-desaturated tint of the material colour (a cool ash glow)
        // rather than the saturated hue. This preserves "visible in shadow"
        // while letting the texture, instance tint, and material albedo —
        // not a constant coloured wash — drive the perceived colour.
        const emissiveColor = new THREE.Color(matDef.color);
        const _emHSL = { h: 0, s: 0, l: 0 };
        if (_SRGB) emissiveColor.getHSL(_emHSL, _SRGB); else emissiveColor.getHSL(_emHSL);
        _emHSL.s *= 0.25;                       // strip most of the hue
        _emHSL.l = Math.min(_emHSL.l, 0.30);    // keep it dim
        if (_SRGB) emissiveColor.setHSL(_emHSL.h, _emHSL.s, _emHSL.l, _SRGB);
        else emissiveColor.setHSL(_emHSL.h, _emHSL.s, _emHSL.l);

        mat = new THREE.MeshStandardMaterial({
          color: matDef.color,
          metalness: matDef.metalness,
          roughness: matDef.roughness,
          emissive: emissiveColor,
          emissiveIntensity: 0.06,
        });
        // ST-6.2: Apply type atlas texture if available
        const typeAtlasTex = getTypeAtlasTexture();
        if (typeAtlasTex) {
          const uvs = getUVOffsetForType(catalogType);
          const clonedTex = typeAtlasTex.clone();
          clonedTex.offset.set(uvs.offsetU, uvs.offsetV);
          clonedTex.repeat.set(uvs.scaleU, uvs.scaleV);
          mat.map = clonedTex;
          mat.needsUpdate = true;

          // The atlas texture ALREADY carries type-characteristic colour
          // (silver hull, blue solar cells, gold MLI patches, charred metal).
          // The final fragment colour is color × map × instanceColor — three
          // colour sources multiplied. If `color` stays the full saturated
          // material hue (e.g. gold 0xFFD700) it double-tints the already-
          // coloured atlas and muddies everything. Soften `color` toward a
          // light neutral tint so the texture reads truthfully and the
          // material identity is carried by metalness/roughness instead.
          const tint = new THREE.Color(matDef.color);
          const _tHSL = { h: 0, s: 0, l: 0 };
          if (_SRGB) tint.getHSL(_tHSL, _SRGB); else tint.getHSL(_tHSL);
          _tHSL.s *= 0.35;                                 // mostly neutral
          _tHSL.l = Math.max(0.72, Math.min(0.92, _tHSL.l)); // bright modulator
          if (_SRGB) tint.setHSL(_tHSL.h, _tHSL.s, _tHSL.l, _SRGB);
          else tint.setHSL(_tHSL.h, _tHSL.s, _tHSL.l);
          mat.color = tint;
        }
      } else {
        // Wireframe fallback
        mat = new THREE.MeshStandardMaterial({
          color: matDef.color,
          metalness: matDef.metalness,
          roughness: matDef.roughness,
          wireframe: true,
        });
      }

      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.name = `Debris_${type}_${material}${parts.length > 2 ? '_v' + parts[2] : ''}`;
      mesh.frustumCulled = false; // We'll handle LOD manually

      // Sprint D1: Initialize instanceColor with white defaults for web shot tinting
      const defaultColor = new THREE.Color(1, 1, 1);
      for (let i = 0; i < count; i++) {
        mesh.setColorAt(i, defaultColor);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

      this.group.add(mesh);
      this.instancedMeshes[key] = mesh;
    }

    // Assign each debris to an instance index
    // ST-6.2: set instanceColor per debris using catalogType base colour
    const _tmpTypeColor = new THREE.Color();
    for (const d of this.debrisList) {
      const idx = indexMap[d._meshKey]++;
      this._instanceLookup.set(d.id, { meshKey: d._meshKey, instanceIndex: idx });

      // Tint instance with a near-white weathering modulator (NOT the dark
      // type colour — that lives in the atlas) plus deterministic per-instance
      // variation, so the field reads as individually-weathered hardware
      // instead of a flat dim mass.
      const baseHex = getInstanceTintBase(d.catalogType || 'unknown');
      _tmpTypeColor.set(baseHex);
      applyInstanceColorVariation(_tmpTypeColor, d.id, d.catalogType);
      const mesh = this.instancedMeshes[d._meshKey];
      if (mesh) {
        mesh.setColorAt(idx, _tmpTypeColor);
      }

      // Set initial transform
      this._updateInstanceTransform(d, idx);
    }

    // Mark instanceColor as updated
    for (const mesh of Object.values(this.instancedMeshes)) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  // ==========================================================================
  // FLAG OVERLAYS (ST-6.2: Option B — second InstancedMesh layer per country)
  // ==========================================================================

  /**
   * Build flag decal overlay InstancedMeshes grouped by country code.
   * Each country gets a small PlaneGeometry with the flag atlas UV-mapped
   * to that country's slot.
   *
   * Item 12 (2026-06-12): eligibility is now CLASS-gated — only rocket bodies
   * and defunct sats ≥ FLAG_MIN_SIZE_M get a flag (fragments never). Eligible
   * PROCEDURAL pieces get a deterministic weighted country at build time
   * (real catalog rows keep their own), so flags appear in early missions,
   * not just on catalog debris.
   * @private
   */
  _buildFlagOverlays() {
    const flagAtlasTex = getFlagAtlasTexture();
    if (!flagAtlasTex) return; // No atlas (Node tests or mode=wireframe)

    // Assign a deterministic country to eligible procedural debris first.
    for (const d of this.debrisList) {
      if (!d.country && !d.isReal && isFlagEligible(d)) {
        d.country = pickCountryForId(d.id);
      }
    }

    // Group eligible debris by country
    const countryGroups = {};
    for (const d of this.debrisList) {
      if (!d.country || d.country === '---' || !isFlagEligible(d)) continue;
      const cc = d.country;
      if (!countryGroups[cc]) countryGroups[cc] = [];
      countryGroups[cc].push(d);
    }

    if (Object.keys(countryGroups).length === 0) return;

    // Flag decal patch (aspect ~3:2). Sized in debris-local units so it reads
    // as a sticker painted ON the hull (NASA/ESA style), not a floating banner.
    // Local debris geometry has bounding radius ~1, so a ~0.7-wide patch covers
    // a believable area of the surface.
    const flagGeo = new THREE.PlaneGeometry(0.7, 0.47);

    const indexCounters = {};

    for (const [cc, debrisList] of Object.entries(countryGroups)) {
      const count = debrisList.length;
      if (count === 0) continue;

      // Clone atlas texture with UV offset for this country
      const uvInfo = getUVOffsetForCountry(cc);
      const tex = flagAtlasTex.clone();
      tex.offset.set(uvInfo.offsetU, uvInfo.offsetV);
      tex.repeat.set(uvInfo.scaleU, uvInfo.scaleV);

      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        alphaTest: 0.1,
        side: THREE.DoubleSide,
        depthWrite: false,
      });

      const mesh = new THREE.InstancedMesh(flagGeo, mat, count);
      mesh.name = `Flag_${cc}`;
      mesh.frustumCulled = false;

      // Initialise all flag instances at origin (will be placed in update)
      const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < count; i++) {
        mesh.setMatrixAt(i, zeroMatrix);
      }

      this.group.add(mesh);
      this.flagMeshes[cc] = mesh;
      indexCounters[cc] = 0;
    }

    // Assign each eligible debris to a flag instance slot
    for (const d of this.debrisList) {
      if (!d.country || d.country === '---' || !isFlagEligible(d)) continue;
      const cc = d.country;
      if (!this.flagMeshes[cc]) continue;
      const idx = indexCounters[cc]++;
      this._flagLookup.set(d.id, { country: cc, instanceIndex: idx });

      // Deterministic surface-mount direction (which face of the hull the decal
      // sits on). Derived from the id so a piece always wears its flag the same
      // way. Bias toward the "side" of the object (low |y|) so the flag faces
      // out from a body panel rather than off the nose/engine.
      if (!d._flagDir) {
        const a = (Math.sin(d.id * 12.9898) * 43758.5453);
        const b = (Math.sin(d.id * 4.1414 + 0.7) * 13218.114);
        const az = (a - Math.floor(a)) * Math.PI * 2;
        const ny = ((b - Math.floor(b)) - 0.5) * 0.5;       // small vertical tilt
        const horiz = Math.sqrt(Math.max(0, 1 - ny * ny));
        d._flagDir = new THREE.Vector3(
          Math.cos(az) * horiz, ny, Math.sin(az) * horiz
        ).normalize();
      }
    }
  }

  // ==========================================================================
  // BACKGROUND DEBRIS (Points)
  // ==========================================================================

  /** @private */
  _generateBackground() {
    const positions = new Float32Array(BACKGROUND_COUNT * 3);
    const colors = new Float32Array(BACKGROUND_COUNT * 3);
    const sizes = new Float32Array(BACKGROUND_COUNT);

    this._backgroundOrbits = [];

    for (let i = 0; i < BACKGROUND_COUNT; i++) {
      // Pick altitude band
      const altBand = weightedRandom(ALT_BANDS);
      const altKm = gaussRandom(
        (altBand.min + altBand.max) / 2,
        (altBand.max - altBand.min) / 4
      );
      const clampedAlt = Math.max(180, Math.min(2000, altKm));
      const smaScene = Constants.EARTH_RADIUS + clampedAlt * Constants.SCENE_SCALE;

      // Pick inclination
      const incCluster = weightedRandom(INC_CLUSTERS);
      const incDeg = gaussRandom(incCluster.center, incCluster.spread);

      const orbit = {
        semiMajorAxis: smaScene,
        eccentricity: Math.random() * 0.015,
        inclination: Math.max(0, Math.min(180, incDeg)) * Math.PI / 180,
        raan: Math.random() * 2 * Math.PI,
        argPerigee: Math.random() * 2 * Math.PI,
        trueAnomaly: Math.random() * 2 * Math.PI,
        meanMotion: 0,
      };

      this._backgroundOrbits.push(orbit);

      // Initial position
      const cart = orbitToSceneCartesian(orbit);
      positions[i * 3] = cart.position.x;
      positions[i * 3 + 1] = cart.position.y;
      positions[i * 3 + 2] = cart.position.z;

      // Color: slightly warm grayish
      colors[i * 3] = 0.6 + Math.random() * 0.3;
      colors[i * 3 + 1] = 0.55 + Math.random() * 0.25;
      colors[i * 3 + 2] = 0.5 + Math.random() * 0.2;

      // Size: tiny dots
      sizes[i] = 1.0 + Math.random() * 2.0;
    }

    const bgGeo = new THREE.BufferGeometry();
    bgGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    bgGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    bgGeo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const bgMat = new THREE.PointsMaterial({
      size: 0.0002,
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      sizeAttenuation: true,
      depthWrite: false,
    });

    this.backgroundPoints = new THREE.Points(bgGeo, bgMat);
    this.backgroundPoints.name = 'BackgroundDebris';
    this.group.add(this.backgroundPoints);
  }

  /**
   * Boost the background debris cloud for the MENU backdrop reveal, or restore it.
   *
   * The transparent menu hero canvas composites over the live game scene, and the
   * faint background dust (size 0.0002 / opacity 0.6) can read too subtle behind
   * the menu UI. This makes it visibly denser while the menu is showing.
   *
   * Mission 1 hides `backgroundPoints` (see the _mission1HideApplied path). This
   * method stores/restores the exact prior `.visible`/`size`/`opacity`, so exiting
   * the boost automatically re-applies whatever hidden state was active on entry
   * (if `visible:false` was stored, that's what gets restored) — no need to
   * consult the mission number or _mission1HideApplied here.
   *
   * @param {boolean} on  true to boost, false to restore.
   */
  setMenuBackdropBoost(on) {
    const pts = this.backgroundPoints;
    if (!pts || !pts.material) return;
    if (on) {
      if (this._menuBackdropBoost) return;   // already boosted — no-op
      this._menuBackdropBoost = {
        visible: pts.visible,
        size: pts.material.size,
        opacity: pts.material.opacity,
      };
      pts.visible = true;
      pts.material.size = this._menuBackdropBoost.size * 2;   // 0.0002 → 0.0004
      pts.material.opacity = 0.85;
    } else {
      const prev = this._menuBackdropBoost;
      if (!prev) return;   // not boosted — no-op
      pts.visible = prev.visible;
      pts.material.size = prev.size;
      pts.material.opacity = prev.opacity;
      this._menuBackdropBoost = null;
    }
  }

  // ==========================================================================
  // UPDATE
  // ==========================================================================

  /**
   * Advance a debris's visual tumble angle for this frame, clamped to
   * DEBRIS_MAX_VISUAL_TUMBLE_DEG_S (ST-2.3).
   *
   * A CAPTURED debris is cinched in the net (held by, or pinned to, a daughter),
   * which arrests its tumble — so its orientation is frozen while held: it does
   * not rotate while reeling in or while parked at the strut tip. The angle
   * resumes advancing from where it stopped if the catch is ever released (the
   * `_capturedByArm` / `_armPinned` flags clear), so a dropped catch tumbles
   * again naturally.
   *
   * @param {object} debris        canonical debris record (mutated in place)
   * @param {number} dt            real-frame delta seconds
   * @param {number} maxVisualRad  per-frame visual-rate clamp (rad/s)
   */
  static _advanceTumble(debris, dt, maxVisualRad) {
    if (debris._capturedByArm || debris._armPinned) return; // cinched — no tumble
    const visualRate = Math.min(debris.tumbleRate * Constants.TIME_SCALE_GAMEPLAY, maxVisualRad);
    debris.tumbleAngle += visualRate * dt;
  }

  /**
   * Per-frame update: propagate orbits, update instance transforms, update background.
   * @param {number} dt - Real-time delta (seconds)
   * @param {THREE.Vector3} [playerPos] - Player position for LOD
   * @param {object} [playerOrbit] - Player orbital elements (for tutorial debris spawning)
   */
  update(dt, playerPos, playerOrbit) {
    const gameDt = dt * Constants.TIME_SCALE_GAMEPLAY;

    // UX-4: Update floating origin to player position (camera-relative rendering)
    if (Constants.FLOATING_ORIGIN_ENABLED && playerPos) {
      // On first frame: adjust all existing background point positions
      if (!this._floatingOriginInitialized && this.backgroundPoints) {
        const posAttr = this.backgroundPoints.geometry.attributes.position;
        for (let i = 0; i < posAttr.count; i++) {
          posAttr.setXYZ(i,
            posAttr.getX(i) - playerPos.x,
            posAttr.getY(i) - playerPos.y,
            posAttr.getZ(i) - playerPos.z
          );
        }
        posAttr.needsUpdate = true;
        this._floatingOriginInitialized = true;
      }
      this._floatingOrigin.copy(playerPos);
      this.group.position.copy(playerPos);
      // ── Belt-and-suspenders: force the group's world matrix to refresh now
      // rather than relying on the renderer's deferred scene.updateMatrixWorld()
      // traversal at draw time. With Three.js defaults (matrixAutoUpdate=true),
      // the renderer will recompute group.matrixWorld on the next render call
      // anyway, so this call is *technically redundant* — but it guarantees
      // that any consumer reading group.matrixWorld between now and the render
      // (raycaster, project() in a diagnostic, lookAt math, screen-space metric,
      // post-process passes, etc.) sees up-to-date coordinates instead of last
      // frame's. Cheap (one matrix multiply) and prevents a class of latent
      // staleness bugs whenever a group is moved AFTER the renderer's natural
      // traversal point. See debug session 2026-05-15 (SK center-of-rotation).
      this.group.updateMatrixWorld(true);
    }

    // Welcome field: spawn nearby debris on first frame with valid player orbit
    if (!this._welcomeFieldSpawned && playerPos && playerOrbit) {
      // Stash gameDt so _spawnWelcomeField can pre-compensate the one-frame
      // propagation that's about to happen below (otherwise debris ends up
      // ~n*gameDt rad ahead of the player and gets culled by the M1 filter).
      this._lastSpawnGameDt = gameDt;
      this._spawnWelcomeField(playerOrbit);
      this._welcomeFieldSpawned = true;
      // Mark mission-1 hide as not-yet-applied so the enforcement below runs
      // once to disable any catalog debris the welcome field did NOT touch
      // (the welcome field overwrites only ~7 debris; the other ~793 still
      // exist at random orbits and need to be culled for mission 1).
      this._mission1HideApplied = false;
      // 2026-05-17 fix: REMOVED `_autoDiscoverNearest()` call. It was the
      // source of the "only 1 target visible" bug — it used a *static*
      // startSma proxy and would sometimes pick a catalog debris that the
      // M1 enforcement (just below) immediately killed, leaving zero
      // discovered welcome debris. `_spawnWelcomeField` now marks all 7
      // welcome debris as `discovered=true` directly. Method retained for
      // potential non-M1 use; just not called from this hot path.
    }

    // ── Mission-1 cluster enforcement (runs AFTER welcome field is placed) ──
    // We must run this AFTER _spawnWelcomeField so the welcome-field marker
    // flags (`welcomeSpawn = true`) are already set on the 7 chosen debris.
    // Otherwise we would hide everything including the welcome-field
    // candidates and leave the pilot with zero targets.
    // Idempotent: flips `_mission1HideApplied` once done so the per-frame
    // cost is just one flag check.  Also handles save-restore paths where
    // _spawnWelcomeField is skipped because _welcomeFieldSpawned was true.
    if ((this._currentMissionNumber || 1) === 1
        && this._welcomeFieldSpawned
        && !this._mission1HideApplied) {
      let hidden = 0;
      for (const d of this.debrisList) {
        if (d.welcomeSpawn) continue;
        if (d._hiddenForMission1) continue;
        d._hiddenForMission1 = true;
        d.alive = false;
        d.tracked = false;
        const lookup = this._instanceLookup.get(d.id);
        if (lookup) {
          const mesh = this.instancedMeshes[lookup.meshKey];
          if (mesh) {
            this._tempMatrix.makeScale(0, 0, 0);
            mesh.setMatrixAt(lookup.instanceIndex, this._tempMatrix);
            mesh.instanceMatrix.needsUpdate = true;
          }
        }
        hidden++;
      }
      // 2026-05-15 polish (urgent): hide the 5000-point background cloud
      // on Mission 1. Without this, the THREE.Points particles at
      // 200–2000 km altitude render as faint coloured dots inside the
      // player's frustum that *look like* multi-km debris (the user
      // reported seeing "7 km debris" — those were background points,
      // not targetable). Background-points are scene dressing; on M1 we
      // want the pilot's view limited to the tight welcome cluster.
      // Restored when mission advances (MISSION_START handler above).
      if (this.backgroundPoints) {
        this.backgroundPoints.visible = false;
      }
      if (hidden > 0) {
        const welcomeCount = this.debrisList.filter(d => d.welcomeSpawn && d.alive).length;
        console.log(`[DebrisField] Mission 1: hid ${hidden} catalog debris + background-points cloud, kept ${welcomeCount} welcome-field targets (total=${this.debrisList.length})`);
      }
      this._mission1HideApplied = true;
    }

    // 2026-05-15 polish (urgent): per-frame hard distance cutoff on M1.
    // Belt-and-suspenders for any debris that escapes the initial hide
    // (e.g. catalog-loaded debris injected post-_welcomeFieldSpawned,
    // restored-from-save debris with stale alive flag, future regressions
    // that forget the _hiddenForMission1 marker). Any non-welcome alive
    // debris beyond 2 km from the player gets zeroed out this frame.
    if ((this._currentMissionNumber || 1) === 1 && playerPos) {
      const MAX_M1_DIST_M = 2000;
      const MAX_M1_DIST_SCENE = MAX_M1_DIST_M * 0.00001;  // metres → scene
      const MAX_M1_DIST_SQ = MAX_M1_DIST_SCENE * MAX_M1_DIST_SCENE;
      let culled = 0;
      for (const d of this.debrisList) {
        if (!d.alive) continue;
        if (d.welcomeSpawn) continue;       // welcome cluster is exempt
        if (!d._scenePosition) continue;    // not yet positioned
        const dx = d._scenePosition.x - playerPos.x;
        const dy = d._scenePosition.y - playerPos.y;
        const dz = d._scenePosition.z - playerPos.z;
        if (dx * dx + dy * dy + dz * dz > MAX_M1_DIST_SQ) {
          d._hiddenForMission1 = true;
          d.alive = false;
          d.tracked = false;
          const lookup = this._instanceLookup.get(d.id);
          if (lookup) {
            const mesh = this.instancedMeshes[lookup.meshKey];
            if (mesh) {
              this._tempMatrix.makeScale(0, 0, 0);
              mesh.setMatrixAt(lookup.instanceIndex, this._tempMatrix);
              mesh.instanceMatrix.needsUpdate = true;
            }
          }
          culled++;
        }
      }
    }

    // --- Update interactive debris ---
    const maxVisualRad = Constants.DEBRIS_MAX_VISUAL_TUMBLE_DEG_S * Math.PI / 180;

    // Mother local-frame basis for the onboarding tease pin (forward = prograde,
    // right = cross-track / horizontal). Computed once per frame; consumed by
    // _updateInstanceTransform to place pinned pieces (#1 dead-centre, #2 off to
    // one side). Cleared when no player orbit so the pin branch falls back safely.
    this._motherFwd = null;
    this._motherRight = null;
    if (playerPos && playerOrbit && this._onboardingPinIds.size > 0) {
      const pc = orbitToSceneCartesian(playerOrbit);
      const v = pc.velocity, p = playerPos;
      let fx = v.x, fy = v.y, fz = v.z;
      let fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
      let rx = p.x, ry = p.y, rz = p.z;                 // radial (away from Earth)
      let rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
      // right = forward × radial  (horizontal, perpendicular to both)
      let gx = fy * rz - fz * ry;
      let gy = fz * rx - fx * rz;
      let gz = fx * ry - fy * rx;
      const gl = Math.hypot(gx, gy, gz) || 1; gx /= gl; gy /= gl; gz /= gl;
      this._motherFwd = { x: fx, y: fy, z: fz };
      this._motherRight = { x: gx, y: gy, z: gz };
    }

    for (const debris of this.debrisList) {
      if (!debris.alive) continue;

      // Sprint D1: Apply web shot drag decay (dragMultiplier > 1 = webbed debris)
      if (debris.dragMultiplier && debris.dragMultiplier > 1.0) {
        const decayRate = Constants.WEB_SHOT_DECAY_RATE * debris.dragMultiplier;
        debris.orbit.semiMajorAxis -= decayRate * gameDt;

        // Check if debris has de-orbited (altitude < burn-up threshold)
        const altKm = (debris.orbit.semiMajorAxis / Constants.SCENE_SCALE) - Constants.EARTH_RADIUS_KM;
        if (altKm < Constants.WEB_SHOT_DEORBIT_ALT_KM) {
          // Debris burns up — remove and award points
          debris.alive = false;
          const lookup = this._instanceLookup.get(debris.id);
          if (lookup) {
            this._tempMatrix.makeScale(0, 0, 0);
            const mesh = this.instancedMeshes[lookup.meshKey];
            if (mesh) {
              mesh.setMatrixAt(lookup.instanceIndex, this._tempMatrix);
              mesh.instanceMatrix.needsUpdate = true;
            }
          }
          eventBus.emit(Events.SCORING_AWARD, {
            type: 'webShotDeorbit',
            points: Constants.WEB_SHOT_DEORBIT_SCORE,
            debrisId: debris.id,
          });
          eventBus.emit(Events.DEBRIS_REMOVED, {
            id: debris.id, type: debris.type, sizeMeter: debris.sizeMeter, cause: 'webShotDeorbit',
          });
          eventBus.emit(Events.COMMS_MESSAGE, {
            sender: 'DEBRIS',
            text: `🔥 Debris ${debris.id} burned up. Web-assisted de-orbit complete`,
            priority: 'success',
          });
          continue; // skip further processing for this debris
        }
      }

      // Propagate orbit (re-use pre-allocated temp instead of spread)
      const o = debris.orbit;
      if (debris._onboardingPinned) {
        // ── Onboarding tease pin ────────────────────────────────────────────
        // Skip propagation: this piece is held at a fixed offset in the mother's
        // LOCAL frame (forward + lateral), written to _scenePosition in
        // _updateInstanceTransform below using the per-frame mother basis. That
        // (not the orbit) is the single source of truth all consumers read, so
        // the piece is stable, selectable, dead-ahead/off-to-the-side, and never
        // drifts. The orbit is left as a co-orbital fallback only.
      } else {
        _tmpKmOrbit.semiMajorAxis = o.semiMajorAxis / Constants.SCENE_SCALE;
        _tmpKmOrbit.eccentricity = o.eccentricity;
        _tmpKmOrbit.inclination = o.inclination;
        _tmpKmOrbit.raan = o.raan;
        _tmpKmOrbit.argPerigee = o.argPerigee;
        _tmpKmOrbit.trueAnomaly = o.trueAnomaly;
        _tmpKmOrbit.meanMotion = o.meanMotion;
        propagateOrbit(_tmpKmOrbit, gameDt);
        o.trueAnomaly = _tmpKmOrbit.trueAnomaly;
        o.meanMotion = _tmpKmOrbit.meanMotion;

        // Atmospheric drag — matches PlayerSatellite so co-orbiting objects
        // stay on the same trajectory (prevents mother/debris drift that hid
        // debris from the ARM_PILOT camera via LOD culling).
        const debrisAltKm = _tmpKmOrbit.semiMajorAxis - Constants.EARTH_RADIUS_KM;
        if (debrisAltKm < 600) {
          const debrisVel = orbitalVelocity(
            _tmpKmOrbit.semiMajorAxis, _tmpKmOrbit.semiMajorAxis, Constants.MU_EARTH
          );
          // Cross-section ≈ sizeMeter², mass from debris spec (floor 1 kg)
          const debrisArea = debris.sizeMeter * debris.sizeMeter;
          const debrisMass = Math.max(debris.mass || 1, 1);
          const dragDecel = atmosphericDrag(debrisAltKm, debrisVel, debrisArea, debrisMass);
          const dvDrag = dragDecel * gameDt;
          if (debrisVel > 0) {
            o.semiMajorAxis *= (1 - 2 * dvDrag / debrisVel);
          }
        }
      }

      // Update tumble (frozen while the debris is captured — see _advanceTumble).
      DebrisField._advanceTumble(debris, dt, maxVisualRad);

      // Update instance transform
      const lookup = this._instanceLookup.get(debris.id);
      if (lookup) {
        this._updateInstanceTransform(debris, lookup.instanceIndex, playerPos);

        // ST-6.2: MOID badge colour tinting (approximated via instanceColor)
        // Track badge changes to avoid per-frame work for unbadged debris
        const currentBadge = debris.moidBadge || null;
        const renderedBadge = debris._renderedMoidBadge || null;
        if (currentBadge !== renderedBadge) {
          debris._renderedMoidBadge = currentBadge;
          const mesh = this.instancedMeshes[lookup.meshKey];
          if (mesh) {
            if (currentBadge) {
              const emissive = getEmissiveForMOID(currentBadge);
              if (emissive.intensity > 0) {
                this._moidTmpColor.set(getInstanceTintBase(debris.catalogType || 'unknown'));
                applyInstanceColorVariation(this._moidTmpColor, debris.id, debris.catalogType);
                this._moidTmpEmissive.set(emissive.color);
                this._moidTmpColor.lerp(this._moidTmpEmissive, emissive.intensity);
                mesh.setColorAt(lookup.instanceIndex, this._moidTmpColor);
              }
            } else {
              // Badge cleared — revert to weathering-tint base (with per-instance variation)
              this._moidTmpColor.set(getInstanceTintBase(debris.catalogType || 'unknown'));
              applyInstanceColorVariation(this._moidTmpColor, debris.id, debris.catalogType);
              mesh.setColorAt(lookup.instanceIndex, this._moidTmpColor);
            }
          }
        }

        // ST-6.2: Update flag overlay transform — mount the decal ON the hull
        // surface (NASA/ESA style), facing outward and tumbling with the piece.
        const flagInfo = this._flagLookup.get(debris.id);
        if (flagInfo && debris._scenePosition && debris._lodScale > 0) {
          const flagMesh = this.flagMeshes[flagInfo.country];
          if (flagMesh) {
            const sp = debris._scenePosition;
            const dir = debris._flagDir || this._flagPlaneNormal;

            // Tumble quaternion (same rotation the debris mesh uses)
            this._flagQuat.setFromAxisAngle(debris.tumbleAxis, debris.tumbleAngle);

            // Rotate the local mount direction into world space → the outward
            // surface normal where the decal sits.
            this._flagDirWorld.copy(dir).applyQuaternion(this._flagQuat);

            // Distance to the hull surface along the (LOCAL) mount direction.
            // Using the bounding-box face distance (not the bounding-sphere
            // radius) keeps the decal flush against the body even for shapes
            // dominated by far-reaching parts like solar wings. _lodScale maps
            // local units → world; 1.01 sits the decal just proud to avoid
            // z-fighting.
            const localD = DebrisWireframe.getSurfaceDistance(
              debris.type, debris.id, dir.x, dir.y, dir.z
            ) || 1;
            const surfaceR = debris._lodScale * localD * 1.01;

            // Centre of the debris instance, in floating-origin space
            const baseX = Constants.FLOATING_ORIGIN_ENABLED ? sp.x - this._floatingOrigin.x : sp.x;
            const baseY = Constants.FLOATING_ORIGIN_ENABLED ? sp.y - this._floatingOrigin.y : sp.y;
            const baseZ = Constants.FLOATING_ORIGIN_ENABLED ? sp.z - this._floatingOrigin.z : sp.z;
            this._flagPos.set(
              baseX + this._flagDirWorld.x * surfaceR,
              baseY + this._flagDirWorld.y * surfaceR,
              baseZ + this._flagDirWorld.z * surfaceR
            );

            // Orient the plane so its +Z (front) normal points outward along dir.
            // Matrix4.lookAt makes -Z face the target, so target = -dir → +Z = dir.
            const up = Math.abs(this._flagDirWorld.y) > 0.95 ? this._flagAltUp : this._flagUp;
            this._flagPos2.copy(this._flagDirWorld).multiplyScalar(-1);
            this._flagMatrix.lookAt(this._zeroVec, this._flagPos2, up);
            this._flagQuat.setFromRotationMatrix(this._flagMatrix);

            // Reveal scale matches the debris mesh.
            const flagRp = debris._revealProgress;
            const flagReveal = (flagRp !== undefined && flagRp < 1)
              ? flagRp * flagRp * (3 - 2 * flagRp) : 1;
            // Item 12 (2026-06-12): decal sized in PHYSICAL metres —
            // clamp(sizeMeter × FACTOR, MIN..MAX) — instead of a fixed
            // 0.7-local-unit footprint (read tiny on an 8 m rocket body).
            // The LOD shrink ratio is preserved so distant flags fade with
            // their debris.
            const dv = Constants.DEBRIS_VISUAL || {};
            const widthM = Math.min(dv.FLAG_DECAL_MAX_M ?? 1.6,
              Math.max(dv.FLAG_DECAL_MIN_M ?? 0.4,
                (debris.sizeMeter || 1) * (dv.FLAG_SIZE_FACTOR ?? 0.12)));
            const lodRatio = debris.sceneSize > 0 ? debris._lodScale / debris.sceneSize : 1;
            // Plane geometry is 0.7 local units wide → scale to widthM metres
            // (1 m = 0.00001 scene units).
            this._flagScale.setScalar((widthM * 0.00001 / 0.7) * lodRatio * flagReveal);
            this._flagMatrix.compose(this._flagPos, this._flagQuat, this._flagScale);
            flagMesh.setMatrixAt(flagInfo.instanceIndex, this._flagMatrix);
          }
        }
      }
    }

    // Mark instanced meshes for update (matrix + colour)
    for (const mesh of Object.values(this.instancedMeshes)) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    // ST-6.2: Mark flag overlay meshes for update
    for (const mesh of Object.values(this.flagMeshes)) {
      mesh.instanceMatrix.needsUpdate = true;
    }

    // --- Update background debris (propagate in batches for performance) ---
    this._updateBackground(gameDt, playerPos);
  }

  /**
   * Authoritative catch pin (called by ArmManager AFTER arms move, and after
   * this.update() ran earlier in the frame). Forces a captured debris — both
   * the object reference the arm/net/camera hold AND the CANONICAL field object
   * looked up by id — and its rendered instance onto the arm's scene position.
   *
   * This is the definitive fix for the reel-in "net + debris drift ~600 m away
   * and vanish" bug: the object the arm pinned was not the same object this
   * field rendered, so position flags never reached the rendered instance.
   * Pinning by id (the canonical key used by _instanceLookup / removeDebris)
   * can't suffer that mismatch.
   *
   * @param {object} debrisRef - the arm's captured debris object (net/camera ref)
   * @param {THREE.Vector3} armScenePos - arm position in scene units
   * @param {number} [scaleMul=1] - multiplier on rendered size (dock stow-shrink)
   */
  pinCapturedDebris(debrisRef, armScenePos, scaleMul = 1) {
    if (!debrisRef || !armScenePos) return;
    const id = debrisRef.id;

    // 1) Update the ref the arm/net/camera hold so those consumers track the arm.
    if (!debrisRef._scenePosition) debrisRef._scenePosition = new THREE.Vector3();
    debrisRef._scenePosition.copy(armScenePos);
    debrisRef._armPinPos = debrisRef._armPinPos ? debrisRef._armPinPos.copy(armScenePos) : armScenePos.clone();
    debrisRef._armPinned = true;

    // 2) Update the CANONICAL field object by id (may be a different reference)
    //    so the orbit-driven renderer doesn't fight us next frame.
    const canonical = (id != null && this.debrisMap.get(id)) || debrisRef;
    if (canonical !== debrisRef) {
      if (!canonical._scenePosition) canonical._scenePosition = new THREE.Vector3();
      canonical._scenePosition.copy(armScenePos);
      canonical._armPinPos = canonical._armPinPos ? canonical._armPinPos.copy(armScenePos) : armScenePos.clone();
      canonical._armPinned = true;
    }

    // 3) Force the rendered instance (by id slot) to the arm position THIS frame,
    //    overriding whatever this.update() computed earlier (orbit branch).
    if (id == null) return;
    const lookup = this._instanceLookup.get(id);
    if (!lookup) return;
    const mesh = this.instancedMeshes[lookup.meshKey];
    if (!mesh) return;
    if (Constants.FLOATING_ORIGIN_ENABLED && this._floatingOrigin) {
      this._tempPos.set(
        armScenePos.x - this._floatingOrigin.x,
        armScenePos.y - this._floatingOrigin.y,
        armScenePos.z - this._floatingOrigin.z
      );
    } else {
      this._tempPos.set(armScenePos.x, armScenePos.y, armScenePos.z);
    }
    if (canonical.tumbleAxis) {
      this._tempQuat.setFromAxisAngle(canonical.tumbleAxis, canonical.tumbleAngle || 0);
    } else {
      this._tempQuat.identity();
    }
    const baseSize = canonical.sceneSize || (canonical.sizeMeter ? canonical.sizeMeter * 0.00001 : 0.00001);
    this._tempScale.setScalar(baseSize * (scaleMul > 0 ? scaleMul : 1));
    this._tempMatrix.compose(this._tempPos, this._tempQuat, this._tempScale);
    mesh.setMatrixAt(lookup.instanceIndex, this._tempMatrix);
    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Update the instance matrix for a single debris piece.
   * @private
   */
  _updateInstanceTransform(debris, instanceIndex, playerPos) {
    // POLISH FIX (issue #2: "daughter abandoned debris"): once an arm has
    // captured this debris AND moved past the GRAPPLED stabilization (i.e., it
    // is reeling/hauling/docking back to the mother), the debris visual must
    // FOLLOW the arm rather than continue along its independent orbit.
    // During GRAPPLED itself we let the orbit-driven path run so the rigid
    // arm+debris pair continues to co-orbit naturally (arm.position.copy(tPos)
    // in _updateGrappled keeps the arm shadowed onto the debris).
    let px, py, pz;
    // AUTHORITATIVE arm pin (set by ArmUnit while it owns the catch during
    // REELING/DOCKING and for a tether-snapped drift). This is a direct
    // position copy with NO state/ref checks, so it can't be defeated by the
    // SK/welcome-debris edge cases that left the older `_capturedByArm` pin
    // reading the orbit branch — the catch was drifting 600 m+ away mid-haul.
    const _armPinned = !!(debris._armPinned && debris._armPinPos);
    const _captor = debris._capturedByArm;
    const _captorState = _captor && _captor.state;
    const _pinToArm = !_armPinned && _captor && _captor.position &&
      _captorState && _captorState !== 'GRAPPLED' && _captorState !== 'NETTING';
    // Onboarding tease pin (local frame): place the piece at a fixed
    // forward + lateral offset from the mother so it reads dead-centre (#1) or
    // off-to-one-side (#2) and is selectable/in-range. This _scenePosition is
    // authoritative (TargetSelector/AutoLock/Lasso/reticle all read it). An arm
    // capture (ARM_CAPTURED) releases the pin first, so _armPinned wins after.
    const _onboardPinned = !!(debris._onboardingPinned && playerPos &&
      this._motherFwd && this._motherRight);
    if (_onboardPinned) {
      const f = this._motherFwd, r = this._motherRight;
      const fwd = debris._onboardingPinFwd || 0;
      const lat = debris._onboardingPinLat || 0;
      px = playerPos.x + f.x * fwd + r.x * lat;
      py = playerPos.y + f.y * fwd + r.y * lat;
      pz = playerPos.z + f.z * fwd + r.z * lat;
    } else if (_armPinned) {
      px = debris._armPinPos.x;
      py = debris._armPinPos.y;
      pz = debris._armPinPos.z;
    } else if (_pinToArm) {
      px = _captor.position.x;
      py = _captor.position.y;
      pz = _captor.position.z;
    } else {
      // Sprint 2 / PR A — scratch-output variant; no per-debris allocation.
      orbitToSceneCartesianInto(debris.orbit, this._tmpCartPos, this._tmpCartVel);
      px = this._tmpCartPos.x;
      py = this._tmpCartPos.y;
      pz = this._tmpCartPos.z;
    }

    // Store scene position for arm autopilot and external queries
    if (!debris._scenePosition) {
      debris._scenePosition = new THREE.Vector3(px, py, pz);
    } else {
      debris._scenePosition.set(px, py, pz);
    }

    // LOD: determine scale based on distance to player
    // ST-6.2: stored on debris for flag overlay LOD
    let scale = debris.sceneSize;
    if (playerPos) {
      // Skip LOD downscaling for debris that an arm is actively station-keeping on,
      // OR that an arm has captured (pinned to the arm during REELING/HAULING/
      // DOCKING).  LOD uses playerPos (mother ship), but the ARM_PILOT camera is
      // near the debris.  When the mother orbits far away the LOD would zero
      // the scale.  For SK targets this hid the inspection debris.  For
      // captured debris (Item 3 fix, 2026-05-28) it hid the "package" being
      // reeled in — the user saw only the daughter, with the debris
      // invisible inside the net during the entire reel-in.
      if (!debris._isStationKeepTarget && !debris._capturedByArm && !debris._armPinned) {
        const dx = px - playerPos.x;
        const dy = py - playerPos.y;
        const dz = pz - playerPos.z;
        const distSq = dx * dx + dy * dy + dz * dz;

        // LOD thresholds (in scene units, squared)
        const near = 0.0005;    // ~50m  → 0.05² = 0.0025... let's use 0.05
        const mid = 0.005;      // ~500m
        const far = 0.05;       // ~5km
        const vfar = 0.5;       // ~50km

        if (distSq > vfar * vfar) {
          // Very far: make invisible (scale to 0)
          scale = 0;
        } else if (distSq > far * far) {
          // Far: simplified (smaller)
          scale *= 0.5;
        }
        // Near / mid: full detail
      }
    }

    // Net-held catch readability: a lasso-held catch sets `_catchRenderMin`
    // (scene units). A physically tiny catch (e.g. a 0.6 m M1 fragment) renders
    // sub-pixel and "disappears" inside the net / at the nose; clamp its apparent
    // size up to that floor while held so it reads as a real catch. Opt-in per
    // debris AND gated on _armPinned (actively held) so a stale override can
    // never inflate a released piece, and the Daughter pipeline (which never sets
    // it) is unaffected.
    if (_armPinned && debris._catchRenderMin && scale < debris._catchRenderMin) {
      scale = debris._catchRenderMin;
    }

    // ST-6.2: Store LOD scale for flag overlay sync
    debris._lodScale = scale;

    // Perf: skip compose + setMatrixAt when debris is still invisible (scale 0)
    // from last frame — the instance buffer already holds a zero-scale matrix.
    const wasZero = debris._wasZeroScale;
    debris._wasZeroScale = (scale === 0);
    if (scale === 0 && wasZero) return;

    // Build transform matrix
    // UX-4: Instance positions relative to floating origin (eliminates float32 jitter)
    if (Constants.FLOATING_ORIGIN_ENABLED) {
      this._tempPos.set(
        px - this._floatingOrigin.x,
        py - this._floatingOrigin.y,
        pz - this._floatingOrigin.z
      );
    } else {
      this._tempPos.set(px, py, pz);
    }
    this._tempQuat.setFromAxisAngle(debris.tumbleAxis, debris.tumbleAngle);

    // Smooth reveal: scale up from 0→1 over 300ms using smoothstep
    const rp = debris._revealProgress;
    const revealScale = (rp !== undefined && rp < 1)
      ? rp * rp * (3 - 2 * rp) // smoothstep easing
      : 1;
    this._tempScale.setScalar(scale * revealScale);
    this._tempMatrix.compose(this._tempPos, this._tempQuat, this._tempScale);

    // Apply to instanced mesh
    const mesh = this.instancedMeshes[debris._meshKey];
    if (mesh) {
      mesh.setMatrixAt(instanceIndex, this._tempMatrix);
    }
  }

  /** @private Update background points positions (batch propagation) */
  _updateBackground(gameDt, playerPos) {
    if (!this.backgroundPoints) return;
    const posAttr = this.backgroundPoints.geometry.attributes.position;

    // Propagate every 4th particle each frame for performance (rotate batch)
    const batchSize = Math.ceil(BACKGROUND_COUNT / 4);
    const batchIndex = (this._bgBatch || 0);
    this._bgBatch = (batchIndex + 1) % 4;

    const start = batchIndex * batchSize;
    const end = Math.min(start + batchSize, BACKGROUND_COUNT);

    // Sprint 2 / PR A — mutate the pre-allocated `_tmpBgOrbit` scratch instead
    // of `{...orbit, semiMajorAxis: …}` spread (one alloc per batched debris).
    const bg = this._tmpBgOrbit;
    for (let i = start; i < end; i++) {
      const orbit = this._backgroundOrbits[i];

      // Propagate (4× dt since we only update 1/4 per frame)
      bg.semiMajorAxis = orbit.semiMajorAxis / Constants.SCENE_SCALE;
      bg.eccentricity = orbit.eccentricity;
      bg.inclination = orbit.inclination;
      bg.raan = orbit.raan;
      bg.argPerigee = orbit.argPerigee;
      bg.trueAnomaly = orbit.trueAnomaly;
      propagateOrbit(bg, gameDt * 4);
      orbit.trueAnomaly = bg.trueAnomaly;

      orbitToSceneCartesianInto(orbit, this._tmpCartPos, this._tmpCartVel);
      // UX-4: Background positions relative to floating origin
      if (Constants.FLOATING_ORIGIN_ENABLED && this._floatingOrigin) {
        posAttr.setXYZ(i,
          this._tmpCartPos.x - this._floatingOrigin.x,
          this._tmpCartPos.y - this._floatingOrigin.y,
          this._tmpCartPos.z - this._floatingOrigin.z
        );
      } else {
        posAttr.setXYZ(i, this._tmpCartPos.x, this._tmpCartPos.y, this._tmpCartPos.z);
      }
    }

    posAttr.needsUpdate = true;
  }

  // ==========================================================================
  // WEB SHOT HIT — Apply drag multiplier from GSL web shot (Sprint D1)
  // ==========================================================================

  /**
   * Handle WEB_SHOT_HIT event — set dragMultiplier on the targeted debris.
   * @private
   * @param {{ debrisId: number, dragMultiplier: number }} data
   */
  _onWebShotHit({ debrisId, dragMultiplier }) {
    const debris = this.debrisMap.get(debrisId);
    if (!debris || !debris.alive) return;

    // Apply drag multiplier (default is 1.0; web shot sets to 5.0)
    debris.dragMultiplier = dragMultiplier || Constants.WEB_SHOT_DRAG_MULT;

    // Visual: tint webbed debris (applied once, not per-frame)
    const lookup = this._instanceLookup.get(debrisId);
    if (lookup) {
      const mesh = this.instancedMeshes[lookup.meshKey];
      if (mesh && mesh.instanceColor) {
        mesh.setColorAt(lookup.instanceIndex, this._webTintColor);
        mesh.instanceColor.needsUpdate = true;
      }
    }

    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'DEBRIS',
      text: `Debris ${debrisId}: drag ×${debris.dragMultiplier}. Passive de-orbit initiated`,
      priority: 'info',
    });
  }

  // ==========================================================================
  // EDT ATTRACT — Electrodynamic Tether debris attraction (Phase 6)
  // ==========================================================================

  /**
   * Handle EDT_ATTRACT event — nudge small debris toward the attract point.
   * Applies gentle orbital perturbations (trueAnomaly + semiMajorAxis) so
   * debris drifts toward the player without teleporting.
   * @private
   * @param {object} data
   * @param {THREE.Vector3|{x:number,y:number,z:number}} data.position — attract centre (scene coords)
   * @param {number} data.radius — attract radius in km (Constants.EDT.ATTRACTION_RADIUS_KM)
   * @param {number} data.force  — base force in km/s² (Constants.EDT.ATTRACTION_FORCE)
   * @param {number} data.maxMass — max debris mass affected (Constants.EDT.MAX_ATTRACT_MASS)
   */
  _onEdtAttract({ position, radius, force, maxMass }) {
    if (!position) return;

    // Convert radius from km → scene units
    const radiusScene = (radius || Constants.EDT.ATTRACTION_RADIUS_KM) * Constants.SCENE_SCALE;
    const radiusSq = radiusScene * radiusScene;

    // Force magnitude in scene-unit acceleration
    const baseForce = (force || Constants.EDT.ATTRACTION_FORCE) * Constants.SCENE_SCALE;
    const massLimit = maxMass || Constants.EDT.MAX_ATTRACT_MASS;

    for (const debris of this.debrisList) {
      if (!debris.alive || debris.mass > massLimit) continue;

      const dPos = debris._scenePosition;
      if (!dPos) continue;

      // Vector from debris → attract point
      const dx = position.x - dPos.x;
      const dy = position.y - dPos.y;
      const dz = position.z - dPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq >= radiusSq || distSq < 1e-12) continue;

      const dist = Math.sqrt(distSq);

      // Strength: inversely proportional to distance (linear fall-off to zero at boundary)
      const strength = baseForce * (1.0 - dist / radiusScene);

      // Orbital velocity direction from current elements
      const cart = orbitToSceneCartesian(debris.orbit);
      const vx = cart.velocity.x;
      const vy = cart.velocity.y;
      const vz = cart.velocity.z;
      const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (vLen < 1e-10) continue;

      // Tangential component: project attract direction onto velocity direction
      const tangDot = (dx * vx + dy * vy + dz * vz) / (dist * vLen);

      // Nudge trueAnomaly — advances/retards debris along its orbit toward attract point
      debris.orbit.trueAnomaly += strength * tangDot / debris.orbit.semiMajorAxis;

      // Radial component: gently drift semiMajorAxis toward attract-point altitude
      const debrisR = Math.sqrt(dPos.x * dPos.x + dPos.y * dPos.y + dPos.z * dPos.z);
      const attractR = Math.sqrt(
        position.x * position.x + position.y * position.y + position.z * position.z
      );
      debris.orbit.semiMajorAxis += (attractR - debrisR) * strength * 0.1;
    }
  }


  /**
   * Release onboarding tease pins, handing the curated piece(s) back to normal
   * co-orbital propagation. Idempotent. Because each orbit was kept synced to
   * playerOrbit + offset every frame, release is seamless (no snap).
   * @param {number|string} [id] - release just this piece; omit to release all.
   * @private
   */
  _clearOnboardingPin(id = null) {
    const unpin = (pid) => {
      const d = this.debrisMap.get(pid);
      if (d) { d._onboardingPinned = false; d._onboardingPinFwd = 0; d._onboardingPinLat = 0; }
    };
    if (id != null) {
      unpin(id);
      this._onboardingPinIds.delete(id);
      return;
    }
    for (const pid of this._onboardingPinIds) unpin(pid);
    this._onboardingPinIds.clear();
  }

  /**
   * Spawn welcome field debris near the player for immediate first-game engagement.
   * Repositions far-away debris to nearby co-orbital positions.
   * ST-4.C: Now respects current mission profile for cluster count, hydrazine,
   * and untracked debris.
   * @param {object} playerOrbit - Player orbital elements
   * @private
   */
  _spawnWelcomeField(playerOrbit) {
    // ST-4.C: Determine mission profile
    const profile = this._currentMissionProfile || Constants.MISSIONS.PROFILES[0];

    // Bugfix: WELCOME_FIELD is the player's *local* learning cluster — a fixed
    // set of 7 hand-crafted specs that teach scanning/targeting/approach/capture.
    // It always spawns in full. `profile.clusters` controls how many *broader*
    // orbital cluster regions populate globally (handled elsewhere), NOT the
    // local welcome group. Slicing this by profile.clusters was a regression
    // introduced in ST-4.C that reduced M1 to a single debris item.
    const fieldToSpawn = WELCOME_FIELD;

    // Collect candidates: alive debris not already special-tagged. Prefer debris
    // in different orbit bands (farThreshold ≈ 3km altitude diff) so we don't
    // disrupt coincidentally-nearby objects. The welcome spawn reuses a debris'
    // existing instanced-mesh slot (it does NOT rebind geometry), so the RENDERED
    // shape AND material/colour come from WHICH candidate is selected
    // (_meshKey = type:material[:id%N]). That's why selection drives appearance:
    //   - APPEARANCE BY SELECTION: a row wanting gold MLI foil (#2) or a blue
    //     solar-cell panel shard (#3/#5) must match a candidate already in that
    //     material slot + flat plate variant (spec.appearMaterial/appearPlate).
    //   - SHAPE BY SELECTION: row #7 (cubesat) must match a `cubesat`-type
    //     candidate so it renders as a small whole microsat, not a junk chunk.
    // See the bucketing + scoring just below.
    const farThreshold = 0.03; // ~3km in scene units
    const N = Constants.DEBRIS_FRAGMENT_VARIANTS || 7;
    // Far-band candidate buckets by visual class. `fragment` = irregular junk
    // chunk (the dominant cluster look). `cubesat` = small whole microsat box
    // (row #7's graduation catch). `farOther` (defunctSat/rocketBody/…) read as
    // intact high-value bodies — wrong for a junk cluster, so they're only a
    // last-resort fallback. Near-band debris is the final fallback.
    //
    // Phase-2 fix: NO early-break. We scan the whole alive list once (≤800,
    // one-time at spawn — negligible) so gold-MLI / blue-solar-cell plate
    // fragments and cubesats that sit LATER in debrisList are still reachable.
    // The old `farFragments.length >= 7` break grabbed the first 7 far fragments
    // (≈12% chance of containing a gold plate), starving the matcher and making
    // #2/#3/#5 fall back to generic grey chunks.
    const farFragments = [];
    const farCubesats = [];
    const farOther = [];
    const fallbackCandidates = [];

    for (const debris of this.debrisList) {
      if (!debris.alive) continue;
      if (debris.tutorialSpawn || debris.welcomeSpawn) continue;
      const altDiff = Math.abs(debris.orbit.semiMajorAxis - playerOrbit.semiMajorAxis);
      if (altDiff > farThreshold) {
        if (debris.type === 'fragment') farFragments.push(debris);
        else if (debris.type === 'cubesat') farCubesats.push(debris);
        else farOther.push(debris);
      } else {
        fallbackCandidates.push(debris);
      }
    }

    // Per-row candidate assignment. The welcome spawn reuses a candidate's
    // existing instanced-mesh slot (it can't rebind), so the RENDERED shape +
    // material/colour come from WHICH candidate we pick. Score the still-unused
    // far candidates per spec:
    //   +4  type match (spec's desired type — shape is the dominant visual, so
    //       it outranks material; keeps fragment rows off cubesats and #7 off
    //       fragments whenever a cubesat exists)
    //   +2  material match (spec.appearMaterial → rendered colour)
    //   +1  plate-variant match (spec.appearPlate → flat panel-shard look)
    // Best score wins; ties keep placed-order (stable). We scan fragments +
    // cubesats together so a desired-type match can win across buckets, then
    // fall back to any far fragment → far cubesat → far other → near so the row
    // still spawns (spawn must never under-fill).
    const usedIds = new Set();
    const fragVariant = (d) => (typeof d.id === 'number' ? (d.id >>> 0) % N : 0);
    const isPlate = (d) => DebrisWireframe.isPlateVariant(fragVariant(d));
    // The desired type for a spec is the first entry of spec.types (fragment for
    // #1–#6, cubesat for #7).
    const desiredType = (spec) => (Array.isArray(spec.types) && spec.types.length ? spec.types[0] : null);
    const scorePool = [...farFragments, ...farCubesats];
    const pickFar = (spec) => {
      const wantType = desiredType(spec);
      let best = null;
      let bestScore = -1;
      for (const d of scorePool) {
        if (usedIds.has(d.id)) continue;
        let score = 0;
        if (wantType && d.type === wantType) score += 4;
        if (spec.appearMaterial && d.material === spec.appearMaterial) score += 2;
        // Plate test only meaningful for fragment variants.
        if (typeof spec.appearPlate === 'boolean' && d.type === 'fragment' &&
            isPlate(d) === spec.appearPlate) score += 1;
        if (score > bestScore) { bestScore = score; best = d; }
      }
      return best;
    };
    const pickAny = (pool) => {
      for (const d of pool) {
        if (!usedIds.has(d.id)) return d;
      }
      return null;
    };

    // assigned[i] = the debris that will realise spec i (null ⇒ no candidate).
    const assigned = new Array(fieldToSpawn.length).fill(null);
    for (let i = 0; i < fieldToSpawn.length; i++) {
      const spec = fieldToSpawn[i];
      // pickFar already scans the combined fragment+cubesat scorePool and returns
      // any unused candidate (score ≥ 0), so it only returns null when that pool
      // is exhausted/empty — fall straight through to far-other then near.
      let chosen = pickFar(spec) || pickAny(farOther) || pickAny(fallbackCandidates);
      if (!chosen) break; // ran out of candidates entirely
      usedIds.add(chosen.id);
      assigned[i] = chosen;
    }

    let placed = 0;
    let untrackedCount = 0;  // ST-4.C: track how many debris set as untracked

    for (let i = 0; i < fieldToSpawn.length && placed < fieldToSpawn.length; i++) {
      const spec = fieldToSpawn[i];
      const debris = assigned[i];
      if (!debris) break;

      // Co-orbital elements (shared with the mother). Forward placement differs
      // by piece: PINNED pieces (#1, #2) are positioned in the mother's LOCAL
      // frame each frame (see the pin branch in update()/_updateInstanceTransform)
      // — their orbit is only a sane fallback. The rest use a trueAnomaly offset.
      const isPin = !!spec.pin;
      // Guided pieces sit AHEAD (prograde, in AutoLock's forward arc). Spread
      // pieces (#4+) alternate ahead/behind for variety.
      const sign = (i < 3) ? 1 : ((i % 2 === 0) ? 1 : -1);

      debris.orbit.semiMajorAxis = playerOrbit.semiMajorAxis;
      debris.orbit.eccentricity = playerOrbit.eccentricity;
      debris.orbit.inclination = playerOrbit.inclination;
      debris.orbit.raan = playerOrbit.raan;
      debris.orbit.argPerigee = playerOrbit.argPerigee;
      debris.orbit.meanMotion = playerOrbit.meanMotion;

      if (isPin) {
        // Fallback orbit ≈ fwdM ahead (used only if the local-frame pin is ever
        // unavailable / after an uncaught release). No frame-comp needed — the
        // authoritative position is the local-frame _scenePosition pin.
        const aScene = playerOrbit.semiMajorAxis || 1;
        const fwdNu = ((spec.fwdM || 0) * METRE_SCENE) / aScene; // arc → Δtrue-anomaly
        debris.orbit.trueAnomaly = playerOrbit.trueAnomaly + fwdNu;
      } else {
        const offset = sign * (spec.offsetMin + Math.random() * (spec.offsetMax - spec.offsetMin));
        // 2026-05-17 off-by-one-frame fix: the debris is spawned mid-frame after
        // player.update propagated the player by n×gameDt, and the loop below will
        // advance this debris once more this frame. Pre-subtract one step so the
        // post-propagation trueAnomaly lands at playerOrbit + offset.
        const _nApprox = playerOrbit.meanMotion ||
          Math.sqrt(Constants.MU_EARTH / Math.pow(playerOrbit.semiMajorAxis / Constants.SCENE_SCALE, 3));
        const _frameComp = _nApprox * (this._lastSpawnGameDt || 0);
        debris.orbit.trueAnomaly = playerOrbit.trueAnomaly + offset - _frameComp;
      }

      // Adjust mass to spec
      debris.mass = spec.massMin + Math.random() * (spec.massMax - spec.massMin);

      // Mission-1 onboarding is NET-ONLY: every guided beat captures with the
      // Mother net (tease_lock→N, second_catch→N, range_wall→A-then-net,
      // free_clear→"net the rest of the cluster"); there is no Daughter beat.
      // The Mother net rejects anything over LASSO_MAX_CAPTURE_MASS, so clamp
      // the whole welcome cluster to that ceiling — otherwise the curated first
      // target (and most of the cluster) trips "Target too massive for Mother
      // net. Try deploying a Daughter [D]", contradicting the onboarding script.
      const netCeil = Constants.LASSO_MAX_CAPTURE_MASS;
      if (Number.isFinite(netCeil) && debris.mass > netCeil) {
        debris.mass = netCeil;
      }

      // Update type if needed
      if (!spec.types.includes(debris.type)) {
        debris.type = spec.types[Math.floor(Math.random() * spec.types.length)];
      }

      // Update sizeMeter/sceneSize to match new type+mass
      const typeDef = DEBRIS_TYPES[debris.type];
      if (typeDef) {
        const massFrac = Math.max(0, Math.min(1,
          (debris.mass - typeDef.massMin) / (typeDef.massMax - typeDef.massMin || 1)));
        debris.sizeMeter = typeDef.sizeMin + massFrac * (typeDef.sizeMax - typeDef.sizeMin);
        debris.sceneSize = debris.sizeMeter * 0.00001;
      }

      // Reward-first spine: deterministic visible size for curated welcome
      // pieces. `sizeM` is a DELIBERATE override (a 0.1–1 m fragment is a ~10 px
      // speck), so it intentionally bypasses the per-type sizeMax cap — a 3 m
      // fragment renders as a clearly-visible irregular junk chunk.
      if (Number.isFinite(spec.sizeM)) {
        debris.sizeMeter = spec.sizeM;
        debris.sceneSize = debris.sizeMeter * 0.00001;
      }
      // Keep salvage/flags consistent with the intended appearance. The
      // RENDERED colour comes from the candidate's existing mesh slot (selected
      // above to match appearMaterial); `debris.material` only feeds salvage and
      // capture flags. Honour spec.material, else the appearance hint.
      if (spec.material) {
        debris.material = spec.material;
      } else if (spec.appearMaterial) {
        debris.material = spec.appearMaterial;
      }

      // Reset web-shot drag if previously webbed
      if (debris.dragMultiplier) {
        debris.dragMultiplier = undefined;
      }

      // Regenerate salvage for updated type/mass
      debris.salvage = this._generateSalvage(debris.type, debris.mass, debris.material);

      // ST-4.C: Suppress hydrazine based on mission profile
      if (!profile.hydrazine) {
        debris.salvage.hydrazine = 0;
      }

      // Reward-first spine: the tease piece is a deliberately LOW-VALUE quick
      // win (a glinting but cheap solar panel). Strip the premium materials and
      // thin the metals so the first catch pays a little, leaving the richer
      // pieces for later — this is what `spec.lowValue` means.
      if (spec.lowValue && debris.salvage) {
        debris.salvage.gaAs = 0;
        debris.salvage.indium = 0;
        debris.salvage.xenon = 0;
        debris.salvage.lithium = 0;
        debris.salvage.battery = 0;
        if (Array.isArray(debris.salvage.metals)) {
          for (const m of debris.salvage.metals) m.amount *= 0.3;
        }
      }

      debris.hasSalvage = debris.salvage.xenon > 0 || debris.salvage.indium > 0 ||
        debris.salvage.gaAs > 0 || debris.salvage.battery > 0 || debris.salvage.hydrazine > 0 ||
        debris.salvage.lithium > 0 ||
        (debris.salvage.metals && debris.salvage.metals.length > 0);
      debris.metalMassKg = (debris.salvage.metals || [])
        .reduce((sum, m) => sum + m.amount, 0);

      // Mark as welcome spawn, ensure visible
      debris.welcomeSpawn = true;
      debris.alive = true;
      // Which curated WELCOME_FIELD spec row realised this piece (0-based).
      // Score-based candidate matching means debrisList order != spec order, so
      // this lets consumers/tests recover the intended progression position.
      debris._welcomeSpecIndex = i;

      // Flag safety guard. Welcome pieces are reused from far candidates that
      // may have been flag-eligible (≥2 m sat/rocket) at build time — and the
      // per-frame flag path only REPOSITIONS, never re-checks eligibility — so a
      // reused piece would keep a stale flag. The cluster sizes already drop
      // below the 2 m flag threshold, but strip any existing flag explicitly:
      // zero its instance, drop the lookup, and clear the country so no welcome
      // piece ever wears a flag (a sub-2 m flag would be an invisible smear).
      // Tolerant of mock receivers (tests) that lack the flag/instance state.
      const _flagInfo = this._flagLookup && this._flagLookup.get(debris.id);
      if (_flagInfo) {
        const _flagMesh = this.flagMeshes && this.flagMeshes[_flagInfo.country];
        if (_flagMesh && this._tempMatrix) {
          this._tempMatrix.makeScale(0, 0, 0);
          _flagMesh.setMatrixAt(_flagInfo.instanceIndex, this._tempMatrix);
          _flagMesh.instanceMatrix.needsUpdate = true;
        }
        this._flagLookup.delete(debris.id);
      }
      debris.country = null;

      // 2026-06-21: pre-discover the TWO PINNED guided net-catch pieces
      // (#1 dead-centre ~22 m, #2 off-side ~48 m — spec indices 0 and 1). Both
      // are guaranteed, in-range, guided catches, so having #2 a visible mesh +
      // reticle bracket yet absent from the list was confusing. The other 5
      // (#3–#7) stay `discovered=false` until the user presses S to scan —
      // which reveals them via SensorSystem._revealNearbyDebris() →
      // getDebrisNear() (M1-clamped to 2 km, welcomeSpawn-gated). With two
      // pre-discovered, a single quick scan (MAX_REVEALS=5) reveals exactly
      // #3–#7. This matches the intended new-user UX: start with two obvious
      // targets visible, learn to scan to find more.
      // Replaces the old buggy `_autoDiscoverNearest()` which used a static
      // startSma proxy and would sometimes pick a catalog debris that got
      // killed by the M1 enforcement, leaving zero discovered debris.
      if (i <= 1) {
        debris.discovered = true;
        eventBus.emit(Events.TARGET_DISCOVERED, { target: debris });
      } else {
        debris.discovered = false;
      }

      // Onboarding tease pin: hold the curated STATION-catch pieces (those with
      // spec.pin — #1 dead-centre, #2 off to one side) at a fixed offset in the
      // MOTHER'S LOCAL FRAME (forward + lateral) until each is caught. Enforced
      // per-frame in update()/_updateInstanceTransform by writing _scenePosition
      // (the single source of truth that selection, range, net, reticle, and
      // rendering all read — TargetSelector prefers it). Local-frame is the only
      // way to hold a STABLE sideways offset: co-orbital cross-track oscillates
      // to zero. #3 (range wall) is NOT pinned — it's the free orbit the mother
      // autopilots to. Released per-id on capture / removal / complete / reset.
      if (isPin) {
        debris._onboardingPinned = true;
        debris._onboardingPinFwd = (spec.fwdM || 0) * METRE_SCENE;
        debris._onboardingPinLat = (spec.latM || 0) * METRE_SCENE;
        this._onboardingPinIds.add(debris.id);

        // Per-instance brightness boost (lever 3, m1-debris-1-2-visibility):
        // brighten ONLY the pinned welcome pieces (#1/#2) via the existing
        // instanceColor channel so they read clearly even on the shadow side.
        // Isolated to these instances — no shared-material/emissive change.
        // Tolerant of mock receivers (tests) lacking instanced meshes.
        const _boostLookup = this._instanceLookup && this._instanceLookup.get(debris.id);
        if (_boostLookup) {
          const _boostMesh = this.instancedMeshes && this.instancedMeshes[_boostLookup.meshKey];
          if (_boostMesh && _boostMesh.instanceColor) {
            _boostMesh.setColorAt(_boostLookup.instanceIndex, this._welcomeBoostColor);
            _boostMesh.instanceColor.needsUpdate = true;
          }
        }
      }

      // ST-4.C: Track/untrack based on profile (untracked count from far end)
      const maxUntracked = profile.untracked ?? 0;
      if (maxUntracked > 0 && untrackedCount < maxUntracked && i >= fieldToSpawn.length - maxUntracked) {
        debris.tracked = false;
        untrackedCount++;
      } else {
        debris.tracked = true;
      }

      placed++;
    }

    if (placed > 0) {
      console.log(`[DebrisField] Welcome field: repositioned ${placed} debris near player (mission ${this._currentMissionNumber}, profile: ${profile.label})`);
    }

    // ── Mission 1 only: hide all non-welcome interactive debris so the
    // pilot sees a tight ≤1.5 km cluster instead of catalog debris that
    // happens to drift through their orbit at multi-km range.  This is the
    // "all debris within 2 km on first mission" UX request (debug session
    // 2026-05-15).  Hidden debris are marked _hiddenForMission1=true so
    // _onMissionStart() can restore them when the mission counter advances.
    if ((this._currentMissionNumber || 1) === 1) {
      let hiddenCount = 0;
      for (const d of this.debrisList) {
        if (!d.alive) continue;
        if (d.welcomeSpawn) continue;
        d._hiddenForMission1 = true;
        d.alive = false;
        d.tracked = false;
        // Zero the instance scale immediately so it disappears this frame
        const lookup = this._instanceLookup.get(d.id);
        if (lookup) {
          const mesh = this.instancedMeshes[lookup.meshKey];
          if (mesh) {
            this._tempMatrix.makeScale(0, 0, 0);
            mesh.setMatrixAt(lookup.instanceIndex, this._tempMatrix);
            mesh.instanceMatrix.needsUpdate = true;
          }
        }
        hiddenCount++;
      }
      console.log(`[DebrisField] Mission 1: hid ${hiddenCount} non-welcome debris so cluster stays compact`);
    }
  }

  /**
   * Public welcome-field API — Delegation 2 (2026-05-31).
   *
   * Returns a deterministic *plan* (pure data, Node-safe) describing the 7–8
   * fragment cluster the OnboardingDirector wants spawned in the player's
   * own orbit at 150–1500 m offsets, then (if a live debrisList is present)
   * mutates the field to realise that plan by delegating to the existing
   * private spawner.  Each spawned debris is additionally tagged with
   * `welcomeField:true` so callers can disambiguate from `welcomeSpawn`
   * (which is M1-only and applies the harsher M1-only hide logic).
   *
   * @param {object} playerOrbit — orbital element snapshot (a, e, i, RAAN, argP, trueAnomaly, meanMotion)
   * @param {object} [options]
   * @param {number} [options.count=7]      — number of fragments (7 or 8)
   * @param {number} [options.minOffsetM=150]  — closest fragment distance (metres)
   * @param {number} [options.maxOffsetM=1500] — farthest fragment distance (metres)
   * @param {number} [options.minMassKg=5]
   * @param {number} [options.maxMassKg=50]
   * @returns {{ playerOrbit: object, fragments: Array<{ massKg:number, offsetM:number, ahead:boolean, welcomeField:boolean, type:string }> }}
   */
  spawnWelcomeField(playerOrbit, options = {}) {
    const count = Math.max(7, Math.min(8, options.count ?? 7));
    const minOffsetM = options.minOffsetM ?? 150;
    const maxOffsetM = options.maxOffsetM ?? 1500;
    const minMassKg = options.minMassKg ?? 5;
    const maxMassKg = options.maxMassKg ?? 50;

    // Distribute fragments evenly across the offset range; alternate ahead/behind.
    const fragments = [];
    for (let i = 0; i < count; i++) {
      const frac = count === 1 ? 0.5 : (i / (count - 1));
      const offsetM = minOffsetM + frac * (maxOffsetM - minOffsetM);
      const massKg = minMassKg + Math.random() * (maxMassKg - minMassKg);
      fragments.push({
        massKg,
        offsetM,
        ahead: (i % 2 === 0),
        welcomeField: true,
        type: 'fragment',
      });
    }

    // If a live debris list is available, also stage the existing spawn path
    // so the actual game state is updated.  Tag matching debris with
    // welcomeField:true post-hoc.
    if (Array.isArray(this.debrisList) && this.debrisList.length > 0 && playerOrbit) {
      try {
        if (!this._welcomeFieldSpawned) {
          this._spawnWelcomeField(playerOrbit);
          this._welcomeFieldSpawned = true;
        }
        for (const d of this.debrisList) {
          if (d.welcomeSpawn) d.welcomeField = true;
        }
      } catch (e) {
        console.warn('[DebrisField] spawnWelcomeField apply failed:', e?.message);
      }
    }

    return { playerOrbit, fragments };
  }

  /**
   * CH5 ISS conjunction boss (MISSION_ARC §6) — spawn `count` threat fragments
   * in the ISS forward track, tagged `iss_threat:true`.
   * @param {object} [options] @param {number} [options.count]
   * @returns {{ ids: number[] }}
   */
  spawnIssThreatField(options = {}) {
    const cfg = Constants.ISS_BOSS;
    if (!cfg || !cfg.ORBIT) return { ids: [] };
    const count = Math.max(1, options.count ?? cfg.FRAG_COUNT ?? 6);
    return this._spawnThreatField(cfg.ORBIT, count, 'iss_threat');
  }

  /**
   * CH9 Starlink fragmentation boss (MISSION_ARC §6) — burst-spawn `count`
   * fragments in the Starlink shell, tagged `starlink_threat:true`.
   * @param {object} [options] @param {number} [options.count]
   * @returns {{ ids: number[] }}
   */
  spawnStarlinkField(options = {}) {
    const cfg = Constants.STARLINK_BOSS;
    if (!cfg || !cfg.ORBIT) return { ids: [] };
    const count = Math.max(1, options.count ?? cfg.FRAG_COUNT ?? 35);
    return this._spawnThreatField(cfg.ORBIT, count, 'starlink_threat');
  }

  /**
   * Shared boss-frag spawner. Repurposes existing alive, non-special, NOT-mid-
   * capture debris into the given orbit `cfg` (mirrors `_spawnWelcomeField`):
   * overwrites orbital elements, spreads them ahead in true-anomaly, refreshes
   * mass/type/salvage, tags `debris[tag]=true`, and marks them tracked +
   * discovered. Returns the spawned ids (fewer than `count` if candidates run out).
   *
   * @private
   * @param {object} cfg — orbit config (altKm, incDeg, raanDeg, argPerigeeDeg, eccentricity, fragMassKg, trackSpreadDeg)
   * @param {number} count
   * @param {string} tag — per-debris flag identifying the threat set
   * @returns {{ ids: number[] }}
   */
  _spawnThreatField(cfg, count, tag) {
    // Orbit in scene units.
    const altKm = cfg.altKm ?? 408;
    const sma = Constants.EARTH_RADIUS + altKm * Constants.SCENE_SCALE;
    const meanMotion = Math.sqrt(Constants.MU_EARTH / Math.pow(sma / Constants.SCENE_SCALE, 3));
    const baseNu = Math.random() * Math.PI * 2;          // random phase around the track
    const spreadRad = (cfg.trackSpreadDeg ?? 8) * Math.PI / 180;
    const frameComp = meanMotion * (this._lastSpawnGameDt || 0); // mid-frame propagation pre-compensation

    // Candidates: alive, not already special-tagged, and NOT mid-capture.
    // Unlike the welcome field (mission-1 init, nothing grappled), this runs on
    // SHOP_DEPLOY into a later mission, when a daughter may be hauling or parking
    // a catch (_capturedByArm/_armPinned keep that debris pinned to the arm) — so
    // repurposing it would teleport an in-flight catch onto the threat track.
    const candidates = [];
    for (const debris of this.debrisList) {
      if (!debris.alive) continue;
      if (debris.tutorialSpawn || debris.welcomeSpawn || debris.iss_threat || debris.starlink_threat) continue;
      if (debris._capturedByArm || debris._armPinned || debris._captured) continue;
      candidates.push(debris);
      if (candidates.length >= count) break;
    }

    const ids = [];
    for (let i = 0; i < count && i < candidates.length; i++) {
      const debris = candidates[i];

      // Place ahead in track (forward conjunction): evenly spread leads.
      const lead = ((i + 1) / count) * spreadRad;
      debris.orbit.semiMajorAxis = sma;
      debris.orbit.eccentricity = cfg.eccentricity ?? 0.0003;
      debris.orbit.inclination = (cfg.incDeg ?? 51.6) * Math.PI / 180;
      debris.orbit.raan = (cfg.raanDeg ?? 123.4) * Math.PI / 180;
      debris.orbit.argPerigee = (cfg.argPerigeeDeg ?? 45) * Math.PI / 180;
      debris.orbit.trueAnomaly = baseNu + lead - frameComp;
      debris.orbit.meanMotion = meanMotion;

      // Fragment profile.
      debris.mass = cfg.fragMassKg ?? 45;
      debris.type = 'fragment';
      const typeDef = DEBRIS_TYPES[debris.type];
      if (typeDef) {
        const massFrac = Math.max(0, Math.min(1,
          (debris.mass - typeDef.massMin) / (typeDef.massMax - typeDef.massMin || 1)));
        debris.sizeMeter = typeDef.sizeMin + massFrac * (typeDef.sizeMax - typeDef.sizeMin);
        debris.sceneSize = debris.sizeMeter * 0.00001;
      }
      if (debris.dragMultiplier) debris.dragMultiplier = undefined;

      debris.salvage = this._generateSalvage(debris.type, debris.mass, debris.material);
      debris.hasSalvage = debris.salvage.xenon > 0 || debris.salvage.indium > 0 ||
        debris.salvage.gaAs > 0 || debris.salvage.battery > 0 || debris.salvage.hydrazine > 0 ||
        debris.salvage.lithium > 0 ||
        (debris.salvage.metals && debris.salvage.metals.length > 0);
      debris.metalMassKg = (debris.salvage.metals || []).reduce((sum, m) => sum + m.amount, 0);

      debris[tag] = true;
      debris.alive = true;
      debris.tracked = true;
      debris.discovered = true;

      ids.push(debris.id);
      eventBus.emit(Events.TARGET_DISCOVERED, { target: debris });
    }

    if (ids.length > 0) {
      console.log(`[DebrisField] boss spawn: ${ids.length} ${tag} frags at ${altKm} km / ${cfg.incDeg ?? 51.6}°`);
    }
    return { ids };
  }

  // ==========================================================================
  // QUERIES
  // ==========================================================================

  /**
   * Get debris objects within a radius of a position (scene units).
   * @param {THREE.Vector3} position
   * @param {number} radius - Scene units
   * @returns {Array<object>}
   */
  getDebrisNear(position, radius) {
    // 2026-05-15 polish (urgent, 2nd pass): on Mission 1, hard-clamp the
    // effective radius to 2 km and require welcomeSpawn — same rationale as
    // getEnhancedTargetList.  Without this, TargetReticle and NavSphere
    // render brackets / dots for drifted welcome debris at multi-km range,
    // contradicting the "tight ≤ 2 km cluster" M1 UX contract.
    // Gameplay systems (lasso, arm capture, sensor scan) use tiny radii
    // (50–200 m) that are always inside the welcome cluster, so the clamp
    // has zero impact on them.
    const isMission1 = (this._currentMissionNumber || 1) === 1;
    const effectiveRadius = isMission1
      ? Math.min(radius, 2.0 * Constants.SCENE_SCALE) // 2 km
      : radius;

    // --- Frame-level cache: if same frame + same/smaller radius, reuse ---
    if (this._frameId === this._cacheFrame &&
        effectiveRadius <= this._cacheRadius &&
        position.distanceToSquared(this._cachePos) < 1e-12) {
      return this._cachedNearby;
    }

    const rSq = effectiveRadius * effectiveRadius;
    const results = [];

    for (const debris of this.debrisList) {
      if (!debris.alive || debris._captured) continue;
      // M1: only welcome cluster debris can appear (same guard as getEnhancedTargetList)
      if (isMission1 && !debris.welcomeSpawn) continue;
      // Perf: reuse _scenePosition (populated this frame by _updateInstanceTransform);
      // fall back to orbitToSceneCartesian only if _scenePosition is missing (first frame).
      const sp = debris._scenePosition;
      let px, py, pz, cart;
      if (sp) {
        px = sp.x; py = sp.y; pz = sp.z;
        cart = null;
      } else {
        cart = orbitToSceneCartesian(debris.orbit);
        px = cart.position.x; py = cart.position.y; pz = cart.position.z;
      }
      const dx = px - position.x;
      const dy = py - position.y;
      const dz = pz - position.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < rSq) {
        const dist = Math.sqrt(distSq);
        results.push({
          ...debris,
          // HARDENING: the spread above would otherwise share the canonical's
          // mutable refs (_scenePosition Vector3, orbit object). Hand out
          // read-only SNAPSHOTS so a caller mutating a result can't corrupt the
          // real debris. To mutate/hold a debris, resolve it via getDebrisById(id).
          _scenePosition: debris._scenePosition ? debris._scenePosition.clone() : undefined,
          orbit: debris.orbit ? { ...debris.orbit } : undefined,
          distance: dist,
          distanceKm: dist / Constants.SCENE_SCALE,
          _cartesian: cart,
        });
      }
    }

    results.sort((a, b) => a.distance - b.distance);

    // Store in cache
    this._cachedNearby = results;
    this._cacheFrame = this._frameId;
    this._cachePos.copy(position);
    this._cacheRadius = effectiveRadius;

    return results;
  }

  /**
   * Set the current frame ID for spatial query caching.
   * Must be called once per frame from the game loop before any getDebrisNear calls.
   * @param {number} frameId
   */
  setFrameId(frameId) {
    this._frameId = frameId;
  }

  /**
   * Get small untracked debris within sensor range.
   * Returns objects under 10cm that are sensor-detectable.
   * @param {THREE.Vector3} position - Player position
   * @param {number} sensorRange - Sensor range in scene units (default: 0.1 = 10km)
   * @returns {Array<object>} Detected small objects with collision risk
   */
  getUntrackedDebrisNear(position, sensorRange = 0.1) {
    const rSq = sensorRange * sensorRange;
    const results = [];

    for (const debris of this.debrisList) {
      if (!debris.alive) continue;
      // Only sub-10cm untracked objects
      if (debris.tracked || debris.sizeMeter > 0.1) continue;

      const cart = orbitToSceneCartesian(debris.orbit);
      const dx = cart.position.x - position.x;
      const dy = cart.position.y - position.y;
      const dz = cart.position.z - position.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq < rSq) {
        const dist = Math.sqrt(distSq);
        const distKm = dist / Constants.SCENE_SCALE;

        // Calculate collision risk based on distance, relative velocity, and trajectory
        const collisionRisk = this._calculateCollisionRisk(debris, cart, position, distKm);

        results.push({
          id: debris.id,
          sizeMeter: debris.sizeMeter,
          sizeCm: Math.round(debris.sizeMeter * 100),
          distance: dist,
          distanceKm: distKm,
          collisionRisk,
          riskLevel: collisionRisk > 0.5 ? 'HIGH' : collisionRisk > 0.2 ? 'MED' : 'LOW',
        });
      }
    }

    return results.sort((a, b) => b.collisionRisk - a.collisionRisk);
  }

  /**
   * Calculate collision risk for a debris object relative to the player.
   * Based on distance, approach rate, and trajectory alignment.
   * @param {object} debris - Debris data object
   * @param {object} cart - Cartesian state { position, velocity }
   * @param {THREE.Vector3} playerPos - Player position
   * @param {number} distKm - Distance in km
   * @returns {number} Risk 0..1
   * @private
   */
  _calculateCollisionRisk(debris, cart, playerPos, distKm) {
    // Distance factor — closer = higher risk (exponential)
    const distFactor = Math.exp(-distKm / 2);

    // Approach vector — is it heading toward us?
    const dx = playerPos.x - cart.position.x;
    const dy = playerPos.y - cart.position.y;
    const dz = playerPos.z - cart.position.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-10) return 1.0;

    // Normalize direction to player
    const dirX = dx / len;
    const dirY = dy / len;
    const dirZ = dz / len;

    // Velocity dot direction to player (approach rate)
    const vLen = Math.sqrt(cart.velocity.x ** 2 + cart.velocity.y ** 2 + cart.velocity.z ** 2);
    if (vLen < 1e-10) return distFactor * 0.1;

    const dot = (cart.velocity.x * dirX + cart.velocity.y * dirY + cart.velocity.z * dirZ) / vLen;
    const approachFactor = Math.max(0, dot); // 0 = receding, 1 = direct approach

    // Size factor — larger objects easier to hit
    const sizeFactor = Math.min(1, debris.sizeMeter / 0.1);

    // Combined risk
    return Math.min(1.0, distFactor * 0.5 + approachFactor * 0.35 + sizeFactor * 0.15);
  }

  /**
   * Get sorted list of reachable targets with delta-v estimates.
   * @param {object} playerOrbit - Player's orbital elements (scene units)
   * @returns {Array<{ id, type, deltaV, distance, altKm }>}
   */
  getTargetList(playerOrbit) {
    const targets = [];

    for (const debris of this.debrisList) {
      if (!debris.alive) continue;

      // Use pre-allocated orbit temps instead of spread
      _tmpKmOrbit.semiMajorAxis = playerOrbit.semiMajorAxis / Constants.SCENE_SCALE;
      _tmpKmOrbit.eccentricity = playerOrbit.eccentricity;
      _tmpKmOrbit.inclination = playerOrbit.inclination;
      _tmpKmOrbit.raan = playerOrbit.raan;
      _tmpKmOrbit.argPerigee = playerOrbit.argPerigee;
      _tmpKmOrbit.trueAnomaly = playerOrbit.trueAnomaly;
      _tmpKmOrbit.meanMotion = playerOrbit.meanMotion;

      _tmpKmOrbit2.semiMajorAxis = debris.orbit.semiMajorAxis / Constants.SCENE_SCALE;
      _tmpKmOrbit2.eccentricity = debris.orbit.eccentricity;
      _tmpKmOrbit2.inclination = debris.orbit.inclination;
      _tmpKmOrbit2.raan = debris.orbit.raan;
      _tmpKmOrbit2.argPerigee = debris.orbit.argPerigee;
      _tmpKmOrbit2.trueAnomaly = debris.orbit.trueAnomaly;
      _tmpKmOrbit2.meanMotion = debris.orbit.meanMotion;

      const dv = totalDeltaV(_tmpKmOrbit, _tmpKmOrbit2);

      const altKm = (debris.orbit.semiMajorAxis / Constants.SCENE_SCALE) - Constants.EARTH_RADIUS_KM;

      targets.push({
        id: debris.id,
        type: debris.type,
        sizeMeter: debris.sizeMeter,
        mass: debris.mass,
        tumbleRate: debris.tumbleRate,
        deltaV: dv,
        altKm,
        tracked: debris.tracked,
      });
    }

    // Sort by delta-v (closest/cheapest first)
    return targets.sort((a, b) => a.deltaV - b.deltaV);
  }

  /**
   * Get enhanced target list suitable for the HUD with risk ratings and point estimates.
   * @param {THREE.Vector3} playerPos - Player position
   * @param {object} playerOrbit - Player orbital elements (scene units)
   * @returns {Array<object>}
   */
  getEnhancedTargetList(playerPos, playerOrbit) {
    const results = [];
    // 2026-05-15 polish (urgent, 2nd pass): on Mission 1, hard-clamp the
    // search radius to 2 km AND require `welcomeSpawn` flag.  Without this,
    // catalog-loaded debris that escaped the instance-lookup pool (and thus
    // never had `_scenePosition` set, so the per-frame 2 km cull at
    // line ~995 never marked them dead) leak into the HUD's TRACKED TARGETS
    // panel at multi-km range — exactly the symptom the user reported
    // ("debris at 7 km on M1").  This filter is the single source of truth
    // for the HUD list, so it's the right defence-in-depth layer.
    const isMission1 = (this._currentMissionNumber || 1) === 1;
    const searchRadius = isMission1
      ? 2.0 * Constants.SCENE_SCALE      // M1: 2 km
      : 10.0;                             // 1000 km in scene units (default)
    const rSq = searchRadius * searchRadius;

    // 2026-05-17 fix (TRACKED TARGETS empty bug, RCS-offset edition):
    // On M1, the welcome cluster is placed by *orbital elements* relative
    // to playerOrbit. But PlayerSatellite.position can be offset from its
    // orbital position by `_rcsVelocity * dt` integrated over many frames
    // (PlayerSatellite.js:1572). Diagnostic showed welcome debris correctly
    // placed 30 m – 1.2 km from `orbitToSceneCartesian(playerOrbit)`, but
    // `player.getPosition()` was ~7.7 km offset due to accumulated RCS
    // impulses from launch / collision-avoidance dodges. Using the orbital
    // reference position for the M1 distance check is the right
    // apples-to-apples comparison: it's the frame the welcome cluster
    // lives in. Non-M1 missions stay on rendered playerPos.
    const refPos = isMission1
      ? orbitToSceneCartesian(playerOrbit).position
      : playerPos;

    for (const debris of this.debrisList) {
      if (!debris.alive || debris._captured) continue;
      // UX-3 #9: Only return discovered debris (scanned or auto-discovered)
      if (!debris.discovered) continue;
      // M1 hard contract: ONLY the welcome cluster appears in the HUD list.
      // Any non-welcome debris is invisible to the pilot on the first mission.
      if (isMission1 && !debris.welcomeSpawn) continue;

      // Prefer the live rendered _scenePosition (the single source of truth all
      // consumers read, and the same basis getDebrisNear uses) measured against
      // the rendered playerPos. Onboarding-PINNED pieces have their orbit
      // propagation frozen (see _updateInstanceTransform pin branch), so the
      // orbital comparison below drifts them out of the M1 2 km window within
      // ~0.3 s and silently drops #1/#2 from the HUD list / T-Tab / scan reveal.
      // Comparing scene-vs-rendered is self-consistent and cancels the RCS
      // offset too. Pieces without a scene position (e.g. catalog debris that
      // never entered the instance pool) fall back to the orbital comparison.
      let dx, dy, dz;
      const sp = debris._scenePosition;
      if (sp && playerPos) {
        dx = sp.x - playerPos.x;
        dy = sp.y - playerPos.y;
        dz = sp.z - playerPos.z;
      } else {
        const cart = orbitToSceneCartesian(debris.orbit);
        dx = cart.position.x - refPos.x;
        dy = cart.position.y - refPos.y;
        dz = cart.position.z - refPos.z;
      }
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq < rSq) {
        const dist = Math.sqrt(distSq);
        const distKm = dist / Constants.SCENE_SCALE;
        const altKm = (debris.orbit.semiMajorAxis / Constants.SCENE_SCALE) - Constants.EARTH_RADIUS_KM;

        // Delta-V estimate (re-use pre-allocated orbit temps)
        _tmpKmOrbit.semiMajorAxis = playerOrbit.semiMajorAxis / Constants.SCENE_SCALE;
        _tmpKmOrbit.eccentricity = playerOrbit.eccentricity;
        _tmpKmOrbit.inclination = playerOrbit.inclination;
        _tmpKmOrbit.raan = playerOrbit.raan;
        _tmpKmOrbit.argPerigee = playerOrbit.argPerigee;
        _tmpKmOrbit.trueAnomaly = playerOrbit.trueAnomaly;
        _tmpKmOrbit.meanMotion = playerOrbit.meanMotion;

        _tmpKmOrbit2.semiMajorAxis = debris.orbit.semiMajorAxis / Constants.SCENE_SCALE;
        _tmpKmOrbit2.eccentricity = debris.orbit.eccentricity;
        _tmpKmOrbit2.inclination = debris.orbit.inclination;
        _tmpKmOrbit2.raan = debris.orbit.raan;
        _tmpKmOrbit2.argPerigee = debris.orbit.argPerigee;
        _tmpKmOrbit2.trueAnomaly = debris.orbit.trueAnomaly;
        _tmpKmOrbit2.meanMotion = debris.orbit.meanMotion;

        const dv = totalDeltaV(_tmpKmOrbit, _tmpKmOrbit2);

        // Risk level based on tumble + size
        const tumbleDeg = debris.tumbleRate * 180 / Math.PI;
        let risk = 'Low';
        let riskStars = 1;
        if (tumbleDeg > 60 || (debris.type === 'rocketBody' && debris.mass > 3000)) {
          risk = 'High';
          riskStars = 4;
        } else if (tumbleDeg > 20 || debris.mass > 500) {
          risk = 'Med';
          riskStars = 2;
        }
        if (debris.type === 'rocketBody' && debris.mass > 4000) {
          riskStars = 5;
          risk = 'Extreme';
        }

        // Point estimate (simplified scoring)
        let basePoints;
        if (debris.type === 'rocketBody' && debris.mass > 4000) basePoints = 2000;
        else if (debris.type === 'rocketBody') basePoints = 500;
        else if (debris.type === 'defunctSat') basePoints = debris.mass > 500 ? 500 : 300;
        else if (debris.type === 'missionDebris') basePoints = debris.mass > 5 ? 200 : 100;
        else basePoints = 100;

        // Size/tumble multiplier
        const sizeMult = 1.0 + Math.log10(Math.max(debris.mass, 1)) / 4;
        const tumbleMult = 1.0 + tumbleDeg / 90.0;
        const estimatedPoints = Math.floor(basePoints * sizeMult * tumbleMult);

        // FIX_PLAN §4: Compute Target Priority Index (TPI) — composite ranking score
        // Lower TPI = higher priority. Factors normalized to 0..1 then weighted.
        const TR = Constants.TARGET_RANKING;
        const distScore = Math.min(distKm / TR.DIST_REF_KM, 1.0);
        const dvScore = Math.min(dv / TR.DV_REF_MS, 1.0);
        const threatMap = TR.MOID_THREAT_MAP;
        // Use bracket lookup; null key requires `threatMap[null]` (string 'null' key in JS objects)
        const badgeKey = debris.moidBadge != null ? debris.moidBadge : null;
        const threatScore = threatMap[badgeKey] !== undefined ? threatMap[badgeKey] : 1.0;
        const valueScore = 1.0 - Math.min(estimatedPoints / TR.VALUE_REF_PTS, 1.0);
        const tpi = TR.W_DIST * distScore + TR.W_DV * dvScore + TR.W_THREAT * threatScore + TR.W_VALUE * valueScore;

        results.push({
          id: debris.id,
          type: debris.type,
          sizeMeter: debris.sizeMeter,
          mass: debris.mass,
          tumbleRate: debris.tumbleRate,
          material: debris.material,
          tracked: debris.tracked,
          distance: dist,
          distanceKm: distKm,
          altKm: Math.round(altKm),
          incDeg: Math.round(debris.orbit.inclination * 180 / Math.PI),
          deltaV: dv,
          selectedDeltaV: debris.selectedDeltaV,
          risk,
          riskStars,
          estimatedPoints,
          hasSalvage: debris.hasSalvage || false,
          salvage: debris.salvage || null,
          metalMassKg: debris.metalMassKg || 0,
          // FIX_PLAN §4: MOID propagation + composite priority index
          moidBadge: debris.moidBadge || null,
          moid_m: debris.moid_m || null,
          tpi,  // Target Priority Index — lower = higher priority
        });
      }
    }

    // Mission 1 is a guided cluster authored near→far == catch order == reward
    // ramp (#1→#7 climb in both distance and value), so for a new player we sort
    // purely by distance: the list reads top-to-bottom in catch/reward order and
    // Tab cycles nearest-first. Later missions keep the composite Target Priority
    // Index (distance + ΔV + threat + value, lower = higher priority). The per-
    // result `tpi` is still computed on M1 (cheap, harmless) so the result shape
    // other consumers rely on is unchanged.
    return results.sort((a, b) =>
      isMission1 ? (a.distance - b.distance) : (a.tpi - b.tpi));
  }

  /**
   * Remove a debris object (captured/deorbited).
   * @param {number} id
   * @returns {boolean}
   */
  removeDebris(id) {
    const debris = this.debrisMap.get(id);
    if (!debris || !debris.alive) return false;

    // Capture the cluster bucket BEFORE marking dead so we can check whether
    // this removal emptied the bucket (defer-trawl: anchors CLUSTER_CLEARED on
    // active captures/deorbits instead of trawl sweeps).
    const clusterId = this._clusterIdOf(debris);

    debris.alive = false;

    // Set instance scale to 0 (hide)
    const lookup = this._instanceLookup.get(id);
    if (lookup) {
      this._tempMatrix.makeScale(0, 0, 0);
      const mesh = this.instancedMeshes[lookup.meshKey];
      if (mesh) {
        mesh.setMatrixAt(lookup.instanceIndex, this._tempMatrix);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }

    eventBus.emit(Events.DEBRIS_REMOVED, { id, type: debris.type, sizeMeter: debris.sizeMeter });

    // CLUSTER_CLEARED: if this piece was the last alive member of its bucket,
    // fire the cluster-cleared ceremony. Guard against double-emit when several
    // removal paths (CATCH_PROCESSED, ARM_DEORBIT, lasso) race the last member.
    if (clusterId) {
      this._maybeEmitClusterCleared(clusterId);
    }

    return true;
  }

  /**
   * Resolve the (altitude band × inclination cluster) bucket id for a debris
   * object — the single classification entry point shared by getDebrisClusters,
   * getFieldIdNear, and the CLUSTER_CLEARED accounting (so all three stay in
   * lockstep). Transparently memoized on the orbital determinants (sma + inc):
   * the result is identical to a live recompute, but stable debris (the vast
   * majority on any given frame) skip the arithmetic + two linear searches, so
   * the per-removal membership scan in _maybeEmitClusterCleared stays cheap.
   * The cache auto-invalidates whenever sma/inc change (drift, deorbit, EDT
   * attract, station-keep snap, fragment respawn).
   * @private
   * @param {object} debris
   * @returns {string|null} cluster id, or null if out of tracked bands
   */
  _clusterIdOf(debris) {
    if (!debris || !debris.orbit) return null;
    const sma = debris.orbit.semiMajorAxis;
    const inc = debris.orbit.inclination;
    if (debris._clusterId !== undefined
        && debris._clusterIdSma === sma
        && debris._clusterIdInc === inc) {
      return debris._clusterId;
    }
    const altKm = (sma - Constants.EARTH_RADIUS) / Constants.SCENE_SCALE;
    const incDeg = inc * 180 / Math.PI;
    debris._clusterId = classifyClusterId(altKm, incDeg);
    debris._clusterIdSma = sma;
    debris._clusterIdInc = inc;
    return debris._clusterId;
  }

  /**
   * Emit CLUSTER_CLEARED once for a bucket whose last alive member was just
   * removed. Always called immediately AFTER a live member was marked dead, so
   * the bucket was non-empty an instant ago. The alive-count check below is the
   * sole de-dup mechanism: a bucket reaches `aliveInBucket === 0` exactly once
   * per emptying (removeDebris early-returns on already-dead ids), and a later
   * Kessler re-population that re-empties the same band naturally re-fires.
   * @private
   * @param {string} clusterId
   */
  _maybeEmitClusterCleared(clusterId) {
    // Count alive members + total in a single pass. Per-item cost is a cached
    // id lookup + string compare (see _clusterIdOf memoization).
    let aliveInBucket = 0;
    let totalInBucket = 0;
    for (const d of this.debrisList) {
      if (this._clusterIdOf(d) !== clusterId) continue;
      totalInBucket++;
      if (d.alive) aliveInBucket++;
    }

    if (aliveInBucket > 0) return; // bucket not empty yet

    // Build a readable name from the id (`${incName}-${altMin}`).
    const dash = clusterId.lastIndexOf('-');
    const incName = dash >= 0 ? clusterId.slice(0, dash) : clusterId;
    const altMin = dash >= 0 ? clusterId.slice(dash + 1) : '';
    const incMeta = INC_NAMES.find(i => i.name === incName);
    const altBand = ALT_BANDS.find(a => String(a.min) === altMin);
    const name = (incMeta && altBand)
      ? `${incMeta.label}, ${altBand.min}-${altBand.max} km`
      : clusterId;

    eventBus.emit(Events.CLUSTER_CLEARED, { clusterId, name, count: totalInBucket });
    console.log(`[DebrisField] Cluster cleared: ${clusterId} (${totalInBucket} debris)`);
  }

  /**
   * Phase 3b (capture-feedback overhaul): apply a tool-induced fragmentation
   * to the field. Crack sheds a few small fragments and the body survives;
   * breakup/shatter replaces the body with its fragments. KesslerSystem counts
   * the same event independently.
   * @param {{debrisId:*, fragments?:number, severity?:string, destroyTarget?:boolean, mass?:number}} data
   * @private
   */
  _onInteractionFragmentation(data) {
    if (!data) return;
    const debris = this.debrisMap.get(data.debrisId);
    if (!debris || debris.alive === false) return;
    const pos = debris._scenePosition;
    if (!pos) return;
    const count = Math.max(1, data.fragments || 1);
    const FS = Constants.FRAG_SEVERITY || {};
    if (data.destroyTarget) {
      // Breakup / shatter: fragments carry the body's mass; original removed.
      this.createFragments({ x: pos.x, y: pos.y, z: pos.z }, debris.mass || data.mass || 1, count);
      this.removeDebris(debris.id);
    } else {
      // Crack: shed a small mass fraction; the catch target survives.
      const shedMass = Math.max(0.1, (debris.mass || 1) * (FS.CRACK_MASS_FRACTION ?? 0.05));
      this.createFragments({ x: pos.x, y: pos.y, z: pos.z }, shedMass, count);
    }
  }

  /**
   * Create new fragments at a position (Kessler cascade event).
   * @param {{ x: number, y: number, z: number }} position - Scene units
   * @param {number} mass - Source mass (kg)
   * @param {number} count - Number of fragments to create
   * @returns {Array<number>} IDs of new fragments
   */
  createFragments(position, mass, count) {
    // Limit fragment creation to prevent runaway
    const actualCount = Math.min(count, Constants.KESSLER_FRAGMENT_LIMIT);
    const ids = [];

    for (let i = 0; i < actualCount; i++) {
      const debris = this._createDebrisData();
      // Override to fragment type at current position's approximate orbit
      debris.type = 'fragment';
      debris.shape = 'icosahedron';
      debris._meshKey = null; // No instanced mesh slot for Kessler fragments
      debris.tracked = Math.random() < TRACKING_PROB.fragment;
      debris.sizeMeter = randRange(0.01, 0.5);
      debris.sceneSize = debris.sizeMeter * 0.00001;
      debris.mass = mass / actualCount;
      debris.tumbleRate = randRange(30, 180) * Math.PI / 180;

      // Place near the collision point — approximate orbit from position
      const r = Math.sqrt(position.x ** 2 + position.y ** 2 + position.z ** 2);
      debris.orbit.semiMajorAxis = r + (Math.random() - 0.5) * 0.001;

      this.debrisMap.set(debris.id, debris);
      this.debrisList.push(debris);
      ids.push(debris.id);
    }

    // Note: new fragments won't have instanced mesh slots yet
    // For a full implementation, we'd need to rebuild or grow the instanced meshes
    // For now, emit event for tracking
    eventBus.emit(Events.DEBRIS_KESSLER, { count: actualCount, position });

    return ids;
  }

  /**
   * Get specific debris by ID.
   * @param {number} id
   * @returns {object|null}
   */
  getDebrisById(id) {
    return this.debrisMap.get(id) || null;
  }

  // ==========================================================================
  // CLUSTER ANALYSIS (Phase 2 — Trawl System)
  // ==========================================================================

  /**
   * Group debris into orbital clusters for mission selection.
   * A cluster = debris sharing similar altitude band + inclination center.
   * Includes center position (THREE.Vector3) for autopilot heading and
   * targets array for TrawlManager consumption.
   * @returns {Array<{id: string, name: string, altRange: {min:number,max:number},
   *           incCenter: number, count: number, avgAltKm: number,
   *           totalMassKg: number, types: object, targets: Array,
   *           center: {x:number,y:number,z:number}}>}
   */
  getDebrisClusters() {
    // Inclination cluster names for human-readable IDs (shared module constant).
    const INC_NAMES_LOCAL = INC_NAMES;

    // Build cluster buckets: one per (altBand × incCluster)
    const clusters = new Map();

    for (const alt of ALT_BANDS) {
      for (const inc of INC_NAMES_LOCAL) {
        const id = `${inc.name}-${alt.min}`;
        clusters.set(id, {
          id,
          name: `${inc.label}, ${alt.min}-${alt.max} km`,
          altRange: { min: alt.min, max: alt.max },
          incCenter: inc.center,
          incSpread: inc.spread,
          count: 0,
          avgAltKm: 0,
          totalMassKg: 0,
          types: {},
          targets: [],       // S7-B: debris objects in this cluster
          _altSum: 0,         // running sum for avg computation
          _centerSum: { x: 0, y: 0, z: 0 }, // running sum for center computation
        });
      }
    }

    // Classify each alive debris into its cluster
    for (const debris of this.debrisList) {
      if (!debris.alive) continue;

      // Shared classifier (memoized) — keeps cluster membership identical to
      // the CLUSTER_CLEARED accounting in _maybeEmitClusterCleared.
      const clusterId = this._clusterIdOf(debris);
      if (!clusterId) continue; // out of range
      const cluster = clusters.get(clusterId);
      if (!cluster) continue;

      // Altitude (km) still needed for the running average.
      const altKm = (debris.orbit.semiMajorAxis - Constants.EARTH_RADIUS) / Constants.SCENE_SCALE;

      cluster.count++;
      cluster._altSum += altKm;
      cluster.totalMassKg += debris.mass;
      cluster.types[debris.type] = (cluster.types[debris.type] || 0) + 1;
      cluster.targets.push(debris);

      // S7-B: Accumulate cartesian position for center-of-mass computation
      const cart = orbitToSceneCartesian(debris.orbit);
      if (cart && cart.position) {
        cluster._centerSum.x += cart.position.x;
        cluster._centerSum.y += cart.position.y;
        cluster._centerSum.z += cart.position.z;
      }
    }

    // Finalize: compute averages, filter empty clusters, sort
    const result = [];
    for (const cluster of clusters.values()) {
      if (cluster.count === 0) continue;
      cluster.avgAltKm = cluster._altSum / cluster.count;

      // S7-B: Compute cluster center (average cartesian position of members)
      cluster.center = {
        x: cluster._centerSum.x / cluster.count,
        y: cluster._centerSum.y / cluster.count,
        z: cluster._centerSum.z / cluster.count,
      };

      delete cluster._altSum;
      delete cluster._centerSum;
      delete cluster.incSpread;
      result.push(cluster);
    }

    // Sort by value heuristic: density (count) × type variety
    result.sort((a, b) => {
      const varietyA = Object.keys(a.types).length;
      const varietyB = Object.keys(b.types).length;
      const valueA = a.count * varietyA;
      const valueB = b.count * varietyB;
      return valueB - valueA;
    });

    return result;
  }

  /**
   * Get total count of alive interactive debris.
   * @returns {number}
   */
  getAliveCount() {
    let count = 0;
    for (const d of this.debrisList) {
      if (d.alive) count++;
    }
    return count;
  }

  /**
   * Mission-1 welcome-field diagnostics — per-piece SIZE, POSITION, and
   * VISIBILITY feedback for the curated learning cluster (WELCOME_FIELD #1–#7).
   *
   * Built for tuning the first mission: it reports the *live* state of each
   * curated piece (not the authored spec) so layout drift, LOD culling, or
   * a piece that never becomes discoverable can be spotted on screen via the
   * Ctrl+D debug overlay.
   *
   * Each entry contains:
   *  - `label`      1-based piece number (= spec index + 1 → "debris 1..7")
   *  - `type`       rendered debris type (fragment / cubesat)
   *  - `sizeM`      live size in metres (`sizeMeter`)
   *  - `renderM`    approximate on-screen size (≈ 1.9× sizeMeter, see WELCOME_FIELD)
   *  - `rangeM`     straight-line distance from the player (m) or null
   *  - `fwdM`/`latM` along-track / cross-track offset in the mother's local
   *                 frame (m) — fwd>0 ahead, lat>0 to the right; null if frame
   *                 not yet established
   *  - `inNetRange` true when within Constants.NET_LOCK_RANGE_M
   *  - `discovered` / `tracked`  HUD/targeting visibility flags
   *  - `pinned`     held in the mother's local frame (#1/#2 onboarding pins)
   *  - `captured`   currently held by an arm/net
   *  - `lodState`   'full' | 'far½' | 'CULLED' (distance LOD applied to render)
   *  - `visible`    alive AND rendered (lodScale > 0)
   *
   * @param {{x:number,y:number,z:number}} [playerPos] - mother-ship scene position
   * @returns {Array<object>} entries sorted by piece number ([] if none spawned)
   */
  getWelcomeFieldDiagnostics(playerPos) {
    const out = [];
    if (!Array.isArray(this.debrisList)) return out;

    // METRE_SCENE scene-units-per-metre → invert for scene→metres readout.
    const sceneToM = (METRE_SCENE > 0) ? (1 / METRE_SCENE) : 100000;
    const fwd = this._motherFwd;
    const right = this._motherRight;
    const netRangeM = Constants.NET_LOCK_RANGE_M || 90;

    for (const d of this.debrisList) {
      if (!d || !d.welcomeSpawn) continue;
      if (typeof d._welcomeSpecIndex !== 'number') continue;

      const pos = d._scenePosition;
      let rangeM = null;
      let fwdM = null;
      let latM = null;
      if (pos && playerPos) {
        const dx = pos.x - playerPos.x;
        const dy = pos.y - playerPos.y;
        const dz = pos.z - playerPos.z;
        rangeM = Math.sqrt(dx * dx + dy * dy + dz * dz) * sceneToM;
        if (fwd && right) {
          fwdM = (dx * fwd.x + dy * fwd.y + dz * fwd.z) * sceneToM;
          latM = (dx * right.x + dy * right.y + dz * right.z) * sceneToM;
        }
      }

      // _lodScale is the post-LOD instance scale written each frame in
      // _updateInstanceTransform (0 = culled, sceneSize = full, ½ = far tier).
      const lod = (typeof d._lodScale === 'number') ? d._lodScale : (d.sceneSize || 0);
      let lodState = 'full';
      if (lod === 0) lodState = 'CULLED';
      else if (d.sceneSize > 0 && lod < d.sceneSize * 0.99) lodState = 'far\u00bd';

      const sizeM = Number.isFinite(d.sizeMeter) ? d.sizeMeter : 0;

      out.push({
        label: d._welcomeSpecIndex + 1,
        type: d.type || '?',
        sizeM,
        renderM: sizeM * 1.9,
        rangeM,
        fwdM,
        latM,
        inNetRange: (rangeM != null) ? (rangeM <= netRangeM) : null,
        discovered: !!d.discovered,
        tracked: d.tracked !== false,
        pinned: !!d._onboardingPinned,
        captured: !!d._capturedByArm,
        lodState,
        visible: !!d.alive && lod > 0,
      });
    }

    out.sort((a, b) => a.label - b.label);
    return out;
  }

  /**
   * Count alive debris that have been discovered (revealed via scan/selection).
   * @param {boolean} [trackedOnly=false] - if true, only count tracked debris
   *   (those that Tab cycling can select without an IR scanner).
   * @returns {number}
   */
  getDiscoveredCount(trackedOnly = false) {
    let count = 0;
    for (const d of this.debrisList) {
      if (!d.alive || !d.discovered) continue;
      if (trackedOnly && d.tracked === false) continue;
      count++;
    }
    return count;
  }

  /**
   * Identify the debris "field" (orbital cluster) the player is currently in,
   * based on the dominant cluster among alive debris within `radius` of a
   * position. Used by the scan-reward economy so ground stations pay once per
   * distinct field surveyed (re-scanning the same field yields no new data).
   *
   * Returns null when there is no meaningful field nearby (empty space) — a
   * scan there produces no valuable survey data and earns nothing.
   *
   * @param {THREE.Vector3} position - player scene position
   * @param {number} radius - scene units (defaults to scan reveal range)
   * @returns {string|null} dominant field id (e.g. 'iss-400') or null
   */
  getFieldIdNear(position, radius) {
    if (!position) return null;
    const r = radius || ((Constants.SCAN && Constants.SCAN.REVEAL_BASE_RANGE) || 5.0);
    // Tally cluster ids among alive debris within range (discovered or not —
    // the field exists regardless of whether the player has revealed it yet).
    const tally = new Map();
    const rSq = r * r;
    for (const debris of this.debrisList) {
      if (!debris.alive) continue;
      const sp = debris._scenePosition;
      if (!sp) continue;
      const dx = sp.x - position.x, dy = sp.y - position.y, dz = sp.z - position.z;
      if (dx * dx + dy * dy + dz * dz > rSq) continue;
      const id = this._clusterIdOf(debris);
      if (!id) continue;
      tally.set(id, (tally.get(id) || 0) + 1);
    }
    if (tally.size === 0) return null;
    // Return the most populous field id.
    let bestId = null, bestN = -1;
    for (const [id, n] of tally) {
      if (n > bestN) { bestN = n; bestId = id; }
    }
    return bestId;
  }
}

export default DebrisField;
