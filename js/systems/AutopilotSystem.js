/**
 * AutopilotSystem.js — Trailing-rendezvous autopilot for the mothership.
 *
 * Four-phase state machine:
 *   RENDEZVOUS_FAR → MATCH_ORBIT → TRAIL_ALIGN → HOLD
 * The goal pose is P_m* = P_d − v̂_d · D_trail, V_m* = V_d, nose* = v̂_d.
 * Commands are issued as world-frame Cartesian ΔV via
 * [`PlayerSatellite.applyCartesianImpulse`](js/entities/PlayerSatellite.js:2125),
 * keeping orbit updates physically consistent. Manual `thrustIon()` feel is
 * untouched.
 *
 * See AUTOPILOT_ANALYSIS.md §C & §D for the full design rationale.
 * @module systems/AutopilotSystem
 */

import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { orbitToSceneCartesian, orbitToSceneCartesianInto } from '../entities/OrbitalMechanics.js';
import { findNearestLiveDebris } from './NavRecoveryAdvisor.js';
import { strutLocalDirection } from '../entities/ArmDockBasis.js';

/** 1 metre in scene units (1 scene unit = 100 km) */
const M = 0.00001;

/** Minimum ΔV (m/s) required to engage autopilot */
const ENGAGE_DV_MIN = 50;

/** ΔV (m/s) threshold for automatic disengage */
const DISENGAGE_DV_MIN = 30;

/** Autopilot rotation rate (rad/s) — gentler than manual (0.3) */
const AP_ROT_RATE = 0.2;

/** Dead zone (radians) — ignore tiny corrections to prevent jitter */
const AP_ROT_DEADZONE = 0.01;

/** How often to re-scan for nearest large debris (seconds) */
const DEBRIS_SCAN_INTERVAL = 2.0;

/** Minimum mass (kg) to qualify as "large debris" */
const LARGE_DEBRIS_MASS = 50;

/**
 * Phase labels for the rendezvous state machine.
 * Public API: [`AutopilotSystem.getCurrentPhase()`](js/systems/AutopilotSystem.js:1).
 */
const PHASE = Object.freeze({
  OFF:             'OFF',
  RENDEZVOUS_FAR:  'RENDEZVOUS_FAR',
  MATCH_ORBIT:     'MATCH_ORBIT',
  TRAIL_ALIGN:     'TRAIL_ALIGN',
  HOLD:            'HOLD',
});

export class AutopilotSystem {
  constructor() {
    /** @type {boolean} */
    this._engaged = false;

    /** @type {string} 'OFF'|'RENDEZVOUS_FAR'|'MATCH_ORBIT'|'TRAIL_ALIGN'|'HOLD' */
    this._phase = PHASE.OFF;

    /** @type {number} Seconds spent in HOLD (triggers auto-disengage at HOLD_DURATION) */
    this._holdTimer = 0;

    /** @type {number} Accumulated time the HOLD excursion has exceeded the
     *  demotion band — debounces HOLD → TRAIL_ALIGN so transient single-frame
     *  spikes don't flicker the phase (see AUTOPILOT_align-hold-loop plan). */
    this._holdExitDwell = 0;

    /** @type {THREE.Vector3|null} Latest computed goal position (P_m*) in scene units */
    this._goalPos = null;

    /** @type {string} 'NONE'|'TARGET'|'TRAWL'|'DEBRIS'|'PROGRADE' */
    this._headingMode = 'NONE';

    /** @type {THREE.Vector3|null} Current heading world position (for legacy HUD compatibility) */
    this._headingTarget = null;

    // Dependency references (set via init)
    /** @type {import('../entities/PlayerSatellite.js').PlayerSatellite|null} */
    this._player = null;
    /** @type {import('./TargetSelector.js').TargetSelector|null} */
    this._targetSelector = null;
    /** @type {import('./TrawlManager.js').TrawlManager|null} */
    this._trawlManager = null;
    /** @type {import('../entities/DebrisField.js').DebrisField|null} */
    this._debrisField = null;
    /** @type {import('../entities/ArmManager.js').ArmManager|null} */
    this._armManager = null;
    /** @type {import('./TargetAcquisition.js').TargetAcquisition|null} */
    this._targetAcquisition = null;

    /** @type {number} Timer for throttling debris scan */
    this._debrisScanTimer = 0;
    /** @type {{ pos: THREE.Vector3, orbit: object, id: (number|string|null) }|null} */
    this._cachedDebrisResult = null;

    /** @type {boolean} True while a trawl sweep is active — blocks autopilot engage */
    this._trawlActive = false;

    /** @type {boolean} UX-11 #4: armed after a trawl-denied engage; next A press aborts the sweep */
    this._trawlAbortArmed = false;

    /** @type {object|null} Debris Map cluster target (ST-4.A) */
    this._debrisMapCluster = null;

    /** @type {object|null} Locked target reference (persists through target cycling) */
    this._lockedTargetRef = null;

    /** @type {number|string|null} Currently-emitted lock id (for LOCK/UNLOCK events) */
    this._lockedEmittedId = null;

    // Pre-allocated scratch vectors (hot path)
    this._tmpV1 = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();
    this._tmpV3 = new THREE.Vector3();

    // P3 (2026-07-20): hot-path temps for update()/_resolveTargetState/
    // _rotateTowardWorld — previously ~12 allocations per engaged frame.
    // Each is written+consumed within one call; _goalPosV/_headingTargetV are
    // OWNED persistent vectors so we never .copy() into a foreign object
    // (engageCluster/heading paths can assign foreign refs to _headingTarget).
    this._relP = new THREE.Vector3();
    this._relVv = new THREE.Vector3();
    this._noseWorld = new THREE.Vector3();
    this._goalDir = new THREE.Vector3();
    this._relVmps = new THREE.Vector3();
    this._velCtrlErr = new THREE.Vector3();
    this._dvCmd = new THREE.Vector3();
    this._goalPosV = new THREE.Vector3();
    this._headingTargetV = new THREE.Vector3();
    this._PdV = new THREE.Vector3();
    this._VdV = new THREE.Vector3();
    this._rotRadial = new THREE.Vector3();
    this._rotEye = new THREE.Vector3();
    this._rotMat = new THREE.Matrix4();
    this._rotQuat = new THREE.Quaternion();

    // Sprint 2 / PR A — scratch outputs for [`orbitToSceneCartesianInto`](js/entities/OrbitalMechanics.js:1).
    // Used by [`_resolveTargetState`](js/systems/AutopilotSystem.js:802) to avoid
    // allocating a fresh `{position:{x,y,z},velocity:{x,y,z}}` literal on every AP tick.
    this._tmpAPCartPos = { x: 0, y: 0, z: 0 };
    this._tmpAPCartVel = { x: 0, y: 0, z: 0 };

    /** @type {number} Cumulative ΔV spent on station-keeping recoil compensation (m/s) */
    this._stationKeepDeltaV = 0;

    /** @type {object|null} Active aim-before-launch coroutine state (net/daughter) */
    this._aimCoroutine = null;

    /** @type {boolean} Attitude hold (steady freeze) during a catch reel-in. */
    this._attitudeHold = false;
    /** @type {number} Seconds the current attitude hold has been active (safety cap). */
    this._attitudeHoldElapsed = 0;

    // Aim-before-launch: scratch for the attitude coroutine (net + daughter modes).
    this._aimBoresightWorld = new THREE.Vector3();
    this._aimTargetDir = new THREE.Vector3();
    this._aimErrAxis = new THREE.Vector3();
    this._aimDeltaQuat = new THREE.Quaternion();
    this._aimTargetQuat = new THREE.Quaternion();
    this._aimInvQuat = new THREE.Quaternion();
    this._aimLocalDir = new THREE.Vector3();

    this._setupListeners();
  }

  /**
   * Inject dependencies after construction.
   * @param {object} deps
   */
  init(deps) {
    this._player = deps.player;
    this._targetSelector = deps.targetSelector;
    this._trawlManager = deps.trawlManager;
    this._debrisField = deps.debrisField;
    this._armManager = deps.armManager;
    this._targetAcquisition = deps.targetAcquisition || null;
  }

  // ==========================================================================
  // PUBLIC STATE ACCESSORS
  // ==========================================================================

  /** @returns {boolean} Whether autopilot is currently engaged */
  get engaged() { return this._engaged; }

  /** @returns {string} Current heading mode label (legacy HUD consumers) */
  get headingMode() { return this._headingMode; }

  /**
   * Get the current rendezvous-phase label for HUD / telemetry.
   * @returns {'OFF'|'RENDEZVOUS_FAR'|'MATCH_ORBIT'|'TRAIL_ALIGN'|'HOLD'}
   */
  getCurrentPhase() { return this._phase; }

  /** @returns {boolean} True while an aim-before-launch attitude sequence is active. */
  isAiming() { return !!this._aimCoroutine; }

  /**
   * Hold the mother's orientation steady (catch capture/reel-in). Suppresses the
   * prograde auto-orient and the autopilot's steering so the attitude stays put
   * — no active slew runs, so it cannot waver. Released on reel-in end.
   */
  holdAttitude() {
    this._attitudeHold = true;
    this._attitudeHoldElapsed = 0;
    if (this._player) this._player.aimHold = true;
  }

  /**
   * Mother-net-reel plan §8 A3: the net hold gets its OWN timeout. Flight
   * (≤11 s) + reel (≤25 s) + berth margin exceeds the shared
   * AIM.AIM_TIMEOUT_S (30 s) the aim coroutine uses, so reusing it would drop
   * the hold mid-reel and resume the prograde auto-orient with a whale on
   * the line.
   */
  holdAttitudeForNet() {
    this._attitudeHold = true;
    this._attitudeHoldElapsed = 0;
    this._attitudeHoldTimeoutS = (Constants.CAPTURE_NET && Constants.CAPTURE_NET.LARGE
      ? (Constants.CAPTURE_NET.LARGE.MAX_FLIGHT_TIME ?? 11) : 11)
      + 25 + (Constants.CAPTURE_NET?.BERTH_SECURE_S ?? 4) + 6; // flight + reel + berth + margin
    if (this._player) this._player.aimHold = true;
  }

  /** Release the reel-in attitude hold (unless an aim seq owns it). */
  releaseAttitudeHold() {
    this._attitudeHold = false;
    this._attitudeHoldElapsed = 0;
    this._attitudeHoldTimeoutS = null;
    if (this._player && !this._aimCoroutine) this._player.aimHold = false;
  }

  /**
   * Tick the attitude hold. The hold is a steady freeze (no active rotation —
   * the prograde auto-orient and autopilot steering are already suppressed), so
   * this only enforces the safety cap in case a reel-in end event is missed.
   * @param {number} dt
   * @private
   */
  _tickAttitudeHold(dt) {
    if (!this._attitudeHold) return;
    this._attitudeHoldElapsed += dt;
    const timeout = this._attitudeHoldTimeoutS ?? Constants.AIM.AIM_TIMEOUT_S;
    if (this._attitudeHoldElapsed > timeout) this.releaseAttitudeHold();
  }

  // ==========================================================================
  // ENGAGE / DISENGAGE / TOGGLE
  // ==========================================================================

  /** Toggle autopilot on/off. */
  toggle() {
    if (this._engaged) {
      this.disengage('MANUAL');
    } else {
      this.engage();
    }
  }

  /** Attempt to engage autopilot. Validates ΔV safety and trawl state first. */
  engage() {
    // ΔV safety FIRST — before any destructive side effect. A second-press
    // trawl abort (below) must never fire when the engage would be denied
    // anyway (review finding: low-ΔV double-A used to kill the sweep and
    // still deny).
    const dv = this._getRemainingDeltaV();
    if (dv < ENGAGE_DV_MIN) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `⚠ AUTOPILOT DENIED. ΔV ${Math.round(dv)} m/s below ${ENGAGE_DV_MIN} m/s safety limit`,
        priority: 'warning',
      });
      return;
    }

    // UX-11 #4: the trawl-block is advisory — re-derive it from the TrawlManager's
    // live state so a stuck `_trawlActive` flag (sweep that never completed)
    // can never permanently wedge the autopilot.
    if (this._trawlActive && !(this._trawlManager && this._trawlManager.active)) {
      this._trawlActive = false;
    }
    if (this._trawlActive) {
      // Genuine active sweep. First A press warns; a second A press aborts the
      // trawl (TrawlManager ends the sweep → TRAWL_SWEEP_COMPLETE clears the
      // flag synchronously) and engages.
      if (this._trawlAbortArmed) {
        this._trawlAbortArmed = false;
        eventBus.emit(Events.TRAWL_ABORT, { reason: 'AUTOPILOT_OVERRIDE' });
        if (this._trawlActive) {
          // Abort failed to clear the sweep — bail out rather than fight it.
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: '⚠ AUTOPILOT DENIED. Trawl sweep still active',
            priority: 'warning',
          });
          return;
        }
      } else {
        this._trawlAbortArmed = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: '⚠ AUTOPILOT DENIED. Trawl sweep in progress. Press A again to abort the sweep and engage.',
          priority: 'warning',
        });
        return;
      }
    }
    this._trawlAbortArmed = false;

    let hasSelectedTarget = this._targetSelector && this._targetSelector.getActiveTarget();
    if (!hasSelectedTarget) {
      // UX-11 #11: one-tap re-acquire — pressing A with no target auto-selects
      // the best contact and engages, instead of dead-ending.
      //
      // Prefer the unified helper (top of the Tracked Targets pane, so the pane
      // highlight and the AP destination agree). The helper's list is
      // discovered-only, so fall back to the mass-based nearest lookup when it
      // yields null (e.g. an undiscovered field, or fragments-only Kessler
      // end-state) — this honours the NavRecoveryAdvisor "press A to approach"
      // promise, which uses a mass-0 nearest lookup, in all cases.
      let acquired = null;
      if (this._targetAcquisition && typeof this._targetAcquisition.acquireBestTarget === 'function') {
        acquired = this._targetAcquisition.acquireBestTarget({ source: 'autopilot_reacquire' });
      }
      if (acquired) {
        hasSelectedTarget = this._targetSelector.getActiveTarget();
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'No target selected. Acquiring nearest contact.',
          priority: 'info',
        });
      } else {
        const nearest = this._findNearestLargeDebris() || this._findNearestLargeDebris(0);
        if (nearest && nearest.debris && this._targetSelector &&
            typeof this._targetSelector.setTarget === 'function') {
          this._targetSelector.setTarget(nearest.debris, { source: 'autopilot_reacquire' });
          hasSelectedTarget = this._targetSelector.getActiveTarget();
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: 'No target selected. Acquiring nearest contact.',
            priority: 'info',
          });
        } else if (nearest) {
          // No selector API available — engage in DEBRIS heading mode directly.
          this._cachedDebrisResult = nearest;
          this._debrisScanTimer = 0;
          hasSelectedTarget = true;
        }
      }
    }
    if (!hasSelectedTarget) {
      // AUTOPILOT_ANALYSIS.md §D.5 #1: refuse to engage without a selected target.
      // Skills system listens for AUTOPILOT_NO_TARGET as a discovery signal
      // (Constants.js:1006 nav_autopilot_no_target).
      eventBus.emit(Events.AUTOPILOT_NO_TARGET);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: '⚠ AUTOPILOT DENIED. No live contacts in the field. Check the Debris Map (`) for the next cluster.',
        priority: 'warning',
      });
      return;
    }

    const heading = this._determineHeading();
    if (!heading) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'AUTOPILOT: No valid heading. Using prograde',
        priority: 'info',
      });
    }

    this._engaged = true;
    if (this._player) {
      this._player.autopilotEngaged = true;
      // Legacy kinematic path only (arbiter owns dynamics-path continuity).
      if (!Constants.ATTITUDE?.DYNAMICS_ENABLED) this._player._manualRotation.set(0, 0, 0, 1);
    }
    this._headingTarget = heading ? heading.position : null;
    this._headingMode = heading ? heading.mode : 'PROGRADE';

    // Lock target reference so cycling targets doesn't change AP destination
    this._lockedTargetRef = null;
    if (this._headingMode === 'TARGET' && this._targetSelector) {
      this._lockedTargetRef = this._targetSelector.getActiveTarget();
    }

    // Start in RENDEZVOUS_FAR — the state machine will promote early if conditions
    // already satisfy tighter phases on the first update tick.
    this._setPhase(PHASE.RENDEZVOUS_FAR);
    this._holdTimer = 0;

    // Emit target lock for CollisionAvoidanceSystem
    this._refreshTargetLock();

    eventBus.emit(Events.AUTOPILOT_ENGAGE, {
      mode: this._headingMode,
      targetName: this._getTargetLabel(),
      phase: this._phase,
    });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `AUTOPILOT ENGAGED. ${this._headingMode}`,
      priority: 'info',
    });
    // UX-2 #12: Route autopilot engage through notification zone
    eventBus.emit(Events.SHOW_NOTIFICATION, { text: 'AUTOPILOT ACTIVE' });
  }

  /**
   * Engage autopilot toward a debris cluster center (from Field-Assay MFD).
   * Bypasses selected-target and trawl-active checks since clusters are not
   * individual targets.
   * @param {object} cluster — cluster object with .center { x, y, z } and .id
   */
  engageCluster(cluster) {
    if (!cluster?.center) return;
    this._debrisMapCluster = cluster;
    this._trawlActive = false;  // override trawl if active
    this._engaged = true;
    this._setPhase(PHASE.RENDEZVOUS_FAR);
    this._holdTimer = 0;
    this._headingMode = 'CLUSTER';
    this._headingTarget = new THREE.Vector3(cluster.center.x, cluster.center.y, cluster.center.z);
    this._lockedTargetRef = null;

    if (this._player) {
      this._player.autopilotEngaged = true;
      // Legacy kinematic path only: reset the manual offset on AP transitions.
      // Under the rigid-body dynamics path the attitude arbiter owns handback
      // continuity (_handAttitudeToPlayer folds the current attitude into the
      // offset), so this hard reset must NOT run there or it would cause a snap.
      if (!Constants.ATTITUDE?.DYNAMICS_ENABLED) this._player._manualRotation.set(0, 0, 0, 1);
    }

    // Emit target lock for CollisionAvoidanceSystem exemption
    eventBus.emit(Events.AUTOPILOT_TARGET_LOCK, { targetId: cluster.id });

    eventBus.emit(Events.AUTOPILOT_ENGAGE, {
      mode: 'CLUSTER',
      clusterId: cluster.id,
      targetName: cluster.name || cluster.id,
      phase: this._phase,
    });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `AUTOPILOT ENGAGED. CLUSTER: ${cluster.name || cluster.id}`,
      priority: 'info',
    });
  }

  /**
   * Disengage autopilot with a reason tag.
   * @param {string} reason — 'MANUAL'|'DELTAV'|'ARRIVED'|'COLLISION'|'ARROW_INPUT'|'TRAWL'|'TARGET_LOST'
   */
  disengage(reason) {
    if (!this._engaged) return;

    this._engaged = false;
    this._lockedTargetRef = null;
    this._debrisMapCluster = null;
    this._goalPos = null;
    this._holdTimer = 0;
    this._holdExitDwell = 0;
    this._stationKeepDeltaV = 0;

    // Release any active target lock
    this._releaseTargetLock();

    if (this._player) {
      this._player.autopilotEngaged = false;
      // Legacy kinematic path only. On the dynamics path the arbiter's handback
      // (_handAttitudeToPlayer) folds the AP-left attitude into the offset for a
      // jump-free return to manual — resetting to identity here would snap it.
      if (!Constants.ATTITUDE?.DYNAMICS_ENABLED) this._player._manualRotation.set(0, 0, 0, 1);
    }
    this._headingTarget = null;
    this._headingMode = 'NONE';
    this._setPhase(PHASE.OFF);

    eventBus.emit(Events.AUTOPILOT_DISENGAGE, { reason });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `AUTOPILOT OFF. ${reason}`,
      priority: reason === 'DELTAV' || reason === 'COLLISION' ? 'warning' : 'info',
    });
    // UX-2 #12: Route autopilot disengage through notification zone
    eventBus.emit(Events.SHOW_NOTIFICATION, { text: 'AUTOPILOT DISENGAGED' });
  }

  // ==========================================================================
  // PER-FRAME UPDATE (state machine + control law)
  // ==========================================================================

  /**
   * Called each gameplay frame from the main game loop.
   * Advances the rendezvous state machine and commands Cartesian impulses.
   * @param {number} dt — frame delta in seconds (game-scaled)
   */
  update(dt) {
    // C-11: Tick aim coroutine independently of autopilot engagement
    this._tickAimCoroutine(dt);

    // Attitude-hold: actively track the catch during reel-in (also independent
    // of engagement). Reel-in always ends with a stow/snap/miss event; the
    // internal safety cap releases if one is ever missed.
    this._tickAttitudeHold(dt);

    if (!this._engaged || !this._player) return;

    // --- ΔV safety check ---
    const dv = this._getRemainingDeltaV();
    if (dv < DISENGAGE_DV_MIN) {
      this.disengage('DELTAV');
      return;
    }

    // --- Locked target still alive? ---
    if (this._lockedTargetRef && !this._lockedTargetRef.alive) {
      this.disengage('TARGET_LOST');
      return;
    }

    // --- Resolve target state: P_d, V_d, orbit ---
    const targetState = this._resolveTargetState(dt);
    if (!targetState) {
      // Prograde fallback — just rotate toward current velocity, no thrust.
      this._updateProgradeOnly(dt);
      return;
    }
    const { Pd, Vd, mode } = targetState;

    // Emit AUTOPILOT_ENGAGE if heading mode changed (legacy listeners)
    if (mode !== this._headingMode) {
      this._headingMode = mode;
      eventBus.emit(Events.AUTOPILOT_ENGAGE, {
        mode: this._headingMode,
        targetName: this._getTargetLabel(),
        phase: this._phase,
      });
      // Lock may have changed — refresh CA exemption
      this._refreshTargetLock();
    }

    // --- Target unit-velocity v̂_d (fall back to player prograde if degenerate) ---
    const vdMag = Vd.length();
    const vHat = this._tmpV1;
    if (vdMag > 1e-10) {
      vHat.copy(Vd).divideScalar(vdMag);
    } else {
      const pv = this._player.getVelocity();
      vHat.set(pv.x, pv.y, pv.z);
      if (vHat.lengthSq() > 1e-20) vHat.normalize();
      else vHat.set(0, 0, 1);
    }

    // --- Tool-aware trailing distance ---
    const Dtrail_m = this._getTrailDistance();
    const Dtrail_scene = Dtrail_m * M;

    // --- Goal pose: P_m* = P_d − v̂_d · D_trail ---
    const Pm_goal = this._tmpV2.copy(Pd).addScaledVector(vHat, -Dtrail_scene);
    this._goalPos = this._goalPosV.copy(Pm_goal);
    this._headingTarget = this._headingTargetV.copy(Pd); // keep legacy HUD field populated

    // --- Errors ---
    const Pm = this._player.getPosition();                 // scene units
    const pvel = this._player.getVelocity();               // km/s
    const Vm = this._tmpV3.set(pvel.x, pvel.y, pvel.z);    // km/s

    // relP = Pm_goal − Pm (scene units)
    const relP = this._relP.subVectors(Pm_goal, Pm);
    // relV = Vd − Vm (km/s)
    const relV = this._relVv.subVectors(Vd, Vm);

    const posErrM = relP.length() / M;                     // metres
    const velErrMps = relV.length() * 1000;                // m/s

    // Angle error: ship nose (+Z local) vs. v̂_d
    const noseWorld = this._noseWorld.set(0, 0, 1).applyQuaternion(this._player.quaternion);
    const dotNose = Math.max(-1, Math.min(1, noseWorld.dot(vHat)));
    const angleRad = Math.acos(dotNose);

    // --- State-machine transitions & control law ---
    const AP = Constants.AUTOPILOT;
    const POS_TOL = AP.POS_TOL;                            // m
    const VEL_TOL = AP.VEL_TOL;                            // m/s
    const ANG_TOL = AP.ANG_TOL_DEG * Math.PI / 180;        // rad
    const FAR_TO_MATCH = AP.FAR_TO_MATCH_POS;              // m

    // -----------------------------------------------------------------------
    // Predictive quadratic-braking velocity profile.
    //   v*(r) = min(V_CAP, √(2·A_BRAKE·r))
    // The autopilot tracks desired relative velocity v*·goalDir (player
    // closes on goal at v*). Commanded ΔV = KP_VEL · (v*·goalDir + relV_mps)
    // which goes to zero at `relV = −v*·goalDir` (= player matching the
    // prescribed closing profile). At the goal (r=0) v*=0 so the law becomes
    // pure velocity damping and the ship arrives at rest. A_BRAKE reserves
    // headroom below MAX_ACCEL for transverse corrections and tracking error.
    // See AUTOPILOT_ANALYSIS.md §D Retrospective #2.
    // -----------------------------------------------------------------------
    const A_BRAKE = AP.MAX_ACCEL * AP.BRAKE_FRACTION;      // m/s²
    const vStarBrake = Math.sqrt(2 * A_BRAKE * posErrM);   // m/s
    const vStar = Math.min(AP.V_CAP, vStarBrake);          // m/s

    // goalDir in world frame (scene-unit direction == world-direction since M is scalar)
    const goalDir = this._goalDir.set(0, 0, 0);
    if (relP.lengthSq() > 1e-20) goalDir.copy(relP).normalize();
    // relV in m/s (relV is Vd − Vm in km/s → ×1000)
    const relV_mps = this._relVmps.copy(relV).multiplyScalar(1000);
    // Velocity-control error: v*·goalDir + relV_mps. This is the impulse
    // direction that drives the player toward the desired closing profile.
    const velCtrlErr = this._velCtrlErr.copy(goalDir).multiplyScalar(vStar).add(relV_mps);

    const dvCmd = this._dvCmd.set(0, 0, 0);

    switch (this._phase) {
      case PHASE.RENDEZVOUS_FAR: {
        dvCmd.copy(velCtrlErr).multiplyScalar(AP.KP_VEL);
        if (posErrM < FAR_TO_MATCH) this._setPhase(PHASE.MATCH_ORBIT);
        break;
      }
      case PHASE.MATCH_ORBIT: {
        dvCmd.copy(velCtrlErr).multiplyScalar(AP.KP_VEL);
        // MATCH→TRAIL gate: under the predictive-braking law the residual
        // velocity error is v*(r) by design (ship tracks the braking profile),
        // so a tight velErr gate would prevent TRAIL_ALIGN entry until
        // sub-metre posErr. Instead gate on posErr and a looser velErr
        // consistent with v*(D_trail) — the band where terminal-phase
        // tolerances become meaningful.
        if (posErrM < Dtrail_m && velErrMps < Math.sqrt(2 * A_BRAKE * Dtrail_m)) {
          this._setPhase(PHASE.TRAIL_ALIGN);
        } else if (posErrM > FAR_TO_MATCH * 1.5) {
          this._setPhase(PHASE.RENDEZVOUS_FAR);
        }
        break;
      }
      case PHASE.TRAIL_ALIGN: {
        dvCmd.copy(velCtrlErr).multiplyScalar(AP.KP_VEL);
        if (posErrM < POS_TOL && velErrMps < VEL_TOL && angleRad < ANG_TOL) {
          this._setPhase(PHASE.HOLD);
          this._holdTimer = 0;

          // Snap mother orbit shape/plane to match target so they share
          // identical Keplerian elements and propagate together (prevents
          // secular drift from differential drag and residual ΔV error).
          //
          // CRITICAL FIX: After snapping the orbital plane (inc/raan/argPerigee),
          // the old trueAnomaly maps to a DIFFERENT Cartesian position on the new
          // plane — potentially hundreds of km away (the "teleportation bug").
          // Fix: capture the pre-snap position, snap the plane, then recompute
          // trueAnomaly so the derived Cartesian position matches the pre-snap
          // location.  This preserves the physical trailing offset while syncing
          // the orbit shape for drift prevention.
          if (this._lockedTargetRef && this._lockedTargetRef.orbit && this._player) {
            const tOrb = this._lockedTargetRef.orbit;
            const pOrb = this._player.orbit;

            // 1. Capture pre-snap scene-space position (from current orbit elements)
            const preSnap = orbitToSceneCartesian(pOrb);

            // 2. Snap orbital plane + shape (NOT trueAnomaly yet)
            pOrb.semiMajorAxis = tOrb.semiMajorAxis;
            pOrb.eccentricity  = tOrb.eccentricity;
            pOrb.inclination   = tOrb.inclination;
            pOrb.raan          = tOrb.raan;
            pOrb.argPerigee    = tOrb.argPerigee;
            pOrb.meanMotion    = tOrb.meanMotion;

            // 3. Recompute trueAnomaly from pre-snap position on the NEW plane.
            //    Project the pre-snap position into the new orbit's perifocal frame
            //    and extract the angle.  The rotation matrix from perifocal → scene
            //    depends only on angles (same as keplerianToCartesian).  We invert
            //    it (R^T) to go scene → perifocal, then atan2(yP, xP) = ν.
            const inc  = pOrb.inclination;
            const raan = pOrb.raan;
            const argP = pOrb.argPerigee;
            const cosO = Math.cos(raan), sinO = Math.sin(raan);
            const cosW = Math.cos(argP), sinW = Math.sin(argP);
            const cosI = Math.cos(inc),  sinI = Math.sin(inc);

            // Perifocal → scene rotation (matches keplerianToCartesian)
            const l1 = cosO * cosW - sinO * sinW * cosI;
            const l2 = -cosO * sinW - sinO * cosW * cosI;
            const m1 = sinO * cosW + cosO * sinW * cosI;
            const m2 = -sinO * sinW + cosO * cosW * cosI;
            const n1 = sinW * sinI;
            const n2 = cosW * sinI;

            // Inverse (scene → perifocal): xP = l1*x + n1*y + m1*z
            const sx = preSnap.position.x;
            const sy = preSnap.position.y;
            const sz = preSnap.position.z;
            const xP = l1 * sx + n1 * sy + m1 * sz;
            const yP = l2 * sx + n2 * sy + m2 * sz;

            let newTA = Math.atan2(yP, xP);
            if (newTA < 0) newTA += 2 * Math.PI;
            pOrb.trueAnomaly = newTA;

            // Zero RCS residual so the additive position offset in
            // PlayerSatellite.update() doesn't shift mother away from the
            // orbit-derived position and trigger spurious dead-band corrections.
            if (this._player._rcsVelocity) {
              this._player._rcsVelocity.set(0, 0, 0);
            }
          }

          eventBus.emit(Events.AUTOPILOT_ARRIVED, { mode: this._headingMode });
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: '✓ ON STATION. [N] lasso (≤200m) · [D] deploy daughter for far/heavy debris',
            priority: 'info',
          });
        } else if (posErrM > Dtrail_m * 3) {
          // Fell too far behind — back off to MATCH_ORBIT
          this._setPhase(PHASE.MATCH_ORBIT);
        }
        break;
      }
      case PHASE.HOLD: {
        // Continuous orbit-shape sync: copy target shape/plane elements to
        // mother every frame. Models active station-keeping thrust that
        // compensates for differential drag, CoM perturbations, and other
        // asymmetric forces the debris does not experience.
        //
        // Same teleportation guard as the initial TRAIL_ALIGN→HOLD snap:
        // if the orbital plane changed since last frame (e.g. perturbation,
        // collision-avoidance impulse), recompute trueAnomaly to preserve
        // the mother's physical position.
        let syncedThisFrame = false;
        if (this._lockedTargetRef && this._lockedTargetRef.orbit && this._player) {
          syncedThisFrame = true;
          const tOrb = this._lockedTargetRef.orbit;
          const pOrb = this._player.orbit;

          // Detect plane change before overwriting
          const planeChanged =
            pOrb.inclination !== tOrb.inclination ||
            pOrb.raan        !== tOrb.raan ||
            pOrb.argPerigee  !== tOrb.argPerigee;

          // Capture pre-snap position only if plane is about to change
          const preSnap = planeChanged ? orbitToSceneCartesian(pOrb) : null;

          pOrb.semiMajorAxis = tOrb.semiMajorAxis;
          pOrb.eccentricity  = tOrb.eccentricity;
          pOrb.inclination   = tOrb.inclination;
          pOrb.raan          = tOrb.raan;
          pOrb.argPerigee    = tOrb.argPerigee;
          // trueAnomaly deliberately NOT copied — preserves trailing offset
          pOrb.meanMotion    = tOrb.meanMotion;

          // Recompute trueAnomaly when plane changed (same math as initial snap)
          if (planeChanged && preSnap) {
            const cosO = Math.cos(pOrb.raan), sinO = Math.sin(pOrb.raan);
            const cosW = Math.cos(pOrb.argPerigee), sinW = Math.sin(pOrb.argPerigee);
            const cosI = Math.cos(pOrb.inclination), sinI = Math.sin(pOrb.inclination);
            const l1 = cosO * cosW - sinO * sinW * cosI;
            const l2 = -cosO * sinW - sinO * cosW * cosI;
            const m1 = sinO * cosW + cosO * sinW * cosI;
            const m2 = -sinO * sinW + cosO * cosW * cosI;
            const n1 = sinW * sinI;
            const n2 = cosW * sinI;
            const sx = preSnap.position.x, sy = preSnap.position.y, sz = preSnap.position.z;
            let newTA = Math.atan2(
              l2 * sx + n2 * sy + m2 * sz,
              l1 * sx + n1 * sy + m1 * sz
            );
            if (newTA < 0) newTA += 2 * Math.PI;
            pOrb.trueAnomaly = newTA;
          }
        }

        // Dead-band for along-track fine-tuning: if the trailing distance
        // drifts outside tolerance (from numerical noise or frame-boundary
        // drag mismatch), a gentle velocity-damping pulse nudges it back.
        //
        // CRITICAL: skip the damping pulse entirely while the continuous
        // orbit-sync above is active. The sync alone holds the mother exactly
        // at the trailing point (both bodies share Keplerian elements and the
        // same mean motion, so they propagate in lock-step). Issuing a
        // velocity-damping `applyCartesianImpulse` here re-derives `player.orbit`
        // from a STALE cached `_cartesian` state and discards the sync that just
        // ran this frame — and because da/dv ≈ 1.8 km per m/s at LEO, a sub-m/s
        // pulse corrupts the semi-major axis by hundreds of metres. That drove
        // the HOLD ⇄ TRAIL_ALIGN ("hold/align/hold/align") oscillation the user
        // reported. See .kilo/plans/autopilot-align-hold-loop.md.
        if (!syncedThisFrame && (posErrM > POS_TOL || velErrMps > VEL_TOL)) {
          dvCmd.addScaledVector(relV_mps, AP.KP_VEL * 0.5);
        }

        // Hysteresis + dwell — only drop back to TRAIL_ALIGN on a LARGE
        // excursion (4× tolerance: sync failed, target lost, big perturbation)
        // that PERSISTS for HOLD_EXIT_DWELL_S. The dwell debounces single-frame
        // transients (CA dodge settling, one-frame measurement lag, frame-
        // boundary drag mismatch) that — combined with the pre-fix damping
        // pulse corrupting the synced orbit — produced the HOLD ⇄ TRAIL_ALIGN
        // ("hold/align/hold/align") flicker. Measured posErr/velErr is used so
        // a genuinely displaced mother (e.g. a large CA dodge that the sync
        // cannot heal) still demotes and re-aligns.
        const excursion = posErrM > 4 * POS_TOL || velErrMps > 4 * VEL_TOL;
        if (excursion) {
          this._holdExitDwell += dt;
        } else {
          this._holdExitDwell = 0;
        }
        if (excursion && this._holdExitDwell >= AP.HOLD_EXIT_DWELL_S) {
          this._setPhase(PHASE.TRAIL_ALIGN);
        } else {
          // Suppress HOLD timer while ANY of these are true:
          //   (a) a daughter arm is actively seeking targets, OR
          //   (b) a locked target is still alive — the pilot engaged AP toward
          //       a specific debris, so the UX contract is "hold indefinitely
          //       until manual disengage, target captured/burned, or arm work
          //       starts".  Without (b) the mother auto-disengages 1.5 s after
          //       arrival and drifts away — the symptom the user reported
          //       2026-05-15 ("mother autopilot turns off after approaching
          //       target").  (a) alone wasn't enough because it only covers
          //       the post-deployment window — before any daughter is even
          //       launched, only (b) prevents the auto-disengage.
          // The remaining ARRIVED auto-disengage case is cluster / prograde
          // AP (no specific target locked): there's nothing further to do,
          // so an automatic shut-off after 1.5 s is the right UX.
          // FIX_PLAN §3: Use canonical predicate — old check missed REELING, HAULING, etc.
          const armsActive = this._armManager?.hasTetheredArm?.() || false;
          const hasLockedTarget = !!(this._lockedTargetRef && this._lockedTargetRef.alive);
          if (!armsActive && !hasLockedTarget) {
            this._holdTimer += dt;
          }
          if (this._holdTimer >= AP.HOLD_DURATION) {
            this.disengage('ARRIVED');
            return;
          }
        }
        // Issue-A option-5 defense: when an arm is GRAPPLED or REELING the
        // mother should *also* gently close on the daughter, not just wait
        // for the daughter to reach her.  This adds a small additive ΔV
        // command pointing at the active arm — bounded by MAX_ACCEL clamp
        // below so it can never overpower the normal HOLD control.  Works
        // whether or not the locked target's orbit is perfectly synced;
        // any residual mother-daughter drift is bled off automatically.
        if (this._armManager && this._armManager.arms) {
          let activeArm = null;
          for (const a of this._armManager.arms) {
            if (a.state === Constants.ARM_STATES.GRAPPLED ||
                a.state === Constants.ARM_STATES.REELING) {
              activeArm = a;
              break;
            }
          }
          if (activeArm && activeArm.position) {
            const toArm = this._tmpV3.subVectors(activeArm.position, Pm);
            const distM = toArm.length() / M;
            if (distM > 1) {
              // Closing rate proportional to gap, capped at 3 m/s so a stale
              // 1-km drift case still converges in ~5 min instead of forever,
              // and a clean ≤ 35 m capture isn't disturbed (3 % gain × 35 m
              // = 1 m/s — invisible alongside the 4 m/s reel-in).
              const closeSpeed = Math.min(3.0, distM * 0.03);
              toArm.normalize();
              // Apply as velocity-control error so the existing KP_VEL gain
              // converts it to a Cartesian impulse on the same scale as the
              // rest of the HOLD control law.  toArm points mother→arm, so a
              // POSITIVE scalar pushes the mother toward the arm; the global
              // MAX_ACCEL clamp at the bottom of update() prevents this from
              // ever exceeding the normal autopilot thrust budget.
              dvCmd.addScaledVector(toArm, closeSpeed * AP.KP_VEL);
            }
          }
        }
        break;
      }
      default:
        break;
    }

    // --- Clamp commanded ΔV by MAX_ACCEL · gameDt ---
    // Orbit propagation runs at TIME_SCALE_GAMEPLAY × real-time (10× by
    // default). The control law's acceleration budget must match the
    // game-time dynamics; otherwise the effective braking authority is only
    // 1/TIME_SCALE of what the profile assumes, causing decaying oscillation
    // through the goal (the "10× underdamped" bug — see Retrospective #3).
    const gameDt = dt * Constants.TIME_SCALE_GAMEPLAY;
    const maxDv = AP.MAX_ACCEL * gameDt;
    const dvMag = dvCmd.length();
    if (dvMag > maxDv && dvMag > 1e-12) {
      dvCmd.multiplyScalar(maxDv / dvMag);
    }

    // --- Issue impulse via the new Cartesian API (no element-basis misuse) ---
    // Resource bookkeeping inside applyCartesianImpulse uses the raw dt so
    // fuel consumption remains physical, not time-warped.
    if (dvCmd.lengthSq() > 1e-18) {
      this._player.applyCartesianImpulse(dvCmd, dt);
    }

    // --- Rotate ship toward nose* = v̂_d ---
    // Aim-before-launch mutual exclusion: while an aim coroutine is slewing the
    // attitude, OR a catch reel-in has frozen the orientation, that controller
    // owns the quaternion — don't let the HOLD-phase prograde steer fight it.
    if (!this._aimCoroutine && !this._attitudeHold) {
      this._rotateTowardWorld(vHat, dt);
    }
  }

  /**
   * Advance the rendezvous phase, logging the transition. Public events for
   * the phase label are intentionally omitted in this subtask; the HUD
   * follow-up will consume `getCurrentPhase()` directly.
   * @param {string} newPhase
   * @private
   */
  _setPhase(newPhase) {
    if (newPhase === this._phase) return;
    this._phase = newPhase;
    // Reset HOLD-exit debounce on any phase change so a fresh HOLD entry starts
    // with a clean accumulator (and a demotion can't carry stale dwell time).
    this._holdExitDwell = 0;
  }

  // ==========================================================================
  // TARGET-STATE RESOLUTION
  // ==========================================================================

  /**
   * Resolve the current target's scene-Cartesian state and heading mode.
   * Priority: locked TARGET ref > live TARGET ref > TRAWL cluster > large DEBRIS scan.
   *
   * @param {number} dt - Frame delta (for scan throttling)
   * @returns {{ Pd: THREE.Vector3, Vd: THREE.Vector3, mode: string }|null}
   * @private
   */
  _resolveTargetState(dt) {
    // Locked TARGET ref (persists through target cycling) ---------------------
    if (this._lockedTargetRef && this._lockedTargetRef.alive && this._lockedTargetRef.orbit) {
      // Sprint 2 / PR A — scratch-output variant; no per-tick literal alloc.
      orbitToSceneCartesianInto(
        this._lockedTargetRef.orbit, this._tmpAPCartPos, this._tmpAPCartVel
      );
      const p = this._tmpAPCartPos, v = this._tmpAPCartVel;
      return {
        Pd: this._PdV.set(p.x, p.y, p.z),
        Vd: this._VdV.set(v.x, v.y, v.z),
        mode: 'TARGET',
      };
    }

    // Non-locked heading — re-evaluate priority chain ------------------------
    this._debrisScanTimer += dt;
    const heading = this._determineHeading();
    if (!heading || !heading.position) return null;

    let Vd = null;

    if (heading.mode === 'TARGET' && this._targetSelector) {
      const t = this._targetSelector.getActiveTarget();
      if (t && t.orbit) {
        // Sprint 2 / PR A — scratch-output variant.
        orbitToSceneCartesianInto(t.orbit, this._tmpAPCartPos, this._tmpAPCartVel);
        const v = this._tmpAPCartVel;
        Vd = this._VdV.set(v.x, v.y, v.z);
      }
    } else if (heading.mode === 'TRAWL' &&
               this._trawlManager && this._trawlManager.activeCluster) {
      // Trawl clusters rarely expose a composite velocity; fall back to player prograde
      // below. This keeps the trailing vector tangent to the player's own orbit which
      // is a reasonable approximation when the cluster drifts with the mother.
    } else if (heading.mode === 'DEBRIS' &&
               this._cachedDebrisResult && this._cachedDebrisResult.orbit) {
      // Sprint 2 / PR A — scratch-output variant.
      orbitToSceneCartesianInto(
        this._cachedDebrisResult.orbit, this._tmpAPCartPos, this._tmpAPCartVel
      );
      const v = this._tmpAPCartVel;
      Vd = this._VdV.set(v.x, v.y, v.z);
    } else if (heading.mode === 'PROGRADE') {
      return null; // prograde coast — no rendezvous geometry
    }

    if (!Vd) {
      // Fallback: use player's own velocity direction
      const pv = this._player.getVelocity();
      Vd = this._VdV.set(pv.x, pv.y, pv.z);
    }

    return { Pd: heading.position, Vd, mode: heading.mode };
  }

  /** @private Prograde fallback: face velocity, no thrust. */
  _updateProgradeOnly(dt) {
    const pv = this._player.getVelocity();
    // P3: _tmpV1 is free here — the main control law (vHat) only runs when
    // _resolveTargetState() returns non-null, which routes AWAY from this path.
    const dir = this._tmpV1.set(pv.x, pv.y, pv.z);
    if (dir.lengthSq() > 1e-20) {
      dir.normalize();
      // Aim-before-launch mutual exclusion: the aim coroutine / reel-in freeze
      // owns the quaternion while active — don't let prograde-hold fight it
      // (mirrors the guard on the main control path).
      if (!this._aimCoroutine && !this._attitudeHold) this._rotateTowardWorld(dir, dt);
    }
  }

  // ==========================================================================
  // HEADING DETERMINATION (legacy priority list — unchanged)
  // ==========================================================================

  /**
   * Determine the best heading based on priority:
   * 0. Field-Assay cluster  1. Selected target  2. Trawl cluster  3. Nearest large debris  4. Prograde
   * @returns {{ position: THREE.Vector3|null, mode: string }|null}
   * @private
   */
  _determineHeading() {
    // --- Priority 0: Debris Map cluster target (highest — explicit player choice) ---
    if (this._debrisMapCluster?.center) {
      const c = this._debrisMapCluster.center;
      return {
        position: new THREE.Vector3(c.x, c.y, c.z),
        mode: 'CLUSTER',
      };
    }

    // --- Priority 1: Selected target ---
    if (this._targetSelector) {
      const target = this._targetSelector.getActiveTarget();
      if (target && target.alive && target.orbit) {
        const cart = orbitToSceneCartesian(target.orbit);
        if (cart && cart.position) {
          return {
            position: new THREE.Vector3(cart.position.x, cart.position.y, cart.position.z),
            mode: 'TARGET',
          };
        }
      }
    }

    // --- Priority 2: Active trawl cluster center ---
    if (this._trawlManager && this._trawlManager.active && this._trawlManager.activeCluster) {
      const cluster = this._trawlManager.activeCluster;
      if (cluster.center) {
        return {
          position: new THREE.Vector3(cluster.center.x, cluster.center.y, cluster.center.z),
          mode: 'TRAWL',
        };
      }
    }

    // --- Priority 3: Nearest large debris (throttled scan) ---
    if (this._debrisScanTimer >= DEBRIS_SCAN_INTERVAL || !this._cachedDebrisResult) {
      this._debrisScanTimer = 0;
      this._cachedDebrisResult = this._findNearestLargeDebris();
    }
    if (this._cachedDebrisResult) {
      return { position: this._cachedDebrisResult.pos, mode: 'DEBRIS' };
    }

    // --- Priority 4: Prograde ---
    return { position: null, mode: 'PROGRADE' };
  }

  /** @private Get human-readable label for current AP heading target. */
  _getTargetLabel() {
    if (this._headingMode === 'TARGET' && this._targetSelector) {
      const t = this._targetSelector.getActiveTarget();
      if (t) return t.type || 'TARGET';
    }
    return this._headingMode;
  }

  /**
   * Scan debrisList for the nearest alive debris with mass ≥ minMassKg
   * (default LARGE_DEBRIS_MASS). Delegates to the shared pure helper
   * [`findNearestLiveDebris`](js/systems/NavRecoveryAdvisor.js:1) (UX-11 #4/#11).
   * @param {number} [minMassKg=LARGE_DEBRIS_MASS]
   * @returns {{ pos: THREE.Vector3, orbit: object, id: (number|string|null), debris: object }|null}
   * @private
   */
  _findNearestLargeDebris(minMassKg = LARGE_DEBRIS_MASS) {
    if (!this._debrisField || !this._debrisField.debrisList) return null;
    const playerPos = this._player.getPosition();
    const nearest = findNearestLiveDebris(
      { x: playerPos.x, y: playerPos.y, z: playerPos.z },
      this._debrisField.debrisList,
      minMassKg
    );
    if (!nearest) return null;
    const d = nearest.debris;
    return {
      pos: new THREE.Vector3(nearest.pos.x, nearest.pos.y, nearest.pos.z),
      orbit: d.orbit,
      id: d.id != null ? d.id : null,
      debris: d,
    };
  }

  // ==========================================================================
  // CA TARGET LOCK (emit AUTOPILOT_TARGET_LOCK / UNLOCK)
  // ==========================================================================

  /**
   * Compute the debris-id that the autopilot is currently locked onto and
   * emit LOCK/UNLOCK events so [`CollisionAvoidanceSystem`](js/systems/CollisionAvoidanceSystem.js:1)
   * can exempt it from dodging.
   * @private
   */
  _refreshTargetLock() {
    const id = this._getCurrentLockId();
    if (id === this._lockedEmittedId) return;

    // Transition: different id → release old, acquire new
    if (this._lockedEmittedId != null) {
      eventBus.emit(Events.AUTOPILOT_TARGET_UNLOCK, { debrisId: this._lockedEmittedId });
    }
    this._lockedEmittedId = id;
    if (id != null) {
      eventBus.emit(Events.AUTOPILOT_TARGET_LOCK, { debrisId: id });
    }
  }

  /** @private Release any active target lock. */
  _releaseTargetLock() {
    if (this._lockedEmittedId == null) return;
    eventBus.emit(Events.AUTOPILOT_TARGET_UNLOCK, { debrisId: this._lockedEmittedId });
    this._lockedEmittedId = null;
  }

  /** @private Return current lock id (null if no single debris is being approached). */
  _getCurrentLockId() {
    if (this._lockedTargetRef && this._lockedTargetRef.alive) {
      return this._lockedTargetRef.id != null
        ? this._lockedTargetRef.id
        : (this._lockedTargetRef.debrisId != null ? this._lockedTargetRef.debrisId : null);
    }
    if (this._headingMode === 'TARGET' && this._targetSelector) {
      const t = this._targetSelector.getActiveTarget();
      if (t) return t.id != null ? t.id : (t.debrisId != null ? t.debrisId : null);
    }
    if (this._headingMode === 'DEBRIS' && this._cachedDebrisResult) {
      return this._cachedDebrisResult.id;
    }
    return null;
  }

  // ==========================================================================
  // ROTATION HELPER
  // ==========================================================================

  /**
   * Rotate the ship toward a world-space direction using rate-limited slerp.
   * Uses the same lookAt convention as
   * [`PlayerSatellite._orientAlongVelocity`](js/entities/PlayerSatellite.js:2177)
   * (radial-up). No PD controller — monotonic convergence, no oscillation.
   * @param {THREE.Vector3} worldDir — normalized world-space direction
   * @param {number} dt
   * @private
   */
  _rotateTowardWorld(worldDir, dt) {
    const pos = this._player.getPosition(); // getPosition() clones — API boundary
    const radial = this._rotRadial.copy(pos).normalize();

    // lookAt: eye=pos+dir, target=pos → +Z = worldDir (model +Z = forward).
    this._rotMat.lookAt(this._rotEye.copy(pos).add(worldDir), pos, radial);
    const targetQuat = this._rotQuat.setFromRotationMatrix(this._rotMat);

    const angle = this._player.quaternion.angleTo(targetQuat);
    if (angle < AP_ROT_DEADZONE) return;

    const maxAngle = AP_ROT_RATE * dt;
    const alpha = Math.min(maxAngle / angle, 1.0);
    this._player.quaternion.slerp(targetQuat, alpha);
  }

  // ==========================================================================
  // TOOL-AWARE TRAILING DISTANCE
  // ==========================================================================

  /**
   * Tool-aware trailing distance (metres).
   *   lasso   → D_TRAIL_LASSO
   *   spinner → D_TRAIL_ARMS
   *   weaver  → D_TRAIL_ARMS
   *   trawl   → D_TRAIL_TRAWL
   *   mother  → D_TRAIL_NET (20 m — inside the Large Net sure-shot band)
   *   default → D_TRAIL_DEFAULT
   * @returns {number} trailing distance in metres
   * @private
   */
  _getTrailDistance() {
    const AP = Constants.AUTOPILOT;
    const tool = this._targetSelector ? this._targetSelector._recommendedTool : null;
    switch (tool) {
      case 'lasso':   return AP.D_TRAIL_LASSO;
      case 'spinner': return AP.D_TRAIL_ARMS;
      case 'weaver':  return AP.D_TRAIL_ARMS;
      case 'trawl':   return AP.D_TRAIL_TRAWL;
      case 'mother':  return AP.D_TRAIL_NET;
      default:        return AP.D_TRAIL_DEFAULT;
    }
  }

  // ==========================================================================
  // ΔV QUERY
  // ==========================================================================

  /**
   * Get remaining ΔV in m/s from ArmManager mass budget,
   * with a rough fallback based on xenon remaining.
   * @returns {number}
   * @private
   */
  _getRemainingDeltaV() {
    if (this._armManager) {
      try {
        return this._armManager.getMassBudget().deltaV;
      } catch (_) { /* fall through */ }
    }
    return this._player ? this._player.resources.xenon * 10 : 0;
  }

  // ==========================================================================
  // EVENT LISTENERS
  // ==========================================================================

  /** @private Wire up external event listeners for auto-disengage and trawl awareness. */
  _setupListeners() {
    // Attitude-hold across a lasso capture: HOLD the mother's orientation steady
    // from the moment it fires (the aim-before-launch has just put +Z on the
    // debris) through the entire reel-in, until the catch is stowed/lost. A
    // steady hold — not active tracking — because during reel-in the catch is
    // pulled to the ship's own nose (+Z), so "point at the catch" is circular and
    // oscillates. Holding steady keeps the tethered mass on the launcher axis so
    // it reels straight in instead of swinging into the fore sensors / ROSA
    // panels. The hold suppresses the prograde auto-orient (_orientAlongVelocity
    // via player.aimHold) and the autopilot's _rotateTowardWorld (guarded on
    // _attitudeHold); no active slew runs, so the attitude can't waver.
    eventBus.on(Events.LASSO_FIRED, () => this.holdAttitude());
    const endHold = () => this.releaseAttitudeHold();
    eventBus.on(Events.LASSO_STOWED, endHold);
    eventBus.on(Events.LASSO_SNAPPED, endHold);
    eventBus.on(Events.LASSO_MISSED, endHold);
    eventBus.on(Events.LASSO_DENIED, endHold);

    // Mother-net attitude hold (mother-net-reel plan §8 A3) — mirrors the
    // lasso wiring, mother-only (podIndex ≥ 0), with the dedicated net
    // timeout (flight + reel + berth, not the shared 30 s AIM_TIMEOUT_S).
    // The hold is a FREEZE; manual rotation stays available by design.
    eventBus.on(Events.NET_FIRED, (data) => {
      if (data && data.podIndex >= 0) this.holdAttitudeForNet();
    });
    const endNetHold = (data) => {
      if (data && data.podIndex >= 0) this.releaseAttitudeHold();
    };
    eventBus.on(Events.NET_CATCH_MISS, endNetHold);
    eventBus.on(Events.NET_RELEASED, endNetHold);
    eventBus.on(Events.NET_BERTHED, endNetHold);
    // NET_FAILED / TETHER_SNAP are ArmUnit-only emitters — subscribed
    // defensively; never relied on for mother cleanup (plan §8 A3).
    eventBus.on(Events.NET_FAILED, endNetHold);
    eventBus.on(Events.TETHER_SNAP, endNetHold);

    // Conjunction warning (tier ≥ 2) → auto-disengage (CA overrides AP)
    eventBus.on(Events.CONJUNCTION_WARNING, (data) => {
      if (this._engaged && data && data.tier >= 2) {
        this.disengage('COLLISION');
      }
    });

    // Trawl awareness — block autopilot during active sweeps (real cluster starts only,
    // not plain command events without cluster data).
    eventBus.on(Events.TRAWL_START, (data) => {
      if (!data || !data.cluster) return;
      this._trawlActive = true;
      if (this._engaged) {
        this.disengage('TRAWL');
      }
    });

    eventBus.on(Events.TRAWL_SWEEP_COMPLETE, () => {
      this._trawlActive = false;
      this._trawlAbortArmed = false;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Press A to autopilot to next target cluster.',
        priority: 'info',
      });
    });

    // --- Station-keeping recoil compensation (ST-4.B) ---
    eventBus.on(Events.LASSO_FIRED, (data) => {
      this._applyRecoilCompensation(data);
    });

    eventBus.on(Events.CROSSBOW_FIRE, (data) => {
      this._applyRecoilCompensation(data);
    });

    eventBus.on(Events.TRAWL_START, (data) => {
      this._applyTrawlRecoilCompensation(data);
    });

    // Delegation 2 (2026-05-31) — "release arrows" coaching warning.
    // While AP is engaged, arrow-key inputs disengage by design (see InputManager).
    // New onboarding pilots routinely fight that by mashing arrows.  Count
    // arrow-key events within a 2 s rolling window; once we cross 3 within
    // window emit a one-shot COMMS warning.  Reset on AP disengage.
    this._arrowInterferenceCount = 0;
    this._arrowInterferenceFirstAt = 0;
    this._warnedAboutArrows = false;
    eventBus.on(Events.TUTORIAL_ARROW_INPUT, () => {
      if (!this._engaged) return;
      const now = Date.now();
      if (now - (this._arrowInterferenceFirstAt || 0) > 2000) {
        this._arrowInterferenceFirstAt = now;
        this._arrowInterferenceCount = 1;
        return;
      }
      this._arrowInterferenceCount++;
      if (this._arrowInterferenceCount >= 3 && !this._warnedAboutArrows) {
        this._warnedAboutArrows = true;
        eventBus.emit(Events.COMMS_MESSAGE, {
          source: 'SPACECRAFT', channel: 'CMD', priority: 'warning',
          text: 'Release arrow keys. Autopilot has control.',
        });
      }
    });
    eventBus.on(Events.AUTOPILOT_DISENGAGE, () => {
      this._arrowInterferenceCount = 0;
      this._arrowInterferenceFirstAt = 0;
      this._warnedAboutArrows = false;
    });

  }

  // ==========================================================================
  // STATION-KEEPING RECOIL COMPENSATION (ST-4.B)
  // ==========================================================================

  /**
   * Total ΔV spent on station-keeping recoil compensation this session (m/s).
   * Exposed for Field-Assay MFD reporting.
   */
  getStationKeepDeltaV() { return this._stationKeepDeltaV || 0; }

  /**
   * Apply opposite impulse to compensate for tool firing while in HOLD.
   * Uses momentum conservation: ΔV_player = −(m_proj × v_proj / m_player) × η
   * @param {object} data - Event payload with projectileMass/armMass, launchDirection, speed
   * @private
   */
  _applyRecoilCompensation(data) {
    const AP = Constants.AUTOPILOT;
    if (!AP.STATION_KEEP_COMPENSATION) return;
    if (this._phase !== PHASE.HOLD) return;
    if (!this._player) return;

    // Extract projectile parameters from payload
    let projMass, projSpeed, launchDir;

    if (data.projectileMass && data.launchDirection && data.speed) {
      // LASSO_FIRED payload
      projMass = data.projectileMass;
      projSpeed = data.speed;
      launchDir = data.launchDirection;
    } else if (data.armMass && data.launchDirection && data.speed) {
      // CROSSBOW_FIRE payload
      projMass = data.armMass;
      projSpeed = data.speed;
      launchDir = data.launchDirection;
    } else {
      return; // Insufficient data
    }

    if (!launchDir || typeof projMass !== 'number' || typeof projSpeed !== 'number') return;

    const playerMass = this._player.mass || 130;
    const dvMagnitude = (projMass * projSpeed) / playerMass;

    // Apply opposite impulse: negate launch direction, scale by ΔV × efficiency
    const reactionDv = new THREE.Vector3()
      .copy(launchDir)
      .normalize()
      .negate()
      .multiplyScalar(dvMagnitude * AP.STATION_KEEP_EFFICIENCY);

    // dt = 0: instantaneous compensation, not continuous thrust
    this._player.applyCartesianImpulse(reactionDv, 0);

    // Track cumulative compensation ΔV for MFD reporting
    this._stationKeepDeltaV = (this._stationKeepDeltaV || 0) + dvMagnitude * AP.STATION_KEEP_EFFICIENCY;
  }

  /**
   * Apply recoil compensation for trawl net deployment.
   * Trawl deploys a net slowly — smaller single-pulse approximation.
   * @param {object} data - TRAWL_START payload
   * @private
   */
  _applyTrawlRecoilCompensation(data) {
    const AP = Constants.AUTOPILOT;
    if (!AP.STATION_KEEP_COMPENSATION) return;
    if (this._phase !== PHASE.HOLD) return;
    if (!this._player) return;

    const netMass = Constants.TRAWLING?.NET_MASS || 5;
    const deploySpeed = Constants.TRAWLING?.DEPLOY_SPEED || 2;
    const playerMass = this._player.mass || 130;
    const dvMag = (netMass * deploySpeed) / playerMass;

    // Direction: player forward (trawl deploys ahead)
    const dir = new THREE.Vector3();
    if (this._player.mesh) {
      this._player.mesh.getWorldDirection(dir);
    } else if (this._player.getForwardVector) {
      dir.copy(this._player.getForwardVector());
    } else {
      dir.set(0, 0, 1).applyQuaternion(this._player.quaternion);
    }
    dir.negate().multiplyScalar(dvMag * AP.STATION_KEEP_EFFICIENCY);

    this._player.applyCartesianImpulse(dir, 0);
    this._stationKeepDeltaV = (this._stationKeepDeltaV || 0) + dvMag * AP.STATION_KEEP_EFFICIENCY;
  }

  // ==========================================================================
  // ST-9.3 C-3: SEMI-AUTO AIM ROTATION (Gap #13)
  // ==========================================================================

  /**
   * Request the autopilot to rotate the Mother spacecraft and slew arms
   * to aim at the given target direction.
   *
   * Gated behind FEATURE_FLAGS.SEMI_AUTO_AIM. When flag is false,
   * returns a rejected promise with an informative error.
   *
   * Phase 1: Issue RCS rotation command to align chosen arm pair's meridian plane.
   *          Wait until ω < 0.5°/s AND attitude error < 1°.
   * Phase 2: Command both arms in chosen pair to slew to α.
   * Phase 3: Resolve once both arms reach target alpha within ±1°.
   *
   * Cancel: any manual aim/RCS input cancels the autopilot-managed rotation.
   *
   * @param {THREE.Vector3} targetDir — world-space unit direction to target
   * @param {import('../entities/ArmManager.js').ArmManager} [armManager] — for pair geometry
   * @returns {Promise<{ pairIndex: number, alpha: number }>} Resolves when aimed
   */
  /**
   * Aim-before-launch: rotate the Mother (and, for daughter mode, slew the
   * chosen strut pair) so the physical launcher axis points at the target,
   * then resolve so the caller can fire along the ACTUAL attitude.
   *
   * Two modes:
   *   'net'      — align ship +Z with the lead-intercept direction. Tight
   *                tolerance (NET_AIM_TOLERANCE_DEG); the net cannot steer.
   *   'daughter' — align the physical strut fire direction of the chosen arm
   *                with the target and concurrently slew α. Loose tolerance
   *                (DAUGHTER_AIM_TOLERANCE_DEG); TRANSIT FEEP corrects residual.
   *
   * Attitude is driven by directly slerping this._player.quaternion toward a
   * minimal-arc target quaternion (same 3-DOF authority AutopilotSystem already
   * uses in _rotateTowardWorld), while plumes + N₂ draw are fired through the
   * manual RCS path for feel.
   *
   * @param {(function():{x,y,z}|null)|{x,y,z}} dirProvider — callback returning the
   *   current WORLD aim direction (recomputed per tick so it tracks a moving
   *   target), or a static world dir object.
   * @param {object} [opts]
   * @param {'net'|'daughter'} [opts.mode='net']
   * @param {import('../entities/ArmManager.js').ArmManager} [opts.armManager]
   * @param {import('../entities/ArmUnit.js').ArmUnit} [opts.arm] — daughter arm (for α slew)
   * @param {number} [opts.pairIndex] — chosen pair primary index (daughter)
   * @returns {Promise<{ mode:string, launchDir:{x,y,z} }>}
   */
  requestAimRotation(dirProvider, opts = {}) {
    if (!Constants.FEATURE_FLAGS.SEMI_AUTO_AIM) {
      return Promise.reject(new Error('SEMI_AUTO_AIM feature flag is disabled.'));
    }
    if (!this._player) {
      return Promise.reject(new Error('AutopilotSystem not initialized (no player).'));
    }

    const mode = opts.mode === 'daughter' ? 'daughter' : 'net';
    const provider = (typeof dirProvider === 'function')
      ? dirProvider
      : () => dirProvider;

    // Supersede any existing coroutine.
    if (this._aimCoroutine) {
      this._rejectAim('Superseded by new aim request');
    }

    const AIM = Constants.AIM;
    const tolRad = (mode === 'net' ? AIM.NET_AIM_TOLERANCE_DEG : AIM.DAUGHTER_AIM_TOLERANCE_DEG)
      * Math.PI / 180;
    const rate = AIM.AP_ROT_RATE * (AIM.ONBOARDING_ROT_RATE_MULT || 1);

    return new Promise((resolve, reject) => {
      // Cancel handlers — manual attitude input, target change, superseding.
      const onManualRotate = () => this._rejectAim('Manual attitude input');
      const onTargetChange = () => this._rejectAim('Target changed');
      eventBus.on(Events.MOTHER_MANUAL_ROTATE, onManualRotate);
      eventBus.on(Events.TARGET_SELECTED, onTargetChange);
      eventBus.on(Events.TARGET_CLEARED, onTargetChange);

      this._player.aimHold = true;

      // One-time "on fumes" advisory when starting to slew with empty cold gas.
      if (this._player.resources && this._player.resources.coldGas <= 0) {
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: 'Attitude control on fumes — rotating anyway.',
          priority: 'warning', source: 'HOUSTON',
        });
      }

      eventBus.emit(Events.AIM_SEQUENCE_START, { mode });
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `Rotating to launch attitude. ~${Math.ceil(Math.PI / rate)}s max.`,
        priority: 'info', source: 'HOUSTON',
      });

      this._aimCoroutine = {
        mode, provider, tolRad, rate,
        armManager: opts.armManager || this._armManager,
        arm: opts.arm || null,
        pairIndex: (opts.pairIndex != null) ? opts.pairIndex : null,
        azRad: null,               // resolved lazily from dock geometry
        elapsed: 0,
        timeout: AIM.AIM_TIMEOUT_S,
        _cleanup: () => {
          eventBus.off(Events.MOTHER_MANUAL_ROTATE, onManualRotate);
          eventBus.off(Events.TARGET_SELECTED, onTargetChange);
          eventBus.off(Events.TARGET_CLEARED, onTargetChange);
          // Preserve an active reel-in freeze — don't clobber its aimHold.
          if (this._player) this._player.aimHold = this._attitudeHold;
        },
        resolve, reject,
      };
    });
  }

  /** @private Resolve the active aim coroutine (fire may proceed). */
  _resolveAim(launchDir) {
    const c = this._aimCoroutine;
    if (!c) return;
    this._aimCoroutine = null;
    c._cleanup();
    eventBus.emit(Events.AIM_SEQUENCE_END, { mode: c.mode, result: 'resolved' });
    c.resolve({ mode: c.mode, launchDir });
  }

  /** @private Reject the active aim coroutine (nothing fired/spent). */
  _rejectAim(reason) {
    const c = this._aimCoroutine;
    if (!c) return;
    this._aimCoroutine = null;
    c._cleanup();
    eventBus.emit(Events.AIM_SEQUENCE_END, { mode: c.mode, result: 'rejected', reason });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Launch aborted — ${reason}.`, priority: 'warning', source: 'HOUSTON',
    });
    c.reject(new Error(reason));
  }

  /**
   * Tick the aim coroutine. Called each frame from update() regardless of
   * autopilot engagement. Drives attitude (and daughter α) toward the target
   * and resolves with the ACTUAL launcher direction at convergence.
   * @param {number} dt — frame time in seconds
   * @private
   */
  _tickAimCoroutine(dt) {
    const c = this._aimCoroutine;
    if (!c || !this._player) return;

    c.elapsed += dt;
    if (c.elapsed >= c.timeout) { this._rejectAim('attitude not held (timeout)'); return; }

    // Current world aim direction (recomputed per tick — tracks moving target).
    const raw = c.provider();
    if (!raw) { this._rejectAim('target lost'); return; }
    const T = this._aimTargetDir.set(raw.x, raw.y, raw.z);
    if (T.lengthSq() < 1e-12) return; // degenerate this frame; wait
    T.normalize();

    const q = this._player.quaternion;

    // Resolve the boresight (launcher axis) in LOCAL frame.
    // net      → ship +Z.
    // daughter → physical strut fire dir (sinα·cos az, sinα·sin az, −cosα).
    let boresightLocalX = 0, boresightLocalY = 0, boresightLocalZ = 1;
    if (c.mode === 'daughter') {
      // Resolve azimuth from dock geometry once.
      if (c.azRad == null && c.armManager && c.armManager._dockPositions && c.pairIndex != null) {
        const dp = c.armManager._dockPositions[c.pairIndex];
        c.azRad = dp ? (dp.azimuthDeg * Math.PI / 180) : 0;
      }
      const az = c.azRad || 0;

      // Slew α toward the in-plane solution (transform target into local frame).
      this._aimInvQuat.copy(q).invert();
      const tl = this._aimLocalDir.copy(T).applyQuaternion(this._aimInvQuat);
      const radialComp = tl.x * Math.cos(az) + tl.y * Math.sin(az);
      let alphaDesired = Math.atan2(radialComp, -tl.z);
      alphaDesired = Math.max(0, Math.min(Math.PI, alphaDesired));

      let alpha = alphaDesired;
      if (c.arm && typeof c.arm.setAimAlpha === 'function') {
        const ok = c.arm.setAimAlpha(alphaDesired, dt);
        if (ok === false) { this._rejectAim('hinge LOCKED — release the hinge brake [H]'); return; }
        if (typeof c.arm.getAimAlpha === 'function') alpha = c.arm.getAimAlpha();
      }
      // Shared SSOT strut-direction convention (ArmDockBasis.strutLocalDirection).
      strutLocalDirection(alpha, az, this._aimBoresightWorld);
      boresightLocalX = this._aimBoresightWorld.x;
      boresightLocalY = this._aimBoresightWorld.y;
      boresightLocalZ = this._aimBoresightWorld.z;
    }

    // Boresight in world frame.
    const b = this._aimBoresightWorld.set(boresightLocalX, boresightLocalY, boresightLocalZ)
      .applyQuaternion(q).normalize();

    const dot = Math.max(-1, Math.min(1, b.dot(T)));
    const errAngle = Math.acos(dot);

    // Converged? Resolve with the ACTUAL current launcher direction.
    if (errAngle <= c.tolRad) {
      this._resolveAim({ x: b.x, y: b.y, z: b.z });
      return;
    }

    // Minimal-arc rotation that maps the current boresight onto the target.
    this._aimDeltaQuat.setFromUnitVectors(b, T);
    this._aimTargetQuat.copy(this._aimDeltaQuat).multiply(q);

    // Slerp toward it, capped at the autopilot slew rate.
    const maxStep = c.rate * dt;
    const alphaSlerp = Math.min(maxStep / errAngle, 1.0);
    q.slerp(this._aimTargetQuat, alphaSlerp);
    q.normalize();

    // Plumes + N₂ draw via the manual RCS path (feel only). Decompose the error
    // rotation axis into local pitch (X) / yaw (Y) components to pick nozzles.
    this._aimErrAxis.crossVectors(b, T);
    if (this._aimErrAxis.lengthSq() > 1e-12) {
      this._aimInvQuat.copy(q).invert();
      const axLocal = this._aimErrAxis.applyQuaternion(this._aimInvQuat).normalize();
      const mag = Math.min(1, errAngle / (10 * Math.PI / 180));
      const pitchSign = axLocal.x >= 0 ? 1 : -1;
      const yawSign = axLocal.y >= 0 ? 1 : -1;
      const pMag = Math.abs(axLocal.x) * mag;
      const yMag = Math.abs(axLocal.y) * mag;
      if (pMag > 0.02) {
        this._player.setThrusterFire('pitch', pitchSign, pMag);
        this._player.fireRcsRotation('pitch', pitchSign, pMag, dt);
      }
      if (yMag > 0.02) {
        this._player.setThrusterFire('yaw', yawSign, yMag);
        this._player.fireRcsRotation('yaw', yawSign, yMag, dt);
      }
    }
  }
}
