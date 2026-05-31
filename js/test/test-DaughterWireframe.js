/**
 * test-DaughterWireframe.js — Delegation 3 (2026-05-31)
 *
 * Tests the pure-data `buildDaughterShape()` function (no DOM required)
 * and the DaughterWireframe class with a minimal DOM stub.
 *
 * @module test/test-DaughterWireframe
 */
import { describe, it, assert } from './TestRunner.js';

// ── Import the pure shape builder (no DOM access at module level) ─────────
import { buildDaughterShape } from '../ui/DaughterWireframe.js';

describe('buildDaughterShape — zones', () => {
  const shape = buildDaughterShape();

  it('returns exactly 10 zones', () => {
    assert.equal(shape.zones.length, 10);
  });

  it('zone names match spec', () => {
    const names = shape.zones.map(z => z.name);
    for (const n of [
      'Body Shell (hex)', 'EPM Pole',
      'FEEP Fore Thruster', 'FEEP Aft Thruster',
      'ROSA Panel L', 'ROSA Panel R',
      'Net Pack', 'Bridle Ring', 'Status Light', 'Tether',
    ]) {
      assert.ok(names.includes(n), `has zone: ${n}`);
    }
  });

  it('Net Pack defaults to RED (no nets), Body Shell to GREEN', () => {
    const byName = {};
    for (const z of shape.zones) byName[z.name] = z.risk;
    assert.equal(byName['Net Pack'],        'RED',    'Net Pack is RED by default');
    assert.equal(byName['Body Shell (hex)'],'GREEN',  'Body Shell is GREEN');
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

describe('buildDaughterShape — vertices', () => {
  const shape = buildDaughterShape();

  it('vertex count is 48', () => {
    assert.equal(shape.vertices.length, 48);
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

// ── DaughterWireframe class — per-test canvas shim ───────────────────────

import { DaughterWireframe } from '../ui/DaughterWireframe.js';

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

describe('DaughterWireframe class', () => {
  it('instantiates without throwing', () => _withCanvasShim(() => {
    const dw = new DaughterWireframe();
    assert.ok(dw, 'instance created');
    dw.destroy();
  }));

  it('is not visible at construction', () => _withCanvasShim(() => {
    const dw = new DaughterWireframe();
    assert.ok(!dw._visible, 'not visible at start');
    dw.destroy();
  }));

  it('show() / hide() toggle works', () => _withCanvasShim(() => {
    const dw = new DaughterWireframe();
    dw.show();
    assert.ok(dw._visible, 'visible after show()');
    dw.hide();
    assert.ok(!dw._visible, 'hidden after hide()');
    dw.destroy();
  }));

  it('setPilotedArm(null) leaves _arm null', () => _withCanvasShim(() => {
    const dw = new DaughterWireframe();
    dw.setPilotedArm(null);
    assert.equal(dw._arm, null, '_arm is null');
    dw.destroy();
  }));

  it('setPilotedArm(arm, idx) stores arm and index', () => _withCanvasShim(() => {
    const dw      = new DaughterWireframe();
    const fakeArm = { state: 'DOCKED', netInventory: 3, _statusLightMat: null };
    dw.setPilotedArm(fakeArm, 2);
    assert.equal(dw._arm, fakeArm, '_arm reference set');
    assert.equal(dw._armIndex, 2,  '_armIndex correct');
    dw.destroy();
  }));

  it('Net Pack turns GREEN when arm carries nets > 0', () => _withCanvasShim(() => {
    const dw      = new DaughterWireframe();
    const fakeArm = { state: 'TRANSIT', netInventory: 2, _statusLightMat: null };
    dw.setPilotedArm(fakeArm, 0);
    const netZone = dw._shape.zones.find(z => z.name === 'Net Pack');
    assert.equal(netZone.risk, 'GREEN', 'Net Pack is GREEN when nets > 0');
    dw.destroy();
  }));

  it('Net Pack stays RED when arm carries 0 nets', () => _withCanvasShim(() => {
    const dw      = new DaughterWireframe();
    const fakeArm = { state: 'TRANSIT', netInventory: 0, _statusLightMat: null };
    dw.setPilotedArm(fakeArm, 0);
    const netZone = dw._shape.zones.find(z => z.name === 'Net Pack');
    assert.equal(netZone.risk, 'RED', 'Net Pack is RED when nets = 0');
    dw.destroy();
  }));

  it('setZoneHighlight and cycleZone work as expected', () => _withCanvasShim(() => {
    const dw = new DaughterWireframe();
    const n  = dw._shape.zones.length;
    dw.setZoneHighlight(0);
    assert.equal(dw._zoneIndex, 0,  'setZoneHighlight(0) → 0');
    dw.setZoneHighlight(null);
    assert.equal(dw._zoneIndex, -1, 'setZoneHighlight(null) → -1');
    dw.setZoneHighlight(n - 1);
    dw.cycleZone(1);
    assert.equal(dw._zoneIndex, 0,  'cycleZone wraps at end');
    dw.destroy();
  }));

  it('Bridle Ring zone exists in shape', () => _withCanvasShim(() => {
    const dw = new DaughterWireframe();
    const br = dw._shape.zones.find(z => z.name === 'Bridle Ring');
    assert.ok(br, 'Bridle Ring zone present');
    assert.ok(br.edges.length > 0, 'Bridle Ring has edges');
    dw.destroy();
  }));
});
