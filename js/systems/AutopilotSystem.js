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
import { orbitToSceneCartesian } from '../entities/OrbitalMechanics.js';
import { decomposeAimTarget } from './AimDecomposition.js';

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

    /** @type {number} Timer for throttling debris scan */
    this._debrisScanTimer = 0;
    /** @type {{ pos: THREE.Vector3, orbit: object, id: (number|string|null) }|null} */
    this._cachedDebrisResult = null;

    /** @type {boolean} True while a trawl sweep is active — blocks autopilot engage */
    this._trawlActive = false;

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

    /** @type {number} Cumulative ΔV spent on station-keeping recoil compensation (m/s) */
    this._stationKeepDeltaV = 0;

    /** @type {object|null} C-11: Active aim coroutine state (Phase 1-2-3 sequencing) */
    this._aimCoroutine = null;

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
    if (this._trawlActive) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: '⚠ AUTOPILOT DENIED — trawl sweep in progress',
        priority: 'warning',
      });
      return;
    }

    const dv = this._getRemainingDeltaV();
    if (dv < ENGAGE_DV_MIN) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `⚠ AUTOPILOT DENIED — ΔV ${Math.round(dv)} m/s below ${ENGAGE_DV_MIN} m/s safety limit`,
        priority: 'warning',
      });
      return;
    }

    const hasSelectedTarget = this._targetSelector && this._targetSelector.getActiveTarget();
    if (!hasSelectedTarget) {
      // AUTOPILOT_ANALYSIS.md §D.5 #1: refuse to engage without a selected target.
      // Skills system listens for AUTOPILOT_NO_TARGET as a discovery signal
      // (Constants.js:1006 nav_autopilot_no_target).
      eventBus.emit(Events.AUTOPILOT_NO_TARGET);
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: '⚠ AUTOPILOT DENIED — no target selected',
        priority: 'warning',
      });
      return;
    }

    const heading = this._determineHeading();
    if (!heading) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'AUTOPILOT: No valid heading — using prograde',
        priority: 'info',
      });
    }

    this._engaged = true;
    if (this._player) {
      this._player.autopilotEngaged = true;
      this._player._manualRotation.set(0, 0, 0, 1);
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
      text: `AUTOPILOT ENGAGED — ${this._headingMode}`,
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
      this._player._manualRotation.set(0, 0, 0, 1);
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
      text: `AUTOPILOT ENGAGED — CLUSTER: ${cluster.name || cluster.id}`,
      priority: 'info',
    });
  }

  /**
   * Disengage autopilot with a reason tag.
   * @param {string} reason — 'MANUAL'|'DELTAV'|'ARRIVED'|'COLLISION'|'ARROW_INPUT'|'TRAWL'|'TARGET_LOST'
   */
  disengage(reason) {
    if (!this._engaged) return;

    // [DBG-AP-DISENGAGE] Capture the exact reason + system state when the
    // mothership AP shuts itself off. Helps distinguish ARRIVED (HOLD timer),
    // DELTAV, TARGET_LOST, COLLISION, TRAWL, ARROW_INPUT, MANUAL.
    // Routed through console.warn (visible in default DevTools filter).
    try {
      const dv = this._getRemainingDeltaV();
      const armStates = this._armManager?.arms?.map(a => `${a.id}:${a.state}`)?.join(',') || '(none)';
      let posErrM = null;
      if (this._goalPos && this._player?.getPosition) {
        const pm = this._player.getPosition();
        const dx = this._goalPos.x - pm.x;
        const dy = this._goalPos.y - pm.y;
        const dz = this._goalPos.z - pm.z;
        posErrM = Math.sqrt(dx * dx + dy * dy + dz * dz) / M;
      }
      const tgtAlive = this._lockedTargetRef ? !!this._lockedTargetRef.alive : 'noLock';
      const tgtId = this._lockedTargetRef?.id ?? '?';
      console.warn('[DBG-AP-DISENGAGE]',
        'reason=', reason,
        'phase=', this._phase,
        'holdTimer=', this._holdTimer.toFixed(3),
        'HOLD_DURATION=', Constants.AUTOPILOT.HOLD_DURATION,
        'dv=', dv.toFixed(1),
        'posErrM=', posErrM === null ? 'n/a' : posErrM.toFixed(1),
        'tgtId=', tgtId,
        'tgtAlive=', tgtAlive,
        'arms=[', armStates, ']');
    } catch (e) {
      // Never let logging crash disengage
      console.warn('[DBG-AP-DISENGAGE] (log failed)', e?.message);
    }

    this._engaged = false;
    this._lockedTargetRef = null;
    this._debrisMapCluster = null;
    this._goalPos = null;
    this._holdTimer = 0;
    this._stationKeepDeltaV = 0;

    // Release any active target lock
    this._releaseTargetLock();

    if (this._player) {
      this._player.autopilotEngaged = false;
      this._player._manualRotation.set(0, 0, 0, 1);
    }
    this._headingTarget = null;
    this._headingMode = 'NONE';
    this._setPhase(PHASE.OFF);

    eventBus.emit(Events.AUTOPILOT_DISENGAGE, { reason });
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `AUTOPILOT OFF — ${reason}`,
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
    this._goalPos = Pm_goal.clone();
    this._headingTarget = Pd.clone(); // keep legacy HUD field populated

    // --- Errors ---
    const Pm = this._player.getPosition();                 // scene units
    const pvel = this._player.getVelocity();               // km/s
    const Vm = this._tmpV3.set(pvel.x, pvel.y, pvel.z);    // km/s

    // relP = Pm_goal − Pm (scene units)
    const relP = new THREE.Vector3().subVectors(Pm_goal, Pm);
    // relV = Vd − Vm (km/s)
    const relV = new THREE.Vector3().subVectors(Vd, Vm);

    const posErrM = relP.length() / M;                     // metres
    const velErrMps = relV.length() * 1000;                // m/s

    // Angle error: ship nose (+Z local) vs. v̂_d
    const noseWorld = new THREE.Vector3(0, 0, 1).applyQuaternion(this._player.quaternion);
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
    const goalDir = new THREE.Vector3();
    if (relP.lengthSq() > 1e-20) goalDir.copy(relP).normalize();
    // relV in m/s (relV is Vd − Vm in km/s → ×1000)
    const relV_mps = relV.clone().multiplyScalar(1000);
    // Velocity-control error: v*·goalDir + relV_mps. This is the impulse
    // direction that drives the player toward the desired closing profile.
    const velCtrlErr = goalDir.clone().multiplyScalar(vStar).add(relV_mps);

    const dvCmd = new THREE.Vector3(0, 0, 0);

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

          // [DBG-AP-HOLD] Snapshot at HOLD entry — capture position, orbit, target, arm state
          {
            const posPreSnap = this._player?.getPosition?.()?.toArray?.() || '?';
            const debrisAlive = this._debrisField?.debrisList?.filter(d => d.alive)?.length ?? '?';
            const targetId = this._lockedTargetRef?.id ?? this._targetSelector?.getActiveTarget?.()?.id ?? '?';
            const armStates = this._armManager?.arms?.map(a => `${a.id}:${a.state}`) || [];
            console.error('[DBG-AP-HOLD] entering HOLD',
              'posPreSnap=', posPreSnap,
              'debrisAlive=', debrisAlive,
              'targetId=', targetId,
              'armStates=', armStates.join(','),
              'posErrM=', posErrM.toFixed(1),
              'velErrMps=', velErrMps.toFixed(3));
          }

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

            // [DBG-AP-HOLD] Verify snap didn't teleport
            if (typeof console !== 'undefined') {
              const postSnap = orbitToSceneCartesian(pOrb);
              const dx = postSnap.position.x - preSnap.position.x;
              const dy = postSnap.position.y - preSnap.position.y;
              const dz = postSnap.position.z - preSnap.position.z;
              const jumpKm = Math.sqrt(dx * dx + dy * dy + dz * dz) / Constants.SCENE_SCALE;
              console.log('[DBG-AP-HOLD] orbit snap: jumpKm=', jumpKm.toFixed(3),
                'newTA=', newTA.toFixed(4));
            }

            // Zero RCS residual so the additive position offset in
            // PlayerSatellite.update() doesn't shift mother away from the
            // orbit-derived position and trigger spurious dead-band corrections.
            if (this._player._rcsVelocity) {
              this._player._rcsVelocity.set(0, 0, 0);
            }
          }

          eventBus.emit(Events.AUTOPILOT_ARRIVED, { mode: this._headingMode });
          eventBus.emit(Events.COMMS_MESSAGE, {
            text: '✓ ON STATION — ready for capture',
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
        if (this._lockedTargetRef && this._lockedTargetRef.orbit && this._player) {
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
        // The orbit sync above will reset SMA/ecc/etc. next frame, so the
        // net lasting effect of the impulse is only on trueAnomaly —
        // effectively repositioning the mother along the orbit (pure
        // along-track station-keeping).
        if (posErrM > POS_TOL || velErrMps > VEL_TOL) {
          dvCmd.addScaledVector(relV_mps, AP.KP_VEL * 0.5);
        }

        // Hysteresis — only drop back to TRAIL_ALIGN on large excursions
        // (e.g. sync failed, target lost). 4× tolerance prevents
        // HOLD↔TRAIL cycling on every minor perturbation.
        if (posErrM > 4 * POS_TOL || velErrMps > 4 * VEL_TOL) {
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
          const armsActive = this._armManager && this._armManager.arms &&
            this._armManager.arms.some(a =>
              a.state === Constants.ARM_STATES.LAUNCHING ||
              a.state === Constants.ARM_STATES.TRANSIT ||
              a.state === Constants.ARM_STATES.APPROACH ||
              a.state === Constants.ARM_STATES.STATION_KEEP
            );
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
        // [DBG-AP-HOLD-STATUS] Throttled (~5s) mid-HOLD status to confirm
        // whether HOLD is still actively syncing during a long SK session.
        // Reports posErrM (how far mother is from her trail goal), lockedRef
        // identity & alive, and arm states.  Crucial for diagnosing the
        // mother-debris drift bug: if mother drifts away from debris during
        // SK and posErrM stays small, then her HOLD target is NOT the
        // debris the daughter is SK'ing on.  If posErrM grows, HOLD is
        // losing the sync.  If this line never fires, autopilot disengaged.
        this._dbgHoldStatusAccum = (this._dbgHoldStatusAccum || 0) + dt;
        if (this._dbgHoldStatusAccum >= 5.0) {
          this._dbgHoldStatusAccum = 0;
          const lt = this._lockedTargetRef;
          const armStates = this._armManager?.arms?.filter(a =>
            a.state !== Constants.ARM_STATES.DOCKED &&
            a.state !== Constants.ARM_STATES.RELOADING
          )?.map(a => `${a.id}:${a.state}${a.target ? '(tgt='+a.target.id+')' : ''}`)?.join(',') || '(none)';
          console.log(
            `[DBG-AP-HOLD-STATUS] phase=${this._phase} ` +
            `posErrM=${posErrM.toFixed(1)} velErrMps=${velErrMps.toFixed(3)} ` +
            `lockedId=${lt?.id ?? 'null'} lockedAlive=${lt ? (lt.alive !== false) : 'n/a'} ` +
            `Dtrail=${Dtrail_m}m ` +
            `holdTimer=${this._holdTimer.toFixed(2)}s ` +
            `arms=[${armStates}]`
          );
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
    this._rotateTowardWorld(vHat, dt);
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
      const cart = orbitToSceneCartesian(this._lockedTargetRef.orbit);
      if (cart && cart.position && cart.velocity) {
        return {
          Pd: new THREE.Vector3(cart.position.x, cart.position.y, cart.position.z),
          Vd: new THREE.Vector3(cart.velocity.x, cart.velocity.y, cart.velocity.z),
          mode: 'TARGET',
        };
      }
    }

    // Non-locked heading — re-evaluate priority chain ------------------------
    this._debrisScanTimer += dt;
    const heading = this._determineHeading();
    if (!heading || !heading.position) return null;

    let Vd = null;

    if (heading.mode === 'TARGET' && this._targetSelector) {
      const t = this._targetSelector.getActiveTarget();
      if (t && t.orbit) {
        const cart = orbitToSceneCartesian(t.orbit);
        if (cart && cart.velocity) {
          Vd = new THREE.Vector3(cart.velocity.x, cart.velocity.y, cart.velocity.z);
        }
      }
    } else if (heading.mode === 'TRAWL' &&
               this._trawlManager && this._trawlManager.activeCluster) {
      // Trawl clusters rarely expose a composite velocity; fall back to player prograde
      // below. This keeps the trailing vector tangent to the player's own orbit which
      // is a reasonable approximation when the cluster drifts with the mother.
    } else if (heading.mode === 'DEBRIS' &&
               this._cachedDebrisResult && this._cachedDebrisResult.orbit) {
      const cart = orbitToSceneCartesian(this._cachedDebrisResult.orbit);
      if (cart && cart.velocity) {
        Vd = new THREE.Vector3(cart.velocity.x, cart.velocity.y, cart.velocity.z);
      }
    } else if (heading.mode === 'PROGRADE') {
      return null; // prograde coast — no rendezvous geometry
    }

    if (!Vd) {
      // Fallback: use player's own velocity direction
      const pv = this._player.getVelocity();
      Vd = new THREE.Vector3(pv.x, pv.y, pv.z);
    }

    return { Pd: heading.position, Vd, mode: heading.mode };
  }

  /** @private Prograde fallback: face velocity, no thrust. */
  _updateProgradeOnly(dt) {
    const pv = this._player.getVelocity();
    const dir = new THREE.Vector3(pv.x, pv.y, pv.z);
    if (dir.lengthSq() > 1e-20) {
      dir.normalize();
      this._rotateTowardWorld(dir, dt);
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
   * Scan debrisList for the nearest alive debris with mass ≥ LARGE_DEBRIS_MASS.
   * @returns {{ pos: THREE.Vector3, orbit: object, id: (number|string|null) }|null}
   * @private
   */
  _findNearestLargeDebris() {
    if (!this._debrisField || !this._debrisField.debrisList) return null;
    const playerPos = this._player.getPosition();
    let bestDist = Infinity;
    let bestResult = null;

    for (const d of this._debrisField.debrisList) {
      if (!d.alive) continue;
      if ((d.mass || 0) < LARGE_DEBRIS_MASS) continue;
      const cart = orbitToSceneCartesian(d.orbit);
      if (!cart || !cart.position) continue;
      const pos = new THREE.Vector3(cart.position.x, cart.position.y, cart.position.z);
      const dist = playerPos.distanceTo(pos);
      if (dist < bestDist) {
        bestDist = dist;
        bestResult = { pos, orbit: d.orbit, id: d.id != null ? d.id : null };
      }
    }
    return bestResult;
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
    const pos = this._player.getPosition();
    const radial = pos.clone().normalize();

    // lookAt: eye=pos+dir, target=pos → +Z = worldDir (model +Z = forward).
    const mat = new THREE.Matrix4();
    const lookEye = pos.clone().add(worldDir);
    mat.lookAt(lookEye, pos, radial);
    const targetQuat = new THREE.Quaternion().setFromRotationMatrix(mat);

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
  requestAimRotation(targetDir, armManager) {
    // Feature flag gate
    if (!Constants.FEATURE_FLAGS.SEMI_AUTO_AIM) {
      return Promise.reject(new Error(
        'SEMI_AUTO_AIM feature flag is disabled. Enable Constants.FEATURE_FLAGS.SEMI_AUTO_AIM to use autopilot aim rotation.'
      ));
    }

    if (!this._player || !armManager) {
      return Promise.reject(new Error('AutopilotSystem not initialized or armManager not provided'));
    }

    // Cancel any existing aim coroutine
    if (this._aimCoroutine) {
      this._aimCoroutine.reject(new Error('Superseded by new aim request'));
      this._aimCoroutine = null;
    }

    const dockPositions = armManager._dockPositions;
    const dir = { x: targetDir.x, y: targetDir.y, z: targetDir.z };

    // Decompose target into pair + rotation + alpha
    const { pairIndex, motherRotationRad, strutAlpha } = decomposeAimTarget(dir, dockPositions);

    return new Promise((resolve, reject) => {
      const TOLERANCE_RAD = 1 * Math.PI / 180; // 1° tolerance
      const TIMEOUT_S = 30;
      const SETTLE_DURATION = 0.5; // seconds of stability required

      // Cancel on manual input
      const cancelHandler = () => {
        if (this._aimCoroutine) {
          const rej = this._aimCoroutine.reject;
          this._aimCoroutine = null;
          eventBus.off(Events.ARM_MANUAL_THRUST, cancelHandler);
          rej(new Error('Aim rotation cancelled by manual input'));
        }
      };
      eventBus.on(Events.ARM_MANUAL_THRUST, cancelHandler);

      // Houston comms
      const estTime = Math.abs(motherRotationRad) / AP_ROT_RATE;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `Rotating to firing attitude — ${Math.ceil(estTime)} seconds.`,
        priority: 'info',
        source: 'HOUSTON',
      });

      // C-11: Store coroutine state — ticked by _tickAimCoroutine(dt) in update()
      this._aimCoroutine = {
        phase: 1,                    // 1=RCS rotate, 2=strut slew, 3=settle
        pairIndex,
        motherRotationRemaining: motherRotationRad,
        strutAlpha,
        armManager,
        elapsed: 0,
        timeout: TIMEOUT_S,
        tolerance: TOLERANCE_RAD,
        settleDuration: SETTLE_DURATION,
        settleTimer: 0,
        cancelHandler,
        resolve: (val) => {
          eventBus.off(Events.ARM_MANUAL_THRUST, cancelHandler);
          resolve(val);
        },
        reject: (err) => {
          eventBus.off(Events.ARM_MANUAL_THRUST, cancelHandler);
          reject(err);
        },
      };
    });
  }

  /**
   * C-11: Tick the aim coroutine through Phase 1 → 2 → 3.
   * Called each frame from update(), regardless of autopilot engagement.
   *
   * Phase 1 — RCS rotate Mother toward target meridian plane (at AP_ROT_RATE).
   * Phase 2 — Slew both arms in chosen pair to target α (via setAimAlpha).
   * Phase 3 — Settle: hold within ±1° for SETTLE_DURATION, then resolve.
   *
   * @param {number} dt — frame time in seconds
   * @private
   */
  _tickAimCoroutine(dt) {
    const c = this._aimCoroutine;
    if (!c) return;

    c.elapsed += dt;
    if (c.elapsed >= c.timeout) {
      const rej = c.reject;
      this._aimCoroutine = null;
      rej(new Error('Aim coroutine timeout'));
      return;
    }

    const partnerIndex = c.armManager.getDualFirePair(c.pairIndex);
    const arm1 = c.armManager.arms[c.pairIndex];
    const arm2 = partnerIndex !== null ? c.armManager.arms[partnerIndex] : null;

    switch (c.phase) {
      case 1: {
        // Phase 1: Simulate RCS rotation toward target
        const rotDelta = AP_ROT_RATE * dt;
        if (Math.abs(c.motherRotationRemaining) <= rotDelta) {
          c.motherRotationRemaining = 0;
          c.phase = 2; // Advance to strut slew
        } else {
          c.motherRotationRemaining -= Math.sign(c.motherRotationRemaining) * rotDelta;
        }
        break;
      }

      case 2: {
        // Phase 2: Slew both struts to target α
        if (arm1 && typeof arm1.setAimAlpha === 'function') arm1.setAimAlpha(c.strutAlpha, dt);
        if (arm2 && typeof arm2.setAimAlpha === 'function') arm2.setAimAlpha(c.strutAlpha, dt);

        const alpha1 = arm1 && typeof arm1.getAimAlpha === 'function' ? arm1.getAimAlpha() : c.strutAlpha;
        const alpha2 = arm2 && typeof arm2.getAimAlpha === 'function' ? arm2.getAimAlpha() : c.strutAlpha;

        const close1 = Math.abs(alpha1 - c.strutAlpha) < c.tolerance;
        const close2 = Math.abs(alpha2 - c.strutAlpha) < c.tolerance;

        if (close1 && close2) {
          c.phase = 3;        // Advance to settle
          c.settleTimer = 0;
        }
        break;
      }

      case 3: {
        // Phase 3: Verify both arms hold within tolerance
        const alpha1 = arm1 && typeof arm1.getAimAlpha === 'function' ? arm1.getAimAlpha() : c.strutAlpha;
        const alpha2 = arm2 && typeof arm2.getAimAlpha === 'function' ? arm2.getAimAlpha() : c.strutAlpha;

        const close1 = Math.abs(alpha1 - c.strutAlpha) < c.tolerance;
        const close2 = Math.abs(alpha2 - c.strutAlpha) < c.tolerance;

        if (!close1 || !close2) {
          // Went out of tolerance — back to Phase 2
          c.phase = 2;
          c.settleTimer = 0;
          break;
        }

        c.settleTimer += dt;
        if (c.settleTimer >= c.settleDuration) {
          // Settled — resolve the promise
          const res = c.resolve;
          this._aimCoroutine = null;
          res({ pairIndex: c.pairIndex, alpha: c.strutAlpha });
        }
        break;
      }
    }
  }
}
