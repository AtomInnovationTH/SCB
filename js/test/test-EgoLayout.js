/**
 * test-EgoLayout.js — Slice 8: pure ego-map layout guards.
 *
 * layoutEgoMap builds a deterministic two-ring radial graph around a focus
 * entry. These tests pin: determinism, ring membership + radii, related-order
 * angle assignment, 2-hop dedupe (excludes focus + ring 1) and cap, field
 * passthrough (locked/icon/title/category), edge correctness, and the
 * unknown-focus empty case.
 *
 * Node-safe: layoutEgoMap has no DOM/THREE/EventBus dependencies.
 *
 * @module test/test-EgoLayout
 */

import { describe, it, assert } from './TestRunner.js';
import { layoutEgoMap, EGO_LAYOUT_VIEW } from '../systems/codex/egoLayout.js';

// ── Inline stub graph ───────────────────────────────────────────────────────
// focus → [a, b, c]; a → [d, e]; b → [e, f]; c → [g]
// (e is shared by a and b → dedupe keeps a as first parent)
function makeStub() {
  const entries = {
    focus: { id: 'focus', title: 'Focus', icon: '🎯', category: 'NAV', unlocked: true, related: ['a', 'b', 'c'] },
    a:     { id: 'a', title: 'Alpha', icon: '🅰️', category: 'NAV', unlocked: true,  related: ['d', 'e'] },
    b:     { id: 'b', title: 'Bravo', icon: '🅱️', category: 'POWER', unlocked: false, related: ['e', 'f'] },
    c:     { id: 'c', title: 'Charlie', icon: '🇨', category: 'NAV', unlocked: true, related: ['g'] },
    d:     { id: 'd', title: 'Delta', icon: '🔺', category: 'NAV', unlocked: true, related: [] },
    e:     { id: 'e', title: 'Echo', icon: '📻', category: 'POWER', unlocked: false, related: [] },
    f:     { id: 'f', title: 'Foxtrot', icon: '🦊', category: 'NAV', unlocked: true, related: [] },
    g:     { id: 'g', title: 'Golf', icon: '⛳', category: 'POWER', unlocked: true, related: [] },
  };
  const getEntry = (id) => entries[id] || null;
  const getRelated = (id) => {
    const e = entries[id];
    if (!e) return [];
    return e.related.map(getEntry).filter(Boolean);
  };
  return { getEntry, getRelated, entries };
}

const CX = EGO_LAYOUT_VIEW.cx;
const CY = EGO_LAYOUT_VIEW.cy;

function dist(node) {
  return Math.hypot(node.x - CX, node.y - CY);
}

describe('egoLayout — determinism', () => {
  it('produces byte-identical output on repeated calls', () => {
    const { getEntry, getRelated } = makeStub();
    const a = layoutEgoMap({ focusId: 'focus', getEntry, getRelated });
    const b = layoutEgoMap({ focusId: 'focus', getEntry, getRelated });
    assert.equal(JSON.stringify(a), JSON.stringify(b), 'same inputs → same output');
  });
});

describe('egoLayout — unknown focus', () => {
  it('returns empty nodes/edges for an unknown focusId', () => {
    const { getEntry, getRelated } = makeStub();
    const out = layoutEgoMap({ focusId: 'nope', getEntry, getRelated });
    assert.equal(out.nodes.length, 0, 'no nodes');
    assert.equal(out.edges.length, 0, 'no edges');
  });

  it('returns empty when getEntry is not a function', () => {
    const out = layoutEgoMap({ focusId: 'focus' });
    assert.equal(out.nodes.length, 0, 'no nodes');
    assert.equal(out.edges.length, 0, 'no edges');
  });
});

describe('egoLayout — ring membership & radii', () => {
  it('places the focus at ring 0, centred', () => {
    const { getEntry, getRelated } = makeStub();
    const { nodes } = layoutEgoMap({ focusId: 'focus', getEntry, getRelated });
    const focus = nodes.find(n => n.id === 'focus');
    assert.equal(focus.ring, 0, 'focus is ring 0');
    assert.equal(focus.x, CX, 'centred x');
    assert.equal(focus.y, CY, 'centred y');
  });

  it('places direct related at ring 1 with radius ~210', () => {
    const { getEntry, getRelated } = makeStub();
    const { nodes } = layoutEgoMap({ focusId: 'focus', getEntry, getRelated });
    for (const id of ['a', 'b', 'c']) {
      const n = nodes.find(x => x.id === id);
      assert.equal(n.ring, 1, `${id} is ring 1`);
      assert.ok(Math.abs(dist(n) - 210) < 0.001, `${id} radius ~210`);
    }
  });

  it('places 2-hop related at ring 2 with radius ~320', () => {
    const { getEntry, getRelated } = makeStub();
    const { nodes } = layoutEgoMap({ focusId: 'focus', getEntry, getRelated });
    // 2-hop: d, f, g (e is excluded — it's promoted to nothing, see dedupe test)
    for (const id of ['d', 'f', 'g']) {
      const n = nodes.find(x => x.id === id);
      assert.equal(n.ring, 2, `${id} is ring 2`);
      assert.ok(Math.abs(dist(n) - 320) < 0.001, `${id} radius ~320`);
    }
  });
});

describe('egoLayout — ring-1 angle assignment', () => {
  it('starts the first related at -90° (top) in array order', () => {
    const { getEntry, getRelated } = makeStub();
    const { nodes } = layoutEgoMap({ focusId: 'focus', getEntry, getRelated });
    const a = nodes.find(n => n.id === 'a');
    // First ring-1 node sits directly above the centre.
    assert.ok(Math.abs(a.x - CX) < 0.001, 'first node x == centre');
    assert.ok(a.y < CY, 'first node above centre (−90°)');
  });

  it('distributes ring-1 nodes evenly by array index', () => {
    const { getEntry, getRelated } = makeStub();
    const { nodes } = layoutEgoMap({ focusId: 'focus', getEntry, getRelated });
    // 3 related → 120° apart. Node b at +30°, node c at +150° (approx by y sign).
    const b = nodes.find(n => n.id === 'b');
    const c = nodes.find(n => n.id === 'c');
    assert.ok(b.x > CX && b.y > CY, 'second node lower-right');
    assert.ok(c.x < CX && c.y > CY, 'third node lower-left');
  });

  it('spaces surviving ring-1 nodes evenly when related has a self-ref/duplicate', () => {
    // related = [self, a, a, b] → after dedupe only a, b survive → 180° apart.
    const entries = {
      focus: { id: 'focus', title: 'F', icon: '🎯', category: 'NAV', unlocked: true, related: ['focus', 'a', 'a', 'b'] },
      a: { id: 'a', title: 'A', icon: '🅰️', category: 'NAV', unlocked: true, related: [] },
      b: { id: 'b', title: 'B', icon: '🅱️', category: 'NAV', unlocked: true, related: [] },
    };
    const getEntry = (id) => entries[id] || null;
    const getRelated = (id) => (entries[id] ? entries[id].related.map(getEntry).filter(Boolean) : []);
    const { nodes } = layoutEgoMap({ focusId: 'focus', getEntry, getRelated });
    const ring1 = nodes.filter(n => n.ring === 1);
    assert.equal(ring1.length, 2, 'self-ref + duplicate removed → 2 nodes');
    const a = nodes.find(n => n.id === 'a');
    const b = nodes.find(n => n.id === 'b');
    // Two nodes at −90° and +90° → a directly above centre, b directly below.
    assert.ok(Math.abs(a.x - CX) < 0.001 && a.y < CY, 'a at top (−90°)');
    assert.ok(Math.abs(b.x - CX) < 0.001 && b.y > CY, 'b at bottom (+90°), evenly opposite — no gap');
  });
});

describe('egoLayout — 2-hop dedupe & cap', () => {
  it('excludes focus and ring-1 members from ring 2', () => {
    const { getEntry, getRelated } = makeStub();
    const { nodes } = layoutEgoMap({ focusId: 'focus', getEntry, getRelated });
    const ring2Ids = nodes.filter(n => n.ring === 2).map(n => n.id);
    assert.ok(!ring2Ids.includes('focus'), 'focus not in ring 2');
    assert.ok(!ring2Ids.includes('a') && !ring2Ids.includes('b') && !ring2Ids.includes('c'),
      'ring-1 members not in ring 2');
    // e is related to both a and b, but e is NOT a ring-1 node, so it belongs
    // in ring 2 exactly once.
    assert.equal(ring2Ids.filter(id => id === 'e').length, 1, 'e appears once');
  });

  it('keeps the first-seen parent for a shared 2-hop node', () => {
    const { getEntry, getRelated } = makeStub();
    const { edges } = layoutEgoMap({ focusId: 'focus', getEntry, getRelated });
    // e is reachable via a (parent index 0) and b (parent index 1) → keep a.
    const eEdges = edges.filter(ed => ed.to === 'e');
    assert.equal(eEdges.length, 1, 'exactly one edge into e');
    assert.equal(eEdges[0].from, 'a', 'e edge comes from first-seen parent a');
  });

  it('caps ring 2 at 12 nodes', () => {
    const entries = { focus: { id: 'focus', title: 'F', icon: '🎯', category: 'NAV', unlocked: true, related: ['p'] },
                      p: { id: 'p', title: 'P', icon: '📎', category: 'NAV', unlocked: true, related: [] } };
    // give p 20 grandchildren
    const gids = [];
    for (let i = 0; i < 20; i++) {
      const id = 'g' + String(i).padStart(2, '0');
      gids.push(id);
      entries[id] = { id, title: id, icon: '•', category: 'NAV', unlocked: true, related: [] };
    }
    entries.p.related = gids;
    const getEntry = (id) => entries[id] || null;
    const getRelated = (id) => (entries[id] ? entries[id].related.map(getEntry).filter(Boolean) : []);
    const { nodes } = layoutEgoMap({ focusId: 'focus', getEntry, getRelated });
    const ring2 = nodes.filter(n => n.ring === 2);
    assert.equal(ring2.length, 12, 'ring 2 capped at 12');
    // Sorted by id → first 12 alphabetically (g00..g11).
    assert.equal(ring2[0].id, 'g00', 'first ring-2 is g00');
    assert.equal(ring2[11].id, 'g11', 'last kept ring-2 is g11');
  });
});

describe('egoLayout — field passthrough', () => {
  it('passes through locked/icon/title/category', () => {
    const { getEntry, getRelated } = makeStub();
    const { nodes } = layoutEgoMap({ focusId: 'focus', getEntry, getRelated });
    const b = nodes.find(n => n.id === 'b');
    assert.equal(b.locked, true, 'b is locked (unlocked:false)');
    assert.equal(b.icon, '🅱️', 'icon passthrough');
    assert.equal(b.title, 'Bravo', 'title passthrough');
    assert.equal(b.category, 'POWER', 'category passthrough');
    const a = nodes.find(n => n.id === 'a');
    assert.equal(a.locked, false, 'a is unlocked');
  });

  it('defaults icon and title when missing', () => {
    const entries = { focus: { id: 'focus', unlocked: true, related: ['x'] },
                      x: { id: 'x', unlocked: true, related: [] } };
    const getEntry = (id) => entries[id] || null;
    const getRelated = (id) => (entries[id] ? entries[id].related.map(getEntry).filter(Boolean) : []);
    const { nodes } = layoutEgoMap({ focusId: 'focus', getEntry, getRelated });
    const x = nodes.find(n => n.id === 'x');
    assert.equal(x.icon, '📄', 'default icon');
    assert.equal(x.title, 'x', 'title falls back to id');
  });
});

describe('egoLayout — edges', () => {
  it('emits focus→ring1 and parent→ring2 edges only', () => {
    const { getEntry, getRelated } = makeStub();
    const { edges } = layoutEgoMap({ focusId: 'focus', getEntry, getRelated });
    // focus→a, focus→b, focus→c (3) + a→d, a→e, c→g, b→f (4) = 7
    const fromFocus = edges.filter(e => e.from === 'focus').map(e => e.to).sort();
    assert.equal(JSON.stringify(fromFocus), JSON.stringify(['a', 'b', 'c']), 'ring-1 edges');
    assert.ok(edges.some(e => e.from === 'a' && e.to === 'd'), 'a→d');
    assert.ok(edges.some(e => e.from === 'c' && e.to === 'g'), 'c→g');
    assert.ok(edges.some(e => e.from === 'b' && e.to === 'f'), 'b→f');
  });

  it('has no edges when focus has no related', () => {
    const entries = { focus: { id: 'focus', unlocked: true, related: [] } };
    const getEntry = (id) => entries[id] || null;
    const getRelated = () => [];
    const { nodes, edges } = layoutEgoMap({ focusId: 'focus', getEntry, getRelated });
    assert.equal(nodes.length, 1, 'just the focus');
    assert.equal(edges.length, 0, 'no edges');
  });
});
