/**
 * test-CodexViewer.js — Codex Overhaul Phase 3: viewer logic guards.
 *
 * CodexViewerUI is a DOM overlay, so its rendering can't run headless. These
 * tests exercise the *pure* logic added in the Phase 3 overhaul — the bits a
 * regression would silently break — by instantiating the prototype WITHOUT the
 * DOM-heavy constructor (Object.create) and calling the methods directly:
 *   • _hexToRgb       — category-accent colour parsing (+ graceful fallback)
 *   • _applyFilterSort — locked/unlocked filter + A–Z / readiness sort
 *   • _currentListEntries — search / track / category list resolution
 *
 * @module test/test-CodexViewer
 */

import { describe, it, assert } from './TestRunner.js';
import { CodexViewerUI } from '../ui/CodexViewerUI.js';

/** Build a viewer instance without running the DOM constructor. */
function makeViewer(codexStub) {
  const v = Object.create(CodexViewerUI.prototype);
  v._codex = codexStub || {};
  v._searchQuery = '';
  v._selectedCategory = null;
  v._selectedEntry = null;
  v._filter = 'all';
  v._sort = 'default';
  return v;
}

/** Minimal entry factory for filter/sort tests. */
function entry(id, opts = {}) {
  return {
    id,
    title: opts.title || id,
    category: opts.category || 'PROPULSION',
    trl: ('trl' in opts) ? opts.trl : 9,
    unlocked: opts.unlocked !== false,
  };
}

describe('CodexViewerUI._hexToRgb — accent colour parsing', () => {
  it('parses #rrggbb', () => {
    const v = makeViewer();
    assert.deepEqual(v._hexToRgb('#e69f00'), { r: 0xe6, g: 0x9f, b: 0x00 });
  });

  it('parses shorthand #rgb', () => {
    const v = makeViewer();
    assert.deepEqual(v._hexToRgb('#0f8'), { r: 0x00, g: 0xff, b: 0x88 });
  });

  it('tolerates a missing leading #', () => {
    const v = makeViewer();
    assert.deepEqual(v._hexToRgb('ff6b6b'), { r: 0xff, g: 0x6b, b: 0x6b });
  });

  it('falls back to codex cyan on malformed input', () => {
    const v = makeViewer();
    const cyan = { r: 0, g: 212, b: 255 };
    assert.deepEqual(v._hexToRgb('not-a-color'), cyan);
    assert.deepEqual(v._hexToRgb('#12'), cyan);
    assert.deepEqual(v._hexToRgb(null), cyan);
    assert.deepEqual(v._hexToRgb(undefined), cyan);
  });
});

describe('CodexViewerUI._applyFilterSort — filter', () => {
  const list = [
    entry('a', { unlocked: true }),
    entry('b', { unlocked: false }),
    entry('c', { unlocked: true }),
  ];

  it('"all" returns every entry untouched', () => {
    const v = makeViewer();
    v._filter = 'all';
    assert.deepEqual(v._applyFilterSort(list).map(e => e.id), ['a', 'b', 'c']);
  });

  it('"unlocked" keeps only unlocked entries', () => {
    const v = makeViewer();
    v._filter = 'unlocked';
    assert.deepEqual(v._applyFilterSort(list).map(e => e.id), ['a', 'c']);
  });

  it('"locked" keeps only locked entries', () => {
    const v = makeViewer();
    v._filter = 'locked';
    assert.deepEqual(v._applyFilterSort(list).map(e => e.id), ['b']);
  });
});

describe('CodexViewerUI._applyFilterSort — sort', () => {
  const list = [
    entry('z', { title: 'Zeta', trl: 5 }),
    entry('a', { title: 'Alpha', trl: 9 }),
    entry('m', { title: 'Mu', trl: null }),
  ];

  it('"default" preserves the incoming (category/track) order', () => {
    const v = makeViewer();
    v._sort = 'default';
    assert.deepEqual(v._applyFilterSort(list).map(e => e.id), ['z', 'a', 'm']);
  });

  it('"az" sorts by title', () => {
    const v = makeViewer();
    v._sort = 'az';
    assert.deepEqual(v._applyFilterSort(list).map(e => e.id), ['a', 'm', 'z']);
  });

  it('"trl" sorts highest readiness first, null TRL last', () => {
    const v = makeViewer();
    v._sort = 'trl';
    assert.deepEqual(v._applyFilterSort(list).map(e => e.id), ['a', 'z', 'm']);
  });

  it('does not mutate the input array', () => {
    const v = makeViewer();
    v._sort = 'az';
    const input = list.slice();
    v._applyFilterSort(input);
    assert.deepEqual(input.map(e => e.id), ['z', 'a', 'm'], 'original order intact');
  });

  it('a track ignores the sort and keeps authored order', () => {
    const v = makeViewer();
    v._sort = 'az'; // would reorder a category, but a track must stay authored
    assert.deepEqual(v._applyFilterSort(list, true).map(e => e.id), ['z', 'a', 'm']);
  });

  it('a track still honours the locked/unlocked filter', () => {
    const v = makeViewer();
    v._sort = 'az';
    v._filter = 'unlocked';
    const mixed = [
      entry('z', { title: 'Zeta', unlocked: false }),
      entry('a', { title: 'Alpha', unlocked: true }),
    ];
    assert.deepEqual(v._applyFilterSort(mixed, true).map(e => e.id), ['a']);
  });
});

describe('CodexViewerUI._currentListEntries — list resolution', () => {
  const propulsion = [entry('feep', { category: 'PROPULSION' }), entry('isp', { category: 'PROPULSION' })];
  const trackEntries = [entry('isp', { category: 'PROPULSION' }), entry('feep', { category: 'PROPULSION' })];
  const all = propulsion.concat([entry('debris', { category: 'DEBRIS' })]);

  function stub() {
    return {
      entries: all,
      getCategory: (c) => all.filter(e => e.category === c),
      searchEntries: (q) => all.filter(e => e.id.includes(q)),
      getTrack: (tid) => (tid === 'propellant_story' ? { id: tid, meta: {}, entries: trackEntries } : null),
    };
  }

  it('resolves a category selection to that category', () => {
    const v = makeViewer(stub());
    v._selectedCategory = 'PROPULSION';
    const { entries, isTrack } = v._currentListEntries();
    assert.equal(isTrack, false);
    assert.deepEqual(entries.map(e => e.id), ['feep', 'isp']);
  });

  it('resolves a "track:" selection to the track entries in authored order', () => {
    const v = makeViewer(stub());
    v._selectedCategory = 'track:propellant_story';
    const { entries, isTrack } = v._currentListEntries();
    assert.equal(isTrack, true);
    assert.deepEqual(entries.map(e => e.id), ['isp', 'feep'], 'track order preserved');
  });

  it('an active search ignores the sidebar selection and spans all categories', () => {
    const v = makeViewer(stub());
    v._selectedCategory = 'PROPULSION';
    v._searchQuery = 'debris';
    const { entries } = v._currentListEntries();
    assert.deepEqual(entries.map(e => e.id), ['debris']);
  });

  it('an unknown track id resolves to an empty list (no throw)', () => {
    const v = makeViewer(stub());
    v._selectedCategory = 'track:does_not_exist';
    const { entries } = v._currentListEntries();
    assert.deepEqual(entries, []);
  });
});

describe('CodexViewerUI.openEntry — glossary deep-link (§11.8)', () => {
  // openEntry touches DOM via show()/_showDetail()/_renderSidebarActive(); stub
  // those so we can assert the pure routing (resolve → select category → detail)
  // without the DOM-heavy constructor.
  function makeDeepLinkViewer(entriesById) {
    const v = makeViewer({
      getEntry: (id) => entriesById[id] || null,
    });
    v._calls = { show: 0, detail: null, sidebar: 0 };
    v.show = function () { this._calls.show++; this._visible = true; };
    v._showDetail = function (entry) { this._calls.detail = entry; };
    v._renderSidebarActive = function () { this._calls.sidebar++; };
    return v;
  }

  const ENTRIES = {
    delta_v: { id: 'delta_v', category: 'ORBITAL_MECHANICS', unlocked: true },
    feep_thruster: { id: 'feep_thruster', category: 'PROPULSION', unlocked: false },
  };

  it('opens the viewer, selects the entry category, and routes to detail', () => {
    const v = makeDeepLinkViewer(ENTRIES);
    const ok = v.openEntry('delta_v');
    assert.equal(ok, true, 'returns true on success');
    assert.equal(v._calls.show, 1, 'show() called');
    assert.equal(v._selectedCategory, 'ORBITAL_MECHANICS', 'category selected from entry');
    assert.equal(v._calls.detail, ENTRIES.delta_v, 'routed to the entry detail');
  });

  it('deep-links a LOCKED entry (viewer shows the how-to-unlock hint)', () => {
    const v = makeDeepLinkViewer(ENTRIES);
    const ok = v.openEntry('feep_thruster');
    assert.equal(ok, true, 'locked entries still open');
    assert.equal(v._calls.detail, ENTRIES.feep_thruster, 'locked entry detail shown');
  });

  it('unknown id is a safe no-op (no show, no detail)', () => {
    const v = makeDeepLinkViewer(ENTRIES);
    const ok = v.openEntry('not_a_real_id');
    assert.equal(ok, false, 'returns false on unknown id');
    assert.equal(v._calls.show, 0, 'did not open the viewer');
    assert.equal(v._calls.detail, null, 'did not route to detail');
  });

  it('falsy / missing id is a safe no-op', () => {
    const v = makeDeepLinkViewer(ENTRIES);
    assert.equal(v.openEntry(''), false);
    assert.equal(v.openEntry(null), false);
    assert.equal(v.openEntry(undefined), false);
    assert.equal(v._calls.show, 0, 'never opened');
  });
});

