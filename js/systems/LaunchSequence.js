/**
 * LaunchSequence.js — 9-phase launch-to-operational sequence (ST-9.11 C-5)
 *
 * Drives LOCKED → STOWED transitions and ROSA solar panel deployment.
 * Feature-flag gated: FEATURE_FLAGS.LAUNCH_SEQUENCE (default false).
 *
 * Phase machine (canonical order):
 *   STOWED_IN_FAIRING → LIFTOFF → FAIRING_SEPARATION → ORBIT_INSERTION →
 *   LAUNCH_LOCK_RELEASE → ROSA_DEPLOY_PRIMARY → ROSA_DEPLOY_SECONDARY →
 *   POWER_NOMINAL → READY
 *
 * @module systems/LaunchSequence
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { powerDistribution } from './PowerDistribution.js';

/** Ordered phase names — index determines canonical ordering. */
export const LAUNCH_PHASES = Object.freeze([
  'STOWED_IN_FAIRING',
  'LIFTOFF',
  'FAIRING_SEPARATION',
  'ORBIT_INSERTION',
  'LAUNCH_LOCK_RELEASE',
  'ROSA_DEPLOY_PRIMARY',
  'ROSA_DEPLOY_SECONDARY',
  'POWER_NOMINAL',
  'READY',
]);

class LaunchSequence {
  constructor() {
    this._phase = null;          // null when not initialised
    this._phaseIndex = -1;
    this._phaseElapsed = 0;      // seconds in current phase
    this._totalElapsed = 0;      // total seconds since start()
    this._armManager = null;
    this._persistenceManager = null;
    this._running = false;

    // ROSA progress
    this._rosaWing1 = 0;         // 0..1
    this._rosaWing2 = 0;         // 0..1
    this._rosaTotalPowerW = 0;

    // Launch-lock stagger tracking
    this._lockReleaseArms = [];  // arms to unlock
    this._lockReleaseNext = 0;   // next arm index to unlock
    this._lockStaggerAccum = 0;  // accumulated stagger time
  }

  // ========================================================================
  // PUBLIC API
  // ========================================================================

  /**
   * Start the launch sequence from STOWED_IN_FAIRING.
   * No-op when FEATURE_FLAGS.LAUNCH_SEQUENCE is false.
   *
   * @param {object} armManager — ArmManager instance (injected for testability)
   * @param {object} [persistenceManager] — PersistenceManager instance
   * @param {object} [_eventBus] — unused, kept for API-spec compatibility
   */
  start(armManager, persistenceManager, _eventBus) {
    if (!Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE) return;

    this._armManager = armManager;
    this._persistenceManager = persistenceManager || null;
    this._running = true;
    this._totalElapsed = 0;
    this._rosaWing1 = 0;
    this._rosaWing2 = 0;
    this._rosaTotalPowerW = 0;

    // Block arm input during sequence
    if (armManager && typeof armManager.setLaunchLock === 'function') {
      armManager.setLaunchLock(true);
    }

    // Enter initial phase (emits LAUNCH_PHASE_CHANGED with fromPhase: null)
    this._setPhase(0); // STOWED_IN_FAIRING
  }

  /**
   * Advance one frame.  Call from main game loop.
   * @param {number} dt — delta time in seconds
   */
  tick(dt) {
    if (!this._running || this._phase === 'READY') return;

    this._phaseElapsed += dt;
    this._totalElapsed += dt;

    switch (this._phase) {
      case 'STOWED_IN_FAIRING':
        // Immediate transition — first tick advances to LIFTOFF
        this._advancePhase();
        break;

      case 'LIFTOFF':
        if (this._phaseElapsed >= (Constants.FAIRING_SEP_DELAY_S || 4.0)) {
          this._advancePhase(); // → FAIRING_SEPARATION
        }
        break;

      case 'FAIRING_SEPARATION':
        if (this._phaseElapsed >= (Constants.ORBIT_INSERTION_DELAY_S || 4.0)) {
          this._advancePhase(); // → ORBIT_INSERTION
        }
        break;

      case 'ORBIT_INSERTION':
        if (this._phaseElapsed >= (Constants.LAUNCH_PYRO_DELAY || 40)) {
          this._advancePhase(); // → LAUNCH_LOCK_RELEASE
        }
        break;

      case 'LAUNCH_LOCK_RELEASE':
        this._tickLaunchLockRelease(dt);
        break;

      case 'ROSA_DEPLOY_PRIMARY':
        this._tickRosaDeploy(1);
        break;

      case 'ROSA_DEPLOY_SECONDARY':
        this._tickRosaDeploy(2);
        break;

      case 'POWER_NOMINAL':
        // Transition → READY (immediate)
        this._advancePhase();
        break;

      default:
        break;
    }
  }

  /**
   * Debug / test bypass — jump straight to READY.
   * All arms set to STOWED, ROSA at 100%.
   */
  skipToReady() {
    if (!Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE) return;

    // If not yet started, bootstrap minimally
    if (!this._running) {
      this._running = true;
    }

    // Unlock all arms that are still LOCKED
    if (this._armManager) {
      const DS = Constants.DEPLOY_STATES;
      const arms = this._armManager.arms || [];
      for (const arm of arms) {
        if (arm._deployState === DS.LOCKED) {
          arm.strutUnlock();
        }
      }
    }

    // Snap ROSA to 100 %
    const totalPower = Constants.OCTOPUS_V5.TOTAL_SOLAR_POWER || 2240;
    this._rosaWing1 = 1;
    this._rosaWing2 = 1;
    this._rosaTotalPowerW = totalPower;
    powerDistribution.setSolarInput(totalPower);

    // Unblock arm input
    if (this._armManager && typeof this._armManager.setLaunchLock === 'function') {
      this._armManager.setLaunchLock(false);
    }

    const fromPhase = this._phase;
    this._phase = 'READY';
    this._phaseIndex = LAUNCH_PHASES.indexOf('READY');
    this._phaseElapsed = 0;
    this._running = false;

    eventBus.emit(Events.LAUNCH_PHASE_CHANGED, {
      fromPhase: fromPhase || null,
      toPhase: 'READY',
      elapsedTotalS: this._totalElapsed,
    });
    eventBus.emit(Events.LAUNCH_SEQUENCE_COMPLETE);

    // Persist terminal state
    if (this._persistenceManager && typeof this._persistenceManager.setLaunchPhase === 'function') {
      this._persistenceManager.setLaunchPhase('READY');
    }
  }

  /** @returns {string|null} Current phase name (null if not started) */
  getCurrentPhase() { return this._phase; }

  /** @returns {number} Seconds elapsed in current phase */
  getElapsedSecondsInPhase() { return this._phaseElapsed; }

  /** @returns {{ wing1: number, wing2: number, totalPowerW: number }} */
  getRosaProgress() {
    return {
      wing1: this._rosaWing1,
      wing2: this._rosaWing2,
      totalPowerW: this._rosaTotalPowerW,
    };
  }

  /** @returns {boolean} True when phase is READY (terminal) */
  isReady() { return this._phase === 'READY'; }

  /** @returns {boolean} True when sequence is actively running (not null / not READY) */
  isActive() { return this._running && this._phase !== null && this._phase !== 'READY'; }

  /**
   * Reset for new game.  Clears all sequence state.
   */
  reset() {
    this._phase = null;
    this._phaseIndex = -1;
    this._phaseElapsed = 0;
    this._totalElapsed = 0;
    this._running = false;
    this._rosaWing1 = 0;
    this._rosaWing2 = 0;
    this._rosaTotalPowerW = 0;
    this._lockReleaseArms = [];
    this._lockReleaseNext = 0;
    this._lockStaggerAccum = 0;
    this._armManager = null;
    this._persistenceManager = null;
  }

  // ========================================================================
  // INTERNAL — Phase helpers
  // ========================================================================

  /**
   * Set the current phase by index.  Emits LAUNCH_PHASE_CHANGED.
   * @param {number} index — index into LAUNCH_PHASES
   * @private
   */
  _setPhase(index) {
    const fromPhase = this._phase;
    this._phaseIndex = index;
    this._phase = LAUNCH_PHASES[index];
    this._phaseElapsed = 0;

    const nextIndex = index + 1;
    const nextPhase = nextIndex < LAUNCH_PHASES.length ? LAUNCH_PHASES[nextIndex] : null;

    eventBus.emit(Events.LAUNCH_PHASE_CHANGED, {
      fromPhase: fromPhase !== undefined ? fromPhase : null,
      toPhase: this._phase,
      elapsedTotalS: this._totalElapsed,
      phaseDurationS: this._getExpectedPhaseDuration(this._phase),
      nextPhase,
    });
  }

  /**
   * Expected wall-clock duration of a given phase.
   * Used by HUD for countdown display.
   * @param {string} phase
   * @returns {number} seconds (0 = instant transition)
   * @private
   */
  _getExpectedPhaseDuration(phase) {
    const V5 = Constants.OCTOPUS_V5;
    switch (phase) {
      case 'STOWED_IN_FAIRING': return 0;
      case 'LIFTOFF':           return Constants.FAIRING_SEP_DELAY_S   || 4.0;
      case 'FAIRING_SEPARATION':return Constants.ORBIT_INSERTION_DELAY_S || 4.0;
      case 'ORBIT_INSERTION':   return Constants.LAUNCH_PYRO_DELAY      || 40;
      case 'LAUNCH_LOCK_RELEASE': {
        const armCount = (this._armManager?.arms?.length) || 0;
        return armCount * (Constants.LAUNCH_LOCK_STAGGER_S || 0.1) + 0.1;
      }
      case 'ROSA_DEPLOY_PRIMARY':   return V5.ROSA_DEPLOY_DURATION_S || 6.0;
      case 'ROSA_DEPLOY_SECONDARY': return V5.ROSA_DEPLOY_DURATION_S || 6.0;
      case 'POWER_NOMINAL':         return 0;
      case 'READY':                 return Infinity;
      default:                      return 0;
    }
  }

  /**
   * Advance to the next phase.  No-op if already at READY.
   * @private
   */
  _advancePhase() {
    const nextIndex = this._phaseIndex + 1;
    if (nextIndex >= LAUNCH_PHASES.length) return;

    this._setPhase(nextIndex);

    // Phase-entry side effects
    switch (this._phase) {
      case 'LAUNCH_LOCK_RELEASE':
        this._beginLaunchLockRelease();
        break;
      case 'ROSA_DEPLOY_PRIMARY':
        eventBus.emit(Events.ROSA_DEPLOY_STARTED, { wing: 1 });
        break;
      case 'ROSA_DEPLOY_SECONDARY':
        eventBus.emit(Events.ROSA_DEPLOY_STARTED, { wing: 2 });
        break;
      case 'READY':
        this._onReady();
        break;
      default:
        break;
    }
  }

  // ========================================================================
  // INTERNAL — Launch Lock Release
  // ========================================================================

  /** Prepare the per-arm stagger unlock list. */
  _beginLaunchLockRelease() {
    if (!this._armManager || !this._armManager.arms) {
      // No arms — skip immediately
      this._advancePhase();
      return;
    }
    this._lockReleaseArms = [...this._armManager.arms];
    this._lockReleaseNext = 0;
    this._lockStaggerAccum = 0;
  }

  /**
   * Tick the launch-lock release phase: unlock one arm every LAUNCH_LOCK_STAGGER_S.
   * After all arms reach STOWED, advance to ROSA_DEPLOY_PRIMARY.
   */
  _tickLaunchLockRelease(_dt) {
    if (!this._armManager) {
      this._advancePhase();
      return;
    }

    const stagger = Constants.LAUNCH_LOCK_STAGGER_S || 0.1;

    // Unlock arms at staggered intervals (arm 0 at 0 s, arm 1 at 0.1 s, …)
    while (
      this._lockReleaseNext < this._lockReleaseArms.length &&
      this._phaseElapsed >= this._lockReleaseNext * stagger
    ) {
      const arm = this._lockReleaseArms[this._lockReleaseNext];
      if (arm && typeof arm.strutUnlock === 'function') {
        arm.strutUnlock();
      }
      eventBus.emit(Events.LAUNCH_LOCK_RELEASED, {
        armIndex: this._lockReleaseNext,
      });
      this._lockReleaseNext++;
    }

    // All arms processed — verify no arm still LOCKED, then advance.
    // Uses !== LOCKED rather than === STOWED for robustness: when
    // STOW_DEPLOY_STATE_MACHINE is off, arms stay DEPLOYED (valid).
    if (this._lockReleaseNext >= this._lockReleaseArms.length) {
      const DS = Constants.DEPLOY_STATES;
      const allUnlocked = this._lockReleaseArms.every(
        arm => arm._deployState !== DS.LOCKED
      );
      if (allUnlocked) {
        this._advancePhase(); // → ROSA_DEPLOY_PRIMARY
      }
    }
  }

  // ========================================================================
  // INTERNAL — ROSA Deployment
  // ========================================================================

  /**
   * Tick ROSA wing deployment.  Linear power ramp per wing.
   * @param {number} wing — 1 or 2
   */
  _tickRosaDeploy(wing) {
    const duration = Constants.OCTOPUS_V5.ROSA_DEPLOY_DURATION_S || 6.0;
    const totalPower = Constants.OCTOPUS_V5.TOTAL_SOLAR_POWER || 2240;
    const perWing = totalPower / 2;

    if (wing === 1) {
      this._rosaWing1 = Math.min(1, this._phaseElapsed / duration);
      this._rosaTotalPowerW = this._rosaWing1 * perWing;
    } else {
      this._rosaWing2 = Math.min(1, this._phaseElapsed / duration);
      this._rosaTotalPowerW = perWing + this._rosaWing2 * perWing;
    }

    // Update power distribution with running total
    powerDistribution.setSolarInput(this._rosaTotalPowerW);

    // Wing deployment complete?
    if (this._phaseElapsed >= duration) {
      // Snap to exact values
      if (wing === 1) {
        this._rosaWing1 = 1;
        this._rosaTotalPowerW = perWing;
      } else {
        this._rosaWing2 = 1;
        this._rosaTotalPowerW = totalPower;
      }
      powerDistribution.setSolarInput(this._rosaTotalPowerW);

      eventBus.emit(Events.ROSA_DEPLOY_COMPLETED, {
        wing,
        powerW: wing === 1 ? perWing : totalPower,
      });

      // TODO: visual cinematic — animate ROSA blanket geometry here
      this._advancePhase();
    }
  }

  // ========================================================================
  // INTERNAL — Terminal state
  // ========================================================================

  /** Called on entering READY phase. */
  _onReady() {
    this._running = false;

    // Unblock arm input
    if (this._armManager && typeof this._armManager.setLaunchLock === 'function') {
      this._armManager.setLaunchLock(false);
    }

    eventBus.emit(Events.LAUNCH_SEQUENCE_COMPLETE);

    // Persist terminal state
    if (this._persistenceManager && typeof this._persistenceManager.setLaunchPhase === 'function') {
      this._persistenceManager.setLaunchPhase('READY');
    }
  }
}

/** Singleton instance */
export const launchSequence = new LaunchSequence();
export default launchSequence;
