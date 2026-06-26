/**
 * test-ArmManager-Salvage.js — Shift+A field-center salvage + reel-in fix.
 *
 * Covers the ArmManager methods added in the 2026-06-14 high-risk-salvage
 * rework + reel-in fix:
 *   • deployAllToDistinctTargets(targets, fallback) — fan every docked daughter
 *     out to a DISTINCT debris (surplus daughters reuse the fallback target).
 *   • recallAllDeployed() — Shift+R recall-all that returns an honest count and
 *     only reels genuinely deployed daughters.
 */
import { describe, it, assert } from './TestRunner.js';
import * as THREE from 'three';
import { eventBus } from '../core/EventBus.js';
import { ArmManager } from '../entities/ArmManager.js';

const S = {
  DOCKED: 'DOCKED', EXPENDED: 'EXPENDED', STATION_KEEP: 'STATION_KEEP',
  TRANSIT: 'TRANSIT', RETURNING: 'RETURNING', DOCKING: 'DOCKING',
};

function makeMgr() {
  const scene = { add() {}, remove() {} };
  const player = {
    safeMode: false,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    resources: {},
  };
  const mgr = new ArmManager(scene, player);
  eventBus.clear();
  return mgr;
}

/** Fake docked arm that records what it was deployed against. */
function fakeArm(state) {
  return {
    state, springCharged: true,
    deployedTo: undefined, freeflyCount: 0, recallCount: 0, recallOpts: null,
    deploy(target) { this.deployedTo = target; return true; },
    deployFreefly() { this.freeflyCount++; return true; },
    recall(opts) { this.recallCount++; this.recallOpts = opts; },
  };
}

describe('ArmManager.deployAllToDistinctTargets — fan-out (2026-06-14)', () => {
  it('assigns each docked daughter a DISTINCT target', () => {
    const mgr = makeMgr();
    const a = fakeArm(S.DOCKED), b = fakeArm(S.DOCKED), c = fakeArm(S.DOCKED);
    mgr.arms = [a, b, c];
    const t1 = { id: 1 }, t2 = { id: 2 }, t3 = { id: 3 };
    const n = mgr.deployAllToDistinctTargets([t1, t2, t3]);
    assert.equal(n, 3, 'all three docked daughters deploy');
    assert.equal(a.deployedTo, t1, 'arm 0 → target 1');
    assert.equal(b.deployedTo, t2, 'arm 1 → target 2');
    assert.equal(c.deployedTo, t3, 'arm 2 → target 3');
  });

  it('surplus daughters fall back to the fallback target', () => {
    const mgr = makeMgr();
    const a = fakeArm(S.DOCKED), b = fakeArm(S.DOCKED), c = fakeArm(S.DOCKED);
    mgr.arms = [a, b, c];
    const t1 = { id: 1 }, t2 = { id: 2 };
    const fb = { id: 99 };
    const n = mgr.deployAllToDistinctTargets([t1, t2], fb);
    assert.equal(n, 3, 'all deploy');
    assert.equal(a.deployedTo, t1);
    assert.equal(b.deployedTo, t2);
    assert.equal(c.deployedTo, fb, 'surplus daughter reuses the fallback target');
  });

  it('surplus daughters free-fly when no fallback target is given', () => {
    const mgr = makeMgr();
    const a = fakeArm(S.DOCKED), b = fakeArm(S.DOCKED);
    mgr.arms = [a, b];
    const n = mgr.deployAllToDistinctTargets([{ id: 1 }], null);
    assert.equal(n, 2, 'both deploy');
    assert.equal(b.freeflyCount, 1, 'surplus daughter free-flies when no fallback');
  });

  it('skips non-docked / uncharged daughters', () => {
    const mgr = makeMgr();
    const docked = fakeArm(S.DOCKED);
    const flying = fakeArm(S.STATION_KEEP);
    const uncharged = fakeArm(S.DOCKED); uncharged.springCharged = false;
    mgr.arms = [flying, uncharged, docked];
    const t1 = { id: 1 }, t2 = { id: 2 };
    const n = mgr.deployAllToDistinctTargets([t1, t2]);
    assert.equal(n, 1, 'only the charged docked daughter deploys');
    assert.equal(docked.deployedTo, t1, 'docked daughter gets the first distinct target');
    assert.equal(flying.deployedTo, undefined, 'already-flying daughter is untouched');
  });
});

describe('ArmManager.recallAllDeployed — honest count (2026-06-14 reel fix)', () => {
  it('reels only genuinely deployed daughters and returns the count', () => {
    const mgr = makeMgr();
    const docked = fakeArm(S.DOCKED);
    const sk = fakeArm(S.STATION_KEEP);
    const transit = fakeArm(S.TRANSIT);
    const returning = fakeArm(S.RETURNING);
    const expended = fakeArm(S.EXPENDED);
    mgr.arms = [docked, sk, transit, returning, expended];
    const n = mgr.recallAllDeployed();
    assert.equal(n, 2, 'only STATION_KEEP + TRANSIT count as deployed');
    assert.equal(sk.recallCount, 1, 'SK daughter reeled');
    assert.equal(transit.recallCount, 1, 'TRANSIT daughter reeled');
    assert.equal(docked.recallCount, 0, 'docked daughter not reeled');
    assert.equal(returning.recallCount, 0, 'already-returning daughter not re-reeled');
    assert.equal(expended.recallCount, 0, 'expended daughter not reeled');
  });

  it('reels stuck daughters home on the zero-fuel tether (unconditional reel)', () => {
    const mgr = makeMgr();
    const sk = fakeArm(S.STATION_KEEP);
    mgr.arms = [sk];
    mgr.recallAllDeployed();
    // recall() now always reels a tethered daughter home on the mothership's
    // zero-fuel winch — no motherInitiated option is needed or passed.
    assert.equal(sk.recallCount, 1, 'reel-all calls recall() on the stuck daughter');
    assert.equal(sk.recallOpts, undefined, 'no obsolete options passed to recall()');
  });

  it('returns 0 when nothing is deployed', () => {
    const mgr = makeMgr();
    mgr.arms = [fakeArm(S.DOCKED), fakeArm(S.EXPENDED)];
    assert.equal(mgr.recallAllDeployed(), 0, 'no deployed daughters → 0');
  });
});
