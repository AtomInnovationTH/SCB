/**
 * test-CatalogLoader.js — ST-6.1 offline-catalogue service tests.
 *
 * Uses top-level await (supported in Node.js ES modules) to ensure
 * CatalogLoader instances are fully initialised before synchronous
 * describe() / it() blocks run. This keeps compatibility with the
 * zero-dependency TestRunner that doesn't await describe callbacks.
 *
 * Covers:
 *  1. META loading → isReady(), getMeta(), counts.
 *  2. Lookup by NORAD (hit + type-coercion + miss).
 *  3. Weather timeline — getWeatherEventsUpTo, getNextWeatherEvent.
 *  4. Fetch failure fallback — resolves false, empty catalogues.
 *  5. Active-sat arming refusal (RED alert + Houston stand-down).
 *  6. CatalogConverter — catalogEntryToDebrisData (pure).
 *  7. buildHybridDebrisSeeds — real + procedural split.
 *  8. Seeded weather replay — events fire once, manage_power gate honoured.
 *
 * @module test/test-CatalogLoader
 */

import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { Events } from '../core/Events.js';
import { eventBus } from '../core/EventBus.js';

import { CatalogLoader } from '../systems/CatalogLoader.js';
import { checkActiveSatArming } from '../systems/ActiveSatGuard.js';
import {
  catalogEntryToDebrisData,
  buildHybridDebrisSeeds,
} from '../entities/CatalogConverter.js';
import { SpaceWeatherSystem } from '../systems/SpaceWeatherSystem.js';

// ============================================================================
// FIXTURES
// ============================================================================

const META_FIXTURE = {
  version: '1.0.0',
  generated_at: '2026-04-20',
  files: [
    'debris-catalog.json', 'active-sats.json', 'launches.json',
    'space-weather.json', 'ground-stations.json', 'constellations.json',
  ],
  counts: { debris: 2, active_sats: 2, launches: 1, weather_events: 3, ground_stations: 1, constellations: 1 },
  checksum: 'sc-catalog-test',
};

const DEBRIS_FIXTURE = [
  { norad: '00005', name: 'VANGUARD 1', type: 'inactive', mass_kg: 1.5,  size_m: 0.165, country: 'USA', launch_year: 1958,
    tle: { alt_km: 650, inc_deg: 34.25, raan_deg: 80, ecc: 0.185, arg_perigee_deg: 230, mean_anomaly_deg: 85 }, notable: 'Oldest', trl: 9 },
  { norad: '27386', name: 'ENVISAT',    type: 'inactive', mass_kg: 8211, size_m: 26.0,  country: 'ESA', launch_year: 2002,
    tle: { alt_km: 771, inc_deg: 98.56, raan_deg: 120, ecc: 0.0001, arg_perigee_deg: 90, mean_anomaly_deg: 12 }, notable: 'ADR', trl: 9 },
];
const ACTIVE_FIXTURE = [
  { norad: '25544', name: 'ISS (ZARYA)',  type: 'active', mass_kg: 420000, size_m: 73,   country: 'ISS', launch_year: 1998,
    tle: { alt_km: 418, inc_deg: 51.64, raan_deg: 123.4, ecc: 0.0003, arg_perigee_deg: 45, mean_anomaly_deg: 0 }, notable: 'ISS', trl: 9 },
  { norad: '20580', name: 'HST (HUBBLE)', type: 'active', mass_kg: 11110, size_m: 13.2, country: 'USA', launch_year: 1990,
    tle: { alt_km: 535, inc_deg: 28.47, raan_deg: 12.3, ecc: 0.0003, arg_perigee_deg: 90, mean_anomaly_deg: 0 }, notable: 'HST', trl: 9 },
];
const LAUNCHES_FIXTURE = [
  { id: 'sputnik-1', name: 'Sputnik 1', date: '1957-10-04', country: 'CIS', payload_kg: 83.6, vehicle: 'R-7', outcome: 'success', significance: 'First sat' },
];
const WEATHER_FIXTURE = {
  cycle_start_game_hour: 0, cycle_length_game_hours: 132,
  events: [
    { game_hour: 12, type: 'cme',         severity: 'M',  duration_h: 4  },
    { game_hour: 48, type: 'solar_flare', severity: 'X',  duration_h: 2  },
    { game_hour: 72, type: 'quiet',       severity: '--', duration_h: 24 },
  ],
};
const GROUND_FIXTURE = [{ id: 'madrid-dsn', name: 'Madrid DSN', lat_deg: 40.43, lon_deg: -4.25, country: 'ESP', type: 'DSN' }];
const CONSTELLATIONS_FIXTURE = [{ id: 'starlink', name: 'Starlink', operator: 'SpaceX', sat_count_approx: 5000, inc_deg: 53, alt_km: 550, purpose: 'Broadband' }];

function makeFetchStub(overrides = {}) {
  const map = {
    './data/META.json':              META_FIXTURE,
    './data/debris-catalog.json':    DEBRIS_FIXTURE,
    './data/active-sats.json':       ACTIVE_FIXTURE,
    './data/launches.json':          LAUNCHES_FIXTURE,
    './data/space-weather.json':     WEATHER_FIXTURE,
    './data/ground-stations.json':   GROUND_FIXTURE,
    './data/constellations.json':    CONSTELLATIONS_FIXTURE,
    ...overrides,
  };
  return (path) => {
    if (!(path in map))
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error('404')) });
    if (map[path] === null)
      return Promise.reject(new Error(`stub: forced reject for ${path}`));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(map[path]) });
  };
}

function captureBus(eventName) {
  const events = [];
  const unsub = eventBus.on(eventName, (p) => events.push(p));
  return { events, stop: () => typeof unsub === 'function' && unsub() };
}

// ============================================================================
// PRE-INITIALISED LOADERS (top-level await — Node.js ES module support)
// ============================================================================

/** Standard fully-loaded CatalogLoader */
const cl     = new CatalogLoader();
await cl.init({ fetchImpl: makeFetchStub() });

/** Loader whose META fetch is forced to reject → tests fallback path */
const clFail = new CatalogLoader();
await clFail.init({ fetchImpl: makeFetchStub({ './data/META.json': null }) });

/** Loader where only launches.json fails — other files succeed */
const clPartial = new CatalogLoader();
await clPartial.init({ fetchImpl: makeFetchStub({ './data/launches.json': null }) });

/** Pre-capture CATALOG_LOADED events for the two emit-verification tests.
 *  Because these require async init, we do them at top-level await so the
 *  corresponding it() blocks can assert synchronously. */
const _catLoadedOk = captureBus(Events.CATALOG_LOADED);
const _clEmitOk = new CatalogLoader();
await _clEmitOk.init({ fetchImpl: makeFetchStub() });
_catLoadedOk.stop();

const _catLoadedFail = captureBus(Events.CATALOG_LOADED);
const _clEmitFail = new CatalogLoader();
await _clEmitFail.init({ fetchImpl: makeFetchStub({ './data/META.json': null }) });
_catLoadedFail.stop();

// ============================================================================
// (1) META loading
// ============================================================================

describe('CatalogLoader — META loading (stubbed fetch)', () => {
  it('init() resolves and isReady() === true', () => {
    assert.equal(cl.isReady(), true);
  });
  it('getMeta().version === "1.0.0"', () => {
    assert.equal(cl.getMeta().version, '1.0.0');
  });
  it('debris count: 2 entries', () => {
    assert.equal(cl.getAllDebris().length, 2);
  });
  it('active-sat count: 2 entries', () => {
    assert.equal(cl.getAllActiveSats().length, 2);
  });
  it('launches count: 1 entry', () => {
    assert.equal(cl.getAllLaunches().length, 1);
  });
  it('ground-station count: 1 entry', () => {
    assert.equal(cl.getAllGroundStations().length, 1);
  });
  it('EVT.CATALOG_LOADED carries ready:true, version, counts', () => {
    assert.ok(_catLoadedOk.events.length >= 1, 'expected at least one CATALOG_LOADED emission');
    const p = _catLoadedOk.events[_catLoadedOk.events.length - 1];
    assert.equal(p.ready, true);
    assert.equal(p.version, '1.0.0');
    assert.equal(p.counts.debris, 2);
    assert.equal(p.counts.weather_events, 3);
  });
});

// ============================================================================
// (2) Lookup by NORAD
// ============================================================================

describe('CatalogLoader — lookup by NORAD', () => {
  it('getDebrisByNorad("27386") returns ENVISAT', () => {
    const env = cl.getDebrisByNorad('27386');
    assert.ok(env);
    assert.equal(env.name, 'ENVISAT');
  });
  it('getActiveSat("25544") returns ISS (ZARYA)', () => {
    const iss = cl.getActiveSat('25544');
    assert.ok(iss);
    assert.equal(iss.name, 'ISS (ZARYA)');
  });
  it('getActiveSat(unknown NORAD) returns null', () => {
    assert.equal(cl.getActiveSat('99999'), null);
  });
  it('getDebrisByNorad(null) and (undefined) return null gracefully', () => {
    assert.equal(cl.getDebrisByNorad(null), null);
    assert.equal(cl.getDebrisByNorad(undefined), null);
  });
  it('numeric NORAD coerced to string (getDebrisByNorad(27386))', () => {
    assert.equal(cl.getDebrisByNorad(27386).name, 'ENVISAT');
  });
});

// ============================================================================
// (3) Weather timeline
// ============================================================================

describe('CatalogLoader — weather timeline', () => {
  it('getWeatherEventsUpTo(0) → []', () => {
    assert.equal(cl.getWeatherEventsUpTo(0).length, 0);
  });
  it('getWeatherEventsUpTo(50) → 2 events (12 h CME + 48 h X-flare)', () => {
    const evs = cl.getWeatherEventsUpTo(50);
    assert.equal(evs.length, 2);
    assert.equal(evs[0].game_hour, 12);
    assert.equal(evs[1].game_hour, 48);
  });
  it('getWeatherEventsUpTo(9999) → all 3 events (incl. quiet)', () => {
    assert.equal(cl.getWeatherEventsUpTo(9999).length, 3);
  });
  it('getNextWeatherEvent(30) returns the event at game_hour=48', () => {
    const next = cl.getNextWeatherEvent(30);
    assert.ok(next);
    assert.equal(next.game_hour, 48);
    assert.equal(next.type, 'solar_flare');
  });
  it('getNextWeatherEvent past-end → null', () => {
    assert.equal(cl.getNextWeatherEvent(9999), null);
  });
});

// ============================================================================
// (4) Fetch-failure fallback
// ============================================================================

describe('CatalogLoader — fetch failure fallback', () => {
  it('META reject → isReady() === false', () => {
    assert.equal(clFail.isReady(), false);
  });
  it('META reject → getAllDebris() === []', () => {
    assert.equal(clFail.getAllDebris().length, 0);
  });
  it('META reject → getDebrisByNorad returns null', () => {
    assert.equal(clFail.getDebrisByNorad('27386'), null);
  });
  it('META reject → EVT.CATALOG_LOADED still emitted (ready:false)', () => {
    assert.ok(_catLoadedFail.events.length >= 1, 'CATALOG_LOADED must emit even on failure');
    assert.equal(_catLoadedFail.events[_catLoadedFail.events.length - 1].ready, false);
  });
  it('single-file reject tolerated: other files index normally', () => {
    assert.equal(clPartial.isReady(), true);
    assert.equal(clPartial.getAllLaunches().length, 0);
    assert.ok(clPartial.getDebrisByNorad('27386'));
    assert.ok(clPartial.getActiveSat('25544'));
  });
});

// ============================================================================
// (5) Active-sat arming refusal
// ============================================================================

describe('CatalogLoader — active-sat arming refusal (ActiveSatGuard)', () => {
  it('target with active NORAD → returns true (refused) + fires RED alert', () => {
    const alertCap = captureBus(Events.CONJUNCTION_ALERT);
    const refused = checkActiveSatArming({ id: 42, norad: '25544', mass: 420000 }, cl, eventBus);
    alertCap.stop();
    assert.equal(refused, true, 'guard must refuse');
    assert.ok(alertCap.events.length >= 1);
    assert.equal(alertCap.events[0].severity, 'RED');
    assert.equal(alertCap.events[0].reason, 'ACTIVE_SAT_ARMING');
    assert.equal(alertCap.events[0].norad, '25544');
    assert.equal(alertCap.events[0].targetName, 'ISS (ZARYA)');
  });
  it('target with active NORAD → Houston COMMS_MESSAGE contains stand-down text', () => {
    const commsCap = captureBus(Events.COMMS_MESSAGE);
    checkActiveSatArming({ norad: '25544' }, cl, eventBus);
    commsCap.stop();
    assert.ok(commsCap.events.length >= 1);
    const cm = commsCap.events[0];
    assert.equal(cm.source, 'HOUSTON');
    assert.ok(/Negative, Cowboy/.test(cm.text));
    assert.ok(/ISS \(ZARYA\)/.test(cm.text));
  });
  it('target without norad → returns false (no events)', () => {
    const alertCap = captureBus(Events.CONJUNCTION_ALERT);
    const refused = checkActiveSatArming({ id: 1, mass: 10 }, cl, eventBus);
    alertCap.stop();
    assert.equal(refused, false);
    assert.equal(alertCap.events.length, 0);
  });
  it('catalogLoader not ready → returns false', () => {
    const unready = new CatalogLoader(); // never init()
    const alertCap = captureBus(Events.CONJUNCTION_ALERT);
    const refused = checkActiveSatArming({ norad: '25544' }, unready, eventBus);
    alertCap.stop();
    assert.equal(refused, false);
    assert.equal(alertCap.events.length, 0);
  });
  it('debris NORAD (not active-sat) → returns false', () => {
    const refused = checkActiveSatArming({ norad: '27386' }, cl, eventBus);
    assert.equal(refused, false);
  });
});

// ============================================================================
// (6) CatalogConverter — catalogEntryToDebrisData (pure, sync)
// ============================================================================

describe('CatalogConverter — catalogEntryToDebrisData', () => {
  it('returns isReal:true with norad + name + country', () => {
    const d = catalogEntryToDebrisData(DEBRIS_FIXTURE[1], 100); // ENVISAT
    assert.ok(d);
    assert.equal(d.isReal, true);
    assert.equal(d.norad, '27386');
    assert.equal(d.name, 'ENVISAT');
    assert.equal(d.country, 'ESA');
  });
  it('orbit.semiMajorAxis is a positive scene-unit value', () => {
    const d = catalogEntryToDebrisData(DEBRIS_FIXTURE[1], 0);
    assert.ok(d.orbit.semiMajorAxis > 0);
    assert.equal(typeof d.orbit.inclination, 'number');
  });
  it('mass, tracked, type are correct', () => {
    const d = catalogEntryToDebrisData(DEBRIS_FIXTURE[1], 0);
    assert.equal(d.mass, 8211);
    assert.equal(d.tracked, true);
    assert.equal(d.type, 'defunctSat');   // inactive → defunctSat
  });
  it('null entry returns null gracefully', () => {
    assert.equal(catalogEntryToDebrisData(null, 0), null);
    assert.equal(catalogEntryToDebrisData({ name: 'no-tle' }, 0), null);
  });
});

// ============================================================================
// (7) buildHybridDebrisSeeds — real + procedural split
// ============================================================================

describe('CatalogConverter — buildHybridDebrisSeeds split', () => {
  it('3-real + 7-procedural fills a 10-slot field correctly', () => {
    const mockCL = {
      isReady: () => true,
      getAllDebris: () => [
        DEBRIS_FIXTURE[0],
        DEBRIS_FIXTURE[1],
        { ...DEBRIS_FIXTURE[0], norad: '00011', name: 'VANGUARD 2' },
      ],
    };
    const r = buildHybridDebrisSeeds(mockCL, 10, (id) => ({ id, type: 'fragment', mass: 1 }));
    assert.equal(r.real.length, 3);
    assert.equal(r.procedural.length, 7);
    assert.equal(r.debug.realCount, 3);
    assert.equal(r.debug.proceduralCount, 7);
    assert.equal(r.real[0].norad, '00005');
    assert.equal(r.real[1].norad, '27386');
    assert.equal(r.real[2].norad, '00011');
    for (const x of r.real)       assert.equal(x.isReal, true);
    for (const x of r.procedural) assert.equal(x.isReal, false);
  });
  it('unready catalogLoader → all procedural', () => {
    const unready = { isReady: () => false, getAllDebris: () => [] };
    const r = buildHybridDebrisSeeds(unready, 5, (id) => ({ id }));
    assert.equal(r.real.length, 0);
    assert.equal(r.procedural.length, 5);
  });
  it('catalogue larger than budget → caps at budget (no overflow)', () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ ...DEBRIS_FIXTURE[0], norad: `c${i}` }));
    const mockCL = { isReady: () => true, getAllDebris: () => big };
    const r = buildHybridDebrisSeeds(mockCL, 10, (id) => ({ id }));
    assert.equal(r.real.length, 10);
    assert.equal(r.procedural.length, 0);
  });
  it('active-type entries are skipped (not spawned as debris)', () => {
    const mixedCatalogue = [
      DEBRIS_FIXTURE[0],
      { ...ACTIVE_FIXTURE[0] }, // type:'active' — must be skipped
      DEBRIS_FIXTURE[1],
    ];
    const mockCL = { isReady: () => true, getAllDebris: () => mixedCatalogue };
    const r = buildHybridDebrisSeeds(mockCL, 10, (id) => ({ id, type: 'fragment' }));
    assert.equal(r.real.length, 2);
    assert.equal(r.procedural.length, 8);
  });
});

// ============================================================================
// (8) Seeded weather replay
// ============================================================================

describe('SpaceWeatherSystem — seeded replay via catalogLoader', () => {
  it('replay mode active when catalogLoader is ready', () => {
    const sw = new SpaceWeatherSystem({ catalogLoader: cl });
    assert.equal(sw._replayMode, true);
  });
  it('no replay mode without catalogLoader', () => {
    const sw = new SpaceWeatherSystem({});
    assert.equal(sw._replayMode, false);
  });
  it('events fire once each (not re-fired on repeated ticks)', () => {
    const sw = new SpaceWeatherSystem({ catalogLoader: cl });
    sw._powerMgmtDiscovered = true;
    sw._weatherAllowed = true;

    const TS = Constants.TIME_SCALE_GAMEPLAY || 1;
    const tick50h = (50 * 3600) / TS;  // crosses 12h CME + 48h X-flare

    const cap = captureBus(Events.WEATHER_EFFECT_START);
    sw.update(tick50h);  // should fire both CME + X-flare
    sw.update(1);        // should NOT re-fire anything
    sw.update(1);
    cap.stop();

    assert.ok(cap.events.length >= 2, `expected ≥2 events, got ${cap.events.length}`);
    const types = {};
    for (const e of cap.events) types[e.type] = (types[e.type] || 0) + 1;
    for (const [t, n] of Object.entries(types)) {
      assert.ok(n === 1, `type ${t} fired ${n} times (must be exactly 1)`);
    }
  });
  it('manage_power gate: skill not discovered → WEATHER_EFFECT_START suppressed', () => {
    const sw = new SpaceWeatherSystem({ catalogLoader: cl });
    sw._powerMgmtDiscovered = false;   // skill gate CLOSED
    sw._weatherAllowed = true;          // mission profile gate open

    const TS = Constants.TIME_SCALE_GAMEPLAY || 1;
    const cap = captureBus(Events.WEATHER_EFFECT_START);
    sw.update((50 * 3600) / TS);
    cap.stop();
    assert.equal(cap.events.length, 0, 'no WEATHER_EFFECT_START without manage_power skill');
  });
});
