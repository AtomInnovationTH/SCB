/**
 * @module systems/MissionEventSystem — dynamic mid-mission events: listens for gameplay events and triggers
 * complications with comms messages and gameplay effects, gated by the current mission profile.
 *   1. SCAN_DISCOVERY + hydrazine → DEBRIS_HAZARD_REVEALED
 *   2. SCAN_DISCOVERY + synergy metals → SYNERGY_OPPORTUNITY
 *   3. KESSLER_CASCADE → CASCADE_THREAT
 *   4. WEATHER_EFFECT_START (sensorRange < 1) → WEATHER_MISSION_EFFECT
 *   5. Multiple CONJUNCTION_WARNING → CLUSTER_CONJUNCTION
 * All timing constants live in Constants.MISSION_EVENTS.
 */

import { Constants } from '../core/Constants.js';
import { eventBus }  from '../core/EventBus.js';
import { Events }    from '../core/Events.js';
import { fetchData } from '../core/dataUrl.js';

export class MissionEventSystem {
  constructor() {
    this._missionNumber = 1;

    /** @private Current mission profile (Constants.MISSIONS.PROFILES) */
    this._missionProfile = Constants.MISSIONS.PROFILES[0];

    /** @private Active synergy opportunity timers — synergyName → expiry timestamp */
    this._synergyTimers = new Map();

    /** @private Conjunction warnings within the accumulation window */
    this._conjunctionAlertCount = 0;

    this._eventCooldownMs = Constants.MISSION_EVENTS.COOLDOWN_MS;

    /** @private Last fire timestamp per event type */
    this._lastEventTime = {};

    this._unsubs = [];

    this._newsEvents = [];           // loaded from news-events.json
    this._triggeredNewsIds = new Set(); // prevent re-trigger
    this._totalCaptures = 0;         // running capture count
    this._newsLoaded = false;        // true once JSON loaded

    this._setupListeners();
  }


  /** @private */
  _setupListeners() {
    const u = (evt, fn) => this._unsubs.push(eventBus.on(evt, fn));

    u(Events.MISSION_START, (d) => {
      this._missionNumber = d.missionNumber;
      this._missionProfile = d.profile;
    });

    // Triggers 1+2: hydrazine hazard / synergy opportunity on scan
    u(Events.SCAN_DISCOVERY, (d) => this._onScanDiscovery(d));

    u(Events.KESSLER_CASCADE, (d) => this._onKesslerCascade(d));

    u(Events.WEATHER_EFFECT_START, (d) => this._onWeatherStart(d));

    // Trigger 5: accumulate conjunction warnings
    u(Events.CONJUNCTION_WARNING, (d) => this._onConjunctionWarning(d));

    // News missions: count captures
    this._unsubs.push(eventBus.on(Events.INTERACTION_CAPTURE, () => {
      this._totalCaptures++;
      this._checkNewsUnlocks();
    }));

    // Deorbits count as captures too (debris removed = success)
    this._unsubs.push(eventBus.on(Events.INTERACTION_DEORBIT, () => {
      this._totalCaptures++;
      this._checkNewsUnlocks();
    }));

    u(Events.GAME_RESET, () => this.reset());
  }


  /** Reset all state for new game. */
  reset() {
    this._missionNumber = 1;
    this._missionProfile = Constants.MISSIONS.PROFILES[0];
    this._synergyTimers.clear();
    this._conjunctionAlertCount = 0;
    this._lastEventTime = {};
    this._triggeredNewsIds = new Set();
    this._totalCaptures = 0;
  }

  /** Per-frame: clean expired synergy timers (wall-clock, so `_dt` is unused). */
  update(_dt) {
    const now = Date.now();
    for (const [name, expiry] of this._synergyTimers) {
      if (now >= expiry) {
        this._synergyTimers.delete(name);
      }
    }
  }

  dispose() {
    for (const unsub of this._unsubs) unsub();
    this._unsubs.length = 0;
  }


  /** @private */
  _onScanDiscovery(data) {
    if (!data) return;

    if (this._missionProfile.hydrazine !== false) {
      const hasHydrazine = (data.salvage && data.salvage.hydrazine > 0) ||
                           data.type === 'rocketBody';

      if (hasHydrazine && this._canFire('DEBRIS_HAZARD_REVEALED')) {
        this._markFired('DEBRIS_HAZARD_REVEALED');

        const bonusPts = Constants.MISSION_EVENTS.HYDRAZINE_BONUS_POINTS;

        eventBus.emit(Events.DEBRIS_HAZARD_REVEALED, {
          debrisId: data.debrisId || null,
          type: data.type,
          hazardType: 'hydrazine',
        });

        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'HOUSTON',
          text: `CAUTION: Hydrazine detected in target! Maintain 500 m approach distance. Hazard bonus +${bonusPts}.`,
          priority: 'warning',
        });

        eventBus.emit(Events.SCORING_AWARD, {
          points: bonusPts,
          reason: 'Hydrazine hazard bonus',
        });
      }
    }

    this._checkSynergyOpportunity(data);
  }


  /** @private */
  _checkSynergyOpportunity(data) {
    if (!this._missionProfile.synergy) return;

    const metals = (data.salvage && data.salvage.metals) || data.metals;
    if (!metals || !Array.isArray(metals) || metals.length === 0) return;
    if (!this._canFire('SYNERGY_OPPORTUNITY')) return;

    const synergies = Constants.SALVAGE_SYNERGIES;
    if (!synergies) return;

    for (const syn of synergies) {
      const matching = syn.metals.filter(m => metals.includes(m));
      if (matching.length > 0 && matching.length < syn.metals.length) {
        const missing = syn.metals.filter(m => !metals.includes(m));
        if (this._synergyTimers.has(syn.name)) continue; // already active

        this._markFired('SYNERGY_OPPORTUNITY');

        const durationMs = Constants.MISSION_EVENTS.SYNERGY_TIMER_MS;
        this._synergyTimers.set(syn.name, Date.now() + durationMs);

        eventBus.emit(Events.SYNERGY_OPPORTUNITY, {
          synergyName: syn.name,
          matchedMetals: matching,
          missingMetals: missing,
          bonusPoints: syn.points,
          expiresMs: durationMs,
        });

        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'HOUSTON',
          text: `Synergy opportunity: "${syn.name}". Collect ${missing.join(', ')} within 5 min for +${syn.points} bonus.`,
          priority: 'info',
        });
        break; // Only one synergy alert per scan
      }
    }
  }


  /** @private */
  _onKesslerCascade(data) {
    if (!this._missionProfile.kessler) return;
    if (!this._canFire('CASCADE_THREAT')) return;

    this._markFired('CASCADE_THREAT');
    const fc = (data && data.fragmentCount) || 0;

    eventBus.emit(Events.CASCADE_THREAT, { fragmentCount: fc });

    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'HOUSTON',
      text: `CASCADE WARNING: ${fc || 'Unknown'} fragments generated. Recommend immediate repositioning.`,
      priority: 'critical',
    });
  }


  /** @private */
  _onWeatherStart(data) {
    if (!this._missionProfile.weather) return;
    if (!data || !data.effects) return;
    if (data.effects.sensorRange >= 1) return; // Not severe
    if (!this._canFire('WEATHER_MISSION_EFFECT')) return;

    this._markFired('WEATHER_MISSION_EFFECT');
    const reductionPct = Math.round((1 - data.effects.sensorRange) * 100);

    eventBus.emit(Events.WEATHER_MISSION_EFFECT, {
      type: data.type,
      sensorReduction: data.effects.sensorRange,
      duration: data.duration,
    });

    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'HOUSTON',
      text: `${data.name || data.type}: Sensor range reduced ${reductionPct}% for ${Math.round((data.duration || 600) / 60)} min.`,
      priority: 'warning',
    });
  }


  /** @private */
  _onConjunctionWarning(_data) {
    if (!this._missionProfile.conjunction) return;
    this._conjunctionAlertCount++;

    const minAlerts = Constants.MISSION_EVENTS.MIN_CONJUNCTION_ALERTS;
    if (this._conjunctionAlertCount >= minAlerts && this._canFire('CLUSTER_CONJUNCTION')) {
      const count = this._conjunctionAlertCount;
      this._markFired('CLUSTER_CONJUNCTION');
      this._conjunctionAlertCount = 0;

      eventBus.emit(Events.CLUSTER_CONJUNCTION, { alertCount: count });

      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        text: 'WARNING: Multiple conjunction alerts in your altitude band. Recommend immediate departure or altitude change.',
        priority: 'critical',
      });
    }

    // Decay counter after accumulation window
    const windowMs = Constants.MISSION_EVENTS.CONJUNCTION_ACCUMULATION_WINDOW_MS;
    setTimeout(() => {
      this._conjunctionAlertCount = Math.max(0, this._conjunctionAlertCount - 1);
    }, windowMs);
  }


  /** Load news events from static JSON, once after construction. Offline-first: local data/, falls back to empty. */
  async loadNewsEvents() {
    try {
      const resp = await fetchData('data/news-events.json');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      this._newsEvents = Array.isArray(data.events) ? data.events : [];
      this._newsLoaded = true;
    } catch (e) {
      console.warn('[MissionEventSystem] Could not load news-events.json:', e.message);
      this._newsEvents = [];
      this._newsLoaded = true;
    }
  }

  /** Unlock news events whose capture count is reached; called after each capture/deorbit. */
  _checkNewsUnlocks() {
    for (const evt of this._newsEvents) {
      if (this._triggeredNewsIds.has(evt.id)) continue;
      if (this._totalCaptures >= evt.unlockCaptures) {
        this._triggeredNewsIds.add(evt.id);
        this._triggerNewsEvent(evt);
      }
    }
  }

  /** Fire a news event: emit the event. */
  _triggerNewsEvent(evt) {
    eventBus.emit(Events.NEWS_EVENT_TRIGGERED, {
      eventId: evt.id,
      name: evt.name,
      headline: evt.headline,
      date: evt.date,
      bounty: evt.bounty,
      partner: evt.partner,
      debrisName: evt.debris ? evt.debris.name : 'unknown',
      debris: evt.debris
    });
  }

  /** Test access */
  get newsEvents() { return this._newsEvents; }
  get triggeredNewsIds() { return this._triggeredNewsIds; }
  get totalCaptures() { return this._totalCaptures; }
  set totalCaptures(n) { this._totalCaptures = n; }

  _injectNewsEvents(events) {
    this._newsEvents = events;
    this._newsLoaded = true;
  }


  /** @private True when the event type's cooldown has elapsed. */
  _canFire(eventType) {
    const last = this._lastEventTime[eventType] || 0;
    return Date.now() - last >= this._eventCooldownMs;
  }

  /**
   * Record that an event type just fired.
   * @param {string} eventType
   * @private
   */
  _markFired(eventType) {
    this._lastEventTime[eventType] = Date.now();
  }
}
