/**
 * test-DebrisTextureAtlas.js — ST-6.2 Debris Texture Atlas + Flag Decal System tests
 * Tests pure-logic methods only (UV math, colour lookups, flag checks, MOID emissive).
 * Node-safe: no Canvas2D / no THREE.js / no DOM.
 */

import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import {
  getUVOffsetForType,
  getBaseColorForType,
  getEmissiveForMOID,
  TYPE_ORDER,
} from '../ui/DebrisTextureAtlas.js';
import {
  getUVOffsetForCountry,
  hasFlag,
  COUNTRY_ORDER,
  isFlagEligible,
  pickCountryForId,
} from '../ui/FlagDecalSystem.js';

// ============================================================================
// 1. Atlas grid math — UV offsets for type slots
// ============================================================================

describe('DebrisTextureAtlas — Type UV offset math', () => {
  const C = Constants.DEBRIS_VISUAL;
  const COLS = C.TYPE_SLOT_COLS;
  const ROWS = C.TYPE_SLOT_ROWS;

  it('TYPE_ORDER has exactly 6 entries', () => {
    assert.equal(TYPE_ORDER.length, 6);
  });

  it('getUVOffsetForType returns valid UVs for all 6 types', () => {
    for (const t of TYPE_ORDER) {
      const uv = getUVOffsetForType(t);
      assert.ok(uv.offsetU >= 0 && uv.offsetU < 1,
        `${t}: offsetU ${uv.offsetU} should be in [0,1)`);
      assert.ok(uv.offsetV >= 0 && uv.offsetV < 1,
        `${t}: offsetV ${uv.offsetV} should be in [0,1)`);
      assert.ok(uv.scaleU > 0, `${t}: scaleU ${uv.scaleU} must be > 0`);
      assert.ok(uv.scaleV > 0, `${t}: scaleV ${uv.scaleV} must be > 0`);
      assert.ok(uv.offsetU + uv.scaleU <= 1.001,
        `${t}: offsetU+scaleU ${uv.offsetU + uv.scaleU} must be ≤ 1`);
      assert.ok(uv.offsetV + uv.scaleV <= 1.001,
        `${t}: offsetV+scaleV ${uv.offsetV + uv.scaleV} must be ≤ 1`);
    }
  });

  it('each type maps to a unique (offsetU, offsetV) pair', () => {
    const pairs = new Set();
    for (const t of TYPE_ORDER) {
      const uv = getUVOffsetForType(t);
      const key = `${uv.offsetU.toFixed(4)},${uv.offsetV.toFixed(4)}`;
      assert.ok(!pairs.has(key), `duplicate UV slot for ${t}: ${key}`);
      pairs.add(key);
    }
    assert.equal(pairs.size, 6);
  });

  it('scaleU = 1/COLS and scaleV = 1/ROWS', () => {
    const uv = getUVOffsetForType('debris');
    assert.closeTo(uv.scaleU, 1 / COLS, 1e-6);
    assert.closeTo(uv.scaleV, 1 / ROWS, 1e-6);
  });

  it('slot (0,0) = debris → offsetU=0, offsetV=0.5', () => {
    const uv = getUVOffsetForType('debris');
    assert.closeTo(uv.offsetU, 0, 1e-6);
    assert.closeTo(uv.offsetV, 0.5, 1e-6);
  });

  it('slot (1,0) = rocket_body → offsetU=1/3', () => {
    const uv = getUVOffsetForType('rocket_body');
    assert.closeTo(uv.offsetU, 1 / 3, 1e-4);
    assert.closeTo(uv.offsetV, 0.5, 1e-6);
  });
});

// ============================================================================
// 2. Base colour lookups for all 6 types
// ============================================================================

describe('DebrisTextureAtlas — Base colour for type', () => {
  const C = Constants.DEBRIS_VISUAL;

  it('getBaseColorForType("debris") returns COLOR_DEBRIS', () => {
    assert.equal(getBaseColorForType('debris'), C.COLOR_DEBRIS);
  });

  it('getBaseColorForType("rocket_body") returns COLOR_ROCKET_BODY', () => {
    assert.equal(getBaseColorForType('rocket_body'), C.COLOR_ROCKET_BODY);
  });

  it('getBaseColorForType("inactive") returns COLOR_INACTIVE', () => {
    assert.equal(getBaseColorForType('inactive'), C.COLOR_INACTIVE);
  });

  it('getBaseColorForType("active") returns COLOR_ACTIVE', () => {
    assert.equal(getBaseColorForType('active'), C.COLOR_ACTIVE);
  });

  it('getBaseColorForType("unknown") returns COLOR_UNKNOWN', () => {
    assert.equal(getBaseColorForType('unknown'), C.COLOR_UNKNOWN);
  });

  it('getBaseColorForType("fragment") returns COLOR_FRAGMENT', () => {
    assert.equal(getBaseColorForType('fragment'), C.COLOR_FRAGMENT);
  });

  it('unknown type falls back to COLOR_UNKNOWN (not undefined)', () => {
    const color = getBaseColorForType('nonexistent_garbage_type');
    assert.equal(color, C.COLOR_UNKNOWN);
    assert.ok(color !== undefined && color !== null, 'should not be null/undefined');
  });

  it('all 6 colours are non-empty hex strings', () => {
    const hexRe = /^#[0-9a-fA-F]{6}$/;
    for (const t of TYPE_ORDER) {
      const c = getBaseColorForType(t);
      assert.ok(hexRe.test(c), `${t}: "${c}" should be a #RRGGBB hex string`);
    }
  });
});

// ============================================================================
// 3. Flag UV math — 15 countries + unknown fallback
// ============================================================================

describe('FlagDecalSystem — Country UV offset math', () => {
  const C = Constants.DEBRIS_VISUAL;
  const COLS = C.FLAG_SLOT_COLS;
  const ROWS = C.FLAG_SLOT_ROWS;

  it('COUNTRY_ORDER has 16 entries (15 countries + unknown)', () => {
    assert.equal(COUNTRY_ORDER.length, 16);
  });

  it('getUVOffsetForCountry returns valid UVs for all 15 real countries', () => {
    const realCountries = COUNTRY_ORDER.filter(c => c !== '???');
    for (const cc of realCountries) {
      const uv = getUVOffsetForCountry(cc);
      assert.ok(uv.offsetU >= 0 && uv.offsetU < 1,
        `${cc}: offsetU ${uv.offsetU} in [0,1)`);
      assert.ok(uv.offsetV >= 0 && uv.offsetV < 1,
        `${cc}: offsetV ${uv.offsetV} in [0,1)`);
      assert.ok(uv.scaleU > 0, `${cc}: scaleU > 0`);
      assert.ok(uv.scaleV > 0, `${cc}: scaleV > 0`);
      assert.ok(uv.offsetU + uv.scaleU <= 1.001,
        `${cc}: offsetU+scaleU ≤ 1`);
      assert.ok(uv.offsetV + uv.scaleV <= 1.001,
        `${cc}: offsetV+scaleV ≤ 1`);
    }
  });

  it('each country maps to a unique UV slot', () => {
    const pairs = new Set();
    for (const cc of COUNTRY_ORDER) {
      const uv = getUVOffsetForCountry(cc);
      const key = `${uv.offsetU.toFixed(4)},${uv.offsetV.toFixed(4)}`;
      assert.ok(!pairs.has(key), `duplicate UV slot for ${cc}: ${key}`);
      pairs.add(key);
    }
    assert.equal(pairs.size, 16);
  });

  it('scaleU = 1/FLAG_COLS and scaleV = 1/FLAG_ROWS', () => {
    const uv = getUVOffsetForCountry('USA');
    assert.closeTo(uv.scaleU, 1 / COLS, 1e-6);
    assert.closeTo(uv.scaleV, 1 / ROWS, 1e-6);
  });
});

// ============================================================================
// 4. Unknown country fallback
// ============================================================================

describe('FlagDecalSystem — Unknown country fallback', () => {
  it('getUVOffsetForCountry("XYZ") returns the "???" fallback slot', () => {
    const unknownUV = getUVOffsetForCountry('???');
    const xyzUV = getUVOffsetForCountry('XYZ');
    assert.closeTo(xyzUV.offsetU, unknownUV.offsetU, 1e-6);
    assert.closeTo(xyzUV.offsetV, unknownUV.offsetV, 1e-6);
    assert.closeTo(xyzUV.scaleU, unknownUV.scaleU, 1e-6);
    assert.closeTo(xyzUV.scaleV, unknownUV.scaleV, 1e-6);
  });

  it('getUVOffsetForCountry(null-ish) returns fallback slot', () => {
    const unknownUV = getUVOffsetForCountry('???');
    const uv = getUVOffsetForCountry('');
    assert.closeTo(uv.offsetU, unknownUV.offsetU, 1e-6);
  });

  it('country alias "RUS" resolves to "CIS" slot', () => {
    const cisUV = getUVOffsetForCountry('CIS');
    const rusUV = getUVOffsetForCountry('RUS');
    assert.closeTo(rusUV.offsetU, cisUV.offsetU, 1e-6);
    assert.closeTo(rusUV.offsetV, cisUV.offsetV, 1e-6);
  });

  it('country alias "CHN" resolves to "PRC" slot', () => {
    const prcUV = getUVOffsetForCountry('PRC');
    const chnUV = getUVOffsetForCountry('CHN');
    assert.closeTo(chnUV.offsetU, prcUV.offsetU, 1e-6);
    assert.closeTo(chnUV.offsetV, prcUV.offsetV, 1e-6);
  });
});

// ============================================================================
// 5. hasFlag truth table
// ============================================================================

describe('FlagDecalSystem — hasFlag()', () => {
  it('hasFlag("USA") → true', () => {
    assert.equal(hasFlag('USA'), true);
  });

  it('hasFlag("CIS") → true', () => {
    assert.equal(hasFlag('CIS'), true);
  });

  it('hasFlag("JPN") → true', () => {
    assert.equal(hasFlag('JPN'), true);
  });

  it('hasFlag("XYZ") → false', () => {
    assert.equal(hasFlag('XYZ'), false);
  });

  it('hasFlag("???") → false (fallback slot is not a "real" flag)', () => {
    assert.equal(hasFlag('???'), false);
  });

  it('hasFlag("RUS") → true (alias to CIS)', () => {
    assert.equal(hasFlag('RUS'), true);
  });

  it('hasFlag("CHN") → true (alias to PRC)', () => {
    assert.equal(hasFlag('CHN'), true);
  });

  it('all 15 real countries return true', () => {
    const realCountries = COUNTRY_ORDER.filter(c => c !== '???');
    for (const cc of realCountries) {
      assert.ok(hasFlag(cc), `hasFlag("${cc}") should be true`);
    }
  });
});

// ============================================================================
// 6. MOID emissive mapping
// ============================================================================

describe('DebrisTextureAtlas — MOID emissive mapping', () => {
  const C = Constants.DEBRIS_VISUAL;

  it('moidBadge "HI" → intensity = EMISSIVE_HI_INTENSITY', () => {
    const e = getEmissiveForMOID('HI');
    assert.equal(e.intensity, C.EMISSIVE_HI_INTENSITY);
  });

  it('moidBadge "MD" → intensity = EMISSIVE_MD_INTENSITY', () => {
    const e = getEmissiveForMOID('MD');
    assert.equal(e.intensity, C.EMISSIVE_MD_INTENSITY);
  });

  it('moidBadge "LO" → intensity = 0 (no glow)', () => {
    const e = getEmissiveForMOID('LO');
    assert.equal(e.intensity, 0);
  });

  it('moidBadge null → intensity = 0', () => {
    const e = getEmissiveForMOID(null);
    assert.equal(e.intensity, 0);
  });

  it('moidBadge undefined → intensity = 0', () => {
    const e = getEmissiveForMOID(undefined);
    assert.equal(e.intensity, 0);
  });

  it('HI colour matches CONJUNCTION.BADGE_COLOR_HI', () => {
    const e = getEmissiveForMOID('HI');
    assert.equal(e.color, Constants.CONJUNCTION.BADGE_COLOR_HI);
  });

  it('MD colour matches CONJUNCTION.BADGE_COLOR_MD', () => {
    const e = getEmissiveForMOID('MD');
    assert.equal(e.color, Constants.CONJUNCTION.BADGE_COLOR_MD);
  });

  it('null badge returns black colour (#000000)', () => {
    const e = getEmissiveForMOID(null);
    assert.equal(e.color, '#000000');
  });
});

// ============================================================================
// 7. Wireframe toggle defaults
// ============================================================================

describe('DebrisTextureAtlas — Wireframe toggle', () => {
  it('DEFAULT_MODE is "textured"', () => {
    assert.equal(Constants.DEBRIS_VISUAL.DEFAULT_MODE, 'textured');
  });

  it('wireframe mode string is an accepted alternative', () => {
    // Confirm the constant namespace acknowledges both modes
    assert.ok(
      Constants.DEBRIS_VISUAL.DEFAULT_MODE === 'textured' ||
      Constants.DEBRIS_VISUAL.DEFAULT_MODE === 'wireframe',
      'DEFAULT_MODE must be textured or wireframe'
    );
  });
});

// ============================================================================
// 8. PROC_TYPE_TO_CATALOG mapping coverage (inline check)
// ============================================================================

describe('DebrisTextureAtlas — Procedural type mapping', () => {
  // Mirror the mapping from DebrisField.js
  const PROC_TYPE_TO_CATALOG = {
    fragment:      'debris',
    rocketBody:    'rocket_body',
    defunctSat:    'inactive',
    missionDebris: 'debris',
  };

  it('all 4 procedural types map to valid atlas catalogTypes', () => {
    for (const [procType, catType] of Object.entries(PROC_TYPE_TO_CATALOG)) {
      assert.ok(TYPE_ORDER.includes(catType),
        `${procType} → "${catType}" should be in TYPE_ORDER`);
    }
  });

  it('getUVOffsetForType returns valid UVs for all mapped catalogTypes', () => {
    const mapped = new Set(Object.values(PROC_TYPE_TO_CATALOG));
    for (const catType of mapped) {
      const uv = getUVOffsetForType(catType);
      assert.ok(uv.scaleU > 0, `${catType}: scaleU > 0`);
      assert.ok(uv.offsetU >= 0, `${catType}: offsetU >= 0`);
    }
  });
});

// ============================================================================
// Item 12 (2026-06-12): flag eligibility gating + procedural country pick
// ============================================================================

describe('FlagDecalSystem — isFlagEligible() type/size gating (Item 12)', () => {
  const minM = Constants.DEBRIS_VISUAL.FLAG_MIN_SIZE_M;

  it('large rocket body is eligible', () => {
    assert.equal(isFlagEligible({ type: 'rocketBody', sizeMeter: 8 }), true);
  });

  it('large defunct sat is eligible', () => {
    assert.equal(isFlagEligible({ type: 'defunctSat', sizeMeter: 3 }), true);
  });

  it('fragments are NEVER eligible, regardless of size', () => {
    assert.equal(isFlagEligible({ type: 'fragment', sizeMeter: 10 }), false);
  });

  it('mission debris is not eligible', () => {
    assert.equal(isFlagEligible({ type: 'missionDebris', sizeMeter: 10 }), false);
  });

  it('eligible types below FLAG_MIN_SIZE_M are excluded', () => {
    assert.equal(isFlagEligible({ type: 'rocketBody', sizeMeter: minM - 0.5 }), false);
    assert.equal(isFlagEligible({ type: 'defunctSat', sizeMeter: minM - 0.5 }), false);
  });

  it('exactly at the threshold is eligible (>=)', () => {
    assert.equal(isFlagEligible({ type: 'rocketBody', sizeMeter: minM }), true);
  });

  it('null / missing fields → false (graceful)', () => {
    assert.equal(isFlagEligible(null), false);
    assert.equal(isFlagEligible({}), false);
    assert.equal(isFlagEligible({ type: 'rocketBody' }), false);
  });
});

describe('FlagDecalSystem — pickCountryForId() deterministic weighted pick', () => {
  it('is deterministic — the same id always picks the same country', () => {
    for (const id of [1, 42, 9999, 123456]) {
      assert.equal(pickCountryForId(id), pickCountryForId(id), `id ${id} stable`);
    }
  });

  it('never returns the unknown fallback slot', () => {
    for (let id = 0; id < 200; id++) {
      const cc = pickCountryForId(id);
      assert.notEqual(cc, '???', `id ${id} → real country`);
      assert.equal(hasFlag(cc), true, `id ${id} → ${cc} has a flag design`);
    }
  });

  it('spreads across multiple countries (not a constant)', () => {
    const seen = new Set();
    for (let id = 0; id < 100; id++) seen.add(pickCountryForId(id));
    assert.ok(seen.size >= 5, `expected ≥5 distinct countries in 100 ids, got ${seen.size}`);
  });
});
