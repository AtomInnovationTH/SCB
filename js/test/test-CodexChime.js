/**
 * test-CodexChime.js — Slice 8: codexChimeNotes pure helper.
 *
 * The codex-unlock chime transposes a base D5→A5 pair by a deterministic
 * per-category pentatonic offset. These tests pin: determinism, two finite
 * ascending frequencies, distinct pairs across categories, and base-pair
 * fallback for unknown/missing categories.
 *
 * Node-safe: codexChimeNotes is a module-level pure function (no WebAudio).
 *
 * @module test/test-CodexChime
 */

import { describe, it, assert } from './TestRunner.js';
import { codexChimeNotes } from '../systems/AudioSystem.js';

const BASE = [587, 880];

describe('codexChimeNotes — base pair for unknown/missing', () => {
  it('returns the base pair for undefined', () => {
    assert.deepEqual(codexChimeNotes(), BASE);
  });
  it('returns the base pair for empty string', () => {
    assert.deepEqual(codexChimeNotes(''), BASE);
  });
  it('returns the base pair for a non-string', () => {
    assert.deepEqual(codexChimeNotes(42), BASE);
    assert.deepEqual(codexChimeNotes(null), BASE);
  });
});

describe('codexChimeNotes — shape', () => {
  it('returns two finite ascending frequencies', () => {
    for (const cat of ['ORBITAL_MECHANICS', 'PROPULSION', 'POWER', 'DEBRIS', 'COMMS']) {
      const [a, b] = codexChimeNotes(cat);
      assert.ok(Number.isFinite(a) && a > 0, `${cat} first freq finite+positive`);
      assert.ok(Number.isFinite(b) && b > 0, `${cat} second freq finite+positive`);
      assert.ok(b > a, `${cat} ascending (A5 above D5)`);
    }
  });
});

describe('codexChimeNotes — determinism', () => {
  it('same category → identical pair on repeat calls', () => {
    const a = codexChimeNotes('PROPULSION');
    const b = codexChimeNotes('PROPULSION');
    assert.deepEqual(a, b);
  });
});

describe('codexChimeNotes — distinct across categories', () => {
  it('produces distinct pairs for at least two categories', () => {
    const cats = ['ORBITAL_MECHANICS', 'PROPULSION', 'POWER', 'DEBRIS', 'COMMS', 'MATERIALS', 'TETHERS'];
    const seen = new Set(cats.map(c => codexChimeNotes(c).join(',')));
    assert.ok(seen.size >= 2, `expected ≥2 distinct chime pairs, got ${seen.size}`);
  });
});
