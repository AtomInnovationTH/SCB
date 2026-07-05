#!/usr/bin/env node
// Phase 6c — Content batch C: MATERIALS (10) + ATTITUDE (8) + AVIONICS (9) +
// HERITAGE (10) + PROPULSION (17) to the deep-dive editorial template
// (see .kilo/plans/1782994412021-tech-library-deep-dive-overhaul.md §2).
//
// ATTITUDE/AVIONICS/PROPULSION already carried strong phase2/phase2d content, so
// this pass is largely polish: reflow into 2+ paragraphs, add realWorld where
// missing, fill related gaps, and rewrite unlock hints to concrete
// actions/observables that match each entry's real trigger (Part 2A). MATERIALS
// and HERITAGE (esp. the ISRO entries) get fuller rewrites.
//
// Same idempotent conventions as phase6a/6b: upsert by id; related made
// symmetric two ways (inbound-heal skipping PLAYBOOK, then reciprocation that
// also honours HEAL_SKIP_CATEGORIES). Facts web-verified where volatile
// (ISRO: PSLV 64 flights/59 successes — NOT an unbroken streak; LVM3 10 t to LEO;
// SSLV operational since 2024; Kulasekarapattinam under construction, first
// launch targeted late 2026; dropped the false "$30k/kg Western" comparison).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'data/codex.json');
const codex = JSON.parse(readFileSync(path, 'utf8'));

const NEW_ENTRIES = [
  // ============================== MATERIALS (10) ==============================
  {
    id: 'aluminum_space', category: 'MATERIALS', trl: 9, icon: '🔩',
    related: ['titanium_alloys', 'carbon_composites'],
    i18n: {
      title: 'Aluminum in Space',
      shortText: 'The default spacecraft metal, and roughly 40% of the debris mass in low orbit is aluminium alloy.',
      fullText: "Aluminium alloys, mostly 6061-T6 and 7075, dominate spacecraft construction because they are light, strong, cheap, easy to machine, and shrug off radiation. That ubiquity has a flip side: about 40% of the debris mass in low Earth orbit is aluminium, the metal that built the satellites now dead around you.\n\nThat makes it your bread-and-butter salvage. Aluminium re-melts cleanly, so the forge can take a captured strut or panel, run it through an electromagnetic levitation furnace, and cast it into new stock. It is the closest thing up here to a universal feedstock, turning yesterday's spacecraft into tomorrow's structure.",
      realWorld: 'Aircraft/spacecraft alloys 6061-T6 and 7075; ~40% of LEO debris mass is aluminium.',
      trlRationale: 'Ubiquitous aerospace structural metal.',
      unlockHint: 'Store salvaged aluminium in the Forge.',
    },
  },
  {
    id: 'carbon_composites', category: 'MATERIALS', trl: 9, icon: '🪶',
    related: ['cnt', 'graphene_gsl', 'titanium_alloys'],
    i18n: {
      title: 'Carbon Fiber Composites',
      shortText: 'Stiffer than steel at a fifth of the weight, but the cured polymer cannot be melted down and recast in orbit.',
      fullText: "Carbon-fibre reinforced polymer (CFRP) gives satellite structures and solar-panel substrates an exceptional stiffness-to-weight ratio, which is why so much modern hardware is built from it rather than metal. Fibres carry the load; a cured polymer matrix holds them in place.\n\nThat matrix is the catch for a salvager. Unlike aluminium, CFRP is a thermoset: once cured it cannot be re-melted and recast, so the forge cannot reflow it into new stock. It still has value as radiation-shielding mass or as structural patching material, but a captured composite panel is a fixed shape, not raw feedstock. Chemically it is the same carbon lattice as the nanotubes in your capture nets, just arranged differently.",
      realWorld: 'CFRP standard for satellite bus structures and solar-array substrates; thermoset matrix is not re-meltable.',
      trlRationale: 'Standard aerospace structural composite.',
      unlockHint: 'Store salvaged carbon composite in the Forge.',
    },
  },
  {
    id: 'gallium_arsenide', category: 'MATERIALS', trl: 9, icon: '☀️',
    related: ['multijunction_pv', 'solar_power', 'solar_cell_degradation'],
    i18n: {
      title: 'Gallium Arsenide Solar Cells',
      shortText: 'GaAs cells convert ~30% of sunlight and shrug off radiation — the gold standard for space power, at a gold-standard price.',
      fullText: "Gallium arsenide (GaAs) is the semiconductor of choice for space solar power. It converts around 30% of incident sunlight, close to double a silicon cell, and it tolerates radiation far better, which matters over a long mission. Nearly every high-value satellite flies GaAs multi-junction cells.\n\nThe drawback is cost: GaAs runs on the order of a hundred times more per watt than silicon. That flips the economics for a salvager, because a dead satellite's array is studded with a material worth far more than its mass in scrap aluminium. Your forge can recover gallium from captured panels, turning a derelict's wings into genuinely valuable feedstock.",
      realWorld: 'Space GaAs cells ~29-32% efficient and radiation-tolerant; ~100× the per-watt cost of silicon.',
      trlRationale: 'GaAs cells standard on GEO satellites and deep-space probes.',
      unlockHint: 'Store salvaged gallium in the Forge.',
    },
  },
  {
    id: 'graphene_gsl', category: 'MATERIALS', trl: 2, icon: '🕸️',
    related: ['cnt', 'carbyne', 'carbon_composites'],
    i18n: {
      title: 'Graphene Structural Lattice',
      shortText: 'A graphene-and-aramid net material, aiming for ~200× the strength of steel by weight to catch tumbling debris.',
      fullText: "Graphene structural lattice (GSL) is a proposed capture material: sheets of graphene backed by aramid fibre. On paper it reaches roughly 200 times the strength of steel by weight while staying flexible enough to absorb the impact energy of a tumbling target instead of shattering against it.\n\nThat combination is what a debris net wants, strength to hold and give to cushion. Your Weaver daughters deploy GSL nets rated to envelop objects up to about eight metres across. The material is early-stage, sharing the graphene lattice of carbon nanotubes but woven into a sheet; treat its rating as an engineering target, not flight-proven hardware.",
      realWorld: 'Speculative graphene/aramid capture net; extends real graphene strength research (no flight heritage).',
      trlRationale: 'Graphene sheet strength demonstrated in lab; woven capture lattice is speculative.',
      unlockHint: 'Capture a target with a Weaver daughter.',
    },
  },
  {
    id: 'hbn_coating', category: 'MATERIALS', trl: 5, icon: '🛡️',
    related: ['atomic_oxygen', 'mli_insulation', 'titanium_alloys'],
    i18n: {
      title: 'Hexagonal Boron Nitride Coating',
      shortText: 'A ceramic coating that shields spacecraft surfaces from the slow sandblasting of atomic oxygen in low orbit.',
      fullText: "Below about 700 km, single oxygen atoms erode exposed spacecraft surfaces at roughly a micrometre a year, quietly eating coatings, films, and optics. Hexagonal boron nitride (HBN) is a ceramic that forms a hard, chemically inert barrier against that attack.\n\nA thin HBN layer keeps solar panels, thermal blankets, and optical surfaces from fogging and degrading over a long exposure. Your mothership's exterior panels are HBN-coated for exactly this reason. It is the same erosion that ages the salvage you pull off old derelicts, which is part of why a scavenged surface rarely performs like a new one.",
      realWorld: 'HBN ceramic coatings resist atomic-oxygen erosion (~1 µm/yr below ~700 km); developed for LEO surface protection.',
      trlRationale: 'HBN coatings demonstrated; not yet ubiquitous flight hardware.',
      unlockHint: 'Take an atomic-oxygen erosion warning.',
    },
  },
  {
    id: 'iridium_avionics', category: 'MATERIALS', trl: 9, icon: '💎',
    related: ['iridium_cosmos', 'titanium_alloys'],
    i18n: {
      title: 'Iridium in Spacecraft',
      shortText: 'One of Earth\u2019s rarest metals, used in thruster catalysts and thermal coatings — and scattered by a famous 2009 collision.',
      fullText: "Iridium is among the rarest elements in Earth's crust, and it earns its place on spacecraft as a hydrazine-thruster catalyst and in high-temperature thermal coatings. A little goes a long way, so recovering it from salvage is disproportionately valuable.\n\nThe metal shares a name with the Iridium communications constellation, 66 satellites launched from 1997 to 2002, whose debris still carries recoverable components. One of them, Iridium 33, was destroyed in the 2009 collision with the derelict Cosmos 2251 that scattered more than 2,000 tracked fragments, a reminder that today's valuable hardware is tomorrow's hazard, and salvage.",
      realWorld: 'Iridium used as hydrazine-thruster catalyst and thermal coating; Iridium 33 lost in the 2009 Iridium-Cosmos collision.',
      trlRationale: 'Flight-proven catalyst and coating material.',
      unlockHint: 'Store salvaged iridium in the Forge.',
    },
  },
  {
    id: 'kevlar_mli', category: 'MATERIALS', trl: 9, icon: '🧥',
    related: ['mli_insulation', 'thermal_management', 'hypervelocity'],
    i18n: {
      title: 'Kevlar & MLI Shielding',
      shortText: 'Aramid fabric for micrometeoroid protection, layered with reflective blankets against the 300°C swing of sun to shadow.',
      fullText: "A spacecraft skin has two jobs the interior structure cannot do: hold off the temperature swing between sunlight and shadow, and stop small impactors. Multi-layer insulation blankets, thin aluminised film separated by spacers, handle the thermal side, cutting the heat exchange between a +150°C sunlit face and a -150°C shadowed one.\n\nBeneath the blankets, tough aramid fabric like Kevlar adds a bumper against micrometeoroids and small debris, catching and spreading a hit the way a bulletproof vest does. The International Space Station layers a dozen or more sheets of insulation over this kind of shielding across its exterior. Your salvaged blankets carry both the erosion and the impact scars of that duty.",
      realWorld: 'MLI (aluminised film) + aramid (Kevlar) micrometeoroid layers; the ISS uses 14+ MLI layers on exterior surfaces.',
      trlRationale: 'Standard spacecraft thermal + micrometeoroid protection.',
      unlockHint: 'Store salvaged Kevlar in the Forge.',
    },
  },
  {
    id: 'titanium_alloys', category: 'MATERIALS', trl: 9, icon: '⚙️',
    related: ['heritage_ldef', 'aluminum_space', 'carbon_composites'],
    i18n: {
      title: 'Titanium Aerospace Alloys',
      shortText: 'Ti-6Al-4V: half the weight of steel, corrosion-proof, and strong up past 400°C — the aerospace workhorse alloy.',
      fullText: "Titanium alloy Ti-6Al-4V is the workhorse where aluminium is too weak and steel too heavy. It holds its strength well above 400°C, resists corrosion including atomic-oxygen attack, and does it all at roughly half the density of steel, which is why it turns up in engine parts, thruster nozzles, and load-bearing satellite frames.\n\nFor a salvager that resilience is a gift. Titanium comes off a derelict already refined and formed, effectively pre-processed ore ready for the forge, and it has usually survived years in orbit better than the softer metals around it. A captured titanium fitting is some of the most useful mass you can bring home.",
      realWorld: 'Ti-6Al-4V in engines, nozzles, and frames; strong to ~400°C+ at ~half steel density; corrosion-resistant.',
      trlRationale: 'Ubiquitous aerospace structural alloy.',
      unlockHint: 'Store salvaged titanium in the Forge.',
    },
  },
  {
    id: 'cnt', category: 'MATERIALS', trl: 3, icon: '🧵',
    related: ['space_elevator', 'graphene_gsl', 'carbyne', 'carbon_composites'],
    i18n: {
      title: 'Carbon Nanotubes (CNT)',
      shortText: 'Roll a graphene sheet into a straw and you get the strongest fibre we can actually make — the leading space-elevator candidate.',
      fullText: "A carbon nanotube is a single graphene sheet rolled into a cylinder about a nanometre across. Individual multi-walled tubes have been pulled to tensile strengths around 11-63 gigapascals in the lab, dozens of times stronger than steel by weight, with a theoretical ceiling above 100 GPa.\n\nThe catch is length. Defect-free tubes are microscopic, and spinning them into metre-scale yarn loses most of that strength to slippage between tubes, so real CNT fibre today is short and imperfect. It remains the leading credible material for a space-elevator tether, and it shares its lattice with the graphene in your Weaver capture nets, the same chemistry in a different geometry.",
      realWorld: 'Space-elevator tether studies (NASA/ISEC); CNT yarns in aerospace composites; lab tubes 11-63 GPa.',
      formula: 'σ_measured ≈ 11-63 GPa  ·  σ_theoretical > 100 GPa',
      trlRationale: 'Short CNT fibres real; metre-scale high-strength yarn not yet achievable.',
      unlockHint: 'Clear 30 pieces of debris.',
    },
  },
  {
    id: 'carbyne', category: 'MATERIALS', trl: 1, icon: '💠',
    related: ['cnt', 'space_elevator', 'graphene_gsl'],
    i18n: {
      title: 'Carbyne — The Dream Tether',
      shortText: 'A single chain of carbon atoms, predicted to be the strongest material possible — and we can barely make a strand of it.',
      fullText: "Carbyne is linear acetylenic carbon: one chain of carbon atoms, alternating single and triple bonds. Calculations put its specific strength at roughly twice that of carbon nanotubes or graphene, which by that measure makes it the strongest material theoretically possible, the textbook dream cable for a space elevator.\n\nReality is humbling. Free carbyne is wildly unstable and reacts with itself on contact, so the longest chains ever made, in Vienna in 2016, ran about 6,000 atoms and survived only by being sealed inside double-walled nanotubes. It belongs in the codex as an honest TRL 1: spectacular on paper, and decades away from a usable cable.",
      realWorld: 'Confined carbyne synthesised inside nanotubes (Univ. Vienna, 2016, ~6,000-atom chains); no bulk material.',
      formula: 'predicted specific strength ≈ 2× CNT/graphene',
      trlRationale: 'Only confined ~6,000-atom chains synthesised; no free bulk carbyne.',
      unlockHint: 'Clear 45 pieces of debris.',
    },
  },

  // =============================== ATTITUDE (8) ===============================
  {
    id: 'attitude_control_system', category: 'ATTITUDE', trl: 9, icon: '🧭',
    related: ['star_tracker', 'reaction_wheels', 'control_moment_gyroscope', 'kalman_filtering', 'sun_sensor', 'gravity_gradient_stabilization'],
    i18n: {
      title: 'Attitude Determination & Control (ADCS)',
      shortText: 'Two questions, asked thousands of times a second: which way am I pointing, and which way do I want to point?',
      fullText: "The attitude determination and control system (ADCS) is the loop that keeps a spacecraft aimed. First it determines orientation by fusing sensors, star trackers, sun sensors, and a gyroscope-based inertial measurement unit, usually through a Kalman filter that blends their noisy readings into one best estimate.\n\nThen it controls orientation with actuators: reaction wheels and control moment gyroscopes for smooth fine pointing, magnetorquers and thrusters for resets and large moves. Aiming a telescope, pointing an antenna at a ground station, or lining up to grab a tumbling derelict all run through the ADCS. It is the sense of balance underneath every other thing your ship does.",
      realWorld: 'Standard on every three-axis-stabilised spacecraft; fuses sensors and actuators through a control loop.',
      trlRationale: 'Standard on every three-axis-stabilised spacecraft.',
      unlockHint: 'Clear 6 pieces of debris.',
    },
  },
  {
    id: 'reaction_wheels', category: 'ATTITUDE', trl: 9, icon: '🔄',
    related: ['attitude_control_system', 'control_moment_gyroscope', 'momentum_dumping'],
    i18n: {
      title: 'Reaction Wheels',
      shortText: 'Spin up a flywheel and the spacecraft turns the other way — propellant-free pointing by conservation of momentum.',
      fullText: "A reaction wheel is an electric motor spinning a heavy disc. Speed the disc up and, by conservation of angular momentum, the spacecraft rotates the opposite way; three wheels give full three-axis control with no propellant spent, just electricity.\n\nThe limit is saturation. Every disturbance the wheels absorb makes them spin a little faster, until they reach their maximum rate and can take no more. At that point they must be desaturated by applying an external torque, usually magnetorquers pushing against Earth's magnetic field. Wheels do the quiet, precise, fuel-free pointing; something external periodically bleeds off what they have stored.",
      realWorld: 'Reaction wheels provide propellant-free 3-axis control on most satellites; desaturated via magnetorquers or thrusters.',
      trlRationale: 'Ubiquitous fine-pointing actuator.',
      unlockHint: 'Fly until the mothership flags a reaction wheel.',
    },
  },
  {
    id: 'control_moment_gyroscope', category: 'ATTITUDE', trl: 9, icon: '🌀',
    related: ['reaction_wheels', 'momentum_dumping', 'attitude_control_system', 'detumble', 'gravity_gradient_stabilization'],
    i18n: {
      title: 'Control Moment Gyroscopes',
      shortText: 'A spinning wheel on a gimbal: tilt it and the whole spacecraft swings — the muscle behind steering a station.',
      fullText: "A control moment gyroscope (CMG) spins a heavy rotor at constant speed, then tilts that rotor on a gimbal. Changing the direction of the rotor's angular momentum exerts a large gyroscopic torque on the spacecraft, far more than a reaction wheel of similar mass and for a fraction of the power.\n\nThat leverage is why stations use them: the International Space Station holds attitude with four CMGs on its Z1 truss, Skylab pioneered them in 1973, and Mir flew the same idea. The catch is geometry. Certain gimbal angles line up into singularities where the cluster briefly produces no useful torque, so the steering software works constantly to route around them.",
      realWorld: 'ISS: 4 CMGs on the Z1 truss (since 2000); Skylab (1973) first; Mir flew 18 gyrodynes.',
      formula: 'τ = H · θ̇   (output torque = rotor momentum × gimbal rate)',
      trlRationale: 'Flown on Skylab, Mir, and the ISS.',
      unlockHint: 'Clear 16 pieces of debris.',
    },
  },
  {
    id: 'rcs_attitude_control', category: 'ATTITUDE', trl: 9, icon: '💨',
    related: ['cold_gas_rcs', 'momentum_dumping', 'detumble', 'rendezvous'],
    i18n: {
      title: 'Thruster Attitude Control (RCS)',
      shortText: 'Fire two small thrusters in opposite directions and the craft spins in place — crude, fast, and strong.',
      fullText: "A reaction control system (RCS) is a set of small thrusters arranged so that firing them in balanced, opposing pairs produces a pure rotation, a torque with no net push, letting the spacecraft turn without drifting off course.\n\nThrusters deliver far more torque than wheels or magnetorquers, so they take the heavy jobs: large fast slews, arresting a dangerous tumble, and dumping momentum when the wheels saturate. The price is propellant, which is finite, so thrusters do the coarse, urgent work while wheels and gyroscopes handle the steady, fuel-free fine pointing. Reaction thrusters have flown since Mercury and Gemini.",
      realWorld: 'RCS thrusters flown since Mercury and Gemini; the ISS burns propellant when its CMGs saturate during spacewalks.',
      trlRationale: 'Flown since the earliest crewed spacecraft.',
      unlockHint: 'Clear 12 pieces of debris.',
    },
  },
  {
    id: 'detumble', category: 'ATTITUDE', trl: 9, icon: '🌀',
    related: ['docking_berthing', 'control_moment_gyroscope', 'rcs_attitude_control', 'spin_stabilization'],
    i18n: {
      title: 'Detumbling Captured Debris',
      shortText: 'Stopping a spinning derelict takes reaction torque and patience — and a bad tumble can defeat the grab entirely.',
      fullText: "Dead satellites and debris tumble unpredictably, sometimes at rates up to 60° per second, and you cannot safely haul a spinning target. Before it comes home it has to be de-spun, which means applying a counter-torque through the grapple point using thrusters or reaction wheels.\n\nThe difficulty is that real objects are not simple. An asymmetric body tumbles about all three axes at once, so the spin does not lie on a single clean axis, and knowing its moment of inertia is what tells you how much effort the job will take. A fast, awkward tumble can defeat a grab outright, which is why reading the target's motion comes before committing a net or an arm.",
      realWorld: 'Debris tumbles up to ~60°/s; de-spin via grapple-point counter-torque is a core active-debris-removal problem.',
      trlRationale: 'Detumble control demonstrated; non-cooperative capture still maturing.',
      unlockHint: "Fly until the mothership reports a target's tumble rate.",
    },
  },
  {
    id: 'momentum_dumping', category: 'ATTITUDE', trl: 9, icon: '♻️',
    related: ['reaction_wheels', 'control_moment_gyroscope', 'magnetorquers', 'rcs_attitude_control'],
    i18n: {
      title: 'Momentum Dumping (Desaturation)',
      shortText: 'Wheels that soak up disturbance torques eventually spin flat-out; resetting them means bleeding the momentum off externally.',
      fullText: "Reaction wheels and control moment gyroscopes hold a spacecraft steady by absorbing the small, relentless disturbance torques of orbit: drag, sunlight pressure, and the gravity gradient. But that stored momentum has nowhere to go, so the wheels spin ever faster and the CMG gimbals creep toward their limits until they saturate and can absorb no more.\n\nResetting them means applying an external torque to dump the excess. Magnetorquers pushing against Earth's magnetic field can do it, so can reaction-control thrusters, and so can the gravity-gradient torque itself. The International Space Station prefers the gravity-gradient route precisely because it costs no propellant, turning a free environmental torque into a reset.",
      realWorld: 'ISS desaturates its CMGs using gravity-gradient torque (no propellant); zero-propellant turns demonstrated 2006-2007.',
      trlRationale: 'Routine on every momentum-managed spacecraft.',
      unlockHint: 'Clear 24 pieces of debris.',
    },
  },
  {
    id: 'magnetorquers', category: 'ATTITUDE', trl: 9, icon: '🧲',
    related: ['momentum_dumping', 'gravity_gradient_stabilization', 'reaction_wheels'],
    i18n: {
      title: 'Magnetorquers',
      shortText: "Electromagnetic coils that push against Earth's magnetic field — weak, but propellant-free and effectively eternal.",
      fullText: "A magnetorquer is a coil of wire that becomes a magnetic dipole when powered, and that dipole pushes against Earth's magnetic field to produce a torque. It uses no propellant, has no moving parts, and never wears out; the trade is that the torque is weak, so it cannot slew a spacecraft quickly.\n\nIts main job is quiet housekeeping: desaturating reaction wheels by slowly bleeding off the momentum they have stored, against the planet's own field. That makes magnetorquers the free, patient partner to the fast, finite thrusters. On a small satellite they may be the primary actuator; on a large one they are the reset switch for the wheels.",
      realWorld: 'Magnetorquers give propellant-free torque against Earth\u2019s field; standard reaction-wheel desaturation on most satellites.',
      trlRationale: 'Ubiquitous, especially on small satellites.',
      unlockHint: 'Fly until the mothership flags the magnetorquers.',
    },
  },
  {
    id: 'gravity_gradient_stabilization', category: 'ATTITUDE', trl: 9, icon: '📐',
    related: ['control_moment_gyroscope', 'magnetorquers', 'attitude_control_system'],
    i18n: {
      title: 'Gravity-Gradient Stabilization',
      shortText: 'Gravity pulls slightly harder on your low end than your high end, so a long satellite hangs upright for free.',
      fullText: "Gravity weakens with altitude, so the lower end of a long spacecraft feels a fraction more pull than the upper end. That tiny difference produces a torque that swings the long axis toward the local vertical and holds it there, a free, passive way to keep one face pointed at Earth with no power at all.\n\nEarly satellites exploited it with long gravity-gradient booms, and many small satellites still do. It is gentle and only loosely controls two axes, so it is usually paired with a damper to bleed off slow wobble or with magnetorquers for finer pointing. The same environmental torque is what the International Space Station uses to desaturate its gyroscopes without spending propellant.",
      realWorld: 'Used since the 1960s; the same gravity-gradient torque also desaturates the ISS CMGs.',
      formula: 'τ_gg = (3μ / r³) · (I_max − I_min) · sin 2θ',
      trlRationale: 'Passive stabilisation flown since the 1960s.',
      unlockHint: 'Clear 34 pieces of debris.',
    },
  },

  // =============================== AVIONICS (9) ===============================
  {
    id: 'onboard_computer', category: 'AVIONICS', trl: 9, icon: '📟',
    related: ['rad_hard_processor', 'spacewire_bus', 'watchdog_timer', 'telemetry', 'fdir'],
    i18n: {
      title: 'Command & Data Handling (C&DH)',
      shortText: 'The onboard computer is mission control\u2019s hands when mission control is out of radio range, which is most of the time.',
      fullText: "The command and data handling (C&DH) system is the spacecraft's central computer. It receives and executes commands from the ground, runs the flight software, gathers data from every subsystem, and packages it for downlink.\n\nBecause a satellite is only in contact with a ground station for a few minutes per orbit, the C&DH has to run the vehicle autonomously the rest of the time, sequencing events, watching for faults, and keeping the craft safe until the next pass. It talks to the other boxes over standardised data buses so hardware from different builders can interoperate, the quiet hub the whole spacecraft is wired around.",
      realWorld: 'Runs flight software and autonomy between ground-station passes; central to every spacecraft.',
      trlRationale: 'Every spacecraft carries a C&DH computer.',
      unlockHint: 'Clear 7 pieces of debris.',
    },
  },
  {
    id: 'rad_hard_processor', category: 'AVIONICS', trl: 9, icon: '🧠',
    related: ['single_event_effects', 'ecc_memory', 'radiation_dose', 'triple_redundancy', 'onboard_computer'],
    i18n: {
      title: 'Radiation-Hardened Processors',
      shortText: 'The brain of a billion-dollar probe runs slower than a 1990s desktop on purpose: out here, surviving radiation beats speed.',
      fullText: "Space radiation flips bits and can latch up and destroy an ordinary chip, so spacecraft fly processors built to survive it rather than to win benchmarks. The workhorse is BAE Systems' RAD750, a radiation-hardened processor running roughly 110-200 MHz that tolerates an enormous total dose; it flies on the Curiosity and Perseverance rovers and on the James Webb Space Telescope.\n\nIt costs orders of magnitude more than a consumer chip and is years behind in raw speed, yet it keeps computing where a laptop processor would crash or die. That is the whole trade of spaceflight electronics in one part: reliability first, performance a distant second.",
      realWorld: 'BAE Systems RAD750 (~118 MHz on JWST); flies on Curiosity, Perseverance, JWST; tolerates ~200k-1M rad.',
      trlRationale: 'RAD750 flown on many flagship missions.',
      unlockHint: 'Clear 17 pieces of debris.',
    },
  },
  {
    id: 'single_event_effects', category: 'AVIONICS', trl: 9, icon: '☢️',
    related: ['ecc_memory', 'rad_hard_processor', 'triple_redundancy', 'radiation_dose', 'fdir'],
    i18n: {
      title: 'Single-Event Effects',
      shortText: 'One cosmic ray, one flipped bit: usually harmless, occasionally fatal, and the reason flight software never trusts its own memory.',
      fullText: "When a single energetic particle, a cosmic ray or a solar proton, strikes a chip it can deposit enough charge to cause a single-event effect. The mildest is a single-event upset: one bit silently flips, corrupting a number or an instruction. Worse is a single-event latch-up, a short circuit that can burn out the device unless power is cycled quickly, and a single-event transient is a brief voltage glitch that ripples through the logic.\n\nThese are why spacecraft layer on error-correcting memory, watchdog timers, and redundancy. The hardware is built on the assumption that the universe will occasionally reach in and change a one to a zero, and that nothing important should depend on that never happening.",
      realWorld: 'SEU = bit flip; SEL = potentially destructive latch-up; SET = logic glitch (standard SEE taxonomy).',
      trlRationale: 'Well-characterised radiation-effect physics.',
      unlockHint: 'Clear 27 pieces of debris.',
    },
  },
  {
    id: 'ecc_memory', category: 'AVIONICS', trl: 9, icon: '🛡️',
    related: ['rad_hard_processor', 'single_event_effects', 'triple_redundancy'],
    i18n: {
      title: 'Error-Correcting Memory',
      shortText: 'Radiation flips bits in RAM; ECC memory carries extra bits that catch and fix a single-bit error automatically.',
      fullText: "Cosmic rays and trapped particles flip bits in memory, and in low orbit a spacecraft may see several such single-event upsets a day. Error-correcting code (ECC) memory guards against them by storing extra check bits alongside the data.\n\nThose check bits let the memory detect and automatically correct any single-bit error, and detect, though not fix, a double-bit error. Without ECC a navigation computer would quietly return wrong answers on a routine basis, corrupted by radiation it never noticed. It is a cheap, constant insurance policy that makes the difference between trustworthy memory and a slow drip of silent faults.",
      realWorld: 'ECC memory corrects single-bit and detects double-bit errors; standard against LEO single-event upsets.',
      trlRationale: 'Standard spacecraft memory protection.',
      unlockHint: 'Fly until the mothership logs a single-bit memory error.',
    },
  },
  {
    id: 'triple_redundancy', category: 'AVIONICS', trl: 9, icon: '🖥️',
    related: ['rad_hard_processor', 'single_event_effects', 'fdir'],
    i18n: {
      title: 'Triple Modular Redundancy',
      shortText: 'Three computers run every calculation and vote; two must agree, so a radiation-corrupted answer gets outvoted.',
      fullText: "Radiation flips bits at random, so a single computer can silently produce a wrong answer. Triple modular redundancy defeats that by running three identical processors on the same calculation and comparing results.\n\nIf one disagrees, corrupted by a particle strike, the other two outvote it, the faulty unit is reset, and the system carries on without a stumble. This is why the most critical spacecraft fly three to five computers doing the same job in lockstep: not for speed, but so that no single upset can ever decide the outcome. Reliability is bought with redundancy rather than with a better chip.",
      realWorld: 'Triple modular redundancy with majority voting; standard on mission-critical flight computers.',
      trlRationale: 'Standard high-reliability computing architecture.',
      unlockHint: 'Fly until the mothership flags a redundancy vote.',
    },
  },
  {
    id: 'watchdog_timer', category: 'AVIONICS', trl: 9, icon: '🐕',
    related: ['onboard_computer', 'fdir'],
    i18n: {
      title: 'Watchdog Timers & Safe Modes',
      shortText: 'A hardware timer reboots the computer if the software stops checking in, because no one can reach up and reset it.',
      fullText: "A watchdog timer is a simple hardware circuit that expects a periodic pet signal from the flight software, every few seconds. If the signal stops, meaning the software has hung, the watchdog assumes the worst and forces a reboot with no human involved.\n\nRecovery usually lands the vehicle in safe mode, a stripped-down state that points the solar panels at the Sun for power and transmits a beacon for ground contact while it waits for instructions. The International Space Station has entered safe mode dozens of times and always recovered. It is the space equivalent of the reset no one can walk over and press.",
      realWorld: 'Hardware watchdog reboots on software hang; safe mode is the canonical survival state (ISS uses it routinely).',
      trlRationale: 'Universal spacecraft fault-recovery mechanism.',
      unlockHint: 'Fly until the watchdog timer trips.',
    },
  },
  {
    id: 'telemetry', category: 'AVIONICS', trl: 9, icon: '📊',
    related: ['onboard_computer', 'spacewire_bus'],
    i18n: {
      title: 'Telemetry — Everything Is Measured',
      shortText: 'Thousands of channels report temperature, voltage, current, and pressure every second, so the ground sees trouble coming.',
      fullText: "A typical spacecraft monitors somewhere between 2,000 and 5,000 telemetry channels continuously. Every temperature sensor, voltage rail, current draw, pressure reading, wheel speed, and tank level is measured and logged, second by second.\n\nThe point is prediction. Ground controllers watch the trends in that flood of numbers to catch a failing part before it actually fails, reading a slow voltage droop or a warming bearing as an early warning. Your status panels show a tiny curated subset of what the vehicle actually tracks; underneath, the full stream is the difference between a surprise and a scheduled repair.",
      realWorld: 'Spacecraft monitor ~2,000-5,000 telemetry channels; ground trend analysis predicts failures before they happen.',
      trlRationale: 'Fundamental to all spacecraft operations.',
      unlockHint: 'Fly until the mothership flags a telemetry frame.',
    },
  },
  {
    id: 'spacewire_bus', category: 'AVIONICS', trl: 9, icon: '🔌',
    related: ['onboard_computer', 'telemetry', 'telemetry_bandwidth'],
    i18n: {
      title: 'Spacecraft Data Buses',
      shortText: 'Before boxes from five builders can fly together they must agree how to talk — space has its own wiring standards for that.',
      fullText: "A spacecraft is a network of separate boxes, computer, sensors, radios, and power, that must exchange commands and data reliably, so the industry standardises the wiring. MIL-STD-1553, a one-megabit-per-second military data bus from the 1970s, is still flown for its ruggedness and predictable timing.\n\nSpaceWire, a faster network standard coordinated by the European Space Agency, carries high-rate instrument data on many modern missions. Standard buses let a builder integrate hardware from many suppliers without rewiring the whole vehicle, the same reason desktop computers settled on USB. Interoperability, not raw speed, is what these standards are really selling.",
      realWorld: 'MIL-STD-1553 (1 Mbit/s, 1970s); SpaceWire (ESA/ECSS standard) flown on NASA, ESA, and JAXA missions.',
      trlRationale: 'Standard data buses flown across agencies.',
      unlockHint: 'Clear 13 pieces of debris.',
    },
  },
  {
    id: 'fdir', category: 'AVIONICS', trl: 9, icon: '🛟',
    related: ['watchdog_timer', 'triple_redundancy', 'onboard_computer', 'single_event_effects'],
    i18n: {
      title: 'FDIR & Safe Mode',
      shortText: 'When something breaks and the ground is over the horizon, the spacecraft has to save itself — so it assumes the worst and waits.',
      fullText: "Fault detection, isolation, and recovery (FDIR) is the spacecraft's self-preservation reflex. Onboard monitors watch for trouble, a sensor reading out of range, a subsystem drawing too much current, a computer that stops responding.\n\nWhen FDIR detects a fault it isolates the suspect part and takes recovery action, often dropping into safe mode: a stripped-down survival state that points the solar panels at the Sun, keeps the craft warm and powered, and calls home for instructions. Safe mode has rescued countless missions by buying time until engineers on the ground can diagnose the problem, trading capability for survival until help arrives.",
      realWorld: "Standard ESA/NASA fault management; 'safe mode' is the canonical survival state.",
      trlRationale: 'Standard fault-management practice.',
      unlockHint: 'Clear 21 pieces of debris.',
    },
  },

  // =============================== HERITAGE (10) ==============================
  {
    id: 'heritage_solar_max', category: 'HERITAGE', trl: 9, icon: '🛠️',
    related: ['news_mev1_servicing', 'world_servicing', 'docking_berthing', 'heritage_hubble_servicing'],
    i18n: {
      title: 'Solar Max — The First House Call',
      shortText: 'In 1984 a Space Shuttle crew caught a broken satellite, fixed it, and let it go again — the first repair job in orbit.',
      fullText: "The Solar Maximum Mission, launched in 1980 to study the Sun, lost its attitude control within a year. Rather than write it off, NASA sent the Space Shuttle Challenger to catch it.\n\nIn April 1984, on mission STS-41-C, astronauts grappled the tumbling satellite, swapped out the faulty modules, and released it back to work, the first time a satellite was ever repaired in orbit. It proved that spacecraft could be serviced instead of discarded, planting the seed for Hubble's later rescues and for today's refuel-and-capture industry. Everything you do with a robotic arm has a lineage that runs back to this catch.",
      realWorld: 'Solar Maximum Mission repaired on STS-41-C (Challenger), April 1984 — first on-orbit satellite repair.',
      trlRationale: 'Historical mission (1984).',
      unlockHint: 'Clear 36 pieces of debris.',
    },
  },
  {
    id: 'heritage_ldef', category: 'HERITAGE', trl: 9, icon: '🧫',
    related: ['mmod_impact', 'atomic_oxygen', 'titanium_alloys', 'hypervelocity'],
    i18n: {
      title: 'LDEF — Six Years in the Open',
      shortText: 'Left exposed to space for nearly six years, this bus-sized satellite came home peppered with impact craters.',
      fullText: "The Long Duration Exposure Facility (LDEF) was a passive, bus-sized cylinder carrying 57 experiments, deployed by the Space Shuttle in April 1984 to see how materials, coatings, and electronics endure prolonged exposure to space. It was meant to be retrieved within a year.\n\nShuttle delays, including the Challenger accident, stranded it in orbit for nearly six years until Columbia recovered it in January 1990. It returned peppered with tens of thousands of micrometeoroid and debris craters and surfaces eroded by atomic oxygen, giving engineers their richest real-world dataset on the debris environment and on how low Earth orbit slowly destroys hardware.",
      realWorld: 'LDEF deployed 6 Apr 1984 (STS-41-C), retrieved 12 Jan 1990 (STS-32); ~5.7 years; 57 experiments.',
      trlRationale: 'Historical mission (1984-1990).',
      unlockHint: 'Clear 44 pieces of debris.',
    },
  },
  {
    id: 'heritage_hubble_servicing', category: 'HERITAGE', trl: 9, icon: '🔭',
    related: ['heritage_solar_max', 'world_servicing', 'jwst_horizon', 'hubble_watch'],
    i18n: {
      title: 'Hubble — Saved Five Times',
      shortText: 'Launched with a famously flawed mirror, the most beloved telescope in history was rescued by astronauts five times.',
      fullText: "When the Hubble Space Telescope reached orbit in 1990, its primary mirror had been ground to the wrong shape and its images came back blurred. Instead of abandoning a flagship, NASA flew the first of five Space Shuttle servicing missions in December 1993, installing corrective optics that restored its sight.\n\nFour more visits, in 1997, 1999, 2002, and a final one in 2009, replaced instruments, gyroscopes, and batteries, rebuilding the telescope in place and extending its life by decades. Hubble is the proof of what on-orbit servicing can be worth: a spacecraft kept world-class for more than thirty years by sending people up to fix it.",
      realWorld: 'Hubble (launched 1990); 5 Shuttle servicing missions: 1993, 1997, 1999, 2002, 2009.',
      trlRationale: 'Historical servicing campaign (1993-2009).',
      unlockHint: 'Clear 46 pieces of debris.',
    },
  },
  {
    id: 'jwst_horizon', category: 'HERITAGE', trl: 9, icon: '🔭',
    related: ['heritage_hubble_servicing', 'space_elevator', 'what_10000kg_buys'],
    i18n: {
      title: 'JWST — The Next Horizon',
      shortText: 'A million miles out at L2, the James Webb telescope watches a sky you helped keep clear.',
      fullText: "The James Webb Space Telescope orbits the Sun-Earth L2 point, about 1.5 million km away, far beyond the debris fields, beyond reach, beyond salvage. It is the work that becomes possible when low orbit is kept clear: the deep-sky science that needs a clean launch corridor and a stable platform.\n\nYou will never tow JWST. But the sky it looks out from is a little safer because of the field you swept, and the launches that carry its successors depend on corridors that stay usable. That is the quiet dividend of debris removal, the science you enable without ever touching it. That is the job, Cowboy.",
      realWorld: 'JWST operates at Sun-Earth L2 (~1.5 million km); launched 2021, beyond any servicing or debris risk.',
      trlRationale: 'Operational flagship observatory (since 2022).',
      unlockHint: 'Win the mission via the space elevator.',
    },
  },
  {
    id: 'space_elevator', category: 'HERITAGE', trl: 2, icon: '🪝',
    related: ['cnt', 'carbyne', 'what_10000kg_buys'],
    i18n: {
      title: 'The Space Elevator',
      shortText: 'A tether from a ground anchor past GEO to a counterweight — and debris is the cheapest counterweight mass on orbit.',
      fullText: "Konstantin Tsiolkovsky imagined it in 1895. A space elevator is a tether running from a ground station past geostationary altitude to a counterweight, letting payloads climb to orbit on electric power instead of riding rockets. The physics works; the material does not exist yet, which is why carbon nanotubes and carbyne matter so much.\n\nThe other hard part is mass, both the counterweight and the climbers, and the cheapest mass available is already up here as debris. Every kilogram you deliver to the anchor is a kilogram nobody had to launch from the ground. Cleaning the sky and building the road off it turn out to be the same job.",
      realWorld: 'Concept from Tsiolkovsky (1895); blocked by tether material limits (see CNT, carbyne); no flight hardware.',
      trlRationale: 'Concept only; no material can yet build the tether.',
      unlockHint: 'Win the mission via the space elevator.',
    },
  },
  {
    id: 'what_10000kg_buys', category: 'HERITAGE', trl: 9, icon: '⚖️',
    related: ['space_elevator', 'jwst_horizon'],
    i18n: {
      title: 'What 10,000 kg Buys',
      shortText: 'Ten tonnes of salvaged orbital mass is a real counterweight anchor — and, more quietly, a cleared sky.',
      fullText: "Ten thousand kilograms is roughly the dry mass of a Hubble-class observatory, or a third of the International Space Station's Zarya module. Assembled at the anchor it is enough structural counterweight to tension a first-generation space-elevator tether.\n\nBut the deeper value is subtractive. Every tonne you removed is debris that will never again fragment, never force a station to dodge, never end another satellite's life. You did not only build something at the top of the tether; you took the same mass out of the collision problem below. Both halves of that ledger count, and the cleanup is the half that lasts.",
      realWorld: '10,000 kg ≈ a Hubble-class dry mass; enough counterweight to tension a first-generation elevator tether.',
      trlRationale: 'Illustrative mass milestone.',
      unlockHint: 'Win the mission via the space elevator.',
    },
  },
  {
    id: 'isro_launch_vehicles', category: 'HERITAGE', trl: 9, icon: '🚀',
    related: ['isro_why_india', 'isro_istrac', 'isro_kulasekarapattinam'],
    i18n: {
      title: 'ISRO Launch Vehicle Families',
      shortText: "PSLV, LVM3, and SSLV — India's three-tier fleet, from small satellites to lunar landers.",
      fullText: "India's space agency flies three launch vehicles covering the payload range. The PSLV (Polar Satellite Launch Vehicle) is the workhorse, with 64 flights and 59 successes and a knack for rideshare; it once deployed 104 satellites on a single mission and lifts about 1,750 kg to Sun-synchronous orbit in its XL configuration.\n\nThe LVM3 is the heavy lifter, carrying roughly 4,200 kg to geostationary transfer or up to 10,000 kg to low orbit on an indigenous CE-20 cryogenic upper stage, and it launched the Chandrayaan-2 and Chandrayaan-3 lunar missions. The SSLV (Small Satellite Launch Vehicle), operational since 2024, puts up to 500 kg into low orbit on three solid stages with a liquid trimming module for quick, dedicated small launches.",
      realWorld: 'PSLV: 64 flights, 59 successes, ~1,750 kg to SSO (XL). LVM3: ~4,200 kg GTO / ~10,000 kg LEO; flew Chandrayaan-2/-3. SSLV: ~500 kg to LEO, operational since 2024.',
      trlRationale: 'All three vehicle families operational.',
      unlockHint: 'Take an ISRO ground-ops message.',
    },
  },
  {
    id: 'isro_istrac', category: 'HERITAGE', trl: 9, icon: '📡',
    related: ['isro_launch_vehicles', 'isro_why_india'],
    i18n: {
      title: 'ISTRAC Bangalore',
      shortText: "ISRO's Telemetry, Tracking and Command network — the ground eyes that fly every Indian spacecraft.",
      fullText: "The ISRO Telemetry, Tracking and Command Network (ISTRAC), headquartered in Bangalore since 1976, is the ground half of every Indian mission. It handles telemetry, tracking, and commanding from liftoff through the full operational life of a satellite: determining orbits, monitoring health, and sending up commands.\n\nIts reach is global. Indian stations at Sriharikota, Lucknow, Port Blair and elsewhere are backed by international sites from Mauritius to Svalbard to Antarctica, giving near-continuous downrange coverage. For an orbital cleanup operation, that kind of tracking network is exactly what turns a vague radar blip into an orbit precise enough to plan an intercept against.",
      realWorld: 'ISTRAC (Bangalore, est. 1976) runs ISRO TTC via a global station network incl. Svalbard and Antarctica.',
      trlRationale: 'Operational tracking network for decades.',
      unlockHint: 'Take an ISRO ground-ops message.',
    },
  },
  {
    id: 'isro_kulasekarapattinam', category: 'HERITAGE', trl: 9, icon: '🚀',
    related: ['isro_launch_vehicles', 'isro_why_india'],
    i18n: {
      title: 'Kulasekarapattinam Spaceport',
      shortText: "India's new southern spaceport at 8.4°N, being built to launch small rockets straight into polar orbit.",
      fullText: "Kulasekarapattinam, on the Tamil Nadu coast at about 8.4°N, is India's second orbital launch site, purpose-built for the Small Satellite Launch Vehicle and other small rockets. Its southern position lets it fire straight south over open ocean into polar and Sun-synchronous orbits.\n\nThat matters because the established site at Sriharikota must fly a fuel-costly dogleg around Sri Lanka to reach the same orbits. Construction began in 2025, with the pad and a first launch targeted for late 2026, so it is a spaceport still taking shape rather than one already flying. For a small-launch, quick-turnaround future, a dedicated southern range is the enabling piece of ground.",
      realWorld: 'Kulasekarapattinam (~8.4°N, Tamil Nadu): SSLV/small-launch site under construction; first launch targeted late 2026.',
      trlRationale: 'Under construction; not yet operational.',
      unlockHint: 'Take an ISRO ground-ops message.',
    },
  },
  {
    id: 'isro_why_india', category: 'HERITAGE', trl: 9, icon: '🇮🇳',
    related: ['isro_launch_vehicles', 'isro_istrac', 'isro_kulasekarapattinam'],
    i18n: {
      title: 'Why Launch from India?',
      shortText: "Sriharikota's low latitude, a deep tracking network, and a reliable, cost-conscious fleet make India a strong launch base.",
      fullText: "Sriharikota sits at about 13.7°N, and a low-latitude site gives an eastward launch a useful boost from Earth's rotation for equatorial and low-inclination orbits. India pairs that geography with a launch fleet known for reliability and low fixed mission cost, which is why so many rideshare and government payloads fly on it.\n\nIt is not that Indian launch is dramatically cheaper per kilogram than modern reusable rockets; its edge is dependable service, rideshare flexibility, and a modest per-mission price. For a mothership, an Indian launch also means working from insertion within reach of ISTRAC's tracking network, which shortens the path from orbit to useful debris-intercept planning.",
      realWorld: 'Sriharikota ~13.7°N (rotational launch assist); PSLV valued for reliability and low mission cost, plus ISTRAC tracking.',
      trlRationale: 'Operational launch base for decades.',
      unlockHint: 'Take an ISRO ground-ops message.',
    },
  },

  // ============================== PROPULSION (17) =============================
  {
    id: 'specific_impulse', category: 'PROPULSION', trl: 9, icon: '📊',
    related: ['feep_thruster', 'mpd_burst', 'delta_v', 'cold_gas_thruster'],
    i18n: {
      title: 'Specific Impulse',
      shortText: 'How many seconds a kilo of propellant holds up one newton of thrust — the efficiency yardstick every engine is judged by.',
      fullText: "Specific impulse (Isp), measured in seconds, is the efficiency rating of a thruster: how much velocity change it wrings from each kilogram of propellant. Higher is better, and the range is enormous. A chemical rocket manages around 300 seconds, a xenon ion drive around 3,000, and a FEEP thruster over 6,000.\n\nThe universal catch is that efficiency and thrust trade against each other: the most efficient engines are also the weakest. That single tension shapes your whole ship, which is why the mothership cruises on an efficient ion drive while the attitude thrusters use responsive, thirsty cold gas. You pick the engine to match the job, not the other way around.",
      realWorld: 'Cold gas ~70 s · hydrazine ~230 s · xenon ion ~3,000 s · FEEP ~6,000 s.',
      formula: 'Isp = F / (ṁ · g₀)',
      trlRationale: 'Fundamental propulsion metric.',
      unlockHint: 'Earn a fuel-efficiency award.',
    },
  },
  {
    id: 'feep_thruster', category: 'PROPULSION', trl: 7, icon: '🔥',
    related: ['specific_impulse', 'feep_indium', 'mpd_burst', 'xenon_propellant'],
    i18n: {
      title: 'FEEP Thrusters',
      shortText: 'Field-emission electric propulsion: liquid metal ionised and flung by an electric field at extreme efficiency.',
      fullText: "Field-emission electric propulsion (FEEP) ionises a liquid metal, usually indium or cesium, and accelerates the ions through a strong electric field. The thrust is tiny, in the micronewton range, but the efficiency is extraordinary, with specific impulse above 6,000 seconds.\n\nThat profile suits precision, not power. FEEP is how you nudge a spacecraft by fractions of a millimetre per second for formation flying or fine positioning, spending almost no propellant to do it. Your daughters carry miniaturised FEEP units for exactly that: patient, delicate maneuvering in a crowded debris field where a heavy hand would do more harm than good.",
      realWorld: 'Enpulsion IFM Nano; flew on Gaia (2013) and LISA Pathfinder (2016); micronewton thrust, Isp >6,000 s.',
      formula: 'F = ṁ · v_exhaust  (micronewton class)',
      trlRationale: 'FEEP flown on Gaia and LISA Pathfinder.',
      unlockHint: 'Pilot a daughter (P) and thrust manually.',
    },
  },
  {
    id: 'feep_indium', category: 'PROPULSION', trl: 9, icon: '🔬',
    related: ['feep_thruster', 'feep_gallium', 'feep_cesium', 'specific_impulse'],
    i18n: {
      title: 'FEEP Propellant: Indium',
      shortText: 'The baseline FEEP metal — flight-proven, well-behaved, and reliable enough to be the boring default.',
      fullText: "Indium melts at a modest 156.6°C and has been the workhorse FEEP propellant since the 1990s. Enpulsion's IFM Nano uses a porous indium needle emitter to reach 4,000-19,000 seconds of specific impulse at micronewton thrust, and its high surface tension and low vapour pressure make it ideal for capillary feed systems.\n\nCrucially, it is flight-proven: indium FEEP has flown on LISA Pathfinder, on ESA's GOCE gravity mapper, and on numerous CubeSats, earning a full TRL 9. Your daughters ship with indium as the default for the same reason the industry does, because it is reliable, well-characterised, and available off the shelf. It is the propellant you pick when you want no surprises.",
      realWorld: 'Enpulsion IFM Nano; LISA Pathfinder (2016), GOCE; Isp ≈ 4,000-19,000 s.',
      formula: 'Isp ≈ 4,000-19,000 s',
      trlRationale: 'Indium FEEP flight-proven (TRL 9).',
      unlockHint: 'Switch the FEEP propellant to indium.',
    },
  },
  {
    id: 'feep_gallium', category: 'PROPULSION', trl: 7, icon: '🔬',
    related: ['feep_indium', 'feep_bismuth', 'feep_iodine'],
    i18n: {
      title: 'FEEP Propellant: Gallium',
      shortText: 'Gallium melts at 29.8°C, warm enough to liquefy in your hand — simpler feed heating, higher Isp than indium.',
      fullText: "Gallium's remarkable trait is that it melts at just 29.8°C, warm enough to go liquid in your hand. For a FEEP thruster that low melting point means less heater power and a simpler feed system, a real operational saving over indium.\n\nGround studies under ESA's Horizon 2000+ programme showed gallium FEEP reaching specific impulses up to about 25,000 seconds, some 31% above the indium baseline, at slightly lower thrust per watt. The complication is that gallium tends to supercool below its freezing point, so the feed system has to actively prevent it from solidifying during the cold of an eclipse pass. Higher performance, in exchange for a fussier thermal design.",
      realWorld: 'ESA Horizon 2000+ FEEP studies (ground); Isp up to ~25,000 s at ~0.028 N/W.',
      formula: 'Isp ≈ up to 25,000 s · 0.028 N/W',
      trlRationale: 'Gallium FEEP demonstrated in ground tests.',
      unlockHint: 'Switch the FEEP propellant to gallium.',
    },
  },
  {
    id: 'feep_bismuth', category: 'PROPULSION', trl: 6, icon: '🔬',
    related: ['feep_indium', 'feep_tungsten', 'feep_gallium'],
    i18n: {
      title: 'FEEP Propellant: Bismuth',
      shortText: 'The heavy-ion bruiser: low Isp, but the highest thrust per watt of the conventional FEEP metals.',
      fullText: "Bismuth is the heaviest practical FEEP propellant at 209 atomic mass units, and that mass is the whole point. Each heavy ion carries enormous momentum, delivering around 45 millinewtons per kilowatt, roughly 40% more thrust per watt than indium.\n\nThe trade is severe: specific impulse tops out near 8,000 seconds, less than half of indium's peak, and bismuth's 271°C melting point demands more heater power. Research at TU Dresden and Alta SpA has taken it to TRL 6 in ground tests. You reach for bismuth when you need raw stopping power rather than efficiency, deorbiting a heavy derelict or braking hard, and can accept burning propellant faster to get it.",
      realWorld: 'TU Dresden / Alta SpA ground tests (TRL 6); Isp ~8,000 s at ~45 mN/W.',
      formula: 'Isp ≈ 8,000 s · ~45 mN/W',
      trlRationale: 'Bismuth FEEP at ground-test maturity (TRL 6).',
      unlockHint: 'Switch the FEEP propellant to bismuth.',
    },
  },
  {
    id: 'feep_iodine', category: 'PROPULSION', trl: 7, icon: '🔬',
    related: ['feep_indium', 'feep_gallium', 'feep_cesium'],
    i18n: {
      title: 'FEEP Propellant: Iodine',
      shortText: 'Cheap and storable as a solid, needing no pressurised tank — but viciously corrosive to the hardware.',
      fullText: "Iodine stores as a solid at room temperature, so it needs no heavy pressurised tank, and at roughly the cost of indium it packs into a far denser volume. ThrustMe's NPT30-I2 flew on ESA's SpaceVan in 2020, validating iodine electric propulsion at TRL 7, with excellent thrust per watt around 60 millinewtons per kilowatt at a modest 2,000-4,500 seconds of specific impulse.\n\nThe catch is chemistry: iodine is viciously corrosive, attacking spacecraft surfaces, feed lines, and even thruster grids over time. That hostility is also an opportunity; JAXA has explored iodine for air-breathing thrusters that scoop atmospheric particles below 200 km. Cheap and compact, if you can keep it from eating the ship.",
      realWorld: 'ThrustMe NPT30-I2 on ESA SpaceVan (2020); Isp ~2,000-4,500 s at ~60 mN/W; corrosive.',
      formula: 'Isp ≈ 2,000-4,500 s · ~60 mN/W',
      trlRationale: 'Iodine EP flight-validated (TRL 7).',
      unlockHint: 'Switch the FEEP propellant to iodine.',
    },
  },
  {
    id: 'feep_mercury', category: 'PROPULSION', trl: 5, icon: '⚠️',
    related: ['feep_cesium', 'feep_indium'],
    i18n: {
      title: 'FEEP Propellant: Mercury',
      shortText: 'The first ion-drive propellant ever flown — mechanically simple, genuinely effective, and far too toxic to use today.',
      fullText: "Mercury was the very first ion-thruster propellant flown in space: NASA's SERT-I in 1964 and the Soviet Zond programme both used mercury bombardment thrusters. It works well, offering 3,000-10,000 seconds of specific impulse at a solid 40 millinewtons per kilowatt, and being liquid at room temperature with a high atomic mass makes it mechanically simple to handle.\n\nThe dealbreaker is toxicity. Contamination risk led NASA to abandon mercury propulsion in the 1980s, and modern planetary-protection rules effectively ban it. Your forge can still extract mercury from old switchgear salvage, so it remains an option of last resort, but the codex is blunt about it: use it only if you are desperate, and handle it with extreme caution.",
      realWorld: 'NASA SERT-I (1964) and Soviet Zond used mercury; abandoned ~1980s over toxicity; effectively banned now.',
      formula: 'Isp ≈ 3,000-10,000 s · ~40 mN/W',
      trlRationale: 'Flew historically; abandoned for toxicity.',
      unlockHint: 'Switch the FEEP propellant to mercury.',
    },
  },
  {
    id: 'feep_cesium', category: 'PROPULSION', trl: 5, icon: '⚠️',
    related: ['feep_mercury', 'feep_indium', 'feep_iodine'],
    i18n: {
      title: 'FEEP Propellant: Cesium',
      shortText: 'The specific-impulse king, thanks to the lowest ionisation energy of any stable element — and violently reactive with air.',
      fullText: "Cesium holds the FEEP specific-impulse record, reaching 8,000-22,000 seconds in flight-representative tests. It owes that to the lowest ionisation energy of any stable element, just 3.89 electronvolts, so its ions come free easily and efficiently even at low power. Early FEEP research at ESA's ESTEC in the 1970s and 80s leaned heavily on cesium emitters.\n\nThe problem is that cesium reacts explosively with water and air, so it must be handled in inert-atmosphere gloveboxes, and contamination of spacecraft surfaces causes long-term outgassing and arcing. The industry drifted to indium precisely because it is chemically boring. Cesium's efficiency is tempting, but really only for a spacecraft that is never coming home.",
      realWorld: 'ESA/ESTEC cesium FEEP research (1970s-80s); Isp ~8,000-22,000 s (highest); reactive with air/water.',
      formula: 'Isp ≈ 8,000-22,000 s (highest)',
      trlRationale: 'Cesium FEEP demonstrated; handling hazards limit use.',
      unlockHint: 'Switch the FEEP propellant to cesium.',
    },
  },
  {
    id: 'feep_tungsten', category: 'PROPULSION', trl: 4, icon: '🔬',
    related: ['feep_bismuth', 'mpd_burst'],
    i18n: {
      title: 'FEEP Propellant: Tungsten',
      shortText: 'Maximum thrust, minimum range: so heavy it needs MPD-class power just to ionise, and lab-only for now.',
      fullText: "Tungsten sits at the extreme end of FEEP research. At 183.8 atomic mass units and a 3,422°C melting point, it demands enormous power to ionise and accelerate, on the order of an MPD-class system drawing kilowatts.\n\nIn return it delivers around 80 millinewtons per kilowatt, more than double indium, but the massive ions cannot be accelerated efficiently, so specific impulse is limited to 1,500-3,500 seconds. It remains lab-only at TRL 4, with no flight hardware, having emerged from Applied Physics Laboratory studies on high-thrust electric propulsion for debris removal. It is a near-perfect match for your mission's needs, if you can ever spare the power budget to run it.",
      realWorld: 'APL high-thrust EP concepts (lab only, TRL 4); Isp ~1,500-3,500 s at ~80 mN/W.',
      formula: 'Isp ≈ 1,500-3,500 s · ~80 mN/W',
      trlRationale: 'Tungsten FEEP lab-demonstrated only (TRL 4).',
      unlockHint: 'Switch the FEEP propellant to tungsten.',
    },
  },
  {
    id: 'mpd_burst', category: 'PROPULSION', trl: 4, icon: '🚀',
    related: ['feep_thruster', 'specific_impulse', 'graphene_supercap', 'feep_tungsten'],
    i18n: {
      title: 'MPD Thruster',
      shortText: 'Lorentz force on a lithium plasma: fifty times an ion drive\u2019s thrust, drinking 150 kW to do it.',
      fullText: "A magnetoplasmadynamic (MPD) thruster ionises lithium propellant and accelerates the plasma with the Lorentz force, the interaction between the current running through the plasma and its own self-generated magnetic field. At 150 kilowatts it produces about 25 newtons, roughly fifty times an ion drive, at a healthy 2,000-5,000 seconds of specific impulse.\n\nThe catch is that appetite for power, which drains batteries in seconds and is why MPD needs a supercapacitor bank to feed it. Real thrusters have been tested at NASA Glenn and JAXA, but cathode erosion, tungsten slowly subliming at the arc, remains the core engineering problem. Your Ludicrous Mode makes it usable by chaining multi-junction solar, solid-state batteries, and supercapacitors into one burst-power system.",
      realWorld: 'MPD thrusters tested at NASA Glenn and JAXA (kW-MW class); ~25 N at 150 kW; not yet operational for ADR.',
      formula: 'F = ½ · μ₀/(4π) · J² · ln(r_a/r_c)',
      trlRationale: 'MPD thrusters lab-tested; not operational.',
      unlockHint: 'Fire the MPD burst.',
    },
  },
  {
    id: 'xenon_propellant', category: 'PROPULSION', trl: 9, icon: '⚗️',
    related: ['krypton_propellant', 'argon_propellant', 'feep_thruster'],
    i18n: {
      title: 'Xenon Propellant',
      shortText: 'Heavy, inert, and easy to ionise — the default ion-drive propellant for half a century, and expensive.',
      fullText: "Xenon has been the propellant of choice for electric propulsion for decades because it checks every box: it is heavy, giving good momentum per ion, chemically inert and therefore safe to store, and easy to ionise. Your mothership's main ion drive burns it.\n\nThe drawback is price, around 3,000 dollars a kilogram, which is one more reason efficiency matters when every gram counts. It is why the propellant gauge is a resource to respect rather than ignore, and why cheaper substitutes like krypton and argon exist as deliberate trade-downs. Xenon is the gold standard you burn when performance outweighs cost.",
      realWorld: 'Xenon flown on Dawn, SMART-1, and most GEO comsat electric thrusters; ~$3,000/kg.',
      trlRationale: 'Standard electric-propulsion propellant.',
      unlockHint: 'Burn xenon below 70%.',
    },
  },
  {
    id: 'krypton_propellant', category: 'PROPULSION', trl: 9, icon: '💨',
    related: ['xenon_propellant', 'argon_propellant'],
    i18n: {
      title: 'Krypton Propellant',
      shortText: 'Cheaper than xenon at a slight efficiency cost — the trade SpaceX made to fly thousands of thrusters.',
      fullText: "Krypton costs around 400 dollars a kilogram against xenon's 3,000, and that gap is the whole story. It is lighter, at 83.8 atomic mass units versus xenon's 131.3, which costs roughly 15% in specific impulse, but the savings let a mission carry far more propellant for the same budget.\n\nSpaceX made exactly this trade for the first-generation Starlink satellites, whose Hall thrusters run on krypton because flying thousands of them on xenon would have been prohibitive. Upgrading your thrusters to krypton opens the same door: cheaper bulk operations, accepting a modest efficiency hit in exchange for burning far more freely.",
      realWorld: 'SpaceX Starlink v1 Hall thrusters use krypton (~$400/kg vs xenon ~$3,000/kg; ~15% lower Isp).',
      trlRationale: 'Krypton Hall thrusters operational at scale.',
      unlockHint: 'Fit a krypton thruster upgrade.',
    },
  },
  {
    id: 'argon_propellant', category: 'PROPULSION', trl: 7, icon: '💨',
    related: ['xenon_propellant', 'krypton_propellant'],
    i18n: {
      title: 'Argon Propellant',
      shortText: 'Dirt-cheap and abundant, at a further efficiency hit — the next step down the propellant cost curve.',
      fullText: "Argon makes up about 1% of Earth's atmosphere, so it is extraordinarily cheap to produce, on the order of 5 dollars a kilogram, roughly 600 times cheaper than xenon. The price of that abundance is performance: at 39.9 atomic mass units it is much lighter, giving around 2,000 seconds of specific impulse against xenon's 3,000.\n\nFor bulk work the arithmetic can still favour it. When you are processing thousands of objects, argon's cost advantage can outweigh its lower efficiency, and SpaceX moved its second-generation Starlink thrusters to argon for exactly that reason. It is the propellant for operations measured in tonnes and volume rather than in precision.",
      realWorld: 'SpaceX Starlink v2 Hall thrusters use argon (~$5/kg, ~600× cheaper than xenon; Isp ~2,000 s).',
      trlRationale: 'Argon Hall thrusters operational on Starlink v2.',
      unlockHint: 'Fit an argon thruster upgrade.',
    },
  },
  {
    id: 'cold_gas_thruster', category: 'PROPULSION', trl: 9, icon: '💨',
    related: ['cold_gas_rcs', 'specific_impulse'],
    i18n: {
      title: 'Cold Gas Thrusters',
      shortText: 'Just blow gas out a nozzle: terrible efficiency, near-instant response, and utterly reliable when nothing else may fire.',
      fullText: "A cold-gas thruster is the simplest rocket there is: store a gas under pressure, nitrogen or helium, and release it through a nozzle. No combustion, no ionisation, just Newton's third law. Its specific impulse is dismal, around 70 seconds, so it burns through propellant fast.\n\nWhat it offers instead is response and safety. The valve opens and thrust appears almost instantly, with no ignition, no plume contamination, and no risk near volatile debris, which makes it ideal for fine attitude control and emergency maneuvers. Your reaction-control system runs on this principle precisely because when you need a small nudge right now, reliability beats efficiency every time.",
      realWorld: 'Cold gas (N₂/He) flown on CPOD and countless CubeSats; Isp ~40-70 s; instant, ignition-free.',
      formula: 'Isp ≈ 40-70 s',
      trlRationale: 'Ubiquitous simple attitude propulsion.',
      unlockHint: 'Burn the cold-gas reserve below 80%.',
    },
  },
  {
    id: 'cold_gas_rcs', category: 'PROPULSION', trl: 9, icon: '💨',
    related: ['cold_gas_thruster', 'recoil_cancellation', 'rcs_attitude_control'],
    i18n: {
      title: 'Cold Gas RCS',
      shortText: 'Nitrogen jets for fine positioning: low thrust and thirsty, but zero ignition risk right next to debris.',
      fullText: "A cold-gas reaction control system expels stored pressurised nitrogen through small nozzles for attitude and position control. Each jet produces only about a newton, and the poor specific impulse of roughly 73 seconds means it drinks propellant quickly, so it is not for big maneuvers.\n\nIts virtue is that it is utterly safe to fire in close quarters: no combustion, no contamination, and no ignition source near volatile or fuel-laden debris. That safety is exactly what you want during the delicate final metres of an approach, so your mothership uses cold gas for fine positioning where a hotter thruster would be a hazard. Precision and safety, bought with propellant you spend freely.",
      realWorld: 'Cold-gas RCS provides fine, ignition-free attitude control on most spacecraft; Isp ~73 s.',
      formula: 'impulse-bit limited (mN·s)',
      trlRationale: 'Standard fine attitude/RCS propulsion.',
      unlockHint: 'Switch to cold-gas control mode.',
    },
  },
  {
    id: 'recoil_cancellation', category: 'PROPULSION', trl: 9, icon: '⚖️',
    related: ['cold_gas_rcs', 'spring_energy', 'rcs_attitude_control'],
    i18n: {
      title: 'Recoil Cancellation',
      shortText: 'Launch two daughters in opposite directions at once and their equal, opposite momenta cancel the mothership\u2019s kick.',
      fullText: "Newton's third law is unforgiving: every daughter you launch shoves the mothership backward by an equal and opposite momentum. Do it carelessly and the ship drifts and spins a little more with each release, spending propellant to correct.\n\nDual-launch turns the law against itself. Fire two daughters in opposite directions at the same instant and their momenta cancel, leaving the mothership essentially unmoved. Because a Weaver outmasses a Spinner, a small residual remains, trimmed by a brief reaction-control burst. Real spacecraft use the same accounting trick, storing angular momentum internally in reaction wheels rather than letting every action throw the whole vehicle off station.",
      realWorld: "Momentum conservation (Newton's 3rd law); dual, opposed launch cancels net recoil, residual trimmed by RCS.",
      formula: 'Σ m·v = 0   (momentum conserved)',
      trlRationale: 'Direct application of momentum conservation.',
      unlockHint: 'Dual-launch two daughters at once.',
    },
  },
  {
    id: 'spring_energy', category: 'PROPULSION', trl: 2, icon: '🛰️',
    related: ['recoil_cancellation', 'cold_gas_thruster'],
    i18n: {
      title: 'Spring-Launched Daughters',
      shortText: 'Stored elastic energy flings a daughter clear at zero propellant cost — the thrusters only handle final approach.',
      fullText: "Instead of burning propellant to release a daughter, your cradle stores mechanical energy in a compressed spring, wound up through a worm gear to hold a couple of joules. On release that elastic energy accelerates the 2-7 kilogram daughter to roughly half a metre to a metre and a half per second, enough to open a working gap for proximity operations.\n\nThe launch itself costs no propellant at all, only the electricity that wound the spring, which is the whole appeal, since fuel is the resource you cannot refill up here. The daughter's own FEEP thrusters then take over for the final approach. It is a deliberately low-energy shove: cheap, gentle, and repeatable.",
      realWorld: 'Stored elastic energy (½kx²) for propellant-free deployment; a game-speculative cradle mechanism.',
      formula: 'E = ½ k x²',
      trlRationale: 'Spring deployment concept; game-speculative implementation.',
      unlockHint: 'Fire the crossbow (spring launch).',
    },
  },
];

// The propellant_story track ordering lives in top-level `track`/`trackOrder`
// fields (outside the i18n template) that the full-entry rewrite above omits.
// Restore them so the Phase 1 "tracks" guard and the in-game track view survive.
const PROPELLANT_STORY = [
  'specific_impulse', 'feep_thruster', 'feep_indium', 'feep_gallium', 'feep_bismuth',
  'feep_iodine', 'feep_mercury', 'feep_cesium', 'feep_tungsten', 'mpd_burst',
  'xenon_propellant', 'krypton_propellant', 'argon_propellant', 'cold_gas_thruster',
];
for (const ne of NEW_ENTRIES) {
  const idx = PROPELLANT_STORY.indexOf(ne.id);
  if (idx >= 0) { ne.track = 'propellant_story'; ne.trackOrder = idx; }
}

// --- upsert by id (idempotent, order-independent) ---
for (const ne of NEW_ENTRIES) {
  const i = codex.entries.findIndex((e) => e.id === ne.id);
  if (i >= 0) codex.entries[i] = ne;
  else codex.entries.push(ne);
}

const rewrittenIds = new Set(NEW_ENTRIES.map((e) => e.id));

// PLAYBOOK cards teach; concept entries never ring back to a tutorial card.
const HEAL_SKIP_CATEGORIES = new Set(['PLAYBOOK']);

// --- heal inbound links orphaned by the rewrite (except tutorial back-links) ---
for (const ne of NEW_ENTRIES) {
  for (const other of codex.entries) {
    if (other.id === ne.id) continue;
    if (HEAL_SKIP_CATEGORIES.has(other.category)) continue;
    if ((other.related || []).includes(ne.id)) {
      ne.related = ne.related || [];
      if (!ne.related.includes(other.id)) ne.related.push(other.id);
    }
  }
}

// --- outbound symmetrization (also honouring HEAL_SKIP_CATEGORIES) ---
const byId = new Map(codex.entries.map((e) => [e.id, e]));
for (const ne of NEW_ENTRIES) {
  for (const rid of ne.related || []) {
    const target = byId.get(rid);
    if (!target || HEAL_SKIP_CATEGORIES.has(target.category)) continue;
    target.related = target.related || [];
    if (!target.related.includes(ne.id)) target.related.push(ne.id);
  }
}

writeFileSync(path, JSON.stringify(codex, null, 2) + '\n', 'utf8');
const counts = {};
for (const e of codex.entries) counts[e.category] = (counts[e.category] || 0) + 1;
console.log('[phase6c] entries now', codex.entries.length,
  '| MATERIALS', counts.MATERIALS, 'ATTITUDE', counts.ATTITUDE,
  'AVIONICS', counts.AVIONICS, 'HERITAGE', counts.HERITAGE, 'PROPULSION', counts.PROPULSION,
  `| rewrote ${rewrittenIds.size} entries`);
