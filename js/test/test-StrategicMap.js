/**
 * test-StrategicMap.js — ST-6.4 Strategic Map unit tests
 *
 * Tests pure-logic helpers (Node-safe, no THREE/DOM) and lightweight
 * class state management via mock deps.
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { Events } from '../core/Events.js';
import {
  keplerianToOrbitPoints,
  latLonToPosition,
  catalogTypeToColor,
  formatThreatList,
  StrategicMap,
} from '../ui/StrategicMap.js';

// ============================================================================
// keplerianToOrbitPoints
// ============================================================================

describe('StrategicMap — keplerianToOrbitPoints (circular)', () => {
  const circularOrbit = {
    semiMajorAxis: 7000,   // km (≈ 630 km altitude)
    eccentricity: 0,
    inclination: 0,
    raan: 0,
    argPerigee: 0,
  };

  it('returns 64 points by default', () => {
    const pts = keplerianToOrbitPoints(circularOrbit);
    assert.equal(pts.length, 64, `Expected 64 points, got ${pts.length}`);
  });

  it('all points approximately equidistant from origin (circular, 0.1% tol)', () => {
    const pts = keplerianToOrbitPoints(circularOrbit);
    const expected = 7000; // km
    for (let i = 0; i < pts.length; i++) {
      const r = Math.sqrt(pts[i].x ** 2 + pts[i].y ** 2 + pts[i].z ** 2);
      const err = Math.abs(r - expected) / expected;
      assert.ok(err < 0.001,
        `Point ${i}: distance ${r.toFixed(2)} km, expected ~${expected} km (err ${(err * 100).toFixed(4)}%)`);
    }
  });

  it('respects custom segment count', () => {
    const pts = keplerianToOrbitPoints(circularOrbit, 32);
    assert.equal(pts.length, 32);
  });
});

describe('StrategicMap — keplerianToOrbitPoints (elliptical)', () => {
  const ellipticalOrbit = {
    semiMajorAxis: 10000,
    eccentricity: 0.1,
    inclination: 0.5,
    raan: 1.0,
    argPerigee: 0.3,
  };

  it('periapsis < apoapsis in returned points', () => {
    const pts = keplerianToOrbitPoints(ellipticalOrbit, 128);
    const distances = pts.map(p => Math.sqrt(p.x ** 2 + p.y ** 2 + p.z ** 2));
    const minR = Math.min(...distances);
    const maxR = Math.max(...distances);
    const expectedPeri = 10000 * (1 - 0.1); // 9000 km
    const expectedApo = 10000 * (1 + 0.1);  // 11000 km

    assert.ok(minR < maxR, `Min (${minR.toFixed(1)}) should be < Max (${maxR.toFixed(1)})`);
    assert.closeTo(minR, expectedPeri, 50,
      `Periapsis ${minR.toFixed(1)} should be near ${expectedPeri}`);
    assert.closeTo(maxR, expectedApo, 50,
      `Apoapsis ${maxR.toFixed(1)} should be near ${expectedApo}`);
  });
});

// ============================================================================
// latLonToPosition
// ============================================================================

describe('StrategicMap — latLonToPosition', () => {
  const R = 63.71; // Earth radius in scene units

  it('lat=0, lon=0 → point on equator at +X axis', () => {
    const p = latLonToPosition(0, 0, R);
    assert.closeTo(p.x, R, 0.01, `x should be ${R}`);
    assert.closeTo(p.y, 0, 0.01, 'y should be 0');
    assert.closeTo(p.z, 0, 0.01, 'z should be 0');
  });

  it('lat=90 → point at +Y (north pole)', () => {
    const p = latLonToPosition(90, 0, R);
    assert.closeTo(p.y, R, 0.01, `y should be ${R}`);
    assert.closeTo(p.x, 0, 0.5, 'x should be ~0');
    assert.closeTo(p.z, 0, 0.5, 'z should be ~0');
  });

  it('lat=0, lon=180 → point at -X axis (antipodal)', () => {
    const p = latLonToPosition(0, 180, R);
    assert.closeTo(p.x, -R, 0.01, `x should be ${-R}`);
    assert.closeTo(p.y, 0, 0.01, 'y should be 0');
    // z may have floating point noise near 0
    assert.ok(Math.abs(p.z) < 0.1, `z should be near 0, got ${p.z}`);
  });

  it('lat=-90 → point at -Y (south pole)', () => {
    const p = latLonToPosition(-90, 0, R);
    assert.closeTo(p.y, -R, 0.01, `y should be ${-R}`);
  });

  it('distance from origin equals radius', () => {
    const cases = [
      [45, 90], [30, -120], [-60, 45], [0, 270],
    ];
    for (const [lat, lon] of cases) {
      const p = latLonToPosition(lat, lon, R);
      const dist = Math.sqrt(p.x ** 2 + p.y ** 2 + p.z ** 2);
      assert.closeTo(dist, R, 0.01,
        `lat=${lat}, lon=${lon}: distance ${dist.toFixed(4)} ≠ ${R}`);
    }
  });
});

// ============================================================================
// catalogTypeToColor
// ============================================================================

describe('StrategicMap — catalogTypeToColor', () => {
  const SM = Constants.STRATEGIC_MAP;

  it('debris → DOT_COLOR_DEBRIS', () => {
    assert.equal(catalogTypeToColor('debris', SM), SM.DOT_COLOR_DEBRIS);
  });

  it('rocket_body → DOT_COLOR_ROCKET_BODY', () => {
    assert.equal(catalogTypeToColor('rocket_body', SM), SM.DOT_COLOR_ROCKET_BODY);
  });

  it('inactive → DOT_COLOR_INACTIVE', () => {
    assert.equal(catalogTypeToColor('inactive', SM), SM.DOT_COLOR_INACTIVE);
  });

  it('active → DOT_COLOR_ACTIVE', () => {
    assert.equal(catalogTypeToColor('active', SM), SM.DOT_COLOR_ACTIVE);
  });

  it('fragment → DOT_COLOR_FRAGMENT', () => {
    assert.equal(catalogTypeToColor('fragment', SM), SM.DOT_COLOR_FRAGMENT);
  });

  it('unknown type → DOT_COLOR_FALLBACK', () => {
    assert.equal(catalogTypeToColor('alien_probe', SM), SM.DOT_COLOR_FALLBACK);
  });
});

// ============================================================================
// formatThreatList
// ============================================================================

describe('StrategicMap — formatThreatList', () => {
  const mockDebrisField = {
    getDebrisById: (id) => {
      const map = {
        'D001': { name: 'Fengyun-1C DEB', moidBadge: 'HI' },
        'D002': { name: 'COSMOS 2251 DEB', moidBadge: 'MD' },
        'D003': { name: 'ATLAS V R/B', moidBadge: 'LO' },
      };
      return map[id] || null;
    },
  };

  it('formats top risk pairs correctly', () => {
    const pairs = [
      { id: 'D001', moid: 3200 },   // 3.2 km
      { id: 'D002', moid: 18700 },  // 18.7 km
      { id: 'D003', moid: 67100 },  // 67.1 km
    ];
    const result = formatThreatList(pairs, mockDebrisField);
    assert.equal(result.length, 3);

    assert.equal(result[0].badge, 'HI');
    assert.equal(result[0].name, 'Fengyun-1C DEB');
    assert.equal(result[0].moidKm, '3.2');
    assert.ok(result[0].line.includes('[HI]'), 'Line should contain [HI]');
    assert.ok(result[0].line.includes('Fengyun-1C DEB'), 'Line should contain name');
    assert.ok(result[0].line.includes('3.2 km'), 'Line should contain MOID');

    assert.equal(result[1].badge, 'MD');
    assert.equal(result[2].badge, 'LO');
  });

  it('returns empty array for null/empty input', () => {
    assert.deepEqual(formatThreatList(null, mockDebrisField), []);
    assert.deepEqual(formatThreatList([], mockDebrisField), []);
  });

  it('handles unknown debris (no name) gracefully', () => {
    const pairs = [{ id: 'UNKNOWN', moid: 5000 }];
    const result = formatThreatList(pairs, mockDebrisField);
    assert.equal(result.length, 1);
    assert.ok(result[0].name.includes('OBJ-'), 'Should fall back to OBJ-id');
  });
});

// ============================================================================
// StrategicMap — toggle state
// ============================================================================

describe('StrategicMap — toggle state', () => {
  // Create with mock deps that are Node-safe (no THREE, no DOM)
  function createMockMap() {
    const emitted = [];
    const mockBus = {
      emit: (evt, data) => emitted.push({ evt, data }),
      on: () => {},
    };
    const map = new StrategicMap({
      scene: null,
      renderer: null,
      catalogLoader: null,
      debrisField: null,
      playerSatellite: null,
      conjunctionSystem: null,
      environmentSystem: null,
      eventBus: mockBus,
    });
    // Don't call init() — no THREE.js available in Node
    return { map, emitted };
  }

  it('isOpen() is false initially', () => {
    const { map } = createMockMap();
    assert.equal(map.isOpen(), false, 'Should start closed');
  });

  it('open() → isOpen() true', () => {
    const { map } = createMockMap();
    map.open();
    assert.equal(map.isOpen(), true, 'Should be open after open()');
  });

  it('close() → isOpen() false', () => {
    const { map } = createMockMap();
    map.open();
    map.close();
    assert.equal(map.isOpen(), false, 'Should be closed after close()');
  });

  it('open() emits STRATEGIC_MAP_OPENED', () => {
    const { map, emitted } = createMockMap();
    map.open();
    const opened = emitted.find(e => e.evt === Events.STRATEGIC_MAP_OPENED);
    assert.ok(opened, 'STRATEGIC_MAP_OPENED should be emitted');
  });

  it('close() emits STRATEGIC_MAP_CLOSED', () => {
    const { map, emitted } = createMockMap();
    map.open();
    map.close();
    const closed = emitted.find(e => e.evt === Events.STRATEGIC_MAP_CLOSED);
    assert.ok(closed, 'STRATEGIC_MAP_CLOSED should be emitted');
  });

  it('double open() is idempotent', () => {
    const { map, emitted } = createMockMap();
    map.open();
    map.open();
    const openedEvents = emitted.filter(e => e.evt === Events.STRATEGIC_MAP_OPENED);
    assert.equal(openedEvents.length, 1, 'Should only emit once');
  });
});

// ============================================================================
// StrategicMap — hazard overlay toggle
// ============================================================================

describe('StrategicMap — hazardOverlays', () => {
  function createMockMap() {
    const map = new StrategicMap({
      scene: null, renderer: null, catalogLoader: null, debrisField: null,
      playerSatellite: null, conjunctionSystem: null, environmentSystem: null,
      eventBus: { emit: () => {}, on: () => {} },
    });
    return map;
  }

  it('setHazardOverlays(true) sets internal flag', () => {
    const map = createMockMap();
    map.setHazardOverlays(true);
    assert.equal(map._hazardOverlays, true);
  });

  it('setHazardOverlays(false) clears internal flag', () => {
    const map = createMockMap();
    map.setHazardOverlays(false);
    assert.equal(map._hazardOverlays, false);
  });
});

// ============================================================================
// Constants validation
// ============================================================================

describe('StrategicMap — Constants.STRATEGIC_MAP', () => {
  it('STRATEGIC_MAP namespace exists', () => {
    assert.ok(Constants.STRATEGIC_MAP, 'Constants.STRATEGIC_MAP must be defined');
  });

  it('has all expected fields (≥30)', () => {
    const keys = Object.keys(Constants.STRATEGIC_MAP);
    assert.ok(keys.length >= 30,
      `Expected ≥30 fields, got ${keys.length}: ${keys.join(', ')}`);
  });

  it('CAMERA fields are valid', () => {
    const SM = Constants.STRATEGIC_MAP;
    assert.equal(typeof SM.CAMERA_FOV, 'number');
    assert.ok(SM.CAMERA_FOV > 0 && SM.CAMERA_FOV < 180);
    assert.equal(typeof SM.CAMERA_NEAR, 'number');
    assert.ok(SM.CAMERA_NEAR > 0);
    assert.equal(typeof SM.CAMERA_FAR, 'number');
    assert.ok(SM.CAMERA_FAR > SM.CAMERA_NEAR);
    assert.equal(typeof SM.CAMERA_INITIAL_DISTANCE, 'number');
    assert.ok(SM.CAMERA_INITIAL_DISTANCE > 0);
  });

  it('ZOOM_MIN < ZOOM_MAX', () => {
    const SM = Constants.STRATEGIC_MAP;
    assert.ok(SM.ZOOM_MIN < SM.ZOOM_MAX,
      `ZOOM_MIN (${SM.ZOOM_MIN}) should be < ZOOM_MAX (${SM.ZOOM_MAX})`);
  });

  it('ALT_BAND_COLORS length matches DEBRIS.ALT_BANDS length', () => {
    const SM = Constants.STRATEGIC_MAP;
    const bands = Constants.DEBRIS.ALT_BANDS;
    assert.equal(SM.ALT_BAND_COLORS.length, bands.length,
      `ALT_BAND_COLORS (${SM.ALT_BAND_COLORS.length}) ≠ ALT_BANDS (${bands.length})`);
    assert.equal(SM.ALT_BAND_OPACITY.length, bands.length,
      `ALT_BAND_OPACITY (${SM.ALT_BAND_OPACITY.length}) ≠ ALT_BANDS (${bands.length})`);
  });

  it('dot colour strings are hex format', () => {
    const SM = Constants.STRATEGIC_MAP;
    const hexRe = /^#[0-9a-fA-F]{6}$/;
    assert.ok(hexRe.test(SM.DOT_COLOR_DEBRIS), `DOT_COLOR_DEBRIS: "${SM.DOT_COLOR_DEBRIS}"`);
    assert.ok(hexRe.test(SM.DOT_COLOR_ROCKET_BODY), `DOT_COLOR_ROCKET_BODY: "${SM.DOT_COLOR_ROCKET_BODY}"`);
    assert.ok(hexRe.test(SM.DOT_COLOR_INACTIVE), `DOT_COLOR_INACTIVE: "${SM.DOT_COLOR_INACTIVE}"`);
    assert.ok(hexRe.test(SM.DOT_COLOR_ACTIVE), `DOT_COLOR_ACTIVE: "${SM.DOT_COLOR_ACTIVE}"`);
    assert.ok(hexRe.test(SM.DOT_COLOR_FRAGMENT), `DOT_COLOR_FRAGMENT: "${SM.DOT_COLOR_FRAGMENT}"`);
    assert.ok(hexRe.test(SM.DOT_COLOR_FALLBACK), `DOT_COLOR_FALLBACK: "${SM.DOT_COLOR_FALLBACK}"`);
  });
});

// ============================================================================
// Events validation
// ============================================================================

describe('StrategicMap — Events', () => {
  it('STRATEGIC_MAP_TOGGLE exists', () => {
    assert.ok(Events.STRATEGIC_MAP_TOGGLE, 'STRATEGIC_MAP_TOGGLE should exist');
    assert.equal(typeof Events.STRATEGIC_MAP_TOGGLE, 'string');
  });

  it('STRATEGIC_MAP_OPENED exists', () => {
    assert.ok(Events.STRATEGIC_MAP_OPENED, 'STRATEGIC_MAP_OPENED should exist');
    assert.equal(typeof Events.STRATEGIC_MAP_OPENED, 'string');
  });

  it('STRATEGIC_MAP_CLOSED exists', () => {
    assert.ok(Events.STRATEGIC_MAP_CLOSED, 'STRATEGIC_MAP_CLOSED should exist');
    assert.equal(typeof Events.STRATEGIC_MAP_CLOSED, 'string');
  });

  it('all three event strings are unique', () => {
    const vals = new Set([
      Events.STRATEGIC_MAP_TOGGLE,
      Events.STRATEGIC_MAP_OPENED,
      Events.STRATEGIC_MAP_CLOSED,
    ]);
    assert.equal(vals.size, 3, 'All 3 event strings must be unique');
  });
});

// ============================================================================
// Ground station count (mock)
// ============================================================================

describe('StrategicMap — ground station count (mock)', () => {
  it('_groundStationCount tracks catalogLoader station count', () => {
    // Without init (no THREE), we can't test the actual point creation,
    // but we can verify the constructor stores catalogLoader for later use
    const mockCatalog = {
      getAllGroundStations: () => new Array(20).fill({ lat: 0, lon: 0 }),
    };
    const map = new StrategicMap({
      scene: null, renderer: null, catalogLoader: mockCatalog, debrisField: null,
      playerSatellite: null, conjunctionSystem: null, environmentSystem: null,
      eventBus: { emit: () => {}, on: () => {} },
    });
    // _catalogLoader should be stored
    assert.ok(map._catalogLoader, 'catalogLoader should be stored');
    assert.equal(map._catalogLoader.getAllGroundStations().length, 20,
      'Should have 20 mock ground stations');
  });
});

// ============================================================================
// ALT_BAND ring count
// ============================================================================

describe('StrategicMap — ALT_BAND ring count', () => {
  it('7 altitude bands defined in Constants', () => {
    assert.equal(Constants.DEBRIS.ALT_BANDS.length, 7,
      `Expected 7 bands, got ${Constants.DEBRIS.ALT_BANDS.length}`);
  });

  it('ALT_BAND_COLORS has 7 entries matching band count', () => {
    assert.equal(Constants.STRATEGIC_MAP.ALT_BAND_COLORS.length, 7);
    assert.equal(Constants.STRATEGIC_MAP.ALT_BAND_OPACITY.length, 7);
  });
});
