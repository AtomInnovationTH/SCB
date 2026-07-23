/**
 * PlayerSatellite.js — The player's ADR (Active Debris Removal) spacecraft
 * (Octopus V5 / Config G core). Detailed cylindrical "barrel" model with
 * subsystems: body-mount thin-film solar cells, deployable ROSA wings,
 * FEEP main + RCS thrusters, EO/IR/LIDAR sensor gimbal, arm collar with
 * hinges and crossbow struts, docking port, and nav lights.
 * @module entities/PlayerSatellite
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { getSolarCellTexture, getRosaBackTexture } from '../scene/solarCellTexture.js';
import { getMLIFoilMaps } from '../scene/mliFoilTexture.js';
import { getRadialGlowTexture, makeLightHalo } from '../scene/glowSpriteTexture.js';
import { makePlumeFrustum } from '../scene/plumeGeometry.js';
import { applyDetailLod } from '../scene/detailLodCull.js';
import { getOrbitalFoilEnv } from '../scene/orbitalFoilEnv.js';
import { powerDistribution } from '../systems/PowerDistribution.js';
import { persistenceManager } from '../systems/PersistenceManager.js';
import {
  computeCoM, computeCoMDrift, computeCoMDriftVector,
  getActiveBlocks,
} from '../systems/CoMCalculator.js';
import { composeDockedArmQuat } from './ArmDockBasis.js';
import {
  propagateOrbit,
  orbitToSceneCartesian,
  keplerianToCartesian,
  cartesianToKeplerian,
  orbitToKm,
  kmToScene,
  isInShadow,
  orbitalVelocity,
  atmosphericDrag,
} from './OrbitalMechanics.js';

/** 1 meter in scene units (1 scene unit = 100 km) */
const M = 0.00001;

/* ── Preallocated temp objects for strut sweep animation (Epic 10 V-3) ── */
const _strutFrom = new THREE.Vector3(0, -1, 0);
const _strutTo   = new THREE.Vector3();
const _strutQuat = new THREE.Quaternion();
/* ── V-4: Preallocated temps for strut-tip dock offset + arm orientation ── */
const _tipLocal    = new THREE.Vector3();
const _armQuat     = new THREE.Quaternion();
/* Scratch world-space target quat for DOCKING slerp / HOLDING_CATCH snap. */
const _armDockTargetQuat = new THREE.Quaternion();

// P3 (2026-07-20): per-frame animation temps (solar tracking, sensor gimbal,
// solar power). Written+consumed within one call; single PlayerSatellite instance.
const _qInvTmp = new THREE.Quaternion();
const _v3TmpA  = new THREE.Vector3();
const _v3TmpB  = new THREE.Vector3();
/* RCS direction-aware firing temps (per-frame, single instance — no alloc). */
const _rcsL  = new THREE.Vector3();
const _rcsLn = new THREE.Vector3();
/* Deterministic docked-arm roll basis now lives in ArmDockBasis.js (shared SSOT
 * with ArmUnit's DOCKING/HOLDING_CATCH self-alignment — see HANDOFF §10 Rule B).
 * `_composeDockedArmQuat` is a thin local alias kept for call-site readability. */
const _composeDockedArmQuat = composeDockedArmQuat;

/** Destructured V5 constants for crossbow recoil & interlock */
const {
  DUALFIRE_RECOIL_WEAVER, DUALFIRE_RECOIL_SPINNER, DUALFIRE_RCS_COMPENSATION_N2,
  V5_ARM_COUNT, V5_WEAVER_MASS, V5_SPINNER_MASS, ARM_STATES,
} = Constants;

export class PlayerSatellite extends THREE.Group {
  /**
   * @param {THREE.Scene} scene - The Three.js scene to add the satellite to
   */
  constructor(scene) {
    super();
    this.name = 'PlayerSatellite';

    // ========================================================================
    // ORBITAL STATE (Keplerian elements — semiMajorAxis in scene units)
    // ========================================================================
    this.orbit = {
      semiMajorAxis: Constants.EARTH_RADIUS + Constants.START_ALTITUDE,
      eccentricity: 0.0001,
      inclination: 51.6 * Math.PI / 180,
      raan: 0,
      argPerigee: 0,
      trueAnomaly: 0,
      meanMotion: 0,
    };

    // Cache for Cartesian state
    this._cartesian = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };

    // ========================================================================
    // RESOURCES
    // ========================================================================
    this.resources = {
      xenon: Constants.XENON_FUEL_MAX,
      coldGas: Constants.COLD_GAS_MAX,
      battery: Constants.BATTERY_MAX,
      solarRate: 0,
      solarPanelHealth: 1.0,
      lithium: 0,
      lithiumMax: Constants.MPD_LITHIUM_CAPACITY,
    };

    // ========================================================================
    // MPD THRUSTER STATE (F16)
    // ========================================================================
    this._hasMPD = false;           // unlocked via shop purchase
    this._mpdCathodeTime = 0;       // cumulative seconds of MPD firing
    this._mpdCathodeLife = Constants.MPD_CATHODE_LIFE || 600; // upgradable via Hardened Cathode
    this._mpdDeltaV = Constants.MPD_DELTA_V || 0.0015; // scene-scale ΔV per tick

    // ========================================================================
    // MPD BURST MODE STATE (S3b)
    // ========================================================================
    this._mpdArmed = false;           // M key toggle
    this._mpdHeat = 0;                // thermal accumulator (0 to MPD_BURST_OVERHEAT_THRESHOLD)
    this._mpdCooldownTimer = 0;       // seconds remaining in forced cooldown (0 = ready)
    this._mpdDegraded = false;        // true when battery < 5% during burst
    this._hasSupercap = false;        // set by Graphene Supercap upgrade

    // Consumption rates
    this._ionThrustXenonRate = 0.02;
    this._ionThrustPowerRate = 5.0;
    this._coldGasRate = 0.5;
    this._basePowerDraw = 0.5;
    this._ionDeltaV = 0.0003;
    this._coldGasDeltaV = 0.002;

    // Base values for upgrade multipliers (so upgrades modify the rate properties
    // that thrustIon()/thrustColdGas() already read directly)
    this._baseIonDeltaV = this._ionDeltaV;
    this._baseIonXenonRate = this._ionThrustXenonRate;
    this._baseColdGasDeltaV = this._coldGasDeltaV;
    this._baseColdGasRate = this._coldGasRate;

    // Ion-drive multiplier factors, kept separate so they compose without one
    // upgrade clobbering another on the save-restore path (F2/F4). _ionDeltaV is
    // always recomputed as base × thrustMult × mpdPassiveMult via _recomputeIonDeltaV().
    this._thrustMult = 1;        // Ion Booster (thrustMultiplier effect)
    this._mpdPassiveMult = 1;    // MPD Thruster passive drive gain (mpdThruster effect)

    // ========================================================================
    // THRUST INPUT STATE
    // ========================================================================
    this.thrustInput = { x: 0, y: 0, z: 0 };
    this._lastThrustOfflineWarning = 0; // Throttle for power-offline comms warnings

    // Phase 1: RCS fine-positioning velocity (additive to orbital motion)
    this._rcsVelocity = new THREE.Vector3();

    // Mother-net Phase 1C: cosmetic launch-recoil offset (scene units). Applied
    // to the rendered hull position each frame and decayed back to zero by a
    // critically-damped spring. VISUAL ONLY — it does NOT feed the orbit, fuel,
    // or _rcsVelocity, and is re-derived from orbit each frame so it never
    // accumulates. ≤ LASSO_RECOIL_KICK_M (~1.2 m) so it reads as a subtle shudder
    // at ship scale, negligible at orbital scale.
    this._recoilOffset = new THREE.Vector3();

    // Phase 1: Thrust direction tracking & cumulative ΔV
    this._deltaVSpent = 0;         // cumulative ΔV spent this mission (km/s game units)
    this._thrustDirection = null;   // 'prograde' | 'retrograde' | 'lateral' | null
    this._lastThrustType = null;    // 'ion' | 'coldgas' | null

    // F14: Throttle level (0.0–1.0, default 1.0 for backward compatibility)
    this.throttleLevel = 1.0;

    // F13: Manual rotation offset (applied on top of velocity-aligned orientation)
    this._manualRotation = new THREE.Quaternion(); // identity = no offset

    // Autopilot flag — suppresses orientation decay when autopilot is steering (Fix 2)
    this.autopilotEngaged = false;

    // Phase 4: Dual-mode fuel system references
    /** @type {import('../systems/ResourceSystem.js').ResourceSystem|null} */
    this._resourceSystem = null;
    /** @type {import('../systems/CargoSystem.js').CargoSystem|null} */
    this._cargoSystem = null;

    // ========================================================================
    // ANIMATION STATE
    // ========================================================================
    this._lidarPulseTimer = 0;

    // ROSA furl/unfurl state (Comma key). 1 = unfurled (deployed), 0 = furled
    // (rolled up). _rosaManualControl latches once the player toggles, so the
    // post-launch READY state defers to the player instead of LaunchSequence.
    this._rosaFurlTarget = 1.0;
    this._rosaFurlProgress = 1.0;
    this._rosaManualControl = false;
    // ROSA feather state (Shift+Comma). 0 = sun-tracking (normal), 1 = feathered
    // (parked edge-on to a hazard). Feather only acts on a deployed wing — furl
    // takes precedence (a furled wing is frozen, so feather is ignored while
    // furled). Feathering cuts the ROSA power share via the edge-on incidence
    // angle (see _updateSolarPower), NOT a separate multiplier like furl uses.
    this._rosaFeatherTarget = 0.0;
    this._rosaFeatherProgress = 0.0;
    // ROSA power-flow glow: a running clock for the idle "breathing" shimmer and
    // an optional idle floor (the menu hero sets this so the wings glow even
    // without the gameplay power subsystem driving solarRate). See _animateRosaGlow.
    this._rosaGlowClock = 0;
    this._rosaGlowIdleFloor = 0;
    this._thrusterGlowTargets = new Map(); // thruster mesh → { glow, plume, outerGlow, intensity }
    this._differentialFireTargets = [0, 0, 0, 0]; // per-nozzle attitude rotation intensity [TOP, BOTTOM, RIGHT, LEFT]
    this._sensorTarget = null; // THREE.Vector3 world position to track
    this._activeThrustDir = { x: 0, y: 0, z: 0 };

    // Tether reel states: 'ready', 'deployed', 'empty' — V5: expanded to 8 reels
    this._tetherStates = Array(V5_ARM_COUNT).fill('ready');
    this._tetherDeployAnim = Array(V5_ARM_COUNT).fill(0); // 0..1 spool animation

    // ========================================================================
    // RCS THRUSTER PUFF POOL STATE
    // ========================================================================
    this._rcsPuffs = [];          // Array of { sprite, startTime, active }
    this._rcsPuffIndex = 0;       // Round-robin pool index
    this._rcsPuffLastFire = {};   // Per-nozzle cooldown timestamps (seconds)

    // Eclipse cache (Phase 3 §4): _updateSolarPower caches the shadow flag here
    // every frame so puff/plume dimming can read it. Defaults false so headless/
    // Node builds (which never call update, and where _updateSolarPower
    // early-returns on null sunDirection) treat the craft as sunlit.
    this._inShadow = false;

    // §2 sun-scatter cache: camera world pos (set from main.js each frame) and
    // the current sun direction (cached in update). Both null → scatter = 1
    // (headless / null-sun frames stay scatter-free).
    this._camWorldPos = null;
    this._sunDirWorld = null;

    // Detail-LOD cull set (Phase 6): inert mm-scale hardware hidden when the
    // camera is far. Populated by _collectDetailMeshes() after _buildModel;
    // toggled only on threshold crossing by setCameraDistance().
    this._detailMeshes = [];
    this._detailHidden = false;

    // ========================================================================
    // EDT — Electrodynamic Tether (Phase 6)
    // ========================================================================
    this._edtDeployed = false;
    this._edtDeployTimer = 0;
    this._edtActive = false;

    // Wire EDT event listener
    eventBus.on(Events.EDT_DEPLOY, () => this.toggleEDT());

    // ========================================================================
    // V5 CROSSBOW STATE
    // ========================================================================
    this.mass = 130;                // kg — mothership mass for recoil calculations
    this.armManager = null;         // Set via setArmManager() for interlock checks
    this._thrusterInterlock = false; // True when back arm blocks FEEP thruster exhaust
    this._plumeBlocked = {};        // C-9: Map<thrusterId, reason> — plume geometry interlock
    this._comCache = null;          // C-9: Cached CoM result from last computation
    this._comDriftM = 0;            // C-9: Cached scalar drift (m) for HUD
    this._comDriftVec = { x: 0, y: 0, z: 0 }; // C-9: Drift vector (actual − balanced) for torque coupling
    this._crossbowAutoRcs = true;   // Auto-compensate crossbow recoil with RCS
    this._frameRecoilDv = 0;        // Accumulated recoil ΔV this frame (for dual-fire tracking)
    this._frameRecoilCount = 0;     // Number of crossbow fires this frame
    this._frameN2Consumed = 0;      // Actual N₂ consumed (kg) this frame for refund on dual-fire
    this._recoilAngularVel = 0;     // C-11: Pending recoil angular velocity (rad/s) for RCS nulling

    // V5: Subscribe to crossbow fire events for recoil handling
    eventBus.on(Events.CROSSBOW_FIRE, (data) => this._applyCrossbowRecoil(data));
    eventBus.on(Events.DUAL_FIRE_RECOIL, (data) => this._applyDualFireRecoil(data));

    // Scan visual feedback — emissive flash on body material
    this._scanFlashTimer = 0;
    eventBus.on(Events.SCAN_INITIATED, () => {
      this._scanFlashTimer = 0.5; // 0.5s flash duration
    });

    // Diagnostic hull outline — visible during close inspection. Two signals
    // drive it; they are INDEPENDENT inputs we OR together (each frame the
    // outline is on if EITHER path reports inspection), with an explicit boolean
    // so they can't desync or flip-flop:
    //   (1) the discrete INSPECTION camera view (bare-I / debris / arm path)
    //       via CAMERA_VIEW_CHANGE, and
    //   (2) the OVERVIEW zoom-driven mothership inspection sub-state, which
    //       keeps the view as ORBIT and signals via INSPECT_HULL_OUTLINE.
    // Previously these were two separate setHullOutlineVisible() calls, so a
    // CAMERA_VIEW_CHANGE to ORBIT fired during the zoom path would clobber the
    // hull-outline signal and make the outline flicker.
    //
    // SECOND CONSUMER: `_orientAlongVelocity()` also reads these two flags
    // (OR'd) to suspend the prograde auto-orient during close inspection so the
    // hull holds still for the player. Keep both flags reset on inspection exit
    // or the ship stays frozen — don't fold this into the outline plumbing.
    this._hullInspectView = false; // discrete INSPECTION view active?
    this._hullInspectZoom = false; // OVERVIEW zoom sub-state active?
    eventBus.on(Events.CAMERA_VIEW_CHANGE, ({ view } = {}) => {
      this._hullInspectView = (view === 'INSPECTION');
      this.setHullOutlineVisible(this._hullInspectView || this._hullInspectZoom);
    });
    eventBus.on(Events.INSPECT_HULL_OUTLINE, ({ visible } = {}) => {
      this._hullInspectZoom = !!visible;
      this.setHullOutlineVisible(this._hullInspectView || this._hullInspectZoom);
    });

    // ========================================================================
    // BUILD VISUAL MODEL
    // ========================================================================
    this._buildModel();

    // ========================================================================
    // INITIAL POSITION
    // ========================================================================
    this._updateCartesian();
    this._applyPosition();

    scene.add(this);
  }

  // ==========================================================================
  // VISUAL MODEL — V3 Octopus ADR Spacecraft (Octagonal Core)
  // ==========================================================================

  /** @private */
  /**
   * Build a thin PV panel BOX (Task 1, F1 z-layer fix). The outward +z face
   * carries the GaAs cell material; the four side walls + inner (−z) face carry
   * the dark mounting-rail material (`_matPanelRail`) — the 10 mm side walls ARE
   * the mounting rail that covers the flat-facet-over-curved-hull corner air gap,
   * so no separate frame decal is needed. BoxGeometry material array order is
   * [+x, −x, +y, −y, +z, −z]; index 4 (+z) is the cell face, which carries
   * standard 0..1 UVs so the cell texture's `repeat` is unchanged. The panel is
   * positioned by the caller so the +z face lands at the visual radius (1.014R)
   * and the back sits buried at 1.004R.
   * @param {number} w   panel width (local X)
   * @param {number} h   panel height (local Y)
   * @param {number} thick  panel thickness (local Z)
   * @param {THREE.Material} cellMat  outward-face GaAs cell material
   * @returns {THREE.Mesh}
   * @private
   */
  _makePanelBox(w, h, thick, cellMat) {
    const geo = new THREE.BoxGeometry(w, h, thick);
    const rail = this._matPanelRail;
    // [+x, −x, +y, −y, +z(outward cell), −z(inner rail)]
    const mats = [rail, rail, rail, rail, cellMat, rail];
    return new THREE.Mesh(geo, mats);
  }

  /**
   * Apply the synthetic orbital environment map to the gold MLI foil materials
   * (v6 root-cause fix). Foil is a near-mirror: its perceived contrast is the
   * reflected environment × normal variation, so under the scene's near-uniform
   * RoomEnvironment the gold reads as a smooth brass pipe no matter how much
   * crumple detail the normal map carries. A per-MATERIAL orbital envMap (sun +
   * void + Earth) on ONLY these materials makes it read as broken white/dark
   * foil patchwork; scene.environment stays RoomEnvironment for everything else.
   *
   * Call once after construction, from the owning scene, passing that scene's
   * renderer. Idempotent-ish: safe to call again (re-fetches the cached env).
   * Headless-safe: with no renderer (node tests) getOrbitalFoilEnv returns null
   * and this no-ops, leaving the materials unchanged.
   *
   * NOTE: a per-material envMap ignores scene.environmentIntensity — brightness
   * is retuned via material.envMapIntensity here (default 1.0, useful 0.5–2).
   *
   * @param {THREE.WebGLRenderer} [renderer] - the owning scene's renderer.
   * @param {number} [intensity=1.0] - envMapIntensity for the foil materials.
   * @returns {boolean} true if an env map was applied, false if it no-op'd.
   */
  applyFoilEnv(renderer, intensity = 1.0) {
    const env = getOrbitalFoilEnv(renderer);
    if (!env || !this._foilMats) return false;
    for (const mat of this._foilMats) {
      if (!mat) continue;
      mat.envMap = env;
      mat.envMapIntensity = intensity;
      mat.needsUpdate = true;
    }
    return true;
  }

  _buildModel() {
    // Shared materials
    // Gold MLI foil materials (master + its clones) are collected here so the
    // orbital env-map (v6) can be applied to all of them in one pass via
    // applyFoilEnv(). Foil is a near-mirror, so its whole look is the reflected
    // environment; a per-material orbital envMap on just these (not
    // scene.environment) is what makes it read as broken foil rather than a
    // smooth brass pipe under the uniform RoomEnvironment. See orbitalFoilEnv.js.
    this._foilMats = [];
    // Gold-MLI normal + roughness + albedo maps, v5 HEIGHT-FIELD drape
    // (null in headless/no-DOM). These are BAKED static PNGs loaded from textures/
    // (mli_foil_*.png); the v5 generator in mliFoilTexture.js is the bake source
    // (re-run `node scripts/bake-foil-maps.mjs` after knob tweaks), so runtime
    // pays no procedural build cost — just a full-size texture load + a brief
    // pop-in like the Earth textures. Returns a fresh clone per call so each part
    // can carry its own `repeat`. The v5 `crumpled` generator bakes a continuous
    // drape height field — LARGE smooth near-white↔amber gradient panels, long
    // straight bright fold-ridge crests + radiating fans, gated micro-crumple —
    // into ONE tile (the MRO gold-foil read; no cell/facet mosaic). The barrel
    // gets a SINGLE un-tiled wrap [1,1]: the barrel UV is ~2.51 m circumference ×
    // 2.0 m (aspect ≈1.26 — near square), and u=1 is an integer wrap so the
    // cylinder UV stays seamless at u=1 (a fractional u would put a hard texture
    // seam down the barrel; the height field is tileable by construction). The
    // aperture ring reuses the same crumpled tile ([1,1] + smallPart roughness).
    // Instrument boxes instead use `variant:'flat'` — a calm taut sheet, since the
    // full drape amplitudes on a tiny cube face read as glitter. See
    // mliFoilTexture.js header for the bake pipeline and the v2.2→v5 height-field
    // architecture story (fixed per-UV gain, no normalization, no blur).
    const bodyFoil = getMLIFoilMaps({ repeat: [1, 1] });
    this._matBody = new THREE.MeshStandardMaterial({
      color: 0x5c5c64, metalness: 0.7, roughness: 0.55,
    });
    this._matGoldMLI = new THREE.MeshStandardMaterial({
      // MLI thermal blanket — LEMON-gold aluminized-Kapton foil. Real MLI is a
      // continuous DRAPED metallized sheet: large smooth mirror panels with
      // gradient sweeps, separated by sharp tented fold ridges whose crests catch
      // bright specular streaks — so under the PMREM IBL it reads as big
      // near-white↔amber gradient panels crossed by bright ridge lines (the MRO
      // gold-foil look), NOT a facet mosaic. That specular drape is the whole
      // look, so this is a near-MIRROR: metalness 1.0 + roughness 0.45 (the
      // roughnessMap, relative 0.30–0.60, multiplies it to an effective
      // ~0.13–0.27 — glossy enough for ridge glints, satin enough to avoid a
      // harsh blown-out sweep). The v5 normalMap comes from a continuous height
      // field's gradient, so the sun sweeps smoothly across each panel and pops on
      // the crests. If a rolling blowout still appears in chase view (F4), raise
      // roughness toward 0.50. Color is LEMON-gold (0xe3c24d, R:G ≈1.16),
      // NOT amber/copper (0xd6a43e was amber, R:G 1.30 → rejected). Emissive is a
      // matching lemon-shadow tint carrying the shadow side; scan-flash mutates
      // emissive/emissiveIntensity at runtime — the resting tint is retuned here.
      // v6.1 calm: roughness 0.45→0.50 (satin, less mirror; roughnessMap
      // multiplies → effective ~0.15–0.30, killing the harsh whole-panel sweep).
      color: 0xe3c24d, metalness: 1.0, roughness: 0.50,
      emissive: 0x4a3d12, emissiveIntensity: 0.16,
    });
    // Drape gold-foil read (v5): apply the MLI normal + roughness + albedo maps.
    // The normalMap (from the height-field gradient) sweeps each panel smoothly and
    // tents the fold crests so the environment glints along the ridge lines (no
    // cell/facet outlines); the roughnessMap mottles reflectance per-panel + roughens
    // the fold faces (it MULTIPLIES material.roughness, so it's encoded relative
    // 0.30–0.60 → effective ~0.13–0.27 at roughness 0.45); the albedoMap is
    // near-neutral/near-white (hue lives in the material color, variation is
    // SPECULAR not albedo). No-op headless. The body skin (_matBody) is a clone of
    // this material, so it inherits all three maps at the same [1,1] wrap
    // automatically.
    if (bodyFoil) {
      this._matGoldMLI.map = bodyFoil.albedoMap;
      this._matGoldMLI.normalMap = bodyFoil.normalMap;
      this._matGoldMLI.normalScale = new THREE.Vector2(1.0, 1.0);
      this._matGoldMLI.roughnessMap = bodyFoil.roughnessMap;
      // emissiveMap carries the crease pattern onto the shadow side, where flat
      // emissive would otherwise wash the crease darkening out. Scan-flash
      // mutates emissive/emissiveIntensity only — the map does not interfere.
      this._matGoldMLI.emissiveMap = bodyFoil.albedoMap;
    }
    // Register the master gold material for the v6 orbital envMap pass. The
    // _matBody / aperture-ring / IR-box clones are registered at their clone
    // sites (clones copy envMap by reference at clone time, but we set envMap
    // AFTER construction via applyFoilEnv, so each clone must be tracked).
    this._foilMats.push(this._matGoldMLI);
    this._matDark = new THREE.MeshStandardMaterial({
      color: 0x222233, metalness: 0.6, roughness: 0.4,
    });
    // PV panel mounting-rail material (Task 1) — dark satin metal on the side
    // walls + inner face of the thin PV boxes. The 10 mm box side walls ARE the
    // mounting rail (they cover the ~6.7 mm corner air gap of a flat facet panel
    // over the curved hull), so this replaces the old zero-thickness frame decal:
    // solid, depth-writing, single-sided (FrontSide) — no polygon offset, no
    // decal render-order tricks.
    this._matPanelRail = new THREE.MeshStandardMaterial({
      color: 0x1a1a22, metalness: 0.55, roughness: 0.5,
      side: THREE.FrontSide,
    });
    // FEEP nozzle material — copper/bronze tint (field-emission emitters use refractory metals)
    this._matFEEP = new THREE.MeshStandardMaterial({
      color: 0x996644, metalness: 0.80, roughness: 0.35,
    });
    // FEEP nozzle interior — bright emissive ion-emitter surface (BackSide rendered)
    // Visually distinct from the copper exterior; emissive modulated by differential firing
    this._matFEEPInner = new THREE.MeshStandardMaterial({
      color: 0x8899aa, metalness: 0.5, roughness: 0.2,
      emissive: 0x334466, emissiveIntensity: 0.3,
      side: THREE.BackSide,
    });
    // RCS attitude thruster nozzles — standard aerospace gray. DoubleSide so the
    // interior bell wall renders when looking straight down the mouth (otherwise
    // the back faces cull and you see through the wall past the inset liner).
    this._matRCS = new THREE.MeshStandardMaterial({
      color: 0x555566, metalness: 0.65, roughness: 0.45, side: THREE.DoubleSide,
    });

    // --- 1. MAIN BUS — Config G cylindrical barrel (Epic 10 V-1) ---
    this._buildMainBus();

    // --- 1.5. COLLAR RING + HINGE MOUNTS (Epic 10 V-2) ---
    this._buildCollar();

    // --- 1.6. STRUTS + SWEEP PIVOTS (Epic 10 V-3) ---
    this._buildStruts();

    // --- 2. FEEP THRUSTERS (4 main dual-metal FEEP + 4 RCS doghouse quad pods) — Config G ---
    this._buildThrusters();

    // --- 3. ROSA SOLAR ARRAYS (Epic 10 V-5) ---
    this._buildSolarPanels();

    // --- 4. SENSOR SUITE (front) ---
    this._buildSensors();

    // --- 5. Tether reels + indicators now populated by _buildStruts() (S3.3) ---

    // --- 6. (V3 magnetic ring removed — not in Config G) ---

    // --- 7. DOCKING PORT REMOVED (2026-07-23): the fore docking port (ring,
    //        collar, dark guide cone, blinking green/red lamps) was cosmetic
    //        greeble — nothing in the game ever docked with the mother, and
    //        getDockingPortPosition() had no callers. Removed to declutter the
    //        fore end. Capture/berthing is handled by the arms, not a nose port.
    //        In its place: real hardware for a real mechanic — the Large Net pods.

    // --- 7b. LARGE NET PODS (2026-07-23): fore-end launcher hardware for the
    //         Mother's whale-class capture net ([N] fire). Two pods on the lower
    //         fore face, each a 2-cell magazine whose caps show loaded/spent.
    this._buildNetPods();

    // --- 8. NAVIGATION LIGHTS ---
    this._buildNavLights();

    // --- 9. RCS THRUSTER PUFF SPRITES ---
    this._buildRcsPuffPool();

    // --- 10. Detail-LOD cull set (Phase 6) — collect inert mm-scale hardware ---
    this._collectDetailMeshes();
  }

  /**
   * @private — Gather inert, mm-scale hardware into `_detailMeshes` for the
   * distance LOD cull (Phase 6). Selected by NAME so the set is auditable in one
   * place and can never accidentally include a gameplay-communicative mesh
   * (nav/strobe/dock lights, reel LEDs, plumes, tethers are additive/connector
   * meshes with different names and are deliberately excluded). Structural
   * silhouette pieces (hull, struts, caps, collar ring, joint collars, sensor
   * deck, docking ring) are NOT listed — only sub-pixel-at-distance detail.
   */
  _collectDetailMeshes() {
    const CULL_PREFIXES = [
      'PyroPin_', 'PClip_', 'CableHarness_', 'SpringHousing_', 'SpringCoil_',
      'GuideRail_', 'RibRing_', 'FEEPInner_', 'MountBolt_', 'Bushing_',
    ];
    const CULL_EXACT = new Set(['AccentRing', 'FEEP_Boss', 'FEEP_GridDisc']);
    this._detailMeshes.length = 0;
    this.traverse((o) => {
      if (!(o.isMesh || o.isLine) || !o.name) return;   // isLine covers CableHarness lines
      if (CULL_EXACT.has(o.name) || CULL_PREFIXES.some((p) => o.name.startsWith(p))) {
        this._detailMeshes.push(o);
      }
    });
  }

  /**
   * Feed the live camera→craft distance (SCENE UNITS) so the inert detail set can
   * be hidden when far. Called once per frame from main.js. The flip is applied
   * only when a hysteresis threshold is CROSSED (state change), never per frame,
   * so it does not fight systems that own `visible` on other meshes.
   * @param {number} distSceneUnits camera.position.distanceTo(craft.position)
   */
  setCameraDistance(distSceneUnits) {
    this._detailHidden = applyDetailLod(distSceneUnits, this._detailMeshes, this._detailHidden);
  }

  // --------------------------------------------------------------------------
  // 1. Main Bus — Config G Cylindrical Barrel (Epic 10 V-1)
  // --------------------------------------------------------------------------
  /**
   * @private Carve stow grooves into the barrel by displacing the cylinder's
   * vertices radially inward in a band at each strut azimuth.
   *
   * The body CylinderGeometry is built Y-axis aligned and the mesh is later
   * rotated rotation.x=π/2 (geom-Y → world-Z). So a groove at ship azimuth θ and
   * barrel-Z range [z0,z1] maps to:
   *   geometry azimuth  φ = -θ          (atan2(geomZ, geomX))
   *   geometry axial    y ∈ [z0, z1]    (geom-Y == world-Z after the rotation)
   *
   * Each groove uses smooth cosine falloff across its angular width and a
   * smooth ramp at its axial ends, so the dip is a rounded depression rather
   * than a hard-edged trench. Vertices are pushed inward up to `depth`; the
   * normals are recomputed so lighting reads the groove correctly.
   * @param {THREE.BufferGeometry} geo  the body CylinderGeometry (Y-axis)
   * @param {number} barrelR
   * @param {number} barrelH
   */
  /**
   * Single source of truth for stow-groove angular half-widths. The pocket arc
   * spans ~1.3× the daughter body width (capped at 0.45 rad); the shallower stow
   * channel the folded strut lies in is 0.55× the pocket half-width. Both the
   * groove carve (`_carveStowGrooves`/`profileFor`) and the pyro-pin lip
   * placement consume this so the two can never drift apart (previously the pin
   * math re-derived these numbers independently — a latent desync bug).
   * @param {number} crossW    daughter body cross-section width (m)
   * @param {number} barrelR_m barrel radius (m)
   * @returns {{ pocketHa: number, chanHa: number }} angular half-widths (rad)
   * @private
   */
  _stowGrooveHalfWidths(crossW, barrelR_m) {
    const pocketHa = Math.min(0.45, (1.3 * crossW) / (2 * barrelR_m));
    return { pocketHa, chanHa: pocketHa * 0.55 };
  }

  /**
   * SSOT groove profile (stow channel + cradle pocket) for one daughter body.
   * Consumed by `_carveStowGrooves` (the actual vertex carve) AND by
   * test-RcsPlacement.js (which asserts the RCS doghouse pods clear these
   * bands) — extract-shared so the two can never drift apart.
   * @param {number[]} body     daughter [x,y,z] in metres
   * @param {number}   barrelH  barrel length (scene units)
   * @returns {Array<{zc:number,hl:number,ha:number,d:number}>} scene-unit bands
   * @private
   */
  _stowGrooveProfile(body, barrelH) {
    const V5 = Constants.OCTOPUS_V5 ?? {};
    const barrelR_m = (V5.COLLAR_RADIUS ?? 0.40); // metres
    const crossW = body[0];                 // body width (m), cross-section
    const bodyLen = body[2];                // body length (m), along barrel Z
    // Pocket angular half-width so the arc spans ~1.3× the body width (a little
    // clearance around the cradled body): arcWidth = barrelR * 2*ha = 1.3*crossW.
    // Shared with the pyro-pin lip placement via _stowGrooveHalfWidths.
    const { pocketHa, chanHa } = this._stowGrooveHalfWidths(crossW, barrelR_m);
    // Pocket depth scales with daughter size. A small MLI standoff is baked in
    // so the cradle floor sits a few mm clear of the stowed daughter's blanket
    // (avoids MLI-on-MLI scrubbing). Cap ~18% of the barrel radius: the old 50%
    // (0.20 m) read as an impact crater and 15% (0.06 m) left the body looking
    // jammed against the floor; ~18% (0.072 m) with the plateau profile reads as
    // a machined recess with visible clearance. Weaver (crossW 0.20) hits the
    // cap; the smaller Spinner (crossW 0.10) scales down proportionally.
    const MLI_GAP_M = 0.006;                        // ~6 mm blanket standoff
    const maxDepth_m = barrelR_m * 0.18;            // 0.072 m ≈ 18% of 0.40 m radius
    const WEAVER_CROSS = (Constants.WEAVER_BODY ?? [0.2])[0];  // reference (largest)
    const pocketDepth =
      (Math.min(maxDepth_m, maxDepth_m * (crossW / WEAVER_CROSS)) + MLI_GAP_M) * M;
    // Pocket axial CENTRE derived from the true stowed-daughter geometry rather
    // than a magic barrelH fraction: when an arm is STOWED (sweep α = 0) the strut
    // lies along −Z, so the daughter body parks at its tip — z = COLLAR_Y −
    // STRUT_LENGTH (≈ 0.90 − 1.60 = −0.70 m). Centring the pocket exactly there
    // makes both the large (Weaver) and small (Spinner) daughters sit dead-centre
    // in their cradle instead of ~2 cm forward of it. Falls back to the previous
    // −0.34·barrelH constant if the tier constants are missing.
    const pocketZc = (V5.COLLAR_Y != null && V5.STRUT_LENGTH != null)
      ? (V5.COLLAR_Y - V5.STRUT_LENGTH) * M
      : -barrelH * 0.34;
    // Pocket axial half-length ≈ body half-length + clearance + MLI standoff so
    // the daughter's end caps clear the pocket end walls.
    const pocketHl = (bodyLen * 0.6 + MLI_GAP_M) * M;
    // Stow channel: a shallower, narrower groove the folded strut lies in,
    // running forward of the pocket. chanHa comes from the shared helper above.
    const chanDepth = pocketDepth * 0.55;
    return [
      { zc: barrelH * 0.08,  hl: barrelH * 0.38, ha: chanHa,   d: chanDepth },  // stow channel
      { zc: pocketZc,        hl: pocketHl,       ha: pocketHa, d: pocketDepth }, // cradle pocket
    ];
  }

  /**
   * Resolve the active arm-tier config (azimuth ring) the same way ArmManager
   * does — from the persisted save — so the carved stow pockets and pyro-pin
   * launch locks land at the SAME azimuths where daughters actually dock. Falls
   * back to Y0_QUAD for fresh/headless builds with no save. Consumed by
   * `_carveStowGrooves` and the pyro-pin placement so the two can't drift from
   * ArmManager.generateDockPositions.
   *
   * NOTE: the barrel is carved once at construction, so an in-session tier refit
   * (which does not reconstruct the ship) only re-aligns the pockets on the next
   * load; that is still strictly better than the old hard-coded Y0_QUAD, which
   * left Hex/Octo tiers permanently mismatched.
   * @returns {{azimuths:number[]}} the active tier config
   * @private
   */
  _activeArmTierConfig() {
    let key = 'Y0_QUAD';
    try {
      const persisted = persistenceManager?.getArmTier?.();
      if (persisted && Constants.ARM_LADDER?.[persisted]) key = persisted;
    } catch (_) { /* headless / no save → default quad */ }
    return Constants.ARM_LADDER?.[key] ?? Constants.ARM_LADDER?.Y0_QUAD
      ?? { azimuths: [60, 120, 240, 300] };
  }

  _carveStowGrooves(geo, barrelR, barrelH) {
    // Carve at the ACTIVE tier's ring azimuths (Quad/Hex/Octo), not a hard-coded
    // Y0_QUAD, so the pockets land where daughters really dock in the current
    // configuration. (End-face Octo arms dock on the ±Z caps, not the barrel
    // side, so they need no side pocket — only the ring azimuths are carved.)
    const azimuths = (this._activeArmTierConfig().azimuths ?? [60, 120, 240, 300])
      .map(d => d * Math.PI / 180);

    // Daughter body specs [x, y, z] in metres. The pocket cradles the body
    // cross-section (x≈y); z is the body length. Source: Constants.WEAVER_BODY /
    // SPINNER_BODY. Arm type alternates around the ring by index (mirrors
    // ArmManager._buildDockPositions: i%2===0 → weaver, else spinner), so the
    // groove at azimuths[i] is sized for that daughter.
    const WEAVER_BODY  = Constants.WEAVER_BODY  ?? [0.2, 0.2, 0.3];
    const SPINNER_BODY = Constants.SPINNER_BODY ?? [0.1, 0.1, 0.15];

    const weaverProfile  = this._stowGrooveProfile(WEAVER_BODY, barrelH);
    const spinnerProfile = this._stowGrooveProfile(SPINNER_BODY, barrelH);

    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    const smooth = (t) => { // smoothstep 0..1
      t = Math.max(0, Math.min(1, t));
      return t * t * (3 - 2 * t);
    };
    const angDist = (a, b) => {
      let d = Math.abs(a - b) % (Math.PI * 2);
      return d > Math.PI ? Math.PI * 2 - d : d;
    };

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const r = Math.hypot(v.x, v.z);
      if (r < 1e-9) continue;              // skip axis-cap centre (open cyl: none)
      const phi = Math.atan2(v.z, v.x);    // geometry azimuth around Y
      const y = v.y;                       // geometry axial == world barrel-Z

      let maxDepth = 0;
      for (let a = 0; a < azimuths.length; a++) {
        const gPhi = -azimuths[a];         // ship azimuth → geometry azimuth
        // Match ArmManager ring assignment: even index = weaver, odd = spinner.
        const grooves = (a % 2 === 0) ? weaverProfile : spinnerProfile;
        for (const g of grooves) {
          const dAng = angDist(phi, gPhi);
          if (dAng > g.ha) continue;
          const dAx = Math.abs(y - g.zc);
          if (dAx > g.hl) continue;
          // Plateau profile: flat floor over the inner ~60% of the angular width,
          // steep smoothstep walls over the outer 40% — reads as a machined
          // pocket with a level bottom rather than a rounded (crater) dip. Same
          // smooth ramp over the last 25% of the axial length.
          const plateauHa = g.ha * 0.60;
          const wAng = (dAng <= plateauHa)
            ? 1
            : smooth((g.ha - dAng) / (g.ha - plateauHa));
          const wAx  = smooth((g.hl - dAx) / (g.hl * 0.25));
          maxDepth = Math.max(maxDepth, g.d * wAng * wAx);
        }
      }
      if (maxDepth > 0) {
        const nr = (r - maxDepth) / r;     // pull inward toward the axis
        v.x *= nr; v.z *= nr;
        pos.setXYZ(i, v.x, v.y, v.z);
      }
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  /** @private */
  _buildMainBus() {
    // ── Config G Barrel — cylindrical, 0.4m radius × 2.0m height ──
    // Reference: Constants.OCTOPUS_V5 + ARM_PIVOT_ANALYSIS.md §10.11
    const V5 = Constants.OCTOPUS_V5;
    const barrelR = V5.COLLAR_RADIUS * M;  // 0.40m → M * 0.40
    const barrelH = V5.CORE_LENGTH * M;    // 2.00m → M * 2.00

    // Main body — smooth cylinder (16 radial segments). The body shell IS the
    // base MLI (Multi-Layer Insulation) thermal blanket: gold foil is the
    // default surface that wraps the whole bus for thermal control. Everything
    // else — solar panels, thrusters, sensors, collar, docking port, channels —
    // sits ON TOP of this blanket (higher renderOrder / larger radius), exactly
    // as cut-outs/mounts sit on a real satellite's MLI.
    // §2-followup (round 11): body uses 64 radial segments (was 16) so stow
    // grooves can be carved into the hull as real vertex displacement. The
    // grooves dip the wall inward in a band at each strut azimuth — a true
    // conforming depression with no separate, coincident groove mesh.
    const bodyGeo = new THREE.CylinderGeometry(barrelR, barrelR, barrelH, 64, 24, true);
    this._carveStowGrooves(bodyGeo, barrelR, barrelH);
    this._matBody = this._matGoldMLI.clone();   // body skin = MLI blanket (gold)
    this._foilMats.push(this._matBody);         // v6 orbital envMap target
    this.body = new THREE.Mesh(bodyGeo, this._matBody);
    this.body.rotation.x = Math.PI / 2; // Align Y-cylinder to Z-forward
    this.body.name = 'Barrel_ConfigG';
    this.body.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE; // FIX_PLAN §2
    this.add(this.body);

    // Diagnostic hull edge-outline (2026-06-03) — shown only in the INSPECT
    // camera view to give a "technical scan" read without a full scene
    // wireframe. Built LAZILY on the first setHullOutlineVisible(true) call
    // (visual-detail audit Task 3a): the EdgesGeometry walk over the carved
    // 64×24 barrel is pure boot waste for the many sessions that never open
    // INSPECT. `null` until first use; see setHullOutlineVisible().
    this._hullOutline = null;

    // Body-mount GaAs solar cells (610W per ARM_PIVOT_ANALYSIS §10.15 —
    // supplements the deployable ROSA wings).
    //
    // REAL-BUS INTEGRATION: body-mounted cells on real spacecraft are FLAT rigid
    // sub-panels tiled onto the structure's facets — not a curved film. The
    // barrel is a 16-gon, so we mount one flat PV sub-panel per facet (22.5°),
    // tangent to the barrel ON TOP of the MLI blanket, but ONLY on facets that
    // fall in the clear sectors between the stowed struts ([60,120,240,300]°)
    // and clear of the ROSA wing roots at 0°/180°. Each panel carries the dark
    // GaAs cell texture (crisp rectangular cells when the player zooms to
    // inspect). Cells occupy only the central z-band; the MLI blanket (= the
    // body skin itself) shows through everywhere else.

    // PV rows along the barrel length. The satellite is solar-constrained
    // (2240 W solar vs an 8 kW distributable budget + 600 Wh battery), so body
    // cells are maximized: a tall CENTRAL row plus a shorter FORWARD and AFT row
    // filling the end bands that were previously bare MLI. All rows live only on
    // the clear inter-strut facets (off the struts and ROSA roots).
    // §2-followup (round 13): pulled the fore/aft rows INWARD and shortened them
    // so they no longer run into the end-mounted hardware (collar ring at the
    // +Z end, FEEP/RCS thrusters + docking port at the −Z end) or the carved
    // daughter pockets near the aft end. endZ 0.36→0.30, endH 0.16→0.12.
    const centralH = barrelH * 0.46;          // central PV row height (z)
    const endH     = barrelH * 0.12;          // forward/aft PV row height (shortened)
    const endZ     = barrelH * 0.30;          // |z| centre of the end rows (pulled in)
    const cellBandH = centralH;               // (kept for MLI seam placement below)
    const barrelFacets = 16;                  // matches the barrel shell segment count
    const facetStep = (Math.PI * 2) / barrelFacets; // 22.5°
    const facetWidth = 2 * (barrelR * 1.006) * Math.tan(facetStep / 2); // chord of one facet
    // Task 1 (F1): PV panels are thin boxes 10 mm deep. The dark side walls (this
    // thickness) cover the ~6.7 mm corner air gap of a flat 22.5° facet panel over
    // the curved hull and give the panel a real silhouette lip at the limb.
    const PANEL_THICK = M * 0.010;

    const barrelCellTex = getSolarCellTexture();
    const makeRowMat = (texRows) => {
      let tx = null;
      if (barrelCellTex) {
        tx = barrelCellTex.clone();
        tx.needsUpdate = true;
        tx.repeat.set(1, texRows);   // ~one cell-tile across a facet, N rows down
      }
      return new THREE.MeshStandardMaterial({
        color: tx ? 0xffffff : 0x0a1133, // tint comes from the map when present
        map: tx || null,
        emissiveMap: tx || null,
        // Real PV cells carry an anti-reflective coating and read matte — low
        // metalness + high roughness so the directional sun does NOT produce a
        // mirror glint on the flat body-mounted cells as the hull rolls.
        metalness: 0.25, roughness: 0.7,
        emissive: 0x0b1030, emissiveIntensity: 0.18,
        side: THREE.FrontSide,
        // Task 1 (F1 z-layer fix): panels are now thin BOXES, not zero-thickness
        // decals. The +z (outward) cell face sits at 1.014R with the back face
        // buried under the panel at 1.004R, so the panel has real depth and can
        // write depth normally — no more coplanar-decal z-fight, no floating
        // sticker read. depthWrite ON, standard OPAQUE render order.
        depthWrite: true,
      });
    };
    // PV rows: { z-centre, height, texture rows }. Three rows: central + 2 ends.
    const pvRows = [
      { z: 0,      h: centralH, mat: makeRowMat(3) },
      { z: endZ,   h: endH,     mat: makeRowMat(1) },
      { z: -endZ,  h: endH,     mat: makeRowMat(1), aft: true },
    ];
    // Scan-flash drives every PV-row material.
    this._cellSkinMats = pvRows.map(r => r.mat);

    // Bare-MLI half-window reserved around each strut; cells avoid these and
    // the ROSA roots at 0°/180°.
    // §2-followup (round 13): the central/fore rows keep the original ±18° strut
    // keep-out (they sit away from the daughter, which stows AFT). The AFT row
    // gets a much wider ±30° keep-out so no aft cell overlaps a carved daughter
    // pocket or a stowed daughter, and all end rows were pulled inward + shortened
    // (endZ/endH above) so they clear the collar (+Z) and thruster/dock (−Z)
    // hardware near the barrel ends.
    const strutAz = Constants.ARM_LADDER.Y0_QUAD.azimuths.map(d => d * Math.PI / 180);
    const rosaAz = [0, Math.PI];
    const strutKeep    = 18 * Math.PI / 180;  // ±18° clear of each strut (side/central/fore rows)
    const strutKeepAft = 30 * Math.PI / 180;  // ±30° clear of each strut for the AFT row (pocket/daughter)
    const rosaKeep  = 8 * Math.PI / 180;   // ±8° clear of each ROSA root
    const angDist = (a, b) => { let d = Math.abs(a - b) % (Math.PI * 2); return d > Math.PI ? Math.PI * 2 - d : d; };

    let _panelN = 0;
    for (let f = 0; f < barrelFacets; f++) {
      const az = f * facetStep + facetStep / 2;  // facet centre azimuth
      // Skip facets near a strut or a ROSA root.
      if (strutAz.some(s => angDist(az, s) < strutKeep)) continue;
      if (rosaAz.some(rz => angDist(az, rz) < rosaKeep)) continue;

      // §2-followup (round 21): radial restack. Earlier the panels sat at 1.025R
      // and the accent rings extended to ~1.035R (the round-8 comments miscounted
      // the tube radii by 2.5×), so the accents poked OUTSIDE the panels near
      // facet centres. New code-true stack (units of hull radius R): hull 1.000
      // writes depth; seam tape 0.998–1.006R; accent rings 1.004–1.012R; PV
      // panels flat-tangent at 1.014R centre. Flat 22.5° facet panels still lift
      // ~2% (sec 11.25°) at their azimuth edges → ~1.034R; that residual gold gap
      // is masked by the per-panel dark frame border below (reads as a mounting
      // rail), NOT by pushing rr lower (which would let the accents poke through).
      const rr = barrelR * 1.014;
      const radial = new THREE.Vector3(Math.cos(az), Math.sin(az), 0);
      const up = new THREE.Vector3(0, 0, 1);
      const right = new THREE.Vector3().crossVectors(up, radial).normalize();
      const _m4 = new THREE.Matrix4().makeBasis(right, up, radial);

      for (const row of pvRows) {
        // The aft row sits over the daughter-pocket band — give it a wider strut
        // keep-out so no aft cell overlaps a pocket or a stowed daughter.
        if (row.aft && strutAz.some(s => angDist(az, s) < strutKeepAft)) continue;

        // Task 1 (F1): thin BOX panel instead of a zero-thickness decal. The
        // outward +z cell face stays at the current visual radius (1.014R); the
        // box is PANEL_THICK deep (10 mm), so the back face buries well inside the
        // hull and the 10 mm dark side walls cover the ~6.7 mm corner air gap of a
        // flat facet over the curved hull (they read as a mounting rail). Centre
        // the box so its +z face lands at rr: centre = rr − halfThick.
        const panel = this._makePanelBox(facetWidth * 0.92, row.h, PANEL_THICK, row.mat);
        const cr = rr - PANEL_THICK / 2;   // box-centre radius so +z face sits at rr
        panel.position.set(Math.cos(az) * cr, Math.sin(az) * cr, row.z);
        panel.quaternion.setFromRotationMatrix(_m4);
        panel.name = `BarrelSolarPanel_${_panelN++}`;
        // Opaque, depth-writing box — no decal render-order tricks.
        panel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
        this.add(panel);
      }
    }

    // §2-followup (round 15): a few EXTRA cells in the clear gaps BETWEEN stowed
    // daughters near the barrel ends, without disturbing the rows above. The
    // daughters stow at the strut azimuths [60,120,240,300]; the widest clear
    // azimuth windows sit at 90° and 270° (between a Weaver, ±18.6°, and a
    // Spinner, ±9.3°). At the fore/aft end Z-bands those windows are clear of
    // daughters, struts and the collar; the RCS quad pods share the 90/270°
    // columns but sit at |z| ≥ 0.745 (clear of these cells' z-band 0.48–0.72), so
    // one cell fits in each — reclaiming otherwise-bare MLI. (The strobe lights
    // at 90/270 sit at the equator Z=0, not at these end bands, so no conflict.)
    const gapMat = makeRowMat(1);
    this._cellSkinMats.push(gapMat);
    const gapCellW = facetWidth * 0.75;   // half-angle ≈ 8.5° → ~2.9° margin to the Weaver
    for (const gapAzDeg of [90, 270]) {
      const gapAz = gapAzDeg * Math.PI / 180;
      const radial = new THREE.Vector3(Math.cos(gapAz), Math.sin(gapAz), 0);
      const up = new THREE.Vector3(0, 0, 1);
      const right = new THREE.Vector3().crossVectors(up, radial).normalize();
      const gM4 = new THREE.Matrix4().makeBasis(right, up, radial);
      for (const z of [endZ, -endZ]) {  // fore (+) and aft (−) end bands
        const rr = barrelR * 1.014;
        const cr = rr - PANEL_THICK / 2;   // box-centre radius so +z face sits at rr
        const panel = this._makePanelBox(gapCellW, endH, PANEL_THICK, gapMat);
        panel.position.set(Math.cos(gapAz) * cr, Math.sin(gapAz) * cr, z);
        panel.quaternion.setFromRotationMatrix(gM4);
        panel.name = `BarrelSolarPanel_gap_${gapAzDeg}_${z > 0 ? 'F' : 'A'}`;
        panel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
        this.add(panel);
      }
    }

    // MLI quilting seam rings REMOVED (2026-07-23): four thin gold tape hoops
    // (z = ±0.50 m, ±0.80 m) were sub-pixel in normal play and read as floating
    // distractions at inspect zoom; the ±0.80 pair also ran through the RCS pod
    // housings (z ±0.795). The MLI foil texture carries the quilted read.
    // (−4 draw calls, −768 tris.)


    // Panel-line accent rings (thin dark seam grooves) marking the cell-band
    // seams at the central-row edges.
    // §2-followup (z-layer-and-lights-fix Batch 3, Z4): the accents span radial
    // 1.004–1.012R, INSIDE the PV panel radial span (panel outer face 1.014R,
    // buried back to ~0.989R). The old z=0 ring ran straight THROUGH the central
    // PV row — buried except for its facet-gap arcs, and its side-wall crossings
    // flickered. Fix: DELETE the z=0 ring, and push the two band-edge rings OUT of
    // the panel rows into the bare-MLI band at z = ±(cellBandH*0.5 + M*0.015).
    // That +15 mm clears BOTH the central row edge (top at cellBandH*0.5) and the
    // seam tape sitting at cellBandH*0.5 (round-21 "never coincide" z rule), while
    // staying inboard of the fore/aft rows (inner edge endZ − endH/2 = barrelH*0.24
    // = 0.48M; the accent at 0.475M ± tube stays clear). Now the accents sit fully
    // proud on bare MLI — no panel crossing, deterministic tie-pass.
    const lineGeo = new THREE.TorusGeometry(barrelR * 1.008, M * 0.0016, 4, 24);
    const lineMat = this._matDark.clone();
    lineMat.depthWrite = false;
    const accentZ = cellBandH * 0.5 + M * 0.015; // bare-MLI band, +15 mm off the row edge/seam
    for (const z of [-accentZ, accentZ]) {
      const line = new THREE.Mesh(lineGeo, lineMat);
      line.position.z = z;
      line.rotation.x = Math.PI / 2;
      line.name = 'AccentRing';   // Phase 6 detail-cull tag
      // Sub-order 2.03 — paints last (over panels + seam tape).
      line.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL + 0.03;
      this.add(line);
    }

    // Aperture bezel/housing — a short 8-gon cylinder wall bridging the cap face
    // (z=1.0M) to the back of the viewport disc, sharing the -0.2 tilt so bezel,
    // glass disc, and gold ring read as one aimed optic assembly. This FILLS the
    // deliberate §2-followup log-depth standoff gap (8mm/12mm) with structure
    // rather than seating the pieces flush (which would regress that fix).
    // OPAQUE band so the disc (DETAIL) still paints in front of the bezel mouth.
    const bezelLen = M * 0.02;
    const bezelGeo = new THREE.CylinderGeometry(M * 0.13, M * 0.135, bezelLen, 24, 1, true);  // was 8-seg (visibly octagonal at inspect zoom)
    const bezelMat = new THREE.MeshStandardMaterial({
      color: 0x3a3a44, metalness: 0.7, roughness: 0.45,
    });
    const bezel = new THREE.Mesh(bezelGeo, bezelMat);
    // Cylinder axis Y → point it along +Z, then apply the shared -0.2 tilt.
    bezel.rotation.x = Math.PI / 2 - 0.2;
    // Sit its aft mouth on the cap face and its fore mouth just under the disc.
    bezel.position.set(0, M * 0.2, barrelH * 0.5 + M * 0.001 + bezelLen * 0.5);
    bezel.name = 'LaserBezel';
    bezel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
    this.add(bezel);

    // Front viewport/window — laser aperture (20cm Cassegrain)
    // FIX_PLAN §2-followup (round 3): viewport was at z=barrelH*0.5 − 0.05 =
    // 0.95, i.e. 5 CM BEHIND the front cap at z=1.0 — polygonOffset cannot
    // cover a 5 cm gap in depth, so the cap was occluding the aperture.
    // Moved viewport to z=barrelH*0.5 + 0.001 (1 mm IN FRONT of cap) and
    // apertureRing to +0.002 m. They now sit flush on the cap face, fully
    // visible, with renderOrder layering keeping the gold rim on top.
    const viewportGeo = new THREE.CircleGeometry(M * 0.12, 24);  // was 8-seg (match bezel)
    const viewportMat = new THREE.MeshStandardMaterial({
      color: 0x112244, metalness: 0.3, roughness: 0.2,
      emissive: 0x1133aa, emissiveIntensity: 0.4,
    });
    this.viewport = new THREE.Mesh(viewportGeo, viewportMat);
    // §2-followup (round 8): was +0.001·M (1 mm) in front of the cap — the disc
    // (r 0.12) overlaps the cap (r 0.40) in screen space, and 1 mm is below the
    // log depth buffer's reliable separation → z-fight on the front face. Pushed
    // to +0.008·M (8 mm) for a decisive, zoom-independent standoff.
    this.viewport.position.set(0, M * 0.2, barrelH * 0.5 + M * 0.008);
    this.viewport.rotation.x = -0.2;
    this.viewport.name = 'LaserAperture';
    this.viewport.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL; // FIX_PLAN §2-followup
    this.add(this.viewport);

    // Laser aperture ring (gold, forward-facing)
    const apertureRingGeo = new THREE.RingGeometry(M * 0.10, M * 0.14, 24);  // was 8-seg (match bezel)
    const apertureRingMat = this._matGoldMLI.clone();
    // The clone shares the barrel-scale foil textures; this ring is only a few cm,
    // so swap in [1,1] foil clones with the smallPart roughness variant (higher
    // floor) + a scalar roughness ≈0.6 so the small metallic part doesn't clip to
    // white under bloom (F2 exposure fix). Null-safe headless (leaves inherited
    // maps). Override ALL THREE maps so the repeat stays consistent across them.
    const ringFoil = getMLIFoilMaps({ repeat: [1, 1], smallPart: true });
    apertureRingMat.roughness = 0.6;
    if (ringFoil) {
      apertureRingMat.map = ringFoil.albedoMap;
      apertureRingMat.normalMap = ringFoil.normalMap;
      apertureRingMat.roughnessMap = ringFoil.roughnessMap;
      apertureRingMat.emissiveMap = ringFoil.albedoMap;
      apertureRingMat.needsUpdate = true;
    }
    this._foilMats.push(apertureRingMat);       // v6 orbital envMap target
    const apertureRing = new THREE.Mesh(apertureRingGeo, apertureRingMat);
    // §2-followup (round 8): +0.012·M (12 mm), 4 mm proud of the viewport so the
    // gold rim sits clearly in front of the aperture glass.
    apertureRing.position.set(0, M * 0.2, barrelH * 0.5 + M * 0.012);
    apertureRing.rotation.x = -0.2;
    apertureRing.name = 'LaserRing';
    apertureRing.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;  // FIX_PLAN §2-followup
    this.add(apertureRing);

    // End caps
    // FIX_PLAN §2-followup (round 3): removed polygonOffset from cap material
    // — bus is openEnded so there's no built-in cap to z-fight with; the
    // offset was also tying with viewport's offset (both -2,-2) which caused
    // the aperture occlusion. Cap now renders as plain SPACECRAFT_OPAQUE so
    // any DETAIL-tagged mesh in front (viewport, ring) wins cleanly.
    // 64 segments to match the barrel cylinder (both default thetaStart=0 →
    // phases align). Rim rows are uncarved (groove z-spans stay clear of the
    // ±barrelH/2 rims), so the flat 64-gon caps seat exactly on the barrel edge
    // and no longer leave see-through slits from the 16↔64 segment mismatch.
    // §2-followup (z-layer-and-lights-fix Batch 3, Z5): the cap edge circle used
    // to share the EXACT barrel-rim circle (both at 1.000R, same z) — two
    // coincident rim curves that flickered along the whole silhouette under
    // log-depth. Bump the cap to a lid LIP at 1.004R (+1.6 mm overhang): the rim
    // curves are no longer coincident, and the barrel wall now meets the cap
    // underside perpendicular (a stable crossing, not a parallel tie). Do NOT
    // inset the cap in z — that would open a slit at the rim. Silhouette change
    // (1.6 mm) is invisible at gameplay range.
    const capGeo = new THREE.CircleGeometry(barrelR * 1.004, 64);
    // End caps are structural plates (optics bench forward, thruster deck aft),
    // not blanket — keep them dark metallic, distinct from the gold MLI body.
    const capMat = new THREE.MeshStandardMaterial({
      color: 0x4a4a52, metalness: 0.7, roughness: 0.5,
    });
    const frontCap = new THREE.Mesh(capGeo, capMat);
    frontCap.position.z = barrelH * 0.5;
    frontCap.name = 'FrontCap_ConfigG';
    frontCap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;      // FIX_PLAN §2-followup (round 3)
    this.add(frontCap);
    const rearCap = new THREE.Mesh(capGeo, capMat);
    rearCap.position.z = -barrelH * 0.5;
    rearCap.rotation.y = Math.PI;
    rearCap.name = 'RearCap_ConfigG';
    rearCap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;       // FIX_PLAN §2-followup (round 3)
    this.add(rearCap);

    // ── V-11: Stowage grooves are carved into the BODY mesh itself ──
    // §2-followup (round 11): a true inset arc would be hidden behind the smooth
    // (thin, open) body wall, so the groove is now part of the hull geometry —
    // see _buildMainBus where the body cylinder's vertices are displaced inward
    // in a band at each strut azimuth (_carveStowGrooves). That gives a real
    // conforming depression with zero coincident geometry. Here we only add the
    // pyro-pin launch locks at the groove lips.
    // Active tier's ring (matches _carveStowGrooves) so each launch lock lands on
    // a real carved groove lip, not a phantom Y0_QUAD azimuth after a refit.
    const channelTier = this._activeArmTierConfig();

    // Groove angular half-widths at the stow-channel band (matches the profile
    // used by _carveStowGrooves): the pin sits at z=-barrelH*0.21, inside the
    // stow channel, whose angular half-width is chanHa = pocketHa*0.55. Recompute
    // per daughter type so each pin lands on the actual carved lip, not the
    // deepest floor (INTENT MISMATCH FIX: comment said "groove lips" but pins
    // were at the groove centre over the deepest carve → ~12 cm float).
    const barrelR_m_pin = (Constants.OCTOPUS_V5?.COLLAR_RADIUS ?? 0.40);
    const chanHaFor = (body) =>
      this._stowGrooveHalfWidths(body[0], barrelR_m_pin).chanHa;
    const chanHaWeaver  = chanHaFor(Constants.WEAVER_BODY  ?? [0.2, 0.2, 0.3]);
    const chanHaSpinner = chanHaFor(Constants.SPINNER_BODY ?? [0.1, 0.1, 0.15]);
    const pinEps = 2 * Math.PI / 180;   // small margin past the lip onto uncarved hull

    channelTier.azimuths.forEach((azDeg, aIdx) => {
      const azRad = azDeg * Math.PI / 180;
      // Even index = weaver, odd = spinner (matches _carveStowGrooves / ArmManager).
      const chanHa = (aIdx % 2 === 0) ? chanHaWeaver : chanHaSpinner;

      // Two pins per groove, one on each lip (±(chanHa+ε) around the azimuth), at
      // radius 1.005R on the uncarved hull just outside the channel wall.
      for (const side of [-1, 1]) {
        const lipAz = azRad + side * (chanHa + pinEps);
        const pyroGeo = new THREE.CylinderGeometry(M * 0.006, M * 0.006, M * 0.025, 4);
        const pyroMat = new THREE.MeshStandardMaterial({
          color: 0xcc4400, metalness: 0.6, roughness: 0.4,
        });
        const pyro = new THREE.Mesh(pyroGeo, pyroMat);
        pyro.position.set(
          Math.cos(lipAz) * barrelR * 1.005,
          Math.sin(lipAz) * barrelR * 1.005,
          -barrelH * 0.21,
        );
        const radialUp = new THREE.Vector3(Math.cos(lipAz), Math.sin(lipAz), 0);
        pyro.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), radialUp);
        pyro.name = `PyroPin_${azDeg}_${side > 0 ? 'hi' : 'lo'}`;
        this.add(pyro);
      }
    });

    // (V3 docking cavities removed — Config G uses collar-mounted struts)
    this._dockingCavities = [];
  }

  /**
   * @private — Helper: creates A-frame bracket 2D Shape for ExtrudeGeometry.
   * Topology-optimized profile with rounded apex, tapered web, gusset fillets,
   * and oval lightening hole. See EPIC10_DEEP_ANALYSIS.md §13.1.2.
   * @returns {THREE.Shape}
   */
  _aframeShape() {
    const W  = M * 0.025;  // half-width at base (50 mm total)
    const H  = M * 0.040;  // total height base→apex (40 mm)
    const FH = M * 0.012;  // flange height (12 mm)
    const AW = M * 0.010;  // half-width at apex (20 mm total)
    const R  = M * 0.008;  // apex fillet radius

    const shape = new THREE.Shape();
    // Bottom-left of mounting flange
    shape.moveTo(-W, 0);
    // Left flange edge up
    shape.lineTo(-W, FH);
    // Left web taper — bezier from flange top to apex
    shape.bezierCurveTo(
      -W, FH + M * 0.010,    // CP1: slight outward bulge (gusset fillet)
      -AW - R, H - R,        // CP2: approach apex tangent
      -AW, H,                // End: apex left edge
    );
    // Rounded apex arc (over pin bore)
    shape.bezierCurveTo(
      -AW + R * 0.5, H + R * 0.4,  // CP1
       AW - R * 0.5, H + R * 0.4,  // CP2
       AW, H,                       // End: apex right edge
    );
    // Right web taper (mirror of left)
    shape.bezierCurveTo(
       AW + R, H - R,
       W, FH + M * 0.010,
       W, FH,
    );
    // Right flange edge down + close
    shape.lineTo(W, 0);
    shape.lineTo(-W, 0);

    // Lightening hole — oval cutout in web center (~30 % mass removal)
    const hole = new THREE.Path();
    hole.ellipse(0, M * 0.022, M * 0.007, M * 0.005, 0, Math.PI * 2, false, 0);
    shape.holes.push(hole);

    return shape;
  }

  /**
   * @private — Epic 10 S3.1: Collar ring + Double-A clevis hinge assemblies.
   *
   * Implements EPIC10_DEEP_ANALYSIS.md §13.1 — topology-optimized A-frame brackets,
   * Vespel bushings, brake discs, Ti bolt details, collar flange ring, and bolt circle.
   * All shared geometries are created once and reused via mesh cloning.
   *
   * PRESERVED: this.hingeMounts[], this.hingeLEDs[] (used by postArmUpdate).
   */
  _buildCollar() {
    const V5 = Constants.OCTOPUS_V5;
    const collarY = V5.COLLAR_Y * M;          // 0.90 m → ship-frame Z offset
    const collarR = V5.COLLAR_RADIUS * M;     // 0.40 m → torus major radius
    const tier = Constants.ARM_LADDER.Y0_QUAD; // { azimuths: [60, 120, 240, 300] }
    const _yUpCollar = new THREE.Vector3(0, 1, 0);  // reusable Y-up for quaternion ops

    // ── Materials (§13.1.1 Material Selection Table) ─────────────────────
    const aframeMat = new THREE.MeshStandardMaterial({
      color: 0x9090a8, metalness: 0.72, roughness: 0.30,   // 6061-T6 CNC
    });
    const pinMat = new THREE.MeshStandardMaterial({
      color: 0xaabbcc, metalness: 0.85, roughness: 0.15,   // 17-4PH stainless
    });
    const bushingMat = new THREE.MeshStandardMaterial({
      color: 0x8b6914, metalness: 0.15, roughness: 0.70,   // Vespel SP-1
    });
    const brakeMat = new THREE.MeshStandardMaterial({
      color: 0x555566, metalness: 0.70, roughness: 0.35,   // 440C stainless
    });
    const boltMat = new THREE.MeshStandardMaterial({
      color: 0x99aabb, metalness: 0.80, roughness: 0.20,   // Ti-6Al-4V
    });

    // Collar ring cluster REMOVED (2026-07-23): the full-circumference torus belt
    // (+ flange ring, seat ring, 12 flange bolts) read as a loose hoop slipped
    // over the hull, was overkill for 4 hinge points, and sat in the fore axial
    // RCS exhaust path (~27 mm clearance). Struts now mount on discrete hinge
    // pads (see below). this.collarRing is intentionally no longer set
    // (TierVisualManager guards on it and no-ops).

    // ── Hinge mounting pads — discrete feet replacing the old collar ring ──
    // One low plate per strut hinge. Base buried 2 mm below the hull surface
    // (bury-don't-touch, same anti-z-fight pattern as the RCS doghouses); top
    // face ~6 mm proud, sitting under the A-frame brackets.
    const PAD_W = 0.10, PAD_L = 0.10, PAD_T = 0.008;   // m: tangential × axial × radial
    const padGeo = new THREE.BoxGeometry(M * PAD_W, M * PAD_L, M * PAD_T);
    const padMat = new THREE.MeshStandardMaterial({
      color: 0x8888a0, metalness: 0.75, roughness: 0.28,   // 7075-T6 (matches hinge metal)
    });
    tier.azimuths.forEach((azDeg, i) => {
      const azRad  = azDeg * Math.PI / 180;
      const radial = new THREE.Vector3(Math.cos(azRad), Math.sin(azRad), 0);
      const tangent = new THREE.Vector3(-Math.sin(azRad), Math.cos(azRad), 0);
      const padR = collarR - M * 0.002 + M * (PAD_T / 2);  // base 2 mm under hull
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.position.set(radial.x * padR, radial.y * padR, collarY);
      pad.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(tangent, new THREE.Vector3(0, 0, 1), radial),
      );
      pad.name = `HingePad_${i}`;
      pad.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      this.add(pad);
    });

    // ── Shared hinge geometries (§13.1.5, create once, clone per hinge) ──
    const aframeGeo = new THREE.ExtrudeGeometry(this._aframeShape(), {
      depth:          M * 0.008,    // 8 mm plate thickness
      bevelEnabled:   true,
      bevelThickness: M * 0.001,    // 1 mm chamfer
      bevelSize:      M * 0.001,
      bevelSegments:  1,            // single chamfer (machined look)
      curveSegments:  8,            // bezier smoothness
    });
    aframeGeo.center();             // origin at bracket centroid

    const pinGeo     = new THREE.CylinderGeometry(M * 0.005, M * 0.005, M * 0.070, 8);
    const clipGeo    = new THREE.TorusGeometry(M * 0.007, M * 0.0015, 4, 8);
    const bushingGeo = new THREE.TorusGeometry(M * 0.008, M * 0.003, 6, 8);
    const brakeGeo   = new THREE.CylinderGeometry(M * 0.015, M * 0.015, M * 0.003, 12);
    const mountBoltGeo = new THREE.CylinderGeometry(M * 0.003, M * 0.003, M * 0.004, 6);
    const ledGeo     = new THREE.SphereGeometry(M * 0.01, 8, 6);  // was 4×4 (Phase 5)

    // ── Per-hinge Double-A clevis assemblies ─────────────────────────────
    this.hingeMounts = [];
    this.hingeLEDs   = [];

    for (const azDeg of tier.azimuths) {
      const azRad   = azDeg * Math.PI / 180;
      const cx      = Math.cos(azRad) * collarR;
      const cy      = Math.sin(azRad) * collarR;
      const radial  = new THREE.Vector3(Math.cos(azRad), Math.sin(azRad), 0);
      const tangent = new THREE.Vector3(-Math.sin(azRad), Math.cos(azRad), 0);
      const pinQuat = new THREE.Quaternion().setFromUnitVectors(_yUpCollar, tangent);

      // ── A-frame brackets (×2 per hinge, straddling strut root) ──
      // Offset ±19 mm along tangent (gap = 38 mm, clears 25 mm strut + bushings)
      // Orientation: shape +Y → radial, extrude +Z → tangent×side, shape +X → barrel Z
      // FIX_PLAN §2-followup (round 3): hinge cluster (brackets, mount bolts,
      // bushings, pin, c-clips, brake disc) sits on the hinge pad at z=0.90
      // with overlapping radial extents → potential z-fights between bracket
      // body and pad/hull surfaces. Tag every part DETAIL so they render after
      // the pad/hull and win the depth ties cleanly.
      for (const side of [-1, 1]) {
        const bracket = new THREE.Mesh(aframeGeo, aframeMat);
        // Position: on collar surface, offset tangentially, centered at half bracket height
        bracket.position.set(
          cx + radial.x * M * 0.020 + tangent.x * M * 0.019 * side,
          cy + radial.y * M * 0.020 + tangent.y * M * 0.019 * side,
          collarY,
        );
        // Build rotation: localX→barrelZ×side, localY→radial, localZ→tangent×side
        // Both axes flip together to keep the basis right-handed (det = +1).
        // Shape is X-symmetric so flipping local X has no visual effect.
        const basis = new THREE.Matrix4().makeBasis(
          new THREE.Vector3(0, 0, side),                   // local X → barrel axis (×side)
          radial,                                          // local Y → radial out
          tangent.clone().multiplyScalar(side),            // local Z → tangent×side
        );
        bracket.setRotationFromMatrix(basis);
        bracket.name = `AFrame_${azDeg}_${side > 0 ? 'L' : 'R'}`;
        bracket.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;       // FIX_PLAN §2-followup (round 3)
        this.add(bracket);

        // ── Mounting bolts (×2 per bracket, at flange base ±18 mm along barrel Z) ──
        for (const boltSide of [-1, 1]) {
          const mb = new THREE.Mesh(mountBoltGeo, boltMat);
          mb.position.set(
            cx + tangent.x * M * 0.019 * side + radial.x * M * 0.002,
            cy + tangent.y * M * 0.019 * side + radial.y * M * 0.002,
            collarY + M * 0.018 * boltSide,
          );
          mb.quaternion.setFromUnitVectors(_yUpCollar, radial);  // bolt head outward
          mb.name = `MountBolt_${azDeg}_${side > 0 ? 'L' : 'R'}_${boltSide}`;
          mb.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;          // FIX_PLAN §2-followup (round 3)
          this.add(mb);
        }

        // ── Vespel bushing (×1 per bracket, pressed into pin bore at apex) ──
        const bushing = new THREE.Mesh(bushingGeo, bushingMat);
        bushing.position.set(
          cx + radial.x * M * 0.040 + tangent.x * M * 0.019 * side,
          cy + radial.y * M * 0.040 + tangent.y * M * 0.019 * side,
          collarY,
        );
        bushing.quaternion.copy(pinQuat);   // ring axis along tangent (around pin)
        bushing.name = `Bushing_${azDeg}_${side > 0 ? 'L' : 'R'}`;
        bushing.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;       // FIX_PLAN §2-followup (round 3)
        this.add(bushing);
      }

      // ── Pivot pin (17-4PH, ∅10 mm × 70 mm, through both A-frame bores) ──
      const pin = new THREE.Mesh(pinGeo, pinMat);
      pin.position.set(
        cx + radial.x * M * 0.040,
        cy + radial.y * M * 0.040,
        collarY,
      );
      pin.quaternion.copy(pinQuat);
      pin.name = `HingePin_${azDeg}`;
      pin.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;             // FIX_PLAN §2-followup (round 3)
      this.add(pin);
      this.hingeMounts.push(pin);           // preserve hingeMounts[] reference

      // ── C-clip retainers (×2, snap rings on pin ends, 5 mm exposed) ──
      for (const side of [-1, 1]) {
        const clip = new THREE.Mesh(clipGeo, pinMat);
        clip.position.set(
          cx + radial.x * M * 0.040 + tangent.x * M * 0.033 * side,
          cy + radial.y * M * 0.040 + tangent.y * M * 0.033 * side,
          collarY,
        );
        clip.quaternion.copy(pinQuat);
        clip.name = `CClip_${azDeg}_${side > 0 ? 'L' : 'R'}`;
        clip.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;          // FIX_PLAN §2-followup (round 3)
        this.add(clip);
      }

      // ── Brake disc (440C, centered on pin between A-frames) ──
      const disc = new THREE.Mesh(brakeGeo, brakeMat);
      disc.position.set(
        cx + radial.x * M * 0.040,
        cy + radial.y * M * 0.040,
        collarY,
      );
      disc.quaternion.copy(pinQuat);
      disc.name = `BrakeDisc_${azDeg}`;
      disc.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;            // FIX_PLAN §2-followup (round 3)
      this.add(disc);

      // ── LED indicator (forward of outboard A-frame, per §13.1.1) ──
      const ledMat = new THREE.MeshBasicMaterial({ color: 0x00ff44 });
      const led = new THREE.Mesh(ledGeo, ledMat);
      led.position.set(cx, cy, collarY + M * 0.03);
      led.name = `HingeLED_${azDeg}`;
      led.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;           // FIX_PLAN §2-followup (round 3)
      this.add(led);
      this.hingeLEDs.push(led);             // preserve hingeLEDs[] for postArmUpdate
    }
  }

  // --------------------------------------------------------------------------
  // 1.6. Struts — Animated sweep arms (Epic 10 V-3)
  // --------------------------------------------------------------------------

  /**
   * @private — Epic 10 V-3: Build animated strut pivots at each hinge mount.
   *
   * Each strut extends from the collar hinge and sweeps 0–π driven by
   * {@link ArmUnit.getAimAlpha}. A tip node at the far end serves as the
   * attachment point for daughter arms (V-4).
   *
   * Scene hierarchy per arm:
   * ```
   *   PlayerSatellite (ship group)
   *     └─ StrutPivot_i (THREE.Group) — at hinge, rotates for sweep
   *          └─ Strut_i (Mesh)       — cylinder, top = pivot
   *          └─ StrutTip_i (Group)   — far end, daughter-arm dock
   * ```
   */
  _buildStruts() {
    const V5 = Constants.OCTOPUS_V5;
    const strutLen = V5.STRUT_LENGTH * M;         // 1.60 m → scene
    const strutR   = (V5.STRUT_TUBE_OD / 2) * M;  // 0.025 m → scene
    const collarY  = V5.COLLAR_Y * M;
    const collarR  = V5.COLLAR_RADIUS * M;
    const tier     = Constants.ARM_LADDER.Y0_QUAD;

    // V-4: Cache strut length for dynamic dock-offset computation in _updateStruts
    this._strutLen = strutLen;

    // Shared geometry + material (one per satellite, 4 struts share)
    const strutGeo = new THREE.CylinderGeometry(strutR, strutR, strutLen, 12);
    const strutMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a30, metalness: 0.15, roughness: 0.65,  // CFRP T800/M21
    });

    // ── Rib ring collars (field-joint detail) ──
    // FIX_PLAN §2-followup: bumped 1.15→1.22 so torus inner edge clears strut
    // surface (was strutR*1.15 - 0.003 ≈ strutR*1.03, only ~0.7 mm gap → z-fight).
    const ribGeo = new THREE.TorusGeometry(strutR * 1.22, M * 0.003, 4, 12);   // FIX_PLAN §2-followup
    const ribMat = new THREE.MeshStandardMaterial({
      color: 0x8899aa, metalness: 0.72, roughness: 0.28,  // machined 6061-T6
    });

    // ── Root joint collar (clevis fork fitting at hinge end) ──
    // FIX_PLAN §2-followup: rootCollar cylinder at strutR*1.20 (radius 0.030)
    // sits at the pivot point on the bus surface, where it crosses the body
    // collar/seat rings. §2-followup (round 5) replaced the old polygonOffset
    // depth bias with a real outboard standoff (see ROOT_COLLAR_STANDOFF below).
    const ROOT_COLLAR_LEN = M * 0.025;          // cylinder length (half = inner-face offset)
    // Forward reach of the hinge PAD toward the strut, measured from the hinge
    // plane (collarY). Was COLLAR_RING_REACH = M*0.015 for the removed collar
    // ring; now the pad's proud height + nothing else.
    const PAD_REACH = M * 0.006;
    const STANDOFF_MARGIN   = M * 0.004;        // clearance so metal never grazes the ring
    // Distance the collar centre must sit outboard (-Y) of the pivot so its
    // inner face clears the ring cluster: half-length + ring reach + margin.
    const ROOT_COLLAR_STANDOFF = ROOT_COLLAR_LEN * 0.5 + PAD_REACH + STANDOFF_MARGIN;
    const rootCollarGeo = new THREE.CylinderGeometry(
      strutR * 1.20, strutR * 1.20, ROOT_COLLAR_LEN, 12
    );
    const rootCollarMat = new THREE.MeshStandardMaterial({
      color: 0x8888a0, metalness: 0.75, roughness: 0.28,  // 7075-T6
      // §2-followup (round 5): polygonOffset(-2,-2) removed. The root collar is
      // solid metal interpenetrating the body-frame collar/seat rings, and
      // polygonOffset is the LEAST reliable here under logarithmicDepthBuffer
      // (it biased two solids in different transform frames). Replaced with a
      // real geometric standoff (see rootCollar.position.y below) so the collar
      // metal physically clears the ring surfaces at every zoom.
    });

    // ── Tip joint collar (dock fitting at daughter-arm end) ──
    const tipCollarGeo = new THREE.CylinderGeometry(
      strutR * 1.10, strutR * 1.10, M * 0.020, 12
    );
    const tipCollarMat = new THREE.MeshStandardMaterial({
      color: 0x8899aa, metalness: 0.72, roughness: 0.28,  // 6061-T6
    });

    // ── S3.3: Reel cartridge shared geometry + materials ──
    // Z-fix (Phase 1): the housing was open-ended (…, 8, 1, true), so looking
    // through either open end showed a culled/see-through interior and the drum
    // end-caps (which are coaxial with, and pierced by, the strut) read as
    // interpenetrating geometry. Closing the ends (openEnded=false) resolves both
    // — the opaque shell now caps the cartridge and hides the enclosed drum/strut
    // overlap. Done by swapping the geometry flag (NOT adding cap meshes) so the
    // keyed child order (housing[0], drum[1], led[2]) is preserved.
    const housingGeo = new THREE.CylinderGeometry(M * 0.055, M * 0.055, M * 0.065, 12, 1, false);  // was 8-seg (4× always in chase view)
    const housingMat = new THREE.MeshStandardMaterial({
      color: 0x505868, metalness: 0.40, roughness: 0.50,  // hard-anodized 6061-T6
    });
    const drumGeo = new THREE.CylinderGeometry(M * 0.045, M * 0.045, M * 0.055, 12);  // was 8-seg (match housing)
    const drumMat = new THREE.MeshStandardMaterial({
      color: 0xddddee, metalness: 0.20, roughness: 0.60,  // Dyneema SK78 T0
    });
    // Status LED — Z-fix (Phase 1): was a flat PlaneGeometry sitting only 1 mm
    // off the housing wall (z 0.056 vs wall r 0.055) — below reliable log-depth
    // separation at distance, so it z-fought the shell. Now a small solid box
    // whose inner face stands REEL_LED_STANDOFF (4 mm) proud of the wall so the
    // pad reads as a raised indicator and never shares a depth plane with the
    // housing. Colour is still driven via .material.color in _animateTetherIndicators.
    const REEL_LED_STANDOFF = M * 0.004;      // 4 mm ≥ log-depth min separation
    const ledDepth = M * 0.004;
    const ledGeo = new THREE.BoxGeometry(M * 0.008, M * 0.008, ledDepth);
    const ledZ = M * 0.055 + REEL_LED_STANDOFF + ledDepth * 0.5; // inner face 4 mm proud
    const ledMatBase = new THREE.MeshBasicMaterial({
      color: 0x00ff44,  // green = STOWED
    });

    // ── S3.3: Cable harness (Line geometry, simplified from TubeGeometry) ──
    // §2-followup (round 8): was strutR+0.005 = 0.030, which put the cable line
    // right on the rib-ring tube (centre 0.0305, outer 0.0335) → the 1px line
    // z-fought the ring surface where it crossed each ring. Route it just
    // OUTSIDE the rib-ring outer edge so it rides proud of the rings with a real
    // gap. The P-clips inherit this offset, so cable + clips stay aligned.
    const cableOffset = strutR * 1.22 + M * 0.006;  // ~clear of rib-ring outer (0.0335)
    const cableVerts = new Float32Array([
      cableOffset, -M * 0.015, 0,                       // root collar exit
      cableOffset, -strutLen * 0.25, 0,                  // clip 1
      cableOffset, -strutLen * 0.50, 0,                  // clip 2
      cableOffset, -strutLen * 0.75, 0,                  // clip 3
      cableOffset, -strutLen * 0.85 + M * 0.0325, 0,    // reel housing entry
    ]);
    const cableGeo = new THREE.BufferGeometry();
    cableGeo.setAttribute('position', new THREE.BufferAttribute(cableVerts, 3));
    const cableMat = new THREE.LineBasicMaterial({ color: 0x555566 });

    // ── S3.3: P-clip shared geometry (reuses ribMat from S3.2) ──
    const clipGeo = new THREE.BoxGeometry(M * 0.012, M * 0.008, M * 0.006);

    // ── S3.4: Crossbow spring mechanism shared geometry + materials ──
    const springHousingGeo = new THREE.CylinderGeometry(
      M * 0.030, M * 0.030, M * 0.060, 8, 1, true   // open-ended, reveals coil
    );
    const springRingGeo = new THREE.TorusGeometry(M * 0.018, M * 0.003, 3, 6);
    const springMat = new THREE.MeshStandardMaterial({
      color: 0x889999, metalness: 0.82, roughness: 0.28,  // maraging steel C-300
    });
    const guideLen = strutLen * 0.05;  // 5% of strut = 80mm (housing to tip)
    const guideGeo = new THREE.BoxGeometry(M * 0.005, guideLen, M * 0.005);

    this.strutPivots   = [];   // THREE.Group — pivot at hinge
    this.strutMeshes   = [];   // THREE.Mesh  — the thin rod
    this.strutTipNodes = [];   // THREE.Group — tip attachment for V-4
    this.tetherReels   = [];   // THREE.Group[] — S3.3 reel cartridge per strut
    this._tetherIndicators = []; // THREE.Mesh[] — S3.3 LED per reel

    /** @type {Array<{pivotGroup: THREE.Group, strut: THREE.Mesh, tipNode: THREE.Group, azRad: number}>} */
    this.strutGroups = [];

    tier.azimuths.forEach((azDeg, i) => {
      const azRad = azDeg * Math.PI / 180;

      // ── Pivot group at hinge point on collar ──
      const pivotGroup = new THREE.Group();
      pivotGroup.position.set(
        Math.cos(azRad) * collarR,
        Math.sin(azRad) * collarR,
        collarY,
      );
      pivotGroup.name = `StrutPivot_${i}`;

      // ── Strut mesh — CylinderGeometry default is Y-axis aligned.
      //    Offset so the pivot point = top end of the cylinder. ──
      const strut = new THREE.Mesh(strutGeo, strutMat);
      strut.position.y = -strutLen / 2;   // hang from pivot
      strut.name = `Strut_${i}`;
      strut.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;   // FIX_PLAN §2-followup
      pivotGroup.add(strut);

      // ── Tip node at far end of strut (daughter-arm dock in V-4) ──
      const tipNode = new THREE.Group();
      tipNode.position.y = -strutLen;
      tipNode.name = `StrutTip_${i}`;
      pivotGroup.add(tipNode);

      // ── S3.3: Reel cartridge (3-child group, replaces placeholder reel) ──
      const housing = new THREE.Mesh(housingGeo, housingMat);
      housing.name = `ReelHousing_${i}`;
      const drum = new THREE.Mesh(drumGeo, drumMat);
      drum.name = `ReelDrum_${i}`;
      const led = new THREE.Mesh(ledGeo, ledMatBase.clone());
      led.position.set(0, M * 0.02, ledZ);  // on the housing wall, standing proud
      led.name = `ReelLED_${i}`;

      const reelCartridge = new THREE.Group();
      reelCartridge.add(housing);    // children[0] — housing shell
      reelCartridge.add(drum);       // children[1] — spool drum (keyed for rotation)
      reelCartridge.add(led);        // children[2] — status LED
      reelCartridge.position.y = -strutLen * 0.85;
      reelCartridge.name = `ReelCartridge_${i}`;
      pivotGroup.add(reelCartridge);

      this.tetherReels.push(reelCartridge);
      this._tetherIndicators.push(led);

      // ── S3.3: Cable harness line (root collar → rib rings → reel entry) ──
      const cable = new THREE.Line(cableGeo, cableMat);
      cable.name = `CableHarness_${i}`;
      pivotGroup.add(cable);

      // ── S3.3: P-clips at rib ring positions ──
      // §2-followup (round 8): the clips were at the EXACT same Y as the rib
      // rings (-strutLen*{0.25,0.50,0.75}), and the clip box (centred at radius
      // cableOffset≈0.030, extent ±0.006 → 0.024–0.036) sits INSIDE the rib-ring
      // torus radial span (0.0275–0.0335) at that Y → interpenetrating coincident
      // geometry that z-fought on the +X side. Offset each clip a few mm along Y
      // off the ring plane so the box and torus no longer share a plane. (A clip
      // clamping the cable just below its rib ring is physically correct.)
      const CLIP_Y_OFFSET = M * 0.012;
      for (const frac of [0.25, 0.50, 0.75]) {
        const clip = new THREE.Mesh(clipGeo, ribMat);
        clip.position.set(cableOffset, -strutLen * frac - CLIP_Y_OFFSET, 0);
        clip.name = `PClip_${i}_${frac * 100}`;
        clip.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;   // FIX_PLAN §2-followup
        pivotGroup.add(clip);
      }

      // ── S3.4: Crossbow spring mechanism (4-child group, replaces SpringMount) ──
      const springGroup = new THREE.Group();
      const springHousing = new THREE.Mesh(springHousingGeo, housingMat);
      springHousing.name = `SpringHousing_${i}`;
      springGroup.add(springHousing);
      const springCoil = new THREE.Mesh(springRingGeo, springMat);
      springCoil.rotation.x = Math.PI / 2;
      springCoil.name = `SpringCoil_${i}`;
      springGroup.add(springCoil);
      const railOff = M * 0.012;
      const railL = new THREE.Mesh(guideGeo, housingMat);
      railL.position.set(-railOff, -strutLen * 0.025, 0);
      railL.name = `GuideRail_${i}_L`;
      springGroup.add(railL);
      const railR = new THREE.Mesh(guideGeo, housingMat);
      railR.position.set(+railOff, -strutLen * 0.025, 0);
      railR.name = `GuideRail_${i}_R`;
      springGroup.add(railR);
      springGroup.position.y = -strutLen * 0.95;
      springGroup.name = `CrossbowSpring_${i}`;
      pivotGroup.add(springGroup);

      // ── Rib ring collars at 25%, 50%, 75% of strut length ──
      for (const frac of [0.25, 0.50, 0.75]) {
        const ring = new THREE.Mesh(ribGeo, ribMat);
        ring.position.y = -strutLen * frac;
        ring.rotation.x = Math.PI / 2;   // torus plane ⊥ strut Y-axis
        ring.name = `RibRing_${i}_${frac * 100}`;
        ring.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;   // FIX_PLAN §2-followup
        pivotGroup.add(ring);
      }

      // ── Root joint collar (hinge end) ──
      const rootCollar = new THREE.Mesh(rootCollarGeo, rootCollarMat);
      // §2-followup (round 5): seat the collar outboard along the strut (-Y) by
      // a standoff DERIVED from the ring cluster's reach + the collar's own
      // half-length (see ROOT_COLLAR_STANDOFF above), so its inner face clears
      // the body collar/seat rings geometrically — log-depth-buffer-safe and
      // self-adjusting if the ring/collar dimensions change. Replaces both the
      // old polygonOffset bias and the earlier hand-picked 6mm guess.
      rootCollar.position.y = -ROOT_COLLAR_STANDOFF;
      rootCollar.name = `RootCollar_${i}`;
      rootCollar.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;   // FIX_PLAN §2-followup
      pivotGroup.add(rootCollar);

      // ── Tip joint collar (daughter dock end) ──
      const tipCollar = new THREE.Mesh(tipCollarGeo, tipCollarMat);
      tipCollar.position.y = -strutLen + M * 0.010;  // at strut tip
      tipCollar.name = `TipCollar_${i}`;
      tipCollar.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;   // FIX_PLAN §2-followup
      pivotGroup.add(tipCollar);

      // ── Default orientation: α = π/2  →  strut points radially outward ──
      //    Rotation maps local -Y to the radial direction (cosθ, sinθ, 0).
      //    Uses setFromUnitVectors for exact alignment (same as _updateStruts).
      const radialDir = new THREE.Vector3(Math.cos(azRad), Math.sin(azRad), 0);
      const baseQuat = new THREE.Quaternion();
      baseQuat.setFromUnitVectors(new THREE.Vector3(0, -1, 0), radialDir);
      pivotGroup.setRotationFromQuaternion(baseQuat);

      this.add(pivotGroup);

      // Store references
      this.strutPivots.push(pivotGroup);
      this.strutMeshes.push(strut);
      this.strutTipNodes.push(tipNode);
      this.strutGroups.push({ pivotGroup, strut, tipNode, azRad, baseQuat, strutDir: new THREE.Vector3() });
    });
  }

  // --------------------------------------------------------------------------
  // 2. Thrusters
  // --------------------------------------------------------------------------
  /**
   * @private — Build a diverging, open-ended plume frustum with a per-vertex
   * alpha fade to zero at the far (downstream) end. Thin delegate to the shared
   * `makePlumeFrustum` (scene/plumeGeometry.js), which the daughters reuse so the
   * Mother and daughter beams share one shape/fade SSOT.
   */
  _makePlumeFrustum(rNear, rFar, len, radial = 12, rings = 4) {
    return makePlumeFrustum(rNear, rFar, len, radial, rings);
  }

  /** @private — Config G FEEP thruster array + RCS attitude thrusters */
  _buildThrusters() {
    this.mainThrusters = [];
    this.mainThrusterPlumes = [];
    this.attitudeThrusters = [];
    this.attitudeThrusterPlumes = [];

    // Config G main FEEP nozzle — smaller proportions for 0.4m barrel
    const nozzleGeo = new THREE.CylinderGeometry(M * 0.03, M * 0.06, M * 0.15, 16, 1, true);  // was 12-seg (aft-view focal)

    // Map thruster index → Constants.THRUSTERS id (for interlock visual)
    const thrusterIds = ['HT_TOP', 'HT_BOTTOM', 'HT_RIGHT', 'HT_LEFT'];

    // Recessed aft thruster deck — a shallow mounting plate the 4 FEEP cones sit
    // on, so the cluster reads as attached hardware rather than cones floating off
    // the aft cap. Sits just aft of the rear cap (z=-M*1.0) on a distinct z-plane
    // (z=-M*1.008) with DETAIL order so it does not z-fight the cap face; radius
    // covers the ±0.2M cross while staying inside the 0.40M hull.
    const deckGeo = new THREE.CylinderGeometry(M * 0.30, M * 0.30, M * 0.04, 24);  // was 16-seg (60 cm disc edge)
    const deckMat = new THREE.MeshStandardMaterial({
      color: 0x3a3a44, metalness: 0.7, roughness: 0.45,
    });
    const aftDeck = new THREE.Mesh(deckGeo, deckMat);
    aftDeck.rotation.x = Math.PI / 2;
    aftDeck.position.set(0, 0, -M * 1.008);
    aftDeck.name = 'AftThrusterDeck';
    aftDeck.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.add(aftDeck);

    // 4 main FEEP thrusters at aft face, cross pattern (Config G barrel)
    const mainPositions = [
      { x: 0, y: M * 0.2 },  // top
      { x: 0, y: -M * 0.2 }, // bottom
      { x: M * 0.2, y: 0 },  // right
      { x: -M * 0.2, y: 0 }, // left
    ];

    mainPositions.forEach((pos, i) => {
      const thruster = new THREE.Mesh(nozzleGeo, this._matFEEP);
      thruster.position.set(pos.x, pos.y, -M * 1.0);
      thruster.rotation.x = Math.PI / 2;
      thruster.name = `MainFEEP_${i}`;
      thruster._thrusterId = thrusterIds[i]; // for interlock visual lookup
      this.add(thruster);
      this.mainThrusters.push(thruster);

      // Inner liner — BackSide-rendered interior surface, distinct from copper
      // exterior.
      // §2-followup (round 8): the liner used the SAME nozzleGeo as the thruster
      // with zero offset — a coincident shell (exactly the daughter cell-skin
      // bug). Under logarithmicDepthBuffer two coincident surfaces z-fight
      // regardless of depth flags. Give the liner its own geometry inset from the
      // nozzle radius so it is a genuine interior wall with a real gap, never
      // coincident with the outer nozzle.
      // §2-followup (z-layer-and-lights-fix Batch 4, Z6): the inset was 0.97×,
      // leaving only a ~1.8 mm exit gap — below the ~4 mm log-depth reliable
      // separation, so the mouth still shimmered. Tighten the inset to 0.92× so
      // the exit gap is M*0.06*0.08 = 4.8 mm (≥ 4 mm), deterministic tie-pass at
      // the visible nozzle mouth. Single factor on both radii keeps the cone taper.
      const LINER_INSET = 0.92;
      const linerGeo = new THREE.CylinderGeometry(M * 0.03 * LINER_INSET, M * 0.06 * LINER_INSET, M * 0.15, 16, 1, true);  // was 12-seg (match bell)
      const innerLiner = new THREE.Mesh(linerGeo, this._matFEEPInner.clone());
      innerLiner.name = `FEEPInner_${i}`;
      innerLiner.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      thruster.add(innerLiner);

      // FIX_PLAN §2 — Mounting boss (ring around nozzle throat)
      // Parent thruster has rotation.x=π/2 mapping local +Y → world +Z, so
      // boss.position.y is the axis aligned with the nozzle, and boss cylinder
      // geometry (along local Y) auto-aligns with world Z (no extra rotation).
      const bossGeo = new THREE.CylinderGeometry(M * 0.07, M * 0.07, M * 0.03, 8);
      const bossMat = new THREE.MeshStandardMaterial({
        color: 0x444455, metalness: 0.7, roughness: 0.3,
      });
      const boss = new THREE.Mesh(bossGeo, bossMat);
      // Place at nozzle throat (world Δz = +0.075M from thruster centre at world -M*1.0)
      boss.position.y = M * 0.075;
      boss.name = 'FEEP_Boss';
      boss.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL; // FIX_PLAN §2
      thruster.add(boss);

      // FIX_PLAN §2 — Grid disc (ion accelerator grid recessed inside nozzle exit)
      // Same parent-rotation accounting: use local Y axis for the nozzle direction.
      const gridDiscGeo = new THREE.CircleGeometry(M * 0.025, 8);
      const gridDiscMat = new THREE.MeshBasicMaterial({
        color: 0x667788, wireframe: true, transparent: true, opacity: 0.5,
        side: THREE.DoubleSide,
      });
      const gridDisc = new THREE.Mesh(gridDiscGeo, gridDiscMat);
      // Place 5mm inside nozzle exit (world z = -M*1.005, exit at world z = -M*1.075)
      gridDisc.position.y = -M * 0.005;
      // Disc default normal is local +Z = world -Y; DoubleSide keeps it visible
      // from outside the nozzle without further rotation.
      gridDisc.name = 'FEEP_GridDisc';
      gridDisc.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT; // FIX_PLAN §2
      thruster.add(gridDisc);

      // FEEP nozzle glow ring (sized to nozzle aperture)
      const glowGeo = new THREE.RingGeometry(M * 0.02, M * 0.055, 6);
      const glowMat = new THREE.MeshBasicMaterial({
        color: 0x99bbdd, transparent: true, opacity: 0.0,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.position.set(pos.x, pos.y, -M * 1.075);
      glow.name = `MainFEEPGlow_${i}`;
      glow.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // FIX_PLAN §2
      this.add(glow);

      // FEEP plume — diverging ion beam (Phase 3). Was a converging cone (base at
      // nozzle, apex 30 cm aft) which reads as a chemical flame, physically wrong
      // for field-emission. Now an open frustum, narrow at the exit (r=nozzle exit
      // 0.06M) widening to ~2.2× downstream, vertex-alpha fading to 0 at the tip.
      // Kept in mainThrusterPlumes as a Mesh with .material.opacity/.color/.visible
      // — the exact hooks LaunchCinematic + _animateThrusterGlow drive.
      const plumeGeo = this._makePlumeFrustum(M * 0.06, M * 0.13, M * 0.35);
      const feepPlumeMat = new THREE.MeshBasicMaterial({
        color: 0x99bbdd, transparent: true, opacity: 0.0, vertexColors: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const plume = new THREE.Mesh(plumeGeo, feepPlumeMat);
      plume.position.set(pos.x, pos.y, -M * 1.075);  // near end welded to nozzle exit
      plume.rotation.x = -Math.PI / 2;               // beam local +Y → world -Z (aft)
      plume.name = `MainFEEPPlume_${i}`;
      plume.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // FIX_PLAN §2
      plume.visible = false;
      this.add(plume);
      this.mainThrusterPlumes.push(plume);

      // Outer glow halo — longer, wider, fainter diverging frustum around the core.
      const outerGlowGeo = this._makePlumeFrustum(M * 0.06, M * 0.17, M * 0.75);
      const outerGlowMat = new THREE.MeshBasicMaterial({
        color: 0xaaccee, transparent: true, opacity: 0.0, vertexColors: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const outerGlow = new THREE.Mesh(outerGlowGeo, outerGlowMat);
      outerGlow.position.set(pos.x, pos.y, -M * 1.075);
      outerGlow.rotation.x = -Math.PI / 2;
      outerGlow.name = `MainFEEPOuterGlow_${i}`;
      outerGlow.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // FIX_PLAN §2
      outerGlow.visible = false;
      this.add(outerGlow);

      this._thrusterGlowTargets.set(thruster, { glow, plume, outerGlow, innerLiner, intensity: 0 });
    });

    // ── RCS: 4 doghouse quad pods (visual-detail audit Task 1, rev 2) ────────
    // WAS (rev 1): 4 quad pods on a "plinth" — but the plinth was a broken
    // CylinderGeometry (outer/inner radii fed into radiusTop/radiusBottom → a
    // single tapered OPEN sheet, no thickness, no side walls). With a 5 mm
    // standoff the whole housing hovered 15–19 mm off the 0.40 m hull with a
    // visible under-gap (user-reported "floating above mother").
    // NOW (rev 2): NO plinth. The doghouse housing is SEMI-RECESSED — its base
    // is buried RCS_BURY (10 mm) BELOW the hull surface, so its flat bottom edges
    // land inside the hull and no under-gap can ever show from any angle (the
    // box sides cross the MLI at a steep angle → no log-depth z-fight; that only
    // bites near-parallel coincident surfaces). This is how real doghouses read:
    // the MLI blanket closes out around a base that emerges from the hull.
    // Each pod (2 azimuth columns × 2 z-stations) carries 3 nozzles — RADIAL
    // (±Y), AXIAL (±Z), TANGENTIAL (canted ±X) — so all six local translation
    // directions show a plume (a real Draco-style cluster), with 2 nozzles per
    // ±X/±Y/±Z axis → single-nozzle-failure redundancy.
    // Placement (all guarded from BUILT geometry by test-RcsPlacement.js — never
    // trust these comments):
    //   • azimuth = 90°/274.65°... SNAPPED to 90°/270° so each pod is centred on
    //     the body PV "gap" cells at those azimuths (the nearest solar panels on
    //     the mother body). ~11° clear of the weaver pocket and ~21° of the
    //     spinner pocket. Kept ORTHOGONAL to the ROSA wings (0°/180°) so
    //     radial/axial exhaust never washes the blankets.
    //   • |z| = 0.795 m, housing 0.10 m long → pod z-span 0.745–0.845 m: 2.5 cm
    //     clear of the PV end rows (edge 0.72) and of the collar cluster.
    //   • TANGENTIAL bells are canted RCS_TANG_CANT (18°) radially outward: an
    //     uncanted ±X plume runs parallel just ~0.44 m above the wing plane and a
    //     ~25° cold-gas boundary would clip the outer wing beyond ~0.8 m; the
    //     cant lifts the boundary clear (≥0.24 m above the plane at the wing tip)
    //     while still firing at cos18°=0.95 intensity for ±X demand.
    const RCS_POD_Z    = 0.795;   // m — pod centre |z| station (fore/aft)
    const RCS_POD_W    = 0.12;    // m — tangential width
    const RCS_POD_L    = 0.10;    // m — axial length
    const RCS_POD_H    = 0.055;   // m — radial height
    const RCS_BURY     = 0.010;   // m — housing base buried below hull (no under-gap, no plinth)
    const RCS_BELL_LEN = 0.06;    // m — nozzle bell length (throat 0.015 → exit 0.025), ~25% smaller
    const RCS_TANG_CANT = 18 * Math.PI / 180;  // rad — tangential bell outward cant (ROSA plume clearance)

    // Liner inset: the RCS exit is now 0.025 m, so 0.88 would leave only 3.0 mm
    // (< 4 mm log-depth minimum). 0.82 gives 0.025·0.18 = 4.5 mm — deterministic
    // tie-pass at the bell mouth.
    const RCS_LINER_INSET = 0.82;

    // Azimuth columns: SNAPPED to 90°/270° so each pod is centred on the body PV
    // "gap" cells that sit at exactly 90°/270° (see the fore/aft gap-cell loop in
    // _buildMainBus) — the nearest solar panels on the mother body. 90° stays
    // ~11° clear of the weaver pocket (edge ~78.6°) and ~21° clear of the spinner
    // pocket (edge ~110.7°), so the groove-clearance guard (≥2°) still holds. The
    // SSOT half-widths are still read below only for the clearance context; the
    // column azimuth itself is now panel-anchored, not window-centred.
    const barrelR_m = Constants.OCTOPUS_V5?.COLLAR_RADIUS ?? 0.40;
    const RCS_POD_AZ_DEG = [90, 270];

    const podGeo = new THREE.BoxGeometry(M * RCS_POD_W, M * RCS_POD_L, M * RCS_POD_H);
    const podMat = new THREE.MeshStandardMaterial({
      color: 0x9090a8, metalness: 0.72, roughness: 0.30,   // 6061-T6 CNC (matches A-frame gray)
    });
    // §3 MLI close-out boot — the darker gold/bronze frame/lip where the housing
    // emerges from the blanket (close-out tape read). One per pod, buried base.
    const bootMat = new THREE.MeshStandardMaterial({
      color: 0x6e5a30, metalness: 0.55, roughness: 0.55,   // darker gold/bronze close-out
    });
    const bootGeo = new THREE.BoxGeometry(
      M * (RCS_POD_W + 0.006), M * (RCS_POD_L + 0.016), M * 0.012,
    );
    // §3 Corner bolts — Ti fasteners on the housing outer face (Ti recipe; the
    // collar's boltMat is function-local to _buildCollar, so a fresh one here).
    const podBoltMat = new THREE.MeshStandardMaterial({
      color: 0x99aabb, metalness: 0.80, roughness: 0.20,
    });
    const podBoltGeo = new THREE.CylinderGeometry(M * 0.004, M * 0.004, M * 0.005, 6);
    // 14-seg bells (was 10): pods are end-mounted focal hardware at inspect zoom.
    // Throat 0.015 → exit 0.025 (Ø50 mm), 0.06 m long — ~25% smaller than rev 1.
    const bellGeo = new THREE.CylinderGeometry(M * 0.015, M * 0.025, M * RCS_BELL_LEN, 14, 1, true);
    const linerGeo = new THREE.CylinderGeometry(
      M * 0.015 * RCS_LINER_INSET, M * 0.025 * RCS_LINER_INSET, M * RCS_BELL_LEN, 14, 1, true,
    );
    const linerMat = new THREE.MeshStandardMaterial({
      color: 0x22242c, metalness: 0.6, roughness: 0.5,     // dark cold-gas throat
      side: THREE.BackSide,
    });
    // Throat cap (injector/poppet plate) — closes the small throat aperture so
    // that LOOKING DOWN THE BELL shows a dark injector face, not an open hole
    // through the throat into the housing/hull. Mirrors the FEEP grid-disc idea.
    // Reused across all 12 bells; oriented per-bell as a child of the bell.
    const throatCapGeo = new THREE.CircleGeometry(M * 0.015 * RCS_LINER_INSET, 14);
    const throatCapMat = new THREE.MeshStandardMaterial({
      color: 0x15161c, metalness: 0.55, roughness: 0.6,    // darker than the liner (recessed injector)
      side: THREE.DoubleSide, emissive: 0x000000,
    });
    // RCS plume — diverging cold-gas puff (Phase 4): short/puffy, white-gray cold
    // gas (NOT ion blue). Near end welds to the nozzle exit; +Y beam axis aimed
    // along each nozzle's exhaust dir. Scaled ~0.75× to match the smaller bell.
    const rcsPlumeGeo = makePlumeFrustum(M * 0.015, M * 0.041, M * 0.10, 8, 2);
    const rcsPlumeMat = new THREE.MeshBasicMaterial({
      color: 0xccd2dc, transparent: true, opacity: 0.0, vertexColors: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const yUpBeam = new THREE.Vector3(0, 1, 0);  // bell/plume geometry axis

    // Per-nozzle exhaust dirs + local positions — direction-aware firing (a
    // nozzle lights when its EXHAUST opposes the thrust demand) and puff-spawn
    // snapping. Replaces the radial-only `_rcsOutward`.
    this._rcsExhaustDir = [];
    this._rcsNozzleLocalPos = [];
    // Per-bell liner meshes (index-aligned with attitudeThrusterPlumes) so the
    // plume loop can brighten only the firing bells' throats. Liners get a CLONED
    // material each (was a single shared linerMat) — a shared material would light
    // all 12 throats whenever any one fires.
    this._rcsLiners = [];

    /** Build one bell+liner+plume cluster. exhaustDir = unit vector the plume
     *  exits along (bell throat faces −exhaustDir, wide mouth faces exhaust). */
    const buildNozzle = (name, centre, exhaustDir) => {
      const bell = new THREE.Mesh(bellGeo, this._matRCS);
      bell.position.copy(centre);
      // CylinderGeometry: +Y = radiusTop (throat 0.015), −Y = radiusBottom (exit
      // 0.025). Map +Y → −exhaust so the wide mouth flares along the exhaust —
      // the OLD build had this backwards (bells flared into the hull).
      bell.quaternion.setFromUnitVectors(yUpBeam, _v3TmpA.copy(exhaustDir).negate());
      bell.name = name;
      this.add(bell);
      this.attitudeThrusters.push(bell);

      const liner = new THREE.Mesh(linerGeo, linerMat.clone());
      liner.name = name.replace('RCSThruster', 'RCSLiner');
      liner.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      bell.add(liner);   // inherits bell orientation; concentric inset cone
      this._rcsLiners.push(liner);   // index-aligned with attitudeThrusterPlumes

      // Throat cap at the +Y (throat) end, inset 2 mm toward the exit so it sits
      // just inside the throat. Normal faces −Y (out the mouth) so it's visible
      // looking down the bell. Child of bell → inherits orientation.
      const throatCap = new THREE.Mesh(throatCapGeo, throatCapMat);
      throatCap.position.set(0, M * (RCS_BELL_LEN / 2 - 0.002), 0);
      throatCap.rotation.x = Math.PI / 2;   // circle normal +Z → −Y (out the mouth)
      throatCap.name = name.replace('RCSThruster', 'RCSThroat');
      throatCap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      bell.add(throatCap);

      const exit = _v3TmpB.copy(centre).addScaledVector(exhaustDir, M * (RCS_BELL_LEN / 2));
      const plume = new THREE.Mesh(rcsPlumeGeo, rcsPlumeMat.clone());
      plume.position.copy(exit).addScaledVector(exhaustDir, M * 0.005);
      plume.quaternion.setFromUnitVectors(yUpBeam, exhaustDir);  // +Y beam → exhaust
      plume.name = name.replace('RCSThruster', 'RCSPlume');
      plume.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
      plume.visible = false;
      this.add(plume);
      this.attitudeThrusterPlumes.push(plume);

      this._rcsExhaustDir.push(exhaustDir.clone());
      // Puff origin = the nozzle MOUTH (exit + 1 cm outward), NOT the bell centre:
      // a glow at the centre sits inside the bell cone and gets occluded by the
      // (now depth-tested) bell wall, reading as "in the wrong place". Spawning at
      // the mouth matches the plume and reads as gas leaving the nozzle. Torque
      // sign is unchanged (same radial line, slightly longer arm).
      const puffOrigin = _v3TmpB.copy(centre).addScaledVector(exhaustDir, M * (RCS_BELL_LEN / 2 + 0.01));
      this._rcsNozzleLocalPos.push(puffOrigin.clone());
    };

    let podIdx = 0;
    for (let col = 0; col < RCS_POD_AZ_DEG.length; col++) {
      const az = RCS_POD_AZ_DEG[col] * Math.PI / 180;
      const azSign = col === 0 ? 1 : -1;   // +Y column (0) / −Y column (1)
      const radial = new THREE.Vector3(Math.cos(az), Math.sin(az), 0);
      const podBasis = new THREE.Matrix4().makeBasis(
        new THREE.Vector3().crossVectors(new THREE.Vector3(0, 0, 1), radial).normalize(), // tangent
        new THREE.Vector3(0, 0, 1),
        radial,
      );

      for (const station of [1, -1]) {   // fore (+z) / aft (−z)
        const podZ = station * M * RCS_POD_Z;

        // Doghouse housing — SEMI-RECESSED, NO plinth. Its base is buried
        // RCS_BURY (10 mm) below the hull surface so the flat bottom edges land
        // inside the hull and no under-gap shows (box sides cross the MLI at a
        // steep angle → no z-fight). The housing centre sits at hull − BURY +
        // half-height; its outer face is faceR.
        const housingBaseR = M * (barrelR_m - RCS_BURY);   // base buried below hull
        const podR = housingBaseR + M * (RCS_POD_H / 2);
        const pod = new THREE.Mesh(podGeo, podMat);
        pod.position.set(radial.x * podR, radial.y * podR, podZ);
        pod.quaternion.setFromRotationMatrix(podBasis);
        pod.name = `RCSPod_${podIdx}`;
        pod.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
        this.add(pod);

        // §3 MLI close-out boot: a low lip framing the housing where it emerges
        // from the blanket. Base buried like the housing (bottom at hull −4 mm),
        // top ~8 mm proud. Its centre radius = hullR − 4 mm + 6 mm = hullR + 2 mm.
        const bootR = M * (barrelR_m + 0.002);
        const boot = new THREE.Mesh(bootGeo, bootMat);
        boot.position.set(radial.x * bootR, radial.y * bootR, podZ);
        boot.quaternion.setFromRotationMatrix(podBasis);
        boot.name = `RCSPodBoot_${podIdx}`;
        boot.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
        this.add(boot);

        // §3 Corner bolts: 4 on the housing outer face, inset ~12 mm from the
        // face corners, oriented radially. Positioned in pod-local space (x =
        // tangential, y = axial, z = radial) then baked into the mother frame via
        // pod.matrix and parented to `this` — attaching them as pod children makes
        // Box3.setFromObject miss the pod transform for the placement guards.
        pod.updateMatrix();
        const boltInsetX = M * (RCS_POD_W / 2 - 0.012);
        const boltInsetY = M * (RCS_POD_L / 2 - 0.012);
        const boltZ = M * (RCS_POD_H / 2);   // on the outer face
        let boltN = 0;
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            const bolt = new THREE.Mesh(podBoltGeo, podBoltMat);
            bolt.position.set(sx * boltInsetX, sy * boltInsetY, boltZ);
            bolt.rotation.x = Math.PI / 2;   // +Y → pod-local +z (radial)
            bolt.updateMatrix();
            bolt.applyMatrix4(pod.matrix);   // bake pod transform → mother-local
            bolt.name = `RCSPodBolt_${podIdx}_${boltN}`;
            bolt.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
            this.add(bolt);
            boltN++;
          }
        }

        const faceR = podR + M * (RCS_POD_H / 2);  // housing outer face radius (~0.445 m)

        // RADIAL nozzle: on the outer face, exhaust radially outward (±Y column).
        const radialCentre = new THREE.Vector3(
          radial.x * (faceR + M * RCS_BELL_LEN / 2),
          radial.y * (faceR + M * RCS_BELL_LEN / 2),
          podZ,
        );
        buildNozzle(`RCSThruster_${podIdx}_R`, radialCentre, radial.clone());

        // AXIAL nozzle: corner-mounted at the pod's outboard-z edge, buried 3 mm
        // into the housing face, exhaust ±Z (fore pods +Z, aft −Z). Its whole
        // radial span stays OUTSIDE the collar rings (max r ~0.415) as its mouth
        // passes the collar z-band (test-RcsPlacement guards the meridian gap).
        const axialR = faceR + M * (0.025 - 0.003);   // exit r 0.025 − 3 mm bury
        const axialCentre = new THREE.Vector3(
          radial.x * axialR,
          radial.y * axialR,
          podZ + station * M * (RCS_POD_L / 2 - 0.02),
        );
        buildNozzle(`RCSThruster_${podIdx}_A`, axialCentre, new THREE.Vector3(0, 0, station));

        // TANGENTIAL nozzle: canted RCS_TANG_CANT (18°) radially OUTWARD from the
        // pure ±X axis so its cold-gas plume boundary clears the ROSA wing plane
        // (an uncanted ±X plume runs parallel just above the blanket and would
        // clip the outer wing). Still fires at cos18°=0.95 for ±X demand. The ±X
        // sign is distributed across the 4 pods (fore/aft × col) so BOTH +X and
        // −X exhaust exist somewhere:
        //   +Y col: fore→+X, aft→−X ;  −Y col: fore→−X, aft→+X.
        const tangSignX = station * azSign;
        const tangDir = new THREE.Vector3(tangSignX, 0, 0)
          .multiplyScalar(Math.cos(RCS_TANG_CANT))
          .addScaledVector(radial, Math.sin(RCS_TANG_CANT))
          .normalize();
        const tangCentre = new THREE.Vector3(
          radial.x * faceR,
          radial.y * faceR,
          podZ,
        ).addScaledVector(tangDir, M * (RCS_BELL_LEN / 2));
        buildNozzle(`RCSThruster_${podIdx}_T`, tangCentre, tangDir);

        podIdx++;
      }
    }

    // Per-nozzle ATTITUDE flash intensity (Phase 3 §1): rotation demand lights
    // the couple bells' plume cones/liners directly, decoupled from the puff
    // cadence. Index-aligned with attitudeThrusterPlumes / _rcsLiners.
    this._rcsAttitudeFlash = new Float32Array(this.attitudeThrusterPlumes.length);
  }

  // --------------------------------------------------------------------------
  // 3. Solar Panels
  // --------------------------------------------------------------------------
  /**
   * @private — Epic 10 V-5: ROSA (Roll-Out Solar Array) panels.
   *
   * Replaces V3-era accordion wings with two compact ROSA panels at
   * 0° and 180° azimuths (±X from barrel centre).
   *
   * Scene hierarchy per wing:
   * ```
   *   panelRightPivot (Group — sun-tracking tilt / feather rotation)
   *     ├─ _rosaPanelWrapper1 (Group — scale.x drives roll-out)
   *     │    ├─ ROSA_Panel_Front_0deg (PlaneGeometry — FrontSide cell-string surface, local z = +2 mm)
   *     │    └─ ROSA_Panel_Back_0deg  (PlaneGeometry — BackSide copper-Kapton substrate, local z = −2 mm)
   *     └─ ROSA_Roll_0deg             (CylinderGeometry — stowed roll)
   * ```
   *
   * Accuracy pass (Option B): the blanket is a plain square-cornered rectangle
   * (real ROSA wings are NOT chamfered) carrying the shared procedural solar-cell
   * texture, so the former coplanar wireframe-grid + gold-edge decal stack (and
   * their depthTest:false hacks) are gone — the texture now carries the cell
   * detail. The slit-tube booms (built in `_buildRosaStructure`) provide the edge
   * structure. UVs are oriented so the cell strings run along the deploy/X axis.
   */
  _buildSolarPanels() {
    const V5      = Constants.OCTOPUS_V5;
    const rosaW   = V5.ROSA_WIDTH * M;       // 1.0 m → scene (radial deploy / X)
    const rosaL   = V5.ROSA_LENGTH * M;      // 2.0 m → scene (axial / Y→world Z)
    const barrelR = V5.COLLAR_RADIUS * M;    // 0.4 m → scene

    // ── Materials ──────────────────────────────────────────────
    // Front = dark GaAs cell strings via the shared procedural texture. The
    // texture's "tall" cells (rows>cols) are oriented so cell strings run along
    // the deploy/X axis: repeat u (width, 1.0 m) ≈ 3 cells, v (length, 2.0 m)
    // ≈ 6 cells. getSolarCellTexture returns null in headless (no DOM) — the
    // material tolerates a null map (tint falls back to the dark cell colour).
    const cellTex = getSolarCellTexture();
    let frontMap = null;
    if (cellTex) {
      frontMap = cellTex.clone();
      frontMap.repeat.set(3, 6);   // ~3 cells across width × 6 along length
      frontMap.needsUpdate = true;
    }
    // The cell strings carry a royal-blue self-illumination (see _animateRosaGlow,
    // which pulses the emissive with generated power). The TEAL the wings used to
    // read came from `iridescence` (a ≈420 nm thin-film over the sun's specular),
    // NOT the emissive — so iridescence is removed and the wings now read a clean
    // royal blue. The emissive is intentionally NOT masked by an emissiveMap: the
    // dark cell texture would bury the glow, and the uniform royal-blue glow is the
    // look that reads well in BOTH the menu hero and gameplay. Props stay inert
    // without WebGL, so this is safe in headless tests. Front mats are tracked in
    // _rosaFrontMats so the glow + scan-flash can drive their emissive.
    const panelMatFront = new THREE.MeshPhysicalMaterial({
      color: frontMap ? 0xffffff : 0x0a1133, // tint comes from the map when present
      map: frontMap || null,
      // Softer specular response: real PV blankets carry an anti-reflective
      // coating and read fairly matte, not mirror-like. Lower metalness + higher
      // roughness, plus a much weaker/rougher clearcoat, keep the sun glint from
      // blowing out to white under the intensity-2.0 sun + ACES tonemapping.
      metalness: 0.25, roughness: 0.62,
      side: THREE.FrontSide,
      emissive: 0x1e3cff, emissiveIntensity: 0.30, // royal blue (matches _animateRosaGlow)
      clearcoat: 0.3, clearcoatRoughness: 0.5,
      iridescence: 0.0, // was 0.5 → produced the TEAL thin-film sheen; removed
    });
    this._rosaFrontMats = [panelMatFront];
    // Back substrate = deep amber-brown copper-Kapton (real ROSA blanket backing
    // reads dark amber, not beige). Task 3 (F3): the backside now carries a
    // procedural copper-Kapton substrate map (bay-seam grid + stiffener strips +
    // wiring runs + per-bay jitter) so it no longer reads as flat untextured
    // cardboard at the common top-down inspect angle. Near-matte (very low
    // metalness, high roughness) like real Kapton foil. A modest emissive gives a
    // self-illuminating floor so the substrate never collapses to pure black when
    // its face is turned away from the sun / in shadow — the fix for the
    // "inverted Mother's ROSA wings vanish / dark rectangle on Earth" regression.
    // Keep emissiveIntensity at/above the ROSA_BACK_EMISSIVE_MIN (0.24) floor
    // asserted in js/test/test-RosaFurl.js. Emissive stays UN-masked (never-black
    // floor) — same rationale as the front mat.
    let backMap = null;
    const rosaBackTex = getRosaBackTexture();
    if (rosaBackTex) {
      backMap = rosaBackTex.clone();
      backMap.repeat.set(2, 5);   // ~2 bay-cols across width × 5 bays along length
      backMap.needsUpdate = true;
    }
    const panelMatBack = new THREE.MeshStandardMaterial({
      color: backMap ? 0xffffff : 0x7a4f26, // tint comes from the map when present
      map: backMap || null,
      metalness: 0.08, roughness: 0.85,
      side: THREE.BackSide,
      emissive: 0x3e2c14, emissiveIntensity: 0.25,
    });
    const rollMat = new THREE.MeshStandardMaterial({
      color: 0x333344, metalness: 0.5, roughness: 0.4,
    });

    // ── Square-cornered blanket planes (local XY, rotated to XZ via wrapper) ──
    // §2-followup (z-layer-and-lights-fix Batch 2, Option A): the front + back
    // blanket faces are the user-confirmed "solar cells" flicker source. They
    // WERE both at local z=0 (exactly coincident); under logarithmicDepthBuffer
    // two near-parallel surfaces at equal depth shimmer at the wing's edge-on
    // sweep even with complementary Front/BackSide culling. Fix: give the blanket
    // a real 4 mm thickness — front at +M*0.002 (2 mm), back at −M*0.002 (2 mm) —
    // so the faces never tie. (Kept as two named meshes, NOT a merged box, because
    // test-RosaFurl.js + the inverted-visibility guard bind ROSA_Panel_Front/Back
    // and their Front/BackSide semantics.) These offsets are M-SCALED mm: 1 scene
    // unit = 100 km, so M*0.002 = 2 mm. The old raw −0.001 was −100 m (see the
    // panel1Back note) — always multiply real mm by M here.
    // Z2: the inboard edge is also pushed +M*0.005 (5 mm) outboard so it starts
    // clear of the bus; the root drum/bracket masks the small gap. Furled
    // (wrapper scale.x→0) collapses the panel toward the pivot — visually unchanged.
    const ROSA_HALF_THICK = M * 0.002;   // 2 mm — half the blanket thickness (Z1)
    const ROSA_INBOARD_GAP = M * 0.005;  // 5 mm — inboard-edge standoff (Z2)
    const panelGeo = new THREE.PlaneGeometry(rosaW, rosaL);
    const rollGeo  = new THREE.CylinderGeometry(M * 0.05, M * 0.05, rosaL, 16);  // was 8-seg (2 m-long visible roll)

    // ── Shared solar array pivot — groups both wings as one rigid
    //    assembly so they stay coplanar through the satellite centre. ──
    // No Z-rotation: panels extend ±X (orbit-normal direction), which
    // projects as horizontal wings from the CHASE camera.
    // Sun-tracking is handled per-panel via boom-axis tilt (pivot.rotation.x).
    this._solarArrayPivot = new THREE.Group();
    this._solarArrayPivot.name = 'SolarArrayPivot';
    this.add(this._solarArrayPivot);

    // ── Panel 1: 0° azimuth (+X) ─────────────────────────────
    this.panelRightPivot = new THREE.Group();
    this.panelRightPivot.position.set(barrelR, 0, 0);
    this.panelRightPivot.name = 'PanelRightPivot';
    this._solarArrayPivot.add(this.panelRightPivot);

    this._rosaPanelWrapper1 = new THREE.Group();
    // Wrapper at pivot origin — shape starts at local x=0 (barrel surface)
    this._rosaPanelWrapper1.rotation.x = -Math.PI / 2; // local XY → world XZ
    this.panelRightPivot.add(this._rosaPanelWrapper1);

    const panel1Front = new THREE.Mesh(panelGeo, panelMatFront);
    panel1Front.position.set(rosaW / 2 + ROSA_INBOARD_GAP, 0, ROSA_HALF_THICK); // +2 mm proud (Z1), +5 mm inboard gap (Z2)
    panel1Front.name = 'ROSA_Panel_Front_0deg';
    panel1Front.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
    this._rosaPanelWrapper1.add(panel1Front);

    // Back substrate: 4 mm behind the front face (local z = −2 mm) so the blanket
    // reads as a real thin panel, not a zero-thickness sheet. FrontSide/BackSide
    // remain complementary (only one rasterizes per camera) AND now sit at
    // distinct depths, so the edge-on sweep no longer shimmers. (A previous −0.001
    // "1 mm" offset was actually −100 m: 1 scene unit = 100 km, so it flung the
    // back face 100 m off and opened a dead zone where the inverted wing rendered
    // nothing. All offsets here are M-scaled real mm — never raw literals.)
    const panel1Back = new THREE.Mesh(panelGeo, panelMatBack);
    panel1Back.position.set(rosaW / 2 + ROSA_INBOARD_GAP, 0, -ROSA_HALF_THICK);
    panel1Back.name = 'ROSA_Panel_Back_0deg';
    panel1Back.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
    this._rosaPanelWrapper1.add(panel1Back);

    this._rosaRoll1 = new THREE.Mesh(rollGeo, rollMat);
    this._rosaRoll1.position.set(M * 0.05, 0, 0); // just beyond barrel edge
    this._rosaRoll1.rotation.x = Math.PI / 2; // Y-axis → Z-axis (barrel axis)
    this._rosaRoll1.name = 'ROSA_Roll_0deg';
    this.panelRightPivot.add(this._rosaRoll1);

    // ── ROSA structural detail: edge booms + tip spreader + root drum/bracket ──
    this._buildRosaStructure(1, this._rosaPanelWrapper1, this.panelRightPivot, +1);

    // ── Panel 2: 180° azimuth (-X) ───────────────────────────
    this.panelLeftPivot = new THREE.Group();
    this.panelLeftPivot.position.set(-barrelR, 0, 0);
    this.panelLeftPivot.name = 'PanelLeftPivot';
    this._solarArrayPivot.add(this.panelLeftPivot);

    this._rosaPanelWrapper2 = new THREE.Group();
    this._rosaPanelWrapper2.rotation.x = -Math.PI / 2;
    this.panelLeftPivot.add(this._rosaPanelWrapper2);

    const panel2Front = new THREE.Mesh(panelGeo, panelMatFront);
    panel2Front.position.set(-(rosaW / 2 + ROSA_INBOARD_GAP), 0, ROSA_HALF_THICK); // mirrored; +2 mm proud, +5 mm gap
    panel2Front.name = 'ROSA_Panel_Front_180deg';
    panel2Front.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
    this._rosaPanelWrapper2.add(panel2Front);

    const panel2Back = new THREE.Mesh(panelGeo, panelMatBack); // −2 mm behind front: see panel1Back note
    panel2Back.position.set(-(rosaW / 2 + ROSA_INBOARD_GAP), 0, -ROSA_HALF_THICK);
    panel2Back.name = 'ROSA_Panel_Back_180deg';
    panel2Back.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
    this._rosaPanelWrapper2.add(panel2Back);

    this._rosaRoll2 = new THREE.Mesh(rollGeo, rollMat);
    this._rosaRoll2.position.set(-M * 0.05, 0, 0); // just beyond barrel edge
    this._rosaRoll2.rotation.x = Math.PI / 2;
    this._rosaRoll2.name = 'ROSA_Roll_180deg';
    this.panelLeftPivot.add(this._rosaRoll2);

    this._buildRosaStructure(2, this._rosaPanelWrapper2, this.panelLeftPivot, -1);

    // ── Default state: fully deployed ─────────────────────────
    this._setRosaWingProgress(1, 1.0);
    this._setRosaWingProgress(2, 1.0);
  }

  /**
   * @private Apply roll-out progress to one ROSA wing.
   * @param {1|2} wing  — 1 = +X (0°), 2 = -X (180°)
   * @param {number} progress  — 0 (stowed) → 1 (deployed)
   */
  _setRosaWingProgress(wing, progress) {
    const wrapper = wing === 1 ? this._rosaPanelWrapper1 : this._rosaPanelWrapper2;
    const roll    = wing === 1 ? this._rosaRoll1 : this._rosaRoll2;
    const struct  = wing === 1 ? this._rosaStruct1 : this._rosaStruct2;
    // Booms + spreader live INSIDE the wrapper, so scale.x stretches/extends
    // them with the blanket automatically. The blanket starts at 5% (a thin
    // rolled stub) and grows to full width as progress → 1.
    if (wrapper) wrapper.scale.x = 0.05 + 0.95 * progress;
    if (roll)    roll.visible = progress < 0.5;

    if (struct) {
      // Spool spin: the blanket reels off the drum as it deploys, so spin the
      // drum + coil about their long axis proportional to the length paid out.
      // ~6 turns across the full stroke reads as a real reeling mechanism.
      const spin = (1 - progress) * Math.PI * 2 * 6 * (struct.sign || 1);
      if (struct.drum)     struct.drum.rotation.y = spin;
      if (struct.stowRoll) struct.stowRoll.rotation.y = spin;

      // Stowed-roll bulge: a fat coil of blanket+booms when stowed, shrinking to
      // a bare mandrel as the wing rolls out (real ROSA stores like a tape measure).
      if (struct.stowRoll) {
        const r = 1 + 2 * (1 - progress);       // DRUM_R (deployed) → ~3× (stowed)
        struct.stowRoll.scale.set(r, 1, r);
        struct.stowRoll.visible = progress < 0.98; // hide the bulge when fully out
      }

      // Slit-tube spool curls: the strain-energy tape-spring uncoiling. When
      // furled the tape tucks back toward the coil (extra wrap); as it deploys it
      // lays flat into the boom line. A short damped overshoot as progress crosses
      // ~0.85→1 gives the elastic "snap" of a composite boom locking straight.
      if (struct.curls && struct.curls.length) {
        const tuck = (1 - progress) * (Math.PI / 2);      // 0 (flat) → 90° (coiled)
        let snap = 0;
        if (progress > 0.85) {
          const u = (progress - 0.85) / 0.15;             // 0→1 over the last 15%
          snap = Math.sin(u * Math.PI * 2) * 0.12 * (1 - u); // damped wobble, rad
        }
        for (const curl of struct.curls) {
          const base = curl.userData.baseRotZ || 0;
          curl.rotation.z = base + (struct.sign || 1) * (tuck + snap);
        }
      }
    }
  }

  /**
   * @private Build the structural detail for one ROSA wing — the two
   * high-strain composite edge booms (one per long edge), the tip spreader
   * bar, the root roller drum/mandrel (with a stowed-coil bulge), and the
   * mounting bracket standing the wing off the bus mast. Verified against the
   * real Redwire/NASA ROSA layout (slit-tube booms on BOTH long edges, blanket
   * rolled onto a root spool).
   *
   * Booms + spreader are parented to `wrapper` so the wing's `scale.x` roll-out
   * extends them to track the blanket edge. The drum/bracket are parented to
   * `pivot` (root-fixed, do not stretch).
   *
   * @param {1|2} wing
   * @param {THREE.Group} wrapper  — the scale.x roll-out wrapper (local XY)
   * @param {THREE.Group} pivot    — the sun-tracking pivot (root-fixed)
   * @param {number} sign          — +1 for +X wing, -1 for -X wing
   * @private
   */
  _buildRosaStructure(wing, wrapper, pivot, sign) {
    const V5      = Constants.OCTOPUS_V5;
    const rosaW   = V5.ROSA_WIDTH * M;
    const rosaL   = V5.ROSA_LENGTH * M;
    const boomOD  = V5.ROSA_BOOM_OD * M;
    const sprOD   = V5.ROSA_SPREADER_OD * M;
    const drumR   = V5.ROSA_DRUM_R * M;
    const brkLen  = V5.ROSA_BRACKET_LEN * M;

    // Root of the rolled blanket. The spool/drum sits this far OUTBOARD of the
    // sun-tracking pivot (the pivot is at the bus collar, barrelR from centre).
    // The blanket, both edge booms and the tip spreader all live in `wrapper`,
    // so anchoring the wrapper at the drum makes the blanket's INBOARD edge
    // start at the drum. Without this the wrapper sat at the pivot while the
    // drum sat rootX outboard, so the blanket spanned [pivot → tip] and a ~8 cm
    // strip poked INBOARD of the drum toward the bus (the "narrow strip extends
    // in" artifact). scale.x rolls the blanket out from this drum-anchored
    // origin, so the inboard edge stays pinned at the drum at every furl state.
    const rootX = brkLen + drumR * 0.4;
    wrapper.position.x = sign * rootX;

    // Near-black carbon-composite boom material (real ROSA slit-tube high-strain
    // spars read dark, not pale) — low metalness, mid roughness for a matte
    // composite finish.
    const boomMat = new THREE.MeshStandardMaterial({
      color: 0x1c1c20, metalness: 0.2, roughness: 0.6,
    });
    const drumMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a33, metalness: 0.6, roughness: 0.4,
    });

    // Retained handles animated by _setRosaWingProgress: the spool drum + coil
    // (spin/scale as the blanket reels) and the slit-tube curls (uncoil + snap).
    const struct = { stowRoll: null, drum: null, curls: [], sign };

    // Tiny anti-z-fight nudge that lifts the booms/spreader just off the blanket
    // plane. MUST be M-scaled: 1 scene unit = 100 km, so a raw literal like
    // 0.0008 is ~80 m — ~80× the panel width — which flung the structure far off
    // the blanket (same unit-mismatch class as the fixed back-face −0.001 = −100 m
    // bug). Half the boom radius sits the tube tangent to the blanket surface.
    const zNudge = boomOD * 0.6; // ≈ 1.2 cm in metres, M-scaled (~1.2e-7 scene units)

    // ── Two edge booms — run along X (roll-out dir) at both long edges (±Y) ──
    // Cylinder default axis is Y; rotate Z by 90° so it lies along local X.
    // Booms are added on BOTH faces (±zNudge): the front pair sits on the cell
    // side, the back pair on the copper-Kapton substrate side so the featureless
    // back face now carries matching structure. All parented to `wrapper` so the
    // roll-out scale.x extends them with the blanket. (Booms are not in `struct`
    // handles, so _setRosaWingProgress leaves them untouched — safe.)
    const boomGeo = new THREE.CylinderGeometry(boomOD / 2, boomOD / 2, rosaW, 6);
    for (const edgeY of [rosaL / 2, -rosaL / 2]) {
      for (const face of [zNudge, -zNudge]) {
        const boom = new THREE.Mesh(boomGeo, boomMat);
        boom.rotation.z = Math.PI / 2;           // Y-axis → X-axis (blanket length)
        // Center at half-width so it spans local x ∈ [0, rosaW]; for the -X wing
        // the wrapper geometry runs x ∈ [-rosaW, 0], so mirror via sign.
        boom.position.set(sign * rosaW / 2, edgeY, face);
        // Keep the original front-boom names (asserted in test-RosaFurl.js); the
        // new back-face pair gets a distinct "_K" (Kapton side) suffix.
        boom.name = (face > 0)
          ? `ROSA_Boom_${wing === 1 ? '0' : '180'}deg_${edgeY > 0 ? 'A' : 'B'}`
          : `ROSA_Boom_${wing === 1 ? '0' : '180'}deg_${edgeY > 0 ? 'A' : 'B'}_K`;
        boom.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
        wrapper.add(boom);
      }
    }

    // ── Tip spreader bar — at the outboard edge (x = ±rosaW), spans width (Y) ──
    const sprGeo = new THREE.CylinderGeometry(sprOD / 2, sprOD / 2, rosaL, 6);
    const spreader = new THREE.Mesh(sprGeo, boomMat);
    spreader.position.set(sign * rosaW, 0, zNudge); // rides to deployed tip via scale.x (M-scaled nudge)
    spreader.name = `ROSA_Spreader_${wing === 1 ? '0' : '180'}deg`;
    spreader.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    wrapper.add(spreader);

    // ── Slit-tube spool curls — short quarter-tori where each boom peels off
    //    the root drum and flattens into the blanket plane. This is the signature
    //    ROSA "uncoiling tape measure" read, animated by _setRosaWingProgress:
    //    they tuck toward the coil when furled and lay out flat when deployed,
    //    with a small elastic overshoot as the strain-energy boom snaps straight.
    //    Root-fixed (parented to pivot) so they do NOT stretch with scale.x. ──
    // A TorusGeometry sweeps in its local XY plane about the local Z axis (the
    // barrel axis), so the arc rises from the drum (zenith) and lays out radially.
    const curlGeo = new THREE.TorusGeometry(drumR, boomOD / 2, 6, 12, Math.PI / 2);
    const curls = [];
    for (const edgeZ of [rosaL / 2, -rosaL / 2]) {
      const curl = new THREE.Mesh(curlGeo, boomMat);
      curl.position.set(sign * rootX, 0, sign > 0 ? edgeZ : -edgeZ);
      // Mirror the sweep direction for the -X wing so both curls open outboard.
      curl.userData.baseRotZ = sign > 0 ? 0 : Math.PI;
      curl.rotation.z = curl.userData.baseRotZ;
      curl.name = `ROSA_SpoolCurl_${wing === 1 ? '0' : '180'}deg_${edgeZ > 0 ? 'A' : 'B'}`;
      curl.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      pivot.add(curl);
      curls.push(curl);
    }
    struct.curls = curls;
    struct.sign = sign;

    // ── Root mounting brackets — three short standoffs from the bus mast to the
    //    drum (one central + two flanking), giving the root a real truss read. ──
    const brkGeo = new THREE.BoxGeometry(brkLen, drumR * 1.2, drumR * 0.6);
    const bracket = new THREE.Mesh(brkGeo, drumMat);
    bracket.position.set(sign * brkLen / 2, 0, 0);
    bracket.name = `ROSA_Bracket_${wing === 1 ? '0' : '180'}deg`;
    pivot.add(bracket);

    // Two flanking brackets offset along the drum axis (barrel Z), narrower.
    const brkSideGeo = new THREE.BoxGeometry(brkLen * 0.9, drumR * 0.9, drumR * 0.4);
    for (const zOff of [rosaL * 0.32, -rosaL * 0.32]) {
      const brkSide = new THREE.Mesh(brkSideGeo, drumMat);
      brkSide.position.set(sign * brkLen / 2, 0, zOff);
      brkSide.name = `ROSA_Bracket_${wing === 1 ? '0' : '180'}deg_${zOff > 0 ? 'A' : 'B'}`;
      pivot.add(brkSide);
    }

    // ── Spool assembly — drum/mandrel + stowed-coil bulge share a pivot whose
    //    local Y is the barrel axis, so spinning each mesh about its own long
    //    axis (rotation.y) reads as the blanket reeling on/off the spool. ──
    const spoolPivot = new THREE.Group();
    spoolPivot.rotation.x = Math.PI / 2;                 // long axis → barrel Z
    spoolPivot.position.set(sign * rootX, 0, 0);
    spoolPivot.name = `ROSA_Spool_${wing === 1 ? '0' : '180'}deg`;
    pivot.add(spoolPivot);

    // Root roller drum / mandrel — the bare spool the blanket rolls onto.
    const drumGeo = new THREE.CylinderGeometry(drumR, drumR, rosaL * 1.02, 16);  // was 12-seg
    const drum = new THREE.Mesh(drumGeo, drumMat);
    drum.name = `ROSA_Drum_${wing === 1 ? '0' : '180'}deg`;
    spoolPivot.add(drum);
    struct.drum = drum;

    // Stowed-coil bulge — coaxial fat roll of blanket when stowed, shrinking to a
    // bare mandrel as the wing rolls out (scaled radially by _setRosaWingProgress).
    const coilGeo = new THREE.CylinderGeometry(drumR * 1.05, drumR * 1.05, rosaL, 16);  // was 12-seg (match drum)
    const stowRoll = new THREE.Mesh(coilGeo, drumMat);
    stowRoll.name = `ROSA_StowRoll_${wing === 1 ? '0' : '180'}deg`;
    spoolPivot.add(stowRoll);
    struct.stowRoll = stowRoll;

    if (wing === 1) this._rosaStruct1 = struct;
    else            this._rosaStruct2 = struct;
  }

  /**
   * @private Drive ROSA panel roll-out. While the launch sequence is actively
   * running, the panels follow its scripted roll-out. Once launch is READY (or
   * absent), the player-owned furl state takes over so "," can furl/unfurl the
   * arrays to dodge debris or tether strikes.
   * @param {number} dt — seconds since last frame
   */
  _updateRosaPanels(dt = 0) {
    // Advance the feather angle toward its target every frame. Feather only
    // changes the per-panel tilt (handled in _animateSolarTracking), so it is
    // independent of roll-out / launch state and animates here unconditionally.
    const fRate = (Constants.OCTOPUS_V5.ROSA_FEATHER_RATE || 0.6) * dt;
    const fTarget = this._rosaFeatherTarget ?? 0;
    if (this._rosaFeatherProgress < fTarget) {
      this._rosaFeatherProgress = Math.min(fTarget, this._rosaFeatherProgress + fRate);
    } else if (this._rosaFeatherProgress > fTarget) {
      this._rosaFeatherProgress = Math.max(fTarget, this._rosaFeatherProgress - fRate);
    }

    const ls = this._launchSequence;
    const launchActive = !!(ls && ls.isActive && ls.isActive());

    if (launchActive && ls.getRosaProgress) {
      // Scripted launch roll-out owns the panels. Keep the furl state synced to
      // the current deploy so there is no jump when control hands to the player.
      const prog = ls.getRosaProgress();
      this._setRosaWingProgress(1, prog.wing1);
      this._setRosaWingProgress(2, prog.wing2);
      this._rosaFurlProgress = Math.min(prog.wing1, prog.wing2);
      this._rosaFurlTarget = 1.0;
      return;
    }

    // Post-launch (READY) / no-launch: player furl control. If the player has
    // never toggled, hold fully deployed (or whatever launch left us at).
    const target = this._rosaManualControl ? this._rosaFurlTarget : 1.0;
    const rate = (Constants.OCTOPUS_V5.ROSA_FURL_RATE || 0.4) * dt;
    if (this._rosaFurlProgress < target) {
      this._rosaFurlProgress = Math.min(target, this._rosaFurlProgress + rate);
    } else if (this._rosaFurlProgress > target) {
      this._rosaFurlProgress = Math.max(target, this._rosaFurlProgress - rate);
    }
    this._setRosaWingProgress(1, this._rosaFurlProgress);
    this._setRosaWingProgress(2, this._rosaFurlProgress);
  }

  /**
   * Toggle the ROSA arrays between furled (rolled up) and unfurled (deployed).
   * Mirrors the strut deploy/stow toggle on ".". Furling reduces solar power
   * (ROSA share only — body-mount cells stay on) but lets the player retract
   * the wings to avoid debris or tether strikes.
   * @returns {number} the new furl target (0 = furling, 1 = unfurling)
   */
  toggleRosaFurl() {
    this._rosaManualControl = true;
    // Decide from the live animated progress so a mid-animation press reverses.
    this._rosaFurlTarget = this._rosaFurlProgress >= 0.5 ? 0.0 : 1.0;
    return this._rosaFurlTarget;
  }

  /**
   * Programmatically set the ROSA furl target. Used by tests / scripted events.
   * @param {number} target — 0 (furled) → 1 (unfurled)
   */
  setRosaFurl(target) {
    this._rosaManualControl = true;
    this._rosaFurlTarget = Math.max(0, Math.min(1, target));
    return this._rosaFurlTarget;
  }

  /**
   * Reset ROSA furl state to the default (fully deployed, no manual control).
   * Called on game reset so a retry never inherits a furled array from the
   * previous run — the retry path does NOT re-run the launch sequence, so
   * without this the post-launch player-furl branch would hold the panels
   * wherever the dead run left them. Also clears the feather state so a retry
   * starts sun-tracking, not parked edge-on.
   */
  resetRosaFurlState() {
    this._rosaManualControl = false;
    this._rosaFurlTarget = 1.0;
    this._rosaFurlProgress = 1.0;
    this._rosaFeatherTarget = 0.0;
    this._rosaFeatherProgress = 0.0;
  }

  /**
   * Toggle the ROSA arrays between feathered (parked edge-on) and sun-tracking.
   * Bound to "Shift+,", parallel to "," = furl. Feathering swings the wings
   * edge-on to a hazard — faster than a full furl and the wings stay deployed —
   * cutting the ROSA power share via the edge-on sun-incidence angle (NOT via a
   * separate multiplier like furl). Furl takes precedence: a furled wing is
   * frozen, so feather only visibly acts once the array is unfurled.
   * @returns {boolean} the new feather state (true = feathering edge-on)
   */
  toggleRosaFeather() {
    // Decide from the live animated progress so a mid-animation press reverses.
    this._rosaFeatherTarget = this._rosaFeatherProgress >= 0.5 ? 0.0 : 1.0;
    return this._rosaFeatherTarget >= 0.5;
  }

  /**
   * Programmatically set the ROSA feather target. Used by tests / scripted events.
   * @param {number} target — 0 (sun-tracking) → 1 (edge-on)
   * @returns {number} the clamped feather target
   */
  setRosaFeather(target) {
    this._rosaFeatherTarget = Math.max(0, Math.min(1, target));
    return this._rosaFeatherTarget;
  }

  /**
   * Wire up a LaunchSequence instance so ROSA panels can read
   * roll-out progress.  Called from main.js or GameFlowManager.
   * @param {import('../systems/LaunchSequence.js').default} ls
   */
  setLaunchSequence(ls) {
    this._launchSequence = ls;
  }

  // --------------------------------------------------------------------------
  // 4. Sensor Suite
  // --------------------------------------------------------------------------
  /** @private */
  _buildSensors() {
    // Gimbal platform group (articulates toward targets — repositioned for Config G barrel)
    this.sensorGimbal = new THREE.Group();
    this.sensorGimbal.position.set(0, M * 0.25, M * 1.0);
    this.sensorGimbal.name = 'SensorGimbal';
    this.add(this.sensorGimbal);

    // Shared gunmetal — same recipe as the LIDAR dome; used by the EO barrel and
    // the gimbal yoke members so the mechanism reads as one machined assembly.
    const gunmetalMat = new THREE.MeshStandardMaterial({
      color: 0x55585f, metalness: 0.5, roughness: 0.55,
    });

    // EO Camera: gunmetal barrel with a recessed dark lens + bright bezel
    const camGeo = new THREE.CylinderGeometry(M * 0.12, M * 0.12, M * 0.3, 12);  // was 6-seg
    const camLensMat = new THREE.MeshStandardMaterial({
      color: 0x111122, metalness: 0.7, roughness: 0.3,   // now the lens disc material
    });
    const eoCam = new THREE.Mesh(camGeo, gunmetalMat);   // barrel reads as metal housing
    eoCam.rotation.x = Math.PI / 2;
    eoCam.position.set(M * 0.25, 0, M * 0.1);
    eoCam.name = 'EO_Camera';
    this.sensorGimbal.add(eoCam);

    // Lens: dark disc 1 mm proud of the front (+Z) face (bury-don't-touch).
    // eoCam.rotation.x = +π/2 maps cylinder-local +Y → gimbal +Z (fore); the
    // front face is at cylinder-local y = +0.15M (half the 0.3M length).
    const eoLensGeo = new THREE.CircleGeometry(M * 0.085, 16);
    const eoLens = new THREE.Mesh(eoLensGeo, camLensMat);
    eoLens.position.set(0, M * 0.151, 0);
    eoLens.rotation.x = -Math.PI / 2;   // circle +Z normal → cylinder-local +Y (outward)
    eoLens.name = 'EO_Lens';
    eoLens.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    eoCam.add(eoLens);
    // Bezel: thin bright-steel ring around the lens, 0.5 mm proud
    const eoBezelMat = new THREE.MeshStandardMaterial({
      color: 0xaabbcc, metalness: 0.85, roughness: 0.15,
    });
    const eoBezelGeo = new THREE.RingGeometry(M * 0.085, M * 0.115, 16);
    const eoBezel = new THREE.Mesh(eoBezelGeo, eoBezelMat);
    eoBezel.position.set(0, M * 0.1505, 0);   // distinct proud offset avoids a coplanar tie with the lens
    eoBezel.rotation.x = -Math.PI / 2;
    eoBezel.name = 'EO_Bezel';
    eoBezel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    eoCam.add(eoBezel);

    // IR Sensor: gold-foil box
    const irGeo = new THREE.BoxGeometry(M * 0.2, M * 0.15, M * 0.2);
    // Clone the gold MLI material so the small box can carry the v4 `flat`
    // variant — a taut near-flat sheet (very low tilt 1.5–7°, high inheritance,
    // a few shallow straight folds) instead of the barrel's crumpled facets,
    // which mapped onto each tiny BoxGeometry face read as a glitter/disco-ball.
    // The flat variant bakes ONE roughness with a high floor, so smallPart is
    // dropped; scalar roughness ≈0.6 (flat map 0.50–0.80 × 0.6 ⇒ effective
    // ~0.30–0.48 satin) keeps the box from blowing out white over the collar
    // under bloom (F2 exposure fix). Override ALL THREE maps so the repeat stays
    // consistent across them.
    const irMat = this._matGoldMLI.clone();
    const irFoil = getMLIFoilMaps({ repeat: [1, 1], variant: 'flat' });
    irMat.roughness = 0.6;
    if (irFoil) {
      irMat.map = irFoil.albedoMap;
      irMat.normalMap = irFoil.normalMap;
      irMat.roughnessMap = irFoil.roughnessMap;
      irMat.emissiveMap = irFoil.albedoMap;
      irMat.needsUpdate = true;
    }
    this._foilMats.push(irMat);                 // v6 orbital envMap target
    const irSensor = new THREE.Mesh(irGeo, irMat);
    irSensor.position.set(-M * 0.25, 0, M * 0.1);
    irSensor.name = 'IR_Sensor';
    this.sensorGimbal.add(irSensor);

    // IR aperture window — one dark facet so the foil box reads as an instrument
    // (same recipe as the LIDAR lens). 1 mm proud of the +Z face (local z=0.1M).
    const irWinGeo = new THREE.CircleGeometry(M * 0.05, 12);
    const irWinMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a12, metalness: 0.4, roughness: 0.15,   // matches LIDAR_Lens
    });
    const irWin = new THREE.Mesh(irWinGeo, irWinMat);
    irWin.position.set(0, 0, M * 0.101);   // CircleGeometry +Z normal already faces outward
    irWin.name = 'IR_Aperture';
    irWin.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    irSensor.add(irWin);

    // LIDAR: small dome with pulsing green light
    const lidarGeo = new THREE.SphereGeometry(M * 0.1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);  // was 8×6
    const lidarMat = new THREE.MeshStandardMaterial({
      color: 0x55585f, metalness: 0.5, roughness: 0.55,   // gunmetal — was 0x888888/0.7/0.3,
      // which bloomed to a white blob (same fix class as the IR box above).
    });
    this.lidarDome = new THREE.Mesh(lidarGeo, lidarMat);
    this.lidarDome.position.set(0, M * 0.15, M * 0.15);
    this.lidarDome.name = 'LIDAR_Dome';
    this.sensorGimbal.add(this.lidarDome);

    // §2-followup (z-layer-and-lights-fix Batch 4, Z7): the dome is an OPEN
    // FrontSide hemisphere — from below the equator the back faces cull and the
    // interior shows through (a see-through hollow). Cap the equator with a dark
    // base disc so the dome reads solid. A base disc (not DoubleSide on the dome)
    // avoids the doubled dome overdraw. The disc overhangs the rim slightly
    // (×1.02) so its edge — not a rim coincident with the dome equator — defines
    // the silhouette; the dome wall meets the disc perpendicular (stable, not a
    // parallel tie). DoubleSide so it caps from any view of the tiny lip.
    const lidarBaseGeo = new THREE.CircleGeometry(M * 0.1 * 1.02, 16);
    const lidarBaseMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a30, metalness: 0.6, roughness: 0.5, side: THREE.DoubleSide,
    });
    const lidarBase = new THREE.Mesh(lidarBaseGeo, lidarBaseMat);
    lidarBase.rotation.x = -Math.PI / 2;  // lie flat in the equator (XZ) plane
    lidarBase.name = 'LIDAR_DomeBase';
    this.lidarDome.add(lidarBase);  // child of the dome → tracks it exactly (local origin = equator centre)

    // LIDAR aperture — small dark lens facet on the dome's forward face so the
    // labelled "LIDAR DOME" reads as an instrument, not a bead. Sits proud of
    // the dome surface by 1 mm along +Z (bury-don't-touch: avoid a coincident
    // curved-on-flat tie under log-depth).
    const lidarLensGeo = new THREE.CircleGeometry(M * 0.045, 16);
    const lidarLensMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a12, metalness: 0.4, roughness: 0.15,
    });
    const lidarLens = new THREE.Mesh(lidarLensGeo, lidarLensMat);
    // Dome-local: dome is a hemisphere (equator at y=0, pole +Y). Place the lens
    // on the +Z side at ~40° elevation so it faces forward-out, at radius+1 mm.
    const lensEl = 40 * Math.PI / 180;
    lidarLens.position.set(0, Math.sin(lensEl) * M * 0.101, Math.cos(lensEl) * M * 0.101);
    lidarLens.lookAt(lidarLens.position.clone().multiplyScalar(2)); // face outward along the radial
    lidarLens.name = 'LIDAR_Lens';
    lidarLens.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.lidarDome.add(lidarLens);

    // LIDAR pulse light
    const lidarLightGeo = new THREE.SphereGeometry(M * 0.04, 8, 6);  // was 4×4
    this._lidarLightMat = new THREE.MeshBasicMaterial({
      color: 0x00ff44, transparent: true, opacity: 0.0,
    });
    this.lidarLight = new THREE.Mesh(lidarLightGeo, this._lidarLightMat);
    // Co-located with LIDAR_Lens (~40° elevation, +Z side), centre ON the dome
    // surface (r 0.10) so half the r 0.04 pulse sphere protrudes — reads as the
    // emitter firing through the aperture. Reparented onto the dome: previously
    // a gimbal child fully enclosed by the opaque dome, so the pulse never showed.
    this.lidarLight.position.set(0, Math.sin(lensEl) * M * 0.10, Math.cos(lensEl) * M * 0.10);
    this.lidarLight.name = 'LIDAR_Light';
    this.lidarLight.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
    this.lidarDome.add(this.lidarLight);

    // Sensor base plate — FIXED deck, re-parented from the articulating gimbal
    // to the hull (`this`). Only the instruments (EO/IR/LIDAR, children of
    // sensorGimbal) articulate; the deck they mount to stays put. Ship-local
    // position is the gimbal origin (0, 0.25M, 1.0M) plus the old gimbal-local
    // offset (0, -0.1M, +0.03M) = (0, 0.15M, 1.03M).
    // §2-followup: keep the aft face clear of the front cap plane (z=1.0M); the
    // deck sits forward of it so nothing straddles/z-fights the cap face.
    // Plate shrunk r 0.35M → 0.26M so its silhouette stays inside the hull
    // radius (0.40M) while still covering the instruments at x=±0.25M.
    const basePlateR = M * 0.26;
    const basePlateT = M * 0.05;
    const basePlateGeo = new THREE.CylinderGeometry(basePlateR, basePlateR, basePlateT, 16);
    const basePlate = new THREE.Mesh(basePlateGeo, this._matDark);
    basePlate.rotation.x = Math.PI / 2;
    basePlate.position.set(0, M * 0.15, M * 1.03);
    basePlate.name = 'SensorDeck';
    basePlate.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.add(basePlate);

    // Thin fixed flange/skirt ring bridging the cap face (z=1.0M) to the deck's
    // aft face. A short open cylinder from the cap plane to just under the plate,
    // keeping the §2-followup 5 mm stagger (deck aft face ≈ z=1.0055M) so it
    // does not re-straddle the cap plane.
    const skirtGeo = new THREE.CylinderGeometry(basePlateR * 0.98, basePlateR * 0.98, M * 0.03, 16, 1, true);
    const skirt = new THREE.Mesh(skirtGeo, this._matDark);
    skirt.rotation.x = Math.PI / 2;
    skirt.position.set(0, M * 0.15, M * 1.015);
    skirt.name = 'SensorDeckSkirt';
    skirt.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.add(skirt);

    // Static mount feet REMOVED (2026-07-23): they stayed put while the gimballed instruments articulated away from them; replaced by the gimbal-child yoke below.

    // ── Gimbal yoke — visible mechanism connecting the instruments to the ship.
    // The gimbal bearing itself is implied, hidden at the deck/cap junction
    // (gimbal origin sits behind the deck slab); these members are gimbal
    // children so they swivel with the instruments and always emerge from the
    // hidden-bearing region regardless of articulation (yaw ±60°, pitch ±45° —
    // points near the origin sweep tiny radii and stay inside the junction).
    const yokeBarGeo = new THREE.BoxGeometry(M * 0.56, M * 0.05, M * 0.05);  // x span ±0.28: through both instrument bodies
    const yokeBar = new THREE.Mesh(yokeBarGeo, gunmetalMat);
    yokeBar.position.set(0, 0, M * 0.03);
    yokeBar.name = 'SensorYokeBar';
    yokeBar.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.sensorGimbal.add(yokeBar);

    // Dome column — slanted strut from the bar/junction region up to the dome
    // centre. Endpoint-oriented via setFromUnitVectors (never hand-set rotation
    // on slanted runs). Its top ends inside the dome, hidden behind LIDAR_DomeBase.
    const colA = new THREE.Vector3(0, 0, M * 0.03);            // buried in the yoke bar
    const colB = new THREE.Vector3(0, M * 0.15, M * 0.15);     // dome centre (inside the dome, under its base cap)
    const colDir = colB.clone().sub(colA);
    const colGeo = new THREE.CylinderGeometry(M * 0.028, M * 0.035, colDir.length(), 10);
    const yokeCol = new THREE.Mesh(colGeo, gunmetalMat);
    yokeCol.position.copy(colA).addScaledVector(colDir, 0.5);
    yokeCol.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), colDir.clone().normalize());
    yokeCol.name = 'SensorYokeColumn';
    yokeCol.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.sensorGimbal.add(yokeCol);
  }

  // --------------------------------------------------------------------------
  // 7b. Large Net Pods — fore-end launcher hardware
  // --------------------------------------------------------------------------
  /**
   * @private — Build the two Large Net launcher pods on the lower fore face.
   * The Mother's whale-class capture net (`[N]`) is a real 2-pod × 2-net
   * magazine mechanic (CaptureNetSystem._motherPodInventory); this is its
   * hardware. Each pod is a squat gunmetal launcher tube whose front face has
   * two cell bores — the magazine made visible: a pale Dyneema cap per LOADED
   * net, a dark open bore for a spent cell. An invisible muzzle anchor at each
   * pod's front centre is the launch point used by fireMotherNet (via
   * getNetPodPosition), so nets depart from the pod, not the hull origin.
   *
   * Placement (verified clear of the sensor deck (0, 0.15M, r 0.26M) and inside
   * hull r 0.40M): pods at (±0.18M, −0.18M), axes +Z, tails buried ~5 mm into
   * the front cap (aft face z≈0.995M, front face z≈1.155M).
   */
  _buildNetPods() {
    // Shared pod housing material — gunmetal, same recipe as the LIDAR dome /
    // sensor yoke so the launchers read as part of the same machined assembly.
    const gunmetalMat = new THREE.MeshStandardMaterial({
      color: 0x55585f, metalness: 0.5, roughness: 0.55,
    });
    // Cell bore (dark recessed): same recipe as LIDAR_Lens / IR_Aperture.
    const cellHoleMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a12, metalness: 0.4, roughness: 0.15,
    });
    // Loaded-net cap — pale Dyneema face, visible only while that net is loaded.
    const cellCapMat = new THREE.MeshStandardMaterial({
      color: 0xd8d8d0, metalness: 0.1, roughness: 0.7,
    });

    this._netPodMuzzles = [];
    this._netPodCaps = [];

    // podIndex 0 → +X, podIndex 1 → −X.
    const podX = [M * 0.18, -M * 0.18];
    for (let pod = 0; pod < 2; pod++) {
      const x = podX[pod];

      // Housing: 12-seg cylinder, length 0.16M. rotation.x = π/2 maps the
      // cylinder axis (local +Y) → ship +Z (fore); default caps are kept
      // (closed ends) so no extra front disc is needed. Centre at z=1.075M →
      // aft face z=0.995M (buried in the cap), front face z=1.155M.
      const housingGeo = new THREE.CylinderGeometry(M * 0.11, M * 0.11, M * 0.16, 12);
      const housing = new THREE.Mesh(housingGeo, gunmetalMat);
      housing.rotation.x = Math.PI / 2;
      housing.position.set(x, -M * 0.18, M * 1.075);
      housing.name = `NetPod_${pod}`;
      housing.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
      this.add(housing);

      // Two cells per pod at cylinder-local (0, ±0.045M) on the front face.
      // rotation.x = π/2 on the housing maps cylinder-local +Y → ship +Z, so
      // the front face is at cylinder-local y = +0.08M (half the 0.16M length);
      // facets sit 1–1.5 mm proud with rotation.x = −π/2 (same pre-verified EO
      // lens mapping). Cell offset ±0.045M is cylinder-local X (→ ship X).
      const caps = [];
      for (let cell = 0; cell < 2; cell++) {
        const cx = cell === 0 ? M * 0.045 : -M * 0.045;

        const holeGeo = new THREE.CircleGeometry(M * 0.032, 12);
        const hole = new THREE.Mesh(holeGeo, cellHoleMat);
        hole.position.set(cx, M * 0.081, 0);   // 1 mm proud of the 0.08M half-length
        hole.rotation.x = -Math.PI / 2;
        hole.name = `NetPodCellHole_${pod}_${cell}`;
        hole.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
        housing.add(hole);

        const capGeo = new THREE.CircleGeometry(M * 0.030, 12);
        const cap = new THREE.Mesh(capGeo, cellCapMat);
        cap.position.set(cx, M * 0.0815, 0);   // distinct offset — no coplanar tie
        cap.rotation.x = -Math.PI / 2;
        cap.name = `NetPodCellCap_${pod}_${cell}`;
        cap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
        cap.visible = true;                      // default full; init() emit syncs
        housing.add(cap);
        caps.push(cap);
      }
      this._netPodCaps.push(caps);

      // Muzzle anchor — invisible Object3D at the pod front centre, a child of
      // the ship frame (NOT the rotated housing) so its world position is the
      // launch point regardless of housing-local axis rotation.
      const muzzle = new THREE.Object3D();
      muzzle.position.set(x, -M * 0.18, M * 1.155);
      muzzle.name = `NetPodMuzzle_${pod}`;
      this.add(muzzle);
      this._netPodMuzzles.push(muzzle);
    }

    // Inventory subscription — mirror the pale caps to the live magazine.
    // Session singleton: follows the same fire-and-forget eventBus.on pattern as
    // the constructor listeners above (no teardown). Filters to mother-source
    // emits carrying a podInventory array (init/fire/restore/restock all do).
    this._onNetInventoryChanged = (p) => {
      if (!p || p.source !== 'mother' || !Array.isArray(p.podInventory)) return;
      for (let pod = 0; pod < 2; pod++) {
        const n = p.podInventory[pod] ?? 0;
        const caps = this._netPodCaps?.[pod] || [];
        caps.forEach((cap, i) => { cap.visible = i < n; });
      }
    };
    eventBus.on(Events.NET_INVENTORY_CHANGED, this._onNetInventoryChanged);
  }

  // --------------------------------------------------------------------------
  // 5. Tether Reels — REMOVED for Config G (strut-mounted reels in V-3/V-7)
  // --------------------------------------------------------------------------
  // V3 bus-mounted tether reels removed. Config G uses strut-mounted reels
  // that will be added to each strut tip in V-3 (strut animation) and V-7 (tether reel visual).
  // Arrays kept empty for API compatibility with _animateTetherIndicators / getTetherReelPosition.

  // --------------------------------------------------------------------------
  // 6. Magnetic Field Generator — REMOVED for Config G
  // --------------------------------------------------------------------------
  // V3 magnetic coil ring removed — not present in Config G design.

  // --------------------------------------------------------------------------
  // 7. Docking Port — REMOVED (2026-07-23)
  // --------------------------------------------------------------------------
  // The fore docking port (ring, collar, dark guide cone, blinking green/red
  // lamps + halos) was cosmetic greeble: nothing in the game docked with the
  // mother (capture/berthing is done by the arms), and getDockingPortPosition()
  // had no callers. Removed to declutter the fore end and reclaim tris. The
  // Large Net pods (§7b, _buildNetPods) now occupy the lower fore face.

  /**
   * World position of a Large Net pod muzzle — the launch point for
   * fireMotherNet (fore-end hardware, not the hull origin). Falls back to pod 0
   * for an out-of-range index, then to the ship origin if pods weren't built.
   * @param {number} podIndex 0 (+X) or 1 (−X)
   * @returns {THREE.Vector3} world-space muzzle position
   */
  getNetPodPosition(podIndex) {
    const m = this._netPodMuzzles?.[podIndex] ?? this._netPodMuzzles?.[0];
    const pos = new THREE.Vector3();
    if (m) m.getWorldPosition(pos); else this.getWorldPosition(pos);
    return pos;
  }

  // --------------------------------------------------------------------------
  // 8. Navigation Lights
  // --------------------------------------------------------------------------
  /**
   * @private — Thin delegate to the shared `makeLightHalo` factory
   * (scene/glowSpriteTexture.js), so the Mother and daughters build halos from one
   * SSOT. Kept as a method for call-site readability inside the builders.
   *
   * The bare emissive spheres read as flat painted dots; a co-located additive
   * radial-gradient sprite gives real spill (the "ship is alive" cue). Gameplay
   * only — the menu hero has its own standalone model. Bloom threshold is 2.5, so
   * coloured halos glow additively without blooming; only near-white strobe peaks
   * (×hdrMul) cross 2.5 to bloom in the HalfFloat target, keeping the hull clean.
   */
  _makeLightHalo(colorHex, scaleM, hdrMul = 1.6, opacity = 0.0) {
    return makeLightHalo(colorHex, scaleM, hdrMul, opacity);
  }

  /** @private */
  _buildNavLights() {
    // Sizes read from Constants.LIGHT_FX (Batch 1 light-shrink; the SSOT block).
    const LFX = Constants.LIGHT_FX;
    const navGeo = new THREE.SphereGeometry(M * LFX.NAV_CORE_R, 8, 6);  // was 4×4 faceted lump
    const HALO = M * LFX.NAV_HALO;  // steady nav halo sprite size

    // Port (left) — Red (repositioned for Config G barrel)
    this._portLightMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    this.portLight = new THREE.Mesh(navGeo, this._portLightMat);
    this.portLight.position.set(-M * 0.42, 0, M * 0.3);
    this.portLight.name = 'NavLight_Port';
    this.add(this.portLight);
    // Port/starboard are STEADY (running lights) — a constant modest halo.
    this.portLight.add(this._makeLightHalo(0xff0000, HALO, 1.6, LFX.NAV_HALO_OPACITY));

    // Starboard (right) — Green
    this._starboardLightMat = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    this.starboardLight = new THREE.Mesh(navGeo, this._starboardLightMat);
    this.starboardLight.position.set(M * 0.42, 0, M * 0.3);
    this.starboardLight.name = 'NavLight_Starboard';
    this.add(this.starboardLight);
    this.starboardLight.add(this._makeLightHalo(0x00ff00, HALO, 1.6, LFX.NAV_HALO_OPACITY));
  }

  // --------------------------------------------------------------------------
  // 9. RCS Thruster Puff Sprites (pooled)
  // --------------------------------------------------------------------------
  /** @private — Create sprite pool for RCS thruster puff visual effects */
  _buildRcsPuffPool() {
    // Shared procedural soft radial gradient (headless-safe: null without a DOM,
    // so this builder — and the whole model — constructs cleanly in Node tests).
    const tex = getRadialGlowTexture({ size: 32 });

    const puffMat = new THREE.SpriteMaterial({
      map: tex || null,
      color: 0xcfe0ff,   // cool translucent cold-gas (N₂) white-blue, not a hot flash
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      // depthTest ON so the hull/pods occlude puffs — previously false, which
      // drew the puffs THROUGH the mother body from any angle.
      depthTest: true,
    });

    // Nozzle positions: keyed by THRUST-axis sign (exhaust appears OPPOSITE to
    // thrust). Ship model: +Z = forward (prograde), −Z = rear.
    // Each key snaps to the nozzle whose EXHAUST best opposes that thrust
    // (min exhaust·thrust) — robust to the doghouse-quad layout (radial=±Y,
    // axial=±Z, tangential=±X across the 4 pods). The 6-key API (_fireRcsPuff
    // callers pass local thrust dir) is unchanged — only the lookup.
    const thrustAxis = {
      'pz': new THREE.Vector3(0, 0, 1),
      'nz': new THREE.Vector3(0, 0, -1),
      'px': new THREE.Vector3(1, 0, 0),
      'nx': new THREE.Vector3(-1, 0, 0),
      'py': new THREE.Vector3(0, 1, 0),
      'ny': new THREE.Vector3(0, -1, 0),
    };
    const dirs = this._rcsExhaustDir || [];
    const nozzles = this._rcsNozzleLocalPos || [];
    this._rcsPuffNozzles = {};
    this._rcsPuffDirs = {};   // exhaust dir per key — gas drifts along this in vacuum
    for (const key of Object.keys(thrustAxis)) {
      const thrust = thrustAxis[key];
      let best = null, bestDir = null;
      let bestDot = Infinity;   // want the MOST-opposing exhaust (most negative dot)
      for (let i = 0; i < dirs.length; i++) {
        const d = dirs[i].dot(thrust);
        if (d < bestDot) { bestDot = d; best = nozzles[i]; bestDir = dirs[i]; }
      }
      this._rcsPuffNozzles[key] = best ? best.clone() : new THREE.Vector3();
      this._rcsPuffDirs[key] = bestDir ? bestDir.clone() : new THREE.Vector3(0, 1, 0);
    }

    // Attitude couples — which pod nozzles puff for pitch/yaw rotation. The RCS
    // pods are the attitude hardware, so arrow-key rotation puffs these (and
    // costs cold gas; see fireRcsRotation). Torque on the craft from a nozzle is
    // τ = r × F, with thrust F = −exhaust. rotatePitch spins about +X, rotateYaw
    // about +Y. We pick the two nozzles with the largest same-sign torque about
    // the axis → a visible couple (pitch resolves to the radial ±Y bells, yaw to
    // the tangential bells, by geometry).
    this._rcsAttitudeNozzles = {};
    this._rcsAttitudeDirs = {};   // exhaust dir per couple nozzle (index-aligned)
    this._rcsAttitudeIdx = {};    // nozzle INDICES per couple (into attitudeThrusterPlumes / _rcsLiners)
    const pickCouple = (comp, sign) => {
      const scored = [];
      for (let i = 0; i < dirs.length; i++) {
        const F = dirs[i].clone().multiplyScalar(-1);              // thrust = −exhaust
        const t = new THREE.Vector3().crossVectors(nozzles[i], F); // torque
        const v = t[comp] * sign;                                   // want positive
        if (v > 1e-9) scored.push({ i, v });
      }
      scored.sort((a, b) => b.v - a.v);
      const top = scored.slice(0, 2);
      return {
        pos: top.map(s => nozzles[s.i].clone()),
        dir: top.map(s => dirs[s.i].clone()),
        idx: top.map(s => s.i),
      };
    };
    for (const [key, comp, sign] of [
      ['pitchPos', 'x', +1], ['pitchNeg', 'x', -1],
      ['yawPos', 'y', +1], ['yawNeg', 'y', -1],
    ]) {
      const c = pickCouple(comp, sign);
      this._rcsAttitudeNozzles[key] = c.pos;
      this._rcsAttitudeDirs[key] = c.dir;
      this._rcsAttitudeIdx[key] = c.idx;
    }

    // Pooled sprites (round-robin reuse). A single RCS burst emits a small
    // multi-sprite cloud, so keep enough in the pool to avoid thrash.
    for (let i = 0; i < 16; i++) {
      const sprite = new THREE.Sprite(puffMat.clone());
      sprite.scale.set(M * 0.05, M * 0.05, M * 0.05);
      sprite.visible = false;
      sprite.name = `RcsPuff_${i}`;
      this.add(sprite);
      this._rcsPuffs.push({
        sprite, startTime: 0, active: false,
        startPos: new THREE.Vector3(), dir: new THREE.Vector3(0, 1, 0),
        life: 0.3, maxScale: M * 0.3, baseOp: 0.5, drift: M * 0.5,
        rot: 0, spin: 0,
      });
    }
  }

  // ==========================================================================
  // NAMED ATTACHMENT POINT GETTERS
  // ==========================================================================

  /** Get world position of the sensor gimbal (laser/scan origin) */
  getSensorGimbalPosition() {
    const pos = new THREE.Vector3();
    this.sensorGimbal.getWorldPosition(pos);
    return pos;
  }

  /** Get world position of a specific main FEEP nozzle (field-emission beam origin) */
  getMainThrusterPosition(index = 0) {
    const pos = new THREE.Vector3();
    if (this.mainThrusters[index]) {
      this.mainThrusters[index].getWorldPosition(pos);
    } else {
      this.getWorldPosition(pos);
    }
    return pos;
  }

  /** Get world position of a specific tether reel (tether origin) */
  getTetherReelPosition(index = 0) {
    const pos = new THREE.Vector3();
    if (this.tetherReels[index]) {
      this.tetherReels[index].getWorldPosition(pos);
    } else {
      this.getWorldPosition(pos);
    }
    return pos;
  }

  // ==========================================================================
  // ANIMATION CONTROL API
  // ==========================================================================

  /** Set sensor gimbal target (world position vector or null) */
  setSensorTarget(worldPos) {
    this._sensorTarget = worldPos;
  }

  /** Set tether reel state (index 0-7, state: 'ready'|'deployed'|'empty') */
  setTetherState(index, state) {
    if (index >= 0 && index < this._tetherStates.length) {
      this._tetherStates[index] = state;
    }
  }

  /** Get current active thrust direction for thruster glow */
  setActiveThrustDirection(dir) {
    this._activeThrustDir = dir;
  }

  // ==========================================================================
  // UPDATE
  // ==========================================================================

  /**
   * Per-frame update: propagate orbit, position, solar power, animations.
   * @param {number} dt - Real-time delta (seconds)
   * @param {THREE.Vector3} sunDirection - Normalized sun direction vector
   */
  update(dt, sunDirection) {
    const gameDt = dt * Constants.TIME_SCALE_GAMEPLAY;

    // §2 cache the sun direction for puff sun-scatter (null when unavailable, so
    // headless / null-sun frames stay scatter-free — no per-frame alloc).
    if (sunDirection) {
      this._sunDirWorld ||= new THREE.Vector3();
      this._sunDirWorld.copy(sunDirection);
    } else {
      this._sunDirWorld = null;
    }

    // --- V5: Thruster interlock check ---
    this._updateThrusterInterlock();

    // --- C-11: RCS nulling of recoil angular velocity ---
    if (Constants.FEATURE_FLAGS.RECOIL_PHYSICS) {
      this._tickRecoilRcs(gameDt);
    }

    // --- Apply accumulated thrust ---
    this._applyThrust(gameDt);

    // --- Propagate orbit ---
    const kmOrbit = {
      ...this.orbit,
      semiMajorAxis: this.orbit.semiMajorAxis / Constants.SCENE_SCALE,
    };
    propagateOrbit(kmOrbit, gameDt);
    this.orbit.trueAnomaly = kmOrbit.trueAnomaly;
    this.orbit.meanMotion = kmOrbit.meanMotion;

    // --- Atmospheric drag ---
    const altKm = (this.orbit.semiMajorAxis / Constants.SCENE_SCALE) - Constants.EARTH_RADIUS_KM;
    if (altKm < 600) {
      const vel = orbitalVelocity(
        this.orbit.semiMajorAxis / Constants.SCENE_SCALE,
        this.orbit.semiMajorAxis / Constants.SCENE_SCALE,
        Constants.MU_EARTH
      );
      const dragDecel = atmosphericDrag(altKm, vel, 20, this.mass);
      const dvDrag = dragDecel * gameDt;
      if (vel > 0) {
        const factor = 1 - 2 * dvDrag / vel;
        this.orbit.semiMajorAxis *= factor;
      }
    }

    // --- Update position ---
    this._updateCartesian();
    this._applyPosition();

    // --- RCS fine-positioning (Phase 1: additive to orbital motion) ---
    if (this._rcsVelocity.lengthSq() > 1e-20) {
      this.position.addScaledVector(this._rcsVelocity, dt);
      // Damping: velocity decays when not thrusting (stops quickly on key release)
      this._rcsVelocity.multiplyScalar(Constants.RCS_DAMPING);
      // Zero out when negligible
      if (this._rcsVelocity.lengthSq() < 1e-22) {
        this._rcsVelocity.set(0, 0, 0);
      }
    }

    // --- Mother-net Phase 1C: cosmetic launch-recoil shudder ---
    // Apply the (decaying) recoil offset to the rendered position, then spring it
    // back toward zero. Because _applyPosition() recomputes position from orbit
    // every frame, this offset never accumulates into the orbit — it is purely a
    // visual hull kick that the tether/muzzle (computed from getPosition) follow.
    if (this._recoilOffset.lengthSq() > 1e-24) {
      this.position.add(this._recoilOffset);
      const decay = Math.max(0, 1 - Constants.LASSO_RECOIL_DECAY * dt);
      this._recoilOffset.multiplyScalar(decay);
      if (this._recoilOffset.lengthSq() < 1e-26) this._recoilOffset.set(0, 0, 0);
    }

    this._orientAlongVelocity();

    // --- Solar power ---
    this._updateSolarPower(sunDirection);

    // --- Resources ---
    this._updateResources(dt);

    // --- S3b: MPD thermal dissipation (always runs, even when not firing) ---
    if (this._mpdHeat > 0) {
      const coolRate = this._hasSupercap
        ? (Constants.MPD_BURST_COOL_RATE_SUPERCAP || 0.5)
        : (Constants.MPD_BURST_COOL_RATE || 0.3);
      this._mpdHeat = Math.max(0, this._mpdHeat - coolRate * dt);
    }

    // S3b: MPD cooldown timer
    if (this._mpdCooldownTimer > 0) {
      this._mpdCooldownTimer -= dt;
      if (this._mpdCooldownTimer <= 0) {
        this._mpdCooldownTimer = 0;
        this._mpdHeat = 0;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'PROPULSION',
          text: 'MPD thermal nominal. Ready to arm',
          priority: 'info',
        });
      }
    }

    // S3b: Auto-disarm if battery depleted while armed
    if (this._mpdArmed && this.resources.battery <= 0) {
      this._mpdArmed = false;
      this._mpdDegraded = false;
      eventBus.emit(Events.MPD_BURST_END, { reason: 'battery_depleted' });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: 'MPD OFFLINE. Battery depleted',
        priority: 'warning',
      });
    }

    // S3b: Auto-disarm if lithium depleted while armed
    if (this._mpdArmed && this.resources.lithium <= 0) {
      this._mpdArmed = false;
      this._mpdDegraded = false;
      eventBus.emit(Events.MPD_BURST_END, { reason: 'lithium_depleted' });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: 'MPD FUEL DEPLETED. No lithium',
        priority: 'warning',
      });
    }

    // --- Animations ---
    this._updateRosaPanels(dt);
    this._animateSolarTracking(dt, sunDirection);
    this._animateRosaGlow(dt);
    this._animateSensorGimbal(dt);
    this._animateNavLights(dt);
    this._animateThrusterGlow(dt);
    this._animateLidarPulse(dt);
    this._animateTetherIndicators(dt);
    this._animateScanFlash(dt);
    this._updateRcsPuffs(dt);
    this._updateStruts(dt);

    // --- EDT deployment & attraction (Phase 6) ---
    if (this._edtDeployed && !this._edtActive) {
      const deployTime = (Constants.EDT && Constants.EDT.DEPLOY_TIME) || 5;
      this._edtDeployTimer += dt;
      if (this._edtDeployTimer >= deployTime) {
        this._edtActive = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'EDT', text: 'EDT active. Attracting nearby debris', priority: 'info',
        });
      }
    }

    if (this._edtActive) {
      const powerDraw = (Constants.EDT && Constants.EDT.POWER_DRAW) || 0.05;
      if (this._resourceSystem && !this._resourceSystem.canAfford('battery', powerDraw * dt)) {
        this._edtActive = false;
        this._edtDeployed = false;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'EDT', text: 'EDT shutdown. Low power', priority: 'warning',
        });
      } else if (this._resourceSystem) {
        this._resourceSystem.consume('battery', powerDraw * dt);
        // Emit attraction event for debris field to process
        eventBus.emit(Events.EDT_ATTRACT, {
          position: this.position ? this.position.clone() : new THREE.Vector3(),
          radius: (Constants.EDT && Constants.EDT.ATTRACTION_RADIUS_KM) || 0.2,
          force: (Constants.EDT && Constants.EDT.ATTRACTION_FORCE) || 0.0001,
          maxMass: (Constants.EDT && Constants.EDT.MAX_ATTRACT_MASS) || 20,
        });
      } else {
        // No resource system — drain legacy battery directly
        this.resources.battery -= powerDraw * dt;
        if (this.resources.battery <= 0) {
          this.resources.battery = 0;
          this._edtActive = false;
          this._edtDeployed = false;
          eventBus.emit(Events.COMMS_MESSAGE, {
            sender: 'EDT', text: 'EDT shutdown. Low power', priority: 'warning',
          });
        }
      }
    }

    // --- ST-5.2: Trail sample emission (continuous 10 Hz) ---
    // Samples emitted continuously; TrailSystem controls visibility via
    // THRUST_VISUAL events (only shows trail during active thrust).
    if (Constants.TRAILS && Constants.TRAILS.ENABLED !== false) {
      this._trailSampleAccum = (this._trailSampleAccum || 0) + gameDt;
      const trailInterval = 1 / (Constants.TRAILS.SAMPLE_RATE_HZ || 10);
      if (this._trailSampleAccum >= trailInterval) {
        this._trailSampleAccum -= trailInterval;
        // Clamp accumulator to prevent burst after long pauses
        if (this._trailSampleAccum > trailInterval) this._trailSampleAccum = 0;
        eventBus.emit(Events.PLAYER_TRAIL_SAMPLE, {
          pos: { x: this.position.x, y: this.position.y, z: this.position.z },
          vel: this._cartesian ? this._cartesian.velocity : { x: 0, y: 0, z: 0 },
        });
      }
    }

    // --- Emit telemetry ---
    if (Math.random() < 0.02) {
      // Phase 4: Include current fuel info in telemetry
      const currentFuel = this._resourceSystem
        ? this._resourceSystem.getCurrentFuel()
        : Constants.FUELS.xenon;

      eventBus.emit(Events.PLAYER_TELEMETRY, {
        altitude: altKm,
        velocity: this._cartesian.velocity,
        resources: { ...this.resources },
        orbit: { ...this.orbit },
        deltaVSpent: this._deltaVSpent,
        thrustDirection: this._thrustDirection,
        lastThrustType: this._lastThrustType,
        currentFuelId: currentFuel.id || 'xenon',
        currentIsp: currentFuel.isp || 1600,
        throttleLevel: this.throttleLevel,
        edtActive: this._edtActive,
        edtDeployed: this._edtDeployed,
        hasMPD: this._hasMPD,
        mpdCathodeTime: this._mpdCathodeTime,
        mpdCathodeHealth: this.mpdCathodeHealth,
        mpdCathodeLife: this._mpdCathodeLife,
        // S3b: MPD burst mode telemetry
        mpdArmed: this._mpdArmed,
        mpdHeat: this._mpdHeat,
        mpdHeatFraction: this.mpdHeatFraction,
        mpdCooldownRemaining: this._mpdCooldownTimer,
        mpdDegraded: this._mpdDegraded,
      });
    }
    // Reset per-frame thrust direction (accumulated fresh each frame)
    this._thrustDirection = null;
  }

  // ==========================================================================
  // ANIMATIONS
  // ==========================================================================

  /** @private Solar panels slowly track the sun via boom-axis tilt.
   *
   *  Each panel pivot rotates around the boom axis (body ±X) to tilt the
   *  panel face toward the sun.  This keeps wings extending in ±X
   *  (orbit-normal → horizontal on screen from CHASE camera) while
   *  allowing proper sun-tracking.
   *
   *  Panel normal at rest (rotation.x = 0) is body +Y (zenith).
   *  Rotation.x = α tilts the normal to (0, cos α, sin α) in body space.
   *  Optimal α = atan2(localSun.z, localSun.y) — maximises dot(normal, sun).
   *
   *  Precedence: furl wins (a furled wing is frozen, no gimbal). When deployed
   *  and feathered, the pivot is driven to the edge-on park angle (sun-track is
   *  skipped). Otherwise the pivot tracks the sun, clamped to the tier-aware
   *  maximum so the trailing edge clears the arm struts.
   */
  _animateSolarTracking(dt, sunDirection) {
    if (!sunDirection) return;

    // A rolled-up (furled) array shouldn't gimbal — freeze tracking when the
    // wings are mostly furled so the panels hold their tilt while retracted.
    // Furl takes precedence over feather.
    if ((this._rosaFurlProgress ?? 1) < 0.5) return;

    // Convert sun direction to satellite body space
    const localSun = _v3TmpA.copy(sunDirection).applyQuaternion(_qInvTmp.copy(this.quaternion).invert());

    // Optimal tilt: align panel normal with sun's projection in the YZ plane
    // (perpendicular to the boom axis X).
    const targetTilt = Math.atan2(localSun.z, localSun.y);

    // Tier-aware clamp: at Y0 the struts sit 60° off the ROSA plane so ±30°
    // clears them; Y1+ tiers add struts only 30° from the plane → tighter clamp.
    const maxTilt = this._rosaMaxTiltRad();

    // Feather: when feathered (and deployed), park the wing edge-on to the sun
    // (sun-track target + 90°) instead of tracking. This minimises the blanket's
    // sun-facing cross-section to dodge a hazard while staying deployed.
    const feather = this._rosaFeatherProgress ?? 0;
    let desired;
    if (feather > 0) {
      const edgeOn = targetTilt + Math.PI / 2;             // 90° off sun = edge-on
      const tracked = Math.max(-maxTilt, Math.min(maxTilt, targetTilt));
      desired = tracked + (edgeOn - tracked) * feather;    // blend track → edge-on
    } else {
      desired = Math.max(-maxTilt, Math.min(maxTilt, targetTilt));
    }

    const trackSpeed = 0.3 * dt; // Slow, smooth tracking

    // Apply identical tilt to both panel pivots (coplanar tracking)
    if (this.panelRightPivot) {
      const cur = this.panelRightPivot.rotation.x;
      this.panelRightPivot.rotation.x += (desired - cur) * trackSpeed;
    }
    if (this.panelLeftPivot) {
      const cur = this.panelLeftPivot.rotation.x;
      this.panelLeftPivot.rotation.x += (desired - cur) * trackSpeed;
    }
  }

  /**
   * @private Tier-aware sun-track tilt clamp (radians).
   *
   * The sun-track tilt swings the ROSA trailing edge toward the arm-strut
   * planes. At Y0 the struts sit at 60°/120° (60° off the 0°/180° ROSA plane),
   * so the loose ±30° default clears them. Y1+ tiers add struts at 30°/330° —
   * only 30° from the ROSA plane — so when the nearest strut is within ~30° of
   * the plane the clamp tightens to ROSA_TILT_CLAMP_TIGHT_DEG.
   *
   * Reads the active tier's azimuths from ArmManager/ARM_LADDER at runtime so an
   * in-session tier refit updates the clamp. Falls back to the Y0 quad azimuths.
   * @returns {number} max tilt magnitude in radians
   */
  _rosaMaxTiltRad() {
    const V5 = Constants.OCTOPUS_V5;
    const looseDeg = 30;
    const tightDeg = V5.ROSA_TILT_CLAMP_TIGHT_DEG ?? 18;

    // Resolve the active tier's strut azimuths (degrees).
    let azimuths = Constants.ARM_LADDER?.Y0_QUAD?.azimuths ?? [60, 120, 240, 300];
    const tierKey = this.armManager?.getCurrentTier?.();
    if (tierKey && Constants.ARM_LADDER?.[tierKey]?.azimuths) {
      azimuths = Constants.ARM_LADDER[tierKey].azimuths;
    }

    // Smallest angular gap between any strut and the ROSA plane (0° / 180°).
    let minGapDeg = 90;
    for (const az of azimuths) {
      const a = ((az % 180) + 180) % 180;      // fold onto [0,180): plane is 0 & 180
      const gap = Math.min(a, 180 - a);        // distance to the nearest plane line
      if (gap < minGapDeg) minGapDeg = gap;
    }

    // If a strut sits within ~30° of the plane, tighten; otherwise stay loose.
    const deg = minGapDeg <= 30 + 1e-6 ? tightDeg : looseDeg;
    return deg * Math.PI / 180;
  }

  /**
   * @private Power-flow glow on the ROSA cell faces. Drives the front material
   * emissive from the actual generated power (resources.solarRate) so the wings
   * visibly energize in sunlight and go dark in shadow / when feathered or
   * furled (both of which already drop solarRate). A faint sine "breathing"
   * keeps the array alive even at steady output.
   *
   * Runs BEFORE _animateScanFlash so a scan pulse cleanly overrides this for its
   * brief window. The menu hero scene has no power subsystem, so it sets
   * `_rosaGlowIdleFloor` to give the wings a constant energized look there.
   * @param {number} dt — seconds since last frame
   */
  _animateRosaGlow(dt = 0) {
    if (!this._rosaFrontMats || !this._rosaFrontMats.length) return;
    this._rosaGlowClock += dt;

    // Normalise generated power to 0..1 against the theoretical panel peak.
    const peak = Constants.SOLAR_FLUX * Constants.SOLAR_PANEL_AREA *
                 Constants.SOLAR_PANEL_EFFICIENCY;
    const rate = this.resources?.solarRate ?? 0;
    let frac = peak > 0 ? rate / peak : 0;
    frac = Math.max(this._rosaGlowIdleFloor || 0, Math.min(1, frac));

    // Dim royal blue (0.12) → bright, vivid royal blue (0.78), plus a subtle
    // breathing ripple so even a steady array shimmers.
    const breathe = 0.04 * (0.5 + 0.5 * Math.sin(this._rosaGlowClock * 2.0));
    const intensity = 0.12 + 0.66 * frac + breathe * frac;
    // Hue lerp: deep royal blue (0x101e64) → bright royal blue (0x2a55ff). Both
    // ends are blue-dominant (high B, low-moderate G, minimal R) so the wings read
    // royal blue at ANY power level — richer/deeper than the old cyan-teal — and
    // just get brighter and more vivid toward full power.
    const r = 0x10 + Math.round((0x2a - 0x10) * frac);
    const g = 0x1e + Math.round((0x55 - 0x1e) * frac);
    const b = 0x64 + Math.round((0xff - 0x64) * frac);
    const hex = (r << 16) | (g << 8) | b;
    for (const mat of this._rosaFrontMats) {
      mat.emissive.setHex(hex);
      mat.emissiveIntensity = intensity;
    }
  }

  /** @private Sensor gimbal points toward selected target */
  _animateSensorGimbal(dt) {
    if (!this._sensorTarget || !this.sensorGimbal) return;

    // Get target direction in local space
    this.sensorGimbal.getWorldPosition(_v3TmpA);
    const localDir = _v3TmpB.copy(this._sensorTarget).sub(_v3TmpA)
      .applyQuaternion(_qInvTmp.copy(this.quaternion).invert());

    // Compute yaw/pitch for gimbal
    const yaw = Math.atan2(localDir.x, localDir.z);
    const pitch = Math.atan2(localDir.y, Math.sqrt(localDir.x * localDir.x + localDir.z * localDir.z));

    // Clamp rotation range
    const maxYaw = Math.PI / 3;
    const maxPitch = Math.PI / 4;
    const clampedYaw = Math.max(-maxYaw, Math.min(maxYaw, yaw));
    const clampedPitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));

    // Smooth interpolation
    const speed = 2.0 * dt;
    this.sensorGimbal.rotation.y += (clampedYaw - this.sensorGimbal.rotation.y) * speed;
    this.sensorGimbal.rotation.x += (-clampedPitch - this.sensorGimbal.rotation.x) * speed;
  }

  /** @private Navigation and docking lights blinking */
  _animateNavLights(dt) {
    // Port/Starboard nav lights: always on (constant core + steady halo, set at
    // build). No per-frame work remains here now that the blinking docking
    // lights are gone (docking port removed 2026-07-23); kept as a no-op so the
    // update loop and menu hero call sites stay stable.
  }

  /** @private Thruster glow — per-nozzle differential for attitude + uniform prograde */
  _animateThrusterGlow(dt) {
    const ti = this.thrustInput;
    const mag = Math.sqrt(ti.x * ti.x + ti.y * ti.y + ti.z * ti.z);
    const hasThrust = mag > 1e-12;
    const lerpRate = Constants.DIFFERENTIAL_THRUST.LERP_RATE;

    // Main thrusters: each nozzle lerps independently toward its own target
    this.mainThrusters.forEach((thruster, i) => {
      const data = this._thrusterGlowTargets.get(thruster);
      if (!data) return;

      // C-9: Check plume interlock — dim blocked FEEP nozzles
      const tid = thruster._thrusterId;
      const blocked = Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK &&
                      this._plumeBlocked && tid && (tid in this._plumeBlocked);

      // Prograde thrust target (same for all nozzles, as before)
      let progradeTarget = 0;
      if (hasThrust && ti.z > 0) {
        progradeTarget = Math.min(1.0, Math.abs(ti.z) * 5000);
      }

      // Differential attitude-rotation target (per-nozzle, set by setThrusterFire)
      const diffTarget = this._differentialFireTargets[i] || 0;

      // Composite: max of prograde and differential
      let target = Math.max(progradeTarget, diffTarget);

      // Suppress thrust output when plume-blocked
      if (blocked) target *= 0.15;

      // Smooth interpolation — per-nozzle independent lerp
      data.intensity += (target - data.intensity) * Math.min(1, dt * lerpRate);

      // Apply glow — red tint when blocked, silvery-blue when clear
      if (data.glow && data.glow.material) {
        data.glow.material.opacity = data.intensity * 0.8;
        if (blocked) {
          data.glow.material.color.setHex(0xff4444);
        } else {
          data.glow.material.color.setHex(0x99bbdd);
        }
      }

      // Plume visibility, scale, and steady ion shimmer.
      if (data.plume) {
        data.plume.visible = data.intensity > 0.05;
        if (data.plume.visible) {
          // Frame-rate-independent shimmer: sum of two sines (±~5%), NOT per-frame
          // Math.random() (which produced frame-rate-dependent fire flicker). Ion
          // emission is steady — length breathes with thrust, width stays ~constant.
          const t = Date.now() * 0.001;
          const shimmer = 1 + 0.032 * Math.sin(t * 6.1 + i * 1.7)
                            + 0.02 * Math.sin(t * 11.3 + i * 2.9);
          const lenS = (0.55 + data.intensity * 0.9) * shimmer; // grows aft with thrust
          const wS = 0.9 + data.intensity * 0.12;               // width nearly constant
          data.plume.scale.set(wS, lenS, wS);                   // local +Y = beam length
          data.plume.material.opacity = data.intensity * 0.5;   // steady (fade is vertex-alpha)
          // Red-shift plume when interlock active (C-9 — preserved)
          data.plume.material.color.setHex(blocked ? 0xff6644 : 0x99bbdd);
        }
      }

      // Outer volumetric glow — softer, larger, slightly slower shimmer.
      if (data.outerGlow) {
        data.outerGlow.visible = data.intensity > 0.08;
        if (data.outerGlow.visible) {
          const t = Date.now() * 0.001;
          const shimmer = 1 + 0.028 * Math.sin(t * 4.3 + i * 2.3);
          const lenS = (0.6 + data.intensity * 0.8) * shimmer;
          const wS = 0.95 + data.intensity * 0.1;
          data.outerGlow.scale.set(wS, lenS, wS);
          data.outerGlow.material.opacity = data.intensity * 0.16;
          data.outerGlow.material.color.setHex(blocked ? 0xff4422 : 0xaaccee);
        }
      }

      // Inner nozzle liner — emissive intensifies when nozzle fires
      if (data.innerLiner && data.innerLiner.material) {
        const DT = Constants.DIFFERENTIAL_THRUST;
        const fireEmissive = DT.INNER_EMISSIVE_BASE + data.intensity * DT.INNER_EMISSIVE_FIRE_SCALE;
        data.innerLiner.material.emissiveIntensity = fireEmissive;
        if (blocked) {
          data.innerLiner.material.emissive.setHex(0x662222);
        } else {
          data.innerLiner.material.emissive.setHex(0x334466);
        }
      }
    });

    // Reset differential targets — caller must re-set every frame for sustained fire
    this._differentialFireTargets[0] = 0;
    this._differentialFireTargets[1] = 0;
    this._differentialFireTargets[2] = 0;
    this._differentialFireTargets[3] = 0;

    // Attitude (RCS) thrusters — DIRECTION-AWARE (Phase 4; generalized to 3-D
    // for the doghouse pods). thrustInput carries LOCAL translation ΔV. Each
    // nozzle stores its EXHAUST direction (`_rcsExhaustDir`: radial for the
    // lateral bells, ±Z for the pod axial bells), and fires when its exhaust
    // opposes the demand: to thrust +X, the exhaust must exit −X. The z demand
    // now lights the axial bells too (fore pods exhaust +Z for retro trim, aft
    // pods −Z for prograde trim) — previously ±Z translation had NO RCS visuals.
    // Replaces the old shared attitudeIntensity that lit all 8 regardless.
    _rcsL.set(ti.x, ti.y, ti.z);
    const lMag = _rcsL.length();
    const transScale = Math.min(1, lMag * 5000);   // keep the established ·5000 scale
    const haveLat = lMag > 1e-12 && transScale > 0.001;
    if (haveLat) _rcsLn.copy(_rcsL).divideScalar(lMag);
    const plumes = this.attitudeThrusterPlumes;
    const shadowMul = this._inShadow ? 0.35 : 1;   // §4 eclipse dimming (cold gas isn't self-luminous)
    const flash = this._rcsAttitudeFlash;
    for (let k = 0; k < plumes.length; k++) {
      const plume = plumes[k];
      const exhaust = this._rcsExhaustDir[k];
      // A nozzle fires when its exhaust opposes the thrust demand:
      // intensity = max(0, dot(-exhaust, L̂)) · transScale.
      let transInten = 0;
      if (haveLat && exhaust) transInten = Math.max(0, -exhaust.dot(_rcsLn)) * transScale;
      // Attitude rotation lights the couple bells directly (§1), decoupled from
      // the puff cadence. Composite = max(translation, attitude flash).
      const attInten = flash ? flash[k] : 0;
      const inten = Math.max(transInten, attInten);
      plume.visible = inten > 0.1;
      if (plume.visible && plume.material) {
        plume.material.opacity = inten * 0.5 * shadowMul;
        // Jet-core streak (§2): grow the plume along its beam axis (+Y) with
        // intensity — root welded to the bell mouth, so it stretches outward.
        const s = 0.7 + inten * 0.6;              // puffier with demand
        plume.scale.set(s, s * (1 + 0.4 * inten), s);
      }
      // Liner throat glow (§1): brighten only firing bells; emissive → 0 as the
      // flash decays, so no restore bookkeeping is needed (driven every frame).
      const liner = this._rcsLiners && this._rcsLiners[k];
      if (liner && liner.material) {
        liner.material.emissive.setHex(0x8fb0d8);
        liner.material.emissiveIntensity = 0.6 * inten;
      }
    }

    // Decay the attitude flash toward 0 (§1). Held keys re-raise it each frame in
    // fireRcsRotation; released keys fade over ~1/8 s.
    if (flash) {
      const decay = Math.exp(-8 * dt);
      for (let k = 0; k < flash.length; k++) {
        flash[k] *= decay;
        if (flash[k] < 1e-3) flash[k] = 0;
      }
    }
  }

  /**
   * @private Scan flash — brief cyan emissive pulse on body material.
   * Triggered by SCAN_INITIATED event, decays over 0.5s.
   */
  _animateScanFlash(dt) {
    if (this._scanFlashTimer <= 0) return;
    this._scanFlashTimer -= dt;

    const t = Math.max(0, this._scanFlashTimer / 0.5); // 1→0 over 0.5s
    const done = this._scanFlashTimer <= 0;

    // Drive BOTH the MLI body blanket and the solar-cell panels with the cyan
    // scan glow. Restore values MUST match each material's build defaults
    // (mismatched restores previously dimmed the barrel permanently after the
    // first scan).
    if (this._matBody) {
      this._matBody.emissive.setHex(0x00aaff);     // cyan scan glow
      this._matBody.emissiveIntensity = t * 0.6;    // peak 0.6, fade to 0
      if (done) {
        this._matBody.emissive.setHex(0x4a3008);    // gold MLI build default (_matGoldMLI)
        this._matBody.emissiveIntensity = 0.16;
      }
    }
    if (this._cellSkinMats) {
      for (const mat of this._cellSkinMats) {
        mat.emissive.setHex(0x00aaff);
        mat.emissiveIntensity = t * 0.6;
        if (done) {
          mat.emissive.setHex(0x0b1030); // build default (_buildMainBus)
          mat.emissiveIntensity = 0.18;
        }
      }
    }
    // ROSA wings: sweep the same cyan scan pulse across the cell faces while the
    // flash is active. On `done` we DON'T restore — _animateRosaGlow runs every
    // frame (before this) and reasserts the power-flow emissive, so it owns the
    // ROSA steady state and there is nothing to restore here.
    if (!done && this._rosaFrontMats) {
      for (const mat of this._rosaFrontMats) {
        mat.emissive.setHex(0x00aaff);
        mat.emissiveIntensity = t * 0.7;
      }
    }
  }

  /** @private LIDAR occasional green pulse */
  _animateLidarPulse(dt) {
    this._lidarPulseTimer += dt;
    if (this._lidarPulseTimer > 3.0) {
      this._lidarPulseTimer = 0;
      // Pulse
      this._lidarLightMat.opacity = 1.0;
    }
    // Fade
    if (this._lidarLightMat.opacity > 0) {
      this._lidarLightMat.opacity = Math.max(0, this._lidarLightMat.opacity - dt * 2.0);
    }
  }

  /** @private Tether indicator colors based on state (Config G: no-op, bus reels removed) */
  _animateTetherIndicators(dt) {
    // Config G: bus-mounted tether reels removed — guard against empty arrays
    if (!this._tetherIndicators || this._tetherIndicators.length === 0) return;

    this._tetherStates.forEach((state, i) => {
      const ind = this._tetherIndicators[i];
      if (!ind) return;

      switch (state) {
        case 'ready':
          ind.material.color.setHex(0x00ff44); // Green
          break;
        case 'deployed':
          ind.material.color.setHex(0xffaa00); // Yellow
          // Animate spool rotation
          if (this.tetherReels && this.tetherReels[i]) {
            this.tetherReels[i].children[1].rotation.y += dt * 2;
          }
          break;
        case 'empty':
          ind.material.color.setHex(0xff2222); // Red
          break;
      }
    });

    // EDT active glow — pulse tether indicators blue when EDT is on (Phase 6)
    // Uses color override since indicators are MeshBasicMaterial (no emissive)
    if (this._edtActive && this._tetherIndicators && this._tetherIndicators.length > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.005);
      const r = Math.round(79 * pulse);        // 0x4f = 79
      const g = Math.round(195 * (0.5 + 0.5 * pulse)); // 0xc3 = 195
      const b = Math.round(247);                // 0xf7 = 247
      for (const indicator of this._tetherIndicators) {
        if (indicator && indicator.material) {
          indicator.material.color.setRGB(r / 255, g / 255, b / 255);
        }
      }
    }
  }

  // ==========================================================================
  // SYSTEM REFERENCES (Phase 4)
  // ==========================================================================

  /** Set ResourceSystem reference for fuel-aware thrust. */
  setResourceSystem(rs) { this._resourceSystem = rs; }

  /** Set CargoSystem reference for cargo-based fuel consumption. */
  setCargoSystem(cs) { this._cargoSystem = cs; }

  /**
   * Show/hide the diagnostic hull edge-outline (INSPECT view treatment).
   * Gated by Constants.INSPECTION.HULL_OUTLINE so it can be disabled globally.
   * The LineSegments is built lazily on the FIRST show (visual-detail audit
   * Task 3a): EdgesGeometry over the carved barrel is boot waste for sessions
   * that never open INSPECT. Cached after first build.
   * @param {boolean} visible
   */
  setHullOutlineVisible(visible) {
    const enabled = Constants.INSPECTION?.HULL_OUTLINE !== false;
    const want = !!visible && enabled;
    if (want && !this._hullOutline && this.body) {
      // First show — build from the live (groove-carved) barrel geometry so the
      // outline matches the hull exactly. EdgesGeometry yields the axial seams
      // + rim circles (clean silhouette).
      const INS = Constants.INSPECTION || {};
      const outlineEdges = new THREE.EdgesGeometry(
        this.body.geometry, INS.HULL_OUTLINE_THRESHOLD_DEG ?? 20,
      );
      this._hullOutline = new THREE.LineSegments(
        outlineEdges,
        new THREE.LineBasicMaterial({
          color: INS.HULL_OUTLINE_COLOR ?? 0x00ffcc,
          transparent: true,
          opacity: 0.85,
        }),
      );
      this._hullOutline.rotation.x = Math.PI / 2; // match this.body orientation
      this._hullOutline.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // draw on top
      this.add(this._hullOutline);
    }
    if (!this._hullOutline) return;
    this._hullOutline.visible = want;
  }

  // ==========================================================================
  // V5 CROSSBOW — ARM MANAGER & RECOIL (Phase 4 Mothership)
  // ==========================================================================

  /**
   * Set arm manager reference for interlock and recoil calculations.
   * @param {import('./ArmManager.js').ArmManager} armManager
   */
  setArmManager(armManager) {
    this.armManager = armManager;
  }

  /**
   * Apply recoil momentum from crossbow arm firing.
   * Newton's 3rd law: p_recoil = m_arm × v_launch / m_mother
   * Single Weaver at 10 m/s: 6.6 × 10 / 130 = 0.508 m/s recoil
   * Single Spinner at 10 m/s: 2.1 × 10 / 130 = 0.162 m/s recoil
   * @param {object} data - { armIndex, armMass, speed }
   * @private
   */
  _applyCrossbowRecoil(data) {
    const { armMass, speed } = data;
    const motherMass = this.mass || 130; // kg
    const recoilSpeed = (armMass * speed) / motherMass;

    // Convert recoil speed (m/s) to scene units/s.
    // Scale to 10% of theoretical — subtle nudge, not disorienting for new players.
    // Real ADR sats have internal momentum management that absorbs most recoil.
    const RECOIL_SCALE = 0.1;
    const recoilDv = recoilSpeed * M * RECOIL_SCALE;

    // Apply recoil as velocity change opposite to arm launch direction
    // Approximate: backward along ship's current heading (-Z local axis)
    const backward = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(this.quaternion)
      .multiplyScalar(recoilDv);
    this._rcsVelocity.add(backward);

    // Track cumulative recoil for this frame — DUAL_FIRE_RECOIL may
    // supersede these individual impulses (opposing arms cancel naturally).
    this._frameRecoilDv += recoilDv;
    this._frameRecoilCount++;

    // Auto-compensate with RCS if enabled (single-arm fire).
    // For dual-fire, individual compensations still apply but the net
    // velocity change is zero (backward + forward cancel). The N₂ cost
    // is refunded when DUAL_FIRE_RECOIL arrives with cancelled=true.
    this._autoRcsCompensation(recoilDv);
  }

  /**
   * Automatic RCS compensation after crossbow recoil.
   * Uses cold-gas N₂ — 3.7g per Weaver single-fire compensation.
   * @param {number} recoilDv - Scene-scale ΔV to compensate
   * @private
   */
  _autoRcsCompensation(recoilDv) {
    if (!this._crossbowAutoRcs) return; // Can be toggled by player

    // Calculate N₂ needed (proportional to ΔV relative to Weaver baseline)
    const baseRecoilDv = DUALFIRE_RECOIL_WEAVER * M;
    const n2Grams = DUALFIRE_RCS_COMPENSATION_N2 * (recoilDv / baseRecoilDv);

    // Consume cold gas resource via EventBus (ResourceSystem is canonical owner)
    const n2Kg = n2Grams / 1000;
    eventBus.emit(Events.RESOURCE_CONSUME, {
      resource: 'coldGas',
      amount: n2Kg,
    });

    // Track actual N₂ consumed for dual-fire refund
    this._frameN2Consumed += n2Kg;

    // Apply counter-impulse (cancel the recoil)
    const forward = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(this.quaternion)
      .multiplyScalar(recoilDv);
    this._rcsVelocity.add(forward);

    // Show RCS compensation puff visual
    this._triggerRcsPuff('compensation');
  }

  /**
   * Handle dual-fire recoil result.
   * If cancelled: no compensation needed (opposing arms cancelled momentum).
   * If residual: small RCS correction only.
   * @param {object} data - { cancelled: boolean, residualDv: number }
   * @private
   */
  _applyDualFireRecoil(data) {
    if (data.cancelled) {
      // Momentum fully cancelled by opposing arms — refund N₂ that
      // individual CROSSBOW_FIRE handlers consumed (2 arms × compensation).
      // Each arm's autoRcsCompensation already cancelled the velocity,
      // so we only need to refund the cold gas.
      if (this._crossbowAutoRcs && this._frameN2Consumed > 0) {
        // Refund exact N₂ consumed by individual arm compensations
        eventBus.emit(Events.RESOURCE_REPLENISH, {
          resource: 'coldGas',
          amount: this._frameN2Consumed,
        });
      }
      this._frameRecoilDv = 0;
      this._frameRecoilCount = 0;
      this._frameN2Consumed = 0;
      return;
    }

    // Small residual — apply minimal RCS correction
    this._frameRecoilDv = 0;
    this._frameRecoilCount = 0;
    this._frameN2Consumed = 0;
    const residualDv = data.residualDv * M;
    this._autoRcsCompensation(residualDv);
  }

  /**
   * C-11: Apply angular impulse from Config G dual-fire residual.
   * Converts torque impulse (N·m·s) to angular velocity change via
   * approximate moment of inertia (I ≈ mass × r² where r = 0.5 m).
   * RCS nulling runs in _tickRecoilRcs() during update loop.
   *
   * @param {number} torqueImpulse — angular impulse in N·m·s
   */
  applyRecoilAngularImpulse(torqueImpulse) {
    if (!Constants.FEATURE_FLAGS.RECOIL_PHYSICS) return;
    // Approximate MOI for a 130 kg cylinder of radius 0.5 m
    const I_mother = (this.mass || 130) * 0.25; // kg·m²
    const deltaOmega = torqueImpulse / I_mother;
    this._recoilAngularVel += deltaOmega;
  }

  /**
   * C-11: RCS damping of recoil angular velocity.
   * Nulls _recoilAngularVel toward zero at RCS angular authority rate.
   * Called each frame from update(). Settles within ~2 s.
   * @param {number} dt — frame time in seconds
   * @private
   */
  _tickRecoilRcs(dt) {
    if (Math.abs(this._recoilAngularVel) < 1e-6) {
      this._recoilAngularVel = 0;
      return;
    }
    // RCS angular authority: ~0.5 rad/s² (cold-gas thrusters)
    const rcsAuthority = 0.5; // rad/s²
    const maxDelta = rcsAuthority * dt;
    if (Math.abs(this._recoilAngularVel) <= maxDelta) {
      this._recoilAngularVel = 0;
    } else {
      this._recoilAngularVel -= Math.sign(this._recoilAngularVel) * maxDelta;
    }
  }

  /**
   * C-11: Apply induced torque from CoM offset during recoil.
   * Called by ArmManager when both RECOIL_PHYSICS and COM_TRACKING are enabled.
   * The torque vector comes from computeInducedTorque(comPos, recoilForce).
   *
   * @param {{ x: number, y: number, z: number }} torqueVec — torque in N·m
   */
  applyInducedTorque(torqueVec) {
    if (!Constants.FEATURE_FLAGS.RECOIL_PHYSICS) return;
    if (!torqueVec) return;
    // Convert torque vector magnitude to angular velocity (simplified)
    const I_mother = (this.mass || 130) * 0.25; // kg·m²
    const mag = Math.sqrt(torqueVec.x ** 2 + torqueVec.y ** 2 + torqueVec.z ** 2);
    this._recoilAngularVel += mag / I_mother;
  }

  /**
   * Fire a visual RCS puff for compensation feedback.
   * @param {string} type - 'compensation' | other
   * @private
   */
  _triggerRcsPuff(type) {
    // Fire a forward-facing puff to indicate RCS compensation firing
    this._fireRcsPuff({ x: 0, y: 0, z: 0.5 });
  }

  /**
   * Check if back arm (index 7) is in a state that requires thruster inhibit,
   * AND run Config G plume-geometry interlock (C-9, Gap #8).
   * §13 Thruster Safety: Hall/MPD exhaust endangers arm at retrograde dock.
   * Called each update tick.
   * @private
   */
  _updateThrusterInterlock() {
    if (!this.armManager) {
      this._thrusterInterlock = false;
      this._plumeBlocked = {};
      return;
    }

    // Legacy back-arm check (Y3 Octo retro dock)
    const backArm = this.armManager.arms[7]; // Back arm at retrograde position
    if (backArm) {
      const dangerStates = [
        ARM_STATES.LAUNCHING,
        ARM_STATES.DOCKING,
        ARM_STATES.REELING,
      ];
      this._thrusterInterlock = dangerStates.includes(backArm.state);
    } else {
      this._thrusterInterlock = false;
    }

    // C-9: Plume-geometry interlock (flag-gated)
    if (Constants.FEATURE_FLAGS.THRUSTER_INTERLOCK) {
      this._plumeBlocked = getActiveBlocks(this.armManager);
      // If ANY thruster is plume-blocked, also set the legacy interlock flag
      // so existing thrust methods that check _thrusterInterlock will respect it
      if (Object.keys(this._plumeBlocked).length > 0) {
        this._thrusterInterlock = true;
      }
    } else {
      this._plumeBlocked = {};
    }

    // C-9: Compute and cache CoM (once per frame, used by HUD + torque coupling)
    if (Constants.FEATURE_FLAGS.COM_TRACKING) {
      this._comCache = computeCoM(this.armManager, this);
      this._comDriftM = computeCoMDrift(this.armManager, this);
      this._comDriftVec = computeCoMDriftVector(this.armManager, this);
    } else {
      this._comCache = null;
      this._comDriftM = 0;
      this._comDriftVec = { x: 0, y: 0, z: 0 };
    }
  }

  /**
   * Check if mothership angular velocity is safe for crossbow fire.
   * §16 Attitude Management: recoil torque is dangerous if ω too high.
   * @returns {boolean} true if safe, false if ω too high (HUD should show "STABILIZE")
   */
  isCrossbowFireSafe() {
    // If angular velocity exceeds threshold, firing would cause unpredictable torque
    const maxOmega = 0.1; // rad/s — threshold for safe fire
    if (this.angularVelocity) {
      const omega = typeof this.angularVelocity === 'number'
        ? Math.abs(this.angularVelocity)
        : this.angularVelocity.length();
      return omega < maxOmega;
    }
    return true; // No angular velocity tracking — assume safe
  }

  /**
   * Toggle automatic RCS compensation for crossbow recoil.
   * @returns {boolean} New auto-RCS state
   */
  toggleCrossbowAutoRcs() {
    this._crossbowAutoRcs = !this._crossbowAutoRcs;
    return this._crossbowAutoRcs;
  }

  /**
   * Reset V5 crossbow-related state (call on mission restart).
   */
  resetCrossbowState() {
    this._thrusterInterlock = false;
    this._plumeBlocked = {};
    this._comCache = null;
    this._comDriftM = 0;
    this._comDriftVec = { x: 0, y: 0, z: 0 };
    this._crossbowAutoRcs = true;
    this._frameRecoilDv = 0;
    this._frameRecoilCount = 0;
    this._frameN2Consumed = 0;
  }

  /** @returns {boolean} Whether thruster interlock is active (back arm blocking exhaust) */
  get thrusterInterlocked() { return this._thrusterInterlock; }

  /** @returns {boolean} Whether auto-RCS compensation is enabled */
  get crossbowAutoRcs() { return this._crossbowAutoRcs; }

  /**
   * C-9: Get cached CoM computation result from this frame.
   * Only populated when COM_TRACKING flag is ON.
   * @returns {{ position: {x,y,z}, totalMass: number, breakdown: object }|null}
   */
  getCoMCache() { return this._comCache; }

  /**
   * C-9: Get cached CoM drift distance (meters) from this frame.
   * Returns 0 when COM_TRACKING flag is OFF.
   * @returns {number}
   */
  getCoMDrift() { return this._comDriftM; }

  /**
   * C-9: Get the plume-blocked thruster map from this frame.
   * @returns {Object<string, string>} Map: { thrusterId → reason }
   */
  getPlumeBlocks() { return this._plumeBlocked; }

  // ==========================================================================
  // UPGRADES
  // ==========================================================================

  /**
   * Recompute the effective ion-drive delta-V from its base and the composable
   * multiplier factors (Ion Booster × MPD passive). Called by applyUpgrade so
   * the two upgrades stack instead of overwriting each other, and so re-applying
   * either on the save-restore path is idempotent.
   * @private
   */
  _recomputeIonDeltaV() {
    this._ionDeltaV = this._baseIonDeltaV * this._thrustMult * this._mpdPassiveMult;
  }

  /**
   * Apply a shop upgrade that affects propulsion properties.
   * Modifies the rate properties that thrustIon()/thrustColdGas() already read.
   * @param {object} data - { effect: string, value: number }
   */
  applyUpgrade(data) {
    switch (data.effect) {
      case 'xenonEfficiency':
        // value=0.8 → 20% less xenon consumption per thrust tick
        this._ionThrustXenonRate = this._baseIonXenonRate * data.value;
        break;
      case 'thrustMultiplier':
        // value=1.5 → 50% more thrust delta-V per tick
        this._thrustMult = data.value;
        this._recomputeIonDeltaV();
        break;
      case 'coldGasThrust':
        // value=1.3 → 30% more cold gas thrust per tick
        this._coldGasDeltaV = this._baseColdGasDeltaV * data.value;
        break;
      case 'coldGasEfficiency':
        // value=0.8 → 20% less cold gas consumption per tick
        this._coldGasRate = this._baseColdGasRate * data.value;
        break;
      case 'mpdThruster':
        // F16 + F2: Unlock MPD thruster from shop purchase. The burst subsystem
        // (toggleMPDArmed) stays dormant (no hotkey); the MPD instead delivers a
        // REAL passive gain by boosting the primary ion drive so ch11's copy
        // ("its passive drive trims your transfer burns") is honest. Idempotent on
        // save-restore because it recomputes _ionDeltaV from base × factors.
        this._hasMPD = true;
        this._mpdPassiveMult = Constants.MPD_PASSIVE_THRUST_MULT || 1.5;
        this._recomputeIonDeltaV();
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'PROPULSION',
          text: 'MPD thruster installed. Passive drive boosts primary thrust; lithium reserves feed heavy burns.',
          priority: 'info',
        });
        break;
      case 'mpdCathodeLife':
        // Hardened Cathode upgrade — doubles cathode life
        this._mpdCathodeLife = data.value;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'PROPULSION',
          text: 'Hardened tungsten-rhenium cathode installed. Cathode lifetime extended to 1,200s.',
          priority: 'info',
        });
        break;
      case 'supercapUpgrade':
        // S3b: Graphene Supercapacitor — faster thermal dissipation
        this._hasSupercap = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'POWER',
          text: 'Graphene supercapacitor bank installed. MPD thermal dissipation improved.',
          priority: 'info',
        });
        break;
    }
  }

  // ==========================================================================
  // THROTTLE (F14)
  // ==========================================================================

  /**
   * Set the throttle level (0.0–1.0). Clamps to valid range.
   * Affects all thrust methods proportionally.
   * @param {number} level — desired throttle level
   */
  setThrottleLevel(level) {
    this.throttleLevel = Math.max(0, Math.min(1, level));
    eventBus.emit(Events.THROTTLE_CHANGE, { level: this.throttleLevel });
  }

  // ==========================================================================
  // ROTATION (F13)
  // ==========================================================================

  /**
   * Apply pitch rotation (around local X axis).
   * Positive angle = nose up.
   * @param {number} angle — radians to rotate
   */
  rotatePitch(angle) {
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0), angle
    );
    this._manualRotation.multiply(q);
    this._manualRotation.normalize();
  }

  /**
   * Apply yaw rotation (around local Y axis).
   * Positive angle = nose left.
   * @param {number} angle — radians to rotate
   */
  rotateYaw(angle) {
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), angle
    );
    this._manualRotation.multiply(q);
    this._manualRotation.normalize();
  }

  /**
   * Differential FEEP plume — set per-nozzle firing intensity for attitude rotation.
   * Visual only: does NOT apply torque (rotatePitch/rotateYaw handle that).
   *
   * Nozzle mapping (same-side nozzle fires, +Z = forward model convention):
   *   pitch +1 (nose up)    → HT_TOP    (idx 0, at +Y)
   *   pitch −1 (nose down)  → HT_BOTTOM (idx 1, at −Y)
   *   yaw   +1 (nose left)  → HT_LEFT   (idx 3, at −X)
   *   yaw   −1 (nose right) → HT_RIGHT  (idx 2, at +X)
   *
   * @param {'pitch'|'yaw'} axis — rotation axis
   * @param {number} sign — +1 or −1 direction
   * @param {number} magnitude — 0..1 normalised firing intensity
   */
  setThrusterFire(axis, sign, magnitude) {
    const map = Constants.DIFFERENTIAL_THRUST.NOZZLE_MAP[axis];
    if (!map) return; // unknown axis (roll etc.) — no-op
    const key = sign >= 0 ? '1' : '-1';
    const idx = map[key];
    if (idx === undefined) return;
    this._differentialFireTargets[idx] = Math.max(
      this._differentialFireTargets[idx],
      Math.min(1, magnitude)
    );
  }

  // ==========================================================================
  // THRUST
  // ==========================================================================

  /**
   * Apply ion thrust (costs fuel + battery).
   * Phase 4: fuel type determines thrustScale and consumption source.
   * @param {{ x: number, y: number, z: number }} direction
   * @param {number} dt
   */
  thrustIon(direction, dt) {
    // Power distribution: block thrust entirely if THRUST bus is at 0%
    if (powerDistribution.thrustMultiplier <= 0) {
      const now = performance.now();
      if (now - this._lastThrustOfflineWarning > 3000) {
        this._lastThrustOfflineWarning = now;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: '⚠ ION DRIVE OFFLINE. Increase THRUST power allocation',
          priority: 'warning',
        });
      }
      return;
    }

    // V5: Thruster interlock — back arm in danger zone near FEEP thruster exhaust
    if (this._thrusterInterlock) {
      return;
    }

    // Phase 4: Get current fuel definition for thrust scaling
    const fuel = this._resourceSystem
      ? this._resourceSystem.getCurrentFuel()
      : Constants.FUELS.xenon;
    const thrustScale = fuel.thrustScale || 1.0;

    // Check battery (always required)
    if (this.resources.battery <= 0) {
      eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'no_fuel', type: 'ion' });
      return;
    }

    // Check fuel availability — xenon tank for default, cargo existence for alt fuels
    if (!fuel.fromCargo && this.resources.xenon <= 0) {
      eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'no_fuel', type: 'ion' });
      return;
    }

    // Apply thrust scaled by fuel's thrustScale and throttle level (F14)
    const thr = this.throttleLevel;
    this.thrustInput.x += direction.x * this._ionDeltaV * thrustScale * thr * dt;
    this.thrustInput.y += direction.y * this._ionDeltaV * thrustScale * thr * dt;
    this.thrustInput.z += direction.z * this._ionDeltaV * thrustScale * thr * dt;

    // Classify thrust direction (z = prograde/retrograde axis)
    if (direction.z > 0.5) this._thrustDirection = 'prograde';
    else if (direction.z < -0.5) this._thrustDirection = 'retrograde';
    else if (!this._thrustDirection) this._thrustDirection = 'lateral';
    this._lastThrustType = 'ion';

    // Power distribution modulates Isp/efficiency: higher mult = less fuel consumed
    const efficiencyScale = 1 / powerDistribution.thrustMultiplier;
    const fuelAmount = this._ionThrustXenonRate * dt * efficiencyScale;

    // Phase 4: Route fuel consumption through dual-mode system
    if (this._resourceSystem) {
      this._resourceSystem.consumeIonFuel(fuelAmount);
    } else {
      // Fallback: direct xenon consumption via event
      eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'xenon', amount: fuelAmount });
    }

    // Battery always consumed regardless of fuel type
    eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'battery', amount: this._ionThrustPowerRate * dt });

    // Phase 4: Emit thrust visual event for velocity streaks overlay
    eventBus.emit(Events.THRUST_VISUAL, {
      magnitude: thr,
      direction: this._thrustDirection || 'lateral',
      type: 'ion',
    });

    // Visual: fire RCS puff opposite to thrust direction
    this._fireRcsPuff(direction);
  }

  /**
   * Apply cold-gas thrust (emergency).
   * @param {{ x: number, y: number, z: number }} direction
   * @param {number} dt
   */
  thrustColdGas(direction, dt) {
    if (this.resources.coldGas <= 0) {
      eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'no_fuel', type: 'coldGas' });
      return;
    }

    // F14: Scale by throttle level
    const thr = this.throttleLevel;
    this.thrustInput.x += direction.x * this._coldGasDeltaV * thr * dt;
    this.thrustInput.y += direction.y * this._coldGasDeltaV * thr * dt;
    this.thrustInput.z += direction.z * this._coldGasDeltaV * thr * dt;

    // Classify thrust direction (z = prograde/retrograde axis)
    if (direction.z > 0.5) this._thrustDirection = 'prograde';
    else if (direction.z < -0.5) this._thrustDirection = 'retrograde';
    else if (!this._thrustDirection) this._thrustDirection = 'lateral';
    this._lastThrustType = 'coldgas';

    eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'coldGas', amount: this._coldGasRate * dt });

    // Phase 4: Emit thrust visual event for velocity streaks overlay
    eventBus.emit(Events.THRUST_VISUAL, {
      magnitude: thr,
      direction: this._thrustDirection || 'lateral',
      type: 'coldgas',
    });

    // Visual: fire RCS puff opposite to thrust direction
    this._fireRcsPuff(direction);
  }

  /**
   * Apply MPD thrust (F16). Costs lithium + battery. High thrust, cathode erosion.
   * @param {{ x: number, y: number, z: number }} direction
   * @param {number} dt
   */
  thrustMPD(direction, dt) {
    // Guard: MPD must be unlocked
    if (!this._hasMPD) return;

    // V5: Thruster interlock — back arm in danger zone near FEEP thruster exhaust
    if (this._thrusterInterlock) return;

    // Guard: power distribution — block if THRUST bus is at 0%
    if (powerDistribution.thrustMultiplier <= 0) {
      const now = performance.now();
      if (now - this._lastThrustOfflineWarning > 3000) {
        this._lastThrustOfflineWarning = now;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: '⚠ MPD DRIVE OFFLINE. Increase THRUST power allocation',
          priority: 'warning',
        });
      }
      return;
    }

    // Guard: need lithium
    if (this.resources.lithium <= 0) {
      eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'no_fuel', type: 'mpd' });
      return;
    }

    // Guard: need battery (MPD draws significant power)
    if (this.resources.battery <= 0) {
      eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'no_power', type: 'mpd' });
      return;
    }

    // Cathode degradation factor
    const cathodeLife = this._mpdCathodeLife;
    const degradedFactor = Constants.MPD_DEGRADED_FACTOR || 0.5;
    const cathodeFactor = this._mpdCathodeTime >= cathodeLife ? degradedFactor : 1.0;

    // Apply thrust scaled by throttle level and cathode health
    const thr = this.throttleLevel;
    const dv = this._mpdDeltaV * cathodeFactor * thr * dt;
    this.thrustInput.x += direction.x * dv;
    this.thrustInput.y += direction.y * dv;
    this.thrustInput.z += direction.z * dv;

    // Classify thrust direction
    if (direction.z > 0.5) this._thrustDirection = 'prograde';
    else if (direction.z < -0.5) this._thrustDirection = 'retrograde';
    else if (!this._thrustDirection) this._thrustDirection = 'lateral';
    this._lastThrustType = 'mpd';

    // Consume lithium
    const lithiumCost = (Constants.MPD_LITHIUM_PER_SECOND || 0.5) * dt;
    if (this._resourceSystem) {
      this._resourceSystem.consumeLithium(lithiumCost);
    } else {
      eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'lithium', amount: lithiumCost });
    }

    // S3b: Battery degradation — reduce thrust at low battery
    const batteryFraction = this.resources.batteryMax > 0
      ? this.resources.battery / this.resources.batteryMax : 0;
    const degradeThreshold = Constants.MPD_BURST_POWER_DEGRADE || 0.05;
    const batteryThrustMult = batteryFraction <= degradeThreshold ? 0.5 : 1.0;

    // Apply battery thrust degradation to thrust input
    if (batteryThrustMult < 1.0 && !this._mpdDegraded) {
      this._mpdDegraded = true;
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: '⚠ MPD degraded. Critical power',
        priority: 'warning',
      });
    } else if (batteryThrustMult >= 1.0) {
      this._mpdDegraded = false;
    }

    // Re-scale thrust by battery degradation (applied on top of cathode factor)
    this.thrustInput.x *= batteryThrustMult;
    this.thrustInput.y *= batteryThrustMult;
    this.thrustInput.z *= batteryThrustMult;

    // Consume battery (high power draw — scaled for gameplay)
    const powerCost = (Constants.MPD_POWER_DRAW || 150) * 0.1 * dt; // 150 kW × 0.1 = 15 Wh/s battery drain (S3b)
    eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'battery', amount: powerCost });

    // Track cathode time (increment when firing)
    this._mpdCathodeTime += dt;

    // Check cathode erosion threshold — emit event once when crossed
    if (this._mpdCathodeTime >= cathodeLife &&
        this._mpdCathodeTime - dt < cathodeLife) {
      eventBus.emit(Events.MPD_CATHODE_WORN, {
        cathodeTime: this._mpdCathodeTime,
        degradedFactor,
      });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: `⚠ MPD cathode eroded. Thrust degraded to ${Math.round(degradedFactor * 100)}%`,
        priority: 'warning',
      });
    }

    // S3b: Thermal tracking
    const heatRate = Constants.MPD_BURST_HEAT_RATE || 1.0;
    this._mpdHeat += heatRate * dt;

    // Check overheat
    if (this._mpdHeat >= (Constants.MPD_BURST_OVERHEAT_THRESHOLD || 40)) {
      this._mpdArmed = false;
      this._mpdCooldownTimer = Constants.MPD_BURST_COOLDOWN_TIME || 15;
      eventBus.emit(Events.MPD_OVERHEAT, { heat: this._mpdHeat });
      eventBus.emit(Events.MPD_BURST_END, { reason: 'overheat' });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: '🔥 MPD THERMAL SHUTDOWN. Mandatory cooldown',
        priority: 'critical',
      });
    }

    // S3b: Battery low warning
    const warnThreshold = Constants.MPD_BURST_POWER_WARN || 0.15;
    if (batteryFraction < warnThreshold && batteryFraction > 0) {
      eventBus.emit(Events.MPD_POWER_WARNING, { batteryFraction });
    }

    // Fire event
    eventBus.emit(Events.MPD_FIRE, {
      direction,
      thrust: Constants.MPD_THRUST * cathodeFactor * thr,
      cathodeHealth: Math.max(0, 1 - this._mpdCathodeTime / cathodeLife),
    });

    // Phase 4: Emit thrust visual event for velocity streaks overlay
    eventBus.emit(Events.THRUST_VISUAL, {
      magnitude: thr * cathodeFactor,
      direction: this._thrustDirection || 'lateral',
      type: 'mpd',
    });

    // Visual: fire RCS puff opposite to thrust direction (reuse existing)
    this._fireRcsPuff(direction);
  }

  /** @returns {boolean} Whether MPD thruster is unlocked */
  get hasMPD() { return this._hasMPD; }

  // ========================================================================
  // S3b: MPD BURST MODE
  // ========================================================================
  //
  // ⚠️ FUTURE TEAMS — DORMANT FEATURE (note added 2026-06-16) ⚠️
  // This entire MPD "Ludicrous mode" burst subsystem (toggleMPDArmed + heat /
  // cooldown / lithium / MPD_BURST_START|END events + the StatusPanel HEAT row +
  // the CodexSystem trigger + the AudioSystem burst SFX) is currently
  // UNREACHABLE by the player. `toggleMPDArmed()` has NO caller: it used to be
  // bound to the `M` key, but `M` was reassigned to the Debris Map in the
  // 2026-06-14 hotkey revamp and the arming verb was never re-homed. As of
  // 2026-06-16 the shop now describes the MPD as a passive thrust upgrade (no
  // hotkey promised), so today buying it gives no burst benefit at all.
  //
  // DECISION NEEDED before this ships as a real feature — pick ONE:
  //   (a) Give it an affordance again — bind arming to a free key (`W`, `Y`,
  //       `O`, `,`, or the freed `C`), add it to HotkeyOverlay.HOTKEY_GROUPS +
  //       the README/ARCHITECTURE §6 tables, and wire InputManager →
  //       toggleMPDArmed(). (Re-instate the MPD_BURST control-mode branch that
  //       was removed from InputManager.processInput on 2026-06-16.)  OR
  //   (b) Make it genuinely passive — fold the thrust gain into the normal
  //       drive when `hasMPD` is true and DELETE the burst/heat/arm machinery
  //       (this getter, toggleMPDArmed, the MPD_BURST events, StatusPanel HEAT
  //       row, CodexSystem trigger).  OR
  //   (c) Cut the upgrade from the shop entirely.
  // Until then, leave the code intact but be aware it does nothing in-game.
  // See ARCHITECTURE.md §16 (drift register) for the cross-reference.

  /** @returns {boolean} Whether MPD is armed (Ludicrous mode active) */
  get isMPDArmed() { return this._mpdArmed; }

  /** @returns {number} Current thermal accumulator value */
  get mpdBurstHeat() { return this._mpdHeat; }

  /** @returns {number} Heat as fraction 0–1 of overheat threshold */
  get mpdHeatFraction() {
    return this._mpdHeat / (Constants.MPD_BURST_OVERHEAT_THRESHOLD || 40);
  }

  /** @returns {number} Seconds remaining in forced cooldown (0 = ready) */
  get mpdCooldownRemaining() { return this._mpdCooldownTimer; }

  /** @returns {boolean} Whether Graphene Supercap upgrade is installed */
  get hasSupercap() { return this._hasSupercap; }

  /**
   * Toggle MPD armed state.
   *
   * ⚠️ NO CALLER as of 2026-06-16 — this is dead until a team re-homes the
   * arming verb (its old `M` key is now the Debris Map). See the "DORMANT
   * FEATURE" banner above the `isMPDArmed` getter for the decision options.
   * If you re-bind it, also restore the MPD_BURST control-mode branch in
   * InputManager.processInput and add it to the help pane + docs.
   */
  toggleMPDArmed() {
    if (!this._hasMPD) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: 'MPD thruster not installed.',
        priority: 'warning',
      });
      return;
    }
    if (this._mpdCooldownTimer > 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: `MPD cooling. ${Math.ceil(this._mpdCooldownTimer)}s remaining`,
        priority: 'warning',
      });
      return;
    }
    if (this.resources.lithium <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: 'MPD FUEL DEPLETED. No lithium',
        priority: 'warning',
      });
      return;
    }

    this._mpdArmed = !this._mpdArmed;
    this._mpdDegraded = false;

    if (this._mpdArmed) {
      eventBus.emit(Events.MPD_BURST_START, { armed: true });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: '⚡ MPD ARMED. Ludicrous mode active',
        priority: 'info',
      });
    } else {
      eventBus.emit(Events.MPD_BURST_END, { reason: 'manual' });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'PROPULSION',
        text: 'MPD standby. Ion drive resumed',
        priority: 'info',
      });
    }
  }

  /** @returns {number} Cumulative cathode operation time in seconds */
  get mpdCathodeTime() { return this._mpdCathodeTime; }

  /** @returns {number} Cathode health as fraction (1.0 = new, 0.0 = fully worn) */
  get mpdCathodeHealth() {
    return Math.max(0, 1 - this._mpdCathodeTime / this._mpdCathodeLife);
  }

  /**
   * Apply RCS cold-gas impulse for fine positioning within debris field.
   * Unlike thrustIon/thrustColdGas which change orbital elements,
   * RCS applies tiny velocity nudges to the world position directly.
   * @param {{ x: number, y: number, z: number }} direction - Normalized thrust direction in local frame
   * @param {number} dt - Delta time
   */
  applyRCS(direction, dt) {
    const impulse = Constants.RCS_IMPULSE * this.throttleLevel * dt;

    // Build local-frame axes: prograde (velocity), radial (up from Earth), cross-track
    const vel = this._cartesian.velocity;
    const vLen = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
    let prograde, radialUp, crossTrack;

    if (vLen > 1e-10) {
      prograde = new THREE.Vector3(vel.x, vel.y, vel.z).normalize();
    } else {
      prograde = new THREE.Vector3(0, 0, 1);
    }
    radialUp = this.position.clone().normalize();
    crossTrack = new THREE.Vector3().crossVectors(prograde, radialUp).normalize();
    // Re-orthogonalize radialUp
    radialUp = new THREE.Vector3().crossVectors(crossTrack, prograde).normalize();

    // Map direction: W/S = prograde/retrograde (z), A/D = cross-track (x).
    // The radial (y) axis is retained for completeness but no key feeds it
    // since Q/E radial thrust was removed (hotkey revamp 2026-06-14) —
    // direction.y is always 0 in normal play.
    const worldImpulse = new THREE.Vector3()
      .addScaledVector(prograde, direction.z * impulse)
      .addScaledVector(crossTrack, direction.x * impulse)
      .addScaledVector(radialUp, direction.y * impulse);

    this._rcsVelocity.add(worldImpulse);

    // Visual: fire RCS puff opposite to thrust direction
    this._fireRcsPuff(direction);

    // Phase 4: Emit thrust visual event for velocity streaks overlay (RCS)
    let rcsDir = 'lateral';
    if (direction.z > 0.5) rcsDir = 'prograde';
    else if (direction.z < -0.5) rcsDir = 'retrograde';
    else if (direction.x < -0.5) rcsDir = 'lateral-left';
    else if (direction.x > 0.5) rcsDir = 'lateral-right';
    eventBus.emit(Events.THRUST_VISUAL, {
      magnitude: this.throttleLevel,
      direction: rcsDir,
      type: 'rcs',
    });

    // Clamp to max RCS speed
    const maxV = Constants.RCS_MAX_SPEED;
    if (this._rcsVelocity.length() > maxV) {
      this._rcsVelocity.normalize().multiplyScalar(maxV);
    }
  }

  /**
   * @private — Emit a cold-gas RCS burst at a nozzle mouth: a small diffuse
   * cloud of pooled sprites that free-expands and drifts along the exhaust and
   * thins out fast, the way a cold-gas jet reads in vacuum (no atmospheric
   * flame, no lingering smoke). Each mini-puff is randomised so repeated bursts
   * don't look identical.
   * @param {THREE.Vector3} pos — nozzle-mouth local position
   * @param {THREE.Vector3} dir — exhaust (drift) direction
   * @param {number} now — seconds (performance.now * 0.001)
   */
  _emitColdGas(pos, dir, now) {
    if (!this._rcsPuffs.length) return;
    const base = (dir && dir.lengthSq() > 1e-9)
      ? _v3TmpA.copy(dir).normalize()
      : _v3TmpA.set(0, 1, 0);
    const CLOUD = 2;   // mini-puffs per burst → diffuse, not a single ball
    for (let k = 0; k < CLOUD; k++) {
      const puff = this._rcsPuffs[this._rcsPuffIndex];
      this._rcsPuffIndex = (this._rcsPuffIndex + 1) % this._rcsPuffs.length;

      // Position jitter: a few mm off the mouth so the cloud isn't a point.
      puff.startPos.set(
        pos.x + (Math.random() - 0.5) * M * 0.012,
        pos.y + (Math.random() - 0.5) * M * 0.012,
        pos.z + (Math.random() - 0.5) * M * 0.012,
      );
      // Direction jitter: ±~8° cone spread so the jet fans slightly.
      puff.dir.set(
        base.x + (Math.random() - 0.5) * 0.28,
        base.y + (Math.random() - 0.5) * 0.28,
        base.z + (Math.random() - 0.5) * 0.28,
      ).normalize();

      puff.life     = 0.22 + Math.random() * 0.12;        // 0.22–0.34 s (brief)
      puff.maxScale = M * (0.20 + Math.random() * 0.16);  // expands to 0.20–0.36 m
      puff.baseOp   = 0.32 + Math.random() * 0.16;        // 0.32–0.48 peak, translucent
      puff.drift    = M * (0.45 + Math.random() * 0.35);  // travels 0.45–0.80 m along exhaust
      puff.startTime = now - k * 0.012;                   // tiny stagger between the two
      puff.rot  = Math.random() * Math.PI * 2;            // §3 random initial sprite angle
      puff.spin = (Math.random() - 0.5) * 1.6;            // §3 ±0.8 rad/s slow tumble

      puff.sprite.position.copy(puff.startPos);
      puff.sprite.material.opacity = 0;
      puff.sprite.scale.set(M * 0.04, M * 0.04, M * 0.04);
      puff.sprite.visible = true;
      puff.active = true;
    }
  }

  /**
   * Fire the RCS attitude couple for a pitch/yaw rotation demand: puffs the pod
   * nozzles that produce the torque (visual) and consumes cold gas (N₂). Called
   * per-frame while an arrow key is held. Rotation kinematics stay in
   * rotatePitch/rotateYaw — this is the propellant + plume side of it.
   * @param {'pitch'|'yaw'} axis
   * @param {number} sign — +1 / −1 rotation direction
   * @param {number} magnitude — 0..1 firing intensity (spring-reduced under tether)
   * @param {number} dt — frame delta (s) for propellant scaling
   */
  fireRcsRotation(axis, sign, magnitude, dt) {
    if (!this._rcsPuffs.length || !this._rcsAttitudeNozzles) return;
    const key = axis + (sign >= 0 ? 'Pos' : 'Neg');
    const nozzles = this._rcsAttitudeNozzles[key];
    if (!nozzles || !nozzles.length) return;

    // Cold-gas (N₂) cost while attitude-thrusting — only when propellant remains
    // (rotation itself is never hard-blocked, to avoid an attitude soft-lock).
    if (magnitude > 0.01 && this.resources.coldGas > 0 && dt > 0) {
      const RCS_ATTITUDE_N2_FACTOR = 0.3;   // attitude puffs cost less than translation
      eventBus.emit(Events.RESOURCE_CONSUME, {
        resource: 'coldGas',
        amount: this._coldGasRate * RCS_ATTITUDE_N2_FACTOR * Math.min(1, magnitude) * dt,
      });
    }

    // Attitude cone/liner flash (Phase 3 §1): light the couple bells' plume
    // meshes directly from rotation demand, BEFORE the puff cooldown early-return
    // so a held key keeps the cones lit steadily while the cloud puffs at its own
    // 0.12 s cadence. Decayed in _animateThrusterGlow.
    if (this._rcsAttitudeFlash && this._rcsAttitudeIdx) {
      const idx = this._rcsAttitudeIdx[key] || [];
      for (let n = 0; n < idx.length; n++) {
        const i = idx[n];
        // §5 first-pulse spike: a valve-opening transient. When the couple is
        // effectively cold (<0.05), overshoot to 1.25× so the plume pops on
        // start; the exp(−8·dt) decay eats it in ~30 ms, after which held keys
        // re-raise to exactly `magnitude` (spike=1.0). Do NOT clamp to 1.
        const spike = this._rcsAttitudeFlash[i] < 0.05 ? 1.25 : 1.0;
        this._rcsAttitudeFlash[i] = Math.max(this._rcsAttitudeFlash[i], magnitude * spike);
      }
    }

    // Puff visual — per-couple cooldown so held keys puff at a steady cadence.
    const now = performance.now() * 0.001;
    const ck = `att_${key}`;
    if (this._rcsPuffLastFire[ck] && (now - this._rcsPuffLastFire[ck]) < 0.12) return;
    this._rcsPuffLastFire[ck] = now;
    const ndirs = this._rcsAttitudeDirs[key] || [];
    for (let i = 0; i < nozzles.length; i++) this._emitColdGas(nozzles[i], ndirs[i], now);
  }

  /**
   * §2 — Cache the camera world position for cold-gas sun-scatter brightening.
   * Called from the main render loop each frame (no per-frame alloc).
   * @param {THREE.Vector3} v
   */
  setCameraWorldPos(v) {
    if (!v) return;
    this._camWorldPos ||= new THREE.Vector3();
    this._camWorldPos.copy(v);
  }

  /**
   * Fire a single counter-firing RCS stop pulse on arrow-key RELEASE. Rotation
   * is kinematic (rotatePitch applies angle directly while held), so a real
   * craft nulls the residual rate by firing the OPPOSITE couple once on release.
   * Visual pop only + a fixed N₂ sip; never blocks.
   * @param {'pitch'|'yaw'} axis
   * @param {number} heldSign — the sign of the rotation that WAS held
   */
  fireRcsStopPulse(axis, heldSign) {
    if (!this._rcsPuffs.length || !this._rcsAttitudeIdx) return;
    // The OPPOSITE couple nulls the rate.
    const key = axis + (heldSign >= 0 ? 'Neg' : 'Pos');

    // Flash pop: flat 1.0 (decays in ~1/8 s via _animateThrusterGlow). Does NOT
    // route through the §5 spike branch — this flat value IS the pop.
    const flash = this._rcsAttitudeFlash;
    if (flash) {
      const idx = this._rcsAttitudeIdx[key] || [];
      for (let n = 0; n < idx.length; n++) {
        const i = idx[n];
        flash[i] = Math.max(flash[i], 1.0);
      }
    }

    // Fixed N₂ sip (≈ one 0.1 s attitude burn); never blocks the visual.
    if (this.resources.coldGas > 0) {
      eventBus.emit(Events.RESOURCE_CONSUME, {
        resource: 'coldGas',
        amount: this._coldGasRate * 0.3 * 0.1,
      });
    }

    // One puff burst, guarded against key-repeat bounce double-fires.
    const now = performance.now() * 0.001;
    const ck = `stop_${key}`;
    if (this._rcsPuffLastFire[ck] && (now - this._rcsPuffLastFire[ck]) < 0.25) return;
    this._rcsPuffLastFire[ck] = now;
    const nozzles = this._rcsAttitudeNozzles[key] || [];
    const ndirs = this._rcsAttitudeDirs[key] || [];
    for (let i = 0; i < nozzles.length; i++) this._emitColdGas(nozzles[i], ndirs[i], now);
  }

  /**
   * @private — Fire RCS puff sprites opposite to the given thrust direction.
   * Uses a round-robin pool of 8 sprites with per-nozzle cooldown.
   * @param {{ x: number, y: number, z: number }} direction
   */
  _fireRcsPuff(direction) {
    if (!this._rcsPuffs.length) return;
    const now = performance.now() * 0.001; // seconds
    const cooldown = 0.12; // min seconds between puffs per nozzle
    const threshold = 0.1;

    const axes = [
      { val: direction.z, pos: 'pz', neg: 'nz' },
      { val: direction.x, pos: 'px', neg: 'nx' },
      { val: direction.y, pos: 'py', neg: 'ny' },
    ];

    for (const { val, pos, neg } of axes) {
      let nozzleKey = null;
      if (val > threshold) nozzleKey = pos;
      else if (val < -threshold) nozzleKey = neg;
      if (!nozzleKey) continue;

      // Per-nozzle cooldown
      if (this._rcsPuffLastFire[nozzleKey] &&
          (now - this._rcsPuffLastFire[nozzleKey]) < cooldown) continue;
      this._rcsPuffLastFire[nozzleKey] = now;
      this._emitColdGas(this._rcsPuffNozzles[nozzleKey], this._rcsPuffDirs[nozzleKey], now);
    }
  }

  /**
   * @private — Animate active cold-gas puffs. In vacuum a cold-gas jet appears
   * at the nozzle, free-expands and drifts along the exhaust, and thins out
   * fast. Each puff drifts (constant velocity), grows quickly (∝√t), and fades
   * with a quick rise-then-decay — no lingering atmospheric smoke.
   * @param {number} dt — frame delta (unused; uses absolute time)
   */
  _updateRcsPuffs(dt) {
    const now = performance.now() * 0.001;
    const shadowMul = this._inShadow ? 0.35 : 1;   // §4 eclipse dimming (readability floor)

    // §2 sun-scatter: ONE forward-lobe factor per frame (puffs cluster within
    // ~1 m of the craft, so a single view vector suffices). Falls back to 1 in
    // shadow / headless / null-sun frames.
    let scatter = 1;
    if (!this._inShadow && this._camWorldPos && this._sunDirWorld) {
      this.getWorldPosition(_v3TmpA);                       // craft world pos
      const viewDir = _v3TmpB.copy(_v3TmpA).sub(this._camWorldPos).normalize();
      const g = Math.max(0, viewDir.dot(this._sunDirWorld));
      scatter = 1 + 0.5 * g * g * g * g;                    // sharp forward lobe, max 1.5×
    }
    // §4 earthshine tint colour for active puffs.
    const tint = this._inShadow ? 0x8fa0c8 : 0xcfe0ff;

    for (const puff of this._rcsPuffs) {
      if (!puff.active) continue;
      const age = now - puff.startTime;
      const life = puff.life || 0.3;

      if (age >= life) {
        puff.sprite.visible = false;
        puff.sprite.material.opacity = 0;
        puff.active = false;
        continue;
      }

      const t = age / life;                 // 0 → 1
      // Drift along exhaust at constant velocity (free jet).
      puff.sprite.position.copy(puff.startPos).addScaledVector(puff.dir, puff.drift * t);
      // Rapid free-expansion (fast early, ∝√t) from a small mouth size.
      const startS = M * 0.04;
      const s = startS + (puff.maxScale - startS) * Math.sqrt(t);
      puff.sprite.scale.set(s, s, s);
      // §3 slow tumble (cloned mats → per-puff safe).
      puff.sprite.material.rotation = puff.rot + puff.spin * age;
      // §4 earthshine tint, driven every frame (no restore bookkeeping).
      puff.sprite.material.color.setHex(tint);
      // Quick rise (~first 10%) then thin out — translucent, gone fast.
      const rise = Math.min(1, t / 0.1);
      const fall = Math.pow(1 - t, 1.5);
      // §2 scatter brightening, capped at 0.85 so stacked additive sprites
      // can't blow out.
      puff.sprite.material.opacity = Math.min(0.85, puff.baseOp * rise * fall * shadowMul * scatter);
    }
  }

  // --------------------------------------------------------------------------
  // Strut sweep animation (Epic 10 V-3)
  // --------------------------------------------------------------------------

  /**
   * @private — Each frame: read arm aim-alpha and rotate strut pivot.
   *
   * Sweep maps getAimAlpha() (0–π) to strut orientation:
   *   α = 0   → strut along −Z (aft / stowed alongside barrel)
   *   α = π/2 → strut radially outward (equatorial)
   *   α = π   → strut along +Z (forward / zenith)
   *
   * The desired strut-tip direction from the pivot is:
   *   d(α) = sin(α) · r̂ − cos(α) · ẑ
   * where r̂ = (cos θ, sin θ, 0) is the radial-outward direction for azimuth θ.
   *
   * The pivot's local −Y axis is rotated to match d(α) using
   * `Quaternion.setFromUnitVectors()`.
   */
  _updateStruts(dt) {
    if (!this.strutGroups || !this.armManager) return;
    const arms = this.armManager.arms;
    if (!arms) return;

    for (let i = 0; i < this.strutGroups.length; i++) {
      if (i >= arms.length) break;
      const sg  = this.strutGroups[i];
      const arm = arms[i];

      // Gradual strut slew: if a target alpha was set (by , / . keys), slew toward it
      if (arm._strutTargetAlpha !== undefined && arm.setAimAlpha) {
        arm.setAimAlpha(arm._strutTargetAlpha, dt);
        // Clear target when reached (within 0.01 rad ≈ 0.6°)
        if (Math.abs(arm.getAimAlpha() - arm._strutTargetAlpha) < 0.01) {
          arm._strutTargetAlpha = undefined;
        }
      }

      // Read current sweep angle from arm FSM (default π/2 = radially out)
      let alpha = (arm.getAimAlpha ? arm.getAimAlpha() : Math.PI / 2);

      // V-11: Stowage — force α = 0 (aft, against barrel) when LOCKED or STOWED
      if (arm.getDeployState) {
        const ds = arm.getDeployState();
        if (ds === 'LOCKED' || ds === 'STOWED') {
          alpha = 0;
        }
      }

      // Compute desired strut direction: sin(α)·radial − cos(α)·Z
      // α=0 → −Z (stowed aft), α=π/2 → radial (equatorial), α=π → +Z (zenith)
      const sinA = Math.sin(alpha);
      const cosA = Math.cos(alpha);
      _strutTo.set(
        sinA * Math.cos(sg.azRad),
        sinA * Math.sin(sg.azRad),
        -cosA,
      );

      // Rotate local -Y → desired direction
      _strutQuat.setFromUnitVectors(_strutFrom, _strutTo);
      sg.pivotGroup.setRotationFromQuaternion(_strutQuat);

      // ── V-4: Update arm dockOffset to track strut tip position ──
      // Tip position in player-local frame = pivot origin + strutDir * strutLen.
      // _strutTo is already a unit vector, so multiply by cached _strutLen.
      // This runs BEFORE armManager.update() in the game loop, so when
      // arm._updateDocked() fires, it uses the updated dockOffset — the arm
      // world position naturally follows the strut tip each frame.
      if (arm.dockOffset && this._strutLen !== undefined) {
        _tipLocal.set(
          sg.pivotGroup.position.x + _strutTo.x * this._strutLen,
          sg.pivotGroup.position.y + _strutTo.y * this._strutLen,
          sg.pivotGroup.position.z + _strutTo.z * this._strutLen,
        );
        arm.dockOffset.copy(_tipLocal);

        // Reel position: 85% along strut from pivot (where the tether exits).
        // The tether anchors HERE, not at the strut tip (100%).
        const REEL_FRAC = 0.85;
        if (!arm._reelOffset) arm._reelOffset = new THREE.Vector3();
        arm._reelOffset.set(
          sg.pivotGroup.position.x + _strutTo.x * this._strutLen * REEL_FRAC,
          sg.pivotGroup.position.y + _strutTo.y * this._strutLen * REEL_FRAC,
          sg.pivotGroup.position.z + _strutTo.z * this._strutLen * REEL_FRAC,
        );

        // Cache strut direction for postArmUpdate orientation
        sg.strutDir.copy(_strutTo);
      }
    }
  }

  /**
   * V-4: Post-arm-update visibility sync.
   *
   * Must be called from the game loop AFTER `armManager.update()` so that
   * `_updateDocked()`'s unconditional `mesh.visible = false` can be overridden
   * for daughter arms whose deploy state is DEPLOYED / DEPLOYING / STOWING
   * (i.e. the strut has swept out and the arm should be visible at the tip).
   *
   * Arms in LOCKED or STOWED deploy state remain hidden (folded inside barrel).
   */
  postArmUpdate() {
    if (!this.armManager || !this.strutGroups) return;
    const arms = this.armManager.arms;
    if (!arms) return;

    const DS = Constants.DEPLOY_STATES;

    for (let i = 0; i < this.strutGroups.length; i++) {
      if (i >= arms.length) break;
      const arm = arms[i];
      const sg  = this.strutGroups[i];

      // ── V-10: Deploy State LEDs — color each hinge LED by arm deploy state ──
      if (this.hingeLEDs && this.hingeLEDs[i]) {
        const led = this.hingeLEDs[i];
        const state = arm.getDeployState ? arm.getDeployState() : DS.DEPLOYED;
        const isRecoil = arm.isHighRecoilZone ? arm.isHighRecoilZone() : false;

        let color;
        let intensity = 1.0;

        if (state === DS.LOCKED) {
          color = 0x222222;
        } else if (state === DS.STOWED) {
          color = 0x664400;
        } else if (state === DS.DEPLOYING) {
          // Pulsing blue (0.3–1.0 intensity)
          intensity = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(Date.now() * 0.005));
          color = 0x0066ff;
        } else if (state === DS.STOWING) {
          // Pulsing amber (0.3–1.0 intensity)
          intensity = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(Date.now() * 0.005));
          color = 0xff8800;
        } else if (state === DS.DEPLOYED && isRecoil) {
          // High recoil zone — amber override
          color = 0xff6600;
        } else {
          // Default: DEPLOYED green
          color = 0x00ff44;
        }

        led.material.color.setHex(color);
        // Dim pulsing states by scaling color channels
        if (intensity < 1.0) {
          led.material.color.multiplyScalar(intensity);
        }
      }

      // Only override visibility + orientation for DOCKED arms (strut-mounted).
      // Arms in other FSM states (TRANSIT, HAULING, etc.) manage their own visuals.
      //
      // Exceptions handled here so a SINGLE owner composes the strut basis (the
      // live sg.strutDir/azRad + mother world quat), avoiding the override-fight
      // bug class (HANDOFF §10 Rule B):
      //   • LAUNCHING (pre-spring): still clamped to the strut — track it, else the
      //     daughter counter-rotates as the ceremony slews the strut to target.
      //   • DOCKING: slerp onto the strut basis over the dock window so the arm
      //     visibly aligns itself — no orientation pop at RELOADING→DOCKED.
      //   • HOLDING_CATCH: snap to the strut basis every frame (like DOCKED) so the
      //     parked daughter holds the catch square to her strut instead of drifting
      //     toward the raw mother-bus quaternion (the wrong-basis defect, Item 4/5).
      if (arm.state !== ARM_STATES.DOCKED) {
        const trackStrut =
          (arm.state === 'LAUNCHING' && !arm._springFired) ||
          arm.state === ARM_STATES.DOCKING ||
          arm.state === ARM_STATES.HOLDING_CATCH;
        if (trackStrut && arm.group && sg.strutDir.lengthSq() > 0) {
          _composeDockedArmQuat(sg.strutDir, sg.azRad, _armQuat);
          _armDockTargetQuat.copy(this.quaternion).multiply(_armQuat);
          if (arm.state === ARM_STATES.DOCKING) {
            // Exponential approach onto the strut over the ~3 s dock window.
            // 0.12/frame ≈ converges in <1 s @60fps; smooth, no snap.
            arm.group.quaternion.slerp(_armDockTargetQuat, 0.12);
          } else {
            arm.group.quaternion.copy(_armDockTargetQuat);
          }
          // Re-dock fix (Issue 8b, 2026-06-12): ArmUnit._updateTether already
          // baked tetherLine.quaternion = group.quaternion⁻¹ during
          // armManager.update() — BEFORE the quat change above. Re-sync here
          // so the rendered tether isn't counter-rotated by this frame's slerp
          // delta (worst at DOCKING entry, where pose error can approach 180°).
          // Single-owner rule (HANDOFF §10 Rule B): this block owns the quat
          // for these states, so it also owns the dependent tether counter-quat.
          if (arm.tetherLine && arm.tetherLine.visible) {
            arm.tetherLine.quaternion.copy(arm.group.quaternion).invert();
          }
        }
        continue;
      }

      if (arm.getDeployState) {
        const ds = arm.getDeployState();
        const shouldShow = (ds === DS.DEPLOYED || ds === DS.DEPLOYING || ds === DS.STOWING);
        if (arm.mesh) arm.mesh.visible = shouldShow;

        // Orient arm.group so its +Z (forward) faces outward along strut
        // direction in world space.  Compose mother's full quaternion with
        // the local strut rotation so the arm inherits pitch/yaw/roll —
        // not just the forward axis.  strutDir is in player-local frame.
        //
        // SYMMETRY: use the deterministic basis (forward + azimuth-radial up)
        // instead of setFromUnitVectors, so every docked daughter shares one
        // roll convention and their body-conformal cells / panel lines stay
        // symmetric around the ring.
        if (shouldShow && arm.group && sg.strutDir.lengthSq() > 0) {
          _composeDockedArmQuat(sg.strutDir, sg.azRad, _armQuat);  // local strut rotation
          arm.group.quaternion.copy(this.quaternion).multiply(_armQuat);
        }
      }
    }
  }

  /**
   * Apply a world-frame Cartesian ΔV impulse to the orbit.
   *
   * Used by [`AutopilotSystem`](js/systems/AutopilotSystem.js:1) to command
   * rendezvous burns independent of the element-rate channel mapping in
   * [`_applyThrust()`](js/entities/PlayerSatellite.js:2139) which is tuned
   * for manual thrust feel.
   *
   * Algorithm: take current Cartesian state (km / km/s), add the impulse
   * (converted m/s → km/s), recompute Keplerian elements via
   * [`cartesianToKeplerian()`](js/entities/OrbitalMechanics.js:129), write
   * back. This is equivalent to the closed-form Gauss planetary equations
   * without the approximations in `_applyThrust`.
   *
   * Side-effects: mutates `this.orbit`, refreshes `this._cartesian`, charges
   * fuel/battery, accumulates `_deltaVSpent`. Does NOT touch `_rcsVelocity`.
   *
   * @param {THREE.Vector3} dvWorld - World-frame ΔV in m/s
   * @param {number} dt - Frame delta (s) for resource bookkeeping
   */
  applyCartesianImpulse(dvWorld, dt) {
    if (!dvWorld) return;
    const dvMag = dvWorld.length();
    if (dvMag < 1e-9 || !isFinite(dvMag)) return;

    // --- Resource / power gating (mirrors thrustIon) ---
    if (powerDistribution.thrustMultiplier <= 0) {
      const now = performance.now();
      if (now - this._lastThrustOfflineWarning > 3000) {
        this._lastThrustOfflineWarning = now;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: '⚠ ION DRIVE OFFLINE. Increase THRUST power allocation',
          priority: 'warning',
        });
      }
      return;
    }
    if (this._thrusterInterlock) return;
    if (this.resources.battery <= 0) {
      eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'no_fuel', type: 'ion' });
      return;
    }
    const fuel = this._resourceSystem
      ? this._resourceSystem.getCurrentFuel()
      : (Constants.FUELS && Constants.FUELS.xenon) || null;
    if (fuel && !fuel.fromCargo && this.resources.xenon <= 0) {
      eventBus.emit(Events.PLAYER_THRUST_FAILED, { reason: 'no_fuel', type: 'ion' });
      return;
    }

    // --- Recompute Cartesian state (km / km/s) from current orbit ---
    const pos = this._cartesian.position;   // scene units
    const vel = this._cartesian.velocity;   // km/s (unchanged by orbitToSceneCartesian)

    const rKm = {
      x: pos.x / Constants.SCENE_SCALE,
      y: pos.y / Constants.SCENE_SCALE,
      z: pos.z / Constants.SCENE_SCALE,
    };
    // Add impulse (convert m/s → km/s by × 0.001)
    const vKms = {
      x: vel.x + dvWorld.x * 0.001,
      y: vel.y + dvWorld.y * 0.001,
      z: vel.z + dvWorld.z * 0.001,
    };

    const newOrbit = cartesianToKeplerian(rKm, vKms);
    if (!isFinite(newOrbit.semiMajorAxis) || newOrbit.semiMajorAxis <= 0) return;

    // Altitude guard (same envelope as _applyThrust)
    const newSmaScene = newOrbit.semiMajorAxis * Constants.SCENE_SCALE;
    const minAlt = Constants.VLEO_MIN + Constants.EARTH_RADIUS;
    const maxAlt = Constants.LEO_MAX + Constants.EARTH_RADIUS;
    if (newSmaScene < minAlt || newSmaScene > maxAlt) {
      // Refuse the burn rather than silently clip — keeps orbital energy accounting honest
      return;
    }

    // --- Write back Keplerian elements ---
    this.orbit.semiMajorAxis = newSmaScene;
    this.orbit.eccentricity = Math.max(0, Math.min(0.1, newOrbit.eccentricity));
    this.orbit.inclination = newOrbit.inclination;
    this.orbit.raan = newOrbit.raan;
    this.orbit.argPerigee = newOrbit.argPerigee;
    this.orbit.trueAnomaly = newOrbit.trueAnomaly;
    this.orbit.meanMotion = newOrbit.meanMotion;

    // Refresh cached Cartesian so subsequent getVelocity/getPosition reads see the new state
    this._cartesian = orbitToSceneCartesian(this.orbit);

    // --- Bookkeeping ---
    this._deltaVSpent += dvMag;

    // Resource consumption: scale with |dv| vs. one ion-thrust tick baseline.
    const baselineDv_mps =
      (this._ionDeltaV || 0.0003) * (this.throttleLevel || 1) * 1000; // rough m/s per tick proxy
    const usage = baselineDv_mps > 1e-6
      ? Math.min(5.0, dvMag / baselineDv_mps)
      : 1.0;
    const fuelAmount = this._ionThrustXenonRate * dt * usage;
    const batteryAmount = this._ionThrustPowerRate * dt * usage;

    if (this._resourceSystem) {
      this._resourceSystem.consumeIonFuel(fuelAmount);
    } else {
      eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'xenon', amount: fuelAmount });
    }
    eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'battery', amount: batteryAmount });

    // --- Visual: fire RCS puff opposite to the impulse direction (in local frame) ---
    const localDir = dvWorld.clone().applyQuaternion(
      this.quaternion.clone().invert()
    ).normalize();
    this._fireRcsPuff({ x: localDir.x, y: localDir.y, z: localDir.z });

    // Velocity-streaks visual
    const dirTag = Math.abs(localDir.z) > Math.max(Math.abs(localDir.x), Math.abs(localDir.y))
      ? (localDir.z > 0 ? 'prograde' : 'retrograde')
      : 'lateral';
    eventBus.emit(Events.THRUST_VISUAL, {
      magnitude: Math.min(1, dvMag * 0.5),
      direction: dirTag,
      type: 'ion',
    });

  }

  /** @private */
  _applyThrust(gameDt) {
    const ti = this.thrustInput;
    const mag = Math.sqrt(ti.x * ti.x + ti.y * ti.y + ti.z * ti.z);
    if (mag < 1e-12) {
      ti.x = ti.y = ti.z = 0;
      return;
    }

    // Accumulate ΔV spent (mag is the actual |Δv| applied this tick)
    this._deltaVSpent += mag;

    const aKm = this.orbit.semiMajorAxis / Constants.SCENE_SCALE;
    const v = orbitalVelocity(aKm, aKm, Constants.MU_EARTH);

    if (Math.abs(ti.z) > 1e-14) {
      const da = 2 * aKm * ti.z / v;
      this.orbit.semiMajorAxis += da * Constants.SCENE_SCALE;
    }

    if (Math.abs(ti.y) > 1e-14) {
      this.orbit.inclination += ti.y / v;
    }

    if (Math.abs(ti.x) > 1e-14) {
      this.orbit.eccentricity += ti.x / (2 * v);
      this.orbit.eccentricity = Math.max(0, Math.min(0.1, this.orbit.eccentricity));
    }

    // C-9: CoM-offset induced torque coupling (COM_TRACKING flag-gated).
    // When asymmetric arm deployment shifts CoM off the thrust line, linear thrust
    // induces a torque τ = r × F. Uses the DRIFT vector (actual − balanced)
    // to isolate player-caused asymmetry from the permanent collar offset.
    // Simplified model: perpendicular drift / barrel length = angular tilt,
    // leaking z-thrust into inclination (y) and eccentricity (x) perturbations.
    if (Constants.FEATURE_FLAGS.COM_TRACKING && this._comDriftM > 1e-8 && mag > 1e-12) {
      const cp = this._comDriftVec; // drift vector, NOT raw CoM position
      const perpSq = cp.x * cp.x + cp.y * cp.y; // XY drift from Z-axis thrust line
      if (perpSq > 1e-12) {
        const barrelLen = Constants.OCTOPUS_V5.CORE_LENGTH; // 2.0 m
        const perpDist = Math.sqrt(perpSq);
        const tiltRad = perpDist / barrelLen; // small-angle approx (typ. < 0.01 rad)
        const leakDv = mag * tiltRad; // ΔV leaked into cross-track
        // Direction of leak = normalize(comXY) — tells which way thrust tilts
        const invPerp = 1 / perpDist;
        const leakY = leakDv * (cp.y * invPerp); // inclination leak
        const leakX = leakDv * (cp.x * invPerp); // eccentricity leak
        if (Math.abs(leakY) > 1e-16) {
          this.orbit.inclination += leakY / v;
        }
        if (Math.abs(leakX) > 1e-16) {
          this.orbit.eccentricity += leakX / (2 * v);
          this.orbit.eccentricity = Math.max(0, Math.min(0.1, this.orbit.eccentricity));
        }
      }
    }

    const minAlt = Constants.VLEO_MIN + Constants.EARTH_RADIUS;
    const maxAlt = Constants.LEO_MAX + Constants.EARTH_RADIUS;
    this.orbit.semiMajorAxis = Math.max(minAlt, Math.min(maxAlt, this.orbit.semiMajorAxis));

    ti.x = ti.y = ti.z = 0;
  }

  // ==========================================================================
  // POSITION & ORIENTATION
  // ==========================================================================

  /** @private */
  _updateCartesian() {
    this._cartesian = orbitToSceneCartesian(this.orbit);
  }

  /** @private */
  _applyPosition() {
    const p = this._cartesian.position;
    this.position.set(p.x, p.y, p.z);
  }

  /** @private Orient the satellite so +Z faces velocity direction (slerp-damped),
   *  then apply manual rotation offset (F13) */
  _orientAlongVelocity() {
    // Autopilot has exclusive orientation control — skip prograde tracking entirely
    if (this.autopilotEngaged) return;

    // Close-inspection hold (V / zoom-in). While the pilot is studying the hull up
    // close, suspend ONLY the prograde auto-orient below — the manual-rotation
    // offset further down still applies, so the player can freely turn the ship to
    // look at a detail without the "autostabilize" slerp dragging it back toward
    // prograde and fighting them. Gated on the same signals that raise the
    // hull-outline overlay so the two stay in lockstep. Prograde settling resumes
    // automatically on exit.
    const inspecting = this._hullInspectView || this._hullInspectZoom;

    const v = this._cartesian.velocity;
    const vLen = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

    if (!inspecting && vLen >= 1e-10) {
      const velDir = new THREE.Vector3(v.x, v.y, v.z).normalize();
      const radial = this.position.clone().normalize();

      // lookAt: eye=pos+vel, target=pos → +Z = velDir (model +Z = forward/prograde).
      // Model convention: thrusters at -Z (aft), sensors at +Z (fore).
      const mat = new THREE.Matrix4();
      const eye = this.position.clone().add(velDir);
      mat.lookAt(eye, this.position, radial);

      // Slerp toward velocity heading — preserves spin momentum on startup
      const targetQuat = new THREE.Quaternion().setFromRotationMatrix(mat);
      this.quaternion.slerp(targetQuat, 0.02); // Low alpha = slow settling, longer spin
    }

    // F13: Apply manual rotation offset. During normal flight this rides on top of
    // the velocity alignment above; during inspection it is the sole attitude
    // driver, letting the player rotate the hull freely.
    if (this._manualRotation.x !== 0 || this._manualRotation.y !== 0 || this._manualRotation.z !== 0) {
      this.quaternion.multiply(this._manualRotation);
      this.quaternion.normalize();
    }

    // F13: Decay manual rotation slowly back to identity when not actively rotating
    this._manualRotation.slerp(new THREE.Quaternion(), 0.01);
  }

  // ==========================================================================
  // SOLAR POWER
  // ==========================================================================

  /** @private */
  _updateSolarPower(sunDirection) {
    if (!sunDirection) {
      this.resources.solarRate = 0;
      this._inShadow = false;   // §4 keep the eclipse cache safe when sun dir is unavailable
      return;
    }

    const panelNormal = _v3TmpA.set(0, 1, 0).applyQuaternion(this.quaternion);
    const sunAngle = Math.max(0, panelNormal.dot(sunDirection));

    const pos = this._cartesian.position;
    const sunDir = { x: sunDirection.x, y: sunDirection.y, z: sunDirection.z };
    const inShadow = isInShadow(pos, sunDir, Constants.EARTH_RADIUS);
    this._inShadow = inShadow;   // §4 cache for puff/plume eclipse dimming

    if (inShadow) {
      this.resources.solarRate = 0;
    } else {
      // Furl coupling: only the ROSA blanket share is gated by furl progress;
      // the body-mount GaAs cells can't furl, so they stay on. A fully furled
      // array keeps ~BODY_MOUNT_POWER_FRACTION of peak; unfurled is unchanged.
      //
      // Feather coupling: feathering parks the deployed blanket edge-on, so its
      // sun-incidence drops by cos(feather·90°). Unlike furl (which scales the
      // ROSA share by roll-out progress), feather attenuates the ROSA share via
      // this geometric incidence factor — fully feathered → ROSA contributes ~0,
      // leaving the body-mount share, but reached by turning rather than rolling.
      const V5 = Constants.OCTOPUS_V5;
      const bodyFrac = V5.BODY_MOUNT_POWER_FRACTION ?? 0;
      const rosaFrac = V5.ROSA_POWER_FRACTION ?? 1;
      const furl = (this._rosaFurlProgress ?? 1);
      const feather = (this._rosaFeatherProgress ?? 0);
      const featherInc = Math.cos(feather * Math.PI / 2); // 1 (flat) → 0 (edge-on)
      const furlMult = bodyFrac + rosaFrac * furl * featherInc;

      this.resources.solarRate =
        Constants.SOLAR_FLUX *
        Constants.SOLAR_PANEL_AREA *
        Constants.SOLAR_PANEL_EFFICIENCY *
        sunAngle *
        this.resources.solarPanelHealth *
        furlMult;
    }
  }

  // ==========================================================================
  // RESOURCES
  // ==========================================================================

  /** @private */
  _updateResources(dt) {
    // Base power draw routed through ResourceSystem (canonical owner)
    const powerDraw = this._basePowerDraw * dt;
    if (powerDraw > 0) {
      eventBus.emit(Events.RESOURCE_CONSUME, { resource: 'battery', amount: powerDraw });
    }

    // Low-resource warnings (reads from player.resources, pushed by ResourceSystem)
    if (this.resources.battery < 10) {
      eventBus.emit(Events.PLAYER_LOW_BATTERY, { level: this.resources.battery });
    }
    if (this.resources.xenon < 10) {
      eventBus.emit(Events.PLAYER_LOW_XENON, { level: this.resources.xenon });
    }
  }

  /**
   * Consume a resource — delegates to ResourceSystem via eventBus.
   * PlayerSatellite.resources is a read-only view; ResourceSystem is the
   * canonical owner and will push updated values back via _syncToPlayer().
   * @param {string} type - 'xenon' | 'coldGas' | 'battery'
   * @param {number} amount
   * @returns {boolean}
   */
  consumeResource(type, amount) {
    if (this.resources[type] === undefined) return false;
    if (this.resources[type] <= 0) {
      return false;
    }

    eventBus.emit(Events.RESOURCE_CONSUME, { resource: type, amount });
    return true;
  }

  // ==========================================================================
  // GETTERS
  // ==========================================================================

  /**
   * Mother-net Phase 1C: apply a cosmetic launch-recoil kick to the hull mesh.
   * The offset (scene units, opposite the launch direction) is added to the
   * rendered position next frame and springs back to zero. VISUAL ONLY — no
   * orbit/fuel/RCS change. See _recoilOffset in the constructor + update().
   * @param {THREE.Vector3} offset — world-space kick offset (scene units)
   */
  applyCosmeticRecoil(offset) {
    if (offset) this._recoilOffset.copy(offset);
  }

  /** @returns {THREE.Vector3} */
  getPosition() {
    return this.position.clone();
  }

  /** @returns {{ x: number, y: number, z: number }} */
  getVelocity() {
    return { ...this._cartesian.velocity };
  }

  // ==========================================================================
  // EDT — Electrodynamic Tether (Phase 6)
  // ==========================================================================

  /** Toggle EDT deployment on/off. */
  toggleEDT() {
    if (!this._edtActive && !this._edtDeployed) {
      // Start deploying
      this._edtDeployed = true;
      this._edtDeployTimer = 0;
      this._edtActive = false;
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'EDT', text: 'Deploying electrodynamic tether...', priority: 'info',
      });
    } else if (this._edtActive) {
      // Retract
      this._edtDeployed = false;
      this._edtActive = false;
      eventBus.emit(Events.EDT_RETRACT);
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'EDT', text: 'EDT retracted', priority: 'info',
      });
    } else if (this._edtDeployed && !this._edtActive) {
      // Still deploying — cancel
      this._edtDeployed = false;
      this._edtDeployTimer = 0;
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'EDT', text: 'EDT deployment cancelled', priority: 'info',
      });
    }
  }

  /** @returns {boolean} Whether EDT is actively attracting debris */
  isEDTActive() { return this._edtActive; }

  /** @returns {boolean} Whether EDT is deployed (may still be deploying) */
  isEDTDeployed() { return this._edtDeployed; }

  /** @returns {object} */
  getOrbitalElements() {
    return { ...this.orbit };
  }

  /** @returns {number} */
  getAltitudeKm() {
    return (this.orbit.semiMajorAxis / Constants.SCENE_SCALE) - Constants.EARTH_RADIUS_KM;
  }

  /** @returns {number} Cumulative ΔV spent in km/s game units */
  getDeltaVSpent() {
    return this._deltaVSpent;
  }

  /** @returns {string|null} 'prograde' | 'retrograde' | 'lateral' | null */
  getThrustDirection() {
    return this._thrustDirection;
  }

  /** @returns {string|null} 'ion' | 'coldgas' | null */
  getLastThrustType() {
    return this._lastThrustType;
  }

  /**
   * Delegation 2 (2026-05-31) — onboarding "struts" beat helper.
   *
   * Briefly brightens every strut's emissive channel to a cyan glow so the
   * player can see what their `,` / `.` keypress just animated.  Self-clears
   * after `durationMs`.  Calling again while a highlight is live extends the
   * timer (idempotent).  Labels are NOT rendered — kept to a glow-only pass
   * since the screen-space label primitive is out of scope for this delegation.
   *
   * @param {number} [durationMs=4000]
   * @returns {boolean} true if struts exist and the highlight was applied
   */
  highlightStrutsForBeat(durationMs = 4000) {
    if (!Array.isArray(this.strutMeshes) || this.strutMeshes.length === 0) return false;
    // Mesh materials may be shared across all struts — collect the unique set.
    const uniqueMats = new Set();
    for (const s of this.strutMeshes) {
      if (s && s.material) uniqueMats.add(s.material);
    }
    if (uniqueMats.size === 0) return false;
    // Record original emissive values once per session (so we can restore).
    if (!this._strutEmissiveOriginal) {
      this._strutEmissiveOriginal = new Map();
      for (const m of uniqueMats) {
        if (m.emissive && typeof m.emissive.clone === 'function') {
          this._strutEmissiveOriginal.set(m, m.emissive.clone());
        }
      }
    }
    // Apply cyan glow.
    for (const m of uniqueMats) {
      if (m.emissive && typeof m.emissive.setRGB === 'function') {
        m.emissive.setRGB(0.05, 0.55, 0.75);
        m.emissiveIntensity = 1.0;
        m.needsUpdate = true;
      }
    }
    // (Re-)arm restore timer.
    if (this._strutHighlightTimer != null && typeof clearTimeout === 'function') {
      clearTimeout(this._strutHighlightTimer);
    }
    if (typeof setTimeout === 'function') {
      this._strutHighlightTimer = setTimeout(() => {
        this._strutHighlightTimer = null;
        const orig = this._strutEmissiveOriginal;
        if (!orig) return;
        for (const [m, c] of orig) {
          if (m && m.emissive && typeof m.emissive.copy === 'function') {
            m.emissive.copy(c);
            m.needsUpdate = true;
          }
        }
      }, durationMs);
    }
    // Emit strut-labels event so StrutLabels overlay can visualize tip positions.
    // Delegation 4 (2026-05-31) — Quick-Win 2b / P1-3: enrich each entry with
    // the authoritative `hingeAngleDeg` read from the partner arm's aimAlpha
    // so labels can render the real strut sweep angle instead of the legacy
    // Euler-magnitude proxy.  Falls back to 0° when an arm slot is empty.
    const arms = this.armManager?.arms || [];
    const RAD2DEG = 180 / Math.PI;
    const sgPayload = (this.strutGroups || []).map((sg, i) => {
      const arm = arms[i];
      const alphaRad = (arm && typeof arm.getAimAlpha === 'function')
        ? arm.getAimAlpha()
        : 0;
      return {
        pivotGroup: sg.pivotGroup,
        strut:      sg.strut,
        tipNode:    sg.tipNode,
        azRad:      sg.azRad,
        hingeAngleDeg: Math.round(alphaRad * RAD2DEG),
      };
    });
    eventBus.emit(Events.STRUT_LABELS_SHOW, {
      strutGroups: sgPayload,
      durationMs,
    });
    return true;
  }
}

export default PlayerSatellite;
