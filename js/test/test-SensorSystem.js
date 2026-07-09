/**
 * test-SensorSystem.js — scan reveal-settled event timing.
 * (.kilo/plans/1783473856741-scan-auto-select-target.md — task 2)
 *
 * Covers SCAN_REVEALS_SETTLED emission from _revealNearbyDebris:
 *   • emitted after the staggered reveals land (toReveal.length * stagger + 50);
 *   • emitted immediately on a zero-reveal re-scan of a field with discovered contacts;
 *   • NOT emitted for truly empty space (no nearby debris at all).
 *
 * @module test/test-SensorSystem
 */

import { describe, it, assert } from './TestRunner.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { SensorSystem } from '../systems/SensorSystem.js';

const STAGGER = Constants.SCAN.REVEAL_STAGGER_MS || 120;

/**
 * DebrisField mock. `nearby` is the list returned by getDebrisNear (spread
 * copies, each with `discovered`); getDebrisById resolves the same objects so
 * reveal mutations stick.
 */
function mockField(nearby) {
  const byId = new Map(nearby.map(d => [d.id, d]));
  return {
    getDebrisNear: () => nearby,
    getDebrisById: (id) => byId.get(id) || null,
  };
}

function makeSensor(nearby, playerPos = { x: 0, y: 0, z: 0 }) {
  const s = new SensorSystem();
  s._lastDebrisField = mockField(nearby);
  s._lastPlayerPos = playerPos;
  return s;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('SensorSystem — SCAN_REVEALS_SETTLED', () => {
  it('does NOT emit for truly empty space', async () => {
    eventBus.clear();
    const settled = [];
    eventBus.on(Events.SCAN_REVEALS_SETTLED, (d) => settled.push(d));
    const s = makeSensor([]); // getDebrisNear → empty
    s._revealNearbyDebris('quick');
    await waitMs(STAGGER + 80);
    assert.equal(settled.length, 0, 'no reveal-settled event when the field is empty');
  });

  it('emits immediately on a zero-reveal re-scan of a known field', () => {
    eventBus.clear();
    const settled = [];
    eventBus.on(Events.SCAN_REVEALS_SETTLED, (d) => settled.push(d));
    // Field with only already-discovered contacts → nothing new to reveal.
    const s = makeSensor([{ id: 1, discovered: true }]);
    s._revealNearbyDebris('quick');
    assert.equal(settled.length, 1, 'reveal-settled fires synchronously on re-scan');
    assert.equal(settled[0].revealed, 0, 'zero new reveals reported');
    assert.equal(settled[0].scanType, 'quick');
  });

  it('emits after the staggered reveals land', () => {
    eventBus.clear();
    // Capture scheduled timers synchronously so this test does not depend on
    // real time or on the shared eventBus surviving concurrent suites' clears.
    const timers = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return 0; };
    const settled = [];
    eventBus.on(Events.SCAN_REVEALS_SETTLED, (d) => settled.push(d));
    try {
      const contacts = [
        { id: 1, discovered: false },
        { id: 2, discovered: false },
      ];
      const s = makeSensor(contacts);
      s._revealNearbyDebris('quick');

      // Two reveal timers (at 0, STAGGER) + one settled timer at
      // 2*STAGGER + 50 — nothing has run yet.
      assert.equal(settled.length, 0, 'settled event deferred until reveals land');
      const settledTimer = timers.find(t => t.ms === 2 * STAGGER + 50);
      assert.ok(settledTimer, 'settled timer scheduled at toReveal.length*stagger + 50');

      // Fire every scheduled timer in order (nearest-first reveal, then settle).
      timers.sort((a, b) => a.ms - b.ms).forEach(t => t.fn());
      assert.ok(contacts.every(c => c.discovered), 'both contacts discovered');
      assert.equal(settled.length, 1, 'settled fires once after the last reveal');
      assert.equal(settled[0].revealed, 2, 'reveal count reported');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});
