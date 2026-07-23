/**
 * ArmUnit.js — Autonomous arm unit (V5 Crossbow ADR satellite)
 * Supports both Weaver (large, 6.6kg V5, reel on mothership)
 * and Spinner (small, 2.1kg V5, reel on mothership) types.
 * V5 State machine: DOCKED → LAUNCHING → TRANSIT → APPROACH →
 *   NETTING → GRAPPLED → REELING → DOCKING → RELOADING →
 *   TRAWLING → ABLATING → SCANNING → EXPENDED
 * Legacy states (UNDOCKING, HAULING, RETURNING) preserved for backward compat.
 * @module entities/ArmUnit
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { getSolarCellTexture } from '../scene/solarCellTexture.js';
import { makeLightHalo } from '../scene/glowSpriteTexture.js';
import { makePlumeFrustum } from '../scene/plumeGeometry.js';
import { applyDetailLod } from '../scene/detailLodCull.js';
import { tetherReel } from '../systems/TetherReel.js';
import { captureNetSystem, getNetClassForType, computeLeadAim, computeFragRisk, effectiveFragility, presentedWidthForApproach } from './CaptureNet.js';
import { audioSystem } from '../systems/AudioSystem.js';
import { recommendArmTool } from '../systems/ToolRecommender.js';
import { computeToolOdds } from '../systems/ToolOdds.js';
import { gameState } from '../core/GameState.js';
import { daughterDisplayName } from '../core/daughterNames.js';

/** 1 meter in scene units (1 scene unit = 100 km) */
const M = 0.00001;

/** World up axis (reused for the HOLDING_CATCH lateral-bias cross product). */
const _WORLD_UP = new THREE.Vector3(0, 1, 0);

// P3 (2026-07-20): hot-path temps — update()/state handlers allocated ~10-15
// Vector3+Matrix4+Quaternion per frame PER ARM. Module-level is safe: JS is
// single-threaded, ArmManager updates arms sequentially, and every temp is
// written and fully consumed within one method call (nothing crosses calls).
const _orientRadial = new THREE.Vector3();
const _orientEye    = new THREE.Vector3();
const _orientMat    = new THREE.Matrix4();
const _orientQuat   = new THREE.Quaternion();
const _tetherDir    = new THREE.Vector3();
const _driftTDelta  = new THREE.Vector3();
const _driftPDelta  = new THREE.Vector3();
const _driftRaw     = new THREE.Vector3();
const _relVel       = new THREE.Vector3();
const _goalDir      = new THREE.Vector3();
const _posCmd       = new THREE.Vector3();
const _dockOffTmp   = new THREE.Vector3();

// ──────────────────────────────────────────────────────────────────────────
const S = Constants.ARM_STATES;

// V5 Crossbow constants (destructured for readability)
const {
  CROSSBOW_DRAW_DISTANCE, CROSSBOW_SPRING_K_WEAVER, CROSSBOW_SPRING_K_SPINNER,
  CROSSBOW_RELEASE_TIME, CROSSBOW_UNDOCK_TIME, CROSSBOW_LAUNCH_SPEED_DEFAULT,
  CROSSBOW_LAUNCH_SPEED_MIN, CROSSBOW_LAUNCH_SPEED_MAX,
  CROSSBOW_RELOAD_POWER, CROSSBOW_WORM_GEAR_EFFICIENCY,
  REEL_IN_SPEED_EMPTY, REEL_IN_SPEED_LOADED, REEL_MOTOR_POWER,
  REEL_BRAKE_FORCE_MAX, REEL_TENSION_WARNING, REEL_TENSION_CRITICAL,
  ABLATION_LASER_POWER, ABLATION_RANGE_MAX, ABLATION_DURATION_MAX, ABLATION_DESPIN_RATE,
  PULSE_SCAN_DURATION, PULSE_SCAN_RANGE_MULT,
  V5_WEAVER_MASS, V5_SPINNER_MASS,
  SPRING_TIERS, TETHER_TIERS,
} = Constants;

// S3.6: Shared bridle geometries (created once, reused across all arms)
let _sharedBridleGeo = null;
function _ensureSharedBridleGeo() {
  if (_sharedBridleGeo) return _sharedBridleGeo;
  _sharedBridleGeo = {
    gimbalW: new THREE.TorusGeometry(0.015 * M, 0.003 * M, 6, 4),  // Weaver gimbal ring — 48 tris
    gimbalS: new THREE.TorusGeometry(0.010 * M, 0.002 * M, 6, 4),  // Spinner gimbal ring — 48 tris
    hpSphere: new THREE.SphereGeometry(0.005 * M, 4, 4),           // Hardpoint bracket — 16 tris each
  };
  return _sharedBridleGeo;
}

export class ArmUnit {
  /**
   * @param {string} id - e.g. 'weaver-1', 'spinner-2'
   * @param {'weaver'|'spinner'} type
   * @param {THREE.Vector3} dockOffset - LOCAL offset from core center when docked
   * @param {THREE.Scene} scene
   */
  constructor(id, type, dockOffset, scene) {
    this.id = id;
    this.index = null;                    // Set by ArmManager after construction
    this.type = type;
    this.state = S.DOCKED;
    this.scene = scene;

    /** @type {THREE.Vector3} Local dock position relative to core center */
    this.dockOffset = dockOffset.clone();

    // --- Type-specific configuration ---
    const isWeaver = type === 'weaver';
    this.config = {
      // Physical mass for ALL dynamics (manual-thrust accel, capture combined
      // mass, recoil residual, deorbit ΔV). Uses the V5 figures (6.6/2.1 kg) so
      // it matches crossbow launch, CoM, and recoil-cancel math — the legacy
      // Constants.WEAVER_MASS/SPINNER_MASS (11.0/3.7) are pre-V5 and would
      // mis-size recoil compensation by ~67%.
      mass: isWeaver ? V5_WEAVER_MASS : V5_SPINNER_MASS,
      type: type,
      tetherMax: isWeaver ? Constants.WEAVER_TETHER_LENGTH : Constants.SPINNER_TETHER_LENGTH,
      maxCaptureMass: isWeaver ? Constants.WEAVER_MAX_CAPTURE_MASS : Constants.SPINNER_MAX_CAPTURE_MASS,
      netSize: isWeaver ? Constants.WEAVER_NET_SIZE : Constants.SPINNER_NET_SIZE,
      bodyDims: isWeaver ? Constants.WEAVER_BODY : Constants.SPINNER_BODY,
      capturesPerFuel: isWeaver ? Constants.WEAVER_CAPTURES_PER_FUEL : Constants.SPINNER_CAPTURES_PER_FUEL,
      approachSpeed: Constants.ARM_APPROACH_SPEED,
      haulSpeed: Constants.ARM_HAUL_SPEED,
      thrust: isWeaver ? Constants.WEAVER_THRUST : Constants.SPINNER_THRUST,
    };

    // --- Runtime state ---
    this.fuel = 100;                        // 0–100 percentage
    this.tetherLength = 0;                  // current deployed length in meters
    this.target = null;                     // assigned debris object
    this.capturedDebris = null;             // debris hauled back
    this.stateTimer = 0;                    // seconds in current state
    this.captures = 0;                      // total captures by this arm
    this._startingDistance = 0;             // distance to target at transit start (for approach beep fraction)
    this.position = new THREE.Vector3();    // world position
    this.velocity = new THREE.Vector3();    // world velocity

    // Tether detach state (Phase 6 — Risk-Reward)
    this.isDetached = false;                // true after tether severed
    this._detachFuelWarning25 = false;      // already warned at 25%
    this._detachFuelWarning10 = false;      // already warned at 10%

    // Pre-allocated temporary vectors for hot-loop methods
    this._tmpVec = new THREE.Vector3();

    // Cached parent-ship world quaternion — refreshed each frame by _updateDocked().
    // Needed so deploy*() methods (called externally while DOCKED) can compute a
    // world-space deploy direction from the LOCAL dockOffset (§4.6 180° bug).
    /** @type {THREE.Quaternion|null} */
    this._lastParentQuat = null;

    /** @type {THREE.Vector3|null} Previous frame's parent position — for orbital frame correction */
    this._prevParentPos = null;

    /** @type {THREE.Vector3|null} Previous frame's target scene position — for orbital drift correction */
    this._prevTargetScenePos = null;

    // Manual pilot mode (ARM PILOT)
    this._manualMode = false;
    this._manualCapture = false; // Flag for manual capture scoring (Delegate 3C)
    this._fuelAtDeploy = 100;    // Track fuel at deployment for efficiency scoring
    this._autoFailChance = 0;    // Set by external code to trigger tutorial auto-failure

    this._nearbyDebris = [];               // injected by ArmManager for proximity checks

    // Web shot state (Sprint D1)
    this._webShotCooldown = 0;             // seconds remaining before next shot
    this._webShotTarget = null;            // target debris during WEB_SHOT state
    this._webShotPrevState = S.DOCKED;     // state to return to after shot
    this._webShotOrigin = new THREE.Vector3(); // position when shot was fired

    // Trawling mode state (Phase 6)
    this._trawlingMode = false;
    this._trawlDirection = null;
    this._trawlTimer = 0;

    // ── V5 Crossbow state ──
    this.springTier = 0;                    // Index into SPRING_TIERS
    this.tetherTier = 0;                    // Index into TETHER_TIERS
    this.springCharged = true;              // Starts charged (ready to fire)
    this.reloadProgress = 0;               // 0..1 reload completion
    this.reloadDuration = 0;               // Calculated reload time for current speed
    this.launchSpeed = CROSSBOW_LAUNCH_SPEED_DEFAULT; // Current selected launch speed
    this.launchDirection = null;            // Direction set before launch

    // V5 Tether state
    this.tetherTension = 0;                // Current tension in Newtons
    this.tetherMaxLength = TETHER_TIERS[0].maxLength; // From current tier
    this.tetherBreakStrength = TETHER_TIERS[0].breakStrength; // From current tier
    this.reeling = false;                  // True when actively reeling in
    this._tetherSevered = false;           // True after a tether SNAP (hides line, drifts)
    this._severedCatch = null;             // debris still pinned to this arm after a tether snap
    this._severedDriftS = 0;               // s drifting since the snap (bounds the pin)
    this._netRatedMass = 0;                // kg — net's rated capture mass (set in initNetInventory)
    this._netDiameter = 0;                 // m — net mouth diameter (set in initNetInventory)

    // ── Daughter multi-tool (CP-1 / P2 — DAUGHTER_MULTITOOL_SPEC) ──
    // Static-by-class toolset, read once on construction. selectedTool is the
    // verb F dispatches; it is (re)defaulted to the recommended tool whenever
    // the daughter enters STATION_KEEP. The live odds strip reads _toolOdds.
    this.toolset = (Constants.DAUGHTER_TOOLSETS && Constants.DAUGHTER_TOOLSETS[type])
      ? Constants.DAUGHTER_TOOLSETS[type].slice()
      : ['NET'];
    this.selectedTool = 'NET';
    this._captureToolKind = 'NET';         // which verb actually secured the live catch
    // ── Live tool odds (capture-feedback overhaul Phase 1b) ──
    // Refreshed at TOOL_ODDS.REFRESH_HZ during STATION_KEEP so de-spinning /
    // closing in reads as a live count-up on the reticle odds strip.
    this._toolOdds = null;                 // { NET: {p, blocker, hint}, ... }
    this._toolOddsFragRisk = 0;            // pre-fire FRAG % for the ⚠ chip
    this._toolOddsTimer = 0;               // refresh accumulator (s)
    // ── Reel boost (capture-feedback overhaul Phase 3a) ──
    this._boostReelHeld = false;           // Shift held (set by InputManager via ArmManager)
    this._boostReel = false;               // boost ACTIVE this frame (REELING + payload)
    // ── Eddy-current detumble (Phase 3c — MAGNET secondary) ──
    this._eddyActive = false;              // damping running this frame
    this._eddyTarget = null;               // debris being damped (for flag cleanup)
    // Magnetic-grapple sub-state machine (P2): null | 'ENERGIZING' | 'CLOSING' | 'GRIP'
    this._magPhase = null;
    this._magTimer = 0;
    // Tool-closing CA exemption: debris id held under AUTOPILOT_TARGET_LOCK while
    // the daughter deliberately closes to contact (magnet / gripper / pad). Released
    // centrally on ANY exit from the closing state (_transitionTo) so it can't leak.
    this._toolLockedDebrisId = null;
    // Gripper-grapple sub-FSM (P3): null | 'EXTEND' | 'SEEK' | 'CLOSE'
    this._gripPhase = null;
    this._gripTimer = 0;
    // Pad-contact sub-FSM (P4): null | 'APPROACH' | 'CONTACT'
    this._padPhase = null;
    this._padTimer = 0;
    this._padResolvedMode = null;
    // §13 Q3 — per-arm UV-cure magazine (finite; runtime-only at Y0, persistence deferred).
    this._padUvCureDosesRemaining = (Constants.PAD_CONTACT && Constants.PAD_CONTACT.UV_CURE_DOSES_Y0) || 10;

    // V5 Ablation state
    this.ablationTarget = null;            // Target being ablated
    this.ablationTimer = 0;                // Time spent ablating

    // ── Epic 8.3: FEEP Dual-Metal System ──
    this._currentMetal = 'indium';     // active FEEP propellant
    this._alternateMetal = null;       // second slot (unlocked via Forge)
    this._metalIsp = Constants.ION_THRUSTER.ISP_DEFAULT; // current operating ISP

    // ── Epic 8: STATION_KEEP state ──
    // _orbitTheta/_orbitPhi are now interpreted in a frozen *entry frame*
    // captured at SK entry (see _initSkFrame).  θ is yaw around the camera-up
    // axis (Earth-radial at debris) and φ is delta-pitch around the camera-
    // right axis.  Both are 0 at entry and clamped within THETA_LIMIT_DEG /
    // (MAX_LATITUDE − TETHER_SAFETY_MARGIN).
    this._orbitTheta = 0;                   // yaw delta in entry frame (rad)
    this._orbitPhi = 0;                     // pitch delta in entry frame (rad)
    /** @private Frozen entry frame axes (set on SK entry, cleared on exit). */
    this._skPolarAxis = null;               // THREE.Vector3 — Earth-radial at debris
    this._skEquator0 = null;                // THREE.Vector3 — initial debris→arm dir
    this._skRightVec = null;                // THREE.Vector3 — equator0 × polar (screen-right)
    this._skPitch0 = 0;                     // rad — entry pitch (so θ=φ=0 reproduces arrival pose)
    /** @private Pattern-C auto-return state (set during STATION_KEEP) */
    this._skIdleS = 0;                      // s — accumulated time since last arrow input
    this._standoffR = 5;                    // current standoff radius in metres
    this._standoffTargetR = 5;              // m — radius the settle-in eases toward
    this._standoffSettling = false;         // true while easing entry distance → nominal standoff
    this._thetaRate = 0;                    // current theta angular velocity
    this._phiRate = 0;                      // current phi angular velocity
    this._radiusRate = 0;                   // current radial velocity
    this._rMin = Constants.STATION_KEEP.MIN_STANDOFF;
    this._rMax = Constants.STATION_KEEP.MAX_STANDOFF;
    this._phiMax = Constants.STATION_KEEP.MAX_LATITUDE * Math.PI / 180;
    this._stationKeepTarget = null;         // reference to target debris

    // ── ST-9.3 C-3: Config G Aim + Hinge State ──
    /** Meridian sweep angle α ∈ [0, π]. 0=stowed(−Y), π/2=equatorial, π=zenith(+Y) */
    this._aimAlpha = 0;

    /**
     * Hinge state: 'ROTATE' (motor drives, brake off) or 'LOCKED' (brake on, motor off).
     * Gated by FEATURE_FLAGS.LOCKABLE_HINGE — when false, hinge behaves as always-ROTATE.
     * @type {string}
     */
    this._hingeState = Constants.HINGE_STATES.ROTATE;

    // ══════════════════════════════════════════════════════════════════
    // ST-9.10 C-4: DEPLOY STATE MACHINE
    // ══════════════════════════════════════════════════════════════════
    //
    // Two state machines coexist on ArmUnit and must NOT be conflated (§V-3):
    //   1. deployState (THIS) — physical/mechanical:
    //        LOCKED → STOWED → DEPLOYING → DEPLOYED → STOWING (→ STOWED)
    //      Transitions take real time and animate strut alpha.
    //   2. armState (this.state / ARM_STATES) — operational mission role:
    //        DOCKED → LAUNCHING → TRANSIT → ...
    //      Set by gameplay code.
    //
    // A fully-deployed arm (deployState=DEPLOYED) can be in any operational
    // state. An arm cannot fire/operate (DOCKED→LAUNCHING) unless
    // deployState === DEPLOYED.
    //
    // When FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE is false:
    //   - deployState is always DEPLOYED (C-3 placeholder behavior)
    //   - strutDeploy/strutStow/strutUnlock are no-ops
    //   - All existing code paths continue to work unchanged
    // ══════════════════════════════════════════════════════════════════

    /**
     * Physical deploy state of the strut hinge mechanism.
     * Gated by FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE.
     * When flag OFF: always DEPLOYED. When flag ON: starts LOCKED.
     * @type {string} One of Constants.DEPLOY_STATES values
     */
    this._deployState = Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE
      ? Constants.DEPLOY_STATES.LOCKED
      : Constants.DEPLOY_STATES.DEPLOYED;

    /**
     * Target alpha for deploy/stow animation.
     * During DEPLOYING: sweeps toward this value at STRUT_SLEW_RATE.
     * During STOWING: sweeps toward 0 at STRUT_SLEW_RATE.
     * @type {number}
     */
    this._deployTargetAlpha = Math.PI / 2; // default deploy target = equatorial

    /**
     * Promise resolve callback for strutDeploy(). Called when DEPLOYED is reached.
     * @type {Function|null}
     */
    this._deployResolve = null;

    /**
     * Promise resolve callback for strutStow(). Called when STOWED is reached.
     * @type {Function|null}
     */
    this._stowResolve = null;

    /**
     * Timer for auto-unlock after fire recoil settles.
     * When > 0, counts down; at 0 the hinge auto-unlocks.
     * @type {number}
     */
    this._hingeSettleTimer = 0;

    // Config G geometry — set by ArmManager._initArms() after construction
    /** @type {THREE.Vector3|null} */ this._hingePosition = null;
    /** @type {THREE.Vector3|null} */ this._dockOutward = null;
    /** @type {THREE.Vector3|null} */ this._swingAxis = null;
    /** @type {number} */ this._azimuthDeg = 0;
    /** @type {boolean} */ this._isEndFace = false;

    // ── ST-9.4 C-6: Capture Net Inventory ──
    // Per CAPTURE_NET.md §6.1: weaver carries Medium Net, spinner carries Small Net.
    // Gated by FEATURE_FLAGS.CAPTURE_NET — when false these stay at 0.
    /** @type {number} */ this._netInventory = 0;
    /** @type {number} */ this._netInventoryMax = 0;
    /** @type {object|null} */ this._firedNet = null;       // stored net reference for NETTING FSM
    /** @type {object|null} */ this._nettingOffset = null;  // standoff offset (arm - target) during NETTING

    // ST-8.2.2: Listen for orbital positioning commands
    eventBus.on(Events.ARM_ORBIT_ADJUST, (data) => {
      if (data.armId !== this.id) return;
      if (this.state !== Constants.ARM_STATES.STATION_KEEP) return;

      const SK = Constants.STATION_KEEP;
      const rate = data.fine ? SK.ORBIT_RATE_FINE : SK.ORBIT_RATE;
      const radRate = data.fine ? SK.RADIUS_RATE_FINE : SK.RADIUS_RATE;

      // Rate-based input (keys-held: ±/=, arrows). theta/phi/radius are
      // signed ±1 unit-rates; multiplied by SK.ORBIT_RATE / SK.RADIUS_RATE
      // (and dt at apply-time) inside _updateStationKeep. Rates reset
      // each frame at line ~2820 so missing-key frames decay to 0.
      this._thetaRate = (data.theta || 0) * rate;
      this._phiRate = (data.phi || 0) * rate;
      this._radiusRate = (data.radius || 0) * radRate;

      // Step-based input (one-shot: mouse-wheel). radiusStep is an
      // instantaneous delta in metres applied directly to _standoffR
      // (no dt, no rate). 0.5 m/tick × ~16 ticks spans the 4–12 m band.
      // Clamped to [_rMin, _rMax] by the existing clamp in
      // _updateStationKeep at line ~2763 on the next frame.
      if (typeof data.radiusStep === 'number' && data.radiusStep !== 0) {
        this._standoffR += data.radiusStep;
        // Immediate clamp so HUD readout reflects the bounded value
        // even if the next physics tick is delayed.
        this._standoffR = Math.max(this._rMin, Math.min(this._rMax, this._standoffR));
      }
    });

    // --- Visual ---
    this.group = new THREE.Group();
    this.group.name = this.id;
    this.mesh = null;
    this.tetherLine = null;
    this.tetherMaterial = null;
    this._thrusterPlumes = [];
    this._statusLightMat = null;
    this._netMesh = null;
    // Detail-LOD cull set (Phase 6): inert daughter hardware hidden when far.
    this._detailMeshes = [];
    this._detailHidden = false;

    // Selection highlight (hotkey revamp 2026-06-14, D4): when a DOCKED daughter
    // is selected with 1-4 it glows/flashes so the player can see which plate
    // they picked before launching with D. Driven by ArmManager via
    // setSelectedHighlight(); the pulse runs in _updateSelectGlow() each frame.
    /** @type {boolean} */
    this._selected = false;
    /** @type {Array<{mat:THREE.Material, baseEmissive:number, baseIntensity:number}>} */
    this._selectGlowMats = [];

    // S3.6: Bridle visual references (populated in _createMesh)
    this._gimbalRing = null;
    this._bridleLegA = null;
    this._bridleLegB = null;
    this._bridleLegMat = null;
    this._bridleHpA = null;
    this._bridleHpB = null;

    this._createMesh();
    this._createTether();

    // §2-followup (round 4): the daughter is a SEPARATE top-level scene object
    // from the mother, yet docks AT the mother's strut tip where their geometry
    // overlaps. Their meshes share the RENDER_ORDER scale, so equal bands (e.g.
    // both DETAIL) tie and resolve by ambiguous depth → z-fighting at the seam.
    // Lift the whole daughter BODY subtree by DAUGHTER_BIAS so it resolves
    // cleanly in front of the strut-tip collar while preserving the body's own
    // internal layering (every child keeps its relative renderOrder). The main
    // tether (a child of `this.group`, not `this.mesh`) bridges to the mother
    // and is intentionally left unbiased so it keeps lying on both craft; the
    // short bridle legs live on `this.mesh` and ride with the biased body.
    const dbias = Constants.RENDER_ORDER.DAUGHTER_BIAS;
    this.mesh.traverse((obj) => {
      if (obj.isMesh || obj.isLine || obj.isPoints || obj.isSprite) {
        obj.renderOrder += dbias;
      }
    });

    scene.add(this.group);
  }

  /**
   * Player-facing name for this daughter. Internal type stays 'weaver'/'spinner'
   * but the crew sees the size-based vocab: 'Large' / 'Small'. Delegates to the
   * shared {@link daughterDisplayName} so the HUD, reticle, and comms can never
   * disagree on the same daughter's name.
   * @returns {string}
   */
  get displayName() {
    return daughterDisplayName(this.id);
  }

  // ==========================================================================
  // 3D MODEL
  // ==========================================================================

  /** @private Build the arm unit Three.js model */
  _createMesh() {
    const [bx, by, bz] = this.config.bodyDims;
    const isWeaver = this.type === 'weaver';

    // --- S3.5: Hex prism body (Group replaces Mesh for child composition) ---
    this.mesh = new THREE.Group();
    this.mesh.name = `${this.id}-body`;
    this.group.add(this.mesh);

    const apothem = (bx / 2) * M;
    const hexR = apothem / Math.cos(Math.PI / 6);
    const halfLen = (bz * M) / 2;

    // §2-followup (round 12): the body side is built as 6 INDIVIDUAL flat facet
    // quads (instead of one textured hex shell) so we can control cell coverage
    // per facet: the solar-cell map goes on 5 facets, and the facet that carries
    // the round laser receiver (+Y) is left as bare metal. The end caps are also
    // plain metal (no cells). Separate, non-coincident faces → no z-fight.
    //
    // Facet k (k=0..5) outward azimuth = 30° + k·60° (matches the prior hex
    // thetaStart = π/6). +Y is 90° → facet k=1 carries the laser RX; leave bare.
    const LASER_FACET = 1;

    const baseColor = isWeaver ? 0x4488aa : 0x88aa44;
    const bareMetalMat = new THREE.MeshStandardMaterial({
      color: baseColor, metalness: 0.80, roughness: 0.30,
    });

    // Solar-cell facet material (GaAs map when available, else dark PV tint).
    const cellTex = getSolarCellTexture();
    let skinTex = null;
    if (cellTex) {
      skinTex = cellTex.clone();
      skinTex.needsUpdate = true;
      skinTex.repeat.set(isWeaver ? 1.0 : 0.7, 1.0); // ~one cell-tile per facet
    }
    const cellMat = skinTex
      ? new THREE.MeshStandardMaterial({
          color: 0xffffff, map: skinTex, emissiveMap: skinTex,
          emissive: 0x0b1030, emissiveIntensity: 0.18, metalness: 0.5, roughness: 0.5,
        })
      : new THREE.MeshStandardMaterial({
          color: baseColor, metalness: 0.5, roughness: 0.5,
          emissive: 0x060614, emissiveIntensity: 0.10,
        });

    // Width of one hex facet = side length = circumradius (hexagon property).
    const facetW = hexR;
    const facetGeo = new THREE.PlaneGeometry(facetW, bz * M);
    this._bodyShell = null; // (legacy ref no longer a single mesh)
    for (let k = 0; k < 6; k++) {
      const az = Math.PI / 6 + k * (Math.PI / 3);  // facet outward azimuth (XY)
      const mat = (k === LASER_FACET) ? bareMetalMat : cellMat;
      const facet = new THREE.Mesh(facetGeo, mat);
      // Plane default normal +Z; orient it to face outward at azimuth `az`,
      // with its height running along the body Z axis.
      const outward = new THREE.Vector3(Math.cos(az), Math.sin(az), 0);
      const bodyAxis = new THREE.Vector3(0, 0, 1);
      const tangent = new THREE.Vector3().crossVectors(bodyAxis, outward).normalize();
      facet.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(tangent, bodyAxis, outward)
      );
      facet.position.copy(outward).multiplyScalar(apothem);
      facet.name = `${this.id}-facet-${k}`;
      facet.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      this.mesh.add(facet);
      if (k === 0) this._bodyShell = facet; // keep a representative ref
    }

    // D4 selection-glow: register the body facet materials (solar-cell skin +
    // the bare-metal laser facet) so _updateSelectGlow() can pulse their
    // emissive when this daughter is the selected plate. Both are per-arm
    // MeshStandardMaterials, so modulating their emissive is isolated to this
    // unit. Record each base emissive/intensity once for clean restore.
    for (const mat of [cellMat, bareMetalMat]) {
      if (mat && mat.emissive && !this._selectGlowMats.some(e => e.mat === mat)) {
        this._selectGlowMats.push({
          mat,
          baseEmissive: mat.emissive.getHex(),
          baseIntensity: mat.emissiveIntensity ?? 1.0,
        });
      }
    }

    // Plain metal end caps (fore +Z, aft −Z) — no solar cells on the ends.
    const capGeo = new THREE.CircleGeometry(hexR, 6);
    for (const s of [-1, 1]) {
      const cap = new THREE.Mesh(capGeo, bareMetalMat);
      cap.position.set(0, 0, s * halfLen);
      cap.rotation.y = s > 0 ? 0 : Math.PI;  // outward-facing
      // CircleGeometry(hexR, 6) default vertices sit at azimuth 0°+k·60°, which
      // are exactly the hull CORNERS between the side facets (facets are centered
      // at 30°+k·60°, L482). So the default cap already aligns — no z-rotation.
      // (Adding π/6 here rotated cap corners onto facet-normal azimuths, poking
      // ~13.4% past the facet planes. The aft cap's rotation.y=π mirror maps the
      // corrected vertex set onto itself, so this fixes both caps.)
      cap.name = `${this.id}-cap-${s > 0 ? 'fore' : 'aft'}`;
      cap.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE;
      this.mesh.add(cap);
    }

    // --- S3.5: Panel line edges (zero triangle cost) ---
    // §2-followup (round 8): the edges are built from a slightly LARGER hex
    // (1.5% proud) so the lines sit physically off the facets with a real,
    // zoom-independent gap (no coplanar z-fight with the facet quads).
    const edgeHexGeo = new THREE.CylinderGeometry(hexR * 1.015, hexR * 1.015, bz * M, 6, 1, false, Math.PI / 6);
    const edgeGeo = new THREE.EdgesGeometry(edgeHexGeo, 30);
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x667788, transparent: true, opacity: 0.5,
    });
    const edges = new THREE.LineSegments(edgeGeo, edgeMat);
    edges.rotation.x = Math.PI / 2;
    edges.name = `${this.id}-panel-lines`;
    edges.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT; // FIX_PLAN §2-followup
    this.mesh.add(edges);


    // --- S3.5: Aft FEEP nozzle (stub, centered on −Z face) ---
    const aftNozR = (isWeaver ? 0.015 : 0.010) * M;
    const aftNozL = (isWeaver ? 0.025 : 0.015) * M;
    const aftNozGeo = new THREE.CylinderGeometry(aftNozR, aftNozR * 1.1, aftNozL, 10, 1, true);  // was 6-seg
    const feepMat = new THREE.MeshStandardMaterial({
      color: 0x444455, metalness: 0.85, roughness: 0.25,
    });
    const aftNozzle = new THREE.Mesh(aftNozGeo, feepMat);
    aftNozzle.position.set(0, 0, -bz * 0.52 * M);
    aftNozzle.rotation.x = Math.PI / 2;
    aftNozzle.name = `${this.id}-feep-aft`;
    this.mesh.add(aftNozzle);

    // Small mounting boss/recess ring at the nozzle base so it reads as attached
    // rather than a stub poking out of the cap. On a DISTINCT z-plane
    // (z=-bz*0.515) — between the aft cap (−0.5) and the pusher disc (−0.505,
    // L707) and the nozzle base (−0.52) — plus DETAIL order so it does not
    // re-introduce the L696/round-8 aft-nozzle-base z-fight.
    const bossGeo = new THREE.CylinderGeometry(aftNozR * 2.0, aftNozR * 2.2, aftNozL * 0.4, 6, 1, false);
    const bossMat = new THREE.MeshStandardMaterial({
      color: 0x3a3a44, metalness: 0.7, roughness: 0.4,
    });
    const boss = new THREE.Mesh(bossGeo, bossMat);
    boss.position.set(0, 0, -bz * 0.515 * M);
    boss.rotation.x = Math.PI / 2;
    boss.name = `${this.id}-feep-aft-boss`;
    boss.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(boss);

    // Aft thruster plume (additive, hidden by default) — HYBRID (Phase 3):
    // a physically-consistent silver-blue FEEP core (0x99bbdd, same propellant as
    // the Mother) inside a fainter TYPE-TINTED outer halo (Weaver blue / Spinner
    // green) so per-type identification survives at distance. Both are diverging
    // frustums (narrow at the exit, widening + alpha-fading aft) welded at the
    // nozzle exit; both are pushed to _thrusterPlumes so the single _updatePlumes
    // driver shows/flickers them together.
    const plumeLen = bz * 0.55 * M;
    const coreGeo = makePlumeFrustum(aftNozR * 1.0, aftNozR * 2.2, plumeLen, 10, 3);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0x99bbdd, transparent: true, opacity: 0.0, vertexColors: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const plume = new THREE.Mesh(coreGeo, coreMat);
    // §2-followup (round 4): additive plume must draw AFTER solid geometry, like
    // the mother's plumes — without this the untagged plume sorted by raw depth
    // against the (separate) mother object and punched through inconsistently.
    plume.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
    plume.position.set(0, 0, -bz * 0.5 * M);   // near end welded to aft nozzle exit
    plume.rotation.x = -Math.PI / 2;           // beam local +Y → world -Z (aft)
    plume.visible = false;
    plume.name = `${this.id}-feep-plume-core`;
    this.mesh.add(plume);
    this._thrusterPlumes.push(plume);

    const haloGeo = makePlumeFrustum(aftNozR * 1.0, aftNozR * 3.0, plumeLen * 1.35, 10, 3);
    const haloMat = new THREE.MeshBasicMaterial({
      color: isWeaver ? 0x4488ff : 0x44ff88, transparent: true, opacity: 0.0, vertexColors: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const plumeHalo = new THREE.Mesh(haloGeo, haloMat);
    plumeHalo.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE;
    plumeHalo.position.set(0, 0, -bz * 0.5 * M);
    plumeHalo.rotation.x = -Math.PI / 2;
    plumeHalo.visible = false;
    plumeHalo.name = `${this.id}-feep-plume-halo`;
    this.mesh.add(plumeHalo);
    this._thrusterPlumes.push(plumeHalo);
    this._plumeHalo = plumeHalo;   // tagged so _updatePlumes can dim it to ~0.4×

    // --- S3.5: Fore FEEP nozzle (braking/attitude, offset on +Z face) ---
    const foreNozR = (isWeaver ? 0.010 : 0.007) * M;
    const foreNozL = (isWeaver ? 0.015 : 0.010) * M;
    const foreNozGeo = new THREE.CylinderGeometry(foreNozR, foreNozR * 1.1, foreNozL, 10, 1, true);  // was 6-seg
    const foreNozzle = new THREE.Mesh(foreNozGeo, feepMat);
    // Protrude past the fore face (halfLen = bz·0.5·M) with the base embedded so
    // it reads as a real nozzle, not a stub buried inside the hull. The brake
    // plume axis test uses the daughter's world +Z direction (L4394), not this
    // mesh position, so moving it forward is safe.
    foreNozzle.position.set(bx * 0.25 * M, 0, bz * 0.5 * M + foreNozL * 0.35);
    foreNozzle.rotation.x = -Math.PI / 2;
    foreNozzle.name = `${this.id}-feep-fore`;
    this.mesh.add(foreNozzle);

    // --- Net canister (forward, cylindrical) ---
    const canR = isWeaver ? 0.06 : 0.03;
    const canH = isWeaver ? 0.08 : 0.05;
    // Closed-ended so the outboard face reads as a capped canister lid rather
    // than a see-through tube protruding from the fore face.
    const canGeo = new THREE.CylinderGeometry(canR * M, canR * M, canH * M, 8, 1, false);
    const canMat = new THREE.MeshStandardMaterial({
      color: 0x666677, metalness: 0.6, roughness: 0.4,
    });
    const canister = new THREE.Mesh(canGeo, canMat);
    canister.position.set(0, 0, bz * 0.55 * M);
    canister.rotation.x = Math.PI / 2;
    this.mesh.add(canister);

    // --- Laser power receiver (top face) — a small optical rectenna, NOT a
    // solar array. A round photodiode recessed inside a short metallic housing.
    const rxR = (isWeaver ? 0.045 : 0.030) * M;   // receiver disc radius (small)
    // §2-followup (round 18): earlier versions used a FLAT ring + disc that
    // either z-fought the facet (coplanar) or, when lifted clear, looked like
    // they FLOATED above the hull. Fix: the bezel is now a real 3-D ring HOUSING
    // (a short open cylinder wall) that RISES from the facet — its base sits on
    // the body, so nothing floats — and the diode is recessed at the bottom of
    // that well. Because the wall has real height (perpendicular to the facet),
    // no surface is coplanar with the body, so there is no z-fight at any zoom.
    const facetY = (bx / 2) * M;                  // +Y facet plane (apothem)
    const houseOR = rxR * 1.35;                   // housing outer radius
    const houseH  = rxR * 0.6;                    // housing wall height (proud of facet)

    // Bezel housing: open cylinder wall, base on the facet, rising +Y.
    const rxBezelGeo = new THREE.CylinderGeometry(houseOR, houseOR, houseH, 24, 1, true);
    const rxBezelMat = new THREE.MeshStandardMaterial({
      color: 0x777788, metalness: 0.9, roughness: 0.25, side: THREE.DoubleSide,
    });
    const rxBezel = new THREE.Mesh(rxBezelGeo, rxBezelMat);
    // Sink the base slightly into the facet so the wall reads as embedded in the
    // hull (grounded, not floating) and its bottom edge isn't exactly coplanar.
    rxBezel.position.set(0, facetY + houseH / 2 - houseH * 0.2, 0);
    rxBezel.name = `${this.id}-laser-rx-bezel`;
    rxBezel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(rxBezel);

    // Dark optical receiver face (the diode) recessed at the base of the well.
    const rxGeo = new THREE.CircleGeometry(rxR, 24);
    const rxMat = new THREE.MeshStandardMaterial({
      color: 0x1a0e02, metalness: 0.35, roughness: 0.2,
      emissive: 0x140a00, emissiveIntensity: 0.18,  // warm 808nm-receiver tint
    });
    const pvPanel = new THREE.Mesh(rxGeo, rxMat);
    pvPanel.position.set(0, facetY + houseH * 0.4, 0);  // recessed inside the housing
    pvPanel.rotation.x = -Math.PI / 2;
    pvPanel.name = `${this.id}-laser-rx`;
    pvPanel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(pvPanel);

    // --- S3.5: MRR patch antenna — a thin 3-D puck (has thickness, so it is
    // grounded to the facet and never coplanar with it). ---
    const mrrR = (isWeaver ? 0.015 : 0.010) * M;
    const mrrH = mrrR * 0.4;                       // puck thickness
    const mrrGeo = new THREE.CylinderGeometry(mrrR, mrrR, mrrH, 6);
    const mrrMat = new THREE.MeshStandardMaterial({
      color: 0xccccdd, metalness: 0.95, roughness: 0.15,
    });
    const mrr = new THREE.Mesh(mrrGeo, mrrMat);
    // §2-followup (round 18): base sunk slightly into the facet so the puck sits
    // ON the hull with real thickness — grounded, no float, no coplanar tie.
    mrr.position.set(bx * 0.25 * M, facetY + mrrH / 2 - mrrH * 0.25, -bz * 0.20 * M);
    mrr.name = `${this.id}-mrr-patch`;
    mrr.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(mrr);

    // --- Status light (blinks to show state) ---
    const lightGeo = new THREE.SphereGeometry(0.010 * M, 8, 6);  // was 0.015 (Batch 1 shrink)
    this._statusLightMat = new THREE.MeshBasicMaterial({ color: 0x00ff44 });
    const statusLight = new THREE.Mesh(lightGeo, this._statusLightMat);
    statusLight.position.set(0, by * 0.55 * M, -bz * 0.3 * M);
    statusLight.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // FIX_PLAN §2-followup
    this.mesh.add(statusLight);
    // Additive glow halo so the state light reads as an alive lamp, not a painted
    // dot. Built via the shared makeLightHalo factory (same recipe as the Mother's
    // nav/dock halos). Colour + opacity track the core in _updateStatusLight (the
    // per-state hex already encodes the blink bright/dim phase, so it breathes).
    // Size/opacity from Constants.LIGHT_FX (Batch 1 light-shrink SSOT).
    this._statusLightHalo = makeLightHalo(
      0x00ff44, Constants.LIGHT_FX.STATUS_HALO * M, 1.8, Constants.LIGHT_FX.STATUS_HALO_OPACITY);
    statusLight.add(this._statusLightHalo);

    // --- S3.4: EPM docking collar (replaces flat dock plate) ---
    const epmR = (isWeaver ? 0.025 : 0.020) * M;
    const epmH = (isWeaver ? 0.015 : 0.012) * M;
    const epmHousing = new THREE.Mesh(
      new THREE.CylinderGeometry(epmR, epmR, epmH, 8),
      new THREE.MeshStandardMaterial({ color: 0x606068, metalness: 0.85, roughness: 0.40 })
    );
    epmHousing.position.y = -by * 0.52 * M;
    epmHousing.name = `${this.id}-epm-housing`;
    this.mesh.add(epmHousing);

    // EPM pole face ring (AlNiCo — cloned mat per arm for independent emissive)
    const poleOR = (isWeaver ? 0.025 : 0.020) * M;
    const poleIR = (isWeaver ? 0.0125 : 0.010) * M;
    this._epmPoleMat = new THREE.MeshStandardMaterial({
      color: 0xbbaa55, metalness: 0.75, roughness: 0.25,
      emissive: 0x000000, emissiveIntensity: 0.0, side: THREE.DoubleSide,
    });
    const epmPole = new THREE.Mesh(
      new THREE.RingGeometry(poleIR, poleOR, 8, 1),
      this._epmPoleMat
    );
    epmPole.position.y = -by * 0.52 * M - epmH * 0.51;
    epmPole.rotation.x = Math.PI / 2;
    epmPole.name = `${this.id}-epm-pole`;
    this.mesh.add(epmPole);

    // Aft pusher plate (17-4PH stainless — spring contact surface)
    const pushR = (isWeaver ? 0.025 : 0.018) * M;
    const pushH = M * 0.003;
    const pusher = new THREE.Mesh(
      new THREE.CylinderGeometry(pushR, pushR, pushH, 6),
      new THREE.MeshStandardMaterial({ color: 0x777788, metalness: 0.78, roughness: 0.32 })
    );
    // FIX_PLAN §2-followup: nudged forward to z=-bz*0.505 so pusher disc no
    // longer shares the aft-nozzle base plane at z=-bz*0.52 (was z-fight).
    pusher.position.set(0, 0, -bz * 0.505 * M);                          // FIX_PLAN §2-followup
    pusher.rotation.x = Math.PI / 2;
    pusher.name = `${this.id}-pusher-plate`;
    pusher.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;       // FIX_PLAN §2-followup
    this.mesh.add(pusher);

    // --- S3.6: Wishbone bridle (gimbal ring + Y-fork legs + hardpoints) ---
    // 2× wishbone hardpoints at ±X (supersedes §13.4.5 3× tripod)
    const bGeo = _ensureSharedBridleGeo();
    const gimbalMat = new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.75, roughness: 0.30 });
    const gimbalRing = new THREE.Mesh(isWeaver ? bGeo.gimbalW : bGeo.gimbalS, gimbalMat);
    gimbalRing.position.set(0, by * 0.70 * M, 0);
    gimbalRing.rotation.x = Math.PI / 2;
    gimbalRing.name = `${this.id}-gimbal-ring`;
    this.mesh.add(gimbalRing);
    this._gimbalRing = gimbalRing;

    const hpMat = new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.72, roughness: 0.28 });
    const hpA = new THREE.Mesh(bGeo.hpSphere, hpMat);
    hpA.position.set(bx * 0.45 * M, by * 0.30 * M, 0);
    hpA.name = `${this.id}-bridle-hp-A`;
    this.mesh.add(hpA);
    const hpB = new THREE.Mesh(bGeo.hpSphere, hpMat);
    hpB.position.set(-bx * 0.45 * M, by * 0.30 * M, 0);
    hpB.name = `${this.id}-bridle-hp-B`;
    this.mesh.add(hpB);
    this._bridleHpA = hpA;
    this._bridleHpB = hpB;

    const bridleLegMat = new THREE.LineBasicMaterial({ color: 0xccccdd, transparent: true, opacity: 0.85 });
    const legAGeo = new THREE.BufferGeometry();
    legAGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, by * 0.70 * M, 0,  bx * 0.45 * M, by * 0.30 * M, 0
    ]), 3));
    const legA = new THREE.Line(legAGeo, bridleLegMat);
    legA.name = `${this.id}-bridle-leg-A`;
    legA.visible = false;
    legA.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_CONNECTOR; // §2-followup (round 4)
    this.mesh.add(legA);

    const legBGeo = new THREE.BufferGeometry();
    legBGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, by * 0.70 * M, 0,  -bx * 0.45 * M, by * 0.30 * M, 0
    ]), 3));
    const legB = new THREE.Line(legBGeo, bridleLegMat);
    legB.name = `${this.id}-bridle-leg-B`;
    legB.visible = false;
    legB.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_CONNECTOR; // §2-followup (round 4)
    this.mesh.add(legB);

    this._bridleLegA = legA;
    this._bridleLegB = legB;
    this._bridleLegMat = bridleLegMat;

    // Detail-LOD cull set (Phase 6): collect inert daughter hardware by name
    // suffix. Excludes body, status light + halo, plumes, tether, bridle legs
    // (communicative / connector). Only sub-pixel-at-distance detail is listed.
    this._collectDetailMeshes();

    // Start hidden (docked = part of core visually)
    this.mesh.visible = false;
  }

  /**
   * @private — Gather inert daughter hardware into `_detailMeshes` for the
   * distance LOD cull. Selected by the `${id}-` name suffix so it's auditable.
   */
  _collectDetailMeshes() {
    const CULL_SUFFIXES = [
      '-panel-lines', '-mrr-patch', '-epm-housing', '-epm-pole', '-gimbal-ring',
      '-bridle-hp-A', '-bridle-hp-B', '-feep-aft-boss',
    ];
    this._detailMeshes.length = 0;
    if (!this.mesh) return;
    this.mesh.traverse((o) => {
      if (!(o.isMesh || o.isLine) || !o.name) return;   // isLine covers panel-lines
      if (CULL_SUFFIXES.some((s) => o.name.endsWith(s))) this._detailMeshes.push(o);
    });
  }

  /**
   * Feed the live camera→craft distance (SCENE UNITS) so inert detail is hidden
   * when far. Flip applied only on hysteresis-threshold crossing (state change).
   * @param {number} distSceneUnits
   */
  setCameraDistance(distSceneUnits) {
    this._detailHidden = applyDetailLod(distSceneUnits, this._detailMeshes, this._detailHidden);
  }

  /** @private Create tether line geometry */
  _createTether() {
    const segments = Constants.TETHER_SEGMENTS;
    const positions = new Float32Array(segments * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    // Item 11 (2026-06-12): SOLID gradient line (was LineDashedMaterial).
    // Per-vertex colors make the cable read as a lit line — bright at the
    // strut anchor (vertex 0) fading toward the daughter — instead of a 1 px
    // dashed line that read as broken. The REELING motion cue is now a
    // brightness pulse traveling anchor-ward (see _updateTether), replacing
    // the old dash-phase scroll; computeLineDistances is no longer needed.
    const colors = new Float32Array(segments * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.tetherMaterial = new THREE.LineBasicMaterial({
      color: Constants.TETHER_COLOR_NOMINAL,   // state tint (multiplies vertex colors)
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
    });
    // Static base gradient: anchor-bright (1.0) → daughter-dim (0.35).
    this.tetherLine = new THREE.Line(geometry, this.tetherMaterial);
    this.tetherLine.visible = false;
    this.tetherLine.frustumCulled = false;
    // §2-followup (round 4): the tether bridges the (separate) daughter and
    // mother objects. Untagged, its transparent line sorted by raw depth and
    // flickered in front of/behind the strut + reel point. CONNECTOR band draws
    // it just above solid hull geometry so it lies cleanly on the craft.
    this.tetherLine.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_CONNECTOR;
    this.group.add(this.tetherLine);
    this._tetherWriteGradient(-1);
  }

  /**
   * @private Item 11: write the per-vertex brightness gradient.
   * Base ramp: 1.0 at the anchor (vertex 0) → 0.35 at the daughter. During
   * REELING a gaussian brightness pulse travels toward the anchor (decreasing
   * t) as the motion cue; `pulsePhase` ∈ [0,1) is the pulse centre (1 = at
   * daughter, 0 = at anchor). Pass a negative phase for "no pulse".
   */
  _tetherWriteGradient(pulsePhase = -1) {
    if (!this.tetherLine) return;
    const colorAttr = this.tetherLine.geometry.attributes.color;
    if (!colorAttr) return;
    const arr = colorAttr.array;
    const segments = Constants.TETHER_SEGMENTS;
    for (let i = 0; i < segments; i++) {
      const t = i / (segments - 1);            // 0 = anchor, 1 = daughter
      let b = 1.0 - 0.65 * t;                  // base ramp 1.0 → 0.35
      if (pulsePhase >= 0) {
        const d = t - pulsePhase;
        b += 0.9 * Math.exp(-(d * d) / (2 * 0.06 * 0.06));   // traveling pulse
        if (b > 1.6) b = 1.6;
      }
      const idx = i * 3;
      arr[idx] = b; arr[idx + 1] = b; arr[idx + 2] = b;
    }
    colorAttr.needsUpdate = true;
  }

  // ==========================================================================
  // SHOP UPGRADES
  // ==========================================================================

  /**
   * Apply a shop upgrade override to this arm's config.
   * Called by ArmManager.applyUpgrade() and ArmManager._reapplyStoredUpgrades().
   * @param {string} effect - Upgrade effect key
   * @param {number} value - Upgrade value
   */
  applyUpgradeOverride(effect, value) {
    switch (effect) {
      case 'tetherRange':
        // Multiply tether max length (e.g., 2.0 = 2× range)
        // Use base constant to avoid compounding on re-apply
        this.config.tetherMax = (this.type === 'weaver'
          ? Constants.WEAVER_TETHER_LENGTH : Constants.SPINNER_TETHER_LENGTH) * value;
        break;
      case 'reelSpeed':
        // Multiply approach/haul speed (e.g., 1.5 = 50% faster)
        this.config.approachSpeed = Constants.ARM_APPROACH_SPEED * value;
        this.config.haulSpeed = Constants.ARM_HAUL_SPEED * value;
        break;
      case 'armFuelMax': {
        // Multiply max fuel (e.g., 1.5 = 50% more FEEP fuel)
        // Refill proportionally to the increase
        const baseFuelMax = 100;
        const newMax = baseFuelMax * value;
        if (this.fuel === baseFuelMax) {
          this.fuel = newMax; // full tank → fill to new max
        }
        // Note: fuel is a percentage 0-100, so we scale the captures-per-fuel instead
        this.config.capturesPerFuel = Math.round(
          (this.type === 'weaver' ? Constants.WEAVER_CAPTURES_PER_FUEL : Constants.SPINNER_CAPTURES_PER_FUEL) * value
        );
        break;
      }
      case 'captureRate':
        // Increase capture success rate (value is additive, e.g., 0.2 = +20%)
        this.config.captureSuccessRate = Math.min(1.0, 0.85 + value);
        break;
      case 'autoDock':
        // Reduce docking time multiplier (value=0.5 → half dock time)
        this.config.dockSpeedMultiplier = 1.0 / value; // 0.5 → 2× faster
        break;
      // --- V4 GSL upgrades (Sprint D5) ---
      case 'v4TetherRange':
        // V4 GSL tether: 6.25× reach (12.5km)
        this.config.tetherMax = (this.type === 'weaver'
          ? Constants.WEAVER_TETHER_LENGTH : Constants.SPINNER_TETHER_LENGTH) * value;
        break;
      case 'v4NetArea': {
        // V4 GSL net: sqrt(10)× radius for 10× area
        const baseNet = this.type === 'weaver' ? Constants.WEAVER_NET_SIZE : Constants.SPINNER_NET_SIZE;
        this.config.netSize = baseNet * value;
        break;
      }
      case 'v4GripForce':
        // V4 electrostatic: 160N grip → can hold heavier debris
        this.config.maxCaptureMass = (this.type === 'weaver'
          ? Constants.WEAVER_MAX_CAPTURE_MASS : Constants.SPINNER_MAX_CAPTURE_MASS) * value;
        break;
    }
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * @private Item 5a (2026-06-12): post a HintTicker entry for a deploy
   * refusal so the next action lands on the bottom strip, not just a
   * scrolling comms line. One id per cause — HintTicker coalesces repeats.
   */
  _postDeployRefusalHint(cause, text) {
    eventBus.emit(Events.HINT_POSTED, {
      id: `deploy_refused_${cause}`,
      text,
      glyph: '!',
      keys: [],
      skillId: null,
      duration: 10000,
      priority: 'normal',
    });
  }

  /**
   * Deploy this arm toward a target debris.
   * @param {object} target - Debris object with ._scenePosition and .id
   * @returns {boolean} true if deployment started
   */
  deploy(target) {
    if (this.state !== S.DOCKED) return false;
    // V5: Spring must be charged to deploy
    // Item 5a (2026-06-12): every refusal ALSO posts a HintTicker entry naming
    // the next verb — a scrolling comms line alone is easy to miss in the
    // learning missions ("every refusal names the next verb").
    if (!this.springCharged) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Spring not charged. Reloading`,
        priority: 'warning',
      });
      this._postDeployRefusalHint('spring', 'Spring reloading. Wait for charge, or deploy another daughter [1-4]');
      return false;
    }
    if (this.fuel <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: No fuel remaining`,
        priority: 'warning',
      });
      this._postDeployRefusalHint('fuel', 'Daughter out of fuel. Deploy another [1-4] or refuel');
      return false;
    }
    if (target.mass && target.mass > this.config.maxCaptureMass) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Target too massive (${target.mass}kg > ${this.config.maxCaptureMass}kg)`,
        priority: 'warning',
      });
      this._postDeployRefusalHint('mass', 'Target too massive for this daughter. Pick a lighter one [T]');
      return false;
    }
    this.target = target;
    this._fuelAtDeploy = this.fuel;         // Track for efficiency scoring
    this._startingDistance = 0;             // Phase 8: reset for approach beep fraction
    this._smoothDriftVel = null;            // Reset EMA-smoothed drift for fresh approach
    this._prevTargetScenePos = null;        // Reset stale target position from previous mission

    // V5: Compute launch direction toward target
    const tPos = this._getTargetScenePos();
    if (tPos) {
      const distToTarget = tPos.distanceTo(this.position) / M;
      // Guard: refuse deployment when target is beyond operational range.
      // Arm autopilot is designed for ~35-200m (after mother autopilot closes).
      // Beyond 500m, transit takes minutes and tether may snap. Force player to
      // use mother autopilot (A key) first.
      const maxDeployRange = Math.min(500, this.config.tetherMax * 0.5);
      if (distToTarget > maxDeployRange) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Target ${Math.round(distToTarget)}m away (max ${Math.round(maxDeployRange)}m). Press A to autopilot closer first.`,
          priority: 'warning',
        });
        this._postDeployRefusalHint('range', 'Target out of daughter range. Press [A] to autopilot closer first');
        this.target = null;
        return false;
      }
      this.launchDirection = tPos.clone().sub(this.position).normalize();
    } else {
      // Fallback: deploy outward along world-space dock direction (§4.6 fix)
      this.launchDirection = this._worldDockDirection(this._lastParentQuat);
    }

    // V5: Use LAUNCHING state (crossbow spring release)
    this._transitionTo(S.LAUNCHING);
    this._undockTimer = 0;
    this._springFired = false;
    this._dockWorldPos = this.position.clone();

    eventBus.emit(Events.ARM_DEPLOYED, {
      armId: this.id, type: this.type, targetId: target.id,
    });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: Cradle launch. Target ${target.id || 'acquired'}`,
      priority: 'info',
    });
    return true;
  }

  /**
   * Deploy this arm in free-fly mode (no target).
   * Goes through LAUNCHING → TRANSIT with manual pilot control.
   * Used by number key deploy when no target is selected.
   * @returns {boolean}
   */
  deployFreefly() {
    if (this.state !== S.DOCKED) return false;
    // V5: Spring must be charged to deploy
    // Phase 0.5 (capture-feedback overhaul): refusal parity with deploy() —
    // every refusal also posts a HintTicker entry naming the next verb.
    // (No mass check here: free-fly has no target to weigh.)
    if (!this.springCharged) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Spring not charged. Reloading`,
        priority: 'warning',
      });
      this._postDeployRefusalHint('spring', 'Spring reloading. Wait for charge, or deploy another daughter [1-4]');
      return false;
    }
    if (this.fuel <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: No fuel remaining`,
        priority: 'warning',
      });
      this._postDeployRefusalHint('fuel', 'Daughter out of fuel. Deploy another [1-4] or refuel');
      return false;
    }
    this.target = null;
    this._trawlingMode = false;
    this._fuelAtDeploy = this.fuel;

    // V5: Launch direction = outward along world-space dock direction (§4.6 fix)
    this.launchDirection = this._worldDockDirection(this._lastParentQuat);

    // V5: Use LAUNCHING state
    this._transitionTo(S.LAUNCHING);
    this._undockTimer = 0;
    this._springFired = false;
    this._dockWorldPos = this.position.clone();

    eventBus.emit(Events.ARM_DEPLOYED, {
      armId: this.id, type: this.type, mode: 'freefly',
    });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: Cradle launch. Free-fly mode`,
      priority: 'info',
    });
    return true;
  }

  /**
   * Deploy arm in trawling mode — slow sweep to passively collect debris.
   * @param {{ x: number, y: number, z: number }|null} direction — trawl direction
   * @returns {boolean}
   */
  deployTrawl(direction) {
    if (this.state !== S.DOCKED) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: this.displayName, text: 'Must be docked to trawl', priority: 'warning',
      });
      return false;
    }
    // V5: Spring must be charged to deploy
    if (!this.springCharged) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Spring not charged. Reloading`,
        priority: 'warning',
      });
      return false;
    }
    if (this.fuel <= 5) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: this.displayName, text: 'Insufficient fuel for trawling', priority: 'warning',
      });
      return false;
    }

    // Fallback uses world-space dock direction so trawl sweeps outward (§4.6 fix).
    this._trawlDirection = direction
      ? new THREE.Vector3(direction.x, direction.y, direction.z).normalize()
      : this._worldDockDirection(this._lastParentQuat);
    this._trawlTimer = 0;
    this._trawlingMode = true;
    this.target = null;

    // V5: Launch direction for trawling
    this.launchDirection = this._trawlDirection.clone();

    // V5: Use LAUNCHING state
    this._transitionTo(S.LAUNCHING);
    this._undockTimer = 0;
    this._springFired = false;
    this._dockWorldPos = this.position.clone();

    eventBus.emit(Events.TRAWL_START, { armId: this.id });
    eventBus.emit(Events.ARM_DEPLOYED, { armId: this.id, type: this.type, mode: 'trawling' });
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: this.displayName, text: 'Cradle launch. Trawling deployed', priority: 'info',
    });

    return true;
  }

  /**
   * Fire a GSL web shot at targeted debris to increase atmospheric drag.
   * Ranged "fire and forget" — arm extends briefly toward target then returns.
   * @param {object} target - Debris object from TargetSelector with .id and ._scenePosition
   * @returns {boolean} true if web shot was initiated
   */
  fireWebShot(target) {
    // Must be IDLE (docked) to fire
    if (this.state !== S.DOCKED) return false;
    if (!target || target.id === undefined || target.id === null) return false;

    // Cooldown check
    if (this._webShotCooldown > 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Web shot cooldown. ${Math.ceil(this._webShotCooldown)}s remaining`,
        priority: 'warning',
      });
      return false;
    }

    // Fuel check
    if (this.fuel < Constants.WEB_SHOT_FUEL_COST) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Insufficient fuel for web shot`,
        priority: 'warning',
      });
      return false;
    }

    // Consume fuel for the shot
    this.fuel -= Constants.WEB_SHOT_FUEL_COST;

    // Store previous state and origin position for animation
    this._webShotPrevState = this.state;
    this._webShotTarget = target;
    this._webShotOrigin.copy(this.position);
    this._transitionTo(S.WEB_SHOT);

    // Make arm visible during shot animation
    this.mesh.visible = true;
    this.tetherLine.visible = true;

    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: 🕸 GSL web shot. Targeting ${target.id}`,
      priority: 'info',
    });

    return true;
  }

  /**
   * Recall this arm (abort mission, return to core).
   *
   * A TETHERED daughter is ALWAYS reeled home on the mothership's zero-fuel
   * strut/tether reel motor and is never abandoned as EXPENDED for low fuel —
   * her emergency FEEP reserve (if any) funds the soft-dock arrest. Only a
   * detached (severed-tether) daughter is beyond reel-in.
   */
  recall() {
    if (this.state === S.DOCKED || this.state === S.EXPENDED) return;

    // Detached arms cannot be recalled — tether severed
    if (this.isDetached) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Cannot recall. Tether severed. Daughter is autonomous.`,
        priority: 'warning',
      });
      return;
    }

    this._manualMode = false; // always exit manual on recall
    this._manualCapture = false;
    this._trawlTimer = 0; // reset trawl timer on recall
    this._trawlingMode = false;
    this._webShotTarget = null; // clear web shot state on recall

    // V5: If reeling or returning, allow recall to just continue return
    // If other states, transition to REELING (zero-fuel return)
    if (this.state === S.REELING || this.state === S.RETURNING) return;

    // STATION_KEEP has its own bookkeeping (the SK target flag, orbit rates,
    // polar-axis cache). Route through the dedicated zero-fuel strut reel so it
    // is torn down cleanly rather than left dangling on the captured debris.
    if (this.state === S.STATION_KEEP) {
      this.capturedDebris = null;
      this.target = null;
      this.reelFromStationKeep();
      eventBus.emit(Events.ARM_RECALLED, { armId: this.id });
      return;
    }

    // The strut/tether reel motor lives on the mothership, so a TETHERED daughter
    // is ALWAYS reeled home on winch power — never abandoned as EXPENDED, even
    // when out of fuel, adrift, or stuck. Her emergency FEEP reserve (if any)
    // funds tether tension + the soft-dock arrest so she eases in rather than
    // slamming the strut.
    const lowFuel = this.fuel <= (Constants.ARM_RESERVE_FUEL ?? 2);
    this.capturedDebris = null;
    this.target = null;
    // V5: Use REELING for zero-fuel return instead of RETURNING
    this._transitionTo(S.REELING);
    if (lowFuel) {
      // Plain-language reassurance: the mother is hauling a low/empty daughter
      // home on the tether (winch power — no propellant needed).
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `Reeling ${this.displayName} home on the tether. Winch power, no FEEP needed.`,
        source: 'HOUSTON',
        channel: 'CMD',
        priority: 'info',
      });
    }
    eventBus.emit(Events.ARM_RECALLED, { armId: this.id });
  }

  // ==========================================================================
  // TETHER DETACH (Phase 6 — Risk-Reward Redline Mechanic)
  // ==========================================================================

  /**
   * Sever the tether and enter free-flight mode.
   * Arm continues on current velocity + remaining FEEP fuel.
   * Cannot refuel, cannot recall. Must self-deorbit after capture.
   * @returns {boolean} true if detach succeeded
   */
  detach() {
    const DETACHABLE = new Set([
      S.TRANSIT, S.APPROACH, S.NETTING, S.GRAPPLED, S.ADRIFT, S.STATION_KEEP
    ]);
    if (!DETACHABLE.has(this.state)) return false;
    if (this.isDetached) return false;

    this.isDetached = true;
    this._detachFuelWarning25 = false;
    this._detachFuelWarning10 = false;

    // Sever tether — no reel-back possible
    this.tetherLength = 0;

    // Hide tether line immediately (also handled in _updateTether, but immediate is cleaner)
    if (this.tetherLine) {
      this.tetherLine.visible = false;
    }

    // Emit detach event
    eventBus.emit(Events.ARM_DETACHED, {
      armId: this.index,
      position: this.position.clone(),
      fuelRemaining: this.fuel,
      hasDebris: this.capturedDebris !== null,
    });

    // Comms callout
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Houston: ${this.displayName}. Tether severed. COWBOY! Free-flight on own fuel.`,
      priority: 'HIGH',
    });

    console.log(`[ArmUnit] ${this.id} DETACHED (fuel: ${this.fuel.toFixed(1)}%)`);
    return true;
  }

  // ==========================================================================
  // MANUAL PILOT MODE (ARM PILOT)
  // ==========================================================================

  /** Enable manual pilot control (player takes over from autopilot) */
  enableManual() {
    if (this.state === S.DOCKED || this.state === S.EXPENDED) return;
    this._manualMode = true;
    eventBus.emit(Events.ARM_STATE_CHANGE, { armId: this.id, manual: true });
  }

  /** Disable manual control (return to autopilot) */
  disableManual() {
    this._manualMode = false;
    eventBus.emit(Events.ARM_STATE_CHANGE, { armId: this.id, manual: false });
  }

  /** @returns {boolean} Whether this arm is in manual pilot mode */
  isManual() {
    return this._manualMode;
  }

  /**
   * Apply manual thrust from ARM PILOT input.
   * Direction is in arm-local space: +Z = forward (toward target), +X = right, +Y = up.
   * @param {{ x: number, y: number, z: number }} direction - Normalized thrust direction
   * @param {boolean} fine - Fine control (Shift held) — reduced thrust
   * @param {number} dt - Delta time
   */
  applyManualThrust(direction, fine, dt) {
    if (!this._manualMode) return;
    // No usable propellant → thrusters are offline. Protect the emergency reserve
    // (held for a safe reel-home) from being burned on manual nudges. She can
    // still be reeled in on the tether — piloting just can't thrust her.
    if (this.state === S.ADRIFT || this.fuel <= (Constants.ARM_RESERVE_FUEL ?? 0)) return;

    // V5: No gamified multiplier — crossbow provides initial velocity, FEEP for corrections only
    // ST-8.3.4: Use metal-specific thrust calculation
    const thrustMag = this._computeMetalThrust();
    const thrust = fine ? thrustMag * 0.25 : thrustMag;
    const accel = thrust / this.config.mass;
    const dv = accel * dt;

    // Convert arm-local direction to world space
    // Forward: toward target (if available) or arm's current velocity direction
    let forward, up, right;
    const tPos = this._getTargetScenePos();
    if (tPos) {
      forward = tPos.clone().sub(this.position).normalize();
    } else if (this.velocity.lengthSq() > 1e-16) {
      forward = this.velocity.clone().normalize();
    } else {
      forward = new THREE.Vector3(0, 0, 1);
    }
    up = this.position.clone().normalize(); // radial up
    right = new THREE.Vector3().crossVectors(forward, up).normalize();
    up = new THREE.Vector3().crossVectors(right, forward).normalize(); // re-orthogonalize

    // Apply thrust in world space
    this.velocity.addScaledVector(right, direction.x * dv);
    this.velocity.addScaledVector(up, direction.y * dv);
    this.velocity.addScaledVector(forward, direction.z * dv);
  }

  // ══════════════════════════════════════════════════════════════════
  //  ST-8.3: FEEP Dual-Metal System
  // ══════════════════════════════════════════════════════════════════

  /**
   * Switch active FEEP propellant metal.
   * Can only switch between current and alternate slot.
   * @param {string} metalId
   * @returns {boolean} success
   */
  switchMetal(metalId) {
    const metals = Constants.ION_THRUSTER_METALS;
    if (!metals[metalId]) return false;

    // Can switch to current, alternate, or indium (default — always available)
    if (metalId !== this._currentMetal && metalId !== this._alternateMetal && metalId !== 'indium') return false;

    const oldMetal = this._currentMetal;
    this._currentMetal = metalId;

    // Update ISP based on new metal
    const metalData = metals[metalId];
    this._metalIsp = (metalData.ispMin + metalData.ispMax) / 2; // midpoint default

    // Emit event
    eventBus.emit(Events.FEEP_METAL_CHANGED, {
      armId: this.id,
      metal: metalId,
      ispRange: [metalData.ispMin, metalData.ispMax],
      thrustPerW: metalData.thrustPerW,
    });

    return true;
  }

  /**
   * Set the alternate FEEP metal slot (unlocked via Forge refining).
   * @param {string} metalId
   * @returns {boolean} success
   */
  setAlternateMetal(metalId) {
    const metals = Constants.ION_THRUSTER_METALS;
    if (!metals[metalId]) return false;
    this._alternateMetal = metalId;
    return true;
  }

  /**
   * Get the data object for the currently active FEEP metal.
   * @returns {object} metal data from ION_THRUSTER_METALS
   */
  getCurrentMetalData() {
    return Constants.ION_THRUSTER_METALS[this._currentMetal] || Constants.ION_THRUSTER_METALS.indium;
  }

  /**
   * Compute thrust from FEEP physics: thrust = P_beam / (isp × g0 × η)
   * Higher ISP = lower thrust (momentum vs efficiency tradeoff).
   * Falls back to config.thrust if ION_THRUSTER_METALS not available.
   * @returns {number} thrust in Newtons
   * @private
   */
  _computeMetalThrust() {
    const IT = Constants.ION_THRUSTER;
    if (!IT) return this.config.thrust;
    const beamPower = this.type === 'weaver' ? IT.BEAM_POWER_WEAVER : IT.BEAM_POWER_SPINNER;
    const g0 = 9.80665;
    return beamPower / (this._metalIsp * g0 * IT.EFFICIENCY);
  }

  /**
   * Manually deploy net from ARM PILOT mode.
   * Transitions directly to NETTING state, bypassing auto-approach.
   * Capture success probability depends on alignment and tumble.
   * @returns {boolean}
   */
  manualNetDeploy() {
    if (this.state !== S.TRANSIT && this.state !== S.APPROACH) return false;
    if (!this.target) return false;

    // 2026-05-28 (Item 8): mirror the inventory gate from captureFromStationKeep
    // so the ARM_PILOT manual-deploy path also fails loudly when the daughter
    // is out of nets, instead of silently transitioning to NETTING and getting
    // a console.warn fallback inside _updateNettingFSM with no UI cue.
    if (Constants.isFeatureEnabled('CAPTURE_NET') && this._netInventory <= 0) {
      eventBus.emit(Events.NET_EMPTY_CLICK, { armId: this.id });
      audioSystem.playClickFail();
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: `${this.displayName}: No nets remaining. Return to mother for reload.`,
        channel: 'CMD',
        priority: 'warning',
      });
      return false;
    }

    this._manualMode = false; // Exit manual control for capture sequence
    this._manualCapture = true; // Flag for scoring (Delegate 3C will use this)
    this._transitionTo(S.NETTING);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: Net deployed. Attempting capture`,
      priority: 'info',
    });
    return true;
  }

  /**
   * Begin one-way deorbit sacrifice. Arm burns all remaining FEEP fuel
   * retrograde, lowering the captured debris' perigee. Both arm and debris
   * are removed when fuel is exhausted.
   * Only valid when arm has captured debris (GRAPPLED, HAULING, REELING, or RETURNING).
   * @returns {{ success: boolean, fuelAtStart: number, totalMass: number }}
   */
  startDeorbit() {
    // A deorbit burn needs real propellant to lower perigee. An ADRIFT /
    // reserve-only daughter can't fund it, so deorbit is disabled at the reserve
    // floor — guide the player to reel her home instead (design decision).
    if (this.state === S.ADRIFT || this.fuel <= (Constants.ARM_RESERVE_FUEL ?? 0)) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: 'HOUSTON', channel: 'CMD',
        text: `${this.displayName}: Insufficient FEEP for a deorbit burn. Reel her in (R) instead.`,
        priority: 'warning',
      });
      return { success: false, fuelAtStart: this.fuel, totalMass: 0 };
    }
    if (this.state !== S.GRAPPLED && this.state !== S.HAULING &&
        this.state !== S.REELING && this.state !== S.RETURNING) {
      return { success: false, fuelAtStart: 0, totalMass: 0 };
    }
    if (!this.capturedDebris && !this.target) {
      return { success: false, fuelAtStart: 0, totalMass: 0 };
    }

    const fuelAtStart = this.fuel;
    const debrisMass = this.capturedDebris
      ? (this.capturedDebris.mass || 1)
      : (this.target ? this.target.mass || 1 : 1);
    const totalMass = this.config.mass + debrisMass;

    this._manualMode = false;
    this._transitionTo(S.DEORBITING);

    eventBus.emit(Events.ARM_DEORBIT, {
      armId: this.id,
      fuelAtStart,
      totalMass,
      debrisId: this.capturedDebris?.id || this.target?.id,
    });

    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: DEORBIT BURN. All fuel committed retrograde`,
      priority: 'warning',
    });

    return { success: true, fuelAtStart, totalMass };
  }

  // ==========================================================================
  // V5 CROSSBOW API
  // ==========================================================================

  /**
   * Set the arm's launch speed for next crossbow fire.
   * Clamped to current spring tier's max speed.
   * @param {number} speed - Desired launch speed in m/s
   */
  setLaunchSpeed(speed) {
    const tier = SPRING_TIERS[this.springTier];
    this.launchSpeed = Math.max(
      CROSSBOW_LAUNCH_SPEED_MIN,
      Math.min(speed, tier.maxSpeed)
    );
  }

  /**
   * Start laser ablation on a target for de-spin/nudge.
   * Only valid in TRANSIT or APPROACH states.
   * @param {object} target - Target object with mesh and optional angularVelocity
   * @returns {boolean}
   */
  startAblation(target) {
    if (this.state !== S.TRANSIT && this.state !== S.APPROACH) return false;
    this.ablationTarget = target;
    this.ablationTimer = 0;
    this._transitionTo(S.ABLATING);
    eventBus.emit(Events.ABLATION_START, {
      armIndex: this.index,
      targetId: target.id || null,
    });
    return true;
  }

  /**
   * Start pulse scan — arm acts as distributed sensor node.
   * Only valid when DOCKED.
   * @returns {boolean}
   */
  startScan() {
    if (this.state !== S.DOCKED) return false;
    this._preScanState = this.state;
    this._scanTimer = 0;
    this._transitionTo(S.SCANNING);
    return true;
  }

  /**
   * Upgrade the spring tier (shop upgrade).
   * @param {number} tier - Spring tier index
   */
  setSpringTier(tier) {
    this.springTier = Math.max(0, Math.min(tier, SPRING_TIERS.length - 1));
    // Clamp current launch speed to new tier max
    this.launchSpeed = Math.min(this.launchSpeed, SPRING_TIERS[this.springTier].maxSpeed);
  }

  /**
   * Upgrade the tether tier (shop upgrade).
   * @param {number} tier - Tether tier index
   */
  setTetherTier(tier) {
    this.tetherTier = Math.max(0, Math.min(tier, TETHER_TIERS.length - 1));
    const t = TETHER_TIERS[this.tetherTier];
    this.tetherMaxLength = t.maxLength;
    this.tetherBreakStrength = t.breakStrength;
  }

  // ==========================================================================
  // ST-9.3 C-3: AIM ALPHA (MERIDIAN SWEEP) — replaces Rev 5 setAimYaw
  // ==========================================================================

  /**
   * Get the current meridian sweep angle.
   * α=0 → stowed (−Y), α=π/2 → equatorial (outward), α=π → zenith (+Y).
   * @returns {number} Current aim alpha in radians [0, π]
   */
  getAimAlpha() {
    return this._aimAlpha;
  }

  /**
   * Set the aim meridian sweep angle with slew-rate clamping.
   * Clamped to [STRUT_SWEEP_MIN, STRUT_SWEEP_MAX] (0 to π).
   * Per-frame delta clamped to STRUT_SLEW_RATE × dt.
   *
   * Rejected if hinge is LOCKED (when LOCKABLE_HINGE feature flag is on).
   *
   * @param {number} alpha — target angle in radians [0, π]
   * @param {number} [dt=0] — frame deltaTime for slew-rate clamping.
   *   If 0, snaps immediately (used for initialization).
   * @returns {boolean} true if alpha was changed, false if rejected (hinge locked)
   */
  setAimAlpha(alpha, dt = 0) {
    // Hinge lock gate (only enforced when feature flag is on)
    if (Constants.FEATURE_FLAGS.LOCKABLE_HINGE && this._hingeState === Constants.HINGE_STATES.LOCKED) {
      return false; // Rotation rejected — hinge is locked
    }

    // C-4: Deploy state gate — during DEPLOYING/STOWING, the deploy state
    // machine owns alpha. User aim changes are rejected.
    if (Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE) {
      const ds = this._deployState;
      if (ds === Constants.DEPLOY_STATES.DEPLOYING || ds === Constants.DEPLOY_STATES.STOWING) {
        return false; // Alpha driven by deploy animation
      }
    }

    const V5 = Constants.OCTOPUS_V5;
    const target = Math.max(V5.STRUT_SWEEP_MIN, Math.min(alpha, V5.STRUT_SWEEP_MAX));

    if (dt > 0) {
      // Slew-rate clamp: max angular change per frame
      const maxDelta = V5.STRUT_SLEW_RATE * dt;
      const delta = target - this._aimAlpha;
      const clampedDelta = Math.max(-maxDelta, Math.min(delta, maxDelta));
      this._aimAlpha += clampedDelta;
    } else {
      // Snap (initialization or test)
      this._aimAlpha = target;
    }
    return true;
  }

  /**
   * Check if aim alpha is in the high-recoil zone.
   * High recoil occurs when strut points mostly axially (near stowed or zenith).
   * @returns {boolean} true if α < HIGH_RECOIL_ALPHA_LOW or α > HIGH_RECOIL_ALPHA_HIGH
   */
  isHighRecoilZone() {
    const V5 = Constants.OCTOPUS_V5;
    return this._aimAlpha < V5.HIGH_RECOIL_ALPHA_LOW ||
           this._aimAlpha > V5.HIGH_RECOIL_ALPHA_HIGH;
  }

  // ==========================================================================
  // ST-9.3 C-3: LOCKABLE HINGE STATE MACHINE (Gap #9)
  // ==========================================================================

  /**
   * Lock the hinge brake (ROTATE → LOCKED). No-op if already locked.
   * Gated behind FEATURE_FLAGS.LOCKABLE_HINGE — when false, this is a no-op.
   * Emits EVENTS.ARM_HINGE_LOCKED on successful transition.
   */
  lockHinge() {
    if (!Constants.FEATURE_FLAGS.LOCKABLE_HINGE) return;
    if (this._hingeState === Constants.HINGE_STATES.LOCKED) return;

    // C-4: Cannot lock hinge during DEPLOYING/STOWING — strut motor is active
    if (Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE) {
      const ds = this._deployState;
      if (ds === Constants.DEPLOY_STATES.DEPLOYING || ds === Constants.DEPLOY_STATES.STOWING) {
        eventBus.emit(Events.ARM_DEPLOY_REJECTED, {
          armIndex: this.index,
          currentState: ds,
          reason: `Cannot lock hinge during ${ds}`,
        });
        return;
      }
    }

    this._hingeState = Constants.HINGE_STATES.LOCKED;
    eventBus.emit(Events.ARM_HINGE_LOCKED, { armIndex: this.index });
  }

  /**
   * Unlock the hinge brake (LOCKED → ROTATE). No-op if already unlocked.
   * Gated behind FEATURE_FLAGS.LOCKABLE_HINGE — when false, this is a no-op.
   * Emits EVENTS.ARM_HINGE_UNLOCKED on successful transition.
   */
  unlockHinge() {
    if (!Constants.FEATURE_FLAGS.LOCKABLE_HINGE) return;
    if (this._hingeState === Constants.HINGE_STATES.ROTATE) return;

    this._hingeState = Constants.HINGE_STATES.ROTATE;
    eventBus.emit(Events.ARM_HINGE_UNLOCKED, { armIndex: this.index });
  }

  /**
   * Query hinge lock state.
   * @returns {boolean} true if hinge is locked AND LOCKABLE_HINGE flag is on.
   *   Returns false if the feature flag is off (hinge always rotatable).
   */
  isHingeLocked() {
    if (!Constants.FEATURE_FLAGS.LOCKABLE_HINGE) return false;
    return this._hingeState === Constants.HINGE_STATES.LOCKED;
  }

  /**
   * Get the raw hinge state string regardless of feature flag.
   * Used by HUD display and tests.
   * @returns {string} 'ROTATE' or 'LOCKED'
   */
  getHingeState() {
    return this._hingeState;
  }

  /**
   * Get the physical deploy state of the strut.
   * When STOW_DEPLOY_STATE_MACHINE flag is OFF: always returns 'DEPLOYED'
   * (C-3 placeholder behavior — existing code paths unaffected).
   * When flag is ON: returns the live deploy state.
   * @returns {string} One of Constants.DEPLOY_STATES values
   */
  getDeployState() {
    if (!Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE) {
      return Constants.DEPLOY_STATES.DEPLOYED;
    }
    return this._deployState;
  }

  // ==========================================================================
  // ST-9.10 C-4: DEPLOY STATE MACHINE — STRUT DEPLOY/STOW
  // ==========================================================================

  /**
   * Begin strut deployment: STOWED → DEPLOYING → DEPLOYED.
   * Strut sweeps from α=0 to α=deployTargetAlpha at STRUT_SLEW_RATE.
   * Duration: deployTargetAlpha / STRUT_SLEW_RATE (default π/2 at 30°/s ≈ 3s).
   *
   * No-op when STOW_DEPLOY_STATE_MACHINE is false.
   * Rejects if current deployState is not STOWED.
   *
   * @param {number} [targetAlpha=Math.PI/2] — target sweep angle (default equatorial)
   * @returns {Promise<void>} Resolves when DEPLOYED is reached
   */
  strutDeploy(targetAlpha) {
    if (!Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE) {
      return Promise.resolve(); // No-op when flag off
    }

    const DS = Constants.DEPLOY_STATES;
    if (this._deployState !== DS.STOWED) {
      eventBus.emit(Events.ARM_DEPLOY_REJECTED, {
        armIndex: this.index,
        currentState: this._deployState,
        reason: `Cannot deploy from ${this._deployState} (must be STOWED)`,
      });
      return Promise.reject(new Error(`Cannot deploy from ${this._deployState}`));
    }

    this._deployTargetAlpha = targetAlpha !== undefined ? targetAlpha : Math.PI / 2;
    this._deployState = DS.DEPLOYING;

    eventBus.emit(Events.ARM_DEPLOY_STARTED, {
      armIndex: this.index,
      fromState: DS.STOWED,
    });

    return new Promise((resolve) => {
      this._deployResolve = resolve;
    });
  }

  /**
   * Begin strut stow: DEPLOYED → STOWING → STOWED.
   * Strut sweeps from current α to α=0 at STRUT_SLEW_RATE.
   * Duration: currentAlpha / STRUT_SLEW_RATE.
   *
   * No-op when STOW_DEPLOY_STATE_MACHINE is false.
   * Rejects if current deployState is not DEPLOYED.
   *
   * @returns {Promise<void>} Resolves when STOWED is reached
   */
  strutStow() {
    if (!Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE) {
      return Promise.resolve(); // No-op when flag off
    }

    const DS = Constants.DEPLOY_STATES;
    if (this._deployState !== DS.DEPLOYED) {
      eventBus.emit(Events.ARM_DEPLOY_REJECTED, {
        armIndex: this.index,
        currentState: this._deployState,
        reason: `Cannot stow from ${this._deployState} (must be DEPLOYED)`,
      });
      return Promise.reject(new Error(`Cannot stow from ${this._deployState}`));
    }

    const fromAlpha = this._aimAlpha;
    this._deployState = DS.STOWING;

    eventBus.emit(Events.ARM_STOW_STARTED, {
      armIndex: this.index,
      fromAlpha,
    });

    return new Promise((resolve) => {
      this._stowResolve = resolve;
    });
  }

  /**
   * Unlock strut from launch lock: LOCKED → STOWED.
   * Used by C-5 launch sequence; here we just implement the transition.
   * No animation — instantaneous transition.
   *
   * No-op when STOW_DEPLOY_STATE_MACHINE is false.
   * Rejects if current deployState is not LOCKED.
   */
  strutUnlock() {
    if (!Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE) {
      return; // No-op when flag off
    }

    const DS = Constants.DEPLOY_STATES;
    if (this._deployState !== DS.LOCKED) {
      eventBus.emit(Events.ARM_DEPLOY_REJECTED, {
        armIndex: this.index,
        currentState: this._deployState,
        reason: `Cannot unlock from ${this._deployState} (must be LOCKED)`,
      });
      return;
    }

    this._deployState = DS.STOWED;
    // Alpha should already be 0 (stowed), ensure it
    this._aimAlpha = 0;
  }

  /**
   * Internal/test setter for deploy state.
   * NOT a gameplay API — used for testing and persistence restore.
   * @param {string} state — one of Constants.DEPLOY_STATES values
   */
  setDeployState(state) {
    const DS = Constants.DEPLOY_STATES;
    const valid = Object.values(DS);
    if (!valid.includes(state)) return;
    this._deployState = state;
  }

  /**
   * Get the deploy sweep progress as a fraction [0, 1].
   * 0 at start of sweep, 1 at completion.
   * Returns -1 if not in a transitional state (DEPLOYING/STOWING).
   * Used by HUD for progress display.
   * @returns {number} Progress fraction, or -1 if not transitioning
   */
  getDeployProgress() {
    const DS = Constants.DEPLOY_STATES;
    if (this._deployState === DS.DEPLOYING) {
      const target = this._deployTargetAlpha || (Math.PI / 2);
      if (target <= 0) return 1;
      return Math.min(1, this._aimAlpha / target);
    }
    if (this._deployState === DS.STOWING) {
      // Stow goes from some alpha toward 0. Progress = 1 - (current/start).
      // We approximate using the deploy target as the "start" reference.
      const startAlpha = this._deployTargetAlpha || (Math.PI / 2);
      if (startAlpha <= 0) return 1;
      return Math.min(1, 1 - (this._aimAlpha / startAlpha));
    }
    return -1;
  }

  /**
   * Tick the deploy state animation each frame.
   * Drives _aimAlpha toward target during DEPLOYING/STOWING at STRUT_SLEW_RATE.
   * Completes transitions when target is reached.
   * @param {number} dt — frame delta time
   * @private
   */
  _tickDeployState(dt) {
    if (!Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE) return;

    const DS = Constants.DEPLOY_STATES;
    const slewRate = Constants.OCTOPUS_V5.STRUT_SLEW_RATE;

    if (this._deployState === DS.DEPLOYING) {
      // Sweep alpha toward target
      const target = this._deployTargetAlpha;
      const maxDelta = slewRate * dt;
      const remaining = target - this._aimAlpha;

      if (remaining <= maxDelta) {
        // Target reached — snap and complete
        this._aimAlpha = target;
        this._deployState = DS.DEPLOYED;
        eventBus.emit(Events.ARM_DEPLOY_COMPLETED, { armIndex: this.index });
        if (this._deployResolve) {
          this._deployResolve();
          this._deployResolve = null;
        }
      } else {
        this._aimAlpha += maxDelta;
      }
    } else if (this._deployState === DS.STOWING) {
      // Sweep alpha toward 0
      const maxDelta = slewRate * dt;
      const remaining = this._aimAlpha;

      if (remaining <= maxDelta) {
        // Target reached — snap and complete
        this._aimAlpha = 0;
        this._deployState = DS.STOWED;
        eventBus.emit(Events.ARM_STOW_COMPLETED, { armIndex: this.index });
        if (this._stowResolve) {
          this._stowResolve();
          this._stowResolve = null;
        }
      } else {
        this._aimAlpha -= maxDelta;
      }
    }
  }

  /**
   * Auto-lock hinge for crossbow fire, then schedule auto-unlock after settle time.
   * Called by fireDualPair and single-fire paths.
   * Choice: one-shot timer approach (HINGE_SETTLE_TIME seconds after fire).
   * @private
   */
  _autoLockForFire() {
    this.lockHinge();
    // Schedule auto-unlock after recoil settle time
    this._hingeSettleTimer = Constants.OCTOPUS_V5.HINGE_SETTLE_TIME;
  }

  /**
   * Tick the hinge settle timer. Call each frame from the update loop.
   * When timer expires, the hinge auto-unlocks.
   * @param {number} dt — frame delta time
   * @private
   */
  _tickHingeSettle(dt) {
    if (this._hingeSettleTimer <= 0) return;
    this._hingeSettleTimer -= dt;
    if (this._hingeSettleTimer <= 0) {
      this._hingeSettleTimer = 0;
      this.unlockHinge();
    }
  }

  // ==========================================================================
  // ST-9.3 C-3: TETHER ANCHOR — strut tip (Gap #9)
  // ==========================================================================

  /**
   * Compute the world-space tether anchor point at the REEL position on the strut.
   *
   * The tether exits from the reel cartridge (at 85% of strut length from the pivot),
   * not from the strut tip (100%). Uses _reelOffset set by PlayerSatellite._updateStruts()
   * in the correct PlayerSatellite local frame. Falls back to dockOffset (strut tip)
   * if _reelOffset isn't available, then to arm.position as last resort.
   *
   * @param {THREE.Vector3} motherPos — mother world position (scene units)
   * @param {THREE.Quaternion} motherQuat — mother world orientation
   * @returns {THREE.Vector3} World-space reel position (scene units)
   */
  getTetherAnchorWorldPosition(motherPos, motherQuat) {
    // Prefer _reelOffset (85% of strut = reel cartridge position)
    const localOffset = this._reelOffset || this.dockOffset;
    if (localOffset) {
      const offset = localOffset.clone();
      if (motherQuat) offset.applyQuaternion(motherQuat);
      return offset.add(motherPos);
    }

    // Fallback: return arm world position (pre-C-3 / no strut geometry)
    return this.position.clone();
  }

  /**
   * Compute the residual recoil angular impulse for a dual-fire at current alpha.
   * Per ARM_PIVOT_ANALYSIS.md §4.3:
   *   residual = 2 × F_impulse × COLLAR_Y × cos(α)
   *
   * F_impulse = m_daughter × v_launch (momentum per arm).
   * The factor of 2 accounts for the antipodal pair.
   * cos(α) = 1 at stowed (max residual), 0 at equatorial (zero residual).
   *
   * @param {number} [launchSpeed] — override launch speed (m/s). Defaults to this.launchSpeed.
   * @returns {number} Residual angular impulse in N·m·s (positive = +Y torque)
   */
  computeRecoilResidual(launchSpeed) {
    const speed = launchSpeed !== undefined ? launchSpeed : this.launchSpeed;
    const mass = this.config.mass;
    const collarY = Constants.OCTOPUS_V5.COLLAR_Y; // meters
    const alpha = this._aimAlpha;

    // Derivation (§4.3): For a pair at azimuths θ and θ+π, both at swing angle α,
    // the net linear impulse = 2·m·v·cos(α) along ±Y.
    // The angular impulse about the Mother CoM comes from the collar offset:
    //   torque_impulse ≈ 2 × (m × v) × COLLAR_Y × cos(α)
    // This is approximate — treats COLLAR_Y as the lever arm for the Y-component force.
    return 2 * mass * speed * collarY * Math.cos(alpha);
  }

  /**
   * Check if the Mother angular rate is below the fire safety threshold.
   * @param {number} omegaMagnitude — |ω| in rad/s of the mother spacecraft
   * @returns {boolean} true if safe to fire (ω below threshold)
   */
  static isFireRateSafe(omegaMagnitude) {
    return omegaMagnitude <= Constants.OCTOPUS_V5.FIRE_RATE_INTERLOCK;
  }

  /**
   * Reset arm to initial state (e.g. new game).
   * Does NOT reset springTier/tetherTier — those are persistent upgrades.
   */
  reset() {
    this.state = S.DOCKED;
    this.fuel = 100;
    this.tetherLength = 0;
    this.target = null;
    this.capturedDebris = null;
    this.stateTimer = 0;
    this.captures = 0;
    this._startingDistance = 0;
    this.position.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.isDetached = false;
    this._tetherSevered = false;
    this._severedCatch = null;
    this._severedDriftS = 0;
    this._detachFuelWarning25 = false;
    this._detachFuelWarning10 = false;
    this._manualMode = false;
    this._manualCapture = false;
    this._fuelAtDeploy = 100;
    this._autoFailChance = 0;
    this._nearbyDebris = [];
    this._webShotCooldown = 0;
    this._webShotTarget = null;
    this._trawlingMode = false;
    this._trawlDirection = null;
    this._trawlTimer = 0;
    this._lastParentQuat = null;   // ST-1.1: clear cached parent quaternion
    this._prevParentPos = null;    // Orbital frame correction: reset on arm reset

    // V5 Crossbow resets
    this.springCharged = true;
    this.reloadProgress = 0;
    this.reloadDuration = 0;
    this.tetherTension = 0;
    this.tetherLength = 0;
    this.ablationTarget = null;
    this.ablationTimer = 0;
    this.reeling = false;
    this.launchDirection = null;
    // Don't reset springTier/tetherTier — those are upgrades

    // C-3: Reset aim/hinge state
    this._aimAlpha = 0;
    this._hingeState = Constants.HINGE_STATES.ROTATE;
    // C-4: Reset deploy state — flag-gated initial value
    this._deployState = Constants.FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE
      ? Constants.DEPLOY_STATES.LOCKED
      : Constants.DEPLOY_STATES.DEPLOYED;
    this._deployTargetAlpha = Math.PI / 2;
    this._deployResolve = null;
    this._stowResolve = null;
    this._hingeSettleTimer = 0;

    this.mesh.visible = false;
    this.tetherLine.visible = false;
  }

  /**
   * Update arm each frame.
   * @param {number} dt - Real-time delta in seconds
   * @param {THREE.Vector3} parentPos - Core satellite world position
   * @param {THREE.Quaternion} [parentQuat] - Core satellite quaternion
   */
  update(dt, parentPos, parentQuat) {
   this.stateTimer += dt;

   // C-3: Tick hinge auto-unlock settle timer
   this._tickHingeSettle(dt);

   // C-4: Tick deploy state animation (DEPLOYING/STOWING strut sweep)
   this._tickDeployState(dt);

   // --- Orbital frame correction (APPLY): keep deployed arms in ship's co-moving frame ---
   // MUST run BEFORE state machine so _updateTransit / _updateApproach see
   // this.position in the CURRENT frame's co-moving frame (matching the freshly-
   // propagated target._scenePosition from DebrisField). When this ran AFTER the
   // state machine, the arm's position was one orbital step behind the target,
   // creating a ~1900 m phantom gap that prevented convergence.
   //
   // NOTE: _prevParentPos is updated AFTER the state machine (below) so that the
   // drift calculation `(parentPos - _prevParentPos)` in _updateTransit still sees
   // the correct per-frame parent displacement, not zero.
   if (parentPos) {
     if (this.state !== S.DOCKED && this.state !== S.DOCKING) {
       if (this._prevParentPos) {
         this.position.x += (parentPos.x - this._prevParentPos.x);
         this.position.y += (parentPos.y - this._prevParentPos.y);
         this.position.z += (parentPos.z - this._prevParentPos.z);
       }
     }
   }

   switch (this.state) {
     case S.DOCKED:     this._updateDocked(dt, parentPos, parentQuat); break;
     case S.UNDOCKING:  this._updateUndocking(dt, parentPos); break;
     case S.LAUNCHING:  this._updateLaunching(dt, parentPos); break;
     case S.TRANSIT:    this._updateTransit(dt, parentPos); break;
     case S.APPROACH:   this._updateApproach(dt, parentPos); break;
     case S.NETTING:    this._updateNetting(dt); break;
     case S.GRAPPLED:   this._updateGrappled(dt); break;
     case S.HAULING:    this._updateHauling(dt, parentPos); break;
     case S.REELING:    this._updateReeling(dt, parentPos, parentQuat); break;
     case S.RETURNING:  this._updateReturning(dt, parentPos, parentQuat); break;
     case S.DOCKING:    this._updateDocking(dt, parentPos, parentQuat); break;
      case S.RELOADING:  this._updateReloading(dt); break;
      case S.HOLDING_CATCH: this._updateHoldingCatch(dt, parentPos, parentQuat); break;
     case S.TRAWLING:   this._updateTrawling(dt, parentPos); break;
     case S.DEORBITING: this._updateDeorbiting(dt); break;
     case S.WEB_SHOT:   this._updateWebShot(dt, parentPos); break;
     case S.ABLATING:   this._updateAblating(dt); break;
      case S.SCANNING:   this._updateScanning(dt); break;
      case S.STATION_KEEP: this._updateStationKeep(dt); break;
     case S.MAGNETIC_GRAPPLE: this._updateMagneticGrapple(dt); break;
     case S.GRIPPER_GRAPPLE: this._updateGripperGrapple(dt); break;
     case S.PAD_CONTACT: this._updatePadContact(dt); break;
     case S.EXPENDED:   this._updateExpended(dt); break;
     case S.ADRIFT:     this._updateAdrift(dt); break;
   }

   // --- Orbital frame correction (STORE): update _prevParentPos AFTER state machine ---
   // Must be separate from the APPLY step above so that _updateTransit's drift
   // calculation `(parentPos - _prevParentPos)` sees the correct per-frame delta
   // (last frame's parentPos → this frame's parentPos), not zero.
    if (parentPos) {
      if (!this._prevParentPos) {
        this._prevParentPos = new THREE.Vector3();
      }
      this._prevParentPos.copy(parentPos);
    }

    // --- Lead-aim: estimate the selected target's velocity RELATIVE TO THE ARM ---
    // Tracked every frame while a target exists (so by the time NETTING fires the
    // net on its first frame, STATION_KEEP has already built a velocity estimate).
    //
    // 2026-06-12 (Issue 2 fix): the net is propagated in the ARM's co-orbiting
    // frame — CaptureNet re-anchors `net.position = arm.position + launchDir ×
    // distanceTraveled` every flight frame — so the correct lead velocity is the
    // target velocity AS SEEN FROM THE ARM, not the raw scene-space delta. In a
    // settled STATION_KEEP both arm and target share the orbital drift, so the
    // relative velocity is ≈0 and the shot must fly dead straight; leading by
    // the shared drift (the old behavior) bent every SK shot off-axis. Both
    // deltas are sampled in this same block (identical frame timing) for
    // robustness. Units: scene units/s throughout (NOT metres/s — both
    // `_scenePosition` and `arm.position` are scene-space; `launchSpeedScene =
    // LAUNCH_SPEED × M` in computeLeadAim matches).
    {
      const tp = this.target && this.target._scenePosition;
      if (tp && dt > 1e-6) {
        if (this._leadTargetPrevPos && this._leadArmPrevPos) {
          if (!this._leadTargetVel) this._leadTargetVel = new THREE.Vector3();
          // Arm-relative velocity in scene units/s: (targetDelta − armDelta)/dt.
          this._leadTargetVel.set(
            ((tp.x - this._leadTargetPrevPos.x) - (this.position.x - this._leadArmPrevPos.x)) / dt,
            ((tp.y - this._leadTargetPrevPos.y) - (this.position.y - this._leadArmPrevPos.y)) / dt,
            ((tp.z - this._leadTargetPrevPos.z) - (this.position.z - this._leadArmPrevPos.z)) / dt,
          );
          this._leadTargetVelValid = true;
        } else {
          if (!this._leadTargetPrevPos) this._leadTargetPrevPos = new THREE.Vector3();
          if (!this._leadArmPrevPos) this._leadArmPrevPos = new THREE.Vector3();
        }
        this._leadTargetPrevPos.copy(tp);
        this._leadArmPrevPos.copy(this.position);
      } else {
        this._leadTargetPrevPos = null;
        this._leadArmPrevPos = null;
        this._leadTargetVelValid = false;
      }
    }

   // --- ST-5.2: Trail sample emission (10 Hz gated by game time) ---
    if (Constants.TRAILS && Constants.TRAILS.ENABLED !== false &&
        this.state !== S.DOCKED && this.state !== S.RELOADING) {
      const gameDt = dt * Constants.TIME_SCALE_GAMEPLAY;
      this._trailSampleAccum = (this._trailSampleAccum || 0) + gameDt;
      const trailInterval = 1 / (Constants.TRAILS.SAMPLE_RATE_HZ || 10);
      if (this._trailSampleAccum >= trailInterval) {
        this._trailSampleAccum -= trailInterval;
        if (this._trailSampleAccum > trailInterval) this._trailSampleAccum = 0;
        eventBus.emit(Events.ARM_TRAIL_SAMPLE, {
          armId: this.id,
          pos: { x: this.position.x, y: this.position.y, z: this.position.z },
          vel: { x: this.velocity.x, y: this.velocity.y, z: this.velocity.z },
        });
      }
    }

    // Web shot cooldown tick (Sprint D1)
    if (this._webShotCooldown > 0) {
      this._webShotCooldown -= dt;
      if (this._webShotCooldown < 0) this._webShotCooldown = 0;
    }

    // Fuel consumption (when active — trawling uses minimal power)
    // DEORBITING handles its own burn rate in _updateDeorbiting()
    // TRAWLING handles its own fuel consumption in _updateTrawling()
    // WEB_SHOT fuel is consumed upfront in fireWebShot()
    // V5: REELING, RELOADING, LAUNCHING, ABLATING, SCANNING exempt from legacy fuel
    if (this.state !== S.DOCKED && this.state !== S.EXPENDED &&
        this.state !== S.DEORBITING && this.state !== S.TRAWLING &&
        this.state !== S.WEB_SHOT && this.state !== S.REELING &&
        this.state !== S.RELOADING && this.state !== S.LAUNCHING &&
        this.state !== S.ABLATING && this.state !== S.SCANNING &&
        this.state !== S.ADRIFT) {
      this._consumeFuel(dt);
    }

    // Max-distance kill for detached arms — prevent orphaned arms drifting forever
    if (this.isDetached && this.state !== S.EXPENDED && parentPos) {
      const distMeters = this.position.distanceTo(parentPos) / M;
      if (distMeters > Constants.DETACH_MAX_DISTANCE) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Daughter lost. ${this.displayName} exceeded max range (${Math.round(distMeters)}m). Signal lost.`,
          priority: 'critical',
        });
        eventBus.emit(Events.ARM_LOST, { armId: this.id, reason: 'max_distance' });
        eventBus.emit(Events.ARM_EXPENDED, { armId: this.id, type: this.type });
        this._transitionTo(S.EXPENDED);
      }
    }

    // Update tether visual — C-3: use strut tip as mother-side anchor when available
    this._updateTether(parentPos, parentQuat, dt);
    this._updateBridle();  // S3.6 — bridle visibility mirrors tether

    // Update mesh position
    this.group.position.copy(this.position);

    // --- Attitude control: orient the daughter along its heading ---
    // DOCKED/DOCKING/RELOADING/HOLDING_CATCH: mesh hidden or strut-aligned — skip.
    //   These are owned by PlayerSatellite.postArmUpdate, which has the live
    //   strut basis (sg.strutDir/azRad) and composes the mother's world quat.
    //   DOCKED snaps; DOCKING slerps onto the strut (no pop at dock); HOLDING_CATCH
    //   snaps to the strut basis (no wrong-basis drift toward raw parentQuat).
    //   Keeping a SINGLE owner avoids the override-fight class of bug (HANDOFF §10
    //   Rule B) that caused the parked daughter to rotate to the mother bus basis
    //   and render the tether in the wrong direction (Item 5).
    // LAUNCHING: maintain strut-aligned orientation set by postArmUpdate on the
    //   last DOCKED frame. The arm is either in clamp hold (velocity=0) or just
    //   launched (velocity along strut). Slerping toward parentQuat or a lookAt
    //   target here would cause a disorienting rotation because postArmUpdate uses
    //   setFromUnitVectors (no roll constraint) while lookAt uses Earth-radial up
    //   (different roll). Skip entire LAUNCHING state — attitude picks up in TRANSIT.
    // APPROACH/NETTING: nose (+Z) toward target for intercept.
    // All other deployed states: nose (+Z) along velocity (prograde).
    // Fallback: inherit mother's orientation (parentQuat) when no heading available.
    const skipAttitude = (this.state === S.DOCKED || this.state === S.DOCKING ||
                         this.state === S.RELOADING || this.state === S.LAUNCHING ||
                         this.state === S.HOLDING_CATCH);
    if (!skipAttitude) {
      let headingDir = null;
      let reelHeading = false;

      // Target-tracking states: point nose toward debris target
      // STATION_KEEP included so the arm faces the debris instead of
      // inheriting the mother's prograde orientation (which caused 180° flips).
      if ((this.state === S.APPROACH || this.state === S.NETTING || this.state === S.STATION_KEEP) &&
          (this.target || this._stationKeepTarget)) {
        const _attTarget = this._stationKeepTarget || this.target;
        const tPos = _attTarget._scenePosition || _attTarget.position || _attTarget;
        headingDir = this._tmpVec.subVectors(tPos, this.position);
        if (headingDir.lengthSq() < 1e-20) headingDir = null;
        else headingDir.normalize();
      }

      // Whole-haul reel attitude (REEL_PROFILE_V2, plan Rev-3): during REELING
      // point the nose (+Z) at the LIVE strut-tip dock so the +Y wishbone bridle
      // (and thus the tether) trails off-axis from the ±Z FEEP plume — the yoke
      // tether-plume clearance the FEEP-during-reel behaviours depend on. Held
      // for the entire haul (not just the arrest), and recomputed each frame so
      // it tracks a maneuvering mother. Replaces the prograde/inherited fallback
      // that REELING used before (REELING barely sets velocity).
      if (!headingDir && this.state === S.REELING
          && Constants.isFeatureEnabled('REEL_PROFILE_V2') && parentPos && this.dockOffset) {
        const dockWP = this._tmpDockTarget || (this._tmpDockTarget = new THREE.Vector3());
        this._resolveStrutDockWorld(parentPos, parentQuat, dockWP);
        headingDir = this._tmpVec.subVectors(dockWP, this.position);
        if (headingDir.lengthSq() < 1e-20) headingDir = null;
        else { headingDir.normalize(); reelHeading = true; }
      }

      // Prograde fallback: align nose with velocity vector
      if (!headingDir && this.velocity.lengthSq() > 1e-20) {
        headingDir = this._tmpVec.copy(this.velocity).normalize();
      }

      if (headingDir) {
        // Use Earth-radial as "up" (same convention as mother satellite)
        const radial = _orientRadial.copy(this.position).normalize();
        const eye = _orientEye.copy(this.position).add(headingDir);
        _orientMat.lookAt(eye, this.position, radial);
        const targetQuat = _orientQuat.setFromRotationMatrix(_orientMat);
        // V-8 fix: faster slerp for target-tracking states so daughter visually
        // snaps to face debris promptly. 0.05 was ~1s to converge — too slow for
        // APPROACH/STATION_KEEP where the daughter should clearly face the debris.
        let sRate;
        if (reelHeading) {
          sRate = (Constants.YOKE_CLEARANCE && Constants.YOKE_CLEARANCE.REEL_ATTITUDE_SLERP) ?? 0.1;
        } else {
          sRate = (this.state === S.APPROACH || this.state === S.STATION_KEEP || this.state === S.NETTING)
            ? 0.15    // fast reorientation during close-range operations
            : 0.05;   // gentle for TRANSIT (cosmetic, less disorienting on long flights)
        }
        this.group.quaternion.slerp(targetQuat, sRate);
      } else if (parentQuat) {
        // No heading available (velocity ≈ 0 when stationary, etc.)
        // Inherit mother's orientation so daughters don't appear to counter-rotate
        // when the camera follows the mother's pitch.
        this.group.quaternion.slerp(parentQuat, 0.1);
      }

      // [DBG-ARM] ATTITUDE per-frame log removed (excessive noise — was firing every frame
      // for every arm in every state). If needed, re-enable with a much tighter throttle.
    }

    // Thruster plume animation
    this._updatePlumes(dt);

    // Status light color based on state
    this._updateStatusLight(dt);

    // D4: selection glow/flash pulse on the body facets (when selected)
    this._updateSelectGlow(dt);
  }

  /**
   * Get arm status snapshot for HUD.
   * @returns {object}
   */
  getStatus() {
    return {
      id: this.id,
      type: this.type,
      state: this.state,
      fuel: Math.round(this.fuel),
      tetherLength: Math.round(this.tetherLength),
      targetId: this.target?.id || null,
      hasCaptured: !!this.capturedDebris,
      captures: this.captures,
      position: this.position.clone(),
      remainingDeltaV: (this.fuel / 100) * (this.config?.totalDeltaV || 50),
      isDetached: this.isDetached,
      // V5 Crossbow fields
      springCharged: this.springCharged,
      reloadProgress: this.reloadProgress,
      tetherTension: this.tetherTension,
      launchSpeed: this.launchSpeed,
      springTier: this.springTier,
      tetherTier: this.tetherTier,
    };
  }

  /** @private Get target scene position (computed by DebrisField each frame) */
  _getTargetScenePos() {
    if (!this.target) return null;
    return this.target._scenePosition || null;
  }

  // ==========================================================================
  // STATE MACHINE
  // ==========================================================================

  /** @private Transition to a new state */
  _transitionTo(newState) {
    const old = this.state;
    if (old === S.NETTING) this._firedNet = null;  // clear net ref when leaving NETTING
    this.state = newState;
    this.stateTimer = 0;
    eventBus.emit(Events.ARM_STATE_CHANGE, {
      armId: this.id, from: old, to: newState,
    });
    // ST-5.2: Clear trail buffer on dock/reload
    if (newState === S.DOCKED || newState === S.RELOADING) {
      this._trailSampleAccum = 0;
      eventBus.emit(Events.ARM_TRAIL_CLEAR, { armId: this.id });
      this._captureToolKind = 'NET';   // P2: reset capture-verb to default on a clean slate
    }
    // REEL_PROFILE_V2 bookkeeping reset on a fresh capture/dock cycle so the
    // SNUG window (Q3), catch-cleared guard, and re-dock arrest (Q4) re-arm.
    if (newState === S.GRAPPLED || newState === S.DOCKED || newState === S.RELOADING ||
        newState === S.HOLDING_CATCH) {
      this._catchSnugged = false;
      this._reelHadPayload = false;
      this._redockArrestStarted = false;
      this._redockFuelLowWarned = false;
      this._redockDebitApplied = false;
    }
    // CP-1 / P2: refresh the per-arm tool recommendation on STATION_KEEP entry
    // and default selectedTool to the recommended verb (player can re-cycle).
    if (newState === S.STATION_KEEP && Constants.isFeatureEnabled('DAUGHTER_MULTITOOL')) {
      this._refreshToolRecommendation();
    }
    // CP-1: release the tool-closing CA exemption on ANY exit from a closing
    // state (MAGNETIC_GRAPPLE / GRIPPER_GRAPPLE / PAD_CONTACT) — success,
    // failure, OR an external recall/deorbit — so the AUTOPILOT_TARGET_LOCK set
    // on entry can never leak and permanently exempt a debris from avoidance.
    if ((old === S.MAGNETIC_GRAPPLE || old === S.GRIPPER_GRAPPLE || old === S.PAD_CONTACT)
        && this._toolLockedDebrisId != null) {
      eventBus.emit(Events.AUTOPILOT_TARGET_UNLOCK, { debrisId: this._toolLockedDebrisId });
      this._toolLockedDebrisId = null;
    }
    // ST-8.3.4: Auto-adjust ISP based on flight phase for current metal
    this._updateMetalIspForPhase(newState);
  }

  /**
   * Set _metalIsp based on flight phase and current metal's ISP range.
   * Phase-specific ISP values are clamped to the metal's [ispMin, ispMax].
   * @private
   */
  _updateMetalIspForPhase(phase) {
    const IT = Constants.ION_THRUSTER;
    if (!IT) return;
    const metalData = this.getCurrentMetalData();
    if (!metalData) return;

    // Map ARM_STATES → desired ISP
    const ispMap = {
      [S.TRANSIT]:       IT.ISP_TRANSIT,
      [S.APPROACH]:      IT.ISP_APPROACH,
      [S.STATION_KEEP]:  IT.ISP_STATIONKEEP,
      [S.RETURNING]:     IT.ISP_RETURN,
      [S.DEORBITING]:    IT.ISP_DEORBIT,
    };

    const desired = ispMap[phase];
    if (desired !== undefined) {
      // Clamp to metal's range
      this._metalIsp = Math.max(metalData.ispMin, Math.min(metalData.ispMax, desired));
    }
  }

  /**
   * V5 Crossbow: Apply spring-launched impulse.
   * E = ½kd², v = √(2E/m) = d√(k/m)
   * All velocities come from spring energy, not magic multipliers.
   * @private
   * @returns {number} Actual launch speed used (m/s)
   */
  _applyLaunchImpulse() {
    const tier = SPRING_TIERS[this.springTier];
    const isWeaver = this.config.type === 'weaver';
    const armMass = isWeaver ? V5_WEAVER_MASS : V5_SPINNER_MASS;
    const springK = isWeaver ? CROSSBOW_SPRING_K_WEAVER : CROSSBOW_SPRING_K_SPINNER;

    // Clamp launch speed to spring tier max
    const speed = Math.min(this.launchSpeed, tier.maxSpeed);

    // Spring energy: E = ½kd², effective k scales as v² for variable launch speed
    // (springK and CROSSBOW_DRAW_DISTANCE are used to validate energy budget;
    //  actual impulse is applied directly as velocity for numerical stability)

    // Apply impulse in launch direction (game scale)
    const launchVelocity = speed * M;  // Convert to game units

    if (this.launchDirection) {
      this.velocity.copy(this.launchDirection).multiplyScalar(launchVelocity);
    } else {
      // Fallback: use world-space dock direction so impulse pushes outward
      // even when the mothership is rotated (§4.6 fix).
      const dir = this._worldDockDirection(this._lastParentQuat);
      this.velocity.copy(dir).multiplyScalar(launchVelocity);
    }

    // Store actual launch speed for TRANSIT V_CAP (arm should coast, not accelerate)
    this._launchSpeedMps = speed;

    // Mark spring as discharged
    this.springCharged = false;

    // Emit fire event (includes launchDirection for station-keeping recoil compensation)
    eventBus.emit(Events.CROSSBOW_FIRE, {
      armIndex: this.index,
      speed: speed,
      springTier: this.springTier,
      armMass: armMass,
      launchDirection: this.velocity.clone().normalize(),
    });

    // Calculate reload duration based on energy stored
    // E = ½ × m × v², reload time = E / (P × η)
    const energy = 0.5 * armMass * speed * speed;
    this.reloadDuration = energy / (CROSSBOW_RELOAD_POWER * CROSSBOW_WORM_GEAR_EFFICIENCY);

    return speed; // Return actual launch speed for recoil calculation
  }

  /**
   * Compute world-space dock (deploy) direction from LOCAL dockOffset.
   * Rotates dockOffset by the parent ship's world quaternion so arms always
   * deploy OUTWARD regardless of mothership orientation (§4.6 180° bug fix).
   * @param {THREE.Quaternion|null} parentQuat - parent ship world quat (nullable)
   * @returns {THREE.Vector3} normalized world-space deploy direction
   * @private
   */
  _worldDockDirection(parentQuat) {
    const dir = this.dockOffset.clone();
    if (parentQuat) dir.applyQuaternion(parentQuat);
    return dir.normalize();
  }

  /** DOCKED: follow parent at dock offset */
  _updateDocked(dt, parentPos, parentQuat) {
    // Cache parent quat so externally-invoked deploy*() methods can derive
    // a world-space launch direction (§4.6 fix). P3: owned persistent quat —
    // consumers (_worldDockDirection) read it at deploy time, never store it.
    this._lastParentQuat = parentQuat
      ? (this._lastParentQuatV || (this._lastParentQuatV = new THREE.Quaternion())).copy(parentQuat)
      : null;
    const offset = _dockOffTmp.copy(this.dockOffset);
    if (parentQuat) offset.applyQuaternion(parentQuat);
    this.position.copy(parentPos).add(offset);
    // POLISH FIX: do NOT unconditionally hide the daughter mesh on DOCKED.
    // PlayerSatellite.postArmUpdate() (runs immediately after armManager.update)
    // owns visibility based on deploy state — DEPLOYED → visible at strut tip,
    // LOCKED/STOWED → hidden.  Hiding here made the daughter "disappear" after
    // re-dock at the end of REELING, before the next undock.  Now she stays
    // visibly clamped to the strut after a successful retrieval.
    this.tetherLine.visible = false;
    this.velocity.set(0, 0, 0);
  }

  /**
   * UNDOCKING: slowly separate from core (2s animation).
   * Legacy state — preserved for backward compatibility.
   * V5 uses LAUNCHING instead for crossbow spring release.
   */
  _updateUndocking(dt, parentPos) {
    this.mesh.visible = true;
    this.tetherLine.visible = true;

    // Push outward along world-space dock direction (§4.6 fix).
    const pushDir = this._worldDockDirection(this._lastParentQuat);
    const speed = this.config.bodyDims[2] * M * 2;
    this.position.add(pushDir.multiplyScalar(speed * dt));

    this.tetherLength = this.position.distanceTo(parentPos) / M;  // in meters

    if (this.stateTimer > Constants.ARM_DETACH_DURATION) {
      if (this._trawlingMode) {
        this._transitionTo(S.TRAWLING);
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Trawling mode. Slow sweep for debris`,
          priority: 'info',
        });
      } else {
        this._transitionTo(S.TRANSIT);
        // Legacy: still uses old launch impulse for backward compat
        this._applyLaunchImpulse();
        // Issue 1 (2026-06-12): departure event for audio (legacy UNDOCKING path).
        eventBus.emit(Events.ARM_SPRING_FIRED, {
          armId: this.id, type: this.type, speed: this.launchSpeed, mode: 'normal',
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Clear of core. In transit`,
          priority: 'info',
        });
        // Manual-pilot nudge moved to ArmIdleAdvisor (Constants.ARM_IDLE_HINTS
        // 'transit_pilot_nudge') so it is veteran-gated + deployment-scoped and
        // routed through the same hint pipeline. (Guidance cleanup, Phase 2/3.)
      }
    }
  }

  /**
   * LAUNCHING: V5 crossbow spring release sequence.
   * Phase 1: Magnetic clamp release (0..CROSSBOW_UNDOCK_TIME)
   * Phase 2: Spring release (CROSSBOW_UNDOCK_TIME..+ CROSSBOW_RELEASE_TIME)
   * @private
   */
  _updateLaunching(dt, parentPos) {
    this.mesh.visible = true;
    this.tetherLine.visible = true;

    this._undockTimer = (this._undockTimer || 0) + dt;

    if (this._undockTimer < CROSSBOW_UNDOCK_TIME) {
      // Phase 1: Magnetic clamp release — arm holds at current position
      // (position was set correctly by _updateDocked on prior frame)
    } else if (this._undockTimer >= CROSSBOW_UNDOCK_TIME && !this._springFired) {
      // Phase 2: Fire the spring!
      this._springFired = true;
      this._applyLaunchImpulse();
      // Issue 1 (2026-06-12): actual departure moment — audio (woosh) keys off
      // THIS event, not ARM_DEPLOYED (which fires 1.5 s earlier at LAUNCHING
      // entry, during the magnetic-clamp-release hold).
      eventBus.emit(Events.ARM_SPRING_FIRED, {
        armId: this.id, type: this.type, speed: this.launchSpeed,
        mode: this._trawlingMode ? 'trawl' : 'normal',
      });
    }

    if (this._springFired) {
      // Arm is flying — update position with velocity
      this.position.addScaledVector(this.velocity, dt);
      this.tetherLength = this.position.distanceTo(parentPos) / M;
    }

    // Transition after full launch sequence
    if (this._undockTimer >= CROSSBOW_UNDOCK_TIME + CROSSBOW_RELEASE_TIME + 0.2) {
      if (this._trawlingMode) {
        this._transitionTo(S.TRAWLING);
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Trawling mode. Slow sweep for debris`,
          priority: 'info',
        });
      } else {
        this._transitionTo(S.TRANSIT);
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Clear of core. Cradle transit`,
          priority: 'info',
        });
        // Manual-pilot nudge moved to ArmIdleAdvisor (Constants.ARM_IDLE_HINTS
        // 'transit_pilot_nudge') — veteran-gated + deployment-scoped. (Phase 2/3.)
      }
      this._undockTimer = 0;
      this._springFired = false;
    }
  }

  /** TRANSIT: fly toward target using FEEP thrust */
  _updateTransit(dt, parentPos) {
    if (this._manualMode) {
      // Manual mode: player controls velocity, we just update position.
      // Autopilot (proportional controller, pings, thruster audio) is
      // intentionally skipped to suppress approach beep + thruster hum
      // that were reported as annoying in ARM_PILOT mode.
      this.position.addScaledVector(this.velocity, dt);
      this.tetherLength = this.position.distanceTo(parentPos) / M;
      if (!this.isDetached && this.tetherLength > this.config.tetherMax) {
        const dir = _tetherDir.subVectors(this.position, parentPos).normalize();
        this.position.copy(parentPos).add(dir.multiplyScalar(this.config.tetherMax * M));
        const velAlongTether = this.velocity.dot(dir);
        if (velAlongTether > 0) {
          this.velocity.addScaledVector(dir, -velAlongTether);
        }
      }
      // ── STILL CHECK APPROACH THRESHOLD even in manual mode ──
      // enableManual() fires during LAUNCH_CEREMONY_COMPLETE while the arm
      // is still in TRANSIT. Without this gate the arm coasts forever and
      // never transitions to APPROACH → STATION_KEEP.
      if (this.target) {
        const _tPos = this._getTargetScenePos();
        if (_tPos) {
          const _dist = _tPos.distanceTo(this.position);
          const _dSz = (this.target.sizeMeter) || 1;
          const _so = Math.max(Constants.STATION_KEEP.DEFAULT_STANDOFF,
            Math.min(Constants.STATION_KEEP.MAX_STANDOFF,
              _dSz * Constants.STATION_KEEP.DEFAULT_STANDOFF_MULT));
          const _thresh = Math.max(_so * 2, this.config.bodyDims[2] * 15) * M;
          if (_dist < _thresh) {
            this._transitionTo(S.APPROACH);
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: `${this.displayName}: Beginning final approach`,
              priority: 'info',
            });
          }
        }
      }
      return; // skip autopilot logic (pings, thruster audio, etc.)
    }

    const targetPos = this._getTargetScenePos();
    if (!targetPos) {
      this.recall();
      return;
    }
    const toTarget = this._tmpVec.subVectors(targetPos, this.position);
    const dist = toTarget.length();

    // Phase 8: Track starting distance for approach beep fraction
    if (this._startingDistance === 0 || dist > this._startingDistance) {
      this._startingDistance = dist;
    }
    // Phase 8: Emit approach ping with distance fraction
    if (this._startingDistance > 0) {
      const distFraction = Math.min(1, dist / this._startingDistance);
      eventBus.emit(Events.ARM_APPROACH_PING, { distanceFraction: distFraction, armId: this.id });
    }

    // Update tether length
    this.tetherLength = this.position.distanceTo(parentPos) / M;

    // Check tether limit (skip for detached arms — free-flying)
    if (!this.isDetached && this.tetherLength >= this.config.tetherMax * 0.95) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Tether limit (${Math.round(this.config.tetherMax)}m). Recalling`,
        priority: 'warning',
      });
      // Phase 6: Signal tutorial system that tether limit was hit (detach hint trigger)
      eventBus.emit(Events.TUTORIAL_TETHER_LIMIT, { armId: this.id });
      this.recall();
      return;
    }

    // ── Proportional controller with velocity matching ──
    // Mirrors mother AutopilotSystem.js control law (§D quadratic braking + relV).
    // arm.velocity is in the parent co-moving frame (orbital frame correction at
    // line 1831 adds parentDelta each frame). driftVel compensates for the
    // different orbit of the target vs parent.
    const DAP_T = Constants.DAUGHTER_AUTOPILOT;

    // Orbital drift velocity: how the target moves relative to parent frame
    // Raw finite-difference is noisy (catastrophic cancellation when tDelta ≈ pDelta
    // for co-orbiting objects). EMA smoothing eliminates frame-to-frame jitter.
    let rawDriftVel = _driftRaw.set(0, 0, 0);
    if (this._prevTargetScenePos && this._prevParentPos && parentPos && dt > 0) {
      const tDelta = _driftTDelta.subVectors(targetPos, this._prevTargetScenePos);
      const pDelta = _driftPDelta.subVectors(parentPos, this._prevParentPos);
      rawDriftVel = tDelta.sub(pDelta).divideScalar(dt);
    }
    if (!this._prevTargetScenePos) this._prevTargetScenePos = targetPos.clone();
    else this._prevTargetScenePos.copy(targetPos);

    // EMA-smooth the drift velocity (shared across TRANSIT/APPROACH via instance field)
    if (!this._smoothDriftVel) this._smoothDriftVel = new THREE.Vector3(0, 0, 0);
    const alpha = DAP_T.DRIFT_EMA_ALPHA || 0.1;
    this._smoothDriftVel.lerp(rawDriftVel, alpha);
    const driftVelT = this._smoothDriftVel;

    // Velocity error: when relV → 0, arm matches target orbital velocity
    const relVT = _relVel.subVectors(driftVelT, this.velocity);

    // Quadratic braking: v*(r) = min(V_CAP, √(2·A_BRAKE·posErr))
    // V_CAP = actual launch speed so the arm COASTS, never accelerates beyond spring speed
    const posErrM = dist / M;
    const effectiveVCap = this._launchSpeedMps || DAP_T.V_CAP;
    const aBrakeT = DAP_T.MAX_ACCEL * DAP_T.BRAKE_FRACTION;
    const vStarMT = Math.min(effectiveVCap, Math.sqrt(2 * aBrakeT * posErrM));
    const vStarT = vStarMT * M; // scene units/s

    // Velocity control error = goalDir × v* + relV
    const goalDirT = _goalDir.copy(toTarget).normalize();
    const velCtrlErrT = goalDirT.multiplyScalar(vStarT).add(relVT);

    // Commanded impulse = KP × velCtrlErr, clamped by MAX_ACCEL × gameDt
    const dvCmdT = velCtrlErrT.multiplyScalar(DAP_T.KP_VEL);
    const gameDtT = dt * Constants.TIME_SCALE_GAMEPLAY;
    const maxDvT = DAP_T.MAX_ACCEL * M * gameDtT;
    const dvMagT = dvCmdT.length();
    if (dvMagT > maxDvT && dvMagT > 1e-18) dvCmdT.multiplyScalar(maxDvT / dvMagT);

    // Apply thrust impulse (NOT lerp — direct impulse like mother autopilot)
    this.velocity.add(dvCmdT);
    this.position.addScaledVector(this.velocity, dt);

    // Close enough for fine approach — threshold must be >= standoff distance
    // so APPROACH controller has room to decelerate before reaching standoff.
    const debrisSizeT = (this.target && this.target.sizeMeter) || 1;
    const standoffT = Math.max(
      Constants.STATION_KEEP.DEFAULT_STANDOFF,
      Math.min(Constants.STATION_KEEP.MAX_STANDOFF, debrisSizeT * Constants.STATION_KEEP.DEFAULT_STANDOFF_MULT)
    );
    const approachThreshold = Math.max(standoffT * 2, this.config.bodyDims[2] * 15) * M;
    if (dist < approachThreshold) {
      this._transitionTo(S.APPROACH);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Beginning final approach`,
        priority: 'info',
      });
    }
  }

  /** APPROACH: fine approach — slower, match velocity */
  _updateApproach(dt, parentPos) {
    if (this._manualMode) {
      // Manual mode: coast with current velocity. Autopilot (proportional
      // controller, approach pings, thruster audio) intentionally skipped
      // to suppress annoying beep/hum in ARM_PILOT mode.
      this.position.addScaledVector(this.velocity, dt);
      if (parentPos) {
        this.tetherLength = this.position.distanceTo(parentPos) / M;
        if (!this.isDetached && this.tetherLength > this.config.tetherMax) {
          const dir = _tetherDir.subVectors(this.position, parentPos).normalize();
          this.position.copy(parentPos).add(dir.multiplyScalar(this.config.tetherMax * M));
          const velAlongTether = this.velocity.dot(dir);
          if (velAlongTether > 0) {
            this.velocity.addScaledVector(dir, -velAlongTether);
          }
        }
      }
      // ── STILL CHECK SK GATE even in manual mode ──
      // enableManual() fires during LAUNCH_CEREMONY_COMPLETE while the arm
      // is still in APPROACH. Without this gate the arm coasts through the
      // debris and never enters STATION_KEEP.
      // Distance-only check (no velocity gate): manual mode skips the
      // proportional braking controller, so the arm arrives at high velocity.
      // The SK lerp (0.8/frame) converges in ~3 frames — imperceptible.
      if (this.target) {
        const _tPos = this._getTargetScenePos();
        if (_tPos) {
          const _distM = _tPos.distanceTo(this.position) / M;
          const _dSz = (this.target.sizeMeter) || 1;
          const _so = Math.max(Constants.STATION_KEEP.DEFAULT_STANDOFF,
            Math.min(Constants.STATION_KEEP.MAX_STANDOFF,
              _dSz * Constants.STATION_KEEP.DEFAULT_STANDOFF_MULT));
          const _gateDist = _so * (Constants.STATION_KEEP.ENTRY_DISTANCE_MULT || 2.0);
          if (_distM <= _gateDist) {
            this._transitionTo(S.STATION_KEEP);
            this._stationKeepTarget = this.target;
            if (this.target) this.target._isStationKeepTarget = true;
            // Enter at actual arrival distance, ease to nominal (same as autopilot
            // path) so the position lerp doesn't snap the camera. Manual mode skips
            // braking so _distM can be well outside the band — settling matters most here.
            this._standoffR = _distM;
            this._standoffTargetR = _so;
            this._standoffSettling = true;
            this._initSkFrame(_tPos);
            // Use accumulated drift if available (from TRANSIT before manual)
            const _drift = this._smoothDriftVel;
            if (_drift && _drift.lengthSq() > 0) {
              this.velocity.copy(_drift);
            } else {
              this.velocity.set(0, 0, 0);
            }
            eventBus.emit(Events.STATION_KEEP_ENTERED, {
              armId: this.id,
              armType: this.type,
              armIndex: this.index,
              targetId: this.target.id || this.target.catalogId,
              standoffR: _so,
              isPiloted: this.isManual(),
            });
            return;
          }
        }
      }
      return; // skip autopilot logic (pings, thruster audio, etc.)
    }

    const targetPos = this._getTargetScenePos();
    if (!targetPos) { this.recall(); return; }
    const toTarget = this._tmpVec.subVectors(targetPos, this.position);
    const dist = toTarget.length();

    // Phase 8: Emit approach ping (in APPROACH, distance fraction is always low)
    if (this._startingDistance > 0) {
      const distFraction = Math.min(1, dist / this._startingDistance);
      eventBus.emit(Events.ARM_APPROACH_PING, { distanceFraction: distFraction, armId: this.id });
    }

    // ── Proportional controller with standoff-aware braking ──
    // Same control law as TRANSIT but v* brakes to standoff distance (not zero).
    const DAP_A = Constants.DAUGHTER_AUTOPILOT;

    // Standoff distance
    const debrisSize = (this.target && this.target.sizeMeter) || 1;
    const standoff = Math.max(
      Constants.STATION_KEEP.DEFAULT_STANDOFF,
      Math.min(Constants.STATION_KEEP.MAX_STANDOFF, debrisSize * Constants.STATION_KEEP.DEFAULT_STANDOFF_MULT)
    );
    const distMetres = dist / M;

    // Orbital drift velocity — EMA-smoothed (shared with TRANSIT via _smoothDriftVel)
    let rawDriftVelA = _driftRaw.set(0, 0, 0);
    const targetScenePos = this._getTargetScenePos();
    if (targetScenePos && this._prevTargetScenePos && this._prevParentPos && parentPos && dt > 0) {
      const tDelta = _driftTDelta.subVectors(targetScenePos, this._prevTargetScenePos);
      const pDelta = _driftPDelta.subVectors(parentPos, this._prevParentPos);
      rawDriftVelA = tDelta.sub(pDelta).divideScalar(dt);
    }
    if (targetScenePos) {
      if (!this._prevTargetScenePos) this._prevTargetScenePos = targetScenePos.clone();
      else this._prevTargetScenePos.copy(targetScenePos);
    }

    // EMA-smooth the drift velocity (continues from TRANSIT's accumulation)
    if (!this._smoothDriftVel) this._smoothDriftVel = new THREE.Vector3(0, 0, 0);
    const alphaA = DAP_A.DRIFT_EMA_ALPHA || 0.1;
    this._smoothDriftVel.lerp(rawDriftVelA, alphaA);
    const driftVelA = this._smoothDriftVel;

    // Velocity error
    const relVA = _relVel.subVectors(driftVelA, this.velocity);

    // Signed excess distance: positive = outside standoff, negative = inside
    // Inside standoff → restoring spring pushes arm back OUT (fixes no-retreat bug)
    const signedExcess = distMetres - standoff;
    const absExcess = Math.abs(signedExcess);
    const aBrakeA = DAP_A.MAX_ACCEL * DAP_A.BRAKE_FRACTION;
    const vStarMA = Math.min(DAP_A.V_CAP * 0.3, Math.sqrt(2 * aBrakeA * absExcess));
    const vStarA = vStarMA * M;

    // Velocity control error + commanded impulse
    // goalDir toward target when outside standoff; AWAY from target when inside
    const goalDirA = _goalDir.copy(toTarget).normalize();
    // approach: drive toward target (+vStarA); retreat: drive away (−vStarA)
    const posCmd = _posCmd.copy(goalDirA).multiplyScalar(signedExcess >= 0 ? vStarA : -vStarA);
    const velCtrlErrA = posCmd.add(relVA);
    const dvCmdA = velCtrlErrA.multiplyScalar(DAP_A.KP_VEL);
    const gameDtA = dt * Constants.TIME_SCALE_GAMEPLAY;
    const maxDvA = DAP_A.MAX_ACCEL * M * gameDtA;
    const dvMagA = dvCmdA.length();
    if (dvMagA > maxDvA && dvMagA > 1e-18) dvCmdA.multiplyScalar(maxDvA / dvMagA);

    this.velocity.add(dvCmdA);
    this.position.addScaledVector(this.velocity, dt);

    // ── Epic 8: Check for STATION_KEEP entry before netting ──
    if (this.target && !this._manualMode) {
      // Relative velocity to TARGET using EMA-smoothed drift (not raw — avoids noise).
      // At steady state, arm.velocity ≈ smoothDriftVel, so relVelToTarget → 0.
      const relVel = this.velocity.distanceTo(driftVelA) / M;

      // SK entry gate — distance + velocity thresholds.  Both are constants
      // so they can be tuned without code changes (debug session 2026-05-09:
      // distance widened 1.3→2.0×, velocity 2.0→3.0 m/s after observing arms
      // parking at dist=17m / relV=1.9m/s, which were JUST outside the old
      // 13m / 2.0m/s gate so SK never triggered).
      const _SK_DIST_MULT = Constants.STATION_KEEP.ENTRY_DISTANCE_MULT;
      const _SK_GATE_DIST = standoff * _SK_DIST_MULT;
      const _SK_GATE_VEL  = Constants.STATION_KEEP.ENTRY_MAX_VELOCITY;

      if (distMetres <= _SK_GATE_DIST && relVel < _SK_GATE_VEL) {
        this._transitionTo(S.STATION_KEEP);
        this._stationKeepTarget = this.target;
        // Mark debris so DebrisField LOD won't scale it to 0 when mother orbits far away
        if (this.target) this.target._isStationKeepTarget = true;
        // Enter at the ACTUAL arrival distance and ease in to the nominal
        // standoff (see _updateStationKeep settle block + STANDOFF_SETTLE_TAU_S).
        // The gate fires at up to 2× standoff while still closing, so setting
        // _standoffR = standoff here would make the 0.8/frame position lerp snap
        // the whole gap in ~3 frames and jerk the welded pilot camera.
        this._standoffR = distMetres;
        this._standoffTargetR = standoff;
        this._standoffSettling = true;

        // Capture the frozen entry frame so arrow keys map cleanly to
        // screen-axes (left/right = pure horizontal screen motion, up/down =
        // pure vertical, no tilt or roll regardless of orbit inclination).
        // _initSkFrame establishes _skPolarAxis / _skEquator0 / _skRightVec /
        // _skPitch0 from current geometry; θ and φ start at 0 (= entry pose).
        const _skTargetPos = this._getTargetScenePos();
        this._initSkFrame(_skTargetPos);
        // Initialize velocity to the EMA-smoothed orbital drift (debris frame
        // velocity), NOT zero.  STATION_KEEP uses lerp positioning, but the
        // parent-frame correction in update() shifts the daughter by mother's
        // delta each frame.  If velocity were zeroed, the daughter would lag
        // the debris by mother's drift each frame and the lerp would have to
        // continuously chase.  Setting velocity = drift means the daughter is
        // already co-moving with the debris on entry — the lerp only has to
        // correct sub-frame position errors, not velocity errors.
        // (driftVelA is in scene units / second; this.velocity is too.)
        if (driftVelA && driftVelA.lengthSq() > 0) {
          this.velocity.copy(driftVelA);
        } else {
          this.velocity.set(0, 0, 0);
        }
        eventBus.emit(Events.STATION_KEEP_ENTERED, {
          armId: this.id,
          armType: this.type,
          armIndex: this.index,
          targetId: this.target.id || this.target.catalogId,
          standoffR: standoff,
          isPiloted: this.isManual(),
        });
        return;
      }
    }

    // Close enough for net deployment
    const netThreshold = this.config.bodyDims[2] * M * 5;
    if (dist < netThreshold) {
      this._transitionTo(S.NETTING);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Deploying ${this.config.netSize}m net`,
        priority: 'info',
      });
    }
  }

  // =========================================================================
  // STATION_KEEP — orbital-crane hold position around debris (Epic 8)
  // =========================================================================

  /** STATION_KEEP: hold spherical orbit around target debris */
  _updateStationKeep(dt) {
    const SK = Constants.STATION_KEEP;
    const target = this._stationKeepTarget;

    // Ensure mesh stays visible during STATION_KEEP
    this.mesh.visible = true;

    // If target lost, exit — check _scenePosition (instanced debris have no .mesh)
    if (!target || (!target._scenePosition && !target.mesh)) {
      this._exitStationKeep('lost');
      return;
    }

    // Phase 1b (capture-feedback overhaul): live odds refresh at REFRESH_HZ.
    // The displayed value eases toward this truth in DockingReticle — this is
    // the "watch the odds climb while de-spinning" feedback loop.
    if (Constants.isFeatureEnabled('DAUGHTER_MULTITOOL')) {
      this._toolOddsTimer += dt;
      const interval = 1 / ((Constants.TOOL_ODDS && Constants.TOOL_ODDS.REFRESH_HZ) || 10);
      if (this._toolOddsTimer >= interval) {
        this._toolOddsTimer = 0;
        this._refreshToolOdds();
      }
      // Phase 3c: MAGNET secondary — eddy-current detumble on conductive targets.
      this._updateEddyDamp(dt, target);
    }

    // Update spherical coordinates from input rates
    this._orbitTheta += this._thetaRate * dt;
    this._orbitPhi += this._phiRate * dt;
    this._standoffR += this._radiusRate * dt;

    // ── Standoff settle-in (smooth SK entry) ──
    // On entry _standoffR is the ACTUAL arrival distance (often well outside the
    // nominal standoff because the SK gate fires at ENTRY_DISTANCE_MULT × standoff
    // while the daughter is still closing). Ease it down to the nominal target so
    // the goal recedes inward smoothly instead of letting the 0.8/frame position
    // lerp snap the whole gap in ~3 frames (which jerks the welded pilot camera).
    // Any pilot radius input cancels the settle and hands over manual control.
    if (this._standoffSettling) {
      if (Math.abs(this._radiusRate) > 1e-4) {
        // Pilot took manual radius control. Hand over, but if the daughter is
        // still outside the band keep easing inward (target = _rMax) so the
        // clamp below can't snap an out-of-band radius down in a single frame.
        this._standoffTargetR = Math.min(this._standoffR, this._rMax);
        this._standoffSettling = this._standoffR > this._rMax;
      } else {
        const tauR = SK.STANDOFF_SETTLE_TAU_S || 0.6;
        const kR = 1 - Math.exp(-dt / tauR);
        this._standoffR += (this._standoffTargetR - this._standoffR) * kR;
        if (Math.abs(this._standoffR - this._standoffTargetR) < 0.05) {
          this._standoffR = this._standoffTargetR;
          this._standoffSettling = false;
        }
      }
    }

    // ── Pattern-C auto-return (dwell-then-ease) ──
    // Pilot-friendly recovery: daughter holds her position for a quiet window
    // after the pilot releases the arrows, THEN gently eases back toward the
    // entry pose.  Any new arrow input cancels the ease and resets the dwell.
    const _hasInput = Math.abs(this._thetaRate) > 1e-4
                   || Math.abs(this._phiRate) > 1e-4
                   || Math.abs(this._radiusRate) > 1e-4;
    if (_hasInput) {
      // Any pilot input → cancel auto-return entirely, reset the dwell clock
      this._skIdleS = 0;
    } else {
      this._skIdleS = (this._skIdleS || 0) + dt;
      // Idle but inside dwell window: hold position. Idle past dwell: ease back.
      const dwell = SK.AUTO_RETURN_DWELL_S || 3.0;
      const tauSlow = SK.AUTO_RETURN_TIME_CONSTANT_S || 4.0;
      let tau = null;
      if (this._skIdleS >= dwell) {
        tau = tauSlow;
      }
      if (tau !== null) {
        const k = 1 - Math.exp(-dt / tau);
        this._orbitTheta += (0 - this._orbitTheta) * k;
        this._orbitPhi   += (0 - this._orbitPhi)   * k;
        // Dead-zone snap so we don't asymptote forever.
        const deadRad = (SK.AUTO_RETURN_DEADZONE_DEG || 2.0) * Math.PI / 180;
        if (Math.abs(this._orbitTheta) < deadRad && Math.abs(this._orbitPhi) < deadRad) {
          this._orbitTheta = 0;
          this._orbitPhi   = 0;
        }
      }
    }

    // Clamp phi delta to pitch swing limit (re-using MAX_LATITUDE -
    // TETHER_SAFETY_MARGIN as the half-angle).  Same physical meaning as
    // before: prevents the pilot from pitching so far the daughter goes
    // behind the debris or wraps the tether vertically.
    const phiLimit = this._phiMax - (SK.TETHER_SAFETY_MARGIN * Math.PI / 180);
    this._orbitPhi = Math.max(-phiLimit, Math.min(phiLimit, this._orbitPhi));

    // ── Clamp θ delta around entry (tether-tangle + disorientation safety) ──
    // In the frozen entry frame θ is always measured from 0, so the clamp is
    // a simple ±THETA_LIMIT_DEG.  Prevents the pilot from winding the
    // daughter all the way around the debris (tether wrap = critical failure)
    // and from rotating past the mother's peripheral view (disorientation).
    const thetaLimitRad = (SK.THETA_LIMIT_DEG || 120) * Math.PI / 180;
    this._orbitTheta = Math.max(-thetaLimitRad, Math.min(thetaLimitRad, this._orbitTheta));

    // Clamp radius. While settling-in from a wide SK entry the arrival distance
    // can exceed _rMax — only enforce the lower bound so the ease can bring it
    // down through the band; once settled the normal [_rMin,_rMax] clamp holds.
    if (this._standoffSettling) {
      this._standoffR = Math.max(this._rMin, this._standoffR);
    } else {
      this._standoffR = Math.max(this._rMin, Math.min(this._rMax, this._standoffR));
    }

    // Target position in scene coordinates — use _scenePosition (orbit-propagated)
    // not mesh.position which may be stale or floating-origin-adjusted for instanced debris
    const targetPos = target._scenePosition || (target.mesh && target.mesh.position);
    if (!targetPos) {
      this._exitStationKeep('lost');
      return;
    }

    // Lazy-init entry frame if missing (e.g. unit tests that set _orbitTheta
    // directly without going through the SK entry transition).
    if (!this._skPolarAxis) this._initSkFrame(targetPos);

    // ── Compute goal position in the frozen entry frame ──
    // yaw   = rotation around _skPolarAxis (screen-up at entry)
    // pitch = rotation around the rotated _skRightVec (screen-right at entry)
    // Effect for the pilot:
    //   ← / →  rotate purely horizontally in screen space, no tilt
    //   ↑ / ↓  rotate purely vertically   in screen space, no tilt
    const _yaw = this._orbitTheta;
    const _totalPitch = this._skPitch0 + this._orbitPhi;
    const _cosY = Math.cos(_yaw), _sinY = Math.sin(_yaw);
    const _cosP = Math.cos(_totalPitch), _sinP = Math.sin(_totalPitch);
    const _eqX = this._skEquator0.x * _cosY + this._skRightVec.x * _sinY;
    const _eqY = this._skEquator0.y * _cosY + this._skRightVec.y * _sinY;
    const _eqZ = this._skEquator0.z * _cosY + this._skRightVec.z * _sinY;
    const _ox  = _eqX * _cosP + this._skPolarAxis.x * _sinP;
    const _oy  = _eqY * _cosP + this._skPolarAxis.y * _sinP;
    const _oz  = _eqZ * _cosP + this._skPolarAxis.z * _sinP;
    const _Rscene = this._standoffR * M;
    const goalX = targetPos.x + _ox * _Rscene;
    const goalY = targetPos.y + _oy * _Rscene;
    const goalZ = targetPos.z + _oz * _Rscene;

    // Lerp world position to goal (group.position synced from this.position in update())
    const lerp = SK.STATIONKEEP_LERP_RATE;
    this.position.x += (goalX - this.position.x) * lerp;
    this.position.y += (goalY - this.position.y) * lerp;
    this.position.z += (goalZ - this.position.z) * lerp;

    // Consume fuel — more when maneuvering
    const isManeuver = Math.abs(this._thetaRate) > 0.01 ||
                       Math.abs(this._phiRate) > 0.01 ||
                       Math.abs(this._radiusRate) > 0.01;
    const fuelRate = isManeuver ? SK.FUEL_RATE_MANEUVER : SK.FUEL_RATE_STATIONKEEP;
    this.fuel -= fuelRate * dt;

    // Fuel depleted → exit
    if (this.fuel <= 0) {
      this.fuel = 0;
      this._exitStationKeep('fuel');
      return;
    }

    // Reset rates each frame (they're set by input events)
    this._thetaRate = 0;
    this._phiRate = 0;
    this._radiusRate = 0;
  }

  /**
   * @private Initialise the frozen SK entry frame so arrow keys map to
   * screen-aligned yaw/pitch.
   *
   * Establishes an orthonormal triad at the moment the daughter parks at
   * the debris:
   *   _skPolarAxis  — Earth-radial at the debris (camera-up).  Aligns the
   *                   game's "up" with the player's "up" regardless of
   *                   orbit inclination, so the screen never rolls during
   *                   sweep.
   *   _skEquator0   — direction from debris→arm projected perpendicular to
   *                   the polar axis (the entry "forward in the equator
   *                   plane").  θ=0 reproduces the arrival pose.
   *   _skRightVec   — equator0 × polarAxis = camera-right at entry.
   *                   +θ moves the daughter in this direction so → arrow
   *                   key produces pure screen-right motion.
   *   _skPitch0     — the entry pose's pitch angle from the equator plane;
   *                   added to φ when computing the final pose so the
   *                   daughter does not snap if she arrived above/below
   *                   the equator.
   * @param {THREE.Vector3} targetPos — debris _scenePosition (scene units)
   */
  _initSkFrame(targetPos) {
    if (!targetPos) {
      // Degenerate — leave defaults so SK can still run with world axes
      this._skPolarAxis = new THREE.Vector3(0, 1, 0);
      this._skEquator0  = new THREE.Vector3(1, 0, 0);
      this._skRightVec  = new THREE.Vector3(0, 0, 1);
      this._skPitch0    = 0;
      this._orbitTheta  = 0;
      this._orbitPhi    = 0;
      return;
    }

    const debrisToArm = new THREE.Vector3(
      this.position.x - targetPos.x,
      this.position.y - targetPos.y,
      this.position.z - targetPos.z,
    );
    if (debrisToArm.lengthSq() < 1e-20) {
      // Co-located — pick world axes as a degenerate fallback
      this._skPolarAxis = targetPos.clone().normalize();
      if (this._skPolarAxis.lengthSq() < 1e-12) this._skPolarAxis.set(0, 1, 0);
      this._skEquator0  = new THREE.Vector3(1, 0, 0);
    } else {
      debrisToArm.normalize();
      this._skPolarAxis = targetPos.clone();
      if (this._skPolarAxis.lengthSq() < 1e-12) this._skPolarAxis.set(0, 1, 0);
      this._skPolarAxis.normalize();
      const dotP = debrisToArm.dot(this._skPolarAxis);
      // equator0 = debrisToArm projected onto plane perpendicular to polar
      this._skEquator0 = debrisToArm.clone()
        .sub(this._skPolarAxis.clone().multiplyScalar(dotP));
      if (this._skEquator0.lengthSq() < 1e-8) {
        // Edge case: arm directly above/below the polar pole — fall back to
        // an arbitrary perpendicular vector
        const _alt = Math.abs(this._skPolarAxis.x) < 0.9
          ? new THREE.Vector3(1, 0, 0)
          : new THREE.Vector3(0, 1, 0);
        this._skEquator0 = _alt.sub(
          this._skPolarAxis.clone().multiplyScalar(_alt.dot(this._skPolarAxis))
        );
      }
      this._skEquator0.normalize();
      this._skPitch0 = Math.asin(Math.max(-1, Math.min(1, dotP)));
    }
    // right = equator0 × polar (camera-right at entry, so +yaw → screen-right)
    this._skRightVec = new THREE.Vector3()
      .crossVectors(this._skEquator0, this._skPolarAxis).normalize();
    this._orbitTheta = 0;
    this._orbitPhi   = 0;
  }

  /** @private Exit STATION_KEEP and transition to RETURNING */
  _exitStationKeep(reason) {
    eventBus.emit(Events.STATION_KEEP_EXITED, {
      armId: this.id,
      reason: reason,
    });
    // Clear LOD protection flag so normal LOD applies again
    if (this._stationKeepTarget) this._stationKeepTarget._isStationKeepTarget = false;
    this._stationKeepTarget = null;
    // Phase 3c: stop eddy damping + clear the target's HUD flags
    // (_despinning is safe to clear — DespinLaser re-asserts it each frame)
    if (this._eddyTarget) {
      this._eddyTarget._eddyDamping = false;
      this._eddyTarget._despinning = false;
    }
    this._eddyTarget = null;
    this._eddyActive = false;
    this._thetaRate = 0;
    this._phiRate = 0;
    this._radiusRate = 0;
    this._standoffSettling = false;
    // Release the frozen entry frame so the next SK entry captures fresh axes
    this._skPolarAxis = null;
    this._skEquator0  = null;
    this._skRightVec  = null;
    this._skPitch0    = 0;
    this._skIdleS     = 0;
    this._transitionTo(S.RETURNING);
  }

  /** Public: Capture debris from STATION_KEEP → NETTING */
  captureFromStationKeep() {
    if (this.state !== S.STATION_KEEP) return false;

    // §13 Q5: Net inventory gate — when CAPTURE_NET is ON and nets exhausted,
    // emit NET_EMPTY_CLICK + click-fail audio + comms message instead of
    // transitioning.  2026-05-28 (Item 8): the prior implementation only
    // emitted NET_EMPTY_CLICK with no user-visible feedback beyond a click-
    // fail sfx — players couldn't tell why F did nothing.  Add a CMD-channel
    // comms message so the comms log explains the failure and points at the
    // remedy (return to mother for reload).
    if (Constants.isFeatureEnabled('CAPTURE_NET') && this._netInventory <= 0) {
      eventBus.emit(Events.NET_EMPTY_CLICK, { armId: this.id });
      audioSystem.playClickFail();
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: `${this.displayName}: No nets remaining. Return to mother for reload.`,
        channel: 'CMD',
        priority: 'warning',
      });
      return false;
    }

    eventBus.emit(Events.STATION_KEEP_EXITED, {
      armId: this.id,
      reason: 'capture',
    });

    // POLISH FIX: do NOT null _stationKeepTarget here — keeping the reference
    // live during NETTING means our miss-fallback (NETTING → STATION_KEEP) can
    // resume cleanly.  Previously this line was the cause of repeated capture
    // failures: net misses, we fell back to SK, but _stationKeepTarget was
    // already null → SK exited as "lost" → daughter returned home empty.
    // The LOD protection flag also stays on during NETTING (the debris is
    // still the focus of the active capture operation).  Both fields are
    // cleared on _exitStationKeep / recallFromStationKeep / reelFromStationKeep
    // / successful capture (GRAPPLED entry doesn't need them).
    //
    // Issue-B GUARD: snapshot the committed target so the NETTING-FSM
    // miss-fallback can detect "target removed mid-net-flight" and bail out
    // to RETURNING instead of looping back into SK with a stale reference.
    // We also mark the debris itself so DebrisField.removeDebris() can warn
    // when something nukes a debris that has a net committed to it.
    this._netCommittedTarget = this.target || null;
    if (this._netCommittedTarget) {
      this._netCommittedTarget._committedNetArmId = this.id;
    }
    this._captureToolKind = 'NET';
    this._transitionTo(S.NETTING);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: Deploying net. Stand by for capture`,
      priority: 'info',
    });
    return true;
  }

  /** Public: Recall arm from STATION_KEEP → RETURNING (FEEP-powered) */
  recallFromStationKeep() {
    if (this.state !== S.STATION_KEEP) return false;
    this._exitStationKeep('recall');
    return true;
  }

  /** Public: Reel arm from STATION_KEEP → REELING (zero-fuel strut motor).
   *  Use when daughter is out of fuel/nets or player wants to abort without
   *  burning FEEP. The mothership's strut reel motor pulls the daughter back
   *  via tether — no propellant cost.
   */
  reelFromStationKeep() {
    if (this.state !== S.STATION_KEEP) return false;
    eventBus.emit(Events.STATION_KEEP_EXITED, {
      armId: this.id,
      reason: 'reel',
    });
    if (this._stationKeepTarget) this._stationKeepTarget._isStationKeepTarget = false;
    this._stationKeepTarget = null;
    this._thetaRate = 0;
    this._phiRate = 0;
    this._radiusRate = 0;
    this._skPolarAxis = null;
    this._skEquator0  = null;
    this._skRightVec  = null;
    this._skPitch0    = 0;
    this._skIdleS     = 0;
    this._transitionTo(S.REELING);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: Reeling in. Strut motor engaged`,
      priority: 'info',
    });
    return true;
  }

  // ============================================================================
  // DAUGHTER MULTI-TOOL (CP-1 / P2 — DAUGHTER_MULTITOOL_SPEC §5 / §7 / §8)
  // ============================================================================

  /**
   * Recompute the per-arm tool recommendation for the current STATION_KEEP
   * target and default `selectedTool` to the top-scored verb. Stores ★ scores
   * and hint strings the SK tool-selection HUD reads directly off this arm.
   * @private
   */
  _refreshToolRecommendation() {
    const target = this._stationKeepTarget || this.target;
    const netDepleted = (typeof this.getNetInventory === 'function')
      ? this.getNetInventory() <= 0
      : (this._netInventory <= 0);
    const rec = recommendArmTool({
      armType: this.type,
      mass: target ? (target.mass || 0) : 0,
      sizeMeter: target ? (target.sizeMeter || 0) : 0,
      debrisType: target ? (target.type || null) : null,
      ferromagnetic: !!(target && target.ferromagnetic === true),
      hasFerrousFasteners: !!(target && target.hasFerrousFasteners === true),
      hasGrappleFixture: !!(target && target.hasGrappleFixture === true),
      netDepleted,
    });
    this.selectedTool = rec.recommended;
    this._refreshToolOdds();               // Phase 1b: seed the odds strip immediately
    eventBus.emit(Events.TOOL_ARMSET_CHANGED, { armId: this.id, toolset: this.toolset.slice() });
    eventBus.emit(Events.TOOL_SELECTED, { armId: this.id, tool: this.selectedTool });
  }

  /**
   * @private Phase 1b (capture-feedback overhaul): recompute the live tool
   * odds for the odds strip. Called on SK entry and at TOOL_ODDS.REFRESH_HZ
   * from _updateStationKeep — the same pure model the resolve rolls use, so
   * de-spinning / closing in visibly moves the numbers ("honest numbers").
   */
  _refreshToolOdds() {
    const target = this._stationKeepTarget || this.target;
    const range = (typeof this._standoffR === 'number' && this._standoffR > 0)
      ? this._standoffR : 50;
    const netCount = (typeof this.getNetInventory === 'function')
      ? this.getNetInventory() : (this._netInventory ?? undefined);
    // Phase 2 (ASPECT_CAPTURE): live presented width along the current
    // approach bearing — the NET % dips/rises as θ sweeps or as the pilot
    // orbits toward end-on.
    let presentedWidthM;
    if (Constants.isFeatureEnabled('ASPECT_CAPTURE') && target
        && target._scenePosition && this.position) {
      const tp = target._scenePosition;
      presentedWidthM = presentedWidthForApproach(target, {
        x: tp.x - this.position.x,
        y: tp.y - this.position.y,
        z: tp.z - this.position.z,
      });
    }
    const odds = computeToolOdds({
      armType: this.type,
      toolset: this.toolset,
      target,
      range,
      netCount,
      padUvDoses: this._padUvCureDosesRemaining,
      presentedWidthM,
    });
    this._toolOdds = odds;
    // Pre-fire FRAG risk for the ⚠FRAG chip (same computeFragRisk the resolve
    // computes at _resolveCatch; Phase 3b rolls it).
    if (target) {
      const netClass = getNetClassForType(this.type);
      this._toolOddsFragRisk = computeFragRisk({
        netMass: netClass.MASS,
        vRel: netClass.LAUNCH_SPEED,
        targetFragility: effectiveFragility(target),
        range,
      });
    } else {
      this._toolOddsFragRisk = 0;
    }
  }

  /**
   * @private Phase 3c (capture-feedback overhaul): eddy-current detumble —
   * the MAGNET's rotating field induces eddy currents in a CONDUCTIVE hull and
   * bleeds tumble at ~⅓ of the mother laser's rate, ≤ EDDY_DAMP.RANGE_M. Runs
   * passively while station-keeping with MAGNET selected (no new key). Counts
   * toward DESPIN_IN_SPEC so the "tumble in spec — net it" loop closes the
   * same way as the laser.
   * @param {number} dt
   * @param {object|null} target — the STATION_KEEP target
   */
  _updateEddyDamp(dt, target) {
    const ED = Constants.EDDY_DAMP;
    const conductive = !!(ED && target
      && Array.isArray(ED.CONDUCTIVE_MATERIALS)
      && ED.CONDUCTIVE_MATERIALS.includes(target.material));
    const active = conductive
      && this.selectedTool === 'MAGNET'
      && (target.tumbleRate || 0) > 0
      && (typeof this._standoffR === 'number' && this._standoffR <= (ED.RANGE_M || 30));

    if (!active) {
      if (this._eddyActive) {
        this._eddyActive = false;
        if (this._eddyTarget) {
          this._eddyTarget._eddyDamping = false;
          // Also clear the shared HUD hint — the laser re-asserts it every
          // frame while firing, so this never fights an active despin beam.
          this._eddyTarget._despinning = false;
        }
        this._eddyTarget = null;
      }
      return;
    }

    if (!this._eddyActive) {
      this._eddyActive = true;
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: `${this.displayName}: Eddy-current damping engaged. EPM field bleeding tumble (${target.material} hull).`,
        channel: 'CMD', priority: 'info',
      });
    }
    if (this._eddyTarget && this._eddyTarget !== target) this._eddyTarget._eddyDamping = false;
    this._eddyTarget = target;
    target._eddyDamping = true;
    target._despinning = true;   // shared HUD hint (live °/s readouts)

    const before = target.tumbleRate || 0;
    const after = Math.max(0, before - (ED.DESPIN_RATE_RAD_S2 || 0.1) * dt);
    target.tumbleRate = after;

    // Crossed below the net-safe spin → announce once (same loop as the laser).
    const inSpecRad = ((Constants.DESPIN_LASER && Constants.DESPIN_LASER.IN_SPEC_DEG) || 10) * Math.PI / 180;
    if (before > inSpecRad && after <= inSpecRad) {
      eventBus.emit(Events.DESPIN_IN_SPEC, { targetId: target.id ?? null, tumbleDeg: after * 180 / Math.PI });
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: `${this.displayName}: Tumble in spec. Net it.`,
        channel: 'CMD', priority: 'success',
      });
    }
  }

  /** Cycle `selectedTool` through this arm's toolset (` ` ` backtick in SK). */
  cycleTool() {
    if (!this.toolset || this.toolset.length <= 1) return this.selectedTool;
    const i = this.toolset.indexOf(this.selectedTool);
    const next = this.toolset[(i + 1) % this.toolset.length];
    this.selectedTool = next;
    audioSystem.playClick();
    eventBus.emit(Events.TOOL_SELECTED, { armId: this.id, tool: next });
    return next;
  }

  /** Programmatically select a tool (must be in the arm's toolset). */
  setTool(kind) {
    if (this.toolset && this.toolset.includes(kind)) {
      this.selectedTool = kind;
      eventBus.emit(Events.TOOL_SELECTED, { armId: this.id, tool: kind });
      return true;
    }
    return false;
  }

  /**
   * Dispatch the currently-selected tool from STATION_KEEP (the F key, when
   * DAUGHTER_MULTITOOL is ON). NET → the P1 net path; MAGNET → the P2 EPM
   * grapple; GRIPPER/PAD → graceful "offline" until P3/P4 land.
   * @returns {boolean} true if a dispatch occurred
   */
  dispatchSelectedTool() {
    if (this.state !== S.STATION_KEEP) return false;
    switch (this.selectedTool) {
      case 'MAGNET':  return this.magneticGrapple();
      case 'GRIPPER': return Constants.isFeatureEnabled('WEAVER_GRIPPER') ? this.gripperGrapple() : this._toolOffline('GRIPPER');
      case 'PAD':     return Constants.isFeatureEnabled('SPINNER_PAD')    ? this.padContact()    : this._toolOffline('PAD');
      case 'NET':
      default:        return this.captureFromStationKeep();
    }
  }

  /** @private Graceful feedback for a not-yet-equipped verb (P3/P4). */
  _toolOffline(kind) {
    audioSystem.playClickFail();
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: this.displayName,
      text: `${this.displayName}: ${kind} tool offline. Not yet equipped. Cycle (\`) to NET or MAGNET.`,
      channel: 'CMD',
      priority: 'warning',
    });
    return false;
  }

  /** @private Base grip probability for the magnetic EPM against a target. */
  _magnetGripProbability(target) {
    const MAG = Constants.MAGNETIC_GRAPPLE;
    if (!target || (target.mass || 0) > MAG.MAX_DEBRIS_MASS_KG) return 0;
    if (target.ferromagnetic === true) return MAG.P_GRIP_FERROUS;
    if (target.hasFerrousFasteners === true) return MAG.P_GRIP_FASTENERS;
    return MAG.P_GRIP_NON_FERROUS;
  }

  /**
   * Begin a magnetic-grapple attempt from STATION_KEEP (P2). Drives a small
   * sub-FSM (ENERGIZING → CLOSING → GRIP) in `_updateMagneticGrapple`. Emits
   * AUTOPILOT_TARGET_LOCK so CollisionAvoidance exempts the target while the
   * daughter deliberately closes within contact range (§5.1 gotcha).
   * @returns {boolean}
   */
  magneticGrapple() {
    if (this.state !== S.STATION_KEEP) return false;
    const target = this._stationKeepTarget || this.target;
    if (!target) { audioSystem.playClickFail(); return false; }

    eventBus.emit(Events.STATION_KEEP_EXITED, { armId: this.id, reason: 'magnet' });
    this._magPhase = 'ENERGIZING';
    this._magTimer = 0;
    this._captureToolKind = 'MAGNET';
    audioSystem.playMagnetic();
    // CA exemption during CLOSING (the arm intentionally drives < 0.5 m to the target).
    // The lock is released centrally on ANY exit from MAGNETIC_GRAPPLE (_transitionTo).
    this._toolLockedDebrisId = target.id;
    eventBus.emit(Events.AUTOPILOT_TARGET_LOCK, { debrisId: target.id });
    eventBus.emit(Events.MAGNETIC_GRIP_ATTEMPT, {
      armId: this.id, targetId: target.id, pBase: this._magnetGripProbability(target),
    });
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: this.displayName, text: `${this.displayName}: Energizing EPM. Closing for magnetic grapple`,
      channel: 'CMD', priority: 'info',
    });
    this._transitionTo(S.MAGNETIC_GRAPPLE);
    return true;
  }

  /** @private MAGNETIC_GRAPPLE sub-FSM: ENERGIZING → CLOSING → GRIP roll. */
  _updateMagneticGrapple(dt) {
    this._magTimer += dt;
    const MAG = Constants.MAGNETIC_GRAPPLE;
    const target = this._stationKeepTarget || this.target;

    // Target gone (removed / captured by another arm) → abort home.
    if (!target || target._captured || target.alive === false) {
      this._failMagneticGrip('standoff');
      return;
    }

    if (this._magPhase === 'ENERGIZING') {
      if (this._magTimer >= MAG.ENERGIZE_PULSE_S) {
        this._magPhase = 'CLOSING';
        this._magTimer = 0;
      }
      return;
    }

    if (this._magPhase === 'CLOSING') {
      const tPos = target._scenePosition;
      if (tPos) {
        this.position.lerp(tPos, Math.min(1, dt * 2.0));
        const distM = this.position.distanceTo(tPos) / M;
        if (distM <= MAG.CONTACT_RANGE_M) {
          this._magPhase = 'GRIP';
          this._magTimer = 0;
          return;
        }
      }
      if (this._magTimer >= MAG.CLOSE_TIMEOUT_S) this._failMagneticGrip('standoff');
      return;
    }

    if (this._magPhase === 'GRIP') {
      if (this._magTimer >= MAG.GRIP_DWELL_S) this._resolveMagnetGrip(target);
    }
  }

  /** @private Resolve the contact P_GRIP roll → GRAPPLED (success) or RETURNING (fail). */
  _resolveMagnetGrip(target) {
    if ((target.mass || 0) > Constants.MAGNETIC_GRAPPLE.MAX_DEBRIS_MASS_KG) {
      this._failMagneticGrip('too_heavy');
      return;
    }
    const ferrous = target.ferromagnetic === true || target.hasFerrousFasteners === true;
    if (!ferrous) {
      // Non-ferrous: residual-flux probability only — but tag the failure clearly.
      const pNF = Constants.MAGNETIC_GRAPPLE.P_GRIP_NON_FERROUS;
      const rollNF = (this._magRollOverride != null) ? this._magRollOverride : Math.random();
      if (rollNF >= pNF) { this._failMagneticGrip('non_ferrous'); return; }
    } else {
      const p = this._magnetGripProbability(target);
      // Test seam: `_magRollOverride` (0..1) forces a deterministic roll.
      const roll = (this._magRollOverride != null) ? this._magRollOverride : Math.random();
      if (roll >= p) { this._failMagneticGrip('p_roll'); return; }
    }

    // ── Grip acquired ── reuse the GRAPPLED → REELING lifecycle (net-integrity
    // is skipped for non-NET catches via the _captureToolKind guard).
    this._magPhase = null;
    eventBus.emit(Events.MAGNETIC_GRIP_ACQUIRED, {
      armId: this.id, targetId: target.id, mass: target.mass || 0,
    });
    this._secureToolCatch(target, 'MAGNET',
      `${this.displayName}: EPM grip secured. Magnetic latch holding. Reeling in.`);
  }

  /** @private Magnetic grip failed/aborted → release lock, return to reload. */
  _failMagneticGrip(reason) {
    const target = this._stationKeepTarget || this.target;
    this._magPhase = null;
    audioSystem.playClickFail();
    if (target) {
      eventBus.emit(Events.MAGNETIC_GRIP_FAILED, { armId: this.id, targetId: target.id, reason });
      eventBus.emit(Events.MAGNETIC_RELEASE, { armId: this.id, targetId: target.id });
    }
    const msg = reason === 'too_heavy'
      ? `${this.displayName}: Magnetic grapple failed. Target too massive for the EPM. Returning to reload.`
      : reason === 'non_ferrous'
        ? `${this.displayName}: No magnetic purchase. Target is non-ferrous. Returning; try the net.`
        : reason === 'standoff'
          ? `${this.displayName}: Lost contact on approach. Magnetic grapple aborted. Returning.`
          : `${this.displayName}: Magnetic grip slipped. Returning to reload. Re-attempt or try the net.`;
    eventBus.emit(Events.COMMS_MESSAGE, { source: this.displayName, text: msg, channel: 'CMD', priority: 'warning' });
    this._endToolFailure();
  }

  // ── Shared non-net catch plumbing (magnet / gripper / pad) ──────────────

  /**
   * @private Secure a non-net catch and hand off to the shared GRAPPLED →
   * REELING → park-the-catch lifecycle. Emits ARM_CAPTURED (tagged with the
   * tool) so scoring/teaching fire exactly as for a net catch.
   */
  _secureToolCatch(target, toolKind, successMsg) {
    this.capturedDebris = target;
    target._captured = true;
    target._capturedByArm = this;
    this._captureToolKind = toolKind;
    this._pinCatchToSelf();
    eventBus.emit(Events.ARM_CAPTURED, {
      armId: this.id, targetId: target.id, type: this.type,
      detached: this.isDetached, mass: target.mass || 0,
      debrisType: target.type || 'unknown', tool: toolKind,
      manual: this._manualCapture,
    });
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: this.displayName, text: successMsg, channel: 'CMD', priority: 'success',
    });
    this._transitionTo(S.GRAPPLED);  // _transitionTo releases the CA lock on exit
  }

  /** @private Shared cleanup tail for a failed/aborted non-net tool attempt. */
  _endToolFailure() {
    if (this._stationKeepTarget) this._stationKeepTarget._isStationKeepTarget = false;
    this._stationKeepTarget = null;
    this.target = null;
    this._captureToolKind = 'NET';
    this._transitionTo(S.RETURNING);  // _transitionTo releases the CA lock on exit
  }

  // ============================================================================
  // GRIPPER JAWS (P3 — WEAVER_GRIPPER)
  // ============================================================================

  /**
   * Begin a 3-jaw gripper grapple from STATION_KEEP (P3). Sub-FSM in
   * `_updateGripperGrapple`: EXTEND → SEEK (fixture raycast) → CLOSE → latch roll.
   * @returns {boolean}
   */
  gripperGrapple() {
    if (this.state !== S.STATION_KEEP) return false;
    if (!Constants.isFeatureEnabled('WEAVER_GRIPPER')) return this._toolOffline('GRIPPER');
    const target = this._stationKeepTarget || this.target;
    if (!target) { audioSystem.playClickFail(); return false; }

    eventBus.emit(Events.STATION_KEEP_EXITED, { armId: this.id, reason: 'gripper' });
    this._gripPhase = 'EXTEND';
    this._gripTimer = 0;
    this._captureToolKind = 'GRIPPER';
    audioSystem.playClick();   // servo click
    this._toolLockedDebrisId = target.id;
    eventBus.emit(Events.AUTOPILOT_TARGET_LOCK, { debrisId: target.id });
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: this.displayName, text: `${this.displayName}: Extending gripper jaws. Seeking a fixture`,
      channel: 'CMD', priority: 'info',
    });
    this._transitionTo(S.GRIPPER_GRAPPLE);
    return true;
  }

  /** @private GRIPPER_GRAPPLE sub-FSM: EXTEND → SEEK → CLOSE → latch roll. */
  _updateGripperGrapple(dt) {
    this._gripTimer += dt;
    const G = Constants.GRIPPER_GRAPPLE;
    const target = this._stationKeepTarget || this.target;
    if (!target || target._captured || target.alive === false) {
      this._failGripperGrip('no_fixture');
      return;
    }

    if (this._gripPhase === 'EXTEND') {
      if (this._gripTimer >= G.EXTEND_TIME_S) { this._gripPhase = 'SEEK'; this._gripTimer = 0; }
      return;
    }

    if (this._gripPhase === 'SEEK') {
      const tPos = target._scenePosition;
      if (tPos) this.position.lerp(tPos, Math.min(1, dt * 2.0));
      if (this._gripTimer >= G.SEEK_TIME_S) {
        const fixtured = target.hasGrappleFixture === true;
        eventBus.emit(Events.GRIPPER_LATCH_ATTEMPT, { armId: this.id, targetId: target.id, fixtured });
        this._gripPhase = 'CLOSE';
        this._gripTimer = 0;
      }
      return;
    }

    if (this._gripPhase === 'CLOSE') {
      if (this._gripTimer >= G.CLOSE_TIME_S) this._resolveGripperLatch(target);
    }
  }

  /** @private Resolve the gripper latch roll → GRAPPLED (success) or RETURNING (slip). */
  _resolveGripperLatch(target) {
    const G = Constants.GRIPPER_GRAPPLE;
    if ((target.mass || 0) > G.MAX_DEBRIS_MASS_KG) { this._failGripperGrip('oversize'); return; }
    const fixtured = target.hasGrappleFixture === true;
    const p = fixtured ? G.P_GRIP_FIXTURED : G.P_GRIP_UNFIXTURED;
    // Test seam: `_gripRollOverride` (0..1) forces a deterministic roll.
    const roll = (this._gripRollOverride != null) ? this._gripRollOverride : Math.random();
    if (roll >= p) { this._failGripperGrip(fixtured ? 'p_roll' : 'no_fixture'); return; }

    this._gripPhase = null;
    eventBus.emit(Events.GRIPPER_LATCHED, { armId: this.id, targetId: target.id });
    this._secureToolCatch(target, 'GRIPPER',
      `${this.displayName}: Gripper latched. Ratchet holding (zero-power). Reeling in.`);
  }

  /** @private Gripper slip/abort → release, return to reload. */
  _failGripperGrip(reason) {
    const target = this._stationKeepTarget || this.target;
    this._gripPhase = null;
    audioSystem.playClickFail();
    if (target) {
      eventBus.emit(Events.GRIPPER_SLIPPED, { armId: this.id, targetId: target.id, reason });
      eventBus.emit(Events.GRIPPER_RELEASED, { armId: this.id, targetId: target.id });
    }
    const msg = reason === 'oversize'
      ? `${this.displayName}: Gripper failed. Target beyond jaw mass limit. Returning to reload.`
      : reason === 'no_fixture'
        ? `${this.displayName}: Gripper found no fixture to grab. Returning; the net may suit this target.`
        : `${this.displayName}: Gripper slipped off the fixture. Returning to reload.`;
    eventBus.emit(Events.COMMS_MESSAGE, { source: this.displayName, text: msg, channel: 'CMD', priority: 'warning' });
    this._endToolFailure();
  }

  // ============================================================================
  // MULTI-MODAL PAD (P4 — SPINNER_PAD)
  // ============================================================================

  /**
   * Resolve the pad adhesion mode deterministically from target surface
   * metadata at contact (§5.3 priority). "The pad figures it out." Returns a
   * mode string or null (NO_MODE — e.g. exotic surface with UV doses spent).
   * @returns {string|null}
   */
  _resolvePadMode(target) {
    const material = target.material;
    const roughness = (typeof target.surfaceRoughness === 'number') ? target.surfaceRoughness : 0.5;
    if (material === 'steel' || material === 'iron_alloy') return 'magnet';
    if (material === 'mli_mylar' || roughness > 0.7) return 'hooks';
    if (material === 'aluminum' || material === 'kapton'
        || material === 'glass_ceramic' || material === 'solar_cell') return 'gecko';  // warm window assumed at Y0
    if (material === 'composite') return 'electrostatic';
    // Last resort — finite UV-cure magazine (§13 Q3): once spent, NO_MODE.
    if ((this._padUvCureDosesRemaining || 0) > 0) return 'uv_cure';
    return null;
  }

  /**
   * Begin a multi-modal pad contact from STATION_KEEP (P4). Sub-FSM in
   * `_updatePadContact`: APPROACH_SOFT → CONTACT (resolve mode) → grip roll.
   * @returns {boolean}
   */
  padContact() {
    if (this.state !== S.STATION_KEEP) return false;
    if (!Constants.isFeatureEnabled('SPINNER_PAD')) return this._toolOffline('PAD');
    const target = this._stationKeepTarget || this.target;
    if (!target) { audioSystem.playClickFail(); return false; }

    eventBus.emit(Events.STATION_KEEP_EXITED, { armId: this.id, reason: 'pad' });
    this._padPhase = 'APPROACH';
    this._padTimer = 0;
    this._padResolvedMode = null;
    this._captureToolKind = 'PAD';
    audioSystem.playClick();
    this._toolLockedDebrisId = target.id;
    eventBus.emit(Events.AUTOPILOT_TARGET_LOCK, { debrisId: target.id });
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: this.displayName, text: `${this.displayName}: Soft approach. Bringing pad to contact`,
      channel: 'CMD', priority: 'info',
    });
    this._transitionTo(S.PAD_CONTACT);
    return true;
  }

  /** @private PAD_CONTACT sub-FSM: APPROACH_SOFT → CONTACT → grip roll. */
  _updatePadContact(dt) {
    this._padTimer += dt;
    const P = Constants.PAD_CONTACT;
    const target = this._stationKeepTarget || this.target;
    if (!target || target._captured || target.alive === false) {
      this._failPadContact('no_mode');
      return;
    }

    if (this._padPhase === 'APPROACH') {
      const tPos = target._scenePosition;
      if (tPos) {
        this.position.lerp(tPos, Math.min(1, dt * 1.5));   // soft closing
        const distM = this.position.distanceTo(tPos) / M;
        if (distM <= P.PAD_RADIUS_M) {
          const contactVel = (this._padContactVelOverride != null)
            ? this._padContactVelOverride
            : this.velocity.length() / M;
          eventBus.emit(Events.PAD_CONTACT_ATTEMPT, { armId: this.id, targetId: target.id, contactVel });
          if (contactVel > P.CONTACT_VEL_MAX_M_S) { this._failPadContact('too_fast'); return; }
          this._padResolvedMode = this._resolvePadMode(target);
          this._padPhase = 'CONTACT';
          this._padTimer = 0;
          return;
        }
      }
      if (this._padTimer >= P.APPROACH_TIMEOUT_S) this._failPadContact('too_fast');
      return;
    }

    if (this._padPhase === 'CONTACT') {
      if (this._padTimer >= P.CONTACT_HOLD_S) this._resolvePadGrip(target);
    }
  }

  /** @private Resolve the pad grip roll → GRAPPLED (adhered) or RETURNING (bounced). */
  _resolvePadGrip(target) {
    const P = Constants.PAD_CONTACT;
    const mode = this._padResolvedMode;
    const p = mode ? (P.P_GRIP_BY_MODE[mode] ?? P.P_GRIP_NO_MODE) : P.P_GRIP_NO_MODE;
    // Test seam: `_padRollOverride` (0..1) forces a deterministic roll.
    const roll = (this._padRollOverride != null) ? this._padRollOverride : Math.random();
    if (roll >= p) { this._failPadContact(mode ? 'p_roll' : 'no_mode'); return; }

    // Success — decrement the UV-cure magazine IFF that mode actually adhered.
    if (mode === 'uv_cure') {
      this._padUvCureDosesRemaining = Math.max(0, (this._padUvCureDosesRemaining || 0) - 1);
      eventBus.emit(Events.PAD_UV_DOSE_USED, { armId: this.id, dosesRemaining: this._padUvCureDosesRemaining });
    }
    this._padPhase = null;
    eventBus.emit(Events.PAD_ADHERED, { armId: this.id, targetId: target.id, mode });
    this._secureToolCatch(target, 'PAD',
      `${this.displayName}: Pad adhered (${mode || 'no-mode'}). Holding. Reeling in.`);
  }

  /** @private Pad bounce/abort → release, return to reload. */
  _failPadContact(reason) {
    const target = this._stationKeepTarget || this.target;
    this._padPhase = null;
    audioSystem.playClickFail();
    if (target) {
      eventBus.emit(Events.PAD_BOUNCED, { armId: this.id, targetId: target.id, reason });
      eventBus.emit(Events.PAD_RELEASED, { armId: this.id, targetId: target.id });
    }
    const msg = reason === 'too_fast'
      ? `${this.displayName}: Pad bounced. Contact too fast. Returning; ease the approach and retry.`
      : reason === 'no_mode'
        ? `${this.displayName}: Pad found no adhesion mode for this surface. Returning to reload.`
        : `${this.displayName}: Pad failed to adhere. Returning to reload.`;
    eventBus.emit(Events.COMMS_MESSAGE, { source: this.displayName, text: msg, channel: 'CMD', priority: 'warning' });
    this._endToolFailure();
  }

  /** NETTING: net deployment + capture attempt (3s) */
  _updateNetting(dt) {
    // ── CAPTURE_NET ON: delegate to 14-state FSM in CaptureNet.js ──
    if (Constants.isFeatureEnabled('CAPTURE_NET')) {
      this._updateNettingFSM(dt);
      return;
    }

    // ── Legacy path (CAPTURE_NET OFF): 85% dice roll ──
    // --- Engineered auto-capture failure for tutorial discovery ---
    if (!this._manualCapture && this._autoFailChance > 0) {
      // Consume the failure chance immediately (single roll, not per-frame)
      const failChance = this._autoFailChance;
      this._autoFailChance = 0;

      // High-tumble targets have a failure chance when auto-captured
      const tumbleDeg = (this.target?.tumbleRate || 0) * (180 / Math.PI);
      const isHighTumble = tumbleDeg > 50; // 50°/s is very fast

      if (isHighTumble && Math.random() < failChance) {
        // Auto-capture FAILED
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: AUTO-CAPTURE FAILED. Target tumble too high!`,
          priority: 'critical',
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Tumble too high for auto-capture. Pilot her in manually (1-4) for a better grip.`,
          priority: 'warning',
        });

        // Return arm (failed capture)
        this.capturedDebris = null;
        this.target = null;
        this._transitionTo(S.RETURNING);
        return;
      }
    }

    // Station-keep near target
    const tPos = this._getTargetScenePos();
    if (tPos) {
      this.position.lerp(tPos, 0.02);
    }

    if (this.stateTimer > Constants.ARM_NET_DEPLOY_TIME) {
      const success = Math.random() < Constants.ARM_CAPTURE_SUCCESS_RATE;
      if (success) {
        this.capturedDebris = this.target;
        if (this.target) {
          this.target._captured = true;  // UX Fix E+: hide reticle immediately
          this.target._capturedByArm = this; // POLISH FIX issue #2: pin debris visual to arm during REELING
        }
        this._transitionTo(S.GRAPPLED);
        eventBus.emit(Events.ARM_CAPTURED, {
          armId: this.id, targetId: this.target.id, type: this.type,
          detached: this.isDetached,
          mass: this.target?.mass || 0, debrisType: this.target?.type || 'unknown',
          manual: this._manualCapture,
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Target secured! SMA cinch complete.`,
          priority: 'success',
        });
      } else {
        eventBus.emit(Events.ARM_CAPTURE_FAILED, {
          armId: this.id, targetId: this.target?.id,
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Netting failed. Re-approaching`,
          priority: 'warning',
        });
        this._transitionTo(S.APPROACH);
      }
    }
  }

  /**
   * NETTING sub-handler for CAPTURE_NET ON: fire a daughter net via
   * CaptureNetSystem and poll the 14-state FSM each frame.
   * Decrement happens inside fireDaughterNet() (exactly once on launch).
   * @private
   */
  _updateNettingFSM(dt) {
  const CN_STATES = Constants.CAPTURE_NET.STATES;

  // Use stored reference first (robust: survives activeNets lookup issues),
  // then fall back to system query.
  let activeNet = this._firedNet || captureNetSystem.getActiveNetForArm(this.index);
   if (!activeNet) {
     const launchPos = {
       x: this.position.x / M,
       y: this.position.y / M,
       z: this.position.z / M,
     };
      // Launch direction: lead the target (Item 2). Aim at where the target will
      // be when the net arrives — targetPos + relVel × (dist / LAUNCH_SPEED).
      // Close-range SK shots barely change (short time-of-flight); long shots stop
      // missing for a non-obvious reason. All quantities are in SCENE UNITS; the
      // net's LAUNCH_SPEED is m/s, so convert to scene-units/s via × M.
      // UX-11 #1 (review fix): single source of truth — the SAME computeLeadAim
      // used by the HUD's OFF-AXIS advisory (DockingReticle), so the warning
      // can never disagree with where the shot actually goes.
      const tPos = this._getTargetScenePos();
      let launchDir = { x: 1, y: 0, z: 0 };
      if (tPos) {
        const relVel = this._leadTargetVelValid ? this._leadTargetVel : null;
        // Net class via the canonical selector (same class fireDaughterNet will
        // launch) so the lead's time-of-flight always matches the actual net.
        const _cnClass = getNetClassForType(this.type);
        const launchSpeedScene = (this._firedNet?.netClass?.LAUNCH_SPEED
          || _cnClass?.LAUNCH_SPEED || 10) * M;
        launchDir = computeLeadAim(this.position, tPos, relVel, launchSpeedScene).dir;
        // Issue 2 instrumentation (?debug=1): log the lead magnitude + off-axis
        // angle at fire time. From a settled SK both should read ≈0 now that
        // _leadTargetVel is arm-relative; a large value flags an alternate
        // drift source (e.g. the NETTING chase lerp below).
        if (Constants.DEBUG && Constants.DEBUG.LOG_RENDERER_DIAGNOSTICS) {
          const bx = tPos.x - this.position.x, by = tPos.y - this.position.y, bz = tPos.z - this.position.z;
          const bLen = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
          const dot = Math.min(1, Math.max(-1,
            (launchDir.x * bx + launchDir.y * by + launchDir.z * bz) / bLen));
          const offAxisDeg = Math.acos(dot) * 180 / Math.PI;
          const relSpeed = relVel ? Math.sqrt(relVel.x ** 2 + relVel.y ** 2 + relVel.z ** 2) : 0;
          console.info(`[LeadAim] ${this.id} fire: |relVel|=${(relSpeed / M).toFixed(3)} m/s ` +
            `offAxis=${offAxisDeg.toFixed(2)}° dist=${(bLen / M).toFixed(1)} m state=${this.state}`);
        }
      }

     activeNet = captureNetSystem.fireDaughterNet(
       this, this.index, launchPos, launchDir, this.target
     );

     if (!activeNet) {
       // fireDaughterNet returned null (cooldown/inventory/flag) — fall back to SK
       // (not APPROACH, which causes "screen-races-to-debris" at orbital speed).
       // Item 5b (2026-06-12): name the actual reason — a silent fallback left
       // the player wondering why nothing fired (learning-mission dead end).
       {
         const inv = (typeof this.getNetInventory === 'function')
           ? this.getNetInventory() : (this._netInventory || 0);
         const cdS = (typeof captureNetSystem.getCooldown === 'function')
           ? captureNetSystem.getCooldown('arm', this.index) : 0;
         const reason = inv <= 0
           ? 'Net magazine empty. Press R to reel home and reload.'
           : cdS > 0
             ? `Net launcher cooling down. Ready in ${Math.ceil(cdS)}s.`
             : 'Net launcher unavailable. Holding station.';
         eventBus.emit(Events.COMMS_MESSAGE, {
           source: this.displayName, text: `${this.displayName}: ${reason}`,
           channel: 'CMD', priority: 'warning',
         });
       }
       this._firedNet = null;
       this._transitionTo(S.STATION_KEEP);
       return;
     }
     this._firedNet = activeNet;  // store reference for subsequent frames
   }

    // NETTING: track the target at the same SK standoff offset so the camera
    // stays stable while the net is in flight.
    // Reuse SK frame vectors (frozen at SK entry: _skPolarAxis, _skRightVec,
    // _skEquator0, _skPitch0) + spherical coords (_orbitTheta, _orbitPhi,
    // _standoffR) for an exact goal, then lerp at the same SK rate (smooth,
    // jitter-free — direct overwrite causes ~1m/frame jumps from frame mismatch
    // with line 1886 parent-frame correction).
    {
      const tPos = this._getTargetScenePos();
      if (tPos && this._skPolarAxis && this._skEquator0 && this._skRightVec) {
        const SK = Constants.STATION_KEEP;
        const _yaw = this._orbitTheta || 0;
        const _totalPitch = (this._skPitch0 || 0) + (this._orbitPhi || 0);
        const _cosY = Math.cos(_yaw), _sinY = Math.sin(_yaw);
        const _cosP = Math.cos(_totalPitch), _sinP = Math.sin(_totalPitch);
        const _eqX = this._skEquator0.x * _cosY + this._skRightVec.x * _sinY;
        const _eqY = this._skEquator0.y * _cosY + this._skRightVec.y * _sinY;
        const _eqZ = this._skEquator0.z * _cosY + this._skRightVec.z * _sinY;
        const _ox = _eqX * _cosP + this._skPolarAxis.x * _sinP;
        const _oy = _eqY * _cosP + this._skPolarAxis.y * _sinP;
        const _oz = _eqZ * _cosP + this._skPolarAxis.z * _sinP;
        const _Rscene = (this._standoffR || SK.DEFAULT_STANDOFF) * M;
        const goalX = tPos.x + _ox * _Rscene;
        const goalY = tPos.y + _oy * _Rscene;
        const goalZ = tPos.z + _oz * _Rscene;
        const lerp = SK.STATIONKEEP_LERP_RATE;
        this.position.x += (goalX - this.position.x) * lerp;
        this.position.y += (goalY - this.position.y) * lerp;
        this.position.z += (goalZ - this.position.z) * lerp;
      }
    }

    // Poll FSM state
    const netState = activeNet.state;
    if (netState === CN_STATES.CAPTURED) {
      this.capturedDebris = this.target;
      // Phase 2 (ASPECT_CAPTURE): freeze the presented width AT CATCH TIME —
      // the reel-start oversize check judges the geometry the net actually
      // wrapped, not whatever the body has rotated to by reel time.
      this._catchPresentedWidthM = (activeNet._presentedWidthM != null)
        ? activeNet._presentedWidthM : null;
      if (this.target) {
        this.target._captured = true;
        this.target._capturedByArm = this; // POLISH FIX issue #2: pin debris visual to arm during REELING
      }
      this._transitionTo(S.GRAPPLED);
      eventBus.emit(Events.ARM_CAPTURED, {
        armId: this.id, targetId: this.target?.id, type: this.type,
        detached: this.isDetached,
        mass: this.target?.mass || 0, debrisType: this.target?.type || 'unknown',
        manual: this._manualCapture,
      });
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Target secured! SMA cinch complete.`,
        priority: 'success',
      });
    } else if (netState === CN_STATES.MISSED || netState === CN_STATES.RELEASED) {
      // Issue-B GUARD: if the target died mid-net-flight (deorbit, cull,
      // fragmentation, etc.), don't loop back into SK — there's nothing to
      // station-keep on. Go straight to RETURNING with a clear comms message.
      const committedAlive = this._netCommittedTarget && this._netCommittedTarget.alive !== false;
      eventBus.emit(Events.ARM_CAPTURE_FAILED, {
        armId: this.id, targetId: this.target?.id,
      });
      if (!committedAlive) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Target lost during net flight. Returning empty.`,
          priority: 'warning',
        });
        if (this._netCommittedTarget) this._netCommittedTarget._committedNetArmId = null;
        this._netCommittedTarget = null;
        if (this._stationKeepTarget) this._stationKeepTarget._isStationKeepTarget = false;
        this._stationKeepTarget = null;
        this._transitionTo(S.RETURNING);
      } else {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Netting failed. Holding standoff. Press N to retry.`,
          priority: 'warning',
        });
        // Fall back to SK (not APPROACH) — arm stays at standoff; pilot retries with F.
        // APPROACH causes "screen-races-to-debris" effect at orbital speed.
        this._transitionTo(S.STATION_KEEP);
      }
    } else if (netState === CN_STATES.STOWED) {
      // Net returned stowed (either success cargo-stored or miss-returned)
      if (activeNet.catchResult === 'success') {
        this.capturedDebris = this.target;
        if (this.target) {
          this.target._captured = true;
          this.target._capturedByArm = this; // POLISH FIX issue #2: pin debris visual to arm during REELING
        }
        if (this._netCommittedTarget) this._netCommittedTarget._committedNetArmId = null;
        this._netCommittedTarget = null;
        this._transitionTo(S.GRAPPLED);
        eventBus.emit(Events.ARM_CAPTURED, {
          armId: this.id, targetId: this.target?.id, type: this.type,
          detached: this.isDetached,
          mass: this.target?.mass || 0, debrisType: this.target?.type || 'unknown',
          manual: this._manualCapture,
        });
      } else {
        // Issue-B GUARD (STOWED miss path): same target-alive check.
        const committedAliveStowed = this._netCommittedTarget && this._netCommittedTarget.alive !== false;
        if (!committedAliveStowed) {
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: `${this.displayName}: Target lost during net flight. Returning empty.`,
            priority: 'warning',
          });
          if (this._netCommittedTarget) this._netCommittedTarget._committedNetArmId = null;
          this._netCommittedTarget = null;
          if (this._stationKeepTarget) this._stationKeepTarget._isStationKeepTarget = false;
          this._stationKeepTarget = null;
          this._transitionTo(S.RETURNING);
        } else {
          // Miss STOWED: also stay in SK so pilot can retry without re-approaching.
          this._transitionTo(S.STATION_KEEP);
        }
      }
    }
    // Otherwise: net still in flight/reeling — keep polling
  }

  /** GRAPPLED: holding debris, stabilize before hauling/reeling */
  _updateGrappled(dt) {
    const tPos = this._getTargetScenePos();
    if (tPos) {
      this.position.copy(tPos);
    }
    if (this.stateTimer > Constants.ARM_GRAPPLE_STABILIZE) {
      // Detached arms cannot return — go straight to deorbit sacrifice
      if (this.isDetached) {
        this._transitionTo(S.DEORBITING);
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: No tether. Committing to deorbit burn. Sacrificial play.`,
          priority: 'warning',
        });
        return;
      }
      // Net-integrity check at reel start: a heavy, near-rated catch can slip
      // the net. A failure is recoverable (debris drifts free, daughter returns
      // to reload) and is handled inside the check — bail out of REELING.
      if (this._checkNetIntegrityOnReel()) return;

      // SNUG sub-phase (REEL_PROFILE_V2, plan Q3): before the haul, cinch the
      // stage-1 net tight so daughter+net+debris is ONE rigid unit (one CoM,
      // m_unit). Implemented as a short settle window after the stabilize hold:
      // we ask the held net to pull to its snug-tension target, wait SETTLE_S so
      // the cinch transient damps, emit CATCH_SNUGGED once, then enter REELING.
      // Skipped when empty (reelFromStationKeep aborts have no catch) — only the
      // GRAPPLED→REELING capture path snugs. Over-strain already handled above.
      if (Constants.isFeatureEnabled('REEL_PROFILE_V2') && this.capturedDebris && !this._catchSnugged) {
        this._applySnugTension();
        const settle = (Constants.CATCH_SNUG && Constants.CATCH_SNUG.SETTLE_S) ?? 0.4;
        if (this.stateTimer <= Constants.ARM_GRAPPLE_STABILIZE + settle) {
          return;   // still settling — hold the GRAPPLED co-location one more frame
        }
        this._catchSnugged = true;
        const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
        eventBus.emit(Events.CATCH_SNUGGED, {
          armIndex: this.index,
          debrisId: this.capturedDebris.id,
          mUnit: this._computeReelMUnit(armMass, true),
        });
      }

      // V5: Zero-fuel motor reel-in instead of fuel-burning HAULING
      this._transitionTo(S.REELING);
      const _hasPayload = this.capturedDebris !== null;
      const _reelSpeed = _hasPayload ? REEL_IN_SPEED_LOADED : REEL_IN_SPEED_EMPTY;
      const _eta = (this.tetherLength / Math.max(_reelSpeed, 1)).toFixed(1);
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: `Reeling in. ETA ${_eta} s`,
        channel: 'CMD',
        priority: 'info',
      });
    }
  }

  /**
   * SNUG cinch (REEL_PROFILE_V2, plan Q3): tell the held stage-1 net to tighten
   * to CATCH_SNUG.TENSION_TARGET_N so the bag rigidizes onto the debris before
   * the haul. The net's _updateReeling honours `_snugTargetN` while `_heldByArm`
   * (otherwise its tension is the base mass formula). No-op for non-NET grips.
   * @private
   */
  _applySnugTension() {
    if (this._captureToolKind && this._captureToolKind !== 'NET') return;
    const net = this._firedNet || (captureNetSystem.getActiveNetForArm
      ? captureNetSystem.getActiveNetForArm(this.index) : null);
    if (!net) return;
    const target = (Constants.CATCH_SNUG && Constants.CATCH_SNUG.TENSION_TARGET_N) ?? 8;
    net._snugTargetN = target;
  }

  /**
   * Yoke tether-plume clearance test (REEL_PROFILE_V2, plan Rev-3 / §1.2).
   * FEEP braking fires the fore nozzle (+Z exhaust) toward the mother — the same
   * side the tether runs to. The +Y wishbone bridle holds the cable off that
   * axis. This returns true only when the angle between the tether line (bridle
   * anchor → strut dock) and the active brake-plume axis (the daughter's world
   * +Z / nose) is at least MIN_TETHER_PLUME_DEG, i.e. the cable rides outside
   * the plume cone. When false, FEEP is withheld and the reel finishes on the
   * motor alone (no §4.2 ablation is simulated). Degenerate/test geometry
   * (no parent frame) returns true so minimal mocks aren't blocked.
   * @param {THREE.Vector3} [parentPos] mother world position
   * @param {THREE.Quaternion} [parentQuat] mother world orientation
   * @returns {boolean} true if the tether clears the plume (FEEP permitted)
   * @private
   */
  _tetherPlumeClearOK(parentPos, parentQuat) {
    const YC = Constants.YOKE_CLEARANCE || {};
    const minDeg = YC.MIN_TETHER_PLUME_DEG ?? 30;
    if (!parentPos || !this.dockOffset) return true;   // test/degenerate geometry

    // Strut dock world position (tether mother-side anchor) — shared resolver so
    // this gate uses exactly the same dock reference as the reel target.
    const dockWP = this._tmpPlumeDock || (this._tmpPlumeDock = new THREE.Vector3());
    this._resolveStrutDockWorld(parentPos, parentQuat, dockWP);

    // Tether line: daughter (+Y bridle ≈ daughter position for this angle test)
    // → strut dock. Brake-plume axis: daughter world +Z (nose), the fore-nozzle
    // exhaust direction under the whole-haul reel attitude.
    const tetherDir = this._tmpPlumeTether || (this._tmpPlumeTether = new THREE.Vector3());
    tetherDir.subVectors(dockWP, this.position);
    if (tetherDir.lengthSq() < 1e-20) return true;
    tetherDir.normalize();

    const noseDir = this._tmpPlumeNose || (this._tmpPlumeNose = new THREE.Vector3());
    noseDir.set(0, 0, 1).applyQuaternion(this.group.quaternion);
    if (noseDir.lengthSq() < 1e-12) return true;
    noseDir.normalize();

    const cos = Math.max(-1, Math.min(1, tetherDir.dot(noseDir)));
    const angleDeg = Math.acos(cos) * 180 / Math.PI;
    return angleDeg >= minDeg;
  }

  /**
   * Release the currently captured debris back into the field as a free,
   * re-targetable body (shared by both capture-failure modes).
   *
   * The debris resumes its propagated orbit (its true trajectory — the capture
   * was only a visual pin) and is tagged `_netted` so it reads as "still wearing
   * the net" and is worth re-capturing. Crucially this means a lost catch never
   * silently vanishes; it becomes a chase-able object again.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.keepPinned=false] - keep `_capturedByArm` so the debris
   *        drifts WITH this arm (tether snap: the net stays intact between the
   *        daughter and debris). When false the debris detaches and floats free.
   * @returns {object|null} the released debris (or null if none)
   * @private
   */
  _releaseCapturedDebris({ keepPinned = false } = {}) {
    const debris = this.capturedDebris;
    if (!debris) return null;
    debris._netted = true;             // visual/gameplay tag: drifting in a net
    debris._captured = false;          // re-targetable by the next daughter
    debris._isStationKeepTarget = false;
    debris._committedNetArmId = null;
    if (!keepPinned) {
      // Detach: clear the pin so DebrisField resumes orbit-driven positioning
      // and restores LOD. The debris keeps its real orbital trajectory.
      debris._capturedByArm = null;
      debris._armPinned = false;       // release authoritative arm pin
    }
    // This arm no longer owns the catch for docking/processing in either case.
    this.capturedDebris = null;
    this.reeling = false;
    this.tetherTension = 0;
    return debris;
  }

  /**
   * Authoritative catch pin: force the captured debris straight to this arm's
   * position for the renderer AND every consumer (net visual, camera, autopilot,
   * gap diagnostics). Belt-and-suspenders over DebrisField's `_capturedByArm`
   * pin, which proved fragile for station-keep / welcome-field debris and let
   * the catch drift hundreds of metres away on its own orbit during the haul.
   *
   * 2026-06-12 (Issue 13): the pin carries a STANDOFF along the hold axis —
   * `arm.position + holdDir × (sizeMeter/2 + ARM_HOLD_CLEARANCE_M)` — so the
   * daughter never renders inside a catch larger than herself. holdDir is the
   * capture axis (net launchDirection while the fired-net ref lives), else the
   * outboard direction from the mother (so the catch hangs outboard of the
   * daughter in REELING and outboard of the strut in HOLDING_CATCH, tracking
   * parent rotation each re-pin).
   * @param {THREE.Vector3|null} [parentPos] freshest mother position (falls
   *   back to _prevParentPos when the call site has no parent frame in scope)
   * @param {number} [lateralBias=0] perpendicular offset (× catch radius) to
   *   slide the bag off the camera→daughter axis so the parked daughter stays
   *   visible beside her catch (used by HOLDING_CATCH). 0 = pure outboard.
   * @private
   */
  _pinCatchToSelf(parentPos = null, lateralBias = 0) {
    const d = this.capturedDebris;
    if (!d) return;
    const dir = this._tmpHoldDir || (this._tmpHoldDir = new THREE.Vector3());
    let hasDir = false;
    const ld = this._firedNet && this._firedNet.launchDirection;
    if (ld) {
      dir.set(ld.x, ld.y, ld.z);
      hasDir = dir.lengthSq() > 1e-12;
    }
    const pp = parentPos || this._prevParentPos;
    if (!hasDir && pp) {
      dir.subVectors(this.position, pp);
      hasDir = dir.lengthSq() > 1e-12;
    }
    if (hasDir) dir.normalize(); else dir.set(0, 0, 0);
    const clearance = (Constants.ARM_HOLD_CLEARANCE_M ?? 1.0);
    const standoffScene = ((d.sizeMeter || 0) / 2 + clearance) * M;
    if (!d._armPinPos) d._armPinPos = new THREE.Vector3();
    d._armPinPos.copy(this.position).addScaledVector(dir, standoffScene);

    // Issue (re-dock occlusion): in HOLDING_CATCH the catch parks full-size at
    // the strut tip directly OUTBOARD of the ~1 m daughter. From the usual
    // gameplay camera (looking from the mother outward) a 5 m bag placed on the
    // camera→daughter axis eclipses her — reading as "the daughter disappeared"
    // for the whole hold/chop window. A lateral bias slides the bag off that
    // axis (perpendicular to the outboard hold direction) so the daughter stays
    // visible beside her catch. Axis = holdDir × world-up, falling back to
    // world-X when holdDir is ~parallel to up. Scales with the catch radius so
    // bigger catches clear further.
    if (lateralBias !== 0 && hasDir) {
      const lat = this._tmpLatDir || (this._tmpLatDir = new THREE.Vector3());
      lat.crossVectors(dir, _WORLD_UP);
      if (lat.lengthSq() < 1e-8) lat.set(1, 0, 0); // holdDir ∥ up — pick world-X
      lat.normalize();
      const latScene = ((d.sizeMeter || 0) / 2 + clearance) * M * lateralBias;
      d._armPinPos.addScaledVector(lat, latScene);
    }
    d._armPinned = true;
  }

  /**
   * Net-integrity check performed as reel-in begins (GRAPPLED → REELING).
   * Two failure modes, both RECOVERABLE (daughter keeps her tether and returns
   * to reload while the debris drifts free, re-capturable):
   *   • OVERSIZE (deterministic): debris is physically wider than the net mouth,
   *     so the net can't actually cinch around it.
   *   • STRAIN (probabilistic): a heavy catch near the net's rated mass slips
   *     the weave, scaling with how close the payload is to the rating.
   * @returns {boolean} true if the net failed (caller must NOT enter REELING)
   * @private
   */
  _checkNetIntegrityOnReel() {
    const debris = this.capturedDebris;
    if (!debris) return false;
    // CP-1 / P2: net-integrity (oversize / strain) only applies to NET catches.
    // A magnetic (or future gripper/pad) grip has no net mouth to overflow, so
    // skip the check entirely — otherwise a large ferrous body grabbed by the
    // EPM would false-fail against the net diameter.
    if (this._captureToolKind && this._captureToolKind !== 'NET') return false;
    const payloadMass = debris.mass || 0;
    const rated = this._netRatedMass || 0;
    // Phase 2 (ASPECT_CAPTURE): judge the width the net actually wrapped at
    // catch time (presented width at contact), not the scalar max extent —
    // an end-on catch of a long body is legitimate.
    const aspectOn = Constants.isFeatureEnabled('ASPECT_CAPTURE');
    const debrisSize = (aspectOn && this._catchPresentedWidthM != null)
      ? this._catchPresentedWidthM
      : (debris.sizeMeter || 0);
    const netDia = this._netDiameter || 0;

    // Hard fail: debris wider than the net mouth can't be enveloped/cinched.
    const oversized = netDia > 0 && debrisSize > netDia;

    // Probabilistic fail: heavy catch near the net's rated mass slips the weave.
    let strain = 0;
    let strainFail = false;
    if (!oversized && payloadMass > 0 && rated > 0) {
      strain = payloadMass / rated;
      const safe = Constants.NET_STRAIN_SAFE_FRACTION ?? 0.8;
      if (strain > safe) {
        const pMax = Constants.NET_STRAIN_FAIL_PROB_MAX ?? 0;
        const t = Math.min(1, (strain - safe) / Math.max(1e-6, 1 - safe));
        strainFail = Math.random() < pMax * t;
      }
    }

    if (!oversized && !strainFail) return false;               // net holds

    // ── Net failed — release the catch; daughter returns to reload ──
    this._releaseCapturedDebris({ keepPinned: false });
    eventBus.emit(Events.NET_FAILED, {
      armId: this.id, armIndex: this.index,
      debrisId: debris.id, strain, oversized, recoverable: true,
    });
    const reason = oversized
      ? `Net failed. Debris too wide for the net (${debrisSize.toFixed(1)}m vs ${netDia.toFixed(1)}m mouth). Returning to reload; a larger net is needed.`
      // Phase 0.4 (capture-feedback overhaul): name the CAUSE so the slip is
      // legible — the catch was deep in the 80-100% strain band, not bad luck.
      : `Net failed. Debris slipped free and is drifting (catch was ${Math.round(strain * 100)}% of the net's rated mass. Slips become likely above ${Math.round((Constants.NET_STRAIN_SAFE_FRACTION ?? 0.8) * 100)}%). Returning to reload; re-net to retry.`;
    eventBus.emit(Events.COMMS_MESSAGE, { text: `${this.displayName}: ${reason}`, priority: 'warning' });
    if (this._stationKeepTarget) this._stationKeepTarget._isStationKeepTarget = false;
    this._stationKeepTarget = null;
    this.target = null;
    this._transitionTo(S.RETURNING);
    return true;
  }

  /**
   * Phase 3a (capture-feedback overhaul): the net RIPS under boost-reel load —
   * recoverable (mirror of the reel-start strain slip): debris drifts free and
   * re-capturable, daughter keeps her tether and returns to reload.
   * @param {number} strain — payload / rated mass at the moment of the rip
   * @private
   */
  _ripNetDuringBoost(strain) {
    const debris = this.capturedDebris;
    if (!debris) return;
    this._boostReel = false;
    this._releaseCapturedDebris({ keepPinned: false });
    eventBus.emit(Events.NET_FAILED, {
      armId: this.id, armIndex: this.index,
      debrisId: debris.id, strain, oversized: false, recoverable: true,
      cause: 'boost_reel',
    });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.displayName}: Net RIPPED under boost reel (catch was ${Math.round(strain * 100)}% of rated mass). `
        + 'Debris drifting free. Nominal reel speed is safe; boost prices heavy catches.',
      priority: 'warning',
    });
    if (this._stationKeepTarget) this._stationKeepTarget._isStationKeepTarget = false;
    this._stationKeepTarget = null;
    this.target = null;
    this._transitionTo(S.RETURNING);
  }

  /**
   * Catastrophic tether snap during reel-in: the mother↔daughter cable parts.
   * The net stays intact between daughter and debris, so they are cut loose and
   * drift off TOGETHER (debris stays pinned to the now-EXPENDED daughter — it
   * does NOT vanish). A recoil impulse springs the pair clear of the mother and
   * the severed line is hidden. The catch is lost (the daughter can't return),
   * though the runaway debris is left re-targetable so another daughter can give
   * chase. Upgrade the tether to haul heavier loads without snapping.
   * @private
   */
  _snapTether(parentPos) {
    // Recoil: shove the daughter (and her pinned catch) away from the mother
    // along the tether axis so the pair visibly springs free instead of freezing.
    const sep = (Constants.CAPTURE_RELEASE_SEPARATION_MPS || 1.2) * M;
    if (parentPos) {
      const away = this._tmpVec.subVectors(this.position, parentPos);
      if (away.lengthSq() > 1e-20) {
        away.normalize();
        this.velocity.addScaledVector(away, sep);
      }
    }
    // Keep the catch attached to the daughter (net intact) so it drifts with
    // her — coherent, still visible, never silently removed.
    const debris = this._releaseCapturedDebris({ keepPinned: true });
    this._tetherSevered = true;
    this._severedCatch = debris;       // bounded pin — released after a drift delay
    this._severedDriftS = 0;
    this.isDetached = true;            // cut from mother — can't reel/return
    if (this.tetherLine) this.tetherLine.visible = false;
    eventBus.emit(Events.TETHER_SNAP, {
      armIndex: this.index, armId: this.id, cause: 'overload',
      debrisId: debris && debris.id, recoverable: false,
    });
    this._transitionTo(S.EXPENDED);
  }


  /**
   * HAULING: tow debris back toward parent (slow).
   * Legacy state — preserved for backward compatibility.
   * V5 uses REELING instead for zero-fuel motor reel-in.
   */
  _updateHauling(dt, parentPos) {
    // Detached arms can't return — redirect to deorbit sacrifice
    if (this.isDetached) {
      this._transitionTo(S.DEORBITING);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: No tether. Committing to deorbit burn. Sacrificial play.`,
        priority: 'warning',
      });
      return;
    }

    const toParent = this._tmpVec.subVectors(parentPos, this.position);
    const dist = toParent.length();

    toParent.normalize();
    const haulSpeed = this.config.haulSpeed * (this._beaconSpeedScale || 1);
    this.velocity.lerp(toParent.multiplyScalar(haulSpeed), 0.05);
    this.position.addScaledVector(this.velocity, dt);

    // Note: captured debris uses InstancedMesh — its visual is handled by
    // DebrisField (and marked not-alive after capture). No mesh to move.

    this.tetherLength = this.position.distanceTo(parentPos) / M;

    const dockThreshold = this.config.bodyDims[2] * M * 8;
    if (dist < dockThreshold) {
      this._transitionTo(S.DOCKING);
      eventBus.emit(Events.ARM_RETURNED, {
        armId: this.id, captured: true, debrisId: this.capturedDebris?.id,
      });
    }
  }

  /**
   * Resolve the strut-tip dock world position into `out` (single source of
   * truth so every distance / heading / plume-clearance computation agrees on
   * the dock reference). Strict fallback: only rotate+offset when BOTH a parent
   * quaternion and a dockOffset are present; otherwise the dock is the mother
   * centre (`parentPos`). Matches the long-standing _updateReeling convention so
   * the FEEP gate and reel heading can never diverge from the reel target.
   * @param {THREE.Vector3} parentPos mother world position
   * @param {THREE.Quaternion} [parentQuat] mother world orientation
   * @param {THREE.Vector3} out destination vector (written in place)
   * @returns {THREE.Vector3} `out`
   * @private
   */
  _resolveStrutDockWorld(parentPos, parentQuat, out) {
    if (parentQuat && this.dockOffset) {
      out.copy(this.dockOffset).applyQuaternion(parentQuat).add(parentPos);
    } else {
      out.copy(parentPos);
    }
    return out;
  }

  /**
   * Combined retrieval-unit mass m_unit = m_daughter + m_net + m_debris (kg).
   * The single source of truth for V2 reel tension/throttle (plan Q2). Net mass
   * is small but folded in so Q3/Q4 share one consistent mass.
   * @param {number} armMass daughter dry mass (kg)
   * @param {boolean} hasPayload whether a catch is held
   * @returns {number} kg
   * @private
   */
  _computeReelMUnit(armMass, hasPayload) {
    let m = armMass;
    if (hasPayload && this.capturedDebris) m += (this.capturedDebris.mass || 0);
    // Net mass: only NET catches carry a net; magnetic/gripper/pad grips don't.
    if (hasPayload && (!this._captureToolKind || this._captureToolKind === 'NET')) {
      const nc = getNetClassForType(this.type);
      if (nc && typeof nc.MASS === 'number') m += nc.MASS;
    }
    return m;
  }

  /**
   * Trapezoidal reel-in speed (m/s, game-scale) at a given remaining distance.
   * Power-bounded cruise → ramps DOWN to V_DOCK within DECEL_DISTANCE_M.
   *
   * Cruise solves the implicit power throttle v = P / T_reel with
   * T_reel = m_unit·v·coeff ⇒ v_cruise = √(P / (m_unit·coeff)), clamped to
   * [V_DOCK, V_CRUISE_MAX]. Because the cruise is power-bounded the resulting
   * tension T = m_unit·v·coeff = P/v ≥ P/V_CRUISE_MAX stays under the tether
   * break strength for any in-spec catch (the snap invariant) — only Boost,
   * which multiplies the speed AFTER the throttle, can push past it.
   *
   * Boost is locked out inside DECEL_DISTANCE_M (BOOST_LOCKOUT_IN_DECEL) so the
   * player can't slam the dock and defeat the Q4 arrest.
   * @param {number} distMeters remaining distance to the strut dock (m)
   * @param {number} armMass daughter dry mass (kg)
   * @param {boolean} hasPayload whether a catch is held
   * @param {number} boostMult REEL_BOOST speed multiplier (1 when not boosting)
   * @returns {number} reel speed in m/s
   * @private
   */
  _computeReelProfileSpeed(distMeters, armMass, hasPayload, boostMult) {
    const P = Constants.REEL_PROFILE || {};
    const vCruiseMax = P.V_CRUISE_MAX ?? 60;
    const vDock = P.V_DOCK ?? 1.0;
    const decelDist = P.DECEL_DISTANCE_M ?? 15;
    const power = P.HAUL_MOTOR_POWER ?? 2500;
    const tMin = P.T_MIN ?? 5;
    const coeff = Constants.REEL_TENSION_COEFF ?? 0.04;
    const mUnit = this._computeReelMUnit(armMass, hasPayload);

    // Power-bounded cruise (closed form of v = P/(m·v·coeff)). The T_MIN floor
    // caps how fast a near-massless unit may go (keeps it ≤ V_CRUISE_MAX) and
    // the V_DOCK floor prevents a 0-speed stall for a very heavy catch.
    const vFromMin = power / Math.max(tMin, 1e-6);            // light-catch ceiling
    const vFromPower = Math.sqrt(power / Math.max(mUnit * coeff, 1e-6));
    let vCruise = Math.min(vCruiseMax, vFromMin, vFromPower);

    // SNAP INVARIANT (plan §Q1): cap cruise so the steady-reel tension
    // T = m_unit·v·coeff never exceeds break×CRUISE_TENSION_FRACTION. A heavy
    // in-spec catch is therefore throttled to a slower-but-safe cruise; only
    // Boost (applied AFTER this throttle) may push tension past break.
    const tensionFrac = P.CRUISE_TENSION_FRACTION ?? 0.85;
    const breakN = this.tetherBreakStrength || 0;
    if (breakN > 0) {
      const vTension = (breakN * tensionFrac) / Math.max(mUnit * coeff, 1e-6);
      vCruise = Math.min(vCruise, vTension);
    }
    vCruise = Math.max(vDock, vCruise);

    // Ramp DOWN to V_DOCK under a constant-deceleration (ACCEL) kinematic bound:
    // v = √(V_DOCK² + 2·ACCEL·dist), clamped to the cruise cap. This is the
    // decel half of the trapezoid — far from the dock the bound exceeds vCruise
    // (so we cruise), and it tapers continuously to V_DOCK at contact (no band
    // edge discontinuity). DECEL_DISTANCE_M is retained as the boost-lockout
    // window. (Accel ramp-UP from launch is implicit — the daughter starts at
    // rest at the GRAPPLED co-location and the per-frame move clamps to the
    // remaining distance.)
    const accel = P.ACCEL ?? 8.0;
    const vDecel = Math.sqrt(vDock * vDock + 2 * accel * Math.max(0, distMeters));
    let speed = Math.min(vCruise, vDecel);

    // Boost multiplies cruise only, and is locked out inside the decel band so
    // the dock can't be slammed (keeps Q4 arrest meaningful).
    const lockBoost = (P.BOOST_LOCKOUT_IN_DECEL !== false) && distMeters <= decelDist;
    if (boostMult > 1 && !lockBoost) speed *= boostMult;

    return speed;
  }

  /**
   * REELING: V5 zero-fuel motor reel-in.
   * Reel motor on mothership pulls arm back — no FEEP fuel consumed.
   *
   * 2026-05-26 (Issue 1 fix): daughter docks at the end of the strut she
   * launched from, NOT mother's bus centre. Before this fix, _updateReeling
   * pulled the daughter to `parentPos` (mother core), then _updateDocking
   * lerped the last few metres over to the strut tip. The user saw the
   * daughter slide INTO the mother core then slide back out to the strut.
   * Now the reel target is the strut-tip dock world position (matches
   * _updateDocking) so the daughter approaches the correct dock from the
   * outset.
   * @private
   */
  _updateReeling(dt, parentPos, parentQuat) {
    const hasPayload = this.capturedDebris !== null;

    // Catch-cleared-mid-reel guard (plan §Q3 edge): if a captured debris was
    // destroyed/removed elsewhere during the haul, don't strand the FSM holding
    // a stale "loaded" profile — convert to an empty return (mirrors the
    // HOLDING_CATCH→RELOADING fallback). Only meaningful when we previously had
    // a catch; a genuinely empty reel (reelFromStationKeep) leaves this null
    // from the start and is unaffected.
    if (Constants.isFeatureEnabled('REEL_PROFILE_V2')
        && this._reelHadPayload === true && !hasPayload && this.state === S.REELING) {
      this._reelHadPayload = false;
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: `${this.displayName}: Catch lost mid-reel. Returning empty.`,
        channel: 'CMD', priority: 'warning',
      });
    }
    if (hasPayload) this._reelHadPayload = true;

    // Phase 3a (capture-feedback overhaul): hold Shift → BOOST reel ×2.
    // Tension scales ∝ reelSpeed² (mult applied to both speed and the tension
    // formula below), so boosting a heavy catch walks the bar toward RIP/SNAP.
    const boostOn = Constants.isFeatureEnabled('REEL_BOOST')
      && this._boostReelHeld === true && hasPayload;
    if (boostOn && !this._boostReel) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.displayName,
        text: `${this.displayName}: Boost reel engaged. Watch the tension bar.`,
        channel: 'CMD', priority: 'info',
      });
    }
    this._boostReel = boostOn;
    const boostMult = boostOn ? ((Constants.REEL_BOOST && Constants.REEL_BOOST.SPEED_MULT) || 2) : 1;

    // Compute strut-tip dock world position: parentPos + parentQuat × dockOffset.
    // Falls back to parentPos (mother centre) if quaternion or dockOffset absent
    // (pre-Config-G compat / test harness with minimal mocks).
    const dockWorldPos = this._tmpDockTarget || (this._tmpDockTarget = new THREE.Vector3());
    this._resolveStrutDockWorld(parentPos, parentQuat, dockWorldPos);

    // Direction toward strut-tip dock (reuse pre-allocated _tmpVec)
    const toMother = this._tmpVec.subVectors(dockWorldPos, this.position);
    const dist = toMother.length();

    // ── Reel speed selection ──────────────────────────────────────────────
    // V2 (FEATURE_FLAGS.REEL_PROFILE_V2): trapezoidal velocity profile — fast
    // power-bounded cruise that ramps DOWN to a gentle dock speed within
    // DECEL_DISTANCE_M. Legacy path: constant REEL_IN_SPEED_* × boost.
    const profileV2 = Constants.isFeatureEnabled('REEL_PROFILE_V2');
    const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
    let reelSpeed;
    if (profileV2) {
      const distMeters = dist / M;
      reelSpeed = this._computeReelProfileSpeed(distMeters, armMass, hasPayload, boostMult);
    } else {      reelSpeed = (hasPayload ? REEL_IN_SPEED_LOADED : REEL_IN_SPEED_EMPTY) * boostMult;
    }
    const reelSpeedScaled = reelSpeed * M;

    // ── FEEP soft re-dock arrest (REEL_PROFILE_V2, plan Q4) ────────────────
    // Within ARREST_DISTANCE_M the daughter fires FEEP to null the residual
    // closing-rate for a soft contact. Implemented as a ONE-SHOT mass-scaled
    // fuel debit (fuel% = DEBIT_K · m_unit · v_arrest) the first frame inside
    // the window — the existing reel ramp already carries the closing-rate down
    // to ~V_DOCK, so the debit prices the FEEP burn rather than re-simulating
    // momentum. Gated on tether-plume clearance (yoke) and fuel; either failing
    // → FUEL_FALLBACK_SLOW (zero-fuel reel-only finish + warn, never a dead-end).
    // Mission-1 is free (the learning loop). DOCKING's per-state fuel rate is
    // suppressed for this cycle (see _consumeFuel) so the arrest is charged once.
    if (profileV2 && hasPayload && !this._redockArrestStarted && !this.isDetached) {
      const RF = Constants.REDOCK_FEEP || {};
      const arrestDist = RF.ARREST_DISTANCE_M ?? 8;
      const distMeters = dist / M;
      if (distMeters <= arrestDist) {
        this._redockArrestStarted = true;
        this._redockDebitApplied = false;   // suppress DOCKING fuel rate this cycle
        const vArrest = Math.max(reelSpeed, RF.SOFT_DOCK_VEL ?? 0.10);
        const mUnit = this._computeReelMUnit(armMass, true);
        eventBus.emit(Events.REDOCK_ARREST_START, {
          armIndex: this.index, mUnit, vArrest,
        });

        const perMission = Constants.MISSIONS?.DEBRIS_PER_MISSION || 5;
        const missionNumber = Math.floor((gameState.debrisCleared || 0) / perMission) + 1;
        const mission1Free = (RF.MISSION1_FREE !== false) && missionNumber === 1;
        const plumeClear = this._tetherPlumeClearOK(parentPos, parentQuat);

        if (mission1Free) {
          this._redockDebitApplied = true;   // free pass still suppresses the DOCKING rate
        } else {
          const debit = (RF.DEBIT_K ?? 0.0008) * mUnit * vArrest;
          if (plumeClear && this.fuel >= debit) {
            this.fuel -= debit;
            this._redockDebitApplied = true;
          } else if (RF.FUEL_FALLBACK_SLOW !== false) {
            // Can't fund the burn OR the tether crosses the FEEP plume cone:
            // finish on the reel motor alone (slower, zero-fuel) and warn.
            if (!this._redockFuelLowWarned) {
              this._redockFuelLowWarned = true;
              eventBus.emit(Events.REDOCK_FUEL_LOW, {
                armIndex: this.index, fuel: this.fuel, needed: debit,
              });
              eventBus.emit(Events.COMMS_MESSAGE, {
                source: this.displayName,
                text: plumeClear
                  ? `${this.displayName}: Low FEEP for arrest. Easing in on the winch.`
                  : `${this.displayName}: Tether fouls the FEEP plume. Easing in on the winch.`,
                channel: 'CMD', priority: 'warning',
              });
            }
          }
        }
      }
    }


    // value as metres, but `dist` is in SCENE UNITS (1 unit = 100 km).  0.001
    // scene units = 100 m — so the entire reel-step branch was silently skipped
    // whenever REELING started inside ~100 m of the mother (e.g. a clean 35 m
    // capture).  The daughter was glued at her starting gap by the parent-frame
    // correction in update() and never docked.
    // Correct guard: 1 mm in scene units (M = 1 m → 0.00001 scene units) — purely
    // to avoid normalize() on a zero-length vector.  Real docking is decided by
    // the `moveDistance >= dist` branch below.
    if (dist > 1e-7) {
      toMother.normalize();
      // Move toward mothership at reel speed
      const moveDistance = reelSpeedScaled * dt;
      if (moveDistance >= dist) {
        // Close enough to dock — snap to the strut-tip dock (not mother core).
        this.position.copy(dockWorldPos);
        this._transitionTo(S.DOCKING);
        eventBus.emit(Events.ARM_RETURNED, {
          armId: this.id, captured: hasPayload, debrisId: this.capturedDebris?.id,
        });
      } else {
        this.position.addScaledVector(toMother, moveDistance);
      }
    }

    // Authoritative: drag the captured debris with us every frame so it can
    // never be left behind on its orbit while we reel home.
    this._pinCatchToSelf(parentPos);

    // Update tether length
    this.tetherLength = dist / M;

    // Calculate tension (simplified: F = m × a_reel).  Coefficient tuned
    // (Constants.REEL_TENSION_COEFF) so an in-spec catch reels home under the
    // default tether break strength — only genuine overload snaps the cable.
    // Phase 3a: the boosted reelSpeed doubles the tension target; while
    // boosting, tension EASES toward the target (TENSION_EASE_TAU_S) so the
    // bar visibly climbs into the red and the player can release Shift before
    // the snap. Nominal reel keeps the legacy direct assignment exactly —
    // cautious play is never punished.
    // V2 (Q2): tension keys off the combined unit mass m_unit = daughter + net +
    // debris (single source of truth). The cruise throttle (see
    // _computeReelProfileSpeed) is power-bounded so an in-spec catch stays under
    // break strength at full cruise — only Boost may push past it.
    const payloadMass = hasPayload && this.capturedDebris ? (this.capturedDebris.mass || 0) : 0;
    const tensionMass = profileV2 ? this._computeReelMUnit(armMass, hasPayload) : (armMass + payloadMass);
    const tensionCoeff = Constants.REEL_TENSION_COEFF ?? 0.04;
    const tensionTarget = tensionMass * reelSpeed * tensionCoeff;
    if (boostOn) {
      const tau = (Constants.REEL_BOOST && Constants.REEL_BOOST.TENSION_EASE_TAU_S) || 0.4;
      this.tetherTension += (tensionTarget - this.tetherTension) * Math.min(1, dt / tau);
    } else {
      this.tetherTension = tensionTarget;
    }

    // Phase 3a: boosting a catch deep in the strain band can RIP the net —
    // recoverable (debris drifts free, daughter returns), same consequence
    // path as the reel-start strain slip. Rolled per second while boosting.
    if (boostOn && this.state === S.REELING
        && (!this._captureToolKind || this._captureToolKind === 'NET')
        && payloadMass > 0 && (this._netRatedMass || 0) > 0) {
      const strain = payloadMass / this._netRatedMass;
      const safe = Constants.NET_STRAIN_SAFE_FRACTION ?? 0.8;
      if (strain > safe) {
        const t = Math.min(1, (strain - safe) / Math.max(1e-6, 1 - safe));
        const pPerS = (Constants.REEL_BOOST && Constants.REEL_BOOST.RIP_PROB_PER_S) ?? 0.10;
        const roll = (this._boostRipRollOverride != null) ? this._boostRipRollOverride : Math.random();
        if (roll < pPerS * t * dt) {
          this._ripNetDuringBoost(strain);
          return;
        }
      }
    }

    // Emit tension update
    eventBus.emit(Events.TETHER_TENSION_UPDATE, {
      armIndex: this.index,
      tension: this.tetherTension,
      fraction: this.tetherTension / this.tetherBreakStrength,
    });

    // Check for tether snap — catastrophic cut from the mother (see _snapTether).
    // Guard on REELING: the reel-step above may have already docked the catch
    // this frame (transitioned to DOCKING), in which case it's delivered, not lost.
    // Item 5d (2026-06-12): during MISSION 1 (the learning mission) the snap is
    // clamped to a warning — a catastrophic EXPENDED daughter dead-ends the
    // beginner loop before the player has learned the recovery verbs.
    if (this.state === S.REELING && this.tetherTension > this.tetherBreakStrength) {
      const perMission = Constants.MISSIONS?.DEBRIS_PER_MISSION || 5;
      const missionNumber = Math.floor((gameState.debrisCleared || 0) / perMission) + 1;
      if (missionNumber === 1) {
        this.tetherTension = this.tetherBreakStrength;   // clamp at the limit
        if (!this._m1SnapWarned) {
          this._m1SnapWarned = true;
          eventBus.emit(Events.COMMS_MESSAGE, {
            source: this.displayName,
            text: `${this.displayName}: Tether at rated limit. Winch absorbing the overload. ` +
              `Heavier catches will SNAP the cable once you're past training.`,
            channel: 'CMD', priority: 'warning',
          });
        }
      } else {
        this._snapTether(parentPos);
        return;
      }
    }

    // NO fuel consumption! This is the key V5 benefit.
    // Power draw from reel motor only (handled by PowerDistribution)

    // Emit reel state
    this.reeling = true;
    // V2: tag the current reel phase + closing-rate so the HUD can render
    // HAUL / RAMP / ARREST and a closing-rate readout ("docking hot" legibility).
    // `speed` already carries the live closing-rate (= reel speed; REELING moves
    // position directly so the reel speed IS the closing-rate).
    let reelPhase = null;
    if (profileV2) {
      const arrestDist = (Constants.REDOCK_FEEP && Constants.REDOCK_FEEP.ARREST_DISTANCE_M) ?? 8;
      const decelDist = (Constants.REEL_PROFILE && Constants.REEL_PROFILE.DECEL_DISTANCE_M) ?? 15;
      const distM = dist / M;
      reelPhase = distM <= arrestDist ? 'ARREST' : (distM <= decelDist ? 'RAMP' : 'HAUL');
    }
    eventBus.emit(Events.TETHER_REEL_STATE, {
      armIndex: this.index,
      reeling: true,
      speed: reelSpeed,
      phase: reelPhase,
      closingRate: reelSpeed,
    });
  }

  /**
   * RETURNING: return to parent without debris.
   *
   * 2026-06-12 (re-dock fix, Issue 8): like REELING (Issue 1 fix 2026-05-26),
   * empty-handed returns target the STRUT-TIP dock world position, NOT the
   * mother bus centre. Targeting `parentPos` flew the daughter into/behind the
   * hull (she "vanished" occluded for ~2 s while DOCKING lerped her back out),
   * and the strut-tip-anchored tether drew inward through the ship — reading
   * as a tether pointing 180° the wrong way.
   */
  _updateReturning(dt, parentPos, parentQuat) {
    // Detached arms can't return — switch to free-flying transit
    if (this.isDetached) {
      this._transitionTo(S.TRANSIT);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Cannot return. Tether severed. Free-flying.`,
        priority: 'warning',
      });
      return;
    }

    // Strut-tip dock world position: parentPos + parentQuat × dockOffset.
    // Falls back to parentPos if quaternion or dockOffset absent (test mocks).
    const dockWorldPos = this._tmpDockTarget || (this._tmpDockTarget = new THREE.Vector3());
    this._resolveStrutDockWorld(parentPos, parentQuat, dockWorldPos);

    const toParent = this._tmpVec.subVectors(dockWorldPos, this.position);
    const dist = toParent.length();

    toParent.normalize();
    const returnSpeed = this.config.approachSpeed * (this._beaconSpeedScale || 1);
    this.velocity.lerp(toParent.multiplyScalar(returnSpeed), 0.08);
    this.position.addScaledVector(this.velocity, dt);

    this.tetherLength = this.position.distanceTo(parentPos) / M;

    const dockThreshold = this.config.bodyDims[2] * M * 8;
    if (dist < dockThreshold) {
      this._transitionTo(S.DOCKING);
      eventBus.emit(Events.ARM_RETURNED, {
        armId: this.id, captured: false,
      });
    }
  }

  /** DOCKING: final alignment to dock offset (3s) */
  _updateDocking(dt, parentPos, parentQuat) {
    const dockWorldPos = _dockOffTmp.copy(this.dockOffset);
    if (parentQuat) dockWorldPos.applyQuaternion(parentQuat);
    dockWorldPos.add(parentPos);

    this.position.lerp(dockWorldPos, 0.05);

    // Keep the catch glued to us through the final dock approach too.
    this._pinCatchToSelf(parentPos);

    if (this.stateTimer > Constants.ARM_DOCK_DURATION) {
      // POLISH FIX: keep daughter VISIBLE at the strut after a successful
      // retrieval — set deploy state to DEPLOYED so PlayerSatellite.postArmUpdate
      // shows her clamped to the strut tip (instead of hiding her until next
      // undock).  Was previously left at LOCKED post-retrieval → invisible.
      if (this._deployState === Constants.DEPLOY_STATES.LOCKED ||
          this._deployState === Constants.DEPLOY_STATES.STOWED) {
        this._deployState = Constants.DEPLOY_STATES.DEPLOYED;
      }
      this.reeling = false;
      this.tetherTension = 0;

      // PARK-THE-CATCH (2026-06-06): a captured debris is NOT processed/removed
      // at the mother any more. The mother's furnace can't ingest a whole catch
      // yet (furnace-transfer + breakdown are unsolved/deferred), so the daughter
      // parks at her strut tip still holding the debris cinched in the net, full
      // size, indefinitely. She is now OCCUPIED — she does NOT reload her spring
      // and stays out of the deploy pool (HOLDING_CATCH is not DOCKED), leaving
      // the other daughters free to capture more. Keep `_capturedByArm` and
      // `_armPinned` set so the held net stays cinched (CaptureNet's held-net
      // release keys off `_capturedByArm`) and the debris stays pinned to the
      // strut. DEBRIS_CAPTURED is still emitted (capture-secured signal — drives
      // the first_capture teaching beat). Salvage/scoring and field removal now
      // fire on CATCH_PROCESSED (emitted by _updateHoldingCatch once the
      // furnace-transfer window elapses), NOT on dock arrival — see GameFlowManager.
      if (this.capturedDebris) {
        this.captures++;
        // Pin with the same lateral bias HOLDING_CATCH will use, so there's no
        // one-frame jump of the bag when the park state begins.
        this._pinCatchToSelf(parentPos, Constants.ARM_HOLD_LATERAL_BIAS ?? 0);
        this._breakdownStarted = false;     // reset staged-furnace bookkeeping (Item 1)
        this._breakdownChunksFired = 0;
        this._transitionTo(S.HOLDING_CATCH);
        eventBus.emit(Events.DEBRIS_CAPTURED, {
          debrisId: this.capturedDebris.id,
          armId: this.id,
          type: this.type,
          parked: true,                     // held at strut, not removed/processed
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: Catch secured at the strut. Holding in net (awaiting processing). Capture #${this.captures}.`,
          priority: 'success',
        });
        return;
      }

      // Empty return (e.g., a recoverable net failure sent her home without a
      // catch): the legacy reload path still applies.
      this.target = null;
      this._manualCapture = false;        // reset manual capture flag on re-dock
      this._nearbyDebris = [];

      // V5: After docking, reload the crossbow spring
      this._transitionTo(S.RELOADING);
      this.reloadProgress = 0;
      this.reloadDuration = 0; // Will be calculated in RELOADING state
      eventBus.emit(Events.CROSSBOW_RELOAD_START, {
        armIndex: this.index,
        duration: this.reloadDuration,
      });
    }
  }

  /**
   * HOLDING_CATCH: daughter is docked at her strut tip carrying a captured
   * debris cinched in the net, waiting for the (not-yet-implemented) furnace
   * transfer. She holds position like DOCKED but is intentionally NOT charged
   * and NOT in the DOCKED state, so `ArmManager._findDockedArm()` skips her and
   * the other daughters remain available. The captured debris is re-pinned to
   * the strut tip every frame (full size) so it never drifts or vanishes.
   * @private
   */
  _updateHoldingCatch(dt, parentPos, parentQuat) {
    // Clamp the daughter to her strut-tip dock (mirrors _updateDocked).
    this._lastParentQuat = parentQuat
      ? (this._lastParentQuatV || (this._lastParentQuatV = new THREE.Quaternion())).copy(parentQuat)
      : null;
    if (parentPos) {
      const offset = _dockOffTmp.copy(this.dockOffset);
      if (parentQuat) offset.applyQuaternion(parentQuat);
      this.position.copy(parentPos).add(offset);
    }
    this.tetherLine.visible = false;
    this.velocity.set(0, 0, 0);

    // If the catch was cleared elsewhere, fall back to reload immediately.
    if (!this.capturedDebris) {
      this._transitionTo(S.RELOADING);
      this.reloadProgress = 0;
      this.reloadDuration = 0;
      eventBus.emit(Events.CROSSBOW_RELOAD_START, {
        armIndex: this.index,
        duration: this.reloadDuration,
      });
      return;
    }

    // ── Staged furnace breakdown (Item 1) ────────────────────────────────────
    // Three phases off stateTimer (cumulative seconds from HOLDING_CATCH entry):
    //   hold [0, HOLD_S)        — catch full-size, cinched in the net (_capturedByArm
    //                             set so CaptureNet keeps the held net wrapped).
    //   chop [HOLD_S, CHOP_S)   — emit CATCH_BREAKDOWN_START once; release the net's
    //                             hold (_capturedByArm = null) so the bag visual can
    //                             follow the chop; mark debris._breakdownActive so the
    //                             furnace visual owns its scale/disposal.
    //   feed [CHOP_S, FEED_S)   — emit CHUNK_COUNT evenly-spaced CATCH_BREAKDOWN_CHUNK
    //                             events as chunks stream to the mother's furnace.
    //   at FEED_S               — emit the single CATCH_PROCESSED (unchanged payload /
    //                             single-fire contract — GameFlowManager + bosses) and
    //                             reload. Gameplay timing only MOVES to feed-end.
    // Phase boundaries come straight from the single authoritative constant —
    // no per-site fallback literals (they drifted-by-design risk vs ArmManager's
    // chop-window scale ramp, which reads the same keys).
    const FT = Constants.FURNACE_TRANSFER;
    const HOLD_S = FT.HOLD_S;
    const CHOP_S = FT.CHOP_S;
    const FEED_S = FT.FEED_S;
    const CHUNK_COUNT = FT.CHUNK_COUNT;
    const debris = this.capturedDebris;
    const t = this.stateTimer;

    // Lazy-init the per-park breakdown bookkeeping (also reset on entry in
    // _updateDocking). Safe if a test sets HOLDING_CATCH directly.
    if (this._breakdownStarted === undefined) this._breakdownStarted = false;
    if (this._breakdownChunksFired === undefined) this._breakdownChunksFired = 0;

    if (t < HOLD_S) {
      // hold: catch welded full-size, net still cinched. Lateral bias keeps the
      // bag off the camera→daughter axis so the parked daughter stays visible.
      this._pinCatchToSelf(parentPos, Constants.ARM_HOLD_LATERAL_BIAS ?? 0);
      return;
    }

    // Fire the chop-start exactly once when we cross into the chop phase.
    if (!this._breakdownStarted) {
      this._breakdownStarted = true;
      debris._breakdownActive = true;          // furnace visual owns scale/disposal
      debris._capturedByArm = null;            // release the held-net cinch
      eventBus.emit(Events.CATCH_BREAKDOWN_START, {
        armId: this.id, debrisId: debris.id, chunkCount: CHUNK_COUNT,
      });
      // Player-facing comms for the breakdown is owned by GameFlowManager's
      // CATCH_BREAKDOWN_START handler (single narrative owner) — no comms here.
    }

    // Keep the (now-breaking-down) catch pinned to the strut so it never drifts
    // while the furnace visual animates the chop. The visual owns the scale ramp.
    // Same lateral bias as the hold phase so the daughter stays clear of the bag.
    this._pinCatchToSelf(parentPos, Constants.ARM_HOLD_LATERAL_BIAS ?? 0);

    // feed: emit chunk events evenly across [CHOP_S, FEED_S).
    if (t >= CHOP_S && t < FEED_S) {
      const feedSpan = Math.max(1e-6, FEED_S - CHOP_S);
      const feedFrac = (t - CHOP_S) / feedSpan;             // 0 → 1 across feed
      const due = Math.min(CHUNK_COUNT, Math.floor(feedFrac * CHUNK_COUNT) + 1);
      while (this._breakdownChunksFired < due) {
        const index = this._breakdownChunksFired;            // 0-based
        eventBus.emit(Events.CATCH_BREAKDOWN_CHUNK, {
          armId: this.id, debrisId: debris.id, index, total: CHUNK_COUNT,
        });
        this._breakdownChunksFired++;
      }
      return;
    }

    if (t >= FEED_S) {
      // Flush any chunk events not yet emitted (e.g. a long frame skipped some).
      while (this._breakdownChunksFired < CHUNK_COUNT) {
        eventBus.emit(Events.CATCH_BREAKDOWN_CHUNK, {
          armId: this.id, debrisId: debris.id,
          index: this._breakdownChunksFired, total: CHUNK_COUNT,
        });
        this._breakdownChunksFired++;
      }

      // ── Furnace-transfer complete: hand the catch to the mother ──
      const debrisId = debris.id;
      // Release the daughter's pin so the furnace step owns the debris.
      debris._armPinned = false;
      debris._capturedByArm = null;
      debris._armPinPos = null;
      debris._breakdownActive = false;
      this.capturedDebris = null;
      this.reeling = false;
      this.tetherTension = 0;
      this._breakdownStarted = false;
      this._breakdownChunksFired = 0;
      // The successful catch consumed the net — fed in with the debris. Tell the
      // bag visual to draw itself toward the mother (§3.5: success consumes net).
      eventBus.emit(Events.NET_CONSUMED, { armIndex: this.index, armId: this.id });
      eventBus.emit(Events.CATCH_PROCESSED, { armId: this.id, debrisId, type: this.type });
      // Completion comms is owned by GameFlowManager's CATCH_PROCESSED handler.
      this._transitionTo(S.RELOADING);
      this.reloadProgress = 0;
      this.reloadDuration = 0;
      eventBus.emit(Events.CROSSBOW_RELOAD_START, {
        armIndex: this.index,
        duration: this.reloadDuration,
      });
    }
  }

  /**
   * RELOADING: V5 worm gear motor compresses crossbow spring.
   * Duration depends on launch speed² (energy-based).
   * @private
   */
  _updateReloading(dt) {
    if (this.reloadDuration <= 0) {
      // Calculate reload duration if not set
      const speed = this.launchSpeed;
      const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
      const energy = 0.5 * armMass * speed * speed;
      this.reloadDuration = energy / (CROSSBOW_RELOAD_POWER * CROSSBOW_WORM_GEAR_EFFICIENCY);
    }

    this.reloadProgress += dt / this.reloadDuration;

    if (this.reloadProgress >= 1.0) {
      this.reloadProgress = 1.0;
      this.springCharged = true;
      this._transitionTo(S.DOCKED);
      eventBus.emit(Events.CROSSBOW_RELOAD_COMPLETE, { armIndex: this.index, armId: this.id });
      eventBus.emit(Events.ARM_DOCKED, { armId: this.id });
    }
  }

  /** TRAWLING: slow sweep — passive debris collection along orbit path (Phase 6) */
  _updateTrawling(dt, parentPos) {
    this.mesh.visible = true;
    this.tetherLine.visible = true;

    // Track duration
    this._trawlTimer = (this._trawlTimer || 0) + dt;
    const maxDuration = (Constants.TRAWLING && Constants.TRAWLING.TRAWL_DURATION_MAX) || 120;

    if (this._trawlTimer >= maxDuration) {
      this._trawlingMode = false;
      eventBus.emit(Events.TRAWL_END, { armId: this.id });

      if (this.isDetached) {
        // Detached arms can't return — switch to free-flying transit
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: this.displayName, text: 'Trawl complete. Free-flying, no tether.', priority: 'info',
        });
        this._transitionTo(S.TRANSIT);
      } else {
        // V5: Use REELING for zero-fuel return
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: this.displayName, text: 'Trawl complete. Reeling in', priority: 'info',
        });
        this._transitionTo(S.REELING);
      }
      return;
    }

    // Consume fuel (very low rate)
    const fuelRate = (Constants.TRAWLING && Constants.TRAWLING.FUEL_RATE_TRAWL) || 0.002;
    this.fuel -= fuelRate * dt;

    // Detached trawling arms: fuel warnings (same thresholds as _consumeFuel)
    if (this.isDetached) {
      const fuelFrac = this.fuel / 100;
      if (fuelFrac <= Constants.DETACH_FUEL_WARNING_10 && !this._detachFuelWarning10) {
        this._detachFuelWarning10 = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `CRITICAL: ${this.displayName} fuel at 10%. Recommend immediate deorbit.`,
          priority: 'critical',
        });
      } else if (fuelFrac <= Constants.DETACH_FUEL_WARNING_25 && !this._detachFuelWarning25) {
        this._detachFuelWarning25 = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `WARNING: ${this.displayName} fuel at 25%. Limited maneuver capability.`,
          priority: 'warning',
        });
      }
    }

    // Tethered trawler that runs low holds her reserve and goes ADRIFT (the
    // mother can still reel her home) rather than being abandoned. Detached
    // trawlers have no winch — they are genuinely lost at zero.
    const trawlReserve = Constants.ARM_RESERVE_FUEL ?? 0;
    if (!this.isDetached && trawlReserve > 0 && this.fuel <= trawlReserve) {
      this.fuel = trawlReserve;
      this._trawlingMode = false;
      eventBus.emit(Events.TRAWL_END, { armId: this.id });
      this._enterAdrift();
      return;
    }

    if (this.fuel <= 0) {
      this.fuel = 0;
      this._trawlingMode = false;

      if (this.isDetached) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Daughter lost. ${this.displayName} fuel depleted. No thrust available.`,
          priority: 'critical',
        });
        eventBus.emit(Events.ARM_LOST, { armId: this.id });
      } else {
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: this.displayName, text: 'Trawl aborted. Fuel depleted', priority: 'warning',
        });
      }
      eventBus.emit(Events.TRAWL_END, { armId: this.id });
      eventBus.emit(Events.ARM_EXPENDED, { armId: this.id, type: this.type });
      this._transitionTo(S.EXPENDED);
      return;
    }

    // Move slowly in trawl direction at 30% of normal speed
    const speed = (this.config.approachSpeed || 0.000005) *
      ((Constants.TRAWLING && Constants.TRAWLING.TRAWL_SPEED_SCALE) || 0.3);

    if (this._trawlDirection) {
      this.position.x += this._trawlDirection.x * speed * dt;
      this.position.y += this._trawlDirection.y * speed * dt;
      this.position.z += this._trawlDirection.z * speed * dt;
    }

    // Update tether length and enforce tether limit
    this.tetherLength = this.position.distanceTo(parentPos) / M;

    if (!this.isDetached && this.tetherLength >= this.config.tetherMax * 0.95) {
      // Clamp to tether max — prevent over-extension (skip for detached arms)
      const dir = this._tmpVec.subVectors(this.position, parentPos).normalize();
      this.position.copy(parentPos).add(dir.multiplyScalar(this.config.tetherMax * 0.94 * M));
      this.tetherLength = this.config.tetherMax * 0.94;
    }

    // Check for nearby debris (auto-capture)
    const captureRadius = ((Constants.TRAWLING && Constants.TRAWLING.TRAWL_RADIUS_KM) || 0.05) * Constants.SCENE_SCALE;
    const maxCaptureMass = (Constants.TRAWLING && Constants.TRAWLING.AUTO_CAPTURE_MASS_MAX) || 50;

    // Emit event for debris field to check
    eventBus.emit(Events.TRAWL_CAPTURE, {
      armId: this.id,
      position: this.position.clone(),
      radius: captureRadius,
      maxMass: maxCaptureMass,
    });

    // Also check _nearbyDebris (passive proximity capture)
    if (this._nearbyDebris && this._nearbyDebris.length > 0) {
      for (const debris of this._nearbyDebris) {
        if (!debris.alive || !debris._scenePosition) continue;
        if (debris.mass > maxCaptureMass) continue;
        const dist = this.position.distanceTo(debris._scenePosition);
        if (dist < captureRadius) {
          // Trawl auto-capture!
          this.target = debris;
          this.capturedDebris = debris;
          debris._captured = true;  // UX Fix E+: hide reticle immediately
          debris._capturedByArm = this; // POLISH FIX issue #2: pin debris visual to arm during REELING
          this._trawlTimer = 0;
          this._trawlingMode = false;
          this._transitionTo(S.GRAPPLED);
          eventBus.emit(Events.ARM_CAPTURED, {
            armId: this.id, targetId: debris.id, type: this.type, mode: 'trawling',
            detached: this.isDetached,
            mass: debris.mass || 0, debrisType: debris.type || 'unknown',
            manual: false,
          });
          eventBus.emit(Events.COMMS_MESSAGE, {
            sender: this.displayName,
            text: `🎣 Trawl capture! ${debris.id} netted passively.`,
            priority: 'success',
          });
          eventBus.emit(Events.TRAWL_END, { armId: this.id });
          break;
        }
      }
    }
  }

  /** DEORBITING: burning all fuel retrograde until depleted, then removed (Session 10) */
  _updateDeorbiting(dt) {
    // Burn fuel at maximum rate (3× normal transit rate)
    const burnRate = 5.0; // %/sec — aggressive burn
    this.fuel -= burnRate * dt;

    // Move retrograde (opposite to orbital velocity direction = "slowing down")
    // F9: derive retrograde from the LIVE velocity vector, not `position × ŷ`.
    // The old cross-product assumed an equatorial orbit and pointed the wrong
    // way for inclined tracks (e.g. the 51.6° ISS-like orbits the sim uses).
    // (normalize() of a zero vector returns zero in THREE, so no NaN risk.)
    const retrograde = _goalDir.copy(this.velocity).normalize().negate();
    // ST-8.3.4: Use metal-specific thrust calculation
    const thrustDV = (this._computeMetalThrust() / (this.config.mass + (this.capturedDebris?.mass || 0))) * dt;
    this.velocity.add(retrograde.multiplyScalar(thrustDV));
    this.position.addScaledVector(this.velocity, dt);

    // Visual: mesh visible, thruster plume active
    this.mesh.visible = true;
    this.tetherLine.visible = false; // Tether detached for deorbit

    // Fuel depleted — sacrifice complete
    if (this.fuel <= 0) {
      this.fuel = 0;
      // Remove arm + debris from scene
      this.mesh.visible = false;
      this.group.visible = false;
      this._transitionTo(S.EXPENDED);

      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: Fuel exhausted. Deorbit burn complete. Daughter lost.`,
        priority: 'warning',
      });
    }
  }

  /** WEB_SHOT: brief GSL web launch animation (~2s), then emit hit event (Sprint D1) */
  _updateWebShot(dt, parentPos) {
    this.mesh.visible = true;
    this.tetherLine.visible = true;

    // Extend arm briefly toward target direction from its origin position
    const tPos = this._webShotTarget?._scenePosition;
    const origin = this._webShotOrigin;
    if (tPos && origin) {
      const toTarget = this._tmpVec.subVectors(tPos, origin).normalize();
      const extendDist = this.config.bodyDims[2] * M * 10 * (this.stateTimer / Constants.WEB_SHOT_DURATION);
      this.position.copy(origin).add(toTarget.multiplyScalar(extendDist));
    }

    // Update tether length
    if (parentPos) {
      this.tetherLength = this.position.distanceTo(parentPos) / M;
    }

    // After duration: emit hit, start cooldown, return to previous state
    if (this.stateTimer >= Constants.WEB_SHOT_DURATION) {
      // Emit web shot hit event
      const debrisId = this._webShotTarget?.id;
      if (debrisId !== undefined && debrisId !== null) {
        eventBus.emit(Events.WEB_SHOT_HIT, {
          debrisId,
          dragMultiplier: Constants.WEB_SHOT_DRAG_MULT,
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.displayName}: 🕸 Web hit! Debris ${debrisId} drag ×${Constants.WEB_SHOT_DRAG_MULT}`,
          priority: 'success',
        });
      }

      // Start cooldown
      this._webShotCooldown = Constants.WEB_SHOT_COOLDOWN;
      this._webShotTarget = null;

      // Return to previous state
      this._transitionTo(this._webShotPrevState);
    }
  }

  /**
   * ABLATING: V5 laser ablation for de-spin/nudge.
   * 10W laser applies torque to reduce target angular velocity.
   * @private
   */
  _updateAblating(dt) {
    this.ablationTimer += dt;

    // Check range to target
    if (this.ablationTarget) {
      const targetPos = this.ablationTarget.mesh ? this.ablationTarget.mesh.position : null;
      if (targetPos) {
        const range = this.position.distanceTo(targetPos) / M;
        if (range > ABLATION_RANGE_MAX) {
          // Out of range — stop ablation
          this._endAblation('outOfRange');
          return;
        }

        // Apply de-spin torque to target (if it has angular velocity)
        if (this.ablationTarget.angularVelocity !== undefined) {
          const despin = ABLATION_DESPIN_RATE * dt;
          const av = this.ablationTarget.angularVelocity;
          if (Math.abs(av) > despin) {
            this.ablationTarget.angularVelocity -= Math.sign(av) * despin;
          } else {
            this.ablationTarget.angularVelocity = 0;
          }
        }
      }
    }

    if (this.ablationTimer >= ABLATION_DURATION_MAX) {
      this._endAblation('timeout');
    }
  }

  /**
   * End ablation and return to transit.
   * @private
   * @param {string} reason - Why ablation ended
   */
  _endAblation(reason) {
    eventBus.emit(Events.ABLATION_END, {
      armIndex: this.index,
      despinAchieved: reason !== 'outOfRange',
    });
    this.ablationTimer = 0;
    this.ablationTarget = null;
    this._transitionTo(S.TRANSIT); // Return to transit to come back
  }

  /**
   * SCANNING: V5 pulse scan — arm acts as distributed sensor node.
   * Duration managed by ArmManager (orchestrates all arms together).
   * Individual arm just holds position and emits sensor data.
   * @private
   */
  _updateScanning(dt) {
    this._scanTimer = (this._scanTimer || 0) + dt;

    if (this._scanTimer >= PULSE_SCAN_DURATION) {
      this._scanTimer = 0;
      this._transitionTo(this._preScanState || S.DOCKED);
      this._preScanState = null;
    }
  }

  /**
   * ADRIFT: out of usable FEEP but STILL TETHERED and powered. Thrusters are
   * offline (the working tank is empty), yet avionics/beacon run on the reserve
   * and the mother's winch can pull her home, so she stays fully recoverable —
   * the player can reel her in (R), select/pilot her (1-4), or disconnect her.
   * She drifts gently at the end of the tether (no active thrust); the tether
   * line and tension are handled by _updateTether as for any deployed daughter.
   */
  _updateAdrift(dt) {
    this.position.addScaledVector(this.velocity, dt * 0.5);
    this.velocity.multiplyScalar(0.99); // slow residual drift; the tether holds her
    this.mesh.visible = true;
  }

  /**
   * Transition a tethered daughter into ADRIFT (out of usable propellant but
   * recoverable). Plain-language comms so the player understands WHAT happened
   * and WHAT they can do — never the bare, scary "expended". Guarded so the
   * message fires once per adrift episode.
   * @private
   */
  _enterAdrift() {
    if (this.state === S.ADRIFT || this.state === S.EXPENDED || this.isDetached) return;
    this._manualMode = false;
    this._trawlingMode = false;
    this._transitionTo(S.ADRIFT);
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'HOUSTON',
      channel: 'CMD',
      text: `${this.displayName}: FEEP propellant spent. Thrusters offline, but she's still on the tether and powered. Press R to reel her home (winch, no fuel needed) or disconnect. Not lost.`,
      priority: 'warning',
    });
  }

  /** EXPENDED: no fuel, drifting */
  _updateExpended(dt) {
    this.position.addScaledVector(this.velocity, dt * 0.5);
    this.velocity.multiplyScalar(0.999);
    this.mesh.visible = true;
    // A severed tether shows no line back to the mother (the cable parted).
    this.tetherLine.visible = !this._tetherSevered;

    // Bounded cleanup of a tether-snapped catch: it tumbles off pinned to this
    // drifting daughter for a short while, then we release the pin so the
    // runaway debris resumes its own orbit + LOD (otherwise it would render at
    // full detail forever and never be reclaimed by the field).
    if (this._severedCatch) {
      // If another daughter re-captured the runaway, the pin has transferred —
      // stop tracking it here.
      if (this._severedCatch._capturedByArm !== this) {
        this._severedCatch = null;
      } else {
        // Keep the catch glued to this drifting daughter (authoritative pin).
        this._severedCatch._armPinPos = this._severedCatch._armPinPos
          ? this._severedCatch._armPinPos.copy(this.position)
          : this.position.clone();
        this._severedCatch._armPinned = true;
        this._severedDriftS += dt;
        if (this._severedDriftS >= (Constants.TETHER_SNAP_RELEASE_DELAY_S || 8.0)) {
          this._severedCatch._capturedByArm = null; // resume orbit-driven position + LOD
          this._severedCatch._armPinned = false;
          this._severedCatch = null;
        }
      }
    }
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  /** @private Fuel consumption by state */
  _consumeFuel(dt) {
    // Rates in %/sec — tuned so a full deploy-capture-return cycle ≈30-60s gameplay
    const rates = {
      [S.UNDOCKING]: 0.2,
      [S.LAUNCHING]: 0.0,         // V5: Spring provides energy, no fuel burn
      [S.TRANSIT]: 1.5,
      [S.APPROACH]: 1.0,
      [S.NETTING]: 0.3,
      [S.GRAPPLED]: 0.2,
      [S.HAULING]: 2.0,
      [S.REELING]: 0.0,           // V5: Zero-fuel motor reel-in
      [S.RETURNING]: 1.2,
      [S.DOCKING]: 0.2,
      [S.RELOADING]: 0.0,         // V5: worm gear — zero FEEP fuel (no stored-energy model)
      [S.WEB_SHOT]: 0.0,          // Fuel consumed upfront in fireWebShot()
      [S.ABLATING]: 0.0,          // V5: laser de-spin — zero FEEP fuel (no stored-energy model)
      [S.SCANNING]: 0.0,          // V5: sensor mode — zero FEEP fuel (no stored-energy model)
    };
    let rate = rates[this.state] || 0;
    // REEL_PROFILE_V2 (plan Q4): the re-dock arrest is charged ONCE as a discrete
    // mass-scaled debit during REELING. Suppress the per-state DOCKING rate for
    // the cycle that fired it so the FEEP burn isn't double-charged. The flag is
    // cleared on the next clean dock/reload cycle (in _transitionTo).
    if (this.state === S.DOCKING && this._redockDebitApplied === true) rate = 0;
    this.fuel -= rate * dt;

    // === Detached arm fuel warnings (Phase 6 — no refuel possible) ===
    if (this.isDetached) {
      const fuelFrac = this.fuel / 100;

      if (fuelFrac <= Constants.DETACH_FUEL_WARNING_25 && !this._detachFuelWarning25) {
        this._detachFuelWarning25 = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `WARNING: ${this.displayName} fuel at 25%. Limited maneuver capability.`,
          priority: 'warning',
        });
      }
      if (fuelFrac <= Constants.DETACH_FUEL_WARNING_10 && !this._detachFuelWarning10) {
        this._detachFuelWarning10 = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `CRITICAL: ${this.displayName} fuel at 10%. Recommend immediate deorbit.`,
          priority: 'critical',
        });
      }
    }

    // ── Emergency reserve: a TETHERED daughter never strands herself ──────────
    // She holds ARM_RESERVE_FUEL back so the mother can reel her home under
    // control (tether tension + soft-dock arrest, so neither she nor her catch
    // slams the strut). Hitting the reserve while working/flying means "no usable
    // propellant" — but she is NOT lost: avionics/beacon stay live and she goes
    // ADRIFT (recoverable, fully commandable on the tether). Detached daughters
    // have no winch, so the reserve can't save them — they fall through to the
    // genuine-loss path below.
    const reserve = Constants.ARM_RESERVE_FUEL ?? 0;
    if (!this.isDetached && reserve > 0 && this.fuel <= reserve && this.state !== S.ADRIFT) {
      if (this.state === S.RETURNING) {
        // Can't fly home on the reserve. Hand off to the mother's zero-fuel winch
        // so the reserve survives for the soft-dock arrest.
        this._transitionTo(S.REELING);
        eventBus.emit(Events.COMMS_MESSAGE, {
          source: 'HOUSTON', channel: 'CMD',
          text: `${this.displayName}: FEEP reserve only. Finishing the return on the winch.`,
          priority: 'warning',
        });
        eventBus.emit(Events.ARM_RECALLED, { armId: this.id });
        return;
      }
      if (this.state !== S.DOCKING) {
        // Working daughter (transit / approach / netting / hauling / …) has spent
        // her usable propellant. Lock the reserve and go ADRIFT — tethered,
        // powered, recoverable. DOCKING is exempt: she is allowed to spend the
        // reserve on the final arrest.
        this.fuel = reserve;
        this._enterAdrift();
        return;
      }
    }

    if (this.fuel <= 0) {
      this.fuel = 0;

      // Detached arms that run out of fuel: no tether to winch home — genuinely lost.
      if (this.isDetached) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Daughter lost. ${this.displayName} fuel depleted. No thrust available.`,
          priority: 'critical',
        });
        eventBus.emit(Events.ARM_LOST, { armId: this.id });
        eventBus.emit(Events.ARM_EXPENDED, { armId: this.id, type: this.type });
        this._transitionTo(S.EXPENDED);
        return;
      }

      // Non-detached daughter that drained the reserve during the dock itself:
      // the winch still eases her in (REDOCK_FEEP FUEL_FALLBACK_SLOW), so a
      // tethered daughter is never abandoned. Hold at empty and let the dock
      // finish on motor power.
      if (this.state === S.DOCKING) return;

      // Any other state hitting true zero with no tether benefit is spent.
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.displayName}: FUEL DEPLETED. Daughter expended`,
        priority: 'critical',
      });
      eventBus.emit(Events.ARM_EXPENDED, { armId: this.id, type: this.type });
      this._transitionTo(S.EXPENDED);
    }
  }

  /**
   * @private Update tether visual between parent and arm.
   * C-3: Uses strut tip as mother-side anchor when Config G geometry is available.
   * Falls back to parentPos (mother center) when geometry is absent (pre-C-3 compat).
   * @param {THREE.Vector3} parentPos — mother world position
   * @param {THREE.Quaternion} [parentQuat] — mother world orientation (for strut tip calc)
   * @param {number} [dt] — frame delta (seconds) for REELING dash-flow animation
   */
  _updateTether(parentPos, parentQuat, dt) {
    // States where the daughter is AT (or arriving at) her strut-tip dock —
    // no tether should render. REELING/RETURNING already snap her to the strut
    // tip before entering DOCKING (Issue 1/8 fixes), so by DOCKING the cable
    // spans ~0 and carries no information; rendering it only exposes the
    // one-frame-stale counter-rotation flash (Mechanism B — pose error nears
    // 180° at DOCKING entry), which read as a "wrong-way 180° tether". DOCKED /
    // RELOADING / HOLDING_CATCH likewise park at the strut. _updateTether runs
    // AFTER the per-state handler, so without this early-out it re-shows a
    // stray, wrong-direction tether for the whole window.
    if (this.state === S.DOCKED || this.state === S.DOCKING ||
        this.state === S.RELOADING || this.state === S.HOLDING_CATCH) {
      this.tetherLine.visible = false;
      return;
    }
    // Detached arms have no tether to render
    if (this.isDetached) {
      this.tetherLine.visible = false;
      return;
    }

    // C-7: When TETHER_REEL flag is ON, hide tether if reel is CUT
    if (Constants.FEATURE_FLAGS.TETHER_REEL) {
      const reelState = tetherReel.getReelState(this.index);
      if (reelState === Constants.REEL_STATES.CUT) {
        this.tetherLine.visible = false;
        return;
      }
    }

    if (this.state === S.EXPENDED) {
      // Tether still visible but dimmed
      this.tetherMaterial.opacity = 0.2;
    }
    this.tetherLine.visible = true;

    // C-7: Strain-based color only when TETHER_REEL feature flag is ON
    // (authoritative tension/length from reel system). When OFF, keep
    // nominal Dyneema color — the distance-based strain calculation was
    // causing erratic red/white flashing due to orbital frame artifacts.
    if (Constants.FEATURE_FLAGS.TETHER_REEL) {
      const cableLen = tetherReel.getCableLength(this.index);
      const maxLen = tetherReel.getMaxCableLength(this.index);
      let strain = maxLen > 0 ? cableLen / maxLen : 0;
      const tensionN = tetherReel.getTensionN(this.index);
      const breakingN = Constants.OCTOPUS_V5.REEL.BREAKING_TENSION_N;
      const tensionFrac = breakingN > 0 ? tensionN / breakingN : 0;
      strain = Math.max(strain, tensionFrac);

      if (strain > 0.7 && this.state !== S.DOCKED && this.state !== S.EXPENDED) {
        eventBus.emit(Events.TETHER_TENSION, { tensionFraction: strain, armId: this.id });
      }

      if (strain > 0.9) {
        this.tetherMaterial.color.setHex(Constants.TETHER_COLOR_CRITICAL);
      } else if (strain > 0.7) {
        this.tetherMaterial.color.setHex(Constants.TETHER_COLOR_STRESSED);
      } else {
        this.tetherMaterial.color.setHex(Constants.TETHER_COLOR_NOMINAL);
      }
    }
    // When TETHER_REEL is OFF: color stays at NOMINAL (set during construction).
    // No per-frame color updates — eliminates red/white flashing artifact.
    this.tetherMaterial.opacity = (this.state === S.EXPENDED) ? 0.2 : 0.9;

    // Compute mother-side anchor point — strut tip via dockOffset (PlayerSatellite frame),
    // or fallback to parentPos (bus center, pre-Config-G behavior).
    let anchorPos = parentPos;
    if (this.dockOffset && parentQuat) {
      anchorPos = this.getTetherAnchorWorldPosition(parentPos, parentQuat);
    }

    // Update geometry — catenary sag (perpendicular to tether direction)
    // Tether line is child of this.group (identity rotation, positioned at this.position),
    // so vertex positions are in GROUP-LOCAL coordinates (world offset by this.position).
    // Directions in group-local space equal directions in world space.
    const posArr = this.tetherLine.geometry.attributes.position.array;
    const segments = Constants.TETHER_SEGMENTS;

    // Compute tether vector in group-local space (anchor → arm origin)
    const dx = anchorPos.x - this.position.x;
    const dy = anchorPos.y - this.position.y;
    const dz = anchorPos.z - this.position.z;
    const separation = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // If separation is near-zero, draw all vertices at origin
    if (separation < Constants.TETHER_SAG_PARALLEL_THRESHOLD) {
      for (let i = 0; i < segments; i++) {
        const idx = i * 3;
        posArr[idx] = 0; posArr[idx + 1] = 0; posArr[idx + 2] = 0;
      }
      this.tetherLine.geometry.attributes.position.needsUpdate = true;
      return;
    }

    // Tether direction (unit vector)
    const tHatX = dx / separation;
    const tHatY = dy / separation;
    const tHatZ = dz / separation;

    // Project world-down (0, -1, 0) onto the plane perpendicular to tether direction
    // sagDir = worldDown - (worldDown · tHat) * tHat
    const dotDown = -tHatY; // (0,-1,0) · tHat
    let sagX = 0 - dotDown * tHatX;
    let sagY = -1 - dotDown * tHatY;
    let sagZ = 0 - dotDown * tHatZ;
    let sagMag = Math.sqrt(sagX * sagX + sagY * sagY + sagZ * sagZ);

    // Degenerate case: tether nearly aligned with gravity — fall back to world +Z
    if (sagMag < Constants.TETHER_SAG_PARALLEL_THRESHOLD) {
      const dotZ = tHatZ; // (0,0,1) · tHat
      sagX = 0 - dotZ * tHatX;
      sagY = 0 - dotZ * tHatY;
      sagZ = 1 - dotZ * tHatZ;
      sagMag = Math.sqrt(sagX * sagX + sagY * sagY + sagZ * sagZ);
    }

    // Normalize sag direction
    if (sagMag > Constants.TETHER_SAG_PARALLEL_THRESHOLD) {
      sagX /= sagMag; sagY /= sagMag; sagZ /= sagMag;
    } else {
      sagX = 0; sagY = 0; sagZ = 0; // Truly degenerate — no sag
    }

    // Sag amplitude: proportional to current separation (not max tether length)
    const sagAmp = separation * Constants.TETHER_SAG_FACTOR;

    for (let i = 0; i < segments; i++) {
      const t = i / (segments - 1);
      const invT = 1 - t;
      const bell = Math.sin(t * Math.PI);
      const idx = i * 3;
      posArr[idx]     = dx * invT + sagX * bell * sagAmp;
      posArr[idx + 1] = dy * invT + sagY * bell * sagAmp;
      posArr[idx + 2] = dz * invT + sagZ * bell * sagAmp;
    }
    this.tetherLine.geometry.attributes.position.needsUpdate = true;

    // Item 11 (2026-06-12): REELING motion cue — a brightness pulse travels
    // along the gradient toward the mother (anchor), replacing the old
    // LineDashedMaterial dash-phase scroll. Phase 1 → 0 maps daughter → anchor.
    if (this.state === S.REELING && typeof dt === 'number' && dt > 0) {
      const _rs = (this.capturedDebris !== null
        ? REEL_IN_SPEED_LOADED : REEL_IN_SPEED_EMPTY);
      // Pulse speed: one full traverse per (separation / reelSpeed) seconds,
      // i.e. the pulse moves at the reel speed along the cable; minimum rate
      // keeps it visible on very short tethers.
      const sepM = Math.max(1, separation / M);
      const rate = Math.max(0.25, _rs / sepM);          // traversals per second
      this._tetherPulsePhase = (this._tetherPulsePhase ?? 1) - rate * dt;
      if (this._tetherPulsePhase < 0) this._tetherPulsePhase += 1;
      this._tetherWriteGradient(this._tetherPulsePhase);
    } else if (this._tetherPulsePhase !== undefined) {
      // Leaving REELING: restore the static gradient once.
      this._tetherPulsePhase = undefined;
      this._tetherWriteGradient(-1);
    }

    // FIX: Tether vertices are computed as WORLD-SPACE offsets from arm.position,
    // but the tether line is a child of arm.group which has a non-identity quaternion
    // (set by attitude control to align the arm mesh with its heading). This rotation
    // was being applied to the tether vertices, causing the tether to "drift off
    // parallel to mother" instead of connecting reel to arm.
    // Counteract the group rotation so tether renders in world orientation.
    this.tetherLine.quaternion.copy(this.group.quaternion).invert();
  }

  /** @private S3.6: Update bridle visibility + color to mirror tether state */
  _updateBridle() {
    if (!this._bridleLegA) return;
    const show = this.tetherLine && this.tetherLine.visible;
    // Hide during slack phase (first 0.3m post-launch, per §13.4.1)
    const pastSlack = this.tetherLength > 0.3;
    const visible = show && pastSlack;
    this._bridleLegA.visible = visible;
    this._bridleLegB.visible = visible;
    // Gate the gimbal ring + hardpoints with the legs so the bridle hardware only
    // appears while the tether/bridle is deployed (they read as clutter floating
    // on the docked body otherwise). Refs stored at build time (L722, L733–734).
    if (this._gimbalRing) this._gimbalRing.visible = visible;
    if (this._bridleHpA) this._bridleHpA.visible = visible;
    if (this._bridleHpB) this._bridleHpB.visible = visible;
    // Color: mirror tether material (same strain logic drives both)
    if (visible && this._bridleLegMat && this.tetherMaterial) {
      this._bridleLegMat.color.copy(this.tetherMaterial.color);
      this._bridleLegMat.opacity = this.tetherMaterial.opacity;
    }
    // KNOWN: gimbal ring rotates with daughter body (physically should track
    // tether direction). Acceptable at gameplay distances. Future: §13.7.3.
  }

  /** @private Thruster plume animation */
  _updatePlumes(dt) {
    const isThrusting = [S.TRANSIT, S.APPROACH, S.HAULING, S.RETURNING, S.WEB_SHOT, S.REELING].includes(this.state);
    // Frame-rate-independent shimmer (two sines, ±~5%) — replaces per-frame
    // Math.random() fire flicker; ion emission is steady.
    const t = Date.now() * 0.001;
    const shimmer = 1 + 0.035 * Math.sin(t * 6.7) + 0.02 * Math.sin(t * 12.1);
    const lenS = 0.85 * shimmer;
    for (const plume of this._thrusterPlumes) {
      if (isThrusting) {
        plume.visible = true;
        plume.scale.set(1, lenS, 1);                 // grow aft; width steady
        // Type-tinted outer halo runs ~0.4× the core opacity (per-type ID at range).
        plume.material.opacity = (plume === this._plumeHalo) ? 0.24 : 0.6;
      } else {
        plume.visible = false;
        plume.material.opacity = 0;
      }
    }
  }

  /** @private Status light color based on state */
  _updateStatusLight(dt) {
    if (!this._statusLightMat) return;
    const blink = Math.sin(this.stateTimer * 4) > 0;

    // Detached arms: fast pulsing red override (regardless of state)
    if (this.isDetached) {
      const fastPulse = Math.sin(this.stateTimer * 10) > 0; // 2.5× faster pulse
      this._statusLightMat.color.setHex(fastPulse ? 0xff0000 : 0x440000);
      this._syncStatusHalo();
      return;
    }

    switch (this.state) {
      case S.DOCKED:     this._statusLightMat.color.setHex(0x00ff44); break;
      case S.UNDOCKING:  this._statusLightMat.color.setHex(blink ? 0xffff00 : 0x444400); break;
      case S.LAUNCHING:  this._statusLightMat.color.setHex(blink ? 0xff8800 : 0x884400); break;
      case S.TRANSIT:    this._statusLightMat.color.setHex(0x4488ff); break;
      case S.APPROACH:   this._statusLightMat.color.setHex(blink ? 0xff8800 : 0x442200); break;
      case S.NETTING:    this._statusLightMat.color.setHex(blink ? 0xff00ff : 0x440044); break;
      case S.GRAPPLED:   this._statusLightMat.color.setHex(0x00ffff); break;
      case S.HAULING:    this._statusLightMat.color.setHex(0x00ff88); break;
      case S.REELING:    this._statusLightMat.color.setHex(blink ? 0x00ffaa : 0x004422); break;
      case S.RETURNING:  this._statusLightMat.color.setHex(0x4488ff); break;
      case S.DOCKING:    this._statusLightMat.color.setHex(blink ? 0xffff00 : 0x444400); break;
      case S.RELOADING:  this._statusLightMat.color.setHex(blink ? 0xaaaa00 : 0x333300); break;
      case S.TRAWLING:   this._statusLightMat.color.setHex(blink ? 0x44aaff : 0x002244); break;
      case S.DEORBITING: this._statusLightMat.color.setHex(blink ? 0xff4400 : 0x441100); break;
      case S.WEB_SHOT:   this._statusLightMat.color.setHex(blink ? 0xffffff : 0x448844); break;
      case S.ABLATING:   this._statusLightMat.color.setHex(blink ? 0xff4488 : 0x441122); break;
      case S.SCANNING:   this._statusLightMat.color.setHex(blink ? 0x88ffff : 0x224444); break;
      case S.STATION_KEEP: this._statusLightMat.color.setHex(blink ? 0x00ffaa : 0x004422); break;
      case S.ADRIFT:     this._statusLightMat.color.setHex(blink ? 0xffaa00 : 0x442200); break;
      case S.EXPENDED:   this._statusLightMat.color.setHex(0xff0000); break;
    }
    this._syncStatusHalo();
  }

  /**
   * @private Mirror the status-light core colour onto its additive halo (×HDR),
   * so the glow always matches the current state and breathes with the blink
   * (the bright/dim per-state hex carries the phase). Cheap, null-safe.
   */
  _syncStatusHalo() {
    const halo = this._statusLightHalo;
    if (!halo) return;
    halo.material.color.copy(this._statusLightMat.color).multiplyScalar(1.8);
  }

  /**
   * D4 (hotkey revamp 2026-06-14): mark this daughter as the selected plate so
   * its body glows/flashes. Called by ArmManager on ARM_SELECT/ARM_DESELECT.
   * The visual pulse itself runs every frame in _updateSelectGlow(); this just
   * flips the flag and immediately restores the base emissive on deselect so a
   * non-updating (e.g. paused) frame doesn't leave the arm stuck lit.
   * @param {boolean} on
   */
  setSelectedHighlight(on) {
    const next = !!on;
    if (next === this._selected) return;
    this._selected = next;
    if (!next) this._restoreSelectGlow();
  }

  /** @private Restore body facet emissive to its recorded base values. */
  _restoreSelectGlow() {
    for (const e of this._selectGlowMats) {
      e.mat.emissive.setHex(e.baseEmissive);
      e.mat.emissiveIntensity = e.baseIntensity;
    }
  }

  /**
   * @private Pulse the body facet emissive while selected (D4). A cyan flash
   * sinusoidally modulates emissiveIntensity above the base value so the
   * selected daughter "breathes" — clearly readable on a docked plate while
   * the mother stays in view. No-op (cheap early return) when not selected.
   */
  _updateSelectGlow(dt) {
    if (!this._selected || this._selectGlowMats.length === 0) return;
    // ~1.4 Hz breath; intensity rides from base → base + 0.9.
    const pulse = 0.5 + 0.5 * Math.sin(this.stateTimer * 9.0);
    const SELECT_EMISSIVE = 0x00d4ff;   // HUD cyan accent
    for (const e of this._selectGlowMats) {
      e.mat.emissive.setHex(SELECT_EMISSIVE);
      e.mat.emissiveIntensity = e.baseIntensity + 0.25 + 0.9 * pulse;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ST-9.4 C-6: CAPTURE NET INVENTORY
  // Per CAPTURE_NET.md §6.1 — weaver=Medium Net (Large Daughter, magazine 2),
  // spinner=Small Net (Small Daughter, magazine 4) at Y0.
  // Gated by FEATURE_FLAGS.CAPTURE_NET. When OFF: inventory stays 0.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Initialise net inventory from CAPTURE_NET constants for this arm's type.
   * Called by CaptureNetSystem.init() or ArmManager after arm creation.
   */
  initNetInventory() {
    if (!Constants.isFeatureEnabled('CAPTURE_NET')) return;
    const type = this.config.type;
    // Net class — Weaver carries the Medium net (Large Daughter), Spinner the
    // Small net (Small Daughter) (CAPTURE_NET.md §6.1).
    const netClass = type === 'weaver' ? Constants.CAPTURE_NET.MEDIUM : Constants.CAPTURE_NET.SMALL;
    // Magazine capacity is sourced from the net class's MAGAZINE_SIZE. The
    // ARM_NET_CAPACITY constant mirrors these values (drift-guard test enforces
    // equality); we seed from MAGAZINE_SIZE so the net class stays authoritative.
    const capacity = (netClass && netClass.MAGAZINE_SIZE) ?? Constants.ARM_NET_CAPACITY[type] ?? 0;
    this._netInventoryMax = capacity;
    this._netInventory = capacity;
    this._netRatedMass = (netClass && netClass.MAX_CAPTURE_MASS) || 0;
    this._netDiameter = (netClass && netClass.DIAMETER) || 0;
  }

  /** Current net count remaining in magazine. */
  getNetInventory() { return this._netInventory; }

  /** Maximum net magazine capacity. */
  getNetInventoryMax() { return this._netInventoryMax; }

  /**
   * Set net inventory directly (persistence restore / shop reload).
   * Delegation 4 (2026-05-31): emits NET_INVENTORY_CHANGED so
   * dependent HUD panels stay in sync when the count is adjusted
   * outside of CaptureNet's own fire/reload path.
   * @param {number} count
   */
  setNetInventory(count) {
    this._netInventory = Math.max(0, Math.min(count, this._netInventoryMax || count));
    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'daughter',
      armIndex: this.index ?? null,
      nets: this._netInventory,
      max:  this._netInventoryMax,
    });
  }

  /**
   * Consume one net from the magazine. Returns the remaining count.
   * Delegation 4 (2026-05-31): emits NET_INVENTORY_CHANGED so
   * NetInventoryPanel updates immediately on any decrement point,
   * even if CaptureNet also emits (NetInventoryPanel re-polls
   * idempotently — the second signal is a cheap no-op).
   * @returns {number} remaining inventory (0 if already empty)
   */
  decrementNetInventory() {
    if (this._netInventory > 0) this._netInventory--;
    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'daughter',
      armIndex: this.index ?? null,
      nets: this._netInventory,
      max:  this._netInventoryMax,
    });
    return this._netInventory;
  }

  /**
   * Reload magazine to full capacity (shop / between missions).
   * Delegation 4 (2026-05-31): emits NET_INVENTORY_CHANGED so the
   * HUD chip updates when the player purchases a net reload in shop.
   */
  reloadNetInventory() {
    this._netInventory = this._netInventoryMax;
    eventBus.emit(Events.NET_INVENTORY_CHANGED, {
      source: 'daughter',
      armIndex: this.index ?? null,
      nets: this._netInventory,
      max:  this._netInventoryMax,
    });
  }

  /**
   * Dispose of all Three.js resources.
   */
  dispose() {
    const disposeMat = (m) => {
      if (!m) return;
      // Dispose per-instance textures (e.g. cloned solar-cell map/emissiveMap)
      // — material.dispose() does NOT free attached textures.
      if (m.map && m.map.dispose) m.map.dispose();
      if (m.emissiveMap && m.emissiveMap.dispose && m.emissiveMap !== m.map) m.emissiveMap.dispose();
      m.dispose();
    };
    this.group.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(disposeMat);
        } else {
          disposeMat(child.material);
        }
      }
    });
    if (this.scene) this.scene.remove(this.group);
  }
}
