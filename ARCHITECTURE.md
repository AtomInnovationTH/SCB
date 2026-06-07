# Space Cowboy — Architecture Blueprint

> **The single current source of truth for "how the code actually works."** Browser-based 3D orbital-debris-removal sim. Three.js (loaded from local `node_modules`), vanilla ES6 modules, **zero build tools**.
>
> **Verified against code: 2026-06-07** (architect ground-truth pass; supersedes the Epic-8-era doc, now in git history). Where this doc and an older design doc disagree, **this doc wins** for as-built behavior. Design intent lives in [`GAME_DESIGN.md`](GAME_DESIGN.md), the forward plan in [`ROADMAP.md`](ROADMAP.md), and the live shift state + load-bearing SSOT rules in [`HANDOFF.md`](HANDOFF.md).
>
> **Test baseline:** 612 suites / 2542 tests / 0 failures (`node js/test/run-tests.js`, verified 2026-06-07). Node-only harness; no DOM/THREE stubs for physics.

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

[`Constants.FEATURE_FLAGS`](js/core/Constants.js:471). `isFeatureEnabled()` force-returns false when `REALITY_MODE` is on. **Three flags are ON in the shipping build:**

| Flag | State | What it gates |
|---|---|---|
| **CAPTURE_NET** | **ON** | Real 14-state net projectile FSM + physics cling probability (replaces legacy 85% dice-roll, now dead code) |
| **NET_CEREMONY** | **ON** | 7-beat cinematic net-launch camera (Q2 ceremony) |
| **DAUGHTER_MULTITOOL** | **ON** | CP-1/P2 — per-arm tool choice: `MAGNETIC_GRAPPLE` state, SK tool-selection HUD, backtick cycle, F dispatches selected verb |
| **WEAVER_GRIPPER** | **ON** | CP-1/P3 — Weaver tertiary `GRIPPER_GRAPPLE` (3-jaw chuck on protruding fixtures) |
| **SPINNER_PAD** | **ON** | CP-1/P4 — Spinner secondary `PAD_CONTACT` (multi-modal pad, auto mode-resolve, finite UV-cure doses) |
| SHIPYARD_REFIT, CROSSBOW_MECHANISM, DUAL_OPPOSITE_FIRE, RECOIL_PHYSICS | off | spring physics, recoil-cancel pair fire |
| NET_TERMINOLOGY, NET_PRIMARY_DOCTRINE, NET_CLING_MODEL, NET_TANGLE_MECHANICS, PER_PLATFORM_NETS | off | net doctrine refits (cling model is effectively live via CaptureNet regardless) |
| DYNEEMA_TETHER, REEL_CYCLE_RESOURCE, **TETHER_REEL** | off | tether wear + strut reel cable physics (**TetherReel.js orphaned**) |
| **BRIDLE_RING**, BRIDLE_RING_GEOMETRY | off | Y-harness load ring (**BridleRing.js orphaned**) |
| ABLATION_MODULE | off | mother deorbit laser (no keybind even if flipped) |
| TIER_UPGRADES | off | Y0/Y1/Y3 arm-config shop section |
| STOW_DEPLOY_STATE_MACHINE, LAUNCH_SEQUENCE, COM_TRACKING, THRUSTER_INTERLOCK, SEMI_AUTO_AIM, LOCKABLE_HINGE, TECH_LADDER_SHOP, REALITY_MODE | off | Config-G gap features |

> **CP-1 fully landed (P2 magnet + P3 gripper + P4 pad).** All three daughter tools are built and player-dispatchable from STATION_KEEP: `MAGNETIC_GRAPPLE`, `GRIPPER_GRAPPLE`, `PAD_CONTACT`. The `ToolRecommender` scores the arm's toolset (steel hull → ▶MAGNET; oversize/awkward/fixture → ▶GRIPPER; tiny fragment → PAD ★★★ alternative; net stays primary on ties). Ferrous/fixture/roughness flags are derived once in [`debrisFerrous.js`](js/entities/debrisFerrous.js) for both procedural and catalog debris. **Deferred:** UV-cure dose save/load persistence (§13 Q3) — runtime-only at Y0, resets full on reload.

---

## 6. Input / hotkey map (verified)

All in [`InputManager.js`](js/systems/InputManager.js) `_handleKeyDown` + held-key `processInput`. WASD thrust is **ARM_PILOT-only** (autopilot-first paradigm). Overlays (hotkey `?`, Codex `L`, StrategicMap, DebrisMap, launch ceremony) swallow most input while open.

| Key | Normal / Orbital | ARM_PILOT |
|---|---|---|
| **S** | Quick Scan ($50, 1.5s) | held → −Z thrust |
| **W** | Wide Scan ($150, 4s) | held → +Z thrust |
| **A** | Autopilot toggle (Shift+A = engage DebrisMap cluster) | held → −X thrust |
| **D** | Deploy daughter (+ launch ceremony). Ctrl+Shift+D = deorbit; Ctrl+D = debug | held → +X thrust |
| **Q / E** | — | held → +Y / −Y thrust *(undocumented in README)* |
| **Tab** | Cycle targets (TPI-sorted) | — |
| **Space / N** | Lasso fire (Space consults OnboardingDirector first). Shift+N = NavSphere | net capture/deploy (Space auto-exits ARM_PILOT) |
| **F** | Focus action (context smart button) | STATION_KEEP→capture; TRANSIT/APPROACH→manual net |
| **P** | Enter ARM_PILOT | exit ARM_PILOT |
| **I** | Inspection (mother, or debris if Tab-locked) | expand debris wireframe |
| **R** | AP→abort; else recall closest daughter | reel from STATION_KEEP |
| **H** | Recall all | recall all |
| **X** | Tether detach (sacrifice) | same |
| **Y** | EDT deploy | same |
| **Z / Shift+Z** | Wireframe zone cycle ±1 | same |
| **C** | tap → comms focus; hold → radial menu | same |
| **V / Shift+V** | cycle view (CHASE↔ORBIT); Shift+V → Strategic Map | Shift+V map; V exits pilot |
| **M** | Orbit MFD (or arm MPD if unlocked) | same |
| **L** | Codex viewer | same |
| **J** | Skills/Journal pane *(owned by SkillsPane's own listener)* | same |
| **B** | Shop (ORBITAL_VIEW only) | — |
| **` (backtick)** | toggle DebrisMap; Shift+` = TOOL_CYCLE | same |
| **, / .** | stow / deploy all struts | same |
| **+ / −** | throttle ±10% (in SK: orbit radius ∓) | SK: approach/retreat |
| **[ / ]** | power bus ∓10%; Shift+1/2/3 select bus | same |
| **1–6 / 7** | deploy/select/pilot arm; 7 = return to mother | switch piloted arm |
| **F2 / F4 / F5** | F2 (ARM_PILOT: cycle FEEP metal); F4 Forge; F5 fuel cycle | F2 metal cycle |
| **O / Shift+O** | deploy-all-to-target / recall-all (blocked in ARM_PILOT) | — |
| **Shift+G** | Trawl start | — |
| **Enter / Esc** | begin approach / pause·back | SK recall / exit pilot |
| **PageUp/Down** | comms scroll | same |
| **Arrows** | pitch/yaw (tether-aware spring) | SK θ/φ orbit (Shift = fine) |

**Inert/reserved:** `K` (empty), bare `G`, bare `J` (no-op marker), `T` in ARM_PILOT, `Enter` while piloting.

---

## 7. HUD & panes

[`HUD.js`](js/ui/HUD.js) coordinates a left column (StatusPanel), right column (DebrisWireframe + TargetPanel), top-right comms, body-mounted score, plus floating overlays.

- **Progressive reveal is effectively DISABLED for dimming.** `_applySkillReveal()` force-marks all groups `hud-active` (luminance dimming was "too hard to read"). `data-hud-group` / `SKILL_GROUP_TO_DOM` now only drive the corner keycap-glyph affordance + progression tracking. Panels render full-brightness from frame one. *(This supersedes the dormant-opacity design in FIRST_EXPERIENCE.md §8.)*
- **StatusPanel** — body-mounted score/objective bar ("CLEARED n/50", credits, hidden anchor-mass), Propulsion panel (`fuel-group`, key A: autopilot, ΔV, Xe/gas/battery, EDT, MPD rows, throttle, inline Forge F4), Power panel (`power-group`, Shift+1-3 / [ ]), Crossbow Fleet panel (`arms-group`, key D: per-arm status, lasso cooldown ring, WEB n/max). HOLDING_CATCH renders gold with a 🎣 badge. Control-mode (RCS/COLD GAS) badge was **removed**.
- **TargetPanel** — right column. Tracked (max 7, sort cycle), Untracked sensor (max 3), Active sats (max 3). Selected row expands with Net-ΔV, points, **MOID badge**, action hints. PaneChrome resize (Tab).
- **CommsPanel** — top-right, 3-color priority palette, PaneChrome resize (C). Hosts `executeCommsCommand(1–6)`.
- **RadialMenu** — C-hold radial: Deploy Weaver/Spinner, Fish, Recall All, Pilot [P], Deorbit [D], with arm-state gating.
- **SkillsPane** — bottom-left, J toggle (own listener). Experience-level opacity (NOVICE checklist "NEXT STEPS" → APPRENTICE auto-hide → VETERAN transient).
- **HintTicker** — bottom strip, max 4, driven by `HINT_POSTED`/`SKILL_STATE_CHANGED`.
- **NetInventoryPanel** — **SUSPENDED** (mounts `display:none`, never shown; logic/tests live). Redesign pending.

---

## 8. Camera system & ceremonies

[`CameraSystem.js`](js/systems/CameraSystem.js). `CameraViews` enum has **7** values: `FIRST_PERSON, CHASE, ORBIT, TARGET_LOCK, ARM_PILOT, INSPECTION, NET_CINEMATIC`. The **V-cycle is only CHASE↔ORBIT** (COMMAND↔OVERVIEW). `TARGET_LOCK` is **orphaned** (dropped from cycle; framing folded into CHASE via `targetLookBias`). INSPECTION entered via I / OVERVIEW-zoom Schmitt trigger.

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
| **Capture Net** (F/N in STATION_KEEP; F/N/Space manual in TRANSIT/APPROACH) | ✅ | Real FSM + cling probability |
| **Trawl** (Shift+G) | ✅ | TrawlManager auto-picks `clusters[0]` |
| **Deorbit sacrifice** (Ctrl+Shift+D) | ✅ | |
| **Reeling / Returning** (R/H, post-capture) | ✅ (indirect) | REELING = zero-fuel strut motor; RETURNING = FEEP |
| **HOLDING_CATCH** (park the catch) | ✅ (auto) | Daughter parks oversize catch at strut, stays occupied (§ HANDOFF 1.9) |
| **Fishing** | ⚠️ orphaned from keys | `deployFishing()` exists; only via ArmManager autopilot path / comms — no direct key |
| **Web Shot** | ⚠️ orphaned | `fireWebShot()` exists, **no keybinding** |
| **Ablation** | ⚠️ orphaned | flag off + no keybinding |
| **Magnetic grapple** (F in STATION_KEEP, MAGNET selected) | ✅ (P2) | `MAGNETIC_GRAPPLE` ENERGIZING→CLOSING→GRIP; ferrous→GRAPPLED, else→RETURNING. Gated by `DAUGHTER_MULTITOOL` |
| **Gripper jaws** (F in STATION_KEEP, GRIPPER selected — Weaver) | ✅ (P3) | `GRIPPER_GRAPPLE` EXTEND→SEEK→CLOSE→latch; fixtured→GRAPPLED, else→RETURNING. Gated by `WEAVER_GRIPPER` |
| **Multi-modal pad** (F in STATION_KEEP, PAD selected — Spinner) | ✅ (P4) | `PAD_CONTACT` APPROACH_SOFT→CONTACT (auto mode-resolve)→grip; adhered→GRAPPLED, bounce→RETURNING. Finite UV-cure magazine. Gated by `SPINNER_PAD` |

**Weaver vs Spinner ARE differentiated** under `CAPTURE_NET=true`: Weaver fires a MEDIUM net, Spinner a SMALL net (different diameter/mass/launch-speed/spin/tether), and catch success is resolved by `computeClingProbability()` (velocity·contact·roughness·spin·tension·distance × pBase) — **not** the legacy flat 85% (now dead code). The *multi-tool* decision (magnet/gripper/pad) is what's missing, not net differentiation.

**Captured-debris lifecycle:** authoritative `DebrisField.pinCapturedDebris()` welds the catch to the hauling arm (called post-arm-update). Catch is parked full-size in `HOLDING_CATCH` at the strut tip; **capture no longer removes debris** — field removal awaits a future furnace-transfer step (deferred). Salvage/scoring currently fires early on `ARM_RETURNED` (known timing debt).

---

## 10. Guidance stack

Three layers; only the first two exist today.

1. **OnboardingDirector** ([`OnboardingDirector.js`](js/systems/OnboardingDirector.js)) — **16 beats** (boot, handshake, arrows, struts, view, look, zoom, inspect, scan, target, autopilot, decision, lasso, daughter, captured, complete). Each interactive beat triggers on an `Events` constant; narrative beats auto-advance. Escalation → `TEACHING_MOMENT_FORCE` after idle (`IDLE_ESCALATION_MS`) or >6 unrelated inputs. Veteran-skip via `VETERAN_SKILL_THRESHOLD`. Emits `ONBOARDING_COMPLETE`. **No solo-flight/counter-beat, no PostOnboardingCoach (both spec'd, unbuilt).**
2. **TeachingSystem** ([`TeachingSystem.js`](js/systems/TeachingSystem.js)) — **19 first-encounter moments**, `_seen` Set persisted to `localStorage['teachingSeen']`. `TEACHING_MOMENT_FORCE` bypasses the seen-guard (used by Director escalation).
3. **MissionCoach** — **does not exist** (`js/systems/MissionCoach.js` absent). The 12-chapter arc has no per-chapter coaching layer in code.

**SkillsSystem** ([`SkillsSystem.js`](js/systems/SkillsSystem.js)) — **35 skills**, 5 tiers (orientation/core_tools/proficiency/advanced/mastery), 5 categories (nav/scan/collect/awareness/manage). States: undiscovered→discovered→practiced→mastered (mastery needs count AND `MASTERY_MIN_TIME=300s`). SM-2 spaced reminders. **No `triggerFilter`** (skills wire 1:1 to `triggerEvent`).

**CommsSystem** ([`CommsSystem.js`](js/systems/CommsSystem.js)) — **binary** suppression (`_onboardingActive`), NOT the graduated `_suppressionTier` (0–3) the mission-guidance design calls for. 6 channels (CMD/ALERT/HOUSTON/SCI/FLAVOR/MISSION); personas HOUSTON + ISRO BANGALORE/HASSAN with a scripted handoff line.

---

## 11. Missions, economy & win conditions

- **Mission number** = `floor(debrisCleared / 5) + 1` (`DEBRIS_PER_MISSION=5`). `MISSIONS.PROFILES` has **5 difficulty tiers** keyed by `minMission` (1/2/4/7/10) — ramping cluster count + enabling hydrazine→synergy→conjunction/kessler→weather/activeSats. **There is no 12-chapter narrative arc in code** — only these 5 numeric profiles.
- **MissionEventSystem** — 5 mid-mission triggers (hydrazine, synergy, kessler cascade, weather, conjunction) + **3 news events** from `data/news-events.json` (`ast_spacemobile_tumble`, `starlink_breakup`, +1) unlocked by capture count.
- **Two win conditions (both wired):** (A) **50 debris cleared** → `GAME_WIN` from `GameState.update()`; (B) **10,000 kg refined metal** contributed to the elevator contract in ShopScreen → `CONTRACT_COMPLETE` → win on next return-to-orbit.
- **Active-sat treaty guard** — `ActiveSatGuard.checkActiveSatArming()` invoked from **ArmManager** (3 arming paths); blocks arming against any NORAD present in `data/active-sats.json` (**51 sats**: ISS, Hubble, GPS, Starlink, etc.). **JWST is not in the catalog** (out of LEO/GEO scope).
- **Economy:** capture → cargo → ForgeSystem (refine metals / make FEEP propellant, F4) → fuel cycling (F5) → synergy bonuses → ShopScreen credits/upgrades. ΔV is the master resource (never free-regenerates except via salvage).

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
| **Transfer ellipse + launch countdown** | ❌ | ❌ |
| **Cluster selection** | partial — DebrisMap (backtick) picks a cluster → Shift+A engages autopilot | StrategicMap does NOT select clusters |

So the educational suite has a strong **situational-awareness** layer (MOID, bands, Hohmann) but **no maneuver-planning/timing tools** (porkchop, Lambert, CW, transfer-window countdown). These are the biggest unbuilt teaching opportunities (see ROADMAP).

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
| SkillsSystem "34"/"33 skills" | **35 skills** |
| TeachingSystem "12 moments" | **19 moments** |
| "5 camera views" / V cycles 3 | **7 CameraViews**, V cycles **2** (CHASE↔ORBIT); TARGET_LOCK orphaned |
| "21 upgrades" | **30 upgrades** |
| "Start → ORBITAL_VIEW, skipping briefing" | MENU → **BRIEFING** (target picker) → ORBITAL_VIEW |
| R = forge cycle | R = **recall/reel**; Forge = **F4** |
| Weaver/Spinner identical 85% dice-roll | **differentiated** (MEDIUM/SMALL net + cling physics); 85% path dead |
| StrategicMap unbuilt | **built** (bands/debris/hazards/ground-stations/MOID) — but no porkchop/Lambert/CW/cluster-select |
| MissionCoach / 12-chapter arc / graduated comms tiers / triggerFilter / solo-flight | **none exist in code** (design only) |
| TetherReel / BridleRing wired | **orphaned** (flags off, not in main.js) |
| Test baseline 272/1252 (old ARCHITECTURE) | **611 / 2537 / 0** |

---

*This blueprint reflects the code as of 2026-06-07. When you change architecture, update this file and the [`ROADMAP.md`](ROADMAP.md) gap table in the same shift.*
