# Space Cowboy — Forward Roadmap

> **The prioritized plan to take the sim from "great sandbox loop" to "complete 12-mission arc."** Written against code ground-truth (2026-06-07 architect pass — see [`ARCHITECTURE.md`](ARCHITECTURE.md)). Read [`HANDOFF.md`](HANDOFF.md) §9–§11 (load-bearing SSOT) before touching orientation/FSM/capture/visual code.
>
> Every item has **Risk** (chance of breaking things / unknowns) and **Burden** (engineering effort). Burden scale: **S** ≤ ½ day · **M** 1–2 days · **L** 3–5 days · **XL** > 1 week.

---

## 0. The big picture in one paragraph

Three loops nest cleanly: **tactical** (scan→target→approach→capture, seconds, FEEP fuel), **operational** (tool choice, detumble, forge, plate-spinning, minutes, ΔV), **strategic** (cluster/orbit selection, tech ladder, sessions, time + reputation). The tool ladder = difficulty ladder = curriculum = TRL tech tree (one progression vector, four payoffs). The destination is the VLEO→GEO climb to a 10,000 kg space-elevator anchor. **The loops are coherent in design; what's missing in code is the connective tissue.** Three moves turn the whole thing on: (1) make tool choice real, (2) give clusters/transfers agency + teaching, (3) build the mission-arc coaching spine.

---

## 1. The critical path (do these first, in order)

These are the load-bearing moves. Each unlocks downstream value far beyond its own scope.

### CP-1 — Make tool choice real: wire the multi-tool (magnet first)
**Why first.** Today tool choice = lasso/net/trawl. The net is differentiated (Weaver MEDIUM / Spinner SMALL + cling physics) but the *decision* "this target needs a different tool" doesn't exist. This is the hinge that turns the tactical loop from "deploy → win" into "inspect → choose → commit" — which is the premise of failure-mode learning, the inspect-before-fire doctrine, and most of the delight. Build per [`DAUGHTER_MULTITOOL_SPEC.md`](DAUGHTER_MULTITOOL_SPEC.md) phases: P1 net (done) → **P2 magnet (✅ DONE)** → **P3 gripper (✅ DONE)** → **P4 pad (✅ DONE)** — CP-1 complete 2026-06-07.
**✅ P2 shipped (2026-06-07).** `DAUGHTER_MULTITOOL` flag ON; `ARM_STATES.MAGNETIC_GRAPPLE` (ENERGIZING→CLOSING→GRIP sub-FSM); pure `ToolRecommender` (steel hull → ▶MAGNET ★★★, fastener-only/non-ferrous → net stays primary, graceful degradation on absent flags); SK tool-selection HUD panel; backtick-cycle in SK + F-dispatch-by-selected; steel material added to the debris pool + `ferromagnetic`/`hasFerrousFasteners` derivations; CA exemption via `AUTOPILOT_TARGET_LOCK`.
**✅ P3 + P4 shipped (2026-06-07).** `WEAVER_GRIPPER` + `SPINNER_PAD` flags ON. **Gripper** (`GRIPPER_GRAPPLE`: EXTEND→SEEK→CLOSE→latch; fixtured P 0.90, oversize/awkward recommender fork). **Pad** (`PAD_CONTACT`: APPROACH_SOFT→CONTACT→grip; deterministic `_resolvePadMode` priority — magnet/hooks/gecko/electrostatic/uv_cure; finite per-arm UV-cure magazine with decrement-on-success-only + removal-at-zero; HUD `[u:n]` counter). Shared `debrisFerrous.deriveCaptureFlags()` SSOT now derives `hasGrappleFixture` + `surfaceRoughness` too. CP-1 is **complete**. Tests: `test-ToolRecommender`, `test-ArmUnit-MagneticGrapple`, `test-ArmUnit-GripperGrapple`, `test-ArmUnit-PadContact`, `test-DockingReticle-ToolPanel` (623 suites / 2582 tests / 0 fail). **Deferred:** UV-cure dose save/load persistence (§13 Q3) — runtime-only at Y0. **Next: CP-2 laser de-spin.**
**Risk:** Medium — touches ArmUnit FSM, TargetSelector recommender, DockingReticle HUD, CollisionAvoidance exempt set. Mitigated by feature-flag gating + the spec's graceful-degradation recommender.
**Burden:** P2 = **M**; P3/P4 = **M** each. **(All shipped.)**
**Acceptance:** ✅ steel rocket-body shows ▶MAGNET ★★★; oversize/awkward body shows ▶GRIPPER; Spinner tiny fragment offers PAD ★★★; net-only target still recommends net; backtick cycles per-arm toolset; tests stay green.

### CP-2 — Laser de-spin + the first 2-step combo
**Why.** Tumbling debris is the canonical reason nets fail (angular momentum). Detumble→net is the first "tools chain together" aha and the cleanest physics lesson. Reactivate the dormant `ABLATING` path (mother-mounted per [`BIG_PICTURE.md §16`](BIG_PICTURE.md), not daughter) with a keybind + HUD spin-rate readout ticking down.
**✅ SHIPPED (2026-06-07).** New mother-mounted [`DespinLaser`](js/systems/DespinLaser.js) system (flag `LASER_DESPIN` ON), **hold `U`** in command view to bleed the active target's `tumbleRate` (cyan beam, `DESPIN_IN_SPEC` → "tumble in spec, net it"). The bit-rotted daughter `ABLATING` path (mutated a non-existent `angularVelocity`) is superseded. Live coupling: `CaptureNet.computeTumbleModifier` adds a tumble penalty to net cling so detumbling genuinely improves capture (not cosmetic). HUD: `TargetReticle` shows the live °/s ticking down + a `▼ DE-SPIN` marker; reticle colour already shifts red→green as spin drops. Tests: `test-DespinLaser.js` (pure step, FSM, range/flag gates, target-switch cleanup, cling coupling), 627 suites / 2594 tests / 0 fail. **Next: CP-3 cluster/transfer agency.**
**Risk:** Medium-low (code exists, flag off, no binding). Keep it a *detumble assist*, not a primary capture.
**Burden:** **M**. **(Shipped.)**
**Acceptance:** ✅ aim at a >10°/s target → spin ticks down → in-spec comms fires + net cling improves; HUD spin readout ticks down live.

### CP-3 — Cluster/transfer agency + the transfer-ellipse countdown
**Why.** "Which cluster next?" must be a fuel-vs-time-vs-value decision, not "nearest." TrawlManager auto-picks `clusters[0]`; StrategicMap shows everything but can't select. Add cluster selection on StrategicMap (or unify with DebrisMap) that sets the trawl/AP target, and add the **transfer ellipse + launch-window countdown** ([`BIG_PICTURE.md §24`](BIG_PICTURE.md)). This is the single highest-value *educational* build: it teaches "space is periodic; go-now is usually wrong."
**✅ SHIPPED (2026-06-08).** Built on the existing cluster-selection surface ([`DebrisMap`](js/ui/DebrisMap.js) already selects + drives autopilot via `engageCluster`). New pure math module [`LaunchWindow.js`](js/entities/LaunchWindow.js) (`meanMotion`/`orbitalPeriod`/`synodicPeriod`/`hohmannPhaseLead`/`computeTransferWindow`/`clusterToOrbitKm`/`detectWindowCrossing`) computes the next Hohmann window from player→cluster using a representative member's live orbit for phase. DebrisMap now shows a **TRANSFER WINDOW** readout for the highlighted cluster (`Depart T-mm:ss` / `Arrive T+mm:ss` / `ΔV m/s` + "next window every …" periodicity hint) and a dashed transfer-path arc on the schematic. Engaging a cluster **commits** the countdown: it ticks every frame (even with the map closed), turns cyan + beeps at T-10s (`CLUSTER_WINDOW_IMMINENT` → `playWindowImminent`), and fires HOUSTON "window open" comms + chime at T-0 (`CLUSTER_WINDOW_OPEN`); a missed window rolls to the next synodic period automatically. Flag `CLUSTER_TRANSFER_WINDOW` ON. Tests: `test-LaunchWindow.js` (24 cases — period/synodic/phase-lead, window phase invariant, co-altitude edge, cluster derivation, crossing detection), **634 suites / 2618 tests / 0 fail**. **Deferred:** porkchop/Lambert escalations (EN-5/EN-6); StrategicMap (3D) still view-only — selection agency lives in DebrisMap. **Next: CP-4 MissionCoach + comms arbiter.**
**Risk:** Medium — new UI on existing StrategicMap; reuse OrbitMFD Hohmann math.
**Burden:** **L**. **(Shipped.)**
**Acceptance:** ✅ select cluster → ellipse + "Depart T+mm:ss / Arrive / ΔV"; countdown beeps at T-10s; miss → next window one period later; selection drives autopilot.

### CP-4 — MissionCoach + the comms suppression arbiter (the arc spine)
**Why.** The 12-chapter arc ([`MISSION_GUIDANCE_DESIGN.md`](MISSION_GUIDANCE_DESIGN.md)) has no code. Before any chapter content, build the **"who's allowed to talk right now" arbiter**: replace binary `_onboardingActive` with graduated `_suppressionTier` (0–3) and a single rule — *a hint fires only if its skill is undiscovered or recently-failed, never twice, silent after 3 unheeded nudges.* Then add `MissionCoach.js` (+ shared `_beatLifecycle.js`) driven by `SHOP_DEPLOY`, with per-chapter `BEATS_BY_MISSION[N]` tables.
**✅ SHIPPED (2026-06-08) — the arc spine is complete: arbiter (steps 1–5) + MissionCoach engine + chapter 2.** The binary `_onboardingActive` is replaced by a graduated `_suppressionTier` (0–3) with a game-clock wake ramp (tier 1 HOUSTON/MISSION → tier 2 +ALERT/CMD → tier 3 all), plus the `_critical`/`_postOnboarding`/`_lassoFeedback` tag bypasses (and CRITICAL-priority from tier 1). Pure core in [`commsSuppression.js`](js/systems/commsSuppression.js); wired into [`CommsSystem.js`](js/systems/CommsSystem.js); low-fuel/battery + imminent (RED) conjunction alerts stamped `_critical`. **Step 3:** [`SkillsSystem`](js/systems/SkillsSystem.js) gained an optional `def.triggerFilter(data)` gate; `ARM_CAPTURED` carries `manual`, `SCAN_INITIATED` carries `type`. **Step 4:** the universal hint-gating rule `SkillsSystem.canFireHint(skillId,{cause})` (*undiscovered OR discovered+failed-recently, never mastered, silent after `MAX_UNHEEDED_NUDGES`*) + `_recentFailures` ring buffer + `isVeteran()`/`getHintPresentation()` (`SKILLS.VETERAN_SKILL_THRESHOLD` 0.7). **Step 5:** [`TeachingSystem`](js/systems/TeachingSystem.js) queues single-fire overlays while a blocking surface (radial `C`/deploy ceremony `D`), the OnboardingDirector, or a MissionCoach beat owns the screen, drains ≤1 per `TEACHING.QUEUE_DRAIN_INTERVAL_S`, drops overlays whose id matches an active beat's `skillId`, and downgrades veterans to ticker. **MissionCoach (2026-06-08):** [`MissionCoach.js`](js/systems/MissionCoach.js) + shared [`_beatLifecycle.js`](js/systems/_beatLifecycle.js) (`BeatSequencer`) run per-chapter beat tables on `SHOP_DEPLOY` — every beat posts `_postOnboarding` MISSION comms, interactive beats emit `MISSION_BEAT_STARTED/SATISFIED` and resolve on their (payload-filtered) trigger, idle beats re-prompt via `TEACHING_MOMENT_FORCE`, completion persists per mission. **Chapter 2** (Daughter piloting) ships as `Constants.MISSION_COACH.BEATS_BY_MISSION[2]` + 2 new `triggerFilter` skills (`arm_pilot`, `arm_pilot_capture`), proving the data-driven pattern. Tests: + `test-beatLifecycle.js` + `test-MissionCoach.js` (**648 suites / 2679 tests / 0 fail**); zero regression. **Follow-on (not CP-4 spine — see [`MISSION_ARC_IMPLEMENTATION.md`](MISSION_ARC_IMPLEMENTATION.md) Phases C–F):** chapters 3–12 beat tables + their ~5 remaining skills, the ISS/Starlink/Thaicom boss events, the win cinematic, and the OnboardingDirector adoption of `_beatLifecycle`.
**Risk:** Medium — touches CommsSystem (well-tested), adds a system. The arbiter is the risky part; get it right once.
**Burden:** arbiter = **M**; MissionCoach engine = **M**; each chapter's beats = **S** (data, not code).
**Acceptance:** experts see no modals; new players get one nudge per new tool; ISS conjunction alert still reaches a tier-1 player via `_critical` tag (✅ RED conjunctions now stamped `_critical` in `ConjunctionSystem`).

> **Sequencing rationale:** CP-1/CP-2 make the *moment-to-moment* game deep enough to be worth a campaign. CP-3 makes the *strategic* choices real. CP-4 turns the sandbox into a *journey*. Do them in that order; each is shippable alone.

---

## 2. High-value enrichment (after the critical path)

| ID | Item | Why | Risk | Burden |
|---|---|---|---|---|
| EN-1 | **Wire TetherReel** (cable physics, JAM, tension) | Tether-tension color/hum is the signature delight + teaches constant-tension control. Currently orphaned. | Med (flag on + wire main.js + verify visual reads `getReelRecord`) | M |
| EN-2 | **Net failure → partial/recoverable + TANGLED decision** | Turns binary failures into micro-decisions; feeds risk-reward. Builds on existing capture-failure model. | Low | M |
| EN-3 | **Fuel-positive route scoring** in sweep/mission report | Gamifies the orbital-economy lesson; infinite optimizer ceiling. | Low | S |
| EN-4 | **Iron-filing field-line flash** on magnet capture | Makes invisible B-field visible; cheap delight. Depends on CP-1 P2. | Low | S |
| EN-5 | **Porkchop plot** (apprentice reveal, after first bad-timing burn) | Teaches the ΔV-vs-timing landscape; escalation of CP-3. | Med (needs Lambert) | L |
| EN-6 | **Lambert solver + "impossible orbit" red slider** (veteran) | Teaches "can't brute-force time"; powers porkchop. | Med | M |
| EN-7 | **CW accuracy band** during close approach | Teaches when linear approximation breaks; builds autopilot trust. | Low | M |
| EN-8 | **Trophy shelf** (first net, first detumble, first GEO, first 1000kg) | Profile-permanent retention hook; cheap. Extends apex-hub keepsake. | Low | S |
| EN-9 | **Re-home orphaned verbs:** keybind Web Shot; decide Fishing key; resolve Ablation (CP-2 supersedes) | Removes dead-code smell; small UX wins. See DAUGHTER_RETRIEVAL_AUDIT §7. | Low | S each |
| EN-10 | **NetInventoryPanel redesign + re-enable** | Suspended pending visual redesign (StatusPanel aesthetic, progressive reveal). | Low | S |

---

## 3. Optimization opportunities

| Item | Trigger to act | Burden |
|---|---|---|
| **`getDebrisNear` clone cost** — now clones `_scenePosition`/`orbit` per result | Profile under dense debris; if hot, apply caching from `archive/QUICK_WINS_PERF.md` | S |
| **`DebrisField.js` ~2093 LOC / `SkillsSystem.js` ~1869 LOC / `ArmUnit.js` 4000+ LOC** | Split candidates — extract on next major touch, not speculatively | M each |
| **Wiring smoke test** (`test-main-wiring.js`) — assert every `main.js`-imported system has `init()` OR `update()` called | Would have caught the CaptureNet/TetherReel orphan class of bug | S |
| **rAF/audio throttle** (done) | Already fixes paused/app-switch GPU; keep the policy intact when adding wake hooks | — |
| **MOID as primary conjunction filter** | Skips ~90% of pairs; already partially used — verify it gates the expensive TCA path | S |

---

## 4. Pacing & guidance principles (design guardrails)

Hold these while building the arc, or the learning curve breaks:

1. **At most 3 plates per chapter; cognitive ceiling ~6 by chapter 8.** No new plate in consolidation chapters (8, 12). One new tool/concept per chapter (the 20%), everything prior reinforced (the 80%).
2. **Teach reactively, not proactively** — experience → consequence → explanation. The strongest beats fire *in response to the player's own action* (e.g. active-sat lockout explains itself when tripped).
3. **Every failure answers three questions visibly:** what failed (symptom), why (root-cause readout), what now (a counter-tool owned or shop-visible).
4. **Make tool choice the gate.** Inspect-before-fire must be rewarded, not optional — it's the real ADR doctrine and the thing that makes the tool ladder matter.
5. **Protect ΔV as the single master resource.** Never let it free-regenerate except via salvage→forge→propellant. The tactical cost and strategic lifeblood being the *same quantity* is what unifies the loops.
6. **Cooldown beauty is a feature** — sunrise pans, empty-sky moments, forge idle. Schedule breathing room between spinning-plate waves.
7. **Introduce each viz when the player first hits the problem it solves** (transfer ellipse at first cluster select; porkchop after a bad-timing burn; MOID at first conjunction; Lambert at first retrograde; CW at first <100m approach).

---

## 5. Risk register (project-level)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Wiring-gap bugs** (imported, not called) | High (recurring) | Browser-only dead features | Build `test-main-wiring.js`; feature-flag + verify in browser, not just tests |
| **THREE convention bugs** (lookAt/world-vs-local/frame-order) | Med | Silent visual breakage | HANDOFF §9/§10 SSOT; world-coord asserts in tests; mutation-test fixes |
| **Comms arbiter regressions** (CP-4) | Med | Nag experts / mute critical alerts | `_critical` bypass tag; tier tests extend `test-CommsSystem.js` |
| **Scope creep on the arc** | High | Never ships | Ship CP-1..CP-4 independently; chapters are data tables, not code |
| **Salvage-timing debt** (scoring fired on `ARM_RETURNED`, before furnace) | ✅ Resolved 2026-06-07 | Was: reward granted prematurely under park-the-catch | Fixed: salvage + scoring + field removal moved to `CATCH_PROCESSED` (furnace-transfer completion); parked catch now auto-clears → daughter reloads (no 4-catch stall) |
| **Doc/code drift** (this whole pass) | High historically | Misleads future shifts | Update ARCHITECTURE drift table + this roadmap in the same shift as code changes |

---

## 6. What docs are still needed for the full 12-mission arc

The arc needs **connective specs that bind existing systems**, not new design vision (that exists). Gaps, in priority order:

1. ✅ **[`MISSION_ARC_IMPLEMENTATION.md`](MISSION_ARC_IMPLEMENTATION.md)** *(written 2026-06-07)* — the per-chapter build contract: 12-chapter table (band, new skill+triggerEvent, mass quota, boss/news hook), the MissionCoach engine, the new skills, and the chapter-1 onboarding (folded from the archived FIRST_EXPERIENCE.md).
2. ✅ **[`GUIDANCE_ARBITER_SPEC.md`](GUIDANCE_ARBITER_SPEC.md)** *(written 2026-06-07)* — the SSOT for the `_suppressionTier` model, the `_critical`/`_postOnboarding` tag exceptions, the universal hint-gating rule, the 3-layer arbitration table, and the `triggerFilter` extension. **CP-4 prerequisite — build this first.**
3. **`SKILLS_CATALOG.md`** *(new or fold into SKILLS_ARCHITECTURE.md)* — the authoritative list of all 35 (→~41 for the arc) skills with id/tier/category/triggerEvent. The arc's new skills are tabulated in MISSION_ARC §5; this would make the full catalog a single maintained surface.
4. **`ECONOMY_BALANCE.md`** *(new)* — the ΔV/credit/mass numbers that make the VLEO→GEO climb and the 10,000 kg anchor feel earned: per-chapter mass quotas (they must sum to 10,000), FEEP-metal Isp/thrust table, shop cost curve, salvage yields. Currently scattered across Constants + GAME_FLOW_BRAINSTORM.
5. **`EDUCATIONAL_VIZ_SPEC.md`** *(new, or expand BIG_PICTURE Part III)* — implementation contracts for transfer-ellipse-countdown, porkchop, Lambert, CW, keyed to the StrategicMap/OrbitMFD surfaces and the when-to-introduce table.
6. **`CEREMONIES.md`** *(consolidation)* — one place for all camera ceremonies (launch 3-beat, net 7-beat, the missing dock + tier-upgrade + win cinematics the arc's chapter 12 needs).

**Consolidation/streamlining — DONE 2026-06-07:**
- Archived (git mv, history preserved): `QA_FINDINGS.md`, `IMPLEMENTATION_PLAN.md` → `archive/IMPLEMENTATION_PLAN_2026-06.md`, removed the `FIX_PLAN.md` redirect stub.
- Folded-and-archived: `FIRST_EXPERIENCE.md` → MISSION_ARC §3; `GAME_FLOW_BRAINSTORM.md` (net-failure modes + tool kit) → DAUGHTER_MULTITOOL_SPEC §15; `DAUGHTER_RETRIEVAL_AUDIT.md` → ARCHITECTURE §9 reachability + HANDOFF §11.7 + EN-9.
- Root is now **6 canonical + active-reference specs only**; all kept-doc cross-links repointed to `archive/`. README has a Doc Map.
- **Still open:** items 3–6 below (SKILLS_CATALOG, ECONOMY_BALANCE, EDUCATIONAL_VIZ_SPEC, CEREMONIES) when their work is scheduled.

---

## 7. Minor backlog (carried forward, low priority)

From Delegation 2/3 and prior shifts — small, self-contained:
- **Space-bar heuristic mode** (post-onboarding smart-default: scan / autopilot / lasso / deploy by context). Wrap the post-onboarding fall-through in `InputManager` Space handler.
- **Per-strut screen-space labels** during the `struts` onboarding beat (currently glow-only).
- **`arm_struts` / `inspect_mother` skill catalog entries** (so those beats can tier-skip).
- **Welcome-field consolidation** — unify public `spawnWelcomeField` + legacy `_spawnWelcomeField`; drop the `welcomeSpawn` flag for `welcomeField:true`.
- **Wireframe zone click-to-inspect**, zone voice readouts, debris-inspection camera zoom, StrutLabels hinge-angle accuracy, MotherWireframe arm-count cache (Delegation 3 polish).
- **Four-fix backlog:** differential `setThrusterFire`, `test-TargetRanking.js`, `SpacecraftMaterials.js` extraction, `RENDER_ORDER` extension, dynamic `DIST_REF_KM`, remaining inline `ARM_STATES` predicate sites (HANDOFF §11.8).

---

*Maintenance: when a critical-path item ships, move it to "done" in HANDOFF §14 heritage and update the ARCHITECTURE drift table. Keep this file the single forward-planning surface.*
