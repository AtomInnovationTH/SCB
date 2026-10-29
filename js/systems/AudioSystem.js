/**
 * AudioSystem.js — procedural Web Audio sound effects; no external audio files.
 * @module systems/AudioSystem
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { devSearch } from '../core/DevHost.js';
import timerManager from './TimerManager.js';
import { installSoundLog } from './audio/SoundLog.js';
import { clamp01, clamp, lerp } from '../core/MathUtil.js';

// Codex unlock chime: D5→A5 base pair, transposed per category by a small pentatonic offset (pure, unit-testable).
const CODEX_CHIME_BASE = [587, 880]; // D5, A5
const CODEX_PENTATONIC = [0, 2, 4, 7, 9]; // major-pentatonic semitone offsets

/**
 * Deterministic 3-note triad for a codex-unlock chime. The octave-above third note (D6) makes the 3-note LENGTH set
 * it apart from every 2-note cue. Unknown/missing category → base triad.
 */
export function codexChimeNotes(category) {
  const triad = (factor) => [
    CODEX_CHIME_BASE[0] * factor,
    CODEX_CHIME_BASE[1] * factor,
    CODEX_CHIME_BASE[0] * 2 * factor,
  ];
  if (typeof category !== 'string' || category.length === 0) {
    return triad(1);
  }
  let h = 0;
  for (let i = 0; i < category.length; i++) {
    h = (h * 31 + category.charCodeAt(i)) | 0;
  }
  const semi = CODEX_PENTATONIC[Math.abs(h) % CODEX_PENTATONIC.length];
  const factor = Math.pow(2, semi / 12);
  return triad(factor);
}

/**
 * True when a TARGET_SELECTED payload is a pick the GAME made, not the player: a scan's auto-select (autoAcquire,
 * source 'scan'), autolock (autoLock), the legacy welcome auto-target, or the game's own follow-ups (source
 * capture_advance, lesson_pick, onboarding_pick). The autopilot's own re-acquire is not one: it is flying her there.
 */
export function isAutomaticPick(d) {
  if (!d) return false;
  if (d.autoLock || d.autoTarget) return true;
  return (!!d.autoAcquire && d.source === 'scan') || d.source === 'capture_advance' || d.source === 'lesson_pick' || d.source === 'onboarding_pick';
}

export function isRangeTickAutoPick(id, autoPickId) {
  return autoPickId != null && id === autoPickId;
}

/**
 * Daughter-net cue gain scale. Daughter launchers (Medium/Small nets) are heard from their standoff, so every net
 * voice shared with the mother plays at this scale; the mother pod keeps the default (scale omitted ⇒ 1.0,
 * byte-identical). Exported for test-DaughterNetAudio.js.
 */
export const DAUGHTER_NET_GAIN = 0.7;

/**
 * De-dup windows for the daughter catch cue (see the ARM_CAPTURED handler): an ARM_CAPTURED whose debris id matches a
 * net catch voiced within DAUGHTER_CATCH_ECHO_ID_S is the same physical catch (the arm's FSM poll lands 1-2 frames
 * after NET_CATCH_SUCCESS; measured ≤ 34 ms at 60 fps). With no id on either side (headless mocks) only
 * DAUGHTER_CATCH_ECHO_FALLBACK_S applies. Exported for tests.
 */
export const DAUGHTER_CATCH_ECHO_ID_S = 5.0;
export const DAUGHTER_CATCH_ECHO_FALLBACK_S = 1.0;

class AudioSystem {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    // Per-family bus nodes (created in init()).
    this.physicalBus = null;
    this.radioBus = null;
    this.pingBus = null;
    this.tickBus = null;
    this.denyBus = null;
    this.alarmBus = null;
    this.rewardBus = null;
    this.padBus = null;
    // Reserved, silent, unused: future music + TTS narration.
    this.musicBus = null;
    this.voiceBus = null;
    // Re-entrancy counter so overlapping duck requests don't restore early; the voiceBus TTS hook shares it.
    this._duckHolds = 0;
    this._rangeTickerActive = false;
    /** id of a piece the game (scan / autolock) picked: its range ticker stays silent. */
    this._rangeAutoPickId = null;
    /** The autopilot is flying her to the target: the ticker may run for any pick. */
    this._rangeApEngaged = false;
    this._rangeTickerId = null;
    this._rangeTickerHz = 1;
    this._rangeTickerSuppressedUntil = 0;
    this._apEngaged = false;
    // Set on MENU → ORBITAL_VIEW; gates manifest blips.
    this._missionStartMs = null;
    this.available = false;
    this.activeSources = new Map();
    this._initialized = false;
    this._eventsSetup = false;

    // Approach beep per-arm timers { armId → lastBeepTime }
    this._approachBeepTimers = new Map();

    // Tether tension cooldown per-arm { armId → lastTensionTime }
    this._tetherTensionTimers = new Map();
    this._tetherTensionCooldown = 3.0; // seconds between tension sounds

    // Mother net: loop node state for the flight whistle and reel winch; null when no loop runs. _stopNetLoops() is
    // the chokepoint every terminal path calls, so a loop can never stick.
    this._netWhistleNodes = null;
    this._netWinchNodes = null;
    // Ceremony duck guard: the NET_CEREMONY_START duck pairs with NET_CEREMONY_COMPLETE, which fires only from
    // _captureSuccess/_miss. A net abandoned before either (release from FLIGHT, CaptureNetSystem.reset()) would leave
    // _duckHolds at 1 forever (every non-alarm bus at half gain). The flag makes acquire idempotent and
    // _releaseNetDuck() rides _stopNetLoops(), so the duck cannot outlive a net.
    this._netCeremonyDucked = false;

    // Daughter-net catch ledger (one owner per physical catch): NET_CATCH_SUCCESS (armIndex ≥ 0) voices the scaled
    // cinch clamp and records the debris id + time here. The ARM_CAPTURED handler (same catch, 1-2 frames later) skips
    // its whoosh+clamp for a catch the net already voiced. Non-net ARM_CAPTURED paths (lasso, magnetic grapple,
    // legacy netting) never write the ledger and keep their cue.
    /** @type {Map<string|number, number>} debrisId → catch time (s) */
    this._daughterNetCatchIds = new Map();
    /** @type {number|null} last daughter net-catch time (s) — id-less fallback */
    this._lastDaughterNetCatchAt = null;

    this._dvAlarmTier = 0;
    this._dvDucked = false;
    this._dvAlarmInterval = null;
    this._dvAlarmOsc = null;
    this._dvAlarmLfo = null;
    this._dvAlarmGain = null;

    this._thrusterSputtering = false;
    this._sputterInterval = null;
    this._thrusterBaseGain = 0.06;
    this._thrusterGain = null;

    this._alignmentToneOsc = null;
    this._alignmentToneGain = null;

    // FURNACE gag klaxon on the SAFETY OVERRIDE panel (owner 2026-09-07) { osc, gain, endsAt } or null; single-instance re-entrancy guard.
    this._klaxon = null;

    // Dev tool (?sounds=1 pane): logs every vocabulary sound call; changes no sound.
    installSoundLog(this);
  }

  /** Create the AudioContext; must run from a user gesture (browser rule). */
  init() {
    if (this._initialized) return;
    // ?noAudio=1 skips AudioContext creation entirely (A/B for whether the audio render thread triggers the SMC fan
    // at sim-start). Parsed lazily so the headless test runner (no window) is unaffected.
    try {
      if (typeof window !== 'undefined' &&
          new URLSearchParams(devSearch(window.location)).get('noAudio') === '1') {
        console.info('[AudioSystem] ?noAudio=1. Skipping AudioContext creation. All audio is disabled for this session.');
        this.available = false;
        this._initialized = true; // prevent retry storms from event handlers
        return;
      }
    } catch (_e) { /* swallow — non-browser env */ }
    // ?logBoot=1 boot timeline: mark audio lifecycle events (when the audio render thread goes active). No-op without
    // window.__bootMark.
    try {
      // eslint-disable-next-line no-undef
      if (typeof window !== 'undefined') window.__bootMark?.('audioSystem.init() called');
    } catch (_e) { /* swallow */ }
    try {
      // Low-power AudioContext. The default latencyHint 'interactive' (~256-sample buffer, ~5.8 ms @ 44.1 kHz) wakes
      // the render thread ~170×/s, which drives Energy Impact past the macOS SMC fan-trip threshold even with zero
      // audible work (A/B: fan stays off with ?noAudio=1). 'playback' (1024-4096 samples) + 22050 Hz gives 8-32× fewer
      // wakeups; all procedural SFX are sub-2 kHz (the 11025 Hz low-pass is inaudible). Every play* method uses
      // relative time and absolute frequencies, so sample rate is invisible to call sites. Tests stub AudioContext.
      const CtxCtor = window.AudioContext || window.webkitAudioContext;
      let opts = { latencyHint: 'playback', sampleRate: 22050 };
      try {
        this.ctx = new CtxCtor(opts);
      } catch (_e1) {
        // Old Safari rejects sampleRate at construct time: retry without it, then the default ctor.
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
      // Family bus graph: every family bus routes → sfxBus → master → destination. Ducking (_duckOthers) ramps all
      // non-alarm buses; the alarm bus is never ducked, so danger outranks. musicBus/voiceBus are reserved (silent) and
      // connect straight to master so future music/TTS bypass sfx volume and can be ducked independently.
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
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 1.0;
      this.musicBus.connect(this.master);
      this.voiceBus = this.ctx.createGain();
      this.voiceBus.gain.value = 1.0;
      this.voiceBus.connect(this.master);
      this._duckableBuses = [
        this.physicalBus, this.radioBus, this.pingBus, this.tickBus,
        this.denyBus, this.rewardBus, this.padBus, this.musicBus, this.voiceBus,
      ];
      this.master.connect(this.ctx.destination);
      this.available = true;
      this._initialized = true;
      // §13 boot mark of the initial state (typically 'suspended' until a user gesture).
      try {
        // eslint-disable-next-line no-undef
        if (typeof window !== 'undefined') {
          window.__bootMark?.(`AudioContext created (state=${this.ctx.state}, sampleRate=${this.ctx.sampleRate})`);
          // Subscribe to suspended ↔ running transitions: the §12.11 fan-trigger signal.
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

  /**
   * Resume if suspended (autoplay policy) or interrupted. WebKit parks the ctx in the NON-STANDARD 'interrupted' state
   * on an iPadOS audio interruption (Siri, a call, another app); a 'suspended'-only gate would leave the game silent
   * all session because the InputManager unlock is one-shot. 'closed' is never resumed. Pinned in
   * audio-vocabulary.test.js.
   */
  resume() {
    if (!this.ctx) return;
    const s = this.ctx.state;
    if (s === 'suspended' || s === 'interrupted') {
      // resume() returns a promise (a stub may return nothing); swallow a rejection (NotAllowedError before any
      // gesture): never an unhandled rejection.
      const p = this.ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }

  /** Set master volume 0..1 */
  setVolume(v) {
    if (this.master) this.master.gain.value = clamp01(v);
  }

  /**
   * Duck all non-alarm family buses so an ALARM cue reads clearly (danger outranks everything — Design law (d)). The
   * `_duckHolds` counter stops overlapping alarms restoring the mix early. 0.15 s down-ramp, 0.5 s up-ramp.
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

  /** @private One-shot duck for a transient alarm: on, restored after `ms`. */
  _duckPulse(ms) {
    if (!this.available) return;
    this._duckOthers(true);
    timerManager.setTimeout(() => this._duckOthers(false), ms, { owner: this });
  }

  /**
   * TTS-ready hook (reserved): duck the mix for spoken narration; shares the alarm re-entrancy counter. No voice
   * content ships yet.
   */
  duckForVoice(on) {
    this._duckOthers(on);
  }

  /**
   * @private True while inside the mission-start cue grace window (Constants.AUDIO.STARTUP_CUE_GRACE_S after
   * MENU → gameplay). Non-essential automation-fired cues (manifest blips, hint chime) stay quiet; visuals still
   * appear. Never used for ALARM/danger cues.
   */
  _inStartupCueGrace() {
    if (this._missionStartMs == null) return false;
    const graceS = (Constants.AUDIO && Constants.AUDIO.STARTUP_CUE_GRACE_S) || 0;
    const nowMs = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    return (nowMs - this._missionStartMs) < graceS * 1000;
  }

  /**
   * @private Map a throttled TARGET_RANGE readout to a tick cadence and (re)start the range ticker. Cadence rises as
   * the player closes; below net range the lock ping takes over, so it stops.
   */
  _onTargetRange(d) {
    const RT = (Constants.AUDIO && Constants.AUDIO.RANGE_TICKER) || {};
    if (!RT.ENABLED || !this.available || !d) { this._stopRangeTicker(); return; }
    // owner 2026-10-27: the ticker answers the player's own pick or the autopilot's flight, never a piece the game
    // picked (a scan's auto-select, autolock). A later player pick of the same piece clears the tag (TARGET_SELECTED).
    if (isRangeTickAutoPick(d.id, this._rangeAutoPickId) && !this._rangeApEngaged) {
      this._stopRangeTicker();
      return;
    }
    const distM = d.distM;
    const netRangeM = d.netRangeM || 90;
    const startM = RT.START_M || 2000;
    if (!(distM > netRangeM && distM < startM)) { this._stopRangeTicker(); return; }
    // Linear 0 (far, at startM) → 1 (close, at netRangeM).
    const t = 1 - (distM - netRangeM) / (startM - netRangeM);
    const minHz = RT.MIN_HZ || 0.5;
    const maxHz = RT.MAX_HZ || 3;
    this._rangeTickerHz = lerp(minHz, maxHz, clamp01(t));
    if (!this._rangeTickerActive) {
      this._rangeTickerActive = true;
      this._scheduleRangeTick();
    }
  }

  _scheduleRangeTick() {
    if (!this._rangeTickerActive) return;
    const hz = this._rangeTickerHz || 1;
    const periodMs = Math.max(120, 1000 / hz);
    this._rangeTickerId = timerManager.setTimeout(() => {
      if (!this._rangeTickerActive) return;
        // Pause while the DockingReticle owns the PING channel (alignment tone / recent docking beeps).
      const now = this.ctx ? this.ctx.currentTime : 0;
      const suppressed = !!this._alignmentToneOsc
        || (this._rangeTickerSuppressedUntil && now < this._rangeTickerSuppressedUntil);
      if (!suppressed && this.available && this.ctx && this.ctx.state === 'running') {
        const g = (Constants.AUDIO.RANGE_TICKER && Constants.AUDIO.RANGE_TICKER.GAIN) || 0.05;
        this._playSineBlip(now, 1000, 0.03, g, this.pingBus);
      }
      this._scheduleRangeTick();
    }, periodMs, { owner: this });
  }

  _stopRangeTicker() {
    this._rangeTickerActive = false;
    if (this._rangeTickerId != null) {
      timerManager.clear(this._rangeTickerId);
      this._rangeTickerId = null;
    }
  }

  /**
   * @private §13: whether the ambient engine-room loop runs in gameplay. Default false (Apple Silicon SMC fan
   * trigger); `?ambient=1` forces on, `?noAmbient=1` forces off. The Node runner (no window) → always false.
   */
  _isAmbientLoopEnabled() {
    try {
      if (typeof window === 'undefined') return false;
      const qs = new URLSearchParams(devSearch(window.location));
      if (qs.get('ambient') === '1') return true;
      if (qs.get('noAmbient') === '1') return false;
    } catch (_e) { /* swallow — non-browser env */ }
    return !!(Constants.AUDIO && Constants.AUDIO.AMBIENT_LOOP_ENABLED);
  }

  /** Subscribe to game events via EventBus. Idempotent. */
  setupEventListeners() {
    if (this._eventsSetup) return;
    this._eventsSetup = true;

    // Arm lifecycle sounds. The deploy WOOSH keys off ARM_SPRING_FIRED (the crossbow spring actually releasing the
    // daughter, 1.5 s after LAUNCHING entry) so audio matches departure; ARM_DEPLOYED (clamp-release start) plays a
    // quiet click so the wind-up reads as deliberate.
    eventBus.on(Events.ARM_DEPLOYED, () => {
      this.playDockClick();
    });

    eventBus.on(Events.ARM_SPRING_FIRED, () => {
      this.playArmDeploy();
    });

    // A NET capture has ONE physical moment, the bag cinching shut, and NET_CATCH_SUCCESS owns its sound
    // (playNetCinchClamp, daughter-scaled) for both launcher families. ARM_CAPTURED for the same catch is the ArmUnit
    // FSM's bookkeeping 1-2 frames later (measured f397 → f399 at 60 fps), so its whoosh+clamp is skipped when the
    // debris id matches the just-voiced net catch. Non-net ARM_CAPTURED (lasso, magnetic grapple, legacy netting)
    // keeps this cue.
    eventBus.on(Events.ARM_CAPTURED, (data) => {
      if (this._isDaughterNetCatchEcho(data)) return;
      this.playNetWhoosh(0.3);
      this.playCatchClamp();
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

    eventBus.on(Events.GAME_KESSLER, () => {
      this._duckPulse(2000); // Kessler collision is game-ending danger
      this.playCollision();
    });

    // SCORE_UPDATE deliberately does not play playScoreTally: a capture already fires cashRegister (SCORING_AWARD) and
    // the tally tick doubled the reward voice. playScoreTally stays for a future score-HUD count-up.

    eventBus.on(Events.SCAN_INITIATED, () => {
      this.playScan();
    });

    eventBus.on(Events.SCORING_AWARD, (data) => {
      if (data.points > 0) {
        this.playCashRegister();
      }
    });

    eventBus.on(Events.CAMERA_VIEW_CHANGE, () => {
      // No click here: main.js onKeyDown already plays it for the V key (avoids a double click).
    });

    // Target lock earcon, reward-first: governed by the NET-RANGE crossing, NOT raw selection, so it always means
    // "you can act on this now". AutoLockController tracks every selected target and emits TARGET_IN_RANGE on the
    // out→in crossing (immediately for an already-in-range pick), which is where the cue fires. An out-of-range pick
    // stays silent. A one-frame SELECTED cue still plays when nothing range-tracks the pick (headless / no
    // controller), unless the range system tagged the selection (avoids a double-fire).
    eventBus.on(Events.TARGET_SELECTED, (data) => {
      if (data && data._suppressLockSound) return;
      if (data && data.autoLock) return;
      this._playLockDeduped();
    });

    eventBus.on(Events.TARGET_CLEARED, (data) => {
      // A programmatic reset clear (mission init) passes silent:true: no target was engaged, so no "target lost" earcon.
      if (data && data.silent) return;
      this.playTargetLost();
    });

    // Net-range crossing INTO range → the lock earcon: the single trustworthy "now actionable" cue (payoff after the
    // autopilot closes the gap, and the tease lock at start).
    eventBus.on(Events.TARGET_IN_RANGE, (data) => {
      // Only the player's selection should ping. The game's automatic lock (startup tease debris, ambient reacquire)
      // fires TARGET_IN_RANGE unprompted; an anonymous earcon teaches no vocabulary, so it is tagged autoLock and
      // stays silent.
      if (data && data.autoLock) return;
      this._playLockDeduped();
    });

    eventBus.on(Events.FUEL_CHANGED, (data) => {
      if (data && data.initial) return; // the boot/load announcement is not a player action
      this.playFuelCycle(data.index || 0);
    });

    eventBus.on(Events.CARGO_STORE, () => {
      this.playCargoStored();
    });

    eventBus.on(Events.TRAWL_CAPTURE, () => {
      this.playTrawlCapture();
    });

    // Ion start-up (a trip's four tail engines light, DECISIONS §37 row 7): a hum on its own 'ionStartup' key that
    // rises with the lit share, then holds quiet for the burn; InputManager's per-frame stopThrusterHum() never touches it.
    eventBus.on(Events.ION_STARTUP_BEGIN, () => this.startIonStartupHum(0));
    eventBus.on(Events.ION_STARTUP_HUM, (d) => this.updateIonStartupHum(d ? d.lit : 0));
    eventBus.on(Events.ION_STARTUP_LIT, () => this.holdIonStartupHum());
    eventBus.on(Events.ION_STARTUP_END, () => this.stopIonStartupHum());
    // ... and silent while the game is paused (the trip's clock does not run then), back at the same level on resume.
    eventBus.on(Events.PAUSE_MENU, () => this.muteIonStartupHum(true));
    eventBus.on(Events.PAUSE_RESUME, () => this.muteIonStartupHum(false));

    // Ambient loop lifecycle: start on gameplay, stop on menu/gameover. Gated by Constants.AUDIO.AMBIENT_LOOP_ENABLED
    // (default false): two continuously-looping BufferSource + BiquadFilter chains kept the audio render thread busy
    // on Apple Silicon (SMC fan trigger, even after the low-power ctx fix). URL: ?ambient=1 force-enables,
    // ?noAmbient=1 force-disables.
    eventBus.on(Events.STATE_CHANGE, (data) => {
      const playStates = ['ORBITAL_VIEW', 'APPROACH', 'INTERACTION'];
      // Mark mission start (MENU → gameplay) so cues tied to automatic startup processes (manifest blips) stay quiet
      // during the opening cluster.
      if (data.to === 'ORBITAL_VIEW' && data.from === 'MENU') {
        this._missionStartMs = (typeof performance !== 'undefined' && performance.now)
          ? performance.now() : Date.now();
      }
      if (playStates.includes(data.to) && !this._ambientActive && this._isAmbientLoopEnabled()) {
        this.startAmbientLoop();
      } else if (['MENU', 'GAME_OVER', 'WIN'].includes(data.to)) {
        this.stopAmbientLoop();
      }
    });

    // Menu→sim transition audio (there is no menu ambient; the engine-room loop is gameplay-only): a soft pad swell
    // during the camera pull-back and a comms crackle as the HUD comes online. Both gate on this.available, so
    // ?noAudio=1 keeps them silent for capture drivers.
    eventBus.on(Events.MENU_DEPARTURE_START, (data) => {
      // Size the swell to the pull-back so it lands with the handoff.
      const dur = (data && Number.isFinite(data.durationMs)) ? data.durationMs / 1000 : 1.35;
      this.playDepartureSwell(dur);
    });
    eventBus.on(Events.HUD_POWER_ON, () => {
      this.playCommsCrackle();
    });

    // SAFER cold-gas puff during the astronaut jet-off exit: one per puff, only on the full new-game exit.
    eventBus.on(Events.MENU_EVA_PUFF, () => {
      this.playEvaPuff();
    });

    // ΔV telemetry → 4-tier urgency alarm + thruster sputtering + ambient modulation
    eventBus.on(Events.DELTAV_UPDATE, (data) => {
      this.updateDeltaVAlarm(data.pct, data.predictedPct);
      // thruster sputtering when fuel is low
      if (this.activeSources.has('thruster')) {
        this.updateThrusterFuelState(data.pct * 100); // 0-1 → 0-100
      }
      // modulate ambient engine-room sounds from solar/battery state
      this.updateAmbientState({
        solarRate: data.solarRate || 0,
        batteryPct: data.batteryPct || 100,
      });
    });

    eventBus.on(Events.CONJUNCTION_WARNING, (data) => {
      this.playConjunctionAlert(data.tier);
    });

    eventBus.on(Events.ARM_DETACHED, () => {
      this.playTetherSnap();
    });
    // TETHER_SNAP also triggers the snap audio
    eventBus.on(Events.TETHER_SNAP, () => this.playTetherSnap());

    // Approach beep — arm nearing target (rate-limited per arm)
    eventBus.on(Events.ARM_APPROACH_PING, (data) => {
      const { distanceFraction, armId } = data;
      const now = performance.now() / 1000;
      const lastBeep = this._approachBeepTimers.get(armId) || 0;

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

    eventBus.on(Events.WEATHER_EFFECT_START, (data) => {
      this.playWeatherAlert(data.type);
    });

    eventBus.on(Events.CODEX_UNLOCKED, (d) => {
      this.playCodexUnlock(d && d.category);
    });

    eventBus.on(Events.TRAWL_SWEEP_COMPLETE, () => {
      this.playSweepComplete();
    });

    eventBus.on(Events.AUTOPILOT_DISENGAGE, () => {
      this._apEngaged = false;
      this.playAPDisengage();
    });

    // P6 coverage gap: autopilot engage cue (inverse of disengage). Deduped to
    // a genuine off→on transition — AUTOPILOT_ENGAGE also fires on mid-flight
    // heading-mode changes, which should NOT re-announce "engaged".
    eventBus.on(Events.AUTOPILOT_ENGAGE, () => {
      if (this._apEngaged) return;
      this._apEngaged = true;
      this.playAPEngage();
    });

    eventBus.on(Events.AUTOPILOT_ARRIVED, () => {
      this.playAPArrived();
    });

    eventBus.on(Events.CLUSTER_WINDOW_IMMINENT, () => this.playWindowImminent());
    eventBus.on(Events.CLUSTER_WINDOW_OPEN, () => this.playWindowOpen());

    eventBus.on(Events.TARGET_RANGE, (d) => this._onTargetRange(d));
    // Tag a game-made pick so its range readout stays silent (see _onTargetRange).
    eventBus.on(Events.TARGET_SELECTED, (d) => {
      this._rangeAutoPickId = d && isAutomaticPick(d) ? d.id : null;
      if (this._rangeAutoPickId != null) this._stopRangeTicker();
    });
    eventBus.on(Events.AUTOPILOT_ENGAGE, (d) => {
      this._rangeApEngaged = !d || d.mode === undefined || d.mode === 'TARGET';
    });
    eventBus.on(Events.AUTOPILOT_DISENGAGE, () => { this._rangeApEngaged = false; });
    eventBus.on(Events.TARGET_CLEARED, () => this._stopRangeTicker());
    eventBus.on(Events.TARGET_IN_RANGE, () => this._stopRangeTicker());
    eventBus.on(Events.DEBRIS_CAPTURED, () => this._stopRangeTicker());
    eventBus.on(Events.STATE_CHANGE, () => this._stopRangeTicker());

    eventBus.on(Events.SALVAGE_REVEAL, () => {
      this.playSalvageReveal();
    });

    eventBus.on(Events.LASSO_FIRED, () => {
      this.playLassoFire();
      this.startLassoWireWhistle();
    });

    eventBus.on(Events.LASSO_CONTACT, () => {
      this.playCatchClamp();
      this.stopLassoWireWhistle();
      this.playLassoWinch();
    });

    eventBus.on(Events.LASSO_CAPTURED, () => {
      this.stopLassoWireWhistle();
    });

    eventBus.on(Events.LASSO_DENIED, () => {
      this.playDeny();
    });

    // Net voices. TWO launcher families share these events and BOTH speak: mother (podIndex ≥ 0, full volume) and
    // daughter (armIndex ≥ 0 with podIndex −1; the same voices at DAUGHTER_NET_GAIN). Gating is deliberate on BOTH
    // branches: a payload naming neither launcher stays silent (an old `podIndex < 0` mother gate read
    // `undefined < 0 === false` and let id-less daughter fires start the mother thump+whistle with no reachable
    // stop). The two loops (flight whistle, reel winch) are killed via _stopNetLoops() from EVERY terminal path of
    // EITHER family.

    // Fire: canister thump + flight whistle (stopped on any terminal event).
    eventBus.on(Events.NET_FIRED, (data) => {
      if (!data) return;
      if (data.podIndex >= 0) {
        this.playNetCanisterThump();
        this.startNetFlightWhistle();
      } else if (data.armIndex >= 0) {
        this.playNetCanisterThump(DAUGHTER_NET_GAIN);
        this.startNetFlightWhistle(DAUGHTER_NET_GAIN);
      }
    });

    // Catch: whistle stops, the clamp lands (the line-taut beat). The daughter catch records itself so the
    // ARM_CAPTURED handler doesn't double the clamp (see its ownership note).
    eventBus.on(Events.NET_CATCH_SUCCESS, (data) => {
      if (!data) return;
      if (data.podIndex >= 0) {
        this.stopNetFlightWhistle();
        this.playNetCinchClamp();
      } else if (data.armIndex >= 0) {
        this.stopNetFlightWhistle();
        this.playNetCinchClamp(DAUGHTER_NET_GAIN);
        this._recordDaughterNetCatch(data.debrisId);
      }
    });

    // Miss: kill the loops. Mother keeps her DENY buzz / strain rip (§9.7). The DAUGHTER branch is loop-hygiene ONLY:
    // ARM_CAPTURE_FAILED → playFailBuzz owns the daughter miss voice (the ArmUnit emits it when its FSM poll sees
    // MISSED, the same moment); a deny here would double-voice one miss.
    eventBus.on(Events.NET_CATCH_MISS, (data) => {
      if (!data) return;
      if (data.podIndex >= 0) {
        this._stopNetLoops();
        if (data.reason === 'strain_slip') {
          this.playNetStrainRip();
        } else {
          this.playDeny();
        }
      } else if (data.armIndex >= 0) {
        this._stopNetLoops();
      }
    });

    // Reel: winch loop (pitch follows remainingM via updateNetReelPitch, polled from CaptureNetSystem.update).
    // Mother-only and only for a successful catch: the empty miss reel-back is a quiet rewind, and the daughter's
    // catch is hauled home by the ArmUnit (the arm/tether owns that soundscape). The daughter branch is a whistle
    // backstop: her auto-reel fires this event in the same tick as catch/miss resolution.
    eventBus.on(Events.NET_REEL_STARTED, (data) => {
      if (!data) return;
      if (data.podIndex >= 0) {
        if (data.hasCatch) this.startNetReelWinch();
      } else if (data.armIndex >= 0) {
        this.stopNetFlightWhistle();
      }
    });

    // Berth: winch stops, dock clunk + short reward chime. Mother-only: a daughter net never berths (fireDaughterNet
    // catches are arm-hauled; lasso adoptions suppress NET_BERTHED).
    eventBus.on(Events.NET_BERTHED, (data) => {
      if (!data || data.podIndex < 0) return;
      this._stopNetLoops();
      this.playNetBerthClunk();
      this.playNetBerthChime();
    });

    // Reel completed: belt-and-braces loop stop for BOTH families. Mother: the fallback STOWED exit (headless
    // reel-back). Daughter: the held-catch stow (arm delivery / target death mid-haul) and any reel-end path that
    // skips the catch/miss hooks.
    eventBus.on(Events.NET_REEL_COMPLETED, (data) => {
      if (!data) return;
      if (data.podIndex >= 0 || data.armIndex >= 0) this._stopNetLoops();
    });

    // Release / jettison: kill every loop (abort path), both families.
    eventBus.on(Events.NET_RELEASED, (data) => {
      if (!data) return;
      if (data.podIndex >= 0 || data.armIndex >= 0) this._stopNetLoops();
    });

    // Fragmentation with a mother net on the field: kill the loops. (NET_FRAGMENTATION carries no podIndex; the net's
    // own miss path fires separately and also stops the loops.)
    eventBus.on(Events.NET_FRAGMENTATION, () => {
      this._stopNetLoops();
    });

    // Ceremony stings (emitted behind FEATURE_FLAGS.NET_CEREMONY): brake retro hiss, envelop sweep, per-10% cinch
    // ratchet ticks. Daughter ceremonies (podIndex −1, armIndex ≥ 0) play them at DAUGHTER_NET_GAIN.
    eventBus.on(Events.NET_BRAKE_FIRED, (data) => {
      if (!data) return;
      if (data.podIndex >= 0) this.playNetBrakeHiss();
      else if (data.armIndex >= 0) this.playNetBrakeHiss(DAUGHTER_NET_GAIN);
    });
    eventBus.on(Events.NET_ENVELOP_PEAK, (data) => {
      if (!data) return;
      if (data.podIndex >= 0) this.playNetEnvelopSting();
      else if (data.armIndex >= 0) this.playNetEnvelopSting(DAUGHTER_NET_GAIN);
    });
    eventBus.on(Events.NET_CINCH_PROGRESS, (data) => {
      if (!data) return;
      if (data.podIndex >= 0) this.playNetCinchTick(data.fraction);
      else if (data.armIndex >= 0) this.playNetCinchTick(data.fraction, DAUGHTER_NET_GAIN);
    });

    // Ceremony ducking: the mix ducks under the ceremony so the net voices read clearly (alarm bus never ducks).
    // Daughter ceremonies too (NET_CEREMONY_START fires for them with podIndex −1 and an armIndex): idempotent acquire
    // keeps the _duckOthers counter balanced (one hold per live ceremony flag), and release rides the _stopNetLoops()
    // chokepoint, which every terminal path of either family runs, so an abandoned net can never leak a permanent 50%
    // mix. The flag is one shared slot: mother and daughter ceremonies never run concurrently (CameraSystem admits one
    // at a time).
    eventBus.on(Events.NET_CEREMONY_START, (data) => {
      if (!data) return;
      if (!(data.podIndex >= 0) && !(data.armIndex >= 0)) return;
      if (!this._netCeremonyDucked) {
        this._netCeremonyDucked = true;
        this._duckOthers(true);
      }
    });
    eventBus.on(Events.NET_CEREMONY_COMPLETE, (data) => {
      if (!data) return;
      if (!(data.podIndex >= 0) && !(data.armIndex >= 0)) return;
      this._releaseNetDuck();
    });

    eventBus.on(Events.MPD_BURST_END, (data) => {
      this.playMPDDisarm();
    });

    eventBus.on(Events.SKILL_STATE_CHANGED, (d) => {
      if (d?.to === 'practiced') this.playPracticeChime();
    });
    // Owner 2026-10-21: no mastery popup or fanfare in the sim.

    // A mission's last catch: one existing success cue. The same catch can also clear a cluster (RewardSystem →
    // AUDIO_CUE fieldCleared), so both go through one guard.
    eventBus.on(Events.MISSION_COMPLETE, () => this._playFieldClearedOnce());

    // Generic AUDIO_CUE channel, payload { id|cue: string, volume?: number }. Recognised cues: `hint_post`,
    // `sweepComplete` (trawl sweep), `fieldCleared` (milestone, its own voice); unknown cues are no-ops.
    eventBus.on(Events.AUDIO_CUE, (data) => {
      if (!data) return;
      const id = data.id || data.cue;
      if (id === 'hint_post') {
        // The first onboarding hints post seconds into the mission with no player action; the chime read as an
        // unexplained tone. The hint card still appears; only the sound waits out the opening grace window.
        if (this._inStartupCueGrace()) return;
        const v = (typeof data.volume === 'number') ? data.volume : 0.4;
        this.playHintPost(v);
      } else if (id === 'sweepComplete') {
        this.playSweepComplete();
      } else if (id === 'fieldCleared') {
        this._playFieldClearedOnce();
      }
    });
  }

  playMagnetic(duration = 0.5) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 60;

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

  /** Warning beep: descending G4→E4 two-note earcon (EARCON_FREQUENCIES.ALERT). */
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

  /** Capture/clamp impact: metallic thud + ring + noise click. Triggered when the arm enters GRAPPLED (catch moment). */
  playCatchClamp() {
    if (!this.available) return;
    const now = this.ctx.currentTime;

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
   * REWARD FAMILY note map: every "you gained something" cue, distinct in contour + length so they never blur:
   *   playCaptureSuccess  single A5 (880)            — debris captured
   *   playPurchase        700 → 1050 (triangle)      — credits spent (shop)
   *   playCashRegister    1200 → 1800 (triangle)     — credits earned
   *   playScoreTally      (see method)               — per-point tick (HUD)
   *   playHintPost        G4 → B4 (392→494)          — onboarding hint
   *   playPracticeChime   A5 → C#6 (880→1108)        — PRACTICED transition
   *   playTrawlCapture    single C5                  — trawl catch
   *   playCodexUnlock     3-note triad (per-category) — codex entry unlocked
   *   playSweepComplete   C4·E4·G4·C5 echo fanfare   — trawl sweep finished
   *   playFieldCleared    C5·E5·G5·C6 echo fanfare   — cluster/field cleared
   *   playVictory         (see method)               — run victory
   * PING chimes for reference: targetLock C5→E5, targetLost E5→C5.
   */

  /** Capture success: single clean beep (A5, 880 Hz, 150 ms). */
  playCaptureSuccess() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 880;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    osc.connect(gain);
    gain.connect(this.rewardBus);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  playCollision() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

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
   * SAFETY OVERRIDE panel's FURNACE gag: a broken cockpit button that fakes a self-destruct. Two-tone sawtooth
   * klaxon, 440/620 Hz alternating at 2 Hz (0.25 s per step, precomputed across the duration), on the ALARM bus
   * (never ducked). Single-instance: a klaxon in flight is ignored until its endsAt passes (onended may never fire on
   * a suspended ctx, so expiry is checked by time). Mute-aware: no ctx call when unavailable. Never throws.
   * @param {number} [durationS=2] klaxon length in s (non-finite or ≤ 0 → 2; capped at 10).
   */
  playKlaxon(durationS = 2) {
    if (!this.available || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Re-entrancy guard: a stale _klaxon past its endsAt (onended never fired, ctx suspended) is discarded.
    if (this._klaxon) {
      if (now < this._klaxon.endsAt) return;
      this._klaxon = null;
    }
    let d = (Number.isFinite(durationS) && durationS > 0) ? durationS : 2;
    if (d > 10) d = 10;
    try {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const steps = Math.ceil(d / 0.25);
      for (let k = 0; k < steps; k++) {
        const f = (k % 2 === 0) ? 440 : 620;
        osc.frequency.setValueAtTime(f, now + k * 0.25);
      }
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + d);
      osc.connect(gain);
      gain.connect(this.alarmBus || this.master);
      osc.start(now);
      osc.stop(now + d);
      this._klaxon = { osc, gain, endsAt: now + d };
      osc.onended = () => {
        if (this._klaxon && this._klaxon.osc === osc) this._klaxon = null;
        try { osc.disconnect(); gain.disconnect(); } catch (_e) {}
      };
    } catch (_e) {
      this._klaxon = null;
    }
  }

  /** Teardown seam for the FURNACE gag's abort path: kills a klaxon in flight early. No-op when none; never throws. */
  stopKlaxon() {
    if (!this._klaxon) return;
    const { osc, gain } = this._klaxon;
    try { osc.onended = null; osc.stop(); } catch (_e) {}
    try { osc.disconnect(); gain.disconnect(); } catch (_e) {}
    this._klaxon = null;
  }

  /**
   * FURNACE gag v2: a breaker relay closing, ONE HUD panel returning after the blackout. HudReboot fires one per
   * returning panel, so the top → bottom return reads as relays clacking home down the console. PHYSICAL family
   * (mechanical cockpit event, not a UI tick): 40 ms sawtooth 160 → 90 Hz through a 600 Hz low-pass, gain 0.22 → 0.
   * Mute-aware (`available` guard). Never throws.
   */
  playRelayClack() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.04);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.physicalBus);
    osc.start(now);
    osc.stop(now + 0.04);
  }

  /**
   * Terminal blip: short FM sweep, ~50 ms, low volume, for comms boot messages and the salvage-manifest typewriter
   * reveal. Optional `step` (row index; 0 = 800→400 Hz sweep) pitches each row up (+60 Hz/row) so a run reads as one
   * rising "data loading" gesture. Silent during the mission-start grace window: the auto-locked first target's
   * passive survey completes with no player action and would fire ~5 unexplained clicks; the rows still animate.
   */
  playTerminalBlip(step = 0) {
    if (!this.available) return;
    if (this._inStartupCueGrace()) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const bump = Math.max(0, step) * 60;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800 + bump, now);
    osc.frequency.exponentialRampToValueAtTime(400 + bump, now + 0.05);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    osc.connect(gain);
    gain.connect(this.pingBus);
    osc.start(now);
    osc.stop(now + 0.06);
  }

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

  playNetWhoosh(dur = 0.4) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const bufferSize = Math.ceil(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(3000, now);
    filter.frequency.linearRampToValueAtTime(300, now + dur);

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

  playDockClick() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.03;

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

  playArmDeploy(dur = 0.6) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const bufferSize = Math.ceil(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1500;
    filter.Q.value = 0.8;

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 8;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 300;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);

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

  /** Tether snap: sharp metallic snap + tension-release whip + low rumble fade. Plays when the tether is severed. */
  playTetherSnap() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

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

  playFailBuzz(dur = 0.3) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 150;

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
   * Canonical DENY voice: the single "input refused, nothing broke" sound. Low dull square buzz, ~120 ms (the
   * playFailBuzz DNA shortened). One meaning, one word.
   */
  playDeny() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.12;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 150;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.14, now + 0.008);
    gain.gain.setValueAtTime(0.14, now + 0.07);
    gain.gain.linearRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain);
    gain.connect(this.denyBus);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  /** Ascending step tone for T-key fuel cycling; each fuel type one step higher. */
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
   * Softer single-note "ding" for trawl auto-captures (C5).
   * Distinct from manual capture's single A5 beep.
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

  /** Start the persistent ambient "engine room" loop: bandpass white noise (fans/coolant hum) + solar hiss layer. */
  startAmbientLoop() {
    if (!this.available || this._ambientActive) return;
    this._ambientActive = true;
    // §13 boot timeline: mark when the ambient loop kicks in so fan-on can be correlated in `?logBoot=1` output.
    try {
      // eslint-disable-next-line no-undef
      if (typeof window !== 'undefined') window.__bootMark?.('startAmbientLoop(). 2 buffer sources + 2 filters going live');
    } catch (_e) { /* swallow */ }

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

    this._ambientNoise.connect(this._ambientFilter);
    this._ambientFilter.connect(this._ambientGain);
    this._ambientGain.connect(this.padBus);

    this._solarNoise.connect(this._solarFilter);
    this._solarFilter.connect(this._solarGain);
    this._solarGain.connect(this.padBus);

    this._ambientNoise.start();
    this._solarNoise.start();
  }

  /** Stop the ambient loop with a fade-out. Safe to call when not started. */
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

  /**
   * Start continuous thruster hum with directional sound differentiation.
   * @param {number} [intensity=1.0] gain multiplier; 0.4 for arm-pilot FEEP thrusters (much smaller engines than the
   *   mothership main bus).
   */
  startThrusterHum(type = 'ion', direction = 'prograde', intensity = 1.0) {
    if (!this.available) return;

    // If already playing, check if direction/intensity/type changed — restart if so
    if (this.activeSources.has('thruster')) {
      const existing = this.activeSources.get('thruster');
      if (existing._direction === direction
          && existing.type === type
          && existing._intensity === intensity) return;
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
      this._thrusterBaseGain = baseGain;
    } else if (type === 'coldgas') {
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
      this._thrusterBaseGain = baseGain;
    }

    // sputtering reads _thrusterBaseGain and _thrusterGain
    this._thrusterGain = gain;

    // Retrograde braking pulse: LFO amplitude modulation
    let retroLfo = null;
    let retroLfoGain = null;
    if (direction === 'retrograde') {
      retroLfo = ctx.createOscillator();
      retroLfoGain = ctx.createGain();
      retroLfo.frequency.value = 4;    // 4 Hz pulse
      retroLfoGain.gain.value = 0.3;   // ±30% modulation depth
      retroLfo.connect(retroLfoGain);
      retroLfoGain.connect(gain.gain);
      retroLfo.start(now);
      nodes.push(retroLfo);
    }

    gain.connect(this.physicalBus);
    this.activeSources.set('thruster', { nodes, gain, type, _direction: direction, _intensity: intensity, _retroLfo: retroLfo });
  }

  stopThrusterHum() {
    if (!this.activeSources.has('thruster')) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const entry = this.activeSources.get('thruster');

    this._stopSputtering();
    this._thrusterGain = null;

    entry.gain.gain.cancelScheduledValues(now);
    entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
    entry.gain.gain.linearRampToValueAtTime(0, now + 0.15);

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

  /**
   * Ion start-up hum (TransferTrip's lighting stage, Constants.ION_STARTUP): a quiet sine with a triangle a fifth
   * above, on its OWN 'ionStartup' key (never 'thruster'), at gain 0 and the low pitch until `updateIonStartupHum`
   * raises them with the lit share. A second call while one plays does nothing.
   * @param {number} [lit=0] 0..1 the lit share it starts at
   */
  startIonStartupHum(lit = 0) {
    if (!this.available || this.activeSources.has('ionStartup')) return;
    const I = Constants.ION_STARTUP;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(I.HUM_FREQ_LOW_HZ, now);
    osc.connect(gain);
    osc.start(now);
    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(I.HUM_FREQ_LOW_HZ * 1.5, now);
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0.35;
    body.connect(bodyGain);
    bodyGain.connect(gain);
    body.start(now);
    gain.connect(this.physicalBus);
    this.activeSources.set('ionStartup', { nodes: [osc, body, bodyGain], gain, osc, body, lit: 0, cruise: false, muted: false });
    this.updateIonStartupHum(lit);
  }

  /** Ion start-up hum: gain 0 → HUM_GAIN_PEAK and pitch HUM_FREQ_LOW_HZ → HUM_FREQ_HIGH_HZ follow the lit share (0..1). */
  updateIonStartupHum(lit) {
    const entry = this.activeSources.get('ionStartup');
    if (!this.available || !entry) return;
    const I = Constants.ION_STARTUP;
    const l = clamp01(Number.isFinite(lit) ? lit : 0);
    const now = this.ctx.currentTime;
    const hz = lerp(I.HUM_FREQ_LOW_HZ, I.HUM_FREQ_HIGH_HZ, l);
    entry.lit = l;
    if (!entry.muted) entry.gain.gain.setTargetAtTime(I.HUM_GAIN_PEAK * l, now, 0.08);
    entry.osc.frequency.setTargetAtTime(hz, now, 0.08);
    entry.body.frequency.setTargetAtTime(hz * 1.5, now, 0.08);
  }

  /** Ion start-up hum: all four engines burn - settle to the quiet cruise level at the full pitch, held through the burn. */
  holdIonStartupHum() {
    const entry = this.activeSources.get('ionStartup');
    if (!this.available || !entry) return;
    const I = Constants.ION_STARTUP;
    const now = this.ctx.currentTime;
    entry.lit = 1;
    entry.cruise = true;
    if (!entry.muted) entry.gain.gain.setTargetAtTime(I.HUM_GAIN_CRUISE, now, 0.5);
    entry.osc.frequency.setTargetAtTime(I.HUM_FREQ_HIGH_HZ, now, 0.08);
    entry.body.frequency.setTargetAtTime(I.HUM_FREQ_HIGH_HZ * 1.5, now, 0.08);
  }

  /** Ion start-up hum: silent while the game is paused, back at the level it had on resume. Safe when none plays. */
  muteIonStartupHum(muted) {
    const entry = this.activeSources.get('ionStartup');
    if (!this.available || !entry || entry.muted === !!muted) return;
    entry.muted = !!muted;
    const I = Constants.ION_STARTUP;
    const level = entry.cruise ? I.HUM_GAIN_CRUISE : I.HUM_GAIN_PEAK * entry.lit;
    entry.gain.gain.setTargetAtTime(entry.muted ? 0 : level, this.ctx.currentTime, 0.05);
  }

  /** Ion start-up hum: the trip ended (or was aborted, or the game left play): fade out and stop. Safe when none plays. */
  stopIonStartupHum() {
    const entry = this.activeSources.get('ionStartup');
    if (!entry) return;
    this.activeSources.delete('ionStartup');
    if (!this.available) return;
    const now = this.ctx.currentTime;
    entry.gain.gain.cancelScheduledValues(now);
    entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
    entry.gain.gain.linearRampToValueAtTime(0, now + 0.3);
    timerManager.setTimeout(() => {
      entry.nodes.forEach((node) => {
        try { node.stop(); } catch (_) { /* not a source node */ }
        try { node.disconnect(); } catch (_) { /* already disconnected */ }
      });
      try { entry.gain.disconnect(); } catch (_) { /* already disconnected */ }
    }, 350, { owner: this });
  }

  /**
   * Sustained RCS attitude hiss: looping white noise through a 400 Hz bandpass (startThrusterHum's 'coldgas' recipe),
   * on its own 'rcsHiss' key so it never fights the ion hum. Driven at the real post-gate attitude-thrust level (quiet
   * while coasting at the rate cap, swells during the arrest burn); kept under the ion hum (0.06 base gain).
   * @param {number} [level=1.0] 0..1 commanded attitude-thrust fraction.
   */
  startRcsHiss(level = 1.0) {
    if (!this.available) return;
    level = clamp01(level);

    if (this.activeSources.has('rcsHiss')) {
      const existing = this.activeSources.get('rcsHiss');
      const target = 0.06 * level;
      if (Math.abs((existing._level ?? -1) - level) > 1e-3) {
        existing.gain.gain.cancelScheduledValues(this.ctx.currentTime);
        existing.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.03);
        existing._level = level;
      }
      return;
    }
    if (level <= 0) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    const nodes = [];

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

    gain.gain.linearRampToValueAtTime(0.06 * level, now + 0.05);

    gain.connect(this.physicalBus);
    this.activeSources.set('rcsHiss', { nodes, gain, type: 'coldgas', _level: level });
  }

  stopRcsHiss() {
    if (!this.activeSources.has('rcsHiss')) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const entry = this.activeSources.get('rcsHiss');

    entry.gain.gain.cancelScheduledValues(now);
    entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
    entry.gain.gain.linearRampToValueAtTime(0, now + 0.08);

    timerManager.setTimeout(() => {
      entry.nodes.forEach((node) => {
        try { node.stop(); } catch (_) { /* not a source node */ }
        try { node.disconnect(); } catch (_) { /* already disconnected */ }
      });
      try { entry.gain.disconnect(); } catch (_) { /* already disconnected */ }
    }, 100, { owner: this });

    this.activeSources.delete('rcsHiss');
  }

  /**
   * RCS ignition accent: a copy of playEvaPuff (highpassed noise, ~60 ms, gain ~0.045), fired once per fresh couple
   * ignition so the *attack* is instant even though the hull is slow to respond.
   */
  playRcsPuff() {
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
    g.gain.exponentialRampToValueAtTime(0.045, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, now + dur);
    noise.connect(hp);
    hp.connect(g);
    g.connect(this.physicalBus);
    noise.start(now);
    noise.stop(now + dur + 0.02);
  }

  /**
   * Update ΔV alarm state; called at 10 Hz from HUD update via DELTAV_UPDATE. Tier: 0=none, 1=single beep/15s,
   * 2=double beep/8s, 3=triple beep/3s, 4=continuous warble.
   * @param {number} dvPct current ΔV fraction (0-1)
   * @param {number} [predictedPct] optional ΔV fraction (0-1) after matching the target
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

    if (tier === this._dvAlarmTier) return;

    this._dvAlarmTier = tier;
    this._stopDvAlarm();

    // Sustain a duck hold while the ΔV alarm is at tier ≥ 2 so the beeps read clearly. Symmetric on/off keyed off
    // _dvDucked so the re-entrancy counter never leaks a hold.
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
      this._startContinuousAlarm();
    } else {
      const intervals = Constants.HUD.DV_ALARM_INTERVALS;
      const intervalSec = intervals[tier - 1] || 15;
      // _dvAlarmInterval stores the TimerManager id (owner=this); teardown via timerManager.clear() in _stopDvAlarm().
      this._dvAlarmInterval = timerManager.setInterval(() => {
        this._playAlarmBeeps(tier);
      }, intervalSec * 1000, { owner: this });
      this._playAlarmBeeps(tier);
    }
  }

  /** Legacy stop: force-resets the alarm tier (backward compatibility). */
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

  /** Thruster audio from the fuel level: below 10% fuel, random gain dropouts (sputtering). @param fuelPct 0-100 */
  updateThrusterFuelState(fuelPct) {
    if (!this.available || !this._thrusterGain) return;

    if (fuelPct < 10 && !this._thrusterSputtering) {
      this._thrusterSputtering = true;
      this._sputterInterval = timerManager.setInterval(() => {
        if (!this._thrusterGain) { this._stopSputtering(); return; }
        const now = this.ctx.currentTime;
        this._thrusterGain.gain.setValueAtTime(0.01, now);
        const resumeTime = now + 0.03 + Math.random() * 0.08;
        this._thrusterGain.gain.setValueAtTime(this._thrusterBaseGain || 0.06, resumeTime);
      }, 150 + Math.random() * 200, { owner: this });
    } else if (fuelPct >= 10 && this._thrusterSputtering) {
      this._stopSputtering();
    }
  }

  _stopSputtering() {
    this._thrusterSputtering = false;
    if (this._sputterInterval) {
      timerManager.clear(this._sputterInterval);
      this._sputterInterval = null;
    }
  }

  /**
   * Approach beep: pitch rises as the arm nears the target.
   * Far (0.7-1.0): 400 Hz quiet | Mid (0.3-0.7): 600 Hz | Close (0.1-0.3): 800 Hz | Final (<0.1): 1000 Hz
   * @param {number} distanceFraction 0 = at target, 1 = far away
   */
  playApproachBeep(distanceFraction) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    let freq, vol;
    if (distanceFraction < 0.1) { freq = 1000; vol = 0.14; }
    else if (distanceFraction < 0.3) { freq = 800; vol = 0.11; }
    else if (distanceFraction < 0.7) { freq = 600; vol = 0.08; }
    else { freq = 400; vol = 0.05; }

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    osc.connect(gain);
    gain.connect(this.pingBus);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  /**
   * Tether tension: low creak/groan that intensifies with strain.
   * Light (0.3-0.5): quiet creak | Medium (0.5-0.8): groaning | Heavy (0.8-1.0): stressed cable
   * @param {number} tensionFraction 0 = slack, 1 = max tension
   */
  playTetherTension(tensionFraction) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const t = clamp01(tensionFraction);

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
   * Salvage reveal, a two-phase loot box moment: 1 (0-500 ms) metallic unsealing + pneumatic hiss; 2 (500-1500 ms)
   * rising chime cascade C5→E5→G5.
   */
  playSalvageReveal() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

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

    const chimeNotes = [523, 659, 784]; // C5, E5, G5
    chimeNotes.forEach((freq, i) => {
      const start = now + 0.5 + i * 0.2;
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
   * Menu→sim departure pad swell: a soft, low synth chord that fades in and back out over the camera pull-back, giving
   * the (otherwise silent) departure a sense of lift without a musical stinger. Quiet (peak ≈ 0.06) so it sits under
   * the UI click and never masks Houston VO.
   * @param {number} [durationSec=1.35] total swell length (≈ pull-back time).
   */
  playDepartureSwell(durationSec = 1.35) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = clamp(durationSec, 0.4, 3);

    // Low chord: root A2, fifth E3, octave A3 — a stable, open "lift" voicing.
    const freqs = [110, 164.81, 220];
    // Shared lowpass so the pad reads warm/soft, opening slightly as it swells.
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(300, now);
    filter.frequency.linearRampToValueAtTime(900, now + dur * 0.55);
    filter.frequency.linearRampToValueAtTime(500, now + dur);

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
   * Comms crackle: a short radio-squelch burst (no confirm blips),
   * played as the HUD powers on. Signals the comms link coming live
   * alongside the visual power-on stagger. ~0.16 s total, subtle.
   */
  playCommsCrackle() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Squelch only (bandpass noise, radio keying): RADIO speaks in static; square "online confirm" blips sit in the
    // PING register and read as unexplained tones, so none are added.
    this._playSquelch(now, 0.16, 0.09);
  }

  /**
   * @private Shared RADIO squelch burst: bandpass noise, quick in/out (radio keying), on radioBus. Single source of
   * the squelch DNA so playCommsCrackle and playRadioNotice can't drift apart.
   * @param {number} startTime AudioContext time to begin.
   * @param {number} [dur=0.16] burst length (s).
   * @param {number} [peakGain=0.09] envelope peak.
   */
  _playSquelch(startTime, dur = 0.16, peakGain = 0.09) {
    if (!this.available) return;
    const ctx = this.ctx;
    const bufSize = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 4;
    bp.frequency.setValueAtTime(1400, startTime);
    bp.frequency.exponentialRampToValueAtTime(2200, startTime + dur);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, startTime);
    ng.gain.exponentialRampToValueAtTime(peakGain, startTime + 0.02);
    ng.gain.exponentialRampToValueAtTime(0.001, startTime + dur);
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(this.radioBus);
    noise.start(startTime);
    noise.stop(startTime + dur + 0.02);
  }

  /**
   * Comms message notice, replacing playWarning for comms priority sounds so a radio message never sounds like a
   * danger ALARM. Short squelch burst (shared with commsCrackle; slightly shorter/quieter). RADIO family.
   * @param {string} [priority] 'CRITICAL' doubles the squelch; otherwise single.
   */
  playRadioNotice(priority) {
    if (!this.available) return;
    this._playSquelch(this.ctx.currentTime, 0.14, 0.08);
    if (priority === 'CRITICAL') {
      // double squelch = urgent traffic
      this._playSquelch(this.ctx.currentTime + 0.18, 0.14, 0.08);
    }
  }

  /**
   * SAFER cold-gas puff: a tiny highpassed-noise "pfft" (~0.05 s, quiet), layered under the departure pad swell as the
   * astronaut thrusters fire on her jet-off exit. Deliberately subtle: a texture cue, not a bang.
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
    g.gain.exponentialRampToValueAtTime(0.045, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, now + dur);
    noise.connect(hp);
    hp.connect(g);
    g.connect(this.physicalBus);
    noise.start(now);
    noise.stop(now + dur + 0.02);
  }

  /** Weather alert earcons, a distinct sound per type: 'solar_flare', 'geomagnetic', 'saa', 'eclipse'. */
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
   * Codex unlock — gentle three-note ascending chime (D5→A5→D6 base, transposed by
   * a deterministic per-category pentatonic offset via {@link codexChimeNotes}).
   * Light and informative, not disruptive.
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

  /** Sweep complete: brief success fanfare C4→E4→G4→C5 (trawl sweep only); sawtooth + sine blend, echo tail via delay node. */
  playSweepComplete() {
    this._playEchoFanfare([262, 330, 392, 523]); // C4, E4, G4, C5
  }

  /**
   * Field-cleared milestone, its OWN voice (not shared with playSweepComplete). Same echo-fanfare DNA but a full octave
   * span (C5→E5→G5→C6), so it reads as a bigger milestone than any 2-3 note chime, yet smaller than the victory
   * fanfare. REWARD family.
   */
  playFieldCleared() {
    this._playEchoFanfare([523, 659, 784, 1047]); // C5, E5, G5, C6
  }

  /**
   * @private The field-cleared cue, at most once per 2 s: the 5th catch of a
   * mission can end a cluster AND the mission in one go (AUDIO_CUE fieldCleared + MISSION_COMPLETE),
   * and two stacked fanfares would read as a glitch. Real time, so a pause cannot stretch it.
   */
  _playFieldClearedOnce() {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (this._fieldClearedAtMs !== undefined && now - this._fieldClearedAtMs < 2000) return;
    this._fieldClearedAtMs = now;
    this.playFieldCleared();
  }

  /**
   * @private Shared ascending 4-note fanfare (sawtooth+sine blend) with an echo tail, for playSweepComplete and
   * playFieldCleared. REWARD family. @param {number[]} notes ascending frequencies (Hz).
   */
  _playEchoFanfare(notes) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

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

    notes.forEach((freq, i) => {
      const start = now + i * 0.15;
      const saw = ctx.createOscillator();
      saw.type = 'sawtooth';
      saw.frequency.value = freq;
      const sawGain = ctx.createGain();
      sawGain.gain.setValueAtTime(0.06, start);
      sawGain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
      saw.connect(sawGain);
      sawGain.connect(this.rewardBus);
      sawGain.connect(delay);
      saw.start(start);
      saw.stop(start + 0.3);

      const sin = ctx.createOscillator();
      sin.type = 'sine';
      sin.frequency.value = freq;
      const sinGain = ctx.createGain();
      sinGain.gain.setValueAtTime(0.08, start);
      sinGain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
      sin.connect(sinGain);
      sinGain.connect(this.rewardBus);
      sinGain.connect(delay);
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

  /**
   * Conjunction alert beeps, tiered urgency.
   * GREEN:  single soft beep  (800 Hz, 100 ms)
   * YELLOW: double beep       (1200 Hz, 80 ms × 2, 100 ms gap)
   * RED:    urgent triple beep (1600 Hz, 60 ms × 3, 60 ms gap) + distortion
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

    // RED conjunction is act-now danger: duck the mix for 2 s.
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

  /** Lasso fire: electromagnetic "THWIP" (noise burst + resonant filter sweep, 150 ms), the lasso-launch sound. */
  playLassoFire() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.15;

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

  /** Continuous wire-whistle during lasso flight: filtered noise at 800 Hz, very low volume. */
  startLassoWireWhistle() {
    this.stopLassoWireWhistle();
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

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
    gain.gain.linearRampToValueAtTime(0.03, now + 0.1);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.physicalBus);
    noise.start(now);

    this._lassoWhistleNodes = { noise, filter, gain };
  }

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

  /** Lasso winch/reel: mechanical rising-pitch filtered noise, 500 ms; plays during the reel-in after contact. */
  playLassoWinch() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.5;

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

  // NET VOICES. Listener-side gating decides the family: mother (podIndex ≥ 0) plays full volume (default `scale`
  // 1.0), daughter (armIndex ≥ 0) passes DAUGHTER_NET_GAIN. The lasso keeps its own voices. Two loops (flight whistle,
  // reel winch) have explicit stop methods and a single _stopNetLoops() chokepoint called from EVERY terminal path of
  // either family.

  /**
   * Net canister thump: the canister leaving the launcher muzzle. Low body thud + a short pressure "pfft" (the
   * cold-gas ejection), distinct from the lasso's THWIP (playLassoFire) and the daughter's crossbow WOOSH
   * (playArmDeploy). PHYSICAL.
   */
  playNetCanisterThump(scale = 1.0) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(60, now);
    thud.frequency.exponentialRampToValueAtTime(35, now + 0.18);
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.35 * scale, now);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    thud.connect(thudGain);
    thudGain.connect(this.physicalBus);
    thud.start(now);
    thud.stop(now + 0.22);

    const dur = 0.12;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.4));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.18 * scale, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    noise.connect(lp);
    lp.connect(noiseGain);
    noiseGain.connect(this.physicalBus);
    noise.start(now);
    noise.stop(now + dur);
  }

  /**
   * Net flight whistle: continuous loop while a net is airborne. Same idiom as startLassoWireWhistle but a separate
   * instance (the two never overlap by mass routing, but must not share state) and a lower, heavier band (600 Hz vs
   * 800 Hz). ONE instance serves both launcher families (a daughter fire restarts it at DAUGHTER_NET_GAIN); the stop
   * side is event-driven per family plus the any-net-in-flight poll in CaptureNetSystem.update. PHYSICAL.
   */
  startNetFlightWhistle(scale = 1.0) {
    this.stopNetFlightWhistle();
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const bufSize = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const bufData = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) bufData[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 600;
    filter.Q.value = 7;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.035 * scale, now + 0.12);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.physicalBus);
    noise.start(now);

    this._netWhistleNodes = { noise, filter, gain };
  }

  stopNetFlightWhistle() {
    if (!this._netWhistleNodes) return;
    const { noise, gain } = this._netWhistleNodes;
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
    this._netWhistleNodes = null;
  }

  /**
   * Net cinch clamp: the wrapped bundle ratcheting shut on a catch. Heavier than playCatchClamp (whose "net clamp on
   * catch" meaning is taken by ARM_CAPTURED): a low metallic CLUNK + a ratchet buzz tail. Owns the catch moment for
   * NET captures of BOTH families (the daughter's trailing ARM_CAPTURED echo is deduped at the listener). PHYSICAL.
   */
  playNetCinchClamp(scale = 1.0) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const clunk = ctx.createOscillator();
    clunk.type = 'sine';
    clunk.frequency.setValueAtTime(70, now);
    clunk.frequency.exponentialRampToValueAtTime(45, now + 0.2);
    const clunkGain = ctx.createGain();
    clunkGain.gain.setValueAtTime(0.4 * scale, now);
    clunkGain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    clunk.connect(clunkGain);
    clunkGain.connect(this.physicalBus);
    clunk.start(now);
    clunk.stop(now + 0.28);

    const ring = ctx.createOscillator();
    ring.type = 'triangle';
    ring.frequency.setValueAtTime(500, now + 0.02);
    ring.frequency.exponentialRampToValueAtTime(250, now + 0.5);
    const ringGain = ctx.createGain();
    ringGain.gain.setValueAtTime(0.18 * scale, now + 0.02);
    ringGain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    ring.connect(ringGain);
    ringGain.connect(this.physicalBus);
    ring.start(now + 0.02);
    ring.stop(now + 0.55);

    const dur = 0.3;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 4;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 12;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.05 * scale;
    lfo.connect(lfoGain);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.12 * scale, now + 0.05);
    lfoGain.connect(noiseGain.gain);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05 + dur);
    noise.connect(bp);
    bp.connect(noiseGain);
    noiseGain.connect(this.physicalBus);
    noise.start(now + 0.05);
    lfo.start(now + 0.05);
    noise.stop(now + 0.05 + dur);
    lfo.stop(now + 0.05 + dur);
  }

  /**
   * Mother reel winch: continuous loop while the catch reels in, pitch mapped to the remaining distance
   * (updateNetReelPitch). Mechanical ratcheting like playLassoWinch but a LOOP (the mother reel runs 5–25 s, not
   * 500 ms). PHYSICAL.
   */
  startNetReelWinch() {
    this.stopNetReelWinch();
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const bufSize = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const bufData = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) bufData[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;

    // Bandpass centre driven by remainingM (see updateNetReelPitch): starts high (far), falls as the catch closes;
    // the audible range readout.
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 3;

    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 11;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.04;
    lfo.connect(lfoGain);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.15);
    lfoGain.connect(gain.gain);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.physicalBus);
    noise.start(now);
    lfo.start(now);

    this._netWinchNodes = { noise, filter, gain, lfo };
  }

  /**
   * Map the winch pitch to the reel's remaining distance. Called per frame from CaptureNetSystem.update while a mother
   * net reels (cheap: one setTargetAtTime on a live loop; no-op when no winch runs).
   * @param {number} remainingM metres left to reel (≥ 0)
   * @param {number} seedM the seeded reel distance (for normalisation)
   */
  updateNetReelPitch(remainingM, seedM) {
    const nodes = this._netWinchNodes;
    if (!nodes || !this.ctx) return;
    const seed = Math.max(1e-3, seedM || 1);
    const t = clamp01(remainingM / seed);   // 1 = far, 0 = at the muzzle
    // 900 Hz far → 350 Hz at the berth. setTargetAtTime smooths the steps.
    const freq = 350 + 550 * t;
    try {
      nodes.filter.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.05);
    } catch (e) { /* headless stub */ }
  }

  stopNetReelWinch() {
    if (!this._netWinchNodes) return;
    const { noise, gain, lfo } = this._netWinchNodes;
    try {
      if (this.ctx) {
        gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.12);
      }
      const n = noise, l = lfo;
      timerManager.setTimeout(() => {
        try { n.stop(); } catch (e) { /* already stopped */ }
        try { n.disconnect(); } catch (e) { /* already disconnected */ }
        try { l.stop(); } catch (e) { /* already stopped */ }
        try { l.disconnect(); } catch (e) { /* already disconnected */ }
      }, 180, { owner: this });
    } catch (e) { /* audio not available */ }
    this._netWinchNodes = null;
  }

  /**
   * Mother berth clunk: the wrapped package settling onto the launcher at the standoff. A single deep docking thud
   * (distinct from playDockClick's small arm-latch click). PHYSICAL.
   */
  playNetBerthClunk() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(55, now);
    thud.frequency.exponentialRampToValueAtTime(30, now + 0.35);
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.45, now);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    thud.connect(thudGain);
    thudGain.connect(this.physicalBus);
    thud.start(now);
    thud.stop(now + 0.4);

    const tickDur = 0.04;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * tickDur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.2));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.15, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + tickDur);
    noise.connect(hp);
    hp.connect(noiseGain);
    noiseGain.connect(this.physicalBus);
    noise.start(now);
    noise.stop(now + tickDur);
  }

  /**
   * Mother berth chime: short two-note REWARD for a secured whale. Distinct from playCaptureSuccess (single A5,
   * daughter-flavoured): a lower, longer G4→D5 pair that reads as "heavy cargo signed off".
   */
  playNetBerthChime() {
    if (!this.available) return;
    const now = this.ctx.currentTime;
    this._playSineBlip(now,        392, 0.16, 0.20);   // G4
    this._playSineBlip(now + 0.12, 587, 0.22, 0.24);   // D5, held
  }

  /**
   * Net retro-brake hiss: the corner retros firing to arrest the net at BRAKE entry. A mid-band noise burst
   * (~400 ms), distinct from the lasso's contact clank. PHYSICAL.
   */
  playNetBrakeHiss(scale = 1.0) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.4;

    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.6));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2500, now);
    bp.frequency.exponentialRampToValueAtTime(900, now + dur);
    bp.Q.value = 1.5;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.2 * scale, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    noise.connect(bp);
    bp.connect(gain);
    gain.connect(this.physicalBus);
    noise.start(now);
    noise.stop(now + dur);
  }

  /**
   * Net envelop sting: the rim weights sweeping past the catch at ENVELOP peak. A soft fabric "shh" sweep (noise band
   * 1800→600 Hz). PHYSICAL.
   */
  playNetEnvelopSting(scale = 1.0) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.35;

    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.5));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1800, now);
    bp.frequency.exponentialRampToValueAtTime(600, now + dur);
    bp.Q.value = 2.5;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.16 * scale, now + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    noise.connect(bp);
    bp.connect(gain);
    gain.connect(this.physicalBus);
    noise.start(now);
    noise.stop(now + dur);
  }

  /**
   * Net cinch-progress tick: one short ratchet click per 10% cinch threshold, pitched up slightly as the fraction
   * closes (the drawstring tightening). PHYSICAL.
   * @param {number} [fraction=0] cinch fraction 0..1
   */
  playNetCinchTick(fraction = 0, scale = 1.0) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const f = clamp01(fraction);
    const freq = 900 + 500 * f;   // 900 Hz open → 1400 Hz cinched
    const dur = 0.03;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.07 * scale, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(gain);
    gain.connect(this.physicalBus);
    osc.start(now);
    osc.stop(now + dur);
  }

  /**
   * Mother strain rip: the net letting go at the 80–100% rated-mass band. Creak-then-let-go: a rising tension creak
   * (sawtooth 180→400 Hz) that cuts to a noise rip + release drop. Pairs with the strain-slip comms line. PHYSICAL.
   */
  playNetStrainRip() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const creak = ctx.createOscillator();
    creak.type = 'sawtooth';
    creak.frequency.setValueAtTime(180, now);
    creak.frequency.linearRampToValueAtTime(400, now + 0.35);
    const creakGain = ctx.createGain();
    creakGain.gain.setValueAtTime(0.08, now);
    creakGain.gain.linearRampToValueAtTime(0.16, now + 0.3);
    creakGain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
    creak.connect(creakGain);
    creakGain.connect(this.physicalBus);
    creak.start(now);
    creak.stop(now + 0.38);

    const ripDur = 0.2;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * ripDur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.25));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1500;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.25, now + 0.32);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.32 + ripDur);
    noise.connect(hp);
    hp.connect(noiseGain);
    noiseGain.connect(this.physicalBus);
    noise.start(now + 0.32);
    noise.stop(now + 0.32 + ripDur);

    const drop = ctx.createOscillator();
    drop.type = 'sine';
    drop.frequency.setValueAtTime(300, now + 0.34);
    drop.frequency.exponentialRampToValueAtTime(80, now + 0.34 + 0.3);
    const dropGain = ctx.createGain();
    dropGain.gain.setValueAtTime(0.18, now + 0.34);
    dropGain.gain.exponentialRampToValueAtTime(0.001, now + 0.34 + 0.35);
    drop.connect(dropGain);
    dropGain.connect(this.physicalBus);
    drop.start(now + 0.34);
    drop.stop(now + 0.34 + 0.35);
  }

  /**
   * Aim-resolve double-tick: the mother slew settling on the launch attitude. Two short TICK clicks ~70 ms apart (the
   * "locked, then confirmed" gesture), distinct from playClick (single UI tick) and the target-lock PING earcon.
   */
  playAimResolveTick() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const start = now + i * 0.07;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = i === 0 ? 1000 : 1250;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.09, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.04);
      osc.connect(gain);
      gain.connect(this.tickBus);
      osc.start(start);
      osc.stop(start + 0.04);
    }
  }

  /**
   * @private The net-loop chokepoint (§9.5). Called from EVERY net terminal path of BOTH families: mother (catch,
   * miss, release, frag, strain, berth, reel-completed, tab-hide, reset) and daughter (miss, reel-completed stow,
   * release, frag, reset), so no loop can stick. Idempotent. Also releases the ceremony duck, which must not outlive a
   * net of either family.
   */
  _stopNetLoops() {
    this.stopNetFlightWhistle();
    this.stopNetReelWinch();
    this._releaseNetDuck();
  }

  /** @private Idempotent release of the mother-net ceremony duck; pairs with the acquire in the NET_CEREMONY_START handler. */
  _releaseNetDuck() {
    if (!this._netCeremonyDucked) return;
    this._netCeremonyDucked = false;
    this._duckOthers(false);
  }

  /** @private Seconds clock for the daughter catch de-dup ledger: audio clock when live, wall clock headless. */
  _nowS() {
    return (this.ctx && typeof this.ctx.currentTime === 'number')
      ? this.ctx.currentTime : (Date.now() / 1000);
  }

  /**
   * @private Record a daughter NET_CATCH_SUCCESS so the trailing ARM_CAPTURED for the SAME catch (1-2 frames later)
   * skips its whoosh+clamp: one owner per physical moment. Stale entries are pruned on insert so the ledger stays a
   * handful deep.
   * @param {string|number|null|undefined} debrisId
   */
  _recordDaughterNetCatch(debrisId) {
    const now = this._nowS();
    this._lastDaughterNetCatchAt = now;
    for (const [id, t] of this._daughterNetCatchIds) {
      if (now - t > DAUGHTER_CATCH_ECHO_ID_S) this._daughterNetCatchIds.delete(id);
    }
    if (debrisId != null) this._daughterNetCatchIds.set(debrisId, now);
  }

  /**
   * @private True when this ARM_CAPTURED payload echoes a daughter net catch that playNetCinchClamp already voiced.
   * Primary key: debris id (ARM_CAPTURED carries targetId on the arm path, debrisId on the lasso path;
   * NET_CATCH_SUCCESS carries debrisId; same id space) within DAUGHTER_CATCH_ECHO_ID_S. Id-less payloads fall back to
   * the tight DAUGHTER_CATCH_ECHO_FALLBACK_S window. Matches are consumed one-shot so a later genuine capture of the
   * same body keeps its cue.
   * @param {object|undefined} data ARM_CAPTURED payload
   */
  _isDaughterNetCatchEcho(data) {
    const now = this._nowS();
    const id = data ? (data.targetId ?? data.debrisId) : null;
    if (id != null && this._daughterNetCatchIds.has(id)) {
      const t = this._daughterNetCatchIds.get(id);
      this._daughterNetCatchIds.delete(id);
      if (now - t <= DAUGHTER_CATCH_ECHO_ID_S) return true;
    }
    if (id == null && this._lastDaughterNetCatchAt != null
        && now - this._lastDaughterNetCatchAt <= DAUGHTER_CATCH_ECHO_FALLBACK_S) {
      this._lastDaughterNetCatchAt = null;
      return true;
    }
    return false;
  }

  /**
   * @private Play the lock earcon with a ~250 ms dedupe window so a manual SELECTED and the follow-up TARGET_IN_RANGE
   * crossing (or any two near-simultaneous triggers) produce exactly ONE "locked on" sound.
   */
  _playLockDeduped() {
    const t = (this.ctx && typeof this.ctx.currentTime === 'number') ? this.ctx.currentTime : (Date.now() / 1000);
    if (this._lastLockAt != null && (t - this._lastLockAt) < 0.25) return;
    this._lastLockAt = t;
    this.playTargetLock();
  }

  /** Target lock-on: ascending two-note (C5→E5, 60 ms each, sine, slight reverb); FS2/MW2 heritage "target acquired" ping. */
  playTargetLock() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const notes = [523, 659];
    const noteDur = 0.06; // 60ms each

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
      gain.connect(delay);
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

  /** Target lost: descending two-note (E5→C5, 40 ms each), softer and quicker than lock-on to indicate loss. */
  playTargetLost() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const notes = [659, 523];
    const noteDur = 0.04; // 40ms each

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

  /** Docking approach beep with explicit frequency (Hz) and volume (0-1). */
  playDockingBeep(freq, vol) {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Docking beeps own the PING channel: pause the range ticker ~0.5 s so two range sonifications never overlap.
    this._rangeTickerSuppressedUntil = now + 0.5;
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

  /** Transfer-window T-minus cue: two rising cyan blips. */
  playWindowImminent() {
    if (!this.available) return;
    const now = this.ctx.currentTime;
    this._playSineBlip(now,        988, 0.08, 0.20);  // B5
    this._playSineBlip(now + 0.10, 1319, 0.10, 0.22); // E6
  }

  /** Transfer-window open cue: confirming ascending triad. */
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

  stopAlignmentTone() {
    if (!this._alignmentToneOsc) return;
    const now = this.ctx.currentTime;
    this._alignmentToneGain.gain.linearRampToValueAtTime(0.001, now + 0.2);
    this._alignmentToneOsc.stop(now + 0.25);
    this._alignmentToneOsc = null;
    this._alignmentToneGain = null;
  }

  /** Autopilot engage tone: ascending 400→800 Hz (inverse of disengage), 500 ms fade. PING family. */
  playAPEngage() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, now);
    osc.frequency.exponentialRampToValueAtTime(800, now + 0.5);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.linearRampToValueAtTime(0.001, now + 0.5);
    osc.connect(gain);
    gain.connect(this.pingBus);
    osc.start(now);
    osc.stop(now + 0.55);
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

  /** MPD disarm: power-down descending tone (200 → 30 Hz, 0.3 s) + relay click. */
  playMPDDisarm() {
    if (!this.available) return;
    try {
      const ctx = this.ctx;
      const now = ctx.currentTime;

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

  /** Scan initiated: radar sweep/ping, rising sine 800→2000 Hz over 0.3 s with a fade envelope. */
  playScan() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(2000, now + 0.3);

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
    gain.gain.setValueAtTime(0.15, now + 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

    osc.connect(gain);
    gain.connect(this.pingBus);
    osc.start(now);
    osc.stop(now + 0.5);
  }

  /** Cash register "ka-ching": two quick metallic triangle-wave tones, played when credits are awarded (SCORING_AWARD). */
  playCashRegister() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

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

  /**
   * Shop purchase confirm. REWARD family, ka-ching (triangle pair) DNA but pitched below playCashRegister (700/1050 Hz
   * vs 1200/1800) so "spent credits" is audibly distinct from "earned credits". (playCaptureSuccess is capture-only.)
   */
  playPurchase() {
    if (!this.available) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const freqs = [700, 1050];
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freqs[i], now + i * 0.08);
      gain.gain.setValueAtTime(0, now + i * 0.08);
      gain.gain.linearRampToValueAtTime(0.18, now + i * 0.08 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.15);
      osc.connect(gain);
      gain.connect(this.rewardBus);
      osc.start(now + i * 0.08);
      osc.stop(now + i * 0.08 + 0.15);
    }
  }
  /**
   * @private Sine tone with an attack-decay envelope. Shared across families: REWARD chimes by default, PING for the
   * range ticker; the caller passes an explicit family bus when needed.
   * @param {number} startTime AudioContext time to begin
   * @param {number} freq Hz
   * @param {number} dur s
   * @param {number} peakGain 0–1
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
    osc.connect(gain).connect(dest || this.rewardBus || this.sfxBus);
    osc.start(startTime);
    osc.stop(startTime + dur + 0.02);
  }

  /** Soft ascending chime for PRACTICED state transitions. ~150 ms, pitched higher than playClick. */
  playPracticeChime() {
    if (!this.available) return;
    const now = this.ctx.currentTime;
    // Two-note ascending sine: A5 (880 Hz) → C#6 (1108 Hz), 80 ms apart, short
    // decay. Distinct from the hint (G4→B4) and lock (C5→E5) contours.
    this._playSineBlip(now,        880, 0.08, 0.18);
    this._playSineBlip(now + 0.08, 1108, 0.10, 0.22);
  }

  /**
   * Soft "hint posted" notification cue: a gentle, longer, lower triangle
   * swell (~392→494 Hz, ~350 ms, soft attack) so it reads as a "gentle
   * notification" rather than another UI click in the startup blip family.
   * Quiet enough to fade into the ambient mix; peak gain capped at ~0.15.
   * @param {number} [volume=0.4] caller-side scale; clamped to [0, 1].
   */
  playHintPost(volume = 0.4) {
    if (!this.available || !this.ctx) return;
    // Bail when the AudioContext is not running (AutoplayPolicy first-frame race): scheduled oscillators would queue up
    // and trigger a delayed click at first interaction. AudioCue is fire-and-forget; dropping the first chime beats a
    // glitch.
    if (this.ctx.state !== 'running') return;
    const v = clamp01(volume);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dest = this.rewardBus || this.sfxBus || this.master || ctx.destination;
    // Two-note rising notification G4 (392 Hz) → B4 (494 Hz), triangle, soft attack, long decay tail, ~350 ms.
    // Deliberately below playTargetLock (C5→E5) so a hint never sounds like a sensor lock.
    const playNote = (freq, startOffset, durSec) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + startOffset);
      const peak = 0.15 * v;
      gain.gain.setValueAtTime(0.0001, now + startOffset);
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

/**
 * Wake the browser's audio service without blocking. The prewarm has to make `new AudioContext()`, and the first
 * constructor of a page blocks the main thread 117-220 ms (1 ms of CPU; measured, Chromium GPU, headless and headed
 * Brave) until the audio service has started and answered the device query; a second constructor costs 0.1-16 ms.
 * `mediaDevices.enumerateDevices()` makes the same service start-up asynchronously; a constructor after it measured
 * 1-2 ms. So the prewarm calls this first and builds the context when the promise settles.
 *
 * Same gates as the prewarm (desktop only: a coarse primary pointer, no `matchMedia`, or no `mediaDevices` →
 * nothing); `?noAudio=1` stays fully silent. Opens no device, plays nothing, asks for no permission. Called at the
 * start of main.js it delayed the menu by ~75 ms (measured, 10 runs), so it is called after the first draw.
 *
 * @param {object} opts
 * @param {object} opts.win window stand-in (`matchMedia`, `navigator`, `location`)
 * @param {boolean} [opts.pointerChecked=false] the caller already asked the coarse-pointer query
 * @returns {Promise|null} the enumerateDevices() promise (never rejects), or null when nothing was requested
 */
export function warmAudioService({ win, pointerChecked = false } = {}) {
  if (!win) return null;
  try {
    if (!pointerChecked && (typeof win.matchMedia !== 'function' || win.matchMedia('(pointer: coarse)')?.matches)) return null;
    if (new URLSearchParams(devSearch(win.location)).get('noAudio') === '1') return null;
    const md = win.navigator && win.navigator.mediaDevices;
    if (!md || typeof md.enumerateDevices !== 'function') return null;
    const p = md.enumerateDevices();
    if (!p || typeof p.then !== 'function') return null;
    return p.then(() => {}, () => {});   // settled either way; never an unhandled rejection
  } catch (_e) { return null; }
}

/**
 * Start-up prewarm: build the sound system in an idle moment after the first draw, so the first click does not pay
 * the 0.26 s `AudioContext` start (measured). The browser only needs a gesture to RESUME a context, not to create one:
 * the context stays suspended and the first gesture's `InputManager._tryAudioUnlock` resumes it (`init()` is
 * idempotent, so that path never builds a second one).
 *
 * Desktop only: with a coarse primary pointer (iPad / iPhone) nothing is scheduled; no `matchMedia` → also nothing
 * (unknown environment).
 *
 * @param {object} opts
 * @param {object} opts.win window stand-in (`matchMedia`, `requestIdleCallback`, `setTimeout`)
 * @param {{init: Function}} opts.audio the AudioSystem
 * @param {Function} [opts.afterInit] called after init (main.js `_syncAudioCtxState`: the menu keeps the context
 *   suspended even if the browser allowed autoplay)
 * @returns {boolean} true when the prewarm was scheduled
 */
export function scheduleAudioPrewarm({ win, audio, afterInit } = {}) {
  if (!win || !audio || typeof audio.init !== 'function') return false;
  let coarse = true;
  try {
    coarse = typeof win.matchMedia !== 'function' || !!win.matchMedia('(pointer: coarse)')?.matches;
  } catch (_e) { coarse = true; }
  if (coarse) return false;
  const callAfterInit = () => {
    try { if (typeof afterInit === 'function') afterInit(); } catch (_e) { /* never fatal */ }
  };
  const run = () => {
    // A gesture (or other explicit init()) got here first and built/resumed the sound system for a reason (e.g. the
    // menu's departure swell is playing), so the prewarm must not touch it (afterInit would suspend it).
    if (audio._initialized) return;   // init() latches this on success and on ?noAudio
    try { audio.init(); } catch (_e) { /* init() reports its own failures */ }
    const ctx = audio.ctx;
    if (!ctx || !audio.available) { callAfterInit(); return; }
    // Hold: until someone calls init() on purpose (a gesture's _tryAudioUnlock, the menu's Start, comms), play*() stays
    // a no-op as before the prewarm (`available` was false); else events firing on the menu before the first click
    // (e.g. a saved engine-gas switch → FUEL_CHANGED) would queue on the suspended context and all sound at once.
    const hadOwnInit = Object.prototype.hasOwnProperty.call(audio, 'init');
    const prevInit = audio.init;
    let held = true;
    let onChange = null;
    const release = () => {
      if (!held) return;
      held = false;
      if (hadOwnInit) audio.init = prevInit; else delete audio.init;
      audio.available = true;
      if (onChange && typeof ctx.removeEventListener === 'function') ctx.removeEventListener('statechange', onChange);
    };
    audio.available = false;
    audio.init = function (...args) { release(); return prevInit.apply(audio, args); };
    callAfterInit();
    // A browser that allows autoplay may report 'suspended' now and flip to 'running'
    // later; the menu must not run the context, so afterInit runs once more then.
    // Only while still held: after a gesture the context is meant to run.
    if (typeof ctx.addEventListener === 'function') {
      onChange = () => {
        if (!held) { ctx.removeEventListener?.('statechange', onChange); return; }
        if (ctx.state !== 'running') return;
        ctx.removeEventListener?.('statechange', onChange);
        callAfterInit();
      };
      ctx.addEventListener('statechange', onChange);
    }
  };
  const schedule = () => {
    if (typeof win.requestIdleCallback === 'function') {
      win.requestIdleCallback(run, { timeout: 2000 });
    } else {
      (typeof win.setTimeout === 'function' ? win.setTimeout.bind(win) : setTimeout)(run, 0);
    }
  };
  // Wake the audio service first (async); build the context once that settled, so `new AudioContext()` is ~1 ms
  // instead of a 117-220 ms frame. A 1 s cap keeps a browser that never answers from delaying the prewarm.
  const warm = warmAudioService({ win, pointerChecked: true });
  if (warm) {
    let scheduled = false;
    const once = () => { if (scheduled) return; scheduled = true; schedule(); };
    warm.then(once);
    if (typeof win.setTimeout === 'function') win.setTimeout(once, 1000);
  } else {
    schedule();
  }
  return true;
}

export const audioSystem = new AudioSystem();
export default audioSystem;
