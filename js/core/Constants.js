/**
 * Constants.js — All game tuning knobs and physical constants
 * @module core/Constants
 */

export const Constants = {
  // === SCENE SCALE ===
  // 1 unit = 100 km. Requires logarithmicDepthBuffer: true.
  SCENE_SCALE: 0.01,
  EARTH_RADIUS: 63.71,            // 6371 km × 0.01
  EARTH_RADIUS_KM: 6371,

  // === PHYSICAL CONSTANTS ===
  MU_EARTH: 398600.4418,          // km³/s² — gravitational parameter
  J2: 1.08263e-3,                 // Earth oblateness coefficient
  G0: 9.80665,                    // m/s² — standard gravity
  SOLAR_FLUX: 1361,               // W/m² at 1 AU

  // === ORBITAL ALTITUDES (scene units = km × SCENE_SCALE) ===
  VLEO_MIN: 2.0,                  // 200 km × 0.01
  VLEO_MAX: 4.0,                  // 400 km × 0.01
  LEO_MAX: 20.0,                  // 2000 km × 0.01

  // === STARTING ORBIT ===
  START_ALTITUDE: 3.5,            // 350 km × 0.01
  START_ALTITUDE_KM: 350,

  // === RENDERING ===
  FLOATING_ORIGIN_ENABLED: true,    // UX-4: Camera-relative instanced mesh positions to avoid float32 jitter

  // === CAMERA ===
  CAMERA_NEAR: 0.00003,           // ~3 m minimum (lowered from 10m to prevent panel clipping at close zoom)
  CAMERA_FAR: 500,                // ~50,000 km maximum
  CAMERA_FOV: 55,                 // COMMAND/TACTICAL base FOV (ST-5.3: 65→55°)
  CAMERA_FOV_ARM_PILOT: 40,      // ARM_PILOT narrow FOV

  // === RESOURCE DEFAULTS ===
  XENON_FUEL_MAX: 100,            // kg
  COLD_GAS_MAX: 20,               // kg
  BATTERY_MAX: 100,               // Wh (simplified)
  SOLAR_PANEL_EFFICIENCY: 0.30,   // 30% efficient cells
  SOLAR_PANEL_AREA: 20,           // m²

  // === SCORING ===
  TIER1_BASE: 100,                // Data capture
  TIER2_BASE: 300,                // Deorbit
  TIER3_BASE: 500,                // Physical capture
  TIER4_BASE: 2000,               // Boss-class
  WIN_DEBRIS_COUNT: 50,

  // === DEBRIS TYPES ===
  DEBRIS_TYPES: {
    FRAGMENT:       'fragment',
    ROCKET_BODY:    'rocketBody',
    DEFUNCT_SAT:    'defunctSat',
    MISSION_DEBRIS: 'missionDebris',
  },

  // === DEBRIS TIERS (by difficulty) ===
  DEBRIS_TIER_RANGES: {
    fragment:       { tier: 1, label: 'Fragment' },
    rocketBody:     { tier: 3, label: 'Rocket Body' },
    defunctSat:     { tier: 2, label: 'Defunct Satellite' },
    missionDebris:  { tier: 1, label: 'Mission Debris' },
  },

  // === PHYSICS ===
  CATASTROPHIC_THRESHOLD: 40,     // J/g
  KESSLER_FRAGMENT_LIMIT: 50,
  LEO_AVG_COLLISION_VEL: 10,      // km/s
  LEO_MAX_COLLISION_VEL: 15.4,    // km/s
  LEO_MIN_ALT: 180,               // km — reentry threshold
  LEO_MAX_ALT: 2000,              // km — out of bounds

  // === TIME ===
  TIME_SCALE_TRANSFER: 60,        // 1 real sec = 60 game sec
  TIME_SCALE_GAMEPLAY: 10,        // 1 real sec = 10 game sec
  ORBITAL_PERIOD_400KM: 5556,     // seconds (~92.6 min)
  EARTH_ROTATION_PERIOD: 86400,   // seconds (24 h)
  CLOUD_ROTATION_FACTOR: 0.33,    // Clouds at 1/3 Earth speed

  // === ATMOSPHERE LAYERS (scene units, radii) ===
  CLOUD_RADIUS: 63.81,            // +10 km above surface
  ATMOSPHERE_RADIUS: 64.41,       // +70 km above surface

  // === EARTH RENDERING (ST-5.3) ===
  EARTH: {
    CLOUD_ROTATION_RATE: 0.00007,   // rad/s — sidereal-ish, visible drift over a game hour
    LOD_16K_THRESHOLD: 16384,       // renderer.capabilities.maxTextureSize >= → 16k textures
    LOD_8K_THRESHOLD: 8192,         //                                    >= → 8k textures
    VLEO_HOLD_SECONDS: 4,           // first-boot cinematic intro hold time
    VLEO_INTRO_CAMERA_SCALE: 3.0,   // chase-offset multiplier for cinematic establishing shot
    VLEO_INTRO_EASE_RATE: 2.5,      // per-second exponential ease rate back to normal
  },

  // === STARFIELD ===
  STAR_COUNT: 10000,
  STAR_SPHERE_RADIUS: 400,        // Must be < CAMERA_FAR (500)

  // =========================================================================
  // V3 OCTOPUS ADR SATELLITE (from V3 Octopus.md Appendix F)
  // 6-arm configuration: 3 Weaver (large) + 3 Spinner (small), hexagonal
  // V4 "Opussy" GSL upgrades available as unlockable tech path
  // =========================================================================

  // --- Core ("The Brain") ---
  OCTOPUS_CORE_DRY_MASS: 170,           // kg
  OCTOPUS_CORE_XENON: 40,               // kg propellant
  OCTOPUS_CORE_COLD_GAS: 6,             // kg N₂ RCS
  OCTOPUS_CORE_WET_MASS: 216,           // kg (170 + 40 + 6)
  OCTOPUS_CORE_BATTERY: 600,            // Wh
  OCTOPUS_CORE_SOLAR_AREA: 5.0,         // m² (2 wings)
  OCTOPUS_CORE_SOLAR_POWER: 1900,       // W peak
  OCTOPUS_CORE_LASER_POWER: 200,        // W electrical input
  OCTOPUS_CORE_LASER_OPTICAL: 120,      // W optical output (60% wall-plug)
  OCTOPUS_CORE_ACROSS_FLATS: 1.0,       // m (octagonal prism)
  OCTOPUS_CORE_LENGTH: 1.2,             // m
  OCTOPUS_CORE_HALL_THRUST: 0.01,       // N (2× HT-100, 10 mN each)
  OCTOPUS_CORE_HALL_ISP: 1500,          // s
  SATELLITE_ROTATION_RATE: 0.08,        // rad/s — manual arrow-key rotation (~4.6°/s, realistic for 500kg ADR satellite)

  // --- Weaver (Large Arm) — 3 units in hexagonal config ---
  WEAVER_COUNT: 3,
  WEAVER_MASS: 11.0,                    // kg per unit
  WEAVER_FUEL_MAX: 100,                 // game fuel units (maps to FEEP total impulse)
  WEAVER_DELTA_V: 500,                  // m/s total FEEP budget
  WEAVER_TOTAL_IMPULSE: 5500,           // Ns (Enpulsion NANO R3)
  WEAVER_THRUST: 0.00035,              // N (0.35 mN FEEP)
  WEAVER_TETHER_LENGTH: 2000,           // m (2 km)
  WEAVER_TETHER_REEL_SPEED: 2.0,       // m/s
  WEAVER_NET_SIZE: 5.0,                 // m (5×5 deployed Dyneema SK78)
  WEAVER_MAX_CAPTURE_MASS: 500,         // kg
  WEAVER_GRIPPER_SPAN: 0.05,           // m (50mm 3-jaw chuck, backup)
  WEAVER_LASER_POWER_RECV: 19.5,       // W at 2 km via 808nm PV
  WEAVER_SOLAR_POWER: 15,              // W peak (backup)
  WEAVER_BATTERY: 25,                   // Wh
  WEAVER_COLD_GAS: 0.2,               // kg N₂ (rapid attitude during capture)
  WEAVER_BODY: [0.2, 0.2, 0.3],       // m [x, y, z] dimensions
  WEAVER_CAPTURES_PER_FUEL: 33,        // captures before FEEP depletion

  // --- Spinner (Small Arm) — 3 units in hexagonal config ---
  SPINNER_COUNT: 3,
  SPINNER_MASS: 3.7,                    // kg per unit
  SPINNER_FUEL_MAX: 100,                // game fuel units
  SPINNER_DELTA_V: 297,                 // m/s total FEEP budget
  SPINNER_TOTAL_IMPULSE: 1100,          // Ns (Enpulsion IFM Nano SE)
  SPINNER_THRUST: 0.0005,             // N (0.5 mN FEEP)
  SPINNER_TETHER_LENGTH: 500,           // m (0.5 km)
  SPINNER_TETHER_REEL_SPEED: 2.0,      // m/s
  SPINNER_NET_SIZE: 1.5,                // m (1.5×1.5 deployed)
  SPINNER_MAX_CAPTURE_MASS: 10,         // kg
  SPINNER_GECKO_PAD_FORCE: 3.5,        // N/cm² (PDMS Van der Waals)
  SPINNER_LASER_POWER_RECV: 19.5,      // W at 1 km
  SPINNER_SOLAR_POWER: 8,              // W peak (backup)
  SPINNER_BATTERY: 10,                  // Wh
  SPINNER_BODY: [0.1, 0.1, 0.15],     // m [x, y, z] dimensions
  SPINNER_CAPTURES_PER_FUEL: 37,       // captures before FEEP depletion

  // --- Tether ---
  TETHER_LINEAR_DENSITY: 1.2,          // kg/km (Dyneema/Vectran/Cu/SMA ribbon)
  TETHER_TENSILE_STRENGTH: 500,        // N (5× safety margin over 100N design load)
  TETHER_WIDTH: 0.003,                  // m (3 mm ribbon)
  TETHER_THICKNESS: 0.0001,            // m (0.1 mm)
  TETHER_REEL_POWER: 15,               // W per reel motor
  TETHER_EDT_CURRENT: 0.1,             // A (100 mA for Lorentz EDT propulsion)
  TETHER_EDT_FORCE_PER_KM: 1.65,       // mN per km at 100 mA in 30 µT

  // --- Tether Visual ---
  // Dyneema SK78 fiber — naturally white, dyed hi-vis for space operations.
  // Nominal: cream-white matching Dyneema drum material. Stressed/Critical: warning amber/red.
  TETHER_COLOR_NOMINAL: 0xddddee,
  TETHER_COLOR_STRESSED: 0xffaa00,
  TETHER_COLOR_CRITICAL: 0xff0000,
  TETHER_SEGMENTS: 24,                 // line segments for catenary render
  TETHER_SAG_FACTOR: 0.015,           // catenary sag amplitude as fraction of current separation
  TETHER_SAG_PARALLEL_THRESHOLD: 1e-6, // threshold for tether-parallel-to-gravity degeneracy detection

  // --- Docking (EPM — Electro-Permanent Magnets) ---
  DOCK_EPM_HOLD_FORCE: 50,             // N (pair of modules, zero power)
  DOCK_EPM_SWITCH_ENERGY: 0.5,         // J per toggle (100ms pulse)
  DOCK_EPM_MASS_PER_CAVITY: 0.08,     // kg (pair)
  DOCK_CONE_HALF_ANGLE: 15,            // degrees — guide funnel acceptance
  DOCK_ALIGNMENT_TOLERANCE: 0.02,      // m (±2 cm)

  // --- Optical System ---
  OPTICAL_RANGE_ACCURACY: 0.02,        // m (±2 cm via TDC7200 ToF)
  OPTICAL_BEARING_ACCURACY: 0.1,       // degrees (quad detector at 2 km)
  OPTICAL_COMMS_RATE: 1000000,         // bps (1 Mbps via MRR)
  OPTICAL_BEAM_DIVERGENCE: 0.00005,    // rad (50 µrad half-angle)

  // --- Arm State Machine ---
  ARM_STATES: {
    DOCKED: 'DOCKED',
    UNDOCKING: 'UNDOCKING',
    TRANSIT: 'TRANSIT',
    APPROACH: 'APPROACH',
    NETTING: 'NETTING',
    GRAPPLED: 'GRAPPLED',
    HAULING: 'HAULING',
    RETURNING: 'RETURNING',
    DOCKING: 'DOCKING',
    FISHING: 'FISHING',            // Passive ambush — hibernate on tether, auto-capture on proximity
    TRAWLING: 'TRAWLING',          // Slow sweep — passive debris collection along orbit path
    DEORBITING: 'DEORBITING',      // One-way sacrifice — burning all fuel retrograde (Session 10)
    WEB_SHOT: 'WEB_SHOT',          // Brief GSL web shot launch animation (Sprint D1)
    LAUNCHING: 'LAUNCHING',        // V5 — Replaces UNDOCKING — crossbow spring release (0.05s)
    REELING: 'REELING',            // V5 — Replaces HAULING — zero-fuel motor reel-in
    RELOADING: 'RELOADING',        // V5 — worm gear compresses spring
    ABLATING: 'ABLATING',          // V5 — 10W laser de-spin/nudge
    SCANNING: 'SCANNING',          // V5 — pulse scan distributed sensor array
    TANGLED: 'TANGLED',            // V5 — tether tangle state requiring resolution
    STATION_KEEP: 'STATION_KEEP',  // V8 — hold position relative to debris (orbital-crane)
    EXPENDED: 'EXPENDED',
  },

  // --- Arm Operations ---
  ARM_DETACH_DURATION: 2.0,            // seconds (real-time undock animation)
  ARM_DOCK_DURATION: 3.0,              // seconds (real-time re-dock)
  ARM_NET_DEPLOY_TIME: 3.0,            // seconds (Miura-ori unfold + SMA cinch)
  ARM_GRAPPLE_STABILIZE: 1.5,          // seconds (stabilization after capture)
  ARM_CAPTURE_SUCCESS_RATE: 0.85,      // 85% net capture success (legacy; gated off when CAPTURE_NET ON)

  // Per-arm net inventory capacity (§13 Q5 — depletion is a real Y0 fail state)
  // Mass budget anchor: M-NET ~1,265 g vs 6,600 g Weaver = 19% per net;
  // SD-NET ~360 g vs 2,100 g Spinner = 17% per net. Uniform 2/arm = "one mulligan".
  ARM_NET_CAPACITY: {
    weaver:  2,
    spinner: 2,
  },

  // --- Arm Approach Speeds (scene units/s — 1 unit = 100 km) ---
  // 0.5 m/s real = 0.000005 scene units/s
  ARM_APPROACH_SPEED: 0.000005,        // m/s (0.5 m/s closing)
  ARM_HAUL_SPEED: 0.0000025,           // m/s (0.25 m/s loaded return)

  // --- Total System (3W + 3S configuration) ---
  OCTOPUS_TOTAL_WET_MASS: 260,         // kg (216 core + 33 Weavers + 11.1 Spinners)
  OCTOPUS_TOTAL_DRY_MASS: 214,         // kg (without propellant)
  OCTOPUS_ARM_COUNT: 6,                // 3 Weaver + 3 Spinner

  // --- Web Shot (Sprint D1) ---
  WEB_SHOT_DURATION: 2.0,                // seconds — launch animation
  WEB_SHOT_COOLDOWN: 10.0,               // seconds between shots
  WEB_SHOT_DRAG_MULT: 5.0,               // drag multiplier applied to hit debris
  WEB_SHOT_FUEL_COST: 3.0,               // fuel % consumed per shot
  WEB_SHOT_DEORBIT_ALT_KM: 150,          // altitude below which debris burns up (km)
  WEB_SHOT_DECAY_RATE: 0.00002,          // SMA decay per second (scene units) at 1× drag
  WEB_SHOT_DEORBIT_SCORE: 300,           // points awarded for web-shot de-orbit

  // --- V4 "Opussy" GSL Upgrade Multipliers (unlockable) ---
  V4_TETHER_MASS_MULT: 0.167,         // GSL tether 6× lighter (0.20 vs 1.2 kg/km)
  V4_NET_MASS_MULT: 0.08,             // GSL net 92% lighter
  V4_TETHER_LENGTH_MULT: 6.25,        // Same mass → 6.25× longer reach (12.5 km)
  V4_NET_SIZE_MULT: 10.0,             // Same mass → 10× net area (50×50m)
  V4_ELECTROSTATIC_FORCE: 160,        // N (HBN-coated GSL at 3 kV)
  V4_SYSTEM_MASS_SAVINGS: 17.3,       // kg lighter than V3

  // ============================================================================
  // OCTOPUS V5 BASELINE (Epic 9 — V5 Hardware)
  // Consolidated parameter block for the V5 satellite (Hex Umbrella default).
  // Mirrors V3 OCTOPUS_* flat-key structure for downstream consistency.
  // Detailed crossbow/tether/spring sub-systems remain in their own blocks below.
  // ============================================================================
  OCTOPUS_V5: {
    // ── Barrel Geometry (CHANGED: 1.2×1.0 → 2.0×0.8 Config G) ──
    CORE_LENGTH: 2.0,              // m — was 1.2
    CORE_ACROSS_FLATS: 0.8,        // m — was 1.0
    CORE_ASPECT_RATIO: 2.5,        // NEW

    // ── Collar (NEW) ──
    COLLAR_Y: 0.90,                // m from barrel center (+Y)
    COLLAR_RADIUS: 0.40,           // m

    // ── Strut (NEW — replaces short-strut spec) ──
    STRUT_LENGTH: 1.60,            // m (hinge to daughter dock)
    STRUT_TUBE_OD: 0.050,          // m
    STRUT_TUBE_WALL: 0.002,        // m
    STRUT_MASS: 4.5,               // kg (structure + reel + spring + hinge)
    STRUT_SWEEP_MIN: 0,            // rad
    STRUT_SWEEP_MAX: Math.PI,      // rad (180°)
    STRUT_SLEW_RATE: 15 * Math.PI / 180, // rad/s (15°/s — slowed 50% so new players can see strut deploy)

    // ── Recoil Safety (NEW — ST-9.3 C-3) ──
    HIGH_RECOIL_ALPHA_LOW:  Math.PI / 6,     // rad (30°) — below this = high axial recoil
    HIGH_RECOIL_ALPHA_HIGH: 5 * Math.PI / 6, // rad (150°) — above this = high axial recoil
    FIRE_RATE_INTERLOCK: 0.5 * Math.PI / 180, // rad/s (0.5°/s) — ω threshold to block fire
    HINGE_SETTLE_TIME: 0.5,                   // seconds — auto-unlock delay after fire recoil settles

    // ── 3-Plane Layout (NEW) ──
    ROSA_PLANE_AZIMUTH: 0,         // rad (0° and 180° plane)
    ARM_PLANE_OFFSET: Math.PI / 3, // rad (60° from ROSA)
    // Derived: arm azimuths [60°, 120°, 240°, 300°] for Y0 Quad

    // ── ROSA Panels (NEW — replaces rigid wing spec) ──
    ROSA_WIDTH: 1.0,               // m
    ROSA_LENGTH: 2.0,              // m
    ROSA_CHAMFER: 0.30,            // m
    ROSA_POWER: 1630,              // W (ROSA alone)
    BODY_MOUNT_POWER: 610,         // W (GaAs)
    TOTAL_SOLAR_POWER: 2240,       // W (combined)
    ROSA_DEPLOY_DURATION_S: 6.0,   // seconds per wing (ST-9.11 C-5)

    // ── Hinge (NEW) ──
    HINGE_LOCK_TORQUE: 1000,       // N·m
    HINGE_MOTOR_TORQUE: 10,        // N·m
    HINGE_BEARING: 'Si3N4_MoS2',

    // ── Launch Vehicle (NEW) ──
    LAUNCH_VEHICLE: 'SSLV',
    FAIRING_DIAMETER: 2.1,         // m
    FAIRING_LENGTH: 2.5,           // m
    STOWED_ENVELOPE_DIA: 1.2,      // m
    STOWED_ENVELOPE_LEN: 2.3,      // m

    // ── Mass Budget (UPDATED for Config G — §10.11 canonical) ──
    TOTAL_DRY_MASS: 196.4,         // was 198.4
    TOTAL_WET_MASS: 242.4,         // was 244.4
    CORE_DRY_MASS: 161.0,          // was 170 — bus + ROSA + body-mount
    CORE_WET_MASS: 216,            // unchanged (carries forward propellant calc)
    WEAVER_MASS: 6.6,              // unchanged
    SPINNER_MASS: 2.1,             // unchanged
    FRONT_ARM_MASS: 6.6,           // retained for Y3
    BACK_ARM_MASS: 6.6,            // retained for Y3

    // ── Arm Counts (keeping same structure) ──
    ARM_COUNT: 4,
    WEAVER_COUNT: 2,
    SPINNER_COUNT: 2,
    FRONT_ARM_COUNT: 0,
    BACK_ARM_COUNT: 0,

    // ── Geometry (DEPRECATED equatorial values → Config G replacements) ──
    BACK_ARM_OFFSET: 0.3,          // DEPRECATED — no back arm at Y0

    // ── Power & Thrust (carried forward) ──
    CORE_BATTERY: 600,             // Wh
    CORE_SOLAR_AREA: 5.0,          // m²
    CORE_SOLAR_POWER: 1900,        // W — DEPRECATED, use TOTAL_SOLAR_POWER
    CORE_LASER_POWER: 200,         // W
    CORE_LASER_OPTICAL: 120,       // W
    CORE_HALL_THRUST: 0.01,        // N
    CORE_HALL_ISP: 1500,           // s

    // ── Tether (unchanged) ──
    TETHER_LENGTH_DEFAULT: 2000,   // m
    TETHER_MATERIAL: 'Dyneema SK78',

    // ── Strut-Mounted Reel (NEW — ST-9.5 C-7, Config G §10.4) ──
    // Reel housing sits on the strut near the tip (not at arm base).
    // Cable pays out from reel toward working end (target debris, daughter, etc.).
    REEL: {
      MAX_CABLE_LENGTH_M: { Y0: 50, Y1: 80, Y3: 120 },  // per arm tier
      PAYOUT_RATE_M_PER_S: 5.0,       // max pay-out rate
      REEL_IN_RATE_M_PER_S: 2.0,      // base reel-in rate (scales down with payload mass)
      BREAKING_TENSION_N: 800,         // Dyneema SK78 break threshold
      CABLE_MASS_PER_M_KG: 0.05,      // kg per metre of cable
      JAM_PROBABILITY_PER_REEL: 0.005, // per reel-in cycle
      CABLE_SPRING_K: 500,             // N/m — taut cable restoring force (Hooke)
      CABLE_DAMPING_C: 50,             // N·s/m — damping coefficient
      JAM_CLEAR_COOLDOWN_S: 5.0,       // seconds cooldown before clearJam available
      REEL_MASS_KG: 1.2,              // kg — reel housing mass (included in STRUT_MASS 4.5)
      MOTOR_POWER_W: 15,              // watts — reel motor draw from arm power bus
      TENSION_WARNING_FRAC: 0.75,     // fraction of breaking tension → debounced warning
    },

    // ── Bridle Ring (NEW — ST-9.7 C-8, Config G simplified) ──
    // Simple load-distribution ring at strut tip. Replaces Y-harness (superseded).
    // Cable exits from strut-tip reel through bridle ring to capture devices.
    BRIDLE: {
      ATTACH_POINTS_PER_RING: 3,       // 3 hardpoints per ring
      MAX_LOAD_PER_POINT_KG: 200,      // kg — max load per single attach point
      RING_MASS_KG: 0.3,              // kg — ring structural mass (small)
      OVERLOAD_FACTOR: 1.2,           // load > 120% of max → DAMAGED state
    },
  },

  // ============================================================================
  // ST-9.2 ARM TECH LADDER — Quad Y0 → Hex Y1 → Octo Y3
  // Progression from 4 to 8 arms. Hex/Octo gated by FEATURE_FLAGS.SHIPYARD_REFIT.
  // See CROSSBOW_ARMS.md §12.5 + §25 for mass derivation.
  // ============================================================================
  ARM_LADDER: {
    Y0_QUAD: { armCount: 4, weaverCount: 2, spinnerCount: 2, frontArmCount: 0, backArmCount: 0, dryMass: 196.4, wetMass: 242.4, unlocked: true,  tier: 0, azimuths: [60, 120, 240, 300] },
    Y1_HEX:  { armCount: 6, weaverCount: 3, spinnerCount: 3, frontArmCount: 0, backArmCount: 0, dryMass: 208.0, wetMass: 254.0, unlocked: false, tier: 1, azimuths: [30, 90, 150, 210, 270, 330] },
    Y3_OCTO: { armCount: 8, weaverCount: 3, spinnerCount: 3, frontArmCount: 1, backArmCount: 1, dryMass: 222.0, wetMass: 268.0, unlocked: false, tier: 3, azimuths: [30, 90, 150, 210, 270, 330], endFaceArms: ['+Z', '-Z'] },
  },

  // ============================================================================
  // EPIC 9 FEATURE FLAGS (default false; flipped on per shipyard/shop unlock)
  // ST-9.9 Reality Mode toggle forces ALL of these to false at runtime.
  // ============================================================================
  FEATURE_FLAGS: {
    SHIPYARD_REFIT:        false,  // ST-9.2 — Quad/Hex/Double config switching
    CROSSBOW_MECHANISM:    false,  // ST-9.3 — full spring physics + 2-DOF + interlock
    DUAL_OPPOSITE_FIRE:    false,  // ST-9.3 — recoil-cancelling pair fire
    NET_TERMINOLOGY:       false,  // ST-9.4 — Capture Net terminology refit
    NET_PRIMARY_DOCTRINE:  false,  // ST-9.4 — net primary, bola secondary
    NET_CLING_MODEL:       false,  // ST-9.4c — cling probability + empty-net + mercy rule
    NET_TANGLE_MECHANICS:  false,  // ST-9.4d — 5-scenario tangle detection + recovery
    PER_PLATFORM_NETS:     false,  // ST-9.4e — Large/Medium/Small Net per-platform classes
    DYNEEMA_TETHER:        false,  // ST-9.5 — Dyneema SK78 + reel-cycle wear
    REEL_CYCLE_RESOURCE:   false,  // ST-9.5 — 20-cycle wear counter
    ABLATION_MODULE:       false,  // ST-9.6 — mother-mounted deorbit laser
    BRIDLE_RING_GEOMETRY:  false,  // ST-9.7 — Y-harness FEEP plume exclusion
    TECH_LADDER_SHOP:      false,  // ST-9.8 — Y0–Y4 tier surfacing
    REALITY_MODE:          false,  // ST-9.9 — locks all FEATURE_* false (master)

    // NEW — Epic 9 Config G gaps
    STOW_DEPLOY_STATE_MACHINE: false,  // ST-9.10 — arm stow/deploy gating
    LAUNCH_SEQUENCE:           false,  // ST-9.11 — launch lock cinematic
    COM_TRACKING:              false,  // ST-9.12 — center-of-mass tracking
    THRUSTER_INTERLOCK:        false,  // ST-9.12 — plume geometry check
    SEMI_AUTO_AIM:             false,  // ST-9.3  — Mother auto-rotation aim
    LOCKABLE_HINGE:            false,  // ST-9.3  — ROTATE ↔ LOCKED hinge

    // NEW — ST-9.4 C-6: Capture Net System
    CAPTURE_NET:               true,   // ST-9.4  — full capture net projectile + inventory (P1 ON)

    // NEW — ST-9.5 C-7: Strut-Mounted Tether Reel
    TETHER_REEL:               false,  // ST-9.5 C-7 — strut-mounted reel state machine + cable physics

    // NEW — ST-9.7 C-8: Bridle Ring (simplified Config G)
    BRIDLE_RING:               false,  // ST-9.7 C-8 — strut-tip load-distribution ring

    // NEW — ST-9.8 C-10: Arm Tier Upgrades (shop entries)
    TIER_UPGRADES:             false,  // ST-9.8 C-10 — Y0/Y1/Y3 tier shop entries + upgrade flow

    // NEW — C-11 Integration: Recoil Physics (deferred from C-3)
    RECOIL_PHYSICS:            false,  // C-11 — angular impulse from dual-fire applied to Mother
  },

  // ============================================================================
  // ARM TIER UPGRADE ECONOMY — ST-9.8 C-10
  // Costs match IMPLEMENTATION_PLAN.md §ST-9.8 (5 000 / 15 000 credits).
  // TRL gates: Y1 ≥ 6, Y3 ≥ 8.  Debris-cleared thresholds map progression
  // to effective TRL (display-only TRL values exist on other shop items).
  // ============================================================================
  ARM_TIER_COSTS: {
    Y1_HEX:  5000,
    Y3_OCTO: 15000,
  },
  ARM_TIER_TRL_GATE: {
    Y1_HEX:  6,
    Y3_OCTO: 8,
  },
  ARM_TIER_DEBRIS_GATE: {
    Y1_HEX:  15,   // debris cleared ≥ 15 → effective TRL 6
    Y3_OCTO: 30,   // debris cleared ≥ 30 → effective TRL 8
  },

  // =========================================================================
  // CONFIG G REEL STATES (NEW — for ST-9.5 C-7)
  // =========================================================================
  REEL_STATES: {
    STOWED:      'STOWED',       // cable fully spooled, no load
    PAYING_OUT:  'PAYING_OUT',   // cable extending; rate-limited by reel motor
    STATIC:      'STATIC',       // cable paid out, no movement
    REELING_IN:  'REELING_IN',   // retracting; speed scales with payload mass
    JAMMED:      'JAMMED',       // physical jam; clear via clearJam (player action with cooldown)
    CUT:         'CUT',          // terminal; cable lost; reel must be reloaded
  },

  // =========================================================================
  // CONFIG G BRIDLE RING STATES (NEW — for ST-9.7 C-8)
  // =========================================================================
  BRIDLE_STATES: {
    IDLE:       'IDLE',        // ring empty, no payloads attached
    ATTACHED:   'ATTACHED',    // one or more payloads attached, within load limits
    OVERLOADED: 'OVERLOADED',  // load exceeds max but not yet damaged
    DAMAGED:    'DAMAGED',     // load exceeded OVERLOAD_FACTOR — ring structurally compromised
  },

  // =========================================================================
  // CONFIG G DEPLOY STATES (NEW — for ST-9.10)
  // =========================================================================
  DEPLOY_STATES: {
    LOCKED:    'LOCKED',     // launch lock engaged
    STOWED:    'STOWED',     // free but folded (α ≈ 0)
    DEPLOYING: 'DEPLOYING',  // motor driving open
    DEPLOYED:  'DEPLOYED',   // at target α
    STOWING:   'STOWING',    // motor driving closed
  },

  // =========================================================================
  // CONFIG G HINGE STATES (NEW — for ST-9.3 #9)
  // =========================================================================
  HINGE_STATES: {
    ROTATE: 'ROTATE',   // motor active, brake disengaged
    LOCKED: 'LOCKED',   // brake engaged, motor off
  },

  // =========================================================================
  // CONFIG G PLUME CLEARANCE (NEW — for ST-9.12 #8)
  // =========================================================================
  PLUME_HALF_ANGLE: 35 * Math.PI / 180,  // rad (35°)
  COM_DRIFT_WARN_THRESHOLD: 0.020,       // m (20mm)
  COM_BALANCED_THRESHOLD: 0.005,         // m (5mm)

  // =========================================================================
  // MAIN THRUSTER NOZZLE GEOMETRY (NEW — ST-9.12 C-9, Gap #8)
  // =========================================================================
  // 4 main dual-metal FEEP thrusters on the aft face (−Z), cross pattern.
  // Positions match PlayerSatellite._buildThrusters() visual placement (in meters).
  // Config G clearance analysis (ARM_PIVOT_GAPS_EXPLAINER §8):
  //   Nearest arm plane is 60° from thrust axis (ROSA at 0°/180°, arms at 60°/120°/240°/300°).
  //   Plume half-angle 35° → minimum angular clearance = 60° − 35° = 25°.
  //   At standard deploy angles (α ∈ [0, π]), ring-arm strut tips remain well outside
  //   the −Z plume cone. Edge case: Y3 Octo end-face arm (−Z) at α≈π/2 places tip
  //   at z ≈ −2.0 m, directly in the thruster plane — interlock required for Octo tier.
  THRUSTERS: [
    { id: 'HT_TOP',    nozzlePos: { x:  0,    y:  0.5,  z: -2.0 }, thrustDir: { x: 0, y: 0, z: -1 } },
    { id: 'HT_BOTTOM', nozzlePos: { x:  0,    y: -0.5,  z: -2.0 }, thrustDir: { x: 0, y: 0, z: -1 } },
    { id: 'HT_RIGHT',  nozzlePos: { x:  0.5,  y:  0,    z: -2.0 }, thrustDir: { x: 0, y: 0, z: -1 } },
    { id: 'HT_LEFT',   nozzlePos: { x: -0.5,  y:  0,    z: -2.0 }, thrustDir: { x: 0, y: 0, z: -1 } },
  ],

  // =========================================================================
  // LAUNCH SEQUENCE (NEW — for ST-9.11 #7)
  // =========================================================================
  LAUNCH_SEQUENCE_ENABLED: true,
  LAUNCH_PYRO_DELAY: 40,                 // seconds after orbit insertion
  LAUNCH_LOCK_COUNT: 3,                  // pyro pins per arm
  PYRO_PIN_MASS: 0.005,                  // kg per pin
  FAIRING_SEP_DELAY_S: 4.0,             // seconds from liftoff to fairing sep (ST-9.11 C-5)
  ORBIT_INSERTION_DELAY_S: 4.0,          // seconds from fairing sep to orbit insertion (ST-9.11 C-5)
  LAUNCH_LOCK_STAGGER_S: 0.1,           // seconds between per-arm pyro releases (ST-9.11 C-5)

  // =========================================================================
  // V5 CROSSBOW ARMS — Spring-launched tethered arms with reel-in capture
  // See CROSSBOW_ARMS.md for full specification
  // =========================================================================

  // ── V5 Crossbow Arms ──

  // --- Crossbow Spring Physics ---
  CROSSBOW_DRAW_DISTANCE: 0.25,           // meters — spring compression distance
  CROSSBOW_SPRING_K_WEAVER: 17600,        // N/m — spring constant for 11kg Weaver at 10 m/s
  CROSSBOW_SPRING_K_SPINNER: 5920,        // N/m — spring constant for 3.7kg Spinner at 10 m/s
  CROSSBOW_RELEASE_TIME: 0.05,            // seconds — spring release duration (40ms)
  CROSSBOW_UNDOCK_TIME: 1.5,              // seconds — magnetic clamp release + crossbow charge
                                           // (increased from 0.3s so player sees strut aim + charge before launch)
  CROSSBOW_LAUNCH_SPEED_DEFAULT: 10.0,    // m/s — default launch speed (physically justified)
  CROSSBOW_LAUNCH_SPEED_MIN: 3.0,         // m/s — minimum selectable launch speed
  CROSSBOW_LAUNCH_SPEED_MAX: 20.0,        // m/s — maximum selectable launch speed

  // --- Reload Mechanism ---
  CROSSBOW_RELOAD_POWER: 15,              // watts — worm gear motor power draw
  CROSSBOW_RELOAD_TIME_SPINNER_10: 20,    // seconds — Spinner reload at 10 m/s
  CROSSBOW_RELOAD_TIME_WEAVER_10: 37,     // seconds — Weaver reload at 10 m/s
  CROSSBOW_RELOAD_TIME_MULT: 0.37,        // reload time scales as v² — t = E/(P×η), η=0.80
  CROSSBOW_WORM_GEAR_EFFICIENCY: 0.80,    // 80% mechanical efficiency

  // --- Tether Reel (on mothership) ---
  REEL_IN_SPEED_EMPTY: 2.0,              // m/s — reel-in speed unloaded (game-scale)
  REEL_IN_SPEED_LOADED: 4.0,             // m/s — reel-in speed with captured debris (POLISH: bumped from 1.4 for snappier retrieval)
  REEL_MOTOR_POWER: 25,                  // watts — reel motor power draw
  REEL_BRAKE_FORCE_MAX: 500,             // N — maximum magnetic clutch brake force
  REEL_TENSION_WARNING: 0.7,             // fraction of break strength → yellow HUD
  REEL_TENSION_CRITICAL: 0.9,            // fraction of break strength → red HUD
  REEL_LEVEL_WIND_SPEED: 0.02,           // m/s — traverse speed for even spooling

  // --- Dual-Fire / Recoil ---
  DUALFIRE_SYNC_WINDOW: 0.01,            // seconds — max timing offset for dual fire
  DUALFIRE_RECOIL_WEAVER: 0.509,         // m/s — single Weaver recoil on 130kg mothership
  DUALFIRE_RECOIL_SPINNER: 0.171,        // m/s — single Spinner recoil
  DUALFIRE_RCS_COMPENSATION_N2: 3.7,     // grams N₂ — RCS cost per single Weaver shot

  // --- Pulse Scan ---
  PULSE_SCAN_DURATION: 2.0,              // seconds — all arms fire simultaneously
  PULSE_SCAN_RANGE_MULT: 1.5,            // range multiplier vs single arm sensor
  PULSE_SCAN_COOLDOWN: 30.0,             // seconds — cooldown between pulse scans
  PULSE_SCAN_POWER: 50,                  // watts — total power draw during scan

  // =========================================================================
  // ACTIVE SCAN SYSTEM — Player-initiated scanning for treasure hunting
  // =========================================================================
  SCAN: {
    REVEAL_BASE_RANGE: 5.0,   // 500 km in scene units — base radius for scan target reveal (UX-3 #9)
    REVEAL_STAGGER_MS: 120,   // ms between each target reveal (smooth, snappy cadence)
    SESSION_SCAN_CAP: 5000,   // S2.4: max total scan credits per session (anti-spam)
    QUICK: {
      DURATION: 0.3,          // seconds to complete quick scan (fast S→reward feedback)
      COOLDOWN: 5.0,          // seconds between quick scans (raised from 3.0 — anti-spam)
      POWER_COST: 0.05,       // fraction of sensor bus power
      DISCOVERY_CHANCE: 0.20, // 20% chance to find hidden debris
      REWARD: 50,             // base credits for survey data (modified by diminishing returns)
      RANGE_MULTIPLIER: 1.0,  // uses current sensor range
      MAX_REVEALS: 5,         // targets discovered per quick scan (UX-3 #9)
    },
    WIDE: {
      DURATION: 4.0,          // seconds for wide aperture scan
      COOLDOWN: 8.0,          // seconds between wide scans
      POWER_COST: 0.15,       // higher power draw
      DISCOVERY_CHANCE: 0.40, // 40% chance to find hidden debris
      REWARD: 150,            // credits for deep survey data
      DISCOVERY_REWARD: 100,  // bonus per new contact found
      RANGE_MULTIPLIER: 2.0,  // double current sensor range
      MAX_DISCOVERIES: 3,     // up to 3 hidden objects per scan
      MAX_REVEALS: 10,        // targets discovered per wide scan (UX-3 #9)
    },
  },

  // =========================================================================
  // AUTO-TOOL RECOMMENDATION — MW2-style auto-pick for best capture tool
  // =========================================================================
  TOOL_RECOMMENDATION: {
    LASSO_MAX_MASS: 10,         // kg — lasso effective up to this mass
    SPINNER_MAX_MASS: 50,       // kg — spinner arm for small/medium
    GRAPPLE_MAX_MASS: 500,      // kg — grapple for medium/large
    WEAVER_MIN_MASS: 200,       // kg — weaver for large debris
    TRAWL_MIN_COUNT: 3,         // minimum cluster size for trawl recommendation
    TRAWL_MAX_INDIVIDUAL_MASS: 20, // kg — trawl only for small fragments
  },

  // --- Ablation ---
  ABLATION_LASER_POWER: 10,              // watts — onboard laser for de-spin/nudge
  ABLATION_RANGE_MAX: 50,                // meters — max effective ablation range
  ABLATION_DURATION_MAX: 30,             // seconds — max continuous ablation
  ABLATION_DESPIN_RATE: 0.1,             // rad/s² — angular deceleration applied

  // --- V5 Arm Configuration ---
  V5_ARM_COUNT: 4,                       // Total arms: 2W + 2S (Y0 Quad baseline — ST-9.2)
  V5_WEAVER_MASS: 6.6,                   // kg — 40% lighter (reel on mothership)
  V5_SPINNER_MASS: 2.1,                  // kg — 40% lighter (reel on mothership)
  V5_FRONT_ARM_TYPE: 'spinner',          // prograde arm type
  V5_BACK_ARM_TYPE: 'spinner',           // retrograde arm type

  // --- Tether Materials (upgrade tiers) ---
  TETHER_TIERS: [
    { name: 'Dyneema',   breakStrength: 100,  mass_per_km: 0.8,  maxLength: 2000,  cost: 0 },
    { name: 'Zylon',     breakStrength: 200,  mass_per_km: 0.6,  maxLength: 4000,  cost: 1500 },
    { name: 'CNT',       breakStrength: 350,  mass_per_km: 0.3,  maxLength: 6000,  cost: 5000 },
    { name: 'GSL-50',    breakStrength: 500,  mass_per_km: 0.15, maxLength: 8000,  cost: 15000 },
    { name: 'GSL-100',   breakStrength: 800,  mass_per_km: 0.10, maxLength: 10000, cost: 40000 },
  ],

  // --- Spring Upgrade Tiers ---
  SPRING_TIERS: [
    { name: 'Steel T1',      maxSpeed: 7.1,  reloadMult: 0.5,  cost: 0 },
    { name: 'Maraging T2',   maxSpeed: 10.0, reloadMult: 1.0,  cost: 800 },
    { name: 'Composite T3',  maxSpeed: 15.0, reloadMult: 2.25, cost: 3000 },
    { name: 'Nanolam T4',    maxSpeed: 20.0, reloadMult: 4.0,  cost: 10000 },
    { name: 'Metamat T5',    maxSpeed: 25.0, reloadMult: 6.25, cost: 30000 },
  ],

  // --- Tangle Resolution ---
  TANGLE_DETECT_ANGLE: 0.52,             // radians (~30°) — crossing angle threshold
  TANGLE_RESOLVE_TIME: 8.0,              // seconds — auto-resolution duration
  TANGLE_SLACK_PULSE: 0.5,               // N — gentle tension pulse for untangle

  // =========================================================================
  // SALVAGE SYSTEM — Recoverable resources from captured debris (Session 10)
  // =========================================================================

  // --- Salvage Probabilities (by debris type) ---
  SALVAGE_PROB_DEFUNCT_SAT_XENON: 0.15,        // Ion-propelled satellites
  SALVAGE_PROB_DEFUNCT_SAT_XENON_LARGE: 0.25,  // Large sats (>500 kg)
  SALVAGE_PROB_DEFUNCT_SAT_GAAS: 0.20,         // Solar panel fragments
  SALVAGE_PROB_DEFUNCT_SAT_BATTERY: 0.15,      // Residual Li-ion charge
  SALVAGE_PROB_ROCKET_BODY_HYDRAZINE: 0.10,    // Residual propellant (hazardous)
  SALVAGE_PROB_ROCKET_BODY_XENON: 0.05,        // Electric upper stages (rare)
  SALVAGE_PROB_MISSION_DEBRIS_INDIUM: 0.12,    // FEEP thruster components
  SALVAGE_PROB_MISSION_DEBRIS_BATTERY: 0.10,   // Small power systems
  SALVAGE_PROB_FRAGMENT_GAAS: 0.30,            // Broken solar panel shards
  SALVAGE_PROB_FRAGMENT_INDIUM: 0.05,          // Trace alloy amounts
  SALVAGE_PROB_DEFUNCT_SAT_LITHIUM: 0.25,      // Lithium from defunct satellite batteries/propulsion

  // --- Salvage Amount Ranges ---
  SALVAGE_XENON_MIN: 2,               // kg
  SALVAGE_XENON_MAX: 8,               // kg (standard sat)
  SALVAGE_XENON_LARGE_MIN: 5,         // kg (large sat >500kg)
  SALVAGE_XENON_LARGE_MAX: 15,        // kg
  SALVAGE_INDIUM_MIN: 0.01,           // kg
  SALVAGE_INDIUM_MAX: 0.05,           // kg
  SALVAGE_GAAS_MIN: 0.005,            // fraction (0.5% panel health)
  SALVAGE_GAAS_MAX: 0.03,             // fraction (3% panel health)
  SALVAGE_BATTERY_MIN: 2,             // Wh
  SALVAGE_BATTERY_MAX: 20,            // Wh
  SALVAGE_HYDRAZINE_MIN: 2,           // kg
  SALVAGE_HYDRAZINE_MAX: 10,          // kg
  SALVAGE_HYDRAZINE_COLDGAS_RATIO: 0.6, // 60% conversion to cold gas equivalent
  SALVAGE_LITHIUM_MIN: 5,               // units (F16: MPD thruster propellant)
  SALVAGE_LITHIUM_MAX: 15,              // units (reasonable for 100 capacity)

  // --- Indium FEEP Fuel Tank Sizes (for arm refueling calculation) ---
  INDIUM_FULL_TANK_WEAVER: 0.15,      // kg Indium for 100% Weaver FEEP
  INDIUM_FULL_TANK_SPINNER: 0.05,     // kg Indium for 100% Spinner FEEP

  // --- Salvage Scoring ---
  SALVAGE_SCORE_MULTIPLIER: 1.15,     // ×1.15 when salvage recovered
  SALVAGE_XENON_CREDIT_BONUS: 200,    // Flat credits for Xenon recovery
  SALVAGE_INDIUM_CREDIT_BONUS: 500,   // Flat credits for Indium (scarce)
  SALVAGE_HAZMAT_MULTIPLIER: 1.4,     // ×1.4 for hydrazine recovery (risky)

  // =========================================================================
  // DEORBIT SACRIFICE SYSTEM — One-way arm missions (Session 10)
  // =========================================================================

  DEORBIT_MULTIPLIER_BASE: 1.5,       // Standard sacrifice bonus
  DEORBIT_MULTIPLIER_HIGH_DV: 1.8,    // >20 m/s retrograde burn achieved
  DEORBIT_MULTIPLIER_REENTRY: 2.5,    // Perigee < 200 km (actual reentry)
  DEORBIT_MULTIPLIER_EMERGENCY: 1.2,  // < 5% fuel at sacrifice
  DEORBIT_HIGH_DV_THRESHOLD: 20,      // m/s — threshold for high-ΔV bonus
  DEORBIT_REENTRY_PERIGEE: 200,       // km — perigee for reentry bonus

  // =========================================================================
  // METAL SALVAGE ECONOMY — Recoverable metals from debris (Phase 2)
  // =========================================================================

  METALS: {
    ALUMINUM: {
      id: 'aluminum',
      name: 'Aluminum',
      density: 2700,          // kg/m³
      meltPoint: 660,         // °C
      ispAsThrust: 800,       // seconds (metal-ion propulsion)
      marketValue: 2.5,       // credits per kg
      color: '#C0C0C0',
      abundance: 0.40,        // 40% of debris mass is aluminum
    },
    TITANIUM: {
      id: 'titanium',
      name: 'Titanium',
      density: 4507,
      meltPoint: 1668,
      ispAsThrust: 900,
      marketValue: 12.0,
      color: '#8B8682',
      abundance: 0.08,
    },
    STEEL: {
      id: 'steel',
      name: 'Steel',
      density: 7850,
      meltPoint: 1370,
      ispAsThrust: 500,       // iron-based
      marketValue: 1.0,
      color: '#71797E',
      abundance: 0.15,
    },
    COPPER: {
      id: 'copper',
      name: 'Copper',
      density: 8960,
      meltPoint: 1085,
      ispAsThrust: 600,
      marketValue: 8.0,
      color: '#B87333',
      abundance: 0.05,
    },
    CARBON_COMPOSITE: {
      id: 'carbon_composite',
      name: 'Carbon Composite',
      density: 1600,
      meltPoint: 3550,
      ispAsThrust: 0,         // not usable as propellant
      marketValue: 15.0,
      color: '#2C2C2C',
      abundance: 0.10,
    },
    GALLIUM: {
      id: 'gallium',
      name: 'Gallium',
      density: 5910,
      meltPoint: 30,          // melts near room temp!
      ispAsThrust: 3000,      // excellent as propellant
      marketValue: 50.0,
      color: '#7B8D8E',
      abundance: 0.02,        // rare — found in electronics
    },
    GLASS_CERAMIC: {
      id: 'glass_ceramic',
      name: 'Glass/Ceramic',
      density: 2500,
      meltPoint: 1700,
      ispAsThrust: 0,
      marketValue: 0.5,
      color: '#E8E8E8',
      abundance: 0.12,
    },
    IRIDIUM: {
      id: 'iridium',
      name: 'Iridium',
      density: 22560,
      meltPoint: 2446,
      ispAsThrust: 1200,
      marketValue: 150.0,     // very valuable
      color: '#E8E0D0',
      abundance: 0.01,        // very rare — from Iridium constellation debris
    },
    KEVLAR: {
      id: 'kevlar',
      name: 'Kevlar/MLI',
      density: 1440,
      meltPoint: 500,
      ispAsThrust: 0,
      marketValue: 3.0,
      color: '#DAA520',
      abundance: 0.07,
    },
  },

  // Debris type → metal composition overrides (which metals are more likely)
  // Keys match game debris type IDs from DEBRIS_TYPES
  DEBRIS_METAL_PROFILES: {
    rocketBody:   { aluminum: 0.55, steel: 0.20, titanium: 0.10, copper: 0.05, kevlar: 0.05, glass_ceramic: 0.05 },
    defunctSat:   { aluminum: 0.30, gallium: 0.05, copper: 0.10, carbon_composite: 0.15, glass_ceramic: 0.15, titanium: 0.10, kevlar: 0.10, steel: 0.05 },
    fragment:     { aluminum: 0.45, steel: 0.25, titanium: 0.05, glass_ceramic: 0.15, kevlar: 0.10 },
    missionDebris: { aluminum: 0.20, glass_ceramic: 0.30, carbon_composite: 0.20, copper: 0.15, kevlar: 0.10, gallium: 0.03, iridium: 0.02 },
  },

  // --- Cargo Hold ---
  CARGO_CAPACITY_KG: 500,        // base cargo hold capacity in kg
  CARGO_CAPACITY_SLOTS: 20,      // max distinct material stacks

  // =========================================================================
  // FORGE — Electromagnetic Levitation Melting (EML) Furnace (Phase 3)
  // Based on ISS TEMPUS facility (TRL 8-9), scaled to 5kg batches
  // =========================================================================

  FORGE: {
    BATCH_SIZE_KG: 5.0,          // max kg per processing batch
    POWER_DRAW: 0.15,            // battery fraction per second while melting
    REFINE_MULTIPLIER: 2.5,      // refined metal worth 2.5× raw value
    PROPELLANT_EFFICIENCY: 0.85, // 85% mass retained when converting to propellant slugs

    // Processing times (seconds) per phase
    PHASE_TIMES: {
      INTAKE: 5,               // loading sample into EML chamber (S3 balance: was 3)
      SEPARATE: 15,            // electromagnetic separation of alloys (S3 balance: was 8)
      MELT: 30,                // levitation melting (S3 balance: was 12)
      COOL: 10,                // controlled cooling/solidification (S3 balance: was 5)
    },

    // Total cycle: ~60 seconds per batch (S3 balance: was ~28s — now matches 2-3 capture cadence)
    // Higher melt-point metals take longer (multiplier)
    MELT_POINT_TIME_SCALE: {
      low: 0.7,    // < 500°C (gallium, kevlar)
      medium: 1.0,  // 500-1500°C (aluminum, copper, steel)
      high: 1.5,    // > 1500°C (titanium, carbon composite, glass)
      extreme: 2.0, // > 2000°C (iridium)
    },
  },

  // =========================================================================
  // FUELS — Dual-Mode Hall Thruster Propellant Definitions (Phase 4)
  // One thruster, multiple fuels. T key cycles. Isp affects ΔV efficiency.
  // =========================================================================

  FUELS: {
    xenon: {
      id: 'xenon',
      name: 'Xenon',
      isp: 1600,          // seconds — standard Hall thruster
      thrustScale: 1.0,   // baseline thrust
      color: '#4fc3f7',   // light blue
      resourceKey: 'xenon', // consumes from ResourceSystem xenon tank
      fromCargo: false,    // uses ship's built-in tank
    },
    aluminum: {
      id: 'aluminum',
      name: 'Aluminum',
      isp: 800,
      thrustScale: 1.4,   // higher thrust, lower efficiency
      color: '#C0C0C0',
      resourceKey: null,
      fromCargo: true,     // consumed from cargo prop_aluminum
      cargoMetalId: 'prop_aluminum',
    },
    gallium: {
      id: 'gallium',
      name: 'Gallium',
      isp: 3000,
      thrustScale: 0.6,   // lower thrust, very high efficiency
      color: '#7B8D8E',
      resourceKey: null,
      fromCargo: true,
      cargoMetalId: 'prop_gallium',
    },
    copper: {
      id: 'copper',
      name: 'Copper',
      isp: 600,
      thrustScale: 1.2,
      color: '#B87333',
      resourceKey: null,
      fromCargo: true,
      cargoMetalId: 'prop_copper',
    },
    iridium: {
      id: 'iridium',
      name: 'Iridium',
      isp: 1200,
      thrustScale: 0.9,
      color: '#E8E0D0',
      resourceKey: null,
      fromCargo: true,
      cargoMetalId: 'prop_iridium',
    },
  },

  DEFAULT_FUEL: 'xenon',

  // =========================================================================
  // MPD THRUSTER — Magnetoplasmadynamic Tier 3 Propulsion (F16)
  // High-thrust lithium-propellant system with cathode erosion mechanic
  // =========================================================================

  MPD_THRUST: 25,                    // Newtons (much higher than ion's ~0.5N)
  MPD_ISP: 3000,                     // seconds (specific impulse)
  MPD_POWER_DRAW: 150,               // kW (S3b: restored from 5 — Ludicrous Mode with power infrastructure upgrade chain)
  MPD_CATHODE_LIFE: 600,             // seconds of operation before erosion
  MPD_CATHODE_LIFE_UPGRADED: 1200,   // seconds — doubled with Hardened Cathode upgrade
  MPD_DEGRADED_FACTOR: 0.5,          // thrust multiplier after cathode erosion
  MPD_COST: 3000,                    // credits
  MPD_LITHIUM_CAPACITY: 100,         // max lithium units
  MPD_LITHIUM_PER_SECOND: 0.5,       // lithium consumption rate
  MPD_DELTA_V: 0.0015,               // scene units/s² — scaled for gameplay feel (~5× ion)

  // --- MPD Burst Mode (S3b) ---
  MPD_BURST_HEAT_RATE: 1.0,               // heat units/s while firing
  MPD_BURST_COOL_RATE: 0.3,               // heat units/s passive dissipation
  MPD_BURST_COOL_RATE_SUPERCAP: 0.5,      // heat dissipation with supercap upgrade
  MPD_BURST_OVERHEAT_THRESHOLD: 40,       // heat units for thermal shutdown
  MPD_BURST_COOLDOWN_TIME: 15,            // seconds forced cooldown after overheat
  MPD_BURST_POWER_WARN: 0.15,             // battery fraction for MPD power warning
  MPD_BURST_POWER_DEGRADE: 0.05,          // battery fraction for thrust degradation (50%)

  // --- RTG (S3b) ---
  RTG_POWER: 2.0,                         // kW constant generation (Wh/s)

  // --- Power Beaming (S3b) ---
  POWER_BEAM_RATE: 5.0,                   // kW during ground station pass (Wh/s)

  // =========================================================================
  // MARKET & BOUNTY SYSTEM (Phase 5)
  // =========================================================================

  MARKET: {
    // Bounty premiums by debris type (multiplier on base capture score)
    // Keys must match DEBRIS_TYPES values (camelCase game IDs)
    BOUNTY_PREMIUMS: {
      fragment: 1.8,         // small fragments: high bounty per piece (thorough cleanup)
      missionDebris: 1.5,    // mission debris: moderate premium
      defunctSat: 1.0,       // base rate
      rocketBody: 0.8,       // large bodies: lower bounty but more salvage metal
    },

    // Selling price modifier (cargo sells at this fraction of listed marketValue)
    SELL_PRICE_MODIFIER: 0.85,  // 85% of listed value (market spread)

    // Bulk bonus: selling > 50kg at once gets a bonus
    BULK_THRESHOLD_KG: 50,
    BULK_BONUS_MULTIPLIER: 1.15,
  },

  // =========================================================================
  // SPACE ELEVATOR CONTRACT — Endgame Win Condition (Phase 5)
  // =========================================================================

  ELEVATOR_CONTRACT: {
    TARGET_MASS_KG: 10000,     // 10,000 kg to complete the contract
    CONTRIBUTION_TYPES: ['refined_aluminum', 'refined_titanium', 'refined_steel', 'refined_copper', 'refined_iridium'],
    // Only REFINED metals count towards the contract (incentivizes using the Forge)
    BONUS_CREDITS_PER_KG: 5,  // bonus credits on top of selling price for contributing
    WIN_BONUS: 50000,          // credits bonus for completing the contract
  },

  // =========================================================================
  // TRAWLING — Passive debris collection along orbit path (Phase 6)
  // =========================================================================

  TRAWLING: {
    MAX_TRAWL_ARMS: 3,                    // max arms that can trawl simultaneously
    TRAWL_RADIUS_KM: 0.05,               // capture radius while trawling (50m)
    TRAWL_SPEED_SCALE: 0.3,              // trawling arm moves at 30% normal speed
    FUEL_RATE_TRAWL: 0.002,              // fuel consumption per second while trawling (very low)
    AUTO_CAPTURE_MASS_MAX: 50,            // auto-capture debris up to 50kg
    TRAWL_DURATION_MAX: 120,              // max trawl time before auto-recall (seconds)
    TRAVERSE_SPEED_DEFAULT: 0.000002,     // scene units/s (~0.2 m/s)
    SPEED_ADAPT_UP: 1.5,                  // multiplier when catch ratio > 80%
    SPEED_ADAPT_DOWN: 0.6,               // multiplier when catch ratio < 30%
    SPEED_MIN: 0.0000005,                // minimum traverse speed
    SPEED_MAX: 0.00002,                   // maximum traverse speed
    IDLE_TIMEOUT: 60,                     // seconds with no targets → auto-end
    WINDOW_CLOSING_THRESHOLD: 0.8,        // fraction of max range → warning
    SPEED_MAINTAIN_HIGH: 0.8,             // catch ratio above this → speed up
    SPEED_MAINTAIN_LOW: 0.3,              // catch ratio below this → slow down
    NET_MASS: 5,                          // kg — trawl net mass (for recoil compensation)
    DEPLOY_SPEED: 2,                      // m/s — trawl net deployment speed
  },

  // =========================================================================
  // EDT — Electrodynamic Tether deployment to attract small debris (Phase 6)
  // =========================================================================

  EDT: {
    DEPLOY_LENGTH_KM: 0.1,     // 100m tether
    POWER_DRAW: 0.05,          // battery fraction per second
    ATTRACTION_RADIUS_KM: 0.2, // 200m — draws small debris closer
    ATTRACTION_FORCE: 0.0001,  // km/s² — gentle pull
    MAX_ATTRACT_MASS: 20,      // only affects debris < 20kg
    DEPLOY_TIME: 5,            // seconds to deploy
  },

  // =========================================================================
  // ROUTE PLANNER — ΔV-optimal multi-target visit order (Phase 6)
  // =========================================================================

  ROUTE_PLANNER: {
    MAX_WAYPOINTS: 6,          // max targets in a planned route
    DISPLAY_DV_THRESHOLD: 0.01, // don't show ΔV < 10 m/s legs
  },

  // === HUD Configuration (Phase R4) ===
  HUD: {
    COLORS: {
      GREEN: '#00ff88',
      AMBER: '#ffaa00',
      RED: '#ff4444',
      BLUE: '#4488ff',
      WHITE: '#ccddcc',
    },
    THRESHOLDS: {
      BAR_AMBER: 0.30,     // 30% — bar turns amber
      BAR_RED: 0.15,        // 15% — bar turns red
      BAR_PULSE: 0.05,      // 5% — bar starts pulsing
      BAR_CRITICAL: 0.01,   // 1% — continuous alarm
    },
    PANEL_WIDTH: 220,
    LABEL_WIDTH: 42,
    DV_ALARM_INTERVALS: [15, 8, 3, 0],  // seconds between beeps per tier
  },

  // === Audio Configuration (Phase R4) ===
  AUDIO: {
    AMBIENT_GAIN: 0.01,
    // §14.6 (Sprint 4) removed SFX_GAIN: 0.15 — declared but never referenced
    // anywhere in the codebase. The SFX bus uses a hardcoded 0.7 gain at
    // [`AudioSystem.js:116`](js/systems/AudioSystem.js:116). Keep AMBIENT_GAIN
    // (used by opt-in `?ambient=1`) and ALERT_GAIN (used by warning/conjunction
    // earcons — see AudioSystem.js:1820, 1848).
    ALERT_GAIN: 0.20,
    // §13 Sprint 4 escalation — gameplay ambient loop default OFF.
    //
    // Root cause investigation: even after the low-power AudioContext fix
    // (latencyHint:'playback' + sampleRate:22050, §13.5), the user reported
    // the fan still triggered on sim-start (MENU → ORBITAL_VIEW). A/B test
    // with ?noAudio=1 confirmed the audio thread is still the trigger.
    //
    // The ambient loop creates two continuously-looping BufferSource nodes
    // (white noise) + two BiquadFilter nodes (bandpass) that keep the audio
    // render thread permanently busy from the moment ORBITAL_VIEW starts.
    // Even at 22 kHz the filters process every render quantum (~46 ms at
    // 1024-sample 'playback' buffer = ~22 wakeups/s per filter chain, plus
    // every gain ramp scheduled via linearRampToValueAtTime). On Apple
    // Silicon this is enough to push Energy Impact across the SMC fan-trip
    // threshold.
    //
    // Toggling the ambient loop off means the AudioContext still exists
    // (so SFX play instantly without resume-latency) but no continuous
    // sources are running between SFX events. The audio thread can c-state
    // park between callbacks.
    //
    // URL flag override: `?ambient=1` enables it for users who want the
    // engine-room sound (and accept the energy cost). `?noAmbient=1` is
    // also accepted for symmetry but is the default.
    AMBIENT_LOOP_ENABLED: false,
    EARCON_FREQUENCIES: {
      SUCCESS: [261, 329, 392],    // C4, E4, G4 — ascending major
      ALERT: [392, 329],            // G4, E4 — descending third
      CONFIRM: [600, 600],          // two same-pitch blips
      CYCLE: [400, 450, 500, 550, 600],  // ascending steps for T key
    },
  },

  // =========================================================================
  // GAMEPLAY LOOP — Phase 1 Core Feel (from GAMEPLAY_LOOP.md)
  // =========================================================================

  // --- Arm Game-ification ---
  // DEPRECATED V5 — replaced by crossbow spring physics (CROSSBOW_LAUNCH_SPEED_DEFAULT)
  ARM_GAMIFIED_THRUST_MULT: 200,       // multiply real FEEP thrust for responsive feel (1-2s response)
  // DEPRECATED V5 — replaced by crossbow spring physics (CROSSBOW_LAUNCH_SPEED_DEFAULT)
  ARM_LAUNCH_SPEED: 10.0,              // m/s initial cast velocity (spring/gas push on deploy)
  ARM_LAUNCH_DURATION: 0.5,            // seconds of launch animation

  // --- Lasso System ---
  LASSO_RANGE: 200,                    // meters
  LASSO_SPEED: 10,                     // m/s launch velocity — 10 m/s (50% slower) for deliberate space-sim cast feel
                                       // accounts for TIME_SCALE_GAMEPLAY×10 so apparent speed is 100 m/s game-time
  LASSO_MAX_FLIGHT_TIME: 8,            // seconds real-time before auto-retract
  LASSO_TRAIL_SAMPLE_INTERVAL: 0.03,   // seconds between trail position samples (halved from 0.06 for denser trail)
  LASSO_REEL_SPEED: 0.33,             // reel-in progress per real second (0→1; ~3 s total) — SLOWER than outbound to avoid tangles
  LASSO_MAX_CAPTURE_MASS: 10,          // kg
  LASSO_AMMO_MAX: 50,                  // UX-3 #7 — web tether ammo count (50 shots per session/refill)
  LASSO_FORWARD_ARC_DOT: 0.3,         // UX-3 #4 — min dot product for forward hemisphere (~72° cone)
  LASSO_CAST_WINDUP: 0.15,            // seconds — brief charging delay before lasso fires (cast feel)
  LASSO_COOLDOWN_CATCH: 2,            // seconds — cooldown after successful catch before next cast
  LASSO_COOLDOWN_MISS: 1,             // seconds — cooldown after miss/retract before next cast
  LASSO_PROJECTILE_MASS: 2.5,         // kg — mass of lasso net projectile (for recoil compensation)

  // --- Capture Net Visual (ST-2.4 → FIX-2.4a → v2 polish) ---
  NET_SPIN_HZ: 4,                       // rotations per second during flight (gyroscopic stabilisation)
  NET_WEIGHT_COUNT: 4,                   // perimeter weight spheres (keep net spread open)
  NET_WEIGHT_RADIUS: 1.5,               // metres — each weight sphere radius
  NET_PERIMETER_RADIUS: 4,              // metres — net ring radius
  NET_SEGMENTS: 8,                       // octagonal perimeter line segments
  NET_CROSS_LINES: 4,                    // cross-mesh lines (diameters through center)
  NET_COMPACT_SCALE: 0.45,              // scale factor during reel-in (was 0.15 — too small to see)
  // Coaxial tether (v2): dark outer sheath + bright inner core
  NET_TETHER_SHEATH_RADIUS: 0.45,       // metres — outer sheath radius (thicker, dark)
  NET_TETHER_CORE_RADIUS: 0.18,         // metres — inner core radius (thin, bright)
  NET_TETHER_SAG: 2.0,                   // metres — catenary sag at tether midpoint
  NET_TETHER_SEGMENTS: 20,              // segments along tether curve (more = smoother sag)
  NET_TETHER_RADIAL_SEGMENTS: 6,        // radial segments for tube cross-section (smoother)
  NET_PULSE_HZ: 2.0,                    // pulse beads per second travelling along tether during reel-in
  NET_PULSE_RADIUS: 0.8,                // metres — pulse bead radius
  NET_SPARK_COUNT: 12,                   // radial spark lines on contact
  NET_SPARK_DURATION: 0.4,              // seconds — spark animation time
  NET_SPARK_LENGTH: 15,                  // metres — spark line length
  // Legacy tether radius alias for tests
  NET_TETHER_RADIUS: 0.45,              // = sheath radius (backwards compat)

  // Legacy aliases (backwards compat for any external refs)
  get BOLAS_SPIN_HZ() { return this.NET_SPIN_HZ; },
  get BOLAS_WEIGHT_COUNT() { return this.NET_WEIGHT_COUNT; },
  get BOLAS_TORUS_RADIUS() { return this.NET_PERIMETER_RADIUS; },
  get BOLAS_TORUS_TUBE() { return 0.8; },
  get BOLAS_WEIGHT_RADIUS() { return this.NET_WEIGHT_RADIUS; },
  get BOLAS_SHAFT_LENGTH() { return 6; },
  get BOLAS_SHAFT_RADIUS() { return 0.5; },
  get BOLAS_TETHER_RADIUS() { return this.NET_TETHER_RADIUS; },
  get BOLAS_TETHER_SEGMENTS() { return this.NET_TETHER_SEGMENTS; },
  get BOLAS_TETHER_RADIAL_SEGMENTS() { return this.NET_TETHER_RADIAL_SEGMENTS; },
  get BOLAS_SPARK_COUNT() { return this.NET_SPARK_COUNT; },
  get BOLAS_SPARK_DURATION() { return this.NET_SPARK_DURATION; },
  get BOLAS_SPARK_LENGTH() { return this.NET_SPARK_LENGTH; },

  // =========================================================================
  // CAPTURE NET SYSTEM — ST-9.4 C-6 (Config G)
  // Per CAPTURE_NET.md §2–§6 canonical spec. Gated by FEATURE_FLAGS.CAPTURE_NET.
  // =========================================================================
  CAPTURE_NET: {
    // ── Net Projectile States ──
    STATES: {
      FOLDED:        'FOLDED',
      LAUNCHING:     'LAUNCHING',
      SPINNING_UP:   'SPINNING_UP',
      FLIGHT:        'FLIGHT',
      CONTACT:       'CONTACT',       // slam-wrap contact
      BRAKE:         'BRAKE',         // tether-brake (cinch path)
      ENVELOP:       'ENVELOP',       // rim weights sweep past (cinch)
      CINCH_CLOSING: 'CINCH_CLOSING', // drawstring cinch
      SECURE_CHECK:  'SECURE_CHECK',  // cling/cinch success roll
      CAPTURED:      'CAPTURED',      // debris secured
      MISSED:        'MISSED',        // cling failed / timeout
      REELING:       'REELING',       // motor reel-in
      STOWED:        'STOWED',        // back at platform
      RELEASED:      'RELEASED',      // player abort — net+debris float free
    },

    // ── Capture Modes ──
    MODES: {
      SLAM_WRAP: 'SLAM_WRAP',   // durable targets
      CINCH:     'CINCH',       // delicate targets (tether-brake bag)
    },

    // ── Phase Timings (seconds) — per CAPTURE_NET.md §2.4 ──
    CAST_WINDUP:          0.15,   // crossbow spring release (§2.4 phase 1)
    SPIN_UP_TIME:         0.5,    // yo-yo despin (§2.4 phase 2)
    MAX_FLIGHT_TIME:      8,      // max tether pay-out (§2.4 phase 3)
    SLAM_CONTACT_TIME:    0.5,    // slam-wrap wrap duration (§2.4 phase 5a, min)
    BRAKE_TIME:           0.5,    // tether-brake application (§2.4 phase 5b)
    ENVELOP_TIME:         1.5,    // rim-weight sweep (§2.4 phase 5b)
    CINCH_CLOSE_TIME:     2.0,    // drawstring cinch + settle (§2.4 phase 5b+§8)
    SECURE_CHECK_TIME:    0.2,    // capture probability roll (§2.4 phase 6)
    MAGAZINE_ADVANCE_TIME: 0.5,   // next net rotates into position (§2.4 phase 8)

    // ── Cooldowns (seconds) ──
    COOLDOWN_CATCH:       2,      // after success before re-fire (LASSO_COOLDOWN_CATCH)
    COOLDOWN_MISS:        1,      // after miss before re-fire (LASSO_COOLDOWN_MISS)

    // ── Reel-cycle lifetime ──
    REEL_CYCLE_LIFE:      20,     // §6.6: deploy/reel cycles before tether replacement

    // ── Distance zones (metres) — per §3.3 + QA Q-4 ──
    CLOSE_RANGE:          30,     // <30 m = bonus zone (f_distance = 1.1)
    BASELINE_RANGE_MAX:   75,     // 30–75 m = standard (f_distance = 1.0)
    ENVELOPE_RANGE:       100,    // max engagement envelope

    // ── Cling probability base values — per §3.4 ──
    SLAM_P_BASE: {
      RIGHT_RIGHT:   0.90,   // right net, right target
      RIGHT_HARDER:  0.80,   // right net, harder target
      RIGHT_FRAGILE: 0.70,   // right net, fragile target
      WRONG_NET:     0.50,   // wrong net size
    },
    CINCH_P_BASE: {
      RIGHT_RIGHT:   0.95,
      RIGHT_HARDER:  0.93,
      RIGHT_FRAGILE: 0.92,
      WRONG_NET:     0.85,
    },

    // ── Tangle base probabilities — per §4.6 (gated by NET_TANGLE_MECHANICS) ──
    TANGLE_SELF_P:          0.015,
    TANGLE_MOTHER_P:        0.02,
    TANGLE_DAUGHTER_P:      0.05,
    TANGLE_CROSS_DEBRIS_P:  0.008,
    TANGLE_REEL_IN_P:       0.04,

    // ── Fragmentation ──
    FRAG_REP_PENALTY:       10,     // reputation lost per fragment (§5.5)
    FRAG_CREDIT_PENALTY:    50,     // credits lost per fragment (§5.5)
    FRAG_MERCY_FIRST_FREE:  true,   // first-fragmentation waives penalties (§5.7)

    // ── Mother Pod Config — per §2.9 ──
    MOTHER_POD_COUNT:       2,      // 2 symmetric pods (A and B)
    MOTHER_POD_SPRING_E:    100,    // J per pod (§2.8)
    GUIDE_RING_MASS:        0.080,  // kg (§2.9.3)

    // ═══════════════════════════════════════════════════════════
    // Per-Platform Net Class Specs — per §6.1
    // ═══════════════════════════════════════════════════════════

    // ── Large Net (M-NET) — Mother pod ──
    LARGE: {
      CODE:             'M-NET',
      NAME:             'Large Net',
      DIAMETER:         8.0,       // m deployed (§2.1)
      MASS:             1.95,      // kg total net+hub (§2.3)
      MESH_MASS:        1.200,     // kg mesh only (Dyneema Y0)
      RIM_WEIGHT_COUNT: 8,         // (§2.1)
      RIM_WEIGHT_MASS:  0.075,     // kg each (§2.1)
      HUB_MASS:         0.150,     // kg (§2.3)
      CONE_HALF_ANGLE:  15,        // degrees (§2.1)
      SPIN_HZ:          2,         // (§6.1)
      MAX_CAPTURE_MASS: 5000,      // kg (§6.1)
      MAGAZINE_SIZE:    4,         // nets/pack Dyneema Y0 (§6.4)
      RELOAD_TIME:      30,        // seconds (§6.1)
      REEL_SPEED:       2.0,       // m/s (§6.1)
      TETHER_MAX:       100,       // m (§6.1)
      RANGE:            100,       // m engagement envelope (§2.8)
      LAUNCH_SPEED:     10.0,      // m/s (§2.8)
      SPRING_ENERGY:    100,       // J (§2.8)
      REPLACEMENT_COST: 250,       // credits (§6.1)
    },

    // ── Medium Net (LD-NET) — Weaver / Large Daughter ──
    MEDIUM: {
      CODE:             'LD-NET',
      NAME:             'Medium Net',
      DIAMETER:         5.0,
      MASS:             0.68,
      MESH_MASS:        0.400,
      RIM_WEIGHT_COUNT: 4,
      RIM_WEIGHT_MASS:  0.050,
      HUB_MASS:         0.080,
      CONE_HALF_ANGLE:  12,
      SPIN_HZ:          4,
      MAX_CAPTURE_MASS: 500,
      MAGAZINE_SIZE:    2,
      RELOAD_TIME:      15,
      REEL_SPEED:       2.0,
      TETHER_MAX:       100,
      RANGE:            100,
      LAUNCH_SPEED:     10.0,
      SPRING_ENERGY:    34,
      REPLACEMENT_COST: 100,
    },

    // ── Small Net (SD-NET) — Spinner / Small Daughter ──
    SMALL: {
      CODE:             'SD-NET',
      NAME:             'Small Net',
      DIAMETER:         1.5,
      MASS:             0.12,
      MESH_MASS:        0.040,
      RIM_WEIGHT_COUNT: 4,
      RIM_WEIGHT_MASS:  0.015,
      HUB_MASS:         0.020,
      CONE_HALF_ANGLE:  10,
      SPIN_HZ:          6,
      MAX_CAPTURE_MASS: 50,
      MAGAZINE_SIZE:    4,
      RELOAD_TIME:      5,
      REEL_SPEED:       3.0,
      TETHER_MAX:       100,
      RANGE:            100,
      LAUNCH_SPEED:     10.0,
      SPRING_ENERGY:    6,
      REPLACEMENT_COST: 25,
    },
  },

  // --- Mothership RCS Fine Positioning ---
  RCS_IMPULSE: 0.0000002,             // scene units/s² — very small nudge (20 m/s² real → tiny in scene scale)
  RCS_MAX_SPEED: 0.000005,            // scene units/s — max RCS drift speed (0.5 m/s real)
  RCS_DAMPING: 0.95,                  // velocity damping per frame when not thrusting (stops quickly)

  // --- Catch Juice (S4 — Core Feel) ---
  CATCH_SLOWMO_DURATION: 0.4,          // seconds of slow-motion on contact (was 0.2 — extended for more juice)
  CATCH_SLOWMO_FACTOR: 0.1,            // time scale during slo-mo
  CATCH_SHAKE_DURATION: 0.3,           // seconds — camera micro-shake on capture
  CATCH_SHAKE_INTENSITY: 0.003,        // scene units — shake amplitude
  CATCH_FLASH_DURATION: 250,           // ms — screen border pulse duration

  // --- Field Clearing (Phase 5 — reserve constants) ---
  FIELD_CLEAR_100_BONUS: 2000,         // credits for 100% sector clear

  // =========================================================================
  // SALVAGE SYNERGIES — Complementary metal bonuses (Phase 5 Rewards)
  // =========================================================================

  SALVAGE_SYNERGIES: [
    { metals: ['GALLIUM', 'COPPER'],           name: 'Complete Solar Array',   points: 300 },
    { metals: ['TITANIUM', 'KEVLAR'],          name: 'Shielding Kit',          points: 250 },
    { metals: ['ALUMINUM', 'STEEL'],           name: 'Structural Alloy',       points: 200 },
    { metals: ['GALLIUM', 'IRIDIUM'],          name: 'Avionics Suite',         points: 500 },
    { metals: ['CARBON_COMPOSITE', 'COPPER'],  name: 'Propulsion Package',     points: 350 },
    { metals: ['GLASS_CERAMIC', 'GALLIUM'],    name: 'Sensor Package',         points: 250 },
  ],
  FIELD_CLEAR_BONUS: 1000,              // bonus points for 100% field clear
  FIELD_CLEAR_THRESHOLDS: [
    { pct: 0.50, bonus: 200,  label: 'Half Clear' },
    { pct: 0.75, bonus: 500,  label: 'Three-Quarter Clear' },
    { pct: 1.00, bonus: 2000, label: 'Perfect Sweep' },
  ],
  SWEEP_REPORT_TIMEOUT: 15,             // seconds before auto-dismiss of sweep report

  // --- Tether Detach (Phase 6 — Risk-Reward Redline Mechanic) ---
  DETACH_SCORE_MULT: 2.0,              // untethered catch multiplier
  DETACH_SACRIFICE_MULT: 2.5,          // deorbit sacrifice multiplier
  DETACH_FAIL_PENALTY: -500,           // score penalty for lost arm
  DETACH_FUEL_WARNING_25: 0.25,        // fraction triggers warning comms
  DETACH_FUEL_WARNING_10: 0.10,        // fraction triggers critical comms
  DETACH_SLOWMO_DURATION: 0.3,         // seconds of slo-mo on detach (slightly longer than catch)
  DETACH_SLOWMO_FACTOR: 0.08,          // time scale during detach slo-mo
  DETACH_MAX_DISTANCE: 50000,          // meters (50 km) — auto-destroy detached arm if it drifts beyond this

  // --- NavSphere Tether Zones (Phase 3 — reserve constants) ---
  NAVSPHERE_LASSO_RING_COLOR: 'rgba(255, 255, 255, 0.3)',
  NAVSPHERE_SPINNER_RING_COLOR: 'rgba(0, 255, 136, 0.25)',
  NAVSPHERE_WEAVER_RING_COLOR: 'rgba(0, 204, 255, 0.2)',

  // --- NavSphere Distance Encoding (Sprint S5-A) ---
  NAVSPHERE: {
    SPHERE_RADIUS: 140,               // px (matches current value)
    INNER_ZONE_KM: 5,                 // tactical zone boundary
    OUTER_ZONE_KM_MAX: 100,           // max awareness zone
    ZONE_SPLIT: 0.50,                 // fraction of radius for inner zone
    RANGE_RINGS_KM: [0.2, 0.5, 2, 5, 10, 25, 50],
    DOT_MIN_PX: 1.5,
    DOT_MAX_PX: 8,
    VELOCITY_TAIL_MAX_PX: 15,
    VELOCITY_SCALE_FACTOR: 200,
    VELOCITY_MIN_CONTACTS_KM: 10,
    CLOSURE_APPROACHING_THRESHOLD: -0.0001,
    CLOSURE_RECEDING_THRESHOLD: 0.0001,
    COLOR_APPROACHING: '#ff4444',
    COLOR_ORBIT_CROSS: '#ffaa00',
    COLOR_RECEDING: '#00ff88',
    COLOR_ZONE_BOUNDARY: 'rgba(255, 170, 0, 0.25)',
    MAX_VELOCITY_TAILS: 50,
    MAX_SHAPE_CONTACTS_VISIBLE: 200,
    // ST-5.4: NavSphere stalks, lock-on ring, geo readout, velocity arrows
    STALK_MAX_FRACTION: 0.25,            // stalk length as fraction of sphere radius R
    STALK_LINE_WIDTH: 0.8,
    STALK_ALPHA: 0.5,
    LOCK_ON_PULSE_RATE: 2.0,             // Hz — ring pulse frequency
    LOCK_ON_OUTER_RADIUS_MULT: 1.5,      // × dot radius
    LOCK_ON_INNER_RADIUS_MULT: 1.1,      // × dot radius
    GEO_UPDATE_HZ: 2,                    // geolocation readout refresh rate
    VELOCITY_ARROW_RANGE_KM: 50,         // contacts within this range get arrows
    VELOCITY_ARROW_MAX_KMS: 2,           // closure rate that maps to MAX_LENGTH
    VELOCITY_ARROW_MAX_LENGTH_PX: 4,
  },

  // =========================================================================
  // CODEX (Phase 7 — Learning Systems)
  // =========================================================================
  CODEX: {
    UNLOCK_COOLDOWN: 20,              // seconds between unlocks (reduced from 30 for better game feel)
    NOTIFICATION_DURATION: 4,         // seconds notification stays visible
  },

  // =========================================================================
  // CONJUNCTION GATING (ST-2.1 — prevents early-game alert panic)
  // + MOID badge thresholds & CA speed-up (ST-6.3)
  // =========================================================================
  CONJUNCTION: {
    MIN_CAPTURES: 1,            // Minimum captures before first alert allowed
    MIN_ELAPSED_S: 120,         // Seconds after first capture before first alert
    PRIMER_LEAD_S: 5,           // Comms primer fires this many seconds before first overlay

    // ST-6.3: MOID badge thresholds (metres)
    MOID_HI_M: 5_000,          // <5 km  → HI (red, "imminent")
    MOID_MD_M: 25_000,         // <25 km → MD (yellow, "monitor")
    MOID_LO_M: 100_000,        // <100 km → LO (blue-green, "noted")
    MOID_SAFE_M: Infinity,     // ≥100 km → SAFE (not surfaced)

    // ST-6.3: Badge UI colours & labels
    BADGE_COLOR_HI: '#ff3344',
    BADGE_COLOR_MD: '#ddcc00',
    BADGE_COLOR_LO: '#22aadd',
    BADGE_LABEL_HI: 'HI',
    BADGE_LABEL_MD: 'MD',
    BADGE_LABEL_LO: 'LO',

    // ST-6.3: CA speed-up — only top-N MOID-ranked pairs enter the CA hot loop
    CA_TOP_N: 32,
    CA_MOID_PREFILTER_M: 150_000, // objects with MOID above this excluded from CA

    // ST-6.3: MOID recompute cadence (game-time seconds)
    MOID_RECOMPUTE_INTERVAL_S: 5.0,
    MOID_COARSE_SAMPLES: 8,
    MOID_REFINE_SAMPLES: 8,
  },

  // =========================================================================
  // SPACE WEATHER (Phase 7 — Learning Systems)
  // =========================================================================
  SPACE_WEATHER: {
    SOLAR_FLARE_MIN_INTERVAL: 300,
    SOLAR_FLARE_MAX_INTERVAL: 600,
    SOLAR_FLARE_MIN_DURATION: 60,
    SOLAR_FLARE_MAX_DURATION: 120,
    GEOMAGNETIC_MIN_INTERVAL: 600,
    GEOMAGNETIC_MAX_INTERVAL: 1200,
    GEOMAGNETIC_MIN_DURATION: 90,
    GEOMAGNETIC_MAX_DURATION: 180,
    SAA_DURATION: 45,
    SAA_INTERVAL: 5400,
    ECLIPSE_DURATION: 2100,
    ECLIPSE_INTERVAL: 5520,
  },

  // =========================================================================
  // SUBSYSTEM EVENTS (Phase 7B — Spacecraft Subsystems)
  // =========================================================================
  SUBSYSTEMS: {
    GROUND_STATION_INTERVAL: [300, 400],   // min/max seconds
    GROUND_STATION_WINDOW: [30, 90],       // min/max seconds of contact
    STAR_TRACKER_INTERVAL: 600,
    IMU_DRIFT_INTERVAL: 900,
    GPS_DENIED_INTERVAL: 1200,
    REACTION_WHEEL_INTERVAL: 800,
    GYRO_CHECK_INTERVAL: 1500,
    BATTERY_CYCLE_INTERVAL: 1000,
    TELEMETRY_INTERVAL: 500,
    WATCHDOG_INTERVAL: 1200,
    ECC_INTERVAL: 2000,
    TMR_INTERVAL: 1800,
    ATOMIC_OXYGEN_INTERVAL: 700,
    UV_DEGRADATION_INTERVAL: 1000,
    MMOD_INTERVAL: 2500,
    RADIATION_DOSE_INTERVAL: 900,
  },

  // =========================================================================
  // COLLISION AVOIDANCE — Semi-autonomous evasive maneuver system
  // =========================================================================
  COLLISION_AVOIDANCE: {
    SCAN_RADIUS: 0.05,              // scene units (5 km)
    SCAN_RADIUS_SQ: 0.0025,         // pre-computed squared
    AVOIDANCE_RADIUS_M: 100,        // meters — dodge threshold
    AVOIDANCE_RADIUS: 0.001,        // scene units (100 m)
    WARN_THRESHOLD_M: 300,          // meters — warning threshold (no dodge)
    WARN_THRESHOLD: 0.003,          // scene units (300 m)
    TRAWL_AVOIDANCE_RADIUS_M: 50,   // meters — tighter threshold during trawl
    TRAWL_AVOIDANCE_RADIUS: 0.0005, // scene units (50 m)
    LOOK_AHEAD_S: 10,               // seconds — prediction window
    SCAN_INTERVAL: 0.25,            // seconds — scan every 250 ms (4 Hz)
    BASE_DODGE_DV: 0.5,             // m/s — peak dodge impulse
    COOLDOWN: 3.0,                  // seconds between dodges
    OVERRIDE_WINDOW: 1.5,           // seconds — player input cancels dodge
    ALERT_DISPLAY_TIME: 3.0,        // seconds — HUD threat indicator duration
    /** @deprecated Tutorial system removed Sprint 3. Retained for reference only. */
    TUTORIAL_MIN_STAGE: 7,          // suppress during tutorial stages 0-6 (DEPLOY stage onward in new 10-stage tutorial)
    ENABLED_DEFAULT: true,          // system on by default
  },

  // =========================================================================
  // AUTOPILOT — Trailing-rendezvous controller (see AUTOPILOT_ANALYSIS.md §D)
  // All distances in metres, velocities in m/s unless noted. Scene conversion
  // uses M = 1e-5 scene units / metre. See AutopilotSystem.js for usage.
  // =========================================================================
  AUTOPILOT: {
    // --- Tool-aware trailing distance (metres behind debris along V_d) ---
    D_TRAIL_LASSO:   120,  // m — lasso within 200 m projectile range
    D_TRAIL_ARMS:    35,   // m — spinner/weaver arm reach (~50 m)
    D_TRAIL_TRAWL:   150,  // m — trawl sweep trailing centroid
    D_TRAIL_DEFAULT: 80,   // m — fallback when no tool recommendation

    // --- Tolerance bands (state machine transitions) ---
    POS_TOL:          15,  // m — |P_m − P_m*| considered on-station
    VEL_TOL:          0.5, // m/s — |V_m − V_d| considered velocity-matched
    ANG_TOL_DEG:      3,   // degrees — nose vs. v̂_d alignment tolerance

    // --- Phase transition thresholds ---
    FAR_TO_MATCH_POS: 500, // m — RENDEZVOUS_FAR → MATCH_ORBIT when pos err below this
    HOLD_DURATION:    1.5, // s — HOLD phase duration before auto-disengage

    // --- Control law ---
    // Predictive quadratic-braking velocity profile (see AUTOPILOT_ANALYSIS.md §D
    // Retrospective #2 for rationale). Desired closing speed:
    //   v*(r) = min(V_CAP, √(2·A_BRAKE·max(r − POS_TOL, 0)))
    // where A_BRAKE = MAX_ACCEL·BRAKE_FRACTION leaves headroom for transverse
    // corrections. Commanded ΔV = KP_VEL·(v*·goalDir + relV_mps), clamped by
    // MAX_ACCEL·dt. This replaces a proportional-only law that had no
    // predictive-braking term and overshot by hundreds of metres from >500 m
    // engage distance.
    MAX_ACCEL:        2.0, // m/s² — clamp per-tick commanded acceleration
    KP_VEL:           0.8, // dimensionless — velocity tracking gain
    BRAKE_FRACTION:   0.5, // fraction of MAX_ACCEL reserved for along-track braking
    V_CAP:           50.0, // m/s — hard cap on commanded closing speed v*
    KP_POS:           0.2, // 1/s — deprecated; retained for compatibility, not used in control law

    // --- Station-keeping recoil compensation (ST-4.B) ---
    STATION_KEEP_COMPENSATION: true,  // master toggle for tool-fire recoil compensation in HOLD
    STATION_KEEP_EFFICIENCY:   0.85,  // fraction of theoretical ΔV applied (thruster losses)
  },

  // =========================================================================
  // SKILLS DISCOVERY — Replaces linear 10-stage tutorial
  // See SKILLS_ARCHITECTURE.md for full specification (34 discoverable skills)
  // =========================================================================
  SKILLS: {
    // --- State Transition Thresholds ---
    PRACTICE_COUNT_DEFAULT: 5,       // uses to reach PRACTICED state
    PRACTICE_COUNT_SCAN: 3,          // quick actions need fewer uses
    PRACTICE_COUNT_CATCH: 3,         // significant actions need fewer uses
    PRACTICE_COUNT_COMPLEX: 2,       // complex skills (arm_pilot) need fewer uses
    MASTERY_COUNT_DEFAULT: 20,       // uses to reach MASTERED state
    MASTERY_COUNT_CATCH: 10,         // catch skills master faster
    MASTERY_MIN_TIME: 300,           // seconds (5 min minimum before mastery)

    // --- UI Timing ---
    PANE_SHOW_DURATION: 4000,        // ms — how long pane stays visible after discovery
    PANE_FIRST_SKILL_DURATION: 8000, // ms — first 3 discoveries get longer display
    PANE_FADE_DURATION: 600,         // ms — fade out animation
    MASTERED_FADE_DELAY: 30000,      // ms — delay before mastered skills fade from pane

    // --- Spaced Repetition (SM-2 variant) ---
    REMINDER_BASE_INTERVAL: 45,      // seconds — base interval between reminders
    REMINDER_MAX_INTERVAL: 86400,    // seconds — cap at 24h
    REMINDER_MIN_INTERVAL: 30,       // seconds — floor
    REMINDER_EASE_FACTOR: 2.5,       // SM-2 ease factor
    REMINDER_FREQUENCY_CAP: 3,       // max reminders per cap window
    REMINDER_CAP_WINDOW: 300,        // seconds — window for frequency cap

    // --- Blitz Detection (veteran/expert player) ---
    BLITZ_WINDOW: 8000,              // ms — variable ratio window for early rapid discovery
    BLITZ_SUPPRESS_CHANCE: 0.3,      // probability of suppressing reminder during blitz
    BLITZ_THRESHOLD: 15,             // skills in detection window → expert mode
    BLITZ_DETECTION_WINDOW: 300,     // seconds (5 min) — window for blitz rate calculation

    // --- Discovery Queue ---
    DISCOVERY_COOLDOWN: 3,           // seconds between pane popups
    DISCOVERY_BATCH_THRESHOLD: 5,    // above this → batch notification
    EARLY_DISCOVERY_COUNT: 10,       // first N discoveries get variable ratio reinforcement

    // --- Safety Gates ---
    DETACH_MIN_CATCHES: 2,           // mastery_detach requires ≥2 total catches
    TRAWL_MIN_CATCHES: 1,            // collect_trawl requires ≥1 total catch

    // --- Tier Definitions (5 tiers with progression colors) ---
    TIERS: [
      { id: 'orientation',  tier: 1, label: 'Orientation',  color: '#00ff88' },
      { id: 'core_tools',   tier: 2, label: 'Core Tools',   color: '#44ddff' },
      { id: 'proficiency',  tier: 3, label: 'Proficiency',  color: '#4488ff' },
      { id: 'advanced',     tier: 4, label: 'Advanced',     color: '#8866ff' },
      { id: 'mastery',      tier: 5, label: 'Mastery',      color: '#cc44dd' },
    ],

    // --- Skill Catalog (33 skills) -----------------------------------------------------------
    // Fields: id, label, key, tier, category, hudGroup, prereqs, prereqType, noReminder, triggerEvent
    // triggerEvent: Events.js constant name (string key) or null if auto/timer/needs new event
    // prereqType: 'none' | 'soft' | 'hard' | 'safety'
    //   none   — independent, discoverable any time in any order
    //   soft   — works without prereq but system provides contextual guidance
    //   hard   — physically impossible without prior game state
    //   safety — irreversible destructive action gated by catch count
    CATALOG: [
      // ── Tier 1: Orientation (6 skills — independent, any order) ─────────
      { id: 'nav_zoom',         label: 'Zoom',         key: 'Scroll',    tier: 1, category: 'nav',       hudGroup: null,            prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'CAMERA_ZOOM' },
      { id: 'nav_rotate',       label: 'Rotate View',  key: 'Drag',      tier: 1, category: 'nav',       hudGroup: null,            prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'CAMERA_ORBIT_DRAG' },
      { id: 'nav_camera',       label: 'Camera Views', key: 'V',         tier: 1, category: 'nav',       hudGroup: null,            prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'CAMERA_VIEW_CHANGE' },
      { id: 'nav_arrows',       label: 'Ship Rotation', key: '←↑↓→',    tier: 1, category: 'nav',       hudGroup: null,            prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'TUTORIAL_ARROW_INPUT' },
      { id: 'nav_throttle',     label: 'Throttle',     key: 'Shift/Ctrl', tier: 1, category: 'nav',      hudGroup: 'propulsion',    prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'THROTTLE_CHANGE' },
      { id: 'scan_quick',       label: 'Quick Scan',   key: 'S',         tier: 1, category: 'scan',      hudGroup: 'targets',       prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'SCAN_QUICK' },
      // ── Tier 2: Core Tools (6 skills) ───────────────────────────────────
      { id: 'scan_wide',            label: 'Wide Scan',    key: 'W',     tier: 2, category: 'scan',      hudGroup: null,            prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'SCAN_WIDE' },
      { id: 'nav_target',           label: 'Target Selection', key: 'Tab', tier: 2, category: 'nav',     hudGroup: 'target-info',   prereqs: [],  prereqType: 'soft', noReminder: false, triggerEvent: 'TARGET_SELECTED' },
      { id: 'nav_autopilot',        label: 'Autopilot',    key: 'A',     tier: 2, category: 'nav',       hudGroup: 'orbit-mfd',     prereqs: [],  prereqType: 'soft', noReminder: false, triggerEvent: 'AUTOPILOT_ENGAGE' },
      { id: 'collect_deploy',       label: 'Deploy Arm',   key: 'D',     tier: 2, category: 'collect',   hudGroup: 'fleet',         prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'ARM_DEPLOYED' },
      { id: 'collect_lasso',        label: 'Lasso',        key: 'Space', tier: 2, category: 'collect',   hudGroup: null,            prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'LASSO_FIRED' },
      { id: 'awareness_mouse_look', label: 'Mouse Look',   key: null,    tier: 2, category: 'awareness', hudGroup: null,            prereqs: [],  prereqType: 'none', noReminder: true,  triggerEvent: 'CAMERA_FREE_LOOK' },

      // ── Tier 3: Proficiency (7 skills) ──────────────────────────────────
      { id: 'nav_autopilot_no_target', label: 'Autopilot w/o Target', key: null, tier: 3, category: 'nav',    hudGroup: null,          prereqs: [],  prereqType: 'none', noReminder: true,  triggerEvent: 'AUTOPILOT_NO_TARGET' },
      { id: 'scan_discovery',          label: 'Scan Discovery',       key: null, tier: 3, category: 'scan',   hudGroup: null,          prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'SCAN_DISCOVERY' },
      { id: 'collect_dual_fire',       label: 'Dual Fire',            key: null, tier: 3, category: 'collect', hudGroup: null,          prereqs: [],  prereqType: 'hard', noReminder: false, triggerEvent: 'DUAL_FIRE' },
      { id: 'collect_trawl',           label: 'Trawl',                key: 'T',  tier: 3, category: 'collect', hudGroup: null,          prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'TRAWL_START' },
      { id: 'manage_power',            label: 'Power Distribution',   key: '1/2/3', tier: 3, category: 'manage', hudGroup: 'power',    prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'POWER_BUS_SELECTED' },
      { id: 'manage_comms',            label: 'Comms Menu',           key: 'C',  tier: 3, category: 'manage', hudGroup: 'comms',       prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'COMMS_OPENED' },
      { id: 'manage_codex',            label: 'Tech Library',         key: 'L',  tier: 3, category: 'manage', hudGroup: null,          prereqs: [],  prereqType: 'none', noReminder: false, triggerEvent: 'CODEX_OPENED' },

      // ── Tier 4: Advanced (7 skills) ─────────────────────────────────────
      { id: 'nav_orbit_mfd',      label: 'Orbit MFD Reading',   key: 'M',  tier: 4, category: 'nav',       hudGroup: null,  prereqs: ['nav_autopilot'],  prereqType: 'soft',   noReminder: false, triggerEvent: 'ORBIT_MFD_TOGGLE' },
      { id: 'collect_pulse_scan', label: 'Pulse Scan',           key: null, tier: 4, category: 'collect',   hudGroup: null,  prereqs: [],                  prereqType: 'none',   noReminder: false, triggerEvent: 'PULSE_SCAN_START' },
      { id: 'collect_lasso_miss', label: 'Lasso Miss Recovery',  key: null, tier: 4, category: 'collect',   hudGroup: null,  prereqs: ['collect_lasso'],   prereqType: 'hard',   noReminder: true,  triggerEvent: 'LASSO_MISSED' },
      { id: 'manage_forge',       label: 'Forge',                key: 'R',  tier: 4, category: 'manage',    hudGroup: null,  prereqs: [],                  prereqType: 'none',   noReminder: false, triggerEvent: 'FORGE_TOGGLE' },
      { id: 'manage_shop',        label: 'Shop Navigation',      key: null, tier: 4, category: 'manage',    hudGroup: null,  prereqs: [],                  prereqType: 'none',   noReminder: false, triggerEvent: 'UPGRADE_PURCHASED' },
      { id: 'awareness_kessler',  label: 'Kessler Event',        key: null, tier: 4, category: 'awareness', hudGroup: null,  prereqs: [],                  prereqType: 'none',   noReminder: true,  triggerEvent: 'KESSLER_CASCADE' },
      { id: 'awareness_weather',  label: 'Space Weather',        key: null, tier: 4, category: 'awareness', hudGroup: null,  prereqs: [],                  prereqType: 'none',   noReminder: true,  triggerEvent: 'WEATHER_EFFECT_START' },

      // ── Tier 5: Mastery (7 skills) ──────────────────────────────────────
      { id: 'nav_hohmann',        label: 'Hohmann Transfer',     key: null,  tier: 5, category: 'nav',       hudGroup: null,  prereqs: ['nav_orbit_mfd'],  prereqType: 'soft',   noReminder: false, triggerEvent: 'AUTOPILOT_ARRIVED' },
      { id: 'collect_arm_pilot',  label: 'ARM PILOT Mode',       key: 'P',   tier: 5, category: 'collect',   hudGroup: null,  prereqs: [],                  prereqType: 'soft',   noReminder: false, triggerEvent: 'ARM_SELECT' },
      { id: 'mastery_detach',     label: 'Risk Detach',          key: 'X',   tier: 5, category: 'collect',   hudGroup: null,  prereqs: ['collect_deploy'],  prereqType: 'safety', noReminder: false, triggerEvent: 'ARM_DETACHED',       safetyGate: { minCatches: 2 } },
      { id: 'mastery_tool_cycle', label: 'Tool Cycling',         key: 'Shift+`', tier: 5, category: 'manage', hudGroup: null, prereqs: [],                  prereqType: 'none',   noReminder: false, triggerEvent: 'TOOL_CYCLE' },
      { id: 'mastery_ca_dodge',   label: 'CA Manual Override',   key: null,  tier: 5, category: 'awareness', hudGroup: null,  prereqs: [],                  prereqType: 'none',   noReminder: false, triggerEvent: 'CA_DODGE_EXECUTED' },
      { id: 'mastery_synergy',    label: 'Synergistic Salvage',  key: null,  tier: 5, category: 'collect',   hudGroup: null,  prereqs: [],                  prereqType: 'hard',   noReminder: false, triggerEvent: 'SYNERGY_BONUS' },
      { id: 'mastery_full_sweep', label: 'Full Sweep',           key: null,  tier: 5, category: 'collect',   hudGroup: null,  prereqs: [],                  prereqType: 'hard',   noReminder: false, triggerEvent: 'TRAWL_SWEEP_COMPLETE' },
    ],

    // --- Celebration (ST-3.4: PRACTICED / MASTERED feedback) ---
    CELEBRATION: {
        MASTERY_TOAST_THRESHOLD: 3,      // first N masteries get the large centered toast
        MASTERY_TOAST_DURATION_MS: 2000,
        PRACTICE_FLASH_MS: 650,
        MASTERY_FLASH_MS: 1200,
    },

    // --- Discovery Pane (ST-3.1: NOVICE checklist mode) ---
    DISCOVERY_PANE: {
        CHECKLIST_SUGGESTION_COUNT: 3,
        CHECKLIST_DONE_LINGER_MS: 3000,
        CHECKLIST_PULSE_PERIOD_MS: 1400,
    },
  },

  // === HUD PANEL READABILITY (ST-2.2) ===
  HUD_PANEL_BG_ALPHA: 0.95,             // Base panel background opacity
  HUD_PANEL_EARTH_OVERLAP_ALPHA: 0.98,  // Fallback when overlapping bright Earth
  SELECTED_ROW_ALPHA: 0.22,             // Target list selected‐row highlight
  SELECTED_ROW_GLOW_ALPHA: 0.4,         // Inset box-shadow glow
  SELECTED_ROW_TEXT_GLOW: 0.5,          // Text-shadow on selected name
  WIREFRAME_BG_ALPHA: 0.95,             // Debris wireframe panel background
  RETICLE_PULSE_HZ: 0.8,               // Bracket breathing oscillation frequency
  RETICLE_BRACKET_WIDTH: 2.0,           // Unselected bracket lineWidth (up from 1.5)
  RETICLE_BRACKET_WIDTH_SELECTED: 3.0,  // Selected bracket lineWidth (up from 2.5)

  // === DEBRIS VISUAL MATERIALS (ST-2.3) ===
  DEBRIS_MATERIALS: {
    aluminum:   { metalness: 0.9,  roughness: 0.3,  color: 0xC0C0C0 },   // bright reflective
    titanium:   { metalness: 0.85, roughness: 0.4,  color: 0x8A9BA8 },   // darker metallic
    composite:  { metalness: 0.2,  roughness: 0.7,  color: 0x3A3A3A },   // dark matte
    mli_mylar:  { metalness: 0.95, roughness: 0.15, color: 0xFFD700 },   // gold foil
    solar_cell: { metalness: 0.6,  roughness: 0.5,  color: 0x1A237E },   // dark blue
  },

  // === DEBRIS VISUAL TUMBLE CLAMPING (ST-2.3 → v2e) ===
  // v2e: Reduced from 30°/s → 10°/s per user feedback ("jagged object rotating fast").
  // At 60fps that's 0.17°/frame — much smoother perceived motion on small
  // jagged geometry without compromising the "actively tumbling" feel.
  DEBRIS_MAX_VISUAL_TUMBLE_DEG_S: 10,   // max visual tumble rate in °/s (real time) — 3D scene
  WIREFRAME_MAX_TUMBLE_DEG_S: 8,        // max wireframe tumble rate in °/s — lower for Canvas2D comfort

  // === DEBRIS FRAGMENT VARIATION (ST-2.3) ===
  DEBRIS_FRAGMENT_VARIANTS: 7,           // number of distinct fragment geometry variants

  // =========================================================================
  // SKILL_GATES — Sprint 3 skill-based feature gating thresholds
  // Replaces removed TutorialSystem stage-number gates.
  // =========================================================================
  SKILL_GATES: {
    CONJUNCTION_MIN_CATCHES: 1,          // minimum captures before conjunction alerts fire
    CONJUNCTION_MIN_ELAPSED_S: 120,      // seconds after first capture before conjunction alerts
    KESSLER_MIN_MISSION: 4,             // mission number before Kessler warnings activate
    SUBSYSTEM_MIN_CATCHES: 1,           // minimum captures before subsystem chatter
  },

  // =========================================================================
  // DEBRIS MAP (ST-4.A — Cluster-ranked strategic sweep planning overlay)
  // =========================================================================
  DEBRIS_MAP: {
    POLL_INTERVAL_S: 5,       // seconds between cluster re-polls
    MAX_DISPLAY: 5,           // top-N clusters shown in the map
    MAX_DV_MS: 500,           // clusters requiring > this ΔV (m/s) are "unreachable"
  },

  // =========================================================================
  // MISSIONS — ST-4.C Mission Spawn Difficulty Profiles
  // Each profile applies when missionNumber >= minMission (highest matching wins).
  // =========================================================================
  MISSIONS: {
    DEBRIS_PER_MISSION: 5,    // matches existing Math.floor(debrisCleared / 5) + 1
    PROFILES: [
      {
        minMission: 1,
        label: 'Orientation',
        clusters: 1,          // nearby cluster count to guarantee
        hydrazine: false,     // exclude hydrazine from salvage
        conjunction: false,   // suppress conjunction events
        kessler: false,       // suppress Kessler cascade
        synergy: false,       // no synergy pairs forced
        untracked: 0,         // count of untracked (scan-reveal) debris
        weather: false,       // suppress weather events
        activeSats: false,    // no active satellite hazards
      },
      {
        minMission: 2,
        label: 'First Operations',
        clusters: 2,
        hydrazine: true,      // tracked hydrazine tank allowed
        conjunction: false,
        kessler: false,
        synergy: false,
        untracked: 0,
        weather: false,
        activeSats: false,
      },
      {
        minMission: 4,
        label: 'Expanding Field',
        clusters: 4,
        hydrazine: true,
        conjunction: false,
        kessler: false,
        synergy: true,        // 1 synergy pair forced
        untracked: 2,         // 2 scan-reveal untracked debris
        weather: false,
        activeSats: false,
      },
      {
        minMission: 7,
        label: 'Full Operations',
        clusters: 6,
        hydrazine: true,
        conjunction: true,
        kessler: true,
        synergy: true,
        untracked: 4,
        weather: false,
        activeSats: false,
      },
      {
        minMission: 10,
        label: 'Unrestricted',
        clusters: null,       // null = no limit, full random
        hydrazine: true,
        conjunction: true,
        kessler: true,
        synergy: true,
        untracked: null,      // null = random distribution
        weather: true,
        activeSats: true,
      },
    ],
  },

  // =========================================================================
  // MISSION EVENTS — ST-4.D Dynamic Mid-Mission Event System
  // =========================================================================
  MISSION_EVENTS: {
    COOLDOWN_MS: 30000,                         // minimum 30s between repeated events of same type
    SYNERGY_TIMER_MS: 300000,                   // 5 minutes for synergy opportunity window
    CONJUNCTION_ACCUMULATION_WINDOW_MS: 60000,  // 1 min window for counting conjunctions
    MIN_CONJUNCTION_ALERTS: 2,                  // number of warnings needed for cluster conjunction
    HYDRAZINE_BONUS_POINTS: 500,                // points awarded for hydrazine hazard discovery
  },

  // === TRAIL SYSTEM (ST-5.2) ===
  TRAILS: {
    SAMPLE_RATE_HZ: 10,                // samples per game-second
    MOTHER_BUFFER_SECONDS: 90,         // player trail history length (game-seconds)
    ARM_BUFFER_SECONDS: 30,            // arm trail history length (game-seconds)
    MOTHER_WIDTH_SCALE: 1.0,           // ribbon width multiplier for player trail
    ARM_TRAIL_WIDTH: 0.5,              // ribbon width multiplier for arm trails
    PROGRADE_DOT_THRESHOLD: 0.7,       // dot > this → prograde (green)
    RETROGRADE_DOT_THRESHOLD: -0.7,    // dot < this → retrograde (red); else → amber
    FADE_ALPHA_MIN: 0.05,              // alpha of oldest point in buffer
    COLOR_PROGRADE: 0x22ff66,          // green
    COLOR_RETROGRADE: 0xff3344,        // red
    COLOR_NORMAL: 0xffaa22,            // amber (radial/normal-plane)
    COLOR_ARM: 0xe6e6ff,               // near-white, slight blue tint
    BASE_WIDTH_METRES: 5,              // base ribbon width in metres (multiplied by M at render)
    STALE_HIDE_SECONDS: 3,             // seconds after last sample before trail hides
    MIN_SAMPLE_DIST_M: 2,             // minimum metres between consecutive samples
    ENABLED: false,                    // master toggle (disabled — pending visual rework)
  },

  // === COMMS SYSTEM (ST-5.1) ===
  COMMS: {
    CHANNELS: ['CMD', 'ALERT', 'HOUSTON', 'SCI', 'FLAVOR', 'MISSION'],
    CHANNEL_COLORS: {
      CMD: '#ffaa00',
      ALERT: '#ff4444',
      HOUSTON: '#88ffcc',
      SCI: '#00ccff',
      FLAVOR: '#888888',
      MISSION: '#ffd700',
    },
    DEFAULT_CHANNEL: 'FLAVOR',
    COALESCE_THRESHOLD_COUNT: 3,
    COALESCE_WINDOW_MS: 2000,
    PANE_HEIGHT_PX: 144,
    PANE_WIDTH_PX: 480,                   // fits ~70 chars per line (UX-2 #11)
    PANE_LINES_DEFAULT: 4,                // collapsed line count (UX-2 #11)
    PANE_LINES_EXPANDED: 10,              // expanded line count (UX-2 #10)
    PANE_EXPAND_HEIGHT_PX: 300,
    PANE_EXPAND_HOLD_MS: 3000,
    STRIPE_WIDTH_PX: 3,
    C_HOLD_THRESHOLD_MS: 300,
    C_TAP_MAX_MS: 250,
    RADIAL_RADIUS_PX: 90,
    RADIAL_OPTION_COUNT: 6,
    FILTER_STORAGE_KEY: 'SC_comms_filters_v1',
  },

  // ============================================================================
  // ST-6.6: TECHNOLOGY READINESS LEVEL (TRL) — NASA scale 1–9
  // Used for colour-coded badges on Codex entries, Shop upgrades, and the
  // active-tool indicator. Display-only metadata — NEVER used for gating.
  // See BIG_PICTURE.md §25 for TRL rationale and V5 composition baseline.
  // ============================================================================
  TRL: {
    // --- Tier threshold levels ---
    FLIGHT_PROVEN_MIN: 9,      // exactly TRL 9 → flight-proven
    MATURE_MIN:        7,      // TRL 7–8 → mature
    RESEARCH_MIN:      4,      // TRL 4–6 → research
    SPECULATIVE_MIN:   1,      // TRL 1–3 → speculative

    // --- Badge colours ---
    COLOR_FLIGHT_PROVEN: '#22dd44', // green   — TRL 9
    COLOR_MATURE:        '#ddcc00', // yellow  — TRL 7–8
    COLOR_RESEARCH:      '#ff9900', // amber   — TRL 4–6
    COLOR_SPECULATIVE:   '#ff3344', // red     — TRL 1–3

    // --- Label strings for tooltips / screen readers ---
    LABEL_FLIGHT_PROVEN: 'Flight-proven',
    LABEL_MATURE:        'Mature',
    LABEL_RESEARCH:      'Research',
    LABEL_SPECULATIVE:   'Speculative',

    // --- Validation range ---
    MIN_VALID: 1,
    MAX_VALID: 9,
  },

  // ============================================================================
  // ST-6.1: OFFLINE CATALOGUE (CatalogLoader paths + timeouts)
  // Paths are relative to index.html; loader issues parallel fetches from META.
  // ============================================================================
  CATALOG: {
    BASE_PATH: './data/',
    META_FILE: 'META.json',
    LOAD_TIMEOUT_MS: 10000,
    MAX_PARALLEL_FETCHES: 8,
  },

  // ============================================================================
  // ST-6.1: DEBRIS FIELD ALTITUDE BANDS (7-band layout — VLEO + MEO added)
  // Weights sum to ~1.0. Shared by interactive debris + background Points.
  // Real catalogue entries predominantly occupy VLEO (ISS-class), LEO, and MEO.
  // ============================================================================
  DEBRIS: {
    INTERACTIVE_COUNT: 800,
    BACKGROUND_COUNT: 5000,
    ALT_BANDS: [
      { label: 'VLEO',     min:   180, max:  400, weight: 0.12 },  // ISS, Tiangong, early-reentry debris
      { label: 'LEO-low',  min:   400, max:  600, weight: 0.14 },  // Sentinel, Hubble, Starlink
      { label: 'LEO-mid',  min:   600, max:  900, weight: 0.26 },  // Fengyun-1C, Iridium-33, dense debris belt
      { label: 'LEO-high', min:   900, max: 1200, weight: 0.18 },  // Cosmos constellations
      { label: 'LEO-top',  min:  1200, max: 2000, weight: 0.12 },  // Globalstar, legacy military
      { label: 'MEO',      min:  2000, max:21000, weight: 0.12 },  // GPS, GLONASS, Galileo, BeiDou
      { label: 'GEO',      min: 33000, max:36000, weight: 0.06 },  // GEO graveyard, GOES, comms sats
    ],
  },

  // ============================================================================
  // ST-6.2: DEBRIS VISUAL — Type texture atlas + Flag decal atlas constants
  // Procedural Canvas2D textures; no external image files.
  // ============================================================================
  DEBRIS_VISUAL: {
    ATLAS_SIZE: 1024,           // px; type texture atlas dimension
    FLAG_ATLAS_SIZE: 512,       // px; flag decal atlas dimension
    FLAG_SLOT_SIZE: 128,        // px per flag slot in atlas
    TYPE_SLOT_COLS: 3,          // atlas grid layout columns
    TYPE_SLOT_ROWS: 2,          // atlas grid layout rows
    FLAG_SLOT_COLS: 4,          // flag atlas grid columns
    FLAG_SLOT_ROWS: 4,          // flag atlas grid rows

    // Type base colours (hex strings)
    COLOR_DEBRIS:      '#666666',
    COLOR_ROCKET_BODY: '#aaaabb',
    COLOR_INACTIVE:    '#333366',
    COLOR_ACTIVE:      '#eeeeff',
    COLOR_UNKNOWN:     '#665544',
    COLOR_FRAGMENT:    '#333333',

    // MOID emissive glow intensities
    EMISSIVE_HI_INTENSITY: 0.3,
    EMISSIVE_MD_INTENSITY: 0.15,

    // Wireframe / textured toggle
    DEFAULT_MODE: 'textured',   // 'textured' | 'wireframe'
  },

  // ============================================================================
  // ST-6.5: TEACHING SYSTEM — First-encounter contextual overlays
  // Non-blocking, show-once teaching moments triggered by game events.
  // ============================================================================
  TEACHING: {
    OVERLAY_WIDTH_PX: 400,
    OVERLAY_MIN_WIDTH_PX: 280,
    OVERLAY_TOP_MARGIN_PX: 20,
    OVERLAY_BG: 'rgba(0, 10, 20, 0.85)',
    OVERLAY_BORDER_COLOR: '#00ccff',
    OVERLAY_TITLE_COLOR: '#00ccff',
    OVERLAY_BODY_COLOR: '#ccddee',
    FADE_IN_MS: 300,
    FADE_OUT_MS: 500,
    MAX_QUEUE_DEPTH: 3,
    DEFAULT_DURATION_MS: 7000,
    PERSISTENCE_KEY: 'teachingSeen',
    TOTAL_MOMENTS: 17,           // UX-3 N1: added first_scan + first_arm_deploy
  },

  // ============================================================================
  // ST-6.7: ENVIRONMENT HAZARD SYSTEM — Five periodic/altitude-dependent effects
  // that create strategic pressure on the player. Degradation rates are tuned
  // for "long-session gradually accumulates" not "instant death".
  // ============================================================================
  ENVIRONMENT: {
    // ── Atomic Oxygen ──────────────────────────────────────────────────────
    AO_THRESHOLD_KM: 600,
    AO_TICK_INTERVAL_S: 10,
    AO_ARM_DEGRADATION: 0.002,         // 0.2% per tick
    AO_PANEL_DEGRADATION: 0.001,       // 0.1% per tick
    AO_SKILL_MITIGATION: 0.5,          // halved with manage_power

    // ── MMOD (Micro-Meteoroid / Orbital Debris) ───────────────────────────
    MMOD_CHECK_INTERVAL_S: 30,
    MMOD_BASE_PROBABILITY: 0.02,       // 2% per check
    MMOD_DAMAGE_FRACTION: 0.05,        // 5% of subsystem health
    MMOD_SUBSYSTEM_WEIGHTS: { arms: 0.4, sensors: 0.25, comms: 0.2, power: 0.15 },
    MMOD_SKILL_MITIGATION: 0.5,        // halved with advanced_sensors
    MMOD_WEATHER_AMPLIFIER: 1.5,       // during CME → ×1.5 probability

    // ── Safe Mode ─────────────────────────────────────────────────────────
    SAFE_MODE_CHECK_INTERVAL_S: 10,
    SAFE_MODE_HEALTH_THRESHOLD: 0.25,
    SAFE_MODE_RECOVERY_THRESHOLD: 0.40,
    SAFE_MODE_SENSOR_PENALTY: 0.5,

    // ── Radiation Belt ────────────────────────────────────────────────────
    RADIATION_BELT_LOW_KM: 2000,
    RADIATION_BELT_HIGH_KM: 12000,
    RADIATION_SENSOR_PENALTY: 0.3,
    RADIATION_COMMS_DELAY_S: 2,
    RADIATION_NOISE_INTERVAL_S: 15,
    RADIATION_SKILL_MITIGATION: 0.6,   // 60% reduction with radiation_hardening

    // ── Battery Depth-of-Discharge ────────────────────────────────────────
    DOD_DEEP_DISCHARGE_THRESHOLD: 0.2,
    DOD_RECHARGE_THRESHOLD: 0.8,
    DOD_CYCLE_PENALTY_INTERVAL: 10,
    DOD_CAPACITY_LOSS: 0.02,           // 2% per penalty interval
    DOD_SKILL_MITIGATION: 0.5,         // halved with manage_power
  },

  // ============================================================================
  // ST-6.4: STRATEGIC MAP — Zoomed-out 3-D orbital overview (Shift+V toggle)
  // Renders the full orbital environment: Earth wireframe, altitude band rings,
  // debris dots, player marker + orbit ellipse, hazard zones, ground stations,
  // top-N threat overlay, and legend/status bar.
  // ============================================================================
  STRATEGIC_MAP: {
    CAMERA_FOV: 45,
    CAMERA_NEAR: 0.1,
    CAMERA_FAR: 100000,
    CAMERA_INITIAL_DISTANCE: 800,     // scene units (~3× GEO in scene scale)
    CAMERA_ELEVATION_DEG: 45,
    CAMERA_TRANSITION_MS: 500,
    ZOOM_MIN: 50,                     // scene units (don't zoom inside Earth)
    ZOOM_MAX: 5000,                   // scene units
    ORBIT_SEGMENTS: 64,               // segments for player orbit ellipse
    DOT_SIZE_DEBRIS: 2,
    DOT_SIZE_PLAYER: 5,
    DOT_SIZE_GROUND_STATION: 3,
    EARTH_WIREFRAME_COLOR: '#1a4a5a',
    PLAYER_COLOR: '#00ffcc',
    PLAYER_ORBIT_COLOR: '#00ccff',
    THREAT_LIST_COUNT: 5,
    AO_ZONE_COLOR: '#ff6600',
    AO_ZONE_OPACITY: 0.06,
    RADIATION_ZONE_COLOR: '#cc44ff',
    RADIATION_ZONE_OPACITY: 0.05,
    GROUND_STATION_COLOR: '#22ff44',
    ALT_BAND_COLORS: ['#22aa44', '#22aa44', '#22aadd', '#22aadd', '#22aadd', '#ddcc00', '#aa44dd'],
    ALT_BAND_OPACITY: [0.10, 0.10, 0.08, 0.08, 0.08, 0.06, 0.05],
    DOT_COLOR_DEBRIS:      '#888888',
    DOT_COLOR_ROCKET_BODY: '#aaaabb',
    DOT_COLOR_INACTIVE:    '#444488',
    DOT_COLOR_ACTIVE:      '#eeeeff',
    DOT_COLOR_FRAGMENT:    '#555555',
    DOT_COLOR_FALLBACK:    '#666666',
    MOID_PULSE_SPEED:      4,               // Hz — red pulse speed for HI-badge debris
  },

  // =========================================================================
  // EPIC 8 — STATION_KEEP & FEEP ION THRUSTER PARAMETERS
  // =========================================================================

  // === ION_THRUSTER — FEEP engine parameters ===
  ION_THRUSTER: {
    WEAVER_MAX_THRUST: 0.00128,    // N — peak thrust Weaver arm
    SPINNER_MAX_THRUST: 0.0008,    // N — peak thrust Spinner arm
    ISP_MIN: 4000,                 // s — minimum specific impulse
    ISP_MAX: 19000,                // s — maximum specific impulse
    ISP_DEFAULT: 10000,            // s — default operating ISP
    BEAM_POWER_WEAVER: 40,         // W — beam power Weaver
    BEAM_POWER_SPINNER: 25,        // W — beam power Spinner
    EFFICIENCY: 0.6,               // η — overall thruster efficiency
    VECTOR_ANGLE_MAX: 15,          // deg — max thrust vectoring angle
    PROPELLANT: 'indium',          // default propellant
    THRUSTER_COUNT: 2,             // thrusters per arm
    // Auto-ISP modes for different flight phases
    ISP_TRANSIT: 12000,            // s — high-ISP cruise
    ISP_APPROACH: 8000,            // s — moderate for maneuvering
    ISP_STATIONKEEP: 15000,        // s — high-ISP low-thrust hold
    ISP_TENSION: 6000,             // s — medium for tether control
    ISP_RETURN: 10000,             // s — balanced return
    ISP_DEORBIT: 4000,             // s — max thrust for deorbit
  },

  // === STATION_KEEP — orbital-crane positioning ===
  STATION_KEEP: {
    DEFAULT_STANDOFF_MULT: 1.5,    // × debris size for initial standoff
    DEFAULT_STANDOFF: 8.0,         // m — initial standoff on SK entry (mid-band of
                                   //     4–12 m so ±/=/wheel give equal zoom range
                                   //     in either direction. Debug session
                                   //     2026-05-17 polish.
    MIN_STANDOFF: 4.0,             // m — minimum standoff distance (debug session
                                   //     2026-05-15 polish: widened 8→4 per user.
                                   //     At a 50° FOV the near plane (≥0.01 scene
                                   //     units = 1m world) still clears comfortably.
                                   //     The pilot now has room for close-inspection
                                   //     framing while ±/=/wheel give live zoom
                                   //     control over the full 4–12 m band.
    MAX_STANDOFF: 12.0,            // m — maximum standoff distance (debug session
                                   //     2026-05-15 polish: tightened 15→12 so the
                                   //     debris stays a meaningful size in frame
                                   //     even at the far end; 12 m also fits the
                                   //     mouse-wheel granularity (0.5 m / tick →
                                   //     16 ticks to traverse the full band).
    WHEEL_STEP_M: 0.5,             // m per mouse-wheel tick — instantaneous
                                   //     radius delta (not rate-based). 16 ticks
                                   //     covers the 4→12 m range.
    ORBIT_RATE: 0.5,               // rad/s — orbit angular rate
    ORBIT_RATE_FINE: 0.125,        // rad/s — fine orbit angular rate
    RADIUS_RATE: 1.0,              // m/s — radial approach/retreat rate
    RADIUS_RATE_FINE: 0.25,        // m/s — fine radial rate
    MAX_LATITUDE: 80,              // deg — max phi angle from equator
    TETHER_SAFETY_MARGIN: 10,      // deg — phi margin for tether clearance
    THETA_LIMIT_DEG: 120,          // deg — max θ swing ±around entry value during SK.
                                   // Prevents tether wrap (mother→arm tether tangles
                                   // around the debris past ~180°) and pilot
                                   // disorientation (mother leaves peripheral view
                                   // past ~90°). 120° = comfortable 240° inspection
                                   // arc keeping mother in view and tether unwound.
                                   // See debug session 2026-05-15.
    // ── Auto-return (Pattern C: dwell-then-ease) ──
    // 1. Hold arrow → daughter rotates.
    // 2. Release → daughter freezes for AUTO_RETURN_DWELL_S (no motion).
    // 3. After dwell → exponential ease back to entry (τ = AUTO_RETURN_TIME_CONSTANT_S).
    // 4. Press any arrow → cancel ease, reset dwell.
    // 5. Press 'R' (recenter) → skip dwell, fast snap back (τ_SNAP).
    AUTO_RETURN_DWELL_S:        3.0,  // s — quiet time before auto-return begins.
                                      // Long enough to read a label or line up a
                                      // screenshot without the camera fighting you.
    AUTO_RETURN_TIME_CONSTANT_S: 4.0, // s — exponential time constant during
                                      // ease-back.  Gentle: 92 % returned by
                                      // t_dwell+9 s ≈ 12 s.
    AUTO_RETURN_SNAP_TAU_S:     0.8,  // s — fast time constant when the pilot
                                      // explicitly presses the recenter key.
    AUTO_RETURN_DEADZONE_DEG:   2.0,  // deg — once |θ| AND |φ| are inside this
                                      // band, snap to exact 0 so the camera
                                      // doesn't asymptote forever.
    STATIONKEEP_LERP_RATE: 0.8,   // lerp factor for position smoothing
    FUEL_RATE_STATIONKEEP: 0.02,  // kg/s — fuel consumption holding
    FUEL_RATE_MANEUVER: 0.1,      // kg/s — fuel consumption maneuvering
    ENTRY_MAX_VELOCITY: 3.0,      // m/s — max relative vel to enter SK.  Raised from 2.0: realistic arrivals show relV ~1.9 m/s (controller residual after drift cancellation + V_CAP*0.3 ≈ 2.1 m/s nominal approach speed) which is INSIDE the 2.0 m/s gate by only 0.1 m/s — not enough margin for variation.  3.0 m/s gives 1.0 m/s headroom and matches the actual achievable steady-state of the proportional controller.  See debug session 2026-05-09.
    ENTRY_DISTANCE_MULT: 2.0,     // ×standoff — distance gate for SK entry.  Widened from 1.3 hardcoded: the APPROACH controller's brake profile + EMA-smoothed drift compensation produces a settling band of ~1.5–2.0× standoff (e.g. observed dist=17m for standoff=10m, see debug logs).  1.3× gate (13 m) was inside the achievable band so SK never fired.  2.0× = 20 m comfortably captures the band so the daughter actually transitions to STATION_KEEP and the SK lerp pulls her into the standoff sphere.
  },

  // =========================================================================
  // DAUGHTER_AUTOPILOT — Proportional controller for arm TRANSIT + APPROACH
  // Mirrors mother AutopilotSystem.js control law (§D quadratic braking + relV
  // velocity matching). Values scaled for FEEP micro-thrusters on daughter arms.
  //
  // V_CAP = 10 m/s matches CROSSBOW_LAUNCH_SPEED_DEFAULT so the braking profile
  // sqrt(2·A_BRAKE·r) is the dominant control term, not the cap. Old V_CAP=0.5
  // caused the profile to saturate at 2.5m, making the arm brake immediately
  // from 10 m/s launch speed and then crawl. See debug session 2026-05-04.
  // =========================================================================
  DAUGHTER_AUTOPILOT: {
    MAX_ACCEL:      0.5,   // m/s² — game-feel acceleration (was 0.1; 4× less than mother's 2.0)
    KP_VEL:         0.8,   // dimensionless — velocity tracking gain (same as mother)
    BRAKE_FRACTION: 0.5,   // fraction of MAX_ACCEL for along-track braking
    V_CAP:          7.1,   // m/s — fallback cap (T1 spring speed). TRANSIT uses _launchSpeedMps dynamically.
    DRIFT_EMA_ALPHA: 0.1,  // EMA smoothing factor for orbital drift velocity (0=frozen, 1=raw)
  },

  // === TETHER_TENSION — tether force parameters ===
  TETHER_TENSION: {
    TARGET_TENSION: 2.0,           // N — nominal tether tension
    MIN_TENSION: 0.4,              // N — minimum safe tension
    MAX_TENSION_WARNING: 50,       // N — warning threshold
    MAX_TENSION_CRITICAL: 200,     // N — critical / snap threshold
    FEEP_RADIAL_HOLD_OFFSET: 10,  // m — radial hold offset
    FEEP_TENSION_AUTHORITY: 0.001, // N — FEEP authority for tension
  },

  // === ION_THRUSTER_METALS — FEEP propellant characteristics ===
  // Based on real FEEP research: Enpulsion IFM Nano (indium), ESA studies (gallium, bismuth)
  ION_THRUSTER_METALS: {
    indium:   { ispMin: 4000,  ispMax: 19000, thrustPerW: 0.032, mass: 114.8, unlock: 'default',        trl: 9 },
    gallium:  { ispMin: 6000,  ispMax: 25000, thrustPerW: 0.028, mass: 69.7,  unlock: 'forge_gallium',  trl: 7, heater_W: 2 },
    bismuth:  { ispMin: 2500,  ispMax: 8000,  thrustPerW: 0.045, mass: 209.0, unlock: 'forge_bismuth',  trl: 6 },
    iodine:   { ispMin: 2000,  ispMax: 4500,  thrustPerW: 0.060, mass: 126.9, unlock: 'forge_iodine',   trl: 7 },
    mercury:  { ispMin: 3000,  ispMax: 10000, thrustPerW: 0.040, mass: 200.6, unlock: 'forge_mercury',  trl: 5, codex_warning: 'toxic' },
    cesium:   { ispMin: 8000,  ispMax: 22000, thrustPerW: 0.030, mass: 132.9, unlock: 'forge_cesium',   trl: 5, codex_warning: 'reactive' },
    tungsten: { ispMin: 1500,  ispMax: 3500,  thrustPerW: 0.080, mass: 183.8, unlock: 'forge_tungsten', trl: 4, requires: 'mpd_class_power' },
  },

  // === FORGE_METAL_YIELDS — what metals each debris type yields in propellant mode ===
  FORGE_METAL_YIELDS: {
    electronics:    { gallium: 0.4, indium: 0.3, copper: 0.3 },
    heatsink:       { bismuth: 0.5, aluminum: 0.5 },
    medical_sat:    { iodine: 0.6, gold: 0.1, aluminum: 0.3 },
    comms_eqp:      { gallium: 0.3, indium: 0.5, gold: 0.2 },
    rocket_body:    { aluminum: 0.7, titanium: 0.2, steel: 0.1 },
    heat_shield:    { tungsten: 0.6, titanium: 0.4 },
    old_switchgear: { mercury: 0.4, copper: 0.3, aluminum: 0.3 },
    rare_sat:       { cesium: 0.2, gallium: 0.4, gold: 0.4 },
  },

  // ============================================================================
  // EPIC 9 FEATURE HELPERS
  // ============================================================================

  /**
   * Returns true if a feature flag is enabled.
   * Reality Mode globally forces ALL feature flags to false.
   */
  isFeatureEnabled(flagName) {
    if (this.FEATURE_FLAGS.REALITY_MODE) return false;
    return this.FEATURE_FLAGS[flagName] === true;
  },

  /**
   * Reality Mode helper — returns true when the player is restricted to TRL 9 baseline.
   */
  isRealityMode() {
    return this.FEATURE_FLAGS.REALITY_MODE === true;
  },

  // === DEBUG / DIAGNOSTICS (PR 5) ===
  // Verbose runtime logging — off by default. Enable per-session via
  // ?debug=1 in the URL (see main.js bootstrap), which flips the flags
  // below to true before any module reads them.
  DEBUG: {
    // SceneManager._logDiagnostics() + Earth LOD selection log.
    // When false these blocks are cheap no-ops.
    LOG_RENDERER_DIAGNOSTICS: false,
    // PR 6 / P3.15: Per-60-frame draw-call profiling log.
    // Enable via ?profile=1 URL flag (see main.js bootstrap).
    LOG_DRAW_CALLS: false,
    // Sprint 2 / Phase A: 1 Hz performance report overlay.
    // Enable via ?perfReport=1 URL flag (see main.js bootstrap).
    PERF_REPORT_OVERLAY: false,
  },

  // === PERFORMANCE TUNING (PR 3 + PR 4) ===
  PERF: {
    // null | 60 | 120 — cap RAF to a target FPS (null = no cap, follow display refresh).
    // On 120/144 Hz displays a hard 60 fps gate causes every-other-frame skips
    // (judder). Default `null` lets the browser run at native refresh.
    FRAME_CAP: null,

    // --- PR 4 / P1.5: Quality tier system ---
    // Each tier is a config object consumed by SceneManager._setupPostProcessing()
    // and the renderer pixelRatio setter. QualityManager.selectInitialTier()
    // picks one of these at bootstrap; runtimeAdapt() can downshift live.
    //   msaaSamples     — MultisampledRenderTarget samples (0 = none)
    //   enableBloom     — UnrealBloomPass added to composer when true
    //   enableSMAA      — SMAAPass added to composer when true
    //   pixelRatioCap   — renderer.setPixelRatio(min(devicePR, cap))
    //   useFXAAFallback — reserved: lighter AA when SMAA is off. No FXAAPass in
    //                     this codebase yet (PR 4 scope note); SceneManager
    //                     treats this as a TODO marker. The current passes are
    //                     RenderPass + UnrealBloomPass + SMAAPass.
    // Sprint 3 GPU profiling — Phase C.1 (2026-05-23): HIGH `pixelRatioCap` lowered
    // from 2 → 1.5 based on round-2 sweep data. At pr=2 the M4 Max renders at
    // 5760×3600 (20.7 M fragments) and every fragment-bound pass (Earth FS,
    // bloom mip chain, SMAA, MSAA resolve) pays for it. Post-C.1 measurement:
    // baseline 10.52 → 4.82 ms MENU (-5.7 ms), 11.07 → 5.12 IN-MISSION (-5.95 ms).
    // The 54% cost reduction from a 44% fragment reduction is the cache /
    // bandwidth-pressure signature — at pr=2 we were over the M4 Max memory
    // ceiling; at pr=1.5 we drop below it and gain super-linearly.
    //
    // Sprint 3 GPU profiling — Phase C.2 (2026-05-23): HIGH `enableSMAA` flipped
    // false. With 4× MSAA still active on the customRT, geometric edges already
    // get smoothed; SMAA's marginal contribution (shader / transparent-edge AA)
    // costs 1.77 ms IN-MISSION at pr=1.5 — too high for the visual benefit at
    // retina-class density. No FXAA fallback (useFXAAFallback: false) since MSAA
    // is already handling geometric aliasing. If shader aliasing becomes visible
    // on debris specular highlights, the cheap fix is `enableSMAA: true` at HIGH
    // again — the cost re-emerges only at IN-MISSION, MENU is unaffected.
    QUALITY_TIERS: {
      HIGH:   { msaaSamples: 4, enableBloom: true,  enableSMAA: false, pixelRatioCap: 1.5, useFXAAFallback: false },
      MEDIUM: { msaaSamples: 2, enableBloom: true,  enableSMAA: false, pixelRatioCap: 1.5, useFXAAFallback: true  },
      LOW:    { msaaSamples: 0, enableBloom: false, enableSMAA: false, pixelRatioCap: 1,   useFXAAFallback: false },
    },
    // Default initial tier when auto-detection isn't conclusive.
    DEFAULT_QUALITY_TIER: 'HIGH',
    // Sliding-window size for the FPS history feeding runtimeAdapt() (frames).
    FPS_HISTORY_SIZE: 180,
    // Median FPS below this triggers a tier drop.
    ADAPT_FPS_THRESHOLD: 50,
    // Cooldown frames after a tier change before another change is allowed.
    ADAPT_COOLDOWN_FRAMES: 300,
    // Sprint 2 / PR B — auto-upshift gate. Median FPS at or above this triggers
    // a tier promotion (one step up). Wider hysteresis band than downshift (50 → 58)
    // prevents HIGH ↔ MEDIUM ping-pong when the workload sits near the threshold.
    ADAPT_UPSHIFT_FPS_THRESHOLD: 58,
    // Sprint 2 / PR B — upshift cooldown (frames). Longer than the downshift
    // cooldown (300) because upshifting is optimistic — we want to be sure the
    // workload really has eased before re-enabling heavier post-FX.
    ADAPT_UPSHIFT_COOLDOWN_FRAMES: 600,
    // PR 6 / P3.11: GPU runtime probe — EXT_disjoint_timer_query_webgl2.
    // If the median GPU frame time over the probe window exceeds this (ms),
    // request a tier downshift. Only runs once at startup.
    GPU_PROBE_THRESHOLD_MS: 14,
    // Number of frames in the probe sampling window.
    GPU_PROBE_FRAMES: 60,
  },
};

// ============================================================================
// ST-6.6: TRL PURE HELPERS — exported for UI and tests.
// These are intentionally side-effect-free and DOM-free so they can run in
// Node.js test context.
// ============================================================================

/**
 * Validate a TRL value (must be integer in [MIN_VALID..MAX_VALID]).
 * @param {number} trl
 * @param {object} [C=Constants.TRL] — constants namespace (for injection)
 * @returns {boolean}
 */
export function isValidTRL(trl, C) {
  const k = C || Constants.TRL;
  return Number.isInteger(trl) && trl >= k.MIN_VALID && trl <= k.MAX_VALID;
}

/**
 * Map a TRL integer to one of four badge colours.
 * TRL 9   → COLOR_FLIGHT_PROVEN  (green)
 * TRL 7–8 → COLOR_MATURE         (yellow)
 * TRL 4–6 → COLOR_RESEARCH       (amber)
 * TRL 1–3 → COLOR_SPECULATIVE    (red)
 * Invalid TRL → COLOR_SPECULATIVE (fail-loud red).
 * @param {number} trl
 * @param {object} [C=Constants.TRL]
 * @returns {string} hex colour
 */
export function trlToBadgeColor(trl, C) {
  const k = C || Constants.TRL;
  if (!isValidTRL(trl, k)) return k.COLOR_SPECULATIVE;
  if (trl >= k.FLIGHT_PROVEN_MIN) return k.COLOR_FLIGHT_PROVEN;
  if (trl >= k.MATURE_MIN)        return k.COLOR_MATURE;
  if (trl >= k.RESEARCH_MIN)      return k.COLOR_RESEARCH;
  return k.COLOR_SPECULATIVE;
}

/**
 * Map a TRL integer to its label string.
 * @param {number} trl
 * @param {object} [C=Constants.TRL]
 * @returns {string}
 */
export function trlToLabel(trl, C) {
  const k = C || Constants.TRL;
  if (!isValidTRL(trl, k)) return k.LABEL_SPECULATIVE;
  if (trl >= k.FLIGHT_PROVEN_MIN) return k.LABEL_FLIGHT_PROVEN;
  if (trl >= k.MATURE_MIN)        return k.LABEL_MATURE;
  if (trl >= k.RESEARCH_MIN)      return k.LABEL_RESEARCH;
  return k.LABEL_SPECULATIVE;
}

// CJS guard — expose pure helpers for Node.js tests (same pattern as Epic 5).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Constants, trlToBadgeColor, trlToLabel, isValidTRL };
}

export default Constants;
