/**
 * TimerManager tests — verifies the central setTimeout/setInterval
 * registry behavior, including auto-removal, tag-based clearing, and
 * the STATE_CHANGE auto-clear hook.
 *
 * Most assertions exercise the registry API directly (no real waits).
 * For the auto-fire path we use small real-time sleeps (≤ 30 ms total)
 * — those are wrapped in `await describe(...)` so the test module
 * doesn't resolve before all timers have fired (the run-tests.js
 * runner only flushes microtasks, not macrotasks).
 */

import { describe, it, assert } from './TestRunner.js';
import timerManager, { TimerManager } from '../systems/TimerManager.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- synchronous API-shape tests ----------

describe('TimerManager — clear by id', () => {

  it('clear(id) cancels a pending setTimeout, registry empties', () => {
    const tm = new TimerManager();
    let fired = 0;
    const id = tm.setTimeout(() => { fired++; }, 10_000);
    assert.equal(tm.activeCount(), 1, 'one active before clear');
    assert.equal(tm.clear(id), true, 'clear returns true for live timer');
    assert.equal(tm.activeCount(), 0, 'registry empty after clear');
    assert.equal(tm.clear(id), false, 'second clear returns false');
    assert.equal(fired, 0, 'cleared timer never fires');
  });

  it('clearAll empties the entire registry', () => {
    const tm = new TimerManager();
    tm.setTimeout(() => {}, 10_000);
    tm.setInterval(() => {}, 10_000);
    tm.setTimeout(() => {}, 10_000, { owner: 'foo', state: 'MENU' });
    assert.equal(tm.activeCount(), 3);
    const n = tm.clearAll();
    assert.equal(n, 3, 'clearAll returns count cleared');
    assert.equal(tm.activeCount(), 0);
  });
});

describe('TimerManager — tagged clearing', () => {

  it('clearByOwner clears only matching timers', () => {
    const tm = new TimerManager();
    const ownerA = { tag: 'A' };
    const ownerB = { tag: 'B' };
    tm.setTimeout(() => {}, 10_000, { owner: ownerA });
    tm.setTimeout(() => {}, 10_000, { owner: ownerA });
    tm.setTimeout(() => {}, 10_000, { owner: ownerB });
    tm.setInterval(() => {}, 10_000, { owner: ownerA });
    assert.equal(tm.activeCount(), 4);

    const cleared = tm.clearByOwner(ownerA);
    assert.equal(cleared, 3, 'three A-owned timers cleared');
    assert.equal(tm.activeCount(), 1, 'only B-owned timer remains');

    tm.clearAll();
  });

  it('clearByState clears only matching state-tagged timers', () => {
    const tm = new TimerManager();
    tm.setTimeout(() => {}, 10_000, { state: 'MENU' });
    tm.setTimeout(() => {}, 10_000, { state: 'MENU' });
    tm.setTimeout(() => {}, 10_000, { state: 'ORBITAL_VIEW' });
    tm.setTimeout(() => {}, 10_000, { state: null }); // state-agnostic
    assert.equal(tm.activeCount(), 4);

    const cleared = tm.clearByState('MENU');
    assert.equal(cleared, 2, 'two MENU-tagged timers cleared');
    assert.equal(tm.activeCount(), 2);

    // clearByState(null) is a no-op
    assert.equal(tm.clearByState(null), 0);
    assert.equal(tm.activeCount(), 2);

    tm.clearAll();
  });

  it('clearByOwner(null) and clearByOwner(unknown) are no-ops', () => {
    const tm = new TimerManager();
    tm.setTimeout(() => {}, 10_000, { owner: 'real' });
    assert.equal(tm.clearByOwner(null), 0);
    assert.equal(tm.clearByOwner('not-real'), 0);
    assert.equal(tm.activeCount(), 1);
    tm.clearAll();
  });
});

describe('TimerManager — STATE_CHANGE auto-clear', () => {

  it('emitting Events.STATE_CHANGE clears timers tagged with the previous state', () => {
    // Use a FRESH instance to keep the assertion hermetic. The singleton
    // shares the eventBus with the rest of the app, so other test files
    // (AudioSystem etc.) may schedule timers as side-effects of the
    // emit below — those would pollute activeCount. A fresh TimerManager
    // subscribes to the same Events.STATE_CHANGE in its constructor and
    // exercises identical behavior in isolation.
    const tm = new TimerManager();

    tm.setTimeout(() => {}, 10_000, { state: 'MENU' });
    tm.setTimeout(() => {}, 10_000, { state: 'MENU' });
    tm.setTimeout(() => {}, 10_000, { state: 'ORBITAL_VIEW' });
    tm.setTimeout(() => {}, 10_000, { state: null });
    const before = tm.activeCount();
    assert.equal(before, 4);

    // Mimic GameState.setState(): emit STATE_CHANGE with { from, to }.
    // Both `tm` and the singleton receive this; we only assert on `tm`.
    eventBus.emit(Events.STATE_CHANGE, { from: 'MENU', to: 'ORBITAL_VIEW' });

    assert.equal(tm.activeCount(), 2,
      'MENU-tagged timers auto-cleared on STATE_CHANGE(from=MENU)');

    tm.clearAll();
    assert.equal(tm.activeCount(), 0);
  });
});

// ---------- real-timer tests (must be awaited at top level) ----------

await describe('TimerManager — setTimeout fires + auto-removes', async () => {

  await it('setTimeout fires once and is removed from registry', async () => {
    const tm = new TimerManager();
    let fired = 0;
    const id = tm.setTimeout(() => { fired++; }, 5);
    assert.equal(tm.activeCount(), 1, 'one active before fire');
    await sleep(25);
    assert.equal(fired, 1, 'fired exactly once');
    assert.equal(tm.activeCount(), 0, 'auto-removed after fire');
    assert.equal(tm.clear(id), false, 'clear(stale id) is a no-op');
  });
});

await describe('TimerManager — setInterval repeats and is cancellable', async () => {

  await it('setInterval fires repeatedly until cleared, then stops', async () => {
    const tm = new TimerManager();
    let ticks = 0;
    const id = tm.setInterval(() => { ticks++; }, 5);
    await sleep(28);
    tm.clear(id);
    const ticksAtClear = ticks;
    assert.ok(ticksAtClear >= 3, `expected ≥3 ticks in 28 ms, got ${ticksAtClear}`);
    assert.equal(tm.activeCount(), 0, 'cleared interval removed from registry');
    await sleep(20);
    assert.equal(ticks, ticksAtClear, 'no more ticks after clear');
  });
});

await describe('TimerManager — activeCount reflects state across lifecycle', async () => {

  await it('activeCount tracks adds, fires, and clears', async () => {
    const tm = new TimerManager();
    assert.equal(tm.activeCount(), 0);

    const a = tm.setTimeout(() => {}, 10_000);
    const b = tm.setTimeout(() => {}, 5);
    const c = tm.setInterval(() => {}, 10_000);
    assert.equal(tm.activeCount(), 3);

    await sleep(25);
    assert.equal(tm.activeCount(), 2, 'auto-fire decremented count');

    tm.clear(a);
    assert.equal(tm.activeCount(), 1);

    tm.clear(c);
    assert.equal(tm.activeCount(), 0);
  });
});

await describe('TimerManager — re-entrant safety', async () => {

  await it('clearByOwner inside a fired callback finds nothing to clear', async () => {
    const tm = new TimerManager();
    const owner = { tag: 'reentrant' };
    let fired = 0;
    tm.setTimeout(() => {
      fired++;
      // The fired timer should already be removed from the registry,
      // so clearByOwner finds nothing — must not throw.
      const n = tm.clearByOwner(owner);
      assert.equal(n, 0, 'self-firing timer already removed before cb');
    }, 5, { owner });
    await sleep(25);
    assert.equal(fired, 1);
    assert.equal(tm.activeCount(), 0);
  });
});
