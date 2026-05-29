/**
 * test-NetCeremonyEvents.js — Q2 Stage 1: Net Ceremony Event Emission
 *
 * Verifies that NetProjectile emits the 6 ceremony events
 * (CEREMONY_REDESIGN.md §5.2) from existing FSM transitions,
 * gated behind FEATURE_FLAGS.NET_CEREMONY.
 */

import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { NetProjectile } from '../entities/CaptureNet.js';

const CN = Constants.CAPTURE_NET;
const STATES = CN.STATES;
const MODES = CN.MODES;

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create a net config with a reachable target (default: cinch mode) */
function makeCeremonyConfig(overrides = {}) {
  return {
    netClass: CN.MEDIUM,
    armIndex: 0,
    podIndex: -1,
    launchPosition: { x: 0, y: 0, z: 0 },
    launchDirection: { x: 1, y: 0, z: 0 },
    targetDebris: {
      position: { x: 20, y: 0, z: 0 },
      mass: 100,
      id: 'debris-ceremony-1',
      surfaceRoughness: 1.0,
      fragility: 0.05,
    },
    captureMode: MODES.CINCH,
    ...overrides,
  };
}

/** Advance a net's state machine by totalTime in small steps */
function advanceNet(net, totalTime, dt = 0.05) {
  let elapsed = 0;
  while (elapsed < totalTime) {
    const step = Math.min(dt, totalTime - elapsed);
    net.update(step);
    elapsed += step;
  }
}

/** Subscribe to all 6 ceremony events; returns { counts, payloads, order, unsub } */
function subscribeCeremonyEvents() {
  const counts = {};
  const payloads = {};
  const order = [];
  const handlers = {};

  const eventNames = [
    'NET_CEREMONY_START',
    'NET_BRAKE_IMMINENT',
    'NET_BRAKE_FIRED',
    'NET_ENVELOP_PEAK',
    'NET_CINCH_PROGRESS',
    'NET_CEREMONY_COMPLETE',
  ];

  for (const name of eventNames) {
    counts[name] = 0;
    payloads[name] = [];
    handlers[name] = (data) => {
      counts[name]++;
      payloads[name].push(data);
      order.push(name);
    };
    eventBus.on(Events[name], handlers[name]);
  }

  function unsub() {
    for (const name of eventNames) {
      eventBus.off(Events[name], handlers[name]);
    }
  }

  return { counts, payloads, order, unsub };
}


// ══════════════════════════════════════════════════════════════════════════
// FLAG OFF — ZERO EMISSIONS
// ══════════════════════════════════════════════════════════════════════════

describe('NetCeremonyEvents — flag OFF → zero emissions', () => {
  it('cinch path emits no ceremony events when NET_CEREMONY is false', () => {
    const saved = Constants.FEATURE_FLAGS.NET_CEREMONY;
    Constants.FEATURE_FLAGS.NET_CEREMONY = false;
    try {
      const { counts, unsub } = subscribeCeremonyEvents();
      const net = new NetProjectile(makeCeremonyConfig());
      advanceNet(net, 10, 0.05);
      if (net.isActive) net.forceResolve(true);

      for (const [name, count] of Object.entries(counts)) {
        assert.equal(count, 0, `${name} should not fire when flag OFF, got ${count}`);
      }
      unsub();
    } finally {
      Constants.FEATURE_FLAGS.NET_CEREMONY = saved;
    }
  });

  it('slam-wrap path emits no ceremony events when NET_CEREMONY is false', () => {
    const saved = Constants.FEATURE_FLAGS.NET_CEREMONY;
    Constants.FEATURE_FLAGS.NET_CEREMONY = false;
    try {
      const { counts, unsub } = subscribeCeremonyEvents();
      const net = new NetProjectile(makeCeremonyConfig({ captureMode: MODES.SLAM_WRAP }));
      advanceNet(net, 10, 0.05);
      if (net.isActive) net.forceResolve(true);

      for (const [name, count] of Object.entries(counts)) {
        assert.equal(count, 0, `${name} should not fire when flag OFF, got ${count}`);
      }
      unsub();
    } finally {
      Constants.FEATURE_FLAGS.NET_CEREMONY = saved;
    }
  });
});


// ══════════════════════════════════════════════════════════════════════════
// FLAG ON — ONE-SHOT EVENTS FIRE EXACTLY ONCE (cinch path)
// ══════════════════════════════════════════════════════════════════════════

describe('NetCeremonyEvents — flag ON, cinch path', () => {
  it('each one-shot event fires exactly once', () => {
    const saved = Constants.FEATURE_FLAGS.NET_CEREMONY;
    Constants.FEATURE_FLAGS.NET_CEREMONY = true;
    const origRandom = Math.random;
    Math.random = () => 0; // force success (roll=0 ≤ probability)
    try {
      const { counts, unsub } = subscribeCeremonyEvents();
      const net = new NetProjectile(makeCeremonyConfig());
      advanceNet(net, 10, 0.05);

      assert.equal(counts.NET_CEREMONY_START, 1, 'START fires once');
      assert.equal(counts.NET_BRAKE_IMMINENT, 1, 'BRAKE_IMMINENT fires once');
      assert.equal(counts.NET_BRAKE_FIRED, 1, 'BRAKE_FIRED fires once');
      assert.equal(counts.NET_ENVELOP_PEAK, 1, 'ENVELOP_PEAK fires once');
      assert.ok(counts.NET_CINCH_PROGRESS >= 1, `CINCH_PROGRESS should fire ≥1, got ${counts.NET_CINCH_PROGRESS}`);
      assert.equal(counts.NET_CEREMONY_COMPLETE, 1, 'CEREMONY_COMPLETE fires once');

      unsub();
    } finally {
      Math.random = origRandom;
      Constants.FEATURE_FLAGS.NET_CEREMONY = saved;
    }
  });

  it('NET_CEREMONY_START payload has armIndex, podIndex, netClass', () => {
    const saved = Constants.FEATURE_FLAGS.NET_CEREMONY;
    Constants.FEATURE_FLAGS.NET_CEREMONY = true;
    try {
      const { payloads, unsub } = subscribeCeremonyEvents();
      const net = new NetProjectile(makeCeremonyConfig({ armIndex: 2, podIndex: -1 }));
      net.update(0.01); // first tick

      assert.equal(payloads.NET_CEREMONY_START.length, 1);
      const p = payloads.NET_CEREMONY_START[0];
      assert.equal(p.armIndex, 2);
      assert.equal(p.podIndex, -1);
      assert.equal(p.netClass, CN.MEDIUM.CODE);

      unsub();
    } finally {
      Constants.FEATURE_FLAGS.NET_CEREMONY = saved;
    }
  });

  it('NET_BRAKE_IMMINENT payload has tMinus: 0.3', () => {
    const saved = Constants.FEATURE_FLAGS.NET_CEREMONY;
    Constants.FEATURE_FLAGS.NET_CEREMONY = true;
    const origRandom = Math.random;
    Math.random = () => 0;
    try {
      const { payloads, unsub } = subscribeCeremonyEvents();
      const net = new NetProjectile(makeCeremonyConfig());
      advanceNet(net, 10, 0.05);

      assert.equal(payloads.NET_BRAKE_IMMINENT.length, 1);
      const p = payloads.NET_BRAKE_IMMINENT[0];
      assert.equal(p.tMinus, 0.3);
      assert.equal(p.armIndex, 0);

      unsub();
    } finally {
      Math.random = origRandom;
      Constants.FEATURE_FLAGS.NET_CEREMONY = saved;
    }
  });

  it('NET_BRAKE_FIRED payload has tetherTensionN', () => {
    const saved = Constants.FEATURE_FLAGS.NET_CEREMONY;
    Constants.FEATURE_FLAGS.NET_CEREMONY = true;
    const origRandom = Math.random;
    Math.random = () => 0;
    try {
      const { payloads, unsub } = subscribeCeremonyEvents();
      const net = new NetProjectile(makeCeremonyConfig());
      advanceNet(net, 10, 0.05);

      assert.equal(payloads.NET_BRAKE_FIRED.length, 1);
      const p = payloads.NET_BRAKE_FIRED[0];
      assert.equal(typeof p.tetherTensionN, 'number');

      unsub();
    } finally {
      Math.random = origRandom;
      Constants.FEATURE_FLAGS.NET_CEREMONY = saved;
    }
  });

  it('NET_CEREMONY_COMPLETE payload has mode and success', () => {
    const saved = Constants.FEATURE_FLAGS.NET_CEREMONY;
    Constants.FEATURE_FLAGS.NET_CEREMONY = true;
    const origRandom = Math.random;
    Math.random = () => 0;
    try {
      const { payloads, unsub } = subscribeCeremonyEvents();
      const net = new NetProjectile(makeCeremonyConfig());
      advanceNet(net, 10, 0.05);

      assert.equal(payloads.NET_CEREMONY_COMPLETE.length, 1);
      const p = payloads.NET_CEREMONY_COMPLETE[0];
      assert.equal(p.mode, MODES.CINCH);
      assert.equal(p.success, true);

      unsub();
    } finally {
      Math.random = origRandom;
      Constants.FEATURE_FLAGS.NET_CEREMONY = saved;
    }
  });
});


// ══════════════════════════════════════════════════════════════════════════
// FLAG ON — EVENT ORDER MATCHES DESIGN DOC §4 BEAT ORDER
// ══════════════════════════════════════════════════════════════════════════

describe('NetCeremonyEvents — event order (cinch path)', () => {
  it('events fire in beat-sheet order: START → BRAKE_IMMINENT → BRAKE_FIRED → ENVELOP_PEAK → CINCH_PROGRESS → CEREMONY_COMPLETE', () => {
    const saved = Constants.FEATURE_FLAGS.NET_CEREMONY;
    Constants.FEATURE_FLAGS.NET_CEREMONY = true;
    const origRandom = Math.random;
    Math.random = () => 0;
    try {
      const { order, unsub } = subscribeCeremonyEvents();
      const net = new NetProjectile(makeCeremonyConfig());
      advanceNet(net, 10, 0.05);

      // Filter to unique-first-occurrence order
      const seen = new Set();
      const uniqueOrder = [];
      for (const name of order) {
        if (!seen.has(name)) {
          seen.add(name);
          uniqueOrder.push(name);
        }
      }

      const expected = [
        'NET_CEREMONY_START',
        'NET_BRAKE_IMMINENT',
        'NET_BRAKE_FIRED',
        'NET_ENVELOP_PEAK',
        'NET_CINCH_PROGRESS',
        'NET_CEREMONY_COMPLETE',
      ];

      assert.equal(uniqueOrder.length, expected.length,
        `Expected ${expected.length} unique events, got ${uniqueOrder.length}: [${uniqueOrder}]`);
      for (let i = 0; i < expected.length; i++) {
        assert.equal(uniqueOrder[i], expected[i],
          `Event #${i}: expected ${expected[i]}, got ${uniqueOrder[i]}`);
      }

      unsub();
    } finally {
      Math.random = origRandom;
      Constants.FEATURE_FLAGS.NET_CEREMONY = saved;
    }
  });
});


// ══════════════════════════════════════════════════════════════════════════
// CINCH_PROGRESS PAYLOAD
// ══════════════════════════════════════════════════════════════════════════

describe('NetCeremonyEvents — CINCH_PROGRESS payload', () => {
  it('fraction is always in [0, 1]', () => {
    const saved = Constants.FEATURE_FLAGS.NET_CEREMONY;
    Constants.FEATURE_FLAGS.NET_CEREMONY = true;
    const origRandom = Math.random;
    Math.random = () => 0;
    try {
      const { payloads, unsub } = subscribeCeremonyEvents();
      const net = new NetProjectile(makeCeremonyConfig());
      advanceNet(net, 10, 0.05);

      assert.ok(payloads.NET_CINCH_PROGRESS.length >= 1,
        `Should have ≥1 CINCH_PROGRESS, got ${payloads.NET_CINCH_PROGRESS.length}`);
      for (const p of payloads.NET_CINCH_PROGRESS) {
        assert.ok(p.fraction >= 0 && p.fraction <= 1,
          `fraction ${p.fraction} out of range [0, 1]`);
        assert.equal(typeof p.armIndex, 'number');
        assert.equal(typeof p.podIndex, 'number');
      }

      unsub();
    } finally {
      Math.random = origRandom;
      Constants.FEATURE_FLAGS.NET_CEREMONY = saved;
    }
  });

  it('emits at discrete thresholds (bucket-throttled), not every frame', () => {
    const saved = Constants.FEATURE_FLAGS.NET_CEREMONY;
    Constants.FEATURE_FLAGS.NET_CEREMONY = true;
    const origRandom = Math.random;
    Math.random = () => 0;
    try {
      const { payloads, unsub } = subscribeCeremonyEvents();
      const net = new NetProjectile(makeCeremonyConfig());
      advanceNet(net, 10, 0.01); // very small dt → many ticks through CINCH_CLOSING

      // With 10 buckets and 2.0s CINCH_CLOSE_TIME at dt=0.01, there are ~200 ticks
      // but only ~11 distinct bucket transitions (0–10) should emit
      const progressCount = payloads.NET_CINCH_PROGRESS.length;
      assert.ok(progressCount >= 5 && progressCount <= 15,
        `Expected 5–15 bucket emissions, got ${progressCount}`);

      unsub();
    } finally {
      Math.random = origRandom;
      Constants.FEATURE_FLAGS.NET_CEREMONY = saved;
    }
  });
});


// ══════════════════════════════════════════════════════════════════════════
// IDEMPOTENCE OF ONE-SHOT EVENTS
// ══════════════════════════════════════════════════════════════════════════

describe('NetCeremonyEvents — idempotence', () => {
  it('re-calling forceResolve does not re-emit CEREMONY_COMPLETE', () => {
    const saved = Constants.FEATURE_FLAGS.NET_CEREMONY;
    Constants.FEATURE_FLAGS.NET_CEREMONY = true;
    try {
      const { counts, unsub } = subscribeCeremonyEvents();
      const net = new NetProjectile(makeCeremonyConfig());
      net.update(0.01); // trigger CEREMONY_START

      // Force resolve twice
      net.forceResolve(true);
      net.forceResolve(false);

      assert.equal(counts.NET_CEREMONY_COMPLETE, 1,
        'CEREMONY_COMPLETE should fire only once despite double forceResolve');

      unsub();
    } finally {
      Constants.FEATURE_FLAGS.NET_CEREMONY = saved;
    }
  });

  it('CEREMONY_START fires only on very first update, not on subsequent updates', () => {
    const saved = Constants.FEATURE_FLAGS.NET_CEREMONY;
    Constants.FEATURE_FLAGS.NET_CEREMONY = true;
    try {
      const { counts, unsub } = subscribeCeremonyEvents();
      const net = new NetProjectile(makeCeremonyConfig());

      net.update(0.01);
      net.update(0.01);
      net.update(0.01);

      assert.equal(counts.NET_CEREMONY_START, 1,
        'CEREMONY_START should fire only once');

      unsub();
    } finally {
      Constants.FEATURE_FLAGS.NET_CEREMONY = saved;
    }
  });

  it('re-entering BRAKE/ENVELOP states does not re-emit one-shot events', () => {
    const saved = Constants.FEATURE_FLAGS.NET_CEREMONY;
    Constants.FEATURE_FLAGS.NET_CEREMONY = true;
    const origRandom = Math.random;
    Math.random = () => 0;
    try {
      const { counts, unsub } = subscribeCeremonyEvents();
      const net = new NetProjectile(makeCeremonyConfig());

      // Drive through full cinch lifecycle
      advanceNet(net, 10, 0.05);

      assert.equal(counts.NET_BRAKE_FIRED, 1, 'BRAKE_FIRED fired once in first pass');
      assert.equal(counts.NET_ENVELOP_PEAK, 1, 'ENVELOP_PEAK fired once in first pass');
      assert.equal(counts.NET_CEREMONY_COMPLETE, 1, 'CEREMONY_COMPLETE fired once');

      // Artificially re-enter BRAKE state (poke the state machine)
      net.state = STATES.BRAKE;
      net.stateTimer = 0;
      net.isActive = true;
      advanceNet(net, 1, 0.05);

      assert.equal(counts.NET_BRAKE_FIRED, 1,
        'BRAKE_FIRED guard holds on state re-entry');

      // Artificially re-enter ENVELOP state
      net.state = STATES.ENVELOP;
      net.stateTimer = 0;
      advanceNet(net, 2, 0.05);

      assert.equal(counts.NET_ENVELOP_PEAK, 1,
        'ENVELOP_PEAK guard holds on state re-entry');

      unsub();
    } finally {
      Math.random = origRandom;
      Constants.FEATURE_FLAGS.NET_CEREMONY = saved;
    }
  });
});


// ══════════════════════════════════════════════════════════════════════════
// SLAM-WRAP PATH — only START + COMPLETE fire
// ══════════════════════════════════════════════════════════════════════════

describe('NetCeremonyEvents — slam-wrap path', () => {
  it('only START and COMPLETE fire (no brake/envelop/cinch events)', () => {
    const saved = Constants.FEATURE_FLAGS.NET_CEREMONY;
    Constants.FEATURE_FLAGS.NET_CEREMONY = true;
    const origRandom = Math.random;
    Math.random = () => 0;
    try {
      const { counts, unsub } = subscribeCeremonyEvents();
      const net = new NetProjectile(makeCeremonyConfig({ captureMode: MODES.SLAM_WRAP }));
      advanceNet(net, 10, 0.05);

      assert.equal(counts.NET_CEREMONY_START, 1, 'START fires once');
      assert.equal(counts.NET_BRAKE_IMMINENT, 0, 'BRAKE_IMMINENT should not fire for slam-wrap');
      assert.equal(counts.NET_BRAKE_FIRED, 0, 'BRAKE_FIRED should not fire for slam-wrap');
      assert.equal(counts.NET_ENVELOP_PEAK, 0, 'ENVELOP_PEAK should not fire for slam-wrap');
      assert.equal(counts.NET_CINCH_PROGRESS, 0, 'CINCH_PROGRESS should not fire for slam-wrap');
      assert.equal(counts.NET_CEREMONY_COMPLETE, 1, 'COMPLETE fires once');

      unsub();
    } finally {
      Math.random = origRandom;
      Constants.FEATURE_FLAGS.NET_CEREMONY = saved;
    }
  });
});
