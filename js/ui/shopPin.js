/**
 * shopPin.js — S1 retention: pure helpers for the pinned "next upgrade" chase
 * target (2026-07-23).
 *
 * Extracted from ShopScreen so the DOM-bound HUD can import the progress math
 * without pulling the whole shop module graph, and so both the shop and the HUD
 * share one source of truth. Pure — no DOM, no singletons, unit-tested directly.
 *
 * @module ui/shopPin
 */
import { upgradePrereqsMet } from './shopGating.js';

/**
 * Live progress toward a pinned shop upgrade, for the "visible next goal" HUD
 * widget.
 * @param {number} credits - current spendable credits
 * @param {{cost:number}|null|undefined} upgrade - the pinned upgrade catalog row
 * @returns {{pct:number, remaining:number, affordable:boolean}}
 */
export function pinProgress(credits, upgrade) {
  if (!upgrade || !(upgrade.cost > 0)) {
    return { pct: 0, remaining: 0, affordable: false };
  }
  const c = Math.max(0, credits || 0);
  const pct = Math.max(0, Math.min(1, c / upgrade.cost));
  const remaining = Math.max(0, upgrade.cost - c);
  return { pct, remaining, affordable: c >= upgrade.cost };
}

/**
 * Pick the auto-pin chase target — the cheapest gated-open, un-owned,
 * non-consumable upgrade the player cannot yet afford. Falls back to the
 * cheapest gated-open un-owned upgrade if everything gated-open is already
 * affordable (so the chase target is never empty while items remain).
 * @param {Array} upgrades - upgrade catalog (UPGRADES)
 * @param {{has:(id:string)=>boolean}} owned - purchasedUpgrades Map/Set
 * @param {number} credits - current spendable credits
 * @param {(flag:string)=>boolean} [isFeatureEnabled]
 * @returns {string|null} upgrade id, or null when nothing remains
 */
export function cheapestChaseTarget(upgrades, owned, credits, isFeatureEnabled) {
  const has = (id) => (owned && typeof owned.has === 'function' ? owned.has(id) : false);
  const level = (id) => (owned && typeof owned.get === 'function' ? (owned.get(id) || 0) : (has(id) ? 1 : 0));
  let cheapestUnaffordable = null;
  let cheapestAny = null;
  for (const u of upgrades || []) {
    if (u.consumable || u.maxLevel === Infinity) continue;
    if (level(u.id) >= (u.maxLevel || 1)) continue; // maxed / owned
    if (!upgradePrereqsMet(u, owned, isFeatureEnabled)) continue;
    if (cheapestAny === null || u.cost < cheapestAny.cost) cheapestAny = u;
    if ((credits || 0) < u.cost && (cheapestUnaffordable === null || u.cost < cheapestUnaffordable.cost)) {
      cheapestUnaffordable = u;
    }
  }
  const pick = cheapestUnaffordable || cheapestAny;
  return pick ? pick.id : null;
}
