/**
 * The REFIT pane's data layer (docs/ladder/08-workbench.md §2 "REFIT card", §7, §10; D9 seven callouts).
 *
 * One entry per ShopScreen UPGRADES row (all 33) carrying what the RefitPane needs that the shop catalog lacks:
 *   1. `subsystem` - which of the SEVEN hull callouts (D9) the item belongs to, by what the upgrade PHYSICALLY changes
 *      (borderline calls are commented at the row).
 *   2. `display` - { param, base, unit, op }: the one number that matters, its pre-upgrade base, unit, and what buying does to it.
 *      DERIVED from the sources the live handlers read (Constants, SENSOR_TIERS, the row's `value`), never hand-copied where an
 *      importable SSOT exists.
 *   3. `current` - a pure adapter over INJECTED getters reading the live value of `display.param`. No live-singleton imports:
 *      callers pass { resourceSystem, player, armManager, sensorSystem, kesslerSystem, cargoSystem, captureNetSystem, hasUpgrade }
 *      (any subset; tests pass stubs). HEADLESS-SAFE: an absent getter yields undefined and the pane renders the static base.
 *
 * Each entry also carries `routes` (EFFECT_ROUTES targets for its effect) and `reads` (the injected dep the adapter consumes).
 * test-fittingCatalog.js asserts reads are in the routes' provider set, so a route change in upgradeEffectRoutes.js trips this
 * catalog too (the F4 law extended to display semantics).
 *
 * IMPORT DISCIPLINE: only pure-data SSOTs (UPGRADES, read-only and NEVER mutated here; EFFECT_ROUTES; Constants; SENSOR_TIERS, a pure
 * table; blueprintSubsystems' M_TO_U). Live system instances are always injected.
 *
 * Q3 (owner default "graceful"): COMMS has nothing to buy and THERMAL only the flower pairs. `groupBySubsystem()` returns ALL SEVEN
 * keys, empty arrays included ("nothing to refit yet" is RefitPane copy, not a missing key). This module authors NO shop items.
 *
 * @module data/fittingCatalog
 */

import { Constants } from '../core/Constants.js';
import { UPGRADES } from '../ui/ShopScreen.js';
import { EFFECT_ROUTES } from '../systems/upgradeEffectRoutes.js';
import { engineGasKg, START_GAS_KG, coldGasPoolToKg } from '../systems/ResourceSystem.js';
import { SENSOR_TIERS } from '../systems/SensorSystem.js';
import { M_TO_U } from './blueprintSubsystems.js';

/** The seven hull callouts (D9): the ONLY legal subsystem tags, in D9 order (five shipped parts, then the two added). */
export const SUBSYSTEMS = Object.freeze([
  'ENGINEERING', 'POWER', 'COMMS', 'THERMAL', 'CARGO', 'SENSORS', 'BERTHS',
]);

/**
 * km per scene unit from blueprintSubsystems' metre scale (1e-5 u/m = 100 km/u); rounded at metres-per-unit to shed
 * the fp residue of the reciprocal (1/1e-5 = 99999.99...).
 */
export const KM_PER_SCENE_UNIT = Math.round(1 / M_TO_U) / 1000;

/** Base solar output (W): the product ResourceSystem's constructor and solarEfficiency handler compute from Constants. */
export const SOLAR_BASE_W =
  Constants.SOLAR_PANEL_EFFICIENCY * Constants.SOLAR_FLUX * Constants.SOLAR_PANEL_AREA;

/** Full Mother large-net magazine: launchers x nets/launcher = 1 x 4 (CaptureNet._motherPodMax). */
export const MOTHER_NET_MAGAZINE_FULL =
  Constants.CAPTURE_NET.MOTHER_POD_COUNT * Constants.CAPTURE_NET.LARGE.MAGAZINE_SIZE;

/** Wrap an adapter body so it NEVER throws on missing/partial deps: absent getter or NaN -> undefined (the pane then shows the static base). */
const safeAdapter = (fn) => (deps) => {
  try {
    const v = fn(deps || {});
    if (typeof v === 'number' && !Number.isFinite(v)) return undefined;
    return v === null ? undefined : v;
  } catch {
    return undefined;
  }
};

/**
 * First arm as fleet representative: fleet-wide shop effects apply to EVERY arm (ArmManager.applyUpgrade, re-applied
 * via _storedUpgrades), so arms[0] is an honest read.
 */
const firstArm = (deps) => deps.armManager?.arms?.[0];

/** Per-type arm base for a config field (weaver vs spinner Constants pair). */
const armTypeBase = (arm, weaverKey, spinnerKey) =>
  (arm?.type === 'spinner' ? Constants[spinnerKey] : Constants[weaverKey]);

/** Ownership check for RUNTIME-routed effects (GameFlowManager._hasUpgrade shape); `hasUpgrade(id) -> boolean` is injected. */
const owned = (deps, id) =>
  (typeof deps.hasUpgrade === 'function' ? !!deps.hasUpgrade(id) : undefined);

// Route target -> the injected dep an adapter may read for that effect. Mirrors GameFlowManager.applyUpgradeEffect's dispatch
// (pinned by test-shop-effects); ARM_MANAGER_EVENT reaches the same ArmManager via its UPGRADE_PURCHASED listener.
export const ROUTE_READS = Object.freeze({
  resourceSystem: 'resourceSystem',
  player: 'player',
  armManager: 'armManager',
  armManagerEvent: 'armManager',
  sensorEvent: 'sensorSystem',
  kesslerSystem: 'kesslerSystem',
  captureNet: 'captureNetSystem',
  daughterNet: 'armManager',      // DECISIONS §33: ArmManager.addDaughterNet(type)
  cargoSystem: 'cargoSystem',
  runtime: 'hasUpgrade',
});

// Per-upgrade fitting specs, keyed by ShopScreen upgrade id. `display(row)` derives { param, base, unit, op } from the row's live
// `value` + Constants/SENSOR_TIERS (op grammar: '×N' multiply, '+N' add, '=N' absolute set, 'ON' enable). `current(deps, row)`
// reads the live param. `reads` is checked against EFFECT_ROUTES by the coverage test.
// Subsystem tag law (D9): tag by what the upgrade PHYSICALLY changes; borderline calls are commented at the row.
const FITTING_SPECS = {
  // ENGINEERING: thruster block / bus structure (10)
  efficient_ion: {
    subsystem: 'ENGINEERING', reads: 'player',
    // _ionThrustXenonRate = base × value; the base is a PlayerSatellite constructor literal (no Constants key), so display the
    // consumption MULTIPLIER (nominal 1) and read live/base.
    display: (row) => ({ param: 'ionXenonRateMult', base: 1, unit: '×', op: `×${row.value}` }),
    current: (deps) => deps.player?._ionThrustXenonRate / deps.player?._baseIonXenonRate,
  },
  high_thrust_ion: {
    subsystem: 'ENGINEERING', reads: 'player',
    display: (row) => ({ param: 'ionThrustMult', base: 1, unit: '×', op: `×${row.value}` }),
    current: (deps) => deps.player?._thrustMult,
  },
  extra_xenon: {
    // a bigger tank is SPACE: shown in litres (the pool is a percentage of the 60 L base tank)
    subsystem: 'ENGINEERING', reads: 'resourceSystem',
    display: (row) => ({ param: 'engineTankL', base: Constants.ENGINE_TANK_VOLUME_L, unit: 'L',
      op: `+${row.value / Constants.XENON_FUEL_MAX * Constants.ENGINE_TANK_VOLUME_L}` }),
    current: (deps) => deps.resourceSystem?.xenonMax / Constants.XENON_FUEL_MAX * Constants.ENGINE_TANK_VOLUME_L,
  },
  // krypton / xenon are one-way upgrades of the tank gas; shown as thrust scale on the same power, `current` reads the tank gas's
  gas_krypton: {
    subsystem: 'ENGINEERING', reads: 'resourceSystem',
    display: (row) => ({ param: 'gasThrustScale', base: Constants.FUELS[Constants.DEFAULT_FUEL].thrustScale, unit: '×',
      op: `=${Constants.FUELS[row.value].thrustScale}` }),
    current: (deps) => Constants.FUELS[deps.resourceSystem?.tankGasId]?.thrustScale,
  },
  gas_xenon: {
    subsystem: 'ENGINEERING', reads: 'resourceSystem',
    display: (row) => ({ param: 'gasThrustScale', base: Constants.FUELS[Constants.DEFAULT_FUEL].thrustScale, unit: '×',
      op: `=${Constants.FUELS[row.value].thrustScale}` }),
    current: (deps) => Constants.FUELS[deps.resourceSystem?.tankGasId]?.thrustScale,
  },
  // range is bought by the kilo; shown as engine gas aboard (kg)
  gas_resupply: {
    subsystem: 'ENGINEERING', reads: 'resourceSystem',
    display: (row) => ({ param: 'engineGasKg', base: START_GAS_KG, unit: 'kg', op: `+${row.value}` }),
    current: (deps) => (deps.resourceSystem ? engineGasKg(deps.resourceSystem) : undefined),
  },
  // nitrogen for her cold-gas tank (tops up docked daughters); shown as cold gas aboard (kg)
  coldgas_resupply: {
    subsystem: 'ENGINEERING', reads: 'resourceSystem',
    // real kg (the pool is 0.3 kg a unit), so a 5 kg buy reads +5
    display: (row) => ({ param: 'coldGasKg', base: coldGasPoolToKg(Constants.COLD_GAS_MAX * Constants.PROPELLANT_START_FRACTION), unit: 'kg', op: `+${row.value}` }),
    current: (deps) => (deps.resourceSystem && Number.isFinite(deps.resourceSystem.coldGas) ? coldGasPoolToKg(deps.resourceSystem.coldGas) : undefined),
  },
  extra_coldgas: {
    subsystem: 'ENGINEERING', reads: 'resourceSystem',
    // the tank is POOL units (20 = 6 kg); the pane reads real kg
    display: (row) => ({ param: 'coldGasMax', base: coldGasPoolToKg(Constants.COLD_GAS_MAX), unit: 'kg', op: `+${coldGasPoolToKg(row.value)}` }),
    current: (deps) => (Number.isFinite(deps.resourceSystem?.coldGasMax) ? coldGasPoolToKg(deps.resourceSystem.coldGasMax) : undefined),
  },
  // shown as wheels aboard (count, 0 -> +3), read from the player's kit flag
  reaction_wheels: {
    subsystem: 'ENGINEERING', reads: 'player',
    display: () => ({ param: 'reactionWheels', base: 0, unit: 'wheels', op: `+${Constants.WHEELS.COUNT}` }),
    current: (deps) => (deps.player && typeof deps.player.hasWheelKit === 'function' ? (deps.player.hasWheelKit() ? Constants.WHEELS.COUNT : 0) : undefined),
  },
  mpd_thruster: {
    subsystem: 'ENGINEERING', reads: 'player',
    // catalog value is `true`; the REAL magnitude is Constants.MPD_PASSIVE_THRUST_MULT (applied in PlayerSatellite)
    display: () => ({ param: 'mpdPassiveMult', base: 1, unit: '×', op: `×${Constants.MPD_PASSIVE_THRUST_MULT}` }),
    current: (deps) => deps.player?._mpdPassiveMult,
  },
  hardened_cathode: {
    subsystem: 'ENGINEERING', reads: 'player',
    display: (row) => ({ param: 'mpdCathodeLife', base: Constants.MPD_CATHODE_LIFE, unit: 's', op: `=${row.value}` }),
    current: (deps) => deps.player?._mpdCathodeLife,
  },
  whipple_shield: {
    // BORDERLINE (shop cat "Hull"): a Whipple bumper wraps the bus structure. NOT THERMAL: Q3 pins THERMAL as only the flower pairs.
    subsystem: 'ENGINEERING', reads: 'kesslerSystem',
    display: (row) => ({ param: 'shieldHits', base: 0, unit: 'hits', op: `+${row.value}` }),
    current: (deps) => deps.kesslerSystem?.shieldHits,
  },

  // POWER: arrays, storage, generation (8)
  efficient_panels: {
    subsystem: 'POWER', reads: 'resourceSystem',
    // solarRate = EFF × value × FLUX × AREA: ×value on SOLAR_BASE_W (08-workbench §3 card: base -> ×1.3)
    display: (row) => ({ param: 'solarOutput', base: SOLAR_BASE_W, unit: 'W', op: `×${row.value}` }),
    current: (deps) => deps.resourceSystem?.solarRate,
  },
  multi_junction_solar: {
    subsystem: 'POWER', reads: 'resourceSystem',
    // same param as efficient_panels; the handler recomputes from base (no compounding): ×2.0 OF BASE
    display: (row) => ({ param: 'solarOutput', base: SOLAR_BASE_W, unit: 'W', op: `×${row.value}` }),
    current: (deps) => deps.resourceSystem?.solarRate,
  },
  extra_battery: {
    subsystem: 'POWER', reads: 'resourceSystem',
    display: (row) => ({ param: 'batteryMax', base: Constants.BATTERY_MAX, unit: 'Wh', op: `+${row.value}` }),
    current: (deps) => deps.resourceSystem?.batteryMax,
  },
  solid_state_battery: {
    subsystem: 'POWER', reads: 'resourceSystem',
    display: (row) => ({ param: 'batteryMax', base: Constants.BATTERY_MAX, unit: 'Wh', op: `+${row.value}` }),
    current: (deps) => deps.resourceSystem?.batteryMax,
  },
  graphene_supercap: {
    subsystem: 'POWER', reads: 'resourceSystem',
    // two-leg route (RESOURCE_SYSTEM + PLAYER): the number that matters is the +100 Wh burst store
    display: (row) => ({ param: 'batteryMax', base: Constants.BATTERY_MAX, unit: 'Wh', op: `+${row.value}` }),
    current: (deps) => deps.resourceSystem?.batteryMax,
  },
  rtg_module: {
    subsystem: 'POWER', reads: 'resourceSystem',
    display: (row) => ({ param: 'rtgRate', base: 0, unit: 'Wh/s', op: `=${row.value}` }),
    current: (deps) => deps.resourceSystem?.getStatus?.().rtgRate,
  },
  power_beaming: {
    // BORDERLINE: a rectenna is antenna-shaped, but what it changes is the POWER budget (+5 Wh/s on ground pass); Q3 expects COMMS empty
    subsystem: 'POWER', reads: 'resourceSystem',
    display: (row) => ({ param: 'powerBeamRate', base: 0, unit: 'Wh/s', op: `=${row.value}` }),
    current: (deps) => deps.resourceSystem?.getStatus?.().powerBeamRate,
  },
  rad_hard_panels: {
    subsystem: 'POWER', reads: 'resourceSystem',
    // handler assigns the degradation multiplier absolutely (0.5); with base 1 and maxLevel 1 that IS ×0.5
    display: (row) => ({ param: 'panelDegradationMult', base: 1, unit: '×', op: `×${row.value}` }),
    current: (deps) => deps.resourceSystem?.panelDegradationMultiplier,
  },

  // SENSORS: the SensorDeck (5)
  enhanced_eo: {
    subsystem: 'SENSORS', reads: 'sensorSystem',
    // SensorSystem.range is scene units; shown in km via the derived scale
    display: (row) => ({ param: 'sensorRange', base: SENSOR_TIERS.basic.rangeKm, unit: 'km', op: `×${row.value}` }),
    current: (deps) => deps.sensorSystem?.range * KM_PER_SCENE_UNIT,
  },
  ir_scanner: {
    subsystem: 'SENSORS', reads: 'sensorSystem',
    display: () => ({ param: 'detectUntracked', base: false, unit: 'flag', op: 'ON' }),
    current: (deps) => deps.sensorSystem && !!deps.sensorSystem.canDetectUntracked,
  },
  advanced_lidar: {
    subsystem: 'SENSORS', reads: 'sensorSystem',
    display: (row) => ({ param: 'scanRate', base: SENSOR_TIERS.basic.scanRate, unit: '×', op: `×${row.value}` }),
    current: (deps) => deps.sensorSystem?.scanRate,
  },
  salvage_scanner: {
    subsystem: 'SENSORS', reads: 'sensorSystem',
    display: () => ({ param: 'salvageScan', base: false, unit: 'flag', op: 'ON' }),
    current: (deps) => deps.sensorSystem && !!deps.sensorSystem.canScanSalvage,
  },
  kessler_warning: {
    // BORDERLINE (shop cat "Automation"): warnings land in comms, but the player buys situational AWARENESS (onboard cascade
    // analysis), a sensing capability. Q3 expects COMMS empty.
    subsystem: 'SENSORS', reads: 'kesslerSystem',
    display: () => ({ param: 'cascadeWarnings', base: false, unit: 'flag', op: 'ON' }),
    current: (deps) => deps.kesslerSystem && !!deps.kesslerSystem._warningsEnabled,
  },

  // BERTHS: daughter docks, reels, nets, arm tooling (9; D9 "arms, nets ... included")
  fast_reel: {
    subsystem: 'BERTHS', reads: 'armManager',
    // approachSpeed = ARM_APPROACH_SPEED × value: display the multiplier, read live/base
    display: (row) => ({ param: 'reelSpeedMult', base: 1, unit: '×', op: `×${row.value}` }),
    current: (deps) => firstArm(deps)?.config?.approachSpeed / Constants.ARM_APPROACH_SPEED,
  },
  arm_fuel: {
    subsystem: 'BERTHS', reads: 'armManager',
    // capturesPerFuel scales from the per-type base (weaver 33 / spinner 37): the multiplier is the fleet-wide number
    display: (row) => ({ param: 'armFuelMult', base: 1, unit: '×', op: `×${row.value}` }),
    current: (deps) => {
      const arm = firstArm(deps);
      return arm?.config?.capturesPerFuel
        / armTypeBase(arm, 'WEAVER_CAPTURES_PER_FUEL', 'SPINNER_CAPTURES_PER_FUEL');
    },
  },
  capture_net: {
    subsystem: 'BERTHS', reads: 'armManager',
    // captureSuccessRate = min(1, 0.85 + value); 0.85 is Constants.ARM_CAPTURE_SUCCESS_RATE
    display: (row) => ({ param: 'captureSuccess', base: Constants.ARM_CAPTURE_SUCCESS_RATE, unit: 'prob', op: `+${row.value}` }),
    current: (deps) => firstArm(deps)?.config?.captureSuccessRate,
  },
  mother_net_restock: {
    // BORDERLINE: the Large-Net launcher rides the Mother hull, but D9 groups nets with the berth/reel cartridges -> BERTHS
    subsystem: 'BERTHS', reads: 'captureNetSystem',
    display: (row) => ({ param: 'motherNets', base: MOTHER_NET_MAGAZINE_FULL, unit: 'nets', op: `+${row.value}` }),
    current: (deps) => deps.captureNetSystem?.getMotherNetCount?.(),
  },
  // DECISIONS §33 rows 2/5: a daughter's nets refill only here, one per buy, into the first docked daughter of the size
  large_daughter_net: {
    subsystem: 'BERTHS', reads: 'armManager',
    display: (row) => ({ param: 'largeDaughterNets', base: Constants.CAPTURE_NET.MEDIUM.MAGAZINE_SIZE, unit: 'nets', op: `+${row.value}` }),
    current: (deps) => deps.armManager?.arms?.find((a) => a?.config?.type === 'weaver')?.getNetInventory?.(),
  },
  small_daughter_net: {
    subsystem: 'BERTHS', reads: 'armManager',
    display: (row) => ({ param: 'smallDaughterNets', base: Constants.CAPTURE_NET.SMALL.MAGAZINE_SIZE, unit: 'nets', op: `+${row.value}` }),
    current: (deps) => deps.armManager?.arms?.find((a) => a?.config?.type === 'spinner')?.getNetInventory?.(),
  },
  // an ion-fuel cartridge goes into her indium store (kg); a docked daughter swaps it in; shown as the store's level
  indium_cartridge: {
    subsystem: 'BERTHS', reads: 'resourceSystem',
    display: (row) => ({ param: 'indiumStoreKg', base: 0, unit: 'kg', op: `+${row.value}` }),
    current: (deps) => deps.resourceSystem?.indiumStoreKg,
  },
  // a drag sail goes into her sail stock (count; its mass is part of hers); shown as the stock's level
  drag_sail: {
    subsystem: 'BERTHS', reads: 'resourceSystem',
    display: (row) => ({ param: 'dragSails', base: 0, unit: 'sails', op: `+${row.value}` }),
    current: (deps) => deps.resourceSystem?.dragSails,
  },
  hazmat_handler: {
    subsystem: 'BERTHS', reads: 'hasUpgrade',
    // RUNTIME route: no apply-time mutation; the live value IS ownership (GameFlowManager checks _hasUpgrade at salvage time)
    display: () => ({ param: 'hazmatRecovery', base: false, unit: 'flag', op: 'ON' }),
    current: (deps) => owned(deps, 'hazmat_handler'),
  },
  refinery_arm: {
    subsystem: 'BERTHS', reads: 'hasUpgrade',
    // RUNTIME route: GameFlowManager applies `owned ? value : 1` at salvage time; the adapter mirrors it from row.value
    display: (row) => ({ param: 'salvageYieldMult', base: 1, unit: '×', op: `×${row.value}` }),
    current: (deps, row) => {
      const has = owned(deps, 'refinery_arm');
      return has === undefined ? undefined : (has ? row.value : 1);
    },
  },
  auto_dock: {
    // BORDERLINE (shop cat "Hull"): the handler speeds daughter DOCKING (ArmUnit dockSpeedMultiplier), hardware at the berths
    subsystem: 'BERTHS', reads: 'armManager',
    // dockSpeedMultiplier = 1 / value (0.5 -> ×2 faster); derive the ×2 from the row value
    display: (row) => ({ param: 'dockSpeedMult', base: 1, unit: '×', op: `×${1 / row.value}` }),
    current: (deps) => firstArm(deps)?.config?.dockSpeedMultiplier,
  },
  gsl_net_v4: {
    subsystem: 'BERTHS', reads: 'armManager',
    // row value is √(area mult) (linear net size); the number shown is the AREA multiplier (Constants.V4_NET_SIZE_MULT); the
    // adapter squares the live linear ratio
    display: () => ({ param: 'netAreaMult', base: 1, unit: '×', op: `×${Constants.V4_NET_SIZE_MULT}` }),
    current: (deps) => {
      const arm = firstArm(deps);
      const ratio = arm?.config?.netSize / armTypeBase(arm, 'WEAVER_NET_SIZE', 'SPINNER_NET_SIZE');
      return Number.isFinite(ratio) ? ratio * ratio : undefined;
    },
  },
  gsl_electrostatic_v4: {
    subsystem: 'BERTHS', reads: 'armManager',
    display: (row) => ({ param: 'captureMassMult', base: 1, unit: '×', op: `×${row.value}` }),
    current: (deps) => {
      const arm = firstArm(deps);
      return arm?.config?.maxCaptureMass
        / armTypeBase(arm, 'WEAVER_MAX_CAPTURE_MASS', 'SPINNER_MAX_CAPTURE_MASS');
    },
  },

  // CARGO: the hold (2)
  cargo_bay_2: {
    subsystem: 'CARGO', reads: 'cargoSystem',
    // CargoSystem assigns the ABSOLUTE target (row.value IS Constants.CARGO_BAY_TIER2_KG): op '='
    display: (row) => ({ param: 'cargoCapacity', base: Constants.CARGO_CAPACITY_KG, unit: 'kg', op: `=${row.value}` }),
    current: (deps) => deps.cargoSystem?.getStatus?.().capacityKg,
  },
  cargo_bay_3: {
    subsystem: 'CARGO', reads: 'cargoSystem',
    display: (row) => ({ param: 'cargoCapacity', base: Constants.CARGO_CAPACITY_KG, unit: 'kg', op: `=${row.value}` }),
    current: (deps) => deps.cargoSystem?.getStatus?.().capacityKg,
  },

  // THERMAL: the aft flower (2; Q3: only the flower pairs)
  flower_pair_a: {
    subsystem: 'THERMAL', reads: 'player',
    display: (row) => ({ param: 'flowerPairs', base: 0, unit: 'pairs', op: `+${row.value}` }),
    current: (deps) => deps.player?.getFlowerPairCount?.(),
  },
  flower_pair_b: {
    subsystem: 'THERMAL', reads: 'player',
    display: (row) => ({ param: 'flowerPairs', base: 0, unit: 'pairs', op: `+${row.value}` }),
    current: (deps) => deps.player?.getFlowerPairCount?.(),
  },
};

/**
 * Build one fitting entry from a ShopScreen row (read-only) + its spec. A row with no spec builds a DEGENERATE entry (subsystem
 * null, display null, adapter -> undefined) rather than throwing: the game never crashes on catalog drift; the coverage test trips instead.
 */
function buildEntry(row) {
  const spec = FITTING_SPECS[row.id];
  if (!spec) {
    return Object.freeze({
      id: row.id, shop: row, effect: row.effect,
      subsystem: null, display: null, routes: EFFECT_ROUTES[row.effect] || [],
      reads: null, current: () => undefined,
    });
  }
  return Object.freeze({
    id: row.id,
    /** the live ShopScreen row: a REFERENCE, no copy */
    shop: row,
    effect: row.effect,
    subsystem: spec.subsystem,
    display: Object.freeze(spec.display(row)),
    routes: EFFECT_ROUTES[row.effect] || [],
    reads: spec.reads,
    current: safeAdapter((deps) => spec.current(deps, row)),
  });
}

/**
 * One entry per ShopScreen UPGRADES row, same order; the coverage test pins the count so a catalog edit without
 * fitting metadata trips loudly. @type {ReadonlyArray<object>}
 */
export const FITTING_CATALOG = Object.freeze(UPGRADES.map(buildEntry));

/** Spec keys with no catalog row would be dead weight: exported so the coverage test can assert there are none (F4 stale-key guard). */
export const FITTING_SPEC_IDS = Object.freeze(Object.keys(FITTING_SPECS));

/**
 * Group the catalog by subsystem for the RefitPane. ALWAYS returns all seven keys (Q3 graceful): an empty array means "nothing to
 * refit yet", never a missing group.
 * @returns {Object<string, object[]>} subsystem -> entries (catalog order)
 */
export function groupBySubsystem(catalog = FITTING_CATALOG) {
  const groups = {};
  for (const s of SUBSYSTEMS) groups[s] = [];
  for (const entry of catalog) {
    if (groups[entry.subsystem]) groups[entry.subsystem].push(entry);
  }
  return groups;
}

/** Look up one fitting entry by ShopScreen upgrade id. */
export function getFittingEntry(id) {
  return FITTING_CATALOG.find((e) => e.id === id);
}
