/**
 * AudioSystem.js — Procedural sound effects using Web Audio API
 * All sounds are generated procedurally — no external audio files needed.
 * @module systems/AudioSystem
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import timerManager from './TimerManager.js';

// Slice 8 — codex unlock chime. The base pair is D5→A5 [587, 880]; per category
// we transpose by a small deterministic pentatonic offset so different tracks
// feel tonally distinct without any pitch feeling "wrong". Pure + module-level
// so it's unit-testable in the headless harness.
const CODEX_CHIME_BASE = [587, 880]; // D5, A5
const CODEX_PENTATONIC = [0, 2, 4, 7, 9]; // major-pentatonic semitone offsets

/**
 * Deterministic two-note frequency pair for a codex-unlock chime, transposed
 * from the base D5→A5 pair by a per-category pentatonic offset.
 * @param {string} [category] - codex category key; unknown/missing → base pair.
 * @returns {[number, number]} two finite ascending frequencies.
 */
export function codexChimeNotes(category) {
  if (typeof category !== 'string' || category.length === 0) {
    return [CODEX_CHIME_BASE[0], CODEX_CHIME_BASE[1]];
  }
  // Stable string hash → pentatonic bucket.
  let h = 0;
  for (let i = 0; i < category.length; i++) {
    h = (h * 31 + category.charCodeAt(i)) | 0;
  }
  const semi = CODEX_PENTATONIC[Math.abs(h) % CODEX_PENTATONIC.length];
  const factor = Math.pow(2, semi / 12);
  return [CODEX_CHIME_BASE[0] * factor, CODEX_CHIME_BASE[1] * factor];
}

class AudioSystem {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    // Audio Vocabulary Overhaul (P2) — per-family bus nodes (created in init()).
    this.physicalBus = null;
    this.radioBus = null;
    this.pingBus = null;
    this.tickBus = null;
    this.denyBus = null;
    this.alarmBus = null;
    this.rewardBus = null;
    this.padBus = null;
    // Reserved, silent, unused — prepared for future music + TTS narration.
    this.musicBus = null;
    this.voiceBus = null;
    // Ducking state: re-entrancy counter so overlapping duck requests don't
    // restore early. voiceBus TTS hook shares the same counter.
    this._duckHolds = 0;
    this.available = false;
    this.activeSources = new Map();
    this._initialized = false;
    this._eventsSetup = false;

    // Phase 8: Approach beep per-arm timers { armId → lastBeepTime }
    this._approachBeepTimers = new Map();

    // Phase 8: Tether tension cooldown per-arm { armId → lastTensionTime }
    this._tetherTensionTimers = new Map();
    this._tetherTensionCooldown = 3.0; // seconds between tension sounds

    // Phase R9: 4-tier ΔV alarm state
    this._dvAlarmTier = 0;
    this._dvDucked = false;
    this._dvAlarmInterval = null;
    this._dvAlarmOsc = null;
    this._dvAlarmLfo = null;
    this._dvAlarmGain = null;

    // Phase R9: Thruster sputtering state
    this._thrusterSputtering = false;
    this._sputterInterval = null;
    this._thrusterBaseGain = 0.06;
    this._thrusterGain = null;

    // Phase 7: Docking alignment tone state
    this._alignmentToneOsc = null;
    this._alignmentToneGain = null;
  }

  /**
   * Initialize AudioContext on user interaction (required by browsers).
   */
  init() {
    if (this._initialized) return;
    // §13 diagnostic: ?noAudio=1 URL flag — short-circuits AudioContext
    // creation entirely so we can A/B test whether the audio render thread
    // is the SMC fan trigger at sim-start. Flag is parsed lazily so the test
    // runner (no window) is unaffected. Identical to §12.11 mechanism for
    // pause-fan but applied to GAMEPLAY: if fan stays off with this flag set,
    // the §12.11 audio-thread mechanism is confirmed as the gameplay trigger.
    try {
      if (typeof window !== 'undefined' &&
          new URLSearchParams(window.location.search).get('noAudio') === '1') {
        console.info('[AudioSystem] ?noAudio=1. Skipping AudioContext creation. All audio is disabled for this session.');
        this.available = false;
        this._initialized = true; // prevent retry storms from event handlers
        return;
      }
    } catch (_e) { /* swallow — non-browser env */ }
    // §13 boot timeline (?logBoot=1) — mark every audio lifecycle event so the
    // timeline shows precisely when the 44.1 kHz audio render thread becomes
    // active (the §12.11 fan-trigger mechanism). Optional-chained — no-op when
    // window.__bootMark is not attached. Safe in Node test runner.
    try {
      // eslint-disable-next-line no-undef
      if (typeof window !== 'undefined') window.__bootMark?.('audioSystem.init() called');
    } catch (_e) { /* swallow */ }
    try {
      // §13 Sprint 4 — low-power AudioContext configuration.
      //
      // Root-cause: default `new AudioContext()` uses
      //   latencyHint = 'interactive' (≈ 256-sample buffer, ~5.8 ms @ 44.1k)
      //   sampleRate  = 44100
      // → audio render thread wakes ~170×/s with default config.
      // Even with zero audible work, that wakeup frequency drives Energy
      // Impact past the macOS SMC fan-trip threshold (§12.11 mechanism).
      // A/B-confirmed via ?noAudio=1: fan stays OFF when ctx is never
      // created, ON when ctx is created with defaults — even with full
      // GPU work running in both cases.
      //
      // Fix: use latencyHint:'playback' (large buffer, fewer wakeups —
      // typically 1024-4096 samples) and 22050 Hz sampleRate (half the
      // clock rate, sufficient for all procedural game SFX which are
      // sub-2 kHz). Combined effect: 8-32× fewer audio thread wakeups.
      //
      // Compatibility: every play* method uses relative time and absolute
      // frequencies that are invariant under sample rate change. No call
      // site needs modification. Tested at 22050 Hz / 44100 Hz, identical
      // behaviour aside from intentional low-pass at 11025 Hz (above all
      // procedural sound frequencies — not perceptible).
      //
      // Test runner is unaffected — it stubs AudioContext entirely.
      const CtxCtor = window.AudioContext || window.webkitAudioContext;
      let opts = { latencyHint: 'playback', sampleRate: 22050 };
      try {
        this.ctx = new CtxCtor(opts);
      } catch (_e1) {
        // Some old Safari builds don't accept sampleRate at construct time.
        // Retry without sampleRate first; if that also fails, default ctor.
        try {
          this.ctx = new CtxCtor({ latencyHint: 'playback' });
        } catch (_e2) {
          this.ctx = new CtxCtor();
        }
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = 0.7;
      this.sfxBus.connect(this.master);
      // Audio Vocabulary Overhaul (P2) — family bus graph. Every family bus
      // routes → sfxBus → master → destination. Ducking (see _duckOthers)
      // ramps all non-alarm family buses; the alarm bus is never ducked so
      // danger always outranks. musicBus/voiceBus are reserved (silent) and
      // connect straight to master so future music/TTS bypass sfx volume and
      // can be ducked independently.
      const FG = (Constants.AUDIO && Constants.AUDIO.FAMILY_GAIN) || {};
      const mkFamily = (gainVal) => {
        const g = this.ctx.createGain();
        g.gain.value = (typeof gainVal === 'number') ? gainVal : 1.0;
        g.connect(this.sfxBus);
        return g;
      };
      this.physicalBus = mkFamily(FG.physical);
      this.radioBus = mkFamily(FG.radio);
      this.pingBus = mkFamily(FG.ping);
      this.tickBus = mkFamily(FG.tick);
      this.denyBus = mkFamily(FG.deny);
      this.alarmBus = mkFamily(FG.alarm);
      this.rewardBus = mkFamily(FG.reward);
      this.padBus = mkFamily(FG.pad);
      // Reserved buses → master (silent until music/TTS ships).
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 1.0;
      this.musicBus.connect(this.master);
      this.voiceBus = this.ctx.createGain();
      this.voiceBus.gain.value = 1.0;
      this.voiceBus.connect(this.master);
      // Non-alarm family buses that duck when an alarm is active.
      this._duckableBuses = [
        this.physicalBus, this.radioBus, this.pingBus, this.tickBus,
        this.denyBus, this.rewardBus, this.padBus, this.musicBus, this.voiceBus,
      ];
      this.master.connect(this.ctx.destination);
      this.available = true;
      this._initialized = true;
      // §13 mark initial state (typically 'suspended' until user gesture).
      try {
        // eslint-disable-next-line no-undef
        if (typeof window !== 'undefined') {
          window.__bootMark?.(`AudioContext created (state=${this.ctx.state}, sampleRate=${this.ctx.sampleRate})`);
          // Subscribe to state transitions — fires when ctx goes
          // suspended ↔ running. This is the §12.11 fan-trigger signal.
          if (typeof this.ctx.addEventListener === 'function') {
            this.ctx.addEventListener('statechange', () => {
              try {
                window.__bootMark?.(`AudioContext statechange → ${this.ctx.state}`);
              } catch (_e) { /* swallow */ }
            });
          } else if ('onstatechange' in this.ctx) {
            const prev = this.ctx.onstatechange;
            this.ctx.onstatechange = (...args) => {
              try {
                window.__bootMark?.(`AudioContext statechange → ${this.ctx.state}`);
              } catch (_e) { /* swallow */ }
              if (typeof prev === 'function') prev.apply(this.ctx, args);
            };
          }
        }
      } catch (_e) { /* swallow */ }
      this.setupEventListeners();
    } catch (e) {
      console.warn('[AudioSystem] Web Audio API not available:', e);
      this.available = false;
    }
  }

  /** Resume context if suspended (autoplay policy) */
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /** Set master volume 0..1 */
  setVolume(v) {
    if (this.master) this.master.gain.value = Math.max(0, Math.min(1, v));
  }

  /**
   * Duck all non-alarm family buses so an ALARM cue reads clearly over the
   * rest of the mix (danger outranks everything — Design law (d)). Uses a
   * re-entrancy counter (`_duckHolds`) so overlapping alarms don't restore
   * the mix early. 0.15 s down-ramp, 0.5 s up-ramp.
   * @param {boolean} on
   * @private
   */
  _duckOthers(on) {
    if (!this.available || !this.ctx || !this._duckableBuses) return;
    if (on) {
      this._duckHolds++;
      if (this._duckHolds > 1) return; // already ducked
    } else {
      this._duckHolds = Math.max(0, this._duckHolds - 1);
      if (this._duckHolds > 0) return; // another hold still active
    }
    const now = this.ctx.currentTime;
    const target = on ? 0.5 : 1.0;
    const ramp = on ? 0.15 : 0.5;
    for (const bus of this._duckableBuses) {
      if (!bus) continue;
      try {
        bus.gain.cancelScheduledValues(now);
        bus.gain.setValueAtTime(bus.gain.value, now);
        bus.gain.linearRampToValueAtTime(target, now + ramp);
      } catch (_e) { /* headless stub */ }
    }
  }

  /**
   * One-shot duck for a transient alarm: duck on, restore after `ms`.
   * @param {number} ms
   * @private
   */
  _duckPulse(ms) {
    if (!this.available) return;
    this._duckOthers(true);
    timerManager.setTimeout(() => this._duckOthers(false), ms, { owner: this });
  }

  /**
   * TTS-ready hook (reserved): duck the mix for spoken narration. Shares the
   * same re-entrancy counter as alarm ducking. No voice content ships yet.
   * @param {boolean} on
   */
  duckForVoice(on) {
    this._duckOthers(on);
  }

  /**
   * §13 escalation: decide whether the ambient engine-room loop should run
   * in gameplay states. Constant default is false (Apple Silicon SMC fan
   * trigger); `?ambient=1` URL flag force-enables, `?noAmbient=1` force-
   * disables for symmetry. Node test runner has no `window` → always false.
   * @returns {boolean}
   * @private
   */
  _isAmbientLoopEnabled() {
    try {
      if (typeof window === 'undefined') return false;
      const qs = new URLSearchParams(window.location.search);
      if (qs.get('ambient') === '1') return true;
      if (qs.get('noAmbient') === '1') return false;
    } catch (_e) { /* swallow — non-browser env */ }
    return !!(Constants.AUDIO && Constants.AUDIO.AMBIENT_LOOP_ENABLED);
  }

  // ==========================================================================
  // EVENT-DRIVEN WIRING
  // ==========================================================================

  /**
   * Subscribe to game events via EventBus for automatic sound playback.
   * Idempotent — only wires once.
   */
  setupEventListeners() {
    if (this._eventsSetup) return;
    this._eventsSetup = true;

    // Arm lifecycle sounds.
    // Issue 1 (2026-06-12): the deploy WOOSH keys off ARM_SPRING_FIRED — the
    // moment the crossbow spring actually releases the daughter (1.5 s after
    // LAUNCHING entry) — so audio matches departure, not intent. ARM_DEPLOYED
    // (clamp-release start) now plays a quiet mechanical click so the 1.5 s
    // wind-up reads as deliberate. HUD/skills/teaching wiring on ARM_DEPLOYED
    // is unaffected.
    eventBus.on(Events.ARM_DEPLOYED, () => {
      this.playDockClick();
    });

    eventBus.on(Events.ARM_SPRING_FIRED, () => {
      this.playArmDeploy();
    });

    eventBus.on(Events.ARM_CAPTURED, () => {
      this.playNetWhoosh(0.3);
      this.playCatchClamp(); // Phase 1C: metallic clamp impact on capture
    });

    eventBus.on(Events.ARM_RETURNED, (data) => {
      if (data.captured) {
        this.playCaptureSuccess();
      }
    });

    eventBus.on(Events.ARM_DOCKED, () => {
      this.playDockClick();
    });

    eventBus.on(Events.ARM_CAPTURE_FAILED, () => {
      this.playFailBuzz();
    });

    eventBus.on(Events.ARM_EXPENDED, () => {
      this.playWarning(0.6);
    });

    // Game events
    eventBus.on(Events.GAME_KESSLER, () => {
      this._duckPulse(2000); // P2 ducking: Kessler collision is game-ending danger
      this.playCollision();
    });

    eventBus.on(Events.SCORE_UPDATE, (data) => {
      if (data.points > 0) {
        this.playScoreTally();
      }
    });

    // Scan initiated — radar sweep/ping sound
    eventBus.on(Events.SCAN_INITIATED, () => {
      this.playScan();
    });

    // Credit award — cash register "ka-ching"
    eventBus.on(Events.SCORING_AWARD, (data) => {
      if (data.points > 0) {
        this.playCashRegister();
      }
    });

    eventBus.on(Events.CAMERA_VIEW_CHANGE, () => {
      // Don't play click here — it's already called directly in main.js onKeyDown for V key
      // This prevents double-click sounds
    });

    // Forge events
    eventBus.on(Events.FORGE_PHASE_CHANGE, (data) => {
      if (data.phase === 'IDLE') {
        this.stopForgeHum();
      } else {
        this.startForgeHum(data.phase);
      }
    });

    eventBus.on(Events.FORGE_COMPLETE, () => {
      this.stopForgeHum();
      this.playForgeComplete();
    });

    // === Phase R8 event wiring ===

    // Target lock ceremony sounds (Phase 5) — reward-first spine.
    // The "locked on" earcon is governed by the NET-RANGE crossing, NOT raw
    // selection, so it always means "you can act on this now". AutoLockController
    // tracks every selected target (auto or manual) and emits TARGET_IN_RANGE on
    // the out→in crossing (or immediately for an already-in-range pick), which is
    // where the lock cue fires. An explicitly out-of-range selection stays
    // silent. We still honor a one-frame SELECTED cue when nothing will range-
    // track it (e.g. headless/no-controller contexts) — but skip it whenever the
    // selection is tagged in/out by the range system to avoid a double-fire.
    eventBus.on(Events.TARGET_SELECTED, (data) => {
      // Suppressed picks (autolock) and range-governed selections defer to
      // TARGET_IN_RANGE for the earcon.
      if (data && data._suppressLockSound) return;
      if (data && data.autoLock) return;
      // Manual selection without range governance: play immediately.
      this._playLockDeduped();
    });

    eventBus.on(Events.TARGET_CLEARED, (data) => {
      // A programmatic reset clear (mission init) passes silent:true — no target
      // was ever engaged, so skip the "target lost" earcon.
      if (data && data.silent) return;
      this.playTargetLost();
    });

    // Net-range crossing INTO range → the lock earcon (the "there it is" payoff
    // after autopilot closes the gap, and the tease lock at start). This is the
    // single trustworthy "now actionable" cue.
    eventBus.on(Events.TARGET_IN_RANGE, (data) => {
      // Only the player selecting a target should ping. The game's automatic
      // lock (startup tease debris, ambient reacquire) fires TARGET_IN_RANGE
      // unprompted — an anonymous earcon the player did nothing to cause teaches
      // no vocabulary, so it is tagged autoLock and stays silent here.
      if (data && data.autoLock) return;
      this._playLockDeduped();
    });

    // T key → ascending fuel cycle step tone
    eventBus.on(Events.FUEL_CHANGED, (data) => {
      this.playFuelCycle(data.index || 0);
    });

    // Cargo stored → mechanical clunk
    eventBus.on(Events.CARGO_STORE, () => {
      this.playCargoStored();
    });

    // Trawl auto-capture → soft ding
    eventBus.on(Events.TRAWL_CAPTURE, () => {
      this.playTrawlCapture();
    });

    // Ambient loop lifecycle: start on gameplay, stop on menu/gameover.
    // §13 escalation: gated by Constants.AUDIO.AMBIENT_LOOP_ENABLED (default
    // false) — two continuously-looping BufferSource + BiquadFilter chains
    // were keeping the audio render thread permanently busy on Apple Silicon
    // (SMC fan trigger after the §13.5 low-power ctx fix still ran the chip
    // hot). URL overrides:
    //   ?ambient=1   — force-enable (for users who want engine-room sound)
    //   ?noAmbient=1 — force-disable (default behaviour, kept for symmetry)
    eventBus.on(Events.STATE_CHANGE, (data) => {
      const playStates = ['ORBITAL_VIEW', 'APPROACH', 'INTERACTION'];
      if (playStates.includes(data.to) && !this._ambientActive && this._isAmbientLoopEnabled()) {
        this.startAmbientLoop();
      } else if (['MENU', 'GAME_OVER', 'WIN'].includes(data.to)) {
        this.stopAmbientLoop();
      }
    });

    // T10 — menu→sim transition audio. There is no menu ambient (engine-room
    // loop is gameplay-only), so the departure was silent. A soft pad swell
    // rises during the camera pull-back; a comms crackle marks the HUD coming
    // online. Both gate on this.available, so ?noAudio=1 (init short-circuits
    // → available=false) keeps them silent for capture drivers.
    eventBus.on(Events.MENU_DEPARTURE_START, (data) => {
      // Size the swell to the pull-back so it lands with the handoff.
      const dur = (data && Number.isFinite(data.durationMs)) ? data.durationMs / 1000 : 1.35;
      this.playDepartureSwell(dur);
    });
    eventBus.on(Events.HUD_POWER_ON, () => {
      this.playCommsCrackle();
    });

    // T6 — SAFER cold-gas puff "pfft" during the astronaut jet-off exit. One per
    // puff (fires only on the full new-game exit). Gates on this.available.
    eventBus.on(Events.MENU_EVA_PUFF, () => {
      this.playEvaPuff();
    });

    // === Phase R9 event wiring ===

    // ΔV telemetry → 4-tier urgency alarm + thruster sputtering + ambient modulation
    eventBus.on(Events.DELTAV_UPDATE, (data) => {
      this.updateDeltaVAlarm(data.pct, data.predictedPct);
      // Bug 2 fix: drive thruster sputtering when fuel is low
      if (this.activeSources.has('thruster')) {
        this.updateThrusterFuelState(data.pct * 100); // 0-1 → 0-100
      }
      // Bug 3 fix: modulate ambient engine-room sounds based on solar/battery state
      this.updateAmbientState({
        solarRate: data.solarRate || 0,
        batteryPct: data.batteryPct || 100,
      });
    });

    // === Conjunction alerts (Sprint C1) ===
    eventBus.on(Events.CONJUNCTION_WARNING, (data) => {
      this.playConjunctionAlert(data.tier);
    });

    // === Phase 6: Tether detach snap sound ===
    eventBus.on(Events.ARM_DETACHED, () => {
      this.playTetherSnap();
    });
    // §4 item 2: TETHER_SNAP also triggers snap audio (BUG-B fix)
    eventBus.on(Events.TETHER_SNAP, () => this.playTetherSnap());

    // === Phase 8: Audio & Polish — Final Juice ===

    // Approach beep — arm nearing target (rate-limited per arm)
    eventBus.on(Events.ARM_APPROACH_PING, (data) => {
      const { distanceFraction, armId } = data;
      const now = performance.now() / 1000;
      const lastBeep = this._approachBeepTimers.get(armId) || 0;

      // Determine interval based on distance tier
      let interval;
      if (distanceFraction < 0.1) interval = 0.2;
      else if (distanceFraction < 0.3) interval = 0.5;
      else if (distanceFraction < 0.7) interval = 1.0;
      else interval = 2.0;

      if (now - lastBeep >= interval) {
        this._approachBeepTimers.set(armId, now);
        this.playApproachBeep(distanceFraction);
      }
    });

    // Tether tension — arm nearing tether limit
    eventBus.on(Events.TETHER_TENSION, (data) => {
      const { tensionFraction, armId } = data;
      const now = performance.now() / 1000;
      const lastTension = this._tetherTensionTimers.get(armId) || 0;

      if (now - lastTension >= this._tetherTensionCooldown) {
        this._tetherTensionTimers.set(armId, now);
        this.playTetherTension(tensionFraction);
      }
    });

    // Weather alerts — distinct earcons per type
    eventBus.on(Events.WEATHER_EFFECT_START, (data) => {
      this.playWeatherAlert(data.type);
    });

    // Codex unlock — discovery chime (Slice 8: per-category tonal variant)
    eventBus.on(Events.CODEX_UNLOCKED, (d) => {
      this.playCodexUnlock(d && d.category);
    });

    // Sweep complete — success fanfare
    eventBus.on(Events.TRAWL_SWEEP_COMPLETE, () => {
      this.playSweepComplete();
    });

    // Phase 7: Autopilot disengage tone
    eventBus.on(Events.AUTOPILOT_DISENGAGE, () => {
      this.playAPDisengage();
    });

    // Autopilot arrival — distinctive ascending chime (ready to capture)
    eventBus.on(Events.AUTOPILOT_ARRIVED, () => {
      this.playAPArrived();
    });

    // CP-3: transfer-window cues — T-minus beep + window-open chime
    eventBus.on(Events.CLUSTER_WINDOW_IMMINENT, () => this.playWindowImminent());
    eventBus.on(Events.CLUSTER_WINDOW_OPEN, () => this.playWindowOpen());

    // Salvage reveal — loot box moment
    eventBus.on(Events.SALVAGE_REVEAL, () => {
      this.playSalvageReveal();
    });

    // Lasso audio feedback (Phase 6 — Lasso Feedback Overhaul)
    eventBus.on(Events.LASSO_FIRED, () => {
      this.playLassoFire();
      this.startLassoWireWhistle();
    });

    eventBus.on(Events.LASSO_CONTACT, () => {
      this.playCatchClamp();        // Metallic clank on contact
      this.stopLassoWireWhistle();
      this.playLassoWinch();        // Mechanical reel-in sound
    });

    eventBus.on(Events.LASSO_CAPTURED, () => {
      this.stopLassoWireWhistle();  // Safety stop
    });

    eventBus.on(Events.LASSO_DENIED, () => {
      this.playLassoDenied();
    });

    // S3b: MPD Burst Mode audio
    eventBus.on(Events.MPD_BURST_START, () => {
      this.playMPDArm();
    });

    eventBus.on(Events.MPD_BURST_END, (data) => {
      this.playMPDDisarm();
    });

    eventBus.on(Events.MPD_OVERHEAT, () => {
      this.playMPDOverheat();
    });

    // ST-3.4: Skill celebration audio
    eventBus.on(Events.SKILL_STATE_CHANGED, (d) => {
      if (d?.to === 'practiced') this.playPracticeChime();
    });
    eventBus.on(Events.MASTERY_FANFARE, () => this.playMasteryFanfare());

    // Delegation 2 (2026-05-31) — onboarding "hint posted" soft chime.
    // Generic AUDIO_CUE channel — payload: { id|cue: string, volume?: number }.
    // Currently we only recognise `hint_post` and `sweepComplete`; unknown cues
    // are no-ops.
    eventBus.on(Events.AUDIO_CUE, (data) => {
      if (!data) return;
      const id = data.id || data.cue;
      if (id === 'hint_post') {
        const v = (typeof data.volume === 'number') ? data.volume : 0.4;
        this.playHintPost(v);
      } else if (id === 'sweepComplete') {
        // defer-trawl: cluster-cleared ceremony reuses the sweep-complete sting.
        this.playSweepComplete();
      }
    });
  }

  // ==========================================================================
  // PROCEDURAL SOUND GENERATORS
  // ==========================================================================

  /**
   * Magnetic field hum — pulsing low tone
   * @param {number} [duration=0.5]
   */
  playMagnetic(duration = 0.5) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 60;

    // LFO for pulsing
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 4;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.06;
    lfo.connect(lfoGain);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.08, now);
    lfoGain.connect(gain.gain);
    gain.gain.linearRampToValueAtTime(0.001, now + duration);

    osc.connect(gain);
    gain.connect(this.physicalBus);
    osc.start(now);
    lfo.start(now);
    osc.stop(now + duration);
    lfo.stop(now + duration);
  }

  /**
   * Warning beep — descending G4→E4 interval (Phase R8).
   * Two-note earcon using EARCON_FREQUENCIES.ALERT.
   */
  playWarning() {
    if (!this.available) return;
    const now = this.ctx.currentTime;
    const freqs = Constants.AUDIO.EARCON_FREQUENCIES.ALERT; // [392, 329] — G4, E4

    freqs.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      const start = now + i * 0.15;
      gain.gain.setValueAtTime(0.15, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.12);
      osc.connect(gain);
      gain.connect(this.alarmBus);
      osc.start(start);
      osc.stop(start + 0.15);
    });
  }

  /**
   * Play capture/clamp impact sound — metallic thud + ringing (Phase 1C).
   * Triggered when arm enters GRAPPLED state (catch moment).
   */
  playCatchClamp() {
    if (!this.available) return;
    const now = this.ctx.currentTime;

    // Impact thud (low frequency burst)
    const thud = this.ctx.createOscillator();
    const thudGain = this.ctx.createGain();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(80, now);
    thud.frequency.exponentialRampToValueAtTime(40, now + 0.15);
    thudGain.gain.setValueAtTime(0.3, now);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    thud.connect(thudGain).connect(this.physicalBus);
    thud.start(now);
    thud.stop(now + 0.2);

    // Metallic ring (higher frequency, longer decay)
    const ring = this.ctx.createOscillator();
    const ringGain = this.ctx.createGain();
    ring.type = 'triangle';
    ring.frequency.setValueAtTime(800, now + 0.02);
    ring.frequency.exponentialRampToValueAtTime(400, now + 0.5);
    ringGain.gain.setValueAtTime(0.15, now + 0.02);
    ringGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    ring.connect(ringGain).connect(this.physicalBus);
    ring.start(now + 0.02);
    ring.stop(now + 0.5);

    // Clamp click (noise burst)
    const bufSize = Math.floor(this.ctx.sampleRate * 0.05);
    const buf = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSize * 0.1));
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buf;
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.2, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 2000;
    noiseFilter.Q.value = 2;
    noise.connect(noiseFilter).connect(noiseGain).connect(this.physicalBus);
    noise.start(now);
    noise.stop(now + 0.08);
  }

  /**
   * Capture success confirmation — single clean beep (A5, 880Hz, 150ms).
   * S9-B: Simplified from G4→B4→D5 fanfare to a single tone for sim reframe.
   */
  playCaptureSuccess() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 880; // A5 — clean, high, brief

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    osc.connect(gain);
    gain.connect(this.rewardBus);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  /**
   * Collision/explosion rumble
   */
  playCollision() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Low noise burst
    const bufferSize = ctx.sampleRate * 0.5;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.3));
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 200;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.physicalBus);
    noise.start(now);
    noise.stop(now + 0.5);
  }

  /**
   * UI click — short blip
   */
  playClick() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1200;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    osc.connect(gain);
    gain.connect(this.tickBus);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  /**
   * Terminal blip — short FM sweep 800→400Hz, 50ms duration, low volume.
   * Used for comms boot sequence messages (UX-2 #10B).
   */
  playTerminalBlip() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(400, now + 0.05);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    osc.connect(gain);
    gain.connect(this.pingBus);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  /**
   * Score tally — digital counting sound
   */
  playScoreTally() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 1800;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.04, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

    osc.connect(gain);
    gain.connect(this.rewardBus);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  /**
   * Game over — ominous descending tone
   */
  playGameOver() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(200, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 2.0);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.linearRampToValueAtTime(0, now + 2.0);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.alarmBus);
    osc.start(now);
    osc.stop(now + 2.0);
  }

  /**
   * Victory fanfare — ascending chord
   */
  playVictory() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const chords = [
      [261, 329, 392],  // C major
      [329, 415, 523],  // E major
      [392, 494, 587],  // G major
      [523, 659, 784],  // C major (octave up)
    ];

    chords.forEach((chord, ci) => {
      chord.forEach((freq) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;

        const gain = ctx.createGain();
        const start = now + ci * 0.25;
        gain.gain.setValueAtTime(0.08, start);
        gain.gain.linearRampToValueAtTime(0.001, start + 0.5);

        osc.connect(gain);
        gain.connect(this.rewardBus);
        osc.start(start);
        osc.stop(start + 0.5);
      });
    });
  }

  // ==========================================================================
  // NEW FIRE-AND-FORGET GENERATORS
  // ==========================================================================

  /**
   * Net whoosh — filtered noise sweep for net deployment
   * @param {number} [dur=0.4]
   */
  playNetWhoosh(dur = 0.4) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // White noise buffer
    const bufferSize = Math.ceil(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    // Bandpass filter with frequency sweep 3000 → 300 Hz
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(3000, now);
    filter.frequency.linearRampToValueAtTime(300, now + dur);

    // Gain envelope: 0→0.4 in 20ms, hold, 0.4→0 in last 100ms
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.4, now + 0.02);
    gain.gain.setValueAtTime(0.4, now + dur - 0.1);
    gain.gain.linearRampToValueAtTime(0, now + dur);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.physicalBus);
    noise.start(now);
    noise.stop(now + dur);
  }

  /**
   * Dock click — mechanical latch click when arm docks
   */
  playDockClick() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.03;

    // Primary click — sine at 400Hz
    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = 400;

    const gain1 = ctx.createGain();
    gain1.gain.setValueAtTime(0, now);
    gain1.gain.linearRampToValueAtTime(0.3, now + 0.002);
    gain1.gain.linearRampToValueAtTime(0, now + dur);

    osc1.connect(gain1);
    gain1.connect(this.physicalBus);
    osc1.start(now);
    osc1.stop(now + dur);

    // Lower thud — sine at 200Hz
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 200;

    const gain2 = ctx.createGain();
    gain2.gain.setValueAtTime(0, now);
    gain2.gain.linearRampToValueAtTime(0.15, now + 0.002);
    gain2.gain.linearRampToValueAtTime(0, now + dur);

    osc2.connect(gain2);
    gain2.connect(this.physicalBus);
    osc2.start(now);
    osc2.stop(now + dur);
  }

  /**
   * Arm deploy — tether unspool sound with whirring LFO
   * @param {number} [dur=0.6]
   */
  playArmDeploy(dur = 0.6) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // White noise source
    const bufferSize = Math.ceil(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    // Bandpass filter at 1500Hz, Q=0.8
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1500;
    filter.Q.value = 0.8;

    // LFO: sine at 8Hz modulating bandpass frequency ±300Hz
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 8;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 300;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);

    // Gain: ramp 0→0.2 over 50ms, then slow decay to 0 over duration
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.05);
    gain.gain.linearRampToValueAtTime(0, now + dur);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.physicalBus);
    noise.start(now);
    lfo.start(now);
    noise.stop(now + dur);
    lfo.stop(now + dur);
  }

  /**
   * Tether snap — sharp metallic snap/crack + tension release whip + low rumble fade.
   * Phase 6: plays when tether is severed (ARM_DETACHED event).
   */
  playTetherSnap() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Layer 1: Sharp metallic snap (short burst of filtered noise at high freq)
    const snapDur = 0.08;
    const snapBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * snapDur), ctx.sampleRate);
    const snapData = snapBuf.getChannelData(0);
    for (let i = 0; i < snapData.length; i++) {
      snapData[i] = (Math.random() * 2 - 1) * Math.exp(-i / (snapData.length * 0.15));
    }
    const snapSrc = ctx.createBufferSource();
    snapSrc.buffer = snapBuf;
    const snapFilter = ctx.createBiquadFilter();
    snapFilter.type = 'highpass';
    snapFilter.frequency.value = 3000;
    snapFilter.Q.value = 2;
    const snapGain = ctx.createGain();
    snapGain.gain.setValueAtTime(0.4, now);
    snapGain.gain.exponentialRampToValueAtTime(0.001, now + snapDur);
    snapSrc.connect(snapFilter);
    snapFilter.connect(snapGain);
    snapGain.connect(this.physicalBus);
    snapSrc.start(now);
    snapSrc.stop(now + snapDur);

    // Layer 2: Tension release whip (descending tone)
    const whipOsc = ctx.createOscillator();
    whipOsc.type = 'sawtooth';
    whipOsc.frequency.setValueAtTime(2000, now);
    whipOsc.frequency.exponentialRampToValueAtTime(100, now + 0.25);
    const whipGain = ctx.createGain();
    whipGain.gain.setValueAtTime(0.15, now);
    whipGain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    whipOsc.connect(whipGain);
    whipGain.connect(this.physicalBus);
    whipOsc.start(now);
    whipOsc.stop(now + 0.3);

    // Layer 3: Low rumble fade (sub-bass)
    const rumbleOsc = ctx.createOscillator();
    rumbleOsc.type = 'sine';
    rumbleOsc.frequency.value = 50;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.setValueAtTime(0.2, now + 0.05);
    rumbleGain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
    rumbleOsc.connect(rumbleGain);
    rumbleGain.connect(this.physicalBus);
    rumbleOsc.start(now + 0.05);
    rumbleOsc.stop(now + 0.8);
  }

  /**
   * Fail buzz — error buzz for arm capture failure
   * @param {number} [dur=0.3]
   */
  playFailBuzz(dur = 0.3) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 150;

    // Gain: 0→0.15 in 10ms, hold 200ms, 0.15→0 in remaining time
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.01);
    gain.gain.setValueAtTime(0.15, now + 0.21);
    gain.gain.linearRampToValueAtTime(0, now + dur);

    osc.connect(gain);
    gain.connect(this.alarmBus);
    osc.start(now);
    osc.stop(now + dur);
  }

  /**
   * Short dry "no-go" click for empty-inventory actions (e.g. NET at 0).
   * Real-time audio — uses dt, not gameDt. Under 200 ms total.
   */
  playClickFail() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.12;

    // Low-pitched square blip — deliberate "denied" character
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.linearRampToValueAtTime(110, now + dur);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.005);
    gain.gain.setValueAtTime(0.18, now + 0.04);
    gain.gain.linearRampToValueAtTime(0, now + dur);

    osc.connect(gain);
    gain.connect(this.denyBus);
    osc.start(now);
    osc.stop(now + dur);
  }

  /**
   * Dramatic retrograde deorbit burn sound — descending rumble + alert tone (Session 10).
   * Represents arm sacrificing all remaining fuel.
   * @param {number} [dur=2.5] - Duration in seconds
   */
  playDeorbitBurn(dur = 2.5) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Deep rumble: filtered noise descending
    const bufferSize = ctx.sampleRate * dur;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, now);
    filter.frequency.linearRampToValueAtTime(100, now + dur);
    filter.Q.value = 3;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0, now);
    noiseGain.gain.linearRampToValueAtTime(0.2, now + 0.15);
    noiseGain.gain.setValueAtTime(0.2, now + dur * 0.7);
    noiseGain.gain.linearRampToValueAtTime(0, now + dur);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(this.physicalBus);
    noise.start(now);
    noise.stop(now + dur);

    // Alert tone: descending warning pulse
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(400, now);
    osc.frequency.linearRampToValueAtTime(80, now + dur);

    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0, now);
    oscGain.gain.linearRampToValueAtTime(0.08, now + 0.1);
    oscGain.gain.setValueAtTime(0.08, now + dur * 0.6);
    oscGain.gain.linearRampToValueAtTime(0, now + dur);

    osc.connect(oscGain);
    oscGain.connect(this.physicalBus);
    osc.start(now);
    osc.stop(now + dur);
  }

  // ==========================================================================
  // PHASE R8 — NEW SOUND METHODS
  // ==========================================================================

  /**
   * Ascending step tone for fuel cycling with T key.
   * Each fuel type gets one step higher.
   * @param {number} [stepIndex=0]
   */
  playFuelCycle(stepIndex = 0) {
    if (!this.available) return;
    const freqs = Constants.AUDIO.EARCON_FREQUENCIES.CYCLE;
    const freq = freqs[stepIndex % freqs.length];

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.08, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(this.tickBus);
    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + 0.12);
  }

  /**
   * Soft mechanical "clunk" when cargo is stored — 100→60Hz thud.
   */
  playCargoStored() {
    if (!this.available) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(100, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(60, this.ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(this.physicalBus);
    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + 0.15);
  }

  /**
   * Metallic anvil ping for forge completion — G5 with inharmonic overtone.
   */
  playForgeComplete() {
    if (!this.available) return;
    const now = this.ctx.currentTime;

    // Main ping
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 784; // G5
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

    // Overtone for metallic character
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = 784 * 2.76; // Inharmonic partial for metallic ring
    const gain2 = this.ctx.createGain();
    gain2.gain.setValueAtTime(0.06, now);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

    osc.connect(gain);
    osc2.connect(gain2);
    gain.connect(this.rewardBus);
    gain2.connect(this.rewardBus);
    osc.start(now);
    osc2.start(now);
    osc.stop(now + 0.7);
    osc2.stop(now + 0.5);
  }

  /**
   * Softer single-note "ding" for trawl auto-captures (C5).
   * Distinct from manual capture's ascending triad.
   */
  playTrawlCapture() {
    if (!this.available) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 523; // C5
    gain.gain.setValueAtTime(0.08, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.25);
    osc.connect(gain);
    gain.connect(this.rewardBus);
    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + 0.3);
  }

  // ==========================================================================
  // AMBIENT ENGINE ROOM LOOP (Phase R8)
  // ==========================================================================

  /**
   * Start persistent ambient "engine room" loop — bandpass-filtered white noise
   * for fans/coolant hum + solar hiss layer.
   */
  startAmbientLoop() {
    if (!this.available || this._ambientActive) return;
    this._ambientActive = true;
    // §13 boot timeline — mark exactly when the ambient loop kicks in so
    // the user can correlate fan-on with this event in `?logBoot=1` output.
    try {
      // eslint-disable-next-line no-undef
      if (typeof window !== 'undefined') window.__bootMark?.('startAmbientLoop(). 2 buffer sources + 2 filters going live');
    } catch (_e) { /* swallow */ }

    // White noise via buffer for fans/coolant
    const bufferSize = this.ctx.sampleRate * 2;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    this._ambientNoise = this.ctx.createBufferSource();
    this._ambientNoise.buffer = noiseBuffer;
    this._ambientNoise.loop = true;

    // Bandpass filter: 100-400 Hz (fans/coolant hum)
    this._ambientFilter = this.ctx.createBiquadFilter();
    this._ambientFilter.type = 'bandpass';
    this._ambientFilter.frequency.value = 200;
    this._ambientFilter.Q.value = 0.5;

    this._ambientGain = this.ctx.createGain();
    this._ambientGain.gain.value = Constants.AUDIO.AMBIENT_GAIN;

    // Solar hiss: higher frequency noise (when in sunlight)
    this._solarNoise = this.ctx.createBufferSource();
    this._solarNoise.buffer = noiseBuffer;
    this._solarNoise.loop = true;

    this._solarFilter = this.ctx.createBiquadFilter();
    this._solarFilter.type = 'bandpass';
    this._solarFilter.frequency.value = 3000;
    this._solarFilter.Q.value = 1;

    this._solarGain = this.ctx.createGain();
    this._solarGain.gain.value = 0.005;

    // Connect chains
    this._ambientNoise.connect(this._ambientFilter);
    this._ambientFilter.connect(this._ambientGain);
    this._ambientGain.connect(this.padBus);

    this._solarNoise.connect(this._solarFilter);
    this._solarFilter.connect(this._solarGain);
    this._solarGain.connect(this.padBus);

    this._ambientNoise.start();
    this._solarNoise.start();
  }

  /**
   * Stop ambient loop with fade-out. Safe to call when not started.
   */
  stopAmbientLoop() {
    if (!this._ambientActive) return;
    this._ambientActive = false;

    const now = this.ctx.currentTime;
    if (this._ambientGain) {
      this._ambientGain.gain.linearRampToValueAtTime(0, now + 0.5);
    }
    if (this._solarGain) {
      this._solarGain.gain.linearRampToValueAtTime(0, now + 0.5);
    }

    timerManager.setTimeout(() => {
      try {
        if (this._ambientNoise) { this._ambientNoise.stop(); this._ambientNoise = null; }
        if (this._solarNoise) { this._solarNoise.stop(); this._solarNoise = null; }
      } catch(e) { /* already stopped */ }
      this._ambientFilter = null;
      this._ambientGain = null;
      this._solarFilter = null;
      this._solarGain = null;
    }, 600, { owner: this });
  }

  /**
   * Update ambient sound state based on ship systems.
   * @param {{ solarRate: number, batteryPct: number, forgeActive: boolean }} state
   */
  updateAmbientState(state) {
    if (!this._ambientActive) return;

    const now = this.ctx.currentTime;

    // Solar hiss tied to solar rate (0 in shadow, up to 0.005 in sunlight)
    if (this._solarGain) {
      const solarGain = state.solarRate > 0 ? 0.005 : 0;
      this._solarGain.gain.linearRampToValueAtTime(solarGain, now + 1);
    }

    // Low power: lower filter frequency (fans slowing)
    if (this._ambientFilter) {
      const freq = state.batteryPct > 30 ? 200 : state.batteryPct > 10 ? 120 : 80;
      this._ambientFilter.frequency.linearRampToValueAtTime(freq, now + 2);
    }
  }

  // ==========================================================================
  // FORGE SOUNDS
  // ==========================================================================

  /**
   * Start forge electromagnetic hum — varies by processing phase.
   * @param {'INTAKE'|'SEPARATE'|'MELT'|'COOL'} [phase='MELT']
   */
  startForgeHum(phase = 'MELT') {
    this.stopForgeHum();
    if (!this.available) return;

    try {
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      // Phase-specific frequencies
      const freqs = {
        INTAKE: 120,
        SEPARATE: 200,
        MELT: 280,
        COOL: 90,
      };

      osc.type = 'sawtooth';
      osc.frequency.value = freqs[phase] || 200;

      filter.type = 'lowpass';
      filter.frequency.value = 600;
      filter.Q.value = 2;

      gain.gain.value = 0;
      gain.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 0.5);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.physicalBus);
      osc.start();

      this._forgeOsc = osc;
      this._forgeGain = gain;
      this._forgeFilter = filter;

      // Add crackling for MELT phase
      if (phase === 'MELT') {
        const noise = ctx.createOscillator();
        const noiseGain = ctx.createGain();
        noise.type = 'square';
        noise.frequency.value = 37; // low crackle
        noiseGain.gain.value = 0.015;
        noise.connect(noiseGain);
        noiseGain.connect(this.physicalBus);
        noise.start();
        this._forgeCrackle = noise;
        this._forgeCrackleGain = noiseGain;
      }

      // ── Phase-specific texture layers ──────────────────────────

      // INTAKE: Metallic clank — short noise burst through bandpass
      if (phase === 'INTAKE') {
        const noiseLen = 0.08; // 80ms
        const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * noiseLen, ctx.sampleRate);
        const noiseData = noiseBuf.getChannelData(0);
        for (let i = 0; i < noiseData.length; i++) noiseData[i] = (Math.random() * 2 - 1);

        const noiseSrc = ctx.createBufferSource();
        noiseSrc.buffer = noiseBuf;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 300;
        bp.Q.value = 3;
        const ng = ctx.createGain();
        ng.gain.value = 0.12;

        noiseSrc.connect(bp);
        bp.connect(ng);
        ng.connect(this.physicalBus);
        noiseSrc.start(ctx.currentTime);
      }

      // SEPARATE: Random micro-clicks (magnetic separation texture)
      if (phase === 'SEPARATE') {
        const clickCount = 8;
        for (let i = 0; i < clickCount; i++) {
          const clickTime = ctx.currentTime + Math.random() * 2; // spread over 2s
          const clickLen = 0.015; // 15ms each
          const clickBuf = ctx.createBuffer(1, ctx.sampleRate * clickLen, ctx.sampleRate);
          const clickData = clickBuf.getChannelData(0);
          for (let j = 0; j < clickData.length; j++) clickData[j] = (Math.random() * 2 - 1);

          const clickSrc = ctx.createBufferSource();
          clickSrc.buffer = clickBuf;
          const cg = ctx.createGain();
          cg.gain.value = 0.06;
          clickSrc.connect(cg);
          cg.connect(this.physicalBus);
          clickSrc.start(clickTime);
        }
      }

      // MELT: Random filtered noise bursts (layered on top of 37Hz crackle)
      if (phase === 'MELT') {
        const burstCount = 12;
        for (let i = 0; i < burstCount; i++) {
          const burstTime = ctx.currentTime + Math.random() * 4; // spread over 4s
          const burstLen = 0.03 + Math.random() * 0.04; // 30-70ms
          const burstBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * burstLen), ctx.sampleRate);
          const burstData = burstBuf.getChannelData(0);
          for (let j = 0; j < burstData.length; j++) burstData[j] = (Math.random() * 2 - 1);

          const burstSrc = ctx.createBufferSource();
          burstSrc.buffer = burstBuf;
          const bg = ctx.createGain();
          bg.gain.value = 0.04 + Math.random() * 0.04; // vary intensity
          const blp = ctx.createBiquadFilter();
          blp.type = 'lowpass';
          blp.frequency.value = 800 + Math.random() * 400;
          burstSrc.connect(blp);
          blp.connect(bg);
          bg.connect(this.physicalBus);
          burstSrc.start(burstTime);
        }
      }

      // COOL: Descending sweep — sine 400→80Hz for "powering down" character
      if (phase === 'COOL') {
        const sweepOsc = ctx.createOscillator();
        const sweepGain = ctx.createGain();
        sweepOsc.type = 'sine';
        sweepOsc.frequency.setValueAtTime(400, ctx.currentTime);
        sweepOsc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 3);
        sweepGain.gain.setValueAtTime(0.05, ctx.currentTime);
        sweepGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 4);
        sweepOsc.connect(sweepGain);
        sweepGain.connect(this.physicalBus);
        sweepOsc.start(ctx.currentTime);
        sweepOsc.stop(ctx.currentTime + 4);
        this._forgeSweep = sweepOsc;
        this._forgeSweepGain = sweepGain;
      }
    } catch (e) {
      // Audio not available
    }
  }

  /**
   * Stop forge electromagnetic hum with fade-out.
   */
  stopForgeHum() {
    if (this._forgeOsc) {
      try {
        if (this._forgeGain && this.ctx) {
          this._forgeGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.3);
        }
        const osc = this._forgeOsc;
        const gain = this._forgeGain;
        const filter = this._forgeFilter;
        this._forgeOsc = null;
        this._forgeGain = null;
        this._forgeFilter = null;
        timerManager.setTimeout(() => {
          try { osc.stop(); } catch(e) {}
          try { osc.disconnect(); } catch(e) {}
          try { gain.disconnect(); } catch(e) {}
          try { filter.disconnect(); } catch(e) {}
        }, 350, { owner: this });
      } catch (e) {
        this._forgeOsc = null;
        this._forgeGain = null;
        this._forgeFilter = null;
      }
    }
    if (this._forgeCrackle) {
      try {
        if (this._forgeCrackleGain && this.ctx) {
          this._forgeCrackleGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.2);
        }
        const crackle = this._forgeCrackle;
        const crackleGain = this._forgeCrackleGain;
        this._forgeCrackle = null;
        this._forgeCrackleGain = null;
        timerManager.setTimeout(() => {
          try { crackle.stop(); } catch(e) {}
          try { crackle.disconnect(); } catch(e) {}
          try { crackleGain.disconnect(); } catch(e) {}
        }, 250, { owner: this });
      } catch (e) {
        this._forgeCrackle = null;
        this._forgeCrackleGain = null;
      }
    }
    if (this._forgeSweep) {
      try {
        if (this._forgeSweepGain && this.ctx) {
          this._forgeSweepGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.2);
        }
        const sweep = this._forgeSweep;
        const sweepGain = this._forgeSweepGain;
        this._forgeSweep = null;
        this._forgeSweepGain = null;
        timerManager.setTimeout(() => {
          try { sweep.stop(); } catch(e) {}
          try { sweep.disconnect(); } catch(e) {}
          try { sweepGain.disconnect(); } catch(e) {}
        }, 250, { owner: this });
      } catch (e) {
        this._forgeSweep = null;
        this._forgeSweepGain = null;
      }
    }
  }

  // ==========================================================================
  // PERSISTENT / LOOPING SOUNDS
  // ==========================================================================

  /**
   * Start continuous thruster hum with directional sound differentiation.
   * @param {'ion'|'coldgas'} [type='ion']
   * @param {'prograde'|'retrograde'|'lateral'} [direction='prograde']
   * @param {number} [intensity=1.0] — gain multiplier. Use 0.4 for arm-pilot
   *   FEEP thrusters (much smaller engines than the mothership main bus).
   */
  startThrusterHum(type = 'ion', direction = 'prograde', intensity = 1.0) {
    if (!this.available) return;

    // If already playing, check if direction/intensity/type changed — restart if so
    if (this.activeSources.has('thruster')) {
      const existing = this.activeSources.get('thruster');
      if (existing._direction === direction
          && existing.type === type
          && existing._intensity === intensity) return;
      // Something changed — stop and restart
      this.stopThrusterHum();
    }

    const ctx = this.ctx;
    const now = ctx.currentTime;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    const nodes = [];

    if (type === 'ion') {
      const osc1 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.value = 80;
      osc1.connect(gain);
      osc1.start(now);
      nodes.push(osc1);

      const osc2 = ctx.createOscillator();
      osc2.type = 'triangle';
      osc2.frequency.value = 120;
      osc2.connect(gain);
      osc2.start(now);
      nodes.push(osc2);

      const baseGain = 0.08 * intensity;
      gain.gain.linearRampToValueAtTime(baseGain, now + 0.2);
      // Phase R9: store base gain for sputtering reference
      this._thrusterBaseGain = baseGain;
    } else if (type === 'coldgas') {
      // White noise buffer (2 seconds, looping)
      const bufferSize = ctx.sampleRate * 2;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const channelData = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        channelData[i] = Math.random() * 2 - 1;
      }

      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      noise.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 400;
      filter.Q.value = 2;

      noise.connect(filter);
      filter.connect(gain);
      noise.start(now);
      nodes.push(noise);
      nodes.push(filter);

      const baseGain = 0.06 * intensity;
      gain.gain.linearRampToValueAtTime(baseGain, now + 0.1);
      // Phase R9: store base gain for sputtering reference
      this._thrusterBaseGain = baseGain;
    }

    // Phase R9: store reference to thruster gain node for sputtering
    this._thrusterGain = gain;

    // Phase 1: Retrograde braking pulse — LFO amplitude modulation
    let retroLfo = null;
    let retroLfoGain = null;
    if (direction === 'retrograde') {
      retroLfo = ctx.createOscillator();
      retroLfoGain = ctx.createGain();
      retroLfo.frequency.value = 4;    // 4 Hz pulse
      retroLfoGain.gain.value = 0.3;   // ±30% modulation depth
      retroLfo.connect(retroLfoGain);
      retroLfoGain.connect(gain.gain); // AM modulation on main gain
      retroLfo.start(now);
      nodes.push(retroLfo);
    }

    gain.connect(this.physicalBus);
    this.activeSources.set('thruster', { nodes, gain, type, _direction: direction, _intensity: intensity, _retroLfo: retroLfo });
  }

  /**
   * Stop continuous thruster hum with fade-out.
   */
  stopThrusterHum() {
    if (!this.activeSources.has('thruster')) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const entry = this.activeSources.get('thruster');

    // Phase R9: stop sputtering when thruster hum stops
    this._stopSputtering();
    this._thrusterGain = null;

    entry.gain.gain.cancelScheduledValues(now);
    entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
    entry.gain.gain.linearRampToValueAtTime(0, now + 0.15);

    // Clean up retrograde LFO if present
    if (entry._retroLfo) {
      try { entry._retroLfo.stop(); } catch (_) { /* already stopped */ }
      entry._retroLfo = null;
    }

    timerManager.setTimeout(() => {
      entry.nodes.forEach((node) => {
        try { node.stop(); } catch (_) { /* not a source node */ }
        try { node.disconnect(); } catch (_) { /* already disconnected */ }
      });
      try { entry.gain.disconnect(); } catch (_) { /* already disconnected */ }
    }, 150, { owner: this });

    this.activeSources.delete('thruster');
  }

  // ==========================================================================
  // PHASE R9 — 4-TIER ΔV ALARM SYSTEM
  // ==========================================================================

  /**
   * Update ΔV alarm state. Called at 10Hz from HUD update via DELTAV_UPDATE event.
   * Tier: 0=none, 1=single beep/15s, 2=double beep/8s, 3=triple beep/3s, 4=continuous warble.
   * @param {number} dvPct — Current ΔV as percentage (0-1)
   * @param {number} [predictedPct] — Predicted ΔV after matching target (0-1), optional
   */
  updateDeltaVAlarm(dvPct, predictedPct) {
    if (!this.available) return;

    // Use the lower of current or predicted percentage for tier determination
    let tier = 0;
    const pct = Math.min(dvPct, predictedPct != null ? predictedPct : dvPct);

    if (pct <= 0.01) tier = 4;        // <1%: continuous warbling
    else if (pct <= 0.05) tier = 3;    // <5%: triple beep every 3s
    else if (pct <= 0.15) tier = 2;    // <15%: double beep every 8s
    else if (pct <= 0.30) tier = 1;    // <30%: single beep every 15s

    // Idempotent: if tier unchanged, do nothing
    if (tier === this._dvAlarmTier) return;

    this._dvAlarmTier = tier;
    this._stopDvAlarm();

    // P2 ducking: sustain a duck hold while the ΔV alarm is at tier ≥ 2 so the
    // beeps read clearly over the mix. Symmetric on/off keyed off _dvDucked so
    // the re-entrancy counter never leaks a hold.
    const wantDuck = tier >= 2;
    if (wantDuck && !this._dvDucked) {
      this._dvDucked = true;
      this._duckOthers(true);
    } else if (!wantDuck && this._dvDucked) {
      this._dvDucked = false;
      this._duckOthers(false);
    }

    if (tier === 0) return;

    if (tier === 4) {
      // Continuous warbling tone for <1% ΔV
      this._startContinuousAlarm();
    } else {
      // Periodic beeps: tier 1=single, 2=double, 3=triple
      const intervals = Constants.HUD.DV_ALARM_INTERVALS;
      const intervalSec = intervals[tier - 1] || 15;
      // PR 5 / P2.8: TimerManager-tracked interval (owner=this).
      // _dvAlarmInterval now stores the TimerManager id; teardown via
      // timerManager.clear() in _stopDvAlarm().
      this._dvAlarmInterval = timerManager.setInterval(() => {
        this._playAlarmBeeps(tier);
      }, intervalSec * 1000, { owner: this });
      // Play first beep pattern immediately
      this._playAlarmBeeps(tier);
    }
  }

  /**
   * Legacy stop — force-resets alarm tier for backward compatibility.
   */
  stopDeltaVAlarm() {
    this._dvAlarmTier = -1; // Force reset on next updateDeltaVAlarm call
    this.updateDeltaVAlarm(1.0); // Full fuel = no alarm
  }

  /** @private Play N beeps for the given tier (1=single, 2=double, 3=triple) */
  _playAlarmBeeps(count) {
    if (!this.available) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < count; i++) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      // Higher pitch for more urgent tiers
      osc.frequency.value = 1500 + (count - 1) * 300;
      const start = now + i * 0.18;
      gain.gain.setValueAtTime(Constants.AUDIO.ALERT_GAIN, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.12);
      osc.connect(gain);
      gain.connect(this.alarmBus);
      osc.start(start);
      osc.stop(start + 0.15);
    }
  }

  /** @private Start continuous warbling alarm for <1% ΔV */
  _startContinuousAlarm() {
    if (!this.available) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();

    osc.type = 'square';
    osc.frequency.value = 2400;

    // LFO modulates frequency for warbling effect
    lfo.type = 'sine';
    lfo.frequency.value = 4; // 4Hz warble
    lfoGain.gain.value = 200; // ±200Hz variation

    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);

    gain.gain.value = Constants.AUDIO.ALERT_GAIN * 0.7;
    osc.connect(gain);
    gain.connect(this.alarmBus);

    osc.start();
    lfo.start();

    this._dvAlarmOsc = osc;
    this._dvAlarmLfo = lfo;
    this._dvAlarmGain = gain;
  }

  /** @private Stop any active ΔV alarm (interval beeps or continuous warble) */
  _stopDvAlarm() {
    if (this._dvAlarmInterval) {
      timerManager.clear(this._dvAlarmInterval);
      this._dvAlarmInterval = null;
    }
    if (this._dvAlarmOsc) {
      try {
        if (this._dvAlarmGain) {
          this._dvAlarmGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.1);
        }
        const osc = this._dvAlarmOsc;
        const lfo = this._dvAlarmLfo;
        timerManager.setTimeout(() => {
          try { osc.stop(); } catch(e) {}
          try { lfo.stop(); } catch(e) {}
        }, 150, { owner: this });
      } catch(e) {}
      this._dvAlarmOsc = null;
      this._dvAlarmLfo = null;
      this._dvAlarmGain = null;
    }
  }

  // ==========================================================================
  // PHASE R9 — THRUSTER SPUTTERING
  // ==========================================================================

  /**
   * Update thruster audio state based on current fuel level.
   * When fuel < 10%, introduces random gain dropouts (sputtering).
   * @param {number} fuelPct — Current fuel percentage (0-100)
   */
  updateThrusterFuelState(fuelPct) {
    if (!this.available || !this._thrusterGain) return;

    if (fuelPct < 10 && !this._thrusterSputtering) {
      // Start sputtering: random gain dropouts
      this._thrusterSputtering = true;
      // PR 5 / P2.8: TimerManager-tracked sputter interval.
      this._sputterInterval = timerManager.setInterval(() => {
        if (!this._thrusterGain) { this._stopSputtering(); return; }
        const now = this.ctx.currentTime;
        // Random dropout: gain drops to near-zero briefly
        this._thrusterGain.gain.setValueAtTime(0.01, now);
        const resumeTime = now + 0.03 + Math.random() * 0.08;
        this._thrusterGain.gain.setValueAtTime(this._thrusterBaseGain || 0.06, resumeTime);
      }, 150 + Math.random() * 200, { owner: this });
    } else if (fuelPct >= 10 && this._thrusterSputtering) {
      this._stopSputtering();
    }
  }

  /** @private Stop sputtering effect and restore stable gain */
  _stopSputtering() {
    this._thrusterSputtering = false;
    if (this._sputterInterval) {
      timerManager.clear(this._sputterInterval);
      this._sputterInterval = null;
    }
  }

  // ==========================================================================
  // PHASE 8 — AUDIO & POLISH (FINAL JUICE)
  // ==========================================================================

  /**
   * Approach beep — pitch increases as arm nears target.
   * Far (0.7-1.0): 400Hz quiet | Mid (0.3-0.7): 600Hz | Close (0.1-0.3): 800Hz | Final (<0.1): 1000Hz
   * @param {number} distanceFraction — 0.0 = at target, 1.0 = far away
   */
  playApproachBeep(distanceFraction) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Map distance to frequency and volume
    let freq, vol;
    if (distanceFraction < 0.1) { freq = 1000; vol = 0.14; }
    else if (distanceFraction < 0.3) { freq = 800; vol = 0.11; }
    else if (distanceFraction < 0.7) { freq = 600; vol = 0.08; }
    else { freq = 400; vol = 0.05; }

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const gain = ctx.createGain();
    // Short envelope: 50ms attack, 100ms release
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    osc.connect(gain);
    gain.connect(this.pingBus);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  /**
   * Tether tension — low creak/groan that intensifies with strain.
   * Light (0.3-0.5): quiet creak | Medium (0.5-0.8): groaning | Heavy (0.8-1.0): stressed cable
   * @param {number} tensionFraction — 0.0 = slack, 1.0 = max tension
   */
  playTetherTension(tensionFraction) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const t = Math.max(0, Math.min(1, tensionFraction));

    if (t < 0.5) {
      // Light: filtered noise creak (100-200Hz)
      const dur = 0.3;
      const bufSize = Math.ceil(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < bufSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSize * 0.4));
      }
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 150;
      filter.Q.value = 3;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.physicalBus);
      noise.start(now);
      noise.stop(now + dur);
    } else if (t < 0.8) {
      // Medium: sawtooth + lowpass groaning (150Hz)
      const dur = 0.5;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 100 + (t - 0.5) * 100;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 150;
      filter.Q.value = 4;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.physicalBus);
      osc.start(now);
      osc.stop(now + dur);
    } else {
      // Heavy: noise + sawtooth stressed cable (80-120Hz)
      const dur = 0.8;
      // Noise layer
      const bufSize = Math.ceil(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.value = 100;
      noiseFilter.Q.value = 2;
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.08, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(this.physicalBus);
      noise.start(now);
      noise.stop(now + dur);

      // Sawtooth layer
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(80, now);
      osc.frequency.linearRampToValueAtTime(120, now + dur * 0.5);
      osc.frequency.linearRampToValueAtTime(80, now + dur);
      const oscFilter = ctx.createBiquadFilter();
      oscFilter.type = 'lowpass';
      oscFilter.frequency.value = 200;
      const oscGain = ctx.createGain();
      oscGain.gain.setValueAtTime(0.12, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      osc.connect(oscFilter);
      oscFilter.connect(oscGain);
      oscGain.connect(this.physicalBus);
      osc.start(now);
      osc.stop(now + dur);
    }
  }

  /**
   * Salvage reveal — two-phase loot box moment.
   * Phase 1 (0-500ms): metallic unsealing + pneumatic hiss
   * Phase 2 (500-1500ms): rising chime cascade C5→E5→G5
   */
  playSalvageReveal() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Phase 1A: Metallic unsealing (noise sweep 200→2000Hz, 300ms)
    const sealDur = 0.3;
    const sealBufSize = Math.ceil(ctx.sampleRate * sealDur);
    const sealBuf = ctx.createBuffer(1, sealBufSize, ctx.sampleRate);
    const sealData = sealBuf.getChannelData(0);
    for (let i = 0; i < sealBufSize; i++) sealData[i] = Math.random() * 2 - 1;
    const sealNoise = ctx.createBufferSource();
    sealNoise.buffer = sealBuf;
    const sealFilter = ctx.createBiquadFilter();
    sealFilter.type = 'bandpass';
    sealFilter.Q.value = 2;
    sealFilter.frequency.setValueAtTime(200, now);
    sealFilter.frequency.exponentialRampToValueAtTime(2000, now + sealDur);
    const sealGain = ctx.createGain();
    sealGain.gain.setValueAtTime(0.15, now);
    sealGain.gain.exponentialRampToValueAtTime(0.001, now + sealDur);
    sealNoise.connect(sealFilter);
    sealFilter.connect(sealGain);
    sealGain.connect(this.rewardBus);
    sealNoise.start(now);
    sealNoise.stop(now + sealDur);

    // Phase 1B: Pneumatic hiss (high-passed noise, 100ms)
    const hissDur = 0.1;
    const hissBufSize = Math.ceil(ctx.sampleRate * hissDur);
    const hissBuf = ctx.createBuffer(1, hissBufSize, ctx.sampleRate);
    const hissData = hissBuf.getChannelData(0);
    for (let i = 0; i < hissBufSize; i++) hissData[i] = Math.random() * 2 - 1;
    const hissNoise = ctx.createBufferSource();
    hissNoise.buffer = hissBuf;
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'highpass';
    hissFilter.frequency.value = 4000;
    const hissGain = ctx.createGain();
    hissGain.gain.setValueAtTime(0.1, now + 0.2);
    hissGain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    hissNoise.connect(hissFilter);
    hissFilter.connect(hissGain);
    hissGain.connect(this.rewardBus);
    hissNoise.start(now + 0.2);
    hissNoise.stop(now + 0.35);

    // Phase 2: Rising chime cascade C5→E5→G5 (starting at 500ms)
    const chimeNotes = [523, 659, 784]; // C5, E5, G5
    chimeNotes.forEach((freq, i) => {
      const start = now + 0.5 + i * 0.2;
      // Main tone
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.12, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);
      osc.connect(gain);
      gain.connect(this.rewardBus);
      osc.start(start);
      osc.stop(start + 0.4);

      // Slight detune shimmer
      const osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.value = freq * 1.005; // +5 cents
      const gain2 = ctx.createGain();
      gain2.gain.setValueAtTime(0.06, start);
      gain2.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
      osc2.connect(gain2);
      gain2.connect(this.rewardBus);
      osc2.start(start);
      osc2.stop(start + 0.35);
    });
  }

  /**
   * T10 — menu→sim departure pad swell. A soft, low synth chord that fades in
   * and back out over the camera pull-back, giving the (otherwise silent)
   * departure a sense of motion/lift without a musical stinger. Kept quiet
   * (peak ≈ 0.06) so it sits under the UI click and never masks Houston VO.
   * @param {number} [durationSec=1.35] — total swell length (≈ pull-back time).
   */
  playDepartureSwell(durationSec = 1.35) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = Math.max(0.4, Math.min(3, durationSec));

    // Low chord: root A2, fifth E3, octave A3 — a stable, open "lift" voicing.
    const freqs = [110, 164.81, 220];
    // Shared lowpass so the pad reads warm/soft, opening slightly as it swells.
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(300, now);
    filter.frequency.linearRampToValueAtTime(900, now + dur * 0.55);
    filter.frequency.linearRampToValueAtTime(500, now + dur);

    // Master swell envelope: slow attack, gentle release.
    const swell = ctx.createGain();
    swell.gain.setValueAtTime(0.0001, now);
    swell.gain.linearRampToValueAtTime(0.06, now + dur * 0.5);
    swell.gain.linearRampToValueAtTime(0.0001, now + dur);
    filter.connect(swell);
    swell.connect(this.padBus);

    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'sine' : 'triangle';
      osc.frequency.value = f;
      // Slight per-voice detune for a wider, less synthetic pad.
      osc.detune.value = (i - 1) * 4;
      const vg = ctx.createGain();
      vg.gain.value = i === 0 ? 0.9 : 0.5; // root loudest
      osc.connect(vg);
      vg.connect(filter);
      osc.start(now);
      osc.stop(now + dur + 0.05);
    });
  }

  /**
   * T10 — comms crackle: a short radio-squelch burst + a two-blip "online"
   * confirm, played as the HUD powers on. Signals the comms link coming live
   * alongside the visual power-on stagger. ~0.35 s total, subtle.
   */
  playCommsCrackle() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Squelch burst: bandpass-filtered noise, quick in/out (radio keying).
    const nDur = 0.16;
    const bufSize = Math.ceil(ctx.sampleRate * nDur);
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 4;
    bp.frequency.setValueAtTime(1400, now);
    bp.frequency.exponentialRampToValueAtTime(2200, now + nDur);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, now);
    ng.gain.exponentialRampToValueAtTime(0.09, now + 0.02);
    ng.gain.exponentialRampToValueAtTime(0.001, now + nDur);
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(this.radioBus);
    noise.start(now);
    noise.stop(now + nDur + 0.02);

    // Two-blip "online" confirm after the squelch (comms handshake).
    const blips = [880, 1320];
    blips.forEach((f, i) => {
      const start = now + 0.18 + i * 0.09;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.035, start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.06);
      osc.connect(g);
      g.connect(this.radioBus);
      osc.start(start);
      osc.stop(start + 0.07);
    });
  }

  /**
   * T6 — SAFER cold-gas puff: a tiny highpassed-noise "pfft" (~0.05 s, quiet),
   * layered under the departure pad swell as the astronaut thrusters fire on her
   * jet-off exit. Deliberately subtle — a texture cue, not a bang.
   */
  playEvaPuff() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.06;
    const bufSize = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    // Highpass ~3 kHz → thin, gassy hiss rather than a low thud.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    hp.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.045, now + 0.008); // quiet, fast attack
    g.gain.exponentialRampToValueAtTime(0.0008, now + dur);
    noise.connect(hp);
    hp.connect(g);
    g.connect(this.physicalBus);
    noise.start(now);
    noise.stop(now + dur + 0.02);
  }

  /**
   * Weather alert earcons — distinct sound per weather type.
   * @param {string} type — 'solar_flare', 'geomagnetic', 'saa', 'eclipse'
   */
  playWeatherAlert(type) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    switch (type) {
      case 'SOLAR_FLARE': {
        // Rapid high warble (800Hz oscillating ±100Hz at 8Hz, 400ms)
        const dur = 0.4;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 800;
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 8;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 100;
        lfo.connect(lfoGain);
        lfoGain.connect(osc.frequency);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
        osc.connect(gain);
        gain.connect(this.alarmBus);
        osc.start(now);
        lfo.start(now);
        osc.stop(now + dur);
        lfo.stop(now + dur);
        break;
      }
      case 'GEOMAGNETIC_STORM': {
        // Deep pulsing (60Hz amplitude-modulated at 2Hz, 600ms)
        const dur = 0.6;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 60;
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 2;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 0.08;
        lfo.connect(lfoGain);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.1, now);
        lfoGain.connect(gain.gain);
        gain.gain.linearRampToValueAtTime(0.001, now + dur);
        osc.connect(gain);
        gain.connect(this.alarmBus);
        osc.start(now);
        lfo.start(now);
        osc.stop(now + dur);
        lfo.stop(now + dur);
        break;
      }
      case 'SAA_PASSAGE': {
        // Stuttering static (burst noise, 50ms on / 50ms off × 4, 400ms)
        for (let i = 0; i < 4; i++) {
          const start = now + i * 0.1;
          const burstDur = 0.05;
          const bufSize = Math.ceil(ctx.sampleRate * burstDur);
          const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
          const data = buf.getChannelData(0);
          for (let j = 0; j < bufSize; j++) data[j] = Math.random() * 2 - 1;
          const noise = ctx.createBufferSource();
          noise.buffer = buf;
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0.12, start);
          gain.gain.exponentialRampToValueAtTime(0.001, start + burstDur);
          noise.connect(gain);
          gain.connect(this.alarmBus);
          noise.start(start);
          noise.stop(start + burstDur);
        }
        break;
      }
      case 'ECLIPSE_ENTRY': {
        // Descending tone (1000→200Hz sweep, 800ms, quiet)
        const dur = 0.8;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1000, now);
        osc.frequency.exponentialRampToValueAtTime(200, now + dur);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
        osc.connect(gain);
        gain.connect(this.alarmBus);
        osc.start(now);
        osc.stop(now + dur);
        break;
      }
      default: {
        // Generic chirp for unknown types
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 600;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.connect(gain);
        gain.connect(this.alarmBus);
        osc.start(now);
        osc.stop(now + 0.2);
      }
    }
  }

  /**
   * Codex unlock — gentle two-note ascending chime (D5→A5 base, transposed by
   * a deterministic per-category pentatonic offset via {@link codexChimeNotes}).
   * Light and informative, not disruptive.
   * @param {string} [category] - codex category key for the tonal variant.
   */
  playCodexUnlock(category) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const notes = codexChimeNotes(category);
    notes.forEach((freq, i) => {
      const start = now + i * 0.15;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.07, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
      osc.connect(gain);
      gain.connect(this.rewardBus);
      osc.start(start);
      osc.stop(start + 0.3);
    });
  }

  /**
   * Sweep complete — brief success fanfare C4→E4→G4→C5.
   * Sawtooth + sine blend with echo tail via delay node.
   */
  playSweepComplete() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Delay node for reverb tail
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.15;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.3;
    delay.connect(feedback);
    feedback.connect(delay);
    const delayGain = ctx.createGain();
    delayGain.gain.value = 0.4;
    delay.connect(delayGain);
    delayGain.connect(this.rewardBus);

    const notes = [262, 330, 392, 523]; // C4, E4, G4, C5
    notes.forEach((freq, i) => {
      const start = now + i * 0.15;
      // Sawtooth layer
      const saw = ctx.createOscillator();
      saw.type = 'sawtooth';
      saw.frequency.value = freq;
      const sawGain = ctx.createGain();
      sawGain.gain.setValueAtTime(0.06, start);
      sawGain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
      saw.connect(sawGain);
      sawGain.connect(this.rewardBus);
      sawGain.connect(delay); // feed into echo
      saw.start(start);
      saw.stop(start + 0.3);

      // Sine layer
      const sin = ctx.createOscillator();
      sin.type = 'sine';
      sin.frequency.value = freq;
      const sinGain = ctx.createGain();
      sinGain.gain.setValueAtTime(0.08, start);
      sinGain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
      sin.connect(sinGain);
      sinGain.connect(this.rewardBus);
      sinGain.connect(delay); // feed into echo
      sin.start(start);
      sin.stop(start + 0.35);
    });

    // Auto-cleanup delay nodes after fanfare + echo tail
    timerManager.setTimeout(() => {
      try {
        delay.disconnect();
        feedback.disconnect();
        delayGain.disconnect();
      } catch (e) { /* already disconnected */ }
    }, 2500, { owner: this });
  }

  // ==========================================================================
  // CONJUNCTION ALERT BEEPS (Sprint C1)
  // ==========================================================================

  /**
   * Conjunction alert beeps — tiered urgency.
   * GREEN:  single soft beep  (800 Hz, 100 ms)
   * YELLOW: double beep       (1200 Hz, 80 ms × 2, 100 ms gap)
   * RED:    urgent triple beep (1600 Hz, 60 ms × 3, 60 ms gap) + distortion
   * @param {string} tier — 'GREEN' | 'YELLOW' | 'RED'
   */
  playConjunctionAlert(tier) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const configs = {
      GREEN:  { freq: 800,  dur: 0.10, count: 1, gap: 0,    gain: 0.10, type: 'sine'   },
      YELLOW: { freq: 1200, dur: 0.08, count: 2, gap: 0.10, gain: 0.14, type: 'sine'   },
      RED:    { freq: 1600, dur: 0.06, count: 3, gap: 0.06, gain: 0.18, type: 'square' },
    };
    const cfg = configs[tier] || configs.GREEN;

    // P2 ducking: RED conjunction is act-now danger — duck the mix for 2 s.
    if (tier === 'RED') this._duckPulse(2000);

    for (let i = 0; i < cfg.count; i++) {
      const start = now + i * (cfg.dur + cfg.gap);

      const osc = ctx.createOscillator();
      osc.type = cfg.type;
      osc.frequency.value = cfg.freq;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(cfg.gain, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + cfg.dur);

      // RED tier: waveshaper distortion for urgency
      if (tier === 'RED') {
        const shaper = ctx.createWaveShaper();
        const curve = new Float32Array(256);
        for (let j = 0; j < 256; j++) {
          const x = (j / 128) - 1;
          curve[j] = (Math.PI + 3) * x / (Math.PI + 3 * Math.abs(x));
        }
        shaper.curve = curve;
        shaper.oversample = '2x';
        osc.connect(shaper);
        shaper.connect(gain);
      } else {
        osc.connect(gain);
      }

      gain.connect(this.alarmBus);
      osc.start(start);
      osc.stop(start + cfg.dur + 0.01);
    }
  }

  // ==========================================================================
  // PHASE 6 — LASSO FEEDBACK SOUNDS
  // ==========================================================================

  /**
   * Lasso fire — electromagnetic "THWIP" (noise burst + resonant filter sweep, 150ms).
   * Replaces the generic click for lasso launch.
   */
  playLassoFire() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.15;

    // Layer 1: Noise burst through resonant bandpass (the "snap")
    const bufSize = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufSize * 0.3));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(2000, now);
    filter.frequency.exponentialRampToValueAtTime(400, now + dur);
    filter.Q.value = 8; // High resonance for electromagnetic character
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.25, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(this.physicalBus);
    noise.start(now);
    noise.stop(now + dur);

    // Layer 2: Short descending tone for electromagnetic character
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, now);
    osc.frequency.exponentialRampToValueAtTime(200, now + dur);
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.12, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(oscGain);
    oscGain.connect(this.physicalBus);
    osc.start(now);
    osc.stop(now + dur);
  }

  /**
   * Start continuous wire-whistle during lasso flight — filtered noise at 800Hz, very low volume.
   */
  startLassoWireWhistle() {
    this.stopLassoWireWhistle(); // Stop any existing
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Looping noise buffer
    const bufSize = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const bufData = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) bufData[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 800;
    filter.Q.value = 6;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.03, now + 0.1); // Very low volume

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.physicalBus);
    noise.start(now);

    this._lassoWhistleNodes = { noise, filter, gain };
  }

  /**
   * Stop wire-whistle sound with fade-out.
   */
  stopLassoWireWhistle() {
    if (!this._lassoWhistleNodes) return;
    const { noise, gain } = this._lassoWhistleNodes;
    try {
      if (this.ctx) {
        gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.1);
      }
      const n = noise;
      timerManager.setTimeout(() => {
        try { n.stop(); } catch (e) { /* already stopped */ }
        try { n.disconnect(); } catch (e) { /* already disconnected */ }
      }, 150, { owner: this });
    } catch (e) { /* audio not available */ }
    this._lassoWhistleNodes = null;
  }

  /**
   * Lasso winch/reel — mechanical rising-pitch filtered noise, 500ms.
   * Plays during reel-in phase after contact.
   */
  playLassoWinch() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.5;

    // Noise source
    const bufSize = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;

    // Rising bandpass filter (200Hz → 1200Hz)
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(200, now);
    filter.frequency.exponentialRampToValueAtTime(1200, now + dur);
    filter.Q.value = 3;

    // LFO for mechanical ratcheting effect
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 12; // 12Hz rapid mechanical clicking
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.06;
    lfo.connect(lfoGain);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, now);
    lfoGain.connect(gain.gain);
    gain.gain.linearRampToValueAtTime(0.001, now + dur);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.physicalBus);
    noise.start(now);
    lfo.start(now);
    noise.stop(now + dur);
    lfo.stop(now + dur);
  }

  /**
   * Lasso denied — brief buzz when Space pressed during cooldown or no target.
   * 50ms square wave, low pitch.
   */
  playLassoDenied() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.05;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 120; // Low pitch

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.linearRampToValueAtTime(0, now + dur);

    osc.connect(gain);
    gain.connect(this.denyBus);
    osc.start(now);
    osc.stop(now + dur);
  }

  // ==========================================================================
  // PHASE 5 — TARGET LOCK CEREMONY SOUNDS
  // ==========================================================================

  /**
   * Play the lock earcon with a short dedupe window so a manual SELECTED and the
   * follow-up TARGET_IN_RANGE crossing (or any two near-simultaneous triggers)
   * produce exactly ONE "locked on" sound. ~250 ms guard.
   * @private
   */
  _playLockDeduped() {
    const t = (this.ctx && typeof this.ctx.currentTime === 'number') ? this.ctx.currentTime : (Date.now() / 1000);
    if (this._lastLockAt != null && (t - this._lastLockAt) < 0.25) return;
    this._lastLockAt = t;
    this.playTargetLock();
  }

  /**
   * Target lock-on — ascending two-note (C5→E5, 60ms each, sine wave, slight reverb).
   * FS2/MW2 heritage "target acquired" ping.
   */
  playTargetLock() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Ascending two-note: C5 (523Hz) → E5 (659Hz)
    const notes = [523, 659];
    const noteDur = 0.06; // 60ms each

    // Delay node for slight reverb tail
    const delay = ctx.createDelay(0.3);
    delay.delayTime.value = 0.08;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.2;
    delay.connect(feedback);
    feedback.connect(delay);
    const delayGain = ctx.createGain();
    delayGain.gain.value = 0.25;
    delay.connect(delayGain);
    delayGain.connect(this.pingBus);

    // Delay 100ms so visual animation plays before audio confirms (§5.2)
    const lockDelay = 0.1;
    notes.forEach((freq, i) => {
      const start = now + lockDelay + i * noteDur;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.14, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + noteDur + 0.06);
      osc.connect(gain);
      gain.connect(this.pingBus);
      gain.connect(delay); // feed into reverb
      osc.start(start);
      osc.stop(start + noteDur + 0.06);
    });

    // Auto-cleanup delay nodes after reverb tail
    timerManager.setTimeout(() => {
      try {
        delay.disconnect();
        feedback.disconnect();
        delayGain.disconnect();
      } catch (e) { /* already disconnected */ }
    }, 500, { owner: this });
  }

  /**
   * Target lost — descending two-note (E5→C5, 40ms each).
   * Softer and quicker than lock-on to indicate loss.
   */
  playTargetLost() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Descending two-note: E5 (659Hz) → C5 (523Hz)
    const notes = [659, 523];
    const noteDur = 0.04; // 40ms each

    // Delay 100ms so visual animation plays before audio confirms (§5.2)
    const lostDelay = 0.1;
    notes.forEach((freq, i) => {
      const start = now + lostDelay + i * noteDur;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.10, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + noteDur + 0.04);
      osc.connect(gain);
      gain.connect(this.pingBus);
      osc.start(start);
      osc.stop(start + noteDur + 0.04);
    });
  }

  // ==========================================================================
  // Phase 7: DOCKING APPROACH AUDIO
  // ==========================================================================

  /**
   * Play a docking approach beep with explicit frequency and volume.
   * @param {number} freq - Hz
   * @param {number} vol - 0-1
   */
  playDockingBeep(freq, vol) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(gain);
    gain.connect(this.pingBus);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  /** CP-3: transfer-window T-minus cue — two rising cyan blips. */
  playWindowImminent() {
    if (!this.available) return;
    const now = this.ctx.currentTime;
    this._playSineBlip(now,        988, 0.08, 0.20);  // B5
    this._playSineBlip(now + 0.10, 1319, 0.10, 0.22); // E6
  }

  /** CP-3: transfer-window open cue — confirming ascending triad. */
  playWindowOpen() {
    if (!this.available) return;
    const now = this.ctx.currentTime;
    this._playSineBlip(now,        784, 0.12, 0.26);  // G5
    this._playSineBlip(now + 0.12, 988, 0.12, 0.26);  // B5
    this._playSineBlip(now + 0.24, 1319, 0.20, 0.30); // E6 held
  }

  /** Start a sustained 440Hz alignment confirmation tone at vol 0.1. */
  startAlignmentTone() {
    if (!this.available || this._alignmentToneOsc) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 440;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.1, now + 0.3);
    osc.connect(gain);
    gain.connect(this.pingBus);
    osc.start(now);
    this._alignmentToneOsc = osc;
    this._alignmentToneGain = gain;
  }

  /** Stop the sustained alignment confirmation tone. */
  stopAlignmentTone() {
    if (!this._alignmentToneOsc) return;
    const now = this.ctx.currentTime;
    this._alignmentToneGain.gain.linearRampToValueAtTime(0.001, now + 0.2);
    this._alignmentToneOsc.stop(now + 0.25);
    this._alignmentToneOsc = null;
    this._alignmentToneGain = null;
  }

  /** Play autopilot disengage tone: descending 800→400Hz, 500ms fade. */
  playAPDisengage() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(400, now + 0.5);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.linearRampToValueAtTime(0.001, now + 0.5);
    osc.connect(gain);
    gain.connect(this.pingBus);
    osc.start(now);
    osc.stop(now + 0.55);
  }

  /** Play autopilot arrival chime: ascending 400→800→1200Hz triple-beep. */
  playAPArrived() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Three ascending beeps: 400, 800, 1200 Hz
    [400, 800, 1200].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const t = now + i * 0.12;
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.15, t + 0.03);
      gain.gain.linearRampToValueAtTime(0.001, t + 0.1);
      osc.connect(gain);
      gain.connect(this.pingBus);
      osc.start(t);
      osc.stop(t + 0.12);
    });
  }

  // ==========================================================================
  // S3b: MPD BURST MODE SOUNDS
  // ==========================================================================

  /**
   * MPD arm sound — deep capacitor charge-up hum (50 Hz → 200 Hz ramp, 0.5s).
   */
  playMPDArm() {
    if (!this.available) return;
    try {
      const ctx = this.ctx;
      const now = ctx.currentTime;

      // Main charge-up oscillator
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(50, now);
      osc.frequency.exponentialRampToValueAtTime(200, now + 0.5);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.1);
      gain.gain.setValueAtTime(0.12, now + 0.35);
      gain.gain.linearRampToValueAtTime(0.04, now + 0.5);

      // Low-pass filter for warmth
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(300, now);
      filter.frequency.linearRampToValueAtTime(800, now + 0.5);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.physicalBus);
      osc.start(now);
      osc.stop(now + 0.55);
    } catch (e) { /* audio error — non-critical */ }
  }

  /**
   * MPD disarm sound — power-down descending tone (200 Hz → 30 Hz, 0.3s) + relay click.
   */
  playMPDDisarm() {
    if (!this.available) return;
    try {
      const ctx = this.ctx;
      const now = ctx.currentTime;

      // Descending power-down tone
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(200, now);
      osc.frequency.exponentialRampToValueAtTime(30, now + 0.3);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.35);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 400;

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.physicalBus);
      osc.start(now);
      osc.stop(now + 0.4);

      // Relay click (short noise burst)
      const bufferSize = ctx.sampleRate * 0.02;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.1));
      }
      const click = ctx.createBufferSource();
      click.buffer = buffer;
      const clickGain = ctx.createGain();
      clickGain.gain.value = 0.15;
      click.connect(clickGain);
      clickGain.connect(this.physicalBus);
      click.start(now + 0.05);
    } catch (e) { /* audio error — non-critical */ }
  }

  /**
   * MPD overheat alarm — rapid 880 Hz pulses (1s) + steam hiss (white noise burst 0.5s).
   */
  playMPDOverheat() {
    if (!this.available) return;
    this._duckPulse(1500); // P2 ducking: overheat danger
    try {
      const ctx = this.ctx;
      const now = ctx.currentTime;

      // Rapid alarm beeps (880 Hz, 6 pulses over 1s)
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 880;

      const alarmGain = ctx.createGain();
      alarmGain.gain.setValueAtTime(0, now);
      // 6 pulses: on/off every ~0.08s
      for (let i = 0; i < 6; i++) {
        const t = now + i * 0.16;
        alarmGain.gain.setValueAtTime(0.1, t);
        alarmGain.gain.setValueAtTime(0, t + 0.08);
      }

      osc.connect(alarmGain);
      alarmGain.connect(this.alarmBus);
      osc.start(now);
      osc.stop(now + 1.0);

      // Steam hiss (white noise burst)
      const bufferSize = ctx.sampleRate;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.3));
      }
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;

      const hissFilter = ctx.createBiquadFilter();
      hissFilter.type = 'highpass';
      hissFilter.frequency.value = 2000;

      const hissGain = ctx.createGain();
      hissGain.gain.setValueAtTime(0.08, now + 0.1);
      hissGain.gain.linearRampToValueAtTime(0, now + 0.6);

      noise.connect(hissFilter);
      hissFilter.connect(hissGain);
      hissGain.connect(this.alarmBus);
      noise.start(now + 0.1);
    } catch (e) { /* audio error — non-critical */ }
  }

  // ==========================================================================
  // SCAN & CREDIT FEEDBACK SOUNDS
  // ==========================================================================

  /**
   * Scan initiated — radar sweep/ping sound.
   * Rising sine sweep 800→2000Hz over 0.3s with fade envelope.
   */
  playScan() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    // Rising sweep: 800Hz to 2000Hz over 0.3s
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(2000, now + 0.3);

    // Quick fade in, sustain, fade out
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
    gain.gain.setValueAtTime(0.15, now + 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

    osc.connect(gain);
    gain.connect(this.pingBus);
    osc.start(now);
    osc.stop(now + 0.5);
  }

  /**
   * Cash register "ka-ching" — two quick metallic triangle-wave tones.
   * Plays when credits are awarded (SCORING_AWARD event).
   */
  playCashRegister() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Two quick metallic tones
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(i === 0 ? 1200 : 1800, now + i * 0.08);
      gain.gain.setValueAtTime(0, now + i * 0.08);
      gain.gain.linearRampToValueAtTime(0.2, now + i * 0.08 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.15);
      osc.connect(gain);
      gain.connect(this.rewardBus);
      osc.start(now + i * 0.08);
      osc.stop(now + i * 0.08 + 0.15);
    }
  }
  // ==========================================================================
  // ST-3.4: SKILL CELEBRATION SOUNDS
  // ==========================================================================

  /**
   * Internal helper: sine tone with attack-decay envelope, routed through sfxBus.
   * @param {number} startTime — AudioContext time to begin
   * @param {number} freq — Frequency in Hz
   * @param {number} dur — Duration in seconds
   * @param {number} peakGain — Peak gain (0–1)
   * @private
   */
  _playSineBlip(startTime, freq, dur, peakGain, dest) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + dur);
    // Shared helper across families — REWARD chimes by default, PING for the
    // range ticker (P6). Caller passes an explicit family bus when needed.
    osc.connect(gain).connect(dest || this.rewardBus || this.sfxBus);
    osc.start(startTime);
    osc.stop(startTime + dur + 0.02);
  }

  /** Soft ascending chime for PRACTICED state transitions. ~150 ms, pitched higher than playClick. */
  playPracticeChime() {
    if (!this.available) return;
    const now = this.ctx.currentTime;
    // Two-note ascending sine: 880 Hz → 1320 Hz, 80 ms apart, short decay
    this._playSineBlip(now,        880, 0.08, 0.18);
    this._playSineBlip(now + 0.08, 1320, 0.10, 0.22);
  }

  /** Celebratory 3-note arpeggio for MASTERED transitions. ~650 ms total. */
  playMasteryFanfare() {
    if (!this.available) return;
    const now = this.ctx.currentTime;
    // Triad arpeggio: C5 → E5 → G5 (523→659→784 Hz), each with slight overlap
    this._playSineBlip(now,        523, 0.18, 0.32);
    this._playSineBlip(now + 0.14, 659, 0.18, 0.32);
    this._playSineBlip(now + 0.28, 784, 0.28, 0.40); // held longer for finale
  }

  /**
   * Delegation 2 (2026-05-31) — soft "hint posted" notification cue.
   * Startup-legibility rework (2026-07-23): a gentle, longer, lower triangle
   * swell (~520→660 Hz, ~350 ms, soft attack) so it reads as a "gentle
   * notification" rather than another UI click in the startup blip family.
   * Quiet enough to fade into the ambient mix; peak gain capped at ~0.15.
   * @param {number} [volume=0.4] — caller-side scale; clamped to [0, 1].
   */
  playHintPost(volume = 0.4) {
    if (!this.available || !this.ctx) return;
    // Delegation 4 (2026-05-31) — P1-1 fix: bail early when the AudioContext
    // is suspended (AutoplayPolicy first-frame race). Scheduled oscillators
    // would otherwise queue up and trigger a delayed click whenever the user
    // first interacts. AudioCue is fire-and-forget — dropping the first chime
    // is preferable to a glitch.
    if (this.ctx.state !== 'running') return;
    const v = Math.max(0, Math.min(1, volume));
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dest = this.rewardBus || this.sfxBus || this.master || ctx.destination;
    // Two-note rising notification: G4 (392 Hz) → B4 (494 Hz), triangle wave,
    // soft attack and a long decay tail. Total ~350 ms. Deliberately pitched
    // below playTargetLock (C5→E5) so a hint never sounds like a sensor lock.
    const playNote = (freq, startOffset, durSec) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + startOffset);
      const peak = 0.15 * v;
      gain.gain.setValueAtTime(0.0001, now + startOffset);
      // Gentle attack (~50 ms) so it swells rather than clicks.
      gain.gain.exponentialRampToValueAtTime(peak, now + startOffset + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + durSec);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + durSec + 0.02);
    };
    playNote(392, 0.000, 0.24);
    playNote(494, 0.130, 0.34);
  }
}

export const audioSystem = new AudioSystem();
export default audioSystem;
