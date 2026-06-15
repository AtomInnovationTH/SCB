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
  trlToTechLevelLabel,
  techLevelBadgeText,
} from '../core/Constants.js';
import { CodexSystem, entryMatchesQuery } from '../systems/CodexSystem.js';
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

// ============================================================================
// UX-11 #10: Tech-Level presentation helpers + Codex syllabus getters
// ============================================================================
describe('Tech Level (UX-11 #10) - presentation relabel', () => {

  it('trlToTechLevelLabel keeps the 1-9 number + tier word, drops "TRL"', () => {
    assert.equal(trlToTechLevelLabel(9, T), `Tech Level 9: ${T.LABEL_FLIGHT_PROVEN}`);
    assert.equal(trlToTechLevelLabel(7, T), `Tech Level 7: ${T.LABEL_MATURE}`);
    assert.equal(trlToTechLevelLabel(5, T), `Tech Level 5: ${T.LABEL_RESEARCH}`);
    assert.equal(trlToTechLevelLabel(2, T), `Tech Level 2: ${T.LABEL_SPECULATIVE}`);
    assert.ok(!trlToTechLevelLabel(9, T).includes('TRL'), 'no TRL acronym player-facing');
  });

  it('techLevelBadgeText renders the short card badge', () => {
    assert.equal(techLevelBadgeText(9), 'Tech Lvl 9');
    assert.equal(techLevelBadgeText(3), 'Tech Lvl 3');
  });
});

describe('Codex (UX-11 #10) - unlock hints, category progress, search', () => {

  it('every entry carries a non-empty unlockHint (default per category)', () => {
    const codex = new CodexSystem();
    const missing = codex.entries.filter(e => !e.unlockHint || !e.unlockHint.trim());
    assert.equal(missing.length, 0,
      `entries without unlockHint: ${missing.map(e => e.id).join(', ')}`);
  });

  it('getUnlockHint returns the specific override when authored', () => {
    const codex = new CodexSystem();
    assert.ok(codex.getUnlockHint('hohmann_transfer').toLowerCase().includes('transfer'));
    assert.equal(codex.getUnlockHint('nonexistent_id'), '');
  });

  it('getCategoryProgress tracks unlocks per category', () => {
    const codex = new CodexSystem();
    const cat = codex.entries[0].category;
    const before = codex.getCategoryProgress(cat);
    assert.equal(before.unlocked, 0, 'fresh system starts fully locked');
    assert.ok(before.total > 0);
    codex.entries[0].unlocked = true;
    const after = codex.getCategoryProgress(cat);
    assert.equal(after.unlocked, 1);
    assert.equal(after.total, before.total);
  });

  it('searchEntries matches title, shortText, and category (case-insensitive)', () => {
    const codex = new CodexSystem();
    const byTitle = codex.searchEntries('hohmann');
    assert.ok(byTitle.some(e => e.id === 'hohmann_transfer'), 'title match');
    const byCat = codex.searchEntries('orbital mechanics');
    assert.ok(byCat.length >= 4, 'category match finds the OM entries');
    assert.equal(codex.searchEntries('zzz_no_such_topic').length, 0);
    assert.equal(codex.searchEntries('').length, codex.entries.length, 'empty query = all');
  });

  it('entryMatchesQuery is a pure predicate', () => {
    const e = { title: 'Xenon Propellant', shortText: 'Noble gas', category: 'PROPULSION' };
    assert.equal(entryMatchesQuery(e, 'xenon'), true);
    assert.equal(entryMatchesQuery(e, 'noble'), true);
    assert.equal(entryMatchesQuery(e, 'propulsion'), true);
    assert.equal(entryMatchesQuery(e, 'tether'), false);
  });
});
