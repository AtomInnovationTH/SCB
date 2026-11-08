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

/** True when the capsule stock is at `PART_CAPSULE.MAX_ABOARD` (the shop sells no more). Works on a ResourceSystem or player.resources. */
export function capsuleBayFull(res) {
  return !!res && Number.isFinite(res.capsules) && res.capsules >= Constants.PART_CAPSULE.MAX_ABOARD;
}

/**
 * "This consumable has nowhere to go": engine tank full (gas resupply), cold-gas tank full (nitrogen buy), the indium store
 * cannot take a cartridge, or a new part with nothing to replace (under 1 % of its life used: ShipWear, via
 * `res.getWear()`; a `res` without it, like a bare test stub, counts as "as new"). False for every other row.
 */
export function consumableFull(upgrade, res) {
  switch (upgrade && upgrade.effect) {
    case 'engineGasResupply': return engineTankFull(res);
    case 'coldGasResupply': return coldGasTankFull(res);
    case 'indiumCartridge': return indiumStoreFull(res, upgrade.value);
    case 'reentryCapsule': return capsuleBayFull(res);
    case 'replaceEngine': return partAsNew(res, 'engine');
    case 'replaceBattery': return partAsNew(res, 'battery');
    case 'replaceWings': return partAsNew(res, 'wings');
    default: return false;
  }
}

/** True when a part has used under 1 % of its life (a new one would replace nothing); with no wear to read (no ResourceSystem) it is "as new". */
function partAsNew(res, part) {
  const w = res && typeof res.getWear === 'function' ? res.getWear() : null;
  return !w || w[part] < 0.01;
}

/**
 * Is this catalog row sold at all? Pure; shared by the shop list, the refit card's ranking and both purchase guards, so a hidden
 * row cannot be bought by another route. A row is not offered when its feature flag is off, or when the hardware is already aboard
 * from boot: owner 2026-08-27, while FLOWER_PREINSTALLED is ON the two radiator rows are hidden so nobody pays for installed hardware;
 * owner 2026-10-29 / DECISIONS §57 row 4 (built 2026-11-04), while `Constants.WHEELS.STANDARD` is on the reaction-wheels card is
 * hidden too (`PlayerSatellite.installStandardWheels` at boot). Rows stay in UPGRADES: CATALOG_TOTAL_CR and its pacing pins are
 * catalog-shape facts, and an old save's `wheelKit` purchase still replays (idempotent). Re-exported by ShopScreen.
 * @param {{id?:string, requiresFeature?:string}} u
 * @param {{capsuleCity?: boolean}} [ctx] where she is (plan route-1107-d2 D-B3): the reentry capsule is sold only with `capsuleCity` true (her part goes home by capsule: the six
 *   cities, never New York); a caller with no context never offers it. Every other row ignores it.
 * @returns {boolean}
 */
export function isShopRowOffered(u, ctx) {
  if (!u) return true;
  if (u.id === 'reentry_capsule' && !(ctx && ctx.capsuleCity === true)) return false;
  // owner 2026-11-08 / DECISIONS §68 row 1: the drag sail comes later, so the shop sells none. The row stays in UPGRADES (an old save's purchase and its sails still load).
  if (u.id === 'drag_sail') return false;
  if (u.requiresFeature && !Constants.isFeatureEnabled(u.requiresFeature)) return false;
  if (Constants.FEATURE_FLAGS.FLOWER_PREINSTALLED && (u.id === 'flower_pair_a' || u.id === 'flower_pair_b')) return false;
  if (Constants.WHEELS.STANDARD === true && u.id === 'reaction_wheels') return false;
  return true;
}
