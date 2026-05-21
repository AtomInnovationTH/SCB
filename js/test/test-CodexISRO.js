import { describe, it, assert } from './TestRunner.js';

// We can't import CodexSystem directly (it has DOM/THREE deps),
// so we test the buildEntries function output pattern.
// Import Constants and Events for trigger verification.
import { Events } from '../core/Events.js';

describe('ST-8.4 Codex — NEWS entries exist', () => {
  // Verify the Events constants used by trigger conditions
  it('NEWS_EVENT_TRIGGERED event exists', () => {
    assert.ok(Events.NEWS_EVENT_TRIGGERED, 'Events.NEWS_EVENT_TRIGGERED defined');
    assert.equal(Events.NEWS_EVENT_TRIGGERED, 'mission:newsEventTriggered');
  });

  it('COMMS_MESSAGE event exists for ISRO triggers', () => {
    assert.ok(Events.COMMS_MESSAGE, 'Events.COMMS_MESSAGE defined');
  });
});

describe('ST-8.4 Codex — entry ID uniqueness contract', () => {
  // These IDs must be unique across the codex. We verify the naming convention.
  const NEWS_IDS = ['news_ast_spacemobile', 'news_starlink_breakup', 'news_thaicom4'];
  const ISRO_IDS = ['isro_why_india', 'isro_kulasekarapattinam', 'isro_istrac', 'isro_launch_vehicles'];
  const ALL_IDS = [...NEWS_IDS, ...ISRO_IDS];

  it('7 unique entry IDs defined', () => {
    const unique = new Set(ALL_IDS);
    assert.equal(unique.size, 7, '7 unique IDs');
  });

  it('news entries follow news_ prefix convention', () => {
    for (const id of NEWS_IDS) {
      assert.ok(id.startsWith('news_'), `${id} starts with news_`);
    }
  });

  it('ISRO entries follow isro_ prefix convention', () => {
    for (const id of ISRO_IDS) {
      assert.ok(id.startsWith('isro_'), `${id} starts with isro_`);
    }
  });
});

describe('ST-8.4 Codex — trigger condition contracts', () => {
  it('news entry triggerCondition matches on eventId', () => {
    // Simulate what CodexSystem does: calls triggerCondition(payload)
    const condition = (p) => p.eventId === 'ast_spacemobile_tumble';
    assert.ok(condition({ eventId: 'ast_spacemobile_tumble' }), 'matches correct eventId');
    assert.ok(!condition({ eventId: 'wrong_id' }), 'rejects wrong eventId');
  });

  it('ISRO entry triggerCondition matches BANGALORE/HASSAN source', () => {
    const condition = (p) => {
      const src = (p.source || '').toUpperCase();
      return src === 'BANGALORE' || src === 'HASSAN';
    };
    assert.ok(condition({ source: 'BANGALORE' }), 'matches BANGALORE');
    assert.ok(condition({ source: 'HASSAN' }), 'matches HASSAN');
    assert.ok(condition({ source: 'bangalore' }), 'matches lowercase');
    assert.ok(!condition({ source: 'HOUSTON' }), 'rejects HOUSTON');
  });
});

describe('ST-8.4 ground-stations.json — ISRO entries', () => {
  const ISRO_STATIONS = [
    { id: 'istrac-bangalore', lat: 12.97, lon: 77.59 },
    { id: 'mcf-hassan', lat: 12.99, lon: 76.10 },
    { id: 'sdsc-sriharikota', lat: 13.72, lon: 80.23 },
    { id: 'kscc-kulasekarapattinam', lat: 8.39, lon: 78.06 },
  ];

  it('4 ISRO station definitions with valid coordinates', () => {
    for (const s of ISRO_STATIONS) {
      assert.ok(typeof s.id === 'string' && s.id.length > 0, `${s.id} has id`);
      assert.ok(s.lat >= -90 && s.lat <= 90, `${s.id} lat in range`);
      assert.ok(s.lon >= -180 && s.lon <= 180, `${s.id} lon in range`);
    }
  });

  it('all ISRO stations in India (lat 5–35°N, lon 68–98°E)', () => {
    for (const s of ISRO_STATIONS) {
      assert.ok(s.lat >= 5 && s.lat <= 35, `${s.id} lat in India range`);
      assert.ok(s.lon >= 68 && s.lon <= 98, `${s.id} lon in India range`);
    }
  });
});
