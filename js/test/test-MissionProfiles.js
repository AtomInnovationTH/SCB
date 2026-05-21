/**
 * test-MissionProfiles.js — ST-4.C Mission Spawn Difficulty Profiles
 *
 * Tests mission profile constants, profile selection logic,
 * MISSION_START event emission, and profile property validation.
 *
 * Node-safe: no DOM, no THREE.js dependencies.
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { eventBus }  from '../core/EventBus.js';
import { Events }    from '../core/Events.js';
import { ScoringSystem } from '../systems/ScoringSystem.js';

// ============================================================================
// HELPERS
// ============================================================================

/** Create a fresh ScoringSystem with a clean EventBus. */
function makeScoring() {
  eventBus.clear();
  const sys = new ScoringSystem();
  sys.reset();
  return sys;
}

/** Track emitted events — returns a growing array of { event, data }. */
function trackEvents(...names) {
  const log = [];
  names.forEach(n => eventBus.on(n, d => log.push({ event: n, data: d })));
  return log;
}

// ============================================================================
// SUITE 1: Constants.MISSIONS structure validation
// ============================================================================

describe('MissionProfiles — Constants.MISSIONS structure', () => {
  it('Constants.MISSIONS exists', () => {
    assert.ok(Constants.MISSIONS, 'MISSIONS namespace should exist');
  });

  it('DEBRIS_PER_MISSION === 5 (matches existing scoring formula)', () => {
    assert.equal(Constants.MISSIONS.DEBRIS_PER_MISSION, 5);
  });

  it('PROFILES is an array with 5 entries', () => {
    assert.ok(Array.isArray(Constants.MISSIONS.PROFILES), 'PROFILES should be an array');
    assert.equal(Constants.MISSIONS.PROFILES.length, 5);
  });

  it('each profile has required keys', () => {
    const requiredKeys = [
      'minMission', 'label', 'clusters', 'hydrazine',
      'conjunction', 'kessler', 'synergy', 'untracked',
      'weather', 'activeSats',
    ];
    for (const p of Constants.MISSIONS.PROFILES) {
      for (const key of requiredKeys) {
        assert.ok(key in p, `profile "${p.label}" should have key "${key}"`);
      }
    }
  });

  it('profiles are sorted by minMission ascending', () => {
    const profiles = Constants.MISSIONS.PROFILES;
    for (let i = 1; i < profiles.length; i++) {
      assert.ok(
        profiles[i].minMission >= profiles[i - 1].minMission,
        `profile[${i}].minMission (${profiles[i].minMission}) should be >= profile[${i - 1}].minMission (${profiles[i - 1].minMission})`,
      );
    }
  });
});

// ============================================================================
// SUITE 2: M1 profile properties
// ============================================================================

describe('MissionProfiles — M1 (Orientation) profile', () => {
  const p = Constants.MISSIONS.PROFILES[0];

  it('M1 profile has minMission === 1', () => {
    assert.equal(p.minMission, 1);
  });

  it('M1 profile has no hydrazine', () => {
    assert.equal(p.hydrazine, false);
  });

  it('M1 profile has no kessler', () => {
    assert.equal(p.kessler, false);
  });

  it('M1 profile has no conjunction', () => {
    assert.equal(p.conjunction, false);
  });

  it('M1 profile has no weather', () => {
    assert.equal(p.weather, false);
  });

  it('M1 profile has no active satellites', () => {
    assert.equal(p.activeSats, false);
  });

  it('M1 profile has 1 cluster', () => {
    assert.equal(p.clusters, 1);
  });

  it('M1 profile has 0 untracked debris', () => {
    assert.equal(p.untracked, 0);
  });
});

// ============================================================================
// SUITE 3: Profile selection via _getMissionProfile
// ============================================================================

describe('MissionProfiles — _getMissionProfile selection', () => {
  const scoring = makeScoring();

  it('mission 1 → minMission=1 profile (Orientation)', () => {
    const p = scoring._getMissionProfile(1);
    assert.equal(p.minMission, 1);
    assert.equal(p.label, 'Orientation');
  });

  it('mission 2 → minMission=2 profile (First Operations)', () => {
    const p = scoring._getMissionProfile(2);
    assert.equal(p.minMission, 2);
    assert.equal(p.label, 'First Operations');
  });

  it('mission 3 → minMission=2 profile (highest matching)', () => {
    const p = scoring._getMissionProfile(3);
    assert.equal(p.minMission, 2);
  });

  it('mission 4 → minMission=4 profile (Expanding Field)', () => {
    const p = scoring._getMissionProfile(4);
    assert.equal(p.minMission, 4);
    assert.equal(p.label, 'Expanding Field');
  });

  it('mission 7 → minMission=7 profile (Full Operations)', () => {
    const p = scoring._getMissionProfile(7);
    assert.equal(p.minMission, 7);
    assert.equal(p.label, 'Full Operations');
  });

  it('mission 10 → minMission=10 profile (Unrestricted)', () => {
    const p = scoring._getMissionProfile(10);
    assert.equal(p.minMission, 10);
    assert.equal(p.label, 'Unrestricted');
  });

  it('mission 15 → minMission=10 profile (highest matching)', () => {
    const p = scoring._getMissionProfile(15);
    assert.equal(p.minMission, 10);
    assert.equal(p.label, 'Unrestricted');
  });
});

// ============================================================================
// SUITE 4: getMissionNumber derivation
// ============================================================================

describe('MissionProfiles — getMissionNumber', () => {
  it('0 debris → mission 1', () => {
    const s = makeScoring();
    s._gameState = { debrisCleared: 0 };
    assert.equal(s.getMissionNumber(), 1);
  });

  it('4 debris → mission 1', () => {
    const s = makeScoring();
    s._gameState = { debrisCleared: 4 };
    assert.equal(s.getMissionNumber(), 1);
  });

  it('5 debris → mission 2', () => {
    const s = makeScoring();
    s._gameState = { debrisCleared: 5 };
    assert.equal(s.getMissionNumber(), 2);
  });

  it('9 debris → mission 2', () => {
    const s = makeScoring();
    s._gameState = { debrisCleared: 9 };
    assert.equal(s.getMissionNumber(), 2);
  });

  it('10 debris → mission 3', () => {
    const s = makeScoring();
    s._gameState = { debrisCleared: 10 };
    assert.equal(s.getMissionNumber(), 3);
  });

  it('49 debris → mission 10', () => {
    const s = makeScoring();
    s._gameState = { debrisCleared: 49 };
    assert.equal(s.getMissionNumber(), 10);
  });

  it('50 debris → mission 11', () => {
    const s = makeScoring();
    s._gameState = { debrisCleared: 50 };
    assert.equal(s.getMissionNumber(), 11);
  });
});

// ============================================================================
// SUITE 5: MISSION_START event emission
// ============================================================================

describe('MissionProfiles — MISSION_START emission', () => {
  it('MISSION_START event constant exists', () => {
    assert.ok(Events.MISSION_START, 'Events.MISSION_START should exist');
    assert.equal(Events.MISSION_START, 'mission:start');
  });

  it('_checkMissionTransition emits MISSION_START when mission changes', () => {
    const s = makeScoring();
    const log = trackEvents(Events.MISSION_START);

    // Start at mission 1, then simulate reaching mission 2
    s._lastMissionNumber = 1;
    s._gameState = { debrisCleared: 5 }; // mission 2

    s._checkMissionTransition();

    assert.equal(log.length, 1, 'should have emitted exactly 1 MISSION_START');
    assert.equal(log[0].data.missionNumber, 2);
    assert.ok(log[0].data.profile, 'event should include profile');
    assert.equal(log[0].data.profile.minMission, 2, 'profile should be minMission=2');
  });

  it('_checkMissionTransition does NOT emit when mission unchanged', () => {
    const s = makeScoring();
    const log = trackEvents(Events.MISSION_START);

    s._lastMissionNumber = 2;
    s._gameState = { debrisCleared: 5 }; // still mission 2

    s._checkMissionTransition();

    assert.equal(log.length, 0, 'should not emit when mission number unchanged');
  });

  it('_checkMissionTransition updates _lastMissionNumber', () => {
    const s = makeScoring();
    trackEvents(Events.MISSION_START);

    s._lastMissionNumber = 1;
    s._gameState = { debrisCleared: 15 }; // mission 4

    s._checkMissionTransition();
    assert.equal(s._lastMissionNumber, 4);
  });

  it('reset() resets _lastMissionNumber to 1', () => {
    const s = makeScoring();
    s._lastMissionNumber = 5;
    s.reset();
    assert.equal(s._lastMissionNumber, 1);
  });
});

// ============================================================================
// SUITE 6: M4+ profile has synergy + untracked
// ============================================================================

describe('MissionProfiles — M4+ (Expanding Field) properties', () => {
  const p4 = Constants.MISSIONS.PROFILES[2]; // minMission=4

  it('M4 profile has synergy === true', () => {
    assert.equal(p4.synergy, true);
  });

  it('M4 profile has untracked >= 1', () => {
    assert.ok(p4.untracked >= 1, `untracked should be >= 1, got ${p4.untracked}`);
  });

  it('M4 profile has hydrazine enabled', () => {
    assert.equal(p4.hydrazine, true);
  });

  it('M4 profile has 4 clusters', () => {
    assert.equal(p4.clusters, 4);
  });
});

// ============================================================================
// SUITE 7: M10+ (Unrestricted) profile
// ============================================================================

describe('MissionProfiles — M10+ (Unrestricted) properties', () => {
  const p10 = Constants.MISSIONS.PROFILES[4]; // minMission=10

  it('M10 profile has clusters === null (full random)', () => {
    assert.equal(p10.clusters, null);
  });

  it('M10 profile has untracked === null (random distribution)', () => {
    assert.equal(p10.untracked, null);
  });

  it('M10 profile has weather enabled', () => {
    assert.equal(p10.weather, true);
  });

  it('M10 profile has activeSats enabled', () => {
    assert.equal(p10.activeSats, true);
  });

  it('M10 profile has all hazards enabled', () => {
    assert.equal(p10.conjunction, true);
    assert.equal(p10.kessler, true);
    assert.equal(p10.synergy, true);
    assert.equal(p10.hydrazine, true);
  });
});
