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
import { messagePassesSuppression, rampSuppressionTier } from './commsSuppression.js';
import { missReasonToText } from '../entities/CaptureNet.js';

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
 * @deprecated CP-4 (2026-06-08) — superseded by the graduated suppression-tier
 * gate in `commsSuppression.js` (`messagePassesSuppression`). Retained as an
 * exported pure helper for back-compat; no longer used by CommsSystem itself.
 *
 * Delegation 4 (2026-05-31) — Browser-playtest Bug 4 helper (strengthened).
 *
 * During onboarding the comms panel must show *only* the Director's own
 * Houston script (boot → handshake → arrows → …).  **Everything else is
 * noise** — EnvironmentSystem MMOD alerts, SpaceWeatherSystem, SubsystemEvents,
 * GameFlowManager first-time comms, CommsSystem flavour templates, etc.
 *
 * The check is simple: if the message payload carries `_onboarding: true`
 * (stamped by [`OnboardingDirector._emitComms()`](js/systems/OnboardingDirector.js:748))
 * it is allowed.  Lasso/net denial feedback (`_lassoFeedback: true`) is also
 * allowed so a rejected cast always explains itself.  Every other message is
 * suppressed.
 *
 * @param {object} [data] — full message payload (may have `_onboarding` flag)
 * @returns {boolean} true → message is noise and should be dropped.
 */
export function isOnboardingNoise(data) {
  if (data && data._onboarding) return false;   // Director's own line — pass
  // Lasso/net denial feedback must reach the player even mid-onboarding —
  // otherwise a rejected cast (cooldown, out-of-arc, no target) shows only a
  // red reticle flash with no explanation, leaving new players stuck.
  if (data && data._lassoFeedback) return false; // actionable denial — pass
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
    template: '⚠ Solar storm (Coronal Mass Ejection) inbound in {time} min. A blast of radiation from the Sun. Duck into Earth\'s shadow to shield your panels.',
    effect: 'solarStorm',
  },
  {
    priority: CommsPriority.WARNING,
    source: 'NOAA SWPC',
    template: 'Geomagnetic storm, strength Kp={kp} (how charged-up Earth\'s magnetic field is). Magnetic capture works +50% better, but orbit tracking is -30% less accurate.',
    effect: 'geoStorm',
  },
  {
    priority: CommsPriority.INFO,
    source: 'MISSION CTRL',
    template: 'Heading into Earth\'s shadow for {dur} min. No sunlight, so you\'re on battery power. Go easy on the tools.',
    effect: 'eclipse',
  },
  {
    priority: CommsPriority.WARNING,
    source: 'NOAA SWPC',
    template: 'Burst of solar particles detected. Your solar panels may wear down faster for the next {time} min.',
    effect: 'solarProton',
  },
];

/** Kessler event messages */
const KESSLER_TEMPLATES = [
  {
    priority: CommsPriority.CRITICAL,
    source: 'Space Domain Awareness',
    template: '⚠ CRITICAL: Collision at {alt}km just shattered into {count} new debris pieces. Adding them to the catalog now.',
  },
  {
    priority: CommsPriority.WARNING,
    source: 'NORAD',
    template: 'Close call ahead (a "conjunction"): {obj1} and {obj2} have a 1-in-{odds} chance of colliding in {hours} hours. Steer clear of that area.',
  },
  {
    priority: CommsPriority.WARNING,
    source: '18th Space Defense Squadron',
    template: 'Debris cloud spreading out at {alt}km. If you\'re flying near that altitude, move clear.',
  },
];

/** Launch notification templates */
const LAUNCH_TEMPLATES = [
  {
    priority: CommsPriority.INFO,
    source: 'LAUNCH ALERT',
    template: 'Rocket Lab Electron launching in {time} min. It\'ll pass through {alt}km at {inc}°. Keep your distance from that lane.',
  },
  {
    priority: CommsPriority.INFO,
    source: 'LAUNCH ALERT',
    template: 'SpaceX is releasing {count} Starlink satellites at {alt}km. New objects coming to your catalog shortly.',
  },
  {
    priority: CommsPriority.INFO,
    source: 'LAUNCH ALERT',
    template: 'Soyuz lifting off from Baikonur. Its climb passes through {alt}km at {inc}° over the next {time} min. Give it room.',
  },
  {
    priority: CommsPriority.WARNING,
    source: 'LAUNCH ALERT',
    template: 'URGENT: A spent Falcon 9 rocket stage is about to be dumped at {alt}km. Clear that lane now.',
  },
];

/** Mission update templates */
const MISSION_TEMPLATES = [
  {
    priority: CommsPriority.INFO,
    source: 'GROUND STN',
    template: '{target} is spinning at {tumble}°/s. Hit it with the laser first to slow the spin (detumble). Makes it far easier to grab.',
  },
  {
    priority: CommsPriority.INFO,
    source: 'LeoLabs',
    template: 'Got your scan data on {target}, thanks. Bonus +50 points.',
  },
  {
    priority: CommsPriority.WARNING,
    source: 'ClearSpace',
    template: 'New contract: priority pickup at {alt}km. Capture there and your points are doubled (×2).',
  },
  {
    priority: CommsPriority.INFO,
    source: 'GROUND STN',
    template: 'Telemetry looks good. All systems green. Carry on, Cowboy.',
  },
  {
    priority: CommsPriority.INFO,
    source: 'ESOC',
    template: '{target} is slowly falling out of orbit. It\'ll burn up on re-entry in {days} days if you don\'t grab it first.',
  },
];

/** Player status templates (triggered by events) */
const PLAYER_STATUS_TEMPLATES = {
  lowXenon: {
    priority: CommsPriority.WARNING,
    source: 'SPACECRAFT',
    template: 'Heads up: your xenon thruster fuel is below {pct}%. Refuel at an orbital depot when you can.',
  },
  lowColdGas: {
    priority: CommsPriority.WARNING,
    source: 'SPACECRAFT',
    template: 'Cold-gas thruster fuel running low: {val} units left. Save it for dodging. Go easy on quick maneuvers.',
  },
  lowBattery: {
    priority: CommsPriority.WARNING,
    source: 'SPACECRAFT',
    template: 'Battery critical at {pct}%! Ease off the tools and get into sunlight to recharge.',
  },
  debrisCleared: {
    priority: CommsPriority.INFO,
    source: 'HOUSTON',
    template: 'Nice. {count} debris objects cleared! Orbit is {stability}% safer thanks to you.',
  },
  evasionPerformed: {
    priority: CommsPriority.WARNING,
    source: 'SPACECRAFT',
    template: 'Dodge complete. {name} slipped by at {dist}m. Nicely flown.',
  },
};

/** Generic flavor messages */
const FLAVOR_MESSAGES = [
  { source: 'HOUSTON', text: 'Orbital environment looking good. Keep up the great work, Cowboy.' },
  { source: 'MISSION CTRL', text: 'Sun transit in 12 minutes. Optimal solar charging window approaching.' },
  { source: 'GROUND STN', text: 'Next ground contact window: Svalbard station in 8 minutes.' },
  { source: 'SDA', text: 'Drag estimates updated. Low-altitude debris is falling out of orbit a bit faster than expected.' },
  { source: 'HOUSTON', text: 'Reminder: Document all capture operations for post-mission analysis.' },
  { source: 'ESOC', text: 'ESA Space Sustainability Index updated. Your contributions noted.' },
  { source: 'NORAD', text: 'Routine catalog maintenance complete. 347 objects re-correlated.' },
  { source: 'GROUND STN', text: 'Magnetic field measurements nominal. Proceeding with scheduled survey.' },
  { source: 'JAXA', text: 'Japan shared their tracking data. Your catalog now covers the Asian sector too.' },
  { source: 'HOUSTON', text: 'Weather report: Clear skies over recovery zone. Good conditions for de-orbit operations.' },
  { source: 'LeoLabs', text: 'New radar track: Uncatalogued object detected at 620km. Adding to survey queue.' },
  { source: 'MISSION CTRL', text: 'Crew activity report filed. All mission objectives on track.' },
  { source: 'SDA', text: 'Space fence detection: Small debris cluster at 780km altitude. Monitoring.' },
  { source: 'HOUSTON', text: 'Thermal model updated. Spacecraft temperatures within nominal range.' },
  { source: 'GROUND STN', text: 'Signal is crystal clear. Keeping your data link running at full speed.' },
];

// === ST-8.4: ISRO Ground Station Personas ===
const BANGALORE_TEMPLATES = [
  { source: 'BANGALORE', text: 'ISTRAC Bangalore here. We\'ve got you on our antenna, tracking {target}, signal good.', priority: 'INFO' },
  { source: 'BANGALORE', text: 'Bangalore confirms your orbit. {orbits} orbits until your intercept window opens.', priority: 'INFO' },
  { source: 'BANGALORE', text: 'Bangalore: your telemetry stream is healthy, all systems looking good.', priority: 'INFO' },
  { source: 'BANGALORE', text: 'Bangalore handing your tracking over to {nextStation} as you pass out of range.', priority: 'INFO' },
  { source: 'BANGALORE', text: 'Bangalore: that debris matches its catalog entry on radar. Confirmed.', priority: 'INFO' },
];

const HASSAN_TEMPLATES = [
  { source: 'HASSAN', text: 'Hassan station: locked onto your far-off (geostationary) target with our big 32m dish.', priority: 'INFO' },
  { source: 'HASSAN', text: 'Hassan: signal locked. You\'re so far out the radio round-trip is {rtDelay}ms.', priority: 'INFO' },
  { source: 'HASSAN', text: 'Hassan confirms your orbit-raise burn is done. Rounding out your orbit now.', priority: 'INFO' },
  { source: 'HASSAN', text: 'Hassan tracking: your approach lane to the high orbit is clear.', priority: 'INFO' },
];

const HANDOFF_DIALOGUE = [
  { from: 'HOUSTON', text: 'Houston: handing off to Bangalore ISTRAC. Good hunting.' },
  { from: 'BANGALORE', text: 'ISTRAC Bangalore: Roger, we have the conn. Tracking nominal.' },
];

const NEWS_BOUNTY_TEMPLATES = [
  { source: 'NEWS', text: '[{date} NEWS] {headline}', priority: 'WARNING' },
  { source: 'NEWS', text: 'Bounty posted: ₹{bounty}. Target {debrisName}', priority: 'INFO' },
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
     * CP-4 guidance arbiter (GUIDANCE_ARBITER_SPEC §2) — graduated suppression
     * tier (0–3) replacing the old binary `_onboardingActive`:
     *   0 = OnboardingDirector running (only tag-bypassed lines pass)
     *   1 = 0–30 s after ONBOARDING_COMPLETE (+ HOUSTON, MISSION)
     *   2 = 30–60 s after (+ ALERT, CMD)
     *   3 = steady state / DEFAULT for non-onboarding play (all channels)
     * Escalation is driven off the game clock in `_advanceSuppression(dt)` (so it
     * respects pause for free); see `commsSuppression.js` for the pure gate.
     * @type {number}
     */
    this._suppressionTier = 3;
    this._postOnboardingElapsed = 0; // seconds since ONBOARDING_COMPLETE (ramp 1→3)
    this._tempTierActive = false;    // a MissionCoach beat is holding a protected tier
    this._tempTierRestoreS = 0;      // remaining hold (s) before the ramp resumes

    this._setupEventListeners();

    // Self-reset via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.GAME_RESET, () => this.reset());

    // CP-4 suppression tiers — onboarding drops to tier 0; completion begins the
    // graduated wake ramp. (Non-onboarding play stays at the default tier 3.)
    if (Events.ONBOARDING_STARTED) {
      eventBus.on(Events.ONBOARDING_STARTED, () => { this._suppressionTier = 0; });
    }
    if (Events.ONBOARDING_COMPLETE) {
      eventBus.on(Events.ONBOARDING_COMPLETE, () => this._beginPostOnboardingRamp());
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

      // CP-4 guidance arbiter — graduated tier gate (replaces the binary
      // onboarding gate). Tag bypasses (_critical/_onboarding/_postOnboarding/
      // _lassoFeedback) + CRITICAL priority are honoured in the pure helper.
      if (!messagePassesSuppression(this._suppressionTier, channel, data, data.priority)) {
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
        // Carry the onboarding beat id (if any) so the comms panel can drop the
        // "demanding attention" highlight the moment the player follows it.
        onboardingBeatId: data._onboardingBeatId,
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
      // CP-4: survival warning — must reach the player even during the wake ramp.
      this.addMessage(tmpl.priority, tmpl.source, tmpl.template.replace('{pct}', pct), { _critical: true });
    });

    eventBus.on(Events.PLAYER_LOW_BATTERY, (data) => {
      if (!this._canSend('lowBattery')) return;
      const tmpl = PLAYER_STATUS_TEMPLATES.lowBattery;
      const pct = data && data.level ? Math.round(data.level / Constants.BATTERY_MAX * 100) : 10;
      this.addMessage(tmpl.priority, tmpl.source, tmpl.template.replace('{pct}', pct), { _critical: true });
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
        `⚡ Emergency dodge! ${data.name} at ${(data.distance / Constants.SCENE_SCALE * 1000).toFixed(0)}m. Burned some cold-gas thruster fuel to get clear.`
      );
    });

    // Score updates for milestone messages
    eventBus.on(Events.SCORE_UPDATE, (data) => {
      if (data.debrisCleared && data.debrisCleared % 10 === 0 && data.debrisCleared > 0) {
        if (!this._canSend('milestone')) return;
        this.addMessage(
          CommsPriority.INFO,
          'HOUSTON',
          `Milestone reached: ${data.debrisCleared} debris objects cleared. Score: ${data.total.toLocaleString()}. Outstanding work.`
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
        `Deorbit burn good. That object is now headed down to burn up in the atmosphere. +${data.points} points.`
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
        `Ion thruster (FEEP) now running on ${data.metal}. Fuel efficiency ${sign}${ispPct}%`
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
        this.addMessage('INFO', 'NEWS', `Bounty posted: ₹${bountyStr}. Target ${debrisName}`);
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
          this.addMessage('INFO', 'HOUSTON', 'Houston: handing off to Bangalore ISTRAC. Good hunting.');
        }, 500, { owner: this });
        timerManager.setTimeout(() => {
          this.addMessage('INFO', 'BANGALORE', 'ISTRAC Bangalore: Roger, we have the conn. Tracking nominal.');
        }, 2500, { owner: this });
      }
    });

    // === Phase 1: Capture-flow UX comms (§4 items 2-5) ===

    // §4 item 2: TETHER_SNAP → CRITICAL comms + ALERT channel (BUG-C fix)
    eventBus.on(Events.TETHER_SNAP, (data) => {
      this.addMessage('CRITICAL', data?.armId || 'SYSTEM', 'TETHER SEVERED. Daughter and catch cut loose and drifting. Reload not possible; send another daughter to chase it down.', { channel: 'ALERT' });
    });

    // Net-integrity failure (recoverable): the net lost its grip on a heavy
    // catch. The daughter is fine and returning to reload; the debris is loose.
    eventBus.on(Events.NET_FAILED, (data) => {
      this.addMessage('WARNING', data?.armId || 'SYSTEM', 'NET FAILED. Debris slipped the net and is drifting. Daughter returning to reload; re-net to retry.', { channel: 'ALERT' });
    });

    // UX-11 #1: net MISS reasons → actionable plain text. A miss is fully
    // recoverable (the net reels back and inventory is restored), so the line
    // must say WHY it missed and what to do next, not just "missed".
    // 'forced' (test/scripted resolves) stays silent.
    eventBus.on(Events.NET_CATCH_MISS, (data) => {
      const text = missReasonToText(data?.reason);
      if (!text) return;
      const source = (data?.armIndex != null && data.armIndex >= 0)
        ? `ARM-${data.armIndex + 1}` : 'NET POD';
      this.addMessage('WARNING', source, text, { channel: 'ALERT' });
    });

    // §4 item 3: ARM_RETURNED (captured) → Docking comms
    eventBus.on(Events.ARM_RETURNED, (data) => {
      if (data?.captured === true) {
        this.addMessage('INFO', data.armId || 'SYSTEM', 'Docking. 3 s.', { channel: 'CMD' });
      }
    });

    // §4 item 3: CROSSBOW_RELOAD_COMPLETE → Spring re-charged comms
    eventBus.on(Events.CROSSBOW_RELOAD_COMPLETE, (data) => {
      this.addMessage('INFO', data?.armId || 'SYSTEM', 'Spring re-charged. Ready for next deploy.', { channel: 'CMD' });
    });

    // §4 item 4: STATION_KEEP_ENTERED → ON STATION comms with key hints.
    // New-player guidance: speak plainly about what the daughter is doing and
    // exactly which keys move things forward. Capture is fired with [N] (the
    // same key onboarding teaches for the net); [P] takes manual pilot control.
    eventBus.on(Events.STATION_KEEP_ENTERED, (data) => {
      const standoff = data?.standoffR != null ? Math.round(data.standoffR) : '?';
      const targetId = data?.targetId != null ? data.targetId : '?';
      const armId = data?.armId || 'SYSTEM';
      // While piloting the arm, teach the station-keep orbit controls so the
      // player can inspect every side of the debris and line up a capture.
      // When the arm arrived under autopilot, point them at taking manual
      // control (its number key 1-4) or capturing (N) instead.
      const hint = data?.isPiloted
        ? 'Arrow keys orbit the debris · +/- adjust distance · [N] capture.'
        : '[N] capture · [1-4] pilot for a closer look.';
      this.addMessage('INFO', armId,
        `ON STATION. Holding ${standoff}m from debris #${targetId}. ${hint}`,
        { channel: 'CMD' });
      // Plain-language follow-up for new players: name the daughter and spell
      // out the next move in a friendly command voice.
      const daughterName = data?.armId || 'your daughter';
      this.addMessage('INFO', 'HOUSTON',
        `${daughterName} is holding station on the debris. Press N to capture, or its number key (1-4) to pilot it in closer.`,
        { channel: 'CMD' });
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

    // CP-4 — advance the post-onboarding suppression ramp (real dt; pause-safe).
    this._advanceSuppression(dt);

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

    // CP-4 guidance arbiter — graduated tier gate. addMessage() is the internal
    // path for flavour templates, Kessler, weather, MMOD, etc.; at the default
    // tier 3 this is a no-op, so non-onboarding play is unaffected.
    if (!messagePassesSuppression(this._suppressionTier, channel, extra, priority)) {
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
    // CP-4 — back to steady-state default; onboarding (if it re-runs) drops to 0.
    this._suppressionTier = 3;
    this._postOnboardingElapsed = 0;
    this._tempTierActive = false;
    this._tempTierRestoreS = 0;
  }

  // ==========================================================================
  // CP-4 GUIDANCE ARBITER — suppression tier (GUIDANCE_ARBITER_SPEC §2)
  // ==========================================================================

  /** @returns {number} current suppression tier (0–3). */
  getSuppressionTier() { return this._suppressionTier; }

  /** @private Begin the graduated post-onboarding wake ramp (tier 1 → 2 → 3). */
  _beginPostOnboardingRamp() {
    this._suppressionTier = 1;
    this._postOnboardingElapsed = 0;
    this._tempTierActive = false;
    this._tempTierRestoreS = 0;
  }

  /**
   * Temporarily drop to a protected tier for a high-cognitive-load MissionCoach
   * beat (spec §2); the ramp auto-restores after `durationS` seconds of play.
   * @param {number} tier
   * @param {number} durationS
   */
  _tempDropToTier(tier, durationS) {
    this._suppressionTier = Math.max(0, Math.min(3, tier | 0));
    this._tempTierActive = true;
    this._tempTierRestoreS = Math.max(0, durationS || 0);
  }

  /**
   * Advance the suppression ramp by `dt` seconds of (unpaused) play. Driven off
   * the game loop so it respects pause without a wall-clock timer.
   * @param {number} dt
   */
  _advanceSuppression(dt) {
    // A MissionCoach beat is holding a protected tier — count it down first.
    if (this._tempTierActive) {
      this._tempTierRestoreS -= dt;
      if (this._tempTierRestoreS > 0) return; // keep holding the protected tier
      this._tempTierActive = false;           // released → resume the ramp below
    }
    // Tier 0 (onboarding) and tier 3 (steady state) are terminal for the ramp.
    if (this._suppressionTier <= 0 || this._suppressionTier >= 3) return;
    this._postOnboardingElapsed += dt;
    this._suppressionTier = rampSuppressionTier(this._postOnboardingElapsed);
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
