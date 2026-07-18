/**
 * upgradeEffectRoutes.js — F4: explicit shop-effect → subsystem routing map.
 *
 * WHY THIS EXISTS (F4): `GameFlowManager.applyUpgradeEffect` used to be a hand-
 * maintained `switch`. Three purchasable Power upgrades — `graphene_supercap`
 * (`supercapUpgrade`, 2,500 cr), `rtg_module` (`rtgPower`, 3,500 cr) and
 * `power_beaming` (`powerBeaming`, 2,000 cr) — had working handler CASES in
 * ResourceSystem / PlayerSatellite but no `switch` entry routing to them, so
 * ~8,000 cr of shop effects silently did nothing on purchase OR save-restore.
 *
 * The routing is now DATA (this map) + a mechanical dispatcher, and the map is
 * exported so `test-shop-effects.js` can assert that every catalog `effect`
 * has a route (no more silently-inert purchases). This module is pure — it
 * imports nothing — so the test loads it in Node with no THREE/DOM.
 *
 * @module systems/upgradeEffectRoutes
 */

// ── Route-target identifiers ────────────────────────────────────────────────
// Each names a dispatch destination understood by applyUpgradeEffect().
export const RESOURCE_SYSTEM = 'resourceSystem';   // resourceSystem.applyUpgrade(data)
export const PLAYER = 'player';                    // player.applyUpgrade(data)
export const ARM_MANAGER = 'armManager';           // armManager.applyUpgrade(data)
export const SENSOR_EVENT = 'sensorEvent';         // emit SENSOR_UPGRADE (SensorSystem self-manages)
export const KESSLER_SYSTEM = 'kesslerSystem';     // kesslerSystem.applyUpgrade(data)
export const CAPTURE_NET = 'captureNet';           // captureNetSystem.loadOneMotherNet()
export const RUNTIME = 'runtime';                  // no apply-time action; checked at runtime via _hasUpgrade
export const ARM_MANAGER_EVENT = 'armManagerEvent';// handled by ArmManager's own UPGRADE_PURCHASED listener

/** The complete set of valid route targets (for test validation). */
export const ROUTE_TARGETS = new Set([
  RESOURCE_SYSTEM, PLAYER, ARM_MANAGER, SENSOR_EVENT,
  KESSLER_SYSTEM, CAPTURE_NET, RUNTIME, ARM_MANAGER_EVENT,
]);

/**
 * effect string → ordered list of subsystems that consume it.
 * MUST cover every `effect` in the ShopScreen UPGRADES catalog (asserted by
 * test-shop-effects.js). Multiple targets = the effect is consumed in more
 * than one place (e.g. `supercapUpgrade` bumps battery storage in
 * ResourceSystem AND flips the MPD-cooling flag in PlayerSatellite).
 * @type {Object<string, string[]>}
 */
export const EFFECT_ROUTES = {
  // ── Resource pools → ResourceSystem ──
  xenonMax: [RESOURCE_SYSTEM],
  coldGasMax: [RESOURCE_SYSTEM],
  batteryMax: [RESOURCE_SYSTEM],
  solarEfficiency: [RESOURCE_SYSTEM],
  panelDegradation: [RESOURCE_SYSTEM],

  // ── S3b power infrastructure (F4: these three were inert) ──
  supercapUpgrade: [RESOURCE_SYSTEM, PLAYER], // +100 Wh burst store + MPD thermal flag (ResourceSystem.js:480, PlayerSatellite.js:3616)
  rtgPower: [RESOURCE_SYSTEM],                 // constant Wh/s generation (ResourceSystem.js:486)
  powerBeaming: [RESOURCE_SYSTEM],             // ground-pass Wh/s (ResourceSystem.js:490)

  // ── Propulsion → PlayerSatellite ──
  xenonEfficiency: [PLAYER],
  thrustMultiplier: [PLAYER],
  coldGasThrust: [PLAYER],
  coldGasEfficiency: [PLAYER],
  mpdThruster: [PLAYER],
  mpdCathodeLife: [PLAYER],

  // ── Sensors → SENSOR_UPGRADE event (SensorSystem self-manages) ──
  sensorRange: [SENSOR_EVENT],
  detectUntracked: [SENSOR_EVENT],
  scanRange: [SENSOR_EVENT],
  salvageScan: [SENSOR_EVENT],

  // ── Arms → ArmManager ──
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

  // ── Kessler / hull ──
  kesslerWarning: [KESSLER_SYSTEM],
  shieldHits: [KESSLER_SYSTEM],

  // ── V4 GSL arm upgrades — dispatched by ArmManager's OWN UPGRADE_PURCHASED
  //    listener (ArmManager.js:279), so applyUpgradeEffect must not re-dispatch
  //    them. Present here so the catalog-coverage test stays honest. ──
  v4TetherRange: [ARM_MANAGER_EVENT],
  v4NetArea: [ARM_MANAGER_EVENT],
  v4GripForce: [ARM_MANAGER_EVENT],
};

/**
 * Effects whose RESOURCE-side state is fully persisted by
 * ResourceSystem.serialize()/restore() AND applied CUMULATIVELY (so re-running
 * their handler on the restore path would double-count). On the MENU_CONTINUE
 * restore path — where resourceSystem.restore() has already set the absolute
 * value — the RESOURCE_SYSTEM route is skipped for these so the `+=` handlers
 * don't double-count (e.g. batteryMax). Their NON-resource routes (e.g.
 * supercapUpgrade → PLAYER) still run so the player-side flag is re-applied.
 *
 * NOTE: rtgPower / powerBeaming are deliberately NOT listed here even though
 * ResourceSystem also serializes them — their handlers are plain ASSIGNMENTS
 * (`_rtgRate = value`), so re-applying on restore is idempotent. Leaving them
 * OUT means the restore path re-applies them, which also retroactively repairs
 * legacy saves written before F4 (where the effect was inert, so the field was
 * persisted as 0). supercapUpgrade must stay because its resource handler is
 * cumulative (`batteryMax += value`).
 *
 * Purchase and GAMEOVER_CONTINUE (from a reset base) always apply the full route.
 * @type {Set<string>}
 */
export const RESOURCE_RESTORED_EFFECTS = new Set([
  'xenonMax', 'coldGasMax', 'batteryMax', 'supercapUpgrade',
]);

/**
 * Resolve the route targets for an effect on a given code path.
 * @param {string} effect — the catalog effect string
 * @param {{ restore?: boolean }} [opts] — restore=true drops the RESOURCE_SYSTEM
 *   target for RESOURCE_RESTORED_EFFECTS (see above).
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
