/**
 * TargetSelector.js — which debris object is selected for arm deployment, plus mass-based auto-tool
 * recommendation (archive/CONTROL_REDESIGN.md §3).
 *
 * @module systems/TargetSelector
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { orbitToSceneCartesian } from '../entities/OrbitalMechanics.js';

export class TargetSelector {
  constructor() {
    /** @type {object|null} Currently selected debris data object */
    this.activeTarget = null;

    /** @type {object} Context from last setTarget call (distanceKm, etc.) */
    this._targetContext = {};

    /** @type {string|null} Current recommended tool: 'lasso'|'spinner'|'weaver'|'trawl' */
    this._recommendedTool = null;

    /** @type {string[]} List of viable tool alternatives for cycling */
    this._toolAlternatives = [];

    /** @type {number} Current index in alternatives list (for backtick cycling) */
    this._toolIndex = 0;

    this._setupListeners();
  }

  /**
   * Set the active target debris.
   * @param {object|null} debris - Debris data from DebrisField, or null to clear
   * @param {object} [context={}] - forwarded into the TARGET_SELECTED event
   */
  setTarget(debris, context = {}) {
    // A piece that was disposed of (let go by a push-down or a drag sail, or broke loose) is never a target: it stays
    // in the sky as a collision object, so Tab, a tap, the autopilot, auto-lock and the N key's aim all end here.
    if (debris && debris._disposed === true) return;
    // Clear the previous target's frozen ΔV when switching
    if (this.activeTarget && this.activeTarget !== debris) {
      delete this.activeTarget.selectedDeltaV;
    }
    this.activeTarget = debris;
    this._targetContext = context;
    if (debris) {
      // Auto-discover on selection so the target shows in the panel
      if (!debris.discovered) {
        debris.discovered = true;
        eventBus.emit(Events.TARGET_DISCOVERED, { target: debris });
      }
      // Freeze ΔV at selection time (Tab, autopilot, HUD click)
      if (context.deltaV !== undefined) {
        debris.selectedDeltaV = context.deltaV;
      }
      eventBus.emit(Events.TARGET_SELECTED, { id: debris.id, type: debris.type, debris, ...context });
    } else {
      this._recommendedTool = null;
      this._toolAlternatives = [];
      this._toolIndex = 0;
      // Forward context so a reset clear (context.silent) can suppress the "target lost" earcon.
      eventBus.emit(Events.TARGET_CLEARED, context);
    }
  }

  /** @returns {object|null} Active debris data object, or null */
  getActiveTarget() {
    return this.activeTarget;
  }

  /**
   * World position of the active target. Prefers the live `_scenePosition` (set every frame by
   * DebrisField._updateInstanceTransform): the SSOT shared with LassoSystem/AutoLock/rendering, equal to the orbit
   * position for normal debris. It also honours the onboarding tease pin (curated pieces at a fixed mother-local
   * offset); reading the orbit would put the reticle off the rendered piece. Falls back to the orbit for targets
   * without a cached scene position (e.g. ISS/satellites).
   * @returns {THREE.Vector3|null}
   */
  getActiveTargetPosition() {
    const t = this.activeTarget;
    if (!t) return null;
    if (t._scenePosition) return t._scenePosition.clone();
    if (!t.orbit) return null;
    const cart = orbitToSceneCartesian(t.orbit);
    if (!cart || !cart.position) return null;
    return cart.position;
  }

  /**
   * Allocation-free getActiveTargetPosition for per-frame callers (the mother-net lead-aim provider polls every aim tick).
   * @param {THREE.Vector3} out — receives the position
   * @returns {THREE.Vector3|null} out, or null when no target/position
   */
  getActiveTargetPositionInto(out) {
    const t = this.activeTarget;
    if (!t) return null;
    if (t._scenePosition) return out.copy(t._scenePosition);
    if (!t.orbit) return null;
    const cart = orbitToSceneCartesian(t.orbit);
    if (!cart || !cart.position) return null;
    return out.copy(cart.position);
  }

  /** Recommend the best capture tool for the active target; runs on TARGET_SELECTED. @private */
  _updateRecommendation() {
    const target = this.activeTarget;
    if (!target) {
      this._recommendedTool = null;
      this._toolAlternatives = [];
      this._toolIndex = 0;
      return;
    }

    const mass = target.mass || 0;
    const TR = Constants.TOOL_RECOMMENDATION;
    const tools = [];

    // Whale band FIRST: above MOTHER_MIN_MASS no daughter tool can take the catch — ArmUnit hard-refuses > 500 kg, the
    // lasso caps at 10 kg and trawl auto-capture at 50 kg — so the mother's Large Net pod is the ONLY legal tool.
    if (mass > (TR.MOTHER_MIN_MASS ?? TR.GRAPPLE_MAX_MASS)) {
      this._recommendedTool = 'mother';
      this._toolAlternatives = ['mother'];
      this._toolIndex = 0;
      eventBus.emit(Events.TOOL_RECOMMENDED, {
        tool: this._recommendedTool,
        alternatives: this._toolAlternatives,
        targetId: target.id,
      });
      return;
    }

    // Viable tools by mass; priority lasso (smallest/cheapest) → spinner → weaver → trawl
    if (mass <= TR.LASSO_MAX_MASS) tools.push('lasso');
    if (mass <= TR.SPINNER_MAX_MASS) tools.push('spinner');
    if (mass > TR.SPINNER_MAX_MASS || mass <= TR.GRAPPLE_MAX_MASS) {
      if (!tools.includes('weaver') && mass >= TR.WEAVER_MIN_MASS) tools.push('weaver');
    }
    if (mass >= TR.WEAVER_MIN_MASS && !tools.includes('weaver')) tools.push('weaver');

    // Smallest effective tool first
    if (tools.length > 0) {
      this._recommendedTool = tools[0];
      this._toolAlternatives = tools;
      this._toolIndex = 0;
    } else {
      // Too heavy for spinner but below weaver min → weaver
      this._recommendedTool = 'weaver';
      this._toolAlternatives = ['weaver'];
      this._toolIndex = 0;
    }

    eventBus.emit(Events.TOOL_RECOMMENDED, {
      tool: this._recommendedTool,
      alternatives: this._toolAlternatives,
      targetId: target.id,
    });
  }

  /** Cycle to the next tool alternative (backtick key). @private */
  _cycleTool() {
    if (this._toolAlternatives.length <= 1) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'V5',
        text: 'No alternative tools available.',
        priority: 'info',
      });
      return;
    }

    this._toolIndex = (this._toolIndex + 1) % this._toolAlternatives.length;
    this._recommendedTool = this._toolAlternatives[this._toolIndex];

    eventBus.emit(Events.TOOL_RECOMMENDED, {
      tool: this._recommendedTool,
      alternatives: this._toolAlternatives,
      targetId: this.activeTarget?.id,
    });

    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'V5',
      text: `Tool: ${this._recommendedTool.toUpperCase()}`,
      priority: 'info',
    });
  }

  /** Per-frame. @param {number} dt - seconds */
  update(dt) {
    // Safety net: clear a removed target (event path is _onDebrisRemoved); also one let go while it was the target
    if (this.activeTarget && (!this.activeTarget.alive || this.activeTarget._disposed === true)) {
      this.clearTarget();
    }
  }

  /** Clear the active target and emit TARGET_CLEARED; use instead of nulling directly (HUD/reticle/audio feedback). */
  clearTarget() {
    if (this.activeTarget) {
      this.setTarget(null);
    }
  }

  /** DEBRIS_REMOVED: clear the target if it matches. @private @param {object} data - { id, type, sizeMeter } */
  _onDebrisRemoved(data) {
    if (this.activeTarget && data && data.id === this.activeTarget.id) {
      // Silent: the target ceasing to EXIST has its own cues (capture ceremony, deorbit visuals). The "target lost"
      // earcon means exactly one thing: lock/selection lost while the target still exists (drift or deselect).
      this.setTarget(null, { silent: true });
    }
  }

  reset() {
    this.activeTarget = null;
    this._targetContext = {};
    this._recommendedTool = null;
    this._toolAlternatives = [];
    this._toolIndex = 0;
  }

  /** @private */
  _setupListeners() {
    eventBus.on(Events.TARGET_SELECTED, () => {
      this._updateRecommendation();
    });

    // T emits TOOL_CYCLE; tool deployment is reached directly via D / N (no smart "focus action" verb).
    eventBus.on(Events.TOOL_CYCLE, () => {
      this._cycleTool();
    });

    eventBus.on(Events.DEBRIS_REMOVED, (data) => this._onDebrisRemoved(data));

    // Clear the active target on NET_BERTHED, silently, and ONLY at berth. NOT from the shared per-frame gate (a
    // `_captured` check there would emit TARGET_CLEARED for every arm/lasso catch, playing the "target lost" earcon
    // and cancelling any running aim coroutine), and NOT before berth or the player loses the survey bounty that
    // auto-fires during the reel.
    eventBus.on(Events.NET_BERTHED, (data) => {
      if (this.activeTarget && data && data.debrisId === this.activeTarget.id) {
        this.setTarget(null, { silent: true });
      }
    });
  }
}

/** Singleton instance (imported by GameFlowManager, AutopilotSystem, etc.) */
export const targetSelector = new TargetSelector();
