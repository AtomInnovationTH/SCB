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
    commsSource: 'HOUSTON', commsText: 'Hello Space Cowboy, we read you 5 by 5.',
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
    id: 'zoom',
    commsSource: 'HOUSTON', commsText: 'Use mouse wheel (or + / −) to zoom in for visual inspection.',
    commsAck: 'Visual check looks good. Ready for first mission.',
    text: 'Mouse wheel / + − to zoom',
    glyph: '🖱️ + −',
    keys: ['Equal','Minus','NumpadAdd','NumpadSubtract','MouseWheel'],
    triggerEvent: 'CAMERA_ZOOM_INPUT',
    skillId: 'nav_zoom',
    credit: 10,
    escalationText: 'Mouse wheel zooms the camera. Hold Shift while scrolling for fine zoom.',
  },
  {
    id: 'view',
    commsSource: 'HOUSTON', commsText: 'Press V to change camera views — Command flies the ship, Overview pulls back, Inspect zooms in close. Keep pressing V to come back to Command.',
    commsAck: 'Good. V always loops you back to Command — your flying view — so you can never get stuck.',
    text: 'Change camera (V)',
    glyph: 'V',
    keys: ['KeyV'],
    triggerEvent: 'CAMERA_VIEW_CHANGE',
    // 2026-06-03 consolidation: V is now the single taught camera control. It
    // cycles Command → Overview → Inspect → Command; Inspect (formerly the
    // separate I hotkey) shows a close, contextual wireframe of your ship or a
    // locked target. Bare I is retained as an undocumented power-user shortcut.
    // The comms copy explicitly tells the player V loops back to Command so a
    // new player never gets stranded in Overview/Inspect mid-mission.
    skillId: 'nav_camera',
    credit: 10,
    optional: true,                       // skippable after 25s
    skipAfter: 25000,
    escalationText: 'V cycles Command → Overview → Inspect, then back to Command. Command is your flying view — just keep tapping V until you return to it. Inspect zooms in on your ship (or a locked target) with full callouts.',
  },
  {
    id: 'scan',
    commsSource: 'BANGALORE', commsText: 'Ground station requests a scan of your area. Press S.',
    commsAck: 'Scan returned. Multiple contacts.',
    text: 'Scan area',
    glyph: 'S',
    keys: ['KeyS'],
    triggerEvent: 'SCAN_INITIATED',
    skillId: 'scan_quick',
    credit: 10,
    escalationText: 'S fires a Quick Scan ($50, 1.5s). W is a Wide Scan ($150, 4s).',
  },
  {
    id: 'target',
    commsSource: 'BANGALORE', commsText: 'Choose your target carefully — press Tab to cycle.',
    commsAck: 'Target locked. Fragment in range.',
    text: 'Cycle target',
    glyph: 'Tab',
    keys: ['Tab'],
    triggerEvent: 'TARGET_SELECTED',
    skillId: 'nav_target',
    credit: 10,
    escalationText: 'Tab cycles through tracked debris by Time-to-Closest-Approach (TPI).',
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
    commsSource: 'HOUSTON', commsText: 'You\'re close to the debris now. Two capture tools — lasso for nearby, daughter arms for the big stuff.',
    commsAck: null,
    glyph: '?', keys: [], skillId: null,
    autoAdvanceAfter: 3500,
  },
  {
    id: 'lasso',
    commsSource: 'HOUSTON', commsText: 'Try the lasso first — press N (or Space) when debris is within 50 m. Quick and easy.',
    commsAck: 'Catch! Nice shot, Cowboy. That\'s how it\'s done.',
    text: 'Fire lasso/net',
    glyph: 'N',
    keys: ['KeyN','Space'],
    triggerEvent: 'LASSO_FIRED',
    skillId: 'collect_lasso',
    credit: 10,
    parallel: 'daughter',
    escalationText: 'N fires the lasso at the selected target within 50 m. Space bar works too. Aim at the green-highlighted debris.',
  },
  {
    id: 'daughter',
    commsSource: 'HOUSTON', commsText: 'For distant or heavy debris, deploy a daughter arm — press D. Pilot it with P, then recall with R.',
    commsAck: 'Daughter deployed — nice work. Pilot with P to steer it home.',
    text: 'Deploy daughter',
    glyph: 'D',
    keys: ['KeyD'],
    triggerEvent: 'ARM_DEPLOYED',
    skillId: 'collect_deploy',
    credit: 10,
    parallel: 'lasso',
    escalationText: 'D launches the next docked daughter toward your target. Press P to pilot it, then R to recall. Daughter arms can reach debris the lasso cannot.',
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
   */
  constructor(deps = {}) {
    this._eventBus = deps.eventBus;
    this._scoring = deps.scoringSystem || null;
    this._skills = deps.skillsSystem || null;
    this._teaching = deps.teachingSystem || null;
    this._persistence = deps.persistenceManager || null;

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
    };

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
      // (7) Optional auto-skip for `inspect` beat.
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

  _onTrigger(beat) {
    if (!this._active) return;
    if (this._active.beat.id !== beat.id) {
      // It's possible this beat is the *parallel partner* of the active beat
      // — satisfying it should also satisfy the partner.
      if (beat.parallel && this._active.beat.id === beat.parallel) {
        // Treat as satisfying the active beat instead, then mark partner too.
        this._satisfy(this._active.beat, /* alsoPartner= */ beat.id);
        return;
      }
      return;
    }
    this._satisfy(beat, /* alsoPartner= */ null);
  }

  _satisfy(beat, alsoPartner) {
    if (!this._active || this._active.beat.id !== beat.id) return;
    this._clearActiveTimers();

    // (1) HINT_SATISFIED → fades the ticker entry.
    this._emit(Events.HINT_SATISFIED, { id: beat.id });

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
    }
    a.idleTimer = null;
    a.autoAdvanceTimer = null;
    a.skipTimer = null;
  }
}

// CJS guard — exposes the data for Node-safe tests.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OnboardingDirector, ONBOARDING_BEATS };
}

export default OnboardingDirector;
