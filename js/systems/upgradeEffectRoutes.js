/**
 * upgradeEffectRoutes.js — explicit shop-effect → subsystem routing map.
 *
 * `GameFlowManager.applyUpgradeEffect` was a hand-maintained `switch`; three purchasable Power upgrades (`graphene_supercap`
 * → `supercapUpgrade`, `rtg_module` → `rtgPower`, `power_beaming` → `powerBeaming`) had handler CASES in ResourceSystem /
 * PlayerSatellite but no `switch` entry, so they silently did nothing on purchase OR save-restore. Routing is now DATA (this
 * map) + a mechanical dispatcher, and the map is exported so `test-shop-effects.js` can assert every catalog `effect` has a
 * route. Pure (imports nothing), so the test loads it in Node with no THREE/DOM.
 *
 * @module systems/upgradeEffectRoutes
 */

// Route-target identifiers: each names a dispatch destination understood by applyUpgradeEffect().
export const RESOURCE_SYSTEM = 'resourceSystem';   // resourceSystem.applyUpgrade(data)
export const PLAYER = 'player';                    // player.applyUpgrade(data)
export const ARM_MANAGER = 'armManager';           // armManager.applyUpgrade(data)
export const SENSOR_EVENT = 'sensorEvent';         // emit SENSOR_UPGRADE (SensorSystem self-manages)
export const KESSLER_SYSTEM = 'kesslerSystem';     // kesslerSystem.applyUpgrade(data)
export const CAPTURE_NET = 'captureNet';           // captureNetSystem.loadOneMotherNet()
export const DAUGHTER_NET = 'daughterNet';         // armManager.addDaughterNet(type): one net into a docked daughter (DECISIONS §33 row 2)
export const RUNTIME = 'runtime';                  // no apply-time action; checked at runtime via _hasUpgrade
export const ARM_MANAGER_EVENT = 'armManagerEvent';// handled by ArmManager's own UPGRADE_PURCHASED listener
export const CARGO_SYSTEM = 'cargoSystem';         // cargoSystem.applyUpgrade(data) — E2 Cargo Bay chain

/** The complete set of valid route targets (for test validation). */
export const ROUTE_TARGETS = new Set([
  RESOURCE_SYSTEM, PLAYER, ARM_MANAGER, SENSOR_EVENT,
  KESSLER_SYSTEM, CAPTURE_NET, DAUGHTER_NET, RUNTIME, ARM_MANAGER_EVENT, CARGO_SYSTEM,
]);

/**
 * The consumable daughter-net restock items (DECISIONS §33 rows 2 and 5): shop effect -> the daughter type whose magazine
 * takes the net ('weaver' = the large daughter, 'spinner' = the small). The ONE table the shop's full check, the purchase
 * guard and the apply route all read.
 */
export const DAUGHTER_NET_EFFECT_TYPE = Object.freeze({
  largeDaughterNet: 'weaver',
  smallDaughterNet: 'spinner',
});

/**
 * effect string → ordered list of subsystems that consume it. MUST cover every `effect` in the ShopScreen UPGRADES catalog
 * (asserted by test-shop-effects.js). Multiple targets = consumed in more than one place (e.g. `supercapUpgrade` bumps
 * battery storage in ResourceSystem AND flips the MPD-cooling flag in PlayerSatellite).
 * @type {Object<string, string[]>}
 */
export const EFFECT_ROUTES = {
  // ── Resource pools → ResourceSystem ──
  xenonMax: [RESOURCE_SYSTEM],
  coldGasMax: [RESOURCE_SYSTEM],
  batteryMax: [RESOURCE_SYSTEM],
  solarEfficiency: [RESOURCE_SYSTEM],
  panelDegradation: [RESOURCE_SYSTEM],

  // ── Engine gas (one-way gas switch, consumable resupply) → ResourceSystem ──
  engineGasSwitch: [RESOURCE_SYSTEM],
  engineGasResupply: [RESOURCE_SYSTEM],
  // ── the nitrogen buy fills her cold-gas tank (it tops up docked daughters) → ResourceSystem ──
  coldGasResupply: [RESOURCE_SYSTEM],
  // ── the ion-fuel cartridge goes into her indium store → ResourceSystem (the satellite's swap is only the look) ──
  indiumCartridge: [RESOURCE_SYSTEM],
  // ── the drag sail goes into her sail stock (a count) → ResourceSystem ──
  dragSail: [RESOURCE_SYSTEM],

  // ── Power infrastructure ──
  // +100 Wh burst store (ResourceSystem.applyUpgrade) + MPD thermal flag (PlayerSatellite.applyUpgrade)
  supercapUpgrade: [RESOURCE_SYSTEM, PLAYER],
  rtgPower: [RESOURCE_SYSTEM],                 // constant Wh/s generation
  powerBeaming: [RESOURCE_SYSTEM],             // ground-pass Wh/s

  // ── Propulsion → PlayerSatellite ──
  xenonEfficiency: [PLAYER],
  thrustMultiplier: [PLAYER],
  coldGasThrust: [PLAYER],
  coldGasEfficiency: [PLAYER],
  mpdThruster: [PLAYER],
  mpdCathodeLife: [PLAYER],

  // ── Thermal (aft flower) → PlayerSatellite ──
  // Purchase-gated hardware install: PlayerSatellite._installFlowerPair builds the pair meshes (idempotent: the
  // save-restore replay re-applies these). Mass rides ArmManager.getMassBudget's coreDry carrier via
  // player.getFlowerDryMassKg(); no resource-side state, so restore replay is safe.
  flowerPairA: [PLAYER],
  flowerPairB: [PLAYER],

  // ── Reaction-wheel kit → PlayerSatellite (hardware flag, idempotent: the save-restore replay re-applies it; the wheels'
  // stored spin is saved apart: `wheelH` in the save, restored after the replay) ──
  wheelKit: [PLAYER],

  // ── Sensors → SENSOR_UPGRADE event (SensorSystem self-manages) ──
  sensorRange: [SENSOR_EVENT],
  detectUntracked: [SENSOR_EVENT],
  scanRange: [SENSOR_EVENT],
  salvageScan: [SENSOR_EVENT],

  // ── Arms → ArmManager ──
  // owner 2026-08-21: the `long_tether` catalog row is RETIRED (it wrote the same live config.tetherMax the tier ladder owns,
  // last-writer-wins). Route + handler STAY: a pre-retirement save's replay (`forEachPurchasedUpgrade` →
  // applyUpgradeEffect) re-applies it so an owned save keeps its reach. No new purchase can emit it.
  tetherRange: [ARM_MANAGER],
  reelSpeed: [ARM_MANAGER],
  armFuelMax: [ARM_MANAGER],
  captureRate: [ARM_MANAGER],
  autoDock: [ARM_MANAGER],
  springTier: [ARM_MANAGER],
  tetherTier: [ARM_MANAGER],

  // ── Salvage → runtime-checked (no apply-time mutation) ──
  hazmatRecovery: [RUNTIME],
  refineryEfficiency: [RUNTIME],

  // ── Consumable Mother Large Net restock ──
  motherNetRestock: [CAPTURE_NET],
  // ── Consumable daughter-net restock (one net into the first docked daughter of that type with room) ──
  largeDaughterNet: [DAUGHTER_NET],
  smallDaughterNet: [DAUGHTER_NET],

  // ── Cargo hold capacity → CargoSystem ──
  cargoCapacity: [CARGO_SYSTEM],

  // ── Kessler / hull ──
  kesslerWarning: [KESSLER_SYSTEM],
  shieldHits: [KESSLER_SYSTEM],

  // ── V4 GSL arm upgrades: dispatched by ArmManager's OWN UPGRADE_PURCHASED listener, so applyUpgradeEffect must not
  //    re-dispatch them. Present here so the catalog-coverage test stays honest.
  //    owner 2026-08-21: `gsl_tether_v4` (v4TetherRange) is RETIRED from the catalog (it out-reached the tether ladder top and
  //    any later tier purchase silently LOWERED reach); route + handler STAY for owned saves. v4NetArea / v4GripForce remain
  //    live cards. ──
  v4TetherRange: [ARM_MANAGER_EVENT],
  v4NetArea: [ARM_MANAGER_EVENT],
  v4GripForce: [ARM_MANAGER_EVENT],
};

/**
 * Effects whose RESOURCE-side state is fully persisted by ResourceSystem.serialize()/restore() AND applied CUMULATIVELY
 * (re-running the handler on restore would double-count). On the MENU_CONTINUE restore path, where resourceSystem.restore()
 * has already set the absolute value, the RESOURCE_SYSTEM route is skipped for these so the `+=` handlers don't double-count
 * (e.g. batteryMax). Their NON-resource routes (e.g. supercapUpgrade → PLAYER) still run.
 *
 * rtgPower / powerBeaming are deliberately NOT listed even though ResourceSystem serializes them: their handlers are plain
 * ASSIGNMENTS (`_rtgRate = value`), so re-applying is idempotent, and it also repairs legacy saves written while the effect
 * was inert (persisted as 0). supercapUpgrade must stay: its resource handler is cumulative (`batteryMax += value`).
 *
 * Purchase and GAMEOVER_CONTINUE (from a reset base) always apply the full route.
 * @type {Set<string>}
 */
export const RESOURCE_RESTORED_EFFECTS = new Set([
  'xenonMax', 'coldGasMax', 'batteryMax', 'supercapUpgrade',
  // restore() already set the tank gas (`tankGasId`) and fills the launch mass: a replay on MENU_CONTINUE must not vent or
  // refill. (GAMEOVER_CONTINUE replays from a reset base.)
  'engineGasSwitch',
]);

/**
 * Route targets for an effect on a given code path.
 * @param {{ restore?: boolean }} [opts] restore=true drops the RESOURCE_SYSTEM target for RESOURCE_RESTORED_EFFECTS.
 * @returns {string[]} targets to dispatch (possibly empty)
 */
export function resolveEffectRoute(effect, opts = {}) {
  const targets = EFFECT_ROUTES[effect];
  if (!targets) return [];
  if (opts.restore && RESOURCE_RESTORED_EFFECTS.has(effect)) {
    return targets.filter((t) => t !== RESOURCE_SYSTEM);
  }
  return targets;
}
