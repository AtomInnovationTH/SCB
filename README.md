# 🤠 Space Cowboy

**A browser-based Newtonian-physics ADR (Active Debris Removal) simulation** built with Three.js. Command the V5 "Crossbow" satellite platform: navigate orbital mechanics, deploy spring-loaded capture arms, and clear 50 debris objects to win. Semi-autonomous collision avoidance AI keeps you alive while you focus on the catch.

UI design draws from four landmark space sims: **Independence War** (NavSphere, velocity vectors), **MechWarrior 2** (tension gauge, damage wireframe), **FreeSpace 2** (target wireframe, comms menu), and **Orbiter** (MFD panels, orbital visualization).

---

## Quick Start

```bash
./start.sh          # Starts Python HTTP server on port 8081
# Then open http://localhost:8081
```

**Controls:** `A` autopilot, `S` quick scan, `W` wide scan, `D` deploy tool, `F` focus action, `` ` `` cycle tools, Arrows rotate, `+/-` throttle, `Tab` cycle targets, `Space` lasso, `G` deploy arm, `H` recall, `V` camera, `P` arm pilot, `Z` wireframe, `C` comms, `N` NavSphere, `M` MPD/orbit, `L` tech library, `B` shop, `R` forge, `X` detach, `Shift+1/2/3` power bus, `[/]` adjust. WASD thrust in arm pilot mode only (P key).

**Tech:** Three.js r170 via CDN import maps. Zero build tools. ES6 modules. All geometry procedural (no GLTF). NASA public domain textures.

---

## Project Status

- **63 modules** across core, entities, systems, UI, scene (30 system modules)
- **272 suites / 1,252 tests** (32 test files) — all passing
- **Epic 8 complete** — STATION_KEEP orbital-crane, dual-metal FEEP (7 metals, Y0 baseline), news-driven missions, ReputationSystem, ISRO comms (BANGALORE/HASSAN), DockingReticle standoff sphere, NavSphere sibling markers
- **Epic 6 complete** — offline data catalog, debris textures + flag decals, MOID computation, strategic 3-D map, teaching overlays, TRL framing, environment hazards
- **Epic 5 complete** — trail ribbons, NavSphere overhaul, comms 6-channel redesign, Earth 16k LOD, radial menu
- **Next priorities**: Epic 9 — V5 Hardware Baseline (see [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md))

---

## Documentation

**New developer?** Read in this order: README → FINAL_ANALYSIS → IMPLEMENTATION_PLAN → ARCHITECTURE → BIG_PICTURE → GAME_DESIGN → HANDOFF. See [`FINAL_ANALYSIS.md`](FINAL_ANALYSIS.md) for the latest doc-state map and Epic 8 brief.

> **Locked product principles** (see [`FINAL_ANALYSIS.md §5.4`](FINAL_ANALYSIS.md)):
> - **Offline-first.** No auto-fetch APIs, no live TLE feeds, no telemetry. Catalogue updates are user-driven via `data/news-events.json`.
> - **Dual-metal FEEP is Y0 baseline.** Multimetal FEEP is TRL 7–8 today (Enpulsion IFM Nano), not endgame.
> - **Mother launches from India** (ISRO Sriharikota / Kulasekarapattinam). Bangalore (ISTRAC) ground control is part of comms alongside Houston.

| # | Document | Purpose |
|---|----------|---------|
| 1 | [README.md](README.md) | Quick start, controls, project structure |
| 2 | [FINAL_ANALYSIS.md](FINAL_ANALYSIS.md) | **NEW** — Doc-state map, Epic 8 brief, offline-first manifesto, India identity |
| 3 | [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | Epic tracker — Epics 1–8 done, Epic 9 next |
| 4 | [ARCHITECTURE.md](ARCHITECTURE.md) | As-built technical reference — 62 modules, rendering, orbital mechanics |
| 5 | [BIG_PICTURE.md](BIG_PICTURE.md) | 12-month strategic roadmap — UX, V5 redesign, education, engineering |
| 6 | [GAME_DESIGN.md](GAME_DESIGN.md) | Game design vision — core loop, economy, difficulty, heritage |
| 7 | [HANDOFF.md](HANDOFF.md) | Shift handoff — architectural gotchas, improvement backlog, tech debt |
| — | [DAUGHTER_ARM_CONTROLS.md](DAUGHTER_ARM_CONTROLS.md) | **NEW** — Orbital-crane control redesign (replaces WASD free-fly) + dual-metal FEEP |
| — | [GAME_FLOW_BRAINSTORM.md](GAME_FLOW_BRAINSTORM.md) | **NEW** — Tool failure modes, FEEP metals, ISRO comms, delight catalog |
| — | [CROSSBOW_ARMS.md](CROSSBOW_ARMS.md) | V5 crossbow arm system design bible (read before modifying arms) |
| — | [LEARNING_THROUGH_PLAY.md](LEARNING_THROUGH_PLAY.md) | Educational design — 17 aerospace concepts |
| — | [SKILLS_ARCHITECTURE.md](SKILLS_ARCHITECTURE.md) | Skills Discovery system as-built architecture |
| — | [FIRST_EXPERIENCE.md](FIRST_EXPERIENCE.md) | First 90-second onboarding design spec |

**Archived** (in `archive/`, 21 files): V3 Octopus, V4 Opussy, RESEARCH_ARCHIVE, COLLISION_AVOIDANCE_DESIGN, REFS_DECOUPLING_PLAN, ARCHITECTURE_ANALYSIS_V6, IMPLEMENTATION_PLAN_V6, IMPLEMENTATION_PLAN, FULL_HUD_STRATEGY, NAVSPHERE_REDESIGN, TARGET_PANEL_REDESIGN, ORCHESTRATOR_BRIEF, TUTORIAL_REDESIGN, CONTROL_REDESIGN, TUTORIAL_ANALYSIS, SKILLS_SYSTEM_DESIGN, UX_OVERHAUL_PLAN, AUTOPILOT_ANALYSIS — **+ Apr 25 consolidation:** UX_FIXES_ROADMAP (16 complete UX issues), BIG_PICTURE_EPIC_5_6_HISTORY (§§1,2,5,6,7,8,9 shipped Epic 5/6), HANDOFF_AUTOPILOT_RETRO (Sessions 19–30 retro)

---

## 🗂️ Project Structure

```
Space Cowboy/
├── README.md                ← YOU ARE HERE
├── ARCHITECTURE.md          ← Technical architecture reference
├── GAME_DESIGN.md           ← Game design vision (consolidated)
├── CROSSBOW_ARMS.md         ← V5 crossbow arm system design
├── index.html               ← Entry point (import maps + canvas + HUD overlay)
├── start.sh                 ← Dev server launcher (Python HTTP, port 8081)
├── test.sh                  ← Test runner shortcut
├── test.html                ← Browser-based test runner
│
├── js/
│   ├── main.js              ← Thin bootstrap + game loop (~520 LOC)
│   ├── core/
│   │   ├── Constants.js     ← ALL tuning knobs (~840 LOC)
│   │   ├── EventBus.js      ← Pub/sub singleton (92 LOC)
│   │   ├── Events.js        ← Event name constants (~145 LOC)
│   │   └── GameState.js     ← FSM with SHOP state + isGameplay() (~148 LOC)
│   ├── scene/
│   │   ├── SceneManager.js  ← Renderer + threshold bloom pipeline (228 LOC)
│   │   ├── Earth.js         ← 3-layer Earth: surface + clouds + atmosphere (534 LOC)
│   │   ├── Starfield.js     ← Point-based stars (~120 LOC)
│   │   └── SunLight.js      ← Sun, moon, lens flares, auto-exposure (~400 LOC)
│   ├── entities/
│   │   ├── PlayerSatellite.js ← V5 Crossbow + thrust + MPD (~1,400 LOC)
│   │   ├── ArmManager.js     ← 8-arm fleet coordinator (~568 LOC)
│   │   ├── ArmUnit.js        ← Crossbow arm FSM (~1,088 LOC)
│   │   ├── DebrisField.js    ← Instanced debris + salvage (~1,040 LOC)
│   │   ├── ActiveSatellite.js ← Protected satellites (292 LOC)
│   │   └── OrbitalMechanics.js ← Kepler + Hohmann + J2 (439 LOC)
│   ├── systems/              ← 29 system modules (see ARCHITECTURE.md §1)
│   │   ├── GameFlowManager.js, InputManager.js, CameraSystem.js,
│   │   ├── AudioSystem.js, ResourceSystem.js, ScoringSystem.js,
│   │   ├── PowerDistribution.js, SensorSystem.js, ForgeSystem.js,
│   │   ├── CargoSystem.js, CommsSystem.js, AutopilotSystem.js,
│   │   ├── TrawlManager.js, LassoSystem.js, MissionEventSystem.js,
│   │   ├── CodexSystem.js, SpaceWeatherSystem.js, ConjunctionSystem.js,
│   │   ├── KesslerSystem.js, PersistenceManager.js, RewardSystem.js,
│   │   ├── SubsystemEvents.js, TargetSelector.js, SkillsSystem.js,
│   │   ├── CatalogLoader.js, ActiveSatGuard.js, MoidCalculator.js,
│   │   ├── TeachingSystem.js, EnvironmentSystem.js,
│   │   ├── ReputationSystem.js,
│   │   └── CollisionAvoidanceSystem.js
│   ├── ui/                   ← ~22 UI modules (see ARCHITECTURE.md §6.5)
│   │   ├── HUD.js, hud/StatusPanel.js, hud/TargetPanel.js, hud/CommsPanel.js,
│   │   ├── hud/RadialMenu.js, hud/SkillsPane.js,
│   │   ├── NavSphere.js, OrbitMFD.js, TargetReticle.js, DebrisWireframe.js,
│   │   ├── DockingReticle.js, CodexViewerUI.js, VelocityStreaks.js,
│   │   ├── TrailSystem.js, DebrisMap.js, DebrisTextureAtlas.js,
│   │   ├── FlagDecalSystem.js, TeachingOverlay.js, StrategicMap.js,
│   │   ├── ShopScreen.js, BriefingScreen.js, GameOverScreen.js, MenuScreen.js,
│   │   └── DebugOverlay.js, SweepReportUI.js
│   └── test/                 ← Unit test suite (32 test files)
│       ├── TestRunner.js     ← Micro-framework: describe/it/assert (~80 LOC)
│       ├── run-tests.js      ← Node.js CLI entry point
│       └── 32 test files     ← See ARCHITECTURE.md §1 for full list
│
│
├── data/                     ← Offline catalog JSON files (7 files — debris, sats, weather, etc.)
├── textures/                 ← NASA public domain Earth textures (day/night/clouds, 4K-16K)
│
├── LEARNING_THROUGH_PLAY.md ← Educational design (17 aerospace concepts)
├── HANDOFF.md               ← Shift handoff brief
└── archive/                  ← 18 archived design docs (see HANDOFF.md §7)
```

**Total: 63 modules, ~36,000+ LOC JavaScript. 1,252 tests across 272 suites (32 test files).**

---

## 🚀 Current Gameplay

**Core loop:** S scan → Tab target → A autopilot → D deploy tool → capture → score/salvage → win at 50. Autopilot-first paradigm: manual flight is a 1% mastery skill. Full roguelite progression with 25+ shop upgrades, localStorage persistence, 50% credit penalty on continue.

**HUD:** Progressive luminance system (dormant/active CSS states). 3-panel left column (Propulsion/Energy/Fleet), right column (wireframe + target list), NavSphere with distance encoding + range rings, OrbitMFD, 5-color system.

**Systems:** Active scanning (S/W keys with cooldowns, discovery mechanics, survey rewards), auto-tool recommendation (D-deploy, backtick-cycle), focus action (F key, context-sensitive), 5 camera views, ARM PILOT manual control (P key), FS2-style comms menu (C key), debris wireframe analysis (Z key), arm deorbit sacrifice (Ctrl+Shift+D), forge system (R key), power distribution ETS (Shift+1/2/3 + [/] keys), autopilot system (A key), throttle control (+/- keys), MPD thruster burst mode (M key), lasso with miss recovery prompts (Space), trawl system with adaptive speed, collision avoidance AI, 10-stage curiosity-driven tutorial.

**Audio:** 30+ procedural generators + ambient loop + 4-tier ΔV alarm + thruster sputtering + forge phase textures + target lock ceremony + lasso feedback.

### Key Bindings — Command Cluster (WASD Redesigned)

| Key | Normal Mode | ARM PILOT Mode |
|-----|-------------|----------------|
| **A** | Toggle autopilot | Arm thrust left |
| **S** | Quick Scan (1.5s ping, $50 reward, 20% discovery) | Arm thrust back |
| **W** | Wide Scan (4s deep scan, $150 reward, 40% discovery) | Arm thrust forward |
| **D** | Deploy recommended tool | Arm thrust right |

### Key Bindings — Full Reference

| Key | Action |
|-----|--------|
| ↑/↓/←/→ | Pitch / Yaw rotation; in STATION_KEEP: orbit debris θ/φ |
| +/= and − | Increase / decrease throttle; in STATION_KEEP: adjust standoff distance |
| `` ` `` (backtick) | Cycle tool alternatives (MW2-style weapon scroll) |
| F | Focus Action — context-sensitive smart button; in STATION_KEEP: capture |
| F2 | Cycle FEEP metal on piloted arm (ARM_PILOT mode) |
| Tab | Cycle target selection (auto-recommends best tool) |
| Space | Cast lasso — or deploy net in ARM PILOT |
| G | Deploy arm to target (secondary to D) / Shift+G: deploy trawl net |
| H | Recall all arms |
| X | Tether detach (risk-reward sacrifice) |
| R | Cycle forge mode: OFF → REFINE → PROPELLANT → OFF |
| T | Cycle fuel type |
| V | Camera cycle (COMMAND → TACTICAL → OVERVIEW) |
| P | Toggle ARM PILOT mode (40° FOV, arm camera) — WASD becomes arm thrust |
| B | Open shop |
| Z / Shift+Z | Cycle wireframe zones forward / backward |
| C | Toggle comms menu (FS2-style 1–6 commands) |
| M | Toggle MPD armed / Orbit View (if no MPD upgrade) |
| N | Toggle NavSphere |
| L | Open Tech Library (105-entry encyclopedia) |
| Shift+1/2/3 | Select power bus (Thrust / Sensors / Arms) |
| [ / ] | Adjust power allocation ±10% |
| Ctrl+D | Debug overlay |
| Ctrl+Shift+D | Deorbit sacrifice (arm burns all fuel retrograde) |
| Shift | Fine mode (¼ rates) during STATION_KEEP orbit controls |
| Esc | Pause; in STATION_KEEP: recall arm |

> **Note:** WASD mothership thrust removed from normal play. Autopilot handles all navigation. WASD is a command cluster (A/S/W/D) in normal mode, traditional thrust only in ARM PILOT mode (P key).

---

## 🛠️ Development

### Running the Game
```bash
./start.sh                    # Python HTTP server on port 8081
# Then open http://localhost:8081
```

### Running Tests
```bash
./test.sh                     # or: node js/test/run-tests.js
# 272 suites / 1,252 tests — all passing
```

Browser-based tests: open [`test.html`](test.html) in any browser.

### Test Coverage

32 test files covering core, entities, systems, and UI modules. Key areas include Constants validation, EventBus pub/sub, OrbitalMechanics round-trips, GameState FSM, scoring/credits, power distribution, V5 crossbow arm FSM, collision avoidance, autopilot phases, skills discovery, lasso mechanics, mission profiles/events, comms system, NavSphere, trail system, TRL classification, catalog loading, conjunction/MOID, debris textures, teaching system, environment hazards, strategic map, STATION_KEEP state machine, FEEP metals, news events, and ISRO Codex entries.

Tests target Node-safe modules only (no THREE.js, no DOM). Add new test files to [`js/test/run-tests.js`](js/test/run-tests.js). Full test file list in [`ARCHITECTURE.md`](ARCHITECTURE.md) §1.

---

## 🎮 Key Design Decisions

1. **Autopilot-first, not flight sim.** Manual piloting to debris in orbit is counterintuitive and burns ΔV. Autopilot handles navigation. WASD becomes a command cluster. Free flight is a 1% mastery skill — the game never requires it.

2. **Scanning is treasure hunting.** Active scanning (S/W keys) transforms passive data into an exploration loop: scan → discover uncharted debris → earn survey credits → build the catalog. Every scan can reveal hidden fragments.

3. **Auto-tool recommendation removes choice paralysis.** Tab selects a target, system auto-recommends the best arm/lasso/trawl. D deploys it. Backtick cycles alternatives. Newbies D-spam and win; experts manually optimize.

4. **4-tier skill progression:** Auto-capture (×1.0) → Tactical assessment (×1.3) → Manual arm piloting (×2.0) → Fuel-efficient approach (×1.25). Combined max ×3.74 with salvage.

5. **ΔV is the master resource — but salvage extends it.** MW2's heat gauge adapted: every action depletes ΔV, it never regenerates (unless you salvage Xenon), below 30% triggers alarm.

6. **Arm sacrifice creates meaningful tradeoffs.** Return the arm (reuse it) or sacrifice it for a ×1.5–2.5 deorbit bonus?

7. **Wireframe = information, solid = world.** I-War/FS2 aesthetic: physical universe renders normally, all information overlays use wireframe/vector rendering.

8. **Skills Discovery + Teaching System.** 33-skill free-order discovery system (replaced linear tutorial). TeachingSystem delivers 15 contextual overlays at first-encounter moments. No tutorial walls — every key press is rewarded.

9. **Roguelite progression.** Credits persist across missions. Shop every 5 debris. 50% credit penalty on continue.
