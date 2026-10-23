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

import { Constants } from '../core/Constants.js';
import { gasPriceCr, engineTankFreeKg, coldGasPriceCr, coldGasFreeKg, indiumCartridgePriceCr } from '../systems/ResourceSystem.js';

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
  // lane 3f: the nitrogen buy is priced the same way - by the kilos it would load (the room in her cold-gas tank), at the
  // nitrogen commodity price on top of the launch mass.
  if (upgrade.effect === 'coldGasResupply' && res) {
    const free = coldGasFreeKg(res);
    const kg = free < 0.1 ? upgrade.value : Math.min(upgrade.value, free);
    return coldGasPriceCr(kg);
  }
  // lane 3f: a cartridge is one fixed load (a whole cartridge or none), priced by its indium on top of the launch mass
  if (upgrade.effect === 'indiumCartridge') return indiumCartridgePriceCr(upgrade.value);
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

/**
 * Nets step 3 lane 3f: true when the nitrogen buy has no room to load (cold-gas tank full: free < 0.1 kg).
 * @param {{coldGas?: number, coldGasMax?: number}|null} res - ResourceSystem or player.resources
 * @returns {boolean}
 */
export function coldGasTankFull(res) {
  return !!res && coldGasFreeKg(res) < 0.1;
}

/**
 * Nets step 3 lane 3f: true when the store has no room for one WHOLE ion-fuel cartridge (a cartridge is not poured, so a store with a
 * little room refuses it). Works on a ResourceSystem or on player.resources (`indiumStoreKg` is mirrored there).
 * @param {{indiumStoreKg?: number}|null} res
 * @param {number} [cartridgeKg] default: the cartridge size
 * @returns {boolean}
 */
export function indiumStoreFull(res, cartridgeKg = Constants.DAUGHTER_SUPPLY.INDIUM_CARTRIDGE_KG) {
  if (!res) return false;
  const have = Number.isFinite(res.indiumStoreKg) ? res.indiumStoreKg : 0;
  return Constants.DAUGHTER_SUPPLY.INDIUM_STORE_MAX_KG - have < cartridgeKg - 1e-9;
}

/**
 * Nets step 3 lane 3f: the one answer to "this consumable has nowhere to go": the engine tank is full (the gas resupply), the cold-gas
 * tank is full (the nitrogen buy), or the indium store cannot take a cartridge. False for every other row.
 * @param {object} upgrade - catalog row
 * @param {object|null} res - ResourceSystem or player.resources
 * @returns {boolean}
 */
export function consumableFull(upgrade, res) {
  switch (upgrade && upgrade.effect) {
    case 'engineGasResupply': return engineTankFull(res);
    case 'coldGasResupply': return coldGasTankFull(res);
    case 'indiumCartridge': return indiumStoreFull(res, upgrade.value);
    default: return false;
  }
}
