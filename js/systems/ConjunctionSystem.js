/**
 * ConjunctionSystem.js — Predicts debris-to-player conjunctions (near-misses)
 * Generates 3-tier warnings (GREEN/YELLOW/RED) that force evasive manoeuvres.
 * Creates semi-random interruptions that cost ΔV to dodge, deepening resource tension.
 *
 * Design constraints (from game design doc):
 *  - ~2 alerts per mission (matches real ISS conjunction rate)
 *  - Never during ARM PILOT mode (too disruptive to fine motor control)
 *  - Random timing prevents predictability
 *  - Forces ΔV spend → deepens resource tension
 *  - Evasion vector teaches collision avoidance concepts
 *
 * @module systems/ConjunctionSystem
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { orbitToSceneCartesian, cartesianToKeplerian } from '../entities/OrbitalMechanics.js';

// ST-6.3: Graceful MOID import — back-compat if MoidCalculator unavailable (§C.6)
let _computeMOID = null;
let _classifyMOID = null;
import('./MoidCalculator.js').then(mod => {
  _computeMOID = mod.computeMOID;
  _classifyMOID = mod.classifyMOID;
}).catch(() => {
  console.warn('[ConjunctionSystem] MoidCalculator unavailable — MOID features disabled');
});

// ============================================================================
// CONSTANTS
// ============================================================================

/** 1 metre in scene units (1 scene unit ≈ 100 km) */
const M = 0.00001;

/** Velocity conversion: km/s → scene-units/s  (orbitToSceneCartesian returns km/s) */
const KM_TO_SCENE = M * 1000; // 0.01

/** Threat classification thresholds (metres) */
const THRESHOLD_RED_M    = 200;
const THRESHOLD_YELLOW_M = 500;
const THRESHOLD_GREEN_M  = 5000; // extended from 1000m for reliable alert generation

/** Thresholds in scene units */
const THRESHOLD_RED    = THRESHOLD_RED_M    * M;  // 0.002
const THRESHOLD_YELLOW = THRESHOLD_YELLOW_M * M;  // 0.005
const THRESHOLD_GREEN  = THRESHOLD_GREEN_M  * M;  // 0.05

/** Pre-filter scan radius (scene units ≈ 50 km) */
const SCAN_RADIUS    = 0.5;
const SCAN_RADIUS_SQ = SCAN_RADIUS * SCAN_RADIUS;

/** Linear propagation look-ahead (seconds — matches orbital velocity timescale) */
const LOOK_AHEAD_S = 60;

/** Random interval between conjunction checks (real seconds) */
const CHECK_MIN_S = 30;
const CHECK_MAX_S = 120;

/** Maximum alerts per mission (avoids annoyance while matching ISS rate) */
const MAX_ALERTS = 3;

/** Alert tier enum */
const TIER = Object.freeze({ GREEN: 'GREEN', YELLOW: 'YELLOW', RED: 'RED' });

// ============================================================================
// CONJUNCTION SYSTEM
// ============================================================================

export class ConjunctionSystem {
  constructor() {
    /** @private Accumulated real-time since last check */
    this._checkTimer = 0;

    /** @private Next check fires when _checkTimer reaches this value */
    this._nextCheckAt = this._randomInterval();

    /** @private Number of alerts emitted this mission */
    this._alertCount = 0;

    /** @private Current active threat data (or null) */
    this._currentThreat = null;

    /** @private Whether an alert overlay is currently active */
    this._alertActive = false;

    /** @private Remaining display time for current alert (seconds) */
    this._alertTimer = 0;

    // ST-2.1: Capture-count gating — no alerts before first capture + elapsed time
    this._captureCount = 0;
    this._missionElapsed = 0;
    this._firstCaptureTime = null;
    this._firstAlertFired = false;
    this._primerSent = false;
    this._primerTimer = 0;
    this._pendingFirstAlert = null;

    // ST-6.3: MOID cache and badge state
    /** @type {Map<number|string, number>} debris id → MOID in metres */
    this._moidCache = new Map();
    /** @type {Map<number|string, string|null>} debris id → current badge tier */
    this._moidBadges = new Map();
    /** @private MOID recompute accumulator (game seconds) */
    this._moidTimer = 0;
    /** @private Last player velocity magnitude (km/s) for delta-v detection */
    this._lastPlayerVelMag = 0;

    eventBus.on(Events.ARM_CAPTURED, () => { this._onCapture(); });
    eventBus.on(Events.LASSO_CAPTURED, () => { this._onCapture(); });

    // ST-4.C: Mission profile gate — additional suppression from mission profiles
    this._conjunctionAllowed = false;
    eventBus.on(Events.MISSION_START, (d) => {
      this._conjunctionAllowed = d.profile.conjunction;
    });

    // ST-4.C: Self-reset on GAME_RESET (ConjunctionSystem is a singleton)
    eventBus.on(Events.GAME_RESET, () => this.reset());

    console.log(
      '[ConjunctionSystem] Initialized — first check in',
      Math.round(this._nextCheckAt), 's',
    );
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Main per-frame update.  Call from the game loop during active gameplay.
   *
   * @param {number}  dt          — Real-time delta (seconds)
   * @param {object}  gameState   — GameState singleton
   * @param {Array}   debrisList  — DebrisField.debrisList (flat array)
   * @param {THREE.Vector3} playerPos — Player scene position
   * @param {{x:number,y:number,z:number}} playerVel — Player velocity (scene units/s)
   * @param {boolean} isArmPilot  — True when ARM_PILOT camera mode is active
   */
  update(dt, gameState, debrisList, playerPos, playerVel, isArmPilot) {
    // Tick down active alert display timer
    if (this._alertActive) {
      this._alertTimer -= dt;
      if (this._alertTimer <= 0) {
        this._clearAlert();
      }
    }

    // Only scan during active gameplay states
    if (!gameState.isGameplay()) return;

    // ST-2.1: Track mission elapsed time
    this._missionElapsed += dt;

    // ST-2.1: Tick primer countdown → fire delayed first alert
    if (this._primerTimer > 0) {
      this._primerTimer -= dt;
      if (this._primerTimer <= 0 && this._pendingFirstAlert) {
        const p = this._pendingFirstAlert;
        this._pendingFirstAlert = null;
        this._doEmitAlert(p.tier, p.debris, p.tca, p.distScene, p.evasionVector);
      }
    }

    // Advance randomised check timer
    this._checkTimer += dt;
    if (this._checkTimer < this._nextCheckAt) return;

    // Timer fired — reset and schedule next
    this._checkTimer = 0;
    this._nextCheckAt = this._randomInterval();

    // Enforce per-mission alert cap
    if (this._alertCount >= MAX_ALERTS) return;

    // Suppress during ARM_PILOT — fine motor control must not be disrupted
    if (isArmPilot) return;

    // Guard against missing data
    if (!debrisList || !playerPos || !playerVel) return;

    // --- Scan for conjunctions ---
    const threat = this._scanForConjunctions(debrisList, playerPos, playerVel);
    if (!threat) return;

    // Generate evasion recommendation
    const evasionVector = this._generateEvasionVector(
      threat.threatDir, playerPos,
    );

    // Emit alert event
    this._emitAlert(threat.tier, threat.debris, threat.tca,
      threat.minDistScene, evasionVector);
  }

  /**
   * ST-6.3: Separate MOID update — call from the game loop alongside update().
   * Decoupled from the stochastic proximity scan so it runs on a fixed cadence.
   * @param {number}  dt          — Real-time delta (seconds)
   * @param {Array}   debrisList  — DebrisField.debrisList
   * @param {THREE.Vector3} playerPos — Player scene position
   * @param {{x,y,z}} playerVel — Player velocity (km/s)
   */
  updateMOID(dt, debrisList, playerPos, playerVel) {
    if (!_computeMOID || !_classifyMOID) return; // MOID calculator not available
    if (!debrisList || !playerPos || !playerVel) return;

    const C = Constants.CONJUNCTION;
    // Gotcha #4: MOID_RECOMPUTE_INTERVAL_S is in game seconds, dt is wall seconds
    this._moidTimer += dt * Constants.TIME_SCALE_GAMEPLAY;

    // Detect significant velocity change (>10 m/s) → force early recompute
    const velMag = Math.sqrt(
      playerVel.x * playerVel.x + playerVel.y * playerVel.y + playerVel.z * playerVel.z,
    );
    const dvMs = Math.abs(velMag - this._lastPlayerVelMag) * 1000; // km/s → m/s
    if (dvMs > 10) {
      this._moidTimer = C.MOID_RECOMPUTE_INTERVAL_S; // force immediate recompute
    }

    if (this._moidTimer < C.MOID_RECOMPUTE_INTERVAL_S) return;
    this._moidTimer = 0;
    this._lastPlayerVelMag = velMag;

    // Derive player Keplerian orbit from position/velocity
    const S = Constants.SCENE_SCALE;
    const posKm = { x: playerPos.x / S, y: playerPos.y / S, z: playerPos.z / S };
    const playerOrbit = cartesianToKeplerian(posKm, playerVel);
    if (!playerOrbit || !isFinite(playerOrbit.semiMajorAxis) || playerOrbit.semiMajorAxis <= 0) return;

    // Convert player orbit semiMajorAxis from km to metres for the _m API
    const playerMoidOrbit = {
      semiMajorAxis_m: playerOrbit.semiMajorAxis * 1000,
      eccentricity:    playerOrbit.eccentricity,
      inclination:     playerOrbit.inclination,
      raan:            playerOrbit.raan,
      argPerigee:      playerOrbit.argPerigee,
    };

    // Compute MOID for each debris object
    for (let i = 0, len = debrisList.length; i < len; i++) {
      const debris = debrisList[i];
      if (!debris.alive || !debris.orbit) continue;

      const moid = _computeMOID(playerMoidOrbit, debris.orbit);
      this._moidCache.set(debris.id, moid);

      const badge = _classifyMOID(moid);
      const newBadge = badge === 'SAFE' ? null : badge;
      const oldBadge = this._moidBadges.get(debris.id) || null;

      // Stamp badge onto the debris object for UI consumption
      debris.moidBadge = newBadge;
      debris.moid_m = moid;

      // De-bounce: emit CONJUNCTION_ALERT only on UPWARD tier transitions
      if (this._isUpwardTransition(oldBadge, newBadge)) {
        this._emitMoidAlert(debris, moid, newBadge);
      }

      this._moidBadges.set(debris.id, newBadge);
    }
  }

  /** Reset all state for a new mission. */
  reset() {
    this._checkTimer = 0;
    this._nextCheckAt = this._randomInterval();
    this._alertCount = 0;
    this._currentThreat = null;
    this._alertActive = false;
    this._alertTimer = 0;
    // ST-2.1: Reset gating state
    this._captureCount = 0;
    this._missionElapsed = 0;
    this._firstCaptureTime = null;
    this._firstAlertFired = false;
    this._primerSent = false;
    this._primerTimer = 0;
    this._pendingFirstAlert = null;
    this._conjunctionAllowed = false;  // ST-4.C: reset mission profile gate
    // ST-6.3: Reset MOID state
    this._moidCache.clear();
    this._moidBadges.clear();
    this._moidTimer = 0;
    this._lastPlayerVelMag = 0;
  }

  /**
   * Current status snapshot (for HUD polling or debug overlay).
   * @returns {{ currentThreat: object|null, alertActive: boolean,
   *             alertCount: number, nextCheckIn: number }}
   */
  getStatus() {
    return {
      currentThreat: this._currentThreat,
      alertActive:   this._alertActive,
      alertCount:    this._alertCount,
      nextCheckIn:   Math.max(0, this._nextCheckAt - this._checkTimer),
    };
  }

  /**
   * ST-6.3: Return the top-N riskiest debris by MOID within the prefilter threshold.
   * Used by CollisionAvoidanceSystem for hot-loop pre-filtering.
   * @param {number} [n] — max items (defaults to Constants.CONJUNCTION.CA_TOP_N)
   * @returns {Array<{id: *, moid: number}>} sorted ascending by MOID
   */
  getTopRiskPairs(n) {
    const limit = n || Constants.CONJUNCTION.CA_TOP_N || 32;
    const threshold = Constants.CONJUNCTION.CA_MOID_PREFILTER_M || 150_000;
    const result = [];
    for (const [id, moid] of this._moidCache) {
      if (moid <= threshold) {
        result.push({ id, moid });
      }
    }
    result.sort((a, b) => a.moid - b.moid);
    return result.slice(0, limit);
  }

  // ==========================================================================
  // SCHEDULING
  // ==========================================================================

  /**
   * @private Random real-second interval for the next conjunction check.
   * @returns {number}
   */
  _randomInterval() {
    return CHECK_MIN_S + Math.random() * (CHECK_MAX_S - CHECK_MIN_S);
  }

  // ==========================================================================
  // SCANNING
  // ==========================================================================

  /**
   * Scan the full debris list for the single most threatening upcoming
   * conjunction within the look-ahead window.
   *
   * @private
   * @param {Array}  debrisList
   * @param {{x,y,z}} playerPos
   * @param {{x,y,z}} playerVel
   * @returns {object|null} Best threat { debris, tca, minDistScene, tier, threatDir }
   */
  _scanForConjunctions(debrisList, playerPos, playerVel) {
    let best = null;
    let bestDist = Infinity;

    for (let i = 0, len = debrisList.length; i < len; i++) {
      const debris = debrisList[i];
      if (!debris.alive) continue;

      // --- Fast pre-filter using cached scene position ---
      let dx, dy, dz;
      if (debris._scenePosition) {
        dx = debris._scenePosition.x - playerPos.x;
        dy = debris._scenePosition.y - playerPos.y;
        dz = debris._scenePosition.z - playerPos.z;
      } else {
        // Fallback: compute on the fly (first frame before update runs)
        const c = orbitToSceneCartesian(debris.orbit);
        dx = c.position.x - playerPos.x;
        dy = c.position.y - playerPos.y;
        dz = c.position.z - playerPos.z;
      }
      if (dx * dx + dy * dy + dz * dz > SCAN_RADIUS_SQ) continue;

      // --- Full cartesian state for velocity-based prediction ---
      const cart = orbitToSceneCartesian(debris.orbit);
      const prediction = this._predictClosestApproach(
        cart.position, cart.velocity, playerPos, playerVel,
      );
      if (!prediction) continue;

      // Only interested if approaching (TCA > 0) and within GREEN envelope
      if (prediction.tca <= 0 || prediction.minDist > THRESHOLD_GREEN) continue;

      if (prediction.minDist < bestDist) {
        bestDist = prediction.minDist;
        best = {
          debris,
          tca:          prediction.tca,
          minDistScene: prediction.minDist,
          tier:         this._classifyThreat(prediction.minDist),
          threatDir:    prediction.threatDir,
        };
      }
    }

    return best;
  }

  // ==========================================================================
  // CLOSEST APPROACH PREDICTION (simplified linear propagation)
  // ==========================================================================

  /**
   * Compute time-of-closest-approach (TCA) and miss distance using constant-
   * velocity (linear) extrapolation.  Analytically:
   *
   *   TCA = − (Δr · Δv) / (Δv · Δv)    clamped to [0, LOOK_AHEAD_S]
   *   miss = |Δr + Δv · TCA|
   *
   * @private
   * @param {{x,y,z}} dPos  — debris position  (scene units)
   * @param {{x,y,z}} dVel  — debris velocity   (scene units / s)
   * @param {{x,y,z}} pPos  — player position
   * @param {{x,y,z}} pVel  — player velocity
   * @returns {{ tca:number, minDist:number, threatDir:{x,y,z} } | null}
   */
  _predictClosestApproach(dPos, dVel, pPos, pVel) {
    // Relative position (scene units)
    const rpx = dPos.x - pPos.x;
    const rpy = dPos.y - pPos.y;
    const rpz = dPos.z - pPos.z;

    // Relative velocity — convert km/s → scene-units/s so TCA is in seconds
    // and miss distance comes out in scene units (matching thresholds).
    const rvx = (dVel.x - pVel.x) * KM_TO_SCENE;
    const rvy = (dVel.y - pVel.y) * KM_TO_SCENE;
    const rvz = (dVel.z - pVel.z) * KM_TO_SCENE;

    const rvDotRv = rvx * rvx + rvy * rvy + rvz * rvz;
    if (rvDotRv < 1e-24) return null; // negligible relative motion

    const rpDotRv = rpx * rvx + rpy * rvy + rpz * rvz;
    let tca = -rpDotRv / rvDotRv;
    tca = Math.max(0, Math.min(LOOK_AHEAD_S, tca));

    // Miss vector at TCA
    const cx = rpx + rvx * tca;
    const cy = rpy + rvy * tca;
    const cz = rpz + rvz * tca;
    const minDist = Math.sqrt(cx * cx + cy * cy + cz * cz);

    // Normalised threat approach direction (current relative position vector)
    const rLen = Math.sqrt(rpx * rpx + rpy * rpy + rpz * rpz);
    const threatDir = rLen > 1e-10
      ? { x: rpx / rLen, y: rpy / rLen, z: rpz / rLen }
      : { x: 1, y: 0, z: 0 };

    return { tca, minDist, threatDir };
  }

  // ==========================================================================
  // CLASSIFICATION
  // ==========================================================================

  /**
   * Classify threat tier from predicted miss distance.
   * @private
   * @param {number} minDistScene — miss distance in scene units
   * @returns {string} 'GREEN' | 'YELLOW' | 'RED'
   */
  _classifyThreat(minDistScene) {
    if (minDistScene < THRESHOLD_RED)    return TIER.RED;
    if (minDistScene < THRESHOLD_YELLOW) return TIER.YELLOW;
    return TIER.GREEN;
  }

  // ==========================================================================
  // EVASION VECTOR
  // ==========================================================================

  /**
   * Compute a recommended evasion direction perpendicular to the threat
   * approach vector, preferring the radial (anti-Earth) direction so the
   * manoeuvre stays in the orbital plane.
   *
   * @private
   * @param {{x,y,z}} threatDir  — normalised threat approach direction
   * @param {{x,y,z}} playerPos  — player scene position (for radial ref)
   * @returns {{x:number, y:number, z:number}} normalised evasion vector
   */
  _generateEvasionVector(threatDir, playerPos) {
    // Radial "up" — away from Earth centre
    const px = playerPos.x, py = playerPos.y, pz = playerPos.z;
    const pLen = Math.sqrt(px * px + py * py + pz * pz);
    const radial = pLen > 1e-10
      ? { x: px / pLen, y: py / pLen, z: pz / pLen }
      : { x: 0, y: 1, z: 0 };

    // Cross product: threat × radial → perpendicular in orbital plane
    let ex = threatDir.y * radial.z - threatDir.z * radial.y;
    let ey = threatDir.z * radial.x - threatDir.x * radial.z;
    let ez = threatDir.x * radial.y - threatDir.y * radial.x;
    const eLen = Math.sqrt(ex * ex + ey * ey + ez * ez);

    if (eLen > 1e-10) {
      return { x: ex / eLen, y: ey / eLen, z: ez / eLen };
    }

    // Degenerate case: threat is perfectly radial → evade prograde
    return { x: radial.z, y: 0, z: -radial.x };
  }

  // ==========================================================================
  // ALERT EMISSION
  // ==========================================================================

  /**
   * Handle a capture event (arm or lasso). ST-2.1.
   * @private
   */
  _onCapture() {
    this._captureCount++;
    if (this._firstCaptureTime === null) {
      this._firstCaptureTime = this._missionElapsed;
    }
  }

  /**
   * Gate and emit a CONJUNCTION_WARNING event.
   * Applies capture-count, elapsed-time, and first-alert GREEN gating (ST-2.1).
   * @private
   */
  _emitAlert(tier, debris, tca, distScene, evasionVector) {
    // ST-4.C: Mission profile gate — BOTH skill gate AND profile must pass
    if (!this._conjunctionAllowed) return;

    // ST-2.1: Capture-count + elapsed gating
    const C = Constants.CONJUNCTION;
    if (this._captureCount < C.MIN_CAPTURES) return;
    if (this._firstCaptureTime === null) return;
    if ((this._missionElapsed - this._firstCaptureTime) < C.MIN_ELAPSED_S) return;

    // ST-2.1: First-alert handling — force GREEN, queue comms primer
    if (!this._firstAlertFired) {
      tier = TIER.GREEN;

      if (!this._primerSent) {
        // Emit comms primer and delay first alert by PRIMER_LEAD_S
        this._primerSent = true;
        this._primerTimer = C.PRIMER_LEAD_S;
        this._pendingFirstAlert = { tier, debris, tca, distScene, evasionVector };

        eventBus.emit(Events.COMMS_MESSAGE, {
          source: 'HOUSTON',
          priority: 'INFO',
          text: 'CONJUNCTION TRACKING ONLINE<br>Orbital debris paths sometimes cross yours. Green = informational.<br>Check Tech Library [?] for details.',
        });
        return; // Don't emit alert yet — primer leads by 5s
      }

      // Primer already sent — waiting for timer to expire. Ignore additional scans.
      return;
    }

    this._doEmitAlert(tier, debris, tca, distScene, evasionVector);
  }

  /**
   * Perform the actual alert emission (no gating). ST-2.1 split from _emitAlert.
   * @private
   */
  _doEmitAlert(tier, debris, tca, distScene, evasionVector) {
    this._firstAlertFired = true;
    this._alertCount++;
    this._alertActive = true;

    const distMeters = Math.round(distScene / M);
    this._currentThreat = { tier, debrisId: debris.id, tca, distMeters };

    // Display duration by tier
    switch (tier) {
      case TIER.GREEN:  this._alertTimer = 5;  break;
      case TIER.YELLOW: this._alertTimer = 10; break;
      case TIER.RED:    this._alertTimer = 30; break;
      default:          this._alertTimer = 5;
    }

    eventBus.emit(Events.CONJUNCTION_WARNING, {
      tier,
      debrisId:     debris.id,
      debrisType:   debris.type,
      tca:          Math.round(tca),
      distance:     distMeters,
      evasionVector,
      alertNumber:  this._alertCount,
    });

    // UX-2 #2: Route conjunction alerts through comms panel
    eventBus.emit(Events.COMMS_MESSAGE, {
      source: '18th Space Defense Squadron',
      channel: 'ALERT',
      priority: tier === TIER.RED ? 'critical' : tier === TIER.YELLOW ? 'warning' : 'info',
      // CP-4: an imminent (RED) conjunction must reach the player at ANY suppression
      // tier — the explicit _critical tag bypasses the post-onboarding wake ramp.
      _critical: tier === TIER.RED,
      text: `CONJUNCTION ${tier}: ${(debris.type || 'UNKNOWN').toUpperCase()} #${debris.id} at ${distMeters}m in ${Math.round(tca)}s`,
    });

    console.log(
      `[ConjunctionSystem] ${tier} alert #${this._alertCount}: ` +
      `${debris.type} ID ${debris.id}, TCA ${Math.round(tca)}s, miss ${distMeters}m`,
    );
  }

  /**
   * Clear the active alert and emit CONJUNCTION_CLEAR.
   * @private
   */
  _clearAlert() {
    if (!this._alertActive) return;
    this._alertActive = false;
    const prev = this._currentThreat;
    this._currentThreat = null;

    eventBus.emit(Events.CONJUNCTION_CLEAR, {
      debrisId: prev ? prev.debrisId : null,
    });
  }

  // ==========================================================================
  // ST-6.3: MOID BADGE LOGIC
  // ==========================================================================

  /** Badge-tier ordering for upward-transition detection. @private */
  static _TIER_ORDER = { HI: 3, MD: 2, LO: 1 };

  /**
   * Check if new badge is a more severe tier than old badge.
   * null→LO, null→MD, null→HI, LO→MD, LO→HI, MD→HI are all "upward".
   * @private
   * @param {string|null} oldBadge
   * @param {string|null} newBadge
   * @returns {boolean}
   */
  _isUpwardTransition(oldBadge, newBadge) {
    if (!newBadge) return false; // new is SAFE — never emit
    const oldRank = oldBadge ? (ConjunctionSystem._TIER_ORDER[oldBadge] || 0) : 0;
    const newRank = ConjunctionSystem._TIER_ORDER[newBadge] || 0;
    return newRank > oldRank;
  }

  /**
   * Emit a CONJUNCTION_ALERT for a MOID-based tier transition.
   * Additive to ST-6.1's active-sat arming RED path.
   * @private
   */
  _emitMoidAlert(debris, moid_m, badge) {
    eventBus.emit(Events.CONJUNCTION_ALERT, {
      severity:   badge,
      reason:     'MOID_CROSSING',
      targetId:   debris.id,
      targetName: debris.name || `Debris ${debris.id}`,
      norad:      debris.norad || null,
      moid_m,
      moidBadge:  badge,
    });

    // Also push into the comms feed — embed styled badge HTML in text because
    // CommsSystem constructs new message objects (standard fields only), so
    // custom metadata fields would be dropped before reaching CommsPanel.
    const C = Constants.CONJUNCTION;
    const color = badge === 'HI' ? C.BADGE_COLOR_HI
      : badge === 'MD' ? C.BADGE_COLOR_MD : C.BADGE_COLOR_LO;
    const moidStr = moid_m >= 1000
      ? `${(moid_m / 1000).toFixed(1)} km`
      : `${moid_m.toFixed(0)} m`;
    const name = debris.name || `ID ${debris.id}`;
    const badgeTag = `<span style="color:${color};font-weight:bold">[${badge}]</span>`;

    eventBus.emit(Events.COMMS_MESSAGE, {
      source: 'HOUSTON',
      priority: badge === 'HI' ? 'warning' : 'info',
      text: `${badgeTag} Conjunction — ${name} · MOID ${moidStr}`,
      channel: 'ALERT',
    });
  }
}

export default ConjunctionSystem;
