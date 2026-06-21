/**
 * test-WelcomeField.js — Delegation 2 (2026-05-31)
 *
 * Verifies DebrisField.spawnWelcomeField():
 *   • Returns 7–8 fragments
 *   • All fragments are tagged welcomeField: true
 *   • All distances fall within 150–1500 m of the player
 *   • All fragments share the player's orbital frame (a/e/i/RAAN/argP) —
 *     the public method only varies trueAnomaly, never the shape.
 *
 * Avoids instantiating DebrisField (which needs THREE.Scene) by calling
 * the prototype method against a minimal mock receiver.
 *
 * @module test/test-WelcomeField
 */

import { describe, it, assert } from './TestRunner.js';
import { DebrisField } from '../entities/DebrisField.js';
import { Constants } from '../core/Constants.js';
import { DebrisWireframe } from '../ui/DebrisWireframe.js';

// Mock receiver — emulates the few fields the method touches when
// `debrisList` is empty (pure-data plan return path).
function createMockField() {
  return {
    debrisList: [],
    _welcomeFieldSpawned: false,
    _spawnWelcomeField() { /* no-op — not exercised when debrisList is empty */ },
  };
}

const playerOrbit = {
  semiMajorAxis: 6878.137,    // 500 km altitude
  eccentricity: 0.0,
  inclination: 51.6 * Math.PI / 180,
  raan: 0.0,
  argPerigee: 0.0,
  trueAnomaly: 1.234,
  meanMotion: 0.0011,
};

// ─── BASIC SHAPE ─────────────────────────────────────────────────────────

describe('DebrisField.spawnWelcomeField — basic shape', () => {
  it('returns a plan with at least 7 fragments (default)', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit);
    assert.ok(plan && Array.isArray(plan.fragments), 'plan.fragments is an array');
    assert.ok(plan.fragments.length >= 7 && plan.fragments.length <= 8,
      `expected 7–8 fragments, got ${plan.fragments.length}`);
  });

  it('honours an explicit count of 8', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit, { count: 8 });
    assert.equal(plan.fragments.length, 8);
  });

  it('clamps count to the 7–8 range', () => {
    const mock = createMockField();
    const planLow = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit, { count: 3 });
    const planHigh = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit, { count: 50 });
    assert.equal(planLow.fragments.length, 7);
    assert.equal(planHigh.fragments.length, 8);
  });
});

// ─── TAGGING ─────────────────────────────────────────────────────────────

describe('DebrisField.spawnWelcomeField — tagging', () => {
  it('every fragment has welcomeField: true', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit);
    for (const f of plan.fragments) {
      assert.equal(f.welcomeField, true, `fragment missing welcomeField tag: ${JSON.stringify(f)}`);
    }
  });
});

// ─── DISTANCE RANGE ──────────────────────────────────────────────────────

describe('DebrisField.spawnWelcomeField — offset range 150 – 1500 m', () => {
  it('all fragments fall within the 150 – 1500 m offset window', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit);
    for (const f of plan.fragments) {
      assert.ok(f.offsetM >= 150 && f.offsetM <= 1500,
        `offsetM out of range: ${f.offsetM}`);
    }
  });

  it('custom min/max offsets propagate', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit, {
      minOffsetM: 300, maxOffsetM: 900,
    });
    for (const f of plan.fragments) {
      assert.ok(f.offsetM >= 300 && f.offsetM <= 900,
        `offsetM out of custom range: ${f.offsetM}`);
    }
  });
});

// ─── MASS RANGE ──────────────────────────────────────────────────────────

describe('DebrisField.spawnWelcomeField — mass range 5 – 50 kg', () => {
  it('all masses fall within the spec window (5 – 50 kg)', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit);
    for (const f of plan.fragments) {
      assert.ok(f.massKg >= 5 && f.massKg <= 50,
        `massKg out of range: ${f.massKg}`);
    }
  });
});

// ─── ORBITAL FRAME ───────────────────────────────────────────────────────

describe('DebrisField.spawnWelcomeField — orbital frame preserved', () => {
  it('plan.playerOrbit is the same reference the caller passed in', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit);
    assert.equal(plan.playerOrbit, playerOrbit);
  });

  it('alternates ahead/behind orientation across the cluster', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, playerOrbit);
    const aheadCount = plan.fragments.filter(f => f.ahead).length;
    const behindCount = plan.fragments.filter(f => !f.ahead).length;
    // For a 7-frag plan we expect at least 3 of each.
    assert.ok(aheadCount >= 3, `expected ≥3 ahead, got ${aheadCount}`);
    assert.ok(behindCount >= 3, `expected ≥3 behind, got ${behindCount}`);
  });
});

// ─── INCLINATION INHERITANCE (per-language start tilt) ───────────────────────
// Per-language starting orbits (Languages.incDeg) set the player's inclination
// before MISSION_START fires, so the welcome cluster — spawned in the player's
// own orbit — must inherit *whatever* tilt the start uses. Low-tilt starts
// (Brazil 5°, Tamil 18°) get the same guaranteed first contacts as the 51.6°
// default. This guards the frame-copy at DebrisField._spawnWelcomeField.

describe('DebrisField.spawnWelcomeField — inherits a non-51.6° start tilt', () => {
  const lowTiltOrbit = {
    semiMajorAxis: 6728.137,    // 350 km altitude (fixed start altitude)
    eccentricity: 0.0,
    inclination: 5.0 * Math.PI / 180,   // Brazil / Alcântara equatorial start
    raan: 2.1,
    argPerigee: 0.0,
    trueAnomaly: 0.7,
    meanMotion: 0.0011,
  };

  it('plan.playerOrbit carries the 5° start inclination unchanged', () => {
    const mock = createMockField();
    const plan = DebrisField.prototype.spawnWelcomeField.call(mock, lowTiltOrbit);
    assert.closeTo(plan.playerOrbit.inclination, 5.0 * Math.PI / 180, 1e-12,
      'plan.playerOrbit must preserve the 5° start tilt');
  });

  it('actual spawned debris copy the player inclination/raan/argPerigee (frame copy)', () => {
    // Drive the real _spawnWelcomeField path with a minimal debris list so the
    // line that copies playerOrbit.inclination onto each fragment is exercised.
    const makeDebris = (id) => ({
      id,
      alive: true,
      type: 'fragment',
      mass: 10,
      material: undefined,
      orbit: {
        semiMajorAxis: lowTiltOrbit.semiMajorAxis + 0.5,  // "far" candidate
        eccentricity: 0,
        inclination: 51.6 * Math.PI / 180,                // distinct from player
        raan: 0,
        argPerigee: 0,
        trueAnomaly: 0,
      },
    });
    const debrisList = Array.from({ length: 7 }, (_, i) => makeDebris(i + 1));

    const mock = {
      debrisList,
      _welcomeFieldSpawned: false,
      _currentMissionProfile: { hydrazine: true },
      _lastSpawnGameDt: 0,
      _onboardingPinIds: new Set(),
      _generateSalvage: () => ({
        xenon: 0, indium: 0, gaAs: 0, battery: 0, hydrazine: 0, lithium: 0, metals: [],
      }),
      // Drive the real frame-copy path (not the empty-list plan return).
      _spawnWelcomeField: DebrisField.prototype._spawnWelcomeField,
    };

    DebrisField.prototype.spawnWelcomeField.call(mock, lowTiltOrbit);

    const welcome = debrisList.filter(d => d.welcomeSpawn);
    assert.ok(welcome.length >= 7, `expected ≥7 welcome debris, got ${welcome.length}`);
    for (const d of welcome) {
      assert.closeTo(d.orbit.inclination, lowTiltOrbit.inclination, 1e-12,
        `welcome debris ${d.id} did not inherit the 5° start tilt`);
      assert.closeTo(d.orbit.raan, lowTiltOrbit.raan, 1e-12,
        `welcome debris ${d.id} did not inherit the player RAAN`);
      assert.closeTo(d.orbit.argPerigee, lowTiltOrbit.argPerigee, 1e-12,
        `welcome debris ${d.id} did not inherit the player argPerigee`);
    }
  });
});

// ─── ONBOARDING TEASE PIN (mother-local frame, single source of truth) ─────
// #1 (dead-centre) and #2 (off to one side) are pinned at a fixed forward +
// lateral offset in the mother's local frame, written to _scenePosition (which
// selection, range, net, reticle, and rendering all read — TargetSelector
// prefers it). Local-frame is the only way to hold a stable sideways offset:
// co-orbital cross-track oscillates to zero. Here we cover the spawn-time
// contract and release; the per-frame orbit re-sync is the documented branch in
// update().

describe('DebrisField — onboarding tease pin (orbit-based)', () => {
  const pinOrbit = {
    semiMajorAxis: 6728.137, eccentricity: 0,
    inclination: 51.6 * Math.PI / 180, raan: 0, argPerigee: 0,
    trueAnomaly: 0.5, meanMotion: 0.0011,
  };

  function spawnWithPin(gameDt = 0) {
    const makeDebris = (id) => ({
      id, alive: true, type: 'fragment', mass: 10, material: undefined,
      orbit: {
        semiMajorAxis: pinOrbit.semiMajorAxis + 0.5,
        eccentricity: 0, inclination: 28.5 * Math.PI / 180,
        raan: 0, argPerigee: 0, trueAnomaly: 0,
      },
    });
    const debrisList = Array.from({ length: 7 }, (_, i) => makeDebris(i + 1));
    const mock = {
      debrisList,
      debrisMap: new Map(debrisList.map(d => [d.id, d])),
      _welcomeFieldSpawned: false,
      _currentMissionProfile: { hydrazine: true },
      _lastSpawnGameDt: gameDt,
      _onboardingPinIds: new Set(),
      _generateSalvage: () => ({
        xenon: 0, indium: 0, gaAs: 0, battery: 0, hydrazine: 0, lithium: 0, metals: [],
      }),
      _clearOnboardingPin: DebrisField.prototype._clearOnboardingPin,
      _spawnWelcomeField: DebrisField.prototype._spawnWelcomeField,
    };
    mock._spawnWelcomeField(pinOrbit);
    return mock;
  }

  it('pins the two close station-catch pieces (#1 centre, #2 to one side)', () => {
    const mock = spawnWithPin();
    const pinned = mock.debrisList.filter(d => d._onboardingPinned === true);
    assert.equal(pinned.length, 2, 'exactly two pieces are pinned (#1 and #2)');
    assert.equal(mock._onboardingPinIds.size, 2, '_onboardingPinIds tracks both');
    for (const d of pinned) {
      assert.ok(mock._onboardingPinIds.has(d.id), 'pinned id is tracked in the set');
    }
    const ms = Constants.SCENE_SCALE / 1000; // metre → scene
    // Identify the pinned pieces by ROLE, not by debrisList index: the curated
    // spec→candidate matcher assigns by appearance score (type/material/plate),
    // so spec #1 does not necessarily land at debrisList[0]. The product
    // invariant is "one dead-centre piece + one piece off to the side".
    const d1 = pinned.find(d => d._onboardingPinLat === 0);       // #1 dead centre
    const d2 = pinned.find(d => d._onboardingPinLat > 0);         // #2 off to one side
    assert.ok(d1, 'a dead-centre pinned piece exists (#1)');
    assert.ok(d2, 'an off-to-one-side pinned piece exists (#2)');
    // #1 dead-centre: 22 m forward, no lateral.
    assert.closeTo(d1._onboardingPinFwd, 22 * ms, 1e-12, '#1 is 22 m forward');
    assert.equal(d1._onboardingPinLat, 0, '#1 has no lateral (dead centre)');
    // #2 farther ahead AND off to one side.
    assert.closeTo(d2._onboardingPinFwd, 45 * ms, 1e-12, '#2 is 45 m forward');
    assert.ok(d2._onboardingPinLat > 0, '#2 is offset to one side');
    assert.ok(d2._onboardingPinFwd > d1._onboardingPinFwd, '#2 sits farther ahead than #1');
  });

  it('local-frame pin offsets are independent of spawn-frame dt', () => {
    // Regression: the old _scenePosition pin absorbed the one-frame _frameComp
    // (n × gameDt) and froze the piece ~km off-target. The local-frame pin comes
    // straight from spec.fwdM/latM, so a large spawn-frame gameDt changes nothing.
    const ms = Constants.SCENE_SCALE / 1000;
    const a = spawnWithPin(0);
    const b = spawnWithPin(1.0); // large frame-comp
    // The dead-centre piece (#1) is pinned 22 m forward regardless of spawn dt.
    const aCenter = a.debrisList.find(d => d._onboardingPinned && d._onboardingPinLat === 0);
    const bCenter = b.debrisList.find(d => d._onboardingPinned && d._onboardingPinLat === 0);
    assert.closeTo(aCenter._onboardingPinFwd, 22 * ms, 1e-12, 'dt=0 → 22 m');
    assert.closeTo(bCenter._onboardingPinFwd, 22 * ms, 1e-12, 'dt=1 → still 22 m');
  });

  it('pinned pieces are in net range and inside the forward arc', () => {
    const mock = spawnWithPin();
    const ms = Constants.SCENE_SCALE / 1000;
    const netRange = Constants.NET_LOCK_RANGE_M || 90;
    for (const d of mock.debrisList.filter(x => x._onboardingPinned)) {
      const fwdM = d._onboardingPinFwd / ms;
      const latM = d._onboardingPinLat / ms;
      const dist = Math.hypot(fwdM, latM);
      assert.ok(dist < netRange, `pinned piece must be in net range (${dist.toFixed(1)} m < ${netRange})`);
      assert.ok(fwdM / dist >= 0.5, `pinned piece must be in the forward arc (dot ${(fwdM / dist).toFixed(2)})`);
    }
  });

  it('release semantics: catching one piece does not unpin the other', () => {
    const mock = spawnWithPin();
    // Identify pinned pieces by role (matcher order is appearance-scored).
    const pinned = mock.debrisList.filter(d => d._onboardingPinned);
    const d1 = pinned.find(d => d._onboardingPinLat === 0);   // #1 dead centre
    const d2 = pinned.find(d => d._onboardingPinLat > 0);     // #2 to one side
    assert.ok(d1 && d2 && d1._onboardingPinned && d2._onboardingPinned, 'both pinned to start');

    // A non-pinned id must release nothing.
    mock._clearOnboardingPin(9999);
    assert.equal(mock._onboardingPinIds.size, 2, 'unknown id releases nothing');

    // Releasing #1 (e.g. ARM_CAPTURED / DEBRIS_REMOVED for #1) leaves #2 pinned.
    mock._clearOnboardingPin(d1.id);
    assert.equal(d1._onboardingPinned, false, '#1 unpinned');
    assert.equal(d1._onboardingPinFwd, 0, '#1 forward offset reset');
    assert.equal(d1._onboardingPinLat, 0, '#1 lateral offset reset');
    assert.equal(d2._onboardingPinned, true, '#2 still pinned');
    assert.ok(mock._onboardingPinIds.has(d2.id) && !mock._onboardingPinIds.has(d1.id),
      'set tracks only #2 now');

    // Releasing all (ONBOARDING_COMPLETE / reset) clears the rest.
    mock._clearOnboardingPin();
    assert.equal(d2._onboardingPinned, false, '#2 unpinned on clear-all');
    assert.equal(mock._onboardingPinIds.size, 0, 'no pins remain');
  });
});

// ─── NET-CATCHABLE WELCOME CLUSTER ─────────────────────────────────────────
// Mission-1 onboarding is net-only (no Daughter beat). Every welcome piece must
// be catchable by the Mother net, i.e. mass ≤ LASSO_MAX_CAPTURE_MASS. Otherwise
// the tutorial's "fire the Mother net (N)" target trips "Target too massive for
// Mother net. Try deploying a Daughter [D]".

describe('DebrisField — welcome cluster is Mother-net catchable', () => {
  it('every spawned welcome piece has mass ≤ LASSO_MAX_CAPTURE_MASS', () => {
    const playerOrbit = {
      semiMajorAxis: 6728.137, eccentricity: 0,
      inclination: 51.6 * Math.PI / 180, raan: 0, argPerigee: 0,
      trueAnomaly: 0.5, meanMotion: 0.0011,
    };
    const makeDebris = (id) => ({
      id, alive: true, type: 'defunctSat', mass: 999, material: undefined,
      orbit: {
        semiMajorAxis: playerOrbit.semiMajorAxis + 0.5,
        eccentricity: 0, inclination: 28.5 * Math.PI / 180,
        raan: 0, argPerigee: 0, trueAnomaly: 0,
      },
    });
    const debrisList = Array.from({ length: 7 }, (_, i) => makeDebris(i + 1));
    const mock = {
      debrisList,
      debrisMap: new Map(debrisList.map(d => [d.id, d])),
      _welcomeFieldSpawned: false,
      _currentMissionProfile: { hydrazine: true },
      _lastSpawnGameDt: 0,
      _onboardingPinIds: new Set(),
      _generateSalvage: () => ({
        xenon: 0, indium: 0, gaAs: 0, battery: 0, hydrazine: 0, lithium: 0, metals: [],
      }),
      _clearOnboardingPin: DebrisField.prototype._clearOnboardingPin,
      _spawnWelcomeField: DebrisField.prototype._spawnWelcomeField,
    };
    mock._spawnWelcomeField(playerOrbit);

    const ceil = Constants.LASSO_MAX_CAPTURE_MASS;
    const welcome = debrisList.filter(d => d.welcomeSpawn);
    assert.ok(welcome.length >= 7, `expected ≥7 welcome debris, got ${welcome.length}`);
    for (const d of welcome) {
      assert.ok(d.mass <= ceil,
        `welcome debris ${d.id} mass ${d.mass} exceeds Mother-net limit ${ceil}`);
    }
  });
});

// ─── M1 CLUSTER: SIZE HIERARCHY · REWARD RAMP · NO FLAGS (Phase 1) ──────────
// .kilo/plans/onboarding-tease-2-lateral-tune.md — every welcome fragment must
// render sub-metre (never larger than the ~2 m mother), reward must climb
// across the cluster (mass-driven), and no welcome piece may keep a flag.

const m1Orbit = {
  semiMajorAxis: 6728.137, eccentricity: 0,
  inclination: 51.6 * Math.PI / 180, raan: 0, argPerigee: 0,
  trueAnomaly: 0.5, meanMotion: 0.0011,
};

// Build a mock field with `n` far fragment candidates carrying explicit
// material + variant (so Phase-2 candidate matching has something to select),
// plus an optional pre-seeded _flagLookup so the flag-strip guard is exercised.
function makeM1Mock(opts = {}) {
  const materials = opts.materials ||
    ['aluminum', 'mli_mylar', 'solar_cell', 'aluminum', 'solar_cell', 'mli_mylar', 'titanium',
     'aluminum', 'composite', 'mli_mylar', 'solar_cell', 'aluminum'];
  const n = opts.n || 12;
  // Per-candidate type, in id order (defaults to all 'fragment'). Lets a test
  // seed 'cubesat' candidates so #7's type-aware match can select one.
  const types = opts.types || null;
  const debrisList = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    alive: true,
    type: types ? types[i % types.length] : 'fragment',
    mass: 50, material: materials[i % materials.length],
    country: opts.country || null,
    orbit: {
      semiMajorAxis: m1Orbit.semiMajorAxis + 0.5, // far band
      eccentricity: 0, inclination: 28.5 * Math.PI / 180,
      raan: 0, argPerigee: 0, trueAnomaly: 0,
    },
  }));
  const mock = {
    debrisList,
    debrisMap: new Map(debrisList.map(d => [d.id, d])),
    _welcomeFieldSpawned: false,
    _currentMissionNumber: 2, // skip the M1 hide-everything branch (needs meshes)
    _currentMissionProfile: { hydrazine: true },
    _lastSpawnGameDt: 0,
    _onboardingPinIds: new Set(),
    _generateSalvage: (type, mass) => ({
      xenon: 0, indium: 0, gaAs: 0, battery: 0, hydrazine: 0, lithium: 0,
      metals: [{ type: 'aluminum', amount: mass * 0.5 }],
    }),
    _clearOnboardingPin: DebrisField.prototype._clearOnboardingPin,
    _spawnWelcomeField: DebrisField.prototype._spawnWelcomeField,
  };
  if (opts.flagLookup) mock._flagLookup = opts.flagLookup;
  if (opts.captureOriginal) {
    mock.__originalMaterial = new Map(debrisList.map(d => [d.id, d.material]));
  }
  if (opts.captureOriginalType) {
    // The reused mesh slot (hence rendered SHAPE) is the candidate's original
    // type — the downstream retype guard rewrites debris.type to the spec's,
    // so post-spawn debris.type can't distinguish a real cubesat slot from a
    // retyped fragment. Snapshot the pre-spawn type to test slot selection.
    mock.__originalType = new Map(debrisList.map(d => [d.id, d.type]));
  }
  mock._spawnWelcomeField(m1Orbit);
  return mock;
}

describe('DebrisField — M1 cluster size hierarchy (Phase 1)', () => {
  it('every welcome piece renders sub-metre (sizeMeter < 1.1, below the mother)', () => {
    const mock = makeM1Mock();
    const welcome = mock.debrisList.filter(d => d.welcomeSpawn);
    assert.ok(welcome.length >= 7, `expected ≥7 welcome, got ${welcome.length}`);
    for (const d of welcome) {
      assert.ok(d.sizeMeter < 1.1,
        `welcome debris ${d.id} sizeMeter ${d.sizeMeter} should be sub-metre`);
    }
  });
});

describe('DebrisField — M1 cluster reward ramps (Phase 1)', () => {
  it('curated welcome masses are non-decreasing #1→#7', () => {
    const mock = makeM1Mock();
    // Recover spec order via _welcomeSpecIndex (score-based matching means
    // debrisList order != spec order).
    const ordered = mock.debrisList
      .filter(d => d.welcomeSpawn)
      .sort((a, b) => a._welcomeSpecIndex - b._welcomeSpecIndex);
    assert.equal(ordered.length, 7, 'all 7 specs placed');
    for (let i = 1; i < ordered.length; i++) {
      assert.ok(ordered[i].mass >= ordered[i - 1].mass - 1e-9,
        `mass should not decrease: #${i} ${ordered[i].mass} < #${i - 1} ${ordered[i - 1].mass}`);
    }
    // Last piece (#7 cubesat) is the heaviest / top reward.
    assert.ok(ordered[6].mass >= ordered[0].mass, '#7 is heavier than #1');
  });

  it('only #1 and #2 are lowValue (premium materials stripped early only)', () => {
    const mock = makeM1Mock();
    const ordered = mock.debrisList
      .filter(d => d.welcomeSpawn)
      .sort((a, b) => a._welcomeSpecIndex - b._welcomeSpecIndex);
    // lowValue thins metals ×0.3 + zeroes premium. With our salvage stub the
    // metal amount is the visible signal: #1/#2 thinned, #3+ full.
    const m = (d) => (d.salvage.metals[0] ? d.salvage.metals[0].amount : 0);
    // #3 keeps full metal (mass×0.5), #1 is thinned (mass×0.5×0.3).
    assert.ok(m(ordered[0]) < ordered[0].mass * 0.5,
      '#1 metals thinned by lowValue');
    assert.ok(m(ordered[2]) >= ordered[2].mass * 0.5 - 1e-9,
      '#3 metals NOT thinned (no lowValue)');
  });
});

describe('DebrisField — welcome pieces carry no flag (Phase 1)', () => {
  it('strips a pre-existing flag lookup + clears country on spawn', () => {
    // Seed a flag lookup keyed by every candidate id; after spawn none of the
    // welcome pieces should remain in the lookup, and their country is cleared.
    const flagLookup = new Map();
    for (let i = 1; i <= 12; i++) flagLookup.set(i, { country: 'US', instanceIndex: i });
    const mock = makeM1Mock({ flagLookup, country: 'US' });
    const welcome = mock.debrisList.filter(d => d.welcomeSpawn);
    for (const d of welcome) {
      assert.ok(!mock._flagLookup.has(d.id),
        `welcome debris ${d.id} still has a flag lookup entry`);
      assert.equal(d.country, null, `welcome debris ${d.id} country not cleared`);
    }
  });
});

// ─── APPEARANCE BY SELECTION (Phase 2) ─────────────────────────────────────

describe('DebrisWireframe.isPlateVariant (Phase 2)', () => {
  it('drives the real _buildFragmentGeo shape (plate variants render flatter in Y)', () => {
    // isPlateVariant is now the single source of truth _buildFragmentGeo
    // consumes, so rather than re-deriving the hash (which would just be a
    // second copy of the rule and could silently agree while both drift), this
    // asserts against the ACTUAL geometry: plate variants flatten the Y axis
    // (dy * sy * flat), so their bounding-box Y-flatness must be smaller, in
    // aggregate, than the non-plate variants. If the builder ever stops
    // consuming the flag, both groups flatten identically and this fails.
    const N = Constants.DEBRIS_FRAGMENT_VARIANTS || 7;
    const flatnessY = (v) => {
      const geo = DebrisWireframe.getGeometry('fragment', v);
      geo.computeBoundingBox();
      const b = geo.boundingBox;
      const xs = b.max.x - b.min.x;
      const ys = b.max.y - b.min.y;
      const zs = b.max.z - b.min.z;
      return ys / (((xs + zs) / 2) || 1);
    };
    const plate = [], chunk = [];
    for (let v = 0; v < N; v++) {
      (DebrisWireframe.isPlateVariant(v) ? plate : chunk).push(flatnessY(v));
    }
    // Sanity: the fixed variant set must contain at least one of each class,
    // otherwise the comparison is vacuous.
    assert.ok(plate.length > 0, 'at least one plate variant exists');
    assert.ok(chunk.length > 0, 'at least one non-plate variant exists');
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    assert.ok(mean(plate) < mean(chunk),
      `plate variants must render flatter in Y than chunks ` +
      `(plate mean ${mean(plate).toFixed(3)} >= chunk mean ${mean(chunk).toFixed(3)})`);
  });

  it('is stable under variant wrap (id % N)', () => {
    const N = Constants.DEBRIS_FRAGMENT_VARIANTS || 7;
    for (let v = 0; v < N; v++) {
      assert.equal(DebrisWireframe.isPlateVariant(v),
        DebrisWireframe.isPlateVariant(v + N), `variant ${v} not stable under +N`);
    }
  });
});

describe('DebrisField — welcome candidate material selection (Phase 2)', () => {
  it('selects a gold mli_mylar candidate for #2 and blue solar_cell for #3/#5', () => {
    // Record each candidate's ORIGINAL material (spawn overwrites debris.material
    // from the appearance hint, so we must capture the pre-spawn slot — that
    // original material is what the reused mesh slot actually renders).
    const mock = makeM1Mock({ captureOriginal: true });
    const orig = mock.__originalMaterial; // id → original material
    const ordered = mock.debrisList
      .filter(d => d.welcomeSpawn)
      .sort((a, b) => a._welcomeSpecIndex - b._welcomeSpecIndex);
    assert.equal(orig.get(ordered[1].id), 'mli_mylar',
      '#2 reused a gold MLI mesh slot');
    assert.equal(orig.get(ordered[2].id), 'solar_cell',
      '#3 reused a blue solar-cell mesh slot');
    assert.equal(orig.get(ordered[4].id), 'solar_cell',
      '#5 reused a blue solar-cell mesh slot');
  });

  it('falls back gracefully when no matching-material candidate exists', () => {
    // All candidates aluminium → matcher cannot satisfy gold/blue rows but must
    // still place all 7 (graceful fallback to any far fragment).
    const mock = makeM1Mock({ materials: ['aluminum'], n: 12 });
    const welcome = mock.debrisList.filter(d => d.welcomeSpawn);
    assert.ok(welcome.length >= 7, `spawn must not under-fill, got ${welcome.length}`);
  });
});

// ─── APPEARANCE STARVATION REGRESSION (Phase 2 fix) ─────────────────────────
// The old matcher had an early-break at `farFragments.length >= 7`, so it only
// ever scored the FIRST 7 far fragments in debrisList order. If those 7 are all
// the wrong material, #2/#3/#5 fell back to grey chunks even though gold/blue
// candidates existed later in the list. This test puts the matching materials
// LATER than 7 aluminum fragments, so it FAILS under the old early-break and
// PASSES once the full list is scanned.

describe('DebrisField — welcome matcher is not starved by list order (Phase 2 fix)', () => {
  it('reaches gold/blue candidates that sit after the first 7 aluminum fragments', () => {
    // ids 1–7: aluminum (the only candidates the old early-break would see).
    // ids 8–12: the gold MLI + blue solar-cell slots #2/#3/#5 actually want.
    const materials = [
      'aluminum', 'aluminum', 'aluminum', 'aluminum', 'aluminum', 'aluminum', 'aluminum',
      'mli_mylar', 'solar_cell', 'solar_cell', 'mli_mylar', 'aluminum',
    ];
    const mock = makeM1Mock({ materials, n: 12, captureOriginal: true });
    const orig = mock.__originalMaterial; // id → original (rendered) material
    const ordered = mock.debrisList
      .filter(d => d.welcomeSpawn)
      .sort((a, b) => a._welcomeSpecIndex - b._welcomeSpecIndex);
    assert.equal(ordered.length, 7, 'all 7 specs placed');
    assert.equal(orig.get(ordered[1].id), 'mli_mylar',
      '#2 reached a gold MLI slot despite it being past the first 7');
    assert.equal(orig.get(ordered[2].id), 'solar_cell',
      '#3 reached a blue solar-cell slot despite list order');
    assert.equal(orig.get(ordered[4].id), 'solar_cell',
      '#5 reached a blue solar-cell slot despite list order');
  });
});

// ─── CUBESAT SELECTION (Phase 2 fix — shape by selection) ───────────────────
// Row #7 (types:['cubesat']) must reuse a real `cubesat`-type candidate so it
// renders as a small whole microsat box, not a junk fragment. The +4 type-match
// score makes #7 prefer a cubesat slot whenever one exists in the far band.

describe('DebrisField — welcome #7 selects a cubesat candidate (Phase 2 fix)', () => {
  it('realises spec #7 with a cubesat-type debris when cubesats are available', () => {
    // Mostly fragments, with a couple of cubesat candidates sprinkled in.
    const types = [
      'fragment', 'fragment', 'fragment', 'cubesat', 'fragment', 'fragment',
      'fragment', 'fragment', 'cubesat', 'fragment', 'fragment', 'fragment',
    ];
    const mock = makeM1Mock({ types, n: 12, captureOriginalType: true });
    const origType = mock.__originalType; // id → original (mesh-slot) type
    const seven = mock.debrisList.find(d => d.welcomeSpawn && d._welcomeSpecIndex === 6);
    assert.ok(seven, 'spec #7 was realised');
    // The reused SLOT must be a cubesat (so it renders as a small whole sat).
    // debris.type is always 'cubesat' post-spawn (spec.types retype guard), so
    // assert on the captured ORIGINAL type instead.
    assert.equal(origType.get(seven.id), 'cubesat',
      '#7 reused a cubesat mesh slot (renders as a small whole satellite)');
    // The fragment rows must NOT have grabbed the cubesats — they should keep
    // their original fragment slots.
    const fragRows = mock.debrisList.filter(d => d.welcomeSpawn && d._welcomeSpecIndex < 6);
    for (const d of fragRows) {
      assert.equal(origType.get(d.id), 'fragment',
        `fragment row #${d._welcomeSpecIndex + 1} must reuse a fragment slot, not a cubesat`);
    }
  });

  it('falls back to a fragment for #7 when no cubesat candidate exists', () => {
    // All fragments → #7 has no cubesat to select; graceful fallback keeps spawn
    // full, and the retype guard still labels #7 a cubesat for downstream logic.
    const mock = makeM1Mock({ captureOriginalType: true });
    const welcome = mock.debrisList.filter(d => d.welcomeSpawn);
    assert.ok(welcome.length >= 7, `spawn must not under-fill, got ${welcome.length}`);
    const seven = mock.debrisList.find(d => d.welcomeSpawn && d._welcomeSpecIndex === 6);
    assert.ok(seven, 'spec #7 still realised via fallback');
    assert.equal(mock.__originalType.get(seven.id), 'fragment',
      '#7 reused a fragment slot (no cubesat candidate existed)');
    assert.equal(seven.type, 'cubesat',
      '#7 retypes to cubesat via the spec.types guard when a fragment is reused');
  });
});
