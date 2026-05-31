# Space Cowboy — Implementation Plan

> Orchestrator brief synthesising [`HANDOFF.md`](HANDOFF.md:1) (tactical, current shift + next steps) and [`BIG_PICTURE.md`](BIG_PICTURE.md:1) (strategic, 39 sections, 12-month / 4-quarter roadmap).
>
> Scope & ordering: **Sprints 1–4** are HANDOFF's original priority order (delivered Apr 2026). **Epics 5–10** are BIG_PICTURE quarterly scope (Epics 5, 6, 8, 9, 10 delivered; Epic 7 pending). **Post-Sprint Polish (2026-06)** is the follow-up backlog from the 2026-05-30 four-fix architectural sprint.
>
> Current test baseline: **556 suites / 2364 tests / 0 failures** (post-4-fix sprint, 2026-05-30). Every sprint must land green.

---

## Table of Contents

0. [Completion Log](#completion-log) ← **Start here for handoff context**
0. [▶ NEXT: Post-Sprint Polish & Architecture (2026-06)](#-next-post-sprint-polish--architecture-2026-06) ← **Start here for new work** (4-fix sprint complete ✅)
1. [Sprint 1 — Tier A Quick Wins (1 day)](#sprint-1--tier-a-quick-wins-1-day)
2. [Sprint 2 — Tier B First-Experience UX (2–3 days)](#sprint-2--tier-b-first-experience-ux-23-days)
3. [Sprint 3 — Tier C Onboarding Redesign (2–4 days)](#sprint-3--tier-c-onboarding-redesign-24-days)
4. [Sprint 4 — Tier C Mission Operations Model (4–7 days)](#sprint-4--tier-c-mission-operations-model-47-days)
5. [Epic 5 — Q1 UX Foundation (BIG_PICTURE Part I)](#epic-5--q1-ux-foundation-big_picture-part-i)
6. [Epic 6 — Q2 Data, Education & TRL Framing](#epic-6--q2-data-education--trl-framing)
7. [Epic 7 — Q3 Missions + Rendezvous Ladder](#epic-7--q3-missions--rendezvous-ladder)
8. [Epic 8 — Daughter-Arm Redesign + Dual-Metal FEEP + ISRO Heritage](#epic-8--q4-v5-baseline--daughter-arm-redesign--isro-heritage)
9. [Cross-Cutting Rules](#cross-cutting-rules)
10. [Dependency Graph](#dependency-graph)
11. [Delegation Model](#delegation-model)

---

## Completion Log

- 2026-05-30: **Four-Fix Architectural Sprint complete.** [`archive/FIX_PLAN.md`](archive/FIX_PLAN.md:1)
  delivered: Issue 1 (Z-layer + aft rendering + RENDER_ORDER convention), Issue 2 (rotation lock
  with exponential spring-resistance model), Issue 3 (TPI composite target ranking), Issue 4
  (ROSA panel front/back split). Test delta: **+44 tests** (2320 → **2364**), **556 suites**, 0 failures.
  Service worker bumped to v4. New constants: [`RENDER_ORDER`](js/core/Constants.js:1) (6-tier enum),
  [`TETHER_ROTATION`](js/core/Constants.js:1) (spring model), [`TARGET_RANKING`](js/core/Constants.js:1) (TPI weights + MOID threat map).
  New canonical predicates on [`ArmManager`](js/entities/ArmManager.js:1): `hasTetheredArm()`,
  `getRotationLockTier()`. New test file: [`test-RotationLock.js`](js/test/test-RotationLock.js:1) (7 suites, 44 tests).
  Bonus: [`AutopilotSystem.armsActive`](js/systems/AutopilotSystem.js:1) under-inclusive check (was 4 of 22 ARM_STATES) replaced with `hasTetheredArm()`.
  Emergent discovery: spring-resistance creates a skill-based boost-assist rotation mechanic
  (build displacement → release for springback boost). 21 deferred items + recommended next-step
  ordering at [`HANDOFF.md §4–§5`](HANDOFF.md:1). 7-item polish backlog: see [▶ NEXT below](#-next-post-sprint-polish--architecture-2026-06).
  Touched: PlayerSatellite.js, ArmUnit.js, MenuScene3D.js (Issue 1+4); ArmManager.js,
  InputManager.js, AutopilotSystem.js, Constants.js, test-RotationLock.js, run-tests.js (Issue 2);
  DebrisField.js, TargetPanel.js, Constants.js, InputManager.js (Issue 3); sw.js (cache bump).
  Docs: HANDOFF.md (full rewrite), FIX_PLAN.md → archive/, IMPLEMENTATION_PLAN.md (this file).

- 2026-04-27: **Config G adopted + Epic 9 gap scoping complete.** Barrel-axial
  top-collar geometry (2.0m × 0.8m barrel, 3-plane layout, ROSA panels, strut-mounted reel).
  See [`ARM_PIVOT_ANALYSIS.md §10`](ARM_PIVOT_ANALYSIS.md:801) for locked spec.
  Gap items #4–#14 scoped: Comprehensive bundle (7 IN, 1 STUB, 3 DEFER).
  Semi-auto aim rotation adopted. ST-9.6 (ablation) and ST-9.9 (Reality Mode) deferred to Epic 10.
  New tasks: ST-9.10 (stow/deploy), ST-9.11 (launch locks + ROSA), ST-9.12 (CoM + interlock).
  Full gap analysis + orchestrator specs: [`ARM_PIVOT_GAPS_EXPLAINER.md`](archive/ARM_PIVOT_GAPS_EXPLAINER.md).
  Mass budget: Y0 dry=196.4 kg, wet=242.4 kg (Config G canonical).
  Touched: IMPLEMENTATION_PLAN.md (this file), HANDOFF.md, CROSSBOW_ARMS.md,
  CAPTURE_NET.md, BIG_PICTURE.md, ARM_PIVOT_GAPS_EXPLAINER.md (new).

- 2026-04-26: Design pivots Rev 5. Strut → 1-DOF yaw-only. Arm count → Quad-4 Y0
  baseline with Hex Y1 / Octo Y3 tech ladder. ST-9.2 + ST-9.3 + ST-9.8 re-spec'd.
  Mass budget recomputed across Y0/Y1/Y3 (from Constants.OCTOPUS_V5 per-arm values).
  Doc-only change; code follows in next ST-9.2 sub-task.
  Touched: CAPTURE_NET.md (Rev 5), CROSSBOW_ARMS.md (§8/§12.5/§25), BIG_PICTURE.md
  (§12.4/§13/§29/§35/§36/§38/§39), IMPLEMENTATION_PLAN.md (this file), HANDOFF.md (§3).

### Sprints 1–4: HANDOFF Deliverables ✅ (Completed Apr 19, 2026)

**Test baseline: 157 suites, 841 tests, 0 failures.**

#### Sprint 3 — Tier C Onboarding Redesign (Complete)
| ID | Title | Files | Status |
|----|-------|-------|--------|
| ST-3.1 | Checklist Mode in Discovery Pane | `SkillsPane.js` (+194 LOC) | ✅ |
| ST-3.2 | Delete TutorialSystem.js | `TutorialSystem.js` deleted (–752 LOC) | ✅ |
| ST-3.3 | Dormant panel corner-glyph affordance | `HUD.js`, `StatusPanel.js`, `TargetPanel.js` (+32 LOC) | ✅ |
| ST-3.4 | Mastery celebration | `AudioSystem.js`, `SkillsPane.js`, `HUD.js`, `Events.js` | ✅ |
| ST-3.5 | Skills-based gates | 10 systems migrated from tutorialStage | ✅ |

#### Sprint 4 — Tier C Mission Operations Model (Complete)
| ID | Title | Files | Status |
|----|-------|-------|--------|
| ST-4.A | Debris Map (was "Field-Assay MFD") | NEW `DebrisMap.js` (604 LOC), `AutopilotSystem.js`, `InputManager.js` | ✅ |
| ST-4.B | Station-Keeping Recoil Compensation | `AutopilotSystem.js`, `LassoSystem.js`, `ArmUnit.js` | ✅ |
| ST-4.C | Mission Spawn Difficulty Profiles | `Constants.MISSIONS`, `ScoringSystem.js`, `DebrisField.js` | ✅ |
| ST-4.D | Dynamic Mid-Mission Events | NEW `MissionEventSystem.js` (301 LOC), `SensorSystem.js` | ✅ |
| ST-4.E | Tool-Tier Efficiency Report | `ScoringSystem.js`, `SweepReportUI.js` | ✅ |

#### Post-Sprint Bug Fixes
| Bug | Cause | Fix | File |
|-----|-------|-----|------|
| Lasso invisible on first target | `!this._targetId` falsy-zero (id=0 treated as null) | `this._targetId == null` | [`LassoSystem.js:586`](js/systems/LassoSystem.js:586) |
| M1 spawns 1 debris instead of 7 | `profile.clusters` incorrectly sliced WELCOME_FIELD | Removed slice — welcome field always spawns in full | [`DebrisField.js:863`](js/entities/DebrisField.js:863) |

#### New Constants Namespaces Added (Sprints 3+4)
- `Constants.SKILL_GATES` — conjunction, kessler, subsystem catch thresholds
- `Constants.DISCOVERY_PANE` — checklist suggestion count, linger duration
- `Constants.SKILLS.CELEBRATION` — mastery toast threshold, durations
- `Constants.DEBRIS_MAP` — poll interval, max display, max ΔV
- `Constants.AUTOPILOT.STATION_KEEP_*` — compensation toggle, efficiency
- `Constants.MISSIONS` — DEBRIS_PER_MISSION, PROFILES[] (5-tier progression)
- `Constants.MISSION_EVENTS` — cooldown, synergy timer, hydrazine bonus

#### New Events Added (Sprints 3+4)
- `MASTERY_FANFARE` — skill mastery celebration trigger
- `MISSION_START` — mission number transition
- `DEBRIS_MAP_CLUSTER_SELECTED` — cluster selection in debris map
- `DEBRIS_HAZARD_REVEALED` — hydrazine scan discovery
- `SYNERGY_OPPORTUNITY` — synergy pair detected
- `CASCADE_THREAT` — Kessler cascade during operations
- `WEATHER_MISSION_EFFECT` — severe weather impacting sensors
- `CLUSTER_CONJUNCTION` — multiple conjunctions in altitude band

#### New Test Files Added
- [`test-no-tutorial-legacy.js`](js/test/test-no-tutorial-legacy.js) — TutorialSystem purge validation
- [`test-hud-activate-keys.js`](js/test/test-hud-activate-keys.js) — dormant glyph attribute checks
- [`test-DebrisMap.js`](js/test/test-DebrisMap.js) — cluster scoring + autopilot engagement
- [`test-MissionProfiles.js`](js/test/test-MissionProfiles.js) — profile selection + MISSION_START emission
- [`test-MissionEvents.js`](js/test/test-MissionEvents.js) — mid-mission event triggers + suppression

#### Current Keybind Map (Post-Sprint 4)
| Key | Action | Added In |
|-----|--------|----------|
| `` ` `` (backtick) | Toggle Debris Map | ST-4.A |
| `Shift+A` | Engage autopilot to selected cluster | ST-4.A |
| `,` / `.` | Select prev/next cluster in Debris Map | ST-4.A |
| `Escape` | Close Debris Map (+ existing uses) | ST-4.A |
| `` Shift+` `` | Tool cycling (relocated from backtick) | ST-4.A |

### Epic 5 — Q1 UX Foundation ✅ (Complete Apr 20, 2026)

| ID | Title | Key Deliverables | Test Delta |
|----|-------|------------------|------------|
| ST-5.3 | Earth 16k LOD + FOV 55° + VLEO Intro | Earth 16k/8k/4k LOD, FOV 55°, VLEO cinematic intro, cloud rotation | +5 suites, +22 tests (→ 130/695) |
| ST-5.4 | NavSphere Stalks + Lock-On Ring | Bidirectional stalks, pulsing cyan lock-on ring, WGS-84 geolocation (LAT/LON/ALT @ 2 Hz), closure velocity arrows | +9 suites, +44 tests (→ 139/739) |
| ST-5.2 | Player/Arm Trail Ribbons | 3-D world-space ribbon trails | +8 suites, +52 tests (→ 147/791) |
| ST-5.1 | Comms 6-Channel + Radial Menu | 6-channel comms pane, target-anchored radial command menu, center popup removed | +10 suites, +50 tests (→ 157/841) |

**Epic 5 total: +32 suites, +168 tests** (baseline 125/673 → 157/841).

#### New Modules Created
- [`TrailSystem.js`](js/ui/TrailSystem.js) — player/arm ribbon trails in 3-D world space (570 LOC)
- [`RadialMenu.js`](js/ui/hud/RadialMenu.js) — target-anchored radial command menu (~430 LOC)

#### New Constants Namespaces Added
- `Constants.EARTH` — LOD texture thresholds, cloud rotation rate
- `Constants.NAVSPHERE` (extended) — stalk geometry, lock-on ring, geolocation, velocity arrows
- `Constants.TRAILS` — ribbon width, sample rate, max length, ENABLED flag
- `Constants.COMMS` — 6-channel layout, radial menu geometry
- `Constants.CAMERA_FOV` / `Constants.CAMERA_FOV_ARM_PILOT` — hoisted FOV constants (55°)

#### New Events Added
- `PLAYER_TRAIL_SAMPLE`, `ARM_TRAIL_SAMPLE`, `ARM_TRAIL_CLEAR` — trail system sampling
- `COMMS_FOCUS`, `COMMS_RADIAL_OPEN`, `COMMS_RADIAL_CLOSE` — radial menu lifecycle
- `COMMS_SCROLL_UP`, `COMMS_SCROLL_DOWN` — channel scrolling
- `COMMS_MESSAGE` gained optional `channel` metadata key

#### New Test Files Added
- [`test-EarthLOD.js`](js/test/test-EarthLOD.js) — Earth LOD texture + FOV validation
- [`test-CameraFOV.js`](js/test/test-CameraFOV.js) — FOV 55° + arm pilot FOV
- [`test-NavSphere.js`](js/test/test-NavSphere.js) — stalks, lock-on ring, geolocation, velocity arrows
- [`test-TrailSystem.js`](js/test/test-TrailSystem.js) — ribbon trail sampling + rendering
- [`test-CommsSystem.js`](js/test/test-CommsSystem.js) — 6-channel comms + message routing
- [`test-CommsPanel.js`](js/test/test-CommsPanel.js) — panel UI + channel switching
- [`test-RadialMenu.js`](js/test/test-RadialMenu.js) — radial menu open/close/selection

#### Notable Deletions
- `CommsPanel._buildCommsMenu()`, `_updateCommsMenu()`, `_setCommsCommandAvail()` — center popup helpers removed
- `_commsMenuEl`, `comms-menu-style` — center popup DOM elements removed
- Number-key comms-menu intercept in [`InputManager.js`](js/systems/InputManager.js) — removed

---

## ✅ DONE: Epic 6 — Data, Education & Honest Framing

**Prerequisites**: All Sprints 1–4 and Epic 5 complete. 841 tests green.

**Start here**: Read [`BIG_PICTURE.md`](BIG_PICTURE.md) for full specs — Epic 6 draws from multiple sections.

### Quick Orientation for New Developer
1. Run `./test.sh` — expect 157 suites, 841 tests, 0 failures
2. Run `./start.sh` — launches the game in browser
3. Key architecture files:
   - [`ARCHITECTURE.md`](ARCHITECTURE.md) — system overview
   - [`HANDOFF.md`](HANDOFF.md) — original recommendations (Sprints 1–4 implemented)
   - [`BIG_PICTURE.md`](BIG_PICTURE.md) — quarterly roadmap (Epics 5–8)
   - [`js/core/Constants.js`](js/core/Constants.js) — all tuning constants (search for namespace names above)
   - [`js/core/Events.js`](js/core/Events.js) — all event bus events
4. The game uses vanilla JS + Three.js, no build system, ES modules via `<script type="module">`
5. HUD panels are in `js/ui/hud/`, systems in `js/systems/`, entities in `js/entities/`

### Epic 6 Authoritative Spec Sources (from BIG_PICTURE)
- **ST-6.1** Offline data catalog → [`§2`](BIG_PICTURE.md:147)
- **ST-6.2** Debris wireframe Phase 2–3 → [`§6`](BIG_PICTURE.md:366)
- **ST-6.3** MOID computation + badges → [`§21`](BIG_PICTURE.md:1059)
- **ST-6.4** Strategic 3-D Map → [`§4`](BIG_PICTURE.md:280)
- **ST-6.5** Teaching overlays → [`§19`](BIG_PICTURE.md:1006)
- **ST-6.6** TRL numbers on Codex/Shop/tooltips → [`§25`](BIG_PICTURE.md:1192)
- **ST-6.7** Environment-effect events → [`§30–§33`](BIG_PICTURE.md:1389)

> **Note:** The [Epic 6 summary table](#epic-6--q2-data-education--trl-framing) below contains only the short overview — callers must read BIG_PICTURE for full acceptance criteria and implementation specs.

### Known Gotchas (carry-forward)
- [`CommsPanel.js`](js/ui/hud/CommsPanel.js) uses `source:` field (not `sender:`) for message origin — [`ScoringSystem`](js/systems/ScoringSystem.js) and [`MissionEventSystem`](js/systems/MissionEventSystem.js) both use `source: 'HOUSTON'`
- The [`_applySkillReveal()`](js/ui/HUD.js) HUD path is THE reveal mechanism (TutorialSystem deleted in Sprint 3 ST-3.2) — don't add a parallel system
- [`DebrisMap.js`](js/ui/DebrisMap.js) suppresses all InputManager keys when visible — new keybinds must be added to the passthrough list in [`InputManager._handleKeyDown()`](js/systems/InputManager.js) if they should work while the map is open
- Mission profiles ([`Constants.MISSIONS.PROFILES`](js/core/Constants.js)) gate conjunction/kessler/weather — new systems that should be suppressed early-game must add a profile flag

---

## ▶ NEXT: Post-Sprint Polish & Architecture (2026-06)

> **Source:** [`HANDOFF.md §5 Recommended Next Steps`](HANDOFF.md:1) — emerged from the 2026-05-30 four-fix architectural sprint (see [Completion Log](#completion-log)).
>
> **Prerequisites:** 4-fix sprint complete. **556 suites / 2364 tests / 0 failures**.
>
> **Suggested ordering:**
> ```
> Day 1: ST-PS.2 test-TargetRanking → ST-PS.7 dynamic DIST_REF_KM → ST-PS.4 TPI in AP
> Day 2: ST-PS.1 setThrusterFire → ST-PS.6 teaching moment
> Day 3: ST-PS.3 SpacecraftMaterials → ST-PS.5 RENDER_ORDER extend
> ```
>
> All 7 items are scoped, ready for Orchestrator to research+architect+code. Dependencies noted at the end.

### ST-PS.1 — `setThrusterFire(axis, sign, magnitude)` differential firing

- **Source.** [`archive/FIX_PLAN.md §2.2.C`](archive/FIX_PLAN.md:1) (deferred); [`HANDOFF §4.1 #1`](HANDOFF.md:1).
- **Problem.** All 4 main FEEPs lerp glow + plume together via [`PlayerSatellite._animateThrusters`](js/entities/PlayerSatellite.js:1). Player rotation input fires all 4 nozzles regardless of axis — visually breaks the "this is a real spacecraft" reading and misses the physics-fidelity opportunity the FEEP-nozzle visual upgrade landed for.
- **Fix.** New method `setThrusterFire(axis, sign, magnitude)` on [`PlayerSatellite`](js/entities/PlayerSatellite.js:1). Map: pitch+ → HT_BOTTOM, pitch− → HT_TOP, yaw+ → HT_LEFT, yaw− → HT_RIGHT. Lerp per-thruster glow intensity (matches existing `_thrusterGlowTargets` pattern). Call from [`InputManager.processInput`](js/systems/InputManager.js:1) after each `rotatePitch`/`rotateYaw`. Verify axis-sign convention against [`PlayerSatellite.rotatePitch`](js/entities/PlayerSatellite.js:1).
- **Test.** Extend [`test-FEEPMetals.js`](js/test/test-FEEPMetals.js:1) (or new `test-ThrusterFire.js`): assert (axis, sign) → expected `_thrusterId` map; assert single-axis input fires only 1 nozzle; CoMCalculator + FEEPMetals tests stay green.
- **Mode.** `code`. **Effort.** ~1–2 h.
- **Acceptance.** Holding ↑ fires only HT_BOTTOM plume; ↑+← fires HT_BOTTOM + HT_LEFT independently; spring-resistance soft-tier scales magnitude proportionally.

### ST-PS.2 — `test-TargetRanking.js` (TPI coverage)

- **Source.** [`HANDOFF §4.4 #12`](HANDOFF.md:1) test gap; [`archive/FIX_PLAN.md §4.6`](archive/FIX_PLAN.md:1) suggested coverage list.
- **Problem.** TPI math shipped without unit tests. MOID null fallback, weight normalization, and threat multiplier behaviour have no regression coverage.
- **Fix.** New [`js/test/test-TargetRanking.js`](js/test/test-TargetRanking.js:1) with cases per [`archive/FIX_PLAN.md §4.6`](archive/FIX_PLAN.md:1):
  - 4-target comparison table (close-cheap, close-expensive, far-cheap, MOID-HI) → assert exact ordering
  - Edge: distance == DIST_REF_KM → distScore = 0 (not filtered)
  - Edge: estimatedPoints = 0 → no NaN
  - Threat tier override: identical rows except `moidBadge: 'HI'` → HI row ranks higher
  - MOID badge propagation (Issue 3 §4.4 #14): `debris.moidBadge` reaches row.moidBadge
- **Mode.** `code`. **Effort.** ~1 h.
- **Acceptance.** New test file passes; covers 8+ TPI scenarios; total suite stays green.

### ST-PS.3 — Extract `js/scene/SpacecraftMaterials.js`

- **Source.** [`HANDOFF §4.5 #16`](HANDOFF.md:1) architecture opportunity.
- **Problem.** `panelMatFront`, `panelMatBack`, `gridMat`, `goldEdgeMat` duplicated between [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:1) and [`ArmUnit.js`](js/entities/ArmUnit.js:1) (10 materials where 4 suffice). Future panel tweaks risk skew between mother and daughter.
- **Fix.** New `js/scene/SpacecraftMaterials.js` module exporting `getPanelMatFront()`, `getPanelMatBack()`, `getPanelGridMat()`, `getPanelGoldEdgeMat()` (memoized singletons). [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:1) and [`ArmUnit.js`](js/entities/ArmUnit.js:1) import from it. No behaviour change.
- **Test.** Existing visual tests stay green. Optional: new `test-SpacecraftMaterials.js` asserting same instance returned across calls.
- **Mode.** `code`. **Effort.** ~1.5 h.
- **Acceptance.** 4 materials exported; both spacecraft files import from the new module; 0 regressions in existing tests; bloom budget unchanged.

### ST-PS.4 — Wire TPI into AutopilotSystem fallback

- **Source.** [`HANDOFF §4.5 #18`](HANDOFF.md:1) architecture opportunity. Depends on ST-PS.2 for test coverage.
- **Problem.** [`AutopilotSystem`](js/systems/AutopilotSystem.js:1) fallback target picker uses "nearest Tier 3/4" inline logic; doesn't benefit from MOID prioritisation that TPI bakes in.
- **Fix.** Replace inline pick with `debrisField.getEnhancedTargetList(...)[0]`. AP now respects player-visible ranking and surfaces MOID-priority threats.
- **Test.** Extend [`test-AutopilotSystem.js`](js/test/test-AutopilotSystem.js:1): AP target fallback chooses top-TPI not nearest-distance when a HI MOID target exists at slightly longer range.
- **Mode.** `code`. **Effort.** ~30 min.
- **Acceptance.** AP fallback target consistent with what's shown at the top of the player's panel; 1+ new test passes.

### ST-PS.5 — Extend `RENDER_ORDER` to 5+ more modules

- **Source.** [`HANDOFF §4.5 #17`](HANDOFF.md:1) architecture opportunity. [`HANDOFF §2.4`](HANDOFF.md:1) convention not yet project-wide.
- **Problem.** 6 modules still use ad-hoc renderOrder integers: [`Earth.js`](js/scene/Earth.js:1), [`Starfield.js`](js/scene/Starfield.js:1), [`TrailSystem.js`](js/ui/TrailSystem.js:1), [`TargetReticle.js`](js/ui/TargetReticle.js:1), [`NavSphere.js`](js/ui/NavSphere.js:1), [`DockingReticle.js`](js/ui/DockingReticle.js:1). Future visual layering work risks ordering inconsistency.
- **Fix.** Replace all numeric `renderOrder` literals with `Constants.RENDER_ORDER.*` references. Extend the enum if a new tier is needed (e.g., `BACKGROUND = -1` for Starfield if it currently uses negative values).
- **Test.** Existing visual smoke tests stay green. Optional: linter-style grep that fails CI on `renderOrder = <integer>` outside Constants.
- **Mode.** `code`. **Effort.** ~2 h.
- **Acceptance.** `grep -RIn 'renderOrder = ' js/` returns only Constants.js or `RENDER_ORDER.*` references; 0 visual regressions.

### ST-PS.6 — Teaching moment for rotation lock + spring-snap-back skill

- **Source.** [`HANDOFF §4.5 #19`](HANDOFF.md:1) architecture opportunity + [`§4.6 #21`](HANDOFF.md:1) emergent product opportunity.
- **Problem.** Players hitting the new rotation lock get a comms warning but no Codex/teaching reinforcement. The skill-based springback boost (build displacement → release for assisted rotation) is undiscoverable without help.
- **Fix.** Two parts:
  1. **Teaching overlay.** Subscribe [`TeachingSystem.js`](js/systems/TeachingSystem.js:1) to `COMMS_MESSAGE` events filtered by "rotation locked" category. Once-per-profile overlay: *"Rotation locked while daughters are tethered. Recall (H) or wait for capture. Soft-tier states (TRANSIT/APPROACH) allow limited rotation — release arrows to ride the springback for an assisted swing."*
  2. **Codex entry.** New entry in `LEARNING` category documenting the skill: build displacement → release → springback boost. Cross-reference real-world tether dynamics.
- **Test.** Extend [`test-TeachingSystem.js`](js/test/test-TeachingSystem.js:1): rotation-lock comms triggers teaching overlay; only fires once per profile; Codex entry registered.
- **Mode.** `code`. **Effort.** ~45 min.
- **Acceptance.** New player hits rotation lock → sees overlay once; subsequent locks → comms only; Codex entry searchable; teaching-system tests pass.

### ST-PS.7 — Dynamic `DIST_REF_KM` from sensor tier

- **Source.** [`HANDOFF §4.1 #2`](HANDOFF.md:1) silently deferred from FIX_PLAN. Depends on ST-PS.2 for test coverage.
- **Problem.** TPI distance reference is a fixed 100km. Sensor upgrades don't change ranking sensitivity — a Basic sensor (10km max) ranks the same way as Advanced (100km max).
- **Fix.** In [`DebrisField.getEnhancedTargetList`](js/entities/DebrisField.js:1), read `SENSOR_TIERS[d.sensorSystem.tier].rangeKm` and scale `DIST_REF_KM = max(sensorRangeKm × 0.7, 10)`. Pass sensor tier through the call. Default fallback when sensor unavailable: 100km (current behaviour).
- **Test.** Extend [`test-TargetRanking.js`](js/test/test-TargetRanking.js:1) (from ST-PS.2): sensor tier 'basic' → 7km DIST_REF_KM → 60km debris very low rank; sensor tier 'advanced' → 70km DIST_REF_KM → same 60km debris climbs several positions.
- **Mode.** `code`. **Effort.** ~30 min.
- **Acceptance.** TPI reference scales with sensor tier; manual playtest confirms far targets stay competitive as player upgrades sensors; existing TPI tests stay green; new sensor-tier scaling test passes.

### Cross-references

| ST | HANDOFF source | FIX_PLAN source | Effort | Mode |
|----|---|---|---|------|
| ST-PS.1 setThrusterFire | §4.1 #1 + §4.5 #20 | §2.2.C | ~1–2 h | code |
| ST-PS.2 test-TargetRanking | §4.4 #12 | §4.6 | ~1 h | code |
| ST-PS.3 SpacecraftMaterials | §4.5 #16 | (new — emergent) | ~1.5 h | code |
| ST-PS.4 TPI in AP | §4.5 #18 | §4.2 | ~30 min | code |
| ST-PS.5 RENDER_ORDER extend | §4.5 #17 | §2.2.A | ~2 h | code |
| ST-PS.6 teaching moment | §4.5 #19 + §4.6 #21 | (new — emergent) | ~45 min | code |
| ST-PS.7 dynamic DIST_REF_KM | §4.1 #2 | §4.2 | ~30 min | code |

### Dependency graph

```
ST-PS.2 test-TargetRanking ──┬─→ ST-PS.4 TPI in AP
                              └─→ ST-PS.7 dynamic DIST_REF_KM

ST-PS.1 setThrusterFire ──→ ST-PS.6 teaching (visual reinforcement)
ST-PS.3 SpacecraftMaterials ── independent
ST-PS.5 RENDER_ORDER extend ── independent
```

**Total effort:** ~7 h engineering + ~1 h playtest tuning. ≈ **1.5 days** for a single developer; **3 parallel tracks** possible (PS.2/PS.4/PS.7 batch · PS.1/PS.6 batch · PS.3/PS.5 batch).

### Feature flag watch list (carry-forward)

When `TETHER_REEL` flag flips ON: audit [`ArmManager.getRotationLockTier()`](js/entities/ArmManager.js:1) for severed-tether downgrade. When `STOW_DEPLOY_STATE_MACHINE` flips ON: consider 4th `'warn'` tier for DEPLOYING/STOWING transients. See [`HANDOFF §6`](HANDOFF.md:1).

---

## Sprint 1 — Tier A Quick Wins (1 day)

**Goal.** Ship three pure bug/tuning fixes plus the tether catenary fix. No design risk. Commit message: `"fix(arms,tether,lasso): world-frame dock directions + catenary perpendicular + lasso tuning"`.

### ST-1.1 — Arm 180° deploy direction ([`HANDOFF §4.6`](HANDOFF.md:327))

- **Bug.** Six call sites in [`ArmUnit.js`](js/entities/ArmUnit.js:1) use `this.dockOffset.clone().normalize()` as a **world** direction, but `dockOffset` is **local**. When `parentQuat` ≠ identity, arms fire through the ship.
- **Fix.** Add helper [`ArmUnit._worldDockDirection(parentQuat)`](js/entities/ArmUnit.js:1) that clones → applies quaternion → normalizes. Cache `this._lastParentQuat` in [`_updateDocked()`](js/entities/ArmUnit.js:1151). Replace at [`ArmUnit.js:466, 508, 559, 1127, 1170`](js/entities/ArmUnit.js:466).
- **Test.** Extend [`test-Crossbow-ArmUnit.js`](js/test/test-Crossbow-ArmUnit.js:1): identity / 90° / 180° parentQuat cases — last one would have caught the bug ([`HANDOFF §6.2`](HANDOFF.md:864)).
- **Mode.** `code`. **Effort.** 1–2 h.

### ST-1.2 — Lasso speed + `TIME_SCALE_GAMEPLAY` fix ([`HANDOFF §4.4`](HANDOFF.md:284))

- **Bug.** [`LassoSystem.js:419-422`](js/systems/LassoSystem.js:419) integrates `speed * dt` in **real dt**, not `gameDt` — the [`§3.2 silent multiplier`](HANDOFF.md:167) gotcha. Combined with [`LASSO_SPEED = 5 m/s`](js/core/Constants.js:756), the projectile takes 15 s to cover 120 m.
- **Fix.** (a) Raise `LASSO_SPEED` 5→40 m/s. (b) Multiply step by `Constants.TIME_SCALE_GAMEPLAY`. (c) Halve trail-sampler threshold 0.06→0.03. (d) Reduce `maxFlightTime` to 8 s. (e) `_reelProgress += dt * 1.5` → 0.7 s reel.
- **Test.** New `test-LassoSystem.js`: (a) constant value, (b) step formula, (c) contact within `maxFlightTime` at 120 m.
- **Mode.** `code`. **Effort.** 1–2 h.

### ST-1.3 — Lasso reusability — Option A surfacing ([`HANDOFF §4.5`](HANDOFF.md:306))

- **Problem.** Existing 2 s cooldown is invisible — players think lasso is broken.
- **Fix.** Hoist magic numbers into [`Constants.LASSO_COOLDOWN_CATCH`](js/core/Constants.js:1) / `LASSO_COOLDOWN_MISS`. Add 2 s ring progress indicator next to SPACE hint in [`StatusPanel`](js/ui/hud/StatusPanel.js:1). First-cast comms primer: *"Lasso ready in 2 s — unlimited casts."*
- **Test.** Extend `test-LassoSystem.js`: cooldown decrement + `LASSO_DENIED` during cooldown.
- **Mode.** `code`. **Effort.** ~2 h.

### ST-1.4 — Tether catenary 90° bug ([`BIG_PICTURE §9`](BIG_PICTURE.md:513))

- **Bug.** [`ArmUnit._updateTether()`](js/entities/ArmUnit.js:2083) at [`line 2132`](js/entities/ArmUnit.js:2132) applies sag unconditionally in **world +Y** and scales by **max tether length** — folds the mid-segment when the tether aligns with world-Y.
- **Fix.** Compute tether-perpendicular sag direction by projecting world-down onto the plane ⟂ to tether. Scale by **current separation**, not max. Full math in [`BIG_PICTURE §9.3`](BIG_PICTURE.md:538).
- **Test.** New test in `test-ArmUnit.js` ([`BIG_PICTURE §9.4`](BIG_PICTURE.md:585)): arm displaced purely along +Y from mother → mid-vertex Y == linear-Y (sag in X/Z only).
- **Mode.** `code`. **Effort.** ~2 h.

**Sprint 1 acceptance:** arms fire outward from every ship orientation; lasso cast→catch ≤ 5 s at 120 m; SPACE hint shows cooldown ring; tether catenary smooth at all orientations; test suite ≥ 389 pass.

---

## Sprint 2 — Tier B First-Experience UX (2–3 days)

**Goal.** Visual + tuning pass that transforms the first-session experience. Commit: `"feat(hud,debris,lasso): conjunction gating + target prominence + 3-D debris + bolas"`.

### ST-2.1 — Conjunction alert gating ([`HANDOFF §4.2`](HANDOFF.md:246))

- **Fix.** Gate first alert on `_captureCount ≥ 1 && missionElapsed ≥ 120 s` in [`ConjunctionSystem`](js/systems/ConjunctionSystem.js:61). Force first alert GREEN. Move 2 Codex entries from `CONJUNCTION_WARNING` to `FIRST_CAPTURE` trigger in [`CodexSystem.js:319, 1281`](js/systems/CodexSystem.js:319). Add `[?]` glyph linking to Tech Library entry.
- **Test.** New `test-Conjunction.js`: no alert with `captures = 0`; first alert forced GREEN; delayed ≥ 120 s after first capture.
- **Depends on.** Sprint 3 ST-3.5 (skills-based gates) for cleanest integration — interim: use local `_captureCount` counter.
- **Mode.** `code`. **Effort.** 3–5 h.

### ST-2.2 — Target Analysis panel readability ([`HANDOFF §4.3`](HANDOFF.md:266))

- **Fix.** [`TargetPanel.js:57-60`](js/ui/hud/TargetPanel.js:57): selected row `rgba(0,204,255,0.22)` + inset shadow + 3 px border-left + text-shadow on name. `.hud-panel` bg 0.75 → 0.95. Thicken [`TargetReticle`](js/ui/TargetReticle.js:1) bracket, pulse 0.8 Hz. `.hud-panel--earth-overlap` fallback class.
- **Mode.** `code`. **Effort.** 2–4 h (mostly CSS).

### ST-2.3 — Debris 3-D visual parity ([`HANDOFF §4.1`](HANDOFF.md:223) + [`BIG_PICTURE §6 Phase 1`](BIG_PICTURE.md:366))

- **Fix.** Expose [`DebrisWireframe.buildRocketBody()`](js/ui/DebrisWireframe.js:94) / [`buildDefunctSat()`](js/ui/DebrisWireframe.js:146) / [`buildMissionDebris()`](js/ui/DebrisWireframe.js:213) / [`buildFragment()`](js/ui/DebrisWireframe.js:273) as `getGeometry(type, id) → BufferGeometry`. Replace [`DebrisField._buildInstancedMeshes()`](js/entities/DebrisField.js:444) geometries. Map `material` tag to 5 `MeshStandardMaterial` variants. Clamp tumble ≤ 30°/s effective.
- **Mode.** `code`. **Effort.** 6–10 h.

### ST-2.4 — Lasso visuals → bolas head ([`HANDOFF §4.7`](HANDOFF.md:373) + [`BIG_PICTURE §29.5`](BIG_PICTURE.md:1375))

- **Fix.** Bolas group = torus loop (axis along velocity) + cylinder shaft + two tungsten weights, rotating ~4 Hz. Replace [`LassoSystem.js:107-115`](js/systems/LassoSystem.js:107) projectile. Tether → `TubeGeometry` along `CatmullRomCurve3`. Replace wireframe-sphere ring at [`LassoSystem.js:170-179`](js/systems/LassoSystem.js:170) with 12 radial sparks over 0.4 s. Rename Codex entry per [`§29.5`](BIG_PICTURE.md:1375): *"Bolas. Humans have used weighted cord since the Paleolithic. In Dyneema and vacuum, it still works."*
- **Depends on.** ST-1.2 (speed fix first).
- **Mode.** `code`. **Effort.** 4–6 h.

**Sprint 2 acceptance:** new player can identify debris type by sight at 500 m; conjunction alerts silent in first 2 min; selected target unmistakable on busy field; bolas reads as 3-D object.

---

## Sprint 3 — Tier C Onboarding Redesign (2–4 days)

**Goal.** Eliminate the three-systems-competing debt ([`HANDOFF §4.9.1`](HANDOFF.md:554)) and deliver the checklist-mode discovery pane specified in [`FIRST_EXPERIENCE.md §4.3`](FIRST_EXPERIENCE.md:242) but never built.

### ST-3.1 — Checklist Mode in Discovery Pane ([`HANDOFF §4.9.2 #1`](HANDOFF.md:634))

- **Fix.** In NOVICE level (< 5 discoveries), [`SkillsPane.js`](js/ui/hud/SkillsPane.js:1) renders [`SkillsSystem.getNextSuggestions(3)`](js/systems/SkillsSystem.js:146) as a 3-item checklist. Top discovered shows ✓ for 3 s then dims. Current pulses in tier color. Refresh list on completion. Transition to APPRENTICE pop-in on FIRST_CAPTURE.
- **Mode.** `code`. **Effort.** ~80 LOC, ~4 h.

### ST-3.2 — Delete `TutorialSystem.js` ([`HANDOFF §4.9.2 #2`](HANDOFF.md:657))

- **Action.** Remove [`js/systems/TutorialSystem.js`](js/systems/TutorialSystem.js:1) (752 LOC). Remove bridge hack at [`SkillsSystem.js:82, 215`](js/systems/SkillsSystem.js:82). Audit [`CodexSystem`](js/systems/CodexSystem.js:1) for `TUTORIAL_STAGE_CHANGED` dependencies.
- **Test.** New `test-no-tutorial-legacy.js`: `grep` for `TutorialSystem` import returns 0; no `TUTORIAL_STAGE_CHANGED` emitters outside [`Events.js`](js/core/Events.js:1).
- **Mode.** `code`. **Effort.** ~3 h.

### ST-3.3 — Dormant panel corner-glyph affordance ([`HANDOFF §4.9.2 #3`](HANDOFF.md:668))

- **Fix.** CSS `::after` on `.hud-dormant[data-activate-key]` renders a key-cap glyph. Add `data-activate-key="S"` etc. to each HUD panel; fades on `.hud-active`.
- **Mode.** `code`. **Effort.** ~2 h.

### ST-3.4 — Mastery celebration (PRACTICED + MASTERED) ([`HANDOFF §4.9.2 #4`](HANDOFF.md:673))

- **Fix.** Listener in [`SkillsPane`](js/ui/hud/SkillsPane.js:1) on `SKILL_STATE_CHANGED`: PRACTICED = soft chime + tier-color flash. MASTERED = 3-note arpeggio in [`AudioSystem`](js/systems/AudioSystem.js:1) + edge pulse + centered toast (first 3 masteries only).
- **Test.** Extend [`test-SkillsSystem.js`](js/test/test-SkillsSystem.js:1): MASTERED emits `MASTERY_FANFARE`; first 3 set `largeToast: true`.
- **Mode.** `code`. **Effort.** ~3 h.

### ST-3.5 — Skills-based gates for advanced systems ([`HANDOFF §4.9.2 #5`](HANDOFF.md:681))

- **Fix.** New public API on [`SkillsSystem`](js/systems/SkillsSystem.js:1): `getTotalCatches()`, `getSessionElapsed()`. Migrate gates:
  - [`ConjunctionSystem`](js/systems/ConjunctionSystem.js:360): `totalCatches ≥ 1 && elapsed ≥ 120 s` (finalises ST-2.1)
  - [`KesslerSystem`](js/systems/KesslerSystem.js:1): `missionNumber ≥ 4`
  - [`SpaceWeatherSystem`](js/systems/SpaceWeatherSystem.js:1) + [`ResourceSystem`](js/systems/ResourceSystem.js:1) fuel-mode: `isDiscovered('manage_power')`
- **Test.** Integration: CA silent at `catches = 0`; Kessler silent `mission < 4`.
- **Mode.** `code`. **Effort.** ~4 h.

**Sprint 3 acceptance.** New player reaches first capture in 45–90 s ([`FIRST_EXPERIENCE.md`](FIRST_EXPERIENCE.md:1) goal); Discovery Pane never empty; 3 distinct fanfares after 3 masteries; `grep -r TutorialSystem js/` returns 0 imports.

---

## Sprint 4 — Tier C Mission Operations Model (4–7 days)

**Goal.** Transform *"catch floating stuff"* → *"run a sustained ADR operation"*. Five sub-features, each shippable independently; ship in order A → B → C → D → E.

### ST-4.A — Field-Assay MFD ([`HANDOFF §4.8.3 A`](HANDOFF.md:431))

- **New file.** `js/ui/FieldAssayMFD.js` (~400 LOC). Polls [`DebrisField.getDebrisClusters()`](js/entities/DebrisField.js:1485) every 5 s. Ranks top 5 clusters by:
  ```
  Score = (totalMassKg × varietyBonus × reachable) / (ΔV_in + conjunction_risk)
  ```
  `ΔV_in` via existing [`totalDeltaV()`](js/entities/OrbitalMechanics.js:288). `Shift+A` engages AP on selected cluster (TRAWL heading mode — [`AutopilotSystem.js:576-583`](js/systems/AutopilotSystem.js:576)).
- **Test.** New `test-FieldAssayMFD.js`: score monotonic in `count`; unreachable filtered; sorted desc.
- **Mode.** `code`. **Effort.** ~500 LOC, 1–1.5 days.

### ST-4.B — Station-keeping recoil compensation ([`HANDOFF §4.8.3 B`](HANDOFF.md:458))

- **Fix.** [`AutopilotSystem`](js/systems/AutopilotSystem.js:1) listens for `LASSO_FIRED` / `CROSSBOW_FIRE` / `TRAWL_START` in HOLD; auto-applies opposite [`applyCartesianImpulse`](js/entities/PlayerSatellite.js:2145) of magnitude `m_proj × v_proj / m_player × STATION_KEEP_EFFICIENCY`. New `stationKeepingDeltaV` counter displayed in Field Assay MFD.
- **Constants.** `AUTOPILOT.STATION_KEEP_COMPENSATION = true`, `STATION_KEEP_EFFICIENCY = 0.85`.
- **Test.** Extend [`test-AutopilotSystem.js`](js/test/test-AutopilotSystem.js:1): LASSO_FIRED in HOLD → opposite impulse; toggle disables.
- **Depends on.** Sprint 1 ST-1.1 (correct arm directions required first).
- **Mode.** `code`. **Effort.** ~80 LOC, ~4 h.

### ST-4.C — Mission spawn difficulty profiles ([`HANDOFF §4.8.3 C`](HANDOFF.md:471))

- **Fix.** Extend [`DebrisField._spawnWelcomeField()`](js/entities/DebrisField.js:1) with `missionNumber` branching. Table in new `Constants.MISSIONS.PROFILES`:
  - M1 = welcome field, 1 nearby cluster, no hydrazine, no conjunction
  - M2–3 = +2 clusters, tracked hydrazine tank
  - M4–6 = 4 clusters, scan-revealed untracked, 1 synergy pair
  - M7–9 = 6 clusters + mid-mission Kessler + conjunction
  - M10+ = full random + active sats + weather
- **Event.** Emit `MISSION_START` on each new mission (satisfies tech-debt note at [`HANDOFF §8`](HANDOFF.md:945)).
- **Test.** Extend [`test-DebrisField.js`](js/test/test-DebrisField.js:1): M1 spawns welcome field + 0 hazards; M4+ ≥ 1 Kessler seed; no hydrazine in M1.
- **Mode.** `code`. **Effort.** ~150 LOC, ~6 h.

### ST-4.D — Dynamic mid-mission events ([`HANDOFF §4.8.3 D`](HANDOFF.md:487))

- **Fix.** Wire 5 triggers through existing systems:
  | Trigger | Emits | Effect |
  |---------|-------|--------|
  | `SCAN_DISCOVERY` on hydrazine target | `DEBRIS_HAZARD_REVEALED` | +500 bonus, D_TRAIL → 500 m |
  | `SCAN_DISCOVERY` with synergy-adjacent | `SYNERGY_OPPORTUNITY` | 5-min +300 bonus timer |
  | `KESSLER_CASCADE` in cluster | `CASCADE_THREAT` | Comms + fragments |
  | `WEATHER_EFFECT_START` severe | `WEATHER_MISSION_EFFECT` | Sensor range halved 10 min |
  | Multi-object cluster conjunction | `CLUSTER_CONJUNCTION` | Depart-now comms |
- **Test.** New `test-MissionEvents.js`: scan hydrazine → hazard event; synergy scan → bonus timer.
- **Mode.** `code`. **Effort.** ~200 LOC, ~6 h.

### ST-4.E — Tool-tier efficiency report ([`HANDOFF §4.8.3 E`](HANDOFF.md:502))

- **Fix.** Per-capture-method ΔV tracking in [`ScoringSystem`](js/systems/ScoringSystem.js:1). New panel in [`SweepReportUI`](js/ui/SweepReportUI.js:1): "Capture Efficiency Report" with ΔV/catch per method (Lasso / Spinner / Weaver / Trawl), "most efficient" stars. After M2, Houston says *"Trawl is 90× more efficient than lasso."*
- **Test.** Extend [`test-ScoringSystem.js`](js/test/test-ScoringSystem.js:1): ΔV/catch per method; star to lowest.
- **Mode.** `code`. **Effort.** ~100 LOC, ~3 h.

**Sprint 4 acceptance.** First ORBITAL_VIEW shows Field Assay with ≥ 1 ranked cluster; lasso in HOLD drift ≤ 10 m over 10 s; after M2 Houston has mentioned trawl efficiency; M3+ has ≥ 1 mid-mission event.

---

# Strategic epics (post-Tier-C)

Epics 5–8 correspond to [`BIG_PICTURE §38`](BIG_PICTURE.md:1784) quarterly roadmap. Each is a multi-week body of work — subtask-level detail here; depth documented in BIG_PICTURE.

---

## Epic 5 — Q1 UX Foundation (BIG_PICTURE Part I)

Completes HANDOFF Tier A+B and adds the remaining Part I items that weren't tactical.

| ID | Item | Big-Picture ref | Rough effort |
|----|------|-----------------|--------------|
| ST-5.1 | Comms pane redesign — 6 channels, radial menu, delete center popup | [`§1`](BIG_PICTURE.md:70) | 3–5 days |
| ST-5.2 | Player + arm trail ribbons (I-War heritage) | [`§5`](BIG_PICTURE.md:320) | 2 days |
| ST-5.3 | Earth texture LOD (16k/8k/2k) + FOV 55° + VLEO intro framing + cloud rotation | [`§7`](BIG_PICTURE.md:383) | 1.5 days |
| ST-5.4 | NavSphere stalks + lock-on ring + geolocation readout + velocity arrows | [`§8`](BIG_PICTURE.md:436) | 2 days |

## Epic 6 — Q2 Data, Education & TRL Framing ✅ COMPLETE (Apr 22, 2026)

| ID | Item | Big-Picture ref | Effort |
|----|------|-----------------|--------|
| ✅ ST-6.1 | `/data/*.json` offline catalog (debris, sats, weather, ground stations, constellations) + `CatalogLoader` + hybrid DebrisField + seeded SpaceWeather + active-sat arming guard. **Complete (Apr 21, 2026)** — 174 suites / 930 tests / 0 fail. | [`§2`](BIG_PICTURE.md:147) | 3 days |
| ✅ ST-6.2 | Debris wireframe Phase 2–3 — textures + country flag decals. **Complete (Apr 21, 2026)** — `DebrisTextureAtlas.js` (procedural 6-type Canvas2D atlas), `FlagDecalSystem.js` (15-country flag atlas), `DebrisWireframe.js` atlas statics + UV merge + mode toggle, `DebrisField.js` catalogType threading + atlas material + flag overlays + MOID emissive tint. 200 suites / 1039 tests / 0 fail. | [`§6 Ph2-3`](BIG_PICTURE.md:366) | 2 days |
| ✅ ST-6.3 | MOID computation + `[HI]/[MD]/[LO]` badges + CA speed-up. **Complete (Apr 21, 2026)** — `MoidCalculator.js` (8-pt sampled MOID), `ConjunctionSystem` MOID cache w/ tier de-bounce, `CollisionAvoidanceSystem` MOID prefilter (800→32 objects), TargetPanel/CommsPanel/NavSphere badge rendering. 191 suites / 989 tests / 0 fail. | [`§21`](BIG_PICTURE.md:1059) | 2 days |
| ✅ ST-6.4 | Strategic 3-D Map on `Shift+V` key. **Complete (Apr 22, 2026)** — `StrategicMap.js` (925 LOC: wireframe Earth, 7 altitude-band rings, 800 debris dots colour-coded by catalogType with MOID pulse, player marker + orbit ellipse, AO/radiation hazard zone shells, ground station dots, top-5 threat list DOM overlay, legend/status DOM overlay, mouse orbit controls, separate THREE.Scene), plus 4 pure helpers (`keplerianToOrbitPoints`, `latLonToPosition`, `catalogTypeToColor`, `formatThreatList`), Shift+V/Escape key binding, HUD dimming CSS, teaching moment #15, `Constants.STRATEGIC_MAP` (30 fields), 3 new events. 238 suites / 1158 tests / 0 fail. | [`§4`](BIG_PICTURE.md:280) | 3 days |
| ✅ ST-6.5 | Teaching overlays (first-encounter contextual overlays). **Complete (Apr 22, 2026)** — `TeachingSystem.js` (12→15 teaching moments, EventBus-driven triggers, localStorage persistence), `TeachingOverlay.js` (non-blocking DOM overlay with fade + queue), 1 new event (`SHOP_OPENED`), `Constants.TEACHING` namespace (13 fields). 216 suites / 1075 tests / 0 fail. | [`§19`](BIG_PICTURE.md:1006) | 1.5 days |
| ✅ ST-6.6 | TRL number on every Codex entry, Shop item, tool tooltip. **Complete (Apr 21, 2026)** | [`§25`](BIG_PICTURE.md:1192) | 2 days |
| ✅ ST-6.7 | Environment-effect events (AO, MMOD, safe-mode, radiation belt, battery DOD). **Complete (Apr 22, 2026)** — `EnvironmentSystem.js` (5 hazard effects, seeded MMOD RNG, weather→MMOD synergy, subsystem health model, safe-mode flag on PlayerSatellite, arm deploy gate in ArmManager, 2 teaching moments), `Constants.ENVIRONMENT` (26 fields), 4 new events. 226 suites / 1114 tests / 0 fail. | [`§30-§33`](BIG_PICTURE.md:1389) | 3 days |

## Epic 7 — Q3 Missions + Rendezvous Ladder

| ID | Item | Big-Picture ref | Effort |
|----|------|-----------------|--------|
| ST-7.1 | `MissionSystem` + tier 1–5 missions + `BriefingScreen` cluster picker | [`§3`](BIG_PICTURE.md:210) | 4 days |
| ST-7.2 | ISS Boss event (real TLE, 6-h warning, reward/decline paths) | [`§3.3`](BIG_PICTURE.md:228) | 2 days |
| ST-7.3 | `GroundStationSystem` with pass windows | [`§3.4`](BIG_PICTURE.md:242) | 1.5 days |
| ST-7.4 | Scavenger economy (xenon/hydrazine/GaAs chain) | [`§3.5`](BIG_PICTURE.md:251) | 2 days |
| ST-7.5 | Porkchop plot overlay | [`§20`](BIG_PICTURE.md:1028) | 2 days |
| ST-7.6 | Lambert solver (Izzo) + CW band + cluster countdown | [`§22`](BIG_PICTURE.md:1087), [`§23`](BIG_PICTURE.md:1116), [`§24`](BIG_PICTURE.md:1150) | 3 days |
| ST-7.7 | HUD sensor swap (GPS→RADAR→LIDAR→FLASH→FIDUCIAL→DOCK) | [`§27.3`](BIG_PICTURE.md:1269) | 1 day |

## Epic 8 — Q4 V5 Baseline + Daughter-Arm Redesign + ISRO Heritage ✅ COMPLETE (2026-04-25)

> **Completed 2026-04-25.** 5 sprints, ~6 dev days. Test delta: **+34 suites / +92 tests** (238/1,160 → 272/1,252). 0 regressions.
> All 3 locked design principles honored: ✅ Offline-First, ✅ Dual-Metal FEEP is Y0, ✅ Mother Launches from India.

> **Three locked design principles** (applied across all subtasks):
> 1. **Offline-first** — no auto-fetch APIs, no live TLE feeds, no telemetry. News content via manual `data/news-events.json` edits only.
> 2. **Dual-metal FEEP is Y0 baseline** — multimetal is TRL 7–8 today (Enpulsion IFM Nano flight-demonstrated). Indium + 1 alt metal default.
> 3. **Mother launches from India** — ISRO ground stations (Bangalore ISTRAC + Hassan MCF) join Houston as comms personas.

### Sprint 8.1 — ✅ STATION_KEEP Foundation (1.5 days)

| ID | Item | Ref | Status |
|----|------|-----|--------|
| ✅ ST-8.1.1 | Added `STATION_KEEP` state to `Constants.ARM_STATES` | [`DAUGHTER_ARM_CONTROLS §6`](DAUGHTER_ARM_CONTROLS.md) | Complete |
| ✅ ST-8.1.2 | Added `STATION_KEEP`, `ION_THRUSTER`, `TETHER_TENSION` constant blocks (~50 keys) | [`DAUGHTER_ARM_CONTROLS §5.4`](DAUGHTER_ARM_CONTROLS.md) | Complete |
| ✅ ST-8.1.3 | Added 5 events: `ARM_ORBIT_ADJUST`, `STATION_KEEP_ENTERED/EXITED`, `FEEP_METAL_CHANGED`, `NEWS_EVENT_TRIGGERED` | New events | Complete |
| ✅ ST-8.1.4 | Implemented `_updateStationKeep(dt)` — spherical orbit positioning with lerp, phi/radius clamping, fuel consumption | [`DAUGHTER_ARM_CONTROLS §4.3`](DAUGHTER_ARM_CONTROLS.md) | Complete |
| ✅ ST-8.1.5 | APPROACH → STATION_KEEP transition at standoff distance | [`ArmUnit._updateApproach()`](js/entities/ArmUnit.js:1431) | Complete |
| ✅ ST-8.1.6 | `captureFromStationKeep()` and `recallFromStationKeep()` methods | New | Complete |
| ✅ ST-8.1.7 | Unit tests in [`test-StationKeep.js`](js/test/test-StationKeep.js): state transitions, spherical clamping, tether clearance | New | Complete |

**Implementation notes:** Spherical positioning around debris target uses lerp-based θ/φ interpolation with configurable clamping. Fuel consumption modeled per FEEP metal ISP. Tether tension validated against `TETHER_TENSION` constants.

### Sprint 8.2 — ✅ Orbital-Crane Controls (1 day)

| ID | Item | Ref | Status |
|----|------|-----|--------|
| ✅ ST-8.2.1 | Arrow keys → `ARM_ORBIT_ADJUST` in ARM_PILOT mode during STATION_KEEP | [`DAUGHTER_ARM_CONTROLS §8.2`](DAUGHTER_ARM_CONTROLS.md) | Complete |
| ✅ ST-8.2.2 | +/- for radial distance, Shift for fine mode (¼ rate) | New | Complete |
| ✅ ST-8.2.3 | Context-aware HUD strip: "🛰️ STATION KEEP │ ↑↓←→ Orbit │ +/- Distance │ F Capture │ Shift Fine │ ESC Exit" | [`DAUGHTER_ARM_CONTROLS §8.3`](DAUGHTER_ARM_CONTROLS.md) | Complete |
| ✅ ST-8.2.4 | Camera looks at debris (0.5s lerp blend) during STATION_KEEP | [`DAUGHTER_ARM_CONTROLS §7.1`](DAUGHTER_ARM_CONTROLS.md) | Complete |
| ✅ ST-8.2.5 | F captures from STATION_KEEP, ESC recalls | New | Complete |

**Implementation notes:** Input routing checks ARM_PILOT + STATION_KEEP state before emitting `ARM_ORBIT_ADJUST`. Fine mode (Shift held) applies ¼ multiplier to all rates. Camera lerp uses 0.5s blend to look-at target position.

### Sprint 8.3 — ✅ Dual-Metal FEEP (1.5 days)

| ID | Item | Ref | Status |
|----|------|-----|--------|
| ✅ ST-8.3.1 | `ION_THRUSTER_METALS` lookup: 7 metals (In/Ga/Bi/I/Hg/Cs/W) with ISP, thrust, TRL | [`FINAL_ANALYSIS §4.4`](archive/FINAL_ANALYSIS.md) | Complete |
| ✅ ST-8.3.2 | `_currentMetal`, `_alternateMetal`, `switchMetal()`, `_computeMetalThrust()` on ArmUnit | [`GAME_FLOW_BRAINSTORM §7.2`](GAME_FLOW_BRAINSTORM.md) | Complete |
| ✅ ST-8.3.3 | Metal-specific thrust: `thrust = P_beam / (isp × g0 × η)`, auto-ISP by flight phase | New | Complete |
| ✅ ST-8.3.4 | `FORGE_METAL_YIELDS`: 8 debris types → metal distributions; ForgeSystem propellant mode yields FEEP metals via `refinedMetals` inventory | [`FINAL_ANALYSIS §4.4`](archive/FINAL_ANALYSIS.md) | Complete |
| ✅ ST-8.3.5 | F2 cycles metals; CommsSystem announces with ISP % delta | New | Complete |
| ✅ ST-8.3.6 | 7 Codex entries (PROPULSION category) for FEEP metals | [`CodexSystem.js`](js/systems/CodexSystem.js) | Complete |
| ✅ ST-8.3.7 | Tests in [`test-FEEPMetals.js`](js/test/test-FEEPMetals.js): metal switching, ISP calculation, thrust scaling | New | Complete |

**Implementation notes:** Thrust formula `P_beam / (isp × g0 × η)` gives physically correct thrust per metal. Auto-ISP selects optimal metal per flight phase (TRANSIT/APPROACH/STATION_KEEP/RETURN/DEORBIT). ForgeSystem `refinedMetals` inventory tracks per-metal quantities from debris processing.

### Sprint 8.4 — ✅ News-Driven Missions + ISRO Comms (2 days)

| ID | Item | Ref | Status |
|----|------|-----|--------|
| ✅ ST-8.4.1 | Created [`data/news-events.json`](data/news-events.json): 3 events (AST SpaceMobile tumble, Starlink breakup, Thaicom 4 GEO) | [`FINAL_ANALYSIS §5.2`](archive/FINAL_ANALYSIS.md) | Complete |
| ✅ ST-8.4.2 | Updated [`META.json`](data/META.json) counts | Trivial | Complete |
| ✅ ST-8.4.3 | MissionEventSystem: news loading, capture-count gating, `NEWS_EVENT_TRIGGERED` emission | [`FINAL_ANALYSIS §5.2.B`](archive/FINAL_ANALYSIS.md) | Complete |
| ✅ ST-8.4.4 | News ticker: headline + delayed bounty announcement | New | Complete |
| ✅ ST-8.4.5 | 4 ISRO ground stations in [`ground-stations.json`](data/ground-stations.json): ISTRAC Bangalore, MCF Hassan, SDSC Sriharikota, KSCC Kulasekarapattinam | [`FINAL_ANALYSIS §5A.4`](archive/FINAL_ANALYSIS.md) | Complete |
| ✅ ST-8.4.6 | BANGALORE/HASSAN comms personas → HOUSTON channel, NEWS → MISSION channel; ISRO handoff dialogue | [`FINAL_ANALYSIS §5A.3`](archive/FINAL_ANALYSIS.md) | Complete |
| ✅ ST-8.4.7 | 7 Codex entries: 3 news (NEWS category) + 4 ISRO heritage (HERITAGE category); 2 new CodexCategory values | [`FINAL_ANALYSIS §5A.5`](archive/FINAL_ANALYSIS.md) | Complete |
| ✅ ST-8.4.8 | [`ReputationSystem.js`](js/systems/ReputationSystem.js): 5 partners (USA/SpaceX/Thailand/ESA/India), 4 tiers, event-driven rep tracking | [`FINAL_ANALYSIS §5.2.D`](archive/FINAL_ANALYSIS.md) | Complete |
| ✅ ST-8.4.9 | Tests in [`test-NewsEvents-epic8.js`](js/test/test-NewsEvents-epic8.js) + [`test-CodexISRO.js`](js/test/test-CodexISRO.js) | New | Complete |

**Implementation notes:** News events are static JSON (offline-first), gated by capture count. ReputationSystem tracks 5 partners with 4 tiers (NEUTRAL/FRIENDLY/ALLIED/PARTNER). ISRO handoff dialogue: "Houston: handing off to Bangalore ISTRAC — good hunting." India starts at rep=30 (highest, reflecting ISRO launch heritage).

### Sprint 8.5 — ✅ Polish & Integration (1 day)

| ID | Item | Ref | Status |
|----|------|-----|--------|
| ✅ ST-8.5.1 | DockingReticle: standoff wireframe sphere (0x00ffaa, 15% opacity) + θ/φ/R canvas readout + range bar | [`DAUGHTER_ARM_CONTROLS §11`](DAUGHTER_ARM_CONTROLS.md) | Complete |
| ✅ ST-8.5.2 | NavSphere: amber diamond markers for sibling deployed arms during ARM_PILOT | New | Complete |
| ✅ ST-8.5.3 | Full test pass: 272 suites / 1,252 tests / 0 failures | Critical | Complete |
| ✅ ST-8.5.4 | Updated [`README.md`](README.md), [`HANDOFF.md`](HANDOFF.md), this file | Doc maintenance | Complete |
| ✅ ST-8.5.5 | Updated [`BIG_PICTURE.md §36`](BIG_PICTURE.md) Tech Ladder — moved dual-metal FEEP from Y4 to Y0 | TRL correction | Complete |

**Implementation notes:** Standoff sphere renders as wireframe with 15% opacity green (#00ffaa). Canvas readout shows θ/φ/R in real-time. NavSphere amber diamonds use same marker system as existing target indicators but with distinct color for sibling awareness.

### Original Epic 8 Items (Deferred to Epic 9 / Q4)

The following are **postponed** to a future Epic 9 (V5 Hardware Baseline) — the daughter-arm redesign + dual-metal FEEP work takes precedence as it directly responds to playtester feedback:

> **2026-04-26: ST-9.4 re-scoped.** Original "LassoSystem → BolaSystem rename" framing was incorrect on both terminology and behaviour. Canonical name is **Capture Net** (fishing theme, not bola/lasso). Full design doc created: [`CAPTURE_NET.md`](CAPTURE_NET.md) — covers cling mechanism, tangle mechanics, fragmentation prevention, and per-platform net classes (Large Net / Medium Net / Small Net). Effort raised 2d → 4d, split into 5 sub-tasks (ST-9.4a–e). Three new feature flags defined: `NET_CLING_MODEL`, `NET_TANGLE_MECHANICS`, `PER_PLATFORM_NETS`.
>
> - 2026-04-26: ST-9.4 design Rev 4 finalized. CAPTURE_NET.md §10 closed.
>   All 12 QA decisions ✓ + mercy rule ✓. CAPTURE_NET_QA.md retained as audit trail.
> - 2026-04-26: ST-9.4a complete. Constants.FEATURE_FLAGS expanded to 14:
>   BOLA_RENAME→NET_TERMINOLOGY rename + NET_CLING_MODEL/NET_TANGLE_MECHANICS/PER_PLATFORM_NETS
>   added (all default false). Test count: 274→275 suites / 1,263→1,267 tests / 0 failures.

| ID | Item | Big-Picture ref | Effort | Status |
|----|------|-----------------|--------|--------|
| ST-9.1 | `Constants.OCTOPUS_V5` block — **Config G values** per [`§10.12`](ARM_PIVOT_ANALYSIS.md:1417) | [`§11`](BIG_PICTURE.md:646) | 1 day | Ready |
| ST-9.2 | **Config G Geometry: Top-Collar 3-Plane Layout** (re-spec'd 2026-04-27; was equatorial) | [`ARM_PIVOT_ANALYSIS.md §10.11`](ARM_PIVOT_ANALYSIS.md:1236) | 2 days | Ready |
| ST-9.3 | **Crossbow: 0–180° Sweep + Lockable Hinge + Semi-Auto Aim + Dual-Fire** (re-spec'd 2026-04-27; was ±30° yaw) | [`ARM_PIVOT_ANALYSIS.md §10`](ARM_PIVOT_ANALYSIS.md:801), [`ARM_PIVOT_GAPS_EXPLAINER.md §W`](archive/ARM_PIVOT_GAPS_EXPLAINER.md) | 4 days | Ready |
| ST-9.4 | **Capture Net System** — see [`CAPTURE_NET.md`](CAPTURE_NET.md) | [`§29`](BIG_PICTURE.md:922), [`CAPTURE_NET.md`](CAPTURE_NET.md) | 4 days | Ready |
| ST-9.5 | Dyneema SK78 tether + reel-cycle resource — **reel on strut tip** (Config G) | [`§28.3`](BIG_PICTURE.md:1310), [`ARM_PIVOT_ANALYSIS.md §10.4`](ARM_PIVOT_ANALYSIS.md:934) | 2 days | Ready |
| ST-9.6 | ~~Mother-mounted ablation module~~ | [`§16`](BIG_PICTURE.md:909) | ~~2 days~~ | **DEFERRED → Epic 10** |
| ST-9.7 | Tether exit geometry — **simplified for Config G** (no Y-harness, no bridle) | [`ARM_PIVOT_ANALYSIS.md §10.4`](ARM_PIVOT_ANALYSIS.md:934) | 0.5 day | Ready |
| ST-9.8 | Technology Upgrade Ladder via Shop + Codex + HOUSTON | [`§36`](BIG_PICTURE.md:1706), [`CROSSBOW_ARMS.md §25`](CROSSBOW_ARMS.md) | 3 days | Ready |
| ST-9.9 | ~~Reality Mode toggle~~ | [`§36.4`](BIG_PICTURE.md:1737) | ~~0.5 day~~ | **DEFERRED → Epic 10** |
| **ST-9.10** | **Stow/Deploy State Machine** (gap #4) | [`ARM_PIVOT_GAPS_EXPLAINER.md §W`](archive/ARM_PIVOT_GAPS_EXPLAINER.md) | 2 days | **NEW** |
| **ST-9.11** | **Launch Locks + ROSA Deploy Cinematic** (gap #7) | [`ARM_PIVOT_ANALYSIS.md §10.14`](ARM_PIVOT_ANALYSIS.md:1642), [`§10.16`](ARM_PIVOT_ANALYSIS.md:1810) | 1.5 days | **NEW** |
| **ST-9.12** | **CoM Tracking + Thruster Plume Interlock** (gaps #5, #8) | [`ARM_PIVOT_GAPS_EXPLAINER.md §W`](archive/ARM_PIVOT_GAPS_EXPLAINER.md) | 1.5 days | **NEW** |

#### ST-9.2 Detailed Spec (Config G — 2026-04-27) ⚠️ SUPERSEDES Rev 5 EQUATORIAL SPEC

```
ST-9.2 — Config G Geometry: Top-Collar 3-Plane Layout
  Effort: 2 days
  Files: js/entities/ArmManager.js, js/core/Constants.js
  Description:
    - REWRITE generateDockPositions() for top-collar mount:
      All arms hinge at COLLAR_Y (+0.90m from barrel center), not Y=0.
      Y0 Quad: 4 struts at azimuths [60°, 120°, 240°, 300°] per §10.11.
      Y1 Hex: 6 struts at [30°, 90°, 150°, 210°, 270°, 330°].
      Y3 Octo: 6 ring + 2 F/B on end faces (+Z, -Z).
    - dockOutward is now the MERIDIAN SWING DIRECTION (not radial in XZ plane).
      Each strut swings in the plane defined by the Y-axis and the strut's azimuth.
    - Strut tip position = collar + STRUT_LENGTH × swing_direction(alpha).
    - Antipodal pairs: arms at θ and θ+180° (e.g., 60° ↔ 240°).
    - Config G mass budget (§10.11 canonical — NOT old 198.4/244.4):
        Y0: dry=196.4, wet=242.4
        Y1: dry=~208, wet=~254
        Y3: dry=~222, wet=~268
    - ARM_LADDER block with Y0/Y1/Y3 entries.
    - Persist active tier via PersistenceManager (default Y0).
    - 3-plane layout: ROSA panels at 0°/180°, arms at 60°/120°/240°/300°.
  Source: ARM_PIVOT_ANALYSIS.md §10.11 (locked dimensions), §10.12 (Constants block)
  Acceptance:
    - generateDockPositions(4) returns 4 positions at collar height with correct azimuths.
    - All 3 tiers generate valid positions and antipodal pairs.
    - Default Y0 fleet = 1M + 2LD + 2SD.
    - Mass budget: Y0 dry=196.4±0.1 kg, wet=242.4±0.1 kg.
    - 0 regressions; test-Crossbow-Constants.js updated for Config G values.
```

#### ST-9.3 Detailed Spec (Config G — 2026-04-27) ⚠️ SUPERSEDES Rev 5 YAW-ONLY SPEC

```
ST-9.3 — Crossbow: 0–180° Meridian Sweep + Lockable Hinge
         + Semi-Auto Aim Rotation + Dual-Fire + Paired-Fire Coordination
  Effort: 4 days (was 2.5 — extended by gap items #9, #13, #14)
  Files: js/entities/ArmUnit.js, js/entities/ArmManager.js,
         js/systems/AutopilotSystem.js, js/ui/NavSphere.js, js/ui/HUD.js
  Strut DOF: 0–180° meridian sweep (NOT ±30° yaw). Config G barrel-axial hinge.
  Description:
    - ArmUnit.setAimAlpha(alpha): 0–180° meridian sweep.
      0° = stowed (alongside barrel), 90° = equatorial, 180° = zenith.
      Slew rate: STRUT_SLEW_RATE (30°/s per §10.12).
      API REPLACES setAimYaw(yaw) from Rev 5.
    - LOCKABLE HINGE (gap #9):
      Hinge states: ROTATE (motor drives, brake off) ↔ LOCKED (brake on, motor off).
      Lock before crossbow fire; unlock for aim adjustment; lock during capture/reel.
      Constants: HINGE_LOCK_TORQUE: 1000 N·m, HINGE_MOTOR_TORQUE: 10 N·m.
    - SEMI-AUTO AIM ROTATION (gap #13):
      AutopilotSystem.requestAimRotation(targetDir) → Promise<void>.
      Player presses Fire → system decomposes target into (Mother rotation, strut alpha).
      Mother rotates via RCS; strut sweeps to alpha. Both converge.
      Crossbow fires automatically when |ω| < 0.5°/s AND angular error < 1°.
      HOUSTON: "Rotating to firing attitude — [N] seconds."
      NavSphere: dashed aim arc during rotation.
      Cancel: ESC aborts rotation. Timeout: 30 s.
      RCS cost: ~5.5g N₂ per 30° rotation.
      HIGH RECOIL indicator: show amber on NavSphere if α < 30° or α > 150°.
    - Spring physics: E = ½kd², v = √(2E/m).
    - DUAL-FIRE + PAIRED-FIRE (gap #14):
      ArmManager.getDualFirePair(armIndex) → antipodal partner index.
      ArmManager.getNextDeployRecommendation() → suggests antipodal partner.
      Dual-fire enabled only when both arms of ≥1 pair are deployed.
      UI hint: "Deploy opposing arm for balanced fire."
    - RCS recoil compensation on every fire (non-zero for Config G).
    - Safety interlock: block fire when ω_mother > 0.5°/s.
    - Aim decomposition utility: decomposeAimTarget(targetDir, armPairAngles)
      → { pairIndex, motherRotation, strutAlpha }
  Constants:
    - CROSSBOW_AIM_ALPHA_MAX: Math.PI (replaces CROSSBOW_AIM_YAW_MAX)
    - STRUT_SLEW_RATE: 30°/s (replaces CROSSBOW_AIM_RATE)
    - CROSSBOW_AIM_YAW_MAX → REMOVED
  Source: ARM_PIVOT_ANALYSIS.md §10, ARM_PIVOT_GAPS_EXPLAINER.md §W + §V-2 + §V-5
  Acceptance:
    - setAimAlpha(0) = stowed; setAimAlpha(π/2) = equatorial; setAimAlpha(π) = zenith.
    - Hinge locks during GRAPPLED/REELING states.
    - Semi-auto: fire at off-plane target → Mother rotates → crossbow fires on alignment.
    - Dual-fire gate: only enabled when antipodal pair both deployed.
    - Deploy recommendation: suggests partner of last deployed arm.
    - RCS compensation: Mother ΔV < 0.05 m/s after compensation.
    - Pre-fire interlock: fire blocked when ω > 0.5°/s.
    - HIGH RECOIL indicator visible when α < 30° or > 150°.
    - 0 regressions; test-Crossbow-ArmUnit.js rewritten for Config G.
```

#### ST-9.8 Arm-Tier Upgrade Entries (Appended 2026-04-26)

```
ST-9.8 (continued) — Tech Ladder must include arm-count upgrade entries:
  - Y1 Hex Refit: unlocks Hex (6 arms) layout. Requires shipyard docking + Y1 credits.
    Shop entry: "Hex Configuration Refit — adds 1 Large Daughter + 1 Small Daughter.
    Requires: Shipyard docking, 5000 credits, 30+ mission hours."
  - Y3 Octo Refit: unlocks Octo (8 arms) layout. Requires Y1 unlocked + Y3 credits.
    NOTE (2026-04-27): Ablation module prereq SOFTENED — ST-9.6 deferred to Epic 10.
    Gate Y3 behind FEATURE_FLAGS.ABLATION_MODULE (false by default) so prereq can be
    re-enabled when ablation ships. For now, Y3 unlock requires credits + hours only.
    Shop entry: "Octo Configuration Refit — adds Front + Back arms, completes the Octopus.
    Requires: Hex refit, Shipyard docking, 15000 credits, 300+ mission hours."
  HOUSTON announcement on Y3 unlock: "Octopus-class is fully operational."
  Codex entry on Y3: "The name was always aspirational — start with four arms,
  earn the full eight. The Octopus has arrived."
```

#### ST-9.4 Sub-Tasks (Re-scoped 2026-04-26)

Original "rename" framing was wrong — see [`CAPTURE_NET.md`](CAPTURE_NET.md) for the full Capture Net design (cling, tangle, fragmentation, per-platform M-NET/LD-NET/SD-NET classes). Effort raised 2d → 4d.

```
ST-9.4 — Capture Net System (was: LassoSystem → BolaSystem rename)
  Effort: 4 days (was 2)
  Sub-tasks:
    ST-9.4a  Flag rename in Constants (BOLA_RENAME → NET_TERMINOLOGY)
             + design-doc cross-reference. (0.25d)
    ST-9.4b  LassoSystem → CaptureNetSystem terminology refit
             (file alias, BOLA_*/NET_* getters, Codex copy update,
              backward-compat alias module). (1d)
    ST-9.4c  Cling probability model + empty-net failure path
             (per CAPTURE_NET.md §3). (1d)
             + First-Fragmentation Mercy Rule:
               - Persist `playerHasFragmented: bool` (default false) via PersistenceManager.
               - On first fragmentation event in player's lifetime: waive all penalties
                 (no Kessler injection, no reputation hit, no credit deduction).
               - Instead: emit HOUSTON warning comms ("First miss is on us. Next one costs.")
                 + TeachingSystem tip explaining frag mechanics.
               - Set flag true; from second event onward apply full consequences per §5.
             + Spring-hub single-fire safety: spec 3× force margin + limit-switch confirm sensor.
             + Solenoid EMI cross-talk: stagger node fire 10 ms/node.
             + Pre-fire P_cling calc must run ≤1 ms/frame.
    ST-9.4d  Tangle detection + recovery (per CAPTURE_NET.md §4,
              5 scenarios, gated by FEATURE_FLAGS.NET_TANGLE_MECHANICS). (1d)
    ST-9.4e  Per-platform net classes M-NET / LD-NET / SD-NET
             (per CAPTURE_NET.md §6, gated by FEATURE_FLAGS.PER_PLATFORM_NETS). (0.75d)

  All sub-tasks gate behind FEATURE_FLAGS so default Y0 play remains
  unchanged from ST-9.1 baseline.
```

**New feature flags to add in ST-9.4a** (alongside the `BOLA_RENAME → NET_TERMINOLOGY` rename):
- `FEATURE_FLAGS.NET_CLING_MODEL` — enables §3 cling probability system (default `false`)
- `FEATURE_FLAGS.NET_TANGLE_MECHANICS` — enables §4 tangle scenarios (default `false`)
- `FEATURE_FLAGS.PER_PLATFORM_NETS` — enables §6 M-NET/LD-NET/SD-NET class selection (default `false`)

Existing flags retained: `NET_TERMINOLOGY` (renamed from `BOLA_RENAME`), `NET_PRIMARY_DOCTRINE`.

#### ST-9.10 Detailed Spec (New — 2026-04-27, gap #4)

```
ST-9.10 — Arm Stow/Deploy State Machine
  Effort: 2 days
  Files: js/entities/ArmUnit.js, js/entities/ArmManager.js,
         js/systems/AutopilotSystem.js, js/systems/EnvironmentSystem.js
  Description:
    - Add ArmUnit.deployState enum: LOCKED | STOWED | DEPLOYING | DEPLOYED | STOWING.
      This is SEPARATE from ArmUnit.state (operational: DOCKED, LAUNCHING, etc.).
      See ARM_PIVOT_GAPS_EXPLAINER.md §V-3 for dual-state-machine design.
    - Initial state: LOCKED (for launch lock cinematic in ST-9.11).
    - After pyro event: transition to STOWED.
    - Deploy: STOWED → DEPLOYING → DEPLOYED (hinge swings to target α).
    - Stow: DEPLOYED → STOWING → STOWED (hinge returns to α=0).
    - Auto-stow triggers: Hall burn, Safe Mode, docking approach.
    - Gate rules: crossbow fire requires DEPLOYED; stow requires state=DOCKED.
  Source: ARM_PIVOT_GAPS_EXPLAINER.md §W (ST-9.10 spec), §V-3 (dual state machine)
  Depends on: ST-9.2 (geometry), ST-9.3 (hinge)
  Acceptance:
    - Arms start LOCKED; transition to STOWED after pyro event.
    - Deploy/stow commands animate strut swing.
    - Crossbow blocked when not DEPLOYED.
    - Hall burn auto-stows deployed arms.
    - 4+ unit tests in test-ArmDeployState.js.
```

#### ST-9.11 Detailed Spec (New — 2026-04-27, gap #7)

```
ST-9.11 — Launch Lock Release + ROSA Deployment Cinematic
  Effort: 1.5 days
  Files: js/entities/ArmManager.js, js/entities/PlayerSatellite.js,
         js/systems/CommsSystem.js, js/core/Events.js, js/core/Constants.js
  Description:
    - First mission start: play deployment sequence per §10.14/§10.16:
      T+0: "SSLV separation confirmed."
      T+5s: RCS stabilization visual.
      T+10s: ROSA deploy — golden panels unfurl along barrel axis.
        HOUSTON: "Solar arrays nominal. 2,240 watts."
      T+40s: Pyro pins fire. HOUSTON: "Arms free. Ready for operations."
        Arms transition LOCKED → STOWED (requires ST-9.10).
    - Constants: LAUNCH_SEQUENCE_ENABLED: true, LAUNCH_PYRO_DELAY: 40.
    - Event: LAUNCH_SEQUENCE_COMPLETE.
    - Persist: launchSequencePlayed flag (runs once per save).
    - Skip: any key after T+5s skips cinematic.
  Source: ARM_PIVOT_ANALYSIS.md §10.14 (launch locks), §10.16 (ROSA deploy mechanism),
          §10.16 game visual sequence description
  Depends on: ST-9.10 (LOCKED state), ST-9.2 (barrel model)
  Acceptance:
    - New game starts with cinematic. HOUSTON comms at each step.
    - ROSA panels visible after deploy.
    - Arms in STOWED state after pyro event.
    - Skippable. Runs once per save.
    - 2+ unit tests.
```

#### ST-9.12 Detailed Spec (New — 2026-04-27, gaps #5 + #8)

```
ST-9.12 — Center-of-Mass Tracking + Thruster Plume Interlock
  Effort: 1.5 days
  Files: js/entities/ArmManager.js, js/systems/AutopilotSystem.js,
         js/ui/HUD.js, js/core/Constants.js
  Description:
    - CoM tracking (gap #5):
      Compute CoM offset on arm state change: Σ(strut_mass × tip_position) / total_mass.
      Store as ArmManager.comOffset (Vector3).
      Feed into AutopilotSystem as persistent torque correction.
      HUD: "ATTITUDE DRIFT" amber if |comOffset| > 20mm.
      HUD: "BALANCED" green if |comOffset| < 5mm.
    - Thruster plume interlock (gap #8):
      Config G: nearest arm plane 60° from thrust axis, plume cone 35°.
      Minimum clearance: 25°. Normally no intersection.
      Edge case: strut at α > 150° AND azimuth within 35° of thrust axis → auto-stow.
      Document clearance analysis as Constants comment.
    - Constants: COM_DRIFT_WARN_THRESHOLD: 0.020, COM_BALANCED_THRESHOLD: 0.005,
      PLUME_HALF_ANGLE: 35° (in radians).
  Source: ARM_PIVOT_GAPS_EXPLAINER.md §W (ST-9.12 spec), §V-2 (recoil budget)
  Depends on: ST-9.3 (alpha tracking), ST-9.10 (deploy state)
  Acceptance:
    - Symmetric deploy → comOffset ≈ 0. Single arm → expected offset.
    - "ATTITUDE DRIFT" warning on asymmetric deploy.
    - Hall burn with strut at α=170° near thrust axis → auto-stow.
    - 3+ unit tests.
```

### Epic 8 Completion Summary

**Actual effort: ~6 days** (Sprints 8.1–8.5). **Final test suite: 272 suites / 1,252 tests / 0 failures** (target was 250+/1,250+). ✅ Target exceeded.

#### New Constants Namespaces Added (Epic 8)
- `Constants.ION_THRUSTER` — FEEP thruster parameters, metal lookup
- `Constants.ION_THRUSTER_METALS` — 7 metals with ISP, thrust, TRL data
- `Constants.STATION_KEEP` — standoff distance, orbit rates, clamping
- `Constants.TETHER_TENSION` — tension thresholds, warning levels
- `Constants.FORGE_METAL_YIELDS` — 8 debris types → metal distributions

#### New Events Added (Epic 8)
- `ARM_ORBIT_ADJUST` — orbit adjustment input in STATION_KEEP
- `STATION_KEEP_ENTERED` / `STATION_KEEP_EXITED` — state transitions
- `FEEP_METAL_CHANGED` — metal switch notification
- `NEWS_EVENT_TRIGGERED` — news-driven mission activation

#### New Test Files Added (Epic 8)
- [`test-StationKeep.js`](js/test/test-StationKeep.js) — STATION_KEEP state machine, spherical positioning
- [`test-FEEPMetals.js`](js/test/test-FEEPMetals.js) — Metal switching, ISP math, thrust scaling
- [`test-NewsEvents-epic8.js`](js/test/test-NewsEvents-epic8.js) — News event spawn, capture gating
- [`test-CodexISRO.js`](js/test/test-CodexISRO.js) — ISRO heritage Codex entries validation

#### New Keybind Map (Epic 8)
| Key | Action | Context |
|-----|--------|---------|
| ↑↓←→ | Orbit debris θ/φ | ARM_PILOT + STATION_KEEP |
| +/- | Adjust standoff distance | ARM_PILOT + STATION_KEEP |
| Shift | Fine mode (¼ rates) | ARM_PILOT + STATION_KEEP |
| F | Capture from STATION_KEEP | ARM_PILOT + STATION_KEEP |
| F2 | Cycle FEEP metal on piloted arm | ARM_PILOT |
| ESC | Recall from STATION_KEEP | ARM_PILOT + STATION_KEEP |

---

## Cross-Cutting Rules

Every subtask inherits these from [`HANDOFF §9 THREE.js SSOT`](HANDOFF.md:1), [`§10 Post-Cinch Learnings`](HANDOFF.md:1), and [`§11 Architectural Gotchas`](HANDOFF.md:1):

1. **Y-up (Three.js) vs Z-up (ECI)** — use [`cartesianToKeplerian()`](js/entities/OrbitalMechanics.js:129) (corrected); do not write parallel versions. See [`HANDOFF §11.1`](HANDOFF.md:1).
2. **`TIME_SCALE_GAMEPLAY` silent multiplier** — any physics-per-tick must multiply `dt * TIME_SCALE_GAMEPLAY`; factor-of-10 bug = suspect this. See [`HANDOFF §11.2`](HANDOFF.md:1).
3. **`applyCartesianImpulse` vs `_applyThrust`** — world-frame ΔV → the new API at [`PlayerSatellite.applyCartesianImpulse()`](js/entities/PlayerSatellite.js:2145); orbital-element rates → the legacy one. See [`HANDOFF §11.3`](HANDOFF.md:1).
4. **CA exemption** — any pursuit system emits `AUTOPILOT_TARGET_LOCK` or equivalent so [`CollisionAvoidanceSystem`](js/systems/CollisionAvoidanceSystem.js:1) stops fighting it. See [`HANDOFF §11.4`](HANDOFF.md:1).
5. **Scene scale `M = 1e-5`** — distances in metres in Constants; multiply by `M` at the rendering boundary. See [`HANDOFF §11.6`](HANDOFF.md:1).
6. **Constants-first refactors** — hoist every magic number to [`Constants.js`](js/core/Constants.js:1) with a named comment. Example: `Constants.RENDER_ORDER`, `Constants.TETHER_ROTATION`, `Constants.TARGET_RANKING` — all landed this sprint.
7. **Regression test per bug** — inverse-consistency tests for physics helpers; integration > stubs; `grep TIME_SCALE_GAMEPLAY|gameDt` to catch omissions. See [`HANDOFF §11.5`](HANDOFF.md:1).
8. **Test suite must stay green** — current **556 suites / 2,364 tests / 0 failures** (post-4-fix sprint, 2026-05-30). Every sprint must land green.
9. **(NEW 2026-05-30) RENDER_ORDER convention** — every mesh in a spacecraft hierarchy declares `renderOrder` from the [`RENDER_ORDER`](js/core/Constants.js:1) 6-tier enum. `polygonOffset` is a finer-grained tool but cannot order across transparency passes. See [`HANDOFF §9 Rule 6`](HANDOFF.md:1).
10. **(NEW 2026-05-30) Inline ARM_STATES checks → named predicates** — any `state === A || state === B || ...` over ARM_STATES is a code smell; promote to a named predicate on [`ArmManager`](js/entities/ArmManager.js:1) ([`hasTetheredArm()`](js/entities/ArmManager.js:1), [`getRotationLockTier()`](js/entities/ArmManager.js:1) already exist; two known remaining inline sites at [`AutopilotSystem.js:697`](js/systems/AutopilotSystem.js:697) and [`RadialMenu.js:306`](js/ui/hud/RadialMenu.js:306)). See [`HANDOFF §11.8`](HANDOFF.md:1).
11. **(NEW 2026-05-30) GL_LINES has no face culling** — for wireframes that must hide on back-facing surfaces, use a custom ShaderMaterial with view-dot-normal discard at fragment level. `side: FrontSide` does NOT cull line primitives. See [`HANDOFF §9 Rule 7`](HANDOFF.md:1).
12. **(NEW 2026-05-30) `ShapeGeometry` cannot split into material groups** — single contiguous face range. For front/back material splits (e.g., ROSA panel PV vs Kapton), use **two coincident meshes** sharing the same geometry instance — one `FrontSide`, one `BackSide` with cloned flipped-normal geometry. See [`HANDOFF §9 Rule 4`](HANDOFF.md:1).

---

## Dependency Graph

```
Sprint 1 (bugs) ───┬─→ Sprint 2 (UX) ───┬─→ Sprint 3 (onboarding) ──┐
ST-1.1 arm dir ────┼──→ ST-4.B recoil                                │
ST-1.2 lasso spd ──┼──→ ST-2.4 bolas                                 │
ST-1.4 tether ─────┘                                                 │
                                                                     │
Sprint 3 ST-3.5 skills-gates ──finalises──→ ST-2.1 conjunction       │
                                                                     ▼
                            Sprint 4 (mission ops A→E) ──→ Epics 5-8
                                                              │
    Epic 6 ST-6.1 data catalog ──unblocks──→ Epic 7 ST-7.1 missions
    Epic 6 ST-6.3 MOID         ──unblocks──→ Epic 7 ST-7.5 porkchop
    Epic 7 ST-7.5/7.6          ──unblocks──→ Epic 8 ST-8.6 ablation

──────────────────── 2026-05-30 four-fix sprint complete ────────────────────

Post-Sprint Polish (2026-06):
    ST-PS.2 test-TargetRanking ──┬─→ ST-PS.4 TPI in AP
                                  └─→ ST-PS.7 dynamic DIST_REF_KM
    ST-PS.1 setThrusterFire ─────→ ST-PS.6 teaching moment
    ST-PS.3 SpacecraftMaterials ── (independent)
    ST-PS.5 RENDER_ORDER extend ── (independent)
```

Hard blockers (from [`BIG_PICTURE §37`](BIG_PICTURE.md:1745)):
- §3 missions ← §2 data catalog (ISS TLE)
- §6 flag decals ← §2 (owner_country)
- §19 teaching map ← §5 trails + §21 MOID + §22 Lambert
- §14 / Epic 8 ← §11 Constants block

Feature-flag-conditional blockers (from [`HANDOFF §6`](HANDOFF.md:1)):
- When `TETHER_REEL` flag flips ON: [`ArmManager.getRotationLockTier()`](js/entities/ArmManager.js:1) must consult reel-cut state before any new rotation-blocked work
- When `STOW_DEPLOY_STATE_MACHINE` flag flips ON: deploy-state × arm-state cross-product needs audit in rotation tier mapping

---

## Delegation Model

The orchestrator should spawn subtasks in this cadence:

| Phase | Parallelisable? | Mode | Notes |
|-------|-----------------|------|-------|
| Sprint 1 (4 items) | Yes — ST-1.1/1.2/1.4 independent; ST-1.3 after 1.2 | `code` | Tight 1-day scope ✅ Done |
| Sprint 2 (4 items) | Yes — ST-2.2/2.3 independent; ST-2.4 after ST-1.2 | `code` | Visual pass ✅ Done |
| Sprint 3 (5 items) | Partial — ST-3.2 first (removes coupling), then rest parallel | `code` + `debug` | Watch test gates ✅ Done |
| Sprint 4 (5 items) | Sequential A→B→C→D→E; each shippable | `code` | Each is its own PR ✅ Done |
| Epics 5–8 | Per-quarter; run multiple subtasks in parallel within a quarter | `architect` for design, `code` for impl, `project-research` when new surface areas need scoping | Multi-week ✅ Epics 5/6/8 done; Epic 7 pending; Epic 9/10 done |
| **Post-Sprint Polish (7 items)** | **Yes — 3 parallel tracks (PS.2/4/7 · PS.1/6 · PS.3/5)** | **`code` (all)** | **~1.5 days total. See [▶ NEXT](#-next-post-sprint-polish--architecture-2026-06).** |

Recommended `new_task` pattern per subtask: include (a) the ST-ID, (b) the HANDOFF/BIG_PICTURE cite, (c) file/line targets, (d) acceptance criterion, (e) test requirement, (f) cross-cutting rule checklist.

---

*Plan owner: Architect. Current focus: Post-Sprint Polish (2026-06) — see [▶ NEXT](#-next-post-sprint-polish--architecture-2026-06). Sources: [`HANDOFF.md`](HANDOFF.md:1), [`BIG_PICTURE.md`](BIG_PICTURE.md:1), [`archive/FIX_PLAN.md`](archive/FIX_PLAN.md:1).*
