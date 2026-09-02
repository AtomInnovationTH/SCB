/**
 * LadderSfx.js — the Zoom Ladder's interaction sound effects (00-spec §4 audio
 * + 08-workbench §2 "Sound"): ratchet ticks while charging, the pitched
 * crossing clunk (up outward / down inward), the flick-to-wall soft tick, the
 * "↶" undo-affordance chime, the Q10 post-arrival horizon-level settle, and
 * the workbench pane "air" (consumer arrives Wave 5).
 *
 * One module owns all six sounds. Each is a short procedural one-shot in the
 * house style (AudioSystem.js playClick / thud idiom): oscillator or
 * noise-burst layers through optional biquad filters into a per-shot envelope
 * gain, all at VERY low gain — these sit UNDER gameplay sfx (§ the beds' 0.02
 * family), navigation feedback rather than events. Sound character is entirely
 * data-driven (SFX_RECIPES below): retuning a sound is a constants edit, not
 * code surgery.
 *
 * Feed (decision-driven — there is NO per-frame API): LadderController
 * translates the ZoomLadder core's decisions (docs/ladder/06-core-api.md:
 * "Audio is NOT a decision type: S2 derives ratchet from `charge`, clunk from
 * `cross.direction`") into the hooks below:
 *   onCharge(charge, side)  ← every `charge` decision (ratchet steps up)
 *   onCross(direction)      ← every `cross` decision ('out' ↑ / 'in' ↓ clunk)
 *   onRide(kind)            ← every `ride` decision (only 'flickWall' sounds)
 *   onUndoWindow(armed)     ← a CROSS ride's rideFinished (the 800 ms
 *                             FLICK_UNDO_WINDOW arms — one "↶" chime)
 *   onLevelPhase()          ← the Q10 level-to-north phase start (~600 ms,
 *                             CameraSystem.isLadderLeveling rise edge)
 *   onPaneSlide(open)       ← Wave-5 workbench panes (REFIT / TECH LIBRARY)
 *   reset()                 ← ladder disengage (clears transient state)
 *
 * Owner compass: every state change = one sound, one glyph — each hook call
 * builds at most ONE recipe graph, repeats of the same state build none
 * (ratchet steps are quantized; the undo chime is armed-edge-only).
 *
 * Discipline:
 *   - G1 (docs/ladder/02-traps.md): no per-frame churn. Hooks fire on
 *     DECISIONS (wheel events / ride completions), and the ratchet quantizer
 *     bounds even those to one tick per step crossed.
 *   - §13 energy (AudioSystem.js:184-206): nothing runs while silent — every
 *     source is a one-shot with a scheduled stop() at envelope end (+ margin)
 *     and the first source's `ended` event frees the whole shot's sub-graph
 *     (the LadderAudioBeds condemn idiom; the WebAudio clock is the only
 *     scheduler, no JS timers). No loops idle between sounds.
 *   - Autoplay: this module NEVER calls ctx.resume()/init(). It plays into the
 *     AudioContext AudioSystem created on a user gesture (MenuScreen.js:811);
 *     the deps resolve null until then, so every call before the gesture is a
 *     no-op (AudioSystem unlock pattern).
 *   - Deps optional (LadderAudioBeds pattern): without a context/destination
 *     every method is a no-op. Headless-safe import: no THREE, no DOM, no
 *     EventBus — this module imports NOTHING.
 *
 * Wiring (serial track — see the LadderSfx HANDOFF): main.js constructs it
 * with AudioSystem GETTERS (ctx + tickBus: ladder sfx are input confirms, the
 * TICK family — they ride tickBus → sfxBus → master so alarm ducking,
 * setVolume, and the §12.12 suspend gate govern them for free) and injects it
 * into LadderController as the optional `sfx` dep, which feeds the hooks from
 * the decisions it already handles in _apply/_startRide.
 *
 * @module systems/LadderSfx
 */

// ── Tunables (own-module, house rule: not FloorContract/Constants) ──────────

/** Hard ceiling for every recipe's envelope peak gain (the beds' low family). */
export const SFX_GAIN_CAP = 0.02;

/** Exponential-decay floor the envelope ramps to (never 0 — WebAudio rule). */
export const SFX_ENV_FLOOR = 0.0001;

/** Safety margin after the envelope end before the scheduled source.stop(), ms. */
export const SFX_STOP_MARGIN_MS = 50;

/** Sfx-bus base gain (everything below is scaled by this one knob). */
export const SFX_MASTER_GAIN = 1.0;

/** Looped noise-buffer length, seconds (one-shots are short; loop covers durMs). */
export const SFX_NOISE_BUFFER_S = 0.5;

/** Ratchet quantizer: charge 0..1 splits into this many tick steps (G1 bound). */
export const RATCHET_STEPS = 8;

/** Ratchet pitch rise: tick pitch factor = 1 + charge × this (1× → 2.2×). */
export const RATCHET_PITCH_RISE = 1.2;

/** Crossing clunk pitch factor, outward ('out' — zooming out, pitch UP). */
export const CLUNK_PITCH_OUT = 1.25;

/** Crossing clunk pitch factor, inward ('in' — zooming in, pitch DOWN). */
export const CLUNK_PITCH_IN = 0.8;

/** Pane "air" pitch factor when a workbench pane slides OPEN. */
export const PANE_PITCH_OPEN = 1.1;

/** Pane "air" pitch factor when a workbench pane slides CLOSED. */
export const PANE_PITCH_CLOSE = 0.9;

/**
 * SFX_RECIPES — per-sound synth params (the data-driven character table).
 *
 * Shape:
 *   { gain, durMs, attackMs, layers: [layer...] }
 *   layer (osc):   { kind:'osc', wave, freq, freqEnd?, gain }
 *   layer (noise): { kind:'noise', filter:{type, freq, freqEnd?, Q}, gain }
 *
 * `gain` is the shot's envelope peak (pinned ≤ SFX_GAIN_CAP — these sit UNDER
 * gameplay sfx, alongside the beds' 0.02 family); layer gains are static
 * texture balance INSIDE the shot. The envelope is born silent, linear-ramps
 * to `gain` over attackMs, then exponentially decays to SFX_ENV_FLOOR at
 * durMs. `freqEnd` glides the osc (or filter center) across the full durMs.
 * A per-call pitch factor (ratchet charge, clunk direction, pane direction)
 * multiplies every layer's osc + filter frequencies coherently.
 */
export const SFX_RECIPES = {
  // (a) Ratchet tick — one per charge step while pushing a hump spring
  // (00-spec §4 "ratchet ticks while charging"). Pitch follows charge 0..1.
  ratchet: {
    gain: 0.012, durMs: 30, attackMs: 2,
    layers: [
      { kind: 'osc', wave: 'triangle', freq: 340, gain: 1.0 },
    ],
  },
  // (b) Crossing clunk — the hump gives way (00-spec §4 "clunk on crossing,
  // pitch up for outward, down for inward"): low body drop + a soft knock.
  clunk: {
    gain: 0.018, durMs: 140, attackMs: 4,
    layers: [
      { kind: 'osc', wave: 'sine', freq: 150, freqEnd: 95, gain: 0.8 },
      { kind: 'noise', filter: { type: 'lowpass', freq: 320, Q: 0.8 }, gain: 0.35 },
    ],
  },
  // (c) Flick-to-wall soft tick — the within-floor flickWall ride (G3): a
  // lighter, higher cousin of the ratchet tick (arrival at the wall edge).
  flickTick: {
    gain: 0.008, durMs: 24, attackMs: 2,
    layers: [
      { kind: 'osc', wave: 'sine', freq: 620, gain: 1.0 },
    ],
  },
  // (d) "↶" undo-affordance chime — the 800 ms FLICK_UNDO_WINDOW arms after a
  // cross completes: a gentle downward curl ("you can step back"), soft attack.
  undoChime: {
    gain: 0.010, durMs: 180, attackMs: 8,
    layers: [
      { kind: 'osc', wave: 'sine', freq: 740, freqEnd: 555, gain: 1.0 },
    ],
  },
  // (e) Level-phase settle — the Q10 post-arrival horizon-level motion
  // (~600 ms, CameraSystem LADDER_LEVEL_MS — durMs mirrors it, no import):
  // a downward-settling noise whoosh under a soft G4+C5 dyad.
  level: {
    gain: 0.010, durMs: 600, attackMs: 120,
    layers: [
      { kind: 'noise', filter: { type: 'lowpass', freq: 900, freqEnd: 240, Q: 0.7 }, gain: 0.6 },
      { kind: 'osc', wave: 'sine', freq: 392, gain: 0.18 },
      { kind: 'osc', wave: 'sine', freq: 523.25, gain: 0.14 },
    ],
  },
  // (f) Pane "air" — a workbench pane slides (240–300 ms, 01-numbers): a soft
  // air band, pitched up on open / down on close. Consumer arrives Wave 5.
  paneAir: {
    gain: 0.008, durMs: 260, attackMs: 60,
    layers: [
      { kind: 'noise', filter: { type: 'bandpass', freq: 1100, Q: 1.1 }, gain: 1.0 },
    ],
  },
};

export class LadderSfx {
  /**
   * @param {object} [deps]
   * @param {AudioContext|function} [deps.context] - AudioSystem's ctx, or a
   *   zero-arg getter (main.js wires `() => audioSystem.ctx` — null until the
   *   user-gesture init(), which keeps this module on the unlock pattern).
   * @param {AudioNode|function}    [deps.destination] - the node sfx feed
   *   (recommended: audioSystem.tickBus — input confirms ride the TICK family
   *   → sfxBus → master, so ducking/volume/suspend govern them), or a zero-arg
   *   getter. Either dep absent/null ⇒ every method is a no-op.
   */
  constructor(deps = {}) {
    this._ctxDep = deps.context || null;
    this._destDep = deps.destination || null;
    this._ctx = null;          // resolved lazily on first use
    this._dest = null;
    this._bus = null;          // sfx bus: shotGain → bus → destination
    this._enabled = true;      // master-mute gate (setEnabled)
    this._disposed = false;
    /** Last ratchet step ticked this gesture (-1 = idle; ticks on increase). */
    this._ratchetStep = -1;
    /** Undo window armed (chime is armed-edge-only — one per completed cross). */
    this._undoArmed = false;
    this._noise = null;        // shared looped noise buffer (per context)
    this._noiseCtx = null;
  }

  // ── Public API (the LadderController feed) ─────────────────────────────────

  /**
   * `charge` decision → ratchet. Ticks once each time the charge climbs into a
   * new step of the RATCHET_STEPS quantizer (a real ratchet: the pawl clicks
   * on the drive stroke, slips back silently). Pitch rises with charge.
   * charge 0 (spring release) resets the gesture.
   * @param {number} charge - normalized 0..1 (the decision's `charge`)
   * @param {string} [_side] - 'up'|'down' (decision `side`; reserved for retune)
   */
  onCharge(charge, _side) {
    if (this._disposed || !this._enabled) return;
    const c = Math.max(0, Math.min(1, Number(charge) || 0));
    if (c <= 0) { this._ratchetStep = -1; return; }
    const step = Math.min(RATCHET_STEPS - 1, Math.floor(c * RATCHET_STEPS));
    if (step <= this._ratchetStep) {
      this._ratchetStep = step;       // slipped back — silent (re-climb re-ticks)
      return;
    }
    this._ratchetStep = step;
    this._play('ratchet', 1 + c * RATCHET_PITCH_RISE);
  }

  /**
   * `cross` decision → the pitched clunk (00-spec §4): pitch UP for outward
   * ('out'), DOWN for inward ('in'). A cross ends the charge gesture and
   * clears any armed undo window (the core clears it on any new player ride).
   * @param {string} direction - 'in'|'out' (the decision's `direction`)
   */
  onCross(direction) {
    if (this._disposed || !this._enabled) return;
    this._ratchetStep = -1;
    this._undoArmed = false;
    this._play('clunk', direction === 'in' ? CLUNK_PITCH_IN : CLUNK_PITCH_OUT);
  }

  /**
   * `ride` decision → only the G3 flick-to-wall ride sounds (a soft tick);
   * jump/page/esc/aimDown/alarmAuto rides are silent (low-friction, never
   * noisy — their state change is the arrival, which the beds voice). Any
   * player ride ends the charge gesture and clears the armed undo window.
   * @param {string} kind - the decision's `kind`
   */
  onRide(kind) {
    if (this._disposed || !this._enabled) return;
    this._ratchetStep = -1;
    this._undoArmed = false;
    if (kind === 'flickWall') this._play('flickTick');
  }

  /**
   * The FLICK_UNDO_WINDOW (800 ms) armed/cleared — armed only by a completed
   * CROSS ride (LadderController's rideFinished path). One "↶" chime per arm
   * (armed-edge-only: repeats while armed are silent; false just clears).
   * @param {boolean} armed
   */
  onUndoWindow(armed) {
    if (this._disposed) return;
    if (!armed) { this._undoArmed = false; return; }
    if (!this._enabled) return;
    if (this._undoArmed) return;      // already chimed for this window
    this._undoArmed = true;
    this._play('undoChime');
  }

  /**
   * The Q10 post-arrival horizon-level phase started (~600 ms — "level the
   * horizon to north as a separate motion with its own sound"). Fired on the
   * CameraSystem.isLadderLeveling() rise edge (main.js serial wire).
   */
  onLevelPhase() {
    if (this._disposed || !this._enabled) return;
    this._play('level');
  }

  /**
   * A workbench pane slid (08-workbench §2 "pane 'air' on slide"). The Wave-5
   * pane consumers (RefitPane / LibraryPane) call this; exposed now so the
   * recipe + surface are pinned.
   * @param {boolean} open - true on slide-open, false on slide-closed
   */
  onPaneSlide(open) {
    if (this._disposed || !this._enabled) return;
    this._play('paneAir', open ? PANE_PITCH_OPEN : PANE_PITCH_CLOSE);
  }

  /** Clear transient gesture state (ladder disengage). No nodes to tear down. */
  reset() {
    this._ratchetStep = -1;
    this._undoArmed = false;
  }

  /**
   * Master-mute gate. One-shots die by their own scheduled stop, so disabling
   * only gates future triggers (and clears gesture state); nothing to fade.
   * @param {boolean} on
   */
  setEnabled(on) {
    if (this._disposed) return;
    const want = !!on;
    if (want === this._enabled) return;
    this._enabled = want;
    if (!want) this.reset();
  }

  /** Immediate teardown: disconnect the bus; further calls no-op. In-flight
   *  one-shots stop at their already-scheduled times (§13 bounded life). */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.reset();
    if (this._bus) {
      try { this._bus.disconnect(); } catch (_e) { /* stub */ }
      this._bus = null;
    }
    this._ctx = null;
    this._dest = null;
    this._noise = null;
    this._noiseCtx = null;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * @private Resolve the injected context/destination (direct ref or getter).
   * Retried on every trigger: before AudioSystem's user-gesture init() both
   * resolve null and the module stays a no-op (unlock pattern).
   * @returns {boolean} true when live audio deps are available
   */
  _resolve() {
    if (this._ctx && this._dest) return true;
    const ctx = (typeof this._ctxDep === 'function') ? this._ctxDep() : this._ctxDep;
    const dest = (typeof this._destDep === 'function') ? this._destDep() : this._destDep;
    if (!ctx || !dest) return false;
    this._ctx = ctx;
    this._dest = dest;
    return true;
  }

  /**
   * @private Lazy sfx bus: shotGain(per one-shot) → bus(SFX_MASTER_GAIN) →
   * injected destination. Created once, on the first sound.
   */
  _ensureBus() {
    if (this._bus) return this._bus;
    const bus = this._ctx.createGain();
    bus.gain.value = SFX_MASTER_GAIN;
    bus.connect(this._dest);
    this._bus = bus;
    return bus;
  }

  /**
   * @private Build + fire one SFX_RECIPES one-shot: every layer feeds a shot
   * envelope gain born at 0 (never a click/pop), sources start(now) and carry
   * a scheduled stop(now + durMs + margin); the first source's `ended` event
   * frees the shot's whole sub-graph (the beds' condemn idiom — no JS timers,
   * the WebAudio clock is the scheduler).
   * @param {string} name - SFX_RECIPES key
   * @param {number} [pitch=1] - coherent frequency factor (osc + filter)
   */
  _play(name, pitch = 1) {
    if (!this._resolve()) return;
    const recipe = SFX_RECIPES[name];
    if (!recipe) return;
    try {
      const ctx = this._ctx;
      const bus = this._ensureBus();
      const now = ctx.currentTime;
      const durS = recipe.durMs / 1000;
      const atkS = Math.min(recipe.attackMs, recipe.durMs) / 1000;
      // Shot envelope: silent birth → peak by attack → exp decay to the floor.
      const shotGain = ctx.createGain();
      shotGain.gain.setValueAtTime(0, now);
      shotGain.gain.linearRampToValueAtTime(recipe.gain, now + atkS);
      shotGain.gain.exponentialRampToValueAtTime(SFX_ENV_FLOOR, now + durS);
      shotGain.connect(bus);
      const sources = [];
      const nodes = [shotGain];
      const stopAt = now + durS + SFX_STOP_MARGIN_MS / 1000;

      for (const layer of recipe.layers) {
        // Source: oscillator (with optional glide) or looped noise burst.
        let src;
        if (layer.kind === 'noise') {
          src = ctx.createBufferSource();
          src.buffer = this._noiseBuffer();
          src.loop = true;              // scheduled stop bounds it (§13)
        } else {
          src = ctx.createOscillator();
          src.type = layer.wave;
          src.frequency.setValueAtTime(layer.freq * pitch, now);
          if (layer.freqEnd != null) {
            src.frequency.exponentialRampToValueAtTime(layer.freqEnd * pitch, now + durS);
          }
        }
        // Optional shaping filter (noise color / sweep).
        let head = src;
        let filter = null;
        if (layer.filter) {
          filter = ctx.createBiquadFilter();
          filter.type = layer.filter.type;
          filter.frequency.setValueAtTime(layer.filter.freq * pitch, now);
          if (layer.filter.freqEnd != null) {
            filter.frequency.exponentialRampToValueAtTime(layer.filter.freqEnd * pitch, now + durS);
          }
          filter.Q.value = layer.filter.Q;
          head.connect(filter);
          head = filter;
          nodes.push(filter);
        }
        // Layer balance gain → shot envelope gain.
        const layerGain = ctx.createGain();
        layerGain.gain.value = layer.gain;
        head.connect(layerGain);
        layerGain.connect(shotGain);
        nodes.push(layerGain);

        src.start(now);
        src.stop(stopAt);
        sources.push(src);
        nodes.push(src);
      }
      // One cleanup owner: the first source's ended event frees the shot's
      // graph so the nodes can GC — nothing idles between sounds (§13).
      const first = sources[0];
      if (first) {
        first.onended = () => {
          for (const n of nodes) {
            try { if (n.disconnect) n.disconnect(); } catch (_e) { /* stub */ }
          }
          nodes.length = 0;
          sources.length = 0;
        };
      }
    } catch (_e) {
      /* stub/ancient-browser failure — sfx stay silent, game unaffected */
    }
  }

  /**
   * @private Shared looped white-noise buffer (SFX_NOISE_BUFFER_S at the
   * context's sample rate), built once per context — every noise layer reuses
   * it (the beds/startAmbientLoop share one buffer the same way).
   */
  _noiseBuffer() {
    if (this._noise && this._noiseCtx === this._ctx) return this._noise;
    const len = Math.max(1, Math.floor(this._ctx.sampleRate * SFX_NOISE_BUFFER_S));
    const buf = this._ctx.createBuffer(1, len, this._ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noise = buf;
    this._noiseCtx = this._ctx;
    return buf;
  }
}
