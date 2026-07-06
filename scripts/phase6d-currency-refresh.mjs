#!/usr/bin/env node
// Phase 6d — Content batch D: currency refresh — WORLD_INDUSTRY (9) + NEWS (9) +
// CATALOG (10) + PLAYBOOK (10) to the editorial template
// (see .kilo/plans/1782994412021-tech-library-deep-dive-overhaul.md §2, Slice 5).
//
// This is the volatile-facts batch: every real-world figure was web-verified to
// 2026-07 and stamped `lastVerified` (WORLD_INDUSTRY/NEWS/CATALOG; PLAYBOOK
// exempt). Currency corrections folded in: EU Space Act *proposed* 2025 (not
// adopted); FCC 5-year rule effective 2024; ClearSpace-1 retargeted to PROBA-1,
// launch slipped to ~2028; ADRAS-J ~15 m (2024), ADRAS-J2 ~2027; Kosmos-1408
// debris ~99.7% decayed by 2025; tracked population ~40,000 (2025); SSR Platinum
// ratings (OneWeb 2024, SES O3b mPOWER 2025); Kosmos 482 reentered 10 May 2025.
//
// PLAYBOOK re-verified against the LIVE game (Constants.js / InputManager /
// StatusPanel), not old plans: WIN_DEBRIS_COUNT 50; power buses are
// Thrust/Sensors/DAUGHTERS (the old "Arms" label is gone); DETACH_SACRIFICE_MULT
// 2.5; capture-quality stack ≈ ×3.7 (1.3×2.0×1.25×1.15); keys S/T/A, backtick
// tool-cycle, [ ]/Shift+1-3 power, I for the codex.
//
// The three fictional NEWS event cards (ast_spacemobile, starlink_breakup,
// thaicom4) drop their spurious trl and gain a realWorld line naming the REAL
// satellite behind the in-game mission scenario.
//
// Same idempotent conventions as phase6a-c: upsert by id; two-way related
// symmetry (inbound-heal skipping PLAYBOOK, outbound reciprocation also honouring
// HEAL_SKIP_CATEGORIES). Part 2B (CATALOG/NEWS debrisCleared threshold
// compression 5-46 → 3-20) lives in codexTriggers.js; the hints below match it.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'data/codex.json');
const codex = JSON.parse(readFileSync(path, 'utf8'));

const NEW_ENTRIES = [
  // ============================ WORLD_INDUSTRY (9) ============================
  {
    id: 'world_adr_mandate', category: 'WORLD_INDUSTRY', icon: '📜', startUnlocked: true,
    related: ['adr_methods_real', 'kessler_syndrome', 'ssa_network', 'world_the_rules', 'world_liability', 'world_five_year_rule'],
    i18n: {
      title: 'Cleanup Is Now Mandatory',
      shortText: "For decades, deorbiting your dead satellite was polite. Now it's the law — and a real industry is racing to do it.",
      fullText: "The rules of orbit are tightening fast. Deorbiting a dead satellite used to be a courtesy; increasingly it is a legal obligation, and that shift has created a market for exactly the work you do.\n\nThe US Federal Communications Commission (FCC) now requires licensed low-orbit satellites to deorbit within 5 years of end-of-life, down from 25, a rule in force since 2024. ESA's Zero Debris Charter targets no new debris by 2030, the EU proposed a Space Act in 2025, and India's ISRO has pledged debris-free missions by 2030. Companies like Astroscale and ClearSpace fly the first removal missions while trackers such as LeoLabs and Slingshot map the junk. The removal operator you are playing is no longer science fiction; it is an industry with contracts, regulators, and deadlines.",
      realWorld: 'FCC 5-year rule (effective 2024) · ESA Zero Debris Charter (2030 goal) · EU Space Act proposed 2025 · ISRO Debris-Free 2030 · Astroscale, ClearSpace, LeoLabs',
      unlockHint: 'Start clearing debris to learn why the work exists.',
    },
  },
  {
    id: 'world_who_removes', category: 'WORLD_INDUSTRY', icon: '🛰️', startUnlocked: true,
    related: ['adr_methods_real', 'world_adr_mandate', 'world_the_rules', 'world_servicing'],
    i18n: {
      title: 'Who Actually Cleans Orbit',
      shortText: "Debris removal isn't science fiction — real companies are flying the first missions right now.",
      fullText: "A handful of companies are turning orbital cleanup into a business, inventing the removal-operator role in real time.\n\nAstroscale of Japan flew ELSA-d in 2021 to test magnetic capture, and in 2024 its ADRAS-J closed to about 15 metres from a spent rocket stage, the closest look yet at uncontrolled debris; a capture follow-on, ADRAS-J2, is due around 2027. Europe's ClearSpace-1 is being built to grab and deorbit the defunct PROBA-1 satellite, now targeting a launch around 2028, while firms like Starfish Space and D-Orbit develop tugs and de-orbit services. The job you play is exactly the one these teams are building toward.",
      realWorld: 'Astroscale ELSA-d (2021), ADRAS-J (~15 m, 2024), ADRAS-J2 (~2027); ClearSpace-1 (PROBA-1, ~2028); Starfish Space, D-Orbit.',
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'world_who_tracks', category: 'WORLD_INDUSTRY', icon: '📡', startUnlocked: true,
    related: ['ssa_network', 'conjunction_assessment', 'debris_tracking', 'world_sustainability_rating'],
    i18n: {
      title: 'Who Tracks the Junk',
      shortText: "You can't dodge what you can't see. A growing web of radars and telescopes maps orbit around the clock.",
      fullText: "Knowing where roughly 40,000 tracked objects are at any moment is its own industry, the quiet backbone under every safe operation up here.\n\nThe US Space Surveillance Network has catalogued orbital objects since the 1960s, and commercial trackers like LeoLabs, with its phased-array radars, and Slingshot Aerospace now map low orbit continuously and issue collision warnings. Every target you scan and every conjunction alert you receive is a nod to this real tracking backbone. What it cannot see, the millions of sub-catalogue fragments, is exactly the gap your onboard sensors reach into.",
      realWorld: 'US Space Surveillance Network + ESA catalogue ~40,000 tracked objects (2025); commercial trackers LeoLabs, Slingshot Aerospace.',
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'world_why_now', category: 'WORLD_INDUSTRY', icon: '⏳', startUnlocked: true,
    related: ['kessler_syndrome', 'world_adr_mandate', 'world_five_year_rule', 'world_sustainability_rating'],
    i18n: {
      title: 'Why Now?',
      shortText: "Orbit got crowded fast. Decades of leftovers plus mega-constellations turned 'someday' into 'this decade.'",
      fullText: "Two things turned cleanup from a someday-problem into a this-decade one.\n\nFirst, the leftovers: sixty-odd years of launches left thousands of dead satellites and spent stages that will not decay for decades. Second, the boom: mega-constellations are adding satellites by the thousand, so the odds of a collision, and of a runaway Kessler cascade, climb every year. Regulators answered with hard deadlines like the FCC's five-year rule, and that wave of obligation is the one you are riding.",
      realWorld: 'Tracked population ~40,000 and rising (2025); mega-constellation growth drives the collision-rate concern.',
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'world_the_rules', category: 'WORLD_INDUSTRY', icon: '⚖️', startUnlocked: true,
    related: ['world_adr_mandate', 'world_liability', 'world_who_removes', 'world_sustainability_rating'],
    i18n: {
      title: 'The Rules of the Road',
      shortText: "You can't just grab a dead satellite and keep it — half-century-old treaties say it still belongs to whoever launched it.",
      fullText: "Space has law, and it is old. The Outer Space Treaty, in force since 1967, says the state that launches an object keeps jurisdiction and control over it, even after it dies.\n\nThat single rule shapes the whole debris-removal business: you cannot legally salvage someone else's derelict without permission, so every cleanup needs the original owner's consent. The Liability Convention of 1972 adds teeth, making a launching state liable for damage its objects cause. The removal-for-hire job you do, with the owner's blessing, exists precisely because the junk is never truly abandoned.",
      realWorld: 'Outer Space Treaty (in force 1967); Liability Convention (in force 1972).',
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'world_liability', category: 'WORLD_INDUSTRY', icon: '💸', startUnlocked: true,
    related: ['world_the_rules', 'world_adr_mandate', 'news_iss_pallet'],
    i18n: {
      title: 'Who Pays When It Falls',
      shortText: 'Only one country has ever been billed for a space crash — when a Soviet nuclear satellite scattered over Canada in 1978.',
      fullText: "Under the 1972 Liability Convention, a launching state is liable for damage its space objects cause on Earth or in the air. It has been formally invoked exactly once.\n\nIn 1978 the Soviet satellite Kosmos 954, carrying a nuclear reactor, broke up over northern Canada and spread radioactive debris across thousands of square kilometres; Canada billed the USSR for the cleanup and was partly paid. As uncontrolled reentries grow more common, spent stages, retired satellites, even a piece of ISS battery pallet that punched through a Florida roof in 2024, this half-century-old rule is the framework everyone reaches for when something lands where it should not.",
      realWorld: 'Liability Convention (1972); sole claim filed: Kosmos 954 crash in Canada, 1978.',
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'world_five_year_rule', category: 'WORLD_INDUSTRY', icon: '⏳', startUnlocked: true,
    related: ['world_adr_mandate', 'world_why_now', 'adr_methods_real'],
    i18n: {
      title: 'The Five-Year Rule',
      shortText: 'The old deal: clean up your dead satellite within 25 years. The new US deal: make it five. The leash just got shorter.',
      fullText: "For decades the global guideline, set by the Inter-Agency Space Debris Coordination Committee (IADC), asked operators to remove a retired low-orbit satellite within 25 years, and it was voluntary.\n\nIn 2022 the US Federal Communications Commission (FCC) turned that into a rule and cut the limit to five years for satellites it licenses, a standard in force since 2024. The change reflects how crowded orbit has become: leaving thousands of dead spacecraft to decay for a quarter-century is untenable when new constellations add satellites by the thousand. Shorter deadlines mean more deliberate disposal, and more demand for the removal services you provide.",
      realWorld: 'IADC 25-year guideline (voluntary); FCC 5-year deorbit rule adopted 2022, effective 2024.',
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'world_servicing', category: 'WORLD_INDUSTRY', icon: '🔧', startUnlocked: true,
    related: ['news_mev1_servicing', 'world_who_removes', 'docking_berthing', 'heritage_solar_max', 'heritage_hubble_servicing'],
    i18n: {
      title: 'The Servicing Economy',
      shortText: 'Why scrap a satellite that only needs fuel? A new industry flies up to refuel and repair — the same skills that catch the dead ones.',
      fullText: "A growing business treats satellites as repairable assets rather than disposables. Called on-orbit servicing, assembly, and manufacturing (OSAM), it covers refuelling a satellite, towing one to a new orbit, or building structures in space.\n\nThe first commercial demonstration came in 2020, when Northrop Grumman's Mission Extension Vehicle docked to an aging Intelsat and became its new engine for five more years. The rendezvous-and-grab techniques that extend a working satellite's life are the very same ones that capture a tumbling derelict, which is why servicing companies and debris-removal companies keep turning out to be the same companies.",
      realWorld: 'On-orbit servicing (OSAM); first commercial demo: Northrop Grumman MEV-1 + Intelsat 901, 2020.',
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'world_sustainability_rating', category: 'WORLD_INDUSTRY', icon: '🌱', startUnlocked: true,
    related: ['world_who_tracks', 'world_why_now', 'world_the_rules'],
    i18n: {
      title: 'Scoring Good Behaviour',
      shortText: 'Orbit now has a credit score. Run a clean, trackable, deorbitable mission and you can earn a badge that says so.',
      fullText: "To reward operators who fly responsibly, a consortium convened through the World Economic Forum built the Space Sustainability Rating (SSR): a voluntary score grading a mission on how well it shares data, avoids collisions, plans disposal, and avoids adding debris.\n\nDeveloped with the European Space Agency, MIT, BryceTech, and the University of Texas at Austin, it is now run from eSpace at the EPFL in Switzerland. It has teeth in practice: Eutelsat's OneWeb constellation earned a Platinum rating in 2024 and SES's O3b mPOWER system in 2025, turning good citizenship in orbit into something measurable and marketable.",
      realWorld: 'Space Sustainability Rating (WEF-initiated; ESA/MIT/BryceTech/UT-Austin; run by eSpace at EPFL); Platinum: OneWeb 2024, SES O3b mPOWER 2025.',
      unlockHint: 'Reach orbit.',
    },
  },

  // ================================ CATALOG (10) ================================
  {
    id: 'catalog_vanguard1', category: 'CATALOG', icon: '🛰️',
    related: ['atmospheric_drag', 'orbital_period_altitude'],
    i18n: {
      title: 'Vanguard 1 — The Elder',
      shortText: 'Launched in 1958, this grapefruit-sized satellite is the oldest human-made object still in orbit.',
      fullText: "Vanguard 1 went up in March 1958, the fourth satellite ever launched, and although it fell silent in 1964 it is still up there, making it the oldest human-made object in orbit.\n\nIts orbit is high enough that atmospheric drag barely touches it, so it will keep circling for centuries. A museum piece you cannot visit, and a quiet reminder that what we put up tends to stay up far longer than the mission that placed it.",
      realWorld: 'Launched 17 Mar 1958 (4th satellite ever); silent since 1964; oldest human-made object still in orbit.',
      unlockHint: 'Clear 4 pieces of debris.',
    },
  },
  {
    id: 'catalog_telstar1', category: 'CATALOG', icon: '📺',
    related: ['van_allen_belts', 'solar_storm', 'catalog_vanguard1'],
    i18n: {
      title: 'Telstar 1 — First Voice in the Sky',
      shortText: 'It relayed the first live TV across the Atlantic in 1962 — then a nuclear test in the radiation belts killed it.',
      fullText: "Telstar 1, launched 10 July 1962, was the first active communications satellite, carrying the first live transatlantic television and the first satellite phone call.\n\nIts life was short. The day before launch, a high-altitude US nuclear test, Starfish Prime, pumped extra radiation into the Van Allen belts, the zones of charged particles trapped by Earth's magnetic field. That radiation overwhelmed Telstar's fragile transistors, and it fell silent in early 1963. The 77 kg sphere has circled, dead, ever since, a working monument to the dawn of satellite communications.",
      realWorld: 'AT&T / Bell Labs / NASA; launched 10 Jul 1962; failed Feb 1963; still in orbit.',
      unlockHint: 'Clear 5 pieces of debris.',
    },
  },
  {
    id: 'catalog_envisat', category: 'CATALOG', icon: '🛰️',
    related: ['adr_methods_real', 'conjunction_assessment', 'debris_classification'],
    i18n: {
      title: 'Envisat — The 8-Tonne Derelict',
      shortText: "Europe's largest Earth-observation satellite went silent in 2012 and never came down: eight tonnes, tumbling, in a busy lane.",
      fullText: "Envisat was ESA's flagship Earth-observation satellite, at roughly 8,200 kg and the size of a bus one of the largest objects ever placed in low orbit. It abruptly stopped responding in April 2012 and now drifts, uncontrolled, near 770 km, in the middle of a heavily-used sun-synchronous corridor.\n\nIt cannot deorbit naturally for about 150 years, and a single collision could shower the region with thousands of fragments, which is exactly why it tops nearly every active-debris-removal target list. It is the marquee big, dead, and dangerous object: the kind of capture that actually moves the needle.",
      realWorld: 'ESA, launched 2002; contact lost 2012; drifts near 770 km; perennial top-priority ADR target.',
      unlockHint: 'Clear 7 pieces of debris.',
    },
  },
  {
    id: 'catalog_kosmos482', category: 'CATALOG', icon: '🪐',
    related: ['atmospheric_drag', 'titanium_alloys', 'catalog_envisat'],
    i18n: {
      title: 'Kosmos 482 — The Venus Lander That Stayed',
      shortText: 'A 1972 Soviet probe meant for Venus never left Earth orbit. Built to survive Venus, it fell back intact 53 years later.',
      fullText: "In March 1972 the Soviet Union launched a Venera-program probe toward Venus, but a timer fault cut its escape burn short and stranded it in low Earth orbit. Renamed Kosmos 482, its roughly 495 kg descent capsule was engineered to survive the crushing heat and pressure of a Venus landing, so it shrugged off decades in orbit.\n\nOn 10 May 2025, after 53 years, it finally reentered and fell into the Indian Ocean, likely in one hardened piece rather than burning up. A reminder that some derelicts are built tougher than the spacecraft sent to chase them.",
      realWorld: 'Soviet Venera program; launched 31 Mar 1972; reentered 10 May 2025 (confirmed).',
      unlockHint: 'Clear 8 pieces of debris.',
    },
  },
  {
    id: 'catalog_les1', category: 'CATALOG', icon: '📡',
    related: ['battery_chemistry', 'comms_blackout'],
    i18n: {
      title: 'LES-1 — The Zombie Sat',
      shortText: 'Dead since 1967, it started transmitting again in 2013. Nobody told it to.',
      fullText: "LES-1, a small US military communications satellite, was stranded in the wrong orbit in 1965 and went dark in 1967.\n\nThen in 2013 an amateur astronomer picked up its signal again. It had woken up, most likely because failed batteries let sunlight power the transmitter directly as the satellite tumbled through the light. A derelict that talks: proof that dead hardware can still surprise the people who thought they were done with it.",
      realWorld: 'MIT Lincoln Laboratory LES-1; launched 1965, silent 1967; re-detected transmitting 2013.',
      unlockHint: 'Clear 9 pieces of debris.',
    },
  },
  {
    id: 'catalog_cosmos_iridium', category: 'CATALOG', icon: '💥',
    related: ['kessler_syndrome', 'iridium_cosmos', 'conjunction_assessment'],
    i18n: {
      title: 'Iridium 33 × Cosmos 2251',
      shortText: 'In 2009 a working satellite and a dead one slammed together at ~11.7 km/s — the first big accidental collision.',
      fullText: "On 10 February 2009 the active Iridium 33 communications satellite and the defunct Russian Cosmos 2251 collided over Siberia at roughly 11.7 km/s, destroying both.\n\nThe crash scattered thousands of trackable fragments that still circle today. It was the first major accidental satellite collision, the event that turned Kessler syndrome from a theory into headlines and put conjunction screening and debris removal on the industry's agenda.",
      realWorld: 'Iridium 33 (active) + Cosmos 2251 (derelict), 10 Feb 2009, ~11.7 km/s; 2,000+ tracked fragments.',
      unlockHint: 'Clear 11 pieces of debris.',
    },
  },
  {
    id: 'catalog_sl16', category: 'CATALOG', icon: '🛢️',
    related: ['adr_methods_real', 'kessler_syndrome', 'world_who_removes'],
    i18n: {
      title: 'SL-16 Rocket Bodies — The Heavy Hazards',
      shortText: 'Spent Soviet rocket stages, nine tonnes each, abandoned in busy orbits. Trackers rank them the most dangerous junk up there.',
      fullText: "When a rocket lofts a satellite, the empty upper stage is often left in orbit. The Zenit-2 second stage, catalogued by trackers as SL-16, is the worst offender: each is a roughly 8.8-9 tonne steel cylinder, and about 17-20 of them drift near 800-1,000 km.\n\nA 2020 risk analysis found the 20 most dangerous objects in low Earth orbit were all SL-16 stages, heavy, intact, and parked where a single collision would spray thousands of fragments. They sit at the top of nearly every active debris removal (ADR) shopping list, including yours.",
      realWorld: 'Zenit-2 upper stages; ~17-20 in orbit near 800-1,000 km; top-ranked ADR targets (2020 risk analysis).',
      unlockHint: 'Clear 13 pieces of debris.',
    },
  },
  {
    id: 'catalog_cz5b', category: 'CATALOG', icon: '🚀',
    related: ['atmospheric_drag', 'kessler_syndrome', 'news_iss_pallet'],
    i18n: {
      title: 'Long March 5B — The Falling Core',
      shortText: 'A 21-tonne rocket core that reaches orbit, then falls back uncontrolled. Four of them have rained debris on three continents.',
      fullText: "Most big rockets steer their spent stages to a safe ocean splashdown. China's Long March 5B does not: its roughly 21.6 tonne core stage reaches orbit with the payload, then reenters uncontrolled days later, scattering surviving debris along an unpredictable track.\n\nIt has happened four times, in May 2020 (pipes landed in Ivory Coast), May 2021 (near the Maldives), July 2022, and November 2022 (fragments recovered in Malaysia and Indonesia). At 21 tonnes it is among the most massive objects to make an uncontrolled return, and a recurring flashpoint in the debate over who answers for what falls.",
      realWorld: 'CZ-5B core stage ~21.6 t; uncontrolled reentries 2020, 2021, 2022 (×2).',
      unlockHint: 'Clear 14 pieces of debris.',
    },
  },
  {
    id: 'catalog_fengyun1c', category: 'CATALOG', icon: '☄️',
    related: ['kessler_syndrome', 'fengyun_test', 'hypervelocity'],
    i18n: {
      title: 'Fengyun-1C — The Worst Cloud',
      shortText: 'A 2007 anti-satellite test shattered one weather satellite into 3,000+ trackable pieces — the largest debris cloud ever made.',
      fullText: "In January 2007 China destroyed its own defunct Fengyun-1C weather satellite in an anti-satellite missile test.\n\nThe impact created more than 3,000 trackable fragments, the single largest debris-generating event on record, much of it in a long-lived orbit near 865 km. Years later its shrapnel still forces collision-avoidance manoeuvres across low orbit. One test, a generation of hazard.",
      realWorld: 'Fengyun-1C ASAT test, 11 Jan 2007, ~865 km; 3,000+ tracked fragments; largest single debris event on record.',
      unlockHint: 'Clear 15 pieces of debris.',
    },
  },
  {
    id: 'catalog_kosmos1408', category: 'CATALOG', icon: '🎯',
    related: ['kessler_syndrome', 'fengyun_test', 'conjunction_assessment', 'catalog_fengyun1c'],
    i18n: {
      title: 'Kosmos 1408 — The 2021 Debris Cloud',
      shortText: 'Russia blew up its own dead satellite in a 2021 missile test. The Space Station crew had to shelter in their escape capsules.',
      fullText: "On 15 November 2021 Russia destroyed Kosmos 1408, a defunct 1982 spy satellite, in an anti-satellite (ASAT) weapon test, firing a ground-launched missile at its own spacecraft. The impact produced at least 1,500 trackable fragments spread between about 300 and 1,100 km, and the seven astronauts aboard the International Space Station were ordered into their return capsules as the cloud swept past every 90 minutes.\n\nThere is a hopeful coda: the cloud sat low enough that atmospheric drag has done its work, and by late 2025 only a handful of tracked fragments remained. It was the fourth major ASAT test to litter orbit, and a stark lesson in how fast one deliberate act multiplies the hazard, and how slowly the low ones fade.",
      realWorld: 'Russian ASAT test, 15 Nov 2021; ~1,500 trackable fragments; ISS crew sheltered; ~99.7% decayed by late 2025.',
      unlockHint: 'Clear 18 pieces of debris.',
    },
  },

  // ================================= NEWS (9) =================================
  {
    id: 'news_starlink_storm', category: 'NEWS', icon: '🌎',
    related: ['solar_storm', 'geomagnetic_storm', 'atmospheric_drag'],
    i18n: {
      title: 'A Solar Storm Sinks 38 Starlinks',
      shortText: 'In 2022 a minor space-weather storm puffed up the upper atmosphere just enough to drag a fresh batch of satellites back down.',
      fullText: "On 3 February 2022 SpaceX launched 49 Starlink satellites into a very low deployment orbit, near 210 km. A day later a minor geomagnetic storm, a disturbance in Earth's magnetic field driven by the Sun, heated and expanded the upper atmosphere and raised the drag on those satellites by an estimated 50%.\n\nMost could not climb out in time: up to 40 were doomed, and about 38 reentered and burned up. It was a vivid demonstration that empty space near Earth still holds enough air to matter, and that space weather is an operational hazard, not a curiosity.",
      realWorld: 'SpaceX Starlink, launched 3 Feb 2022; ~38 lost to geomagnetic-storm drag.',
      unlockHint: 'Clear 3 pieces of debris.',
    },
  },
  {
    id: 'news_tiangong_dodge', category: 'NEWS', icon: '🇨🇳',
    related: ['conjunction_assessment', 'ssa_network', 'world_who_tracks'],
    i18n: {
      title: 'A Space Station Dodges Twice',
      shortText: 'In 2021 China told the UN its crewed station had to swerve around Starlink satellites — twice. Crowded orbits got personal.',
      fullText: "In a December 2021 note to the United Nations, China reported that its crewed Tiangong space station had performed two collision-avoidance maneuvers earlier that year, on 1 July and 21 October 2021, to dodge passing SpaceX Starlink satellites.\n\nWhether or not the risk was as sharp as claimed, the filing marked a turning point: as mega-constellations add thousands of satellites, even crewed stations now have to actively get out of the way. Conjunction, a close approach between two orbiting objects, used to be rare news. It is becoming routine traffic management.",
      realWorld: 'China UN filing, Dec 2021; Tiangong maneuvers 1 Jul & 21 Oct 2021.',
      unlockHint: 'Clear 6 pieces of debris.',
    },
  },
  {
    id: 'news_iss_pallet', category: 'NEWS', icon: '🏠',
    related: ['atmospheric_drag', 'catalog_cz5b', 'world_liability'],
    i18n: {
      title: 'A Piece of the Station Hits a House',
      shortText: 'A chunk of old Space Station batteries survived reentry in 2024 and punched through a roof in Florida. Not abstract anymore.',
      fullText: "In 2021 the International Space Station released a 2.6-tonne pallet of spent batteries to reenter naturally. On 8 March 2024 it came down, and not all of it burned up.\n\nA small metal stanchion, a nickel-alloy piece weighing about 0.7 kg, tore through the roof of a home in Naples, Florida. NASA later confirmed the fragment came from the station pallet. No one was hurt, but it was a rare, concrete reminder that what we abandon in orbit eventually returns, and that controlled disposal exists precisely so the odds stay tiny.",
      realWorld: 'ISS EP-9 battery pallet; reentered 8 Mar 2024; fragment struck a Naples, FL home (NASA-confirmed).',
      unlockHint: 'Clear 10 pieces of debris.',
    },
  },
  {
    id: 'news_aeolus_reentry', category: 'NEWS', icon: '🌬️',
    related: ['adr_methods_real', 'world_adr_mandate', 'atmospheric_drag'],
    i18n: {
      title: 'Aeolus — A Tidy Way Down',
      shortText: "Europe's wind satellite was nudged down on purpose in 2023 — the first 'assisted reentry,' lowering the odds of hitting anyone.",
      fullText: "When the European Space Agency's Aeolus wind-mapping satellite, launched in 2018, ran out of life, controllers tried something new. Aeolus was never designed to steer its own reentry.\n\nOn 28 July 2023 the team used its last fuel to fly a series of commanded burns, guiding the falling satellite over the empty Southern Ocean before atmospheric drag finished the job. This first-ever assisted reentry cut the already-small risk to people on the ground by a large factor, and set a template for retiring older satellites responsibly rather than letting them drop where they may.",
      realWorld: 'ESA Aeolus (launched 2018); first assisted reentry, 28 Jul 2023.',
      unlockHint: 'Clear 12 pieces of debris.',
    },
  },
  {
    id: 'news_mev1_servicing', category: 'NEWS', icon: '🤖',
    related: ['docking_berthing', 'docking_precision', 'world_who_removes', 'world_servicing', 'heritage_solar_max'],
    i18n: {
      title: 'A Robot Refuels a Satellite',
      shortText: 'In 2020 one spacecraft flew up, latched onto a dying satellite, and became its new engine — the first commercial docking in high orbit.',
      fullText: "In February 2020 Northrop Grumman's Mission Extension Vehicle (MEV-1) caught up with Intelsat 901, a communications satellite running low on fuel in geostationary orbit, the ring about 35,800 km up where satellites hover over a fixed spot on Earth.\n\nMEV-1 docked to it and took over steering and station-keeping, effectively becoming a strap-on engine, and returned the satellite to service for five more years. It was the first time one commercial spacecraft serviced another in orbit. The same rendezvous-and-grab skills that extend a satellite's life are the skills that capture a dead one.",
      realWorld: 'Northrop Grumman MEV-1 + Intelsat 901; docked 25 Feb 2020 (first commercial GEO docking).',
      unlockHint: 'Clear 16 pieces of debris.',
    },
  },
  {
    id: 'news_yunhai_collision', category: 'NEWS', icon: '💢',
    related: ['kessler_syndrome', 'catalog_cosmos_iridium', 'conjunction_assessment'],
    i18n: {
      title: 'Hit by a 1996 Rocket',
      shortText: 'In 2021 a working Chinese satellite was struck by a shard from a rocket launched 25 years earlier. Old junk never really goes away.',
      fullText: "On about 18 March 2021 the Chinese satellite Yunhai-1 02 was clipped by a small fragment of a Russian Zenit-2 rocket stage, debris from a launch back in 1996. Tracking analysts spotted the satellite suddenly shedding pieces and traced the cause to the quarter-century-old shard.\n\nYunhai survived and kept partially working, but it became only the second confirmed accidental collision between catalogued objects, after Iridium 33 and Cosmos 2251 in 2009. The lesson is sobering: debris you ignore today can come back to wreck a working satellite decades later.",
      realWorld: 'Yunhai-1 02 struck by a 1996 Zenit-2 fragment, ~18 Mar 2021 (2nd confirmed collision).',
      unlockHint: 'Clear 20 pieces of debris.',
    },
  },
  {
    id: 'news_ast_spacemobile', category: 'NEWS', icon: '📰',
    related: ['kessler_syndrome', 'conjunction_assessment'],
    i18n: {
      title: 'AST SpaceMobile BW3',
      shortText: "A 64 m² phased-array test satellite, tumbling in the busy ISS corridor — and a high-value capture contract lands on your desk.",
      fullText: "AST SpaceMobile's BlueWalker 3 is a 64 m² phased-array test satellite launched in 2022 to prove direct-to-cell connectivity, beaming ordinary phone signals from orbit.\n\nIn this mission scenario a reaction-wheel failure has left it tumbling at 2°/s in the crowded 350 km ISS corridor, where its huge array makes it a serious Kessler risk. At 700 kg it is a rich capture: gallium arsenide in the solar cells, indium and gold in the phased array. A ₹25,000 bounty rides on a safe deorbit.",
      realWorld: 'AST SpaceMobile BlueWalker 3: real 64 m² direct-to-cell test satellite, launched Sept 2022. (Tumble and bounty are a mission scenario.)',
      unlockHint: 'Fly the AST SpaceMobile contract when it breaks.',
    },
  },
  {
    id: 'news_starlink_breakup', category: 'NEWS', icon: '📰',
    related: ['kessler_syndrome', 'breakup_events', 'battery_chemistry'],
    i18n: {
      title: 'Starlink V2-Mini Breakup',
      shortText: 'A battery thermal runaway fragments a Starlink cluster, seeding a dense threat corridor in the 540 km shell.',
      fullText: "A lithium-ion battery thermal runaway has fragmented a cluster of 35 Starlink V2-Mini satellites in the 540 km shell, and the expanding cloud threatens hundreds of operational Starlinks and other assets in the 53° band.\n\nEach fragment is small, averaging 50 kg, but the sheer number creates a dense threat corridor that has to be swept fast before it cascades. SpaceX has posted a ₹50,000 bounty for the full sweep, and the electronics-rich debris is a good source of gallium and indium for FEEP propellant refinement.",
      realWorld: 'Starlink V2-Mini: real SpaceX hardware. (The 35-satellite battery cascade is a mission scenario.)',
      unlockHint: 'Fly the Starlink breakup contract when it breaks.',
    },
  },
  {
    id: 'news_thaicom4', category: 'NEWS', icon: '📰',
    related: ['thaicom_graveyard', 'hohmann_transfer'],
    i18n: {
      title: 'Thaicom 4 (IPSTAR)',
      shortText: 'At 6,505 kg, the largest commercial satellite ever built — now a GEO derelict with a first-of-its-kind removal contract.',
      fullText: "Thaicom 4, also called IPSTAR, was at 6,505 kg the largest commercial communications satellite ever built when Arianespace launched it in 2005, serving Southeast Asia's broadband from geostationary orbit.\n\nIn this scenario, after twenty years Thailand's regulator has ordered its removal from the graveyard band — the first GEO active-debris-removal contract, demanding a full orbit-raise, precise station-keeping, and a grapple on its wide arrays and reflectors. The ₹100,000 bounty reflects the difficulty; a deep-space dish is recommended for tracking it out at GEO.",
      realWorld: 'Thaicom 4 (IPSTAR): real ~6,505 kg GEO satellite, launched 2005. (The removal contract is a mission scenario.)',
      unlockHint: 'Fly the Thaicom 4 GEO contract when it breaks.',
    },
  },

  // =============================== PLAYBOOK (10) ===============================
  {
    id: 'welcome_cowboy', category: 'PLAYBOOK', icon: '🤠', startUnlocked: true,
    related: ['kessler_syndrome', 'adr_methods_real', 'delta_v'],
    i18n: {
      title: 'Welcome, Cowboy',
      shortText: "Low orbit is getting dangerous to use. You're here to clean it up — one piece of junk at a time.",
      fullText: "Welcome to space, Cowboy. Decades of launches left low Earth orbit littered with dead satellites and shrapnel, and every collision makes more, the runaway feedback called Kessler syndrome. Your job is active debris removal: fly your mothership and its daughter drones out to derelict objects, capture them, and either drag them down to burn up or salvage them for parts.\n\nThe core loop is simple: scan for targets, let autopilot bring you alongside, capture, and bank the haul. Clear enough debris, fifty pieces to win the shift, and you have helped keep orbit usable. This library fills in as you go, every system you touch unlocking the science behind it. Press I anytime to come back here.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'core_loop', category: 'PLAYBOOK', icon: '🔁', startUnlocked: true,
    related: ['rendezvous', 'tool_choice', 'salvage_economy'],
    i18n: {
      title: 'The Core Loop',
      shortText: "Scan, pick a target, let autopilot fly you there, capture, cash in. Repeat. That's the whole job.",
      fullText: "Five steps, and then you do them again. That is the entire job.\n\n1. Scan (S) to find debris. 2. Target (T) to pick one. 3. Autopilot (A) flies you alongside — you don't hand-fly there. 4. Capture it with a daughter's net. 5. Bank the haul: drag it down to burn up, or salvage it for parts.\n\nClear 50 pieces and the shift is won. Everything else in this library just explains one of these five steps in more depth.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'reading_the_hud', category: 'PLAYBOOK', icon: '🖥️', startUnlocked: true,
    related: ['core_loop', 'autopilot_first'],
    i18n: {
      title: 'Reading the Screen',
      shortText: 'A nav-ball, a few status panels, and a colour code that runs green to red. Glance for red; read the rest when curious.',
      fullText: "Don't try to absorb every readout at once. The essentials are few.\n\nThe NavSphere (nav-ball) shows where you're pointed and where your target sits; the side panels track ship health, power, and resources; and the status colours run from green (fine) toward red (act now). You can play the whole loop just watching for red and trusting autopilot for the rest. The detail is all here in the library when you want it.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'delta_v_doctrine', category: 'PLAYBOOK', icon: '⛽', startUnlocked: true,
    related: ['delta_v', 'specific_impulse', 'salvage_economy'],
    i18n: {
      title: 'ΔV Is Everything',
      shortText: "Fuel doesn't refill on its own. Every burn spends a budget you can't get back for free.",
      fullText: "Delta-V (ΔV), your ability to change orbit, is the master resource. Your xenon and cold-gas tanks do not magically refill: the only way to top up is to salvage metal and run it through the Forge into propellant.\n\nSo fly cheap. Let autopilot pick efficient routes, and don't chase a target across the sky when a closer one will do. Run every tank dry and the mission ends, wherever you happen to be.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'autopilot_first', category: 'PLAYBOOK', icon: '🛰️', startUnlocked: true,
    related: ['prograde_paradox', 'rendezvous', 'core_loop'],
    i18n: {
      title: 'Let the Autopilot Fly',
      shortText: 'Hand-flying in orbit is a black-belt skill. For almost everything, press A and let the computer do it.',
      fullText: "Orbital motion is counter-intuitive: thrust straight at a target and you will usually miss it, an effect known as the prograde paradox.\n\nThat is why autopilot (A) is the default. It solves the approach for you and burns less fuel doing it. Manual piloting exists for fine moments and bragging rights, but you can win the entire game leaning on autopilot. Automating isn't cheating up here; the professionals do exactly the same.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'tool_choice', category: 'PLAYBOOK', icon: '🧰', startUnlocked: true,
    related: ['miura_ori_net', 'detumble', 'recoil_cancellation'],
    i18n: {
      title: 'Net, Gripper, or Magnet?',
      shortText: 'Different junk wants different tools. The game suggests one — and you can cycle to the rest.',
      fullText: "Your daughters carry several capture tools: a net is the workhorse, backed by grippers, magnets, and pads.\n\nThe game reads each target and marks a recommended tool with a ▶. While piloting a daughter, tap the backtick key ( ` ) to cycle through the options. Big tumbling slab? Net. Small iron fragment? Magnet. When in doubt, take the suggestion — it is usually right.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'arm_sacrifice', category: 'PLAYBOOK', icon: '🤲', startUnlocked: true,
    related: ['docking_berthing', 'detumble'],
    i18n: {
      title: 'When to Sacrifice an Arm',
      shortText: 'Bring a daughter home to reuse it — or ride it down with the junk for a bigger payout.',
      fullText: "Most captures mean tethering the target and reeling it in. But for stubborn or massive debris you can send a daughter down with it on a deorbit burn, sacrificing the arm for a bonus worth up to ×2.5 the score.\n\nIt is a genuine trade: lose hardware now for a bigger clear, or keep your fleet and play the long game. Early on, keep your arms. Once you can spare one, the deorbit bonus adds up fast.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'salvage_economy', category: 'PLAYBOOK', icon: '♻️', startUnlocked: true,
    related: ['delta_v_doctrine', 'what_10000kg_buys'],
    i18n: {
      title: 'The Salvage Economy',
      shortText: 'Dead satellites are a gas station. Grab the metal, run the Forge, refuel — your only way to top up.',
      fullText: "A captured object isn't just a tick on the counter; it is raw material. Salvage yields metal, and sometimes a splash of propellant or an on-the-spot panel repair.\n\nFeed salvaged metal into the Forge in propellant mode and it becomes fuel you can burn. Because the tanks never refill for free, the salvage-to-Forge-to-propellant loop is the heartbeat that keeps you flying. You clean up and gas up in the same move.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'power_triage', category: 'PLAYBOOK', icon: '⚡', startUnlocked: true,
    related: ['eclipse_cycle', 'battery_chemistry'],
    i18n: {
      title: 'Power Under Eclipse',
      shortText: 'Half of every orbit is night. With no sun, you ration power across three buses: thrust, sensors, daughters.',
      fullText: "Your solar panels stop producing the instant you cross into Earth's shadow, and you run on battery. Power flows through three buses, Thrust, Sensors, and Daughters, and you can shift the balance: Shift+1/2/3 selects a bus, then [ and ] trim it.\n\nGoing into eclipse with a capture to finish? Lean power toward Daughters. Long coast ahead? Favour Thrust. Manage the dark half of the orbit and the bright half takes care of itself.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'capture_quality', category: 'PLAYBOOK', icon: '⭐', startUnlocked: true,
    related: ['tool_choice', 'core_loop'],
    i18n: {
      title: 'Capture Quality Pays',
      shortText: 'A clean, scanned, fuel-smart capture can score nearly four times a sloppy one. Style matters.',
      fullText: "Not all captures are equal. Scan a target's structure before you grab it, pilot the daughter in by hand, approach without burning much fuel, and recover its salvage: each adds a multiplier.\n\nStacked, those bonuses reach almost ×3.7 over a bare auto-grab. You never have to chase the perfect capture, but when you want a high score, or a faster fifty, quality beats quantity.",
      unlockHint: 'Reach orbit.',
    },
  },
];

// lastVerified stamp — required on WORLD_INDUSTRY/NEWS/CATALOG (PLAYBOOK exempt).
for (const ne of NEW_ENTRIES) {
  if (['WORLD_INDUSTRY', 'NEWS', 'CATALOG'].includes(ne.category)) ne.lastVerified = '2026-07';
}

// --- upsert by id (idempotent, order-independent) ---
for (const ne of NEW_ENTRIES) {
  const i = codex.entries.findIndex((e) => e.id === ne.id);
  if (i >= 0) codex.entries[i] = ne;
  else codex.entries.push(ne);
}

const rewrittenIds = new Set(NEW_ENTRIES.map((e) => e.id));
const HEAL_SKIP_CATEGORIES = new Set(['PLAYBOOK']);
// A reciprocal link is created only when BOTH endpoints share PLAYBOOK-ness:
// concept↔concept and PLAYBOOK↔PLAYBOOK symmetrize, but a tutorial→concept link
// (PLAYBOOK→non-PLAYBOOK) stays one-directional so concept entries never show a
// tutorial chip. For phase6a-c (which never rewrote PLAYBOOK) this XOR reduces
// exactly to the old "skip PLAYBOOK targets" rule, so their output is unchanged.
const linkSkipped = (a, b) =>
  HEAL_SKIP_CATEGORIES.has(a.category) !== HEAL_SKIP_CATEGORIES.has(b.category);

// --- heal inbound links orphaned by the rewrite (respecting the XOR rule) ---
for (const ne of NEW_ENTRIES) {
  for (const other of codex.entries) {
    if (other.id === ne.id) continue;
    if (linkSkipped(ne, other)) continue;
    if ((other.related || []).includes(ne.id)) {
      ne.related = ne.related || [];
      if (!ne.related.includes(other.id)) ne.related.push(other.id);
    }
  }
}

// --- outbound symmetrization (respecting the XOR rule) ---
const byId = new Map(codex.entries.map((e) => [e.id, e]));
for (const ne of NEW_ENTRIES) {
  for (const rid of ne.related || []) {
    const target = byId.get(rid);
    if (!target || linkSkipped(ne, target)) continue;
    target.related = target.related || [];
    if (!target.related.includes(ne.id)) target.related.push(ne.id);
  }
}

writeFileSync(path, JSON.stringify(codex, null, 2) + '\n', 'utf8');
const counts = {};
for (const e of codex.entries) counts[e.category] = (counts[e.category] || 0) + 1;
console.log('[phase6d] entries now', codex.entries.length,
  '| WORLD_INDUSTRY', counts.WORLD_INDUSTRY, 'NEWS', counts.NEWS,
  'CATALOG', counts.CATALOG, 'PLAYBOOK', counts.PLAYBOOK,
  `| rewrote ${rewrittenIds.size} entries`);
