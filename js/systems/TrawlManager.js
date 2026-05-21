/**
 * TrawlManager.js — Manages mothership traverse through debris clusters.
 * Controls autopilot approach, traverse speed, tether window tracking,
 * and adaptive difficulty.
 * @module systems/TrawlManager
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';

export class TrawlManager {
  constructor() {
    /** @type {object|null} Current active cluster being trawled */
    this.activeCluster = null;

    /** @type {number} Traverse speed in scene units/s */
    this.traverseSpeed = Constants.TRAWLING.TRAVERSE_SPEED_DEFAULT;

    /** @type {boolean} Whether trawling is active */
    this.active = false;

    /** @type {Array} Targets currently within tether range */
    this.targetsInRange = [];

    /** @type {number} Catches this pass */
    this.catchesThisPass = 0;

    /** @type {number} Opportunities this pass (targets that entered range) */
    this.opportunitiesThisPass = 0;

    /** @type {number} Time in trawl mode (seconds) */
    this.trawlTime = 0;

    /** @type {number} Seconds since last target was in range (for auto-end) */
    this._idleTimer = 0;

    /** @type {Set<number>} IDs of targets already warned about window closing */
    this._windowWarned = new Set();

    // Self-reset via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.GAME_RESET, () => {
      if (this.active) {
        try { this.endTrawl(); } catch (e) { /* ignore */ }
      }
    });

    // Cached refs from update() for self-managed auto-start and toggle (Batch 3)
    /** @type {object|null} */ this._player = null;
    /** @type {object|null} */ this._debrisField = null;

    // Self-manage auto-start on ORBITAL_VIEW (Batch 3 decoupling)
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
      if (to === GameStates.ORBITAL_VIEW && !this.active && this._debrisField) {
        try {
          const clusters = this._debrisField.getDebrisClusters();
          const nearest = clusters[0]; // densest/most-valuable cluster
          if (nearest) {
            this.startTrawl(nearest, this._player);
          }
        } catch (e) { console.error('[TrawlManager] Auto-start trawl:', e); }
      }
    });

    // Self-manage toggle via keyboard TRAWL_START (Batch 3 decoupling)
    eventBus.on(Events.TRAWL_START, (data) => {
      // Skip if this is a notification from TrawlManager auto-start (has cluster)
      if (data && data.cluster) return;
      // Skip if notification from an arm (has armId) — only handle keyboard commands
      if (data && data.armId) return;

      // Toggle trawl mode via Shift+G
      if (this.active) {
        const report = this.endTrawl();
        eventBus.emit(Events.TRAWL_END, report);
        return;
      }

      // Start a new trawl — pick the densest cluster
      if (this._debrisField && this._player) {
        try {
          const clusters = this._debrisField.getDebrisClusters();
          if (clusters.length > 0) {
            this.startTrawl(clusters[0], this._player);
          } else {
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: 'No debris clusters detected — cannot start trawl.',
              priority: 'warning',
            });
          }
        } catch (e) {
          console.error('[TrawlManager] Trawl toggle:', e);
        }
      }
    });

    /** @type {Map<number, number>} Track when each target entered range (id → trawlTime) */
    this._targetEntryTimes = new Map();

    // Wire up ARM_CAPTURED listener for catch registration
    this._onArmCaptured = this._onArmCaptured.bind(this);
  }

  /**
   * Begin trawling through a cluster.
   * @param {object} cluster - Cluster from DebrisField.getDebrisClusters()
   * @param {object} playerSatellite - The player's mothership
   */
  startTrawl(cluster, playerSatellite) {
    this.activeCluster = cluster;
    this.active = true;
    this.catchesThisPass = 0;
    this.opportunitiesThisPass = 0;
    this.trawlTime = 0;
    this._idleTimer = 0;
    this._windowWarned.clear();
    this._targetEntryTimes.clear();
    this.targetsInRange = [];

    eventBus.on(Events.ARM_CAPTURED, this._onArmCaptured);

    eventBus.emit(Events.TRAWL_START, { cluster });

    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Entering ${cluster.name} — ${cluster.count} targets. Begin fishing.`,
      priority: 'info',
    });

    console.log(`[TrawlManager] Trawl started: ${cluster.id} (${cluster.count} targets)`);
  }

  /**
   * Update trawl state — called each frame during gameplay states.
   * @param {number} dt - Game delta time
   * @param {object} data - { playerPos, debrisField, armManager }
   */
  update(dt, data) {
    // Cache refs for self-management (auto-start, toggle) — Batch 3
    if (data.player) this._player = data.player;
    if (data.debrisField) this._debrisField = data.debrisField;

    if (!this.active) return;

    this.trawlTime += dt;

    // Apply traversal: advance mothership along orbit
    if (data.player && data.player.orbit) {
      // Move the mothership's true anomaly forward at traverse speed
      // traverseSpeed is in scene units/s; convert to orbital angle change
      // angular speed = traverseSpeed / orbitRadius (radians/s)
      const orbitRadius = data.player.orbit.semiMajorAxis || 66.71; // scene units
      const angularIncrement = (this.traverseSpeed / orbitRadius) * dt * 10; // TIME_SCALE_GAMEPLAY = 10
      data.player.orbit.trueAnomaly += angularIncrement;
      // Wrap true anomaly to [0, 2π]
      if (data.player.orbit.trueAnomaly > 2 * Math.PI) {
        data.player.orbit.trueAnomaly -= 2 * Math.PI;
      }
    }

    const { playerPos, debrisField, armManager } = data;
    if (!playerPos || !debrisField) return;

    // Determine max tether range (based on largest deployed/available arm)
    const maxRange = this._getMaxTetherRange(armManager);
    const maxRangeScene = maxRange * Constants.SCENE_SCALE; // km to scene units

    // Get all debris within tether sphere
    const nearbyDebris = debrisField.getDebrisNear(playerPos, maxRangeScene);

    // Track targets entering/exiting range
    this._updateTargetWindows(nearbyDebris, maxRangeScene, playerPos);

    // Track idle time for auto-end (no targets in range for IDLE_TIMEOUT seconds)
    if (this.targetsInRange.length > 0) {
      this._idleTimer = 0;
    } else {
      this._idleTimer += dt;
      if (this._idleTimer >= Constants.TRAWLING.IDLE_TIMEOUT) {
        console.log(`[TrawlManager] Auto-ending trawl: no targets for ${Constants.TRAWLING.IDLE_TIMEOUT}s`);
        const report = this.endTrawl();
        eventBus.emit(Events.TRAWL_END, report);
      }
    }
  }

  /**
   * Track which targets just entered range, are in range, or just left.
   * Also check for window-closing warnings.
   * @private
   * @param {Array} nearbyDebris - Debris within range
   * @param {number} maxRange - Max tether range in scene units
   * @param {THREE.Vector3} playerPos - Player position
   */
  _updateTargetWindows(nearbyDebris, maxRange, playerPos) {
    const nearbyIds = new Set(nearbyDebris.map(d => d.id));
    const prevIds = new Set(this.targetsInRange.map(d => d.id));
    const maxRangeKm = maxRange / Constants.SCENE_SCALE;

    // New targets entering range
    for (const debris of nearbyDebris) {
      if (!prevIds.has(debris.id)) {
        this.opportunitiesThisPass++;

        // Record entry time
        this._targetEntryTimes.set(debris.id, this.trawlTime);

        // Estimate window duration based on traverse speed and range
        const distKm = debris.distance / Constants.SCENE_SCALE;
        const estimatedWindowSec = this._estimateWindowDuration(distKm, maxRangeKm);

        eventBus.emit(Events.TRAWL_TARGET_ENTERING, {
          debrisId: debris.id,
          type: debris.type,
          mass: debris.mass,
          distanceKm: distKm,
          estimatedWindowSec: estimatedWindowSec,
        });
      }
    }

    // Targets leaving range
    for (const prev of this.targetsInRange) {
      if (!nearbyIds.has(prev.id)) {
        const entryTime = this._targetEntryTimes.get(prev.id);
        const windowDuration = entryTime !== undefined ? this.trawlTime - entryTime : 0;
        this._targetEntryTimes.delete(prev.id);

        eventBus.emit(Events.TRAWL_TARGET_EXITED, {
          debrisId: prev.id,
          windowDurationSec: windowDuration,
        });
        // Clean up window warning tracking
        this._windowWarned.delete(prev.id);
      }
    }

    // Check for window-closing warnings (beyond threshold of max range = drifting out)
    const closingThreshold = Constants.TRAWLING.WINDOW_CLOSING_THRESHOLD;
    for (const debris of nearbyDebris) {
      const dist = debris.distance; // already computed by getDebrisNear
      const ratio = dist / maxRange;
      if (ratio > closingThreshold && !this._windowWarned.has(debris.id)) {
        this._windowWarned.add(debris.id);

        const entryTime = this._targetEntryTimes.get(debris.id) || this.trawlTime;
        const timeInRange = this.trawlTime - entryTime;
        const remainingRatio = 1 - ratio;
        // Rough estimate: remaining time ≈ timeInRange × remainingRatio / (1 - remainingRatio)
        const remainingTimeSec = remainingRatio > 0.01
          ? (timeInRange * remainingRatio / (1 - remainingRatio))
          : 0;

        eventBus.emit(Events.TRAWL_TARGET_WINDOW_CLOSING, {
          debrisId: debris.id,
          remainingRatio: remainingRatio,
          remainingTimeSec: remainingTimeSec,
        });
      }
    }

    this.targetsInRange = nearbyDebris;
  }

  /**
   * Estimate how long a target will remain in tether range.
   * Based on current traverse speed and distance from player.
   * @param {number} currentDistKm - current distance in km
   * @param {number} maxRangeKm - max tether range in km
   * @returns {number} estimated seconds in range
   */
  _estimateWindowDuration(currentDistKm, maxRangeKm) {
    if (this.traverseSpeed <= 0) return 999;
    // Chord length through sphere at this distance
    // Approximate: window ≈ 2 * sqrt(maxRange² - dist²) / traverseSpeedKm
    const traverseSpeedKm = this.traverseSpeed / Constants.SCENE_SCALE;
    const distRatio = Math.min(currentDistKm / maxRangeKm, 0.99);
    const chordHalf = maxRangeKm * Math.sqrt(1 - distRatio * distRatio);
    const windowSec = (2 * chordHalf) / (traverseSpeedKm || 0.0001);
    return Math.round(windowSec);
  }

  /**
   * Get the maximum tether range in km based on available arms.
   * @private
   * @param {object} armManager - ArmManager instance
   * @returns {number} Max range in km
   */
  _getMaxTetherRange(armManager) {
    if (!armManager) return 2.0; // default 2 km (Weaver V3)
    let maxKm = 0.5; // minimum = Spinner range
    for (const arm of armManager.arms) {
      const rangeM = arm.config.tetherMax; // meters
      const rangeKm = rangeM / 1000;
      if (rangeKm > maxKm) maxKm = rangeKm;
    }
    return maxKm;
  }

  /**
   * End the current trawl pass.
   * @returns {object} Sweep report data
   */
  endTrawl() {
    eventBus.off(Events.ARM_CAPTURED, this._onArmCaptured);

    const report = {
      clusterName: this.activeCluster ? this.activeCluster.name : 'Unknown',
      clusterId: this.activeCluster ? this.activeCluster.id : null,
      catches: this.catchesThisPass,
      opportunities: this.opportunitiesThisPass,
      catchRatio: this.opportunitiesThisPass > 0
        ? this.catchesThisPass / this.opportunitiesThisPass : 0,
      trawlTimeSec: this.trawlTime,
    };

    // Adapt speed for next pass (persistent — carries over between passes)
    this._adaptSpeed(report.catchRatio);

    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Trawl complete: ${report.catches}/${report.opportunities} captured (${Math.round(report.catchRatio * 100)}%)`,
      priority: 'info',
    });

    // Emit sweep complete event for RewardSystem to compile full report
    eventBus.emit(Events.TRAWL_SWEEP_COMPLETE, {
      duration: this.trawlTime,
      targetsEntered: this.opportunitiesThisPass,
    });

    console.log(`[TrawlManager] Trawl ended: ${report.catches}/${report.opportunities} ` +
      `(${Math.round(report.catchRatio * 100)}%) in ${report.trawlTimeSec.toFixed(0)}s`);

    this.active = false;
    this.activeCluster = null;
    this.targetsInRange = [];
    this._windowWarned.clear();
    this._targetEntryTimes.clear();

    return report;
  }

  /**
   * Adapt traverse speed based on performance.
   * @private
   * @param {number} catchRatio - Ratio of catches to opportunities (0-1)
   */
  _adaptSpeed(catchRatio) {
    const T = Constants.TRAWLING;

    if (catchRatio > T.SPEED_MAINTAIN_HIGH) {
      // Player crushing it → speed up
      this.traverseSpeed *= T.SPEED_ADAPT_UP;
      eventBus.emit(Events.COMMS_MESSAGE, {
        speaker: 'HOUSTON',
        text: 'Increasing sweep speed. Let\'s push it.',
        priority: 1,
      });
    } else if (catchRatio < T.SPEED_MAINTAIN_LOW) {
      // Player struggling → slow down
      this.traverseSpeed *= T.SPEED_ADAPT_DOWN;
      eventBus.emit(Events.COMMS_MESSAGE, {
        speaker: 'HOUSTON',
        text: 'Slowing sweep. Take your time.',
        priority: 1,
      });
    }

    // Clamp
    this.traverseSpeed = Math.max(T.SPEED_MIN, Math.min(T.SPEED_MAX, this.traverseSpeed));
  }

  /**
   * Handler for ARM_CAPTURED events during trawl.
   * @private
   * @param {object} data - ARM_CAPTURED event data
   */
  _onArmCaptured(data) {
    if (!this.active) return;
    this.registerCatch();
  }

  /**
   * Register a catch during trawl.
   * Called when ARM_CAPTURED fires while trawling.
   */
  registerCatch() {
    this.catchesThisPass++;
  }
}

/** Singleton instance */
export const trawlManager = new TrawlManager();
export default TrawlManager;
