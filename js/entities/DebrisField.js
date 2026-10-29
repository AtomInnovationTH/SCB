/**
 * DebrisField.js — Manages all debris objects (interactive + background)
 * Two populations (S11(b)): DEBRIS.FOREGROUND_CAST authored targets (the
 * three-act cast) + a dense uncapturable power-law hazard shard cloud —
 * 800 interactive total with InstancedMesh, 5000 background as Points.
 * @module entities/DebrisField
 */

import * as THREE from 'three';
import { Constants, isArmAttachedToMother } from '../core/Constants.js';
import { TimeAuthority } from '../systems/TimeAuthority.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import {
  propagateOrbit,
  orbitToSceneCartesian,
  orbitToSceneCartesianInto,
  totalDeltaV,
  orbitalVelocity,
  atmosphericDrag,
} from './OrbitalMechanics.js';
import {
  DebrisWireframe,
  initAtlases, getTypeAtlasTexture, getFlagAtlasTexture,
  getUVOffsetForType, getEmissiveForMOID,
  getUVOffsetForCountry,
  getVisualMode,
} from '../ui/DebrisWireframe.js';
import { buildRegimeDebrisSeeds, regimeFromStartOrbit, mulberry32, samplePowerLawSize, sampleSbmMassKg, buildIntactMassPools } from './CatalogConverter.js';
import { deriveCaptureFlags } from './debrisFerrous.js';
import { referenceDragAreaM2 } from './MotherDragArea.js';
import { isFlagEligible, pickCountryForId } from '../ui/FlagDecalSystem.js';
import { bagSize } from './scoopRule.js';
import { DragSailSet } from './DragSailMesh.js';
import { degToRad, radToDeg, clamp01, clamp, smoothstep01 } from '../core/MathUtil.js';

// Honour Constants.DEBRIS.INTERACTIVE_COUNT/BACKGROUND_COUNT so hybrid-mode tests can inject.
const INTERACTIVE_COUNT = (Constants.DEBRIS && Constants.DEBRIS.INTERACTIVE_COUNT) || 800;
const BACKGROUND_COUNT  = (Constants.DEBRIS && Constants.DEBRIS.BACKGROUND_COUNT)  || 5000;

// `aspect` = length:width ratio (1.0 = symmetric). lengthM/widthM are derived per piece in _createDebrisData and
// re-derived on every resize by setDebrisSize. Keep in sync with Constants.ASPECT_CAPTURE.ASPECT_BY_TYPE
// (drift-guarded in test-DebrisField-SizeSSOT.js).
const DEBRIS_TYPES = {
  fragment:     { weight: 0.60, sizeMin: 0.1, sizeMax: 1.0, massMin: 0.01, massMax: 5, tumbleMin: 10, tumbleMax: 180, shape: 'icosahedron', aspect: 1.0 },
  rocketBody:   { weight: 0.12, sizeMin: 5, sizeMax: 11, massMin: 500, massMax: 5000, tumbleMin: 1, tumbleMax: 20, shape: 'cylinder', aspect: 3.5 },
  defunctSat:   { weight: 0.16, sizeMin: 1, sizeMax: 8, massMin: 50, massMax: 2000, tumbleMin: 2, tumbleMax: 30, shape: 'box', aspect: 1.6 },
  missionDebris: { weight: 0.12, sizeMin: 0.05, sizeMax: 0.5, massMin: 0.001, massMax: 2, tumbleMin: 5, tumbleMax: 120, shape: 'sphere', aspect: 1.0 },
  // cubesat: small whole microsat (panelled box), the heaviest whole thing a Mother net can take. Low tumble;
  // the M1 graduation catch (welcome #7), sprinkled rarely into the field.
  cubesat:      { weight: 0.02, sizeMin: 0.1, sizeMax: 0.5, massMin: 1, massMax: 10, tumbleMin: 1, tumbleMax: 15, shape: 'box', aspect: 1.1 },
};

const METRE_SCENE = Constants.SCENE_SCALE / 1000;  // 1 m in scene units (1 km = SCENE_SCALE)

/**
 * A piece the ship HOLDS (`_armPinned`: on the lasso/net line, at the nose, on a rack, in a tip bag, in a daughter's
 * hand) is drawn in the near-field pass while within HELD_NEAR_ON_M of the ship, so the hull cannot paint over it.
 * Same rule as the net tether (CaptureNetVisual TETHER_NEAR_ON_M / TETHER_NEAR_OFF_M); the 8.5/9.5 m gap stops a piece
 * on the limit hopping between passes. The near pass brackets +-10 m (SceneManager NEAR_FIELD_RADIUS).
 */
export const HELD_NEAR_ON_M = 8.5;
export const HELD_NEAR_OFF_M = 9.5;
/**
 * Near camera depth-bracket half-extent, m: SceneManager's NEAR_FIELD_RADIUS (0.0001 scene units; module-private
 * there). test-CatchNearPass reads SceneManager.js and fails if the two drift apart.
 */
export const NEAR_BRACKET_M = 10;
/**
 * A proxy is itself a near-field root and the bracket reaches only NEAR_BRACKET_M beyond its centre, so a piece
 * whose far edge is further out would be clipped. Pieces up to this longest side (half of it, 7 m, leaves slack
 * for the cross-section; rocket bodies <= 11 m, satellites <= 8 m) draw in the near pass; bigger ones stay far pass.
 * Derived from the bracket (the test asserts the relation).
 */
export const HELD_NEAR_MAX_SIZE_M = NEAR_BRACKET_M * 1.4;
const HELD_PROXY_PREFIX = 'HeldCatchProxy_';
const _pairQ = new THREE.Quaternion();   // pairSpec's scratch
const _heldIdentity = new THREE.Matrix4();   // a held proxy's one instance sits at its own object pose

/** Material types for debris */
const MATERIALS = ['aluminum', 'titanium', 'composite', 'mli_mylar', 'solar_cell', 'steel'];

// Material weights BY debris type, so the field is mostly bare/charred metal and dark composite, not "gold/blue soup".
// Gold MLI and blue PV cells only appear on (or shed from) satellites, and then as a minority. Relative weights
// (need not sum to 1); picked via weightedMaterial().
//   fragment: ~6% each gold-MLI / blue-cell shards. These slots also let the welcome spawn SELECT a gold/blue plate
//             candidate (it reuses a debris' existing mesh slot and cannot rebind).
//   defunctSat: the "variety" piece (real chance of gold MLI and blue arrays).
const MATERIAL_WEIGHTS_BY_TYPE = {
  fragment:      { aluminum: 0.36, titanium: 0.21, composite: 0.31, steel: 0.05, mli_mylar: 0.06, solar_cell: 0.06 },
  rocketBody:    { aluminum: 0.45, titanium: 0.25, composite: 0.12, steel: 0.18 },
  defunctSat:    { aluminum: 0.30, titanium: 0.12, composite: 0.18, mli_mylar: 0.16, solar_cell: 0.14, steel: 0.10 },
  missionDebris: { aluminum: 0.30, titanium: 0.16, composite: 0.30, mli_mylar: 0.14, solar_cell: 0.10 },
  // cubesat: aluminium bus dominant, real chance of blue cells + a little gold MLI (working panels/insulation).
  cubesat:       { aluminum: 0.42, composite: 0.18, titanium: 0.08, solar_cell: 0.20, mli_mylar: 0.12 },
};

/**
 * Pick a material tag for a debris piece, weighted by its type; uniform pick if the type is unknown.
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

// Per-instance colour variation: each piece's base colour is nudged deterministically by its id (hue shift, brightness
// variation) so the field doesn't read as one flat tint.
//
// GOTCHA: Three.js colour management (r152+) stores sRGB hex as LINEAR values and the no-arg getHSL/setHSL work in
// linear space. Read/write HSL in *sRGB* space so perceptual lightness varies as intended (else the field goes darker
// and barely varies). Falls back to the no-arg form when the constant is unavailable (older THREE / test stubs).
const _instanceHSL = { h: 0, s: 0, l: 0 };
const _SRGB = (typeof THREE !== 'undefined' && THREE.SRGBColorSpace) || undefined;

// Instance-tint base colour (3D mesh): a near-WHITE weathering modulator. instanceColor multiplies color × map in the
// shader, so dark type colours (getBaseColorForType #666/#333) crush the texture-carried hull colour toward black.
// The type's colour lives in the atlas; this only adds a faint type-appropriate hue bias (bare metal neutral-cool,
// charred fragments warm/sooty, sat surfaces faintly blue) for applyInstanceColorVariation() to jitter.
const _INSTANCE_TINT_BASE = {
  debris:      '#cfcfcf',  // grey structural metal
  fragment:    '#b9b4ac',  // charred, slightly warm bare metal
  rocket_body: '#d6d6dc',  // bright aluminium hull
  inactive:    '#c2c6d2',  // satellite skin, faint cool blue
  active:      '#e6e6ee',  // clean spacecraft
  unknown:     '#c8bfb0',  // weathered warm
};

/**
 * Base colour for the 3D instanceColor weathering modulator (near-white). Not getBaseColorForType(), which stays
 * dark/type-coded for atlas/strategic-map dots.
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

  if (_SRGB) out.getHSL(_instanceHSL, _SRGB);
  else out.getHSL(_instanceHSL);

  // Hue drift: subtle for painted/metal, warmer scatter for raw fragments
  const isFrag = catalogType === 'fragment' || catalogType === 'debris';
  const hueRange = isFrag ? 0.05 : 0.03;
  _instanceHSL.h = (_instanceHSL.h + (r1 - 0.5) * hueRange + 1) % 1;
  _instanceHSL.s = clamp01(_instanceHSL.s * (0.75 + r2 * 0.6));
  // Brightness is the big anti-monotone win: multiplier centred ~1.0 (0.62–1.18) so some pieces read sun-lit and
  // others shadow-darkened without dragging the field dark. The floor keeps near-black fragments from going flat.
  _instanceHSL.l = clamp(_instanceHSL.l * (0.62 + r1 * 0.56), 0.10, 0.97);

  if (_SRGB) out.setHSL(_instanceHSL.h, _instanceHSL.s, _instanceHSL.l, _SRGB);
  else out.setHSL(_instanceHSL.h, _instanceHSL.s, _instanceHSL.l);
  return out;
}

/** Procedural game-type → catalogType for atlas visuals */
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

/** Welcome field debris — spawned near the player on first ORBITAL_VIEW for immediate gameplay.
 *
 *  LAYOUT — the M1 CONE FAN (owner 2026-09-09): all 7 pieces sit AHEAD of the mother, fanned over an ≈8–10° cone about
 *  the prograde boresight (alternating left/right and up/down) around the range-wall piece #3. Rows author offsets in
 *  METRES in the mother's local orbital frame at spawn:
 *    fwd   = along-track / prograde (PlayerSatellite composes quaternion = prograde · _manualRotation),
 *    right = cross-track = fwd × radial (the same axis the #2 pin's latM uses; see _motherRight in update()),
 *    up    = radial, away from Earth.
 *  _placeWelcomePiece converts metres → radians with METRE_SCENE / a. The cluster stays ≤ ~1.5 km; #4–#7 need the
 *  autopilot or a daughter (all inside TETHER_LENGTH_DEFAULT 2000 m and the 5 km AutoLock search; only #1/#2 sit
 *  inside NET_LOCK_RANGE_M).
 *
 *  WHY THE FAN BREATHES BUT NEVER DRIFTS: every free piece keeps the mother's SEMI-MAJOR AXIS (same period). The
 *  cross-track offset is a plane tilt (Δi, ΔΩ) and the radial offset an eccentricity-VECTOR delta at the same a, both
 *  period-preserving, so there is NO secular separation. Over one orbit (≈ 9.2 real minutes at 10× time) right/up
 *  reverse sign every ≈ 4.6 real minutes and the radial offset sloshes along-track by ≤ 2·radM (≤ 130 m for #7).
 *  Do NOT "fix" that float by touching semiMajorAxis: an SMA step is a period change and separates for good
 *  (test-WelcomeField pins the bounded motion and the SMA-drift control case). */
const WELCOME_FIELD = [
  // Mission 1 is NET-ONLY and the Mother net rejects anything over LASSO_MAX_CAPTURE_MASS (10 kg), so EVERY welcome
  // piece is authored ≤ 10 kg.
  //
  // APPEARANCE: all `fragment` (irregular icosahedron) so they read as LOW-VALUE junk, not intact satellites.
  // Candidate selection also prefers fragment-shaped debris because the spawn reuses a debris' instanced-mesh slot
  // (the rendered shape is the candidate's, not the spec's). `sizeM` = drawn longest side, so NONE renders larger
  // than the ~2 m mother; cubesat #7 is the small, dense, valuable "graduation" catch. Reward climbs 1→7 via mass +
  // lowValue (only #1–#2): progression by value, not strictly by size.
  //
  // PLACEMENT (mother-local frame, metres): #1 dead ahead and #2 to the right are PINNED (local-frame, SSOT =
  // _scenePosition) and in net range, so the two guided net catches are guaranteed. #3 is the RANGE WALL: dead ahead
  // at 1.15–1.40× NET_LOCK_RANGE_M (tracks the constant, never a literal) so the reticle flips OUT OF RANGE and
  // teaches Autopilot (A); a FREE co-orbital orbit, not pinned. #4–#7 are FREE orbits at 220–1400 m.
  // Row fields: `pin:true` rows use fwdM/latM (fixed); free rows use fwdMinM/fwdMaxM (fwd randomised inside the band
  // per spawn) plus a fixed latM (right, +) and radM (up, +). Only _placeWelcomePiece reads them.
  //
  // appear* hints drive candidate selection (which mesh slot to reuse; spawn cannot rebind shape/material):
  // plate = flat panel-shard variant, material = the rendered colour (gold mli_mylar foil, blue solar_cell cell).
  //
  // tumbleDegS / tumbleAxis (optional) author the OPENING TUMBLE. Without them a piece keeps its creation-time class
  // roll (fragment band 10–180 °/s): a 180 °/s blender read as chaos, and anything above
  // NET_TUMBLE_PENALTY.IN_SPEC_DEG (10 °/s) queued the `first_high_tumble_target` de-spin teach (TeachingSystem) on
  // the first lock, out of context since the M1 lasso ignores tumble. #1 is 7 °/s on a fixed axis (identical opening
  // every session); #2 15 °/s; #3+ deliberately stay on the class roll. Honoured ONLY by _spawnWelcomeField.
  // Guarded by test-WelcomeField 'authored opening tumble' (threshold from Constants, not a magic number).
  { types: ['fragment'], sizeM: 0.60, lowValue: true, appearMaterial: 'aluminum', appearPlate: true,
    massMin: 3, massMax: 3,  pin: true, fwdM: 22, latM: 0,
    tumbleDegS: 7, tumbleAxis: { x: 0.25, y: 1.0, z: 0.15 } },  // #1 aluminium panel shard (flat) — dead centre, ~22 m, render ~1.15 m; stately authored tumble (< IN_SPEC_DEG)
  { types: ['fragment'], sizeM: 0.70, lowValue: true, appearMaterial: 'mli_mylar', appearPlate: true,
    massMin: 4, massMax: 4,  pin: true, fwdM: 45, latM: 18,
    tumbleDegS: 15 },                                           // #2 MLI-foil scrap (gold flat) — right, in range (≈48 m), render ~1.33 m; a touch livelier
  { types: ['fragment'], sizeM: 0.45, appearMaterial: 'solar_cell', appearPlate: true,
    massMin: 5, massMax: 5,
    fwdMinM: Constants.NET_LOCK_RANGE_M * 1.15, fwdMaxM: Constants.NET_LOCK_RANGE_M * 1.40,
    latM: 0, radM: 0 },                                         // #3 RANGE WALL — solar-cell shard, dead ahead ~104–126 m (just outside the 90 m net lock)
  // Medium/far tier: free orbits fanned left/right and up/down (≈8–10° half-angle).
  { types: ['fragment'], sizeM: 0.55, appearMaterial: 'aluminum', appearPlate: false,
    massMin: 6, massMax: 6,  fwdMinM: 220,  fwdMaxM: 320,  latM: -40,  radM: 20 },  // #4 aluminium fragment ~220–320 m, left + up
  { types: ['fragment'], sizeM: 0.95, appearMaterial: 'solar_cell', appearPlate: true,
    massMin: 6, massMax: 6,  fwdMinM: 420,  fwdMaxM: 560,  latM: 75,   radM: -30 }, // #5 large thin solar-array section ~420–560 m, right + down
  { types: ['fragment'], sizeM: 0.70, appearMaterial: 'mli_mylar', appearPlate: true,
    massMin: 8, massMax: 8,  fwdMinM: 700,  fwdMaxM: 900,  latM: -120, radM: 50 },  // #6 foil + strut bundle ~700–900 m, left + up
  { types: ['cubesat'], sizeM: 0.30,
    massMin: 10, massMax: 10, fwdMinM: 1100, fwdMaxM: 1400, latM: 170,  radM: -65 }, // #7 cubesat (small whole microsat) ~1100–1400 m, right + down
];

/** How often the per-piece distance sweep in _reseatDriftedWelcome runs, in REAL seconds (player-experience timer,
 *  not game time): with a 10 s dwell (Constants.MISSIONS.RESEAT.DWELL_S) 2 s resolves the dwell in 5 steps. */
const RESEAT_SCAN_PERIOD_S = 2;
/** A welcome piece this close to the ship is never re-seated (holds even if RESEAT.DIST_M is retuned below it). */
const RESEAT_NEVER_WITHIN_M = 100;
/** True when any live net in the registry (`activeNets`) targets or holds `debris`. */
function netHoldsPiece(src, debris) {
  const nets = src && src.activeNets;
  if (!Array.isArray(nets)) return false;
  for (const net of nets) {
    if (!net || net.isActive === false) continue;
    const t = net.targetDebris;
    if (t && (t === debris || (t.id != null && t.id === debris.id))) return true;
  }
  return false;
}

/** HOUSTON line posted once per re-seat scan that moved a single piece (plain ASCII; muted at suppression tier 0 by
 *  design: there the reticle re-lock is the cue). A scan that moved several posts ONE line naming the count. */
const RESEAT_COMMS_TEXT = 'Re-acquired a drifted piece ahead of you. Check the reticle.';

/** Altitude bands (km above surface) with percentage weights, from Constants.DEBRIS.ALT_BANDS (7 bands). The
 *  5-band fallback is used only if Constants.DEBRIS is absent. */
const ALT_BANDS = (Constants.DEBRIS && Array.isArray(Constants.DEBRIS.ALT_BANDS))
  ? Constants.DEBRIS.ALT_BANDS
  : [
      { min: 200, max: 400,  weight: 0.20 },
      { min: 400, max: 600,  weight: 0.15 },
      { min: 700, max: 900,  weight: 0.30 },
      { min: 900, max: 1200, weight: 0.20 },
      { min: 1200, max: 2000, weight: 0.15 },
    ];

// Named inclination clusters for human-readable field/cluster IDs, shared by getDebrisClusters() and
// classifyClusterId() so a scanned "field" is identified identically everywhere. (id = `${incName}-${altMin}`.)
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
 * Classify an (altitudeKm, inclinationDeg) pair into a stable field/cluster id, e.g. 'iss-400'.
 * Returns null if the altitude is outside all tracked bands.
 * @param {number} altKm
 * @param {number} incDeg
 * @returns {string|null}
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

/** Gaussian random (Box-Muller) on an explicit stream (seeded assembly). */
function gaussRandomRng(rng, mean = 0, stddev = 1) {
  const u1 = rng();
  const u2 = rng();
  return mean + stddev * Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function randomUnitVector() {
  const theta = Math.random() * 2 * Math.PI;
  const phi = Math.acos(2 * Math.random() - 1);
  return new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.sin(phi) * Math.sin(theta),
    Math.cos(phi)
  );
}

// Pre-allocated orbit temporaries (avoids ~800 spread allocations per frame)
const _tmpKmOrbit = {
  semiMajorAxis: 0, eccentricity: 0, inclination: 0,
  raan: 0, argPerigee: 0, trueAnomaly: 0, meanMotion: 0,
};
const _tmpKmOrbit2 = {
  semiMajorAxis: 0, eccentricity: 0, inclination: 0,
  raan: 0, argPerigee: 0, trueAnomaly: 0, meanMotion: 0,
};

export class DebrisField {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts] - Options.
   * @param {object} [opts.catalogLoader] - Optional catalogue source. If provided AND `.isReady()`, real entries
   *        populate first, with procedural entries topping up INTERACTIVE_COUNT. Null keeps pure-procedural behaviour.
   * @param {number} [opts.interactiveCount] - Override INTERACTIVE_COUNT (rare).
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this._catalogLoader = opts.catalogLoader || null;
    this._motherDragSource = null;      // setMotherDragSource: the player whose last drag step the welcome pieces share
    this._interactiveCount = opts.interactiveCount || INTERACTIVE_COUNT;

    // The field is ONE orbital regime (register item 38), assembled inside the band derived from the player's start
    // orbit (main.js passes computeStartOrbit through regimeFromStartOrbit). A mid-menu language switch (register item
    // 50) re-derives it: GameFlowManager._applyStartLocation calls reseatFieldRegime(), which re-seats every orbit
    // in-band (orbits only; an unchanged regime is a no-op). Absent opts, the ISS-band default keeps legacy
    // constructions/tests deterministic. The seed drives the catalogue pick + procedural orbit draws; it is logged so a
    // reported field is reproducible.
    this._fieldSeed = (opts.seed != null ? opts.seed >>> 0 : (Date.now() >>> 0));
    this._fieldRegime = opts.fieldRegime || regimeFromStartOrbit(null);
    // Cluster-vocabulary identity for the regime (e.g. 'iss-180'); same SSOT as getDebrisClusters.
    this._fieldRegimeLabel = this._regimeLabelFrom(this._fieldRegime);

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

    this._tempMatrix = new THREE.Matrix4();
    this._tempQuat = new THREE.Quaternion();
    this._tempScale = new THREE.Vector3();
    this._tempPos = new THREE.Vector3();

    // Scratch outputs for orbitToSceneCartesianInto, reused across every alive debris + background batch each frame.
    this._tmpCartPos = { x: 0, y: 0, z: 0 };
    this._tmpCartVel = { x: 0, y: 0, z: 0 };
    // Background-orbit scratch: avoids the `{...orbit, semiMajorAxis: …}` spread copy in _updateBackground.
    this._tmpBgOrbit = {
      semiMajorAxis: 0,
      eccentricity: 0,
      inclination: 0,
      raan: 0,
      argPerigee: 0,
      trueAnomaly: 0,
    };

    /** Floating origin reference position (camera-relative rendering) */
    this._floatingOrigin = new THREE.Vector3();
    this._floatingOriginInitialized = false;

    // Background-dot glide state (see _updateBackground). Only 1/4 of the dots are propagated exactly each frame; the
    // other 3/4 are extrapolated with their stored scene-unit velocity and re-based for the floating-origin move.
    /** @type {Float32Array|null} 3 per dot, scene units per second of game time */
    this._bgVel = null;
    /** Game seconds elapsed since each of the 4 batches was last propagated */
    this._bgDtAcc = [0, 0, 0, 0];
    /** Floating origin as of the previous _updateBackground call */
    this._bgPrevOrigin = { x: 0, y: 0, z: 0 };
    this._bgPrevOriginValid = false;

    // Near-field host (main.js attachNearField) and the live held-piece proxies, keyed by debris id. A proxy is a
    // 1-instance InstancedMesh sharing the piece's geometry + material; it IS the near-field root (its own world pose
    // is the piece's), so no parent is parked on the ship and a stale frame can never leave a root behind to stretch
    // the near pass's depth bracket.
    /** @type {object|null} */ this._nearSm = null;
    /** @type {THREE.Object3D|null} */ this._nearPlayer = null;
    /** @type {Map<number, {proxy: THREE.InstancedMesh, canonical: object, ref: object|null}>} */
    this._heldProxies = new Map();
    /** The mother's hidden state the held pieces were last redrawn for (syncHeldWithMother). */
    this._heldHiddenApplied = 0;
    this._heldColor = new THREE.Color();

    this._webTintColor = new THREE.Color(0.85, 0.92, 1.0);
    this._defaultDebrisColor = new THREE.Color(1, 1, 1);
    /** Per-instance brightness boost for the pinned welcome pieces (#1/#2) so they catch the eye on the shadow side
     *  without touching the shared (deliberately dim) material emissive. Modest (1.25×) so the foil / solar-cell hue
     *  still reads as man-made debris, not a neutral-grey "rock". */
    this._welcomeBoostColor = new THREE.Color(1.25, 1.25, 1.25);

    this._moidTmpColor = new THREE.Color();
    this._moidTmpEmissive = new THREE.Color();

    /** Flag overlay InstancedMeshes keyed by country code */
    this.flagMeshes = {};
    /** @type {Map<number, { country: string, instanceIndex: number }>} */
    this._flagLookup = new Map();
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

    // Spatial query cache (avoids a triple scan per frame)
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
    /** FEATURE_FLAGS.FIELDS_BY_HEIGHT: the FieldRegistry that says which field's pieces the mission-start spawn lays
     *  out (null = today's welcome field), and the pieces of the fields she has left. */
    this._fieldSource = null;
    /** @type {Map<string, object>} `${fieldId}|${row}` -> a piece taken out of play when she left its field */
    this._fieldStored = new Map();
    /** @type {Set<number|string>} ids of onboarding tease pieces pinned ahead of
     *  the mother (orbit re-synced each frame) until each is caught. */
    this._onboardingPinIds = new Set();

    /** @type {Map<id,{fwd:{x,y,z}, right:{x,y,z}}>} Per-debris frozen pin-basis overrides: a pinned id with one uses
     *  the fixed world-space basis instead of the live per-frame prograde/right basis, so the ceremony whale does not
     *  ride the slewing prograde. Per id: other pinned pieces keep the live ship-relative basis. Latched/cleared by
     *  the ceremony scenario only. */
    this._onboardingPinBasisOverrides = new Map();

    // Re-seat safety-net state (_reseatDriftedWelcome). The "busy" set: ids something is flying to
    // (AUTOPILOT_TARGET_LOCK from the mother AP and from every daughter closing on a target; a Set because they
    // overlap), the optional "daughter en route" guard main.js wires (setReseatGuard), and the scan cadence
    // accumulator (real seconds).
    /** @type {Set<number|string>} debris ids under an AUTOPILOT_TARGET_LOCK */
    this._lockedDebrisIds = new Set();
    /** @type {((id:number|string) => boolean)|null} "is a daughter flying to this id?" */
    this._reseatGuard = null;
    /** @type {number} real seconds since the last re-seat scan */
    this._reseatScanS = 0;
    /** @type {{x:number,y:number,z:number}|null} ship position as of the PREVIOUS
     *  update call — the same step the pieces' last _scenePosition is from */
    this._reseatPrevShip = null;
    this._reseatHasPrev = false;
    /** @type {{activeNets?: object[]}|null} optional mother-net registry
     *  (CaptureNetSystem) — see setReseatNetSource */
    this._reseatNetSource = null;

    /** @type {object|null} Current mission profile from Constants.MISSIONS.PROFILES */
    this._currentMissionProfile = null;
    /** @type {number} Current mission number */
    this._currentMissionNumber = 1;
    /** true once the background shards run on the later size law (mission 2 on; `_applyShardLaw`). */
    this._shardsLater = false;

    // Boot-timeline marks (?logBoot=1) to attribute cost to orbit generation vs. InstancedMesh build vs. flags vs.
    // background Points. `window.__bootMark` exists only with `?logBoot=1` and is optional-chained: zero overhead by
    // default and safe in the Node test runner (no window global).
    const _bm = (typeof window !== 'undefined') ? window.__bootMark : null;
    this._generateDebris();
    _bm?.('DebrisField._generateDebris (procedural orbit gen) complete');
    initAtlases();                // generate type + flag atlas textures
    _bm?.('DebrisField initAtlases (type + flag atlas textures) complete');
    this._buildInstancedMeshes();
    _bm?.('DebrisField._buildInstancedMeshes complete');
    this._buildFlagOverlays();    // country flag decal overlay layer
    _bm?.('DebrisField._buildFlagOverlays complete');
    this._generateBackground();
    _bm?.('DebrisField._generateBackground (5000 Points) complete');

    if (this._catalogLoader && this._catalogLoader.isReady && this._catalogLoader.isReady()) {
      const proc = this.debrisList.length - this.realEntryCount - (this._heavySpareCount || 0);
      console.log(`[DebrisField] HYBRID mode. ${this.realEntryCount} real catalogue + ${proc} procedural filler`);
    }

    // EDT attract events nudge small debris toward the player
    eventBus.on(Events.EDT_ATTRACT, (data) => this._onEdtAttract(data));

    // GSL web shot hits apply a drag multiplier
    eventBus.on(Events.WEB_SHOT_HIT, (data) => this._onWebShotHit(data));

    // Tool-induced fragmentation sheds fragments at the impact point; breakup/shatter also destroys the body.
    eventBus.on(Events.INTERACTION_FRAGMENTATION, (data) => this._onInteractionFragmentation(data));

    // MISSION_START: update profile and allow re-spawn
    eventBus.on(Events.MISSION_START, (data) => {
      this._currentMissionProfile = data.profile;
      this._currentMissionNumber = data.missionNumber;
      // Reset welcome field flag so new field can spawn for this mission
      this._welcomeFieldSpawned = false;
      // Drop any stale onboarding tease pin from a prior mission/run.
      this._clearOnboardingPin();
      // Also reset the mission-1 hide flag so per-frame enforcement runs again on re-entry (retry / replay path).
      this._mission1HideApplied = false;
      // Mission 2+: restore catalog debris hidden for mission 1. Orbital elements are untouched; flip
      // `alive`/`tracked` back on and let _updateInstanceTransform repopulate the instance matrix next tick.
      if ((data.missionNumber || 1) > 1) {
        this._leaveMission1(data.missionNumber);
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
      this._currentMissionProfile = null;
      this._currentMissionNumber = 1;
      this._applyShardLaw(1);               // a new game is mission 1 again: the shards go back to the first law
      // A previous game's group pieces are ordinary debris now: the map-off "is a group still out?" test
      // (`has('group')` in `_spawnWelcomeField`) reads `_extraKind`, and a stale tag would make the next game skip its
      // group. (The satellite's body is parked below, which drops the tag with every other flag.)
      for (const d of this.debrisList) { d.welcomeSpawn = false; if (d._extraKind) d._extraKind = null; }
      this._clearOnboardingPin();
      this._reviveStoredFieldPieces();      // the pieces of the fields she left go back to the pool
    });
    // A game-over CONTINUE is a fresh attempt at the start field (the registry resets itself): the same clean-up
    eventBus.on(Events.GAMEOVER_CONTINUE, () => this._reviveStoredFieldPieces());

    // The re-seat safety net's "busy" set follows the AUTOPILOT_TARGET_LOCK / UNLOCK pair (mother AP + every
    // daughter) and is cleared on GAME_RESET. Factored out so the subscription is testable without a field.
    this._wireReseatLockEvents();

    // Onboarding tease pin release: hand a curated piece back to normal co-orbital propagation once it leaves play.
    // Each pinned piece (#1, #2) is released independently by id. Released on:
    //  • LASSO_CONTACT — the reel-in begins. MUST release at contact (not completion): otherwise the highest-priority
    //    pin branch in _updateInstanceTransform keeps re-pinning the piece to its fixed mother-local offset every reel
    //    frame (net reels in, debris stays frozen, then vanishes). The LassoSystem reel then drives the piece via the
    //    authoritative _armPinned/_armPinPos direct-copy pin.
    //  • ARM_CAPTURED — daughter-arm catch path (payload uses targetId/debrisId).
    //  • NET_CATCH_SUCCESS — the NetProjectile mother path (fireMotherNet, the production path) never emits
    //    LASSO_CONTACT; without this a pinned piece caught by a mother NET stayed glued at the tease offset (the pin
    //    branch beats _armPinned). It fires before the auto-reel starts, so the handoff is race-free (and the orbit
    //    re-sync in _clearOnboardingPin makes it seamless).
    //  • DEBRIS_REMOVED — the reliable "tease consumed" backstop (fragmentation, web de-orbit, any catch that ends in
    //    removeDebris).
    //  • ONBOARDING_COMPLETE — veteran skip / all-done start (clear all); not at the tutorial's
    //    real end ({ atTutorialEnd: true }: uncaught pieces stay held until caught).
    const _releaseIfMatch = (d) => {
      const id = d?.debrisId ?? d?.targetId ?? d?.id;
      if (id != null && this._onboardingPinIds.has(id)) this._clearOnboardingPin(id);
    };
    if (Events.ARM_CAPTURED) eventBus.on(Events.ARM_CAPTURED, _releaseIfMatch);
    if (Events.LASSO_CONTACT) eventBus.on(Events.LASSO_CONTACT, _releaseIfMatch);
    if (Events.NET_CATCH_SUCCESS) eventBus.on(Events.NET_CATCH_SUCCESS, _releaseIfMatch);
    if (Events.DEBRIS_REMOVED) eventBus.on(Events.DEBRIS_REMOVED, _releaseIfMatch);
    if (Events.ONBOARDING_COMPLETE) {
      eventBus.on(Events.ONBOARDING_COMPLETE, (d) => {
        // The tutorial's real end leaves uncaught welcome pieces held (they release when caught): releasing piece #2
        // would move it ~18 m in one step. A veteran's / skipped tutorial's COMPLETE ({} payload) still releases all.
        if (d?.atTutorialEnd) return;
        this._clearOnboardingPin();
      });
    }

    console.log(`[DebrisField] ${this.debrisList.length} interactive + ${BACKGROUND_COUNT} background debris`);
  }

  /** @private Generate all interactive debris data.
   *  Hybrid mode: real catalogue entries populate first, then procedural entries top up INTERACTIVE_COUNT.
   *  Regime-first: the catalogue half is ADMITTED by the field regime (TLE alt+inc in band) and picked by a seeded
   *  weighted sampler (register item 38); the procedural half is drawn in-band by `_createDebrisData(id, rng)` on the
   *  same seeded stream.
   *  TWO POPULATIONS (register items 38/39; owner: "the whale as act three, not as 24 % of the furniture"): the first
   *  DEBRIS.FOREGROUND_CAST.length slots are the authored foreground cast (three-act shape, exactly
   *  MISSIONS.DEBRIS_PER_MISSION pieces; a real in-band whale substitutes the finale when one exists; at the start
   *  regime the in-band yield is zero, register item 51, so the cast is all-procedural); every other slot is an
   *  uncapturable HAZARD shard from the power-law cloud. */
  _generateDebris() {
    const total = this._interactiveCount;
    const cast = (Constants.DEBRIS && Array.isArray(Constants.DEBRIS.FOREGROUND_CAST))
      ? Constants.DEBRIS.FOREGROUND_CAST : [];
    const finaleMassKg = (Constants.TOOL_RECOMMENDATION
      && Constants.TOOL_RECOMMENDATION.MOTHER_MIN_MASS) || 500;

    // Intact bodies are launch history, not a power law (register item 39): the procedural intact draw samples the
    // REAL catalogue's masses. Empty pools (no loader / tests) fall back to the uniform in-type draw in _createDebrisData.
    this._intactMassPools = buildIntactMassPools(
      (this._catalogLoader && this._catalogLoader.isReady && this._catalogLoader.isReady())
        ? this._catalogLoader.getAllDebris() : []);

    const { real, procedural, debug } = buildRegimeDebrisSeeds(
      this._catalogLoader,
      total,
      (id, rng, info) => {
        if (!info) return this._createDebrisData(id, rng);      // legacy assembly (tests)
        return info.role === 'foreground'
          ? this._createDebrisData(id, rng, cast[info.slot])
          : this._createDebrisData(id, rng, this._drawHazardSpec(rng));
      },
      {
        regime: this._fieldRegime,
        seed: this._fieldSeed,
        foreground: cast.length ? { count: cast.length, finaleMassKg } : null,
      },
    );

    for (const data of real) {
      this._finaliseRealDebris(data);
      this.debrisMap.set(data.id, data);
      this.debrisList.push(data);
      this.realEntryCount++;
    }
    for (const debris of procedural) {
      this.debrisMap.set(debris.id, debris);
      this.debrisList.push(debris);
    }
    // The parked heavy spares take the ids after the live pool; `_nextId` is set after them, so no id repeats.
    this._addHeavySpares();
    this._nextId = this.debrisList.length;

    const r = this._fieldRegime;
    console.log(`[DebrisField] field regime "${this._fieldRegimeLabel}" seed=${this._fieldSeed}: ` +
      `${debug.foregroundCount} authored (${debug.realCount} real finale: ${debug.finaleReal || 'none'}, ` +
      `${debug.eligibleCount} in-band) + ${debug.hazardCount} hazard, ` +
      `alt ${r.altMinKm}–${r.altMaxKm} km, inc ${r.incCenterDeg.toFixed(1)}±${r.incTolDeg}°`);

    // All debris starts hidden; auto-discover runs after welcome-field spawn in update()
  }

  /**
   * The PARKED HEAVY SPARES: one for every row of every `high` field in `Constants.FIELDS.LIST` (4 fields x the 7
   * `Constants.HIGH_FIELD` rows = 28), of that row's type and material. A high field lays its rows out through the
   * ordinary field spawn path (`_spawnWelcomeField`), but an instanced mesh is sized and shaped once at the build
   * (`_buildInstancedMeshes`) and a retyped fragment still draws as a fragment. So the heavy bodies exist from the
   * start, parked out of play, and a high field CLAIMS one per row.
   *
   * Parked = not alive, not tracked, not discovered, not a hazard, instance scaled to nothing, and flag-ineligible
   * (built at `HEAVY_SPARES.PARK_SIZE_M`, under the flag size). Every reader of the pool filters on `alive`, so a spare
   * is in no total, mission, scan, lock or hazard list until claimed. They are NOT in FOREGROUND_CAST (pinned to
   * DEBRIS_PER_MISSION) and take ids after the live pool. Their orbits come from their own seeded stream
   * (`_fieldSeed ^ HEAVY_SPARES.SEED_XOR`), disjoint from the assembly's and the background's; they are never re-seated
   * by `reseatFieldRegime` and never revived as live debris (`_reviveStoredFieldPieces` parks them again).
   * @private
   */
  _addHeavySpares() {
    const rows = Array.isArray(Constants.HIGH_FIELD) ? Constants.HIGH_FIELD : [];
    const lists = (Constants.FIELDS && Array.isArray(Constants.FIELDS.LIST)) ? Constants.FIELDS.LIST : [];
    const highFields = lists.filter((f) => f && f.kind === 'high');
    const hs = Constants.HEAVY_SPARES || {};
    const rng = mulberry32(((this._fieldSeed >>> 0) ^ (hs.SEED_XOR | 0)) >>> 0);
    let count = 0;
    for (let f = 0; f < highFields.length; f++) {
      for (const row of rows) {
        const data = this._createDebrisData(this.debrisList.length, rng, DebrisField._spareSpec(row.types[0], row.material, row.massMin));
        data._heavySpare = true;
        data._spareClaimed = false;
        data.alive = false;
        data.tracked = false;
        data.discovered = false;
        this.debrisMap.set(data.id, data);
        this.debrisList.push(data);
        count++;
      }
    }
    // The mission-satellite pool, after the 28. A `_missionSpare` is claimed by a mission satellite only
    // (`_claimHeavySpare` pool 'mission'); a high field never takes one.
    const missionMats = typeof Constants.missionPoolMaterials === 'function' ? Constants.missionPoolMaterials() : [];
    for (const material of missionMats) {
      const data = this._createDebrisData(this.debrisList.length, rng, DebrisField._spareSpec('defunctSat', material, Constants.MISSION_SAT.MASS_MIN_KG));
      data._heavySpare = true;
      data._missionSpare = true;
      data._spareClaimed = false;
      data.alive = false;
      data.tracked = false;
      data.discovered = false;
      this.debrisMap.set(data.id, data);
      this.debrisList.push(data);
      count++;
    }
    this._heavySpareCount = count;
  }

  /** @private The spec a spare is BUILT from: the row's type and material at the parked size, tracked = false. */
  static _spareSpec(type, material, massKg) {
    const hs = Constants.HEAVY_SPARES || {};
    return { type, material, massKg, sizeM: Number.isFinite(hs.PARK_SIZE_M) ? hs.PARK_SIZE_M : 0.5, tracked: false };
  }

  /**
   * A high-field row claims a parked spare of its type and material (the instanced mesh is the spare's). The first
   * free one by id; with none of that material, the first free one of the type; null when the pool has none (a high
   * field then lays out fewer pieces: it never invents one). A claimed spare stays claimed until `_parkHeavySpare`.
   * @private
   * @param {string} type @param {string} [material] @returns {object|null}
   */
  _claimHeavySpare(type, material, pool = 'high') {
    const mission = pool === 'mission';
    let anyOfType = null;
    for (const d of this.debrisList) {
      if (!d._heavySpare || d.type !== type || !!d._missionSpare !== mission) continue;
      if (d._spareClaimed) {
        // A MISSION body whose piece has been cleared comes back to the pool; a high field's claim stays for good.
        // Re-parked from the body's own stream: no global draw.
        if (!mission || !this._missionBodyCleared(d)) continue;
        this._parkHeavySpare(d, mulberry32(((this._fieldSeed >>> 0) ^ (Constants.HEAVY_SPARES.SEED_XOR | 0) ^ Math.imul(d.id + 1, 0x9E3779B1)) >>> 0));
      }
      if (!material || d.material === material) { d._spareClaimed = true; return d; }
      if (!anyOfType) anyOfType = d;
    }
    if (anyOfType) anyOfType._spareClaimed = true;
    return anyOfType;
  }

  /**
   * A saved BIG piece that was still aboard comes back as a real field body. It claims a parked heavy spare of its
   * type and material exactly as a high-field row does (`_claimHeavySpare`: a reload re-parks every spare, so one is
   * free; none left = null, the caller counts it lost) and takes the saved name, mass, size, owner and tumbling area.
   * It is credited (the catch counted and paid nothing; no later CATCH_PROCESSED for it pays or counts), tagged with
   * the field row it was caught from (the registry's `markCaught` finds the row already gone), alive and discovered,
   * and NOT laid out as a field piece (`welcomeSpawn` false: no re-seat, no store). Not yet held: the caller seats it
   * on a holder (the collar or a daughter's rack), whose pin then owns its position.
   * @param {{type: string, name?: string, material?: string, mass: number, size?: number, owner: object, areaM2?: number, fieldId?: string, fieldRow?: number, massAtCatch?: number}} spec
   *   (`mass` is what is left of a piece being melted; `massAtCatch` what it weighed when caught, so the drawn piece is shortened to the share left)
   * @param {{orbit?: object}} [opts] `orbit`: an orbit to start the body on (the mother's), so its propagation is sane until a holder pins it
   * @returns {object|null} the body
   */
  restoreHeldPiece(spec, opts = {}) {
    if (!spec || !Constants.BIG_PIECES.TYPES.includes(spec.type) || !(spec.mass > 0)) return null;
    const d = this._claimHeavySpare(spec.type, spec.material);
    if (!d) return null;
    d.mass = spec.mass;
    if (Number.isFinite(spec.size) && spec.size > 0) DebrisField.setDebrisSize(d, spec.size);
    if (spec.material) d.material = spec.material;
    if (spec.name) d.name = spec.name;
    d.owner = spec.owner ? { ...spec.owner } : null;
    if (Number.isFinite(spec.areaM2)) d.areaM2 = spec.areaM2;
    // A partly melted piece comes back as its remainder (`mass`), drawn shortened to its share of the mass it was caught at
    if (spec.massAtCatch > 0 && spec.mass < spec.massAtCatch) d._meltK = spec.mass / spec.massAtCatch; else delete d._meltK;
    Object.assign(d, deriveCaptureFlags(d.material, d.type, d.mass));
    if (opts.orbit) d.orbit = { ...opts.orbit };
    d.fieldId = spec.fieldId ?? null;
    d.fieldRow = spec.fieldRow ?? null;
    d._fieldStored = false;
    d._credited = true;
    d.hazard = false;
    d.discovered = true;
    d.tracked = true;
    d.alive = true;
    return d;
  }

  /**
   * Is a claimed MISSION body's piece gone for good? Cleared = it was laid out (`welcomeSpawn`), is no longer alive,
   * is not parked in a field's store (`_fieldStored`: it comes back on a return visit) and is not inside a scoop bag
   * still in play. It does NOT read the capture flags (`_captured`, `_armPinned`, `_capturedByArm`...): a daughter's
   * catch and a tip catch leave `_captured` true when the piece is credited and removed, so a flag test never saw
   * them cleared. A bag member keeps `_inBag` after the bag is credited and removed (`mergeIntoBag` sets alive false,
   * `_captured` false), so the bag itself is looked up: only a bag still alive holds it (a split bag clears `_inBag`).
   * @private
   * @param {object} d a claimed `_missionSpare` body @returns {boolean}
   */
  _missionBodyCleared(d) {
    if (!d.welcomeSpawn || d.alive || d._fieldStored) return false;
    if (d._inBag) {
      const bag = this.debrisMap.get(d._bagId);
      if (bag && bag.alive) return false;
    }
    return true;
  }

  /**
   * Is a mission-satellite body free to claim (never claimed, or claimed and cleared)? FieldRegistry asks before it
   * adds the satellite row to a field, so a row never exists without a body behind it.
   * @returns {boolean}
   */
  hasFreeMissionBody() {
    for (const d of this.debrisList) {
      if (!d._heavySpare || !d._missionSpare) continue;
      if (!d._spareClaimed || this._missionBodyCleared(d)) return true;
    }
    return false;
  }

  /**
   * Park a spare again (a new run, a game-over continue): the body is reset to a fresh parked one of the same id, type
   * and material (every lifecycle flag a piece accrues goes with it, and the object keeps its identity), taken out of
   * play and drawn at no size. The mesh slot (`_meshKey`, instance) is the spare's own and is kept.
   * @private
   * @param {object} d a `_heavySpare` piece
   */
  _parkHeavySpare(d, rng = Math.random) {
    if (this._heldProxies && this._heldProxies.has(d.id)) this._dropHeldProxy(d.id);
    const wasMission = !!d._missionSpare;
    const fresh = this._createDebrisData(d.id, rng, DebrisField._spareSpec(d.type, d.material, d.mass));
    const keep = { _meshKey: d._meshKey };
    for (const k of Object.keys(d)) if (!(k in fresh)) delete d[k];
    Object.assign(d, fresh, keep);
    d._heavySpare = true;
    if (wasMission) d._missionSpare = true;
    d._spareClaimed = false;
    d.alive = false;
    d.tracked = false;
    d.discovered = false;
    const lookup = this._instanceLookup && this._instanceLookup.get(d.id);
    if (lookup) {
      const mesh = this.instancedMeshes[lookup.meshKey];
      if (mesh && this._tempMatrix) {
        this._tempMatrix.makeScale(0, 0, 0);
        mesh.setMatrixAt(lookup.instanceIndex, this._tempMatrix);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /**
   * Per-piece spec for a HAZARD shard: a fragment whose SIZE follows the NASA Standard Breakup Model cumulative count
   * law N(≥Lc) ∝ Lc^−λ (Constants.DEBRIS.HAZARD_CLOUD) drawn on the seeded stream, so the cloud is reproducible from
   * the logged boot seed and its measured exponent is test-pinned.
   * MASS follows the SBM area→mass chain (register item 39; Constants.DEBRIS.MASS_LAW): A = 0.556945·Lc^2.0047, then
   * mass = A/(A/M) with the area-to-mass ratio log-normal (collision fragments, χ = log10(A/M) ~ N(−0.9, 0.45)). The
   * measured cumulative mass exponent lands ≈0.6 (SBM band 0.6–0.85). Two more uniforms are consumed per shard
   * (Box–Muller), in the same fixed order every call, so the seeded stream stays deterministic. The result is clamped
   * to the fragment envelope: the cloud stays shard-class furniture (uncapturable by mass as well as size; ~2–3 % of
   * draws pile at the edges). The shard is flagged uncapturable furniture (`hazard: true`, untracked).
   * @private
   * @param {() => number} rng — the assembly's seeded stream
   * @returns {object} a _createDebrisData spec
   */
  _drawHazardSpec(rng) {
    const HC = (Constants.DEBRIS && Constants.DEBRIS.HAZARD_CLOUD)
      || { LAMBDA: 1.71, SIZE_MIN_M: 0.1, SIZE_MAX_M: 0.5 };
    const ML = (Constants.DEBRIS && Constants.DEBRIS.MASS_LAW)
      || { AREA_COEF: 0.556945, AREA_EXP: 2.0047, AM_LOG10_MEAN: -0.9, AM_LOG10_SIGMA: 0.45 };
    const td = DEBRIS_TYPES.fragment;
    // ONE seeded draw (u, g1, g2: the same three the stream always gave a shard) feeds TWO laws. `sizeM`/`massKg` are
    // mission 1's (edge FIRST_SIZE_MIN_M, so mission 1's field is byte-identical: DECISIONS §38 rows 1 and 4); `later`
    // is the law from mission HC.LATER_FROM_MISSION on (2-50 cm, mass floor MASS_MIN_KG instead of the fragment row's
    // 0.01 kg, which the mission targets share). `_applyShardLaw` swaps them at each mission start.
    const firstMin = Number.isFinite(HC.FIRST_SIZE_MIN_M) ? HC.FIRST_SIZE_MIN_M : HC.SIZE_MIN_M;
    const u = rng(), g1 = rng(), g2 = rng();
    const sizeMeter = samplePowerLawSize(u, firstMin, HC.SIZE_MAX_M, HC.LAMBDA);
    const massKg = Math.max(td.massMin, Math.min(td.massMax,
      sampleSbmMassKg(sizeMeter, g1, g2, ML)));
    const laterSize = samplePowerLawSize(u, HC.SIZE_MIN_M, HC.SIZE_MAX_M, HC.LAMBDA);
    const massFloor = Number.isFinite(HC.MASS_MIN_KG) ? HC.MASS_MIN_KG : td.massMin;
    const laterMass = Math.max(massFloor, Math.min(td.massMax, sampleSbmMassKg(laterSize, g1, g2, ML)));
    return {
      type: 'fragment',
      sizeM: sizeMeter,
      massKg,
      hazard: true,
      tracked: false,
      later: { sizeM: laterSize, massKg: laterMass },
    };
  }

  /**
   * Mission 2+ undoes what mission 1 did to the field: the shards take the later size law, every piece hidden for
   * mission 1 comes back, and the background dots are shown again. One body for MISSION_START and for
   * `setMissionNumber` (a map-off load of a later-mission save, after a mission 1 was played this session).
   * @param {number} missionNumber
   */
  _leaveMission1(missionNumber) {
    let restored = 0;
    // The shards take the later size law BEFORE they come back, so the tracked rule below reads their new size.
    this._applyShardLaw(missionNumber);
    for (const d of this.debrisList) {
      if (d._hiddenForMission1) {
        d._hiddenForMission1 = false;
        d.alive = true;
        // A hazard shard is not a target: restoring it must not catalogue it like one. `_trackedFor` is the one rule:
        // 10 cm or bigger shards are known to radar (tracked, still scenery: hazard keeps them out of every target list).
        d.tracked = this._trackedFor(d);
        restored++;
      }
    }
    if (restored > 0) {
      console.log(`[DebrisField] Mission ${missionNumber}: restored ${restored} previously hidden debris`);
    }
    // Restore the background-points cloud past mission 1: it is hidden during M1 so the pilot sees a clean ≤2 km
    // welcome cluster, not decorative dots at multi-km range that look like real debris.
    if (this.backgroundPoints) {
      this.backgroundPoints.visible = true;
    }
  }

  /**
   * Set the mission the field lays out for, where no MISSION_START will say it (a LOAD with the map off: `GAME_RESET`
   * left 1, so the saved game would run the mission-1 shard law, no extras, the mission-1 hide and the 2 km cull). The
   * map-on load gets the number through `FieldRegistry.restore` -> the field plan (`_currentMissionNumber`,
   * `_spawnWelcomeField`). Applies the shard law for it now (idempotent, no random draw). A bad number is ignored.
   * @param {number} missionNumber the scorer's uncapped mission number (1 = the first)
   * @returns {boolean} true when it was taken
   */
  setMissionNumber(missionNumber) {
    if (!Number.isInteger(missionNumber) || missionNumber < 1) return false;
    this._currentMissionNumber = missionNumber;
    // A later mission also undoes mission 1's hiding (the same body MISSION_START runs): a mission 1 played this
    // session, then quit to the menu and CONTINUE of a mission-3 save, must not leave pieces hidden or the dots off.
    if (missionNumber > 1) this._leaveMission1(missionNumber);
    else this._applyShardLaw(missionNumber);
    return true;
  }

  /**
   * The background shards' size law for the mission now running (DECISIONS §38 row 1). Mission 1: the first law every
   * shard was built with (0.10-0.50 m, untracked). From `HAZARD_CLOUD.LATER_FROM_MISSION`: the shard's `later` size and
   * mass (2-50 cm), and `tracked` follows `_trackedFor`. Touches only pieces still hazard shards (a shard the welcome
   * spawn promoted into a target keeps what the spawn gave it); idempotent, so it may run at every mission start and
   * every welcome spawn. No random draw. Returns the number rewritten.
   * @param {number} [missionNumber]
   * @returns {number}
   */
  _applyShardLaw(missionNumber = this._currentMissionNumber) {
    const HC = (Constants.DEBRIS && Constants.DEBRIS.HAZARD_CLOUD) || {};
    const later = (missionNumber || 1) >= (Number.isFinite(HC.LATER_FROM_MISSION) ? HC.LATER_FROM_MISSION : 2);
    this._shardsLater = later;
    let n = 0;
    for (const d of this.debrisList) {
      if (!d.hazard || !d._shardLaw) continue;
      const v = later ? d._shardLaw.later : d._shardLaw.first;
      if (d.sizeMeter !== v.sizeM) DebrisField.setDebrisSize(d, v.sizeM);
      d.mass = v.massKg;
      if (d.alive) d.tracked = this._trackedFor(d);
      n++;
    }
    return n;
  }

  /**
   * The ONE rule for a piece's `tracked` flag when something puts it back in play (a mission-start restore, a field
   * revive). Everything but a background shard is tracked. A background shard is tracked only under the later law
   * (`_applyShardLaw`) and only at `HAZARD_CLOUD.TRACKED_MIN_M` (10 cm) or bigger: real radars follow pieces from ~10 cm.
   * @param {object} d
   * @returns {boolean}
   */
  _trackedFor(d) {
    if (!d.hazard) return true;
    const HC = (Constants.DEBRIS && Constants.DEBRIS.HAZARD_CLOUD) || {};
    const min = Number.isFinite(HC.TRACKED_MIN_M) ? HC.TRACKED_MIN_M : 0.1;
    return this._shardsLater === true && d.sizeMeter >= min;
  }

  /** @private Convert CatalogConverter's Node-safe seed into THREE.js runtime form: tumbleAxis plain {x,y,z} →
   *  THREE.Vector3, generate salvage. Does NOT mutate the catalogue entry, only the debris-data object passed in. */
  _finaliseRealDebris(data) {
    if (!data.tumbleAxis || !data.tumbleAxis.isVector3) {
      const a = data.tumbleAxis || { x: 0, y: 1, z: 0 };
      data.tumbleAxis = new THREE.Vector3(a.x || 0, a.y || 0, a.z || 0).normalize();
    }
    const sal = this._generateSalvage(data.type, data.mass, data.material);
    data.salvage = sal;
    data.hasSalvage = sal.xenon > 0 || sal.indium > 0 || sal.gaAs > 0 ||
                       sal.battery > 0 || sal.hydrazine > 0 || sal.lithium > 0 ||
                       (sal.metals && sal.metals.length > 0);
    data.metalMassKg = (sal.metals || []).reduce((s, m) => s + m.amount, 0);
    // ConjunctionSystem stamps moidBadge later
    if (data.moidBadge === undefined) data.moidBadge = null;
    // Hidden until scanned
    if (data.discovered === undefined) data.discovered = false;
    // Onboarding tease pin fields: same hidden class as procedural debris so the per-frame read stays monomorphic.
    if (data._onboardingPinned === undefined) data._onboardingPinned = false;
    if (data._onboardingPinFwd === undefined) data._onboardingPinFwd = 0;
    if (data._onboardingPinLat === undefined) data._onboardingPinLat = 0;
  }

  /** @private The regime's cluster-vocabulary identity (e.g. 'iss-180'): ONE computation shared by the constructor
   *  and reseatFieldRegime so the label can never drift from the live regime (same classifyClusterId SSOT). */
  _regimeLabelFrom(regime) {
    return classifyClusterId(
      (regime.altMinKm + regime.altMaxKm) / 2,
      regime.incCenterDeg,
    ) || 'off-band';
  }

  /** @private Draw one orbit INSIDE the field regime on the seeded stream. The whole field is one orbital plane
   *  family centred on the player's start orbit (register item 38: "objects in different planes are not in the same
   *  field"). Altitude spans the containing ALT_BANDS cell (the benign axis: along-track drift, no plane crossings);
   *  inclination/RAAN are gaussian about the regime centre, clamped to ±tol, so the worst-case pairwise plane
   *  difference is ≤ 2·tol (~1° ≈ 135 m/s at VLEO): neighbours, not km/s strangers.
   *  The foreground cast, hazard shards AND the 5000-point background cloud all draw the SAME in-plane geometry here.
   *  ORDER: consumes the rng in a fixed order (alt gauss ×2, inc ×2, raan ×2, then ecc/argP/trueAnomaly singles);
   *  the reproducibility pin depends on that order never changing. */
  _drawRegimeOrbit(rng = Math.random) {
    const regime = this._fieldRegime || regimeFromStartOrbit(null);
    const altMidKm = (regime.altMinKm + regime.altMaxKm) / 2;
    const altKm = gaussRandomRng(rng, altMidKm, (regime.altMaxKm - regime.altMinKm) / 4);
    const clampedAlt = clamp(altKm, regime.altMinKm, regime.altMaxKm - 1e-9);

    const incTol = regime.incTolDeg;
    const incDeg = gaussRandomRng(rng, regime.incCenterDeg, incTol / 2);
    const clampedInc = clamp(incDeg, regime.incCenterDeg - incTol, regime.incCenterDeg + incTol);

    const raanTolRad = degToRad(regime.raanTolDeg || 0);
    const raanCenter = regime.raanCenterRad || 0;
    const raan = raanCenter + Math.max(-raanTolRad,
      Math.min(raanTolRad, gaussRandomRng(rng, 0, raanTolRad / 2)));

    const smaScene = Constants.EARTH_RADIUS + clampedAlt * Constants.SCENE_SCALE;

    return {
      semiMajorAxis: smaScene,
      eccentricity: rng() * 0.02,
      inclination: degToRad(clampedInc),
      raan,
      argPerigee: rng() * 2 * Math.PI,
      trueAnomaly: rng() * 2 * Math.PI,
      meanMotion: 0,
    };
  }

  /**
   * Re-seat the assembled field onto a NEW orbital regime (register item 50: a mid-menu language switch re-aims the
   * player's start orbit via GameFlowManager._applyStartLocation; the field must share that plane or from mission 2
   * the player flies a plane the field doesn't share).
   *
   * ORBITS ONLY: each piece keeps its identity (type/mass/size/material/mesh slot/flags) and its semiMajorAxis +
   * eccentricity BYTE-EXACT. The altitude cell is shared by every language (regimeFromStartOrbit maps the
   * language-independent START_ALTITUDE_KM into the same ALT_BANDS cell), so preserving sma is distribution-identical
   * to re-drawing in-cell, and authored altKm overrides (e.g. the gate-critical 250 km cubesat) are recorded nowhere
   * else. Only inclination, raan, argPerigee, trueAnomaly are re-drawn, through the ONE _drawRegimeOrbit (its fixed
   * rng consumption order is preserved; the drawn sma/ecc are consumed and discarded).
   *
   * The background cloud re-seats too (the sky is one field). Positions follow within a frame (interactive) / a
   * 4-batch cycle (_updateBackground); the _clusterIdOf memo auto-invalidates on the inc change.
   *
   * Deterministic: draws run on a fresh mulberry32 stream keyed off the boot seed XOR a dedicated constant (disjoint
   * from the assembly and background streams, so neither reproducibility pin can move), over the interactive list in
   * index order, then the background orbits in index order. Pieces without an orbit skip WITHOUT consuming the stream.
   *
   * An unchanged regime is a VALUE-compared no-op (computeStartOrbit is pure: exact equality, no epsilon): returns
   * false with zero draws and zero writes.
   *
   * isReal pieces re-seat uniformly (unreachable at the start regime: in-band catalogue yield is zero, register item
   * 51): an admitted real entry keeps its identity and (in-cell) sma and takes an in-band plane.
   *
   * EXEMPTION: welcome-spawned / onboarding-tease-pinned pieces are NEVER re-seated: their positions are pinned to the
   * PLAYER's orbit, so re-seating would teleport an already-placed co-orbital cluster off its pins. Unreachable today
   * (every start path that can carry a CHANGED regime runs resetGame() first, which clears welcomeSpawn and
   * _welcomeFieldSpawned, so the cluster is re-spawned lazily AFTER this re-seat); the guard keeps the invariant in
   * the method, not the call-site wiring. Skipped pieces do NOT consume the rng stream.
   *
   * @param {object|null} regime — a regimeFromStartOrbit() shape.
   * @returns {boolean} true when the field was re-seated.
   */
  reseatFieldRegime(regime) {
    if (!regime) return false;
    const cur = this._fieldRegime;
    if (cur
        && cur.altMinKm === regime.altMinKm
        && cur.altMaxKm === regime.altMaxKm
        && cur.incCenterDeg === regime.incCenterDeg
        && cur.raanCenterRad === regime.raanCenterRad) {
      return false;   // same plane — nothing to move (the common start path)
    }
    const oldLabel = this._fieldRegimeLabel;
    this._fieldRegime = regime;                 // BEFORE the draws: the helper reads it
    this._fieldRegimeLabel = this._regimeLabelFrom(regime);
    const rng = mulberry32((this._fieldSeed ^ 0x50E51EED) >>> 0);
    const reseatOne = (o) => {
      const drawn = this._drawRegimeOrbit(rng);
      o.inclination = drawn.inclination;
      o.raan = drawn.raan;
      o.argPerigee = drawn.argPerigee;
      o.trueAnomaly = drawn.trueAnomaly;
    };
    let seated = 0;
    for (const d of this.debrisList) {
      if (!d || !d.orbit) continue;             // defensive: consumes nothing
      // Never re-seat a player-pinned piece (the welcome cluster / the onboarding tease).
      if (d.welcomeSpawn || d._onboardingPinned) continue;
      if (d._heavySpare) continue;              // a parked spare takes no draw (the stream stays a function of the live pool)
      reseatOne(d.orbit);
      seated++;
    }
    let bgSeated = 0;
    for (const o of this._backgroundOrbits || []) {
      if (!o) continue;
      reseatOne(o);
      bgSeated++;
    }
    // Hidden dots: the fresh draws start now, so time banked before the reseat must not advance them.
    if (this._bgHiddenDt !== undefined) this._bgHiddenDt = 0;
    console.log(`[DebrisField] field regime re-seated "${this._fieldRegimeLabel}" (was "${oldLabel}"): ` +
      `${seated} interactive + ${bgSeated} background orbits in-band (seed=${this._fieldSeed})`);
    return true;
  }

  /** @private Create a single debris data object. Takes the assembly id and the seeded rng from
   *  `buildRegimeDebrisSeeds`; legacy callers (Kessler `createFragments`) omit both and get non-deterministic
   *  behaviour. Only the ORBIT draws are seeded: type/mass/material stay on Math.random (the mass law changed the
   *  DISTRIBUTION, not the seeding).
   *  An optional authored `spec` ({ type, massKg, sizeM, tumbleDeg?, material?, altKm?, tracked?, hazard?, act? })
   *  replaces the random type/mass/size/tumble/material draws with AUTHORED values (the foreground cast + hazard
   *  shards are built this way). Everything not named keeps the random draws; the orbit stays the seeded in-regime
   *  draw (`spec.altKm` only overrides the altitude, consumed identically so the stream never shifts). */
  _createDebrisData(id = this._nextId++, rng = Math.random, spec = null) {
    const specActive = !!spec;

    // Pick type by weighted distribution (authored when a spec drives)
    const typeEntries = Object.entries(DEBRIS_TYPES);
    const typeItem = specActive ? null : weightedRandom(typeEntries.map(([k, v]) => ({ key: k, ...v })));
    const type = specActive ? spec.type : typeItem.key;
    const typeDef = DEBRIS_TYPES[type] || DEBRIS_TYPES.fragment;

    // Size & mass: mass is the primary random; sizeMeter follows the type's mass→size envelope with ±15 % jitter.
    // (Independent size and mass rolls once rendered a 5 kg fragment the same size as a 200 kg defunctSat, breaking
    // "big-looking debris yields big salvage": salvage is roughly linear in mass.) A spec carries AUTHORED mass+size,
    // so the envelope is skipped.
    // THE MASS LAW (register item 39; Constants.DEBRIS.MASS_LAW): fragments and mission debris are breakup/junk
    // populations → inverse-CDF power-law mass (cumulative N(≥m) ∝ m^−MASS_CUM_EXP, the SBM collision asymptote
    // λ/2.0047 ≈ 0.853; the measured exponent pins in band). Intact bodies (rocketBody/defunctSat/cubesat) are launch
    // history → sampled from the REAL catalogue's per-type mass pools (built in _generateDebris; the uniform draw is
    // only the no-catalogue fallback for tests/legacy constructions).
    let mass, sizeMeter;
    if (specActive) {
      mass = spec.massKg;
      sizeMeter = spec.sizeM;
    } else {
      const ML = (Constants.DEBRIS && Constants.DEBRIS.MASS_LAW)
        || { MASS_CUM_EXP: 0.85 };
      if (type === 'fragment' || type === 'missionDebris') {
        mass = samplePowerLawSize(Math.random(), typeDef.massMin, typeDef.massMax, ML.MASS_CUM_EXP);
      } else {
        const pool = this._intactMassPools && this._intactMassPools[type];
        mass = (pool && pool.length)
          ? pool[Math.floor(Math.random() * pool.length)]
          : randRange(typeDef.massMin, typeDef.massMax);   // no catalogue — legacy fallback
      }
      const _massSpan = typeDef.massMax - typeDef.massMin;
      const _massFrac = _massSpan > 0 ? (mass - typeDef.massMin) / _massSpan : 0.5;
      const _sizeSpan = typeDef.sizeMax - typeDef.sizeMin;
      const _sizeMid  = typeDef.sizeMin + _massFrac * _sizeSpan;
      const _sizeJitter = 0.85 + Math.random() * 0.30;   // ±15 %
      sizeMeter = clamp(_sizeMid * _sizeJitter, typeDef.sizeMin * 0.7, typeDef.sizeMax * 1.15);
    }

    // Tumble (authored rate when the spec names one)
    const tumbleRateDeg = (specActive && Number.isFinite(spec.tumbleDeg))
      ? spec.tumbleDeg
      : randRange(typeDef.tumbleMin, typeDef.tumbleMax);
    const tumbleRate = degToRad(tumbleRateDeg); // rad/s
    const tumbleAxis = randomUnitVector();

    // Material: weighted by type so gold MLI / blue solar cells stay rare and concentrated on satellites.
    // A spec authors it directly (the cast's look is deliberate).
    const material = (specActive && spec.material) ? spec.material : weightedMaterial(type);

    const brittleness = Math.random();

    // Tracked: probability by debris type (real-world catalog coverage). The cast is catalogued (tracked); hazard
    // shards are the untrackable population by construction.
    const tracked = specActive
      ? (spec.tracked !== false)
      : Math.random() < (TRACKING_PROB[type] || 0.5);

    // Orbit: the seeded in-regime draw (_drawRegimeOrbit); a spec may pin the altitude (the cubesat's gate-critical far
    // slot). The altitude draw is consumed identically either way, so the stream position never depends on the spec row.
    const orbit = this._drawRegimeOrbit(rng);
    if (specActive && Number.isFinite(spec.altKm)) {
      orbit.semiMajorAxis = Constants.EARTH_RADIUS + spec.altKm * Constants.SCENE_SCALE;
    }

    // Scene-scale size (meters → scene units: 1m = 0.00001 scene units)
    const sceneSize = sizeMeter * 0.00001;

    const salvage = this._generateSalvage(type, mass, material);
    const hasSalvage = salvage.xenon > 0 || salvage.indium > 0 ||
                       salvage.gaAs > 0 || salvage.battery > 0 || salvage.hydrazine > 0 ||
                       salvage.lithium > 0 ||
                       (salvage.metals && salvage.metals.length > 0);

    // Total metal mass for ΔV calculations
    const metalMassKg = (salvage.metals || [])
      .reduce((sum, m) => sum + m.amount, 0);

    // catalogType for procedural debris (real entries set this in CatalogConverter)
    const catalogType = (type === 'fragment' && mass < 1)
      ? 'fragment'
      : (PROC_TYPE_TO_CATALOG[type] || 'debris');

    // Population marks from the driving spec (defaults keep one hidden class; see the return literal).
    const hazard = specActive && spec.hazard === true;
    // A hazard shard keeps both of its size/mass laws (first = mission 1's, later = from mission 2); null for every
    // other piece, so all debris share one hidden class.
    const shardLaw = (hazard && spec.later)
      ? { first: { sizeM: sizeMeter, massKg: mass }, later: { sizeM: spec.later.sizeM, massKg: spec.later.massKg } }
      : null;
    const foreground = specActive && !hazard && Number.isFinite(spec.act);
    const act = foreground ? spec.act : 0;

    return {
      id,
      type,
      orbit,
      sizeMeter,
      sceneSize,
      mass,
      // Aspect-derived extents. sizeMeter remains the max extent (long axis); widthM is the end-on cross-section the
      // net actually has to swallow.
      lengthM: sizeMeter,
      widthM: sizeMeter / (typeDef.aspect || 1.0),
      tumbleRate,
      // Despin doctrine: the tumble the piece SPAWNED with. The capture tumble bonus is paid only when this was
      // above-spec AND tumble at capture is in-spec (the player despun it). Frozen at spawn so despin can't erase it.
      _initialTumbleRate: tumbleRate,
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
      // Capture-recommender inputs (ferromagnetic / hasFerrousFasteners, hasGrappleFixture, surfaceRoughness).
      // SSOT: debrisFerrous.js.
      ...deriveCaptureFlags(material, type, mass),
      // Visual data for atlas system
      isReal: false,
      country: null,
      catalogType,
      moidBadge: null,
      // Population marks, initialised on every piece so all debris share one hidden class. `hazard`: uncapturable
      // power-law shard furniture (excluded from targeting/scan-reveal/trawl; feeds ConjunctionSystem).
      // `foreground`/`act`: a member of the authored three-act cast (Constants.DEBRIS.FOREGROUND_CAST).
      hazard,
      _shardLaw: shardLaw,
      foreground,
      act,
      // Hidden until scanned (staggered reveal), except the authored cast: the field's KNOWN, catalogued population.
      // Five pieces spread around a ~42 000 km ring can never be scan-found (REVEAL_BASE_RANGE 500 km). Hazard shards
      // stay undiscovered forever (scan-reveal skips them; furniture, not contacts).
      discovered: foreground,
      // Onboarding tease pin (init on every piece for one hidden class). Only the curated M1 tease piece flips these on.
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
        // Lithium from Li-ion batteries / propulsion systems
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
        // NOTE: no fragment-sourced GaAs. A shard CAN draw the `solar_cell` material tag (the fragment row gives it
        // 0.06, see MATERIAL_WEIGHTS_BY_TYPE), but GaAs salvage stays reserved for defunctSat: a loose scrap has no
        // recoverable cell. The orphaned SALVAGE_PROB_FRAGMENT_GAAS constant is left in Constants.js for any future
        // re-introduction (register item 91).
        // Trace Indium in titanium alloys
        if (material === 'titanium' && Math.random() < C.SALVAGE_PROB_FRAGMENT_INDIUM) {
          salvage.indium = C.SALVAGE_INDIUM_MIN +
            Math.random() * (C.SALVAGE_INDIUM_MAX - C.SALVAGE_INDIUM_MIN) * 0.4;
        }
        break;
      }
    }

    const metalProfile = C.DEBRIS_METAL_PROFILES[type] || C.DEBRIS_METAL_PROFILES.fragment;
    const recoverableFraction = 0.3 + Math.random() * 0.4; // 30-70% of mass is recoverable
    const recoverableMass = mass * recoverableFraction;

    for (const [metalId, fraction] of Object.entries(metalProfile)) {
      const metalDef = Object.values(C.METALS).find(m => m.id === metalId);
      if (!metalDef) continue;

      const metalMass = recoverableMass * fraction;
      if (metalMass < 0.1) continue; // skip trace amounts

      // ±30 % randomness
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

  // TODO: InstancedMesh merge opportunity — currently one mesh per (type, material, variant) key (~20-30 draw calls).
  // Profile with ?profile=1 first. Potential merge: one atlas-textured MeshStandardMaterial and one InstancedMesh for
  // all fragments. Non-trivial: UV remapping, per-instance colour attributes, flag overlay rewrite. Deferred.

  /** @private Build InstancedMesh per (type, material) with wireframe-derived geometry */
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

    for (const [key, count] of Object.entries(counts)) {
      if (count === 0) continue;
      const parts = key.split(':');
      const type = parts[0];
      const material = parts[1];
      const variantId = parts.length > 2 ? parseInt(parts[2], 10) : 0;

      // Fragments get per-variant geometry
      const geo = DebrisWireframe.getGeometry(type, variantId);

      const matDef = Constants.DEBRIS_MATERIALS[material] || Constants.DEBRIS_MATERIALS.aluminum;

      const isTextured = getVisualMode() === 'textured';
      const catalogType = PROC_TYPE_TO_CATALOG[type] || 'debris';

      let mat;
      if (isTextured) {
        // Emissive = dim, desaturated tint (S×0.25, L≤0.30): debris is visible in shadow (sun + earthshine only)
        // without a coloured wash that defeats the per-instance colour variation.
        const emissiveColor = new THREE.Color(matDef.color);
        const _emHSL = { h: 0, s: 0, l: 0 };
        if (_SRGB) emissiveColor.getHSL(_emHSL, _SRGB); else emissiveColor.getHSL(_emHSL);
        _emHSL.s *= 0.25;
        _emHSL.l = Math.min(_emHSL.l, 0.30);
        if (_SRGB) emissiveColor.setHSL(_emHSL.h, _emHSL.s, _emHSL.l, _SRGB);
        else emissiveColor.setHSL(_emHSL.h, _emHSL.s, _emHSL.l);

        mat = new THREE.MeshStandardMaterial({
          color: matDef.color,
          metalness: matDef.metalness,
          roughness: matDef.roughness,
          emissive: emissiveColor,
          emissiveIntensity: 0.06,
        });
        const typeAtlasTex = getTypeAtlasTexture();
        if (typeAtlasTex) {
          const uvs = getUVOffsetForType(catalogType);
          const clonedTex = typeAtlasTex.clone();
          clonedTex.offset.set(uvs.offsetU, uvs.offsetV);
          clonedTex.repeat.set(uvs.scaleU, uvs.scaleV);
          mat.map = clonedTex;
          mat.needsUpdate = true;

          // The atlas already carries the type colour and the fragment colour is color × map × instanceColor, so a
          // full saturated `color` (gold 0xFFD700) double-tints and muddies. Soften `color` toward a light neutral
          // tint; material identity is carried by metalness/roughness.
          const tint = new THREE.Color(matDef.color);
          const _tHSL = { h: 0, s: 0, l: 0 };
          if (_SRGB) tint.getHSL(_tHSL, _SRGB); else tint.getHSL(_tHSL);
          _tHSL.s *= 0.35;                                 // mostly neutral
          _tHSL.l = clamp(_tHSL.l, 0.72, 0.92); // bright modulator
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

      // White default instanceColor for web shot tinting
      const defaultColor = new THREE.Color(1, 1, 1);
      for (let i = 0; i < count; i++) {
        mesh.setColorAt(i, defaultColor);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

      this.group.add(mesh);
      this.instancedMeshes[key] = mesh;
    }

    // Assign each debris to an instance index and set its instanceColor
    const _tmpTypeColor = new THREE.Color();
    for (const d of this.debrisList) {
      const idx = indexMap[d._meshKey]++;
      this._instanceLookup.set(d.id, { meshKey: d._meshKey, instanceIndex: idx });

      // Near-white weathering modulator (NOT the dark type colour, which lives in the atlas) plus deterministic
      // per-instance variation.
      const baseHex = getInstanceTintBase(d.catalogType || 'unknown');
      _tmpTypeColor.set(baseHex);
      applyInstanceColorVariation(_tmpTypeColor, d.id, d.catalogType);
      const mesh = this.instancedMeshes[d._meshKey];
      if (mesh) {
        mesh.setColorAt(idx, _tmpTypeColor);
      }

      // Initial transform (a parked heavy spare is drawn at no size until a high field claims it)
      if (d._heavySpare) {
        this._tempMatrix.makeScale(0, 0, 0);
        if (mesh) mesh.setMatrixAt(idx, this._tempMatrix);
      } else {
        this._updateInstanceTransform(d, idx);
      }
    }

    for (const mesh of Object.values(this.instancedMeshes)) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Build flag decal overlay InstancedMeshes grouped by country code, each with a small PlaneGeometry carrying the
   * flag atlas UV-mapped to that country's slot. Eligibility is CLASS-gated: only rocket bodies and defunct sats
   * ≥ FLAG_MIN_SIZE_M get a flag (fragments never). Eligible PROCEDURAL pieces get a deterministic weighted country
   * at build time (real catalog rows keep their own).
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

    const countryGroups = {};
    for (const d of this.debrisList) {
      if (!d.country || d.country === '---' || !isFlagEligible(d)) continue;
      const cc = d.country;
      if (!countryGroups[cc]) countryGroups[cc] = [];
      countryGroups[cc].push(d);
    }

    if (Object.keys(countryGroups).length === 0) return;

    // Flag decal patch (aspect ~3:2) in debris-local units (bounding radius ~1): ~0.7 wide reads as a sticker painted
    // ON the hull (NASA/ESA style), not a floating banner.
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

      // All flag instances start at origin (placed in update)
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

      // Deterministic surface-mount direction (which hull face the decal sits on), derived from the id. Biased toward
      // the "side" (low |y|) so the flag faces out from a body panel, not off the nose/engine.
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

  /** @private */
  _generateBackground() {
    const positions = new Float32Array(BACKGROUND_COUNT * 3);
    const colors = new Float32Array(BACKGROUND_COUNT * 3);
    const sizes = new Float32Array(BACKGROUND_COUNT);

    this._backgroundOrbits = [];
    this._bgVel = new Float32Array(BACKGROUND_COUNT * 3);

    // The background is the SAME field the interactive population lives in: one orbital regime (register item 38).
    // Orbits draw from the identical in-regime helper, on a seeded stream derived from the boot seed (XOR-folded so
    // the sky's draws never shift the cast's). Sizes follow the hazard cloud's NASA-SBM power law (many tiny shards,
    // few big): the far-field view of the same fragment population.
    const rng = mulberry32((this._fieldSeed ^ 0x9E3779B9) >>> 0);
    const HC = (Constants.DEBRIS && Constants.DEBRIS.HAZARD_CLOUD)
      || { LAMBDA: 1.71, SIZE_MIN_M: 0.1, SIZE_MAX_M: 0.5 };
    // The sky dots keep their own size mapping, whatever the shards' lower edge is.
    const dotMin = Number.isFinite(HC.DOT_SIZE_MIN_M) ? HC.DOT_SIZE_MIN_M : HC.SIZE_MIN_M;

    for (let i = 0; i < BACKGROUND_COUNT; i++) {
      const orbit = this._drawRegimeOrbit(rng);
      this._backgroundOrbits.push(orbit);

      const cart = orbitToSceneCartesian(orbit);
      positions[i * 3] = cart.position.x;
      positions[i * 3 + 1] = cart.position.y;
      positions[i * 3 + 2] = cart.position.z;
      // cart.velocity is km/s; positions are scene units (km * SCENE_SCALE).
      this._bgVel[i * 3] = cart.velocity.x * Constants.SCENE_SCALE;
      this._bgVel[i * 3 + 1] = cart.velocity.y * Constants.SCENE_SCALE;
      this._bgVel[i * 3 + 2] = cart.velocity.z * Constants.SCENE_SCALE;

      // Color: slightly warm grayish
      colors[i * 3] = 0.6 + rng() * 0.3;
      colors[i * 3 + 1] = 0.55 + rng() * 0.25;
      colors[i * 3 + 2] = 0.5 + rng() * 0.2;

      // Size: power-law shard size, linearly mapped onto the 1–3 dot-size band (the render attribute is decorative;
      // the law it inherits is the measured one).
      const lc = samplePowerLawSize(rng(), dotMin, HC.SIZE_MAX_M, HC.LAMBDA);
      sizes[i] = 1.0 + 2.0 * ((lc - dotMin) / ((HC.SIZE_MAX_M - dotMin) || 1));
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
   * Boost the background debris cloud for the MENU backdrop reveal, or restore it. The transparent menu hero canvas
   * composites over the live game scene, where the faint dust (size 0.0002 / opacity 0.6) reads too subtle.
   *
   * Mission 1 hides `backgroundPoints` (_mission1HideApplied path). This stores/restores the exact prior
   * `.visible`/`size`/`opacity`, so exiting the boost re-applies whatever hidden state was active on entry: no need
   * to consult the mission number or _mission1HideApplied here.
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

  /**
   * Advance a debris's visual tumble angle for this frame, clamped to DEBRIS_MAX_VISUAL_TUMBLE_DEG_S.
   *
   * A CAPTURED debris is cinched in the net, which arrests its tumble, so its orientation is frozen while held (reeling
   * in or parked at the strut tip). The angle resumes from where it stopped if the catch is released (the
   * `_capturedByArm` / `_armPinned` flags clear).
   *
   * @param {object} debris        canonical debris record (mutated in place)
   * @param {number} dt            real-frame delta seconds
   * @param {number} maxVisualRad  per-frame visual-rate clamp (rad/s)
   */
  static _advanceTumble(debris, dt, maxVisualRad) {
    if (debris._capturedByArm || debris._armPinned) return; // cinched — no tumble
    const visualRate = Math.min(debris.tumbleRate * TimeAuthority.BASE_SCALE, maxVisualRad);
    debris.tumbleAngle += visualRate * dt;
  }

  /**
   * SSOT for the sizeMeter ↔ sceneSize pair (1 m = 1e-5 scene units) and for the aspect pair lengthM/widthM that feeds
   * the capture verdicts (assessNetFit / presentedWidthForApproach / oversize_aspect). The renderer scales instances
   * by `sceneSize` (`_updateInstanceTransform`); every mesh is built with its longest bounding-box side = 1 mesh unit,
   * so the drawn longest side IS `sizeMeter`.
   * Every size mutation must go through here so the fields can never desync (a ceremony scenario once wrote
   * `sizeMeter = 7` without `sceneSize` and cinched an 8 m net around a 0.23 m pebble while every gate believed 7 m).
   * @param {object} debris
   * @param {number} sizeMeter
   * @returns {object} debris
   */
  static setDebrisSize(debris, sizeMeter) {
    debris.sizeMeter = sizeMeter;
    debris.sceneSize = sizeMeter * 0.00001;
    // The aspect pair tracks the resize (same derivation as _createDebrisData), keyed on `debris.type` AT CALL TIME so
    // retype-then-resize sites pick up the NEW type's aspect. Verdict RULES are untouched; only the inputs track.
    // The aspect source is THIS module's table; test-DebrisField-SizeSSOT.js pins it equal to ASPECT_BY_TYPE.
    const aspect = (debris && DEBRIS_TYPES[debris.type]
      && DEBRIS_TYPES[debris.type].aspect) || 1.0;
    debris.lengthM = sizeMeter;
    debris.widthM = sizeMeter / aspect;
    return debris;
  }

  /**
   * The physical (UNfloored) uniform instance scale, the ONE base expression every render-scale computation shares:
   * `sceneSize`, else `sizeMeter × METRE_SCENE`, else 0. Both the clamp-aware reader (`effectiveRenderScale`) and the
   * catch ramp's base (`CaptureNet._catchFloorScale`) compute it through this static: a byte-copy of the expression
   * would silently restart the ramp's one-frame pop if the base ever gained a term. Read-only companion to
   * `setDebrisSize`.
   * @param {object} debris
   * @returns {number} base uniform instance scale (scene units)
   */
  static baseRenderScale(debris) {
    return debris.sceneSize || (debris.sizeMeter ? debris.sizeMeter * METRE_SCENE : 0);
  }

  /**
   * The net-held readability floor (`_catchRenderMin`) as ONE computation, applied to ANY pre-floor uniform scale.
   * Both `effectiveRenderScale` (the SSOT reader) and `_updateInstanceTransform` (writer A, which must compose with
   * the LOD multipliers and the reveal smoothstep IN PLACE, and is the ONLY matrix writer for a lasso-held catch,
   * which never reaches `pinCapturedDebris`) route here: the SSOT passes `baseRenderScale` and the field-only pinned
   * default; writer A passes its per-frame scale and its OWN pinned local, deliberately stricter
   * (`_armPinned && _armPinPos`) because that local also gates the pin-POSITION read, so the half-cleared state must
   * not floor here either. Never shrinks: the floor wins only when it exceeds the caller's scale.
   * @param {object} debris
   * @param {number} preFloorScale — the caller's pre-floor uniform scale
   *   (a base, or writer A's per-frame LOD-slot scale)
   * @param {boolean} [pinned=!!debris._armPinned] — the caller's held
   *   determination
   * @returns {number} the floored uniform scale (scene units)
   */
  static catchRenderFloorScale(debris, preFloorScale, pinned = !!debris._armPinned) {
    const min = debris._catchRenderMin;
    return (pinned && min > preFloorScale) ? min : preFloorScale;
  }

  /**
   * The local axis along which a piece being melted is drawn shortened (no magic shrinking, §28: the piece visibly
   * loses the length it has cut). The stage's lathe has its long axis along local Y; any other mesh (the satellite)
   * shortens along its longest bounding-box side. A scoop bag is a ball and shrinks evenly (see `setDrawScale`).
   * @param {{type?: string, id?: number}} debris @returns {'x'|'y'|'z'}
   */
  static meltAxis(debris) {
    const type = debris && debris.type;
    if (type === 'rocketBody') return 'y';
    const he = DebrisWireframe.getBoundingBoxExtents(type, debris && debris.id);
    return he.hy >= he.hx && he.hy >= he.hz ? 'y' : (he.hx >= he.hz ? 'x' : 'z');
  }

  /**
   * Write the draw scale `s` into `out` (a Vector3; static so the writers can run on a bare receiver, as the pin tests
   * do): uniform, except a piece being melted (`debris._meltK`, 0..1 = the share of its mass still there, written by
   * GameFlowManager's melt work and restored from `massAtCatch`) is drawn shortened to that share along its long axis
   * (`meltAxis`); a bag shrinks evenly by the cube root. Never to nothing (a 2 % sliver floor: a singular matrix has
   * no normals). Called by all three matrix writers (the pin, the unpinned writer and the near-pass proxy), so they
   * cannot disagree.
   * @param {THREE.Vector3} out @param {number} s @param {object} debris
   */
  static setDrawScale(out, s, debris) {
    const k = debris ? debris._meltK : undefined;
    if (k === undefined || !(k < 1) || s === 0) { out.setScalar(s); return; }
    const kk = Math.max(k, 0.02);
    if (debris.isBag === true) { out.setScalar(s * Math.cbrt(kk)); return; }
    out.set(s, s, s);
    out[DebrisField.meltAxis(debris)] = s * kk;
  }

  /**
   * The scale the renderer will actually use, including the net-held readability floor (`_catchRenderMin`, applied
   * only while `_armPinned`; see `_updateInstanceTransform`). Read-only companion to setDebrisSize so the probe /
   * visual drivers cannot drift from the renderer. `pinCapturedDebris` reads its scale through THIS helper too: one
   * clamp-aware computation for the probe, the bag's contents floor, and both matrix writers. The floor itself is
   * `catchRenderFloorScale`.
   * @param {object} debris
   * @returns {number} effective uniform instance scale (scene units)
   */
  static effectiveRenderScale(debris) {
    return DebrisField.catchRenderFloorScale(debris, DebrisField.baseRenderScale(debris));
  }

  /**
   * The ONE radius (m) a radiator tip must clear for this catch: the farthest point the catch is DRAWN at, from the
   * point it is pinned and bagged at, at TRUE size with no readability floor (`sizeMeter × DebrisWireframe.getOriginRadius`).
   * `sizeMeter / 2` is not that, but is close since every mesh is drawn with its longest side = sizeMeter:
   * reach / (sizeMeter / 2) is fragment 1.07-1.26, rocketBody 1.31, defunctSat 1.00, missionDebris 1.13, cubesat 1.16
   * (measured by probe). Every tip check (CaptureNet._tryLeash, LeashDriver, TipCargo.stow) reads this, so the
   * physics sphere encloses the drawn mesh.
   * @param {{sizeMeter?: number, type?: string, id?: number}} debris
   * @param {number} [defaultSizeM=0] — size used when `sizeMeter` is missing / 0 / not a number (as the old `||` did)
   * @returns {number} metres
   */
  static trueReachM(debris, defaultSizeM = 0) {
    const s = debris ? debris.sizeMeter : undefined;
    const sizeM = (Number.isFinite(s) && s !== 0) ? s : defaultSizeM;
    // A scoop net's bag is a ball by construction: `sizeMeter / 2`, checked BEFORE the type lookup (its `type` is the
    // heaviest member's, whose mesh is not the bag's shape).
    if (debris && debris.isBag === true) return sizeM / 2;
    // no `type` = a test rig that never drew a mesh: the legacy sphere
    if (!debris || !debris.type) return sizeM / 2;
    return sizeM * DebrisWireframe.getOriginRadius(debris.type, debris.id);
  }

  /**
   * Atmospheric-drag deceleration (km/s²) for one debris piece: the ONE place the drag ballistic coefficient
   * (area / mass) is chosen, factored out of update()'s propagation loop so it is unit-testable (test-WelcomeDrag.js).
   *
   * `welcomeSpawn` pieces use the MOTHER's coefficient instead of their own sizeMeter² / mass: the area and mass her
   * drag block USED this frame (PlayerSatellite.lastDragAreaM2 / lastDragMassKg, read through `source`, the player
   * handed in by setMotherDragSource). With no source, or no value yet (before her first drag step, or above the
   * air), they use her REFERENCE coefficient: MotherDragArea.referenceDragAreaM2() over Constants.MOTHER_DRAG.MASS_KG.
   * Why: the cluster is spawned co-orbital with the mother at 350 km, where drag lowers the SMA ≈ 0.5 m per
   * game-second. The authored rows' own A/m (0.009–0.15) differs from the mother's (about 0.02, changing as she burns
   * gas, turns and moves her wings), so they decay at another rate and the mother pulls ahead or falls behind
   * quadratically (along-track ≈ 0.026–0.040·t² m; > 2 km within ~3.5–5 real minutes with no key pressed: the
   * "welcome cluster drifts away / vanishes" report). Same coefficient ⇒ same per-frame decay factor ⇒ lock-step
   * decay. The pieces stay REAL orbits (not mother-pinned), so RCS / thrust still separate the player from them.
   * Scope: welcomeSpawn only; the M2+ authored cast keeps physical drag. Every other piece keeps cross-section ≈
   * sizeMeter², mass from its spec (floor 1 kg: a 0 / missing mass must not divide to Infinity).
   *
   * @param {object} debris - reads welcomeSpawn, sizeMeter, mass
   * @param {number} altKm - altitude above the surface (km)
   * @param {number} velKms - orbital speed (km/s)
   * @param {{lastDragAreaM2?: (number|null), lastDragMassKg?: (number|null)}|null} [source] - the mother (or null)
   * @returns {number} deceleration (km/s²)
   */
  static dragDecelFor(debris, altKm, velKms, source = null) {
    if (debris.welcomeSpawn) {
      let area = source ? source.lastDragAreaM2 : 0;
      let mass = source ? source.lastDragMassKg : 0;
      if (!(area > 0) || !(mass > 0)) { area = referenceDragAreaM2(); mass = Constants.MOTHER_DRAG.MASS_KG; }
      return atmosphericDrag(altKm, velKms, area, mass);
    }
    const area = debris.sizeMeter * debris.sizeMeter;
    const mass = Math.max(debris.mass || 1, 1);
    return atmosphericDrag(altKm, velKms, area, mass);
  }

  /**
   * Per-frame update: propagate orbits, update instance transforms, update background.
   * @param {number} dt - Real-time (dtReal) delta seconds — LOD, visual tumble, cosmetics.
   * @param {THREE.Vector3} [playerPos] - Player position for LOD
   * @param {object} [playerOrbit] - Player orbital elements (for tutorial debris spawning)
   * @param {number} [dtWorld] - World-simulation delta (game seconds) for orbit + drag, threaded from the
   *   TimeAuthority choke point; defaults to the shipped base rate for headless/test callers (= dt × 10).
   */
  update(dt, playerPos, playerOrbit, dtWorld = TimeAuthority.baseGameDt(dt)) {
    const gameDt = dtWorld;

    // A piece that is no longer held leaves the near pass before the instance loop draws it again.
    if (this._heldProxies && this._heldProxies.size > 0) this._sweepHeldProxies();

    // Cache the latest player orbit so event-driven paths with no update() scope (notably _clearOnboardingPin, fired
    // from LASSO_CONTACT etc.) can re-sync a released pin's fallback orbit to the CURRENT phase. Reference assignment only.
    if (playerOrbit) this._lastPlayerOrbit = playerOrbit;

    // Floating origin: camera-relative rendering
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
        // Points are now relative to playerPos: the origin "moved" by zero this frame.
        this._bgPrevOrigin.x = playerPos.x;
        this._bgPrevOrigin.y = playerPos.y;
        this._bgPrevOrigin.z = playerPos.z;
        this._bgPrevOriginValid = true;
      }
      this._floatingOrigin.copy(playerPos);
      this.group.position.copy(playerPos);
      // Force the group's world matrix to refresh now rather than wait for the renderer's deferred traversal: any
      // consumer reading group.matrixWorld before render (raycaster, project(), lookAt math, post-process) then sees
      // current coordinates, not last frame's. Cheap (one matrix multiply).
      this.group.updateMatrixWorld(true);
    }

    // Welcome field: spawn nearby debris on first frame with valid player orbit
    if (!this._welcomeFieldSpawned && playerPos && playerOrbit) {
      // Stash gameDt so _spawnWelcomeField can pre-compensate the one-frame propagation about to happen below
      // (otherwise debris ends up ~n*gameDt rad ahead of the player and gets culled by the M1 filter).
      this._lastSpawnGameDt = gameDt;
      this._spawnWelcomeField(playerOrbit);
      this._welcomeFieldSpawned = true;
      // Mission-1 hide is not yet applied: the enforcement below runs once to disable catalog debris the welcome field
      // did NOT touch (it overwrites only ~7 debris; the other ~793 still exist at random orbits).
      this._mission1HideApplied = false;
      // Deliberately NO `_autoDiscoverNearest()` here: it used a *static* startSma proxy and could pick a catalog
      // debris the M1 enforcement below immediately killed, leaving zero discovered welcome debris (the "only 1
      // target visible" bug). `_spawnWelcomeField` starts all seven pieces undiscovered; the S-scan reveals them. The
      // live discovery channels are SensorSystem's scan reveal and the authored cast's tracked/pre-discovered flags.
    }

    // Mission-1 cluster enforcement. MUST run AFTER _spawnWelcomeField so the welcome-field marker flags
    // (`welcomeSpawn = true`) are set on the 7 chosen debris; otherwise we would hide everything including the
    // welcome candidates. Idempotent: `_mission1HideApplied` flips once done, so per-frame cost is one flag check.
    // Also handles save-restore paths where _spawnWelcomeField is skipped because _welcomeFieldSpawned was true.
    if ((this._currentMissionNumber || 1) === 1
        && this._welcomeFieldSpawned
        && !this._mission1HideApplied) {
      let hidden = 0;
      for (const d of this.debrisList) {
        if (d.welcomeSpawn) continue;
        if (d._heavySpare) continue;            // a parked spare is not "hidden for mission 1": MISSION_START would revive it
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
      // Hide the 5000-point background cloud on Mission 1: those Points at 200–2000 km altitude render as faint dots
      // inside the frustum that *look like* multi-km debris (seen as "7 km debris"; not targetable). On M1 the pilot's
      // view is limited to the tight welcome cluster. Restored by the MISSION_START handler.
      if (this.backgroundPoints) {
        this.backgroundPoints.visible = false;
      }
      if (hidden > 0) {
        const welcomeCount = this.debrisList.filter(d => d.welcomeSpawn && d.alive).length;
        console.log(`[DebrisField] Mission 1: hid ${hidden} catalog debris + background-points cloud, kept ${welcomeCount} welcome-field targets (total=${this.debrisList.length})`);
      }
      this._mission1HideApplied = true;
    }

    // Per-frame hard distance cutoff on M1: belt-and-suspenders for any debris that escapes the initial hide
    // (catalog debris injected after _welcomeFieldSpawned, save-restored debris with a stale alive flag, future
    // regressions that forget _hiddenForMission1). Any non-welcome alive debris beyond 2 km from the player is zeroed.
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

    // Welcome-cluster re-seat safety net (guided chapters only; only welcomeSpawn pieces are touched, the very pieces
    // the M1 cull above exempts, so it sits after that block and measures the same _scenePosition). It runs BEFORE
    // the propagation loop below, so a re-seated piece is stepped once more this frame like a fresh spawn; hence it
    // receives this frame's gameDt for the same one-step pre-compensation _spawnWelcomeField applies.
    this._reseatDriftedWelcome(playerPos, playerOrbit, dt, gameDt);

    const maxVisualRad = degToRad(Constants.DEBRIS_MAX_VISUAL_TUMBLE_DEG_S);

    // Mother local-frame basis for the onboarding tease pin (forward = prograde, right = cross-track / horizontal),
    // computed once per frame and consumed by _updateInstanceTransform to place pinned pieces. Cleared when no player
    // orbit so the pin branch falls back safely. A frozen basis override may be latched by the ceremony scenario so
    // the pinned whale does not ride the live slewing prograde out of the frozen capture cone (10× world-time flight).
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

      // Web shot drag decay (dragMultiplier > 1 = webbed debris)
      if (debris.dragMultiplier && debris.dragMultiplier > 1.0) {
        const decayRate = Constants.WEB_SHOT_DECAY_RATE * debris.dragMultiplier;
        debris.orbit.semiMajorAxis -= decayRate * gameDt;

        // De-orbited (altitude < burn-up threshold)?
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
            text: `Debris ${debris.id} burned up. Web-assisted de-orbit complete`,
            priority: 'success',
          });
          continue; // skip further processing for this debris
        }
      }

      // Propagate orbit (re-use pre-allocated temp instead of spread)
      const o = debris.orbit;
      if (debris._onboardingPinned || debris._motherParked) {
        // Onboarding tease pin: no Kepler step, no drag. This piece rides the mother at a fixed offset in her LOCAL
        // frame (forward + lateral), written to _scenePosition in _updateInstanceTransform from the per-frame mother
        // basis. _scenePosition is what selection, range, net, reticle and rendering read, but the ORBIT is read too:
        // AutopilotSystem (goal pose + HOLD element copy), NavRecoveryAdvisor, getDebrisClusters (the Shift+A field
        // centre), NavSphere, InsertionPlanner, FieldRiskModel, ConjunctionSystem and CollisionAvoidance all derive a
        // position from `debris.orbit`. A frozen orbit would show those readers the piece where the mother WAS
        // (~77 km per REAL second along-track: 7.7 km/s × the 10× game clock) and pressing A on a pinned #1/#2 (the
        // default AutoLock target) burned retrograde toward that ghost. So re-sync the orbit to the mother's
        // elements EVERY frame (_syncPinnedOrbitToMother, same math as the release re-sync): the orbit-derived
        // position lands within the pin's lateral offset (≤ 18 m, #2) of the mesh. No playerOrbit (headless/menu
        // update) ⇒ the orbit keeps its last synced value.
        if (debris._onboardingPinned && playerOrbit) {
          DebrisField._syncPinnedOrbitToMother(debris, playerOrbit);
        }
        // Mother berth/park hold: _motherParked is a plain skip, the orbit stays frozen. A berthed/parked catch is
        // pinned at the nose every frame (updateBerthHold → pinCapturedDebris); if its own orbit kept propagating
        // through an indefinite park, a later jettison would snap it to wherever the orbit drifted (measured 15.4 km
        // away). _reseatOrbitOnRelease rebuilds the orbit from the pin at [K], so a parked catch's frozen orbit is
        // never the release authority.
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

        // Atmospheric drag: the same formula, sub-stepping and gameDt as PlayerSatellite.update (dtWorld is threaded
        // to both from main.js), and for welcomeSpawn pieces the same BALLISTIC COEFFICIENT too (dragDecelFor).
        // Matching the formula alone was not enough: with their own sizeMeter²/mass the welcome pieces decayed 3–17×
        // slower than the mother and drifted km away. ("Co-orbiting objects stay on the same trajectory" held only
        // for the pinned #1/#2, which skip this branch and ride the mother.)
        // Residual: the spawn frame applies one drag step to the new pieces AFTER the mother took hers (player.update
        // runs first, and _spawnWelcomeField copies her already-decayed SMA), so the welcome SMA sits ONE step
        // (~0.1 m at 60 fps) below the mother's forever: along-track drift ≈ 1.4 mm/s real, < 1 m over 10 min.
        // Accepted; deliberately NOT compensated (a one-off SMA nudge is more machinery than the effect it hides).
        const debrisAltKm = _tmpKmOrbit.semiMajorAxis - Constants.EARTH_RADIUS_KM;
        if (debrisAltKm < Constants.DRAG_CEILING_KM) {
          const debrisVel = orbitalVelocity(
            _tmpKmOrbit.semiMajorAxis, _tmpKmOrbit.semiMajorAxis, Constants.MU_EARTH
          );
          const dragDecel = DebrisField.dragDecelFor(debris, debrisAltKm, debrisVel, this._motherDragSource);
          if (debrisVel > 0) {
            // Drag chunking (see PlayerSatellite): ≤ DRAG_CHUNK_GAME_S game-second Euler sub-steps so the decay
            // factor can't flip negative at high warp. Single, byte-identical step below ~60 game-s.
            const nSub = TimeAuthority.dragSubSteps(gameDt);
            const subDt = gameDt / nSub;
            const factor = 1 - 2 * (dragDecel * subDt) / debrisVel;
            for (let s = 0; s < nSub; s++) o.semiMajorAxis *= factor;
          }
        }
      }

      // Tumble (frozen while the debris is captured — see _advanceTumble).
      DebrisField._advanceTumble(debris, dt, maxVisualRad);

      const lookup = this._instanceLookup.get(debris.id);
      if (lookup) {
        this._updateInstanceTransform(debris, lookup.instanceIndex, playerPos);

        // MOID badge colour tinting (approximated via instanceColor); track badge changes to avoid per-frame work
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

        // Flag overlay transform: the decal is mounted ON the hull surface (NASA/ESA style), facing outward and
        // tumbling with the piece.
        const flagInfo = this._flagLookup.get(debris.id);
        if (flagInfo && debris._scenePosition && debris._lodScale > 0 && !DebrisField.heldHidden(this, debris)) {
          const flagMesh = this.flagMeshes[flagInfo.country];
          if (flagMesh) {
            const sp = debris._scenePosition;
            const dir = debris._flagDir || this._flagPlaneNormal;

            // Same rotation the debris mesh uses
            this._flagQuat.setFromAxisAngle(debris.tumbleAxis, debris.tumbleAngle);

            // Local mount direction → world space: the outward surface normal where the decal sits.
            this._flagDirWorld.copy(dir).applyQuaternion(this._flagQuat);

            // Distance to the hull surface along the (LOCAL) mount direction. The bounding-box face distance (not the
            // bounding-sphere radius) keeps the decal flush even for shapes dominated by far-reaching parts like
            // solar wings. _lodScale maps local units → world; 1.01 sits the decal just proud to avoid z-fighting.
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
              ? smoothstep01(flagRp) : 1;
            // Decal sized in PHYSICAL metres, clamp(sizeMeter × FACTOR, MIN..MAX) (a fixed 0.7-local-unit footprint
            // read tiny on an 8 m rocket body). The LOD shrink ratio is preserved so distant flags fade with their debris.
            const dv = Constants.DEBRIS_VISUAL || {};
            const widthM = Math.min(dv.FLAG_DECAL_MAX_M ?? 1.6,
              Math.max(dv.FLAG_DECAL_MIN_M ?? 0.4,
                (debris.sizeMeter || 1) * (dv.FLAG_SIZE_FACTOR ?? 0.12)));
            const lodRatio = debris.sceneSize > 0 ? debris._lodScale / debris.sceneSize : 1;
            // Plane geometry is 0.7 local units wide → scale to widthM metres (1 m = 0.00001 scene units).
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

    // The drag sails follow their pieces (the draw hook: only while one exists)
    if (this._sails && this._sails.size > 0) this._sails.sync(Constants.FLOATING_ORIGIN_ENABLED ? this._floatingOrigin : null, this._heldHiddenFn || (this._heldHiddenFn = (d) => DebrisField.heldHidden(this, d)));

    for (const mesh of Object.values(this.flagMeshes)) {
      mesh.instanceMatrix.needsUpdate = true;
    }

    // Background debris propagates in batches for performance
    this._updateBackground(gameDt, playerPos);
  }

  /**
   * Hand over the near-field host. `sceneManager` registers/unregisters the proxies as near-field roots; `player` (the
   * ship, a THREE.Group whose `.position` is its scene position) is what "near" is measured from. Without both,
   * nothing is drawn by a proxy (headless / menu / old tests): every piece stays far pass.
   * @param {object|null} sceneManager
   * @param {THREE.Object3D|null} player
   */
  attachNearField(sceneManager, player) {
    this._nearSm = sceneManager || null;
    this._nearPlayer = player || null;
    if (!this._nearSm || !this._nearPlayer) this._dropAllHeldProxies();
  }

  /**
   * True while `debris` (any reference to it) is drawn by its near-pass proxy. CaptureNetVisual and LassoSystem read it
   * so the bag / web around a held piece follows the piece into the same pass.
   * @param {object|null} debris
   * @returns {boolean}
   */
  hasHeldProxy(debris) {
    return !!(debris && debris.id != null && this._heldProxies.has(debris.id));
  }

  /**
   * Draw a HELD piece in the near-field pass while it is near the ship. Called with the piece's pinned pose by every
   * pin (`pinCapturedDebris`, and the pinned branch of `_updateInstanceTransform`). Makes the proxy when the piece
   * comes within HELD_NEAR_ON_M of the ship, keeps it up to HELD_NEAR_OFF_M, and drops it beyond. Sets/clears
   * `_nearProxy` on the canonical object AND the pinning reference. Allocation-free once the proxy exists.
   *
   * @param {object} canonical  the field's object for the piece
   * @param {object|null} ref   the reference the pinning system holds (may differ from `canonical`)
   * @param {{x:number,y:number,z:number}} pos  pinned WORLD position, scene units
   * @param {THREE.Quaternion} quat  the piece's world attitude
   * @param {number} scale  drawn scale (scene units), the same value the far instance would take
   * @returns {boolean} true when the proxy draws the piece (the caller then writes a zero-scale far instance)
   * @private
   */
  _syncHeldProxy(canonical, ref, pos, quat, scale) {
    const sm = this._nearSm;
    const pp = this._nearPlayer && this._nearPlayer.position;
    const id = canonical.id;
    let rec = id != null ? this._heldProxies.get(id) : undefined;
    if (!sm || !pp || id == null || typeof sm.registerNearFieldRoot !== 'function'
        || !Number.isFinite(pp.x) || !Number.isFinite(pp.y) || !Number.isFinite(pp.z)) {
      if (rec) this._dropHeldProxy(id);
      return false;
    }
    const dx = pos.x - pp.x, dy = pos.y - pp.y, dz = pos.z - pp.z;
    const reachM = Math.sqrt(dx * dx + dy * dy + dz * dz) / METRE_SCENE;
    const tooBig = Number.isFinite(canonical.sizeMeter) && canonical.sizeMeter > HELD_NEAR_MAX_SIZE_M;
    const want = !tooBig && (rec ? reachM <= HELD_NEAR_OFF_M : reachM <= HELD_NEAR_ON_M);
    if (!want) {
      if (rec) this._dropHeldProxy(id);
      return false;
    }
    const lookup = this._instanceLookup.get(id);
    const src = lookup ? this.instancedMeshes[lookup.meshKey] : null;
    if (!src) {
      if (rec) this._dropHeldProxy(id);
      return false;
    }
    if (!rec) {
      const proxy = new THREE.InstancedMesh(src.geometry, src.material, 1);   // shares the piece's geometry + material
      proxy.name = HELD_PROXY_PREFIX + id;
      proxy.frustumCulled = false;
      proxy.setMatrixAt(0, _heldIdentity);
      proxy.setColorAt(0, this._defaultDebrisColor);                          // allocates the colour buffer
      this.scene.add(proxy);
      sm.registerNearFieldRoot(proxy);                                        // the proxy is its own near-field root
      if (typeof sm.refreshNearFieldLayers === 'function') sm.refreshNearFieldLayers(proxy);
      rec = { proxy, canonical, ref: ref && ref !== canonical ? ref : null };
      this._heldProxies.set(id, rec);
    } else if (ref && ref !== canonical) {
      rec.ref = ref;
    }
    canonical._nearProxy = true;
    if (rec.ref) rec.ref._nearProxy = true;
    const proxy = rec.proxy;
    proxy.position.set(pos.x, pos.y, pos.z);
    proxy.quaternion.copy(quat);
    DebrisField.setDrawScale(proxy.scale, scale, canonical);   // a piece being melted is drawn shortened along its long axis
    // The per-instance colour (weathering tint, MOID badge) lives on the far instance; keep the proxy in step.
    src.getColorAt(lookup.instanceIndex, this._heldColor);
    proxy.setColorAt(0, this._heldColor);
    if (proxy.instanceColor) proxy.instanceColor.needsUpdate = true;
    return true;
  }

  /** Take a piece's proxy out of the near pass and clear its flags (the far instance returns next write). @private */
  _dropHeldProxy(id) {
    const rec = this._heldProxies.get(id);
    if (!rec) return;
    this._heldProxies.delete(id);
    const sm = this._nearSm;
    if (sm && typeof sm.unregisterNearFieldRoot === 'function') sm.unregisterNearFieldRoot(rec.proxy);
    this.scene.remove(rec.proxy);
    rec.proxy.dispose();                       // frees the proxy's own instance buffers; geometry + material are shared
    rec.canonical._nearProxy = false;
    if (rec.ref) rec.ref._nearProxy = false;
  }

  /** @private */
  _dropAllHeldProxies() {
    for (const id of Array.from(this._heldProxies.keys())) this._dropHeldProxy(id);
  }

  /**
   * Once a frame, before the instance loop, drop every proxy whose piece is no longer held (released, processed,
   * removed, field rebuilt) so the same frame's `_updateInstanceTransform` draws it far pass again.
   * @private
   */
  _sweepHeldProxies() {
    if (this._heldProxies.size === 0) return;
    for (const [id, rec] of this._heldProxies) {
      const d = rec.canonical;
      const cur = this.debrisMap.get(id);
      const lookup = this._instanceLookup.get(id);
      const mesh = lookup ? this.instancedMeshes[lookup.meshKey] : null;
      const held = d.alive !== false && d._armPinned === true && !!d._armPinPos
        && (!cur || cur === d) && !!mesh && mesh.geometry === rec.proxy.geometry;
      if (!held) this._dropHeldProxy(id);
    }
  }

  /**
   * Authoritative catch pin (called by ArmManager AFTER arms move, and after this.update() ran earlier in the frame).
   * Forces a captured debris — both the object reference the arm/net/camera hold AND the CANONICAL field object looked
   * up by id — and its rendered instance onto the arm's scene position.
   *
   * Fixes the reel-in "net + debris drift ~600 m away and vanish" bug: the object the arm pinned was not the same
   * object this field rendered, so position flags never reached the rendered instance. Pinning by id (the canonical
   * key used by _instanceLookup / removeDebris) can't suffer that mismatch.
   *
   * @param {object} debrisRef - the arm's captured debris object (net/camera ref)
   * @param {THREE.Vector3} armScenePos - arm position in scene units
   * @param {number} [scaleMul=1] - multiplier on rendered size (dock stow-shrink); applied AFTER the
   *   `_catchRenderMin` readability floor, so the furnace chop can still shrink a held catch below the floor.
   */
  pinCapturedDebris(debrisRef, armScenePos, scaleMul = 1) {
    if (!debrisRef || !armScenePos) return;
    const id = debrisRef.id;

    // 1) Update the ref the arm/net/camera hold so those consumers track the arm.
    if (!debrisRef._scenePosition) debrisRef._scenePosition = new THREE.Vector3();
    debrisRef._scenePosition.copy(armScenePos);
    debrisRef._armPinPos = debrisRef._armPinPos ? debrisRef._armPinPos.copy(armScenePos) : armScenePos.clone();
    debrisRef._armPinned = true;

    debrisRef._pinScaleMul = scaleMul > 0 ? scaleMul : 1;   // the edge redraw (syncHeldWithMother) reuses it, so a shrinking catch never pops
    // 2) Update the CANONICAL field object by id (may be a different reference) so the orbit-driven renderer doesn't
    //    fight us next frame.
    const canonical = (id != null && this.debrisMap.get(id)) || debrisRef;
    if (canonical !== debrisRef) {
      canonical._pinScaleMul = debrisRef._pinScaleMul;
      if (!canonical._scenePosition) canonical._scenePosition = new THREE.Vector3();
      canonical._scenePosition.copy(armScenePos);
      canonical._armPinPos = canonical._armPinPos ? canonical._armPinPos.copy(armScenePos) : armScenePos.clone();
      canonical._armPinned = true;
    }

    // 3) Force the rendered instance (by id slot) to the arm position THIS frame, overriding the orbit branch.
    if (id == null) return;
    DebrisField.prototype._drawPinned.call(this, canonical, debrisRef, armScenePos, scaleMul);
  }

  /**
   * True while the mother is hidden (the floor-4/5 ship-is-icon costume, the menu backdrop, the Ships step of `-`).
   * Every piece that rides with her is then not drawn: ONE rule, read live by both held-piece writers
   * (`_updateInstanceTransform`'s pinned branch and `_drawPinned`). `_nearPlayer` is the mother (main.js attachNearField).
   * @returns {boolean}
   */
  motherIsHidden() {
    const p = this._nearPlayer;
    return !!p && p.visible === false;
  }

  /**
   * Is the carrier of this held piece hidden? The piece follows whoever carries it: an explicit carrier object
   * (`_carrierObj`, e.g. the resupply craft once it has gripped a piece) by that object's own visibility; a daughter's
   * catch follows HER drawing (her group is hidden when she is attached while the mother is hidden, or by the Ships
   * step; a daughter flying on her own stays drawn, and so does her catch); every other held piece (tip, rack, nose,
   * net, leash, bag) follows the mother. Static + null-safe: tests also run the held-piece writers on bare receivers.
   * @param {object} field  the DebrisField (reads `_nearPlayer` only)
   * @param {object} d      the held piece
   * @returns {boolean}
   */
  static carrierHidden(field, d) {
    const o = d._carrierObj;
    if (o) return o.visible === false;
    const p = field._nearPlayer;
    const motherHidden = !!p && p.visible === false;
    const c = d._capturedByArm;
    if (c && c.group) return c.group.visible === false || (isArmAttachedToMother(c.state) && motherHidden);
    return motherHidden;
  }

  /**
   * Is `d` a held piece (pinned, parked at the nose, or following a daughter) whose carrier is hidden? Gates everything
   * that hangs off a held piece's drawing (instance, proxy, flag decal, drag sail). A free field piece is never "held hidden".
   * @param {object} field
   * @param {object} d
   * @returns {boolean}
   */
  static heldHidden(field, d) {
    if (!d) return false;
    const c = d._capturedByArm;
    const held = !!(d._armPinned && d._armPinPos) || !!d._motherParked
      || !!(c && c.position && c.state && c.state !== 'GRAPPLED' && c.state !== 'NETTING');
    return held && DebrisField.carrierHidden(field, d);
  }

  /**
   * The ONE draw of a pinned (held) piece: far-pass instance or near-pass proxy at the pin, or nothing while the mother
   * is hidden (a held piece is part of her). Body of `pinCapturedDebris` step 3, shared with `syncHeldWithMother`.
   * @private
   */
  _drawPinned(canonical, debrisRef, armScenePos, scaleMul) {
    const id = canonical.id;
    const lookup = this._instanceLookup.get(id);
    if (!lookup) return;
    const mesh = this.instancedMeshes[lookup.meshKey];
    if (!mesh) return;
    const hidden = DebrisField.carrierHidden(this, canonical);
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
    const baseSize = DebrisField.effectiveRenderScale(canonical) || 0.00001;
    // The pin honours the same net-held readability floor as _updateInstanceTransform, via the ONE clamp-aware SSOT
    // read. Floor FIRST, scaleMul AFTER: the furnace stow-shrink must still take a held catch below the floor (the
    // deliberate chunk-mesh swap, ArmManager).
    const drawSize = baseSize * (scaleMul > 0 ? scaleMul : 1);
    // A held piece near the ship is drawn by its near-pass proxy; the far-pass instance is then written at scale 0
    // (every pin, every frame, so it never flickers back). `_nearSm` is null until main.js hands the near-field host
    // over; test stubs calling this on a bare receiver never have one. Mother hidden: no proxy either (drop it), and
    // the far instance is written at scale 0.
    if (hidden && this._heldProxies && this._heldProxies.has(id)) this._dropHeldProxy(id);
    const nearDrawn = !hidden && this._nearSm ? this._syncHeldProxy(canonical, debrisRef, armScenePos, this._tempQuat, drawSize) : false;
    DebrisField.setDrawScale(this._tempScale, nearDrawn || hidden ? 0 : drawSize, canonical);   // shortened while it is melted
    this._tempMatrix.compose(this._tempPos, this._tempQuat, this._tempScale);
    mesh.setMatrixAt(lookup.instanceIndex, this._tempMatrix);
    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Call once per frame just before render (main.js), after everything that can hide or show the mother has run
   * (the ladder floor change lands AFTER this frame's field update). When her visibility differs from what the held
   * pieces were last drawn for, redraw every pinned piece now, so the piece goes with her on the same frame (no
   * one-frame stray on hide, none late on show). Edge-only work; steady frames cost one compare.
   * @param {number} [armMask=0] bitmask of hidden daughter groups (ArmManager.syncAttachedWithMother), part of the change key
   * @returns {boolean} the mother's current hidden state
   */
  syncHeldWithMother(armMask = 0) {
    const hidden = this.motherIsHidden();
    const key = (hidden ? 256 : 0) | armMask;
    if (key === this._heldHiddenApplied) return hidden;
    this._heldHiddenApplied = key;
    const list = this.debrisList;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (d && d._armPinned === true && d._armPinPos && d.alive !== false) {
        this._drawPinned(d, d, d._armPinPos, d._pinScaleMul > 0 ? d._pinScaleMul : 1);
        // The flag decal on a piece that just went hidden goes now too (a shown one is redrawn by the next field update)
        const fi = this._flagLookup && this._flagLookup.get(d.id);
        if (fi && DebrisField.heldHidden(this, d)) {
          const fm = this.flagMeshes[fi.country];
          if (fm) { this._flagScale.setScalar(0); this._flagMatrix.compose(this._flagPos, this._flagQuat, this._flagScale); fm.setMatrixAt(fi.instanceIndex, this._flagMatrix); fm.instanceMatrix.needsUpdate = true; }
        }
      }
    }
    if (this._sails && this._sails.size > 0) this._sails.sync(Constants.FLOATING_ORIGIN_ENABLED ? this._floatingOrigin : null, this._heldHiddenFn || (this._heldHiddenFn = (d) => DebrisField.heldHidden(this, d)));
    return hidden;
  }

  /**
   * CUT_AT_NOSE: spawn ONE cut piece of a captured boss as a real, DRAWN debris object.
   *
   * `createFragments` (the Kessler spawner) sets `_meshKey = null`, so its pieces render nothing. A cut piece is cargo
   * the player watches fly nose → strut tip, so it gets a TRUE InstancedMesh slot: the existing (type:material) mesh is
   * grown by one instance (matrices and colours carried over; geometry and material are shared, never disposed here,
   * since the geometry belongs to the wireframe cache), or the mesh is created on first use with the same recipe as
   * `_buildInstancedMeshes` (one convention, no second key scheme).
   *
   * The piece carries its planned mass and salvage, the parent's material / isReal / country / catalogType, and
   * `_credited: true`: the mate already paid the whole body, so no later CATCH_PROCESSED may pay or recover salvage
   * for a piece (register item 37's law). It is born held: `_captured`/`_armPinned`/`_motherParked` set, orbit frozen
   * at the parent's (the collar pin owns it from the first frame).
   *
   * Deterministic by construction: no rng, ids sequence from `_nextId`.
   *
   * @param {object} parent — the boss debris (read-only)
   * @param {object} pieceSpec — one `planCuts` piece ({ massKg, salvage, zones, index })
   * @param {object} plan — the `planCuts` result (pieces in chop order)
   * @param {number} originalMassKg — the boss's mass BEFORE any cuts (the
   *   size-derivation reference)
   * @param {THREE.Vector3|null} seatScenePos — where to seat the piece now
   * @returns {object|null} the piece, or null when the inputs are unusable
   */
  spawnCutPiece(parent, pieceSpec, plan, originalMassKg, seatScenePos) {
    if (!parent || !pieceSpec || typeof pieceSpec.massKg !== 'number'
      || !(pieceSpec.massKg > 0)) return null;

    const sv = pieceSpec.salvage || null;
    const piece = {
      id: this._nextId++,
      // A piece of the parent: same type (same wireframe family) and provenance fields. Zone-accurate piece SHAPES
      // are a later order; the drawn size below is the volume-honest scaling of the parent's.
      type: parent.type,
      material: parent.material,
      mass: pieceSpec.massKg,
      salvage: sv,
      hasSalvage: !!sv && ((sv.xenon || 0) + (sv.indium || 0) + (sv.gaAs || 0)
        + (sv.battery || 0) + (sv.hydrazine || 0) + (sv.lithium || 0) > 0
        || (Array.isArray(sv.metals) && sv.metals.length > 0)),
      metalMassKg: (sv && Array.isArray(sv.metals))
        ? sv.metals.reduce((s, m) => s + (m.amount || 0), 0) : 0,
      alive: true,
      tracked: false,
      tumbleRate: 0,
      _initialTumbleRate: 0,
      tumbleAxis: (parent.tumbleAxis instanceof THREE.Vector3)
        ? parent.tumbleAxis.clone() : (parent.tumbleAxis || null),
      tumbleAngle: 0,
      isReal: parent.isReal,
      country: parent.country,
      catalogType: parent.catalogType,
      // Cut provenance: what the CARGO_TRANSFER_START `cut` payload reports.
      cutParentId: parent.id,
      cutIndex: pieceSpec.index,
      cutOf: plan && Array.isArray(plan.pieces) ? plan.pieces.length : 0,
      cutZoneName: (pieceSpec.zones && pieceSpec.zones[0] && pieceSpec.zones[0].zoneName) || null,
      // Born paid: the mate credited the whole body already.
      _credited: true,
      // Born held at the nose: cargo from the first frame.
      _captured: true,
      _armPinned: true,
      _motherParked: true,
    };
    if (parent.orbit) piece.orbit = { ...parent.orbit };

    // Volume-honest size: the piece keeps the parent's density, so its drawn extent scales with the cube root of its
    // share of the ORIGINAL body. (The boss's own drawn shape does not shrink as pieces come off: a known limit.)
    const refMass = (originalMassKg && originalMassKg > 0)
      ? originalMassKg : (parent.mass || pieceSpec.massKg);
    const frac = Math.min(1, pieceSpec.massKg / refMass);
    DebrisField.setDebrisSize(piece,
      Math.max(0.1, (parent.sizeMeter || 2) * Math.cbrt(frac)));

    this.debrisMap.set(piece.id, piece);
    this.debrisList.push(piece);

    // The instance slot is what makes the piece DRAWN
    const N = Constants.DEBRIS_FRAGMENT_VARIANTS || 7;
    const key = piece.type === 'fragment'
      ? `${piece.type}:${piece.material}:${piece.id % N}`
      : `${piece.type}:${piece.material}`;
    piece._meshKey = key;
    let mesh = this.instancedMeshes[key];
    let idx;
    if (mesh) {
      // Grow: allocate count+1, carry every existing instance over, swap.
      const next = new THREE.InstancedMesh(mesh.geometry, mesh.material, mesh.count + 1);
      next.name = mesh.name;
      next.frustumCulled = false;
      next.instanceMatrix.array.set(mesh.instanceMatrix.array);
      if (mesh.instanceColor) {
        next.setColorAt(mesh.count, this._defaultDebrisColor);  // allocates the buffer
        next.instanceColor.array.set(mesh.instanceColor.array);
      }
      this.group.add(next);
      this.group.remove(mesh);
      mesh.dispose();   // frees the OLD instance buffers only
      this.instancedMeshes[key] = next;
      mesh = next;
      idx = next.count - 1;
    } else {
      // First piece of this (type:material): build the mesh the way `_buildInstancedMeshes` does (same recipe).
      const geo = DebrisWireframe.getGeometry(piece.type, 0);
      const matDef = Constants.DEBRIS_MATERIALS[piece.material]
        || Constants.DEBRIS_MATERIALS.aluminum;
      const isTextured = getVisualMode() === 'textured';
      const catalogType = PROC_TYPE_TO_CATALOG[piece.type] || 'debris';
      let mat;
      if (isTextured) {
        const emissiveColor = new THREE.Color(matDef.color);
        const _emHSL = { h: 0, s: 0, l: 0 };
        if (_SRGB) emissiveColor.getHSL(_emHSL, _SRGB); else emissiveColor.getHSL(_emHSL);
        _emHSL.s *= 0.25;
        _emHSL.l = Math.min(_emHSL.l, 0.30);
        if (_SRGB) emissiveColor.setHSL(_emHSL.h, _emHSL.s, _emHSL.l, _SRGB);
        else emissiveColor.setHSL(_emHSL.h, _emHSL.s, _emHSL.l);
        mat = new THREE.MeshStandardMaterial({
          color: matDef.color, metalness: matDef.metalness,
          roughness: matDef.roughness, emissive: emissiveColor, emissiveIntensity: 0.06,
        });
        const typeAtlasTex = getTypeAtlasTexture();
        if (typeAtlasTex) {
          const uvs = getUVOffsetForType(catalogType);
          const clonedTex = typeAtlasTex.clone();
          clonedTex.offset.set(uvs.offsetU, uvs.offsetV);
          clonedTex.repeat.set(uvs.scaleU, uvs.scaleV);
          mat.map = clonedTex;
          mat.needsUpdate = true;
          const tint = new THREE.Color(matDef.color);
          const _tHSL = { h: 0, s: 0, l: 0 };
          if (_SRGB) tint.getHSL(_tHSL, _SRGB); else tint.getHSL(_tHSL);
          _tHSL.s *= 0.35;
          _tHSL.l = clamp(_tHSL.l, 0.72, 0.92);
          if (_SRGB) tint.setHSL(_tHSL.h, _tHSL.s, _tHSL.l, _SRGB);
          else tint.setHSL(_tHSL.h, _tHSL.s, _tHSL.l);
          mat.color = tint;
        }
      } else {
        mat = new THREE.MeshStandardMaterial({
          color: matDef.color, metalness: matDef.metalness,
          roughness: matDef.roughness, wireframe: true,
        });
      }
      const fresh = new THREE.InstancedMesh(geo, mat, 1);
      fresh.name = `Debris_${piece.type}_${piece.material}`;
      fresh.frustumCulled = false;
      fresh.setColorAt(0, this._defaultDebrisColor);
      this.group.add(fresh);
      this.instancedMeshes[key] = fresh;
      mesh = fresh;
      idx = 0;
    }
    // Same weathering tint every other instance gets.
    const _cutTint = new THREE.Color(getInstanceTintBase(piece.catalogType || 'unknown'));
    applyInstanceColorVariation(_cutTint, piece.id, piece.catalogType);
    mesh.setColorAt(idx, _cutTint);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this._instanceLookup.set(piece.id, { meshKey: key, instanceIndex: idx });
    mesh.instanceMatrix.needsUpdate = true;

    if (seatScenePos) this.pinCapturedDebris(piece, seatScenePos);
    return piece;
  }

  /**
   * The scoop net's bag (owner 2026-10-23: "daughters may need ways to combine many small pieces in one net"): the
   * reverse of `spawnCutPiece`. A daughter's net that closed on its target calls this with the pieces inside its mouth
   * (the target first, the rest picked by `scoopRule.pickScoopMembers`). It makes ONE new piece, the bag, and takes the
   * members out of play; every downstream rule (one catch per daughter, tip fit by `trueReachM`, the carry gate by
   * `sizeMeter`, the leash, trip melting by mass) then sees one piece. Fewer than two live members: nothing is made
   * (the caller keeps the same piece held).
   *
   * The bag: `isBag: true`; `type`/`material` the heaviest member's (for code that reads a type; `trueReachM` answers
   * `sizeMeter / 2` for a bag BEFORE any type lookup, and `heldBagShape` draws its wrap round that ball); a new id;
   * `mass` the sum; `sizeMeter = 2r` by `scoopRule.bagSize`; position the mass centre; the target's orbit and tumble
   * axis; the tumble RATE mass-weighted [estimate]. `bagMembers[i]` = `{ id, type, massKg, sizeMeter, fieldId,
   * fieldRow, piece }`: the plain fields are what a save or a log needs, `piece` is the member's own body, kept whole
   * so the credit pays each one exactly as if it had been caught alone (score, salvage, `markCaught`).
   *
   * The members: `alive = false` and hidden through `removeDebris` (so the selector, wireframe, reticle and
   * auto-advance hear the one removal event every other leaving piece sends), tagged `_inBag` / `_bagId`.
   * `FieldRegistry._onRemoved` marks a removed piece's row caught, which would pay a row for a piece nobody has been
   * paid for (a lost bag would then lose its members' rows for good). A solo catch's row leaves only at its credit,
   * so the members' field tag is PARKED (`_bagFieldId` / `_bagFieldRow`, the live `fieldId` nulled) for the removal
   * and the credit restores nothing: it marks the `bagMembers` snapshots caught. A bag let go (K), cut, lost or melted
   * is one piece of its total mass and size, like a solo.
   *
   * Drawn: ONE instance of a mesh merged from the members' own meshes at true size, each at its offset from the mass
   * centre (pulled inside the bag's ball when it pokes out) and its own attitude, sharing the heaviest member's material.
   *
   * @param {object[]} members the target first, then the others (already vetted by the caller)
   * @param {{netClass?: object, armIndex?: number}|null} [net] the closing net (its class caps the bag at mouth / 4)
   * @returns {object|null} the bag, or null when fewer than two members are alive
   */
  mergeIntoBag(members, net = null) {
    const live = Array.isArray(members) ? members.filter((m) => m && m.alive !== false && m.isBag !== true) : [];
    if (live.length < 2) return null;
    const target = live[0];
    const netClass = (net && net.netClass) || null;

    // mass centre, scene units
    const posOf = (d) => {
      if (d._scenePosition && Number.isFinite(d._scenePosition.x)) return d._scenePosition;
      return d.orbit ? orbitToSceneCartesian(d.orbit).position : null;
    };
    let mass = 0, cx = 0, cy = 0, cz = 0, wn = 0;
    for (const m of live) {
      const p = posOf(m);
      const w = m.mass > 0 ? m.mass : 1e-6;
      mass += (m.mass || 0);
      if (p) { cx += p.x * w; cy += p.y * w; cz += p.z * w; wn += w; }
    }
    const cm = wn > 0 ? new THREE.Vector3(cx / wn, cy / wn, cz / wn) : null;

    const sz = bagSize(live, netClass, (d) => DebrisField.trueReachM(d));
    const heaviest = live.reduce((a, b) => ((b.mass || 0) > (a.mass || 0) ? b : a), live[0]);
    let spinW = 0, brittle = 0;
    for (const m of live) { spinW += (m.tumbleRate || 0) * (m.mass || 0); brittle = Math.max(brittle, m.brittleness || 0); }
    const tumbleRate = mass > 0 ? spinW / mass : (target.tumbleRate || 0);

    const bag = {
      id: this._nextId++,
      type: heaviest.type,
      material: heaviest.material,
      mass,
      salvage: { xenon: 0, indium: 0, gaAs: 0, battery: 0, hydrazine: 0, lithium: 0, metals: [] },  // each member pays its own
      hasSalvage: false,
      metalMassKg: live.reduce((a, m) => a + (m.metalMassKg || 0), 0),
      brittleness: brittle,
      alive: true,
      tracked: target.tracked !== false,
      discovered: true,
      tumbleRate,
      _initialTumbleRate: tumbleRate,
      tumbleAxis: (target.tumbleAxis instanceof THREE.Vector3)
        ? target.tumbleAxis.clone() : (target.tumbleAxis ? new THREE.Vector3(target.tumbleAxis.x, target.tumbleAxis.y, target.tumbleAxis.z) : new THREE.Vector3(0, 1, 0)),
      tumbleAngle: 0,
      shape: 'sphere',
      isReal: false,
      country: null,
      catalogType: heaviest.catalogType,
      moidBadge: null,
      hazard: false,
      foreground: false,
      act: 0,
      _onboardingPinned: false,
      _onboardingPinFwd: 0,
      _onboardingPinLat: 0,
      _credited: false,
      isBag: true,
      bagNetArmIndex: net && Number.isInteger(net.armIndex) ? net.armIndex : -1,
      bagMembers: live.map((m) => ({
        id: m.id, type: m.type, massKg: m.mass || 0, sizeMeter: m.sizeMeter,
        fieldId: m.fieldId ?? null, fieldRow: m.fieldRow ?? null, piece: m,
      })),
      ...deriveCaptureFlags(heaviest.material, heaviest.type, mass),
    };
    if (target.orbit) bag.orbit = { ...target.orbit };
    DebrisField.setDebrisSize(bag, sz.sizeMeter);
    bag.lengthM = bag.widthM = sz.sizeMeter;            // a ball: the same extent every way
    bag.bagRadiusM = sz.radiusM;
    if (cm) bag._scenePosition = cm.clone();

    // The members leave play (see the docblock for the field-tag parking)
    for (const m of live) {
      m._inBag = true;
      m._bagId = bag.id;
      m._bagFieldId = m.fieldId ?? null;
      m._bagFieldRow = m.fieldRow ?? null;
      m._bagOffsetScene = (cm && posOf(m)) ? new THREE.Vector3(posOf(m).x - cm.x, posOf(m).y - cm.y, posOf(m).z - cm.z) : null;
      m.fieldId = null;
      m._committedNetArmId = null;
      m._captured = false;
    }
    // The bag's mesh is built from the members' meshes BEFORE they are hidden (their slots/materials are still there).
    this.debrisMap.set(bag.id, bag);
    this.debrisList.push(bag);
    this._attachBagMesh(bag, live, cm, sz.radiusM);
    for (const m of live) this.removeDebris(m.id);
    return bag;
  }

  /**
   * Give a bag its one drawn instance: a mesh merged from the members' meshes (true size, at their offsets from the
   * mass centre, pulled inside the ball of radius `radiusM` when they poke out, each at its own attitude). Unit of the
   * merged geometry: one bag `sizeMeter`, like every other mesh here (drawn at `sceneSize` = `sizeMeter` x 1e-5).
   * Shares the heaviest member's material. Nothing is drawn (the bag is still a piece) when no member has a mesh or
   * the field has no scene group.
   * @private
   */
  _attachBagMesh(bag, live, cm, radiusM) {
    if (!this.group || !this.instancedMeshes) return;
    const sizeM = bag.sizeMeter;
    if (!(sizeM > 0)) return;
    const parts = [];
    const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _n = new THREE.Vector3(), _o = new THREE.Vector3();
    let hasUv = true;
    for (const m of live) {
      const src = DebrisWireframe.getGeometry(m.type, m.id);
      if (!src || !src.attributes || !src.attributes.position) continue;
      const g = src.index ? src.toNonIndexed() : src.clone();
      if (!g.attributes.uv) hasUv = false;
      const reach = Math.max(1e-6, DebrisField.trueReachM(m));
      // offset from the mass centre, metres, pulled inside the ball when the member would poke out of it
      const p = (m._scenePosition && Number.isFinite(m._scenePosition.x)) ? m._scenePosition : (m.orbit ? orbitToSceneCartesian(m.orbit).position : null);
      if (p && cm) _o.set((p.x - cm.x) / METRE_SCENE, (p.y - cm.y) / METRE_SCENE, (p.z - cm.z) / METRE_SCENE);
      else _o.set(0, 0, 0);
      const room = Math.max(0, radiusM - reach);
      const dist = _o.length();
      if (dist > room) _o.multiplyScalar(dist > 0 ? room / dist : 0);
      if (m.tumbleAxis) _q.setFromAxisAngle(m.tumbleAxis, m.tumbleAngle || 0); else _q.identity();
      parts.push({ g, k: (m.sizeMeter || sizeM) / sizeM, ox: _o.x / sizeM, oy: _o.y / sizeM, oz: _o.z / sizeM, q: _q.clone() });
    }
    if (parts.length === 0) return;
    let total = 0;
    for (const t of parts) total += t.g.attributes.position.count;
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = hasUv ? new Float32Array(total * 2) : null;
    let at = 0;
    for (const t of parts) {
      const P = t.g.attributes.position, N = t.g.attributes.normal, U = t.g.attributes.uv;
      for (let i = 0; i < P.count; i++, at++) {
        _v.set(P.getX(i), P.getY(i), P.getZ(i)).applyQuaternion(t.q).multiplyScalar(t.k);
        pos[at * 3] = _v.x + t.ox; pos[at * 3 + 1] = _v.y + t.oy; pos[at * 3 + 2] = _v.z + t.oz;
        if (N) { _n.set(N.getX(i), N.getY(i), N.getZ(i)).applyQuaternion(t.q); nor[at * 3] = _n.x; nor[at * 3 + 1] = _n.y; nor[at * 3 + 2] = _n.z; }
        else { nor[at * 3 + 1] = 1; }
        if (uv && U) { uv[at * 2] = U.getX(i); uv[at * 2 + 1] = U.getY(i); }
      }
      t.g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (uv) geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.computeBoundingSphere();
    const heavyLook = this._instanceLookup.get(live.reduce((a, b) => ((b.mass || 0) > (a.mass || 0) ? b : a), live[0]).id);
    const heavyMesh = heavyLook ? this.instancedMeshes[heavyLook.meshKey] : null;
    let mat = heavyMesh ? heavyMesh.material : null;
    if (!mat) mat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.5, roughness: 0.6, wireframe: getVisualMode() !== 'textured' });
    const key = `bag:${bag.id}`;
    const mesh = new THREE.InstancedMesh(geo, mat, 1);
    mesh.name = `Debris_bag_${bag.id}`;
    mesh.frustumCulled = false;
    mesh.setColorAt(0, this._defaultDebrisColor);
    const _tint = new THREE.Color(getInstanceTintBase(bag.catalogType || 'unknown'));
    applyInstanceColorVariation(_tint, bag.id, bag.catalogType);
    mesh.setColorAt(0, _tint);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    this.instancedMeshes[key] = mesh;
    bag._meshKey = key;
    this._instanceLookup.set(bag.id, { meshKey: key, instanceIndex: 0 });
    mesh.instanceMatrix.needsUpdate = true;
    bag._ownsMesh = true;
  }

  /**
   * Update the instance matrix for a single debris piece.
   * @private
   */
  _updateInstanceTransform(debris, instanceIndex, playerPos) {
    // Once an arm has captured this debris AND moved past GRAPPLED stabilization (reeling/hauling/docking back to the
    // mother), the visual must FOLLOW the arm rather than its independent orbit. During GRAPPLED itself the
    // orbit-driven path runs so the rigid arm+debris pair co-orbits naturally (arm.position.copy(tPos) in
    // _updateGrappled keeps the arm shadowed onto the debris).
    let px, py, pz;
    // AUTHORITATIVE arm pin (set by ArmUnit while it owns the catch during REELING/DOCKING and for a tether-snapped
    // drift): a direct position copy with NO state/ref checks, so SK/welcome-debris edge cases can't defeat it (the
    // older `_capturedByArm` pin read the orbit branch and the catch drifted 600 m+ away mid-haul).
    const _armPinned = !!(debris._armPinned && debris._armPinPos);
    const _captor = debris._capturedByArm;
    const _captorState = _captor && _captor.state;
    const _pinToArm = !_armPinned && _captor && _captor.position &&
      _captorState && _captorState !== 'GRAPPLED' && _captorState !== 'NETTING';
    // Onboarding tease pin (local frame): the piece sits at a fixed forward + lateral offset from the mother so it
    // reads dead-centre (#1) or off to one side (#2) and is selectable/in-range. This _scenePosition is authoritative
    // (TargetSelector/AutoLock/Lasso/reticle all read it). An arm capture (ARM_CAPTURED) releases the pin first, so
    // _armPinned wins after.
    // Register item 23: _onboardingPinBasisOverrides is production-unreachable (its only writer is the dev scenario in
    // main.js) but LOAD-BEARING for the visual gates: record, do NOT delete.
    const _pinBasisOv = this._onboardingPinBasisOverrides?.get(debris.id);
    const _onboardPinned = !!(debris._onboardingPinned && playerPos &&
      (_pinBasisOv || (this._motherFwd && this._motherRight)));
    if (_onboardPinned) {
      // Per-id frozen basis wins for this piece; every other pinned piece uses the live ship-relative basis.
      const f = _pinBasisOv ? _pinBasisOv.fwd : this._motherFwd;
      const r = _pinBasisOv ? _pinBasisOv.right : this._motherRight;
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
      // Scratch-output variant; no per-debris allocation.
      orbitToSceneCartesianInto(debris.orbit, this._tmpCartPos, this._tmpCartVel);
      px = this._tmpCartPos.x;
      py = this._tmpCartPos.y;
      pz = this._tmpCartPos.z;
    }

    // Scene position for arm autopilot and external queries
    if (!debris._scenePosition) {
      debris._scenePosition = new THREE.Vector3(px, py, pz);
    } else {
      debris._scenePosition.set(px, py, pz);
    }

    // LOD: scale by distance to player (stored on debris as _lodScale for the flag overlay)
    let scale = debris.sceneSize;
    if (playerPos) {
      // Skip LOD downscaling for debris an arm is station-keeping on, or has captured (pinned to the arm during
      // REELING/HAULING/DOCKING). LOD uses playerPos (mother ship) but the ARM_PILOT camera is near the debris, so
      // with the mother far away LOD would zero the scale and hide the inspection debris / the "package" being reeled in.
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

    // Net-held catch readability: a lasso-held catch (LassoSystem, 1.5 m) or a mother-net-held catch (CaptureNet's
    // reel/berth ticks, 2.0 m) sets `_catchRenderMin` (scene units, from a rendered RADIUS in metres by
    // DebrisWireframe.scaleForRenderRadiusM). A physically tiny catch (a 0.6 m M1 fragment) renders sub-pixel and
    // "disappears" inside the net / at the nose, so clamp its apparent size up to that floor while held. Opt-in per
    // debris AND gated on _armPinned (actively held) so a stale override can never inflate a released piece, and the
    // Daughter pipeline (which never sets it) is unaffected. `pinCapturedDebris` overwrites this matrix later in the
    // same frame for a pinned catch and applies the IDENTICAL floor through `effectiveRenderScale`, so the two
    // writers cannot disagree on drawn size.
    // The floor predicate has ONE home, `catchRenderFloorScale`. This writer passes its OWN pinned local (the stricter
    // `_armPinned && _armPinPos`, which also gates the pin-position read above); the SSOT reader uses the field-only
    // default. LassoSystem routes its per-frame reel/pending pins through `pinCapturedDebris` (same-frame
    // force-write) because THIS site runs before lassoSystem.update in the frame: a bare `_armPinPos` write drew one
    // ship-step behind the net (7.7 km under the SwiftShader dt clamp). This site composes with the LOD multipliers
    // above and the reveal smoothstep below IN PLACE, deliberately not via `effectiveRenderScale`, which reads the
    // base, not this frame's LOD slot.
    scale = DebrisField.catchRenderFloorScale(debris, scale, _armPinned);

    debris._lodScale = scale;

    // Smooth reveal: scale up from 0→1 over 300ms using smoothstep
    const rp = debris._revealProgress;
    const revealScale = (rp !== undefined && rp < 1)
      ? smoothstep01(rp) // smoothstep easing
      : 1;

    // A held piece near the ship is drawn by its near-pass proxy, so the far-pass instance stays at scale 0
    // (`_lodScale` above is left as the real scale for the flag overlay). The authoritative pin
    // (`pinCapturedDebris`) re-syncs the proxy later in the frame with the same pose; this one covers a frame in which
    // no pin is called. `_nearProxy` without a pin is a stale flag: drop it. (Only a pinned piece pays for the
    // attitude here; every other piece keeps the cheap scale-0 early-out below.)
    let drawScale = scale;
    if ((_armPinned || _pinToArm || debris._motherParked) && DebrisField.carrierHidden(this, debris)) {
      // A held piece is part of the mother: hidden with her (no far instance, no near-pass proxy).
      if (debris._nearProxy && this._heldProxies) this._dropHeldProxy(debris.id);
      drawScale = 0;
    } else if (_armPinned) {
      if (this._nearSm) {
        this._tempQuat.setFromAxisAngle(debris.tumbleAxis, debris.tumbleAngle);
        if (this._syncHeldProxy(debris, null, debris._armPinPos, this._tempQuat, scale * revealScale)) drawScale = 0;
      }
    } else if (debris._nearProxy && this._heldProxies) {
      this._dropHeldProxy(debris.id);
    }

    // Perf: skip compose + setMatrixAt when debris is still invisible (scale 0) from last frame (the instance
    // buffer already holds a zero-scale matrix).
    const wasZero = debris._wasZeroScale;
    debris._wasZeroScale = (drawScale === 0);
    if (drawScale === 0 && wasZero) return;

    // Instance positions relative to floating origin (eliminates float32 jitter)
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
    DebrisField.setDrawScale(this._tempScale, drawScale * revealScale, debris);   // shortened while it is melted
    this._tempMatrix.compose(this._tempPos, this._tempQuat, this._tempScale);

    const mesh = this.instancedMeshes[debris._meshKey];
    if (mesh) {
      mesh.setMatrixAt(instanceIndex, this._tempMatrix);
    }
  }

  /**
   * @private Update background points positions.
   *
   * Cost control: only one quarter of the dots (rotating `_bgBatch`) is propagated exactly each frame, using the real
   * game time elapsed since THAT batch was last propagated (`_bgDtAcc`, so a varying / zero / hitching dt stays
   * exact). The other three quarters are carried forward every frame with their stored velocity and re-based for the
   * floating-origin move, so every dot glides each frame rather than freezing for 3 frames and jumping. Allocation-free.
   */
  _updateBackground(gameDt, playerPos) {
    if (!this.backgroundPoints) return;
    // Hidden dots (mission 1) are never read by anything but the renderer: skip the work and bank the game time.
    // `.visible` is set directly in several places, so it is read here each call.
    if (!this.backgroundPoints.visible) {
      this._bgHiddenDt = (this._bgHiddenDt || 0) + gameDt;
      return;
    }
    const posAttr = this.backgroundPoints.geometry.attributes.position;
    const arr = posAttr.array;
    const vel = this._bgVel;
    const acc = this._bgDtAcc;
    const floating = !!(Constants.FLOATING_ORIGIN_ENABLED && this._floatingOrigin);
    if (this._bgHiddenDt !== undefined) this._catchUpBackground(posAttr, vel, acc, floating);

    // Floating-origin movement since the previous call (0 with the flag off, or on the first call: the first-frame
    // re-basing in update() already made points relative).
    let ox = 0, oy = 0, oz = 0;
    let pox = 0, poy = 0, poz = 0;   // origin the stored local positions are currently relative to
    if (floating) {
      const fo = this._floatingOrigin;
      const po = this._bgPrevOrigin;
      if (this._bgPrevOriginValid) {
        pox = po.x; poy = po.y; poz = po.z;
        ox = fo.x - po.x; oy = fo.y - po.y; oz = fo.z - po.z;
      }
      po.x = fo.x; po.y = fo.y; po.z = fo.z;
      this._bgPrevOriginValid = true;
    }

    // Propagate every 4th particle each frame for performance (rotate batch)
    const batchSize = Math.ceil(BACKGROUND_COUNT / 4);
    const batchIndex = (this._bgBatch || 0);
    this._bgBatch = (batchIndex + 1) % 4;

    const start = batchIndex * batchSize;
    const end = Math.min(start + batchSize, BACKGROUND_COUNT);

    // Every batch has now waited one more frame; this batch takes what it accumulated.
    acc[0] += gameDt; acc[1] += gameDt; acc[2] += gameDt; acc[3] += gameDt;
    const batchDt = acc[batchIndex];
    acc[batchIndex] = 0;

    // Glide the 3/4 that are NOT propagated this frame, under each dot's own gravity
    // (a straight line is wrong under time warp: dtWorld is up to ~16.7 game-s/frame):
    //   a = -mu r / |r|^3        r = local + previous origin (the absolute position)
    //   j = da/dt = g (v - 3 (r.v)/|r|^2 r)        g = -mu / |r|^3
    //   local += v dt + a dt^2/2 + j dt^3/6 - originDelta;   v += a dt + j dt^2/2
    // The jerk term keeps a 16.7 game-s step (100x warp) within ~1e-3 scene units; with
    // acceleration only the error was ~10x that (measured, tmp/probe-bg-dots.mjs).
    // mu in scene units: a_scene = a_km * s, r_km = r_scene / s  =>  mu * s^3 (scene^3/s^2).
    if (vel) {
      const mu = Constants.MU_EARTH * (Constants.SCENE_SCALE * Constants.SCENE_SCALE * Constants.SCENE_SCALE);
      const hdt2 = 0.5 * gameDt * gameDt;
      const sdt3 = gameDt * gameDt * gameDt / 6;
      for (let i = 0; i < BACKGROUND_COUNT; i++) {
        if (i >= start && i < end) continue;
        const k = i * 3;
        const x = arr[k], y = arr[k + 1], z = arr[k + 2];
        const rx = x + pox, ry = y + poy, rz = z + poz;
        const r2 = rx * rx + ry * ry + rz * rz;
        const g = r2 > 0 ? -mu / (r2 * Math.sqrt(r2)) : 0;
        const ax = g * rx, ay = g * ry, az = g * rz;
        const vx = vel[k], vy = vel[k + 1], vz = vel[k + 2];
        const s3 = r2 > 0 ? 3 * (rx * vx + ry * vy + rz * vz) / r2 : 0;
        const jx = g * (vx - s3 * rx), jy = g * (vy - s3 * ry), jz = g * (vz - s3 * rz);
        arr[k] = x + vx * gameDt + ax * hdt2 + jx * sdt3 - ox;
        arr[k + 1] = y + vy * gameDt + ay * hdt2 + jy * sdt3 - oy;
        arr[k + 2] = z + vz * gameDt + az * hdt2 + jz * sdt3 - oz;
        vel[k] = vx + ax * gameDt + jx * hdt2;
        vel[k + 1] = vy + ay * gameDt + jy * hdt2;
        vel[k + 2] = vz + az * gameDt + jz * hdt2;
      }
    }

    // Mutate the pre-allocated `_tmpBgOrbit` scratch instead of a `{...orbit, semiMajorAxis: …}` spread (one alloc per batched debris).
    const bg = this._tmpBgOrbit;
    const cp = this._tmpCartPos;
    const cv = this._tmpCartVel;
    const ss = Constants.SCENE_SCALE;
    for (let i = start; i < end; i++) {
      const orbit = this._backgroundOrbits[i];

      // Propagate by the game time since this batch was last propagated
      bg.semiMajorAxis = orbit.semiMajorAxis / Constants.SCENE_SCALE;
      bg.eccentricity = orbit.eccentricity;
      bg.inclination = orbit.inclination;
      bg.raan = orbit.raan;
      bg.argPerigee = orbit.argPerigee;
      bg.trueAnomaly = orbit.trueAnomaly;
      propagateOrbit(bg, batchDt);
      orbit.trueAnomaly = bg.trueAnomaly;

      orbitToSceneCartesianInto(orbit, cp, cv);
      // cv is km/s (orbitToSceneCartesianInto converts position only): scale to scene units/s.
      if (vel) {
        vel[i * 3] = cv.x * ss;
        vel[i * 3 + 1] = cv.y * ss;
        vel[i * 3 + 2] = cv.z * ss;
      }
      // Background positions relative to floating origin
      if (floating) {
        posAttr.setXYZ(i,
          cp.x - this._floatingOrigin.x,
          cp.y - this._floatingOrigin.y,
          cp.z - this._floatingOrigin.z
        );
      } else {
        posAttr.setXYZ(i, cp.x, cp.y, cp.z);
      }
    }

    posAttr.needsUpdate = true;
  }

  /**
   * First visible update after the dots were hidden: propagate every dot by the game time since it was last
   * propagated (batch `_bgDtAcc` + banked hidden time), re-base to the floating origin, reset the glide state.
   * Leaves `_bgBatch` alone.
   */
  _catchUpBackground(posAttr, vel, acc, floating) {
    const hidden = this._bgHiddenDt;
    this._bgHiddenDt = undefined;
    const batchSize = Math.ceil(BACKGROUND_COUNT / 4);
    const bg = this._tmpBgOrbit;
    const cp = this._tmpCartPos;
    const cv = this._tmpCartVel;
    const ss = Constants.SCENE_SCALE;
    for (let b = 0; b < 4; b++) {
      const dt = acc[b] + hidden;
      acc[b] = 0;
      const end = Math.min((b + 1) * batchSize, BACKGROUND_COUNT);
      for (let i = b * batchSize; i < end; i++) {
        const orbit = this._backgroundOrbits[i];
        bg.semiMajorAxis = orbit.semiMajorAxis / ss;
        bg.eccentricity = orbit.eccentricity;
        bg.inclination = orbit.inclination;
        bg.raan = orbit.raan;
        bg.argPerigee = orbit.argPerigee;
        bg.trueAnomaly = orbit.trueAnomaly;
        propagateOrbit(bg, dt);
        orbit.trueAnomaly = bg.trueAnomaly;
        orbitToSceneCartesianInto(orbit, cp, cv);
        if (vel) {
          vel[i * 3] = cv.x * ss;
          vel[i * 3 + 1] = cv.y * ss;
          vel[i * 3 + 2] = cv.z * ss;
        }
        if (floating) {
          posAttr.setXYZ(i, cp.x - this._floatingOrigin.x, cp.y - this._floatingOrigin.y, cp.z - this._floatingOrigin.z);
        } else {
          posAttr.setXYZ(i, cp.x, cp.y, cp.z);
        }
      }
    }
    if (floating) {
      const fo = this._floatingOrigin;
      this._bgPrevOrigin.x = fo.x; this._bgPrevOrigin.y = fo.y; this._bgPrevOrigin.z = fo.z;
      this._bgPrevOriginValid = true;
    }
  }

  _onWebShotHit({ debrisId, dragMultiplier }) {
    const debris = this.debrisMap.get(debrisId);
    if (!debris || !debris.alive) return;

    debris.dragMultiplier = dragMultiplier || Constants.WEB_SHOT_DRAG_MULT;

    // tint once, not per frame
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

  /**
   * EDT_ATTRACT: nudge small debris toward the attract point via small orbital perturbations
   * (trueAnomaly + semiMajorAxis), so it drifts rather than teleports.
   * @param {object} data
   * @param {THREE.Vector3|{x:number,y:number,z:number}} data.position — attract centre (scene coords)
   * @param {number} data.radius — attract radius in km (Constants.EDT.ATTRACTION_RADIUS_KM)
   * @param {number} data.force  — base force in km/s² (Constants.EDT.ATTRACTION_FORCE)
   * @param {number} data.maxMass — max debris mass affected (Constants.EDT.MAX_ATTRACT_MASS)
   */
  _onEdtAttract({ position, radius, force, maxMass }) {
    if (!position) return;

    // km → scene units
    const radiusScene = (radius || Constants.EDT.ATTRACTION_RADIUS_KM) * Constants.SCENE_SCALE;
    const radiusSq = radiusScene * radiusScene;

    const baseForce = (force || Constants.EDT.ATTRACTION_FORCE) * Constants.SCENE_SCALE;
    const massLimit = maxMass || Constants.EDT.MAX_ATTRACT_MASS;

    for (const debris of this.debrisList) {
      if (!debris.alive || debris.mass > massLimit) continue;

      const dPos = debris._scenePosition;
      if (!dPos) continue;

      const dx = position.x - dPos.x;
      const dy = position.y - dPos.y;
      const dz = position.z - dPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq >= radiusSq || distSq < 1e-12) continue;

      const dist = Math.sqrt(distSq);

      // linear fall-off to zero at the boundary
      const strength = baseForce * (1.0 - dist / radiusScene);

      const cart = orbitToSceneCartesian(debris.orbit);
      const vx = cart.velocity.x;
      const vy = cart.velocity.y;
      const vz = cart.velocity.z;
      const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (vLen < 1e-10) continue;

      // tangential: attract direction · velocity direction, nudges trueAnomaly
      const tangDot = (dx * vx + dy * vy + dz * vz) / (dist * vLen);
      debris.orbit.trueAnomaly += strength * tangDot / debris.orbit.semiMajorAxis;

      // radial: drift semiMajorAxis toward the attract-point altitude
      const debrisR = Math.sqrt(dPos.x * dPos.x + dPos.y * dPos.y + dPos.z * dPos.z);
      const attractR = Math.sqrt(
        position.x * position.x + position.y * position.y + position.z * position.z
      );
      debris.orbit.semiMajorAxis += (attractR - debrisR) * strength * 0.1;
    }
  }


  /**
   * Write a pinned piece's orbit as "the mother's orbit, phased forward by the pin's along-track offset" — the ONE
   * co-orbital expression of the tease pin. Callers: update() every frame while `_onboardingPinned`, and
   * _clearOnboardingPin once (seamless hand-back to free propagation).
   * trueAnomaly = mother ν + fwd / a (`_onboardingPinFwd` is already scene units, so arc / radius is radians).
   * Only the along-track offset is expressible in co-orbital elements; the lateral pin component (`latM: 18`) lives in
   * `_scenePosition` only, so an orbit-derived position sits ≤ 18 m from the mesh.
   *
   * Static so test receivers that borrow `_clearOnboardingPin` onto a plain-object mock work without wiring this too.
   *
   * @param {object} debris        canonical debris record (orbit mutated in place)
   * @param {object} playerOrbit   mother's elements (scene-unit semiMajorAxis)
   * @returns {boolean} true when the orbit was written; false on a missing orbit / player orbit / non-positive
   *   semi-major axis (orbit left untouched)
   */
  static _syncPinnedOrbitToMother(debris, playerOrbit) {
    const o = debris && debris.orbit;
    if (!o || !playerOrbit || !(playerOrbit.semiMajorAxis > 0)) return false;
    o.semiMajorAxis = playerOrbit.semiMajorAxis;
    o.eccentricity  = playerOrbit.eccentricity;
    o.inclination   = playerOrbit.inclination;
    o.raan          = playerOrbit.raan;
    o.argPerigee    = playerOrbit.argPerigee;
    o.meanMotion    = playerOrbit.meanMotion;
    o.trueAnomaly   = playerOrbit.trueAnomaly
      + (debris._onboardingPinFwd || 0) / playerOrbit.semiMajorAxis;
    return true;
  }

  /**
   * Release onboarding tease pins, handing the curated piece(s) back to normal co-orbital propagation. Idempotent.
   * The orbit is re-synced to the current player orbit + the pin's along-track offset before clearing (no snap).
   *
   * update() already runs the same re-sync every frame (_syncPinnedOrbitToMother); this call still matters because it
   * covers a release before update() has seen a player orbit (headless/test receivers, save-restore), and it is the
   * only site that must read the offset BEFORE the pin fields are zeroed.
   * The lateral pin component (`latM: 18`) is DROPPED rather than converted: a catch release is invisible (the reel
   * pin takes over the same frame), but an `ONBOARDING_COMPLETE` release of a live tease piece snaps it onto the
   * boresight in one frame. Deliberate: faking a cross-track term via inclination/RAAN would be guesswork.
   * @param {number|string} [id] - release just this piece; omit to release all.
   * @private
   */
  _clearOnboardingPin(id = null) {
    const unpin = (pid) => {
      const d = this.debrisMap.get(pid);
      // Idempotent: a second release with `_onboardingPinFwd` already zeroed would seed trueAnomaly = the ship's
      // exact phase and TELEPORT the piece onto the ship.
      if (!d || !d._onboardingPinned) return;
      // `_lastPlayerOrbit` is cached by update() so event-driven releases still see the CURRENT phase; the helper
      // no-ops on a missing/degenerate orbit.
      DebrisField._syncPinnedOrbitToMother(d, this._lastPlayerOrbit);
      d._onboardingPinned = false; d._onboardingPinFwd = 0; d._onboardingPinLat = 0;
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
   * Seat ONE welcome piece on its cone-fan slot relative to the mother: the WELCOME_FIELD row's metres (mother-local
   * frame) become orbital elements. Shared by _spawnWelcomeField and the re-seat net (_reseatDriftedWelcome). Reads
   * nothing from the piece's current orbit (only its sticky fwd roll), so it is safe to call again with the CURRENT
   * player orbit to re-seat.
   *
   * Frame (same basis as the pin in update()): fwd = along-track / prograde, right = fwd × radial, up = radial (away
   * from Earth). Metres → radians of arc via METRE_SCENE / a. Signs are pinned by the projection test in
   * test-WelcomeField (right = +latM, up = +radM at spawn).
   *
   * PINNED rows (spec.pin): the orbit is only the co-orbital FALLBACK (the authoritative position is the local-frame
   * _scenePosition pin): mother's elements copied, fwdM laid along-track, no frame comp.
   *
   * FREE rows keep the mother's SEMI-MAJOR AXIS (same period) and build all three offsets period-preserving, so the
   * fan breathes but never drifts:
   *   fwd   — Δν = fwd·METRE_SCENE/a, fwd rolled once inside [fwdMinM, fwdMaxM] and remembered on the piece
   *           (_welcomeFwdM) so a re-seat snaps it back to ITS slot (a stale roll outside the band re-rolls);
   *           minus frameCompRad (the spawn's one-frame pre-compensation); minus ΔΩ·cos i — a node rotation moves
   *           the piece along-track too (without this the 5° start put #7 ≈ 1.9 km off its band).
   *   right — plane tilt about the mother's argument of latitude u0 = ω + ν: Δi = L·sin u0, ΔΩ = −L·cos u0 / sin i,
   *           L = latM·METRE_SCENE/a, giving cross-track w(u) = L·cos(u − u0): exact at spawn, reversing sign every
   *           half orbit, never growing. |sin i| < 0.01 → ΔΩ = 0 (guard only; starts run 5°–97.5°).
   *   up    — eccentricity-VECTOR delta at the same a: with û = (cos u, sin u) in the in-plane node frame and
   *           ê_m = e_m·(cos ω_m, sin ω_m), ê_p = ê_m − (Δr/a)·û, so r_p − r_m = Δr·cos(u − u_p). Adding to the
   *           mother's vector keeps her own ±672 m radial oscillation (e = 0.0001) common-mode; the offset sloshes
   *           along-track by ≤ 2·Δr over the orbit (≤ 130 m for #7).
   *
   * @param {object} debris        the piece — its `orbit` is overwritten
   * @param {object} spec          the WELCOME_FIELD row
   * @param {object} playerOrbit   mother's elements (semiMajorAxis in scene units)
   * @param {number} [frameCompRad=0] along-track pre-compensation (rad): n×gameDt for the frame in which the
   *                               propagation loop steps the piece once more; spawn and re-seat both pass it
   * @returns {{ fwdM: number, latM: number, radM: number }} the realised local-frame offsets in metres
   *          (fwdM is the roll actually used)
   * @private
   */
  _placeWelcomePiece(debris, spec, playerOrbit, frameCompRad = 0) {
    const o = debris.orbit;
    const aScene = playerOrbit.semiMajorAxis || 1;
    const radPerM = METRE_SCENE / aScene; // radians of arc per metre at radius a

    // Co-orbital baseline: same semi-major axis (same period; never touched below), mother's plane and shape.
    o.semiMajorAxis = playerOrbit.semiMajorAxis;
    o.eccentricity = playerOrbit.eccentricity;
    o.inclination = playerOrbit.inclination;
    o.raan = playerOrbit.raan;
    o.argPerigee = playerOrbit.argPerigee;
    o.meanMotion = playerOrbit.meanMotion;

    if (spec.pin) {
      const fwdM = spec.fwdM || 0;
      o.trueAnomaly = playerOrbit.trueAnomaly + fwdM * radPerM;
      return { fwdM, latM: spec.latM || 0, radM: 0 };
    }

    // fwd: one roll inside the row band, sticky per piece.
    const fMin = Number.isFinite(spec.fwdMinM) ? spec.fwdMinM : 0;
    const fMax = Number.isFinite(spec.fwdMaxM) ? spec.fwdMaxM : fMin;
    let fwdM = debris._welcomeFwdM;
    if (!(Number.isFinite(fwdM) && fwdM >= fMin && fwdM <= fMax)) {
      fwdM = fMin + Math.random() * (fMax - fMin);
      debris._welcomeFwdM = fwdM;
    }
    const latM = spec.latM || 0;
    const radM = spec.radM || 0;

    // right: plane tilt (Δi, ΔΩ) about the mother's argument of latitude.
    const incM = playerOrbit.inclination;
    const u0 = playerOrbit.argPerigee + playerOrbit.trueAnomaly;
    const L = latM * radPerM;
    const sinI = Math.sin(incM);
    const dInc = L * Math.sin(u0);
    const dRaan = (Math.abs(sinI) < 0.01) ? 0 : -L * Math.cos(u0) / sinI;
    o.inclination = incM + dInc;
    o.raan = playerOrbit.raan + dRaan;

    // Along-track: fwd arc, the spawn's one-frame pre-compensation, and the node rotation's along-track side effect
    // (ΔΩ·cos i) taken back out.
    const uP = u0 + fwdM * radPerM - frameCompRad - dRaan * Math.cos(incM);

    // up: eccentricity-vector delta at the same a (ν is measured from the piece's OWN perigee: ν_p = u_p − ω_p).
    const eM = playerOrbit.eccentricity || 0;
    const wM = playerOrbit.argPerigee;
    if (radM === 0) {
      o.trueAnomaly = uP - wM; // e-vector untouched (#3 shares the mother's exactly)
    } else {
      const dr = radM * radPerM;
      const ex = eM * Math.cos(wM) - dr * Math.cos(uP);
      const ey = eM * Math.sin(wM) - dr * Math.sin(uP);
      const eP = Math.hypot(ex, ey);
      // ω_p stays on the mother's branch (ω_m + signed, wrapped delta) so a vanishing delta returns exactly ω_m; a
      // circular result keeps ω_m as its reference direction.
      let wP = wM;
      if (eP > 1e-12) {
        const dW = Math.atan2(ey, ex) - wM;
        wP = wM + Math.atan2(Math.sin(dW), Math.cos(dW));
      }
      o.eccentricity = eP;
      o.argPerigee = wP;
      o.trueAnomaly = uP - wP;
    }
    return { fwdM, latM, radM };
  }

  /** Give the field its registry: the mission-start spawn asks it which field she is at and which pieces are left. Null = welcome field. */
  setFieldSource(source) { this._fieldSource = source || null; }

  /** Seeded roll in [0, 1) for a field's row (mulberry32 on a mix of seed and row): the same field lays free rows out the same way. */
  static fieldRoll(seed, row) {
    let t = (Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) + Math.imul((row | 0) + 1, 0xc2b2ae35)) >>> 0;
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Resolved spec of one row of a HIGH field: a `Constants.HIGH_FIELD` row with this field's rolls applied, in the shape of a
   * WELCOME_FIELD row. ONE roll (`fieldRoll(seed, row + 100)`, independent of the along-track roll `fieldRoll(seed, row)`)
   * picks mass and size inside the row's ranges, so a heavier piece is a bigger one. `high: true` keeps the 10 kg ceiling of
   * the mission-1 cluster off it.
   * @param {number} seed the field's seed @param {number} row the row index
   * @returns {object|null} null for a row the table does not have
   */
  static highFieldSpec(seed, row) {
    const r = Array.isArray(Constants.HIGH_FIELD) ? Constants.HIGH_FIELD[row] : null;
    if (!r) return null;
    const u = DebrisField.fieldRoll(seed, row + 100);
    const massKg = r.massMin + u * (r.massMax - r.massMin);
    const sizeM = r.sizeMin + u * (r.sizeMax - r.sizeMin);
    return {
      high: true, name: r.name, types: r.types, material: r.material, sizeM, massMin: massKg, massMax: massKg,
      tumbleDegS: r.tumbleDegS, fwdMinM: r.fwdMinM, fwdMaxM: r.fwdMaxM, latM: r.latM || 0, radM: r.radM || 0,
      // who owns the piece and its tumbling area (a copy, so no piece shares the table's object); only a HIGH_FIELD row has them
      owner: r.owner ? { ...r.owner } : null, areaM2: r.areaM2,
    };
  }

  /**
   * One of a field's own seeded streams for the small-piece group and mission satellite: `seed` (the field's), `variant`
   * (0 = a low field's own group, 1 = the group a mission adds, 2 = the satellite), `k` (which piece/use) mixed into a
   * mulberry32 seed. A FRESH generator every call, so a piece resolves to the same spec in any order; never touches Math.random.
   * @param {number} seed @param {number} variant @param {number} k @returns {() => number}
   */
  static _groupStream(seed, variant, k) {
    const x = (Constants.SMALL_GROUP.SEED_XOR | 0) ^ (seed | 0);
    return mulberry32((Math.imul(x, 0x9E3779B1) + Math.imul((variant | 0) + 1, 0x85EBCA6B) + Math.imul((k | 0) + 1, 0xC2B2AE35)) >>> 0);
  }

  /** The group's centre: along-track and cross-track metres ahead of her (one roll per field and variant). */
  static _groupCentre(seed, variant) {
    const G = Constants.SMALL_GROUP;
    const r = DebrisField._groupStream(seed, variant, 9999);
    const a = r(), b = r();
    return variant === 0
      ? { fwdM: G.OWN_FWD_MIN_M + a * (G.OWN_FWD_MAX_M - G.OWN_FWD_MIN_M), latM: (b - 0.5) * G.OWN_LAT_M }
      : { fwdM: G.EXTRA_FWD_MIN_M + a * (G.EXTRA_FWD_MAX_M - G.EXTRA_FWD_MIN_M), latM: G.EXTRA_LAT_MIN_M + b * (G.EXTRA_LAT_MAX_M - G.EXTRA_LAT_MIN_M) };
  }

  /**
   * DECISIONS §38 rows 3 and 4: the resolved spec of piece `i` of a field's small-piece group, in the shape of a WELCOME_FIELD
   * row. `variant` 0 is a low field's own group, 1 the group a mission adds. The piece sits in a flat disc
   * (SMALL_GROUP.SPREAD_R_M) around the group's centre: along-track and cross-track offsets, radM 0, so every pair stays
   * within 2 x SPREAD_R_M (a radial offset would slosh along-track by twice its size). Size uniform in SIZE_MIN_M..SIZE_MAX_M,
   * mass the real breakup-model chain, a slow tumble, all from the piece's own stream. `rng` is that stream for the SPAWN
   * (mass roll, salvage): `_spawnWelcomeField` uses it instead of Math.random.
   * @param {number} seed the field's seed @param {number} variant 0 or 1 @param {number} i the piece, 0-based
   * @returns {object|null} null past the group's count (`Constants.smallGroupCount`)
   */
  static groupSpec(seed, variant, i) {
    const G = Constants.SMALL_GROUP;
    const count = Constants.smallGroupCount(seed, variant);
    if (!Number.isInteger(i) || i < 0 || i >= count) return null;
    const c = DebrisField._groupCentre(seed, variant);
    const r = DebrisField._groupStream(seed, variant, i);
    const rad = G.SPREAD_R_M * Math.sqrt(r());
    const th = r() * Math.PI * 2;
    const sizeM = G.SIZE_MIN_M + r() * (G.SIZE_MAX_M - G.SIZE_MIN_M);
    const ML = (Constants.DEBRIS && Constants.DEBRIS.MASS_LAW) || { AREA_COEF: 0.556945, AREA_EXP: 2.0047, AM_LOG10_MEAN: -0.9, AM_LOG10_SIGMA: 0.45 };
    const massKg = Math.max(0.02, Math.min(5, sampleSbmMassKg(sizeM, r(), r(), ML)));
    const tumbleDegS = G.TUMBLE_MIN_DEG_S + r() * (G.TUMBLE_MAX_DEG_S - G.TUMBLE_MIN_DEG_S);
    const fwd = c.fwdM + rad * Math.cos(th);
    return {
      types: ['fragment'], sizeM, massMin: massKg, massMax: massKg, tumbleDegS, own: true, group: variant,
      fwdMinM: fwd, fwdMaxM: fwd, latM: c.latM + rad * Math.sin(th), radM: 0,
      rng: DebrisField._groupStream(seed, variant, 5000 + i),
    };
  }

  /**
   * DECISIONS §38 row 4: the resolved spec of a field's mission satellite: a dead satellite (the mission pool's type) of
   * 1.0-4.5 m and 50-500 kg, ONE roll for both so a heavier one is a bigger one, FWD_AFTER_GROUP_* beyond the group's centre
   * and LAT_BESIDE_M to the other side of her track (about 70 m from the group). `variant`: which group it sits by.
   * @param {number} seed the field's seed @param {number} variant 0 or 1 @returns {object}
   */
  static missionSatSpec(seed, variant) {
    const S = Constants.MISSION_SAT;
    const c = DebrisField._groupCentre(seed, variant);
    const r = DebrisField._groupStream(seed, 2, variant);
    const u = r();
    const material = S.MATERIALS[Math.min(S.MATERIALS.length - 1, Math.floor(r() * S.MATERIALS.length))];
    const tumbleDegS = S.TUMBLE_MIN_DEG_S + r() * (S.TUMBLE_MAX_DEG_S - S.TUMBLE_MIN_DEG_S);
    const fwd = c.fwdM + S.FWD_AFTER_GROUP_MIN_M + r() * (S.FWD_AFTER_GROUP_MAX_M - S.FWD_AFTER_GROUP_MIN_M);
    const massKg = S.MASS_MIN_KG + u * (S.MASS_MAX_KG - S.MASS_MIN_KG);
    return {
      high: true, own: true, missionSat: true, name: 'Dead satellite', types: ['defunctSat'], material,
      sizeM: S.SIZE_MIN_M + u * (S.SIZE_MAX_M - S.SIZE_MIN_M), massMin: massKg, massMax: massKg, tumbleDegS,
      fwdMinM: fwd, fwdMaxM: fwd, latM: c.latM - S.LAT_BESIDE_M, radM: 0,
      rng: DebrisField._groupStream(seed, 2, 5000 + variant),
    };
  }

  /** One of a pair's own seeded streams (PAIR_FIELDS.SEED_XOR): `p` the pair, `m` 0/1 the member, 9 the pair's shared
   *  rolls. Fresh generator each call. */
  static _pairStream(seed, p, m) {
    const x = (Constants.PAIR_FIELDS.SEED_XOR | 0) ^ (seed | 0);
    return mulberry32((Math.imul(x, 0x9E3779B1) + Math.imul((p | 0) + 1, 0x85EBCA6B) + Math.imul((m | 0) + 1, 0xC2B2AE35)) >>> 0);
  }

  /** Rows the pairs of a field take (PAIR_FIELDS.PAIRS x 2): rows ROW0 .. ROW0 + this - 1. @returns {number} */
  static pairRowCount() { return Constants.PAIR_FIELDS.PAIRS * 2; }

  /** @param {number} row @returns {boolean} the row is one of a field's paired pieces */
  static isPairRow(row) {
    const P = Constants.PAIR_FIELDS;
    return Number.isInteger(row) && row >= P.ROW0 && row < P.ROW0 + DebrisField.pairRowCount();
  }

  /**
   * DECISIONS §38 row 7 (`Constants.PAIR_FIELDS`): the resolved spec of paired piece `k` of a field (k = row - ROW0, pair
   * `k >> 1`, member `k & 1`), in the shape of a WELCOME_FIELD row. Pair p is built for the opposite struts of `KINDS[p]` at
   * ONE strut angle alpha (the pair's roll): the piece sits on its strut's launch line from the strut's tip, `range` m out, in
   * the frame of her arrival (ship x = left = -latM, y = up = radM, z = ahead = fwdM), so both lines hit with no turn. Own
   * seeded stream; size from the kind's band, mass the group's chain (<= 5 kg), a slow tumble. Null for a k outside the pairs.
   * `attitude` is her attitude relative to the prograde frame (`attitudeOf`): the launch point in HER frame is turned into the
   * prograde frame before it becomes fwd / lat / rad, so the pair fits however she arrives. Null = nose forward, upright.
   * @param {number} seed the field's seed @param {number} k the piece, 0-based
   * @param {{x: number, y: number, z: number, w: number}|null} [attitude] @returns {object|null}
   */
  static pairSpec(seed, k, attitude = null) {
    const P = Constants.PAIR_FIELDS;
    if (!Number.isInteger(k) || k < 0 || k >= DebrisField.pairRowCount()) return null;
    const p = k >> 1, m = k & 1;
    const kind = P.KINDS[p % P.KINDS.length];
    const shared = DebrisField._pairStream(seed, p, 9);
    const alphaDeg = kind.alphaMin + shared() * (kind.alphaMax - kind.alphaMin);
    const rangeM = kind.rangeMin + shared() * (kind.rangeMax - kind.rangeMin);
    const r = DebrisField._pairStream(seed, p, m);
    const rangeMemberM = rangeM * (1 + (r() * 2 - 1) * P.RANGE_SPREAD);
    const sizeM = kind.sizeMin + r() * (kind.sizeMax - kind.sizeMin);
    const G = Constants.SMALL_GROUP;
    const ML = (Constants.DEBRIS && Constants.DEBRIS.MASS_LAW) || { AREA_COEF: 0.556945, AREA_EXP: 2.0047, AM_LOG10_MEAN: -0.9, AM_LOG10_SIGMA: 0.45 };
    const massKg = Math.max(0.02, Math.min(5, sampleSbmMassKg(sizeM, r(), r(), ML)));
    const tumbleDegS = G.TUMBLE_MIN_DEG_S + r() * (G.TUMBLE_MAX_DEG_S - G.TUMBLE_MIN_DEG_S);
    const pos = DebrisField.pairLaunchPoint(kind.struts[m], alphaDeg, rangeMemberM);
    if (attitude) {
      const v = new THREE.Vector3(pos.x, pos.y, pos.z).applyQuaternion(_pairQ.set(attitude.x, attitude.y, attitude.z, attitude.w).normalize());
      pos.x = v.x; pos.y = v.y; pos.z = v.z;
    }
    return {
      types: ['fragment'], sizeM, massMin: massKg, massMax: massKg, tumbleDegS, own: true, pair: p,
      fwdMinM: pos.z, fwdMaxM: pos.z, latM: -pos.x, radM: pos.y,
      pairAlphaDeg: alphaDeg, pairStrut: kind.struts[m], pairRangeM: rangeMemberM,
      rng: DebrisField._pairStream(seed, p, 5000 + m),
    };
  }

  /**
   * Her attitude relative to the prograde frame (prograde^-1 * quaternion). Read from the live quaternion, not `_manualRotation`
   * (stale while the autopilot or an aim holds the nose). Null for no ship, or a mock without a quaternion (pairs then lay out
   * nose forward, upright).
   * @param {object|null} player the PlayerSatellite @returns {THREE.Quaternion|null}
   */
  static attitudeOf(player) {
    if (!player || !player.quaternion) return null;
    const pg = typeof player._progradeQuat === 'function' ? player._progradeQuat(new THREE.Quaternion()) : null;
    if (pg) return pg.invert().multiply(player.quaternion).normalize();
    return player._manualRotation ? player._manualRotation.clone() : null;
  }

  /** The ship the attitude is read from: drag source and near-field player are main.js's wiring of her, the registry's player is the rigs'. */
  _attitudeSource() {
    const has = (p) => p && p.quaternion;
    if (has(this._motherDragSource)) return this._motherDragSource;
    if (has(this._nearPlayer)) return this._nearPlayer;
    const rp = this._fieldSource && this._fieldSource._player;
    return has(rp) ? rp : null;
  }

  /**
   * The point `rangeM` m out along the launch line of strut `strut` at strut angle `alphaDeg`, from the strut's tip, in the ship
   * frame (x left, y up, z ahead; metres). Tip = ((hingeR + L sin a) cos az, (hingeR + L sin a) sin az, hingeZ - L cos a),
   * direction = (sin a cos az, sin a sin az, -cos a): the same lines as `strutTipMeters` and `strutLocalDirection`
   * (test-PairFields pins it).
   * @param {number} strut 0-3 @param {number} alphaDeg @param {number} rangeM @returns {{x: number, y: number, z: number}}
   */
  static pairLaunchPoint(strut, alphaDeg, rangeM) {
    const P = Constants.PAIR_FIELDS;
    const az = degToRad(Constants.ARM_LADDER.Y0_QUAD.azimuths[strut]);
    const a = degToRad(alphaDeg);
    const sA = Math.sin(a), cA = Math.cos(a);
    const rho = P.HINGE_R_M + Constants.OCTOPUS_V5.STRUT_LENGTH * sA;
    return {
      x: rho * Math.cos(az) + rangeM * sA * Math.cos(az),
      y: rho * Math.sin(az) + rangeM * sA * Math.sin(az),
      z: P.HINGE_Z_M - Constants.OCTOPUS_V5.STRUT_LENGTH * cA - rangeM * cA,
    };
  }

  /**
   * The spec of row `row` of a field laid out as `layout`: 'welcome' (WELCOME_FIELD, the start field), 'high' (HIGH_FIELD,
   * rolled with the field's seed) or 'group' (a low field's own small-piece group); a row of EXTRA_ROW0 or more is a mission
   * extra on any layout: EXTRA_ROW0 + i the i-th piece of the extra group, SAT_ROW the extra satellite. Null for a row the
   * field does not have.
   * On a 'group' layout the satellite sits by the group that is THERE NOW. `rows` (the field's rows in play, optional) says
   * which: the field's own group while any of its rows is left, else the extra group a mission added (rows 200+). Without
   * `rows` it is the own group's spot.
   * `attitude` is her attitude relative to the prograde frame at the spawn, read by the pair rows only (`pairSpec`).
   * @param {string} layout @param {number} seed @param {number} row @param {number[]} [rows] @param {object|null} [attitude] @returns {object|null}
   */
  static fieldRowSpec(layout, seed, row, rows = null, attitude = null) {
    const G = Constants.SMALL_GROUP;
    if (!Number.isInteger(row) || row < 0) return null;
    if (DebrisField.isPairRow(row)) return DebrisField.pairSpec(seed, row - Constants.PAIR_FIELDS.ROW0, attitude);
    if (row === G.SAT_ROW) {
      let variant = layout === 'group' ? 0 : 1;
      if (layout === 'group' && Array.isArray(rows) && !rows.some((r) => r < G.EXTRA_ROW0) && rows.some((r) => r >= G.EXTRA_ROW0 && r < G.SAT_ROW)) variant = 1;
      return DebrisField.missionSatSpec(seed, variant);
    }
    if (row >= G.EXTRA_ROW0) return DebrisField.groupSpec(seed, 1, row - G.EXTRA_ROW0);
    if (layout === 'high') return DebrisField.highFieldSpec(seed, row);
    if (layout === 'group') return DebrisField.groupSpec(seed, 0, row);
    return WELCOME_FIELD[row] || null;
  }

  /**
   * Draw a drag sail on a piece that was just let go (`GameFlowManager._letGoBig`). The sail is its own set of three.js groups
   * (`DragSailMesh`) in this field's group, so it shares the floating origin, and follows the piece through `update`. The piece
   * carries `_sail`; a removed or dead piece takes it away.
   * @param {object} d the piece (any reference: the field's own body is looked up by id) @returns {boolean} a sail was added
   */
  attachSail(d) {
    if (!d || d.id == null) return false;
    const canon = this.debrisMap.get(d.id) || d;
    canon._sail = true;
    if (!this._sails) this._sails = new DragSailSet(this.group);
    return this._sails.add(canon);
  }

  /**
   * Remove every disposed piece that still floats (`_disposed`: a let-go big piece, with or without a drag sail, or one that
   * broke loose from its rack). Called at her departure (`storeFieldPieces`); a new game or continue after game over reaches it
   * the same way (their re-layout stores the field), so no let-go piece floats into the next game (PD4c pins it).
   * @returns {number} how many left
   */
  _removeDisposedPieces() {
    let n = 0;
    for (const d of this.debrisList.slice()) {
      if (d._disposed === true && d.alive) { this.removeDebris(d.id); n++; }
    }
    return n;
  }

  /**
   * She is leaving a field (or laying it out again on a Stay): every still-free piece is taken out of play (not alive, not
   * tracked, instance scaled to nothing) and kept by (field, row) so the next visit puts the SAME piece back. Stored, not
   * simulated. A held piece (a catch on her nose, a rack, a tip, a net, a daughter's hand) is not free: it rides with her and is
   * credited later, still tagged with its field. No event is emitted: nothing was caught, so the registry keeps the row.
   * @returns {number} how many pieces were stored
   */
  storeFieldPieces() {
    let stored = 0;
    // Disposed pieces leave at departure. Before the bag split below, so a disposed free bag is removed whole.
    this._removeDisposedPieces();
    // A bag nobody holds any more (let go, strain slip, snapped tether) has no field tag of its own; its members' rows are
    // still open, so a return visit would lay them out again while the bag floated and paid them twice. Split it back first:
    // members come out tagged and alive and fall into the loop below; the bag is gone.
    for (const d of this.debrisList.slice()) {
      if (d.isBag !== true || !d.alive) continue;
      if (d._captured || d._armPinned || d._capturedByArm || d._motherParked || d._netted || d._committedNetArmId != null) continue;
      this._splitFreeBag(d);
    }
    for (const d of this.debrisList) {
      if (!d.alive || d.fieldId == null) continue;
      if (d._captured || d._armPinned || d._capturedByArm || d._motherParked || d._netted || d._committedNetArmId != null) continue;
      if (d._onboardingPinned) this._clearOnboardingPin(d.id);
      if (this._heldProxies && this._heldProxies.has(d.id)) this._dropHeldProxy(d.id);
      d.alive = false;
      d.tracked = false;
      d._fieldStored = true;
      const lookup = this._instanceLookup && this._instanceLookup.get(d.id);
      if (lookup) {
        const mesh = this.instancedMeshes[lookup.meshKey];
        if (mesh) {
          this._tempMatrix.makeScale(0, 0, 0);
          mesh.setMatrixAt(lookup.instanceIndex, this._tempMatrix);
          mesh.instanceMatrix.needsUpdate = true;
        }
      }
      this._fieldStored.set(`${d.fieldId}|${d.fieldRow}`, d);
      stored++;
    }
    return stored;
  }

  /**
   * Undo `mergeIntoBag` for a bag nobody holds: every member not yet credited is alive again in its field row (the tag parked
   * at the merge is restored) at its old offset round the bag's centre on the bag's orbit; the bag leaves play (mesh freed by
   * `removeDebris`) and keeps no members, so nothing can pay them through it.
   * @param {object} bag @returns {number} how many members were restored
   */
  _splitFreeBag(bag) {
    const members = (bag.bagMembers || []).map((m) => m.piece).filter((p) => p && !p._credited && p.isBag !== true);
    bag.bagMembers = [];
    this.removeDebris(bag.id);                  // the bag has no field tag: the registry hears the removal and keeps every row
    for (const p of members) {
      p.alive = true;
      p.tracked = this._trackedFor(p);
      p.fieldId = p._bagFieldId ?? null;
      p.fieldRow = p._bagFieldRow ?? null;
      p._inBag = false;
      p._bagId = null;
      p._bagFieldId = null;
      p._bagFieldRow = null;
      if (bag.orbit) p.orbit = { ...bag.orbit };
      if (bag._scenePosition) {
        const off = p._bagOffsetScene;
        const q = new THREE.Vector3(bag._scenePosition.x + (off ? off.x : 0), bag._scenePosition.y + (off ? off.y : 0), bag._scenePosition.z + (off ? off.z : 0));
        if (p._scenePosition && typeof p._scenePosition.copy === 'function') p._scenePosition.copy(q); else p._scenePosition = q;
      }
      p._bagOffsetScene = null;
    }
    return members.length;
  }

  /** The piece stored for (field, row), taken out of the store; null when there is none (or it is back in play). */
  _takeStoredFieldPiece(fieldId, row) {
    const key = `${fieldId}|${row}`;
    const d = this._fieldStored.get(key);
    if (!d) return null;
    this._fieldStored.delete(key);
    return d.alive ? null : d;
  }

  /** A new run: stored pieces go back to the pool (alive, ordinary debris) and no piece keeps a field tag (a stale tag
   *  would take a row out of a field it never belonged to). */
  _reviveStoredFieldPieces() {
    for (const d of this._fieldStored.values()) {
      if (d._heavySpare) continue;              // a heavy spare is never ordinary debris: parked again below
      d.alive = true;
      d.tracked = this._trackedFor(d);
      d._fieldStored = false;
    }
    this._fieldStored.clear();
    for (const d of this.debrisList) {
      if (d._heavySpare) { this._parkHeavySpare(d); continue; }   // stored, claimed in the sky or caught: back in the pool, claimable again
      if (d.fieldId != null) { d.fieldId = null; d.fieldRow = null; }
    }
  }

  /**
   * Spawn welcome field debris near the player: repositions far-away debris to nearby co-orbital positions.
   * @param {object} playerOrbit - Player orbital elements
   * @private
   */
  _spawnWelcomeField(playerOrbit) {
    const profile = this._currentMissionProfile || Constants.MISSIONS.PROFILES[0];

    // WELCOME_FIELD is the player's *local* learning cluster: a fixed set of 7 hand-crafted specs, always spawned in full.
    // `profile.clusters` only controls the broader orbital cluster regions (handled elsewhere), NOT this group.
    // FIELDS_BY_HEIGHT: with the flag on, the registry names the field she is at and its uncaught rows; THOSE rows are laid
    // out (same placement, same tags), the field she left is stored, and a row's piece comes back from the store on a
    // revisit. Flag off (or no registry / test mock): `fieldPlan` is null and this is the plain seven.
    const fieldPlan = this._fieldSource && typeof this._fieldSource.spawnPlan === 'function' ? this._fieldSource.spawnPlan() : null;
    // A HIGH field (`fieldPlan.kind === 'high'`) indexes the HIGH_FIELD rows, resolved with the field's seed
    // (`highFieldSpec`); its pieces are parked heavy spares claimed below.
    const isHigh = !!fieldPlan && fieldPlan.kind === 'high';
    // Which table the rows index: 'welcome', 'high' or 'group' (a low non-start field's own small-piece group); a plan with
    // no `layout` (a test stub) is read from its kind. Rows from SMALL_GROUP.EXTRA_ROW0 up are mission extras, resolved by
    // `DebrisField.fieldRowSpec` on any layout.
    const layout = fieldPlan ? (fieldPlan.layout || (isHigh ? 'high' : 'welcome')) : 'welcome';
    const attitude = DebrisField.attitudeOf((this._attitudeSource || DebrisField.prototype._attitudeSource).call(this));   // the pairs fit her attitude
    const specOfRow = (r) => DebrisField.fieldRowSpec(layout, fieldPlan.seed, r, fieldPlan.rows, attitude);
    let fieldRows = null;                       // the WELCOME_FIELD (or HIGH_FIELD) row index of each piece to lay out (null = all, in order)
    if (fieldPlan) {
      this.storeFieldPieces();                  // anything of hers still free goes back into store first (a Stay re-seats it)
      fieldRows = fieldPlan.rows.filter((r) => Number.isInteger(r) && specOfRow(r));
      if (Number.isInteger(fieldPlan.missionNumber) && fieldPlan.missionNumber > 0) this._currentMissionNumber = fieldPlan.missionNumber;
    }
    // Shards run on the size law of the mission being laid out (mission 1: today's; mission 2 on: 2-50 cm).
    // Tolerant of mock receivers (tests bind only _spawnWelcomeField onto a plain object).
    (this._applyShardLaw || DebrisField.prototype._applyShardLaw).call(this, this._currentMissionNumber || 1);
    // Map off (no registry): from mission SMALL_GROUP.FROM_MISSION on, the seven welcome rows are followed by the mission
    // extras: a group unless an uncaught one is still out, a satellite likewise (map-on keeps the same rule in FieldRegistry).
    let offRows = null;
    const missionNo = this._currentMissionNumber || 1;
    if (!fieldPlan && missionNo >= Math.min(Constants.SMALL_GROUP.FROM_MISSION, Constants.PAIR_FIELDS.FROM_MISSION)) {
      const seed = this._fieldSeed;
      const G = Constants.SMALL_GROUP;
      const rows = WELCOME_FIELD.map((_, i) => i);
      const has = (kind) => this.debrisList.some((d) => d.alive && d._extraKind === kind &&
        !(d._captured || d._armPinned || d._capturedByArm || d._motherParked));
      if (missionNo >= G.FROM_MISSION && !has('group')) for (let i = 0, n = Constants.smallGroupCount(seed, 1); i < n; i++) rows.push(G.EXTRA_ROW0 + i);
      if (missionNo >= G.FROM_MISSION && !has('sat')) {
        if ((this.hasFreeMissionBody || DebrisField.prototype.hasFreeMissionBody).call(this)) rows.push(G.SAT_ROW);
        else console.warn('[DebrisField] no mission-satellite body is free: this mission lays out no satellite');
      }
      // owner 2026-10-25 (PAIR_FIELDS): from mission 2 on, the pairs too, unless an uncaught pair is still out
      if (missionNo >= Constants.PAIR_FIELDS.FROM_MISSION && !has('pair')) {
        for (let i = 0, n = DebrisField.pairRowCount(); i < n; i++) rows.push(Constants.PAIR_FIELDS.ROW0 + i);
      }
      if (rows.length > WELCOME_FIELD.length) offRows = rows;
    }
    const fieldToSpawn = fieldRows
      ? fieldRows.map((r) => specOfRow(r))
      : offRows ? offRows.map((r) => DebrisField.fieldRowSpec('welcome', this._fieldSeed, r, null, attitude)) : WELCOME_FIELD;
    const rowOf = (i) => (fieldRows ? fieldRows[i] : offRows ? offRows[i] : i);   // the row spec i of `fieldToSpawn` came from

    // Candidates: alive debris not already special-tagged, preferring other orbit bands (farThreshold ≈ 3 km altitude diff)
    // so coincidentally-nearby objects aren't disrupted. The spawn reuses a debris' existing instanced-mesh slot (it does
    // NOT rebind geometry), so the RENDERED shape AND material/colour come from WHICH candidate is selected
    // (_meshKey = type:material[:id%N]):
    //   - a row wanting gold MLI foil (#2) or a blue solar-cell panel shard (#3/#5) must match a candidate already in that
    //     material slot + flat plate variant (spec.appearMaterial/appearPlate);
    //   - row #7 (cubesat) must match a `cubesat`-type candidate so it renders as a small whole microsat.
    const farThreshold = 0.03; // ~3km in scene units
    const N = Constants.DEBRIS_FRAGMENT_VARIANTS || 7;
    // Far-band buckets by visual class: `fragment` = irregular junk chunk (the dominant look), `cubesat` = small whole
    // microsat (row #7), `farOther` (defunctSat/rocketBody/…) reads as an intact high-value body, wrong for a junk
    // cluster, so last-resort only. Near-band debris is the final fallback.
    // NO early-break: scan the whole alive list once (≤800, one-time) so gold-MLI / solar-cell plate fragments and
    // cubesats LATER in debrisList stay reachable (a first-7 cut gave ≈12% chance of a gold plate and starved the matcher).
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

    // Score the still-unused far candidates per spec (best wins; ties keep placed order). Fragments + cubesats are scanned
    // together so a desired-type match can win across buckets; then fall back far fragment → far cubesat → far other →
    // near, so the spawn never under-fills:
    //   +4  type match (shape dominates, so fragment rows stay off cubesats and #7 off fragments when a cubesat exists)
    //   +2  material match (spec.appearMaterial → rendered colour)
    //   +1  plate-variant match (spec.appearPlate → flat panel-shard look)
    const usedIds = new Set();
    const fragVariant = (d) => (typeof d.id === 'number' ? (d.id >>> 0) % N : 0);
    const isPlate = (d) => DebrisWireframe.isPlateVariant(fragVariant(d));
    // Desired type = first entry of spec.types (fragment for #1–#6, cubesat for #7).
    const desiredType = (spec) => (Array.isArray(spec.types) && spec.types.length ? spec.types[0] : null);
    const scorePool = [...farFragments, ...farCubesats];
    const pickFar = (spec) => {
      const wantType = desiredType(spec);
      let best = null;
      let bestScore = -1;
      // A paired piece takes its body from the FAR END of the pool (earlier rows take the front), so the bodies a
      // mission's welcome rows get, and the ids the next mission's rows get, do not move.
      const rev = Number.isInteger(spec.pair);
      for (let k = 0; k < scorePool.length; k++) {
        const d = scorePool[rev ? scorePool.length - 1 - k : k];
        if (usedIds.has(d.id)) continue;
        let score = 0;
        if (wantType && d.type === wantType) score += 4;
        if (spec.appearMaterial && d.material === spec.appearMaterial) score += 2;
        // plate test only meaningful for fragment variants
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
      // pickFar scans the combined scorePool and returns any unused candidate, so null means it is exhausted: fall
      // through to far-other, then near.
      // A row she has been to before gets ITS piece back from store; else a fresh candidate. A high row takes its stored
      // piece back, else CLAIMS a parked heavy spare of its type and material (`_claimHeavySpare`), never a fragment or
      // new body; none left means the field lays out fewer pieces.
      const claim = this._claimHeavySpare || DebrisField.prototype._claimHeavySpare;
      let chosen = (fieldPlan && this._takeStoredFieldPiece(fieldPlan.fieldId, rowOf(i)))
        || (spec.high ? claim.call(this, desiredType(spec), spec.material, spec.missionSat ? 'mission' : 'high')
          : (pickFar(spec) || pickAny(farOther) || pickAny(fallbackCandidates)));
      if (!chosen) break; // ran out of candidates entirely
      usedIds.add(chosen.id);
      assigned[i] = chosen;
    }

    let placed = 0;
    let untrackedCount = 0;
    // The "far end" the profile leaves untracked is the far end of the welcome / high rows, never a small-piece group or a
    // mission satellite (10 cm or bigger: known to radar).
    const baseRowCount = fieldToSpawn.filter((sp) => !(sp && sp.own)).length;
    // A group piece and the mission satellite run on their OWN seeded stream (`spec.rng`): every Math.random below (mass
    // roll, type pick, salvage) reads it, so no other piece's draws move. Restored at the end.
    const outerRandom = Math.random;
    try {
    for (let i = 0; i < fieldToSpawn.length && placed < fieldToSpawn.length; i++) {
      const spec = fieldToSpawn[i];
      const debris = assigned[i];
      if (!debris) break;
      Math.random = spec.rng || outerRandom;

      // Seat the piece on its cone-fan slot: ALL 7 sit AHEAD of the mother (WELCOME_FIELD header has the layout and the
      // no-drift argument). PINNED pieces (#1, #2) are positioned in the mother's LOCAL frame each frame (pin branch in
      // update()/_updateInstanceTransform); their orbit is only a fallback. Free pieces (#3–#7) get real co-orbital orbits
      // (same semi-major axis, period-preserving right/up offsets) so the range_wall "press A" beat still flies to #3 and
      // AutoLock's forward arc (ARC_DOT 0.5) sees every one.
      const isPin = !!spec.pin;
      // The debris is spawned mid-frame after player.update propagated the player by n×gameDt, and the loop below advances
      // this debris once more: pre-subtract one step so the along-track offset lands at playerOrbit + fwd (ignored for
      // pinned rows).
      const _nApprox = playerOrbit.meanMotion ||
        Math.sqrt(Constants.MU_EARTH / Math.pow(playerOrbit.semiMajorAxis / Constants.SCENE_SCALE, 3));
      const _frameComp = _nApprox * (this._lastSpawnGameDt || 0);
      // Tolerant of mock receivers: fall back to the prototype's helper.
      const _place = this._placeWelcomePiece || DebrisField.prototype._placeWelcomePiece;
      // A field's free rows take their along-track roll from the field's seed (same field, same look); the placement keeps
      // a roll inside the row band, so this decides it. Pinned rows have no roll.
      if (fieldPlan && !spec.pin) {
        const fMin = Number.isFinite(spec.fwdMinM) ? spec.fwdMinM : 0;
        const fMax = Number.isFinite(spec.fwdMaxM) ? spec.fwdMaxM : fMin;
        debris._welcomeFwdM = fMin + DebrisField.fieldRoll(fieldPlan.seed, rowOf(i)) * (fMax - fMin);
      }
      // a group piece or satellite sits at its own along-track offset: no roll
      if (spec.own) debris._welcomeFwdM = spec.fwdMinM;
      _place.call(this, debris, spec, playerOrbit, _frameComp);

      debris.mass = spec.massMin + Math.random() * (spec.massMax - spec.massMin);

      // Mission-1 onboarding is NET-ONLY (every guided beat captures with the Mother net; no Daughter beat), and the net
      // rejects anything over LASSO_MAX_CAPTURE_MASS: clamp the welcome cluster to that ceiling, else the first target trips
      // "Target too massive for Mother net. Try deploying a Daughter [D]". A high-field row is heavy by design (every one is
      // held under the net's cap by `Constants.HIGH_FIELD`), so the ceiling is for low rows only.
      const netCeil = Constants.LASSO_MAX_CAPTURE_MASS;
      if (!spec.high && Number.isFinite(netCeil) && debris.mass > netCeil) {
        debris.mass = netCeil;
      }

      if (!spec.types.includes(debris.type)) {
        debris.type = spec.types[Math.floor(Math.random() * spec.types.length)];
      }

      // size follows the new type + mass
      const typeDef = DEBRIS_TYPES[debris.type];
      if (typeDef) {
        const massFrac = clamp01((debris.mass - typeDef.massMin) / (typeDef.massMax - typeDef.massMin || 1));
        DebrisField.setDebrisSize(debris,
          typeDef.sizeMin + massFrac * (typeDef.sizeMax - typeDef.sizeMin));
      }

      // `sizeM` is a DELIBERATE override (a 0.1–1 m fragment is a ~10 px speck), so it intentionally bypasses the per-type
      // sizeMax cap: a 3 m fragment renders as a clearly-visible junk chunk.
      if (Number.isFinite(spec.sizeM)) {
        DebrisField.setDebrisSize(debris, spec.sizeM);
      }

      // Authored opening tumble (rate/axis). Pieces without tumbleDegS keep their class-band roll. _initialTumbleRate
      // mirrors the rate (as the Kessler-shard override does) so the E1 despin doctrine can't mistake authoring for a
      // player de-spin.
      if (Number.isFinite(spec.tumbleDegS)) {
        debris.tumbleRate = degToRad(spec.tumbleDegS);
        debris._initialTumbleRate = debris.tumbleRate;
      }
      if (spec.tumbleAxis) {
        const ax = spec.tumbleAxis.x || 0;
        const ay = spec.tumbleAxis.y || 0;
        const az = spec.tumbleAxis.z || 0;
        const al = Math.hypot(ax, ay, az) || 1;
        if (debris.tumbleAxis && typeof debris.tumbleAxis.set === 'function') {
          debris.tumbleAxis.set(ax / al, ay / al, az / al); // prod: THREE.Vector3
        } else {
          debris.tumbleAxis = { x: ax / al, y: ay / al, z: az / al }; // mock receivers
        }
      }
      // The RENDERED colour comes from the candidate's mesh slot (selected above to match appearMaterial);
      // `debris.material` only feeds salvage and capture flags.
      if (spec.material) {
        debris.material = spec.material;
      } else if (spec.appearMaterial) {
        debris.material = spec.appearMaterial;
      }

      if (debris.dragMultiplier) {
        debris.dragMultiplier = undefined;   // clear a previous web shot
      }

      debris.salvage = this._generateSalvage(debris.type, debris.mass, debris.material);

      if (!profile.hydrazine) {
        debris.salvage.hydrazine = 0;
      }

      // `spec.lowValue`: the tease piece is a deliberately LOW-VALUE quick win (a glinting but cheap solar panel): strip
      // premium materials and thin the metals so the first catch pays a little.
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

      // A claimed spare was built at a parked mass: its capture flags (grapple fixture by mass) follow the real mass; the
      // row's name rides on the piece (informational).
      if (spec.high) Object.assign(debris, deriveCaptureFlags(debris.material, debris.type, debris.mass));
      if (spec.name) debris.name = spec.name;
      // Only a HIGH_FIELD piece has an owner (who pays for its removal) and a tumbling area (its orbit life)
      if (spec.owner) { debris.owner = { ...spec.owner }; debris.areaM2 = spec.areaM2; }
      else if (debris.owner) { delete debris.owner; delete debris.areaM2; }   // a reused body never carries a stale owner
      // The piece keeps ITS OWN row spec (a high row is not a WELCOME_FIELD row); re-seat reads it, never the table by index.
      debris._fieldSpec = spec;

      debris.welcomeSpawn = true;
      // The chapter this piece was placed for: collision avoidance exempts a welcome piece only in its own chapter (a new
      // chapter's piece 22 m ahead never costs a burn); a leftover from an older chapter stays a live candidate.
      debris.welcomeChapter = this._currentMissionNumber || 1;
      debris.alive = true;
      // A reused candidate may have been a hazard shard: promotion into the curated cluster clears the
      // uncapturable-furniture flag (the dev net scenario stages its whale on row #7, so this is gate-critical).
      debris.hazard = false;
      // Which spec row realised this piece (0-based): candidate matching is score-based, so debrisList order != spec order.
      debris._welcomeSpecIndex = rowOf(i);
      // a mission extra (row from EXTRA_ROW0 up) is tagged by kind: the map-off "is one still out" rule reads it
      if (rowOf(i) >= Constants.SMALL_GROUP.EXTRA_ROW0) debris._extraKind = DebrisField.isPairRow(rowOf(i)) ? 'pair' : rowOf(i) === Constants.SMALL_GROUP.SAT_ROW ? 'sat' : 'group';
      if (fieldPlan) {   // which field and row this piece is (FieldRegistry reads them when it is removed)
        debris.fieldId = fieldPlan.fieldId;
        debris.fieldRow = rowOf(i);
        debris._fieldStored = false;
      }

      // Flag safety guard: welcome pieces are reused from far candidates that may have been flag-eligible (≥2 m sat/rocket),
      // and the per-frame flag path only REPOSITIONS, never re-checks eligibility, so strip any existing flag: zero its
      // instance, drop the lookup, clear the country (a sub-2 m flag would be an invisible smear).
      // Tolerant of mock receivers lacking flag/instance state.
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

      // Scan-first (owner 2026-10-08, DECISIONS §15 row 1): a new player sees no target bracket, arrow or radar dot until
      // they press S, so ALL seven pieces start `discovered=false`, including pinned #1 (~22 m ahead) and #2 (~48 m). A quick
      // scan (SensorSystem._revealNearbyDebris() → getDebrisNear(), welcomeSpawn-gated on M1; the caller's radius is
      // honoured) reveals at most MAX_REVEALS=5 nearest, so #1–#5 on the first S and #6/#7 on a second. The `tease_lock`
      // beat holds on "Press S to scan" until the first reveal (OnboardingDirector `requiresContacts`).
      debris.discovered = false;

      // Onboarding tease pin: hold the STATION-catch pieces (spec.pin: #1 dead-centre, #2 off to one side) at a fixed
      // offset in the MOTHER'S LOCAL FRAME (forward + lateral) until each is caught. Enforced per-frame in
      // update()/_updateInstanceTransform by writing _scenePosition (the single source of truth that selection, range, net,
      // reticle and rendering read; TargetSelector prefers it). Local-frame is the only way to hold a STABLE sideways
      // offset: co-orbital cross-track oscillates to zero. #3 (range wall) is NOT pinned: it's the free orbit the mother
      // autopilots to. Released per-id on capture / removal / complete / reset.
      if (isPin) {
        debris._onboardingPinned = true;
        debris._onboardingPinFwd = (spec.fwdM || 0) * METRE_SCENE;
        debris._onboardingPinLat = (spec.latM || 0) * METRE_SCENE;
        this._onboardingPinIds.add(debris.id);

        // Per-instance brightness boost for ONLY the pinned pieces (#1/#2) via instanceColor, so they read on the shadow
        // side; no shared-material change. Tolerant of mock receivers lacking instanced meshes.
        const _boostLookup = this._instanceLookup && this._instanceLookup.get(debris.id);
        if (_boostLookup) {
          const _boostMesh = this.instancedMeshes && this.instancedMeshes[_boostLookup.meshKey];
          if (_boostMesh && _boostMesh.instanceColor) {
            _boostMesh.setColorAt(_boostLookup.instanceIndex, this._welcomeBoostColor);
            _boostMesh.instanceColor.needsUpdate = true;
          }
        }
      }

      // profile.untracked: the far end of the rows is left untracked
      const maxUntracked = profile.untracked ?? 0;
      if (!spec.own && maxUntracked > 0 && untrackedCount < maxUntracked && i >= baseRowCount - maxUntracked) {
        debris.tracked = false;
        untrackedCount++;
      } else {
        debris.tracked = true;
      }

      placed++;
    }
    } finally {
      Math.random = outerRandom;
    }

    if (placed > 0) {
      console.log(`[DebrisField] Welcome field: repositioned ${placed} debris near player (mission ${this._currentMissionNumber}, profile: ${profile.label})`);
    }

    // Mission 1 only: hide all non-welcome interactive debris so the pilot sees a tight ≤1.5 km cluster, not catalog debris
    // drifting through at multi-km range. Marked _hiddenForMission1 so _onMissionStart() can restore them.
    if ((this._currentMissionNumber || 1) === 1) {
      let hiddenCount = 0;
      for (const d of this.debrisList) {
        if (!d.alive) continue;
        if (d.welcomeSpawn) continue;
        d._hiddenForMission1 = true;
        d.alive = false;
        d.tracked = false;
        // zero the instance scale so it disappears this frame
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
   * Public welcome-field API: returns a deterministic *plan* (pure data, Node-safe) of the 7–8 fragment cluster the
   * OnboardingDirector wants in the player's orbit at 150–1500 m offsets, then (if a live debrisList is present) realises
   * it via the private spawner. Spawned debris is also tagged `welcomeField:true` to disambiguate from `welcomeSpawn`
   * (M1-only, with the harsher M1 hide logic).
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
    const count = clamp(options.count ?? 7, 7, 8);
    const minOffsetM = options.minOffsetM ?? 150;
    const maxOffsetM = options.maxOffsetM ?? 1500;
    const minMassKg = options.minMassKg ?? 5;
    const maxMassKg = options.maxMassKg ?? 50;

    // Evenly across the offset range; every fragment AHEAD of the mother (mirrors the cone-fan: nothing spawns behind).
    const fragments = [];
    for (let i = 0; i < count; i++) {
      const frac = count === 1 ? 0.5 : (i / (count - 1));
      const offsetM = minOffsetM + frac * (maxOffsetM - minOffsetM);
      const massKg = minMassKg + Math.random() * (maxMassKg - minMassKg);
      fragments.push({
        massKg,
        offsetM,
        ahead: true,
        welcomeField: true,
        type: 'fragment',
      });
    }

    // With a live debris list, also stage the real spawn path and tag matching debris welcomeField:true.
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
   * CH5 ISS conjunction boss (MISSION_ARC §6): spawn `count` threat fragments in the ISS forward track, tagged `iss_threat:true`.
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
   * CH9 Starlink fragmentation boss (MISSION_ARC §6): burst-spawn `count` fragments in the Starlink shell, tagged `starlink_threat:true`.
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
   * Shared boss-frag spawner. Repurposes alive, non-special, NOT-mid-capture debris into the orbit `cfg` (as
   * `_spawnWelcomeField`): overwrites elements, spreads them ahead in true-anomaly, refreshes mass/type/salvage, sets
   * `debris[tag]=true`, marks them tracked + discovered. Returns the spawned ids (fewer than `count` if candidates run out).
   *
   * @private
   * @param {object} cfg — orbit config (altKm, incDeg, raanDeg, argPerigeeDeg, eccentricity, fragMassKg, trackSpreadDeg)
   * @param {number} count
   * @param {string} tag — per-debris flag identifying the threat set
   * @returns {{ ids: number[] }}
   */
  _spawnThreatField(cfg, count, tag) {
    const altKm = cfg.altKm ?? 408;
    const sma = Constants.EARTH_RADIUS + altKm * Constants.SCENE_SCALE;
    const meanMotion = Math.sqrt(Constants.MU_EARTH / Math.pow(sma / Constants.SCENE_SCALE, 3));
    const baseNu = Math.random() * Math.PI * 2;          // random phase around the track
    const spreadRad = degToRad(cfg.trackSpreadDeg ?? 8);
    const frameComp = meanMotion * (this._lastSpawnGameDt || 0); // mid-frame propagation pre-compensation

    // Candidates: alive, not special-tagged, NOT mid-capture. Unlike the welcome field (mission-1 init, nothing grappled),
    // this runs on SHOP_DEPLOY into a later mission, when a daughter may be hauling a catch (_capturedByArm/_armPinned);
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

      // Evenly spread leads ahead in track (forward conjunction).
      const lead = ((i + 1) / count) * spreadRad;
      debris.orbit.semiMajorAxis = sma;
      debris.orbit.eccentricity = cfg.eccentricity ?? 0.0003;
      debris.orbit.inclination = degToRad(cfg.incDeg ?? 51.6);
      debris.orbit.raan = degToRad(cfg.raanDeg ?? 123.4);
      debris.orbit.argPerigee = degToRad(cfg.argPerigeeDeg ?? 45);
      debris.orbit.trueAnomaly = baseNu + lead - frameComp;
      debris.orbit.meanMotion = meanMotion;

      debris.mass = cfg.fragMassKg ?? 45;
      debris.type = 'fragment';
      const typeDef = DEBRIS_TYPES[debris.type];
      if (typeDef) {
        const massFrac = clamp01((debris.mass - typeDef.massMin) / (typeDef.massMax - typeDef.massMin || 1));
        DebrisField.setDebrisSize(debris,
          typeDef.sizeMin + massFrac * (typeDef.sizeMax - typeDef.sizeMin));
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
      // a repurposed shard leaves the hazard cloud: boss fragments are deliberate targets, not furniture
      debris.hazard = false;

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
    // The caller's radius is honoured on EVERY mission: a hard M1 clamp (2 km) made a drifting welcome piece "suddenly
    // disappear" for TargetReticle, NavSphere, AutoLock, the scan reveal and post-catch auto-select at once. What stays is
    // the `welcomeSpawn` gate in the loop, the M1 "only the cluster exists" contract (same guard as getEnhancedTargetList).
    const isMission1 = (this._currentMissionNumber || 1) === 1;

    // Frame-level cache: same frame + same/smaller radius reuses the result
    if (this._frameId === this._cacheFrame &&
        radius <= this._cacheRadius &&
        position.distanceToSquared(this._cachePos) < 1e-12) {
      return this._cachedNearby;
    }

    const rSq = radius * radius;
    const results = [];

    for (const debris of this.debrisList) {
      if (!debris.alive || debris._captured) continue;
      // M1: only welcome cluster debris can appear (the M1 contract; see the head comment).
      if (isMission1 && !debris.welcomeSpawn) continue;
      // Perf: reuse _scenePosition (set this frame by _updateInstanceTransform); orbitToSceneCartesian only on the first frame.
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
          // read-only SNAPSHOTS: the spread would otherwise share the canonical's mutable refs. To mutate/hold a debris,
          // resolve it via getDebrisById(id).
          _scenePosition: debris._scenePosition ? debris._scenePosition.clone() : undefined,
          orbit: debris.orbit ? { ...debris.orbit } : undefined,
          distance: dist,
          distanceKm: dist / Constants.SCENE_SCALE,
          _cartesian: cart,
        });
      }
    }

    results.sort((a, b) => a.distance - b.distance);

    this._cachedNearby = results;
    this._cacheFrame = this._frameId;
    this._cachePos.copy(position);
    this._cacheRadius = radius;

    return results;
  }

  /**
   * Set the current frame ID for spatial query caching; call once per frame from the game loop before any getDebrisNear.
   * @param {number} frameId
   */
  setFrameId(frameId) {
    this._frameId = frameId;
  }

  /**
   * Small untracked debris (under 10 cm, sensor-detectable) within sensor range.
   * @param {THREE.Vector3} position - Player position
   * @param {number} sensorRange - Sensor range in scene units (default: 0.1 = 10km)
   * @returns {Array<object>} Detected small objects with collision risk
   */
  getUntrackedDebrisNear(position, sensorRange = 0.1) {
    const rSq = sensorRange * sensorRange;
    const results = [];

    for (const debris of this.debrisList) {
      if (!debris.alive) continue;
      // hazard shards are collision hazards (ConjunctionSystem), not trawl fodder or sensor contacts
      if (debris.hazard) continue;
      if (debris._disposed) continue;           // never trawl fodder or a contact once disposed of
      if (debris.tracked || debris.sizeMeter > 0.1) continue;

      const cart = orbitToSceneCartesian(debris.orbit);
      const dx = cart.position.x - position.x;
      const dy = cart.position.y - position.y;
      const dz = cart.position.z - position.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq < rSq) {
        const dist = Math.sqrt(distSq);
        const distKm = dist / Constants.SCENE_SCALE;

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
   * Collision risk of a debris object relative to the player, from distance, approach rate and trajectory alignment.
   * @param {object} debris - Debris data object
   * @param {object} cart - Cartesian state { position, velocity }
   * @param {THREE.Vector3} playerPos - Player position
   * @param {number} distKm - Distance in km
   * @returns {number} Risk 0..1
   * @private
   */
  _calculateCollisionRisk(debris, cart, playerPos, distKm) {
    const distFactor = Math.exp(-distKm / 2);

    // Approach vector: is it heading toward us?
    const dx = playerPos.x - cart.position.x;
    const dy = playerPos.y - cart.position.y;
    const dz = playerPos.z - cart.position.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-10) return 1.0;

    const dirX = dx / len;
    const dirY = dy / len;
    const dirZ = dz / len;

    const vLen = Math.sqrt(cart.velocity.x ** 2 + cart.velocity.y ** 2 + cart.velocity.z ** 2);
    if (vLen < 1e-10) return distFactor * 0.1;

    const dot = (cart.velocity.x * dirX + cart.velocity.y * dirY + cart.velocity.z * dirZ) / vLen;
    const approachFactor = Math.max(0, dot); // 0 = receding, 1 = direct approach

    const sizeFactor = Math.min(1, debris.sizeMeter / 0.1);

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
      // hazard shards are not targets (the trawl path reads this list)
      if (debris.hazard) continue;
      // a disposed piece is no target: it stays in the sky as a collision object only
      if (debris._disposed) continue;

      // pre-allocated orbit temps instead of spread
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
    // Search radius: 1000 km (10 scene units) on EVERY mission. A 2 km M1 clamp made a drifted welcome piece drop out of
    // the HUD list and Tab cycle while alive a few km ahead ("cluster vanishes"). The `welcomeSpawn` gate below is what
    // enforces the M1 "only the cluster exists" contract; this filter is the single source of truth for the HUD list.
    const isMission1 = (this._currentMissionNumber || 1) === 1;
    const searchRadius = 10.0;            // 1000 km in scene units, all missions
    const rSq = searchRadius * searchRadius;

    // On M1 the welcome cluster is placed by *orbital elements* relative to playerOrbit, but PlayerSatellite.position can
    // be offset from its orbital position by accumulated `_rcsVelocity * dt` (PlayerSatellite `_rcsVelocity`; measured
    // ~7.7 km after launch / collision-avoidance dodges, vs 30 m – 1.2 km for the cluster). So the M1 distance check uses
    // the orbital reference position: the frame the cluster lives in. Non-M1 missions use the rendered playerPos.
    const refPos = isMission1
      ? orbitToSceneCartesian(playerOrbit).position
      : playerPos;

    for (const debris of this.debrisList) {
      if (!debris.alive || debris._captured) continue;
      // hazard shards are uncapturable furniture: they feed ConjunctionSystem and the sky, never the HUD list
      if (debris.hazard) continue;
      // nor does a disposed piece (a collision object only)
      if (debris._disposed) continue;
      // only discovered debris (scanned)
      if (!debris.discovered) continue;
      // M1 hard contract: ONLY the welcome cluster appears in the HUD list.
      if (isMission1 && !debris.welcomeSpawn) continue;

      // Prefer the live rendered _scenePosition (single source of truth; same basis as getDebrisNear) against the rendered
      // playerPos. Onboarding-PINNED pieces skip Kepler/drag propagation (orbit re-synced to the mother's each frame by
      // _syncPinnedOrbitToMother, but #2's 18 m lateral lives only in _scenePosition), so the orbital comparison is the
      // weaker basis for them. Scene-vs-rendered also cancels the RCS offset. Pieces without a scene position (catalog
      // debris never in the instance pool) fall back to the orbital comparison.
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

        // Delta-V estimate (pre-allocated orbit temps)
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

        // Risk level from tumble + size
        const tumbleDeg = radToDeg(debris.tumbleRate);
        let risk = 'Low';
        let riskStars = 1;
        if (tumbleDeg > 60 || (debris.type === 'rocketBody' && debris.mass > 3000)) {
          risk = 'High';
          riskStars = 4;
        } else if (tumbleDeg > 20 || debris.mass > 500) {
          risk = 'Med';
          riskStars = 2;
        }
        // No Extreme/5-star row for a rocketBody over 4 000 kg, and no 2 000-point arm: no production spawn path emits one
        // (authored cast max 1 600 kg; hazard shards / boss frags / Kessler shards are fragments; the welcome cluster is
        // clamped ≤ 10 kg). Do not harmonise the rows back in; re-add at a measured threshold deliberately. The flat 500
        // row is the live rocketBody pay.

        // Point estimate (simplified scoring)
        let basePoints;
        if (debris.type === 'rocketBody') basePoints = 500;
        else if (debris.type === 'defunctSat') basePoints = debris.mass > 500 ? 500 : 300;
        else if (debris.type === 'missionDebris') basePoints = debris.mass > 5 ? 200 : 100;
        else basePoints = 100;

        const sizeMult = 1.0 + Math.log10(Math.max(debris.mass, 1)) / 4;
        const tumbleMult = 1.0 + tumbleDeg / 90.0;
        const estimatedPoints = Math.floor(basePoints * sizeMult * tumbleMult);

        // Target Priority Index (TPI, FIX_PLAN §4): composite ranking score, lower = higher priority; factors normalized
        // to 0..1 then weighted.
        const TR = Constants.TARGET_RANKING;
        const distScore = Math.min(distKm / TR.DIST_REF_KM, 1.0);
        const dvScore = Math.min(dv / TR.DV_REF_MS, 1.0);
        const threatMap = TR.MOID_THREAT_MAP;
        // bracket lookup: a null badge needs `threatMap[null]` (the string 'null' key)
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
          incDeg: Math.round(radToDeg(debris.orbit.inclination)),
          deltaV: dv,
          selectedDeltaV: debris.selectedDeltaV,
          risk,
          riskStars,
          estimatedPoints,
          hasSalvage: debris.hasSalvage || false,
          salvage: debris.salvage || null,
          metalMassKg: debris.metalMassKg || 0,
          // MOID propagation + composite priority index (FIX_PLAN §4)
          moidBadge: debris.moidBadge || null,
          moid_m: debris.moid_m || null,
          tpi,  // lower = higher priority
        });
      }
    }

    // Mission 1 is a guided cluster authored near→far == catch order == reward ramp, so a new player gets a pure distance
    // sort (list reads in catch/reward order; Tab cycles nearest-first). Later missions use the composite TPI. `tpi` is
    // still computed on M1 so the result shape other consumers rely on is unchanged.
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

    // Capture the cluster bucket BEFORE marking dead, to check whether this removal emptied it (anchors CLUSTER_CLEARED on
    // active captures/deorbits, not trawl sweeps).
    const clusterId = this._clusterIdOf(debris);

    debris.alive = false;

    // a removed piece takes its near-pass proxy with it, this frame
    if (this._heldProxies && this._heldProxies.has(id)) this._dropHeldProxy(id);

    // hide: instance scale 0
    const lookup = this._instanceLookup.get(id);
    if (lookup) {
      this._tempMatrix.makeScale(0, 0, 0);
      const mesh = this.instancedMeshes[lookup.meshKey];
      if (mesh) {
        mesh.setMatrixAt(lookup.instanceIndex, this._tempMatrix);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }

    // A scoop bag owns its merged mesh (`mergeIntoBag`): free it with the bag (geometry and instance buffers; the material
    // is the heaviest member's shared one and stays). Every reader of a removed piece's slot guards a missing mesh.
    if (debris._ownsMesh && debris._meshKey && this.instancedMeshes[debris._meshKey]) {
      const own = this.instancedMeshes[debris._meshKey];
      if (this.group) this.group.remove(own);
      if (own.geometry) own.geometry.dispose();
      own.dispose();
      delete this.instancedMeshes[debris._meshKey];
      this._instanceLookup.delete(id);
      debris._ownsMesh = false;
    }

    eventBus.emit(Events.DEBRIS_REMOVED, { id, type: debris.type, sizeMeter: debris.sizeMeter });

    // CLUSTER_CLEARED when this was the last alive member of its bucket. Guards against double-emit when several removal
    // paths (CATCH_PROCESSED, lasso) race the last member.
    if (clusterId) {
      this._maybeEmitClusterCleared(clusterId);
    }

    return true;
  }

  /**
   * Resolve the (altitude band × inclination cluster) bucket id for a debris object: the single classification entry
   * shared by getDebrisClusters, getFieldIdNear and the CLUSTER_CLEARED accounting. Memoized on sma + inc (identical to a
   * live recompute; auto-invalidates when either changes: drift, deorbit, EDT attract, station-keep snap, fragment respawn).
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
    const incDeg = radToDeg(inc);
    debris._clusterId = classifyClusterId(altKm, incDeg);
    debris._clusterIdSma = sma;
    debris._clusterIdInc = inc;
    return debris._clusterId;
  }

  /**
   * Emit CLUSTER_CLEARED once for a bucket whose last alive member was just removed (called right AFTER a live member was
   * marked dead). The alive-count check is the sole de-dup: a bucket reaches `aliveInBucket === 0` once per emptying, and
   * a later Kessler re-population that re-empties the band re-fires.
   * @private
   * @param {string} clusterId
   */
  _maybeEmitClusterCleared(clusterId) {
    // alive + total in a single pass (cheap thanks to _clusterIdOf memoization)
    let aliveInBucket = 0;
    let totalInBucket = 0;
    let setAside = 0;
    for (const d of this.debrisList) {
      if (this._clusterIdOf(d) !== clusterId) continue;
      totalInBucket++;
      if (d.alive) aliveInBucket++;
      else if (d._fieldStored === true) setAside++;
    }

    if (aliveInBucket > 0) return; // bucket not empty yet
    // A piece set aside when she left its field was never caught: a bucket holding one is not cleared.
    if (setAside > 0) return;

    // readable name from the id (`${incName}-${altMin}`)
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
   * Tool-induced fragmentation: crack sheds a few small fragments and the body survives; breakup/shatter replaces the
   * body with its fragments. KesslerSystem counts the same event independently.
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
      // fragments carry the body's mass; original removed
      this.createFragments({ x: pos.x, y: pos.y, z: pos.z }, debris.mass || data.mass || 1, count);
      this.removeDebris(debris.id);
    } else {
      // crack: shed a small mass fraction; the target survives
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
    // cap to prevent runaway
    const actualCount = Math.min(count, Constants.KESSLER_FRAGMENT_LIMIT);
    const ids = [];

    for (let i = 0; i < actualCount; i++) {
      const debris = this._createDebrisData();
      debris.type = 'fragment';
      debris.shape = 'icosahedron';
      debris._meshKey = null; // no instanced mesh slot for Kessler fragments
      debris.tracked = Math.random() < TRACKING_PROB.fragment;
      DebrisField.setDebrisSize(debris, randRange(0.01, 0.5));
      debris.mass = mass / actualCount;
      // `_createDebrisData` drew the material from the DISCARDED type's MATERIAL_WEIGHTS_BY_TYPE row (a shard drawn AS a
      // rocketBody carried 45/23/22 aluminium/titanium/steel, never mli_mylar or solar_cell; the fragment row intends
      // 34/20/29.5 with ~6 % each MLI/PV) and its capture flags (measured: 27 % of shards had hasFerrousFasteners +
      // hasGrappleFixture, both intact-only). Redraw the material from the fragment row BEFORE the salvage regen reads
      // it, and re-derive the flags from the shipped triple. Brittleness is a type-blind uniform roll in
      // _createDebrisData; re-rolled here for provenance.
      debris.material = weightedMaterial(debris.type);
      Object.assign(debris, deriveCaptureFlags(debris.material, debris.type, debris.mass));
      debris.brittleness = Math.random();
      // _createDebrisData built the salvage from the discarded draw: regenerate it for the shipped fragment (same
      // post-hoc idiom as _spawnWelcomeField / _spawnThreatField).
      debris.salvage = this._generateSalvage(debris.type, debris.mass, debris.material);
      debris.hasSalvage = debris.salvage.xenon > 0 || debris.salvage.indium > 0 ||
        debris.salvage.gaAs > 0 || debris.salvage.battery > 0 || debris.salvage.hydrazine > 0 ||
        debris.salvage.lithium > 0 ||
        (debris.salvage.metals && debris.salvage.metals.length > 0);
      debris.metalMassKg = (debris.salvage.metals || []).reduce((sum, m) => sum + m.amount, 0);
      debris.tumbleRate = degToRad(randRange(30, 180));
      debris._initialTumbleRate = debris.tumbleRate; // keep spawn-tumble in sync with the override (E1)

      // approximate orbit from the collision position
      const r = Math.sqrt(position.x ** 2 + position.y ** 2 + position.z ** 2);
      debris.orbit.semiMajorAxis = r + (Math.random() - 0.5) * 0.001;

      this.debrisMap.set(debris.id, debris);
      this.debrisList.push(debris);
      ids.push(debris.id);
    }

    // New fragments have no instanced mesh slots yet (growing the meshes is not implemented); emit the event for tracking only.
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

  /**
   * Zoom Ladder F6/F7 render-block seam (docs/ladder/01-numbers.md per-floor fidelity). F6 (NAVCOM) `debrisMode` is
   * 'clusters' (meshes replaced by NAVCOM cluster icons); F7 (SDA DOWNLINK, M4) is 'massBands' (chart altitude bands,
   * SdaChart): both hide the meshes. Any other mode ('full'/'tactical'/'hidden'/null) restores the group.
   * `getDebrisClusters()` reads debris DATA, not meshes, so the chart keeps working. SceneManager re-asserts this after
   * applyTier() (same lifecycle as nearFieldEnabled) and restores it on disengage.
   * @param {?string} mode - the arrival floor's fidelity.debrisMode (or null)
   */
  setLadderDebrisMode(mode) {
    const hide = (mode === 'clusters' || mode === 'massBands');
    if (this.group) this.group.visible = !hide;
  }

  /**
   * Is the field in a GUIDED chapter (missions 1–3, the FORCED_DEPOT_CHAPTERS boundary)? Reads the live mission profile's
   * `guidedCluster` (Constants.MISSIONS.PROFILES, the ONE place the boundary is authored), with `_spawnWelcomeField`'s
   * null fallback: before any MISSION_START the field is in M1 mode and PROFILES[0] answers. Strict `=== true`.
   *
   * Consumers: AutoLockController's nearest-any fallback when the forward arc is empty, and the re-seat safety net
   * (_reseatDriftedWelcome): both keep the welcome cluster findable where losing it costs a player.
   *
   * Known limit (inherited from `_currentMissionProfile`): on a bare Continue no MISSION_START fires, so a mission-5 save
   * reads M1 here until the first credited catch re-asserts the mission. GameFlowManager's per-catch line uses the pure
   * `isGuidedChapterNumber(getMissionProgress(debrisCleared).missionNum)`, which IS correct on Continue.
   *
   * @returns {boolean}
   */
  isGuidedChapter() {
    const profile = this._currentMissionProfile || Constants.MISSIONS.PROFILES[0];
    return !!profile && profile.guidedCluster === true;
  }

  /**
   * Subscribe the re-seat "busy" set to the AUTOPILOT_TARGET_LOCK / UNLOCK pair and clear it on GAME_RESET. The mother
   * autopilot and EVERY daughter (ArmUnit, when its tool closes on a target) emit the pair with `{ debrisId }`, hence a
   * Set. The cluster-approach variant carries `targetId` only and is ignored. Called once by the constructor; returns the
   * unsubscribe closure (so test-WelcomeField can exercise it on a bare receiver).
   * @returns {() => void}
   * @private
   */
  _wireReseatLockEvents() {
    const offs = [
      eventBus.on(Events.AUTOPILOT_TARGET_LOCK, (data) => {
        if (data && data.debrisId != null) this._lockedDebrisIds.add(data.debrisId);
      }),
      eventBus.on(Events.AUTOPILOT_TARGET_UNLOCK, (data) => {
        if (data && data.debrisId != null) this._lockedDebrisIds.delete(data.debrisId);
      }),
      eventBus.on(Events.GAME_RESET, () => { this._lockedDebrisIds.clear(); }),
    ];
    return () => { for (const off of offs) off(); };
  }

  /**
   * Install the "is a daughter flying to this id?" guard for the re-seat net. main.js wires it ONCE where debrisField and
   * armManager both exist, as the same test CollisionAvoidanceSystem._isArmTarget makes (`arm.target.id === id`), mirrored
   * not imported so DebrisField never holds an ArmManager reference. It closes the window the lock set leaves open: a
   * daughter EN ROUTE has not yet emitted AUTOPILOT_TARGET_LOCK (that fires when its tool closes). Absent guard = "not
   * busy" (headless / tests).
   * @param {((id: number|string) => boolean)|null} fn
   */
  setReseatGuard(fn) {
    this._reseatGuard = (typeof fn === 'function') ? fn : null;
  }

  /**
   * Hand the field the mother, so the welcome pieces share her ballistic coefficient each frame: dragDecelFor reads
   * `source.lastDragAreaM2` / `lastDragMassKg`, the area and mass her drag block used. main.js calls it once, after both
   * exist, so every update() call (game loop and menu/shop one) uses it. Absent = her reference coefficient
   * (MotherDragArea.referenceDragAreaM2() over MOTHER_DRAG.MASS_KG).
   * @param {{lastDragAreaM2?: (number|null), lastDragMassKg?: (number|null)}|null} source the PlayerSatellite
   */
  setMotherDragSource(source) {
    this._motherDragSource = (source && typeof source === 'object') ? source : null;
  }

  /**
   * Install the mother-net registry (an object with an `activeNets` array, i.e. CaptureNetSystem) so the re-seat net never
   * moves a piece any live net is flying at or holding (net.targetDebris). Handed in because DebrisField cannot import
   * CaptureNet (cycle). Absent = "no net busy".
   * @param {{activeNets?: object[]}|null} src
   */
  setReseatNetSource(src) {
    this._reseatNetSource = (src && typeof src === 'object') ? src : null;
  }

  /**
   * Re-seat a LOST welcome piece onto its cone-fan slot ahead of the mother. This is a TELEPORT, gated hard: every clause
   * must hold:
   *   • a GUIDED chapter (isGuidedChapter(): missions 1–3): later missions accept drifting pieces;
   *   • the piece is `welcomeSpawn` with a numeric `_welcomeSpecIndex`: catalog debris are NEVER re-seated;
   *   • alive and free: not `_captured`, `_onboardingPinned` (#1/#2 ride the mother), `_armPinned`, `_capturedByArm` or
   *     `_motherParked`;
   *   • FAR: `_scenePosition` more than Constants.MISSIONS.RESEAT.DIST_M from the mother at every scan spanning
   *     RESEAT.DWELL_S of REAL time (`_reseatFarS`, reset the moment it is seen back within range);
   *   • NOT BEING APPROACHED: not under an AUTOPILOT_TARGET_LOCK (_lockedDebrisIds: mother AP or a daughter closing on
   *     it) and not a daughter's en-route target (the setReseatGuard callback).
   * Why (owner 2026-09-09): a player who cannot finish an early mission may quit and never return, so the guided cluster
   * must stay reachable if something unforeseen moves the ship (e.g. a manual applyCartesianImpulse). "Far AND not being
   * approached" is the point: a piece the autopilot or a daughter is flying to is never moved, however far.
   *
   * The seat is _placeWelcomePiece (the spawn's own helper): same SMA, inside its row's fwd band (remembered roll), with
   * its cone right/up offsets. `discovered` is kept; a SELECTED piece keeps its selection (no target-change event).
   * `_scenePosition` is refreshed from the new orbit at once for every reader before the propagation loop. Each re-seat
   * logs the id and old distance; the scan posts ONE HOUSTON line in total (RESEAT_COMMS_TEXT for one piece, "Re-acquired
   * N drifted pieces ahead of you." for several; `_postOnboarding`, muted at tier 0 by design) and re-tags each moved
   * piece `welcomeChapter` to the current chapter.
   *
   * Timers are wall-clock: the scan cadence (RESEAT_SCAN_PERIOD_S) and the dwell are player-experience timers ("lost for
   * ten seconds" is what the player feels regardless of game-clock warp).
   *
   * @param {THREE.Vector3|{x,y,z}} playerPos  mother position (scene units)
   * @param {object} playerOrbit               mother elements (scene-unit SMA)
   * @param {number} dt                        REAL seconds since the last frame
   * @param {number} [gameDt]                  this frame's world step: the propagation loop advances the re-seated piece
   *        by it right after, so the spawn's one-step pre-compensation (n × gameDt) is applied here too
   * @returns {number} how many pieces were re-seated this call
   * @private
   */
  _reseatDriftedWelcome(playerPos, playerOrbit, dt, gameDt = TimeAuthority.baseGameDt(dt)) {
    if (!playerPos || !playerOrbit) return 0;
    // Consistent frame: pieces' _scenePosition was written by the PREVIOUS update's propagation loop, i.e. against the ship
    // position handed to that call. Measure against it, not this frame's post-step playerPos (one 0.1 s x10 frame moves
    // the ship ~7.7 km, so a piece 9 m away read as "far"). Cached on every call, before any early return.
    const prev = this._reseatPrevShip || (this._reseatPrevShip = { x: 0, y: 0, z: 0 });
    const hadPrev = this._reseatHasPrev === true;
    const refX = hadPrev ? prev.x : playerPos.x;
    const refY = hadPrev ? prev.y : playerPos.y;
    const refZ = hadPrev ? prev.z : playerPos.z;
    prev.x = playerPos.x; prev.y = playerPos.y; prev.z = playerPos.z;
    this._reseatHasPrev = true;
    if (!this.isGuidedChapter()) return 0;
    const cfg = Constants.MISSIONS.RESEAT;
    if (!cfg) return 0;

    // Scan cadence (real time); the dwell below accumulates the same elapsed seconds.
    this._reseatScanS = (this._reseatScanS || 0) + (dt > 0 ? dt : 0);
    if (this._reseatScanS < RESEAT_SCAN_PERIOD_S) return 0;
    const elapsedS = this._reseatScanS;
    this._reseatScanS = 0;

    const farScene = cfg.DIST_M * METRE_SCENE;
    const farSq = farScene * farScene;
    const nearScene = RESEAT_NEVER_WITHIN_M * METRE_SCENE;
    const nearSq = nearScene * nearScene;
    let reseated = 0;
    let frameCompRad = null; // lazy: most scans move nothing

    for (const debris of this.debrisList) {
      if (!debris.alive || !debris.welcomeSpawn) continue;
      if (debris._disposed) continue;       // a let-go piece stays where it was let go
      if (!Number.isInteger(debris._welcomeSpecIndex)) continue;
      // The piece's own row spec (a high field's piece is not a WELCOME_FIELD row); a test rig that sets only the index
      // falls back to the low table.
      const spec = debris._fieldSpec || WELCOME_FIELD[debris._welcomeSpecIndex];
      if (!spec) continue;
      if (debris._captured || debris._onboardingPinned || debris._armPinned ||
          debris._capturedByArm || debris._motherParked) {
        debris._reseatFarS = 0;
        continue;
      }
      // Any net (mother registry, or a daughter's) targeting or holding the piece: never ours to move.
      if (debris._netted || debris._committedNetArmId != null || netHoldsPiece(this._reseatNetSource, debris)) {
        debris._reseatFarS = 0;
        continue;
      }
      const sp = debris._scenePosition;
      if (!sp) continue; // never positioned yet
      const dx = sp.x - refX, dy = sp.y - refY, dz = sp.z - refZ;
      const distSq = dx * dx + dy * dy + dz * dz;
      // never re-seat a piece within RESEAT_NEVER_WITHIN_M of the ship
      if (distSq <= nearSq || distSq <= farSq) {
        debris._reseatFarS = 0;
        continue;
      }
      debris._reseatFarS = (debris._reseatFarS || 0) + elapsedS;
      // dwell resolves at scan cadence (10–12 s at a 2 s cadence)
      if (debris._reseatFarS < cfg.DWELL_S) continue;
      // never move a piece something is flying to
      if (this._lockedDebrisIds && this._lockedDebrisIds.has(debris.id)) continue;
      if (this._reseatGuard && this._reseatGuard(debris.id)) continue;

      if (frameCompRad === null) {
        const nApprox = playerOrbit.meanMotion ||
          Math.sqrt(Constants.MU_EARTH / Math.pow(playerOrbit.semiMajorAxis / Constants.SCENE_SCALE, 3));
        frameCompRad = nApprox * (gameDt || 0);
      }
      const oldDistM = Math.sqrt(distSq) / METRE_SCENE;
      const wasDiscovered = debris.discovered;
      this._placeWelcomePiece(debris, spec, playerOrbit, frameCompRad);
      debris.discovered = wasDiscovered;
      debris._reseatFarS = 0;
      // put back in the player's path in THIS chapter: counts as this chapter's welcome piece again
      debris.welcomeChapter = this._currentMissionNumber || 1;
      // refresh the read position now (the loop re-derives it after the step)
      const np = orbitToSceneCartesian(debris.orbit).position;
      if (sp.set) sp.set(np.x, np.y, np.z);
      else { sp.x = np.x; sp.y = np.y; sp.z = np.z; }
      reseated++;

      console.log(`[DebrisField] Re-seat: welcome piece ${debris.id} (#${debris._welcomeSpecIndex + 1}) ` +
        `was ${Math.round(oldDistM)} m from the mother for ${cfg.DWELL_S}+ s with nothing flying to it ` +
        `- put back on its slot ahead`);
    }
    // ONE line per scan, however many pieces moved
    if (reseated > 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        text: reseated === 1 ? RESEAT_COMMS_TEXT : `Re-acquired ${reseated} drifted pieces ahead of you.`,
        priority: 'info',
        _postOnboarding: true,
      });
    }
    return reseated;
  }

  /**
   * Group debris into orbital clusters for mission selection: a cluster = debris sharing an altitude band + inclination
   * center. Includes center position (THREE.Vector3) for autopilot heading and a targets array for TrawlManager.
   *
   * The field is assembled inside ONE orbital regime, so every alive piece classifies into ONE (band × inclination) cell
   * and this returns a single non-empty cluster: TRUE, not a defect (the multi-cluster ranking premise returns with
   * fields-as-destinations). reseatFieldRegime moves that cell on a language switch and the _clusterIdOf memo follows.
   * Each cluster carries avgIncRad (alive members' mean live inclination, radians, accumulated with avgAltKm) and
   * scoreCluster reads it, not the cell's incCenter label (the label remains the payload-less fallback): the DebrisMap
   * SCORE priced the transfer against the label, which is wrong where a language's incDeg is off the cell centre.
   * @returns {Array<{id: string, name: string, altRange: {min:number,max:number},
   *           incCenter: number, avgIncRad: number, count: number,
   *           avgAltKm: number, totalMassKg: number, types: object,
   *           targets: Array, center: {x:number,y:number,z:number}}>}
   */
  getDebrisClusters() {
    const INC_NAMES_LOCAL = INC_NAMES;

    // one bucket per (altBand × incCluster)
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
          targets: [],       // debris objects in this cluster
          _altSum: 0,         // running sum for avg computation
          _incSum: 0,         // running sum (radians) for the members' mean plane
          _centerSum: { x: 0, y: 0, z: 0 }, // running sum for center computation
        });
      }
    }

    for (const debris of this.debrisList) {
      if (!debris.alive) continue;

      // shared memoized classifier: membership identical to the CLUSTER_CLEARED accounting
      const clusterId = this._clusterIdOf(debris);
      if (!clusterId) continue; // out of range
      const cluster = clusters.get(clusterId);
      if (!cluster) continue;

      const altKm = (debris.orbit.semiMajorAxis - Constants.EARTH_RADIUS) / Constants.SCENE_SCALE;

      cluster.count++;
      cluster._altSum += altKm;
      cluster._incSum += debris.orbit.inclination; // radians
      cluster.totalMassKg += debris.mass;
      cluster.types[debris.type] = (cluster.types[debris.type] || 0) + 1;
      cluster.targets.push(debris);

      // cartesian position for the center computation
      const cart = orbitToSceneCartesian(debris.orbit);
      if (cart && cart.position) {
        cluster._centerSum.x += cart.position.x;
        cluster._centerSum.y += cart.position.y;
        cluster._centerSum.z += cart.position.z;
      }
    }

    // Finalize: averages, drop empty clusters, sort
    const result = [];
    for (const cluster of clusters.values()) {
      if (cluster.count === 0) continue;
      cluster.avgAltKm = cluster._altSum / cluster.count;
      cluster.avgIncRad = cluster._incSum / cluster.count;

      // center = average cartesian position of members
      cluster.center = {
        x: cluster._centerSum.x / cluster.count,
        y: cluster._centerSum.y / cluster.count,
        z: cluster._centerSum.z / cluster.count,
      };

      delete cluster._altSum;
      delete cluster._incSum;
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
   * Mission-1 welcome-field diagnostics: per-piece SIZE, POSITION and VISIBILITY of the curated cluster (WELCOME_FIELD
   * #1–#7), from the *live* state (not the authored spec), for the Ctrl+D debug overlay.
   *
   * Each entry contains:
   *  - `label`      1-based piece number (= spec index + 1)
   *  - `type`       rendered debris type (fragment / cubesat)
   *  - `sizeM`      live size in metres (`sizeMeter`)
   *  - `renderM`    on-screen size (the longest side of the drawn mesh = sizeMeter)
   *  - `rangeM`     straight-line distance from the player (m) or null
   *  - `fwdM`/`latM` along-track / cross-track offset in the mother's local frame (m): fwd>0 ahead, lat>0 to the right;
   *                 null if frame not yet established
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

    // scene units per metre, inverted for the scene→metres readout
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

      // _lodScale: post-LOD instance scale written each frame in _updateInstanceTransform (0 = culled, sceneSize = full,
      // ½ = far tier).
      const lod = (typeof d._lodScale === 'number') ? d._lodScale : (d.sceneSize || 0);
      let lodState = 'full';
      if (lod === 0) lodState = 'CULLED';
      else if (d.sceneSize > 0 && lod < d.sceneSize * 0.99) lodState = 'far\u00bd';

      const sizeM = Number.isFinite(d.sizeMeter) ? d.sizeMeter : 0;

      out.push({
        label: d._welcomeSpecIndex + 1,
        type: d.type || '?',
        sizeM,
        // a piece is DRAWN at its listed size (longest bounding-box side = sizeMeter), so on-screen size IS sizeM
        renderM: sizeM,
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
   * @param {boolean} [trackedOnly=false] - if true, only count tracked debris (Tab cycling can select without an IR scanner).
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
   * Identify the debris "field" (orbital cluster) the player is in: the dominant cluster among alive debris within
   * `radius` of a position. The scan-reward economy pays once per distinct field surveyed. Null when no meaningful field
   * is nearby (empty space): a scan there earns nothing.
   *
   * @param {THREE.Vector3} position - player scene position
   * @param {number} radius - scene units (defaults to scan reveal range)
   * @returns {string|null} dominant field id (e.g. 'iss-400') or null
   */
  getFieldIdNear(position, radius) {
    if (!position) return null;
    const r = radius || ((Constants.SCAN && Constants.SCAN.REVEAL_BASE_RANGE) || 5.0);
    // tally cluster ids among alive debris within range (discovered or not: the field exists regardless)
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
    let bestId = null, bestN = -1;
    for (const [id, n] of tally) {
      if (n > bestN) { bestN = n; bestId = id; }
    }
    return bestId;
  }
}

export default DebrisField;
