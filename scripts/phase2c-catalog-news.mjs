#!/usr/bin/env node
// Phase 2c — expand the two "fascinating" discovery categories with verified,
// sourced content: +5 CATALOG marquee objects and +6 NEWS & EVENTS cards.
// Idempotent (upsert by id). All facts verified against Wikipedia/ESA/NASA/
// SpaceNews/Jonathan McDowell (see session notes). Voice: acronyms are spelled
// out on first use (LEO, ADR, ASAT, GEO) so jargon is introduced gradually.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'data/codex.json');
const codex = JSON.parse(readFileSync(path, 'utf8'));

const NEW_ENTRIES = [
  // ===================== CATALOG — marquee real objects =====================
  {
    id: 'catalog_kosmos482', category: 'CATALOG', icon: '🪐',
    related: ['atmospheric_drag', 'titanium_alloys', 'catalog_envisat'],
    i18n: {
      title: 'Kosmos 482 — The Venus Lander That Stayed',
      shortText: "A 1972 Soviet probe meant for Venus never left Earth orbit. Built to survive Venus, it fell back — intact — 53 years later.",
      fullText: "In March 1972 the Soviet Union launched a Venera-program probe toward Venus, but a timer fault cut its escape burn short and stranded it in low Earth orbit (LEO) — the band of space from roughly 200 to 2,000 km up. Renamed Kosmos 482, its ~495 kg descent capsule was engineered to survive the crushing heat and pressure of a Venus landing, so it shrugged off decades in orbit. On 10 May 2025, after 53 years, it finally reentered and fell into the Indian Ocean — likely in one hardened piece rather than burning up. A reminder that some derelicts are built tougher than the spacecraft chasing them.",
      realWorld: 'Soviet Venera program; launched 31 Mar 1972; reentered 10 May 2025',
      unlockHint: 'Clear debris to be briefed on notable objects.',
    },
  },
  {
    id: 'catalog_telstar1', category: 'CATALOG', icon: '📺',
    related: ['van_allen_belts', 'solar_storm', 'catalog_vanguard1'],
    i18n: {
      title: 'Telstar 1 — First Voice in the Sky',
      shortText: 'It relayed the first live TV across the Atlantic in 1962 — then a nuclear test in the radiation belts killed it. It still orbits, silent.',
      fullText: "Telstar 1, launched 10 July 1962, was the first active communications satellite — it carried the first live transatlantic television and the first satellite phone call. Its life was short: the day before launch, a high-altitude U.S. nuclear test (Starfish Prime) pumped extra radiation into the Van Allen belts, the zones of charged particles trapped by Earth's magnetic field. That radiation overwhelmed Telstar's fragile transistors, and it fell silent in early 1963. The 77 kg sphere has circled, dead, ever since — a working monument to the dawn of satellite communications.",
      realWorld: 'AT&T / Bell Labs / NASA; launched 10 Jul 1962; failed Feb 1963; still in orbit',
      unlockHint: 'Clear debris to be briefed on notable objects.',
    },
  },
  {
    id: 'catalog_sl16', category: 'CATALOG', icon: '🛢️',
    related: ['adr_methods_real', 'kessler_syndrome', 'world_who_removes'],
    i18n: {
      title: 'SL-16 Rocket Bodies — The Heavy Hazards',
      shortText: 'Spent Soviet rocket stages, nine tonnes each, abandoned in busy orbits. Trackers rank them the single most dangerous junk up there.',
      fullText: "When a rocket lofts a satellite, the empty upper stage is often left in orbit. The Zenit-2 second stage (catalogued by trackers as SL-16) is the worst offender: each is a roughly 8.8–9 tonne steel cylinder, and about 17–20 of them drift near 800–1,000 km altitude. A 2020 risk analysis found the 20 most dangerous objects in low Earth orbit were all SL-16 stages — heavy, intact, and parked where a single collision would spray thousands of fragments. They sit at the top of nearly every active debris removal (ADR) shopping list, including yours.",
      realWorld: 'Zenit-2 upper stages; ~17–20 in orbit near 800–1,000 km; top-ranked ADR targets',
      unlockHint: 'Clear debris to be briefed on notable objects.',
    },
  },
  {
    id: 'catalog_cz5b', category: 'CATALOG', icon: '🚀',
    related: ['atmospheric_drag', 'kessler_syndrome', 'news_iss_pallet'],
    i18n: {
      title: 'Long March 5B — The Falling Core',
      shortText: 'A 21-tonne rocket core that reaches orbit, then falls back uncontrolled. Four of them have rained debris on three continents.',
      fullText: "Most big rockets steer their spent stages to a safe ocean splashdown. China's Long March 5B does not: its ~21.6 tonne core stage reaches orbit with the payload, then reenters uncontrolled days later, scattering surviving debris along an unpredictable track. It has happened four times — May 2020 (pipes landed in Ivory Coast), May 2021 (near the Maldives), July 2022, and November 2022 (fragments recovered in Malaysia and Indonesia). At 21 tonnes it is among the most massive objects to make an uncontrolled return, and a recurring flashpoint in the debate over who is responsible for what falls.",
      realWorld: 'CZ-5B core stage ~21.6 t; uncontrolled reentries 2020, 2021, 2022 (×2)',
      unlockHint: 'Clear debris to be briefed on notable objects.',
    },
  },
  {
    id: 'catalog_kosmos1408', category: 'CATALOG', icon: '🎯',
    related: ['kessler_syndrome', 'fengyun_test', 'conjunction_assessment', 'catalog_fengyun1c'],
    i18n: {
      title: 'Kosmos 1408 — The 2021 Debris Cloud',
      shortText: 'Russia blew up its own dead satellite in a 2021 missile test. The crew of the Space Station had to shelter in their escape capsules.',
      fullText: "On 15 November 2021 Russia destroyed Kosmos 1408 — a defunct 1982 spy satellite — in an anti-satellite (ASAT) weapon test, firing a ground-launched missile at its own spacecraft. The impact produced at least 1,500 trackable fragments spread between about 300 and 1,100 km altitude, threatening everything in low Earth orbit. The seven astronauts aboard the International Space Station were ordered into their return capsules as the cloud swept past every 90 minutes. It was the fourth major ASAT test to litter orbit, and a stark lesson in how fast one deliberate act multiplies the hazard.",
      realWorld: 'Russian ASAT test, 15 Nov 2021; ~1,500 trackable fragments; ISS crew sheltered',
      unlockHint: 'Clear debris to be briefed on notable objects.',
    },
  },
  // ===================== NEWS & EVENTS — recent real headlines ===============
  {
    id: 'news_starlink_storm', category: 'NEWS', icon: '🌎',
    related: ['solar_storm', 'geomagnetic_storm', 'atmospheric_drag'],
    i18n: {
      title: 'A Solar Storm Sinks 38 Starlinks',
      shortText: 'In 2022 a minor space-weather storm puffed up the upper atmosphere just enough to drag a fresh batch of satellites back down.',
      fullText: "On 3 February 2022 SpaceX launched 49 Starlink satellites into a very low deployment orbit (~210 km). A day later a minor geomagnetic storm — a disturbance in Earth's magnetic field driven by the Sun — heated and expanded the upper atmosphere, increasing the drag on those satellites by an estimated 50%. Most could not climb out in time: up to 40 were doomed, and about 38 reentered and burned up. It was a vivid demonstration that 'empty' space near Earth still has enough air to matter, and that space weather is an operational hazard, not a curiosity.",
      realWorld: 'SpaceX Starlink, launched 3 Feb 2022; ~38 lost to geomagnetic-storm drag',
      unlockHint: 'Keep clearing debris — the news desk will brief you.',
    },
  },
  {
    id: 'news_tiangong_dodge', category: 'NEWS', icon: '🇨🇳',
    related: ['conjunction_assessment', 'ssa_network', 'world_who_tracks'],
    i18n: {
      title: 'A Space Station Dodges Twice',
      shortText: "In 2021 China told the UN its crewed station had to swerve around Starlink satellites — twice. Crowded orbits are getting personal.",
      fullText: "In a December 2021 note to the United Nations, China reported that its crewed Tiangong space station had performed two collision-avoidance maneuvers earlier that year — on 1 July and 21 October 2021 — to dodge passing SpaceX Starlink satellites. Whether or not the risk was as sharp as claimed, the filing marked a turning point: as mega-constellations add thousands of satellites, even crewed stations now have to actively get out of the way. Conjunction — a close approach between two orbiting objects — used to be rare news. It is becoming routine traffic management.",
      realWorld: 'China UN filing, Dec 2021; Tiangong maneuvers 1 Jul & 21 Oct 2021',
      unlockHint: 'Keep clearing debris — the news desk will brief you.',
    },
  },
  {
    id: 'news_iss_pallet', category: 'NEWS', icon: '🏠',
    related: ['atmospheric_drag', 'catalog_cz5b'],
    i18n: {
      title: 'A Piece of the Station Hits a House',
      shortText: 'A chunk of old Space Station batteries survived reentry in 2024 and punched through a roof in Florida. The risk is no longer abstract.',
      fullText: "In 2021 the International Space Station released a 2.6-tonne pallet of spent batteries to reenter naturally. On 8 March 2024 it came down — and not all of it burned up. A small metal stanchion, a nickel-alloy piece weighing about 0.7 kg, tore through the roof of a home in Naples, Florida. NASA later confirmed the fragment came from the station pallet. No one was hurt, but it was a rare, concrete reminder that what we abandon in orbit eventually returns, and that controlled disposal exists precisely so the odds stay tiny.",
      realWorld: 'ISS EP-9 battery pallet; reentered 8 Mar 2024; fragment struck a Naples, FL home',
      unlockHint: 'Keep clearing debris — the news desk will brief you.',
    },
  },
  {
    id: 'news_aeolus_reentry', category: 'NEWS', icon: '🌬️',
    related: ['adr_methods_real', 'world_adr_mandate', 'atmospheric_drag'],
    i18n: {
      title: 'Aeolus — A Tidy Way Down',
      shortText: "Europe's wind satellite was nudged down on purpose in 2023 — the first 'assisted reentry,' lowering the odds of debris reaching anyone.",
      fullText: "When the European Space Agency's Aeolus wind-mapping satellite (launched 2018) ran out of life, controllers tried something new. Aeolus was never designed to steer its own reentry, but on 28 July 2023 the team used its last fuel to fly a series of commanded burns, guiding the falling satellite over the empty Southern Ocean before atmospheric drag finished the job. This first-ever 'assisted reentry' cut the already-small risk to people on the ground by a large factor, and set a template for retiring older satellites responsibly rather than just letting them drop where they may.",
      realWorld: 'ESA Aeolus (launched 2018); first assisted reentry, 28 Jul 2023',
      unlockHint: 'Keep clearing debris — the news desk will brief you.',
    },
  },
  {
    id: 'news_mev1_servicing', category: 'NEWS', icon: '🤖',
    related: ['docking_berthing', 'docking_precision', 'world_who_removes'],
    i18n: {
      title: 'A Robot Refuels a Satellite',
      shortText: 'In 2020 one spacecraft flew up, latched onto a dying satellite, and became its new engine — the first commercial docking in high orbit.',
      fullText: "In February 2020 Northrop Grumman's Mission Extension Vehicle (MEV-1) caught up with Intelsat 901, a communications satellite running low on fuel in geostationary orbit (GEO) — the ring ~35,800 km up where satellites hover over a fixed spot on Earth. MEV-1 docked to it and took over steering and station-keeping, effectively becoming a strap-on engine, and returned the satellite to service for five more years. It was the first time one commercial spacecraft serviced another in orbit. The same rendezvous-and-grab skills that extend a satellite's life are the skills that capture a dead one.",
      realWorld: 'Northrop Grumman MEV-1 + Intelsat 901; docked 25 Feb 2020 (first commercial GEO docking)',
      unlockHint: 'Keep clearing debris — the news desk will brief you.',
    },
  },
  {
    id: 'news_yunhai_collision', category: 'NEWS', icon: '💢',
    related: ['kessler_syndrome', 'catalog_cosmos_iridium', 'conjunction_assessment'],
    i18n: {
      title: 'Hit by a 1996 Rocket',
      shortText: 'In 2021 a working Chinese satellite was struck by a shard from a rocket launched 25 years earlier. Old junk never really goes away.',
      fullText: "On about 18 March 2021 the Chinese satellite Yunhai-1 02 was clipped by a small fragment of a Russian Zenit-2 rocket stage — debris from a launch back in 1996. Tracking analysts spotted the satellite suddenly shedding pieces and traced the cause to the quarter-century-old shard. Yunhai survived and kept partially working, but it became only the second confirmed accidental collision between catalogued objects (after Iridium 33 and Cosmos 2251 in 2009). The lesson is sobering: debris you ignore today can come back to wreck a working satellite decades later.",
      realWorld: 'Yunhai-1 02 struck by 1996 Zenit-2 fragment, ~18 Mar 2021 (2nd confirmed collision)',
      unlockHint: 'Keep clearing debris — the news desk will brief you.',
    },
  },
];

for (const ne of NEW_ENTRIES) {
  const i = codex.entries.findIndex((e) => e.id === ne.id);
  if (i >= 0) codex.entries[i] = ne;
  else codex.entries.push(ne);
}

writeFileSync(path, JSON.stringify(codex, null, 2) + '\n', 'utf8');
const counts = {};
for (const e of codex.entries) counts[e.category] = (counts[e.category] || 0) + 1;
console.log('[phase2c] entries now', codex.entries.length,
  '| CATALOG', counts.CATALOG, 'NEWS', counts.NEWS);
