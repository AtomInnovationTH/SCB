/**
 * test-GlossaryDom.js — shared DOM affordances for the inline glossary (§11.8).
 *
 * glossaryDom.js is the browser-only sibling of the pure decorator. These tests
 * drive it through a minimal document/element shim (no jsdom) to lock in:
 *   • ensureGlossaryCss — injects once, is idempotent, and never throws on a
 *     minimal DOM (no head/documentElement)
 *   • delegateGlossaryClicks — emits CODEX_OPEN_ENTRY only for a
 *     `.glossary-term[data-entry]`, stops propagation, is idempotent, and
 *     supports capture-phase registration
 *
 * @module test/test-GlossaryDom
 */

import { describe, it, assert } from './TestRunner.js';
import { ensureGlossaryCss, delegateGlossaryClicks } from '../ui/glossaryDom.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';

// ─── tiny element shim ──────────────────────────────────────────────────────
function makeEl(tag = 'div') {
  return {
    tagName: tag,
    id: '',
    dataset: {},
    children: [],
    _handlers: [],
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn, capture) { this._handlers.push({ type, fn, capture: !!capture }); },
    // Test helper: fire a click whose target is `target`.
    _fireClick(target) {
      let stopped = false;
      const evt = { type: 'click', target, stopPropagation() { stopped = true; } };
      for (const h of this._handlers) if (h.type === 'click') h.fn(evt);
      return stopped;
    },
  };
}

// A "term span" whose closest('.glossary-term') resolves to itself.
function makeTermSpan(entryId) {
  const span = { dataset: entryId ? { entry: entryId } : {} };
  span.closest = (sel) => (sel === '.glossary-term' ? span : null);
  return span;
}

function makeDoc({ withHead = true } = {}) {
  const store = {};
  const head = makeEl('head');
  const doc = {
    _created: [],
    createElement(tag) { const el = makeEl(tag); this._created.push(el); return el; },
    getElementById(id) { return store[id] || null; },
    _register(el) { if (el.id) store[el.id] = el; },
  };
  if (withHead) doc.head = head;
  // wire appendChild on head to register by id so getElementById sees it
  head.appendChild = (c) => { head.children.push(c); doc._register(c); return c; };
  return doc;
}

// ─── ensureGlossaryCss ────────────────────────────────────────────────────────
describe('glossaryDom.ensureGlossaryCss', () => {
  it('injects a <style> with the glossary-term-css id once', () => {
    const doc = makeDoc();
    ensureGlossaryCss(doc);
    const styles = doc._created.filter(e => e.tagName === 'style');
    assert.equal(styles.length, 1, 'one style element created');
    assert.equal(styles[0].id, 'glossary-term-css', 'tagged with the css id');
    assert.ok(styles[0].textContent.includes('.glossary-term'), 'carries the rule');
  });

  it('is idempotent (second call is a no-op)', () => {
    const doc = makeDoc();
    ensureGlossaryCss(doc);
    ensureGlossaryCss(doc);
    const styles = doc._created.filter(e => e.tagName === 'style');
    assert.equal(styles.length, 1, 'still only one style element');
  });

  it('does not throw on a minimal DOM with no head/documentElement', () => {
    const doc = makeDoc({ withHead: false });   // no head, no documentElement, no body
    ensureGlossaryCss(doc);                       // must not throw
    assert.ok(true, 'survived a mount-less document');
  });

  it('does not throw when doc is null/invalid', () => {
    ensureGlossaryCss(null);
    ensureGlossaryCss({});
    assert.ok(true, 'tolerates missing/invalid document');
  });
});

// ─── delegateGlossaryClicks ──────────────────────────────────────────────────
describe('glossaryDom.delegateGlossaryClicks', () => {
  function withCapture(fn) {
    const events = [];
    const off = eventBus.on(Events.CODEX_OPEN_ENTRY, (p) => events.push(p));
    try { fn(events); } finally { off(); }
  }

  it('emits CODEX_OPEN_ENTRY for a term with data-entry', () => {
    withCapture((events) => {
      const el = makeEl();
      delegateGlossaryClicks(el);
      const stopped = el._fireClick(makeTermSpan('delta_v'));
      assert.deepEqual(events, [{ id: 'delta_v' }], 'emitted with the entry id');
      assert.equal(stopped, true, 'stopped propagation on a term hit');
    });
  });

  it('does NOT emit for a hover-only term (no data-entry)', () => {
    withCapture((events) => {
      const el = makeEl();
      delegateGlossaryClicks(el);
      const stopped = el._fireClick(makeTermSpan(null));
      assert.equal(events.length, 0, 'no emit without data-entry');
      assert.equal(stopped, false, 'did not stop propagation');
    });
  });

  it('does NOT emit for a click outside any glossary term', () => {
    withCapture((events) => {
      const el = makeEl();
      delegateGlossaryClicks(el);
      const nonTerm = { dataset: {}, closest: () => null };
      el._fireClick(nonTerm);
      assert.equal(events.length, 0, 'plain clicks are ignored');
    });
  });

  it('is idempotent — repeated calls do not stack handlers', () => {
    withCapture((events) => {
      const el = makeEl();
      delegateGlossaryClicks(el);
      delegateGlossaryClicks(el);
      delegateGlossaryClicks(el);
      el._fireClick(makeTermSpan('delta_v'));
      assert.equal(events.length, 1, 'exactly one emit despite 3 attaches');
    });
  });

  it('registers in capture phase when { capture:true }', () => {
    const el = makeEl();
    delegateGlossaryClicks(el, { capture: true });
    assert.equal(el._handlers.length, 1, 'one handler registered');
    assert.equal(el._handlers[0].capture, true, 'capture flag honoured');
  });

  it('tolerates a null element', () => {
    delegateGlossaryClicks(null);
    assert.ok(true, 'no throw on null el');
  });
});
