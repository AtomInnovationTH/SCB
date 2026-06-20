/**
 * test-CodexReachability.js — Codex Overhaul Phase 0d.
 *
 * ~40 codex entries unlock when a comms message's text contains a specific
 * substring (e.g. `p.text.toLowerCase().includes('laser comms')`). That couples
 * unlock reachability to prose that lives in OTHER files — editing a comms line
 * can silently make an entry permanently unreachable, with no compile error and
 * no other test catching it. This guard reads the real comms-source corpus and
 * asserts every coupled entry still has a live string that satisfies its
 * trigger.
 *
 * The coupling map below is the single documented place that records which
 * comms substring each entry depends on. When triggers move into
 * codexTriggers.js (Phase 1) this map should be kept in lock-step.
 *
 * Group semantics mirror the real triggerCondition boolean logic:
 *   anyOf: [ group, ... ]   — entry unlocks if ANY group matches (OR)
 *   group:  string | string[] — a single needle, or an AND of needles
 *   { cs: true }            — case-sensitive (trigger does NOT lowercase p.text)
 *
 * @module test/test-CodexReachability
 */

import { describe, it, assert } from './TestRunner.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CodexSystem } from '../systems/CodexSystem.js';
import { CODEX_DATA } from './_codexFixture.js';
import { Events } from '../core/Events.js';

const _here = dirname(fileURLToPath(import.meta.url));
const _root = resolve(_here, '../..');

// Files whose literal strings can become a live comms `p.text` (per the
// Phase-0d corpus audit): CommsSystem templates, SubsystemEvents generators,
// Constants chapter beats (routed through MissionCoach → COMMS_MESSAGE), and
// PlayerSatellite's direct EDT emit.
const CORPUS_FILES = [
  'js/systems/CommsSystem.js',
  'js/systems/SubsystemEvents.js',
  'js/core/Constants.js',
  'js/entities/PlayerSatellite.js',
];

const CORPUS_RAW = CORPUS_FILES
  .map(f => { try { return readFileSync(resolve(_root, f), 'utf8'); } catch { return ''; } })
  .join('\n');
const CORPUS_LC = CORPUS_RAW.toLowerCase();

/**
 * @param {string|string[]} group  one needle (string) or an AND of needles
 * @param {boolean} caseSensitive
 * @returns {boolean}
 */
function groupMatches(group, caseSensitive) {
  const needles = Array.isArray(group) ? group : [group];
  const hay = caseSensitive ? CORPUS_RAW : CORPUS_LC;
  return needles.every(n => hay.includes(caseSensitive ? n : n.toLowerCase()));
}

// id → { anyOf: [group,...], cs?: bool }  (cs default false = lowercased trigger)
const COUPLINGS = [
  // --- COMMS_MESSAGE text triggers ---
  { id: 'hohmann_transfer',     anyOf: ['transfer'] },
  { id: 'eclipse_cycle',        anyOf: ['shadow', 'eclipse'] },
  { id: 'solar_storm',          anyOf: ['solar'] },
  { id: 'van_allen_belts',      anyOf: ['radiation', 'van allen'] },
  { id: 'laser_comms',          anyOf: ['laser comms'] },
  { id: 'ground_station_window', anyOf: [['ground station', 'range']] },
  { id: 'bandwidth_limits',     anyOf: ['bandwidth'] },
  { id: 'comms_blackout',       anyOf: ['comms degraded'] },
  { id: 'star_tracker',         anyOf: ['star tracker'] },
  { id: 'imu_drift',            anyOf: ['imu drift'] },
  { id: 'docking_precision',    anyOf: ['relative navigation'] },
  { id: 'reaction_wheels',      anyOf: ['reaction wheel', 'gyro'] },
  { id: 'magnetorquers',        anyOf: ['magnetorquer'] },
  { id: 'detumble',             anyOf: ['tumble rate'] },
  { id: 'battery_chemistry',    anyOf: ['battery cycle'] },
  { id: 'supercapacitors',      anyOf: ['supercapacitor'] },
  { id: 'thermal_management',   anyOf: ['thermal gradient'] },
  { id: 'mli_insulation',       anyOf: ['mli'] },
  { id: 'triple_redundancy',    anyOf: ['tmr', ['triple', 'redundancy']] },
  { id: 'watchdog_timer',       anyOf: ['watchdog'] },
  { id: 'telemetry',            anyOf: ['telemetry frame'] },
  { id: 'ecc_memory',           anyOf: ['single-bit error'] },
  // survivor of merges — substrings folded in from the merged-away losers:
  { id: 'atomic_oxygen',        anyOf: ['atomic oxygen'] },      // ← atomic_oxygen_erosion
  { id: 'mmod_impact',          anyOf: ['mmod', 'micrometeorite'] }, // ← mmod_impact_physics
  { id: 'edt_physics',          anyOf: ['edt'] },                // ← edt_propulsion
  // case-sensitive (these triggers do NOT lowercase p.text)
  { id: 'j2_perturbation',      anyOf: ['predicted', 'drift'], cs: true },
  { id: 'hubble_watch',         anyOf: ['Hubble'], cs: true },
  { id: 'thaicom_graveyard',    anyOf: ['Thaicom'], cs: true },

  // --- SUBSYSTEM_EVENT text triggers (same source corpus) ---
  { id: 'gps_denied',           anyOf: ['gps'] },
  { id: 'hbn_coating',          anyOf: ['atomic oxygen'] },
  { id: 'uv_degradation',       anyOf: ['uv'] },
  { id: 'radiation_dose',       anyOf: ['radiation'] },
  { id: 'telemetry_bandwidth',  anyOf: ['bandwidth'] },
  { id: 'star_tracker',         anyOf: ['star tracker'] },       // ← star_tracker_nav folded in
  { id: 'battery_cycles',       anyOf: ['battery'] },
  { id: 'solar_cell_degradation', anyOf: ['solar uv'] },
  { id: 'raan_precession',      anyOf: ['Ground station'], cs: true },
];

describe('Codex Phase 0 — comms-substring trigger reachability', () => {
  it('the comms-source corpus is non-empty (files resolved)', () => {
    assert.ok(CORPUS_RAW.length > 1000, 'corpus loaded from source files');
  });

  for (const c of COUPLINGS) {
    it(`'${c.id}' has a live comms string`, () => {
      const reachable = c.anyOf.some(group => groupMatches(group, !!c.cs));
      const printable = c.anyOf.map(g => Array.isArray(g) ? `(${g.join(' AND ')})` : `'${g}'`).join(' OR ');
      assert.ok(reachable,
        `${c.id} unreachable: no live comms string matches ${printable}${c.cs ? ' [case-sensitive]' : ''}`);
    });
  }
});

// Trigger-SIDE validation: the corpus check above proves a needle exists in
// live comms copy, but NOT that the entry's triggerCondition still tests that
// needle. Without this, renaming a substring inside CodexSystem.buildEntries()
// (e.g. 'imu drift' → something else) would leave COUPLINGS green yet make the
// entry unreachable. Here we feed each coupling's needle to the REAL
// triggerCondition and assert it fires — tying the map to the actual logic.
describe('Codex Phase 0 — COUPLINGS match real triggerConditions', () => {
  const codex = new CodexSystem(CODEX_DATA);

  /** Build a payload that carries the needle group's text (+ a source hint
   *  for source-gated triggers like raan_precession). */
  function payloadFor(group) {
    const needles = Array.isArray(group) ? group : [group];
    return { text: needles.join(' '), source: 'SYSTEM' };
  }

  it('every COUPLINGS id resolves to a real entry', () => {
    const missing = COUPLINGS.filter(c => !codex.getEntry(c.id)).map(c => c.id);
    assert.equal(missing.length, 0, `COUPLINGS ids with no entry: ${missing.join(', ')}`);
  });

  for (const c of COUPLINGS) {
    it(`'${c.id}' triggerCondition fires on its mapped needle`, () => {
      const entry = codex.getEntry(c.id);
      assert.ok(entry, `entry ${c.id} exists`);
      // Some alternative group should fire on at least one of the entry's
      // triggers (any event), via the synthesized payload.
      const fires = c.anyOf.some(group => {
        const p = payloadFor(group);
        return codex.getTriggers(c.id).some(t => {
          try { return t.match(p) === true; } catch { return false; }
        });
      });
      assert.ok(fires,
        `${c.id}: no trigger fired on mapped needle(s) — COUPLINGS has drifted from the real trigger`);
    });
  }

  it('mapped text triggers do NOT fire on an unrelated payload (negative guard)', () => {
    const neg = { text: 'zzz no match here qqq', source: 'NOPE' };
    // Only the text-bearing channels are relevant here; an entry may also have
    // legitimate event-only `always` triggers (e.g. edt_physics on EDT_ATTRACT)
    // that intentionally ignore text — those are not coupling-map errors.
    const TEXT_EVENTS = new Set([Events.COMMS_MESSAGE, Events.SUBSYSTEM_EVENT]);
    const falsePositives = COUPLINGS.filter(c => {
      return codex.getTriggers(c.id).some(t => {
        if (!TEXT_EVENTS.has(t.event)) return false;
        try { return t.match(neg) === true; } catch { return false; }
      });
    }).map(c => c.id);
    assert.equal(falsePositives.length, 0,
      `text triggers fired on an unrelated payload (coupling map may be wrong): ${falsePositives.join(', ')}`);
  });
});
