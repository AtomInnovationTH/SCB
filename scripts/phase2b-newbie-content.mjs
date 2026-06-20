#!/usr/bin/env node
// Phase 2b — fix the new-player first impression. Idempotent (re-runnable).
//   - Reorder categories: orientation first (Playbook, World & Industry), then
//     core gameplay, with Catalog (a discovery collection) moved below them.
//   - Mark PLAYBOOK + WORLD_INDUSTRY entries `startUnlocked` (reference/onboarding
//     material is readable immediately — not gated behind gameplay triggers).
//   - Author the full PLAYBOOK quick-start (§3.7) and expand WORLD_INDUSTRY (§3.9)
//     and CATALOG (§3.8) so none of the lead categories is a single card.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'data/codex.json');
const codex = JSON.parse(readFileSync(path, 'utf8'));
const byId = new Map(codex.entries.map((e) => [e.id, e]));

// (A) Category order — orientation first; Catalog is a discovery set, sits lower.
const ORDER = [
  'PLAYBOOK', 'WORLD_INDUSTRY', 'DEBRIS', 'CATALOG', 'ORBITAL_MECHANICS',
  'TETHERS', 'PROPULSION', 'SENSORS', 'POWER', 'ATTITUDE', 'AVIONICS',
  'COMMS', 'SPACE_ENVIRONMENT', 'MATERIALS', 'HERITAGE', 'NEWS',
];
const catKeys = Object.keys(codex.categories);
const miss = catKeys.filter((k) => !ORDER.includes(k));
const extra = ORDER.filter((k) => !catKeys.includes(k));
if (miss.length || extra.length) throw new Error('category order mismatch: ' + JSON.stringify({ miss, extra }));
ORDER.forEach((k, i) => { codex.categories[k].order = i; });

// (B) Mark existing lead entries start-unlocked (readable from the first open).
for (const id of ['welcome_cowboy', 'world_adr_mandate']) {
  const e = byId.get(id);
  if (e) e.startUnlocked = true;
}

// (C) New entries — UPSERT by id (idempotent). PLAYBOOK + WORLD are startUnlocked
// (no trl, no trigger). CATALOG entries are discovery cards (trigger added by hand
// in codexTriggers.js). Facts verified against the live game + public record.
const NEW_ENTRIES = [
  // ================= PLAYBOOK — the quick-start (§3.7), all start-unlocked =====
  {
    id: 'core_loop', category: 'PLAYBOOK', icon: '🔁', startUnlocked: true,
    related: ['rendezvous', 'tool_choice', 'salvage_economy'],
    i18n: {
      title: 'The Core Loop',
      shortText: "Scan, pick a target, let autopilot fly you there, capture, cash in. Repeat. That's the whole job.",
      fullText: "Five steps, over and over:\n1. Scan (S) to find debris.\n2. Target (T) to pick one.\n3. Autopilot (A) flies you alongside — you don't hand-fly there.\n4. Capture it with a daughter's net.\n5. Bank the haul — drag it down to burn up, or salvage it for parts.\nClear 50 pieces and the shift is won. Everything else in this library just explains a step in more depth.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'reading_the_hud', category: 'PLAYBOOK', icon: '🖥️', startUnlocked: true,
    related: ['core_loop'],
    i18n: {
      title: 'Reading the Screen',
      shortText: 'A nav-ball, a few status panels, and a colour code that runs green to red. Glance for red; read the rest when curious.',
      fullText: "Don't try to absorb every readout at once. The essentials: the NavSphere (nav-ball) shows where you're pointed and where your target sits; the side panels track ship health, power, and resources; status colours run from green (fine) toward red (act now). You can play the whole loop watching for red and trusting autopilot for the rest — the detail is here when you want it.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'delta_v_doctrine', category: 'PLAYBOOK', icon: '⛽', startUnlocked: true,
    related: ['delta_v', 'specific_impulse', 'salvage_economy'],
    i18n: {
      title: 'ΔV Is Everything',
      shortText: "Fuel doesn't refill on its own. Every burn spends a budget you can't get back for free.",
      fullText: "ΔV — your ability to change orbit — is the master resource. Your xenon and cold-gas tanks do not magically refill: the only way to top up is to salvage metal and run it through the Forge into propellant. So fly cheap. Let autopilot pick efficient routes, and don't chase a target across the sky when a closer one will do. Run every tank dry and the mission ends.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'autopilot_first', category: 'PLAYBOOK', icon: '🛰️', startUnlocked: true,
    related: ['prograde_paradox', 'rendezvous', 'core_loop'],
    i18n: {
      title: 'Let the Autopilot Fly',
      shortText: "Hand-flying in orbit is a black-belt skill. For almost everything, press A and let the computer do it.",
      fullText: "Orbital motion is counter-intuitive — thrust straight at a target and you'll usually miss it (see the 'prograde paradox'). That's why autopilot (A) is the default: it solves the approach for you and burns less fuel doing it. Manual piloting exists for fine moments and bragging rights, but you can win the entire game leaning on autopilot. Automating isn't cheating — the pros do it.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'tool_choice', category: 'PLAYBOOK', icon: '🧰', startUnlocked: true,
    related: ['miura_ori_net', 'detumble', 'recoil_cancellation'],
    i18n: {
      title: 'Net, Gripper, or Magnet?',
      shortText: 'Different junk wants different tools. The game suggests one — and you can cycle the rest.',
      fullText: "Your daughters carry several capture tools: a net is the workhorse, backed by grippers, magnets, and pads. The game reads each target and marks a recommended tool with a ▶. While piloting a daughter, tap the backtick key ( ` ) to cycle through them. Big tumbling slab? Net. Small iron fragment? Magnet. When in doubt, take the suggestion.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'arm_sacrifice', category: 'PLAYBOOK', icon: '🤲', startUnlocked: true,
    related: ['docking_berthing', 'detumble'],
    i18n: {
      title: 'When to Sacrifice an Arm',
      shortText: 'Bring a daughter home to reuse it — or ride it down with the junk for a bigger payout.',
      fullText: "Most captures mean tethering the target and reeling it in. But for stubborn or massive debris you can send a daughter down with it on a deorbit burn, sacrificing the arm for a bonus worth up to ×2.5 the score. It's a genuine trade: lose hardware now for a bigger clear, or keep your fleet and play the long game. Early on, keep your arms. Once you can spare one, the deorbit bonus adds up.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'salvage_economy', category: 'PLAYBOOK', icon: '♻️', startUnlocked: true,
    related: ['delta_v_doctrine', 'what_10000kg_buys'],
    i18n: {
      title: 'The Salvage Economy',
      shortText: 'Dead satellites are a gas station. Grab the metal, run the Forge, refuel — your only way to top up.',
      fullText: "A captured object isn't just a tick on the counter — it's raw material. Salvage yields metal, and sometimes a splash of propellant or a panel repair on the spot. Feed salvaged metal into the Forge in propellant mode and it becomes fuel you can burn. Because tanks never refill for free, the salvage → Forge → propellant loop is the heartbeat that keeps you flying. You clean up and gas up in the same move.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'power_triage', category: 'PLAYBOOK', icon: '⚡', startUnlocked: true,
    related: ['eclipse_cycle', 'battery_chemistry'],
    i18n: {
      title: 'Power Under Eclipse',
      shortText: 'Half of every orbit is night. With no sun, you ration power across three buses — thrust, sensors, arms.',
      fullText: "Your solar panels stop producing the instant you cross into Earth's shadow, and you run on battery. Power flows through three buses — Thrust, Sensors, and Arms — and you can shift the balance (Shift+1/2/3 to select a bus, then [ and ] to trim it). Going into eclipse with a capture to finish? Lean power toward Arms. Long coast ahead? Favour Thrust. Manage the dark half of the orbit and the bright half takes care of itself.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'capture_quality', category: 'PLAYBOOK', icon: '⭐', startUnlocked: true,
    related: ['tool_choice', 'core_loop'],
    i18n: {
      title: 'Capture Quality Pays',
      shortText: 'A clean, scanned, fuel-smart capture can score nearly four times a sloppy one. Style matters.',
      fullText: "Not all captures are equal. Scan a target's structure before you grab it, pilot the daughter in by hand, approach without burning much fuel, and recover its salvage — each adds a multiplier, stacking to almost ×3.7 over a bare auto-grab. You never have to chase the perfect capture, but when you want a high score (or a faster 50), quality beats quantity.",
      unlockHint: 'Reach orbit.',
    },
  },
  // ================= WORLD & INDUSTRY — the "why" (§3.9), start-unlocked =======
  {
    id: 'world_who_removes', category: 'WORLD_INDUSTRY', icon: '🛰️', startUnlocked: true,
    related: ['adr_methods_real', 'world_adr_mandate'],
    i18n: {
      title: 'Who Actually Cleans Orbit',
      shortText: "Debris removal isn't science fiction — real companies are flying the first missions now.",
      fullText: "A handful of companies are turning orbital cleanup into a business. Astroscale (Japan) flew ELSA-d in 2021 to test magnetic capture and has since inspected real derelicts up close; ClearSpace (Europe) is building a mission to grab a leftover rocket adapter; firms like Starfish Space and D-Orbit are developing tugs and de-orbit services. The role you play — a removal operator for hire — is exactly the job these teams are inventing.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'world_who_tracks', category: 'WORLD_INDUSTRY', icon: '📡', startUnlocked: true,
    related: ['ssa_network', 'conjunction_assessment', 'debris_tracking'],
    i18n: {
      title: 'Who Tracks the Junk',
      shortText: "You can't dodge what you can't see. A growing web of radars and telescopes maps orbit around the clock.",
      fullText: "Knowing where tens of thousands of tracked objects are is its own industry. The US Space Surveillance Network has catalogued debris since the 1960s; commercial trackers like LeoLabs (phased-array radars) and Slingshot Aerospace now map low orbit continuously and issue collision warnings. Every target you scan and every conjunction alert you receive is a nod to this real tracking backbone.",
      unlockHint: 'Reach orbit.',
    },
  },
  {
    id: 'world_why_now', category: 'WORLD_INDUSTRY', icon: '⏳', startUnlocked: true,
    related: ['kessler_syndrome', 'world_adr_mandate'],
    i18n: {
      title: 'Why Now?',
      shortText: "Orbit got crowded fast. Decades of leftovers plus mega-constellations turned 'someday' into 'this decade.'",
      fullText: "Two things made cleanup urgent. First, the leftovers: sixty-odd years of launches left thousands of dead satellites and spent stages that won't come down for decades. Second, the boom: mega-constellations are adding thousands of new satellites, so the odds of a collision — and a runaway Kessler cascade — climb every year. Regulators answered with hard deadlines, and that's the wave you're riding.",
      unlockHint: 'Reach orbit.',
    },
  },
  // ================= CATALOG — marquee objects (§3.8), discovery cards =========
  {
    id: 'catalog_vanguard1', category: 'CATALOG', icon: '🛰️',
    related: ['atmospheric_drag', 'orbital_period_altitude'],
    i18n: {
      title: 'Vanguard 1 — The Elder',
      shortText: 'Launched in 1958, this grapefruit-sized satellite is the oldest human object still in orbit.',
      fullText: "Vanguard 1 went up in March 1958 — the fourth satellite ever launched — and although it fell silent in 1964, it is still up there, making it the oldest human-made object in orbit. Its high orbit sees so little atmospheric drag that it will keep circling for centuries. A museum piece you can't visit, and a quiet reminder that what we put up tends to stay up.",
      unlockHint: 'Clear debris to be briefed on notable objects.',
    },
  },
  {
    id: 'catalog_les1', category: 'CATALOG', icon: '📡',
    related: ['battery_chemistry', 'comms_blackout'],
    i18n: {
      title: 'LES-1 — The Zombie Sat',
      shortText: 'Dead since 1967, it started transmitting again in 2013. Nobody told it to.',
      fullText: "LES-1, a small US military comms satellite, was stranded in the wrong orbit in 1965 and went dark in 1967. Then in 2013 an amateur astronomer picked up its signal again — it had 'woken up,' most likely as failed batteries let sunlight power it directly while it tumbled. A derelict that talks: proof that 'dead' hardware can still surprise you.",
      unlockHint: 'Clear debris to be briefed on notable objects.',
    },
  },
  {
    id: 'catalog_cosmos_iridium', category: 'CATALOG', icon: '💥',
    related: ['kessler_syndrome', 'iridium_cosmos', 'conjunction_assessment'],
    i18n: {
      title: 'Iridium 33 × Cosmos 2251',
      shortText: 'In 2009 a working satellite and a dead one slammed together at ~11.7 km/s — the first big accidental collision.',
      fullText: "On 10 February 2009 the active Iridium 33 communications satellite and the defunct Russian Cosmos 2251 collided over Siberia at roughly 11.7 km/s, destroying both and scattering thousands of trackable fragments that still circle today. It was the first major accidental satellite collision — the event that turned Kessler syndrome from a theory into headlines.",
      unlockHint: 'Clear debris to be briefed on notable objects.',
    },
  },
  {
    id: 'catalog_fengyun1c', category: 'CATALOG', icon: '☄️',
    related: ['kessler_syndrome', 'fengyun_test', 'hypervelocity'],
    i18n: {
      title: 'Fengyun-1C — The Worst Cloud',
      shortText: 'A 2007 anti-satellite test shattered one weather satellite into 3,000+ trackable pieces — the largest debris cloud ever made.',
      fullText: "In January 2007 China destroyed its own defunct Fengyun-1C weather satellite in an anti-satellite missile test. The impact created more than 3,000 trackable fragments — the single largest debris-generating event on record — much of it in a long-lived orbit near 865 km. Years later its shrapnel still forces collision-avoidance manoeuvres. One test, a generation of hazard.",
      unlockHint: 'Clear debris to be briefed on notable objects.',
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
console.log('[phase2b] entries now', codex.entries.length,
  '| PLAYBOOK', counts.PLAYBOOK, 'WORLD_INDUSTRY', counts.WORLD_INDUSTRY, 'CATALOG', counts.CATALOG);
