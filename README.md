# 🤠 Space Cowboy

**Play it:** [atominnovationth.github.io/SCB](https://atominnovationth.github.io/SCB/)

**A browser-based Newtonian-physics ADR (Active Debris Removal) simulation** built with Three.js. Command the V5 "Crossbow" satellite platform: navigate orbital mechanics, deploy spring-loaded capture arms, and clear 50 debris objects to win. Semi-autonomous collision avoidance AI keeps you alive while you focus on the catch.

UI design draws from four landmark space sims: **Independence War** (NavSphere, velocity vectors), **MechWarrior 2** (tension gauge, damage wireframe), **FreeSpace 2** (target wireframe, comms menu), and **Orbiter** (MFD panels, orbital visualization).

---

## Quick Start

```bash
./start.sh          # Starts Python HTTP server on port 8081
# Then open http://localhost:8081
```

**Controls:** `A` autopilot, `S` quick scan, `W` wide scan, `D` deploy daughter, `T` tool deploy, `F` focus action, `` ` `` cycle tools, Arrows rotate, `+/-` throttle, `Tab` cycle targets, `N` lasso/net (Space alias), `H` recall all, `R` smart reel-in, `V` camera, `P` arm pilot, `I` inspect, `J` journal, `Z` wireframe, `C` comms, `M` MPD/orbit, `L` codex, `B` shop, `X` detach, `F4` forge, `F5` fuel cycle, `Shift+1/2/3` power bus, `[/]` adjust. WASD thrust in arm pilot mode only (P key). Full table below.

**Tech:** Three.js r170 via CDN import maps. Zero build tools. ES6 modules. All geometry procedural (no GLTF). NASA public domain textures.

---

## Project Status

- **~36 system + entity + UI modules** across core, entities, systems, UI, scene (30+ system modules)
- **2320 / 2320 tests** passing as of 2026-05-28 (Post-Cinch-Fix QA pass)
- **Epics 5–10 complete** — V3 Octopus replaced by Config G visualization (Epic 10), 14-state Capture Net FSM (Epic 9), STATION_KEEP orbital-crane + dual-metal FEEP + ISRO comms (Epic 8), offline data catalog + MOID + strategic map (Epic 6), trail ribbons + NavSphere + Earth 16k LOD (Epic 5)
- **Q2 Net-Launch Ceremony shipped (2026-05-24)** — cone + weights + drawstring + apex hub geometry, `NET_CINEMATIC` 7-beat / 3-beat camera mode, time-dilation 0.3×–0.6×, first-deploy persistence gating
- **Post-Cinch QA pass shipped (2026-05-28)** — 9 of 11 items resolved; load-bearing THREE.js convention SSOT + 5 Rules A–E in [`HANDOFF.md §2–§3`](HANDOFF.md)
- **Next priorities**: Items 6/10/11 build (apex hub keepsake, first-clear guidance, forge chunking) — see [`HANDOFF.md §5 Recommended Priority Order`](HANDOFF.md)

---

## Documentation

**New developer?** Read in this order: README → GAME_DESIGN → ARCHITECTURE → BIG_PICTURE → HANDOFF. See [`HANDOFF.md §7 Active Docs Index`](HANDOFF.md) for the current doc-state map (audit updated 2026-05-29; root layout consolidated from 35 → 16 docs).

> **Locked product principles** (see [`HANDOFF.md Locked Product Principles`](HANDOFF.md)):
> - **Offline-first.** No auto-fetch APIs, no live TLE feeds, no telemetry. Catalogue updates are user-driven via `data/news-events.json`. THREE.js loads from local `node_modules/` (not CDN) so the sim boots offline.
> - **Dual-metal FEEP is Y0 baseline.** Multimetal FEEP is TRL 7–8 today (Enpulsion IFM Nano), not endgame.
> - **Mother launches from India** (ISRO Sriharikota / Kulasekarapattinam). Bangalore (ISTRAC) and Hassan (MCF) ground control are part of comms alongside Houston.

### 🟢 Canonical (6)

| # | Document | Purpose |
|---|----------|---------|
| 1 | [`README.md`](README.md) | Quick start, controls, project structure |
| 2 | [`HANDOFF.md`](HANDOFF.md) | Shift handoff — current state, load-bearing SSOTs (THREE.js conventions, Post-Cinch learnings), improvement backlog, tech debt, doc audit |
| 3 | [`GAME_DESIGN.md`](GAME_DESIGN.md) | Design vision — core loop (jellyfish trawl), ΔV economy, balloon metaphor (§2.1), Forge v2 chunk-and-queue (§4.0), Apex Hub Keepsake (§4.1), heritage |
| 4 | [`ARCHITECTURE.md`](ARCHITECTURE.md) | As-built technical reference — file structure, rendering, orbital mechanics (⚠️ needs Epic 9/10 update pass) |
| 5 | [`BIG_PICTURE.md`](BIG_PICTURE.md) | 12-month strategic roadmap — UX, V5 redesign, education, engineering |
| 6 | [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) | Sprint tracker — Sprints 1–4, Epics 5–10 completion log (⚠️ needs Epic 9/10 backfill) |

### 🟡 Active reference (10) — consult when touching the area

| Document | Read Before Touching |
|----------|----------------------|
| [`ARM_PIVOT_ANALYSIS.md`](ARM_PIVOT_ANALYSIS.md) | Config G geometry bible — [`PlayerSatellite.js`](js/entities/PlayerSatellite.js), [`ArmUnit.js`](js/entities/ArmUnit.js) |
| [`CAPTURE_NET.md`](CAPTURE_NET.md) | Capture Net design Rev 4 — [`CaptureNet.js`](js/entities/CaptureNet.js), [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js) |
| [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md) | V5 crossbow arm physics — [`ArmUnit.js`](js/entities/ArmUnit.js), [`ArmManager.js`](js/entities/ArmManager.js) |
| [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md) | Orbital-crane control redesign + dual-metal FEEP |
| [`DAUGHTER_MULTITOOL_SPEC.md`](DAUGHTER_MULTITOOL_SPEC.md) | Weaver/Spinner tool differentiation 4-phase plan |
| [`DAUGHTER_RETRIEVAL_AUDIT.md`](DAUGHTER_RETRIEVAL_AUDIT.md) | Wiring-gap survey for retrieval methods (companion to HANDOFF §3.8) |
| [`FIRST_EXPERIENCE.md`](FIRST_EXPERIENCE.md) | Welcome Field + first-90-second UX + Checklist Mode design |
| [`GAME_FLOW_BRAINSTORM.md`](GAME_FLOW_BRAINSTORM.md) | Tool failure modes, FEEP metals, ISRO comms, delight catalog |
| [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md) | 17 aerospace concepts taught via play |
| [`SKILLS_ARCHITECTURE.md`](SKILLS_ARCHITECTURE.md) | Skills Discovery system internals |

### 🟠 Archive (`archive/`)

40+ heritage docs across multiple consolidation passes. Recent additions (2026-05-29): all Epic 10 docs (DEEP_ANALYSIS, IMPLEMENTATION, VISUALIZATION_PLAN), all perf-sprint docs (GPU_PROFILING, PERF_SPRINT, PERF_FOLLOWUP, QUICK_WINS, SPRINT_2), SK_M1_POLISH_HANDOFF, CEREMONY_REDESIGN, CAPTURE_UX_AUDIT, DEPLOY_ANALYSIS, FINAL_ANALYSIS, and the 5 existing stubs (ARCHIVAL_PLAN, ARM_PIVOT_GAPS_EXPLAINER, CAPTURE_NET_QA, EPIC9_CODE_ORCHESTRATOR, UX_FIXES_ROADMAP) — plus POST_CINCH_QA_DESIGN_DOCS (content folded into GAME_DESIGN.md §4.0–4.1 + HANDOFF.md §4.9.2 #6). Older archived: V3 Octopus, V4 Opussy, RESEARCH_ARCHIVE, AUTOPILOT_ANALYSIS, COLLISION_AVOIDANCE_DESIGN, REFS_DECOUPLING_PLAN, ARCHITECTURE_ANALYSIS_V6, IMPLEMENTATION_PLAN_V6, IMPLEMENTATION_PLAN, FULL_HUD_STRATEGY, NAVSPHERE_REDESIGN, TARGET_PANEL_REDESIGN, ORCHESTRATOR_BRIEF, TUTORIAL_REDESIGN, CONTROL_REDESIGN, TUTORIAL_ANALYSIS, SKILLS_SYSTEM_DESIGN, UX_OVERHAUL_PLAN, BIG_PICTURE_EPIC_5_6_HISTORY, HANDOFF_AUTOPILOT_RETRO.

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

**Systems:** Active scanning (S/W keys with cooldowns, discovery mechanics, survey rewards), auto-tool recommendation (T tool-deploy, backtick-cycle), focus action (F key, context-sensitive), 5 camera views, ARM PILOT manual control (P key), FS2-style comms menu (C key), debris wireframe analysis (Z key), inspection mode (I key), journal/skills (J key), arm deorbit sacrifice (Ctrl+Shift+D), forge system (F4 key), power distribution ETS (Shift+1/2/3 + [/] keys), autopilot system (A key), throttle control (+/- keys), MPD thruster burst mode (M key), lasso/net fire (N key; Space alias), trawl system with adaptive speed, collision avoidance AI, 10-stage curiosity-driven tutorial.

**Audio:** 30+ procedural generators + ambient loop + 4-tier ΔV alarm + thruster sputtering + forge phase textures + target lock ceremony + lasso feedback.

### Key Bindings — Command Cluster (WASD Redesigned)

| Key | Normal Mode | ARM PILOT Mode |
|-----|-------------|----------------|
| **A** | Toggle autopilot | Arm thrust left |
| **S** | Quick Scan (1.5s ping, $50 reward, 20% discovery) | Arm thrust back |
| **W** | Wide Scan (4s deep scan, $150 reward, 40% discovery) | Arm thrust forward |
| **D** | Deploy daughter (launch ceremony) | Arm thrust right |

### Key Bindings — Full Reference

_Authoritative table (Delegation 1 hotkey rebind, 2026-05-31). The Codex is `L`. The Journal/Skills pane is `J`._

```
═══ MOTHER (orbital view) ═══
  S  · Quick Scan (1.5s, $50)
  W  · Wide Scan  (4s, $150)
  Tab · Cycle target (TPI-sorted)
  A  · Autopilot toggle
  D  · Deploy daughter (launch ceremony)
  T  · Tool Deploy (smart context)
  N  · Lasso / Net fire   (Space = onboarding smart-default → lasso)
  Shift+N · NavSphere toggle (Delegation 2 — 2026-05-31)
  P  · ARM PILOT toggle
  I  · Part callout inspection:
         · in ORBITAL_VIEW → V5 Crossbow mothership part callout (bottom-right panel,
           11 zones, auto-cycling; Tab advances zone, I closes)
         · in ARM_PILOT    → enlarged debris wireframe from daughter perspective
           (press I again to close; no target → comms hint "Select with Tab first")
       Shift+I = alias for I
  L  · Codex / Tech Library
  J  · Journal / Skills discovery
  B  · Shop
  M  · MFD (Orbit / MPD)
  N alias = Space (newbie-friendly default action)
  V / Shift+V · Camera cycle / Strategic Map
  C  · Comms tap-expand, hold-radial
  H  · Recall ALL deployed arms
  R  · Context Reel-in:
         · in ORBITAL_VIEW with deployed daughter → recall closest
         · during autopilot → abort autopilot
         · in ARM_PILOT → reel daughter home
  G  · (unbound — reserved)
  K  · (unbound — reserved)
  X  · Tether detach (sacrifice)
  Y  · EDT deploy
  Z / Shift+Z · Wireframe zone cycle
  ` / Shift+` · Debris Map / Tool cycle
  ,  / .  · Stow / deploy all struts
  +  / −  · Throttle ± (or SK approach/retreat in ARM_PILOT)
  [  / ]  · Power-bus adjust
  Shift+1/2/3 · Power-bus select
  1–6   · Select / pilot arm 1–6
  7     · Return to mother
  F4    · Forge (Kiln) toggle
  F5    · FEEP fuel cycle (Propellant)
  F2    · FEEP metal cycle (piloted arm)
  Shift+G · Trawl start
  Shift+O · Recall all (alias of H)
  O     · Deploy ALL docked arms
  Enter · Begin approach
  Esc   · Pause / back / exit
  Ctrl+D · Debug overlay
  Ctrl+Shift+D · Deorbit sacrifice
  PageUp/Down · Comms scroll
  Arrows · Pitch/Yaw  (or SK θ/φ in ARM_PILOT)

═══ DAUGHTER (ARM_PILOT) — only when P engaged ═══
  Arrows · Orbit debris (θ/φ)  ·  Shift = fine ¼
  + / −  · Approach/retreat (wheel also works)
  N      · Deploy net / capture
  F      · Smart focus (also deploys net)
  R      · Reel-in (with or without capture)
  I      · Inspect debris (part callouts) — render arrives in Delegation 3
  F2     · Cycle FEEP metal (indium/alt)
  Esc / P / 7 · Return to mother
  1–6    · Switch piloted daughter
  X      · Sacrifice detach
```

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
