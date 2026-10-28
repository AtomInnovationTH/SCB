/**
 * ShopScreen.js — Upgrade shop between missions + cargo selling + elevator contract
 * @module ui/ShopScreen
 */

import { Constants, trlToBadgeColor, trlToTechLevelLabel, techLevelBadgeText } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { GameStates } from '../core/GameState.js';
import { audioSystem } from '../systems/AudioSystem.js';
import { scoringSystem, computeContributionPayout } from '../systems/ScoringSystem.js';
import { decorateGlossary } from '../systems/codex/glossary.js';
import { ensureGlossaryCss, delegateGlossaryClicks } from './glossaryDom.js';
import { captureNetSystem } from '../entities/CaptureNet.js';
import { DAUGHTER_NET_EFFECT_TYPE } from '../systems/upgradeEffectRoutes.js';
import { depotWords, shopTitle } from '../systems/resupplyWords.js';   // lane 3d: the depot words read the map switch
import { upgradePrereqsMet, upgradeCostNow, engineTankFull, consumableFull as noRoomFor } from './shopGating.js';
import { gasPriceCr, coldGasPriceCr, coldGasPoolToKg, indiumCartridgePriceCr, GAS_SWITCH_FILL_KG } from '../systems/ResourceSystem.js';

/**
 * Upgrade definitions — 42 items across 9 categories, all wired to live systems
 * (UPGRADES.length / distinct `cat` values are the SSOT; test-shop-cadence pins
 * this header to them).
 * ST-6.6: Each upgrade carries a `trl` (NASA TRL 1-9) and optional `trlRationale`
 * for colour-coded badge display. TRL is display-only — NEVER used in gating.
 * Exported for Node.js test harness (test-TRL.js integrity check).
 */
export const UPGRADES = [
  // Propulsion (10)
  { id: 'efficient_ion', cat: 'Propulsion', name: 'Efficient Ion Drive', cost: 500,
    desc: '-20% engine gas consumption', effect: 'xenonEfficiency', value: 0.8, maxLevel: 1,
    trl: 9, trlRationale: 'Xenon ion drives flown since Deep Space 1 (1998)' },
  { id: 'high_thrust_ion', cat: 'Propulsion', name: 'High-Thrust Ion', cost: 800,
    desc: '+50% thrust power', effect: 'thrustMultiplier', value: 1.5, maxLevel: 1,
    trl: 8, trlRationale: 'High-power Hall thrusters flown on Starlink, AEHF; kW-class ion still maturing' },
  // g1-gas-upgrades D6: id and effect kept (saves); a bigger tank is SPACE — fill it with a resupply.
  { id: 'extra_xenon', cat: 'Propulsion', name: 'Bigger Engine Tank', cost: 600,
    desc: '+30 L of engine tank space (empty: fill it with a resupply)', effect: 'xenonMax', value: 50, maxLevel: 2,
    trl: 9, trlRationale: 'COPV xenon tanks flight-proven since 1990s' },
  // g1-gas-upgrades D3: krypton and xenon are one-way upgrades of the gas in the tank, priced by the mass
  // they put in orbit (D1). Xenon replaces krypton for good (supersededBy, enforced in upgradePrereqsMet).
  { id: 'gas_krypton', cat: 'Propulsion', name: 'Krypton Engine Gas', cost: gasPriceCr('krypton', GAS_SWITCH_FILL_KG),
    desc: "1.5× argon's push on the same power, so chases are quicker. Drains the tank and fills 12.5 kg of krypton — the same launch mass as your argon start.",
    effect: 'engineGasSwitch', value: 'krypton', maxLevel: 1, supersededBy: 'gas_xenon',
    trl: 9, trlRationale: 'Krypton Hall thrusters fly on Starlink v1 (2019)' },
  { id: 'gas_xenon', cat: 'Propulsion', name: 'Xenon Engine Gas', cost: gasPriceCr('xenon', GAS_SWITCH_FILL_KG),
    desc: "2.2× argon's push on the same power, so chases are quicker. Drains the tank and fills 12.5 kg of xenon — the same launch mass as your argon start.",
    effect: 'engineGasSwitch', value: 'xenon', maxLevel: 1,
    trl: 9, trlRationale: 'Xenon Hall thrusters flown since the 1970s; Deep Space 1 (1998)' },
  // g1-gas-upgrades D4: range is bought by the kilo. Repeatable; the price is read through upgradeCostNow
  // (the gas in the tank), `cost` here is the argon price for the catalogue tables.
  { id: 'gas_resupply', cat: 'Propulsion', name: 'Engine Gas Resupply', cost: gasPriceCr('argon', Constants.GAS_RESUPPLY_KG),
    desc: 'Load 5 kg of the gas in your tank (less if the tank is nearly full). Every kilo has to be launched, so range costs credits.',
    effect: 'engineGasResupply', value: Constants.GAS_RESUPPLY_KG, maxLevel: Infinity, consumable: true,
    trl: 6, trlRationale: 'In-orbit propellant transfer demonstrated by Orbital Express (2007, hydrazine); xenon transfer not yet flown' },
  // Nets step 3 lane 3f (owner 2026-10-23, "Cold gas and ion fuel"): nitrogen for her cold-gas tank, by the kilo like the engine gas
  // (price through upgradeCostNow: the room in the tank, launch mass + nitrogen's own commodity price). The tank tops up docked daughters.
  { id: 'coldgas_resupply', cat: 'Propulsion', name: 'Nitrogen Cold Gas', cost: coldGasPriceCr(Constants.DAUGHTER_SUPPLY.N2_BUY_KG),
    desc: 'Load 5 kg of nitrogen into your cold-gas tank (less if it is nearly full). Docked daughters fill their braking gas from it. Every kilo has to be launched, so it costs credits.',
    effect: 'coldGasResupply', value: Constants.DAUGHTER_SUPPLY.N2_BUY_KG, maxLevel: Infinity, consumable: true,
    trl: 6, trlRationale: 'In-orbit propellant transfer demonstrated by Orbital Express (2007, hydrazine); nitrogen servicing not yet flown' },
  { id: 'extra_coldgas', cat: 'Propulsion', name: 'Extra Cold Gas', cost: 400,
    // fu-gas GD2: the tank is pool units (20 = 6 kg); the card says real kg (+10 units = +3 kg)
    desc: `+${coldGasPoolToKg(10)} kg max cold gas`, effect: 'coldGasMax', value: 10, maxLevel: 2,
    trl: 9, trlRationale: 'Cold gas tanks ubiquitous since 1960s' },
  // Reaction-wheel kit (owner 2026-10-24, DECISIONS §2 row 9): three RW4-class wheels, magnetic coils that slow them, the electronics.
  // The numbers are Constants.WHEELS (the card says them out loud: mass, what the wheels do, what they do not).
  { id: 'reaction_wheels', cat: 'Propulsion', name: 'Reaction Wheels (3)', cost: Constants.WHEELS.PRICE_CR,
    desc: `Three spinning wheels, one per axis (${Constants.WHEELS.MASS_KG.toFixed(1)} kg with coils and electronics). They turn her for battery power, no steering gas, but each holds only ${Constants.WHEELS.MOMENTUM_NMS} N·m·s and gives ${Constants.WHEELS.TORQUE_NM} N·m, so a big turn takes minutes: quick turns and big turns stay on the gas. Magnetic coils slow a full wheel in about 4 hours of game time.`,
    effect: 'wheelKit', value: 1, maxLevel: 1,
    trl: 9, trlRationale: 'Reaction wheels flown on thousands of satellites since the 1960s (RW4-class small-satellite wheels, magnetorquer momentum dumping)' },
  { id: 'mpd_thruster', cat: 'Propulsion', name: 'MPD Thruster', cost: 3000,
    desc: 'Magnetoplasmadynamic drive. Runs passively alongside the ion engine for +50% primary thrust — cuts long transfer burns like the GEO climb. Draws on lithium reserves and heavy power.',
    effect: 'mpdThruster', value: true, maxLevel: 1,
    requiresAll: ['solid_state_battery', 'multi_junction_solar'],
    trl: 4, trlRationale: 'Lab-tested at NASA Glenn & JAXA; no kW-class flight heritage' },
  { id: 'hardened_cathode', cat: 'Propulsion', name: 'Hardened Cathode', cost: 1500,
    desc: 'Tungsten-rhenium cathode. Doubles MPD thruster lifetime to 1,200s.',
    effect: 'mpdCathodeLife', value: 1200, maxLevel: 1,
    requiresAll: ['mpd_thruster'],
    trl: 5, trlRationale: 'Tungsten-rhenium cathodes tested in vacuum chambers; on-orbit erosion unverified' },

  // Power (8) — includes S3b MPD infrastructure chain
  { id: 'efficient_panels', cat: 'Power', name: 'Efficient Panels', cost: 500,
    desc: '+30% solar efficiency', effect: 'solarEfficiency', value: 1.3, maxLevel: 1,
    trl: 9, trlRationale: 'Triple-junction GaAs standard on every modern satellite' },
  { id: 'extra_battery', cat: 'Power', name: 'Extra Battery', cost: 400,
    desc: '+50 max battery', effect: 'batteryMax', value: 50, maxLevel: 2,
    trl: 9, trlRationale: 'Space-grade Li-ion flown since 1990s' },
  { id: 'rad_hard_panels', cat: 'Power', name: 'Rad-Hard Panels', cost: 700,
    desc: '-50% panel degradation', effect: 'panelDegradation', value: 0.5, maxLevel: 1,
    trl: 9, trlRationale: 'Rad-hard cover glass + coverslips used on GEO sats for decades' },

  // S3b: Power infrastructure chain for MPD Ludicrous Mode
  { id: 'multi_junction_solar', cat: 'Power', name: 'Multi-Junction Solar', cost: 1200,
    desc: 'GaInP/GaAs/Ge triple-junction. +100% solar efficiency.',
    effect: 'solarEfficiency', value: 2.0, maxLevel: 1,
    requiresAll: ['efficient_panels'],
    trl: 9, trlRationale: 'Triple-junction GaAs on every GEO satellite and Mars rover' },
  { id: 'solid_state_battery', cat: 'Power', name: 'Solid-State Battery', cost: 1500,
    desc: 'Ceramic electrolyte. +150 Wh capacity. No fire risk.',
    effect: 'batteryMax', value: 150, maxLevel: 1,
    requiresAll: ['extra_battery'],
    trl: 5, trlRationale: 'QuantumScape & Toyota prototypes emerging; not yet space-qualified' },
  { id: 'graphene_supercap', cat: 'Power', name: 'Graphene Supercapacitor', cost: 2500,
    desc: 'HBN-dielectric graphene. +100 Wh burst. Faster MPD cooling.',
    effect: 'supercapUpgrade', value: 100, maxLevel: 1,
    requiresAll: ['solid_state_battery'],
    trl: 3, trlRationale: 'Graphene-HBN supercaps demonstrated in lab; no flight heritage' },
  { id: 'rtg_module', cat: 'Power', name: 'RTG Module', cost: 3500,
    desc: 'Pu-238 radioisotope. +2 kW constant. Even in eclipse.',
    effect: 'rtgPower', value: 2.0, maxLevel: 1,
    requiresAll: ['multi_junction_solar'],
    trl: 9, trlRationale: 'RTGs flown since SNAP-3 (1961); MMRTG on Curiosity, Perseverance' },
  { id: 'power_beaming', cat: 'Power', name: 'Power Beaming Receiver', cost: 2000,
    desc: 'Rectenna array. +5 kW during ground station passes.',
    effect: 'powerBeaming', value: 5.0, maxLevel: 1,
    requiresAll: ['multi_junction_solar'],
    trl: 5, trlRationale: 'JAXA (2015) demonstrated 1.8 kW over 55 m ground-to-ground; no orbital link yet' },

  // Sensors (4)
  { id: 'enhanced_eo', cat: 'Sensors', name: 'Enhanced EO', cost: 500,
    desc: '+50% detection range', effect: 'sensorRange', value: 1.5, maxLevel: 1,
    trl: 9, trlRationale: 'Electro-optical telescopes flown on every imaging sat' },
  { id: 'ir_scanner', cat: 'Sensors', name: 'IR Scanner', cost: 600,
    desc: 'Detect untracked debris', effect: 'detectUntracked', value: true, maxLevel: 1,
    trl: 8, trlRationale: 'IR debris tracking (SBV, WISE) demonstrated; ADR-specific arrays still maturing' },
  { id: 'advanced_lidar', cat: 'Sensors', name: 'Advanced LIDAR', cost: 800,
    desc: '+100% scan range', effect: 'scanRange', value: 2.0, maxLevel: 1,
    trl: 9, trlRationale: 'Flash LIDAR flown on Dragon, Cygnus since 2012' },
  { id: 'salvage_scanner', cat: 'Sensors', name: 'Salvage Scanner', cost: 700,
    desc: 'Reveal salvage contents at range', effect: 'salvageScan', value: true, maxLevel: 1,
    trl: 4, trlRationale: 'Remote spectral composition analysis demonstrated on lab targets; no ADR heritage' },

  // Arms (5) — replaces deleted Capture category (laser, ion beam, magnetic, harpoon, net)
  // Register item 101 (2026-08-21, owner-ruled RETIRE): `long_tether` (600 cr,
  // effect 'tetherRange' ×2) retired from the catalog — it wrote the same live
  // config.tetherMax field the tier ladder now owns, last-writer-wins (a tier
  // purchase after it LOST the player the 600 cr reach with no warning). The
  // TETHER MATERIALS ladder below is the one tether-reach track; the
  // applyUpgradeOverride handler + EFFECT_ROUTES entry STAY so a pre-retirement
  // save's upgrade replay keeps its purchased reach.
  { id: 'fast_reel', cat: 'Daughters', name: 'Fast Reel Motor', cost: 500,
    desc: '+50% reel speed', effect: 'reelSpeed', value: 1.5, maxLevel: 1,
    trl: 4, trlRationale: 'Motorised space reels demonstrated on SFU (1995), not yet for capture ops' },
  { id: 'arm_fuel', cat: 'Daughters', name: 'Daughter Fuel Reserve', cost: 700,
    desc: '+50% daughter FEEP fuel', effect: 'armFuelMax', value: 1.5, maxLevel: 1,
    trl: 7, trlRationale: 'FEEP thrusters flown on Gaia, LISA Pathfinder; miniaturised variants emerging' },
  { id: 'capture_net', cat: 'Daughters', name: 'Reinforced Nets', cost: 800,
    desc: '+20% capture success', effect: 'captureRate', value: 0.2, maxLevel: 1,
    trl: 7, trlRationale: 'RemoveDEBRIS net capture demonstrated 2018' },
  // Net ladder Phase B: consumable Mother Large Net restock. Repeatable (no
  // maxLevel gate — see _purchaseUpgrade consumable branch). Each buy loads one
  // net (250 cr) into the Mother's one launcher, up to 4 - her one count, for every
  // piece she nets (DECISIONS §33). No in-mission resupply. Gated by CAPTURE_NET (filtered at render).
  { id: 'mother_net_restock', cat: 'Daughters', name: 'Mother net',
    cost: Constants.CAPTURE_NET.LARGE.REPLACEMENT_COST,
    desc: 'One net cartridge for the mother\'s launcher.',
    effect: 'motherNetRestock', value: 1, maxLevel: Infinity, consumable: true,
    requiresFeature: 'CAPTURE_NET',
    trl: 7, trlRationale: 'RemoveDEBRIS net capture demonstrated 2018' },
  // DECISIONS §33 rows 2 and 5: a daughter's nets refill ONLY by buying here, one at a time. Each buy loads one net
  // into the first docked daughter of that size with room (ArmManager.addDaughterNet); refused when none has room.
  { id: 'large_daughter_net', cat: 'Daughters', name: 'Large daughter net',
    cost: Constants.CAPTURE_NET.MEDIUM.REPLACEMENT_COST,
    desc: 'Load one net into a docked large daughter.',
    effect: 'largeDaughterNet', value: 1, maxLevel: Infinity, consumable: true,
    requiresFeature: 'CAPTURE_NET',
    trl: 7, trlRationale: 'RemoveDEBRIS net capture demonstrated 2018' },
  { id: 'small_daughter_net', cat: 'Daughters', name: 'Small daughter net',
    cost: Constants.CAPTURE_NET.SMALL.REPLACEMENT_COST,
    desc: 'Load one net into a docked small daughter.',
    effect: 'smallDaughterNet', value: 1, maxLevel: Infinity, consumable: true,
    requiresFeature: 'CAPTURE_NET',
    trl: 7, trlRationale: 'RemoveDEBRIS net capture demonstrated 2018' },
  // Nets step 3 lane 3f (owner 2026-10-23, "Cold gas and ion fuel"; DECISIONS §4: ion fuel is cast indium, a cartridge, never a fluid):
  // one cartridge into the mother's indium store (a whole cartridge or none), the satellite's arm hands it over. A docked daughter
  // swaps it for her tank (ArmUnit._updateIndiumSwap). Price: launch mass plus indium's own price (indiumCartridgePriceCr).
  { id: 'indium_cartridge', cat: 'Daughters', name: 'Ion-fuel cartridge', cost: indiumCartridgePriceCr(),
    desc: `One cast-indium cartridge (${Math.round(Constants.DAUGHTER_SUPPLY.INDIUM_CARTRIDGE_KG * 1000)} g, a large daughter's full tank) for the daughters' ion thrusters. It goes into your indium store; a docked daughter swaps it in for her tank in about ${Constants.DAUGHTER_SUPPLY.SWAP_GAME_S} s. Salvaged indium goes to the same store.`,
    effect: 'indiumCartridge', value: Constants.DAUGHTER_SUPPLY.INDIUM_CARTRIDGE_KG, maxLevel: Infinity, consumable: true,
    trl: 5, trlRationale: 'Indium FEEP thrusters flew on Gaia and LISA Pathfinder; handing cartridges over in orbit is not yet demonstrated' },
  // Nets step 3 slice 5 (lane 5a, V6; DECISIONS §33 row 16): a drag sail for letting a big piece go lower. A count in her stock (ResourceSystem.dragSails),
  // its mass is part of her live mass; bought at the resupply satellite like a net (the trade gate is the same). Used by lane 5d.
  { id: 'drag_sail', cat: 'Daughters', name: `Drag sail, ${Constants.BIG_PIECES.SAIL.areaM2} m\u00B2, ${Constants.BIG_PIECES.SAIL.massKg} kg`,
    cost: Constants.BIG_PIECES.SAIL.priceCr,
    desc: `One folded drag sail (${Constants.BIG_PIECES.SAIL.areaM2} m\u00B2, ${Constants.BIG_PIECES.SAIL.massKg} kg; HPS ADEO-L class). Lets a big piece go to come down by itself. Its mass counts in yours.`,
    effect: 'dragSail', value: 1, maxLevel: Infinity, consumable: true,
    requiresFeature: 'FIELDS_BY_HEIGHT',
    trl: 6, trlRationale: 'Drag sails have flown on small satellites, and HPS sells the 25 m\u00B2-class ADEO-L; fitting one to a derelict in orbit is not yet demonstrated' },
  { id: 'hazmat_handler', cat: 'Daughters', name: 'Hazmat Handler', cost: 1200,
    desc: 'Recover hydrazine → cold gas', effect: 'hazmatRecovery', value: true, maxLevel: 1,
    trl: 2, trlRationale: 'On-orbit hazmat recovery from derelicts is fully speculative' },
  { id: 'refinery_arm', cat: 'Daughters', name: 'Micro-Refinery', cost: 1500,
    desc: '+50% salvage yield', effect: 'refineryEfficiency', value: 1.5, maxLevel: 1,
    trl: 2, trlRationale: 'Orbital micro-refinery is game-speculative; no on-orbit metal processing' },

  // Automation (1)
  { id: 'kessler_warning', cat: 'Automation', name: 'Kessler Warning', cost: 500,
    desc: 'Brittleness warnings', effect: 'kesslerWarning', value: true, maxLevel: 1,
    trl: 7, trlRationale: 'LeoLabs, ExoAnalytic provide real collision-risk alerts; onboard analysis still maturing' },

  // Hull (2) — replaces deleted GNC automation items
  { id: 'whipple_shield', cat: 'Hull', name: 'Whipple Shield', cost: 1000,
    desc: 'Survive 1 fragment hit', effect: 'shieldHits', value: 1, maxLevel: 1,
    trl: 9, trlRationale: 'Whipple shields flown on ISS and every crewed spacecraft since 1970s' },
  { id: 'auto_dock', cat: 'Hull', name: 'Auto-Dock Assist', cost: 600,
    desc: 'Faster daughter docking', effect: 'autoDock', value: 0.5, maxLevel: 1,
    trl: 8, trlRationale: 'Auto-docking flown on Progress, Dragon-2; ADR-specific autonomy still emerging' },

  // Graphene (2) — V4 GSL upgrade path (Sprint D5)
  // Register item 101 (2026-08-21, owner-ruled RETIRE): `gsl_tether_v4`
  // (3000 cr, effect 'v4TetherRange' ×6.25 → 12.5 km) retired from the catalog
  // — the 3000 cr card out-reached the 61 500 cr ladder top (T5 GSL-100, 10 km)
  // and any later tier purchase LOWERED reach 12.5 → the tier's maxLength with
  // no warning (last-writer-wins on config.tetherMax, measured in
  // tmp/i101-tether-overlap.mjs). The ladder's T5 GSL-100 (10 km, 800 N break)
  // is the doctrine ceiling; the handler + route STAY for owned saves.
  { id: 'gsl_net_v4', cat: 'Graphene', name: 'GSL Net v4', cost: 3500,
    desc: '10× capture net area', effect: 'v4NetArea',
    value: Math.sqrt(Constants.V4_NET_SIZE_MULT), maxLevel: 1,
    trl: 2, trlRationale: 'Graphene-reinforced capture net. Speculative; no space heritage' },
  { id: 'gsl_electrostatic_v4', cat: 'Graphene', name: 'GSL Electrostatic v4', cost: 4000,
    desc: '160N electrostatic grip. 5× capture mass', effect: 'v4GripForce',
    value: 5.0, maxLevel: 1,
    trl: 3, trlRationale: 'Electrostatic capture demonstrated on CubeSats; 160N force is game-speculative' },

  // Cargo (2) — E2 elevator-throughput fix. The hold caps how much refined
  // salvage each depot run can deliver to the space-elevator contract. Absolute
  // capacity targets live in Constants (SSOT); the effect value is the target kg.
  // Prices are a Phase-4 balance concern (tuned against catalog total).
  { id: 'cargo_bay_2', cat: 'Cargo', name: 'Cargo Bay II', cost: 1800,
    desc: 'Expanded hold: +1,000 kg (500 → 1,500). More salvage per depot run.',
    effect: 'cargoCapacity', value: Constants.CARGO_BAY_TIER2_KG, maxLevel: 1,
    trl: 6, trlRationale: 'Deployable/expandable cargo modules (BEAM, Cygnus) have flight heritage' },
  { id: 'cargo_bay_3', cat: 'Cargo', name: 'Cargo Bay III', cost: 3600,
    desc: 'Whale-class hold: +1,500 kg (1,500 → 3,000). Sized for rocket-body salvage.',
    effect: 'cargoCapacity', value: Constants.CARGO_BAY_TIER3_KG, maxLevel: 1,
    requiresAll: ['cargo_bay_2'],
    trl: 4, trlRationale: 'Large pressurised cargo volumes demonstrated; 3 t ADR hold is game-speculative' },

  // Thermal & Services (2) — category #9, created at P2's first row (P1 ledger
  // §8; charter .kilo/plans/1787839542000-phase2-flower-hardware-charter.md
  // TASK G). Purchase IS the gate: the pre-purchase tree renders byte-identical
  // (no feature flag — the FEATURE_FLAGS pin stays 42). Authored hardware =
  // ALL 4 stations; the shop stages trim-neutral diagonal PAIRS (S12 ⟂-CoM
  // 0.0000). Observe-only at P2: draws and slews, throttles nothing — the
  // thermal loop, PCM bank, and loop-fluid ladder join this category at P3+.
  // Prices are economy-pass placeholders; the ΔV/mass line SAYS the tax out
  // loud (§8.1 doctrine; numbers from tmp/flower-mass-budget.mjs §1 — re-run
  // at the Design 7b pin 25.8 kg/pair: −288.7 / −236.3 m/s, stations
  // 40/220 · 140/320, the plates fold in two for launch).
  { id: 'flower_pair_a', cat: 'Thermal & Services', name: 'Aft Flower — Pair A', cost: 1200,
    desc: 'Two aft-pivot radiator struts at az 40/220 (trim-neutral diagonal): 2.30 m booms, 1.50×0.60 m tri-panel plates that fold in two and lie along the bus for launch, inert tip hardpoints. They open LIKE A FLOWER — O opens them to 146°, and folds them flat to 2°. Mass tax said out loud: +26 kg dry, ΔV 2896 → 2607 m/s at full tanks (−289). Observe-only: radiates nothing yet — the loop refit prices heat later.',
    effect: 'flowerPairA', value: 1, maxLevel: 1,
    trl: 8, trlRationale: 'Rigid deployable radiators flown (ISS HRS/EATCS class); aft-pivot cargo-tip config is this program\'s own' },
  { id: 'flower_pair_b', cat: 'Thermal & Services', name: 'Aft Flower — Pair B', cost: 1000,
    desc: 'Completes the four-strut flower with the az 140/320 diagonal. All four struts open to 146° and fold flat together on O. Mass tax said out loud: +26 kg dry, ΔV 2607 → 2371 m/s at full tanks (−236). Radiator AREA doubles when the thermal loop arrives.',
    effect: 'flowerPairB', value: 1, maxLevel: 1,
    requiresAll: ['flower_pair_a'],
    trl: 8, trlRationale: 'Same rigid-radiator heritage as Pair A; staging is operational, not technological' },
];

/**
 * Recommended-starter highlight (early-shop tension plan). Ordered preference;
 * the shop ⭐-marks the first item here that is (a) un-owned and (b) affordable.
 * The badge persists on early visits until the player owns ANY starter, then
 * fades. Cosmetic only — buying still flows through _purchaseUpgrade.
 * Falls back to Constants.SHOP.RECOMMENDED_STARTERS so tuning lives in one place.
 */
export const STARTER_PREFERENCE =
  (Constants.SHOP && Constants.SHOP.RECOMMENDED_STARTERS)
  || ['capture_net', 'fast_reel', 'enhanced_eo', 'efficient_ion'];

/** One-line "why" per starter, shown next to the ⭐ badge. */
const STARTER_WHY = {
  capture_net:  'Miss fewer catches',
  fast_reel:    'Reel in faster, retry sooner',
  enhanced_eo:  'Spot debris from farther out',
  efficient_ion:'Stretch every drop of xenon',
};

/**
 * Pick the recommended starter id: the first preference that is BOTH un-owned
 * and affordable at the given credits. Returns null when none qualify or when
 * the player already owns any starter (the ⭐ has served its purpose).
 * Pure — exported for tests.
 * @param {Array<{id:string,cost:number}>} upgrades — upgrade catalog
 * @param {Map<string,number>|Set<string>|Iterable} owned — owned upgrade ids
 * @param {number} credits — current spendable credits
 * @param {string[]} [preference] — ordered preference list
 * @returns {string|null}
 */
export function recommendedStarter(upgrades, owned, credits, preference = STARTER_PREFERENCE) {
  const ownsId = (id) => {
    if (!owned) return false;
    if (owned instanceof Map || owned instanceof Set) return owned.has(id);
    if (typeof owned.has === 'function') return owned.has(id);
    if (Array.isArray(owned)) return owned.includes(id);
    return false;
  };
  // Once the player owns any starter, the highlight fades entirely.
  if (preference.some(ownsId)) return null;
  const byId = new Map((upgrades || []).map(u => [u.id, u]));
  for (const id of preference) {
    const u = byId.get(id);
    if (!u) continue;
    if (ownsId(id)) continue;
    if (credits >= u.cost) return id;
  }
  return null;
}

// S1 retention: pinned "next upgrade" chase-target math lives in the pure
// ./shopPin.js module (shared with the HUD, DOM-free). Re-exported here so the
// existing `../ui/ShopScreen.js` import sites (and tests) keep working.
// The pin is ONLY ever player-chosen (pinUpgrade/togglePin) — there is no
// auto-pin: manufacturing a cheapest-item goal the player never chose produced
// noise like "Extra Cold Gas — READY AT DEPOT" while tanks were already full.
import { pinProgress } from './shopPin.js';
import { VisualLaw } from '../core/VisualLaw.js';
export { pinProgress };

/** Spring tier descriptions for shop display */
const SPRING_DESCRIPTIONS = [
  "Factory steel springs. Reliable but slow.",
  "Maraging steel. Premium alloy, higher energy storage.",
  "Composite laminate springs with carbon fiber reinforcement.",
  "Nanolaminate metamaterial with programmable stiffness.",
  "Metamaterial quantum lattice. Maximum energy density.",
];

/** Tether tier descriptions for shop display */
export const TETHER_DESCRIPTIONS = [
  "Ultra-strong plastic fibre. Where you start.",
  "A tougher synthetic fibre. More nets, longer tethers.",
  "Carbon nanotube yarn. Lighter again, so more nets fit.",
  "Graphene fibre. Future tech.",
  "Graphene fibre, longer reach. Future tech.",
];

/**
 * The tether card's one stats line (DECISIONS §33 row 5): what the fibre buys, in plain words. Mother nets, then the
 * large and small daughters' nets, then the large daughter's tether length. "6 mother nets, 6 per daughter, 4 km tethers"
 * (both daughters hold the same count since 2026-10-23, DECISIONS §38 row 5; if a row ever differs it reads "3 and 6 per daughter").
 * @param {{nets:{mother:number,large:number,small:number}, maxLength:number}} tier a Constants.TETHER_TIERS row
 */
export function tetherStatsLine(tier) {
  const km = tier.maxLength / 1000;
  const perDaughter = tier.nets.large === tier.nets.small ? `${tier.nets.large}` : `${tier.nets.large} and ${tier.nets.small}`;
  return `${tier.nets.mother} mother nets, ${perDaughter} per daughter, ${km} km tethers`;
}

export class ShopScreen {
  constructor() {
    this.container = document.getElementById('hud-overlay');
    this.element = null;
    this.visible = false;
    this.purchasedUpgrades = new Map(); // upgradeId → level
    // S1 retention (2026-07-23): the pinned "next upgrade" chase target (id or
    // null). Persisted via the serialized-upgrade array (sentinel). Drives the
    // pinned-next-upgrade HUD widget between depots.
    this.pinnedUpgradeId = null;
    this._lastPurchasedId = null; // for flash animation
    this._springTier = 0;  // Current spring tier index (0 = T1 starter)
    this._tetherTier = 0;  // Current tether tier index (0 = T1 starter)
    // True only while showing the player's first depot visit (set from the
    // GAME_STATE_CHANGE payload). Drives the one-time first-visit framing + ⭐.
    this._firstDepotVisit = false;

    // Phase 5: system references for cargo selling
    this._cargoSystem = null;
    this._resourceSystem = null;   // g1-gas-upgrades D5
    this._scoringSystem = null;
    this._contractMassKg = 0;

    // u1-resupply-stop D2 (owner 2026-10-17): buying and selling happen only at the resupply stop. null = no
    // GameFlowManager wired (bare test rigs trade freely); only `false` refuses. GameFlowManager sets it.
    this._atResupplyStop = null;
    /** Nets step 3 slice 3 (S7): the stop is the resupply SATELLITE (flag on, the "where next" list there): the trade refusal names it. */
    this._satelliteStop = false;
    /** @type {Array<function(boolean|null): void>} u1-resupply-stop D3: panes that word their buttons by the stop (CARGO). */
    this._stopListeners = [];

    this._injectStyles();
    this._build();

    // Self-manage visibility via EventBus (decoupled from GameFlowManager)
    eventBus.on(Events.GAME_STATE_CHANGE, ({ to, firstDepotVisit }) => {
      if (to === GameStates.SHOP) {
        // GameFlowManager persists FIRST_DEPOT_VISITED before this event fires,
        // so the flag would already read true here. It passes the pre-write
        // signal through the payload instead — capture it for refresh() to use.
        this._firstDepotVisit = !!firstDepotVisit;
        this.show();
      } else {
        this._firstDepotVisit = false;
        this.hide();
      }
    });
  }

  // ========================================================================
  // Phase 5: System Setters & Contract State
  // ========================================================================

  /** Set CargoSystem reference for cargo manifest access. */
  setCargoSystem(cs) { this._cargoSystem = cs; }

  /** g1-gas-upgrades D5: ResourceSystem reference — the engine-gas resupply is priced and gated by the tank. */
  setResourceSystem(rs) { this._resourceSystem = rs; }

  /** Set ScoringSystem reference for addCredits. */
  setScoringSystem(ss) { this._scoringSystem = ss; }

  /**
   * u1-resupply-stop D1/D2: GameFlowManager pushes whether the ship is at the resupply stop (a completed mission
   * or the game-over shop, and no credited catch since). `false` refuses every trade below; `null` (never set)
   * leaves the shop permissive for bare test rigs.
   * @param {boolean|null} atStop
   */
  setResupplyStop(atStop) {
    const next = (atStop === null || atStop === undefined) ? null : !!atStop;
    const changed = next !== this._atResupplyStop;
    this._atResupplyStop = next;
    if (!changed) return;
    // A plain callback list, not an EventBus event (no Events.js churn): the CARGO pane repaints its button words.
    // (`|| []`: tests build shops with Object.create(ShopScreen.prototype), which skips the constructor)
    for (const fn of [...(this._stopListeners || [])]) { try { fn(next); } catch (_e) { /* a pane's repaint must not break the flow */ } }
  }

  /**
   * Nets step 3 slice 3 (S7): GameFlowManager says whether the stop is the resupply satellite (FIELDS_BY_HEIGHT on and the list there to
   * ask on). Only the refusal's words change: away from it every trade is still refused, "at the resupply satellite" instead of "stop".
   * @param {boolean} on
   */
  setSatelliteStop(on) { this._satelliteStop = !!on; }

  /**
   * u1-resupply-stop D3: call `fn(atStop)` whenever the stop flag changes (the CARGO pane re-words its buttons).
   * @param {function(boolean|null): void} fn
   * @returns {function(): void} unsubscribe
   */
  onResupplyStopChange(fn) {
    if (typeof fn !== 'function') return () => {};
    this._stopListeners = [...(this._stopListeners || []), fn];
    return () => { this._stopListeners = (this._stopListeners || []).filter((f) => f !== fn); };
  }

  /**
   * u1-resupply-stop D2/D3: may credits change hands right now? False only when GameFlowManager has said the
   * ship is NOT at the resupply stop. The REFIT chips and the CARGO pane read this to word their buttons.
   * @returns {boolean}
   */
  canTrade() { return this._atResupplyStop !== false; }

  /**
   * u1-resupply-stop D2: the trade gate. When the ship is mid-mission, plays the deny sound, posts ONE comms
   * line and returns true (the caller returns without touching credits, upgrades, tiers or cargo).
   * @returns {boolean} true = refused
   * @private
   */
  _refuseTrade() {
    if (this.canTrade()) return false;
    audioSystem.playDeny();
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'MARKET',
      text: this._satelliteStop
        ? 'Buying and selling happen at the resupply satellite.'          // slice 3: the stop moved there
        : 'Buying and selling happen at the resupply stop after a mission.',
      priority: 'warning',
      _reactive: true,   // feedback to the click the player just made — never muted by the onboarding tiers
    });
    return true;
  }

  /** Set contract mass (from save restore). */
  setContractMass(kg) { this._contractMassKg = kg || 0; }

  /** Get contract mass (for save serialization). */
  getContractMass() { return this._contractMassKg || 0; }

  // ========================================================================
  // STYLES
  // ========================================================================

  /** @private Inject CSS for purchase flash animation */
  _injectStyles() {
    if (document.getElementById('shop-flash-style')) return;
    const style = document.createElement('style');
    style.id = 'shop-flash-style';
    style.textContent = `
      @keyframes shop-purchase-flash {
        0%   { background: rgba(0,255,136,0.35); box-shadow: 0 0 20px rgba(0,255,136,0.4); }
        50%  { background: rgba(0,255,136,0.15); box-shadow: 0 0 10px rgba(0,255,136,0.2); }
        100% { background: rgba(0,20,40,0.5); box-shadow: none; }
      }
      .shop-card-flash {
        animation: shop-purchase-flash 0.8s ease-out !important;
      }
      .shop-buy-btn:hover,
      .shop-tier-buy-btn:hover {
        filter: brightness(1.3);
      }
    `;
    document.head.appendChild(style);
  }

  // ========================================================================
  // BUILD DOM
  // ========================================================================

  /** @private */
  _build() {
    this.element = document.createElement('div');
    this.element.id = 'shop-screen';
    this.element.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      background: rgba(0,5,15,0.92); z-index: 50; pointer-events: auto;
      transition: opacity 0.3s;
    `;

    this.element.innerHTML = `
      <div style="max-width:800px;width:95%;max-height:90vh;overflow-y:auto;padding:20px;">
        <div style="text-align:center;margin-bottom:1.5rem;">
          <h2 style="font-size:1.4rem;color:#00ff88;letter-spacing:0.15em;
                      text-shadow:0 0 15px rgba(0,255,136,0.4);">
            ORBITAL SUPPLY DEPOT
          </h2>
          <div style="font-size:0.95rem;color:rgba(0,255,136,0.6);margin-top:6px;">
            💰 Credits: <b id="shop-credits" style="color:#f0c040;font-size:1.1rem;">0</b>
            <span style="font-size:0.7rem;color:rgba(0,255,136,0.35);margin-left:12px;">
              Upgrades owned: <b id="shop-upgrade-count" style="color:rgba(0,255,136,0.6);">0</b>
            </span>
          </div>
          <div id="shop-firstvisit-note" style="display:none;font-size:0.78rem;
                color:rgba(240,192,64,0.85);margin-top:8px;max-width:560px;
                margin-left:auto;margin-right:auto;line-height:1.35;">
            Credits are your refit budget — gear that pays for itself. Pick one upgrade that fits your run.
          </div>
        </div>

        <div id="shop-categories"></div>

        <div id="shop-cargo-anchor"></div>

        <div style="text-align:center;margin-top:1.5rem;">
          <button id="shop-deploy-btn" style="
            font-family:var(--font-mono); font-size:1rem; color:#00ff88;
            background: rgba(0,255,136,0.1); border: 2px solid rgba(0,255,136,0.4);
            padding: 10px 40px; cursor: pointer; border-radius: 4px;
            letter-spacing: 0.15em; transition: all 0.3s;
          ">DEPLOY</button>
        </div>
      </div>
    `;

    this.element.style.display = 'none';
    this.container.appendChild(this.element);

    // Deploy button
    const deployBtn = this.element.querySelector('#shop-deploy-btn');
    deployBtn.addEventListener('click', () => {
      audioSystem.playClick();
      eventBus.emit(Events.SHOP_DEPLOY);
    });
    deployBtn.addEventListener('mouseenter', () => {
      deployBtn.style.background = 'rgba(0,255,136,0.25)';
      deployBtn.style.boxShadow = '0 0 15px rgba(0,255,136,0.3)';
    });
    deployBtn.addEventListener('mouseleave', () => {
      deployBtn.style.background = 'rgba(0,255,136,0.1)';
      deployBtn.style.boxShadow = 'none';
    });

    // Build and append cargo section
    const cargoSection = this._buildCargoSection();
    const anchor = this.element.querySelector('#shop-cargo-anchor');
    if (anchor) anchor.appendChild(cargoSection);
  }

  // ========================================================================
  // CARGO SECTION (Phase 5)
  // ========================================================================

  /** @private Build the cargo bay + elevator contract UI section */
  _buildCargoSection() {
    const section = document.createElement('div');
    section.id = 'shop-cargo-section';
    Object.assign(section.style, {
      marginTop: '20px',
      padding: '15px',
      background: 'rgba(0,0,0,0.6)',
      border: '1px solid #555',
      borderRadius: '8px',
    });

    section.innerHTML = `
      <h3 style="color:#ff9800;margin:0 0 10px 0;font-size:14px">📦 CARGO BAY</h3>
      <div id="cargo-manifest" style="max-height:200px;overflow-y:auto"></div>
      <div style="margin-top:10px;display:flex;gap:10px;align-items:center">
        <button id="sell-all-cargo-btn" style="
          padding:8px 16px;background:#ff9800;color:#000;border:none;
          border-radius:4px;cursor:pointer;font-weight:bold;font-size:12px;
        ">Sell All Cargo</button>
        <span id="cargo-total-value" style="color:#4f4;font-size:12px"></span>
      </div>
      <div style="margin-top:15px;border-top:1px solid #444;padding-top:10px">
        <h4 style="color:#81c784;margin:0 0 8px 0;font-size:12px">
          🏗️ SPACE ELEVATOR CONTRACT
        </h4>
        <div id="elevator-progress-section"></div>
      </div>
    `;

    return section;
  }

  /** @private Refresh the cargo manifest, sell buttons, and elevator progress */
  _refreshCargoManifest() {
    const manifestEl = document.getElementById('cargo-manifest');
    const totalEl = document.getElementById('cargo-total-value');
    const sellBtn = document.getElementById('sell-all-cargo-btn');
    const elevatorSection = document.getElementById('elevator-progress-section');

    if (!manifestEl) return;

    // Get cargo from CargoSystem
    const cargoStatus = this._cargoSystem ? this._cargoSystem.getStatus() : null;

    if (!cargoStatus || cargoStatus.manifest.length === 0) {
      manifestEl.innerHTML = '<div style="color:#666;font-style:italic">Cargo hold empty</div>';
      if (totalEl) totalEl.textContent = '';
      if (sellBtn) sellBtn.disabled = true;
    } else {
      let html = '';
      const sellMod = (Constants.MARKET && Constants.MARKET.SELL_PRICE_MODIFIER) || 0.85;

      for (const item of cargoStatus.manifest) {
        // Defensive: skip any malformed manifest entry (missing metalId) rather
        // than crashing the whole shop on item.metalId.startsWith.
        if (!item || typeof item.metalId !== 'string') continue;
        const sellValue = Math.round(item.value * sellMod);
        const isRefined = item.metalId.startsWith('refined_');
        const isProp = item.metalId.startsWith('prop_');
        const tag = isRefined ? ' ✧' : isProp ? ' ⚗' : '';

        html += `
          <div style="display:flex;justify-content:space-between;align-items:center;
            padding:4px 8px;margin:2px 0;background:rgba(255,255,255,0.05);border-radius:4px">
            <span style="color:${item.color};font-size:11px">
              ${item.name}${tag}. ${item.massKg}kg
            </span>
            <span style="display:flex;gap:8px;align-items:center">
              <span style="color:#4f4;font-size:10px">${sellValue}¢</span>
              <button class="sell-item-btn" data-metal-id="${item.metalId}"
                style="padding:2px 8px;background:#666;color:#fff;border:none;
                border-radius:3px;cursor:pointer;font-size:10px">Sell</button>
              ${isRefined ? `<button class="contribute-item-btn" data-metal-id="${item.metalId}"
                data-mass="${item.massKg}"
                style="padding:2px 8px;background:#81c784;color:#000;border:none;
                border-radius:3px;cursor:pointer;font-size:10px">→ Elevator</button>` : ''}
            </span>
          </div>
        `;
      }
      manifestEl.innerHTML = html;

      const totalValue = Math.round(cargoStatus.totalValue * sellMod);
      if (totalEl) totalEl.textContent = `Total: ${totalValue}¢ (${cargoStatus.totalMassKg}kg / ${cargoStatus.capacityKg}kg)`;
      if (sellBtn) sellBtn.disabled = false;

      // Attach sell handlers
      manifestEl.querySelectorAll('.sell-item-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const metalId = btn.dataset.metalId;
          this._sellCargo(metalId);
        });
      });

      // Attach contribute handlers
      manifestEl.querySelectorAll('.contribute-item-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const metalId = btn.dataset.metalId;
          const mass = parseFloat(btn.dataset.mass);
          this._contributeToElevator(metalId, mass);
        });
      });
    }

    if (sellBtn) {
      sellBtn.onclick = () => this._sellAllCargo();
    }

    // Elevator progress
    if (elevatorSection) {
      const progress = this._contractMassKg || 0;
      const target = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.TARGET_MASS_KG) || 10000;
      const pct = Math.min(100, (progress / target * 100));
      const bonusPerKg = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.BONUS_CREDITS_PER_KG) || 5;
      elevatorSection.innerHTML = `
        <div style="color:#aaa;font-size:11px;margin-bottom:4px">
          ${progress.toFixed(1)} / ${target} kg contributed
        </div>
        <div style="background:#333;border-radius:3px;height:8px;overflow:hidden">
          <div style="height:100%;background:linear-gradient(90deg,#81c784,#4caf50);
            width:${pct.toFixed(1)}%;transition:width 0.5s"></div>
        </div>
        <div style="color:#666;font-size:9px;margin-top:2px">
          Contribute refined metals to earn ${bonusPerKg}¢/kg bonus
        </div>
      `;
    }
  }

  // ========================================================================
  // PUBLIC SELL / CONTRIBUTE WRAPPERS (Session K — the CARGO HUD pane)
  // ========================================================================

  /**
   * Public wrappers over the private sell / contribute paths below. They exist
   * for the CARGO pane (js/ui/hud/CargoPane.js, Session K): the pane's SELL /
   * SELL ALL / -> ELEVATOR buttons act through THESE and never touch
   * CargoSystem.removeMetal directly, so the sale pipeline (ScoringSystem.
   * processSale), the contract mass, the CONTRACT_UPDATE / CONTRACT_COMPLETE
   * emits and the market comms stay in one place. Pure delegation: no logic.
   * @param {string} metalId - manifest metalId to sell in full
   */
  sellMetal(metalId) {
    return this._sellCargo(metalId);
  }

  /** Sell the whole manifest (bulk bonus on the total) — see `_sellAllCargo`. */
  sellAllCargo() {
    return this._sellAllCargo();
  }

  /**
   * Contribute `massKg` of `metalId` to the space elevator contract — see
   * `_contributeToElevator` (the win check fires inside).
   * @param {string} metalId
   * @param {number} massKg
   */
  contributeToElevator(metalId, massKg) {
    return this._contributeToElevator(metalId, massKg);
  }

  // ========================================================================
  // SELL / CONTRIBUTE (Phase 5)
  // ========================================================================

  /** @private Sell a single cargo item for credits */
  _sellCargo(metalId) {
    if (!this._cargoSystem) return;
    const manifest = this._cargoSystem.getManifest();
    const item = manifest.find(m => m.metalId === metalId);
    if (!item) return;
    if (this._refuseTrade()) return;   // u1-resupply-stop D2: no buyer in space

    this._cargoSystem.removeMetal(metalId, item.massKg);

    // E6: single sale-value SSOT. Route through ScoringSystem.processSale
    // (market spread + bulk bonus + credit + BULK comms) instead of the local
    // copy that had drifted from the canonical pipeline.
    const ss = this._scoringSystem || scoringSystem;
    const credits = (ss && ss.processSale)
      ? ss.processSale({ totalValue: item.value, totalMassKg: item.massKg })
      : 0;

    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'MARKET',
      text: `Sold ${item.massKg}kg ${item.name} for ${credits}¢`,
      priority: 'info'
    });

    this.refresh();
  }

  /** @private Sell all cargo for credits (with bulk bonus on total) */
  _sellAllCargo() {
    if (!this._cargoSystem) return;
    const manifest = this._cargoSystem.getManifest();
    if (manifest.length === 0) return;
    if (this._refuseTrade()) return;   // u1-resupply-stop D2

    let totalValue = 0;
    let totalMass = 0;
    for (const item of [...manifest]) {
      totalValue += item.value;
      totalMass += item.massKg;
      this._cargoSystem.removeMetal(item.metalId, item.massKg);
    }

    // E6: route through the shared sale pipeline (spread + bulk-on-total + credit).
    const ss = this._scoringSystem || scoringSystem;
    const credits = (ss && ss.processSale)
      ? ss.processSale({ totalValue, totalMassKg: totalMass })
      : 0;

    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'MARKET',
      text: `Sold all cargo (${totalMass.toFixed(1)}kg) for ${credits}¢`,
      priority: 'info'
    });

    this.refresh();
  }

  /** @private Contribute refined metal to the space elevator contract */
  _contributeToElevator(metalId, massKg) {
    if (!this._cargoSystem) return;
    if (this._refuseTrade()) return;   // u1-resupply-stop D2: the contract pays credits, so it is a sale

    // Read the item BEFORE removal so we can value the contribution at market.
    const item = this._cargoSystem.getManifest().find(m => m.metalId === metalId);

    const removed = this._cargoSystem.removeMetal(metalId, massKg);
    if (removed < 0.01) return;

    this._contractMassKg = (this._contractMassKg || 0) + removed;

    // E3: a contribution pays the metal's SELL VALUE (market spread + bulk
    // bonus — the same credits selling it would earn) PLUS the elevator's
    // per-kg bonus, which the constant documents as being "on top of selling
    // price". Before this fix it paid ONLY the 5¢/kg bonus, so contributing
    // forfeited ~20¢/kg vs selling and the elevator win was strictly dominated.
    const perKgValue = (item && item.massKg > 0) ? (item.value / item.massKg) : 0;
    const { saleValue, bonus, payout } = computeContributionPayout(perKgValue * removed, removed);

    const ss = this._scoringSystem || scoringSystem;
    if (ss && ss.addCredits) {
      ss.addCredits(payout);
    }

    const target = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.TARGET_MASS_KG) || 10000;

    eventBus.emit(Events.CONTRACT_UPDATE, {
      contractMassKg: this._contractMassKg,
      targetMassKg: target,
    });

    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'ELEVATOR',
      text: `+${removed.toFixed(1)}kg contributed (+${payout}¢: ${saleValue} sale + ${bonus} bonus). Total: ${this._contractMassKg.toFixed(1)}kg`,
      priority: 'info'
    });

    // Check win condition
    if (this._contractMassKg >= target) {
      const winBonus = (Constants.ELEVATOR_CONTRACT && Constants.ELEVATOR_CONTRACT.WIN_BONUS) || 50000;
      if (ss && ss.addCredits) {
        ss.addCredits(winBonus);
      }
      eventBus.emit(Events.CONTRACT_COMPLETE, {
        totalMassKg: this._contractMassKg,
        bonusCredits: winBonus,
      });
      eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'ELEVATOR',
        text: `🏆 CONTRACT COMPLETE! ${winBonus}¢ bonus! Space elevator anchor mass achieved!`,
        priority: 'critical'
      });
    }

    this.refresh();
  }

  // ========================================================================
  // REFRESH
  // ========================================================================

  /** Refresh shop with current credits */
  refresh() {
    const creditsEl = this.element.querySelector('#shop-credits');
    if (creditsEl) creditsEl.textContent = scoringSystem.credits.toLocaleString();

    // Show upgrade count
    const upgradeCountEl = this.element.querySelector('#shop-upgrade-count');
    if (upgradeCountEl) {
      let totalOwned = 0;
      for (const [, lvl] of this.purchasedUpgrades) totalOwned += lvl;
      totalOwned += this._springTier + this._tetherTier;
      upgradeCountEl.textContent = totalOwned;
    }

    const catContainer = this.element.querySelector('#shop-categories');
    if (!catContainer) return;

    // First-depot framing + recommended-starter highlight (early-shop tension).
    // The investment-framing header and ⭐ both key off "first depot visit";
    // the ⭐ additionally requires the player to own no starter yet. Use the
    // in-memory signal from GAME_STATE_CHANGE — the persisted FIRST_DEPOT_VISITED
    // flag is already true by the time the shop renders, so re-reading it here
    // would never show the framing on the actual first visit.
    const firstDepot = this._firstDepotVisit;
    const noteEl = this.element.querySelector('#shop-firstvisit-note');
    if (noteEl) noteEl.style.display = firstDepot ? 'block' : 'none';
    const recommendedId = firstDepot
      ? recommendedStarter(UPGRADES, this.purchasedUpgrades, scoringSystem.credits)
      : null;

    // Group by category
    const categories = {};
    UPGRADES.forEach(u => {
      // Net ladder: hide feature-gated items (e.g. Mother net restock) when the
      // gating flag is off.
      if (u.requiresFeature && !Constants.isFeatureEnabled(u.requiresFeature)) return;
      // P2 flower: while FLOWER_PREINSTALLED is ON the hardware is already
      // aboard at boot (owner ruling 2026-08-27) — hide its purchase rows so
      // nobody pays credits for installed hardware. P3 flips the flag off and
      // these rows return as the real gate. (Rows stay in UPGRADES: the
      // CATALOG_TOTAL_CR SSOT and its pacing pins are catalog-shape facts.)
      if (Constants.FEATURE_FLAGS.FLOWER_PREINSTALLED
          && (u.id === 'flower_pair_a' || u.id === 'flower_pair_b')) return;
      if (!categories[u.cat]) categories[u.cat] = [];
      categories[u.cat].push(u);
    });

    let html = Object.entries(categories).map(([cat, upgrades]) => `
      <div style="margin-bottom:1rem;">
        <div style="font-size:0.8rem;color:rgba(0,255,136,0.5);letter-spacing:0.1em;
                     margin-bottom:6px;padding-bottom:3px;border-bottom:1px solid rgba(0,255,136,0.15);">
          ${cat.toUpperCase()}
        </div>
        ${upgrades.map(u => this._renderUpgradeCard(u, recommendedId)).join('')}
      </div>
    `).join('');

    // Append crossbow spring & tether material tier sections
    html += this._renderTierSection('spring', '🛰️ CRADLE SPRINGS', Constants.SPRING_TIERS, SPRING_DESCRIPTIONS, this._springTier);
    html += this._renderTierSection('tether', '🧵 LINE FIBRE', Constants.TETHER_TIERS, TETHER_DESCRIPTIONS, this._tetherTier);

    catContainer.innerHTML = html;

    // Inline-glossary affordances: decorated jargon in upgrade/tier descriptions
    // deep-links to its Tech Library entry (idempotent CSS + delegated click).
    ensureGlossaryCss();
    delegateGlossaryClicks(catContainer);

    // Buy button handlers
    catContainer.querySelectorAll('.shop-buy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        this._purchaseUpgrade(id);
      });
    });

    // S1 retention: pin toggle handlers
    catContainer.querySelectorAll('.shop-pin-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePin(btn.dataset.pinId);
        this.refresh();
      });
    });

    // Tier buy button handlers (springs & tethers)
    catContainer.querySelectorAll('.shop-tier-buy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tierType = btn.dataset.tierType;
        const tierIndex = parseInt(btn.dataset.tierIndex, 10);
        this._purchaseTierUpgrade(tierType, tierIndex);
      });
    });

    // Apply flash animation to last purchased card
    if (this._lastPurchasedId) {
      const card = catContainer.querySelector(`[data-upgrade-id="${this._lastPurchasedId}"]`)
                || catContainer.querySelector(`[data-tier-id="${this._lastPurchasedId}"]`);
      if (card) {
        card.classList.add('shop-card-flash');
        // Remove after animation completes
        setTimeout(() => card.classList.remove('shop-card-flash'), 800);
      }
      this._lastPurchasedId = null;
    }

    // Phase 5: Refresh cargo manifest
    this._refreshCargoManifest();
  }

  // ========================================================================
  // UPGRADE CARDS
  // ========================================================================

  /** @private Render a single upgrade card */
  _renderUpgradeCard(upgrade, recommendedId = null) {
    const currentLevel = this.purchasedUpgrades.get(upgrade.id) || 0;
    const maxed = currentLevel >= upgrade.maxLevel;
    const price = upgradeCostNow(upgrade, this._resourceSystem);   // g1-gas-upgrades D4: the ONE price accessor
    const canAfford = scoringSystem.credits >= price;
    const isRecommended = recommendedId === upgrade.id;
    // Prerequisite gate (E5 SSOT): shared with the purchase guard in
    // _purchaseUpgrade so the render's disabled-state and the actual purchase
    // enforcement can't drift. Handles requires / requiresAll / requiresFeature.
    const requiresMet = upgradePrereqsMet(upgrade, this.purchasedUpgrades, (f) => Constants.isFeatureEnabled(f));
    // Consumable restock with no remaining capacity (both Mother pods full) is
    // unavailable — don't let the player pay for a net that can't be loaded.
    const daughterNetType = DAUGHTER_NET_EFFECT_TYPE[upgrade.effect];
    const consumableFull = (upgrade.effect === 'motherNetRestock'
      && !captureNetSystem.hasMotherPodSpace())
      || (!!daughterNetType && !captureNetSystem.hasDaughterNetSpace(daughterNetType))
      || noRoomFor(upgrade, this._resourceSystem);   // the engine tank, the cold-gas tank, the indium store
    const available = !maxed && canAfford && requiresMet && !consumableFull;
    // S1 retention: pinnable = gated-open, not-maxed, non-consumable.
    const pinnable = !maxed && requiresMet && !upgrade.consumable && upgrade.maxLevel !== Infinity;
    const isPinned = this.pinnedUpgradeId === upgrade.id;

    const opacity = maxed ? 0.5 : (available ? 1.0 : 0.5);
    const borderColor = maxed ? 'rgba(0,255,136,0.2)' : (available ? 'rgba(0,255,136,0.3)' : 'rgba(255,68,68,0.15)');
    const bgColor = maxed ? 'rgba(0,255,136,0.05)' : 'rgba(0,20,40,0.5)';

    // Level indicator for multi-level upgrades (consumables show no level badge).
    const levelBadge = (!upgrade.consumable && upgrade.maxLevel > 1)
      ? `<span style="font-size:0.65rem;color:${maxed ? VisualLaw.COLORS.PLAYER : '#f0c040'};margin-left:6px;
                       padding:1px 5px;border-radius:2px;border:1px solid ${maxed ? 'rgba(0,255,136,0.3)' : 'rgba(240,192,64,0.3)'};
                       background:${maxed ? 'rgba(0,255,136,0.1)' : 'rgba(240,192,64,0.08)'};">
           LVL ${currentLevel}/${upgrade.maxLevel}</span>`
      : (maxed ? `<span style="font-size:0.65rem;color:#00ff88;margin-left:6px;">✓</span>` : '');

    // Cost display with insufficient funds styling
    const costColor = maxed ? 'rgba(0,255,136,0.4)' : (canAfford ? '#f0c040' : '#ff4444');
    const costStrike = !canAfford && !maxed ? 'text-decoration:line-through;opacity:0.6;' : '';

    // ST-6.6 / UX-11 #10: Tech-Level badge — colour-coded, tooltipped with rationale
    const trlBadge = (typeof upgrade.trl === 'number')
      ? `<span title="${trlToTechLevelLabel(upgrade.trl, Constants.TRL)}${upgrade.trlRationale ? '\n' + upgrade.trlRationale : ''}"
              style="display:inline-block;margin-left:6px;font-size:0.6rem;font-weight:bold;
                     padding:1px 5px;border-radius:2px;letter-spacing:0.05em;
                     color:${trlToBadgeColor(upgrade.trl, Constants.TRL)};
                     border:1px solid ${trlToBadgeColor(upgrade.trl, Constants.TRL)};
                     background:rgba(0,0,0,0.3);">${techLevelBadgeText(upgrade.trl)}</span>`
      : '';

    // Recommended-starter ⭐ badge + one-line "why" (early-shop tension).
    const starBadge = isRecommended
      ? `<span title="Recommended starter" style="margin-left:6px;font-size:0.75rem;
               color:#f0c040;">★</span>`
      : '';
    // S1 retention: pin toggle badge (📌) on the name row for pinnable items.
    const pinBadge = pinnable
      ? `<span class="shop-pin-btn" data-pin-id="${upgrade.id}"
              title="${isPinned ? 'Unpin chase target' : 'Pin as next-upgrade goal'}"
              style="margin-left:6px;font-size:0.72rem;cursor:pointer;user-select:none;
                     opacity:${isPinned ? 1 : 0.4};color:${isPinned ? '#f0c040' : 'rgba(0,255,136,0.6)'};">📌</span>`
      : '';
    const whyLine = isRecommended && STARTER_WHY[upgrade.id]
      ? `<div style="font-size:0.65rem;color:rgba(240,192,64,0.85);margin-top:2px;">
           ★ ${STARTER_WHY[upgrade.id]}</div>`
      : '';

    return `
      <div data-upgrade-id="${upgrade.id}" style="display:flex;justify-content:space-between;align-items:center;
                  padding:8px 12px;margin:4px 0;border-radius:3px;
                  background:${isRecommended ? 'rgba(240,192,64,0.06)' : bgColor};
                  border:1px solid ${isRecommended ? 'rgba(240,192,64,0.45)' : borderColor};
                  opacity:${opacity};transition:all 0.3s;">
        <div style="flex:1;">
          <div style="font-size:0.85rem;color:${maxed ? 'rgba(0,255,136,0.6)' : VisualLaw.COLORS.PLAYER};">
            ${upgrade.name}${levelBadge}${trlBadge}${starBadge}${pinBadge}
          </div>
          <div style="font-size:0.7rem;color:rgba(0,255,136,0.5);">${decorateGlossary(depotWords(upgrade.desc), { once: true })}</div>
          ${whyLine}
          ${upgrade.requires && !requiresMet ? `<div style="font-size:0.65rem;color:#ff6644;">Requires: ${UPGRADES.find(u => u.id === upgrade.requires)?.name}</div>` : ''}
          ${upgrade.supersededBy && !requiresMet ? `<div style="font-size:0.65rem;color:#ff6644;">Replaced by ${UPGRADES.find(u => u.id === upgrade.supersededBy)?.name}</div>` : ''}
          ${consumableFull && upgrade.effect === 'engineGasResupply' ? `<div style="font-size:0.65rem;color:#ff6644;">Engine tank full</div>` : ''}
          ${consumableFull && upgrade.effect === 'coldGasResupply' ? `<div style="font-size:0.65rem;color:#ff6644;">Cold-gas tank full</div>` : ''}
          ${consumableFull && upgrade.effect === 'indiumCartridge' ? `<div style="font-size:0.65rem;color:#ff6644;">Indium store full</div>` : ''}
          ${consumableFull && daughterNetType ? `<div style="font-size:0.65rem;color:#ff6644;">No docked daughter has room</div>` : ''}
          ${upgrade.requiresAll && !requiresMet ? `<div style="font-size:0.65rem;color:#ff6644;">Requires: ${upgrade.requiresAll.map(id => UPGRADES.find(u => u.id === id)?.name || id).join(' + ')}</div>` : ''}
          ${!canAfford && !maxed ? `<div style="font-size:0.6rem;color:rgba(255,68,68,0.5);margin-top:2px;">Need ${(price - scoringSystem.credits).toLocaleString()} more cr</div>` : ''}
        </div>
        <div style="text-align:right;min-width:90px;">
          ${maxed
            ? `<span style="color:rgba(0,255,136,0.5);font-size:0.75rem;">✓ OWNED</span>`
            : `<div style="font-size:0.8rem;color:${costColor};${costStrike}">${price.toLocaleString()} cr</div>
               <button class="shop-buy-btn" data-id="${upgrade.id}" style="
                 font-family:var(--font-mono); font-size:0.7rem; color:${available ? VisualLaw.COLORS.PLAYER : 'rgba(0,255,136,0.3)'};
                 background: ${available ? 'rgba(0,255,136,0.15)' : 'transparent'};
                 border: 1px solid ${available ? 'rgba(0,255,136,0.4)' : 'rgba(0,255,136,0.15)'};
                 padding: 3px 12px; cursor: ${available ? 'pointer' : 'default'}; border-radius: 2px;
                 pointer-events: ${available ? 'auto' : 'none'}; transition: all 0.2s;
               ">BUY</button>`
          }
        </div>
      </div>
    `;
  }

  // ========================================================================
  // TIER UPGRADE CARDS (Crossbow Springs & Tether Materials)
  // ========================================================================

  /**
   * @private Render an entire tier upgrade section (springs or tethers).
   * @param {string} tierType - 'spring' or 'tether'
   * @param {string} headerLabel - Section header text
   * @param {Array} tiers - Tier data from Constants
   * @param {string[]} descriptions - Human descriptions per tier
   * @param {number} currentTier - Currently owned tier index
   */
  _renderTierSection(tierType, headerLabel, tiers, descriptions, currentTier) {
    const cards = tiers.map((tier, i) =>
      this._renderTierCard(tierType, tier, i, descriptions[i], currentTier)
    ).join('');

    // Register item 100: the "Max X m/s" cards are TRUE now that the dial
    // ships — the section note names the control (and the tether section names
    // the reach the tier ladder now drives). The dial default stays 10 m/s.
    let sectionNote = '';
    if (tierType === 'spring') {
      sectionNote = '<div style="font-size:0.65rem;color:rgba(0,255,136,0.4);margin-bottom:6px;">The ceiling your cradle can fire at — set the fleet launch speed in flight with [;] down / [\'] up. Hotter shots reload ∝ v².</div>';
    } else if (tierType === 'tether') {
      sectionNote = '<div style="font-size:0.65rem;color:rgba(0,255,136,0.4);margin-bottom:6px;">Stronger fibre holds more nets and reaches further. Small daughters reach a quarter as far.</div>';
    }

    return `
      <div style="margin-bottom:1rem;">
        <div style="font-size:0.8rem;color:rgba(0,255,136,0.5);letter-spacing:0.1em;
                     margin-bottom:6px;padding-bottom:3px;border-bottom:1px solid rgba(0,255,136,0.15);">
          ${headerLabel}
        </div>
        ${sectionNote}
        ${cards}
      </div>
    `;
  }

  /**
   * @private Render a single tier upgrade card.
   * @param {string} tierType - 'spring' or 'tether'
   * @param {Object} tier - Tier data object from Constants
   * @param {number} tierIndex - Index into the tiers array
   * @param {string} desc - Human-readable description
   * @param {number} currentTier - Currently owned tier index
   */
  _renderTierCard(tierType, tier, tierIndex, desc, currentTier) {
    const isOwned = tierIndex < currentTier;
    const isCurrent = tierIndex === currentTier;
    const isNext = tierIndex === currentTier + 1;
    const isLocked = tierIndex > currentTier + 1;
    const canAfford = scoringSystem.credits >= tier.cost;
    const available = isNext && canAfford;

    // Visual states
    let borderColor, bgColor, opacity;
    if (isCurrent) {
      borderColor = 'rgba(0,255,136,0.5)';
      bgColor = 'rgba(0,255,136,0.08)';
      opacity = 1.0;
    } else if (isOwned) {
      borderColor = 'rgba(0,255,136,0.2)';
      bgColor = 'rgba(0,255,136,0.05)';
      opacity = 0.5;
    } else if (isNext) {
      borderColor = available ? 'rgba(240,192,64,0.4)' : 'rgba(255,68,68,0.15)';
      bgColor = 'rgba(0,20,40,0.5)';
      opacity = available ? 1.0 : 0.6;
    } else {
      borderColor = 'rgba(100,100,100,0.2)';
      bgColor = 'rgba(0,10,20,0.3)';
      opacity = 0.35;
    }

    // Stats line differs by tier type
    let statsLine;
    if (tierType === 'spring') {
      statsLine = `Max ${tier.maxSpeed} m/s`;
    } else {
      statsLine = tier.nets ? tetherStatsLine(tier) : `${tier.breakStrength}N break · ${(tier.maxLength / 1000).toFixed(0)}km max`;
    }

    // Status badge / action area
    let statusHtml;
    if (isCurrent) {
      statusHtml = `<span style="color:#00ff88;font-size:0.75rem;">▶ EQUIPPED</span>`;
    } else if (isOwned) {
      statusHtml = `<span style="color:rgba(0,255,136,0.5);font-size:0.75rem;">✓ OWNED</span>`;
    } else if (isLocked) {
      statusHtml = `<span style="color:rgba(100,100,100,0.5);font-size:0.75rem;">🔒 LOCKED</span>`;
    } else {
      // isNext — purchasable
      const costColor = canAfford ? '#f0c040' : '#ff4444';
      const costStrike = !canAfford ? 'text-decoration:line-through;opacity:0.6;' : '';
      statusHtml = `
        <div style="font-size:0.8rem;color:${costColor};${costStrike}">${tier.cost.toLocaleString()} cr</div>
        <button class="shop-tier-buy-btn" data-tier-type="${tierType}" data-tier-index="${tierIndex}" style="
          font-family:var(--font-mono); font-size:0.7rem; color:${available ? VisualLaw.COLORS.PLAYER : 'rgba(0,255,136,0.3)'};
          background: ${available ? 'rgba(0,255,136,0.15)' : 'transparent'};
          border: 1px solid ${available ? 'rgba(0,255,136,0.4)' : 'rgba(0,255,136,0.15)'};
          padding: 3px 12px; cursor: ${available ? 'pointer' : 'default'}; border-radius: 2px;
          pointer-events: ${available ? 'auto' : 'none'}; transition: all 0.2s;
        ">BUY</button>
      `;
      if (!canAfford) {
        statusHtml += `<div style="font-size:0.6rem;color:rgba(255,68,68,0.5);margin-top:2px;">Need ${(tier.cost - scoringSystem.credits).toLocaleString()} more cr</div>`;
      }
    }

    const tierLabel = `T${tierIndex + 1}`;

    return `
      <div data-tier-id="${tierType}-${tierIndex}" style="display:flex;justify-content:space-between;align-items:center;
                  padding:8px 12px;margin:4px 0;border-radius:3px;
                  background:${bgColor};border:1px solid ${borderColor};
                  opacity:${opacity};transition:all 0.3s;">
        <div style="flex:1;">
          <div style="font-size:0.85rem;color:${isCurrent ? VisualLaw.COLORS.PLAYER : isOwned ? 'rgba(0,255,136,0.6)' : isLocked ? 'rgba(100,100,100,0.5)' : VisualLaw.COLORS.PLAYER};">
            <span style="font-size:0.65rem;color:${isCurrent ? '#f0c040' : 'rgba(0,255,136,0.4)'};
                         padding:1px 5px;border-radius:2px;border:1px solid ${isCurrent ? 'rgba(240,192,64,0.3)' : 'rgba(0,255,136,0.15)'};
                         background:${isCurrent ? 'rgba(240,192,64,0.08)' : 'transparent'};margin-right:6px;">${tierLabel}</span>
            ${tier.label || tier.name}
          </div>
          <div style="font-size:0.7rem;color:rgba(0,255,136,0.5);">${statsLine}</div>
          <div style="font-size:0.65rem;color:rgba(0,255,136,0.35);margin-top:1px;">${decorateGlossary(desc, { once: true })}</div>
        </div>
        <div style="text-align:right;min-width:90px;">
          ${statusHtml}
        </div>
      </div>
    `;
  }

  // ========================================================================
  // PURCHASE
  // ========================================================================

  /**
   * Public one-click purchase — the Wave-5 (2) REFIT pane's BUY path
   * (docs/ladder/08-workbench.md §2: "Buying is one click … no browser
   * confirm(), no undo"). u1-resupply-stop D2 (owner 2026-10-17): buying
   * happens only at the resupply stop — the gate is in the private flow below,
   * so a pane buy and a depot buy are refused alike mid-mission. Runs the EXACT private flow below (maxLevel gate, the E5
   * shopGating prereq guard, wallet spend, UPGRADE_PURCHASED emit, refresh),
   * so a pane buy and a depot buy are indistinguishable; the pane then
   * re-renders from purchasedUpgrades/credits truth.
   * @param {string} upgradeId
   */
  purchaseUpgrade(upgradeId) { return this._purchaseUpgrade(upgradeId); }

  /** @private Purchase an upgrade */
  _purchaseUpgrade(upgradeId) {
    const upgrade = UPGRADES.find(u => u.id === upgradeId);
    if (!upgrade) return;
    if (this._refuseTrade()) return;   // u1-resupply-stop D2: no store in the middle of space

    // Consumables (e.g. Mother Large Net restock) are repeatable — no maxLevel
    // gate, no ownership record. They just spend credits and emit the effect.
    if (upgrade.consumable) {
      if (upgrade.requiresFeature && !Constants.isFeatureEnabled(upgrade.requiresFeature)) return;
      // Don't charge for a net that can't be loaded (both pods already full).
      if (upgrade.effect === 'motherNetRestock' && !captureNetSystem.hasMotherPodSpace()) {
        audioSystem.playDeny();
        return;
      }
      // Nor for a daughter net when no docked daughter of that size has room (DECISIONS §33).
      const daughterType = DAUGHTER_NET_EFFECT_TYPE[upgrade.effect];
      if (daughterType && !captureNetSystem.hasDaughterNetSpace(daughterType)) {
        audioSystem.playDeny();
        return;
      }
      // g1-gas-upgrades D4: nor for gas that has no room in the tank (free < 0.1 kg)
      if (upgrade.effect === 'engineGasResupply' && engineTankFull(this._resourceSystem)) {
        audioSystem.playDeny();
        return;
      }
      // lane 3f: nor for nitrogen that has no room in the cold-gas tank (free < 0.1 kg), nor a cartridge the indium store cannot take
      if ((upgrade.effect === 'coldGasResupply' || upgrade.effect === 'indiumCartridge') && noRoomFor(upgrade, this._resourceSystem)) {
        audioSystem.playDeny();
        if (upgrade.effect === 'indiumCartridge') {            // one plain line: the store takes whole cartridges only
          eventBus.emit(Events.COMMS_MESSAGE, {
            sender: 'MARKET', text: 'The ion-fuel store has no room for another cartridge.', priority: 'warning',
            _reactive: true,   // feedback to the click the player just made
          });
        }
        return;
      }
      if (!scoringSystem.spendCredits(upgradeCostNow(upgrade, this._resourceSystem))) {
        audioSystem.playDeny();
        return;
      }
      this._lastPurchasedId = upgradeId;
      audioSystem.playPurchase();
      eventBus.emit(Events.UPGRADE_PURCHASED, {
        id: upgradeId,
        effect: upgrade.effect,
        value: upgrade.value,
        consumable: true,
      });
      this.refresh();
      return;
    }

    const currentLevel = this.purchasedUpgrades.get(upgradeId) || 0;
    if (currentLevel >= upgrade.maxLevel) return;

    // E5: enforce prerequisites at PURCHASE time, not just in the render's
    // disabled-state. Without this a mis-ordered / scripted buy could acquire a
    // locked upgrade (e.g. graphene_supercap before solid_state_battery) and
    // spend the credits anyway. Refuse before charging — wallet untouched.
    if (!upgradePrereqsMet(upgrade, this.purchasedUpgrades, (f) => Constants.isFeatureEnabled(f))) {
      audioSystem.playDeny();
      return;
    }

    if (!scoringSystem.spendCredits(upgradeCostNow(upgrade, this._resourceSystem))) {
      audioSystem.playDeny();
      return;
    }

    this.purchasedUpgrades.set(upgradeId, currentLevel + 1);
    this._lastPurchasedId = upgradeId; // trigger flash on next refresh
    audioSystem.playPurchase();

    // S1 retention: clear the pin when the pinned item is purchased (or once it
    // reaches maxLevel); the HUD re-advances to a fresh chase target on next hide.
    if (this.pinnedUpgradeId === upgradeId) {
      this.pinnedUpgradeId = null;
      this._emitPinnedUpgrade();
    }

    // Emit upgrade event for game to apply
    eventBus.emit(Events.UPGRADE_PURCHASED, {
      id: upgradeId,
      effect: upgrade.effect,
      value: upgrade.value,
      level: currentLevel + 1,
    });

    // Refresh display (will apply flash animation)
    this.refresh();
  }

  /**
   * @private Purchase a tier upgrade (spring or tether).
   * @param {string} tierType - 'spring' or 'tether'
   * @param {number} tierIndex - Target tier index
   */
  _purchaseTierUpgrade(tierType, tierIndex) {
    const tiers = tierType === 'spring' ? Constants.SPRING_TIERS : Constants.TETHER_TIERS;
    const currentTier = tierType === 'spring' ? this._springTier : this._tetherTier;

    // Must be the next tier in sequence
    if (tierIndex !== currentTier + 1) return;
    if (tierIndex >= tiers.length) return;
    if (this._refuseTrade()) return;   // u1-resupply-stop D2

    const tier = tiers[tierIndex];
    if (!scoringSystem.spendCredits(tier.cost)) {
      audioSystem.playDeny();
      return;
    }

    // Advance to new tier
    if (tierType === 'spring') {
      this._springTier = tierIndex;
    } else {
      this._tetherTier = tierIndex;
    }

    this._lastPurchasedId = `${tierType}-${tierIndex}`; // trigger flash on next refresh
    audioSystem.playPurchase();

    // Emit upgrade event — ArmManager.applyUpgrade() handles springTier / tetherTier
    eventBus.emit(Events.UPGRADE_PURCHASED, {
      type: tierType === 'spring' ? 'springTier' : 'tetherTier',
      effect: tierType === 'spring' ? 'springTier' : 'tetherTier',
      value: tierIndex,
      level: tierIndex,
      name: tier.name,
      cost: tier.cost,
    });

    this.refresh();
  }

  // ========================================================================
  // PUBLIC API
  // ========================================================================

  /**
   * Get purchased upgrade IDs as a serializable array for persistence.
   * Multi-level upgrades appear multiple times (once per level).
   * @returns {string[]}
   */
  getSerializableUpgrades() {
    const ids = [];
    for (const [id, level] of this.purchasedUpgrades) {
      for (let i = 0; i < level; i++) {
        ids.push(id);
      }
    }
    // Serialize tier upgrades (tier 0 is free starter, store purchased tiers)
    for (let i = 0; i < this._springTier; i++) ids.push('_springTier');
    for (let i = 0; i < this._tetherTier; i++) ids.push('_tetherTier');
    // S1 retention: persist the pinned chase target as a sentinel token so it
    // survives save/load through the existing upgrade-array channel.
    if (this.pinnedUpgradeId) ids.push(`__pin__${this.pinnedUpgradeId}`);
    return ids;
  }

  /**
   * Restore purchases from a saved array of upgrade IDs.
   * @param {string[]} upgradeIds - Array of upgrade IDs (duplicates = multi-level)
   */
  restorePurchases(upgradeIds) {
    this.purchasedUpgrades.clear();
    this._springTier = 0;
    this._tetherTier = 0;
    this.pinnedUpgradeId = null;
    if (!Array.isArray(upgradeIds)) return;
    let restoredPin = null;
    for (const id of upgradeIds) {
      if (id === '_springTier') {
        this._springTier++;
      } else if (id === '_tetherTier') {
        this._tetherTier++;
      } else if (typeof id === 'string' && id.startsWith('__pin__')) {
        restoredPin = id.slice('__pin__'.length);
      } else {
        const current = this.purchasedUpgrades.get(id) || 0;
        this.purchasedUpgrades.set(id, current + 1);
      }
    }
    // Stale-save safety: drop the pin if it no longer exists in UPGRADES or is
    // already maxed after restoring purchases.
    if (restoredPin) {
      this.pinnedUpgradeId = restoredPin;
      this._clearStalePin();
    }
  }

  /**
   * Iterate all purchased upgrades, calling the callback with the full
   * upgrade data object for each level purchased. Used to re-apply
   * effects after restoring from a save.
   * @param {function({id:string, effect:string, value:*, level:number}):void} callback
   */
  forEachPurchasedUpgrade(callback) {
    for (const [id, level] of this.purchasedUpgrades) {
      const upgrade = UPGRADES.find(u => u.id === id);
      if (!upgrade) continue;
      for (let i = 1; i <= level; i++) {
        callback({
          id: id,
          effect: upgrade.effect,
          value: upgrade.value,
          level: i,
        });
      }
    }
    // Re-apply tier upgrades on restore
    if (this._springTier > 0) {
      callback({ id: '_springTier', effect: 'springTier', value: this._springTier, level: this._springTier });
    }
    if (this._tetherTier > 0) {
      callback({ id: '_tetherTier', effect: 'tetherTier', value: this._tetherTier, level: this._tetherTier });
    }
  }

  /** Get the current tether tier index (0-based). */
  getTetherTier() { return this._tetherTier; }

  show() {
    this.visible = true;
    this._applyTitle();
    this.refresh();
    this.element.style.display = 'flex';
    this.element.style.opacity = '1';
    eventBus.emit(Events.SHOP_OPENED);
  }

  /**
   * Lane 3d: with the map on the header says "RESUPPLY SATELLITE" (the game-over continue shop is the one full-screen shop that
   * still opens then: the workbench replaces it in play). Map off: the markup is never touched.
   * @private
   */
  _applyTitle() {
    const h = this.element && this.element.querySelector ? this.element.querySelector('h2') : null;
    if (!h) return;
    if (this._titleOrig === undefined) {
      if (shopTitle() === 'ORBITAL SUPPLY DEPOT') return;
      this._titleOrig = h.innerHTML;
    }
    h.innerHTML = shopTitle() === 'ORBITAL SUPPLY DEPOT' ? this._titleOrig : shopTitle();
  }

  hide() {
    this.visible = false;
    // S1 retention: broadcast the current (player-chosen) pin so the HUD widget
    // shows live progress until the next depot. No auto-pin: if the player
    // never pinned anything, nothing is manufactured here.
    this._emitPinnedUpgrade();
    this.element.style.opacity = '0';
    setTimeout(() => {
      if (!this.visible) this.element.style.display = 'none';
    }, 300);
  }

  // ========================================================================
  // S1 retention: pinned "next upgrade" chase target
  // ========================================================================

  /**
   * Resolve the pinned upgrade catalog row, or null if unset/stale/maxed.
   * Pure read — does NOT mutate `pinnedUpgradeId` (use `_clearStalePin()` to
   * drop an invalid pin).
   */
  getPinnedUpgrade() {
    if (!this.pinnedUpgradeId) return null;
    const u = UPGRADES.find((x) => x.id === this.pinnedUpgradeId);
    if (!u) return null;
    const level = this.purchasedUpgrades.get(u.id) || 0;
    if (level >= (u.maxLevel || 1)) return null;
    return u;
  }

  /** @private Drop the pin if it is stale (unknown id) or already maxed. */
  _clearStalePin() {
    if (this.pinnedUpgradeId && !this.getPinnedUpgrade()) {
      this.pinnedUpgradeId = null;
    }
  }

  /**
   * Pin (or re-pin) an upgrade as the chase target. Only gated-open, not-maxed,
   * non-consumable items are pinnable. Emits UPGRADE_PINNED.
   * @param {string} id
   * @returns {boolean} whether the pin was set
   */
  pinUpgrade(id) {
    const u = UPGRADES.find((x) => x.id === id);
    if (!u || u.consumable || u.maxLevel === Infinity) return false;
    const level = this.purchasedUpgrades.get(u.id) || 0;
    if (level >= (u.maxLevel || 1)) return false;
    if (!upgradePrereqsMet(u, this.purchasedUpgrades, (f) => Constants.isFeatureEnabled(f))) return false;
    this.pinnedUpgradeId = id;
    this._emitPinnedUpgrade();
    return true;
  }

  /** Toggle the pin on an upgrade (unpins if already pinned). */
  togglePin(id) {
    if (this.pinnedUpgradeId === id) {
      this.pinnedUpgradeId = null;
      this._emitPinnedUpgrade();
      return false;
    }
    return this.pinUpgrade(id);
  }

  /** @private Emit UPGRADE_PINNED with the current pin (or a cleared payload). */
  _emitPinnedUpgrade() {
    this._clearStalePin();
    const u = this.getPinnedUpgrade();
    const credits = this._scoringSystem ? this._scoringSystem.credits : scoringSystem.credits;
    eventBus.emit(Events.UPGRADE_PINNED, u
      ? { id: u.id, name: u.name, cost: u.cost, credits }
      : { id: null, name: null, cost: 0, credits });
  }
}

export default ShopScreen;
