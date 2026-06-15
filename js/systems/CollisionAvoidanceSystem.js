/**
 * CollisionAvoidanceSystem.js — Semi-autonomous evasive maneuver system
 *
 * Continuously monitors nearby debris trajectories at 4 Hz and automatically
 * fires RCS dodge impulses when an imminent collision is detected — unless the
 * player has explicitly targeted that debris for capture.
 *
 * Real-world analogue: ISS Pre-Determined Debris Avoidance Maneuver (PDAM).
 *
 * Detection uses the same constant-velocity linear TCA prediction as
 * ConjunctionSystem._predictClosestApproach(), but with a tighter scan
 * radius (5 km) and shorter look-ahead (10 s).
 *
 * @module systems/CollisionAvoidanceSystem
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { orbitToSceneCartesian } from '../entities/OrbitalMechanics.js';

// ============================================================================
// LOCAL CONSTANTS (derived from Constants.COLLISION_AVOIDANCE)
// ============================================================================

/** 1 metre in scene units */
const M = 0.00001;

/** Velocity conversion: km/s → scene-units/s (orbitToSceneCartesian returns km/s) */
const KM_TO_SCENE = M * 1000; // 0.01

// ============================================================================
// COLLISION AVOIDANCE SYSTEM
// ============================================================================

export class CollisionAvoidanceSystem {

  constructor() {
    const CA = Constants.COLLISION_AVOIDANCE;

    /** @type {boolean} System enabled */
    this._enabled = CA.ENABLED_DEFAULT;

    /** @type {number} Scan throttle accumulator */
    this._scanTimer = 0;

    /** @type {object|null} Current tracked threat */
    this._currentThreat = null;

    /** @type {number} Time since last dodge (for cooldown) */
    this._lastDodgeTime = -Infinity;

    /** @type {number} Elapsed game time */
    this._elapsedTime = 0;

    /** @type {number|null} Active (Tab-selected) target debris ID — exempt from dodging */
    this._activeTargetId = null;

    /** @type {number|string|null} Debris ID currently locked by autopilot — exempt from dodging
     *  in all AP modes (TARGET, DEBRIS, TRAWL). See AUTOPILOT_ANALYSIS.md §D / B.8. */
    this._autopilotLockId = null;

    /** @type {boolean} Trawl mode active — tighter threshold */
    this._trawlActive = false;

    /** @type {boolean} ARM_PILOT camera mode — fully suppress */
    this._armPilotMode = false;


    /** @type {number} Timestamp of last player movement input */
    this._lastPlayerInputTime = -Infinity;

    /** @type {string|null} Debounce: last suppression reason emitted for current threat */
    this._lastSuppressedReason = null;

    // --- Dependencies (set via init()) ---
    /** @type {object|null} */ this._player = null;
    /** @type {object|null} */ this._debrisField = null;
    /** @type {object|null} */ this._armManager = null;
    /** @type {object|null} */ this._inputManager = null;
    /** @type {object|null} ST-6.3: ConjunctionSystem ref for MOID prefilter */
    this._conjunctionSystem = null;
    /** @type {number} ST-6.3: Debug log throttle */
    this._moidLogTimer = 0;

    // --- Comms quieting state (Delegation 1 follow-up, 2026-05-31) ---
    /** @type {number} Current mission number — tracked via MISSION_START
     *  and SCORE_UPDATE so the CA comms gate works without a direct
     *  GameState ref (same pattern as KesslerSystem). */
    this._missionNumber = 1;
    /** @type {number} Epoch ms of last CA comms emit (any kind) */
    this._lastCommsEmitMs = -Infinity;

    this._setupListeners();
  }

  // ==========================================================================
  // INITIALIZATION
  // ==========================================================================

  /**
   * Wire dependencies after construction (same pattern as AutopilotSystem).
   * @param {{ player, debrisField, armManager, inputManager }} deps
   */
  init(deps) {
    this._player = deps.player;
    this._debrisField = deps.debrisField;
    this._armManager = deps.armManager || null;
    this._inputManager = deps.inputManager || null;
    this._conjunctionSystem = deps.conjunctionSystem || null;
  }

  // ==========================================================================
  // EVENT LISTENERS
  // ==========================================================================

  _setupListeners() {
    // Track active target for exemption
    eventBus.on(Events.TARGET_SELECTED, (data) => {
      this._activeTargetId = data?.id ?? data?.debrisId ?? null;
    });
    eventBus.on(Events.TARGET_CLEARED, () => {
      this._activeTargetId = null;
    });

    // Track autopilot-locked debris (exempt regardless of AP mode — see B.8 in
    // AUTOPILOT_ANALYSIS.md). Closes the CA/AP tug-of-war during DEBRIS / TRAWL.
    eventBus.on(Events.AUTOPILOT_TARGET_LOCK, (data) => {
      this._autopilotLockId = data?.debrisId ?? null;
    });
    eventBus.on(Events.AUTOPILOT_TARGET_UNLOCK, (data) => {
      if (data?.debrisId == null || data.debrisId === this._autopilotLockId) {
        this._autopilotLockId = null;
      }
    });

    // Trawl mode — tighten avoidance radius
    eventBus.on(Events.TRAWL_START, () => { this._trawlActive = true; });
    eventBus.on(Events.TRAWL_END, () => { this._trawlActive = false; });
    eventBus.on(Events.TRAWL_SWEEP_COMPLETE, () => { this._trawlActive = false; });

    // ARM_PILOT mode — fully suppress
    eventBus.on(Events.CONTROL_MODE_CHANGE, (data) => {
      this._armPilotMode = data?.mode === 'ARM_PILOT';
    });


    // Toggle system on/off
    eventBus.on(Events.CA_TOGGLED, (data) => {
      this._enabled = !!data?.enabled;
    });

    // Mission tracking for comms quieting gate (Delegation 1 follow-up)
    eventBus.on(Events.MISSION_START, (d) => {
      if (typeof d?.missionNumber === 'number') {
        this._missionNumber = d.missionNumber;
      }
    });
    eventBus.on(Events.SCORE_UPDATE, (d) => {
      if (typeof d?.debrisCleared === 'number') {
        const per = Constants.MISSIONS?.DEBRIS_PER_MISSION || 5;
        this._missionNumber = Math.floor(d.debrisCleared / per) + 1;
      }
    });

    // Game reset — clear all state
    eventBus.on(Events.GAME_RESET, () => { this.reset(); });

    // Game state change — only active during gameplay
    eventBus.on(Events.GAME_STATE_CHANGE, (data) => {
      // Disable during non-gameplay states (menu, shop, briefing, game over)
      const gameplay = ['ORBITAL_VIEW', 'APPROACH', 'INTERACTION'];
      if (data?.to && !gameplay.includes(data.to)) {
        // Not in gameplay — freeze scanning but don't disable toggle
        this._scanTimer = 0;
        this._currentThreat = null;
      }
    });
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /** @returns {boolean} */
  get enabled() { return this._enabled; }

  /** Toggle system enabled state */
  toggle() {
    this._enabled = !this._enabled;
    eventBus.emit(Events.CA_TOGGLED, { enabled: this._enabled });
  }

  /** Get status for HUD or debug */
  getStatus() {
    return {
      enabled: this._enabled,
      currentThreat: this._currentThreat,
      lastDodgeTime: this._lastDodgeTime,
      trawlActive: this._trawlActive,
      armPilotMode: this._armPilotMode,
    };
  }

  /** Reset all state (called on GAME_RESET) */
  reset() {
    this._scanTimer = 0;
    this._currentThreat = null;
    this._lastDodgeTime = -Infinity;
    this._elapsedTime = 0;
    this._activeTargetId = null;
    this._autopilotLockId = null;
    this._trawlActive = false;
    this._armPilotMode = false;
    this._lastPlayerInputTime = -Infinity;
    this._lastSuppressedReason = null;
    this._missionNumber = 1;
    this._lastCommsEmitMs = -Infinity;
  }

  /**
   * Comms-gate helper (Delegation 1 follow-up, 2026-05-31).
   *
   * The CA system used to fire a COMMS_MESSAGE on every threat-detected,
   * dodge-executed, and threat-cleared transition.  Reviewer noted this
   * produced an overwhelming yellow wall on mission 1 (10+ dodges visible
   * in the first 60 seconds) that drowned out welcoming onboarding tone.
   *
   * This helper enforces two gates:
   *   1. Mission floor — silent until missionNumber >= COMMS_MIN_MISSION.
   *   2. Rate limit — at most one CA comms per COMMS_RATE_LIMIT_S seconds.
   *
   * Dodging still fires silently; only the COMMS_MESSAGE side-channel is
   * affected.  Use this for any "chatty" CA comms; do NOT use it for
   * future game-over alerts (those should still fire even on mission 1).
   *
   * @private
   * @param {object} payload — same payload you'd pass to eventBus.emit(COMMS_MESSAGE,…)
   * @returns {boolean} true if the message was emitted, false if gated
   */
  _emitCaComms(payload) {
    const CA = Constants.COLLISION_AVOIDANCE;
    const minMission = CA.COMMS_MIN_MISSION ?? 1;
    if (this._missionNumber < minMission) return false;

    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    const rateLimitMs = (CA.COMMS_RATE_LIMIT_S ?? 0) * 1000;
    if (rateLimitMs > 0 && (now - this._lastCommsEmitMs) < rateLimitMs) return false;

    this._lastCommsEmitMs = now;
    eventBus.emit(Events.COMMS_MESSAGE, payload);
    return true;
  }

  // ==========================================================================
  // UPDATE (called from main.js game loop)
  // ==========================================================================

  /**
   * Main update tick — called after autopilot, before player.update().
   * @param {number} dt — delta time in seconds
   */
  update(dt) {
    if (!this._enabled || !this._player || !this._debrisField) return;

    this._elapsedTime += dt;

    const CA = Constants.COLLISION_AVOIDANCE;

    // --- Suppress conditions ---
    if (this._armPilotMode) return;

    // Track player movement input for override detection
    this._detectPlayerInput();

    // --- Scan throttle (4 Hz) ---
    this._scanTimer += dt;
    if (this._scanTimer < CA.SCAN_INTERVAL) return;
    this._scanTimer = 0;

    // --- Scan for threats ---
    const playerPos = this._player.getPosition();
    const playerVel = this._player.getVelocity();
    const threat = this._scanForThreats(playerPos, playerVel);

    if (threat) {
      // Emit threat detected (only on new threat or different debris)
      if (!this._currentThreat || this._currentThreat.debrisId !== threat.debrisId) {
        this._currentThreat = threat;
        eventBus.emit(Events.CA_THREAT_DETECTED, {
          debrisId: threat.debrisId,
          tca: threat.tca,
          missDistance: threat.missDistM,
          evasionVector: threat.evasionDir,
        });

        // Comms warning (gated — see _emitCaComms JSDoc)
        this._emitCaComms({
          sender: 'CA',
          text: `Debris ${threat.debrisId}. TCA ${threat.tca.toFixed(1)}s, miss ${Math.round(threat.missDistM)}m. Evaluating`,
          priority: 'info',
        });
      }

      // --- Evaluate if dodge is needed ---
      this._evaluateAndDodge(threat, playerPos);
    } else {
      this._clearThreat();
    }
  }

  // ==========================================================================
  // DETECTION (Phase 1 — 4 Hz scan)
  // ==========================================================================

  /**
   * Scan all debris for the most threatening upcoming collision.
   * Pre-filters by distance² for performance (800 debris → ~5-20 candidates).
   *
   * @private
   * @param {THREE.Vector3} playerPos — player scene position
   * @param {{x,y,z}} playerVel — player velocity (km/s)
   * @returns {object|null} Worst threat { debrisId, tca, missDistScene, missDistM, evasionDir, threatDir }
   */
  _scanForThreats(playerPos, playerVel) {
    const CA = Constants.COLLISION_AVOIDANCE;
    const avoidRadius = this._getAvoidanceRadius();

    // ST-6.3: MOID prefilter — if ConjunctionSystem has MOID data, scan only top-N pairs
    const moidPairs = this._conjunctionSystem
      ? this._conjunctionSystem.getTopRiskPairs()
      : null;
    const useMoidFilter = moidPairs && moidPairs.length > 0;

    let debrisList;
    let totalCandidates;

    if (useMoidFilter) {
      // Build a set of IDs to check from the MOID-ranked pairs
      const moidIds = new Set(moidPairs.map(p => p.id));
      debrisList = this._debrisField.debrisList.filter(d => d.alive && moidIds.has(d.id));
      totalCandidates = this._debrisField.debrisList.length;
    } else {
      debrisList = this._debrisField.debrisList;
      totalCandidates = debrisList.length;
    }

    // ST-6.3: Debug log once per second
    this._moidLogTimer += CA.SCAN_INTERVAL;
    if (this._moidLogTimer >= 1.0) {
      this._moidLogTimer = 0;
      if (useMoidFilter) {
        console.log(
          `[CA] checking ${debrisList.length} pairs (MOID-prefiltered from ${totalCandidates} objects)`,
        );
      }
    }

    let worst = null;
    let worstDist = Infinity;

    for (let i = 0, len = debrisList.length; i < len; i++) {
      const debris = debrisList[i];
      if (!debris.alive) continue;

      // --- Exempt active (Tab-selected) target ---
      if (debris.id === this._activeTargetId) continue;

      // --- Exempt autopilot-locked debris (any AP mode) ---
      if (this._autopilotLockId != null && debris.id === this._autopilotLockId) continue;

      // --- Exempt arm-targeted debris ---
      if (this._isArmTarget(debris.id)) continue;

      // --- Fast distance² pre-filter using cached scene position ---
      let dx, dy, dz;
      if (debris._scenePosition) {
        dx = debris._scenePosition.x - playerPos.x;
        dy = debris._scenePosition.y - playerPos.y;
        dz = debris._scenePosition.z - playerPos.z;
      } else {
        continue; // No position cached yet — skip this frame
      }

      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > CA.SCAN_RADIUS_SQ) continue;

      // --- Full cartesian state for velocity-based TCA prediction ---
      const cart = orbitToSceneCartesian(debris.orbit);
      const prediction = this._predictClosestApproach(
        cart.position, cart.velocity, playerPos, playerVel,
      );
      if (!prediction) continue;

      // Only interested if approaching (TCA > 0) and within avoidance envelope
      if (prediction.tca <= 0 || prediction.minDist > avoidRadius) continue;
      if (prediction.tca > CA.LOOK_AHEAD_S) continue;

      if (prediction.minDist < worstDist) {
        worstDist = prediction.minDist;
        worst = {
          debrisId: debris.id,
          tca: prediction.tca,
          missDistScene: prediction.minDist,
          missDistM: prediction.minDist / M,
          threatDir: prediction.threatDir,
          evasionDir: this._generateEvasionVector(prediction.threatDir, playerPos),
        };
      }
    }

    return worst;
  }

  // ==========================================================================
  // TCA PREDICTION (reuse ConjunctionSystem math)
  // ==========================================================================

  /**
   * Compute time-of-closest-approach (TCA) and miss distance using
   * constant-velocity linear extrapolation.
   *
   *   TCA = −(Δr · Δv) / (Δv · Δv)   clamped to [0, LOOK_AHEAD_S]
   *   miss = |Δr + Δv × TCA|
   *
   * @private
   * @param {{x,y,z}} dPos — debris position (scene units)
   * @param {{x,y,z}} dVel — debris velocity (km/s from orbitToSceneCartesian)
   * @param {{x,y,z}} pPos — player position (scene units)
   * @param {{x,y,z}} pVel — player velocity (km/s from getVelocity)
   * @returns {{ tca:number, minDist:number, threatDir:{x,y,z} } | null}
   */
  _predictClosestApproach(dPos, dVel, pPos, pVel) {
    const CA = Constants.COLLISION_AVOIDANCE;

    // Relative position (scene units)
    const rpx = dPos.x - pPos.x;
    const rpy = dPos.y - pPos.y;
    const rpz = dPos.z - pPos.z;

    // Relative velocity — convert km/s → scene-units/s
    const rvx = (dVel.x - pVel.x) * KM_TO_SCENE;
    const rvy = (dVel.y - pVel.y) * KM_TO_SCENE;
    const rvz = (dVel.z - pVel.z) * KM_TO_SCENE;

    const rvDotRv = rvx * rvx + rvy * rvy + rvz * rvz;
    if (rvDotRv < 1e-24) return null; // negligible relative motion

    const rpDotRv = rpx * rvx + rpy * rvy + rpz * rvz;
    let tca = -rpDotRv / rvDotRv;
    tca = Math.max(0, Math.min(CA.LOOK_AHEAD_S, tca));

    // Miss vector at TCA
    const cx = rpx + rvx * tca;
    const cy = rpy + rvy * tca;
    const cz = rpz + rvz * tca;
    const minDist = Math.sqrt(cx * cx + cy * cy + cz * cz);

    // Normalised threat approach direction
    const rLen = Math.sqrt(rpx * rpx + rpy * rpy + rpz * rpz);
    const threatDir = rLen > 1e-10
      ? { x: rpx / rLen, y: rpy / rLen, z: rpz / rLen }
      : { x: 1, y: 0, z: 0 };

    return { tca, minDist, threatDir };
  }

  // ==========================================================================
  // EVASION VECTOR (reuse ConjunctionSystem math)
  // ==========================================================================

  /**
   * Compute dodge direction perpendicular to threat approach vector.
   * Cross product: threat × radial → perpendicular in orbital plane.
   *
   * @private
   * @param {{x,y,z}} threatDir — normalised threat direction
   * @param {{x,y,z}} playerPos — player scene position
   * @returns {{x:number, y:number, z:number}} Normalised evasion direction (scene units)
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
  // AVOIDANCE (Phase 1 — dodge execution)
  // ==========================================================================

  /**
   * Evaluate whether to execute a dodge and fire if appropriate.
   *
   * @private
   * @param {object} threat — from _scanForThreats()
   * @param {THREE.Vector3} playerPos — current player position
   */
  _evaluateAndDodge(threat, playerPos) {
    const CA = Constants.COLLISION_AVOIDANCE;
    const avoidRadius = this._getAvoidanceRadius();

    // --- Cooldown check ---
    if (this._elapsedTime - this._lastDodgeTime < CA.COOLDOWN) return;

    // --- Player manual override: recent input suppresses dodge ---
    if (this._elapsedTime - this._lastPlayerInputTime < CA.OVERRIDE_WINDOW) {
      if (this._lastSuppressedReason !== 'manual_override') {
        this._lastSuppressedReason = 'manual_override';
        eventBus.emit(Events.CA_SUPPRESSED, {
          debrisId: threat.debrisId,
          reason: 'manual_override',
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'CA',
          text: 'Override. Manual control',
          priority: 'info',
        });
      }
      return;
    }

    // --- ARM_PILOT suppress (redundant safety — also checked in update) ---
    if (this._armPilotMode) {
      if (this._lastSuppressedReason !== 'arm_pilot') {
        this._lastSuppressedReason = 'arm_pilot';
        eventBus.emit(Events.CA_SUPPRESSED, {
          debrisId: threat.debrisId,
          reason: 'arm_pilot',
        });
      }
      return;
    }

    // Clear suppression debounce — we're proceeding to dodge
    this._lastSuppressedReason = null;

    // --- Compute dodge magnitude (proportional to severity) ---
    // More severe (smaller miss) = stronger dodge
    const severity = 1 - (threat.missDistScene / avoidRadius);
    const dodgeDvMs = CA.BASE_DODGE_DV * Math.max(0.2, severity); // min 20% impulse
    const dodgeDvScene = dodgeDvMs * M; // convert m/s → scene-units/s

    // --- Apply RCS impulse directly to _rcsVelocity (world-space) ---
    // This is the same velocity channel used by applyRCS() but we bypass
    // the per-frame scaling (designed for continuous input) and apply the
    // full dodge impulse in one shot.
    const ev = threat.evasionDir;
    this._player._rcsVelocity.x += ev.x * dodgeDvScene;
    this._player._rcsVelocity.y += ev.y * dodgeDvScene;
    this._player._rcsVelocity.z += ev.z * dodgeDvScene;

    // Clamp to RCS max speed
    const maxV = Constants.RCS_MAX_SPEED;
    if (this._player._rcsVelocity.length() > maxV) {
      this._player._rcsVelocity.normalize().multiplyScalar(maxV);
    }

    // Trigger RCS visual puff — project world-space evasion into local frame
    // for correct nozzle selection (z=prograde, x=cross-track, y=radial)
    if (typeof this._player._fireRcsPuff === 'function') {
      const localDir = this._worldToLocalFrame(ev, playerPos);
      this._player._fireRcsPuff(localDir);
    }

    this._lastDodgeTime = this._elapsedTime;

    // Determine dodge direction label for messages
    const dirLabel = this._getDirectionLabel(ev, playerPos);

    // --- Emit dodge event ---
    eventBus.emit(Events.CA_DODGE_EXECUTED, {
      debrisId: threat.debrisId,
      direction: dirLabel,
      magnitude: dodgeDvMs,
    });

    // --- Comms notification (gated — see _emitCaComms JSDoc) ---
    this._emitCaComms({
      sender: 'CA',
      text: `⚠ COLLISION AVOIDANCE. RCS dodge fired (${dodgeDvMs.toFixed(2)} m/s ${dirLabel})`,
      priority: 'warning',
    });
  }

  // ==========================================================================
  // THREAT CLEARING
  // ==========================================================================

  /** @private Clear current threat and emit event */
  _clearThreat() {
    if (this._currentThreat) {
      eventBus.emit(Events.CA_THREAT_CLEARED, {
        debrisId: this._currentThreat.debrisId,
      });

      // Gated — see _emitCaComms JSDoc.  Skipping this on mission 1 is
      // especially nice because every dodge would otherwise generate a
      // matching "Clear." follow-up = 2× the noise.
      this._emitCaComms({
        sender: 'CA',
        text: 'Clear. Resume heading.',
        priority: 'info',
      });

      this._currentThreat = null;
      this._lastSuppressedReason = null;
    }
  }

  // ==========================================================================
  // CONTEXT AWARENESS (Phase 2)
  // ==========================================================================

  /**
   * Check if a debris ID is currently targeted by any deployed arm.
   * @private
   * @param {number} debrisId
   * @returns {boolean}
   */
  _isArmTarget(debrisId) {
    if (!this._armManager) return false;
    const arms = this._armManager.arms;
    for (let i = 0, len = arms.length; i < len; i++) {
      const arm = arms[i];
      if (arm.target && arm.target.id === debrisId) return true;
    }
    return false;
  }

  /**
   * Detect recent player movement input (WASD/arrows).
   * If movement keys are pressed, record timestamp for override window.
   * @private
   */
  _detectPlayerInput() {
    if (!this._inputManager) return;
    const keys = this._inputManager.keys;
    if (!keys) return;

    // Check standard movement keys
    const hasInput = keys['KeyW'] || keys['KeyA'] || keys['KeyS'] || keys['KeyD'] ||
                     keys['ArrowUp'] || keys['ArrowDown'] || keys['ArrowLeft'] || keys['ArrowRight'];
    if (hasInput) {
      this._lastPlayerInputTime = this._elapsedTime;
    }
  }

  /**
   * Get the effective avoidance radius based on mode.
   * @private
   * @returns {number} Avoidance radius in scene units
   */
  _getAvoidanceRadius() {
    const CA = Constants.COLLISION_AVOIDANCE;
    return this._trawlActive ? CA.TRAWL_AVOIDANCE_RADIUS : CA.AVOIDANCE_RADIUS;
  }

  /**
   * Project a world-space direction vector into the player's local frame
   * for _fireRcsPuff nozzle selection. Same frame as applyRCS:
   *   z = prograde, x = cross-track, y = radial-up
   *
   * @private
   * @param {{x,y,z}} worldDir — normalised direction in world space
   * @param {{x,y,z}} playerPos — player scene position
   * @returns {{x:number, y:number, z:number}} Local-frame direction
   */
  _worldToLocalFrame(worldDir, playerPos) {
    // Build local axes (same as applyRCS in PlayerSatellite)
    const vel = this._player._cartesian?.velocity;
    if (!vel) return { x: worldDir.x, y: worldDir.y, z: worldDir.z };

    const vLen = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);

    // Prograde axis
    let pgx, pgy, pgz;
    if (vLen > 1e-10) {
      pgx = vel.x / vLen; pgy = vel.y / vLen; pgz = vel.z / vLen;
    } else {
      pgx = 0; pgy = 0; pgz = 1;
    }

    // Radial-up axis (away from Earth)
    const pLen = Math.sqrt(playerPos.x * playerPos.x + playerPos.y * playerPos.y + playerPos.z * playerPos.z);
    let rux, ruy, ruz;
    if (pLen > 1e-10) {
      rux = playerPos.x / pLen; ruy = playerPos.y / pLen; ruz = playerPos.z / pLen;
    } else {
      rux = 0; ruy = 1; ruz = 0;
    }

    // Cross-track axis = prograde × radial
    let ctx = pgy * ruz - pgz * ruy;
    let cty = pgz * rux - pgx * ruz;
    let ctz = pgx * ruy - pgy * rux;
    const ctLen = Math.sqrt(ctx * ctx + cty * cty + ctz * ctz);
    if (ctLen > 1e-10) {
      ctx /= ctLen; cty /= ctLen; ctz /= ctLen;
    }

    // Re-orthogonalise radial: crossTrack × prograde
    rux = cty * pgz - ctz * pgy;
    ruy = ctz * pgx - ctx * pgz;
    ruz = ctx * pgy - cty * pgx;

    // Project world direction onto local axes (dot products)
    return {
      x: worldDir.x * ctx + worldDir.y * cty + worldDir.z * ctz,   // cross-track
      y: worldDir.x * rux + worldDir.y * ruy + worldDir.z * ruz,   // radial
      z: worldDir.x * pgx + worldDir.y * pgy + worldDir.z * pgz,   // prograde
    };
  }

  /**
   * Generate a human-readable direction label from the evasion vector.
   * @private
   * @param {{x,y,z}} evasionDir — normalised evasion direction (world space)
   * @param {{x,y,z}} playerPos — player scene position
   * @returns {string} Direction label (e.g., "cross-track", "radial-up")
   */
  _getDirectionLabel(evasionDir, playerPos) {
    // Approximate radial direction
    const pLen = Math.sqrt(playerPos.x ** 2 + playerPos.y ** 2 + playerPos.z ** 2);
    if (pLen < 1e-10) return 'lateral';

    const radDot = (evasionDir.x * playerPos.x + evasionDir.y * playerPos.y +
                    evasionDir.z * playerPos.z) / pLen;

    if (Math.abs(radDot) > 0.7) {
      return radDot > 0 ? 'radial-up' : 'radial-down';
    }
    return 'cross-track';
  }
}
