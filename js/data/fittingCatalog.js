/**
 * fittingCatalog.js — Wave 4 S2: the REFIT pane's data layer
 * (docs/ladder/08-workbench.md §2 "REFIT card", §7, §10; D9 seven callouts).
 *
 * WHAT THIS IS: one entry per ShopScreen UPGRADES row (all 33) carrying the
 * three things the Wave-5 RefitPane needs that the shop catalog does not have:
 *
 *   1. `subsystem`  — which of the SEVEN hull callouts (D9) the item belongs
 *      to, chosen by what the upgrade PHYSICALLY changes (borderline calls are
 *      documented inline).
 *   2. `display`    — { param, base, unit, op }: the one number that matters,
 *      its pre-upgrade base, its unit, and what buying does to it. DERIVED
 *      from the same sources the live handlers read (Constants, SENSOR_TIERS,
 *      the row's own `value`) — never hand-copied where an importable SSOT
 *      exists.
 *   3. `current`    — a pure adapter over INJECTED getters that reads the live
 *      value of `display.param`. No live-singleton imports here: callers pass
 *      { resourceSystem, player, armManager, sensorSystem, kesslerSystem,
 *      cargoSystem, captureNetSystem, hasUpgrade } (any subset; tests pass
 *      plain stubs). HEADLESS-SAFE: an adapter never throws when a getter is
 *      absent — it returns undefined and the pane renders the static base.
 *
 * Each entry also carries `routes` (the EFFECT_ROUTES targets for its effect)
 * and `reads` (which injected dep the adapter consumes). The coverage test
 * (test-fittingCatalog.js) asserts reads ⊆ routes' provider set, so a route
 * change in upgradeEffectRoutes.js trips this catalog too (the F4 law extended
 * to display semantics).
 *
 * IMPORT DISCIPLINE: only pure-data SSOTs are imported — the UPGRADES catalog
 * (read-only; this module NEVER mutates it), the EFFECT_ROUTES map, Constants,
 * SENSOR_TIERS (a pure exported table; SensorSystem.js constructs no top-level
 * singleton), and blueprintSubsystems' M_TO_U scale. Live system instances are
 * always injected.
 *
 * Q3 (owner default "graceful"): COMMS currently has nothing to buy and
 * THERMAL only the flower pairs. `groupBySubsystem()` returns ALL SEVEN keys,
 * empty arrays included — "nothing to refit yet" is the RefitPane's copy, not
 * a missing key. This module authors NO shop items.
 *
 * @module data/fittingCatalog
 */

import { Constants } from '../core/Constants.js';
import { UPGRADES } from '../ui/ShopScreen.js';
import { EFFECT_ROUTES } from '../systems/upgradeEffectRoutes.js';
import { SENSOR_TIERS } from '../systems/SensorSystem.js';
import { M_TO_U } from './blueprintSubsystems.js';

// ── The seven hull callouts (D9) — the ONLY legal subsystem tags ───────────
// Order matches the D9 phrasing: the five shipped parts, then the two added.
export const SUBSYSTEMS = Object.freeze([
  'ENGINEERING', 'POWER', 'COMMS', 'THERMAL', 'CARGO', 'SENSORS', 'BERTHS',
]);

// ── Derived scale + base constants (SSOT-derived, never hand-copied) ───────

/** km per scene unit, derived from blueprintSubsystems' metre scale (1e-5 u/m
 *  → 100 km/u). Rounded at the metres-per-unit level to shed the fp residue of
 *  the reciprocal (1/1e-5 = 99999.99…) — the scale itself is exact. */
export const KM_PER_SCENE_UNIT = Math.round(1 / M_TO_U) / 1000;

/** Base solar output in W — the exact product ResourceSystem's constructor and
 *  its solarEfficiency handler compute from Constants (ResourceSystem.js:30). */
export const SOLAR_BASE_W =
  Constants.SOLAR_PANEL_EFFICIENCY * Constants.SOLAR_FLUX * Constants.SOLAR_PANEL_AREA;

/** Full Mother large-net magazine: pods × nets/pod (CaptureNet._motherPodMax). */
export const MOTHER_NET_MAGAZINE_FULL =
  Constants.CAPTURE_NET.MOTHER_POD_COUNT * Constants.CAPTURE_NET.LARGE.MAGAZINE_SIZE;

// ── Adapter plumbing ────────────────────────────────────────────────────────

/**
 * Wrap an adapter body so it NEVER throws on missing/partial deps (headless
 * safety): absent getter → undefined; NaN (e.g. a ratio over an absent base)
 * → undefined. The RefitPane treats undefined as "show the static base".
 * @param {(deps: object) => *} fn
 * @returns {(deps?: object) => *}
 */
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
 * First arm of the fleet as the fleet representative. Fleet-wide shop effects
 * apply to EVERY arm (ArmManager.applyUpgrade loops all arms and re-applies
 * after reset via _storedUpgrades), so arms are uniform in these config fields
 * and arms[0] is an honest read.
 */
const firstArm = (deps) => deps.armManager?.arms?.[0];

/** Per-type arm base for a config field (weaver vs spinner Constants pair). */
const armTypeBase = (arm, weaverKey, spinnerKey) =>
  (arm?.type === 'spinner' ? Constants[spinnerKey] : Constants[weaverKey]);

/** Ownership check for RUNTIME-routed effects (GameFlowManager._hasUpgrade
 *  shape). Injected as a plain function `hasUpgrade(id) → boolean`. */
const owned = (deps, id) =>
  (typeof deps.hasUpgrade === 'function' ? !!deps.hasUpgrade(id) : undefined);

// ── Route target → the injected dep an adapter may read for that effect ────
// (Mirrors GameFlowManager.applyUpgradeEffect's dispatch table, which is
// itself pinned by test-shop-effects. ARM_MANAGER_EVENT lands on the same
// ArmManager instance via its own UPGRADE_PURCHASED listener.)
export const ROUTE_READS = Object.freeze({
  resourceSystem: 'resourceSystem',
  player: 'player',
  armManager: 'armManager',
  armManagerEvent: 'armManager',
  sensorEvent: 'sensorSystem',
  kesslerSystem: 'kesslerSystem',
  captureNet: 'captureNetSystem',
  cargoSystem: 'cargoSystem',
  runtime: 'hasUpgrade',
});

// ── Per-upgrade fitting specs ───────────────────────────────────────────────
// Keyed by ShopScreen upgrade id. `display(row)` derives { param, base, unit,
// op } from the row's live `value` + Constants/SENSOR_TIERS (op grammar:
// '×N' multiply, '+N' add, '=N' absolute set, 'ON' enable). `current(deps,
// row)` reads the live param. `reads` names the injected dep consumed —
// checked against EFFECT_ROUTES by the coverage test.
//
// Subsystem tag law (D9): tag by what the upgrade PHYSICALLY changes.
// Borderline calls are commented at the row.
const FITTING_SPECS = {
  // ════ ENGINEERING — the thruster block / bus structure (7) ════
  efficient_ion: {
    subsystem: 'ENGINEERING', reads: 'player',
    // PlayerSatellite: _ionThrustXenonRate = base × value. The base rate is a
    // PlayerSatellite constructor literal (no Constants key), so the display
    // param is the consumption MULTIPLIER (nominal 1) and the adapter reads
    // the live/base ratio — exact and SSOT-safe.
    display: (row) => ({ param: 'ionXenonRateMult', base: 1, unit: '×', op: `×${row.value}` }),
    current: (deps) => deps.player?._ionThrustXenonRate / deps.player?._baseIonXenonRate,
  },
  high_thrust_ion: {
    subsystem: 'ENGINEERING', reads: 'player',
    display: (row) => ({ param: 'ionThrustMult', base: 1, unit: '×', op: `×${row.value}` }),
    current: (deps) => deps.player?._thrustMult,
  },
  extra_xenon: {
    subsystem: 'ENGINEERING', reads: 'resourceSystem',
    display: (row) => ({ param: 'xenonMax', base: Constants.XENON_FUEL_MAX, unit: 'kg', op: `+${row.value}` }),
    current: (deps) => deps.resourceSystem?.xenonMax,
  },
  extra_coldgas: {
    subsystem: 'ENGINEERING', reads: 'resourceSystem',
    display: (row) => ({ param: 'coldGasMax', base: Constants.COLD_GAS_MAX, unit: 'kg', op: `+${row.value}` }),
    current: (deps) => deps.resourceSystem?.coldGasMax,
  },
  mpd_thruster: {
    subsystem: 'ENGINEERING', reads: 'player',
    // Catalog value is `true`; the REAL magnitude the handler applies is
    // Constants.MPD_PASSIVE_THRUST_MULT (PlayerSatellite.js:5221) — derived,
    // not copied.
    display: () => ({ param: 'mpdPassiveMult', base: 1, unit: '×', op: `×${Constants.MPD_PASSIVE_THRUST_MULT}` }),
    current: (deps) => deps.player?._mpdPassiveMult,
  },
  hardened_cathode: {
    subsystem: 'ENGINEERING', reads: 'player',
    display: (row) => ({ param: 'mpdCathodeLife', base: Constants.MPD_CATHODE_LIFE, unit: 's', op: `=${row.value}` }),
    current: (deps) => deps.player?._mpdCathodeLife,
  },
  whipple_shield: {
    // BORDERLINE: shop cat "Hull". A Whipple bumper physically wraps the bus
    // structure — that is ENGINEERING territory. NOT THERMAL: Q3 pins THERMAL
    // as "only the flower pairs", and the MLI band merely hosts the callout.
    subsystem: 'ENGINEERING', reads: 'kesslerSystem',
    display: (row) => ({ param: 'shieldHits', base: 0, unit: 'hits', op: `+${row.value}` }),
    current: (deps) => deps.kesslerSystem?.shieldHits,
  },

  // ════ POWER — arrays, storage, generation (8) ════
  efficient_panels: {
    subsystem: 'POWER', reads: 'resourceSystem',
    // ResourceSystem: solarRate = EFF × value × FLUX × AREA — ×value on the
    // SOLAR_BASE_W product (the 08-workbench §3 card: base → ×1.3).
    display: (row) => ({ param: 'solarOutput', base: SOLAR_BASE_W, unit: 'W', op: `×${row.value}` }),
    current: (deps) => deps.resourceSystem?.solarRate,
  },
  multi_junction_solar: {
    subsystem: 'POWER', reads: 'resourceSystem',
    // Same param as efficient_panels; the handler recomputes from base (last
    // write wins, no compounding) — ×2.0 OF BASE, said honestly by the op.
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
    // Two-leg route (RESOURCE_SYSTEM + PLAYER): the number that matters is the
    // +100 Wh burst store; the PLAYER leg (MPD cooling flag) is a side note
    // for the card copy, not the display param.
    display: (row) => ({ param: 'batteryMax', base: Constants.BATTERY_MAX, unit: 'Wh', op: `+${row.value}` }),
    current: (deps) => deps.resourceSystem?.batteryMax,
  },
  rtg_module: {
    subsystem: 'POWER', reads: 'resourceSystem',
    display: (row) => ({ param: 'rtgRate', base: 0, unit: 'Wh/s', op: `=${row.value}` }),
    current: (deps) => deps.resourceSystem?.getStatus?.().rtgRate,
  },
  power_beaming: {
    // BORDERLINE: a rectenna is antenna-shaped (COMMS?) but what it changes is
    // the POWER budget (+5 Wh/s on ground pass) — and Q3 expects COMMS empty.
    subsystem: 'POWER', reads: 'resourceSystem',
    display: (row) => ({ param: 'powerBeamRate', base: 0, unit: 'Wh/s', op: `=${row.value}` }),
    current: (deps) => deps.resourceSystem?.getStatus?.().powerBeamRate,
  },
  rad_hard_panels: {
    subsystem: 'POWER', reads: 'resourceSystem',
    // Handler assigns the degradation multiplier absolutely (value 0.5); with
    // nominal base 1 and maxLevel 1 that IS ×0.5 on the degradation rate.
    display: (row) => ({ param: 'panelDegradationMult', base: 1, unit: '×', op: `×${row.value}` }),
    current: (deps) => deps.resourceSystem?.panelDegradationMultiplier,
  },

  // ════ SENSORS — the SensorDeck (5) ════
  enhanced_eo: {
    subsystem: 'SENSORS', reads: 'sensorSystem',
    // SensorSystem.range is scene units; display in km via the derived scale
    // (SENSOR_TIERS.basic.rangeKm is the same SSOT pair).
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
    // BORDERLINE: shop cat "Automation"; the warnings LAND in comms, but what
    // the player buys is situational AWARENESS (onboard cascade analysis —
    // LeoLabs-class SSA). That is a sensing capability → SENSORS. Q3 expects
    // COMMS to have nothing to buy.
    subsystem: 'SENSORS', reads: 'kesslerSystem',
    display: () => ({ param: 'cascadeWarnings', base: false, unit: 'flag', op: 'ON' }),
    current: (deps) => deps.kesslerSystem && !!deps.kesslerSystem._warningsEnabled,
  },

  // ════ BERTHS — daughter docks, reels, nets, arm tooling (9, D9: "arms,
  // nets ... included") ════
  fast_reel: {
    subsystem: 'BERTHS', reads: 'armManager',
    // ArmUnit: approachSpeed = ARM_APPROACH_SPEED × value (haulSpeed likewise)
    // — display the multiplier, read it back as live/base.
    display: (row) => ({ param: 'reelSpeedMult', base: 1, unit: '×', op: `×${row.value}` }),
    current: (deps) => firstArm(deps)?.config?.approachSpeed / Constants.ARM_APPROACH_SPEED,
  },
  arm_fuel: {
    subsystem: 'BERTHS', reads: 'armManager',
    // ArmUnit scales capturesPerFuel from the per-type base (weaver 33 /
    // spinner 37) — the multiplier is the honest fleet-wide number.
    display: (row) => ({ param: 'armFuelMult', base: 1, unit: '×', op: `×${row.value}` }),
    current: (deps) => {
      const arm = firstArm(deps);
      return arm?.config?.capturesPerFuel
        / armTypeBase(arm, 'WEAVER_CAPTURES_PER_FUEL', 'SPINNER_CAPTURES_PER_FUEL');
    },
  },
  capture_net: {
    subsystem: 'BERTHS', reads: 'armManager',
    // ArmUnit: captureSuccessRate = min(1, 0.85 + value); the 0.85 base is
    // Constants.ARM_CAPTURE_SUCCESS_RATE (same number the arm config seeds).
    display: (row) => ({ param: 'captureSuccess', base: Constants.ARM_CAPTURE_SUCCESS_RATE, unit: 'prob', op: `+${row.value}` }),
    current: (deps) => firstArm(deps)?.config?.captureSuccessRate,
  },
  mother_net_restock: {
    // BORDERLINE: the Large-Net pods ride the Mother hull, but D9 groups nets
    // with the berth/reel cartridges ("arms, nets ... included") → BERTHS.
    subsystem: 'BERTHS', reads: 'captureNetSystem',
    display: (row) => ({ param: 'motherNets', base: MOTHER_NET_MAGAZINE_FULL, unit: 'nets', op: `+${row.value}` }),
    current: (deps) => deps.captureNetSystem?.getMotherNetCount?.(),
  },
  hazmat_handler: {
    subsystem: 'BERTHS', reads: 'hasUpgrade',
    // RUNTIME route: no apply-time mutation; the live value IS ownership
    // (GameFlowManager.js:973 checks _hasUpgrade at salvage time).
    display: () => ({ param: 'hazmatRecovery', base: false, unit: 'flag', op: 'ON' }),
    current: (deps) => owned(deps, 'hazmat_handler'),
  },
  refinery_arm: {
    subsystem: 'BERTHS', reads: 'hasUpgrade',
    // RUNTIME route: GameFlowManager.js:925 applies `owned ? value : 1` at
    // salvage time — the adapter mirrors exactly that, deriving from row.value.
    display: (row) => ({ param: 'salvageYieldMult', base: 1, unit: '×', op: `×${row.value}` }),
    current: (deps, row) => {
      const has = owned(deps, 'refinery_arm');
      return has === undefined ? undefined : (has ? row.value : 1);
    },
  },
  auto_dock: {
    // BORDERLINE: shop cat "Hull", but the handler speeds daughter DOCKING
    // (ArmUnit dockSpeedMultiplier) — that hardware lives at the berths.
    subsystem: 'BERTHS', reads: 'armManager',
    // ArmUnit: dockSpeedMultiplier = 1 / value (0.5 → ×2 faster) — derive the
    // player-facing ×2 from the row value, never a literal.
    display: (row) => ({ param: 'dockSpeedMult', base: 1, unit: '×', op: `×${1 / row.value}` }),
    current: (deps) => firstArm(deps)?.config?.dockSpeedMultiplier,
  },
  gsl_net_v4: {
    subsystem: 'BERTHS', reads: 'armManager',
    // Row value is √(area mult) (linear net size); the number that matters is
    // the AREA multiplier — Constants.V4_NET_SIZE_MULT, the same SSOT the
    // catalog row derives its value from. Adapter squares the live linear
    // ratio back into area.
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

  // ════ CARGO — the hold (2) ════
  cargo_bay_2: {
    subsystem: 'CARGO', reads: 'cargoSystem',
    // CargoSystem assigns the ABSOLUTE target (row.value IS
    // Constants.CARGO_BAY_TIER2_KG) — op '=' by the handler's algebra.
    display: (row) => ({ param: 'cargoCapacity', base: Constants.CARGO_CAPACITY_KG, unit: 'kg', op: `=${row.value}` }),
    current: (deps) => deps.cargoSystem?.getStatus?.().capacityKg,
  },
  cargo_bay_3: {
    subsystem: 'CARGO', reads: 'cargoSystem',
    display: (row) => ({ param: 'cargoCapacity', base: Constants.CARGO_CAPACITY_KG, unit: 'kg', op: `=${row.value}` }),
    current: (deps) => deps.cargoSystem?.getStatus?.().capacityKg,
  },

  // ════ THERMAL — the aft flower (2; Q3: THERMAL is only the flower pairs) ════
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

// ── The catalog ─────────────────────────────────────────────────────────────

/**
 * Build one fitting entry from a ShopScreen row + its spec. A row with no
 * spec builds a DEGENERATE entry (subsystem null, display null, adapter →
 * undefined) rather than throwing — the game must never crash on catalog
 * drift; the coverage test is what trips (loudly) instead.
 * @param {object} row — a ShopScreen UPGRADES row (read-only; never mutated)
 * @returns {object} fitting entry
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
    /** ShopScreen upgrade id (join key). */
    id: row.id,
    /** The live ShopScreen row (name/cost/desc/trl…) — a REFERENCE, no copy. */
    shop: row,
    /** The effect string, for route joins. */
    effect: row.effect,
    /** One of SUBSYSTEMS — the D9 hull callout this item refits. */
    subsystem: spec.subsystem,
    /** { param, base, unit, op } — derived display semantics. */
    display: Object.freeze(spec.display(row)),
    /** EFFECT_ROUTES targets for this effect (SSOT reference, not a copy). */
    routes: EFFECT_ROUTES[row.effect] || [],
    /** Injected-dep name the adapter reads (test-checked against routes). */
    reads: spec.reads,
    /** Live-value adapter: (deps) → number|boolean|undefined. Never throws. */
    current: safeAdapter((deps) => spec.current(deps, row)),
  });
}

/**
 * One entry per ShopScreen UPGRADES row, same order (33 — the coverage test
 * pins the count so a catalog edit without fitting metadata trips loudly).
 * @type {ReadonlyArray<object>}
 */
export const FITTING_CATALOG = Object.freeze(UPGRADES.map(buildEntry));

/** Spec keys with no catalog row would be silent dead weight — exported so the
 *  coverage test can assert there are none (the F4 stale-key guard mirrored). */
export const FITTING_SPEC_IDS = Object.freeze(Object.keys(FITTING_SPECS));

/**
 * Group the catalog by subsystem for the RefitPane. ALWAYS returns all seven
 * keys (Q3 graceful): an empty array means "nothing to refit yet", never a
 * missing group.
 * @param {ReadonlyArray<object>} [catalog] — defaults to FITTING_CATALOG
 * @returns {Object<string, object[]>} subsystem → entries (catalog order)
 */
export function groupBySubsystem(catalog = FITTING_CATALOG) {
  const groups = {};
  for (const s of SUBSYSTEMS) groups[s] = [];
  for (const entry of catalog) {
    if (groups[entry.subsystem]) groups[entry.subsystem].push(entry);
  }
  return groups;
}

/**
 * Look up one fitting entry by upgrade id.
 * @param {string} id — ShopScreen upgrade id
 * @returns {object|undefined}
 */
export function getFittingEntry(id) {
  return FITTING_CATALOG.find((e) => e.id === id);
}
