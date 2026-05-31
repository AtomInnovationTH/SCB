/**
 * CommsSystem.js — Ground station communications system
 * Delivers immersive, procedurally-generated messages during gameplay.
 * Message types: Space Weather, Kessler Events, Launch Alerts,
 * Mission Updates, Player Status.
 *
 * ST-5.1: 6-channel classification + coalescing layer.
 * @module systems/CommsSystem
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { audioSystem } from './AudioSystem.js';
import timerManager from './TimerManager.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Maximum messages retained in log */
const MAX_MESSAGES = 20;

/** Message priorities */
export const CommsPriority = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
};

/** Flavor message interval range (seconds of game time) */
const FLAVOR_MIN_INTERVAL = 30;
const FLAVOR_MAX_INTERVAL = 120;

/** Event-based message cooldowns (seconds) */
const EVENT_COOLDOWN = 15;

// ============================================================================
// ST-5.1: CHANNEL CLASSIFICATION — Pure helpers (CJS-exportable for tests)
// ============================================================================

const COMMS = Constants.COMMS || {};
const VALID_CHANNELS = new Set(COMMS.CHANNELS || ['CMD', 'ALERT', 'HOUSTON', 'SCI', 'FLAVOR', 'MISSION']);
const DEFAULT_CHANNEL = COMMS.DEFAULT_CHANNEL || 'FLAVOR';

/**
 * Classify a message into one of the 6 channels.
 * Priority: explicit channel → source heuristic → text heuristic → FLAVOR.
 *
 * @param {string} [source] — message source field (e.g. 'HOUSTON', 'SDA')
 * @param {object} [payload] — full message payload (may contain `channel`, `text`)
 * @returns {string} One of Constants.COMMS.CHANNELS
 */
function sourceToChannel(source, payload) {
  const p = payload || {};

  // 1. Explicit channel field — validate against known channels
  if (p.channel) {
    const ch = String(p.channel).toUpperCase();
    return VALID_CHANNELS.has(ch) ? ch : DEFAULT_CHANNEL;
  }

  // 2. Source-based heuristics
  const src = (source || '').toUpperCase();
  if (src === 'HOUSTON') return 'HOUSTON';
  if (src === 'MISSION' || src === 'MISSION_EVENT') return 'MISSION';
  if (src === 'BANGALORE' || src === 'HASSAN') return 'HOUSTON';
  if (src === 'NEWS') return 'MISSION';

  // 3. Conservative text-based heuristics (well-commented, secondary to explicit channel)
  const text = (p.text || '').toUpperCase();
  // ALERT: messages starting with warning-like prefixes
  if (/^(ALERT:|WARNING:|⚠|CONJUNCTION)/.test(text)) return 'ALERT';
  // SCI: discovery/codex/identification
  if (/^(DISCOVERY|CODEX|IDENTIFIED)/.test(text)) return 'SCI';
  // CMD: arm deploy/reel/detach confirmations
  if (/^(DEPLOY|REEL|DETACH|COMMS: DEPLOY|COMMS: FISH|COMMS: RECALL)/.test(text)) return 'CMD';

  // 4. Default
  return DEFAULT_CHANNEL;
}

/**
 * Coalescing predicate: given recent message timestamps + channels,
 * determine if the new message should be coalesced.
 *
 * @param {Array<{channel: string, timestamp: number}>} recentWindow — messages in the coalesce window
 * @param {string} newChannel — channel of the incoming message
 * @param {number} thresholdCount — how many same-channel msgs trigger coalescing
 * @returns {{ shouldCoalesce: boolean, count: number }}
 */
function shouldCoalesce(recentWindow, newChannel, thresholdCount) {
  const threshold = thresholdCount || COMMS.COALESCE_THRESHOLD_COUNT || 3;
  const sameChannel = recentWindow.filter(m => m.channel === newChannel);
  // Count includes the new message being added
  const count = sameChannel.length + 1;
  return {
    shouldCoalesce: count >= threshold,
    count,
  };
}

/**
 * Delegation 4 (2026-05-31) — Browser-playtest Bug 4 helper (strengthened).
 *
 * During onboarding the comms panel must show *only* the Director's own
 * Houston script (boot → handshake → arrows → …).  **Everything else is
 * noise** — EnvironmentSystem MMOD alerts, SpaceWeatherSystem, SubsystemEvents,
 * GameFlowManager first-time comms, CommsSystem flavour templates, etc.
 *
 * The check is simple: if the message payload carries `_onboarding: true`
 * (stamped by [`OnboardingDirector._emitComms()`](js/systems/OnboardingDirector.js:748))
 * it is allowed.  Every other message is suppressed.
 *
 * @param {object} [data] — full message payload (may have `_onboarding` flag)
 * @returns {boolean} true → message is noise and should be dropped.
 */
export function isOnboardingNoise(data) {
  if (data && data._onboarding) return false;   // Director's own line — pass
  return true;                                   // everything else — drop
}

// ============================================================================
// MESSAGE TEMPLATES
// ============================================================================

/** Space weather messages (procedural) */
const SPACE_WEATHER_TEMPLATES = [
  {
    priority: CommsPriority.CRITICAL,
    source: 'NOAA SWPC',
    template: '⚠ Coronal Mass Ejection approaching. Enhanced radiation in {time} min. Seek Earth shadow for panel protection.',
    effect: 'solarStorm',
  },
  {
    priority: CommsPriority.WARNING,
    source: 'NOAA SWPC',
    template: 'Geomagnetic storm index Kp={kp}. Magnetic capture effectiveness +50% but orbit prediction accuracy -30%.',
    effect: 'geoStorm',
  },
  {
    priority: CommsPriority.INFO,
    source: 'MISSION CTRL',
    template: 'Entering Earth shadow. Duration: {dur} min. Battery power only.',
    effect: 'eclipse',
  },
  {
    priority: CommsPriority.WARNING,
    source: 'NOAA SWPC',
    template: 'Solar proton event detected. Solar panel degradation risk elevated for next {time} min.',
    effect: 'solarProton',
  },
];

/** Kessler event messages */
const KESSLER_TEMPLATES = [
  {
    priority: CommsPriority.CRITICAL,
    source: 'Space Domain Awareness',
    template: '⚠ CRITICAL: Collision detected at {alt}km. {count} new debris fragments generated. Updating catalog.',
  },
  {
    priority: CommsPriority.WARNING,
    source: 'NORAD',
    template: 'Conjunction risk 1 in {odds} between {obj1} and {obj2} in {hours} hours.',
  },
  {
    priority: CommsPriority.WARNING,
    source: '18th Space Defense Squadron',
    template: 'Debris cloud expanding at {alt}km. Recommend avoidance maneuver if orbital altitude matches.',
  },
];

/** Launch notification templates */
const LAUNCH_TEMPLATES = [
  {
    priority: CommsPriority.INFO,
    source: 'LAUNCH ALERT',
    template: 'Rocket Lab Electron, T-{time} min. Debris corridor: {alt}km, {inc}° inclination. Maintain clearance.',
  },
  {
    priority: CommsPriority.INFO,
    source: 'LAUNCH ALERT',
    template: 'SpaceX Starlink deployment. {count} objects releasing at {alt}km. Stand by for catalog update.',
  },
  {
    priority: CommsPriority.INFO,
    source: 'LAUNCH ALERT',
    template: 'Soyuz launch from Baikonur. Ascent corridor: {alt}km, {inc}° inclination. Window: {time} min.',
  },
  {
    priority: CommsPriority.WARNING,
    source: 'LAUNCH ALERT',
    template: 'URGENT: Falcon 9 second stage disposal imminent at {alt}km. Clear debris corridor.',
  },
];

/** Mission update templates */
const MISSION_TEMPLATES = [
  {
    priority: CommsPriority.INFO,
    source: 'GROUND STN',
    template: 'Target {target} tumble rate updated to {tumble}°/s. Recommend laser detumble first.',
  },
  {
    priority: CommsPriority.INFO,
    source: 'LeoLabs',
    template: 'Characterization data received for {target}. Bonus +50 points.',
  },
  {
    priority: CommsPriority.WARNING,
    source: 'ClearSpace',
    template: 'Contract update: Priority capture requested at {alt}km. Bonus multiplier ×2 active.',
  },
  {
    priority: CommsPriority.INFO,
    source: 'GROUND STN',
    template: 'Telemetry nominal. All systems green. Continue operations.',
  },
  {
    priority: CommsPriority.INFO,
    source: 'ESOC',
    template: 'Orbital decay detected on {target}. Natural re-entry in {days} days if uncaptured.',
  },
];

/** Player status templates (triggered by events) */
const PLAYER_STATUS_TEMPLATES = {
  lowXenon: {
    priority: CommsPriority.WARNING,
    source: 'SPACECRAFT',
    template: 'Warning: Xenon reserves below {pct}%. Consider resupply at orbital depot.',
  },
  lowColdGas: {
    priority: CommsPriority.WARNING,
    source: 'SPACECRAFT',
    template: 'Cold gas reserves low: {val} units remaining. Limit evasive maneuvers.',
  },
  lowBattery: {
    priority: CommsPriority.WARNING,
    source: 'SPACECRAFT',
    template: 'Battery level critical: {pct}%. Reduce tool usage. Seek sunlight.',
  },
  debrisCleared: {
    priority: CommsPriority.INFO,
    source: 'HOUSTON',
    template: 'Achievement: {count} debris objects cleared! Space environment stability +{stability}%.',
  },
  evasionPerformed: {
    priority: CommsPriority.WARNING,
    source: 'SPACECRAFT',
    template: 'Collision avoidance maneuver performed. {name} passed at {dist}m.',
  },
};

/** Generic flavor messages */
const FLAVOR_MESSAGES = [
  { source: 'HOUSTON', text: 'Orbital environment looking good. Keep up the great work, Cowboy.' },
  { source: 'MISSION CTRL', text: 'Sun transit in 12 minutes. Optimal solar charging window approaching.' },
  { source: 'GROUND STN', text: 'Next ground contact window: Svalbard station in 8 minutes.' },
  { source: 'SDA', text: 'Atmospheric drag models updated. Low-altitude debris decay rates revised upward.' },
  { source: 'HOUSTON', text: 'Reminder: Document all capture operations for post-mission analysis.' },
  { source: 'ESOC', text: 'ESA Space Sustainability Index updated. Your contributions noted.' },
  { source: 'NORAD', text: 'Routine catalog maintenance complete. 347 objects re-correlated.' },
  { source: 'GROUND STN', text: 'Magnetic field measurements nominal. Proceeding with scheduled survey.' },
  { source: 'JAXA', text: 'Cooperative tracking data received. Shared catalog now includes Asian sector objects.' },
  { source: 'HOUSTON', text: 'Weather report: Clear skies over recovery zone. Good conditions for de-orbit operations.' },
  { source: 'LeoLabs', text: 'New radar track: Uncatalogued object detected at 620km. Adding to survey queue.' },
  { source: 'MISSION CTRL', text: 'Crew activity report filed. All mission objectives on track.' },
  { source: 'SDA', text: 'Space fence detection: Small debris cluster at 780km altitude. Monitoring.' },
  { source: 'HOUSTON', text: 'Thermal model updated. Spacecraft temperatures within nominal range.' },
  { source: 'GROUND STN', text: 'Signal-to-noise ratio excellent. Maintaining high-bandwidth downlink.' },
];

// === ST-8.4: ISRO Ground Station Personas ===
const BANGALORE_TEMPLATES = [
  { source: 'BANGALORE', text: 'ISTRAC Bangalore AOS — tracking {target}, signal nominal', priority: 'INFO' },
  { source: 'BANGALORE', text: 'Bangalore confirms orbit determination, {orbits} orbits to intercept window', priority: 'INFO' },
  { source: 'BANGALORE', text: 'ISTRAC TTC: telemetry stream healthy, all subsystems nominal', priority: 'INFO' },
  { source: 'BANGALORE', text: 'Bangalore handover: transferring tracking to {nextStation}', priority: 'INFO' },
  { source: 'BANGALORE', text: 'ISTRAC Bangalore: debris radar cross-section consistent with catalog entry', priority: 'INFO' },
];

const HASSAN_TEMPLATES = [
  { source: 'HASSAN', text: 'MCF Hassan: GEO target acquired on 32m dish', priority: 'INFO' },
  { source: 'HASSAN', text: 'Hassan deep-space: signal locked, round-trip {rtDelay}ms', priority: 'INFO' },
  { source: 'HASSAN', text: 'MCF confirms orbit-raise maneuver complete, circularizing', priority: 'INFO' },
  { source: 'HASSAN', text: 'Hassan tracking: GEO approach corridor confirmed clear', priority: 'INFO' },
];

const HANDOFF_DIALOGUE = [
  { from: 'HOUSTON', text: 'Houston: handing off to Bangalore ISTRAC — good hunting.' },
  { from: 'BANGALORE', text: 'ISTRAC Bangalore: Roger, we have the conn. Tracking nominal.' },
];

const NEWS_BOUNTY_TEMPLATES = [
  { source: 'NEWS', text: '[{date} NEWS] {headline}', priority: 'WARNING' },
  { source: 'NEWS', text: 'Bounty posted: ₹{bounty} — target {debrisName}', priority: 'INFO' },
];

// ============================================================================
// COMMS SYSTEM
// ============================================================================

export class CommsSystem {
  constructor() {
    /** @type {Array<{ timestamp: number, source: string, text: string, priority: string, channel: string, id: number }>} */
    this.messages = [];

    /** @type {number} Next message ID */
    this._nextId = 0;

    /** @type {Array<{channel: string, timestamp: number}>} ST-5.1: sliding window for coalescing */
    this._coalesceWindow = [];

    /** @type {number} Game time elapsed */
    this._gameTime = 0;

    /** @type {number} Time until next flavor message */
    this._nextFlavorTime = this._randomFlavorInterval();

    /** @type {number} Time until next launch alert */
    this._nextLaunchTime = 180 + Math.random() * 300; // 3-8 min

    /** @type {number} Time until next weather event */
    this._nextWeatherTime = 120 + Math.random() * 240; // 2-6 min

    /** @type {number} Time until next mission update */
    this._nextMissionTime = 60 + Math.random() * 120;

    /** @type {Map<string, number>} Cooldown timers for event-based messages */
    this._cooldowns = new Map();

    /** @type {Function|null} Callback for new messages (used by HUD) */
    this.onMessage = null;

    /** @type {boolean} Active gameplay flag */
    this._active = false;

    this._isroHandoffDone = false;  // ST-8.4: tracks whether ISRO handoff dialogue has played

    // Active effects
    this.activeEffects = {
      solarStorm: false,
      geoStorm: false,
      solarStormTimer: 0,
      geoStormTimer: 0,
    };

    /**
     * Delegation 4 (2026-05-31) — Browser-playtest Bug 4:
     * While the OnboardingDirector pipeline is active we suppress the
     * non-essential "atmosphere" comms (space-weather, environment, news
     * flavor, kessler updates, generic FLAVOR/SCI/MISSION INFO traffic)
     * that would otherwise drown out the Houston onboarding script.
     * The flag is toggled by ONBOARDING_STARTED / ONBOARDING_COMPLETE.
     * @type {boolean}
     */
    this._onboardingActive = false;

    this._setupEventListeners();

    // Self-reset via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.GAME_RESET, () => this.reset());

    // Delegation 4 — onboarding-noise gate.
    if (Events.ONBOARDING_STARTED) {
      eventBus.on(Events.ONBOARDING_STARTED, () => { this._onboardingActive = true; });
    }
    if (Events.ONBOARDING_COMPLETE) {
      eventBus.on(Events.ONBOARDING_COMPLETE, () => { this._onboardingActive = false; });
    }

    // Self-manage lifecycle via GAME_STATE_CHANGE
    // (decoupled from GameFlowManager.transitionToState start/stop/reset calls)
    const ACTIVE_STATES = new Set(['ORBITAL_VIEW', 'APPROACH', 'INTERACTION']);
    eventBus.on(Events.GAME_STATE_CHANGE, ({ from, to }) => {
      if (ACTIVE_STATES.has(to) && !this._active) {
        this.start();
      } else if (!ACTIVE_STATES.has(to)) {
        // Continue path (GAME_OVER → SHOP): full reset to clear stale messages
        if (from === 'GAME_OVER') {
          this.reset();
        } else if (this._active) {
          this.stop();
        }
      }
    });

    // Self-manage: forward COMMS_SEND events to addMessage
    // (decoupled from GameFlowManager COMMS_SEND handler)
    eventBus.on(Events.COMMS_SEND, (data) => {
      if (data && data.source && data.text) {
        const pri = data.priority === 'WARNING' ? 'WARNING'
                  : data.priority === 'CRITICAL' ? 'CRITICAL' : 'INFO';
        this.addMessage(pri, data.source, data.text);
      }
    });

    // S9-B: Self-listener to persist externally-emitted COMMS_MESSAGE events
    // (from ScoringSystem, RewardSystem, GameFlowManager, TrawlManager, etc.)
    // Stores directly without calling addMessage() to avoid double audio/emit.
    eventBus.on(Events.COMMS_MESSAGE, (data) => {
      if (!data || data._internal) return;
      // External emitters use 'source', 'sender', or 'speaker' — normalize
      // §0.1 fix: default missing source to 'SYSTEM' so capture-loop comms render
      const rawSrc = data.source || data.sender || data.speaker;
      if (!rawSrc) console.debug('[CommsSystem] sourceless emit defaulted to SYSTEM:', data.text);
      const src = rawSrc || 'SYSTEM';
      if (!data.text) return;

      // ST-5.1: Classify channel
      const channel = sourceToChannel(src, data);

      // Delegation 4 (2026-05-31) — Browser-playtest Bug 4 (strengthened):
      // During onboarding, only the Director's own tagged messages pass.
      if (this._onboardingActive && isOnboardingNoise(data)) {
        return;
      }

      const now = new Date();
      const tsStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
      const nowMs = Date.now();

      // ST-5.1: Coalescing — check recent window for same-channel flood
      const windowMs = COMMS.COALESCE_WINDOW_MS || 2000;
      this._coalesceWindow = this._coalesceWindow.filter(e => (nowMs - e.timestamp) < windowMs);
      const coal = shouldCoalesce(this._coalesceWindow, channel, COMMS.COALESCE_THRESHOLD_COUNT);
      this._coalesceWindow.push({ channel, timestamp: nowMs });

      if (coal.shouldCoalesce) {
        // Replace last same-channel messages with a summary line
        // Remove prior same-channel msgs from this window that are in messages[]
        const summaryText = `× ${coal.count} ${channel.toLowerCase()} messages queued`;
        // Find and remove the last same-channel messages that were part of this burst
        let removed = 0;
        for (let i = this.messages.length - 1; i >= 0 && removed < coal.count - 1; i--) {
          if (this.messages[i].channel === channel) {
            this.messages.splice(i, 1);
            removed++;
          }
        }
        const msg = {
          id: this._nextId++,
          timestamp: tsStr,
          source: src,
          text: summaryText,
          priority: data.priority || CommsPriority.INFO,
          channel,
          age: 0,
        };
        this.messages.push(msg);
        while (this.messages.length > MAX_MESSAGES) this.messages.shift();
        if (this.onMessage) this.onMessage(msg);
        return;
      }

      const msg = {
        id: this._nextId++,
        timestamp: tsStr,
        source: src,
        text: data.text,
        priority: data.priority || CommsPriority.INFO,
        channel,
        age: 0,
      };

      this.messages.push(msg);
      while (this.messages.length > MAX_MESSAGES) {
        this.messages.shift();
      }

      // Notify HUD (no sound replay, no re-emit)
      if (this.onMessage) {
        this.onMessage(msg);
      }
    });
  }

  // ==========================================================================
  // EVENT LISTENERS
  // ==========================================================================

  /** @private */
  _setupEventListeners() {
    // Kessler events
    eventBus.on(Events.DEBRIS_KESSLER, (data) => {
      if (!this._canSend('kessler')) return;
      const tmpl = KESSLER_TEMPLATES[0];
      const altKm = data.position ?
        Math.round(Math.sqrt(data.position.x ** 2 + data.position.y ** 2 + data.position.z ** 2) / Constants.SCENE_SCALE - Constants.EARTH_RADIUS_KM) :
        Math.round(400 + Math.random() * 600);
      this.addMessage(
        tmpl.priority,
        tmpl.source,
        tmpl.template
          .replace('{alt}', altKm)
          .replace('{count}', data.count)
      );
    });

    // Player low fuel
    eventBus.on(Events.PLAYER_LOW_XENON, (data) => {
      if (!this._canSend('lowXenon')) return;
      const tmpl = PLAYER_STATUS_TEMPLATES.lowXenon;
      const pct = data && data.level ? Math.round(data.level / Constants.XENON_FUEL_MAX * 100) : 10;
      this.addMessage(tmpl.priority, tmpl.source, tmpl.template.replace('{pct}', pct));
    });

    eventBus.on(Events.PLAYER_LOW_BATTERY, (data) => {
      if (!this._canSend('lowBattery')) return;
      const tmpl = PLAYER_STATUS_TEMPLATES.lowBattery;
      const pct = data && data.level ? Math.round(data.level / Constants.BATTERY_MAX * 100) : 10;
      this.addMessage(tmpl.priority, tmpl.source, tmpl.template.replace('{pct}', pct));
    });

    // Debris cleared
    eventBus.on(Events.DEBRIS_CLEARED, (data) => {
      if (!this._canSend('debrisCleared')) return;
      const tmpl = PLAYER_STATUS_TEMPLATES.debrisCleared;
      const stability = Math.min(100, data.count * 2);
      this.addMessage(
        tmpl.priority,
        tmpl.source,
        tmpl.template
          .replace('{count}', data.count)
          .replace('{stability}', stability)
      );
    });

    // Active satellite proximity
    eventBus.on(Events.ACTIVE_SAT_PROXIMITY, (data) => {
      if (!this._canSend('evasion')) return;
      const tmpl = PLAYER_STATUS_TEMPLATES.evasionPerformed;
      this.addMessage(
        tmpl.priority,
        tmpl.source,
        tmpl.template
          .replace('{name}', data.name)
          .replace('{dist}', (data.distanceKm * 1000).toFixed(0))
      );
    });

    // Collision evasion
    eventBus.on(Events.COLLISION_EVASION, (data) => {
      if (!this._canSend('evasionManeuver')) return;
      this.addMessage(
        CommsPriority.CRITICAL,
        'SPACECRAFT',
        `⚡ Emergency evasion! ${data.name} at ${(data.distance / Constants.SCENE_SCALE * 1000).toFixed(0)}m. Cold gas expended.`
      );
    });

    // Score updates for milestone messages
    eventBus.on(Events.SCORE_UPDATE, (data) => {
      if (data.debrisCleared && data.debrisCleared % 10 === 0 && data.debrisCleared > 0) {
        if (!this._canSend('milestone')) return;
        this.addMessage(
          CommsPriority.INFO,
          'HOUSTON',
          `Milestone reached: ${data.debrisCleared} debris objects remediated. Score: ${data.total.toLocaleString()}. Outstanding work.`
        );
      }
    });

    // Capture/deorbit success
    eventBus.on(Events.INTERACTION_CAPTURE, (data) => {
      if (!this._canSend('captureSuccess')) return;
      this.addMessage(
        CommsPriority.INFO,
        'GROUND STN',
        `Capture confirmed. Object secured. +${data.points} points. Catalog updated.`
      );
    });

    eventBus.on(Events.INTERACTION_DEORBIT, (data) => {
      if (!this._canSend('deorbitSuccess')) return;
      this.addMessage(
        CommsPriority.INFO,
        'SDA',
        `Deorbit burn successful. Object on re-entry trajectory. +${data.points} points.`
      );
    });

    // ST-8.3.6: FEEP metal switch announcement
    eventBus.on(Events.FEEP_METAL_CHANGED, (data) => {
      const metalData = Constants.ION_THRUSTER_METALS ? Constants.ION_THRUSTER_METALS[data.metal] : null;
      if (!metalData) return;
      const indiumMax = Constants.ION_THRUSTER_METALS.indium ? Constants.ION_THRUSTER_METALS.indium.ispMax : 19000;
      const ispPct = Math.round(((metalData.ispMax / indiumMax) - 1) * 100);
      const sign = ispPct >= 0 ? '+' : '';
      this.addMessage(
        CommsPriority.INFO,
        'CMD',
        `FEEP switched to ${data.metal} — ISP ${sign}${ispPct}%`
      );
    });

    // ST-8.4: News event ticker — route to MISSION channel
    eventBus.on(Events.NEWS_EVENT_TRIGGERED, (data) => {
      const dateStr = data.date || '????-??-??';
      const headline = data.headline || data.name || 'Unknown event';
      this.addMessage('WARNING', 'NEWS', `[${dateStr} NEWS] ${headline}`);

      // Delayed bounty announcement (2 seconds later)
      const bountyStr = (data.bounty || 0).toLocaleString();
      const debrisName = data.debrisName || 'unknown';
      timerManager.setTimeout(() => {
        this.addMessage('INFO', 'NEWS', `Bounty posted: ₹${bountyStr} — target ${debrisName}`);
      }, 2000, { owner: this });
    });

    // ST-8.4: ISRO handoff dialogue — Houston→Bangalore on first BANGALORE comms
    this._isroHandoffDone = false;

    // ISRO handoff: triggered when first BANGALORE-sourced message comes through
    // We detect this by listening for COMMS_MESSAGE with BANGALORE source
    eventBus.on(Events.COMMS_MESSAGE, (data) => {
      if (this._isroHandoffDone) return;
      if (data._internal) return; // skip self-emitted
      const src = (data.source || '').toUpperCase();
      if (src === 'BANGALORE' || src === 'HASSAN') {
        this._isroHandoffDone = true;
        // Queue handoff dialogue
        timerManager.setTimeout(() => {
          this.addMessage('INFO', 'HOUSTON', 'Houston: handing off to Bangalore ISTRAC — good hunting.');
        }, 500, { owner: this });
        timerManager.setTimeout(() => {
          this.addMessage('INFO', 'BANGALORE', 'ISTRAC Bangalore: Roger, we have the conn. Tracking nominal.');
        }, 2500, { owner: this });
      }
    });

    // === Phase 1: Capture-flow UX comms (§4 items 2-5) ===

    // §4 item 2: TETHER_SNAP → CRITICAL comms + ALERT channel (BUG-C fix)
    eventBus.on(Events.TETHER_SNAP, (data) => {
      this.addMessage('CRITICAL', data?.armId || 'SYSTEM', 'TETHER SEVERED — arm lost. Payload jettisoned. Reload not possible.', { channel: 'ALERT' });
    });

    // §4 item 3: ARM_RETURNED (captured) → Docking comms
    eventBus.on(Events.ARM_RETURNED, (data) => {
      if (data?.captured === true) {
        this.addMessage('INFO', data.armId || 'SYSTEM', 'Docking — 3 s.', { channel: 'CMD' });
      }
    });

    // §4 item 3: CROSSBOW_RELOAD_COMPLETE → Spring re-charged comms
    eventBus.on(Events.CROSSBOW_RELOAD_COMPLETE, (data) => {
      this.addMessage('INFO', data?.armId || 'SYSTEM', 'Spring re-charged — ready for next deploy.', { channel: 'CMD' });
    });

    // §4 item 4: STATION_KEEP_ENTERED → ON STATION comms with key hints
    eventBus.on(Events.STATION_KEEP_ENTERED, (data) => {
      const standoff = data?.standoffR != null ? Math.round(data.standoffR) : '?';
      const targetId = data?.targetId != null ? data.targetId : '?';
      this.addMessage('INFO', data?.armId || 'SYSTEM', `ON STATION — ${standoff}m standoff on debris #${targetId}. [V] view · [F] capture.`, { channel: 'CMD' });
    });
  }

  // ==========================================================================
  // UPDATE
  // ==========================================================================

  /**
   * Per-frame update — generates timed messages.
   * @param {number} dt - Real-time delta (seconds)
   * @param {object} [gameData] - Optional game state reference
   */
  update(dt, gameData) {
    if (!this._active) return;

    const gameDt = dt * Constants.TIME_SCALE_GAMEPLAY;
    this._gameTime += gameDt;

    // Update cooldowns
    for (const [key, time] of this._cooldowns) {
      this._cooldowns.set(key, time - dt);
      if (time - dt <= 0) this._cooldowns.delete(key);
    }

    // Update active effects
    if (this.activeEffects.solarStorm) {
      this.activeEffects.solarStormTimer -= dt;
      if (this.activeEffects.solarStormTimer <= 0) {
        this.activeEffects.solarStorm = false;
        this.addMessage(CommsPriority.INFO, 'NOAA SWPC', 'Solar storm subsiding. Radiation levels returning to normal.');
      }
    }
    if (this.activeEffects.geoStorm) {
      this.activeEffects.geoStormTimer -= dt;
      if (this.activeEffects.geoStormTimer <= 0) {
        this.activeEffects.geoStorm = false;
        this.addMessage(CommsPriority.INFO, 'NOAA SWPC', 'Geomagnetic activity returning to quiet levels.');
      }
    }

    // --- Flavor messages ---
    this._nextFlavorTime -= dt;
    if (this._nextFlavorTime <= 0) {
      this._nextFlavorTime = this._randomFlavorInterval();
      this._sendFlavorMessage();
    }

    // --- Launch alerts ---
    this._nextLaunchTime -= dt;
    if (this._nextLaunchTime <= 0) {
      this._nextLaunchTime = 180 + Math.random() * 420; // 3-10 min
      this._sendLaunchAlert();
    }

    // --- Space weather events ---
    this._nextWeatherTime -= dt;
    if (this._nextWeatherTime <= 0) {
      this._nextWeatherTime = 180 + Math.random() * 360;
      this._sendWeatherEvent();
    }

    // --- Mission updates ---
    this._nextMissionTime -= dt;
    if (this._nextMissionTime <= 0) {
      this._nextMissionTime = 90 + Math.random() * 180;
      this._sendMissionUpdate(gameData);
    }
  }

  // ==========================================================================
  // MESSAGE GENERATION
  // ==========================================================================

  /** @private */
  _sendFlavorMessage() {
    const msg = FLAVOR_MESSAGES[Math.floor(Math.random() * FLAVOR_MESSAGES.length)];
    this.addMessage(CommsPriority.INFO, msg.source, msg.text);
  }

  /** @private */
  _sendLaunchAlert() {
    const tmpl = LAUNCH_TEMPLATES[Math.floor(Math.random() * LAUNCH_TEMPLATES.length)];
    const text = tmpl.template
      .replace('{time}', (3 + Math.floor(Math.random() * 12)).toString())
      .replace('{alt}', (400 + Math.floor(Math.random() * 800)).toString())
      .replace('{inc}', (28 + Math.floor(Math.random() * 70)).toFixed(1))
      .replace('{count}', (20 + Math.floor(Math.random() * 60)).toString());
    this.addMessage(tmpl.priority, tmpl.source, text);
  }

  /** @private */
  _sendWeatherEvent() {
    const idx = Math.floor(Math.random() * SPACE_WEATHER_TEMPLATES.length);
    const tmpl = SPACE_WEATHER_TEMPLATES[idx];
    const text = tmpl.template
      .replace('{time}', (2 + Math.floor(Math.random() * 8)).toString())
      .replace('{kp}', (5 + Math.floor(Math.random() * 4)).toString())
      .replace('{dur}', (25 + Math.floor(Math.random() * 20)).toString());

    this.addMessage(tmpl.priority, tmpl.source, text);

    // Apply effects
    if (tmpl.effect === 'solarStorm') {
      this.activeEffects.solarStorm = true;
      this.activeEffects.solarStormTimer = 30 + Math.random() * 30; // 30-60 real seconds
      eventBus.emit(Events.COMMS_SOLAR_STORM, { duration: this.activeEffects.solarStormTimer });
    } else if (tmpl.effect === 'geoStorm') {
      this.activeEffects.geoStorm = true;
      this.activeEffects.geoStormTimer = 20 + Math.random() * 40;
      eventBus.emit(Events.COMMS_GEO_STORM, { duration: this.activeEffects.geoStormTimer });
    }
  }

  /** @private */
  _sendMissionUpdate(gameData) {
    const tmpl = MISSION_TEMPLATES[Math.floor(Math.random() * MISSION_TEMPLATES.length)];

    // Try to fill in target names from game data
    let targetName = 'Object-' + (100 + Math.floor(Math.random() * 900));
    if (gameData && gameData.debrisField) {
      const debris = gameData.debrisField.debrisList;
      if (debris.length > 0) {
        const rnd = debris[Math.floor(Math.random() * debris.length)];
        if (rnd.alive) {
          const typeNames = {
            rocketBody: 'SL-16 R/B',
            defunctSat: 'Cosmos Fragment',
            missionDebris: 'MLI Fragment',
            fragment: 'Debris Fragment',
          };
          targetName = typeNames[rnd.type] || 'Unknown Object';
        }
      }
    }

    const text = tmpl.template
      .replace('{target}', targetName)
      .replace('{alt}', (400 + Math.floor(Math.random() * 800)).toString())
      .replace('{tumble}', (2 + Math.random() * 15).toFixed(1))
      .replace('{days}', (30 + Math.floor(Math.random() * 365)).toString());

    this.addMessage(tmpl.priority, tmpl.source, text);
  }

  // ==========================================================================
  // MESSAGE MANAGEMENT
  // ==========================================================================

  /**
   * Add a new message to the comms log.
   * ST-5.1: Now classifies channel and applies coalescing.
   * @param {string} priority - CommsPriority enum
   * @param {string} source - Message source (e.g., 'HOUSTON')
   * @param {string} text - Message content
   * @param {object} [extra] - Optional extra fields (channel, etc.)
   */
  addMessage(priority, source, text, extra) {
    // §0.1 fix: default missing source to 'SYSTEM'; bail only on missing text
    if (!source) {
      console.debug('[CommsSystem] addMessage() sourceless call defaulted to SYSTEM:', text);
      source = 'SYSTEM';
    }
    if (!text) return;
    // ST-5.1: Classify channel
    const channel = sourceToChannel(source, { text, ...(extra || {}) });

    // Delegation 4 (2026-05-31) — Browser-playtest Bug 4 (strengthened):
    // During onboarding, addMessage() is the internal path used by flavour
    // templates, Kessler, weather, MMOD, etc. — none of these carry the
    // _onboarding tag, so they are ALL suppressed.
    if (this._onboardingActive && isOnboardingNoise(extra)) {
      return;
    }

    const now = new Date();
    const timestamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    const nowMs = Date.now();

    // ST-5.1: Coalescing — check recent window for same-channel flood
    const windowMs = COMMS.COALESCE_WINDOW_MS || 2000;
    this._coalesceWindow = this._coalesceWindow.filter(e => (nowMs - e.timestamp) < windowMs);
    const coal = shouldCoalesce(this._coalesceWindow, channel, COMMS.COALESCE_THRESHOLD_COUNT);
    this._coalesceWindow.push({ channel, timestamp: nowMs });

    if (coal.shouldCoalesce) {
      const summaryText = `× ${coal.count} ${channel.toLowerCase()} messages queued`;
      let removed = 0;
      for (let i = this.messages.length - 1; i >= 0 && removed < coal.count - 1; i--) {
        if (this.messages[i].channel === channel) {
          this.messages.splice(i, 1);
          removed++;
        }
      }
      const msg = {
        id: this._nextId++,
        timestamp, source, text: summaryText, priority, channel, age: 0,
      };
      this.messages.push(msg);
      while (this.messages.length > MAX_MESSAGES) this.messages.shift();
      this._playMessageSound(priority);
      if (this.onMessage) this.onMessage(msg);
      eventBus.emit(Events.COMMS_MESSAGE, { ...msg, _internal: true });
      return;
    }

    const msg = {
      id: this._nextId++,
      timestamp,
      source,
      text,
      priority,
      channel,
      age: 0,
    };

    this.messages.push(msg);

    // Trim old messages
    while (this.messages.length > MAX_MESSAGES) {
      this.messages.shift();
    }

    // Audio feedback
    this._playMessageSound(priority);

    // Notify HUD
    if (this.onMessage) {
      this.onMessage(msg);
    }

    // Emit for other systems (tagged _internal to prevent self-listen loop)
    eventBus.emit(Events.COMMS_MESSAGE, { ...msg, _internal: true });
  }

  /**
   * Get all messages (newest last).
   * @returns {Array}
   */
  getMessages() {
    return this.messages;
  }

  /**
   * Get the most recent N messages.
   * @param {number} n
   * @returns {Array}
   */
  getRecentMessages(n = 5) {
    return this.messages.slice(-n);
  }

  /**
   * Start the comms system (gameplay active).
   */
  start() {
    this._active = true;
    this.addMessage(
      CommsPriority.INFO,
      'HOUSTON',
      'Comm link established. All systems nominal. Good hunting, Cowboy.'
    );
  }

  /**
   * Stop the comms system.
   */
  stop() {
    this._active = false;
  }

  /**
   * Reset everything.
   */
  reset() {
    this.messages = [];
    this._nextId = 0;
    this._gameTime = 0;
    this._nextFlavorTime = this._randomFlavorInterval();
    this._nextLaunchTime = 180 + Math.random() * 300;
    this._nextWeatherTime = 120 + Math.random() * 240;
    this._nextMissionTime = 60 + Math.random() * 120;
    this._cooldowns.clear();
    this._coalesceWindow = [];
    this.activeEffects = {
      solarStorm: false, geoStorm: false,
      solarStormTimer: 0, geoStormTimer: 0,
    };
    this._active = false;
    this._isroHandoffDone = false;
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  /** @private Check cooldown before sending an event-based message */
  _canSend(eventKey) {
    if (this._cooldowns.has(eventKey)) return false;
    this._cooldowns.set(eventKey, EVENT_COOLDOWN);
    return true;
  }

  /** @private Random flavor interval */
  _randomFlavorInterval() {
    return FLAVOR_MIN_INTERVAL + Math.random() * (FLAVOR_MAX_INTERVAL - FLAVOR_MIN_INTERVAL);
  }

  /** @private Play audio for message priority */
  _playMessageSound(priority) {
    if (!audioSystem.available) {
      audioSystem.init();
    }
    audioSystem.resume();

    switch (priority) {
      case CommsPriority.CRITICAL:
        audioSystem.playWarning(0.9);
        // Double beep for critical
        timerManager.setTimeout(() => audioSystem.playWarning(0.9), 150, { owner: this });
        break;
      case CommsPriority.WARNING:
        audioSystem.playWarning(0.5);
        break;
      case CommsPriority.INFO:
        // Removed: INFO blip audio not needed per UX decision
        break;
    }
  }
}

export default CommsSystem;

// ST-5.1: CJS guard — expose pure helpers for Node.js tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sourceToChannel, shouldCoalesce };
}
