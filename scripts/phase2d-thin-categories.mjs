#!/usr/bin/env node
// Phase 2d — fill the thinnest categories with verified, sourced reference
// content: +5 ATTITUDE, +5 AVIONICS, +5 WORLD_INDUSTRY, +3 HERITAGE, +2 SENSORS
// (20 entries → 175 total). Idempotent (upsert by id) and order-independent.
//
// Facts verified against Wikipedia / NASA / ESA / FCC / SpaceNews (see session
// notes). Voice rules: acronyms spelled out on first use; humor only in the
// shortText hook, never in fullText physics / formula / trlRationale.
//
// `related` links are made bidirectional automatically: after upserting, every
// id referenced by a new entry gets a reciprocal back-link (idempotent — guarded
// by includes()). WORLD_INDUSTRY entries are startUnlocked reference material
// (no trigger needed); the rest are discovery tech (triggers in codexTriggers.js).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'data/codex.json');
const codex = JSON.parse(readFileSync(path, 'utf8'));

const NEW_ENTRIES = [
  // ============================ ATTITUDE ============================
  {
    id: 'attitude_control_system', category: 'ATTITUDE', trl: 9, icon: '🧭',
    related: ['star_tracker', 'reaction_wheels', 'control_moment_gyroscope', 'kalman_filtering', 'sun_sensor'],
    i18n: {
      title: 'Attitude Determination & Control (ADCS)',
      shortText: 'Two questions, asked thousands of times a second: which way am I pointing, and which way do I want to point?',
      fullText: "The attitude determination and control system (ADCS) is the loop that keeps a spacecraft aimed. First it *determines* orientation by fusing sensors — star trackers, sun sensors, and a gyroscope-based inertial measurement unit (IMU) — usually through a Kalman filter that blends their noisy readings into one best estimate. Then it *controls* orientation with actuators: reaction wheels and control moment gyroscopes for smooth fine pointing, magnetorquers and thrusters for resets and large moves. Aiming a telescope, pointing an antenna at a ground station, or lining up to grab a tumbling derelict all run through the ADCS.",
      realWorld: 'Standard on every three-axis-stabilised spacecraft',
      trlRationale: 'Universal on three-axis-stabilised spacecraft',
      unlockHint: 'Clear debris and read the attitude suite.',
    },
  },
  {
    id: 'control_moment_gyroscope', category: 'ATTITUDE', trl: 9, icon: '🌀',
    related: ['reaction_wheels', 'momentum_dumping', 'attitude_control_system', 'detumble'],
    i18n: {
      title: 'Control Moment Gyroscopes',
      shortText: 'A spinning wheel on a gimbal: tilt it, and the whole spacecraft swings. The muscle behind steering a station without firing a thruster.',
      fullText: "A control moment gyroscope (CMG) spins a heavy rotor at constant speed, then tilts that rotor on a gimbal. Changing the *direction* of the rotor's angular momentum exerts a large gyroscopic torque on the spacecraft — far more than a reaction wheel of similar mass, for a fraction of the power. The International Space Station holds its attitude with four CMGs on its Z1 truss; Skylab pioneered them in 1973, and the Salyut and Mir stations used the same idea (the crews called them 'gyrodynes'). The catch is geometry: certain gimbal angles line up into 'singularities' where the cluster briefly produces no useful torque, so the steering software works constantly to avoid them.",
      realWorld: 'ISS: 4 CMGs on the Z1 truss (since 2000); Skylab (1973) first; Mir flew 18 gyrodynes',
      formula: 'τ = H · θ̇   (output torque = rotor momentum × gimbal rate)',
      trlRationale: 'Flown on Skylab, Salyut, Mir, ISS, Tiangong',
      unlockHint: 'Clear debris and read the attitude suite.',
    },
  },
  {
    id: 'rcs_attitude_control', category: 'ATTITUDE', trl: 9, icon: '💨',
    related: ['cold_gas_rcs', 'momentum_dumping', 'detumble', 'rendezvous'],
    i18n: {
      title: 'Thruster Attitude Control (RCS)',
      shortText: 'Fire two small thrusters in opposite directions and the craft spins in place — crude, fast, and strong enough to stop a bad tumble.',
      fullText: "A reaction control system (RCS) is a set of small thrusters arranged so that firing them in balanced, opposing pairs produces a pure rotation — a torque with no net push — letting the spacecraft turn without drifting off course. Thrusters deliver far more torque than wheels or magnetorquers, so they handle the heavy jobs: large fast slews, arresting a dangerous tumble, and dumping momentum when the wheels saturate. The price is propellant, which is finite, so thrusters do the 'coarse' work while wheels and gyroscopes handle the steady, fuel-free fine pointing.",
      realWorld: 'Reaction control thrusters have flown since Mercury and Gemini; the ISS burns propellant when its CMGs saturate during spacewalks',
      trlRationale: 'Reaction control thrusters since the 1960s',
      unlockHint: 'Clear debris and read the attitude suite.',
    },
  },
  {
    id: 'momentum_dumping', category: 'ATTITUDE', trl: 9, icon: '♻️',
    related: ['reaction_wheels', 'control_moment_gyroscope', 'magnetorquers', 'rcs_attitude_control'],
    i18n: {
      title: 'Momentum Dumping (Desaturation)',
      shortText: "Wheels that soak up disturbance torques eventually spin flat-out. To reset them you have to bleed the momentum off against something external.",
      fullText: "Reaction wheels and control moment gyroscopes (CMGs) hold a spacecraft steady by absorbing the small, relentless disturbance torques of orbit — drag, sunlight pressure, gravity gradient. But that stored momentum has nowhere to go: the wheels spin ever faster (or the CMG gimbals creep toward their limits) until they 'saturate' and can absorb no more. To reset them, the spacecraft applies an external torque to dump the excess — magnetorquers pushing against Earth's magnetic field, reaction-control thrusters, or even the gravity-gradient torque itself. The Space Station prefers the gravity-gradient route because it costs no propellant.",
      realWorld: 'ISS desaturates its CMGs using gravity-gradient torque (no propellant); zero-propellant 90°/180° turns demonstrated 2006–2007',
      trlRationale: 'Routine on every momentum-managed spacecraft',
      unlockHint: 'Clear debris and read the attitude suite.',
    },
  },
  {
    id: 'gravity_gradient_stabilization', category: 'ATTITUDE', trl: 9, icon: '📐',
    related: ['control_moment_gyroscope', 'magnetorquers', 'attitude_control_system'],
    i18n: {
      title: 'Gravity-Gradient Stabilization',
      shortText: 'Gravity is very slightly stronger at your low end than your high end. Give a satellite a long axis and it hangs upright on its own — no power.',
      fullText: "Gravity weakens with altitude, so the lower end of a long spacecraft feels a fraction more pull than the upper end. That tiny difference produces a torque that swings the long axis toward the local vertical (straight up-and-down relative to Earth) and holds it there — a free, passive way to keep one face pointed at the planet. Early satellites used long gravity-gradient booms to exploit it, and many small satellites still do. It is gentle and only loosely controls two axes, so it is usually paired with a damper to bleed off slow wobble, or with magnetorquers for finer pointing.",
      realWorld: 'Used since the 1960s; the same gravity-gradient torque also desaturates the ISS CMGs',
      formula: 'τ_gg = (3μ / r³) · (I_max − I_min) · sin 2θ',
      trlRationale: 'Passive method flown since the 1960s',
      unlockHint: 'Clear debris and read the attitude suite.',
    },
  },

  // ============================ AVIONICS ============================
  {
    id: 'onboard_computer', category: 'AVIONICS', trl: 9, icon: '📟',
    related: ['rad_hard_processor', 'spacewire_bus', 'watchdog_timer', 'telemetry', 'fdir'],
    i18n: {
      title: 'Command & Data Handling (C&DH)',
      shortText: 'The on-board computer is mission control’s hands when mission control is out of radio range — which is most of the time.',
      fullText: "The command and data handling (C&DH) system is the spacecraft's central computer: it receives and executes commands from the ground, runs the flight software, gathers data from every subsystem, and packages it for downlink. Because a satellite is only in contact with a ground station for a few minutes per orbit, the C&DH must run the vehicle autonomously the rest of the time — sequencing events, watching for faults, and keeping the craft safe until the next pass. It talks to the other boxes over standardised data buses so that hardware from different builders can interoperate.",
      realWorld: 'Runs the flight software and autonomy between ground-station passes',
      trlRationale: 'Core of every modern spacecraft',
      unlockHint: 'Clear debris and read the avionics suite.',
    },
  },
  {
    id: 'rad_hard_processor', category: 'AVIONICS', trl: 9, icon: '🧠',
    related: ['single_event_effects', 'ecc_memory', 'radiation_dose', 'triple_redundancy'],
    i18n: {
      title: 'Radiation-Hardened Processors',
      shortText: 'The brain steering a billion-dollar probe runs slower than a 1990s desktop — on purpose. Out here, surviving radiation beats raw speed.',
      fullText: "Space radiation flips bits and can latch up and destroy an ordinary chip, so spacecraft fly processors built to survive it rather than to win benchmarks. The workhorse is BAE Systems' RAD750, a radiation-hardened central processing unit (CPU) running roughly 110–200 MHz that tolerates an enormous total radiation dose; it flies on the Curiosity and Perseverance Mars rovers and on the James Webb Space Telescope. It costs orders of magnitude more than a consumer chip and is years behind in speed, but it keeps computing where a laptop processor would crash or die. Reliability is the feature.",
      realWorld: 'BAE Systems RAD750 (~118 MHz on JWST); flies on Curiosity, Perseverance, JWST; tolerates ~200k–1M rad',
      trlRationale: 'RAD750 flown since 2005',
      unlockHint: 'Clear debris and read the avionics suite.',
    },
  },
  {
    id: 'single_event_effects', category: 'AVIONICS', trl: 9, icon: '☢️',
    related: ['ecc_memory', 'rad_hard_processor', 'triple_redundancy', 'radiation_dose'],
    i18n: {
      title: 'Single-Event Effects',
      shortText: 'One cosmic ray, one flipped bit. Usually harmless, occasionally fatal — the reason flight software never fully trusts its own memory.',
      fullText: "When a single energetic particle — a cosmic ray or a solar proton — strikes a chip, it can deposit enough charge to cause a single-event effect (SEE). The mildest is a single-event upset (SEU): one bit silently flips, corrupting a number or an instruction. Worse is a single-event latch-up (SEL), a short circuit that can burn out the device unless power is cycled quickly. A single-event transient (SET) is a brief voltage glitch that can ripple through the logic. These are why spacecraft layer on error-correcting memory, watchdog timers, and redundancy — the hardware assumes the universe will occasionally reach in and change a one to a zero.",
      realWorld: 'SEU = bit flip; SEL = potentially destructive latch-up; SET = logic glitch (standard SEE taxonomy)',
      trlRationale: 'Well-characterised since the 1970s',
      unlockHint: 'Clear debris and read the avionics suite.',
    },
  },
  {
    id: 'spacewire_bus', category: 'AVIONICS', trl: 9, icon: '🔌',
    related: ['onboard_computer', 'telemetry', 'telemetry_bandwidth'],
    i18n: {
      title: 'Spacecraft Data Buses',
      shortText: 'Before boxes from five different builders can fly together, they have to agree on how to talk. Space has its own wiring standards for that.',
      fullText: "A spacecraft is a network of separate boxes — computer, sensors, radios, power — that must exchange commands and data reliably, so the industry standardises the wiring. MIL-STD-1553, a 1-megabit-per-second military data bus from the 1970s, is still flown for its ruggedness and predictable timing. SpaceWire, a faster network standard coordinated by the European Space Agency (ESA), carries high-rate instrument data on many modern missions. Standard buses let a builder integrate hardware from many suppliers without rewiring the whole vehicle — the same reason desktop computers settled on USB.",
      realWorld: 'MIL-STD-1553 (1 Mbit/s, 1970s); SpaceWire (ESA/ECSS standard) flown on NASA, ESA, JAXA missions',
      trlRationale: 'MIL-STD-1553 and SpaceWire flown for decades',
      unlockHint: 'Clear debris and read the avionics suite.',
    },
  },
  {
    id: 'fdir', category: 'AVIONICS', trl: 9, icon: '🛟',
    related: ['watchdog_timer', 'triple_redundancy', 'onboard_computer', 'single_event_effects'],
    i18n: {
      title: 'FDIR & Safe Mode',
      shortText: 'When something breaks and the ground is over the horizon, the spacecraft has to save itself — so it’s built to assume the worst and wait.',
      fullText: "Fault detection, isolation, and recovery (FDIR) is the spacecraft's self-preservation reflex. Onboard monitors watch for trouble — a sensor reading out of range, a subsystem drawing too much current, a computer that stops responding. When FDIR detects a fault it isolates the suspect part and takes recovery action, often dropping into 'safe mode': a stripped-down survival state that points the solar panels at the Sun, keeps the craft warm and powered, and calls home for instructions. Safe mode has rescued countless missions by buying time until engineers on the ground can diagnose the problem.",
      realWorld: "Standard ESA/NASA fault-management practice; 'safe mode' is the canonical survival state",
      trlRationale: 'Standard on all modern spacecraft',
      unlockHint: 'Clear debris and read the avionics suite.',
    },
  },

  // ========================= WORLD_INDUSTRY ========================= (start-unlocked reference)
  {
    id: 'world_the_rules', category: 'WORLD_INDUSTRY', icon: '⚖️', startUnlocked: true,
    related: ['world_adr_mandate', 'world_liability', 'world_who_removes'],
    i18n: {
      title: 'The Rules of the Road',
      shortText: "You can't just grab a dead satellite and keep it — half-century-old treaties say it still belongs to whoever launched it.",
      fullText: "Space has law, and it is old. The Outer Space Treaty, in force since 1967, says the state that launches an object keeps jurisdiction and control over it — even after it dies. That single rule shapes the whole debris-removal business: you cannot legally salvage someone else's derelict without permission, so every cleanup mission needs the original owner's consent. The Liability Convention of 1972 adds teeth, making a launching state liable for damage its objects cause. The job you do — removal for hire, with the owner's blessing — exists precisely because the junk is never truly abandoned.",
      realWorld: 'Outer Space Treaty (in force 1967); Liability Convention (in force 1972)',
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'world_liability', category: 'WORLD_INDUSTRY', icon: '💸', startUnlocked: true,
    related: ['world_the_rules', 'world_adr_mandate', 'news_iss_pallet'],
    i18n: {
      title: 'Who Pays When It Falls',
      shortText: 'Only one country has ever been billed for a space crash — when a Soviet nuclear satellite scattered over Canada in 1978.',
      fullText: "Under the 1972 Liability Convention, a launching state is liable for damage its space objects cause on Earth or in the air. It has been formally invoked exactly once: in 1978 the Soviet satellite Kosmos 954, carrying a nuclear reactor, broke up over northern Canada and spread radioactive debris across thousands of square kilometres. Canada billed the USSR for the cleanup and was partly paid. As reentries grow more common — spent rocket stages, retired satellites, even station hardware — this half-century-old rule is the framework everyone reaches for when something lands where it shouldn't.",
      realWorld: 'Liability Convention (1972); sole claim filed: Kosmos 954 crash in Canada, 1978',
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'world_five_year_rule', category: 'WORLD_INDUSTRY', icon: '⏳', startUnlocked: true,
    related: ['world_adr_mandate', 'world_why_now', 'adr_methods_real'],
    i18n: {
      title: 'The Five-Year Rule',
      shortText: 'The old deal: clean up your dead satellite within 25 years. The new US deal: make it five. The leash just got a lot shorter.',
      fullText: "For decades the global guideline, set by the Inter-Agency Space Debris Coordination Committee (IADC), asked operators to remove a retired low-Earth-orbit satellite within 25 years — and it was voluntary. In 2022 the U.S. Federal Communications Commission (FCC) turned that into a rule and cut the limit to five years for satellites it licenses. The change reflects how crowded orbit has become: leaving thousands of dead spacecraft to decay for a quarter-century is no longer acceptable when new constellations add satellites by the thousand. Shorter deadlines mean more deliberate disposal — and more demand for the removal services you provide.",
      realWorld: 'IADC 25-year guideline (voluntary); FCC 5-year deorbit rule adopted 2022',
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'world_servicing', category: 'WORLD_INDUSTRY', icon: '🔧', startUnlocked: true,
    related: ['news_mev1_servicing', 'world_who_removes', 'docking_berthing'],
    i18n: {
      title: 'The Servicing Economy',
      shortText: 'Why throw away a satellite that just needs fuel? A new industry flies up to refuel, repair, and rebuild — and the same skills capture the dead ones.',
      fullText: "A growing business treats satellites as repairable assets rather than disposables. Known as on-orbit servicing, assembly, and manufacturing (OSAM), it covers refuelling a low satellite, towing one to a new orbit, or even building structures in space. The first commercial demonstration came in 2020, when Northrop Grumman's Mission Extension Vehicle docked to an aging Intelsat and became its new engine. The rendezvous-and-grab techniques that extend a working satellite's life are the very same ones used to capture a tumbling derelict — which is why servicing companies and debris-removal companies keep turning out to be the same companies.",
      realWorld: 'On-orbit servicing (OSAM); first commercial demo: Northrop Grumman MEV-1 + Intelsat 901, 2020',
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'world_sustainability_rating', category: 'WORLD_INDUSTRY', icon: '🌱', startUnlocked: true,
    related: ['world_who_tracks', 'world_why_now', 'world_the_rules'],
    i18n: {
      title: 'Scoring Good Behaviour',
      shortText: 'Orbit now has a credit score. Run a clean, trackable, deorbitable mission and you can earn a badge that says so.',
      fullText: "To reward operators who fly responsibly, a consortium convened through the World Economic Forum built the Space Sustainability Rating (SSR) — a voluntary score that grades a mission on how well it shares data, avoids collisions, plans its disposal, and keeps from adding debris. It was developed with the European Space Agency (ESA), the Massachusetts Institute of Technology (MIT), BryceTech, and the University of Texas at Austin, and is now operated from eSpace at the École Polytechnique Fédérale de Lausanne (EPFL) in Switzerland, which issued its first ratings in the early 2020s. It turns 'being a good citizen of orbit' into something measurable — and marketable.",
      realWorld: 'Space Sustainability Rating: WEF-initiated, built with ESA/MIT/BryceTech/UT-Austin; operated by eSpace (EPFL); first ratings early 2020s',
      unlockHint: 'Reach orbit.',
    },
  },

  // ============================ HERITAGE ============================
  {
    id: 'heritage_solar_max', category: 'HERITAGE', trl: 9, icon: '🛠️',
    related: ['news_mev1_servicing', 'world_servicing', 'docking_berthing', 'heritage_hubble_servicing'],
    i18n: {
      title: 'Solar Max — The First House Call',
      shortText: 'In 1984 a Space Shuttle crew caught a broken satellite, fixed it, and let it go again — the first repair job in orbit.',
      fullText: "The Solar Maximum Mission, launched in 1980 to study the Sun, lost its attitude control within a year. Rather than write it off, NASA sent the Space Shuttle Challenger to catch it. In April 1984, on mission STS-41-C, astronauts grappled the tumbling satellite, swapped out the faulty modules, and released it back to work — the first time a satellite was ever repaired in orbit. It proved that spacecraft could be serviced instead of discarded, planting the seed for Hubble's later rescues and for today's refuel-and-capture industry. Everything you do with a robotic arm has a lineage that runs back to this catch.",
      realWorld: 'Solar Maximum Mission; repaired on STS-41-C (Challenger), April 1984 — first on-orbit satellite repair',
      trlRationale: 'Demonstrated in orbit, 1984',
      unlockHint: 'Deliver mass to the elevator to unlock heritage briefings.',
    },
  },
  {
    id: 'heritage_ldef', category: 'HERITAGE', trl: 9, icon: '🧫',
    related: ['mmod_impact', 'atomic_oxygen', 'titanium_alloys', 'hypervelocity'],
    i18n: {
      title: 'LDEF — Six Years in the Open',
      shortText: 'A bus-sized satellite left exposed to space for nearly six years came home covered in tiny impact craters — the best debris study ever flown.',
      fullText: "The Long Duration Exposure Facility (LDEF) was a passive, bus-sized cylinder carrying 57 experiments, deployed by the Space Shuttle in April 1984 to see how materials, coatings, and electronics endure prolonged exposure to space. It was meant to be retrieved within a year, but Shuttle delays — including the Challenger accident — stranded it in orbit for nearly six years until Columbia recovered it in January 1990. It returned peppered with tens of thousands of micrometeoroid and debris impact craters, plus surfaces eroded by atomic oxygen, giving engineers their richest real-world dataset on the orbital debris environment and on how the harsh environment of low Earth orbit degrades hardware.",
      realWorld: 'LDEF deployed 6 Apr 1984 (STS-41-C), retrieved 12 Jan 1990 (STS-32); ~5.7 years; 57 experiments',
      trlRationale: 'Flight data returned 1990',
      unlockHint: 'Deliver mass to the elevator to unlock heritage briefings.',
    },
  },
  {
    id: 'heritage_hubble_servicing', category: 'HERITAGE', trl: 9, icon: '🔭',
    related: ['heritage_solar_max', 'world_servicing', 'jwst_horizon'],
    i18n: {
      title: 'Hubble — Saved Five Times',
      shortText: 'Launched with a famously flawed mirror, the most beloved telescope in history was rescued and upgraded by astronauts five separate times.',
      fullText: "When the Hubble Space Telescope reached orbit in 1990, its primary mirror had been ground to the wrong shape and its images were blurred. Instead of abandoning a flagship, NASA flew the first of five Space Shuttle servicing missions in December 1993 (STS-61), installing corrective optics that restored its sight. Four more visits — in 1997, 1999, 2002, and a final one in 2009 — replaced instruments, gyroscopes, and batteries, repeatedly rebuilding the telescope in place and extending its life by decades. Hubble is the proof of what on-orbit servicing can be worth: a spacecraft kept world-class for thirty-plus years by sending people up to fix it.",
      realWorld: 'Hubble (launched 1990); 5 Shuttle servicing missions: 1993, 1997, 1999, 2002, 2009',
      trlRationale: 'Five crewed servicing missions, 1993–2009',
      unlockHint: 'Deliver mass to the elevator to unlock heritage briefings.',
    },
  },

  // ============================= SENSORS ============================
  {
    id: 'sun_sensor', category: 'SENSORS', trl: 9, icon: '🌞',
    related: ['star_tracker', 'attitude_control_system', 'imu_drift', 'solar_power'],
    i18n: {
      title: 'Sun Sensors',
      shortText: "The cheapest, oldest trick in attitude control: look at the Sun. If you know where it is, you know which way you're facing.",
      fullText: "A sun sensor measures the direction to the Sun, giving the spacecraft a quick, reliable reference for which way it is pointing. Coarse sun sensors are little more than light detectors that report roughly where the Sun is — handy for spinning up out of a tumble or aiming solar panels. Fine sun sensors are far more precise and feed the attitude determination system. They are among the simplest, cheapest, and oldest attitude sensors, flown since the earliest satellites, and almost every spacecraft carries some form of them as a dependable backstop to fancier star trackers.",
      realWorld: 'Flown since the earliest satellites; coarse and fine variants on nearly every spacecraft',
      trlRationale: 'Flown since the dawn of the satellite era',
      unlockHint: 'Run scans (S / W) and read the sensor suite.',
    },
  },
  {
    id: 'pose_estimation', category: 'SENSORS', trl: 8, icon: '👁️',
    related: ['lidar_ranging', 'docking_precision', 'kalman_filtering', 'star_tracker'],
    i18n: {
      title: 'Visual Pose Estimation',
      shortText: 'Your target is tumbling, unlit, and was never built to be caught. A camera and clever math work out exactly how it’s oriented anyway.',
      fullText: "To grab a derelict, you first have to know precisely where it is and how it is tumbling — its full six-degrees-of-freedom 'pose' (position plus orientation). Cooperative spacecraft make this easy with markers or radio links, but debris is non-cooperative: no beacons, no markers, often spinning in shadow. Visual pose estimation solves it with cameras and algorithms that either match the live image to a 3-D model of the target or track its features frame by frame, recovering the relative pose in real time. It is the perception layer beneath any capture, and it is being actively developed and demonstrated for debris removal and satellite servicing.",
      realWorld: 'Vision-based relative navigation for non-cooperative targets; developed and demonstrated in ESA and JAXA debris-removal and servicing programs',
      trlRationale: 'Demonstrated in servicing/ADR programs; non-cooperative capture still maturing',
      unlockHint: 'Run scans (S / W) and read the sensor suite.',
    },
  },
];

// --- upsert by id (idempotent) ---
for (const ne of NEW_ENTRIES) {
  const i = codex.entries.findIndex((e) => e.id === ne.id);
  if (i >= 0) codex.entries[i] = ne;
  else codex.entries.push(ne);
}

// --- make every new-entry related link bidirectional (idempotent) ---
const byId = new Map(codex.entries.map((e) => [e.id, e]));
for (const ne of NEW_ENTRIES) {
  for (const rid of ne.related || []) {
    const target = byId.get(rid);
    if (!target) continue;
    target.related = target.related || [];
    if (!target.related.includes(ne.id)) target.related.push(ne.id);
  }
}

writeFileSync(path, JSON.stringify(codex, null, 2) + '\n', 'utf8');
const counts = {};
for (const e of codex.entries) counts[e.category] = (counts[e.category] || 0) + 1;
console.log('[phase2d] entries now', codex.entries.length,
  '| ATTITUDE', counts.ATTITUDE, 'AVIONICS', counts.AVIONICS,
  'WORLD_INDUSTRY', counts.WORLD_INDUSTRY, 'HERITAGE', counts.HERITAGE,
  'SENSORS', counts.SENSORS);
