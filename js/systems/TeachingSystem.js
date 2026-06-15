/**
 * TeachingSystem.js — First-encounter contextual overlay manager (ST-6.5)
 *
 * Listens for game events, determines if a teaching moment should fire,
 * manages "seen" persistence, and delegates display to TeachingOverlay.
 *
 * Design philosophy (from LEARNING_THROUGH_PLAY.md):
 *   "No tutorials. The game teaches through contextual overlays that appear
 *    exactly once when the player first encounters each mechanic. Brief,
 *    non-blocking, and dismissible."
 *
 * @module systems/TeachingSystem
 */

import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';

// ============================================================================
// TEACHING MOMENT DEFINITIONS
// ============================================================================

/**
 * All 19 teaching moments. Each defines:
 *   id       — unique key, also used in persistence
 *   title    — overlay heading (SHORT, caps)
 *   body     — overlay body text (1-2 sentences)
 *   duration — display time in ms
 *   icon     — Unicode symbol for visual flair
 */
export const TEACHING_MOMENTS = [
  {
    id: 'first_target',
    title: 'Target Acquired',
    body: 'Press A to autopilot toward it, or deploy a daughter with D. Match your approach to the debris type.',
    duration: 8000,
    icon: '🎯',
  },
  {
    id: 'first_arm',
    title: 'Daughter Deployed',
    body: 'Hold steady. The daughter needs time to reach the target. Watch the tether tension gauge.',
    duration: 7000,
    icon: '🦾',
  },
  {
    id: 'first_capture',
    title: 'First Catch!',
    body: 'Nice work, Cowboy. Captured debris goes to your cargo bay. Open the Codex (L) to learn more.',
    duration: 8000,
    icon: '✅',
  },
  {
    id: 'first_conjunction',
    title: 'Conjunction Warning',
    body: 'A "conjunction" means two objects are about to pass dangerously close. Your Collision Avoidance system will suggest a dodge burn if you need one.',
    duration: 7000,
    icon: '⚠️',
  },
  {
    id: 'first_weather',
    title: 'Space Weather',
    body: 'Solar activity detected. Watch your power levels. Panels may degrade during storms.',
    duration: 8000,
    icon: '☀️',
  },
  {
    id: 'first_shop',
    title: 'The Workshop',
    body: 'Spend resources to upgrade your satellite. TRL badges (Technology Readiness Level) show how proven each upgrade is.',
    duration: 7000,
    icon: '🏪',
  },
  {
    id: 'first_codex',
    title: 'Mission Intel',
    body: 'The Codex catalogues everything you\'ve encountered. Knowledge is half the battle.',
    duration: 7000,
    icon: '📖',
  },
  {
    id: 'first_burn',
    title: 'Manual Burn',
    body: 'Thrusting changes your orbit. Watch the MFD (Multi-Function Display). Your orbit\'s high point (apoapsis) and low point (periapsis) shift in real time.',
    duration: 7000,
    icon: '🔥',
  },
  {
    id: 'first_kessler',
    title: 'Kessler Cascade',
    body: 'A collision just spawned new debris. That\'s the start of a Kessler cascade, where wreckage breeds more wreckage. Clear the field faster before it snowballs.',
    duration: 8000,
    icon: '💥',
  },
  {
    id: 'first_autopilot',
    title: 'Autopilot Active',
    body: 'The computer will handle orbital adjustments. Override anytime with manual thrust.',
    duration: 7000,
    icon: '🤖',
  },
  {
    id: 'first_lasso',
    title: 'Net Deployed',
    body: 'The capture net has a wide radius but needs momentum. Aim ahead of the target.',
    duration: 7000,
    icon: '🪢',
  },
  {
    id: 'first_active_sat_warning',
    title: 'Protected Asset',
    body: 'Active satellites are off-limits. Houston monitors all asset interactions.',
    duration: 8000,
    icon: '🛡️',
  },
  {
    id: 'first_safe_mode',
    title: 'Safe Mode',
    body: 'Too many systems are critical, so the ship locked your daughters to protect itself. Repair until they\'re above 40% to get them back.',
    duration: 8000,
    icon: '🔒',
  },
  {
    id: 'first_radiation',
    title: 'Radiation Belt',
    body: 'You\'re crossing the Van Allen belt. A band of trapped radiation around Earth. Expect sensor static and laggy comms; don\'t linger.',
    duration: 8000,
    icon: '☢️',
  },
  {
    id: 'first_strategic_map',
    title: 'Strategic Overview',
    body: 'The strategic map shows your full orbital environment. Drag to rotate, scroll to zoom. Plan your next approach.',
    duration: 8000,
    icon: '🗺️',
  },
  // UX-3 N1: Scan & arm deploy teaching moments
  {
    id: 'first_scan',
    title: 'Quick Scan',
    body: 'Quick Scan reveals nearby debris. Press Shift+S for a Wide Scan to find targets at longer range.',
    duration: 7000,
    icon: '📡',
  },
  {
    id: 'first_arm_deploy',
    title: 'Daughter Launched',
    body: 'Daughters capture heavier targets at longer range. Press 1-4 to pilot a launched daughter. Manual captures earn 2× score.',
    duration: 8000,
    icon: '🛰️',
  },
  // Capture-failure guidance (recoverable vs catastrophic)
  {
    id: 'first_net_failed',
    title: 'Net Slipped',
    body: 'The net lost its grip. Too heavy, or the debris was wider than the net mouth. The catch is fine: it\'s drifting free again. Your daughter keeps her tether and heads home to reload. Re-net it to try again (a bigger net helps for large debris).',
    duration: 9000,
    icon: '🪢',
  },
  {
    id: 'first_tether_snap',
    title: 'Tether Severed',
    body: 'The tether snapped under reel load. That daughter and her catch are cut loose and drifting, and that line can\'t be reloaded. Launch another daughter (D) to chase the catch down, and upgrade your tether in the Workshop to haul heavier loads safely.',
    duration: 10000,
    icon: '⚠️',
  },
  // Phase 0.6 (capture-feedback overhaul): proactive de-spin teaching —
  // close the "see odds → pull lever → odds climb" loop before the first
  // wasted net on a fast spinner.
  {
    id: 'first_high_tumble_target',
    title: 'Fast Spinner',
    body: 'That target is tumbling fast. Nets slip off fast spinners. Hold H to fire the de-spin laser; watch the capture odds climb as the tumble bleeds off, then net it.',
    duration: 9000,
    icon: '🌀',
  },
  {
    id: 'first_despin_in_spec',
    title: 'Tumble In Spec',
    body: 'Tumble in spec. Odds restored. This works on any spinner.',
    duration: 7000,
    icon: '✅',
  },
  // Phase 1.5 (capture-feedback overhaul): the dossier "chest opens".
  {
    id: 'first_detail_scan',
    title: 'Full Profile',
    body: 'Close-range survey complete. Full structural profile and salvage appraisal. Survey before you commit: brittleness drives fragmentation risk, and appraisal tells you what it\'s worth.',
    duration: 9000,
    icon: '📋',
  },
  // Phase 2 (capture-feedback overhaul): orientation-based capture.
  {
    id: 'first_aspect_target',
    title: 'Too Wide Broadside',
    body: 'Too wide broadside. But the net can swallow it lengthwise. De-spin it, then orbit around until the readout says END-ON.',
    duration: 9000,
    icon: '↔️',
  },
  // Phase 3b (capture-feedback overhaul): fragmentation consequences.
  {
    id: 'first_fragmentation',
    title: 'Fragmentation',
    body: 'The impact broke the debris into new tracked fragments. Wreckage breeds wreckage. First one\'s on the house; avoid it with a slow approach, CINCH mode, or the pad for fragile pieces.',
    duration: 10000,
    icon: '💥',
  },
];

/** Map of moment ID → moment definition for O(1) lookup */
export const MOMENTS_BY_ID = new Map(TEACHING_MOMENTS.map(m => [m.id, m]));

// ============================================================================
// TEACHING SYSTEM CLASS
// ============================================================================

export class TeachingSystem {
  /**
   * @param {object} eventBus — EventBus instance (on/off/emit)
   * @param {object} [persistenceManager] — optional PersistenceManager for localStorage
   */
  constructor(eventBus, persistenceManager) {
    this._eventBus = eventBus;
    this._pm = persistenceManager || null;
    this._seen = new Set();
    this._unsubs = [];
    this._disposed = false;

    /** Callback set by the wiring layer to display a moment. */
    this.onShow = null;

    // --- CP-4 §4: 3-layer arbitration (queue / drain / collision rule) ---
    /** @type {object|null} SkillsSystem ref for the universal hint-gating rule + veteran downgrade. */
    this._skillsSystem = null;
    /** @type {Array<object>} moments deferred while a blocking surface is on screen. */
    this._queue = [];
    /** @type {Set<string>} active blocking surfaces (radial menu / deploy ceremony). */
    this._blockers = new Set();
    /** @type {boolean} OnboardingDirector is running (tier 0 — Director owns the screen). */
    this._onboardingActive = false;
    /** @type {object|null} the MissionCoach beat currently owning the screen ({ skillId }). */
    this._activeCoachBeat = null;
    /** @type {number} seconds until the next queued overlay may drain (≤1 per interval). */
    this._drainTimer = 0;

    // Load persisted seen-set
    this._loadSeen();
  }

  /**
   * Inject the SkillsSystem so overlays obey the universal hint-gating rule and
   * the veteran downgrade (GUIDANCE_ARBITER_SPEC §3 / §3.1). Optional.
   * @param {object} skillsSystem
   */
  setSkillsSystem(skillsSystem) {
    this._skillsSystem = skillsSystem || null;
  }

  // --------------------------------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------------------------------

  /**
   * Subscribe to all trigger events.
   * Must be called after construction and after onShow is wired.
   */
  init() {
    if (this._disposed) return;

    const eb = this._eventBus;
    if (!eb) return;

    // Helper: subscribe + track for dispose
    const on = (evt, handler) => {
      const unsub = eb.on(evt, handler);
      if (typeof unsub === 'function') {
        this._unsubs.push(unsub);
      } else {
        // fallback: store event+handler pair for manual off()
        this._unsubs.push({ evt, handler });
      }
    };

    // 1. first_target — TARGET_SELECTED
    on(Events.TARGET_SELECTED, () => this._trigger('first_target'));

    // 2. first_arm — ARM_DEPLOYED
    on(Events.ARM_DEPLOYED, () => this._trigger('first_arm'));

    // 3. first_capture — DEBRIS_CAPTURED
    on(Events.DEBRIS_CAPTURED, () => this._trigger('first_capture'));

    // 4 & 12. first_conjunction / first_active_sat_warning — CONJUNCTION_ALERT
    on(Events.CONJUNCTION_ALERT, (data) => {
      if (data && data.reason === 'ACTIVE_SAT_ARMING') {
        this._trigger('first_active_sat_warning');
      } else if (data && (data.severity === 'HI' || data.severity === 'MD')) {
        this._trigger('first_conjunction');
      }
    });

    // 5. first_weather — WEATHER_EFFECT_START
    on(Events.WEATHER_EFFECT_START, () => this._trigger('first_weather'));

    // 6. first_shop — SHOP_OPENED
    on(Events.SHOP_OPENED, () => this._trigger('first_shop'));

    // 7. first_codex — CODEX_OPENED
    on(Events.CODEX_OPENED, () => this._trigger('first_codex'));

    // 8. first_burn — THROTTLE_CHANGE with level > 0
    on(Events.THROTTLE_CHANGE, (data) => {
      if (data && data.level > 0) {
        this._trigger('first_burn');
      }
    });

    // 9. first_kessler — KESSLER_CASCADE
    on(Events.KESSLER_CASCADE, () => this._trigger('first_kessler'));

    // 10. first_autopilot — AUTOPILOT_ENGAGE
    on(Events.AUTOPILOT_ENGAGE, () => this._trigger('first_autopilot'));

    // 11. first_lasso — LASSO_FIRED
    on(Events.LASSO_FIRED, () => this._trigger('first_lasso'));

    // 13. first_safe_mode — SAFE_MODE_ENTERED (ST-6.7)
    if (Events.SAFE_MODE_ENTERED) {
      on(Events.SAFE_MODE_ENTERED, () => this._trigger('first_safe_mode'));
    }

    // 14. first_radiation — ENVIRONMENT_EFFECT with type 'radiation_belt' (ST-6.7)
    if (Events.ENVIRONMENT_EFFECT) {
      on(Events.ENVIRONMENT_EFFECT, (data) => {
        if (data && data.type === 'radiation_belt' && data.inBelt === true) {
          this._trigger('first_radiation');
        }
      });
    }

    // 15. first_strategic_map — STRATEGIC_MAP_OPENED (ST-6.4)
    if (Events.STRATEGIC_MAP_OPENED) {
      on(Events.STRATEGIC_MAP_OPENED, () => this._trigger('first_strategic_map'));
    }

    // 16. first_scan — SCAN_INITIATED (UX-3 N1)
    on(Events.SCAN_INITIATED, () => this._trigger('first_scan'));

    // 17. first_arm_deploy — ARM_DEPLOYED (UX-3 N1)
    on(Events.ARM_DEPLOYED, () => this._trigger('first_arm_deploy'));

    // 18. first_net_failed — NET_FAILED (recoverable net-integrity loss)
    if (Events.NET_FAILED) {
      on(Events.NET_FAILED, () => this._trigger('first_net_failed'));
    }

    // 19. first_tether_snap — TETHER_SNAP (catastrophic line break)
    if (Events.TETHER_SNAP) {
      on(Events.TETHER_SNAP, () => this._trigger('first_tether_snap'));
    }

    // 20. first_high_tumble_target — TARGET_SELECTED with tumble above the
    // net-safe spin (Phase 0.6). Gated on LASER_DESPIN so we never teach a
    // verb (hold H) that isn't wired in.
    on(Events.TARGET_SELECTED, (data) => {
      const debris = data && data.debris;
      if (!debris || typeof debris.tumbleRate !== 'number') return;
      if (Constants.isFeatureEnabled && !Constants.isFeatureEnabled('LASER_DESPIN')) return;
      const inSpecDeg = (Constants.NET_TUMBLE_PENALTY && Constants.NET_TUMBLE_PENALTY.IN_SPEC_DEG) || 10;
      const tumbleDeg = Math.abs(debris.tumbleRate) * (180 / Math.PI);
      if (tumbleDeg > inSpecDeg) this._trigger('first_high_tumble_target');
    });

    // 21. first_despin_in_spec — DESPIN_IN_SPEC (Phase 0.6: confirm the loop).
    if (Events.DESPIN_IN_SPEC) {
      on(Events.DESPIN_IN_SPEC, () => this._trigger('first_despin_in_spec'));
    }

    // 22. first_detail_scan — DEBRIS_PROFILED (Phase 1.5: the chest opens).
    if (Events.DEBRIS_PROFILED) {
      on(Events.DEBRIS_PROFILED, () => this._trigger('first_detail_scan'));
    }

    // 23. first_aspect_target — TARGET_SELECTED on an elongated body that only
    // fits the daughter net end-on (Phase 2). Gated on ASPECT_CAPTURE.
    on(Events.TARGET_SELECTED, (data) => {
      const debris = data && data.debris;
      if (!debris) return;
      if (Constants.isFeatureEnabled && !Constants.isFeatureEnabled('ASPECT_CAPTURE')) return;
      const lengthM = (debris.lengthM != null) ? debris.lengthM : (debris.sizeMeter || 0);
      const widthM = (debris.widthM != null) ? debris.widthM : (debris.sizeMeter || 0);
      const dia = (Constants.CAPTURE_NET && Constants.CAPTURE_NET.MEDIUM
        && Constants.CAPTURE_NET.MEDIUM.DIAMETER) || 5;
      if (lengthM > dia && widthM <= dia && lengthM > widthM) {
        this._trigger('first_aspect_target');
      }
    });

    // 24. first_fragmentation — NET_FRAGMENTATION (Phase 3b: mercy + avoidance).
    if (Events.NET_FRAGMENTATION) {
      on(Events.NET_FRAGMENTATION, () => this._trigger('first_fragmentation'));
    }

    // Delegation 2 (2026-05-31): Force-injection channel for OnboardingDirector
    // escalation overlays.  Bypasses the once-per-save `_seen` guard since the
    // Director already runs its own dedup via its `posted/satisfied/escalated`
    // state.  Payload: { id, title, body, duration?, icon? }.
    if (Events.TEACHING_MOMENT_FORCE) {
      on(Events.TEACHING_MOMENT_FORCE, (payload) => this._forceShow(payload));
    }

    // CP-4 §4: 3-layer arbitration. Single-fire overlays QUEUE while a blocking
    // surface (deploy ceremony D / net ceremony) is on screen, while the
    // OnboardingDirector is running, or while a MissionCoach beat owns the
    // screen; they drain ≤1 per QUEUE_DRAIN_INTERVAL_S once everything is idle.
    // (UX-11 #9: the C-hold radial-menu blocker was removed with the radial.)
    if (Events.LAUNCH_CEREMONY_START)    on(Events.LAUNCH_CEREMONY_START,    () => this._blockers.add('launchCeremony'));
    if (Events.LAUNCH_CEREMONY_COMPLETE) on(Events.LAUNCH_CEREMONY_COMPLETE, () => this._blockers.delete('launchCeremony'));
    if (Events.NET_CEREMONY_START)    on(Events.NET_CEREMONY_START,    () => this._blockers.add('netCeremony'));
    if (Events.NET_CEREMONY_COMPLETE) on(Events.NET_CEREMONY_COMPLETE, () => this._blockers.delete('netCeremony'));
    if (Events.ONBOARDING_STARTED)  on(Events.ONBOARDING_STARTED,  () => { this._onboardingActive = true; });
    if (Events.ONBOARDING_COMPLETE) on(Events.ONBOARDING_COMPLETE, () => { this._onboardingActive = false; });
    if (Events.MISSION_BEAT_STARTED)   on(Events.MISSION_BEAT_STARTED,   (d) => { this._activeCoachBeat = d || {}; });
    if (Events.MISSION_BEAT_SATISFIED) on(Events.MISSION_BEAT_SATISFIED, () => this._onCoachBeatSatisfied());
    if (Events.GAME_RESET) on(Events.GAME_RESET, () => this._clearPending());
  }

  /**
   * Force-inject a synthetic moment into the overlay pipeline (Delegation 2).
   * @param {{ id: string, title: string, body: string, duration?: number, icon?: string }} payload
   * @private
   */
  _forceShow(payload) {
    if (this._disposed) return;
    if (!payload || !payload.id) return;
    const moment = {
      id: payload.id,
      title: payload.title || 'HINT',
      body: payload.body || '',
      duration: payload.duration || (Constants?.TEACHING?.DEFAULT_DURATION_MS || 9000),
      icon: payload.icon || '💡',
    };
    // Do NOT mark seen — re-fires legitimate (e.g. onboarding re-escalation).
    if (typeof this.onShow === 'function') {
      this._show(moment);
    }
  }

  /**
   * Check if the player has already seen a specific teaching moment.
   * @param {string} momentId
   * @returns {boolean}
   */
  hasSeen(momentId) {
    return this._seen.has(momentId);
  }

  /**
   * Mark a teaching moment as seen and persist.
   * @param {string} momentId
   */
  markSeen(momentId) {
    this._seen.add(momentId);
    this._saveSeen();
  }

  /**
   * Clear all seen flags — dev/debug tool.
   */
  resetAll() {
    this._seen.clear();
    this._saveSeen();
  }

  /**
   * How many teaching moments the player has encountered.
   * @returns {number}
   */
  getSeenCount() {
    return this._seen.size;
  }

  /**
   * Total number of registered teaching moments.
   * @returns {number}
   */
  getTotalCount() {
    return TEACHING_MOMENTS.length;
  }

  /**
   * Unsubscribe all listeners — prevents memory leaks.
   */
  dispose() {
    this._disposed = true;
    const eb = this._eventBus;
    for (const unsub of this._unsubs) {
      if (typeof unsub === 'function') {
        unsub();
      } else if (unsub && unsub.evt && unsub.handler && eb && typeof eb.off === 'function') {
        eb.off(unsub.evt, unsub.handler);
      }
    }
    this._unsubs.length = 0;
    this.onShow = null;
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  /**
   * Core trigger logic with CP-4 §4 arbitration: seen-guard → collision rule →
   * (queue while blocked | show now). Always single-fire via `_seen`.
   * @param {string} momentId
   * @private
   */
  _trigger(momentId) {
    if (this._disposed) return;
    if (this._seen.has(momentId)) return;

    const moment = MOMENTS_BY_ID.get(momentId);
    if (!moment) return;

    // Collision rule: if a MissionCoach beat is actively teaching this exact
    // skill id, the overlay is redundant — drop it permanently (mark seen, never
    // show or queue).
    if (this._activeCoachBeat && this._activeCoachBeat.skillId === momentId) {
      this.markSeen(momentId);
      return;
    }

    // Mark seen immediately — even when queued, don't re-trigger on the next event.
    this.markSeen(momentId);

    // A blocking surface (radial/ceremony), the OnboardingDirector, or a coach
    // beat owns the screen → defer for orderly drain. Otherwise show now.
    if (this._isBlocked()) {
      this._enqueue(moment);
      return;
    }
    this._show(moment);
  }

  /** @private Whether any layer currently owns the screen (overlays must defer). */
  _isBlocked() {
    return this._blockers.size > 0 || this._onboardingActive || this._activeCoachBeat != null;
  }

  /** @private Enqueue a deferred moment, bounded to MAX_QUEUE_DEPTH (drop oldest). */
  _enqueue(moment) {
    const cap = (Constants && Constants.TEACHING && Constants.TEACHING.MAX_QUEUE_DEPTH) || 3;
    this._queue.push(moment);
    while (this._queue.length > cap) this._queue.shift();
  }

  /**
   * @private Display a moment, tagging it with the veteran-aware presentation
   * mode (GUIDANCE_ARBITER_SPEC §3.1: veterans get a ticker, not a modal).
   */
  _show(moment) {
    if (typeof this.onShow !== 'function') return;
    const presentation = (this._skillsSystem && typeof this._skillsSystem.getHintPresentation === 'function')
      ? this._skillsSystem.getHintPresentation()
      : 'modal';
    this.onShow({ ...moment, presentation });
  }

  /** @private A coach beat was satisfied → resume draining after a short delay. */
  _onCoachBeatSatisfied() {
    this._activeCoachBeat = null;
    const interval = (Constants && Constants.TEACHING && Constants.TEACHING.QUEUE_DRAIN_INTERVAL_S) || 6;
    this._drainTimer = Math.max(this._drainTimer, interval);
  }

  /** @private Clear all pending/deferred arbitration state (GAME_RESET). Keeps `_seen`. */
  _clearPending() {
    this._queue.length = 0;
    this._blockers.clear();
    this._onboardingActive = false;
    this._activeCoachBeat = null;
    this._drainTimer = 0;
  }

  /**
   * Per-frame update — drains the deferred-overlay queue at ≤1 per
   * QUEUE_DRAIN_INTERVAL_S once no layer owns the screen.
   * @param {number} dt - delta time (seconds)
   */
  update(dt) {
    if (this._disposed) return;
    if (this._drainTimer > 0) this._drainTimer -= dt;
    if (this._queue.length === 0) return;
    if (this._isBlocked()) return;
    if (this._drainTimer > 0) return;
    const moment = this._queue.shift();
    this._show(moment);
    this._drainTimer = (Constants && Constants.TEACHING && Constants.TEACHING.QUEUE_DRAIN_INTERVAL_S) || 6;
  }

  /**
   * Load seen-set from localStorage via PersistenceManager pattern.
   * Uses its own key (separate from game save — meta-preference).
   * @private
   */
  _loadSeen() {
    const key = (Constants && Constants.TEACHING)
      ? Constants.TEACHING.PERSISTENCE_KEY
      : 'teachingSeen';

    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(key);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            for (const id of arr) this._seen.add(id);
          }
        }
      }
    } catch (_) {
      // Graceful degradation: in-memory only
    }
  }

  /**
   * Persist seen-set to localStorage.
   * @private
   */
  _saveSeen() {
    const key = (Constants && Constants.TEACHING)
      ? Constants.TEACHING.PERSISTENCE_KEY
      : 'teachingSeen';

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify([...this._seen]));
      }
    } catch (_) {
      // Graceful degradation: in-memory only
    }
  }
}

// CJS guard — expose pure state logic + moment definitions for Node.js tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TeachingSystem, TEACHING_MOMENTS, MOMENTS_BY_ID };
}

export default TeachingSystem;
