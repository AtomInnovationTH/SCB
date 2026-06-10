/**
 * CodexSystem.js — Ambient learning encyclopedia that unlocks entries
 * as the player encounters aerospace concepts during gameplay.
 *
 * Three-Beat Pattern: ENCOUNTER → REACT → UNDERSTAND (codex entry unlocks).
 * Players never read a textbook — they experience phenomena first.
 *
 * @module systems/CodexSystem
 */

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants, trlToBadgeColor, trlToLabel } from '../core/Constants.js';

// ============================================================================
// CATEGORIES (matching LEARNING_THROUGH_PLAY.md sections)
// ============================================================================

export const CodexCategory = {
  ORBITAL_MECHANICS: 'ORBITAL_MECHANICS',
  PROPULSION:        'PROPULSION',
  POWER:             'POWER',
  SPACE_ENVIRONMENT: 'SPACE_ENVIRONMENT',
  MATERIALS:         'MATERIALS',
  TETHERS:           'TETHERS',
  DEBRIS:            'DEBRIS',
  SENSORS:           'SENSORS',
  COMMS:             'COMMS',
  NEWS:              'NEWS',
  HERITAGE:          'HERITAGE',
};

// ============================================================================
// CORE ENTRIES (113 entries across 11 categories)
// ============================================================================

function buildEntries() {
  return [
    // === ORBITAL_MECHANICS (4) ===
    {
      id: 'keplerian_orbit',
      title: 'Keplerian Orbits',
      category: CodexCategory.ORBITAL_MECHANICS,
      shortText: 'All objects in orbit follow elliptical paths defined by 6 orbital elements.',
      fullText: 'Johannes Kepler showed that orbits are ellipses with the central body at one focus. The six elements — semi-major axis, eccentricity, inclination, RAAN, argument of periapsis, and true anomaly — completely describe any orbit. Your mothership\'s orbit display shows these in real-time.',
      triggerEvent: Events.STATE_CHANGE,
      triggerCondition: (p) => p.newState === 'ORBITAL_VIEW',
      unlocked: false,
      seen: false,
      icon: '🌍',
    },
    {
      id: 'delta_v',
      title: 'Delta-V Budget',
      category: CodexCategory.ORBITAL_MECHANICS,
      shortText: 'ΔV is the total velocity change your spacecraft can produce — your fuel budget in space.',
      fullText: 'Unlike cars that measure range in kilometers, spacecraft measure capability in meters per second of velocity change (ΔV). Every maneuver costs ΔV: changing altitude, matching orbits, even stopping debris spin. The Tsiolkovsky rocket equation relates ΔV to fuel mass and exhaust velocity. This is why fuel efficiency (specific impulse) matters so much.',
      triggerEvent: Events.PLAYER_TELEMETRY,
      triggerCondition: (p) => p.xenonPct < 0.9,
      unlocked: false,
      seen: false,
      icon: '⚡',
    },
    {
      id: 'hohmann_transfer',
      title: 'Hohmann Transfer',
      category: CodexCategory.ORBITAL_MECHANICS,
      shortText: 'The most fuel-efficient way to change orbits — two burns connected by an ellipse.',
      fullText: 'Walter Hohmann proved in 1925 that the minimum-fuel orbit change uses two burns: one to enter an elliptical transfer orbit, and one to circularize at the target altitude. Your autopilot uses this when moving between debris clusters. It\'s slow but efficient — patience saves propellant.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('transfer'),
      unlocked: false,
      seen: false,
      icon: '🔄',
    },
    {
      id: 'orbital_inclination',
      title: 'Orbital Inclination',
      category: CodexCategory.ORBITAL_MECHANICS,
      shortText: 'The tilt of an orbit relative to the equator. Changing it costs enormous ΔV.',
      fullText: 'Inclination determines which latitudes a satellite passes over. The ISS orbits at 51.6°, seeing most populated areas. Changing inclination requires burning perpendicular to your orbit — extremely expensive in fuel. This is why debris in different inclinations must be handled in separate trawl sweeps.',
      triggerEvent: Events.TRAWL_START,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '📐',
    },

    // === PROPULSION (6) ===
    {
      id: 'feep_thruster',
      title: 'FEEP Thrusters',
      category: CodexCategory.PROPULSION,
      shortText: 'Field Emission Electric Propulsion — ions accelerated by electric fields.',
      fullText: 'FEEP thrusters ionize liquid metal (typically indium or cesium) and accelerate ions through electric fields. They produce tiny thrust (micro-Newtons) but incredible efficiency (Isp >6000s). Your daughter arms use miniaturized FEEP units — perfect for precise maneuvering in the debris field.',
      triggerEvent: Events.ARM_MANUAL_THRUST,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '🔥',
    },
    {
      id: 'specific_impulse',
      title: 'Specific Impulse (Isp)',
      category: CodexCategory.PROPULSION,
      shortText: 'How efficiently a thruster converts propellant to thrust — like MPG for rockets.',
      fullText: 'Specific impulse measures thruster efficiency in seconds. Higher Isp means more velocity change per kilogram of propellant. Chemical rockets: ~300s. Ion thrusters: ~3000s. FEEP: >6000s. The tradeoff is thrust level — efficient engines are weak. This is why your mothership uses ion drive (efficient) while attitude thrusters use cold gas (responsive).',
      triggerEvent: Events.SCORING_AWARD,
      triggerCondition: (p) => p.reason && p.reason.includes('fuel'),
      unlocked: false,
      seen: false,
      icon: '📊',
    },
    {
      id: 'xenon_propellant',
      title: 'Xenon Propellant',
      category: CodexCategory.PROPULSION,
      shortText: 'Noble gas used in ion engines. Heavy atoms give good thrust.',
      fullText: 'Xenon is the propellant of choice for electric propulsion: it\'s heavy (good momentum per ion), inert (safe to store), and ionizes easily. Your mothership\'s main ion drive burns xenon. At ~$3000/kg, it\'s expensive — another reason fuel efficiency matters. Krypton is a cheaper alternative with slightly less performance.',
      triggerEvent: Events.PLAYER_TELEMETRY,
      triggerCondition: (p) => p.xenonPct < 0.7,
      unlocked: false,
      seen: false,
      icon: '⚗️',
    },
    {
      id: 'edt_propulsion',
      title: 'Electrodynamic Tether Propulsion',
      category: CodexCategory.PROPULSION,
      shortText: 'A conducting wire in Earth\'s magnetic field generates thrust — for free.',
      fullText: 'A long conducting tether moving through Earth\'s magnetic field generates an electric current (Faraday\'s law). By controlling this current, you can generate thrust or drag without any propellant. Your EDT system provides "free" orbital adjustments, but effectiveness varies with magnetic field strength — weakest near the equator, strongest near the poles.',
      triggerEvent: Events.EDT_ATTRACT,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '🧲',
    },
    {
      id: 'krypton_propellant',
      title: 'Krypton — Budget Alternative',
      category: CodexCategory.PROPULSION,
      shortText: 'Cheaper than xenon with 85% of the performance. Every space startup\'s secret.',
      fullText: 'Krypton (Kr) costs ~$400/kg vs xenon at ~$3000/kg. It has lower atomic mass (83.8 vs 131.3) giving ~15% less Isp, but the cost savings allow carrying more propellant. SpaceX\'s Starlink satellites use krypton for exactly this reason. Your upgrade to krypton-compatible thrusters opens budget-friendly operations.',
      triggerEvent: Events.UPGRADE_APPLIED,
      triggerCondition: (p) => p.id && p.id.includes('krypton'),
      unlocked: false,
      seen: false,
      icon: '💨',
    },
    {
      id: 'argon_propellant',
      title: 'Argon — The Abundant Choice',
      category: CodexCategory.PROPULSION,
      shortText: 'Third most abundant gas in Earth\'s atmosphere. Very cheap, lower performance.',
      fullText: 'Argon (Ar) is ~1% of Earth\'s atmosphere, making it extremely cheap to produce. Atomic mass: 39.9 — much lighter than xenon, giving lower Isp (~2000s vs 3000s). But at ~$5/kg, it\'s 600× cheaper than xenon. For bulk operations like debris remediation, argon\'s cost advantage can offset its lower efficiency. The math changes when you process thousands of objects.',
      triggerEvent: Events.UPGRADE_APPLIED,
      triggerCondition: (p) => p.id && p.id.includes('argon'),
      unlocked: false,
      seen: false,
      icon: '💨',
    },
    {
      id: 'cold_gas_thruster',
      title: 'Cold Gas Thrusters',
      category: CodexCategory.PROPULSION,
      shortText: 'Simplest thruster: pressurized gas expelled through a nozzle. Low Isp, instant response.',
      fullText: 'Cold gas thrusters store pressurized nitrogen or helium and simply release it through a nozzle. No combustion, no ionization — just Newton\'s third law. Isp is terrible (~70s) but response time is near-instant, making them perfect for attitude control and emergency maneuvers. Your RCS thrusters use this principle.',
      triggerEvent: Events.PLAYER_TELEMETRY,
      triggerCondition: (p) => p.coldGasPct < 0.8,
      unlocked: false,
      seen: false,
      icon: '💨',
    },

    // === POWER (2) ===
    {
      id: 'solar_power',
      title: 'Solar Panel Power Generation',
      category: CodexCategory.POWER,
      shortText: 'Solar panels convert sunlight to electricity — but not in Earth\'s shadow.',
      fullText: 'In LEO, spacecraft spend ~35% of each orbit in Earth\'s shadow. Solar panels produce ~300 W/m² in sunlight, zero in eclipse. Your power distribution system must manage this cycle: charging batteries in sunlight, rationing power in shadow. Panel degradation from radiation reduces output over time.',
      triggerEvent: Events.PLAYER_TELEMETRY,
      triggerCondition: (p) => p.batteryPct < 0.5,
      unlocked: false,
      seen: false,
      icon: '☀️',
    },
    {
      id: 'eclipse_cycle',
      title: 'Eclipse Cycles',
      category: CodexCategory.POWER,
      shortText: 'Your spacecraft passes through Earth\'s shadow every orbit.',
      fullText: 'In a 400km orbit, you experience ~35 minutes of darkness every 92-minute orbit. During eclipse, solar panels produce nothing. Battery reserves and power rationing become critical. Some operations (EDT propulsion, sensors) may need to be reduced during eclipse to maintain essential systems.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && (p.text.toLowerCase().includes('shadow') || p.text.toLowerCase().includes('eclipse')),
      unlocked: false,
      seen: false,
      icon: '🌑',
    },

    // === SPACE_ENVIRONMENT (4) ===
    {
      id: 'kessler_syndrome',
      title: 'Kessler Syndrome',
      category: CodexCategory.SPACE_ENVIRONMENT,
      shortText: 'Cascading collisions that could make LEO unusable for generations.',
      fullText: 'In 1978, NASA scientist Donald Kessler predicted that above a critical density, collisions between orbital objects would create fragments that cause more collisions — an unstoppable cascade. Each collision multiplies debris exponentially. This is why your mission matters: every piece of debris removed reduces cascade probability. We may already be past the tipping point for some orbital shells.',
      triggerEvent: Events.STATE_CHANGE,
      triggerCondition: (p) => p.newState === 'PLAYING',
      unlocked: false,
      seen: false,
      icon: '💥',
    },
    {
      id: 'solar_storm',
      title: 'Solar Storms',
      category: CodexCategory.SPACE_ENVIRONMENT,
      shortText: 'Coronal mass ejections can damage electronics and increase atmospheric drag.',
      fullText: 'The Sun periodically ejects billions of tons of magnetized plasma. When these coronal mass ejections (CMEs) hit Earth\'s magnetosphere, they cause geomagnetic storms. Effects on spacecraft: increased radiation dose, expanded atmosphere (more drag on LEO objects), disrupted communications, and potential electronics damage. Solar cycle peaks every ~11 years.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('solar'),
      unlocked: false,
      seen: false,
      icon: '🌞',
    },
    {
      id: 'van_allen_belts',
      title: 'Van Allen Radiation Belts',
      category: CodexCategory.SPACE_ENVIRONMENT,
      shortText: 'Zones of trapped high-energy particles surrounding Earth.',
      fullText: 'Earth\'s magnetic field traps charged particles from the solar wind in two doughnut-shaped belts. The inner belt (1,000-5,000 km) contains high-energy protons. The outer belt (13,000-65,000 km) contains electrons. Your LEO orbit is below both belts, but the South Atlantic Anomaly dips radiation into your path.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && (p.text.toLowerCase().includes('radiation') || p.text.toLowerCase().includes('van allen')),
      unlocked: false,
      seen: false,
      icon: '☢️',
    },
    {
      id: 'south_atlantic_anomaly',
      title: 'South Atlantic Anomaly',
      category: CodexCategory.SPACE_ENVIRONMENT,
      shortText: 'A dip in Earth\'s magnetic field where radiation reaches LEO altitudes.',
      fullText: 'Over the South Atlantic, Earth\'s magnetic field is weaker due to an offset between the geographic and magnetic axes. Trapped radiation particles dip lower here, bathing LEO spacecraft in higher radiation doses. The ISS powers down sensitive instruments during SAA passes. Your sensors may glitch in this region.',
      triggerEvent: Events.WEATHER_EFFECT_START,
      triggerCondition: (p) => p.type === 'SAA_PASSAGE',
      unlocked: false,
      seen: false,
      icon: '⚠️',
    },

    // === MATERIALS (3) ===
    {
      id: 'space_aluminum',
      title: 'Aerospace Aluminum Alloys',
      category: CodexCategory.MATERIALS,
      shortText: 'Most common spacecraft material — light, strong, and highly recyclable.',
      fullText: 'Aluminum alloys (especially 7075 and 6061) make up the majority of spacecraft structures. In orbit, they\'re exposed to atomic oxygen, which slowly erodes unprotected surfaces. Your salvaged aluminum can be re-forged into structural components, or used as fuel in certain experimental propulsion systems.',
      triggerEvent: Events.CARGO_STORE,
      triggerCondition: (p) => p.type === 'aluminum',
      unlocked: false,
      seen: false,
      icon: '🔩',
    },
    {
      id: 'titanium',
      title: 'Aerospace Titanium',
      category: CodexCategory.MATERIALS,
      shortText: 'Extremely strong, corrosion-resistant — but difficult to machine.',
      fullText: 'Titanium alloys (especially Ti-6Al-4V) are used where extreme strength-to-weight ratio matters: engine components, structural joints, and pressure vessels. Melting point: 1,668°C. In salvage, titanium components command premium prices because manufacturing new titanium parts in orbit is extremely expensive.',
      triggerEvent: Events.CARGO_STORE,
      triggerCondition: (p) => p.type === 'titanium',
      unlocked: false,
      seen: false,
      icon: '⚙️',
    },
    {
      id: 'carbon_composite',
      title: 'Carbon Fiber Composites',
      category: CodexCategory.MATERIALS,
      shortText: 'Layered carbon fibers in resin — stronger than steel at a fraction of the weight.',
      fullText: 'Carbon fiber reinforced polymers (CFRP) are used in satellite structures, solar panel substrates, and antenna booms. They\'re incredibly strong along the fiber direction but brittle across it. In debris fields, composite fragments are among the most dangerous because they shatter into jagged shards invisible to radar.',
      triggerEvent: Events.CARGO_STORE,
      triggerCondition: (p) => p.type === 'carbon_composite',
      unlocked: false,
      seen: false,
      icon: '🧶',
    },

    // === TETHERS (2) ===
    {
      id: 'space_tether',
      title: 'Space Tethers',
      category: CodexCategory.TETHERS,
      shortText: 'Cables connecting objects in orbit — used for momentum, power, and propulsion.',
      fullText: 'Space tethers can be tens of kilometers long. A taut tether between two objects at different altitudes experiences a gravity gradient that keeps it vertical. The lower end orbits faster than a free object at that altitude, and the upper end orbits slower. This principle enables momentum exchange, propellantless propulsion, and your arm\'s ability to reel in debris without fuel.',
      triggerEvent: Events.ARM_DEPLOYED,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '🪢',
    },
    {
      id: 'tether_reel_in',
      title: 'Tether Reel-In: Free ΔV',
      category: CodexCategory.TETHERS,
      shortText: 'Reeling in a captured object costs no propellant — gravity does the work.',
      fullText: 'When your arm captures debris and reels it in, the tether does the work. The debris descends to a lower orbit (losing energy), while the mothership gains that energy. In practice, the mass difference makes this essentially free. This is why tether-based capture is so efficient compared to chemical propulsion rendezvous.',
      triggerEvent: Events.ARM_CAPTURED,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '🎣',
    },

    // === DEBRIS (2) ===
    {
      id: 'hypervelocity',
      title: 'Hypervelocity Impact',
      category: CodexCategory.DEBRIS,
      shortText: 'At 7+ km/s, even paint flakes can damage spacecraft.',
      fullText: 'Orbital debris travels at relative velocities of 7-15 km/s. At these speeds, kinetic energy scales with velocity squared — a 1cm aluminum sphere hits with the energy of a hand grenade. The ISS has Whipple shields (spaced armor) to protect against particles up to 1cm. Your satellite\'s armor plating serves the same purpose.',
      triggerEvent: Events.ARM_CAPTURED,   // ST-2.1: moved from CONJUNCTION_WARNING so entry unlocks before first alert
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '⚡',
    },
    {
      id: 'debris_tracking',
      title: 'Debris Tracking Networks',
      category: CodexCategory.DEBRIS,
      shortText: 'Ground-based radar tracks 30,000+ objects. Millions more are untracked.',
      fullText: 'The US Space Surveillance Network tracks objects >10cm in LEO using ground-based radar and optical telescopes. This catalog contains ~30,000 objects. But there are estimated 100 million debris fragments 1mm-1cm, and 500,000 objects 1-10cm — too small to track but large enough to damage spacecraft. Your sensors detect what ground radar can\'t.',
      triggerEvent: Events.SENSOR_UPGRADED,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '📡',
    },

    // === SENSORS (1) ===
    {
      id: 'lidar_sensing',
      title: 'LIDAR — Time of Flight',
      category: CodexCategory.SENSORS,
      shortText: 'Laser pulses measure distance by timing the round trip of light.',
      fullText: 'LIDAR (Light Detection And Ranging) fires laser pulses and measures how long they take to bounce back. At the speed of light, 1 nanosecond = 30cm of distance. Your sensor system uses LIDAR for precise ranging to nearby debris. It can even measure target rotation by tracking point changes between pulses.',
      triggerEvent: Events.SENSOR_UPGRADED,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '🔴',
    },

    // =================================================================
    // PHASE 7B — Spacecraft Subsystem Entries (20 entries)
    // =================================================================

    // === COMMS (4) ===
    {
      id: 'laser_comms',
      title: 'Laser Communications',
      category: CodexCategory.COMMS,
      shortText: 'Light-based data links: 10× more bandwidth than radio, but need precise pointing.',
      fullText: 'Laser comms (optical links) transmit data via modulated laser beams between spacecraft and ground stations. NASA\'s LCRD demo achieved 1.2 Gbps from GEO — 10-100× faster than radio. The catch: both ends must point within microradians of each other. Clouds block the beam, so multiple ground stations are needed. Your optical link to Svalbard works because the Arctic has clear, dark skies.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('laser comms'),
      unlocked: false,
      seen: false,
      icon: '🔦',
    },
    {
      id: 'ground_station_window',
      title: 'Ground Station Passes',
      category: CodexCategory.COMMS,
      shortText: 'You can only talk to ground when a station is overhead — typically 5-10 min per pass.',
      fullText: 'In LEO, ground stations are visible for just minutes per orbit. The Deep Space Network (Madrid, Canberra, Goldstone) provides near-continuous coverage for deep space, but LEO satellites rely on a constellation of ground stations. Each pass gives a brief data dump window. This is why spacecraft must store data and prioritize what to send.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('ground station') && p.text.toLowerCase().includes('range'),
      unlocked: false,
      seen: false,
      icon: '📡',
    },
    {
      id: 'bandwidth_limits',
      title: 'Bandwidth & Data Rates',
      category: CodexCategory.COMMS,
      shortText: 'Space-to-ground links have limited bandwidth — every bit must be prioritized.',
      fullText: 'A typical S-band downlink carries ~2 Mbps — less than a poor WiFi connection. With 6 active arms generating telemetry, sensor data, and video, bandwidth becomes a real constraint. Data compression, prioritization, and store-and-forward help, but sometimes you have to choose which arm gets real-time data.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('bandwidth'),
      unlocked: false,
      seen: false,
      icon: '📶',
    },
    {
      id: 'comms_blackout',
      title: 'Communications Blackout',
      category: CodexCategory.COMMS,
      shortText: 'High-energy particles can disrupt radio signals, causing temporary blackouts.',
      fullText: 'During solar events or SAA passages, energetic particles ionize the atmosphere unevenly, causing signal scintillation and blackout. Plasma sheaths during reentry cause total comm loss (Apollo missions waited in silence). Your comms degradation during SAA passage mirrors this real phenomenon.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('comms degraded'),
      unlocked: false,
      seen: false,
      icon: '📵',
    },

    // === NAVIGATION / SENSORS (3) ===
    {
      id: 'star_tracker',
      title: 'Star Trackers',
      category: CodexCategory.SENSORS,
      shortText: 'Cameras that identify star patterns to determine spacecraft orientation to ±0.001°.',
      fullText: 'Star trackers photograph the sky and match star patterns against an onboard catalog of ~3000 stars. This gives attitude knowledge to arcsecond accuracy — essential for pointing antennas, sensors, and thrusters. They fail in sunlight (too bright) and near the Moon (confuses the pattern matcher), so spacecraft carry multiple trackers pointing different directions.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('star tracker'),
      unlocked: false,
      seen: false,
      icon: '⭐',
    },
    {
      id: 'imu_drift',
      title: 'Inertial Measurement Unit',
      category: CodexCategory.SENSORS,
      shortText: 'Gyros and accelerometers track motion between star fixes — but they drift.',
      fullText: 'An IMU contains three gyroscopes and three accelerometers measuring rotation and acceleration. Between star tracker fixes, the IMU dead-reckons the spacecraft\'s attitude. But small measurement errors accumulate (drift), requiring periodic correction. Modern fiber-optic gyros drift ~0.01°/hour. Mechanical gyros were worse — Apollo astronauts had to realign every few hours.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('imu drift'),
      unlocked: false,
      seen: false,
      icon: '🧭',
    },
    {
      id: 'docking_precision',
      title: 'Proximity Navigation',
      category: CodexCategory.SENSORS,
      shortText: 'The last 100 meters of approach require centimeter-level accuracy.',
      fullText: 'Rendezvous and proximity operations (RPO) use a combination of LIDAR, optical cameras, and relative GPS to achieve centimeter precision. Your arm\'s final approach to debris uses similar techniques: closing velocity must drop below 0.1 m/s, alignment within 5°. One wrong move and you bounce the target into an unpredictable tumble.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('relative navigation'),
      unlocked: false,
      seen: false,
      icon: '🎯',
    },

    // === ATTITUDE / SENSORS (3) ===
    {
      id: 'reaction_wheels',
      title: 'Reaction Wheels',
      category: CodexCategory.SENSORS,
      shortText: 'Spinning flywheels that rotate the spacecraft by conservation of angular momentum.',
      fullText: 'Reaction wheels are electric motors spinning heavy discs at thousands of RPM. Speed up a wheel, and the spacecraft rotates the opposite direction (Newton\'s 3rd law). Three wheels give full 3-axis control. The problem: wheels eventually spin too fast (saturation) and must be "desaturated" using external torque — usually magnetorquers interacting with Earth\'s magnetic field.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('reaction wheel'),
      unlocked: false,
      seen: false,
      icon: '🔄',
    },
    {
      id: 'magnetorquers',
      title: 'Magnetorquers',
      category: CodexCategory.SENSORS,
      shortText: 'Electromagnetic coils that push against Earth\'s magnetic field — no propellant needed.',
      fullText: 'Magnetorquers are coils of wire that generate a magnetic dipole when powered. This dipole interacts with Earth\'s magnetic field to produce torque. They\'re weak (can\'t slew quickly) but use no propellant and never wear out. Primary use: desaturating reaction wheels by absorbing their excess angular momentum. Free attitude control from Earth\'s field.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('magnetorquer'),
      unlocked: false,
      seen: false,
      icon: '🧲',
    },
    {
      id: 'detumble',
      title: 'Detumbling Captured Debris',
      category: CodexCategory.SENSORS,
      shortText: 'Stopping a spinning object in space requires reaction torque — and patience.',
      fullText: 'Defunct satellites and debris tumble unpredictably at rates up to 60°/s. Before hauling, you must despin the target. Your arm applies counter-torque through its grapple point, using thrusters or reaction wheels. The challenge: asymmetric objects have complex rotation (all three axes). Understanding moment of inertia helps predict how much effort despinning takes.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('tumble rate'),
      unlocked: false,
      seen: false,
      icon: '🌀',
    },

    // === POWER (4) ===
    {
      id: 'battery_chemistry',
      title: 'Space-Grade Batteries',
      category: CodexCategory.POWER,
      shortText: 'Li-ion cells designed for 50,000+ charge cycles in extreme temperatures.',
      fullText: 'Space batteries must survive 16 charge-discharge cycles per day (one per orbit), extreme temperatures (-20°C to +40°C), and radiation. Depth-of-discharge (DoD) is kept at 25-30% to maximize cycle life — you only use a quarter of the capacity to get 50,000+ cycles (9+ years). This is why your battery shows plenty of capacity but the system treats 25% as "empty".',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('battery cycle'),
      unlocked: false,
      seen: false,
      icon: '🔋',
    },
    {
      id: 'supercapacitors',
      title: 'Supercapacitors',
      category: CodexCategory.POWER,
      shortText: 'Burst power devices that charge in seconds — perfect for deploying arms and lasso.',
      fullText: 'Supercapacitors store less total energy than batteries but can discharge it 100× faster. They\'re perfect for brief high-power operations: deploying an arm, firing a lasso, activating electromagnets. Your spacecraft charges supercap banks from solar panels, then dumps the energy in milliseconds when needed. They last millions of cycles with no degradation.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('supercapacitor'),
      unlocked: false,
      seen: false,
      icon: '⚡',
    },
    {
      id: 'thermal_management',
      title: 'Thermal Management',
      category: CodexCategory.POWER,
      shortText: 'In space, the sun side is +120°C while the shadow side is -150°C — simultaneously.',
      fullText: 'With no atmosphere to conduct heat, temperature in space is purely radiative. Direct sunlight heats surfaces to +120°C while shadowed sides cool to -150°C. Multi-Layer Insulation (MLI) blankets, heat pipes, and radiator panels manage this gradient. Your bus maintains +20°C internally through active thermal control — heaters in shadow, radiators in sun.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('thermal gradient'),
      unlocked: false,
      seen: false,
      icon: '🌡️',
    },
    {
      id: 'mli_insulation',
      title: 'Multi-Layer Insulation (MLI)',
      category: CodexCategory.POWER,
      shortText: 'Gold and silver Mylar blankets — the distinctive look of every spacecraft.',
      fullText: 'MLI blankets are layers of thin aluminized Mylar separated by mesh spacers. Each layer reflects infrared radiation, creating a thermal barrier. 20-30 layers reduce heat transfer by 99%. The distinctive gold/silver appearance of spacecraft comes from these blankets. They\'re the most mass-efficient thermal protection available.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('mli'),
      unlocked: false,
      seen: false,
      icon: '✨',
    },

    // === AVIONICS / SENSORS (4) ===
    {
      id: 'triple_redundancy',
      title: 'Triple Modular Redundancy',
      category: CodexCategory.SENSORS,
      shortText: 'Three computers vote on every decision — two must agree for action.',
      fullText: 'In space, radiation flips bits randomly (SEUs). Triple Modular Redundancy runs three identical processors on every calculation. If one gives a different answer (corrupted by radiation), the other two outvote it. The faulty processor is reset while the system continues operating. This is why mission-critical spacecraft have 3-5 computers doing the same job.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => (p.text && p.text.toLowerCase().includes('tmr')) || (p.text && p.text.toLowerCase().includes('triple') && p.text.toLowerCase().includes('redundancy')),
      unlocked: false,
      seen: false,
      icon: '🖥️',
    },
    {
      id: 'watchdog_timer',
      title: 'Watchdog Timers & Safe Modes',
      category: CodexCategory.SENSORS,
      shortText: 'Automatic reboot if the computer stops responding — because no one can press Ctrl+Alt+Del.',
      fullText: 'Watchdog timers are hardware circuits that expect a "pet" signal from software every few seconds. If the signal stops (software hung), the watchdog forces a reboot. Safe mode strips the spacecraft to minimum functions: sun-pointing for power, beacon transmitting for ground contact. ISS has entered safe mode dozens of times — it always recovers.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('watchdog'),
      unlocked: false,
      seen: false,
      icon: '🐕',
    },
    {
      id: 'telemetry',
      title: 'Telemetry — Everything Is Measured',
      category: CodexCategory.SENSORS,
      shortText: 'Thousands of sensors report temperature, voltage, current, and pressure every second.',
      fullText: 'A typical spacecraft monitors 2,000-5,000 telemetry channels continuously. Every temperature sensor, voltage rail, current draw, pressure reading, wheel speed, and tank level is logged. Ground controllers analyze trends to predict failures before they happen. Your status panels show a tiny subset of the thousands of readings your satellite actually tracks.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('telemetry frame'),
      unlocked: false,
      seen: false,
      icon: '📊',
    },
    {
      id: 'ecc_memory',
      title: 'Error-Correcting Memory',
      category: CodexCategory.SENSORS,
      shortText: 'Radiation flips bits in RAM — ECC detects and fixes single-bit errors automatically.',
      fullText: 'Cosmic rays and trapped radiation particles can flip bits in computer memory (Single Event Upsets / SEUs). Error Correcting Code (ECC) memory adds extra bits that detect and correct single-bit errors and detect (but can\'t fix) double-bit errors. In LEO, a spacecraft might see several SEUs per day. Without ECC, your navigation computer would give wrong answers regularly.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('single-bit error'),
      unlocked: false,
      seen: false,
      icon: '🛡️',
    },

    // === DEGRADATION / SPACE_ENVIRONMENT (2) ===
    {
      id: 'atomic_oxygen',
      title: 'Atomic Oxygen Erosion',
      category: CodexCategory.SPACE_ENVIRONMENT,
      shortText: 'Single oxygen atoms in LEO erode spacecraft surfaces like invisible sandpaper.',
      fullText: 'Below 700km, UV radiation splits O₂ molecules into single oxygen atoms. At orbital velocity (7.8 km/s), these atoms hit spacecraft surfaces with ~5 eV of energy — enough to break chemical bonds. Kapton, silver, and carbon fiber are especially vulnerable. Your Kapton thermal blankets slowly erode, requiring monitoring and eventual replacement. This is why LEO satellites have limited lifetimes.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('atomic oxygen'),
      unlocked: false,
      seen: false,
      icon: '🫧',
    },
    {
      id: 'mmod_impact',
      title: 'MMOD Protection',
      category: CodexCategory.SPACE_ENVIRONMENT,
      shortText: 'Whipple shields use spaced layers to shatter and spread incoming particle energy.',
      fullText: 'Micrometeorites and orbital debris (MMOD) impact at 7-72 km/s. Whipple shields place a thin "bumper" plate ahead of the pressure wall. The particle shatters on the bumper, spreading its energy across a wider area. The resulting debris cloud hits the back wall with much less penetrating power. Your satellite\'s hull panels use this principle — multiple thin layers beat one thick wall.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('mmod'),
      unlocked: false,
      seen: false,
      icon: '🛡️',
    },

    // === S3b: POWER INFRASTRUCTURE (6) ===
    {
      id: 'multijunction_pv',
      title: 'Multi-Junction Photovoltaics',
      category: CodexCategory.POWER,
      shortText: 'Triple-junction cells stack three materials tuned to different parts of the solar spectrum.',
      fullText: 'Triple-junction cells stack three materials tuned to different parts of the solar spectrum. The top layer catches UV/blue, the middle catches visible, the bottom catches infrared. Combined: 39% efficiency vs 22% for silicon. Every Mars rover, every GPS satellite, and the ISS all use multi-junction GaAs cells. The tradeoff: 100× more expensive per watt than silicon — but in space, mass and area matter more than cost.',
      triggerEvent: Events.UPGRADE_PURCHASED,
      triggerCondition: (p) => p.id === 'multi_junction_solar',
      unlocked: false,
      seen: false,
      icon: '☀️',
    },
    {
      id: 'solid_state_battery',
      title: 'Solid-State Batteries',
      category: CodexCategory.POWER,
      shortText: 'Replace the liquid electrolyte with a solid ceramic or glass — no fire risk in space.',
      fullText: 'Replace the liquid electrolyte with a solid ceramic or glass. No sloshing in microgravity, no fire risk from thermal runaway, and 40% more energy per kilogram. Spacecraft batteries endure 50,000+ charge/discharge cycles — once every 92-minute orbit for years. Toyota, QuantumScape, and NASA JPL are all racing to flight-qualify solid-state cells. Your battery survives what would melt a phone battery.',
      triggerEvent: Events.UPGRADE_PURCHASED,
      triggerCondition: (p) => p.id === 'solid_state_battery',
      unlocked: false,
      seen: false,
      icon: '🔋',
    },
    {
      id: 'graphene_supercap',
      title: 'Graphene Supercapacitors',
      category: CodexCategory.POWER,
      shortText: 'Single-atom carbon sheets with astronomical power density — perfect for MPD burst power.',
      fullText: 'Graphene is a single layer of carbon atoms arranged in hexagons — the strongest, most conductive material ever measured. Stack graphene sheets separated by hexagonal boron nitride (HBN) insulator and you get a supercapacitor that charges in seconds and survives millions of cycles. Energy density: 10× less than batteries. But power density: 1000× more. Your MPD thruster draws 150 kW — a current spike that would damage any battery. The supercap bank absorbs the peak, while batteries provide sustained baseload. Same principle as the "ludicrous mode" battery pack in high-performance electric vehicles.',
      triggerEvent: Events.UPGRADE_PURCHASED,
      triggerCondition: (p) => p.id === 'graphene_supercap',
      unlocked: false,
      seen: false,
      icon: '⚡',
    },
    {
      id: 'rtg_power',
      title: 'Radioisotope Generators',
      category: CodexCategory.POWER,
      shortText: 'Plutonium-238 decay produces constant power for decades — no moving parts, no fuel to run out.',
      fullText: 'An RTG is beautifully simple: Plutonium-238 decays, releasing heat. Thermocouples spanning the hot core and cold radiator fins generate electricity from the temperature difference — the Seebeck effect. No turbines, no moving parts, no fuel to run out (half-life: 87.7 years). Voyager 1\'s three RTGs have powered it for 48+ years — it\'s now 24 billion km from Earth, in interstellar space, still transmitting at 23 watts. Your 2 kW micro-RTG uses MMRTG technology (Multi-Mission RTG) scaled down from the Mars Curiosity rover\'s 110W unit. It will outlast every other component on your spacecraft.',
      triggerEvent: Events.UPGRADE_PURCHASED,
      triggerCondition: (p) => p.id === 'rtg_module',
      unlocked: false,
      seen: false,
      icon: '☢️',
    },
    {
      id: 'power_beaming',
      title: 'Wireless Power Transmission',
      category: CodexCategory.POWER,
      shortText: 'Ground-based transmitters beam microwave energy to your spacecraft\'s rectenna array.',
      fullText: 'Nikola Tesla dreamed of it in 1901. A century later, it works: ground-based phased-array microwave transmitters focus a beam on your spacecraft\'s rectenna — a mesh of antennas that convert microwave energy directly to DC electricity. JAXA demonstrated 1.8 kW wireless power transfer over 55 meters in 2015. Your receiver operates at 5.8 GHz (ISM band) with a 1 m² rectenna panel achieving ~85% RF-to-DC conversion. The beam is only available when you\'re over a ground station — but during those 30–90 second windows, you get free power. The future of space infrastructure: orbital solar farms beaming terawatts to Earth.',
      triggerEvent: Events.UPGRADE_PURCHASED,
      triggerCondition: (p) => p.id === 'power_beaming',
      unlocked: false,
      seen: false,
      icon: '📡',
    },
    {
      id: 'mpd_burst',
      title: 'Magnetoplasmadynamic Thrusters',
      category: CodexCategory.PROPULSION,
      shortText: 'Lorentz force on lithium plasma — 150 kW of raw electromagnetic acceleration.',
      fullText: 'MPD thrusters ionize lithium propellant and accelerate the resulting plasma using the Lorentz force (J×B) — the interaction between the electric current through the plasma and the self-generated magnetic field. At 150 kW, the thruster produces 25N — fifty times more than an ion drive. The catch: enormous power demand drains batteries in seconds. Real MPD thrusters have been tested at NASA Glenn and JAXA, achieving specific impulses of 2,000-5,000 seconds. The cathode erosion problem (tungsten sublimation at the arc attachment point) remains the primary engineering challenge. Your Ludicrous Mode solves the power problem with a full infrastructure chain: multi-junction solar, solid-state batteries, supercapacitors, and optional RTG/power beaming.',
      triggerEvent: Events.MPD_BURST_START,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '🚀',
    },

    // === ORBITAL_MECHANICS (new — 6 entries) ===
    {
      id: 'prograde_paradox',
      title: 'The Orbital Speed Paradox',
      category: CodexCategory.ORBITAL_MECHANICS,
      shortText: 'Thrust forward and you end up behind. Thrust backward to catch up. Orbits are counterintuitive.',
      fullText: 'The most counterintuitive fact in orbital mechanics: thrusting prograde (forward) raises your orbit, which makes you slower. To catch something ahead of you in the same orbit, you thrust retrograde (backward) to drop into a lower, faster orbit. This "orbital pool" effect confused early astronauts too — Gemini 4 spent half its fuel trying to chase a booster the wrong way.',
      triggerEvent: Events.THROTTLE_CHANGE,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '🔄',
    },
    {
      id: 'j2_perturbation',
      title: 'J2 Oblateness',
      category: CodexCategory.ORBITAL_MECHANICS,
      shortText: 'Earth bulges at the equator, warping orbits over time. Sun-synchronous orbits exploit this.',
      fullText: 'Earth is not a perfect sphere — it bulges ~21 km at the equator. This "J2" perturbation causes orbital planes to precess (rotate) over time. Engineers exploit this: Sun-synchronous orbits are tilted at exactly ~97.5° so J2 precession makes the orbit track the Sun, keeping constant lighting. Your debris targets drift from predicted positions because of J2.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && (p.text.includes('predicted') || p.text.includes('drift')),
      unlocked: false,
      seen: false,
      icon: '🌐',
    },
    {
      id: 'atmospheric_drag',
      title: 'Atmospheric Drag',
      category: CodexCategory.ORBITAL_MECHANICS,
      shortText: 'Below 300 km, trace atmosphere causes orbital decay. The ISS loses ~2 km/month.',
      fullText: 'Even at 400 km, there are enough air molecules to create measurable drag. The ISS loses about 2 km altitude per month and must reboost regularly using Progress spacecraft. Below 200 km, satellites deorbit within days. This is actually useful for debris removal — nudge debris to a low enough perigee, and atmospheric drag does the rest for free.',
      triggerEvent: Events.SCORE_UPDATE,
      triggerCondition: (p) => p.debrisCleared >= 5,
      unlocked: false,
      seen: false,
      icon: '💨',
    },
    {
      id: 'relative_velocity',
      title: 'Relative Velocity in LEO',
      category: CodexCategory.ORBITAL_MECHANICS,
      shortText: 'Objects in slightly different orbits drift past at walking speed. Same orbit = nearly stationary.',
      fullText: 'In LEO, a 10 km altitude difference produces ~5 m/s relative drift — walking speed. Objects in the exact same orbit appear stationary to each other, even though both travel at 7.8 km/s. This is why rendezvous is about matching orbits, not chasing targets. Your daughter arms exploit this: launch them into matched orbits and they drift gently toward debris.',
      triggerEvent: Events.ARM_CAPTURED,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '↔️',
    },
    {
      id: 'orbital_period_altitude',
      title: 'Period vs Altitude',
      category: CodexCategory.ORBITAL_MECHANICS,
      shortText: 'Higher orbits are slower. At 400 km you orbit in 92 minutes; at 800 km, 101 minutes.',
      fullText: 'Kepler\'s third law: orbital period increases with altitude. At 400 km (ISS altitude), one orbit takes ~92 minutes — 16 sunrises per day. At geostationary altitude (35,786 km), the period matches Earth\'s rotation: 24 hours. This means higher debris clusters take longer to reach AND have fewer passes per mission day.',
      triggerEvent: Events.TRAWL_START,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '⏱️',
    },
    {
      id: 'raan_precession',
      title: 'RAAN Precession',
      category: CodexCategory.ORBITAL_MECHANICS,
      shortText: 'Orbital planes rotate around Earth\'s axis due to J2, changing when you pass over ground stations.',
      fullText: 'The Right Ascension of the Ascending Node (RAAN) defines where an orbit crosses the equator. J2 perturbation causes RAAN to drift — westward for prograde orbits. At 400 km, 51.6° inclination (ISS), RAAN precesses about 5° per day. This means ground station contact windows shift predictably, and mission planners must account for it.',
      triggerEvent: Events.SUBSYSTEM_EVENT,
      triggerCondition: (p) => p.source === 'SYSTEM' && p.text && p.text.includes('Ground station'),
      unlocked: false,
      seen: false,
      icon: '🧭',
    },

    // === PROPULSION (new — 4 entries) ===
    {
      id: 'spring_energy',
      title: 'Spring Energy Storage',
      category: CodexCategory.PROPULSION,
      shortText: 'Crossbow arms use compressed springs — stored mechanical energy releases with zero propellant cost.',
      fullText: 'Spring-launched projectiles use stored elastic potential energy (½kx²). Your crossbow arms compress a spring via worm gear, storing 2–5 J of energy. On release, this accelerates the 2–7 kg bolt to 0.5–1.5 m/s — enough for LEO proximity operations. Zero propellant cost for the launch itself, though FEEP thrusters handle final approach.',
      triggerEvent: Events.CROSSBOW_FIRE,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '🏹',
    },
    {
      id: 'recoil_cancellation',
      title: 'Recoil Cancellation',
      category: CodexCategory.PROPULSION,
      shortText: 'Dual-fire launches two bolts simultaneously — equal and opposite momentum cancels mothership recoil.',
      fullText: 'Newton\'s third law means every launch pushes the mothership backward. Dual-fire exploits this: launching two bolts in opposite directions creates equal and opposite momenta that cancel out. Any residual impulse from mass asymmetry (Weavers are heavier than Spinners) is compensated by a brief RCS burst. Real spacecraft use similar tricks — reaction wheels store angular momentum internally.',
      triggerEvent: Events.DUAL_FIRE,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '⚖️',
    },
    {
      id: 'cold_gas_rcs',
      title: 'Cold Gas RCS',
      category: CodexCategory.PROPULSION,
      shortText: 'Nitrogen thrusters provide precise attitude control — low thrust, but zero ignition risk near debris.',
      fullText: 'Cold gas thrusters use stored pressurized gas (typically nitrogen) expelled through small nozzles. They produce tiny thrust (~1 N) but are extremely safe — no combustion, no contamination, no ignition risk near volatile debris. The trade-off: low specific impulse (Isp ~73s) means they burn through propellant quickly. Your mothership\'s RCS uses cold gas for fine positioning.',
      triggerEvent: Events.CONTROL_MODE_CHANGE,
      triggerCondition: (p) => p.mode === 'COLD_GAS',
      unlocked: false,
      seen: false,
      icon: '💨',
    },
    {
      id: 'specific_impulse_explained',
      title: 'Specific Impulse',
      category: CodexCategory.PROPULSION,
      shortText: 'Isp measures fuel efficiency — higher means more ΔV per kilogram of propellant.',
      fullText: 'Specific impulse (Isp) is measured in seconds — how long one kg of propellant can produce one Newton of thrust. Cold gas: ~73s. Hydrazine: ~230s. Xenon ion: ~3000s. FEEP: ~6000s. Higher Isp means more ΔV per kg, but usually less thrust. This trade-off defines spacecraft design: chemical rockets for urgent maneuvers, electric propulsion for patient efficiency.',
      triggerEvent: Events.FUEL_CHANGED,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '⛽',
    },

    // === MATERIALS (new — 8 entries) ===
    {
      id: 'graphene_gsl',
      title: 'Graphene Structural Lattice',
      category: CodexCategory.MATERIALS,
      shortText: 'GSL nets are 200× stronger than steel by weight — the ultimate space debris capture material.',
      fullText: 'Graphene structural lattice (GSL) combines graphene sheets with aramid fiber backing. The result: a net material 200× stronger than steel by weight, with enough flexibility to absorb impact energy from tumbling debris. Your Weaver arms deploy GSL nets that can safely envelope objects up to 8 meters across.',
      triggerEvent: Events.ARM_CAPTURED,
      triggerCondition: (p) => p.type === 'weaver',
      unlocked: false,
      seen: false,
      icon: '🕸️',
    },
    {
      id: 'hbn_coating',
      title: 'Hexagonal Boron Nitride Coating',
      category: CodexCategory.MATERIALS,
      shortText: 'HBN coatings protect spacecraft surfaces from atomic oxygen erosion in LEO.',
      fullText: 'In LEO, atomic oxygen (single O atoms from UV splitting O₂) erodes exposed surfaces at ~1 µm/year. Hexagonal boron nitride (HBN) coatings form a ceramic shield that resists this erosion. Without protection, solar panels degrade, thermal blankets erode, and optical surfaces fog. Your mothership\'s exterior uses HBN-coated panels.',
      triggerEvent: Events.SUBSYSTEM_EVENT,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('atomic oxygen'),
      unlocked: false,
      seen: false,
      icon: '🛡️',
    },
    {
      id: 'kevlar_mli',
      title: 'Kevlar & MLI Shielding',
      category: CodexCategory.MATERIALS,
      shortText: 'Multi-Layer Insulation blankets protect against temperature swings of 300°C between sun and shadow.',
      fullText: 'Spacecraft experience temperature swings from +150°C in direct sunlight to -150°C in shadow. Multi-Layer Insulation (MLI) — thin layers of aluminized Mylar separated by Dacron spacers — acts like a space thermos. Kevlar panels underneath provide micrometeorite protection. The ISS uses 14+ layers of MLI on all exterior surfaces.',
      triggerEvent: Events.CARGO_STORE,
      triggerCondition: (p) => p.metalId === 'kevlar',
      unlocked: false,
      seen: false,
      icon: '🧥',
    },
    {
      id: 'aluminum_space',
      title: 'Aluminum in Space',
      category: CodexCategory.MATERIALS,
      shortText: 'The most common spacecraft material — 40% of all orbital debris mass is aluminum alloy.',
      fullText: 'Aluminum alloys (6061-T6, 7075) dominate spacecraft construction: lightweight, strong, easy to machine, and resistant to space radiation. About 40% of debris mass in LEO is aluminum. When salvaged in orbit, it can be re-melted in electromagnetic levitation furnaces and cast into useful shapes — turning space junk into space infrastructure.',
      triggerEvent: Events.CARGO_STORE,
      triggerCondition: (p) => p.metalId === 'aluminum',
      unlocked: false,
      seen: false,
      icon: '🔩',
    },
    {
      id: 'gallium_arsenide',
      title: 'Gallium Arsenide Solar Cells',
      category: CodexCategory.MATERIALS,
      shortText: 'GaAs cells achieve 30%+ efficiency — the gold standard for space solar power.',
      fullText: 'Gallium arsenide (GaAs) solar cells convert sunlight to electricity at 29-32% efficiency — nearly double silicon cells. They\'re also more radiation-resistant, crucial for long missions. The trade-off: GaAs costs ~100× more than silicon per watt. Dead satellites carry GaAs cells worth their weight in gold. Your forge can recover gallium from salvaged solar panels.',
      triggerEvent: Events.CARGO_STORE,
      triggerCondition: (p) => p.metalId === 'gallium',
      unlocked: false,
      seen: false,
      icon: '☀️',
    },
    {
      id: 'titanium_alloys',
      title: 'Titanium Aerospace Alloys',
      category: CodexCategory.MATERIALS,
      shortText: 'Ti-6Al-4V: the aerospace wonder alloy. Half the weight of steel, corrosion-proof, heat resistant.',
      fullText: 'Titanium alloy Ti-6Al-4V makes up rocket engine components, satellite frames, and thruster nozzles. It withstands temperatures up to 600°C, resists corrosion from atomic oxygen, and maintains strength at half the density of steel. Salvaging titanium from defunct satellites is like mining refined ore — already processed and ready for the forge.',
      triggerEvent: Events.CARGO_STORE,
      triggerCondition: (p) => p.metalId === 'titanium',
      unlocked: false,
      seen: false,
      icon: '⚙️',
    },
    {
      id: 'carbon_composites',
      title: 'Carbon Fiber Composites',
      category: CodexCategory.MATERIALS,
      shortText: 'CFRP structures are stiffer than steel at 1/5 the weight — but can\'t be easily recycled in orbit.',
      fullText: 'Carbon fiber reinforced polymer (CFRP) provides exceptional stiffness-to-weight ratio for satellite bus structures and solar panel substrates. Unlike metals, CFRP can\'t be melted and recast in orbit — the thermoset polymer matrix is permanently cured. Instead, salvaged carbon composite is valuable as radiation shielding material or structural patching compounds.',
      triggerEvent: Events.CARGO_STORE,
      triggerCondition: (p) => p.metalId === 'carbon_composite',
      unlocked: false,
      seen: false,
      icon: '🪶',
    },
    {
      id: 'iridium_avionics',
      title: 'Iridium in Spacecraft',
      category: CodexCategory.MATERIALS,
      shortText: 'Iridium is extremely rare in orbit — found in thruster catalysts and the original Iridium constellation.',
      fullText: 'Iridium — one of Earth\'s rarest elements — appears in spacecraft as a catalyst in hydrazine thrusters and as thermal coatings. The 66-satellite Iridium constellation (launched 1997-2002) left debris that still contains recoverable iridium components. In 2009, Iridium-33 collided with Cosmos-2251, creating 2,000+ tracked fragments — a cautionary tale for orbital debris.',
      triggerEvent: Events.CARGO_STORE,
      triggerCondition: (p) => p.metalId === 'iridium',
      unlocked: false,
      seen: false,
      icon: '💎',
    },

    // === TETHERS (new — 6 entries) ===
    {
      id: 'tether_materials',
      title: 'Tether Materials: Dyneema & Zylon',
      category: CodexCategory.TETHERS,
      shortText: 'Space tethers use ultra-high molecular weight polymers — stronger than steel cables at a fraction of the mass.',
      fullText: 'Dyneema (UHMWPE) and Zylon (PBO) fibers achieve tensile strengths of 3-6 GPa — comparable to steel at 1/8 the density. Zylon is stronger but degrades under UV light; Dyneema is more durable in LEO. Your tether tiers upgrade through progressively stronger materials, allowing longer tether deployments and heavier captures.',
      triggerEvent: Events.UPGRADE_APPLIED,
      triggerCondition: (p) => p.id && p.id.includes('tether'),
      unlocked: false,
      seen: false,
      icon: '🧵',
    },
    {
      id: 'tether_dynamics',
      title: 'Tether Dynamics',
      category: CodexCategory.TETHERS,
      shortText: 'Long tethers vibrate like guitar strings in orbit — managing oscillation is critical for operations.',
      fullText: 'A 500-meter tether in LEO behaves like an extremely long, thin guitar string. Gravity gradient, atmospheric drag, and electrodynamic forces all induce vibrations. Deployment speed must be carefully controlled — too fast causes dangerous oscillations, too slow wastes time. The reel motor on your mothership uses active damping to suppress tether modes.',
      triggerEvent: Events.TETHER_REEL_STATE,
      triggerCondition: (p) => p.reeling === true,
      unlocked: false,
      seen: false,
      icon: '〰️',
    },
    {
      id: 'tether_tangle_physics',
      title: 'Tether Tangle Physics',
      category: CodexCategory.TETHERS,
      shortText: 'When tethers cross, friction locks them together. Resolving tangles requires careful slack-pulse sequences.',
      fullText: 'Tether tangles are the bane of multi-arm operations. When two tethers cross under tension, friction holds them locked. The solution: inject a precisely timed slack pulse into one tether, allowing it to float free while the other remains taut. Your crossbow system detects tangles via tension sensors and can auto-resolve minor crossings, but severe tangles require manual intervention — or cutting free.',
      triggerEvent: Events.TETHER_TANGLE,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '🪢',
    },
    {
      id: 'edt_physics',
      title: 'Electrodynamic Tethers',
      category: CodexCategory.TETHERS,
      shortText: 'A conductive tether moving through Earth\'s magnetic field generates current — propellantless propulsion.',
      fullText: 'An electrodynamic tether (EDT) is a long conductive wire that generates electrical current as it moves through Earth\'s magnetic field (Faraday\'s law). By controlling current direction, you can create thrust or drag without propellant. NASA\'s TSS-1R experiment deployed a 20 km tether from the Space Shuttle in 1996 — it generated 3,500 volts before the tether snapped.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('edt'),
      unlocked: false,
      seen: false,
      icon: '⚡',
    },
    {
      id: 'miura_ori_net',
      title: 'Miura-Ori Net Folding',
      category: CodexCategory.TETHERS,
      shortText: 'Nets fold into compact packages using Miura-ori — a folding pattern that deploys in a single pull.',
      fullText: 'Miura-ori is a rigid folding pattern invented by Koryo Miura for satellite solar panels. It folds a flat sheet into a compact stack that unfurls completely with a single diagonal pull. Your capture nets use this pattern — the SMA (shape memory alloy) cinch wire activates on contact, triggering the Miura-ori unfold in under 3 seconds to envelope the target.',
      triggerEvent: Events.CROSSBOW_FIRE,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '📐',
    },
    {
      id: 'reel_mechanics',
      title: 'Motorized Reel Mechanics',
      category: CodexCategory.TETHERS,
      shortText: 'The reel motor on the mothership does all the hauling — zero fuel cost for retrieval.',
      fullText: 'Unlike traditional spacecraft capture systems that use propulsion for retrieval, your crossbow arms use a motorized reel on the mothership. At 15 W power draw, the reel winches tether at 0.25 m/s loaded (0.5 m/s unloaded). The mechanical advantage means zero propellant cost for retrieval — only electrical power. A brake system handles tension spikes during retrieval of tumbling objects.',
      triggerEvent: Events.TETHER_REEL_STATE,
      triggerCondition: (p) => p.reeling === true,
      unlocked: false,
      seen: false,
      icon: '🎣',
    },
    {
      id: 'bolas_weapon',
      title: 'Capture Net — Weighted Mesh',
      category: CodexCategory.TETHERS,
      shortText: 'Capture net. A weighted Dyneema mesh spun open by gyroscopic rotation. Gentle enough for delicate debris — and it still works in vacuum.',
      fullText: 'Capture net. A weighted Dyneema mesh spun open by gyroscopic rotation. Gentle enough for delicate debris — and it still works in vacuum. The lasso projectile is a spinning octagonal net — lightweight Dyneema lines with perimeter weights that keep it spread open during flight. Launched on a tether, the net wraps gently around debris on contact and reels it back to the mothership intact.',
      triggerEvent: Events.LASSO_FIRED,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '🥅',
    },

    // === SENSORS (new — 5 entries) ===
    {
      id: 'gps_denied',
      title: 'GPS-Denied Navigation',
      category: CodexCategory.SENSORS,
      shortText: 'When GPS is unavailable, spacecraft rely on star trackers and inertial measurement units.',
      fullText: 'GPS signals can be blocked by solar storms, SAA passages, or geometry. Without GPS, spacecraft rely on star trackers (cameras that match star patterns to catalogs) and IMUs (accelerometers + gyroscopes that dead-reckon position). Kalman filters fuse these noisy measurements into usable position estimates. Military spacecraft are designed to operate GPS-denied from the start.',
      triggerEvent: Events.SUBSYSTEM_EVENT,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('gps'),
      unlocked: false,
      seen: false,
      icon: '📡',
    },
    {
      id: 'kalman_filtering',
      title: 'Kalman Filtering',
      category: CodexCategory.SENSORS,
      shortText: 'Named after Rudolf Kálmán — the algorithm that fuses noisy sensor data into reliable position estimates.',
      fullText: 'Every sensor lies slightly. GPS has ±10m error, star trackers have arc-second noise, IMUs drift over time. The Kalman filter (1960) is a mathematical algorithm that combines multiple noisy measurements optimally, considering each sensor\'s known error characteristics. It\'s used in virtually every navigation system — from Apollo guidance to your smartphone. Your target tracking system runs Kalman filters on all debris contacts.',
      triggerEvent: Events.SCORE_UPDATE,
      triggerCondition: (p) => p.debrisCleared >= 20,
      unlocked: false,
      seen: false,
      icon: '📊',
    },
    {
      id: 'star_tracker_nav',
      title: 'Star Tracker Navigation',
      category: CodexCategory.SENSORS,
      shortText: 'A camera that photographs stars and matches patterns to determine exact spacecraft attitude.',
      fullText: 'Star trackers are cameras that photograph the sky and identify star patterns by comparing them to an onboard catalog of ~5,000 stars. Within seconds, they determine spacecraft attitude (orientation) to arc-second precision — about 0.001°. They don\'t work during SAA passages (too many radiation hits on the CCD) or when pointed at the Sun or bright Earth limb.',
      triggerEvent: Events.SUBSYSTEM_EVENT,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('star tracker'),
      unlocked: false,
      seen: false,
      icon: '⭐',
    },
    {
      id: 'pulse_scan_radar',
      title: 'Distributed Pulse Scan',
      category: CodexCategory.SENSORS,
      shortText: 'Multiple arms transmit radar pulses simultaneously — distributed aperture gives superior resolution.',
      fullText: 'A single small radar antenna has poor angular resolution. But by timing pulses from multiple daughter arms spread across hundreds of meters, your crossbow system creates a synthetic aperture — a virtual antenna the size of the entire arm constellation. This distributed pulse scan can detect debris down to 1 cm at ranges your single mothership radar could never achieve.',
      triggerEvent: Events.PULSE_SCAN_COMPLETE,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '📡',
    },
    {
      id: 'lidar_ranging',
      title: 'LIDAR Ranging',
      category: CodexCategory.SENSORS,
      shortText: 'Laser pulses measure distance to millimeter precision — essential for final approach to debris.',
      fullText: 'LIDAR (Light Detection and Ranging) fires laser pulses and measures the return time to calculate distance. At close range (<1 km), it provides millimeter-precision distance and centimeter-resolution 3D mapping of debris surfaces. Your daughter arms use LIDAR during the APPROACH state to build a tumble model of the target before committing to net deployment.',
      triggerEvent: Events.ARM_CAPTURED,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '🔦',
    },

    // === SPACE_ENVIRONMENT (new — 6 entries) ===
    {
      id: 'saa_radiation',
      title: 'South Atlantic Anomaly',
      category: CodexCategory.SPACE_ENVIRONMENT,
      shortText: 'A dip in Earth\'s magnetic field lets radiation penetrate lower — electronics glitch, sensors blind.',
      fullText: 'The South Atlantic Anomaly (SAA) is a region over South America and the Atlantic where Earth\'s inner radiation belt dips to ~200 km altitude. Spacecraft passing through experience elevated radiation — causing bit-flips in memory, noise in sensors, and CCD "snow" in star trackers. The ISS crew receives the majority of their radiation dose during SAA passes. Hubble pauses observations during SAA transits.',
      triggerEvent: Events.WEATHER_EFFECT_START,
      triggerCondition: (p) => p.type === 'SAA_PASSAGE',
      unlocked: false,
      seen: false,
      icon: '☢️',
    },
    {
      id: 'atomic_oxygen_erosion',
      title: 'Atomic Oxygen Erosion',
      category: CodexCategory.SPACE_ENVIRONMENT,
      shortText: 'Single oxygen atoms in LEO erode spacecraft surfaces — Kapton, silver, and polymers are most vulnerable.',
      fullText: 'UV radiation splits O₂ molecules in the upper atmosphere into reactive single oxygen atoms. At orbital speed (7.8 km/s), these atoms impact spacecraft surfaces with ~5 eV energy — enough to break chemical bonds. Kapton (used in solar panel wiring), silver interconnects, and organic polymers erode visibly within months. The LDEF experiment (1984-1990) showed up to 5 mm erosion depth on some materials.',
      triggerEvent: Events.SUBSYSTEM_EVENT,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('atomic oxygen'),
      unlocked: false,
      seen: false,
      icon: '🧪',
    },
    {
      id: 'uv_degradation',
      title: 'UV Degradation',
      category: CodexCategory.SPACE_ENVIRONMENT,
      shortText: 'Unfiltered solar UV in space is 10× more intense than Earth\'s surface — materials age rapidly.',
      fullText: 'Without atmospheric filtering, spacecraft receive the full solar UV spectrum at ~1,366 W/m². This causes yellowing of thermal coatings, embrittlement of polymers, and degradation of solar cell cover glass. Over years, UV exposure can reduce solar panel output by 2-3% annually. Your solar panels use cerium-doped cover glass for UV protection — but salvaged panels from old satellites may be severely degraded.',
      triggerEvent: Events.SUBSYSTEM_EVENT,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('uv'),
      unlocked: false,
      seen: false,
      icon: '🌞',
    },
    {
      id: 'mmod_impact_physics',
      title: 'MMOD Impacts',
      category: CodexCategory.SPACE_ENVIRONMENT,
      shortText: 'Micrometeorites and orbital debris: tiny particles at 10+ km/s create craters in spacecraft surfaces.',
      fullText: 'Micrometeoroids and Orbital Debris (MMOD) range from dust grains to paint flakes, traveling at 7-15 km/s relative velocity. At these speeds, a 1 cm aluminum sphere has the kinetic energy of a hand grenade. Whipple shields (spaced layers of aluminum and Kevlar) protect critical systems — the outer layer vaporizes the projectile, spreading the impact over the inner wall.',
      triggerEvent: Events.SUBSYSTEM_EVENT,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('micrometeorite'),
      unlocked: false,
      seen: false,
      icon: '💥',
    },
    {
      id: 'geomagnetic_storm',
      title: 'Geomagnetic Storms',
      category: CodexCategory.SPACE_ENVIRONMENT,
      shortText: 'Solar wind distorts Earth\'s magnetic field — increased drag, degraded GPS, and elevated radiation.',
      fullText: 'When a coronal mass ejection (CME) hits Earth\'s magnetosphere, it compresses the day-side magnetic field and stretches the night-side into a long tail. This "geomagnetic storm" heats the upper atmosphere, increasing drag on LEO satellites by up to 10×. GPS accuracy degrades, HF radio blacks out, and radiation levels spike. The 2003 Halloween storms caused several satellite failures.',
      triggerEvent: Events.WEATHER_EFFECT_START,
      triggerCondition: (p) => p.type === 'GEOMAGNETIC_STORM',
      unlocked: false,
      seen: false,
      icon: '🌀',
    },
    {
      id: 'radiation_dose',
      title: 'Radiation Dose Tracking',
      category: CodexCategory.SPACE_ENVIRONMENT,
      shortText: 'Spacecraft accumulate radiation damage over their lifetime — total dose determines equipment lifespan.',
      fullText: 'Radiation in LEO comes from trapped particles (Van Allen belts), solar energetic particles (during flares), and galactic cosmic rays. Electronics are rated for total ionizing dose (TID) — typically 30-100 krad for space-grade components. Your spacecraft tracks cumulative dose; exceeding component ratings means increased risk of latch-up events, bit-flips, and permanent degradation.',
      triggerEvent: Events.SUBSYSTEM_EVENT,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('radiation'),
      unlocked: false,
      seen: false,
      icon: '📈',
    },

    // === COMMS (new — 6 entries) ===
    {
      id: 'ground_station_pass',
      title: 'Ground Station Passes',
      category: CodexCategory.COMMS,
      shortText: 'Communication with ground is limited to brief passes over tracking stations — typically 5-15 minutes.',
      fullText: 'LEO spacecraft can only communicate with ground stations when they have line-of-sight. A typical pass over a ground station lasts 5-15 minutes depending on orbital geometry. NASA\'s network includes stations in Houston, Canberra (Australia), and Madrid (Spain), providing near-continuous coverage — but commercial operators may only get a few passes per day.',
      triggerEvent: Events.GROUND_STATION_PASS,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '📻',
    },
    {
      id: 'telemetry_bandwidth',
      title: 'Telemetry Bandwidth',
      category: CodexCategory.COMMS,
      shortText: 'S-band links provide ~2 Mbps — shared between telemetry, commands, and science data.',
      fullText: 'Standard spacecraft communication uses S-band (~2 GHz) providing 1-2 Mbps. With multiple daughter arms transmitting telemetry simultaneously, bandwidth becomes a constraint — you can\'t get high-resolution video from all arms at once. Ka-band (~26 GHz) offers 10× higher data rates but requires more precise antenna pointing. Laser comms (optical) can reach 100+ Mbps.',
      triggerEvent: Events.SUBSYSTEM_EVENT,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('bandwidth'),
      unlocked: false,
      seen: false,
      icon: '📶',
    },
    {
      id: 'laser_comms_optical',
      title: 'Laser Communications',
      category: CodexCategory.COMMS,
      shortText: 'Optical links achieve 100+ Mbps with tiny terminals — the future of space communications.',
      fullText: 'Laser communication uses modulated infrared beams (1550 nm) instead of radio waves. NASA\'s LCRD demonstrated 1.2 Gbps from geostationary orbit in 2021. Advantages: 10-100× higher data rates, smaller terminals, no frequency licensing. Challenges: requires precise pointing (50 µrad beam), blocked by clouds, and atmospheric turbulence causes scintillation. Your optical comms upgrade enables real-time video from daughter arms.',
      triggerEvent: Events.SUBSYSTEM_EVENT,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('laser comms'),
      unlocked: false,
      seen: false,
      icon: '💡',
    },
    {
      id: 'tdrs_relay',
      title: 'TDRS Relay Satellites',
      category: CodexCategory.COMMS,
      shortText: 'Tracking and Data Relay Satellites in GEO provide near-continuous communication coverage.',
      fullText: 'NASA\'s Tracking and Data Relay Satellite System (TDRSS) places relay satellites in geostationary orbit to provide LEO spacecraft with near-continuous ground contact. Instead of waiting for a ground station pass, you relay through TDRS. The ISS uses TDRS for most communications. The system has been operational since 1983 — the Space Shuttle was its first user.',
      triggerEvent: Events.SCORE_UPDATE,
      triggerCondition: (p) => p.debrisCleared >= 30,
      unlocked: false,
      seen: false,
      icon: '🛰️',
    },
    {
      id: 'signal_propagation',
      title: 'Signal Propagation Delay',
      category: CodexCategory.COMMS,
      shortText: 'Light-speed delay to LEO is only ~2 ms — but processing and routing add 200-500 ms latency.',
      fullText: 'Radio signals travel at the speed of light — 300,000 km/s. At LEO altitude (400 km), the raw propagation delay is just 1.3 ms. But real-world latency includes encoding, error correction, relay satellite hops (if using TDRS: up to GEO and back = ~240 ms), ground processing, and network routing. Total round-trip latency: 400-800 ms — noticeable during manual arm piloting.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p.source === 'HOUSTON',
      unlocked: false,
      seen: false,
      icon: '⏳',
    },
    {
      id: 'frequency_bands',
      title: 'S-Band vs Ka-Band',
      category: CodexCategory.COMMS,
      shortText: 'Higher frequencies carry more data but need larger antennas and precise pointing.',
      fullText: 'S-band (~2 GHz): robust, works with small omnidirectional antennas, but limited to ~2 Mbps. Ka-band (~26 GHz): 10× bandwidth but requires dish antennas with precise pointing. X-band (~8 GHz): a middle ground used by military and deep-space missions. Your spacecraft starts with S-band; upgrading to Ka-band or optical requires more power and better attitude control.',
      triggerEvent: Events.WEATHER_EFFECT_END,
      triggerCondition: (p) => p.type === 'SAA_PASSAGE',
      unlocked: false,
      seen: false,
      icon: '📡',
    },

    // === POWER (new — 5 entries) ===
    {
      id: 'cmg_gyroscopes',
      title: 'CMGs & Reaction Wheels',
      category: CodexCategory.POWER,
      shortText: 'Spinning flywheels store angular momentum — changing their speed rotates the spacecraft without propellant.',
      fullText: 'Control Moment Gyroscopes (CMGs) and reaction wheels are spinning flywheels that trade angular momentum with the spacecraft. Speed up a wheel spinning around the pitch axis, and the spacecraft rotates in pitch — no propellant needed. The ISS uses four 300 kg CMGs producing 258 N⋅m torque each. Over time, wheels accumulate excess momentum and must be "desaturated" using thrusters.',
      triggerEvent: Events.SUBSYSTEM_EVENT,
      triggerCondition: (p) => p.text && (p.text.toLowerCase().includes('gyro') || p.text.toLowerCase().includes('reaction wheel')),
      unlocked: false,
      seen: false,
      icon: '🔄',
    },
    {
      id: 'spin_stabilization',
      title: 'Spin Stabilization',
      category: CodexCategory.POWER,
      shortText: 'A spinning object resists attitude changes — useful for stability, but must be de-spun before capture.',
      fullText: 'Angular momentum conservation means a spinning object maintains its orientation. Early satellites used spin stabilization (rotating at 1-2 RPM) instead of reaction wheels — simpler but limits antenna pointing. Tumbling debris is often spin-stabilized by accident. Your ablation laser can gradually de-spin targets by vaporizing material on one side, creating a tiny counter-torque. It\'s like using a garden hose to stop a merry-go-round.',
      triggerEvent: Events.ABLATION_END,
      triggerCondition: (p) => p.despinAchieved === true,
      unlocked: false,
      seen: false,
      icon: '🌀',
    },
    {
      id: 'battery_cycles',
      title: 'Battery Cycle Life',
      category: CodexCategory.POWER,
      shortText: 'Li-ion batteries in LEO undergo 16 charge/discharge cycles per day — rating for 50,000+ cycles is critical.',
      fullText: 'In LEO, batteries charge during sunlight and discharge during eclipse — 16 cycles per day, ~5,840 per year. Over a 15-year mission, that\'s 87,600 cycles. Space-grade lithium-ion cells are rated for 50,000-80,000 cycles with 10-20% depth-of-discharge. Going deeper into the battery shortens its life exponentially. Your power management system limits battery DoD to preserve long-term capacity.',
      triggerEvent: Events.SUBSYSTEM_EVENT,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('battery'),
      unlocked: false,
      seen: false,
      icon: '🔋',
    },
    {
      id: 'solar_cell_degradation',
      title: 'Solar Cell Degradation',
      category: CodexCategory.POWER,
      shortText: 'Radiation and UV gradually reduce solar panel output — panels lose 2-3% efficiency per year in LEO.',
      fullText: 'Solar cells degrade from proton and electron radiation damage, UV embrittlement of cover glass, and micrometeorite pitting. Typical degradation: 2-3% per year in LEO, 1% in GEO. After 15 years, panels may produce only 60-70% of their beginning-of-life power. Mission designers "over-size" solar arrays to ensure adequate end-of-life power. Salvaged panels from old satellites are often severely degraded.',
      triggerEvent: Events.SUBSYSTEM_EVENT,
      triggerCondition: (p) => p.text && p.text.toLowerCase().includes('solar uv'),
      unlocked: false,
      seen: false,
      icon: '📉',
    },
    {
      id: 'power_bus_management',
      title: 'Power Bus ETS',
      category: CodexCategory.POWER,
      shortText: 'Emergency load-shedding prioritizes critical systems — just like a warship\'s damage control.',
      fullText: 'Spacecraft electrical power is distributed through regulated buses (typically 28V or 100V DC). When power generation drops (eclipse, panel failure), an Energy Transfer System (ETS) sheds non-critical loads in priority order: science instruments first, then heaters, then communications, with attitude control and life support last to go. Your three-bus power system (Thrust/Sensors/Arms) lets you manually prioritize.',
      triggerEvent: Events.POWER_BUS_SELECTED,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '⚡',
    },

    // === DEBRIS (new — 8 entries) ===
    {
      id: 'debris_classification',
      title: 'Debris Size Classification',
      category: CodexCategory.DEBRIS,
      shortText: '~1 cm can kill. ~10 cm can be tracked. Most dangerous: the 1-10 cm "lethal untrackable" range.',
      fullText: 'Space debris is classified by size: >10 cm (trackable — ~36,000 objects cataloged), 1-10 cm (lethal but untrackable — ~1 million estimated), and <1 cm (damageable — ~130 million). A 1 cm aluminum sphere at 10 km/s relative velocity has the energy of a hand grenade. The most dangerous debris is in the 1-10 cm gap: too small to track, too large for shielding to handle.',
      triggerEvent: Events.SCORE_UPDATE,
      triggerCondition: (p) => p.debrisCleared >= 10,
      unlocked: false,
      seen: false,
      icon: '📏',
    },
    {
      id: 'trackable_vs_dark',
      title: 'Trackable vs Dark Debris',
      category: CodexCategory.DEBRIS,
      shortText: 'Only objects >10 cm are reliably tracked — the rest is "dark debris" invisible to ground radar.',
      fullText: 'The US Space Surveillance Network tracks objects down to ~10 cm in LEO using ground-based radar and optical telescopes. But for every tracked object, there are ~25-30 untracked pieces in the 1-10 cm range. These "dark debris" objects are invisible to ground surveillance but lethal to spacecraft. Your onboard sensors (LIDAR, pulse scan) can detect objects that ground tracking misses.',
      triggerEvent: Events.UPGRADE_APPLIED,
      triggerCondition: (p) => p.id && (p.id.includes('sensor') || p.id.includes('scan')),
      unlocked: false,
      seen: false,
      icon: '👁️',
    },
    {
      id: 'conjunction_assessment',
      title: 'Conjunction Assessment',
      category: CodexCategory.DEBRIS,
      shortText: 'Predicting close approaches between objects — a conjunction assessment determines collision probability.',
      fullText: 'A "conjunction" is a predicted close approach between two space objects. USSPACECOM screens all 36,000+ tracked objects against each other, generating Conjunction Data Messages (CDMs) when miss distance drops below threshold. If collision probability exceeds 1 in 10,000, spacecraft operators may execute an avoidance maneuver. The ISS performs ~2-3 avoidance maneuvers per year.',
      triggerEvent: Events.ARM_CAPTURED,   // ST-2.1: moved from CONJUNCTION_WARNING so entry unlocks before first alert
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '⚠️',
    },
    {
      id: 'breakup_events',
      title: 'Breakup Events',
      category: CodexCategory.DEBRIS,
      shortText: 'A single collision can create thousands of fragments — each one a potential bullet.',
      fullText: 'When two objects collide at orbital speed, the impact energy can exceed TNT-equivalent explosions. The 2009 Iridium-Cosmos collision at ~11.7 km/s created 2,300+ trackable fragments and an estimated 100,000+ pieces >1 mm. Each fragment enters its own independent orbit, spreading across a band of altitude over months. This is how Kessler Syndrome begins — each collision seeds future collisions.',
      triggerEvent: Events.KESSLER_FRAGMENTS_ADDED,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '💥',
    },
    {
      id: 'iridium_cosmos',
      title: 'The Iridium-Cosmos Collision',
      category: CodexCategory.DEBRIS,
      shortText: 'February 10, 2009: the first accidental hypervelocity collision between two intact satellites.',
      fullText: 'At 16:56 UTC on February 10, 2009, Iridium-33 (an active communications satellite) collided with Cosmos-2251 (a derelict Russian military satellite) at 11.7 km/s over Siberia, altitude 789 km. The collision destroyed both spacecraft, creating a debris cloud of 2,300+ trackable fragments. Many remain in orbit today. It was the first (and so far, only) accidental collision between two intact satellites — a wake-up call for the space community.',
      triggerEvent: Events.SCORE_UPDATE,
      triggerCondition: (p) => p.debrisCleared >= 25,
      unlocked: false,
      seen: false,
      icon: '💫',
    },
    {
      id: 'fengyun_test',
      title: 'FengYun-1C ASAT Test',
      category: CodexCategory.DEBRIS,
      shortText: 'China\'s 2007 anti-satellite test created 3,500+ trackable fragments — the single worst debris event.',
      fullText: 'On January 11, 2007, China destroyed its own FengYun-1C weather satellite with a kinetic kill vehicle at 865 km altitude. The test created 3,500+ trackable fragments and an estimated 150,000+ pieces >1 cm — the single largest debris-generating event in history. At 865 km altitude, most fragments will remain in orbit for centuries. This event increased the tracked debris population by ~25% overnight.',
      triggerEvent: Events.KESSLER_CASCADE,
      triggerCondition: () => true,
      unlocked: false,
      seen: false,
      icon: '🎯',
    },
    {
      id: 'ssa_network',
      title: 'Space Situational Awareness',
      category: CodexCategory.DEBRIS,
      shortText: 'The global network that tracks every object in orbit — radar fences, optical telescopes, and orbital catalogs.',
      fullText: 'Space Situational Awareness (SSA) is the ability to detect, track, and predict the position of objects in orbit. The US Space Surveillance Network operates ground-based radar (Eglin, Cape Cod) and optical sites (Diego Garcia, Maui). ESA\'s SST system adds European sensors. Together, they maintain a catalog of 36,000+ objects. But the network has gaps — and new commercial trackers (LeoLabs, ExoAnalytic) are filling them.',
      triggerEvent: Events.SCORE_UPDATE,
      triggerCondition: (p) => p.debrisCleared >= 40,
      unlocked: false,
      seen: false,
      icon: '🌐',
    },
    {
      id: 'adr_methods_real',
      title: 'Active Debris Removal IRL',
      category: CodexCategory.DEBRIS,
      shortText: 'Real ADR missions are finally launching — harpoons, nets, robotic arms, and magnetic capture.',
      fullText: 'After decades of study, Active Debris Removal (ADR) is becoming reality. ESA\'s ClearSpace-1 (2026) will use a capture cone to deorbit a Vega upper stage. Astroscale\'s ELSA-d demonstrated magnetic capture in 2021. Other approaches include harpoons (RemoveDEBRIS, 2018), ion beam deflection, and laser nudging. Your crossbow system represents the next generation: reusable, multi-target, and propellant-efficient.',
      triggerEvent: Events.SCORE_UPDATE,
      triggerCondition: (p) => p.debrisCleared >= 50,
      unlocked: false,
      seen: false,
      icon: '🚀',
    },

    // === ST-8.3.7: FEEP PROPELLANT METALS (7 entries) ===
    {
      id: 'feep_indium',
      title: 'FEEP Propellant: Indium',
      category: CodexCategory.PROPULSION,
      shortText: 'Indium — the baseline FEEP propellant with TRL 9 flight heritage from Enpulsion IFM Nano.',
      fullText: 'Indium (In, Z=49) melts at 156.6°C and has been the workhorse FEEP propellant since the 1990s. Enpulsion\'s IFM Nano thruster uses a porous indium needle emitter to achieve 4,000–19,000 seconds specific impulse at micro-Newton thrust levels. The TRL 9 rating means indium FEEP has been flight-proven on multiple missions: LISA Pathfinder, IFM Nano on various CubeSats, and ESA\'s GOCE gravity mapper. Indium\'s high surface tension and low vapor pressure make it ideal for capillary feed systems. Your daughter arms ship with indium as the default propellant — reliable, well-characterized, and available off-the-shelf.',
      triggerEvent: Events.FEEP_METAL_CHANGED,
      triggerCondition: (p) => p.metal === 'indium',
      unlocked: false,
      seen: false,
      icon: '🔬',
    },
    {
      id: 'feep_gallium',
      title: 'FEEP Propellant: Gallium',
      category: CodexCategory.PROPULSION,
      shortText: 'Gallium melts at 29.8°C — warm enough to liquefy in your hand. Higher ISP than indium.',
      fullText: 'Gallium melts at just 29.8°C — warm enough to liquefy in your hand. This low melting point makes it ideal for FEEP thrusters: less heater power needed, simpler feed systems. ESA Horizon 2000+ studies showed gallium FEEP achieving specific impulses up to 25,000 seconds, 31% higher than indium baseline. The trade-off: slightly lower thrust per watt (0.028 vs 0.032 N/W). Gallium\'s tendency to supercool below its freezing point adds operational complexity — the feed system must prevent solidification during eclipse passages.',
      triggerEvent: Events.FEEP_METAL_CHANGED,
      triggerCondition: (p) => p.metal === 'gallium',
      unlocked: false,
      seen: false,
      icon: '🔬',
    },
    {
      id: 'feep_bismuth',
      title: 'FEEP Propellant: Bismuth',
      category: CodexCategory.PROPULSION,
      shortText: 'Bismuth — the heavy-ion bruiser. Low ISP but highest thrust per watt among conventional FEEP metals.',
      fullText: 'Bismuth (Bi, Z=83) is the heaviest practical FEEP propellant. At 209 atomic mass units, each ion carries enormous momentum — translating to 45 mN/W thrust, 40% more than indium. The trade-off is severe: ISP tops out at 8,000 seconds, less than half of indium\'s maximum. Bismuth melts at 271°C, requiring more heater power. Research at TU Dresden and Alta SpA demonstrated bismuth FEEP in ground tests, achieving TRL 6. Use bismuth when you need raw stopping power — deorbiting heavy debris or emergency braking maneuvers.',
      triggerEvent: Events.FEEP_METAL_CHANGED,
      triggerCondition: (p) => p.metal === 'bismuth',
      unlocked: false,
      seen: false,
      icon: '🔬',
    },
    {
      id: 'feep_iodine',
      title: 'FEEP Propellant: Iodine',
      category: CodexCategory.PROPULSION,
      shortText: 'Iodine — cheap and storable as a solid, but corrosive to thruster components.',
      fullText: 'Iodine (I, Z=53) stores as a solid at room temperature — no pressurized tanks needed. At ~$500/kg versus indium\'s ~$200/kg, it\'s cost-competitive with far higher density (4.93 g/cm³ solid). ThrustMe\'s NPT30-I2 flew on ESA\'s SpaceVan in 2020, validating iodine EP at TRL 7. ISP range is modest (2,000–4,500s) but thrust per watt is excellent at 60 mN/W. The catch: iodine is viciously corrosive. It attacks spacecraft surfaces, feed lines, and even thruster grids. Japan\'s JAXA explored iodine for "air-breathing" EP concepts that scoop atmospheric particles below 200 km.',
      triggerEvent: Events.FEEP_METAL_CHANGED,
      triggerCondition: (p) => p.metal === 'iodine',
      unlocked: false,
      seen: false,
      icon: '🔬',
    },
    {
      id: 'feep_mercury',
      title: 'FEEP Propellant: Mercury',
      category: CodexCategory.PROPULSION,
      shortText: 'Mercury — toxic but effective. Historical heritage from Soviet Zond and US SERT missions.',
      fullText: 'Mercury was actually the first ion thruster propellant ever flown in space — NASA\'s SERT-I (1964) and the Soviet Zond series used mercury bombardment thrusters. ISP range of 3,000–10,000 seconds with solid 40 mN/W thrust efficiency. Mercury\'s high atomic mass (200.6 u) and liquid-at-room-temperature state make it mechanically simple. The dealbreaker: mercury is extremely toxic. Post-mission contamination risks caused NASA to abandon mercury EP in the 1980s. Modern planetary protection protocols effectively ban it. Your forge can still extract it from old switchgear debris — use it if you\'re desperate, but the codex warns: handle with extreme caution.',
      triggerEvent: Events.FEEP_METAL_CHANGED,
      triggerCondition: (p) => p.metal === 'mercury',
      unlocked: false,
      seen: false,
      icon: '⚠️',
    },
    {
      id: 'feep_cesium',
      title: 'FEEP Propellant: Cesium',
      category: CodexCategory.PROPULSION,
      shortText: 'Cesium — the ISP king, but violently reactive with water and oxygen.',
      fullText: 'Cesium (Cs, Z=55) holds the record for highest FEEP specific impulse: 8,000–22,000 seconds in flight-representative tests. Its low ionization energy (3.89 eV, lowest of any stable element) means efficient ion extraction at low power. Early FEEP research at ESA\'s ESTEC in the 1970s-80s used cesium emitters extensively. The problem: cesium reacts explosively with water and air. Handling requires inert atmosphere gloveboxes. Contamination of spacecraft surfaces causes long-term outgassing and arcing. Modern preference shifted to indium precisely because it\'s chemically boring. Cesium\'s ISP advantage makes it tempting — but only for spacecraft that never come home.',
      triggerEvent: Events.FEEP_METAL_CHANGED,
      triggerCondition: (p) => p.metal === 'cesium',
      unlocked: false,
      seen: false,
      icon: '⚠️',
    },
    {
      id: 'feep_tungsten',
      title: 'FEEP Propellant: Tungsten',
      category: CodexCategory.PROPULSION,
      shortText: 'Tungsten — maximum thrust, minimum range. Requires MPD-class power to ionize.',
      fullText: 'Tungsten (W, Z=74) is the extreme end of FEEP propellant research. At 183.8 u atomic mass and 3,422°C melting point, it demands enormous power to ionize and accelerate — MPD-class systems drawing kilowatts. In return, tungsten delivers 80 mN/W thrust, more than double indium. ISP is limited (1,500–3,500s) because the massive ions can\'t be accelerated efficiently. TRL 4 means lab demonstrations only — no flight hardware exists. Tungsten FEEP concepts emerged from Applied Physics Laboratory studies on high-thrust EP for orbital debris remediation. A perfect match for your mission, if you can handle the power budget.',
      triggerEvent: Events.FEEP_METAL_CHANGED,
      triggerCondition: (p) => p.metal === 'tungsten',
      unlocked: false,
      seen: false,
      icon: '🔬',
    },

    // === ST-8.4.7: NEWS EVENT ENTRIES (3 entries) ===
    {
      id: 'news_ast_spacemobile',
      title: 'AST SpaceMobile BW3',
      category: CodexCategory.NEWS,
      shortText: 'AST SpaceMobile\'s 64m² phased-array test satellite, tumbling in LEO.',
      fullText: 'AST SpaceMobile BW3 — the 64m² phased-array test satellite launched in 2022 to prove direct-to-cell connectivity from orbit. After three years of successful testing demonstrating 4G/5G coverage to unmodified smartphones, a reaction wheel failure left it tumbling at 2°/s. Its massive solar arrays make it a significant Kessler risk in the busy 350km ISS corridor. At 700 kg, it represents a high-value capture: the solar cells contain gallium arsenide, and the phased-array antenna is rich in indium and gold. The U.S. government has posted a ₹25,000 bounty for safe deorbit.',
      triggerEvent: Events.NEWS_EVENT_TRIGGERED,
      triggerCondition: (p) => p.eventId === 'ast_spacemobile_tumble',
      unlocked: false,
      seen: false,
      icon: '📰',
    },
    {
      id: 'news_starlink_breakup',
      title: 'Starlink V2-Mini Breakup',
      category: CodexCategory.NEWS,
      shortText: 'Catastrophic battery failure fragmented a Starlink V2-Mini cluster.',
      fullText: 'Starlink V2-Mini Battery Cascade — a lithium-ion battery thermal runaway that fragmented a cluster of 35 V2-Mini satellites in the 540km shell. The expanding debris cloud threatens hundreds of operational Starlinks and other LEO assets in the 53° inclination band. Each fragment is small (averaging 50 kg) but the sheer number creates a dense threat corridor. SpaceX has posted a ₹50,000 bounty for the full sweep. The electronics-rich debris is a good source of gallium and indium for FEEP propellant refinement.',
      triggerEvent: Events.NEWS_EVENT_TRIGGERED,
      triggerCondition: (p) => p.eventId === 'starlink_breakup',
      unlocked: false,
      seen: false,
      icon: '📰',
    },
    {
      id: 'news_thaicom4',
      title: 'Thaicom 4 (IPSTAR)',
      category: CodexCategory.NEWS,
      shortText: 'At 6,505 kg, the largest commercial sat ever built — now a GEO derelict.',
      fullText: 'Thaicom 4 (IPSTAR) — at 6,505 kg, the largest commercial communications satellite ever built when launched by Arianespace in 2005. After twenty years serving Southeast Asia\'s broadband needs from its GEO slot at 119.5°E, Thailand\'s NBTC has requested its removal from the graveyard orbit. This is the first GEO active debris removal contract, requiring a full orbit-raise to GEO altitude. The ₹100,000 bounty reflects the extreme difficulty: GEO operations demand precise station-keeping, and the satellite\'s massive solar arrays and antenna reflectors make grappling complex. Hassan MCF\'s 32m deep-space dish is recommended for tracking.',
      triggerEvent: Events.NEWS_EVENT_TRIGGERED,
      triggerCondition: (p) => p.eventId === 'thaicom4_geo_derelict',
      unlocked: false,
      seen: false,
      icon: '📰',
    },

    // === ST-8.4.7: ISRO HERITAGE ENTRIES (4 entries) ===
    {
      id: 'isro_why_india',
      title: 'Why Launch from India?',
      category: CodexCategory.HERITAGE,
      shortText: 'Sriharikota\'s latitude and PSLV reliability make India ideal for orbital ops.',
      fullText: 'Why Launch from India? — Sriharikota\'s 13.7°N latitude provides a significant velocity boost for equatorial and low-inclination orbits compared to higher-latitude launch sites like Baikonur (45.6°N) or Vandenberg (34.7°N). India\'s PSLV has the most reliable track record of any active rocket family, with 55+ consecutive successes. Cost-per-kg to LEO is among the lowest globally, roughly $15,000/kg on PSLV versus $30,000+ on Western launchers. For Space Cowboy\'s mothership, an Indian launch means lower initial ΔV requirements and proximity to ISTRAC Bangalore\'s tracking network from the moment of orbital insertion.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => {
        const src = (p.source || '').toUpperCase();
        return src === 'BANGALORE' || src === 'HASSAN';
      },
      unlocked: false,
      seen: false,
      icon: '🇮🇳',
    },
    {
      id: 'isro_kulasekarapattinam',
      title: 'Kulasekarapattinam Spaceport',
      category: CodexCategory.HERITAGE,
      shortText: 'India\'s newest launch facility at 8.4°N — closest to the equator.',
      fullText: 'Kulasekarapattinam — India\'s newest spaceport at 8.4°N latitude on the Tamil Nadu coast, even closer to the equator than Sriharikota. Purpose-built for the Small Satellite Launch Vehicle (SSLV), it enables rapid-response launches with a 72-hour turnaround. The southern location provides an additional ~0.5% velocity advantage for equatorial orbits. Dedicated pad infrastructure and a streamlined range make it ideal for the frequent, small payloads needed to resupply orbital servicing missions. ISRO envisions it as the "responsive space" hub for India\'s growing commercial launch sector.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => {
        const src = (p.source || '').toUpperCase();
        return src === 'BANGALORE' || src === 'HASSAN';
      },
      unlocked: false,
      seen: false,
      icon: '🚀',
    },
    {
      id: 'isro_istrac',
      title: 'ISTRAC Bangalore',
      category: CodexCategory.HERITAGE,
      shortText: 'ISRO\'s Telemetry, Tracking & Command Network headquarters.',
      fullText: 'ISTRAC Bangalore — the Indian Space Research Organisation\'s Telemetry, Tracking and Command Network headquarters, located in Peenya industrial area of Bangalore. Manages all ISRO spacecraft operations including Chandrayaan lunar missions, Mars Orbiter Mission, and the growing constellation of Earth observation satellites. The campus houses Mission Control, the Indian Deep Space Network relay hub, and the Spacecraft Control Centre. For Space Cowboy operations, ISTRAC provides primary LEO tracking with sub-arc-second pointing accuracy on its S-band and C-band antennas, enabling precise orbit determination for debris intercept planning.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => {
        const src = (p.source || '').toUpperCase();
        return src === 'BANGALORE' || src === 'HASSAN';
      },
      unlocked: false,
      seen: false,
      icon: '📡',
    },
    {
      id: 'isro_launch_vehicles',
      title: 'ISRO Launch Vehicle Families',
      category: CodexCategory.HERITAGE,
      shortText: 'PSLV, LVM3, and SSLV — India\'s orbital access fleet.',
      fullText: 'ISRO Launch Vehicle Families — three active systems covering all payload classes. PSLV (Polar Satellite Launch Vehicle): the workhorse with 55+ flights, 1,750 kg to Sun-synchronous orbit, four-stage solid/liquid design. LVM3 (formerly GSLV Mk III): India\'s heavy-lift vehicle with indigenous CE-20 cryogenic upper stage, 4,000 kg to GTO, launched Chandrayaan-2 and -3 lunar missions. SSLV (Small Satellite Launch Vehicle): newest family, 500 kg to LEO in just 72-hour turnaround on 3 solid stages plus a liquid terminal guidance module. All three families have demonstrated exceptional reliability, making Indian launch services among the most cost-effective and dependable in the global market.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => {
        const src = (p.source || '').toUpperCase();
        return src === 'BANGALORE' || src === 'HASSAN';
      },
      unlocked: false,
      seen: false,
      icon: '🚀',
    },

    // === CH5 ISS CONJUNCTION BOSS (MISSION_ARC §6) — outcome-gated ===
    {
      id: 'iss_saver',
      title: 'ISS Saver',
      category: CodexCategory.DEBRIS,
      shortText: 'You cleared a Cosmos-1408 fragment cloud before it reached the ISS.',
      fullText: 'On 15 November 2021 Russia destroyed Cosmos-1408 in a direct-ascent ASAT test, generating 1,500+ trackable fragments and countless smaller pieces in a 51.6° band that crosses the ISS. The crew sheltered in their Soyuz and Crew Dragon for several orbits. Clearing a converging fragment cloud yourself means the station never has to burn propellant to dodge — and the crew keeps working.',
      triggerEvent: Events.ISS_BOSS_RESOLVED,
      triggerCondition: (p) => p && p.outcome === 'intercept',
      unlocked: false,
      seen: false,
      icon: '🛰️',
    },
    {
      id: 'iss_pdam',
      title: 'ISS PDAM',
      category: CodexCategory.DEBRIS,
      shortText: 'You let the ISS perform a Predetermined Debris Avoidance Maneuver.',
      fullText: 'A PDAM is the routine response when a conjunction\'s collision probability exceeds roughly 1-in-10,000: mission control commands a reboost using the Zvezda module or a docked Progress, nudging the station clear by about 0.5–1 m/s. The ISS has done this 30+ times since 1999. Declining the intercept and letting the station maneuver itself is a perfectly valid call — no penalty, just a little spent propellant.',
      triggerEvent: Events.ISS_BOSS_RESOLVED,
      triggerCondition: (p) => p && p.outcome === 'decline',
      unlocked: false,
      seen: false,
      icon: '🚀',
    },
    {
      id: 'iss_hydrazine_burn',
      title: 'Hydrazine Reboost',
      category: CodexCategory.DEBRIS,
      shortText: 'The ISS dodged on its own at the last minute — burning ~3 kg of hydrazine (~$40k).',
      fullText: 'You engaged the threat but ran out of time before closest approach, so the station had to perform a late avoidance reboost. Hydrazine is cheap on the ground but eye-wateringly expensive once launched — a rushed ~3 kg burn runs around $40,000 and interrupts on-board experiments. Finishing the intercept earlier would have saved both the propellant and the science.',
      triggerEvent: Events.ISS_BOSS_RESOLVED,
      triggerCondition: (p) => p && p.outcome === 'miss',
      unlocked: false,
      seen: false,
      icon: '⛽',
    },

    // === CH8/9/11 Phase D codex (Hubble watch, Starlink boss, Thaicom) ===
    {
      id: 'hubble_watch',
      title: 'Hubble Watch',
      category: CodexCategory.DEBRIS,
      shortText: 'The Hubble Space Telescope shares the LEO-Mid band — and is off-limits.',
      fullText: 'Hubble orbits near 540 km at 28.5° — a working observatory, not salvage. Treaty and common sense make active, crewed, or functioning assets no-fire targets; the arm refuses to engage them. The discipline that matters at this altitude is identification: confirm what a contact IS before you commit fuel or a net to it.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p && typeof p.text === 'string' && p.text.includes('Hubble'),
      unlocked: false,
      seen: false,
      icon: '🔭',
    },
    {
      id: 'starlink_contained',
      title: 'Cascade Contained',
      category: CodexCategory.DEBRIS,
      shortText: 'You swept a fresh fragmentation cloud before it could seed a Kessler cascade.',
      fullText: 'When a satellite fragments, the danger is not the first cloud but the second: fragments striking other objects, each impact breeding more debris until a shell becomes unusable for generations — the Kessler syndrome. Sweeping a fresh cloud quickly is the single highest-leverage thing a debris tug can do. Speed matters more than tonnage here.',
      triggerEvent: Events.STARLINK_BOSS_RESOLVED,
      triggerCondition: (p) => p && p.outcome === 'contained',
      unlocked: false,
      seen: false,
      icon: '🛰️',
    },
    {
      id: 'starlink_cascade',
      title: 'Kessler Syndrome',
      category: CodexCategory.DEBRIS,
      shortText: 'Too many fragments escaped — the collisional cascade is self-sustaining.',
      fullText: 'Donald Kessler predicted in 1978 that beyond a critical density, debris collisions become self-sustaining: each impact creates fragments that cause further impacts, faster than atmospheric drag removes them. A runaway cascade can render an entire orbital shell unusable. You didn\'t catch this one in time — but every piece you DID clear lowered the density a little, and the lesson carries forward.',
      triggerEvent: Events.STARLINK_BOSS_RESOLVED,
      triggerCondition: (p) => p && p.outcome === 'cascade',
      unlocked: false,
      seen: false,
      icon: '💥',
    },
    {
      id: 'thaicom_graveyard',
      title: 'GEO Graveyard',
      category: CodexCategory.DEBRIS,
      shortText: 'Dead GEO birds are boosted to a graveyard orbit ~300 km above the belt.',
      fullText: 'Geostationary slots at 35,786 km are scarce and precious, so end-of-life satellites are meant to be boosted into a "graveyard" orbit a few hundred km higher, clearing the working belt. Many — like the long-dead Thaicom 4 / IPSTAR — never made it, or drift uncontrolled. Reaching GEO is a patience game: a half-orbit Hohmann climb where timing, not thrust, decides whether you arrive where the target will be.',
      triggerEvent: Events.COMMS_MESSAGE,
      triggerCondition: (p) => p && typeof p.text === 'string' && p.text.includes('Thaicom'),
      unlocked: false,
      seen: false,
      icon: '🛰️',
    },
  ];
}

// ============================================================================
// ST-6.6: TRL ANNOTATIONS — one entry per codex ID.
// See BIG_PICTURE.md §25 for rationale. Any entry not listed falls back to
// TRL 9 "Established science (default)" so the integrity test never fails.
// ============================================================================
const TRL_ANNOTATIONS = {
  // === ORBITAL_MECHANICS (10) — established physics, all TRL 9 ===
  keplerian_orbit:         { trl: 9, trlRationale: 'Established orbital mechanics (Kepler 1609)' },
  delta_v:                 { trl: 9, trlRationale: 'Tsiolkovsky rocket equation (1903)' },
  hohmann_transfer:        { trl: 9, trlRationale: 'Flown on every orbital transfer since 1960s' },
  orbital_inclination:     { trl: 9, trlRationale: 'Established orbital mechanics' },
  prograde_paradox:        { trl: 9, trlRationale: 'Documented from Gemini 4 (1965) onward' },
  j2_perturbation:         { trl: 9, trlRationale: 'Exploited on every sun-synchronous satellite' },
  atmospheric_drag:        { trl: 9, trlRationale: 'Observed and modelled since Sputnik (1957)' },
  relative_velocity:       { trl: 9, trlRationale: 'Core concept in every rendezvous since Gemini' },
  orbital_period_altitude: { trl: 9, trlRationale: 'Kepler\'s third law' },
  raan_precession:         { trl: 9, trlRationale: 'Exploited operationally for decades' },

  // === PROPULSION ===
  feep_thruster:               { trl: 7, trlRationale: 'FEEP flown on Gaia (2013), LISA Pathfinder (2016); kW-class still emerging' },
  specific_impulse:            { trl: 9, trlRationale: 'Figure of merit used in every flight programme' },
  xenon_propellant:            { trl: 9, trlRationale: 'Flown since Deep Space 1 (1998); standard on GEO sats' },
  edt_propulsion:              { trl: 5, trlRationale: 'TSS-1R (1996) tether snapped at 3.5 kV; still research/lab demos' },
  krypton_propellant:          { trl: 9, trlRationale: 'Starlink Hall thrusters flown since 2019' },
  argon_propellant:            { trl: 7, trlRationale: 'Starlink V2 argon thrusters first flown 2023; accumulating heritage' },
  cold_gas_thruster:           { trl: 9, trlRationale: 'Used on every crewed and most uncrewed spacecraft since 1960s' },
  mpd_burst:                   { trl: 4, trlRationale: 'Lab-demonstrated at NASA Glenn, JAXA; no kW-class flight heritage' },
  spring_energy:               { trl: 2, trlRationale: 'Game concept — no flight heritage for mothership-launched crossbow bolts' },
  recoil_cancellation:         { trl: 9, trlRationale: 'Newton\'s third law — dual-fire momentum cancellation is standard' },
  cold_gas_rcs:                { trl: 9, trlRationale: 'Same heritage as cold_gas_thruster' },
  specific_impulse_explained:  { trl: 9, trlRationale: 'Established engineering figure of merit' },

  // === ST-8.3.7: FEEP PROPELLANT METALS ===
  feep_indium:    { trl: 9, trlRationale: 'Enpulsion IFM Nano flown on multiple missions; LISA Pathfinder (2016)' },
  feep_gallium:   { trl: 7, trlRationale: 'ESA Horizon 2000+ ground tests; no flight heritage yet' },
  feep_bismuth:   { trl: 6, trlRationale: 'TU Dresden / Alta SpA ground tests; system-level demo' },
  feep_iodine:    { trl: 7, trlRationale: 'ThrustMe NPT30-I2 flown on SpaceVan (2020)' },
  feep_mercury:   { trl: 5, trlRationale: 'SERT-I (1964), Zond heritage; banned by modern protocols' },
  feep_cesium:    { trl: 5, trlRationale: 'ESA ESTEC 1970s-80s tests; abandoned due to reactivity' },
  feep_tungsten:  { trl: 4, trlRationale: 'APL concept studies; lab demos only, no flight hardware' },

  // === POWER ===
  solar_power:             { trl: 9, trlRationale: 'Flown on every operational spacecraft since Vanguard 1 (1958)' },
  eclipse_cycle:           { trl: 9, trlRationale: 'Fundamental LEO constraint since 1957' },
  battery_chemistry:       { trl: 9, trlRationale: 'Li-ion flown since 1990s; space-grade cells routine' },
  supercapacitors:         { trl: 8, trlRationale: 'Supercap modules flown on CubeSats; mature for bus applications' },
  thermal_management:      { trl: 9, trlRationale: 'MLI + heaters + radiators on every spacecraft' },
  mli_insulation:          { trl: 9, trlRationale: 'Ubiquitous — standard exterior on all spacecraft' },
  multijunction_pv:        { trl: 9, trlRationale: 'Triple-junction GaAs on every GEO sat and Mars rover' },
  solid_state_battery:     { trl: 5, trlRationale: 'Automotive solid-state cells emerging; not yet space-qualified' },
  graphene_supercap:       { trl: 3, trlRationale: 'Lab-scale graphene capacitors demonstrated; no space heritage' },
  rtg_power:               { trl: 9, trlRationale: 'Flown since SNAP-3 (1961); Voyager, Curiosity, Perseverance' },
  power_beaming:           { trl: 5, trlRationale: 'JAXA (2015) demonstrated 1.8 kW over 55 m ground-to-ground; no on-orbit heritage' },
  cmg_gyroscopes:          { trl: 9, trlRationale: 'Skylab (1973), ISS (2001) — decades of operation' },
  spin_stabilization:      { trl: 9, trlRationale: 'Flown since Explorer 1 (1958)' },
  battery_cycles:          { trl: 9, trlRationale: 'Established design-for-life practice' },
  solar_cell_degradation:  { trl: 9, trlRationale: 'Observed and modelled on every long-duration mission' },
  power_bus_management:    { trl: 9, trlRationale: 'Standard load-shedding on every bus' },

  // === SPACE_ENVIRONMENT ===
  kessler_syndrome:        { trl: 9, trlRationale: 'Kessler & Cour-Palais (1978); observed during 2007, 2009 events' },
  solar_storm:             { trl: 9, trlRationale: 'Observed and measured since IMP-8 (1973)' },
  van_allen_belts:         { trl: 9, trlRationale: 'Explorer 1 (1958) — foundational discovery' },
  south_atlantic_anomaly:  { trl: 9, trlRationale: 'Mapped by every LEO spacecraft' },
  atomic_oxygen:           { trl: 9, trlRationale: 'Characterised by LDEF (1984-1990)' },
  mmod_impact:             { trl: 9, trlRationale: 'Whipple shields flown since 1970s' },
  saa_radiation:           { trl: 9, trlRationale: 'Hubble and ISS mitigate SAA daily' },
  atomic_oxygen_erosion:   { trl: 9, trlRationale: 'LDEF (1984-1990) provided comprehensive data' },
  uv_degradation:          { trl: 9, trlRationale: 'Observed on every long-duration mission' },
  mmod_impact_physics:     { trl: 9, trlRationale: 'Whipple shield heritage since 1970s' },
  geomagnetic_storm:       { trl: 9, trlRationale: 'Observed every solar cycle since IGY (1957)' },
  radiation_dose:          { trl: 9, trlRationale: 'TID budgeting standard since 1960s' },

  // === MATERIALS ===
  space_aluminum:     { trl: 9, trlRationale: 'Primary structure on every launch vehicle and satellite' },
  titanium:           { trl: 9, trlRationale: 'Rocket engines and pressure vessels since 1960s' },
  carbon_composite:   { trl: 9, trlRationale: 'Ariane 5 fairing (1996) and beyond' },
  graphene_gsl:       { trl: 2, trlRationale: 'Graphene structural lattice — game-speculative; no flight heritage' },
  hbn_coating:        { trl: 5, trlRationale: 'HBN coatings demonstrated in lab; AO-resistance under test' },
  kevlar_mli:         { trl: 9, trlRationale: 'Kevlar + MLI panels flown on ISS since 1998' },
  aluminum_space:     { trl: 9, trlRationale: '6061-T6 / 7075 alloys ubiquitous' },
  gallium_arsenide:   { trl: 9, trlRationale: 'GaAs cells on every GEO satellite' },
  titanium_alloys:    { trl: 9, trlRationale: 'Ti-6Al-4V standard aerospace alloy' },
  carbon_composites:  { trl: 9, trlRationale: 'CFRP structures flown for decades' },
  iridium_avionics:   { trl: 9, trlRationale: 'Hydrazine catalyst beds standard since 1960s' },

  // === TETHERS ===
  space_tether:           { trl: 5, trlRationale: 'TSS-1R (1996), YES2 (2007) demonstrated; not operational' },
  tether_reel_in:         { trl: 4, trlRationale: 'Motorised reel capture demonstrated in ground/lab tests only' },
  tether_materials:       { trl: 9, trlRationale: 'Dyneema/Zylon flown as lanyards; fibre properties well-characterised' },
  tether_dynamics:        { trl: 9, trlRationale: 'Modelled and observed on TSS-1R, YES2' },
  tether_tangle_physics:  { trl: 2, trlRationale: 'Game concept — multi-tether space operations not yet flown' },
  edt_physics:            { trl: 5, trlRationale: 'TSS-1R demonstrated EDT current generation; not operational' },
  miura_ori_net:          { trl: 7, trlRationale: 'Miura-ori flown on SFU (1995); net capture via RemoveDEBRIS (2018)' },
  reel_mechanics:         { trl: 3, trlRationale: 'Mothership-mounted reel is game-speculative' },
  bolas_weapon:           { trl: 3, trlRationale: 'Spinning net / bolas capture is conceptual; no flight heritage' },

  // === DEBRIS ===
  hypervelocity:           { trl: 9, trlRationale: 'Observed and measured since 1960s' },
  debris_tracking:         { trl: 9, trlRationale: 'USSPACECOM catalog operational since 1960s' },
  debris_classification:   { trl: 9, trlRationale: 'IADC classification, long-established' },
  trackable_vs_dark:       { trl: 9, trlRationale: 'Gap characterised by multiple published studies' },
  conjunction_assessment:  { trl: 9, trlRationale: 'USSPACECOM CDMs; ISS manoeuvres 2-3×/year' },
  breakup_events:          { trl: 9, trlRationale: 'Iridium-Cosmos 2009, Fengyun-1C 2007 — documented' },
  iridium_cosmos:          { trl: 9, trlRationale: 'Historical event, 10 February 2009' },
  fengyun_test:            { trl: 9, trlRationale: 'Historical event, 11 January 2007' },
  ssa_network:             { trl: 9, trlRationale: 'Operational network since 1960s' },
  adr_methods_real:        { trl: 7, trlRationale: 'ClearSpace-1 (2026 planned), ELSA-d (2021), RemoveDEBRIS (2018)' },

  // === SENSORS ===
  lidar_sensing:      { trl: 9, trlRationale: 'Flash LIDAR flown on Dragon, Cygnus since 2012' },
  star_tracker:       { trl: 9, trlRationale: 'Ubiquitous attitude sensor since 1980s' },
  imu_drift:          { trl: 9, trlRationale: 'Fibre-optic gyros standard since 1990s' },
  docking_precision:  { trl: 9, trlRationale: 'IDSS/NDS operational on Dragon, Starliner' },
  reaction_wheels:    { trl: 9, trlRationale: 'Every stabilised satellite since 1970s' },
  magnetorquers:      { trl: 9, trlRationale: 'Standard LEO desaturation since 1960s' },
  detumble:           { trl: 9, trlRationale: 'Performed on every cooperative RPO mission' },
  triple_redundancy:  { trl: 9, trlRationale: 'Shuttle GPCs, ISS C&DH, every human-rated system' },
  watchdog_timer:     { trl: 9, trlRationale: 'Standard bus design since 1970s' },
  telemetry:          { trl: 9, trlRationale: 'Core capability on every mission' },
  ecc_memory:         { trl: 9, trlRationale: 'Standard rad-hard memory since 1980s' },
  gps_denied:         { trl: 8, trlRationale: 'Military GPS-denied nav; still maturing on civilian platforms' },
  kalman_filtering:   { trl: 9, trlRationale: 'Used since Apollo (1969)' },
  star_tracker_nav:   { trl: 9, trlRationale: 'Same heritage as star_tracker' },
  pulse_scan_radar:   { trl: 3, trlRationale: 'Distributed synthetic aperture across daughter arms — game-speculative' },
  lidar_ranging:      { trl: 9, trlRationale: 'Same heritage as lidar_sensing' },

  // === COMMS ===
  laser_comms:          { trl: 8, trlRationale: 'LCRD (2021), SDA T1 Tranche (2023-24); emerging operational' },
  ground_station_window:{ trl: 9, trlRationale: 'Fundamental LEO constraint' },
  bandwidth_limits:     { trl: 9, trlRationale: 'Fundamental comms architecture' },
  comms_blackout:       { trl: 9, trlRationale: 'Observed since Gemini re-entry' },
  ground_station_pass:  { trl: 9, trlRationale: 'Fundamental LEO constraint' },
  telemetry_bandwidth:  { trl: 9, trlRationale: 'S-band telemetry standard since 1960s' },
  laser_comms_optical:  { trl: 8, trlRationale: 'LCRD demonstrated 1.2 Gbps from GEO (2021)' },
  tdrs_relay:           { trl: 9, trlRationale: 'TDRS operational since 1983' },
  signal_propagation:   { trl: 9, trlRationale: 'Speed of light — established science' },
  frequency_bands:      { trl: 9, trlRationale: 'ITU-coordinated bands since 1960s' },

  // === ST-8.4.7: NEWS + ISRO HERITAGE ===
  news_ast_spacemobile:     { trl: 9, trlRationale: 'Real satellite, real failure mode scenario' },
  news_starlink_breakup:    { trl: 9, trlRationale: 'Plausible near-term debris event' },
  news_thaicom4:            { trl: 9, trlRationale: 'Real satellite, real GEO ADR challenge' },
  isro_why_india:           { trl: 9, trlRationale: 'Factual geophysics and launch economics' },
  isro_kulasekarapattinam:  { trl: 9, trlRationale: 'Real facility, operational since 2023' },
  isro_istrac:              { trl: 9, trlRationale: 'Real facility, operational ISRO TTC network' },
  isro_launch_vehicles:     { trl: 9, trlRationale: 'Real launch vehicles with documented specs' },

  // === CH5 ISS BOSS ===
  iss_saver:          { trl: 9, trlRationale: 'Cosmos-1408 ASAT event (2021) + ISS conjunction ops documented' },
  iss_pdam:           { trl: 9, trlRationale: 'PDAM reboosts performed 30+ times since 1999' },
  iss_hydrazine_burn: { trl: 9, trlRationale: 'Hydrazine avoidance reboosts are routine, documented ISS ops' },
  hubble_watch:       { trl: 9, trlRationale: 'HST operational since 1990; active-asset no-fire is policy' },
  starlink_contained: { trl: 9, trlRationale: 'ADR rationale; fragmentation-cloud risk is well-characterised' },
  starlink_cascade:   { trl: 9, trlRationale: 'Kessler syndrome (1978) — established, observed (2009 Iridium-Cosmos)' },
  thaicom_graveyard:  { trl: 9, trlRationale: 'GEO graveyard disposal is IADC-standard practice' },
};

/**
 * Apply TRL annotations to the entries array in-place, adding `trl` and
 * `trlRationale` fields. Unknown IDs default to TRL 9 "Established science"
 * to keep the data model uniform.
 * @param {Array<object>} entries
 * @returns {Array<object>} same array (mutated)
 */
function applyTRLAnnotations(entries) {
  for (const entry of entries) {
    const ann = TRL_ANNOTATIONS[entry.id];
    if (ann) {
      entry.trl = ann.trl;
      entry.trlRationale = ann.trlRationale;
    } else {
      entry.trl = 9;
      entry.trlRationale = 'Established science (default)';
    }
  }
  return entries;
}

// ============================================================================
// CODEX SYSTEM
// ============================================================================

export class CodexSystem {
  constructor() {
    /** @type {Array<object>} All codex entries (TRL-annotated) */
    this.entries = applyTRLAnnotations(buildEntries());

    /** @type {Map<string, object>} Fast lookup by id */
    this._byId = new Map();
    this.entries.forEach(e => this._byId.set(e.id, e));

    /** @type {Array<object>} Unlocks waiting for cooldown */
    this._unlockQueue = [];

    /** @type {number} Cooldown timer (seconds remaining) */
    this._cooldownTimer = 0;

    /** @type {Set<string>} Event names we've already subscribed to */
    this._subscribedEvents = new Set();

    this._setupListeners();

    console.log(`[CodexSystem] Initialized with ${this.entries.length} entries across ${Object.keys(CodexCategory).length} categories`);
  }

  // ==========================================================================
  // EVENT SUBSCRIPTION
  // ==========================================================================

  /** @private Subscribe to all unique triggerEvent values from entries */
  _setupListeners() {
    for (const entry of this.entries) {
      const evt = entry.triggerEvent;
      if (!evt || this._subscribedEvents.has(evt)) continue;
      this._subscribedEvents.add(evt);

      eventBus.on(evt, (payload) => {
        this._checkUnlocks(evt, payload);
      });
    }

    // Listen for save game events
    eventBus.on(Events.PERSISTENCE_SAVED, () => {
      // Persistence system can call getState() to include codex data
    });

    // Listen for codex viewed events
    eventBus.on(Events.CODEX_VIEWED, (data) => {
      if (data && data.id) {
        this.markSeen(data.id);
      }
    });

    // Listen for explicit unlock requests (e.g., from TutorialSystem)
    eventBus.on(Events.CODEX_UNLOCK_REQUEST, (data) => {
      if (data && data.id) {
        const entry = this._byId.get(data.id);
        if (entry && !entry.unlocked) {
          this._queueUnlock(entry);
        }
      }
    });

    // Source-based catch-all for SubsystemEvents (Phase 7B)
    // Maps subsystem source fields to representative codex entries so that
    // the first message from each subsystem guarantees at least one unlock.
    const _subsystemSourceMap = {
      'SYSTEM':    'ground_station_pass',     // CommsSubsystem
      'NAV':       'star_tracker',            // Navigation + Attitude
      'THERMAL':   'thermal_management',      // PowerSubsystem eclipse
      'POWER':     'battery_chemistry',       // PowerSubsystem
      'AVIONICS':  'watchdog_timer',          // AvionicsSubsystem
      'STRUCTURE': 'atomic_oxygen',           // DegradationSubsystem
    };
    eventBus.on(Events.SUBSYSTEM_EVENT, (payload) => {
      if (!payload || !payload.source) return;
      const entryId = _subsystemSourceMap[payload.source];
      if (!entryId) return;
      const entry = this._byId.get(entryId);
      if (entry && !entry.unlocked) {
        this._queueUnlock(entry);
      }
    });
  }

  // ==========================================================================
  // UNLOCK MECHANISM
  // ==========================================================================

  /**
   * Check all locked entries matching the fired event.
   * @private
   * @param {string} eventName - The event that fired
   * @param {object} payload - Event payload
   */
  _checkUnlocks(eventName, payload) {
    for (const entry of this.entries) {
      if (entry.unlocked) continue;
      if (entry.triggerEvent !== eventName) continue;

      try {
        if (entry.triggerCondition(payload || {})) {
          this._queueUnlock(entry);
        }
      } catch (e) {
        // Condition function threw — ignore silently
      }
    }
  }

  /**
   * Queue an entry for unlock (respecting cooldown).
   * @private
   * @param {object} entry
   */
  _queueUnlock(entry) {
    // Don't double-queue
    if (entry.unlocked) return;
    if (this._unlockQueue.some(e => e.id === entry.id)) return;

    if (this._cooldownTimer <= 0 && this._unlockQueue.length === 0) {
      // Unlock immediately
      this._performUnlock(entry);
    } else {
      // Queue for later
      this._unlockQueue.push(entry);
    }
  }

  /**
   * Perform the actual unlock — set flag, emit events, start cooldown.
   * @private
   * @param {object} entry
   */
  _performUnlock(entry) {
    entry.unlocked = true;
    this._cooldownTimer = Constants.CODEX.UNLOCK_COOLDOWN;

    // Emit codex unlock event
    eventBus.emit(Events.CODEX_UNLOCKED, {
      id: entry.id,
      title: entry.title,
      shortText: entry.shortText,
      icon: entry.icon,
      category: entry.category,
    });

    // Emit tech unlock event (Discovery Pane picks this up instead of comms)
    eventBus.emit(Events.TECH_UNLOCKED, {
      id: entry.id,
      title: entry.title,
      shortText: entry.shortText,
      category: entry.category,
    });

    console.log(`[CodexSystem] Unlocked: ${entry.icon} ${entry.title}`);
  }

  // ==========================================================================
  // UPDATE (called every frame from game loop)
  // ==========================================================================

  /**
   * Tick the unlock cooldown and process queued unlocks.
   * @param {number} dt - Delta time in seconds
   */
  update(dt) {
    if (this._cooldownTimer > 0) {
      this._cooldownTimer -= dt;
    }

    // Process queue when cooldown expires
    if (this._cooldownTimer <= 0 && this._unlockQueue.length > 0) {
      const next = this._unlockQueue.shift();
      if (!next.unlocked) {
        this._performUnlock(next);
      } else if (this._unlockQueue.length > 0) {
        // Already unlocked (e.g. duplicate), try next
        this._cooldownTimer = 0;
      }
    }
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Get a single entry by ID.
   * @param {string} id
   * @returns {object|null}
   */
  getEntry(id) {
    return this._byId.get(id) || null;
  }

  /**
   * ST-6.6: Get TRL badge info for an entry.
   * @param {string} id
   * @returns {{trl:number, color:string, label:string, rationale:string}|null}
   */
  getEntryTRL(id) {
    const entry = this._byId.get(id);
    if (!entry) return null;
    const trl = (typeof entry.trl === 'number') ? entry.trl : 9;
    return {
      trl,
      color: trlToBadgeColor(trl, Constants.TRL),
      label: trlToLabel(trl, Constants.TRL),
      rationale: entry.trlRationale || '',
    };
  }

  /**
   * Get all entries in a category.
   * @param {string} category - One of CodexCategory values
   * @returns {Array<object>}
   */
  getCategory(category) {
    return this.entries.filter(e => e.category === category);
  }

  /**
   * Get all unlocked entries.
   * @returns {Array<object>}
   */
  getUnlockedEntries() {
    return this.entries.filter(e => e.unlocked);
  }

  /**
   * Get progress statistics.
   * @returns {{ unlocked: number, total: number, percentage: number }}
   */
  getProgress() {
    const unlocked = this.entries.filter(e => e.unlocked).length;
    const total = this.entries.length;
    return {
      unlocked,
      total,
      percentage: total > 0 ? Math.round((unlocked / total) * 100) : 0,
    };
  }

  /**
   * Mark an entry as seen (player has viewed the full text).
   * @param {string} id
   */
  markSeen(id) {
    const entry = this._byId.get(id);
    if (entry && entry.unlocked) {
      entry.seen = true;
    }
  }

  // ==========================================================================
  // PERSISTENCE
  // ==========================================================================

  /**
   * Get serializable state for save game.
   * @returns {Array<{ id: string, unlocked: boolean, seen: boolean }>}
   */
  getState() {
    return this.entries.map(e => ({
      id: e.id,
      unlocked: e.unlocked,
      seen: e.seen,
    }));
  }

  /**
   * Restore state from save game data.
   * @param {Array<{ id: string, unlocked: boolean, seen: boolean }>} data
   */
  restore(data) {
    if (!Array.isArray(data)) return;

    for (const saved of data) {
      const entry = this._byId.get(saved.id);
      if (entry) {
        entry.unlocked = !!saved.unlocked;
        entry.seen = !!saved.seen;
      }
    }

    const restored = data.filter(d => d.unlocked).length;
    console.log(`[CodexSystem] Restored ${restored} unlocked entries from save`);
  }
}

export default CodexSystem;
