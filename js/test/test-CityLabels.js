/**
 * test-CityLabels.js — UX-11 #5 Earth city labels.
 *
 * Node-tests the pure helpers only (THREE/DOM rendering is manual-verify):
 *   1. parseCityList — validation, clamping, count cap.
 *   2. isCityVisible — far-hemisphere cull math.
 *   3. distanceFade — near/far opacity ramp.
 *   4. data/cities.json — parses, all entries valid, within the cap.
 */

import { describe, it, assert } from './TestRunner.js';
import { readFileSync } from 'node:fs';
import {
  parseCityList,
  isCityVisible,
  limbFade,
  distanceFade,
  lodMaxTier,
  MAX_CITIES,
  TIER_MAX,
} from '../scene/CityLabels.js';

describe('CityLabels — parseCityList (UX-11 #5)', () => {

  it('accepts valid entries and trims names', () => {
    const out = parseCityList({ cities: [{ name: '  Tokyo ', lat: 35.68, lon: 139.69 }] });
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'Tokyo');
  });

  it('rejects malformed / out-of-range entries', () => {
    const out = parseCityList({ cities: [
      { name: '', lat: 0, lon: 0 },
      { name: 'NoLat', lon: 10 },
      { name: 'BadLat', lat: 95, lon: 0 },
      { name: 'BadLon', lat: 0, lon: 200 },
      { name: 'OK', lat: -33.87, lon: 151.21 },
      null,
    ] });
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'OK');
  });

  it('caps the list at maxCount', () => {
    const many = Array.from({ length: MAX_CITIES + 25 }, (_, i) => ({ name: `C${i}`, lat: 0, lon: 0 }));
    assert.equal(parseCityList(many).length, MAX_CITIES);
    assert.equal(parseCityList(many, 5).length, 5);
  });

  it('accepts a bare array or {cities:[…]} and tolerates garbage', () => {
    assert.equal(parseCityList([{ name: 'X', lat: 1, lon: 1 }]).length, 1);
    assert.equal(parseCityList(null).length, 0);
    assert.equal(parseCityList({}).length, 0);
  });
});

describe('CityLabels — far-hemisphere cull', () => {
  const center = { x: 0, y: 0, z: 0 };

  it('city facing the camera is visible', () => {
    const city = { x: 10, y: 0, z: 0 };
    const cam = { x: 100, y: 0, z: 0 };
    assert.equal(isCityVisible(city, center, cam), true);
  });

  it('city on the far hemisphere is culled', () => {
    const city = { x: -10, y: 0, z: 0 };
    const cam = { x: 100, y: 0, z: 0 };
    assert.equal(isCityVisible(city, center, cam), false);
  });

  it('limb city (normal ⟂ camera dir) is culled by the threshold bias', () => {
    const city = { x: 0, y: 10, z: 0 };       // normal = +Y
    const cam = { x: 1000, y: 10, z: 0 };     // dir ≈ +X
    assert.equal(isCityVisible(city, center, cam), false);
  });
});

describe('CityLabels — soft limb fade', () => {
  const center = { x: 0, y: 0, z: 0 };

  it('full opacity at the sub-camera point, zero on the far hemisphere', () => {
    const cam = { x: 100, y: 0, z: 0 };
    assert.equal(limbFade({ x: 10, y: 0, z: 0 }, center, cam), 1);   // facing camera
    assert.equal(limbFade({ x: -10, y: 0, z: 0 }, center, cam), 0);  // far side
  });

  it('ramps smoothly (0..1) through the limb band', () => {
    // City near the limb: normal almost perpendicular to the view direction,
    // giving a small facing dot (~0.09) inside the [0.04, 0.16] fade band.
    const cam = { x: 1000, y: 0, z: 0 };
    const f = limbFade({ x: 1, y: 9.95, z: 0 }, center, cam);
    assert.ok(f > 0 && f < 1, `expected partial fade, got ${f}`);
  });
});

describe('CityLabels — distance fade', () => {
  it('full opacity inside near, zero beyond far, linear between', () => {
    assert.equal(distanceFade(50, 100, 500), 1);
    assert.equal(distanceFade(600, 100, 500), 0);
    assert.ok(Math.abs(distanceFade(300, 100, 500) - 0.5) < 1e-12);
  });

  it('degenerate near/far → no fade', () => {
    assert.equal(distanceFade(123, 500, 500), 1);
  });
});

describe('CityLabels — zoom LOD tiers', () => {
  it('parseCityList clamps tier to [1, TIER_MAX] and defaults missing to 2', () => {
    const out = parseCityList({ cities: [
      { name: 'A', lat: 0, lon: 0 },           // no tier → 2
      { name: 'B', lat: 0, lon: 0, tier: 1 },
      { name: 'C', lat: 0, lon: 0, tier: 9 },  // over-cap → TIER_MAX
      { name: 'D', lat: 0, lon: 0, tier: 0 },  // under → 1
    ] });
    assert.equal(out[0].tier, 2);
    assert.equal(out[1].tier, 1);
    assert.equal(out[2].tier, TIER_MAX);
    assert.equal(out[3].tier, 1);
  });

  it('lodMaxTier reveals all tiers when close, only tier 1 when far', () => {
    assert.equal(lodMaxTier(50, 100, 500), TIER_MAX);  // at/under near → full detail
    assert.equal(lodMaxTier(600, 100, 500), 1);        // at/over far → tier 1 only
    assert.equal(lodMaxTier(300, 100, 500), 2);        // midpoint → mid tier (3-tier)
  });
});

describe('CityLabels — data/cities.json integrity', () => {
  it('parses cleanly with every entry valid and within the cap', () => {
    const raw = JSON.parse(readFileSync(new URL('../../data/cities.json', import.meta.url), 'utf8'));
    const parsed = parseCityList(raw);
    assert.ok(parsed.length >= 20, `curated list should have 20+ cities, got ${parsed.length}`);
    assert.ok(parsed.length <= MAX_CITIES, 'within the hard cap');
    assert.equal(parsed.length, raw.cities.length, 'no entry rejected by validation');
  });
});
