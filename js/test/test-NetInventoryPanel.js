/**
 * test-NetInventoryPanel.js — Delegation 4 (2026-05-31)
 *
 * Verifies the [`NetInventoryPanel`](js/ui/hud/NetInventoryPanel.js:1) widget:
 *   • Renders chips with the supplied counts.
 *   • Threshold transitions emit `INVENTORY_LOW` exactly once per crossing.
 *   • Cooldown prevents repeat emits within `LOW_HINT_COOLDOWN_MS`.
 *   • Critical state (both totals zero) uses the critical comms text.
 *   • Pure `classifySeverity` returns ok / low / critical for boundary inputs.
 *
 * @module test/test-NetInventoryPanel
 */

import { describe, it, assert } from './TestRunner.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';

// ── DOM stub (must be installed before importing NetInventoryPanel) ────────
if (typeof document === 'undefined') {
  const makeEl = () => {
    const el = {
      style: {},
      title: '',
      textContent: '',
      children: [],
      parentNode: null,
      _textNode: null,
      dataset: {},
      classList: { add() {}, remove() {} },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null;
        return c;
      },
    };
    return el;
  };
  globalThis.document = { createElement: makeEl, body: makeEl() };
}

import { NetInventoryPanel, classifySeverity } from '../ui/hud/NetInventoryPanel.js';

// ─── mock EventBus ────────────────────────────────────────────────────────
function makeMockBus() {
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

// ─── mock ArmManager ──────────────────────────────────────────────────────
function makeArmManager(perArm) {
  const arms = perArm.map((nets, i) => ({
    id: 'arm-' + i,
    _netInventory: nets,
    _netInventoryMax: 2,
    getNetInventory() { return this._netInventory; },
    getNetInventoryMax() { return this._netInventoryMax; },
  }));
  return { arms };
}

function makeLasso(remaining) {
  return { getAmmo() { return remaining; } };
}

// ─── PURE LOGIC ───────────────────────────────────────────────────────────

describe('NetInventoryPanel — classifySeverity (pure)', () => {
  it('returns "ok" when remaining well above the low threshold', () => {
    assert.equal(classifySeverity(20, 5, 0), 'ok');
  });
  it('returns "low" at exactly the low threshold', () => {
    assert.equal(classifySeverity(5, 5, 0), 'low');
  });
  it('returns "critical" at exactly the critical threshold', () => {
    assert.equal(classifySeverity(0, 5, 0), 'critical');
  });
  it('returns "ok" when threshold is strictly less than current', () => {
    assert.equal(classifySeverity(6, 5, 0), 'ok');
  });
});

// ─── CHIP RENDER ───────────────────────────────────────────────────────────

describe('NetInventoryPanel — initial render', () => {
  it('renders chips reflecting initial polled state', () => {
    const eb     = makeMockBus();
    const am     = makeArmManager([2, 2, 1]);   // total 5/6
    const lasso  = makeLasso(20);
    const container = globalThis.document.createElement('div');
    const panel = new NetInventoryPanel(container, {
      eventBus: eb, armManager: am, lassoSystem: lasso, now: () => 1000,
    });
    const s = panel.getState();
    assert.equal(s.lasso.remaining, 20);
    assert.equal(s.lasso.max, Constants.LASSO_AMMO_MAX);
    assert.equal(s.nets.total, 5);
    assert.equal(s.nets.max, 6);
    // Chips exist with text nodes filled.
    const root = panel.getElement();
    assert.ok(root, 'root element exists');
    assert.ok(root.children.length === 2, 'two chips rendered');
    panel.dispose();
  });
});

// ─── THRESHOLD TRANSITIONS ─────────────────────────────────────────────────

describe('NetInventoryPanel — threshold transitions emit INVENTORY_LOW', () => {
  it('emits INVENTORY_LOW when lasso crosses ok → low', () => {
    const eb     = makeMockBus();
    const am     = makeArmManager([2, 2]);
    const lasso  = makeLasso(20);
    const container = globalThis.document.createElement('div');
    const panel = new NetInventoryPanel(container, {
      eventBus: eb, armManager: am, lassoSystem: lasso, now: () => 1000,
    });
    eb._reset();
    eb.emit(Events.LASSO_AMMO_CHANGED, { remaining: 5, max: 50 });

    const low = eb._findEmits(Events.INVENTORY_LOW);
    assert.equal(low.length, 1, 'one INVENTORY_LOW emit');
    assert.equal(low[0].payload.kind, 'lasso');
    assert.equal(low[0].payload.severity, 'low');

    // Comms hint also emitted on HOUSTON channel.
    const comms = eb._findEmits(Events.COMMS_MESSAGE);
    assert.ok(comms.length >= 1, 'comms hint emitted');
    assert.equal(comms[0].payload.source, 'HOUSTON');
    panel.dispose();
  });

  it('emits "critical" severity + critical comms text when both go to zero', () => {
    const eb     = makeMockBus();
    const am     = makeArmManager([0, 0]);
    const lasso  = makeLasso(0);
    const container = globalThis.document.createElement('div');
    // Initial state is already critical so no emit on construction.
    const panel = new NetInventoryPanel(container, {
      eventBus: eb, armManager: am, lassoSystem: lasso, now: () => 1000,
    });
    eb._reset();
    // Re-emit to force a transition signal (lasso goes from 0 → 0 is not a
    // transition, so we simulate a fresh ok→critical event by manipulating
    // the panel's internal state, then re-emit).
    panel._lasso_state.severity = 'ok';
    panel._net_state.severity   = 'ok';
    eb.emit(Events.LASSO_AMMO_CHANGED, { remaining: 0, max: 50 });

    const low = eb._findEmits(Events.INVENTORY_LOW);
    assert.equal(low.length, 1);
    assert.equal(low[0].payload.severity, 'critical');
    const comms = eb._findEmits(Events.COMMS_MESSAGE);
    assert.ok(comms.length >= 1);
    assert.ok(comms[0].payload.text.includes('Out of capture tools'),
      `expected critical text, got "${comms[0].payload.text}"`);
    panel.dispose();
  });
});

// ─── COOLDOWN ─────────────────────────────────────────────────────────────

describe('NetInventoryPanel — cooldown prevents spam', () => {
  it('second emit within LOW_HINT_COOLDOWN_MS is suppressed', () => {
    const eb     = makeMockBus();
    const am     = makeArmManager([2, 2]);
    const lasso  = makeLasso(20);
    const container = globalThis.document.createElement('div');
    let clock = 1000;
    const panel = new NetInventoryPanel(container, {
      eventBus: eb, armManager: am, lassoSystem: lasso, now: () => clock,
    });
    eb._reset();

    // First crossing — should emit.
    eb.emit(Events.LASSO_AMMO_CHANGED, { remaining: 5, max: 50 });
    assert.equal(eb._findEmits(Events.INVENTORY_LOW).length, 1, 'first emit');

    // Recover above threshold then re-cross within cooldown — suppressed.
    // We manually reset severity to ok to simulate a recovery + re-cross.
    panel._lasso_state.severity = 'ok';
    clock += 10000; // 10s elapsed — still inside 60s cooldown
    eb.emit(Events.LASSO_AMMO_CHANGED, { remaining: 4, max: 50 });
    assert.equal(eb._findEmits(Events.INVENTORY_LOW).length, 1,
      'second emit suppressed by cooldown');

    // After cooldown expires — emit again allowed.
    panel._lasso_state.severity = 'ok';
    clock += 60000; // cooldown elapsed
    eb.emit(Events.LASSO_AMMO_CHANGED, { remaining: 3, max: 50 });
    assert.equal(eb._findEmits(Events.INVENTORY_LOW).length, 2,
      'third emit allowed after cooldown');

    panel.dispose();
  });

  it('recovery (low → ok) does NOT emit INVENTORY_LOW', () => {
    const eb     = makeMockBus();
    const am     = makeArmManager([2, 2]);
    const lasso  = makeLasso(3);  // already below low threshold
    const container = globalThis.document.createElement('div');
    const panel = new NetInventoryPanel(container, {
      eventBus: eb, armManager: am, lassoSystem: lasso, now: () => 1000,
    });
    eb._reset();
    // Lasso refilled → goes from low → ok. No emit expected.
    eb.emit(Events.LASSO_AMMO_CHANGED, { remaining: 50, max: 50 });
    assert.equal(eb._findEmits(Events.INVENTORY_LOW).length, 0,
      'recovery does not emit INVENTORY_LOW');
    panel.dispose();
  });
});

// ─── NET INVENTORY EVENT ───────────────────────────────────────────────────

describe('NetInventoryPanel — net inventory change handling', () => {
  it('updates total + breakdown on NET_INVENTORY_CHANGED', () => {
    const eb     = makeMockBus();
    const arms   = makeArmManager([2, 2]);   // initial 4/4
    const lasso  = makeLasso(20);
    const container = globalThis.document.createElement('div');
    const panel = new NetInventoryPanel(container, {
      eventBus: eb, armManager: arms, lassoSystem: lasso, now: () => 1000,
    });
    eb._reset();
    // Mutate underlying inventory + emit a change signal.
    arms.arms[0]._netInventory = 1;
    arms.arms[1]._netInventory = 0;
    eb.emit(Events.NET_INVENTORY_CHANGED, { source: 'daughter' });
    const s = panel.getState();
    assert.equal(s.nets.total, 1);
    assert.deepEqual(s.nets.perArm, [1, 0]);
    panel.dispose();
  });
});
