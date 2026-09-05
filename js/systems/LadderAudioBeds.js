/**
 * LadderAudioBeds.js — the Zoom Ladder's per-floor ambient audio beds
 * (FloorContract `audioBed`: hull-detail,
 * command-deck, prox-tactical, navcom-drone, downlink-static).
 *
 * One module owns all seven beds. Each bed is a procedural WebAudio loop in
 * the house style (AudioSystem.js startAmbientLoop / startForgeHum idiom):
 * looped-noise-buffer + biquad-filter layers and low oscillator drones, each
 * layer shaped by an optional slow LFO, all at VERY low gain — beds sit UNDER
 * gameplay sfx, mood not melody. Bed character is entirely data-driven
 * (BED_RECIPES below): retuning a bed is a constants edit, not code surgery.
 *
 * Lifecycle (floor changes drive it — there is NO per-frame API):
 *   setFloor(floorId|null) crossfades ~BED_FADE_MS between beds via
 *   linearRampToValueAtTime gain ramps (scheduled ramps cancelled on every
 *   re-target, the _duckOthers idiom); null fades to silence (disengage).
 *   setEnabled(bool) is the master-mute seam; dispose() tears down.
 *
 * Discipline:
 *   - G1 (docs/ladder/02-traps.md): no per-frame node churn. Nodes are built
 *     lazily on bed activation and condemned on deactivation — graph edits
 *     happen only on floor changes / enable flips, never per frame.
 *   - §13 energy (AudioSystem.js:184-206, Constants.AUDIO): only the ACTIVE
 *     bed's sources run (plus a bounded fade-out overlap). A deactivated bed's
 *     sources get a scheduled stop() at fade end and free their graph via the
 *     first source's `ended` event — the audio thread never carries seven
 *     idle loops (no JS timers either: the WebAudio clock is the scheduler).
 *   - Autoplay: this module NEVER calls ctx.resume()/init(). It plays into the
 *     AudioContext AudioSystem created on a user gesture (MenuScreen.js:811 —
 *     init() + resume()); the deps resolve null until then, so every call
 *     before the gesture is a state-only no-op (AudioSystem unlock pattern).
 *   - Deps optional (NavcomFloor pattern): without a context/destination every
 *     method is a no-op. Headless-safe import: no THREE, no DOM, no EventBus —
 *     the only imports are pure data.
 *
 * Wiring (serial track — see the audio-beds HANDOFF in docs/ladder/03-plan.md):
 * main.js constructs it with AudioSystem's context + padBus (PAD family:
 * beds ride padBus → sfxBus → master, so alarm ducking, setVolume, and the
 * §12.12 ctx suspend gate all govern beds for free) and injects it into
 * LadderController, which calls setFloor(floor) from _applyFloorContent and
 * setFloor(null) from _disengage.
 *
 * @module systems/LadderAudioBeds
 */

import { FloorContract } from '../core/FloorContract.js';

// ── Tunables (own-module, house rule: not FloorContract/Constants) ──────────

/** Crossfade length between beds (and to silence), ms. */
export const BED_FADE_MS = 1500;

/** Master-mute gate fade (setEnabled), ms — snappier than a floor crossfade. */
export const BED_DISABLE_FADE_MS = 250;

/** Safety margin after a fade-out before the scheduled source.stop(), ms. */
export const BED_STOP_MARGIN_MS = 50;

/** Beds-bus base gain (everything below is scaled by this one knob). */
export const BED_MASTER_GAIN = 1.0;

/** Looped noise-buffer length, seconds (house pattern: startAmbientLoop's 2 s). */
export const BED_NOISE_BUFFER_S = 2;

/**
 * BED_RECIPES — per-name synth params (the data-driven bed character table).
 *
 * Shape:
 *   { gain, layers: [layer...] }
 *   layer (noise): { kind:'noise', filter:{type,freq,Q}, gain, lfo? }
 *   layer (osc):   { kind:'osc', wave, freq, detune?, filter?, gain, lfo? }
 *   lfo:           { rate, depth, target:'gain'|'freq', wave? }
 *     — a slow oscillator wired lfoOsc → lfoGain(depth) → layerGain.gain (or
 *       filter.frequency). depth is in the target param's units and must keep
 *       base − depth ≥ 0 for gain targets.
 *
 * `gain` is the bed's crossfade target on its bed-gain node; layer gains are
 * static texture balance INSIDE the bed. Levels sit at/under the house
 * ambient loop (Constants.AUDIO.AMBIENT_GAIN 0.01, solar hiss 0.005) — beds
 * are the floor's room tone, below every gameplay cue.
 */
export const BED_RECIPES = {
  // (The old F1 ARCHIVE 'archive-hush' and F2 DEPOT 'depot-hum' recipes left
  // with their floors — Wave 5 Session H, the 7→5 renumber.)
  // F1 HULL CAM — EVA closeness: suit-air band of noise, faint structural
  // fundamental; the bandpass center wanders slowly (helmet-turn air).
  'hull-detail': {
    gain: 0.011,
    layers: [
      { kind: 'noise', filter: { type: 'bandpass', freq: 900, Q: 1.2 }, gain: 0.55,
        lfo: { rate: 0.07, depth: 220, target: 'freq' } },
      { kind: 'osc', wave: 'sine', freq: 120, gain: 0.25 },
    ],
  },
  // F2 COMMAND — the shipped gameplay floor: barely-there deck air so every
  // capture cue keeps its full contrast. The quietest bed by design.
  'command-deck': {
    gain: 0.008,
    layers: [
      { kind: 'noise', filter: { type: 'bandpass', freq: 180, Q: 0.6 }, gain: 0.6,
        lfo: { rate: 0.09, depth: 0.15, target: 'gain' } },
      { kind: 'osc', wave: 'triangle', freq: 90, gain: 0.18 },
    ],
  },
  // F3 PROX NET — tactical tension: mid noise band + a slow sweep pulse on a
  // low tone (radar-scan feel, far under the real conjunction alarms).
  'prox-tactical': {
    gain: 0.012,
    layers: [
      { kind: 'noise', filter: { type: 'bandpass', freq: 500, Q: 1.5 }, gain: 0.45,
        lfo: { rate: 0.13, depth: 0.12, target: 'gain' } },
      { kind: 'osc', wave: 'sine', freq: 220, gain: 0.22,
        lfo: { rate: 0.25, depth: 0.16, target: 'gain' } },
    ],
  },
  // F4 NAVCOM — planning drone: a detuned low pair through a lowpass; the
  // ~0.7 Hz beat between them IS the drone character (no LFO needed on the
  // pair — the detune supplies the motion; one slow breath on the noise).
  'navcom-drone': {
    gain: 0.013,
    layers: [
      { kind: 'osc', wave: 'triangle', freq: 65, filter: { type: 'lowpass', freq: 300, Q: 0.8 }, gain: 0.5 },
      { kind: 'osc', wave: 'triangle', freq: 65.7, filter: { type: 'lowpass', freq: 300, Q: 0.8 }, gain: 0.5 },
      { kind: 'noise', filter: { type: 'lowpass', freq: 150, Q: 0.5 }, gain: 0.25,
        lfo: { rate: 0.06, depth: 0.18, target: 'gain' } },
    ],
  },
  // F5 SDA DOWNLINK — telemetry static: a narrow high noise band gated by a
  // square LFO into soft ticks, over a faint carrier whistle.
  'downlink-static': {
    gain: 0.010,
    layers: [
      { kind: 'noise', filter: { type: 'bandpass', freq: 2000, Q: 8 }, gain: 0.4,
        lfo: { rate: 1.3, depth: 0.35, target: 'gain', wave: 'square' } },
      { kind: 'osc', wave: 'sine', freq: 1046, gain: 0.05,
        lfo: { rate: 0.17, depth: 0.035, target: 'gain' } },
    ],
  },
};

/** floorId → audioBed name, straight from the SSOT (pure data import). */
const FLOOR_BED = new Map(FloorContract.FLOORS.map((f) => [f.id, f.audioBed]));

export class LadderAudioBeds {
  /**
   * @param {object} [deps]
   * @param {AudioContext|function} [deps.context] - AudioSystem's ctx, or a
   *   zero-arg getter (main.js wires `() => audioSystem.ctx` — null until the
   *   user-gesture init(), which keeps this module on the unlock pattern).
   * @param {AudioNode|function}    [deps.destination] - the node beds feed
   *   (recommended: audioSystem.padBus so ducking/volume/suspend govern beds),
   *   or a zero-arg getter. Either dep absent/null ⇒ every method is a no-op.
   */
  constructor(deps = {}) {
    this._ctxDep = deps.context || null;
    this._destDep = deps.destination || null;
    this._ctx = null;          // resolved lazily on first use
    this._dest = null;
    this._bus = null;          // beds bus: bedGain → bus → destination
    this._enabled = true;      // master-mute gate (setEnabled)
    this._floorId = null;      // last requested floor (remembered while disabled)
    this._currentName = null;  // bed name currently ramped up (null = silence)
    /** @type {Map<string, object>} live (non-condemned) bed name → instance */
    this._live = new Map();
    this._noise = null;        // shared looped noise buffer (per context)
    this._noiseCtx = null;
    this._disposed = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Crossfade the beds to `floorId`'s audioBed (~BED_FADE_MS). null fades to
   * silence (ladder disengage). Idempotent for the already-active bed. While
   * disabled (setEnabled(false)) only the floor is remembered — no nodes.
   * @param {number|null} floorId - FloorContract floor id (1..7) or null
   */
  setFloor(floorId) {
    if (this._disposed) return;
    this._floorId = (typeof floorId === 'number') ? floorId : null;
    if (!this._enabled) return;             // remembered; built on re-enable
    const name = this._floorId != null ? (FLOOR_BED.get(this._floorId) || null) : null;
    this._crossfadeTo(name, BED_FADE_MS / 1000);
  }

  /**
   * Master-mute gate. Disabling fades the active bed out (BED_DISABLE_FADE_MS)
   * and frees its sources (no muted loops burning the audio thread — §13);
   * re-enabling rebuilds the remembered floor's bed. Idempotent.
   * @param {boolean} on
   */
  setEnabled(on) {
    if (this._disposed) return;
    const want = !!on;
    if (want === this._enabled) return;
    this._enabled = want;
    if (!want) {
      this._crossfadeTo(null, BED_DISABLE_FADE_MS / 1000);
    } else if (this._floorId != null) {
      const name = FLOOR_BED.get(this._floorId) || null;
      this._crossfadeTo(name, BED_FADE_MS / 1000);
    }
  }

  /** Immediate teardown: stop + disconnect everything; further calls no-op. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const ctx = this._ctx;
    for (const bed of this._live.values()) {
      try {
        const now = ctx ? ctx.currentTime : 0;
        if (bed.gain) {
          bed.gain.gain.cancelScheduledValues(now);
          bed.gain.gain.setValueAtTime(0, now);
        }
        for (const s of bed.sources) { try { s.stop(); } catch (_e) { /* not started / stopped */ } }
        this._freeBed(bed);
      } catch (_e) { /* headless stub */ }
    }
    this._live.clear();
    this._currentName = null;
    if (this._bus) {
      try { this._bus.disconnect(); } catch (_e) { /* stub */ }
      this._bus = null;
    }
    this._ctx = null;
    this._dest = null;
  }

  /** The bed name currently ramped up, or null (tests/debug). */
  getCurrentBedName() { return this._currentName; }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * @private Resolve the injected context/destination (direct ref or getter).
   * Retried on every floor change / enable flip: before AudioSystem's
   * user-gesture init() both resolve null and the module stays a no-op.
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
   * @private Retarget the mix to bed `name` (null = silence) over `fadeS`.
   * The active-bed ramp and every other live bed's fade-out both cancel any
   * scheduled ramps first (re-target discipline), so rapid floor changes
   * never fight stale automation.
   * @param {string|null} name
   * @param {number} fadeS
   */
  _crossfadeTo(name, fadeS) {
    if (!this._resolve()) { this._currentName = name; return; }
    // Idempotence: the requested bed is already the ramped-up one and still
    // live — nothing to schedule (repeat setFloor on the same floor).
    if (name === this._currentName && (name == null || this._live.has(name))) return;
    this._currentName = name;
    const now = this._ctx.currentTime;
    // Fade out every live bed that isn't the target (usually one).
    for (const [bedName, bed] of this._live) {
      if (bedName === name) continue;
      this._condemn(bed, now, fadeS);
      this._live.delete(bedName);
    }
    if (name == null) return;
    // Fade the target in — reuse the live instance (re-target mid-fade) or
    // build fresh (first use / previously condemned).
    let bed = this._live.get(name);
    if (!bed) {
      bed = this._buildBed(name);
      if (!bed) return; // unknown name or stub failure — silence is safe
      this._live.set(name, bed);
    }
    const recipe = BED_RECIPES[name];
    const p = bed.gain.gain;
    try {
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(recipe.gain, now + fadeS);
    } catch (_e) { /* headless stub */ }
  }

  /**
   * @private Fade a bed to zero and condemn it: sources get a scheduled
   * stop() at fade end (+ margin) and the first source's `ended` event frees
   * the whole sub-graph. Condemned beds are never revived — a return to the
   * floor builds a fresh instance (bounded overlap, floor-change cadence).
   * @param {object} bed
   * @param {number} now  - ctx.currentTime
   * @param {number} fadeS
   */
  _condemn(bed, now, fadeS) {
    const p = bed.gain.gain;
    try {
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(0, now + fadeS);
    } catch (_e) { /* headless stub */ }
    const stopAt = now + fadeS + BED_STOP_MARGIN_MS / 1000;
    for (const s of bed.sources) {
      try { s.stop(stopAt); } catch (_e) { /* already stopped */ }
    }
    // One cleanup owner: the first source's ended event (WebAudio clock —
    // no JS timers; a suspended ctx simply defers it, matching §12.12).
    const first = bed.sources[0];
    if (first) {
      first.onended = () => this._freeBed(bed);
    } else {
      this._freeBed(bed);
    }
  }

  /** @private Disconnect a bed's whole sub-graph so the nodes can GC. */
  _freeBed(bed) {
    for (const n of bed.nodes) {
      try { if (n.disconnect) n.disconnect(); } catch (_e) { /* stub */ }
    }
    bed.nodes.length = 0;
    bed.sources.length = 0;
  }

  /**
   * @private Lazy beds bus: bedGain(per bed) → bus(BED_MASTER_GAIN) →
   * injected destination. Created once, on the first bed build.
   */
  _ensureBus() {
    if (this._bus) return this._bus;
    const bus = this._ctx.createGain();
    bus.gain.value = BED_MASTER_GAIN;
    bus.connect(this._dest);
    this._bus = bus;
    return bus;
  }

  /**
   * @private Build one bed instance from its BED_RECIPES entry. All layers
   * feed a per-bed gain that starts at 0 (the crossfade ramps it up), so a
   * fresh bed is born silent — never a click, never an autoplay pop.
   * @param {string} name
   * @returns {{gain:GainNode, sources:Array, nodes:Array}|null}
   */
  _buildBed(name) {
    const recipe = BED_RECIPES[name];
    if (!recipe) return null;
    try {
      const ctx = this._ctx;
      const bus = this._ensureBus();
      const bedGain = ctx.createGain();
      bedGain.gain.value = 0;
      bedGain.connect(bus);
      const sources = [];
      const nodes = [bedGain];

      for (const layer of recipe.layers) {
        // Source: looped noise buffer or oscillator (house idioms).
        let src;
        if (layer.kind === 'noise') {
          src = ctx.createBufferSource();
          src.buffer = this._noiseBuffer();
          src.loop = true;
        } else {
          src = ctx.createOscillator();
          src.type = layer.wave;
          src.frequency.value = layer.freq;
          if (layer.detune != null && src.detune) src.detune.value = layer.detune;
        }
        // Optional shaping filter.
        let head = src;
        let filter = null;
        if (layer.filter) {
          filter = ctx.createBiquadFilter();
          filter.type = layer.filter.type;
          filter.frequency.value = layer.filter.freq;
          filter.Q.value = layer.filter.Q;
          head.connect(filter);
          head = filter;
          nodes.push(filter);
        }
        // Layer balance gain → bed gain.
        const layerGain = ctx.createGain();
        layerGain.gain.value = layer.gain;
        head.connect(layerGain);
        layerGain.connect(bedGain);
        nodes.push(layerGain);

        // Optional slow LFO: lfoOsc → lfoGain(depth) → target AudioParam.
        if (layer.lfo) {
          const lfo = ctx.createOscillator();
          lfo.type = layer.lfo.wave || 'sine';
          lfo.frequency.value = layer.lfo.rate;
          const lfoGain = ctx.createGain();
          lfoGain.gain.value = layer.lfo.depth;
          lfo.connect(lfoGain);
          const target = (layer.lfo.target === 'freq' && filter)
            ? filter.frequency
            : layerGain.gain;
          lfoGain.connect(target);
          lfo.start();
          sources.push(lfo);
          nodes.push(lfo, lfoGain);
        }

        src.start();
        sources.push(src);
        nodes.push(src);
      }
      return { gain: bedGain, sources, nodes };
    } catch (_e) {
      return null; // stub/ancient-browser failure — beds stay silent, game unaffected
    }
  }

  /**
   * @private Shared looped white-noise buffer (BED_NOISE_BUFFER_S at the
   * context's sample rate), built once per context — every noise layer reuses
   * it (startAmbientLoop shares one buffer the same way).
   */
  _noiseBuffer() {
    if (this._noise && this._noiseCtx === this._ctx) return this._noise;
    const len = Math.max(1, Math.floor(this._ctx.sampleRate * BED_NOISE_BUFFER_S));
    const buf = this._ctx.createBuffer(1, len, this._ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noise = buf;
    this._noiseCtx = this._ctx;
    return buf;
  }
}
