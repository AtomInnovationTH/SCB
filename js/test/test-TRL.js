/**
 * test-TRL.js — ST-6.6 TRL annotation + badge helper tests
 *
 * Validates:
 *   - trlToBadgeColor / trlToLabel / isValidTRL (pure helpers)
 *   - Boundary behaviour at tier edges (3/4, 6/7, 8/9)
 *   - Integrity: every CodexSystem entry has a valid integer TRL
 *   - Integrity: every ShopScreen UPGRADE has a valid integer TRL
 *   - Distribution sanity (no tier has zero entries; log actual ratios)
 *
 * @module test/test-TRL
 */
import { describe, it, assert } from './TestRunner.js';
import {
  Constants,
  trlToBadgeColor,
  trlToLabel,
  isValidTRL,
} from '../core/Constants.js';
import { CodexSystem } from '../systems/CodexSystem.js';
import { UPGRADES } from '../ui/ShopScreen.js';

const T = Constants.TRL;

// ============================================================================
// Helper functions — trlToBadgeColor
// ============================================================================
describe('TRL - trlToBadgeColor', () => {

  it('TRL 9 → COLOR_FLIGHT_PROVEN (green)', () => {
    assert.equal(trlToBadgeColor(9, T), T.COLOR_FLIGHT_PROVEN);
  });

  it('TRL 8 → COLOR_MATURE (yellow)', () => {
    assert.equal(trlToBadgeColor(8, T), T.COLOR_MATURE);
  });

  it('TRL 7 → COLOR_MATURE (yellow, lower boundary)', () => {
    assert.equal(trlToBadgeColor(7, T), T.COLOR_MATURE);
  });

  it('TRL 6 → COLOR_RESEARCH (amber, upper boundary)', () => {
    assert.equal(trlToBadgeColor(6, T), T.COLOR_RESEARCH);
  });

  it('TRL 5 → COLOR_RESEARCH (amber)', () => {
    assert.equal(trlToBadgeColor(5, T), T.COLOR_RESEARCH);
  });

  it('TRL 4 → COLOR_RESEARCH (amber, lower boundary)', () => {
    assert.equal(trlToBadgeColor(4, T), T.COLOR_RESEARCH);
  });

  it('TRL 3 → COLOR_SPECULATIVE (red, upper boundary)', () => {
    assert.equal(trlToBadgeColor(3, T), T.COLOR_SPECULATIVE);
  });

  it('TRL 2 → COLOR_SPECULATIVE (red)', () => {
    assert.equal(trlToBadgeColor(2, T), T.COLOR_SPECULATIVE);
  });

  it('TRL 1 → COLOR_SPECULATIVE (red, lower boundary)', () => {
    assert.equal(trlToBadgeColor(1, T), T.COLOR_SPECULATIVE);
  });

  it('uses Constants.TRL as default when no arg passed', () => {
    // Default arg path
    assert.equal(trlToBadgeColor(9), Constants.TRL.COLOR_FLIGHT_PROVEN);
  });

  it('invalid TRL falls back to COLOR_SPECULATIVE (fail-loud red)', () => {
    assert.equal(trlToBadgeColor(0, T), T.COLOR_SPECULATIVE);
    assert.equal(trlToBadgeColor(10, T), T.COLOR_SPECULATIVE);
    assert.equal(trlToBadgeColor(null, T), T.COLOR_SPECULATIVE);
    assert.equal(trlToBadgeColor(undefined, T), T.COLOR_SPECULATIVE);
    assert.equal(trlToBadgeColor('nine', T), T.COLOR_SPECULATIVE);
    assert.equal(trlToBadgeColor(5.5, T), T.COLOR_SPECULATIVE);
  });
});

// ============================================================================
// Helper functions — trlToLabel
// ============================================================================
describe('TRL - trlToLabel', () => {

  it('TRL 9 → LABEL_FLIGHT_PROVEN', () => {
    assert.equal(trlToLabel(9, T), T.LABEL_FLIGHT_PROVEN);
  });

  it('TRL 8 → LABEL_MATURE', () => {
    assert.equal(trlToLabel(8, T), T.LABEL_MATURE);
  });

  it('TRL 7 → LABEL_MATURE (lower boundary)', () => {
    assert.equal(trlToLabel(7, T), T.LABEL_MATURE);
  });

  it('TRL 6 → LABEL_RESEARCH', () => {
    assert.equal(trlToLabel(6, T), T.LABEL_RESEARCH);
  });

  it('TRL 4 → LABEL_RESEARCH (lower boundary)', () => {
    assert.equal(trlToLabel(4, T), T.LABEL_RESEARCH);
  });

  it('TRL 3 → LABEL_SPECULATIVE (upper boundary)', () => {
    assert.equal(trlToLabel(3, T), T.LABEL_SPECULATIVE);
  });

  it('TRL 1 → LABEL_SPECULATIVE (lower boundary)', () => {
    assert.equal(trlToLabel(1, T), T.LABEL_SPECULATIVE);
  });

  it('label matches colour tier (sanity bracket)', () => {
    // If colour is FLIGHT_PROVEN, label should be FLIGHT_PROVEN (and so on)
    for (let trl = 1; trl <= 9; trl++) {
      const col = trlToBadgeColor(trl, T);
      const lbl = trlToLabel(trl, T);
      if (col === T.COLOR_FLIGHT_PROVEN) assert.equal(lbl, T.LABEL_FLIGHT_PROVEN, `trl=${trl}`);
      if (col === T.COLOR_MATURE)        assert.equal(lbl, T.LABEL_MATURE, `trl=${trl}`);
      if (col === T.COLOR_RESEARCH)      assert.equal(lbl, T.LABEL_RESEARCH, `trl=${trl}`);
      if (col === T.COLOR_SPECULATIVE)   assert.equal(lbl, T.LABEL_SPECULATIVE, `trl=${trl}`);
    }
  });
});

// ============================================================================
// Helper functions — isValidTRL
// ============================================================================
describe('TRL - isValidTRL', () => {

  it('rejects 0 (below range)', () => {
    assert.equal(isValidTRL(0, T), false);
  });

  it('rejects 10 (above range)', () => {
    assert.equal(isValidTRL(10, T), false);
  });

  it('accepts 1 and 9 (boundaries)', () => {
    assert.equal(isValidTRL(1, T), true);
    assert.equal(isValidTRL(9, T), true);
  });

  it('accepts 5 (middle)', () => {
    assert.equal(isValidTRL(5, T), true);
  });

  it('rejects non-integers', () => {
    assert.equal(isValidTRL(5.5, T), false);
    assert.equal(isValidTRL(NaN, T), false);
    assert.equal(isValidTRL(Infinity, T), false);
  });

  it('rejects non-numbers', () => {
    assert.equal(isValidTRL(null, T), false);
    assert.equal(isValidTRL(undefined, T), false);
    assert.equal(isValidTRL('5', T), false);
    assert.equal(isValidTRL({}, T), false);
  });
});

// ============================================================================
// Integrity — every Codex entry has a valid integer TRL
// ============================================================================
describe('TRL - CodexSystem entries integrity', () => {

  const codex = new CodexSystem();

  it('CodexSystem has entries', () => {
    assert.ok(Array.isArray(codex.entries), 'entries must be an array');
    assert.ok(codex.entries.length > 0, `entries must be non-empty (got ${codex.entries.length})`);
  });

  it('every entry has typeof entry.trl === "number"', () => {
    const offenders = codex.entries
      .filter(e => typeof e.trl !== 'number')
      .map(e => e.id);
    assert.equal(offenders.length, 0,
      `entries missing numeric trl: ${offenders.join(', ')}`);
  });

  it('every entry passes isValidTRL', () => {
    const offenders = codex.entries
      .filter(e => !isValidTRL(e.trl, T))
      .map(e => `${e.id}=${e.trl}`);
    assert.equal(offenders.length, 0,
      `entries with invalid TRL: ${offenders.join(', ')}`);
  });

  it('getEntryTRL(id) returns {trl, color, label, rationale}', () => {
    const sample = codex.entries[0];
    const info = codex.getEntryTRL(sample.id);
    assert.ok(info, 'getEntryTRL must return truthy object');
    assert.isType(info.trl, 'number');
    assert.isType(info.color, 'string');
    assert.isType(info.label, 'string');
    assert.isType(info.rationale, 'string');
    assert.equal(info.trl, sample.trl);
    assert.equal(info.color, trlToBadgeColor(sample.trl, T));
    assert.equal(info.label, trlToLabel(sample.trl, T));
  });

  it('getEntryTRL(unknownId) returns null', () => {
    assert.equal(codex.getEntryTRL('__nonexistent__'), null);
  });
});

// ============================================================================
// Integrity — every Shop upgrade has a valid integer TRL
// ============================================================================
describe('TRL - ShopScreen upgrades integrity', () => {

  it('UPGRADES array is non-empty', () => {
    assert.ok(Array.isArray(UPGRADES), 'UPGRADES must be an array');
    assert.ok(UPGRADES.length > 0, `UPGRADES must be non-empty (got ${UPGRADES.length})`);
  });

  it('every upgrade has typeof upgrade.trl === "number"', () => {
    const offenders = UPGRADES
      .filter(u => typeof u.trl !== 'number')
      .map(u => u.id);
    assert.equal(offenders.length, 0,
      `upgrades missing numeric trl: ${offenders.join(', ')}`);
  });

  it('every upgrade passes isValidTRL', () => {
    const offenders = UPGRADES
      .filter(u => !isValidTRL(u.trl, T))
      .map(u => `${u.id}=${u.trl}`);
    assert.equal(offenders.length, 0,
      `upgrades with invalid TRL: ${offenders.join(', ')}`);
  });
});

// ============================================================================
// Distribution sanity — log counts across 4 tiers; fail if any tier is empty
// ============================================================================
describe('TRL - distribution sanity', () => {

  /**
   * Tier-count helper.
   * @param {Array<{trl:number}>} items
   * @returns {{flightProven:number, mature:number, research:number, speculative:number, total:number}}
   */
  function countTiers(items) {
    const c = { flightProven: 0, mature: 0, research: 0, speculative: 0, total: 0 };
    for (const item of items) {
      c.total++;
      const col = trlToBadgeColor(item.trl, T);
      if      (col === T.COLOR_FLIGHT_PROVEN) c.flightProven++;
      else if (col === T.COLOR_MATURE)        c.mature++;
      else if (col === T.COLOR_RESEARCH)      c.research++;
      else                                    c.speculative++;
    }
    return c;
  }

  it('Codex distribution — all four tiers populated', () => {
    const codex = new CodexSystem();
    const c = countTiers(codex.entries);
    const pct = (n) => ((100 * n) / c.total).toFixed(1);
    console.log(`  [Codex TRL distribution] total=${c.total}  ` +
      `flight-proven=${c.flightProven} (${pct(c.flightProven)}%)  ` +
      `mature=${c.mature} (${pct(c.mature)}%)  ` +
      `research=${c.research} (${pct(c.research)}%)  ` +
      `speculative=${c.speculative} (${pct(c.speculative)}%)`);
    assert.ok(c.flightProven > 0, 'at least one flight-proven (TRL 9) entry required');
    assert.ok(c.mature > 0,       'at least one mature (TRL 7-8) entry required');
    assert.ok(c.research > 0,     'at least one research (TRL 4-6) entry required');
    assert.ok(c.speculative > 0,  'at least one speculative (TRL 1-3) entry required');
  });

  it('Shop distribution — all four tiers populated', () => {
    const c = countTiers(UPGRADES);
    const pct = (n) => ((100 * n) / c.total).toFixed(1);
    console.log(`  [Shop TRL distribution]  total=${c.total}  ` +
      `flight-proven=${c.flightProven} (${pct(c.flightProven)}%)  ` +
      `mature=${c.mature} (${pct(c.mature)}%)  ` +
      `research=${c.research} (${pct(c.research)}%)  ` +
      `speculative=${c.speculative} (${pct(c.speculative)}%)`);
    assert.ok(c.flightProven > 0, 'at least one flight-proven upgrade required');
    assert.ok(c.mature > 0,       'at least one mature upgrade required');
    assert.ok(c.research > 0,     'at least one research upgrade required');
    assert.ok(c.speculative > 0,  'at least one speculative upgrade required');
  });
});
