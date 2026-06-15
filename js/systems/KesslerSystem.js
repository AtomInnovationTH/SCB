/**
 * KesslerSystem.js — Kessler cascade tracking and fragment monitoring
 *
 * Responsibilities:
 *   • Track total orbital fragment count
 *   • Process fragmentation events (tool-induced, collision-generated)
 *   • Emit graduated warnings as thresholds approach
 *   • Trigger game-over when cascade limit is breached
 *   • Model passive secondary-collision probability
 *
 * @module systems/KesslerSystem
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { gameState } from '../core/GameState.js';
import { audioSystem } from './AudioSystem.js';

// ============================================================================
// WARNING THRESHOLDS  (fraction of cascadeThreshold)
// ============================================================================

const WARNING_LEVELS = [
  { fraction: 0.5, level: 'CAUTION' },
  { fraction: 0.7, level: 'WARNING' },
  { fraction: 0.9, level: 'CRITICAL' },
];

// ============================================================================
// CLASS
// ============================================================================

export class KesslerSystem {
  constructor() {
    /** @type {number} Running fragment tally */
    this.fragmentCount = 0;

    /** @type {number} Fragments required for cascade game-over */
    this.cascadeThreshold = Constants.KESSLER_FRAGMENT_LIMIT; // 50

    /** @type {boolean} Has the cascade been triggered? */
    this.cascadeActive = false;

    /** @type {Array<object>} Chronological fragmentation log */
    this.fragmentEvents = [];

    /** @type {Array<{fraction:number, level:string, emitted:boolean}>} */
    this._warnings = WARNING_LEVELS.map(w => ({ ...w, emitted: false }));

    /** @type {number} Whipple shield hit absorption (from upgrades) */
    this.shieldHits = 0;

    // Sprint 3: Mission-number gating (replaces tutorial stage gate)
    this._missionNumber = 1;
    eventBus.on(Events.SCORE_UPDATE, (d) => {
        if (typeof d?.debrisCleared === 'number') {
            this._missionNumber = Math.floor(d.debrisCleared / 5) + 1;
        }
    });

    // ST-4.C: Mission profile gate — additional suppression from mission profiles
    this._kesslerAllowed = false;
    eventBus.on(Events.MISSION_START, (d) => {
        this._missionNumber = d.missionNumber;
        this._kesslerAllowed = d.profile.kessler;
    });

    this._setupListeners();

    // Self-reset via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.GAME_RESET, () => this.reset());

    // Also reset on roguelite continue (GAMEOVER_CONTINUE does partial reset, not GAME_RESET)
    eventBus.on(Events.GAMEOVER_CONTINUE, () => this.reset());

    // Self-manage shield absorption (Batch 3 decoupling)
    // When a collision/kessler event fires, check shields first.
    // If absorbed → comms + audio. If not → emit COLLISION_GAME_OVER for GFM.
    this._setupShieldAbsorption();
    // Note: upgrade routing remains in GFM.applyUpgradeEffect() via imported singleton
    // to support the GAMEOVER_CONTINUE re-apply path.
  }

  /**
   * Wire shield absorption listeners for GAME_KESSLER, GAME_COLLISION, ACTIVE_SAT_COLLISION.
   * Absorbs hits when shieldHits > 0, otherwise emits COLLISION_GAME_OVER.
   * @private
   */
  _setupShieldAbsorption() {
    eventBus.on(Events.GAME_KESSLER, () => {
      if (!gameState.isGameplay()) return;
      this._tryAbsorbOrGameOver('kessler', 'Kessler fragment');
    });

    eventBus.on(Events.GAME_COLLISION, (data) => {
      if (data.type !== 'activeSatellite' || !gameState.isGameplay()) return;
      this._tryAbsorbOrGameOver('collision', 'collision');
    });

    eventBus.on(Events.ACTIVE_SAT_COLLISION, () => {
      if (!gameState.isGameplay()) return;
      this._tryAbsorbOrGameOver('collision', 'satellite collision');
    });
  }

  /**
   * Attempt shield absorption. If shields available, absorb + notify.
   * Otherwise emit COLLISION_GAME_OVER for GameFlowManager.
   * @param {string} reason - 'kessler' | 'collision'
   * @param {string} label - Human-readable label for comms message
   * @private
   */
  _tryAbsorbOrGameOver(reason, label) {
    if (this.shieldHits > 0) {
      this.shieldHits--;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `⚡ WHIPPLE SHIELD absorbed ${label}. ${this.shieldHits} hit${this.shieldHits !== 1 ? 's' : ''} remaining`,
        priority: 'warning',
      });
      if (audioSystem) audioSystem.playWarning(0.5);
      return;
    }
    eventBus.emit(Events.COLLISION_GAME_OVER, { reason });
  }

  // ======================================================================
  // PUBLIC API
  // ======================================================================

  /**
   * Record a fragmentation event (from any source).
   * @param {object}  params
   * @param {number}  params.fragments – new fragments generated
   * @param {string}  [params.source='unknown'] – 'tool' | 'collision' | 'cascade'
   * @param {*}       [params.debrisId]
   */
  onFragmentation({ fragments, source = 'unknown', debrisId = null }) {
    if (fragments <= 0) return;

    this.fragmentCount += fragments;

    this.fragmentEvents.push({
      timestamp: Date.now(),
      fragments,
      source,
      debrisId,
      totalAfter: this.fragmentCount,
    });

    eventBus.emit(Events.KESSLER_FRAGMENTS_ADDED, {
      newFragments: fragments,
      total: this.fragmentCount,
      threshold: this.cascadeThreshold,
      source,
    });

    this._checkWarnings();
    this.checkCascade();
  }

  /**
   * Model a debris-debris collision using a simplified NASA breakup model.
   * @param {object} debris1 – must have `.mass`
   * @param {object} debris2 – must have `.mass`
   */
  onCollision(debris1, debris2) {
    const mass1 = debris1.mass || 10;
    const mass2 = debris2.mass || 10;
    const relVel = Constants.LEO_AVG_COLLISION_VEL; // km/s
    const totalMass = mass1 + mass2;

    // Kinetic energy → J/g to classify catastrophic vs. cratering
    const kineticEnergy = 0.5 * totalMass * (relVel * 1000) ** 2;
    const energyPerGram = kineticEnergy / (totalMass * 1000);

    let fragmentCount;
    if (energyPerGram >= Constants.CATASTROPHIC_THRESHOLD) {
      fragmentCount = Math.floor(0.1 * totalMass ** 0.75);
    } else {
      fragmentCount = Math.max(1, Math.floor(0.01 * totalMass ** 0.5));
    }

    this.onFragmentation({
      fragments: fragmentCount,
      source: 'collision',
      debrisId: `${debris1.id}-${debris2.id}`,
    });
  }

  /**
   * Check whether the cascade threshold has been breached.
   * @returns {boolean}
   */
  checkCascade() {
    if (this.cascadeActive) return true;

    if (this.fragmentCount >= this.cascadeThreshold) {
      this.cascadeActive = true;

      eventBus.emit(Events.KESSLER_CASCADE, {
        fragmentCount: this.fragmentCount,
        threshold: this.cascadeThreshold,
      });

      // Fire the game-level event that main.js already listens to
      eventBus.emit(Events.GAME_KESSLER, {
        fragments: this.fragmentCount,
      });

      return true;
    }

    return false;
  }

  /**
   * Cascade risk as a 0→1 fraction.
   * @returns {number}
   */
  getCascadeRisk() {
    return Math.min(1.0, this.fragmentCount / this.cascadeThreshold);
  }

  /**
   * HUD-ready status snapshot.
   * @returns {object}
   */
  getStatus() {
    return {
      fragmentCount: this.fragmentCount,
      cascadeThreshold: this.cascadeThreshold,
      cascadeRisk: this.getCascadeRisk(),
      cascadeActive: this.cascadeActive,
      recentEvents: this.fragmentEvents.slice(-5),
    };
  }

  /**
   * Per-frame update: passive secondary-collision probability.
   * When fragment density is high enough, random secondary
   * fragmentation events can occur organically.
   * @param {number} dt – seconds
   */
  update(dt) {
    if (this.fragmentCount <= 10 || this.cascadeActive) return;

    // Quadratic probability scaled to threshold proximity
    const riskFactor = (this.fragmentCount / this.cascadeThreshold) ** 2;
    const collisionProb = riskFactor * 0.001 * dt;

    if (Math.random() < collisionProb) {
      const newFragments = Math.floor(Math.random() * 3) + 1;
      this.onFragmentation({
        fragments: newFragments,
        source: 'cascade',
      });
    }
  }

  // ======================================================================
  // UPGRADES
  // ======================================================================

  /**
   * Apply a shop upgrade affecting Kessler awareness or hull protection.
   * @param {object} data - { effect: string, value: * }
   */
  applyUpgrade(data) {
    switch (data.effect) {
      case 'kesslerWarning':
        // Enable forwarding of cascade warnings to comms panel
        if (!this._warningsEnabled) {
          this._warningsEnabled = true;
          eventBus.on(Events.KESSLER_WARNING, (warnData) => {
            eventBus.emit(Events.COMMS_MESSAGE, {
              text: `⚠ Cascade ${warnData.level}: ${warnData.fragmentCount}/${warnData.threshold} fragments`,
              priority: warnData.level === 'CRITICAL' ? 'danger' : 'warning',
            });
          });
        }
        break;
      case 'shieldHits':
        // Whipple shield: absorb fragment hits before game-over
        this.shieldHits = (this.shieldHits || 0) + data.value;
        break;
    }
  }

  /**
   * Reset for new game / retry.
   */
  reset() {
    this.fragmentCount = 0;
    this.cascadeActive = false;
    this.fragmentEvents = [];
    this._warnings = WARNING_LEVELS.map(w => ({ ...w, emitted: false }));
    this._kesslerAllowed = false;    // ST-4.C: reset mission profile gate
    this._missionNumber = 1;
    // Note: shieldHits NOT reset — they come from upgrades (re-applied after reset)
  }

  // ======================================================================
  // PRIVATE
  // ======================================================================

  /** @private Emit graduated warnings as risk rises */
  _checkWarnings() {
    // Sprint 3: Suppress Kessler warnings until mission 4
    if (this._missionNumber < Constants.SKILL_GATES.KESSLER_MIN_MISSION) return;

    // ST-4.C: Mission profile gate — BOTH skill gate AND profile must pass
    if (!this._kesslerAllowed) return;

    const risk = this.getCascadeRisk();
    for (const w of this._warnings) {
      if (risk >= w.fraction && !w.emitted) {
        w.emitted = true;
        eventBus.emit(Events.KESSLER_WARNING, {
          level: w.level,
          risk,
          fragmentCount: this.fragmentCount,
          threshold: this.cascadeThreshold,
        });
      }
    }
  }

  /** @private */
  _setupListeners() {
    // Tool-induced fragmentation
    eventBus.on(Events.INTERACTION_FRAGMENTATION, (data) => {
      this.onFragmentation({
        fragments: data.fragments || 1,
        source: 'tool',
        debrisId: data.debrisId,
      });
    });

    // Debris-debris collisions (from future physics system)
    eventBus.on(Events.DEBRIS_COLLISION, (data) => {
      if (data.debris1 && data.debris2) {
        this.onCollision(data.debris1, data.debris2);
      }
    });

    // Active-satellite collision → significant fragment burst
    eventBus.on(Events.ACTIVE_SAT_COLLISION, (data) => {
      this.onFragmentation({
        fragments: Math.floor(Math.random() * 20) + 10,
        source: 'collision',
        debrisId: data?.satelliteId,
      });
    });
  }
}

/** Singleton instance (imported by GameFlowManager for upgrade routing) */
export const kesslerSystem = new KesslerSystem();
export default KesslerSystem;
