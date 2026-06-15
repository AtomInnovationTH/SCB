/**
 * test-DockingReticle-ToolPanel.js — Capture Odds Strip
 * (capture-feedback overhaul Phase 1b; replaced the vertical ★-score panel).
 *
 * Renders the four-state widget against a mock 2D context and asserts:
 *   AIM       — odds %s per column, ▶ label, NET·n count, blocker words,
 *               '--' for an empty magazine, advisory + ⚠FRAG chip.
 *   IN FLIGHT — dim labels + 'NET AWAY — Nm'.
 *   REELING   — TENSION bar (SNAP on the tether axis) + thin NET STRAIN bar
 *               (RIP on the strain axis) + payload kg.
 *   gating    — nothing drawn in unrelated states.
 */
import { describe, it, assert } from './TestRunner.js';
import { DockingReticle } from '../ui/DockingReticle.js';

function mockCtx() {
  const texts = [];
  return {
    texts,
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    globalAlpha: 1,
    fillRect() {}, strokeRect() {}, beginPath() {}, arc() {}, fill() {},
    moveTo() {}, lineTo() {}, stroke() {},
    fillText(t) { texts.push(String(t)); },
  };
}

function reticleWith(arm) {
  const r = Object.create(DockingReticle.prototype);
  r._arm = arm;
  r._time = 0;
  r._lastDt = 0.016;
  return r;
}

function weaverArm() {
  return {
    state: 'STATION_KEEP', type: 'weaver',
    toolset: ['NET', 'GRIPPER', 'MAGNET'], selectedTool: 'MAGNET',
    _toolOdds: {
      NET: { p: 0.68, blocker: 'TUMBLE', hint: 'tumbling 18°/s — de-spin [L]' },
      GRIPPER: { p: 0.10, blocker: 'NO-FIX', hint: 'no fixture to grab — net it' },
      MAGNET: { p: 0.95, blocker: null, hint: 'ferrous hull — direct grip' },
    },
    _toolOddsFragRisk: 0,
    getNetInventory: () => 2,
  };
}

describe('DockingReticle — capture odds strip (AIM)', () => {
  it('renders a % column per verb with the NET·n magazine count', () => {
    const r = reticleWith(weaverArm());
    const ctx = mockCtx();
    r._drawToolSelectionPanel(ctx, 400, 300);
    const blob = ctx.texts.join(' | ');
    assert.ok(blob.includes('68%'), `NET column shows its odds: ${blob}`);
    assert.ok(blob.includes('95%'), 'MAGNET column shows its odds');
    assert.ok(blob.includes('NET\u00B72'), 'NET label carries the magazine count');
    assert.ok(blob.includes('GRAB'), 'GRIPPER label shortened to GRAB');
    assert.ok(blob.includes('MAG'), 'MAGNET label shortened to MAG');
    assert.ok(blob.includes('WEAVER'), 'header names the arm class');
    assert.ok(ctx.texts.some(t => t.startsWith('\u25B6')), '▶ marks the selected column');
  });

  it('display caps at 99% — never a lying 100%', () => {
    const arm = weaverArm();
    arm._toolOdds.MAGNET.p = 1.0;
    const r = reticleWith(arm);
    const ctx = mockCtx();
    r._drawToolSelectionPanel(ctx, 400, 300);
    const blob = ctx.texts.join(' | ');
    assert.ok(blob.includes('99%'), 'sure-shot shows 99%');
    assert.ok(!blob.includes('100%'), 'never 100%');
  });

  it('0% column shows the red blocker word; empty magazine shows -- with EMPTY', () => {
    const arm = weaverArm();
    arm._toolOdds = {
      NET: { p: null, blocker: 'EMPTY', hint: 'magazine empty — restock' },
      GRIPPER: { p: 0, blocker: 'HEAVY', hint: 'beyond jaw mass limit' },
      MAGNET: { p: 0.4, blocker: null, hint: 'bolt-latch' },
    };
    const r = reticleWith(arm);
    const ctx = mockCtx();
    r._drawToolSelectionPanel(ctx, 400, 300);
    const blob = ctx.texts.join(' | ');
    assert.ok(ctx.texts.includes('--'), 'empty magazine renders -- not 0%');
    assert.ok(blob.includes('EMPTY'), 'EMPTY blocker word under the -- column');
    assert.ok(blob.includes('HEAVY'), 'HEAVY blocker word under the 0% column');
  });

  it('⚠FRAG chip renders only at/above the risk threshold', () => {
    const arm = weaverArm();
    arm._toolOddsFragRisk = 0.22;
    const r = reticleWith(arm);
    const ctx = mockCtx();
    r._drawToolSelectionPanel(ctx, 400, 300);
    assert.ok(ctx.texts.join(' ').includes('FRAG 22%'), 'chip shows the frag %');

    const arm2 = weaverArm();
    arm2._toolOddsFragRisk = 0.05;
    const ctx2 = mockCtx();
    reticleWith(arm2)._drawToolSelectionPanel(ctx2, 400, 300);
    assert.ok(!ctx2.texts.join(' ').includes('FRAG'), 'below threshold → no chip');
  });

  it('advisory offers a switch when another tool beats the selected by >20 pts', () => {
    const arm = weaverArm();
    arm.selectedTool = 'NET';
    arm._toolOdds.NET = { p: 0, blocker: 'WIDE', hint: 'too wide for the net mouth' };
    arm._stationKeepTarget = { sizeMeter: 6, mass: 200 };
    const r = reticleWith(arm);
    const ctx = mockCtx();
    r._drawToolSelectionPanel(ctx, 400, 300);
    const blob = ctx.texts.join(' | ');
    assert.ok(blob.includes('switch [`]'), `advisory offers the better tool: ${blob}`);
  });

  it('displayed odds ease toward the truth (count-up motion)', () => {
    const arm = weaverArm();
    const r = reticleWith(arm);
    const ctx = mockCtx();
    r._drawToolSelectionPanel(ctx, 400, 300);   // seeds easing at 0.68
    arm._toolOdds.NET.p = 0.95;                  // de-spin finished: truth jumps
    r._lastDt = 0.05;
    const ctx2 = mockCtx();
    r._drawToolSelectionPanel(ctx2, 400, 300);
    const shown = r._oddsEase.NET.shown;
    assert.ok(shown > 0.68 && shown < 0.95,
      `display eases between old and new truth (got ${shown})`);
  });
});

describe('DockingReticle — odds widget context states', () => {
  it('IN FLIGHT: dims to labels and shows NET AWAY with live distance', () => {
    const arm = weaverArm();
    arm.state = 'NETTING';
    arm._firedNet = { distanceTraveled: 34.4 };
    const r = reticleWith(arm);
    const ctx = mockCtx();
    r._drawToolSelectionPanel(ctx, 400, 300);
    const blob = ctx.texts.join(' | ');
    assert.ok(blob.includes('NET AWAY'), 'flight line present');
    assert.ok(blob.includes('34m'), 'live net distance shown');
    assert.ok(!blob.includes('%'), 'no stale odds during flight');
  });

  it('REELING: tension bar with SNAP mark, strain-axis RIP mark, payload kg', () => {
    const arm = weaverArm();
    arm.state = 'REELING';
    arm.capturedDebris = { mass: 320 };
    arm.tetherTension = 60;
    arm.tetherBreakStrength = 100;
    arm._netRatedMass = 400;            // strain 0.8 — RIP tick on its own axis
    const r = reticleWith(arm);
    const ctx = mockCtx();
    r._drawToolSelectionPanel(ctx, 400, 300);
    const blob = ctx.texts.join(' | ');
    assert.ok(blob.includes('TENSION'), 'tension header');
    assert.ok(blob.includes('320 kg'), 'payload mass shown');
    assert.ok(blob.includes('RIP'), 'RIP tick labelled (strain axis)');
    assert.ok(blob.includes('SNAP'), 'SNAP tick labelled (tether axis)');
  });

  it('REELING: RIP rides the net-strain axis — absent for a non-net catch', () => {
    const arm = weaverArm();
    arm.state = 'REELING';
    arm.capturedDebris = { mass: 320 };
    arm.tetherTension = 60;
    arm.tetherBreakStrength = 100;
    arm._captureToolKind = 'GRIPPER';   // no net to rip
    arm._netRatedMass = 400;
    const ctx = mockCtx();
    reticleWith(arm)._drawToolSelectionPanel(ctx, 400, 300);
    const blob = ctx.texts.join(' | ');
    assert.ok(blob.includes('SNAP'), 'tether SNAP still marked');
    assert.ok(!blob.includes('RIP'), 'no RIP mark when nothing can rip');
  });

  it('draws nothing in unrelated states (RESULT flashes own the screen)', () => {
    const arm = weaverArm();
    arm.state = 'TRANSIT';
    const r = reticleWith(arm);
    const ctx = mockCtx();
    r._drawToolSelectionPanel(ctx, 400, 300);
    assert.equal(ctx.texts.length, 0, 'widget gated off outside its states');
  });

  it('GRAPPLED without a payload draws nothing (no tension to show)', () => {
    const arm = weaverArm();
    arm.state = 'GRAPPLED';
    arm.capturedDebris = null;
    const ctx = mockCtx();
    reticleWith(arm)._drawToolSelectionPanel(ctx, 400, 300);
    assert.equal(ctx.texts.length, 0);
  });
});
