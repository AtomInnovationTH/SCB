/**
 * TeachingSystem.js — first-encounter contextual overlay manager: listens for game events, decides if a teaching
 * moment should fire, manages "seen" persistence, and delegates display to TeachingOverlay.
 *
 * Philosophy (archive/LEARNING_THROUGH_PLAY.md): "No tutorials. The game teaches through contextual overlays that
 * appear exactly once when the player first encounters each mechanic. Brief, non-blocking, and dismissible."
 *
 * @module systems/TeachingSystem
 */

import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { RAD2DEG } from '../core/MathUtil.js';

/**
 * All 29 teaching moments (TEACHING_MOMENTS.length is the SSOT; test-shop-cadence pins this header to it). Each:
 *   id       — unique key, also used in persistence
 *   title    — overlay heading (SHORT, caps)
 *   body     — overlay body text (1-2 sentences)
 *   duration — display time in ms
 *   icon     — short text tag (<= 4 chars) beside the title; plain letters only, no pictographs (no emoji anywhere)
 */
export const TEACHING_MOMENTS = [
  {
    id: 'first_target',
    title: 'Target Acquired',
    body: 'Press A to autopilot toward it, or deploy a daughter with D. Match your approach to the debris type.',
    duration: 8000,
    icon: 'TGT',
  },
  {
    id: 'first_arm',
    title: 'Daughter Deployed',
    body: 'Hold steady. The daughter needs time to reach the target. Watch the tether tension gauge.',
    duration: 7000,
    icon: 'DTR',
  },
  {
    id: 'first_capture',
    title: 'First Catch!',
    body: 'Nice work, Cowboy. Captured debris goes to your cargo bay. Open the Codex (I) to learn more.',
    duration: 8000,
    icon: 'OK',
  },
  {
    id: 'first_net_park',
    title: 'Catch Parked at the Nose',
    body: 'A caught whale rides at the nose in its net — it is never deleted. It has mass (watch your drift), blocks the net launcher, and stays until you jettison it with K.',
    duration: 9000,
    icon: 'NET',
  },
  {
    id: 'first_conjunction',
    title: 'Conjunction Warning',
    body: 'A "conjunction" means two objects are about to pass dangerously close. Your Collision Avoidance system will suggest a dodge burn if you need one.',
    duration: 7000,
    icon: 'WARN',
  },
  {
    id: 'first_weather',
    title: 'Space Weather',
    body: 'Solar activity detected. Watch your power levels. Panels may degrade during storms.',
    duration: 8000,
    icon: 'SUN',
  },
  {
    id: 'first_shop',
    title: 'The Workshop',
    body: 'Spend resources to upgrade your satellite. TRL badges (Technology Readiness Level) show how proven each upgrade is.',
    duration: 7000,
    icon: 'SHOP',
  },
  {
    id: 'first_codex',
    title: 'Mission Intel',
    body: 'The Codex catalogues everything you\'ve encountered. Knowledge is half the battle.',
    duration: 7000,
    icon: 'INFO',
  },
  {
    id: 'first_burn',
    title: 'Manual Burn',
    body: 'Thrusting changes your orbit. Watch the MFD (Multi-Function Display). Your orbit\'s high point (apoapsis) and low point (periapsis) shift in real time.',
    duration: 7000,
    icon: 'BURN',
  },
  {
    id: 'first_kessler',
    title: 'Kessler Cascade',
    body: 'A collision just spawned new debris. That\'s the start of a Kessler cascade, where wreckage breeds more wreckage. Clear the field faster before it snowballs.',
    duration: 8000,
    icon: 'FRAG',
  },
  {
    id: 'first_autopilot',
    title: 'Autopilot Active',
    body: 'The computer will handle orbital adjustments. Override anytime with manual thrust.',
    duration: 7000,
    icon: 'AUTO',
  },
  {
    id: 'first_lasso',
    title: 'Net Deployed',
    body: 'The capture net has a wide radius but needs momentum. Aim ahead of the target.',
    duration: 7000,
    icon: 'NET',
  },
  {
    id: 'first_active_sat_warning',
    title: 'Protected Asset',
    body: 'Active satellites are off-limits. Houston monitors all asset interactions.',
    duration: 8000,
    icon: 'PROT',
  },
  {
    id: 'first_safe_mode',
    title: 'Safe Mode',
    body: 'Too many systems are critical, so the ship locked your daughters to protect itself. Repair until they\'re above 40% to get them back.',
    duration: 8000,
    icon: 'LOCK',
  },
  {
    id: 'first_radiation',
    title: 'Radiation Belt',
    body: 'You\'re crossing the Van Allen belt. A band of trapped radiation around Earth. Expect sensor static and laggy comms; don\'t linger.',
    duration: 8000,
    icon: 'RAD',
  },
  {
    id: 'first_scan',
    title: 'Quick Scan',
    // the first scan of a boot is a whole-sky search priced like a wide scan (SensorSystem cold search)
    body: 'The first scan searches the whole sky, so it costs as much power and heat as a Wide Scan. After that, Quick Scan reveals nearby debris; Shift+S runs a Wide Scan for longer range.',
    duration: 7000,
    icon: 'SCAN',
  },
  {
    id: 'first_arm_deploy',
    title: 'Daughter Launched',
    body: 'Daughters capture heavier targets at longer range. Press 1-4 to pilot a launched daughter. Manual captures earn 2× score.',
    duration: 8000,
    icon: 'DTR',
  },
  // per-class first-deploy: catch cap + reach, so the mass-routing rule is legible the first time each class launches
  {
    id: 'first_small_daughter_deploy',
    title: 'Small Daughter',
    body: 'Small Daughter: nets targets up to 50 kg, ranges 500 m from the Mother. Fast reload, four nets aboard — your workhorse for fragments.',
    duration: 8000,
    icon: 'DTR',
  },
  {
    id: 'first_large_daughter_deploy',
    title: 'Large Daughter',
    body: 'Large Daughter: nets pieces up to 500 kg, out to 2 km from the Mother. Send her for mid-size or far pieces, so the Mother keeps her fuel. Heavier pieces need the Mother\'s large net.',
    duration: 8000,
    icon: 'DTR',
  },
  // taught the moment a T3+ spring makes the ceiling exceed the cradle default
  {
    id: 'speed_dial',
    title: 'Launch-Speed Dial',
    body: 'Your new spring outruns the 10 m/s cradle default. Set the fleet launch speed with [\'] up and [;] down — a hotter shot reaches farther but reloads ∝ v². Pair it with a long tether and sweep the far field.',
    duration: 9000,
    icon: 'DIAL',
  },
  // whale doctrine: only the Mother's Large Net holds >500 kg
  {
    id: 'first_whale_target',
    title: 'Whale',
    body: 'Over 500 kg: too heavy for a daughter. Only the Mother\'s large net holds it. Fly the Mother in close and press N; pick your moment, the nets are scarce.',
    duration: 9000,
    icon: 'MASS',
  },
  {
    id: 'first_deltav_waste',
    title: 'Save the Burn',
    body: 'The mother is burning fuel to reach a mid-size piece. A daughter reaches it for almost no fuel: press D to send one. Smaller or farther pieces are the daughters\' job, so the mother keeps her fuel.',
    duration: 9000,
    icon: 'FUEL',
  },
  {
    id: 'first_net_failed',
    title: 'Net Slipped',
    body: 'The net lost its grip. Too heavy, or the debris was wider than the net mouth. The catch is fine: it\'s drifting free again. Your daughter keeps her tether and heads home to reload. Re-net it to try again (a bigger net helps for large debris).',
    duration: 9000,
    icon: 'NET',
  },
  {
    id: 'first_tether_snap',
    title: 'Tether Severed',
    body: 'The tether snapped under reel load. That daughter and her catch are cut loose and drifting, and that line can\'t be reloaded. Launch another daughter (D) to chase the catch down, and upgrade your tether in the Workshop to haul heavier loads safely.',
    duration: 10000,
    icon: 'WARN',
  },
  // proactive de-spin teaching: closes the "see odds → pull lever → odds climb" loop before the first wasted net on a fast spinner
  {
    id: 'first_high_tumble_target',
    title: 'Fast Spinner',
    body: 'That target is tumbling fast. Nets slip off fast spinners. Hold L to fire the de-spin laser; watch the capture odds climb as the tumble bleeds off, then net it.',
    duration: 9000,
    icon: 'SPIN',
  },
  {
    id: 'first_despin_in_spec',
    title: 'Tumble In Spec',
    body: 'Tumble in spec. Odds restored. This works on any spinner.',
    duration: 7000,
    icon: 'OK',
  },
  {
    id: 'first_detail_scan',
    title: 'Full Profile',
    body: 'Close-range survey complete. Full structural profile and salvage appraisal. Survey before you commit: brittleness drives fragmentation risk, and appraisal tells you what it\'s worth.',
    duration: 9000,
    icon: 'SCAN',
  },
  {
    id: 'first_aspect_target',
    title: 'Too Wide Broadside',
    body: 'Too wide broadside. But the net can swallow it lengthwise. De-spin it, then orbit around until the readout says END-ON.',
    duration: 9000,
    icon: 'WIDE',
  },
  {
    id: 'first_fragmentation',
    title: 'Fragmentation',
    body: 'The impact broke the debris into new tracked fragments. Wreckage breeds wreckage. First one\'s on the house; avoid it with a slow approach, CINCH mode, or the pad for fragile pieces.',
    duration: 10000,
    icon: 'FRAG',
  },
];

export const MOMENTS_BY_ID = new Map(TEACHING_MOMENTS.map(m => [m.id, m]));

export class TeachingSystem {
  constructor(eventBus, persistenceManager) {
    this._eventBus = eventBus;
    this._pm = persistenceManager || null;
    this._seen = new Set();
    this._unsubs = [];
    this._disposed = false;
    /** mass of the currently-selected target (Δv-waste nudge); null when nothing is selected */
    this._selectedTargetMass = null;

    this.onShow = null;

    /** SkillsSystem ref for the universal hint-gating rule + veteran downgrade */
    this._skillsSystem = null;
    /** moments deferred while a blocking surface is on screen */
    this._queue = [];
    /** active blocking surfaces (deploy ceremony, net ceremony, aim slew) */
    this._blockers = new Set();
    /** OnboardingDirector is running (tier 0: the Director owns the screen) */
    this._onboardingActive = false;
    /** the MissionCoach beat currently owning the screen ({ skillId }) */
    this._activeCoachBeat = null;
    /** seconds until the next queued overlay may drain (≤1 per interval) */
    this._drainTimer = 0;

    this._loadSeen();
  }

  /** Inject the SkillsSystem so overlays obey the universal hint-gating rule and the veteran downgrade (GUIDANCE_ARBITER_SPEC §3 / §3.1). Optional. */
  setSkillsSystem(skillsSystem) {
    this._skillsSystem = skillsSystem || null;
  }

  /** Subscribe to all trigger events. Call after construction and after onShow is wired. */
  init() {
    if (this._disposed) return;

    const eb = this._eventBus;
    if (!eb) return;

    const on = (evt, handler) => {
      const unsub = eb.on(evt, handler);
      if (typeof unsub === 'function') {
        this._unsubs.push(unsub);
      } else {
        this._unsubs.push({ evt, handler });
      }
    };

    on(Events.TARGET_SELECTED, () => this._trigger('first_target'));

    on(Events.ARM_DEPLOYED, () => this._trigger('first_arm'));

    on(Events.DEBRIS_CAPTURED, () => this._trigger('first_capture'));

    // first_net_park: CATCH_PROCESSED with the body KEPT: the mother parks her catch at the nose, and the beat lands
    // during the PARK_HOLD camera hold on her first catch. A daughter's rack catch ({ source: 'rack' }) is not a net park.
    on(Events.CATCH_PROCESSED, (d) => { if (d && d.parked && d.source !== 'rack') this._trigger('first_net_park'); });

    on(Events.CONJUNCTION_ALERT, (data) => {
      if (data && data.reason === 'ACTIVE_SAT_ARMING') {
        this._trigger('first_active_sat_warning');
      } else if (data && (data.severity === 'HI' || data.severity === 'MD')) {
        this._trigger('first_conjunction');
      }
    });

    on(Events.WEATHER_EFFECT_START, () => this._trigger('first_weather'));

    on(Events.SHOP_OPENED, () => this._trigger('first_shop'));

    on(Events.CODEX_OPENED, () => this._trigger('first_codex'));

    on(Events.THROTTLE_CHANGE, (data) => {
      if (data && data.level > 0) {
        this._trigger('first_burn');
      }
      // Δv-efficiency nudge: burning the Mother toward a mid-size piece (10–500 kg) that a Daughter could take for ~0 Δv
      // (DECISIONS §31/§33: daughters take smaller or farther pieces so the mother keeps her fuel).
      if (data && data.level > 0
          && Constants.isFeatureEnabled && Constants.isFeatureEnabled('CAPTURE_NET')) {
        const m = this._selectedTargetMass;
        const lassoCap = Constants.LASSO_MAX_CAPTURE_MASS || 10;
        const daughterCap = Constants.WEAVER_MAX_CAPTURE_MASS || 500;
        if (typeof m === 'number' && m > lassoCap && m <= daughterCap) {
          this._trigger('first_deltav_waste');
        }
      }
    });

    // speed_dial: first T3+ spring purchase (the ceiling just passed the cradle default)
    on(Events.UPGRADE_PURCHASED, (data) => {
      if (data && (data.type === 'springTier' || data.effect === 'springTier')
          && (data.value ?? data.level ?? 0) >= 2) {
        this._trigger('speed_dial');
      }
    });

    on(Events.KESSLER_CASCADE, () => this._trigger('first_kessler'));

    on(Events.AUTOPILOT_ENGAGE, () => this._trigger('first_autopilot'));

    on(Events.LASSO_FIRED, () => this._trigger('first_lasso'));

    if (Events.SAFE_MODE_ENTERED) {
      on(Events.SAFE_MODE_ENTERED, () => this._trigger('first_safe_mode'));
    }

    if (Events.ENVIRONMENT_EFFECT) {
      on(Events.ENVIRONMENT_EFFECT, (data) => {
        if (data && data.type === 'radiation_belt' && data.inBelt === true) {
          this._trigger('first_radiation');
        }
      });
    }

    on(Events.SCAN_INITIATED, () => this._trigger('first_scan'));

    on(Events.ARM_DEPLOYED, (data) => {
      this._trigger('first_arm_deploy');
      // Per-class cards; internal enum weaver = Large Daughter, spinner = Small Daughter.
      const type = data && data.type;
      if (type === 'weaver') this._trigger('first_large_daughter_deploy');
      else if (type === 'spinner') this._trigger('first_small_daughter_deploy');
    });

    if (Events.NET_FAILED) {
      on(Events.NET_FAILED, () => this._trigger('first_net_failed'));
    }

    if (Events.TETHER_SNAP) {
      on(Events.TETHER_SNAP, () => this._trigger('first_tether_snap'));
    }

    // first_high_tumble_target: tumble above the net-safe spin. Gated on LASER_DESPIN so we never teach a verb (hold L)
    // that isn't wired in.
    on(Events.TARGET_SELECTED, (data) => {
      const debris = data && data.debris;
      if (!debris || typeof debris.tumbleRate !== 'number') return;
      if (Constants.isFeatureEnabled && !Constants.isFeatureEnabled('LASER_DESPIN')) return;
      const inSpecDeg = (Constants.NET_TUMBLE_PENALTY && Constants.NET_TUMBLE_PENALTY.IN_SPEC_DEG) || 10;
      const tumbleDeg = Math.abs(debris.tumbleRate) * RAD2DEG;
      if (tumbleDeg > inSpecDeg) this._trigger('first_high_tumble_target');
    });

    if (Events.DESPIN_IN_SPEC) {
      on(Events.DESPIN_IN_SPEC, () => this._trigger('first_despin_in_spec'));
    }

    if (Events.DEBRIS_PROFILED) {
      on(Events.DEBRIS_PROFILED, () => this._trigger('first_detail_scan'));
    }

    // first_aspect_target: an elongated body that only fits the daughter net end-on. Gated on ASPECT_CAPTURE.
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

    // whale-class lock + track selected mass for the Δv-efficiency nudge on THROTTLE_CHANGE. Gated on CAPTURE_NET.
    on(Events.TARGET_SELECTED, (data) => {
      const debris = data && data.debris;
      const mass = debris && typeof debris.mass === 'number' ? debris.mass : null;
      this._selectedTargetMass = mass;
      if (mass == null) return;
      if (Constants.isFeatureEnabled && !Constants.isFeatureEnabled('CAPTURE_NET')) return;
      const daughterCap = Constants.WEAVER_MAX_CAPTURE_MASS || 500;
      if (mass > daughterCap) this._trigger('first_whale_target');
    });

    // Clear the tracked mass on deselect/loss so the Δv-waste nudge can't fire against a stale target.
    if (Events.TARGET_CLEARED) {
      on(Events.TARGET_CLEARED, () => { this._selectedTargetMass = null; });
    }

    if (Events.NET_FRAGMENTATION) {
      on(Events.NET_FRAGMENTATION, () => this._trigger('first_fragmentation'));
    }

    // Force-injection channel for OnboardingDirector escalation overlays. Bypasses the once-per-save `_seen` guard since
    // the Director runs its own dedup (`posted/satisfied/escalated`). Payload: { id, title, body, duration?, icon? }.
    if (Events.TEACHING_MOMENT_FORCE) {
      on(Events.TEACHING_MOMENT_FORCE, (payload) => this._forceShow(payload));
    }

    // Arbitration: single-fire overlays QUEUE while a blocking surface (deploy ceremony / net ceremony) is on screen, the
    // OnboardingDirector is running, or a MissionCoach beat owns the screen; they drain ≤1 per QUEUE_DRAIN_INTERVAL_S
    // once everything is idle.
    if (Events.LAUNCH_CEREMONY_START)    on(Events.LAUNCH_CEREMONY_START,    () => this._blockers.add('launchCeremony'));
    if (Events.LAUNCH_CEREMONY_COMPLETE) on(Events.LAUNCH_CEREMONY_COMPLETE, () => this._blockers.delete('launchCeremony'));
    // a skipped ceremony emits ABORT, not COMPLETE: without this row the blocker stuck and queued moments never drained
    if (Events.LAUNCH_CEREMONY_ABORT)    on(Events.LAUNCH_CEREMONY_ABORT,    () => this._blockers.delete('launchCeremony'));
    if (Events.NET_CEREMONY_START)    on(Events.NET_CEREMONY_START,    () => this._blockers.add('netCeremony'));
    if (Events.NET_CEREMONY_COMPLETE) on(Events.NET_CEREMONY_COMPLETE, () => this._blockers.delete('netCeremony'));
    // Block queued moments during the multi-second auto-rotation slew (it precedes the camera ceremony) so they don't pop mid-rotation.
    if (Events.AIM_SEQUENCE_START) on(Events.AIM_SEQUENCE_START, () => this._blockers.add('aimSequence'));
    if (Events.AIM_SEQUENCE_END)   on(Events.AIM_SEQUENCE_END,   () => this._blockers.delete('aimSequence'));
    if (Events.ONBOARDING_STARTED)  on(Events.ONBOARDING_STARTED,  () => { this._onboardingActive = true; });
    if (Events.ONBOARDING_COMPLETE) {
      on(Events.ONBOARDING_COMPLETE, () => {
        // Moments queued while the tutorial ran are stale by its end: drop them and un-mark them seen (marked at queue
        // time) so each can still show at its next real moment. A veteran's COMPLETE comes without STARTED and keeps its queue.
        if (this._onboardingActive && this._queue.length) {
          for (const m of this._queue) if (m && m.id != null) this._seen.delete(m.id);
          this._queue.length = 0;
          this._saveSeen();
        }
        this._onboardingActive = false;
      });
    }
    if (Events.MISSION_BEAT_STARTED)   on(Events.MISSION_BEAT_STARTED,   (d) => { this._activeCoachBeat = d || {}; });
    if (Events.MISSION_BEAT_SATISFIED) on(Events.MISSION_BEAT_SATISFIED, () => this._onCoachBeatSatisfied());
    if (Events.GAME_RESET) on(Events.GAME_RESET, () => this._clearPending());
  }

  /** Force-inject a synthetic moment into the overlay pipeline. @private */
  _forceShow(payload) {
    if (this._disposed) return;
    if (!payload || !payload.id) return;
    const moment = {
      id: payload.id,
      title: payload.title || 'HINT',
      body: payload.body || '',
      duration: payload.duration || (Constants?.TEACHING?.DEFAULT_DURATION_MS || 9000),
      icon: payload.icon || 'HINT',
    };
    // Do NOT mark seen: re-fires are legitimate (e.g. onboarding re-escalation).
    if (typeof this.onShow === 'function') {
      this._show(moment);
    }
  }

  hasSeen(momentId) {
    return this._seen.has(momentId);
  }

  markSeen(momentId) {
    this._seen.add(momentId);
    this._saveSeen();
  }

  getSeenCount() {
    return this._seen.size;
  }

  getTotalCount() {
    return TEACHING_MOMENTS.length;
  }

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

  /** @private Seen-guard → collision rule → (queue while blocked | show now). Always single-fire via `_seen`. */
  _trigger(momentId) {
    if (this._disposed) return;
    if (this._seen.has(momentId)) return;

    const moment = MOMENTS_BY_ID.get(momentId);
    if (!moment) return;

    // Collision rule: if a MissionCoach beat is teaching this exact skill id, the overlay is redundant: drop it
    // permanently (mark seen, never show or queue).
    if (this._activeCoachBeat && this._activeCoachBeat.skillId === momentId) {
      this.markSeen(momentId);
      return;
    }

    // Mark seen immediately, even when queued, so the next event doesn't re-trigger.
    this.markSeen(momentId);

    // A blocking surface, the OnboardingDirector, or a coach beat owns the screen: defer for orderly drain; else show now.
    if (this._isBlocked()) {
      this._enqueue(moment);
      return;
    }
    this._show(moment);
  }

  _isBlocked() {
    return this._blockers.size > 0 || this._onboardingActive || this._activeCoachBeat != null;
  }

  _enqueue(moment) {
    const cap = (Constants && Constants.TEACHING && Constants.TEACHING.MAX_QUEUE_DEPTH) || 3;
    this._queue.push(moment);
    while (this._queue.length > cap) this._queue.shift();
  }

  /** @private Display a moment, tagged with the veteran-aware presentation (GUIDANCE_ARBITER_SPEC §3.1: veterans get a ticker, not a modal). */
  _show(moment) {
    if (typeof this.onShow !== 'function') return;
    const presentation = (this._skillsSystem && typeof this._skillsSystem.getHintPresentation === 'function')
      ? this._skillsSystem.getHintPresentation()
      : 'modal';
    this.onShow({ ...moment, presentation });
  }

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

  /** Per frame: drains the deferred queue at ≤1 per QUEUE_DRAIN_INTERVAL_S once no layer owns the screen. */
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

  /** @private Load the seen-set from localStorage under its own key (separate from the game save: a meta-preference). */
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
      // in-memory only
    }
  }

  _saveSeen() {
    const key = (Constants && Constants.TEACHING)
      ? Constants.TEACHING.PERSISTENCE_KEY
      : 'teachingSeen';

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify([...this._seen]));
      }
    } catch (_) {
      // in-memory only
    }
  }
}

// CJS guard: pure state logic + moment definitions for Node tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TeachingSystem, TEACHING_MOMENTS, MOMENTS_BY_ID };
}

export default TeachingSystem;
