/**
 * GuidanceDirector.js — graduated guidance depth + behavior-driven auto-tuning.
 *
 * Reward-first onboarding spine (.kilo/plans/new-player-onboarding-flow.md
 * §D.1 / §D.5). One capture-first spine serves every persona; only the AMOUNT
 * of coaching scales. This module owns that scale.
 *
 * Levels (guidanceLevel):
 *   GUIDED   — new player: full comms + chips + idle help.
 *   POINTERS — middle: terse, ticker-only, undiscovered/struggling nudges.
 *   MINIMAL  — expert / veteran: no coaching; the action is the reward.
 *
 * The level is SEEDED from skill state (a veteran starts at MINIMAL) but is
 * PRIMARILY driven by in-session behavior:
 *   • Competence (de-escalate): an advanced action performed before the spine
 *     coaches it. A successful DEBRIS_CAPTURED before coaching is decisive →
 *     MINIMAL. Otherwise two distinct advanced actions drop one tier.
 *   • Struggle (re-escalate): idle-stall, empty-net click, denied fire, or a
 *     recent failure bumps the level back up one tier (capped by SkillsSystem's
 *     MAX_UNHEEDED_NUDGES so it self-corrects without nagging).
 *
 * A Settings toggle can pin the level (setOverride). Emits
 * Events.GUIDANCE_LEVEL_CHANGED on every transition. GAME_RESET clears
 * in-session state (override persists across reset only if re-applied).
 *
 * @module systems/GuidanceDirector
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

export const GuidanceLevels = Object.freeze({
  GUIDED: 'GUIDED',
  POINTERS: 'POINTERS',
  MINIMAL: 'MINIMAL',
});

const ORDER = [GuidanceLevels.GUIDED, GuidanceLevels.POINTERS, GuidanceLevels.MINIMAL];

export class GuidanceDirector {
  /**
   * @param {object} deps
   * @param {object} [deps.skillsSystem] — for veteran seed (isVeteran)
   * @param {object} [deps.settingsManager] — for the persistent guidance pref
   */
  constructor(deps = {}) {
    this._skills = deps.skillsSystem || null;
    this._settings = deps.settingsManager || null;

    /** @type {string} current level. */
    this._level = this._seedLevel();
    /** @type {string|null} explicit Settings override (pins the level). */
    this._override = null;
    /** @type {boolean} the spine is mid-coaching (gates the "ahead-of-coaching" test). */
    this._coachingActive = false;
    /** @type {Set<string>} distinct competence signals seen before coaching. */
    this._competence = new Set();
    /** @type {boolean} decisive: an unguided capture happened. */
    this._capturedUnguided = false;
    /** @type {boolean} one-shot guard so a competence window steps down once. */
    this._stepDownFired = false;

    this._unsubs = [];
    this._setupListeners();
    this._applySettingsOverride();
  }

  // ─── PUBLIC API ────────────────────────────────────────────────────────

  /** @returns {string} the effective guidance level. */
  getLevel() { return this._override || this._level; }

  isGuided()   { return this.getLevel() === GuidanceLevels.GUIDED; }
  isPointers() { return this.getLevel() === GuidanceLevels.POINTERS; }
  isMinimal()  { return this.getLevel() === GuidanceLevels.MINIMAL; }

  /** Settings toggle: pin a level, or pass null to return to behavior-driven. */
  setOverride(level) {
    if (level !== null && !ORDER.includes(level)) return;
    this._override = level;
    this._emitChange('override');
  }

  /** Mark whether the spine is actively coaching (set by OnboardingDirector). */
  setCoachingActive(on) { this._coachingActive = !!on; }

  // ─── INTERNAL ──────────────────────────────────────────────────────────

  _seedLevel() {
    try {
      if (this._skills && typeof this._skills.isVeteran === 'function' && this._skills.isVeteran()) {
        return GuidanceLevels.MINIMAL;
      }
    } catch (_e) { /* default below */ }
    return GuidanceLevels.GUIDED;
  }

  _setupListeners() {
    const on = (evt, h) => {
      if (!evt) return;
      const u = eventBus.on(evt, h);
      if (typeof u === 'function') this._unsubs.push(u);
    };

    // Competence signals — advanced actions that, performed ahead of coaching,
    // demonstrate the player doesn't need hand-holding.
    const competenceEvents = [
      Events.LASSO_FIRED,
      Events.AUTOPILOT_ENGAGE,
      Events.SCAN_INITIATED,
      Events.ARM_DEPLOYED,
    ];
    for (const e of competenceEvents) {
      on(e, () => this._noteCompetence(e));
    }

    // A successful capture is the decisive opt-out (the returning player's
    // "I've got this"). If it happens while the spine is NOT actively coaching
    // a capture beat, jump straight to MINIMAL.
    on(Events.DEBRIS_CAPTURED, () => {
      if (!this._coachingActive) {
        this._capturedUnguided = true;
        this._setLevel(GuidanceLevels.MINIMAL, 'captured-unguided');
      }
    });

    // Struggle signals — re-escalate one tier (SkillsSystem's unheeded-nudge cap
    // still protects against nagging downstream).
    const struggleEvents = [
      Events.NET_EMPTY_CLICK,
      Events.LASSO_DENIED,
      Events.ARM_CAPTURE_FAILED,
    ];
    for (const e of struggleEvents) {
      on(e, () => this._reEscalate('struggle'));
    }

    if (Events.GAME_RESET) {
      on(Events.GAME_RESET, () => this.reset());
    }

    // Settings toggle: a 'settings'-tagged GUIDANCE_LEVEL_CHANGED pins (or
    // releases, level:null) the override. Ignore our own behavior-driven emits.
    on(Events.GUIDANCE_LEVEL_CHANGED, (d) => {
      if (!d || d.reason !== 'settings') return;
      this._override = d.level || null;
      // Re-emit (non-settings) so consumers see the effective level.
      eventBus.emit(Events.GUIDANCE_LEVEL_CHANGED, { level: this.getLevel(), reason: 'settings-applied' });
    });
  }

  /** @private Apply the persisted Settings guidance preference at startup. */
  _applySettingsOverride() {
    if (!this._settings || typeof this._settings.getGuidance !== 'function') return;
    const pref = this._settings.getGuidance();
    if (pref && pref !== 'auto' && ORDER.includes(pref)) {
      this._override = pref;
    }
  }

  /** Idle-stall escalation hook (called by OnboardingDirector on escalate). */
  noteStall() { this._reEscalate('idle-stall'); }

  _noteCompetence(evtKey) {
    // Only counts as "ahead of coaching" when the spine isn't currently walking
    // the player through this exact action.
    if (this._coachingActive) return;
    this._competence.add(evtKey);
    // Two distinct advanced actions → drop ONE tier (guards single stray press).
    // `_stepDownFired` makes this one-shot per competence window: without it the
    // 3rd and 4th distinct competence events would each re-satisfy `size >= 2`
    // and step down again. A re-escalation (struggle/idle) reopens the window.
    if (this._competence.size >= 2 && !this._capturedUnguided && !this._stepDownFired) {
      this._stepDownFired = true;
      this._stepDown('two-advanced-actions');
    }
  }

  _stepDown(reason) {
    const i = ORDER.indexOf(this._level);
    if (i < ORDER.length - 1) this._setLevel(ORDER[i + 1], reason);
  }

  _reEscalate(reason) {
    // Reopen the competence step-down window: after the player struggles, a
    // fresh pair of advanced actions may legitimately de-escalate again.
    this._stepDownFired = false;
    const i = ORDER.indexOf(this._level);
    if (i > 0) this._setLevel(ORDER[i - 1], reason);
  }

  _setLevel(level, reason) {
    if (level === this._level) return;
    this._level = level;
    if (!this._override) this._emitChange(reason);
  }

  _emitChange(reason) {
    eventBus.emit(Events.GUIDANCE_LEVEL_CHANGED, { level: this.getLevel(), reason });
  }

  reset() {
    this._level = this._seedLevel();
    this._competence.clear();
    this._capturedUnguided = false;
    this._stepDownFired = false;
    this._coachingActive = false;
    // Note: _override is intentionally preserved across GAME_RESET — a player's
    // explicit Settings choice should survive a new game until they change it.
    this._emitChange('reset');
  }

  dispose() {
    for (const u of this._unsubs) { if (typeof u === 'function') u(); }
    this._unsubs.length = 0;
  }
}

export default GuidanceDirector;

// CJS guard for Node-safe tests.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GuidanceDirector, GuidanceLevels };
}
