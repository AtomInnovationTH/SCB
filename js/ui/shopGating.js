/**
 * shopGating.js — E5: pure shop-purchase gating predicate.
 *
 * The upgrade prerequisite invariant (extra_battery → solid_state_battery →
 * graphene_supercap; efficient_panels → multi_junction_solar → RTG /
 * power_beaming; the MPD chain) used to live ONLY in the render disabled-state
 * (_renderUpgradeCard). `_purchaseUpgrade` checked cost + maxLevel but NOT the
 * prerequisites, so a scripted / mis-ordered purchase could buy a locked
 * upgrade out of order and spend the credits anyway (E5).
 *
 * This pure predicate is the single source of truth shared by the render layer
 * AND the purchase guard, and is unit-testable without the DOM-bound ShopScreen.
 *
 * @module ui/shopGating
 */

import { gasPriceCr, engineTankFreeKg } from '../systems/ResourceSystem.js';

/**
 * Whether an upgrade's prerequisites are satisfied.
 * Supports a single `requires` (id string), `requiresAll` (array of ids), and
 * `requiresFeature` (a FEATURE_FLAGS gate), and `supersededBy` (g1-gas-upgrades D3: a row is
 * closed for good once the row that replaces it is owned — krypton after xenon).
 * @param {object} upgrade - catalog row ({ requires?, requiresAll?, requiresFeature? })
 * @param {{ has: (id: string) => boolean }} owned - purchasedUpgrades Map (or a Set)
 * @param {(flag: string) => boolean} [isFeatureEnabled] - FEATURE_FLAGS predicate
 * @returns {boolean}
 */
export function upgradePrereqsMet(upgrade, owned, isFeatureEnabled) {
  if (!upgrade) return false;
  if (upgrade.requiresFeature
      && typeof isFeatureEnabled === 'function'
      && !isFeatureEnabled(upgrade.requiresFeature)) {
    return false;
  }
  if (upgrade.supersededBy && owned && typeof owned.has === 'function' && owned.has(upgrade.supersededBy)) {
    return false;
  }
  if (!owned || typeof owned.has !== 'function') {
    // No ownership record → only prereq-free upgrades are purchasable.
    return !upgrade.requires && !(Array.isArray(upgrade.requiresAll) && upgrade.requiresAll.length);
  }
  if (upgrade.requires && !owned.has(upgrade.requires)) return false;
  if (Array.isArray(upgrade.requiresAll) && !upgrade.requiresAll.every((id) => owned.has(id))) {
    return false;
  }
  return true;
}

/**
 * g1-gas-upgrades D4: the credits an upgrade costs RIGHT NOW — the ONE price accessor for every place a
 * price is shown, compared or charged. Static `cost` for every row, except the engine-gas resupply, which
 * costs what the kilos it would load cost at the tank gas's price. With no resources (a bare test, the
 * catalogue tables) it is the static `cost`.
 * @param {object} upgrade - catalog row
 * @param {{xenon?: number, xenonMax?: number, tankGasId?: string}|null} [res] - ResourceSystem or player.resources
 * @returns {number} credits
 */
export function upgradeCostNow(upgrade, res) {
  if (!upgrade) return 0;
  if (upgrade.effect === 'engineGasResupply' && res) {
    const free = engineTankFreeKg(res);
    const kg = free < 0.1 ? upgrade.value : Math.min(upgrade.value, free);
    return gasPriceCr(res.tankGasId, kg);
  }
  return upgrade.cost;
}

/**
 * g1-gas-upgrades D4: true when the engine-gas resupply has no room to load (tank full: free < 0.1 kg).
 * @param {{xenon?: number, xenonMax?: number, tankGasId?: string}|null} res
 * @returns {boolean}
 */
export function engineTankFull(res) {
  return !!res && engineTankFreeKg(res) < 0.1;
}
