/**
 * @module systems/ArmIdleAdvisor — data-driven anti-stuck idle watchdog.
 *
 * Small Node-safe system (NOT a new engine) that watches each daughter arm's FSM state once per second. When an arm
 * sits in a hint's `state` for ≥ its `idleS` AND the hint's `when` predicate holds, it fires a one-shot guidance hint,
 * posted as a one-line step chip in the hint ticker. Each hint fires once PER DEPLOYMENT (reset on any state change
 * for that arm). Veterans (SkillsSystem.isVeteran) never see them.
 *
 * The hint table is data in Constants.ARM_IDLE_HINTS (+ ARM_PILOT_IDLE for the pilot-mode case, which is a WASD mode
 * rather than an FSM state).
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { wordsFor } from './resupplyWords.js';
import { nWorksFor, flyDigitFor } from './netRouting.js';

const FLY_THEN_N_CHIP = 'Fly her, then N';   // her tool chip when N would not work her (cap = her number key)
const TICK_S = 1.0;   // evaluate at 1 Hz (cheap; matches SkillsSystem cadence)

export class ArmIdleAdvisor {
  constructor() {
    this._armManager = null;
    this._skillsSystem = null;
    this._getPilotMode = null;        // () => string (WASD mode, e.g. 'ARM_PILOT')
    this._getActiveNetForArm = null;  // (index) => net|null
    this._isPiloted = null;           // (arm) => bool: is HE flying her now (her digit would then exit pilot mode, not fly her)
    this._nWorks = null;              // (arm) => bool: does N work HER tool now (InputManager.nWorksDaughter); null = netRouting's registry
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
   * @param {Function} [deps.isPiloted] — (arm) => true when he is flying her now ("Fly her" is not said then)
   * @param {Function} [deps.nWorks] — (arm) => true when N works her tool right now; default: the
   *   resolver registered in netRouting (true when none), so a chip never names a key that goes to the mother or another daughter
   */
  init({ armManager, skillsSystem = null, getPilotMode = null, getActiveNetForArm = null, nWorks = null, isPiloted = null } = {}) {
    this._armManager = armManager || null;
    this._skillsSystem = skillsSystem;
    this._getPilotMode = getPilotMode;
    this._getActiveNetForArm = getActiveNetForArm;
    this._nWorks = typeof nWorks === 'function' ? nWorks : null;
    this._isPiloted = typeof isPiloted === 'function' ? isPiloted : null;
    this._enabled = !!armManager;
  }

  dispose() {
    this._enabled = false;
    this._armState.clear();
  }

  _nWorksFor(arm) {
    if (this._nWorks) { try { return this._nWorks(arm) !== false; } catch (_e) { return true; } }
    return nWorksFor(arm);
  }

  _isVeteran() {
    return !!(this._skillsSystem && typeof this._skillsSystem.isVeteran === 'function'
      && this._skillsSystem.isVeteran());
  }

  _netCount(arm) {
    if (typeof arm.getNetInventory === 'function') return arm.getNetInventory();
    if (typeof arm._netInventory === 'number') return arm._netInventory;
    return 0;
  }

  _netInFlight(arm) {
    if (arm._firedNet) return true;
    if (this._getActiveNetForArm && arm.index != null) {
      return !!this._getActiveNetForArm(arm.index);
    }
    return false;
  }

  _predicateHolds(when, arm) {
    switch (when) {
      case 'noNetInFlightHasNets':
        return !this._netInFlight(arm) && this._netCount(arm) > 0;
      case 'noNetInFlight':
        return !this._netInFlight(arm);
      case 'outOfNets':
        return this._netCount(arm) <= 0;
      case 'always':
      default:
        return true;
    }
  }

  /**
   * The coach sentence is a STEP CHIP in the ticker (cap = the key, body <= 5 words), not a card over the score strip.
   * Entries without a `chip` keep the old TEACHING_MOMENT_FORCE card (none today).
   */
  _fire(hintId, title, text, icon, chip, glyph, keys) {
    text = wordsFor(text); chip = wordsFor(chip);   // "resupply stop" / "the stop" -> "satellite" with the map on
    if (chip) {
      eventBus.emit(Events.HINT_POSTED, {
        id: hintId,
        text: chip,
        glyph: glyph || '',
        keys: Array.isArray(keys) ? keys : [],
        duration: Constants.ONBOARDING?.DEFAULT_HINT_MS || 12000,
        priority: 'normal',
        step: true,
        // On glass a step button that is up (her tool's button, TouchActionChip) is the same instruction in the true
        // word; this text waits behind it instead of covering it for 12 s (HintTicker).
        yieldToButton: true,
        _postOnboarding: true,
      });
      return;
    }
    eventBus.emit(Events.TEACHING_MOMENT_FORCE, {
      id: hintId,
      title: title || 'HINT',
      body: text || '',
      icon: icon || 'HINT',
      _postOnboarding: true,
    });
  }

  /** @param {number} dt — real seconds */
  update(dt) {
    if (!this._enabled || !this._armManager) return;
    this._accum += dt;
    if (this._accum < TICK_S) return;
    const step = this._accum;
    this._accum = 0;

    if (this._isVeteran()) {
      // Still track state so a player who crosses the veteran threshold mid-game doesn't get a stale burst later.
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
      if (rec.state !== arm.state) {
        rec.state = arm.state;
        rec.idleS = 0;
        rec.fired.clear();
      } else {
        rec.idleS += step;
      }

      for (const hint of hints) {
        if (hint.state !== arm.state) continue;
        // A tool row speaks only for the tool she is holding (the pad is the default; N works the selected tool)
        if (hint.tool && (arm.selectedTool || 'NET') !== hint.tool) continue;
        if (rec.idleS < hint.idleS) continue;
        if (rec.fired.has(hint.hintId)) continue;
        if (!this._predicateHolds(hint.when, arm)) continue;
        // A chip that says her number key ("Fly her") is not said while he is flying her: that digit would take him
        // back to the ship. Not marked fired: it may still say it if he lets go while she is in flight.
        if (Array.isArray(hint.keys) && hint.keys.includes('Digit1') && this._isPiloted && this._isPiloted(arm)) continue;
        rec.fired.add(hint.hintId);
        // owner 2026-10-26: a tool chip names N only when N works HER now; else it names her number key. Picked at the
        // moment it fires, so the key is true when it is shown.
        if (Array.isArray(hint.keys) && hint.keys.includes('KeyN') && !this._nWorksFor(arm)) {
          const n = arm.index != null && Number.isInteger(arm.index) ? arm.index + 1 : flyDigitFor(arm);
          if (n) {
            this._fire(hint.hintId, hint.title, hint.text, hint.icon, FLY_THEN_N_CHIP, String(n), ['Digit' + n]);
            continue;
          }
        }
        this._fire(hint.hintId, hint.title, hint.text, hint.icon, hint.chip, hint.glyph, hint.keys);
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
        this._fire(pilotCfg.hintId, pilotCfg.title, pilotCfg.text, pilotCfg.icon, pilotCfg.chip, pilotCfg.glyph, pilotCfg.keys);
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
