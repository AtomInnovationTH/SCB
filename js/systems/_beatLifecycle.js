/**
 * _beatLifecycle.js — shared coach-beat sequencing primitives (CP-4 Phase B).
 *
 * Extracted as the reusable lifecycle layer the GUIDANCE_ARBITER / MISSION_ARC
 * specs call for: a small, framework-agnostic `BeatSequencer` (no EventBus, no
 * DOM, no THREE — fully Node-testable) plus two pure helpers. `MissionCoach`
 * wires real EventBus listeners to it; `OnboardingDirector` can adopt it later.
 *
 * A "beat" is plain data:
 *   { id, type:'narrative'|'interactive'|'reactive', text, source?, channel?,
 *     skillId?, triggerEvent?, triggerFilter?(data)=>bool, holdMs?, escalateMs?,
 *     protect?, title?, body? }
 *
 * @module systems/_beatLifecycle
 */

/** Build the COMMS_MESSAGE payload for a beat (always `_postOnboarding` so it
 *  passes the CP-4 suppression ramp at tiers ≥ 1). Pure. */
export function buildBeatComms(beat) {
  return {
    source: beat.source || 'HOUSTON',
    text: beat.text || '',
    channel: beat.channel || 'MISSION',
    priority: beat.priority || 'info',
    _postOnboarding: true,
  };
}

/** Apply a beat's optional payload filter. Pure; defaults to match. */
export function beatMatches(beat, data) {
  if (!beat || typeof beat.triggerFilter !== 'function') return true;
  try {
    return !!beat.triggerFilter(data);
  } catch (_) {
    return false;
  }
}

/**
 * Sequences a list of beats. Narrative beats auto-advance after a hold; an
 * interactive/reactive beat waits for `satisfy()` and escalates once after a
 * timeout. Drive it with `update(dt)`; observe via hooks.
 *
 * hooks: { onPost(beat), onSatisfy(beat), onEscalate(beat), onComplete() }
 * timing: { narrativeHoldMs, escalateMs }
 */
export class BeatSequencer {
  constructor({ beats = [], hooks = {}, timing = {} } = {}) {
    this.beats = beats;
    this.hooks = hooks;
    this.timing = timing;
    this.index = -1;
    this.running = false;
    this._timer = 0;             // seconds since the current beat was posted
    this._awaitingSatisfy = false;
    this._escalated = false;
  }

  /** Begin the sequence (no-op for an empty beat list). */
  start() {
    if (!Array.isArray(this.beats) || this.beats.length === 0) {
      this.running = false;
      return;
    }
    this.index = -1;
    this.running = true;
    this._advance();
  }

  /** @returns {object|null} the beat currently on screen. */
  current() {
    return this.running ? this.beats[this.index] : null;
  }

  /** Mark the active interactive/reactive beat satisfied and advance. */
  satisfy() {
    if (!this.running || !this._awaitingSatisfy) return false;
    const beat = this.beats[this.index];
    if (typeof this.hooks.onSatisfy === 'function') this.hooks.onSatisfy(beat);
    this._advance();
    return true;
  }

  /** Per-frame tick (seconds). Auto-advances narrative beats; escalates interactive ones once. */
  update(dt) {
    if (!this.running) return;
    this._timer += dt;
    const beat = this.beats[this.index];
    if (!this._awaitingSatisfy) {
      const holdS = (beat.holdMs ?? this.timing.narrativeHoldMs ?? 4000) / 1000;
      if (this._timer >= holdS) this._advance();
    } else {
      const escS = (beat.escalateMs ?? this.timing.escalateMs ?? 20000) / 1000;
      if (!this._escalated && this._timer >= escS) {
        this._escalated = true;
        if (typeof this.hooks.onEscalate === 'function') this.hooks.onEscalate(beat);
      }
    }
  }

  /** Stop and clear all sequencing state. */
  reset() {
    this.running = false;
    this.index = -1;
    this._timer = 0;
    this._awaitingSatisfy = false;
    this._escalated = false;
  }

  /** @private Move to the next beat (or finish). */
  _advance() {
    this.index++;
    this._timer = 0;
    this._escalated = false;
    if (this.index >= this.beats.length) {
      this.running = false;
      this._awaitingSatisfy = false;
      if (typeof this.hooks.onComplete === 'function') this.hooks.onComplete();
      return;
    }
    const beat = this.beats[this.index];
    this._awaitingSatisfy = (beat.type === 'interactive' || beat.type === 'reactive');
    if (typeof this.hooks.onPost === 'function') this.hooks.onPost(beat);
  }
}
