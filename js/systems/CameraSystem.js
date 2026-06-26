/**
 * CameraSystem.js — Multi-view camera system
 * V key toggles two named views: FLY (chase, default) ↔ LOOK AROUND (orbit).
 * Close inspection is NOT a separate cycle stop — it engages automatically as a
 * zoom sub-state of LOOK AROUND (Schmitt-trigger on distance). Other views
 * (cockpit, target lock, arm pilot, net cinematic) are entered by their own
 * bindings.
 * Smooth transitions via position/lookAt lerp.
 * @module systems/CameraSystem
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { captureNetSystem } from '../entities/CaptureNet.js';
import { persistenceManager } from './PersistenceManager.js';
import { CeremonyTimeScale } from './CeremonyTimeScale.js';

// ============================================================================
// VIEW MODES
// ============================================================================

/** @enum {string} Camera view modes */
export const CameraViews = {
  FIRST_PERSON: 'FIRST_PERSON',
  CHASE: 'CHASE',
  ORBIT: 'ORBIT',
  TARGET_LOCK: 'TARGET_LOCK',
  ARM_PILOT: 'ARM_PILOT',
  INSPECTION: 'INSPECTION',
  NET_CINEMATIC: 'NET_CINEMATIC',
};

/**
 * View cycling order driven by the V key.
 *
 * 2026-06-15 (2-cycle revamp): V toggles just two named views —
 *   FLY (fly the ship) ↔ LOOK AROUND (pull back, orbit the camera, study the
 *   field). This re-aligns the cycle with the onboarding copy, which already
 *   teaches a two-view model.
 *
 * Close inspection is NOT a cycle stop: zooming in while in LOOK AROUND
 * auto-enters an inspection sub-state (Schmitt-trigger on distance) that engages
 * the narrow FOV, dynamic near-plane, vignette and contextual wireframe overlay.
 * A Tab-locked debris focuses the debris wireframe; otherwise the mothership.
 *
 * The discrete INSPECTION view + the legacy bare-I / toggleInspection() path
 * remain available (entered via enterInspection()); pressing V from there wraps
 * back to FLY. FIRST_PERSON, ARM_PILOT and NET_CINEMATIC remain outside the
 * cycle (entered by their own bindings).
 */
const VIEW_CYCLE = [
  CameraViews.CHASE,          // FLY (default)
  CameraViews.ORBIT,          // LOOK AROUND (zoom in here to inspect the mothership)
];

/** Human-readable labels for HUD display */
const VIEW_LABELS = {
  [CameraViews.FIRST_PERSON]: '🎯 COCKPIT',
  [CameraViews.CHASE]:        '🛰 FLY',
  [CameraViews.TARGET_LOCK]:  '🔒 TACTICAL',
  [CameraViews.ORBIT]:        '🔭 LOOK AROUND',
  [CameraViews.ARM_PILOT]:    '🤖 DAUGHTER PILOT',
  [CameraViews.INSPECTION]:   '🔍 INSPECTION',
  [CameraViews.NET_CINEMATIC]: '🎬 NET CINEMATIC',
};

// ============================================================================
// CAMERA SYSTEM
// ============================================================================

export class CameraSystem {
  /**
   * @param {THREE.PerspectiveCamera} camera - The scene camera
   * @param {HTMLCanvasElement} canvas - For mouse events (orbit mode)
   */
  constructor(camera, canvas, scene = null) {
    /** @type {THREE.PerspectiveCamera} */
    this.camera = camera;

    /** @type {HTMLCanvasElement} */
    this.canvas = canvas;

    // ========================================================================
    // CAMERA FILL LIGHT
    // Warm PointLight that follows the camera — illuminates the spacecraft
    // regardless of sun angle (like a cockpit instrument floodlight).
    // Only created when a scene reference is supplied.
    // ========================================================================
    /** @type {THREE.PointLight|null} */
    this._fillLight = null;
    if (scene) {
      // Color: slightly warm white (spacecraft instrument lighting feel).
      //
      // UNIT-SCALE NOTE: the scene is 1 unit = 100 km, so the camera-to-ship
      // distance is tiny in scene units (a 15 m chase cam ≈ 0.00015). three.js
      // attenuation is `1 / max(pow(d, decay), 0.01)` — with decay=2 the
      // `pow(0.00015, 2)=2.25e-8` term is always below the 0.01 floor, so the
      // inverse-square pinned at its MAX (1/0.01 = 100×). That turned a nominal
      // 0.35 fill into an effective ~35× frontal flood (vs the sun's 2.0),
      // flattening the ship into a washed-out, shapeless read and making the
      // brightness lurch as the cutoff window faded between ~30–100 m of zoom.
      // (Same class of bug as the −0.001=−100 m panel offset.)
      //
      // Fix: decay=0 (no inverse-square — the 100 km scale makes physical
      // falloff meaningless here) gives a constant base of 1, and a wide
      // cutoff (0.01 units ≈ 1 km) keeps the window ≈1 across the whole
      // gameplay zoom band so the fill no longer changes with zoom. Effective
      // intensity is now ~0.5, a genuine subtle fill. Night-side/eclipse
      // readability that used to lean on the accidental flood is restored via
      // the ambient + hemisphere lift in SceneManager/SunLight.
      this._fillLight = new THREE.PointLight(0xfff5e0, 0.5, 0.01, 0);
      this._fillLight.name = 'cameraFillLight';
      scene.add(this._fillLight);
    }

    /** @private scene reference for fill-light cleanup */
    this._scene = scene;

    /** @type {string} Current view mode */
    this.currentView = CameraViews.CHASE;

    /** @type {string|null} Previous view (for transition) */
    this._previousView = null;

    /** @type {('mother'|'debris'|'daughter')|null} Focused subject while in INSPECTION */
    this._inspectSubject = null;

    // ========================================================================
    // TRANSITION STATE
    // ========================================================================
    this._transitioning = false;
    this._transitionProgress = 0;
    this._transitionDuration = 0.5; // seconds
    this._transitionStartOffset = new THREE.Vector3(); // Start offset from player for transition
    this._transitionStartLookDir = new THREE.Vector3(); // Start look DIRECTION for transition
    this._lastPlayerPos = new THREE.Vector3(); // Cached player pos for setView
    this._lastVelDir = new THREE.Vector3(0, 0, 1);

    // ========================================================================
    // CHASE CAMERA CONFIG
    // ========================================================================
    this.chase = {
      offsetBehind: 0.00015,   // Distance behind player along velocity (~15m)
      offsetAbove: 0.00007,    // Distance above player along radial (~7m)
      lookAhead: 0.00002,      // Look-ahead past player (~2m, keeps spacecraft centered)
      smoothing: 3.0,          // Damping factor (higher = faster follow)
      targetLookBias: 0.25,    // 2026-06-03: fraction the look point eases toward
                               // a locked target (folded-in TACTICAL framing).
                               // 0 = off (pure chase); keep subtle.
    };

    // ========================================================================
    // FIRST PERSON CONFIG
    // ========================================================================
    this.firstPerson = {
      offsetForward: 0.000025, // Slightly in front of satellite center
      offsetUp: 0.000005,      // Slight upward offset
      headBobAmplitude: 0.0000005, // Subtle head-bob during thrust
      headBobFrequency: 8.0,
      headBobPhase: 0,
      freeLookYaw: 0,          // Mouse free-look yaw (right-click drag)
      freeLookPitch: 0,        // Mouse free-look pitch
      freeLookActive: false,
    };

    // ========================================================================
    // ORBIT CAMERA CONFIG
    // ========================================================================
    this.orbit = {
      theta: Math.PI,           // Azimuthal angle (start behind player — same direction as cockpit)
      phi: Math.PI / 4,        // Polar angle (radians)
      distance: 0.0003,        // Distance from player (~30m)
      minDistance: 0.00002,     // Minimum zoom (~2m — lowered so OVERVIEW can push into inspection depth; near-clip scales dynamically below the inspect threshold)
      maxDistance: 0.01,        // Maximum zoom
      rotateSpeed: 0.005,      // Mouse rotation sensitivity
      zoomSpeed: 0.0001,       // Scroll zoom speed
      isDragging: false,
      lastMouseX: 0,
      lastMouseY: 0,
      damping: 0.92,           // Rotation momentum damping
      velocityTheta: 0,
      velocityPhi: 0,

      // ----------------------------------------------------------------------
      // Zoom-driven inspection sub-state (2026-06-03 consolidation rev. 2)
      // ----------------------------------------------------------------------
      // Inspection is no longer a separate view. While in OVERVIEW, zooming in
      // past `inspectEnterDist` engages a mothership inspection sub-state
      // (narrow FOV, dynamic near-plane, vignette, hull/wireframe overlays);
      // zooming back out past the larger `inspectExitDist` disengages it. The
      // gap between the two distances is a Schmitt trigger that prevents the
      // overlay/FOV from flickering when the camera parks near the boundary.
      inspectEnterDist: 0.00012,  // ~12m — push in closer than this to inspect
      inspectExitDist: 0.00018,   // ~18m — pull back past this to leave inspect
      inspectActive: false,       // current sub-state (hysteresis output)
      inspectTaught: false,       // one-shot learning beat fired?
    };

    // ========================================================================
    // INSPECTION CAMERA CONFIG (S2.1 — close-range mechanical inspection)
    // ========================================================================
    // `fov` here is the single source of truth for the inspection lens, shared
    // by BOTH the discrete INSPECTION view (enterInspection) and the OVERVIEW
    // zoom-driven sub-state (_setInspectZoom reads this.inspection.fov) so the
    // two paths can't drift.
    this.inspection = {
      theta: Math.PI,
      phi: Math.PI / 4,
      distance: 0.0002,         // Start at ~20m
      minDistance: 0.00002,      // 2m minimum — see mechanical detail
      maxDistance: 0.0005,       // 50m maximum
      rotateSpeed: 0.005,
      zoomSpeed: 0.00003,       // Slower zoom for fine control
      isDragging: false,
      lastMouseX: 0,
      lastMouseY: 0,
      damping: 0.92,
      velocityTheta: 0,
      velocityPhi: 0,
      fov: 35,                  // Narrow FOV like zoom lens
      savedFov: null,           // Stores previous FOV to restore on exit
    };

    // ========================================================================
    // ARM PILOT CONFIG
    // ========================================================================
    this.armPilot = {
      arm: null,              // Reference to ArmUnit being piloted
      fovNarrow: Constants.CAMERA_FOV_ARM_PILOT,  // 40° narrow FOV for arm camera
      fovNormal: Constants.CAMERA_FOV,             // Stored normal FOV to restore (55° COMMAND base)
      offsetBehind: 0.00005,  // 5m behind arm center — enough to see arm + debris at standoff
      offsetAbove: 0.000016,  // 1.6m above arm
    };

    // ========================================================================
    // TARGET LOCK CONFIG
    // ========================================================================
    this.targetLock = {
      target: null,             // THREE.Vector3 or null
      offsetDistance: 0.0003,   // Camera offset from midpoint
      smoothing: 2.5,
      minCamDist: 0.0001,      // Min distance from player
    };

    // ========================================================================
    // SHARED STATE
    // ========================================================================
    this._currentTargetPos = new THREE.Vector3();  // Where camera should be
    this._currentTargetLook = new THREE.Vector3(); // Where camera should look
    this._thrustMagnitude = 0; // For head-bob

    // S4: Camera shake on catch (enhanced from Phase 8)
    this._catchShakeTimer = 0;     // seconds remaining for shake effect
    this._catchShakeDuration = Constants.CATCH_SHAKE_DURATION || 0.3; // total shake duration
    this._catchShakeIntensity = Constants.CATCH_SHAKE_INTENSITY || 0.003; // scene units offset

    // Phase 4: FOV breathe during sustained thrust (I-War heritage)
    this._fovBreathOffset = 0;       // current FOV offset in degrees
    this._fovBreathTarget = 0;       // target FOV offset
    this._fovBreathTimer = 0;        // sustained thrust timer (seconds)
    this._baseFov = camera.fov;      // base FOV to offset from

    // OVERVIEW zoom-inspection FOV ease state (undefined = inactive sentinel).
    this._inspectZoomFovTarget = undefined; // target _baseFov while easing in/out
    this._inspectZoomSavedFov = undefined;  // _baseFov captured on engage, restored on exit
    this._thrustVisualDir = null;    // 'prograde' | 'retrograde' | 'lateral' | null
    this._thrustVisualMag = 0;       // current thrust magnitude for FOV

    // ST-5.3: VLEO cinematic intro — wider establishing shot
    this._vleoIntroScale = 1.0;      // chase-offset multiplier (1.0 = normal)
    this._vleoIntroHolding = false;  // true while the 4 s hold is active

    // Pre-allocated temporary vectors for update() hot path
    this._tmpVecA = new THREE.Vector3();
    this._tmpVecB = new THREE.Vector3();
    this._tmpVecC = new THREE.Vector3();

    // V-7: Launch ceremony state
    this._launchCeremony = {
      active: false,
      phase: 0,       // 0=inactive, 1=PRE_LAUNCH, 2=LAUNCH, 3=COAST, 4=HANDOFF
      timer: 0,
      arm: null,
      savedFov: 0,    // Pre-ceremony _baseFov for ESC restore
      prevPos: new THREE.Vector3(),
      prevLook: new THREE.Vector3(),
    };

    // Q2: Net ceremony cinematic state (parallel to _launchCeremony)
    this._netCeremony = {
      active: false,
      beatIndex: 0,
      beatTimer: 0,
      beats: [],          // ordered beat definitions: [{ key, duration, fov }]
      armIndex: -1,
      podIndex: -1,
      arm: null,           // ArmUnit reference (the arm that fired the net)
      savedView: null,     // previous CameraView to restore
      savedFov: 0,         // pre-ceremony _baseFov
      isFirstEver: false,  // true if this is the first-ever net deploy
      success: null,       // null until NET_CEREMONY_COMPLETE event
      // Persistent geometry (set once at ceremony start)
      _launchFwd: new THREE.Vector3(),     // launch direction (unit)
      _sideDir: new THREE.Vector3(),       // port-side (cross fwd × radialUp)
      _netDiameterScene: 0,                // D × M, scene units
      // Per-frame scratch vectors (ZERO allocation in hot path)
      _v3a: new THREE.Vector3(),  // result pos
      _v3b: new THREE.Vector3(),  // result look
      _v3c: new THREE.Vector3(),  // localUp / result up
      _v3d: new THREE.Vector3(),  // debrisPos
      _v3e: new THREE.Vector3(),  // general scratch
      _scratchNetPos: new THREE.Vector3(), // net scene position
    };

    // ========================================================================
    // HUD OVERLAY for view indicator
    // ========================================================================
    this._viewIndicator = null;
    this._viewIndicatorTimer = 0;
    /** @type {boolean} When true the indicator stays on screen (no fade) —
     * used for non-default views so the player never loses track of being
     * in LOOK AROUND. Cleared when returning to the default FLY view. */
    this._viewIndicatorPersistent = false;
    this._createViewIndicator();
    this._inspectionVignette = null;
    this._createInspectionVignette();

    // ========================================================================
    // MOUSE EVENT HANDLERS
    // ========================================================================
    // Sim mode: NO camera shake on capture. Previously bumped the camera on
    // ARM_CAPTURED / LASSO_CAPTURED ("catch juice"), which read as arcade
    // feedback. A real ADR sat catching sub-kg debris would feel nothing.
    // Listeners removed per user feedback.

    // Phase 4: Listen for thrust visual events for FOV breathe
    eventBus.on(Events.THRUST_VISUAL, (data) => {
      this._thrustVisualMag = data.magnitude || 0;
      this._thrustVisualDir = data.direction || null;
    });

    // V-7: Launch ceremony trigger
    eventBus.on(Events.LAUNCH_CEREMONY_START, ({ arm }) => {
      this.startLaunchCeremony(arm);
    });

    // Q2: Net ceremony event subscriptions (gated at handler entry)
    eventBus.on(Events.NET_CEREMONY_START, (payload) => {
      this._onNetCeremonyStart(payload);
    });
    eventBus.on(Events.NET_BRAKE_FIRED, (payload) => {
      this._onNetBrakeFired(payload);
    });
    eventBus.on(Events.NET_CEREMONY_COMPLETE, (payload) => {
      this._onNetCeremonyComplete(payload);
    });

    this._boundMouseDown = this._onMouseDown.bind(this);
    this._boundMouseMove = this._onMouseMove.bind(this);
    this._boundMouseUp = this._onMouseUp.bind(this);
    this._boundWheel = this._onWheel.bind(this);
    this._boundContextMenu = (e) => {
      if (this.currentView === CameraViews.FIRST_PERSON ||
          this.currentView === CameraViews.ORBIT) {
        e.preventDefault();
      }
    };

    this._attachMouseListeners();
  }

  // ==========================================================================
  // VIEW CYCLING
  // ==========================================================================

  /**
   * Toggle the camera view (V key): FLY ↔ LOOK AROUND.
   *
   * 2026-06-15 (2-cycle): close inspection is no longer a cycle stop — it
   * engages automatically by zooming in while in LOOK AROUND. The discrete
   * INSPECTION view is still reachable via the legacy bare-I / toggleInspection()
   * path; pressing V from there wraps back to FLY and restores optics/overlay.
   *
   * @param {string|number|null} [lockedId] - The currently Tab-locked debris id
   *   (or null). Accepted for API stability with the V-key caller; no longer used
   *   directly now that INSPECTION left the cycle.
   */
  cycleView(lockedId = null) {
    void lockedId; // retained for caller API stability (INSPECTION left the cycle)
    const cur = this.currentView;

    // From the legacy discrete INSPECTION view, V wraps back to FLY (restores
    // optics/overlay).
    if (cur === CameraViews.INSPECTION) {
      this.exitInspection(CameraViews.CHASE);
      return;
    }

    const currentIdx = VIEW_CYCLE.indexOf(cur);
    const nextIdx = (currentIdx + 1) % VIEW_CYCLE.length;
    const next = VIEW_CYCLE[nextIdx];
    this.setView(next);
  }

  /**
   * Set a specific camera view with smooth transition.
   * @param {string} view - A CameraViews enum value
   */
  setView(view) {
    if (view === this.currentView && !this._transitioning) return;

    // Leaving OVERVIEW clears the zoom-driven inspection sub-state so its
    // narrow FOV / near-plane / vignette / overlay don't leak into the next
    // view. (No-op if it was never engaged.)
    if (this.currentView === CameraViews.ORBIT && view !== CameraViews.ORBIT) {
      this._clearInspectZoom();
    }

    // Q2 Stage 6: external view switch during an active net ceremony aborts
    // the ceremony cleanly (FOV/time-scale restored, FIRST_NET_DEPLOY NOT
    // written). NET_CINEMATIC entries from the ceremony itself are exempt.
    if (this._netCeremony.active && view !== CameraViews.NET_CINEMATIC) {
      this._abortNetCeremony();
    }

    this._previousView = this.currentView;
    this.currentView = view;

    // Start transition — capture current camera state as OFFSET from player
    this._transitioning = true;
    this._transitionProgress = 0;
    // When leaving orbit/inspection view, use canonical theta=π (behind + above) position
    // to prevent 90° roll caused by arbitrary orbit theta
    if ((this._previousView === CameraViews.ORBIT || this._previousView === CameraViews.INSPECTION) && this._lastVelDir) {
      const radialDir = this._lastPlayerPos.clone().normalize();
      const velDir = this._lastVelDir;
      const cfg = this._previousView === CameraViews.INSPECTION ? this.inspection : this.orbit;
      const d = cfg.distance;
      const cosPhi = Math.cos(cfg.phi);
      const sinPhi = Math.sin(cfg.phi);
      // Canonical orbit: theta=π → cosTheta=-1, sinTheta=0
      // offset = radialDir * d * cosPhi + (-velDir) * d * sinPhi
      const canonOffset = radialDir.clone().multiplyScalar(d * cosPhi)
        .sub(velDir.clone().multiplyScalar(d * sinPhi));
      this._transitionStartOffset.copy(canonOffset);
      this._transitionStartLookDir.copy(canonOffset).negate().normalize();
    } else {
      this._transitionStartOffset.copy(this.camera.position).sub(this._lastPlayerPos);
      // Capture the camera's current look direction (unit vector)
      this._transitionStartLookDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    }

    // Reset orbit + inspection drag state
    this.orbit.isDragging = false;
    this.orbit.velocityTheta = 0;
    this.orbit.velocityPhi = 0;
    this.inspection.isDragging = false;
    this.inspection.velocityTheta = 0;
    this.inspection.velocityPhi = 0;

    // Reset free look
    this.firstPerson.freeLookYaw = 0;
    this.firstPerson.freeLookPitch = 0;
    this.firstPerson.freeLookActive = false;

    // Show view indicator (skip for ARM_PILOT enter/exit — controls strip handles it)
    const isArmPilotTransition = view === CameraViews.ARM_PILOT || this._previousView === CameraViews.ARM_PILOT;
    if (!isArmPilotTransition) {
      this._showViewIndicator(view);
    } else {
      // ARM_PILOT uses its own controls strip, not the camera view indicator.
      // Force-clear the indicator so a persistent badge (e.g. "🔭 LOOK AROUND ·
      // [V] to fly", set when LOOK AROUND was entered) doesn't linger on screen
      // through the entire piloting session.
      this._viewIndicatorPersistent = false;
      this._viewIndicatorTimer = 0;
      this._hideViewIndicator();
    }

    // Diagnostic vignette — fade in only for the INSPECT view.
    this._updateInspectionVignette(view);

    // Notify other systems of the view change
    eventBus.emit(Events.CAMERA_VIEW_CHANGE, { view, label: VIEW_LABELS[view] });
    // UX-2 #12: Route camera view change through notification zone
    // (skip for ARM_PILOT enter/exit — controls strip provides the indicator)
    if (!isArmPilotTransition) {
      eventBus.emit(Events.SHOW_NOTIFICATION, { text: VIEW_LABELS[view] });
    }
    console.log(`[CameraSystem] View: ${VIEW_LABELS[view]}`);
  }

  /**
   * Get the current view mode.
   * @returns {string}
   */
  getView() {
    return this.currentView;
  }

  /**
   * Get the human-readable label for the current view.
   * @returns {string}
   */
  getViewLabel() {
    return VIEW_LABELS[this.currentView] || 'UNKNOWN';
  }

  // ==========================================================================
  // SET TARGET (for Target Lock mode)
  // ==========================================================================

  /**
   * Set the target position for Target Lock camera.
   * @param {THREE.Vector3|null} targetPos - World position of the target
   */
  setLockTarget(targetPos) {
    this.targetLock.target = targetPos ? targetPos.clone() : null;
  }

  /**
   * Set current thrust magnitude (for head-bob in first person).
   * @param {number} magnitude - 0 to 1
   */
  setThrustMagnitude(magnitude) {
    this._thrustMagnitude = magnitude;
  }

  // ==========================================================================
  // UPDATE — Called every frame
  // ==========================================================================

  /**
   * Update camera position and orientation.
   * @param {number} dt - Delta time in seconds
   * @param {THREE.Vector3} playerPos - Player position in scene
   * @param {{ x: number, y: number, z: number }} playerVel - Player velocity (km/s)
   * @param {THREE.Quaternion} [playerQuat] - Player orientation quaternion
   */
  update(dt, playerPos, playerVel, playerQuat) {
    if (!playerPos || !playerVel) return;

    this._lastVelDir.set(playerVel.x, playerVel.y, playerVel.z).normalize();
    const velDir = this._lastVelDir;
    const radialDir = playerPos.clone().normalize();
    this._lastPlayerPos.copy(playerPos); // Cache for setView()

    // V-7: Launch ceremony override — bypass normal view computation
    if (this._launchCeremony.active) {
      const result = this._updateLaunchCeremony(dt, playerPos, velDir, radialDir, playerQuat);
      if (result) {
        this.camera.position.copy(result.pos);
        // V-8 fix: use daughter's radial-up when camera is near her (Phases 2-3).
        // Mother's radialDir diverges as tether extends — same fix as ARM_PILOT (line 489).
        const c = this._launchCeremony;
        const ceremonyUp = (c.phase >= 2 && c.arm?.position)
          ? c.arm.position.clone().normalize()
          : radialDir;
        this.camera.up.copy(ceremonyUp);
        this.camera.lookAt(result.look);
      }
    } else if (this._netCeremony.active) {
      // Q2: Net cinematic override — bypass normal view computation
      const ncResult = this._updateNetCeremony(dt, playerPos, velDir, radialDir, playerQuat);
      if (ncResult) {
        this.camera.position.copy(ncResult.pos);
        this.camera.up.copy(ncResult.up);
        this.camera.lookAt(ncResult.look);
      }
    } else {
    // Compute target camera state based on current view
    let targetPos;
    let targetLook;

    let targetUp;  // optional explicit up vector from per-view compute (overrides default)
    switch (this.currentView) {
      case CameraViews.FIRST_PERSON:
        ({ pos: targetPos, look: targetLook } = this._computeFirstPerson(dt, playerPos, velDir, radialDir, playerQuat));
        break;

      case CameraViews.CHASE:
        ({ pos: targetPos, look: targetLook } = this._computeChase(dt, playerPos, velDir, radialDir, true));
        break;

      case CameraViews.ORBIT:
        ({ pos: targetPos, look: targetLook } = this._computeOrbit(dt, playerPos, velDir, radialDir));
        break;

      case CameraViews.TARGET_LOCK:
        // NOTE (2026-06-03): TARGET_LOCK is no longer reachable — it was dropped
        // from VIEW_CYCLE and nothing else calls setView(TARGET_LOCK) (see the
        // VIEW_CYCLE comment + GameFlowManager's "no auto-switch" note). Its
        // side-on framing benefit is now folded into CHASE via targetLookBias.
        // Kept intact (this case, _computeTargetLock, VIEW_INFO_LEVELS.TARGET_LOCK,
        // the GameFlowManager revert) so the view can be re-enabled by simply
        // re-adding it to VIEW_CYCLE if the framing is wanted again.
        ({ pos: targetPos, look: targetLook } = this._computeTargetLock(dt, playerPos, velDir, radialDir));
        break;

      case CameraViews.ARM_PILOT:
        // SK branch returns an explicit up vector (daughter-local) so the
        // horizon stays stable as daughter orbits debris.
        ({ pos: targetPos, look: targetLook, up: targetUp } = this._computeArmPilot(dt, playerPos, velDir, radialDir));
        break;

      case CameraViews.INSPECTION:
        ({ pos: targetPos, look: targetLook } = this._computeInspection(dt, playerPos, velDir, radialDir));
        break;
    }

    // Handle smooth transition between views (position + lookAt lerp, no quaternion slerp)
    if (this._transitioning) {
      this._transitionProgress += dt / this._transitionDuration;

      if (this._transitionProgress >= 1.0) {
        this._transitioning = false;
        this._transitionProgress = 1.0;
        // UX Fix B: Finalize FOV transition when view transition completes
        if (this._fovTransitionStart !== undefined && this._fovTransitionEnd !== undefined) {
          this._baseFov = this._fovTransitionEnd;
          this.camera.fov = this._fovTransitionEnd;
          this.camera.updateProjectionMatrix();
          this._fovTransitionStart = undefined;
          this._fovTransitionEnd = undefined;
        }
      }

      // Smooth easing (ease-in-out cubic)
      const t = this._transitionProgress;
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      // UX Fix B: Smooth FOV lerp piggybacked on view transition
      if (this._fovTransitionStart !== undefined && this._fovTransitionEnd !== undefined) {
        const lerpedFov = this._fovTransitionStart + (this._fovTransitionEnd - this._fovTransitionStart) * ease;
        this._baseFov = lerpedFov;
        this.camera.fov = lerpedFov;
        this.camera.updateProjectionMatrix();
      }

      // Lerp OFFSET from player (not absolute position) to track orbiting player
      const targetOffset = targetPos.clone().sub(playerPos);
      const currentOffset = this._tmpVecA.lerpVectors(this._transitionStartOffset, targetOffset, ease);
      this.camera.position.copy(playerPos).add(currentOffset);

      // Interpolate look DIRECTION (nlerp — normalized linear interp of direction vectors)
      // This avoids the scale mismatch of lerping absolute positions
      const targetLookDir = targetLook.clone().sub(targetPos).normalize();
      const lerpedDir = this._tmpVecB.lerpVectors(this._transitionStartLookDir, targetLookDir, ease);
      if (lerpedDir.lengthSq() < 0.0001) lerpedDir.copy(targetLookDir); // fallback
      lerpedDir.normalize();
      const currentLook = this.camera.position.clone().add(lerpedDir.multiplyScalar(0.001));

      // Always use radialDir as up — maintains roll-free constraint throughout
      this.camera.up.copy(radialDir);
      this.camera.lookAt(currentLook);
    } else {
      // All views: direct position copy (no lerp smoothing).
      // At orbital velocity (~128m/frame), any position lerp causes
      // the camera to fall behind the player and lose tracking.
      this.camera.position.copy(targetPos);
      // ARM_PILOT: prefer the explicit up vector returned by _computeArmPilot
      // (SK branch returns daughter-local +Y so the horizon stays stable as
      // daughter orbits debris — Earth-radial wobbles at φ-poles).  If no
      // explicit up was provided (non-SK branch), fall back to the daughter's
      // Earth-radial up (mother's radial diverges as tether extends).
      if (this.currentView === CameraViews.ARM_PILOT && this.armPilot.arm?.position) {
        if (targetUp && targetUp.lengthSq() > 1e-12) {
          this.camera.up.copy(targetUp);
        } else {
          this.camera.up.copy(this.armPilot.arm.position.clone().normalize());
        }
      } else {
        this.camera.up.copy(radialDir);
      }
      this.camera.lookAt(targetLook);
    }
    } // end V-7 ceremony else

    // Phase 8: Apply camera shake offset (catches, not ARM_PILOT)
    if (this._catchShakeTimer > 0) {
      this._catchShakeTimer -= dt;
      const intensity = this._catchShakeIntensity * (this._catchShakeTimer / this._catchShakeDuration);
      this.camera.position.x += (Math.random() - 0.5) * 2 * intensity;
      this.camera.position.y += (Math.random() - 0.5) * 2 * intensity;
      this.camera.position.z += (Math.random() - 0.5) * 2 * intensity;
    }

    // Update view indicator timer (skipped while the indicator is persistent —
    // non-default views keep the badge on screen so the player never loses
    // track of being in LOOK AROUND).
    if (!this._viewIndicatorPersistent && this._viewIndicatorTimer > 0) {
      this._viewIndicatorTimer -= dt;
      if (this._viewIndicatorTimer <= 0) {
        this._hideViewIndicator();
      }
    }

    // Zoom-inspection FOV ease (OVERVIEW sub-state). The dedicated view-
    // transition FOV lerp only runs when _fovTransitionEnd is set (armPilot /
    // ceremony / discrete-inspection paths); the zoom sub-state doesn't use it,
    // so this independent ease drives _baseFov toward the inspect target
    // (narrow) or back to the saved base — including across an OVERVIEW→COMMAND
    // view change, where the transition lerp is a no-op. Yields to the
    // transition lerp if one is actually configured to avoid double-driving FOV.
    if (this._inspectZoomFovTarget !== undefined && this._fovTransitionEnd === undefined) {
      const easeRate = 5.0; // ~200ms to 63%
      this._baseFov += (this._inspectZoomFovTarget - this._baseFov) * Math.min(1, easeRate * dt);
      if (Math.abs(this._baseFov - this._inspectZoomFovTarget) < 0.05) {
        this._baseFov = this._inspectZoomFovTarget;
        this._inspectZoomFovTarget = undefined; // settled — release control
      }
      this.camera.fov = this._baseFov + this._fovBreathOffset;
      this.camera.updateProjectionMatrix();
    }

    // Phase 4: FOV breathe during sustained thrust (I-War heritage)
    // Skip during ARM_PILOT (has its own narrow FOV)
    if (this.currentView !== CameraViews.ARM_PILOT && !this._launchCeremony.active && !this._netCeremony.active) {
      const thrustMag = this._thrustVisualMag;
      if (thrustMag > 0.05) {
        // Accumulate sustained thrust timer
        this._fovBreathTimer = Math.min(this._fovBreathTimer + dt, 1.0);
        // Only apply after 500ms sustained thrust (ramp from 0.5s to 1.0s)
        const sustainFrac = Math.max(0, (this._fovBreathTimer - 0.5) / 0.5);
        // Prograde: narrow FOV (tunnel-vision acceleration), Retrograde: widen FOV (braking)
        const maxOffset = 2.5 * thrustMag * sustainFrac;
        if (this._thrustVisualDir === 'prograde') {
          this._fovBreathTarget = -maxOffset;  // narrow — acceleration tunnel-vision
        } else if (this._thrustVisualDir === 'retrograde') {
          this._fovBreathTarget = maxOffset;   // widen — braking expansion
        } else {
          this._fovBreathTarget = 0;
        }
      } else {
        this._fovBreathTimer = Math.max(0, this._fovBreathTimer - dt * 2);
        this._fovBreathTarget = 0;
      }
      // Ease toward target (500ms ease)
      const easeRate = 4.0; // ~250ms to 63% of target
      this._fovBreathOffset += (this._fovBreathTarget - this._fovBreathOffset) * Math.min(1, easeRate * dt);
      // Apply offset to camera FOV
      if (Math.abs(this._fovBreathOffset) > 0.01) {
        this.camera.fov = this._baseFov + this._fovBreathOffset;
        this.camera.updateProjectionMatrix();
      } else if (Math.abs(this.camera.fov - this._baseFov) > 0.01 && this._fovBreathTarget === 0) {
        this.camera.fov = this._baseFov;
        this.camera.updateProjectionMatrix();
      }
      // Reset per-frame thrust signal
      this._thrustVisualMag = 0;
      this._thrustVisualDir = null;
    }

    // ST-5.3: VLEO intro offset decay — smooth ease back to normal after hold ends
    if (!this._vleoIntroHolding && this._vleoIntroScale > 1.001) {
      const easeRate = Constants.EARTH.VLEO_INTRO_EASE_RATE;
      this._vleoIntroScale += (1.0 - this._vleoIntroScale) * Math.min(1, easeRate * dt);
      if (this._vleoIntroScale < 1.001) this._vleoIntroScale = 1.0;
    }

    // Sync fill light to camera — illuminates whatever the camera is looking at
    if (this._fillLight) {
      this._fillLight.position.copy(this.camera.position);
    }
  }

  // ==========================================================================
  // VIEW COMPUTATION METHODS
  // ==========================================================================

  /**
   * Compute first-person (cockpit) camera position and look target.
   * @private
   */
  _computeFirstPerson(dt, playerPos, velDir, radialDir, playerQuat) {
    // Camera mounted at front of satellite, looking along velocity
    const pos = playerPos.clone()
      .add(velDir.clone().multiplyScalar(this.firstPerson.offsetForward))
      .add(radialDir.clone().multiplyScalar(this.firstPerson.offsetUp));

    // Head-bob during thrust
    if (this._thrustMagnitude > 0.01) {
      this.firstPerson.headBobPhase += dt * this.firstPerson.headBobFrequency;
      const bobX = Math.sin(this.firstPerson.headBobPhase) * this.firstPerson.headBobAmplitude * this._thrustMagnitude;
      const bobY = Math.cos(this.firstPerson.headBobPhase * 0.7) * this.firstPerson.headBobAmplitude * 0.5 * this._thrustMagnitude;
      const lateral = this._tmpVecA.crossVectors(velDir, radialDir).normalize();
      pos.add(lateral.multiplyScalar(bobX));
      pos.add(radialDir.clone().multiplyScalar(bobY));
    }

    // Look direction: along velocity with optional free-look
    let look = playerPos.clone().add(velDir.clone().multiplyScalar(0.001));

    if (this.firstPerson.freeLookActive) {
      // Apply yaw/pitch offsets to look direction
      const lateral = this._tmpVecA.crossVectors(velDir, radialDir).normalize();
      look.add(lateral.multiplyScalar(this.firstPerson.freeLookYaw * 0.001));
      look.add(radialDir.clone().multiplyScalar(this.firstPerson.freeLookPitch * 0.001));
    }

    return { pos, look };
  }

  /**
   * Compute chase (third-person) camera position and look target.
   * Camera behind and above satellite, looking AT the spacecraft.
   * @private
   */
  _computeChase(dt, playerPos, velDir, radialDir, allowTargetBias = false) {
    // ST-5.3: VLEO intro uses wider offsets for cinematic establishing shot
    const s = this._vleoIntroScale;

    // Position: behind (opposite velocity) and above (along radial out)
    const pos = playerPos.clone()
      .sub(velDir.clone().multiplyScalar(this.chase.offsetBehind * s))
      .add(radialDir.clone().multiplyScalar(this.chase.offsetAbove * s));

    // Look target: at the player with a tiny forward offset (keeps spacecraft centered)
    const look = playerPos.clone()
      .add(velDir.clone().multiplyScalar(this.chase.lookAhead));

    // 2026-06-03: Folded-in TARGET_LOCK behaviour. When a debris target is
    // locked (set each frame during APPROACH) and reasonably close, gently bias
    // the look point toward it and ease the camera back a touch so both the
    // ship and the target stay framed — without the jarring side-on framing of
    // the old dedicated TACTICAL view. Bias is intentionally subtle and only
    // applied to the live CHASE view (not the ARM_PILOT / TARGET_LOCK fallbacks).
    if (allowTargetBias && this.targetLock.target) {
      const sep = playerPos.distanceTo(this.targetLock.target);
      // Only engage within the OVERVIEW zoom range (~1 km) to avoid acting on a
      // stale target left over from a previous approach.
      if (sep > 1e-9 && sep < this.orbit.maxDistance) {
        const bias = this.chase.targetLookBias; // 0..1 fraction toward target
        look.lerp(this.targetLock.target, bias);
        // Pull back proportional to separation (capped) so the target does not
        // crowd the edge of frame as it nears.
        const pullback = Math.min(sep * 0.4, this.chase.offsetBehind * 1.5);
        pos.sub(velDir.clone().multiplyScalar(pullback));
      }
    }

    return { pos, look };
  }

  /**
   * Compute orbit camera position (free orbit around player).
   * Uses LVLH (Local Vertical Local Horizontal) frame so the orbit camera
   * is aligned with the orbital reference frame — no skew or roll artifacts.
   * Mouse drag to rotate, scroll to zoom.
   * @private
   */
  _computeOrbit(dt, playerPos, velDir, radialDir) {
    // Apply momentum damping
    this.orbit.theta += this.orbit.velocityTheta;
    this.orbit.phi += this.orbit.velocityPhi;
    this.orbit.velocityTheta *= this.orbit.damping;
    this.orbit.velocityPhi *= this.orbit.damping;

    // Clamp phi to avoid gimbal lock
    this.orbit.phi = Math.max(0.1, Math.min(Math.PI - 0.1, this.orbit.phi));

    // Build LVLH frame: radial = "up pole", lateral = "right", forward = "ahead"
    const lateral = this._tmpVecA.crossVectors(velDir, radialDir).normalize();
    // Re-derive forward to guarantee orthogonality
    const forward = this._tmpVecB.crossVectors(radialDir, lateral).normalize();

    // Spherical to Cartesian offset in LVLH frame
    // phi: angle from radial (0 = directly above, π = directly below)
    // theta: azimuth around radial in the forward/lateral plane
    const sinPhi = Math.sin(this.orbit.phi);
    const cosPhi = Math.cos(this.orbit.phi);
    const cosTheta = Math.cos(this.orbit.theta);
    const sinTheta = Math.sin(this.orbit.theta);

    const offset = this._tmpVecC.set(0, 0, 0)
      .addScaledVector(radialDir, this.orbit.distance * cosPhi)
      .addScaledVector(forward, this.orbit.distance * sinPhi * cosTheta)
      .addScaledVector(lateral, this.orbit.distance * sinPhi * sinTheta);

    const pos = playerPos.clone().add(offset);
    const look = playerPos.clone();

    // When zoomed into the inspection sub-state, scale the near-plane to the
    // (very small) distance so close mechanical detail doesn't clip. Outside
    // the sub-state, leave the near-plane at the global default (restored by
    // _setInspectZoom(false)).
    if (this.orbit.inspectActive) {
      this._applyDynamicNearPlane(this.orbit.distance);
    }

    return { pos, look };
  }

  /**
   * Scale the camera near-plane to a (very small) inspection distance so close
   * mechanical detail doesn't clip. Shared by both inspection paths — the
   * OVERVIEW zoom sub-state (_computeOrbit) and the discrete INSPECTION view
   * (_computeInspection) — so the optics stay identical and can't drift. The
   * change-guard avoids a projection-matrix rebuild on frames where near barely
   * moves.
   * @param {number} distance camera-to-subject distance in scene units
   * @private
   */
  _applyDynamicNearPlane(distance) {
    const newNear = Math.max(distance * 0.02, 0.000001);
    if (Math.abs(this.camera.near - newNear) > newNear * 0.1) {
      this.camera.near = newNear;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Evaluate the zoom-driven inspection sub-state for OVERVIEW (ORBIT).
   *
   * Called after every OVERVIEW zoom change. Uses a Schmitt trigger: engage
   * inspection once the camera pushes closer than `inspectEnterDist`, and only
   * disengage once it pulls back past the larger `inspectExitDist`. The gap
   * between the two prevents flicker when the player parks near the boundary.
   * Mothership-only (2026-06-03 decision) — debris/daughter inspection stays on
   * the explicit bare-I / ARM_PILOT path.
   * @private
   */
  _evaluateInspectZoom() {
    if (this.currentView !== CameraViews.ORBIT) return;

    const o = this.orbit;
    if (!o.inspectActive && o.distance < o.inspectEnterDist) {
      this._setInspectZoom(true);
    } else if (o.inspectActive && o.distance > o.inspectExitDist) {
      this._setInspectZoom(false);
    }
  }

  /**
   * Engage/disengage the OVERVIEW zoom-inspection sub-state: tween FOV, manage
   * the dynamic near-plane, fade the vignette, and toggle the mothership
   * overlay. Does NOT change `currentView` — the named view stays OVERVIEW.
   * @param {boolean} on
   * @private
   */
  _setInspectZoom(on) {
    const o = this.orbit;
    if (o.inspectActive === on) return;
    o.inspectActive = on;

    if (on) {
      // Narrow the lens like the dedicated inspection view. Remember the
      // pre-zoom base FOV so exit restores exactly what OVERVIEW was using.
      // The FOV itself eases per-frame in update() (the view-transition FOV
      // lerp only runs during a view change, which this sub-state is not).
      this._inspectZoomSavedFov = this._baseFov;
      this._inspectZoomFovTarget = this.inspection.fov; // single source of truth (shared with discrete view)
      this._fovBreathOffset = 0;
      this._fovBreathTarget = 0;
      this._fovBreathTimer = 0;

      // Diagnostic vignette + mothership hull/wireframe overlay.
      this._updateInspectionVignette(CameraViews.INSPECTION);
      eventBus.emit(Events.INSPECTION_TOGGLE, { subject: 'mother', targetId: null });
      eventBus.emit(Events.INSPECT_HULL_OUTLINE, { visible: true });
      // Onboarding signal: fires only on mother-inspection ENGAGE (never exit)
      // so the `inspect` beat can confirm the player actually reached the depth
      // where the hull callouts appear.
      eventBus.emit(Events.MOTHER_INSPECTION_ENGAGED, {});

      // One-shot learning beat the first time inspection engages via zoom, so
      // the player understands the silent threshold did something deliberate.
      if (!o.inspectTaught) {
        o.inspectTaught = true;
        eventBus.emit(Events.SHOW_NOTIFICATION, { text: '🔍 INSPECTION. Overlays active' });
      }
    } else {
      // Restore lens (per-frame ease) + near-plane.
      this._inspectZoomFovTarget = this._inspectZoomSavedFov || Constants.CAMERA_FOV;
      this.camera.near = Constants.CAMERA_NEAR;
      this.camera.updateProjectionMatrix();

      // Fade vignette back out (any non-inspect view clears it) + hide overlay.
      this._updateInspectionVignette(CameraViews.ORBIT);
      eventBus.emit(Events.INSPECTION_TOGGLE, { subject: 'mother' });
      eventBus.emit(Events.INSPECT_HULL_OUTLINE, { visible: false });
    }
  }

  /**
   * Clear the zoom-inspection sub-state without a view transition — used when
   * leaving OVERVIEW so optics/overlays don't leak into the next view.
   *
   * Also pulls the stored OVERVIEW zoom distance back out to the exit threshold.
   * Without this, re-entering OVERVIEW (V→COMMAND→V) would leave orbit.distance
   * inside the inspection band while inspectActive is false — the optics/overlays
   * would stay off AND _computeOrbit's protective dynamic near-plane (gated on
   * inspectActive) would not engage, letting the camera clip through the
   * mothership until the next wheel event. Resetting the distance guarantees
   * OVERVIEW always re-opens outside the band.
   * @private
   */
  _clearInspectZoom() {
    if (!this.orbit.inspectActive) return;
    this._setInspectZoom(false);
    this.orbit.distance = Math.max(this.orbit.distance, this.orbit.inspectExitDist);
  }

  /**
   * Compute INSPECTION camera — reuses orbit math with tighter limits + dynamic near-plane.
   * @private
   */
  _computeInspection(dt, playerPos, velDir, radialDir) {
    const cfg = this.inspection;

    // Apply momentum damping
    cfg.theta += cfg.velocityTheta;
    cfg.phi += cfg.velocityPhi;
    cfg.velocityTheta *= cfg.damping;
    cfg.velocityPhi *= cfg.damping;

    // Clamp phi to avoid gimbal lock
    cfg.phi = Math.max(0.1, Math.min(Math.PI - 0.1, cfg.phi));

    // Build LVLH frame (same as orbit)
    const lateral = this._tmpVecA.crossVectors(velDir, radialDir).normalize();
    const forward = this._tmpVecB.crossVectors(radialDir, lateral).normalize();

    // Spherical to Cartesian offset
    const sinPhi = Math.sin(cfg.phi);
    const cosPhi = Math.cos(cfg.phi);
    const cosTheta = Math.cos(cfg.theta);
    const sinTheta = Math.sin(cfg.theta);

    const offset = this._tmpVecC.set(0, 0, 0)
      .addScaledVector(radialDir, cfg.distance * cosPhi)
      .addScaledVector(forward, cfg.distance * sinPhi * cosTheta)
      .addScaledVector(lateral, cfg.distance * sinPhi * sinTheta);

    const pos = playerPos.clone().add(offset);
    const look = playerPos.clone();

    // Dynamic near-plane (shared with the OVERVIEW zoom sub-state).
    this._applyDynamicNearPlane(cfg.distance);

    return { pos, look };
  }

  /**
   * Compute target lock camera — positions to show both satellite AND target.
   *
   * UNREACHABLE as of 2026-06-03 (TARGET_LOCK removed from VIEW_CYCLE; nothing
   * calls setView(TARGET_LOCK)). Retained intentionally for possible re-enable —
   * re-add CameraViews.TARGET_LOCK to VIEW_CYCLE to bring it back. The framing
   * intent now lives in _computeChase's targetLookBias.
   * @private
   */
  _computeTargetLock(dt, playerPos, velDir, radialDir) {
    const target = this.targetLock.target;

    if (!target) {
      // No target: fall back to chase behavior
      return this._computeChase(dt, playerPos, velDir, radialDir);
    }

    // Midpoint between player and target
    const midpoint = playerPos.clone().add(target).multiplyScalar(0.5);

    // Distance between player and target
    const separation = playerPos.distanceTo(target);

    // Camera should be offset perpendicular to the player-target line
    const toTarget = target.clone().sub(playerPos).normalize();
    const perpendicular = this._tmpVecA.crossVectors(toTarget, radialDir).normalize();
    if (perpendicular.lengthSq() < 0.001) {
      // Fallback if parallel
      perpendicular.crossVectors(toTarget, this._tmpVecB.set(0, 1, 0)).normalize();
    }

    // Camera distance scales with separation (keep both in frame)
    const camDist = Math.max(
      this.targetLock.minCamDist,
      separation * 0.8 + this.targetLock.offsetDistance
    );

    // Position camera to the side and above, looking at midpoint
    const pos = midpoint.clone()
      .add(perpendicular.clone().multiplyScalar(camDist * 0.5))
      .add(radialDir.clone().multiplyScalar(camDist * 0.3));

    // Look at a point weighted 85% satellite + 15% target
    const look = playerPos.clone().lerp(target, 0.15);

    return { pos, look };
  }

  // ==========================================================================
  // ARM PILOT CAMERA
  // ==========================================================================

  /**
   * Set the arm to follow in ARM_PILOT mode.
   * Narrows FOV and switches to ARM_PILOT view.
   * @param {import('../entities/ArmUnit.js').ArmUnit} arm
   */
  setPilotArm(arm) {
    if (!arm) return;
    this.armPilot.arm = arm;
    // Phase 4: Save base FOV (without breathe offset) and reset breathe state
    this.armPilot.fovNormal = this._baseFov;
    this._fovBreathOffset = 0;
    this._fovBreathTarget = 0;
    this._fovBreathTimer = 0;
    // UX Fix B: Smooth FOV transition (lerped during update) instead of instant snap
    this._fovTransitionStart = this._baseFov;
    this._fovTransitionEnd = this.armPilot.fovNarrow;
    // Look-direction blend: smooth transition into ARM PILOT view.
    // If the arm has a target, start the blend already facing toward it
    // so the camera doesn't reverse 180° when the arm flies retrograde
    // toward trailing debris.
    this.armPilot._lookBlendTime = 0;
    this.armPilot._lookBlendDuration = 1.5; // seconds
    this.armPilot._prevForward = new THREE.Vector3();
    if (arm.target && arm.target._scenePosition && arm.position) {
      this.armPilot._prevForward
        .subVectors(arm.target._scenePosition, arm.position)
        .normalize();
    } else if (arm.velocity && arm.velocity.lengthSq() > 1e-16) {
      this.armPilot._prevForward.copy(arm.velocity).normalize();
    } else {
      this.camera.getWorldDirection(this.armPilot._prevForward);
    }
    this.setView(CameraViews.ARM_PILOT);
  }

  /**
   * @private — Set up FOV transition + look-blend fields for ARM_PILOT entry.
   * Extracted from setPilotArm() so the launch-ceremony auto-entry path can
   * reuse the same logic without duplication.  Caller must set
   * this.armPilot.arm BEFORE invoking, then call setView(ARM_PILOT) AFTER.
   * @param {import('../entities/ArmUnit.js').ArmUnit} arm
   */
  _setupArmPilotEntry(arm) {
    this.armPilot.fovNormal = this._baseFov;
    this._fovBreathOffset = 0;
    this._fovBreathTarget = 0;
    this._fovBreathTimer = 0;
    this._fovTransitionStart = this._baseFov;
    this._fovTransitionEnd = this.armPilot.fovNarrow;
    // Look-direction blend: smooth transition into ARM_PILOT view.  If the arm
    // has a target, start the blend already facing toward it so the camera
    // doesn't reverse 180° when the arm flies retrograde toward trailing debris.
    this.armPilot._lookBlendTime = 0;
    this.armPilot._lookBlendDuration = 1.5;
    this.armPilot._prevForward = new THREE.Vector3();
    if (arm.target && arm.target._scenePosition && arm.position) {
      this.armPilot._prevForward
        .subVectors(arm.target._scenePosition, arm.position)
        .normalize();
    } else if (arm._stationKeepTarget && arm._stationKeepTarget._scenePosition && arm.position) {
      // Daughter already in SK before ceremony ended — face the debris.
      this.armPilot._prevForward
        .subVectors(arm._stationKeepTarget._scenePosition, arm.position)
        .normalize();
    } else if (arm.velocity && arm.velocity.lengthSq() > 1e-16) {
      this.armPilot._prevForward.copy(arm.velocity).normalize();
    } else {
      this.camera.getWorldDirection(this.armPilot._prevForward);
    }
  }

  /**
   * Exit ARM_PILOT mode — restore FOV and return to CHASE view.
   */
  clearPilotArm() {
    this.armPilot.arm = null;
    this.armPilot._skLookTarget = null; // Clear STATION_KEEP smooth look target
    this.armPilot._skLockedUp = null;   // Clear STATION_KEEP frozen up vector
    // Restore default ARM_PILOT offsets (ceremony may have boosted them to 8×)
    this.armPilot.offsetBehind = 0.00005;
    this.armPilot.offsetAbove  = 0.000016;
    // UX Fix B: Smooth FOV transition back (lerped during update)
    this._fovTransitionStart = this._baseFov;
    this._fovTransitionEnd = this.armPilot.fovNormal || Constants.CAMERA_FOV;
    // Return to CHASE view (triggers transition that will lerp FOV)
    this.setView(CameraViews.CHASE);
  }

  /**
    * Get the currently piloted arm (or null).
    * @returns {import('../entities/ArmUnit.js').ArmUnit|null}
    */
  getPilotedArm() {
    return this.armPilot.arm;
  }

  // ==========================================================================
  // LAUNCH CEREMONY (V-7)
  // ==========================================================================

  /**
   * Start 4-phase launch cinematic camera sequence.
   * @param {import('../entities/ArmUnit.js').ArmUnit} arm - The launched arm
   */
  startLaunchCeremony(arm) {
    if (!arm) return;
    const c = this._launchCeremony;
    c.active = true;
    c.phase = 1;  // OBSERVE
    c.timer = 0;
    c.arm = arm;
    c.prevPos.copy(this.camera.position);
    const lookDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    c.prevLook.copy(this.camera.position).add(lookDir.multiplyScalar(0.001));

    // Track spring-fire camera shake (trigger once during Phase 1)
    c._shookOnFire = false;

    // Reset dynamic slew multiplier — recomputed on first Phase 1 frame
    c._slewMultiplier = undefined;

    // Latch: once the crossbow spring fires, never override arm position again.
    // arm._springFired resets on LAUNCHING→TRANSIT transition, so the ceremony
    // needs its own persistent flag.
    c._springLatch = false;

    // Save pre-ceremony FOV for ESC restore and fovNormal (§14.8.11.3)
    c.savedFov = this._baseFov;

    // Cancel any active view transition — ceremony takes over (§14.8.11.6)
    this._transitioning = false;
    this._transitionProgress = 0;

    // Cancel FOV transition — ceremony manages FOV directly (§14.8.11.3)
    this._fovTransitionStart = undefined;
    this._fovTransitionEnd = undefined;

    // Reset ARM_PILOT offsets to defaults so Phase 2's * 8 is always correct.
    // A previous ceremony may have left boosted (8×) offsets from completion.
    this.armPilot.offsetBehind = 0.00005;
    this.armPilot.offsetAbove  = 0.000016;
  }

  /**
   * Skip launch ceremony — jump to ARM_PILOT or restore previous view.
   * @param {boolean} [enterPilot=true] - true → enter ARM_PILOT, false → return to CHASE (ESC)
   */
  skipLaunchCeremony(enterPilot = true) {
    const c = this._launchCeremony;
    if (!c.active) return;
    const arm = c.arm;
    c.active = false;
    c.phase = 0;
    // Restore FOV — ESC restores original, skip-to-pilot keeps eased value
    if (!enterPilot) {
      this._baseFov = c.savedFov || Constants.CAMERA_FOV;
    }
    this.camera.fov = this._baseFov;
    // Restore near-plane pushed during Phase 2-3
    this.camera.near = Constants.CAMERA_NEAR;
    this.camera.updateProjectionMatrix();
    if (enterPilot && arm) {
      eventBus.emit(Events.LAUNCH_CEREMONY_COMPLETE, { arm });
    }
  }

  /**
   * Update launch ceremony — 3-phase cinematic camera sequence.
   *
   * User experience timeline:
   *   Phase 1 OBSERVE (1.5s) — Camera stays at CHASE. Player watches from behind:
   *     • Daughter powers up (status LED), strut rotates to aim at target
   *     • ~0.3s: Crossbow spring fires → camera shake (mother recoil)
   *     • Daughter shoots off toward target, tether streams out
   *   Phase 2 TETHER_FOLLOW (2.0s) — Camera zooms from mother along tether to daughter:
   *     • Smooth dolly from CHASE behind-mother to behind-daughter
   *     • Not FPV — slightly behind & above so new player keeps perspective
   *     • Tether visible connecting back to mother as camera advances
   *     • FOV narrows gradually (cinematic zoom-in feel)
   *   Phase 3 HANDOFF (0.5s) — Camera settles to ARM_PILOT view:
   *     • Final convergence to standard arm-pilot viewpoint
   *     • FOV eases to ARM_PILOT narrow (40°)
   *
   * @private
   * @returns {{ pos: THREE.Vector3, look: THREE.Vector3 }|null}
   */
  _updateLaunchCeremony(dt, playerPos, velDir, radialDir, playerQuat) {
    const c = this._launchCeremony;
    //                     Phase:  0    1       2       3
    const DURATIONS = [0, 3.25, 3.5, 1.0]; // total 7.75s.
    // Phase 1 (3.25s): spring fires at CROSSBOW_UNDOCK_TIME (1.5s), leaving ~1.75s
    //   for the player to actually SEE the daughter separate and fly free in the
    //   familiar wide CHASE view before the camera leaves the mothership.
    // Phase 2 (3.5s) / Phase 3 (1.0s): longer, gentler glide + settle into the
    //   pilot view so the handoff reads as gradual rather than a lunge.
    c.timer += dt;

    // ── Phase complete? Advance ──
    if (c.timer >= DURATIONS[c.phase]) {
      c.timer -= DURATIONS[c.phase];
      c.phase++;

      // Phase 2 entry: camera starts zooming along tether toward daughter
      if (c.phase === 2) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `Tracking ${c.arm.displayName}. Tether deploying`,
          priority: 'info',
        });
      }

      // Phase 3 entry: boost ARM_PILOT offsets BEFORE Phase 3 runs.
      // _computeArmPilot() reads these offsets, so they must be boosted
      // before Phase 3's first frame — otherwise it lerps to 0.3m (default).
      if (c.phase === 3) {
        this.armPilot.offsetBehind = 0.00005;   // 5m behind
        this.armPilot.offsetAbove  = 0.000016;  // 1.6m above
      }

      if (c.phase > 3) {
        // Ceremony complete → return to CHASE view.
        // ARM_PILOT is ONLY entered when the user presses the P hotkey.
        // Restore near-plane pushed during Phase 2-3
        this.camera.near = Constants.CAMERA_NEAR;
        this.camera.updateProjectionMatrix();
        const completingArm = c.arm;
        c.active = false;
        c.phase = 0;
        // Camera STAYS on the daughter — auto-enter ARM_PILOT view so the
        // player immediately gets the inspection framing of the debris instead
        // of being yanked back to the mothership CHASE view.
        this.armPilot.offsetBehind = 0.00005;   // 5m past debris (in SK branch)
        this.armPilot.offsetAbove  = 0.000016;  // 1.6m above
        this.armPilot.arm = completingArm;
        this._setupArmPilotEntry(completingArm);
        // Force a transition lerp so camera doesn't snap (setView would otherwise
        // short-circuit if currentView happens to already match).
        this._previousView = this.currentView;
        this._transitioning = true;
        this._transitionProgress = 0;
        this._transitionStartOffset.copy(this.camera.position).sub(this._lastPlayerPos);
        this._transitionStartLookDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        this.setView(CameraViews.ARM_PILOT);
        eventBus.emit(Events.LAUNCH_CEREMONY_COMPLETE, { arm: completingArm });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `${completingArm.displayName} deployed. Arrow keys orbit debris, ESC to recall`,
          priority: 'info',
        });
        // Return ARM_PILOT position (camera follows daughter / inspection view).
        return this._computeArmPilot(dt, playerPos, velDir, radialDir);
      }
    }

    const t = c.timer / DURATIONS[c.phase];
    const ease = t * t * (3 - 2 * t); // smoothstep
    const arm = c.arm;
    if (!arm || !arm.position) { this.skipLaunchCeremony(); return null; }

    // Guard: arm died during ceremony
    if (arm.state === 'EXPENDED' || arm.state === 'DOCKED') {
      this.skipLaunchCeremony(false);
      return null;
    }

    // V-8 fix: Daughter reached STATION_KEEP before ceremony finished (timing
    // race when debris is close — e.g. 35m at 10 m/s ≈ 3.5s arrival vs 6s
    // ceremony). Complete immediately so the daughter is still findable and
    // armPilot is prepped — the ceremony hands the player straight into the
    // daughter (LAUNCH_CEREMONY_COMPLETE auto-enters ARM_PILOT).
    // Cannot use skipLaunchCeremony() — it omits armPilot setup, comms, and
    // LAUNCH_CEREMONY_COMPLETE. Instead, replicate the phase > 3 completion
    // block inline (same logic as lines 937-962 above).
    if (arm.state === Constants.ARM_STATES.STATION_KEEP && c.phase < 3) {
      this.camera.near = Constants.CAMERA_NEAR;
      this.camera.updateProjectionMatrix();
      const completingArm = c.arm;
      c.active = false;
      c.phase = 0;
      // Same as phase>3 path: stay on daughter via ARM_PILOT (don't jump to mother).
      this.armPilot.offsetBehind = 0.00005;   // 5m past debris (in SK branch)
      this.armPilot.offsetAbove  = 0.000016;  // 1.6m above
      this.armPilot.arm = completingArm;
      this._setupArmPilotEntry(completingArm);
      this._previousView = this.currentView;
      this._transitioning = true;
      this._transitionProgress = 0;
      this._transitionStartOffset.copy(this.camera.position).sub(this._lastPlayerPos);
      this._transitionStartLookDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.setView(CameraViews.ARM_PILOT);
      eventBus.emit(Events.LAUNCH_CEREMONY_COMPLETE, { arm: completingArm });
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `${completingArm.displayName} deployed. Arrow keys orbit debris, ESC to recall`,
        priority: 'info',
      });
      return this._computeArmPilot(dt, playerPos, velDir, radialDir);
    }

    const armPos = arm.position.clone();
    const localUp = armPos.clone().normalize();
    let pos, look;

    // ── Compute forward direction toward target (shared by phases 2-3) ──
    let fwd = velDir.clone();
    if (arm.target && arm.target._scenePosition) {
      fwd = arm.target._scenePosition.clone().sub(armPos).normalize();
    } else if (arm.velocity && arm.velocity.lengthSq() > 1e-16) {
      fwd = arm.velocity.clone().normalize();
    }

    // Orthogonalize localUp against fwd so "behind" and "above" offsets
    // stay perpendicular — matches _computeArmPilot pattern (~line 1376).
    localUp.sub(fwd.clone().multiplyScalar(fwd.dot(localUp))).normalize();

    switch (c.phase) {

      // ════════════════════════════════════════════════════════════════════
      // Phase 1: OBSERVE (3.25s) — Camera at CHASE, watching the satellite
      // ════════════════════════════════════════════════════════════════════
      case 1: {
        // Drive strut slew toward target direction during clamp hold
        if (arm.launchDirection && arm._dockOutward && playerQuat && arm.setAimAlpha) {
          const invQuat = playerQuat.clone().invert();
          const localDir = arm.launchDirection.clone().applyQuaternion(invQuat).normalize();
          // Strut-alpha in the PlayerSatellite MODEL frame.
          // Model convention: barrel axis = Z, collar radial plane = XY.
          // _dockOutward stores (cos θ, 0, sin θ) in AimDecomposition's XZ convention,
          // so _dockOutward.z = sin(θ) maps to the model's Y-radial component.
          // sin(α) = target · model_outward = target.x·cos(θ) + target.y·sin(θ)
          const sinA = localDir.x * arm._dockOutward.x + localDir.y * arm._dockOutward.z;
          // cos(α) = target · (-ẑ_barrel) = -target.z
          const cosA = -localDir.z;
          const tgtAlpha = Math.atan2(Math.abs(sinA), cosA);

          // Dynamic slew multiplier: ensure strut reaches tgtAlpha BEFORE
          // the spring fires at CROSSBOW_UNDOCK_TIME.  Budget 80% of the
          // undock window so the strut settles before the daughter launches.
          // Minimum 4× so small angles still look smooth.
          if (c._slewMultiplier === undefined) {
            // First frame of Phase 1 — compute once from initial delta
            const curAlpha = arm.getAimAlpha ? arm.getAimAlpha() : 0;
            const angleDelta = Math.abs(tgtAlpha - curAlpha);
            const budget = Constants.CROSSBOW_UNDOCK_TIME * 0.8;  // 80% of undock window
            const baseRate = Constants.OCTOPUS_V5.STRUT_SLEW_RATE;  // rad/s
            // multiplier so that baseRate × multiplier × budget ≥ angleDelta
            const needed = angleDelta / (baseRate * Math.max(budget, 0.01));
            c._slewMultiplier = Math.max(4, Math.ceil(needed));
          }
          arm.setAimAlpha(tgtAlpha, dt * c._slewMultiplier);
        }

        // Latch spring-fire on the ceremony object so the flag survives
        // the LAUNCHING→TRANSIT state transition (ArmUnit resets _springFired).
        if (arm._springFired && !c._springLatch) {
          c._springLatch = true;
        }

        // Track strut tip position during clamp hold (before spring fires).
        // Use ceremony latch — arm._springFired resets on state transition.
        if (!c._springLatch && arm.dockOffset && playerQuat) {
          const tipOffset = arm.dockOffset.clone().applyQuaternion(playerQuat);
          arm.position.copy(playerPos).add(tipOffset);
        }

        // Comms message on spring fire — detect the moment _springFired flips true.
        if (c._springLatch && !c._shookOnFire) {
          c._shookOnFire = true;
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: `${arm.displayName}: Spring released. Separating`,
            priority: 'info',
          });
        }

        // Camera: stay exactly at CHASE (tracks orbiting player at ~7.6 km/s).
        // Look directly at the arm — starts at strut tip, flies away after spring fires.
        const chaseResult = this._computeChase(dt, playerPos, velDir, radialDir);
        pos = chaseResult.pos;
        look = arm.position.clone();
        break;
      }

      // ════════════════════════════════════════════════════════════════════
      // Phase 2: TETHER_FOLLOW (3.5s) — Zoom from mother to behind-daughter
      // ════════════════════════════════════════════════════════════════════
      case 2: {
        // Start: CHASE position (behind mother — where Phase 1 ended)
        const chasePos = this._computeChase(dt, playerPos, velDir, radialDir).pos;

        // End: behind the daughter arm (4m behind, 1.3m above).
        // Daughter mesh (~0.3m) fills ~8.5% of screen height at 45° FOV — clearly visible.
        // Several meters of tether are also in frame at this distance.
        const behindDaughter = armPos.clone()
          .sub(fwd.clone().multiplyScalar(0.00004))    // 4m behind
          .add(localUp.clone().multiplyScalar(0.000013)); // 1.3m above

        pos = new THREE.Vector3().lerpVectors(chasePos, behindDaughter, ease);

        // Look ahead (same 0.001 = 100m pattern as _computeArmPilot)
        // — keeps daughter in lower frame, tether trailing behind visible.
        const lookAhead = armPos.clone().add(fwd.clone().multiplyScalar(0.001));
        look = new THREE.Vector3().lerpVectors(armPos.clone(), lookAhead, ease);
        break;
      }

      // ════════════════════════════════════════════════════════════════════
      // Phase 3: HANDOFF (1.0s) — Settle to ARM_PILOT tracking view
      // ════════════════════════════════════════════════════════════════════
      case 3: {
        // Temporarily set armPilot.arm so _computeArmPilot works
        this.armPilot.arm = c.arm;
        const apResult = this._computeArmPilot(dt, playerPos, velDir, radialDir);

        // Start: behind-daughter (same geometry as Phase 2 endpoint).
        // Offsets are already boosted at Phase 2→3 transition (4m/1.3m).
        const startPos = armPos.clone()
          .sub(fwd.clone().multiplyScalar(this.armPilot.offsetBehind))
          .add(localUp.clone().multiplyScalar(this.armPilot.offsetAbove));
        const startLook = armPos.clone().add(fwd.clone().multiplyScalar(0.001));

        pos = new THREE.Vector3().lerpVectors(startPos, apResult.pos, ease);
        look = new THREE.Vector3().lerpVectors(startLook, apResult.look, ease);
        break;
      }
    }

    // ── FOV + near-plane management ──
    // Phase 1: keep CHASE FOV (no zoom — player observes from familiar view)
    // Phase 2-3: ease toward 45° (moderate cinematic view behind daughter).
    // Keep 45° through Phase 3 so the post-ceremony ARM_PILOT tracking view
    // matches Phase 2 exactly — no visual zoom from FOV narrowing.
    // User selecting a launched daughter (1-4) eases to 40° (armPilot.fovNarrow).
    if (c.phase >= 2) {
      const targetFov = 45;
      const fovEaseRate = 1.5;
      this._baseFov += (targetFov - this._baseFov) * Math.min(1, fovEaseRate * dt);
      this.camera.fov = this._baseFov;

      // Dynamic near-plane: camera is very close to daughter in phases 2-3.
      // Default CAMERA_NEAR (3m) clips the daughter mesh.  Push near to 0.1m
      // (same floor as INSPECTION mode) so daughter + tether stay visible.
      this.camera.near = 0.000001;   // ~0.1m
      this.camera.updateProjectionMatrix();
    }

    // [DBG-ARM] CEREMONY per-frame log removed (noise during launch ceremony).
    // Phase-change log at line ~1069 is kept (low-volume).

    return { pos, look };
  }

  // ==========================================================================
  // Q2: NET CEREMONY CINEMATIC (CEREMONY_REDESIGN.md §4)
  // ==========================================================================

  /**
   * NET_CEREMONY_START handler — enter NET_CINEMATIC mode.
   * @private
   */
  _onNetCeremonyStart(payload) {
    if (!Constants.FEATURE_FLAGS.NET_CEREMONY) return;
    if (this._netCeremony.active) return;       // already in ceremony
    if (this._launchCeremony.active) return;     // don't interrupt launch

    const c = this._netCeremony;
    const M = 0.00001;
    const NC = Constants.CAPTURE_NET.NET_CEREMONY;
    const BD = NC.BEAT_DURATIONS_S;
    const HCB = NC.HIGHLIGHTS_CUT_BEATS;
    const HTS = NC.HIGHLIGHTS_TIME_SCALE;

    // Read first-deploy flag from PersistenceManager
    const firstDeployDone = persistenceManager.getCeremonyFlag('FIRST_NET_DEPLOY');
    const isFirstEver = !firstDeployDone;

    // FOV targets per beat (design doc §5.3)
    const BEAT_FOV = {
      POD_MUZZLE_PREFIRE: 35,
      MUZZLE_EXIT_SPINUP: 40,
      GLAMOUR_SHOT:       50,
      APPROACH_DOLLY:     45,
      BRAKE_ENVELOP:      38,
      CINCH:              42,
      SECURED_SETTLE:     45,
    };

    // Stage 4 (CEREMONY_REDESIGN.md §5.1): per-beat physics time-scale.
    // Applied ONLY to NetProjectile.update() and CaptureNetVisual.update() via
    // CeremonyTimeScale. World dt stays at 1.0× (§6 R1).
    const BEAT_TIME_SCALE = {
      POD_MUZZLE_PREFIRE: NC.TIME_SCALE_PRE_FLIGHT, // 0.4 — beats 1–2
      MUZZLE_EXIT_SPINUP: NC.TIME_SCALE_PRE_FLIGHT, // 0.4
      GLAMOUR_SHOT:       NC.TIME_SCALE_GLAMOUR,    // 0.5 — beat 3
      APPROACH_DOLLY:     NC.TIME_SCALE_APPROACH,   // 0.6 — beat 4
      BRAKE_ENVELOP:      NC.TIME_SCALE_BRAKE,      // 0.3 — beat 5 (heavy slowmo)
      CINCH:              NC.TIME_SCALE_CINCH,      // 0.4 — beat 6
      SECURED_SETTLE:     1.0,                      // beat 7 — full speed
    };

    let beats;
    if (isFirstEver) {
      // Full 7-beat sequence
      beats = [
        { key: 'POD_MUZZLE_PREFIRE', duration: BD.POD_MUZZLE_PREFIRE, fov: 35, timeScale: BEAT_TIME_SCALE.POD_MUZZLE_PREFIRE },
        { key: 'MUZZLE_EXIT_SPINUP', duration: BD.MUZZLE_EXIT_SPINUP, fov: 40, timeScale: BEAT_TIME_SCALE.MUZZLE_EXIT_SPINUP },
        { key: 'GLAMOUR_SHOT',       duration: BD.GLAMOUR_SHOT,       fov: 50, timeScale: BEAT_TIME_SCALE.GLAMOUR_SHOT },
        // APPROACH_DOLLY: was 2.0 s, raised to 8.0 s on 2026-05-25 so that the
        // FLIGHT phase actually completes inside this beat for typical 30–80 m
        // engagements (10 m/s × scale 0.6 = 6 m/s wall, so 8 s wall ≈ 48 m of
        // flight). NET_BRAKE_FIRED force-advances out of this beat as soon as
        // contact occurs, so the long cap is just a safety upper bound — it
        // does not extend the ceremony when contact happens earlier.
        { key: 'APPROACH_DOLLY',     duration: 8.0,                   fov: 45, timeScale: BEAT_TIME_SCALE.APPROACH_DOLLY },
        { key: 'BRAKE_ENVELOP',      duration: BD.BRAKE_ENVELOP,      fov: 38, timeScale: BEAT_TIME_SCALE.BRAKE_ENVELOP },
        { key: 'CINCH',              duration: BD.CINCH,              fov: 42, timeScale: BEAT_TIME_SCALE.CINCH },
        { key: 'SECURED_SETTLE',     duration: BD.SECURED_SETTLE,     fov: 45, timeScale: BEAT_TIME_SCALE.SECURED_SETTLE },
      ];
    } else {
      // Highlights cut: only HIGHLIGHTS_CUT_BEATS at scaled wall-clock duration.
      // Per-beat physics time-scale is the SAME as the full sequence — only
      // the beat DURATION is multiplied by HIGHLIGHTS_TIME_SCALE.
      // APPROACH_DOLLY is a special case: it has no single BEAT_DURATIONS_S
      // entry (only _MIN/_MAX), and the full-sequence code uses an 8.0 s
      // safety cap that force-advances on NET_BRAKE_FIRED. The highlights
      // cut must use the same cap so the FSM has time to actually contact
      // the target inside the ceremony (the 2026-05-25 capture-flow fix).
      beats = HCB.map(key => {
        const duration = key === 'APPROACH_DOLLY'
          ? 8.0 * HTS
          : BD[key] * HTS;
        return {
          key,
          duration,
          fov: BEAT_FOV[key],
          timeScale: BEAT_TIME_SCALE[key] ?? 1.0,
        };
      });
    }

    // Resolve arm reference — should be the arm in ARM_PILOT
    const arm = this.armPilot.arm;
    if (!arm || !arm.position) return;

    // Resolve net projectile for diameter and launch direction
    const net = captureNetSystem.getActiveNetForArm(payload.armIndex);

    c.active = true;
    c.beatIndex = 0;
    c.beatTimer = 0;
    c.beats = beats;
    c.armIndex = payload.armIndex;
    c.podIndex = payload.podIndex;
    c.arm = arm;
    c.savedView = this.currentView;
    c.savedFov = this._baseFov;
    c.isFirstEver = isFirstEver;
    c.success = null;

    // Store launch direction (unit vector)
    if (net) {
      c._launchFwd.set(
        net.launchDirection.x,
        net.launchDirection.y,
        net.launchDirection.z
      ).normalize();
      c._netDiameterScene = (net.netClass?.DIAMETER || 5) * M;
    } else if (arm.target && arm.target._scenePosition) {
      c._launchFwd.copy(arm.target._scenePosition).sub(arm.position).normalize();
      c._netDiameterScene = 5 * M;
    } else {
      c._launchFwd.copy(this._lastVelDir);
      c._netDiameterScene = 5 * M;
    }

    // Side direction: cross(fwd, radialUp) — consistent "port side"
    const radialUp = c._v3e.copy(arm.position).normalize();
    c._sideDir.crossVectors(c._launchFwd, radialUp).normalize();
    if (c._sideDir.lengthSq() < 0.001) {
      c._sideDir.crossVectors(c._launchFwd, c._v3e.set(0, 1, 0)).normalize();
    }

    // Stage 4: publish first beat's physics time-scale BEFORE the next tick of
    // NetProjectile / CaptureNetVisual runs. EventBus is synchronous, so this
    // handler completes inside captureNetSystem.update() before the camera tick.
    // The very first NetProjectile sub-step that emitted NET_CEREMONY_START
    // already ran at 1.0× (one-frame lag accepted; beats are multi-frame).
    if (beats.length > 0) {
      CeremonyTimeScale.set(beats[0].timeScale ?? 1.0);
    }

    // Switch to NET_CINEMATIC mode
    this.currentView = CameraViews.NET_CINEMATIC;
    this._transitioning = false;
    this._transitionProgress = 0;
    this._fovTransitionStart = undefined;
    this._fovTransitionEnd = undefined;
  }

  /**
   * NET_BRAKE_FIRED advisory handler — snap APPROACH_DOLLY to BRAKE_ENVELOP.
   * @private
   */
  _onNetBrakeFired(payload) {
    if (!Constants.FEATURE_FLAGS.NET_CEREMONY) return;
    const c = this._netCeremony;
    if (!c.active) return;
    if (c.armIndex !== payload.armIndex) return;

    const beat = c.beats[c.beatIndex];
    if (beat && beat.key === 'APPROACH_DOLLY') {
      // Force beat advance on next update frame
      c.beatTimer = beat.duration;
    }
  }

  /**
   * NET_CEREMONY_COMPLETE handler — handle miss (truncate) or success (let play out).
   * @private
   */
  _onNetCeremonyComplete(payload) {
    if (!Constants.FEATURE_FLAGS.NET_CEREMONY) return;
    const c = this._netCeremony;
    if (!c.active) return;
    if (c.armIndex !== payload.armIndex) return;

    c.success = payload.success;

    if (payload.success === false) {
      // Miss path: truncate immediately, do NOT set first-deploy flag
      this._exitNetCeremony(false);
    }
    // Success path: let the ceremony beats play out naturally.
    // _updateNetCeremony will call _exitNetCeremony(true) when all beats finish.
  }

  /**
   * Compute a beat's camera endpoint position (design doc §5.3).
   * Writes into `out`; no allocation.
   * @private
   * @param {THREE.Vector3} out — pre-allocated output vector
   * @param {string} key — beat key or 'ARM_PILOT_START'
   */
  _netCeremonyBeatPos(out, key, armPos, netPos, debrisPos, fwd, side, localUp, D_M) {
    const M = 0.00001;
    switch (key) {
      case 'ARM_PILOT_START':
      case 'SECURED_SETTLE': {
        // ARM_PILOT standard position: behind arm toward debris, above
        const apFwd = this._netCeremony._v3e;
        if (debrisPos.distanceToSquared(armPos) > 1e-20) {
          apFwd.subVectors(debrisPos, armPos).normalize();
        } else {
          apFwd.copy(fwd);
        }
        return out.copy(armPos)
          .addScaledVector(apFwd, -this.armPilot.offsetBehind)
          .addScaledVector(localUp, this.armPilot.offsetAbove);
      }
      case 'POD_MUZZLE_PREFIRE':
        return out.copy(armPos)
          .addScaledVector(fwd, -0.6 * M)
          .addScaledVector(localUp, 0.15 * M);
      case 'MUZZLE_EXIT_SPINUP':
        return out.copy(armPos)
          .addScaledVector(localUp, 1.0 * M)
          .addScaledVector(side, 2.5 * M);
      case 'GLAMOUR_SHOT':
        // Stage 3 retune 2026-05-24: 0.8 → 1.5 (D fractions; mouthR=0.5D so
        // distance/radius = 1.5/0.5 = 3.0× — hero-shot silhouette breathing room).
        return out.copy(netPos)
          .addScaledVector(fwd, -1.5 * D_M);
      case 'APPROACH_DOLLY':
        // Stage 3 retune 2026-05-24: 0.5 → 1.25 (ratio 2.5× — outside cone wall).
        return out.copy(netPos)
          .addScaledVector(side, 1.25 * D_M);
      case 'BRAKE_ENVELOP':
        // 2026-05-25 Stage 3 fix (CONTINUOUS netPos-tracking + apex-plane-breakout):
        // (1) NO cached `_beat5WorldPos` — see CINCH-class regression test 11 in
        //     test-NetCinematic.js. The orbital frame translates >100 km/s; any
        //     stale absolute anchor goes catastrophically out of frame in <1 s.
        // (2) Camera MUST have a non-zero `fwd` component. Previously the offset
        //     was `side × 1.25 × D_M` only — putting the camera in the apex plane
        //     (perpendicular to launchDir). The ENVELOP animation translates the
        //     8 rim weights along the cone axis from z=−coneH (mouth plane) to
        //     z=0 (apex plane). With camera in the apex plane the weight start
        //     position is at atan(coneH/sideOffset)=atan(0.55D/1.25D)=23.7° off
        //     the camera→apex axis — OUTSIDE the half-FOV-V of 19° at beat-5
        //     FOV=38°. User saw weights "pop in" only at the end of the sweep
        //     (= same experience as before any of these fixes).
        //     New offset: (side 1.5, fwd 0.6, up 0.5) × D_M places the camera
        //     in a 3/4 elevated side view. Distance/mouthR = √(2.25+0.36+0.25)/0.5
        //     = 3.38× (still well outside cone surface). The fwd component
        //     pushes the camera off the apex plane so the weight sweep is
        //     observed obliquely (parallax visible).
        return out.copy(netPos)
          .addScaledVector(side, 1.5 * D_M)
          .addScaledVector(fwd, 0.6 * D_M)
          .addScaledVector(localUp, 0.5 * D_M);
      case 'CINCH':
        // 2026-05-25 Stage 3 fix (apex-plane-breakout, front-view framing):
        // Previous offset was (side 1.5, up −0.3) × D_M — again perpendicular
        // to launchDir, so the camera sat in the apex plane (same plane the
        // CINCH_CLOSING weights spin in). The weight ring was seen EDGE-ON
        // — a contracting horizontal line, not a closing drawstring spiral.
        // New offset uses fwd × 2.0 × D_M (camera AHEAD of mouth, looking back
        // through the bag's open mouth at the apex plane) plus a small side
        // component for parallax. The apex plane is now perpendicular to the
        // camera's view direction → weights' spiral inward is rendered as a
        // shrinking 2-D circle dead-centre in the frame. Distance/mouthR ratio:
        // √(0.4² + 2.0² + 0.4²)/0.5 = √4.32/0.5 = 4.16× (well outside cone).
        return out.copy(netPos)
          .addScaledVector(side, 0.4 * D_M)
          .addScaledVector(fwd, 2.0 * D_M)
          .addScaledVector(localUp, 0.4 * D_M);
      default:
        return out.copy(armPos);
    }
  }

  /**
   * Compute a beat's lookAt target. Writes into `out`; no allocation.
   * @private
   */
  _netCeremonyBeatLook(out, key, armPos, netPos, debrisPos, fwd, D_M) {
    switch (key) {
      case 'ARM_PILOT_START':
      case 'SECURED_SETTLE':
      case 'GLAMOUR_SHOT':
        return out.copy(debrisPos);
      case 'POD_MUZZLE_PREFIRE':
        return out.copy(armPos);
      case 'MUZZLE_EXIT_SPINUP':
        return out.copy(netPos);
      case 'BRAKE_ENVELOP':
        // 2026-05-25 — look at cone midpoint (apex + fwd × coneH/2), not the
        // apex itself. The ENVELOP animation occupies the full cone length
        // (weights translate from mouth-plane to apex-plane). Centering on the
        // apex pushes the FROM-end of the weight sweep (mouth plane) outside
        // the FOV; centering on the midpoint balances both ends in frame.
        // coneH = D × CONE_LENGTH_FRAC × CONE_OPEN_RADIUS_FRAC.
        // 2026-05-28 (Item 1): CONE_LENGTH_FRAC bumped 0.55 → 0.85 so the
        // cinch closes past the debris's leading edge (gap = 0.35 × D
        // instead of 0.05 × D).  Midpoint moves 0.275 × D → 0.425 × D.
        return out.copy(netPos).addScaledVector(fwd, 0.425 * (D_M ?? 0));
      case 'CINCH':
        // 2026-05-26 GEOMETRY FIX: CINCH ring contracts at the MOUTH plane
        // (local z=-coneHeight).  2026-05-28 (Item 1): CONE_LENGTH_FRAC was
        // 0.55, so coneH was 0.55 × D and the mouth/ring sat 0.4 m past the
        // target — the user perceived the ring cinching THROUGH the
        // debris's middle.  Bumped to 0.85 so coneH = 0.85 × D and the
        // ring sits 0.35 × D past the target (2.8 m for LARGE D=8) —
        // safely past the leading edge of the debris.  This look-at value
        // = CONE_LENGTH_FRAC × CONE_OPEN_RADIUS_FRAC × D_M and MUST stay
        // in sync with Constants.CAPTURE_NET.NET_CEREMONY.CONE_LENGTH_FRAC.
        return out.copy(netPos).addScaledVector(fwd, 0.85 * (D_M ?? 0));
      case 'APPROACH_DOLLY':
        // Midpoint of net and debris
        return out.copy(netPos).add(debrisPos).multiplyScalar(0.5);
      default:
        return out.copy(armPos);
    }
  }

  /**
   * Compute net scene position into c._scratchNetPos. No allocation.
   * @private
   */
  _computeNetScenePos(c) {
    const M = 0.00001;
    const net = captureNetSystem.getActiveNetForArm(c.armIndex);
    if (net && net._sourceArm?.position) {
      const ap = net._sourceArm.position;
      c._scratchNetPos.set(
        ap.x + net.launchDirection.x * net.distanceTraveled * M,
        ap.y + net.launchDirection.y * net.distanceTraveled * M,
        ap.z + net.launchDirection.z * net.distanceTraveled * M
      );
    } else if (c.arm?.position) {
      c._scratchNetPos.copy(c.arm.position);
    } else {
      c._scratchNetPos.set(0, 0, 0);
    }
  }

  /**
   * Per-frame net ceremony beat update. Returns { pos, look, up } or null.
   * All returned vectors are pre-allocated ceremony scratch — caller must
   * copy them immediately (same pattern as _updateLaunchCeremony).
   * @private
   */
  _updateNetCeremony(dt, playerPos, velDir, radialDir, playerQuat) {
    const c = this._netCeremony;

    c.beatTimer += dt;
    let beat = c.beats[c.beatIndex];

    // Beat advance
    if (c.beatTimer >= beat.duration) {
      c.beatTimer -= beat.duration;
      c.beatIndex++;
      if (c.beatIndex >= c.beats.length) {
        this._exitNetCeremony(true);
        return null;
      }
      beat = c.beats[c.beatIndex];
      // Stage 4: publish new beat's physics time-scale (CEREMONY_REDESIGN.md §5.1)
      CeremonyTimeScale.set(beat.timeScale ?? 1.0);
    }

    const t = c.beatTimer / beat.duration;
    const ease = t * t * (3 - 2 * t); // smoothstep

    const arm = c.arm;
    if (!arm || !arm.position) {
      this._exitNetCeremony(false);
      return null;
    }

    const armPos = arm.position;
    this._computeNetScenePos(c);
    const netPos = c._scratchNetPos;
    const fwd = c._launchFwd;
    const side = c._sideDir;
    const D_M = c._netDiameterScene;

    // Debris scene position (into c._v3d)
    const debrisPos = c._v3d;
    if (arm.target?._scenePosition) {
      debrisPos.copy(arm.target._scenePosition);
    } else if (arm._stationKeepTarget?._scenePosition) {
      debrisPos.copy(arm._stationKeepTarget._scenePosition);
    } else {
      debrisPos.copy(armPos).addScaledVector(fwd, 0.0005);
    }

    // Local up (radial at arm, orthogonalized against fwd)
    const localUp = c._v3c;
    localUp.copy(armPos).normalize();
    const upDot = localUp.dot(fwd);
    if (Math.abs(upDot) < 0.999) {
      localUp.addScaledVector(fwd, -upDot).normalize();
    }


    // ── Compute FROM (previous beat endpoint) and TO (current beat endpoint) ──
    const prevKey = c.beatIndex > 0 ? c.beats[c.beatIndex - 1].key : 'ARM_PILOT_START';
    this._netCeremonyBeatPos(this._tmpVecA, prevKey, armPos, netPos, debrisPos, fwd, side, localUp, D_M);
    this._netCeremonyBeatPos(this._tmpVecB, beat.key, armPos, netPos, debrisPos, fwd, side, localUp, D_M);

    // Output position (lerpVectors reads A,B then writes into _v3a — safe)
    const pos = c._v3a;
    pos.lerpVectors(this._tmpVecA, this._tmpVecB, ease);

    // ── Compute FROM/TO lookAt targets ──
    this._netCeremonyBeatLook(this._tmpVecA, prevKey, armPos, netPos, debrisPos, fwd, D_M);
    this._netCeremonyBeatLook(this._tmpVecB, beat.key, armPos, netPos, debrisPos, fwd, D_M);

    // Output lookAt
    const look = c._v3b;
    look.lerpVectors(this._tmpVecA, this._tmpVecB, ease);

    // FOV lerp between previous beat's target and current beat's target
    const prevFov = c.beatIndex > 0 ? c.beats[c.beatIndex - 1].fov : c.savedFov;
    this._baseFov = prevFov + (beat.fov - prevFov) * ease;
    this.camera.fov = this._baseFov;
    this.camera.near = 0.000001; // ~0.1m (tight framing)
    this.camera.updateProjectionMatrix();

    // Up vector (localUp already computed into c._v3c)
    return { pos, look, up: localUp };
  }

  /**
   * Q2 Stage 6 — abort an active net ceremony WITHOUT routing through
   * setView(prevView). Used by setView() when an external view change is
   * requested mid-ceremony; the new view is set by setView's normal flow,
   * so this helper only undoes ceremony side-effects (FOV, state, time-scale).
   * FIRST_NET_DEPLOY is intentionally NOT written — abort ≠ normal completion.
   * @private
   */
  _abortNetCeremony() {
    const c = this._netCeremony;
    if (!c.active) return;

    // Restore FOV
    this._baseFov = c.savedFov;
    this.camera.fov = c.savedFov;
    this.camera.near = Constants.CAMERA_NEAR;
    this.camera.updateProjectionMatrix();

    // Clear ceremony state
    c.active = false;
    c.beatIndex = 0;
    c.beatTimer = 0;
    c.beats = [];
    c.arm = null;
    c.success = null;

    // Stage 4: clear ceremony time-scale (world dt back to 1.0× — §6 R1)
    CeremonyTimeScale.reset();
  }

  /**
   * Exit net ceremony — restore previous view and FOV.
   * @private
   * @param {boolean} completedNormally — true if all beats played, false on truncation/miss
   */
  _exitNetCeremony(completedNormally) {
    const c = this._netCeremony;
    if (!c.active) return;

    // Set first-deploy flag at end of first-ever SUCCESSFUL ceremony
    if (completedNormally && c.isFirstEver && c.success !== false) {
      persistenceManager.setCeremonyFlag('FIRST_NET_DEPLOY', true);
    }

    // Restore FOV
    this._baseFov = c.savedFov;
    this.camera.fov = c.savedFov;
    this.camera.near = Constants.CAMERA_NEAR;
    this.camera.updateProjectionMatrix();

    // Restore previous view
    const prevView = c.savedView || CameraViews.ARM_PILOT;

    c.active = false;
    c.beatIndex = 0;
    c.beatTimer = 0;
    c.beats = [];
    c.arm = null;
    c.success = null;

    // Stage 4: clear ceremony time-scale (world dt back to 1.0× — §6 R1)
    CeremonyTimeScale.reset();

    this.setView(prevView);
  }

  // ==========================================================================
  // INSPECTION CAMERA (S2.1)
  // ==========================================================================

  /**
   * Enter INSPECTION mode — narrow FOV, close-range orbit around the spacecraft,
   * plus a contextual wireframe overlay (mother / debris / daughter).
   *
   * This is the single entry point for the discrete inspection view: it emits
   * INSPECTION_TOGGLE exactly once so the wireframe panels show, then transitions
   * optics. Reached via the legacy bare-I / toggleInspection() path (the V cycle
   * no longer routes here — close inspection engages as a LOOK AROUND zoom
   * sub-state instead).
   *
   * @param {('mother'|'debris'|'daughter')} [subject='mother'] overlay to focus.
   * @param {number|null} [targetId=null] debris id (for the 'debris' subject).
   */
  enterInspection(subject = 'mother', targetId = null) {
    if (this.currentView === CameraViews.INSPECTION) return;

    // Copy orbit angles for continuity (if coming from ORBIT)
    if (this.currentView === CameraViews.ORBIT) {
      this.inspection.theta = this.orbit.theta;
      this.inspection.phi = this.orbit.phi;
      this.inspection.distance = Math.min(this.orbit.distance, this.inspection.maxDistance);
    }

    // Save current FOV for restore
    this.inspection.savedFov = this._baseFov;
    this._fovBreathOffset = 0;
    this._fovBreathTarget = 0;
    this._fovBreathTimer = 0;

    // Smooth FOV transition to narrow inspection FOV
    this._fovTransitionStart = this._baseFov;
    this._fovTransitionEnd = this.inspection.fov;

    // Remember the focused subject so exit can toggle the same overlay off.
    this._inspectSubject = subject;

    this.setView(CameraViews.INSPECTION);

    // Show the contextual overlay (mother/debris/daughter wireframe panels).
    eventBus.emit(Events.INSPECTION_TOGGLE, { subject, targetId });

    console.log(`[CameraSystem] Inspection mode (${subject}). Zoom 2–50m, FOV 35°`);
  }

  /**
   * Exit INSPECTION mode — restore FOV/near-plane, hide the overlay, and return
   * to the requested view (defaults to the view active before inspection).
   * @param {string} [returnTo] a CameraViews value; falls back to _previousView
   *   then CHASE. cycleView() passes CHASE so V from inspection wraps to FLY.
   */
  exitInspection(returnTo) {
    if (this.currentView !== CameraViews.INSPECTION) return;

    // Copy inspection angles back to orbit for continuity
    this.orbit.theta = this.inspection.theta;
    this.orbit.phi = this.inspection.phi;

    // Restore FOV
    this._fovTransitionStart = this._baseFov;
    this._fovTransitionEnd = this.inspection.savedFov || Constants.CAMERA_FOV;

    // Restore near-plane to default
    this.camera.near = Constants.CAMERA_NEAR;
    this.camera.updateProjectionMatrix();

    // Hide the contextual overlay by re-toggling the same subject.
    eventBus.emit(Events.INSPECTION_TOGGLE, { subject: this._inspectSubject || 'mother' });
    this._inspectSubject = null;

    // Default return view. Bare-I / ESC fall back to the prior view (usually
    // FLY); cycleView() passes CHASE explicitly so V wraps back to FLY.
    const dest = returnTo || this._previousView || CameraViews.CHASE;
    this.setView(dest);
  }

  // ==========================================================================
  // ST-5.3: VLEO CINEMATIC INTRO
  // ==========================================================================

  /**
   * Start VLEO cinematic intro — wider chase-cam establishing shot.
   * Call on first ORBITAL_VIEW entry (new game, no save).
   */
  startVLEOIntro() {
    this._vleoIntroScale = Constants.EARTH.VLEO_INTRO_CAMERA_SCALE;
    this._vleoIntroHolding = true;
  }

  /**
   * End VLEO intro hold — chase offset smoothly decays back to 1.0.
   */
  endVLEOIntro() {
    this._vleoIntroHolding = false;
    // _vleoIntroScale decays in update() via VLEO_INTRO_EASE_RATE
  }

  /**
   * Compute ARM_PILOT camera — follows arm, looking toward target.
   * @private
   */
  _computeArmPilot(dt, playerPos, velDir, radialDir) {
    const arm = this.armPilot.arm;
    if (!arm || !arm.position) {
      return this._computeChase(dt, playerPos, velDir, radialDir);
    }

    const armPos = arm.position.clone();

    // STATION_KEEP: inspection-mode framing.
    //
    // Goal: camera stays in its standard ARM_PILOT position (5 m behind +
    // 1.6 m above the daughter) and looks AT the debris.  The daughter moves
    // around the debris on a θ/φ/R sphere using arrow keys — because the
    // camera is rigidly attached behind the daughter, sweeping the daughter
    // around the sphere automatically sweeps the camera too, exposing the
    // debris from every angle.  Player view layout:
    //     [camera] → [daughter (foreground)] → [debris (centered)]
    // The tether trails back past the camera toward the mothership.
    //
    // KEY DIFFERENCE from non-SK branch: that branch sets look = arm + fwd ×
    // 100 m (a phantom point past the daughter) which causes the debris to
    // drift through the frame as daughter advances toward/past it.  Here the
    // look-target is the LIVE debris position, so debris is locked in screen
    // space and the daughter's circumnavigation is what causes the visible
    // change in viewing angle.
    //
    // Use _scenePosition (authoritative orbit-propagated position), not
    // mesh.position (may be floating-origin-adjusted InstancedMesh container).
    if (arm.state === Constants.ARM_STATES.STATION_KEEP && arm._stationKeepTarget) {
      const debrisScenePos = (arm._stationKeepTarget._scenePosition || arm._stationKeepTarget.mesh?.position)?.clone();
      if (!debrisScenePos) return this._computeChase(dt, playerPos, velDir, radialDir);

      // Forward direction = (daughter → debris) so camera goes BEHIND daughter
      // (away from debris) and looks toward debris.
      const armToDebris = debrisScenePos.clone().sub(armPos);
      if (armToDebris.lengthSq() < 1e-20) {
        // Degenerate (daughter and debris co-located) — fall back to chase view
        return this._computeChase(dt, playerPos, velDir, radialDir);
      }
      armToDebris.normalize();

      // ── UP VECTOR: FROZEN at SK entry to prevent screen-roll-during-sweep ──
      //
      // History: previous attempts used (a) Earth-radial at the daughter's
      // position `armPos.normalize()` — wobbled at orbit-sphere φ-poles — and
      // (b) the daughter's local +Y from `arm.group.quaternion` — but that
      // quaternion changes EVERY frame as daughter slerps to face the new
      // sweep direction, so the camera up-vector rotated continuously during
      // arrow-key sweeps, rolling the screen and creating the illusion of the
      // debris "moving" even though it remained at NDC (0,0).  (Verified by
      // forensic NDC log showing |Δ| = 0 px while user perceived translation.)
      //
      // FIX: Capture Earth-radial at the DEBRIS position when SK is first
      // entered and reuse the same vector every frame.  Earth-radial-at-debris
      // is a sensible "up" (away from Earth's centre, agreeing with orbital
      // intuition) AND it doesn't depend on either daughter's quaternion or
      // armToDebris, so it doesn't change during sweep — the screen no longer
      // rolls.  Cleared when arm exits STATION_KEEP.
      if (!this.armPilot._skLockedUp) {
        // Earth's centre is world origin → Earth-radial at debris = debris
        // direction unit-vector.
        this.armPilot._skLockedUp = debrisScenePos.clone().normalize();
      }
      // Orthogonalise the locked vector against current armToDebris so the
      // 1.6 m offset goes purely in screen-up.  At the orbit-sphere poles the
      // locked vector becomes nearly parallel to armToDebris — fall back to
      // un-orthogonalised so we never produce a zero up.
      const lockedUp = this.armPilot._skLockedUp;
      const upDot = lockedUp.dot(armToDebris);
      const localUp = Math.abs(upDot) > 0.999
        ? lockedUp.clone()
        : lockedUp.clone().sub(armToDebris.clone().multiplyScalar(upDot)).normalize();

      // Camera position: 5 m behind daughter (away from debris), 1.6 m above
      // along the daughter's local up.  Same offsets as the rest of ARM_PILOT.
      const pos = armPos.clone()
        .sub(armToDebris.clone().multiplyScalar(this.armPilot.offsetBehind))
        .add(localUp.clone().multiplyScalar(this.armPilot.offsetAbove));

      // CRITICAL: look-target uses LIVE debris position every frame, NO LERP.
      // A 0.5s-time-constant lerp on _skLookTarget that previously lived here
      // was producing a steady-state lag of v·dt·(1-rate)/rate ≈ 127 m × 0.968
      // / 0.032 ≈ 3.8 km along the orbit-trailing direction (debris
      // _scenePosition advances ~127 m/frame at LEO orbital velocity, lerp
      // rate ≈ 0.032/frame).  The camera appeared to slide off the debris
      // over time.  Initial smooth-entry is handled by _lookBlendTime in
      // _setupArmPilotEntry, not by a lookAt lerp.
      this.armPilot._skLookTarget = debrisScenePos;  // bookkeeping only

      // Pass the frozen-up vector out so update() uses it for camera.up.
      return { pos, look: debrisScenePos.clone(), up: localUp.clone() };
    }

    // Reset SK state when not in STATION_KEEP. Clears both:
    //   _skLookTarget — bookkeeping for the live look target
    //   _skLockedUp   — the up vector frozen at SK entry (so a fresh capture
    //                   happens next time SK is re-entered, possibly on a
    //                   different debris with different Earth-radial).
    if (this.armPilot._skLookTarget) {
      this.armPilot._skLookTarget = null;
    }
    if (this.armPilot._skLockedUp) {
      this.armPilot._skLockedUp = null;
    }

    // Camera behind and above the arm.
    // forwardDir is the direction the camera looks: toward the target debris if
    // available (so the player sees the debris directly during APPROACH), else
    // arm velocity, else parent velocity.
    let forwardDir;
    let lookTarget = null;       // explicit lookAt target when we have a debris target
    if (arm.target && arm.target._scenePosition) {
      forwardDir = arm.target._scenePosition.clone().sub(armPos);
      if (forwardDir.lengthSq() > 1e-12) {
        forwardDir.normalize();
        lookTarget = arm.target._scenePosition.clone();
      } else {
        // POLISH FIX (post-capture): in GRAPPLED state _updateGrappled snaps
        // arm.position onto target._scenePosition, so (target - armPos) is the
        // zero vector. normalize() leaves it zero, then lookAt(target=armPos)
        // with camera.up=radial-at-arm produces antiparallel view/up vectors →
        // gimbal-locked rotation matrix → screen rotates/jitters wildly.
        // Fall back to a sane forward direction and suppress lookTarget so the
        // phantom-point branch below renders a stable view.
        if (arm.velocity && arm.velocity.lengthSq() > 1e-16) {
          forwardDir = arm.velocity.clone().normalize();
        } else if (this.armPilot._prevForward &&
                   this.armPilot._prevForward.lengthSq() > 1e-12) {
          forwardDir = this.armPilot._prevForward.clone().normalize();
        } else {
          forwardDir = velDir.clone();
        }
        // lookTarget stays null → phantom-point look (armPos + fwd × 100m).
      }
    } else if (arm.velocity.lengthSq() > 1e-16) {
      forwardDir = arm.velocity.clone().normalize();
    } else {
      forwardDir = velDir.clone();
    }

    // Smooth look-direction blend when first entering ARM PILOT.
    // Prevents disorienting snap by easing from pre-switch camera forward
    // to the arm's desired forward over _lookBlendDuration seconds.
    if (this.armPilot._lookBlendTime !== undefined &&
        this.armPilot._lookBlendTime < this.armPilot._lookBlendDuration) {
      this.armPilot._lookBlendTime += dt;
      const t = Math.min(1, this.armPilot._lookBlendTime / this.armPilot._lookBlendDuration);
      const eased = t * t * (3 - 2 * t); // smoothstep

      forwardDir = new THREE.Vector3().lerpVectors(
        this.armPilot._prevForward,
        forwardDir,
        eased
      ).normalize();
    }

    // Radial up at arm position — orthogonalized to forwardDir so the
    // "behind" and "above" offset components are always perpendicular.
    // Without this, when forwardDir has a radial component (target at
    // different altitude), the offsets partially cancel and the camera
    // drifts steadily closer to the daughter.
    const rawUp = armPos.clone().normalize();
    const upDot = rawUp.dot(forwardDir);
    const localUp = rawUp.clone().sub(forwardDir.clone().multiplyScalar(upDot)).normalize();

    // Position camera behind the arm (constant distance = √(behind² + above²))
    const pos = armPos.clone()
      .sub(forwardDir.clone().multiplyScalar(this.armPilot.offsetBehind))
      .add(localUp.clone().multiplyScalar(this.armPilot.offsetAbove));

    // Look at the actual debris position when a target exists, so the debris
    // stays locked in screen space as the daughter circles or approaches it.
    // The previous behaviour (look = armPos + forwardDir × 100m) caused the
    // debris to appear to slide through frame because the look target was a
    // phantom point past the daughter rather than the debris itself — once
    // the daughter passed the debris (APPROACH overshoot), the look target
    // moved past it too, so the camera framed empty space.
    // No-target fallback: keep the original "100 m ahead of arm" behavior.
    const look = lookTarget !== null
      ? lookTarget
      : armPos.clone().add(forwardDir.clone().multiplyScalar(0.001));

    return { pos, look };
  }

  // ==========================================================================
  // MOUSE INPUT
  // ==========================================================================

  /** @private */
  _attachMouseListeners() {
    this.canvas.addEventListener('mousedown', this._boundMouseDown);
    this.canvas.addEventListener('mousemove', this._boundMouseMove);
    this.canvas.addEventListener('mouseup', this._boundMouseUp);
    this.canvas.addEventListener('wheel', this._boundWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this._boundContextMenu);
  }

  /** @private */
  _onMouseDown(e) {
    if (this.currentView === CameraViews.ORBIT || this.currentView === CameraViews.INSPECTION) {
      const cfg = this.currentView === CameraViews.INSPECTION ? this.inspection : this.orbit;
      // Left or right click starts orbit/inspection drag
      if (e.button === 0 || e.button === 2) {
        cfg.isDragging = true;
        cfg.lastMouseX = e.clientX;
        cfg.lastMouseY = e.clientY;
        cfg.velocityTheta = 0;
        cfg.velocityPhi = 0;
      }
    } else if (this.currentView === CameraViews.FIRST_PERSON) {
      // Right click starts free-look
      if (e.button === 2) {
        this.firstPerson.freeLookActive = true;
        this.orbit.lastMouseX = e.clientX;
        this.orbit.lastMouseY = e.clientY;
      }
    }
  }

  /** @private */
  _onMouseMove(e) {
    if ((this.currentView === CameraViews.ORBIT || this.currentView === CameraViews.INSPECTION) &&
        (this.currentView === CameraViews.INSPECTION ? this.inspection.isDragging : this.orbit.isDragging)) {
      const cfg = this.currentView === CameraViews.INSPECTION ? this.inspection : this.orbit;
      const dx = e.clientX - cfg.lastMouseX;
      const dy = e.clientY - cfg.lastMouseY;
      cfg.lastMouseX = e.clientX;
      cfg.lastMouseY = e.clientY;

      cfg.velocityTheta = -dx * cfg.rotateSpeed;
      cfg.velocityPhi = dy * cfg.rotateSpeed;

      // Skills discovery: orbit drag event
      eventBus.emit(Events.CAMERA_ORBIT_DRAG);
    } else if (this.currentView === CameraViews.FIRST_PERSON && this.firstPerson.freeLookActive) {
      const dx = e.clientX - this.orbit.lastMouseX;
      const dy = e.clientY - this.orbit.lastMouseY;
      this.orbit.lastMouseX = e.clientX;
      this.orbit.lastMouseY = e.clientY;

      this.firstPerson.freeLookYaw += dx * 0.3;
      this.firstPerson.freeLookPitch += dy * 0.3;
      // Clamp free-look
      this.firstPerson.freeLookYaw = Math.max(-90, Math.min(90, this.firstPerson.freeLookYaw));
      this.firstPerson.freeLookPitch = Math.max(-45, Math.min(45, this.firstPerson.freeLookPitch));

      // Skills discovery: free-look event
      eventBus.emit(Events.CAMERA_FREE_LOOK);
    }
  }

  /** @private */
  _onMouseUp(e) {
    if (this.currentView === CameraViews.ORBIT) {
      this.orbit.isDragging = false;
    }
    if (this.currentView === CameraViews.INSPECTION) {
      this.inspection.isDragging = false;
    }
    if (this.currentView === CameraViews.FIRST_PERSON && e.button === 2) {
      this.firstPerson.freeLookActive = false;
      // Smoothly return to center
      this.firstPerson.freeLookYaw *= 0.3;
      this.firstPerson.freeLookPitch *= 0.3;
    }
  }

  /** @private */
  _onWheel(e) {
    e.preventDefault();

    // Skills discovery: emit zoom event for any view
    eventBus.emit(Events.CAMERA_ZOOM);

    if (this.currentView === CameraViews.ORBIT) {
      // Zoom in/out. Use finer 3% steps once inside the inspection band so
      // close mechanical framing is controllable; 5% otherwise.
      const fine = this.orbit.distance < this.orbit.inspectExitDist;
      const step = fine ? 0.03 : 0.05;
      const zoomDelta = e.deltaY > 0 ? (1 + step) : (1 - step);
      this.orbit.distance *= zoomDelta;
      this.orbit.distance = Math.max(
        this.orbit.minDistance,
        Math.min(this.orbit.maxDistance, this.orbit.distance)
      );
      // Cross the Schmitt trigger → engage/disengage inspection optics+overlay.
      this._evaluateInspectZoom();
    } else if (this.currentView === CameraViews.INSPECTION) {
      // Inspection zoom (smooth 3% steps for fine control)
      const zoomDelta = e.deltaY > 0 ? 1.03 : 0.97;
      this.inspection.distance *= zoomDelta;
      this.inspection.distance = Math.max(
        this.inspection.minDistance,
        Math.min(this.inspection.maxDistance, this.inspection.distance)
      );
    } else if (this.currentView === CameraViews.CHASE) {
      // Adjust chase distance (smooth 5% steps, min ~10m behind)
      const zoomDelta = e.deltaY > 0 ? 1.05 : 0.95;
      this.chase.offsetBehind *= zoomDelta;
      this.chase.offsetBehind = Math.max(0.0001, Math.min(0.001, this.chase.offsetBehind));
      this.chase.offsetAbove = this.chase.offsetBehind * 0.48;
    } else if (this.currentView === CameraViews.TARGET_LOCK) {
      // Unreachable as of 2026-06-03 (TARGET_LOCK removed from VIEW_CYCLE);
      // retained for possible re-enable. See _computeTargetLock.
      // Adjust target lock offset distance
      const zoomDelta = e.deltaY > 0 ? 1.1 : 0.9;
      this.targetLock.offsetDistance *= zoomDelta;
      this.targetLock.offsetDistance = Math.max(0.0001, Math.min(0.005, this.targetLock.offsetDistance));
    } else if (this.currentView === CameraViews.FIRST_PERSON) {
      // Adjust FOV slightly for zoom effect (update _baseFov so FOV breathe offset stacks correctly)
      this._baseFov += e.deltaY > 0 ? 2 : -2;
      this._baseFov = Math.max(30, Math.min(90, this._baseFov));
      this.camera.fov = this._baseFov + this._fovBreathOffset;
      this.camera.updateProjectionMatrix();
    }
  }

  // ==========================================================================
  // VIEW INDICATOR HUD
  // ==========================================================================

  /** @private Create the view mode indicator overlay element */
  _createViewIndicator() {
    const overlay = document.getElementById('hud-overlay');
    if (!overlay) return;

    this._viewIndicator = document.createElement('div');
    this._viewIndicator.id = 'camera-view-indicator';
    // Delegation 4 (2026-05-31) — Browser-playtest: moved from top:60
    // (blocked info near comms panel header) down to top:140.
    this._viewIndicator.style.cssText = `
      position: absolute; top: 140px; left: 50%; transform: translateX(-50%);
      font-family: 'Courier New', monospace; font-size: 0.85rem;
      color: #00ff88; letter-spacing: 0.1em;
      background: rgba(0, 20, 40, 0.7); border: 1px solid rgba(0,255,136,0.3);
      padding: 6px 16px; border-radius: 4px;
      pointer-events: none; opacity: 0; transition: opacity 0.3s;
      text-shadow: 0 0 8px rgba(0,255,136,0.4);
      z-index: 30;
    `;
    overlay.appendChild(this._viewIndicator);
  }

  /**
   * @private Create the INSPECT-view vignette overlay.
   * A radial gradient (clear center → dark edges) that dims the surroundings so
   * the inspected craft reads clearly. Pure DOM (no 3D/material/lighting risk),
   * pointer-events:none, fades in only while the INSPECT view is active.
   */
  _createInspectionVignette() {
    const overlay = document.getElementById('hud-overlay');
    if (!overlay) return;
    const dim = Constants.INSPECTION?.DIM ?? 0.6;
    this._inspectionVignette = document.createElement('div');
    this._inspectionVignette.id = 'inspection-vignette';
    this._inspectionVignette.style.cssText = `
      position: absolute; inset: 0;
      pointer-events: none;
      opacity: 0; transition: opacity 0.3s ease;
      z-index: 1;
      background: radial-gradient(ellipse at center,
        rgba(0,8,16,0) 42%, rgba(0,8,16,${dim}) 100%);
    `;
    overlay.appendChild(this._inspectionVignette);
  }

  /** @private Fade the inspection vignette in (INSPECT) or out (any other view). */
  _updateInspectionVignette(view) {
    if (!this._inspectionVignette) return;
    const on = (view === CameraViews.INSPECTION) && (Constants.INSPECTION?.DIM ?? 0.6) > 0;
    this._inspectionVignette.style.opacity = on ? '1' : '0';
  }

  /** @private Show the view indicator with a label */
  _showViewIndicator(view) {
    if (!this._viewIndicator) return;

    // The default FLY view fades after 2.5s (unobtrusive). Any other view keeps
    // the badge on screen with a "[V] to fly" return hint so the player can't
    // get stuck in LOOK AROUND (or the legacy INSPECTION view) unknowingly.
    const isDefault = view === CameraViews.CHASE;

    if (view === CameraViews.ARM_PILOT) {
      this._viewIndicator.textContent = `${VIEW_LABELS[view]}  [1-4]`;
    } else if (isDefault) {
      this._viewIndicator.textContent = `${VIEW_LABELS[view]}  [V]`;
    } else {
      this._viewIndicator.textContent = `${VIEW_LABELS[view]} · [V] to fly`;
    }

    this._viewIndicator.style.opacity = '1';

    if (isDefault) {
      this._viewIndicatorPersistent = false;
      this._viewIndicatorTimer = 2.5; // fade out after 2.5 seconds
    } else {
      this._viewIndicatorPersistent = true; // stays until we return to FLY
      this._viewIndicatorTimer = 0;
    }
  }

  /** @private Fade out the view indicator */
  _hideViewIndicator() {
    if (!this._viewIndicator) return;
    this._viewIndicator.style.opacity = '0';
  }

  // ==========================================================================
  // CLEANUP
  // ==========================================================================

  /**
   * Remove event listeners (call on destroy).
   */
  dispose() {
    this.canvas.removeEventListener('mousedown', this._boundMouseDown);
    this.canvas.removeEventListener('mousemove', this._boundMouseMove);
    this.canvas.removeEventListener('mouseup', this._boundMouseUp);
    this.canvas.removeEventListener('wheel', this._boundWheel);
    this.canvas.removeEventListener('contextmenu', this._boundContextMenu);

    if (this._viewIndicator && this._viewIndicator.parentNode) {
      this._viewIndicator.parentNode.removeChild(this._viewIndicator);
    }

    if (this._inspectionVignette && this._inspectionVignette.parentNode) {
      this._inspectionVignette.parentNode.removeChild(this._inspectionVignette);
    }

    // Remove fill light from scene
    if (this._fillLight && this._scene) {
      this._scene.remove(this._fillLight);
      this._fillLight = null;
    }
  }

  /**
   * Whether this camera system should suppress OrbitControls.
   * @returns {boolean} true if orbit controls should be disabled
   */
  isActive() {
    return true; // CameraSystem always manages the camera when active
  }
}

export default CameraSystem;
