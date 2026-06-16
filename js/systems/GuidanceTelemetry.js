/**
 * GuidanceTelemetry.js — dev-only guidance instrumentation (Guidance cleanup,
 * Phase 4). DISABLED by default; activate per-session with `?guidanceLog=1`.
 *
 * Subscribes to EXISTING events only (no gameplay coupling) and records a ring
 * buffer of guidance activity so onboarding/coaching pacing can be tuned with
 * data instead of guesswork. Mirrors the existing `?debug=1` / `window.__boot*`
 * dev-flag precedent — nothing here runs in the default build.
 *
 * Metrics captured:
 *   • prompt → action latency — time from a proactive "Press X" guidance comms
 *     to the matching player action event. Tunes autoAdvance / escalation / the
 *     in-range debounce.
 *   • contradiction events — a proactive invite followed by a matching DENIAL
 *     within CONTRA_WINDOW_MS (the exact bug class this cleanup fixes). Should
 *     read 0 after Phase 0.
 *   • overlap events — ≥2 guidance comms within OVERLAP_WINDOW_MS (the "hints
 *     come too fast" feeling).
 *
 * Output: `window.__dumpGuidanceLog()` → console.table + a session summary.
 *
 * @module systems/GuidanceTelemetry
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

const RING_MAX = 500;
const OVERLAP_WINDOW_MS = 2500;   // ≥2 guidance comms inside this = an overlap
const CONTRA_WINDOW_MS = 6000;    // invite→denial inside this = a contradiction
const LATENCY_MAX_MS = 30000;     // ignore prompt→action gaps longer than this

// Map a proactive prompt's text → the action event that "answers" it, so we can
// measure latency and detect contradictions. Keyed by a lowercase substring.
const PROMPT_ANSWERS = [
  { match: 'press n', action: Events.LASSO_FIRED, denial: Events.LASSO_DENIED, label: 'lasso' },
  { match: 'lasso range', action: Events.LASSO_FIRED, denial: Events.LASSO_DENIED, label: 'lasso' },
  { match: 'press a', action: Events.AUTOPILOT_ENGAGE, denial: null, label: 'autopilot' },
  { match: 'press s', action: Events.SCAN_INITIATED, denial: null, label: 'scan' },
  { match: 'press t', action: Events.TARGET_SELECTED, denial: null, label: 'target' },
  { match: 'press d', action: Events.ARM_DEPLOYED, denial: null, label: 'daughter' },
  { match: '1-4', action: Events.CONTROL_MODE_CHANGE, denial: null, label: 'pilot' },
];

export class GuidanceTelemetry {
  constructor() {
    this._enabled = false;
    this._unsubs = [];
    /** @type {Array<object>} ring buffer of recorded entries */
    this._log = [];
    /** @type {Array<{text:string, at:number}>} recent guidance comms (overlap) */
    this._recentComms = [];
    /** @type {Array<{label:string, action:string, denial:string|null, at:number}>} */
    this._pendingPrompts = [];
    this._counts = { prompts: 0, actions: 0, overlaps: 0, contradictions: 0 };
    this._latencies = [];
  }

  /** Activate (idempotent). Call only when the dev flag is set. */
  enable() {
    if (this._enabled) return;
    this._enabled = true;
    const on = (evt, h) => { if (evt) this._unsubs.push(eventBus.on(evt, h)); };

    // Guidance comms (proactive prompts + denials both flow through here).
    on(Events.COMMS_MESSAGE, (d) => this._onComms(d));

    // Action events that "answer" prompts.
    for (const a of PROMPT_ANSWERS) {
      if (a.action) on(a.action, () => this._onAction(a.action));
      if (a.denial) on(a.denial, (d) => this._onDenial(a.denial, d));
    }

    // Beat lifecycle (dwell tracking).
    on('onboarding:beatEnter', (d) => this._record('beatEnter', { beatId: d && d.beatId }));
    if (Events.ONBOARDING_COMPLETE) on(Events.ONBOARDING_COMPLETE, () => this._record('onboardingComplete', {}));
    if (Events.GAME_RESET) on(Events.GAME_RESET, () => this._reset());

    this._installGlobals();
    console.info('[GuidanceTelemetry] enabled via ?guidanceLog=1. Call window.__dumpGuidanceLog() to snapshot.');
  }

  dispose() {
    for (const u of this._unsubs) { if (typeof u === 'function') u(); }
    this._unsubs.length = 0;
    this._enabled = false;
  }

  _reset() {
    this._log.length = 0;
    this._recentComms.length = 0;
    this._pendingPrompts.length = 0;
    this._counts = { prompts: 0, actions: 0, overlaps: 0, contradictions: 0 };
    this._latencies.length = 0;
  }

  _onComms(d) {
    if (!d || !d.text) return;
    const text = String(d.text).toLowerCase();
    const now = Date.now();
    const isProactive = !!d._proactive;
    const isDenial = !!d._lassoFeedback && /not in|recharging|busy|depleted|too massive|no targets|no suitable/.test(text);

    // Overlap detection — count guidance comms clustered in a short window.
    this._recentComms = this._recentComms.filter(e => now - e.at <= OVERLAP_WINDOW_MS);
    this._recentComms.push({ text, at: now });
    if (this._recentComms.length >= 2) {
      this._counts.overlaps++;
      this._record('overlap', { count: this._recentComms.length, text });
    }

    // Register a proactive prompt as "pending" so a later action/denial resolves it.
    if (isProactive || /press [a-z]|1-4/.test(text)) {
      const ans = PROMPT_ANSWERS.find(a => text.includes(a.match));
      if (ans) {
        this._counts.prompts++;
        this._pendingPrompts.push({ label: ans.label, action: ans.action, denial: ans.denial, at: now });
        this._record('prompt', { label: ans.label, text });
      }
    }
    if (isDenial) this._record('denial', { text });
  }

  _onAction(actionEvt) {
    const now = Date.now();
    // Resolve the oldest matching pending prompt → latency.
    const idx = this._pendingPrompts.findIndex(p => p.action === actionEvt && now - p.at <= LATENCY_MAX_MS);
    if (idx >= 0) {
      const p = this._pendingPrompts.splice(idx, 1)[0];
      const latency = now - p.at;
      this._latencies.push(latency);
      this._counts.actions++;
      this._record('action', { label: p.label, latencyMs: latency });
    }
  }

  _onDenial(denialEvt, data) {
    const now = Date.now();
    // A pending invite answered by a DENIAL of the same verb = contradiction.
    const idx = this._pendingPrompts.findIndex(p => p.denial === denialEvt && now - p.at <= CONTRA_WINDOW_MS);
    if (idx >= 0) {
      const p = this._pendingPrompts.splice(idx, 1)[0];
      this._counts.contradictions++;
      this._record('contradiction', { label: p.label, reason: data && data.reason, gapMs: now - p.at });
    }
  }

  _record(kind, payload) {
    this._log.push({ t: Date.now(), kind, ...payload });
    if (this._log.length > RING_MAX) this._log.shift();
  }

  _summary() {
    const lat = this._latencies.slice().sort((a, b) => a - b);
    const median = lat.length ? lat[Math.floor(lat.length / 2)] : null;
    return {
      prompts: this._counts.prompts,
      actionsMatched: this._counts.actions,
      medianLatencyMs: median,
      overlaps: this._counts.overlaps,
      contradictions: this._counts.contradictions,
    };
  }

  _installGlobals() {
    if (typeof window === 'undefined') return;
    window.__dumpGuidanceLog = () => {
      const summary = this._summary();
      console.info('[GuidanceTelemetry] session summary:', summary);
      try { console.table(this._log.slice(-100)); } catch (_e) { console.info(this._log.slice(-100)); }
      return { summary, log: this._log.slice() };
    };
  }
}

export const guidanceTelemetry = new GuidanceTelemetry();
