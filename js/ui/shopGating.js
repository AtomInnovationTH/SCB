/**
 * shopGating.js — pure shop-purchase gating predicate, shared by the render layer (_renderUpgradeCard) and the
 * purchase guard (_purchaseUpgrade): a scripted / mis-ordered purchase must not skip prerequisites and still spend credits.
 * @module ui/shopGating
 */

import { Constants } from '../core/Constants.js';
import { gasPriceCr, engineTankFreeKg, coldGasPriceCr, coldGasFreeKg, indiumCartridgePriceCr } from '../systems/ResourceSystem.js';

/**
 * Whether an upgrade's prerequisites are satisfied: `requires` (id), `requiresAll` (ids), `requiresFeature`
 * (FEATURE_FLAGS gate), `supersededBy` (row closed for good once its replacement is owned — krypton after xenon).
 * @param {{ has: (id: string) => boolean }} owned - purchasedUpgrades Map (or a Set)
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
 * Credits an upgrade costs RIGHT NOW: the one price accessor for every place a price is shown, compared or charged.
 * Static `cost`, except the engine-gas resupply (priced by the kilos it would load at the tank gas's price).
 * With no resources (a bare test, the catalogue tables) it is the static `cost`.
 * @param {{xenon?: number, xenonMax?: number, tankGasId?: string}|null} [res] - ResourceSystem or player.resources
 */
export function upgradeCostNow(upgrade, res) {
  if (!upgrade) return 0;
  if (upgrade.effect === 'engineGasResupply' && res) {
    const free = engineTankFreeKg(res);
    const kg = free < 0.1 ? upgrade.value : Math.min(upgrade.value, free);
    return gasPriceCr(res.tankGasId, kg);
  }
  // Nitrogen buy: priced by the kilos it would load (room in the cold-gas tank) at the nitrogen price on top of launch mass.
  if (upgrade.effect === 'coldGasResupply' && res) {
    const free = coldGasFreeKg(res);
    const kg = free < 0.1 ? upgrade.value : Math.min(upgrade.value, free);
    return coldGasPriceCr(kg);
  }
  // A cartridge is one fixed load (whole or none), priced by its indium on top of the launch mass.
  if (upgrade.effect === 'indiumCartridge') return indiumCartridgePriceCr(upgrade.value);
  return upgrade.cost;
}

/** True when the engine-gas resupply has no room to load (free < 0.1 kg). */
export function engineTankFull(res) {
  return !!res && engineTankFreeKg(res) < 0.1;
}

/** True when the nitrogen buy has no room to load (cold-gas tank free < 0.1 kg). */
export function coldGasTankFull(res) {
  return !!res && coldGasFreeKg(res) < 0.1;
}

/**
 * True when the store has no room for one WHOLE ion-fuel cartridge (not poured, so a little room still refuses it).
 * Works on a ResourceSystem or player.resources (`indiumStoreKg` is mirrored there).
 * @param {number} [cartridgeKg] default: the cartridge size
 */
export function indiumStoreFull(res, cartridgeKg = Constants.DAUGHTER_SUPPLY.INDIUM_CARTRIDGE_KG) {
  if (!res) return false;
  const have = Number.isFinite(res.indiumStoreKg) ? res.indiumStoreKg : 0;
  return Constants.DAUGHTER_SUPPLY.INDIUM_STORE_MAX_KG - have < cartridgeKg - 1e-9;
}

/**
 * "This consumable has nowhere to go": engine tank full (gas resupply), cold-gas tank full (nitrogen buy), or the
 * indium store cannot take a cartridge. False for every other row.
 */
export function consumableFull(upgrade, res) {
  switch (upgrade && upgrade.effect) {
    case 'engineGasResupply': return engineTankFull(res);
    case 'coldGasResupply': return coldGasTankFull(res);
    case 'indiumCartridge': return indiumStoreFull(res, upgrade.value);
    default: return false;
  }
}
