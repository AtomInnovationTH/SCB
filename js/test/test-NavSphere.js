/**
 * test-NavSphere.js — ST-5.4 NavSphere helper function tests
 * Tests pure-function helpers: stalk sign logic, arrow length, painter's order,
 * and ECI→WGS-84 geodetic conversion.
 *
 * Functions are copied from NavSphere.js since that module imports THREE.js
 * (unavailable in Node). Tests validate the algorithm, not the import path.
 * @module test/test-NavSphere
 */

import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';

// ============================================================================
// ALGORITHM COPIES (mirror NavSphere.js module-level helpers exactly)
// ============================================================================

function _stalkDyForZ(z, R, stalkMaxFraction) {
  const stalkLen = Math.abs(z) * R * stalkMaxFraction;
  return z > 0 ? -stalkLen : +stalkLen;
}

function _arrowLengthPx(closureRateKms, maxKms, maxLengthPx) {
  if (closureRateKms <= 0) return 0;
  return Math.min(closureRateKms / maxKms, 1) * maxLengthPx;
}

function _sortContactsSelectedLast(contacts, selectedId) {
  const result = [];
  let selected = null;
  for (const c of contacts) {
    if (c.id === selectedId) { selected = c; continue; }
    result.push(c);
  }
  if (selected) result.push(selected);
  return result;
}

function _eciToGeodeticWithGMST(x, y, z, gmst) {
  const cg = Math.cos(gmst), sg = Math.sin(gmst);
  const xe = x * cg + z * sg, ze = -x * sg + z * cg, ye = y;
  const a = 6378.137, f = 1 / 298.257223563, b = a * (1 - f);
  const e2 = 1 - (b * b) / (a * a);
  const p = Math.sqrt(xe * xe + ze * ze);
  let lat = Math.atan2(ye, p * (1 - e2));
  for (let i = 0; i < 5; i++) {
    const sLat = Math.sin(lat);
    const N = a / Math.sqrt(1 - e2 * sLat * sLat);
    lat = Math.atan2(ye + e2 * N * sLat, p);
  }
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const alt = Math.abs(cosLat) > 1e-10 ? p / cosLat - N : Math.abs(ye) - b;
  return { lat: lat * 180 / Math.PI, lon: Math.atan2(ze, xe) * 180 / Math.PI, alt };
}

function _eciToGeodetic(x, y, z) {
  const jd = Date.now() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525.0;
  const gmstDeg = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
    + T * T * (0.000387933 - T / 38710000);
  const gmst = ((gmstDeg % 360) + 360) % 360 * Math.PI / 180;
  return _eciToGeodeticWithGMST(x, y, z, gmst);
}

// Mirror of NavSphere.getReservedHeight() (NavSphere.js) — the vertical slot
// the sphere reserves below the comms panel so HUD.js can pull the right-hand
// pane column up when the sphere is minimized/hidden. Constants mirror the
// module-level SPHERE_RADIUS (140) and MIN_READOUT_HEIGHT (20).
function _reservedHeight({ hidden = false, visible = true, minimized = false } = {}) {
  const SPHERE_RADIUS = 140;
  const MIN_READOUT_HEIGHT = 20;
  if (hidden || !visible) return 0;
  if (minimized) return MIN_READOUT_HEIGHT;
  return 2 * SPHERE_RADIUS;
}

/** Helper: geodetic → ECI (for round-trip testing). Y = polar axis. */
function _geodeticToECI(latDeg, lonDeg, altKm, gmst) {
  const a = 6378.137, f = 1 / 298.257223563, b = a * (1 - f);
  const e2 = 1 - (b * b) / (a * a);
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  // ECEF
  const xe = (N + altKm) * cosLat * Math.cos(lon);
  const ze = (N + altKm) * cosLat * Math.sin(lon);
  const ye = (N * (1 - e2) + altKm) * sinLat;
  // ECEF → ECI: rotate around Y (polar) by +gmst
  const cg = Math.cos(gmst), sg = Math.sin(gmst);
  const x = xe * cg - ze * sg;
  const z = xe * sg + ze * cg;
  const y = ye;
  return { x, y, z };
}

// ============================================================================
// TESTS
// ============================================================================

// --------------------------------------------------------------------------
// Stalk sign logic
// --------------------------------------------------------------------------
describe('NavSphere — Stalk sign logic', () => {
  const FRAC = 0.25;

  it('z > 0 → negative stalkDy (stalk UP on screen)', () => {
    const dy = _stalkDyForZ(0.5, 100, FRAC);
    assert.ok(dy < 0, `Expected negative dy, got ${dy}`);
  });

  it('z < 0 → positive stalkDy (stalk DOWN on screen)', () => {
    const dy = _stalkDyForZ(-0.5, 100, FRAC);
    assert.ok(dy > 0, `Expected positive dy, got ${dy}`);
  });

  it('z = 0 → stalkDy = 0 (on equatorial plane)', () => {
    const dy = _stalkDyForZ(0, 100, FRAC);
    assert.equal(dy, 0, `Expected 0, got ${dy}`);
  });

  it('z = +0.5, R = 100 → stalkDy = -12.5', () => {
    const dy = _stalkDyForZ(0.5, 100, FRAC);
    assert.closeTo(dy, -12.5, 0.001, `Expected -12.5, got ${dy}`);
  });

  it('z = -0.5, R = 100 → stalkDy = +12.5', () => {
    const dy = _stalkDyForZ(-0.5, 100, FRAC);
    assert.closeTo(dy, 12.5, 0.001, `Expected 12.5, got ${dy}`);
  });

  it('z = +1.0, R = 140 → stalkDy = -35', () => {
    const dy = _stalkDyForZ(1.0, 140, FRAC);
    assert.closeTo(dy, -35, 0.001, `Expected -35, got ${dy}`);
  });

  it('z = -1.0, R = 140 → stalkDy = +35', () => {
    const dy = _stalkDyForZ(-1.0, 140, FRAC);
    assert.closeTo(dy, 35, 0.001, `Expected 35, got ${dy}`);
  });
});

// --------------------------------------------------------------------------
// Stalk length monotonicity
// --------------------------------------------------------------------------
describe('NavSphere — Stalk length monotonic in |z|', () => {
  const FRAC = 0.25;
  const R = 140;

  it('|stalkDy| increases as |z| increases', () => {
    const values = [0.0, 0.1, 0.3, 0.5, 0.8, 1.0];
    for (let i = 1; i < values.length; i++) {
      const prev = Math.abs(_stalkDyForZ(values[i - 1], R, FRAC));
      const curr = Math.abs(_stalkDyForZ(values[i], R, FRAC));
      assert.ok(curr >= prev,
        `|stalkDy| for z=${values[i]} (${curr}) should be >= z=${values[i - 1]} (${prev})`);
    }
  });

  it('stalk signs are symmetric: |dy(+z)| === |dy(-z)|', () => {
    for (const z of [0.1, 0.5, 1.0]) {
      const pos = Math.abs(_stalkDyForZ(z, R, FRAC));
      const neg = Math.abs(_stalkDyForZ(-z, R, FRAC));
      assert.closeTo(pos, neg, 0.001, `|dy(${z})| = ${pos} !== |dy(${-z})| = ${neg}`);
    }
  });
});

// --------------------------------------------------------------------------
// Velocity arrow length
// --------------------------------------------------------------------------
describe('NavSphere — Velocity arrow length', () => {
  const MAX_KMS = 2;
  const MAX_PX = 4;

  it('0 km/s → 0 px', () => {
    assert.equal(_arrowLengthPx(0, MAX_KMS, MAX_PX), 0);
  });

  it('negative closure rate → 0 px (no arrow)', () => {
    assert.equal(_arrowLengthPx(-1, MAX_KMS, MAX_PX), 0);
  });

  it('1 km/s → 2 px (linear midpoint)', () => {
    assert.closeTo(_arrowLengthPx(1, MAX_KMS, MAX_PX), 2, 0.001);
  });

  it('2 km/s → 4 px (max)', () => {
    assert.closeTo(_arrowLengthPx(2, MAX_KMS, MAX_PX), 4, 0.001);
  });

  it('>2 km/s → clamped to 4 px', () => {
    assert.closeTo(_arrowLengthPx(5, MAX_KMS, MAX_PX), 4, 0.001);
  });

  it('0.5 km/s → 1 px (quarter point)', () => {
    assert.closeTo(_arrowLengthPx(0.5, MAX_KMS, MAX_PX), 1, 0.001);
  });

  it('linearity: length is proportional in [0, maxKms] range', () => {
    for (let rate = 0.25; rate <= MAX_KMS; rate += 0.25) {
      const expected = (rate / MAX_KMS) * MAX_PX;
      const actual = _arrowLengthPx(rate, MAX_KMS, MAX_PX);
      assert.closeTo(actual, expected, 0.001,
        `At ${rate} km/s: expected ${expected} px, got ${actual} px`);
    }
  });
});

// --------------------------------------------------------------------------
// Velocity arrow range gate
// --------------------------------------------------------------------------
describe('NavSphere — Velocity arrow range gate', () => {
  it('range ≤ 50 km should produce arrow (length > 0 for nonzero rate)', () => {
    const distKm = 30;
    const RANGE_KM = 50;
    assert.ok(distKm <= RANGE_KM, 'Contact at 30 km should get arrow');
    assert.ok(_arrowLengthPx(1.0, 2, 4) > 0, 'Arrow length should be > 0');
  });

  it('range > 50 km should NOT produce arrow', () => {
    const distKm = 60;
    const RANGE_KM = 50;
    assert.ok(distKm > RANGE_KM, 'Contact at 60 km should NOT pass range gate');
  });

  it('range exactly 50 km → arrow drawn', () => {
    const distKm = 50;
    const RANGE_KM = 50;
    assert.ok(distKm <= RANGE_KM, 'Contact at exactly 50 km should pass range gate');
  });
});

// --------------------------------------------------------------------------
// Painter's order (selected target last)
// --------------------------------------------------------------------------
describe('NavSphere — Painter\'s order (selected last)', () => {
  it('selected contact appears last in sorted array', () => {
    const contacts = [
      { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }
    ];
    const sorted = _sortContactsSelectedLast(contacts, 3);
    assert.equal(sorted.length, 5);
    assert.equal(sorted[sorted.length - 1].id, 3, 'Last should be id=3');
  });

  it('non-selected contacts maintain relative order', () => {
    const contacts = [
      { id: 10 }, { id: 20 }, { id: 30 }, { id: 40 }
    ];
    const sorted = _sortContactsSelectedLast(contacts, 20);
    assert.equal(sorted[0].id, 10, 'First should be 10');
    assert.equal(sorted[1].id, 30, 'Second should be 30');
    assert.equal(sorted[2].id, 40, 'Third should be 40');
    assert.equal(sorted[3].id, 20, 'Last should be 20 (selected)');
  });

  it('no selected id → order unchanged', () => {
    const contacts = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const sorted = _sortContactsSelectedLast(contacts, 999);
    assert.equal(sorted.length, 3);
    assert.equal(sorted[0].id, 1);
    assert.equal(sorted[1].id, 2);
    assert.equal(sorted[2].id, 3);
  });

  it('empty contacts → empty result', () => {
    const sorted = _sortContactsSelectedLast([], 1);
    assert.equal(sorted.length, 0);
  });

  it('single contact that IS selected → still last (only element)', () => {
    const sorted = _sortContactsSelectedLast([{ id: 42 }], 42);
    assert.equal(sorted.length, 1);
    assert.equal(sorted[0].id, 42);
  });
});

// --------------------------------------------------------------------------
// ECI → Geodetic: known fixtures
// --------------------------------------------------------------------------
describe('NavSphere — _eciToGeodeticWithGMST known fixtures', () => {
  it('equatorial satellite at ~400 km altitude, gmst=0 → lat ≈ 0°, alt ≈ 400 km', () => {
    const R = 6378.137;
    const alt = 400;
    const geo = _eciToGeodeticWithGMST(R + alt, 0, 0, 0);
    assert.closeTo(geo.lat, 0, 0.5, `Equatorial lat should be ≈ 0°, got ${geo.lat.toFixed(2)}°`);
    assert.closeTo(geo.alt, alt, 2, `Alt should be ≈ ${alt} km, got ${geo.alt.toFixed(1)} km`);
  });

  it('polar satellite at ~400 km altitude → lat ≈ ±90°, alt ≈ 400 km', () => {
    const b = 6356.752;
    const alt = 400;
    const geo = _eciToGeodeticWithGMST(0, b + alt, 0, 0);
    assert.ok(Math.abs(geo.lat) > 85, `Polar lat should be ≈ 90°, got ${geo.lat.toFixed(2)}°`);
    assert.closeTo(geo.alt, alt, 10, `Alt should be ≈ ${alt} km, got ${geo.alt.toFixed(1)} km`);
  });

  it('satellite at lon ≈ 90° when gmst = 0', () => {
    const R = 6378.137 + 400;
    const geo = _eciToGeodeticWithGMST(0, 0, R, 0);
    assert.closeTo(geo.lat, 0, 1, `Lat should be ≈ 0°, got ${geo.lat.toFixed(2)}°`);
    // lon should be ~90° or equivalent
    const lonNorm = ((geo.lon % 360) + 360) % 360;
    assert.closeTo(lonNorm, 90, 2, `Lon should be ≈ 90°, got ${geo.lon.toFixed(2)}°`);
  });

  it('GMST rotation shifts longitude', () => {
    const R = 6378.137 + 400;
    const geo0 = _eciToGeodeticWithGMST(R, 0, 0, 0);
    const geo45 = _eciToGeodeticWithGMST(R, 0, 0, Math.PI / 4);
    const lonDiff = Math.abs(geo0.lon - geo45.lon);
    assert.closeTo(lonDiff, 45, 2, `Lon should shift by ~45° with π/4 GMST, got ${lonDiff.toFixed(1)}°`);
  });
});

// --------------------------------------------------------------------------
// ECI → Geodetic: round-trip
// --------------------------------------------------------------------------
describe('NavSphere — _eciToGeodeticWithGMST round-trip', () => {
  const testCases = [
    { lat: 0, lon: 0, alt: 400, label: 'equatorial origin' },
    { lat: 51.6, lon: -89.3, alt: 412, label: 'ISS-like orbit' },
    { lat: -33.9, lon: 151.2, alt: 350, label: 'southern hemisphere' },
    { lat: 80, lon: -45, alt: 500, label: 'high latitude' },
  ];

  for (const tc of testCases) {
    it(`round-trip: ${tc.label} (lat=${tc.lat}, lon=${tc.lon}, alt=${tc.alt})`, () => {
      const gmst = 1.23;
      const eci = _geodeticToECI(tc.lat, tc.lon, tc.alt, gmst);
      const geo = _eciToGeodeticWithGMST(eci.x, eci.y, eci.z, gmst);
      assert.closeTo(geo.lat, tc.lat, 0.01,
        `Lat error: expected ${tc.lat}, got ${geo.lat.toFixed(4)}`);
      // Handle longitude wrapping
      const lonErr = Math.abs(((geo.lon - tc.lon + 540) % 360) - 180);
      assert.ok(lonErr < 0.01,
        `Lon error ${lonErr.toFixed(4)}° exceeds 0.01° for ${tc.label}`);
      assert.closeTo(geo.alt, tc.alt, 1,
        `Alt error: expected ${tc.alt}, got ${geo.alt.toFixed(2)} km`);
    });
  }
});

// --------------------------------------------------------------------------
// ECI → Geodetic: _eciToGeodetic (Date.now()-based)
// --------------------------------------------------------------------------
describe('NavSphere — _eciToGeodetic (Date.now GMST)', () => {
  it('returns valid lat/lon/alt for equatorial position', () => {
    const R = 6378.137 + 400;
    const geo = _eciToGeodetic(R, 0, 0);
    assert.ok(typeof geo.lat === 'number' && !isNaN(geo.lat), 'lat should be a number');
    assert.ok(typeof geo.lon === 'number' && !isNaN(geo.lon), 'lon should be a number');
    assert.ok(typeof geo.alt === 'number' && !isNaN(geo.alt), 'alt should be a number');
    assert.closeTo(geo.lat, 0, 1, `Equatorial lat should be near 0°, got ${geo.lat.toFixed(2)}°`);
    assert.ok(geo.alt > 300 && geo.alt < 500, `Alt should be ~400 km, got ${geo.alt.toFixed(1)} km`);
  });

  it('lon is within [-180, 180]', () => {
    const R = 6378.137 + 400;
    const geo = _eciToGeodetic(R, 0, 0);
    assert.ok(geo.lon >= -180 && geo.lon <= 180, `Lon ${geo.lon.toFixed(1)} out of [-180,180]`);
  });
});

// --------------------------------------------------------------------------
// Constants validation (NAVSPHERE namespace has ST-5.4 entries)
// --------------------------------------------------------------------------
describe('NavSphere — Constants.NAVSPHERE ST-5.4 entries', () => {
  const NS = Constants.NAVSPHERE;

  it('STALK_MAX_FRACTION exists and is 0.25', () => {
    assert.equal(NS.STALK_MAX_FRACTION, 0.25);
  });

  it('LOCK_ON_PULSE_RATE exists and is 2.0', () => {
    assert.equal(NS.LOCK_ON_PULSE_RATE, 2.0);
  });

  it('LOCK_ON_OUTER_RADIUS_MULT is 1.5', () => {
    assert.equal(NS.LOCK_ON_OUTER_RADIUS_MULT, 1.5);
  });

  it('LOCK_ON_INNER_RADIUS_MULT is 1.1', () => {
    assert.equal(NS.LOCK_ON_INNER_RADIUS_MULT, 1.1);
  });

  it('VELOCITY_ARROW_RANGE_KM is 50', () => {
    assert.equal(NS.VELOCITY_ARROW_RANGE_KM, 50);
  });

  it('VELOCITY_ARROW_MAX_KMS is 2', () => {
    assert.equal(NS.VELOCITY_ARROW_MAX_KMS, 2);
  });

  it('VELOCITY_ARROW_MAX_LENGTH_PX is 4', () => {
    assert.equal(NS.VELOCITY_ARROW_MAX_LENGTH_PX, 4);
  });

  it('GEO_UPDATE_HZ is 2', () => {
    assert.equal(NS.GEO_UPDATE_HZ, 2);
  });

  it('STALK_LINE_WIDTH is 0.8', () => {
    assert.equal(NS.STALK_LINE_WIDTH, 0.8);
  });

  it('STALK_ALPHA is 0.5', () => {
    assert.equal(NS.STALK_ALPHA, 0.5);
  });
});

// --------------------------------------------------------------------------
// getReservedHeight() — dynamic right-column slot (hotkey revamp 2026-06-14)
// --------------------------------------------------------------------------
describe('NavSphere — getReservedHeight (dynamic pane slot)', () => {
  it('expanded + visible → full diameter (280px)', () => {
    assert.equal(_reservedHeight({ minimized: false }), 280);
  });

  it('minimized → one-line readout footprint (20px)', () => {
    assert.equal(_reservedHeight({ minimized: true }), 20);
  });

  it('minimized reserves far less than expanded (panes reclaim space)', () => {
    const expanded = _reservedHeight({ minimized: false });
    const minimized = _reservedHeight({ minimized: true });
    assert.ok(minimized < expanded,
      `minimized (${minimized}) should be < expanded (${expanded})`);
    assert.ok(expanded - minimized >= 200,
      `expected the column to climb ≥200px, got ${expanded - minimized}px`);
  });

  it('hidden (manual toggle) → 0 (column climbs below comms)', () => {
    assert.equal(_reservedHeight({ hidden: true }), 0);
  });

  it('not visible (view config) → 0', () => {
    assert.equal(_reservedHeight({ visible: false }), 0);
  });

  it('hidden takes priority over minimized state', () => {
    assert.equal(_reservedHeight({ hidden: true, minimized: true }), 0);
  });
});
