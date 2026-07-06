/**
 * codexTriggers.js — unlock predicates for every codex entry, keyed by id.
 *
 * JSON (data/codex.json) holds entry *content*; predicates can't be JSON, so
 * they live here. Each id maps to an ARRAY of { event, match } triggers — an
 * entry unlocks when ANY of its triggers fires (this is how the Phase-1 dedupe
 * "unions" a survivor's trigger with its merged-away losers, and how the old
 * `_subsystemSourceMap` source catch-all is folded in explicitly).
 *
 *   match(payload) → boolean   // must not throw; treat missing fields as false
 *
 * Reachability of the comms-substring matches is guarded by
 * test-CodexReachability.js (corpus side) + its trigger-side self-validation.
 *
 * @module systems/codex/codexTriggers
 */

import { Events } from '../../core/Events.js';

// --- tiny matcher helpers (keep predicates terse + consistent) -------------
/** any-of, case-insensitive substring on p.text */
const txt = (...subs) => (p) => !!p && !!p.text && subs.some(s => p.text.toLowerCase().includes(s));
/** all-of, case-insensitive substring on p.text */
const txtAll = (...subs) => (p) => !!p && !!p.text && subs.every(s => p.text.toLowerCase().includes(s));
/** any-of, CASE-SENSITIVE substring on p.text (triggers that never lowercased) */
const txtCS = (...subs) => (p) => !!p && !!p.text && subs.some(s => p.text.includes(s));
/** SUBSYSTEM_EVENT source membership */
const src = (...sources) => (p) => !!p && sources.includes(p.source);
const always = () => true;
/** COMMS_MESSAGE from an ISRO ground station (case-insensitive source match). */
const isroComms = (p) => {
  const s = (p.source || '').toUpperCase();
  return s === 'BANGALORE' || s === 'HASSAN';
};

const E = Events;

/**
 * id → [{ event, match }]. Every entry in data/codex.json must have an entry
 * here (guarded by test-CodexData.js), or it can never unlock.
 * @type {Record<string, Array<{ event: string, match: (p:object)=>boolean }>>}
 */
export const CODEX_TRIGGERS = {
  // ===== ORBITAL_MECHANICS =====
  keplerian_orbit:        [{ event: E.STATE_CHANGE, match: (p) => p.newState === 'ORBITAL_VIEW' }],
  delta_v:                [{ event: E.PLAYER_TELEMETRY, match: (p) => p.xenonPct < 0.9 }],
  hohmann_transfer:       [{ event: E.COMMS_MESSAGE, match: txt('transfer') }],
  orbital_inclination:    [{ event: E.TARGET_SELECTED, match: always }],
  prograde_paradox:       [{ event: E.THROTTLE_CHANGE, match: always }],
  j2_perturbation:        [{ event: E.COMMS_MESSAGE, match: txtCS('predicted', 'drift') }],
  atmospheric_drag:       [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 5 }],
  relative_velocity:      [{ event: E.ARM_CAPTURED, match: always }],
  orbital_period_altitude:[{ event: E.AUTOPILOT_ENGAGE, match: always }],
  raan_precession:        [{ event: E.SUBSYSTEM_EVENT, match: (p) => p.source === 'SYSTEM' && !!p.text && p.text.includes('Ground station') }],

  // ===== PROPULSION =====
  feep_thruster:          [{ event: E.ARM_MANUAL_THRUST, match: always }],
  // survivor of ← specific_impulse_explained (union: SCORING_AWARD + FUEL_CHANGED)
  specific_impulse:       [{ event: E.SCORING_AWARD, match: (p) => !!p.reason && p.reason.includes('fuel') },
                           { event: E.FUEL_CHANGED, match: always }],
  xenon_propellant:       [{ event: E.PLAYER_TELEMETRY, match: (p) => p.xenonPct < 0.7 }],
  krypton_propellant:     [{ event: E.UPGRADE_APPLIED, match: (p) => !!p.id && p.id.includes('krypton') }],
  argon_propellant:       [{ event: E.UPGRADE_APPLIED, match: (p) => !!p.id && p.id.includes('argon') }],
  cold_gas_thruster:      [{ event: E.PLAYER_TELEMETRY, match: (p) => p.coldGasPct < 0.8 }],
  mpd_burst:              [{ event: E.MPD_BURST_START, match: always }],
  spring_energy:          [{ event: E.CROSSBOW_FIRE, match: always }],
  recoil_cancellation:    [{ event: E.DUAL_FIRE, match: always }],
  cold_gas_rcs:           [{ event: E.CONTROL_MODE_CHANGE, match: (p) => p.mode === 'COLD_GAS' }],
  feep_indium:            [{ event: E.FEEP_METAL_CHANGED, match: (p) => p.metal === 'indium' }],
  feep_gallium:           [{ event: E.FEEP_METAL_CHANGED, match: (p) => p.metal === 'gallium' }],
  feep_bismuth:           [{ event: E.FEEP_METAL_CHANGED, match: (p) => p.metal === 'bismuth' }],
  feep_iodine:            [{ event: E.FEEP_METAL_CHANGED, match: (p) => p.metal === 'iodine' }],
  feep_mercury:           [{ event: E.FEEP_METAL_CHANGED, match: (p) => p.metal === 'mercury' }],
  feep_cesium:            [{ event: E.FEEP_METAL_CHANGED, match: (p) => p.metal === 'cesium' }],
  feep_tungsten:          [{ event: E.FEEP_METAL_CHANGED, match: (p) => p.metal === 'tungsten' }],

  // ===== POWER =====
  solar_power:            [{ event: E.PLAYER_TELEMETRY, match: (p) => p.batteryPct < 0.5 }],
  eclipse_cycle:          [{ event: E.COMMS_MESSAGE, match: txt('shadow', 'eclipse') }],
  battery_chemistry:      [{ event: E.COMMS_MESSAGE, match: txt('battery cycle') },
                           { event: E.SUBSYSTEM_EVENT, match: src('POWER') }],
  supercapacitors:        [{ event: E.COMMS_MESSAGE, match: txt('supercapacitor') }],
  thermal_management:     [{ event: E.COMMS_MESSAGE, match: txt('thermal gradient') },
                           { event: E.SUBSYSTEM_EVENT, match: src('THERMAL') }],
  mli_insulation:         [{ event: E.COMMS_MESSAGE, match: txt('mli') }],
  multijunction_pv:       [{ event: E.UPGRADE_PURCHASED, match: (p) => p.id === 'multi_junction_solar' }],
  solid_state_battery:    [{ event: E.UPGRADE_PURCHASED, match: (p) => p.id === 'solid_state_battery' }],
  graphene_supercap:      [{ event: E.UPGRADE_PURCHASED, match: (p) => p.id === 'graphene_supercap' }],
  rtg_power:              [{ event: E.UPGRADE_PURCHASED, match: (p) => p.id === 'rtg_module' }],
  power_beaming:          [{ event: E.UPGRADE_PURCHASED, match: (p) => p.id === 'power_beaming' }],
  spin_stabilization:     [{ event: E.ABLATION_END, match: (p) => p.despinAchieved === true }],
  battery_cycles:         [{ event: E.SUBSYSTEM_EVENT, match: txt('battery') }],
  solar_cell_degradation: [{ event: E.SUBSYSTEM_EVENT, match: txt('solar uv') }],
  power_bus_management:   [{ event: E.POWER_BUS_SELECTED, match: always }],

  // ===== SPACE_ENVIRONMENT =====
  kessler_syndrome:       [{ event: E.STATE_CHANGE, match: (p) => p.newState === 'PLAYING' }],
  solar_storm:            [{ event: E.COMMS_MESSAGE, match: txt('solar') }],
  van_allen_belts:        [{ event: E.COMMS_MESSAGE, match: txt('radiation', 'van allen') }],
  // survivor of ← saa_radiation (identical trigger)
  south_atlantic_anomaly: [{ event: E.WEATHER_EFFECT_START, match: (p) => p.type === 'SAA_PASSAGE' }],
  // survivor of ← atomic_oxygen_erosion (+ STRUCTURE source catch-all)
  atomic_oxygen:          [{ event: E.COMMS_MESSAGE, match: txt('atomic oxygen') },
                           { event: E.SUBSYSTEM_EVENT, match: txt('atomic oxygen') },
                           { event: E.SUBSYSTEM_EVENT, match: src('STRUCTURE') }],
  // survivor of ← mmod_impact_physics
  mmod_impact:            [{ event: E.COMMS_MESSAGE, match: txt('mmod') },
                           { event: E.SUBSYSTEM_EVENT, match: txt('micrometeorite') }],
  uv_degradation:         [{ event: E.SUBSYSTEM_EVENT, match: txt('uv') }],
  geomagnetic_storm:      [{ event: E.WEATHER_EFFECT_START, match: (p) => p.type === 'GEOMAGNETIC_STORM' }],
  radiation_dose:         [{ event: E.SUBSYSTEM_EVENT, match: txt('radiation') }],

  // ===== MATERIALS =====
  graphene_gsl:           [{ event: E.ARM_CAPTURED, match: (p) => p.type === 'weaver' }],
  hbn_coating:            [{ event: E.SUBSYSTEM_EVENT, match: txt('atomic oxygen') }],
  kevlar_mli:             [{ event: E.CARGO_STORE, match: (p) => p.metalId === 'kevlar' }],
  // survivor of ← space_aluminum (union: metalId + type)
  aluminum_space:         [{ event: E.CARGO_STORE, match: (p) => p.metalId === 'aluminum' || p.type === 'aluminum' }],
  gallium_arsenide:       [{ event: E.CARGO_STORE, match: (p) => p.metalId === 'gallium' }],
  // survivor of ← titanium
  titanium_alloys:        [{ event: E.CARGO_STORE, match: (p) => p.metalId === 'titanium' || p.type === 'titanium' }],
  // survivor of ← carbon_composite
  carbon_composites:      [{ event: E.CARGO_STORE, match: (p) => p.metalId === 'carbon_composite' || p.type === 'carbon_composite' }],
  iridium_avionics:       [{ event: E.CARGO_STORE, match: (p) => p.metalId === 'iridium' }],

  // ===== TETHERS =====
  space_tether:           [{ event: E.ARM_DEPLOYED, match: always }],
  tether_reel_in:         [{ event: E.ARM_CAPTURED, match: always }],
  net_yo_yo_despin:       [{ event: E.NET_FIRED, match: always }],
  tether_materials:       [{ event: E.UPGRADE_APPLIED, match: (p) => !!p.id && p.id.includes('tether') }],
  tether_dynamics:        [{ event: E.TETHER_REEL_STATE, match: (p) => p.reeling === true }],
  tether_tangle_physics:  [{ event: E.TETHER_TANGLE, match: always }],
  // survivor of ← edt_propulsion (union: COMMS 'edt' + EDT_ATTRACT)
  edt_physics:            [{ event: E.COMMS_MESSAGE, match: txt('edt') },
                           { event: E.EDT_ATTRACT, match: always }],
  miura_ori_net:          [{ event: E.CROSSBOW_FIRE, match: always }],
  reel_mechanics:         [{ event: E.TETHER_REEL_STATE, match: (p) => p.reeling === true }],
  bolas_weapon:           [{ event: E.LASSO_FIRED, match: always }],

  // ===== DEBRIS =====
  hypervelocity:          [{ event: E.ARM_CAPTURED, match: always }],
  debris_tracking:        [{ event: E.SENSOR_UPGRADED, match: always }],
  debris_classification:  [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 10 }],
  trackable_vs_dark:      [{ event: E.UPGRADE_APPLIED, match: (p) => !!p.id && (p.id.includes('sensor') || p.id.includes('scan')) }],
  conjunction_assessment: [{ event: E.ARM_CAPTURED, match: always }],
  breakup_events:         [{ event: E.KESSLER_FRAGMENTS_ADDED, match: always }],
  iridium_cosmos:         [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 25 }],
  fengyun_test:           [{ event: E.KESSLER_CASCADE, match: always }],
  ssa_network:            [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 40 }],
  adr_methods_real:       [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 50 }],
  iss_saver:              [{ event: E.ISS_BOSS_RESOLVED, match: (p) => p.outcome === 'intercept' }],
  iss_pdam:               [{ event: E.ISS_BOSS_RESOLVED, match: (p) => p.outcome === 'decline' }],
  iss_hydrazine_burn:     [{ event: E.ISS_BOSS_RESOLVED, match: (p) => p.outcome === 'miss' }],
  hubble_watch:           [{ event: E.COMMS_MESSAGE, match: txtCS('Hubble') }],
  starlink_contained:     [{ event: E.STARLINK_BOSS_RESOLVED, match: (p) => p.outcome === 'contained' }],
  starlink_cascade:       [{ event: E.STARLINK_BOSS_RESOLVED, match: (p) => p.outcome === 'cascade' }],
  thaicom_graveyard:      [{ event: E.COMMS_MESSAGE, match: txtCS('Thaicom') }],

  // ===== SENSORS =====
  lidar_sensing:          [{ event: E.SENSOR_UPGRADED, match: always }],
  // survivor of ← star_tracker_nav (+ NAV source catch-all)
  star_tracker:           [{ event: E.COMMS_MESSAGE, match: txt('star tracker') },
                           { event: E.SUBSYSTEM_EVENT, match: txt('star tracker') },
                           { event: E.SUBSYSTEM_EVENT, match: src('NAV') }],
  imu_drift:              [{ event: E.COMMS_MESSAGE, match: txt('imu drift') }],
  docking_precision:      [{ event: E.COMMS_MESSAGE, match: txt('relative navigation') }],
  gps_denied:             [{ event: E.SUBSYSTEM_EVENT, match: txt('gps') }],
  kalman_filtering:       [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 20 }],
  pulse_scan_radar:       [{ event: E.PULSE_SCAN_COMPLETE, match: always }],
  lidar_ranging:          [{ event: E.ARM_CAPTURED, match: always }],
  // Phase 2d SENSORS fill — discovery via debris-clear thresholds (non-comms)
  sun_sensor:             [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 9 }],
  pose_estimation:        [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 19 }],

  // ===== ATTITUDE (split from SENSORS) =====
  // survivor of ← cmg_gyroscopes (union: COMMS 'reaction wheel' + SUBSYSTEM gyro/reaction wheel)
  reaction_wheels:        [{ event: E.COMMS_MESSAGE, match: txt('reaction wheel') },
                           { event: E.SUBSYSTEM_EVENT, match: txt('gyro', 'reaction wheel') }],
  magnetorquers:          [{ event: E.COMMS_MESSAGE, match: txt('magnetorquer') }],
  detumble:               [{ event: E.COMMS_MESSAGE, match: txt('tumble rate') }],
  // Phase 2d ATTITUDE fill — discovery via debris-clear thresholds (non-comms)
  attitude_control_system:      [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 6 }],
  rcs_attitude_control:         [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 12 }],
  control_moment_gyroscope:     [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 16 }],
  momentum_dumping:             [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 24 }],
  gravity_gradient_stabilization:[{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 34 }],

  // ===== AVIONICS (split from SENSORS) =====
  triple_redundancy:      [{ event: E.COMMS_MESSAGE, match: (p) => !!p.text && (p.text.toLowerCase().includes('tmr') || (p.text.toLowerCase().includes('triple') && p.text.toLowerCase().includes('redundancy'))) }],
  watchdog_timer:         [{ event: E.COMMS_MESSAGE, match: txt('watchdog') },
                           { event: E.SUBSYSTEM_EVENT, match: src('AVIONICS') }],
  telemetry:              [{ event: E.COMMS_MESSAGE, match: txt('telemetry frame') }],
  ecc_memory:             [{ event: E.COMMS_MESSAGE, match: txt('single-bit error') }],
  // Phase 2d AVIONICS fill — discovery via debris-clear thresholds (non-comms)
  onboard_computer:       [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 7 }],
  spacewire_bus:          [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 13 }],
  rad_hard_processor:     [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 17 }],
  fdir:                   [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 21 }],
  single_event_effects:   [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 27 }],

  // ===== COMMS =====
  // survivor of ← laser_comms_optical
  laser_comms:            [{ event: E.COMMS_MESSAGE, match: txt('laser comms') },
                           { event: E.SUBSYSTEM_EVENT, match: txt('laser comms') }],
  ground_station_window:  [{ event: E.COMMS_MESSAGE, match: txtAll('ground station', 'range') }],
  bandwidth_limits:       [{ event: E.COMMS_MESSAGE, match: txt('bandwidth') }],
  comms_blackout:         [{ event: E.COMMS_MESSAGE, match: txt('comms degraded') }],
  ground_station_pass:    [{ event: E.GROUND_STATION_PASS, match: always },
                           { event: E.SUBSYSTEM_EVENT, match: src('SYSTEM') }],
  telemetry_bandwidth:    [{ event: E.SUBSYSTEM_EVENT, match: txt('bandwidth') }],
  tdrs_relay:             [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 30 }],
  signal_propagation:     [{ event: E.COMMS_MESSAGE, match: (p) => p.source === 'HOUSTON' }],
  frequency_bands:        [{ event: E.WEATHER_EFFECT_END, match: (p) => p.type === 'SAA_PASSAGE' }],

  // ===== HERITAGE =====
  isro_why_india:         [{ event: E.COMMS_MESSAGE, match: isroComms }],
  isro_kulasekarapattinam:[{ event: E.COMMS_MESSAGE, match: isroComms }],
  isro_istrac:            [{ event: E.COMMS_MESSAGE, match: isroComms }],
  isro_launch_vehicles:   [{ event: E.COMMS_MESSAGE, match: isroComms }],
  space_elevator:         [{ event: E.GAME_WIN, match: (p) => p.winType === 'elevator' }],
  what_10000kg_buys:      [{ event: E.GAME_WIN, match: (p) => p.winType === 'elevator' }],
  jwst_horizon:           [{ event: E.GAME_WIN, match: (p) => p.winType === 'elevator' }],
  // Phase 2d HERITAGE fill — servicing/exposure legacy, discovery via debris-clear
  heritage_solar_max:        [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 36 }],
  heritage_ldef:             [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 44 }],
  heritage_hubble_servicing: [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 46 }],

  // ===== NEWS =====
  news_ast_spacemobile:   [{ event: E.NEWS_EVENT_TRIGGERED, match: (p) => p.eventId === 'ast_spacemobile_tumble' }],
  news_starlink_breakup:  [{ event: E.NEWS_EVENT_TRIGGERED, match: (p) => p.eventId === 'starlink_breakup' }],
  news_thaicom4:          [{ event: E.NEWS_EVENT_TRIGGERED, match: (p) => p.eventId === 'thaicom4_geo_derelict' }],

  // ===== Phase 2 — new concept entries =====
  cnt:               [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 30 }],
  carbyne:           [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 45 }],
  solar_wind:        [{ event: E.WEATHER_EFFECT_START, match: always }],
  rendezvous:        [{ event: E.AUTOPILOT_ARRIVED, match: always }],
  docking_berthing:  [{ event: E.ARM_CAPTURED, match: always }],
  // ===== CATALOG — discovery "trading cards", unlocked as you clear debris =====
  // (PLAYBOOK + WORLD_INDUSTRY entries are `startUnlocked` in data/codex.json —
  //  reference/onboarding material is readable from the first open, so it needs
  //  no trigger here. welcome_cowboy / world_adr_mandate triggers were removed.)
  catalog_envisat:        [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 7 }],
  catalog_vanguard1:      [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 4 }],
  catalog_les1:           [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 9 }],
  catalog_cosmos_iridium: [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 11 }],
  catalog_fengyun1c:      [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 15 }],
  // Phase 2c CATALOG marquee objects
  catalog_telstar1:       [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 5 }],
  catalog_kosmos482:      [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 8 }],
  catalog_sl16:           [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 13 }],
  catalog_cz5b:           [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 14 }],
  catalog_kosmos1408:     [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 18 }],
  // Phase 2c NEWS & EVENTS — real-world headlines, unlocked as you progress
  news_starlink_storm:    [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 3 }],
  news_tiangong_dodge:    [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 6 }],
  news_iss_pallet:        [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 10 }],
  news_aeolus_reentry:    [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 12 }],
  news_mev1_servicing:    [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 16 }],
  news_yunhai_collision:  [{ event: E.SCORE_UPDATE, match: (p) => p.debrisCleared >= 20 }],
};

export default CODEX_TRIGGERS;
