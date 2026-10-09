/**
 * SoundLog.js — dev tool: a ring buffer of the last 10 sounds played.
 *
 * DECISIONS §15 row 10 (owner 2026-10-08): "The sound list is a dev tool: the
 * last 10 sounds, newest at the bottom, off by default." Troubleshooting aid
 * only — answers "what was that sound?".
 *
 * Every method named in `soundVocabulary` is wrapped ON THE INSTANCE (so the
 * internal `this.playX()` calls are caught too). The wrapper forwards `this`,
 * arguments and the return value, and never changes a sound. A call whose name
 * matches one of the newest DEDUPE_SPAN entries within DEDUPE_S seconds bumps
 * that entry's `count` instead of pushing, so a per-frame sound (thruster hum)
 * cannot flood the slots. Calls are recorded even when WebAudio is unavailable.
 *
 * @module systems/audio/SoundLog
 */

import { soundVocabulary } from './soundVocabulary.js';

export const SOUND_LOG_SIZE = 10;
export const DEDUPE_S = 0.5;
export const DEDUPE_SPAN = 3;

const nowS = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

/** `playTerminalBlip` → `terminal blip`. */
export function plainName(method) {
  return String(method).replace(/^(play|start)(?=[A-Z])/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

export class SoundLog {
  constructor(size = SOUND_LOG_SIZE, now = nowS) {
    this.size = size;
    this.now = now;
    /** @type {{name:string, meaning:string, t:number, count:number}[]} oldest first */
    this.entries = [];
  }

  /** Record one call of `name` (a vocabulary method name). */
  record(name) {
    const t = this.now();
    const e = this.entries;
    for (let i = e.length - 1; i >= 0 && i >= e.length - DEDUPE_SPAN; i--) {
      if (e[i].name === name && t - e[i].t <= DEDUPE_S) { e[i].count++; e[i].t = t; return; }
    }
    if (e.length >= this.size) e.shift();
    e.push({ name, meaning: soundVocabulary[name]?.meaning ?? '', t, count: 1 });
  }
}

/** The shared log read by SoundLogPane. */
export const soundLog = new SoundLog();

/**
 * Wrap every vocabulary-named method of `target` so calls land in `log`.
 * Idempotent: a wrapped method is never wrapped again.
 * @returns {number} how many methods were newly wrapped
 */
export function installSoundLog(target, log = soundLog, vocab = soundVocabulary) {
  let n = 0;
  for (const name of Object.keys(vocab)) {
    const orig = target[name];
    if (typeof orig !== 'function' || orig.__soundLogged) continue;
    // `arguments`, not rest args: no array allocated per call (per-frame hum).
    const wrapped = function () {
      try { log.record(name); } catch (_e) { /* the log must never break a sound */ }
      return orig.apply(this, arguments);
    };
    wrapped.__soundLogged = true;
    target[name] = wrapped;
    n++;
  }
  return n;
}
