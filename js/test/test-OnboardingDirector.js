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
  it('has exactly 18 beats', () => {
    assert.equal(ONBOARDING_BEATS.length, 18);
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

  it('credit-bearing beats all default to 10 credits (narrative confirmations may be 0)', () => {
    const expected = Constants.ONBOARDING?.DEFAULT_CREDIT || 10;
    for (const b of ONBOARDING_BEATS) {
      // Skill/action beats award the standard credit; narrative confirmation
      // beats (e.g. `captured`) may explicitly set 0 since the underlying action
      // already scored elsewhere.
      if (b.credit != null && b.credit !== 0) assert.equal(b.credit, expected, `beat ${b.id}`);
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
      assert.equal(firstComms.payload.text, 'Cowboy, test your RCS (Reaction Control System — your steering thrusters) with the arrow keys.');

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
      const ack = ackEmits.find(e => e.payload.text === 'RCS (steering thrusters) good. Solar panels tracking the sun.');
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

// ─── INSPECT BEAT: callouts must actually engage (not just any scroll) ──────

describe('OnboardingDirector — inspect beat (zoom-to-callouts)', () => {
  it('inspect beat requires MOTHER_INSPECTION_ENGAGED, not just a scroll', () => {
    const installed = installLocalStorageShim();
    try {
      localStorage.clear();
      // Land on `inspect` by pre-completing everything up to and including zoom.
      localStorage.setItem(
        Constants.ONBOARDING.STORAGE_KEY,
        JSON.stringify({
          completedBeats: ['boot', 'handshake', 'arrows', 'struts', 'view', 'look', 'zoom'],
          skippedBeats: [],
          mastered: false,
        }),
      );
      const eb = createMockEventBus();
      const d = new OnboardingDirector({ eventBus: eb, skillsSystem: createMockSkillsSystem() });
      d.start();
      assert.equal(d.getActiveBeatId(), 'inspect', 'should land on inspect after zoom');

      // A plain zoom scroll must NOT satisfy the inspect beat — the player has
      // not pushed in far enough for the callouts to engage yet.
      eb._reset();
      eb.emit(Events.CAMERA_ZOOM_INPUT);
      assert.equal(d.getActiveBeatId(), 'inspect', 'scrolling alone keeps inspect active');
      assert.ok(!d.getState().completed.includes('inspect'), 'inspect not completed by scroll');

      // Pushing in until inspection engages on the mother fires the dedicated
      // event → inspect beat satisfied.
      eb._reset();
      eb.emit(Events.MOTHER_INSPECTION_ENGAGED);
      const satisfied = eb._findEmits(Events.HINT_SATISFIED);
      assert.ok(satisfied.some(e => e.payload.id === 'inspect'),
        'MOTHER_INSPECTION_ENGAGED satisfies inspect');
      assert.ok(d.getState().completed.includes('inspect'));

      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });

  it('inspect beat uses the inspect_mother skill (distinct from nav_zoom so it is not auto-skipped after zoom) and the right trigger', () => {
    const inspect = ONBOARDING_BEATS.find(b => b.id === 'inspect');
    assert.ok(inspect, 'inspect beat exists');
    assert.equal(inspect.skillId, 'inspect_mother');
    assert.equal(inspect.triggerEvent, 'MOTHER_INSPECTION_ENGAGED');
  });
});

// ─── JUMP-AHEAD: out-of-order actions credit + skip future beats ─────────

describe('OnboardingDirector — jump-ahead (out-of-order actions)', () => {
  it('pressing a FUTURE beat action while an earlier hint is active credits it and keeps the active hint, then auto-skips it later', () => {
    const installed = installLocalStorageShim();
    try {
      localStorage.clear();
      // Land directly on `scan` by pre-completing the narrative + nav beats.
      localStorage.setItem(
        Constants.ONBOARDING.STORAGE_KEY,
        JSON.stringify({
          completedBeats: ['boot', 'handshake', 'arrows', 'struts', 'view', 'look', 'zoom', 'inspect'],
          skippedBeats: [],
          mastered: false,
        }),
      );
      const eb = createMockEventBus();
      let scored = 0;
      const scoring = { awardPoints({ points }) { scored += points; return points; } };
      const d = new OnboardingDirector({ eventBus: eb, skillsSystem: createMockSkillsSystem(), scoringSystem: scoring });
      d.start();
      assert.equal(d.getActiveBeatId(), 'scan');

      // Player jumps ahead: engages autopilot (the `autopilot` beat's trigger)
      // BEFORE scanning. This should credit + complete the autopilot beat, clear
      // any autopilot hint, but NOT change the active `scan` beat.
      eb._reset();
      eb.emit(Events.AUTOPILOT_ENGAGE);

      assert.equal(d.getActiveBeatId(), 'scan', 'active beat must remain scan');
      assert.ok(d.getState().completed.includes('autopilot'), 'autopilot pre-completed');
      assert.equal(scored, 10, 'jump-ahead action is credited');
      const satisfied = eb._findEmits(Events.HINT_SATISFIED);
      assert.ok(satisfied.some(e => e.payload.id === 'autopilot'),
        'HINT_SATISFIED fired for the jumped-ahead beat id');

      // Now complete scan + target normally; sequence should skip the already
      // completed autopilot beat and land on `decision` (narrative) → it
      // auto-advances; we just assert autopilot was not re-posted as active.
      eb._reset();
      eb.emit(Events.SCAN_INITIATED);   // satisfies scan
      // advance is delayed by advanceDelay; emit target trigger after advance.
      // The mock has no timers, so advance uses real setTimeout — instead we
      // verify autopilot never becomes the active beat again by checking it's
      // still marked completed and not re-emitted as HINT_POSTED.
      const reposted = eb._findEmits(Events.HINT_POSTED).filter(e => e.payload.id === 'autopilot');
      assert.equal(reposted.length, 0, 'autopilot hint not re-posted after being jumped');

      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });

  it('does not pre-satisfy a beat that is at or before the active beat', () => {
    const installed = installLocalStorageShim();
    try {
      localStorage.clear();
      localStorage.setItem(
        Constants.ONBOARDING.STORAGE_KEY,
        JSON.stringify({
          completedBeats: ['boot', 'handshake', 'arrows', 'struts', 'view', 'look', 'zoom', 'inspect'],
          skippedBeats: [],
          mastered: false,
        }),
      );
      const eb = createMockEventBus();
      const d = new OnboardingDirector({ eventBus: eb, skillsSystem: createMockSkillsSystem() });
      d.start();
      assert.equal(d.getActiveBeatId(), 'scan');

      // Fire the scan trigger — that's the ACTIVE beat, so it should satisfy
      // normally (not be treated as a jump-ahead pre-satisfy).
      eb._reset();
      eb.emit(Events.SCAN_INITIATED);
      const satisfied = eb._findEmits(Events.HINT_SATISFIED);
      assert.ok(satisfied.some(e => e.payload.id === 'scan'), 'scan satisfied normally');
      assert.ok(d.getState().completed.includes('scan'));

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
          completedBeats: ['boot', 'handshake', 'arrows', 'struts', 'view', 'look', 'zoom', 'inspect'],
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

// ─── CONDITIONAL GATING: target beat needs a tracked contact (#1) ──────────

describe('OnboardingDirector — conditional gating (#1 target, #3 capture)', () => {
  it('holds the target beat (no real beat post) until a tracked contact exists', () => {
    const installed = installLocalStorageShim();
    try {
      localStorage.clear();
      // Land on `target` by pre-completing through autopilot's predecessor.
      localStorage.setItem(
        Constants.ONBOARDING.STORAGE_KEY,
        JSON.stringify({
          completedBeats: ['boot', 'handshake', 'arrows', 'struts', 'view', 'look', 'zoom', 'inspect', 'scan'],
          skippedBeats: [],
          mastered: false,
        }),
      );
      const eb = createMockEventBus();
      // Context starts with ZERO tracked contacts → target beat must be held.
      let contacts = 0;
      const d = new OnboardingDirector({
        eventBus: eb,
        skillsSystem: createMockSkillsSystem(),
        contextProvider: () => ({ trackedContacts: contacts, nearestDebrisM: null, hasTarget: false }),
      });
      d.start();
      // Active beat id is 'target' but it is HELD — the real comms/hint for it
      // must NOT have been posted; instead a *_wait nudge hint is shown.
      assert.equal(d.getActiveBeatId(), 'target');
      const targetComms = eb._findEmits(Events.COMMS_MESSAGE)
        .filter(e => e.payload.text && e.payload.text.includes('press Tab'));
      assert.equal(targetComms.length, 0, 'real target comms not posted while held');
      const waitHints = eb._findEmits(Events.HINT_POSTED).filter(e => e.payload.id === 'target_wait');
      assert.ok(waitHints.length >= 1, 'a waiting nudge hint is shown');

      // A scan reveals a contact → re-check converts the held beat to the real one.
      contacts = 1;
      eb._reset();
      eb.emit(Events.TARGET_DISCOVERED, { target: {} });
      const realTargetComms = eb._findEmits(Events.COMMS_MESSAGE)
        .filter(e => e.payload.text && e.payload.text.includes('press Tab'));
      assert.ok(realTargetComms.length >= 1, 'real target beat posts once a contact exists');
      const cleared = eb._findEmits(Events.HINT_SATISFIED).filter(e => e.payload.id === 'target_wait');
      assert.ok(cleared.length >= 1, 'wait nudge cleared when gate opens');

      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });
});

// ─── CAPTURE CONFIRMATION BEAT (#4) ────────────────────────────────────────

describe('OnboardingDirector — captured beat (#4 close the loop)', () => {
  it('captured beat exists, fires on ARM_CAPTURED, and is narrative (no keys)', () => {
    const captured = ONBOARDING_BEATS.find(b => b.id === 'captured');
    assert.ok(captured, 'captured beat exists');
    assert.equal(captured.triggerEvent, 'ARM_CAPTURED');
    assert.ok(!captured.keys || captured.keys.length === 0, 'no keys (narrative confirmation)');
    assert.ok(Number.isFinite(captured.autoAdvanceAfter), 'has a fallback auto-advance');
  });
});

describe('OnboardingDirector — solo-flight graduation (Phase F §4.4)', () => {
  const ids = ONBOARDING_BEATS.map(b => b.id);

  function bootDirector(completedBeats) {
    localStorage.clear();
    localStorage.setItem(
      Constants.ONBOARDING.STORAGE_KEY,
      JSON.stringify({ completedBeats, skippedBeats: [], mastered: false }),
    );
    const eb = createMockEventBus();
    const d = new OnboardingDirector({
      eventBus: eb,
      skillsSystem: createMockSkillsSystem(),
      scoringSystem: { awardPoints() {} },
    });
    d.start();
    return { eb, d };
  }

  it('replaces `complete` with solo_intro / solo_practice(counter) / final', () => {
    assert.ok(!ONBOARDING_BEATS.find(b => b.id === 'complete'), 'old single complete beat removed');
    const intro = ONBOARDING_BEATS.find(b => b.id === 'solo_intro');
    const prac = ONBOARDING_BEATS.find(b => b.id === 'solo_practice');
    const fin = ONBOARDING_BEATS.find(b => b.id === 'final');
    assert.ok(intro && prac && fin, 'three solo beats exist');
    assert.equal(prac.triggerEvent, 'DEBRIS_CAPTURED');
    assert.equal(prac.counterTarget, 1);
    assert.ok(prac.optional && prac.skipAfter > 0, 'optional with skipAfter so no-net players are not stuck');
    assert.ok(prac.netEmptySkip, 'opts into the NET_EMPTY_CLICK consolation skip');
    assert.equal(fin.onEnter, 'mastered=true', 'final marks mastered');
    assert.equal(ids[ids.length - 1], 'final', 'final is the last beat');
  });

  it('a capture WHILE solo_practice is active satisfies the counter beat', () => {
    const installed = installLocalStorageShim();
    try {
      const { eb, d } = bootDirector(ids.slice(0, ids.indexOf('solo_practice')));
      assert.equal(d.getActiveBeatId(), 'solo_practice', 'lands on solo_practice');
      assert.equal(d.isMastered(), false, 'not mastered before the solo capture');
      eb._reset();
      eb.emit(Events.DEBRIS_CAPTURED, { id: 1 });
      assert.ok(d.getState().completed.includes('solo_practice'), 'solo_practice satisfied');
      assert.ok(eb._findEmits(Events.HINT_SATISFIED).some(e => e.payload.id === 'solo_practice'));
      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });

  it('an EARLIER capture (during the `captured` beat) does NOT pre-satisfy solo_practice', () => {
    const installed = installLocalStorageShim();
    try {
      const { eb, d } = bootDirector(ids.slice(0, ids.indexOf('captured')));
      assert.equal(d.getActiveBeatId(), 'captured', 'lands on the captured recap');
      eb.emit(Events.DEBRIS_CAPTURED, { id: 7 }); // the guided catch landing
      assert.ok(!d.getState().completed.includes('solo_practice'),
        'counter beat is never credited ahead of time');
      assert.ok(!d.getState().skipped.includes('solo_practice'));
      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });

  it('NET_EMPTY_CLICK during solo_practice graduates with a consolation line', () => {
    const installed = installLocalStorageShim();
    try {
      const { eb, d } = bootDirector(ids.slice(0, ids.indexOf('solo_practice')));
      assert.equal(d.getActiveBeatId(), 'solo_practice');
      eb._reset();
      eb.emit(Events.NET_EMPTY_CLICK, { armId: 1 });
      assert.ok(d.getState().skipped.includes('solo_practice'), 'consolation-skipped');
      const comms = eb._findEmits(Events.COMMS_MESSAGE);
      assert.ok(comms.some(e => /graduating you anyway/i.test((e.payload && e.payload.text) || '')),
        'consolation comms emitted');
      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });

  it('counterTarget>1: re-posts a running tally then satisfies on the Nth trigger', () => {
    // White-box exercise of the general counter mechanic (no shipped beat uses
    // N>1 yet; solo_practice is counterTarget:1). Drive _onTrigger on a synthetic
    // active counter beat and assert the tally re-post then satisfy.
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
      assert.ok(!d.getState().completed.includes('test_counter'), 'not satisfied after 1 trigger');
      assert.equal(d._active && d._active.beat.id, 'test_counter', 'beat still active');

      eb._reset();
      d._onTrigger(beat); // 2nd of 2 → satisfy
      assert.ok(d.getState().completed.includes('test_counter'), 'satisfied after the Nth trigger');
      assert.ok(eb._findEmits(Events.HINT_SATISFIED).some(e => e.payload.id === 'test_counter'));
      d.dispose();
    } finally {
      localStorage.clear();
      if (installed) delete globalThis.localStorage;
    }
  });
});

