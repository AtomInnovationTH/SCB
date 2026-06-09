/**
 * test-MissionCoach.js — CP-4 per-chapter coaching engine (Node-safe).
 */
import { describe, it, assert } from './TestRunner.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { MissionCoach } from '../systems/MissionCoach.js';

function createMockEventBus() {
  const listeners = new Map();
  return {
    on(evt, handler) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(handler);
      return () => {
        const arr = listeners.get(evt);
        if (arr) { const i = arr.indexOf(handler); if (i >= 0) arr.splice(i, 1); }
      };
    },
    emit(evt, data) {
      const arr = listeners.get(evt);
      if (arr) [...arr].forEach(fn => fn(data)); // copy: handlers may unsubscribe mid-emit
    },
  };
}

/** Build an inited coach + an event recorder. */
function makeCoach({ mission = 2, pmPeek = null } = {}) {
  const eb = createMockEventBus();
  const rec = {};
  const cap = (evt, key) => eb.on(evt, (d) => (rec[key] = rec[key] || []).push(d));
  cap(Events.COMMS_MESSAGE, 'comms');
  cap(Events.MISSION_BEAT_STARTED, 'started');
  cap(Events.MISSION_BEAT_SATISFIED, 'satisfied');
  cap(Events.TEACHING_MOMENT_FORCE, 'force');

  const scoring = { getMissionNumber: () => mission };
  const pm = { peek: () => pmPeek };
  const coach = new MissionCoach({ eventBus: eb, scoringSystem: scoring, persistenceManager: pm });
  coach.init();
  return { eb, coach, rec };
}

const HOLD = Constants.MISSION_COACH.NARRATIVE_HOLD_MS / 1000;

describe('MissionCoach — chapter trigger', () => {
  it('SHOP_DEPLOY into mission 2 posts the opening narrative beat', () => {
    const { eb, rec } = makeCoach();
    eb.emit(Events.SHOP_DEPLOY, { mission: 2 });
    assert.equal(rec.comms.length, 1);
    const m = rec.comms[0];
    assert.equal(m._postOnboarding, true, 'beats survive the suppression ramp');
    assert.equal(m.channel, 'MISSION');
    assert.equal(m.source, 'BANGALORE');
  });

  it('uses ScoringSystem.getMissionNumber() when payload omits mission', () => {
    const { eb, rec } = makeCoach({ mission: 2 });
    eb.emit(Events.SHOP_DEPLOY, {});
    assert.equal(rec.comms.length, 1, 'resolved mission 2 from scoring');
  });

  it('a mission with no beat table does nothing', () => {
    const { eb, rec } = makeCoach({ mission: 99 });
    eb.emit(Events.SHOP_DEPLOY, { mission: 99 });
    assert.equal(rec.comms, undefined);
  });
});

describe('MissionCoach — beat sequencing', () => {
  it('narrative → interactive: emits MISSION_BEAT_STARTED for the pilot skill', () => {
    const { eb, coach, rec } = makeCoach();
    eb.emit(Events.SHOP_DEPLOY, { mission: 2 });
    coach.update(HOLD + 0.1); // advance past the narrative dwell
    assert.ok(rec.started && rec.started.length === 1, 'one interactive beat started');
    assert.equal(rec.started[0].skillId, 'arm_pilot');
  });

  it('satisfies the pilot beat only on a matching payload, then advances', () => {
    const { eb, coach, rec } = makeCoach();
    eb.emit(Events.SHOP_DEPLOY, { mission: 2 });
    coach.update(HOLD + 0.1);

    // Wrong mode → no satisfy
    eb.emit(Events.CONTROL_MODE_CHANGE, { mode: 'RCS' });
    assert.equal(rec.satisfied, undefined, 'non-matching payload ignored');

    // Correct mode → satisfied + advance to the manual-capture beat
    eb.emit(Events.CONTROL_MODE_CHANGE, { mode: 'ARM_PILOT' });
    assert.equal(rec.satisfied.length, 1);
    assert.equal(rec.satisfied[0].skillId, 'arm_pilot');
    assert.equal(rec.started.length, 2, 'second interactive beat started');
    assert.equal(rec.started[1].skillId, 'arm_pilot_capture');
  });

  it('completes after the final beat and marks the mission coached', () => {
    const { eb, coach } = makeCoach();
    eb.emit(Events.SHOP_DEPLOY, { mission: 2 });
    coach.update(HOLD + 0.1);
    eb.emit(Events.CONTROL_MODE_CHANGE, { mode: 'ARM_PILOT' });
    eb.emit(Events.ARM_CAPTURED, { manual: true });
    assert.equal(coach.isRunning(), false, 'sequence finished');
    assert.equal(coach.hasCoached(2), true);
  });

  it('does not re-coach a completed mission', () => {
    const { eb, coach, rec } = makeCoach();
    eb.emit(Events.SHOP_DEPLOY, { mission: 2 });
    coach.update(HOLD + 0.1);
    eb.emit(Events.CONTROL_MODE_CHANGE, { mode: 'ARM_PILOT' });
    eb.emit(Events.ARM_CAPTURED, { manual: true });
    const before = rec.comms.length;
    eb.emit(Events.SHOP_DEPLOY, { mission: 2 });
    assert.equal(rec.comms.length, before, 'no new beats for an already-coached mission');
  });

  it('an idle interactive beat re-prompts via TEACHING_MOMENT_FORCE', () => {
    const { eb, coach, rec } = makeCoach();
    eb.emit(Events.SHOP_DEPLOY, { mission: 2 });
    coach.update(HOLD + 0.1); // now on the interactive pilot beat
    coach.update(Constants.MISSION_COACH.ESCALATE_MS / 1000 + 0.1);
    assert.ok(rec.force && rec.force.length === 1, 'escalated once');
    assert.equal(rec.force[0].id, 'coach_ch2_pilot');
  });
});

describe('MissionCoach — lifecycle', () => {
  it('GAME_RESET clears coached state', () => {
    const { eb, coach } = makeCoach();
    eb.emit(Events.SHOP_DEPLOY, { mission: 2 });
    coach.update(HOLD + 0.1);
    eb.emit(Events.CONTROL_MODE_CHANGE, { mode: 'ARM_PILOT' });
    eb.emit(Events.ARM_CAPTURED, { manual: true });
    assert.equal(coach.hasCoached(2), true);
    eb.emit(Events.GAME_RESET);
    assert.equal(coach.hasCoached(2), false, 'reset clears completion');
  });

  it('restores completedByMission from persistence', () => {
    const save = { missionCoach: { version: 1, completedByMission: { 2: true } } };
    const { eb, coach, rec } = makeCoach({ pmPeek: save });
    eb.emit(Events.PERSISTENCE_LOADED);
    assert.equal(coach.hasCoached(2), true);
    eb.emit(Events.SHOP_DEPLOY, { mission: 2 });
    assert.equal(rec.comms, undefined, 'restored-complete mission is not re-coached');
  });

  it('PERSISTENCE_GATHER writes the coach blob', () => {
    const { eb, coach } = makeCoach();
    eb.emit(Events.SHOP_DEPLOY, { mission: 2 });
    coach.update(HOLD + 0.1);
    eb.emit(Events.CONTROL_MODE_CHANGE, { mode: 'ARM_PILOT' });
    eb.emit(Events.ARM_CAPTURED, { manual: true });
    const save = {};
    eb.emit(Events.PERSISTENCE_GATHER, save);
    assert.ok(save.missionCoach, 'wrote missionCoach blob');
    assert.equal(save.missionCoach.completedByMission[2], true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Phase C — chapters 3,4,6,7 are pure DATA on the shipped engine.
//  Each interactive beat must (a) reference a real Events key, (b) reference a
//  real skill in the catalog, and (c) be driveable to completion by emitting
//  its trigger event in order.
// ════════════════════════════════════════════════════════════════════════════

const BEATS = Constants.MISSION_COACH.BEATS_BY_MISSION;

/** Walk a whole chapter to completion: hold through narrative beats, fire the
 *  trigger event for each interactive/reactive beat. Returns the recorder. */
function runChapter(mission) {
  const { eb, coach, rec } = makeCoach({ mission });
  eb.emit(Events.SHOP_DEPLOY, { mission });
  for (const beat of BEATS[mission]) {
    if (beat.type === 'narrative') {
      coach.update((beat.holdMs ?? Constants.MISSION_COACH.NARRATIVE_HOLD_MS) / 1000 + 0.1);
    } else {
      // Build a payload that passes the beat's filter (none of ch3/4/6/7 use one).
      eb.emit(Events[beat.triggerEvent], {});
    }
  }
  return { coach, rec, mission };
}

describe('MissionCoach — Phase C data integrity (ch3,4,6,7)', () => {
  it('every Phase C interactive beat references a real Events key + catalog skill', () => {
    const skillIds = new Set(Constants.SKILLS.CATALOG.map(s => s.id));
    for (const mission of [3, 4, 6, 7]) {
      const table = BEATS[mission];
      assert.ok(Array.isArray(table) && table.length > 0, `chapter ${mission} has beats`);
      for (const beat of table) {
        if (beat.type === 'narrative') continue;
        assert.ok(Events[beat.triggerEvent],
          `ch${mission} beat ${beat.id}: triggerEvent ${beat.triggerEvent} exists`);
        assert.ok(skillIds.has(beat.skillId),
          `ch${mission} beat ${beat.id}: skill ${beat.skillId} is in the catalog`);
      }
    }
  });

  it('the strategic_map skill exists and listens on DEBRIS_MAP_CLUSTER_SELECTED', () => {
    const sm = Constants.SKILLS.CATALOG.find(s => s.id === 'strategic_map');
    assert.ok(sm, 'strategic_map skill present');
    assert.equal(sm.triggerEvent, 'DEBRIS_MAP_CLUSTER_SELECTED',
      'ch4 teaches the Debris Map cluster/transfer agency (CP-3), not the view-only StrategicMap');
    assert.equal(sm.triggerFilter, undefined, 'fires on any cluster selection');
  });

  it('each Phase C chapter runs to completion and is marked coached', () => {
    for (const mission of [3, 4, 6, 7]) {
      const { coach } = runChapter(mission);
      assert.equal(coach.isRunning(), false, `chapter ${mission} finished`);
      assert.equal(coach.hasCoached(mission), true, `chapter ${mission} coached`);
    }
  });

  it('ch3: opens with HOUSTON narrative, then teaches Wide Scan then the Codex', () => {
    const { eb, coach, rec } = makeCoach({ mission: 3 });
    eb.emit(Events.SHOP_DEPLOY, { mission: 3 });
    assert.equal(rec.comms[0].source, 'HOUSTON');
    coach.update(HOLD + 0.1);
    assert.equal(rec.started[0].skillId, 'scan_wide');
    eb.emit(Events.SCAN_WIDE, {});
    assert.equal(rec.satisfied[0].skillId, 'scan_wide');
    assert.equal(rec.started[1].skillId, 'manage_codex');
    eb.emit(Events.CODEX_OPENED, {});
    assert.equal(coach.hasCoached(3), true);
  });

  it('ch4: a single interactive beat teaches the transfer map', () => {
    const { eb, coach, rec } = makeCoach({ mission: 4 });
    eb.emit(Events.SHOP_DEPLOY, { mission: 4 });
    coach.update(HOLD + 0.1);
    assert.equal(rec.started[0].skillId, 'strategic_map');
    eb.emit(Events.DEBRIS_MAP_CLUSTER_SELECTED, { clusterId: 'c1' });
    assert.equal(rec.satisfied[0].skillId, 'strategic_map');
    assert.equal(coach.hasCoached(4), true);
  });
});

