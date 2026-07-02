/**
 * test-ShopRecommendation.js — early-shop tension (first-credit legibility plan).
 *
 * Coverage:
 *   - recommendedStarter(): first un-owned + affordable preference is chosen;
 *     ⭐ hidden once any starter is owned or none is affordable.
 *   - First-depot affordability floor math: tops UP TO FIRST_DEPOT_FLOOR when
 *     below, no-op when already at/above (one-time semantics live in
 *     GameFlowManager via the FIRST_DEPOT_VISITED ceremony flag).
 */
import { describe, it, assert } from './TestRunner.js';
import { Constants } from '../core/Constants.js';
import { UPGRADES, STARTER_PREFERENCE, recommendedStarter } from '../ui/ShopScreen.js';

describe('ShopScreen — recommended-starter highlight', () => {
  it('preference list matches Constants.SHOP.RECOMMENDED_STARTERS', () => {
    assert.deepEqual(STARTER_PREFERENCE, Constants.SHOP.RECOMMENDED_STARTERS);
    assert.deepEqual(STARTER_PREFERENCE,
      ['capture_net', 'fast_reel', 'enhanced_eo', 'efficient_ion']);
  });

  it('every preference id exists in the upgrade catalog', () => {
    const ids = new Set(UPGRADES.map(u => u.id));
    for (const id of STARTER_PREFERENCE) {
      assert.ok(ids.has(id), `${id} present in UPGRADES`);
    }
  });

  it('recommends the first affordable un-owned preference', () => {
    const owned = new Map();
    // 600 cr (floor): cannot afford capture_net (800) → next is fast_reel (500).
    assert.equal(recommendedStarter(UPGRADES, owned, 600), 'fast_reel');
    // 800 cr: capture_net (800) is now affordable and first in the list.
    assert.equal(recommendedStarter(UPGRADES, owned, 800), 'capture_net');
  });

  it('skips owned preferences when choosing — until any starter owned hides ⭐', () => {
    // Owning a NON-preference upgrade does not hide the badge.
    const ownsOther = new Map([['whipple_shield', 1]]);
    assert.equal(recommendedStarter(UPGRADES, ownsOther, 600), 'fast_reel');
    // Owning ANY starter hides the badge entirely (returns null).
    const ownsStarter = new Map([['fast_reel', 1]]);
    assert.equal(recommendedStarter(UPGRADES, ownsStarter, 5000), null);
  });

  it('returns null when nothing in the list is affordable', () => {
    const owned = new Map();
    assert.equal(recommendedStarter(UPGRADES, owned, 100), null);
  });

  it('accepts a Set of owned ids too', () => {
    const owned = new Set();
    assert.equal(recommendedStarter(UPGRADES, owned, 500), 'fast_reel');
  });
});

describe('ShopScreen — first-depot affordability floor (math)', () => {
  const FLOOR = Constants.SHOP.FIRST_DEPOT_FLOOR;
  const topUp = (credits) => Math.max(0, FLOOR - credits);

  it('FIRST_DEPOT_FLOOR covers one 500 starter, not the 800 net or two starters', () => {
    assert.equal(FLOOR, 600);
    const fastReel = UPGRADES.find(u => u.id === 'fast_reel').cost;
    const captureNet = UPGRADES.find(u => u.id === 'capture_net').cost;
    assert.ok(FLOOR >= fastReel, 'floor affords one 500 starter');
    assert.ok(FLOOR < captureNet, 'floor does NOT afford the 800 net');
    assert.ok(FLOOR < fastReel * 2, 'floor does NOT afford two starters');
  });

  it('tops up to the floor when below it', () => {
    assert.equal(topUp(0), 600);
    assert.equal(topUp(250), 350);
    assert.equal(topUp(599), 1);
  });

  it('is a no-op at or above the floor', () => {
    assert.equal(topUp(600), 0);
    assert.equal(topUp(1200), 0);
  });
});
