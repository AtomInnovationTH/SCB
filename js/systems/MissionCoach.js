/**
 * MissionCoach.js — per-chapter coaching engine (CP-4 / MISSION_ARC_IMPLEMENTATION §2).
 *
 * Chapters 2+ are taught here as DATA (`Constants.MISSION_COACH.BEATS_BY_MISSION[N]`);
 * chapter 1 stays with OnboardingDirector. On `SHOP_DEPLOY` into mission N, the
 * coach runs that mission's beats once via a shared {@link BeatSequencer}:
 *   • every beat posts an MISSION-channel, `_postOnboarding`-tagged comms line so
 *     it survives the CP-4 suppression ramp at tiers ≥ 1;
 *   • interactive beats emit `MISSION_BEAT_STARTED` (so TeachingSystem's collision
 *     rule defers/drops redundant overlays) and resolve on their trigger event
 *     (+ optional payload filter) → `MISSION_BEAT_SATISFIED`;
 *   • an unsatisfied interactive beat re-prompts via `TEACHING_MOMENT_FORCE`.
 * Completion is persisted so a mission is coached only once.
 *
 * Node-safe (no THREE / DOM) — unit-tested against the real EventBus.
 *
 * @module systems/MissionCoach
 */

import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { BeatSequencer, buildBeatComms, beatMatches } from './_beatLifecycle.js';

export class MissionCoach {
  /**
   * @param {object} deps
   * @param {object} deps.eventBus
   * @param {object} [deps.scoringSystem]      — provides getMissionNumber()
   * @param {object} [deps.persistenceManager] — peek() for restore
   * @param {object} [deps.commsSystem]        — optional, for _tempDropToTier protection
   */
  constructor({ eventBus, scoringSystem = null, persistenceManager = null, commsSystem = null } = {}) {
    this._eventBus = eventBus;
    this._scoring = scoringSystem;
    this._pm = persistenceManager;
    this._comms = commsSystem;

    /** @type {Object<number, boolean>} missions whose coaching has completed. */
    this._completedByMission = {};
    /** @type {number|null} mission currently being coached. */
    this._activeMission = null;
    /** @type {BeatSequencer|null} */
    this._seq = null;
    /** @type {Function|null} one-shot unsub for the active interactive beat's trigger. */
    this._beatUnsub = null;

    this._unsubs = [];
    this._disposed = false;
  }

  // --------------------------------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------------------------------

  /** Subscribe to triggers. Call once after construction. */
  init() {
    if (this._disposed || !this._eventBus) return;
    const on = (evt, h) => { if (evt) this._unsubs.push(this._eventBus.on(evt, h)); };

    on(Events.SHOP_DEPLOY, (d) => this._onShopDeploy(d));
    on(Events.GAME_RESET, () => this.reset());
    on(Events.PERSISTENCE_GATHER, (save) => { if (save) save.missionCoach = this._serialize(); });
    on(Events.PERSISTENCE_LOADED, () => {
      const save = this._pm && typeof this._pm.peek === 'function' ? this._pm.peek() : null;
      if (save && save.missionCoach) this._restore(save.missionCoach);
    });
  }

  /** Per-frame tick — drives narrative dwell + interactive escalation timers. */
  update(dt) {
    if (this._disposed || !this._seq) return;
    this._seq.update(dt);
  }

  /** @param {number} mission @returns {boolean} */
  hasCoached(mission) {
    return !!this._completedByMission[mission];
  }

  /** @returns {boolean} whether a beat sequence is currently running. */
  isRunning() {
    return !!(this._seq && this._seq.running);
  }

  /** Clear all coaching state (GAME_RESET / new game). */
  reset() {
    this._clearActive();
    this._completedByMission = {};
    this._activeMission = null;
  }

  /** Remove listeners. */
  dispose() {
    this._disposed = true;
    this._clearActive();
    for (const u of this._unsubs) { if (typeof u === 'function') u(); }
    this._unsubs.length = 0;
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  /** @private */
  _onShopDeploy(data) {
    if (this.isRunning()) return; // never overlap chapters
    const mission = (data && typeof data.mission === 'number')
      ? data.mission
      : (this._scoring && typeof this._scoring.getMissionNumber === 'function'
        ? this._scoring.getMissionNumber() : 1);

    if (this._completedByMission[mission]) return;
    const table = Constants.MISSION_COACH
      && Constants.MISSION_COACH.BEATS_BY_MISSION
      && Constants.MISSION_COACH.BEATS_BY_MISSION[mission];
    if (!Array.isArray(table) || table.length === 0) return;

    this._activeMission = mission;
    const MC = Constants.MISSION_COACH;
    this._seq = new BeatSequencer({
      beats: table,
      timing: { narrativeHoldMs: MC.NARRATIVE_HOLD_MS, escalateMs: MC.ESCALATE_MS },
      hooks: {
        onPost: (beat) => this._postBeat(beat),
        onSatisfy: (beat) => this._satisfyBeat(beat),
        onEscalate: (beat) => this._escalateBeat(beat),
        onComplete: () => this._complete(),
      },
    });
    this._seq.start();
  }

  /** @private Post a beat: comms line + (interactive) beat-start + trigger arming. */
  _postBeat(beat) {
    this._eventBus.emit(Events.COMMS_MESSAGE, buildBeatComms(beat));

    // Clear any prior beat's armed trigger before arming the next.
    this._disarmBeat();

    if (beat.type === 'interactive' || beat.type === 'reactive') {
      this._eventBus.emit(Events.MISSION_BEAT_STARTED, {
        skillId: beat.skillId || beat.id,
        beatId: beat.id,
        mission: this._activeMission,
      });
      const evt = beat.triggerEvent && Events[beat.triggerEvent];
      if (evt) {
        const handler = (payload) => {
          if (!beatMatches(beat, payload)) return;
          if (this._seq) this._seq.satisfy(); // → onSatisfy hook
        };
        this._beatUnsub = this._eventBus.on(evt, handler);
      }
    }
  }

  /** @private Beat satisfied → announce + disarm; sequencer advances. */
  _satisfyBeat(beat) {
    this._eventBus.emit(Events.MISSION_BEAT_SATISFIED, {
      skillId: beat.skillId || beat.id,
      beatId: beat.id,
      mission: this._activeMission,
    });
    this._disarmBeat();
  }

  /** @private Unsatisfied interactive beat → re-prompt via the teaching overlay. */
  _escalateBeat(beat) {
    this._eventBus.emit(Events.TEACHING_MOMENT_FORCE, {
      id: `coach_${beat.id}`,
      title: beat.title || 'MISSION COACH',
      body: beat.body || beat.text || '',
      icon: '🛰️',
    });
  }

  /** @private All beats done → persist completion. */
  _complete() {
    if (this._activeMission != null) {
      this._completedByMission[this._activeMission] = true;
    }
    this._disarmBeat();
    this._activeMission = null;
    this._seq = null;
  }

  /** @private Remove the active beat's one-shot trigger listener. */
  _disarmBeat() {
    if (typeof this._beatUnsub === 'function') this._beatUnsub();
    this._beatUnsub = null;
  }

  /** @private Stop the current run entirely. */
  _clearActive() {
    this._disarmBeat();
    if (this._seq) this._seq.reset();
    this._seq = null;
  }

  /** @private */
  _serialize() {
    return { version: 1, completedByMission: { ...this._completedByMission } };
  }

  /** @private */
  _restore(data) {
    if (data && data.completedByMission && typeof data.completedByMission === 'object') {
      this._completedByMission = { ...data.completedByMission };
    }
  }
}

export default MissionCoach;
