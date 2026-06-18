/**
 * test-OnboardingDirector.js — reward-first capture spine (2026-06-17)
 *
 * Verifies the OnboardingDirector beat lifecycle for the capture-first spine
 * (.kilo/plans/new-player-onboarding-flow.md Phase 3):
 *   boot → handshake → tease_lock → first_catch → second_catch → range_wall →
 *   close_and_catch → free_clear → final
 *
 * Covers: beat-table integrity, persistence, lifecycle (post → trigger →
 * satisfy → advance), tiered-skip, jump-ahead pre-satisfy, the range_wall
 * out-of-range gate, counter beats, and MINIMAL guidance suppression.
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

// ─── mock GuidanceDirector ────────────────────────────────────────────────
function createMockGuidance(level = 'GUIDED') {
  return {
    _level: level,
    _coaching: false,
    getLevel() { return this._level; },
    isMinimal() { return this._level === 'MINIMAL'; },
    setCoachingActive(on) { this._coaching = !!on; },
    noteStall() {},
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

const IDS = ONBOARDING_BEATS.map(b => b.id);

// ─── BEAT TABLE INTEGRITY ─────────────────────────────────────────────────

describe('OnboardingDirector — beat table integrity (capture spine)', () => {
  it('is the reward-first spine in order', () => {
    assert.deepEqual(IDS, [
      'boot', 'handshake', 'tease_lock', 'first_catch', 'second_catch',
      'range_wall', 'close_and_catch', 'free_clear', 'final',
    ]);
  });

  it('all beats have unique ids', () => {
    assert.equal(new Set(IDS).size, IDS.length);
  });

  it('every triggerEvent maps to a known Events constant', () => {
    for (const b of ONBOARDING_BEATS) {
      if (b.triggerEvent) {
        assert.ok(Events[b.triggerEvent], `missing Events.${b.triggerEvent} for beat ${b.id}`);
      }
    }
  });

  it('the tease teaches the net (N) and the range wall teaches autopilot (A)', () => {
    const tease = ONBOARDING_BEATS.find(b => b.id === 'tease_lock');
    assert.equal(tease.triggerEvent, 'LASSO_FIRED');
    assert.equal(tease.glyph, 'N');
    const wall = ONBOARDING_BEATS.find(b => b.id === 'range_wall');
    assert.equal(wall.triggerEvent, 'AUTOPILOT_ENGAGE');
    assert.equal(wall.glyph, 'A');
    assert.ok(wall.requiresOutOfRange, 'range_wall holds until a target is out of range');
  });

  it('final marks mastered and is last', () => {
    const fin = ONBOARDING_BEATS.find(b => b.id === 'final');
    assert.equal(fin.onEnter, 'mastered=true');
    assert.equal(IDS[IDS.length - 1], 'final');
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
          skippedBeats: ['tease_lock'],
          mastered: false,
        }),
      );
      const eb = createMockEventBus();
      const d = new OnboardingDirector({ eventBus: eb });
      const s = d.getState();
      assert.ok(s.completed.includes('boot'));
      assert.ok(s.completed.includes('handshake'));
      assert.ok(s.skipped.includes('tease_lock'));
      assert.equal(s.mastered, false);
      d.dispose();
    } finally {
      if (installed) delete globalThis.localStorage;
    }
  });
});

// ─── LIFECYCLE: post → trigger → satisfy → advance ─────────────────────────

describe('OnboardingDirector — lifecycle (post → trigger → advance)', () => {
  it('start() emits COMMS_MESSAGE + HINT_POSTED for the tease_lock beat', () => {
    const installed = installLocalStorageShim();
    try {
      // Pre-mark boot + handshake completed so we land on tease_lock.
      localStorage.clear();
      localStorage.setItem(
        Constants.ONBOARDING.STORAGE_KEY,
        JSON.stringify({ completedBeats: ['boot', 'handshake'], skippedBeats: [], mastered: false }),
      );
      const eb = createMockEventBus();
      const skills = createMockSkillsSystem();
      let scored = 0;
      const scoring = { awardPoints({ points }) { scored += points; return points; } };
      const d = new OnboardingDirector({ eventBus: eb, skillsSystem: skills, scoringSystem: scoring });
      d.start();

      assert.equal(d.getActiveBeatId(), 'tease_lock');

      const commsEmits = eb._findEmits(Events.COMMS_MESSAGE);
      assert.ok(commsEmits.length >= 1, 'COMMS_MESSAGE must fire on beat post');
      assert.ok(/fire the Mother net with N/i.test(commsEmits[0].payload.text));

      const hintEmits = eb._findEmits(Events.HINT_POSTED);
      assert.ok(hintEmits.length >= 1, 'HINT_POSTED must fire on beat post');
      assert.equal(hintEmits[0].payload.id, 'tease_lock');
      assert.deepEqual(hintEmits[0].payload.keys, ['KeyN']);

      const audioEmits = eb._findEmits(Events.AUDIO_CUE);
      assert.ok(audioEmits.length >= 1);
      assert.equal(audioEmits[0].payload.id, 'hint_post');

      // Trigger fire (N → LASSO_FIRED) → HINT_SATISFIED + credit + ack.
      eb._reset();
      eb.emit(Events.LASSO_FIRED);

      const satisfiedEmits = eb._findEmits(Events.HINT_SATISFIED);
      assert.ok(satisfiedEmits.some(e => e.payload.id === 'tease_lock'));
      assert.equal(scored, 10, 'awardPoints called with 10 credits');

      const ack = eb._findEmits(Events.COMMS_MESSAGE).find(e => /Clean catch/i.test(e.payload.text));
      assert.ok(ack, 'commsAck emitted');
      assert.ok(d.getState().completed.includes('tease_lock'));

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
      // Land on tease_lock; collect_lasso already practiced → skip to first_catch.
      localStorage.setItem(
        Constants.ONBOARDING.STORAGE_KEY,
        JSON.stringify({ completedBeats: ['boot', 'handshake'], skippedBeats: [], mastered: false }),
      );
      const eb = createMockEventBus();
      const skills = createMockSkillsSystem({ collect_lasso: 'practiced' });
      const d = new OnboardingDirector({ eventBus: eb, skillsSystem: skills });
      d.start();

      // tease_lock skipped (collect_lasso practiced); first_catch is a counter
      // beat (never tiered-skipped) so it becomes active.
      assert.equal(d.getActiveBeatId(), 'first_catch');
      assert.ok(d.getState().skipped.includes('tease_lock'));

      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });
});

// ─── RANGE WALL: holds until a target is out of range ──────────────────────

describe('OnboardingDirector — range_wall out-of-range gate', () => {
  it('holds range_wall until context reports targetOutOfRange', () => {
    const installed = installLocalStorageShim();
    try {
      localStorage.clear();
      localStorage.setItem(
        Constants.ONBOARDING.STORAGE_KEY,
        JSON.stringify({
          completedBeats: ['boot', 'handshake', 'tease_lock', 'first_catch', 'second_catch'],
          skippedBeats: [],
          mastered: false,
        }),
      );
      const eb = createMockEventBus();
      let outOfRange = false;
      const d = new OnboardingDirector({
        eventBus: eb,
        skillsSystem: createMockSkillsSystem(),
        contextProvider: () => ({ trackedContacts: 1, nearestDebrisM: 200, hasTarget: true, targetOutOfRange: outOfRange }),
      });
      d.start();

      // range_wall is the active id but HELD — its real comms (Press A) must not
      // be posted; a wait nudge is shown instead.
      assert.equal(d.getActiveBeatId(), 'range_wall');
      const realComms = eb._findEmits(Events.COMMS_MESSAGE)
        .filter(e => e.payload.text && /autopilot in/i.test(e.payload.text));
      assert.equal(realComms.length, 0, 'real range_wall comms not posted while held');
      const waitHints = eb._findEmits(Events.HINT_POSTED).filter(e => e.payload.id === 'range_wall_wait');
      assert.ok(waitHints.length >= 1, 'a waiting nudge hint is shown');

      // Reticle reports OUT OF RANGE → re-check converts held → real beat.
      outOfRange = true;
      eb._reset();
      eb.emit(Events.TARGET_OUT_OF_RANGE, { id: 1, distanceM: 200 });
      const posted = eb._findEmits(Events.COMMS_MESSAGE)
        .filter(e => e.payload.text && /autopilot in/i.test(e.payload.text));
      assert.ok(posted.length >= 1, 'range_wall posts once a target is out of range');
      const cleared = eb._findEmits(Events.HINT_SATISFIED).filter(e => e.payload.id === 'range_wall_wait');
      assert.ok(cleared.length >= 1, 'wait nudge cleared when gate opens');

      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });
});

// ─── JUMP-AHEAD: future action while an earlier beat is active ─────────────

describe('OnboardingDirector — jump-ahead (out-of-order actions)', () => {
  it('pressing a FUTURE action (autopilot) while tease_lock is active credits it', () => {
    const installed = installLocalStorageShim();
    try {
      localStorage.clear();
      localStorage.setItem(
        Constants.ONBOARDING.STORAGE_KEY,
        JSON.stringify({ completedBeats: ['boot', 'handshake'], skippedBeats: [], mastered: false }),
      );
      const eb = createMockEventBus();
      let scored = 0;
      const d = new OnboardingDirector({
        eventBus: eb,
        skillsSystem: createMockSkillsSystem(),
        scoringSystem: { awardPoints({ points }) { scored += points; } },
      });
      d.start();
      assert.equal(d.getActiveBeatId(), 'tease_lock');

      // Player jumps ahead: engages autopilot (range_wall's trigger) early.
      eb._reset();
      eb.emit(Events.AUTOPILOT_ENGAGE);

      assert.equal(d.getActiveBeatId(), 'tease_lock', 'active beat unchanged');
      assert.ok(d.getState().completed.includes('range_wall'), 'range_wall pre-completed');
      assert.equal(scored, 10, 'jump-ahead action credited');
      assert.ok(eb._findEmits(Events.HINT_SATISFIED).some(e => e.payload.id === 'range_wall'));

      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });
});

// ─── COUNTER BEATS ─────────────────────────────────────────────────────────

describe('OnboardingDirector — counter beats', () => {
  it('first_catch satisfies on one DEBRIS_CAPTURED', () => {
    const installed = installLocalStorageShim();
    try {
      localStorage.clear();
      localStorage.setItem(
        Constants.ONBOARDING.STORAGE_KEY,
        JSON.stringify({ completedBeats: ['boot', 'handshake', 'tease_lock'], skippedBeats: [], mastered: false }),
      );
      const eb = createMockEventBus();
      const d = new OnboardingDirector({
        eventBus: eb, skillsSystem: createMockSkillsSystem(), scoringSystem: { awardPoints() {} },
      });
      d.start();
      assert.equal(d.getActiveBeatId(), 'first_catch');
      eb._reset();
      eb.emit(Events.DEBRIS_CAPTURED, { id: 1 });
      assert.ok(d.getState().completed.includes('first_catch'));
      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });

  it('counterTarget>1: re-posts a running tally then satisfies on the Nth trigger', () => {
    const installed = installLocalStorageShim();
    try {
      localStorage.clear();
      const eb = createMockEventBus();
      const d = new OnboardingDirector({
        eventBus: eb,
        skillsSystem: createMockSkillsSystem(),
        scoringSystem: { awardPoints() {} },
      });
      const beat = {
        id: 'test_counter', triggerEvent: 'DEBRIS_CAPTURED', counterTarget: 2,
        text: 'do it twice', glyph: '🎯', keys: [], credit: 0,
      };
      d._active = {
        beat, postedAt: Date.now(), unrelatedInputs: 0, escalated: false,
        idleTimer: null, autoAdvanceTimer: null, skipTimer: null, gateTimer: null, held: false,
      };

      eb._reset();
      d._onTrigger(beat); // 1st of 2
      assert.ok(
        eb._findEmits(Events.HINT_POSTED).some(e => e.payload.id === 'test_counter' && /1\/2/.test(e.payload.text || '')),
        'tally chip re-posted as 1/2',
      );
      assert.ok(!d.getState().completed.includes('test_counter'));

      eb._reset();
      d._onTrigger(beat); // 2nd of 2 → satisfy
      assert.ok(d.getState().completed.includes('test_counter'));
      assert.ok(eb._findEmits(Events.HINT_SATISFIED).some(e => e.payload.id === 'test_counter'));
      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });
});

// ─── GUIDANCE: MINIMAL suppresses coaching ─────────────────────────────────

describe('OnboardingDirector — MINIMAL guidance suppression', () => {
  it('at MINIMAL, an interactive beat posts no comms/hint but still advances on the action', () => {
    const installed = installLocalStorageShim();
    try {
      localStorage.clear();
      localStorage.setItem(
        Constants.ONBOARDING.STORAGE_KEY,
        JSON.stringify({ completedBeats: ['boot', 'handshake'], skippedBeats: [], mastered: false }),
      );
      const eb = createMockEventBus();
      const d = new OnboardingDirector({
        eventBus: eb,
        skillsSystem: createMockSkillsSystem(),
        scoringSystem: { awardPoints() {} },
        guidanceDirector: createMockGuidance('MINIMAL'),
      });
      d.start();
      assert.equal(d.getActiveBeatId(), 'tease_lock');

      // No comms / hint chip while MINIMAL.
      assert.equal(eb._findEmits(Events.COMMS_MESSAGE).length, 0, 'no comms at MINIMAL');
      assert.equal(eb._findEmits(Events.HINT_POSTED).filter(e => e.payload.id === 'tease_lock').length, 0,
        'no hint chip at MINIMAL');

      // The action still advances the spine.
      eb.emit(Events.LASSO_FIRED);
      assert.ok(d.getState().completed.includes('tease_lock'), 'beat satisfied by the action');

      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });
});

// ─── SMART-DEFAULT: pressActiveHint ──────────────────────────────────────

describe('OnboardingDirector — pressActiveHint (Space smart-default)', () => {
  it('dispatches fireLasso for the tease_lock beat (primary key N)', () => {
    const installed = installLocalStorageShim();
    try {
      localStorage.clear();
      localStorage.setItem(
        Constants.ONBOARDING.STORAGE_KEY,
        JSON.stringify({ completedBeats: ['boot', 'handshake'], skippedBeats: [], mastered: false }),
      );
      const eb = createMockEventBus();
      const d = new OnboardingDirector({ eventBus: eb });
      d.start();
      assert.equal(d.getActiveBeatId(), 'tease_lock');

      let fired = 0;
      const im = { fireLasso() { fired++; } };
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
      const out = d.pressActiveHint({});
      assert.equal(out, false);
      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });
});
