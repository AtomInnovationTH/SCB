/**
 * test-TrawlManager.js — UX-11 #4 trawl-sweep robustness.
 *
 * Covers:
 *   1. Auto-complete watchdog: a sweep whose cluster has no live members ends
 *      itself and emits TRAWL_SWEEP_COMPLETE (so the autopilot trawl-block clears).
 *   2. TRAWL_ABORT: external abort request ends the sweep + emits completion.
 *   3. Abort with no active sweep is a no-op.
 *
 * Node-only: TrawlManager has no THREE/DOM dependencies.
 */

import { describe, it, assert } from './TestRunner.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { TrawlManager } from '../systems/TrawlManager.js';

function makeCluster(targets) {
  return {
    id: 'test-cluster',
    name: 'Test Cluster',
    count: targets.length,
    targets,
    center: { x: 67.21, y: 0, z: 0 },
  };
}

function track(name) {
  const log = [];
  eventBus.on(name, (data) => log.push(data));
  return log;
}

describe('TrawlManager — sweep auto-complete + abort (UX-11 #4)', () => {

  it('update() auto-completes the sweep when the cluster has no live members', () => {
    eventBus.clear();
    const tm = new TrawlManager();
    const completeLog = track(Events.TRAWL_SWEEP_COMPLETE);
    const endLog = track(Events.TRAWL_END);

    tm.startTrawl(makeCluster([{ id: 1, alive: false }, { id: 2, alive: false }]), null);
    assert.equal(tm.active, true, 'sanity: sweep started');

    tm.update(0.1, {});

    assert.equal(tm.active, false, 'sweep must auto-end with no live targets');
    assert.equal(completeLog.length, 1, 'TRAWL_SWEEP_COMPLETE must fire');
    assert.equal(endLog.length, 1, 'TRAWL_END must fire');
    eventBus.clear();
  });

  it('update() keeps the sweep alive while any cluster member is alive', () => {
    eventBus.clear();
    const tm = new TrawlManager();
    const completeLog = track(Events.TRAWL_SWEEP_COMPLETE);

    tm.startTrawl(makeCluster([{ id: 1, alive: false }, { id: 2, alive: true }]), null);
    tm.update(0.1, {});

    assert.equal(tm.active, true, 'sweep must stay active with a live target');
    assert.equal(completeLog.length, 0, 'no premature completion');
    eventBus.clear();
  });

  it('TRAWL_ABORT ends an active sweep and emits TRAWL_SWEEP_COMPLETE', () => {
    eventBus.clear();
    const tm = new TrawlManager();
    const completeLog = track(Events.TRAWL_SWEEP_COMPLETE);

    tm.startTrawl(makeCluster([{ id: 1, alive: true }]), null);
    eventBus.emit(Events.TRAWL_ABORT, { reason: 'AUTOPILOT_OVERRIDE' });

    assert.equal(tm.active, false, 'abort must end the sweep');
    assert.equal(completeLog.length, 1, 'abort must emit TRAWL_SWEEP_COMPLETE');
    eventBus.clear();
  });

  it('TRAWL_ABORT with no active sweep is a no-op', () => {
    eventBus.clear();
    const tm = new TrawlManager();
    const completeLog = track(Events.TRAWL_SWEEP_COMPLETE);
    eventBus.emit(Events.TRAWL_ABORT, { reason: 'AUTOPILOT_OVERRIDE' });
    assert.equal(tm.active, false);
    assert.equal(completeLog.length, 0, 'no completion event without an active sweep');
    eventBus.clear();
  });
});
