/**
 * test-ScanFieldRewards.js — 2026-06-04
 *
 * Validates the field-based scan reward economy (one payout per distinct debris
 * field; re-scanning the same field yields nothing; empty space yields nothing;
 * mild diminishing across distinct fields). Mirrors the decision logic in
 * SensorSystem._completeScan (which imports browser/audio deps and can't run in
 * Node), exactly as test-CommsPanel mirrors getPriorityColor.
 *
 * @module test/test-ScanFieldRewards
 */

import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';

// ── Mirror of SensorSystem field-reward decision (keep in sync) ─────────────
function makeScanner() {
  return {
    rewardedFields: new Set(),
    scanCreditsTotal: 0,
    sessionCap: Constants.SCAN.SESSION_SCAN_CAP || 5000,
  };
}

/**
 * Compute the reward for a scan of `fieldId` (null = empty space).
 * @returns {{ reward:number, kind:string }}
 */
function scanReward(state, baseReward, fieldId) {
  if (!fieldId) return { reward: 0, kind: 'empty' };
  if (state.rewardedFields.has(fieldId)) return { reward: 0, kind: 'stale' };

  const fieldsPaid = state.rewardedFields.size;
  const diminish = Math.max(0.5, 1 - fieldsPaid * 0.05);
  let reward = Math.round(baseReward * diminish);
  let kind = 'fresh';

  if (state.scanCreditsTotal >= state.sessionCap) {
    return { reward: 0, kind: 'capped' };
  } else if (state.scanCreditsTotal + reward > state.sessionCap) {
    reward = state.sessionCap - state.scanCreditsTotal;
  }
  if (reward > 0) {
    state.rewardedFields.add(fieldId);
    state.scanCreditsTotal += reward;
  }
  return { reward, kind };
}

const QUICK = Constants.SCAN.QUICK.REWARD; // 50

describe('Scan field rewards — one payout per distinct field', () => {
  it('first scan of a fresh field pays the base reward', () => {
    const s = makeScanner();
    const r = scanReward(s, QUICK, 'iss-400');
    assert.equal(r.kind, 'fresh');
    assert.equal(r.reward, QUICK);
  });

  it('re-scanning the SAME field pays nothing (data already current)', () => {
    const s = makeScanner();
    scanReward(s, QUICK, 'iss-400');
    const again = scanReward(s, QUICK, 'iss-400');
    assert.equal(again.kind, 'stale');
    assert.equal(again.reward, 0);
    // ...and farming it repeatedly never pays.
    for (let i = 0; i < 20; i++) {
      assert.equal(scanReward(s, QUICK, 'iss-400').reward, 0);
    }
  });

  it('scanning a DIFFERENT field pays again (mission with multiple fields)', () => {
    const s = makeScanner();
    const a = scanReward(s, QUICK, 'iss-400');
    const b = scanReward(s, QUICK, 'sso-700');
    assert.equal(a.kind, 'fresh');
    assert.equal(b.kind, 'fresh');
    assert.ok(b.reward > 0, 'second distinct field still pays');
    // Mild diminishing across distinct fields: -5% per prior field.
    assert.equal(b.reward, Math.round(QUICK * 0.95));
  });

  it('empty space (no field in range) pays nothing', () => {
    const s = makeScanner();
    const r = scanReward(s, QUICK, null);
    assert.equal(r.kind, 'empty');
    assert.equal(r.reward, 0);
    assert.equal(s.rewardedFields.size, 0, 'empty scan does not consume a field slot');
  });

  it('diminishing has a 50% floor across many distinct fields', () => {
    const s = makeScanner();
    let last = Infinity;
    for (let i = 0; i < 30; i++) {
      const r = scanReward(s, QUICK, `field-${i}`);
      if (r.reward > 0) {
        assert.ok(r.reward >= Math.round(QUICK * 0.5), `floor honoured at field ${i}`);
        last = r.reward;
      }
    }
    assert.ok(last <= QUICK);
  });

  it('session cap clamps the final payout and then pays zero', () => {
    const s = makeScanner();
    s.scanCreditsTotal = s.sessionCap - 10; // almost capped
    const clamp = scanReward(s, QUICK, 'iss-400');
    assert.equal(clamp.reward, 10, 'clamped to remaining budget');
    const capped = scanReward(s, QUICK, 'sso-700');
    assert.equal(capped.kind, 'capped');
    assert.equal(capped.reward, 0);
  });
});

describe('Scan field rewards — constants sanity', () => {
  it('SCAN rewards exist and quick < wide', () => {
    assert.ok(Constants.SCAN.QUICK.REWARD > 0);
    assert.ok(Constants.SCAN.WIDE.REWARD > Constants.SCAN.QUICK.REWARD);
  });
});
