/**
 * ArmIdleAdvisor.js — data-driven anti-stuck idle watchdog (Item 3, 2026-06-11).
 *
 * Small Node-safe system (NOT a new engine) that watches each daughter arm's FSM
 * state once per second. When an arm sits in a hint's `state` for ≥ its `idleS`
 * AND the hint's `when` predicate holds, it fires a one-shot guidance hint —
 * routed through Events.TEACHING_MOMENT_FORCE so it surfaces in the same overlay
 * pipeline as other teaching beats. Each hint fires once PER DEPLOYMENT (reset on
 * any state change for that arm). Veterans (SkillsSystem.isVeteran) never see them.
 *
 * The hint table is data in Constants.ARM_IDLE_HINTS (+ ARM_PILOT_IDLE for the
 * pilot-mode case, which is a WASD mode rather than an FSM state).
 *
 * Wire in main.js: construct, init({ armManager, skillsSystem, getPilotMode,
 * getActiveNetForArm }), update(dt).
 *
 * @module systems/ArmIdleAdvisor
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';

const TICK_S = 1.0;   // evaluate at 1 Hz (cheap; matches SkillsSystem cadence)

export class ArmIdleAdvisor {
  constructor() {
    this._armManager = null;
    this._skillsSystem = null;
    this._getPilotMode = null;        // () => string (WASD mode, e.g. 'ARM_PILOT')
    this._getActiveNetForArm = null;  // (index) => net|null
    this._enabled = false;

    this._accum = 0;
    /** Per-arm idle bookkeeping keyed by armId: { state, idleS, firedThisDeploy:Set } */
    this._armState = new Map();
    /** ARM_PILOT idle accumulator + once-per-pilot-session fired flag. */
    this._pilotIdleS = 0;
    this._pilotFired = false;
    this._wasPiloting = false;
  }

  /**
   * @param {object} deps
   * @param {object} deps.armManager — exposes `.arms` (array of ArmUnit-likes)
   * @param {object} [deps.skillsSystem] — exposes isVeteran()
   * @param {Function} [deps.getPilotMode] — returns the current WASD control mode
   * @param {Function} [deps.getActiveNetForArm] — (index) => active net or null
   */
  init({ armManager, skillsSystem = null, getPilotMode = null, getActiveNetForArm = null } = {}) {
    this._armManager = armManager || null;
    this._skillsSystem = skillsSystem;
    this._getPilotMode = getPilotMode;
    this._getActiveNetForArm = getActiveNetForArm;
    this._enabled = !!armManager;
  }

  dispose() {
    this._enabled = false;
    this._armState.clear();
  }

  _isVeteran() {
    return !!(this._skillsSystem && typeof this._skillsSystem.isVeteran === 'function'
      && this._skillsSystem.isVeteran());
  }

  /** Net count for an arm (0 if unknown). */
  _netCount(arm) {
    if (typeof arm.getNetInventory === 'function') return arm.getNetInventory();
    if (typeof arm._netInventory === 'number') return arm._netInventory;
    return 0;
  }

  /** Is there a net currently in flight for this arm? */
  _netInFlight(arm) {
    if (arm._firedNet) return true;
    if (this._getActiveNetForArm && arm.index != null) {
      return !!this._getActiveNetForArm(arm.index);
    }
    return false;
  }

  /** Evaluate a hint's `when` predicate against an arm. */
  _predicateHolds(when, arm) {
    switch (when) {
      case 'noNetInFlightHasNets':
        return !this._netInFlight(arm) && this._netCount(arm) > 0;
      case 'outOfNets':
        return this._netCount(arm) <= 0;
      case 'always':
      default:
        return true;
    }
  }

  _fire(hintId, title, text, icon) {
    eventBus.emit(Events.TEACHING_MOMENT_FORCE, {
      id: hintId,
      title: title || 'HINT',
      body: text || '',
      icon: icon || '💡',
      _postOnboarding: true,
    });
  }

  /**
   * @param {number} dt — real seconds
   */
  update(dt) {
    if (!this._enabled || !this._armManager) return;
    this._accum += dt;
    if (this._accum < TICK_S) return;
    const step = this._accum;
    this._accum = 0;

    // Veterans never see idle hints — skip the whole pass.
    if (this._isVeteran()) {
      // Still track state so a player who crosses the veteran threshold mid-game
      // doesn't get a stale burst later; cheap to keep maps fresh.
      this._refreshStateOnly();
      return;
    }

    const hints = Constants.ARM_IDLE_HINTS || [];
    const arms = this._armManager.arms || [];

    for (const arm of arms) {
      if (!arm || !arm.id) continue;
      let rec = this._armState.get(arm.id);
      if (!rec) {
        rec = { state: arm.state, idleS: 0, fired: new Set() };
        this._armState.set(arm.id, rec);
      }
      // State change → reset idle timer + per-deployment fired set.
      if (rec.state !== arm.state) {
        rec.state = arm.state;
        rec.idleS = 0;
        rec.fired.clear();
      } else {
        rec.idleS += step;
      }

      for (const hint of hints) {
        if (hint.state !== arm.state) continue;
        if (rec.idleS < hint.idleS) continue;
        if (rec.fired.has(hint.hintId)) continue;
        if (!this._predicateHolds(hint.when, arm)) continue;
        rec.fired.add(hint.hintId);
        this._fire(hint.hintId, hint.title, hint.text, hint.icon);
      }
    }

    // ARM_PILOT mode idle (a WASD control mode, not an FSM state).
    const pilotCfg = Constants.ARM_PILOT_IDLE;
    const mode = this._getPilotMode ? this._getPilotMode() : null;
    const piloting = mode === 'ARM_PILOT';
    if (piloting && pilotCfg) {
      if (!this._wasPiloting) { this._pilotIdleS = 0; this._pilotFired = false; }
      this._pilotIdleS += step;
      if (!this._pilotFired && this._pilotIdleS >= pilotCfg.idleS) {
        this._pilotFired = true;
        this._fire(pilotCfg.hintId, pilotCfg.title, pilotCfg.text, pilotCfg.icon);
      }
    } else {
      this._pilotIdleS = 0;
      this._pilotFired = false;
    }
    this._wasPiloting = piloting;
  }

  /** @private Keep per-arm state fresh without firing (veteran path). */
  _refreshStateOnly() {
    const arms = this._armManager.arms || [];
    for (const arm of arms) {
      if (!arm || !arm.id) continue;
      let rec = this._armState.get(arm.id);
      if (!rec) { rec = { state: arm.state, idleS: 0, fired: new Set() }; this._armState.set(arm.id, rec); }
      if (rec.state !== arm.state) { rec.state = arm.state; rec.idleS = 0; rec.fired.clear(); }
    }
  }
}

export const armIdleAdvisor = new ArmIdleAdvisor();
