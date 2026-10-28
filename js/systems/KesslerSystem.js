/**
 * @module systems/KesslerSystem — Kessler cascade tracking and fragment monitoring:
 *   • track total orbital fragment count
 *   • process fragmentation events (tool-induced, collision-generated)
 *   • emit graduated warnings as thresholds approach
 *   • trigger game-over when the cascade limit is breached
 *   • model passive secondary-collision probability
 */

import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { gameState } from '../core/GameState.js';
import { audioSystem } from './AudioSystem.js';

// Warning thresholds (fraction of cascadeThreshold)
const WARNING_LEVELS = [
  { fraction: 0.5, level: 'CAUTION' },
  { fraction: 0.7, level: 'WARNING' },
  { fraction: 0.9, level: 'CRITICAL' },
];


export class KesslerSystem {
  constructor() {
    this.fragmentCount = 0;

    this.cascadeThreshold = Constants.KESSLER_FRAGMENT_LIMIT; // 50

    this.cascadeActive = false;

    this.fragmentEvents = [];

    this._warnings = WARNING_LEVELS.map(w => ({ ...w, emitted: false }));

    this.shieldHits = 0;

    // Mission-number gating: warnings stay off until SKILL_GATES.KESSLER_MIN_MISSION
    this._missionNumber = 1;
    eventBus.on(Events.SCORE_UPDATE, (d) => {
        if (typeof d?.debrisCleared === 'number') {
            this._missionNumber = Math.floor(d.debrisCleared / Constants.MISSIONS.DEBRIS_PER_MISSION) + 1;  // T8 SSOT
        }
    });

    // Mission profile gate — additional suppression from mission profiles
    this._kesslerAllowed = false;
    eventBus.on(Events.MISSION_START, (d) => {
        this._missionNumber = d.missionNumber;
        this._kesslerAllowed = d.profile.kessler;
    });

    this._setupListeners();

    // Self-reset via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.GAME_RESET, () => this.reset());

    // Also on roguelite continue (partial reset, no GAME_RESET)
    eventBus.on(Events.GAMEOVER_CONTINUE, () => this.reset());

    // Self-managed shield absorption: absorbed → comms + audio, else COLLISION_GAME_OVER for GFM. Upgrade routing
    // stays in GFM.applyUpgradeEffect() (imported singleton) to support the GAMEOVER_CONTINUE re-apply path.
    this._setupShieldAbsorption();
  }

  /** @private Shield absorption listeners for GAME_KESSLER, GAME_COLLISION, ACTIVE_SAT_COLLISION. */
  _setupShieldAbsorption() {
    eventBus.on(Events.GAME_KESSLER, () => {
      if (!gameState.isGameplay()) return;
      this._tryAbsorbOrGameOver('kessler', 'Kessler fragment');
    });

    eventBus.on(Events.GAME_COLLISION, (data) => {
      if (!gameState.isGameplay()) return;
      if (data.type === 'activeSatellite') {
        this._tryAbsorbOrGameOver('collision', 'collision');
        return;
      }
      // Hard debris contact from CollisionAvoidanceSystem: same absorb-then-game-over path, so the Whipple Shield
      // covers debris strikes too.
      if (data.source === 'debris') {
        this._tryAbsorbOrGameOver('debris', 'debris impact');
        return;
      }
    });

    eventBus.on(Events.ACTIVE_SAT_COLLISION, () => {
      if (!gameState.isGameplay()) return;
      this._tryAbsorbOrGameOver('collision', 'satellite collision');
    });
  }

  /**
   * @private Absorb the hit if shields remain (comms + audio), else emit COLLISION_GAME_OVER for GameFlowManager.
   * @param {string} reason - 'kessler' | 'collision'
   * @param {string} label - label for the comms message
   */
  _tryAbsorbOrGameOver(reason, label) {
    if (this.shieldHits > 0) {
      this.shieldHits--;
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: `WHIPPLE SHIELD absorbed ${label}. ${this.shieldHits} hit${this.shieldHits !== 1 ? 's' : ''} remaining`,
        priority: 'warning',
      });
      if (audioSystem) audioSystem.playWarning(0.5);
      return;
    }
    eventBus.emit(Events.COLLISION_GAME_OVER, { reason });
  }


  /**
   * Record a fragmentation event (from any source).
   * @param {number} params.fragments – new fragments generated
   * @param {string} [params.source='unknown'] – 'tool' | 'collision' | 'cascade'
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

  /** Model a debris-debris collision with a simplified NASA breakup model. Debris needs `.mass`. */
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

  checkCascade() {
    if (this.cascadeActive) return true;

    if (this.fragmentCount >= this.cascadeThreshold) {
      this.cascadeActive = true;

      eventBus.emit(Events.KESSLER_CASCADE, {
        fragmentCount: this.fragmentCount,
        threshold: this.cascadeThreshold,
      });

      eventBus.emit(Events.GAME_KESSLER, {
        fragments: this.fragmentCount,
      });

      return true;
    }

    return false;
  }

  getCascadeRisk() {
    return Math.min(1.0, this.fragmentCount / this.cascadeThreshold);
  }

  getStatus() {
    return {
      fragmentCount: this.fragmentCount,
      cascadeThreshold: this.cascadeThreshold,
      cascadeRisk: this.getCascadeRisk(),
      cascadeActive: this.cascadeActive,
      recentEvents: this.fragmentEvents.slice(-5),
    };
  }

  /** Per-frame: passive secondary-collision probability; at high fragment density random fragmentation can occur. */
  update(dt) {
    if (this.fragmentCount <= 10 || this.cascadeActive) return;

    // Quadratic in threshold proximity
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

  applyUpgrade(data) {
    switch (data.effect) {
      case 'kesslerWarning':
        if (!this._warningsEnabled) {
          this._warningsEnabled = true;
          eventBus.on(Events.KESSLER_WARNING, (warnData) => {
            eventBus.emit(Events.COMMS_MESSAGE, {
              // The level word is already in the sentence; the explicit ALERT channel keeps the classification.
              text: `Cascade ${warnData.level}: ${warnData.fragmentCount}/${warnData.threshold} fragments`,
              channel: 'ALERT',
              priority: warnData.level === 'CRITICAL' ? 'danger' : 'warning',
            });
          });
        }
        break;
      case 'shieldHits':
        this.shieldHits = (this.shieldHits || 0) + data.value;
        break;
    }
  }

  reset() {
    this.fragmentCount = 0;
    this.cascadeActive = false;
    this.fragmentEvents = [];
    this._warnings = WARNING_LEVELS.map(w => ({ ...w, emitted: false }));
    this._kesslerAllowed = false;    // reset mission profile gate
    this._missionNumber = 1;
    // shieldHits NOT reset — they come from upgrades (re-applied after reset)
  }

  _checkWarnings() {
    // Warnings stay off until SKILL_GATES.KESSLER_MIN_MISSION
    if (this._missionNumber < Constants.SKILL_GATES.KESSLER_MIN_MISSION) return;

    // BOTH the skill gate AND the mission profile must pass
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

  _setupListeners() {
    eventBus.on(Events.INTERACTION_FRAGMENTATION, (data) => {
      this.onFragmentation({
        fragments: data.fragments || 1,
        source: 'tool',
        debrisId: data.debrisId,
      });
    });

    // Debris-debris collisions
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

/** Singleton (imported by GameFlowManager for upgrade routing) */
export const kesslerSystem = new KesslerSystem();
export default KesslerSystem;
