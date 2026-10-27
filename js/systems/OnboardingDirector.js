/**
 * OnboardingDirector.js — orchestrates the 9-beat first-experience pipeline
 * (ONBOARDING_BEATS.length is the SSOT; test-shop-cadence pins this header to it).
 *
 * Delegation 2 (2026-05-31). Walks new players through the reward-first capture
 * spine (v3 beat list, 2026-06-17):
 *   boot → handshake → tease_lock → first_catch → second_catch → range_wall →
 *   close_and_catch → free_clear → final
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
  * Persistence: localStorage['spacecowboy_onboarding_v4'] = {
 *   completedBeats:[], skippedBeats:[], mastered:bool
 * }
 *
 * @module systems/OnboardingDirector
 */

import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { StorageKeys } from '../core/StorageKeys.js';
import { GestureHints } from '../ui/hud/GestureHints.js';
import { gameState } from '../core/GameState.js';
import { wingsHint, WINGS_HINT_ID } from './WingsHint.js';
import { OPENING_LINE_START } from './StartOpening.js';
import { OUT_OF_MOTHER_NETS_LINE, motherNWorks, motherNHeldBack, motherNLine } from './netRouting.js';

/**
 * DECISIONS §33 row 9 (owner, 2026-10-20): the mother carries four nets for the whole run and a miss costs one, so a
 * player can reach a net beat with none left. Those beats (`motherEmptyToD: true`) then show the one out-of-nets
 * line and swap their N chip for this D chip; any capture (the mother's, or a daughter's dock) still completes them.
 */
export const MOTHER_EMPTY_CHIP = Object.freeze({
  text: 'Send a daughter', glyph: 'D', keys: Object.freeze(['KeyD']), press: 'KeyD', button: 'SEND DAUGHTER',
});

/** u11 D3: the range wall's nudge while its target is already within net reach (same wording as the net beats' chip). */
const IN_REACH_NUDGE = Object.freeze({
  text: 'Launch the net', glyph: 'N', keys: Object.freeze(['KeyN']), press: 'KeyN', button: 'LAUNCH NET',
});

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
    // u2-one-voice D3/D4: no key names (the chip carries the how), and ONE step at a
    // time - the line (and the scan after it) waits until the wings are commanded out.
    // Owner 2026-10-20: the wings are commanded by the opening itself on the player's
    // first action of any kind (StartOpening), or by the player's own `,` before it:
    // either way WingsHint.needsOpening() reads the commanded target, so this passes.
    commsSource: 'HOUSTON', commsText: 'Power coming in. Nothing is marked until you scan.',
    commsAck: null,
    glyph: '✓', keys: [], skillId: null,
    requiresWingsCommanded: true,
    autoAdvanceAfter: 3000,
  },
  {
    // The tease. Scan-first (owner 2026-10-08, DECISIONS §15 row 1): nothing is
    // marked until the player presses S, so this beat HOLDS on the existing
    // `requiresContacts` gate with a persistent "Press S" nudge, and
    // posts the real net line once the first scan reveal lands (TARGET_DISCOVERED
    // → _recheckHeldGate). AutoLockController then locks the close glinting panel
    // right in front of the mother. Teach the ONE key the opening forces: the net.
    id: 'tease_lock',
    commsSource: 'HOUSTON', commsText: 'Debris {distM} meters in front. Launch the net.',
    // nets-1b (DECISIONS §33): one line per fact, said when it happens. Firing the net is not a catch, so no
    // "Clean catch" here; first_catch says it when the catch really lands.
    commsAck: null,
    // u2-one-voice D2/D8: the cap says N, the body says what it does (key once); on touch
    // the chip is the LAUNCH NET button. Durable (D1b): it stays until the catch.
    text: 'Launch net',
    glyph: 'N',
    keys: ['KeyN'],
    press: 'KeyN',
    button: 'LAUNCH NET',
    requiresContacts: true,
    // Owner 2026-10-13: "Press S to Scan." — on glass GestureHints.speak turns
    // it into "Tap empty space to Scan." (its own "to <verb>" is not doubled).
    noContactNudge: 'Press S to Scan.',
    // The held nudge is about S, not the beat's own N key: its chip shows S
    // (and, on glass, the "tap empty space to scan" gesture chip).
    nudgeGlyph: 'S',
    nudgeKeys: ['KeyS'],
    nudgePress: 'KeyS',
    nudgeButton: 'SCAN',
    triggerEvent: 'LASSO_FIRED',
    // The mother's nets ran out before this beat (not reachable on a fresh run; kept so the rule holds for every N beat):
    // a daughter's capture also completes it.
    altTriggerEvents: ['DEBRIS_CAPTURED'],
    motherEmptyToD: true,
    skillId: 'collect_lasso',
    credit: 10,
    // No stall card (owner, 2026-09-07): the 9 s "That bracket is your lock.
    // Press N…" TeachingOverlay sat over the top-of-screen readouts and only
    // repeated what the comms line + the reticle bracket already say. A beat
    // without escalationText never arms the idle clock and never posts a card.
  },
  {
    // Confirm the first catch landed + name the reward loop. The reticle
    // auto-advances to the next forward piece (AutoLockController REACQUIRE).
    // M1's guided catches ride the MOTHER web-lasso spine, which never emits
    // DEBRIS_CAPTURED (daughter-dock only, ArmUnit). LASSO_CAPTURED fires AT
    // reel completion — the earliest "the catch is definitely secured" signal
    // (a tether snap can only happen BEFORE it; see LassoSystem._resolveCatch)
    // — so the ack lands at the visual moment, not ~8 s later at the collar's
    // CATCH_PROCESSED mate. DEBRIS_CAPTURED stays as the daughter alternative.
    id: 'first_catch',
    // nets-1b: nothing at beat start (the net is still in flight); the line is the beat's ack, so it posts when the
    // beat completes on LASSO_CAPTURED / DEBRIS_CAPTURED, i.e. after the catch.
    commsSource: 'HOUSTON', commsText: null,
    commsAck: 'Capture confirmed. Salvage refines into fuel and credits.',
    glyph: '✓', keys: [], skillId: null,
    triggerEvent: 'LASSO_CAPTURED',
    altTriggerEvents: ['DEBRIS_CAPTURED'],
    counterTarget: 1,
    credit: 0,
    autoAdvanceAfter: 6000,
    // nets-1b R1: the mother's net takes ~8 s to fly and reel, longer than this fallback; a fallback that completed the
    // beat in flight lost the ack ("Capture confirmed") and started second_catch before the catch. While a mother net
    // is in flight the fallback waits; a miss (or a large-net catch) re-arms it (`_rearmDeferredFallback`), so the tutorial never stalls.
    holdFallbackWhileNetInFlight: true,
  },
  {
    // Second easy catch — repetition, slightly more value. Already locked.
    // Same mother-path trigger as first_catch (see the note there); a daughter
    // dock (DEBRIS_CAPTURED) also satisfies it.
    id: 'second_catch',
    commsSource: 'HOUSTON', commsText: 'Good. Keep netting what the reticle locks.',
    commsAck: null,
    text: 'Net the next one',
    glyph: 'N',
    keys: ['KeyN'],
    press: 'KeyN',
    button: 'LAUNCH NET',
    triggerEvent: 'LASSO_CAPTURED',
    altTriggerEvents: ['DEBRIS_CAPTURED'],
    counterTarget: 1,
    skillId: 'collect_lasso',
    credit: 0,
    // Defensive fallback, consistent with its capture-beat siblings
    // (first_catch 6 s / close_and_catch 8 s): a missed/failed capture event
    // can never hang the pipeline here again. Premature advance is harmless —
    // range_wall HOLDS on its out-of-range gate until the close pieces clear.
    autoAdvanceAfter: 8000,
    // The mother is out of nets here (a miss costs one; four last the run): the one out-of-nets line and a D chip;
    // the beat still completes on any capture, a daughter's dock included (altTriggerEvents above).
    motherEmptyToD: true,
    // No-net safety, DAUGHTER path only: NET_EMPTY_CLICK is emitted by a daughter with no nets (never by the
    // mother), so this consolation skip cannot fire for the mother's count. Kept: it stops a hang if every net is gone.
    netEmptySkip: true,
    netEmptyComms: 'Out of nets. We\'ll resupply. Moving on, Cowboy.',
  },
  {
    // The range wall. The third piece is beyond net range — autolock went
    // silent + yellow OUT OF RANGE. Teach Autopilot (A) here and ONLY here.
    id: 'range_wall',
    commsSource: 'BANGALORE', commsText: 'That one\'s too far for the net. See OUT OF RANGE. The autopilot can take us in.',
    commsAck: 'On station. Net it now.',
    text: 'Autopilot in',
    glyph: 'A',
    keys: ['KeyA'],
    press: 'KeyA',
    button: 'AUTOPILOT',
    triggerEvent: 'AUTOPILOT_ENGAGE',
    skillId: 'nav_autopilot',
    credit: 10,
    // Hold until a target is actually out of range (the player has cleared the
    // two close pieces and the reticle has hopped to the far one).
    requiresOutOfRange: true,
    // Scan-first (DECISIONS §15 row 1): AutoLock never locks an unscanned piece,
    // and a player who skipped S can still net #1/#2 with N (the lasso's no-
    // target auto-aim) — so the nudge asks for the scan that marks the far one.
    // Its chip is S, like tease_lock's (glass: the scan gesture).
    outOfRangeNudge: 'Scan for the far piece',
    nudgeGlyph: 'S',
    nudgeKeys: ['KeyS'],
    nudgePress: 'KeyS',
    nudgeButton: 'SCAN',
    escalationText: 'A engages autopilot to the locked target. It closes the gap; the bracket turns cyan when the net can reach.',
  },
  {
    // Close-and-catch payoff: AP arrived, range met (cyan + lock sound), net it.
    // Mother-path trigger (see first_catch note); daughter dock also satisfies.
    id: 'close_and_catch',
    commsSource: 'BANGALORE', commsText: 'In range. Launch the net.',
    commsAck: null,
    glyph: '✓', keys: [], skillId: null,
    triggerEvent: 'LASSO_CAPTURED',
    altTriggerEvents: ['DEBRIS_CAPTURED'],
    counterTarget: 1,
    credit: 0,
    autoAdvanceAfter: 8000,
    motherEmptyToD: true,
    // No-net safety, DAUGHTER path only (see second_catch): NET_EMPTY_CLICK comes from a daughter with no nets.
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
    glyph: '◆', keys: [], skillId: null,
    autoAdvanceAfter: 4000,
  },
  {
    id: 'final',
    commsSource: 'HOUSTON', commsText: 'That\'s real cowboy work. Clear the field, then check LEO for the next cluster. Good hunting.',
    commsAck: null,
    glyph: '◆', keys: [], skillId: null,
    autoAdvanceAfter: 4000,
    onEnter: 'mastered=true',
  },
];

const BEAT_INDEX_BY_ID = new Map(ONBOARDING_BEATS.map((b, i) => [b.id, i]));

/**
 * All trigger-event NAMES for a beat: the primary `triggerEvent` plus any
 * `altTriggerEvents` (e.g. capture beats satisfy on the mother path's
 * LASSO_CAPTURED and, alternatively, a daughter dock's DEBRIS_CAPTURED).
 * De-duplicated; empty for narrative beats.
 * @param {object} beat
 * @returns {string[]}
 */
export function beatTriggerEventNames(beat) {
  if (!beat) return [];
  const names = [];
  if (beat.triggerEvent) names.push(beat.triggerEvent);
  if (Array.isArray(beat.altTriggerEvents)) {
    for (const n of beat.altTriggerEvents) {
      if (n && !names.includes(n)) names.push(n);
    }
  }
  return names;
}

// Set of skills used by onboarding (for veteran-skip threshold check).
const RELEVANT_SKILLS = new Set(
  ONBOARDING_BEATS.map(b => b.skillId).filter(Boolean)
);

// Default skip-after for `optional` beats when no `skipAfter` set.
const OPTIONAL_DEFAULT_SKIP_MS = 25000;

/**
 * Owner 2026-10-20: the ship's opening line ("Opening up: wings out, radiators to
 * 146°, ... The radiators give the wings room to follow the Sun.") is the
 * one place the player is told WHY the radiators open. The comms panel shows only the
 * newest line, and the handshake beat's "Power coming in ..." is released the same
 * frame the wings are commanded (measured headless, tmp/l2-open: 1.0 s Mac, 0.07 s
 * touch), which would replace it at once. So the handshake beat waits this long after
 * the opening line (a two-line message, read at a calm pace).
 */
export const OPENING_LINE_READ_MS = 5000;

// ────────────────────────────────────────────────────────────────────────────
// ONBOARDING DIRECTOR
// ────────────────────────────────────────────────────────────────────────────

/**
 * n-leftovers L2 (owner 2026-10-27): a beat can be up while he flies a daughter (launching one starts her flight), and then N
 * works HER tool, not the mother's net. A chip that names the mother's net (a step chip pressed with N, or the lasso reminder)
 * says "Esc, then N ..." as it is posted, or is held back (null) when Esc would recall her. Picked at post time; nothing else
 * changes. Not piloted, or no resolver (headless, old tests): the payload comes back untouched.
 * @param {object} payload a HINT_POSTED payload
 * @returns {object|null}
 */
export function pilotedMotherNChip(payload) {
  if (!payload || motherNWorks()) return payload;
  const step = payload.press === 'KeyN' && Array.isArray(payload.keys) && payload.keys.includes('KeyN');
  const reminder = payload.skillId === 'collect_lasso' && typeof payload.id === 'string' && payload.id.startsWith('remind_');
  if (!step && !reminder) return payload;
  if (motherNHeldBack()) return null;
  if (reminder) return { ...payload, text: motherNLine(payload.text), glyph: 'Esc' };
  const t = String(payload.text || '');
  const { press, button, ...rest } = payload;
  return { ...rest, text: `Esc, then N to ${t.charAt(0).toLowerCase()}${t.slice(1)}`, glyph: 'Esc', keys: [] };
}

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
   *   hasTarget:boolean, targetOutOfRange?:boolean, ladderAway?:boolean }.
   *   `ladderAway` (2026-09-02): true while the Zoom Ladder holds a floor other
   *   than the flying view (F4) — the stall escalation defers and ladder inputs
   *   don't count as unrelated. Optional; beats degrade gracefully without it.
   * @param {Function} [deps.floorProvider]  — () → number|null, the settled
   *   Zoom Ladder floor. Same contract as GestureSplash's `floor` getter:
   *   null while the intro flyby / a ride is in flight, 2 on the flying floor.
   *   Absent → the DETAIL ticker beat never fires (safe default; main.js wires
   *   it inside the LADDER gate). Plan 1788867799156 Task 15 / locked #17.
   * @param {Function} [deps.getMotherNetCapacity]  — () => number, the mother's magazine size at the current fibre tier
   *   (4 at the start tier; 6/8/10 once bought). Seeds `_motherNets` at construction and after GAME_RESET (the full
   *   magazine, never the live count: the restock may run after the reset handler). Absent -> the start-tier size.
   * @param {Function} [deps.deferWhile]  — () => boolean, true while the
   *   opening dance is still unfolding (main.js wires it to the openingDance
   *   singleton; plan 1789086956154 Task 5). While true the ORBITAL_VIEW start
   *   defers — the dance is wordless, so the boot beat waits for
   *   OPENING_DANCE_HANDOVER instead of firing at the cut. Absent → the
   *   pipeline starts exactly as before.
   */
  constructor(deps = {}) {
    this._eventBus = deps.eventBus;
    this._scoring = deps.scoringSystem || null;
    this._skills = deps.skillsSystem || null;
    this._teaching = deps.teachingSystem || null;
    this._persistence = deps.persistenceManager || null;
    this._context = typeof deps.contextProvider === 'function' ? deps.contextProvider : null;
    this._floorProvider = typeof deps.floorProvider === 'function' ? deps.floorProvider : null;
    /** @type {Function|null} u14b B5: () => the mother's magazine capacity at the current fibre tier (see deps doc). */
    this._getMotherNetCapacity = typeof deps.getMotherNetCapacity === 'function' ? deps.getMotherNetCapacity : null;
    /** @type {Function|null} opening-dance defer gate (see deps doc). */
    this._deferWhile = typeof deps.deferWhile === 'function' ? deps.deferWhile : null;
    /** @type {object|null} GuidanceDirector — scales coaching depth per persona. */
    this._guidance = deps.guidanceDirector || null;
    /** u2-one-voice D4: the wings hint (needsOpening()) the handshake gate reads; shared instance by default. */
    this._wings = deps.wings || wingsHint;
    /** @type {number|null} Date.now() when the ship's opening line (StartOpening) went up; cleared when the handshake posts. */
    this._openingLineAtMs = null;

    /** @type {Set<string>} ids of beats already satisfied (across runs). */
    this._completedBeats = new Set();
    /** @type {Set<string>} ids of beats skipped (tiered-skip / optional). */
    this._skippedBeats = new Set();
    /** @type {boolean} true once final `complete` beat has fired. */
    this._mastered = false;

    /**
     * The mother's nets, cached from NET_INVENTORY_CHANGED { source:'mother', motherNets } (DECISIONS §33 row 9).
     * Starts full; GAME_RESET puts the full magazine back. Not persisted.
     * @type {number}
     */
    this._motherNets = this._fullMagazine();

    /**
     * True from the moment a mother shot (the lasso or the large net) leaves the launcher until it has resolved (caught
     * or missed). The out-of-nets line and the D chip wait for it: a last net still flying may yet catch.
     * @type {boolean}
     */
    this._motherShotInFlight = false;

    /**
     * comms-after-tutorial D1: true once ONBOARDING_MASTERED has been emitted this run
     * (it fires once; reset() re-arms it). Not persisted.
     * @type {boolean}
     */
    this._masteredAnnounced = false;

    /**
     * tutorial-end-switch D1: true once ONBOARDING_COMPLETE has been emitted by the tutorial's
     * end this run (the all-beats-known path shares it). reset() re-arms it. Not persisted.
     * @type {boolean}
     */
    this._completeAnnounced = false;

    /** @type {boolean} flag set after MISSION_START fires (we wait for it). */
    this._started = false;

    /** @type {number} index into ONBOARDING_BEATS for the currently-active beat. */
    this._beatIndex = -1;

    /** @type {object|null} state of currently-active beat. */
    this._active = null;

    /** @type {boolean} True while an aim-before-launch rotation slew is active. */
    this._aimActive = false;

    /**
     * One-shot DETAIL ticker beat (plan 1788867799156 Task 15). PLAYER-owned:
     * survives GAME_RESET / New Game so it fires once per player, not per run.
     * Additive field on the v4 blob — STORAGE_KEY is not bumped.
     * @type {boolean}
     */
    this._detailHintShown = false;

    /** @type {*|null} poll timer while waiting for the first settled F2. */
    this._detailHintPoll = null;

    /**
     * h4-simple-first D9: true once a scan has completed this boot. In mission 1 the DETAIL beat
     * ("− / + fewer / more panes") waits for it — the first frames stay calm.
     * @type {boolean}
     */

    /** @type {Array<{ event: string, at: number }>} recent trigger event buffer. */
    this._recentInputs = [];

    /** @type {Array<Function>} unsubscribe handles. */
    this._unsubs = [];

    /** @type {boolean} smart-default "first use" comms ack guard. */
    this._smartDefaultMsgShown = false;

    /** @type {boolean} */
    this._disposed = false;

    /** u3-payoff-calm D5: the after-completion advance timer (cleared by reset / dispose). */
    this._advanceTimer = null;

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
   *   engageAutopilot, fireLasso, deployDaughter (any subset).
   * @returns {boolean} true if a synthetic action was dispatched.
   */
  pressActiveHint(inputManager) {
    if (!this._active || this._mastered) return false;
    const beat = this._active.beat;
    // A beat showing the out-of-nets D chip presses D, not its own N (DECISIONS §33 row 9).
    const emptyD = !!this._active.motherEmptyShown && !!beat && !!beat.motherEmptyToD;
    if (!beat || (!emptyD && (!Array.isArray(beat.keys) || beat.keys.length === 0))) return false;
    const primary = emptyD ? MOTHER_EMPTY_CHIP.keys[0] : beat.keys[0];
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
      case 'KeyD':
        if (typeof im.deployDaughter === 'function') { im.deployDaughter(); dispatched = true; }
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
    // DETAIL beat is a sidecar (not in ONBOARDING_BEATS): try now, then poll
    // until the intro ride settles on F2. Safe no-op without a floorProvider.
    this._maybeDetailHint();
    this._armDetailHintPoll();
    if (this._checkVeteranSkip()) {
      this._mastered = true;
      this._persist();
      // u5-info-ap-hold D3: a veteran has no hand-over beat - comms opens here if a start still held it.
      this._emit(Events.COMMS_RELEASE, {});
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
    // u3-payoff-calm D5: a beat's pending timers (idle, auto-advance, skip, gate) must not fire into the new run.
    this._clearActiveTimers();
    this._clearAdvanceTimer();
    // u2-one-voice: a durable beat chip (and its nudge) must not outlive a retry.
    if (this._active && this._active.beat) {
      this._dropBeatChip(this._active.beat);
      this._emit(Events.HINT_SATISFIED, { id: this._active.beat.id + '_wait' });
    }
    this._completedBeats.clear();
    this._skippedBeats.clear();
    this._mastered = false;
    this._masteredAnnounced = false; // comms-after-tutorial D1: the next run announces again
    this._completeAnnounced = false; // tutorial-end-switch D1: so does COMPLETE
    this._active = null;
    this._beatIndex = -1;
    this._recentInputs.length = 0;
    this._smartDefaultMsgShown = false;
    this._started = false;
    this._stationKeepArrowsShown = false;
    this._motherNets = this._fullMagazine();
    this._motherShotInFlight = false;
    this._clearDetailHintPoll();
    // `_detailHintShown` is per-player — not cleared (locked decision #17).
    this._persist();
  }

  /** Tear down — unsubscribe + clear pending timers. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._clearActiveTimers();
    this._clearAdvanceTimer();
    this._clearDetailHintPoll();
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
    // never subscribed — so its localStorage blob (`spacecowboy_onboarding_v4`)
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
        if (to !== 'ORBITAL_VIEW') return;
        // Opening dance (plan 1789086956154 Task 5): the ORBITAL_VIEW entry at
        // the cut is mid-unfold and the dance is wordless — hold the boot beat
        // until the hand-over instead of firing both at the cut.
        if (this._deferWhile && this._deferWhile()) return;
        this.start();
      });
    }
    // The dance hands the wheel over → the pipeline starts (normally the
    // ORBITAL_VIEW start above deferred it). Idempotent: if the defer gate was
    // absent (flag off / ?shot / reduced motion), this start() is a no-op.
    if (Events.OPENING_DANCE_HANDOVER) {
      on(Events.OPENING_DANCE_HANDOVER, () => this.start());
    }
    // DETAIL beat nudge: a zoom/pinch that lands F2 (CAMERA_ZOOM_INPUT is the
    // ladder ride's player-side witness). The intro landing has no zoom input
    // — start() arms a poll for that. Absent floorProvider → both are no-ops.
    if (Events.CAMERA_ZOOM_INPUT) {
      on(Events.CAMERA_ZOOM_INPUT, () => this._maybeDetailHint());
    }
    // h4-simple-first D9: the first completed scan releases the DETAIL beat in mission 1.
    if (Events.SCAN_COMPLETE) {
      on(Events.SCAN_COMPLETE, () => this._maybeDetailHint());
    }

    // F1.2: flying a daughter starts or stops (the mother-net chip says what N does, so it follows the switch).
    if (Events.CONTROL_MODE_CHANGE) {
      on(Events.CONTROL_MODE_CHANGE, () => this._onPilotSwitch());
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
    // A beat may declare alternative triggers (altTriggerEvents) — any one of
    // them satisfies it (capture beats: mother LASSO_CAPTURED ∨ daughter
    // DEBRIS_CAPTURED). _onTrigger is idempotent per beat, so multi-wiring is safe.
    for (const beat of ONBOARDING_BEATS) {
      for (const name of beatTriggerEventNames(beat)) {
        const evt = Events[name];
        if (!evt) continue;
        on(evt, () => this._onTrigger(beat));
      }
    }

    // Prompt re-check of a HELD beat's gate the instant relevant state changes
    // (a scan reveals a contact, or the player closes on a target) so the held
    // hint converts to the real beat without waiting for the next poll tick.
    // LASSO_CAPTURED joins DEBRIS_CAPTURED so a MOTHER catch (the M1 spine)
    // prompts the same recheck a daughter dock does.
    const gateNudgeEvents = [
      Events.TARGET_DISCOVERED, Events.SCAN_COMPLETE, Events.AUTOPILOT_ENGAGE,
      Events.TARGET_OUT_OF_RANGE, Events.DEBRIS_CAPTURED, Events.LASSO_CAPTURED,
      // u11 D3: a held range wall swaps its nudge when its target comes within net reach (or leaves it).
      Events.TARGET_IN_RANGE, Events.TARGET_CLEARED,
    ];
    for (const e of gateNudgeEvents) {
      if (!e) continue;
      on(e, () => this._recheckHeldGate());
    }
    // u2-one-voice D4: the wings chip coming down (WingsHint emits it once the wings
    // are commanded out, after `needsOpening()` went false) releases a handshake held
    // on `requiresWingsCommanded`. The held-beat poll tick is the backstop.
    if (Events.HINT_SATISFIED) {
      on(Events.HINT_SATISFIED, (d) => { if (d && d.id === WINGS_HINT_ID) this._recheckHeldGate(); });
    }
    // Owner 2026-10-20: note when the ship's opening line goes up (StartOpening), so the
    // handshake beat can leave it on screen for OPENING_LINE_READ_MS (see _beatGateMet).
    if (Events.COMMS_MESSAGE) {
      on(Events.COMMS_MESSAGE, (m) => {
        if (m && typeof m.text === 'string' && m.text.startsWith(OPENING_LINE_START)) this._openingLineAtMs = Date.now();
      });
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

    // DECISIONS §33 row 9: follow the mother's one count of nets; an N beat with none left points at D instead.
    // (Registered after the GAME_RESET handler above, so a reset's full magazine is what a new run sees.)
    if (Events.NET_INVENTORY_CHANGED) {
      on(Events.NET_INVENTORY_CHANGED, (d) => {
        if (d && d.source === 'mother' && Number.isFinite(d.motherNets)) this._onMotherNets(d.motherNets);
      });
    }
    // R1 (review 2026-10-20): the D line waits until the last mother net has resolved. A shot is in flight from
    // LASSO_FIRED / NET_FIRED{source:'mother'} (both are emitted before the count drops) until it catches or misses.
    // A catch only clears the flag (the beat completes on it, so no D line); a miss clears it and re-checks the count.
    if (Events.LASSO_FIRED) on(Events.LASSO_FIRED, () => { this._motherShotInFlight = true; });
    if (Events.NET_FIRED) {
      on(Events.NET_FIRED, (d) => { if (d && d.source === 'mother') this._motherShotInFlight = true; });
    }
    // nets-1b review 2: a daughter's net result (armIndex >= 0) says nothing about the mother's shot. A mother catch
    // the beat does not complete on (the large net's NET_CATCH_SUCCESS) re-arms a held fallback, so it never freezes
    // the tutorial; once the beat has completed on its own trigger the re-arm does nothing.
    const daughterNet = (d) => !!d && Number.isInteger(d.armIndex) && d.armIndex >= 0;
    for (const name of ['LASSO_CAPTURED', 'NET_CATCH_SUCCESS']) {
      if (Events[name]) on(Events[name], (d) => {
        if (name === 'NET_CATCH_SUCCESS' && daughterNet(d)) return;
        this._motherShotInFlight = false;
        this._rearmDeferredFallback();
      });
    }
    for (const name of ['LASSO_MISSED', 'NET_CATCH_MISS']) {
      if (Events[name]) on(Events[name], (d) => {
        if (name === 'NET_CATCH_MISS' && daughterNet(d)) return;
        this._motherShotInFlight = false;
        this._onMotherNets(this._motherNets);
        this._rearmDeferredFallback();
      });
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

    // Aim-before-launch: a multi-second auto-rotation slew precedes the actual
    // fire/deploy. Pause idle-escalation + auto-advance fallback timers and
    // freeze the unrelated-input counter for its duration so the player isn't
    // nagged (idle) or force-advanced before the delayed fire happens, and
    // repeated N/D presses during the slew don't count as unrelated input.
    if (Events.AIM_SEQUENCE_START) on(Events.AIM_SEQUENCE_START, () => this._onAimSequenceStart());
    if (Events.AIM_SEQUENCE_END)   on(Events.AIM_SEQUENCE_END,   () => this._onAimSequenceEnd());
  }

  /**
   * @private R1 (nets-1b review): a beat flagged `holdFallbackWhileNetInFlight` does not let its auto-advance fallback
   * complete it while a mother net is in flight (fired, not yet caught or missed). Returns true when it deferred; the
   * timer is then spent and `_rearmDeferredFallback` starts it again if the net resolves without a catch.
   */
  _deferFallbackWhileNetInFlight(beat) {
    if (!beat || !beat.holdFallbackWhileNetInFlight || !this._motherShotInFlight) return false;
    const a = this._active;
    if (a && a.beat && a.beat.id === beat.id) { a.autoAdvanceTimer = null; a.fallbackDeferred = true; }
    return true;
  }

  /** @private The net resolved without a catch: a fallback that was held in flight runs again, from now. */
  _rearmDeferredFallback() {
    const a = this._active;
    if (!a || !a.fallbackDeferred || !a.beat || this._aimActive) return;
    const beat = a.beat;
    a.fallbackDeferred = false;
    if (a.autoAdvanceTimer != null || !Number.isFinite(beat.autoAdvanceAfter)) return;
    a.autoAdvanceTimer = this._setTimeout(() => {
      if (!this._active || this._active.beat.id !== beat.id) return;
      if (this._deferFallbackWhileNetInFlight(beat)) return;
      this._dropBeatChip(beat);
      this._completedBeats.add(beat.id);
      this._persist();
      this._active = null;
      this._advanceToNextBeat();
    }, beat.autoAdvanceAfter);
  }

  /** @private Pause beat timers while the aim-rotation slew is active. */
  _onAimSequenceStart() {
    this._aimActive = true;
    const a = this._active;
    if (a && typeof clearTimeout === 'function') {
      if (a.idleTimer != null) { clearTimeout(a.idleTimer); a.idleTimer = null; }
      if (a.autoAdvanceTimer != null) { clearTimeout(a.autoAdvanceTimer); a.autoAdvanceTimer = null; }
    }
  }

  /** @private Restart the paused beat timers once the slew resolves/aborts. */
  _onAimSequenceEnd() {
    this._aimActive = false;
    const a = this._active;
    if (!a || !a.beat) return;
    const beat = a.beat;
    const idleMs = Constants.ONBOARDING?.IDLE_ESCALATION_MS || 15000;
    if (beat.escalationText && a.idleTimer == null) {
      a.idleTimer = this._setTimeout(() => this._escalate(beat), idleMs);
    }
    if (Number.isFinite(beat.autoAdvanceAfter) && a.autoAdvanceTimer == null) {
      a.autoAdvanceTimer = this._setTimeout(() => {
        if (this._active && this._active.beat.id === beat.id) {
          if (this._deferFallbackWhileNetInFlight(beat)) return;
          // `_advanceToNextBeat()` below returns early once mastered; there it announces
          // ONBOARDING_MASTERED (comms) and then ONBOARDING_COMPLETE: the tutorial's end
          // switches the rest of the game on (owner 2026-10-19, tmp/plans/tutorial-end-switch.md).
          if (!beat.triggerEvent && beat.onEnter === 'mastered=true') this._mastered = true;
          this._dropBeatChip(beat);
          this._completedBeats.add(beat.id);
          this._persist();
          this._active = null;
          this._advanceToNextBeat();
        }
      }, beat.autoAdvanceAfter);
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
      text: 'Turn to line her up',
      glyph: '←→↑↓',
      keys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'],
      skillId,
      duration: Constants.ONBOARDING?.DEFAULT_HINT_MS || 12000,
      priority: 'normal',
      presentation,
      step: true,
    });
  }

  /**
   * One-time DETAIL ticker beat on the first settled F2 landing per player
   * (plan 1788867799156 Task 15 / locked #17). Glass vs desktop text follows
   * GestureHints.isGlass() — the same surface switch the ticker already uses.
   * @private
   */
  _maybeDetailHint() {
    if (this._disposed || this._detailHintShown) return;
    if (!this._floorProvider) return;
    let floor = null;
    try { floor = this._floorProvider(); } catch (_e) { return; }
    if (floor !== 2) return;
    // z1-calm-scan D6 (owner 2026-10-18; was h4-simple-first D9 "waits for the first scan"): in mission 1
    // the hint waits for the THIRD catch - the first scan already brings the Targets list, and a new
    // player has enough on screen. Mission 2 on (or without a scoring system to ask): today's behaviour.
    if (this._inMissionOne() && !(gameState.debrisCleared >= 3)) return;
    this._detailHintShown = true;
    this._clearDetailHintPoll();
    this._persist();
    const glass = GestureHints.isGlass();
    this._emit(Events.HINT_POSTED, {
      id: 'detail',
      text: glass
        ? 'DETAIL · slide ← fewer · more →'
        : '− / + · fewer / more panes',
      glyph: glass ? 'DETAIL' : '−/+',
      keys: glass ? [] : ['Minus', 'Equal'],
      duration: Constants.ONBOARDING?.DEFAULT_HINT_MS || 12000,
      priority: 'normal',
    });
  }

  /** @private true while the scoring ledger says mission 1 (false when it cannot say). */
  _inMissionOne() {
    try {
      return !!this._scoring && typeof this._scoring.getMissionNumber === 'function'
        && this._scoring.getMissionNumber() === 1;
    } catch (_e) {
      return false;
    }
  }

  /**
   * Poll until the intro ride settles on F2 (the intro has no CAMERA_ZOOM_INPUT).
   * Mirrors the held-beat gate poll. No-op without a floorProvider.
   * @private
   */
  _armDetailHintPoll() {
    if (this._disposed || this._detailHintShown || !this._floorProvider) return;
    if (this._detailHintPoll != null) return;
    const poll = Constants.ONBOARDING?.GATE_POLL_MS || 1200;
    const tick = () => {
      this._detailHintPoll = null;
      if (this._disposed || this._detailHintShown) return;
      this._maybeDetailHint();
      if (this._disposed || this._detailHintShown) return;
      const id = this._setTimeout(tick, poll);
      if (id == null) return;
      this._detailHintPoll = id;
    };
    const id = this._setTimeout(tick, poll);
    if (id == null) return;
    this._detailHintPoll = id;
  }

  /** @private */
  _clearDetailHintPoll() {
    if (this._detailHintPoll != null && typeof clearTimeout === 'function') {
      clearTimeout(this._detailHintPoll);
    }
    this._detailHintPoll = null;
  }

  /**
   * u14b B5: the full magazine the mother starts a run with. The fibre tier's capacity when main.js supplies it, else the
   * start-tier size. Only compared with 0 and overwritten by every NET_INVENTORY_CHANGED, but the number should be right.
   * @private
   * @returns {number}
   */
  _fullMagazine() {
    try {
      const n = this._getMotherNetCapacity ? this._getMotherNetCapacity() : NaN;
      if (Number.isFinite(n) && n > 0) return n;
    } catch (_e) { /* best-effort */ }
    return Constants.CAPTURE_NET.LARGE.MAGAZINE_SIZE;
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
    // u14b B3: on glass a reminder for a key (or mouse gesture) with no touch control is not posted (R14 pattern).
    if (!GestureHints.reminderFitsGlass(def, d.skillId)) return;
    // Slice 8 — codex resurfacing: when the manage_codex reminder carries a
    // "did you know?" pick, point the player at a specific unread entry instead
    // of the generic library reminder. Same HINT_POSTED path, same gating.
    const dyk = d.didYouKnow;
    const text = (dyk && dyk.title)
      ? `Did you know? ${dyk.icon || ''} ${dyk.title} is in your library — press ${def.key || 'I'}`
      // nets-1b (Ruling 0): the def's own plain phrase ("Press S to scan."); a def without one is its label alone.
      // No "[key]" glue: GestureHints rewrites the letter-key phrases for touch, and a bracket reads as code.
      : (typeof def.say === 'string' && def.say ? def.say : `Reminder: ${def.label}`);
    this._emit(Events.HINT_POSTED, {
      id: 'remind_' + d.skillId,
      // u11 R13: on glass the line names the chip ("Tap LAUNCH NET ..."), as comms lines do; desktop: the same string.
      text: GestureHints.chipPhrase(text),
      glyph: GestureHints.isGlass() ? GestureHints.skillWord(def, d.skillId) : (def.key || '?'),   // u15b B-T5: glass never shows a raw key or '?'
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
    } else {
      this._refreshHeldNudge(beat);
    }
  }

  // ─── INTERNAL — BEAT LIFECYCLE ────────────────────────────────────────

  /**
   * The mother's count changed (DECISIONS §33 row 9). While an N beat (`motherEmptyToD`) is current and the count
   * reaches 0, post the one out-of-nets line and swap the beat's chip to D, once; if nets come back (a restock) put
   * the beat's own chip back. A beat still held on a gate is left to `_postBeat`, which reads the count on entry.
   * @param {number} count
   * @private
   */
  _onMotherNets(count) {
    this._motherNets = count;
    const a = this._active;
    if (a && a.held && a.beat) this._refreshHeldNudge(a.beat);   // u11 D3: the in-reach nudge of a held range beat
    if (!a || a.held || !a.beat || !a.beat.motherEmptyToD) return;
    if (this._motherShotInFlight) return;   // the last net may still catch: say nothing until it has resolved
    if (count <= 0 && !a.motherEmptyShown) {
      a.motherEmptyShown = true;
      if (!this._isMinimal()) this._postMotherEmpty(a.beat);
    } else if (count > 0 && a.motherEmptyShown) {
      a.motherEmptyShown = false;
      if (!this._isMinimal() && Array.isArray(a.beat.keys) && a.beat.keys.length > 0) this._postBeatChip(a.beat);
    }
  }

  /**
   * The ONE out-of-nets line plus the D chip, in place of the beat's own line and N chip. The chip re-uses the beat's
   * id, so the beat's own HINT_SATISFIED (advance / complete / drop) takes it down like any step chip.
   * @param {object} beat @private
   */
  _postMotherEmpty(beat) {
    this._emitComms({
      source: 'HOUSTON',
      channel: 'HOUSTON',
      text: OUT_OF_MOTHER_NETS_LINE,
      priority: 'info',
      _onboardingBeatId: beat.id,
    });
    this._emit(Events.HINT_POSTED, {
      id: beat.id,
      text: MOTHER_EMPTY_CHIP.text,
      glyph: MOTHER_EMPTY_CHIP.glyph,
      keys: [...MOTHER_EMPTY_CHIP.keys],
      skillId: beat.skillId || undefined,
      duration: 0,
      priority: 'normal',
      step: true,
      press: MOTHER_EMPTY_CHIP.press,
      button: MOTHER_EMPTY_CHIP.button,
    });
  }

  /** The beat's own step chip (the hint-ticker emit of `_postBeat`, shared with the nets-restored path). @private */
  _postBeatChip(beat) {
    this._emit(Events.HINT_POSTED, {
      id: beat.id,
      text: beat.text || beat.commsText || '',
      glyph: beat.glyph,
      keys: beat.keys,
      skillId: beat.skillId || undefined,
      // D1b: a beat chip with a button is durable - it leaves on the Director's own HINT_SATISFIED.
      duration: beat.press ? 0 : (beat.hintDuration || (Constants.ONBOARDING?.DEFAULT_HINT_MS || 12000)),
      priority: 'normal',
      step: true,
      press: beat.press,
      button: beat.button,
    });
  }

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
    // A step chip (one with a button, D1b) carries no (n/N) counter and stays up.
    const isStep = !!beat.press;
    this._emit(Events.HINT_POSTED, {
      id: beat.id,
      text: isStep
        ? (beat.text || beat.commsText || '')
        : `${beat.text || beat.commsText || ''} (${count}/${beat.counterTarget})`,
      glyph: beat.glyph || '#',
      keys: beat.keys || [],
      skillId: beat.skillId || undefined,
      duration: isStep ? 0 : (beat.hintDuration || (Constants.ONBOARDING?.DEFAULT_HINT_MS || 12000)),
      priority: 'normal',
      ...(isStep ? { step: true, press: beat.press, button: beat.button } : {}),
    });
  }

  /**
   * u2-one-voice D1b: a beat chip with a button is durable, so every path that
   * moves past the beat without a trigger (auto-advance timers, optional skip)
   * takes it down itself.
   * @private
   */
  _dropBeatChip(beat) {
    if (beat && beat.press) this._emit(Events.HINT_SATISFIED, { id: beat.id });
  }

  _advanceToNextBeat() {
    // The `final` beat's timer (and the aim-slew end) set `_mastered` BEFORE calling
    // here, so this early return is where a finished tutorial lands. Owner 2026-10-19
    // (tutorial-end-switch D1): the tutorial's end announces ONBOARDING_MASTERED (comms
    // stays at its tutorial tier) and then ONBOARDING_COMPLETE, once per run (reset
    // re-arms both), so the rest of the game switches on. The payload tells the pin
    // release to leave the welcome pieces held (D4). A persisted-mastered start()
    // whose skills fall below the veteran threshold also lands here (STARTED fired, no
    // beats left): the tutorial was already finished, so it switches on at once.
    if (this._mastered) {
      this._announceMastered();
      this._announceComplete({ atTutorialEnd: true });
      return;
    }
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
      this._completeAnnounced = true; // tutorial-end-switch D1: shared guard, never a second COMPLETE
      this._emit(Events.ONBOARDING_COMPLETE, {});
      // D1/D2: the all-skipped path keeps its COMPLETE (unchanged); CommsSystem
      // still needs the mastered signal to end the wake ramp at once.
      this._announceMastered();
      return;
    }
    this._beatIndex = idx;
    this._postBeat(ONBOARDING_BEATS[idx]);
  }

  /**
   * comms-after-tutorial D1: tell CommsSystem (and only comms) that the tutorial's
   * beat list is done. Emits ONBOARDING_MASTERED once per run; reset() re-arms it.
   * @private
   */
  _announceMastered() {
    if (this._masteredAnnounced) return;
    this._masteredAnnounced = true;
    this._emit(Events.ONBOARDING_MASTERED, {});
  }

  /**
   * tutorial-end-switch D1: the tutorial's end switches the rest of the game on.
   * Emits ONBOARDING_COMPLETE once per run; reset() re-arms it.
   * @private
   */
  _announceComplete(payload) {
    if (this._completeAnnounced) return;
    this._completeAnnounced = true;
    this._emit(Events.ONBOARDING_COMPLETE, payload);
  }

  _postBeat(beat) {
    // (review 2026-10-20: never clear _openingLineAtMs here — an opening line posted
    // before this beat starts must still get its read time; the wait is time-bounded.)
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

    // DECISIONS §33 row 9: an N beat reached with no mother nets left says the one out-of-nets line and offers D
    // instead of its own line and N chip. Any capture (the mother's or a daughter's dock) still completes it.
    const motherEmpty = !!beat.motherEmptyToD && this._motherNets <= 0 && !this._motherShotInFlight;
    if (motherEmpty) this._active.motherEmptyShown = true;

    if (motherEmpty && !minimal) {
      this._postMotherEmpty(beat);
    } else {
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
        this._postBeatChip(beat);
      }
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
      const armed = this._active;
      this._active.autoAdvanceTimer = this._setTimeout(() => {
        // u3-payoff-calm D5: only the beat that armed this timer may complete it (reset() / a skip moved on).
        if (this._active !== armed) return;
        if (beat.onEnter === 'mastered=true') {
          // Setting `_mastered` makes `_advanceToNextBeat()` below take its early return, which
          // is the tutorial's real end: it announces ONBOARDING_MASTERED and then
          // ONBOARDING_COMPLETE (owner 2026-10-19, tmp/plans/tutorial-end-switch.md D1).
          this._mastered = true;
        }
        this._dropBeatChip(beat);
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
            if (this._deferFallbackWhileNetInFlight(beat)) return;
            this._dropBeatChip(beat);
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
            this._dropBeatChip(beat);
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
    // u2-one-voice D4: one step at a time - hold while the wings still need opening.
    // Unknown (null: no ship seen yet, unit tests) never holds. Independent of the context.
    if (beat.requiresWingsCommanded) {
      let needs = null;
      try { needs = this._wings && typeof this._wings.needsOpening === 'function' ? this._wings.needsOpening() : null; }
      catch (_e) { needs = null; }
      if (needs === true) return false;
      // Owner 2026-10-20: leave the ship's opening line on screen long enough to read.
      if (this._openingLineAtMs !== null && Date.now() - this._openingLineAtMs < OPENING_LINE_READ_MS) return false;
    }
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

    // One step at a time: while the wings are the job, make sure their chip is
    // on screen (a repeat post is a no-op).
    // (Not once the wings are commanded out: the held beat is then only reading time.)
    if (beat.requiresWingsCommanded && this._wings && typeof this._wings.post === 'function'
        && !(typeof this._wings.needsOpening === 'function' && this._wings.needsOpening() === false)) {
      this._wings.post();
    }

    // Post a soft nudge hint explaining what to do to unblock (once).
    this._active.nudgeKind = null;
    this._postHeldNudge(beat);

    const poll = Constants.ONBOARDING?.GATE_POLL_MS || 1200;
    const tick = () => {
      if (!this._active || this._active.beat.id !== beat.id || !this._active.held) return;
      if (this._beatGateMet(beat)) {
        // Gate satisfied — clear the nudge and post the real beat.
        this._emit(Events.HINT_SATISFIED, { id: beat.id + '_wait' });
        this._postBeat(beat);
        return;
      }
      this._refreshHeldNudge(beat);
      this._active.gateTimer = this._setTimeout(tick, poll);
    };
    this._active.gateTimer = this._setTimeout(tick, poll);
  }

  /**
   * u11 D3: what a held beat's nudge asks for right now. Every gate has one fixed nudge, except the range wall:
   * while its target is already within net reach the nudge is the net itself (SEND DAUGHTER with no mother nets
   * left; a net still in flight counts as left), not "Scan for the far piece" with nothing to tap that helps.
   * @param {object} beat
   * @returns {{kind:string,text:string,glyph:string,keys:string[],press?:string,button?:string}|null}
   * @private
   */
  _heldNudgeFor(beat) {
    if (beat.requiresOutOfRange && !beat.requiresContacts) {
      let inReach = false; let daughterReady = false;
      try {
        const c = (this._context && this._context()) || {};
        inReach = !!c.targetInRange;
        daughterReady = !!c.daughterReady;
      } catch (_e) { inReach = false; }
      if (inReach) {
        const asDaughter = () => ({ kind: 'daughter', text: MOTHER_EMPTY_CHIP.text, glyph: MOTHER_EMPTY_CHIP.glyph,
          keys: [...MOTHER_EMPTY_CHIP.keys], press: MOTHER_EMPTY_CHIP.press, button: MOTHER_EMPTY_CHIP.button });
        const asNet = () => ({ kind: 'net', text: IN_REACH_NUDGE.text, glyph: IN_REACH_NUDGE.glyph,
          keys: [...IN_REACH_NUDGE.keys], press: IN_REACH_NUDGE.press, button: IN_REACH_NUDGE.button });
        if (this._motherNets > 0) return asNet();
        // R4c: no mother nets. The last net still flying may catch: keep the nudge that is up until it resolves
        // (never a NEW LAUNCH NET at 0 nets). Settled: SEND DAUGHTER only when a docked daughter has nets to send.
        if (this._motherShotInFlight) {
          const k = this._active && this._active.nudgeKind;
          if (k === 'net') return asNet();
          if (k === 'daughter') return asDaughter();
        } else if (daughterReady) {
          return asDaughter();
        }
      }
    }
    const nudge = beat.requiresContacts ? beat.noContactNudge
                : Number.isFinite(beat.requiresProximityM) ? beat.farNudge
                : beat.requiresOutOfRange ? beat.outOfRangeNudge
                : null;
    if (!nudge) return null;
    return {
      kind: 'base', text: nudge, glyph: beat.nudgeGlyph || beat.glyph || '…',
      keys: Array.isArray(beat.nudgeKeys) ? beat.nudgeKeys : [], press: beat.nudgePress, button: beat.nudgeButton,
    };
  }

  /** Post the held beat's nudge for the current state (id `<beat>_wait`; a repeat post of a live id is a no-op). @private */
  _postHeldNudge(beat) {
    const n = this._heldNudgeFor(beat);
    if (!n) return;
    if (this._active) this._active.nudgeKind = n.kind;
    this._emit(Events.HINT_POSTED, {
      id: beat.id + '_wait',
      text: n.text,
      glyph: n.glyph,
      keys: n.keys,
      duration: 0, // persistent until satisfied/cleared
      priority: 'normal',
      step: true,
      press: n.press,
      button: n.button,
    });
  }

  /** The nudge kind changed while the beat stays held (target came within reach, nets ran out): swap the chip. @private */
  _refreshHeldNudge(beat) {
    const a = this._active;
    if (!a || !a.held || a.beat.id !== beat.id || !beat.requiresOutOfRange) return;
    const n = this._heldNudgeFor(beat);
    if (!n || n.kind === a.nudgeKind) return;
    this._emit(Events.HINT_SATISFIED, { id: beat.id + '_wait' });
    this._postHeldNudge(beat);
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
    // u3-payoff-calm D5: kept, so reset() / dispose() can drop it (a reset inside the delay must not advance the new run).
    this._clearAdvanceTimer();
    this._advanceTimer = this._setTimeout(() => {
      this._advanceTimer = null;
      this._advanceToNextBeat();
    }, delay);
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

  /**
   * @private Zoom Ladder (owner, 2026-09-02 evening): is the player AWAY from
   * the flying view — riding the ladder on the F3 hull floor or the F5–F7
   * icon floors? Every onboarding beat lives at the flying view (F4), so time
   * spent inspecting the hull or reading the chart is exploring, not being
   * stuck: the stall escalation (idle clock + unrelated-input counter) must
   * not fire there. Read from the contextProvider's `ladderAway` flag (main.js
   * wires `ladderController.isActive() && currentFloor() !== 4`); absent
   * provider/flag → false, i.e. the shipped behaviour, byte-identical.
   * @returns {boolean}
   */
  _ladderAway() {
    if (!this._context) return false;
    try {
      const ctx = this._context();
      return !!(ctx && ctx.ladderAway);
    } catch (_e) {
      return false;
    }
  }

  _escalate(beat) {
    if (!this._active || this._active.beat.id !== beat.id) return;
    if (this._active.escalated) return;
    // Away on the ladder (F3 hull / F5–F7): not a stall — defer. The idle
    // clock restarts for a full window so the "you look stuck" card can only
    // land after IDLE_ESCALATION_MS of the player actually being back at the
    // flying view with the beat still unsatisfied. (Real timers only: the
    // synchronous test fallback would recurse.)
    if (this._ladderAway()) {
      if (beat.escalationText && typeof setTimeout === 'function') {
        if (this._active.idleTimer != null && typeof clearTimeout === 'function') clearTimeout(this._active.idleTimer);
        const idleMs = Constants.ONBOARDING?.IDLE_ESCALATION_MS || 15000;
        this._active.idleTimer = this._setTimeout(() => this._escalate(beat), idleMs);
      }
      return;
    }
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
    // The stall card is an opt-in per beat: escalationText or nothing. (No
    // commsText fallback — it would post a raw '{distM}' template for
    // tease_lock and re-say the comms line for the rest.)
    const body = beat.escalationText || '';
    if (!body) return;
    this._emit(Events.TEACHING_MOMENT_FORCE, {
      id: 'onboarding_' + beat.id,
      title: (beat.text || beat.commsText || '').slice(0, 40),
      body,
      duration: 9000,
      icon: 'HINT',
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
    // Related if it matches ANY of the beat's triggers (primary or alternative)
    // — handled in _onTrigger.
    for (const name of beatTriggerEventNames(beat)) {
      if (Events[name] === eventName) return;
    }
    // Aim-before-launch: freeze the counter during the auto-rotation slew so
    // repeated N/D presses (the beat's own action, pre-fire) don't escalate.
    if (this._aimActive) return;
    // Zoom Ladder: riding away from the flying view (pinch/scroll to the hull
    // or the chart) emits CAMERA_ZOOM_INPUT / MOTHER_INSPECTION_ENGAGED — that
    // is exploring, not fumbling the beat's key. Don't count it.
    if (this._ladderAway()) return;
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
    // (b) Trigger event (primary or alternative) fired in the last
    //     RECENT_INPUT_WINDOW_MS.
    if (beat.triggerEvent) {
      const win = Constants.ONBOARDING?.RECENT_INPUT_WINDOW_MS || 3000;
      const cutoff = Date.now() - win;
      for (const name of beatTriggerEventNames(beat)) {
        const evt = Events[name];
        if (!evt) continue;
        for (const e of this._recentInputs) {
          if (e.event === evt && e.at >= cutoff) return true;
        }
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
    const key = Constants.ONBOARDING?.STORAGE_KEY || StorageKeys.ONBOARDING;
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
      this._detailHintShown = !!data.detailHintShown;
    } catch (_e) { /* graceful */ }
  }

  _persist() {
    const key = Constants.ONBOARDING?.STORAGE_KEY || StorageKeys.ONBOARDING;
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, JSON.stringify({
        completedBeats: Array.from(this._completedBeats),
        skippedBeats: Array.from(this._skippedBeats),
        mastered: this._mastered,
        detailHintShown: this._detailHintShown,
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
    if (distM != null) return text.replace('{distM} meters', `${distM.toLocaleString('en-US')} meters`);
    // No live range — strip the "{distM} meters " clause (note trailing space).
    return text.replace('{distM} meters ', '').replace('{distM} meters', '');
  }

  _emit(eventName, payload) {
    if (!this._eventBus || typeof this._eventBus.emit !== 'function') return;
    if (!eventName) return;
    if (eventName === Events.HINT_POSTED) {
      // F1.2: remember which way a durable N chip of the active beat was picked (flying her or not), so a switch can re-post it
      const a = this._active;
      if (a && a.beat && payload && payload.press === 'KeyN' && (payload.id === a.beat.id || payload.id === a.beat.id + '_wait')) {
        a.nChipPiloted = !motherNWorks();
      }
      payload = pilotedMotherNChip(payload);
      if (payload == null) return;
    }
    this._eventBus.emit(eventName, payload);
  }

  /**
   * F1.2: he started or stopped flying a daughter (CONTROL_MODE_CHANGE, the one signal InputManager emits for it). A durable
   * step chip that names N (`tease_lock`, `second_catch`, the held in-reach nudge) was picked at post time; re-post it now so it
   * says what N does now and, on the mother, gets its press / button back. Short hints stay as they were posted. The ticker
   * ignores a repeat post of a live id, so the chip is taken down first (as `_refreshHeldNudge` does).
   * @private
   */
  _onPilotSwitch() {
    const a = this._active;
    if (!a || !a.beat || a.nChipPiloted === undefined) return;
    const now = !motherNWorks();
    if (a.nChipPiloted === now) return;
    const beat = a.beat;
    if (a.held) {
      this._emit(Events.HINT_SATISFIED, { id: beat.id + '_wait' });
      this._postHeldNudge(beat);
    } else if (!a.motherEmptyShown && beat.press === 'KeyN' && !this._isMinimal()) {
      this._emit(Events.HINT_SATISFIED, { id: beat.id });
      this._postBeatChip(beat);
    }
    a.nChipPiloted = now;
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

  /** u3-payoff-calm D5: drop the after-completion advance timer (reset / dispose). */
  _clearAdvanceTimer() {
    if (this._advanceTimer != null && typeof clearTimeout === 'function') clearTimeout(this._advanceTimer);
    this._advanceTimer = null;
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
  module.exports = { OnboardingDirector, ONBOARDING_BEATS, beatTriggerEventNames };
}

export default OnboardingDirector;
