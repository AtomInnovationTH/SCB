/**
 * test-MissionEvents.js — ST-4.D Dynamic Mid-Mission Events
 *
 * Tests the MissionEventSystem: hydrazine hazard, synergy opportunity,
 * cascade threat, weather effect, cluster conjunction, cooldown, and
 * profile-gating.
 *
 * Node-safe: no DOM, no THREE.js dependencies.
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { eventBus }  from '../core/EventBus.js';
import { Events }    from '../core/Events.js';
import { MissionEventSystem } from '../systems/MissionEventSystem.js';

// ============================================================================
// HELPERS
// ============================================================================

/** Create a fresh MissionEventSystem with a clean EventBus. */
function makeMES() {
  eventBus.clear();
  return new MissionEventSystem();
}

/** Track emitted events — returns a growing array of { event, data }. */
function trackEvents(...names) {
  const log = [];
  names.forEach(n => eventBus.on(n, d => log.push({ event: n, data: d })));
  return log;
}

/** Build a mission profile override (defaults = all-enabled M10 style). */
function fullProfile(overrides = {}) {
  return {
    minMission: 10,
    label: 'Test',
    clusters: null,
    hydrazine: true,
    conjunction: true,
    kessler: true,
    synergy: true,
    untracked: null,
    weather: true,
    activeSats: true,
    ...overrides,
  };
}

// ============================================================================
// SUITE 1: Hydrazine scan → DEBRIS_HAZARD_REVEALED
// ============================================================================

describe('MissionEvents — Hydrazine hazard on scan', () => {
  it('emits DEBRIS_HAZARD_REVEALED + COMMS_MESSAGE + SCORING_AWARD on hydrazine scan', () => {
    const mes = makeMES();
    // Set profile to allow hydrazine
    eventBus.emit(Events.MISSION_START, { missionNumber: 10, profile: fullProfile() });

    const log = trackEvents(
      Events.DEBRIS_HAZARD_REVEALED,
      Events.COMMS_MESSAGE,
      Events.SCORING_AWARD,
    );

    eventBus.emit(Events.SCAN_DISCOVERY, {
      type: 'rocketBody',
      mass: 2000,
      debrisId: 'test-rb-1',
      salvage: { hydrazine: 50, metals: [] },
    });

    const hazard = log.filter(e => e.event === Events.DEBRIS_HAZARD_REVEALED);
    assert.equal(hazard.length, 1, 'should emit DEBRIS_HAZARD_REVEALED once');
    assert.equal(hazard[0].data.hazardType, 'hydrazine');
    assert.equal(hazard[0].data.type, 'rocketBody');

    const comms = log.filter(e => e.event === Events.COMMS_MESSAGE);
    assert.ok(comms.length >= 1, 'should emit at least one COMMS_MESSAGE');
    assert.ok(comms[0].data.text.includes('Hydrazine'), 'comms should mention Hydrazine');
    assert.equal(comms[0].data.priority, 'warning');

    const scores = log.filter(e => e.event === Events.SCORING_AWARD);
    assert.equal(scores.length, 1, 'should emit SCORING_AWARD once');
    assert.equal(scores[0].data.points, Constants.MISSION_EVENTS.HYDRAZINE_BONUS_POINTS);

    mes.dispose();
  });

  it('also fires on rocketBody type even without salvage.hydrazine', () => {
    const mes = makeMES();
    eventBus.emit(Events.MISSION_START, { missionNumber: 10, profile: fullProfile() });

    const log = trackEvents(Events.DEBRIS_HAZARD_REVEALED);
    eventBus.emit(Events.SCAN_DISCOVERY, {
      type: 'rocketBody',
      mass: 3000,
    });

    assert.equal(log.length, 1, 'rocketBody type alone should trigger hazard');
    mes.dispose();
  });
});

// ============================================================================
// SUITE 2: Synergy scan → SYNERGY_OPPORTUNITY
// ============================================================================

describe('MissionEvents — Synergy opportunity on scan', () => {
  it('emits SYNERGY_OPPORTUNITY with correct missing metals', () => {
    const mes = makeMES();
    eventBus.emit(Events.MISSION_START, { missionNumber: 10, profile: fullProfile() });

    const log = trackEvents(Events.SYNERGY_OPPORTUNITY, Events.COMMS_MESSAGE);

    // GALLIUM is part of "Complete Solar Array" [GALLIUM, COPPER]
    eventBus.emit(Events.SCAN_DISCOVERY, {
      type: 'fragment',
      mass: 5,
      salvage: { hydrazine: 0, metals: ['GALLIUM'] },
    });

    const syn = log.filter(e => e.event === Events.SYNERGY_OPPORTUNITY);
    assert.equal(syn.length, 1, 'should emit SYNERGY_OPPORTUNITY once');
    assert.equal(syn[0].data.synergyName, 'Complete Solar Array');
    assert.ok(syn[0].data.matchedMetals.includes('GALLIUM'));
    assert.ok(syn[0].data.missingMetals.includes('COPPER'));
    assert.equal(syn[0].data.bonusPoints, 300);
    assert.equal(syn[0].data.expiresMs, Constants.MISSION_EVENTS.SYNERGY_TIMER_MS);

    const comms = log.filter(e => e.event === Events.COMMS_MESSAGE);
    // At least one comms for synergy (hydrazine might also fire since hydrazine=0 and type='fragment' → no hazard)
    const synComms = comms.filter(c => c.data.text.includes('Synergy'));
    assert.equal(synComms.length, 1, 'should have one synergy comms message');
    assert.equal(synComms[0].data.priority, 'info');

    mes.dispose();
  });

  it('suppressed when profile.synergy=false', () => {
    const mes = makeMES();
    eventBus.emit(Events.MISSION_START, { missionNumber: 1, profile: fullProfile({ synergy: false }) });

    const log = trackEvents(Events.SYNERGY_OPPORTUNITY);
    eventBus.emit(Events.SCAN_DISCOVERY, {
      type: 'fragment',
      mass: 5,
      salvage: { hydrazine: 0, metals: ['GALLIUM'] },
    });

    assert.equal(log.length, 0, 'SYNERGY_OPPORTUNITY should NOT fire when synergy=false');
    mes.dispose();
  });
});

// ============================================================================
// SUITE 3: Kessler cascade → CASCADE_THREAT
// ============================================================================

describe('MissionEvents — Kessler cascade threat', () => {
  it('emits CASCADE_THREAT + comms when profile.kessler=true', () => {
    const mes = makeMES();
    eventBus.emit(Events.MISSION_START, { missionNumber: 10, profile: fullProfile({ kessler: true }) });

    const log = trackEvents(Events.CASCADE_THREAT, Events.COMMS_MESSAGE);
    eventBus.emit(Events.KESSLER_CASCADE, { fragmentCount: 12, threshold: 5 });

    const threats = log.filter(e => e.event === Events.CASCADE_THREAT);
    assert.equal(threats.length, 1, 'should emit CASCADE_THREAT once');
    assert.equal(threats[0].data.fragmentCount, 12);

    const comms = log.filter(e => e.event === Events.COMMS_MESSAGE);
    assert.ok(comms.length >= 1, 'should emit comms');
    assert.equal(comms[0].data.priority, 'critical');
    assert.ok(comms[0].data.text.includes('12'));

    mes.dispose();
  });

  it('suppressed when profile.kessler=false', () => {
    const mes = makeMES();
    eventBus.emit(Events.MISSION_START, { missionNumber: 1, profile: fullProfile({ kessler: false }) });

    const log = trackEvents(Events.CASCADE_THREAT);
    eventBus.emit(Events.KESSLER_CASCADE, { fragmentCount: 5, threshold: 5 });

    assert.equal(log.length, 0, 'CASCADE_THREAT should NOT fire when kessler=false');
    mes.dispose();
  });
});

// ============================================================================
// SUITE 4: Severe weather → WEATHER_MISSION_EFFECT
// ============================================================================

describe('MissionEvents — Severe weather effect', () => {
  it('emits WEATHER_MISSION_EFFECT when sensorRange < 1 and weather=true', () => {
    const mes = makeMES();
    eventBus.emit(Events.MISSION_START, { missionNumber: 10, profile: fullProfile({ weather: true }) });

    const log = trackEvents(Events.WEATHER_MISSION_EFFECT, Events.COMMS_MESSAGE);
    eventBus.emit(Events.WEATHER_EFFECT_START, {
      type: 'solarFlare',
      effects: { sensorRange: 0.5 },
      duration: 600,
      name: 'Solar Flare',
      icon: '☀',
      color: '#ff0',
    });

    const wx = log.filter(e => e.event === Events.WEATHER_MISSION_EFFECT);
    assert.equal(wx.length, 1, 'should emit WEATHER_MISSION_EFFECT');
    assert.equal(wx[0].data.sensorReduction, 0.5);
    assert.equal(wx[0].data.duration, 600);

    const comms = log.filter(e => e.event === Events.COMMS_MESSAGE);
    assert.ok(comms.length >= 1, 'should emit comms');
    assert.equal(comms[0].data.priority, 'warning');
    assert.ok(comms[0].data.text.includes('50%'));

    mes.dispose();
  });

  it('suppressed when profile.weather=false', () => {
    const mes = makeMES();
    eventBus.emit(Events.MISSION_START, { missionNumber: 1, profile: fullProfile({ weather: false }) });

    const log = trackEvents(Events.WEATHER_MISSION_EFFECT);
    eventBus.emit(Events.WEATHER_EFFECT_START, {
      type: 'solarFlare',
      effects: { sensorRange: 0.5 },
      duration: 600,
    });

    assert.equal(log.length, 0, 'WEATHER_MISSION_EFFECT should NOT fire when weather=false');
    mes.dispose();
  });

  it('does NOT fire when sensorRange >= 1 (not severe)', () => {
    const mes = makeMES();
    eventBus.emit(Events.MISSION_START, { missionNumber: 10, profile: fullProfile({ weather: true }) });

    const log = trackEvents(Events.WEATHER_MISSION_EFFECT);
    eventBus.emit(Events.WEATHER_EFFECT_START, {
      type: 'aurora',
      effects: { sensorRange: 1.0 },
      duration: 300,
    });

    assert.equal(log.length, 0, 'should not fire for non-severe weather');
    mes.dispose();
  });
});

// ============================================================================
// SUITE 5: Cooldown prevents rapid re-fire
// ============================================================================

describe('MissionEvents — Cooldown system', () => {
  it('prevents same event type from firing twice within cooldown window', () => {
    const mes = makeMES();
    eventBus.emit(Events.MISSION_START, { missionNumber: 10, profile: fullProfile() });

    const log = trackEvents(Events.DEBRIS_HAZARD_REVEALED);

    // First scan — should fire
    eventBus.emit(Events.SCAN_DISCOVERY, {
      type: 'rocketBody',
      mass: 2000,
      salvage: { hydrazine: 50, metals: [] },
    });
    assert.equal(log.length, 1, 'first scan should trigger hazard');

    // Second scan immediately — should NOT fire (cooldown)
    eventBus.emit(Events.SCAN_DISCOVERY, {
      type: 'rocketBody',
      mass: 3000,
      salvage: { hydrazine: 80, metals: [] },
    });
    assert.equal(log.length, 1, 'second scan within cooldown should NOT trigger');

    mes.dispose();
  });

  it('allows different event types to fire independently', () => {
    const mes = makeMES();
    eventBus.emit(Events.MISSION_START, { missionNumber: 10, profile: fullProfile() });

    const log = trackEvents(Events.DEBRIS_HAZARD_REVEALED, Events.CASCADE_THREAT);

    // Hydrazine scan
    eventBus.emit(Events.SCAN_DISCOVERY, {
      type: 'rocketBody',
      mass: 2000,
      salvage: { hydrazine: 50, metals: [] },
    });

    // Kessler cascade (different event type — should fire despite hydrazine cooldown)
    eventBus.emit(Events.KESSLER_CASCADE, { fragmentCount: 8 });

    const hazards = log.filter(e => e.event === Events.DEBRIS_HAZARD_REVEALED);
    const cascades = log.filter(e => e.event === Events.CASCADE_THREAT);
    assert.equal(hazards.length, 1, 'hazard should fire');
    assert.equal(cascades.length, 1, 'cascade should fire independently');

    mes.dispose();
  });
});

// ============================================================================
// SUITE 6: Multiple conjunctions → CLUSTER_CONJUNCTION
// ============================================================================

describe('MissionEvents — Cluster conjunction', () => {
  it('emits CLUSTER_CONJUNCTION after 2+ CONJUNCTION_WARNING events', () => {
    const mes = makeMES();
    eventBus.emit(Events.MISSION_START, { missionNumber: 10, profile: fullProfile({ conjunction: true }) });

    const log = trackEvents(Events.CLUSTER_CONJUNCTION, Events.COMMS_MESSAGE);

    // First warning — not enough
    eventBus.emit(Events.CONJUNCTION_WARNING, { tier: 1, debrisId: 'a', tca: 60, distance: 500 });
    assert.equal(
      log.filter(e => e.event === Events.CLUSTER_CONJUNCTION).length,
      0,
      'single warning should not trigger cluster',
    );

    // Second warning — should trigger cluster
    eventBus.emit(Events.CONJUNCTION_WARNING, { tier: 2, debrisId: 'b', tca: 30, distance: 200 });
    const clusters = log.filter(e => e.event === Events.CLUSTER_CONJUNCTION);
    assert.equal(clusters.length, 1, 'two warnings should trigger CLUSTER_CONJUNCTION');
    assert.ok(clusters[0].data.alertCount >= 2, 'alertCount should be >= 2');

    const comms = log.filter(e => e.event === Events.COMMS_MESSAGE);
    const critComms = comms.filter(c => c.data.priority === 'critical');
    assert.ok(critComms.length >= 1, 'should emit critical comms for cluster conjunction');

    mes.dispose();
  });

  it('suppressed when profile.conjunction=false', () => {
    const mes = makeMES();
    eventBus.emit(Events.MISSION_START, { missionNumber: 1, profile: fullProfile({ conjunction: false }) });

    const log = trackEvents(Events.CLUSTER_CONJUNCTION);
    eventBus.emit(Events.CONJUNCTION_WARNING, { tier: 1, debrisId: 'a', tca: 60, distance: 500 });
    eventBus.emit(Events.CONJUNCTION_WARNING, { tier: 2, debrisId: 'b', tca: 30, distance: 200 });

    assert.equal(log.length, 0, 'CLUSTER_CONJUNCTION should NOT fire when conjunction=false');
    mes.dispose();
  });
});

// ============================================================================
// SUITE 7: Event constants validation
// ============================================================================

describe('MissionEvents — Event constants exist', () => {
  it('all 5 new event constants are defined in Events', () => {
    assert.ok(Events.DEBRIS_HAZARD_REVEALED, 'DEBRIS_HAZARD_REVEALED');
    assert.ok(Events.SYNERGY_OPPORTUNITY, 'SYNERGY_OPPORTUNITY');
    assert.ok(Events.CASCADE_THREAT, 'CASCADE_THREAT');
    assert.ok(Events.WEATHER_MISSION_EFFECT, 'WEATHER_MISSION_EFFECT');
    assert.ok(Events.CLUSTER_CONJUNCTION, 'CLUSTER_CONJUNCTION');
  });

  it('event string values use mission: prefix', () => {
    assert.ok(Events.DEBRIS_HAZARD_REVEALED.startsWith('mission:'));
    assert.ok(Events.SYNERGY_OPPORTUNITY.startsWith('mission:'));
    assert.ok(Events.CASCADE_THREAT.startsWith('mission:'));
    assert.ok(Events.WEATHER_MISSION_EFFECT.startsWith('mission:'));
    assert.ok(Events.CLUSTER_CONJUNCTION.startsWith('mission:'));
  });

  it('MISSION_EVENTS constants exist in Constants', () => {
    assert.ok(Constants.MISSION_EVENTS, 'MISSION_EVENTS namespace');
    assert.equal(Constants.MISSION_EVENTS.COOLDOWN_MS, 30000);
    assert.equal(Constants.MISSION_EVENTS.SYNERGY_TIMER_MS, 300000);
    assert.equal(Constants.MISSION_EVENTS.CONJUNCTION_ACCUMULATION_WINDOW_MS, 60000);
    assert.equal(Constants.MISSION_EVENTS.MIN_CONJUNCTION_ALERTS, 2);
    assert.equal(Constants.MISSION_EVENTS.HYDRAZINE_BONUS_POINTS, 500);
  });
});

// ============================================================================
// SUITE 8: GAME_RESET clears state
// ============================================================================

describe('MissionEvents — Reset behaviour', () => {
  it('GAME_RESET clears internal state', () => {
    const mes = makeMES();
    eventBus.emit(Events.MISSION_START, { missionNumber: 10, profile: fullProfile() });

    // Fire a hydrazine event to set cooldown
    eventBus.emit(Events.SCAN_DISCOVERY, {
      type: 'rocketBody',
      mass: 2000,
      salvage: { hydrazine: 50, metals: [] },
    });

    // Reset
    eventBus.emit(Events.GAME_RESET);

    // After reset, cooldowns should be cleared — set profile again and re-fire
    eventBus.emit(Events.MISSION_START, { missionNumber: 10, profile: fullProfile() });
    const log = trackEvents(Events.DEBRIS_HAZARD_REVEALED);
    eventBus.emit(Events.SCAN_DISCOVERY, {
      type: 'rocketBody',
      mass: 2000,
      salvage: { hydrazine: 50, metals: [] },
    });

    assert.equal(log.length, 1, 'after GAME_RESET, event should fire again (cooldown cleared)');
    mes.dispose();
  });
});
