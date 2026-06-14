# Space Cowboy — Architecture Blueprint

> **The single current source of truth for "how the code actually works."** Browser-based 3D orbital-debris-removal sim. Three.js (loaded from local `node_modules`), vanilla ES6 modules, **zero build tools**.
>
> **Verified against code: 2026-06-07** (architect ground-truth pass; supersedes the Epic-8-era doc, now in git history). Hotkey map §6 + capture-FSM notes re-verified 2026-06-11 (daughter-cycle polish, `80c70b5`). Hotkey cleanup 2026-06-13: de-spin laser `U`→`H`, capture = `N` only, `Space` lasso alias dropped. Where this doc and an older design doc disagree, **this doc wins** for as-built behavior. Design intent lives in [`GAME_DESIGN.md`](GAME_DESIGN.md), the forward plan in [`ROADMAP.md`](ROADMAP.md), and the live shift state + load-bearing SSOT rules in [`HANDOFF.md`](HANDOFF.md).
>
> **Test baseline:** 676 suites / 2759 tests / 0 failures (`node js/test/run-tests.js`, verified 2026-06-11 @ `80c70b5`). Node-only harness; no DOM/THREE stubs for physics.

---

## Table of Contents

1. [System map (how to read the codebase)](#1-system-map)
2. [Boot sequence](#2-boot-sequence)
3. [Game loop & update order](#3-game-loop--update-order)
4. [State machine & full-cycle flow](#4-state-machine--full-cycle-flow)
5. [FEATURE_FLAGS truth table (what's ON)](#5-feature_flags-truth-table)
6. [Input / hotkey map (verified)](#6-input--hotkey-map-verified)
7. [HUD & panes](#7-hud--panes)
8. [Camera system & ceremonies](#8-camera-system--ceremonies)
9. [Capture & retrieval FSM (reachability)](#9-capture--retrieval-fsm-reachability)
10. [Guidance / onboarding / skills / comms](#10-guidance-stack)
11. [Missions, economy & win conditions](#11-missions-economy--win-conditions)
12. [Educational visualization — built vs unbuilt](#12-educational-visualization)
13. [Orbital mechanics, scene scale & conventions](#13-orbital-mechanics-scene-scale--conventions)
14. [Rendering & performance model](#14-rendering--performance-model)
15. [Persistence & offline-first](#15-persistence--offline-first)
16. [Doc-vs-code drift register](#16-doc-vs-code-drift-register)

---

## 1. System map

ES6 modules, no bundler. `index.html` → `<script type="module" src="js/main.js">`. THREE is imported via import-map from **local `./node_modules/three/`** (offline-first; not CDN).

```
js/
├── main.js                         Bootstrap + game loop (~1718 LOC). Owns rAF throttle,
│                                   audio-ctx policy, slow-mo, tier auto-adapt, wiring.
├── core/
│   ├── Constants.js                ~2709 LOC — ALL tuning knobs + FEATURE_FLAGS + enums
│   ├── EventBus.js                 pub/sub singleton (all inter-module comms)
│   ├── Events.js                   event-name constants (no raw strings)
│   ├── GameState.js                8-state FSM + transition validation + isGameplay()
│   └── ProfileFlags.js             URL ?flag parsing for profiling
├── scene/
│   ├── SceneManager.js             renderer + EffectComposer (RenderPass→Bloom→SMAA)
│   ├── Earth.js                    3-layer Earth, adaptive 4/8/16k textures, AVIF
│   ├── Starfield.js, SunLight.js   stars; sun/moon/lens-flare/auto-exposure
│   ├── LaunchCinematic.js, TierVisualManager.js   flag-gated visual effects
│   └── MenuScene3D.js              full-bleed menu hero (EVA astronaut + Mother)
├── entities/
│   ├── PlayerSatellite.js          Config G "Mother": barrel+collar+struts+ROSA, thrust, MPD
│   ├── ArmManager.js               arm fleet coordinator; pinCapturedDebris; active-sat guard
│   ├── ArmUnit.js                  ~4000+ LOC — 22-state daughter-arm FSM
│   ├── DebrisField.js              ~2093 LOC — instanced debris, salvage, welcome field,
│   │                               pinCapturedDebris, getDebrisNear snapshots (SPLIT CANDIDATE)
│   ├── ActiveSatellite.js          protected sats (catalog-driven)
│   ├── CaptureNet.js               14-state net projectile FSM + physics cling probability
│   ├── CatalogConverter.js         /data JSON → DebrisField format
│   ├── OrbitalMechanics.js         Kepler + Hohmann + J2 + drag (Y-up↔Z-up round-trip)
│   ├── BridleRing.js               ORPHANED (flag off, not wired) — see §5/§9
│   └── TetherReel.js *(systems/)*  ORPHANED (flag off, not wired)
├── systems/                        ~33 system modules — see §3 update order
└── ui/                             ~30 UI modules — HUD, panes, screens, overlays, maps
```

**Architectural spine:** everything talks through `eventBus` (`core/EventBus.js`). `main.js` constructs systems and calls `init()`/`update(dt)`; `GameFlowManager` owns state transitions and ~26 event handlers; `gameState` is the FSM. **The wiring-gap trap (HANDOFF §11.7): a module can be imported + have full `init()`/`update()` and still be dead if `main.js` never calls them.** Confirmed-orphaned: `TetherReel`, `BridleRing`.

---

## 2. Boot sequence

`init()` in [`main.js`](js/main.js:457), in order:

1. Parse URL diagnostics flags (`?debug ?profile ?perfReport ?autoProfile ?logPause ?logBoot`).
2. `await catalogLoader.init()` — fetch offline `/data/*.json` (graceful fallback to pure procedural).
3. `SceneManager` (renderer + composer) → `Earth` → `Starfield` → `SunLight`.
4. `PlayerSatellite` → `DebrisField` (800 interactive + 5000 background) → `ActiveSatellites` → `ArmManager` (Y0 Quad: **4 arms = 2 Weaver + 2 Spinner**, per `ARM_LADDER.Y0_QUAD`).
5. Systems: resource, sensor, kessler, cargo, forge, conjunction, autopilot, collision-avoidance, skills, lasso, reward, codex, space-weather, subsystem-events, mission-event, reputation, environment.
6. UI: HUD, MenuScreen, BriefingScreen, ShopScreen, GameOverScreen, reticles, NavSphere, OrbitMFD, DebrisMap, StrategicMap, overlays.
7. Flag-gated visuals: launch cinematic, **captureNetSystem + captureNetVisual (CAPTURE_NET=true)**, tier visual.
8. `gameFlowManager.init({...})` + `setupEventHandlers()`; `autopilotSystem.init()`; `strategicMap.init()`; `inputManager.init().start()`; `collisionAvoidanceSystem.init()`.
9. `renderer.compile()` (pre-warm shaders), hide loading screen, `gameState = MENU`, schedule first frame.

---

## 3. Game loop & update order

[`gameLoop()`](js/main.js:1089). rAF is **state-throttled** (perf): paused→skip (no reschedule); hidden tab / window-blur→early return; menu/briefing/shop→33ms (~30fps); active gameplay→display refresh. Audio context is suspended/resumed by the same policy (`_syncAudioCtxState`).

Per active-gameplay frame (`isGameplay()` true), the order is **load-bearing**:

```
inputManager.processInput → autopilotSystem → collisionAvoidance → gameState.update
→ player.update → debrisField.update → activeSatellites → armManager.update
→ player.postArmUpdate → launchSequence → launchCinematic
→ captureNetSystem → captureNetVisual → tierVisualManager
→ targetSelector → resource → sensor → kessler → forge → trawlManager
→ skills → skillsPane → lasso → reward → missionEvent → codex → spaceWeather
→ environment → subsystemEvents → conjunction → powerDistribution
→ (altitude game-over check) → (APPROACH→INTERACTION distance check)
→ updateCamera → hud.update → orbitMFD → debrisMap → ΔV alarm → reticles/navsphere
```

**Critical ordering rule (HANDOFF §10 Rule G):** `debrisField.update()` runs **before** `armManager.update()`. Captured debris must be re-positioned from the arm's fresh position *after* arms move — this is why `ArmManager` calls `DebrisField.pinCapturedDebris()` post-arm-update (the fix for the reel-in disappearance bug, `b7d5fae`). Every system is wrapped in try/catch so one crash won't freeze the loop.

Non-gameplay states still render the scene (Earth/sun/stars update) at 30fps so menus have a live backdrop.

---

## 4. State machine & full-cycle flow

[`GameState.js`](js/core/GameState.js:11) — 8 states, validated transitions:
`MENU, BRIEFING, ORBITAL_VIEW, APPROACH, INTERACTION, SHOP, GAME_OVER, WIN`. `isGameplay()` = ORBITAL_VIEW|APPROACH|INTERACTION.

```
MENU ──Start──▶ BRIEFING ──Commence/QuickStart/FreeRoam──▶ ORBITAL_VIEW
  └──Continue(save)──▶ BRIEFING                                  │
                                                APPROACH ◀──Enter (target)
                                                   │
                                               INTERACTION (capture / deorbit)
                                                   │
                            every 5 debris cleared │
                                                   ▼
                                                 SHOP ──Deploy/Esc──▶ ORBITAL_VIEW
                                                   │
   WIN ◀── 50 debris cleared  OR  10,000 kg elevator contract
   GAME_OVER ◀── reentry / fuel / collision / kessler / battery
   WIN/GAME_OVER ──▶ MENU or BRIEFING (continue: 50% credit penalty)
```

**Screens (verified):**
- **MenuScreen** — full-bleed 3D hero (MenuScene3D: EVA astronaut welding the Mother), ADR-education side panel. `START MISSION` (Enter) → BRIEFING; `F` = fast-start (skip briefing); `CONTINUE` shown only if `persistenceManager.hasSave()`.
- **BriefingScreen** — has a **target picker** (top-5 debris cards: type/alt/size/tracked/ΔV/fuel/1–5★ difficulty), arrow/Tab/click nav. `COMMENCE APPROACH`, `⚡ QUICK START (Q)` (cheapest), `FREE ROAM`. *(Not a cluster picker.)*
- **ShopScreen** — "ORBITAL SUPPLY DEPOT", entered every 5 clears. **30 upgrades** across Propulsion/Power/Sensors/Arms/Automation/Hull/Graphene (TRL badges, prereqs); Spring & Tether tier sections; Arm-Config section gated on `TIER_UPGRADES`; **Cargo Bay + Space Elevator Contract** (the second win-condition UI: progress to 10,000 kg). `DEPLOY` → SHOP_DEPLOY.
- **GameOverScreen** — handles BOTH GAME_OVER (reason + stats + continue-carry) and WIN (rating: Ace/Veteran/Professional/Apprentice/Rookie).
- **SweepReportUI** — overlay after a trawl sweep (stars, capture %, per-tool ΔV efficiency table). Not part of the main cycle.

---

## 5. FEATURE_FLAGS truth table

[`Constants.FEATURE_FLAGS`](js/core/Constants.js:471). `isFeatureEnabled()` force-returns false when `REALITY_MODE` is on. **Several flags are ON in the shipping build:**

| Flag | State | What it gates |
|---|---|---|
| **CAPTURE_NET** | **ON** | Real 14-state net projectile FSM + physics cling probability (replaces legacy 85% dice-roll, now dead code) |
| **NET_CEREMONY** | **ON** | 7-beat cinematic net-launch camera (Q2 ceremony) |
| **DAUGHTER_MULTITOOL** | **ON** | CP-1/P2 — per-arm tool choice: `MAGNETIC_GRAPPLE` state, SK tool-selection HUD, backtick cycle, F dispatches selected verb |
| **WEAVER_GRIPPER** | **ON** | CP-1/P3 — Weaver tertiary `GRIPPER_GRAPPLE` (3-jaw chuck on protruding fixtures) |
| **SPINNER_PAD** | **ON** | CP-1/P4 — Spinner secondary `PAD_CONTACT` (multi-modal pad, auto mode-resolve, finite UV-cure doses) |
| **LASER_DESPIN** | **ON** | CP-2 — mother-mounted de-spin laser (hold `U`): bleeds target `tumbleRate`, + net-cling tumble penalty so detumble→net works |
| **CLUSTER_TRANSFER_WINDOW** | **ON** | CP-3 — DebrisMap transfer-window readout (Depart/Arrive/ΔV + countdown) + commit-on-engage T-10 beep / T-0 "window open" comms |
| SHIPYARD_REFIT, CROSSBOW_MECHANISM, DUAL_OPPOSITE_FIRE, RECOIL_PHYSICS | off | spring physics, recoil-cancel pair fire |
| NET_TERMINOLOGY, NET_PRIMARY_DOCTRINE, NET_CLING_MODEL, NET_TANGLE_MECHANICS, PER_PLATFORM_NETS | off | net doctrine refits (cling model is effectively live via CaptureNet regardless) |
| DYNEEMA_TETHER, REEL_CYCLE_RESOURCE, **TETHER_REEL** | off | tether wear + strut reel cable physics (**TetherReel.js orphaned**) |
| **BRIDLE_RING**, BRIDLE_RING_GEOMETRY | off | Y-harness load ring (**BridleRing.js orphaned**) |
| ABLATION_MODULE | off | mother deorbit laser (no keybind even if flipped) |
| TIER_UPGRADES | off | Y0/Y1/Y3 arm-config shop section |
| STOW_DEPLOY_STATE_MACHINE, LAUNCH_SEQUENCE, COM_TRACKING, THRUSTER_INTERLOCK, SEMI_AUTO_AIM, LOCKABLE_HINGE, TECH_LADDER_SHOP, REALITY_MODE | off | Config-G gap features |

> **CP-1 fully landed (P2 magnet + P3 gripper + P4 pad).** All three daughter tools are built and player-dispatchable from STATION_KEEP: `MAGNETIC_GRAPPLE`, `GRIPPER_GRAPPLE`, `PAD_CONTACT`. The `ToolRecommender` scores the arm's toolset (steel hull → ▶MAGNET; oversize/awkward/fixture → ▶GRIPPER; tiny fragment → PAD ★★★ alternative; net stays primary on ties). Ferrous/fixture/roughness flags are derived once in [`debrisFerrous.js`](js/entities/debrisFerrous.js) for both procedural and catalog debris. **Deferred:** UV-cure dose save/load persistence (§13 Q3) — runtime-only at Y0, resets full on reload.

> **CP-2 landed (laser de-spin).** New mother-mounted [`DespinLaser`](js/systems/DespinLaser.js) (hold `U`, command view) operates on `targetSelector.getActiveTarget()` — bleeds the target's `tumbleRate` by `DESPIN_LASER.DESPIN_RATE_RAD_S2`, draws a cyan beam, and emits `DESPIN_IN_SPEC` ("tumble in spec, net it") on crossing the net-safe spin. The live coupling is `CaptureNet.computeTumbleModifier` (a tumble factor in `computeClingProbability`, flag-gated): high tumble sheds the net, detumble restores cling — so "detumble → net" is mechanically real, not cosmetic. The dormant daughter `ARM_STATES.ABLATING` path (bit-rotted — mutated a non-existent `angularVelocity`) is **superseded** by this mother system and remains unreached.

> **CP-3 landed (cluster transfer-window countdown).** Pure math in [`LaunchWindow.js`](js/entities/LaunchWindow.js) (`meanMotion`/`orbitalPeriod`/`synodicPeriod`/`hohmannPhaseLead`/`computeTransferWindow`/`clusterToOrbitKm`/`detectWindowCrossing`) computes the next coplanar-Hohmann launch window player→cluster, using a representative member's **live** orbit for phase (`pickRepresentative` → member nearest the cluster mean altitude). [`DebrisMap`](js/ui/DebrisMap.js) renders a **TRANSFER WINDOW** readout for the highlighted cluster (`Depart T-mm:ss` / `Arrive T+mm:ss` / `ΔV m/s` + a "next window every …" periodicity hint — the §24 teaching beat) plus a dashed transfer-path arc on its schematic. `engageSelectedCluster()` **commits** the window: DebrisMap tracks it every frame (even with the map closed), emits `CLUSTER_WINDOW_IMMINENT` (cyan + `AudioSystem.playWindowImminent`) at T-`DEBRIS_MAP.WINDOW_IMMINENT_S` and `CLUSTER_WINDOW_OPEN` (+ HOUSTON comms + `playWindowOpen`) at T-0; a missed window rolls to the next synodic period via the modular solve in `computeTransferWindow`. The committed countdown clears on `AUTOPILOT_DISENGAGE`/`AUTOPILOT_ARRIVED`/`GAME_RESET`. Cluster→autopilot agency itself was already live (`DebrisMap.engageSelectedCluster → AutopilotSystem.engageCluster`); StrategicMap (3D) remains view-only.

---

## 6. Input / hotkey map (verified)

All in [`InputManager.js`](js/systems/InputManager.js) `_handleKeyDown` + held-key `processInput`. **The single source of truth is the in-game help pane** (`?`), defined in [`HotkeyOverlay.js`](js/ui/HotkeyOverlay.js) `HOTKEY_GROUPS`; the code is kept aligned to it (a separate "manifest" file was tried and removed 2026-06-14 — one source only). Overlays (hotkey `?`, Codex `L`, StrategicMap, DebrisMap, launch ceremony) swallow most input while open.

**Hotkey revamp 2026-06-14 (code aligned to the help menu):** daughters are now flown with **arrow keys only** (station-keep orbit) — **WASD/`Q`/`E` daughter thrust was removed**, so `S`/`A`/`D`/`V`/`T` keep their Mother meanings while piloting. `1-4` is the single select/pilot verb (`P`/`Shift+P` gone); re-pressing the active digit backs out to the mother. The number row 5-0 became display toggles; several keys moved (see below). `7` is now "Comms toggle" (was return-to-mother).

| Key | Normal / Orbital | While piloting a daughter |
|---|---|---|
| **↑↓←→** | pitch/yaw (tether-aware spring) | SK θ/φ orbit (Shift = fine) |
| **S / Shift+S** | Quick Scan / Wide "scan big area" (Shift+S — moved off bare `W`) | same |
| **T** | **Target debris** (cycle; `Tab` is an alias) | same |
| **A / Shift+A** | Autopilot toggle / **autopilot to debris center + launch all** | same |
| **N / Shift+N** | lasso/net fire / **auto-target + launch at debris in range** | N = net capture/deploy (single capture verb) |
| **D / Shift+D** | launch **selected docked** daughter (auto-pick if none) / launch **all** docked. Ctrl+Shift+D = deorbit; Ctrl+D = debug | same |
| **R** | AP→abort; else recall closest. **Shift+R = recall ALL** | reel from STATION_KEEP |
| **H** | hold → de-spin laser (needs a target) | hold → de-spin the piloted arm's SK target |
| **E** | **Electrodynamic Tether** (moved off `Y`) | same |
| **X** | Tether detach (sacrifice) | same |
| **V / Shift+V** | cycle view (COMMAND → OVERVIEW → INSPECTION); Shift+V → Strategic Map | V cycles view (back out via re-press digit / Esc); Shift+V map |
| **1–4** | **Select daughter** — docked → select + glow (mother stays in view; `D` launches); deployed → select + pilot. Re-press active digit → back out. Y0 = 4 arms; 5-8 deferred | switch piloted daughter |
| **B** | Shop / Buy (ORBITAL_VIEW only) | — |
| **F** | **Forge** toggle (moved off `5`) | same |
| **M** | **Map** — toggle Debris Map (`` ` `` is an alias) | same |
| **L** | Codex / Library | same |
| **J** | Journal / Skills *(owned by SkillsPane's own listener)* | same |
| **? / Esc** | help pane / pause·back (Esc also backs out of pilot) | same |
| **5 / 6** | toggle City names / Constellation names | same |
| **7 / 8** | Comms size cycle / **NavSphere → minimize to LAT·LON·ALT one-liner** | same |
| **9 / 0** | **Debris pane → minimize to one-liner** (id·size·mass·tumble·material) / toggle Target pane | same |
| **. (period)** | **Struts** toggle (stow/deploy all) | same |
| **+ / −** | throttle ±10% (in SK: orbit radius ∓) | SK: approach/retreat |
| **[ / ]** | power bus ∓10%; Shift+1/2/3 select bus | same |
| **C** | comms focus (plain tap; not in the help pane) | same |
| **Z / Shift+Z** | Wireframe zone cycle ±1 | same |
| **` (backtick)** | toggle DebrisMap (alias of M; cycles tool while piloting in SK) | cycle tool in SK |
| **Shift+G** | Trawl start | — |
| **F2** | — | cycle FEEP metal (piloted arm) |
| **PageUp/Down** | comms scroll | same |

**Freed by the 2026-06-14 remap:** `W`, `Y`, `O`, `,` (comma), `Shift+C`. **Features that lost their dedicated key (not in the help menu):** cycle-capture-tool (was `T`), Focus Action (was `F`), Orbit/MPD MFD (was `M`), FEEP fuel cycle (was `6`). **Removed earlier (2026-06-14 "spinning plates"):** `P`/`Shift+P` (→ `1-4` select/pilot), `7` return-to-mother (→ re-press digit; `7` is now Comms toggle), `Q`/`E` thrust, and the `TOOL_DEPLOY` event constant. **Earlier removals:** bare `I` (inspection rides the `V` cycle, 2026-06-13b); `F4`/`F5` (→ `5`/`6`); C-hold radial menu (UX-11 #9); `H`/`Shift+O` recall-all (→ `Shift+R`, 2026-06-12).

**New toggle hooks (2026-06-14):** `Starfield.toggleConstellations()`, `DebrisWireframe.toggleMinimized()` (collapses the canvas to a one-line dossier summary — id·size·mass·tumble·material — and the right column reflows up), `NavSphere.toggleMinimized()` (draws just the LAT/LON/ALT readout, skips the sphere), `TargetPanel.toggleVisible()`; `starfield` was added to `InputManager` deps.


---

## 7. HUD & panes

[`HUD.js`](js/ui/HUD.js) coordinates a left column (StatusPanel), right column (DebrisWireframe + TargetPanel), top-right comms, body-mounted score, plus floating overlays.

- **Progressive reveal is effectively DISABLED for dimming.** `_applySkillReveal()` force-marks all groups `hud-active` (luminance dimming was "too hard to read"). `data-hud-group` / `SKILL_GROUP_TO_DOM` now only drive the corner keycap-glyph affordance + progression tracking. Panels render full-brightness from frame one. *(This supersedes the dormant-opacity design in FIRST_EXPERIENCE.md §8.)*
- **StatusPanel** — body-mounted dual-objective bar ("CLEARED n/50" + always-visible "⚓ CONTRACT x/10,000 kg" — UX-11 #12, credits), Propulsion panel (`fuel-group`, key A: autopilot, ΔV, Xe/gas/battery, EDT, MPD rows, throttle, inline Forge [5]), Power panel (`power-group`, Shift+1-3 / [ ]), Crossbow Fleet panel (`arms-group`, key D: per-arm status, lasso cooldown ring, WEB n/max). HOLDING_CATCH renders gold with a 🎣 badge. Control-mode (RCS/COLD GAS) badge was **removed**.
- **TargetPanel** — right column. Tracked (max 7, sort cycle), Untracked sensor (max 3), Active sats (max 3). Selected row expands with Net-ΔV, points, **MOID badge**, action hints. PaneChrome resize (Tab).
- **CommsPanel** — top-right, 3-color priority palette, PaneChrome resize (C). Hosts `executeCommsCommand(1–6)`.
- **RadialMenu** — **REMOVED** (UX-11 #9). Every former radial action has a direct key: D deploy, Shift+R recall all, 1-4 select/pilot, Ctrl+Shift+D deorbit. `C` is a plain comms-expand tap.
- **SkillsPane** — bottom-left, J toggle (own listener). Experience-level opacity (NOVICE checklist "NEXT STEPS" → APPRENTICE auto-hide → VETERAN transient).
- **HintTicker** — bottom strip, max 4, driven by `HINT_POSTED`/`SKILL_STATE_CHANGED`.
- **NetInventoryPanel** — **SUSPENDED** (mounts `display:none`, never shown; logic/tests live). Redesign pending.

---

## 8. Camera system & ceremonies

[`CameraSystem.js`](js/systems/CameraSystem.js). `CameraViews` enum has **7** values: `FIRST_PERSON, CHASE, ORBIT, TARGET_LOCK, ARM_PILOT, INSPECTION, NET_CINEMATIC`. The **V-cycle is COMMAND → OVERVIEW → INSPECTION → COMMAND** (`CHASE → ORBIT → INSPECTION`, 2026-06-13b). `TARGET_LOCK` is **orphaned** (dropped from cycle; framing folded into CHASE via `targetLookBias`). The INSPECTION step is entered via `enterInspection()` (so FOV/near-plane/vignette/callouts engage); OVERVIEW-zoom still auto-enters the same sub-state via the Schmitt trigger. The standalone `I` shortcut was removed 2026-06-13b.

**Ceremonies (verified):**
- **Net-launch ceremony** (`NET_CEREMONY` on) — **7 beats**: `POD_MUZZLE_PREFIRE → MUZZLE_EXIT_SPINUP → GLAMOUR_SHOT → APPROACH_DOLLY → BRAKE_ENVELOP → CINCH → SECURED_SETTLE`, with per-beat physics time-dilation (≈0.3–0.6×; world dt stays 1.0×). Subsequent deploys use a shortened "highlights cut." Sets `FIRST_NET_DEPLOY` persistence flag on first completion only.
- **Launch ceremony** — 3 phases (OBSERVE→TETHER_FOLLOW→HANDOFF, ~7.75s), triggered by `LAUNCH_CEREMONY_START` (D deploy), auto-enters ARM_PILOT on completion.
- **No dock or tier-upgrade ceremony.** Capture cinematic = tail of the net ceremony.
- CameraSystem does **not** auto-switch on AUTOPILOT/ARM_DEPLOYED — deploy drives the camera via `LAUNCH_CEREMONY_START` (deliberate no-auto-switch policy).

---

## 9. Capture & retrieval FSM (reachability)

[`ArmUnit.js`](js/entities/ArmUnit.js) `update()` switch handles 25 `ARM_STATES`:
`DOCKED, UNDOCKING, LAUNCHING, TRANSIT, APPROACH, NETTING, GRAPPLED, HAULING, REELING, RETURNING, DOCKING, RELOADING, HOLDING_CATCH, FISHING, TRAWLING, DEORBITING, WEB_SHOT, ABLATING, SCANNING, TANGLED, STATION_KEEP, EXPENDED, MAGNETIC_GRAPPLE, GRIPPER_GRAPPLE, PAD_CONTACT`.

| Method | Reachable by player? | Notes |
|---|---|---|
| **Capture Net** (N in STATION_KEEP; N manual in TRANSIT/APPROACH) | ✅ | Real FSM + cling probability |
| **Trawl** (Shift+G) | ✅ | TrawlManager auto-picks `clusters[0]` |
| **Deorbit sacrifice** (Ctrl+Shift+D) | ✅ | |
| **Reeling / Returning** (R / Shift+R, post-capture) | ✅ (indirect) | REELING = zero-fuel strut motor; RETURNING = FEEP. **Both now target the STRUT-TIP dock world pos** (2026-06-12, Issue 8 — RETURNING previously flew into the mother core, occluding the daughter ~2 s with a 180°-wrong tether) |
| **HOLDING_CATCH** (park the catch) | ✅ (auto) | Daughter parks catch at strut; a staged `FURNACE_TRANSFER` timeline (hold→chop→feed) chops it into `CHUNK_COUNT` pieces, streams them to the furnace, then hands off (`CATCH_PROCESSED`) and reloads (§ HANDOFF 1.9 + Item 1) |
| **Fishing** | ⚠️ orphaned from keys | `deployFishing()` exists; only via ArmManager autopilot path / comms — no direct key |
| **Web Shot** | ⚠️ orphaned | `fireWebShot()` exists, **no keybinding** |
| **Ablation** | ⚠️ orphaned | flag off + no keybinding |
| **Magnetic grapple** (F in STATION_KEEP, MAGNET selected) | ✅ (P2) | `MAGNETIC_GRAPPLE` ENERGIZING→CLOSING→GRIP; ferrous→GRAPPLED, else→RETURNING. Gated by `DAUGHTER_MULTITOOL` |
| **Gripper jaws** (F in STATION_KEEP, GRIPPER selected — Weaver) | ✅ (P3) | `GRIPPER_GRAPPLE` EXTEND→SEEK→CLOSE→latch; fixtured→GRAPPLED, else→RETURNING. Gated by `WEAVER_GRIPPER` |
| **Multi-modal pad** (F in STATION_KEEP, PAD selected — Spinner) | ✅ (P4) | `PAD_CONTACT` APPROACH_SOFT→CONTACT (auto mode-resolve)→grip; adhered→GRAPPLED, bounce→RETURNING. Finite UV-cure magazine. Gated by `SPINNER_PAD` |

**Weaver vs Spinner ARE differentiated** under `CAPTURE_NET=true`: Weaver fires a MEDIUM net, Spinner a SMALL net (different diameter/mass/launch-speed/spin/tether), and catch success is resolved by `computeClingProbability()` (velocity·contact·roughness·spin·tension·distance × pBase) — **not** the legacy flat 85% (now dead code). The *multi-tool* decision (magnet/gripper/pad) is what's missing, not net differentiation.

**Captured-debris lifecycle:** authoritative `DebrisField.pinCapturedDebris()` welds the catch to the hauling arm (called post-arm-update). Catch is parked full-size in `HOLDING_CATCH` at the strut tip. The `FURNACE_TRANSFER` window is now a **staged breakdown** (Item 1, 2026-06-11): `hold` (`HOLD_S`, catch cinched) → `chop` (`CHOP_S`, emits `CATCH_BREAKDOWN_START`, releases the net cinch, shrinks the original instanced catch out of view) → `feed` (`FEED_S`, emits `CHUNK_COUNT`× `CATCH_BREAKDOWN_CHUNK` as chunks stream to the furnace). At feed-end `ArmUnit._updateHoldingCatch` emits **`NET_CONSUMED`** + the single **`CATCH_PROCESSED`** (unchanged `{ armId, debrisId, type }` payload — bosses/persistence contract intact) and clears the catch (→ RELOADING). The THREE-side choreography lives in `FurnaceBreakdownVisual` (chunks + ghost-bag draw-in); the FSM timing is Node-tested. `GameFlowManager`'s `CATCH_PROCESSED` handler still owns **salvage extraction + scoring + field removal** (and a `CATCH_BREAKDOWN_START` comms line). `DURATION_S` is a derived getter (= `FEED_S`) for back-compat. The earlier premature-scoring + indefinite-park debt is resolved.

**Daughter orientation at the strut (Item 4):** `PlayerSatellite.postArmUpdate` is the single owner of strut-basis orientation for `DOCKED` (snap), `DOCKING` (slerp onto the strut — no pop at `RELOADING→DOCKED`), and `HOLDING_CATCH` (snap — no drift toward the raw mother-bus quat). The deterministic basis lives in the shared `ArmDockBasis.composeDockedArmQuat` (SSOT, used by both PlayerSatellite and previously-duplicated code). `HOLDING_CATCH` is in ArmUnit's `skipAttitude` set so the generic attitude branch never fights postArmUpdate (HANDOFF §10 Rule B). `_updateTether` hides the tether in `HOLDING_CATCH` (Item 5) so no stray wrong-direction line renders during the park. As the quat owner, `postArmUpdate` also re-syncs `tetherLine.quaternion = group.quaternion⁻¹` after its slerp/snap (2026-06-12, Issue 8b — the tether counter-quat baked in `_updateTether` was one frame stale for DOCKING/LAUNCHING/HOLDING_CATCH).

**Catch pin standoff (Issue 13, 2026-06-12):** `_pinCatchToSelf` pins the catch at `arm.position + holdDir × (sizeMeter/2 + ARM_HOLD_CLEARANCE_M)` (holdDir = net launch axis while the fired-net ref lives, else outboard from the mother), so the daughter never renders INSIDE a catch larger than herself; `ArmManager` forwards `_armPinPos` (not raw arm position) to `DebrisField.pinCapturedDebris`.

**Net launch + spin (Item 2):** the net now models real yo-yo despin — `_updateSpinningUp` starts at `SPIN_HZ × SPIN_FOLDED_MULT` and decays to `SPIN_HZ` as the mouth blossoms; `_updateFlight` bleeds spin at `SPIN_DECAY_PER_S`, making `f_spin` a live cling factor (fire in-envelope or the wrap is weak). `ArmUnit._updateNettingFSM` leads the aim (`targetPos + relVel × dist/LAUNCH_SPEED`). **relVel is ARM-RELATIVE** (2026-06-12, Issue 2): the net flies in the arm's co-orbiting frame, so the estimator subtracts the arm's own per-frame delta — in a settled SK relVel ≈ 0 and shots fly dead straight (the old raw scene delta bent every SK shot by the shared orbital drift). The SK tool HUD shows a live `P_cling` pre-fire readout + width/de-spin/close-in advisories (`assessNetFit` in CaptureNet.js is the SSOT for reticle + TargetPanel badge + ToolRecommender width fork). Audio: the deploy woosh keys off **`ARM_SPRING_FIRED`** (actual spring release, 1.5 s after `ARM_DEPLOYED`); `ARM_DEPLOYED` plays a quiet clamp click.

---

## 10. Guidance stack

Three layers; only the first two exist today.

1. **OnboardingDirector** ([`OnboardingDirector.js`](js/systems/OnboardingDirector.js)) — **16 beats** (boot, handshake, arrows, struts, view, look, zoom, inspect, scan, target, autopilot, decision, lasso, daughter, captured, complete). Each interactive beat triggers on an `Events` constant; narrative beats auto-advance. Escalation → `TEACHING_MOMENT_FORCE` after idle (`IDLE_ESCALATION_MS`) or >6 unrelated inputs. Veteran-skip via `VETERAN_SKILL_THRESHOLD`. Emits `ONBOARDING_COMPLETE`. **No solo-flight/counter-beat, no PostOnboardingCoach (both spec'd, unbuilt).**
2. **TeachingSystem** ([`TeachingSystem.js`](js/systems/TeachingSystem.js)) — **19 first-encounter moments**, `_seen` Set persisted to `localStorage['teachingSeen']`. `TEACHING_MOMENT_FORCE` bypasses the seen-guard (used by Director escalation). **CP-4 §4 3-layer arbitration (built):** overlays QUEUE while a blocking surface (deploy ceremony `D` / net ceremony; the radial-menu blocker was removed with the radial), the OnboardingDirector, or a MissionCoach beat owns the screen, and drain ≤1 per `TEACHING.QUEUE_DRAIN_INTERVAL_S` (6 s) via `update(dt)`; the **collision rule** drops an overlay permanently when an active coach beat's `skillId` matches the moment id; veterans get `presentation:'ticker'` (via the injected SkillsSystem's `getHintPresentation()`); `GAME_RESET` clears the queue. Coach-beat signals are `MISSION_BEAT_STARTED`/`MISSION_BEAT_SATISFIED` (dormant until MissionCoach emits them).
3. **MissionCoach** ([`MissionCoach.js`](js/systems/MissionCoach.js)) — **built (engine + chapter 2)**. On `SHOP_DEPLOY` into mission N it runs `Constants.MISSION_COACH.BEATS_BY_MISSION[N]` via the shared `BeatSequencer` ([`_beatLifecycle.js`](js/systems/_beatLifecycle.js)): each beat posts a `_postOnboarding`-tagged MISSION comms line; interactive beats emit `MISSION_BEAT_STARTED` and resolve on their (payload-filtered) trigger → `MISSION_BEAT_SATISFIED`; an idle beat re-prompts via `TEACHING_MOMENT_FORCE`; completion persists per mission (`spacecowboy_mission_coach_v1`), cleared on `GAME_RESET`. Chapter 1 stays with OnboardingDirector. **Chapters 3–12 (beat tables, ~5 more skills, boss events, win cinematic) are follow-on content** (MISSION_ARC Phases C–F); the engine makes each a data edit, not code.

**SkillsSystem** ([`SkillsSystem.js`](js/systems/SkillsSystem.js)) — **37 skills**, 5 tiers (orientation/core_tools/proficiency/advanced/mastery), 5 categories (nav/scan/collect/awareness/manage). States: undiscovered→discovered→practiced→mastered (mastery needs count AND `MASTERY_MIN_TIME=300s`). SM-2 spaced reminders. Skills wire 1:1 to a `triggerEvent`, with an **optional `triggerFilter(data) => boolean`** (CP-4 arbiter §5) so several skills can share one event but discriminate by payload — the gate lives in `_setupListeners` and a def without it fires on every event as before. To feed it, `ARM_CAPTURED` now carries `manual` (true for player net/tool captures, false for passive fishing/trawl auto-captures) and `SCAN_INITIATED` carries `type:'quick'|'wide'`. (Chapter 2's `arm_pilot`/`arm_pilot_capture` are the first live `triggerFilter` defs; chapters 3–12 add more as data.) **CP-4 §3 universal hint-gating rule** (the "respect the player" invariant) lives here too: `canFireHint(skillId,{cause})` allows a hint only if the skill is *undiscovered OR (discovered AND failed-recently)*, never for mastered, and falls silent after `MAX_UNHEEDED_NUDGES` (per-skill unheeded counters, reset on use). "failed-recently" is backed by a `_recentFailures` ring buffer auto-wired from `Constants.SKILLS.FAILURE_CAUSES` (NET_FAILED/NET_CATCH_MISS/LASSO_MISSED/LASSO_DENIED/PAD_BOUNCED/ARM_CAPTURE_FAILED). The SM-2 reminder path enforces the unheeded cap and tags each `SKILL_REMINDED` with `presentation:'ticker'|'modal'`; `isVeteran()`/`getHintPresentation()` downgrade veterans (`SKILLS.VETERAN_SKILL_THRESHOLD` 0.7, distinct from the 0.5 onboarding-skip threshold) to ticker hints.

**CommsSystem** ([`CommsSystem.js`](js/systems/CommsSystem.js)) — **graduated suppression tier `_suppressionTier` (0–3)** (CP-4 arbiter, GUIDANCE_ARBITER_SPEC §2), replacing the old binary `_onboardingActive`. Tier 0 = OnboardingDirector running (only tag-bypassed lines); tier 1 (0–30 s after `ONBOARDING_COMPLETE`) = + HOUSTON/MISSION; tier 2 (30–60 s) = + ALERT/CMD; tier 3 (60 s+ / **default for non-onboarding play**) = all channels. The ramp advances off the game clock in `_advanceSuppression(dt)` (pause-safe). Tag bypasses (`_critical` any tier, `_onboarding` tier 0, `_postOnboarding` tiers ≥1, `_lassoFeedback` always) + CRITICAL-priority-from-tier-1 live in the pure [`commsSuppression.js`](js/systems/commsSuppression.js) (`messagePassesSuppression`). Low-fuel/battery warnings and imminent (RED) conjunction alerts ([`ConjunctionSystem.js`](js/systems/ConjunctionSystem.js)) are stamped `_critical` so they bypass the wake ramp at any tier. `_tempDropToTier(tier, durationS)` lets a MissionCoach beat protect its highest-load moment. **CP-4 complete (arbiter steps 1–5 + MissionCoach engine + chapter 2);** the remaining 12-chapter content (chapters 3–12 beat tables, ~5 more skills, boss events, win cinematic) is data-layer follow-on (MISSION_ARC Phases C–F). 6 channels (CMD/ALERT/HOUSTON/SCI/FLAVOR/MISSION); personas HOUSTON + ISRO BANGALORE/HASSAN with a scripted handoff line.

---

## 11. Missions, economy & win conditions

- **Mission number** = `floor(debrisCleared / 5) + 1` (`DEBRIS_PER_MISSION=5`). `MISSIONS.PROFILES` has **5 difficulty tiers** keyed by `minMission` (1/2/4/7/10) — ramping cluster count + enabling hydrazine→synergy→conjunction/kessler→weather/activeSats. **There is no 12-chapter narrative arc in code** — only these 5 numeric profiles.
- **MissionEventSystem** — 5 mid-mission triggers (hydrazine, synergy, kessler cascade, weather, conjunction) + **3 news events** from `data/news-events.json` (`ast_spacemobile_tumble`, `starlink_breakup`, +1) unlocked by capture count.
- **Two win conditions (both wired):** (A) **50 debris cleared** → `GAME_WIN` from `GameState.update()`; (B) **10,000 kg refined metal** contributed to the elevator contract in ShopScreen → `CONTRACT_COMPLETE` → win on next return-to-orbit.
- **Active-sat treaty guard** — `ActiveSatGuard.checkActiveSatArming()` invoked from **ArmManager** (3 arming paths); blocks arming against any NORAD present in `data/active-sats.json` (**51 sats**: ISS, Hubble, GPS, Starlink, etc.). **JWST is not in the catalog** (out of LEO/GEO scope).
- **Economy:** capture → cargo → ForgeSystem (refine metals / make FEEP propellant, key 5) → fuel cycling (key 6) → synergy bonuses → ShopScreen credits/upgrades. ΔV is the master resource (never free-regenerates except via salvage).

---

## 12. Educational visualization

| Concept | Code | Surfaced in UI |
|---|---|---|
| **MOID** (`MoidCalculator.js`) | ✅ | ✅ — TargetPanel + StrategicMap threat-list badges (HI/MD/LO) |
| **Hohmann transfer arc** (OrbitMFD) | ✅ | ✅ — M key: dashed arc + ΔV₁/ΔV₂, route/sweep planners |
| **StrategicMap** (Shift+V) | ✅ | ✅ — 3D globe: altitude bands, debris dots, hazard shells, ground stations, MOID threat list |
| **Porkchop plot** | ❌ | ❌ |
| **Lambert solver** (`lambertIzzo`) | ❌ | ❌ |
| **Clohessy-Wiltshire band** | ❌ | ❌ |
| **Transfer ellipse + launch countdown** | ✅ CP-3 — DebrisMap TRANSFER WINDOW readout (Depart/Arrive/ΔV + countdown) + transfer-path arc; commit-on-engage T-10 beep / T-0 comms | ✅ [`LaunchWindow.js`](js/entities/LaunchWindow.js) (pure, tested) |
| **Cluster selection** | DebrisMap (backtick) picks a cluster → Shift+A engages autopilot + commits its launch-window countdown | StrategicMap does NOT select clusters |

So the educational suite has a strong **situational-awareness** layer (MOID, bands, Hohmann) plus the CP-3 **transfer-window countdown**, but still **no porkchop/Lambert/CW maneuver-planning tools**. These remain the biggest unbuilt teaching opportunities (see ROADMAP EN-5/EN-6).

---

## 13. Orbital mechanics, scene scale & conventions

[`OrbitalMechanics.js`](js/entities/OrbitalMechanics.js) — Kepler propagation, Hohmann ΔV, J2, drag. **Round-trip safety:** scene is Three.js **Y-up**; classical ECI is **Z-up**; `orbitToSceneCartesian()` ↔ `cartesianToKeplerian()` swap y↔z (guard test `test-OrbitalMechanics.js:164`).

**Load-bearing constants (full SSOT in HANDOFF §9–§11):**
- **`M = 1e-5`** — 1 metre in scene units (1 scene unit = 100 km). Distances are metres in Constants; multiply by `M` at the Object3D boundary.
- **`TIME_SCALE_GAMEPLAY = 10×`** — silent multiplier on orbital propagation; per-tick physics must use `gameDt`, not `dt`.
- `Object3D.lookAt` (+Z forward) vs `Camera.lookAt` (−Z forward) — opposite conventions.
- `RENDER_ORDER` 6-tier enum is the deterministic transparency tiebreaker.

**Anyone touching orientation, FSM-state coverage, capture lifecycle, or visual code MUST read HANDOFF §9 (THREE.js Convention SSOT) and §10 (Capture-lifecycle rules A–I) first.**

---

## 14. Rendering & performance model

[`SceneManager.js`](js/scene/SceneManager.js) — `WebGLRenderer` (ACES Filmic, `logarithmicDepthBuffer:true`, no MSAA, no shadows) → `EffectComposer`: RenderPass → UnrealBloomPass (threshold 0.85, half-res) → SMAAPass.

- **Quality tiers + runtime auto-adapt** (`QualityManager.runtimeAdapt`): rolling FPS history downshifts/upshifts tiers with hysteresis; `sceneManager.applyTier()`.
- **rAF throttle by state** (`main.js`): paused→halt; hidden/blurred→halt; menu→30fps; gameplay→refresh. Audio context suspended in lockstep. This is the fix for "40% GPU while paused / on app-switch."
- Diagnostics: `?logPause`, `?logBoot`, `?perfReport`, `?autoProfile`, `?debug`, `?profile`. Profiling history archived in `archive/GPU_PROFILING_REPORT.md`, `archive/QUICK_WINS_PERF.md`.

---

## 15. Persistence & offline-first

- **PersistenceManager** — localStorage save/load (credits, upgrades, stats, ceremony flags, net inventory, skills). Roguelite continue = 50% credit penalty, upgrades kept.
- **Offline-first (locked principle):** THREE loaded from local `node_modules`; `/data/*.json` catalogs fetched once at boot with graceful procedural fallback; **no live TLE/telemetry**. Catalog updates are user-driven (`data/news-events.json`).

---

## 16. Doc-vs-code drift register

Corrected during the 2026-06-07 ground-truth pass. Stale-count headers have been fixed in source where cheap; remaining design-doc aspirations are tracked in [`ROADMAP.md`](ROADMAP.md).

| Claim (somewhere in docs) | Reality (code) |
|---|---|
| "6 arms: 3 Weaver + 3 Spinner" (main.js comment) | Y0 Quad = **4 arms: 2W + 2S** (`ARM_LADDER.Y0_QUAD`) |
| OnboardingDirector "13 beats" | **16 beats** |
| SkillsSystem "34"/"33 skills" | **37 skills** |
| TeachingSystem "12 moments" | **19 moments** |
| "5 camera views" / V cycles 3 | **7 CameraViews**, V cycles **2** (CHASE↔ORBIT); TARGET_LOCK orphaned |
| "21 upgrades" | **30 upgrades** |
| "Start → ORBITAL_VIEW, skipping briefing" | MENU → **BRIEFING** (target picker) → ORBITAL_VIEW |
| R = forge cycle | R = **recall/reel**; Forge = **5** (was F4; UX-11 #8) |
| Weaver/Spinner identical 85% dice-roll | **differentiated** (MEDIUM/SMALL net + cling physics); 85% path dead |
| StrategicMap unbuilt | **built** (bands/debris/hazards/ground-stations/MOID + UX-11 #7 "RECOMMENDED NEXT" guidance panel + legend tooltips + Shift+C city labels) — view-only by design; cluster selection stays on the Debris Map |
| MissionCoach / 12-chapter arc / graduated comms tiers / triggerFilter / solo-flight | **none exist in code** (design only) |
| TetherReel / BridleRing wired | **orphaned** (flags off, not in main.js) |
| "TRL n" badges player-facing | relabeled **"Tech Lvl n"** everywhere player-facing (Codex + Shop + tier gating text, UX-11 #10); internal keys/data stay `trl`/`Constants.TRL` |
| Codex locked cards = blurred `???` | **syllabus reveal** (UX-11 #10): title + one-liner always visible; fullText/rationale gated; `unlockHint` per entry; live search + per-category progress |
| C-hold radial menu (RadialMenu.js) | **removed** (UX-11 #9); `C` = comms expand, `Shift+C` = city labels |
| H / Shift+O = recall all (older docs/skills text) | **Shift+R** = recall all (2026-06-12 hotkey cleanup); `Shift+O` freed; `H` was briefly freed then reassigned to the **de-spin laser** (2026-06-13, was `U`) |
| de-spin laser = `U`; capture = F/N/Space (older docs) | **`H`** = de-spin laser ("Hold"); **`N`** = the single net/capture verb (F inert in ARM_PILOT, Space lasso alias dropped) — 2026-06-13 cleanup |
| Test baseline 272/1252 (old ARCHITECTURE) | **711 / 2880 / 0** (2026-06-12) |

---

*This blueprint reflects the code as of 2026-06-07. When you change architecture, update this file and the [`ROADMAP.md`](ROADMAP.md) gap table in the same shift.*
