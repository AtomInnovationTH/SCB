# Final Analysis — Documentation State, Consolidation Plan, and Next-Shift Brief

> ## 🟡 Partial Heritage — Read This Banner First (Updated 2026-05-16)
>
> This doc dates from 2026-04-25. Most of it has been **superseded** by later work, but **two sections remain canonical** and are linked from elsewhere as authoritative:
>
> | Section | Status | Why kept |
> |---------|--------|---------|
> | §1 Documentation Inventory | 🟠 **Stale** — see [`HANDOFF.md §7 Active Docs Index`](HANDOFF.md) for the current map | — |
> | §2 Reading List | 🟠 **Stale** — see [`HANDOFF.md "New Developer? Full Orientation Reading Order"`](HANDOFF.md) | — |
> | §3 Doc Consolidation Plan | 🟠 **Executed** — see [`HANDOFF.md §7`](HANDOFF.md) and [`HANDOFF.md §9.1 Doc Cleanup`](HANDOFF.md) | — |
> | §4 FEEP-Metals Reward Loop | 🟠 **Implemented in Epic 8** — see [`Constants.ION_THRUSTER_METALS`](js/core/Constants.js), [`ForgeSystem.js`](js/systems/ForgeSystem.js) | — |
> | §5 Real-News Roadmap §5.1–§5.3 | 🟠 **Implemented in Epic 6/8** — see [`data/news-events.json`](data/news-events.json), [`MissionEventSystem.js`](js/systems/MissionEventSystem.js) | — |
> | **§5.4 Offline-First Manifesto** | 🟢 **CANONICAL** — locked product principle | Linked from [`HANDOFF.md Locked Product Principles`](HANDOFF.md) |
> | **§5A Indian Heritage** | 🟢 **CANONICAL** — locked product principle (BANGALORE/HASSAN comms, Sriharikota launch) | Linked from [`HANDOFF.md Locked Product Principles`](HANDOFF.md) |
> | §6 Next-Shift Brief (Epic 8) | 🟠 **Complete** — see [`HANDOFF.md "Epic 8 — Daughter-Arm Redesign"`](HANDOFF.md) | — |
> | §7–§9 Risk / Checklist / Summary | 🟠 **Stale** | — |
>
> **In short:** Skip to §5.4 or §5A if you came here from a locked-principles link. Everything else is heritage; rely on HANDOFF.md for current state.

---

> **Purpose (historical):** Single hand-off document for the next implementation shift. Inventories the current documentation corpus, recommends consolidation/archival actions, integrates the **FEEP-metals + orbital-ladder progression**, adds the **2026 real-news debris roadmap**, and provides a step-by-step starter plan.
>
> **Date:** 2026-04-25
> **Author:** Architect mode synthesis
> **Test baseline:** 238 suites / 1,160 tests / 0 failures
> **Created in this session:** [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md), [`GAME_FLOW_BRAINSTORM.md`](GAME_FLOW_BRAINSTORM.md), this file

---

## Table of Contents

1. [Documentation Inventory & Health](#1-documentation-inventory--health)
2. [What I Still Don't Know — Reading List for Next Shift](#2-what-i-still-dont-know--reading-list-for-next-shift)
3. [Doc Consolidation & Archival Plan](#3-doc-consolidation--archival-plan)
4. [The Orbital Ladder ↔ FEEP-Metals Reward Loop](#4-the-orbital-ladder--feep-metals-reward-loop)
5. [Real News → Live Debris Roadmap (2026)](#5-real-news--live-debris-roadmap-2026)
6. [Next-Shift Implementation Brief](#6-next-shift-implementation-brief)
7. [Risk Register](#7-risk-register)

---

## 1. Documentation Inventory & Health

### 1.1 Active Root-Level Documents

| # | Document | Size | Status | What it owns | Last touched |
|---|---|---|---|---|---|
| 1 | [`README.md`](README.md) | 219 LOC | ✅ Current | Quick start, controls, project map | 2026-04-22 |
| 2 | [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) | 452 LOC | ✅ Current | Sprint tracker, completion log, Epic 7 next | 2026-04-22 |
| 3 | [`ARCHITECTURE.md`](ARCHITECTURE.md) | ~1,500 LOC | ✅ Current | As-built technical reference | 2026-04-20 |
| 4 | [`BIG_PICTURE.md`](BIG_PICTURE.md) | **1,854 LOC** | ⚠️ Bloated | 12-month strategic roadmap, V5 trade study, education suite | 2026-04-15 |
| 5 | [`GAME_DESIGN.md`](GAME_DESIGN.md) | 287 LOC | ✅ Current | Core loop, jellyfish identity, four-game heritage | 2026-04-14 |
| 6 | [`HANDOFF.md`](HANDOFF.md) | 1,006 LOC | ⚠️ Bloated | Architectural gotchas, 9-item improvement backlog | 2026-04-20 |
| 7 | [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md) | **3,580 LOC** | ✅ Reference | V5 arm system physics bible | 2026-03-XX |
| 8 | [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md) | ~1,200 LOC | ✅ Reference | Educational concept mapping | 2026-03-XX |
| 9 | [`SKILLS_ARCHITECTURE.md`](SKILLS_ARCHITECTURE.md) | ~1,800 LOC | ✅ Reference | Skills Discovery system internals | 2026-04-XX |
| 10 | [`FIRST_EXPERIENCE.md`](FIRST_EXPERIENCE.md) | 1,079 LOC | ✅ Current | First 90-second onboarding spec | 2026-04-XX |
| 11 | [`UX_FIXES_ROADMAP.md`](UX_FIXES_ROADMAP.md) | 689 LOC | 🟡 Done | Completed UX-1 to UX-4 sprint (16 issues) | 2026-04-24 |
| 12 | [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md) | 524 LOC | ✅ NEW | Orbital-crane control redesign + FEEP roles | 2026-04-25 |
| 13 | [`GAME_FLOW_BRAINSTORM.md`](GAME_FLOW_BRAINSTORM.md) | ~600 LOC | ✅ NEW | Tool failure modes, delight catalog, FEEP metals | 2026-04-25 |
| 14 | This file | — | ✅ NEW | Final analysis + next-shift brief | 2026-04-25 |

**Total active docs: 14 files, ~13,800 lines of design content.**

### 1.2 Archived (already in `archive/` — 18 files)

These were correctly archived per [`README.md:49`](README.md:49). No action needed except acknowledging their existence:

```
archive/V3 Octopus.md, V4 Opussy.md          ← V3/V4 design history (precursors to V5)
archive/RESEARCH_ARCHIVE.md                   ← Reference: real ADR research
archive/AUTOPILOT_ANALYSIS.md                 ← Pre-rewrite analysis (Sprints 28-30)
archive/COLLISION_AVOIDANCE_DESIGN.md         ← Implemented
archive/REFS_DECOUPLING_PLAN.md               ← Implemented
archive/ARCHITECTURE_ANALYSIS_V6.md           ← Pre-V5 analysis
archive/IMPLEMENTATION_PLAN_V6.md             ← Older plan
archive/IMPLEMENTATION_PLAN.md                ← Older plan
archive/FULL_HUD_STRATEGY.md                  ← Implemented (HUD redesign)
archive/NAVSPHERE_REDESIGN.md                 ← Implemented (Epic 5)
archive/TARGET_PANEL_REDESIGN.md              ← Implemented
archive/ORCHESTRATOR_BRIEF.md                 ← Replaced by IMPLEMENTATION_PLAN
archive/TUTORIAL_REDESIGN.md                  ← Tutorial system DELETED in Sprint 3
archive/CONTROL_REDESIGN.md                   ← Implemented (V7 autopilot-first)
archive/TUTORIAL_ANALYSIS.md                  ← Pre-deletion analysis
archive/SKILLS_SYSTEM_DESIGN.md               ← Implemented (SKILLS_ARCHITECTURE replaces)
archive/UX_OVERHAUL_PLAN.md                   ← Implemented (UX-1..4)
```

### 1.3 Health Summary

- ✅ **10/14 docs are healthy** and serve clear purposes
- ⚠️ **2 docs are bloated**: BIG_PICTURE.md (1854 LOC, ~50% completed work), HANDOFF.md (1006 LOC, autopilot-rewrite history)
- 🟡 **1 doc is "completed sprint" status**: UX_FIXES_ROADMAP.md (all 16 issues done — should archive after referencing key decisions)
- ✅ **No truly stale active docs** — system is well-maintained

---

## 2. What I Still Don't Know — Reading List for Next Shift

I read significant portions of all root docs. Before implementation begins, the next shift should fill these specific gaps:

### 2.1 Code-level reads (mandatory before touching ArmUnit.js)

| File | Why | Time |
|---|---|---|
| [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js) — full file | 2,365 LOC. Need to understand state machine + all FSM transitions | 30 min |
| [`js/entities/ArmManager.js`](js/entities/ArmManager.js) — full file | 1,168 LOC. Manager FSM coordination | 20 min |
| [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js) — full file | 4-phase state machine (recently rewritten) | 20 min |
| [`js/systems/CameraSystem.js`](js/systems/CameraSystem.js) — full file | 951 LOC. ARM_PILOT camera + my new look-blend code | 20 min |
| [`js/systems/InputManager.js`](js/systems/InputManager.js) — full file | 1,133 LOC. Input routing for new orbital controls | 20 min |
| [`js/core/Constants.js`](js/core/Constants.js) — full file | 1,605 LOC. **All tuning knobs.** Where new ION_THRUSTER + STATION_KEEP blocks go | 30 min |

### 2.2 Doc deep-dives (skim before scope decisions)

| Doc | Why | Sections to read |
|---|---|---|
| [`BIG_PICTURE.md`](BIG_PICTURE.md) | The strategic master plan | §3 Rendezvous Ladder, §7 Altitude bands, §29 Capture mechanisms, §36 Tech ladder |
| [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md) | V5 design bible | §15 Y-Harness, §22 V3→V5 migration, §24 Senior review |
| [`HANDOFF.md`](HANDOFF.md) | Tech-debt and gotchas | §3 Architectural gotchas, §8 Known issues |
| [`SKILLS_ARCHITECTURE.md`](SKILLS_ARCHITECTURE.md) | Skills Discovery internals | Whole file before adding new skills |
| [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md) | Educational metaphors | §3.4 EDT, §4 Forge process, §13 Magnetorquers |

### 2.3 Data files (skim — they're the source of truth for missions)

| File | Lines | What's there |
|---|---|---|
| [`data/META.json`](data/META.json) | 23 | Catalogue version, file list, counts (107 debris, 51 active sats, 30 launches, 18 weather, 20 ground stations, 10 constellations) |
| [`data/active-sats.json`](data/active-sats.json) | 54 entries | Real NORAD IDs, includes ISS, Hubble, Starlink, GPS, Sentinel, Landsat, Galileo, BeiDou |
| [`data/debris-catalog.json`](data/debris-catalog.json) | 110 entries | Vanguard 1, Envisat, Cosmos 1408, Iridium 33, Fengyun-1C fragments, rocket bodies |
| [`data/launches.json`](data/launches.json) | 30 entries | Upcoming launch events |
| [`data/space-weather.json`](data/space-weather.json) | 18 entries | Geomagnetic storms, X-flares, CMEs |
| [`data/ground-stations.json`](data/ground-stations.json) | 20 entries | DSN sites, real geocoordinates |
| [`data/constellations.json`](data/constellations.json) | 10 entries | Starlink, OneWeb, Iridium, Galileo metadata |

**Insight:** This catalogue scaffolding is **already wired** for adding 2026 news events. New debris just needs a JSON entry with NORAD ID, mass, orbit elements, and a `notable` field.

---

## 3. Doc Consolidation & Archival Plan

### 3.1 Recommended Actions for Next Shift

| Action | File | Reason | Priority |
|---|---|---|---|
| **Archive** | [`UX_FIXES_ROADMAP.md`](UX_FIXES_ROADMAP.md) → `archive/` | All 16 sprints complete; lessons captured in code | High |
| **Trim** | [`BIG_PICTURE.md`](BIG_PICTURE.md) | 1854 LOC → target 1000 LOC. Move completed §1-§9 to a new `archive/EPIC_5_6_HISTORY.md` | Medium |
| **Trim** | [`HANDOFF.md`](HANDOFF.md) | 1006 LOC → target 500 LOC. Archive §2 autopilot-rewrite retrospective to `archive/AUTOPILOT_RETRO.md` | Medium |
| **Merge** | [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md) + [`GAME_FLOW_BRAINSTORM.md`](GAME_FLOW_BRAINSTORM.md) | Both this-session docs are complementary; could merge into single `EPIC_8_DESIGN.md` once Epic 7 is closed | Low |
| **Update** | [`README.md`](README.md) | Add this file + DAUGHTER_ARM_CONTROLS + GAME_FLOW_BRAINSTORM to doc index | High |
| **Update** | [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) | Add Epic 8 — Daughter Arm Redesign + News-Driven Debris (this brief) | High |

### 3.2 The "Single-Source-of-Truth" Map (Post-Consolidation)

```
ROOT/
├── README.md                  ← Quick start + doc index           [HEALTHY]
├── IMPLEMENTATION_PLAN.md     ← Sprint tracker + Epic 7,8 next    [UPDATE]
├── ARCHITECTURE.md            ← As-built code reference            [HEALTHY]
├── BIG_PICTURE.md             ← Strategic 12-month roadmap         [TRIM]
├── GAME_DESIGN.md             ← Game vision + heritage             [HEALTHY]
├── HANDOFF.md                 ← Tech-debt + gotchas                [TRIM]
├── FINAL_ANALYSIS.md          ← This file (next-shift orchestrator) [NEW]
│
├── DAUGHTER_ARM_CONTROLS.md   ← Orbital-crane controls (Epic 8)    [NEW]
├── GAME_FLOW_BRAINSTORM.md    ← Tool/reward/delight design         [NEW]
│
├── CROSSBOW_ARMS.md           ← V5 arm physics bible (deep ref)    [HEALTHY]
├── LEARNING_THROUGH_PLAY.md   ← Educational concepts               [HEALTHY]
├── SKILLS_ARCHITECTURE.md     ← Skills Discovery internals         [HEALTHY]
├── FIRST_EXPERIENCE.md        ← Onboarding spec                     [HEALTHY]
└── archive/                    ← Historical (20+ files post-archive)
```

---

## 4. The Orbital Ladder ↔ FEEP-Metals Reward Loop

This is **the core progression spine** that ties [`DAUGHTER_ARM_CONTROLS.md §5`](DAUGHTER_ARM_CONTROLS.md), [`GAME_FLOW_BRAINSTORM.md §7.2`](GAME_FLOW_BRAINSTORM.md), and [`BIG_PICTURE.md §3 Rendezvous Ladder`](BIG_PICTURE.md) into one coherent loop.

### 4.1 The Loop

```
┌────────────────────────────────────────────────────────────┐
│  PLAYER STARTS AT VLEO (220 km, indium FEEP, default)        │
│  Scavenges fragments → Forge → Refines basic metals          │
└────────────────────┬───────────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────────┐
│  FORGE YIELDS GALLIUM (from electronics-rich debris)         │
│  → Higher-Isp FEEP option unlocks                            │
│  → Daughter arms maneuver faster on same fuel                │
│  → Player can reach LEO-Mid (550-800 km) richer debris       │
└────────────────────┬───────────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────────┐
│  LEO-Mid yields BISMUTH (heatsinks) + IODINE (medical sat)   │
│  → Higher-thrust FEEP for fast repositioning                 │
│  → Mother ΔV economy improves                                │
│  → Reach ISS region (410 km) — special EVA tools, supply pallets │
└────────────────────┬───────────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────────┐
│  ISS region yields HIGH-VALUE COMPONENTS                     │
│  → Cesium (rare; reactive but Isp 22,000 s)                  │
│  → Mother can transit Van Allen belt (energy budget)          │
│  → Reach MEO (GPS constellation, 19,000-21,000 km)           │
└────────────────────┬───────────────────────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────────────────────┐
│  MEO yields TUNGSTEN (heat shields)                          │
│  → MPD-class thrust unlocks (requires reactor + radiator)    │
│  → GEO transit feasible (1-week burn or Hohmann window)       │
│  → End-game: GEO graveyard cleanup, Thaicom 4 mission        │
└────────────────────────────────────────────────────────────┘
```

### 4.2 Per-Orbit Tier Progression

| Orbit | Altitude | Default FEEP metal | Why | Notable real targets |
|---|---|---|---|---|
| **VLEO** | 200–400 km | Indium | Default; safe storage | Aeolus debris, Tiangong-2 reference |
| **LEO-Low** | 400–550 km | Indium / Gallium | Fast captures | ISS region, Hubble (don't capture!), Starlink V1 |
| **LEO-Mid** | 550–800 km | Gallium / Bismuth | Higher Isp | Sentinel-1, Landsat, Iridium |
| **LEO-High** | 800–1,400 km | Bismuth / Iodine | Higher thrust for cluster ops | Cosmos 1408 fragments, Fengyun-1C debris |
| **MEO Gap** | 1,400–5,000 km | Iodine / Cesium | Long burns, radiation | Mostly empty; transit-only |
| **MEO-GPS** | 19,000–20,500 km | Cesium / Tungsten | Van Allen passage | GPS, GLONASS, Galileo, BeiDou |
| **GEO** | 35,786 km | Tungsten + MPD | Multi-week missions | Thaicom 4, ATS-1, Ariane 5 R/B |

### 4.3 Why This Works (Game-Design Logic)

1. **Each metal unlock = a new orbit becomes reachable.** Direct cause-effect; player feels agency.
2. **Real engineering teaches the pattern.** Higher-orbit missions need higher-Isp engines. This is true for every actual ADR mission profile.
3. **Forge becomes a strategic decision.** Refine Bismuth (high thrust now) or stockpile Cesium (high Isp later)? Each pull from cargo is a choice.
4. **Catalog targets reward exploration.** ATS-1 at GEO is in [`debris-catalog.json:11`](data/debris-catalog.json:11) — already in the data — but you can't reach it until you Forge tungsten.
5. **Reality Mode toggle still works.** Per [`BIG_PICTURE.md §36.4`](BIG_PICTURE.md), Reality Mode locks to indium-only baseline; players who want pure TRL 9 play stay at LEO.

### 4.4 Implementation Sketch

> **TRL correction (per user):** Dual-metal FEEP thrusters are **already TRL 7–8 today** — Enpulsion's IFM Nano series has demonstrated dual-element operation (indium + secondary metals) in flight (multiple CubeSat missions 2024–2025). **Multimetal FEEP is Y0 baseline, not endgame.**

```js
// In Constants.js — extends ION_THRUSTER block:
// Each ArmUnit ships from factory with a dual-metal FEEP (indium + 1 alt metal).
// Player's task is to refine + load alt-metal cartridges from Forge output.
ION_THRUSTER_METALS: {
    // === Y0 BASELINE — DUAL-METAL FEEP (TRL 7-8, flight-demonstrated) ===
    indium:  { ispMin: 4000, ispMax: 19000, thrustPerW: 0.032, mass: 0.15, unlock: 'default',         trl: 9 },
    gallium: { ispMin: 6000, ispMax: 25000, thrustPerW: 0.028, mass: 0.15, unlock: 'forge_gallium',   trl: 7, heater_W: 2 },
    // ↑ Dual-metal indium + gallium is the V5 default (Enpulsion IFM Nano-class)
    
    // === Y1 EXPANSION — additional refinable metals ===
    bismuth: { ispMin: 2500, ispMax: 8000,  thrustPerW: 0.045, mass: 0.18, unlock: 'forge_bismuth',   trl: 6 },
    iodine:  { ispMin: 2000, ispMax: 4500,  thrustPerW: 0.060, mass: 0.10, unlock: 'forge_iodine',    trl: 7 },
    
    // === Y2-Y3 — exotic & specialty metals ===
    mercury: { ispMin: 3000, ispMax: 10000, thrustPerW: 0.040, mass: 0.20, unlock: 'forge_mercury',   trl: 5, codex_warning: 'toxic' },
    cesium:  { ispMin: 8000, ispMax: 22000, thrustPerW: 0.030, mass: 0.13, unlock: 'forge_cesium',    trl: 5, codex_warning: 'reactive' },
    
    // === Y4 ENDGAME ===
    tungsten:{ ispMin: 1500, ispMax: 3500,  thrustPerW: 0.080, mass: 0.30, unlock: 'forge_tungsten',  trl: 4, requires: 'mpd_class_power' },
},

// In ForgeSystem.js — new metal yields per debris type:
FORGE_METAL_YIELDS: {
    'electronics': { gallium: 0.4, indium: 0.3, copper: 0.3 },
    'heatsink':    { bismuth: 0.5, aluminum: 0.5 },
    'medical_sat': { iodine: 0.6, gold: 0.1, aluminum: 0.3 },
    'comms_eqp':   { gallium: 0.3, indium: 0.5, gold: 0.2 },
    'rocket_body': { aluminum: 0.7, titanium: 0.2, steel: 0.1 },
    'heat_shield': { tungsten: 0.6, titanium: 0.4 },
    'old_switchgear': { mercury: 0.4, copper: 0.3, aluminum: 0.3 },
    'rare_sat':    { cesium: 0.2, gallium: 0.4, gold: 0.4 },
}
```

---

## 5. Real News → Live Debris Roadmap (2026)

The three news events you cited are **gold for game realism**. They should become live, dated, named missions.

### 5.1 The Three Real Events

| Event | Source | Date | Object | Game implication |
|---|---|---|---|---|
| **AST SpaceMobile satellite to deorbit** | [Florida Today](https://www.floridatoday.com/story/tech/science/space/2026/04/20/ast-spacemobile-satellite-to-deorbit-after-faulty-blue-origin-rocket-mission/89698328007/) | 2026-04-20 | BlueWalker-class large comms satellite | Massive (~700 kg), failed deploy, faulty Blue Origin upper stage. **Failed satellite + rocket body in same orbit**. |
| **Starlink fragmentation event** | [Ars Technica](https://arstechnica.com/tech-policy/2026/03/starlink-satellite-breaks-apart-into-tens-of-objects-spacex-confirms-anomaly/) | 2026-03-XX | Starlink V2 sat | Broke into "tens of objects" in 53° inclination LEO shell. **Debris cloud spawn event** — affects Starlink-shell altitude band. |
| **Thaicom 4 (IPSTAR-1) deorbit** | [Bangkok Post](https://www.bangkokpost.com/business/general/3242184/thaicom-braces-for-orbital-transition) | Effective 2026-07-31 | Thaicom 4 in GEO | Power-system constraint forces graveyard-orbit transition. **End-game GEO target**. 6,505 kg, launched 2005. |

### 5.2 How They Become Game Content

#### A. **Live News Ticker (HUD bottom edge)**
Comms ambient channel shows real news with date stamp:
```
[2026-04-20 NEWS]  AST SpaceMobile sat tumbling — owner declares
                   total loss. Houston has it on the cleanup list.
                   [Codex: AST SpaceMobile timeline]
```

#### B. **Mission Generator** — extend [`MissionEventSystem.js`](js/systems/MissionEventSystem.js)
Each news event becomes a **named mission** with NORAD ID, real orbit elements, and bonus credits:

```js
// In MissionEventSystem.js — new namespace:
NEWS_DRIVEN_MISSIONS: [
    {
        id: 'ast-spacemobile-2026',
        date: '2026-04-20',
        name: 'AST SpaceMobile Cleanup',
        norad: '60123', // placeholder until real NORAD assigned
        type: 'failed_deploy',
        debris: [
            { name: 'AST SpaceMobile-XX', mass_kg: 700, size_m: 12, alt_km: 350, inc_deg: 51.6, country: 'USA' },
            { name: 'New Glenn US-2', mass_kg: 14000, size_m: 18, alt_km: 350, inc_deg: 51.6, country: 'USA', type: 'rocket_body' },
        ],
        bounty: 25000,
        notable: 'Faulty Blue Origin New Glenn upper stage. Both objects need cleanup.',
        unlock: 'after_5_captures',
    },
    {
        id: 'starlink-breakup-2026',
        date: '2026-03-15',
        name: 'Starlink Fragmentation Sweep',
        type: 'kessler_event',
        debris_count: 35, // procedural fragments in cloud
        cloud_center: { alt_km: 540, inc_deg: 53.0 },
        cloud_radius_km: 25,
        bounty: 50000,
        notable: 'SpaceX confirmed breakup. Tens of pieces — collision risk to neighbouring shells.',
        unlock: 'after_10_captures',
    },
    {
        id: 'thaicom-4-deorbit-2026',
        date: '2026-07-31',
        name: 'Thaicom 4 GEO Graveyard Boost',
        norad: '28786',
        type: 'controlled_deorbit_assist',
        debris: [
            { name: 'THAICOM 4 / IPSTAR-1', mass_kg: 6505, size_m: 8.4, alt_km: 35786, inc_deg: 0.05, country: 'THA', type: 'inactive' },
        ],
        bounty: 100000,
        notable: 'Operator-funded boost-to-graveyard contract. Mission requires GEO transit (Cesium FEEP minimum).',
        unlock: 'after_GEO_unlocked',
    },
],
```

#### C. **Codex Entries** — extend [`CodexSystem.js`](js/systems/CodexSystem.js)
Each event gets a 200-word Codex page with:
- Timeline (real dates)
- What went wrong (technical detail)
- ADR community response
- Educational link (Lorentz force, power degradation, etc.)

#### D. **Reputation Mechanic**
Capturing news-event debris boosts player rep with the originating country/operator:
- AST SpaceMobile → +5 with **AST/Texas**, +3 with **FCC** (creates contract pipeline)
- Starlink → +5 with **SpaceX**, +3 with **NASA SDA**
- Thaicom 4 → +10 with **Thailand**, +5 with **APSCC** (Asia-Pacific Satellite Council)

Reputation unlocks:
- Discounted refuel at partnered ground stations
- Priority mission contracts
- Exclusive cosmetic flags/decals

### 5.3 Update Cadence

Real news happens monthly. The data catalogue should support **easy news injection**:

```bash
# Imagined workflow for adding a news event:
1. Edit data/news-events.json (NEW file) — add JSON entry
2. Update data/META.json counts
3. Run tests — should pass without code changes
4. Comms system auto-pulls latest events for ambient ticker
```

This makes **the game feel alive**. Every month a real news event becomes a mission. Players who play long-term see the actual evolution of the orbital debris problem.

### 5.4 Offline-First Manifesto — No Auto-Fetch (Locked Decision)

> **Design rule:** The game **plays great offline and stays offline**. No background HTTP requests. No live TLE feeds. No telemetry. No phone-home. Period.

[`META.json:4`](data/META.json:4) already says *"Values are realistic and self-consistent but curated for simulation — not a live TLE feed."* This is **not** a future-feature deferral; it is a **product principle**.

**News-driven content** enters the game **only when the user explicitly requests an update**:
- Developer or modding player edits [`data/news-events.json`](data/news-events.json) when a real ADR-relevant event occurs
- A new mission appears next launch
- No telemetry phones home, no API keys, no internet permission required

**Why offline-first matters for Space Cowboy:**
1. **Aerospace classroom use case** — schools and military training contexts demand zero-network operation
2. **Bandwidth-constrained players** — debris-cleanup sims appeal to remote/expedition users
3. **Privacy** — "No, this game is not tracking what NORAD IDs you target"
4. **Longevity** — when a third-party API dies (Celestrak rate-limits, Space-Track changes terms), the game still works
5. **Trust** — players know exactly what's in the game; nothing changes mid-session

**The only network access ever performed by the game** should be:
- Loading textures + JS modules from CDN (one-time, on first launch; can be vendored for full offline)
- Optional one-shot Codex link to NASA/Celestrak for "further reading" (user-clicked, opens in new tab; never automatic)

**News update workflow (manual, user-driven):**

```bash
# When a real ADR-relevant event happens (e.g. AST SpaceMobile, Starlink breakup):
1. Developer (or modding player) adds entry to data/news-events.json
2. Optional: add Codex page in CodexSystem
3. Test: ./test.sh
4. Ship via normal release channel (git pull, file replace)
5. Player sees the new mission next time they launch the game
```

This is the inverse of the live-feed model: **the game pulls reality in deliberately, not reactively**. The pinnacle of the "simulation, not arcade" identity is *making the catalog hand-curated and historically faithful*, not auto-syncing.

**Live TLE feeds, auto-fetch APIs, and online sync features are explicitly OFF the roadmap.**

---

## 5A. Mother Ship's Indian Heritage — Launch, Comms, Identity

> **Locked decision:** The Octopus mothership launches from **India** on a cost-optimised LVM3 / SSLV mission. **Indian Space Research Organisation (ISRO)** ground control is part of the player's comms loop alongside Houston/CAPCOM.

### 5A.1 Why India?

| Reason | Real-world basis |
|---|---|
| **Launch cost** | ISRO's PSLV/LVM3 missions are 30–40% cheaper than Western alternatives. SSLV (Small Satellite Launch Vehicle) targets ~$3M/launch for sub-500 kg payloads. |
| **Equatorial latitude** | [Kulasekarapattinam Spaceport](https://en.wikipedia.org/wiki/Kulasekarapattinam) (Tamil Nadu, ~8.4°N) is closer to the equator than Cape Canaveral (28°N) or Vandenberg (35°N). Lower latitude = ~5% Δv savings to GEO. |
| **Heritage** | India landed Chandrayaan-3 on the Moon (2023), ASAT-tested Mission Shakti (2019), runs Mars Orbiter Mission (since 2014). ISRO is a TRL-9 tier-1 space agency. |
| **Cultural texture** | Adds non-American voice to a genre dominated by US/Soviet imagery. Bangalore Mission Control alongside Houston gives the game international authenticity. |
| **Real ADR commitments** | ISRO published its [Space Sustainability and Sustainability Report 2024](https://www.isro.gov.in/) committing to debris-mitigation infrastructure. |

### 5A.2 Launch Sites (Both Available)

| Site | Code | Latitude | Use case |
|---|---|---|---|
| **Satish Dhawan Space Centre** (SDSC SHAR) | Sriharikota | 13.7°N | Primary spaceport since 1971. PSLV / GSLV / LVM3 launches. Most missions historically. |
| **Kulasekarapattinam Spaceport** | KSCC | 8.4°N | New (announced 2024, operational 2025+). SSLV-only. **Better for GEO**. Commercial focus. |

**Game framing:** The mothership launches from one of these (player choice in mission briefing screen, or auto-determined by mission type). Equatorial Kulasekarapattinam unlocks for GEO-bound missions.

### 5A.3 Indian Ground Control — Comms Persona

The game's comms system already has the [`CommsSystem`](js/systems/CommsSystem.js) with channels and personas. **Add ISRO ground control as a primary channel alongside Houston:**

| Persona | Voice | Triggers | Sample line |
|---|---|---|---|
| **HOUSTON** (existing) | American CAPCOM, Apollo-13 dry humor | Standard mission ops, US-side debris | *"Cowboy, that fragment's heading your way."* |
| **BANGALORE** (NEW) | ISRO Mission Operations Complex (ISTRAC), formal-warm | Mission-critical updates, India-launched assets, Indian Ocean coverage | *"Spacecraft, ISTRAC tracking. Confirm orbital insertion successful."* |
| **HASSAN** (NEW) | ISRO Master Control Facility, GEO ops | GEO missions, Thaicom 4 mission, Thaicom-Asia coverage | *"Spacecraft, Hassan acquired. Standing by for GEO transfer burn."* |

### 5A.4 Indian Ground Stations to Add to [`data/ground-stations.json`](data/ground-stations.json)

```json
[
  {
    "id": "ISTRAC",
    "name": "ISRO Telemetry, Tracking and Command Network — Bangalore",
    "lat": 12.97, "lon": 77.59, "country": "IND",
    "operator": "ISRO",
    "comms_persona": "BANGALORE",
    "frequency_band": ["S", "X"],
    "notable": "Primary mission ops for all Indian launches. Routes Houston-equivalent CAPCOM."
  },
  {
    "id": "MCF_HASSAN",
    "name": "Master Control Facility — Hassan",
    "lat": 12.99, "lon": 76.10, "country": "IND",
    "operator": "ISRO",
    "comms_persona": "HASSAN",
    "frequency_band": ["S", "C", "Ku"],
    "notable": "GEO satellite operations. INSAT/GSAT control."
  },
  {
    "id": "SDSC_SHAR",
    "name": "Satish Dhawan Space Centre — Sriharikota",
    "lat": 13.72, "lon": 80.23, "country": "IND",
    "operator": "ISRO",
    "type": "launch_pad",
    "notable": "Primary Indian spaceport. PSLV, GSLV, LVM3 launches."
  },
  {
    "id": "KSCC",
    "name": "Kulasekarapattinam Spaceport",
    "lat": 8.39, "lon": 78.06, "country": "IND",
    "operator": "ISRO/IN-SPACe",
    "type": "launch_pad",
    "notable": "Equatorial spaceport. Optimised for SSLV + GEO missions."
  }
]
```

### 5A.5 Codex Entries to Add

| Codex page | Content |
|---|---|
| **"Why launch from India?"** | Cost, equatorial advantage, ISRO heritage. Cross-link to [Wikipedia: ISRO](https://en.wikipedia.org/wiki/Indian_Space_Research_Organisation) (one-shot user-clicked link, opens new tab — per offline-first §5.4). |
| **"Kulasekarapattinam — equator advantage"** | Geometry of equatorial launches; Δv savings to GEO; map showing latitude. |
| **"Bangalore Mission Control — ISTRAC"** | Real-world ISRO ops history; Chandrayaan, MOM examples. |
| **"PSLV / LVM3 / SSLV"** | Launch vehicle families; payload mass classes. |

### 5A.6 Comms Flavour Examples

```
[ISTRAC]   Spacecraft, ISTRAC. Acquisition of signal. Power systems nominal.
[ISTRAC]   Spacecraft, ISTRAC. Be advised — Indian Ocean ground track in 4 minutes.
[HOUSTON]  Cowboy, your AOS at Bangalore in 02:14. We'll hand off then.
[BANGALORE] Spacecraft, Bangalore. We have the conn. Welcome, Cowboy.
[HASSAN]   Spacecraft, Hassan. GEO transfer window opens at T-minus 03:30.
[ISTRAC]   Spacecraft, ISTRAC. Loss of signal in 30 seconds. See you next pass.
```

### 5A.7 Implementation Touch Points

| File | Change | Effort |
|---|---|---|
| [`data/ground-stations.json`](data/ground-stations.json) | Add 4 ISRO entries (above) | 5 min |
| [`js/systems/CommsSystem.js`](js/systems/CommsSystem.js) | Add BANGALORE + HASSAN personas; line generation | 1 hour |
| [`js/ui/BriefingScreen.js`](js/ui/BriefingScreen.js) | Optional: launch-site selection in mission briefing | 30 min |
| [`js/systems/CodexSystem.js`](js/systems/CodexSystem.js) + content | 4 new Codex pages | 1 hour |
| [`js/systems/MissionEventSystem.js`](js/systems/MissionEventSystem.js) | Indian missions when applicable (e.g. Chandrayaan-3 lunar reentry debris) | 30 min |

**Total effort: ~3 hours** for full ISRO comms integration.

---

## 6. Next-Shift Implementation Brief

### 6.1 Recommended Sprint Structure

**Epic 8 — Daughter Arm Redesign + News-Driven Debris (4 sprints, ~8-12 days)**

#### Sprint 8.1 — Foundation (1.5 days)
1. Add `STATION_KEEP` state to [`Constants.js ARM_STATES`](js/core/Constants.js:190)
2. Add new constants blocks: `STATION_KEEP`, `ION_THRUSTER`, `ION_THRUSTER_METALS`, `TETHER_TENSION` per [`DAUGHTER_ARM_CONTROLS.md §5.4`](DAUGHTER_ARM_CONTROLS.md)
3. Add events: `ARM_ORBIT_ADJUST`, `STATION_KEEP_ENTERED`, `STATION_KEEP_EXITED`, `FEEP_METAL_CHANGED`
4. Wire `_updateStationKeep()` method in [`ArmUnit.js`](js/entities/ArmUnit.js) per [`DAUGHTER_ARM_CONTROLS.md §4.3`](DAUGHTER_ARM_CONTROLS.md)
5. Add unit tests: state transitions, spherical clamping, tether clearance

#### Sprint 8.2 — Controls (1 day)
6. Modify [`InputManager.processInput()`](js/systems/InputManager.js:1013) — route arrow keys + ±keys to `ARM_ORBIT_ADJUST`
7. Listener in [`ArmUnit`](js/entities/ArmUnit.js) sets orbital rates from event
8. Update HUD ARM_PILOT strip in [`HUD.js:1519`](js/ui/HUD.js:1519) — context-aware text
9. Modify [`_computeArmPilot()`](js/systems/CameraSystem.js:722) — look at debris during STATION_KEEP

#### Sprint 8.3 — FEEP Metal Variants (1.5 days)
10. Implement `ION_THRUSTER_METALS` lookup in [`ArmUnit.applyManualThrust()`](js/entities/ArmUnit.js:765)
11. Add `_currentMetal` field to ArmUnit; default `'indium'`
12. Wire ForgeSystem to surface metal yields per debris type
13. Add Comms menu: "Switch FEEP metal" (keys: F2 cycle metals)
14. Codex entries for each metal (gallium-melts-at-30C, mercury-toxic, etc.)
15. Unit tests for metal-switching, Isp calculation

#### Sprint 8.4 — News-Driven Missions (2 days)
16. Create [`data/news-events.json`](data/news-events.json) — NEW file
17. Add 3 initial events: AST SpaceMobile, Starlink breakup, Thaicom 4
18. Extend [`MissionEventSystem.js`](js/systems/MissionEventSystem.js) — `NEWS_DRIVEN_MISSIONS` block
19. Add `Events.NEWS_EVENT_TRIGGERED` + Comms ambient ticker
20. New Codex pages for each event with timeline + technical detail
21. Add Reputation system (new module: [`ReputationSystem.js`](js/systems/ReputationSystem.js))
22. Wire reputation rewards on news-event captures

#### Sprint 8.5 — Polish & Integration (1 day)
23. DockingReticle shows standoff sphere + angle indicators during STATION_KEEP
24. NavSphere shows other arms' positions when piloting one
25. Test all 1,160 + new tests; verify no regressions
26. Update IMPLEMENTATION_PLAN.md, README.md, HANDOFF.md

### 6.2 Critical Path Dependencies

```
Sprint 8.1 (foundation)
    ├── Sprint 8.2 (controls)        ← needs STATION_KEEP state
    ├── Sprint 8.3 (FEEP metals)      ← independent
    └── Sprint 8.4 (news missions)    ← independent

Sprint 8.5 (polish)                    ← needs ALL above
```

### 6.3 Success Criteria

- [ ] All 238 + new test suites pass (target: 250+ suites)
- [ ] Daughter arm enters STATION_KEEP after APPROACH
- [ ] Arrow keys orbit debris within ±60° lon, ±80° lat
- [ ] +/- adjust standoff (2-15 m clamped)
- [ ] F-key triggers capture from STATION_KEEP
- [ ] FEEP metal switching works for all 7 metals
- [ ] At least 3 news-driven missions playable
- [ ] Reputation system tracks 5 partners (USA/SpaceX/Thailand/ESA/PRC)
- [ ] Codex contains all metal entries + all news events

### 6.4 Test Strategy

Add tests to:
- [`test-Crossbow-ArmUnit.js`](js/test/test-Crossbow-ArmUnit.js) — STATION_KEEP transitions, orbital clamping
- [`test-Constants.js`](js/test/test-Constants.js) — new constant blocks integrity
- New: `test-FEEPMetals.js` — Isp/thrust calculations per metal
- New: `test-NewsEvents.js` — mission spawn, reputation hooks
- New: `test-StationKeep.js` — full state machine integration test

---

## 7. Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| STATION_KEEP feels sluggish (0.32 mm/s² acceleration) | High | Use lerp-based positioning, not raw thrust integration. Tune `STATIONKEEP_LERP_RATE` for snappiness. |
| Arrow key conflicts with mothership rotation | Medium | Already context-switched in [`InputManager.js:186`](js/systems/InputManager.js:186) for arm-pilot. Verify no escape paths. |
| FEEP metal Isp math wrong (variable Isp formula) | Medium | Add test-FEEPMetals.js with known values; cross-check vs Enpulsion datasheets |
| News events feel inserted/disruptive | Low | Gate behind capture-count unlocks; Codex framing makes them feel earned |
| BIG_PICTURE.md trim breaks cross-references | Medium | Search-and-replace for old §-numbers; maintain redirect comments |
| TutorialSystem already deleted, but legacy refs may remain | Low | Run grep for `TutorialSystem` before touching first-run flow |
| Forge metal yields unbalance economy | Medium | Start conservative (yields × 0.5), playtest, tune |

---

## 8. Final Checklist for Next Shift

Before writing any code:

- [ ] Read [`ArmUnit.js`](js/entities/ArmUnit.js) (full 2,365 LOC)
- [ ] Read [`Constants.js`](js/core/Constants.js) (full 1,605 LOC)
- [ ] Read [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md) (full)
- [ ] Read [`GAME_FLOW_BRAINSTORM.md`](GAME_FLOW_BRAINSTORM.md) (full)
- [ ] Read this file (full)
- [ ] Skim [`BIG_PICTURE.md §3, §7, §29, §36`](BIG_PICTURE.md)
- [ ] Skim [`HANDOFF.md §3, §8`](HANDOFF.md)
- [ ] Run baseline tests (`./test.sh`) — verify 238/1160/0fail
- [ ] Update [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) Epic 8 section
- [ ] Pick Sprint 8.1 as the entry point

---

## 9. Summary

**This session created three new docs (1,200+ lines combined) that close the loop on:**
1. Why daughter WASD piloting fails → orbital-crane controls (DAUGHTER_ARM_CONTROLS.md)
2. Why the web/net isn't enough → tool ecosystem with failure modes (GAME_FLOW_BRAINSTORM.md)
3. How to consolidate, what to read next, and a 4-sprint implementation plan (this file)

**Three real-world 2026 news events become game content:**
- AST SpaceMobile (April 2026 — failed deploy, large comms sat + rocket body)
- Starlink breakup (March 2026 — Kessler-event spawn, ~35 fragments)
- Thaicom 4 (July 2026 — GEO end-game target, power-system failure)

**The orbital-ladder ↔ FEEP-metals progression is now the central reward spine:**
- VLEO indium → LEO gallium → ISS bismuth → MEO cesium → GEO tungsten
- Each metal unlock = a new orbit becomes reachable
- Forge becomes a strategic engine (refine for now vs. stockpile for later)

**Ready for code mode.** Next shift starts at Sprint 8.1 — STATION_KEEP foundation.
