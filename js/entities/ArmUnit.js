/**
 * ArmUnit.js — Autonomous arm unit (V5 Crossbow ADR satellite)
 * Supports both Weaver (large, 6.6kg V5, reel on mothership)
 * and Spinner (small, 2.1kg V5, reel on mothership) types.
 * V5 State machine: DOCKED → LAUNCHING → TRANSIT → APPROACH →
 *   NETTING → GRAPPLED → REELING → DOCKING → RELOADING →
 *   FISHING → TRAWLING → ABLATING → SCANNING → TANGLED → EXPENDED
 * Legacy states (UNDOCKING, HAULING, RETURNING) preserved for backward compat.
 * @module entities/ArmUnit
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { getSolarCellTexture } from '../scene/solarCellTexture.js';
import { tetherReel } from '../systems/TetherReel.js';
import { captureNetSystem } from './CaptureNet.js';
import { audioSystem } from '../systems/AudioSystem.js';

/** 1 meter in scene units (1 scene unit = 100 km) */
const M = 0.00001;

// ──────────────────────────────────────────────────────────────────────────
// [DBG-ARM] Temporary debug helpers — remove after diagnosing orient/camera bugs
// ──────────────────────────────────────────────────────────────────────────
const _DBG_ARM_RAD = 180 / Math.PI;
const _dbgArmVec   = (v) => v ? `(${(v.x/M).toFixed(1)},${(v.y/M).toFixed(1)},${(v.z/M).toFixed(1)})m` : 'null';
const _dbgArmDir   = (v) => v ? `(${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)})` : 'null';
const _dbgArmEulerDeg = (q) => {
  if (!q) return 'null';
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return `(${(e.x*_DBG_ARM_RAD).toFixed(1)},${(e.y*_DBG_ARM_RAD).toFixed(1)},${(e.z*_DBG_ARM_RAD).toFixed(1)})°`;
};

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
  TANGLE_DETECT_ANGLE, TANGLE_RESOLVE_TIME, TANGLE_SLACK_PULSE,
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

    // Fishing/ambush mode state
    this._fishingMode = false;
    this._fishingDir = null;
    this._fishingDeployTarget = 0;
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

    // V5 Ablation state
    this.ablationTarget = null;            // Target being ablated
    this.ablationTimer = 0;                // Time spent ablating

    // V5 Tangle state
    this.tangleTimer = 0;                  // Time spent resolving tangle
    this.tanglePartner = null;             // Other arm involved in tangle

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
    this._skSnapBack = false;               // true while a "recenter now" request is in flight
    this._standoffR = 5;                    // current standoff radius in metres
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

    // S3.6: Bridle visual references (populated in _createMesh)
    this._gimbalRing = null;
    this._bridleLegA = null;
    this._bridleLegB = null;
    this._bridleLegMat = null;
    this._bridleHpA = null;
    this._bridleHpB = null;

    this._createMesh();
    this._createTether();

    scene.add(this.group);
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
    const hexGeo = new THREE.CylinderGeometry(hexR, hexR, bz * M, 6, 1, false, Math.PI / 6);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: isWeaver ? 0x4488aa : 0x88aa44,
      metalness: 0.80,
      roughness: 0.30,
      polygonOffset: true,                                          // FIX_PLAN §2-followup
      polygonOffsetFactor: 1,                                        // FIX_PLAN §2-followup — push body slightly into depth
      polygonOffsetUnits: 1,                                         // FIX_PLAN §2-followup — so panel-line edges draw cleanly on top
    });
    this._bodyShell = new THREE.Mesh(hexGeo, bodyMat);
    this._bodyShell.rotation.x = Math.PI / 2;
    this._bodyShell.name = `${this.id}-hex-shell`;
    this._bodyShell.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_OPAQUE; // FIX_PLAN §2-followup
    this.mesh.add(this._bodyShell);

    // --- S3.5: Panel line edges (zero triangle cost) ---
    const edgeGeo = new THREE.EdgesGeometry(hexGeo, 30);
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x667788, transparent: true, opacity: 0.5,
    });
    const edges = new THREE.LineSegments(edgeGeo, edgeMat);
    edges.rotation.x = Math.PI / 2;
    edges.name = `${this.id}-panel-lines`;
    edges.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_TRANSPARENT; // FIX_PLAN §2-followup
    this.mesh.add(edges);

    // --- Body-conformal thin-film GaAs solar cells (matches mother barrel) ---
    // SYMMETRY: cells wrap the full hex body instead of protruding ±Y wings.
    // A hexagonal shell shares the body's azimuthal symmetry, so the daughter's
    // solar coverage looks identical from every angle and no longer depends on
    // the (roll-dependent) docked orientation around the mother. This also
    // removes the wings that broke the radial symmetry of the dock ring.
    //
    // Construction mirrors the mother's barrel cells (PlayerSatellite.js §body
    // thin-film): a slightly oversized conformal shell carrying the dark GaAs
    // material, plus a wireframe cell-grid overlay drawn on top.

    // Darken + faintly energize the hex body so the cell skin reads as PV.
    bodyMat.emissive.setHex(0x060614);
    bodyMat.emissiveIntensity = 0.10;

    // Conformal cell skin: a 6-sided shell (= 6 flat PV facets) at 100.6%
    // radius carrying the dark GaAs cell texture. One mesh, no separate grid
    // shell, so no concentric z-fight/parallax. (The hex faces are already flat,
    // matching how body-mounted cells are flat sub-panels on real spacecraft.)
    const cellTex = getSolarCellTexture();
    let skinTex = null;
    if (cellTex) {
      skinTex = cellTex.clone();
      skinTex.needsUpdate = true;
      skinTex.repeat.set(isWeaver ? 1.0 : 0.7, 1.0); // ~one cell-tile per facet
    }
    const cellSkinGeo = new THREE.CylinderGeometry(
      hexR * 1.006, hexR * 1.006, bz * 0.92 * M, 6, 1, true, Math.PI / 6
    );
    const cellSkinMat = new THREE.MeshStandardMaterial({
      color: skinTex ? 0xffffff : 0x0a1133, // tint comes from the map when present
      map: skinTex || null,
      emissiveMap: skinTex || null,
      metalness: 0.5, roughness: 0.5,
      emissive: 0x0b1030, emissiveIntensity: 0.18,
      side: THREE.FrontSide,
      polygonOffset: true,            // sit just proud of the body shell
      polygonOffsetFactor: -1,        // pull toward camera so cells win the depth tie
      polygonOffsetUnits: -1,
    });
    const cellSkin = new THREE.Mesh(cellSkinGeo, cellSkinMat);
    cellSkin.rotation.x = Math.PI / 2;  // align length axis with body Z
    cellSkin.name = `${this.id}-solar-skin`;
    cellSkin.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL; // over body
    this.mesh.add(cellSkin);

    // --- S3.5: Aft FEEP nozzle (stub, centered on −Z face) ---
    const aftNozR = (isWeaver ? 0.015 : 0.010) * M;
    const aftNozL = (isWeaver ? 0.025 : 0.015) * M;
    const aftNozGeo = new THREE.CylinderGeometry(aftNozR, aftNozR * 1.1, aftNozL, 6, 1, true);
    const feepMat = new THREE.MeshStandardMaterial({
      color: 0x444455, metalness: 0.85, roughness: 0.25,
    });
    const aftNozzle = new THREE.Mesh(aftNozGeo, feepMat);
    aftNozzle.position.set(0, 0, -bz * 0.52 * M);
    aftNozzle.rotation.x = Math.PI / 2;
    aftNozzle.name = `${this.id}-feep-aft`;
    this.mesh.add(aftNozzle);

    // Aft thruster plume (additive blend, hidden by default)
    const plumeGeo = new THREE.ConeGeometry(aftNozR * 3, bz * 0.5 * M, 6, 1, true);
    const plumeMat = new THREE.MeshBasicMaterial({
      color: isWeaver ? 0x4488ff : 0x44ff88,
      transparent: true, opacity: 0.0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const plume = new THREE.Mesh(plumeGeo, plumeMat);
    plume.position.set(0, 0, -bz * 0.75 * M);
    plume.rotation.x = -Math.PI / 2;
    plume.visible = false;
    this.mesh.add(plume);
    this._thrusterPlumes.push(plume);

    // --- S3.5: Fore FEEP nozzle (braking/attitude, offset on +Z face) ---
    const foreNozR = (isWeaver ? 0.010 : 0.007) * M;
    const foreNozL = (isWeaver ? 0.015 : 0.010) * M;
    const foreNozGeo = new THREE.CylinderGeometry(foreNozR, foreNozR * 1.1, foreNozL, 6, 1, true);
    const foreNozzle = new THREE.Mesh(foreNozGeo, feepMat);
    foreNozzle.position.set(bx * 0.25 * M, 0, bz * 0.45 * M);
    foreNozzle.rotation.x = -Math.PI / 2;
    foreNozzle.name = `${this.id}-feep-fore`;
    this.mesh.add(foreNozzle);

    // --- Net canister (forward, cylindrical) ---
    const canR = isWeaver ? 0.06 : 0.03;
    const canH = isWeaver ? 0.08 : 0.05;
    const canGeo = new THREE.CylinderGeometry(canR * M, canR * M, canH * M, 8, 1, true);
    const canMat = new THREE.MeshStandardMaterial({
      color: 0x666677, metalness: 0.6, roughness: 0.4,
    });
    const canister = new THREE.Mesh(canGeo, canMat);
    canister.position.set(0, 0, bz * 0.55 * M);
    canister.rotation.x = Math.PI / 2;
    this.mesh.add(canister);

    // --- Laser power receiver (top face) — a small optical rectenna, NOT a
    // solar array. A single round photodiode tuned to the 808 nm beam, set in a
    // metallic bezel. Deliberately small and distinct from the blue silicon body
    // cells so it doesn't read as "another solar panel".
    const rxR = (isWeaver ? 0.045 : 0.030) * M;   // receiver disc radius (small)
    const rxY = by * 0.52 * M;

    // Metallic bezel ring around the aperture.
    const rxBezelGeo = new THREE.RingGeometry(rxR, rxR * 1.35, 16);
    const rxBezelMat = new THREE.MeshStandardMaterial({
      color: 0x777788, metalness: 0.9, roughness: 0.25, side: THREE.DoubleSide,
    });
    const rxBezel = new THREE.Mesh(rxBezelGeo, rxBezelMat);
    rxBezel.position.set(0, rxY, 0);
    rxBezel.rotation.x = -Math.PI / 2;
    rxBezel.name = `${this.id}-laser-rx-bezel`;
    rxBezel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(rxBezel);

    // Dark optical receiver face with a faint amber glow (active beam target).
    const rxGeo = new THREE.CircleGeometry(rxR, 16);
    const rxMat = new THREE.MeshStandardMaterial({
      color: 0x1a0e02, metalness: 0.35, roughness: 0.2,
      emissive: 0x140a00, emissiveIntensity: 0.18,  // warm 808nm-receiver tint
    });
    const pvPanel = new THREE.Mesh(rxGeo, rxMat);
    pvPanel.position.set(0, rxY + 0.0002 * M, 0);   // just above the bezel plane
    pvPanel.rotation.x = -Math.PI / 2;
    pvPanel.name = `${this.id}-laser-rx`;
    pvPanel.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;
    this.mesh.add(pvPanel);

    // --- S3.5: MRR patch antenna (flat hex disc, replaces 60-tri sphere) ---
    const mrrR = (isWeaver ? 0.015 : 0.010) * M;
    const mrrGeo = new THREE.CircleGeometry(mrrR, 6);
    const mrrMat = new THREE.MeshStandardMaterial({
      color: 0xccccdd, metalness: 0.95, roughness: 0.15, side: THREE.DoubleSide,
    });
    const mrr = new THREE.Mesh(mrrGeo, mrrMat);
    // FIX_PLAN §2-followup: bumped y 0.52→0.525 to clear pvPanel coplanar layer.
    mrr.position.set(bx * 0.25 * M, by * 0.525 * M, -bz * 0.20 * M);   // FIX_PLAN §2-followup
    mrr.rotation.x = -Math.PI / 2;
    mrr.name = `${this.id}-mrr-patch`;
    mrr.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_DETAIL;        // FIX_PLAN §2-followup
    this.mesh.add(mrr);

    // --- Status light (blinks to show state) ---
    const lightGeo = new THREE.SphereGeometry(0.015 * M, 4, 4);
    this._statusLightMat = new THREE.MeshBasicMaterial({ color: 0x00ff44 });
    const statusLight = new THREE.Mesh(lightGeo, this._statusLightMat);
    statusLight.position.set(0, by * 0.55 * M, -bz * 0.3 * M);
    statusLight.renderOrder = Constants.RENDER_ORDER.SPACECRAFT_ADDITIVE; // FIX_PLAN §2-followup
    this.mesh.add(statusLight);

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
    this.mesh.add(legA);

    const legBGeo = new THREE.BufferGeometry();
    legBGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, by * 0.70 * M, 0,  -bx * 0.45 * M, by * 0.30 * M, 0
    ]), 3));
    const legB = new THREE.Line(legBGeo, bridleLegMat);
    legB.name = `${this.id}-bridle-leg-B`;
    legB.visible = false;
    this.mesh.add(legB);

    this._bridleLegA = legA;
    this._bridleLegB = legB;
    this._bridleLegMat = bridleLegMat;

    // Start hidden (docked = part of core visually)
    this.mesh.visible = false;
  }

  /** @private Create tether line geometry */
  _createTether() {
    const segments = Constants.TETHER_SEGMENTS;
    const positions = new Float32Array(segments * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    // Dashed material gives a "high-tech fibre" visual for Dyneema SK78 tether.
    // Color: Dyneema cream-white (dyed hi-vis for space operations).
    this.tetherMaterial = new THREE.LineDashedMaterial({
      color: Constants.TETHER_COLOR_NOMINAL,
      transparent: true,
      opacity: 0.9,
      // POLISH: dash sizes calibrated for visibility at ARM_PILOT viewing
      // distance.  Tether geometry is in scene units (1 unit = 100 km), so a
      // 100 m tether spans 0.001 scene units.  Previous values (0.015/0.005)
      // were 15× longer than typical tethers → effectively a solid line.
      // 0.0001 (10 m) dash + 0.00005 (5 m) gap gives a clear dotted-line look
      // and lets the reel-in dash-flow animation be visible.
      dashSize: 0.0001,
      gapSize: 0.00005,
    });
    this.tetherLine = new THREE.Line(geometry, this.tetherMaterial);
    this.tetherLine.visible = false;
    this.tetherLine.frustumCulled = false;
    this.group.add(this.tetherLine);
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
   * Deploy this arm toward a target debris.
   * @param {object} target - Debris object with ._scenePosition and .id
   * @returns {boolean} true if deployment started
   */
  deploy(target) {
    if (this.state !== S.DOCKED) return false;
    // V5: Spring must be charged to deploy
    if (!this.springCharged) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.id}: Spring not charged — reloading`,
        priority: 'warning',
      });
      return false;
    }
    if (this.fuel <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.id}: No fuel remaining`,
        priority: 'warning',
      });
      return false;
    }
    if (target.mass && target.mass > this.config.maxCaptureMass) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.id}: Target too massive (${target.mass}kg > ${this.config.maxCaptureMass}kg)`,
        priority: 'warning',
      });
      return false;
    }
    this.target = target;
    this._fishingMode = false;              // ensure normal deploy clears fishing flag
    this._fuelAtDeploy = this.fuel;         // Track for efficiency scoring
    this._startingDistance = 0;             // Phase 8: reset for approach beep fraction
    this._transitEntryLogged = false;       // Reset one-shot TRANSIT entry diagnostic
    this._transitFrameCount = 0;            // Reset frame counter for TRANSIT diagnostics
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
          text: `${this.id}: Target ${Math.round(distToTarget)}m away (max ${Math.round(maxDeployRange)}m). Press A to autopilot closer first.`,
          priority: 'warning',
        });
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
      text: `${this.id}: Crossbow launch — target ${target.id || 'acquired'}`,
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
    if (!this.springCharged) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.id}: Spring not charged — reloading`,
        priority: 'warning',
      });
      return false;
    }
    if (this.fuel <= 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.id}: No fuel remaining`,
        priority: 'warning',
      });
      return false;
    }
    this.target = null;
    this._fishingMode = false;
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
      text: `${this.id}: Crossbow launch — free-fly mode`,
      priority: 'info',
    });
    return true;
  }

  /**
   * Deploy this arm in passive fishing/ambush mode.
   * Arm extends on tether to max range and hibernates, auto-capturing
   * any debris that drifts within proximity (trapdoor spider ambush).
   * @param {THREE.Vector3} deployDir - Direction to extend outward from core
   * @returns {boolean}
   */
  deployFishing(deployDir) {
    if (this.state !== S.DOCKED) return false;
    // V5: Spring must be charged to deploy
    if (!this.springCharged) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.id}: Spring not charged — reloading`,
        priority: 'warning',
      });
      return false;
    }
    if (this.fuel <= 5) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.id}: Insufficient fuel for fishing deployment`,
        priority: 'warning',
      });
      return false;
    }
    // Fallback uses world-space dock direction so ambush fires outward
    // regardless of parent orientation (§4.6 fix).
    this._fishingDir = deployDir
      ? deployDir.clone().normalize()
      : this._worldDockDirection(this._lastParentQuat);
    this._fishingDeployTarget = this.config.tetherMax * 0.8; // deploy to 80% of tether max
    this.target = null;

    // V5: Launch direction for fishing
    this.launchDirection = this._fishingDir.clone();

    // V5: Use LAUNCHING state
    this._transitionTo(S.LAUNCHING);
    this._undockTimer = 0;
    this._springFired = false;
    this._dockWorldPos = this.position.clone();
    this._fishingMode = true;

    eventBus.emit(Events.ARM_DEPLOYED, { armId: this.id, type: this.type, mode: 'fishing' });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.id}: Crossbow launch — ambush/fishing mode`,
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
        sender: this.id, text: 'Must be docked to trawl', priority: 'warning',
      });
      return false;
    }
    // V5: Spring must be charged to deploy
    if (!this.springCharged) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.id}: Spring not charged — reloading`,
        priority: 'warning',
      });
      return false;
    }
    if (this.fuel <= 5) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: this.id, text: 'Insufficient fuel for trawling', priority: 'warning',
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
      sender: this.id, text: 'Crossbow launch — trawling deployed', priority: 'info',
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
    // Must be IDLE (docked) or FISHING to fire
    if (this.state !== S.DOCKED && this.state !== S.FISHING) return false;
    if (!target || target.id === undefined || target.id === null) return false;

    // Cooldown check
    if (this._webShotCooldown > 0) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.id}: Web shot cooldown — ${Math.ceil(this._webShotCooldown)}s remaining`,
        priority: 'warning',
      });
      return false;
    }

    // Fuel check
    if (this.fuel < Constants.WEB_SHOT_FUEL_COST) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.id}: Insufficient fuel for web shot`,
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
      text: `${this.id}: 🕸 GSL web shot — targeting ${target.id}`,
      priority: 'info',
    });

    return true;
  }

  /**
   * Recall this arm (abort mission, return to core).
   */
  recall() {
    if (this.state === S.DOCKED || this.state === S.EXPENDED) return;

    // Detached arms cannot be recalled — tether severed
    if (this.isDetached) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.id}: Cannot recall — tether severed. Arm is autonomous.`,
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

    if (this.fuel <= 2) {
      this._transitionTo(S.EXPENDED);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.id}: Insufficient fuel to return — expended`,
        priority: 'critical',
      });
      return;
    }
    this.capturedDebris = null;
    this.target = null;
    // V5: Use REELING for zero-fuel return instead of RETURNING
    this._transitionTo(S.REELING);
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
      S.TRANSIT, S.APPROACH, S.FISHING, S.TANGLED, S.NETTING, S.GRAPPLED
    ]);
    if (!DETACHABLE.has(this.state)) return false;
    if (this.isDetached) return false;

    this.isDetached = true;
    this._detachFuelWarning25 = false;
    this._detachFuelWarning10 = false;
    const wasTangled = this.state === S.TANGLED;

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
      wasTangled,
      hasDebris: this.capturedDebris !== null,
    });

    // Comms callout
    const callout = wasTangled
      ? `Houston: ${this.id} — tether cut from tangle. She's flying free.`
      : `Houston: ${this.id} — tether severed. COWBOY! Free-flight on own fuel.`;
    eventBus.emit(Events.COMMS_MESSAGE, { text: callout, priority: 'HIGH' });

    console.log(`[ArmUnit] ${this.id} DETACHED (fuel: ${this.fuel.toFixed(1)}%, tangled: ${wasTangled})`);
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
    this.velocity.add(right.clone().multiplyScalar(direction.x * dv));
    this.velocity.add(up.clone().multiplyScalar(direction.y * dv));
    this.velocity.add(forward.clone().multiplyScalar(direction.z * dv));
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
        source: this.id,
        text: `${this.id}: No nets remaining — return to mother for reload.`,
        channel: 'CMD',
        priority: 'warning',
      });
      return false;
    }

    this._manualMode = false; // Exit manual control for capture sequence
    this._manualCapture = true; // Flag for scoring (Delegate 3C will use this)
    this._transitionTo(S.NETTING);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.id}: Net deployed — attempting capture`,
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
      text: `${this.id}: DEORBIT BURN — all fuel committed retrograde`,
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
   * Enter tangle state with another arm's tether.
   * @param {ArmUnit} partner - Other arm involved in the tangle
   */
  enterTangle(partner) {
    this._preTangleState = this.state;
    this.tanglePartner = partner;
    this.tangleTimer = 0;
    this._transitionTo(S.TANGLED);
    eventBus.emit(Events.TETHER_TANGLE, {
      armIndices: [this.index, partner.index],
    });
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
    this._detachFuelWarning25 = false;
    this._detachFuelWarning10 = false;
    this._manualMode = false;
    this._manualCapture = false;
    this._fuelAtDeploy = 100;
    this._autoFailChance = 0;
    this._fishingMode = false;
    this._fishingDir = null;
    this._fishingDeployTarget = 0;
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
    this.tangleTimer = 0;
    this.tanglePartner = null;
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

    // UX Fix D: Reset pilot nudge counter on game reset (allows re-nudging in new runs)
    ArmUnit._pilotNudgeCount = 0;

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

   // [DBG-GAP] Stash parentPos reference so _transitionTo (which has no
   // parentPos argument) can compute the daughter-mother gap on state entry.
   // Reference is safe — we only read it during the same-frame state machine
   // tick, never store it across frames.
   this._dbgParentPos = parentPos;

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

   // [DBG-GAP] Throttled in-state gap log (~5s) for STATION_KEEP / NETTING /
   // GRAPPLED / REELING.  Captures the *accumulation* of mother-debris drift
   // across a long-SK session (the 1-2 km gap the user reported after 200s
   // of SK/NETTING is invisible to per-transition logs alone).
   if (parentPos && (this.state === S.STATION_KEEP || this.state === S.NETTING ||
                     this.state === S.GRAPPLED   || this.state === S.REELING)) {
     this._dbgGapAccum = (this._dbgGapAccum || 0) + dt;
     if (this._dbgGapAccum >= 5.0) {
       this._dbgGapAccum = 0;
       const debris = this._stationKeepTarget || this.capturedDebris || this.target;
       const dpos = (debris && debris._scenePosition) ? debris._scenePosition : null;
       const d_m_gap = this.position.distanceTo(parentPos) / M;
       const d_t_gap = dpos ? (this.position.distanceTo(dpos) / M) : NaN;
       const t_m_gap = dpos ? (dpos.distanceTo(parentPos) / M) : NaN;
       const captorId = debris?._capturedByArm?.id || 'none';
       console.log(
         `[DBG-GAP-TICK ${this.id}] state=${this.state} t=${this.stateTimer.toFixed(1)}s | ` +
         `d↔m=${d_m_gap.toFixed(1)}m | ` +
         `d↔target=${isNaN(d_t_gap) ? '?' : d_t_gap.toFixed(1)+'m'} | ` +
         `target↔m=${isNaN(t_m_gap) ? '?' : t_m_gap.toFixed(1)+'m'} | ` +
         `tgt=${debris?.id ?? 'null'} alive=${debris?.alive !== false} captor=${captorId}`
       );
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
     case S.RETURNING:  this._updateReturning(dt, parentPos); break;
     case S.DOCKING:    this._updateDocking(dt, parentPos, parentQuat); break;
     case S.RELOADING:  this._updateReloading(dt); break;
     case S.FISHING:    this._updateFishing(dt, parentPos); break;
     case S.TRAWLING:   this._updateTrawling(dt, parentPos); break;
     case S.DEORBITING: this._updateDeorbiting(dt); break;
     case S.WEB_SHOT:   this._updateWebShot(dt, parentPos); break;
     case S.ABLATING:   this._updateAblating(dt); break;
     case S.SCANNING:   this._updateScanning(dt); break;
     case S.TANGLED:    this._updateTangled(dt); break;
     case S.STATION_KEEP: this._updateStationKeep(dt); break;
     case S.EXPENDED:   this._updateExpended(dt); break;
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

    // Fuel consumption (when active — fishing/trawling use minimal power)
    // DEORBITING handles its own burn rate in _updateDeorbiting()
    // TRAWLING handles its own fuel consumption in _updateTrawling()
    // WEB_SHOT fuel is consumed upfront in fireWebShot()
    // V5: REELING, RELOADING, LAUNCHING, ABLATING, SCANNING, TANGLED exempt from legacy fuel
    if (this.state !== S.DOCKED && this.state !== S.EXPENDED &&
        this.state !== S.DEORBITING && this.state !== S.TRAWLING &&
        this.state !== S.WEB_SHOT && this.state !== S.REELING &&
        this.state !== S.RELOADING && this.state !== S.LAUNCHING &&
        this.state !== S.ABLATING && this.state !== S.SCANNING &&
        this.state !== S.TANGLED) {
      this._consumeFuel(dt);
    }

    // Max-distance kill for detached arms — prevent orphaned arms drifting forever
    if (this.isDetached && this.state !== S.EXPENDED && parentPos) {
      const distMeters = this.position.distanceTo(parentPos) / M;
      if (distMeters > Constants.DETACH_MAX_DISTANCE) {
        const typeLabel = this.type === 'weaver' ? 'Weaver' : 'Spinner';
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Daughter lost. ${typeLabel} ${this.id} exceeded max range (${Math.round(distMeters)}m) — signal lost.`,
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
    // DOCKED/DOCKING/RELOADING: mesh hidden or aligning — skip.
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
                         this.state === S.RELOADING || this.state === S.LAUNCHING);
    if (!skipAttitude) {
      let headingDir = null;

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

      // Prograde fallback: align nose with velocity vector
      if (!headingDir && this.velocity.lengthSq() > 1e-20) {
        headingDir = this._tmpVec.copy(this.velocity).normalize();
      }

      if (headingDir) {
        // Use Earth-radial as "up" (same convention as mother satellite)
        const radial = this.position.clone().normalize();
        const mat = new THREE.Matrix4();
        const eye = this.position.clone().add(headingDir);
        mat.lookAt(eye, this.position, radial);
        const targetQuat = new THREE.Quaternion().setFromRotationMatrix(mat);
        // V-8 fix: faster slerp for target-tracking states so daughter visually
        // snaps to face debris promptly. 0.05 was ~1s to converge — too slow for
        // APPROACH/STATION_KEEP where the daughter should clearly face the debris.
        const sRate = (this.state === S.APPROACH || this.state === S.STATION_KEEP || this.state === S.NETTING)
          ? 0.15    // fast reorientation during close-range operations
          : 0.05;   // gentle for TRANSIT (cosmetic, less disorienting on long flights)
        this.group.quaternion.slerp(targetQuat, sRate);
      } else if (parentQuat) {
        // No heading available (velocity ≈ 0 in FISHING, etc.)
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
    if (old === S.REELING) this._dbgReelLogged = false;  // reset one-shot DBG-REEL on REELING exit
    this.state = newState;
    this.stateTimer = 0;
    // [DBG-ARM] Log every state transition
    {
      const _vDir = this.velocity.lengthSq() > 1e-20
        ? this.velocity.clone().normalize() : null;
      console.log(
        `[DBG-ARM] _transitionTo ${this.id}: ${old} → ${newState} | ` +
        `pos=${_dbgArmVec(this.position)} | ` +
        `eulerDeg=${_dbgArmEulerDeg(this.group.quaternion)} | ` +
        `velDir=${_dbgArmDir(_vDir)}`
      );
      this._dbgFramesSinceState = 0;  // reset counter for attitude per-frame log
    }
    // [DBG-GAP] Per-state-entry diagnostic for the SK/NETTING/GRAPPLED/REELING
    // chain — measures daughter-mother, daughter-debris, and debris-mother gaps
    // so we can see exactly when (and how much) the mother drifts away from
    // the debris during a long station-keep session.
    // Remove once mother-orbit-drift root cause is fixed.
    // NOTE: uses module-local M (scene-units-per-METER = 0.00001), NOT
    // Constants.SCENE_SCALE (which is per-KM = 0.01).
    if (newState === S.STATION_KEEP || newState === S.NETTING ||
        newState === S.GRAPPLED   || newState === S.REELING  ||
        (old === S.REELING && newState === S.DOCKING)) {
      const pp = this._dbgParentPos;
      const debris = this._stationKeepTarget || this.capturedDebris || this.target;
      const dpos = (debris && debris._scenePosition) ? debris._scenePosition : null;
      const d_m_gap = pp ? (this.position.distanceTo(pp) / M) : NaN;
      const d_t_gap = dpos ? (this.position.distanceTo(dpos) / M) : NaN;
      const t_m_gap = (dpos && pp) ? (dpos.distanceTo(pp) / M) : NaN;
      const captorId = debris?._capturedByArm?.id || 'none';
      const aliveStr = debris ? `alive=${debris.alive !== false}` : 'no-debris';
      console.warn(
        `[DBG-GAP ${this.id}] ${old}→${newState} | ` +
        `d↔m=${isNaN(d_m_gap) ? '?' : d_m_gap.toFixed(1)+'m'} | ` +
        `d↔target=${isNaN(d_t_gap) ? '?' : d_t_gap.toFixed(1)+'m'} | ` +
        `target↔m=${isNaN(t_m_gap) ? '?' : t_m_gap.toFixed(1)+'m'} | ` +
        `tgt=${debris?.id ?? 'null'} ${aliveStr} captor=${captorId} | ` +
        `tether=${this.tetherLength?.toFixed?.(1) ?? '?'}m`
      );
      this._dbgGapAccum = 0; // reset throttled in-state gap timer
    }
    eventBus.emit(Events.ARM_STATE_CHANGE, {
      armId: this.id, from: old, to: newState,
    });
    // ST-5.2: Clear trail buffer on dock/reload
    if (newState === S.DOCKED || newState === S.RELOADING) {
      this._trailSampleAccum = 0;
      eventBus.emit(Events.ARM_TRAIL_CLEAR, { armId: this.id });
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
    // a world-space launch direction (§4.6 fix).
    this._lastParentQuat = parentQuat ? parentQuat.clone() : null;
    const offset = this.dockOffset.clone();
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
          text: `${this.id}: Trawling mode — slow sweep for debris`,
          priority: 'info',
        });
      } else if (this._fishingMode) {
        this._transitionTo(S.FISHING);
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.id}: Fishing mode — extending on tether, hibernating`,
          priority: 'info',
        });
      } else {
        this._transitionTo(S.TRANSIT);
        // Legacy: still uses old launch impulse for backward compat
        this._applyLaunchImpulse();
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.id}: Clear of core — in transit`,
          priority: 'info',
        });
        // UX Fix D: Delayed nudge for manual piloting (first 3 deploys only)
        if (!this._manualMode && ArmUnit._pilotNudgeCount < 3) {
          const armId = this.id;
          setTimeout(() => {
            if (this.state === S.TRANSIT && !this._manualMode && ArmUnit._pilotNudgeCount < 3) {
              ArmUnit._pilotNudgeCount++;
              eventBus.emit(Events.COMMS_MESSAGE, {
                text: `${armId}: Press P to take manual control — 2× capture score`,
                source: armId,
                channel: 'CMD',
                priority: 'info',
              });
            }
          }, 2000);
        }
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
          text: `${this.id}: Trawling mode — slow sweep for debris`,
          priority: 'info',
        });
      } else if (this._fishingMode) {
        this._transitionTo(S.FISHING);
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.id}: Fishing mode — extending on tether, hibernating`,
          priority: 'info',
        });
      } else {
        this._transitionTo(S.TRANSIT);
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.id}: Clear of core — crossbow transit`,
          priority: 'info',
        });
        // UX Fix D: Delayed nudge for manual piloting (first 3 deploys only)
        if (!this._manualMode && ArmUnit._pilotNudgeCount < 3) {
          const armId = this.id;
          setTimeout(() => {
            if (this.state === S.TRANSIT && !this._manualMode && ArmUnit._pilotNudgeCount < 3) {
              ArmUnit._pilotNudgeCount++;
              eventBus.emit(Events.COMMS_MESSAGE, {
                text: `${armId}: Press P to take manual control — 2× capture score`,
                source: armId,
                channel: 'CMD',
                priority: 'info',
              });
            }
          }, 2000);
        }
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
      this.position.add(this.velocity.clone().multiplyScalar(dt));
      this.tetherLength = this.position.distanceTo(parentPos) / M;
      if (!this.isDetached && this.tetherLength > this.config.tetherMax) {
        const dir = this.position.clone().sub(parentPos).normalize();
        this.position.copy(parentPos).add(dir.multiplyScalar(this.config.tetherMax * M));
        const velAlongTether = this.velocity.dot(dir);
        if (velAlongTether > 0) {
          this.velocity.sub(dir.clone().multiplyScalar(velAlongTether));
        }
      }
      // ── STILL CHECK APPROACH THRESHOLD even in manual mode ──
      // enableManual() fires during LAUNCH_CEREMONY_COMPLETE while the arm
      // is still in TRANSIT. Without this gate the arm coasts forever and
      // never transitions to APPROACH → STATION_KEEP.
      if (this.target) {
        const _tPos = this._getTargetScenePos();
        if (_tPos) {
          const _dist = _tPos.clone().sub(this.position).length();
          const _dSz = (this.target.sizeMeter) || 1;
          const _so = Math.max(Constants.STATION_KEEP.DEFAULT_STANDOFF,
            Math.min(Constants.STATION_KEEP.MAX_STANDOFF,
              _dSz * Constants.STATION_KEEP.DEFAULT_STANDOFF_MULT));
          const _thresh = Math.max(_so * 2, this.config.bodyDims[2] * 15) * M;
          if (_dist < _thresh) {
            this._transitionTo(S.APPROACH);
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: `${this.id}: Beginning final approach`,
              priority: 'info',
            });
          }
        }
      }
      return; // skip autopilot logic (pings, thruster audio, etc.)
    }

    const targetPos = this._getTargetScenePos();
    if (!targetPos) {
      console.warn(`[DAP-TRANSIT ${this.id}] ⚠ NO TARGET — recalling! target=${this.target}, _scenePos=${this.target?._scenePosition}`);
      this.recall();
      return;
    }
    const toTarget = this._tmpVec.subVectors(targetPos, this.position);
    const dist = toTarget.length();

    // ── DIAGNOSTIC: first 10 frames of TRANSIT (frame-by-frame) ──
    if (!this._transitFrameCount) this._transitFrameCount = 0;
    this._transitFrameCount++;
    if (this._transitFrameCount <= 10 || !this._transitEntryLogged) {
      this._transitEntryLogged = true;
      const distM = dist / M;
      const velMps = this.velocity.length() / M;
      const velDir = this.velocity.clone().normalize();
      const tgtDir = toTarget.clone().normalize();
      const alignment = velDir.dot(tgtDir);
      // [DAP-TRANSIT] per-frame log removed (noise during TRANSIT). Recall warning at top of fn kept.
    }

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
        text: `${this.id}: Tether limit (${Math.round(this.config.tetherMax)}m) — recalling`,
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
    let rawDriftVel = new THREE.Vector3(0, 0, 0);
    if (this._prevTargetScenePos && this._prevParentPos && parentPos && dt > 0) {
      const tDelta = targetPos.clone().sub(this._prevTargetScenePos);
      const pDelta = parentPos.clone().sub(this._prevParentPos);
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
    const relVT = driftVelT.clone().sub(this.velocity);

    // Quadratic braking: v*(r) = min(V_CAP, √(2·A_BRAKE·posErr))
    // V_CAP = actual launch speed so the arm COASTS, never accelerates beyond spring speed
    const posErrM = dist / M;
    const effectiveVCap = this._launchSpeedMps || DAP_T.V_CAP;
    const aBrakeT = DAP_T.MAX_ACCEL * DAP_T.BRAKE_FRACTION;
    const vStarMT = Math.min(effectiveVCap, Math.sqrt(2 * aBrakeT * posErrM));
    const vStarT = vStarMT * M; // scene units/s

    // Velocity control error = goalDir × v* + relV
    const goalDirT = toTarget.clone().normalize();
    const velCtrlErrT = goalDirT.multiplyScalar(vStarT).add(relVT);

    // Commanded impulse = KP × velCtrlErr, clamped by MAX_ACCEL × gameDt
    const dvCmdT = velCtrlErrT.multiplyScalar(DAP_T.KP_VEL);
    const gameDtT = dt * Constants.TIME_SCALE_GAMEPLAY;
    const maxDvT = DAP_T.MAX_ACCEL * M * gameDtT;
    const dvMagT = dvCmdT.length();
    if (dvMagT > maxDvT && dvMagT > 1e-18) dvCmdT.multiplyScalar(maxDvT / dvMagT);

    // Apply thrust impulse (NOT lerp — direct impulse like mother autopilot)
    // ── DIAGNOSTIC: first 10 frames control law detail ──
    if (this._transitFrameCount <= 10) {
      const _vPre = this.velocity.length() / M;
      const _dvMps = dvCmdT.length() / M;
      const _maxMps = maxDvT / M;
      const _clamped = dvMagT > maxDvT;
      // [DAP-CTL] per-frame log removed (10 frames × every arm = noise).
    }
    this.velocity.add(dvCmdT);
    this.position.add(this.velocity.clone().multiplyScalar(dt));

    // ── DIAGNOSTIC: daughter autopilot TRANSIT telemetry (throttled ~1/s) ──
    this._dapLogCounter = (this._dapLogCounter || 0) + 1;
    if (this._dapLogCounter % 60 === 0) {
      const velMps = this.velocity.length() / M;
      const driftMps = driftVelT.length() / M;
      const dvCmdMps = dvCmdT.length() / M;
      const maxDvMps = maxDvT / M;
      console.log(
        `[DAP-TRANSIT ${this.id}] posErr=${posErrM.toFixed(1)}m | ` +
        `v*=${vStarMT.toFixed(3)}m/s | vel=${velMps.toFixed(3)}m/s | ` +
        `drift=${driftMps.toFixed(3)}m/s | dvCmd=${dvCmdMps.toFixed(4)}m/s | ` +
        `maxDv=${maxDvMps.toFixed(4)}m/s | dt=${dt.toFixed(4)} | ` +
        `V_CAP=${DAP_T.V_CAP} | clamp=${(dvMagT > maxDvT) ? 'YES' : 'no'}`
      );
    }

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
        text: `${this.id}: Beginning final approach`,
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
      this.position.add(this.velocity.clone().multiplyScalar(dt));
      if (parentPos) {
        this.tetherLength = this.position.distanceTo(parentPos) / M;
        if (!this.isDetached && this.tetherLength > this.config.tetherMax) {
          const dir = this.position.clone().sub(parentPos).normalize();
          this.position.copy(parentPos).add(dir.multiplyScalar(this.config.tetherMax * M));
          const velAlongTether = this.velocity.dot(dir);
          if (velAlongTether > 0) {
            this.velocity.sub(dir.clone().multiplyScalar(velAlongTether));
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
          const _toTgt = _tPos.clone().sub(this.position);
          const _distM = _toTgt.length() / M;
          const _dSz = (this.target.sizeMeter) || 1;
          const _so = Math.max(Constants.STATION_KEEP.DEFAULT_STANDOFF,
            Math.min(Constants.STATION_KEEP.MAX_STANDOFF,
              _dSz * Constants.STATION_KEEP.DEFAULT_STANDOFF_MULT));
          const _gateDist = _so * (Constants.STATION_KEEP.ENTRY_DISTANCE_MULT || 2.0);
          if (_distM <= _gateDist) {
            console.log(`[SK-ENTER-MANUAL ${this.id}] dist=${_distM.toFixed(2)}m gate=${_gateDist.toFixed(1)}m standoff=${_so}`);
            this._transitionTo(S.STATION_KEEP);
            this._stationKeepTarget = this.target;
            if (this.target) this.target._isStationKeepTarget = true;
            this._standoffR = _so;
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
    let rawDriftVelA = new THREE.Vector3(0, 0, 0);
    const targetScenePos = this._getTargetScenePos();
    if (targetScenePos && this._prevTargetScenePos && this._prevParentPos && parentPos && dt > 0) {
      const tDelta = targetScenePos.clone().sub(this._prevTargetScenePos);
      const pDelta = parentPos.clone().sub(this._prevParentPos);
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
    const relVA = driftVelA.clone().sub(this.velocity);

    // Signed excess distance: positive = outside standoff, negative = inside
    // Inside standoff → restoring spring pushes arm back OUT (fixes no-retreat bug)
    const signedExcess = distMetres - standoff;
    const absExcess = Math.abs(signedExcess);
    const aBrakeA = DAP_A.MAX_ACCEL * DAP_A.BRAKE_FRACTION;
    const vStarMA = Math.min(DAP_A.V_CAP * 0.3, Math.sqrt(2 * aBrakeA * absExcess));
    const vStarA = vStarMA * M;

    // Velocity control error + commanded impulse
    // goalDir toward target when outside standoff; AWAY from target when inside
    const goalDirA = toTarget.clone().normalize();
    const posCmd = signedExcess >= 0
      ? goalDirA.clone().multiplyScalar(vStarA)     // approach: drive toward target
      : goalDirA.clone().multiplyScalar(-vStarA);    // retreat: drive away from target
    const velCtrlErrA = posCmd.add(relVA);
    const dvCmdA = velCtrlErrA.multiplyScalar(DAP_A.KP_VEL);
    const gameDtA = dt * Constants.TIME_SCALE_GAMEPLAY;
    const maxDvA = DAP_A.MAX_ACCEL * M * gameDtA;
    const dvMagA = dvCmdA.length();
    if (dvMagA > maxDvA && dvMagA > 1e-18) dvCmdA.multiplyScalar(maxDvA / dvMagA);

    this.velocity.add(dvCmdA);
    this.position.add(this.velocity.clone().multiplyScalar(dt));

    // ── DIAGNOSTIC: daughter autopilot APPROACH telemetry (throttled ~1/s) ──
    this._dapLogCounter = (this._dapLogCounter || 0) + 1;
    if (this._dapLogCounter % 60 === 0) {
      const velMps = this.velocity.length() / M;
      const driftMps = driftVelA.length() / M;
      const relVMps = relVA.length() / M;
      console.log(
        `[DAP-APPROACH ${this.id}] dist=${distMetres.toFixed(1)}m | standoff=${standoff.toFixed(1)}m | ` +
        `signedExcess=${signedExcess.toFixed(2)}m | v*=${vStarMA.toFixed(4)}m/s | ` +
        `vel=${velMps.toFixed(3)}m/s | drift=${driftMps.toFixed(3)}m/s | ` +
        `relV=${relVMps.toFixed(3)}m/s`
      );
    }

    // ── Epic 8: Check for STATION_KEEP entry before netting ──
    if (this.target && !this._manualMode) {
      // Relative velocity to TARGET using EMA-smoothed drift (not raw — avoids noise).
      // At steady state, arm.velocity ≈ smoothDriftVel, so relVelToTarget → 0.
      const relVelToTarget = this.velocity.clone().sub(driftVelA);
      const relVel = relVelToTarget.length() / M;

      // SK entry gate — distance + velocity thresholds.  Both are constants
      // so they can be tuned without code changes (debug session 2026-05-09:
      // distance widened 1.3→2.0×, velocity 2.0→3.0 m/s after observing arms
      // parking at dist=17m / relV=1.9m/s, which were JUST outside the old
      // 13m / 2.0m/s gate so SK never triggered).
      const _SK_DIST_MULT = Constants.STATION_KEEP.ENTRY_DISTANCE_MULT;
      const _SK_GATE_DIST = standoff * _SK_DIST_MULT;
      const _SK_GATE_VEL  = Constants.STATION_KEEP.ENTRY_MAX_VELOCITY;

      // ── DIAGNOSTIC: STATION_KEEP gate check (~1/s during APPROACH) ──
      if (this._dapLogCounter % 60 === 0) {
        const _driftMps = driftVelA.length() / M;
        console.log(
          `[DAP-SK-GATE ${this.id}] distCheck=${(distMetres <= _SK_GATE_DIST)} (${distMetres.toFixed(1)} <= ${_SK_GATE_DIST.toFixed(1)}) | ` +
          `velCheck=${(relVel < _SK_GATE_VEL)} (${relVel.toFixed(4)} < ${_SK_GATE_VEL}) | ` +
          `driftNoise=${_driftMps.toFixed(4)}m/s`
        );
      }

      if (distMetres <= _SK_GATE_DIST && relVel < _SK_GATE_VEL) {
        console.log(`[SK-ENTER ${this.id}] dist=${distMetres.toFixed(2)}m relVel=${relVel.toFixed(3)}m/s standoff=${standoff} target._scenePos=${!!this.target?._scenePosition} target.mesh=${!!this.target?.mesh}`);
        this._transitionTo(S.STATION_KEEP);
        this._stationKeepTarget = this.target;
        // Mark debris so DebrisField LOD won't scale it to 0 when mother orbits far away
        if (this.target) this.target._isStationKeepTarget = true;
        this._standoffR = standoff;

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
        // [DBG-ARM] SK entry telemetry — capture orbit-frame, position, and target
        {
          const _tp = this._getTargetScenePos();
          console.log(
            `[DBG-ARM] SK-ENTRY ${this.id} | ` +
            `theta=${this._orbitTheta.toFixed(3)} phi=${this._orbitPhi.toFixed(3)} r=${this._standoffR.toFixed(2)}m | ` +
            `pos=${_dbgArmVec(this.position)} | ` +
            `targetScenePos=${_dbgArmVec(_tp)} | ` +
            `eulerDeg=${_dbgArmEulerDeg(this.group.quaternion)}`
          );
        }
        eventBus.emit(Events.STATION_KEEP_ENTERED, {
          armId: this.id,
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
        text: `${this.id}: Deploying ${this.config.netSize}m net`,
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
      console.warn(`[SK-EXIT ${this.id}] LOST | target=${!!target} _scenePos=${!!target?._scenePosition} mesh=${!!target?.mesh} alive=${target?.alive}`);
      this._exitStationKeep('lost');
      return;
    }

    // Update spherical coordinates from input rates
    this._orbitTheta += this._thetaRate * dt;
    this._orbitPhi += this._phiRate * dt;
    this._standoffR += this._radiusRate * dt;

    // ── Pattern-C auto-return (dwell-then-ease) ──
    // Pilot-friendly recovery: daughter holds her position for a quiet window
    // after the pilot releases the arrows, THEN gently eases back toward the
    // entry pose.  Any new arrow input cancels the ease and resets the dwell.
    // A separate "snap-back" mode (triggered by requestSkRecenter()) skips the
    // dwell and uses a faster τ for an explicit recenter command.
    const _hasInput = Math.abs(this._thetaRate) > 1e-4
                   || Math.abs(this._phiRate) > 1e-4
                   || Math.abs(this._radiusRate) > 1e-4;
    if (_hasInput) {
      // Any pilot input → cancel auto-return entirely, reset the dwell clock
      this._skIdleS = 0;
      this._skSnapBack = false;
    } else {
      this._skIdleS = (this._skIdleS || 0) + dt;
      // Determine which time constant to use:
      //  - SnapBack mode (R key pressed): fast τ, no dwell.
      //  - Idle but inside dwell window: hold position (no motion).
      //  - Idle past dwell: standard ease.
      const dwell = SK.AUTO_RETURN_DWELL_S || 3.0;
      const tauSlow = SK.AUTO_RETURN_TIME_CONSTANT_S || 4.0;
      const tauSnap = SK.AUTO_RETURN_SNAP_TAU_S || 0.8;
      let tau = null;
      if (this._skSnapBack) {
        tau = tauSnap;
      } else if (this._skIdleS >= dwell) {
        tau = tauSlow;
      }
      if (tau !== null) {
        const k = 1 - Math.exp(-dt / tau);
        this._orbitTheta += (0 - this._orbitTheta) * k;
        this._orbitPhi   += (0 - this._orbitPhi)   * k;
        // Dead-zone snap so we don't asymptote forever — also clears the
        // snap-back request once the camera is essentially home.
        const deadRad = (SK.AUTO_RETURN_DEADZONE_DEG || 2.0) * Math.PI / 180;
        if (Math.abs(this._orbitTheta) < deadRad && Math.abs(this._orbitPhi) < deadRad) {
          this._orbitTheta = 0;
          this._orbitPhi   = 0;
          this._skSnapBack = false;
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

    // Clamp radius
    this._standoffR = Math.max(this._rMin, Math.min(this._rMax, this._standoffR));

    // Target position in scene coordinates — use _scenePosition (orbit-propagated)
    // not mesh.position which may be stale or floating-origin-adjusted for instanced debris
    const targetPos = target._scenePosition || (target.mesh && target.mesh.position);
    if (!targetPos) {
      console.warn(`[SK-EXIT ${this.id}] NO POS`);
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
      console.warn(`[SK-EXIT ${this.id}] FUEL DEPLETED`);
      this._exitStationKeep('fuel');
      return;
    }

    // Reset rates each frame (they're set by input events)
    this._thetaRate = 0;
    this._phiRate = 0;
    this._radiusRate = 0;
  }

  /**
   * Pilot-triggered recenter: skip the dwell and snap back to the entry pose
   * over ~AUTO_RETURN_SNAP_TAU_S.  No-op outside STATION_KEEP.
   * Wired to the R key in InputManager.
   */
  requestSkRecenter() {
    if (this.state !== S.STATION_KEEP) return;
    this._skSnapBack = true;
    this._skIdleS = Constants.STATION_KEEP.AUTO_RETURN_DWELL_S || 3.0; // bypass dwell
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
    this._thetaRate = 0;
    this._phiRate = 0;
    this._radiusRate = 0;
    // Release the frozen entry frame so the next SK entry captures fresh axes
    this._skPolarAxis = null;
    this._skEquator0  = null;
    this._skRightVec  = null;
    this._skPitch0    = 0;
    this._skIdleS     = 0;
    this._skSnapBack  = false;
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
        source: this.id,
        text: `${this.id}: No nets remaining — return to mother for reload.`,
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
    this._transitionTo(S.NETTING);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.id}: Deploying net — stand by for capture`,
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
    this._skSnapBack  = false;
    this._transitionTo(S.REELING);
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `${this.id}: Reeling in — strut motor engaged`,
      priority: 'info',
    });
    return true;
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
          text: `${this.id}: AUTO-CAPTURE FAILED — target tumble too high!`,
          priority: 'critical',
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Manual pilot available — deploy arm and press P`,
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
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.id}: Target secured! SMA cinch complete.`,
          priority: 'success',
        });
      } else {
        eventBus.emit(Events.ARM_CAPTURE_FAILED, {
          armId: this.id, targetId: this.target?.id,
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.id}: Netting failed — re-approaching`,
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
     // Launch direction: toward target
     const tPos = this._getTargetScenePos();
     let launchDir = { x: 1, y: 0, z: 0 };
     if (tPos) {
       const dx = tPos.x - this.position.x;
       const dy = tPos.y - this.position.y;
       const dz = tPos.z - this.position.z;
       const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
       launchDir = { x: dx / len, y: dy / len, z: dz / len };
     }

     activeNet = captureNetSystem.fireDaughterNet(
       this, this.index, launchPos, launchDir, this.target
     );

     if (!activeNet) {
       // fireDaughterNet returned null (cooldown/inventory/flag) — fall back to SK
       // (not APPROACH, which causes "screen-races-to-debris" at orbital speed).
       console.warn(`[NETTING-FSM ${this.id}] fireDaughterNet returned null — inv=${this._netInventory}/${this._netInventoryMax} flag=${Constants.isFeatureEnabled('CAPTURE_NET')} → fallback STATION_KEEP`);
       this._firedNet = null;
       this._transitionTo(S.STATION_KEEP);
       return;
     }
     this._firedNet = activeNet;  // store reference for subsequent frames
     console.log(`[NETTING-FSM ${this.id}] net fired — state=${activeNet.state} target=${this.target?.id}`);
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
      if (this.target) {
        this.target._captured = true;
        this.target._capturedByArm = this; // POLISH FIX issue #2: pin debris visual to arm during REELING
      }
      this._transitionTo(S.GRAPPLED);
      eventBus.emit(Events.ARM_CAPTURED, {
        armId: this.id, targetId: this.target?.id, type: this.type,
        detached: this.isDetached,
        mass: this.target?.mass || 0, debrisType: this.target?.type || 'unknown',
      });
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.id}: Target secured! SMA cinch complete.`,
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
        console.warn(
          `[NETTING-FSM ${this.id}] target lost during net flight ` +
          `(committed=${this._netCommittedTarget?.id ?? 'null'} ` +
          `alive=${this._netCommittedTarget?.alive}) → RETURNING`
        );
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.id}: Target lost during net flight — returning empty.`,
          priority: 'warning',
        });
        if (this._netCommittedTarget) this._netCommittedTarget._committedNetArmId = null;
        this._netCommittedTarget = null;
        if (this._stationKeepTarget) this._stationKeepTarget._isStationKeepTarget = false;
        this._stationKeepTarget = null;
        this._transitionTo(S.RETURNING);
      } else {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.id}: Netting failed — holding standoff. Press F to retry.`,
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
        });
      } else {
        // Issue-B GUARD (STOWED miss path): same target-alive check.
        const committedAliveStowed = this._netCommittedTarget && this._netCommittedTarget.alive !== false;
        if (!committedAliveStowed) {
          console.warn(
            `[NETTING-FSM ${this.id}] STOWED miss with dead target ` +
            `(committed=${this._netCommittedTarget?.id ?? 'null'}) → RETURNING`
          );
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: `${this.id}: Target lost during net flight — returning empty.`,
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
          text: `${this.id}: No tether — committing to deorbit burn. Sacrificial play.`,
          priority: 'warning',
        });
        return;
      }
      // V5: Zero-fuel motor reel-in instead of fuel-burning HAULING
      this._transitionTo(S.REELING);
      const _hasPayload = this.capturedDebris !== null;
      const _reelSpeed = _hasPayload ? REEL_IN_SPEED_LOADED : REEL_IN_SPEED_EMPTY;
      const _eta = (this.tetherLength / Math.max(_reelSpeed, 1)).toFixed(1);
      eventBus.emit(Events.COMMS_MESSAGE, {
        source: this.id,
        text: `Reeling in — ETA ${_eta} s`,
        channel: 'CMD',
        priority: 'info',
      });
    }
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
        text: `${this.id}: No tether — committing to deorbit burn. Sacrificial play.`,
        priority: 'warning',
      });
      return;
    }

    const toParent = this._tmpVec.subVectors(parentPos, this.position);
    const dist = toParent.length();

    toParent.normalize();
    const haulSpeed = this.config.haulSpeed * (this._beaconSpeedScale || 1);
    this.velocity.lerp(toParent.multiplyScalar(haulSpeed), 0.05);
    this.position.add(this.velocity.clone().multiplyScalar(dt));

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
    const reelSpeed = hasPayload ? REEL_IN_SPEED_LOADED : REEL_IN_SPEED_EMPTY;
    const reelSpeedScaled = reelSpeed * M;

    // Compute strut-tip dock world position: parentPos + parentQuat × dockOffset.
    // Falls back to parentPos (mother centre) if quaternion or dockOffset absent
    // (pre-Config-G compat / test harness with minimal mocks).
    const dockWorldPos = this._tmpDockTarget || (this._tmpDockTarget = new THREE.Vector3());
    if (parentQuat && this.dockOffset) {
      dockWorldPos.copy(this.dockOffset).applyQuaternion(parentQuat).add(parentPos);
    } else {
      dockWorldPos.copy(parentPos);
    }

    // Direction toward strut-tip dock (reuse pre-allocated _tmpVec)
    const toMother = this._tmpVec.subVectors(dockWorldPos, this.position);
    const dist = toMother.length();

    // [DBG-REEL] One-shot at REELING entry — confirms the function fires AND
    // logs the initial distance.  Subsequent frames are silent to avoid log
    // spam.  Reset when leaving REELING so the next reel-in logs fresh.
    if (!this._dbgReelLogged) {
      this._dbgReelLogged = true;
      const distM = dist / M;
      const etaS = (reelSpeed > 0 && distM > 0) ? (distM / reelSpeed).toFixed(1) : 'n/a';
      console.warn(
        `[DBG-REEL ${this.id}] REEL-IN START dist=${distM.toFixed(1)}m ` +
        `reelSpeed=${reelSpeed}m/s ETA=${etaS}s payload=${hasPayload} ` +
        `captorByArm=${this.capturedDebris?._capturedByArm?.id || 'NONE'}`
      );
    }

    // FIX (reel-in unit bug): the previous threshold `dist > 0.001` treated the
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

    // Update tether length
    this.tetherLength = dist / M;

    // Calculate tension (simplified: F = m × a_reel)
    const armMass = this.config.type === 'weaver' ? V5_WEAVER_MASS : V5_SPINNER_MASS;
    const payloadMass = hasPayload && this.capturedDebris ? (this.capturedDebris.mass || 0) : 0;
    this.tetherTension = (armMass + payloadMass) * reelSpeed * 0.5; // Simplified tension estimate

    // Emit tension update
    eventBus.emit(Events.TETHER_TENSION_UPDATE, {
      armIndex: this.index,
      tension: this.tetherTension,
      fraction: this.tetherTension / this.tetherBreakStrength,
    });

    // Check for tether snap
    if (this.tetherTension > this.tetherBreakStrength) {
      eventBus.emit(Events.TETHER_SNAP, { armIndex: this.index, armId: this.id, cause: 'overload' });
      this._transitionTo(S.EXPENDED);
    }

    // NO fuel consumption! This is the key V5 benefit.
    // Power draw from reel motor only (handled by PowerDistribution)

    // Emit reel state
    this.reeling = true;
    eventBus.emit(Events.TETHER_REEL_STATE, {
      armIndex: this.index,
      reeling: true,
      speed: reelSpeed,
    });
  }

  /** RETURNING: return to parent without debris */
  _updateReturning(dt, parentPos) {
    // Detached arms can't return — switch to free-flying transit
    if (this.isDetached) {
      this._transitionTo(S.TRANSIT);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${this.id}: Cannot return — tether severed. Free-flying.`,
        priority: 'warning',
      });
      return;
    }

    const toParent = this._tmpVec.subVectors(parentPos, this.position);
    const dist = toParent.length();

    toParent.normalize();
    const returnSpeed = this.config.approachSpeed * (this._beaconSpeedScale || 1);
    this.velocity.lerp(toParent.multiplyScalar(returnSpeed), 0.08);
    this.position.add(this.velocity.clone().multiplyScalar(dt));

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
    const dockWorldPos = this.dockOffset.clone();
    if (parentQuat) dockWorldPos.applyQuaternion(parentQuat);
    dockWorldPos.add(parentPos);

    this.position.lerp(dockWorldPos, 0.05);

    if (this.stateTimer > Constants.ARM_DOCK_DURATION) {
      // Process captured debris
      if (this.capturedDebris) {
        this.captures++;
        eventBus.emit(Events.DEBRIS_CAPTURED, {
          debrisId: this.capturedDebris.id,
          armId: this.id,
          type: this.type,
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.id}: Debris processed. Capture #${this.captures}.`,
          priority: 'success',
        });
        // POLISH FIX issue #2: release the pin so DebrisField stops using the
        // arm position. The debris is removed via DEBRIS_CAPTURED handler
        // (GameFlowManager.removeDebris) so the visual disappears cleanly.
        this.capturedDebris._capturedByArm = null;
        this.capturedDebris = null;
      }
      // POLISH FIX: keep daughter VISIBLE at the strut after a successful
      // retrieval — set deploy state to DEPLOYED so PlayerSatellite.postArmUpdate
      // shows her clamped to the strut tip (instead of hiding her until next
      // undock).  Was previously left at LOCKED post-retrieval → invisible.
      if (this._deployState === Constants.DEPLOY_STATES.LOCKED ||
          this._deployState === Constants.DEPLOY_STATES.STOWED) {
        this._deployState = Constants.DEPLOY_STATES.DEPLOYED;
      }
      this.target = null;
      this._fishingMode = false;          // clear fishing flag on re-dock
      this._manualCapture = false;        // reset manual capture flag on re-dock
      this._nearbyDebris = [];
      this.reeling = false;
      this.tetherTension = 0;

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

  /** FISHING: passive ambush — hibernate at end of tether, auto-capture on proximity */
  _updateFishing(dt, parentPos) {
    this.mesh.visible = true;
    this.tetherLine.visible = true;

    // If still deploying outward, move along fishing direction
    const currentTether = this.position.distanceTo(parentPos) / M;
    this.tetherLength = currentTether;
    const targetDist = this._fishingDeployTarget || this.config.tetherMax * 0.8;

    if (currentTether < targetDist) {
      // Still extending — slow drift outward (§4.6 fix: fallback uses world dir)
      const dir = this._fishingDir || this._worldDockDirection(this._lastParentQuat);
      this.position.add(dir.clone().multiplyScalar(this.config.approachSpeed * 0.5 * dt));
    }
    // else: at position, hibernating — very low power

    // Check proximity to any nearby debris (auto-capture)
    // Uses _nearbyDebris array injected by ArmManager each frame
    if (this._nearbyDebris && this._nearbyDebris.length > 0) {
      const captureRadius = this.config.netSize * M * 0.5; // half net size as capture radius
      for (const debris of this._nearbyDebris) {
        if (!debris.alive || !debris._scenePosition) continue;
        const dist = this.position.distanceTo(debris._scenePosition);
        if (dist < captureRadius) {
          // Auto-capture triggered!
          this.target = debris;
          this.capturedDebris = debris;
          debris._captured = true;  // UX Fix E+: hide reticle immediately
          debris._capturedByArm = this; // POLISH FIX issue #2: pin debris visual to arm during REELING
          this._fishingMode = false;
          this._transitionTo(S.GRAPPLED);
          eventBus.emit(Events.ARM_CAPTURED, {
            armId: this.id, targetId: debris.id, type: this.type, mode: 'fishing',
            detached: this.isDetached,
            mass: debris.mass || 0, debrisType: debris.type || 'unknown',
          });
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: `${this.id}: 🎣 Ambush capture! Target ${debris.id} caught passively.`,
            priority: 'success',
          });
          break;
        }
      }
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
          sender: this.id, text: 'Trawl complete — free-flying, no tether.', priority: 'info',
        });
        this._transitionTo(S.TRANSIT);
      } else {
        // V5: Use REELING for zero-fuel return
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: this.id, text: 'Trawl complete — reeling in', priority: 'info',
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
      const typeLabel = this.type === 'weaver' ? 'Weaver' : 'Spinner';
      if (fuelFrac <= Constants.DETACH_FUEL_WARNING_10 && !this._detachFuelWarning10) {
        this._detachFuelWarning10 = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `CRITICAL: ${typeLabel} ${this.id} fuel at 10%. Recommend immediate deorbit.`,
          priority: 'critical',
        });
      } else if (fuelFrac <= Constants.DETACH_FUEL_WARNING_25 && !this._detachFuelWarning25) {
        this._detachFuelWarning25 = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `WARNING: ${typeLabel} ${this.id} fuel at 25%. Limited maneuver capability.`,
          priority: 'warning',
        });
      }
    }

    if (this.fuel <= 0) {
      this.fuel = 0;
      this._trawlingMode = false;

      if (this.isDetached) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Daughter lost. ${this.type === 'weaver' ? 'Weaver' : 'Spinner'} ${this.id} fuel depleted — no thrust available.`,
          priority: 'critical',
        });
        eventBus.emit(Events.ARM_LOST, { armId: this.id });
      } else {
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: this.id, text: 'Trawl aborted — fuel depleted', priority: 'warning',
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

    // Also check _nearbyDebris (same as fishing)
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
          });
          eventBus.emit(Events.COMMS_MESSAGE, {
            sender: this.id,
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
    const retrograde = this.position.clone().normalize().cross(
      new THREE.Vector3(0, 1, 0)
    ).normalize().negate();
    // ST-8.3.4: Use metal-specific thrust calculation
    const thrustDV = (this._computeMetalThrust() / (this.config.mass + (this.capturedDebris?.mass || 0))) * dt;
    this.velocity.add(retrograde.multiplyScalar(thrustDV));
    this.position.add(this.velocity.clone().multiplyScalar(dt));

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
        text: `${this.id}: Fuel exhausted — deorbit burn complete. Arm lost.`,
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
          text: `${this.id}: 🕸 Web hit! Debris ${debrisId} drag ×${Constants.WEB_SHOT_DRAG_MULT}`,
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
   * TANGLED: V5 tether tangle state — auto-resolution via gentle slack pulses.
   * @private
   */
  _updateTangled(dt) {
    this.tangleTimer += dt;

    // Apply periodic tension pulses
    if (Math.floor(this.tangleTimer * 2) % 2 === 0) {
      this.tetherTension = TANGLE_SLACK_PULSE;
    } else {
      this.tetherTension = 0;
    }

    if (this.tangleTimer >= TANGLE_RESOLVE_TIME) {
      // Tangle resolved
      this.tangleTimer = 0;
      this.tanglePartner = null;
      this._transitionTo(this._preTangleState || S.DOCKED);
      this._preTangleState = null;
    }
  }

  /** EXPENDED: no fuel, drifting */
  _updateExpended(dt) {
    this.position.add(this.velocity.clone().multiplyScalar(dt * 0.5));
    this.velocity.multiplyScalar(0.999);
    this.mesh.visible = true;
    this.tetherLine.visible = true;
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
      [S.FISHING]: 0.02,          // Hibernate mode — ~10 mW, near-zero consumption
      [S.WEB_SHOT]: 0.0,          // Fuel consumed upfront in fireWebShot()
      [S.ABLATING]: 0.0,          // V5: laser de-spin — zero FEEP fuel (no stored-energy model)
      [S.SCANNING]: 0.0,          // V5: sensor mode — zero FEEP fuel (no stored-energy model)
      [S.TANGLED]: 0.0,           // V5: Tangled — no active thrust
    };
    const rate = rates[this.state] || 0;
    this.fuel -= rate * dt;

    // === Detached arm fuel warnings (Phase 6 — no refuel possible) ===
    if (this.isDetached) {
      const fuelFrac = this.fuel / 100;
      const typeLabel = this.type === 'weaver' ? 'Weaver' : 'Spinner';

      if (fuelFrac <= Constants.DETACH_FUEL_WARNING_25 && !this._detachFuelWarning25) {
        this._detachFuelWarning25 = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `WARNING: ${typeLabel} ${this.id} fuel at 25%. Limited maneuver capability.`,
          priority: 'warning',
        });
      }
      if (fuelFrac <= Constants.DETACH_FUEL_WARNING_10 && !this._detachFuelWarning10) {
        this._detachFuelWarning10 = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `CRITICAL: ${typeLabel} ${this.id} fuel at 10%. Recommend immediate deorbit.`,
          priority: 'critical',
        });
      }
    }

    if (this.fuel <= 0) {
      this.fuel = 0;

      // Detached arms that run out of fuel: emit ARM_LOST
      if (this.isDetached) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Daughter lost. ${this.type === 'weaver' ? 'Weaver' : 'Spinner'} ${this.id} fuel depleted — no thrust available.`,
          priority: 'critical',
        });
        eventBus.emit(Events.ARM_LOST, { armId: this.id });
      } else {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${this.id}: FUEL DEPLETED — arm expended`,
          priority: 'critical',
        });
      }
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
    if (this.state === S.DOCKED || this.state === S.RELOADING) {
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
      this.tetherLine.computeLineDistances(); // required for LineDashedMaterial
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
    this.tetherLine.computeLineDistances(); // required for LineDashedMaterial

    // POLISH: Dash-flow animation during REELING — make the dashes appear to
    // slide along the tether toward the mother, giving the user a clear visual
    // cue that the reel motor is winching the daughter (and her catch) home.
    // Implementation: subtract an accumulated phase from each lineDistance so
    // the LineDashedMaterial's dash pattern shifts in the direction of the
    // mother (vertex 0 = anchor side; lower lineDistance values).
    if (this.state === S.REELING && typeof dt === 'number' && dt > 0) {
      const _rs = (this.capturedDebris !== null
        ? REEL_IN_SPEED_LOADED : REEL_IN_SPEED_EMPTY);
      this._tetherDashPhase = (this._tetherDashPhase || 0) + _rs * dt * M;
      // Keep phase bounded (modulo dash period) so it never drifts large
      // enough to lose floating-point precision over a long reel-in.
      const _period = (this.tetherMaterial.dashSize + this.tetherMaterial.gapSize);
      if (_period > 0 && this._tetherDashPhase > _period) {
        this._tetherDashPhase -= _period;
      }
      const distArr = this.tetherLine.geometry.attributes.lineDistance.array;
      const phase = this._tetherDashPhase;
      for (let i = 0; i < distArr.length; i++) {
        distArr[i] -= phase;
      }
      this.tetherLine.geometry.attributes.lineDistance.needsUpdate = true;
    } else if (this._tetherDashPhase) {
      // Reset phase when leaving REELING so dashes snap back to static layout.
      this._tetherDashPhase = 0;
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
    for (const plume of this._thrusterPlumes) {
      if (isThrusting) {
        plume.visible = true;
        const flicker = 0.4 + Math.random() * 0.3;
        plume.material.opacity = flicker;
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
      case S.FISHING:    this._statusLightMat.color.setHex(blink ? 0x00aa44 : 0x002200); break;
      case S.TRAWLING:   this._statusLightMat.color.setHex(blink ? 0x44aaff : 0x002244); break;
      case S.DEORBITING: this._statusLightMat.color.setHex(blink ? 0xff4400 : 0x441100); break;
      case S.WEB_SHOT:   this._statusLightMat.color.setHex(blink ? 0xffffff : 0x448844); break;
      case S.ABLATING:   this._statusLightMat.color.setHex(blink ? 0xff4488 : 0x441122); break;
      case S.SCANNING:   this._statusLightMat.color.setHex(blink ? 0x88ffff : 0x224444); break;
      case S.TANGLED:    this._statusLightMat.color.setHex(blink ? 0xff8800 : 0x442200); break;
      case S.STATION_KEEP: this._statusLightMat.color.setHex(blink ? 0x00ffaa : 0x004422); break;
      case S.EXPENDED:   this._statusLightMat.color.setHex(0xff0000); break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ST-9.4 C-6: CAPTURE NET INVENTORY
  // Per CAPTURE_NET.md §6.1 — weaver=Medium(2), spinner=Small(4) at Y0.
  // Gated by FEATURE_FLAGS.CAPTURE_NET. When OFF: inventory stays 0.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Initialise net inventory from CAPTURE_NET constants for this arm's type.
   * Called by CaptureNetSystem.init() or ArmManager after arm creation.
   */
  initNetInventory() {
    if (!Constants.isFeatureEnabled('CAPTURE_NET')) return;
    const type = this.config.type;
    const capacity = Constants.ARM_NET_CAPACITY[type] ?? 0;
    this._netInventoryMax = capacity;
    this._netInventory = capacity;
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

// UX Fix D: Class-level nudge counter (first 3 deploys show P-hint, then stop)
ArmUnit._pilotNudgeCount = 0;
