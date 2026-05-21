/**
 * TargetSelector.js — Target selection, tracking, and auto-tool recommendation
 * Manages which debris object is currently selected for arm deployment.
 * Provides MW2-style auto-tool recommendation based on target mass (CONTROL_REDESIGN §3).
 *
 * Extracted from InteractionSystem.js (Session 5 cleanup — dead tool framework removed).
 * Active scan + tool recommendation added in Control Redesign sprint.
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

    // === Auto-Tool Recommendation State ===
    /** @type {string|null} Current recommended tool: 'lasso'|'spinner'|'weaver'|'trawl' */
    this._recommendedTool = null;

    /** @type {string[]} List of viable tool alternatives for cycling */
    this._toolAlternatives = [];

    /** @type {number} Current index in alternatives list (for backtick cycling) */
    this._toolIndex = 0;

    this._setupListeners();
  }

  // ======================================================================
  // TARGET MANAGEMENT
  // ======================================================================

  /**
   * Set the active target debris.
   * @param {object|null} debris - Debris data from DebrisField, or null to clear
   * @param {object} [context={}] - Optional extra data forwarded into TARGET_SELECTED event
   */
  setTarget(debris, context = {}) {
    // UX-3 #1: Clear previous target's frozen ΔV when switching targets
    if (this.activeTarget && this.activeTarget !== debris) {
      delete this.activeTarget.selectedDeltaV;
    }
    this.activeTarget = debris;
    this._targetContext = context;
    if (debris) {
      console.log('[AUTO-TARGET] TargetSelector.setTarget: id=%s type=%s alive=%s', debris.id, debris.type, debris.alive);
      // UX-3 #9: Auto-discover on selection (ensures selected target shows in panel)
      if (!debris.discovered) {
        debris.discovered = true;
        eventBus.emit(Events.TARGET_DISCOVERED, { target: debris });
      }
      // UX-3 #1: Freeze ΔV at selection time (Tab, autopilot, HUD click)
      if (context.deltaV !== undefined) {
        debris.selectedDeltaV = context.deltaV;
      }
      eventBus.emit(Events.TARGET_SELECTED, { id: debris.id, type: debris.type, debris, ...context });
    } else {
      console.log('[AUTO-TARGET] TargetSelector.setTarget: clearing target (null)');
      this._recommendedTool = null;
      this._toolAlternatives = [];
      this._toolIndex = 0;
      eventBus.emit(Events.TARGET_CLEARED);
    }
  }

  /**
   * Get the currently selected target.
   * @returns {object|null} Active debris data object, or null
   */
  getActiveTarget() {
    return this.activeTarget;
  }

  /**
   * Get world position of the active target.
   * @returns {THREE.Vector3|null}
   */
  getActiveTargetPosition() {
    if (!this.activeTarget || !this.activeTarget.orbit) return null;
    const cart = orbitToSceneCartesian(this.activeTarget.orbit);
    if (!cart || !cart.position) return null;
    return cart.position;
  }

  // ======================================================================
  // AUTO-TOOL RECOMMENDATION (CONTROL_REDESIGN §3)
  // ======================================================================

  /**
   * Evaluate the active target and recommend the best capture tool.
   * Called automatically on TARGET_SELECTED.
   * @private
   */
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

    // Build list of viable tools based on mass thresholds
    // Priority order: lasso (smallest/cheapest) → spinner → weaver → trawl
    if (mass <= TR.LASSO_MAX_MASS) tools.push('lasso');
    if (mass <= TR.SPINNER_MAX_MASS) tools.push('spinner');
    if (mass > TR.SPINNER_MAX_MASS || mass <= TR.GRAPPLE_MAX_MASS) {
      // Weaver for medium-to-large debris
      if (!tools.includes('weaver') && mass >= TR.WEAVER_MIN_MASS) tools.push('weaver');
    }
    if (mass >= TR.WEAVER_MIN_MASS && !tools.includes('weaver')) tools.push('weaver');

    // Pick best recommendation (smallest effective tool first = most efficient)
    if (tools.length > 0) {
      this._recommendedTool = tools[0];
      this._toolAlternatives = tools;
      this._toolIndex = 0;
    } else {
      // Fallback: weaver for anything too heavy for spinner but below weaver min
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

  /**
   * Cycle to the next tool alternative (backtick key).
   * @private
   */
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

  /**
   * Deploy the currently recommended tool (D key).
   * Routes to the appropriate system via EventBus events.
   * @private
   */
  _deployRecommended() {
    if (!this.activeTarget) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'V5',
        text: 'No target selected — press TAB first.',
        priority: 'warning',
      });
      return;
    }

    if (!this._recommendedTool) {
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'V5',
        text: 'No tool recommended — press TAB to select a target.',
        priority: 'warning',
      });
      return;
    }

    const tool = this._recommendedTool;
    const target = this.activeTarget;

    switch (tool) {
      case 'lasso':
        // Lasso firing requires player position + debrisField refs held by InputManager.
        // Emit guidance — Space key fires lasso directly.
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'V5',
          text: 'Lasso selected — press Space to fire.',
          priority: 'info',
        });
        return; // Don't emit the deploy message below

      case 'trawl':
        eventBus.emit(Events.TRAWL_START);
        break;

      case 'spinner':
        // ARM_DEPLOY_TO: ArmManager picks best available spinner arm
        eventBus.emit(Events.ARM_DEPLOY_TO, { target, preferType: 'spinner' });
        break;

      case 'weaver':
        // ARM_DEPLOY_TO: ArmManager picks best available weaver arm
        eventBus.emit(Events.ARM_DEPLOY_TO, { target, preferType: 'weaver' });
        break;

      default:
        // Fallback: deploy any available arm
        eventBus.emit(Events.ARM_DEPLOY_TO, { target, preferType: null });
        break;
    }

    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'V5',
      text: `Deploying ${tool}...`,
      priority: 'info',
    });
  }

  // ======================================================================
  // FOCUS ACTION (F KEY — CONTROL_REDESIGN §5)
  // ======================================================================

  /**
   * Context-sensitive smart action.
   * Priority chain:
   *   1. No target selected → prompt player to Tab-select
   *   2. Has target → deploy recommended tool
   *      (arm/lasso systems handle range validation and emit feedback)
   * @private
   */
  _handleFocusAction() {
    if (!this.activeTarget) {
      // No target — guide the player
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'V5',
        text: 'No target — press [Tab] to select.',
        priority: 'info',
      });
      return;
    }

    // Has target — deploy recommended tool (systems handle range checks)
    this._deployRecommended();
  }

  // ======================================================================
  // LIFECYCLE
  // ======================================================================

  /**
   * Per-frame update. Checks if target is still alive.
   * @param {number} dt - Delta time
   */
  update(dt) {
    // Safety-net: clear target if it's been removed (event-driven path is _onDebrisRemoved)
    if (this.activeTarget && !this.activeTarget.alive) {
      this.clearTarget();
    }
  }

  /**
   * Clear the active target and emit TARGET_CLEARED.
   * Preferred over directly nulling — gives HUD/reticle/audio proper feedback.
   */
  clearTarget() {
    if (this.activeTarget) {
      this.setTarget(null);
    }
  }

  /**
   * Handle DEBRIS_REMOVED event — clear target if it matches.
   * @private
   * @param {object} data - { id, type, sizeMeter }
   */
  _onDebrisRemoved(data) {
    if (this.activeTarget && data && data.id === this.activeTarget.id) {
      console.log('[AUTO-TARGET] TargetSelector._onDebrisRemoved: clearing target id=%s (matches removed debris)', data.id);
      this.clearTarget();
    }
  }

  /**
   * Reset to no target.
   */
  reset() {
    this.activeTarget = null;
    this._targetContext = {};
    this._recommendedTool = null;
    this._toolAlternatives = [];
    this._toolIndex = 0;
  }

  // ======================================================================
  // EVENT LISTENERS
  // ======================================================================

  /** @private */
  _setupListeners() {
    // Re-evaluate tool recommendation whenever a new target is selected
    eventBus.on(Events.TARGET_SELECTED, () => {
      this._updateRecommendation();
    });

    // D key → deploy recommended tool
    eventBus.on(Events.TOOL_DEPLOY, () => {
      this._deployRecommended();
    });

    // Backtick → cycle through tool alternatives
    eventBus.on(Events.TOOL_CYCLE, () => {
      this._cycleTool();
    });

    // F key (normal mode) → context-sensitive smart action
    eventBus.on(Events.FOCUS_ACTION, () => {
      this._handleFocusAction();
    });

    // Event-driven cleanup: clear target when its debris is removed
    eventBus.on(Events.DEBRIS_REMOVED, (data) => this._onDebrisRemoved(data));
  }
}

/** Singleton instance (imported by GameFlowManager, AutopilotSystem, etc.) */
export const targetSelector = new TargetSelector();
