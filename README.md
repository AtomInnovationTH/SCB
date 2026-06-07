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

- **~150 modules** across core, entities, systems, UI, scene
- **2542 / 2542 tests** passing as of 2026-06-07 (`node js/test/run-tests.js`)
- **Epics 5–10 complete + capture-lifecycle polish (2026-06-06)** — Config G visualization, 14-state Capture Net FSM with physics cling probability, STATION_KEEP orbital-crane + dual-metal FEEP + ISRO comms, offline data catalog + MOID + strategic map, trail ribbons + NavSphere + Earth 16k LOD, park-the-catch (`HOLDING_CATCH`)
- **Architecture refreshed 2026-06-07** — [`ARCHITECTURE.md`](ARCHITECTURE.md) is now the verified as-built blueprint (full hotkey map, FEATURE_FLAGS truth table, ceremonies, capture-FSM reachability, drift register)
- **Next priorities**: see [`ROADMAP.md`](ROADMAP.md) — critical path **CP-1 (wire the magnet / make tool choice real)** → CP-2 (laser de-spin) → CP-3 (cluster/transfer agency) → CP-4 (MissionCoach + comms arbiter) toward the full 12-mission arc

---

## Documentation

**New developer?** Read in order: **README → [`ARCHITECTURE.md`](ARCHITECTURE.md) (how the code works now) → [`ROADMAP.md`](ROADMAP.md) (what to build next) → [`GAME_DESIGN.md`](GAME_DESIGN.md) (why)**, then [`HANDOFF.md`](HANDOFF.md) §9–§11 before touching orientation/FSM/capture/visual code. Doc set consolidated 2026-06-07 (root = canonical + active-reference specs only; superseded docs in [`archive/`](archive/)).

> **Locked product principles:**
> - **Offline-first.** No auto-fetch APIs, no live TLE feeds, no telemetry. Catalogue updates are user-driven via `data/news-events.json`. THREE.js loads from local `node_modules/` so the sim boots offline.
> - **Dual-metal FEEP is Y0 baseline.** Multimetal FEEP is TRL 7–9 today (Enpulsion IFM Nano), not endgame.
> - **Mother launches from India** (ISRO Sriharikota / Kulasekarapattinam). Bangalore (ISTRAC) and Hassan (MCF) ground control join Houston in comms.
> - **ΔV is the single master resource** — never free-regenerates except via salvage→forge→propellant.

### 🗺 Doc Map — which doc for what

| I want to… | Open |
|---|---|
| Understand how the code works *right now* | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Know what to build next + risk/effort | [`ROADMAP.md`](ROADMAP.md) |
| See current shift state + load-bearing rules | [`HANDOFF.md`](HANDOFF.md) |
| Understand the game vision / economy | [`GAME_DESIGN.md`](GAME_DESIGN.md) · [`BIG_PICTURE.md`](BIG_PICTURE.md) |
| Build the daughter tools (magnet/gripper/pad) + net-failure modes | [`DAUGHTER_MULTITOOL_SPEC.md`](DAUGHTER_MULTITOOL_SPEC.md) |
| Build the 12-mission arc | [`MISSION_ARC_IMPLEMENTATION.md`](MISSION_ARC_IMPLEMENTATION.md) + [`MISSION_GUIDANCE_DESIGN.md`](MISSION_GUIDANCE_DESIGN.md) |
| Coordinate onboarding/coach/comms (who can talk) | [`GUIDANCE_ARBITER_SPEC.md`](GUIDANCE_ARBITER_SPEC.md) |
| Work on arm/net physics or geometry | [`CAPTURE_NET.md`](CAPTURE_NET.md) · [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md) · [`ARM_PIVOT_ANALYSIS.md`](ARM_PIVOT_ANALYSIS.md) · [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md) |
| Work on skills / teaching content | [`SKILLS_ARCHITECTURE.md`](SKILLS_ARCHITECTURE.md) · [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md) |
| Touch the menu hero / Mother model | [`MOTHER_MODEL_UPGRADES.md`](MOTHER_MODEL_UPGRADES.md) |

### 🟢 Canonical (6)

[`README.md`](README.md) · [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`ROADMAP.md`](ROADMAP.md) · [`HANDOFF.md`](HANDOFF.md) · [`GAME_DESIGN.md`](GAME_DESIGN.md) · [`BIG_PICTURE.md`](BIG_PICTURE.md)

### 🟡 Active reference (build specs + subsystem docs)

**Build specs (new):** [`GUIDANCE_ARBITER_SPEC.md`](GUIDANCE_ARBITER_SPEC.md), [`MISSION_ARC_IMPLEMENTATION.md`](MISSION_ARC_IMPLEMENTATION.md).
**Subsystems:** [`ARM_PIVOT_ANALYSIS.md`](ARM_PIVOT_ANALYSIS.md), [`CAPTURE_NET.md`](CAPTURE_NET.md), [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md), [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md), [`DAUGHTER_MULTITOOL_SPEC.md`](DAUGHTER_MULTITOOL_SPEC.md), [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md), [`MISSION_GUIDANCE_DESIGN.md`](MISSION_GUIDANCE_DESIGN.md), [`MOTHER_MODEL_UPGRADES.md`](MOTHER_MODEL_UPGRADES.md), [`SKILLS_ARCHITECTURE.md`](SKILLS_ARCHITECTURE.md).

### 🟠 Archive (`archive/`)

Heritage + superseded docs. Folded-and-archived 2026-06-07: `FIRST_EXPERIENCE.md` (→ MISSION_ARC §3), `GAME_FLOW_BRAINSTORM.md` (→ MULTITOOL §15), `DAUGHTER_RETRIEVAL_AUDIT.md` (→ ARCHITECTURE §9), `QA_FINDINGS.md`, and the sprint tracker `IMPLEMENTATION_PLAN_2026-06.md`. Plus prior-shift handoffs, Epic 10 docs, perf-sprint docs, and earlier consolidation passes.

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
