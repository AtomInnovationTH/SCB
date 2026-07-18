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

/**
 * Whether an upgrade's prerequisites are satisfied.
 * Supports a single `requires` (id string), `requiresAll` (array of ids), and
 * `requiresFeature` (a FEATURE_FLAGS gate).
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
