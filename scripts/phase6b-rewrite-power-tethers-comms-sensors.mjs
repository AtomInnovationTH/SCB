#!/usr/bin/env node
// Phase 6b — Content batch B: rewrite POWER (15) + TETHERS (10) + COMMS (9) +
// SENSORS (10) to the deep-dive editorial template
// (see .kilo/plans/1782994412021-tech-library-deep-dive-overhaul.md §2).
//
// Same conventions as phase6a: upsert by id (idempotent, order-independent);
// `related` made symmetric two ways — pre-existing inbound links healed onto the
// rewritten entry (except tutorial PLAYBOOK back-links, kept one-directional),
// then reciprocated. Every unlockHint names a concrete action or observable and
// matches the entry's real trigger in codexTriggers.js (triggers unchanged).
//
// Facts web-verified during authoring where volatile (triple-junction ~30% vs
// ~20% silicon; Curiosity/Perseverance are RTG-powered, not solar; LCRD ~1 Gbps
// / TBIRD 200 Gbps / Starlink operational laser links; TDRS since 1983, phasing
// out; JAXA 1.8 kW/50 m 2015 + Caltech MAPLE 2023). Physics (Kepler-adjacent
// tether dynamics, Faraday EDT, Seebeck, Kalman 1960) is stable.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'data/codex.json');
const codex = JSON.parse(readFileSync(path, 'utf8'));

const NEW_ENTRIES = [
  // ================================ POWER (15) ================================
  {
    id: 'solar_power', category: 'POWER', trl: 9, icon: '☀️',
    related: ['sun_sensor', 'eclipse_cycle', 'multijunction_pv', 'battery_chemistry'],
    i18n: {
      title: 'Solar Panel Power Generation',
      shortText: "Solar panels turn sunlight into electricity, and make nothing the moment you cross into Earth's shadow.",
      fullText: "Sunlight is free power, and in low Earth orbit a panel delivers on the order of 300 watts per square metre while it is lit. The catch is the shadow: a low orbit spends roughly a third of every lap in eclipse, when the panels produce nothing at all.\n\nThat rhythm defines your power budget. The distribution system charges batteries in daylight and rations draw in darkness, and it must keep doing so as the panels slowly lose output to radiation and ultraviolet aging. Your mothership has run on this cycle since the first burn; every watt you spend on thrust, sensors, or daughters comes out of it.",
      realWorld: 'Flown on essentially every spacecraft since Vanguard 1 (1958); LEO arrays deliver ~300 W/m² in sunlight, zero in eclipse.',
      formula: 'P = η · G · A   (efficiency × solar flux × area)',
      trlRationale: 'Flown on every operational spacecraft since Vanguard 1 (1958).',
      unlockHint: 'Draw the battery below half charge.',
    },
  },
  {
    id: 'eclipse_cycle', category: 'POWER', trl: 9, icon: '🌑',
    related: ['solar_power', 'battery_chemistry', 'power_bus_management'],
    i18n: {
      title: 'Eclipse Cycles',
      shortText: "Every orbit drags you through Earth's shadow: about 35 dark minutes where the panels make nothing.",
      fullText: "In a 400 km orbit the mothership spends roughly 35 minutes of each 92-minute lap inside Earth's shadow. For that stretch the solar panels produce nothing, and everything aboard runs off the batteries charged during the sunlit side.\n\nThat makes eclipse the sizing case for the whole power system. Battery reserve, load-shedding priorities, and which subsystems may dim all get set by how you survive the dark side. Some draws, like electrodynamic-tether work or a hungry sensor sweep, may have to wait for sunrise so the essentials stay powered until you come back into the light.",
      realWorld: '~35 min eclipse per ~92-min LEO orbit; a fundamental constraint since Sputnik 1 (1957).',
      trlRationale: 'Fundamental LEO constraint since 1957.',
      unlockHint: "Fly into Earth's shadow (eclipse).",
    },
  },
  {
    id: 'multijunction_pv', category: 'POWER', trl: 9, icon: '☀️',
    related: ['solar_power', 'solar_cell_degradation'],
    i18n: {
      title: 'Multi-Junction Photovoltaics',
      shortText: 'Stack three materials, each tuned to a different slice of the spectrum, and one cell harvests far more sunlight.',
      fullText: "A plain silicon cell converts about 20% of the sunlight that hits it. A triple-junction cell stacks three semiconductor layers, each tuned to a different band of the spectrum: the top catches blue and ultraviolet, the middle visible light, the bottom infrared. Together they reach roughly 30% in space, half again as much power from the same area.\n\nThe price is cost, many times that of silicon per watt, so they fly where area and mass matter more than money: the International Space Station, communications satellites, and solar landers. Your arrays use them, so a smaller wing carries the load a silicon panel would need far more surface to match.",
      realWorld: 'Space triple-junction (GaAs) cells ~30% efficient vs ~20% for silicon; flown on the ISS, GEO satellites, and solar landers like InSight.',
      trlRationale: 'Triple-junction GaAs standard on GEO satellites and the ISS.',
      unlockHint: 'Buy the multi-junction solar upgrade.',
    },
  },
  {
    id: 'solar_cell_degradation', category: 'POWER', trl: 9, icon: '📉',
    related: ['solar_power', 'multijunction_pv', 'uv_degradation'],
    i18n: {
      title: 'Solar Cell Degradation',
      shortText: 'Radiation and ultraviolet steadily eat panel output: a couple of percent a year, gone for good.',
      fullText: "Solar arrays do not hold their rating. Proton and electron radiation damage the cells, ultraviolet light embrittles and clouds the cover glass, and micrometeoroids pit the surface. In low Earth orbit the loss runs about 2-3% of output per year, a little less in the calmer radiation higher up.\n\nOver a long mission it compounds: after fifteen years a panel may deliver only 60-70% of its beginning-of-life power, so designers oversize arrays to guarantee enough at end of life. It also makes salvage a gamble. Panels pulled off an old derelict can look intact yet supply a fraction of their original watts, one more reason a scavenged part's label lies.",
      realWorld: '~2-3%/yr output loss in LEO; arrays oversized for end-of-life power; measured on every long-duration mission.',
      trlRationale: 'Observed and modelled on every long-duration mission.',
      unlockHint: 'Take a solar-panel UV degradation warning.',
    },
  },
  {
    id: 'battery_chemistry', category: 'POWER', trl: 9, icon: '🔋',
    related: ['battery_cycles', 'solar_power', 'solid_state_battery'],
    i18n: {
      title: 'Space-Grade Batteries',
      shortText: 'Space Li-ion runs shallow on purpose: use a quarter of the pack and it survives tens of thousands of cycles.',
      fullText: "A satellite battery charges and discharges about 16 times a day, once per orbit, through swings of temperature and steady radiation. To survive that, space-grade lithium-ion cells are cycled shallow: only a quarter to a third of the capacity is used per orbit, because shallow cycles last far longer than deep ones.\n\nThat limit buys more than 50,000 cycles, roughly nine years of orbits or better. It also explains a quirk you will notice: the pack reads plenty of charge, yet the system calls 25% empty and refuses to go lower. It is not being stingy; it is protecting the one component you cannot swap out on station.",
      realWorld: 'Space Li-ion cycled at ~25-30% depth of discharge for 50,000+ cycles; flown since the 1990s.',
      trlRationale: 'Li-ion flown since 1990s; space-grade cells routine.',
      unlockHint: 'Fly until the mothership flags a battery-cycle note.',
    },
  },
  {
    id: 'battery_cycles', category: 'POWER', trl: 9, icon: '🔋',
    related: ['battery_chemistry', 'solid_state_battery', 'power_bus_management'],
    i18n: {
      title: 'Battery Cycle Life',
      shortText: 'Sixteen charge-discharge cycles a day, nearly 90,000 over a long mission: cycle life is a hard budget.',
      fullText: "Each orbit is one battery cycle: charge in sunlight, discharge in eclipse, sixteen times a day and about 5,840 times a year. Over a fifteen-year life that is nearly 90,000 cycles, far more than any phone battery will ever see.\n\nSpace cells meet it by trading depth for endurance, rated for 50,000-80,000 shallow cycles. Push the depth of discharge deeper and usable life falls off sharply, so the power manager guards it closely. Treat cycle life as a consumable like propellant: spend it carelessly with deep draws and the battery ages years early, long before anything else on the bus wears out.",
      realWorld: '16 cycles/day (~5,840/yr); space cells rated 50,000-80,000 cycles at shallow depth of discharge.',
      formula: 'cycles/yr ≈ 16 × 365 ≈ 5,840',
      trlRationale: 'Established design-for-life practice.',
      unlockHint: 'Read a battery subsystem alert.',
    },
  },
  {
    id: 'solid_state_battery', category: 'POWER', trl: 5, icon: '🔋',
    related: ['battery_chemistry', 'battery_cycles', 'graphene_supercap'],
    i18n: {
      title: 'Solid-State Batteries',
      shortText: 'Swap the liquid electrolyte for solid ceramic: no sloshing, no fire, and more energy per kilogram.',
      fullText: "A conventional lithium-ion cell carries a flammable liquid electrolyte. A solid-state cell replaces it with a solid ceramic or glass, which removes the fire risk from thermal runaway, tolerates temperature swings better, and packs perhaps 40% more energy per kilogram.\n\nFor a spacecraft cycling its pack every 92 minutes for years, those gains matter, but the technology is not yet flight-proven; carmakers and labs are racing to qualify it on the ground first. Your cells are an early space-rated version, shrugging off duty that would swell and melt a phone battery and buying more reserve for the same mass you had to haul to orbit.",
      realWorld: 'Automotive solid-state cells emerging (Toyota, QuantumScape); ~40% higher energy density; not yet space-qualified.',
      trlRationale: 'Automotive solid-state cells emerging; not yet space-qualified.',
      unlockHint: 'Buy the solid-state battery upgrade.',
    },
  },
  {
    id: 'supercapacitors', category: 'POWER', trl: 8, icon: '⚡',
    related: ['graphene_supercap', 'battery_chemistry', 'power_bus_management'],
    i18n: {
      title: 'Supercapacitors',
      shortText: 'Store less than a battery but dump it a hundred times faster: burst power for lassos, nets, and magnets.',
      fullText: "A supercapacitor holds far less total energy than a battery, but it can pour that energy out perhaps a hundred times faster and take millions of charge cycles without wearing down. That makes it the right tool for short, violent power demands.\n\nYour spacecraft trickle-charges a supercapacitor bank from the panels, then dumps it in milliseconds to fling a lasso, launch a net, or fire an electromagnet. A battery asked to deliver that spike would sag or degrade; the supercapacitor shrugs it off. The division of labour is deliberate: batteries for endurance, supercapacitors for the punch.",
      realWorld: 'Supercapacitor modules flown on CubeSats; mature for burst-power bus applications.',
      trlRationale: 'Supercap modules flown on CubeSats; mature for bus applications.',
      unlockHint: 'Fly until the mothership reports supercapacitor use.',
    },
  },
  {
    id: 'graphene_supercap', category: 'POWER', trl: 3, icon: '⚡',
    related: ['supercapacitors', 'solid_state_battery'],
    i18n: {
      title: 'Graphene Supercapacitors',
      shortText: 'Single-atom carbon sheets promise a supercapacitor with brutal power density, built for the MPD burst.',
      fullText: "Graphene is a one-atom-thick sheet of carbon, the strongest and most conductive material yet measured. Stacked with an insulating layer between sheets, it forms a supercapacitor that charges in seconds and survives millions of cycles, storing perhaps a tenth the energy of a battery but delivering it at far higher power density.\n\nThat profile suits one job on your ship in particular: the magnetoplasmadynamic (MPD) thruster's burst can draw around 150 kilowatts, a spike that would damage a battery asked to supply it. A graphene bank absorbs and releases that peak while the batteries handle the steady baseload. The material is still lab-scale, with no space heritage yet.",
      realWorld: 'Lab-scale graphene capacitors demonstrated; no space heritage; targeted at MPD-class burst loads.',
      trlRationale: 'Lab-scale graphene capacitors demonstrated; no space heritage.',
      unlockHint: 'Buy the graphene supercapacitor upgrade.',
    },
  },
  {
    id: 'rtg_power', category: 'POWER', trl: 9, icon: '☢️',
    related: ['solar_power', 'thermal_management', 'power_bus_management'],
    i18n: {
      title: 'Radioisotope Generators',
      shortText: 'Plutonium-238 decays and the heat becomes electricity: decades of steady power, no moving parts, no fuel to burn.',
      fullText: "A radioisotope thermoelectric generator (RTG) is elegantly simple. Plutonium-238 decays and gives off heat; thermocouples spanning the hot core and cold radiator fins turn that temperature difference straight into electricity, through the Seebeck effect. Nothing spins, nothing combusts, and the fuel fades on a half-life of 87.7 years.\n\nVoyager 1 has run on three of them for over 45 years and still transmits from interstellar space on a dwindling budget of watts. Your micro-RTG scales down the Multi-Mission RTG design flown on the Curiosity and Perseverance rovers. It ignores eclipse and cold entirely, quietly outlasting every other component you carry.",
      realWorld: 'Flown since SNAP-3 (1961); Voyager (45+ yrs), Curiosity and Perseverance (MMRTG); Pu-238 half-life 87.7 yr.',
      formula: 'V ∝ ΔT   (Seebeck effect: output tracks the temperature difference)',
      trlRationale: 'Flown since SNAP-3 (1961); Voyager, Curiosity, Perseverance.',
      unlockHint: 'Buy the RTG module upgrade.',
    },
  },
  {
    id: 'power_bus_management', category: 'POWER', trl: 9, icon: '⚡',
    related: ['eclipse_cycle', 'battery_cycles', 'thermal_management', 'solar_power'],
    i18n: {
      title: 'Power Bus ETS',
      shortText: 'When power runs short, the bus sheds loads in priority order: science first to go, survival systems last.',
      fullText: "A spacecraft distributes electricity over regulated buses, typically 28 or 100 volts of direct current. When generation drops, during eclipse or after a panel fault, an energy-transfer system sheds non-critical loads in a set order: science instruments first, then heaters, then communications, with attitude control and survival functions last to go.\n\nIt is damage control by another name, the same triage a warship runs when power gets tight. Your ship splits its power across three buses, Thrust, Sensors, and Daughters, so you can prioritise by hand. Deciding what to starve and what to protect when the budget is thin is one of the quiet skills of staying alive up here.",
      realWorld: 'Regulated 28 V / 100 V DC buses with priority load-shedding; standard on every spacecraft.',
      trlRationale: 'Standard load-shedding on every bus.',
      unlockHint: 'Switch a power bus.',
    },
  },
  {
    id: 'thermal_management', category: 'POWER', trl: 9, icon: '🌡️',
    related: ['mli_insulation', 'power_bus_management', 'rtg_power'],
    i18n: {
      title: 'Thermal Management',
      shortText: 'Sunlit surfaces bake past 120°C while shadowed ones freeze below -150°C, at the same time on the same hull.',
      fullText: "With no air to carry heat away, temperature in space is set entirely by radiation. A surface in direct sunlight can climb past 120°C while a shadowed one falls below -150°C on the very same spacecraft. Left alone, that gradient would crack structures and kill electronics.\n\nThe fixes work together, passive and active: multi-layer insulation blankets, heat pipes moving warmth to where it is needed, radiator panels dumping it to space, and heaters for the cold soak. Your bus holds around 20°C inside by balancing all of them, heaters on the shadow side and radiators on the sunlit side. Thermal control is invisible when it works and mission-ending when it does not.",
      realWorld: 'Radiative-only environment (+120°C sun / -150°C shade); MLI, heat pipes, radiators, heaters on every spacecraft.',
      trlRationale: 'MLI + heaters + radiators on every spacecraft.',
      unlockHint: 'Fly until the mothership flags a thermal gradient.',
    },
  },
  {
    id: 'mli_insulation', category: 'POWER', trl: 9, icon: '✨',
    related: ['thermal_management', 'atomic_oxygen'],
    i18n: {
      title: 'Multi-Layer Insulation (MLI)',
      shortText: "Those gold and silver blankets aren't styling: they're the most mass-efficient thermal armour there is.",
      fullText: "The gold and silver sheen of a spacecraft comes from multi-layer insulation (MLI): stacks of thin aluminised film separated by fine mesh spacers. Each layer reflects infrared radiation back, and twenty or thirty layers together cut radiative heat transfer by around 99%.\n\nBecause the layers are feather-light, MLI is the most mass-efficient thermal protection available, which is why nearly every spacecraft wears it. It keeps the deep cold of shadow out and trapped heat in, smoothing the brutal swing between sunlight and eclipse. On your ship it is the first line of the thermal system, the passive blanket the heaters and radiators only have to trim.",
      realWorld: '20-30 layers of aluminised film cut radiative transfer ~99%; standard exterior on essentially all spacecraft.',
      trlRationale: 'Ubiquitous — standard exterior on all spacecraft.',
      unlockHint: 'Fly until the mothership notes MLI thermal load.',
    },
  },
  {
    id: 'power_beaming', category: 'POWER', trl: 5, icon: '📡',
    related: ['solar_power', 'multijunction_pv'],
    i18n: {
      title: 'Wireless Power Transmission',
      shortText: 'Beam power as microwaves and a spacecraft can charge without carrying its own source: an old dream, now demonstrated.',
      fullText: "Nikola Tesla imagined transmitting power without wires in 1901; a century on, it works. A ground or orbital transmitter focuses a microwave or laser beam onto a receiving array, a rectenna, which converts the beam straight to direct-current electricity at high efficiency.\n\nThe demonstrations are real but small. JAXA beamed 1.8 kilowatts across 50 metres in 2015, and in 2023 Caltech's orbital experiment sent power to Earth for the first time, though only a trace reached the ground. Your receiver harvests a beam during the brief seconds you overfly a transmitter station, free power with no panel to age and no eclipse to wait out, pointing toward the far larger orbital power farms still on the drawing board.",
      realWorld: 'JAXA 1.8 kW over 50 m (2015); Caltech MAPLE beamed power to Earth (2023, proof of concept, trace power); no operational on-orbit heritage.',
      trlRationale: 'JAXA (2015) 1.8 kW over 50 m; Caltech MAPLE (2023) first space-to-Earth demo; no operational heritage.',
      unlockHint: 'Buy the power-beaming upgrade.',
    },
  },
  {
    id: 'spin_stabilization', category: 'POWER', trl: 9, icon: '🌀',
    related: ['detumble', 'net_yo_yo_despin'],
    i18n: {
      title: 'Spin Stabilization',
      shortText: 'A spinning body holds its heading like a thrown football: cheap stability, but a catch must be de-spun first.',
      fullText: "Spin a body up and its angular momentum resists any change in orientation, so it holds a steady heading without active control. Early satellites used this, rotating at a couple of revolutions per minute instead of carrying reaction wheels, simple and reliable at the cost of only pointing along the spin axis.\n\nDebris inherits the trick by accident: a dead satellite left tumbling is spin-stabilised whether it meant to be or not, and you cannot safely grab a spinning target. Your ablation laser de-spins one gently, vaporising a whisper of material off one side to make a tiny counter-torque, like stopping a merry-go-round with a garden hose, until the tumble is slow enough to catch.",
      realWorld: 'Spin stabilisation flown since Explorer 1 (1958); laser/ablation de-spin is an emerging debris-handling technique.',
      formula: 'L = I·ω   (angular momentum conserved; a spinning body resists reorientation)',
      trlRationale: 'Flown since Explorer 1 (1958).',
      unlockHint: 'De-spin a target with the ablation laser.',
    },
  },

  // =============================== TETHERS (10) ===============================
  {
    id: 'space_tether', category: 'TETHERS', trl: 5, icon: '🪢',
    related: ['tether_dynamics', 'tether_materials', 'edt_physics', 'tether_reel_in'],
    i18n: {
      title: 'Space Tethers',
      shortText: 'Cables kilometres long that trade momentum, make power, or reel a catch in, all without propellant.',
      fullText: "A space tether is a cable, sometimes tens of kilometres long, strung between two objects in orbit. Held taut, the gravity gradient keeps it pointing up and down, because the lower end wants to orbit faster than the upper end. That difference stores usable energy.\n\nExploited well, tethers exchange momentum between objects, generate power or thrust, and let you reel a captured object in without burning fuel. Demonstrations like the Shuttle's TSS-1R in 1996 and Europe's YES2 in 2007 proved the physics, though none is operational yet. Your daughters lean on the same principle to haul debris home on electricity instead of propellant.",
      realWorld: 'TSS-1R (1996) and YES2 (2007, ~31.7 km) demonstrated tether deployment; not yet operational.',
      trlRationale: 'TSS-1R (1996), YES2 (2007) demonstrated; not operational.',
      unlockHint: "Deploy a daughter's arm.",
    },
  },
  {
    id: 'tether_dynamics', category: 'TETHERS', trl: 9, icon: '〰️',
    related: ['space_tether', 'reel_mechanics', 'tether_materials'],
    i18n: {
      title: 'Tether Dynamics',
      shortText: 'A long tether behaves like a giant guitar string; let it oscillate and a capture turns dangerous.',
      fullText: "A 500-metre tether in orbit acts like an enormously long, thin guitar string. Gravity gradient, atmospheric drag, and electrodynamic forces all pluck it, setting up vibrations that travel its length. Deploy it too fast and the oscillations grow dangerous; too slow and you waste the mission clock.\n\nManaging those modes is the whole game. Your mothership's reel motor pays the tether out under controlled tension and actively damps the swaying, reading it back through tension sensors. A well-damped tether reels a tumbling catch home smoothly; an undamped one can whip, snag, or snap, which is why the reel never simply lets go and hauls.",
      realWorld: 'Tether oscillation modelled and observed on TSS-1R and YES2; active reel damping controls it.',
      trlRationale: 'Modelled and observed on TSS-1R, YES2.',
      unlockHint: 'Reel in a tether.',
    },
  },
  {
    id: 'tether_materials', category: 'TETHERS', trl: 9, icon: '🧵',
    related: ['space_tether', 'tether_dynamics', 'tether_reel_in'],
    i18n: {
      title: 'Tether Materials: Dyneema & Zylon',
      shortText: 'Dyneema and Zylon fibres out-pull steel at an eighth the weight: the reason a thread can haul a satellite.',
      fullText: "A tether has to be impossibly strong and impossibly light at once, so it is spun from ultra-high-strength polymer fibre. Dyneema (ultra-high-molecular-weight polyethylene) and Zylon (PBO) reach tensile strengths of 3-6 gigapascals, matching steel at roughly an eighth of the density.\n\nEach has a catch. Zylon is stronger but degrades under ultraviolet light, while Dyneema holds up better in the low-orbit environment. Your tether upgrades climb through progressively tougher fibres, and each step buys longer deployments and heavier captures. The fibre's strength-to-weight is the real limit: it sets how big a derelict a thread the width of a shoelace can safely drag.",
      realWorld: "Dyneema (UHMWPE) and Zylon (PBO) reach 3-6 GPa at ~1/8 steel's density; Zylon degrades under UV.",
      formula: 'specific strength = tensile strength / density   (the figure of merit)',
      trlRationale: 'Dyneema/Zylon flown as lanyards; fibre properties well-characterised.',
      unlockHint: 'Fit a tether upgrade.',
    },
  },
  {
    id: 'tether_reel_in', category: 'TETHERS', trl: 4, icon: '🎣',
    related: ['space_tether', 'reel_mechanics', 'tether_materials'],
    i18n: {
      title: 'Tether Reel-In: Free ΔV',
      shortText: 'Reeling a catch in costs no propellant: the orbital energy difference does the work for you.',
      fullText: "When a daughter captures debris and the reel hauls it in, gravity foots the bill. As the tether shortens, the captured object drops to a lower orbit and gives up energy while the mothership gains it, and because your ship massively outweighs the catch, the exchange is essentially free.\n\nThat is why tethered capture beats a chemical rendezvous for cleanup: no propellant is spent bringing the target home, only the electricity to run the reel motor and its brake. Fuel is the one resource you cannot refill up here, so a method that trades it for winch power changes what is worth chasing. Every catch reeled in cost you watts, not delta-V.",
      realWorld: 'Motorised tether reel-in demonstrated in ground and lab tests; propellant-free retrieval via orbital-energy exchange.',
      trlRationale: 'Motorised reel capture demonstrated in ground/lab tests only.',
      unlockHint: 'Capture a target with an arm.',
    },
  },
  {
    id: 'reel_mechanics', category: 'TETHERS', trl: 3, icon: '🎣',
    related: ['space_tether', 'tether_dynamics', 'tether_reel_in', 'net_yo_yo_despin'],
    i18n: {
      title: 'Motorized Reel Mechanics',
      shortText: 'The mothership reel motor does the hauling on electricity alone: retrieval that spends watts, not fuel.',
      fullText: "Most capture concepts burn propellant to drag a catch back. Yours does not: a motorised reel on the mothership winches the tether in, drawing about 15 watts and pulling at a quarter-metre per second under load, half that empty. The mechanical advantage means retrieval costs electricity, never fuel.\n\nA tumbling catch fights back, so the reel carries a brake to ride out the tension spikes as an off-balance target jerks the line. Get it right and a dead satellite comes home on winch power alone. Get it wrong and a spike can snap the tether, which is why the reel controls tension as carefully as it controls speed.",
      realWorld: 'Mothership-mounted powered reel (~15 W, ~0.25 m/s loaded) is game-speculative; grounded in real winch-capture research.',
      trlRationale: 'Mothership-mounted reel is game-speculative.',
      unlockHint: 'Reel in a tether.',
    },
  },
  {
    id: 'edt_physics', category: 'TETHERS', trl: 5, icon: '⚡',
    related: ['space_tether', 'tether_dynamics', 'tether_materials'],
    i18n: {
      title: 'Electrodynamic Tethers',
      shortText: 'Drag a conductive cable through Earth\u2019s magnetic field and it makes current: thrust or drag with no propellant.',
      fullText: "An electrodynamic tether (EDT) is a long conductive wire, and moving it through Earth's magnetic field induces a voltage along its length, by Faraday's law of induction. Let that current flow and the field pushes back on the wire, giving thrust or drag on demand, all without spending propellant.\n\nThat makes EDTs a tempting deorbit tool: run the current one way and you drag a derelict down for free. The Shuttle's TSS-1R deployed a nearly 20 km tether in 1996 and generated some 3,500 volts before the tether abruptly snapped, a reminder that the forces are large and the engineering unforgiving. The physics is proven; a robust operational system is not here yet.",
      realWorld: 'TSS-1R (1996) generated ~3,500 V on a ~20 km tether before it snapped; EDT deorbit not yet operational.',
      formula: 'EMF = ∫ (v × B) · dL   (motional induction along the tether)',
      trlRationale: 'TSS-1R demonstrated EDT current generation; not operational.',
      unlockHint: 'Fly until the mothership mentions the electrodynamic tether.',
    },
  },
  {
    id: 'net_yo_yo_despin', category: 'TETHERS', trl: 6, icon: '🪀',
    related: ['miura_ori_net', 'bolas_weapon', 'reel_mechanics', 'spin_stabilization'],
    i18n: {
      title: 'Net Spin & the Yo-Yo Despin',
      shortText: 'The net launcher spins the canister; radius growth, not torque, is what slows the blossom.',
      fullText: "A capture net leaves its launcher spinning fast: the spin table torques the canister, and the daughter's reaction wheel soaks up the equal-and-opposite kick. Once it is flying free, no external torque acts on the net, so its angular momentum L = Iω is conserved.\n\nAs the rim weights fly outward and the mouth blossoms open, the moment of inertia grows with radius squared, so the spin rate must fall to keep L fixed. This is the yo-yo despin effect, the same trick sounding rockets have used since the 1960s, with no fuel and no brakes. The settled spin ({{CAPTURE_NET.LARGE.SPIN_HZ*60}}/{{CAPTURE_NET.MEDIUM.SPIN_HZ*60}}/{{CAPTURE_NET.SMALL.SPIN_HZ*60}} RPM by net class) keeps centripetal tension on each rim weight high enough to hold the mouth open in zero gravity until the cinch fires.",
      realWorld: 'RemoveDEBRIS net demo (2018); yo-yo despin flown on sounding rockets since the 1960s.',
      formula: 'L = I·ω = const;  I ∝ r²   (spin rate falls as the net opens)',
      trlRationale: 'RemoveDEBRIS net demo (2018); yo-yo despin flown on sounding rockets since the 1960s.',
      unlockHint: 'Fire a capture net.',
    },
  },
  {
    id: 'miura_ori_net', category: 'TETHERS', trl: 7, icon: '📐',
    related: ['net_yo_yo_despin', 'bolas_weapon', 'tether_materials'],
    i18n: {
      title: 'Miura-Ori Net Folding',
      shortText: 'A fold pattern from origami packs a net flat, then unfurls it completely with one pull.',
      fullText: "Miura-ori is a rigid folding pattern devised by Koryo Miura to stow satellite solar arrays. It collapses a flat sheet into a compact stack that springs fully open from a single diagonal pull, with no snagging and no separate hinges.\n\nYour capture nets borrow it. Stowed, the net is a tight package; on contact a shape-memory-alloy cinch wire triggers, and the Miura-ori pattern unfolds the mesh to envelop the target in under three seconds. The appeal is reliability: one actuation, one clean deployment, in an environment where a jammed fold means a missed catch. The pattern first flew on Japan's SFU spacecraft in 1995.",
      realWorld: "Miura-ori flown on Japan's SFU (1995); net capture demonstrated by RemoveDEBRIS (2018).",
      trlRationale: 'Miura-ori flown on SFU (1995); net capture via RemoveDEBRIS (2018).',
      unlockHint: 'Fire the crossbow net.',
    },
  },
  {
    id: 'bolas_weapon', category: 'TETHERS', trl: 3, icon: '🥅',
    related: ['net_yo_yo_despin', 'miura_ori_net', 'tether_materials'],
    i18n: {
      title: 'Capture Net — Weighted Mesh',
      // shortText is locked by the FIX-2.4a visuals contract (test-BolasVisuals.js);
      // keep it verbatim so the codex text stays in step with the net visuals.
      shortText: 'Capture net. A weighted Dyneema mesh spun open by gyroscopic rotation. Gentle enough for delicate debris — and it still works in vacuum.',
      fullText: "The lasso is a spinning octagonal net of lightweight Dyneema lines, its perimeter studded with small weights that centrifugal force holds spread open in flight. Launched on a tether, it needs no rigid frame and no propellant of its own.\n\nOn contact the mesh wraps around the target rather than striking it, gentle enough for a fragile or oddly shaped derelict that a rigid grab would shatter or send tumbling. Then the reel takes over and draws the whole bundle back to the mothership intact. It is a deliberately low-violence capture: catch first, ask questions later, without adding fresh fragments to the field you are trying to clear.",
      realWorld: 'Spinning-net (bolas) capture is conceptual; nets flown on RemoveDEBRIS (2018).',
      trlRationale: 'Spinning net / bolas capture is conceptual; no flight heritage.',
      unlockHint: 'Fire the lasso.',
    },
  },
  {
    id: 'tether_tangle_physics', category: 'TETHERS', trl: 2, icon: '🪢',
    related: ['reel_mechanics', 'tether_dynamics'],
    i18n: {
      title: 'Tether Tangle Physics',
      shortText: 'Cross two tethers under tension and friction locks them; freeing the snarl takes a timed slack pulse.',
      fullText: "Run several daughters on tethers at once and the lines can cross. Under tension, friction at the crossing point locks them together, and pulling harder only cinches the snarl tighter, the bane of multi-tether operations.\n\nThe fix is counterintuitive: inject a precisely timed slack pulse into one line so it briefly floats free of the other while the second stays taut, letting the crossing slip apart. Your cradle watches tension across all the tethers and auto-resolves minor crossings this way, but a bad tangle still needs a manual hand, or, as a last resort, cutting a line free and writing off the catch on it.",
      realWorld: 'Multi-tether operations not yet flown; slack-pulse untangling is a game concept grounded in cable-friction mechanics.',
      trlRationale: 'Game concept — multi-tether space operations not yet flown.',
      unlockHint: 'Tangle two tethers.',
    },
  },

  // ================================ COMMS (9) ================================
  {
    id: 'bandwidth_limits', category: 'COMMS', trl: 9, icon: '📶',
    related: ['telemetry_bandwidth', 'frequency_bands', 'ground_station_pass'],
    i18n: {
      title: 'Bandwidth & Data Rates',
      shortText: 'A satellite downlink is thinner than bad home internet; every bit has to earn its place in the stream.',
      fullText: "A common S-band downlink carries only about 2 megabits per second, less than a weak home connection, and it is shared across everything the ship wants to say. With six daughters generating telemetry, sensor returns, and video at once, the pipe fills instantly.\n\nSo you triage the bits. Compression, prioritisation, and store-and-forward all help, but sometimes the honest answer is that only one daughter gets a live feed while the rest send numbers. Bandwidth is a budget like any other up here, and choosing what not to send is as much a part of the job as choosing what to.",
      realWorld: 'Typical S-band downlink ~2 Mbps, shared across all traffic; compression and prioritisation are standard practice.',
      trlRationale: 'Fundamental comms architecture.',
      unlockHint: 'Fly until the mothership flags a bandwidth limit.',
    },
  },
  {
    id: 'telemetry_bandwidth', category: 'COMMS', trl: 9, icon: '📶',
    related: ['bandwidth_limits', 'frequency_bands', 'laser_comms'],
    i18n: {
      title: 'Telemetry Bandwidth',
      shortText: "Six daughters talking at once won't fit one S-band pipe; someone gets numbers, not live video.",
      fullText: "Standard S-band telemetry runs at 1-2 megabits per second, and every daughter shares it. Their combined telemetry, commands, and science can easily outstrip the link, so you cannot pull high-resolution video from all six at the same time; something gives.\n\nMoving up in frequency buys room. Ka-band around 26 gigahertz offers roughly ten times the data rate, and an optical link more still, but each demands tighter antenna pointing and more power. Your ship starts on rugged, forgiving S-band and trades up as its attitude control and power allow. The data bus feeding the radio, the spacecraft's internal wiring, has to keep pace too.",
      realWorld: 'S-band ~1-2 Mbps; Ka-band ~10× more; optical more still, at the cost of pointing and power.',
      trlRationale: 'S-band telemetry standard since 1960s.',
      unlockHint: 'Take a telemetry bandwidth event.',
    },
  },
  {
    id: 'frequency_bands', category: 'COMMS', trl: 9, icon: '📡',
    related: ['bandwidth_limits', 'telemetry_bandwidth', 'laser_comms'],
    i18n: {
      title: 'S-Band vs Ka-Band',
      shortText: 'Higher radio bands carry more data but demand bigger dishes and finer aim: power and pointing for throughput.',
      fullText: "Radio bands trade robustness for capacity. S-band, near 2 gigahertz, is forgiving: a small omnidirectional antenna holds the link, but it tops out around 2 megabits per second. Ka-band, near 26 gigahertz, offers roughly ten times the data rate but needs a steerable dish aimed precisely. X-band, near 8 gigahertz, sits between them and serves military and deep-space work.\n\nThe higher you climb in frequency, the more you pay in antenna size, pointing accuracy, and power, and the more weather and ionospheric disturbances bite. Your ship begins on S-band and earns its way up: reaching Ka-band or an optical link means first affording the attitude control and power that finer beams demand.",
      realWorld: 'S-band ~2 GHz (robust, ~2 Mbps); X-band ~8 GHz; Ka-band ~26 GHz (~10× data, needs precise pointing); ITU-coordinated.',
      trlRationale: 'ITU-coordinated bands since 1960s.',
      unlockHint: 'Fly out of the South Atlantic Anomaly.',
    },
  },
  {
    id: 'laser_comms', category: 'COMMS', trl: 8, icon: '🔦',
    related: ['frequency_bands', 'telemetry_bandwidth', 'bandwidth_limits'],
    i18n: {
      title: 'Laser Communications',
      shortText: 'Send data on a laser instead of radio: far more bandwidth, if you can hold the aim within microradians.',
      fullText: "Optical, or laser, communications carry data on a modulated light beam instead of radio waves, buying enormous bandwidth. NASA's LCRD relay, launched in 2021, works at roughly a gigabit per second, and a 2023 CubeSat experiment, TBIRD, hit 200 gigabits per second to the ground, orders of magnitude beyond radio.\n\nThe price is precision and weather. Both ends must aim within microradians, and cloud simply blocks the beam, so operators keep several ground sites and switch between them. The technology has crossed into real use: SpaceX's Starlink now routes traffic over laser links between thousands of satellites. Your optical downlink to Svalbard works because the Arctic offers clear, dark skies.",
      realWorld: 'NASA LCRD (2021, ~1 Gbps); TBIRD (2023) 200 Gbps to ground; Starlink runs operational laser inter-satellite links at scale.',
      trlRationale: 'LCRD (2021), TBIRD (2023), Starlink optical links operational; ground-to-space still weather-limited.',
      unlockHint: 'Fly until the mothership flags the laser comms link.',
    },
  },
  {
    id: 'ground_station_pass', category: 'COMMS', trl: 9, icon: '📻',
    related: ['ground_station_window', 'tdrs_relay', 'bandwidth_limits'],
    i18n: {
      title: 'Ground Station Passes',
      shortText: 'You can only talk when a station is in view: a few minutes per orbit, then silence until the next pass.',
      fullText: "A low-orbit spacecraft can only reach a ground station while it has line of sight, and that window is short: five to fifteen minutes per pass, depending on how high overhead the track runs. Between passes there is nothing but the onboard recorder.\n\nGlobal networks with sites like Houston, Canberra, and Madrid stitch the passes into near-continuous coverage for those who can afford it, but a commercial operator may get only a handful of contacts a day. That rhythm shapes operations: you store data, prioritise what to dump, and plan the important conversations for when a station is actually above the horizon.",
      realWorld: 'LEO passes last ~5-15 min; global networks (Houston, Canberra, Madrid) approach continuous coverage; a fundamental constraint.',
      trlRationale: 'Fundamental LEO constraint.',
      unlockHint: 'Make a ground-station pass.',
    },
  },
  {
    id: 'ground_station_window', category: 'COMMS', trl: 9, icon: '📡',
    related: ['ground_station_pass', 'tdrs_relay', 'bandwidth_limits'],
    i18n: {
      title: 'Contact Windows',
      shortText: 'Contact is rationed by geometry, so spacecraft hoard data and dump it in the brief window a station is up.',
      fullText: "Because a station is only overhead for minutes at a time, a spacecraft lives by store-and-forward: it records continuously and unloads in the short window when a ground site comes into range. Miss the window and the data waits a full orbit or more for the next one.\n\nThat scarcity drives the whole contact plan. Operators schedule which commands go up and which data comes down against a known timetable of passes, and the recorder must be sized so nothing important is overwritten before it can be sent. When the mothership calls a station coming into range, it is opening one of those narrow, precious windows.",
      realWorld: 'Store-and-forward against a scheduled pass timetable; onboard recorders sized to bridge the gaps between contacts.',
      trlRationale: 'Fundamental LEO constraint.',
      unlockHint: 'Fly until the mothership flags a ground station coming into range.',
    },
  },
  {
    id: 'tdrs_relay', category: 'COMMS', trl: 9, icon: '🛰️',
    related: ['ground_station_pass', 'ground_station_window', 'signal_propagation'],
    i18n: {
      title: 'TDRS Relay Satellites',
      shortText: 'Relay satellites parked in high orbit give a low flyer near-constant contact, with no waiting for the next pass.',
      fullText: "Instead of waiting for the ground to rotate a station under you, you can relay through a satellite that always sees both you and home. NASA's Tracking and Data Relay Satellite System parks relays in geostationary orbit, giving low-orbit spacecraft near-continuous contact; the International Space Station routes most of its traffic this way.\n\nThe system has run since 1983, when the Space Shuttle became its first user, and it is now slowly being handed off to commercial relay providers. The idea is unchanged: a few high, always-visible relays beat a scattered ring of ground sites for staying in touch. For a busy operation, continuous contact is worth more than raw data rate.",
      realWorld: 'NASA TDRSS relays in GEO, operational since 1983; used by the ISS; now being phased over to commercial relays.',
      trlRationale: 'TDRS operational since 1983.',
      unlockHint: 'Clear 30 pieces of debris.',
    },
  },
  {
    id: 'signal_propagation', category: 'COMMS', trl: 9, icon: '⏳',
    related: ['tdrs_relay', 'ground_station_pass'],
    i18n: {
      title: 'Signal Propagation Delay',
      shortText: 'Light to low orbit takes barely a millisecond, yet relays and processing stretch the round trip past half a second.',
      fullText: "Radio travels at the speed of light, so the raw hop to a 400 km orbit is only about 1.3 milliseconds. The delay you actually feel is almost entirely the rest of the chain: encoding, error correction, ground processing, network routing, and any relay hops.\n\nGo through a geostationary relay and the signal climbs to 36,000 km and back, adding a couple hundred milliseconds by itself. Total round-trip latency lands around 400-800 milliseconds, enough to feel when you fly a daughter by hand: the view is a little stale and your command lands a little late. It is why close, fast work leans on onboard autonomy rather than a joystick from the ground.",
      realWorld: 'Raw LEO light-time ~1.3 ms; a GEO relay hop adds ~240 ms; real round-trip latency ~400-800 ms.',
      formula: 't = d / c   (c ≈ 300,000 km/s)',
      trlRationale: 'Speed of light — established science.',
      unlockHint: 'Take a message from Houston.',
    },
  },
  {
    id: 'comms_blackout', category: 'COMMS', trl: 9, icon: '📵',
    related: ['signal_propagation', 'frequency_bands'],
    i18n: {
      title: 'Communications Blackout',
      shortText: 'Charged particles can scramble a radio link, and a reentry plasma sheath can silence it completely.',
      fullText: "Radio does not always get through. During solar events or a pass through the South Atlantic Anomaly, energetic particles ionise the upper atmosphere unevenly, scattering signals into scintillation and, at worst, a blackout. The link degrades or drops until the disturbance passes.\n\nThe extreme case is reentry, when the superheated plasma sheath around a returning craft blocks radio entirely; Apollo crews rode out minutes of enforced silence on every return. You meet the milder version as comms fade during a South Atlantic Anomaly crossing. The lesson is the one every operator learns: never count on the link being there at the exact moment you need it most.",
      realWorld: 'Ionospheric scintillation during solar events and SAA passes; reentry plasma blackout (famous on Apollo returns).',
      trlRationale: 'Observed since Gemini re-entry.',
      unlockHint: 'Fly through a comms blackout.',
    },
  },

  // =============================== SENSORS (10) ===============================
  {
    id: 'lidar_sensing', category: 'SENSORS', trl: 9, icon: '🔴',
    related: ['lidar_ranging', 'pulse_scan_radar', 'pose_estimation'],
    i18n: {
      title: 'LIDAR — Time of Flight',
      shortText: 'Fire a laser pulse, time the echo: at light speed, one nanosecond of delay is 30 cm of distance.',
      fullText: "Lidar (light detection and ranging) measures distance by timing light. It fires a short laser pulse, waits for the reflection, and converts the round-trip time into range; because light covers 30 centimetres per nanosecond, precise timing gives precise distance.\n\nSweep the beam and you get more than a single number: a point cloud of the target's surface, and, by watching how points shift between pulses, a read on how it is rotating. Your sensor suite uses lidar to range nearby debris and gauge its tumble. Unlike a camera it does not need sunlight, which matters when half of every orbit is spent in shadow.",
      realWorld: 'Flash lidar flown for rendezvous on Dragon and Cygnus since ~2012; light-time ranging at 30 cm/ns.',
      formula: 'd = c · t / 2   (round-trip time of flight)',
      trlRationale: 'Flash LIDAR flown on Dragon, Cygnus since 2012.',
      unlockHint: 'Upgrade a sensor.',
    },
  },
  {
    id: 'lidar_ranging', category: 'SENSORS', trl: 9, icon: '🔦',
    related: ['lidar_sensing', 'pose_estimation', 'docking_precision'],
    i18n: {
      title: 'LIDAR Ranging',
      shortText: 'Up close, lidar maps a target to the millimetre: enough to model its tumble before you commit to a catch.',
      fullText: "At close range, under a kilometre, lidar does more than range: it builds a centimetre-resolution three-dimensional map of a target's surface, accurate to the millimetre in distance. That detail turns a blip into something you can plan a capture against.\n\nYour daughters run lidar through the approach, assembling a tumble model of the derelict, its spin axis, rate, and shape, before anyone commits a net. Grab without that model and a fast or off-axis tumble will slap the net aside or wrench the tether. The map is the difference between a clean envelope and a fumbled catch that only adds to the mess.",
      realWorld: 'Close-range flash lidar gives mm-precision ranging and cm-resolution 3-D maps; used for rendezvous on Dragon and Cygnus.',
      trlRationale: 'Flash lidar rendezvous heritage on Dragon and Cygnus.',
      unlockHint: 'Capture a target with an arm.',
    },
  },
  {
    id: 'pose_estimation', category: 'SENSORS', trl: 8, icon: '👁️',
    related: ['lidar_ranging', 'docking_precision', 'kalman_filtering', 'star_tracker'],
    i18n: {
      title: 'Visual Pose Estimation',
      shortText: 'Your target is tumbling, unlit, and never built to be caught; a camera and hard math still work out its exact pose.',
      fullText: "To grab a derelict you first have to know precisely where it is and how it is tumbling: its full six-degrees-of-freedom pose, position plus orientation. A cooperative spacecraft makes this easy with markers or a radio link, but debris offers none of that. It is non-cooperative, with no beacons, no markers, and often spinning in shadow.\n\nVisual pose estimation solves it with cameras and algorithms that either match the live image against a three-dimensional model of the target or track its features frame to frame, recovering the relative pose in real time. It is the perception layer beneath every capture, and it is being actively demonstrated in European and Japanese debris-removal and servicing programs. Non-cooperative capture is exactly where it is still maturing.",
      realWorld: 'Vision-based relative navigation for non-cooperative targets; demonstrated in ESA and JAXA debris-removal and servicing programs.',
      trlRationale: 'Demonstrated in servicing/ADR programs; non-cooperative capture still maturing.',
      unlockHint: 'Clear 19 pieces of debris.',
    },
  },
  {
    id: 'docking_precision', category: 'SENSORS', trl: 9, icon: '🎯',
    related: ['pose_estimation', 'lidar_ranging', 'rendezvous', 'docking_berthing'],
    i18n: {
      title: 'Proximity Navigation',
      shortText: 'The last hundred metres of an approach demand centimetre accuracy; one clumsy nudge sends the target tumbling.',
      fullText: "Rendezvous and proximity operations live or die in the final hundred metres. Getting there means fusing lidar, optical cameras, and relative satellite navigation into a position estimate good to centimetres, with closing speed dropping below a tenth of a metre per second and alignment held within a few degrees.\n\nYour daughters run the same discipline on final approach to a derelict. Come in too fast or off-axis and you do not capture the target, you punch it into an unpredictable tumble that is harder and more dangerous to catch on the next try. Precision here is not elegance for its own sake; it is the difference between a clean grip and making the problem worse.",
      realWorld: 'RPO fuses lidar, optical, and relative satellite navigation to cm precision; docking systems operational on Dragon and Starliner.',
      trlRationale: 'IDSS/NDS operational on Dragon, Starliner.',
      unlockHint: 'Close on a target under relative navigation.',
    },
  },
  {
    id: 'star_tracker', category: 'SENSORS', trl: 9, icon: '⭐',
    related: ['sun_sensor', 'imu_drift', 'kalman_filtering', 'pose_estimation'],
    i18n: {
      title: 'Star Trackers',
      shortText: 'A camera that reads the star field like a fingerprint, fixing which way you point to a thousandth of a degree.',
      fullText: "A star tracker photographs the sky and matches the pattern it sees against an onboard catalogue of a few thousand stars. From that match it works out which way the spacecraft is pointing, to arcsecond accuracy, the finest attitude reference most vehicles carry.\n\nThat precision is what lets you aim an antenna, a sensor, or a thruster with confidence. It has limits: point one near the Sun and it is blinded, near the Moon and the pattern-matcher can be fooled, so a spacecraft carries several facing different ways. Paired with a sun sensor for coarse reference and an inertial unit to coast between fixes, the star tracker anchors the whole attitude solution.",
      realWorld: 'Pattern-matches a few thousand catalogued stars to arcsecond accuracy; ubiquitous attitude sensor since the 1980s.',
      trlRationale: 'Ubiquitous attitude sensor since 1980s.',
      unlockHint: 'Fly until the mothership flags the star tracker.',
    },
  },
  {
    id: 'sun_sensor', category: 'SENSORS', trl: 9, icon: '🌞',
    related: ['star_tracker', 'imu_drift', 'solar_power'],
    i18n: {
      title: 'Sun Sensors',
      shortText: "The cheapest, oldest trick in attitude control: look at the Sun, and you know which way you're facing.",
      fullText: "A sun sensor measures the direction to the Sun, giving a quick, dependable reference for which way a spacecraft points. Coarse versions are little more than light detectors reporting roughly where the Sun sits, enough to spin up out of a tumble or aim solar panels. Fine versions are far more precise and feed the attitude determination system directly.\n\nThey are among the simplest, cheapest, and oldest attitude sensors, flown since the earliest satellites, and almost every spacecraft still carries some form as a backstop to the fussier star tracker. When the fancy sensor is blinded by sunlight or confused, the humble sun sensor is often what keeps a vehicle oriented. Reliability, not precision, is its whole point.",
      realWorld: 'Flown since the earliest satellites; coarse and fine variants on nearly every spacecraft.',
      trlRationale: 'Flown since the dawn of the satellite era.',
      unlockHint: 'Clear 9 pieces of debris.',
    },
  },
  {
    id: 'imu_drift', category: 'SENSORS', trl: 9, icon: '🧭',
    related: ['star_tracker', 'sun_sensor', 'kalman_filtering'],
    i18n: {
      title: 'Inertial Measurement Unit',
      shortText: 'Gyros and accelerometers dead-reckon your motion between star fixes, accurate but slowly drifting off truth.',
      fullText: "An inertial measurement unit (IMU) packs three gyroscopes and three accelerometers, sensing rotation and acceleration directly. Between star-tracker fixes it dead-reckons the spacecraft's attitude, integrating its own readings to say how the vehicle has turned.\n\nThe weakness is drift: tiny measurement errors accumulate, so the estimate slowly wanders from truth and must be corrected against an absolute reference. Modern fibre-optic gyros drift only about a hundredth of a degree an hour; the mechanical gyros of the Apollo era were far worse, forcing crews to realign every few hours against the stars. Pair the IMU with a star tracker and you get the best of both: absolute fixes, smoothly bridged.",
      realWorld: 'Fibre-optic gyros drift ~0.01°/hr, far better than Apollo-era mechanical gyros; standard since the 1990s.',
      trlRationale: 'Fibre-optic gyros standard since 1990s.',
      unlockHint: 'Fly until the mothership flags IMU drift.',
    },
  },
  {
    id: 'kalman_filtering', category: 'SENSORS', trl: 9, icon: '📊',
    related: ['imu_drift', 'star_tracker', 'pose_estimation'],
    i18n: {
      title: 'Kalman Filtering',
      shortText: 'Every sensor lies a little; the Kalman filter blends their lies into one estimate better than any alone.',
      fullText: "No sensor is exact. Satellite navigation carries metres of error, a star tracker has arcsecond jitter, an inertial unit drifts. The Kalman filter, published by Rudolf Kalman in 1960, is the algorithm that fuses such noisy streams optimally, weighting each by its known uncertainty to produce an estimate better than any single input.\n\nIt runs almost everywhere a position or attitude must be tracked, from the Apollo guidance computer to the phone in your pocket. On your ship it runs on every debris contact, blending radar, lidar, and optical returns into one confident track. Without it you would have several disagreeing measurements and no principled way to choose; with it you get a single number and a bound on how far to trust it.",
      realWorld: 'Kalman filter (Rudolf Kalman, 1960); flown on Apollo guidance; standard in navigation everywhere since.',
      trlRationale: 'Used since Apollo (1969).',
      unlockHint: 'Clear 20 pieces of debris.',
    },
  },
  {
    id: 'gps_denied', category: 'SENSORS', trl: 8, icon: '📡',
    related: ['imu_drift', 'star_tracker', 'kalman_filtering'],
    i18n: {
      title: 'GPS-Denied Navigation',
      shortText: 'Lose the satnav fix and you fall back on stars and inertial sensors: dead reckoning until the signal returns.',
      fullText: "Satellite navigation is not guaranteed in orbit. Solar storms, South Atlantic Anomaly passes, and simple geometry can block or degrade the signal, leaving a spacecraft to find itself another way.\n\nThe fallback is onboard: a star tracker matching star patterns for absolute attitude, and an inertial unit dead-reckoning motion, with a Kalman filter fusing the two into a usable position estimate. Military spacecraft are built to run this way from the start, never trusting an outside signal an adversary could deny. Your ship treats a lost fix the same way, leaning on its own senses rather than waiting for the constellation to come back.",
      realWorld: 'GPS-denied navigation via star trackers + inertial units + Kalman fusion; standard on military spacecraft.',
      trlRationale: 'Military GPS-denied nav; still maturing on civilian platforms.',
      unlockHint: 'Take a GPS-denied navigation event.',
    },
  },
  {
    id: 'pulse_scan_radar', category: 'SENSORS', trl: 3, icon: '📡',
    related: ['lidar_sensing', 'docking_precision'],
    i18n: {
      title: 'Distributed Pulse Scan',
      shortText: 'Time pulses from daughters spread across hundreds of metres and the swarm acts as one giant radar dish.',
      fullText: "A single small radar antenna sees the sky coarsely; its resolution is set by its size, and a daughter's dish is tiny. The distributed pulse scan gets around that by firing radar pulses from several daughters spread across hundreds of metres and combining the returns with precise timing.\n\nThat synthesises an aperture the size of the whole constellation, a virtual antenna far larger than any one craft carries, sharp enough to pick out debris down to a centimetre at ranges the mothership's own radar could never reach. It is the same principle as ground radio-telescope arrays, applied to a formation of small spacecraft. The concept is speculative, but the physics of aperture synthesis is well proven.",
      realWorld: 'Aperture synthesis is proven in radio astronomy; a debris-scanning distributed array across daughters is game-speculative.',
      trlRationale: 'Distributed synthetic aperture across daughter arms — game-speculative.',
      unlockHint: 'Complete a pulse scan (W).',
    },
  },
];

// --- upsert by id (idempotent, order-independent) ---
for (const ne of NEW_ENTRIES) {
  const i = codex.entries.findIndex((e) => e.id === ne.id);
  if (i >= 0) codex.entries[i] = ne;
  else codex.entries.push(ne);
}

const rewrittenIds = new Set(NEW_ENTRIES.map((e) => e.id));

// PLAYBOOK cards teach; they point INTO concept entries but a concept entry
// should not ring back to a tutorial card. Keep those links one-directional.
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

// --- outbound symmetrization: reciprocate every rewritten entry's links ---
// Honour HEAL_SKIP_CATEGORIES here too, so a rewritten entry that ever links to
// a tutorial (PLAYBOOK) card never forces a back-link onto it — the outbound and
// inbound passes must agree on which categories may receive reciprocal links.
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
console.log('[phase6b] entries now', codex.entries.length,
  '| POWER', counts.POWER, 'TETHERS', counts.TETHERS,
  'COMMS', counts.COMMS, 'SENSORS', counts.SENSORS,
  `| rewrote ${rewrittenIds.size} entries`);
