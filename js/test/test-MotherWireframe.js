/**
 * test-MotherWireframe.js — Delegation 3 (2026-05-31)
 *
 * Tests the pure-data `buildMotherShape()` function (no DOM required)
 * and the MotherWireframe class with a minimal DOM stub.
 *
 * @module test/test-MotherWireframe
 */
import { describe, it, assert } from './TestRunner.js';

// ── Import the pure shape builder (no DOM access at module level) ─────────
import { buildMotherShape } from '../ui/MotherWireframe.js';

describe('buildMotherShape — zones', () => {
  const shape = buildMotherShape();

  it('returns exactly 11 zones', () => {
    assert.equal(shape.zones.length, 11);
  });

  it('zone names match spec', () => {
    const names = shape.zones.map(z => z.name);
    const required = [
      'Barrel (bus)', 'Collar Ring', 'Struts (4)', 'FEEP Thrusters',
      'ROSA Solar Wings', 'Sensor Cluster', 'Docking Port', 'Laser Aperture',
      'Front/Rear Caps', 'Navigation Lights', 'Daughters',
    ];
    for (const n of required) {
      assert.ok(names.includes(n), `has zone: ${n}`);
    }
  });

  it('Laser Aperture is RED, Struts/FEEP/Arms are YELLOW, rest GREEN', () => {
    const byName = {};
    for (const z of shape.zones) byName[z.name] = z.risk;
    assert.equal(byName['Laser Aperture'],   'RED',    'Laser is RED');
    assert.equal(byName['Struts (4)'],       'YELLOW', 'Struts are YELLOW');
    assert.equal(byName['FEEP Thrusters'],   'YELLOW', 'FEEP are YELLOW');
    assert.equal(byName['Daughters'],        'YELLOW', 'Daughters are YELLOW');
    assert.equal(byName['Barrel (bus)'],     'GREEN',  'Barrel is GREEN');
    assert.equal(byName['ROSA Solar Wings'], 'GREEN',  'ROSA is GREEN');
    assert.equal(byName['Docking Port'],     'GREEN',  'Dock is GREEN');
  });

  it('all risk values are GREEN, YELLOW, or RED', () => {
    for (const z of shape.zones) {
      assert.ok(
        ['GREEN', 'YELLOW', 'RED'].includes(z.risk),
        `${z.name}.risk="${z.risk}" is valid`,
      );
    }
  });

  it('all mass percents are positive integers', () => {
    for (const z of shape.zones) {
      assert.ok(
        Number.isInteger(z.massPercent) && z.massPercent > 0,
        `${z.name}.massPercent=${z.massPercent} is a positive integer`,
      );
    }
  });
});

describe('buildMotherShape — vertices', () => {
  const shape = buildMotherShape();

  it('vertex count is 88', () => {
    assert.equal(shape.vertices.length, 88);
  });

  it('every vertex is a 3-element array of finite numbers', () => {
    for (let i = 0; i < shape.vertices.length; i++) {
      const v = shape.vertices[i];
      assert.ok(
        Array.isArray(v) && v.length === 3,
        `vert[${i}] is a 3-element array`,
      );
      assert.ok(
        v.every(n => Number.isFinite(n)),
        `vert[${i}] contains finite numbers`,
      );
    }
  });

  it('all zone edge pairs [a, b] are within vertex bounds', () => {
    const n = shape.vertices.length;
    for (const zone of shape.zones) {
      for (const [a, b] of zone.edges) {
        assert.ok(a >= 0 && a < n,
          `zone "${zone.name}" edge a=${a} is within [0, ${n})`,
        );
        assert.ok(b >= 0 && b < n,
          `zone "${zone.name}" edge b=${b} is within [0, ${n})`,
        );
      }
    }
  });
});

// ── MotherWireframe class — per-test canvas shim ─────────────────────────
// Use a save/restore shim inside each test; HintTicker leaves a non-canvas
// document stub in globalThis that would break canvas element construction.

import { MotherWireframe } from '../ui/MotherWireframe.js';

function _withCanvasShim(fn) {
  const savedDoc = globalThis.document;
  const savedWin = globalThis.window;
  let _nid = 0;
  const makeCtx = () => ({
    scale: () => {}, clearRect: () => {}, fillRect: () => {}, fillText: () => {},
    strokeStyle: '', fillStyle: '', lineWidth: 1, globalAlpha: 1, font: '',
    textAlign: '', beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
    stroke: () => {}, save: () => {}, restore: () => {},
    measureText: () => ({ width: 0 }),
    imageSmoothingEnabled: true, imageSmoothingQuality: '',
    createRadialGradient: () => ({ addColorStop: () => {} }),
  });
  const makeEl = () => {
    const el = {
      style: {}, dataset: {}, children: [], parentNode: null, textContent: '',
      width: 0, height: 0,
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) {
        const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null; return c;
      },
      getContext: () => makeCtx(),
      _id: ++_nid,
    };
    return el;
  };
  globalThis.document = {
    createElement: makeEl,
    body: Object.assign(makeEl(), {
      removeChild(c) {
        const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1);
        c.parentNode = null; return c;
      },
    }),
  };
  globalThis.window = { devicePixelRatio: 1 };
  try {
    return fn();
  } finally {
    globalThis.document = savedDoc;
    globalThis.window   = savedWin;
  }
}

describe('MotherWireframe class', () => {
  it('instantiates without throwing', () => _withCanvasShim(() => {
    const mw = new MotherWireframe();
    assert.ok(mw, 'instance created');
    mw.destroy();
  }));

  it('shape is pre-built (11 zones) at construction', () => _withCanvasShim(() => {
    const mw = new MotherWireframe();
    assert.equal(mw._shape.zones.length, 11, '11 zones in shape');
    mw.destroy();
  }));

  it('show() sets _visible = true; hide() clears it', () => _withCanvasShim(() => {
    const mw = new MotherWireframe();
    assert.ok(!mw._visible, 'initially hidden');
    mw.show();
    assert.ok(mw._visible, 'visible after show()');
    mw.hide();
    assert.ok(!mw._visible, 'hidden after hide()');
    mw.destroy();
  }));

  it('setZoneHighlight(0) sets index to 0', () => _withCanvasShim(() => {
    const mw = new MotherWireframe();
    mw.setZoneHighlight(0);
    assert.equal(mw._zoneIndex, 0);
    mw.destroy();
  }));

  it('setZoneHighlight(null) resets to -1 (auto-rotation)', () => _withCanvasShim(() => {
    const mw = new MotherWireframe();
    mw.setZoneHighlight(5);
    mw.setZoneHighlight(null);
    assert.equal(mw._zoneIndex, -1);
    mw.destroy();
  }));

  it('setZoneHighlight clamps values to [0, zoneCount-1]', () => _withCanvasShim(() => {
    const mw = new MotherWireframe();
    const n  = mw._shape.zones.length;
    mw.setZoneHighlight(999);
    assert.equal(mw._zoneIndex, n - 1, 'clamped to max');
    mw.setZoneHighlight(-99);
    assert.equal(mw._zoneIndex, 0, 'clamped to min');
    mw.destroy();
  }));

  it('cycleZone(+1) advances zone index', () => _withCanvasShim(() => {
    const mw = new MotherWireframe();
    mw.setZoneHighlight(0);
    mw.cycleZone(1);
    assert.equal(mw._zoneIndex, 1);
    mw.destroy();
  }));

  it('cycleZone wraps around at zone count', () => _withCanvasShim(() => {
    const mw = new MotherWireframe();
    const n  = mw._shape.zones.length;
    mw.setZoneHighlight(n - 1);
    mw.cycleZone(1);
    assert.equal(mw._zoneIndex, 0, 'wraps to 0 after last zone');
    mw.destroy();
  }));
});
