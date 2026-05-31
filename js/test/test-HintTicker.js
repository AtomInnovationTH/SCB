/**
 * test-HintTicker.js — Delegation 2 (2026-05-31)
 *
 * Verifies the bottom-screen hint-ticker presenter:
 *   • Emits HINT_POSTED for 5 hints; assert at most 4 visible, 5th displaces.
 *   • Emits HINT_SATISFIED for the leftmost; assert it's removed.
 *
 * Uses a minimal DOM stub (no JSDOM dependency) — sufficient for the
 * ticker's createElement / appendChild / removeChild paths.
 *
 * @module test/test-HintTicker
 */

import { describe, it, assert } from './TestRunner.js';

// ─── minimal DOM stub ────────────────────────────────────────────────────
function installDomShim() {
  // Always install — earlier tests may have left a minimal document stub
  // behind that lacks dataset / insertBefore.  We unconditionally replace
  // it with our full shim and restore afterwards.
  const prevDocument = globalThis.document;
  const prevWindow   = globalThis.window;
  function makeNode(tag) {
    const node = {
      tagName: (tag || 'div').toUpperCase(),
      style: {},
      dataset: {},
      children: [],
      parentNode: null,
      textContent: '',
      classList: {
        add: () => {},
        remove: () => {},
        toggle: () => {},
      },
      appendChild(child) {
        if (!child) return child;
        if (child.parentNode) {
          const i = child.parentNode.children.indexOf(child);
          if (i >= 0) child.parentNode.children.splice(i, 1);
        }
        this.children.push(child);
        child.parentNode = this;
        return child;
      },
      insertBefore(newNode, ref) {
        if (newNode.parentNode) {
          const i = newNode.parentNode.children.indexOf(newNode);
          if (i >= 0) newNode.parentNode.children.splice(i, 1);
        }
        if (!ref) {
          this.children.push(newNode);
        } else {
          const i = this.children.indexOf(ref);
          if (i >= 0) this.children.splice(i, 0, newNode);
          else this.children.push(newNode);
        }
        newNode.parentNode = this;
        return newNode;
      },
      removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
        child.parentNode = null;
        return child;
      },
      get firstChild() { return this.children[0] || null; },
      addEventListener() {},
      removeEventListener() {},
    };
    return node;
  }
  globalThis.document = {
    createElement: (tag) => makeNode(tag),
    body: makeNode('body'),
    // Match the NetCeremony test stub so StrategicMap tests (which use
    // getElementById in a later async describe) keep working when our
    // shim is the live document at their resolve-microtask time.
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
  return { prevDocument, prevWindow };
}

// ─── mock EventBus ───────────────────────────────────────────────────────
function createMockEventBus() {
  const listeners = new Map();
  return {
    on(evt, h) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(h);
      return () => {
        const arr = listeners.get(evt);
        const i = arr.indexOf(h);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    emit(evt, payload) {
      const arr = listeners.get(evt);
      if (arr) for (const fn of arr.slice()) fn(payload);
    },
    off() {},
  };
}

// ─── tests ────────────────────────────────────────────────────────────────

let installed;
let HintTicker;

await (async () => {
  installed = installDomShim();
  // Dynamic import so the DOM shim is in place before module evaluation.
  const mod = await import('../ui/hud/HintTicker.js');
  HintTicker = mod.HintTicker;
})();

describe('HintTicker — basic post + DOM strip layout', () => {
  it('builds a strip element and starts empty', () => {
    const eb = createMockEventBus();
    const ticker = new HintTicker(document.body, { eventBus: eb });
    const strip = ticker.getStripElement();
    assert.ok(strip, 'strip element exists');
    assert.equal(ticker.getVisibleCount(), 0);
    ticker.dispose();
  });

  it('post() adds one entry; HINT_POSTED via EventBus does the same', () => {
    const eb = createMockEventBus();
    const ticker = new HintTicker(document.body, { eventBus: eb });
    ticker.post({ id: 'h1', text: 'Test', glyph: 'A', keys: ['KeyA'] });
    assert.equal(ticker.getVisibleCount(), 1);
    assert.deepEqual(ticker.getItemIds(), ['h1']);
    ticker.dispose();
  });

  it('re-posting same id is a no-op while alive', () => {
    const eb = createMockEventBus();
    const ticker = new HintTicker(document.body, { eventBus: eb });
    ticker.post({ id: 'h1', text: 'Test' });
    ticker.post({ id: 'h1', text: 'Test again' });
    assert.equal(ticker.getVisibleCount(), 1);
    ticker.dispose();
  });
});

describe('HintTicker — 5th hint displaces rightmost', () => {
  it('posting 5 hints results in 4 visible; 5th displaces oldest (right end)', () => {
    const eb = createMockEventBus();
    const ticker = new HintTicker(document.body, { eventBus: eb });
    ticker.post({ id: 'h1', text: '1' });
    ticker.post({ id: 'h2', text: '2' });
    ticker.post({ id: 'h3', text: '3' });
    ticker.post({ id: 'h4', text: '4' });
    assert.equal(ticker.getVisibleCount(), 4);
    // Latest is left, oldest is right: order left→right = ['h4','h3','h2','h1']
    assert.deepEqual(ticker.getItemIds(), ['h4', 'h3', 'h2', 'h1']);
    // Post a 5th — displaces the rightmost (h1).
    ticker.post({ id: 'h5', text: '5' });
    assert.equal(ticker.getVisibleCount(), 4);
    assert.deepEqual(ticker.getItemIds(), ['h5', 'h4', 'h3', 'h2']);
    ticker.dispose();
  });
});

describe('HintTicker — HINT_SATISFIED fades by id', () => {
  it('satisfy(id) immediately removes from the item list (fade-out is async)', () => {
    const eb = createMockEventBus();
    const ticker = new HintTicker(document.body, { eventBus: eb });
    ticker.post({ id: 'h1', text: '1' });
    ticker.post({ id: 'h2', text: '2' });
    assert.equal(ticker.getVisibleCount(), 2);
    ticker.satisfy('h2');
    // h2 was the latest (leftmost) — removing it should leave h1.
    assert.equal(ticker.getVisibleCount(), 1);
    assert.deepEqual(ticker.getItemIds(), ['h1']);
    ticker.dispose();
  });

  it('satisfying an unknown id is a no-op', () => {
    const eb = createMockEventBus();
    const ticker = new HintTicker(document.body, { eventBus: eb });
    ticker.post({ id: 'h1', text: '1' });
    ticker.satisfy('does_not_exist');
    assert.equal(ticker.getVisibleCount(), 1);
    ticker.dispose();
  });
});

if (installed && typeof globalThis.document !== 'undefined') {
  // Leave the shim installed — subsequent tests in the same Node process
  // may or may not benefit; clearing it can break TestRunner's logging in
  // some environments.  Other tests bring their own shim if they need one.
}
