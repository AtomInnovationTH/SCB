/**
 * test-MissionMilestones.js — UX-11 #12 mission-completion clarity.
 *
 * Covers:
 *   1. Pure crossedThresholds (single + multi crossing, exact-hit, no-recross).
 *   2. formatMilestoneLine / formatObjectiveRecap content.
 *   3. Tracker: debris + contract milestone comms fire once per threshold per
 *      track; seed-on-first-observation prevents restore replay; SHOP_DEPLOY
 *      recap; GAME_RESET clears state.
 */

import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import {
  MissionMilestones,
  crossedThresholds,
  formatMilestoneLine,
  formatObjectiveRecap,
  MILESTONE_THRESHOLDS,
} from '../systems/MissionMilestones.js';

function makeTracker() {
  eventBus.clear();
  const mm = new MissionMilestones();
  mm.init();
  return mm;
}

function trackComms() {
  const log = [];
  eventBus.on(Events.COMMS_MESSAGE, (d) => log.push(d));
  return log;
}

describe('MissionMilestones — pure threshold crossing', () => {

  it('detects a single crossing (prev < t ≤ new)', () => {
    assert.deepEqual(crossedThresholds(0.2, 0.3), [0.25]);
  });

  it('exact hit counts as crossed; landing exactly on prev does not re-cross', () => {
    assert.deepEqual(crossedThresholds(0.2, 0.25), [0.25]);
    assert.deepEqual(crossedThresholds(0.25, 0.3), []);
  });

  it('a big jump reports every crossed threshold in ascending order', () => {
    assert.deepEqual(crossedThresholds(0.1, 0.95), [0.25, 0.5, 0.75, 0.9]);
  });

  it('no movement / regression crosses nothing', () => {
    assert.deepEqual(crossedThresholds(0.5, 0.5), []);
    assert.deepEqual(crossedThresholds(0.6, 0.4), []);
  });

  it('thresholds exclude 100% (win flow owns it)', () => {
    assert.ok(!MILESTONE_THRESHOLDS.includes(1.0));
  });
});

describe('MissionMilestones — line formatting', () => {

  it('debris 50% reads as halfway', () => {
    const line = formatMilestoneLine('debris', 0.5, 25, 50);
    assert.ok(line.includes('Halfway'), line);
    assert.ok(line.includes('25 of 50'), line);
  });

  it('contract 90% urges the finish', () => {
    const line = formatMilestoneLine('contract', 0.9, 9000, 10000);
    assert.ok(line.includes('9,000'), line);
    assert.ok(line.includes('One good cluster'), line);
  });

  it('objective recap shows both tracks + next step', () => {
    const line = formatObjectiveRecap(12, 50, 3400, 10000);
    assert.ok(line.includes('12/50'), line);
    assert.ok(line.includes('3,400/10,000'), line);
    assert.ok(line.includes('press A'), line);
  });
});

describe('MissionMilestones — tracker event flow', () => {

  it('debris milestones fire once per threshold via DEBRIS_CLEARED', () => {
    makeTracker();
    const comms = trackComms();
    const target = Constants.WIN_DEBRIS_COUNT || 50;
    // Walk 1..target-1 one clear at a time (like real play)
    for (let c = 1; c < target; c++) {
      eventBus.emit(Events.DEBRIS_CLEARED, { count: c });
    }
    const milestoneLines = comms.filter(m => m._postOnboarding);
    assert.equal(milestoneLines.length, 4, '25/50/75/90% — exactly four lines');
    assert.ok(milestoneLines[1].text.includes('Halfway'), milestoneLines[1].text);
  });

  it('contract milestones fire via CONTRACT_UPDATE and never repeat', () => {
    makeTracker();
    const comms = trackComms();
    eventBus.emit(Events.CONTRACT_UPDATE, { contractMassKg: 0, targetMassKg: 10000 });    // seed
    eventBus.emit(Events.CONTRACT_UPDATE, { contractMassKg: 2600, targetMassKg: 10000 }); // crosses 25%
    assert.equal(comms.length, 1, '25% milestone');
    eventBus.emit(Events.CONTRACT_UPDATE, { contractMassKg: 2700, targetMassKg: 10000 });
    assert.equal(comms.length, 1, 'no repeat');
    eventBus.emit(Events.CONTRACT_UPDATE, { contractMassKg: 9100, targetMassKg: 10000 }); // 50+75+90
    assert.equal(comms.length, 4, 'jump fires every crossed threshold');
  });

  it('restore replay seeds silently (PERSISTENCE_LOADED un-seeds first)', () => {
    makeTracker();
    const comms = trackComms();
    // Simulated restore: GameFlowManager re-emits the absolute contract state
    eventBus.emit(Events.PERSISTENCE_LOADED);
    eventBus.emit(Events.CONTRACT_UPDATE, { contractMassKg: 7500, targetMassKg: 10000 });
    assert.equal(comms.length, 0, 'restore burst must not replay history');
    // Next genuine crossing still fires
    eventBus.emit(Events.CONTRACT_UPDATE, { contractMassKg: 9000, targetMassKg: 10000 });
    assert.equal(comms.length, 1, '90% fires after seed');
  });

  it('a large FIRST contract contribution in a fresh game still announces (no swallow)', () => {
    makeTracker();
    const comms = trackComms();
    // Fresh game: no restore — first delivery is a 2.6 t rocket body
    eventBus.emit(Events.CONTRACT_UPDATE, { contractMassKg: 2600, targetMassKg: 10000 });
    assert.equal(comms.length, 1, '25% must announce, not be silently seeded');
  });

  it('first post-restore debris clear that crosses a threshold announces', () => {
    makeTracker();
    eventBus.emit(Events.PERSISTENCE_LOADED);   // save had 12 cleared (no event on restore)
    const comms = trackComms();
    eventBus.emit(Events.DEBRIS_CLEARED, { count: 13 });  // 12→13 crosses 25% of 50
    assert.equal(comms.length, 1, 'genuine crossing must announce after restore');
    assert.ok(comms[0].text.includes('25%') || comms[0].text.includes('13'), comms[0].text);
  });

  it('SHOP_DEPLOY posts the dual-objective recap', () => {
    makeTracker();
    eventBus.emit(Events.DEBRIS_CLEARED, { count: 12 });
    eventBus.emit(Events.CONTRACT_UPDATE, { contractMassKg: 3400, targetMassKg: 10000 });
    const comms = trackComms();
    eventBus.emit(Events.SHOP_DEPLOY, { mission: 3 });
    assert.equal(comms.length, 1);
    assert.ok(comms[0].text.includes('12/'), comms[0].text);
    assert.ok(comms[0].text.includes('3,400'), comms[0].text);
    assert.equal(comms[0]._postOnboarding, true);
  });

  it('GAME_RESET clears fired milestones and counters', () => {
    const mm = makeTracker();
    eventBus.emit(Events.DEBRIS_CLEARED, { count: 1 });
    for (let c = 2; c <= 30; c++) eventBus.emit(Events.DEBRIS_CLEARED, { count: c });
    eventBus.emit(Events.GAME_RESET);
    assert.equal(mm._fired.size, 0);
    const comms = trackComms();
    eventBus.emit(Events.DEBRIS_CLEARED, { count: 1 });  // re-seed
    for (let c = 2; c <= 13; c++) eventBus.emit(Events.DEBRIS_CLEARED, { count: c });
    assert.equal(comms.length, 1, '25% fires again after reset');
  });

  it('SHOP_DEPLOY recap prefers live getters over event caches (restore safety)', () => {
    eventBus.clear();
    const mm = new MissionMilestones();
    mm.init({ getCleared: () => 27, getContractKg: () => 6100 });
    const comms = trackComms();
    eventBus.emit(Events.SHOP_DEPLOY, { mission: 6 });
    assert.equal(comms.length, 1);
    assert.ok(comms[0].text.includes('27/'), comms[0].text);
    assert.ok(comms[0].text.includes('6,100'), comms[0].text);
  });
});
