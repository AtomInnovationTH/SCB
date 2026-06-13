/**
 * test-Fragmentation.js — wired fragmentation consequences
 * (capture-feedback overhaul Phase 3b).
 *
 * Coverage: severity tier selection (brittleness × vRel excess), the frag
 * roll at _resolveCatch (crack continues / breakup misses), mercy path,
 * credit penalty after mercy is spent.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import {
  NetProjectile,
  captureNetSystem,
  resolveFragSeverity,
  effectiveFragility,
  computeFragRisk,
  getNetClassForType,
} from '../entities/CaptureNet.js';
import { ArmUnit } from '../entities/ArmUnit.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';

const CN = Constants.CAPTURE_NET;

function makeNet(targetOver = {}, netOver = {}) {
  return new NetProjectile({
    netClass: CN.MEDIUM,
    armIndex: 0,
    launchPosition: { x: 0, y: 0, z: 0 },
    launchDirection: { x: 0, y: 1, z: 0 },
    targetDebris: {
      id: 'frag-target', mass: 100, sizeMeter: 2, brittleness: 0.5,
      surfaceRoughness: 1.0,
      ...targetOver,
    },
    captureMode: CN.MODES.SLAM_WRAP,
    ...netOver,
  });
}

function collect(names, fn) {
  const got = {};
  const offs = names.map(n => {
    got[n] = [];
    return eventBus.on(n, (d) => got[n].push(d));
  });
  try { fn(); } finally {
    for (const off of offs) { if (typeof off === 'function') off(); }
  }
  return got;
}

describe('Fragmentation — severity tiers (resolveFragSeverity)', () => {
  it('nominal speed + moderate brittleness → crack (capture continues)', () => {
    const s = resolveFragSeverity({ brittleness: 0.5, vRel: 10, vOptimal: 10 });
    assert.equal(s.tier, 'crack');
    assert.equal(s.destroyTarget, false);
    const [lo, hi] = Constants.FRAG_SEVERITY.CRACK_FRAGS;
    assert.ok(s.fragmentCount >= lo && s.fragmentCount <= hi);
  });

  it('very brittle at nominal speed → breakup', () => {
    const s = resolveFragSeverity({ brittleness: 0.95, vRel: 10, vOptimal: 10 });
    assert.equal(s.tier, 'breakup');
    assert.equal(s.destroyTarget, true);
  });

  it('brittle + hot approach → shatter with the big fragment band', () => {
    const s = resolveFragSeverity({ brittleness: 0.9, vRel: 20, vOptimal: 10, countRoll: 1 });
    assert.equal(s.tier, 'shatter');
    assert.equal(s.fragmentCount, Constants.FRAG_SEVERITY.SHATTER_FRAGS[1]);
  });

  it('severity is monotonic in vRel (go fast = legible gamble)', () => {
    const slow = resolveFragSeverity({ brittleness: 0.7, vRel: 8, vOptimal: 10 }).severity;
    const fast = resolveFragSeverity({ brittleness: 0.7, vRel: 16, vOptimal: 10 }).severity;
    assert.ok(fast > slow);
  });

  it('effectiveFragility: brittleness drives the base risk when fragility absent', () => {
    assert.ok(effectiveFragility({ brittleness: 1.0 }) > effectiveFragility({ brittleness: 0.2 }));
    assert.equal(effectiveFragility({ fragility: 0.42 }), 0.42, 'explicit fragility wins');
    assert.equal(effectiveFragility(null), 0.05);
  });
});

describe('Fragmentation — _resolveCatch roll wiring', () => {
  it('frag roll above the risk → no fragmentation events', () => {
    const net = makeNet();
    net._fragRollOverride = 0.999;   // never below risk
    const got = collect([Events.INTERACTION_FRAGMENTATION, Events.NET_FRAGMENTATION], () => {
      net._resolveCatch();
    });
    assert.equal(got[Events.INTERACTION_FRAGMENTATION].length, 0);
    assert.equal(got[Events.NET_FRAGMENTATION].length, 0);
  });

  it('crack: events fire, capture still resolves via the cling roll', () => {
    captureNetSystem.reset();
    const net = makeNet({ brittleness: 0.3 });
    net._fragRollOverride = 0;       // force the fragmentation roll
    net._fragCountRollOverride = 0;
    const got = collect([Events.INTERACTION_FRAGMENTATION, Events.NET_FRAGMENTATION], () => {
      net._resolveCatch();
    });
    assert.equal(got[Events.INTERACTION_FRAGMENTATION].length, 1);
    assert.equal(got[Events.INTERACTION_FRAGMENTATION][0].severity, 'crack');
    assert.equal(got[Events.INTERACTION_FRAGMENTATION][0].destroyTarget, false);
    assert.ok(net.catchResult === 'success' || net.catchResult === 'miss',
      'cling roll still happened after a crack');
  });

  it('breakup: target destroyed → deterministic fragmented miss', () => {
    captureNetSystem.reset();
    const net = makeNet({ brittleness: 0.95 });
    net._fragRollOverride = 0;
    const got = collect([Events.NET_CATCH_MISS, Events.INTERACTION_FRAGMENTATION], () => {
      net._resolveCatch();
    });
    assert.equal(net.catchResult, 'miss');
    assert.equal(got[Events.NET_CATCH_MISS][0].reason, 'fragmented');
    assert.equal(got[Events.INTERACTION_FRAGMENTATION][0].destroyTarget, true);
  });

  it('mercy path: first fragmentation waives the credit penalty, second pays', () => {
    captureNetSystem.reset();
    const run = () => {
      const net = makeNet({ brittleness: 0.95 });
      net._fragRollOverride = 0;
      net._fragCountRollOverride = 0;
      return collect([Events.NET_FRAGMENTATION, Events.SCORING_AWARD], () => net._resolveCatch());
    };
    const first = run();
    assert.equal(first[Events.NET_FRAGMENTATION][0].mercyApplied, true);
    assert.equal(first[Events.SCORING_AWARD].filter(a => a.reason === 'Fragmentation penalty').length, 0,
      'mercy waives the penalty');

    const second = run();
    assert.equal(second[Events.NET_FRAGMENTATION][0].mercyApplied, false);
    const pens = second[Events.SCORING_AWARD].filter(a => a.reason === 'Fragmentation penalty');
    assert.equal(pens.length, 1, 'post-mercy fragmentation pays the penalty');
    assert.ok(pens[0].points < 0, 'penalty is negative points');
  });
});

describe('Fragmentation — honest FRAG chip (B1)', () => {
  it('pre-fire chip risk equals the resolve-time risk for a brittleness-only target', () => {
    const scene = { add: () => {}, remove: () => {} };
    const arm = new ArmUnit('Weaver-1', 'weaver', new THREE.Vector3(0.00001, 0, 0), scene);
    arm.index = 0;
    arm._standoffR = 50;
    // Debris carries ONLY brittleness — never a `fragility` field
    // (DebrisField._createDebrisData). The chip must read it the same way
    // _resolveCatch does, via effectiveFragility.
    const target = { id: 7, mass: 100, sizeMeter: 2, brittleness: 0.9, tumbleRate: 0 };
    arm._stationKeepTarget = target;

    arm._refreshToolOdds();

    const netClass = getNetClassForType('weaver');
    const resolveRisk = computeFragRisk({
      netMass: netClass.MASS,
      vRel: netClass.LAUNCH_SPEED,
      targetFragility: effectiveFragility(target),
      range: 50,
    });
    assert.equal(arm._toolOddsFragRisk, resolveRisk,
      'chip risk == resolve risk (honest numbers)');

    // Regression guard: a brittle target must NOT show the 0.05-floor risk.
    const floorRisk = computeFragRisk({
      netMass: netClass.MASS,
      vRel: netClass.LAUNCH_SPEED,
      targetFragility: 0.05,
      range: 50,
    });
    assert.ok(arm._toolOddsFragRisk > floorRisk,
      'brittleness moves the chip above the fragility floor');
  });
});
