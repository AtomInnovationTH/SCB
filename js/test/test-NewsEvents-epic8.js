import { describe, it, assert } from './TestRunner.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { MissionEventSystem } from '../systems/MissionEventSystem.js';
import { ReputationSystem } from '../systems/ReputationSystem.js';

function makeMES() {
  eventBus.clear();
  return new MissionEventSystem();
}

function trackEvents(...names) {
  const log = [];
  for (const n of names) {
    eventBus.on(n, (d) => log.push({ event: n, data: d }));
  }
  return log;
}

// --- NEWS EVENTS JSON STRUCTURE ---

describe('ST-8.4 news-events.json structure', () => {
  // We can't fetch in Node tests, so test the _injectNewsEvents path
  it('MissionEventSystem has news fields after construction', () => {
    const mes = makeMES();
    assert.ok(Array.isArray(mes.newsEvents), 'newsEvents is array');
    assert.ok(mes.triggeredNewsIds instanceof Set, 'triggeredNewsIds is Set');
    assert.equal(mes.totalCaptures, 0, 'totalCaptures starts at 0');
    mes.dispose();
  });

  it('_injectNewsEvents populates newsEvents', () => {
    const mes = makeMES();
    mes._injectNewsEvents([
      { id: 'test1', name: 'Test', unlockCaptures: 3, bounty: 1000, partner: 'USA', headline: 'h', date: '2026-01-01', debris: { name: 'D1' } }
    ]);
    assert.equal(mes.newsEvents.length, 1);
    assert.equal(mes.newsEvents[0].id, 'test1');
    mes.dispose();
  });
});

// --- NEWS EVENT TRIGGERING ---

describe('ST-8.4 news event triggering', () => {
  it('triggers event when capture count reaches unlockCaptures', () => {
    const mes = makeMES();
    const log = trackEvents(Events.NEWS_EVENT_TRIGGERED);

    mes._injectNewsEvents([
      { id: 'evt1', name: 'Evt1', unlockCaptures: 2, bounty: 5000, partner: 'USA', headline: 'Test headline', date: '2026-01-01', debris: { name: 'D1' } }
    ]);

    // Simulate 2 captures via INTERACTION_CAPTURE
    eventBus.emit(Events.INTERACTION_CAPTURE, {});
    eventBus.emit(Events.INTERACTION_CAPTURE, {});

    assert.equal(log.length, 1, 'NEWS_EVENT_TRIGGERED fired once');
    assert.equal(log[0].data.eventId, 'evt1');
    assert.equal(log[0].data.bounty, 5000);
    assert.equal(log[0].data.partner, 'USA');
    mes.dispose();
  });

  it('does not re-trigger already triggered events', () => {
    const mes = makeMES();
    const log = trackEvents(Events.NEWS_EVENT_TRIGGERED);

    mes._injectNewsEvents([
      { id: 'evt1', name: 'Evt1', unlockCaptures: 1, bounty: 5000, partner: 'USA', headline: 'h', date: '2026-01-01', debris: { name: 'D1' } }
    ]);

    eventBus.emit(Events.INTERACTION_CAPTURE, {});
    eventBus.emit(Events.INTERACTION_CAPTURE, {});
    eventBus.emit(Events.INTERACTION_CAPTURE, {});

    assert.equal(log.length, 1, 'only triggers once');
    mes.dispose();
  });

  it('INTERACTION_DEORBIT also counts as capture', () => {
    const mes = makeMES();
    const log = trackEvents(Events.NEWS_EVENT_TRIGGERED);

    mes._injectNewsEvents([
      { id: 'evt1', name: 'Evt1', unlockCaptures: 2, bounty: 5000, partner: 'USA', headline: 'h', date: '2026-01-01', debris: { name: 'D1' } }
    ]);

    eventBus.emit(Events.INTERACTION_CAPTURE, {});
    eventBus.emit(Events.INTERACTION_DEORBIT, {});

    assert.equal(log.length, 1, 'deorbit counted toward unlock');
    mes.dispose();
  });

  it('multiple events trigger in sequence as captures accumulate', () => {
    const mes = makeMES();
    const log = trackEvents(Events.NEWS_EVENT_TRIGGERED);

    mes._injectNewsEvents([
      { id: 'evt1', name: 'Evt1', unlockCaptures: 1, bounty: 1000, partner: 'USA', headline: 'h1', date: '2026-01-01', debris: { name: 'D1' } },
      { id: 'evt2', name: 'Evt2', unlockCaptures: 3, bounty: 5000, partner: 'SpaceX', headline: 'h2', date: '2026-02-01', debris: { name: 'D2' } }
    ]);

    eventBus.emit(Events.INTERACTION_CAPTURE, {}); // captures=1 → evt1 triggers
    assert.equal(log.length, 1, 'first event triggered at 1');

    eventBus.emit(Events.INTERACTION_CAPTURE, {}); // captures=2
    assert.equal(log.length, 1, 'still 1 at captures=2');

    eventBus.emit(Events.INTERACTION_CAPTURE, {}); // captures=3 → evt2 triggers
    assert.equal(log.length, 2, 'second event triggered at 3');
    assert.equal(log[1].data.eventId, 'evt2');
    mes.dispose();
  });

  it('reset clears triggeredNewsIds and totalCaptures but keeps events', () => {
    const mes = makeMES();
    mes._injectNewsEvents([
      { id: 'evt1', name: 'Evt1', unlockCaptures: 1, bounty: 1000, partner: 'USA', headline: 'h', date: '2026-01-01', debris: { name: 'D1' } }
    ]);

    eventBus.emit(Events.INTERACTION_CAPTURE, {});
    assert.equal(mes.triggeredNewsIds.size, 1);

    mes.reset();
    assert.equal(mes.totalCaptures, 0, 'captures reset');
    assert.equal(mes.triggeredNewsIds.size, 0, 'triggered IDs cleared');
    assert.equal(mes.newsEvents.length, 1, 'events still loaded');
    mes.dispose();
  });
});

// --- REPUTATION SYSTEM ---

describe('ST-8.4 ReputationSystem initialization', () => {
  it('initializes 5 partners with correct starting rep', () => {
    eventBus.clear();
    const rep = new ReputationSystem();
    const all = rep.getAllPartners();
    assert.equal(all.length, 5, '5 partners');
    assert.equal(rep.partners.India.rep, 30, 'India starts at 30 (home base)');
    assert.equal(rep.partners.USA.rep, 20);
    assert.equal(rep.partners.SpaceX.rep, 10);
    assert.equal(rep.partners.Thailand.rep, 0);
    assert.equal(rep.partners.ESA.rep, 15);
    rep.dispose();
  });
});

describe('ST-8.4 ReputationSystem tier calculation', () => {
  it('returns correct tier for rep values', () => {
    eventBus.clear();
    const rep = new ReputationSystem();
    assert.equal(rep._getTier(0), 0, 'tier 0 at rep 0');
    assert.equal(rep._getTier(24), 0, 'tier 0 at rep 24');
    assert.equal(rep._getTier(25), 1, 'tier 1 at rep 25');
    assert.equal(rep._getTier(49), 1, 'tier 1 at rep 49');
    assert.equal(rep._getTier(50), 2, 'tier 2 at rep 50');
    assert.equal(rep._getTier(74), 2, 'tier 2 at rep 74');
    assert.equal(rep._getTier(75), 3, 'tier 3 at rep 75');
    assert.equal(rep._getTier(100), 3, 'tier 3 at rep 100');
    rep.dispose();
  });
});

describe('ST-8.4 ReputationSystem _addRep', () => {
  it('increases rep and caps at 100', () => {
    eventBus.clear();
    const rep = new ReputationSystem();
    rep._addRep('Thailand', 50);
    assert.equal(rep.partners.Thailand.rep, 50);
    rep._addRep('Thailand', 60);
    assert.equal(rep.partners.Thailand.rep, 100, 'capped at 100');
    rep.dispose();
  });

  it('emits reputation:tierUp when crossing threshold', () => {
    eventBus.clear();
    const rep = new ReputationSystem();
    const log = [];
    eventBus.on('reputation:tierUp', (d) => log.push(d));

    // Thailand is at 0, add 25 → crosses tier 1 at 25
    rep._addRep('Thailand', 25);
    assert.equal(log.length, 1, 'tierUp emitted');
    assert.equal(log[0].partner, 'Thailand');
    assert.equal(log[0].label, 'Trusted');
    rep.dispose();
  });

  it('ignores unknown partner', () => {
    eventBus.clear();
    const rep = new ReputationSystem();
    rep._addRep('UNKNOWN', 50); // should not throw
    rep.dispose();
  });
});

describe('ST-8.4 ReputationSystem getPartnerInfo', () => {
  it('returns correct structure with perks', () => {
    eventBus.clear();
    const rep = new ReputationSystem();
    rep._addRep('India', 20); // 30 + 20 = 50 → tier 2
    const info = rep.getPartnerInfo('India');
    assert.equal(info.rep, 50);
    assert.equal(info.tier, 2);
    assert.equal(info.tierLabel, 'Preferred');
    assert.ok(info.perks.includes('priority_contracts'));
    rep.dispose();
  });

  it('returns null for unknown partner', () => {
    eventBus.clear();
    const rep = new ReputationSystem();
    assert.equal(rep.getPartnerInfo('BOGUS'), null);
    rep.dispose();
  });
});

describe('ST-8.4 ReputationSystem event integration', () => {
  it('INTERACTION_CAPTURE adds 1 rep to India', () => {
    eventBus.clear();
    const rep = new ReputationSystem();
    const startRep = rep.partners.India.rep;
    eventBus.emit(Events.INTERACTION_CAPTURE, {});
    assert.equal(rep.partners.India.rep, startRep + 1);
    rep.dispose();
  });

  it('NEWS_EVENT_TRIGGERED adds 5 rep to partner', () => {
    eventBus.clear();
    const rep = new ReputationSystem();
    const startRep = rep.partners.USA.rep;
    eventBus.emit(Events.NEWS_EVENT_TRIGGERED, { partner: 'USA', eventId: 'test' });
    assert.equal(rep.partners.USA.rep, startRep + 5);
    rep.dispose();
  });

  it('reset restores initial values', () => {
    eventBus.clear();
    const rep = new ReputationSystem();
    rep._addRep('Thailand', 50);
    rep.reset();
    assert.equal(rep.partners.Thailand.rep, 0, 'Thailand reset to 0');
    assert.equal(rep.partners.India.rep, 30, 'India reset to 30');
    rep.dispose();
  });
});
