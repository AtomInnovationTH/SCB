/**
 * @module systems/MissionCoach — per-chapter coaching engine. Chapters 2+ are taught as DATA
 * (`Constants.MISSION_COACH.BEATS_BY_MISSION[N]`); chapter 1 stays with OnboardingDirector.
 *
 * At the MISSION BOUNDARY into mission N (`MISSION_START { missionNumber: N }` — the credited catch that closes
 * chapter N−1; not `SHOP_DEPLOY`, which the chapter-4+ depot INVITATION made optional) the coach ARMS chapter N and
 * starts it on the first gameplay frame with no depot stop pending (`_bossLifecycle.MissionOnset`, the one rule shared
 * with the bosses: chapters 1–3 hold through the "MISSION N COMPLETE" card and the SHOP and open after DEPLOY;
 * chapter 4+ opens at once behind the glowing DEPOT notch). The beats then run once via a shared {@link BeatSequencer}:
 *   • every beat posts a MISSION-channel, `_postOnboarding`-tagged comms line so it survives the suppression ramp at
 *     tiers ≥ 1;
 *   • interactive beats emit `MISSION_BEAT_STARTED` (so TeachingSystem's collision rule defers/drops redundant
 *     overlays) and resolve on their trigger event (+ optional payload filter) → `MISSION_BEAT_SATISFIED`;
 *   • an unsatisfied interactive beat re-prompts via `TEACHING_MOMENT_FORCE`.
 * Completion is persisted so a mission is coached only once. Node-safe (no THREE / DOM).
 */

import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { GameStates } from '../core/GameState.js';
import { BeatSequencer, buildBeatComms, beatMatches } from './_beatLifecycle.js';
import { MissionOnset } from './_bossLifecycle.js';
import { satelliteIsTheStop, wordsFor } from './resupplyWords.js';

/** Training chapters: one still running when the next mission starts ends quietly (plan D7). */
const TRAINING_CHAPTERS = [2, 3];

/** The mover beats a caught mover ends (the lesson's goal is reached); `ch3_net` ends on the net catch itself (NET_CATCH_SUCCESS). */
const ENDS_ON_MOVER_CATCH = ['ch3_pick', 'ch3_close', 'ch3_despin'];
/** A daughter's tool catch (magnet, gripper, pad) reaches the goal with no net event, so it ends `ch3_net` too (plan fix F4). */
const ENDS_ON_TOOL_CATCH = [...ENDS_ON_MOVER_CATCH, 'ch3_net'];

/** The one line when no mover is left in the field while a mover beat is open (plan D9). */
export const NO_MOVERS_LINE = 'No moving pieces left here.';

export class MissionCoach {
  /**
   * @param {object} deps
   * @param {object} deps.eventBus
   * @param {object} [deps.scoringSystem]      — provides getMissionNumber()
   * @param {object} [deps.persistenceManager] — peek() for restore
   * @param {object} [deps.commsSystem]        — optional, for _tempDropToTier protection
   * @param {Function} [deps.depotStopPending] — () => boolean (GameFlowManager.isDepotStopPending(), wired by main.js):
   *   an armed chapter holds while it returns true. Default: never pending (headless / tests fire on the next update).
   * @param {object} [deps.fieldRegistry] — `currentField()` names the field she is at, for a beat's `mapText`.
   */
  constructor({ eventBus, scoringSystem = null, persistenceManager = null, commsSystem = null, depotStopPending = null, fieldRegistry = null } = {}) {
    this._eventBus = eventBus;
    this._scoring = scoringSystem;
    this._pm = persistenceManager;
    this._comms = commsSystem;
    this._fields = fieldRegistry;
    this._depotStopPending = typeof depotStopPending === 'function' ? depotStopPending : () => false;

    /** @type {Object<number, boolean>} missions whose coaching has completed. */
    this._completedByMission = {};
    /** @type {number|null} mission currently being coached. */
    this._activeMission = null;
    /** @type {BeatSequencer|null} */
    this._seq = null;
    /** @type {Function|null} one-shot unsub for the active interactive beat's trigger. */
    this._beatUnsub = null;
    /** @type {MissionOnset} the armed (not yet started) chapter — the shared onset rule. */
    this._onset = new MissionOnset();
    /**
     * What the coach has seen of the training-3 lesson, from events (it holds no selector, autopilot or field): the selected piece (the
     * live debris, so a spin is read live), the last mover arrival, whether a mover was caught since the chapter began, how many uncaught
     * movers the field holds (null = not told). (The approach-cost line is not here: ApproachCostLine says it after every approach.)
     */
    this._latch = this._freshLatch();

    this._unsubs = [];
    this._disposed = false;
  }

  /** Subscribe to triggers. Call once after construction. */
  init() {
    if (this._disposed || !this._eventBus) return;
    const on = (evt, h) => { if (evt) this._unsubs.push(this._eventBus.on(evt, h)); };

    on(Events.MISSION_START, (d) => this._onMissionStart(d));
    // A terminal state before the armed chapter fires cancels it (a GAME_OVER
    // continue restarts the counter at 0; a new game resets everything).
    on(Events.GAME_STATE_CHANGE, (d) => {
      if (d && (d.to === GameStates.GAME_OVER || d.to === GameStates.WIN)) this._onset.cancel();
    });
    // The autopilot could not set the double shot up in time (it has said why): end the beat so the chapter, and the
    // next one behind it, does not wait for ever.
    on(Events.PAIR_LESSON_SKIP, () => this.satisfyBeat('ch2_pair_shot'));
    // The training-3 latch (plan D5, D9). Registered here, before any beat arms its own trigger, so on one event the latch is
    // updated first and a beat's own handler reads it.
    on(Events.TARGET_SELECTED, (d) => { this._latch.selected = d ? (d.debris || { id: d.id }) : null; });
    on(Events.TARGET_CLEARED, () => { this._latch.selected = null; });
    on(Events.AUTOPILOT_ENGAGE, () => { this._latch.arrived = null; });
    on(Events.AUTOPILOT_ARRIVED, (d) => {
      if (d && d.mover === true) this._latch.arrived = { debrisId: d.debrisId ?? null };
    });
    on(Events.AUTOPILOT_DISENGAGE, () => { this._latch.arrived = null; });
    on(Events.NET_CATCH_SUCCESS, (d) => this._onMoverCaught(d));
    on(Events.ARM_CAPTURED, (d) => this._onMoverCaught(d, ENDS_ON_TOOL_CATCH));   // a daughter's tool catch carries `mover` (net catches do not: they came as NET_CATCH_SUCCESS)
    on(Events.MOVERS_CHANGED, (d) => this._onMoversChanged(d));
    on(Events.GAME_RESET, () => this.reset());
    on(Events.PERSISTENCE_GATHER, (save) => { if (save) save.missionCoach = this._serialize(); });
    on(Events.PERSISTENCE_LOADED, () => {
      const save = this._pm && typeof this._pm.peek === 'function' ? this._pm.peek() : null;
      if (save && save.missionCoach) this._restore(save.missionCoach);
    });
  }

  /** Per-frame tick (gameplay frames only): fires an armed chapter, then drives narrative dwell + escalation timers. */
  update(dt) {
    if (this._disposed) return;
    if (this._onset.armed) {
      // Hold while the depot stop is pending (the boss/chapter never starts
      // under the depot) and while a chapter is still running (never overlap).
      const mission = this._onset.poll(this._depotStopPending() || this.isRunning());
      if (mission != null) this._startChapter(mission);
    }
    if (!this._seq) return;
    this._seq.update(dt);
  }

  /**
   * End the interactive beat `beatId` as satisfied by something other than its own trigger (the same hook the trigger takes).
   * @returns {boolean} true when that beat was the one on screen
   */
  satisfyBeat(beatId) {
    if (this._disposed || !this._seq) return false;
    const cur = this._seq.current();
    if (!cur || cur.id !== beatId) return false;
    return this._seq.satisfy();
  }

  hasCoached(mission) {
    return !!this._completedByMission[mission];
  }

  /** @returns {boolean} whether a beat sequence is currently running. */
  isRunning() {
    return !!(this._seq && this._seq.running);
  }

  /** @returns {number|null} the chapter armed at a boundary and not yet started. */
  armedMission() {
    return this._onset.mission;
  }

  reset() {
    this._clearActive();
    this._onset.cancel();
    this._completedByMission = {};
    this._activeMission = null;
    this._latch = this._freshLatch();
  }

  dispose() {
    this._disposed = true;
    this._clearActive();
    this._onset.cancel();
    for (const u of this._unsubs) { if (typeof u === 'function') u(); }
    this._unsubs.length = 0;
  }

  /** @private ARM the chapter for the mission that just started (the boundary catch). */
  _onMissionStart(data) {
    const mission = (data && typeof data.missionNumber === 'number')
      ? data.missionNumber
      : (this._scoring && typeof this._scoring.getMissionNumber === 'function'
        ? this._scoring.getMissionNumber() : 1);
    if (!this._hasChapter(mission)) return;
    // A training chapter never holds the next mission's lesson (training 3 plan D7): the boundary catch that opens
    // chapter N+1 ends a still-running chapter N (N = 2 or 3) quietly, so "never overlap" still holds.
    if (this.isRunning() && this._activeMission != null && TRAINING_CHAPTERS.includes(this._activeMission)
      && mission === this._activeMission + 1) this._endChapterQuietly();
    this._onset.arm(mission);
  }

  /**
   * @private End the running chapter with no line: the open interactive beat (if any) is announced as satisfied (so the
   * autopilot's pair lesson ends), the run stops, and the chapter counts as coached, as after a normal finish.
   */
  _endChapterQuietly() {
    const cur = this._seq ? this._seq.current() : null;
    if (cur && (cur.type === 'interactive' || cur.type === 'reactive')) this._satisfyBeat(cur);
    this._clearActive();
    this._complete();
  }

  /** @private */
  _freshLatch() {
    return { selected: null, arrived: null, caught: false, left: null };
  }

  /**
   * @private A mover was netted (NET_CATCH_SUCCESS with `mover`): the lesson's goal is reached. An open pick, close or de-spin beat
   * ends here (the rest are passed over by `doneIf`); the net beat ends on the same event through its own trigger.
   */
  _onMoverCaught(d, endsBeats = ENDS_ON_MOVER_CATCH) {
    if (!d || d.mover !== true) return;
    this._latch.caught = true;
    const cur = this._seq ? this._seq.current() : null;
    if (cur && endsBeats.includes(cur.id)) this._seq.satisfy();
  }

  /**
   * @private DebrisField told us how many uncaught movers the field holds (plan D9). None left while a mover beat is open and
   * nothing was caught: one plain line, the beat ends, and `shouldSkip` passes over the other mover beats.
   */
  _onMoversChanged(d) {
    if (!d || !Number.isFinite(d.left)) return;
    this._latch.left = d.left;
    if (d.left !== 0 || this._latch.caught || !this._seq) return;
    const cur = this._seq.current();
    if (!cur || cur.mover !== true) return;
    this._eventBus.emit(Events.COMMS_MESSAGE, buildBeatComms({ source: 'HOUSTON', text: NO_MOVERS_LINE }));
    this._seq.satisfy();
  }

  /** @private The sequencer's skip rule (plan D5, D9): no mover left, or the beat's own `doneIf(latch)` says its goal is met. */
  _shouldSkip(beat) {
    if (beat.mover === true && this._latch.left === 0) return true;
    if (typeof beat.doneIf !== 'function') return false;
    try { return !!beat.doneIf(this._latch); } catch (_) { return false; }
  }

  /** @private A coachable, not-yet-coached mission with a beat table. */
  _hasChapter(mission) {
    if (this._completedByMission[mission]) return false;
    const table = Constants.MISSION_COACH
      && Constants.MISSION_COACH.BEATS_BY_MISSION
      && Constants.MISSION_COACH.BEATS_BY_MISSION[mission];
    return Array.isArray(table) && table.length > 0;
  }

  /** @private FIRE: run the chapter's beats (the first beat posts synchronously). */
  _startChapter(mission) {
    if (this.isRunning()) return; // never overlap chapters
    if (!this._hasChapter(mission)) return; // completed meanwhile (a restore during the hold)
    const table = Constants.MISSION_COACH.BEATS_BY_MISSION[mission];

    this._activeMission = mission;
    this._latch.caught = false;          // "caught since the chapter began"
    const MC = Constants.MISSION_COACH;
    this._seq = new BeatSequencer({
      beats: table,
      timing: { narrativeHoldMs: MC.NARRATIVE_HOLD_MS, escalateMs: MC.ESCALATE_MS },
      hooks: {
        onPost: (beat) => this._postBeat(beat),
        onSatisfy: (beat) => this._satisfyBeat(beat),
        onEscalate: (beat) => this._escalateBeat(beat),
        onComplete: () => this._complete(),
        shouldSkip: (beat) => this._shouldSkip(beat),
      },
    });
    this._seq.start();
  }

  /**
   * @private The beat as the player reads it now. Map off (or no registry / list to ask on): the table's words exactly.
   * Map on: a beat's `mapText` with `{km}` = the height she is at, and "resupply stop" read as "resupply satellite".
   */
  _view(beat) {
    let text = beat.text;
    if (typeof beat.mapText === 'string' && satelliteIsTheStop()) {
      const f = this._fields && typeof this._fields.currentField === 'function' ? this._fields.currentField() : null;
      if (f && Number.isFinite(f.altKm)) text = beat.mapText.replace('{km}', String(Math.round(f.altKm)));
    }
    return { ...beat, text: wordsFor(text), body: wordsFor(beat.body) };
  }

  /** @private Post a beat: comms line + (interactive) beat-start + trigger arming. */
  _postBeat(beat) {
    this._eventBus.emit(Events.COMMS_MESSAGE, buildBeatComms(this._view(beat)));

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
    const v = this._view(beat);
    this._eventBus.emit(Events.TEACHING_MOMENT_FORCE, {
      id: `coach_${beat.id}`,
      title: beat.title || 'MISSION COACH',
      body: v.body || v.text || '',
      icon: 'HINT',
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
