/**
 * OnboardingDirector.js — orchestrates the 13-beat first-experience pipeline.
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
  {
    id: 'boot',
    commsSource: 'HOUSTON', commsText: 'Systems powering up — telemetry coming online…',
    commsAck: null,
    glyph: '✓', keys: [], skillId: null,
    autoAdvanceAfter: 3000,
  },
  {
    id: 'handshake',
    commsSource: 'HOUSTON', commsText: 'Hello Cowboy, comms are up and we have you on telemetry.',
    commsAck: null,
    glyph: '✓', keys: [], skillId: null,
    autoAdvanceAfter: 2500,
  },
  {
    id: 'arrows',
    commsSource: 'HOUSTON', commsText: 'Use arrow keys to test attitude control.',
    commsAck: 'RCS nominal. Solar panels tracking sun.',
    text: 'Test attitude control',
    glyph: '←→↑↓',
    keys: ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'],
    triggerEvent: 'TUTORIAL_ARROW_INPUT',
    // Closest existing skill (Constants.SKILLS.CATALOG): nav_arrows.
    skillId: 'nav_arrows',
    credit: 10,
    escalationText: 'Arrow keys rotate your spacecraft. Hold and release to point. RCS thrusters answer instantly.',
  },
  {
    id: 'struts',
    commsSource: 'HOUSTON', commsText: 'Deploy daughter struts to test arm rigging — comma and period keys.',
    commsAck: 'Strut range 180° nominal.',
    text: 'Stow / Deploy struts',
    glyph: ', .',
    keys: ['Comma','Period'],
    triggerEvent: 'STRUT_DEPLOY_INPUT',
    // Delegation 4 (2026-05-31): wired to `arm_struts` Tier-1 skill (Quick-Win 2a).
    skillId: 'arm_struts',
    credit: 10,
    escalationText: 'Strut arms cradle each daughter. , stows them, . deploys them outboard for launch.',
  },
  {
    id: 'view',
    commsSource: 'HOUSTON', commsText: 'Press V to switch camera — Command flies the ship, Overview pulls back to look around. Press V again to return to Command.',
    commsAck: 'Good. V toggles between your flying view and Overview — you can never get stuck.',
    text: 'Switch camera (V)',
    glyph: 'V',
    keys: ['KeyV'],
    triggerEvent: 'CAMERA_VIEW_CHANGE',
    // 2026-06-03 consolidation (rev. 2): V now toggles just two named views —
    // Command (fly) ↔ Overview (look around / zoom in). Close inspection is no
    // longer a third cycle slot; it engages automatically when the player zooms
    // in far enough while in Overview (taught by the `zoom` beat below). Bare I
    // is retained as an undocumented power-user shortcut for the discrete
    // inspection view + debris/arm contextual wireframes.
    skillId: 'nav_camera',
    credit: 10,
    optional: true,                       // skippable after 25s
    skipAfter: 25000,
    escalationText: 'V toggles Command ↔ Overview. Command is your flying view; Overview pulls back so you can look around and zoom in. Tap V again to fly.',
  },
  {
    id: 'look',
    commsSource: 'HOUSTON', commsText: 'In Overview, click and drag to look around your spacecraft.',
    commsAck: 'Nice — you can inspect from any angle now.',
    text: 'Click + drag to look around',
    glyph: '🖱️ drag',
    keys: [],
    triggerEvent: 'CAMERA_ORBIT_DRAG',
    // New beat (2026-06-03): teaches the existing Overview drag-look, which had
    // no prompt. Fires on the first CAMERA_ORBIT_DRAG. Optional so a player who
    // already discovered it isn't blocked. Maps to the nav_rotate skill.
    skillId: 'nav_rotate',
    credit: 10,
    optional: true,
    skipAfter: 20000,
    escalationText: 'Hold the left mouse button and drag in Overview to orbit the camera around your ship.',
  },
  {
    id: 'zoom',
    commsSource: 'HOUSTON', commsText: 'Try the zoom — mouse wheel, or + / −.',
    commsAck: 'Good. Now push in close on the mothership to inspect her.',
    text: 'Zoom the camera',
    glyph: '🖱️ + −',
    keys: ['Equal','Minus','NumpadAdd','NumpadSubtract','MouseWheel'],
    triggerEvent: 'CAMERA_ZOOM_INPUT',
    // 2026-06-04: split from the old combined zoom+inspect beat. This beat only
    // teaches that the wheel zooms; the follow-up `inspect` beat verifies the
    // player actually pushed in far enough for the hull callouts to engage.
    skillId: 'nav_zoom',
    credit: 10,
    escalationText: 'Mouse wheel zooms the camera in and out. Hold Shift while scrolling for fine zoom.',
  },
  {
    id: 'inspect',
    commsSource: 'HOUSTON', commsText: 'Keep zooming in on the mothership — get close and her hull callouts light up automatically. Inspect before you capture so you can read structural hazards.',
    commsAck: 'There they are — those callouts flag fragile panels and engine zones. Visual check good. Ready for first mission.',
    text: 'Zoom in until callouts appear',
    glyph: '🔍',
    keys: ['Equal','NumpadAdd','MouseWheel'],
    // Fires only when the OVERVIEW zoom-inspection sub-state actually ENGAGES
    // for the mother — i.e. the player reached the depth where callouts appear.
    // This guarantees the "callouts appear automatically" promise is fulfilled,
    // not just claimed (the old combined beat completed on the first scroll).
    triggerEvent: 'MOTHER_INSPECTION_ENGAGED',
    skillId: 'inspect_mother',
    credit: 10,
    escalationText: 'In Overview, keep scrolling IN toward the mothership. Once you\'re within a few metres her hull callouts and a focus vignette fade in. Pull back out to clear them.',
  },
  {
    id: 'scan',
    commsSource: 'BANGALORE', commsText: 'Run a scan of your area — press S. Ground stations pay for fresh survey data, so scanning earns you credits.',
    commsAck: 'Scan returned — survey data sold. Credits inbound.',
    text: 'Scan area (earns credits)',
    glyph: 'S',
    keys: ['KeyS'],
    triggerEvent: 'SCAN_INITIATED',
    skillId: 'scan_quick',
    credit: 10,
    escalationText: 'S fires a Quick Scan; W is a wider, slower scan. Both pay out for fresh survey data on a debris field — but only the FIRST scan of a field is worth credits, so move on once a field is logged.',
  },
  {
    id: 'target',
    commsSource: 'BANGALORE', commsText: 'Choose your target carefully — press Tab to cycle tracked contacts.',
    commsAck: 'Target locked. Fragment in range.',
    text: 'Cycle target',
    glyph: 'Tab',
    keys: ['Tab'],
    triggerEvent: 'TARGET_SELECTED',
    skillId: 'nav_target',
    credit: 10,
    // #1 (2026-06-04): don't post this beat until a scan has actually revealed
    // at least one TRACKED contact — otherwise Tab has nothing to select and the
    // player is told to cycle through an empty list. The director holds this beat
    // (showing a re-scan nudge) until contacts exist.
    requiresContacts: true,
    noContactNudge: 'No tracked contacts yet — reposition and scan again (S), or try a Wide scan (W).',
    escalationText: 'Tab cycles through tracked debris by Time-to-Closest-Approach (TPI). If nothing cycles, scan again to reveal contacts.',
  },
  {
    id: 'autopilot',
    commsSource: 'BANGALORE', commsText: 'Autopilot closer to debris — press A.',
    commsAck: 'On station. Decision time, Cowboy.',
    text: 'Autopilot to target',
    glyph: 'A',
    keys: ['KeyA'],
    triggerEvent: 'AUTOPILOT_ENGAGE',
    skillId: 'nav_autopilot',
    credit: 10,
    escalationText: 'A engages autopilot to your selected target. Press A again or arrows to abort.',
  },
  {
    id: 'decision',
    commsSource: 'HOUSTON', commsText: 'Get in close on your target with autopilot. Two capture tools — the Mother net (lasso) for nearby debris, or launch a Daughter for distant or heavy pieces.',
    commsAck: null,
    glyph: '?', keys: [], skillId: null,
    autoAdvanceAfter: 4000,
  },
  {
    id: 'lasso',
    commsSource: 'HOUSTON', commsText: 'Close enough — fire the Mother net with N (or Space). Quick and easy on nearby debris.',
    commsAck: 'Catch! Nice shot, Cowboy. That\'s how it\'s done.',
    text: 'Fire net (N)',
    glyph: 'N',
    keys: ['KeyN','Space'],
    triggerEvent: 'LASSO_FIRED',
    skillId: 'collect_lasso',
    credit: 10,
    parallel: 'daughter',
    // #3 (2026-06-04): hold the capture hint until the player is actually within
    // net range of a target; otherwise "fire when within 50 m" appears while
    // they're kilometres away. Until in range, show the closer-in nudge.
    requiresProximityM: 60,
    farNudge: 'Get closer first — autopilot to your target with A, then fire when within ~50 m.',
    escalationText: 'N fires the Mother net at the selected target within 50 m. Space works too. Aim at the green-highlighted debris.',
  },
  {
    id: 'daughter',
    commsSource: 'HOUSTON', commsText: 'For distant or heavy debris, launch a Daughter — press D. Pilot it with P, then recall with R.',
    commsAck: 'Daughter away — nice work. Pilot with P to steer it home.',
    text: 'Deploy Daughter (D)',
    glyph: 'D',
    keys: ['KeyD'],
    triggerEvent: 'ARM_DEPLOYED',
    skillId: 'collect_deploy',
    credit: 10,
    parallel: 'lasso',
    escalationText: 'D launches the next docked Daughter toward your target. Press P to pilot it, then R to recall. Daughters reach debris the net cannot.',
  },
  {
    id: 'captured',
    // #4 (2026-06-04): close the loop — confirm the catch landed and tell the
    // player what they earned and what to do next. Fires on the first successful
    // capture (lasso/net/arm). Narrative + a short auto-advance.
    commsSource: 'HOUSTON', commsText: 'Splash — debris secured! That hardware is yours: salvage is refined into fuel and materials, and you\'re paid for the deorbit. Keep clearing the field.',
    commsAck: null,
    glyph: '✓', keys: [], skillId: null,
    triggerEvent: 'ARM_CAPTURED',
    credit: 0,            // narrative confirmation — the capture already scored big
    advanceDelay: 500,
    autoAdvanceAfter: 6000,
  },
  {
    id: 'complete',
    commsSource: 'HOUSTON', commsText: 'You\'re flying solo now, Cowboy. Scan for targets with S, lock on with Tab, autopilot with A, then capture. Clear the field to win. Good luck up there.',
    commsAck: null,
    glyph: '★', keys: [], skillId: null,
    autoAdvanceAfter: 5000,
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
        text: 'Smart default — performing recommended action.',
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

    // (1) Comms line.
    if (beat.commsText) {
      this._emitComms({
        source: beat.commsSource || 'HOUSTON',
        channel: 'HOUSTON',
        text: beat.commsText,
        priority: 'info',
      });
    }

    // (2) Hint ticker.
    if (Array.isArray(beat.keys) && beat.keys.length > 0) {
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
    if (!beat.requiresContacts && !Number.isFinite(beat.requiresProximityM)) return true;
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
    if (beat.commsAck) {
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

  _escalate(beat) {
    if (!this._active || this._active.beat.id !== beat.id) return;
    if (this._active.escalated) return;
    this._active.escalated = true;
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
