/**
 * test-TeachingSystem.js — ST-6.5: TeachingSystem + TeachingOverlay tests
 *
 * Tests teaching moment definitions, state management (hasSeen/markSeen),
 * event-driven triggers, persistence round-trips, queue management,
 * and dispose cleanup. Node-safe — no DOM operations.
 */
import { describe, it, assert } from './TestRunner.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { TeachingSystem, TEACHING_MOMENTS, MOMENTS_BY_ID } from '../systems/TeachingSystem.js';

// ============================================================================
// MOCK EventBus — minimal pub/sub for testing
// ============================================================================
function createMockEventBus() {
  const listeners = new Map();
  return {
    on(evt, handler) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(handler);
      // Return unsub function
      return () => {
        const arr = listeners.get(evt);
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx >= 0) arr.splice(idx, 1);
        }
      };
    },
    emit(evt, data) {
      const arr = listeners.get(evt);
      if (arr) arr.forEach(fn => fn(data));
    },
    off(evt, handler) {
      const arr = listeners.get(evt);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    },
    listenerCount(evt) {
      return (listeners.get(evt) || []).length;
    },
    _listeners: listeners,
  };
}

// ============================================================================
// 1. MOMENT DEFINITIONS
// ============================================================================
describe('TeachingSystem — Moment Definitions', () => {

  it('has exactly 17 registered moments', () => {
    assert.equal(TEACHING_MOMENTS.length, 17,
      `expected 17 moments, got ${TEACHING_MOMENTS.length}`);
  });

  it('all moments have required fields: id, title, body, duration, icon', () => {
    for (const m of TEACHING_MOMENTS) {
      assert.ok(typeof m.id === 'string' && m.id.length > 0, `missing id on moment`);
      assert.ok(typeof m.title === 'string' && m.title.length > 0, `missing title on ${m.id}`);
      assert.ok(typeof m.body === 'string' && m.body.length > 0, `missing body on ${m.id}`);
      assert.ok(typeof m.duration === 'number' && m.duration > 0, `invalid duration on ${m.id}`);
      assert.ok(typeof m.icon === 'string' && m.icon.length > 0, `missing icon on ${m.id}`);
    }
  });

  it('no duplicated IDs', () => {
    const ids = TEACHING_MOMENTS.map(m => m.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length,
      `duplicate IDs found: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
  });

  it('MOMENTS_BY_ID map has all 17 entries', () => {
    assert.equal(MOMENTS_BY_ID.size, 17);
    for (const m of TEACHING_MOMENTS) {
      assert.ok(MOMENTS_BY_ID.has(m.id), `MOMENTS_BY_ID missing ${m.id}`);
    }
  });

  it('expected moment IDs match spec', () => {
    const expected = [
      'first_target', 'first_arm', 'first_capture', 'first_conjunction',
      'first_weather', 'first_shop', 'first_codex', 'first_burn',
      'first_kessler', 'first_autopilot', 'first_lasso', 'first_active_sat_warning',
      'first_scan', 'first_arm_deploy',
    ];
    for (const id of expected) {
      assert.ok(MOMENTS_BY_ID.has(id), `missing expected moment: ${id}`);
    }
  });
});

// ============================================================================
// 2. hasSeen / markSeen
// ============================================================================
describe('TeachingSystem — hasSeen / markSeen', () => {

  it('fresh system reports hasSeen=false for all moments', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    for (const m of TEACHING_MOMENTS) {
      assert.equal(ts.hasSeen(m.id), false, `${m.id} should be unseen`);
    }
    ts.dispose();
  });

  it('markSeen makes hasSeen return true', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    ts.markSeen('first_target');
    assert.equal(ts.hasSeen('first_target'), true);
    assert.equal(ts.hasSeen('first_arm'), false);
    ts.dispose();
  });

  it('markSeen is idempotent', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    ts.markSeen('first_target');
    ts.markSeen('first_target');
    assert.equal(ts.getSeenCount(), 1);
    ts.dispose();
  });
});

// ============================================================================
// 3. PERSISTENCE ROUND-TRIP
// ============================================================================
describe('TeachingSystem — Persistence Round-Trip', () => {

  it('markSeen 3 moments → new system from same storage → those 3 are hasSeen=true', () => {
    // Simulate localStorage with a simple in-memory shim
    const store = {};
    const origLS = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k) => store[k] || null,
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    };

    try {
      const eb1 = createMockEventBus();
      const ts1 = new TeachingSystem(eb1);
      ts1.markSeen('first_target');
      ts1.markSeen('first_capture');
      ts1.markSeen('first_kessler');
      ts1.dispose();

      // New instance reads from same storage
      const eb2 = createMockEventBus();
      const ts2 = new TeachingSystem(eb2);
      assert.equal(ts2.hasSeen('first_target'), true);
      assert.equal(ts2.hasSeen('first_capture'), true);
      assert.equal(ts2.hasSeen('first_kessler'), true);
      assert.equal(ts2.hasSeen('first_arm'), false);
      assert.equal(ts2.getSeenCount(), 3);
      ts2.dispose();
    } finally {
      if (origLS) globalThis.localStorage = origLS;
      else delete globalThis.localStorage;
    }
  });
});

// ============================================================================
// 4. TRIGGER FIRES ONCE
// ============================================================================
describe('TeachingSystem — Trigger Fires Once', () => {

  it('TARGET_SELECTED twice → onShow called exactly once', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    let showCount = 0;
    ts.onShow = () => { showCount++; };
    ts.init();

    eb.emit(Events.TARGET_SELECTED, { targetId: 1 });
    eb.emit(Events.TARGET_SELECTED, { targetId: 2 });

    assert.equal(showCount, 1, `expected 1 call, got ${showCount}`);
    ts.dispose();
  });
});

// ============================================================================
// 5. DIFFERENT TRIGGERS
// ============================================================================
describe('TeachingSystem — Different Triggers', () => {

  it('TARGET_SELECTED then ARM_DEPLOYED → onShow called for target + arm + arm_deploy', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    let showCount = 0;
    const shown = [];
    ts.onShow = (m) => { showCount++; shown.push(m.id); };
    ts.init();

    eb.emit(Events.TARGET_SELECTED, { targetId: 1 });
    eb.emit(Events.ARM_DEPLOYED, { armId: 0 });

    // ARM_DEPLOYED triggers both first_arm and first_arm_deploy (UX-3 N1)
    assert.equal(showCount, 3, `expected 3 calls, got ${showCount}`);
    assert.equal(shown[0], 'first_target');
    assert.equal(shown[1], 'first_arm');
    assert.equal(shown[2], 'first_arm_deploy');
    ts.dispose();
  });
});

// ============================================================================
// 6. CONJUNCTION FILTER
// ============================================================================
describe('TeachingSystem — Conjunction Alert Filtering', () => {

  it('CONJUNCTION_ALERT with severity HI triggers first_conjunction', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    let shownId = null;
    ts.onShow = (m) => { shownId = m.id; };
    ts.init();

    eb.emit(Events.CONJUNCTION_ALERT, { severity: 'HI', reason: 'TCA' });
    assert.equal(shownId, 'first_conjunction');
    ts.dispose();
  });

  it('CONJUNCTION_ALERT with severity MD triggers first_conjunction', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    let shownId = null;
    ts.onShow = (m) => { shownId = m.id; };
    ts.init();

    eb.emit(Events.CONJUNCTION_ALERT, { severity: 'MD', reason: 'TCA' });
    assert.equal(shownId, 'first_conjunction');
    ts.dispose();
  });

  it('CONJUNCTION_ALERT with reason ACTIVE_SAT_ARMING triggers first_active_sat_warning', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    let shownId = null;
    ts.onShow = (m) => { shownId = m.id; };
    ts.init();

    eb.emit(Events.CONJUNCTION_ALERT, { severity: 'RED', reason: 'ACTIVE_SAT_ARMING' });
    assert.equal(shownId, 'first_active_sat_warning');
    ts.dispose();
  });

  it('CONJUNCTION_ALERT with severity GREEN and no ACTIVE_SAT reason triggers nothing', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    let showCount = 0;
    ts.onShow = () => { showCount++; };
    ts.init();

    eb.emit(Events.CONJUNCTION_ALERT, { severity: 'GREEN', reason: 'TCA' });
    assert.equal(showCount, 0, 'GREEN severity should not trigger teaching');
    ts.dispose();
  });

  it('both conjunction moments can fire independently', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    const shown = [];
    ts.onShow = (m) => { shown.push(m.id); };
    ts.init();

    eb.emit(Events.CONJUNCTION_ALERT, { severity: 'HI', reason: 'TCA' });
    eb.emit(Events.CONJUNCTION_ALERT, { severity: 'RED', reason: 'ACTIVE_SAT_ARMING' });

    assert.equal(shown.length, 2);
    assert.equal(shown[0], 'first_conjunction');
    assert.equal(shown[1], 'first_active_sat_warning');
    ts.dispose();
  });
});

// ============================================================================
// 7. QUEUE DEPTH LIMIT
// ============================================================================
describe('TeachingSystem — Queue Depth Limit (onShow behaviour)', () => {

  it('firing 5 simultaneous triggers → onShow called 6 times (ARM_DEPLOYED fires 2 moments)', () => {
    // TeachingSystem itself always calls onShow for unseen moments.
    // Queue depth limiting is TeachingOverlay's job.
    // TeachingSystem marks seen immediately and delegates.
    // UX-3 N1: ARM_DEPLOYED triggers both first_arm and first_arm_deploy → 6 total
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    let showCount = 0;
    ts.onShow = () => { showCount++; };
    ts.init();

    eb.emit(Events.TARGET_SELECTED, {});
    eb.emit(Events.ARM_DEPLOYED, {});
    eb.emit(Events.DEBRIS_CAPTURED, {});
    eb.emit(Events.WEATHER_EFFECT_START, {});
    eb.emit(Events.SHOP_OPENED, {});

    // 5 events but ARM_DEPLOYED fires 2 moments → 6 onShow calls
    assert.equal(showCount, 6, `expected 6 onShow calls, got ${showCount}`);
    ts.dispose();
  });

  it('TeachingOverlay queue logic: max 3 queued + 1 showing = 4 total, rest dropped', () => {
    // Test the queue concept: if overlay is "busy", items queue.
    // We test this via a mock overlay with queue tracking.
    const maxQueue = Constants.TEACHING.MAX_QUEUE_DEPTH;
    assert.equal(maxQueue, 3, `MAX_QUEUE_DEPTH should be 3, got ${maxQueue}`);

    // Simulate overlay queue behaviour
    const queue = [];
    let showing = false;
    let dropCount = 0;

    function mockShow(moment) {
      if (showing) {
        if (queue.length < maxQueue) {
          queue.push(moment);
        } else {
          dropCount++;
        }
        return;
      }
      showing = true;
    }

    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    ts.onShow = mockShow;
    ts.init();

    // Fire 5 different events rapidly
    // UX-3 N1: ARM_DEPLOYED triggers 2 moments → 6 total moments from 5 events
    eb.emit(Events.TARGET_SELECTED, {});     // shows immediately
    eb.emit(Events.ARM_DEPLOYED, {});         // queued (1: first_arm), queued (2: first_arm_deploy)
    eb.emit(Events.DEBRIS_CAPTURED, {});      // queued (3: first_capture)
    eb.emit(Events.WEATHER_EFFECT_START, {}); // DROPPED
    eb.emit(Events.SHOP_OPENED, {});          // DROPPED

    assert.equal(queue.length, 3, `queue should have 3, got ${queue.length}`);
    assert.equal(dropCount, 2, `2 should be dropped, got ${dropCount}`);
    ts.dispose();
  });
});

// ============================================================================
// 8. resetAll
// ============================================================================
describe('TeachingSystem — resetAll', () => {

  it('clears all seen flags', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);

    // Mark all seen
    for (const m of TEACHING_MOMENTS) {
      ts.markSeen(m.id);
    }
    assert.equal(ts.getSeenCount(), 17);

    // Reset
    ts.resetAll();
    assert.equal(ts.getSeenCount(), 0);

    // All should be unseen
    for (const m of TEACHING_MOMENTS) {
      assert.equal(ts.hasSeen(m.id), false, `${m.id} should be unseen after reset`);
    }
    ts.dispose();
  });
});

// ============================================================================
// 9. getSeenCount / getTotalCount
// ============================================================================
describe('TeachingSystem — getSeenCount / getTotalCount', () => {

  it('getTotalCount returns 17', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    assert.equal(ts.getTotalCount(), 17);
    ts.dispose();
  });

  it('after marking 5 → getSeenCount === 5', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    ts.markSeen('first_target');
    ts.markSeen('first_arm');
    ts.markSeen('first_capture');
    ts.markSeen('first_shop');
    ts.markSeen('first_burn');
    assert.equal(ts.getSeenCount(), 5);
    assert.equal(ts.getTotalCount(), 17);
    ts.dispose();
  });
});

// ============================================================================
// 10. DISPOSE CLEANUP
// ============================================================================
describe('TeachingSystem — dispose cleanup', () => {

  it('after dispose, firing events does NOT call onShow', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    let showCount = 0;
    ts.onShow = () => { showCount++; };
    ts.init();

    // Dispose before firing
    ts.dispose();

    eb.emit(Events.TARGET_SELECTED, { targetId: 1 });
    eb.emit(Events.ARM_DEPLOYED, { armId: 0 });

    assert.equal(showCount, 0, 'onShow should not be called after dispose');
  });
});

// ============================================================================
// 11. GRACEFUL DEGRADATION
// ============================================================================
describe('TeachingSystem — Graceful Degradation', () => {

  it('construct without PersistenceManager → no crash, hasSeen works', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb, null);
    assert.equal(ts.hasSeen('first_target'), false);
    ts.markSeen('first_target');
    assert.equal(ts.hasSeen('first_target'), true);
    ts.dispose();
  });

  it('construct without eventBus → no crash on init()', () => {
    const ts = new TeachingSystem(null, null);
    ts.init(); // should not throw
    ts.dispose();
  });
});

// ============================================================================
// 12. THROTTLE_CHANGE FILTER
// ============================================================================
describe('TeachingSystem — Throttle Filter', () => {

  it('THROTTLE_CHANGE with level=0 does NOT trigger first_burn', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    let showCount = 0;
    ts.onShow = () => { showCount++; };
    ts.init();

    eb.emit(Events.THROTTLE_CHANGE, { level: 0 });
    assert.equal(showCount, 0, 'level=0 should not trigger');
    ts.dispose();
  });

  it('THROTTLE_CHANGE with level>0 triggers first_burn', () => {
    const eb = createMockEventBus();
    const ts = new TeachingSystem(eb);
    let shownId = null;
    ts.onShow = (m) => { shownId = m.id; };
    ts.init();

    eb.emit(Events.THROTTLE_CHANGE, { level: 0.5 });
    assert.equal(shownId, 'first_burn');
    ts.dispose();
  });
});

// ============================================================================
// 13. ALL TRIGGER EVENT MAPPINGS
// ============================================================================
describe('TeachingSystem — All Trigger Mappings', () => {

  it('each trigger event fires the correct moment', () => {
    const triggers = [
      { event: Events.TARGET_SELECTED, data: {}, expectedId: 'first_target' },
      // ARM_DEPLOYED triggers first_arm (then first_arm_deploy), check first one
      { event: Events.ARM_DEPLOYED, data: {}, expectedId: 'first_arm' },
      { event: Events.DEBRIS_CAPTURED, data: {}, expectedId: 'first_capture' },
      { event: Events.WEATHER_EFFECT_START, data: {}, expectedId: 'first_weather' },
      { event: Events.SHOP_OPENED, data: {}, expectedId: 'first_shop' },
      { event: Events.CODEX_OPENED, data: {}, expectedId: 'first_codex' },
      { event: Events.THROTTLE_CHANGE, data: { level: 1 }, expectedId: 'first_burn' },
      { event: Events.KESSLER_CASCADE, data: {}, expectedId: 'first_kessler' },
      { event: Events.AUTOPILOT_ENGAGE, data: { mode: 'TARGET' }, expectedId: 'first_autopilot' },
      { event: Events.LASSO_FIRED, data: {}, expectedId: 'first_lasso' },
      // UX-3 N1: new triggers
      { event: Events.SCAN_INITIATED, data: {}, expectedId: 'first_scan' },
    ];

    for (const { event, data, expectedId } of triggers) {
      const eb = createMockEventBus();
      const ts = new TeachingSystem(eb);
      let shownId = null;
      // Record only the FIRST onShow call (some events trigger multiple moments)
      ts.onShow = (m) => { if (!shownId) shownId = m.id; };
      ts.init();

      eb.emit(event, data);
      assert.equal(shownId, expectedId,
        `${event} should trigger ${expectedId}, got ${shownId}`);
      ts.dispose();
    }
  });
});

// ============================================================================
// 14. EVENTS.JS — SHOP_OPENED exists
// ============================================================================
describe('TeachingSystem — SHOP_OPENED Event', () => {

  it('Events.SHOP_OPENED is defined as "shop:opened"', () => {
    assert.equal(Events.SHOP_OPENED, 'shop:opened');
  });
});

// ============================================================================
// 15. CONSTANTS.TEACHING — covered in test-Constants.js extension
// ============================================================================
describe('TeachingSystem — Constants.TEACHING Cross-Check', () => {

  it('TOTAL_MOMENTS matches actual TEACHING_MOMENTS count', () => {
    assert.equal(Constants.TEACHING.TOTAL_MOMENTS, TEACHING_MOMENTS.length,
      `TOTAL_MOMENTS (${Constants.TEACHING.TOTAL_MOMENTS}) ≠ actual count (${TEACHING_MOMENTS.length})`);
  });
});
