# Space Cowboy — Architecture Document

> Browser-based 3D space debris remediation game built with Three.js, vanilla JS ES6+ modules, and zero build tools.
>
> **Last updated:** 2026-04-25 (Epic 8 complete. 272 suites / 1,252 tests / 0 failures.)
>
> **Epic 8 landing — 2026-04-25:**
> - New systems: [`ReputationSystem.js`](js/systems/ReputationSystem.js)
> - New data: [`data/news-events.json`](data/news-events.json) (3 real-world news events)
> - Modified: [`ArmUnit.js`](js/entities/ArmUnit.js) (STATION_KEEP state + dual-metal FEEP), [`Constants.js`](js/core/Constants.js) (ION_THRUSTER, STATION_KEEP, TETHER_TENSION, FORGE_METAL_YIELDS), [`Events.js`](js/core/Events.js) (5 new events), [`InputManager.js`](js/systems/InputManager.js), [`CameraSystem.js`](js/systems/CameraSystem.js), [`CommsSystem.js`](js/systems/CommsSystem.js), [`MissionEventSystem.js`](js/systems/MissionEventSystem.js), [`ForgeSystem.js`](js/systems/ForgeSystem.js), [`CodexSystem.js`](js/systems/CodexSystem.js), [`HUD.js`](js/ui/HUD.js), [`DockingReticle.js`](js/ui/DockingReticle.js), [`NavSphere.js`](js/ui/NavSphere.js), [`main.js`](js/main.js)
> - New test files (4): `test-StationKeep.js`, `test-FEEPMetals.js`, `test-NewsEvents-epic8.js`, `test-CodexISRO.js`
> - New Constants namespaces: `ION_THRUSTER`, `ION_THRUSTER_METALS`, `STATION_KEEP`, `TETHER_TENSION`, `FORGE_METAL_YIELDS`
> - Test baseline now **272 suites / 1,252 tests / 0 failures** (+34 suites, +92 tests from Epic 6)
>
> **Epic 6 landing — 2026-04-22:**
> - New systems: [`CatalogLoader.js`](js/systems/CatalogLoader.js), [`MoidCalculator.js`](js/systems/MoidCalculator.js), [`TeachingSystem.js`](js/systems/TeachingSystem.js), [`EnvironmentSystem.js`](js/systems/EnvironmentSystem.js), [`ActiveSatGuard.js`](js/systems/ActiveSatGuard.js)
> - New entities: [`CatalogConverter.js`](js/entities/CatalogConverter.js)
> - New UI: [`DebrisTextureAtlas.js`](js/ui/DebrisTextureAtlas.js), [`FlagDecalSystem.js`](js/ui/FlagDecalSystem.js), [`TeachingOverlay.js`](js/ui/TeachingOverlay.js), [`StrategicMap.js`](js/ui/StrategicMap.js)
> - New data: [`/data/`](data/) directory with 7 offline catalog JSON files (debris, sats, weather, ground stations, constellations, launches, META)
> - New Constants namespaces: `TRL`, `CATALOG`, `CONJUNCTION.MOID_*`, `DEBRIS_VISUAL`, `TEACHING`, `ENVIRONMENT`, `STRATEGIC_MAP`
> - Test baseline was **238 suites / 1158 tests / 0 failures** (+81 suites, +317 tests from Epic 5)
>
> **Epic 5 landing — 2026-04-20:**
> - New modules: [`TrailSystem.js`](js/ui/TrailSystem.js) (570 LOC), [`RadialMenu.js`](js/ui/hud/RadialMenu.js) (~430 LOC)
> - NavSphere overhaul: bidirectional stalks, pulsing cyan lock-on ring, WGS-84 geolocation readout, closure velocity arrows
> - CommsPanel 6-channel redesign + target-anchored radial menu (center popup removed)
> - Earth 16k/8k/4k LOD + VLEO cinematic intro + FOV 55° + cloud rotation
> - Test baseline now **157 suites / 841 tests / 0 failures** (+32 suites, +168 tests from Sprints 1–4 baseline)

---

## Table of Contents

1. [File Structure & Module Organization](#1-file-structure--module-organization)
2. [Technology Stack & CDN Links](#2-technology-stack--cdn-links)
3. [Game State Machine](#3-game-state-machine)
4. [Rendering Pipeline](#4-rendering-pipeline)
5. [Camera System](#5-camera-system)
6. [Class & Module Design](#6-class--module-design)
7. [V5 Crossbow Arm System](#7-v5-crossbow-arm-system)
8. [3D Scene Composition](#8-3d-scene-composition)
9. [HUD Layout](#9-hud-layout)
10. [Resource Formulas & Balance](#10-resource-formulas--balance)
11. [Scoring System](#11-scoring-system)
12. [Upgrade Tree](#12-upgrade-tree)
13. [Debris Generation Algorithm](#13-debris-generation-algorithm)
14. [Orbital Mechanics Model](#14-orbital-mechanics-model)
15. [Sound Design Plan](#15-sound-design-plan)
16. [Performance Optimization Strategy](#16-performance-optimization-strategy)
17. [Key Constants & Simulation Parameters](#17-key-constants--simulation-parameters)
18. [Development History](#18-development-history)

---

## 1. File Structure & Module Organization

### Actual File Structure (as-built)

```
Space Cowboy/
├── index.html                  # Entry point — <script type="module" src="js/main.js">
├── start.sh                    # Local dev server launcher
│
├── ARCHITECTURE.md             # This file
├── CROSSBOW_ARMS.md            # V5 crossbow arm system design bible
├── GAME_DESIGN.md              # Design vision, core loop, economy (merged ROADMAP+GAMEPLAY_LOOP+MASTER_PLAN)
├── LEARNING_THROUGH_PLAY.md    # Educational design (17 concepts)
├── HANDOFF.md                  # Shift handoff brief (refreshed each session)
├── archive/                    # Archived design docs (18 files — see Archive Index in HANDOFF.md)
│
├── data/
│   ├── debris-catalog.json     # 36,500 tracked objects from public catalog snapshot
│   ├── active-sats.json        # 8,000 active satellites (CelesTrak)
│   ├── launches.json           # Upcoming launches next 90 days
│   ├── space-weather.json      # F10.7 flux & Ap index (NOAA SWPC)
│   ├── ground-stations.json    # GSN, ESTRACK, DSN, commercial networks
│   ├── constellations.json     # Starlink, OneWeb, GPS, Galileo, BeiDou, Iridium
│   └── META.json               # Snapshot date, sources, checksums
│
├── js/
│   ├── main.js                 # ~520 LOC — Thin bootstrap + game loop
│   │                           #   (game flow extracted to GameFlowManager.js,
│   │                           #   input handling extracted to InputManager.js,
│   │                           #   wireframe now created by HUD.js [Session 10],
│   │                           #   AutopilotSystem + CodexViewerUI wired [S13])
│   │
│   ├── core/
│   │   ├── Constants.js        # ~860 LOC — All tuning knobs including 120+ V3
│   │   │                       #   arm constants, 42 V5 crossbow constants (spring,
│   │   │                       #   reel, dual-fire, scan, ablation, tiers), salvage,
│   │   │                       #   HUD block, AUDIO block, MPD thruster
│   │   │                       #   [expanded S10, S11, S13, S17 V5]
│   │   ├── EventBus.js         # 92 LOC — Pub/sub singleton
│   │   ├── Events.js           # ~310 LOC — Event name constants (100% coverage,
│   │   │                       #   zero raw strings) [expanded S10–S13, S17: 13 V5
│   │   │                       #   crossbow events; S22: tutorial/scan/autopilot
│   │   │                       #   events; S23: SCAN_INITIATED, AUTOPILOT_ARRIVED]
│   │   └── GameState.js        # ~148 LOC — FSM with SHOP state + transition
│   │                           #   validation + isGameplay() [expanded Session 9]
│   │
│   ├── scene/
│   │   ├── SceneManager.js     # 228 LOC — Three.js renderer + single-composer
│   │   │                       #   threshold bloom pipeline (RenderPass →
│   │   │                       #   UnrealBloomPass → SMAAPass)
│   │   ├── Earth.js            # 534 LOC — 3-layer Earth (surface + clouds +
│   │   │                       #   atmosphere), adaptive texture quality,
│   │   │                       #   8K cloud textures, ocean specular with
│   │   │                       #   ratio-based detection + Fresnel
│   │   ├── Starfield.js        # ~120 LOC — Star field (instanced points),
│   │   │                       #   explicit depthTest:true on constellation
│   │   │                       #   lines/labels [Session 13 F9]
│   │   └── SunLight.js         # ~400 LOC — Directional sun, sun disc sprite
│   │                           #   (64×64 canvas radial gradient), 3 lens flare
│   │                           #   sprites, auto-exposure (dot product), moon
│   │                           #   sprite with phase calculation, depth mask
│   │                           #   meshes for Sun, Moon, planets at r=398
│   │                           #   (inside star sphere r=400) [Session 13 F9]
│   │
│   ├── entities/
│   │   ├── PlayerSatellite.js  # ~1,400 LOC — 8-sided octagonal prism main bus,
│   │   │                       #   6 docking cavities, thrust, applyUpgrade(),
│   │   │                       #   power-aware thrust efficiency [updated Session 9],
│   │   │                       #   RCS puff pool (8 sprites, 6 nozzles) [F10],
│   │   │                       #   rotatePitch/rotateYaw + _manualRotation quat [F13],
│   │   │                       #   throttleLevel + setThrottleLevel() [F14],
│   │   │                       #   thrustMPD + cathode erosion + lithium [F16],
│   │   │                       #   autopilotEngaged flag (suppresses orientation decay),
│   │   │                       #   scan flash (SCAN_INITIATED → 0.5s cyan body glow)
│   │   │                       #   [Session 13, S23 scan flash]
│   │   ├── ArmManager.js       # ~700 LOC — 8-arm fleet coordinator with
│   │   │                       #   dual-fire recoil cancellation, pulse scan
│   │   │                       #   orchestration, fleet upgrade management
│   │   │                       #   [V5 crossbow Session 17]
│   │   ├── ArmUnit.js          # ~1,300 LOC — 20-state autonomous arm with
│   │   │                       #   V5 crossbow spring physics, zero-fuel reel-in,
│   │   │                       #   ablation laser, tangle resolution
│   │   │                       #   [V5 crossbow Session 17]
│   │   ├── CatalogConverter.js # Converts /data/ JSON into DebrisField-compatible format
│   │   ├── ActiveSatellite.js  # 292 LOC — Protected satellites (collision = game over)
│   │   ├── DebrisField.js      # ~1,490 LOC — Instanced mesh manager for all
│   │   │                       #   debris, spatial query cache, salvage
│   │   │                       #   generation per debris [updated Session 10],
│   │   │                       #   lithium salvage from defunct satellites [S13 F16],
│   │   │                       #   TUTORIAL_STAGE_REQUIREMENTS (stages 2,6,7,8) —
│   │   │                       #   repositions far-away debris near player per
│   │   │                       #   stage, listens TUTORIAL_STAGE_CHANGED [S23]
│   │   └── OrbitalMechanics.js # 439 LOC — Kepler + Hohmann + J2 + drag
│   │
│   ├── systems/                # 29 system modules
│   │   ├── ActiveSatGuard.js   # Prevents capture of active satellites from catalog
│   │   ├── AutopilotSystem.js  # ~545 LOC — Autopilot with 4-tier heading
│   │   │                       #   priority (target → trawl → large debris →
│   │   │                       #   prograde), lookAt quaternion + rate-limited
│   │   │                       #   slerp rotation (0.2 rad/s, 0.01 dead zone),
│   │   │                       #   approach-from-behind via targetPrograde,
│   │   │                       #   tool-aware arrival (TOOL_ARRIVAL_DISTANCES),
│   │   │                       #   locked target ref, phase correction,
│   │   │                       #   AUTOPILOT_ARRIVED event, ΔV safety checks
│   │   │                       #   [NEW S13 F15, rewritten S23]
│   │   ├── CameraSystem.js     # 776 LOC — 5 camera views (COMMAND, TACTICAL,
│   │   │                       #   OVERVIEW + ARM_PILOT + COCKPIT), smooth
│   │   │                       #   transitions, auto-camera on arm events
│   │   ├── AudioSystem.js      # ~2,760 LOC — 30+ procedural generators + ambient
│   │   │                       #   loop + 4-tier ΔV alarm + thruster sputtering,
│   │   │                       #   playScan (radar sweep), playCashRegister (ka-ching),
│   │   │                       #   playAPArrived (ascending triple-beep),
│   │   │                       #   playAPDisengage (descending tone), MPD burst mode,
│   │   │                       #   lasso fire/denied/reel, event wiring for
│   │   │                       #   SCAN_INITIATED, SCORING_AWARD, AUTOPILOT_ARRIVED,
│   │   │                       #   AUTOPILOT_DISENGAGE, TARGET_SELECTED, FUEL_CHANGED,
│   │   │                       #   CARGO_STORE, STATE_CHANGE [expanded S10-S16, S23]
│   │   ├── CommsSystem.js      # 616 LOC — Message framework + FS2 comms menu
│   │   ├── KesslerSystem.js    # 273 LOC — Fragment generation + applyUpgrade
│   │   ├── ResourceSystem.js   # ~340 LOC — SOLE resource authority, push-only sync,
│   │   │                       #   serialize/restore, replenishPanelHealth() [S10],
│   │   │                       #   lithium resource tracking (add, consume,
│   │   │                       #   serialize, restore) [Session 13 F16]
│   │   ├── ScoringSystem.js    # ~286 LOC — Points + credits + scoring multipliers
│   │   │                       #   + salvage + deorbit bonuses [Session 10]
│   │   ├── SensorSystem.js     # ~480 LOC — EO/IR/LIDAR range + reveal + applyUpgrade,
│   │   │                       #   power-aware range scaling [updated Session 9],
│   │   │                       #   active scan (S/W key — ping + wide scan,
│   │   │                       #   cooldowns, discovery mechanics, SCAN_INITIATED
│   │   │                       #   event for audio/visual feedback) [S22, S23]
│   │   ├── InputManager.js     # ~520 LOC — Keyboard handling, WASD command cluster
│   │   │                       #   (A=autopilot, S=scan, W=wide scan, D=deploy),
│   │   │                       #   backtick=tool cycle, F=focus action,
│   │   │                       #   arrow keys → rotation [F13], +/- throttle [F14],
│   │   │                       #   WASD thrust in arm pilot only [S22]
│   │   │                       #   [S7 + S9 + S10 + S11 + S13 + S21 + S22]
│   │   ├── GameFlowManager.js  # ~1,060 LOC — State transitions, event wiring,
│   │   │                       #   save/load, salvage recovery, deorbit scoring,
│   │   │                       #   lithium salvage processing [NEW Session 9,
│   │   │                       #   expanded Session 10, Session 13 F16]
│   │   ├── PowerDistribution.js # ~221 LOC — FS2-heritage ETS: 3 buses
│   │   │                       #   (Thrust/Sensors/Arms) [NEW Session 9]
│   │   ├── PersistenceManager.js # 146 LOC — localStorage save/load [NEW Tier 4A]
│   │   ├── CatalogLoader.js    # Loads /data/*.json offline catalog, hybrid merge
│   │   │                       #   with procedural debris [Epic 6 ST-6.1]
│   │   ├── MoidCalculator.js   # 8-point sampled MOID computation + tier badges
│   │   │                       #   [Epic 6 ST-6.3]
│   │   ├── TeachingSystem.js   # 15 contextual teaching moments, EventBus-driven,
│   │   │                       #   localStorage persistence [Epic 6 ST-6.5]
│   │   ├── EnvironmentSystem.js # AO, MMOD, safe-mode, radiation belt, battery DOD
│   │   │                       #   5 hazard effects [Epic 6 ST-6.7]
│   │   ├── TargetSelector.js   # ~150 LOC — Target selection, auto-tool recommendation
│   │   │                       #   (mass-based tool selection, D-deploy, backtick-cycle),
│   │   │                       #   focus action (F key), setTarget() context parameter
│   │   │                       #   [NEW Session 5, updated S11, S22 auto-tool + focus]
│   │   ├── ForgeSystem.js      # Forge toggle + state cycling, FORGE_TOGGLE
│   │   │                       #   listener, toggle() method [NEW Session 11]
│   │   └── CollisionAvoidanceSystem.js # ~290 LOC — Semi-autonomous evasive
│   │                           #   manoeuvre system, 4 Hz scan, RCS dodge,
│   │                           #   active target exempt, ARM_PILOT suppress
│   │                           #   [NEW Session 19 — CA AI]
│   │
│   └── ui/
│       ├── HUD.js              # ~550 LOC — HUD coordinator: right-column layout
│       │                       #   (wireframe + target list), VIEW_INFO_LEVELS
│       │                       #   with showAnalysis, creates DebrisWireframe,
│       │                       #   progressive luminance (.hud-dormant/.hud-active),
│       │                       #   setCodexSystem() delegation
│       │                       #   [Refactored S7, right-column S10, hotkey S11,
│       │                       #   codex wiring S13, progressive luminance S16]
│       ├── hud/
│   │   ├── StatusPanel.js  # ~1,560 LOC — Score, PROPULSION panel (ΔV bar with
│   │   │                   #   5-tier visual + dark-pill contrast fix [F1],
│   │   │                   #   font bumps [F8]), horizontal-expand panels
│   │   │                   #   [F11] — PROPULSION + ENERGY collapse to 110px,
│   │   │                   #   expand to 260px), fleet collapsed summary [F12],
│   │   │                   #   throttle gauge [F14], autopilot indicator [F15],
│   │   │                   #   lithium bar + cathode display [F16], codex
│   │   │                   #   badge [F17], DELTAV_UPDATE emitter,
│   │   │                   #   credit flash (yellow pulse on credit increase) [S23]
│   │   │                   #   [S7+S9+S11+S13+S23]
│       │   ├── TargetPanel.js  # ~360 LOC — Target list, ΔV transfer costs,
│       │   │                   #   arm range indicators, ⛏ salvage icons,
│       │   │                   #   contextual hints, lithium target hints [S13 F16]
│       │   │                   #   [NEW Session 7, salvage+hints Session 10]
│       │   └── CommsPanel.js   # ~375 LOC — FS2-style comms menu (6 commands),
│       │                       #   credits counter, ground comms log
│       │                       #   [NEW Session 7, deorbit cmd Session 10]
│       ├── CodexViewerUI.js    # ~300 LOC — DOM overlay tech library browser with
│       │                       #   category sidebar, 105 entry cards, detail view,
│       │                       #   unseen badge, L key toggle
│       │                       #   [NEW Session 13 F17, expanded Session 18 V6]
│       ├── TargetReticle.js    # ~1,050 LOC — Brackets + velocity markers + lead
│       │                       #   indicator, closure rate + ETA on prograde,
│       │                       #   post-burn ΔV on retrograde, top-2 metal loot
│       │                       #   preview, DPI scaling + image smoothing
│       │                       #   [S11, S13 F5]
│       ├── DebrisWireframe.js  # ~1,180 LOC — Canvas2D wireframe analysis, 5 shapes
│       │                       #   (4 debris + ADR satellite 1.5× scaled), zone
│       │                       #   coloring, salvage indicators, DPI scaling [F2],
│       │                       #   enlarged panel (320px, VIEW_SCALE 240), [Z]
│       │                       #   hotkey hint, font bumps [F3]
│       │                       #   [Tier 2, Session 10, Session 13]
│       ├── OrbitMFD.js         # ~620 LOC — Orbiter-heritage orbit visualization
│       │                       #   2D ellipses, Hohmann transfer, toggle M key,
│       │                       #   Ap/Pe labels, Hohmann ΔV₁/ΔV₂ at burn points,
│       │                       #   inclination diff, prograde direction arrow,
│       │                       #   DPI scaling + image smoothing, route label
│       │                       #   y-coordinate bugfix [S11, S13 F6]
│       ├── DockingReticle.js   # ~560 LOC — ARM PILOT crosshair/alignment overlay,
│       │                       #   range, closure rate, yaw/pitch, DPI scaling +
│       │                       #   image smoothing [NEW Tier 3, S13 F7]
│       ├── NavSphere.js        # ~490 LOC — Canvas2D 3D radar sphere + I-War
│       │                       #   vertical stalks, 260px, top-right, N key toggle,
│       │                       #   DPI scaling + image smoothing [S13 F4]
│       ├── ShopScreen.js       # ~400 LOC — 21 working upgrades (incl. 3 salvage
│       │                       #   + MPD thruster), purchase flash, level badges,
│       │                       #   requiresAll prerequisite support [S13 F16]
│       ├── DebrisTextureAtlas.js # Procedural 6-type Canvas2D texture atlas
│       │                       #   [Epic 6 ST-6.2]
│       ├── FlagDecalSystem.js  # 15-country flag atlas for debris decals
│       │                       #   [Epic 6 ST-6.2]
│       ├── TeachingOverlay.js  # Non-blocking DOM overlay with fade + queue
│       │                       #   [Epic 6 ST-6.5]
│       ├── StrategicMap.js     # 925 LOC — 3-D strategic overview map (Shift+V)
│       │                       #   wireframe Earth, altitude bands, debris dots,
│       │                       #   player marker, threat list [Epic 6 ST-6.4]
│       ├── DebugOverlay.js     # ~120 LOC — Ctrl+D toggleable FPS/frame time/
│       │                       #   entity count/WebGL stats [NEW Session 7 — Tier 5]
│       ├── VelocityStreaks.js   # ~200 LOC — Full-screen Canvas2D velocity streak
│       │                       #   overlay with radial streaks (blue prograde,
│       │                       #   red retrograde, white lateral). I-War heritage.
│       │                       #   [NEW Session 16 — FULL_HUD_STRATEGY Phase 4]
│       ├── BriefingScreen.js   # 357 LOC — Mission briefing + mission number + credits
│       ├── GameOverScreen.js   # 296 LOC — Win/loss + continue button + mission summary
│       └── MenuScreen.js       # 197 LOC — Translucent start menu + continue button
│
└── textures/
    ├── earth_day.jpg           # Standard quality day texture
    ├── earth_day_8k.jpg        # 8K day texture
    ├── earth_day_16k.jpg       # 16K day texture (high-end)
    ├── earth_night.jpg         # Standard quality night/city lights
    ├── earth_night_8k.jpg      # 8K night texture
    ├── earth_night_16k.jpg     # 16K night texture
    ├── earth_clouds.jpg        # Standard quality clouds
    └── earth_clouds_8k.jpg     # 8K cloud texture
```

> **Test directory** (`js/test/`): [`TestRunner.js`](js/test/TestRunner.js) micro-framework, [`run-tests.js`](js/test/run-tests.js) CLI runner, 32 test files, **272 suites / 1,252 tests** — including `test-Constants`, `test-EventBus`, `test-OrbitalMechanics`, `test-GameState`, `test-ScoringSystem`, `test-PowerDistribution`, [`test-Crossbow-Constants`](js/test/test-Crossbow-Constants.js), [`test-Crossbow-ArmUnit`](js/test/test-Crossbow-ArmUnit.js), [`test-CollisionAvoidance`](js/test/test-CollisionAvoidance.js), [`test-AutopilotSystem`](js/test/test-AutopilotSystem.js), [`test-SkillsSystem`](js/test/test-SkillsSystem.js), [`test-LassoSystem`](js/test/test-LassoSystem.js), [`test-BolasVisuals`](js/test/test-BolasVisuals.js), [`test-no-tutorial-legacy`](js/test/test-no-tutorial-legacy.js), [`test-hud-activate-keys`](js/test/test-hud-activate-keys.js), [`test-DebrisMap`](js/test/test-DebrisMap.js), [`test-MissionProfiles`](js/test/test-MissionProfiles.js), [`test-MissionEvents`](js/test/test-MissionEvents.js), [`test-EarthLOD`](js/test/test-EarthLOD.js), [`test-CameraFOV`](js/test/test-CameraFOV.js), [`test-NavSphere`](js/test/test-NavSphere.js), [`test-TrailSystem`](js/test/test-TrailSystem.js), [`test-CommsSystem`](js/test/test-CommsSystem.js), [`test-CommsPanel`](js/test/test-CommsPanel.js), [`test-RadialMenu`](js/test/test-RadialMenu.js), [`test-TRL`](js/test/test-TRL.js), [`test-CatalogLoader`](js/test/test-CatalogLoader.js), [`test-ConjunctionGating`](js/test/test-ConjunctionGating.js), [`test-ConjunctionMOID`](js/test/test-ConjunctionMOID.js), [`test-DebrisTextureAtlas`](js/test/test-DebrisTextureAtlas.js), [`test-DebrisVisuals`](js/test/test-DebrisVisuals.js), [`test-MoidCalculator`](js/test/test-MoidCalculator.js), [`test-TeachingSystem`](js/test/test-TeachingSystem.js), [`test-EnvironmentSystem`](js/test/test-EnvironmentSystem.js), [`test-StrategicMap`](js/test/test-StrategicMap.js), [`test-StationKeep`](js/test/test-StationKeep.js), [`test-FEEPMetals`](js/test/test-FEEPMetals.js), [`test-NewsEvents-epic8`](js/test/test-NewsEvents-epic8.js), [`test-CodexISRO`](js/test/test-CodexISRO.js).

### Key Differences from Original Plan

| Planned | Actual | Reason |
|---------|--------|--------|
| Separate `css/` directory | Inline styles / HUD.js DOM creation | Simpler for zero-build-tool approach |
| `assets/` directory for textures | `textures/` at project root | Flatter structure |
| `shaders/` directory with `.vert`/`.frag` files | Inline GLSL in JS files | Avoided cross-origin issues with file:// serving |
| `GameLoop.js` separate file | Game loop lives in [`main.js`](js/main.js) | Kept tightly coupled with init logic |
| `InputManager.js` separate file | [`InputManager.js`](js/systems/InputManager.js) extracted (Session 7) | Originally in main.js; extracted in Tier 5 code quality pass |
| Monolithic main.js (1,209 LOC) | [`GameFlowManager.js`](js/systems/GameFlowManager.js) (857 LOC) + thin [`main.js`](js/main.js) (488 LOC) | Session 9: state transitions, event wiring, save/load extracted |
| No power management | [`PowerDistribution.js`](js/systems/PowerDistribution.js) (220 LOC) | Session 9: FS2-heritage ETS with 3 buses, keyboard control |
| `PlayerShip.js` entity | [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) | Renamed to match V3 Octopus design |
| `DaughterSatellite.js` only | [`ArmUnit.js`](js/entities/ArmUnit.js) + [`ArmManager.js`](js/entities/ArmManager.js) | V3 Octopus arm system replaced daughter sat |
| `PostProcessing.js` separate | Integrated into [`SceneManager.js`](js/scene/SceneManager.js) | Post-processing tightly coupled to renderer |
| `CameraController.js` in scene/ | [`CameraSystem.js`](js/systems/CameraSystem.js) in systems/ | Camera is a system, not a scene element |
| No NavSphere | [`NavSphere.js`](js/ui/NavSphere.js) (478 LOC) | Added per I-War design analysis |
| Monolithic systems in main.js | Extracted to `ResourceSystem`, `SensorSystem`, `KesslerSystem` | Sprint 4A extraction |
| No wireframe analysis | [`DebrisWireframe.js`](js/ui/DebrisWireframe.js) (783 LOC) | FS2-heritage target assessment (Tier 2) |
| No manual arm piloting | [`DockingReticle.js`](js/ui/DockingReticle.js) (555 LOC) + ARM_PILOT camera | Orbiter-heritage docking (Tier 3) |
| No persistence | [`PersistenceManager.js`](js/systems/PersistenceManager.js) (146 LOC) | localStorage save/load (Tier 4A) |

### Module Dependency Flow (Actual)

```
main.js (thin bootstrap + game loop — ~520 LOC)
  ├── systems/GameFlowManager.js ← state transitions, 26 EventBus handlers, save/load, reset
  │
  ├── core/Constants.js          ← imported by ALL modules
  ├── core/EventBus.js           ← used by ALL modules
  ├── core/Events.js             ← event name constants (100% migrated)
  ├── core/GameState.js          ← FSM with SHOP state
  │
  ├── systems/InputManager.js    ← ALL keyboard handling (WASD command cluster, arrows→rotation, +/-→throttle, `→tool cycle, L→codex)
  │     └── browser keydown/keyup events → game actions via EventBus
  ├── systems/PowerDistribution.js ← FS2 ETS: 3 buses, multiplier curves, [ ] keys
  ├── systems/AutopilotSystem.js ← 4-tier heading, slerp rotation, approach-from-behind,
  │                                 tool-aware arrival, locked target, phase correction [S23]
  │
  ├── scene/SceneManager.js      ← creates renderer, scene, composer
  │     ├── scene/Earth.js       ← 3-layer Earth rendering
  │     ├── scene/Starfield.js   ← background stars + depthTest constellation lines
  │     └── scene/SunLight.js    ← sun, moon, lens flares + depth mask meshes
  │
  ├── entities/PlayerSatellite.js ← octagonal bus + thrust + rotation + throttle + RCS puffs + MPD
  │                                 + scan flash (SCAN_INITIATED → cyan glow) [S23]
  │     └── entities/ArmManager.js ← fleet of 8 ArmUnits + dual-fire + pulse scan
  │           └── entities/ArmUnit.js ← 20-state arm + crossbow spring physics
  │
  ├── entities/CatalogConverter.js ← converts /data/ JSON → DebrisField format [Epic 6 ST-6.1]
  ├── entities/DebrisField.js    ← instanced debris management + lithium salvage
  │                                 + catalog hybrid merge + atlas materials [S23, Epic 6]
  ├── entities/ActiveSatellite.js ← protected satellites
  ├── entities/OrbitalMechanics.js ← Kepler propagation
  │
  ├── systems/CameraSystem.js    ← 5-view camera (incl. ARM_PILOT)
  ├── systems/ResourceSystem.js  ← SOLE resource authority + panel degradation + lithium
  ├── systems/ScoringSystem.js   ← points + credits + multipliers + serialize/restore
  ├── systems/SensorSystem.js    ← sensor range + reveal + applyUpgrade + SCAN_INITIATED event [S23]
  ├── systems/KesslerSystem.js   ← fragment generation + shield hits + applyUpgrade
  ├── systems/CommsSystem.js     ← FS2 comms menu
  ├── systems/AudioSystem.js     ← 30+ generators + ambient loop + ΔV alarm tiers
  │                                 + scan/cashRegister/APArrived/APDisengage [S23]
  │                                 + target lock/lost + lasso fire/denied/reel
  ├── systems/ForgeSystem.js     ← forge toggle + state cycling (R key)
  ├── systems/CollisionAvoidanceSystem.js ← 4 Hz scan, RCS dodge, target/arm exempt [S19]
  ├── systems/CatalogLoader.js   ← /data/*.json offline catalog loader [Epic 6 ST-6.1]
  ├── systems/ActiveSatGuard.js  ← prevents capture of active sats [Epic 6 ST-6.1]
  ├── systems/MoidCalculator.js  ← 8-pt sampled MOID + HI/MD/LO badges [Epic 6 ST-6.3]
  ├── systems/TeachingSystem.js  ← 15 contextual teaching moments [Epic 6 ST-6.5]
  ├── systems/EnvironmentSystem.js ← AO/MMOD/radiation/safe-mode [Epic 6 ST-6.7]
  ├── systems/PersistenceManager.js ← localStorage save/load
  ├── systems/TargetSelector.js  ← target selection + auto-tool recommendation + focus action
  │
  ├── ui/HUD.js                  ← HUD coordinator (progressive luminance + tech library badge)
  │     ├── ui/hud/StatusPanel.js  ← PROPULSION / ENERGY / FLEET panels (data-hud-group)
  │     ├── ui/hud/TargetPanel.js  ← target list, transfer costs (data-hud-group)
  │     ├── ui/hud/CommsPanel.js   ← comms menu, credits, ground comms (always visible)
  │     └── ui/NavSphere.js        ← 3D radar + I-War stalks (top-right, N toggle)
  ├── ui/VelocityStreaks.js      ← Canvas2D radial streak overlay (I-War heritage) [S16]
  ├── ui/CodexViewerUI.js        ← tech library browser (L key, DOM overlay, 105 entries)
  ├── ui/DebugOverlay.js         ← Ctrl+D FPS/frame time/entity/WebGL stats
  ├── ui/OrbitMFD.js             ← orbit visualization (bottom-right, M toggle)
  ├── ui/TargetReticle.js        ← brackets + velocity markers + lead indicator
  │                                 + lock-on animation + cooldown arc + AP indicator [S16]
  ├── ui/DebrisWireframe.js      ← wireframe analysis panel (Z key cycle)
  ├── ui/DockingReticle.js       ← ARM PILOT crosshair overlay + proximity beeps [S16]
  ├── ui/DebrisTextureAtlas.js   ← procedural 6-type Canvas2D atlas [Epic 6 ST-6.2]
  ├── ui/FlagDecalSystem.js      ← 15-country flag atlas for debris [Epic 6 ST-6.2]
  ├── ui/TeachingOverlay.js      ← non-blocking contextual overlays [Epic 6 ST-6.5]
  ├── ui/StrategicMap.js         ← 925 LOC 3-D strategic map (Shift+V) [Epic 6 ST-6.4]
  ├── ui/MenuScreen.js           ← start menu + continue button
  ├── ui/BriefingScreen.js       ← mission briefing + mission number
  ├── ui/ShopScreen.js           ← 21 upgrades + purchase feedback (MPD + prereqs)
  └── ui/GameOverScreen.js       ← win/loss + continue + mission summary
```

All modules use ES6 `import`/`export`. The HTML uses `<script type="module" src="js/main.js">`.

---

## 2. Technology Stack & CDN Links

| Technology | Purpose | CDN / Source |
|---|---|---|
| Three.js r170 | 3D rendering engine | `https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js` |
| Three.js Addons | EffectComposer, UnrealBloomPass, SMAAPass, ShaderPass | `https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/` |
| Web Audio API | Sound effects & ambience | Native browser API |
| localStorage | Save/load game state | Native browser API |
| CSS Custom Properties | Theming & HUD styling | Native CSS |

### Three.js Addon Imports (via import maps in index.html)

```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
  }
}
</script>
<script type="module" src="js/main.js"></script>
```

### Required Addons (as-used)

- `three/addons/postprocessing/EffectComposer.js`
- `three/addons/postprocessing/RenderPass.js`
- `three/addons/postprocessing/UnrealBloomPass.js`
- `three/addons/postprocessing/SMAAPass.js`
- ~~`three/addons/controls/OrbitControls.js`~~ — **removed** (Session 3, Phase 0). Camera is fully managed by custom [`CameraSystem.js`](js/systems/CameraSystem.js).

**Note:** GLTFLoader from the original plan is **not used**. All models are procedural geometry (no GLTF files).

### Earth Textures (Free, Public Domain)

| Texture | Resolution | Source |
|---|---|---|
| Blue Marble day | 8K / 16K | NASA Visible Earth |
| Night lights | 8K / 16K | NASA Black Marble |
| Cloud layer | 8K | NASA cloud composite |

Textures are in `textures/` directory at project root. [`Earth.js`](js/scene/Earth.js) uses [`getTextureQuality()`](js/scene/Earth.js) to adaptively select texture resolution based on device capabilities (GPU memory, Apple GPU detection).

---

## 3. Game State Machine

### Current Startup Flow (Simplified)

The original plan had a complex multi-state flow (LOADING → MAIN_MENU → LOADOUT_SELECTION → BRIEFING → ...). The current implementation streamlines this:

```
                    ┌──────────────┐
                    │   LOADING    │
                    │ (textures,   │
                    │  init scene) │
                    └──────┬───────┘
                           │ assets ready
                           ▼
                    ┌──────────────┐
                    │  MAIN_MENU   │  Translucent overlay —
                    │ (MenuScreen) │  "Continue" button if save exists
                    └──────┬───────┘
                           │ "Start" / "Continue"
                           ▼
                    ┌──────────────┐
                    │ ORBITAL_VIEW │  ← Direct to gameplay!
                    │ (gameplay)   │  No briefing/debris selection gate
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
       Every 5 debris   Win at 50   Fuel out / collision
              │            │            │
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │   SHOP   │ │   WIN    │ │GAME_OVER │
        │(ShopScr) │ │(GameOver)│ │(GameOver)│
        └────┬─────┘ └──────────┘ └────┬─────┘
             │ "Deploy"                 │ "Continue" (50% credit penalty → SHOP)
             ▼                          │ "Retry" (→ MENU)
        ┌──────────┐                    │
        │ BRIEFING │◄───────────────────┘
        └────┬─────┘
             │ "Commence"
             ▼
        ORBITAL_VIEW
```

**Key design decisions:**
- Menu "Start" goes directly to ORBITAL_VIEW, skipping briefing. "Continue" loads saved progress.
- **SHOP state** triggers every 5 debris cleared. Simulation pauses during shop.
- **Roguelite continue:** GAME_OVER → SHOP with 50% credit penalty → BRIEFING → retry.
- [`GameState.js`](js/core/GameState.js) defines 8 states: MENU, BRIEFING, ORBITAL_VIEW, APPROACH, INTERACTION, SHOP, GAME_OVER, WIN.

### In-Game Key Bindings

#### WASD Command Cluster (Session 22 — Autopilot-First Redesign)

| Key | Normal Mode | ARM PILOT Mode (P key) | Mnemonic |
|-----|-------------|------------------------|----------|
| **A** | Autopilot toggle | Arm thrust left | **A**utopilot |
| **S** | Quick Scan (1.5s ping, $50, 20% discovery) | Arm thrust back | **S**can |
| **W** | Wide Scan (4s deep, $150, 40% discovery) | Arm thrust forward | **W**ide aperture |
| **D** | Deploy recommended tool | Arm thrust right | **D**eploy |

> **WASD mothership thrust REMOVED** from normal play. Autopilot handles all navigation. WASD is thrust only in ARM PILOT mode (P key). Arrow key rotation rate: 0.3 → 0.08 rad/s (realistic for 500 kg satellite).

#### Essential Companion Keys (Session 22)

| Key | Action |
|-----|--------|
| `` ` `` (backtick) | Cycle tool alternatives (MW2-style weapon scroll) — was autopilot toggle (S21) |
| F | Focus Action — context-sensitive smart button (no target → Tab, has target → deploy) |

#### Full Key Reference

| Key | Action |
|-----|--------|
| ↑/↓ | Pitch satellite (rotate up/down) — 0.08 rad/s (Session 22, was 0.3) |
| ←/→ | Yaw satellite (rotate left/right) — 0.08 rad/s |
| +/= | Increase thrust level (+10%) — Session 13 F14 |
| - | Decrease thrust level (−10%) — Session 13 F14 |
| Tab | Cycle target selection (auto-recommends best tool) |
| G | Deploy capture arm to selected target (secondary to D) |
| H | Recall all deployed arms |
| Space | Cast lasso — or deploy net in ARM PILOT |
| R | Cycle forge mode: OFF → REFINE → PROPELLANT → OFF (Session 11) |
| L | Open Tech Library (105-entry encyclopedia) — Session 13 F17, expanded V6 |
| X | Tether detach — free-flying arm sacrifice (V6 Session 18) |
| V | Cycle camera view (COMMAND → TACTICAL → OVERVIEW) |
| P | Toggle ARM PILOT mode (40° FOV, arm camera, not in V-cycle) — WASD becomes arm thrust |
| B | Open shop |
| Z | Cycle wireframe zone forward (FS2 subsystem targeting — works on ADR satellite + debris) |
| Shift+Z | Cycle wireframe zone backward |
| C | Toggle comms menu (FS2-style 1–6 numbered commands) |
| Shift+1/2/3 | Select power bus (Thrust / Sensors / Arms) |
| [ / ] | Adjust power allocation ±10% on selected bus |
| M | Toggle Orbit View panel |
| N | Toggle NavSphere |
| Ctrl+D | Debug overlay |
| Ctrl+Shift+D | Deorbit sacrifice (arm burns all fuel retrograde) |
| Esc | Pause |

---

## 4. Rendering Pipeline

### Current Pipeline: Single-Composer Threshold Bloom

The rendering pipeline went through two architectures during this session:

**V1 (Sprint 1, removed):** Dual-composer selective bloom — a `bloomComposer` for layer-1 objects + a `finalComposer` with additive composite shader + SMAA. This consumed **21 render passes × 120Hz = 50% GPU** on M4 Max and was replaced.

**V2 (Current, Fix 1):** Single-composer with threshold-based bloom. Much simpler, much faster:

```
WebGLRenderer (ACES Filmic tone mapping, no MSAA, no shadows)
  │
  └── EffectComposer
        ├── RenderPass (main scene)
        ├── UnrealBloomPass
        │   ├── threshold: 0.85    ← Only very bright objects bloom
        │   ├── strength: 0.4
        │   ├── radius: 0.4
        │   └── resolution: half-res (performance)
        └── SMAAPass              ← Anti-aliasing (software, not hardware MSAA)
```

### Renderer Configuration

```javascript
// SceneManager.js
renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,           // SMAA used instead of hardware MSAA
    logarithmicDepthBuffer: true // Required — scene spans ~8 orders of magnitude
});
renderer.toneMapping = THREE.ACESFilmicToneMapping;  // Changed from AgX
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = false;  // Disabled for performance
```

### Frame Rate Cap

[`main.js`](js/main.js) implements a 60fps frame cap:

```javascript
const TARGET_FPS = 60;
const FRAME_INTERVAL = 1000 / TARGET_FPS;  // 16.67ms
```

This prevents the render loop from running at monitor refresh rate (120Hz on ProMotion displays), halving GPU work.

### Why These Decisions Were Made

| Decision | Reason |
|---|---|
| Threshold bloom over selective bloom | 21 passes at 120Hz caused 50% GPU usage |
| ACES Filmic over AgX | AgX washed out surface detail; ACES preserves contrast |
| SMAA over hardware MSAA | MSAA is expensive with logarithmic depth buffer |
| Shadows disabled | Shadow maps doubled draw calls for marginal visual benefit |
| 60fps cap | M4 Max ProMotion is 120Hz; no visual benefit for a space game at double the cost |

---

## 5. Camera System

### Architecture

[`CameraSystem.js`](js/systems/CameraSystem.js) (776 LOC) implements **5 camera views** — 3 in the V-key cycle (COMMAND, TACTICAL, OVERVIEW) plus ARM_PILOT (P key) and COCKPIT (API only).

### View Cycle Order (Actual)

`V` key cycles: **COMMAND → TACTICAL → OVERVIEW → COMMAND** (3 views)

| View | Label | Description | Toggle |
|------|-------|-------------|--------|
| CHASE | 🛰 COMMAND | Default chase camera behind player | V cycle |
| TARGET_LOCK | 🔒 TACTICAL | Frames both player and target — auto-activates on arm deploy | V cycle |
| ORBIT | 🌍 OVERVIEW | Wide orbital view with mouse drag | V cycle |
| ARM_PILOT | 🤖 ARM PILOT | Follows arm toward target, 40° narrow FOV | P key (dedicated) |
| FIRST_PERSON | 🎯 COCKPIT | Not in cycle (available via direct API) | — |

**ARM_PILOT view details** (Tier 3):
- Activated via [`setArmPilotTarget(arm)`](js/systems/CameraSystem.js:537) — narrows FOV from 60° → 40°
- Camera follows arm position, looking toward target debris
- Exited via [`clearPilotArm()`](js/systems/CameraSystem.js:548) — restores FOV, returns to CHASE
- Not in V-cycle — dedicated P key toggle only
- [`_computeArmPilot()`](js/systems/CameraSystem.js:568) positions camera behind arm with configurable offset

Auto-transitions:
- `arm:deployed` → TACTICAL (if currently in COMMAND)
- `arm:returned` (captured) → COMMAND after 2s delay

### VIEW_INFO_LEVELS

Each view defines which HUD elements are visible, implementing MW2-style progressive information disclosure:

```javascript
// Actual property names from HUD.js (lines 16-51):
const VIEW_INFO_LEVELS = {
    FIRST_PERSON: { showTargetList: true,  showResources: true,  showNavSphere: true,  showComms: true,  showArms: true,  hudOpacity: 1.0  },
    CHASE:        { showTargetList: true,  showResources: true,  showNavSphere: true,  showComms: false, showArms: true,  hudOpacity: 0.85 },
    TARGET_LOCK:  { showTargetList: false, showResources: true,  showNavSphere: true,  showComms: false, showArms: true,  hudOpacity: 0.85 },
    ORBIT:        { showTargetList: false, showResources: false, showNavSphere: false, showComms: false, showArms: false, hudOpacity: 0.6  },
    ARM_PILOT:    { showTargetList: false, showResources: true,  showNavSphere: false, showComms: true,  showArms: true,  hudOpacity: 0.9  },
};
// Note: ARM_PILOT shows resources + arms + comms (need comms during manual pilot).
// ORBIT shows almost nothing (the view IS the information).
```

### Transition System

View changes use smooth lerp transitions (camera position + quaternion interpolation over ~0.5s). The system emits `camera:viewChange` events via the EventBus so HUD elements can fade in/out.

### Key Bug Fix: 90° Roll on View Switch

**Root cause:** When leaving ORBIT view after the user had mouse-dragged theta away from π, the orbit camera's x-axis rotated to `velDir` (instead of `lateral`). The transition lerp captured this rolled state.

**Fix in [`CameraSystem.js`](js/systems/CameraSystem.js):**
1. Fixed `camera.up` before `lookAt()` in all 5 code paths
2. Added `_lastVelDir` caching to avoid frame-to-frame jitter
3. `setView()` now uses canonical theta=π departure point when leaving orbit
4. Fixed TARGET_LOCK 85%/15% weighting, resolved vector mutation bug
5. Added TARGET_LOCK scroll zoom

---

## 6. Class & Module Design

### 6.1 Core Modules

#### [`EventBus`](js/core/EventBus.js)

Singleton pub/sub. All inter-module communication goes through here.

**Key Events in Use:**

| Event Name | Payload | Emitted By |
|---|---|---|
| `camera:viewChange` | `{ view, infoLevel }` | CameraSystem |
| `arm:deployed` | `{ armId, targetId }` | ArmManager |
| `arm:stateChange` | `{ armId, state }` | ArmUnit |
| `target:selected` | `{ debrisId }` | InputManager (Tab key) |
| `resource:changed` | `{ resource, value, delta }` | ResourceSystem |
| `score:update` | `{ total, credits, delta, debrisCleared }` | ScoringSystem |
| `upgrade:purchased` | `{ id, effect, value, level }` | ShopScreen |
| `shop:deploy` | — | ShopScreen (Deploy button) |
| `gameover:continue` | — | GameOverScreen (Continue button) |
| `persistence:saved` | `{ timestamp }` | PersistenceManager |
| `persistence:loaded` | `{ timestamp }` | PersistenceManager |
| `forge:toggle` | `{ mode }` | InputManager (R key) / ForgeSystem |
| `deltav:update` | `{ dvPct, predictedPct, solarRate, batteryPct }` | StatusPanel |
| `throttle:change` | `{ level }` | InputManager (+/- keys) |
| `autopilot:engage` | `{ headingTarget, throttleLevel }` | AutopilotSystem |
| `autopilot:disengage` | `{ reason }` | AutopilotSystem |
| `mpd:fire` | `{ thrustN, lithiumFlow }` | PlayerSatellite |
| `mpd:cathodeWorn` | `{ remainingLife }` | PlayerSatellite |
| `lithium:change` | `{ value, delta }` | ResourceSystem |

All event name strings are defined as constants in [`Events.js`](js/core/Events.js) (~418 LOC). As of Session 9, **100% of event strings** use `Events.*` constants — zero raw strings remain. Session 10 added: `SALVAGE_RECOVERED`, `SALVAGE_SCAN`, `ARM_DEORBIT`, `ARM_REFUELED`, `ARM_DEORBIT_CMD`. Session 11 added: `FORGE_TOGGLE`, `DELTAV_UPDATE`. Session 13 added: `THROTTLE_CHANGE`, `AUTOPILOT_ENGAGE`, `AUTOPILOT_DISENGAGE`, `MPD_FIRE`, `MPD_CATHODE_WORN`, `LITHIUM_CHANGE`. Session 19 (_refs decoupling) added: `PERSISTENCE_GATHER`, `COLLISION_GAME_OVER`, `WIREFRAME_ASSESSED`. Session 19 (CA) added: `CA_THREAT_DETECTED`, `CA_DODGE_EXECUTED`, `CA_THREAT_CLEARED`, `CA_TOGGLED`, `CA_SUPPRESSED`. Session 20 (Tutorial Overhaul) added: `TUTORIAL_WASD_INPUT`. Session 21 added: `LASSO_MISSED`. Session 22 (Control Redesign) added: `SCAN_PING`, `SCAN_WIDE_START`, `SCAN_WIDE_COMPLETE`, `SCAN_WIDE_CANCELLED`, `SCAN_DISCOVERY`, `TOOL_RECOMMENDED`, `TOOL_CYCLED`. Epic 5 added: `PLAYER_TRAIL_SAMPLE`, `ARM_TRAIL_SAMPLE`, `ARM_TRAIL_CLEAR`, `COMMS_FOCUS`, `COMMS_RADIAL_OPEN`, `COMMS_RADIAL_CLOSE`, `COMMS_SCROLL_UP`, `COMMS_SCROLL_DOWN`. Epic 6 added: `CATALOG_LOADED`, `ACTIVE_SAT_WARNING`, `MOID_UPDATED`, `TEACHING_MOMENT`, `TEACHING_DISMISSED`, `ENVIRONMENT_HAZARD`, `SAFE_MODE_ENTER`, `SAFE_MODE_EXIT`, `SHOP_OPENED`, `STRATEGIC_MAP_OPEN`, `STRATEGIC_MAP_CLOSE`, `STRATEGIC_MAP_SELECT`.

#### [`Constants.js`](js/core/Constants.js)

All tuning knobs centralized. Major constant groups:

| Group | Count | Purpose |
|---|---|---|
| Physical constants | ~15 | MU_EARTH, EARTH_RADIUS_KM, J2, G0, etc. |
| Scene scale | ~8 | SCENE_SCALE, EARTH_RADIUS, CAMERA_NEAR/FAR |
| Rendering | ~10 | Bloom strength 0.4, ambient 0.02, tone mapping |
| V3 Octopus core | ~20 | OCTOPUS_CORE_* (bus dimensions, mass, solar area) |
| Weaver arm | ~15 | WEAVER_* (arm lengths, mass, FEEP thrust, net count) |
| Spinner arm | ~15 | SPINNER_* (flywheel mass, torque, spin rate) |
| Tether system | ~10 | TETHER_* (length, strain limit, sag parameters) |
| Docking | ~10 | DOCK_* (port dimensions, EPM force, homing beacon) |
| ARM_STATES | 20 | 14 original + V5: LAUNCHING, REELING, RELOADING, ABLATING, SCANNING, TANGLED |
| Salvage system | ~30 | SALVAGE_PROB_*, amounts, INDIUM_FULL_TANK_*, scoring |
| Deorbit sacrifice | ~6 | DEORBIT_MULTIPLIER_*, thresholds |
| **MPD thruster** | ~12 | THRUST_N (25), ISP (3000), POWER_DRAW_KW (150), PROPELLANT_FLOW_RATE, CATHODE_LIFE_S (600), DEGRADED_THRUST_MULT (0.6), SHOP_COST, SHOP_PREREQS, CATHODE_UPGRADE_* [Session 13 F16] |
| **Salvage lithium** | ~3 | SALVAGE_LITHIUM probability (0.08), amountRange [0.5, 3.0] [Session 13 F16] |
| **HUD** | ~8 | COLORS (5-color system: Green `#00ff88`, Amber `#ffaa00`, Red `#ff4444`, Blue `#4488ff`, White `#ccddcc`), THRESHOLDS (30%/15%), PANEL_WIDTH (220px), LABEL_WIDTH (42px) |
| **AUDIO** | ~6 | Gain levels (sfxBus, master), EARCON_FREQUENCIES for 6 new earcons |
| **V5 Crossbow** | 42 | Spring physics (8), reload (5), reel (7), dual-fire (4), pulse scan (4), ablation (4), arm config (5), tangle (3), spring tiers (array), tether tiers (array) |
| **TRL** | ~10 | Tier thresholds (1–9), TRL badge display config [Epic 6 ST-6.6] |
| **CATALOG** | ~12 | Base path, file names, offline catalog loading config [Epic 6 ST-6.1] |
| **CONJUNCTION.MOID_*** | ~8 | MOID badge thresholds (HI/MD/LO/SAFE), recompute cadence, sample counts [Epic 6 ST-6.3] |
| **DEBRIS_VISUAL** | ~12 | Atlas size, type textures, flag decal config [Epic 6 ST-6.2] |
| **TEACHING** | ~13 | Overlay width, display durations, max queue, localStorage key [Epic 6 ST-6.5] |
| **ENVIRONMENT** | ~26 | AO erosion, MMOD flux/probability, radiation belt, safe-mode, battery DOD [Epic 6 ST-6.7] |
| **STRATEGIC_MAP** | ~30 | Camera FOV, altitude bands, dot sizes/colors, MOID pulse speed, legend config [Epic 6 ST-6.4] |

### 6.2 Scene Modules

#### [`SceneManager`](js/scene/SceneManager.js) (~250 LOC)

Creates renderer with logarithmic depth buffer, sets up single-composer bloom pipeline (§4), handles resize. No longer manages camera (that's CameraSystem).

#### [`Earth`](js/scene/Earth.js) (~400 LOC)

Three-layer Earth rendering:

| Layer | Geometry | Material | Notes |
|---|---|---|---|
| Surface | Sphere 256 segments | Custom GLSL (day/night blend + specular) | Ratio-based ocean detection + Fresnel |
| Clouds | Sphere 128 segments | Alpha-mapped texture | 8K resolution, ClampToEdgeWrapping |
| Atmosphere | Sphere 128 segments, BackSide | Additive Fresnel shader | Power 5.5, intensity 1.4, **removed from bloom layer** |

**Adaptive texture quality** via `getTextureQuality()`:
- Checks `navigator.deviceMemory` (defaults to 8 on Safari where it's undefined)
- Detects Apple GPUs via `renderer.getContext().getParameter(RENDERER)`
- Returns `'16k'`, `'8k'`, or `'4k'` based on available VRAM

**Safari fix:** `wrapS = RepeatWrapping` caused an antimeridian seam → changed to `ClampToEdgeWrapping`.

#### [`SunLight`](js/scene/SunLight.js) (~300 LOC)

| Feature | Implementation |
|---|---|
| Sun disc | `THREE.Sprite` with 64×64 canvas radial gradient, additive blending |
| Lens flares | 3 sprites at varying positions between sun and camera center |
| Auto-exposure | Based on `dot(cameraForward, sunDirection)` — floor 0.8, ceiling 1.3 |
| Moon | Sprite with phase calculation from sun-moon angle, 0.5° angular size |

#### [`Starfield`](js/scene/Starfield.js)

Point-based star rendering with brightness variation.

### 6.3 Entity Modules

#### [`PlayerSatellite`](js/entities/PlayerSatellite.js) (~1,267 LOC)

V3 Octopus design — 8-sided octagonal prism main bus:
- 6 docking cavities (hexagonal arrangement) with LED homing beacons
- Laser aperture ring on forward face
- Solar panel wings
- All procedural geometry (no GLTF models)
- [`applyUpgrade(data)`](js/entities/PlayerSatellite.js) — applies shop upgrades (thrust, xenon efficiency)
- Routes `resource:consume` events to ResourceSystem

#### [`ArmManager`](js/entities/ArmManager.js) (~700 LOC)

8-arm fleet coordinator with dual-fire recoil cancellation, pulse scan orchestration, and fleet upgrade management:
- 3 Weaver arms (11→6.6 kg, net-based capture) + 3 Spinner arms (3.7→2.1 kg, gecko pad secondary)
- 1 Front (prograde spinner) + 1 Back (retrograde spinner, thruster interlock)
- **Dual-fire coordination** — opposite arm pairs (0↔3, 1↔4, 2↔5, 6↔7) cancel recoil momentum
- **Pulse scan** — "jellyfish pulse" fires all arms as distributed sensor array (30s cooldown)
- **Fleet upgrade management** — applies spring tier + tether tier upgrades across all arms
- **Tsiolkovsky ΔV mass budget** calculation (wet mass, dry mass, arm mass, captured debris mass)
- **Stored upgrades** — persists upgrade data so upgrades survive `reset()` across missions
- [`applyUpgrade(data)`](js/entities/ArmManager.js) — applies spring tier, tether tier, reel speed, capture rate upgrades

#### [`ArmUnit`](js/entities/ArmUnit.js) (~1,300 LOC)

20-state autonomous arm with V5 crossbow spring physics, zero-fuel reel-in, ablation laser, and tangle resolution. This is the most complex entity in the codebase.

**20-State Machine (V5):**

```
DOCKED → LAUNCHING → TRANSIT → APPROACH → NETTING → GRAPPLED → REELING → DOCKING → RELOADING → DOCKED
                                    ↓                                                      ↓
                               ABLATING (de-spin)                                     DOCKED (ready)
                                    ↓
                               APPROACH
DOCKED → SCANNING (pulse scan, 2s)
DOCKED → FISHING (passive mode — arms set nets and wait)
Any transit → TANGLED (8s auto-resolution with slack pulses)
Any state → DEORBITING → EXPENDED (arm + debris removed)
```

V5 additions (6 new states): LAUNCHING, REELING, RELOADING, ABLATING, SCANNING, TANGLED. Replaces UNDOCKING (→LAUNCHING) and HAULING (→REELING).

| Feature | Implementation |
|---|---|
| Spring launch | Crossbow spring physics: E = ½kd², velocity from `CROSSBOW_LAUNCH_SPEED_DEFAULT` |
| Zero-fuel reel-in | Motor on mothership reels tether (1.4 m/s loaded), replaces FEEP HAULING |
| Tether | Catenary sag curve + tension-based coloring (green → yellow → red via `REEL_TENSION_WARNING/CRITICAL`) |
| Ablation laser | 10W laser for de-spin/nudge targets (up to 30s, `ABLATION_DESPIN_RATE`) |
| Tangle resolution | Auto-detection at 30° crossing angle, 8s resolution with slack pulses |
| Manual pilot mode | WASD controls arm in ARM_PILOT view (Tier 3) |
| Engineered auto-failure | At debris #10, auto-capture fails 70% — forces manual pilot discovery |
| Spring/tether tiers | 5 spring tiers (7.1–25 m/s) + 5 tether tiers (100–800N, 2–10km) |
| Deorbit sacrifice | `startDeorbit()` — one-way retrograde burn, arm + debris removed (Session 10) |

#### [`DebrisField`](js/entities/DebrisField.js) (~1,040 LOC)

Instanced mesh debris (800 interactive + 5,000 background), orbital propagation, spatial query cache. **Session 10:** Each debris now has `salvage` and `hasSalvage` properties generated by `_generateSalvage()` based on type/mass/material probability tables. Salvage types: Xenon (ion fuel), Indium (FEEP fuel), GaAs (solar panel repair), battery charge, hydrazine (hazmat). **Session 13 F16:** Lithium salvage added — 8% probability on defunct satellites, 0.5–3.0 kg per salvage event.

#### [`ActiveSatellite`](js/entities/ActiveSatellite.js), [`OrbitalMechanics`](js/entities/OrbitalMechanics.js)

Largely as originally planned — protected satellites, Kepler propagation.

### 6.4 System Modules

#### [`CameraSystem`](js/systems/CameraSystem.js) (776 LOC)

See §5 above for full camera system documentation including ARM_PILOT view.

#### [`ResourceSystem`](js/systems/ResourceSystem.js) (~340 LOC) — SOLE RESOURCE AUTHORITY

Canonical owner of all resource pools (xenon, cold gas, battery, lithium). One-way push to `PlayerSatellite.resources` via [`_syncToPlayer()`](js/systems/ResourceSystem.js:265). All consumption flows through EventBus → `ResourceSystem.consume()`.

| Method | Purpose |
|---|---|
| [`consume(resource, amount)`](js/systems/ResourceSystem.js:64) | Deduct resource, sync to player, emit event |
| [`replenish(resource, amount)`](js/systems/ResourceSystem.js:83) | Add resource (capped at max) |
| [`applyUpgrade(data)`](js/systems/ResourceSystem.js:199) | Handle shop upgrades: xenonMax, coldGasMax, batteryMax, solarEfficiency, panelDegradation |
| [`serialize()`](js/systems/ResourceSystem.js:128) | Save upgraded max capacities for persistence |
| [`restore(data)`](js/systems/ResourceSystem.js:141) | Restore maxes + refill for new mission |

**Session 13 F16:** Added lithium resource pool for MPD thruster propellant. `addLithium()`, `consumeLithium()`, lithium included in `serialize()`/`restore()`. Emits `LITHIUM_CHANGE` event.

#### [`ScoringSystem`](js/systems/ScoringSystem.js) (265 LOC)

Points calculation + credits economy + scoring multipliers:
- Base points by debris tier (100/300/800/2000)
- Tactical assessment bonus: **×1.3** (player assessed zones before capture)
- Manual capture bonus: **×2.0** (manually piloted arm to target)
- Fuel efficiency bonus: **×1.25** (gravity gradient approach)
- Max combined multiplier: **×3.25** (1.3 × 2.0 × 1.25)
- Credits = points (1:1 ratio); spent at shop via [`spendCredits(amount)`](js/systems/ScoringSystem.js:165)
- [`serialize()`](js/systems/ScoringSystem.js:206) / [`restore(data)`](js/systems/ScoringSystem.js:227) for persistence

#### [`PersistenceManager`](js/systems/PersistenceManager.js) (146 LOC) — NEW (Tier 4A)

localStorage-based save/load singleton. Stores cross-mission progress:

| Method | Purpose |
|---|---|
| [`save(data)`](js/systems/PersistenceManager.js:46) | Serialize credits, score, mission#, upgrades, resource maxes, stats |
| [`load()`](js/systems/PersistenceManager.js:82) | Parse save data with version check |
| [`hasSave()`](js/systems/PersistenceManager.js:109) | Quick check for valid save |
| [`deleteSave()`](js/systems/PersistenceManager.js:125) | Clear all save data |

Save key: `spacecowboy_save_v1`. Version: 1. Emits `persistence:saved` and `persistence:loaded` events.

#### [`InputManager`](js/systems/InputManager.js) (~520 LOC) — NEW (Tier 5, expanded Session 9, Session 13, Session 22)

Extracted from [`main.js`](js/main.js) in the Tier 5 code quality pass. Owns **all** keyboard event handling:
- **WASD command cluster (Session 22):** A = autopilot toggle, S = quick scan, W = wide scan, D = deploy recommended tool. Context-switched: WASD = arm thrust in ARM PILOT mode only.
- **Backtick = tool cycle (Session 22):** MW2-style weapon scroll through available arms/lasso/trawl. Was autopilot toggle (S21).
- **F = Focus Action (Session 22):** Context-sensitive smart button — no target → select nearest (Tab), has target → deploy, in ARM PILOT → net deploy.
- ARM PILOT input routing (WASD → FEEP thrust, Space → net deploy)
- Comms menu number key handling (1–5)
- Power bus selection (Shift+1/2/3) and adjustment ([ ] for ±10%)
- **Session 13 F13:** Arrow keys → `rotatePitch()`/`rotateYaw()` on PlayerSatellite (rate 0.08 rad/s, was 0.3)
- **Session 13 F14:** +/- keys → `setThrottleLevel()` on PlayerSatellite (graduated thrust 0–100%)
- **Session 13 F17:** L key → tech library viewer open/close
- **WASD mothership thrust REMOVED** from normal play (Session 22). Q/E vertical thrust unbound.
- Sits between browser events and game systems; dispatches actions via direct calls and EventBus

#### [`GameFlowManager`](js/systems/GameFlowManager.js) (~1,060 LOC) — NEW (Session 9, expanded Session 10, Session 13)

Extracted from [`main.js`](js/main.js) in the Session 9 code quality pass. Owns **all game flow logic**:
- **State transitions** — `transitionToState()` handles MENU → ORBITAL_VIEW → SHOP → BRIEFING → GAME_OVER → WIN
- **26 EventBus handlers** — arm return/deploy, shop triggers (every 5 debris), win/loss detection, upgrade routing, camera auto-transitions
- **Save/load orchestration** — coordinates PersistenceManager with ScoringSystem, ResourceSystem, ShopScreen, PowerDistribution
- **Game reset** — full state reset for retry/continue flows, roguelite 50% credit penalty
- **Upgrade routing** — dispatches `upgrade:purchased` events to 7+ target systems
- **Session 13 F16:** Lithium salvage processing — ARM_RETURNED handler recovers lithium from salvaged debris

Reduced [`main.js`](js/main.js) from 1,218 → 488 LOC (60% reduction). Main.js is now a thin bootstrap + game loop only.

#### [`PowerDistribution`](js/systems/PowerDistribution.js) (~220 LOC) — NEW (Session 9)

FS2-heritage Energy Transfer System (ETS) providing continuous tactical power allocation:

| Bus | Default | Effect | Wired To |
|-----|---------|--------|----------|
| THRUST | 40% | Ion drive efficiency; 0% = thrust blocked | [`PlayerSatellite`](js/entities/PlayerSatellite.js) `thrustIon()` |
| SENSORS | 30% | Detection range scaling | [`SensorSystem`](js/systems/SensorSystem.js) |
| ARMS | 30% | Arm deploy gate + beacon speed | [`ArmManager`](js/entities/ArmManager.js), [`ArmUnit`](js/entities/ArmUnit.js) |

- **Keyboard control:** Shift+1/2/3 select bus, [ ] adjust ±10% (was 1/2/3, changed S22 to avoid comms conflict)
- **Piecewise-linear multiplier curve:** 0% → 0.0×, 30% → 0.6×, 50% → 1.0×, 100% → 1.5×
- **Serialize/restore** for persistence across save/load cycles
- **HUD display:** 3 color-coded bars in [`StatusPanel`](js/ui/hud/StatusPanel.js) ("⚡ POWER ETS" panel)

#### [`AutopilotSystem`](js/systems/AutopilotSystem.js) (~200 LOC) — NEW (Session 13 F15, updated Session 22)

MW2-style autopilot providing course-keeping for the mothership:
- **4-tier heading priority:** (1) Tab-selected target debris → (2) active trawl cluster center → (3) nearest Tier 3–4 debris → (4) prograde (fallback)
- **ΔV safety:** Will not engage if remaining ΔV < 50 m/s; emergency disengage at < 30 m/s
- **Orbital-frame thrust:** Applies continuous low-thrust rotation corrections to align velocity vector with desired heading; pulses ion drive at the player's set throttle level
- **Disengage conditions:** A key toggle (Session 22, was backtick S21), arrow key manual override, ΔV safety threshold, target reached (within 200m), conjunction warning
- **Events:** Emits `AUTOPILOT_ENGAGE` and `AUTOPILOT_DISENGAGE` via EventBus
- **HUD integration:** [`StatusPanel`](js/ui/hud/StatusPanel.js) displays autopilot ON/OFF indicator, heading target name, and ETA
- **Tutorial gate:** Available from tutorial stage 4 (AUTOPILOT), was blocked until stage 8

#### Other Systems

| System | LOC | Responsibility |
|---|---|---|
| [`SensorSystem.js`](js/systems/SensorSystem.js) | ~340 | EO/IR/LIDAR range + reveal + [`applyUpgrade()`](js/systems/SensorSystem.js) + **active scan** (S/W key — ping cooldown, wide scan channel, discovery rolls, data overrides, survey rewards) [S22] |
| [`KesslerSystem.js`](js/systems/KesslerSystem.js) | 273 | Fragment generation + shield hits (Whipple Shield) + [`applyUpgrade()`](js/systems/KesslerSystem.js). Exported singleton. |
| [`CommsSystem.js`](js/systems/CommsSystem.js) | 616 | Message framework + FS2-style comms menu |
| [`AudioSystem.js`](js/systems/AudioSystem.js) | ~2049 | 30+ procedural generators + ambient loop + 4-tier ΔV alarm + sputtering + target lock/lost tones + lasso fire/denied/reel + docking proximity beeps + autopilot disengage [S16] |
| [`CollisionAvoidanceSystem.js`](js/systems/CollisionAvoidanceSystem.js) | ~290 | Semi-autonomous evasive manoeuvre: 4 Hz scan, TCA prediction, RCS dodge perpendicular to threat, active target + arm target exempt, ARM_PILOT suppress, trawl leniency, player override, cooldown, comms messages. 5 events. [S19 — CA AI] |
| [`ForgeSystem.js`](js/systems/ForgeSystem.js) | — | Forge toggle listener, `toggle()`, `_emitStateUpdate()` |
| [`TargetSelector.js`](js/systems/TargetSelector.js) | ~150 | Target selection + `setTarget()` context parameter + **auto-tool recommendation** (mass-based selection, `TOOL_RECOMMENDED` event on target change, backtick cycling via `TOOL_CYCLED`) + **focus action** (F-key context-sensitive handler). Exported singleton. [S22] |
| [`TrawlManager.js`](js/systems/TrawlManager.js) | — | Trawl sweep coordination, auto-start on `GAME_STATE_CHANGE`. Exported singleton. |

### 6.5 UI Modules

#### [`HUD`](js/ui/HUD.js) (~550 LOC) — Refactored (Tier 5, Session 11, codex Session 13, progressive luminance Session 16)

HUD coordinator — creates and manages three sub-panels. Reduced from 1,303 LOC to ~472 LOC in the Tier 5 split, updated in Session 11, 13, and 16:
- **Progressive luminance system** (Session 16) — `.hud-dormant` (opacity 0.3, saturate 0.3, pointer-events none) / `.hud-active` (opacity 1.0, saturate 1.0) CSS classes replace `display: none`. All panels visible from frame 1. [`setTutorialVisibility(stage)`](js/ui/HUD.js) activates `data-hud-group` elements as tutorial teaches them.
- **VIEW_INFO_LEVELS config** — per camera view HUD element visibility (includes ARM_PILOT)
- **Panel visibility management** — shows/hides sub-panels based on camera view
- **Hotkey bar removed** (Session 16) — per [`FULL_HUD_STRATEGY.md`](FULL_HUD_STRATEGY.md) §4. All key hints now in panel-embedded text or Houston comms.
- **`setCodexSystem()` delegation** — passes CodexSystem reference to StatusPanel for unseen badge display (Session 13 F17)
- **Delegates rendering** to [`StatusPanel`](js/ui/hud/StatusPanel.js), [`TargetPanel`](js/ui/hud/TargetPanel.js), [`CommsPanel`](js/ui/hud/CommsPanel.js)

#### [`StatusPanel`](js/ui/hud/StatusPanel.js) (~580 LOC) — NEW (Tier 5, Power ETS Session 9, HUD Redesign Session 11, Session 13)

Score and three main panels (extracted from HUD.js, restructured in Session 11 HUD Redesign R1-R5, expanded Session 13):
- **Score/status bar** — score, cleared/50, altitude, ⚓ contract/anchor indicator
- **🚀 PROPULSION panel** (renamed from RESOURCES) — ΔV bar at top with dark-pill text contrast fix (F1), embedded text overlay and 5-tier visual thresholds (30/15/5/1%), resource bars with `Xenon`/`Gas`/`Bat` labels (42px width, no colons, font bumps F8), inline forge display (hidden until first `CARGO_STORE`, R key cycles OFF→REFINE→PROPELLANT→OFF), **lithium bar + cathode erosion display** (F16), **throttle gauge** (0–100%) (F14)
- **⚡ ENERGY panel** — Power ETS (3 buses: Thrust/Sensors/Arms), hover-to-expand hint
- **🐙 FISHING FLEET panel** (renamed from Capture Fleet) — 4 functional state colors, arm statuses + hover-to-expand ΔV details, **collapsed single-row summary** (F12): `🐙 FLEET: 4 ●DOCKED  1 ●TRANSIT  1 ●FISHING`
- **Horizontal-expand panels** (F11) — PROPULSION + ENERGY panels use `.hud-panel-h-expand` CSS class, collapse to 110px showing mini-bar + fuel pips, expand to 260px on hover showing full detail
- **Autopilot indicator** (F15) — displays ON/OFF state, heading target name, ETA when autopilot engaged
- **Tech library badge** (F17) — unseen entry count badge from CodexSystem
- **Hover-to-expand CSS** — `.hud-panel-expandable`, `.panel-expand-section` classes with `max-height`/`opacity` transitions, `pointer-events: auto` on hover (R5)
- **`DELTAV_UPDATE` emitter** — broadcasts ΔV percentage + predicted ΔV + solar/battery state for AudioSystem consumption
- **Panel widths standardized** to 220px collapsed / 260px expanded (R1, updated F11)

#### [`TargetPanel`](js/ui/hud/TargetPanel.js) (~360 LOC) — NEW (Tier 5, lithium hints Session 13)

Target list and information sub-panel (extracted from HUD.js):
- **3-section target list** — tracked, untracked, active sats
- **Arm range badges** — ● (in range), ◐ (approaching), ○ (out of range) (Tier 1)
- **ΔV transfer fuel costs** — shown per target (Tier 1)
- **IR Scanner filtering** — untracked debris hidden unless IR Scanner upgrade active
- **Session 13 F16:** Lithium target hints — shows Li salvage probability indicator on defunct satellites

#### [`CommsPanel`](js/ui/hud/CommsPanel.js) (~375 LOC) — NEW (Tier 5)

Communications and credits sub-panel (extracted from HUD.js):
- **FS2-style comms menu** — C key opens numbered command menu (1–6)
- **Ground comms log** — scrollable message display
- **Credits counter** — 💰 X cr display near score

#### [`DebugOverlay`](js/ui/DebugOverlay.js) (~120 LOC) — NEW (Tier 5)

Developer performance overlay toggled with Ctrl+D:
- **FPS counter** — frames per second with smoothed averaging
- **Frame time** — milliseconds per frame
- **Entity count** — active debris, arms, satellites
- **WebGL stats** — draw calls, triangles, textures, programs from renderer.info

#### [`DebrisWireframe`](js/ui/DebrisWireframe.js) (~1,180 LOC) — NEW (Tier 2, expanded Session 10, DPI Session 13)

Canvas2D wireframe analysis panel — FS2-heritage target assessment system:
- **5 wireframe shapes**: cylinder (rocket body), box (satellite), irregular polygon (fragment), sphere (mission related), V3 Octopus ADR satellite (self-view)
- **ADR satellite self-view** as default when no target selected — 1.5× scaled for clear visualization, teaches wireframe interface organically
- **Container-mountable**: renders inside right-column flexbox above target list (integrated layout), or standalone (legacy fallback)
- Rotating wireframe to match debris tumble (ADR satellite: slow gentle spin)
- **Zone coloring**: green (safe), yellow (fragile), red (hazardous) based on debris properties
- **Z key / Shift+Z** cycling through zones (FS2 subsystem targeting adaptation) — works on both debris and ADR satellite
- **Approach recommendations**: "Net from below", "⚠ Manual pilot recommended", etc.
- **Salvage indicators**: ⛏ SALVAGE DETECTED section with resource type/amounts (exact amounts require Salvage Scanner upgrade)
- Visible in COMMAND, TACTICAL, TARGET_LOCK, and ARM_PILOT camera views (via `showAnalysis` in VIEW_INFO_LEVELS)
- **Session 13 F2:** DPI-aware canvas scaling (`devicePixelRatio` × canvas dimensions, CSS scale-down, `ctx.scale(dpr, dpr)`) — crisp text on Retina displays
- **Session 13 F3:** Enlarged panel (320px height, `VIEW_SCALE = 240` from 200), header "TARGET ANALYSIS [Z]" hotkey hint, increased font sizes (header 13px, type 12px, zones 11px, recommendations 10px)

#### [`DockingReticle`](js/ui/DockingReticle.js) (~560 LOC) — NEW (Tier 3, DPI Session 13)

ARM PILOT crosshair/alignment overlay — Orbiter-heritage docking MFD:
- Crosshair with range readout and closure rate
- Alignment indicators (yaw/pitch error bars)
- Net deploy status indicators
- Active only during ARM_PILOT camera view
- **Session 13 F7:** DPI scaling + `imageSmoothingEnabled` for crisp rendering on Retina displays

#### [`NavSphere`](js/ui/NavSphere.js) (~490 LOC, DPI Session 13)

Canvas2D-rendered 3D radar sphere (260px diameter, top-right, toggleable with N key):
- Radial gradient hemisphere shading (3-stop gradient for depth effect)
- Specular highlight offset up-left
- 5 elliptical longitude meridians + 3 latitude parallels via `ctx.ellipse()`
- Rim glow (outer + inner rings)
- Contact dots: tracked (green diamond), untracked (yellow), active sat (red triangle), selected (pulsing cyan + line to center)
- **I-War vertical stalks** — thin lines from each contact dot down to equatorial plane (Tier 1)
- **Session 13 F4:** DPI scaling + `imageSmoothingEnabled` for crisp text and contacts on Retina displays

#### [`OrbitMFD`](js/ui/OrbitMFD.js) (~620 LOC, educational labels Session 11, DPI Session 13)

Orbiter-heritage orbit visualization MFD. Shows player/target orbits as 2D ellipses in polar top-down view. Displays Hohmann transfer arc, ΔV cost, inclination difference, transfer time. Toggle with M key. Canvas2D overlay at bottom-right. Session 11 (R7) educational labels:
- **Ap/Pe labels** when eccentricity > 0.01; "Circular: ~{alt}km" otherwise
- **Hohmann transfer ΔV₁/ΔV₂** labels at burn points
- **Inclination difference** near target orbit
- **Prograde direction arrow** on player position marker
- **Session 13 F6:** DPI scaling + `imageSmoothingEnabled` for crisp orbit text on Retina displays; route label y-coordinate bugfix

#### [`TargetReticle`](js/ui/TargetReticle.js) (~1,050 LOC, tactical additions Session 11, DPI Session 13, ceremonies Session 16)

Canvas2D target brackets with I-War-style enhancements. Session 11 (R6) added tactical information, Session 16 added feedback ceremonies:
- **Target lock-on animation** (Session 16) — bracket shrink 2.5×→1× over 300ms (cubic ease-out), white corner flash, ascending C5→E5 tone. Target-lost: expand+fade 200ms, descending E5→C5.
- **Lasso cooldown arc** (Session 16) — ring around crosshair fills 0%→100% over cooldown. Green when ready, gray when cooling. Red flash + denied buzz on cooldown/no-target fire.
- **Autopilot indicator** (Session 16) — amber "◉ AP → [target]" text + dashed heading line from prograde to target when autopilot active. Fades on disengage.
- **Closure rate + ETA** on prograde marker
- **Post-burn ΔV** on retrograde marker with color coding (green/amber/red by remaining budget)
- **Top-2 metal loot preview** on target brackets (`⛏ Al:42kg Ti:18kg`)
- **Periapsis burn hint** near prograde when orbit is eccentric
- **Colors updated** to 5-color system (yellow→`#ffaa00`, cyan→`#4488ff`)
- **`DELTAV_UPDATE` event** — predictive ΔV calculation via Tsiolkovsky equation
- **Contact type icons:** Unicode symbols — ⬛ rocket body, ◆ defunct sat, ● mission related, ▪ fragment, ⊕ active sat
- **Lead indicator** — shows where to thrust to intercept target
- **Session 13 F5:** DPI scaling + `imageSmoothingEnabled` for crisp brackets/text on Retina displays

#### [`VelocityStreaks`](js/ui/VelocityStreaks.js) (~200 LOC) — NEW (Session 16 — FULL_HUD_STRATEGY Phase 4)

Full-screen Canvas2D overlay rendering radial velocity streaks — I-War heritage acceleration visualization:
- **Blue streaks** radiating outward from screen center during prograde thrust (`#4488ff` → `#44ffff`)
- **Red streaks** converging inward during retrograde thrust (`#ff4444` → `#ff8844`)
- **White streaks** for lateral thrust (`#aacccc`)
- **Streak parameters:** count proportional to thrust magnitude (up to 30), length 10-80px, alpha 0.15-0.4
- **FOV breathe integration:** [`CameraSystem.js`](js/systems/CameraSystem.js) applies ±2-3° FOV offset during sustained thrust (narrows prograde, widens retrograde, 500ms ease)
- **Event-driven:** Subscribes to `THRUST_VISUAL` events from [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) with `{ magnitude, direction, type }`
- **Works with autopilot:** Same event path fires during autopilot thrusting

#### [`CodexViewerUI`](js/ui/CodexViewerUI.js) (~300 LOC) — NEW (Session 13 F17)

DOM overlay tech library browser — surfaces the 105 educational entries from [`CodexSystem`](js/systems/CodexSystem.js):
- **Category sidebar** — 9 tabs (Orbital Mechanics, Propulsion, Power, Space Environment, Materials, Tethers, Debris, Sensors, Comms)
- **Entry cards** — scrollable list of unlocked entries showing icon, title, short text
- **Detail view** — full text display when entry card is selected
- **Unseen badge** — shows count of unlocked-but-unread entries; emits `CODEX_VIEWED` on read
- **Progress header** — "X/45 entries unlocked" from `codexSystem.getProgress()`
- **L key toggle** — opens/closes the viewer overlay (player-facing name: "Tech Library")
- **Public API:** `getEntry(id)`, `getCategory(cat)`, `getUnlockedEntries()`, `getProgress()` on CodexSystem

#### [`ShopScreen`](js/ui/ShopScreen.js) (~400 LOC, MPD Session 13)

Between-mission upgrade shop with 21 working upgrades:
- Grouped by 6 categories: Propulsion, Power, Sensors, Arms, Automation, Hull
- Purchase flash animation + level badges for multi-level upgrades
- Credits display with insufficient-funds styling
- **Session 13 F16:** MPD Thruster upgrade (3,000 cr) with `requiresAll` prerequisite support — requires both `efficient_panels` AND `extra_battery` purchased before unlock
- [`serialize()`](js/ui/ShopScreen.js:312) / [`restorePurchases()`](js/ui/ShopScreen.js:326) for persistence
- See §12 for full upgrade list

#### [`MenuScreen`](js/ui/MenuScreen.js) (197 LOC)

Translucent dark blue gradient overlay (55-78% opacity, 3-stop gradient). Stars and Earth visible through menu. **Continue button** appears when PersistenceManager detects a valid save.

#### [`GameOverScreen`](js/ui/GameOverScreen.js) (296 LOC)

Win/loss display with:
- **Continue button** — roguelite flow: 50% credit penalty → SHOP → retry
- **Mission summary grid** — score, captures by tier, best streak, time played
- Retry and menu buttons

#### [`BriefingScreen`](js/ui/BriefingScreen.js) (357 LOC)

Mission briefing with:
- **Mission number** — derived from debris cleared ÷ 5
- **Credits context** — shows available credits before deploying
- Commence / Skip buttons

---

## 7. V5 Crossbow Arm System

> Full specification: [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md)

### 7.1 Overview

Spring-loaded crossbow mechanism replaces V3's FEEP ion thrust deployment. All velocities derive from first-principles spring physics (E = ½kd²), eliminating the deprecated `ARM_GAMIFIED_THRUST_MULT: 200` fake multiplier.

**8-arm configuration:** 3 Weavers (11→6.6 kg) + 3 Spinners (3.7→2.1 kg) at hexagonal ring + 1 Front (prograde) + 1 Back (retrograde) spinner.

```
PLAYER SATELLITE ("Octopus" V5)
├── Octagonal bus (8-sided prism)
│   ├── Forward: laser aperture ring + Front spinner arm (prograde)
│   ├── Sides: 6 docking cavities (hexagonal) — 3 Weaver + 3 Spinner
│   ├── Aft: ion drive + solar panels + Back spinner arm (retrograde)
│   └── 8 tether reels (on mothership, not on arms)
│
└── 8 ARM UNITS (3W + 3S + 1F + 1B)
    ├── Weaver: net-based capture, spring-launched (k=17,600 N/m)
    ├── Spinner: gecko pad + net, spring-launched (k=5,920 N/m)
    ├── Each arm: spring rail + tether + sensor node + EPM dock
    └── 20-state machine for full mission lifecycle
```

### 7.2 Launch Physics

- Spring draw distance: 0.25m (maraging steel spring pack) — [`CROSSBOW_DRAW_DISTANCE`](js/core/Constants.js)
- Spring constant: 17,600 N/m (Weaver), 5,920 N/m (Spinner) — [`CROSSBOW_SPRING_K_WEAVER/SPINNER`](js/core/Constants.js)
- Default launch speed: 10 m/s (selectable 3–25 m/s via spring tier) — [`CROSSBOW_LAUNCH_SPEED_DEFAULT`](js/core/Constants.js)
- Release time: 50ms (spring) + 300ms (magnetic clamp) — [`CROSSBOW_RELEASE_TIME`](js/core/Constants.js) + [`CROSSBOW_UNDOCK_TIME`](js/core/Constants.js)
- Energy: 550J (Weaver at 10 m/s), 185J (Spinner at 10 m/s)

### 7.3 State Machine

20 states total. V5 additions (6 new):

| State | Duration | Description |
|-------|----------|-------------|
| LAUNCHING | 0.35s | Magnetic clamp release + spring fire |
| REELING | variable | Zero-fuel motor reel-in (1.4 m/s loaded) |
| RELOADING | 20–55s | Worm gear compresses spring |
| ABLATING | up to 30s | 10W laser de-spin/nudge |
| SCANNING | 2s | Pulse scan sensor node |
| TANGLED | 8s | Auto-resolution with slack pulses |

Core flow: DOCKED → LAUNCHING → TRANSIT → APPROACH → NETTING → GRAPPLED → REELING → DOCKING → RELOADING → DOCKED

### 7.4 Key Mechanics

- **Dual-fire:** Opposite arm pairs (0↔3, 1↔4, 2↔5, 6↔7) cancel recoil momentum — [`DUALFIRE_SYNC_WINDOW`](js/core/Constants.js): 10ms
- **Pulse scan:** "Jellyfish pulse" — all arms fire as distributed sensor array (30s cooldown) — [`PULSE_SCAN_COOLDOWN`](js/core/Constants.js)
- **Reel-in:** Zero-fuel return via motor on mothership (eliminates HAULING fuel cost) — [`REEL_IN_SPEED_LOADED`](js/core/Constants.js): 1.4 m/s
- **Thruster interlock:** Back arm (index 7) inhibits Hall thruster during transit — [`V5_BACK_ARM_TYPE`](js/core/Constants.js)
- **Auto-RCS:** Automatic N₂ compensation for single-fire recoil (3.7g per Weaver shot) — [`DUALFIRE_RCS_COMPENSATION_N2`](js/core/Constants.js)

### 7.5 Upgrade Tiers

**Springs:** T1 Steel (7.1 m/s, free) → T2 Maraging (10 m/s, 800 Cr) → T3 Composite (15 m/s, 3K Cr) → T4 Nanolam (20 m/s, 10K Cr) → T5 Metamat (25 m/s, 30K Cr) — [`SPRING_TIERS`](js/core/Constants.js)

**Tethers:** T1 Dyneema (100N, 2km) → T2 Zylon (200N, 4km) → T3 CNT (350N, 6km) → T4 GSL-50 (500N, 8km) → T5 GSL-100 (800N, 10km) — [`TETHER_TIERS`](js/core/Constants.js)

### 7.6 Files

| File | Role |
|------|------|
| [`ArmUnit.js`](js/entities/ArmUnit.js) | Individual arm: 20-state machine, spring physics, tether tension |
| [`ArmManager.js`](js/entities/ArmManager.js) | Fleet coordinator: 8-arm init, dual-fire, pulse scan |
| [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) | Recoil, RCS compensation, thruster interlock, 8 reels |
| [`Constants.js`](js/core/Constants.js) | 42 V5 constants (spring, reel, dual-fire, scan, ablation, tiers) |
| [`Events.js`](js/core/Events.js) | 13 V5 events (crossbow lifecycle, tether, dual-fire, scan, ablation) |
| [`StatusPanel.js`](js/ui/hud/StatusPanel.js) | 8-arm display: reload bars, tension, tangle/scan/interlock |
| [`ShopScreen.js`](js/ui/ShopScreen.js) | 5-tier spring + 5-tier tether upgrades |

### 7.7 Mass Budget (Strategic Core)

```javascript
// Tsiolkovsky: ΔV = Isp × g0 × ln(m_wet / m_dry)
// m_wet = busEmpty + fuel + (armMass × dockedArms) + capturedDebrisMass
// m_dry = busEmpty + (armMass × dockedArms) + capturedDebrisMass
//
// V5 change: Arms are 40% lighter (reels on mothership, not arms)
// Deploying arms → reduces mass → more agile for next transfer
// Capturing debris → adds hauled mass → reduces available ΔV
// Reel-in uses zero fuel (motor on mothership), unlike V3 FEEP HAULING
```

### 7.8 V4 Upgrade Path

[`V4 Opussy.md`](archive/V4%20Opussy.md) (601 lines) defines the graphene/GSL upgrade path. V5 tether tiers already include GSL-50 and GSL-100 materials from V4 spec.

---

## 8. 3D Scene Composition

### Scene Graph Hierarchy (Actual)

```
Scene (root)
├── DirectionalLight (sun)           // SunLight.js
├── AmbientLight (0.02 intensity)    // Very dim for dark shadows
│
├── Sun Disc Sprite                  // 64×64 canvas gradient, additive
├── Lens Flare Sprites (×3)          // Between sun and camera center
├── Moon Sprite                      // Phase from sun-moon angle
│
├── EarthGroup (pivot at origin)
│   ├── SurfaceSphere               // 256-seg, custom GLSL day/night+specular
│   ├── CloudSphere                 // 128-seg, 8K alpha-mapped, ClampToEdge
│   └── AtmosphereSphere           // 128-seg, BackSide, Fresnel 5.5/1.4
│                                    // NOT on bloom layer (removed for perf)
│
├── PlayerSatelliteGroup
│   ├── OctagonalBusMesh            // 8-sided prism, procedural geometry
│   ├── DockingCavities (×6)        // Hexagonal positions + LED beacons
│   ├── FrontBackArmRails (×2)      // V5: prograde + retrograde spring rails
│   ├── LaserApertureRing           // Forward face
│   ├── SolarPanelWings
│   ├── TetherReels (×8)            // V5: on mothership, not on arms
│   └── ArmUnits (×8, when docked)  // V5: 3W+3S hex + F+B axial
│
├── DeployedArmGroups (when deployed)
│   ├── ArmUnit mesh                // Jointed arm + grapple
│   ├── TetherLine                  // Catenary sag curve, tension-colored
│   └── Status LEDs                 // Color by state
│
├── DebrisGroup
│   ├── InstancedMesh (fragments)
│   ├── InstancedMesh (rockets)
│   ├── InstancedMesh (defunct)
│   └── InstancedMesh (mission-rel)
│
├── ActiveSatellitesGroup
│   └── InstancedMesh (active-sats)
│
└── StarField                        // Points geometry
```

### Earth Rendering

The Earth is the visual centerpiece. Three layers:

**Surface Shader** (inline GLSL in [`Earth.js`](js/scene/Earth.js)):
- Day texture on sun-facing hemisphere
- Night (city lights) texture on dark hemisphere
- Smooth blend across terminator
- Ocean specular using **ratio-based detection** (blue channel dominance) + Fresnel
- Improved from original basic specular map approach

**Atmosphere** (inline GLSL in [`Earth.js`](js/scene/Earth.js)):
- Back-face rendered, additive blending
- Fresnel power: 5.5 (increased from 4.5 for thinner ISS-like limb)
- Intensity: 1.4 (reduced from 1.8 to prevent overblown edges)
- **Removed from bloom layer** (Fix 1) — atmosphere bloom was causing excessive glow

**Cloud Layer**:
- 8K resolution cloud texture (upgraded from 2-4K)
- `ClampToEdgeWrapping` (Safari antimeridian seam fix)
- Slow rotation independent of surface

### Post-Processing Pipeline (Current)

- UnrealBloomPass: **re-enabled** (strength=0.15, threshold=0.85) — Session 9 re-tuned for subtle sun disc + engine glow
- Composer runs RenderPass → UnrealBloomPass → SMAAPass

---

## 9. HUD Layout

### HUD Panels (Actual Implementation — Session 11 HUD Redesign)

| Panel | Position | Content |
|-------|----------|---------|
| Score/Status | Top center | Score, cleared/50, altitude, ⚓ contract/anchor indicator |
| 🚀 PROPULSION | Top-left | ΔV bar (5-tier: 30/15/5/1%), Xenon/Gas/Bat bars (42px labels), inline forge |
| ⚡ ENERGY | Top-left (below propulsion) | Power ETS 3 buses, hover-to-expand hint |
| 🐙 FISHING FLEET | Bottom-left | 8 arm statuses (V5: F/B labels, reload bars), hover-to-expand |
| Targets List | Right (below NavSphere) | 3-section: tracked, untracked, active sats |
| Ground Comms [C] | Bottom-right | Mission comms log (toggleable) |
| Orbit View [M] | Bottom-right (overlay) | 2D orbit ellipses, ΔV readouts, Ap/Pe labels, Hohmann ΔV₁/ΔV₂ |
| NavSphere [N] | Top-right | 260px 3D contact sphere (toggleable) |
| ~~Hotkey Bar~~ | ~~Bottom center~~ | ❌ **Removed** (Session 16 — per FULL_HUD_STRATEGY §4) |
| Contextual Prompt | Right-aligned above comms (bottom: 145px, right: 10px) | MW2-style: max-width 280px, persistent until next stage (S16, repositioned S20) |
| Capture Notification | Top 15% center | Flash on capture (+score, count) |
| Warning Strip | Bottom 170px center | Temporary warnings |

All panels standardized to 220px width. Removed `.hud-bar-cyan`/`.hud-bar-yellow` CSS classes from [`index.html`](index.html). 5-color system: Green `#00ff88`, Amber `#ffaa00`, Red `#ff4444`, Blue `#4488ff`, White `#ccddcc`. Bar thresholds unified to 30%/15% (was 50%/25%).

**Progressive Luminance (Session 16):** All panels use `.hud-dormant` / `.hud-active` CSS classes instead of `display: none`. Dormant panels are visible at opacity 0.3 + saturate 0.3 (near-grayscale), creating a "powered down cockpit" look. Tutorial activates panels via `data-hud-group` attributes as it teaches them. 600ms transitions. See [`FULL_HUD_STRATEGY.md`](archive/FULL_HUD_STRATEGY.md) §2 for the full spec.

Removed panels: Tools (Phase 1), DSat (Phase 0), Sensor/Target Info (layout cleanup), standalone forge panel (R3 — inlined into Propulsion), Hotkey bar (Session 16 — per FULL_HUD_STRATEGY §4)

**V5 Crossbow HUD Additions (Session 17):**
- 8-arm status grid (was 6) with "F" and "B" labels for front/back axial arms
- Reload progress bars per arm (worm gear compression progress)
- Tether tension color coding (green < 70% break strength, yellow 70–90%, red > 90%)
- Pulse scan status + 30s cooldown indicator
- Thruster interlock warning ("⚠ THR LOCK") when back arm (index 7) is in transit
- STABILIZE warning for high angular velocity post-single-fire recoil

---

## 10. Resource Formulas & Balance

> **Tier 0 fix:** [`ResourceSystem`](js/systems/ResourceSystem.js) is now the **sole canonical owner** of all resource pools. `GameState.resources` was removed. `PlayerSatellite.resources` is a read-only view updated via push-only [`_syncToPlayer()`](js/systems/ResourceSystem.js:265). All consumption routes through EventBus → `ResourceSystem.consume()`.

### 10.1 Starting Resources (Base Loadout — upgradeable via Shop)

| Resource | Starting | Max (Base) | Units |
|---|---|---|---|
| Xenon | 100 | 100 | kg |
| Cold Gas (N₂) | 15 | 15 | kg |
| Battery | 5000 | 5000 | Wh |
| Solar Panel Area | 20 | — | m² |
| Solar Degradation | 1.0 | — | factor |

### 10.2 Consumption Rates

**Ion Thruster (Hall-Effect, default):**

```
Isp = 1800 s (upgradeable to 3000s)
Thrust = 200 mN (upgradeable to 500mN)
Power draw = 3000 W
Xenon flow rate = Thrust / (Isp × g₀) = 0.200 / (1800 × 9.80665) = 0.0000113 kg/s ≈ 0.041 kg/hr
```

**Cold Gas Thruster:**

```
Isp = 60 s
Thrust = 10 N (high for emergency)
N₂ flow rate = 10 / (60 × 9.80665) = 0.017 kg/s
Burn duration = typically 0.5–2.0 s max
Per-burst cost = ~0.017 × 1.0 = 0.017 kg per second of burn
```

**Capture Tool Power Costs:**

| Tool | Power (W) | Xenon (kg/s) | Cold Gas (kg/burst) | Duration |
|---|---|---|---|---|
| Laser Ablation | 5000 | — | — | 10–60s continuous |
| Ion Beam Shepherd | 2000 | 0.000008 | — | 30–120s continuous |
| Eddy Current Brake | 1500 | — | — | 20–90s continuous |
| Net Capture | 200 | — | 0.05 (deploy gas) | 2s deploy |
| Harpoon | 100 | — | — | 0.5s launch |
| Robotic Arm | 800 | — | — | 10–30s grapple |
| Magnetic Capture | 1200 | — | — | 5–15s dock |
| Gecko Gripper | 300 | — | — | 10–20s attach |
| Tether Deploy | 500 | — | — | 5–10s deploy |
| Foam Adhesive | 100 | — | — | 3s spray (limited canisters: 5) |

### 10.3 Solar Power Generation

```javascript
// Base solar output at 1 AU
const SOLAR_CONSTANT = 1361;  // W/m² (at 1 AU, close enough for LEO)
const PANEL_EFFICIENCY = 0.30; // 30% efficient cells

solarOutput = SOLAR_CONSTANT * PANEL_EFFICIENCY * solarPanelArea * solarDegradation * sunlightFactor;
// At base: 1361 × 0.30 × 20 × 1.0 × 1.0 = 8,166 W (in sunlight)
// sunlightFactor: 1.0 in sun, 0.0 in shadow
// Orbital period ~92 min → ~60 min sun, ~32 min shadow (65% avg)
```

### 10.4 Hohmann Transfer Fuel Cost

```javascript
// ΔV for Hohmann from current orbit to target
function hohmannDV(r1, r2) {
  const a_t = (r1 + r2) / 2;
  const dv1 = Math.abs(Math.sqrt(MU / r1) * (Math.sqrt(2 * r2 / (r1 + r2)) - 1));
  const dv2 = Math.abs(Math.sqrt(MU / r2) * (1 - Math.sqrt(2 * r1 / (r1 + r2))));
  return dv1 + dv2;  // km/s
}

// Fuel consumed via Tsiolkovsky:
// ΔV = Isp × g₀ × ln(m_initial / m_final)
// → m_fuel = m_ship × (1 - exp(-ΔV / (Isp × g₀)))
function fuelForDeltaV(dv_km_s, shipMass, isp) {
  const dv_m_s = dv_km_s * 1000;
  const ve = isp * 9.80665;
  return shipMass * (1 - Math.exp(-dv_m_s / ve));
}
// Example: 400→800km Hohmann ≈ 0.22 km/s
// Fuel = 2000 × (1 - exp(-220 / (1800 × 9.81))) = 24.9 kg Xe
```

### 10.5 Game-Time Scaling

```javascript
TIME_SCALE = 60;  // 1 real sec = 60 game sec (adjustable 30-120×)
INTERACTION_TIME_SCALE = 10;  // Slowed during capture operations
```

---

## 11. Scoring System

### 11.1 Debris Tiers

| Tier | Description | Examples | Base Points |
|---|---|---|---|
| 1 | Small, easy | Small fragments (<10cm), low tumble | 100 |
| 2 | Medium | Defunct sat parts, medium tumble | 300 |
| 3 | Large/difficult | Defunct satellites, high tumble, rocket upper stages | 800 |
| 4 | Boss-class | SL-16 rocket bodies (9000 kg), extremely dangerous | 2000 |

### 11.2 Scoring Formula

```javascript
function calculateScore(debris, captureMethod, fragmentsCreated) {
  const BASE = TIER_POINTS[debris.tier];
  const sizeFactor = 1.0 + Math.log10(Math.max(debris.mass, 1)) / 4;
  const velFactor = 1.0 + debris.relativeVelocity / 15.0;
  const tumbleFactor = 1.0 + debris.tumbleRate / 90.0;
  const riskMultiplier = 1.0 + nearbyActiveSats * 0.3 + orbitalDensityFactor * 0.2;
  const methodBonus = getMethodBonus(captureMethod, debris);
  const fragmentPenalty = Math.max(1, fragmentsCreated);
  
  const raw = BASE * sizeFactor * velFactor * tumbleFactor;
  return Math.floor(raw * riskMultiplier * methodBonus / fragmentPenalty);
}
```

### 11.3 Method Bonus Table (V3 Arm System)

| Method | Code Key | Multiplier | Notes |
|---|---|---|---|
| Arm (auto-capture) | `arm` | 1.0× | Base — autonomous arm capture |
| Arm (manual pilot) | `armManual` | 2.0× | Player manually piloted arm in ARM_PILOT mode |
| Arm (fishing) | `armFishing` | 1.1× | Passive fishing capture |
| Laser Ablation | `laser` | 1.3× | Legacy tool framework (disabled) |
| Ion Beam Shepherd | `ionBeam` | 1.4× | Legacy tool framework (disabled) |
| Tether | `tether` | 1.25× | Legacy tool framework (disabled) |

### 11.4 Scoring Multiplier Bonuses (Stacking)

These bonuses are applied **after** the base score calculation in [`ScoringSystem.awardPoints()`](js/systems/ScoringSystem.js:103):

| Bonus | Multiplier | Condition | Code Check |
|---|---|---|---|
| Tactical Assessment | ×1.3 | Player assessed all wireframe zones before capture | `data.tacticalAssessment` |
| Manual Capture | ×2.0 | Player manually piloted arm to target (ARM PILOT mode) | `data.manualCapture` |
| Fuel Efficiency | ×1.25 | Fuel-efficient gravity gradient approach during manual capture | `data.fuelEfficient` |
| Salvage Recovery | ×1.15 | Debris had salvageable resources recovered on return (Session 10) | `data.salvageRecovered` |
| Deorbit Sacrifice | ×1.5–2.5 | Arm sacrificed for one-way deorbit burn (Session 10) | `data.deorbitSacrifice` |
| **Max (capture)** | **×3.74** | Tactical × Manual × Fuel × Salvage (1.3 × 2.0 × 1.25 × 1.15) | — |
| **Max (deorbit)** | **×4.88** | Tactical × Manual × Fuel × Deorbit ×1.5 | — |

### 11.5 Credits Economy

Points earned = credits earned (1:1 ratio). Credits are spent in the shop via [`scoringSystem.spendCredits(amount)`](js/systems/ScoringSystem.js:165). Roguelite continue applies a 50% credit penalty.

### 11.6 Score Thresholds

| Milestone | Score / Count | Reward |
|---|---|---|
| First Capture | 1 debris | Tutorial complete badge |
| Apprentice | 10 debris | Unlock Tier 3 missions |
| Professional | 25 debris | Unlock Tier 4 missions |
| Stabilizer | 50 debris (win!) | Victory screen + final stats |
| Ace Cowboy | 100 debris (bonus) | Post-game bragging rights |

---

## 12. Upgrade Tree (21 Working Upgrades)

> **Status:** All 21 upgrades are **wired and working** as of Session 13. Defined in [`ShopScreen.js`](js/ui/ShopScreen.js:11-61), applied across 7+ systems via EventBus `upgrade:purchased` events. Session 10 added 3 salvage-related upgrades. Session 13 added MPD Thruster with `requiresAll` prerequisite support.

### 12.1 Propulsion (5 upgrades)

| ID | Name | Cost | Effect Key | Value | Max Level | Applied In |
|---|---|---|---|---|---|---|
| `efficient_ion` | Efficient Ion Drive | 500 | `xenonEfficiency` | 0.8 (×0.8 consumption) | 1 | [`PlayerSatellite`](js/entities/PlayerSatellite.js) |
| `high_thrust_ion` | High-Thrust Ion | 800 | `thrustMultiplier` | 1.5 (×1.5 thrust) | 1 | [`PlayerSatellite`](js/entities/PlayerSatellite.js) |
| `extra_xenon` | Extra Xenon Tank | 600 | `xenonMax` | +50 per level | 2 | [`ResourceSystem`](js/systems/ResourceSystem.js) |
| `extra_coldgas` | Extra Cold Gas | 400 | `coldGasMax` | +10 per level | 2 | [`ResourceSystem`](js/systems/ResourceSystem.js) |
| `mpd_thruster` | MPD Thruster | 3000 | `mpdThruster` | true (25N thrust, Isp 3000s, 150kW, lithium) | 1 | [`PlayerSatellite`](js/entities/PlayerSatellite.js), [`ResourceSystem`](js/systems/ResourceSystem.js) |

> **MPD Thruster prerequisite (Session 13 F16):** Requires both `efficient_panels` AND `extra_battery` purchased. Uses `requiresAll` array in ShopScreen upgrade definition. Lithium propellant obtained via salvage from defunct satellites. Cathode erosion limits total burn time to 600s (upgradeable to 1,200s with Hardened Cathode — future upgrade slot).

### 12.2 Power (3 upgrades)

| ID | Name | Cost | Effect Key | Value | Max Level | Applied In |
|---|---|---|---|---|---|---|
| `efficient_panels` | Efficient Panels | 500 | `solarEfficiency` | 1.3 (×1.3 solar rate) | 1 | [`ResourceSystem`](js/systems/ResourceSystem.js) |
| `extra_battery` | Extra Battery | 400 | `batteryMax` | +50 per level | 2 | [`ResourceSystem`](js/systems/ResourceSystem.js) |
| `rad_hard_panels` | Rad-Hard Panels | 700 | `panelDegradation` | 0.5 (×0.5 degradation) | 1 | [`ResourceSystem`](js/systems/ResourceSystem.js) |

### 12.3 Sensors (4 upgrades)

| ID | Name | Cost | Effect Key | Value | Max Level | Applied In |
|---|---|---|---|---|---|---|
| `enhanced_eo` | Enhanced EO | 500 | `sensorRange` | 1.5 (×1.5 range) | 1 | [`SensorSystem`](js/systems/SensorSystem.js) |
| `ir_scanner` | IR Scanner | 600 | `detectUntracked` | true | 1 | [`SensorSystem`](js/systems/SensorSystem.js) |
| `advanced_lidar` | Advanced LIDAR | 800 | `scanRange` | 2.0 (×2.0 range) | 1 | [`SensorSystem`](js/systems/SensorSystem.js) |
| `salvage_scanner` | Salvage Scanner | 700 | `salvageScan` | true (reveal salvage at range) | 1 | [`SensorSystem`](js/systems/SensorSystem.js) → [`DebrisWireframe`](js/ui/DebrisWireframe.js) [Session 10] |

### 12.4 Arms (6 upgrades)

| ID | Name | Cost | Effect Key | Value | Max Level | Applied In |
|---|---|---|---|---|---|---|
| `long_tether` | Extended Tether | 600 | `tetherRange` | 2.0 (×2.0 range) | 1 | [`ArmManager`](js/entities/ArmManager.js) / [`ArmUnit`](js/entities/ArmUnit.js) |
| `fast_reel` | Fast Reel Motor | 500 | `reelSpeed` | 1.5 (×1.5 speed) | 1 | [`ArmManager`](js/entities/ArmManager.js) |
| `arm_fuel` | Arm Fuel Reserve | 700 | `armFuelMax` | 1.5 (×1.5 fuel) | 1 | [`ArmManager`](js/entities/ArmManager.js) / [`ArmUnit`](js/entities/ArmUnit.js) |
| `capture_net` | Reinforced Nets | 800 | `captureRate` | +0.2 (+20% success) | 1 | [`ArmManager`](js/entities/ArmManager.js) |
| `hazmat_handler` | Hazmat Handler | 1200 | `hazmatRecovery` | true (hydrazine → cold gas) | 1 | [`GameFlowManager`](js/systems/GameFlowManager.js) [Session 10] |
| `refinery_arm` | Micro-Refinery | 1500 | `refineryEfficiency` | 1.5 (×1.5 salvage yield) | 1 | [`GameFlowManager`](js/systems/GameFlowManager.js) [Session 10] |

### 12.5 Automation (1 upgrade)

| ID | Name | Cost | Effect Key | Value | Max Level | Applied In |
|---|---|---|---|---|---|---|
| `kessler_warning` | Kessler Warning | 500 | `kesslerWarning` | true (brittleness alerts) | 1 | [`KesslerSystem`](js/systems/KesslerSystem.js) |

### 12.6 Hull (2 upgrades)

| ID | Name | Cost | Effect Key | Value | Max Level | Applied In |
|---|---|---|---|---|---|---|
| `whipple_shield` | Whipple Shield | 1000 | `shieldHits` | 1 (survive 1 hit) | 1 | [`GameState`](js/core/GameState.js) |
| `auto_dock` | Auto-Dock Assist | 600 | `autoDock` | 0.5 (×0.5 dock time) | 1 | [`ArmManager`](js/entities/ArmManager.js) |

### 12.7 Upgrade Application Flow

```
ShopScreen._purchaseUpgrade()
  → scoringSystem.spendCredits(cost)
  → eventBus.emit('upgrade:purchased', { id, effect, value, level })
  → GameFlowManager.js listener routes to:
      ├── resourceSystem.applyUpgrade()   — xenonMax, coldGasMax, batteryMax, solar, degradation
      ├── playerSatellite.applyUpgrade()  — thrust, xenon efficiency
      ├── sensorSystem.applyUpgrade()     — range, untracked detection, scan range
      ├── kesslerSystem.applyUpgrade()    — brittleness warnings
      ├── armManager.applyUpgrade()       — tether, reel, fuel, capture rate, dock speed
      └── gameState.shieldHits += value   — whipple shield
```

**Multi-level bug fix:** [`ResourceSystem.applyUpgrade()`](js/systems/ResourceSystem.js:199) now uses cumulative `+=` instead of reset-to-base `= Constants.X + value`, so buying Extra Xenon Tank twice correctly gives base+50+50.

**V4 addition:** GSL upgrade path (stub in [`ArmManager.js`](js/entities/ArmManager.js)) will add graphene-based arm upgrades per [`V4 Opussy.md`](archive/V4%20Opussy.md).

---

## 13. Debris Generation Algorithm

### 13.1 Distribution Parameters

```javascript
const DEBRIS_CONFIG = {
  totalObjects: 800,          // Gameplay count (scaled from 36.5K tracked)
  backgroundPoints: 5000,    // Non-interactive LOD-3 points
  typeDistribution: {
    fragment:       0.60,     // 480 objects
    rocket_body:    0.12,     // 96 objects
    defunct_sat:    0.16,     // 128 objects
    mission_related: 0.12,   // 96 objects
  },
  altitudeDistribution: {
    mean: 800, stdDev: 200, min: 200, max: 2000,  // km
  },
  inclinationClusters: [
    { center: 28.5, weight: 0.10, spread: 3 },   // Cape Canaveral
    { center: 51.6, weight: 0.15, spread: 2 },   // ISS-related
    { center: 65.0, weight: 0.10, spread: 5 },   // Russian launches
    { center: 72.0, weight: 0.10, spread: 3 },   // Plesetsk
    { center: 82.0, weight: 0.10, spread: 3 },   // Polar
    { center: 97.5, weight: 0.30, spread: 3 },   // Sun-synchronous
    { center: 98.7, weight: 0.15, spread: 2 },   // SSO (Iridium/Cosmos)
  ],
};
```

### 13.2 Physical Property Ranges

| Type | Mass (kg) | Size (m) | Tumble (°/s) | Tier |
|---|---|---|---|---|
| Fragment | 0.01–50 | 0.01–0.5 | 10–180 | 1 |
| Rocket body | 500–9000 | 3–11 | 1–20 | 3–4 |
| Defunct sat | 50–3000 | 0.5–5 | 0.5–10 | 2–3 |
| Mission related | 0.1–20 | 0.05–1 | 5–90 | 1–2 |

### 13.3 Active Satellite Placement

```javascript
// 50-100 protected active satellites at key orbital slots
const ACTIVE_SAT_COUNT = 75;
// Clustered at: 400km (ISS), 550km (Starlink-ish), 780km (various)
// Collision with ANY active satellite = instant game over
// HUD shows proximity warnings within 10km
```

---

## 14. Orbital Mechanics Model

### 14.1 Design Philosophy

Full n-body simulation is unnecessary. The game uses **Keplerian two-body** with perturbation corrections applied discretely. Accurate enough to teach real concepts while being computationally trivial.

### 14.2 Coordinate System

```
Scene coordinates:
- Origin: Earth center
- Scale: SCENE_SCALE = 0.01 → 1 km = 0.01 Three.js units
  Earth radius = 6371 × 0.01 = 63.71 units
  Player at 400km alt = 67.71 units from origin

Depth buffer:
  logarithmicDepthBuffer: true (REQUIRED — scene spans ~8 orders of magnitude)
  Camera near/far: 0.0001 to 500 (~10m to 50,000km)
```

### 14.3 Kepler Propagation

```javascript
function propagateOrbit(elements, dt_seconds) {
  const n = Math.sqrt(MU_EARTH / Math.pow(elements.a, 3)); // Mean motion
  elements.M = (elements.M + n * dt_seconds) % (2 * Math.PI);
  const E = solveKepler(elements.M, elements.e); // Newton-Raphson, 5-10 iterations
  const ν = 2 * Math.atan2(
    Math.sqrt(1 + elements.e) * Math.sin(E / 2),
    Math.sqrt(1 - elements.e) * Math.cos(E / 2)
  );
  return { ...elements, M: elements.M, ν };
}
```

### 14.4 Hohmann Transfer (Gameplay Abstraction)

During transfers, the intermediate orbit is **not** simulated:
1. Calculate ΔV cost
2. Calculate transfer time: `t = π × √(a_transfer³ / μ)`
3. Deduct xenon fuel
4. Animate camera on curved bezier path between orbits
5. Advance game clock by transfer time
6. Place player directly in target orbit

### 14.5 J2 Perturbation

```javascript
// RAAN precession rate (rad/s)
function raanDrift(a, e, i) {
  const n = Math.sqrt(MU_EARTH / Math.pow(a, 3));
  const p = a * (1 - e * e);
  return -1.5 * n * J2 * Math.pow(EARTH_RADIUS / p, 2) * Math.cos(i);
}
// Applied every physics tick: RAAN += raanDrift × dt
// Targets at different inclinations drift apart over time
```

### 14.6 Atmospheric Drag (Below 400km)

```javascript
// Applied as semi-major axis decay:
// Δa ≈ -2π × Cd × A/m × ρ × a² per orbit
// Below 300km: noticeable. Below 200km: rapid. Below 180km: game over (reentry)
```

---

## 15. Sound Design Plan

**Status: IMPLEMENTED (Phase 3, expanded Session 11 R8-R9).** All audio is procedural Web Audio API — zero external sound files.

### AudioSystem Architecture
- **Singleton** [`audioSystem`](js/systems/AudioSystem.js) with Web Audio routing: generators → sfxBus (gain per `Constants.AUDIO`) → master → destination
- **Initialized on user gesture** via MenuScreen start/fast-start buttons
- **Event-driven** via `setupEventListeners()` — subscribes to arm lifecycle, game events, and Session 11 events (`TARGET_SELECTED`, `FUEL_CHANGED`, `CARGO_STORE`, `TRAWL_CAPTURE`, `FORGE_COMPLETE`, `STATE_CHANGE`, `DELTAV_UPDATE`) on EventBus

### Sound Generators (23 total — 16 original + 6 earcons R8 + 1 deorbit S10)

| Generator | Type | Trigger |
|-----------|------|---------|
| `playThruster(dur)` | Noise burst, bandpass 250Hz | Legacy (random per-frame) |
| `playLaser(dur)` | Sawtooth sweep 440→880→660 | InteractionSystem laser tool |
| `playIonBeam(dur)` | Dual osc sine 80Hz + triangle 120Hz | InteractionSystem ion beam |
| `playMagnetic(dur)` | Sine 60Hz + LFO 4Hz | InteractionSystem magnetic tool |
| `playTetherDeploy(dur)` | Sine sweep 2000→200Hz | InteractionSystem tether |
| `playWarning(urgency)` | Sine beep, scaled (modified R8) | CommsSystem, ShopScreen, arm:expended |
| `playCaptureSuccess()` | 3-note arpeggio G4→B4→D5 | arm:returned (captured=true) |
| `playCollision()` | Noise burst, lowpass 200Hz | game:kesslerEvent |
| `playClick()` | Sine 1200Hz, 50ms | UI buttons, camera cycle |
| `playScoreTally()` | Square 1800Hz, 60ms | score:update |
| `playGameOver()` | Sawtooth 200→40Hz, 2s | GameOverScreen |
| `playVictory()` | 4-chord ascending C major | GameOverScreen |
| `playNetWhoosh(dur)` | Noise → bandpass sweep 3000→300Hz | arm:deployed (fishing), arm:captured |
| `playDockClick()` | Dual sine 400Hz + 200Hz, 30ms | arm:docked |
| `playArmDeploy(dur)` | Bandpass noise + 8Hz LFO whirr | arm:deployed |
| `playFailBuzz(dur)` | Square 150Hz, 300ms | arm:captureFailed |
| `playDeorbitBurn()` | Descending noise + sawtooth | ARM_DEORBIT (Session 10) |
| **`playTabSelect()`** | Short pip earcon | TARGET_SELECTED (R8) |
| **`playFuelCycle()`** | Tonal click | FUEL_CHANGED (R8) |
| **`playCargoStored()`** | Confirmation chime | CARGO_STORE (R8) |
| **`playForgeComplete()`** | Ascending 2-note | FORGE_COMPLETE (R8) |
| **`playTrawlCapture()`** | Net swoosh variant | TRAWL_CAPTURE (R8) |

### Persistent/Looping Sounds (via activeSources Map)

| Sound | Start/Stop | Description |
|-------|-----------|-------------|
| Thruster Hum | `startThrusterHum(type)` / `stopThrusterHum()` | Ion: sine 80Hz + triangle 120Hz; ColdGas: looping noise, bandpass 400Hz. Fades in/out over 150-200ms |
| ΔV Alarm (4-tier) | `updateDeltaVAlarm(dvPct, predictedPct)` | 4-tier urgency: 15% (slow beep), 8% (medium), 3% (fast), 0% (continuous). Backward compat wrappers: `startDeltaVAlarm()`/`stopDeltaVAlarm()` (R9) |
| Ambient Loop | `startAmbientLoop()` / `stopAmbientLoop()` | Bandpass noise + solar hiss. `updateAmbientState()` adjusts based on solarRate/batteryPct from `DELTAV_UPDATE` payload (R8) |
| Thruster Sputtering | `updateThrusterFuelState(fuelPct)` | Below 5% fuel: intermittent audio artifacts on thruster sound (R9). Wired via `DELTAV_UPDATE` event |

### Event Subscriptions (setupEventListeners)

| Event | Sound Played |
|-------|-------------|
| `arm:deployed` | `playArmDeploy()` or `playNetWhoosh()` (fishing) |
| `arm:captured` | `playNetWhoosh(0.3)` |
| `arm:returned` (captured) | `playCaptureSuccess()` |
| `arm:docked` | `playDockClick()` |
| `arm:captureFailed` | `playFailBuzz()` |
| `arm:expended` | `playWarning(0.6)` |
| `game:kesslerEvent` | `playCollision()` |
| `score:update` (points > 0) | `playScoreTally()` |
| `target:selected` | `playTabSelect()` (R8) |
| `fuel:changed` | `playFuelCycle()` (R8) |
| `cargo:store` | `playCargoStored()` (R8) |
| `trawl:capture` | `playTrawlCapture()` (R8) |
| `forge:complete` | `playForgeComplete()` (R8) |
| `state:change` | context-dependent earcon (R8) |
| `deltav:update` | `updateDeltaVAlarm()`, `updateAmbientState()`, `updateThrusterFuelState()` (R9) |

### Game Loop Integration (main.js)

- **Continuous thruster**: `processInput()` tracks thrust state, calls `startThrusterHum(type)` / `stopThrusterHum()`. Silenced on pause and state transitions.
- **ΔV alarm**: Wired via `DELTAV_UPDATE` event from [`StatusPanel`](js/ui/hud/StatusPanel.js). StatusPanel emits `{ dvPct, predictedPct, solarRate, batteryPct }` each frame; AudioSystem subscribes and routes to `updateDeltaVAlarm()`, `updateAmbientState()`, and `updateThrusterFuelState()`.

---

## 16. Performance Optimization Strategy

### Session 9 Performance Pass

Major allocation and CPU optimizations applied in Session 9 Phase 1:

| Optimization | Files | Impact |
|-------------|-------|--------|
| **Spread alloc elimination** — Pre-allocated `_tmpKmOrbit` replaces `{ ...orbit }` | [`DebrisField.js`](js/entities/DebrisField.js) | −~800 spread allocs/frame |
| **Spatial query cache** — `getDebrisNear()` called 3× per frame but computes only 1× | [`DebrisField.js`](js/entities/DebrisField.js), [`main.js`](js/main.js) | −1,600 iterations/frame |
| **Vector3/Matrix4 pre-alloc** — Persistent `_tmpVec`, `_tmpVecA/B/C`, `_tmpMatrix` in hot loops | [`ActiveSatellite.js`](js/entities/ActiveSatellite.js), [`ArmUnit.js`](js/entities/ArmUnit.js), [`CameraSystem.js`](js/systems/CameraSystem.js) | −~250 allocs/frame |
| **Canvas2D throttle** — NavSphere 60→10Hz (every 6th frame), DebrisWireframe 60→15Hz (every 4th frame) | [`NavSphere.js`](js/ui/NavSphere.js), [`DebrisWireframe.js`](js/ui/DebrisWireframe.js) | Measurable CPU reduction |
| **Bloom re-enabled** — Was strength=0 but 3 fullscreen passes still ran; now strength=0.15 (useful) | [`SceneManager.js`](js/scene/SceneManager.js) | Bloom visuals restored at minimal cost |
| **Frame counter** — `frameCount` in main.js for throttle coordination | [`main.js`](js/main.js) | Enables frame-based throttling |

### Current Performance Profile (Post-Fix 1)

| Metric | Before Fix | After Fix |
|---|---|---|
| GPU Usage (M4 Max) | ~50% | ~15-20% |
| Render passes per frame | 21 (dual composer) | 4 (single composer) |
| Frame rate | 120fps (uncapped, wasted) | 60fps (capped) |
| Shadows | Enabled | Disabled |
| Hardware MSAA | Enabled | Disabled (SMAA instead) |
| Tone mapping | AgX | ACES Filmic |

### Rendering Budget (Updated)

| Component | Draw Calls | Budget |
|---|---|---|
| Earth (3 layers) | 3 | 15% GPU |
| Debris (instanced) | 4 | 5% |
| Player satellite + arms | 3-8 | 5% |
| Sun/moon/flare sprites | 5 | 1% |
| Stars | 1 | 1% |
| Post-processing (3 passes) | fullscreen | 20% |
| **Total** | **~20-25** | **~47%** |

Headroom ~53% for complex scenes (many deployed arms, dense debris clusters).

### Adaptive Texture Quality

[`Earth.js`](js/scene/Earth.js) [`getTextureQuality()`](js/scene/Earth.js) detects device capability:

```javascript
function getTextureQuality() {
    const memory = navigator.deviceMemory || 8;  // Safari default: 8
    const gl = renderer.getContext();
    const rendererInfo = gl.getParameter(gl.RENDERER);
    const isAppleGPU = /apple/i.test(rendererInfo);
    
    if (memory >= 8 && !isAppleGPU) return '16k';
    if (memory >= 4) return '8k';
    return '4k';
}
```

---

## 17. Key Constants & Simulation Parameters

All constants are centralized in [`Constants.js`](js/core/Constants.js) (~840 LOC). This is the **single source of truth** — do not duplicate values here.

Key constant groups: Scene scale, physical constants (MU_EARTH, J2, G0), orbital altitudes, camera settings, resource defaults, scoring tiers, physics thresholds, time scales, V3 Octopus core/Weaver/Spinner params (120+ entries), tether specs, docking (EPM), optical system, arm states (20 — 14 original + 6 V5), arm operations, V4 GSL multipliers, salvage system (30+ entries), deorbit multipliers. Session 11 added: `Constants.HUD` block and `Constants.AUDIO` block.

### V5 Crossbow Constants (42 new — Session 17)

| Group | Count | Key Constants |
|-------|-------|---------------|
| Spring physics | 8 | `CROSSBOW_DRAW_DISTANCE`, `CROSSBOW_SPRING_K_WEAVER/SPINNER`, `CROSSBOW_RELEASE_TIME`, `CROSSBOW_UNDOCK_TIME`, `CROSSBOW_LAUNCH_SPEED_DEFAULT/MIN/MAX` |
| Reload mechanism | 5 | `CROSSBOW_RELOAD_POWER`, `CROSSBOW_RELOAD_TIME_SPINNER_10/WEAVER_10`, `CROSSBOW_RELOAD_TIME_MULT`, `CROSSBOW_WORM_GEAR_EFFICIENCY` |
| Tether reel | 7 | `REEL_IN_SPEED_EMPTY/LOADED`, `REEL_MOTOR_POWER`, `REEL_BRAKE_FORCE_MAX`, `REEL_TENSION_WARNING/CRITICAL`, `REEL_LEVEL_WIND_SPEED` |
| Dual-fire / recoil | 4 | `DUALFIRE_SYNC_WINDOW`, `DUALFIRE_RECOIL_WEAVER/SPINNER`, `DUALFIRE_RCS_COMPENSATION_N2` |
| Pulse scan | 4 | `PULSE_SCAN_DURATION`, `PULSE_SCAN_RANGE_MULT`, `PULSE_SCAN_COOLDOWN`, `PULSE_SCAN_POWER` |
| Ablation | 4 | `ABLATION_LASER_POWER`, `ABLATION_RANGE_MAX`, `ABLATION_DURATION_MAX`, `ABLATION_DESPIN_RATE` |
| V5 arm config | 5 | `V5_ARM_COUNT`, `V5_WEAVER_MASS`, `V5_SPINNER_MASS`, `V5_FRONT_ARM_TYPE`, `V5_BACK_ARM_TYPE` |
| Tangle resolution | 3 | `TANGLE_DETECT_ANGLE`, `TANGLE_RESOLVE_TIME`, `TANGLE_SLACK_PULSE` |
| Spring tiers | array | `SPRING_TIERS[0–4]`: Steel→Maraging→Composite→Nanolam→Metamat (7.1–25 m/s) |
| Tether tiers | array | `TETHER_TIERS[0–4]`: Dyneema→Zylon→CNT→GSL-50→GSL-100 (100–800N, 2–10km) |

6 new `ARM_STATES` entries: `LAUNCHING`, `REELING`, `RELOADING`, `ABLATING`, `SCANNING`, `TANGLED`.

Engineering derivations for constant values are in [`V3 Octopus.md`](archive/V3%20Octopus.md) Appendix F and [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md).

---

## 18. Development History

### Sprint 0: Instant Wins
- [`Constants.js`](js/core/Constants.js): Bloom 0.8→0.45, ambient 0.05→0.02, AgX tone mapping added, camera near/far adjusted, debris density tweaked

### Sprint 1: Visual Foundation
- [`SceneManager.js`](js/scene/SceneManager.js): Replaced single composer with dual-composer selective bloom (later reverted in Fix 1)
- [`Earth.js`](js/scene/Earth.js): 8K cloud textures, improved ocean specular (ratio-based + Fresnel), atmosphere Fresnel 4.5→5.5, intensity 1.8→1.4

### Sprint 2: Cinematic Space
- [`SunLight.js`](js/scene/SunLight.js): Sun disc sprite, 3 lens flare sprites, auto-exposure, moon sprite with phase
- [`Earth.js`](js/scene/Earth.js): Adaptive `getTextureQuality()`, Safari deviceMemory fix, Apple GPU detection, ClampToEdgeWrapping

### Sprint 3: HUD & Awareness
- [`TargetReticle.js`](js/ui/TargetReticle.js): Closure rate display, contact type icons
- [`NavSphere.js`](js/ui/NavSphere.js): New file ~266 LOC — Canvas2D 3D radar sphere
- [`CameraSystem.js`](js/systems/CameraSystem.js): `camera:viewChange` events, VIEW_INFO_LEVELS
- [`HUD.js`](js/ui/HUD.js): VIEW_INFO_LEVELS config per camera view

### Sprint 4A: System Extraction
- Extracted [`ResourceSystem.js`](js/systems/ResourceSystem.js), `CaptureSystem.js` (later deleted), [`SensorSystem.js`](js/systems/SensorSystem.js), [`KesslerSystem.js`](js/systems/KesslerSystem.js) from monolithic main.js (1,007 LOC)

### Sprint 4B: V3 Octopus Arm System
- [`Constants.js`](js/core/Constants.js): 120+ V3 constants
- [`ArmUnit.js`](js/entities/ArmUnit.js): ~800 LOC, 11-state machine
- [`ArmManager.js`](js/entities/ArmManager.js): ~410 LOC, fleet coordinator
- [`PlayerSatellite.js`](js/entities/PlayerSatellite.js): Octagonal prism main bus
- [`main.js`](js/main.js): Key bindings (G=deploy, F=fishing, H=recall)
- [`HUD.js`](js/ui/HUD.js): Arm status panel, mass budget panel

### Sprint 4C: Mass Budget + Passive Fishing
- HUD mass budget panel with Tsiolkovsky ΔV
- FISHING state — arms set nets and wait for debris to drift in

### Bug Fixes

| Fix | File(s) | Description |
|---|---|---|
| GPU 50% → ~15% | [`SceneManager.js`](js/scene/SceneManager.js), [`main.js`](js/main.js), [`SunLight.js`](js/scene/SunLight.js), [`Earth.js`](js/scene/Earth.js) | Replaced dual-composer with single-composer threshold bloom, 60fps cap, disabled shadows/MSAA |
| Flat NavSphere → 3D | [`NavSphere.js`](js/ui/NavSphere.js) | Radial gradient hemisphere shading, specular highlight, elliptical meridians, rim glow |
| 90° camera roll | [`CameraSystem.js`](js/systems/CameraSystem.js) | Fixed `camera.up` in all 5 code paths, canonical theta departure, `_lastVelDir` caching |
| NavSphere too small | [`NavSphere.js`](js/ui/NavSphere.js) | SPHERE_RADIUS 70→110px, all elements scaled proportionally |
| Menu too dark | [`MenuScreen.js`](js/ui/MenuScreen.js) | Translucent dark blue gradient (55-78% opacity) replacing near-black (85-95%) |
| Streamlined startup | [`main.js`](js/main.js) | Menu Start → direct to ORBITAL_VIEW, skip briefing gate |
| Duplicate KeyG | [`main.js`](js/main.js) | Merged with `e.shiftKey` check |
| Stale fishing flag | [`ArmUnit.js`](js/entities/ArmUnit.js) | Clear `_fishingMode` on `deploy()` |
| Tether coordinates | [`ArmUnit.js`](js/entities/ArmUnit.js) | World-coords → group-local conversion |
| Uninitialized fields | [`ArmUnit.js`](js/entities/ArmUnit.js) | Added constructor init for fishing state fields |
| Safari deviceMemory | [`Earth.js`](js/scene/Earth.js) | Default to 8 when `navigator.deviceMemory` undefined |
| Antimeridian seam | [`Earth.js`](js/scene/Earth.js) | `RepeatWrapping` → `ClampToEdgeWrapping` |

### Design Documents Created (Sessions 1-4)

| Document | Lines | Content |
|---|---|---|
| [`V3 Octopus.md`](archive/V3%20Octopus.md) | 1,814 | Complete V3 ADR satellite design |
| [`V4 Opussy.md`](archive/V4%20Opussy.md) | 601 | V4 graphene/GSL upgrade path |
| [`RESEARCH_ARCHIVE.md`](archive/RESEARCH_ARCHIVE.md) | — | ADR sizing, Indian rockets, arm design |

### Sprint 5: Tier 0 + Tier 1 (Game Feel)

- **Tier 0:** Resource authority fix — [`ResourceSystem`](js/systems/ResourceSystem.js) became sole canonical owner; `GameState.resources` removed; push-only sync via `_syncToPlayer()`
- [`Events.js`](js/core/Events.js): Created 118 LOC event name constants registry
- [`TargetSelector.js`](js/systems/TargetSelector.js): Created 66 LOC clean replacement for gutted InteractionSystem
- Deleted dead files: `DaughterSatellite.js`, `InteractionSystem.js`, `CaptureSystem.js`
- [`HUD.js`](js/ui/HUD.js): Arm range badges (●/◐/○), ΔV transfer fuel costs in target list
- [`NavSphere.js`](js/ui/NavSphere.js): I-War vertical stalks (lines from dots to equatorial plane)
- [`HUD.js`](js/ui/HUD.js): FS2-style comms menu (C key → 1–5 numbered commands)

### Sprint 6: Tiers 2–4 (Wireframe, ARM PILOT, Shop, Persistence)

**Tier 2 — Debris Wireframe Analysis:**
- [`DebrisWireframe.js`](js/ui/DebrisWireframe.js): New file 783 LOC — Canvas2D wireframe with 4 debris shapes, zone coloring, Z/Shift+Z cycling, approach recommendations

**Tier 3 — ARM PILOT Mode:**
- [`DockingReticle.js`](js/ui/DockingReticle.js): New file 555 LOC — crosshair/alignment overlay
- [`CameraSystem.js`](js/systems/CameraSystem.js): ARM_PILOT view (40° FOV, not in V-cycle, P key toggle)
- [`ArmUnit.js`](js/entities/ArmUnit.js): Manual pilot mode (WASD→FEEP, Space→net deploy), engineered auto-failure at debris #10
- [`ScoringSystem.js`](js/systems/ScoringSystem.js): ×1.3 tactical + ×2.0 manual + ×1.25 fuel-efficient multipliers

**Tier 4A — Persistence:**
- [`PersistenceManager.js`](js/systems/PersistenceManager.js): New file 146 LOC — localStorage save/load
- [`ScoringSystem.js`](js/systems/ScoringSystem.js): `serialize()` / `restore()` methods
- [`ResourceSystem.js`](js/systems/ResourceSystem.js): `serialize()` / `restore()` methods
- [`MenuScreen.js`](js/ui/MenuScreen.js): "Continue" button when save exists

**Tier 4B — 17 Upgrades Wired (→ 20 with Session 10 salvage upgrades):**
- [`ShopScreen.js`](js/ui/ShopScreen.js): 20 upgrades across 6 categories, purchase flash animation, level badges
- Upgrade application across 7 systems: ResourceSystem, PlayerSatellite, SensorSystem, KesslerSystem, ArmManager, ArmUnit, GameState
- Fixed multi-level upgrade cumulative stacking bug in ResourceSystem
- Fixed ArmManager.reset() to preserve upgrades across missions

**Tier 4C — Shop Triggers + Roguelite:**
- [`GameState.js`](js/core/GameState.js): Added SHOP state + transitions (GAME_OVER → SHOP for roguelite continue)
- Shop triggers every 5 debris cleared; simulation pauses during shop
- Roguelite continue: 50% credit penalty → shop → retry

**Tier 4D — HUD Polish:**
- [`HUD.js`](js/ui/HUD.js): Credits counter (💰 X cr)
- [`GameOverScreen.js`](js/ui/GameOverScreen.js): Mission summary grid, continue button
- [`BriefingScreen.js`](js/ui/BriefingScreen.js): Mission number, credits context

### Session 9: Performance + Code Quality + Power Distribution

**Phase 1 — Performance Pass (8 files):**
- [`DebrisField.js`](js/entities/DebrisField.js): Eliminated ~800 spread allocations/frame with pre-allocated `_tmpKmOrbit`; frame-level spatial query cache (`getDebrisNear()` called 3× but computes 1×)
- [`ActiveSatellite.js`](js/entities/ActiveSatellite.js): Pre-allocated orbit + Vector3/Matrix4 temporaries
- [`ArmUnit.js`](js/entities/ArmUnit.js): Pre-allocated `_tmpVec` for hot-loop Vector3s
- [`CameraSystem.js`](js/systems/CameraSystem.js): Pre-allocated `_tmpVecA/B/C`, reused `_lastVelDir`
- [`NavSphere.js`](js/ui/NavSphere.js): Throttled Canvas2D redraw to 10Hz (every 6th frame)
- [`DebrisWireframe.js`](js/ui/DebrisWireframe.js): Throttled Canvas2D redraw to 15Hz (every 4th frame)
- [`SceneManager.js`](js/scene/SceneManager.js): Re-enabled bloom at strength 0.15 (was 0/disabled but still running)
- [`main.js`](js/main.js): Added `frameCount` for spatial cache + throttle coordination

**Phase 2 — Code Quality (20+ files):**
- [`Events.js`](js/core/Events.js): Added `ARM_MANUAL_THRUST`, `POWER_CHANGED`, `POWER_BUS_SELECTED`
- **100% Events.js migration** — All 110 raw `eventBus.emit('string')` calls replaced with `Events.*` constants across 20 files. Zero raw strings remaining.
- [`GameFlowManager.js`](js/systems/GameFlowManager.js): **NEW FILE** (857 LOC) — Extracted from main.js. Handles all state transitions (`transitionToState()`), 26 EventBus handlers, save/load, game reset, upgrade routing, shop triggers
- [`main.js`](js/main.js): Reduced from 1,218 → 488 LOC (60% reduction). Now thin bootstrap + game loop only.
- [`GameState.js`](js/core/GameState.js): Added `isGameplay()` method
- [`InputManager.js`](js/systems/InputManager.js): Uses `gameState.isGameplay()`

**Phase 3 — Power Distribution (11 files):**
- [`PowerDistribution.js`](js/systems/PowerDistribution.js): **NEW FILE** (220 LOC) — FS2-heritage ETS. 3 buses: THRUST/SENSORS/ARMS, default 40/30/30. Keys: 1-3 select bus, [ ] adjust ±10%. Piecewise-linear multiplier curve. Serialize/restore.
- [`PlayerSatellite.js`](js/entities/PlayerSatellite.js): `thrustIon()` blocked when thrust allocation = 0%, xenon efficiency scales with thrustMultiplier
- [`SensorSystem.js`](js/systems/SensorSystem.js): Detection range scales with sensorMultiplier
- [`ArmManager.js`](js/entities/ArmManager.js): Deploy blocked when arm allocation = 0%, beacon speed scaling
- [`ArmUnit.js`](js/entities/ArmUnit.js): Hauling/returning speed scales with `_beaconSpeedScale`
- [`StatusPanel.js`](js/ui/hud/StatusPanel.js): New "⚡ POWER ETS" HUD panel with 3 color-coded bars
- [`HUD.js`](js/ui/HUD.js): Power panel visibility tied to `showResources` in VIEW_INFO_LEVELS
- [`InputManager.js`](js/systems/InputManager.js): 1/2/3 for bus select (when comms not open), [ ] for adjust
- [`GameFlowManager.js`](js/systems/GameFlowManager.js): Save/load/reset includes power distribution
- [`main.js`](js/main.js): `powerDistribution.update()` in game loop

**New module count: 42 modules** (was 39: +GameFlowManager.js, +PowerDistribution.js, +ForgeSystem.js [S11])

### Session 7: Tier 4 Bug Fixes + Tier 5 Code Quality

**Tier 4 Bug Fixes (6 items):**
1. **Menu help text** — [`MenuScreen.js`](js/ui/MenuScreen.js): Updated stale key bindings in help text
2. **Retry save leak** — [`main.js`](js/main.js): Added `persistenceManager.deleteSave()` before retry reset to prevent stale saves persisting
3. **ΔV budget display** — [`ArmManager.js`](js/entities/ArmManager.js): Now reads upgraded xenon/coldGas maxes from ResourceSystem instead of base constants
4. **Whipple Shield** — All 3 collision handlers in [`main.js`](js/main.js) now check `kesslerSystem.shieldHits` and absorb hits with comms feedback
5. **Panel degradation** — [`ResourceSystem.js`](js/systems/ResourceSystem.js): `update()` now degrades `solarPanelHealth` at base 0.008%/s (halved with Rad-Hard Panels upgrade), floor at 30%
6. **IR Scanner** — [`DebrisField.js`](js/entities/DebrisField.js): Debris now has probabilistic `tracked` property; [`HUD.js`](js/ui/HUD.js), [`NavSphere.js`](js/ui/NavSphere.js), and Tab cycling filter untracked debris unless IR Scanner upgrade is active

**Tier 5 Code Quality (4 items):**
1. **DebugOverlay.js** — [`DebugOverlay.js`](js/ui/DebugOverlay.js): New file ~120 LOC, Ctrl+D toggleable FPS/frame time/entity count/WebGL stats overlay
2. **InputManager.js** — [`InputManager.js`](js/systems/InputManager.js): New file ~395 LOC, extracted all keyboard handling from [`main.js`](js/main.js), reducing main.js by ~289 LOC (1,422→~1,209)
3. **Events.js migration** — 73 raw event string literals replaced with `Events.*` constants across [`main.js`](js/main.js), [`InputManager.js`](js/systems/InputManager.js), [`AudioSystem.js`](js/systems/AudioSystem.js), [`HUD.js`](js/ui/HUD.js)
4. **HUD.js split** — [`HUD.js`](js/ui/HUD.js) split into 3 sub-panels: [`StatusPanel.js`](js/ui/hud/StatusPanel.js) (~413 LOC initial, now ~502 with Power ETS), [`TargetPanel.js`](js/ui/hud/TargetPanel.js) (318 LOC), [`CommsPanel.js`](js/ui/hud/CommsPanel.js) (368 LOC); HUD.js reduced from 1,303 to ~472 LOC coordinator

---

## Appendix A: Startup Loadout Options

### Scout

```
Ship mass: 800 kg
Xenon: 80 kg / 80 max
Cold gas: 10 kg / 10 max
Battery: 4000 / 4000 Wh
Solar: 15 m²
Thruster: Hall-Effect Mk.I
Tools: Laser Ablation, Basic Robotic Arm
Sensors: EO (50km)
Playstyle: Fast, cheap missions — good for learning
```

### Wrangler (Recommended)

```
Ship mass: 1500 kg
Xenon: 100 kg / 100 max
Cold gas: 15 kg / 15 max
Battery: 5000 / 5000 Wh
Solar: 20 m²
Thruster: Hall-Effect Mk.I
Tools: Laser Ablation, Basic Robotic Arm, Net Launcher (3 nets)
Sensors: EO (50km), IR (30km)
Playstyle: Balanced — best for first run
```

### Heavy Hauler

```
Ship mass: 3000 kg
Xenon: 150 kg / 150 max
Cold gas: 25 kg / 25 max
Battery: 8000 / 8000 Wh
Solar: 30 m²
Thruster: Hall-Effect Mk.I (fuel-hungry due to mass)
Tools: Laser Ablation, Robotic Arm, Tether
Sensors: EO (50km), IR (30km), LIDAR (5km)
Playstyle: Tackle big targets early — but burns fuel fast
```

## Appendix B: Implementation Priority

### What's Been Built (Sessions 1-9)

**Sessions 1-2:** Visual foundation, Earth rendering, arm system, NavSphere, basic HUD
**Session 3:** Core gameplay loop, unified capture design, HUD feedback, visual fixes
**Session 4:** Procedural audio, Orbit View panel, HUD layout overhaul, UX improvements
**Session 5 (Tier 0-1):** Resource authority fix, Events.js, TargetSelector, arm range badges, ΔV transfer costs, comms menu, NavSphere stalks, dead file cleanup
**Session 6 (Tier 2-4):** Debris wireframe (783 LOC), ARM PILOT mode + DockingReticle (555 LOC), scoring multipliers, PersistenceManager (146 LOC), 17 shop upgrades wired, SHOP state, roguelite continue, HUD credits, mission summary
**Session 7 (Tier 4 fixes + Tier 5):** 6 Tier 4 bug fixes (menu text, retry leak, ΔV budget, Whipple Shield, panel degradation, IR Scanner), InputManager.js extraction (~395 LOC initial), DebugOverlay.js (~120 LOC), HUD.js split into 3 sub-panels (StatusPanel/TargetPanel/CommsPanel), 73 Events.js string literal migrations
**Session 9 (Perf + Quality + Power):** Performance pass (spread alloc elimination, spatial cache, Vector3 pre-alloc, Canvas2D throttle, bloom re-enable), GameFlowManager.js extraction (~866 LOC, main.js 1,218→~497), 100% Events.js migration (110 raw strings → Events.* across 20 files), PowerDistribution.js (~221 LOC, FS2 ETS with 3 buses). Files grown: StatusPanel.js (~502), ArmManager.js (~528), InputManager.js (~431), DebrisField.js (~930), PlayerSatellite.js (~1,267), ArmUnit.js (~1,013), SensorSystem.js (~284).
**Session 10 (Target Analysis + Salvage + Arm Economy):** 19 files modified across 3 phases + UI polish:
- **Phase 10A — Target Analysis Integration:** DebrisWireframe.js (783→~1,120 LOC) restructured into right-column flexbox above target list, ADR satellite self-view (`buildADRSatellite()` with 1.5× vertex scaling), 5 wireframe shapes, container-mountable constructor, VIEW_SCALE 200, salvage indicators. HUD.js (472→~540) creates right-column container + wireframe, `showAnalysis` in VIEW_INFO_LEVELS, `tabIndex=-1` focus fix. main.js no longer creates standalone wireframe.
- **Phase 10B — Salvageable Debris Resources:** Constants.js (213→267) +40 salvage constants. DebrisField.js (930→1,017) `_generateSalvage()` per debris (Xe, In, GaAs, battery, hydrazine). GameFlowManager.js (866→~1,040) salvage recovery in ARM_RETURNED handler (Xe→fuel, In→arm refuel, GaAs→panel health, hydrazine→cold gas with upgrade gate), refineryMult ×1.5 with upgrade. ResourceSystem.js `replenishPanelHealth()`. TargetPanel.js ⛏ salvage icons + contextual `[Tab] [G] [Z] [D]` keyboard hints. ScoringSystem.js ×1.15 salvage multiplier. ShopScreen.js +3 upgrades (Salvage Scanner, Hazmat Handler, Micro-Refinery, 17→20 total). SensorSystem.js `canScanSalvage` property.
- **Phase 10C — Arm Economy (Deorbit Sacrifice):** ArmUnit.js (1,013→1,088) 12th state DEORBITING, `startDeorbit()`, `_updateDeorbiting()`. ArmManager.js (528→568) `deorbitCapturingArm()`. GameFlowManager.js ARM_DEORBIT handler (ΔV calc, perigee drop, tiered multipliers ×1.2–×2.5). InputManager.js D key. CommsPanel.js option 6. AudioSystem.js `playDeorbitBurn()` (descending noise + sawtooth).
**Session 11 (HUD Redesign R1-R9):** 14 files modified across 9 phases + post-audit bugfixes:
- **R1 — Propulsion Panel Restructure:** Renamed RESOURCES → PROPULSION in StatusPanel.js. ΔV bar at top with embedded text overlay and 5-tier visual (30/15/5/1%). Labels changed to `Xenon`/`Gas`/`Bat` (no colons, 42px width). Removed `.hud-bar-cyan`/`.hud-bar-yellow` CSS from index.html. Panel widths standardized to 220px.
- **R2 — Fleet Panel + Hotkey Bar:** Renamed arms panel → 🐙 FISHING FLEET with 4 functional state colors. Hotkey bar reduced from 12 → 5 items in HUD.js. ArmUnit.getStatus() extended with `remainingDeltaV`.
- **R3 — Forge/Anchor/Contract Consolidation:** Standalone forge panel removed; forge inlined into Propulsion panel (hidden until first CARGO_STORE). Contract info moved to score bar ⚓ anchor. FORGE_TOGGLE event + R key cycling OFF→REFINE→PROPELLANT→OFF. ForgeSystem.js `toggle()` method.
- **R4 — Color Consolidation:** 5-color system (Green `#00ff88`, Amber `#ffaa00`, Red `#ff4444`, Blue `#4488ff`, White `#ccddcc`). Constants.HUD block + Constants.AUDIO block. TargetReticle colors updated. Bar thresholds unified to 30%/15%.
- **R5 — Hover-to-Expand:** CSS hover-to-expand for Propulsion (Mass Budget + Solar), Energy (hint), Fleet (arm ΔV). New CSS classes: `.hud-panel-expandable`, `.panel-expand-section`, `.arm-hover-detail`, `.energy-hint`. `max-height`/`opacity` transitions, `pointer-events: auto`.
- **R6 — Reticle Tactical Additions:** Closure rate + ETA on prograde. Post-burn ΔV on retrograde with color coding. Top-2 metal loot preview on brackets. Periapsis burn hint. `DELTAV_UPDATE` event, predictive ΔV via Tsiolkovsky.
- **R7 — OrbitMFD Educational Labels:** Ap/Pe labels (ecc > 0.01) or "Circular: ~{alt}km". Hohmann ΔV₁/ΔV₂ at burn points. Inclination diff near target. Prograde arrow on player marker.
- **R8 — Audio Missing Sounds + Ambient:** 6 new earcons (playTabSelect, playFuelCycle, playCargoStored, playForgeComplete, playTrawlCapture, modified playWarning). Ambient loop (bandpass noise + solar hiss). Event wiring for 6 new events.
- **R9 — Audio Urgency Ramp + Sputtering:** 4-tier ΔV alarm (intervals at 15%/8%/3%/0%). Backward compat wrappers. Thruster sputtering below 5%. All wired via DELTAV_UPDATE from StatusPanel.
- **Post-audit bugfixes:** Power panel width 210→220px; updateThrusterFuelState() wired via DELTAV_UPDATE; updateAmbientState() wired via extended DELTAV_UPDATE payload.

### Session 12: Post-Gameplay Bugfix Pass (v11.0)

**15 issues found and fixed** across 4 severity levels (5 critical, 3 major, 5 minor, 2 UX). Issue report in [`ISSUES_POST_GAMEPLAY.md`](ISSUES_POST_GAMEPLAY.md).

**Key changes:**
- **Tutorial defaults to FREE_PLAY / inactive** — progressive reveal disabled (caused catch-22 hiding essential UI). [`TutorialSystem.js`](js/systems/TutorialSystem.js) *(deleted in Sprint 3 ST-3.2)* `stage = FREE_PLAY`, `active = false`
- **Lasso scoring wired** — [`LassoSystem._completeCatch()`](js/systems/LassoSystem.js) now emits both `INTERACTION_CAPTURE` and `SCORING_AWARD`, connecting lasso catches to the ScoringSystem pipeline and incrementing `debrisCleared`
- **Weather effects now functional** — [`SensorSystem.js`](js/systems/SensorSystem.js) and [`ResourceSystem.js`](js/systems/ResourceSystem.js) listen to `WEATHER_ACTIVE`, applying `_weatherSensorMult` and `_weatherSolarMult` respectively (sensor range ×0.7 during solar flares, solar power modifiers during eclipses/storms)
- **Trawl system moves mothership** — [`TrawlManager.update()`](js/systems/TrawlManager.js) now applies orbital traversal via `player.orbit.trueAnomaly += traverseSpeed * dt`, with player reference passed from [`main.js`](js/main.js)
- **Pause menu with return-to-menu** — ESC during gameplay shows a pause overlay (via [`HUD.showPause()`](js/ui/HUD.js)) with Resume and Return to Menu buttons
- **Moon/Sun label occlusion fixed** — `depthTest: true` on label sprites in [`SunLight.js`](js/scene/SunLight.js) (was `false`; log depth buffer provides adequate precision)
- **6 raw events registered in Events.js** — `LASSO_FIRED`, `LASSO_CONTACT`, `LASSO_CAPTURED`, `TUTORIAL_STAGE_CHANGED`, `TUTORIAL_SKIPPED`, `TUTORIAL_TETHER_LIMIT` added to [`Events.js`](js/core/Events.js); raw strings replaced in [`LassoSystem.js`](js/systems/LassoSystem.js) and [`TutorialSystem.js`](js/systems/TutorialSystem.js) *(deleted in Sprint 3 ST-3.2)*
- **ESC de-overloaded** — ESC no longer skips tutorial; tutorial skip moved to dedicated interaction. ESC priority: exit ARM_PILOT → toggle pause
- **Lasso audio wired** — [`AudioSystem.setupEventListeners()`](js/systems/AudioSystem.js) subscribes to `LASSO_FIRED` and `LASSO_CONTACT` events
- **Tutorial keybar cleanup** — [`TutorialSystem._startStage(FREE_PLAY)`](js/systems/TutorialSystem.js) *(deleted in Sprint 3 ST-3.2)* sets `active = false` and hides `#tutorial-keybar`, preventing overlap with HUD hotkey bar
- **MENU_START full reset** — [`GameFlowManager`](js/systems/GameFlowManager.js) `MENU_START` handler now calls `resetGame()` for full system reset (resources, arms, comms, kessler, power, tutorial)
- **HUD flash fix** — Tutorial stage advanced before `hud.show()` in `transitionToState(ORBITAL_VIEW)`

**Files modified by area:**
- **Core:** [`Events.js`](js/core/Events.js) (+6 event constants)
- **Systems:** [`GameFlowManager.js`](js/systems/GameFlowManager.js), [`TutorialSystem.js`](js/systems/TutorialSystem.js) *(deleted in Sprint 3 ST-3.2)*, [`LassoSystem.js`](js/systems/LassoSystem.js), [`SensorSystem.js`](js/systems/SensorSystem.js), [`ResourceSystem.js`](js/systems/ResourceSystem.js), [`TrawlManager.js`](js/systems/TrawlManager.js), [`AudioSystem.js`](js/systems/AudioSystem.js), [`InputManager.js`](js/systems/InputManager.js)
- **Scene:** [`SunLight.js`](js/scene/SunLight.js) (label `depthTest`)
- **UI:** [`HUD.js`](js/ui/HUD.js) (pause overlay, flash fix)
- **Entities:** [`ArmUnit.js`](js/entities/ArmUnit.js), [`PlayerSatellite.js`](js/entities/PlayerSatellite.js)
- **Bootstrap:** [`main.js`](js/main.js) (player ref to TrawlManager)

### Session 13: NEXT_STEPS F1–F18 Complete (v12.0)

All 18 features from [`NEXT_STEPS.md`](NEXT_STEPS.md) roadmap implemented. 22 files modified, 2 new files created.

**Phase 13A — DPI Scaling & Readability (F1–F8):**
- **F1:** Dark-pill text contrast on ΔV bar in [`StatusPanel.js`](js/ui/hud/StatusPanel.js) — `background: rgba(0,0,0,0.4); padding: 0 4px; border-radius: 2px`
- **F2:** DPI-aware canvas scaling in [`DebrisWireframe.js`](js/ui/DebrisWireframe.js) — `devicePixelRatio` × dimensions, CSS scale-down, `ctx.scale(dpr, dpr)`
- **F3:** Enlarged wireframe panel (260→320px height, VIEW_SCALE 200→240), `[Z]` hotkey hint in header, font bumps
- **F4:** DPI scaling + `imageSmoothingEnabled` in [`NavSphere.js`](js/ui/NavSphere.js)
- **F5:** DPI scaling + `imageSmoothingEnabled` in [`TargetReticle.js`](js/ui/TargetReticle.js)
- **F6:** DPI scaling + `imageSmoothingEnabled` in [`OrbitMFD.js`](js/ui/OrbitMFD.js); route label y-coordinate bugfix
- **F7:** DPI scaling + `imageSmoothingEnabled` in [`DockingReticle.js`](js/ui/DockingReticle.js)
- **F8:** DOM font size review in [`StatusPanel.js`](js/ui/hud/StatusPanel.js) — minimum 10px for all text, 11px for labels

**Phase 13B — Visual Depth (F9–F10):**
- **F9:** Planet/star occlusion — depth mask meshes (`CircleGeometry`, `depthWrite: true`) for Sun, Moon, planets at r=398 inside star sphere r=400 in [`SunLight.js`](js/scene/SunLight.js); explicit `depthTest: true` on constellation lines/labels in [`Starfield.js`](js/scene/Starfield.js)
- **F10:** RCS thruster puffs in [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) — pool of 8 `THREE.Sprite` instances with additive blending, 6 thruster nozzle positions, 0.5s opacity fadeout

**Phase 13C — HUD Layout Evolution (F11–F12):**
- **F11:** Horizontal-expand left panels in [`StatusPanel.js`](js/ui/hud/StatusPanel.js) + [`index.html`](index.html) — `.hud-panel-h-expand` CSS class, PROPULSION + ENERGY panels collapse to 110px (mini-bar + fuel pips), expand to 260px on hover with `width` transition + `overflow: hidden`
- **F12:** Fleet panel collapsed single-row summary — `🐙 FLEET: 4 ●DOCKED  1 ●TRANSIT  1 ●FISHING` in [`StatusPanel.js`](js/ui/hud/StatusPanel.js) + `.fleet-collapsed-summary` CSS in [`index.html`](index.html)

**Phase 13D — Control Scheme (F13–F15):**
- **F13:** Arrow keys → rotation in [`InputManager.js`](js/systems/InputManager.js) + [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) — `rotatePitch()`/`rotateYaw()` methods, `_manualRotation` quaternion applied per frame
- **F14:** Throttle level (+/- keys) in [`InputManager.js`](js/systems/InputManager.js) + [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) — `throttleLevel` (0–100% in 10% increments), `setThrottleLevel()`, throttle gauge in [`StatusPanel.js`](js/ui/hud/StatusPanel.js), `THROTTLE_CHANGE` event
- **F15:** Autopilot system — **NEW FILE** [`AutopilotSystem.js`](js/systems/AutopilotSystem.js) (~200 LOC) with 4-tier heading priority, ΔV safety (50 m/s engage / 30 m/s emergency disengage), orbital-frame thrust. A key toggle in [`InputManager.js`](js/systems/InputManager.js). Autopilot indicator + heading + ETA in [`StatusPanel.js`](js/ui/hud/StatusPanel.js). `AUTOPILOT_ENGAGE`/`AUTOPILOT_DISENGAGE` events in [`Events.js`](js/core/Events.js). Instantiation + wiring in [`main.js`](js/main.js)

**Phase 13E — MPD Thruster (F16):**
- **F16:** MPD thruster — 25N thrust, Isp 3000s, 150kW power draw, lithium propellant, cathode erosion (600s life). [`Constants.js`](js/core/Constants.js) MPD parameter block + salvage probabilities. [`ShopScreen.js`](js/ui/ShopScreen.js) upgrade with `requiresAll` prerequisite (`efficient_panels` + `extra_battery`). [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) `thrustMPD()` + cathode tracking. [`ResourceSystem.js`](js/systems/ResourceSystem.js) lithium resource (add/consume/serialize/restore). [`DebrisField.js`](js/entities/DebrisField.js) lithium salvage (8% on defunct sats). [`GameFlowManager.js`](js/systems/GameFlowManager.js) lithium salvage processing. [`TargetPanel.js`](js/ui/hud/TargetPanel.js) lithium target hints. [`StatusPanel.js`](js/ui/hud/StatusPanel.js) lithium bar + cathode display. Events: `MPD_FIRE`, `MPD_CATHODE_WORN`, `LITHIUM_CHANGE`

**Phase 13F — Tech Library & Tutorial Design (F17–F18):**
- **F17:** Tech Library Viewer UI — **NEW FILE** [`CodexViewerUI.js`](js/ui/CodexViewerUI.js) (~300 LOC) DOM overlay with category sidebar (9 categories), 45 scrollable entry cards, detail view, unseen badge (player-facing name: "Tech Library"). L key toggle in [`InputManager.js`](js/systems/InputManager.js). `setCodexSystem()` delegation in [`HUD.js`](js/ui/HUD.js). Tech library badge in [`StatusPanel.js`](js/ui/hud/StatusPanel.js). Instantiation + wiring in [`main.js`](js/main.js)
- **F18:** Tutorial re-enablement design document — [`TUTORIAL_REDESIGN.md`](archive/TUTORIAL_REDESIGN.md) (620 lines) covering guaranteed debris spawning, progressive reveal fixes, skip button, reduced progression thresholds — **fully implemented Session 20**

**New module count: 44 modules** (was 42: +[`AutopilotSystem.js`](js/systems/AutopilotSystem.js), +[`CodexViewerUI.js`](js/ui/CodexViewerUI.js))

**Files modified (22):** [`main.js`](js/main.js), [`Constants.js`](js/core/Constants.js), [`Events.js`](js/core/Events.js), [`PlayerSatellite.js`](js/entities/PlayerSatellite.js), [`DebrisField.js`](js/entities/DebrisField.js), [`SunLight.js`](js/scene/SunLight.js), [`Starfield.js`](js/scene/Starfield.js), [`InputManager.js`](js/systems/InputManager.js), [`GameFlowManager.js`](js/systems/GameFlowManager.js), [`ResourceSystem.js`](js/systems/ResourceSystem.js), [`StatusPanel.js`](js/ui/hud/StatusPanel.js), [`TargetPanel.js`](js/ui/hud/TargetPanel.js), [`HUD.js`](js/ui/HUD.js), [`DebrisWireframe.js`](js/ui/DebrisWireframe.js), [`NavSphere.js`](js/ui/NavSphere.js), [`TargetReticle.js`](js/ui/TargetReticle.js), [`OrbitMFD.js`](js/ui/OrbitMFD.js), [`DockingReticle.js`](js/ui/DockingReticle.js), [`ShopScreen.js`](js/ui/ShopScreen.js), [`index.html`](index.html)
**Files created (2):** [`AutopilotSystem.js`](js/systems/AutopilotSystem.js), [`CodexViewerUI.js`](js/ui/CodexViewerUI.js)
**Design docs created (1):** [`TUTORIAL_REDESIGN.md`](archive/TUTORIAL_REDESIGN.md)

### Session 16: FULL_HUD_STRATEGY Implementation (2026-04-09)

All 8 phases of [`FULL_HUD_STRATEGY.md`](FULL_HUD_STRATEGY.md) implemented across 5 delegate tasks. ~960 LOC across 16 files. 1 new file created.

**HUD-1: Comms + Luminance + Hotkey Removal (Phases 1-3):**
- [`HUD.js`](js/ui/HUD.js): Progressive luminance — `.hud-dormant`/`.hud-active` CSS classes replace `display: none`. `setTutorialVisibility(stage)` activates `data-hud-group` elements. Hotkey bar removed.
- [`CommsPanel.js`](js/ui/hud/CommsPanel.js): Always visible from tutorial stage 0. `C` toggles command menu only during tutorial.
- [`TutorialSystem.js`](js/systems/TutorialSystem.js) *(deleted in Sprint 3 ST-3.2)*: All 10 stage messages route through CommsSystem as Houston. MW2-style contextual prompts (persistent, right-aligned above comms panel at bottom:145px right:10px, max-width 280px). Tutorial keybar removed. 10-stage sequence: INTRO→LOOK_AROUND→WASD_MOVE→THROTTLE→LASSO→FIRST_ARM→MULTI_ARM→BIG_GAME→AUTOPILOT→FREE_PLAY *(superseded by Session 22 resequence: BEAUTY→LOOK_AROUND→SCAN→TARGET_SELECT→AUTOPILOT→CAMERA→LASSO→DEPLOY→TOOL_MASTERY→FREE_PLAY)*. Lasso miss recovery prompts during LASSO stage (listens for `LASSO_DENIED` and `LASSO_MISSED`, shows contextual guidance, auto-recovers to "[SPACE] Cast Lasso" after 2–4 s).
- [`StatusPanel.js`](js/ui/hud/StatusPanel.js): `data-hud-group` attributes on score/fuel/cargo/power/thermal/arms sections.
- [`TargetPanel.js`](js/ui/hud/TargetPanel.js): `data-hud-group` attributes on target-list/target-detail sections.

**HUD-2: Velocity Streaks (Phase 4):**
- NEW: [`VelocityStreaks.js`](js/ui/VelocityStreaks.js) (~200 LOC) — Canvas2D radial streak overlay (blue prograde, red retrograde, white lateral).
- [`PlayerSatellite.js`](js/entities/PlayerSatellite.js): Emits `THRUST_VISUAL` event with `{ magnitude, direction, type }`.
- [`CameraSystem.js`](js/systems/CameraSystem.js): FOV breathe ±2-3° during sustained thrust.
- [`main.js`](js/main.js): VelocityStreaks wired into render loop.

**HUD-3: Target Lock Ceremony (Phase 5):**
- [`TargetReticle.js`](js/ui/TargetReticle.js): Lock-on bracket shrink (2.5×→1×, 300ms), white corner flash. Target-lost expand+fade (200ms).
- [`AudioSystem.js`](js/systems/AudioSystem.js): `playTargetLock()` (C5→E5 ascending), `playTargetLost()` (E5→C5 descending).

**HUD-4: Lasso Feedback Overhaul (Phase 6):**
- [`LassoSystem.js`](js/systems/LassoSystem.js): 5-layer feedback stack — fire (THWIP + muzzle flash + micro-shake), flight (comet trail + wire whistle), contact (CLANK + ring), reel-in (tether oscillation + winch), cooldown (arc indicator + denied feedback).
- [`AudioSystem.js`](js/systems/AudioSystem.js): `playLassoFire()`, `playLassoDenied()`, `playLassoReel()`.
- [`TargetReticle.js`](js/ui/TargetReticle.js): Cooldown arc around crosshair + denied flash.
- [`Events.js`](js/core/Events.js): Added `LASSO_DENIED`, `LASSO_MISSED`.

**HUD-5: Docking Audio + Autopilot + Alarm Suppression (Phases 7-8):**
- [`DockingReticle.js`](js/ui/DockingReticle.js): 4-tier proximity beeping wired to computed range + alignment confirmation tone.
- [`AutopilotSystem.js`](js/systems/AutopilotSystem.js): Emits heading data for indicator.
- [`TargetReticle.js`](js/ui/TargetReticle.js): Amber "◉ AP → [target]" indicator + dashed heading line.
- [`AudioSystem.js`](js/systems/AudioSystem.js): AP disengage tone.
- 5 systems with skill-gated alarm suppression (migrated from `tutorialStage` gates to [`SkillsSystem.isDiscovered()`](js/systems/SkillsSystem.js) in Sprint 3 ST-3.2): [`SpaceWeatherSystem.js`](js/systems/SpaceWeatherSystem.js), [`ConjunctionSystem.js`](js/systems/ConjunctionSystem.js), [`KesslerSystem.js`](js/systems/KesslerSystem.js), [`PowerDistribution.js`](js/systems/PowerDistribution.js), [`SensorSystem.js`](js/systems/SensorSystem.js).

**New module count: 45 modules** (was 44: +[`VelocityStreaks.js`](js/ui/VelocityStreaks.js))

### Session 17: V5 Crossbow Arms (2026-04-12)

Replaced FEEP ion thrust arm deployment with spring-loaded crossbow mechanism. 9 files modified, ~1,600 LOC added. 133 new tests (88 Node + 45 browser). Documentation consolidated: 16→8 active files + 5 archived.

**Implementation:**
- [`Constants.js`](js/core/Constants.js): 42 V5 constants (spring physics, reload, reel, dual-fire, scan, ablation, tiers) + 6 new ARM_STATES
- [`Events.js`](js/core/Events.js): 13 crossbow lifecycle events (fire, reload, tether, dual-fire, scan, ablation)
- [`ArmUnit.js`](js/entities/ArmUnit.js): Spring physics launch, 6 new state handlers (LAUNCHING, REELING, RELOADING, ABLATING, SCANNING, TANGLED), zero-fuel REELING, upgrade tiers
- [`ArmManager.js`](js/entities/ArmManager.js): 8-arm fleet (3W+3S+F+B), dual-fire coordination, pulse scan, fleet upgrades
- [`PlayerSatellite.js`](js/entities/PlayerSatellite.js): Crossbow recoil, auto-RCS N₂ compensation, thruster interlock, 8 tether reels
- [`StatusPanel.js`](js/ui/hud/StatusPanel.js): 8-arm display with reload bars, tension color, tangle/scan/interlock warnings
- [`HUD.js`](js/ui/HUD.js): Crossbow fire flash, STABILIZE warning, tether snap alert
- [`ShopScreen.js`](js/ui/ShopScreen.js): 5-tier spring + 5-tier tether upgrade categories
- [`GameFlowManager.js`](js/systems/GameFlowManager.js): Routing for springTier/tetherTier upgrades

**Tests:**
- [`test-Crossbow-Constants.js`](js/test/test-Crossbow-Constants.js): 88 tests (7 suites) — Node + Browser
- [`test-Crossbow-ArmUnit.js`](js/test/test-Crossbow-ArmUnit.js): 54 tests (12 suites) — Node + Browser
- [`test-CollisionAvoidance.js`](js/test/test-CollisionAvoidance.js): 53 tests (5 suites) — Node [S19]
- **Total: 278 Node tests (44 suites, 9 test files)**

**Documentation consolidation:**
- 16 docs → 6 active + 12 archived in `archive/`
- Created [`GAME_DESIGN.md`](GAME_DESIGN.md) (merged ROADMAP + GAMEPLAY_LOOP + MASTER_PLAN)
- Created [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md) — V5 crossbow arm system design bible
- Updated [`README.md`](README.md) with current status and doc guide

**New module count: 45 modules** (unchanged — crossbow replaces existing arm system, no new modules)

### Session 20: Tutorial System Overhaul (2026-04-13)

10-stage tutorial (was 9) with new WASD_MOVE stage, A-key conflict resolution, prompt repositioning, and UX improvements. 15 files modified.

**Key changes:**
- **New 10-stage sequence:** INTRO(0) → LOOK_AROUND(1) → WASD_MOVE(2) → THROTTLE(3) → LASSO(4) → FIRST_ARM(5) → MULTI_ARM(6) → BIG_GAME(7) → AUTOPILOT(8) → FREE_PLAY(9)
- **WASD_MOVE stage (new):** Inserted at position 2. Teaches lateral WASD thrust before throttle. Requires 3 WASD inputs to advance. New `TUTORIAL_WASD_INPUT` event emitted by [`InputManager.js`](js/systems/InputManager.js).
- **A-key conflict eliminated:** Autopilot rebound from A to backtick (`` ` ``), so A is now exclusively WASD left-strafe *(superseded by Session 22: A = autopilot again, backtick = tool cycle, WASD thrust removed from normal mode)*. The `_tutorialBlocksAutopilot` guard remains in [`AutopilotSystem.js`](js/systems/AutopilotSystem.js) as additional safety during early tutorial stages.
- **Tutorial prompt repositioned:** Moved from center-bottom (`top: 75%; left: 50%`) to right-aligned above comms panel (`bottom: 145px; right: 10px; max-width: 280px`). Skip button moved to `bottom: 145px; right: 300px`.
- **Sweep report suppressed:** [`SweepReportUI.show()`](js/ui/SweepReportUI.js) returns early during tutorial stages 0–8.
- **Competence skipping:** Catch/lasso handlers use `<=` instead of `===`, letting skilled players skip ahead multiple stages.
- **Persistent prompts:** All stage prompts use `duration: 0` (persistent until next stage) instead of timed auto-dismiss.
- **Reduced thresholds:** Arrow inputs 6→3, throttle inputs 4→2, WASD inputs 3 to advance.
- **Stage number ripple:** `TUTORIAL_MIN_STAGE` 5→6 in [`Constants.js`](js/core/Constants.js). Stage-gated checks updated in 7 peripheral files.

**Files modified (15):** [`Events.js`](js/core/Events.js), [`Constants.js`](js/core/Constants.js), [`TutorialSystem.js`](js/systems/TutorialSystem.js) *(deleted in Sprint 3 ST-3.2)*, [`HUD.js`](js/ui/HUD.js), [`InputManager.js`](js/systems/InputManager.js), [`AutopilotSystem.js`](js/systems/AutopilotSystem.js), [`SweepReportUI.js`](js/ui/SweepReportUI.js), [`DebrisField.js`](js/entities/DebrisField.js), [`SensorSystem.js`](js/systems/SensorSystem.js), [`SpaceWeatherSystem.js`](js/systems/SpaceWeatherSystem.js), [`PowerDistribution.js`](js/systems/PowerDistribution.js), [`SubsystemEvents.js`](js/systems/SubsystemEvents.js), [`ConjunctionSystem.js`](js/systems/ConjunctionSystem.js), [`KesslerSystem.js`](js/systems/KesslerSystem.js)
**Design doc archived:** [`TUTORIAL_REDESIGN.md`](archive/TUTORIAL_REDESIGN.md) → fully implemented

### Session 22: Control Scheme Redesign + Tutorial Resequence (2026-04-14)

Complete control scheme redesign: autopilot-first paradigm replaces manual-flight-first. WASD becomes a command cluster. 10-stage tutorial resequenced around curiosity-driven progressive discovery. ~20 files modified.

**Control Scheme Changes:**
- **A** = Autopilot toggle (was WASD left-thrust, then backtick)
- **S** = Quick Scan — 1.5s ping, resolves fragment data, $50 reward, 20% discovery chance
- **W** = Wide Scan — 4s deep scan, full zone data, $150 reward, 40% discovery chance
- **D** = Deploy recommended tool (auto-picks best capture method for selected target)
- **F** = Focus Action — context-sensitive smart button (no target → prompt Tab, has target → deploy)
- **Backtick (`)** = Cycle tool alternatives (MW2-style weapon scroll)
- **WASD mothership thrust REMOVED** from normal play (kept for arm pilot mode P-key only)
- **Arrow keys** rotation rate: 0.3 → 0.08 rad/s (more realistic for 500 kg satellite)

**New Systems:**
- **Active Scan** in [`SensorSystem.js`](js/systems/SensorSystem.js) — S/W key handlers, cooldowns (3s/12s), data overrides (30s/60s), discovery mechanics (20%/40%), survey rewards ($50/$150)
- **Auto-tool Recommendation** in [`TargetSelector.js`](js/systems/TargetSelector.js) — mass-based tool selection on `TARGET_SELECTED`, D-deploy, backtick-cycle through alternatives
- **Focus Action** in [`TargetSelector.js`](js/systems/TargetSelector.js) — context-sensitive F-key handler (priority chain: no target → Tab, has target → deploy, arm pilot → net)

**New 10-Stage Tutorial (resequenced):**
```
0 BEAUTY        — 5s to admire the view, auto-advance
1 LOOK_AROUND   — Arrow keys, 3 presses → advance
2 SCAN          — S key, single press → advance
3 TARGET_SELECT — Tab key → advance
4 AUTOPILOT     — A key, triggers autopilot to target
5 CAMERA        — V key during transit, 10s auto-advance
6 LASSO         — Space when close, lasso capture → advance
7 DEPLOY        — D key, deploy arm for bigger catches
8 TOOL_MASTERY  — Backtick + Z, cycle tools + analyze targets, 15s auto-advance
9 FREE_PLAY     — Everything unlocked
```

**Sweep report** suppressed during tutorial (stages 0-8). **Lasso miss recovery prompts** during LASSO tutorial stage.

**New Events:** `SCAN_PING`, `SCAN_WIDE_START`, `SCAN_WIDE_COMPLETE`, `SCAN_WIDE_CANCELLED`, `SCAN_DISCOVERY`, `TOOL_RECOMMENDED`, `TOOL_CYCLED`

**New Constants:** `SCAN_PING_COOLDOWN` (3.0), `SCAN_PING_POWER` (10), `SCAN_PING_OVERRIDE_DURATION` (30), `SCAN_PING_DISCOVERY_CHANCE` (0.20), `SCAN_WIDE_CHANNEL_TIME` (2.0), `SCAN_WIDE_COOLDOWN` (12.0), `SCAN_WIDE_POWER` (30), `SCAN_WIDE_OVERRIDE_DURATION` (60), `SCAN_WIDE_RANGE_FRACTION` (0.6), `SCAN_WIDE_DISCOVERY_CHANCE` (0.40), `SCAN_WIDE_MAX_DISCOVERIES` (3), `SCAN_SURVEY_REWARD_PING` (50), `SCAN_SURVEY_REWARD_WIDE` (150), `SCAN_SURVEY_REWARD_PER_NEW` (100), `SCAN_HISTORICAL_REWARD` (200), `SATELLITE_ROTATION_RATE` (0.3 → 0.08)

**Files modified (~20):** [`Events.js`](js/core/Events.js), [`Constants.js`](js/core/Constants.js), [`TutorialSystem.js`](js/systems/TutorialSystem.js) *(deleted in Sprint 3 ST-3.2)*, [`InputManager.js`](js/systems/InputManager.js), [`AutopilotSystem.js`](js/systems/AutopilotSystem.js), [`SensorSystem.js`](js/systems/SensorSystem.js), [`TargetSelector.js`](js/systems/TargetSelector.js), [`LassoSystem.js`](js/systems/LassoSystem.js), [`HUD.js`](js/ui/HUD.js), [`SweepReportUI.js`](js/ui/SweepReportUI.js), [`DebrisField.js`](js/entities/DebrisField.js), [`SpaceWeatherSystem.js`](js/systems/SpaceWeatherSystem.js), [`PowerDistribution.js`](js/systems/PowerDistribution.js), [`SubsystemEvents.js`](js/systems/SubsystemEvents.js), [`ConjunctionSystem.js`](js/systems/ConjunctionSystem.js), [`KesslerSystem.js`](js/systems/KesslerSystem.js)
**Design doc archived:** [`CONTROL_REDESIGN.md`](archive/CONTROL_REDESIGN.md) → fully implemented
**Tests:** 278 pass, 0 fail (44 suites, 9 test files — unchanged)

### What's Left to Build

- ✅ ~~All S1–S16 implementation work~~ (Sessions 1–16: core gameplay, HUD, audio, tutorial, persistence, 83 tests)
- ✅ ~~V5 Crossbow Arms~~ (Session 17: spring physics, 8-arm, dual-fire, pulse scan, 133 new tests, 9 files)
- ✅ ~~Reward Systems~~ (Session 18 V6: synergistic salvage 6 pairs, tiered field-clearing 50/75/100%, sweep report cards + SweepReportUI)
- ✅ ~~Risk-Reward Detach~~ (Session 18 V6: [X] key sacrifice, ×2.0 capture / ×2.5 deorbit, ARM_LOST −500 penalty, slo-mo)
- ✅ ~~Learning Systems~~ (Session 18 V6: codex expansion 45→105, space weather, subsystem events, 6 generators)
- ✅ ~~Visual polish~~ (Session 18 V6: moon CircleGeometry mesh, 5 planet discs, ecliptic positions)
- ✅ ~~_refs Decoupling~~ (Session 19: 23→6 refs, 11 decoupled via EventBus, 3 singleton exports, 3 new events)
- ✅ ~~Collision Avoidance AI~~ (Session 19: ~290 LOC system, 53 tests, design doc, Phases 1-2)
- ✅ ~~Tutorial Overhaul~~ (Session 20: 10-stage, then resequenced Session 22)
- ✅ ~~Control Redesign~~ (Session 22: autopilot-first, WASD command cluster, active scan, auto-tool, focus action, tutorial resequence)
- ❌ Manual playtesting of new control scheme + tutorial flow
- ❌ HUD scan progress indicator (S/W cooldown bars, wide scan progress)
- ❌ Kessler Cascade Visualization (visual effects for cascade events)
- ❌ Configurable MFD panels (Orbiter heritage)
- ❌ CA Phase 3 (shop upgrades, visual chevron indicator, audio cues)
- ❌ V4 GSL upgrade path (graphene tech tree — stubs exist in ArmManager.js)

See [`GAME_DESIGN.md`](GAME_DESIGN.md) and [`HANDOFF.md`](HANDOFF.md) for priorities and future directions.

## Appendix C: Data Structures Summary

```typescript
// Type reference (not actual TypeScript — documentation only)

type GameState = 'MENU' | 'BRIEFING' | 'ORBITAL_VIEW' | 'APPROACH'
  | 'INTERACTION' | 'SHOP' | 'GAME_OVER' | 'WIN';

type CameraView = 'FIRST_PERSON' | 'CHASE' | 'TARGET_LOCK' | 'ORBIT' | 'ARM_PILOT';

type ArmState = 'DOCKED' | 'LAUNCHING' | 'TRANSIT' | 'APPROACH' | 'NETTING'
  | 'GRAPPLED' | 'REELING' | 'RETURNING' | 'DOCKING' | 'RELOADING'
  | 'FISHING' | 'DEORBITING' | 'EXPENDED' | 'ABLATING' | 'SCANNING'
  | 'TANGLED' | 'UNDOCKING' | 'HAULING' | 'WEB_SHOT';

type ArmType = 'WEAVER' | 'SPINNER';

type DebrisType = 'fragment' | 'rocket_body' | 'defunct_sat' | 'mission_related';
type DebrisTier = 1 | 2 | 3 | 4;
type ScanLevel = 0 | 1 | 2 | 3;

type OrbitalElements = {
  a: number;    // Semi-major axis (km)
  e: number;    // Eccentricity (0-1)
  i: number;    // Inclination (rad)
  Ω: number;    // Right ascension of ascending node (rad)
  ω: number;    // Argument of periapsis (rad)
  M: number;    // Mean anomaly (rad)
};
```

### Session 8 Archived Content

The following content was preserved from `PROJECT_ANALYSIS.md` and `TIER4_ASSESSMENT.md` before those files were deleted during documentation cleanup.

#### Performance Profile (from PROJECT_ANALYSIS.md §7)

| Metric | Value |
|--------|-------|
| Frame rate | 60fps (capped) |
| GPU usage (M4 Max) | ~15-20% |
| Draw calls | ~20-25 (Earth 3 + debris 4 instanced + player 3-8 + sprites 5 + stars 1) |
| Post-processing | 4 passes (Render + Bloom×3-internal + SMAA) |
| Earth textures (8K) | ~48MB VRAM |
| All geometry | ~5MB (procedural) |
| JavaScript modules | ~4.0MB (44 modules) |
| Canvas2D overlays | ~6MB (HUD + NavSphere + OrbitMFD + TargetReticle + DebrisWireframe + DockingReticle) |
| Debris propagation | 800 interactive × Kepler solve (~24K trig ops/frame) |

**Potential bottlenecks:** NavSphere redraws at 60Hz (should throttle to 10Hz), ArmUnit tether geometry (24 segments) updates per frame per deployed arm, background debris (5,000) batch propagation at 1,250/frame, DebrisWireframe + DockingReticle Canvas2D overhead when active.

#### Design Heritage Synthesis (from PROJECT_ANALYSIS.md §9)

| Source | Innovation | Status |
|--------|-----------|--------|
| **I-War (1997)** | NavSphere 3D radar | ✅ [`NavSphere.js`](js/ui/NavSphere.js) with vertical stalks |
| **I-War** | Velocity vectors (prograde/retrograde) | ✅ [`TargetReticle.js`](js/ui/TargetReticle.js) |
| **I-War** | Sensor tiers (progressive reveal) | ⚠️ Framework in [`SensorSystem.js`](js/systems/SensorSystem.js) |
| **I-War** | Newtonian physics | ✅ Full Kepler in [`OrbitalMechanics.js`](js/entities/OrbitalMechanics.js) |
| **MW2 (1995)** | Heat gauge → ΔV budget bar | ✅ [`StatusPanel.js`](js/ui/hud/StatusPanel.js) with color transitions + audio alarm |
| **MW2** | Damage wireframe → debris analysis | ✅ [`DebrisWireframe.js`](js/ui/DebrisWireframe.js) — 4 shapes, zone coloring |
| **MW2** | F1/F2/F3 progressive views | ✅ COMMAND/TACTICAL/OVERVIEW in [`CameraSystem.js`](js/systems/CameraSystem.js) |
| **FreeSpace 2 (1999)** | Target wireframe box | ✅ [`DebrisWireframe.js`](js/ui/DebrisWireframe.js) with FS2-style subsystem targeting |
| **FreeSpace 2** | Lead indicator | ✅ [`TargetReticle.js`](js/ui/TargetReticle.js) |
| **FreeSpace 2** | Escort list → arm status | ✅ 🐙 FISHING FLEET panel in [`StatusPanel.js`](js/ui/hud/StatusPanel.js) |
| **FreeSpace 2** | Comms menu (C→number) | ✅ [`CommsPanel.js`](js/ui/hud/CommsPanel.js) — C key opens 1–6 numbered commands |
| **MW2 (1995)** | Autopilot (speed set + heading hold) | ✅ [`AutopilotSystem.js`](js/systems/AutopilotSystem.js) — 4-tier heading priority, slerp rotation, approach-from-behind, tool-aware arrival, A key toggle (S23 rewrite; S22 WASD cluster; S21 rebind; S13 initial) |
| **Orbiter (2000)** | MFD configurable panels | ⚠️ OrbitMFD exists, not independently configurable yet |
| **Orbiter** | Orbit visualization | ✅ [`OrbitMFD.js`](js/ui/OrbitMFD.js) with Hohmann arc |
| **Orbiter** | Docking MFD → ARM PILOT | ✅ [`DockingReticle.js`](js/ui/DockingReticle.js) + ARM_PILOT camera view |

#### Structural Strengths Validated (from TIER4_ASSESSMENT.md §5)

1. **Persistence round-trip** — Save at 6 trigger points, load with version check, restore to 3 systems with dedup logic. The `RESTORED_BY_RESOURCE_SYSTEM` Set prevents cumulative `+=` double-counting on load.
2. **Roguelite flow** — `gameover:continue` → 50% credit penalty → full system reset → `forEachPurchasedUpgrade` re-applies ALL upgrades → save → transition to SHOP. Multi-level upgrade re-application correctly iterates each level purchased.
3. **ArmManager upgrade persistence** — `_storedUpgrades` survives `reset()`, and `_reapplyStoredUpgrades()` runs after arm state reset.
4. **Multi-level cumulative fix** — `ResourceSystem.applyUpgrade()` uses `this.xenonMax += data.value` (not `= Constants.BASE + value`). Buying Extra Xenon Tank twice correctly gives 100+50+50=200.
5. **ShopScreen serialization** — `getSerializableUpgrades()` returns array with duplicates for multi-level, `restorePurchases()` counts them back into the Map. Clean round-trip.

---

*Document version: 23.0 — Post-Epic 8 (2026-04-25). 272 suites / 1,252 tests / 0 fail. 30 system modules + 7 entity modules + 22 UI modules. 10 active root docs + 21 archived.*
*Previous: 22.0 (Epic 6), 21.0 (Epic 5), 20.0 (Session 23), 19.0 (Session 22 Control Redesign), 18.0 (Session 21), 16.0 (Session 19 CA AI), 15.0 (Session 18 V6), 14.0 (Session 17), 13.0 (Session 16), 12.0 (Session 13), 11.0 (Session 12), 10.0 (Session 11), 9.0 (Session 10), 8.0 (Session 9), 7.0 (Session 8), 6.0 (Session 7), 5.0 (Session 6), 4.0 (Session 4), 3.0 (Session 2 audit), 2.0 (Session 1), 1.0 (initial plan)*
