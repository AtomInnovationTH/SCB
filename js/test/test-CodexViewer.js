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
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

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
  // openEntry touches DOM via show()/_selectEntry()/_renderSidebarActive()/
  // _renderEntryList(); stub those so we can assert the pure routing (resolve →
  // select category → reading pane) without the DOM-heavy constructor.
  function makeDeepLinkViewer(entriesById) {
    const v = makeViewer({
      getEntry: (id) => entriesById[id] || null,
      getCategory: (c) => Object.values(entriesById).filter(e => e.category === c),
    });
    // openEntry() now sets the category + _pendingOpenId BEFORE show(), then
    // show() drives the pipeline: render list → _selectFirstEntry() routes to
    // the pending deep-link entry (single list render, no stale-category flash).
    // Stub the DOM-heavy steps so we can assert the pure routing without the
    // real constructor.
    v._pendingOpenId = null;
    v._narrow = false;
    v._calls = { show: 0, detail: null, sidebar: 0, list: 0 };
    v.show = function () {
      this._calls.show++;
      this._visible = true;
      this._renderEntryList();
      this._selectFirstEntry();
    };
    v._renderSidebarActive = function () { this._calls.sidebar++; };
    v._renderEntryList = function () { this._calls.list++; };
    v._selectEntry = function (entry) { this._calls.detail = entry; this._selectedEntry = entry; };
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

describe('CodexViewerUI._handleListKey — reading-follows-selection stepping', () => {
  // The 3-column viewer moves selection AND renders the reading pane on ↑/↓.
  // Build a stub that resolves a fixed list and records which entry was
  // selected, so we can exercise the pure stepping logic headless.
  const LIST = [entry('a'), entry('b'), entry('c')];
  function makeNavViewer() {
    const v = makeViewer({
      getCategory: () => LIST,
      entries: LIST,
    });
    v._selectedCategory = 'PROPULSION';
    v._focusIdx = 0;
    v._narrow = false;
    v._selected = [];
    v._selectEntry = function (e) { this._selectedEntry = e; this._selected.push(e.id); };
    v._applyRowFocus = function () {};
    return v;
  }

  it('ArrowDown advances selection and renders the next entry', () => {
    const v = makeNavViewer();
    v._handleListKey('ArrowDown');
    assert.equal(v._focusIdx, 1, 'focus moved down');
    assert.equal(v._selectedEntry.id, 'b', 'reading pane followed selection');
  });

  it('ArrowUp retreats selection', () => {
    const v = makeNavViewer();
    v._focusIdx = 2;
    v._handleListKey('ArrowUp');
    assert.equal(v._focusIdx, 1);
    assert.equal(v._selectedEntry.id, 'b');
  });

  it('End jumps to the last entry, Home to the first', () => {
    const v = makeNavViewer();
    v._handleListKey('End');
    assert.equal(v._selectedEntry.id, 'c');
    v._handleListKey('Home');
    assert.equal(v._selectedEntry.id, 'a');
  });

  it('ArrowDown clamps at the last entry', () => {
    const v = makeNavViewer();
    v._focusIdx = 2;
    v._handleListKey('ArrowDown');
    assert.equal(v._focusIdx, 2, 'stays at the bottom');
  });

  it('in narrow mode, arrowing moves focus but does NOT open the reading pane', () => {
    const v = makeNavViewer();
    v._narrow = true;
    v._handleListKey('ArrowDown');
    assert.equal(v._focusIdx, 1, 'focus still moves');
    assert.equal(v._selected.length, 0, 'no reading pane opened until Enter/click');
  });

  it('Enter opens the focused entry (both modes)', () => {
    const v = makeNavViewer();
    v._narrow = true;
    v._focusIdx = 2;
    v._handleListKey('Enter');
    assert.equal(v._selectedEntry.id, 'c', 'Enter opens the focused entry');
  });
});

describe('CodexViewerUI seen-dwell timer — CODEX_VIEWED fires only after a rest', () => {
  // The dwell timer marks an entry seen only once the selection has *rested*
  // ~1.5s on an unlocked/unseen entry — arrow-scrubbing never marks seen. The
  // Node harness has no DOM/timers, so we exercise the injectable seam:
  // _setSeenTimerHooks swaps setTimeout/clearTimeout for a controllable fake.

  /** A fake scheduler the test drives by hand. */
  function fakeClock() {
    const pending = new Map();
    let nextId = 1;
    return {
      schedule(fn) { const id = nextId++; pending.set(id, fn); return id; },
      cancel(id) { pending.delete(id); },
      /** Fire the callback for a still-armed handle (simulates dwell expiry). */
      fire(id) { const fn = pending.get(id); if (fn) { pending.delete(id); fn(); } },
      size() { return pending.size; },
    };
  }

  /** Build a viewer wired to a fake clock, capturing CODEX_VIEWED emits.
   * _selectEntry is left REAL so it arms the timer; its DOM-touching helpers
   * are stubbed. */
  function makeSeenViewer(list) {
    const v = makeViewer({
      getCategory: () => list,
      entries: list,
    });
    v._selectedCategory = 'PROPULSION';
    v._focusIdx = -1;
    v._narrow = false;
    v._selectedEntry = null;
    v._seenTimer = null;
    v._scheduleSeen = (fn, ms) => setTimeout(fn, ms);
    v._cancelSeen = (h) => clearTimeout(h);
    // Stub the DOM-heavy side-effects of _selectEntry.
    v._applyRowFocus = function () {};
    v._renderReading = function () {};
    v._applyResponsiveLayout = function () {};

    const clock = fakeClock();
    v._setSeenTimerHooks(clock.schedule, clock.cancel);

    const seen = [];
    const off = eventBus.on(Events.CODEX_VIEWED, (p) => seen.push(p.id));
    return { v, clock, seen, off };
  }

  const LIST = [
    entry('a', { unlocked: true }),
    entry('b', { unlocked: true }),
  ];

  it('resting on an unlocked/unseen entry emits CODEX_VIEWED once', () => {
    const { v, clock, seen, off } = makeSeenViewer(LIST);
    try {
      v._selectEntry(LIST[0]);
      assert.equal(seen.length, 0, 'no emit before the dwell elapses');
      assert.equal(clock.size(), 1, 'one timer armed');
      clock.fire(v._seenTimer);
      assert.deepEqual(seen, ['a'], 'emits after the rest');
      assert.equal(v._seenTimer, null, 'handle cleared after firing');
    } finally { off(); }
  });

  it('re-selecting before the dwell elapses cancels the pending emit', () => {
    const { v, clock, seen, off } = makeSeenViewer(LIST);
    try {
      v._selectEntry(LIST[0]);
      const firstHandle = v._seenTimer;
      // Scrub to the next entry before the first dwell fires.
      v._selectEntry(LIST[1]);
      clock.fire(firstHandle); // stale handle — already cancelled, no-op
      assert.equal(seen.length, 0, 'scrubbed-past entry never marked seen');
      // The current selection still has a live timer.
      assert.equal(clock.size(), 1, 'only the latest timer remains armed');
      clock.fire(v._seenTimer);
      assert.deepEqual(seen, ['b'], 'only the rested entry emits');
    } finally { off(); }
  });

  it('locked entries never arm the timer', () => {
    const { v, clock, seen, off } = makeSeenViewer([entry('locked', { unlocked: false })]);
    try {
      v._selectEntry({ id: 'locked', unlocked: false, category: 'PROPULSION' });
      assert.equal(clock.size(), 0, 'no timer armed for a locked entry');
      assert.equal(seen.length, 0);
    } finally { off(); }
  });

  it('already-seen entries never arm the timer', () => {
    const { v, clock, seen, off } = makeSeenViewer(LIST);
    try {
      v._selectEntry({ id: 'a', unlocked: true, seen: true, category: 'PROPULSION' });
      assert.equal(clock.size(), 0, 'no timer for an already-seen entry');
      assert.equal(seen.length, 0);
    } finally { off(); }
  });

  it('hide() cancels a pending emit (no mark-seen after close)', () => {
    const { v, clock, seen, off } = makeSeenViewer(LIST);
    try {
      // hide() touches _overlay; stub the DOM bits it needs.
      v._overlay = { style: {} };
      v._selectEntry(LIST[0]);
      assert.equal(clock.size(), 1, 'timer armed');
      v.hide();
      assert.equal(clock.size(), 0, 'hide() cancelled the pending emit');
      assert.equal(v._seenTimer, null, 'handle cleared');
      assert.equal(seen.length, 0, 'nothing marked seen after close');
    } finally { off(); }
  });
});

