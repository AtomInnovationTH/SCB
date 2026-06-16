/**
 * test-Languages.js — Per-language starting-orbit invariants
 *
 * Verifies the LANGUAGES table (js/core/Languages.js) against the start-orbit
 * model added with Portuguese + per-nation inclinations:
 *
 *   • ANCHOR RULE: start.lat ≤ incDeg for every entry (else subPointToOrbit
 *     clamps to the highest reachable parallel and the opening pass misses the
 *     anchor sub-point).
 *   • VISIBILITY RULE: where the home reference differs from the anchor (e.g.
 *     Japan: Tokyo above a 30° tilt → anchor offshore), the home latitude is
 *     still within incDeg + ~10° so it reads near the limb from 350 km.
 *   • subPointToOrbit(anchor, incDeg→rad) returns finite raan / trueAnomaly in
 *     [0, 2π) and forward-projects back to the anchor latitude (incl. the
 *     retrograde 97.5° Hindi start).
 *   • English is LOCKED to the original default route (0, 0, 51.6°).
 *   • Portuguese is present (flag BRA) and sits immediately after Spanish.
 *
 * Pure data + pure math — no DOM/THREE — so it runs headless.
 *
 * @module test/test-Languages
 */

import { describe, it, assert } from './TestRunner.js';
import { LANGUAGES, getLanguage } from '../core/Languages.js';
import { subPointToOrbit } from '../entities/OrbitalMechanics.js';

const TWO_PI = 2 * Math.PI;
const DEG = Math.PI / 180;
const incOf = (l) => (Number.isFinite(l.incDeg) ? l.incDeg : 51.6);

// Sub-point latitude (deg) reproduced from the orbit elements subPointToOrbit
// returns: lat = asin(sin(inc) · sin(ν)). This is the inverse of the aiming map,
// so a correctly-aimed pass crosses exactly the anchor latitude.
function subPointLatDeg(incDeg, trueAnomaly) {
  const lat = Math.asin(Math.sin(incDeg * DEG) * Math.sin(trueAnomaly));
  return lat / DEG;
}

// Known home references for entries whose anchor is NOT the home reference and
// whose home city/feature still needs to satisfy the visibility rule.
// (anchor offshore / over a natural feature when the home lat exceeds the tilt)
//
// Note: Portuguese deliberately uses the Amazon (the anchor itself) as its
// reference — Rio at −23° is beyond clear view from a 5° track, which is fine
// because the rainforest underneath is unmistakable — so `pt` is NOT listed
// here; its reference IS the anchor and is covered by the aiming-math suite.
const HOME_REFERENCE_LAT = {
  ja: 35.68,   // Tokyo — anchor is offshore S of Honshu (28°)
};

// ─── ANCHOR RULE ───────────────────────────────────────────────────────────

describe('Languages — anchor latitude ≤ inclination (no clamp)', () => {
  for (const lang of LANGUAGES) {
    it(`${lang.code}: |anchor.lat| ≤ incDeg`, () => {
      assert.ok(lang.start && Number.isFinite(lang.start.lat) && Number.isFinite(lang.start.lon),
        `${lang.code} has a finite start sub-point`);
      const inc = incOf(lang);
      assert.ok(Math.abs(lang.start.lat) <= inc + 1e-9,
        `${lang.code}: |anchor.lat ${lang.start.lat}| must be ≤ incDeg ${inc}`);
    });
  }
});

// ─── VISIBILITY RULE ─────────────────────────────────────────────────────────

describe('Languages — home reference visible (homeLat ≤ incDeg + 10°)', () => {
  for (const lang of LANGUAGES) {
    const homeLat = HOME_REFERENCE_LAT[lang.code];
    if (homeLat === undefined) continue;   // anchor IS the home reference
    it(`${lang.code}: |homeLat| ≤ incDeg + 10`, () => {
      const inc = incOf(lang);
      assert.ok(Math.abs(homeLat) <= inc + 10 + 1e-9,
        `${lang.code}: |homeLat ${homeLat}| should be ≤ incDeg ${inc} + 10`);
    });
  }
});

// ─── AIMING MATH ─────────────────────────────────────────────────────────────

describe('Languages — subPointToOrbit aims each opening pass correctly', () => {
  for (const lang of LANGUAGES) {
    it(`${lang.code}: returns finite raan/ν in [0, 2π) over the anchor latitude`, () => {
      const inc = incOf(lang);
      const { raan, trueAnomaly } = subPointToOrbit(lang.start.lat, lang.start.lon, inc * DEG);

      assert.ok(Number.isFinite(raan) && raan >= 0 && raan < TWO_PI,
        `${lang.code}: raan out of [0,2π): ${raan}`);
      assert.ok(Number.isFinite(trueAnomaly) && trueAnomaly >= 0 && trueAnomaly < TWO_PI,
        `${lang.code}: trueAnomaly out of [0,2π): ${trueAnomaly}`);

      // Forward-project: the resulting sub-point latitude must equal the anchor.
      const lat = subPointLatDeg(inc, trueAnomaly);
      assert.closeTo(lat, lang.start.lat, 1e-6,
        `${lang.code}: aimed sub-point latitude ${lat} ≠ anchor ${lang.start.lat}`);
    });
  }

  it('hi: retrograde 97.5° start still reproduces the Delhi anchor latitude', () => {
    const hi = getLanguage('hi');
    assert.equal(incOf(hi), 97.5);
    const { trueAnomaly } = subPointToOrbit(hi.start.lat, hi.start.lon, 97.5 * DEG);
    const lat = subPointLatDeg(97.5, trueAnomaly);
    assert.closeTo(lat, hi.start.lat, 1e-6, 'retrograde anchor latitude mismatch');
  });
});

// ─── ENGLISH LOCKED ──────────────────────────────────────────────────────────

describe('Languages — English locked to the original default route', () => {
  it('en → Gulf of Guinea (0, 0) at 51.6°', () => {
    const en = getLanguage('en');
    assert.equal(en.start.lat, 0, 'en anchor lat must be 0');
    assert.equal(en.start.lon, 0, 'en anchor lon must be 0');
    assert.equal(incOf(en), 51.6, 'en incDeg must be 51.6');
  });

  it('en aim resolves to raan = 0, ν = 0', () => {
    const { raan, trueAnomaly } = subPointToOrbit(0, 0, 51.6 * DEG);
    assert.closeTo(raan, 0, 1e-9, 'en raan must be 0');
    assert.closeTo(trueAnomaly, 0, 1e-9, 'en ν must be 0');
  });
});

// ─── PORTUGUESE PRESENT + ORDER ──────────────────────────────────────────────

describe('Languages — Portuguese present and ordered after Spanish', () => {
  it('pt entry exists with flag BRA and incDeg 5°', () => {
    const pt = getLanguage('pt');
    assert.equal(pt.code, 'pt');
    assert.equal(pt.flag, 'BRA', 'Portuguese uses the BRA flag (FlagDecalSystem._paintBRA)');
    assert.equal(incOf(pt), 5.0, 'Portuguese starts at the ~5° Alcântara equatorial tilt');
    assert.equal(pt.sight, 'Amazon Rainforest');
  });

  it('menu order is en, th, ja, es, pt, hi, ta', () => {
    const order = LANGUAGES.map(l => l.code);
    assert.deepEqual(order, ['en', 'th', 'ja', 'es', 'pt', 'hi', 'ta']);
  });

  it('pt sits immediately after es', () => {
    const codes = LANGUAGES.map(l => l.code);
    assert.equal(codes[codes.indexOf('es') + 1], 'pt', 'Portuguese must follow Spanish');
  });
});
