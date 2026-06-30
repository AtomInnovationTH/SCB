/**
 * OnboardingDirector.js — orchestrates the 16-beat first-experience pipeline.
 *
 * Delegation 2 (2026-05-31). Walks new players through:
 *   boot → handshake → arrows → struts → zoom → inspect → scan → target →
 *   autopilot → decision → (lasso || daughter) → complete
 *
 * Each beat may emit:
 *   • [`Events.COMMS_MESSAGE`](js/core/Events.js:117) on the comms channel
 *   • [`Events.HINT_POSTED`](js/core/Events.js:1)    on the bottom-screen ticker
 *   • [`Events.AUDIO_CUE`](js/core/Events.js:427)    soft chime for credit beats
 *   • [`Events.SKILL_DISCOVERED`](js/core/Events.js:303) brightens the related HUD panel
 *
 * Trigger detection uses the existing tutorial input events (TUTORIAL_*_INPUT)
 * plus new STRUT_DEPLOY_INPUT / CAMERA_ZOOM_INPUT. On first match the Director
 * fires HINT_SATISFIED + SCORING_AWARD + a Houston follow-up message, then
 * advances after `beat.advanceDelay`.
 *
 * Escalation paths:
 *   • Idle ≥ IDLE_ESCALATION_MS without satisfaction → emit TEACHING_MOMENT_FORCE
 *   • > UNRELATED_INPUT_THRESHOLD unrelated inputs without satisfaction → same
 *
 * Persistence: localStorage['spacecowboy_onboarding_v1'] = {
 *   completedBeats:[], skippedBeats:[], mastered:bool
 * }
 *
 * @module systems/OnboardingDirector
 */

import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';

// ────────────────────────────────────────────────────────────────────────────
// BEAT TABLE — fixed by spec.  Do not edit individual values without bumping
// Constants.ONBOARDING.STORAGE_KEY (since they affect "satisfied" semantics).
// ────────────────────────────────────────────────────────────────────────────

export const ONBOARDING_BEATS = [
  // ────────────────────────────────────────────────────────────────────────
  // REWARD-FIRST SPINE (.kilo/plans/new-player-onboarding-flow.md Phase 3).
  // Replaces the old 18-beat camera/attitude lecture. The action is the same
  // for everyone (lock → catch → close → clear); only the AMOUNT of talking
  // scales (guidanceLevel + behavior tuner). Camera/attitude keys are taught
  // contextually, just-in-time (D.6), NOT front-loaded here.
  // ────────────────────────────────────────────────────────────────────────
  {
    id: 'boot',
    commsSource: 'HOUSTON', commsText: 'Powering up. Telemetry online, Cowboy.',
    commsAck: null,
    glyph: '✓', keys: [], skillId: null,
    autoAdvanceAfter: 3000,
  },
  {
    id: 'handshake',
    commsSource: 'HOUSTON', commsText: 'We have you on telemetry. Reticle is live. It locks the nearest piece for you.',
    commsAck: null,
    glyph: '✓', keys: [], skillId: null,
    autoAdvanceAfter: 3000,
  },
  {
    // The tease. AutoLockController has locked the close glinting panel right
    // in front of the mother. Teach the ONE key the opening forces: the net.
    id: 'tease_lock',
    commsSource: 'HOUSTON', commsText: 'Debris {distM} meters in front. Launch net with N.',
    commsAck: 'Clean catch, Cowboy.',
    text: 'Launch net (N)',
    glyph: 'N',
    keys: ['KeyN'],
    triggerEvent: 'LASSO_FIRED',
    skillId: 'collect_lasso',
    credit: 10,
    escalationText: 'That bracket is your lock. Press N to launch the net.',
  },
  {
    // Confirm the first catch landed + name the reward loop. The reticle
    // auto-advances to the next forward piece (AutoLockController REACQUIRE).
    id: 'first_catch',
    commsSource: 'HOUSTON', commsText: 'Capture confirmed. Salvage refines into fuel and credits. Another one\'s locked. Take it.',
    commsAck: null,
    glyph: '✓', keys: [], skillId: null,
    triggerEvent: 'DEBRIS_CAPTURED',
    counterTarget: 1,
    credit: 0,
    autoAdvanceAfter: 6000,
  },
  {
    // Second easy catch — repetition, slightly more value. Already locked.
    id: 'second_catch',
    commsSource: 'HOUSTON', commsText: 'Good. Keep netting what the reticle locks.',
    commsAck: null,
    text: 'Net the next lock (N)',
    glyph: 'N',
    keys: ['KeyN'],
    triggerEvent: 'DEBRIS_CAPTURED',
    counterTarget: 1,
    skillId: 'collect_lasso',
    credit: 0,
    // No-net safety: if the player is out of nets here, graduate past rather
    // than stranding them (the NET_EMPTY_CLICK consolation path).
    netEmptySkip: true,
    netEmptyComms: 'Out of nets. We\'ll resupply. Moving on, Cowboy.',
  },
  {
    // The range wall. The third piece is beyond net range — autolock went
    // silent + yellow OUT OF RANGE. Teach Autopilot (A) here and ONLY here.
    id: 'range_wall',
    commsSource: 'BANGALORE', commsText: 'That one\'s too far for the net. See OUT OF RANGE. Press A to autopilot in.',
    commsAck: 'On station. Net it now.',
    text: 'Autopilot in (A)',
    glyph: 'A',
    keys: ['KeyA'],
    triggerEvent: 'AUTOPILOT_ENGAGE',
    skillId: 'nav_autopilot',
    credit: 10,
    // Hold until a target is actually out of range (the player has cleared the
    // two close pieces and the reticle has hopped to the far one).
    requiresOutOfRange: true,
    outOfRangeNudge: 'Clear the close pieces first. The reticle will lock the far one and show OUT OF RANGE.',
    escalationText: 'A engages autopilot to the locked target. It closes the gap; the bracket turns cyan when the net can reach.',
  },
  {
    // Close-and-catch payoff: AP arrived, range met (cyan + lock sound), net it.
    id: 'close_and_catch',
    commsSource: 'BANGALORE', commsText: 'In range. Launch the net.',
    commsAck: null,
    glyph: '✓', keys: [], skillId: null,
    triggerEvent: 'DEBRIS_CAPTURED',
    counterTarget: 1,
    credit: 0,
    autoAdvanceAfter: 8000,
    // No-net safety: graduate past if the player is out of nets here.
    netEmptySkip: true,
    netEmptyComms: 'Out of nets. We\'ll resupply. Moving on, Cowboy.',
  },
  {
    // Free clearing — solo, unguided. Graduation proof: capturing the rest of
    // the cluster is inherently unguided. Optional skip so a no-nets player
    // isn't stranded.
    id: 'free_clear',
    commsSource: 'HOUSTON', commsText: 'You\'ve got the loop: scan, lock, close, net. Clear the rest of the cluster.',
    commsAck: null,
    glyph: '★', keys: [], skillId: null,
    autoAdvanceAfter: 4000,
  },
  {
    id: 'final',
    commsSource: 'HOUSTON', commsText: 'That\'s real cowboy work. Clear the field, then check the map for the next cluster. Good hunting.',
    commsAck: null,
    glyph: '★', keys: [], skillId: null,
    autoAdvanceAfter: 4000,
    onEnter: 'mastered=true',
  },
];

const BEAT_INDEX_BY_ID = new Map(ONBOARDING_BEATS.map((b, i) => [b.id, i]));

// Set of skills used by onboarding (for veteran-skip threshold check).
const RELEVANT_SKILLS = new Set(
  ONBOARDING_BEATS.map(b => b.skillId).filter(Boolean)
);

// Default skip-after for `optional` beats when no `skipAfter` set.
const OPTIONAL_DEFAULT_SKIP_MS = 25000;

// ────────────────────────────────────────────────────────────────────────────
// ONBOARDING DIRECTOR
// ────────────────────────────────────────────────────────────────────────────

export class OnboardingDirector {
  /**
   * @param {object} deps
   * @param {object} deps.eventBus
   * @param {object} [deps.scoringSystem]      — for awardPoints (credit beats)
   * @param {object} [deps.skillsSystem]       — for veteran-skip + tiered-skip
   * @param {object} [deps.teachingSystem]     — for direct overlay injection
   * @param {object} [deps.persistenceManager] — optional (currently unused —
   *                                             we keep our own storage key)
   * @param {Function} [deps.contextProvider]  — returns live game context for
   *   conditional beats: { trackedContacts:number, nearestDebrisM:number|null,
   *   hasTarget:boolean }. Optional; beats degrade gracefully without it.
   */
  constructor(deps = {}) {
    this._eventBus = deps.eventBus;
    this._scoring = deps.scoringSystem || null;
    this._skills = deps.skillsSystem || null;
    this._teaching = deps.teachingSystem || null;
    this._persistence = deps.persistenceManager || null;
    this._context = typeof deps.contextProvider === 'function' ? deps.contextProvider : null;
    /** @type {object|null} GuidanceDirector — scales coaching depth per persona. */
    this._guidance = deps.guidanceDirector || null;

    /** @type {Set<string>} ids of beats already satisfied (across runs). */
    this._completedBeats = new Set();
    /** @type {Set<string>} ids of beats skipped (tiered-skip / optional). */
    this._skippedBeats = new Set();
    /** @type {boolean} true once final `complete` beat has fired. */
    this._mastered = false;

    /** @type {boolean} flag set after MISSION_START fires (we wait for it). */
    this._started = false;

    /** @type {number} index into ONBOARDING_BEATS for the currently-active beat. */
    this._beatIndex = -1;

    /** @type {object|null} state of currently-active beat. */
    this._active = null;

    /** @type {Array<{ event: string, at: number }>} recent trigger event buffer. */
    this._recentInputs = [];

    /** @type {Array<Function>} unsubscribe handles. */
    this._unsubs = [];

    /** @type {boolean} smart-default "first use" comms ack guard. */
    this._smartDefaultMsgShown = false;

    /** @type {boolean} */
    this._disposed = false;

    this._loadPersisted();
    this._setupListeners();
  }

  // ─── PUBLIC API ────────────────────────────────────────────────────────

  /** Whether the entire onboarding has completed (mastered) in any prior run. */
  isMastered() { return this._mastered; }

  /** Currently-active beat id (or null). */
  getActiveBeatId() { return this._active ? this._active.beat.id : null; }

  /** Snapshot of director state for tests / debugging. */
  getState() {
    return {
      mastered: this._mastered,
      completed: Array.from(this._completedBeats),
      skipped: Array.from(this._skippedBeats),
      activeBeatId: this.getActiveBeatId(),
      beatIndex: this._beatIndex,
    };
  }

  /**
   * Smart-default handler for the Space key.  If a beat is currently posted
   * with at least one keyboard key as its trigger AND that key is NOT Space
   * itself, dispatch a synthetic press of the primary key via InputManager
   * helpers and return true.  Otherwise return false so the original Space
   * handler (lasso fire) runs.
   *
   * NOTE (Delegation 4 / QA P0-2): InputManager only consults this helper from
   * the ORBITAL_VIEW Space handler, NOT from the ARM_PILOT Space handler
   * (which is dedicated to manual net deploy).  Players who enter ARM_PILOT
   * mid-onboarding and then press Space while the `inspect` beat is active
   * will deploy a net rather than toggle inspection.  This is acceptable
   * because `inspect` is `optional:true` with a 25 s auto-skip; the player
   * can still press `I` directly without consequence.
   *
   * @param {object} inputManager — must expose fireScan, cycleTarget,
   *   engageAutopilot, fireLasso, deployDaughter, toggleInspection (any subset).
   * @returns {boolean} true if a synthetic action was dispatched.
   */
  pressActiveHint(inputManager) {
    if (!this._active || this._mastered) return false;
    const beat = this._active.beat;
    if (!beat || !Array.isArray(beat.keys) || beat.keys.length === 0) return false;
    const primary = beat.keys[0];
    if (primary === 'Space') return false;

    // Map primary key → InputManager helper.
    const im = inputManager || {};
    let dispatched = false;
    switch (primary) {
      case 'KeyS':
        if (typeof im.fireScan === 'function') { im.fireScan(); dispatched = true; }
        break;
      case 'Tab':
        if (typeof im.cycleTarget === 'function') { im.cycleTarget(); dispatched = true; }
        break;
      case 'KeyT':
        if (typeof im.cycleTarget === 'function') { im.cycleTarget(); dispatched = true; }
        break;
      case 'KeyA':
        if (typeof im.engageAutopilot === 'function') { im.engageAutopilot(); dispatched = true; }
        break;
      case 'KeyN':
        if (typeof im.fireLasso === 'function') { im.fireLasso(); dispatched = true; }
        break;
      case 'KeyV':
        if (typeof im.cycleView === 'function') { im.cycleView(); dispatched = true; }
        break;
      case 'KeyD':
        if (typeof im.deployDaughter === 'function') { im.deployDaughter(); dispatched = true; }
        break;
      case 'KeyI':
        if (typeof im.toggleInspection === 'function') { im.toggleInspection(); dispatched = true; }
        break;
      default:
        // For arrow / comma-period / zoom beats Space doesn't map onto a
        // sensible synthetic input — bail and let Space fall through to lasso.
        return false;
    }
    if (dispatched && !this._smartDefaultMsgShown) {
      this._smartDefaultMsgShown = true;
      this._emitComms({
        source: 'SPACECRAFT', channel: 'CMD', priority: 'info',
        text: 'Smart default. Performing recommended action.',
      });
    }
    return dispatched;
  }

  /** Manually start the pipeline (used by tests; production fires on MISSION_START). */
  start() {
    if (this._started) return;
    this._started = true;
    if (this._checkVeteranSkip()) {
      this._mastered = true;
      this._persist();
      this._emit(Events.ONBOARDING_COMPLETE, {});
      return;
    }
    // Delegation 4 (2026-05-31) — Browser-playtest Bug 4: signal listeners
    // (CommsSystem, HUD panels) that the pipeline is live so they can
    // suppress non-essential noise until ONBOARDING_COMPLETE fires.
    this._emit(Events.ONBOARDING_STARTED, {});
    this._advanceToNextBeat();
  }

  /** Reset all persisted state — used by tests / dev. */
  reset() {
    this._completedBeats.clear();
    this._skippedBeats.clear();
    this._mastered = false;
    this._active = null;
    this._beatIndex = -1;
    this._recentInputs.length = 0;
    this._smartDefaultMsgShown = false;
    this._started = false;
    this._stationKeepArrowsShown = false;
    this._persist();
  }

  /** Tear down — unsubscribe + clear pending timers. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._clearActiveTimers();
    for (const u of this._unsubs) {
      if (typeof u === 'function') u();
    }
    this._unsubs.length = 0;
  }

  // ─── INTERNAL — WIRING ─────────────────────────────────────────────────

  _setupListeners() {
    const eb = this._eventBus;
    if (!eb) return;
    const on = (evt, h) => {
      const u = eb.on(evt, h);
      if (typeof u === 'function') this._unsubs.push(u);
    };

    // Delegation 4 (2026-05-31) — Browser-playtest Bug 1 (true root cause):
    // Every other major system (SkillsSystem, CommsSystem, KesslerSystem,
    // MissionEventSystem, ReputationSystem, EnvironmentSystem, SpaceWeatherSystem,
    // TrawlManager, DebrisField …) self-resets on GAME_RESET.  The Director
    // never subscribed — so its localStorage blob (`spacecowboy_onboarding_v1`)
    // accumulated across QA / "new game" sessions, and the pipeline resumed
    // at whichever beat the previous run had reached (e.g. the player
    // satisfied target on run #3 → next run posts `autopilot` first).
    // Wire it now so "New Game" always restarts the pipeline from `boot`.
    if (Events.GAME_RESET) {
      on(Events.GAME_RESET, () => this.reset());
    }

    // Delegation 4 (2026-05-31) — P0-1: MISSION_START is NOT emitted for the
    // first mission (ScoringSystem._lastMissionNumber starts at 1, so the
    // 1→1 transition is a no-op).  We additionally listen to GAME_STATE_CHANGE
    // and start the pipeline the first time the player enters ORBITAL_VIEW.
    // `start()` is idempotent (guarded by `_started`), so a later legitimate
    // MISSION_START at the 1→2 boundary is harmless.
    on(Events.MISSION_START, () => this.start());
    if (Events.GAME_STATE_CHANGE) {
      on(Events.GAME_STATE_CHANGE, ({ to } = {}) => {
        if (to === 'ORBITAL_VIEW') this.start();
      });
    }

    // Recent-input buffer + unrelated-input counter for repeated-fail escalation.
    // We accumulate from every TUTORIAL_*_INPUT and a small set of action events
    // so the "input made no progress" detector has a reasonable signal.
    const inputEvents = [
      Events.TUTORIAL_ARROW_INPUT,
      Events.TUTORIAL_THROTTLE_INPUT,
      Events.TUTORIAL_WASD_INPUT,
      Events.TUTORIAL_SCAN_INPUT,
      Events.TUTORIAL_TAB_INPUT,
      Events.TUTORIAL_DEPLOY_INPUT,
      Events.STRUT_DEPLOY_INPUT,
      Events.CAMERA_ZOOM_INPUT,
      Events.SCAN_INITIATED,
      Events.TARGET_SELECTED,
      Events.AUTOPILOT_ENGAGE,
      Events.LASSO_FIRED,
      Events.ARM_DEPLOYED,
      Events.INSPECTION_TOGGLE,
      Events.MOTHER_INSPECTION_ENGAGED,
    ];
    for (const e of inputEvents) {
      if (!e) continue;
      on(e, () => this._onAnyInput(e));
    }

    // Per-beat trigger handlers wired against the corresponding Events constant.
    for (const beat of ONBOARDING_BEATS) {
      if (!beat.triggerEvent) continue;
      const evt = Events[beat.triggerEvent];
      if (!evt) continue;
      on(evt, () => this._onTrigger(beat));
    }

    // Prompt re-check of a HELD beat's gate the instant relevant state changes
    // (a scan reveals a contact, or the player closes on a target) so the held
    // hint converts to the real beat without waiting for the next poll tick.
    const gateNudgeEvents = [
      Events.TARGET_DISCOVERED, Events.SCAN_COMPLETE, Events.AUTOPILOT_ENGAGE,
      Events.TARGET_OUT_OF_RANGE, Events.DEBRIS_CAPTURED,
    ];
    for (const e of gateNudgeEvents) {
      if (!e) continue;
      on(e, () => this._recheckHeldGate());
    }

    // #5 (2026-06-04): surface spaced-repetition skill reminders as gentle
    // bottom-ticker hints once onboarding is finished. SkillsSystem already
    // emits SKILL_REMINDED on its SM-2 schedule for skills the player has let
    // go stale; we render it with the skill's key glyph so it's actionable.
    if (Events.SKILL_REMINDED) {
      on(Events.SKILL_REMINDED, (d) => this._onSkillReminded(d));
    }

    // §4.4 no-net edge case: if the player is out of nets during a beat that
    // opted into the consolation skip (solo_practice), graduate them anyway.
    if (Events.NET_EMPTY_CLICK) {
      on(Events.NET_EMPTY_CLICK, () => this._onConsolationSkip());
    }

    // Contextual JIT teaching (.kilo plan §D.6): the arrows/RCS lesson is NOT
    // front-loaded — an autopilot-driving player never needs it to travel. It
    // surfaces exactly when it first matters: a daughter has parked in
    // STATION_KEEP and the pilot may want to rotate the mother to line her up.
    // Gated by canFireHint so it only fires when undiscovered/struggling and
    // falls silent after the unheeded cap; veterans get a ticker, never a modal.
    if (Events.STATION_KEEP_ENTERED) {
      on(Events.STATION_KEEP_ENTERED, () => this._onStationKeepArrowsHint());
    }
  }

  /**
   * Just-in-time arrows reminder when a daughter enters STATION_KEEP. One-shot,
   * canFireHint-gated, never while an onboarding beat is mid-flight.
   * @private
   */
  _onStationKeepArrowsHint() {
    if (this._active) return;                 // don't compete with a live beat
    if (this._stationKeepArrowsShown) return; // one-shot per session
    const skillId = 'nav_arrows';
    if (this._skills && typeof this._skills.canFireHint === 'function') {
      if (!this._skills.canFireHint(skillId)) return;
    }
    this._stationKeepArrowsShown = true;
    if (this._skills && typeof this._skills.noteNudgeShown === 'function') {
      this._skills.noteNudgeShown(skillId);
    }
    const presentation = (this._skills && typeof this._skills.getHintPresentation === 'function')
      ? this._skills.getHintPresentation() : 'modal';
    this._emit(Events.HINT_POSTED, {
      id: 'jit_arrows_sk',
      text: 'Daughter on station. Arrow keys rotate the mother to line her up.',
      glyph: '←→↑↓',
      keys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'],
      skillId,
      duration: Constants.ONBOARDING?.DEFAULT_HINT_MS || 12000,
      priority: 'normal',
      presentation,
    });
  }

  /**
   * Render a stale-skill reminder as a low-priority ticker hint (post-mastery
   * only, so it never competes with an active onboarding beat).
   * @param {{skillId:string}} d
   * @private
   */
  _onSkillReminded(d) {
    if (!d || !d.skillId) return;
    // Only after the guided pipeline is done, and never while a beat is live.
    if (!this._mastered || this._active) return;
    const def = this._lookupSkillDef(d.skillId);
    if (!def || def.noReminder) return;
    const keyHint = def.key ? ` [${def.key}]` : '';
    this._emit(Events.HINT_POSTED, {
      id: 'remind_' + d.skillId,
      text: `Reminder: ${def.label}${keyHint}`,
      glyph: def.key || '?',
      keys: [],
      skillId: d.skillId,
      duration: Constants.ONBOARDING?.DEFAULT_HINT_MS || 12000,
      priority: 'normal',
    });
  }

  /**
   * If the active beat is currently held on a gate, re-evaluate it now.
   * @private
   */
  _recheckHeldGate() {
    if (!this._active || !this._active.held) return;
    const beat = this._active.beat;
    if (this._beatGateMet(beat)) {
      this._clearActiveTimers();
      this._emit(Events.HINT_SATISFIED, { id: beat.id + '_wait' });
      this._postBeat(beat);
    }
  }

  // ─── INTERNAL — BEAT LIFECYCLE ────────────────────────────────────────

  /**
   * No-net consolation skip (§4.4): if the active beat opted in via
   * `netEmptySkip`, graduate the player past it with a consolation comms line
   * rather than stranding them when they're out of nets.
   * @private
   */
  _onConsolationSkip() {
    if (!this._active) return;
    const beat = this._active.beat;
    if (!beat || !beat.netEmptySkip) return;
    if (this._completedBeats.has(beat.id) || this._skippedBeats.has(beat.id)) return;
    this._clearActiveTimers();
    this._emit(Events.HINT_SATISFIED, { id: beat.id });
    if (beat.netEmptyComms) {
      this._emitComms({
        source: beat.commsSource || 'HOUSTON',
        channel: 'HOUSTON',
        text: beat.netEmptyComms,
        priority: 'info',
      });
    }
    this._skippedBeats.add(beat.id);
    this._persist();
    this._active = null;
    this._advanceToNextBeat();
  }

  /**
   * Re-post a multi-target counter beat's hint chip with the running tally.
   * @param {object} beat @param {number} count @private
   */
  _repostCounterHint(beat, count) {
    this._emit(Events.HINT_POSTED, {
      id: beat.id,
      text: `${beat.text || beat.commsText || ''} (${count}/${beat.counterTarget})`,
      glyph: beat.glyph || '🎯',
      keys: beat.keys || [],
      skillId: beat.skillId || undefined,
      duration: beat.hintDuration || (Constants.ONBOARDING?.DEFAULT_HINT_MS || 12000),
      priority: 'normal',
    });
  }

  _advanceToNextBeat() {
    if (this._mastered) return;
    // Pick next un-completed, un-skipped beat.
    let idx = this._beatIndex + 1;
    // If we're advancing past a beat with a parallel partner that's already
    // satisfied, the partner beat's id is in _completedBeats — skip it too.
    while (idx < ONBOARDING_BEATS.length) {
      const beat = ONBOARDING_BEATS[idx];
      if (this._completedBeats.has(beat.id) || this._skippedBeats.has(beat.id)) {
        idx++;
        continue;
      }
      // Tiered-skip if the beat's skill is already practiced+
      if (this._isAlreadyKnown(beat)) {
        this._skippedBeats.add(beat.id);
        this._persist();
        idx++;
        continue;
      }
      break;
    }
    if (idx >= ONBOARDING_BEATS.length) {
      // Reached the end — mark mastered.
      this._mastered = true;
      this._persist();
      this._emit(Events.ONBOARDING_COMPLETE, {});
      return;
    }
    this._beatIndex = idx;
    this._postBeat(ONBOARDING_BEATS[idx]);
  }

  _postBeat(beat) {
    this._clearActiveTimers();
    this._active = {
      beat,
      postedAt: Date.now(),
      unrelatedInputs: 0,
      escalated: false,
      idleTimer: null,
      autoAdvanceTimer: null,
      skipTimer: null,
      gateTimer: null,
      held: false,
    };

    // (0) Conditional gating (2026-06-04): some beats only make sense once the
    // game state supports them — `requiresContacts` (Tab needs ≥1 tracked
    // contact) and `requiresProximityM` (capture hints need a target in range).
    // If the gate isn't met we HOLD the beat: show a contextual nudge hint and
    // re-check periodically instead of posting an instruction the player can't
    // act on yet.
    if (!this._beatGateMet(beat)) {
      this._holdBeat(beat);
      this._emit('onboarding:beatEnter', { beatId: beat.id });
      return;
    }

    // Guidance depth: MINIMAL players (veterans / behavior-detected experts)
    // get NO comms or chips — the spine still advances on their actions, but
    // the action is the reward, not a lecture. The capture beats remain wired.
    const minimal = this._isMinimal();

    // Tell the GuidanceDirector the spine is actively coaching this interactive
    // beat's action, so doing it isn't mis-read as "ahead-of-coaching" competence.
    if (this._guidance && typeof this._guidance.setCoachingActive === 'function') {
      this._guidance.setCoachingActive(!!beat.triggerEvent && !minimal);
    }

    // (1) Comms line.
    if (beat.commsText && !minimal) {
      this._emitComms({
        source: beat.commsSource || 'HOUSTON',
        channel: 'HOUSTON',
        text: this._renderCommsText(beat.commsText),
        priority: 'info',
        // Tag actionable instructions with their beat id so the comms panel can
        // drop the attention highlight the instant the player follows it
        // (HINT_SATISFIED), rather than leaving it highlighted until an ack.
        _onboardingBeatId: beat.triggerEvent ? beat.id : undefined,
      });
    }

    // (2) Hint ticker.
    if (Array.isArray(beat.keys) && beat.keys.length > 0 && !minimal) {
      this._emit(Events.HINT_POSTED, {
        id: beat.id,
        text: beat.text || beat.commsText || '',
        glyph: beat.glyph,
        keys: beat.keys,
        skillId: beat.skillId || undefined,
        duration: beat.hintDuration || (Constants.ONBOARDING?.DEFAULT_HINT_MS || 12000),
        priority: 'normal',
      });
    }

    // (3) Soft chime for credit-bearing beats only.
    const isCreditBeat = (Array.isArray(beat.keys) && beat.keys.length > 0);
    if (isCreditBeat) {
      this._emit(Events.AUDIO_CUE, { id: 'hint_post', cue: 'hint_post', volume: 0.4 });
    }

    // (4) Brighten the related HUD panel via SKILL_DISCOVERED.
    if (beat.skillId && this._skills && typeof this._skills.getState === 'function') {
      const state = this._skills.getState(beat.skillId);
      if (state === 'undiscovered') {
        // Find skill def for hudGroup payload.
        const def = this._lookupSkillDef(beat.skillId);
        this._emit(Events.SKILL_DISCOVERED, {
          skillId: beat.skillId,
          tier: def?.tier,
          label: def?.label,
          hudGroup: def?.hudGroup,
        });
      }
    }

    // (5) Auto-advance narrative beats (no triggerEvent).
    if (!beat.triggerEvent && Number.isFinite(beat.autoAdvanceAfter)) {
      this._active.autoAdvanceTimer = this._setTimeout(() => {
        if (beat.onEnter === 'mastered=true') {
          this._mastered = true;
        }
        this._completedBeats.add(beat.id);
        this._persist();
        this._active = null;
        this._advanceToNextBeat();
      }, beat.autoAdvanceAfter);
    } else {
      // (6) Idle-escalation timer.
      const idleMs = Constants.ONBOARDING?.IDLE_ESCALATION_MS || 15000;
      if (beat.escalationText) {
        this._active.idleTimer = this._setTimeout(() => this._escalate(beat), idleMs);
      }
      // (6b) Confirmation beats (triggerEvent + autoAdvanceAfter): advance on the
      // event, but fall back to a timer so a missed/failed event can't hang the
      // pipeline (e.g. `captured` waits for ARM_CAPTURED but auto-completes if
      // the catch never lands).
      if (beat.triggerEvent && Number.isFinite(beat.autoAdvanceAfter)) {
        this._active.autoAdvanceTimer = this._setTimeout(() => {
          if (this._active && this._active.beat.id === beat.id) {
            this._completedBeats.add(beat.id);
            this._persist();
            this._active = null;
            this._advanceToNextBeat();
          }
        }, beat.autoAdvanceAfter);
      }
      // (7) Optional auto-skip for `inspect`/`view`/`look` beats.
      if (beat.optional) {
        const skipMs = beat.skipAfter || OPTIONAL_DEFAULT_SKIP_MS;
        this._active.skipTimer = this._setTimeout(() => {
          if (this._active && this._active.beat.id === beat.id) {
            this._skippedBeats.add(beat.id);
            this._persist();
            this._active = null;
            this._advanceToNextBeat();
          }
        }, skipMs);
      }
    }

    // Strut highlight — managed by main.js subscriber to `onboarding:beatEnter`.
    // (We don't bind to PlayerSatellite directly — keeps the Director DOM-free.)
    this._emit('onboarding:beatEnter', { beatId: beat.id });
  }

  // ─── INTERNAL — CONDITIONAL GATING (2026-06-04) ───────────────────────

  /**
   * Whether a beat's pre-conditions are met given live game context.
   * Degrades to TRUE when no contextProvider is wired (tests / headless).
   * @param {object} beat
   * @returns {boolean}
   * @private
   */
  _beatGateMet(beat) {
    if (!beat) return true;
    if (!beat.requiresContacts && !Number.isFinite(beat.requiresProximityM) && !beat.requiresOutOfRange) return true;
    if (!this._context) return true; // no provider → don't block
    let ctx = null;
    try { ctx = this._context() || {}; } catch (_e) { return true; }
    if (beat.requiresContacts) {
      if (!(Number(ctx.trackedContacts) > 0)) return false;
    }
    if (Number.isFinite(beat.requiresProximityM)) {
      const d = ctx.nearestDebrisM;
      if (!(Number.isFinite(d) && d <= beat.requiresProximityM)) return false;
    }
    if (beat.requiresOutOfRange) {
      // Range-wall beat: hold until a target is actually out of net range
      // (the player has cleared the close pieces and the reticle has hopped to
      // the far one). Driven by TARGET_OUT_OF_RANGE via the context flag.
      if (!ctx.targetOutOfRange) return false;
    }
    return true;
  }

  /**
   * Hold a gated beat: show a contextual nudge hint and re-check the gate on a
   * short poll. When the gate finally passes, post the real beat.
   * @param {object} beat
   * @private
   */
  _holdBeat(beat) {
    if (!this._active) return;
    this._active.held = true;

    // Post a soft nudge hint explaining what to do to unblock (once).
    const nudge = beat.requiresContacts ? beat.noContactNudge
                : Number.isFinite(beat.requiresProximityM) ? beat.farNudge
                : beat.requiresOutOfRange ? beat.outOfRangeNudge
                : null;
    if (nudge) {
      this._emit(Events.HINT_POSTED, {
        id: beat.id + '_wait',
        text: nudge,
        glyph: beat.glyph || '…',
        keys: [],
        duration: 0, // persistent until satisfied/cleared
        priority: 'normal',
      });
    }

    const poll = Constants.ONBOARDING?.GATE_POLL_MS || 1200;
    const tick = () => {
      if (!this._active || this._active.beat.id !== beat.id || !this._active.held) return;
      if (this._beatGateMet(beat)) {
        // Gate satisfied — clear the nudge and post the real beat.
        this._emit(Events.HINT_SATISFIED, { id: beat.id + '_wait' });
        this._postBeat(beat);
        return;
      }
      this._active.gateTimer = this._setTimeout(tick, poll);
    };
    this._active.gateTimer = this._setTimeout(tick, poll);
  }

  _onTrigger(beat) {
    if (!this._active) {
      // No beat on-screen (narrative gap, or player is ahead of the script).
      // Still credit a genuine action so a later beat for it is auto-skipped.
      this._preSatisfy(beat);
      return;
    }
    if (this._active.beat.id !== beat.id) {
      // It's possible this beat is the *parallel partner* of the active beat
      // — satisfying it should also satisfy the partner.
      if (beat.parallel && this._active.beat.id === beat.parallel) {
        // Treat as satisfying the active beat instead, then mark partner too.
        this._satisfy(this._active.beat, /* alsoPartner= */ beat.id);
        return;
      }
      // JUMP-AHEAD (2026-06-04): the player performed the action for a DIFFERENT
      // beat than the one currently on-screen — e.g. pressing A (autopilot) while
      // the `scan` hint is still up. Onboarding is a progression of hints keyed
      // to actions, not a rigid lockstep: credit that action now and pre-complete
      // its beat so the sequence skips it when it would otherwise come up. The
      // active hint stays put (the player still hasn't done THAT step).
      this._preSatisfy(beat);
      return;
    }
    // Counter beat (§4.4): require `counterTarget` triggers while active before
    // satisfying — re-post the chip with a running tally until the target lands.
    if (Number.isFinite(beat.counterTarget) && beat.counterTarget > 1) {
      this._active.count = (this._active.count || 0) + 1;
      if (this._active.count < beat.counterTarget) {
        this._repostCounterHint(beat, this._active.count);
        return;
      }
    }
    this._satisfy(beat, /* alsoPartner= */ null);
  }

  /**
   * Credit + complete a beat the player triggered out of order (ahead of the
   * script), without disturbing the currently-active beat. Idempotent.
   * @param {object} beat
   * @private
   */
  _preSatisfy(beat) {
    if (!beat || !beat.id) return;
    // Only while a run is genuinely in progress — never before start() or after
    // it finishes. (Before start, the existing recent-input skip window handles
    // "player already knows this"; crediting here would be too aggressive.)
    if (!this._started || this._mastered) return;
    // Only meaningful for interactive beats; narrative beats auto-advance.
    if (!beat.triggerEvent) return;
    // Counter beats (e.g. solo_practice) are live graduation steps — never
    // credit them ahead of time from an earlier trigger of the same event
    // (the guided catch must not satisfy the "do one solo" beat). §4.4.
    if (beat.counterTarget) return;
    // Already handled?
    if (this._completedBeats.has(beat.id) || this._skippedBeats.has(beat.id)) return;
    // Don't pre-satisfy a beat that is BEFORE the active one (it was presumably
    // already skipped/known); only credit current-or-future steps.
    if (this._active) {
      const activeIdx = BEAT_INDEX_BY_ID.get(this._active.beat.id);
      const thisIdx = BEAT_INDEX_BY_ID.get(beat.id);
      if (Number.isFinite(activeIdx) && Number.isFinite(thisIdx) && thisIdx <= activeIdx) return;
    }

    // Clear any (already-posted) ticker entry for this beat immediately.
    this._emit(Events.HINT_SATISFIED, { id: beat.id });

    // Award credit for the action just performed.
    const credit = Number.isFinite(beat.credit) ? beat.credit : (Constants.ONBOARDING?.DEFAULT_CREDIT || 10);
    if (credit > 0) {
      if (this._scoring && typeof this._scoring.awardPoints === 'function') {
        this._scoring.awardPoints({ points: credit, reason: 'Onboarding: ' + beat.id });
      } else {
        this._emit(Events.SCORING_AWARD, { points: credit, reason: 'Onboarding: ' + beat.id });
      }
    }

    // Mark completed (+ parallel partner) and persist so _advanceToNextBeat skips it.
    this._completedBeats.add(beat.id);
    if (beat.parallel) this._completedBeats.add(beat.parallel);
    this._persist();
  }

  _satisfy(beat, alsoPartner) {
    if (!this._active || this._active.beat.id !== beat.id) return;
    this._clearActiveTimers();

    // Coaching for this beat is done — clear the flag so subsequent player
    // actions read as competence again.
    if (this._guidance && typeof this._guidance.setCoachingActive === 'function') {
      this._guidance.setCoachingActive(false);
    }

    // (1) HINT_SATISFIED → fades the ticker entry (and any held nudge variant).
    this._emit(Events.HINT_SATISFIED, { id: beat.id });
    if (this._active.held) this._emit(Events.HINT_SATISFIED, { id: beat.id + '_wait' });

    // (2) Award credit + Houston follow-up.
    const credit = Number.isFinite(beat.credit) ? beat.credit : (Constants.ONBOARDING?.DEFAULT_CREDIT || 10);
    if (credit > 0) {
      if (this._scoring && typeof this._scoring.awardPoints === 'function') {
        this._scoring.awardPoints({ points: credit, reason: 'Onboarding: ' + beat.id });
      } else {
        this._emit(Events.SCORING_AWARD, { points: credit, reason: 'Onboarding: ' + beat.id });
      }
    }
    if (beat.commsAck && !this._isMinimal()) {
      this._emitComms({
        source: beat.commsSource || 'HOUSTON',
        channel: 'HOUSTON',
        text: beat.commsAck,
        priority: 'info',
      });
    }

    // (3) Mark completed (+ partner if parallel pair).
    this._completedBeats.add(beat.id);
    if (alsoPartner) this._completedBeats.add(alsoPartner);
    if (beat.parallel) this._completedBeats.add(beat.parallel);
    this._persist();
    this._active = null;

    // (4) Advance after `beat.advanceDelay`.
    const delay = Number.isFinite(beat.advanceDelay) ? beat.advanceDelay : (Constants.ONBOARDING?.ADVANCE_DELAY_MS || 1500);
    this._setTimeout(() => this._advanceToNextBeat(), delay);
  }

  /**
   * @private Whether guidance is at the MINIMAL depth (veteran / behavior-
   * detected expert) — single source for the comms/chip/escalation suppression
   * checks so they can never drift apart.
   * @returns {boolean}
   */
  _isMinimal() {
    return !!(this._guidance && typeof this._guidance.isMinimal === 'function' && this._guidance.isMinimal());
  }

  _escalate(beat) {
    if (!this._active || this._active.beat.id !== beat.id) return;
    if (this._active.escalated) return;
    this._active.escalated = true;
    // A stall is a struggle signal — let the GuidanceDirector re-escalate one
    // tier so a player who quietly de-escalated then got stuck gets help back.
    if (this._guidance && typeof this._guidance.noteStall === 'function') {
      this._guidance.noteStall();
    }
    // MINIMAL players opted out of coaching — don't force a modal on them.
    if (this._isMinimal()) {
      return;
    }
    const body = beat.escalationText || beat.commsText || '';
    if (!body) return;
    this._emit(Events.TEACHING_MOMENT_FORCE, {
      id: 'onboarding_' + beat.id,
      title: (beat.text || beat.commsText || '').slice(0, 40),
      body,
      duration: 9000,
      icon: '💡',
    });
  }

  _onAnyInput(eventName) {
    // Delegation 4 (2026-05-31) — Browser-playtest Bug 1 fix:
    // Only buffer inputs that occur while an INTERACTIVE beat is active.
    // Previously the push happened unconditionally, so arrow-key presses
    // during the boot/handshake narrative auto-advance (or before `start()`
    // even ran) polluted `_recentInputs`.  When the pipeline later reached
    // the `arrows` beat, `_isAlreadyKnown(arrows)` saw the buffered
    // TUTORIAL_ARROW_INPUT inside the 3 s RECENT_INPUT_WINDOW_MS and
    // tiered-skipped the beat — the sequence jumped to `struts` instead
    // of teaching the first key.  Gating on `beat.triggerEvent` means only
    // inputs received while *another* interactive beat is up count toward
    // the recent-input-based skip detector (its intended use case:
    // player practising the next-beat's action while still finishing this
    // beat).
    if (!this._active || !this._active.beat || !this._active.beat.triggerEvent) {
      return;
    }
    const now = Date.now();
    this._recentInputs.push({ event: eventName, at: now });
    if (this._recentInputs.length > 16) this._recentInputs.shift();

    // Unrelated-input counter against the active beat.
    const beat = this._active.beat;
    if (Events[beat.triggerEvent] === eventName) return; // related — handled in _onTrigger
    this._active.unrelatedInputs++;
    const threshold = Constants.ONBOARDING?.UNRELATED_INPUT_THRESHOLD || 6;
    if (this._active.unrelatedInputs > threshold) {
      this._escalate(beat);
    }
  }

  // ─── INTERNAL — SKIP DETECTION ────────────────────────────────────────

  _isAlreadyKnown(beat) {
    if (!beat) return false;
    // Counter beats are graduation steps — never tiered-skip them. A recent
    // same-event trigger (the guided catch's DEBRIS_CAPTURED) must not satisfy
    // "do one more solo". §4.4.
    if (beat.counterTarget) return false;
    // (a) Skill already practiced+
    if (beat.skillId && this._skills && typeof this._skills.getState === 'function') {
      const s = this._skills.getState(beat.skillId);
      if (s === 'practiced' || s === 'mastered') return true;
    }
    // (b) Trigger event fired in the last RECENT_INPUT_WINDOW_MS.
    if (beat.triggerEvent && Events[beat.triggerEvent]) {
      const evt = Events[beat.triggerEvent];
      const win = Constants.ONBOARDING?.RECENT_INPUT_WINDOW_MS || 3000;
      const cutoff = Date.now() - win;
      for (const e of this._recentInputs) {
        if (e.event === evt && e.at >= cutoff) return true;
      }
    }
    return false;
  }

  _checkVeteranSkip() {
    if (!this._mastered) return false;
    if (!this._skills || typeof this._skills.getState !== 'function') {
      return true; // mastered + no skills system to verify — trust the flag.
    }
    let known = 0;
    let total = 0;
    for (const id of RELEVANT_SKILLS) {
      total++;
      const s = this._skills.getState(id);
      if (s === 'practiced' || s === 'mastered') known++;
    }
    if (total === 0) return true;
    const frac = known / total;
    return frac >= (Constants.ONBOARDING?.VETERAN_SKILL_THRESHOLD || 0.5);
  }

  // ─── INTERNAL — PERSISTENCE ───────────────────────────────────────────

  _loadPersisted() {
    const key = Constants.ONBOARDING?.STORAGE_KEY || 'spacecowboy_onboarding_v1';
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data) return;
      if (Array.isArray(data.completedBeats)) {
        for (const id of data.completedBeats) this._completedBeats.add(id);
      }
      if (Array.isArray(data.skippedBeats)) {
        for (const id of data.skippedBeats) this._skippedBeats.add(id);
      }
      this._mastered = !!data.mastered;
    } catch (_e) { /* graceful */ }
  }

  _persist() {
    const key = Constants.ONBOARDING?.STORAGE_KEY || 'spacecowboy_onboarding_v1';
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, JSON.stringify({
        completedBeats: Array.from(this._completedBeats),
        skippedBeats: Array.from(this._skippedBeats),
        mastered: this._mastered,
      }));
    } catch (_e) { /* graceful */ }
  }

  // ─── INTERNAL — HELPERS ───────────────────────────────────────────────

  _lookupSkillDef(skillId) {
    const catalog = Constants?.SKILLS?.CATALOG;
    if (!Array.isArray(catalog)) return null;
    return catalog.find(s => s.id === skillId) || null;
  }

  /**
   * Interpolate live-context tokens in a comms line. Currently supports
   * `{distM}` → the rounded range (metres) to the nearest tracked debris, so a
   * targeting cue reads the real distance the player sees rather than a stale
   * hardcoded number. When no live distance is available (no contextProvider,
   * or nothing in range yet) the distance clause is dropped so the line still
   * reads cleanly (e.g. "Debris in front. Launch net with N.").
   * @param {string} text
   * @returns {string}
   * @private
   */
  _renderCommsText(text) {
    if (typeof text !== 'string' || text.indexOf('{distM}') === -1) return text;
    let distM = null;
    if (this._context) {
      try {
        const ctx = this._context() || {};
        if (Number.isFinite(ctx.nearestDebrisM) && ctx.nearestDebrisM > 0) {
          distM = Math.round(ctx.nearestDebrisM);
        }
      } catch (_e) { /* context is best-effort */ }
    }
    if (distM != null) return text.replace('{distM} meters', `${distM} meters`);
    // No live range — strip the "{distM} meters " clause (note trailing space).
    return text.replace('{distM} meters ', '').replace('{distM} meters', '');
  }

  _emit(eventName, payload) {
    if (!this._eventBus || typeof this._eventBus.emit !== 'function') return;
    if (!eventName) return;
    this._eventBus.emit(eventName, payload);
  }

  _emitComms(msg) {
    if (!this._eventBus || typeof this._eventBus.emit !== 'function') return;
    // Delegation 4 — Browser-playtest Bug 4 (strengthened): tag all
    // Director-originated comms so CommsSystem can whitelist them while
    // blocking every other source during onboarding.
    this._eventBus.emit(Events.COMMS_MESSAGE, { ...msg, _onboarding: true });
  }

  _setTimeout(fn, ms) {
    if (typeof setTimeout !== 'function') {
      // Test harness lacking setTimeout — invoke directly (synchronous fallback).
      try { fn(); } catch (_e) {}
      return null;
    }
    return setTimeout(fn, ms);
  }

  _clearActiveTimers() {
    if (!this._active) return;
    const a = this._active;
    if (typeof clearTimeout === 'function') {
      if (a.idleTimer != null) clearTimeout(a.idleTimer);
      if (a.autoAdvanceTimer != null) clearTimeout(a.autoAdvanceTimer);
      if (a.skipTimer != null) clearTimeout(a.skipTimer);
      if (a.gateTimer != null) clearTimeout(a.gateTimer);
    }
    a.idleTimer = null;
    a.autoAdvanceTimer = null;
    a.skipTimer = null;
    a.gateTimer = null;
  }
}

// CJS guard — exposes the data for Node-safe tests.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OnboardingDirector, ONBOARDING_BEATS };
}

export default OnboardingDirector;
