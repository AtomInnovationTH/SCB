/**
 * test-OnboardingDirector.js — Delegation 2 (2026-05-31)
 *
 * Verifies the OnboardingDirector beat lifecycle:
 *   • MISSION_START kicks off the pipeline
 *   • First triggerable beat posts COMMS + HINT_POSTED
 *   • Trigger event fires HINT_SATISFIED + credit award + advance
 *   • Tiered-skip path: pre-practiced skill marks beat as skipped
 *
 * @module test/test-OnboardingDirector
 */

import { describe, it, assert } from './TestRunner.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { OnboardingDirector, ONBOARDING_BEATS } from '../systems/OnboardingDirector.js';

// ─── mock EventBus ────────────────────────────────────────────────────────
function createMockEventBus() {
  const listeners = new Map();
  const emitted = [];
  return {
    on(evt, h) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(h);
      return () => {
        const arr = listeners.get(evt);
        const i = arr.indexOf(h);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    emit(evt, payload) {
      emitted.push({ evt, payload });
      const arr = listeners.get(evt);
      if (arr) for (const fn of arr.slice()) fn(payload);
    },
    off() {},
    _emitted: emitted,
    _findEmits(evt) { return emitted.filter(e => e.evt === evt); },
    _reset() { emitted.length = 0; },
  };
}

// ─── mock SkillsSystem ────────────────────────────────────────────────────
function createMockSkillsSystem(states = {}) {
  return {
    getState(id) { return states[id] || 'undiscovered'; },
    _states: states,
  };
}

// ─── localStorage shim for Node ───────────────────────────────────────────
function installLocalStorageShim() {
  if (typeof globalThis.localStorage !== 'undefined') return false;
  const store = new Map();
  globalThis.localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
  };
  return true;
}

// ─── BEAT TABLE INTEGRITY ─────────────────────────────────────────────────

describe('OnboardingDirector — beat table integrity', () => {
  it('has exactly 13 beats', () => {
    assert.equal(ONBOARDING_BEATS.length, 13);
  });

  it('all beats have unique ids', () => {
    const ids = ONBOARDING_BEATS.map(b => b.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('every triggerEvent maps to a known Events constant', () => {
    for (const b of ONBOARDING_BEATS) {
      if (b.triggerEvent) {
        assert.ok(Events[b.triggerEvent], `missing Events.${b.triggerEvent} for beat ${b.id}`);
      }
    }
  });

  it('credit-bearing beats all default to 10 credits', () => {
    const expected = Constants.ONBOARDING?.DEFAULT_CREDIT || 10;
    for (const b of ONBOARDING_BEATS) {
      if (b.credit != null) assert.equal(b.credit, expected, `beat ${b.id}`);
    }
  });
});

// ─── PERSISTENCE ROUND-TRIP ───────────────────────────────────────────────

describe('OnboardingDirector — persistence', () => {
  it('reads completedBeats / skippedBeats / mastered from localStorage', () => {
    const installed = installLocalStorageShim();
    try {
      localStorage.setItem(
        Constants.ONBOARDING.STORAGE_KEY,
        JSON.stringify({
          completedBeats: ['boot', 'handshake'],
          skippedBeats: ['arrows'],
          mastered: false,
        }),
      );
      const eb = createMockEventBus();
      const d = new OnboardingDirector({ eventBus: eb });
      const s = d.getState();
      assert.ok(s.completed.includes('boot'));
      assert.ok(s.completed.includes('handshake'));
      assert.ok(s.skipped.includes('arrows'));
      assert.equal(s.mastered, false);
      d.dispose();
    } finally {
      if (installed) delete globalThis.localStorage;
    }
  });
});

// ─── LIFECYCLE: MISSION_START → first triggerable beat → satisfaction ──

describe('OnboardingDirector — lifecycle (MISSION_START → trigger → advance)', () => {
  it('start() emits COMMS_MESSAGE + HINT_POSTED for first triggerable beat', () => {
    const installed = installLocalStorageShim();
    try {
      // Pre-mark `boot` and `handshake` as completed so we skip past the
      // auto-advance narrative beats and land directly on `arrows`.
      localStorage.clear();
      localStorage.setItem(
        Constants.ONBOARDING.STORAGE_KEY,
        JSON.stringify({ completedBeats: ['boot', 'handshake'], skippedBeats: [], mastered: false }),
      );
      const eb = createMockEventBus();
      const skills = createMockSkillsSystem();
      let scored = 0;
      const scoring = {
        awardPoints({ points }) { scored += points; return points; },
      };
      const d = new OnboardingDirector({ eventBus: eb, skillsSystem: skills, scoringSystem: scoring });
      d.start();

      // Active beat should be `arrows`.
      assert.equal(d.getActiveBeatId(), 'arrows');

      const commsEmits = eb._findEmits(Events.COMMS_MESSAGE);
      assert.ok(commsEmits.length >= 1, 'COMMS_MESSAGE must fire on beat post');
      const firstComms = commsEmits[0];
      assert.equal(firstComms.payload.text, 'Use arrow keys to test attitude control.');

      const hintEmits = eb._findEmits(Events.HINT_POSTED);
      assert.ok(hintEmits.length >= 1, 'HINT_POSTED must fire on beat post');
      const hintPayload = hintEmits[0].payload;
      assert.equal(hintPayload.id, 'arrows');
      assert.ok(Array.isArray(hintPayload.keys) && hintPayload.keys.length === 4);

      // Audio cue fired for credit beat.
      const audioEmits = eb._findEmits(Events.AUDIO_CUE);
      assert.ok(audioEmits.length >= 1);
      assert.equal(audioEmits[0].payload.id, 'hint_post');

      // Trigger fire → HINT_SATISFIED + credit + advance.
      eb._reset();
      eb.emit(Events.TUTORIAL_ARROW_INPUT);

      const satisfiedEmits = eb._findEmits(Events.HINT_SATISFIED);
      assert.ok(satisfiedEmits.length === 1);
      assert.equal(satisfiedEmits[0].payload.id, 'arrows');
      assert.equal(scored, 10, 'awardPoints should be called with 10 credits');

      // Houston ack message fires after satisfy.
      const ackEmits = eb._findEmits(Events.COMMS_MESSAGE);
      const ack = ackEmits.find(e => e.payload.text === 'RCS nominal. Solar panels tracking sun.');
      assert.ok(ack, 'commsAck should be emitted');

      // Beat marked completed.
      assert.ok(d.getState().completed.includes('arrows'));

      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });

  it('tiered-skip path skips beats whose skillId is already practiced', () => {
    const installed = installLocalStorageShim();
    try {
      localStorage.clear();
      // Pre-complete boot+handshake so we land on arrows.
      // SkillsSystem reports nav_arrows as already 'practiced' → beat skipped.
      localStorage.setItem(
        Constants.ONBOARDING.STORAGE_KEY,
        JSON.stringify({ completedBeats: ['boot', 'handshake'], skippedBeats: [], mastered: false }),
      );
      const eb = createMockEventBus();
      const skills = createMockSkillsSystem({ nav_arrows: 'practiced' });
      const d = new OnboardingDirector({ eventBus: eb, skillsSystem: skills });
      d.start();

      // arrows beat should be auto-skipped; active beat should be `struts`
      // (the next un-skipped, un-completed beat — its skillId is null so it
      // can't be tiered-skipped).
      assert.equal(d.getActiveBeatId(), 'struts');
      assert.ok(d.getState().skipped.includes('arrows'));

      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });
});

// ─── SMART-DEFAULT: pressActiveHint ──────────────────────────────────────

describe('OnboardingDirector — pressActiveHint (Space smart-default)', () => {
  it('dispatches the correct InputManager helper for the active beat', () => {
    const installed = installLocalStorageShim();
    try {
      localStorage.clear();
      localStorage.setItem(
        Constants.ONBOARDING.STORAGE_KEY,
        JSON.stringify({
          completedBeats: ['boot', 'handshake', 'arrows', 'struts', 'zoom', 'view'],
          skippedBeats: [],
          mastered: false,
        }),
      );
      const eb = createMockEventBus();
      const d = new OnboardingDirector({ eventBus: eb });
      d.start();
      // Active beat should be `scan` (primary key 'KeyS').
      assert.equal(d.getActiveBeatId(), 'scan');

      let fired = 0;
      const im = { fireScan() { fired++; } };
      const dispatched = d.pressActiveHint(im);
      assert.equal(dispatched, true);
      assert.equal(fired, 1);

      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });

  it('returns false if no beat is active', () => {
    const installed = installLocalStorageShim();
    try {
      localStorage.clear();
      const eb = createMockEventBus();
      const d = new OnboardingDirector({ eventBus: eb });
      // Don't start — no active beat.
      const out = d.pressActiveHint({});
      assert.equal(out, false);
      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });
});
