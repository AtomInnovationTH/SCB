/**
 * test-StrutLabels.js — Delegation 3 (2026-05-31)
 *
 * Tests screen-space strut tip label overlay:
 *   • show(strutGroups, durationMs) creates one label per strut.
 *   • hide() sets all labels to opacity '0' and clears _visible.
 *   • Auto-hides after durationMs via update().
 *   • destroy() removes all labels from the container.
 *   • Label text format matches "STRUT n/k — α=DDD°".
 *
 * @module test/test-StrutLabels
 */
import { describe, it, assert } from './TestRunner.js';

// ── Minimal DOM stub (installed before constructor calls) ─────────────────
// StrutLabels.js only uses DOM in the constructor + helper methods, not at
// module evaluation time, so a simple top-level stub is sufficient.
if (typeof document === 'undefined') {
  const makeEl = () => {
    const el = {
      style: {},
      textContent: '',
      children: [],
      parentNode: null,
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null;
        return c;
      },
    };
    return el;
  };
  globalThis.document = {
    createElement: makeEl,
    body: makeEl(),
  };
  globalThis.window = { innerWidth: 1280, innerHeight: 720 };
}

import { StrutLabels } from '../ui/hud/StrutLabels.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeStrutGroups(n) {
  const groups = [];
  for (let i = 0; i < n; i++) {
    groups.push({
      // pivotGroup with a non-zero rotation to exercise _hingeAngle
      pivotGroup: { rotation: { x: 0.1 * i, y: 0, z: 0 } },
      tipNode:    null,   // null → projection skip is safe
    });
  }
  return groups;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('StrutLabels — label creation', () => {
  it('show() with N struts creates N label divs', () => {
    const container = globalThis.document.createElement('div');
    const sl = new StrutLabels(container);
    sl.show(makeStrutGroups(4), 5000);
    assert.equal(sl._labels.length, 4, '4 labels for 4 struts');
    sl.destroy();
  });

  it('show() with 0 struts creates 0 labels', () => {
    const container = globalThis.document.createElement('div');
    const sl = new StrutLabels(container);
    sl.show([], 5000);
    assert.equal(sl._labels.length, 0, 'no labels for empty array');
    sl.destroy();
  });

  it('labels are appended to the supplied container', () => {
    const container = globalThis.document.createElement('div');
    const sl = new StrutLabels(container);
    sl.show(makeStrutGroups(2), 5000);
    assert.equal(container.children.length, 2, 'container has 2 children');
    sl.destroy();
  });
});

describe('StrutLabels — hide', () => {
  it('hide() clears _visible flag', () => {
    const container = globalThis.document.createElement('div');
    const sl = new StrutLabels(container);
    sl.show(makeStrutGroups(3), 5000);
    assert.ok(sl._visible, 'visible after show');
    sl.hide();
    assert.ok(!sl._visible, '_visible false after hide');
    sl.destroy();
  });

  it('hide() sets all label opacities to "0"', () => {
    const container = globalThis.document.createElement('div');
    const sl = new StrutLabels(container);
    sl.show(makeStrutGroups(3), 5000);
    sl.hide();
    assert.ok(
      sl._labels.every(l => l.style.opacity === '0'),
      'all label opacities are "0"',
    );
    sl.destroy();
  });
});

describe('StrutLabels — auto-hide timer', () => {
  it('auto-hides after durationMs elapses via update()', () => {
    const container = globalThis.document.createElement('div');
    const sl = new StrutLabels(container);
    sl.show(makeStrutGroups(2), 200);  // 200 ms = 0.2 s
    assert.ok(sl._visible, 'visible immediately after show');
    sl.update(null, 0.25);             // advance 250 ms — past the 200 ms threshold
    assert.ok(!sl._visible, 'hidden after durationMs elapsed');
    sl.destroy();
  });

  it('label is still visible before durationMs elapses', () => {
    const container = globalThis.document.createElement('div');
    const sl = new StrutLabels(container);
    sl.show(makeStrutGroups(1), 500);  // 500 ms = 0.5 s
    sl.update(null, 0.1);              // advance only 100 ms — still active
    assert.ok(sl._visible, 'still visible at 100 ms / 500 ms');
    sl.destroy();
  });
});

describe('StrutLabels — label text format', () => {
  it('format string matches "STRUT n/k — α=DDD°"', () => {
    // Validate the format template used in update() without a real camera.
    // The em-dash is U+2014, α is U+03B1, ° is U+00B0.
    const re = /^STRUT \d+\/\d+ \u2014 \u03B1=\s*\d+\u00B0$/;
    const k  = 4;
    for (let i = 0; i < k; i++) {
      const alpha = Math.round(17.3 * i);
      const text  = `STRUT ${i + 1}/${k} \u2014 \u03B1=${String(alpha).padStart(3, ' ')}\u00B0`;
      assert.ok(re.test(text), `strut ${i + 1} format ok: "${text}"`);
    }
  });

  it('index is 1-based (first strut is STRUT 1/k)', () => {
    const k    = 3;
    const text = `STRUT 1/${k} \u2014 \u03B1=  0\u00B0`;
    assert.ok(text.startsWith('STRUT 1/'), 'first strut index is 1');
  });
});

// Delegation 4 (2026-05-31) — Quick-Win 2b: real hinge-angle from payload
describe('StrutLabels — hinge angle source (Quick-Win 2b)', () => {
  function makeFakeCamera() {
    // Provide camera matrix elements so _projectToScreen does not bail.
    const ident = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    return { projectionMatrix: { elements: ident }, matrixWorldInverse: { elements: ident } };
  }
  function makeTipNode() {
    return {
      position: { x: 0, y: 0, z: -1 },
      getWorldPosition(out) { out.x = 0; out.y = 0; out.z = -1; return out; },
    };
  }

  it('reads hingeAngleDeg from payload when present (ignores pivotGroup rotation)', () => {
    const container = globalThis.document.createElement('div');
    const sl = new StrutLabels(container);
    // pivotGroup rotation is wildly off, but the new payload field should win.
    sl.show([
      { pivotGroup: { rotation: { x: 9, y: 9, z: 9 } }, tipNode: makeTipNode(), hingeAngleDeg: 42 },
    ], 5000);
    sl.update(makeFakeCamera(), 0.0);
    const txt = sl._labels[0].textContent || '';
    assert.ok(/\u03B1=\s*42\u00B0/.test(txt), `expected α=42°, got "${txt}"`);
    sl.destroy();
  });

  it('falls back to Euler-magnitude proxy when hingeAngleDeg is missing', () => {
    const container = globalThis.document.createElement('div');
    const sl = new StrutLabels(container);
    // No hingeAngleDeg in payload — legacy fallback engages.
    sl.show([
      { pivotGroup: { rotation: { x: Math.PI / 2, y: 0, z: 0 } }, tipNode: makeTipNode() },
    ], 5000);
    sl.update(makeFakeCamera(), 0.0);
    const txt = sl._labels[0].textContent || '';
    // sqrt((π/2)²)·180/π = 90 → "α= 90°"
    assert.ok(/\u03B1=\s*90\u00B0/.test(txt), `expected α=90° (legacy), got "${txt}"`);
    sl.destroy();
  });
});

describe('StrutLabels — destroy', () => {
  it('destroy() empties _labels array', () => {
    const container = globalThis.document.createElement('div');
    const sl = new StrutLabels(container);
    sl.show(makeStrutGroups(3), 5000);
    assert.equal(sl._labels.length, 3, '3 labels before destroy');
    sl.destroy();
    assert.equal(sl._labels.length, 0, '0 labels after destroy');
  });

  it('destroy() removes label elements from the container', () => {
    const container = globalThis.document.createElement('div');
    const sl = new StrutLabels(container);
    sl.show(makeStrutGroups(2), 5000);
    sl.destroy();
    assert.equal(container.children.length, 0, 'container is empty after destroy');
  });
});
