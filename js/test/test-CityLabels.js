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
  distanceFade,
  MAX_CITIES,
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
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `C${i}`, lat: 0, lon: 0 }));
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

describe('CityLabels — data/cities.json integrity', () => {
  it('parses cleanly with every entry valid and within the cap', () => {
    const raw = JSON.parse(readFileSync(new URL('../../data/cities.json', import.meta.url), 'utf8'));
    const parsed = parseCityList(raw);
    assert.ok(parsed.length >= 20, `curated list should have 20+ cities, got ${parsed.length}`);
    assert.ok(parsed.length <= MAX_CITIES, 'within the hard cap');
    assert.equal(parsed.length, raw.cities.length, 'no entry rejected by validation');
  });
});
