#!/usr/bin/env node
// Phase 6e — Tracks expansion (1 → 7). Adds six curated "learning path" track
// definitions to codex.json.tracks and assigns `track`/`trackOrder` to their
// member entries. The existing `propellant_story` track (owned by phase6c) is
// left untouched; this script never reassigns its members.
// (see .kilo/plans/1782994412021-tech-library-deep-dive-overhaul.md §3, Slice 6.)
//
// Structural only — no prose is authored here. Each track is an ordered,
// cross-category narrative of 6–12 entries; the viewer already renders tracks
// (sidebar "🧭 LEARNING PATHS", sorted by meta.order; list preserves trackOrder).
//
// Constraints enforced below: every member id exists; the six new tracks are
// disjoint from each other AND from propellant_story (an entry carries at most
// one track); trackOrder is contiguous 0..n-1; each track holds 6–12 entries.
//
// Idempotent: definitions are merged and memberships are set in place, so
// re-running produces identical output.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = resolve(root, 'data/codex.json');
const codex = JSON.parse(readFileSync(path, 'utf8'));

// Okabe-Ito colourblind-safe palette; propellant_story keeps its orange (order 0).
const TRACK_DEFS = {
  cowboy_basics:          { label: 'Cowboy Basics',           color: '#56b4e9', order: 1 },
  how_we_catch:           { label: 'How We Catch',            color: '#009e73', order: 2 },
  why_orbits_are_weird:   { label: 'Why Orbits Are Weird',    color: '#0072b2', order: 3 },
  power_through_the_dark: { label: 'Power Through the Dark',  color: '#f0e442', order: 4 },
  the_debris_crisis:      { label: 'The Debris Crisis',       color: '#d55e00', order: 5 },
  world_stage:            { label: 'The World Stage',         color: '#cc79a7', order: 6 },
};

// Ordered membership. Cross-category is intentional; sets are disjoint.
const TRACK_MEMBERS = {
  // The onboarding path, in PLAYBOOK reading order.
  cowboy_basics: [
    'welcome_cowboy', 'core_loop', 'reading_the_hud', 'autopilot_first', 'tool_choice',
    'delta_v_doctrine', 'salvage_economy', 'capture_quality', 'arm_sacrifice', 'power_triage',
  ],
  // Sense → approach → de-spin → net → tether → reel → secure.
  how_we_catch: [
    'pose_estimation', 'docking_precision', 'detumble', 'net_yo_yo_despin', 'miura_ori_net',
    'bolas_weapon', 'space_tether', 'reel_mechanics', 'tether_reel_in', 'docking_berthing',
  ],
  // The counter-intuitive orbital mechanics, foundational → applied.
  why_orbits_are_weird: [
    'keplerian_orbit', 'orbital_period_altitude', 'orbital_inclination', 'j2_perturbation',
    'raan_precession', 'relative_velocity', 'prograde_paradox', 'rendezvous', 'hohmann_transfer',
    'delta_v', 'atmospheric_drag',
  ],
  // Surviving the dark half of every orbit: generation → storage → distribution.
  power_through_the_dark: [
    'solar_power', 'multijunction_pv', 'solar_cell_degradation', 'eclipse_cycle',
    'battery_chemistry', 'battery_cycles', 'supercapacitors', 'power_bus_management',
    'thermal_management', 'rtg_power',
  ],
  // The problem you exist to solve: cascade → hazard → tracking → the marquee junk.
  the_debris_crisis: [
    'kessler_syndrome', 'breakup_events', 'hypervelocity', 'debris_classification',
    'trackable_vs_dark', 'debris_tracking', 'ssa_network', 'conjunction_assessment',
    'iridium_cosmos', 'fengyun_test', 'catalog_envisat', 'adr_methods_real',
  ],
  // The real-world context: the rules, the industry, the headlines.
  world_stage: [
    'world_why_now', 'world_adr_mandate', 'world_five_year_rule', 'world_the_rules',
    'world_liability', 'world_who_removes', 'world_who_tracks', 'world_servicing',
    'world_sustainability_rating', 'news_mev1_servicing', 'news_aeolus_reentry',
  ],
};

const byId = new Map(codex.entries.map((e) => [e.id, e]));

// --- validate before mutating ---
const errors = [];
const seen = new Map(); // id -> track (detect cross-track collisions)
for (const e of codex.entries) {
  if (e.track && e.track !== 'propellant_story') {
    // any pre-existing non-propellant track assignment is re-derived below;
    // record propellant_story members so the new sets can't collide with them.
  }
  if (e.track === 'propellant_story') seen.set(e.id, 'propellant_story');
}
for (const [tid, ids] of Object.entries(TRACK_MEMBERS)) {
  if (ids.length < 6 || ids.length > 12) errors.push(`${tid}: ${ids.length} entries (want 6–12)`);
  for (const id of ids) {
    if (!byId.has(id)) errors.push(`${tid}: missing entry '${id}'`);
    if (seen.has(id)) errors.push(`${id}: already in track '${seen.get(id)}' (would collide with '${tid}')`);
    seen.set(id, tid);
  }
}
if (errors.length) {
  console.error('[phase6e] ABORT — track validation failed:\n  ' + errors.join('\n  '));
  process.exit(1);
}

// --- merge track definitions (propellant_story def preserved) ---
codex.tracks = { ...codex.tracks, ...TRACK_DEFS };

// --- assign track / trackOrder in place ---
for (const [tid, ids] of Object.entries(TRACK_MEMBERS)) {
  ids.forEach((id, i) => {
    const e = byId.get(id);
    e.track = tid;
    e.trackOrder = i;
  });
}

writeFileSync(path, JSON.stringify(codex, null, 2) + '\n', 'utf8');

const summary = Object.keys(codex.tracks)
  .sort((a, b) => codex.tracks[a].order - codex.tracks[b].order)
  .map((tid) => `${tid}(${codex.entries.filter((e) => e.track === tid).length})`)
  .join(' · ');
console.log('[phase6e] tracks now', Object.keys(codex.tracks).length, '|', summary);
