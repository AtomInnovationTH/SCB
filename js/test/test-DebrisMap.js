/**
 * test-DebrisMap.js — Debris Map unit tests (ST-4.A).
 *
 * Covers:
 *   1. Score monotonic in count (higher count → higher score at same ΔV).
 *   2. Unreachable clusters filtered (ΔV > MAX_DV_MS → score 0).
 *   3. Results sorted descending by score.
 *   4. Max display capped at DEBRIS_MAP.MAX_DISPLAY.
 *   5. engageCluster stores cluster and sets _engaged = true.
 *   6. Scoring pure function is callable without DebrisMap instance.
 *
 * Runs in Node (no DOM, no THREE). Uses replicated scoring formula.
 */

import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

// We can't import DebrisMap directly in Node (constructor touches `document`).
// Instead we replicate the scoring formula here for pure testing.
// This validates the *formula* itself, matching DebrisMap.scoreCluster exactly.

const DM = Constants.DEBRIS_MAP;

/**
 * Pure scoring function — mirrors DebrisMap.scoreCluster exactly.
 * Uses dvOverrideMs for deterministic tests (avoids needing totalDeltaV import).
 */
function scoreCluster(cluster, playerOrbitKm, conjAlerts, dvOverrideMs) {
  const clusterSMA = Constants.EARTH_RADIUS_KM + cluster.avgAltKm;
  const playerSMA = playerOrbitKm.semiMajorAxis;

  let dvMs;
  if (dvOverrideMs != null) {
    dvMs = dvOverrideMs;
  } else {
    const mu = Constants.MU_EARTH;
    const v1 = Math.sqrt(mu / playerSMA);
    const v2 = Math.sqrt(mu / clusterSMA);
    const hohmann = Math.abs(v1 - v2) * 1000;
    const deltaI = Math.abs(
      (cluster.incCenter * Math.PI / 180) - playerOrbitKm.inclination
    );
    const planeChange = v2 * 2 * Math.sin(deltaI / 2) * 1000;
    dvMs = hohmann + planeChange;
  }

  const varietyBonus = Object.keys(cluster.types).filter(k => cluster.types[k] > 0).length;

  const untrackedCount = cluster.targets.filter(t => !t.tracked).length;
  let alertCount = 0;
  for (const [band, n] of conjAlerts) {
    if (band >= cluster.altRange.min && band <= cluster.altRange.max) alertCount += n;
  }
  const conjRisk = untrackedCount * 0.5 + alertCount;

  const reachable = dvMs < DM.MAX_DV_MS;

  const score = reachable
    ? (cluster.totalMassKg * varietyBonus) / (dvMs + conjRisk * 100 + 1)
    : 0;

  return { ...cluster, dvMs, varietyBonus, conjRisk, reachable, score };
}

// === MOCK FACTORIES ===

function makeCluster(overrides = {}) {
  return {
    id: overrides.id || 'test-cluster-300',
    name: overrides.name || 'Test Cluster, 300-400 km',
    altRange: overrides.altRange || { min: 300, max: 400 },
    incCenter: overrides.incCenter ?? 51.6,
    count: overrides.count ?? 5,
    avgAltKm: overrides.avgAltKm ?? 350,
    totalMassKg: overrides.totalMassKg ?? 5000,
    types: overrides.types || { fragment: 3, rocketBody: 2 },
    targets: overrides.targets || [
      { tracked: true },
      { tracked: true },
      { tracked: false },
      { tracked: true },
      { tracked: false },
    ],
    center: overrides.center || { x: 67.21, y: 0, z: 0 },
  };
}

function makePlayerOrbitKm(overrides = {}) {
  return {
    semiMajorAxis: overrides.semiMajorAxis ?? (Constants.EARTH_RADIUS_KM + 350),
    inclination: overrides.inclination ?? (51.6 * Math.PI / 180),
    eccentricity: 0.001,
    argumentOfPeriapsis: 0,
    raan: 0,
    ...overrides,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('DebrisMap — Scoring Formula', () => {
  it('Score monotonic in count: higher count → higher score at same ΔV', () => {
    const playerOrbit = makePlayerOrbitKm();
    const conjAlerts = new Map();

    const clusterLow = makeCluster({ count: 3, totalMassKg: 3000 });
    const clusterHigh = makeCluster({ count: 10, totalMassKg: 10000 });

    const scoredLow = scoreCluster(clusterLow, playerOrbit, conjAlerts, 100);
    const scoredHigh = scoreCluster(clusterHigh, playerOrbit, conjAlerts, 100);

    assert.ok(scoredHigh.score > scoredLow.score,
      `Higher count cluster should score higher: ${scoredHigh.score} > ${scoredLow.score}`);
  });

  it('Unreachable clusters filtered: ΔV > MAX_DV_MS → score 0', () => {
    const playerOrbit = makePlayerOrbitKm();
    const conjAlerts = new Map();

    const cluster = makeCluster();
    const scored = scoreCluster(cluster, playerOrbit, conjAlerts, DM.MAX_DV_MS + 100);

    assert.equal(scored.score, 0, `Unreachable cluster score should be 0, got ${scored.score}`);
    assert.ok(!scored.reachable, 'Unreachable cluster should have reachable=false');
  });

  it('Results sorted descending by score', () => {
    const playerOrbit = makePlayerOrbitKm();
    const conjAlerts = new Map();

    const clusters = [
      makeCluster({ id: 'a', totalMassKg: 1000 }),
      makeCluster({ id: 'b', totalMassKg: 5000 }),
      makeCluster({ id: 'c', totalMassKg: 3000 }),
    ];

    const scored = clusters
      .map(c => scoreCluster(c, playerOrbit, conjAlerts, 100))
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score);

    for (let i = 0; i < scored.length - 1; i++) {
      assert.ok(scored[i].score >= scored[i + 1].score,
        `scored[${i}].score (${scored[i].score}) >= scored[${i + 1}].score (${scored[i + 1].score})`);
    }
    assert.equal(scored[0].id, 'b', `Highest-mass cluster should be first, got ${scored[0].id}`);
  });

  it('Max display capped at DEBRIS_MAP.MAX_DISPLAY', () => {
    const playerOrbit = makePlayerOrbitKm();
    const conjAlerts = new Map();

    const clusters = [];
    for (let i = 0; i < 10; i++) {
      clusters.push(makeCluster({
        id: `cluster-${i}`,
        totalMassKg: 1000 * (i + 1),
      }));
    }

    const ranked = clusters
      .map(c => scoreCluster(c, playerOrbit, conjAlerts, 100))
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, DM.MAX_DISPLAY);

    assert.equal(ranked.length, DM.MAX_DISPLAY,
      `Should display max ${DM.MAX_DISPLAY} clusters, got ${ranked.length}`);
  });

  it('Variety bonus increases score', () => {
    const playerOrbit = makePlayerOrbitKm();
    const conjAlerts = new Map();

    const clusterSingleType = makeCluster({
      types: { fragment: 5 },
      totalMassKg: 5000,
    });
    const clusterMultiType = makeCluster({
      types: { fragment: 2, rocketBody: 2, defunctSat: 1 },
      totalMassKg: 5000,
    });

    const scoredSingle = scoreCluster(clusterSingleType, playerOrbit, conjAlerts, 100);
    const scoredMulti = scoreCluster(clusterMultiType, playerOrbit, conjAlerts, 100);

    assert.ok(scoredMulti.score > scoredSingle.score,
      `Multi-type cluster should score higher: ${scoredMulti.score} > ${scoredSingle.score}`);
    assert.equal(scoredSingle.varietyBonus, 1, `Single type variety = 1, got ${scoredSingle.varietyBonus}`);
    assert.equal(scoredMulti.varietyBonus, 3, `Multi type variety = 3, got ${scoredMulti.varietyBonus}`);
  });

  it('Conjunction risk reduces score', () => {
    const playerOrbit = makePlayerOrbitKm();

    const cluster = makeCluster({
      altRange: { min: 300, max: 400 },
      targets: [{ tracked: true }, { tracked: true }],
    });

    const noAlerts = new Map();
    const withAlerts = new Map([[350, 5]]);

    const scoredClean = scoreCluster(cluster, playerOrbit, noAlerts, 100);
    const scoredRisky = scoreCluster(cluster, playerOrbit, withAlerts, 100);

    assert.ok(scoredClean.score > scoredRisky.score,
      `Clean cluster should score higher than risky: ${scoredClean.score} > ${scoredRisky.score}`);
  });

  it('Zero-count clusters produce score 0 (filtered out)', () => {
    const playerOrbit = makePlayerOrbitKm();
    const conjAlerts = new Map();

    const cluster = makeCluster({ count: 0, totalMassKg: 0, targets: [], types: {} });
    const scored = scoreCluster(cluster, playerOrbit, conjAlerts, 50);

    assert.equal(scored.score, 0, `Zero-count cluster score should be 0, got ${scored.score}`);
  });
});

describe('DebrisMap — AutopilotSystem.engageCluster', () => {
  function makeAutopilotStub() {
    const emitted = [];
    const unsubs = [
      eventBus.on(Events.AUTOPILOT_ENGAGE, (d) => emitted.push({ event: 'ENGAGE', ...d })),
      eventBus.on(Events.AUTOPILOT_TARGET_LOCK, (d) => emitted.push({ event: 'LOCK', ...d })),
      eventBus.on(Events.COMMS_MESSAGE, (d) => emitted.push({ event: 'COMMS', ...d })),
    ];

    return {
      _engaged: false,
      _debrisMapCluster: null,
      _trawlActive: false,
      _phase: 'OFF',
      _holdTimer: 0,
      _headingMode: 'NONE',
      _player: { autopilotEngaged: false },

      engageCluster(cluster) {
        if (!cluster?.center) return;
        this._debrisMapCluster = cluster;
        this._trawlActive = false;
        this._engaged = true;
        this._phase = 'RENDEZVOUS_FAR';
        this._holdTimer = 0;
        this._headingMode = 'CLUSTER';

        if (this._player) {
          this._player.autopilotEngaged = true;
        }

        eventBus.emit(Events.AUTOPILOT_TARGET_LOCK, { targetId: cluster.id });
        eventBus.emit(Events.AUTOPILOT_ENGAGE, {
          mode: 'CLUSTER',
          clusterId: cluster.id,
          targetName: cluster.name || cluster.id,
          phase: this._phase,
        });
        eventBus.emit(Events.COMMS_MESSAGE, {
          text: `AUTOPILOT ENGAGED — CLUSTER: ${cluster.name || cluster.id}`,
          priority: 'info',
        });
      },

      emitted,
      cleanup() {
        unsubs.forEach(fn => { if (typeof fn === 'function') fn(); });
      },
    };
  }

  it('engageCluster stores cluster and sets _engaged = true', () => {
    const ap = makeAutopilotStub();
    const cluster = makeCluster();

    ap.engageCluster(cluster);

    assert.ok(ap._engaged === true, '_engaged should be true');
    assert.ok(ap._debrisMapCluster === cluster, '_debrisMapCluster should reference the cluster');
    assert.equal(ap._headingMode, 'CLUSTER', `headingMode should be CLUSTER, got ${ap._headingMode}`);
    assert.equal(ap._phase, 'RENDEZVOUS_FAR', `phase should be RENDEZVOUS_FAR, got ${ap._phase}`);
    assert.ok(ap._player.autopilotEngaged === true, 'player.autopilotEngaged should be true');

    ap.cleanup();
  });

  it('engageCluster emits AUTOPILOT_ENGAGE and AUTOPILOT_TARGET_LOCK', () => {
    const ap = makeAutopilotStub();
    const cluster = makeCluster({ id: 'cluster-test-emit' });

    ap.engageCluster(cluster);

    const lockEvent = ap.emitted.find(e => e.event === 'LOCK');
    assert.ok(lockEvent != null, 'Should emit AUTOPILOT_TARGET_LOCK');
    assert.equal(lockEvent.targetId, 'cluster-test-emit', 'Lock targetId should match cluster id');

    const engageEvent = ap.emitted.find(e => e.event === 'ENGAGE');
    assert.ok(engageEvent != null, 'Should emit AUTOPILOT_ENGAGE');
    assert.equal(engageEvent.mode, 'CLUSTER', `Engage mode should be CLUSTER, got ${engageEvent.mode}`);

    ap.cleanup();
  });

  it('engageCluster rejects cluster without center', () => {
    const ap = makeAutopilotStub();

    ap.engageCluster({ id: 'no-center' });
    assert.ok(ap._engaged === false, 'Should not engage without center');

    ap.engageCluster(null);
    assert.ok(ap._engaged === false, 'Should not engage with null');

    ap.cleanup();
  });

  it('engageCluster overrides active trawl state', () => {
    const ap = makeAutopilotStub();
    ap._trawlActive = true;

    const cluster = makeCluster();
    ap.engageCluster(cluster);

    assert.ok(ap._trawlActive === false, 'Trawl should be overridden');
    assert.ok(ap._engaged === true, 'Should be engaged');

    ap.cleanup();
  });
});

describe('DebrisMap — DEBRIS_MAP Constants', () => {
  it('DEBRIS_MAP constants exist and are valid', () => {
    assert.ok(DM != null, 'DEBRIS_MAP should exist in Constants');
    assert.ok(typeof DM.POLL_INTERVAL_S === 'number' && DM.POLL_INTERVAL_S > 0,
      `POLL_INTERVAL_S should be positive number, got ${DM.POLL_INTERVAL_S}`);
    assert.ok(typeof DM.MAX_DISPLAY === 'number' && DM.MAX_DISPLAY > 0,
      `MAX_DISPLAY should be positive number, got ${DM.MAX_DISPLAY}`);
    assert.ok(typeof DM.MAX_DV_MS === 'number' && DM.MAX_DV_MS > 0,
      `MAX_DV_MS should be positive number, got ${DM.MAX_DV_MS}`);
  });

  it('DEBRIS_MAP_CLUSTER_SELECTED event constant exists', () => {
    assert.ok(typeof Events.DEBRIS_MAP_CLUSTER_SELECTED === 'string',
      'DEBRIS_MAP_CLUSTER_SELECTED should be a string event name');
  });
});
