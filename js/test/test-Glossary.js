/**
 * test-Glossary.js — inline glossary decorator + data integrity (§11.8).
 *
 * glossary.js is DOM-free (mirrors codexInterpolate.js) so it imports cleanly
 * under Node. These guards lock in the security + matching contract:
 *   - HTML-escaping of all non-term text (we moved from raw interpolation)
 *   - term/alias wrapping with correct data-term / data-entry / title
 *   - word-boundary + per-term case rules (LEO uppercase-only; delta-v insensitive)
 *   - `once` semantics (first occurrence per call; never double-wraps)
 *   - data integrity: every GLOSSARY[*].entryId resolves to a real codex entry
 *     (mirrors the dangling-related guard in test-CodexData.js)
 *
 * @module test/test-Glossary
 */

import { describe, it, assert } from './TestRunner.js';
import { decorateGlossary, escapeHtml, GLOSSARY } from '../systems/codex/glossary.js';
import { CodexSystem } from '../systems/CodexSystem.js';
import { CODEX_DATA } from './_codexFixture.js';

const codex = new CodexSystem(CODEX_DATA);

// ───────────────────────────────────────────────────────────────────────────
describe('Glossary — HTML escaping', () => {
  it('escapes < > & " \' in non-term text', () => {
    const out = decorateGlossary('a <b> & "c" \'d\'');
    assert.ok(!out.includes('<b>'), 'raw <b> must not survive');
    assert.ok(out.includes('&lt;b&gt;'), 'angle brackets escaped');
    assert.ok(out.includes('&amp;'), 'ampersand escaped');
    assert.ok(out.includes('&quot;'), 'double quote escaped');
    assert.ok(out.includes('&#39;'), 'single quote escaped');
  });

  it('never emits an unescaped injection from surrounding text', () => {
    const out = decorateGlossary('<script>alert(1)</script> near LEO');
    assert.ok(!out.includes('<script>'), 'no raw <script>');
    assert.ok(out.includes('&lt;script&gt;'), 'script tag escaped');
    // the legitimate glossary span IS allowed:
    assert.ok(out.includes('class="glossary-term"'), 'real term still wrapped');
  });

  it('escapeHtml is exported and pure', () => {
    assert.equal(escapeHtml('<&>'), '&lt;&amp;&gt;');
    assert.equal(escapeHtml(''), '');
  });

  it('non-string / empty inputs are safe', () => {
    assert.equal(decorateGlossary(''), '');
    assert.equal(decorateGlossary(null), '');
    assert.equal(decorateGlossary(undefined), '');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('Glossary — term wrapping', () => {
  it('wraps a known term with class, data-term, title', () => {
    const out = decorateGlossary('reach LEO now');
    assert.ok(out.includes('<span class="glossary-term"'), 'span class present');
    assert.ok(out.includes('data-term="LEO"'), 'data-term present');
    assert.ok(/title="Low Earth Orbit[^"]+"/.test(out), 'title carries the def');
  });

  it('emits data-entry only for terms that have a codex entry', () => {
    // ΔV → delta_v (has entry)
    const withEntry = decorateGlossary('burn ΔV');
    assert.ok(withEntry.includes('data-entry="delta_v"'), 'ΔV deep-links');
    // LEO → no entryId (hover-only)
    const hoverOnly = decorateGlossary('reach LEO');
    assert.ok(hoverOnly.includes('data-term="LEO"'), 'LEO wrapped');
    assert.ok(!/data-term="LEO"[^>]*data-entry/.test(hoverOnly), 'LEO has no data-entry');
  });

  it('matches aliases and keys the span by the canonical term', () => {
    const out = decorateGlossary('apply delta-v');
    assert.ok(out.includes('data-term="ΔV"'), 'alias maps to canonical term key');
    assert.ok(out.includes('>delta-v</span>'), 'displayed text is the matched surface form');
  });

  it('the title attribute is HTML-escaped', () => {
    // Pick any term and assert no raw angle bracket leaks into title.
    const out = decorateGlossary('ΔV');
    assert.ok(!/title="[^"]*</.test(out), 'no raw < inside title');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('Glossary — word boundaries', () => {
  it('does not match an acronym inside a larger word', () => {
    const out = decorateGlossary('Galileo and Wispy and description');
    assert.ok(!out.includes('glossary-term'), 'no false matches inside words');
    assert.ok(out.includes('Galileo'), 'text preserved');
  });

  it('does not match a plural that swallows the term', () => {
    const out = decorateGlossary('many deltas');
    assert.ok(!out.includes('glossary-term'), 'deltas must not match delta-v');
  });

  it('matches a standalone acronym surrounded by punctuation', () => {
    const out = decorateGlossary('(LEO).');
    assert.ok(out.includes('data-term="LEO"'), 'LEO wrapped despite parens/period');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('Glossary — case rules', () => {
  it('uppercase-only acronyms ignore lowercase prose', () => {
    const out = decorateGlossary('leo the lion vs LEO the orbit');
    // exactly one wrap (the uppercase LEO)
    const wraps = (out.match(/data-term="LEO"/g) || []).length;
    assert.equal(wraps, 1, 'only the uppercase LEO is wrapped');
    assert.ok(out.includes('leo the lion'), 'lowercase prose left alone');
  });

  it('case-insensitive phrases match any casing', () => {
    const out = decorateGlossary('Delta-V and DELTA-V');
    assert.ok(out.includes('data-term="ΔV"'), 'mixed/upper case delta-v matches');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('Glossary — once semantics', () => {
  it('wraps only the first occurrence of a term per call (default)', () => {
    const out = decorateGlossary('LEO then LEO then LEO');
    const wraps = (out.match(/class="glossary-term"/g) || []).length;
    assert.equal(wraps, 1, 'only the first LEO is wrapped');
    // later occurrences remain as plain (escaped) text
    assert.ok(out.includes('then LEO then LEO'), 'later LEOs left plain');
  });

  it('once:false wraps every occurrence', () => {
    const out = decorateGlossary('LEO and LEO', { once: false });
    const wraps = (out.match(/class="glossary-term"/g) || []).length;
    assert.equal(wraps, 2, 'both occurrences wrapped when once:false');
  });

  it('never double-wraps / never matches inside an emitted span', () => {
    const out = decorateGlossary('specific impulse');
    // the def text contains words like "impulse"/"propellant" — none should be
    // re-wrapped inside the already-emitted title or body.
    const wraps = (out.match(/class="glossary-term"/g) || []).length;
    assert.equal(wraps, 1, 'phrase wrapped exactly once, no nested spans');
  });

  it('leaves unknown text untouched (apart from escaping)', () => {
    const out = decorateGlossary('the quick brown fox');
    assert.equal(out, 'the quick brown fox');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('Glossary — first-use cue hooks', () => {
  it('adds glossary-term--new when isNew returns true', () => {
    const out = decorateGlossary('LEO', { isNew: () => true });
    assert.ok(out.includes('glossary-term--new'), 'cue class added for new terms');
  });

  it('omits the cue when isNew returns false', () => {
    const out = decorateGlossary('LEO', { isNew: () => false });
    assert.ok(!out.includes('glossary-term--new'), 'no cue for seen terms');
  });

  it('fires onSeen once per distinct term', () => {
    const seen = [];
    decorateGlossary('LEO and LEO and ΔV', { once: false, onSeen: (t) => seen.push(t) });
    assert.deepEqual(seen.sort(), ['LEO', 'ΔV'].sort(), 'onSeen fired once per distinct term');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('Glossary — data integrity', () => {
  it('every entryId resolves to a real codex entry', () => {
    const dangling = GLOSSARY
      .filter(g => g.entryId && !codex.getEntry(g.entryId))
      .map(g => `${g.term}→${g.entryId}`);
    assert.equal(dangling.length, 0, `dangling entryIds: ${dangling.join(', ')}`);
  });

  it('every term has a non-empty term + def', () => {
    const bad = GLOSSARY.filter(g => !g.term || !g.def).map(g => g.term || '(blank)');
    assert.equal(bad.length, 0, `incomplete glossary records: ${bad.join(', ')}`);
  });

  it('no duplicate surface forms (term or alias) across the glossary', () => {
    const seen = new Map();
    const dupes = [];
    for (const g of GLOSSARY) {
      for (const surf of [g.term, ...(g.aliases || [])]) {
        const key = (g.flags && g.flags.includes('i')) ? surf.toLowerCase() : surf;
        if (seen.has(key)) dupes.push(key);
        else seen.set(key, g.term);
      }
    }
    assert.equal(dupes.length, 0, `duplicate surface forms: ${dupes.join(', ')}`);
  });

  it('has a substantial term list (≥50)', () => {
    assert.ok(GLOSSARY.length >= 50, `expected ≥50 terms, got ${GLOSSARY.length}`);
  });
});
