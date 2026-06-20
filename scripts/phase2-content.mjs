#!/usr/bin/env node
// Phase 2 content patch — idempotent. Reads data/codex.json, applies PROPULSION
// i18n patches + related cross-links + new entries, rewrites the file.
// Safe to re-run (upserts by id).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'data/codex.json');
const codex = JSON.parse(readFileSync(path, 'utf8'));
const byId = new Map(codex.entries.map((e) => [e.id, e]));

// (A) PROPULSION i18n patches — merge realWorld/formula/shortText into entry.i18n
const I18N_PATCHES = {
  specific_impulse: {
    shortText: "How many seconds a kilo of propellant can hold up one newton — the efficiency yardstick every thruster is judged by.",
    realWorld: "Cold gas ~70 s · hydrazine ~230 s · xenon ion ~3,000 s · FEEP ~6,000 s",
    formula: "Isp = F / (ṁ · g₀)",
  },
  feep_thruster: {
    realWorld: "Enpulsion IFM Nano · Gaia (2013) · LISA Pathfinder (2016)",
    formula: "F = ṁ · v_exhaust  (micro-newton class)",
  },
  feep_indium:   { realWorld: "Enpulsion IFM Nano · LISA Pathfinder (2016) · GOCE", formula: "Isp ≈ 4,000–19,000 s" },
  feep_gallium:  { realWorld: "ESA Horizon 2000+ FEEP studies (ground)",            formula: "Isp ≈ up to 25,000 s · 0.028 N/W" },
  feep_bismuth:  { realWorld: "TU Dresden / Alta SpA ground tests (TRL 6)",         formula: "Isp ≈ 8,000 s · ~45 mN/W" },
  feep_iodine:   { realWorld: "ThrustMe NPT30-I2 · ESA SpaceVan (2020)",            formula: "Isp ≈ 2,000–4,500 s · ~60 mN/W" },
  feep_mercury:  { realWorld: "NASA SERT-I (1964) · Soviet Zond — abandoned ~1980s (toxicity)", formula: "Isp ≈ 3,000–10,000 s · ~40 mN/W" },
  feep_cesium:   { realWorld: "ESA/ESTEC cesium FEEP research (1970s–80s)",         formula: "Isp ≈ 8,000–22,000 s (highest)" },
  feep_tungsten: { realWorld: "APL high-thrust EP concepts (lab only, TRL 4)",      formula: "Isp ≈ 1,500–3,500 s · ~80 mN/W" },
  mpd_burst:     { realWorld: "MPD thrusters: kW–MW lab class; not yet operational for ADR", formula: "F = ½ · μ₀/(4π) · J² · ln(r_a/r_c)" },
  xenon_propellant:   { shortText: "Heavy, inert, easy to ionize — the default ion-drive propellant for half a century.", realWorld: "Dawn · SMART-1 · most GEO comsats" },
  krypton_propellant: { shortText: "Cheaper than xenon, lower Isp — the trade SpaceX made to fly thousands of thrusters.", realWorld: "SpaceX Starlink v1 (krypton Hall thrusters)" },
  argon_propellant:   { shortText: "Dirt-cheap and abundant — the next step down the cost curve, at a further Isp hit.", realWorld: "SpaceX Starlink v2 (argon Hall thrusters)" },
  cold_gas_thruster:  { shortText: "Just blow gas out a nozzle. Crude, low-Isp — and utterly reliable when nothing else may fire.", realWorld: "CPOD · countless CubeSats", formula: "Isp ≈ 40–70 s" },
  cold_gas_rcs:       { realWorld: "Fine attitude/RCS on most spacecraft", formula: "impulse-bit limited (mN·s)" },
  recoil_cancellation:{ realWorld: "Newton's 3rd law — dual net-launch cancels recoil", formula: "Σ m·v = 0 (momentum conserved)" },
  spring_energy:      { realWorld: "Stored elastic energy → net launch (no propellant)", formula: "E = ½ k x²" },
  // ORBITAL anchor referenced by specific_impulse.related
  delta_v: {
    realWorld: "LEO→GEO ≈ 3.9 km/s · LEO station-keeping ≈ 50 m/s/yr",
    formula: "Δv = Isp · g₀ · ln(m₀ / m_f)   (Tsiolkovsky)",
  },
};
for (const [id, patch] of Object.entries(I18N_PATCHES)) {
  const e = byId.get(id);
  if (!e) throw new Error('missing ' + id);
  Object.assign(e.i18n, patch);
}

// (B) related additions (union, no dupes)
const RELATED_ADD = {
  space_elevator:    ["cnt", "carbyne", "what_10000kg_buys"],
  graphene_gsl:      ["cnt", "carbyne"],
  carbon_composites: ["cnt"],
  solar_storm:       ["solar_wind"],
  geomagnetic_storm: ["solar_wind"],
  van_allen_belts:   ["solar_wind"],
  relative_velocity: ["rendezvous", "docking_berthing"],
  prograde_paradox:  ["rendezvous"],
  hohmann_transfer:  ["rendezvous"],
  docking_precision: ["docking_berthing", "rendezvous"],
  detumble:          ["docking_berthing"],
};
for (const [id, add] of Object.entries(RELATED_ADD)) {
  const e = byId.get(id);
  if (!e) throw new Error('missing ' + id);
  e.related = [...new Set([...(e.related || []), ...add])];
}

// (C) new entries — UPSERT by id (idempotent; safe to re-run)
const NEW_ENTRIES = [
  // ---- §3.10 MATERIALS: carbon-allotrope tether lineage ----
  {
    id: "cnt", category: "MATERIALS", trl: 3, icon: "🧵",
    related: ["space_elevator", "graphene_gsl", "carbyne", "carbon_composites"],
    i18n: {
      title: "Carbon Nanotubes (CNT)",
      shortText: "Roll a graphene sheet into a straw and you get the strongest fibre we can actually make — and the only credible space-elevator cable so far.",
      fullText: "A carbon nanotube is a single graphene sheet rolled into a cylinder ~1 nm across. Individual multi-walled tubes have been pulled to tensile strengths around 11–63 GPa in the lab — dozens of times stronger than steel by weight — with a theoretical ceiling above 100 GPa. The catch is length: defect-free tubes are microscopic, and spinning them into metre-scale yarn loses most of that strength to slippage between tubes. CNT is the leading real candidate material for a space-elevator tether, but production today tops out at short, imperfect fibres. It shares its lattice with the graphene in your Weaver capture nets — same chemistry, different geometry.",
      realWorld: "Space-elevator tether studies (NASA/ISEC); CNT yarns in aerospace composites",
      formula: "σ_measured ≈ 11–63 GPa  ·  σ_theoretical > 100 GPa",
      unlockHint: "Keep salvaging carbon-composite mass.",
      trlRationale: "Individual tubes proven; metre-scale high-strength tether yarn still unproven (TRL ~3)",
    },
  },
  {
    id: "carbyne", category: "MATERIALS", trl: 1, icon: "💠",
    related: ["cnt", "space_elevator", "graphene_gsl"],
    i18n: {
      title: "Carbyne — The Dream Tether",
      shortText: "A single chain of carbon atoms, predicted to be the strongest material that could exist. We can barely make a strand of it.",
      fullText: "Carbyne is linear acetylenic carbon: one infinite chain of carbon atoms, alternating single and triple bonds. Calculations put its specific strength at roughly twice that of carbon nanotubes or graphene — by that measure the strongest material theoretically possible, and the textbook \"dream\" space-elevator cable. Reality is humbling: free carbyne is wildly unstable and reacts with itself on contact. The longest chains made (Vienna, 2016) were ~6,000 atoms long and only survived by being sealed inside double-walled nanotubes. It belongs in the codex as an honest TRL 1: spectacular on paper, decades from a cable.",
      realWorld: "Confined carbyne synthesized inside nanotubes (Univ. Vienna, 2016)",
      formula: "predicted specific strength ≈ 2× CNT/graphene",
      unlockHint: "Clear deep into a mission — the materials frontier reveals itself.",
      trlRationale: "Predicted only; stable bulk carbyne does not yet exist (honest TRL 1)",
    },
  },
  // ---- §3.10 ENVIRONMENT ----
  {
    id: "solar_wind", category: "SPACE_ENVIRONMENT", trl: 9, icon: "🌬️",
    related: ["solar_storm", "geomagnetic_storm", "van_allen_belts"],
    i18n: {
      title: "The Solar Wind",
      shortText: "The Sun is always leaking. A million-tonne-per-second plasma breeze blows past you at 400 km/s — even on a 'quiet' day.",
      fullText: "The solar wind is a continuous stream of charged plasma — mostly protons and electrons — boiling off the Sun's corona and flooding the entire solar system. At Earth's orbit it blows at roughly 400 km/s (300–800 km/s) with a density of only a few particles per cubic centimetre, yet it never stops. This is distinct from a coronal mass ejection (CME): the wind is the steady background breeze, a CME is a discrete gust of billions of tonnes. The wind shapes Earth's magnetosphere, drives the aurora, and — when it gusts — inflates the upper atmosphere and raises drag on everything in LEO. Most 'space weather' you feel is the wind's mood, not a separate force.",
      realWorld: "Mapped by ACE, DSCOVR, Parker Solar Probe; baseline ~400 km/s at 1 AU",
      formula: "ram pressure  P ≈ ρ · v²   (drives magnetosphere shape)",
      unlockHint: "Ride out a space-weather event.",
      trlRationale: "Established heliophysics (natural phenomenon)",
    },
  },
  // ---- §3.10 ORBITAL ----
  {
    id: "rendezvous", category: "ORBITAL_MECHANICS", trl: 9, icon: "🛰️",
    related: ["relative_velocity", "prograde_paradox", "hohmann_transfer"],
    i18n: {
      title: "Orbit Matching & Rendezvous",
      shortText: "You don't chase a target in orbit — you match its orbit, then close the last gap at a crawl. Hurry and you'll fly right past it.",
      fullText: "Rendezvous is the art of bringing two orbits — and two phases along those orbits — into agreement. First you match the orbit (same altitude, plane, and shape) with transfer burns; then you manage phasing, because two craft on the same orbit can still be half a world apart. Closing the final distance is deliberately slow: thanks to the prograde paradox, thrusting straight at a target changes your orbit and makes you miss. Real approaches creep in along a controlled relative trajectory at centimetres per second. Every capture you make is a rendezvous solved.",
      realWorld: "Gemini VI/VII (1965, first crewed rendezvous); every ISS docking",
      formula: "phasing: Δt = Δθ / (n_target − n_chaser)",
      unlockHint: "Let autopilot arrive at a target.",
      trlRationale: "Routine operational astrodynamics",
    },
  },
  {
    id: "docking_berthing", category: "ORBITAL_MECHANICS", trl: 9, icon: "🤝",
    related: ["docking_precision", "detumble", "rendezvous"],
    i18n: {
      title: "Docking vs Berthing",
      shortText: "Two ways to finish the job: the spacecraft flies itself in (docking), or an arm grabs it and bolts it on (berthing). The last centimetre is the hard one.",
      fullText: "Once you've rendezvoused, you still have to connect. Docking is active: the incoming craft flies itself into a mating ring under its own control, latching on contact — fast, but it demands precise alignment and a cooperative, stable target. Berthing is passive: a robotic arm captures the free-floating object and a careful operator maneuvers it onto a fixture to be bolted down — slower, but far gentler and able to handle uncooperative or tumbling targets. Debris removal is almost always a berthing problem: the target is dead, often spinning, and must be de-spun before anything can grab it. Your daughters berth.",
      realWorld: "Docking: Apollo, Crew Dragon · Berthing: SSRMS/Canadarm2 captures of Cygnus/HTV",
      formula: null,
      unlockHint: "Make a capture.",
      trlRationale: "Mature operational technique",
    },
  },
  // ---- PLAYBOOK card (no trl) ----
  {
    id: "welcome_cowboy", category: "PLAYBOOK", icon: "🤠",
    related: ["kessler_syndrome", "adr_methods_real", "delta_v"],
    i18n: {
      title: "Welcome, Cowboy",
      shortText: "Low orbit is getting dangerous to use. You're here to clean it up — one piece of junk at a time.",
      fullText: "Welcome to space, Cowboy. Decades of launches left low Earth orbit littered with dead satellites and shrapnel, and every collision makes more — the runaway feedback called Kessler syndrome. Your job is active debris removal: fly your mothership and its daughter drones out to derelict objects, capture them, and either drag them down to burn up or salvage them for parts. The core loop is simple — scan for targets, let autopilot bring you alongside, capture, and bank the haul. Clear enough debris (the mission goal) and you've helped keep orbit usable. This library fills in as you go: every system you touch unlocks the science behind it. Press I anytime to come back here.",
      unlockHint: "Reach orbit.",
    },
  },
  // ---- CATALOG card (no trl) ----
  {
    id: "catalog_envisat", category: "CATALOG", icon: "🛰️",
    related: ["adr_methods_real", "conjunction_assessment", "debris_classification"],
    i18n: {
      title: "Envisat — The 8-Tonne Derelict",
      shortText: "Europe's largest Earth-observation satellite went silent in 2012 and never came down. Eight tonnes, tumbling, in one of the busiest lanes in orbit.",
      fullText: "Envisat was ESA's flagship Earth-observation satellite — at ~8,200 kg and the size of a bus, one of the largest objects ever placed in low orbit. It abruptly stopped responding in April 2012 and now drifts, uncontrolled, near 770 km, slap in the middle of a heavily-used sun-synchronous corridor. It can't deorbit naturally for ~150 years, and a single collision could shower the region with thousands of fragments — which is exactly why it tops nearly every active-debris-removal target list. It is the marquee 'big, dead, and dangerous' object: the kind of capture that actually moves the needle.",
      realWorld: "ESA, launched 2002; contact lost 2012; perennial top-priority ADR target",
      unlockHint: "Clear enough debris to be briefed on the priority targets.",
    },
  },
  // ---- WORLD_INDUSTRY card (no trl) ----
  {
    id: "world_adr_mandate", category: "WORLD_INDUSTRY", icon: "📜",
    related: ["adr_methods_real", "kessler_syndrome", "ssa_network"],
    i18n: {
      title: "Cleanup Is Now Mandatory",
      shortText: "For decades, deorbiting your dead satellite was polite. Now it's the law — and a real industry is racing to do it.",
      fullText: "The rules of orbit are tightening fast. The US FCC now requires LEO satellites to deorbit within 5 years of end-of-life (down from 25). ESA's Zero Debris Charter targets no new debris by 2030; the EU Space Act and ISRO's Debris-Free-2030 pledge push the same way. That regulatory shift created a market: companies like Astroscale and ClearSpace are flying the first commercial removal missions, while trackers such as LeoLabs and Slingshot map the junk to clean. The role you're playing — a debris-removal operator for hire — is no longer science fiction; it's an emerging industry with contracts, regulators, and deadlines.",
      realWorld: "FCC 5-year rule (2022) · ESA Zero Debris · EU Space Act · ISRO Debris-Free-2030 · Astroscale, ClearSpace, LeoLabs",
      unlockHint: "Start clearing debris — learn why the work exists.",
    },
  },
];
for (const ne of NEW_ENTRIES) {
  const i = codex.entries.findIndex((e) => e.id === ne.id);
  if (i >= 0) codex.entries[i] = ne;
  else codex.entries.push(ne);
}

writeFileSync(path, JSON.stringify(codex, null, 2) + '\n', 'utf8');
console.log('[phase2] entries now', codex.entries.length);
