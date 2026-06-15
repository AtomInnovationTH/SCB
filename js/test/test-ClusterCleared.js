/**
 * test-ClusterCleared.js — defer-trawl: CLUSTER_CLEARED fires when the last
 * alive member of an orbital cluster bucket is removed via active capture /
 * deorbit (replaces the trawl-only TRAWL_SWEEP_COMPLETE in the core loop).
 *
 * Also covers the RewardSystem re-anchor: field-progress thresholds + the
 * 100 % bonus + the star ceremony fire from active captures with NO trawl
 * active.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { DebrisField } from '../entities/DebrisField.js';
import { RewardSystem } from '../systems/RewardSystem.js';

/** Build a debris in a known cluster bucket. ISS band, LEO-low (400-600 km). */
function issDebris(id, altKm = 500, alive = true) {
  return {
    id,
    type: 'fragment',
    alive,
    sizeMeter: 0.5,
    orbit: {
      semiMajorAxis: Constants.EARTH_RADIUS + altKm * Constants.SCENE_SCALE,
      inclination: (51.6 * Math.PI) / 180,
    },
  };
}

/** Minimal field stub good enough for removeDebris + cluster detection. */
function makeFieldStub(debris) {
  const debrisMap = new Map(debris.map(d => [d.id, d]));
  return {
    debrisMap,
    debrisList: debris,
    _instanceLookup: new Map(),
    _tempMatrix: new THREE.Matrix4(),
    instancedMeshes: {},
    // removeDebris calls these sibling prototype methods via `this`.
    _clusterIdOf: DebrisField.prototype._clusterIdOf,
    _maybeEmitClusterCleared: DebrisField.prototype._maybeEmitClusterCleared,
  };
}

function track(name) {
  const log = [];
  eventBus.on(name, (d) => log.push(d));
  return log;
}

describe('DebrisField.removeDebris — CLUSTER_CLEARED (defer-trawl)', () => {

  it('emits CLUSTER_CLEARED only when the LAST alive bucket member is removed', () => {
    eventBus.clear();
    const a = issDebris(1);
    const b = issDebris(2);
    const field = makeFieldStub([a, b]);
    const cleared = track(Events.CLUSTER_CLEARED);

    // First removal: bucket still has one alive member → no event.
    DebrisField.prototype.removeDebris.call(field, 1);
    assert.equal(cleared.length, 0, 'no CLUSTER_CLEARED while a member is alive');

    // Second removal empties the bucket → fire once.
    DebrisField.prototype.removeDebris.call(field, 2);
    assert.equal(cleared.length, 1, 'CLUSTER_CLEARED fires when bucket empties');
    assert.equal(cleared[0].clusterId, 'iss-400', 'carries the bucket id');
    assert.equal(cleared[0].count, 2, 'count = total bucket members');
    assert.ok(typeof cleared[0].name === 'string' && cleared[0].name.length > 0, 'human name');
    eventBus.clear();
  });

  it('does not double-emit when a second removal path hits an already-dead member', () => {
    eventBus.clear();
    const a = issDebris(1);
    const field = makeFieldStub([a]);
    const cleared = track(Events.CLUSTER_CLEARED);

    const first = DebrisField.prototype.removeDebris.call(field, 1);
    assert.equal(first, true, 'first removal succeeds');
    // A second removal path (e.g. ARM_DEORBIT after CATCH_PROCESSED) hits the
    // same id — removeDebris early-returns on !alive, so no re-announce.
    const second = DebrisField.prototype.removeDebris.call(field, 1);
    assert.equal(second, false, 'second removal is a no-op');
    assert.equal(cleared.length, 1, 'only one CLUSTER_CLEARED for the bucket');
    eventBus.clear();
  });

  it('re-arms a bucket if it is re-populated after a clear', () => {
    eventBus.clear();
    const a = issDebris(1);
    const field = makeFieldStub([a]);
    const cleared = track(Events.CLUSTER_CLEARED);

    DebrisField.prototype.removeDebris.call(field, 1);
    assert.equal(cleared.length, 1, 'first clear announced');

    // Kessler re-populates the same band.
    const b = issDebris(2);
    field.debrisList.push(b);
    field.debrisMap.set(2, b);
    DebrisField.prototype.removeDebris.call(field, 2);
    assert.equal(cleared.length, 2, 're-populated bucket announces again on re-clear');
    eventBus.clear();
  });
});

describe('RewardSystem — field progress re-anchored to active captures', () => {

  it('CLUSTER_CLEARED fires the 100% bonus + SWEEP_REPORT with NO trawl active', () => {
    eventBus.clear();
    const rs = new RewardSystem();
    const awards = track(Events.SCORING_AWARD);
    const reports = track(Events.SWEEP_REPORT);

    // Seed the engaged cluster from the Debris Map (real size = 4).
    eventBus.emit(Events.DEBRIS_MAP_CLUSTER_SELECTED, {
      clusterId: 'iss-400', name: 'ISS Band, 400-600 km', count: 4,
    });

    // Player hand-captures all 4 (no trawl).
    for (let i = 0; i < 4; i++) eventBus.emit(Events.ARM_CAPTURED, { armId: i });

    // Cluster empties → ceremony anchor.
    eventBus.emit(Events.CLUSTER_CLEARED, {
      clusterId: 'iss-400', name: 'ISS Band, 400-600 km', count: 4,
    });

    const perfect = awards.find(a => a && /Perfect Sweep/i.test(a.reason || ''));
    assert.ok(perfect, 'Perfect Sweep (100%) bonus awarded from active captures');
    assert.equal(reports.length, 1, 'a SWEEP_REPORT ceremony fired');
    assert.equal(reports[0].title, 'CLUSTER CLEARED', 'core-loop report titled CLUSTER CLEARED');
    assert.equal(reports[0].clearPercentage, 100, '100% cleared');
    eventBus.clear();
  });

  it('backfills a full clear even when the Debris Map was never opened', () => {
    eventBus.clear();
    const rs = new RewardSystem();
    const reports = track(Events.SWEEP_REPORT);
    const awards = track(Events.SCORING_AWARD);

    // No DEBRIS_MAP_CLUSTER_SELECTED — _fieldTotal starts at 0.
    eventBus.emit(Events.CLUSTER_CLEARED, {
      clusterId: 'sso-600', name: 'SSO Band, 600-900 km', count: 3,
    });

    assert.equal(reports.length, 1, 'ceremony still fires');
    assert.equal(reports[0].clearPercentage, 100, 'backfilled to a full clear');
    assert.ok(awards.some(a => /Perfect Sweep/i.test(a.reason || '')), 'perfect bonus backfilled');
    eventBus.clear();
  });

  it('reports each cluster independently across a multi-cluster session (no >100%)', () => {
    eventBus.clear();
    const rs = new RewardSystem();
    const reports = track(Events.SWEEP_REPORT);

    // Cluster A: 3 captures, then cleared.
    eventBus.emit(Events.DEBRIS_MAP_CLUSTER_SELECTED, { clusterId: 'iss-400', name: 'A', count: 3 });
    for (let i = 0; i < 3; i++) eventBus.emit(Events.ARM_CAPTURED, { armId: i });
    eventBus.emit(Events.CLUSTER_CLEARED, { clusterId: 'iss-400', name: 'A', count: 3 });

    // Cluster B: 2 captures, then cleared. Without resetting capture counters
    // per cluster, _trawlCatches would carry A's 3 forward and B would report
    // (3+2)/2 = 250%.
    eventBus.emit(Events.DEBRIS_MAP_CLUSTER_SELECTED, { clusterId: 'sso-600', name: 'B', count: 2 });
    for (let i = 0; i < 2; i++) eventBus.emit(Events.ARM_CAPTURED, { armId: i });
    eventBus.emit(Events.CLUSTER_CLEARED, { clusterId: 'sso-600', name: 'B', count: 2 });

    assert.equal(reports.length, 2, 'one ceremony per cluster');
    assert.equal(reports[0].clearPercentage, 100, 'cluster A reads 100%');
    assert.equal(reports[1].clearPercentage, 100, 'cluster B reads 100% (not 250%)');
    assert.equal(reports[1].totalCaptured, 2, 'cluster B captured count is per-cluster');
    eventBus.clear();
  });

  it('a background clear of a DIFFERENT cluster does not fire a spurious ceremony', () => {
    eventBus.clear();
    const rs = new RewardSystem();
    const reports = track(Events.SWEEP_REPORT);

    // Engaged on A with progress.
    eventBus.emit(Events.DEBRIS_MAP_CLUSTER_SELECTED, { clusterId: 'iss-400', name: 'A', count: 5 });
    for (let i = 0; i < 2; i++) eventBus.emit(Events.ARM_CAPTURED, { armId: i });

    // A stray deorbit empties an unrelated cluster B in the background.
    eventBus.emit(Events.CLUSTER_CLEARED, { clusterId: 'russian65-900', name: 'B', count: 1 });
    assert.equal(reports.length, 0, 'no ceremony for a non-engaged cluster');

    // Finishing A still fires correctly with A's own counts.
    for (let i = 2; i < 5; i++) eventBus.emit(Events.ARM_CAPTURED, { armId: i });
    eventBus.emit(Events.CLUSTER_CLEARED, { clusterId: 'iss-400', name: 'A', count: 5 });
    assert.equal(reports.length, 1, 'engaged cluster A fires its ceremony');
    assert.equal(reports[0].clearPercentage, 100, 'A reads 100%');
    eventBus.clear();
  });
});
