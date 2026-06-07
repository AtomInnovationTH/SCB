/**
 * test-ToolRecommender.js — per-arm capture-tool recommender (CP-1 / P2).
 *
 * Table-driven coverage of DAUGHTER_MULTITOOL_SPEC §7 priority rules + the
 * graceful-degradation contract (absent ferrous flags → net-first fallback).
 */
import { describe, it, assert } from './TestRunner.js';
import { recommendArmTool } from '../systems/ToolRecommender.js';

describe('ToolRecommender — NET / MAGNET priority (§7)', () => {
  it('pure ferrous hull within net cap → MAGNET is recommended (▶), net demotes', () => {
    const r = recommendArmTool({
      armType: 'weaver', mass: 300, debrisType: 'rocketBody',
      ferromagnetic: true, hasFerrousFasteners: true,
    });
    assert.equal(r.recommended, 'MAGNET', 'steel hull → direct magnetic grip wins');
    assert.equal(r.scores.MAGNET, 3, 'ferrous hull magnet score is ★★★');
    assert.equal(r.scores.NET, 2, 'net is still viable but self-demoted to ★★');
  });

  it('fastener-only (Al rocket body) → NET stays primary, MAGNET visible', () => {
    const r = recommendArmTool({
      armType: 'weaver', mass: 300, debrisType: 'rocketBody',
      ferromagnetic: false, hasFerrousFasteners: true,
    });
    assert.equal(r.recommended, 'NET', 'net remains primary for a non-steel hull');
    assert.equal(r.scores.NET, 3);
    assert.equal(r.scores.MAGNET, 2, 'bolt-latch magnet is offered as ★★ alternative');
  });

  it('non-ferrous fragment → net-only (no magnet offered)', () => {
    const r = recommendArmTool({
      armType: 'spinner', mass: 5, debrisType: 'fragment',
      ferromagnetic: false, hasFerrousFasteners: false,
    });
    assert.equal(r.recommended, 'NET');
    assert.equal(r.scores.MAGNET, 0, 'no ferrous purchase → magnet not recommended');
  });

  it('spinner on a 100 kg ferrous-fastener body → MAGNET (net is class-oversize)', () => {
    const r = recommendArmTool({
      armType: 'spinner', mass: 100, debrisType: 'defunctSat',
      ferromagnetic: false, hasFerrousFasteners: true,
    });
    assert.equal(r.scores.NET, 1, 'SD-NET (50 kg cap) self-demotes — Mother only');
    assert.equal(r.recommended, 'MAGNET', 'magnet wins when the small net is oversize');
  });

  it('too-heavy ferrous body (> 500 kg) → magnet skipped; gripper takes oversize', () => {
    const r = recommendArmTool({
      armType: 'weaver', mass: 1200, debrisType: 'rocketBody',
      ferromagnetic: true, hasFerrousFasteners: true, hasGrappleFixture: true,
    });
    assert.equal(r.scores.MAGNET, 0, 'beyond EPM 500 kg limit → not viable');
    assert.equal(r.scores.NET, 1, 'beyond LD-NET cap → Mother-only');
    assert.equal(r.scores.GRIPPER, 3, 'gripper handles the oversize body (< 2000 kg)');
    assert.equal(r.recommended, 'GRIPPER');
  });

  it('graceful degradation: absent ferrous flags → net-first fallback', () => {
    const r = recommendArmTool({ armType: 'weaver', mass: 200, debrisType: 'rocketBody' });
    assert.equal(r.recommended, 'NET', 'net still wins the tie vs gripper (preference order)');
    assert.equal(r.scores.MAGNET, 0);
  });

  it('empty net magazine forces NET to 0 and promotes the next-best tool', () => {
    const r = recommendArmTool({
      armType: 'weaver', mass: 200, debrisType: 'rocketBody',
      hasFerrousFasteners: true, hasGrappleFixture: true, netDepleted: true,
    });
    assert.equal(r.scores.NET, 0, 'depleted magazine → NET score 0');
    // 200 kg Al rocket body, nets gone: gripper (awkward-shape) outranks the
    // ferrous-fastener magnet (§7 example).
    assert.equal(r.recommended, 'GRIPPER', 'gripper picks up the awkward body when nets are gone');
  });

  it('reports the arm class toolset as the cycle order', () => {
    const w = recommendArmTool({ armType: 'weaver', mass: 10 });
    assert.deepEqual(w.alternatives, ['NET', 'GRIPPER', 'MAGNET']);
    const s = recommendArmTool({ armType: 'spinner', mass: 10 });
    assert.deepEqual(s.alternatives, ['NET', 'PAD', 'MAGNET']);
  });

  it('P3 gripper: a fixtured target that fits the net shows GRIPPER as a visible alternative', () => {
    const r = recommendArmTool({
      armType: 'weaver', mass: 120, debrisType: 'defunctSat', hasGrappleFixture: true,
    });
    assert.equal(r.recommended, 'NET', 'net fits (120 < 500) and stays primary');
    assert.equal(r.scores.GRIPPER, 3, 'fixtured + mass>=50 → gripper is awkward-shape ★★★');
  });

  it('P4 pad: spinner tiny fragment → PAD shown ★★★ (net stays the ▶ as it fits)', () => {
    const r = recommendArmTool({ armType: 'spinner', mass: 4, debrisType: 'fragment' });
    assert.equal(r.scores.PAD, 3, 'pad is offered ★★★ for a tiny fragment');
    assert.equal(r.recommended, 'NET', 'SD-NET fits a 4 kg fragment, so it stays primary');
  });
});
