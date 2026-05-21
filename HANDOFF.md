# Space Cowboy — Next-Shift Handoff Brief

*Updated: 2026-05-16 · Supersedes all prior HANDOFF entries · Prior sessions archived to [`archive/HANDOFF_AUTOPILOT_RETRO.md`](archive/HANDOFF_AUTOPILOT_RETRO.md).*

> **Status (May 16, 2026):** Epics 5–10 complete. **SK / Mission-1 polish cycle COMPLETE** — 7 polish tasks, 2 mid-flight additions, 2 diagnostic bug fixes. See [§9](#9-sk--mission-1-polish-cycle-2026-05-16) and [`SK_M1_POLISH_HANDOFF.md`](SK_M1_POLISH_HANDOFF.md) for full breakdown.
> Test suite: **460 suites / 2,060 tests / 0 failures** (up from 458/2,051 post-Epic 10).
> All 3 locked product principles honored: ✅ Offline-First, ✅ Dual-Metal FEEP is Y0, ✅ Mother Launches from India.
>
> ## ✅ Epic 9 — Config G Arm System — COMPLETE (2026-04-28)
>
> **Config G adopted + implemented** — barrel-axial top-collar geometry (2.0m × 0.8m barrel, 3-plane layout,
> ROSA panels, strut-mounted reel). All 11 code subtasks (C-1..C-11) delivered. See [`EPIC9_CODE_ORCHESTRATOR.md`](EPIC9_CODE_ORCHESTRATOR.md).
>
> **Systems delivered (all feature-flagged, default OFF):**
> - Config G constants + 3-plane geometry (C-1, C-2)
> - Meridian sweep aim + lockable hinge + semi-auto aim (C-3)
> - Stow/Deploy state machine (C-4) + Launch sequence + ROSA cinematic (C-5)
> - Capture net (14-state FSM, 3 net classes, slam/cinch modes) (C-6)
> - Strut-mounted tether reel (6-state machine, cable physics) (C-7)
> - Bridle ring (load-distribution, overload detection) (C-8)
> - CoM tracking + thruster plume interlock (C-9)
> - Tech ladder / shop (Y0→Y1→Y3 tier upgrades with TRL gating) (C-10)
> - End-to-end integration tests with all-flags-ON scenarios (C-11)
>
> **25 feature flags** (11 new in Epic 9). **~25 new events**. **~16 files created, ~30 modified.**
>
> ---
>
> ## ✅ Epic 10 — Config G Full Visualization — COMPLETE
>
> **The V3 Octopus visual is gone.** Epic 10 replaced the entire visual model with Config G:
> cylindrical barrel, collar-mounted struts with sweep animation, ROSA roll-out panels,
> FEEP nozzle polish, deploy-state LEDs, full stowage visual, launch cinematic, capture
> net visual, and tier progression visual. All 11 V-tasks delivered.
>
> **ST-9.6 (ablation):** Cancelled/skipped.
> **ST-9.9 (Reality Mode):** Deferred to Epic 11+.
>
> ### Completed Tasks (11/11):
>
> | Task | Title | Key Deliverables | Status |
> |------|-------|------------------|--------|
> | V-1 | Config G Barrel Mesh | Cylindrical barrel (0.4m R × 2.0m H, 16 segments), body-mount solar cells, removed V3 tether reels + magnetic ring + docking cavities | ✅ |
> | V-2 | Collar Ring + Hinge Mounts | Toroidal collar at Z=M*0.90, 4 hinge brackets at [60°,120°,240°,300°], status LEDs | ✅ |
> | V-3 | Strut + Sweep Animation | 4 animated struts (1.60m), pivot groups, tip nodes, driven by [`getAimAlpha()`](js/entities/ArmUnit.js:1080) | ✅ |
> | V-4 | Arm Remount | Dynamic dock offsets, arm orientation via [`postArmUpdate()`](js/entities/PlayerSatellite.js), deploy state visibility | ✅ |
> | V-5 | ROSA Panel Roll-Out | Chamfered ShapeGeometry panels, scaleX roll-out animation, stowed roll cylinders, coplanarity fix | ✅ |
> | V-6 | FEEP Nozzle Polish | Copper/bronze FEEP material, indium plume color, scaled nozzles, interlock dimming | ✅ |
> | V-7 | Launch Cinematic | [`LaunchCinematic.js`](js/scene/LaunchCinematic.js) — 9-phase fairing/pyro/FEEP/ROSA visual controller, event-driven | ✅ |
> | V-8 | Capture Net Visual | [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js) — 14-state FSM visual: canister/disc/tether, state-driven color/spin/scale | ✅ |
> | V-9 | Tier Progression Visual | [`TierVisualManager.js`](js/scene/TierVisualManager.js) — collar thicken, strut addition, end-face mounts, upgrade flash animation | ✅ |
> | V-10 | Deploy State LEDs | Hinge LED colors by state (LOCKED→dark, DEPLOYED→green, etc.), high-recoil amber, pulse effects | ✅ |
> | V-11 | Stowage Visual | α=0 stowed override, barrel stowage channels, daughter pockets, pyro-pin locks, journal bearing hinges | ✅ |
> | Y0 Polish | Visual Polish | ROSA coplanarity, arm visibility wiring, reel+crossbow on struts, barrel solar grid, tether dashes, thruster glow, earth atmosphere, daughter ROSA panels, ship +Z orientation fix | ✅ |
>
> All 11 tasks complete.
>
> ### Files Modified in Epic 10:
>
> | File | Key Changes |
> |------|-------------|
> | [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) | **Primary** — complete `_buildModel()` rewrite: Config G barrel, collar, struts, ROSA panels, solar grid, stowage channels, LEDs, tether dashes, thruster glow. New [`postArmUpdate()`](js/entities/PlayerSatellite.js) method called from main.js. **Debug (§2.1):** `_reelOffset` at 85%, strut-aligned quaternion, recoil 10% |
> | [`ArmUnit.js`](js/entities/ArmUnit.js) | Daughter ROSA panels + tether visual updates. **Debug (§2.1):** tether anchor Y↔Z fix, quaternion fix, opacity/color, proportional autopilot |
> | [`main.js`](js/main.js) | Arm manager wiring — [`setArmManager()`](js/main.js) now called, [`postArmUpdate()`](js/entities/PlayerSatellite.js) invoked from update loop. V-7/V-8/V-9 init + update loop wiring behind feature flags |
> | [`AutopilotSystem.js`](js/systems/AutopilotSystem.js) | Ship +Z orientation fix |
> | [`CameraSystem.js`](js/systems/CameraSystem.js) | Chase cam adjustments for new geometry. **Debug (§2.1):** 3-phase ceremony camera, near-plane fix, FOV fix, spring latch, radial-up fix, slew multiplier |
> | [`Earth.js`](js/scene/Earth.js) | Atmosphere visual layer |
> | [`InputManager.js`](js/systems/InputManager.js) | **Debug (§2.1):** Key blocking during ceremony, 2nd G-press ARM_PILOT exit, `,`/`.` strut stow/deploy |
> | [`Constants.js`](js/core/Constants.js) | **Debug (§2.1):** Tether color 0xddddee, slew rate 15°/s, undock time 1.5s |
> | [`LaunchCinematic.js`](js/scene/LaunchCinematic.js) | **NEW** V-7 — 9-phase launch cinematic: fairing build/separation, liftoff light, FEEP plume ramp, pyro bolt flash, ROSA emissive ramp |
> | [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js) | **NEW** V-8 — 14-state net visual: canister/disc/tether per arm/pod, state-driven appearance |
> | [`TierVisualManager.js`](js/scene/TierVisualManager.js) | **NEW** V-9 — tier upgrade visual: collar rebuild, strut addition, end-face mounts, flash animation |
>
> ### Key New APIs (Epic 10):
> - [`postArmUpdate()`](js/entities/PlayerSatellite.js) — **NEW**, called from [`main.js`](js/main.js) after arm manager update; positions daughters on strut tips, updates tethers + LEDs
> - [`setArmManager()`](js/entities/PlayerSatellite.js) — now wired in [`main.js`](js/main.js) for visual ↔ arm system coupling
> - [`setLaunchSequence()`](js/entities/PlayerSatellite.js) — wired and ready for V-7 launch cinematic
> - [`launchCinematic.init(scene, player)`](js/scene/LaunchCinematic.js) — V-7 launch visual controller
> - [`captureNetVisual.init(scene, player, captureNetSystem)`](js/ui/CaptureNetVisual.js) — V-8 net visual renderer
> - [`tierVisualManager.init(scene, player, armManager)`](js/scene/TierVisualManager.js) — V-9 tier visual manager
>
> ### Key APIs the visual layer reads from (all from Epic 9, do NOT modify):
> - [`arm.getAimAlpha()`](js/entities/ArmUnit.js:1080) — current strut sweep angle (drives V-3 animation)
> - [`arm.getDeployState()`](js/entities/ArmUnit.js:1186) — LOCKED/STOWED/DEPLOYING/DEPLOYED/STOWING (drives V-10 LEDs)
> - [`arm.isHighRecoilZone()`](js/entities/ArmUnit.js:1127) — α < 30° or > 150° (drives V-10 amber glow)
> - [`armManager.getStrutTipPosition(i, α)`](js/entities/ArmManager.js) — world-space strut tip (drives V-3, V-4)
> - [`armManager.getDeploySnapshot()`](js/entities/ArmManager.js) — all arms' state at once
> - [`armManager.getCurrentTier()`](js/entities/ArmManager.js) — Y0_QUAD/Y1_HEX/Y3_OCTO (drives V-9)
> - [`launchSequence.getCurrentPhase()`](js/systems/LaunchSequence.js) — launch phase (drives V-7)
> - [`launchSequence.getRosaProgress()`](js/systems/LaunchSequence.js) — wing1/wing2 0..1 (drives V-5)
> - [`captureNetSystem.getActiveNetForArm(i)`](js/entities/CaptureNet.js) — active net projectile state (drives V-8)
> - [`tetherReel.getReelRecord(i)`](js/systems/TetherReel.js) — cable length/state (drives tether visual)
>
> ### Orchestrator Reading Order (V-7, V-8, V-9 — retained for reference):
>
> 1. **[`EPIC10_VISUALIZATION_PLAN.md`](EPIC10_VISUALIZATION_PLAN.md)** — Complete task breakdown (V-1..V-11), dependency graph, acceptance criteria, risk register. Authoritative Epic 10 spec.
> 2. [`ARM_PIVOT_ANALYSIS.md §10.14`](ARM_PIVOT_ANALYSIS.md:1495) — Stowage geometry. Essential for V-7 (launch anim unfolds from stowed state).
> 3. [`ARM_PIVOT_ANALYSIS.md §10.15–§10.17`](ARM_PIVOT_ANALYSIS.md:1718) — ROSA deployment design. Essential for V-7.
> 4. [`ARM_PIVOT_ANALYSIS.md §10.11`](ARM_PIVOT_ANALYSIS.md:1235) — Locked Config G dimensions.
> 5. [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js) — **Updated** `_buildModel()` with full Config G geometry (no longer V3 Octopus).
> 6. [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js) — Daughter arm visual with ROSA panels + tether.
> 7. [`EPIC9_CODE_ORCHESTRATOR.md`](EPIC9_CODE_ORCHESTRATOR.md) — Epic 9 completion status + available APIs.
>
> ### Execution order: All V-tasks complete. See §4 and §5 for post-Epic 10 improvement backlog.
>
> ### Test baseline: 458 suites / 2,051 tests / 0 failures.
>
> **Config G mass budget (canonical):** Y0 dry=196.4 kg, wet=242.4 kg.
> ⚠️ Old mass values (198.4/244.4) appear in some doc sections not yet updated — Config G values in [`ARM_PIVOT_ANALYSIS.md §10.11`](ARM_PIVOT_ANALYSIS.md:1385) are authoritative.

---

## 🔒 Locked Product Principles (2026-04-25)

These three principles are **non-negotiable** and must be honoured in all subsequent design and implementation work.

### 1. Offline-First — No Auto-Fetch

The game **plays great offline and stays offline**. No background HTTP requests. No live TLE feeds. No telemetry.

- **News-driven content** enters via manual edits to [`data/news-events.json`](data/news-events.json) — user-driven, not API-driven.
- The only network access ever performed is loading textures + JS modules from CDN (one-time, vendorable).
- Optional Codex links to NASA/Celestrak open in user-clicked new tabs; never automatic.

**Live TLE feeds, auto-fetch APIs, and online sync features are explicitly OFF the roadmap.**

See [`FINAL_ANALYSIS.md §5.4`](FINAL_ANALYSIS.md) for full manifesto.

### 2. Dual-Metal FEEP Is Y0 Baseline (TRL 7–8)

Multimetal FEEP thrusters are **flight-demonstrated today** (Enpulsion IFM Nano series, 2024–2025). They are **not** future tech. The V5 daughter arm ships from factory with a dual-metal FEEP capable of running indium (default) OR a Forge-refined alternative metal cartridge (gallium / iodine / bismuth, etc).

- **Y0 baseline:** indium + 1 alt slot
- **Y1 unlock:** iodine, bismuth (TRL 6–7)
- **Y2 unlock:** mercury, cesium (TRL 5)
- **Y4 endgame:** tungsten + MPD-class power (TRL 4)

See [`DAUGHTER_ARM_CONTROLS.md §5`](DAUGHTER_ARM_CONTROLS.md) and [`GAME_FLOW_BRAINSTORM.md §7.2`](GAME_FLOW_BRAINSTORM.md).

### 3. Mother Launches from India — ISRO Heritage

The Octopus mothership launches on a cost-optimised ISRO LVM3 / SSLV mission. Indian Mission Operations are part of the comms loop alongside Houston.

- **Launch sites:** Satish Dhawan Space Centre (Sriharikota, 13.7°N) and Kulasekarapattinam Spaceport (Tamil Nadu, 8.4°N — equatorial advantage for GEO).
- **Comms personas (NEW):** **BANGALORE** (ISTRAC) for mission-critical ops, **HASSAN** (MCF) for GEO operations.
- **Houston** persona retained for US-side context and treaty consults.

Implementation: ~3 hours per [`FINAL_ANALYSIS.md §5A`](FINAL_ANALYSIS.md). New entries needed in [`data/ground-stations.json`](data/ground-stations.json).

### 🚀 Next Shift? Start Here

**SK / Mission-1 polish cycle is COMPLETE (2026-05-16).** Epic 10 visual model operational. SK standoff zoom, mother AP hold-lock, M1 debris cull, SkillsPane gating, opening-screen credits — all shipped. Full details + 7 lessons learned in [`SK_M1_POLISH_HANDOFF.md`](SK_M1_POLISH_HANDOFF.md).

**Next priorities (in order):**
1. **Extract R1–R7** new-user guidance recommendations from SK Research subtask (flagged as pending in [`SK_M1_POLISH_HANDOFF.md §5.1`](SK_M1_POLISH_HANDOFF.md))
2. **Centralise M1 visibility predicate** — `_isVisibleForCurrentMission()` is tripled in [`DebrisField.js`](js/entities/DebrisField.js) (see [`SK_M1_POLISH_HANDOFF.md §5.2.A`](SK_M1_POLISH_HANDOFF.md))
3. **§4 improvement backlog** — Tier A quick wins (§4.4 lasso speed + §4.5 lasso reusability), then Tier B first-experience UX

#### Config G Spacecraft Anatomy (reference)

```
         +Z (forward)
          │
    ┌─────┼─────┐ ← barrel cap (+Z end)
    │  ═══╪═══  │ ← COLLAR RING: toroidal ring at Z=+0.90m
    │  /  │  \  │   where 4 HINGE BRACKETS mount (at 60°/120°/240°/300°)
    │ ╱   │   ╲ │
    │╱    │    ╲│ ← STRUTS: 1.60m arms that pivot 0–180° from collar hinges
    ╳─────┼─────╳ ← TIP NODES: daughter arms (crossbow/reel/net) mount here
    │     │     │
    │ ┌───┴───┐ │ ← BARREL: cylinder 0.4m radius × 2.0m tall, body-mount solar cells
    │ │       │ │
    │ │ FEEP  │ │ ← FEEP NOZZLES: copper thrusters on −Z face
    └─┴───────┴─┘ ← barrel cap (−Z end)
          │
    ═══╤═══╤═══   ← ROSA PANELS: 2.0m roll-out solar arrays on each side
       │   │         (stowed as roll cylinders, unroll via scaleX animation)
```

| Term | What it is | Where in code |
|------|-----------|---------------|
| **Barrel** | Cylindrical core body (0.4m R × 2.0m H, 16 segments) | [`_buildBarrel()`](js/entities/PlayerSatellite.js) |
| **Collar ring** | Toroidal ring at Z=+0.90m where strut hinges mount | [`_buildCollar()`](js/entities/PlayerSatellite.js) — `THREE.TorusGeometry` |
| **Hinge bracket** | Pivot mount on collar at specific azimuth (60°/120°/240°/300° for Y0) | Inside [`_buildCollar()`](js/entities/PlayerSatellite.js) |
| **Strut** | 1.60m arm extending from hinge, sweeps 0–180° | [`_buildStruts()`](js/entities/PlayerSatellite.js) — pivot group + tube |
| **Tip node** | End of strut where daughter arm unit attaches | `strutTipNode` in [`_buildStruts()`](js/entities/PlayerSatellite.js) |
| **ROSA panel** | Roll-Out Solar Array — 2.0m chamfered panels, unroll animation | [`_buildROSAPanels()`](js/entities/PlayerSatellite.js) |
| **Stowage channel** | Groove on barrel surface where strut nests when folded (α=0) | Inside [`_buildBarrel()`](js/entities/PlayerSatellite.js) |
| **Daughter pocket** | Recess at stowed strut tip for daughter arm unit | Inside [`_buildBarrel()`](js/entities/PlayerSatellite.js) |
| **Deploy state LED** | Colored indicator per hinge (dark/green/amber/red by state) | Inside [`_buildCollar()`](js/entities/PlayerSatellite.js) |
| **α (alpha)** | Strut sweep angle: 0=stowed against barrel, π=fully forward | [`arm.getAimAlpha()`](js/entities/ArmUnit.js:1080) |

#### Step 1 — Orient (15 min)

| # | Read | Why |
|---|------|-----|
| 1 | **[`HANDOFF.md`](HANDOFF.md) status header + §9** (top of this file) | Current state: Epic 10 ✅, SK/M1 polish cycle ✅, test baseline 460/2060 |
| 2 | **[`SK_M1_POLISH_HANDOFF.md`](SK_M1_POLISH_HANDOFF.md)** TL;DR + §3 (Lessons L1–L7) + §4 (Conventions) + §5 (Open Work) | Most recent cycle: 7 lessons learned, project conventions reaffirmed, 3 path-forward items |
| 3 | **[`HANDOFF.md §3 Architectural Learnings`](#3-key-architectural-learnings--gotchas)** + **§8 Tech Debt** | Load-bearing rules + current debt list |
| 4 | **[`HANDOFF.md §7 Active Docs Index`](#7-active-docs-index)** | 4-category doc map (🟢 Canonical / 🟡 Active reference / 🟠 Heritage / 🪦 Stub) — know which doc to crack for what subsystem |

Heritage references (read only if working specifically on Epic 9/10 visuals):
- [`EPIC10_VISUALIZATION_PLAN.md`](EPIC10_VISUALIZATION_PLAN.md) — V-task acceptance criteria (V-1..V-11) — useful for visual-fidelity work on Config G
- [`EPIC10_IMPLEMENTATION.md`](EPIC10_IMPLEMENTATION.md) — patterns used in V-1..V-11

#### Step 2 — Pick a task

**Ordered priority (post SK/M1 polish, 2026-05-16):**

1. **Retrieve R1–R7** new-user-guidance recommendations into [`SK_M1_POLISH_HANDOFF.md §5.1`](SK_M1_POLISH_HANDOFF.md) — flagged as "pending retrieval"; small task but unblocks Tier C onboarding work (§4.9).
2. **Centralise M1 visibility predicate** — `_isVisibleForCurrentMission(debris)` is duplicated across 3 sites in [`DebrisField.js`](js/entities/DebrisField.js) (see [`SK_M1_POLISH_HANDOFF.md §5.2.A`](SK_M1_POLISH_HANDOFF.md)). Low risk, high readability win.
3. **§4 Improvement Backlog (pre-existing)** — pick from Tier A quick wins, then Tier B / C:
   - Tier A: §4.4 lasso speed (1–2 h) + §4.5 lasso reusability (2 h)
   - Tier B: §4.2 conjunction gating + §4.3 target panel + §4.1 debris visuals + §4.7 lasso visuals
   - Tier C: §4.9 onboarding redesign + §4.8 mission operations model
4. **Doc cleanup follow-through** — run the `git mv` block in [§9.1](#91-doc-cleanup-2026-05-16) to physically relocate Epic 10 + stubbed docs to `archive/`. Trivial; do alongside any other work.
5. **Larger refactors** (later) — Split [`DebrisField.js`](js/entities/DebrisField.js) (2093 LOC) and [`SkillsPane.js`](js/ui/hud/SkillsPane.js) (1869 LOC); update [`ARCHITECTURE.md`](ARCHITECTURE.md) for Epic 9/10 (V3 Octopus → Config G transition).

#### Step 3 — Run tests, verify baseline

```bash
node js/test/run-tests.js    # expect: 460 suites / 2,060 tests / 0 failures
```

If green, you're ready. If red, see [`SK_M1_POLISH_HANDOFF.md §7 Appendix`](SK_M1_POLISH_HANDOFF.md) for diagnostic-log grep targets (`[DBG-AP-DISENGAGE]`, `[DBG-AP-HOLD]`).

#### Completed Epic 10 V-tasks (reference — Heritage)

| Task | File |
|------|------|
| V-7: Launch Cinematic | [`LaunchCinematic.js`](js/scene/LaunchCinematic.js) — 9-phase cinematic driven by [`launchSequence.getCurrentPhase()`](js/systems/LaunchSequence.js) |
| V-8: Capture Net Visual | [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js) — 14-state FSM, reads [`captureNetSystem.getActiveNetForArm(i)`](js/entities/CaptureNet.js) |
| V-9: Tier Progression | [`TierVisualManager.js`](js/scene/TierVisualManager.js) — collar/strut growth, reads [`armManager.getCurrentTier()`](js/entities/ArmManager.js) |

### 📖 New Developer? Full Orientation Reading Order

| # | Document | Why | Time |
|---|----------|-----|------|
| 1 | **[`README.md`](README.md)** | Quick start, controls, project structure overview | 5 min |
| 2 | **[`GAME_DESIGN.md`](GAME_DESIGN.md)** | Core loop, jellyfish trawl identity, ΔV economy, heritage. Read §1–§3 for design pillars. | 10 min |
| 3 | **[`ARCHITECTURE.md`](ARCHITECTURE.md)** | §1 file structure + dependency flow, §6 module design, §3 game state machine. (Needs Epic 9/10 update.) | 20 min |
| 4 | **[`BIG_PICTURE.md`](BIG_PICTURE.md)** | Strategic 12-month roadmap — missions, educational viz, tech ladder, dependency graph. | 15 min |
| 5 | **This file ([`HANDOFF.md`](HANDOFF.md))** | §3 architectural gotchas (load-bearing rules), §4 improvement backlog, §8 tech debt. | 15 min |

**Deep dives (read as needed):**
- [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md) — V5 arm system physics & design bible (read before touching ArmUnit/ArmManager)
- [`ARM_PIVOT_ANALYSIS.md`](ARM_PIVOT_ANALYSIS.md) — Config G geometry bible, locked dimensions, stowage, ROSA (read before touching PlayerSatellite visual)
- [`CAPTURE_NET.md`](CAPTURE_NET.md) — Capture Net design: 14-state FSM, 3 net classes (read before V-8)
- [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md) — Educational concept mapping (read before adding teaching moments)
- [`SKILLS_ARCHITECTURE.md`](SKILLS_ARCHITECTURE.md) — Skills Discovery system internals (read before touching SkillsSystem/SkillsPane)
- [`FIRST_EXPERIENCE.md`](FIRST_EXPERIENCE.md) — First 90-second onboarding design (read before modifying first-session flow)

> **Companion document:** [`BIG_PICTURE.md`](BIG_PICTURE.md:1) — 12-month strategic roadmap. Key sections: §3 (Missions), §36 (Technology Upgrade Ladder Y0→Y4), §37 (dependency graph).

---

## Table of Contents

1. [§1 Project State Summary](#1-project-state-summary)
2. [§2 Recently Completed Work](#2-recently-completed-work)
   - **2.1 Debug Fix: G-Key Camera + Strut Deployment Regression (2026-05-07)**
   - **2.2 V-7: Launch Cinematic — Implementation Blueprint** ✅ *implemented*
   - 2.3 Epic 9 — Config G Arm System ✅
   - 2.4 Epic 8 — Daughter-Arm Redesign ✅
   - 2.5 Prior work
3. [§3 Key Architectural Learnings & Gotchas](#3-key-architectural-learnings--gotchas)
4. [§4 Next Steps — Improvement Backlog](#4-next-steps--improvement-backlog)
   - 4.1 Debris Visual Representation
   - 4.2 Conjunction Alerts — Timing & Clarity
   - 4.3 Target Analysis Panel Readability
   - 4.4 Lasso Travel Speed
   - 4.5 Lasso Reusability Model
   - ~~4.6 Arm / Tool Deployment Direction~~ — ✅ RESOLVED (Epic 10 V-4)
   - 4.7 Lasso Visual Representation
   - **4.8 Mission Operations Model — NASA/JPL-Style Debris Field Navigation**
   - **4.9 Onboarding Flow — Tutorial + Skills + Discovery Pane Redesign** (partially resolved)
5. [§5 Recommended Priority Order](#5-recommended-priority-order)
6. [§6 Testing Strategy Notes](#6-testing-strategy-notes)
7. [§7 Active Docs Index](#7-active-docs-index)
8. [§8 Known Issues / Tech Debt](#8-known-issues--tech-debt)
9. [§9 SK / Mission-1 Polish Cycle (2026-05-16)](#9-sk--mission-1-polish-cycle-2026-05-16)
   - **9.1 Doc Cleanup (2026-05-16)** — stub-replaced 4 redundant docs; new 🟢/🟡/🟠/🪦 doc-status taxonomy in §7; recommended `git mv` commands for Epic 10 heritage docs

---

## 1. Project State Summary

### 1.1 What the game is

Space Cowboy is a browser-based orbital-debris-capture sim. The player pilots an **Octopus-class** mother ship in low Earth orbit, finds & analyses tracked debris, flies the autopilot into a trailing rendezvous, then captures via **Capture Net** (spinning mesh, short-range), **Spinner/Weaver crossbow arms** (V5 fleet — 4 arms at Y0, expandable to 8 via tech ladder), or the **Trawl** sweep. Salvage is refined into fuel/parts; a Skills Discovery system surfaces 33 gameplay techniques organically as the player enacts them. The game teaches real aerospace concepts (Hohmann, inclination ΔV, Whipple shields, Kessler cascade, conjunction avoidance) through play.

The core identity is **Jellyfish Fisherman** (see [`GAME_DESIGN.md:48`](GAME_DESIGN.md:48)): the mothership drifts on orbital currents, tethered arms extend in a sphere, anything touching a tether gets reeled in — at **zero ΔV cost** because the tether does the braking. ΔV is the master resource, like MechWarrior 2's heat gauge.

### 1.2 Tech stack & how to run

| Layer | Choice |
|---|---|
| Rendering | [`three@^0.160`](package.json:1) (WebGL, no engine) |
| Language | ES Modules, no bundler (native `<script type="module">`) |
| Server | Python `http.server` on port 8081 via [`start.sh`](start.sh:1) |
| Tests | Node-based harness, no browser; see [`js/test/TestRunner.js`](js/test/TestRunner.js:1) |

```bash
./test.sh                       # run full suite
bash start.sh                   # http://localhost:8081
open http://localhost:8081/test.html   # browser-side diagnostics
```

### 1.3 Test suite status

**460 suites / 2,060 tests / 0 failures** as of 2026-05-16 (post SK/M1 polish — up from 458/2,051 after Epic 10). Harness does NOT stub DOM or `THREE`; tests use the real runtime for integration-level checks. Test files live under [`js/test/`](js/test/run-tests.js:1).

| File | Coverage |
|---|---|
| [`test-AutopilotSystem.js`](js/test/test-AutopilotSystem.js:1) | 33 tests — engage gates, phase machine, CA lock, conjunction disengage, HOLD geometry, **locked-target HOLD suppression** (2026-05-16) |
| [`test-OrbitalMechanics.js`](js/test/test-OrbitalMechanics.js:1) | Kepler ↔ Cartesian **round-trip guard** (Y↔Z regression) |
| [`test-CollisionAvoidance.js`](js/test/test-CollisionAvoidance.js:1) | Threat scan, exempt set, dodge RCS |
| [`test-Crossbow-ArmUnit.js`](js/test/test-Crossbow-ArmUnit.js:1), [`test-Crossbow-Constants.js`](js/test/test-Crossbow-Constants.js:1) | V5 spring/tether tiers, state transitions |
| [`test-SkillsSystem.js`](js/test/test-SkillsSystem.js:1) | Discovery state machine, SM-2 reminders, blitz detection |
| [`test-PowerDistribution.js`](js/test/test-PowerDistribution.js:1), [`test-ScoringSystem.js`](js/test/test-ScoringSystem.js:1), [`test-GameState.js`](js/test/test-GameState.js:1), [`test-EventBus.js`](js/test/test-EventBus.js:1), [`test-Constants.js`](js/test/test-Constants.js:1) | Core subsystems |

### 1.4 Systems & maturity

| System | File | Maturity |
|---|---|---|
| OrbitalMechanics | [`js/entities/OrbitalMechanics.js`](js/entities/OrbitalMechanics.js:1) | **Stable** — Y↔Z round-trip now fixed & tested |
| PlayerSatellite | [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js:1) | **Stable** — Config G visual model (Epic 10), [`postArmUpdate()`](js/entities/PlayerSatellite.js), [`applyCartesianImpulse()`](js/entities/PlayerSatellite.js:2145) |
| AutopilotSystem | [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js:1) | **Stable** — 4-phase state machine, `hasLockedTarget` HOLD fork (2026-05-16), `[DBG-AP-DISENGAGE]` diagnostic log |
| CollisionAvoidanceSystem | [`js/systems/CollisionAvoidanceSystem.js`](js/systems/CollisionAvoidanceSystem.js:1) | **Stable** — honors `AUTOPILOT_TARGET_LOCK` |
| DebrisField | [`js/entities/DebrisField.js`](js/entities/DebrisField.js:1) | **OK** — §4.1 visuals pending, §4.8 cluster metadata underused |
| LassoSystem | [`js/systems/LassoSystem.js`](js/systems/LassoSystem.js:1) | **OK but slow** — §4.4 speed, §4.7 visuals pending |
| ArmManager / ArmUnit | [`js/entities/ArmManager.js`](js/entities/ArmManager.js:1), [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js:1) | **Stable** — Config G collar-mount remount (Epic 10 V-4), ~~§4.6 direction bug~~ resolved |
| ConjunctionSystem | [`js/systems/ConjunctionSystem.js`](js/systems/ConjunctionSystem.js:1) | **OK** — §4.2 timing/explanation pending |
| TrawlManager | [`js/systems/TrawlManager.js`](js/systems/TrawlManager.js:1) | **OK** — auto-picks densest cluster; needs player-choice gate for §4.8 |
| SkillsSystem / SkillsPane | [`js/systems/SkillsSystem.js`](js/systems/SkillsSystem.js:1), [`js/ui/hud/SkillsPane.js`](js/ui/hud/SkillsPane.js:1) | **Functional but under-realized** — see §4.9 |
| ~~TutorialSystem~~ | ~~`js/systems/TutorialSystem.js`~~ | **DELETED** — removed Sprint 3 ST-3.2; bridge hack removed; conjunction gates migrated to skills-based |
| HUD + subpanels | [`js/ui/HUD.js`](js/ui/HUD.js:1), [`js/ui/hud/`](js/ui/hud/TargetPanel.js:1) | **OK** — §4.3 prominence, §4.8 field-assay MFD pending |
| CameraSystem, InputManager, ResourceSystem, ScoringSystem, ForgeSystem, CargoSystem, PowerDistribution, SensorSystem, KesslerSystem, AudioSystem | — | **Stable** |

Total: 25 system modules + 6 entity modules + 14 UI modules.

---

## 2. Recently Completed Work

### 2.1 Debug Fix: G-Key Camera + Strut Deployment Regression (2026-05-07)

A comprehensive debug session fixed multiple regression bugs in the launch ceremony camera system and strut deployment coordinates. **Test suite: 458 suites / 2,051 tests / 0 failures** (up from 438/1,995 — includes debug session + V-7/V-8/V-9 tests).

#### Bug 1: Camera Jump & Disorienting Rotation (Fixed)

| Fix | File | Detail |
|-----|------|--------|
| Removed lateral CCW profile movement in Phase 1 | [`CameraSystem.js`](js/systems/CameraSystem.js) | Phase 1 stays at CHASE view |
| Fixed stale `c.prevPos` orbital tracking in all phases | [`CameraSystem.js`](js/systems/CameraSystem.js) | Current-frame lerp targets |
| Eliminated FOV narrowing during Phase 1 | [`CameraSystem.js`](js/systems/CameraSystem.js) | FOV only changes Phase 2+ |
| Fixed one-frame camera gap on ceremony completion | [`CameraSystem.js`](js/systems/CameraSystem.js) | Returns ARM_PILOT pos instead of null |
| 2nd G press now transitions camera to new arm | [`InputManager.js`](js/systems/InputManager.js) | Exits ARM_PILOT before deploying |
| Near-plane pushed to 0.1m during ceremony Phase 2-3 | [`CameraSystem.js`](js/systems/CameraSystem.js) | Prevents near-clip on daughter |
| Key blocking during ceremony (ESC/G/Space/Enter only) | [`InputManager.js`](js/systems/InputManager.js) | No accidental ceremony skip |
| Radial-up fix for ARM_PILOT uses daughter's radial | [`CameraSystem.js`](js/systems/CameraSystem.js) | Correct up vector |

#### Bug 2: 2nd Strut Wrong Coordinates (Fixed)

| Fix | File | Detail |
|-----|------|--------|
| Tether anchor uses `dockOffset`/`_reelOffset` (PlayerSat frame) | [`ArmUnit.js`](js/entities/ArmUnit.js) | Fixed Y↔Z frame mismatch |
| Tether quaternion counteracts group rotation | [`ArmUnit.js`](js/entities/ArmUnit.js) | Tether in world orientation |
| Reel position at 85% of strut (not tip) | [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) | `_reelOffset` tracks reel |
| Strut deploy angle dynamic slew multiplier | [`CameraSystem.js`](js/systems/CameraSystem.js) | Budgets against UNDOCK_TIME |
| LAUNCHING arms get strut-aligned quaternion | [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) | No 180° flip |
| Spring latch prevents double launch on TRANSIT reset | [`CameraSystem.js`](js/systems/CameraSystem.js) | `c._springLatch` |

#### Additional Improvements

| Change | File | Description |
|--------|------|-------------|
| Tether color: Dyneema white (0xddddee) | [`Constants.js`](js/core/Constants.js) | Realistic fiber color |
| Tether opacity: 0.9 (from 0.75) | [`ArmUnit.js`](js/entities/ArmUnit.js) | Better visibility |
| No red/white flash (strain color off when TETHER_REEL flag off) | [`ArmUnit.js`](js/entities/ArmUnit.js) | Stable color |
| Strut slew rate: 15°/s (from 30°/s) | [`Constants.js`](js/core/Constants.js) | 50% slower for visibility |
| Crossbow undock time: 1.5s (from 0.3s) | [`Constants.js`](js/core/Constants.js) | Player sees strut aim |
| Recoil scaled to 10% | [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) | Subtle, not disorienting |
| `,`/`.` keys: gradual strut stow/deploy all | [`InputManager.js`](js/systems/InputManager.js) | Via `_strutTargetAlpha` |
| Daughter autopilot: proportional controller | [`ArmUnit.js`](js/entities/ArmUnit.js) | Replaces velocity lerp |
| New test files | [`test-daughter-autopilot-sim.js`](js/test/test-daughter-autopilot-sim.js), [`test-diagnostic-autopilot-sk.js`](js/test/test-diagnostic-autopilot-sk.js) | Autopilot + station-keep diagnostics |

#### Launch Ceremony Timeline (6.0s total)

1. **Phase 1 OBSERVE (2.25s)** — Camera at CHASE. Strut gradually aims at target. Spring fires at 1.5s. Daughter launches.
2. **Phase 2 TETHER_FOLLOW (3.0s)** — Camera zooms from mother to behind-daughter along tether. FOV narrows.
3. **Phase 3 HANDOFF (0.75s)** — Camera settles to ARM_PILOT view.

#### New Key Bindings

| Key | Action | File |
|-----|--------|------|
| `,` (comma) | Gradual strut stow all (via `_strutTargetAlpha`) | [`InputManager.js`](js/systems/InputManager.js) |
| `.` (period) | Gradual strut deploy all (via `_strutTargetAlpha`) | [`InputManager.js`](js/systems/InputManager.js) |

#### Files Modified in Debug Session

| File | Key Changes |
|------|-------------|
| [`CameraSystem.js`](js/systems/CameraSystem.js) | Launch ceremony 3-phase camera (OBSERVE/TETHER_FOLLOW/HANDOFF), near-plane fix, FOV fix, spring latch, radial-up fix, slew multiplier |
| [`InputManager.js`](js/systems/InputManager.js) | Key blocking during ceremony, 2nd G-press exits ARM_PILOT first, `,`/`.` strut stow/deploy |
| [`ArmUnit.js`](js/entities/ArmUnit.js) | Tether anchor Y↔Z fix, quaternion fix, opacity/color fixes, proportional autopilot controller |
| [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) | `_reelOffset` at 85%, strut-aligned quaternion for LAUNCHING, recoil 10% |
| [`Constants.js`](js/core/Constants.js) | Tether color 0xddddee, slew rate 15°/s, undock time 1.5s |

---

### 2.2 V-7: Launch Cinematic — Implementation Blueprint

> **✅ IMPLEMENTED** — See [`js/scene/LaunchCinematic.js`](js/scene/LaunchCinematic.js). Blueprint retained for reference.

> ~~This section is the complete implementation spec for the next shift.~~ V-7 dependencies V-3 (struts ✅) and V-5 (ROSA panels ✅) were both complete. Implementation delivered.

**Goal**: Create [`js/scene/LaunchCinematic.js`](js/scene/LaunchCinematic.js) (~200-250 LOC) that subscribes to the existing 9-phase [`LaunchSequence.js`](js/systems/LaunchSequence.js) state machine and drives visual effects (fairing, pyro flashes, FEEP glow, panel power ramp).

**Feature flag gate**: [`Constants.FEATURE_FLAGS.LAUNCH_SEQUENCE`](js/core/Constants.js) (default `false`)

#### 9-Phase Visual Mapping

| Phase | Duration | Visual Effect |
|-------|----------|---------------|
| `STOWED_IN_FAIRING` | Instant | Translucent half-cone fairing enclosing spacecraft |
| `LIFTOFF` | 4.0s | Camera shake + orange point light below |
| `FAIRING_SEPARATION` | 4.0s | Two fairing halves fly apart, rotate, dispose |
| `ORBIT_INSERTION` | 40s | FEEP plume glow fade-in (opacity 0→0.3) |
| `LAUNCH_LOCK_RELEASE` | ~0.5s | Per-strut pyro flash at hinge LEDs (white + PointLight) |
| `ROSA_DEPLOY_PRIMARY` | 6.0s | No-op (auto-handled by [`PlayerSatellite._updateRosaPanels`](js/entities/PlayerSatellite.js)) |
| `ROSA_DEPLOY_SECONDARY` | 6.0s | No-op (auto-handled) |
| `POWER_NOMINAL` | Instant | ROSA panel emissiveIntensity ramp 0.15→0.4 |
| `READY` | Terminal | Dispose fairing, restore camera, comms "All systems nominal" |

#### Key APIs to Hook Into

- [`Events.LAUNCH_PHASE_CHANGED`](js/core/Events.js) → `{ fromPhase, toPhase, elapsedTotalS, phaseDurationS, nextPhase }`
- [`Events.LAUNCH_LOCK_RELEASED`](js/core/Events.js) → `{ armIndex }`
- [`playerSatellite.hingeLEDs[]`](js/entities/PlayerSatellite.js) — LED meshes on collar for pyro flash
- [`playerSatellite.mainThrusterPlumes[]`](js/entities/PlayerSatellite.js) — FEEP plume meshes for glow
- [`playerSatellite.panelRightPivot`](js/entities/PlayerSatellite.js), [`panelLeftPivot`](js/entities/PlayerSatellite.js) — ROSA panel pivots for emissive ramp
- Fairing constants: `OCTOPUS_V5.FAIRING_DIAMETER` (2.1m), `FAIRING_LENGTH` (2.5m) — add to [`Constants.js`](js/core/Constants.js)

#### Files to Create/Modify

| Action | File | LOC Est | Detail |
|--------|------|---------|--------|
| **CREATE** | [`js/scene/LaunchCinematic.js`](js/scene/LaunchCinematic.js) | ~200-250 | Main cinematic controller: fairing build, event listeners, per-phase `update()` |
| **CREATE** | [`js/test/test-LaunchCinematic.js`](js/test/test-LaunchCinematic.js) | ~100 | Phase transition tests, fairing dispose, skip-to-ready |
| **MODIFY** | [`js/main.js`](js/main.js) | ~5 | Import + init + game loop call behind feature flag |
| **MODIFY** | [`js/test/run-tests.js`](js/test/run-tests.js) | ~1 | Add new test import |

#### Fairing Implementation Notes

- Build as two `ConeGeometry` halves (half the fairing), translucent material (`opacity: 0.3`, `side: DoubleSide`)
- Parent to spacecraft group, positioned to enclose barrel + collar + stowed struts
- On `FAIRING_SEPARATION`: animate each half with opposing lateral velocity + tumble rotation over 4s, then `dispose()` geometry + material
- Use `OCTOPUS_V5.FAIRING_DIAMETER` (2.1m) and new `FAIRING_LENGTH` (2.5m) constant

#### Acceptance Criteria

- [x] Fairing visible at game start when `LAUNCH_SEQUENCE` flag ON
- [x] Fairing separates into two halves and flies apart during `FAIRING_SEPARATION`
- [x] Per-strut pyro-bolt flash visible during `LAUNCH_LOCK_RELEASE`
- [x] FEEP plume glow fades in during `ORBIT_INSERTION`
- [x] ROSA panel emissive ramps up during `POWER_NOMINAL`
- [x] Camera returns to normal on `READY`
- [x] Cinematic skippable via `skipToReady()`
- [x] All existing 458 suites / 2,051 tests still pass

---

### 2.3 Epic 9 — Config G Arm System ✅ COMPLETE (2026-04-28)

All 11 code subtasks delivered. 25 feature flags, ~25 new events, ~16 files created, ~30 modified.
Full details in status header above and [`EPIC9_CODE_ORCHESTRATOR.md`](EPIC9_CODE_ORCHESTRATOR.md).

### 2.4 Epic 8 — Daughter-Arm Redesign + Dual-Metal FEEP + ISRO Heritage ✅ COMPLETE (2026-04-25)

5 sprints, ~6 dev days. Test delta: +34 suites / +92 tests. 0 regressions.
Key deliverables: STATION_KEEP state, orbital-crane controls, dual-metal FEEP (7 metals), news-driven missions, ISRO comms personas (BANGALORE/HASSAN), ReputationSystem, 6 files created, 18 modified.

### 2.5 Prior work

- **Doc Consolidation (Apr 25):** Executed [`ARCHIVAL_PLAN.md`](ARCHIVAL_PLAN.md) — archived `UX_FIXES_ROADMAP.md`, trimmed `BIG_PICTURE.md` and `HANDOFF.md`.
- **Sessions S19–S30:** Archived to [`archive/HANDOFF_AUTOPILOT_RETRO.md`](archive/HANDOFF_AUTOPILOT_RETRO.md) — autopilot trailing-rendezvous rewrite + trail system.

---

## 3. Key Architectural Learnings & Gotchas

These are **load-bearing** rules discovered in the autopilot rewrite. Violating them silently breaks physics without triggering any existing test.

### 3.1 Y-up (Three.js) vs Z-up (ECI) — the axis convention trap

The entire scene frame uses **Three.js Y-up** convention. Classical orbital-mechanics textbooks use **ECI Z-up**. The original [`orbitToSceneCartesian()`](js/entities/OrbitalMechanics.js:469) was Y-up. The inverse [`cartesianToKeplerian()`](js/entities/OrbitalMechanics.js:129) was Z-up and **had never been exercised** until `applyCartesianImpulse()`. The swap `y↔z` makes them a faithful round-trip.

- **Rule.** Any NEW code that round-trips `(position, velocity) → elements → (position, velocity)` MUST call the corrected function. Don't write a parallel version.
- **Guard test** — [`test-OrbitalMechanics.js:164`](js/test/test-OrbitalMechanics.js:164).

### 3.2 `TIME_SCALE_GAMEPLAY` (10×) — the silent multiplier

[`Constants.TIME_SCALE_GAMEPLAY`](js/core/Constants.js:1) scales orbital propagation so one real second advances orbits ~10 s. Any physics quantity that is "per tick" must account for this or be **10× too small**:

- **Propagation uses it:** [`DebrisField.update()`](js/entities/DebrisField.js:620) — `const gameDt = dt * Constants.TIME_SCALE_GAMEPLAY`. ✅
- **Autopilot ΔV clamp uses it:** bug #3 above. ✅
- **LassoSystem does NOT use it:** [`LassoSystem.js:419-422`](js/systems/LassoSystem.js:419) — `speed = Constants.LASSO_SPEED * M; step = speed * dt`. ❌ (§4.4 fix)
- **ArmUnit transit:** [`ArmUnit._updateLaunching()`](js/entities/ArmUnit.js:1207) integrates `velocity` in real `dt`. Audit if arms visibly lag the ship at high time-scale — worth checking in §4.6 fix.

**Rule.** Grep: `regex: TIME_SCALE_GAMEPLAY|gameDt`. Any physics loop computing impulses/velocities in m/s AND using `dt` (not `gameDt`) is suspect.

### 3.3 `_applyThrust()` vs `applyCartesianImpulse()` — when to use which

| API | Semantics | Use from |
|---|---|---|
| [`PlayerSatellite._applyThrust()`](js/entities/PlayerSatellite.js:2125) | Treats `(x, y, z)` as **orbital-element rate channels**: `x→Δe`, `y→Δi`, `z→Δa`. Low-pass, not an impulse. | Player input (`thrustIon`, RCS) — legacy contract. |
| [`PlayerSatellite.applyCartesianImpulse(dvWorld, dt)`](js/entities/PlayerSatellite.js:2145) | Takes a **Cartesian world-frame ΔV** (m/s). Does a full round-trip via `cartesianToKeplerian`. | Autopilot, any future physically-consistent controller. |

**Rule.** If reasoning about "push the ship this-way by N m/s in world space", use `applyCartesianImpulse`. If reasoning about "bump SMA", use `_applyThrust`. Mixing causes the exact mismatch that sank the old autopilot.

### 3.4 Collision-Avoidance exemption — two axes

[`CollisionAvoidanceSystem`](js/systems/CollisionAvoidanceSystem.js:1) maintains TWO exempt IDs:

1. `_activeTargetId` — fed by `TARGET_SELECTED` / `TARGET_CLEARED` (Tab-selection).
2. `_autopilotLockId` — fed by `AUTOPILOT_TARGET_LOCK` / `_UNLOCK` (new).

Before the fix, AP in `DEBRIS`/`TRAWL` mode → no `TARGET_SELECTED` → CA dodged the chased debris → oscillation. Now AP always emits the lock.

**Rule.** Any new "pursuit" system (hunt-and-tag, escort, docking) emits a LOCK event so CA stops fighting you.

### 3.5 Test-stub blindness

The round-trip guard in [`test-OrbitalMechanics.js:164`](js/test/test-OrbitalMechanics.js:164) is the single most important test added this shift — it would have caught bug #1 the day it was introduced. **Stubs hide bugs.**

**Rules.**
1. For every physics helper: write `f⁻¹(f(x)) ≈ x` to tolerance.
2. Prefer integration tests over stubs. One real end-to-end call beats ten `mock.calls[0]` assertions.
3. Factor-of-10 error? Suspect `TIME_SCALE_GAMEPLAY`.
4. 90°/180° error? Suspect a local-to-world transform missing (see §4.6).
5. Add a regression test for every bug found.

### 3.6 Constants-first refactors

The AP work added 14 knobs into [`Constants.AUTOPILOT`](js/core/Constants.js:907). Every tunable is named, commented, referenced from one place. Three debug retrospectives each adjusted constants only — no control-law touches. **Hoist magic numbers.**

### 3.7 Scene-unit scale `M = 1e-5`

`M = 0.00001` = "1 metre in scene units" (scene unit = 100 km). `SCENE_SCALE = 1e-5` = "1 km in Earth-radius-scaled scene units." Collisions have occurred. **Distances in metres in Constants; multiply by `M` at the boundary.**

---

## 4. Next Steps — Improvement Backlog

> **6 open items** (was 9 — §4.6 resolved by Epic 10 V-4, §4.9 #2 TutorialSystem deletion done, §4.9 #5 skills gates partially done).

For each: (a) current-state cite with line numbers, (b) problem, (c) proposed approach with code-level detail, (d) S/M/L/XL complexity, (e) dependencies. **§4.1–§4.5 + §4.7 are tactical** — each is 1–10 hours and visible as a commit. **§4.8 and §4.9 are strategic multi-sprint features** that re-frame the game from "catch floating stuff" into "run a sustained ADR operation" (§4.8) and re-engineer the first-session experience (§4.9).

### 4.1 Debris Visual Representation

**Symptom.** All debris looks identical — rapidly spinning spiky white crumpled paper. On close inspection size/type distinctions are invisible.

**Current state.**
- [`DebrisField._buildInstancedMeshes()`](js/entities/DebrisField.js:444) creates one InstancedMesh per shape with a shared geometry and single grey material.
- Geometries: `icosahedron` ([`_makeFragmentGeometry()`](js/entities/DebrisField.js:509)) — one per 480 fragments; `cylinder` ([`_makeRocketBodyGeometry()`](js/entities/DebrisField.js:526)) — one per 96 rocket bodies; `box` ([`_makeDefunctSatGeometry()`](js/entities/DebrisField.js:531)) — *comment says "For simplicity, use a single box"*.
- [`DebrisWireframe.js`](js/ui/DebrisWireframe.js:1) already has **differentiated** canvas-2D wireframes: [`buildRocketBody()`](js/ui/DebrisWireframe.js:94), [`buildDefunctSat()`](js/ui/DebrisWireframe.js:146), [`buildMissionDebris()`](js/ui/DebrisWireframe.js:213), [`buildFragment()`](js/ui/DebrisWireframe.js:273) (deterministic by ID).
- Tumble rates [`DEBRIS_TYPES`](js/entities/DebrisField.js:26) — `10–180 °/s` for fragments, multiplied ×10 by `TIME_SCALE_GAMEPLAY` = unrealistic spin.

**Proposed approach.**
1. **Port wireframe shapes** — convert `vertices + edges + zones` from [`DebrisWireframe.js`](js/ui/DebrisWireframe.js:1) into `THREE.BufferGeometry` + `LineSegments` (or meshed versions). Because shapes are already zone-annotated, unlocks future per-zone coloring / damage states.
2. **Per-ID variation** for fragments (cheap, ~480 small geometries, 5–7 verts each). For rocket/defunct/mission, 3–5 variants picked by `id % N`.
3. **Material by material-type** — debris already tagged `material ∈ {aluminum, titanium, composite, mli_mylar, solar_cell}` at [`DebrisField.js:265`](js/entities/DebrisField.js:265). Map to 5 distinct `MeshStandardMaterial`s.
4. **Tumble cap** — clamp effective visual tumble ≤ 30°/s in world time; divide [`DEBRIS_TYPES.tumbleMax`](js/entities/DebrisField.js:27) by `TIME_SCALE_GAMEPLAY`.

**Acceptance.** Standing near 3 random debris from different type categories, the player names each without reading the Target Panel.

**Complexity: M** (~6–10 h). **Dependencies:** synergy with §4.3 (wireframe panel matches scene object).

---

### 4.2 Conjunction Alerts — Timing & Clarity

**Symptom.** Alerts fire too early in the new-player arc; no teaching context.

**Current state.**
- [`ConjunctionSystem`](js/systems/ConjunctionSystem.js:1) fires every **30–120 s** ([`CHECK_MIN_S/MAX_S`](js/systems/ConjunctionSystem.js:48)) up to **3 alerts** ([`MAX_ALERTS`](js/systems/ConjunctionSystem.js:52)).
- Suppression gated on `tutorialStage < 7` ([`ConjunctionSystem.js:358-360`](js/systems/ConjunctionSystem.js:358)) — **but SkillsSystem force-emits `TUTORIAL_STAGE_CHANGED { stage: 9 }`** at [`SkillsSystem.js:82`](js/systems/SkillsSystem.js:82), leaving the gate open from second one.
- RED display 30 s, YELLOW 10 s, GREEN 5 s — [`_emitAlert()`](js/systems/ConjunctionSystem.js:369).
- [`CodexSystem.js:319, 1281`](js/systems/CodexSystem.js:319) has two Tech Library entries triggered BY the alert — player must experience scare before reading explanation.

**Proposed approach.**
1. **Gate on first capture.** Subscribe to `ARM_CAPTURED` / `LASSO_CAPTURED` in [`ConjunctionSystem`](js/systems/ConjunctionSystem.js:61); require `_captureCount ≥ 1` AND `missionElapsed ≥ 120 s` before first alert.
2. **Pre-alert briefing.** First alert ONLY — queue a 3-line comms primer 5 s before the overlay fires.
3. **Force first alert to GREEN tier** regardless of miss distance — informational, no fear.
4. **Codex pre-unlock** — move `triggerEvent` for the 2 conjunction entries from `CONJUNCTION_WARNING` to `FIRST_CAPTURE` so entries sit in Tech Library BEFORE the alert.
5. **HUD affordance** — `[?]` glyph on the overlay links to the Tech Library entry.

**Complexity: S–M** (~3–5 h). **Dependencies:** partial overlap with §4.9 (onboarding) but shippable independently.

---

### 4.3 Target Analysis Panel Readability

**Symptom.** Selected row doesn't stand out enough; Earth rotation changes panel transparency.

**Current state.**
- Selected row: [`TargetPanel.js:57-60`](js/ui/hud/TargetPanel.js:57) — `border-left-color: #00ccff; background: rgba(0, 204, 255, 0.10)` (10% alpha).
- Wireframe panel bg: [`DebrisWireframe.js:24`](js/ui/DebrisWireframe.js:24) — `rgba(0, 10, 25, 0.75)` — 25% Earth bleed-through.

**Proposed approach.**
1. **Opaque backgrounds** — bump `.hud-panel` and wireframe bg to `rgba(5,10,20,0.95)`.
2. **Prominent selection** — selected row: `background: rgba(0, 204, 255, 0.22)` + `box-shadow: 0 0 8px rgba(0, 204, 255, 0.4) inset`; `border-left: 3px`; add `text-shadow` to selected name.
3. **3-D reticle** — thicken [`TargetReticle`](js/ui/TargetReticle.js:1) bracket, pulse at 0.8 Hz.
4. **Earth-contrast fallback** — detect Earth-bright overlap and apply `.hud-panel--earth-overlap` with alpha 0.98.

**Complexity: S** (~2–4 h, mostly CSS).

---

### 4.4 Lasso Travel Speed

**Symptom.** Lasso takes ~15 s to cover 120 m.

**Current state.**
- [`Constants.LASSO_SPEED = 5.0 m/s`](js/core/Constants.js:756); [`LASSO_RANGE = 200 m`](js/core/Constants.js:755).
- [`LassoSystem.update()`](js/systems/LassoSystem.js:419-422) uses **real dt**, not `gameDt` (§3.2 gotcha).
- Reel-in: [`LassoSystem.js:378`](js/systems/LassoSystem.js:378) — 2 s hard-coded.

**Proposed approach.**
1. **Raise `LASSO_SPEED` to 40 m/s** (real ESA e.Deorbit tether reaches 50–80 m/s).
2. **Fix time-scale** — in [`LassoSystem.js:419`](js/systems/LassoSystem.js:419), `speed * dt * Constants.TIME_SCALE_GAMEPLAY`.
3. **Reel-in speed-up** — `_reelProgress += dt * 1.5` (0.7 s).
4. **Adjust `maxFlightTime`** to 8 s.
5. **Trail sampler** — halve `_trailSampleTimer` threshold from 0.06 → 0.03.

**Acceptance.** Cast→contact ≤ 4 s at 120 m; cast→catch ≤ 5 s including reel.

**Complexity: S** (~1–2 h).

---

### 4.5 Lasso Reusability Model

**Symptom.** Model is unclear — reusable with hidden cooldown.

**Current state.**
- [`LassoSystem`](js/systems/LassoSystem.js:17) `cooldown = 2` after catch, `1` after miss ([`LassoSystem.js:536, 547`](js/systems/LassoSystem.js:536)).
- No [`ResourceSystem`](js/systems/ResourceSystem.js:1) cost.
- `LASSO_DENIED` → comms message, no persistent UI.

**Proposed approach — Option A (recommended, ship now).**
- Keep reusable with cooldown, **surface it**:
  - 2-s ring progress indicator next to SPACE key hint in [`StatusPanel`](js/ui/hud/StatusPanel.js:1).
  - First-cast comms: `"Lasso ready in 2 s — unlimited casts, recharges from onboard power."`
  - Hoist magic numbers into `Constants.LASSO_COOLDOWN_CATCH`, `LASSO_COOLDOWN_MISS`.

Options B (single-use + crafting) and C (5-round mag refilling at 1/30s) listed in prior draft — **defer to later design iteration**.

**Complexity: S** (Option A, ~2 h).

---

### ~~4.6 Arm / Tool Deployment Direction (180° Bug)~~ — RESOLVED (Epic 10 V-4)

~~**Symptom.** Arms deploy in the wrong direction — appears 180° off.~~

**Resolution:** Epic 10 V-4 "Arm Remount" completely reworked dock offset architecture for Config G collar-mount geometry. Dynamic dock offsets now computed via [`postArmUpdate()`](js/entities/PlayerSatellite.js) called from [`main.js`](js/main.js), with arm orientation driven by strut tip positions. Ship +Z orientation fix in [`AutopilotSystem.js`](js/systems/AutopilotSystem.js) ensures correct world-frame alignment.

---

### 4.7 Lasso Visual Representation

**Symptom.** Projectile reads as a "2-D orange polyhedron"; tether is thin.

**Current state.**
- Projectile: [`LassoSystem.js:107-115`](js/systems/LassoSystem.js:107) — `SphereGeometry(M * 5, 6, 6)` (6-segment sphere reads as flat hex at distance).
- Tether: [`LassoSystem.js:117-131`](js/systems/LassoSystem.js:117) — 16-segment `THREE.Line`, no apparent thickness.
- Muzzle/contact flash, ring, trail already exist ([`LassoSystem.js:147-180`](js/systems/LassoSystem.js:147)).

**Proposed recommended sprint.**
1. **Bolas head** (M) — group: `torus` (loop, axis along velocity) + `cylinder` (shaft) + two small weights. Rotate ~4 Hz during flight.
2. **Thick tether** (S) — `TubeGeometry` along `CatmullRomCurve3`, OR `three/examples/jsm/lines/LineSegmentsGeometry`. Real 3-D thickness with lighting.
3. **Contact sparks** (S) — replace wireframe sphere ring at [`LassoSystem.js:170-179`](js/systems/LassoSystem.js:170) with 12 radial sparks over 0.4 s.

Options 4 (energy-arc shader) and 5 (net unfurl with cloth sim) → future polish.

**Complexity: M** (~4–6 h for sprint 1+2+3). **Depends on:** §4.4 speed fix first, §4.1 for context.

---

### 4.8 Mission Operations Model — NASA/JPL-Style Debris Field Navigation (Strategic)

**Thesis.** The game is already structurally an ADR (Active Debris Removal) operation — see [`GAME_DESIGN.md §1`](GAME_DESIGN.md:8), *"ADR platform — the V5 Crossbow."* Real NASA/JPL ADR missions (ClearSpace-1, ELSA-d, RemoveDEBRIS) follow a **plan → assay → approach → station-keep → capture → depart** pattern. The codebase already has 80% of the data — [`DebrisField.getDebrisClusters()`](js/entities/DebrisField.js:1485) produces rich per-cluster metadata — but the **pilot has no HUD surface to reason about it**. Closing that gap turns "grab floating stuff" into "run a sustained orbital salvage operation."

#### 4.8.1 Current state — what already exists

| System | File | What it computes that isn't surfaced |
|---|---|---|
| Cluster analysis | [`DebrisField.getDebrisClusters()`](js/entities/DebrisField.js:1485) | Per-cluster: `count`, `totalMassKg`, `avgAltKm`, `types` histogram, **`center` cartesian position**, `targets[]`. Sorts by `count × varietyCount`. |
| Trawl sweep | [`TrawlManager`](js/systems/TrawlManager.js:14) | Auto-picks `clusters[0]` (densest) on `ORBITAL_VIEW` at [`TrawlManager.js:55`](js/systems/TrawlManager.js:55) — **no player choice**. Tracks window, opportunities, catches per pass. |
| Autopilot target modes | [`AutopilotSystem._resolveHeading()`](js/systems/AutopilotSystem.js:556) | Priority: TARGET → TRAWL cluster center → DEBRIS (nearest large) → PROGRADE. Can already aim at cluster centroids. |
| Salvage economics | [`TargetPanel`](js/ui/hud/TargetPanel.js:1) + [`computeTotalSalvageDeltaV()`](js/entities/OrbitalMechanics.js:1) | Net ΔV per target shown in expanded row only (selected target). **No cluster-level aggregate.** |
| Sweep report | [`SweepReportUI`](js/ui/SweepReportUI.js:1) + [`RewardSystem`](js/systems/RewardSystem.js:1) | Post-sweep rating, synergies, stars. **Nothing pre-sweep.** |
| Kessler cascade | [`KesslerSystem`](js/systems/KesslerSystem.js:1) | Spawns fragments on cascade event. Untied to mission objectives. |
| Space weather | [`SpaceWeatherSystem`](js/systems/SpaceWeatherSystem.js:1) | Degrades sensors/panels. Untied to mission planning. |

**The gap:** The player arrives in ORBITAL_VIEW and sees **one** debris field. They don't know there are 7 × 5 = 35 potential clusters (7 inclination bands × 5 altitude bands — see [`DebrisField.js:1487-1494`](js/entities/DebrisField.js:1487)). They can't compare clusters before committing ΔV to travel to one. They can't choose their entry vector. This is the opposite of how NASA plans an ADR mission.

#### 4.8.2 How NASA/JPL actually approaches a debris-field ADR mission

From RemoveDEBRIS (2018) and ClearSpace-1 (2026) flight-design docs, condensed:

1. **Pre-mission field assay.** Ground pre-computes candidate targets: center-of-mass location, relative velocity to chaser, collision-probability grid (Pc), tumble rate, estimated mass/composition.
2. **Approach-vector selection.** Chaser aims at the trailing **R-bar** (radial) or **V-bar** (velocity-vector) hold point at a chosen standoff — typically 100 m → 30 m → 10 m → 5 m keep-out ellipsoid gates.
3. **Station-keeping.** Chaser holds the hold point with RCS impulses. Any tool firing (harpoon, net, robotic arm) generates recoil; station-keeping compensates automatically.
4. **Capture with recoil budget.** Tool ΔV is pre-loaded into the fuel budget. If recoil exceeds margin → abort back to hold.
5. **Depart with hauled mass.** Mass budget updated; departure ΔV recalculated; deorbit to ~200 km burn-up altitude OR transfer to graveyard orbit.
6. **Conjunction awareness is continuous, not episodic.** SPACECOM feeds CDMs (Conjunction Data Messages) throughout the approach. Crew sees them as a threat list with Pc per debris, not as surprise overlays.

Relevant game analogs **already implemented** or straightforward:
- Cluster assay → [`getDebrisClusters()`](js/entities/DebrisField.js:1485).
- R-bar / V-bar hold point → [`AutopilotSystem`](js/systems/AutopilotSystem.js:1) HOLD phase at the trailing point `P_d − v̂_d · D_trail` (§2.1).
- Station-keeping → HOLD already does position-hold; needs recoil compensation.
- Conjunction feed → [`ConjunctionSystem`](js/systems/ConjunctionSystem.js:1) already computes Pc-like miss distances.
- Sweep report → [`SweepReportUI`](js/ui/SweepReportUI.js:1).

#### 4.8.3 Proposed feature set — 5 concrete improvements

##### A. Pre-Mission Field-Assay MFD (Mission Briefing Panel)

**New UI** — a small **Left MFD** (fits the existing `left-column` [`HUD.js`](js/ui/HUD.js:1) pattern; Orbiter-inspired per [`GAME_DESIGN.md §1 Heritage`](GAME_DESIGN.md:26)) that polls [`DebrisField.getDebrisClusters()`](js/entities/DebrisField.js:1485) every 5 s and ranks the **top 5 reachable clusters** by a composite score:

```
Cluster Score = (totalMassKg × varietyBonus × reachable)   /   (deltaV_to_cluster + conjunction_risk)
```

Where:
- `varietyBonus` = `count(unique types)` — a 4-type cluster is worth more than a 4-fragment cluster (synergy potential).
- `reachable` = 1 if within player's `remainingDeltaV` budget, else 0.
- `deltaV_to_cluster` = Hohmann cost via existing [`totalDeltaV()`](js/entities/OrbitalMechanics.js:288) between player orbit and cluster centroid orbit.
- `conjunction_risk` = count of debris in cluster with `tracked == false` (untracked = risk) + any active conjunction alerts in that altitude band.

**Displayed per cluster (row):**
```
Cluster             Alt    Inc    N    Mass     ΔV-in  Score  Risk
───────────────────────────────────────────────────────────────────
ISS Band 400-600    480km  51.6°  42   1.2 t    1.8    ★★★★   ◐
SSO Band 700-900    820km  97.5°  38   890 kg   3.4    ★★★    ○
Cape Canaveral      340km  28.5°  19   340 kg   2.1    ★★     ●
Russian SSO 900+    920km  82°    28   710 kg   4.8    ★      ◐
Scattered           mixed  mixed  51   2.1 t    0.9    ★★★★★  ●
```

A selected cluster becomes the **autopilot target via "engage cluster" action** (new comms-menu option OR `Shift+A`). AP's existing TRAWL heading mode already handles cluster centroids — [`AutopilotSystem.js:576-583`](js/systems/AutopilotSystem.js:576).

##### B. Station-Keeping Recoil Compensation

When in AP HOLD phase, firing a tool produces recoil (lasso, crossbow arm launch, trawl deploy all impart momentum opposite to tool direction). Currently, nothing compensates — player drifts out of HOLD.

**Fix.** When AP is in HOLD phase and a tool fires, auto-command an opposite-direction `applyCartesianImpulse` of equivalent magnitude via the new [`PlayerSatellite.applyCartesianImpulse()`](js/entities/PlayerSatellite.js:2145) API. Details:

- **Listen** in [`AutopilotSystem`](js/systems/AutopilotSystem.js:1) for `LASSO_FIRED`, `CROSSBOW_FIRE`, `TRAWL_START`.
- **Compute reaction impulse** from projectile mass × projectile velocity (all known at emission).
- **Apply opposite impulse** to the player — this is a first-order Newton's-3rd-law compensation.
- **Budget accounting:** charge the station-keeping ΔV to a separate `stationKeepingDeltaV` counter displayed in the Field Assay MFD — players see the cost of over-reliance on the lasso.

**Constants** — new `AUTOPILOT.STATION_KEEP_COMPENSATION = true` toggle, plus `STATION_KEEP_EFFICIENCY = 0.85` (real RCS thrusters are ≤ perfect).

##### C. Mission Progression — Spawn Difficulty Curve

Currently ALL players start with [`WELCOME_FIELD`](js/entities/DebrisField.js:61) + random field. For advanced players, the first ORBITAL_VIEW feels the same as mission 20.

**Proposed.** Tie spawn configuration to `scoring.missionNumber` (already exists — [`ScoringSystem.js:327`](js/systems/ScoringSystem.js:327) computes `Math.floor(debrisCleared / 5) + 1`).

| Mission | Field profile | Key difficulty levers |
|---|---|---|
| **1 (first session)** | Welcome field (7 debris at 150–2500 m); 1 cluster nearby (ISS band); low tumble; NO hydrazine; NO conjunction alerts | Ensures lasso+AP works on trip one |
| **2–3** | Welcome field + 2 clusters visible; moderate tumble; 1 tracked hydrazine tank labeled 🟡 | Introduces cluster choice + risk debris |
| **4–6** | 4 clusters across different inclinations; hidden untracked debris revealed only by scan; 1 synergy pair placed | Teaches scanning-reveals-info loop |
| **7–9** | 6 clusters; mid-mission Kessler cascade spawns fragments; conjunction alerts begin | Time pressure + dynamic events |
| **10+** | Full random field; active sats to respect; space-weather events; solar storm windows | Endgame |

**Implementation.** Extend [`DebrisField._spawnWelcomeField()`](js/entities/DebrisField.js:1) (already a one-shot on first ORBITAL_VIEW) to accept `missionNumber` and branch on profile. Profile table in [`Constants.js`](js/core/Constants.js:1) under new `MISSIONS.PROFILES`.

##### D. Dynamic Mid-Mission Events (MW2-style)

MW2's bar was *"a scan reveals new info — the mission changes."* The systems needed are all present; they're just not wired:

| Trigger | Event | Mission change |
|---|---|---|
| `SCAN_DISCOVERY` on a previously-untracked debris that has `salvage.hydrazine > 0` | `DEBRIS_HAZARD_REVEALED` | Comms: *"Residual hydrazine detected — maintain 500 m standoff. +500 bonus for safe capture."* Updates [`AutopilotSystem`](js/systems/AutopilotSystem.js:1) D_TRAIL to 500 for this target. |
| `SCAN_DISCOVERY` reveals an adjacent debris with a synergy pair ([`Constants.SYNERGY_PAIRS`](js/core/Constants.js:1)) | `SYNERGY_OPPORTUNITY` | Comms: *"Gallium + Copper pair nearby — +300 pts if captured within 5 min."* Spawns a `_missionBonus` timer in [`ScoringSystem`](js/systems/ScoringSystem.js:1). |
| `KESSLER_CASCADE` while in a cluster | `CASCADE_THREAT` | Comms: *"Cascade event — 8 new fragments in your band. Priority: depart or secure high-value targets first."* Adds fragments to current cluster. |
| `WEATHER_EFFECT_START` severe solar storm | `WEATHER_MISSION_EFFECT` | Comms: *"Solar storm — sensors degraded for 10 min. Scan range halved. Keep ΔV reserve."* |
| `ConjunctionSystem` predicts cluster-wide multi-object approach | `CLUSTER_CONJUNCTION` | Comms: *"Multiple contacts converging at your altitude in 90 s. Depart NOW or station-keep low."* Autopilot can pre-emptively plot departure. |

**Wiring.** Each mission-change event updates the [`Field Assay MFD`](HANDOFF.md:4.8) bonus counter, comms, and optionally the HUD conjunction panel. Most of the code exists — what's missing is the **coupling** between scan results and mission state.

##### E. Tool-Tier Efficiency Teaching

The V7 design intent is *"autopilot+lasso is easy, but arms and trawl are more efficient"* ([`GAME_DESIGN.md §5`](GAME_DESIGN.md:147)). Currently the player doesn't learn this — there's no feedback loop that compares capture methods.

**Proposed.** Extend [`SweepReportUI`](js/ui/SweepReportUI.js:1) with a per-capture-method ΔV breakdown:

```
╔══════════════════════════════════════════════════╗
║          CAPTURE EFFICIENCY REPORT               ║
║                                                  ║
║  Method       Catches  ΔV spent  ΔV/catch       ║
║  ─────────────────────────────────────────       ║
║  Lasso        3        0.85      0.28 m/s        ║
║  Spinner      4        0.12      0.03 m/s  ★    ║
║  Weaver       2        0.05      0.025 m/s ★    ║
║  Trawl sweep  7        0.02      0.003 m/s ★★  ║
║                                                  ║
║  ★ = Most efficient                              ║
║  Houston: "Trawl is 90× more efficient than      ║
║   lasso. Worth the setup time."                  ║
╚══════════════════════════════════════════════════╝
```

After mission 2, Houston explicitly calls out the gap: *"You spent 0.85 m/s on 3 lasso catches. A Weaver at tether range would have been free."* This is the **teaching moment** that transitions the player from "lasso-every-target" to "set up the trawl."

#### 4.8.4 Files to touch

| Item | File | Estimated LOC |
|---|---|---|
| A. Field-Assay MFD | NEW `js/ui/FieldAssayMFD.js` (~400) + wire into [`HUD.js`](js/ui/HUD.js:1) | ~500 |
| B. Recoil compensation | [`AutopilotSystem.js`](js/systems/AutopilotSystem.js:1) + [`Constants.js`](js/core/Constants.js:907) | ~80 |
| C. Mission spawn profiles | [`DebrisField.js`](js/entities/DebrisField.js:1) + [`Constants.js`](js/core/Constants.js:1) MISSIONS block | ~150 |
| D. Dynamic events | [`ScoringSystem.js`](js/systems/ScoringSystem.js:1), [`CommsSystem.js`](js/systems/CommsSystem.js:1), new event wiring in [`GameFlowManager.js`](js/systems/GameFlowManager.js:1) | ~200 |
| E. Efficiency report | [`SweepReportUI.js`](js/ui/SweepReportUI.js:1) + capture-method tracking in [`ScoringSystem.js`](js/systems/ScoringSystem.js:1) | ~100 |

**Complexity: XL** (~4–7 dev days across 5 sub-features; A and C are the most expensive).

**Dependencies.** §4.6 arm bug + §4.4 lasso speed should land first (station-keeping compensation in B depends on correct tool-direction vectors). §4.9 onboarding should land in parallel since mission-1 difficulty is the foundation for §4.9's first-hour experience.

**Acceptance.**
- New player's first ORBITAL_VIEW shows a **Field Assay MFD** with at least 1 cluster ranked and 1 "Next Steps" primer.
- Player who fires the lasso in HOLD phase does NOT drift > 10 m from the hold point over 10 s.
- After mission 2, player has seen Houston say *"Trawl is more efficient"* at least once.
- Mission 3+ includes at least one mid-mission event that changes objectives.

---

### 4.9 Onboarding Flow — Tutorial + Skills + Discovery Pane Redesign (Strategic)

**Thesis.** The game has THREE overlapping onboarding systems that compete rather than cooperate: the legacy [`TutorialSystem`](js/systems/TutorialSystem.js:1), the current [`SkillsSystem`](js/systems/SkillsSystem.js:1) + [`SkillsPane`](js/ui/hud/SkillsPane.js:1), and the [`FIRST_EXPERIENCE.md`](FIRST_EXPERIENCE.md:1) "Welcome Field + contextual comms" layer. The Welcome Field + comms work. The Skills discovery engine works. But the **feedback chain** designed in [`FIRST_EXPERIENCE.md §3`](FIRST_EXPERIENCE.md:154) — *"the action's visual/audio payoff naturally suggests the next action"* — was never fully implemented, and the legacy TutorialSystem sits orphaned alongside it.

#### 4.9.1 Current state — audit

##### A. Three systems coexisting

| System | Status | Role |
|---|---|---|
| [`TutorialSystem`](js/systems/TutorialSystem.js:1) (752 LOC) | **Legacy ghost** | 10-stage linear tutorial. Active only if `USE_SKILLS_SYSTEM = false`. Bypassed by bridge hack at [`SkillsSystem.js:82`](js/systems/SkillsSystem.js:82) that force-emits `TUTORIAL_STAGE_CHANGED { stage: 9 }` on init. |
| [`SkillsSystem`](js/systems/SkillsSystem.js:1) (720 LOC) | **Active** | 33-skill free-order discovery, SM-2 reminders, prereq gates, safety gates. |
| [`SkillsPane`](js/ui/hud/SkillsPane.js:1) (1552 LOC) | **Active** | Compact "Discoveries" pane (bottom-left); expanded skill tree on `K`; progression-aware persistence ([`:56-60`](js/ui/hud/SkillsPane.js:56)). |
| [`FIRST_EXPERIENCE.md`](FIRST_EXPERIENCE.md:1) design | **Partially implemented** | Welcome Field ✓; contextual comms ✓; **checklist mode NOT implemented**; scan staggered-animation NOT implemented; sonar ping sound NOT implemented. |

**Consequence.** The bridge hack means [`ConjunctionSystem._tutorialStage`](js/systems/ConjunctionSystem.js:82) is always `9` (FREE_PLAY) — no gate. Any `tutorialStage < N` check elsewhere is also defeated. §4.2 conjunction-gating fix has to work around this.

##### B. Discovery Pane experience levels work but NOVICE doesn't "teach forward"

From [`SkillsPane.js:56-60`](js/ui/hud/SkillsPane.js:56):

```js
const EXPERIENCE_LEVELS = {
    NOVICE:     { threshold: 0,  idleOpacity: 0.85, autoHideMs: null },
    APPRENTICE: { threshold: 5,  idleOpacity: 0.45, autoHideMs: 15000 },
    VETERAN:    { threshold: 15, idleOpacity: 0.0,  autoHideMs: 4000 },
};
```

NOVICE keeps the pane always visible at 0.85 opacity — **but it only shows what the player already discovered**. A player at state "0 skills discovered" sees an empty-ish pane. The design doc [`FIRST_EXPERIENCE.md §4`](FIRST_EXPERIENCE.md:220-343) proposed a **Checklist Mode**:

```
┌──────────────────────────────────┐
│  ▸ NEXT STEPS                     │
│  ✓ Scan area                 [S]  │
│  → Select target            [Tab] │  ← current, pulsing
│  ○ Approach target            [A] │
└──────────────────────────────────┘
```

This was **specified but never coded**. The pane currently shows only DISCOVERED skills, never UPCOMING ones. [`SkillsSystem.getNextSuggestions(n)`](js/systems/SkillsSystem.js:146) exists to surface the next 3 suggestions — just not plumbed into NOVICE view.

##### C. HUD-group dim/undim has gaps

[`HUD.js:286`](js/ui/HUD.js:286) — `.hud-dormant { opacity: 0.5 }`. Groups undim when a skill with `hudGroup:` is discovered. But of 33 skills in [`Constants.js:999-1041`](js/core/Constants.js:999), only these have `hudGroup`:

| hudGroup | Skills activating it |
|---|---|
| `targets` | `scan_quick` |
| `target-info` | `nav_target` |
| `orbit-mfd` | `nav_autopilot` |
| `fleet` | `collect_deploy` |
| `power` | `manage_power` |
| `comms` | `manage_comms` |
| `propulsion` | `nav_throttle` |

**That's 7 skills with HUD payoff out of 33.** Discovering a skill with no `hudGroup` (e.g. `nav_zoom`, `nav_rotate`, `nav_camera`) produces only a pane pop-in — no persistent world change. Discovery feels inconsistent: zoom = quiet; scan = the world lights up.

##### D. No celebration of transitions

[`SkillsSystem._transitionState()`](js/systems/SkillsSystem.js:1) fires `SKILL_STATE_CHANGED` on DISCOVERED → PRACTICED → MASTERED. The current audio/visual feedback:

- DISCOVERED: pane pop-in, edge glow ([`SkillsPane._showEdgeGlow()`](js/ui/hud/SkillsPane.js:1174))
- PRACTICED: **silent state change** — symbol updates in pane, that's it.
- MASTERED: same — symbol `●` → `✓` in pane.

Given `MASTERY_MIN_TIME: 300` ([`Constants.js:951`](js/core/Constants.js:951)) = 5 real minutes, mastery is a real investment. It deserves audio + screen flash at minimum, especially for the **first 3 mastery transitions** (the "I'm levelling up!" moment that hooks players into deeper play).

##### E. HUD affordance — dormant panels give no hint how to activate

A dormant panel at 0.5 opacity is a visual clue that "something is there" but gives no instruction. New players stare at the dim Target Panel wondering what it is. The Discovery Pane says *"○ Quick Scan [S]"* but the player isn't looking at the pane yet — they're looking at the dim panels trying to figure out the game.

Proposed: when a panel is `.hud-dormant`, overlay a small `[S]` key-cap glyph in the corner that says *"press to activate"*. Fades when the associated skill is discovered.

##### F. Tutorial bypass defeats progression-aware systems

[`SkillsSystem:82, 215`](js/systems/SkillsSystem.js:82) emits `TUTORIAL_STAGE_CHANGED { stage: 9 }` on init and reset. This defeats:

- [`ConjunctionSystem._tutorialStage < 7`](js/systems/ConjunctionSystem.js:360) gate.
- Any [`InputManager._tutorialBlocksAutopilot`](js/systems/InputManager.js:1) stage check.
- [`KesslerSystem`](js/systems/KesslerSystem.js:1) / [`SpaceWeatherSystem`](js/systems/SpaceWeatherSystem.js:1) have no tutorial-stage gates but should.

The skills system needs its OWN gate semantics (`capturesSoFar`, `missionNumber`, `skillsDiscovered`) that other systems can read — not the legacy `stage` number.

#### 4.9.2 Proposed redesign — 5 concrete improvements

##### 1. Implement Discovery Pane Checklist Mode

Per [`FIRST_EXPERIENCE.md §4.3`](FIRST_EXPERIENCE.md:242). In NOVICE level (< 5 discoveries), the Discovery Pane renders [`SkillsSystem.getNextSuggestions(3)`](js/systems/SkillsSystem.js:146) as a checklist:

```
▸ NEXT STEPS
  ✓ Scan area                 [S]     ← discovered
  → Select target            [Tab]    ← current, pulsing
  ○ Approach target            [A]    ← upcoming
  ─────────────────────────
  2/34 skills discovered
```

- Top discovered item shown as `✓` for 3 s then dims.
- Current item = first undiscovered suggestion, pulsing in tier color.
- Upcoming items = dim gray.
- Refresh `getNextSuggestions(3)` whenever the list completes.
- Transition to APPRENTICE pop-in mode on FIRST_CAPTURE.

**Files.** Pure [`SkillsPane.js`](js/ui/hud/SkillsPane.js:1) additions — add `_checklistMode` boolean, `_renderChecklist()` method. ~80 LOC.

##### ~~2. Delete TutorialSystem + replace stage gate with skills-state gate~~ — ✅ RESOLVED (Sprint 3 ST-3.2)

~~Kill the legacy system:~~
- ~~Delete [`js/systems/TutorialSystem.js`](js/systems/TutorialSystem.js:1) (752 LOC gone).~~
- ~~Remove the bridge hack at [`SkillsSystem.js:82, 215`](js/systems/SkillsSystem.js:82).~~
- ~~Replace `tutorialStage < N` checks with semantic equivalents.~~

**Done.** TutorialSystem deleted, bridge hack removed, conjunction gates migrated to skills-based. See §8 tech debt for confirmation.

##### 3. HUD dormant affordance — key-cap hint glyph

When a panel has `.hud-dormant`, overlay a corner glyph. Implementation: CSS `::after` pseudo-element on `.hud-dormant[data-activate-key]` that renders the key-cap and fades out on `.hud-active`. Each HUD panel gets a `data-activate-key="S"` attribute pointing to the key that discovers the associated skill.

**Files.** [`HUD.js`](js/ui/HUD.js:1) + [`TargetPanel.js`](js/ui/hud/TargetPanel.js:1) + [`StatusPanel.js`](js/ui/hud/StatusPanel.js:1) for attributes. CSS in the existing style-injection block. ~40 LOC total.

##### 4. Celebrate mastery transitions (PRACTICED + MASTERED)

Add audio + visual on `SKILL_STATE_CHANGED`:
- PRACTICED: soft chime (reuse [`AudioSystem.playClick()`](js/systems/AudioSystem.js:1) with higher pitch) + brief tier-color flash on the pane entry.
- MASTERED: fanfare (3-note arpeggio — new generator in [`AudioSystem`](js/systems/AudioSystem.js:1)) + screen-edge pulse (reuse `_showEdgeGlow` in tier color) + **for the first 3 masteries only**, a centered *"Mastery Unlocked — {label}"* toast that fades after 2 s.

**Files.** [`SkillsPane.js`](js/ui/hud/SkillsPane.js:1) listener + [`AudioSystem.js`](js/systems/AudioSystem.js:1) new generator. ~60 LOC.

##### 5. Skill-based gates for advanced systems

Move mission-progression locks from `tutorialStage` to skills-state:

| System | Old gate | New gate |
|---|---|---|
| [`ConjunctionSystem`](js/systems/ConjunctionSystem.js:1) first alert | `stage >= 7` | `skillsSystem._totalCatches >= 1 && missionElapsed >= 120s` |
| [`KesslerSystem`](js/systems/KesslerSystem.js:1) first cascade | not gated | `missionNumber >= 4` |
| [`SpaceWeatherSystem`](js/systems/SpaceWeatherSystem.js:1) first event | not gated | `skillsSystem.isDiscovered('manage_power')` |
| [`ResourceSystem`](js/systems/ResourceSystem.js:1) fuel-mode cycling (`T`) | not gated | `skillsSystem.isDiscovered('manage_power')` |

**New public API on [`SkillsSystem`](js/systems/SkillsSystem.js:1):** `getProgress()` (exists), `getTotalCatches()`, `getSessionElapsed()` — so other systems can read without tight coupling.

#### 4.9.3 Onboarding sequence — the aspirational 90 seconds

Synthesising [`FIRST_EXPERIENCE.md`](FIRST_EXPERIENCE.md:1) + the proposals above, a clean first-session flow is:

```
0s    — ORBITAL_VIEW starts. 
         HUD at 0.5 opacity, Target Panel has [S] corner glyph.
         Checklist pane: ▸ NEXT STEPS
                         → Scan area [S] (current, pulsing)
                         ○ Select target [Tab]
                         ○ Approach target [A]
         
3s    — Comms: "Multiple contacts nearby. Press S to scan."
         (from existing contextual comms in GameFlowManager)

5s    — Welcome field spawned; auto-target selects nearest debris 
         (existing S25 behavior; _firstTimeComms).

7s    — Player presses S. 
         PING sound (new §4.9 follow-up: replace sine-sweep w/ sonar ping).
         Target Panel corner-glyph fades; panel opacity 1.0. 
         Targets stream in with 200ms stagger (§4.9 follow-up).
         Credit flash +$50. Checklist: ✓ Scan area [S].

10s   — Player presses Tab.
         Wireframe panel undims. TargetReticle brackets (§4.3 prominent). 
         Comms: "Fragment 200m. Press A to approach."
         Checklist: ✓ Select target [Tab].

12s   — Player presses A.
         AP engages (new trailing-rendezvous controller).
         HUD shows phase FAR → MATCH → ALIGN → HOLD.
         Distance milestones in comms ("Range: 500m...200m").

22s   — AP in HOLD. 
         Ship station-keeps at P_d − v̂_d · 120m behind debris.
         Lasso reticle shows target in forward cone (ANG_TOL ≤ 3°).
         Comms: "On station. Press Space to lasso."

25s   — Player presses Space.
         Lasso fires at 40m/s (§4.4 fix) — 3s flight.
         Bolas head visible (§4.7 fix). Tether has apparent thickness.

28s   — CATCH! Slow-mo, point popup, +500 pts.
         Recoil compensated by §4.8 station-keeping.
         Comms: "Got it! Press Tab for next target."
         Checklist: ✓ Lasso debris [Space] → TRANSITION TO APPRENTICE MODE.
         First MASTERED celebration (§4.9.2 #4): "Mastery Unlocked — Quick Scan".

35s   — Player presses Tab. Medium debris at 800m.
         New checklist: → Approach target [A] ○ Next target [Tab] 
                       ○ Analyze target [Z]

45s   — Field Assay MFD (§4.8.A) visible on left column. 
         Shows 4 clusters ranked by score. 
         Player sees "ISS Band 400-600 ★★★★ ΔV-in 0.8 m/s".

60-90s — First loop complete. Player has: 
          - captured 1-2 debris
          - discovered 4-6 skills
          - seen Field Assay, understands clusters exist
          - seen the first mastery celebration
          - NOT been startled by a conjunction alert (§4.2 gate).
```

#### 4.9.4 Files to touch

| Item | File | Estimated LOC |
|---|---|---|
| 1. Checklist mode | [`SkillsPane.js`](js/ui/hud/SkillsPane.js:1) | ~80 |
| 2. Delete TutorialSystem | [`TutorialSystem.js`](js/systems/TutorialSystem.js:1) **removed** + 4 other files de-referenced | −752 / +30 |
| 3. Dormant corner glyph | [`HUD.js`](js/ui/HUD.js:1) + per-panel attributes | ~40 |
| 4. Mastery celebration | [`SkillsPane.js`](js/ui/hud/SkillsPane.js:1) + [`AudioSystem.js`](js/systems/AudioSystem.js:1) | ~60 |
| 5. Skills-based gates | [`SkillsSystem.js`](js/systems/SkillsSystem.js:1) public API + 4 consumers | ~80 |

**Complexity: L** (~2–4 dev days total across 5 sub-features).

**Dependencies.** §4.2 (conjunction gating) needs item 5 (skills gates) to be clean. §4.9 can otherwise land independently but is MOST valuable landed alongside §4.1 + §4.3 (visual overhaul) so the player's first session is also visually polished.

**Acceptance.**
- A new player reaches first capture within 45–90 s (matches [`FIRST_EXPERIENCE.md`](FIRST_EXPERIENCE.md:1) goal).
- At no point does the Discovery Pane show 0 items — NOVICE mode always displays 3 next-step suggestions.
- After 3 masteries, the player has heard 3 distinct fanfares.
- `grep -r 'TUTORIAL_STAGE_CHANGED' js/` returns zero hits outside event-name constants.

---

## 5. Recommended Priority Order

Weighting: (a) impact on new-player first session, (b) bug vs enhancement, (c) complexity, (d) dependency chain. The 9 items split into **3 tiers** by effort and risk.

### Tier A — Quick Wins (ship in 1 day)

Pure bugs or small tuning with isolated fixes. No design risk.

| Rank | Item | Effort | Status |
|---|---|---|---|
| ~~**1**~~ | ~~[§4.6 Arm 180° bug](#46-arm--tool-deployment-direction-180-bug)~~ | ~~**S**~~ | ✅ **RESOLVED** — Epic 10 V-4 |
| **2** | [§4.4 Lasso travel speed](#44-lasso-travel-speed) | **S** (1–2 h) | Pending |
| **3** | [§4.5 Lasso reusability — Option A](#45-lasso-reusability-model) | **S** (2 h) | Pending |

### Tier B — First-Experience UX (ship in 2–3 days)

High-impact for new players. CSS + light code changes. Ships independently, but lands best as a bundle.

| Rank | Item | Effort | Status |
|---|---|---|---|
| **4** | [§4.2 Conjunction alert gating](#42-conjunction-alerts--timing--clarity) | **S–M** (3–5 h) | Pending |
| **5** | [§4.3 Target panel readability](#43-target-analysis-panel-readability) | **S** (2–4 h) | Pending |
| **6** | [§4.1 Debris 3-D visuals](#41-debris-visual-representation) | **M** (6–10 h) | Pending |
| **7** | [§4.7 Lasso visuals](#47-lasso-visual-representation) | **M** (4–6 h) | Pending |

### Tier C — Strategic Multi-Sprint Features (schedule as epics)

These are **not 1-day tickets.** They re-shape the game loop and should be planned as multi-session epics with design review.

| Rank | Item | Effort | Status |
|---|---|---|---|
| **8** | [§4.9 Onboarding flow redesign](#49-onboarding-flow--tutorial--skills--discovery-pane-redesign-strategic) | **L** (2–4 days) | Partially done — TutorialSystem deleted (§4.9.2 #2 ✅), remaining items pending |
| **9** | [§4.8 Mission Operations Model](#48-mission-operations-model--nasajpl-style-debris-field-navigation-strategic) | **XL** (4–7 days) | Pending — each sub-feature (A–E) shippable independently |

### Suggested sprint plan (updated May 2026)

| Sprint | Days | Tier | Items | Outcome |
|---|---|---|---|---|
| **1** | 0.5 | A | §4.4 + §4.5 | Lasso tuning. ~~§4.6 already resolved.~~ |
| **2** | 2–3 | B | §4.2 + §4.3 + §4.1 + §4.7 | First-experience UX + visual pass. Game *looks* better. |
| **3** | 2–3 | C | §4.9 (items #1, #3, #4, #5 — #2 done) | Onboarding coherence. Checklist mode. Mastery celebration. Skills gates. |
| **4** | 4–7 | C | §4.8 (split into A→E order) | Mission operations layer. Game *plays* as an ADR sim. |

**Total: ~8–13.5 dev days** across 4 sprints (reduced from 9–15 with §4.6 + §4.9#2 resolved).

### Key dependencies visualization

```
§4.6 (arm bug) ──── ✅ RESOLVED (Epic 10 V-4)
§4.4 (lasso)  ──┬─→ §4.1 + §4.7 ─→ §4.8.B (recoil)
§4.5 ─ − ─ − ─ ─┘                         │
                                          │
§4.2 (conjunction) ─→ §4.9 #5 (skills gates)
                          │
§4.3 (target panel) ──────┼───→ §4.8.A (Field Assay MFD)
                          │
§4.9 #1 (checklist) ──────┼───→ §4.8.C (mission profiles)
§4.9 #2 (delete tutorial) ── ✅ RESOLVED
§4.9 #4 (mastery fanfare) ┘
```

---

## 6. Testing Strategy Notes

### 6.1 Harness

[`js/test/TestRunner.js`](js/test/TestRunner.js:1) — minimal `describe / it / assert`, no deps, runs under Node ≥ 18. No DOM, no `window`. **Does** instantiate real `three` objects (Vector3, Quaternion) for physics tests. Tests in `js/test/test-*.js`; `run-tests.js` imports all.

### 6.2 Per-item test coverage

| Item | Tests needed | What to test |
|---|---|---|
| §4.1 Debris visuals | ❌ Visual only | Screenshot diff manually. |
| §4.2 Conjunction gating | ✅ New `test-Conjunction.js` | (a) No `CONJUNCTION_WARNING` with `captures = 0`. (b) After first capture, alert still delayed until elapsed ≥ 120 s. (c) First-ever alert forced GREEN. Use EventBus spy + fake clock. |
| §4.3 Target panel | ❌ CSS-only | Manual. |
| §4.4 Lasso speed | ✅ New `test-LassoSystem.js` | (a) `LASSO_SPEED = 40` constant. (b) `projectilePos` advances `speed * dt * TIME_SCALE_GAMEPLAY`. (c) Contact fires within ≤ `maxFlightTime` at 120 m. |
| §4.5 Lasso reusability | ✅ Extend `test-LassoSystem.js` | (a) Cooldown decrements in `update`. (b) `fire()` during cooldown emits `LASSO_DENIED`. (c) Constants hoisted. |
| §4.6 Arm direction | ✅ Extend [`test-Crossbow-ArmUnit.js`](js/test/test-Crossbow-ArmUnit.js:1) | (a) Identity parentQuat → launchDirection = local dockOffset. (b) 90° Y-rotation parentQuat → launchDirection rotated 90°. (c) 180° Y-rotation → back-arm launchDirection is WORLD +Z (opposite of local −Z). **This last test would have caught the bug.** |
| §4.7 Lasso visuals | ❌ Visual only | Manual. |
| §4.8 Mission operations | ✅ **Multiple new files** — see §6.3 | See below. |
| §4.9 Onboarding | ✅ **Extend `test-SkillsSystem.js`** | See below. |

### 6.3 §4.8 test plan

| Sub-feature | Test file | Assertions |
|---|---|---|
| A. Field Assay MFD | `test-FieldAssayMFD.js` (new, logic-only not DOM) | (a) Score formula monotonic in `count`. (b) Unreachable clusters (ΔV > remaining) filtered. (c) Output sorted descending by score. |
| B. Recoil compensation | Extend `test-AutopilotSystem.js` | (a) `LASSO_FIRED` in HOLD → opposite `applyCartesianImpulse` called with magnitude `projMass × projVel / playerMass`. (b) `STATION_KEEP_COMPENSATION = false` disables it. |
| C. Mission spawn profiles | Extend `test-DebrisField.js` (new) | (a) Mission 1 spawns exactly Welcome Field + 0 extra hazards. (b) Mission 4+ spawns ≥ 1 Kessler seed. (c) Hydrazine debris never appears in mission 1. |
| D. Dynamic events | Integration test — new `test-MissionEvents.js` | (a) `SCAN_DISCOVERY` on hydrazine debris → `DEBRIS_HAZARD_REVEALED` fires. (b) Synergy-adjacent debris scan → 5-min bonus timer started in ScoringSystem. |
| E. Efficiency report | Extend `test-ScoringSystem.js` | (a) ΔV/catch tracked per method (lasso / spinner / weaver / trawl). (b) "Most efficient" star awarded to lowest ΔV/catch method in the pass. |

### 6.4 §4.9 test plan

| Sub-feature | Test file | Assertions |
|---|---|---|
| 1. Checklist mode | Extend [`test-SkillsSystem.js`](js/test/test-SkillsSystem.js:1) | (a) `getNextSuggestions(3)` returns 3 undiscovered skills with `prereqsMet`. (b) After 5 discoveries, level == APPRENTICE. |
| 2. Delete TutorialSystem | New `test-no-tutorial-legacy.js` | (a) `grep` for `TutorialSystem` import in `js/**` returns 0. (b) No `TUTORIAL_STAGE_CHANGED` emitters outside `Events.js`. |
| 3. Dormant affordance | ❌ CSS-only | Manual. |
| 4. Mastery celebration | Extend `test-SkillsSystem.js` | (a) `SKILL_STATE_CHANGED { to: 'MASTERED' }` fires `MASTERY_FANFARE` event. (b) First 3 masteries set `largeToast: true` in payload. |
| 5. Skills-based gates | Integration test | (a) `ConjunctionSystem` silent when `totalCatches = 0`. (b) `KesslerSystem` silent when `missionNumber < 4`. |

### 6.5 The hard-won lesson — test the real physics path

The autopilot work surfaced a **critical gap**: the pre-existing test suite had zero coverage of the full `(r,v) → elements → (r,v)` round-trip through [`cartesianToKeplerian`](js/entities/OrbitalMechanics.js:129). That function was wrong for years; nothing triggered it until [`applyCartesianImpulse`](js/entities/PlayerSatellite.js:2145) was added.

1. For every new physics helper: **inverse-consistency test** — [`test-OrbitalMechanics.js:164`](js/test/test-OrbitalMechanics.js:164).
2. Prefer integration tests over unit stubs. One end-to-end call (create player → engage AP → propagate 10 ticks → assert range decreased) is worth ten `mock.calls[0]` assertions.
3. Factor-of-10 wrong → suspect `TIME_SCALE_GAMEPLAY` (§3.2).
4. 90°/180° wrong → suspect local-to-world transform missing (§3.1, §4.6).
5. Add a regression test for every bug found.

### 6.6 Running the suite

```bash
./test.sh                               # full suite (expected: 460 suites / 2,060 tests / 0 failures)
node js/test/run-tests.js               # direct invocation
node js/test/run-tests.js --filter AP   # pattern filter
open http://localhost:8081/test.html    # browser-side diagnostics (separate runner)
```

---

## 7. Active Docs Index

> **Categories:**
> - **🟢 Canonical** — current source of truth; read first
> - **🟡 Active reference** — design specs / system bibles, still consulted when touching their area
> - **🟠 Heritage** — completed epic; useful historical reference but no forward work
> - **🪦 Stub** — content folded elsewhere or executed; file is a one-paragraph redirect to canonical replacement

### 🟢 Canonical (read first)

| Doc | Purpose | Read When |
|---|---|---|
| [`README.md`](README.md:1) | Entry point, quick start, controls | First contact |
| [`HANDOFF.md`](HANDOFF.md:1) | **This file** — current shift brief, gotchas, tech debt, next priorities | Every session |
| [`SK_M1_POLISH_HANDOFF.md`](SK_M1_POLISH_HANDOFF.md:1) | Most recent polish cycle: changes, root causes, L1–L7 lessons, conventions, path forward | Touching SK / M1 / autopilot / debris |
| [`ARCHITECTURE.md`](ARCHITECTURE.md:1) | As-built technical reference (file structure, rendering, state machine, key APIs) | Anywhere new — orient first. ⚠️ Needs Epic 9/10 update. |
| [`BIG_PICTURE.md`](BIG_PICTURE.md:1) | 12-month strategic roadmap — missions, tech ladder, dependency graph | Planning long-term work |
| [`GAME_DESIGN.md`](GAME_DESIGN.md:1) | Design vision — core loop, jellyfish identity, ΔV economy | First contact (after README) |
| [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md:1) | Sprint tracker — Sprints 1–4, Epics 5–10 completion log | Picking next work. ⚠️ Needs Epic 9/10 backfill. |

### 🟡 Active references (read when touching their area)

| Doc | Purpose | Read Before Touching |
|---|---|---|
| [`ARM_PIVOT_ANALYSIS.md`](ARM_PIVOT_ANALYSIS.md:1) | Config G geometry bible — locked dimensions (§10.11), stowage (§10.14), ROSA (§10.15–17) | [`PlayerSatellite.js`](js/entities/PlayerSatellite.js), [`ArmUnit.js`](js/entities/ArmUnit.js) |
| [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md:1) | V5 crossbow arm physics & design bible | [`ArmUnit.js`](js/entities/ArmUnit.js), [`ArmManager.js`](js/entities/ArmManager.js) |
| [`CAPTURE_NET.md`](CAPTURE_NET.md:1) | Capture Net design Rev 4: cling, tangle, fragmentation, M/LD/SD-NET classes | [`CaptureNet.js`](js/entities/CaptureNet.js), [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js) |
| [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md:1) | Orbital-crane control redesign + dual-metal FEEP | [`InputManager.js`](js/systems/InputManager.js) SK/arm-pilot logic |
| [`GAME_FLOW_BRAINSTORM.md`](GAME_FLOW_BRAINSTORM.md:1) | Tool failure modes, FEEP metals, ISRO comms, delight catalog | Adding new game-feel content |
| [`FIRST_EXPERIENCE.md`](FIRST_EXPERIENCE.md:1) | Welcome Field + first-90-second UX + Checklist Mode design | First-experience flow changes |
| [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md:1) | 17 aerospace concepts taught via play | Adding teaching moments / codex entries |
| [`SKILLS_ARCHITECTURE.md`](SKILLS_ARCHITECTURE.md:1) | Skills Discovery system internals | [`SkillsSystem.js`](js/systems/SkillsSystem.js), [`SkillsPane.js`](js/ui/hud/SkillsPane.js) |
| [`FINAL_ANALYSIS.md`](FINAL_ANALYSIS.md:1) | **Heritage doc-state map** (stale §1–§3, §6); **§5.4 Offline-First Manifesto and §5A Indian Heritage are still canonical** (referenced from Locked Principles above) | Locked-principles refresher |

### 🟠 Heritage (completed; archive next git session)

These are 100% complete and have no forward-looking content. They retain real reference value (visual specs, implementation notes, deep analysis) — but they bloat the root listing. **Recommended:** `git mv` to `archive/` (commands in [§9.1](#91-doc-cleanup-2026-05-16)).

| Doc | Status |
|---|---|
| [`EPIC10_DEEP_ANALYSIS.md`](EPIC10_DEEP_ANALYSIS.md:1) | Epic 10 complete 2026-05-08 — 9 concerns + visual design spec (§13 hinge spec still useful as reference) |
| [`EPIC10_IMPLEMENTATION.md`](EPIC10_IMPLEMENTATION.md:1) | Epic 10 implementation log — V-1..V-11 |
| [`EPIC10_VISUALIZATION_PLAN.md`](EPIC10_VISUALIZATION_PLAN.md:1) | Epic 10 task breakdown + acceptance criteria |

### 🪦 Stubs (content folded; file is a redirect)

These were stub-replaced on 2026-05-16. The original content is preserved in git history (`git show HEAD~1:./[FILE]`); the current files are 1-paragraph redirects to where the content now lives.

| Doc | Folded into | Stubbed |
|---|---|---|
| [`ARCHIVAL_PLAN.md`](ARCHIVAL_PLAN.md:1) | HANDOFF §7 (this section) + §9.1 cleanup record | 2026-05-16 |
| [`ARM_PIVOT_GAPS_EXPLAINER.md`](ARM_PIVOT_GAPS_EXPLAINER.md:1) | Epic 9 code + [`ARM_PIVOT_ANALYSIS.md`](ARM_PIVOT_ANALYSIS.md:1) §10–11 | 2026-05-16 |
| [`CAPTURE_NET_QA.md`](CAPTURE_NET_QA.md:1) | [`CAPTURE_NET.md`](CAPTURE_NET.md:1) Rev 4 + [`CaptureNet.js`](js/entities/CaptureNet.js) | 2026-05-16 |
| [`EPIC9_CODE_ORCHESTRATOR.md`](EPIC9_CODE_ORCHESTRATOR.md:1) | Epic 9 deliverables (code) + HANDOFF "Epic 9 — COMPLETE" header | 2026-05-16 |
| [`UX_FIXES_ROADMAP.md`](UX_FIXES_ROADMAP.md:1) | [`archive/UX_FIXES_ROADMAP.md`](archive/UX_FIXES_ROADMAP.md) | 2026-04-25 |

### Previously archived

`AUTOPILOT_ANALYSIS.md`, `TUTORIAL_ANALYSIS.md`, `SKILLS_SYSTEM_DESIGN.md`, `UX_OVERHAUL_PLAN.md` (post-Epic 6). `UX_FIXES_ROADMAP.md`, `BIG_PICTURE_EPIC_5_6_HISTORY.md`, `HANDOFF_AUTOPILOT_RETRO.md` (Apr 25 consolidation). 21 docs total in `archive/`.

---

## 8. Known Issues / Tech Debt

- Welcome Field debris may overlap if player orbit changes between resets.
- Drift-recovery message uses `setTimeout` (not frame-tied).
- No ETA/distance count-down in the AP chip — only phase shown.
- Discovery Pane (`bottom:180px; left:10px`) may collide with left-column panels on small viewports.
- `GAMEOVER_CONTINUE` uses direct `.reset()` calls on 3 systems (intentional).
- 6 remaining `_refs` in [`GameFlowManager.js`](js/systems/GameFlowManager.js:1): player, debrisField, armManager, cameraSystem, shopScreen, resourceSystem.
- [`StatusPanel.js:1506`](js/ui/hud/StatusPanel.js:1506) has a `TODO` placeholder for codex badge.
- CA Phase 3 not yet implemented (shop upgrades, chevron indicator, audio cues).
- V4 GSL upgrade path has stubs in [`ArmManager.js`](js/entities/ArmManager.js:1) but no implementation.
- **From AP work:** `ArmUnit` velocity integrated in real `dt` while ship orbit advances by `gameDt` — audit if arms visibly lag at high time-scale (§3.2).
- ~~**From onboarding audit:** `TutorialSystem.js` was a 752-LOC legacy ghost~~ — **RESOLVED** (Sprint 3 ST-3.2: deleted, bridge hack removed, conjunction gates migrated to skills-based).
- ~~**Camera near-clip during ceremony**~~ — **RESOLVED** (2026-05-07 debug session: near-plane pushed to 0.1m during Phase 2-3, see §2.1).
- ~~**Reticle/camera issues on 2nd G-press**~~ — **RESOLVED** (2026-05-07 debug session: exits ARM_PILOT before deploying, see §2.1).
- ~~**Mother AP ARRIVED disengage with locked target**~~ — **RESOLVED** (2026-05-16: [`hasLockedTarget`](js/systems/AutopilotSystem.js:678) HOLD-timer suppression; see [`SK_M1_POLISH_HANDOFF.md §2.1`](SK_M1_POLISH_HANDOFF.md)).
- ~~**M1 debris at 7 km in TRACKED panel**~~ — **RESOLVED** (2026-05-16: 3-layer fix — per-frame cull, backgroundPoints hide, `welcomeSpawn` query filter; see [`SK_M1_POLISH_HANDOFF.md §2.2`](SK_M1_POLISH_HANDOFF.md)).
- ~~**M1 TRACKED TARGETS empty on new-game (regression)**~~ — **RESOLVED** (2026-05-17). Root cause was an **off-by-one-frame propagation drift**: [`_spawnWelcomeField()`](js/entities/DebrisField.js:1406) runs *after* [`player.update()`](js/entities/PlayerSatellite.js:1) has already advanced `playerOrbit.trueAnomaly` by `n*gameDt` this frame, and *before* the debris propagation loop at [`DebrisField.js:1083`](js/entities/DebrisField.js:1083) advances debris by another `n*gameDt`. Welcome debris ended up `n*gameDt` rad ≈ **7+ km** ahead of the player permanently, beyond the M1 2 km HUD filter. Fix: pre-compensate by stashing `gameDt` ([`DebrisField.js:931`](js/entities/DebrisField.js:931)) and subtracting `n*gameDt` from the welcome `trueAnomaly` assignment ([`DebrisField.js:1466`](js/entities/DebrisField.js:1466)). Also pre-set `discovered=true` on **only the nearest** welcome debris (closest tier, `i===0`) — the other 6 stay undiscovered until the user presses **S** to scan, which reveals them via [`SensorSystem._revealNearbyDebris()`](js/systems/SensorSystem.js:509) (matches the intended new-user UX: one obvious target up front, learn-by-doing for scan). Removed the buggy [`_autoDiscoverNearest()`](js/entities/DebrisField.js:365) call that previously SMA-picked an arbitrary debris (sometimes a catalog one that the M1 enforcement immediately killed → 0 visible). **Gotcha for future:** anywhere you place new entities relative to `playerOrbit.trueAnomaly` and they're then auto-propagated the same frame, subtract `n*gameDt` first — or place them *after* the propagation pass. Same applies if you ever spawn debris using `player.getPosition()` instead of `orbitToSceneCartesian(playerOrbit).position`: the former includes accumulated `_rcsVelocity*dt` offset that bypasses orbital math ([`PlayerSatellite.js:1572`](js/entities/PlayerSatellite.js:1572)).
- ~~**SkillsPane visible during MENU/BRIEFING**~~ — **RESOLVED** (2026-05-16: `_masterVisible` default false + `GAME_STATE_CHANGE` gating).
- ~~**Green "Ready" ring during SK**~~ — **RESOLVED** (2026-05-16: Ready branch deleted from [`_drawLassoCooldownArc()`](js/ui/TargetReticle.js:1651)).
- **NEW (2026-05-16): M1 visibility predicate is tripled** — [`DebrisField.js`](js/entities/DebrisField.js) checks `isMission1 && !welcomeSpawn` in 3 separate places (`update()`, [`getDebrisNear()`](js/entities/DebrisField.js:1560), [`getEnhancedTargetList()`](js/entities/DebrisField.js:1762)). Should be centralised into `_isVisibleForCurrentMission(debris)`.
- **NEW (2026-05-16): [`DebrisField.js`](js/entities/DebrisField.js) is 2093 LOC / 50+ methods** — split candidates: background, welcome-cluster, queries, update. See [`SK_M1_POLISH_HANDOFF.md §5.2.B`](SK_M1_POLISH_HANDOFF.md).
- **NEW (2026-05-16): [`SkillsPane.js`](js/ui/hud/SkillsPane.js) is 1869 LOC** — functional but large; refactor candidate (not urgent).
- **From mission-ops audit:** [`DebrisField.getDebrisClusters()`](js/entities/DebrisField.js:1485) computes rich cluster metadata that only [`TrawlManager`](js/systems/TrawlManager.js:14) consumes — no player-facing surface (§4.8.A).
- `scoring.missionNumber` computed on the fly from `debrisCleared / 5` ([`ScoringSystem.js:327`](js/systems/ScoringSystem.js:327)) — no explicit mission lifecycle events; §4.8.C spawn profiles will need a `MISSION_START` event.
- **ST-5.2 Trail System disabled** ([`Constants.TRAILS.ENABLED: false`](js/core/Constants.js:1291)). All wiring + 54 tests in place but visual rendering failed — `THREE.Line` is 1px on WebGL (macOS/Chrome limitation), invisible at orbital scale. Needs `THREE.Line2` (fat lines from addons), `THREE.Points`, or Canvas2D overlay. See [`archive/HANDOFF_AUTOPILOT_RETRO.md §2.2`](archive/HANDOFF_AUTOPILOT_RETRO.md) for full failure analysis. Files: [`TrailSystem.js`](js/ui/TrailSystem.js:1), [`PlayerSatellite.js:1098`](js/entities/PlayerSatellite.js:1098), [`ArmUnit.js:1038`](js/entities/ArmUnit.js:1038), [`main.js:251`](js/main.js:251).

---

## 9. SK / Mission-1 Polish Cycle (2026-05-16)

**Full write-up:** [`SK_M1_POLISH_HANDOFF.md`](SK_M1_POLISH_HANDOFF.md)

Seven polish tasks + two mid-flight additions + two diagnostic bug fixes. Test suite: **460 suites / 2060 tests / 0 failures**. Key changes: SK standoff zoom 4–12 m with mouse-wheel, sonar-ping restoration, mother AP `hasLockedTarget` HOLD suppression, M1 2 km debris cull (3-layer defence), SkillsPane visibility gating, "Press any key" + ADR credits on opening screen. See the linked doc for full file-by-file breakdown, root-cause narratives, 7 lessons learned (L1–L7), and path-forward recommendations.

---

### 9.1 Doc Cleanup (2026-05-16)

Root-level doc count reduced from 28 → 24 active (after stubs) → 21 (after recommended `git mv`). Strategy described in [§7 Active Docs Index](#7-active-docs-index) categories (🟢 Canonical / 🟡 Active reference / 🟠 Heritage / 🪦 Stub).

#### What was done in this pass

| Action | Files | Why |
|--------|-------|-----|
| **Stub-replaced** (content preserved in git history) | [`ARCHIVAL_PLAN.md`](ARCHIVAL_PLAN.md:1), [`ARM_PIVOT_GAPS_EXPLAINER.md`](ARM_PIVOT_GAPS_EXPLAINER.md:1), [`CAPTURE_NET_QA.md`](CAPTURE_NET_QA.md:1), [`EPIC9_CODE_ORCHESTRATOR.md`](EPIC9_CODE_ORCHESTRATOR.md:1) | Content already folded into canonical docs (CAPTURE_NET.md Rev 4, ARM_PIVOT_ANALYSIS.md, HANDOFF.md, IMPLEMENTATION_PLAN.md) or executed (Epic 9 complete, archival plan run). Stubs are 1-paragraph redirects. |
| **§7 Active Docs Index rewritten** | [`HANDOFF.md`](HANDOFF.md:1) | New 4-category structure: 🟢 Canonical / 🟡 Active reference / 🟠 Heritage / 🪦 Stub. Adds "Read When" / "Read Before Touching" columns so a cold-start contributor knows when to crack each doc. |
| **Kept (referenced as canonical)** | [`FINAL_ANALYSIS.md`](FINAL_ANALYSIS.md:1) | Most of it is stale (§1–§3 doc map, §6 Epic 8 brief) BUT §5.4 Offline-First Manifesto and §5A Indian Heritage are linked from the [Locked Product Principles](#-locked-product-principles-2026-04-25) section as authoritative. Stubbing would break those links. |

#### Recommended `git mv` commands (run when ready)

The three Epic 10 docs contain valuable detailed reference (visual design specs, implementation notes, acceptance criteria) but Epic 10 is complete and they bloat the root. Move them to `archive/` in one commit:

```bash
git mv EPIC10_DEEP_ANALYSIS.md      archive/EPIC10_DEEP_ANALYSIS.md
git mv EPIC10_IMPLEMENTATION.md     archive/EPIC10_IMPLEMENTATION.md
git mv EPIC10_VISUALIZATION_PLAN.md archive/EPIC10_VISUALIZATION_PLAN.md

# Optional follow-up: also move the stub files (history is in git anyway)
git mv ARCHIVAL_PLAN.md             archive/ARCHIVAL_PLAN.md
git mv ARM_PIVOT_GAPS_EXPLAINER.md  archive/ARM_PIVOT_GAPS_EXPLAINER.md
git mv CAPTURE_NET_QA.md            archive/CAPTURE_NET_QA.md
git mv EPIC9_CODE_ORCHESTRATOR.md   archive/EPIC9_CODE_ORCHESTRATOR.md
git mv UX_FIXES_ROADMAP.md          archive/UX_FIXES_ROADMAP.md  # already a stub since 2026-04-25

git commit -m "docs: archive completed Epic 9/10 trackers and stubbed-out heritage docs"
```

After the moves above, the root has **15 .md files** (7 🟢 canonical + 8 🟡 active reference), down from 28. The HANDOFF.md §7 Stub and Heritage subsections then become obsolete and can be deleted next cleanup pass.

#### Cleanup outcome (target end state)

| Tier | Count | Files |
|------|-------|-------|
| 🟢 Canonical | 7 | README, HANDOFF, SK_M1_POLISH_HANDOFF, ARCHITECTURE, BIG_PICTURE, GAME_DESIGN, IMPLEMENTATION_PLAN |
| 🟡 Active reference | 8 | ARM_PIVOT_ANALYSIS, CROSSBOW_ARMS, CAPTURE_NET, DAUGHTER_ARM_CONTROLS, GAME_FLOW_BRAINSTORM, FIRST_EXPERIENCE, LEARNING_THROUGH_PLAY, SKILLS_ARCHITECTURE |
| ⚠ Partially canonical | 1 | FINAL_ANALYSIS (kept for §5.4 + §5A; rest is heritage) |
| **Root total** | **16** | (down from 28) |

#### Future work — full consolidation candidates

These weren't touched this pass but could collapse further next cleanup:

- **FINAL_ANALYSIS.md** — extract §5.4 (Offline-First Manifesto) into the body of HANDOFF.md's Locked Principles section (currently a 1-line reference), then archive the rest. §5A (Indian Heritage) could similarly inline-merge.
- **IMPLEMENTATION_PLAN.md** — backfill Epic 9/10 completion entries so it's accurate, OR retire it in favour of HANDOFF.md sprint tracking (the two overlap heavily).
- **ARCHITECTURE.md** — needs an Epic 9/10 update pass. Until then it's 80% accurate but the V3 Octopus → Config G transition isn't reflected in §6 / §7.
- **BIG_PICTURE.md** is 1,854 LOC and ⚠ marked bloated in old FINAL_ANALYSIS.md inventory. Could split into a per-quarter doc set if it becomes a blocker for new contributors.

---

## 10. Daughter SK + Salvage-Loop Wiring Pass (2026-05-17)

> **Full open-work audit:** [`DAUGHTER_RETRIEVAL_AUDIT.md`](DAUGHTER_RETRIEVAL_AUDIT.md) — companion document. §3 status matrix is the single source of truth for "is daughter retrieval method X wired?".
>
> **Scope:** Capture-net + STATION_KEEP + R/F/ESC keymap end-to-end. Five distinct bugs in daughter-arm wiring fixed; manual-mode + wiring-gap patterns reaffirmed; offline-first principle re-locked.

### 10.1 Fixes shipped this session

| # | File | Change | Why |
|---|------|--------|-----|
| 1 | [`ArmUnit.js _updateTransit`](js/entities/ArmUnit.js:2351) | Manual-mode block now contains APPROACH-threshold check before `return;` | `enableManual()` fires during `LAUNCH_CEREMONY_COMPLETE` while arm is in TRANSIT; old `return;` skipped state transitions, arm coasted past target forever |
| 2 | [`ArmUnit.js _updateApproach`](js/entities/ArmUnit.js:2532) | Manual-mode block now contains distance-only SK gate check before `return;` (no velocity gate — controller is skipped) | Same root cause as #1 for APPROACH → STATION_KEEP transition |
| 3 | [`ArmUnit.js reelFromStationKeep()`](js/entities/ArmUnit.js:3048) (new method) | Exits SK → REELING (zero-fuel strut motor), not RETURNING (FEEP-powered). Mirrors `_exitStationKeep` cleanup pattern. | User-requested: "daughter out of fuel can't fly back" — REELING uses the mothership's strut reel motor via tether, no propellant |
| 4 | [`ArmManager.js _initArms()`](js/entities/ArmManager.js:219) | Added `arm.initNetInventory();` after every `new ArmUnit(...)` | The method existed but was NEVER called anywhere in production code. `_netInventory` stayed at 0; F-key capture blocked with `NET_EMPTY_CLICK` every press |
| 5 | [`main.js`](js/main.js:322) | Added `captureNetSystem.init()` before existing `captureNetVisual.init()`. Added `captureNetSystem.update(dt)` immediately before `captureNetVisual.update(dt)` in game loop. | The system was imported but `init()` and `update()` were NEVER called. Mother pod inventory uninitialized; net projectile FSM frozen (never advanced past FOLDED) |
| 6 | [`index.html`](index.html:352) importmap | Switched `three` and `three/addons/` from `cdn.jsdelivr.net` to `./node_modules/three/build/...` and `./node_modules/three/examples/jsm/` | Locked Product Principle #1 (Offline-First). Sim wouldn't start offline because THREE.js was CDN-loaded. The local node_modules already had the right version. |
| 7 | [`InputManager.js _onKeyDown R-key`](js/systems/InputManager.js:634) | During SK, R now calls `reelFromStationKeep()` (was: nothing useful; recenter handled in processInput which was removed). Forge toggle now suppressed during SK to avoid conflicting side-effect. | User said "automatically recenters" already works (auto-return Pattern C). R should now mean "reel in" — the daughter is on the strut tether and can be reeled back at zero fuel cost. |
| 8 | [`ArmUnit.js captureFromStationKeep()`](js/entities/ArmUnit.js:3032) | Added `COMMS_MESSAGE "Deploying net — stand by for capture"` on successful F-press. | Player feedback was silent before; F appeared to do nothing visually. |
| 9 | [`ArmUnit.js _updateNettingFSM`](js/entities/ArmUnit.js:3177) | Added `console.warn` on `fireDaughterNet` returning null (with inventory + flag details), and `console.log` on success. Tag: `[NETTING-FSM <armId>]` | Diagnostic — future regressions in net-fire path will print exact reason for fallback to APPROACH |
| 10 | [`CaptureNet.js _updateFlight`](js/entities/CaptureNet.js:277) + [`ArmUnit.js _updateNettingFSM`](js/entities/ArmUnit.js:3160) | **Three-part fix (follow-up session):** (a) Flight intersection check now reads `_scenePosition` (scene units → metres via `/M`) instead of non-existent `.position`. (b) Net position & distance computed in arm-relative co-orbiting frame (arm.position + displacement × M) so orbital motion doesn't defeat the 4 m standoff check. (c) Added `_firedNet` stored reference on ArmUnit so `_updateNettingFSM` survives `activeNets` lookup miss. | Root cause: `_updateFlight` read `targetDebris.position` (undefined in production — only test mocks have it); plus net flew in non-co-orbiting absolute metres while debris moves at 7.7 km/s; plus `getActiveNetForArm()` lost the net reference between frames. Result: net always timed out (8 s) → MISS → cooldown → APPROACH fallback = "daughter moves closer." |

### 10.2 Architecture insights (load-bearing — read before touching SK / salvage)

1. **Update-loop order ([`main.js:505-523`](js/main.js:505)):** `inputManager.processInput` → `autopilotSystem.update` → `player.update` → `debrisField.update` → `armManager.update` → `captureNetSystem.update` (newly wired) → `captureNetVisual.update` → ... Order matters: input must precede physics; debris propagation must precede arm consumption of `target._scenePosition`; net system must advance projectile state before visual reads it.

2. **Wiring-gap pattern (CRITICAL — search for more):** A system class can be imported in `main.js` and have full `init()` / `update(dt)` methods, but if `main.js` doesn't actually CALL them, the system is silently dead. **Both** must be called. Tests pass because tests instantiate modules directly; the bug is browser-only. This was the cause for CAPTURE_NET this session — look for the same pattern in other Epic 9/10 systems. See [`DAUGHTER_RETRIEVAL_AUDIT.md §4`](DAUGHTER_RETRIEVAL_AUDIT.md) for the systematic survey (TetherReel + BridleRing also confirmed orphaned).

3. **Manual-mode (`_manualMode`) is a foot-gun.** `enableManual()` is called by `_enterArmPilotCamera()` (P-key + G-key entry) AND by the `LAUNCH_CEREMONY_COMPLETE` event handler ([`InputManager.js:129`](js/systems/InputManager.js:129)). It sets `_manualMode = true` even if the arm is in TRANSIT/APPROACH (not yet at SK). Manual-mode branches in `_updateTransit`/`_updateApproach` short-circuit autopilot AND state transitions. **Rule:** when adding new states with manual-mode branches, INJECT the state-transition check inside the manual block before `return;`, do NOT delete the manual block (it intentionally suppresses pings/thruster audio/AP-disengage-guard during ARM_PILOT mode).

4. **STATION_KEEP entry gate** ([`_updateApproach`](js/entities/ArmUnit.js:2638) line ~2638): `distMetres <= standoff * ENTRY_DISTANCE_MULT (2.0) && relVel < ENTRY_MAX_VELOCITY (3.0)`. In manual-mode branch, the velocity gate is DROPPED (distance-only). Rationale: the proportional braking controller is skipped in manual mode so the arm arrives at coast velocity; the SK lerp (`STATIONKEEP_LERP_RATE = 0.8`) converges in ~3 frames regardless. Imperceptible.

5. **`_initSkFrame()`** establishes the frozen entry triad so arrow keys map to screen-aligned yaw (θ around `_skPolarAxis = Earth radial at debris`) and pitch (φ around `_skRightVec = equator0 × polar`). The triad never recomputes mid-SK so the camera does not roll regardless of orbital inclination.

6. **Salvage state chain (capture path):** `STATION_KEEP --F--> NETTING --(net.CAPTURED)--> GRAPPLED --(stabilize 1.5s)--> REELING --(reach mother)--> DOCKING --> RELOADING --> DOCKED`. Detached arms cannot return: GRAPPLED → DEORBITING instead.

7. **Salvage exits without capture:**
   - [`recallFromStationKeep()`](js/entities/ArmUnit.js:3041) → RETURNING (FEEP-powered, uses propellant)
   - [`reelFromStationKeep()`](js/entities/ArmUnit.js:3052) → REELING (zero-fuel, mothership strut motor pulls via tether) — preferred for out-of-fuel daughters
   - Target lost / fuel depleted in SK → `_exitStationKeep()` → RETURNING (legacy behavior)

8. **CAPTURE_NET FSM gating:** When [`Constants.FEATURE_FLAGS.CAPTURE_NET === true`](js/core/Constants.js:417) (current default), `_updateNetting` delegates to `_updateNettingFSM`. Otherwise legacy 85% dice-roll path runs. The FSM lives in [`CaptureNet.js`](js/entities/CaptureNet.js) (14 states: FOLDED → LAUNCHING → SPINNING_UP → FLIGHT → CONTACT → ...).

9. **Diagnostic log convention reaffirmed:** `[DBG-<TAG>]` or `[<SUBSYS>-<EVENT>]` prefix. Use `console.warn` so logs appear in default DevTools filter. Examples in code: `[DBG-ARM]`, `[DAP-TRANSIT]`, `[DAP-APPROACH]`, `[SK-ENTER]`, `[SK-EXIT]`, `[NETTING-FSM]` (this session).

10. **Test runner does NOT cover browser-only behavior.** 464 suites / 2,067 tests / 0 failures, yet the SK regression + capture wiring + offline loading were all undetected. Run `node --check <file>` on every modified `.js` after edits (catches template-literal traps that test runner misses). Always verify visually in the browser. **Recommendation:** add a `test-main-wiring.js` smoke test that asserts every system imported in `main.js` had `init()` OR `update()` called at least once during a mock boot cycle (see [`DAUGHTER_RETRIEVAL_AUDIT.md §6 #9`](DAUGHTER_RETRIEVAL_AUDIT.md)).

### 10.3 Daughter control keymap (during STATION_KEEP)

| Key | Action | Code path |
|-----|--------|-----------|
| ← → ↑ ↓ | Orbit debris (θ yaw / φ pitch) | [`processInput`](js/systems/InputManager.js:1391) line ~1391 emits `ARM_ORBIT_ADJUST` → [`ArmUnit:288`](js/entities/ArmUnit.js:288) listener sets rate |
| Mouse wheel | Zoom standoff (4–12 m) | [`processInput _onWheel`](js/systems/InputManager.js:1391) → `ARM_ORBIT_ADJUST {radiusStep}` |
| **F** | Fire net → NETTING → GRAPPLED → auto-REELING | [`_onKeyDown:838`](js/systems/InputManager.js:838) → [`captureFromStationKeep()`](js/entities/ArmUnit.js:3032) |
| **R** | Reel in (zero-fuel strut motor → REELING → DOCKING) | [`_onKeyDown:640`](js/systems/InputManager.js:640) (during SK) → [`reelFromStationKeep()`](js/entities/ArmUnit.js:3052) |
| **ESC** | Recall via FEEP (RETURNING → DOCKING) | [`_onKeyDown:541`](js/systems/InputManager.js:541) → [`recallFromStationKeep()`](js/entities/ArmUnit.js:3041) |
| Shift | Fine mode (¼ rate) for orbit/zoom | Modifier on ARM_ORBIT_ADJUST |

### 10.4 Open work — what to read next

The capture-net path is now end-to-end functional. **[`DAUGHTER_RETRIEVAL_AUDIT.md`](DAUGHTER_RETRIEVAL_AUDIT.md)** systematically audits the OTHER retrieval methods (FISHING, TRAWLING, WEB_SHOT, ABLATING, SCANNING, HAULING, REELING, RETURNING) for the same wiring-gap pattern. Key findings:

- **Confirmed orphaned wiring** ([§4](DAUGHTER_RETRIEVAL_AUDIT.md)): [`TetherReel.js`](js/systems/TetherReel.js) — neither imported nor init'd/update'd in [`main.js`](js/main.js); [`BridleRing.js`](js/entities/BridleRing.js) — same. Web Shot ([`fireWebShot`](js/entities/ArmUnit.js:953)) has no keyboard binding.
- **Suspected functional gaps** ([§5](DAUGHTER_RETRIEVAL_AUDIT.md)): FISHING auto-capture radius (`netSize × M × 0.5`) likely too small for orbital relative velocities. `_updateReeling` lacks the `isDetached` guard that `_updateHauling` has.
- **Recommended fix order** ([§6](DAUGHTER_RETRIEVAL_AUDIT.md)): Tier-A quick wins (1–2 h each) before Tier-B wiring gaps (TetherReel + BridleRing → mirrors the CAPTURE_NET fix pattern from this session).
- **Open questions** ([§7](DAUGHTER_RETRIEVAL_AUDIT.md)): 7 design decisions blocking work (ship/hide/remove Web Shot? cancel Ablation? expose Fishing to a hotkey? mandatory wiring-smoke-test?).
