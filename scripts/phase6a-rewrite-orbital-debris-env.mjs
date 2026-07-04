#!/usr/bin/env node
// Phase 6a — Content batch A: rewrite ORBITAL_MECHANICS (12) + DEBRIS (17) +
// SPACE_ENVIRONMENT (10) to the deep-dive editorial template
// (see .kilo/plans/1782994412021-tech-library-deep-dive-overhaul.md §2).
//
// These are the oldest, weakest categories: single-paragraph stub fullText,
// almost no `related` links, no `realWorld` heritage lines. This is a full
// rewrite, not a touch-up.
//
// Idempotent: upsert by id (order-independent). `related` is made symmetric two
// ways — pre-existing inbound links are healed onto the rewritten entry (so a
// rewrite never orphans a cross-category link authored elsewhere), then every
// rewritten entry's links get a reciprocal back-link. Both passes are guarded by
// includes(), so re-running changes nothing.
//
// Editorial rules applied:
//   • shortText ≤140 chars, ELI5, understated hook allowed.
//   • fullText 2–4 paragraphs (\n\n-separated); ¶1 plain what/why, ¶2+ mechanism
//     + figures with units + tie-back to the in-game system the player touched.
//   • realWorld required (all trl-bearing).
//   • unlockHint names a concrete action or observable threshold (Part 2A) and
//     matches the entry's real trigger in codexTriggers.js — triggers unchanged.
//   • Acronyms expanded on first use per entry (LEO, RAAN, ΔV, ISS…).
//   • Voice: mission-ops declaratives, numbers with units, dry wit only in the
//     hook; no exclamation marks; ≤1 em-dash per sentence.
//
// Facts here are stable orbital-mechanics physics (Kepler, Tsiolkovsky, J2,
// drag) — no volatile 2026-currency figures in this category. DEBRIS +
// SPACE_ENVIRONMENT population/currency figures are web-verified when authored.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'data/codex.json');
const codex = JSON.parse(readFileSync(path, 'utf8'));

const NEW_ENTRIES = [
  // ======================= ORBITAL_MECHANICS (12) =======================
  {
    id: 'keplerian_orbit', category: 'ORBITAL_MECHANICS', trl: 9, icon: '🌍',
    related: ['orbital_period_altitude', 'orbital_inclination', 'j2_perturbation', 'delta_v'],
    i18n: {
      title: 'Keplerian Orbits',
      shortText: 'Every orbit is an ellipse, and six numbers pin down its exact size, shape, and tilt.',
      fullText: "Johannes Kepler worked out in the early 1600s that orbits are ellipses, with the body they circle sitting at one focus rather than the centre. Nothing since has overturned it: a live satellite, a spent rocket stage, and your mothership all trace the same kind of curve.\n\nSix orbital elements fix an orbit completely. The semi-major axis sets its size and the eccentricity its shape; inclination, right ascension of the ascending node (RAAN), and argument of periapsis orient the ellipse in space; true anomaly says where the object is along it right now. Your orbital view reads these out live, and every target in the debris field carries its own set.",
      realWorld: "Kepler's laws (published 1609 and 1619); the basis of every catalogued orbit and two-line element set (TLE).",
      formula: 'r = a(1 − e²) / (1 + e·cos ν)',
      trlRationale: 'Established orbital mechanics since Kepler (1609).',
      unlockHint: 'Open the orbital view.',
    },
  },
  {
    id: 'orbital_period_altitude', category: 'ORBITAL_MECHANICS', trl: 9, icon: '⏱️',
    related: ['keplerian_orbit', 'atmospheric_drag', 'relative_velocity'],
    i18n: {
      title: 'Period vs Altitude',
      shortText: 'Higher orbits run slower: about 92 minutes a lap at 400 km, a full 24 hours at geostationary height.',
      fullText: "Kepler's third law ties orbital period to one thing, the size of the orbit: raise it and every lap takes longer. At the International Space Station's 400 km, one orbit runs about 92 minutes, so the crew sees roughly 16 sunrises a day.\n\nClimb to geostationary altitude, 35,786 km, and the period stretches to match Earth's rotation, holding a satellite fixed over one spot on the equator. For you the law is a scheduling constraint: higher debris shells take longer to reach and give fewer close passes per mission day, so a cluster up high is a slower payday than one down low.",
      realWorld: 'ISS ≈ 92 min at ~400 km (16 orbits/day); geostationary ≈ 23 h 56 min at 35,786 km.',
      formula: 'T = 2π · √(a³ / μ)',
      trlRationale: "Kepler's third law (1619).",
      unlockHint: 'Engage the autopilot (A).',
    },
  },
  {
    id: 'orbital_inclination', category: 'ORBITAL_MECHANICS', trl: 9, icon: '📐',
    related: ['keplerian_orbit', 'j2_perturbation', 'raan_precession'],
    i18n: {
      title: 'Orbital Inclination',
      shortText: "An orbit's tilt against the equator decides which latitudes you fly over, and it is brutally expensive to change.",
      fullText: "Inclination is the angle between an orbit's plane and the equator, and it sets the band of latitudes a spacecraft passes over. The International Space Station flies at 51.6°, which carries it above most of the world's population; a near-polar orbit sees the whole planet as Earth turns under it.\n\nChanging inclination means burning perpendicular to your direction of travel, fighting the full orbital speed of roughly 7.7 km/s, so even a few degrees costs enormous delta-V (ΔV). That is why your debris targets in different planes are cleared in separate passes: chasing junk across inclinations would drain the tanks for almost no useful motion.",
      realWorld: 'ISS at 51.6°; Sun-synchronous imagers near 98°; plane changes are among the costliest burns flown.',
      formula: 'Δv = 2·v·sin(Δi / 2)',
      trlRationale: 'Established orbital mechanics.',
      unlockHint: 'Select a debris target (T).',
    },
  },
  {
    id: 'j2_perturbation', category: 'ORBITAL_MECHANICS', trl: 9, icon: '🌐',
    related: ['raan_precession', 'orbital_inclination', 'keplerian_orbit'],
    i18n: {
      title: 'J2 Oblateness',
      shortText: "Earth's equatorial bulge slowly swings orbits around, a nuisance you can also turn into free station-keeping.",
      fullText: "Earth is not a perfect sphere: it bulges about 21 km wider across the equator than pole to pole. That extra girdle of mass tugs on every orbit, and the dominant effect, called J2, makes the orbital plane precess steadily around Earth's axis instead of holding still.\n\nEngineers turn the nuisance into a tool. Tilt an orbit to near 98° and J2 rotates its plane by about 1° a day, exactly enough to keep pace with the Sun and hold constant lighting, giving a Sun-synchronous orbit. The same drift is why your tracked targets creep away from their last predicted spots: the mothership's solver folds J2 in, but the debris field never sits still.",
      realWorld: 'J2 ≈ 1.08×10⁻³; exploited by every Sun-synchronous satellite; the dominant perturbation in low Earth orbit (LEO).',
      formula: 'Ω̇ = −(3/2)·J₂·(R_E / p)²·n·cos i',
      trlRationale: 'Exploited on every Sun-synchronous satellite.',
      unlockHint: 'Fly until tracking flags targets drifting from their predicted track.',
    },
  },
  {
    id: 'raan_precession', category: 'ORBITAL_MECHANICS', trl: 9, icon: '🧭',
    related: ['j2_perturbation', 'orbital_inclination', 'keplerian_orbit'],
    i18n: {
      title: 'RAAN Precession',
      shortText: 'The point where an orbit crosses the equator slides west a few degrees a day, shifting when you pass overhead.',
      fullText: "The right ascension of the ascending node (RAAN) marks where an orbit crosses the equator heading north. Earth's equatorial bulge will not leave it alone: the J2 effect drags RAAN westward for a prograde orbit, slowly rotating the whole orbital plane.\n\nAt the International Space Station's 400 km and 51.6° inclination, RAAN slips about 5° a day. The drift is predictable, so mission planners ride it rather than fight it, and ground-station contact windows march along a known schedule. When the mothership announces a ground-station pass, that timing is RAAN precession playing out.",
      realWorld: 'ISS RAAN drifts ~5°/day westward; the same J2 nodal term underpins Sun-synchronous design.',
      trlRationale: 'Exploited operationally for decades.',
      unlockHint: 'Fly until the mothership logs a ground-station pass.',
    },
  },
  {
    id: 'atmospheric_drag', category: 'ORBITAL_MECHANICS', trl: 9, icon: '💨',
    related: ['orbital_period_altitude', 'delta_v'],
    i18n: {
      title: 'Atmospheric Drag',
      shortText: 'Even at station height the thin air still bites, dragging orbits down, which is exactly how you dispose of debris for free.',
      fullText: "Low Earth orbit is not empty. Enough trace atmosphere reaches past 400 km to rob a spacecraft of energy on every pass, lowering the orbit until, deep enough, it reenters and burns. The International Space Station feels it as roughly 2 km of altitude lost per month, made up by periodic reboosts from visiting cargo ships.\n\nDrag climbs steeply as altitude falls, because the air thickens fast: below about 200 km an object has only days left. That decay is a gift to your job. Nudge a piece of debris down to a low enough perigee and the atmosphere finishes the deorbit for nothing, with no further propellant spent, the cheapest disposal in the business.",
      realWorld: 'ISS loses ~2 km/month and reboosts; objects below ~200 km reenter within days; modelled since Sputnik 1 (1957).',
      formula: 'a_drag = −½·ρ·v²·(C_d·A / m)',
      trlRationale: 'Observed and modelled since Sputnik 1 (1957).',
      unlockHint: 'Clear 5 pieces of debris.',
    },
  },
  {
    id: 'delta_v', category: 'ORBITAL_MECHANICS', trl: 9, icon: '⚡',
    related: ['hohmann_transfer', 'rendezvous'],
    i18n: {
      title: 'Delta-V Budget',
      shortText: 'ΔV is the total change in velocity your tanks can buy, the real currency of moving in space.',
      fullText: "On the ground you measure a vehicle by range; in space you measure it by delta-V (ΔV), the total change in velocity it can still produce. Every maneuver spends from that budget: raising an orbit, matching a target's plane, killing a captured object's spin, or dropping something into a deorbit.\n\nThe Tsiolkovsky rocket equation sets the exchange rate, linking ΔV to exhaust velocity and the fraction of your mass that is propellant. It rewards efficiency without mercy: higher specific impulse buys more ΔV from the same tank, which is why your mothership leans on an efficient ion drive and your daughters sip their propellant. When the budget runs dry, you are wherever you are, for good.",
      realWorld: 'LEO→GEO ≈ 3.9 km/s; low-orbit drag makeup tens of m/s per year; the sizing number behind every mission.',
      formula: 'Δv = Isp · g₀ · ln(m₀ / m_f)   (Tsiolkovsky, 1903)',
      trlRationale: 'Tsiolkovsky rocket equation (1903).',
      unlockHint: 'Spend propellant on a maneuver.',
    },
  },
  {
    id: 'hohmann_transfer', category: 'ORBITAL_MECHANICS', trl: 9, icon: '🔄',
    related: ['rendezvous', 'delta_v', 'orbital_period_altitude'],
    i18n: {
      title: 'Hohmann Transfer',
      shortText: 'The cheapest way between two circular orbits: two burns joined by a single coasting ellipse.',
      fullText: "Walter Hohmann showed in 1925 that the least-propellant hop between two circular orbits takes exactly two burns. The first stretches your circle into an ellipse that just touches the target altitude; you coast halfway around to that far point, then burn again to circularise. No continuous thrust, just two nudges and a long glide.\n\nCheap does not mean quick. The coast can run for hours, and the geometry only lines up at particular moments, so the trade is always propellant against time. Your autopilot flies Hohmann transfers to shift the mothership between debris clusters when the tanks matter more than the clock. Patience is the fuel-saver.",
      realWorld: 'Standard for orbit raising since the 1960s; used for most geostationary insertions and interplanetary departures.',
      formula: 'Δv_total = Δv₁ + Δv₂   (two tangential burns via the transfer ellipse)',
      trlRationale: 'Flown on essentially every orbital transfer since the 1960s.',
      unlockHint: 'Fly an orbit transfer between clusters.',
    },
  },
  {
    id: 'relative_velocity', category: 'ORBITAL_MECHANICS', trl: 9, icon: '↔️',
    related: ['rendezvous', 'prograde_paradox', 'orbital_period_altitude'],
    i18n: {
      title: 'Relative Velocity in LEO',
      shortText: 'Two craft in nearly the same orbit barely move apart; a small altitude gap sets them drifting at walking pace.',
      fullText: "Both objects in low Earth orbit (LEO) travel near 7.7 km/s, yet what matters for catching one is the difference between them. Put two craft in the exact same orbit and they hang almost motionless relative to each other, whether side by side or half a world apart. Open a small altitude gap and they begin to drift, roughly a few metres per second for every ten kilometres of separation.\n\nThat is why capture is about matching orbits, not chasing. Your daughters exploit it directly: launched into an orbit close to a target's, they close the gap at a gentle crawl instead of a high-speed flyby, turning a 7.7 km/s problem into a walking-speed one.",
      realWorld: '~10 km altitude gap → ~5 m/s along-track drift; the basis of every rendezvous since Gemini (1965).',
      formula: 'drift rate ≈ −(3/2)·n·Δa   (n = mean motion, Δa = altitude gap)',
      trlRationale: 'Core concept in every rendezvous since Gemini (1965).',
      unlockHint: 'Capture a target with an arm.',
    },
  },
  {
    id: 'prograde_paradox', category: 'ORBITAL_MECHANICS', trl: 9, icon: '🔄',
    related: ['rendezvous', 'relative_velocity', 'hohmann_transfer'],
    i18n: {
      title: 'The Orbital Speed Paradox',
      shortText: "Thrust forward and you climb, slow down, and fall behind; to catch what's ahead, you burn backward.",
      fullText: "Orbital motion breaks everyday intuition. Fire your engine prograde, straight ahead, and you do not speed toward a target in front of you. You raise the far side of your orbit, settle into a larger and therefore slower path, and drop behind. To close on something ahead in the same orbit you burn retrograde, backward, dipping into a lower and faster lane that carries you around to meet it.\n\nThe effect has fooled trained crews. On Gemini 4 in 1965 the pilot spent much of his maneuvering propellant trying to fly straight at a spent booster and kept falling away from it. Your autopilot has the counterintuitive version wired in; flying a rendezvous by eye, you would make the same mistake.",
      realWorld: 'Documented from Gemini 4 (1965); standard rendezvous doctrine ever since.',
      trlRationale: 'Documented from Gemini 4 (1965) onward.',
      unlockHint: 'Work the throttle on the mothership.',
    },
  },
  {
    id: 'rendezvous', category: 'ORBITAL_MECHANICS', trl: 9, icon: '🛰️',
    related: ['relative_velocity', 'prograde_paradox', 'hohmann_transfer', 'docking_berthing'],
    i18n: {
      title: 'Orbit Matching & Rendezvous',
      shortText: "You don't chase an orbiting target, you match its orbit and close the last gap at a crawl.",
      fullText: "Rendezvous is the craft of bringing two orbits, and two positions along them, into agreement. First you match the orbit itself, its altitude, plane, and shape, with transfer burns. Then you fix the phasing, because two vehicles on one orbit can still sit a quarter-world apart.\n\nClosing the final distance is deliberately slow. Because of the orbital speed paradox, thrusting straight at a target changes your own orbit and throws off the approach, so real closings creep along a controlled path at centimetres per second. Gemini VI and VII flew the first crewed rendezvous in 1965, and every International Space Station docking repeats the discipline. Every capture your daughters make is a rendezvous solved.",
      realWorld: 'Gemini VI/VII (1965, first crewed rendezvous); every ISS docking and cargo approach.',
      formula: 'phasing: Δt = Δθ / (n_target − n_chaser)',
      trlRationale: 'Routine operational astrodynamics.',
      unlockHint: 'Let the autopilot arrive at a target.',
    },
  },
  {
    id: 'docking_berthing', category: 'ORBITAL_MECHANICS', trl: 9, icon: '🤝',
    related: ['rendezvous', 'detumble', 'docking_precision'],
    i18n: {
      title: 'Docking vs Berthing',
      shortText: 'Two ways to connect: the craft flies itself in (docking), or an arm grabs it and bolts it down (berthing).',
      fullText: "Rendezvous only gets you alongside; you still have to connect. Docking is active: the arriving craft flies itself into a mating ring under its own control and latches on contact. It is quick, but it demands precise alignment and a cooperative, steady partner.\n\nBerthing is passive: a robotic arm captures the free-floating object, then an operator walks it onto a fixture to be bolted down. It is slower but far gentler, and it can handle a target that is uncooperative or tumbling. Debris removal is almost always a berthing problem, because the thing you are grabbing is dead, usually spinning, and has to be de-spun before contact. Your daughters berth.",
      realWorld: 'Docking: Apollo, Crew Dragon. Berthing: Canadarm2 (SSRMS) capturing Cygnus and HTV cargo ships.',
      trlRationale: 'Mature operational technique.',
      unlockHint: 'Make a capture.',
    },
  },

  // ============================= DEBRIS (17) =============================
  {
    id: 'adr_methods_real', category: 'DEBRIS', trl: 7, icon: '🚀',
    related: ['breakup_events', 'debris_tracking', 'world_five_year_rule'],
    i18n: {
      title: 'Active Debris Removal IRL',
      shortText: 'After decades on paper, active debris removal is finally flying: nets, harpoons, magnetic docking, and robotic rendezvous.',
      fullText: "Active debris removal (ADR) means sending something up to catch a dead object and drag it down, and after decades of study the first real missions are flying. Britain's RemoveDEBRIS fired a net at a mock target in 2018 and a harpoon in 2019; Astroscale's ELSA-d tested magnetic docking in 2021; and in 2024 its ADRAS-J closed to about 15 metres from a spent Japanese H-2A rocket stage, the closest look yet at a piece of uncontrolled debris.\n\nEurope's ClearSpace-1 is being built to grab and deorbit a defunct satellite, having switched its target to the agency's own retired PROBA-1 after the original target was itself struck by debris. Every approach shares your problem: a dead, drifting, non-cooperative target. Your cradle is the next step, reusable and multi-target where these one-shot demonstrators were not.",
      realWorld: 'RemoveDEBRIS net 2018 / harpoon 2019; Astroscale ELSA-d 2021; ADRAS-J ~15 m rendezvous 2024; ClearSpace-1 (PROBA-1 target) in development.',
      trlRationale: 'Demonstrated in orbit: RemoveDEBRIS (2018-19), ELSA-d (2021), ADRAS-J (2024).',
      unlockHint: 'Clear 50 pieces of debris.',
    },
  },
  {
    id: 'breakup_events', category: 'DEBRIS', trl: 9, icon: '💥',
    related: ['iridium_cosmos', 'fengyun_test', 'kessler_syndrome', 'hypervelocity'],
    i18n: {
      title: 'Breakup Events',
      shortText: 'One collision at orbital speed can spawn thousands of fragments, each a new bullet on its own orbit.',
      fullText: "When two objects meet at orbital speed the closing rate can top 10 km/s, and the impact energy dwarfs any chemical explosion. A single event shatters both bodies into thousands of fragments, and each shard enters its own orbit, spreading over months into a band of altitudes that threatens everything crossing it.\n\nThe 2009 Iridium-Cosmos collision produced more than 2,000 trackable fragments; the 2007 Fengyun-1C weapon test made more than 3,000. This is the engine behind the Kessler syndrome: every breakup seeds the collisions that cause the next breakup. When the mothership registers fresh fragments joining the field, you are watching that engine turn.",
      realWorld: 'Iridium-Cosmos (2009): 2,000+ tracked fragments; Fengyun-1C (2007): 3,000+, the largest single event.',
      trlRationale: 'Iridium-Cosmos 2009, Fengyun-1C 2007 — documented.',
      unlockHint: 'See a collision or breakup spawn fresh fragments.',
    },
  },
  {
    id: 'starlink_contained', category: 'DEBRIS', trl: 9, icon: '🛰️',
    related: ['kessler_syndrome', 'breakup_events', 'starlink_cascade'],
    i18n: {
      title: 'Cascade Contained',
      shortText: 'You swept a fresh fragmentation cloud before it could seed a Kessler cascade.',
      fullText: "When a satellite breaks up, the real danger is not the first cloud but the second: fragments striking other objects, each hit breeding more debris until a shell turns unusable for generations. That runaway is the Kessler syndrome, and the window to stop it is short.\n\nSweeping a fresh cloud fast is the single highest-leverage move a debris tug can make, because you remove the seeds before they multiply. Here, speed matters more than tonnage. You caught this one in time; the fragments that would have spawned the next collision are in your cradle instead of loose in the shell.",
      realWorld: 'ADR rationale; fragmentation-cloud risk characterised in ESA and NASA debris models.',
      trlRationale: 'ADR rationale; fragmentation-cloud risk is well-characterised.',
      unlockHint: 'Contain a fresh fragmentation cloud before it cascades.',
    },
  },
  {
    id: 'conjunction_assessment', category: 'DEBRIS', trl: 9, icon: '⚠️',
    related: ['debris_tracking', 'ssa_network', 'iss_pdam'],
    i18n: {
      title: 'Conjunction Assessment',
      shortText: 'A conjunction is a predicted close approach; cross a probability threshold and someone has to move.',
      fullText: "A conjunction is a forecast close approach between two orbiting objects. Space-surveillance networks screen the whole tracked catalogue against itself and issue a conjunction data message (CDM) when a predicted miss distance falls below a threshold. Operators watch the collision probability, and when it climbs past roughly 1-in-10,000 they may burn to get clear.\n\nThe International Space Station does this a few times a year, and has occasionally had its crew shelter in their return craft when a warning came too late to maneuver. Your job removes the objects that generate these alerts in the first place: every derelict you clear is a conjunction that never has to be flown.",
      realWorld: 'USSPACECOM issues CDMs; the ISS maneuvers a few times a year, dozens of times since 1999.',
      trlRationale: 'USSPACECOM CDMs; ISS manoeuvres a few times a year.',
      unlockHint: 'Capture a target with an arm.',
    },
  },
  {
    id: 'debris_classification', category: 'DEBRIS', trl: 9, icon: '📏',
    related: ['debris_tracking', 'trackable_vs_dark', 'hypervelocity'],
    i18n: {
      title: 'Debris Size Classification',
      shortText: 'About 1 cm can kill, 10 cm can be tracked; the deadly gap is the 1-10 cm range you can neither see nor stop.',
      fullText: "Debris is sorted by size because size decides what you can do about it. Above 10 cm, objects are trackable and can be dodged, and today roughly 40,000 such objects are catalogued. Below 1 cm, shielding can usually absorb the hit. The trouble lives in between.\n\nAn estimated one million fragments in the 1-10 cm range are too small to track reliably yet large enough to punch through a spacecraft: a 1 cm aluminium chip at 10 km/s carries the kinetic energy of a hand grenade. That lethal-untrackable band is why a working orbit can be dangerous even when the catalogue looks clear, and it is why your onboard sensors earn their keep.",
      realWorld: 'IADC size classes; ~40,000 tracked >10 cm, ~1 million 1-10 cm, 130+ million >1 mm (ESA, 2025).',
      trlRationale: 'IADC classification, long-established.',
      unlockHint: 'Clear 10 pieces of debris.',
    },
  },
  {
    id: 'debris_tracking', category: 'DEBRIS', trl: 9, icon: '📡',
    related: ['ssa_network', 'trackable_vs_dark', 'debris_classification', 'conjunction_assessment'],
    i18n: {
      title: 'Debris Tracking Networks',
      shortText: 'Ground radar and telescopes catalogue tens of thousands of objects; millions more are too small to see.',
      fullText: "Tracking debris means knowing where the dangerous objects are well enough to predict close approaches. Ground-based radar and optical telescopes catalogue objects larger than about 10 cm in low Earth orbit; that catalogue now holds roughly 40,000 items and is maintained continuously.\n\nBelow that size the picture goes dark. Statistical models put the 1-10 cm population near a million and the sub-centimetre count above 130 million, none of it reliably tracked. The catalogue is a floor, not a full map. Your daughters' sensors reach into the gap the ground network cannot, spotting hazards that were never in anyone's database.",
      realWorld: 'US Space Surveillance Network + ESA catalogue ~40,000 tracked objects (2025); untracked pieces number in the millions.',
      trlRationale: 'USSPACECOM catalog operational since the 1960s.',
      unlockHint: 'Upgrade a sensor.',
    },
  },
  {
    id: 'fengyun_test', category: 'DEBRIS', trl: 9, icon: '🎯',
    related: ['iridium_cosmos', 'breakup_events', 'kessler_syndrome'],
    i18n: {
      title: 'FengYun-1C ASAT Test',
      shortText: "China's 2007 anti-satellite test made more fragments than any other single event in orbital history.",
      fullText: "On 11 January 2007 China destroyed its own defunct Fengyun-1C weather satellite with a direct-ascent kill vehicle at about 865 km. It remains the single largest debris-generating event ever recorded: more than 3,000 trackable fragments and over 35,000 pieces larger than 1 cm.\n\nAltitude made it worse. At 865 km the air is too thin to pull the fragments down, so most will linger for centuries, threading through the most satellite-dense band of low Earth orbit. The test lifted the tracked-debris population sharply overnight and still drives conjunction alerts today, a standing lesson in why kinetic anti-satellite weapons are a problem for everyone who flies.",
      realWorld: 'Fengyun-1C, 11 Jan 2007, ~865 km; 3,000+ tracked fragments; largest single debris event on record.',
      trlRationale: 'Historical event, 11 January 2007.',
      unlockHint: 'Witness an orbital shell tip into cascade.',
    },
  },
  {
    id: 'thaicom_graveyard', category: 'DEBRIS', trl: 9, icon: '🛰️',
    related: ['hohmann_transfer', 'orbital_period_altitude'],
    i18n: {
      title: 'GEO Graveyard',
      shortText: 'Dead geostationary satellites are meant to climb to a graveyard orbit a few hundred km above the working belt.',
      fullText: "Geostationary slots at 35,786 km are scarce and valuable, so the disposal rule is to boost a dying satellite a few hundred kilometres higher into a graveyard orbit, clearing the working belt for its successor. It costs a small reserve of propellant, set aside for that final burn.\n\nNot everyone pays it. Satellites like the long-dead Thaicom 4 (IPSTAR) drift uncontrolled, and a derelict left in the belt creeps in inclination and speed year over year. Reaching GEO to deal with one is a patience game: a half-orbit Hohmann climb where timing, not thrust, decides whether you arrive where the target will be.",
      realWorld: 'IADC-standard GEO graveyard disposal (~300 km above the belt); many derelicts, such as Thaicom 4/IPSTAR, remain uncleared.',
      trlRationale: 'GEO graveyard disposal is IADC-standard practice.',
      unlockHint: 'Encounter the Thaicom derelict near the GEO belt.',
    },
  },
  {
    id: 'hubble_watch', category: 'DEBRIS', trl: 9, icon: '🔭',
    related: ['heritage_hubble_servicing', 'ssa_network', 'conjunction_assessment'],
    i18n: {
      title: 'Hubble Watch',
      shortText: 'The Hubble Space Telescope shares the low-mid band and is strictly off-limits: a live asset, not salvage.',
      fullText: "Hubble orbits near 540 km at 28.5°, a working observatory rather than a derelict. Treaty and plain sense make active, crewed, or functioning spacecraft no-fire targets, and your daughters refuse to engage them; a net or a nudge aimed at a live asset is a fault, not a catch.\n\nThe skill this teaches is identification. Before you commit fuel, a grip, or a net, you confirm what a contact actually is, because at this altitude the field mixes priceless working hardware with genuine junk. Reading a target correctly is the difference between a clean removal and an incident.",
      realWorld: 'Hubble Space Telescope operational since 1990 (~540 km, 28.5°); active-asset no-fire is standard policy.',
      trlRationale: 'HST operational since 1990; active-asset no-fire is policy.',
      unlockHint: 'Encounter the Hubble Space Telescope on a scan.',
    },
  },
  {
    id: 'iss_hydrazine_burn', category: 'DEBRIS', trl: 9, icon: '⛽',
    related: ['conjunction_assessment', 'iss_pdam', 'iss_saver'],
    i18n: {
      title: 'Hydrazine Reboost',
      shortText: 'The station dodged at the last minute, spending about 3 kg of hydrazine — cheap on the ground, costly up here.',
      fullText: "You engaged the threat but ran out of time before closest approach, so the International Space Station had to make a late avoidance reboost of its own. It cleared the conjunction, but not for free.\n\nHydrazine is inexpensive on Earth and eye-watering once launched; a rushed few-kilogram burn runs into tens of thousands of dollars and interrupts the science running aboard. Finishing the intercept earlier would have saved both the propellant and the experiments. The station is safe, which is what matters, but this one goes in the ledger as a near-miss you could have closed out sooner.",
      realWorld: 'Hydrazine avoidance reboosts are routine, documented ISS operations.',
      trlRationale: 'Hydrazine avoidance reboosts are routine, documented ISS ops.',
      unlockHint: 'Miss the intercept window on an ISS conjunction.',
    },
  },
  {
    id: 'hypervelocity', category: 'DEBRIS', trl: 9, icon: '⚡',
    related: ['mmod_impact', 'debris_classification', 'breakup_events'],
    i18n: {
      title: 'Hypervelocity Impact',
      shortText: 'At 7 km/s and up, even a paint fleck hits like a bullet; energy climbs with the square of speed.',
      fullText: "Orbital debris closes at 7-15 km/s, and kinetic energy rises with the square of speed, so impact damage is savage out of all proportion to size. A 1 cm aluminium sphere striking at 10 km/s delivers roughly the energy of a hand grenade, and a fleck of paint can pit a window.\n\nYou cannot armour against the large stuff, so spacecraft use Whipple shields for the small: a thin outer bumper set ahead of the hull. The particle shatters and spreads on the bumper, and the diffuse cloud that reaches the wall does far less damage than the intact fragment would. Your daughters' hull panels work the same way, thin spaced layers beating one thick plate.",
      realWorld: 'LEO impact speeds 7-15 km/s; Whipple shielding on the ISS and crewed hardware; measured since the 1960s.',
      formula: 'E = ½·m·v²   (impact energy scales with velocity squared)',
      trlRationale: 'Observed and measured since the 1960s.',
      unlockHint: 'Capture a target with an arm.',
    },
  },
  {
    id: 'iss_pdam', category: 'DEBRIS', trl: 9, icon: '🚀',
    related: ['conjunction_assessment', 'iss_saver', 'iss_hydrazine_burn'],
    i18n: {
      title: 'ISS PDAM',
      shortText: 'You waved the ISS off to fly its own Predetermined Debris Avoidance Maneuver — a valid call, no penalty.',
      fullText: "A predetermined debris avoidance maneuver (PDAM) is the routine response when a conjunction's collision probability climbs past roughly 1-in-10,000. Mission control commands a reboost using the Zvezda module or a docked Progress, nudging the International Space Station clear by about half a metre per second.\n\nThe station has done this dozens of times since 1999. Declining the intercept and letting it maneuver itself is a perfectly good decision, not a failure; it costs a little propellant and a little schedule, and the crew stays safe. Sometimes the right move is to let the professionals downstairs handle their own house.",
      realWorld: 'PDAM reboosts via Zvezda or a docked Progress; performed dozens of times since 1999.',
      trlRationale: 'PDAM reboosts performed dozens of times since 1999.',
      unlockHint: 'Decline an ISS conjunction and let the station maneuver.',
    },
  },
  {
    id: 'iss_saver', category: 'DEBRIS', trl: 9, icon: '🛰️',
    related: ['conjunction_assessment', 'iss_pdam', 'iss_hydrazine_burn', 'kessler_syndrome'],
    i18n: {
      title: 'ISS Saver',
      shortText: 'You cleared a Cosmos-1408 fragment cloud before it reached the ISS — the crew never had to dodge.',
      fullText: "On 15 November 2021 Russia destroyed the defunct Cosmos-1408 in a direct-ascent anti-satellite test at about 450 km, generating more than 1,500 trackable fragments in a 51.6° band that crosses the International Space Station. The crew sheltered in their Soyuz and Crew Dragon for several orbits while the cloud spread.\n\nClearing a converging fragment cloud yourself means the station never has to burn propellant to dodge, and the crew keeps working. That is the quiet version of the job: no headline, no near-miss in the ledger, just a hazard removed before it ever became one. This is the outcome to aim for.",
      realWorld: 'Cosmos-1408 ASAT (15 Nov 2021, ~450 km): 1,500+ trackable fragments; ISS crew sheltered.',
      trlRationale: 'Cosmos-1408 ASAT event (2021) + ISS conjunction ops documented.',
      unlockHint: 'Intercept a fragment cloud converging on the ISS.',
    },
  },
  {
    id: 'starlink_cascade', category: 'DEBRIS', trl: 9, icon: '💥',
    related: ['kessler_syndrome', 'starlink_contained', 'breakup_events'],
    i18n: {
      title: 'Cascade Loose',
      shortText: 'Too many fragments escaped the sweep, and the collisional cascade is now feeding itself.',
      fullText: "Donald Kessler warned in 1978 that past a critical density, debris collisions become self-sustaining: each impact throws off fragments that cause further impacts, faster than drag can clear them. A runaway cascade can leave an entire orbital shell unusable for generations.\n\nThis cloud got away from you. Enough fragments stayed loose to keep seeding new collisions, and the shell will pay for it long after this mission ends. Every piece you did clear lowered the density a little and bought a little time, which is not nothing. The lesson is speed: against a fresh cloud, arriving early beats arriving strong.",
      realWorld: 'Kessler syndrome (1978); the 2009 Iridium-Cosmos collision is the clearest real cascade seed to date.',
      trlRationale: 'Kessler syndrome (1978) — established, observed (2009 Iridium-Cosmos).',
      unlockHint: 'Let a fragmentation cloud slip into a cascade.',
    },
  },
  {
    id: 'ssa_network', category: 'DEBRIS', trl: 9, icon: '🌐',
    related: ['debris_tracking', 'conjunction_assessment', 'trackable_vs_dark'],
    i18n: {
      title: 'Space Situational Awareness',
      shortText: 'The global web of radar fences and telescopes that finds, tracks, and predicts everything in orbit.',
      fullText: "Space situational awareness (SSA) is the ability to detect, track, and predict the positions of objects in orbit. The US Space Surveillance Network runs ground radar and optical sites around the world; the European system adds its own sensors, and together they maintain a catalogue of roughly 40,000 objects.\n\nThe network has gaps, especially below 10 cm and over data-sparse regions, and commercial trackers such as LeoLabs and ExoAnalytic have grown up to fill them. Better awareness is the quiet backbone of every safe operation up here: you cannot avoid, remove, or plan around what nobody can see. Your mission consumes that catalogue and, by clearing objects, keeps it a little shorter.",
      realWorld: 'US Space Surveillance Network + ESA SST; ~40,000 catalogued objects (2025); commercial trackers LeoLabs, ExoAnalytic.',
      trlRationale: 'Operational network since the 1960s.',
      unlockHint: 'Clear 40 pieces of debris.',
    },
  },
  {
    id: 'iridium_cosmos', category: 'DEBRIS', trl: 9, icon: '💫',
    related: ['breakup_events', 'kessler_syndrome', 'conjunction_assessment'],
    i18n: {
      title: 'The Iridium-Cosmos Collision',
      shortText: '10 February 2009: the first accidental hypervelocity collision between two intact satellites.',
      fullText: "At 16:56 UTC on 10 February 2009, the active Iridium 33 communications satellite and the derelict Russian Cosmos 2251 collided at about 11.7 km/s over northern Siberia, near 790 km altitude. Both were destroyed instantly, scattering more than 2,000 trackable fragments across the region.\n\nIt was the first, and so far the only, accidental collision between two intact satellites, and it became the space community's wake-up call: the derelict Cosmos had no way to move, and nobody had flown the active satellite clear. Many of the fragments are still up there. The event is a large part of why conjunction screening and debris removal are taken seriously today.",
      realWorld: 'Iridium 33 (active) + Cosmos 2251 (derelict), 10 Feb 2009, ~11.7 km/s, ~790 km; 2,000+ tracked fragments.',
      trlRationale: 'Historical event, 10 February 2009.',
      unlockHint: 'Clear 25 pieces of debris.',
    },
  },
  {
    id: 'trackable_vs_dark', category: 'DEBRIS', trl: 9, icon: '👁️',
    related: ['debris_tracking', 'ssa_network', 'debris_classification'],
    i18n: {
      title: 'Trackable vs Dark Debris',
      shortText: "Only objects above ~10 cm are reliably tracked; the rest is dark debris — invisible to radar, lethal to hardware.",
      fullText: "Ground surveillance reliably tracks objects down to roughly 10 cm in low Earth orbit. Everything smaller is dark debris: present, dangerous, and effectively invisible to the catalogue. For every tracked object there are estimated to be dozens of untracked pieces in the 1-10 cm range.\n\nThat mismatch is the core hazard of a working orbit. Dark debris is too small to dodge because nobody sees it coming, yet large enough to end a mission on impact. Onboard sensing is the only answer at close range, and your daughters' scanners and lidar pick out returns the ground network never logged, turning some of the dark population back into targets you can avoid or remove.",
      realWorld: 'SSN tracks to ~10 cm; an estimated 25-30 untracked 1-10 cm pieces exist per tracked object (published studies).',
      trlRationale: 'Gap characterised by multiple published studies.',
      unlockHint: 'Fit a sensor or scan upgrade.',
    },
  },

  // ========================= SPACE_ENVIRONMENT (10) =========================
  {
    id: 'atomic_oxygen', category: 'SPACE_ENVIRONMENT', trl: 9, icon: '🫧',
    related: ['uv_degradation', 'mmod_impact'],
    i18n: {
      title: 'Atomic Oxygen Erosion',
      shortText: 'Single oxygen atoms in low orbit sandblast spacecraft surfaces, quietly eating coatings and film.',
      fullText: "Below about 700 km, solar ultraviolet light splits molecular oxygen into single, highly reactive atoms. A spacecraft plowing through them at 7.7 km/s meets each atom with roughly 5 electronvolts of impact energy, enough to break chemical bonds and slowly erode the surface. Kapton film, silver, and some carbon materials are especially vulnerable.\n\nThe Long Duration Exposure Facility, retrieved in 1990 after nearly six years in orbit, came home with surfaces visibly eaten away, turning atomic oxygen from a theory into a measured design constraint. Your salvaged thermal blankets carry this damage; erosion is one reason hardware pulled from an old derelict cannot simply be trusted as new.",
      realWorld: 'Characterised by the Long Duration Exposure Facility (LDEF, 1984-1990); dominant erosion agent below ~700 km.',
      trlRationale: 'Characterised by LDEF (1984-1990).',
      unlockHint: 'Fly until the mothership flags atomic-oxygen erosion.',
    },
  },
  {
    id: 'geomagnetic_storm', category: 'SPACE_ENVIRONMENT', trl: 9, icon: '🌀',
    related: ['solar_storm', 'solar_wind', 'atmospheric_drag'],
    i18n: {
      title: 'Geomagnetic Storms',
      shortText: "A solar gust slams Earth's magnetic field, puffing up the atmosphere and heaving drag onto everything in low orbit.",
      fullText: "When a coronal mass ejection (CME) or a fast solar-wind stream strikes Earth's magnetosphere, it compresses the day side and stretches the night side into a long tail; the disturbance is called a geomagnetic storm. The upper atmosphere heats and swells, and drag on low-orbit satellites can jump several-fold within hours.\n\nThe side effects reach the ground: satellite navigation degrades, high-frequency radio blacks out, and radiation levels spike. In February 2022 a modest storm expanded the atmosphere just enough to drag down dozens of newly launched Starlink satellites. For you, a storm is a decay accelerator, pulling both your targets and your own orbit down faster than a calm-day model predicts.",
      realWorld: '2003 Halloween storms caused satellite failures; a Feb 2022 storm deorbited dozens of newly launched Starlink satellites.',
      trlRationale: 'Observed every solar cycle since the IGY (1957).',
      unlockHint: 'Ride out a geomagnetic storm.',
    },
  },
  {
    id: 'kessler_syndrome', category: 'SPACE_ENVIRONMENT', trl: 9, icon: '💥',
    related: ['breakup_events', 'iridium_cosmos', 'fengyun_test', 'starlink_cascade'],
    i18n: {
      title: 'Kessler Syndrome',
      shortText: 'Past a critical debris density, collisions become self-sustaining — a cascade that can close an orbit for generations.',
      fullText: "In 1978 NASA scientist Donald Kessler described the failure mode that now bears his name: above a critical density of objects, collisions produce fragments that trigger further collisions, faster than atmospheric drag can sweep them away. The population then grows on its own, whether or not anyone launches again.\n\nA fully cascading shell could stay hazardous for generations, the long shadow over every crowded orbit. It also explains why your work matters beyond each individual catch: every object removed lowers the local density and pushes the tipping point further off. Some analysts argue two low-orbit bands are already past critical, and a cascade need not look dramatic while it slowly builds.",
      realWorld: 'Kessler & Cour-Palais (1978); the 900-1,000 km and ~1,500 km LEO bands are argued to be near or past critical density.',
      trlRationale: 'Kessler & Cour-Palais (1978); observed during 2007, 2009 events.',
      unlockHint: 'Begin flying the mission.',
    },
  },
  {
    id: 'mmod_impact', category: 'SPACE_ENVIRONMENT', trl: 9, icon: '🛡️',
    related: ['hypervelocity', 'atomic_oxygen'],
    i18n: {
      title: 'MMOD Protection',
      shortText: 'Whipple shields put a thin bumper ahead of the hull, shattering a particle before it can reach the wall.',
      fullText: "Micrometeoroids and orbital debris (MMOD) arrive at 7-72 km/s, far too fast to stop with a simple thick wall. The Whipple shield, proposed by astronomer Fred Whipple in 1947, solves it with geometry: a thin bumper plate stands off ahead of the pressure hull.\n\nThe incoming particle shatters and partly vaporises on the bumper, and the expanding cloud of fine debris spreads its energy over a wide patch of the back wall, which survives what a single intact fragment would have punched straight through. The International Space Station carries this shielding, and modern designs add spaced layers and fabrics. Your daughters' hull panels use the same trick: several light layers beat one heavy plate.",
      realWorld: 'Whipple shield (Fred Whipple, 1947); flown on the ISS and crewed vehicles since the 1970s.',
      trlRationale: 'Whipple shields flown since the 1970s.',
      unlockHint: 'Fly until the mothership reports an MMOD strike.',
    },
  },
  {
    id: 'radiation_dose', category: 'SPACE_ENVIRONMENT', trl: 9, icon: '📈',
    related: ['van_allen_belts', 'south_atlantic_anomaly', 'solar_storm'],
    i18n: {
      title: 'Radiation Dose Tracking',
      shortText: 'Spacecraft soak up radiation for their whole lives; total accumulated dose sets when the electronics give out.',
      fullText: "Radiation in low Earth orbit comes from three places: particles trapped in the Van Allen belts, bursts of solar energetic particles during flares, and the steady drizzle of galactic cosmic rays. Electronics absorb it continuously, and each part is rated for a total ionising dose (TID), typically 30-100 kilorad for space-grade components.\n\nAs the accumulated dose climbs toward that rating, the risk of latch-ups, bit-flips, and permanent degradation rises with it. Mission planners budget dose the way they budget propellant. Your spacecraft tracks its running total; salvaged parts from an old satellite may already be near their limit, having spent years absorbing what yours is only starting to count.",
      realWorld: 'Space-grade parts rated ~30-100 krad total ionising dose; dose budgeting standard since the 1960s.',
      trlRationale: 'TID budgeting standard since the 1960s.',
      unlockHint: 'Take a radiation-dose warning from a subsystem.',
    },
  },
  {
    id: 'solar_storm', category: 'SPACE_ENVIRONMENT', trl: 9, icon: '🌞',
    related: ['geomagnetic_storm', 'solar_wind', 'radiation_dose'],
    i18n: {
      title: 'Solar Storms',
      shortText: 'The Sun hurls billions of tonnes of magnetised plasma; when it lands, electronics and orbits both suffer.',
      fullText: "Every so often the Sun launches a coronal mass ejection (CME), billions of tonnes of magnetised plasma flung outward at high speed. When one sweeps over Earth it drives a geomagnetic storm, and its energetic particles wash across everything in orbit.\n\nThe effects on spacecraft stack up: a spike in radiation dose, an atmosphere puffed up enough to raise drag on low orbits, disrupted communications, and a real chance of electronics damage. Activity waxes and wanes on an eleven-year solar cycle, so quiet years give way to stormy ones. For you a solar storm is both a hazard to ride out and a reminder that the environment up here keeps weather of its own.",
      realWorld: 'CMEs drive geomagnetic storms; ~11-year solar cycle; monitored since IMP-8 (1973) and today by DSCOVR and GOES.',
      trlRationale: 'Observed and measured since IMP-8 (1973).',
      unlockHint: 'Fly through a solar storm.',
    },
  },
  {
    id: 'south_atlantic_anomaly', category: 'SPACE_ENVIRONMENT', trl: 9, icon: '⚠️',
    related: ['van_allen_belts', 'radiation_dose'],
    i18n: {
      title: 'South Atlantic Anomaly',
      shortText: "A weak spot in Earth's magnetic field lets trapped radiation dip down into low orbit over the South Atlantic.",
      fullText: "Earth's magnetic field is not centred on the planet, and over the South Atlantic it sags noticeably, letting the inner radiation belt reach down to low-orbit altitudes. Spacecraft crossing this South Atlantic Anomaly (SAA) meet a sharp local rise in trapped-particle radiation.\n\nOperators plan around it: the International Space Station and observatories like Hubble power down or safe their most sensitive instruments during SAA passes, because the particle flux drives detector noise and single-event upsets. Your own sensors may glitch here in the same way. It is a fixed feature of the map, predictable enough to schedule around once you know where it lies.",
      realWorld: 'Inner-belt radiation dips to LEO over the South Atlantic; the ISS and Hubble safe instruments during passes.',
      trlRationale: 'Mapped by every LEO spacecraft.',
      unlockHint: 'Fly through the South Atlantic Anomaly.',
    },
  },
  {
    id: 'uv_degradation', category: 'SPACE_ENVIRONMENT', trl: 9, icon: '🌞',
    related: ['atomic_oxygen', 'radiation_dose'],
    i18n: {
      title: 'UV Degradation',
      shortText: 'Unfiltered solar ultraviolet ages spacecraft materials fast, yellowing coatings and fading solar cells.',
      fullText: "On the ground the atmosphere screens most ultraviolet light; in orbit a spacecraft takes the full solar spectrum at about 1,361 watts per square metre, unfiltered. Over months and years that steady ultraviolet dose yellows thermal coatings, embrittles polymers, and clouds the cover glass over solar cells.\n\nThe slow result is lost performance, with solar-panel output falling a couple of percent a year on some designs. New panels fight it with cerium-doped cover glass, but salvaged panels off an old satellite may already be badly degraded. When you scavenge power hardware from a derelict, this is part of why its rated output and its real output are two different numbers.",
      realWorld: 'Solar constant ~1,361 W/m²; UV yellows coatings and degrades solar cells over years; seen on every long-duration mission.',
      trlRationale: 'Observed on every long-duration mission.',
      unlockHint: 'Take a UV-degradation notice from a subsystem.',
    },
  },
  {
    id: 'van_allen_belts', category: 'SPACE_ENVIRONMENT', trl: 9, icon: '☢️',
    related: ['south_atlantic_anomaly', 'radiation_dose', 'solar_wind'],
    i18n: {
      title: 'Van Allen Radiation Belts',
      shortText: 'Two doughnuts of trapped high-energy particles ring the Earth; your low orbit slips beneath them.',
      fullText: "Earth's magnetic field traps charged particles from the Sun and cosmic rays into two nested, doughnut-shaped zones, discovered by instruments on Explorer 1 in 1958. The inner belt, from roughly 1,000 to 6,000 km, is thick with high-energy protons; the outer belt, out around 13,000 to 60,000 km, holds energetic electrons.\n\nYour low orbit runs beneath both, one reason crewed and low-flying spacecraft can operate for years without prohibitive shielding. The exception is the South Atlantic Anomaly, where the inner belt dips low enough to matter. The belts are also why climbing through to higher orbits is planned carefully: lingering in them is a fast way to spend an electronics radiation budget.",
      realWorld: 'Discovered by Explorer 1 (1958, James Van Allen); inner belt ~1,000-6,000 km, outer ~13,000-60,000 km.',
      trlRationale: 'Explorer 1 (1958) — foundational discovery.',
      unlockHint: 'Fly until the mothership mentions the Van Allen belts.',
    },
  },
  {
    id: 'solar_wind', category: 'SPACE_ENVIRONMENT', trl: 9, icon: '🌬️',
    related: ['solar_storm', 'geomagnetic_storm', 'van_allen_belts'],
    i18n: {
      title: 'The Solar Wind',
      shortText: 'The Sun is always leaking: a million-tonne-a-second plasma breeze streams past at 400 km/s even on a calm day.',
      fullText: "The solar wind is a continuous stream of charged plasma, mostly protons and electrons, boiling off the Sun's corona and flooding the whole solar system. At Earth's distance it blows at roughly 400 km/s, ranging from about 300 to 800 km/s, with a density of only a few particles per cubic centimetre, and it never stops.\n\nIt is not the same as a coronal mass ejection (CME): the wind is the steady background breeze, while a CME is a discrete gust of billions of tonnes. The wind shapes Earth's magnetosphere, drives the aurora, and when it gusts it inflates the upper atmosphere and raises drag across low orbit. Most of the space weather you feel is the wind's mood rather than a separate force.",
      realWorld: 'Mapped by ACE, DSCOVR, and Parker Solar Probe; baseline ~400 km/s at 1 AU.',
      formula: 'ram pressure  P ≈ ρ·v²',
      trlRationale: 'Established heliophysics (natural phenomenon).',
      unlockHint: 'Ride out a space-weather event.',
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

// PLAYBOOK cards are onboarding/tutorial material; they point INTO concept
// entries as a teaching aid, but a physics briefing should not ring back to a
// tutorial card. Exclude them from the inbound-heal so those links stay
// one-directional (PLAYBOOK → concept), matching the shipped norm.
const HEAL_SKIP_CATEGORIES = new Set(['PLAYBOOK']);

// --- heal inbound links: a rewrite replaces the entry's `related`, so any link
// pointing INTO it from a non-rewritten entry (authored in an earlier phase)
// would be orphaned. Re-add those so the graph stays symmetric both ways —
// except tutorial back-links (HEAL_SKIP_CATEGORIES), which stay one-directional. ---
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

// --- outbound symmetrization: every id a rewritten entry links to gets a
// reciprocal back-link (idempotent — guarded by includes()). ---
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
console.log('[phase6a] entries now', codex.entries.length,
  '| ORBITAL_MECHANICS', counts.ORBITAL_MECHANICS,
  'DEBRIS', counts.DEBRIS, 'SPACE_ENVIRONMENT', counts.SPACE_ENVIRONMENT,
  `| rewrote ${rewrittenIds.size} entries`);
