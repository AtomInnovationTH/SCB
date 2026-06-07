/**
 * test-DockingReticle-ToolPanel.js — STATION_KEEP tool-selection panel (P2).
 *
 * Renders the panel against a mock 2D context and asserts the per-class rows
 * (NET / [GRIPPER|PAD] / MAGNET), the NET (n) magazine count, the ▶ selection
 * marker, and the STATION_KEEP render gate.
 */
import { describe, it, assert } from './TestRunner.js';
import { DockingReticle } from '../ui/DockingReticle.js';

function mockCtx() {
  const texts = [];
  return {
    texts,
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    fillRect() {}, strokeRect() {}, beginPath() {}, arc() {}, fill() {},
    fillText(t) { texts.push(String(t)); },
  };
}

function reticleWith(arm) {
  const r = Object.create(DockingReticle.prototype);
  r._arm = arm;
  return r;
}

function weaverArm() {
  return {
    state: 'STATION_KEEP', type: 'weaver',
    toolset: ['NET', 'GRIPPER', 'MAGNET'], selectedTool: 'MAGNET',
    _toolScores: { NET: 2, GRIPPER: 0, MAGNET: 3 },
    _toolHints: { NET: 'Weaver LD-NET', GRIPPER: '', MAGNET: 'ferrous hull — direct grip' },
    getNetInventory: () => 2,
  };
}

describe('DockingReticle — tool-selection panel', () => {
  it('renders NET / GRIPPER / MAGNET rows for a Weaver with the net count', () => {
    const r = reticleWith(weaverArm());
    const ctx = mockCtx();
    r._drawToolSelectionPanel(ctx, 400, 300);
    const blob = ctx.texts.join(' | ');
    assert.ok(blob.includes('NET (2)'), 'NET row shows magazine count');
    assert.ok(blob.includes('MAGNET'), 'MAGNET row present');
    assert.ok(blob.includes('GRIPPER'), 'GRIPPER row present');
    assert.ok(blob.includes('Weaver'), 'header names the arm class');
    assert.ok(ctx.texts.includes('\u25B6'), 'selection marker (▶) drawn for selected tool');
  });

  it('renders NET / PAD / MAGNET rows for a Spinner', () => {
    const arm = weaverArm();
    arm.type = 'spinner';
    arm.toolset = ['NET', 'PAD', 'MAGNET'];
    arm.selectedTool = 'NET';
    arm._toolScores = { NET: 3, PAD: 0, MAGNET: 0 };
    const r = reticleWith(arm);
    const ctx = mockCtx();
    r._drawToolSelectionPanel(ctx, 400, 300);
    const blob = ctx.texts.join(' | ');
    assert.ok(blob.includes('PAD'), 'PAD row present for spinner');
    assert.ok(blob.includes('MAGNET'), 'MAGNET row present for spinner');
    assert.ok(blob.includes('Spinner'), 'header names the spinner class');
  });

  it('draws nothing unless the arm is in STATION_KEEP', () => {
    const arm = weaverArm();
    arm.state = 'TRANSIT';
    const r = reticleWith(arm);
    const ctx = mockCtx();
    r._drawToolSelectionPanel(ctx, 400, 300);
    assert.equal(ctx.texts.length, 0, 'panel is gated on STATION_KEEP');
  });
});
