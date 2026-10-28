/**
 * TrawlManager.js — mothership traverse through debris clusters: autopilot approach, traverse speed, tether window tracking,
 * adaptive difficulty.
 * @module systems/TrawlManager
 */

import { Constants } from '../core/Constants.js';
import { TimeAuthority } from './TimeAuthority.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { clamp } from '../core/MathUtil.js';

export class TrawlManager {
  constructor() {
    this.activeCluster = null;

    /** @type {number} Traverse speed in scene units/s */
    this.traverseSpeed = Constants.TRAWLING.TRAVERSE_SPEED_DEFAULT;

    this.active = false;

    this.targetsInRange = [];

    this.catchesThisPass = 0;

    /** @type {number} Opportunities this pass (targets that entered range) */
    this.opportunitiesThisPass = 0;

    this.trawlTime = 0;

    /** @type {number} Seconds since last target was in range (for auto-end) */
    this._idleTimer = 0;

    this._windowWarned = new Set();

    eventBus.on(Events.GAME_RESET, () => {
      if (this.active) {
        try { this.endTrawl(); } catch (e) { /* ignore */ }
      }
    });

    // Cached refs from update() for the self-managed toggle
    /** @type {object|null} */ this._player = null;
    /** @type {object|null} */ this._debrisField = null;

    // Shift+G toggles trawl (TRAWL_START from the keyboard) and is the only entry point. There is no GAME_STATE_CHANGE →
    // ORBITAL_VIEW auto-start: it silently moved the mothership on entering orbital view, conflicting with the guided
    // active-capture loop new players are taught. Hidden from the new-player path until an advanced "Dragnet" mission surfaces it.
    eventBus.on(Events.TRAWL_START, (data) => {
      // Skip notifications from TrawlManager's own auto-start (has cluster) or from an arm (has armId): keyboard commands only
      if (data && data.cluster) return;
      if (data && data.armId) return;

      if (this.active) {
        const report = this.endTrawl();
        eventBus.emit(Events.TRAWL_END, report);
        return;
      }

      if (this._debrisField && this._player) {
        try {
          const clusters = this._debrisField.getDebrisClusters();
          if (clusters.length > 0) {
            this.startTrawl(clusters[0], this._player);
          } else {
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: 'No debris clusters detected. Cannot start trawl.',
              priority: 'warning',
            });
          }
        } catch (e) {
          console.error('[TrawlManager] Trawl toggle:', e);
        }
      }
    });

    // External abort request (e.g. autopilot override): end the sweep cleanly so TRAWL_SWEEP_COMPLETE fires and dependent
    // flags self-clear.
    eventBus.on(Events.TRAWL_ABORT, () => {
      if (!this.active) return;
      const report = this.endTrawl();
      eventBus.emit(Events.TRAWL_END, report);
    });

    /** @type {Map<number, number>} Track when each target entered range (id → trawlTime) */
    this._targetEntryTimes = new Map();

    this._onArmCaptured = this._onArmCaptured.bind(this);
  }

  /** @param {object} cluster from DebrisField.getDebrisClusters() */
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
      text: `Entering ${cluster.name}. ${cluster.count} targets. Begin fishing.`,
      priority: 'info',
    });

    console.log(`[TrawlManager] Trawl started: ${cluster.id} (${cluster.count} targets)`);
  }

  /** @param {object} data { playerPos, debrisField, armManager } */
  update(dt, data) {
    if (data.player) this._player = data.player;
    if (data.debrisField) this._debrisField = data.debrisField;

    if (!this.active) return;

    this.trawlTime += dt;

    // Watchdog: a cluster with no live members can never "complete" through normal play; end it so TRAWL_SWEEP_COMPLETE fires
    // and the autopilot trawl-block clears.
    if (this.activeCluster && Array.isArray(this.activeCluster.targets)) {
      const anyAlive = this.activeCluster.targets.some(t => t && t.alive);
      if (!anyAlive) {
        console.log('[TrawlManager] Auto-ending trawl: cluster has no live targets');
        const report = this.endTrawl();
        eventBus.emit(Events.TRAWL_END, report);
        return;
      }
    }

    if (data.player && data.player.orbit) {
      // Advance the mothership's true anomaly: angular speed = traverseSpeed (scene units/s) / orbitRadius (rad/s).
      const orbitRadius = data.player.orbit.semiMajorAxis || 66.71; // scene units
      // Traverse runs at the base game rate, routed through the ONE authority (BASE_SCALE === Constants.TIME_SCALE_GAMEPLAY).
      const angularIncrement = (this.traverseSpeed / orbitRadius) * dt * TimeAuthority.BASE_SCALE;
      data.player.orbit.trueAnomaly += angularIncrement;
      if (data.player.orbit.trueAnomaly > 2 * Math.PI) {
        data.player.orbit.trueAnomaly -= 2 * Math.PI;
      }
    }

    const { playerPos, debrisField, armManager } = data;
    if (!playerPos || !debrisField) return;

    const maxRange = this._getMaxTetherRange(armManager);
    const maxRangeScene = maxRange * Constants.SCENE_SCALE; // km to scene units

    const nearbyDebris = debrisField.getDebrisNear(playerPos, maxRangeScene);

    this._updateTargetWindows(nearbyDebris, maxRangeScene, playerPos);

    // Auto-end after IDLE_TIMEOUT seconds with no targets in range
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

  /** Track which targets entered / are in / left range, plus window-closing warnings. @param {number} maxRange scene units */
  _updateTargetWindows(nearbyDebris, maxRange, playerPos) {
    const nearbyIds = new Set(nearbyDebris.map(d => d.id));
    const prevIds = new Set(this.targetsInRange.map(d => d.id));
    const maxRangeKm = maxRange / Constants.SCENE_SCALE;

    for (const debris of nearbyDebris) {
      if (!prevIds.has(debris.id)) {
        this.opportunitiesThisPass++;

        this._targetEntryTimes.set(debris.id, this.trawlTime);

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

    for (const prev of this.targetsInRange) {
      if (!nearbyIds.has(prev.id)) {
        const entryTime = this._targetEntryTimes.get(prev.id);
        const windowDuration = entryTime !== undefined ? this.trawlTime - entryTime : 0;
        this._targetEntryTimes.delete(prev.id);

        eventBus.emit(Events.TRAWL_TARGET_EXITED, {
          debrisId: prev.id,
          windowDurationSec: windowDuration,
        });
        this._windowWarned.delete(prev.id);
      }
    }

    // Window closing: past the threshold fraction of max range = drifting out
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

  /** Seconds a target stays in tether range: chord through the sphere at this distance ÷ traverse speed (distances in km). */
  _estimateWindowDuration(currentDistKm, maxRangeKm) {
    if (this.traverseSpeed <= 0) return 999;
    const traverseSpeedKm = this.traverseSpeed / Constants.SCENE_SCALE;
    const distRatio = Math.min(currentDistKm / maxRangeKm, 0.99);
    const chordHalf = maxRangeKm * Math.sqrt(1 - distRatio * distRatio);
    const windowSec = (2 * chordHalf) / (traverseSpeedKm || 0.0001);
    return Math.round(windowSec);
  }

  /** Max tether range in km from the available arms. @private */
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

    // Speed adapts for the next pass and persists between passes
    this._adaptSpeed(report.catchRatio);

    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Trawl complete: ${report.catches}/${report.opportunities} captured (${Math.round(report.catchRatio * 100)}%)`,
      priority: 'info',
    });

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

  _adaptSpeed(catchRatio) {
    const T = Constants.TRAWLING;

    if (catchRatio > T.SPEED_MAINTAIN_HIGH) {
      this.traverseSpeed *= T.SPEED_ADAPT_UP;
      eventBus.emit(Events.COMMS_MESSAGE, {
        speaker: 'HOUSTON',
        text: 'Increasing sweep speed. Let\'s push it.',
        priority: 1,
      });
    } else if (catchRatio < T.SPEED_MAINTAIN_LOW) {
      this.traverseSpeed *= T.SPEED_ADAPT_DOWN;
      eventBus.emit(Events.COMMS_MESSAGE, {
        speaker: 'HOUSTON',
        text: 'Slowing sweep. Take your time.',
        priority: 1,
      });
    }

    this.traverseSpeed = clamp(this.traverseSpeed, T.SPEED_MIN, T.SPEED_MAX);
  }

  _onArmCaptured(data) {
    if (!this.active) return;
    this.registerCatch();
  }

  registerCatch() {
    this.catchesThisPass++;
  }
}

export const trawlManager = new TrawlManager();
export default TrawlManager;
