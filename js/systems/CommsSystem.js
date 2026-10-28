/**
 * CommsSystem.js — Ground station communications system
 * Procedurally-generated messages: Space Weather, Kessler Events, Launch Alerts, Mission Updates, Player Status,
 * plus a 6-channel classification + coalescing layer.
 * @module systems/CommsSystem
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { TimeAuthority } from './TimeAuthority.js';
import { audioSystem } from './AudioSystem.js';
import timerManager from './TimerManager.js';
import { messagePassesSuppression, rampSuppressionTier, postOnboardingStartTier } from './commsSuppression.js';
import { missReasonToText } from '../entities/CaptureNet.js';
import { daughterDisplayName } from '../core/daughterNames.js';
import { GestureHints } from '../ui/hud/GestureHints.js';
import { flyFirstLine } from './netRouting.js';   // the daughter's "Press N" line says her number when N is not hers
import { depotWords } from './resupplyWords.js';   // the "depot" advice reads the map switch
import { radToDeg, clamp } from '../core/MathUtil.js';

const MAX_MESSAGES = 20;
/** A shut start-up gate opens itself after this many seconds of updates (the safety). */
const HOLD_SAFETY_S = 20;

export const CommsPriority = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
};

/** Flavor message interval range (s of game time) */
const FLAVOR_MIN_INTERVAL = 30;
const FLAVOR_MAX_INTERVAL = 120;

/** Event-based message cooldown (s) */
const EVENT_COOLDOWN = 15;

const COMMS = Constants.COMMS || {};
const VALID_CHANNELS = new Set(COMMS.CHANNELS || ['CMD', 'ALERT', 'HOUSTON', 'SCI', 'FLAVOR', 'MISSION']);
const DEFAULT_CHANNEL = COMMS.DEFAULT_CHANNEL || 'FLAVOR';

/**
 * The sender is shown once: emitters write `source: 'Small 1'` AND start the text with `Small 1: `. Strips a leading
 * `<source>: ` from the text, case-insensitively. Nothing else is touched; a text that is only the prefix is returned whole.
 */
export function stripSenderPrefix(source, text) {
  if (typeof source !== 'string' || typeof text !== 'string' || !source) return text;
  const prefix = `${source.toLowerCase()}: `;
  if (text.length > prefix.length && text.slice(0, prefix.length).toLowerCase() === prefix) {
    const rest = text.slice(prefix.length).replace(/^\s+/, '');
    return rest || text;
  }
  return text;
}

/**
 * A source-less emit whose text starts with a daughter's own name ("Small 1: Pad adhered"): the name IS the sender;
 * returns it as the source with the rest as the text, or null. The name format is `daughterDisplayName`'s:
 * "Small N" / "Large N" (N = the arm's number).
 *
 * @returns {{source: string, text: string}|null}
 */
export function splitDaughterPrefix(text) {
  if (typeof text !== 'string') return null;
  const m = /^(small|large) (\d+): +(?=\S)/i.exec(text);
  if (!m) return null;
  return { source: `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`, text: text.slice(m[0].length) };
}

/**
 * Classify a message into one of the 6 channels.
 * Priority: explicit channel → source heuristic → text heuristic → FLAVOR.
 *
 * @returns {string} One of Constants.COMMS.CHANNELS
 */
function sourceToChannel(source, payload) {
  const p = payload || {};

  if (p.channel) {
    const ch = String(p.channel).toUpperCase();
    return VALID_CHANNELS.has(ch) ? ch : DEFAULT_CHANNEL;
  }

  const src = (source || '').toUpperCase();
  if (src === 'HOUSTON') return 'HOUSTON';
  if (src === 'MISSION' || src === 'MISSION_EVENT') return 'MISSION';
  if (src === 'BANGALORE' || src === 'HASSAN') return 'HOUSTON';
  if (src === 'NEWS') return 'MISSION';

  // Text heuristics, secondary to the explicit channel.
  const text = (p.text || '').toUpperCase();
  // ALERT: warning-like prefixes (no emoji: the words CAUTION: / WARNING: / CRITICAL: classify).
  // The escaped U+26A0 branch is a do-not-edit COMPATIBILITY branch: GameFlowManager's two sourceless Hazmat lines
  // still lead with the glyph, and without it they fall from ALERT to FLAVOR. Nothing renders the glyph here;
  // drop the branch when the last such emitter is lifted.
  if (/^(ALERT:|WARNING:|CAUTION:|CRITICAL:|CONJUNCTION|\u26A0)/.test(text)) return 'ALERT';
  // SCI: discovery/codex/identification
  if (/^(DISCOVERY|CODEX|IDENTIFIED)/.test(text)) return 'SCI';
  // CMD: arm deploy/reel/detach confirmations
  if (/^(DEPLOY|REEL|DETACH|COMMS: DEPLOY|COMMS: FISH|COMMS: RECALL)/.test(text)) return 'CMD';

  return DEFAULT_CHANNEL;
}

/**
 * Coalescing predicate: should the new message be coalesced, given recent timestamps + channels.
 *
 * @param {Array<{channel: string, timestamp: number}>} recentWindow — messages in the coalesce window
 * @param {string} newChannel — channel of the incoming message
 * @param {number} thresholdCount — how many same-channel msgs trigger coalescing
 * @returns {{ shouldCoalesce: boolean, count: number }}
 */
function shouldCoalesce(recentWindow, newChannel, thresholdCount) {
  const threshold = thresholdCount || COMMS.COALESCE_THRESHOLD_COUNT || 3;
  const sameChannel = recentWindow.filter(m => m.channel === newChannel);
  // includes the new message
  const count = sameChannel.length + 1;
  return {
    shouldCoalesce: count >= threshold,
    count,
  };
}

const SPACE_WEATHER_TEMPLATES = [
  {
    priority: CommsPriority.CRITICAL,
    source: 'NOAA SWPC',
    template: 'WARNING: Solar storm (Coronal Mass Ejection) inbound in {time} min. A blast of radiation from the Sun. Duck into Earth\'s shadow to shield your panels.',
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

const KESSLER_TEMPLATES = [
  {
    priority: CommsPriority.CRITICAL,
    source: 'Space Domain Awareness',
    template: 'CRITICAL: Collision at {alt}km just shattered into {count} new debris pieces. Adding them to the catalog now.',
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

/**
 * Mission update templates (Ruling 0: plain words). `{target}` is the name of a live piece from the field (see
 * `_sendMissionUpdate`), so a template that uses it is not sent when no piece is alive. The spin line carries the piece's
 * own spin rate when it has one (`templateNoSpin` otherwise).
 */
const MISSION_TEMPLATES = [
  {
    priority: CommsPriority.INFO,
    source: 'GROUND STN',
    needsTarget: true,
    needsSpin: true,
    template: '{target} is spinning at {tumble} degrees a second. Hit it with the laser first to slow its spin. Makes it far easier to grab.',
    templateNoSpin: '{target} is spinning. Hit it with the laser first to slow its spin. Makes it far easier to grab.',
  },
  {
    priority: CommsPriority.INFO,
    source: 'LeoLabs',
    needsTarget: true,
    template: 'Got your scan data on {target}, thanks. Bonus +50 points.',
    quiet: true,   // random timer line, no scan behind it
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
    quiet: true,   // pure chatter
  },
  {
    priority: CommsPriority.INFO,
    source: 'ESOC',
    needsTarget: true,
    template: '{target} is slowly falling out of orbit. It\'ll burn up on re-entry in {days} days if you don\'t grab it first.',
  },
];

/** A live piece's plain name for a mission update (its catalogue name if it has one, else by type). */
const MISSION_TYPE_NAMES = {
  rocketBody: 'SL-16 R/B',
  defunctSat: 'Cosmos Fragment',
  missionDebris: 'MLI Fragment',
  fragment: 'Debris Fragment',
  cubesat: 'Cubesat',
};
function missionTargetName(d) {
  if (typeof d.name === 'string' && d.name && !/^Cataloged-/.test(d.name)) return d.name;
  return MISSION_TYPE_NAMES[d.type] || 'Debris Fragment';
}

const PLAYER_STATUS_TEMPLATES = {
  lowXenon: {
    priority: CommsPriority.WARNING,
    source: 'SPACECRAFT',
    template: 'Heads up: your {fuel} thruster fuel is below {pct}%. Refuel at an orbital depot when you can.',
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

/**
 * Validate a COMMS_MESSAGE `link`: the per-message deep link CommsPanel wraps around the first whole-word `term`.
 * Accepted only as an object carrying BOTH `term` and `entryId` as non-empty strings; the whole object is passed
 * through (it may carry `anchor`). Anything else is `null`, so a malformed emit never reaches the renderer. Pure.
 * @returns {{ term: string, entryId: string, anchor?: string }|null}
 */
export function sanitizeCommsLink(link) {
  if (!link || typeof link !== 'object') return null;
  if (typeof link.term !== 'string' || link.term.length === 0) return null;
  if (typeof link.entryId !== 'string' || link.entryId.length === 0) return null;
  return link;
}

export class CommsSystem {
  constructor() {
    /** @type {Array<{ timestamp: number, source: string, text: string, priority: string, channel: string, id: number }>} */
    this.messages = [];

    this._nextId = 0;

    /** @type {string|null} the loaded fuel's name, from the last FUEL_CHANGED (null = the default fuel) */
    this._fuel = null;

    /** @type {Array<{channel: string, timestamp: number}>} sliding window for coalescing */
    this._coalesceWindow = [];

    this._gameTime = 0;

    // time until the next flavor / launch / weather / mission message
    this._nextFlavorTime = this._randomFlavorInterval();

    this._nextLaunchTime = 180 + Math.random() * 300; // 3-8 min

    this._nextWeatherTime = 120 + Math.random() * 240; // 2-6 min

    this._nextMissionTime = 60 + Math.random() * 120;

    /** @type {Map<string, number>} cooldown timers for event-based messages */
    this._cooldowns = new Map();

    /** @type {Function|null} Callback for new messages (used by HUD) */
    this.onMessage = null;

    this._active = false;

    this._isroHandoffDone = false;  // whether the ISRO handoff dialogue has played

    this.activeEffects = {
      solarStorm: false,
      geoStorm: false,
      solarStormTimer: 0,
      geoStormTimer: 0,
    };

    /**
     * Guidance arbiter suppression tier (archive/GUIDANCE_ARBITER_SPEC.md §2), 0–3:
     *   0 = OnboardingDirector running (only tag-bypassed lines pass)
     *   1 = 0–30 s after ONBOARDING_COMPLETE (+ HOUSTON, MISSION)
     *   2 = 30–60 s after (+ ALERT, CMD)
     *   3 = steady state / DEFAULT for non-onboarding play (all channels)
     * Escalation runs off the game clock in `_advanceSuppression(dt)` (respects pause); the pure gate is in
     * `commsSuppression.js`.
     * @type {number}
     */
    this._suppressionTier = 3;
    this._postOnboardingElapsed = 0; // seconds since ONBOARDING_COMPLETE (ramp 1→3)
    this._tempTierActive = false;    // a MissionCoach beat is holding a protected tier
    this._tempTierRestoreS = 0;      // remaining hold (s) before the ramp resumes
    // The post-onboarding wake ramp runs only if the Director pipeline ACTUALLY ran this session: a veteran-skip emits
    // ONBOARDING_COMPLETE WITHOUT a prior ONBOARDING_STARTED and must NOT be dropped to tier 1 for ~60 s.
    this._onboardingWasRun = false;
    /**
     * ONBOARDING_MASTERED arrived this run (tier is 3). Makes a COMPLETE that follows it (the all-skipped path emits
     * both) a no-op instead of starting the wake ramp.
     */
    this._tutorialMastered = false;

    // The start's lines are HELD until comms can be seen. The gate is open by default; OpeningDance shuts it with
    // COMMS_HOLD and opens it with COMMS_RELEASE just before the hand-over. Only the start: later floor-1 visits
    // keep the buffer and show it on return.
    this._gateOpen = true;
    this._held = [];                 // msg objects waiting behind a shut gate (never in `messages`)
    this._holdElapsedS = 0;          // real seconds the gate has been shut (the safety)

    this._setupEventListeners();

    eventBus.on(Events.GAME_RESET, () => this.reset());

    // GAME_RESET / reset() leave a shut gate shut and keep the held list (GAME_RESET can arrive after the hold began).
    if (Events.COMMS_HOLD) eventBus.on(Events.COMMS_HOLD, () => this._shutGate());
    if (Events.COMMS_RELEASE) eventBus.on(Events.COMMS_RELEASE, () => this._openGate());

    // Onboarding drops to tier 0; completion begins the graduated wake ramp.
    if (Events.ONBOARDING_STARTED) {
      eventBus.on(Events.ONBOARDING_STARTED, () => {
        this._suppressionTier = 0;
        this._onboardingWasRun = true;
        this._tutorialMastered = false;
      });
    }
    if (Events.ONBOARDING_COMPLETE) {
      eventBus.on(Events.ONBOARDING_COMPLETE, () => this._beginPostOnboardingRamp());
    }
    // The tutorial's beat list finished. owner 2026-10-19: the tutorial's end emits MASTERED first, then
    // ONBOARDING_COMPLETE. So this takes the panel out of tier 0 straight to tier 3, no 30-60 s wake ramp; the
    // COMPLETE that follows is a no-op here (_tutorialMastered).
    if (Events.ONBOARDING_MASTERED) {
      eventBus.on(Events.ONBOARDING_MASTERED, () => this._endTutorialSilence());
    }

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

    eventBus.on(Events.COMMS_SEND, (data) => {
      if (data && data.source && data.text) {
        const pri = data.priority === 'WARNING' ? 'WARNING'
                  : data.priority === 'CRITICAL' ? 'CRITICAL' : 'INFO';
        this.addMessage(pri, data.source, data.text);
      }
    });

    // Persists externally-emitted COMMS_MESSAGE events. Stores directly, without addMessage(), to avoid double audio/emit.
    eventBus.on(Events.COMMS_MESSAGE, (data) => {
      if (!data || data._internal) return;
      // External emitters use 'source', 'sender', or 'speaker'; a missing source defaults to 'SYSTEM' so capture-loop comms render
      let rawSrc = data.source || data.sender || data.speaker;
      let body = data.text;
      if (!rawSrc && body) {
        // no source, but the text names a daughter ("Small 1: ..."): she is the sender, said once
        const named = splitDaughterPrefix(body);
        if (named) { rawSrc = named.source; body = named.text; }
      }
      if (!rawSrc) console.debug('[CommsSystem] sourceless emit defaulted to SYSTEM:', data.text);
      const src = rawSrc || 'SYSTEM';
      if (!body) return;
      const rawText = stripSenderPrefix(src, body);   // the sender is shown once
      // On glass the line names the button (LAUNCH NET ...), not the key; desktop text is untouched.
      // Runs AFTER the strip/split helpers.
      const text = GestureHints.chipPhrase(rawText);

      const channel = sourceToChannel(src, data);

      // Tier gate. Tag bypasses (_critical/_onboarding/_postOnboarding/_lassoFeedback) + CRITICAL priority are
      // honoured in the pure helper.
      if (!messagePassesSuppression(this._suppressionTier, channel, data, data.priority)) {
        return;
      }

      // Behind a shut gate the line waits (no log, no callback, no sound, no summary).
      if (!this._gateOpen) {
        this._hold({
          id: this._nextId++,
          timestamp: this._clockStamp(),
          source: src,
          text,
          priority: data.priority || CommsPriority.INFO,
          channel,
          age: 0,
          // as on the normal post path below
          onboardingBeatId: data._onboardingBeatId,
          link: sanitizeCommsLink(data.link),
        }, data._critical === true || data._reactive === true);
        return;
      }

      const now = new Date();
      const tsStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
      const nowMs = Date.now();

      const windowMs = COMMS.COALESCE_WINDOW_MS || 2000;
      this._coalesceWindow = this._coalesceWindow.filter(e => (nowMs - e.timestamp) < windowMs);
      // A _critical / _reactive line is "kept": never summarised away, and it does not count toward tipping plain lines
      // into a burst. A `_keep` status line (mission progress, where a catch went, the next step) is kept the same way:
      // it never bypasses the suppression tier, only coalescing.
      const kept = data._critical === true || data._reactive === true || data._keep === true;
      const coal = kept ? { shouldCoalesce: false, count: 0 }
        : shouldCoalesce(this._coalesceWindow, channel, COMMS.COALESCE_THRESHOLD_COUNT);
      if (!kept) this._coalesceWindow.push({ channel, timestamp: nowMs });

      if (coal.shouldCoalesce) {
        // A burst keeps only its newest line: the older non-kept same-channel lines go; the current line is posted
        // below as a normal message. No "× n ... queued" line.
        let removed = 0;
        for (let i = this.messages.length - 1; i >= 0 && removed < coal.count - 1; i--) {
          if (this.messages[i].channel === channel && !this.messages[i].keep) {
            this.messages.splice(i, 1);
            removed++;
          }
        }
      }

      const msg = {
        id: this._nextId++,
        timestamp: tsStr,
        source: src,
        text,
        priority: data.priority || CommsPriority.INFO,
        channel,
        age: 0,
        // lets the comms panel drop the "demanding attention" highlight the moment the player follows the beat
        onboardingBeatId: data._onboardingBeatId,
        // `{ term, entryId, anchor? }` or null; CommsPanel wraps the term as a SPECS link, nothing else reads it
        link: sanitizeCommsLink(data.link),
      };
      if (kept) msg.keep = true;

      this.messages.push(msg);
      GestureHints.noteChipLine(rawText);   // glass: a line that names an action key brings that chip up
      while (this.messages.length > MAX_MESSAGES) {
        this.messages.shift();
      }
      // HUD (no sound replay, no re-emit)
      if (this.onMessage) {
        this.onMessage(msg);
      }
    });
  }

  /** @private */
  _setupEventListeners() {
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

    eventBus.on(Events.FUEL_CHANGED, (data) => {
      if (data && typeof data.name === 'string' && data.name) this._fuel = data.name;
    });

    eventBus.on(Events.PLAYER_LOW_XENON, (data) => {
      if (!this._canSend('lowXenon')) return;
      const tmpl = PLAYER_STATUS_TEMPLATES.lowXenon;
      const pct = data && Number.isFinite(data.level) ? Math.round(data.level / Constants.XENON_FUEL_MAX * 100) : 10;
      // Survival warning: must reach the player even during the wake ramp. The text names the fuel actually loaded
      // (last FUEL_CHANGED, else the default fuel's).
      this.addMessage(tmpl.priority, tmpl.source, depotWords(tmpl.template).replace('{fuel}', this._fuelName().toLowerCase()).replace('{pct}', pct), { _critical: true });
    });

    eventBus.on(Events.PLAYER_LOW_BATTERY, (data) => {
      if (!this._canSend('lowBattery')) return;
      const tmpl = PLAYER_STATUS_TEMPLATES.lowBattery;
      const max = (data && data.batteryMax) || Constants.BATTERY_MAX;
      const pct = data && Number.isFinite(data.level) ? Math.round(data.level / max * 100) : 10;
      this.addMessage(tmpl.priority, tmpl.source, tmpl.template.replace('{pct}', pct), { _critical: true });
    });

    eventBus.on(Events.DEBRIS_CLEARED, (data) => {
      if (!this._canSend('debrisCleared')) return;
      const tmpl = PLAYER_STATUS_TEMPLATES.debrisCleared;
      const stability = Math.min(100, data.count * 2);
      this.addMessage(
        tmpl.priority,
        tmpl.source,
        tmpl.template
          .replace('{count}', data.count)
          .replace('{stability}', stability),
        // Houston praise ("Nice. N cleared!") stays hidden; the progress line says it.
        { _quiet: true }
      );
    });

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

    eventBus.on(Events.COLLISION_EVASION, (data) => {
      if (!this._canSend('evasionManeuver')) return;
      // payload: { debrisId, distanceM, direction }
      this.addMessage(
        CommsPriority.CRITICAL,
        'SPACECRAFT',
        `Emergency dodge! Debris ${data.debrisId} at ${Math.round(data.distanceM)}m. Burned some cold-gas thruster fuel to get clear.`
      );
    });

    eventBus.on(Events.SCORE_UPDATE, (data) => {
      if (data.debrisCleared && data.debrisCleared % 10 === 0 && data.debrisCleared > 0) {
        if (!this._canSend('milestone')) return;
        this.addMessage(
          CommsPriority.INFO,
          'HOUSTON',
          `Milestone reached: ${data.debrisCleared} debris objects cleared. Score: ${data.total.toLocaleString()}. Outstanding work.`,
          { _quiet: true }   // praise, hidden
        );
      }
    });

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

    // News ticker: routes to the MISSION channel.
    eventBus.on(Events.NEWS_EVENT_TRIGGERED, (data) => {
      const dateStr = data.date || '????-??-??';
      const headline = data.headline || data.name || 'Unknown event';
      this.addMessage('WARNING', 'NEWS', `[${dateStr} NEWS] ${headline}`);

      // the bounty announcement follows 2 s later
      const bountyStr = (data.bounty || 0).toLocaleString();
      const debrisName = data.debrisName || 'unknown';
      timerManager.setTimeout(() => {
        this.addMessage('INFO', 'NEWS', `Bounty posted: ${bountyStr} cr. Target ${debrisName}`);
      }, 2000, { owner: this });
    });

    // ISRO handoff dialogue (Houston→Bangalore), triggered by the first BANGALORE-sourced COMMS_MESSAGE.
    this._isroHandoffDone = false;

    eventBus.on(Events.COMMS_MESSAGE, (data) => {
      if (this._isroHandoffDone) return;
      if (data._internal) return; // skip self-emitted
      const src = (data.source || '').toUpperCase();
      if (src === 'BANGALORE' || src === 'HASSAN') {
        this._isroHandoffDone = true;
        timerManager.setTimeout(() => {
          // scripted radio hand-off chatter, hidden (the Bangalore coach lines are separate)
          this.addMessage('INFO', 'HOUSTON', 'Houston: handing off to Bangalore ISTRAC. Good hunting.', { _quiet: true });
        }, 500, { owner: this });
        timerManager.setTimeout(() => {
          this.addMessage('INFO', 'BANGALORE', 'ISTRAC Bangalore: Roger, we have the conn. Tracking nominal.', { _quiet: true });
        }, 2500, { owner: this });
      }
    });

    // Capture-flow comms.

    eventBus.on(Events.TETHER_SNAP, (data) => {
      this.addMessage('CRITICAL', daughterDisplayName(data?.armId) || 'SYSTEM', 'TETHER SEVERED. Daughter and catch cut loose and drifting. Reload not possible; send another daughter to chase it down.', { channel: 'ALERT' });
    });

    // Net-integrity failure (recoverable): the net lost its grip on a heavy catch; the daughter is fine, the debris is
    // loose. Where she goes next (reeled home / held for a retry) is her own line's job (ArmUnit._finishFailedCatch).
    eventBus.on(Events.NET_FAILED, (data) => {
      this.addMessage('WARNING', daughterDisplayName(data?.armId) || 'SYSTEM', 'NET FAILED. Debris slipped the net and is drifting.', { channel: 'ALERT' });
    });

    // Net MISS reasons → actionable plain text: a miss is fully recoverable (the net reels back, inventory restored),
    // so the line must say WHY it missed and what to do next. 'forced' (test/scripted resolves) stays silent.
    eventBus.on(Events.NET_CATCH_MISS, (data) => {
      const text = missReasonToText(data?.reason);
      if (!text) return;
      const source = (data?.armIndex != null && data.armIndex >= 0)
        ? `ARM-${data.armIndex + 1}` : 'LARGE NET';
      this.addMessage('WARNING', source, text, { channel: 'ALERT' });
    });

    eventBus.on(Events.ARM_RETURNED, (data) => {
      if (data?.captured === true) {
        this.addMessage('INFO', daughterDisplayName(data.armId) || 'SYSTEM', 'Docking. 3 s.', { channel: 'CMD' });
      }
    });

    eventBus.on(Events.CROSSBOW_RELOAD_COMPLETE, (data) => {
      this.addMessage('INFO', daughterDisplayName(data?.armId) || 'SYSTEM', 'Spring re-charged. Ready for next deploy.', { channel: 'CMD' });
    });

    // STATION_KEEP_ENTERED → ONE line, one action (DECISIONS §33 row 3). The daughter holds station; N works her
    // recommended tool (InputManager KeyN reaches a holding daughter without pilot mode). The pad, the gripper and the
    // magnet each say their own word (the net's line is every other tool's). Plain words, no symbols (Ruling 0); the
    // number keys that pilot her are in the help page, not here. On glass `chipPhrase` turns each "Press N to ..." into
    // its button (STICK PAD / CLOSE GRIPPER / USE MAGNET). When N goes to the mother's net or to another daughter, the
    // line names her number key.
    const inPositionLine = (tool, armId, inspect = false) => inspect === true
      // over the catch limit she only inspects it: no "Press N", so no net chip on glass either
      ? 'Daughter in position, inspecting it. No net.'
      : flyFirstLine(armId, (tool === 'PAD' ? 'Daughter in position. Press N to stick the pad on.'
        : tool === 'GRIPPER' ? 'Daughter in position. Press N to grip it.'
          : tool === 'MAGNET' ? 'Daughter in position. Press N to use the magnet.'
            : 'Daughter in position. Press N to net it.'));
    eventBus.on(Events.STATION_KEEP_ENTERED, (data) => {
      const armId = daughterDisplayName(data?.armId) || 'SYSTEM';
      this.addMessage('INFO', armId, inPositionLine(data?.tool, data?.armId, data?.inspect), { channel: 'CMD' });
    });
    // The PLAYER changed her tool (backquote or CHANGE TOOL): say the new tool's line once. The recommendation ArmUnit
    // makes on station-keep entry emits TOOL_SELECTED too, without `byPlayer`: the entry line above covers it.
    eventBus.on(Events.TOOL_SELECTED, (data) => {
      if (!data || data.byPlayer !== true) return;
      this.addMessage('INFO', daughterDisplayName(data.armId) || 'SYSTEM', inPositionLine(data.tool, data.armId, data.inspect), { channel: 'CMD' });
    });
  }

  /**
   * Per-frame update — generates timed messages.
   * @param {number} dt - real-time delta (s)
   * @param {object} [gameData] - game state reference
   */
  update(dt, gameData) {
    // the safety: a gate left shut (a start that never reached its hand-over) opens itself
    if (!this._gateOpen) {
      this._holdElapsedS += dt;
      if (this._holdElapsedS >= HOLD_SAFETY_S) this._openGate();
    }
    if (!this._active) return;

    const gameDt = dt * TimeAuthority.BASE_SCALE;
    this._gameTime += gameDt;

    // post-onboarding suppression ramp (real dt; pause-safe)
    this._advanceSuppression(dt);

    for (const [key, time] of this._cooldowns) {
      this._cooldowns.set(key, time - dt);
      if (time - dt <= 0) this._cooldowns.delete(key);
    }

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

    this._nextFlavorTime -= dt;
    if (this._nextFlavorTime <= 0) {
      this._nextFlavorTime = this._randomFlavorInterval();
      this._sendFlavorMessage();
    }

    this._nextLaunchTime -= dt;
    if (this._nextLaunchTime <= 0) {
      this._nextLaunchTime = 180 + Math.random() * 420; // 3-10 min
      this._sendLaunchAlert();
    }

    this._nextWeatherTime -= dt;
    if (this._nextWeatherTime <= 0) {
      this._nextWeatherTime = 180 + Math.random() * 360;
      this._sendWeatherEvent();
    }

    this._nextMissionTime -= dt;
    if (this._nextMissionTime <= 0) {
      this._nextMissionTime = 90 + Math.random() * 180;
      this._sendMissionUpdate(gameData);
    }
  }

  /** @private */
  _sendFlavorMessage() {
    const msg = FLAVOR_MESSAGES[Math.floor(Math.random() * FLAVOR_MESSAGES.length)];
    // radio chatter on a timer, no player action behind it: hidden at every tier
    this.addMessage(CommsPriority.INFO, msg.source, msg.text, { _quiet: true });
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
    // `{target}` is a LIVE piece from the field, never a made-up "Object-NNN". With no live piece the templates that
    // need one are not sent (the others still are).
    const list = (gameData && gameData.debrisField && Array.isArray(gameData.debrisField.debrisList))
      ? gameData.debrisField.debrisList : [];
    // a piece already caught (`_captured`) is not named either: it is no longer there to be scanned or slowed
    const live = list.filter((d) => d && d.alive !== false && d._captured !== true);
    const piece = live.length > 0 ? live[Math.floor(Math.random() * live.length)] : null;
    const eligible = MISSION_TEMPLATES.filter((t) => !t.needsTarget || piece);
    if (eligible.length === 0) return;
    const tmpl = eligible[Math.floor(Math.random() * eligible.length)];

    // the piece's own spin rate (rad/s on the record); without one the line is said without a number
    const spinDegS = (piece && Number.isFinite(piece.tumbleRate) && piece.tumbleRate > 0)
      ? radToDeg(piece.tumbleRate) : null;
    let template = tmpl.template;
    if (tmpl.needsSpin && spinDegS === null) template = tmpl.templateNoSpin;

    const text = template
      .replace('{target}', piece ? missionTargetName(piece) : '')
      .replace('{alt}', (400 + Math.floor(Math.random() * 800)).toString())
      .replace('{tumble}', spinDegS === null ? '' : spinDegS.toFixed(1))
      .replace('{days}', (30 + Math.floor(Math.random() * 365)).toString());

    this.addMessage(tmpl.priority, tmpl.source, text, tmpl.quiet ? { _quiet: true } : undefined);
  }

  /**
   * Add a new message to the comms log (classifies the channel, applies coalescing).
   * @param {string} priority - CommsPriority enum
   * @param {string} source - e.g. 'HOUSTON'
   * @param {object} [extra] - extra fields (channel, `_critical`, `_quiet`, ...)
   */
  addMessage(priority, source, text, extra) {
    // a missing source defaults to 'SYSTEM'; bail only on missing text
    if (!source) {
      const named = splitDaughterPrefix(text);   // "Small 1: ..." with no source: she is the sender
      if (named) { source = named.source; text = named.text; }
      else {
        console.debug('[CommsSystem] addMessage() sourceless call defaulted to SYSTEM:', text);
        source = 'SYSTEM';
      }
    }
    if (!text) return;
    text = stripSenderPrefix(source, text);   // the sender is shown once (COMMS_SEND lands here too)
    const rawText = text;
    text = GestureHints.chipPhrase(text);   // glass names the button, not the key (desktop: same string)
    const channel = sourceToChannel(source, { text, ...(extra || {}) });

    // Tier gate. addMessage() is the internal path for flavour templates, Kessler, weather, MMOD, etc.; at the
    // default tier 3 it is a no-op.
    if (!messagePassesSuppression(this._suppressionTier, channel, extra, priority)) {
      return;
    }

    // Behind a shut gate the line waits (no log, no callback, no sound, no summary). The internal event still fires
    // (other systems read it).
    if (!this._gateOpen) {
      const held = {
        id: this._nextId++, timestamp: this._clockStamp(), source, text, priority, channel, age: 0,
      };
      this._hold(held, !!extra && (extra._critical === true || extra._reactive === true));
      eventBus.emit(Events.COMMS_MESSAGE, { ...held, _internal: true });
      return;
    }

    const now = new Date();
    const timestamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    const nowMs = Date.now();

    const windowMs = COMMS.COALESCE_WINDOW_MS || 2000;
    this._coalesceWindow = this._coalesceWindow.filter(e => (nowMs - e.timestamp) < windowMs);
    // "kept" lines: see the COMMS_MESSAGE listener
    const kept = !!extra && (extra._critical === true || extra._reactive === true || extra._keep === true);
    const coal = kept ? { shouldCoalesce: false, count: 0 }
      : shouldCoalesce(this._coalesceWindow, channel, COMMS.COALESCE_THRESHOLD_COUNT);
    if (!kept) this._coalesceWindow.push({ channel, timestamp: nowMs });

    if (coal.shouldCoalesce) {
      // as in the COMMS_MESSAGE listener: drop the burst's older lines, post this one normally
      let removed = 0;
      for (let i = this.messages.length - 1; i >= 0 && removed < coal.count - 1; i--) {
        if (this.messages[i].channel === channel && !this.messages[i].keep) {
          this.messages.splice(i, 1);
          removed++;
        }
      }
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
    if (kept) msg.keep = true;

    this.messages.push(msg);
    GestureHints.noteChipLine(rawText);   // the text as passed in, before chipPhrase

    while (this.messages.length > MAX_MESSAGES) {
      this.messages.shift();
    }

    this._playMessageSound(priority);

    if (this.onMessage) {
      this.onMessage(msg);
    }

    // tagged _internal to prevent a self-listen loop
    eventBus.emit(Events.COMMS_MESSAGE, { ...msg, _internal: true });
  }

  // the start-up hold

  /** @private HH:MM:SS of now (the log's stamp). */
  _clockStamp() {
    const now = new Date();
    return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
  }

  /** @private Park a built message behind the shut gate (bounded: the oldest falls off). */
  _hold(msg, keep) {
    if (keep) msg.keep = true;
    this._held.push(msg);
    while (this._held.length > MAX_MESSAGES) this._held.shift();
  }

  /** @private COMMS_HOLD: shut the gate. Idempotent; restarts the safety clock. */
  _shutGate() {
    this._gateOpen = false;
    this._holdElapsedS = 0;
  }

  /**
   * @private COMMS_RELEASE (or the safety): open the gate. The held lines go into the log in order,
   * silently (no sound, no callback) and without a coalesce summary, ahead of anything posted after the
   * open. Idempotent.
   */
  _openGate() {
    if (this._gateOpen) return;
    this._gateOpen = true;
    this._holdElapsedS = 0;
    const held = this._held;
    this._held = [];
    for (const msg of held) this.messages.push(msg);
    while (this.messages.length > MAX_MESSAGES) this.messages.shift();
    // Repaint the panel now (a timeout / endState release has no post after it to do that). Text-less, so
    // no other listener records it; the HUD's COMMS_MESSAGE route calls commsPanel.onMessage as usual.
    if (held.length) eventBus.emit(Events.COMMS_MESSAGE, { _internal: true, _repaint: true });
  }

  /** @returns {boolean} false while the start-up hold is shut. */
  isGateOpen() { return this._gateOpen; }

  /** @returns {number} lines waiting behind the gate. */
  heldCount() { return this._held.length; }

  /** @returns {Array} all messages, newest last. */
  getMessages() {
    return this.messages;
  }

  start() {
    this._active = true;
    this.addMessage(
      CommsPriority.INFO,
      'HOUSTON',
      'Comm link established. All systems nominal. Good hunting, Cowboy.'
    );
  }

  stop() {
    this._active = false;
  }

  reset() {
    this.messages = [];
    this._nextId = 0;
    // a shut gate stays shut and keeps its held lines (GAME_RESET can arrive after the hold began); renumber them so
    // they cannot collide with ids handed out after the reset
    for (const m of this._held) m.id = this._nextId++;
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
    // back to the steady-state default; onboarding (if it re-runs) drops to 0
    this._suppressionTier = 3;
    this._postOnboardingElapsed = 0;
    this._tempTierActive = false;
    this._tempTierRestoreS = 0;
    this._onboardingWasRun = false;
    this._tutorialMastered = false;
  }

  /** @returns {number} current suppression tier (0–3). */
  getSuppressionTier() { return this._suppressionTier; }

  /**
   * Would a raw COMMS_MESSAGE payload be shown right now? The HUD asks this before redrawing the panel, so a hidden
   * line (tier gate or `_quiet`) does not reset the PageUp scroll. Same classification and gate as the COMMS_MESSAGE
   * listener; lines this system already stored (`_internal`) were gated when they were added.
   * @param {object} data — the COMMS_MESSAGE payload
   * @returns {boolean}
   */
  wouldShow(data) {
    if (!data) return false;
    if (data._internal) return true;
    if (!data.text) return false;
    const src = data.source || data.sender || data.speaker || 'SYSTEM';
    return messagePassesSuppression(this._suppressionTier, sourceToChannel(src, data), data, data.priority);
  }

  /** @private Begin the graduated post-onboarding wake ramp (tier 1 → 2 → 3). */
  _beginPostOnboardingRamp() {
    // the tutorial already ended (ONBOARDING_MASTERED came first): stay at tier 3; a late COMPLETE must not mute the panel again
    if (this._tutorialMastered) return;
    // Veteran-skip path: ONBOARDING_COMPLETE fired WITHOUT ONBOARDING_STARTED, so there is nothing to wake from:
    // stay at tier 3 instead of muting for 60 s.
    const startTier = postOnboardingStartTier(this._onboardingWasRun);
    if (startTier >= 3) {
      this._suppressionTier = 3;
      this._postOnboardingElapsed = 0;
      this._tempTierActive = false;
      this._tempTierRestoreS = 0;
      return;
    }
    this._suppressionTier = startTier;
    this._postOnboardingElapsed = 0;
    this._tempTierActive = false;
    this._tempTierRestoreS = 0;
  }

  /**
   * The tutorial's beat list is done (ONBOARDING_MASTERED). Leave tier 0 for tier 3 at once: the useful lines
   * (progress, where each catch went, autopilot, failures) show within a frame; `_quiet` lines stay hidden at every tier.
   * @private
   */
  _endTutorialSilence() {
    this._tutorialMastered = true;
    this._suppressionTier = 3;
    this._postOnboardingElapsed = 0;
    this._tempTierActive = false;
    this._tempTierRestoreS = 0;
  }

  /**
   * Temporarily drop to a protected tier for a high-cognitive-load MissionCoach beat; the ramp auto-restores after
   * `durationS` seconds of play.
   */
  _tempDropToTier(tier, durationS) {
    this._suppressionTier = clamp(tier | 0, 0, 3);
    this._tempTierActive = true;
    this._tempTierRestoreS = Math.max(0, durationS || 0);
  }

  /**
   * Advance the suppression ramp by `dt` seconds of (unpaused) play (driven off the game loop, so it respects pause).
   */
  _advanceSuppression(dt) {
    // a MissionCoach beat is holding a protected tier: count it down first
    if (this._tempTierActive) {
      this._tempTierRestoreS -= dt;
      if (this._tempTierRestoreS > 0) return; // keep holding the protected tier
      this._tempTierActive = false;           // released → resume the ramp below
    }
    // tier 0 (onboarding) and tier 3 (steady state) are terminal for the ramp
    if (this._suppressionTier <= 0 || this._suppressionTier >= 3) return;
    this._postOnboardingElapsed += dt;
    this._suppressionTier = rampSuppressionTier(this._postOnboardingElapsed);
  }

  /** @private The loaded fuel's display name: the last FUEL_CHANGED, else the default fuel's own name. */
  _fuelName() {
    if (this._fuel) return this._fuel;
    const f = Constants.FUELS && Constants.FUELS[Constants.DEFAULT_FUEL];
    return (f && f.name) || 'engine';
  }

  /** @private Cooldown gate for event-based messages. */
  _canSend(eventKey) {
    if (this._cooldowns.has(eventKey)) return false;
    this._cooldowns.set(eventKey, EVENT_COOLDOWN);
    return true;
  }

  _randomFlavorInterval() {
    return FLAVOR_MIN_INTERVAL + Math.random() * (FLAVOR_MAX_INTERVAL - FLAVOR_MIN_INTERVAL);
  }

  _playMessageSound(priority) {
    if (!audioSystem.available) {
      audioSystem.init();
    }
    audioSystem.resume();

    switch (priority) {
      case CommsPriority.CRITICAL:
        audioSystem.playRadioNotice('CRITICAL');
        break;
      case CommsPriority.WARNING:
        audioSystem.playRadioNotice('WARNING');
        break;
      case CommsPriority.INFO:
        // INFO blip audio deliberately omitted (UX decision)
        break;
    }
  }
}

export default CommsSystem;

// CJS guard: pure helpers for Node.js tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sourceToChannel, shouldCoalesce };
}
