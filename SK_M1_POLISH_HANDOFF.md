# SK / Mission-1 Polish Cycle — Handoff

> **Date:** 2026-05-16  |  **Test status:** 460 suites / 2060 tests / 0 failures  |  **Author:** debug subtask chain (SK + M1 polish)

---

## TL;DR — If You Read One Section, Read This

- **SK standoff zoom, sonar ping, green ring, daughter-launch COMMS, debris sizing, SkillsPane startup** — seven polish tasks shipped. Two mid-flight additions (2 km debris cull + opening-screen credits). Two diagnostic bugs fixed (mother AP ARRIVED disengage + M1 debris at 7 km).
- **Root cause theme:** separate render/data layers (background-points cloud, welcome-cluster drift, HOLD-timer auto-disengage) that look "fine in tests" but break visually in the browser. Always verify in-browser, not just in headless tests.
- **Biggest lesson (L1):** A backtick inside a template literal inside a JS file broke the browser silently — no console error, no test failure. `node --check <file>` catches this; the test runner does not.
- **Top path-forward items:** (1) Centralise the M1 visibility predicate (`_isVisibleForCurrentMission(debris)`) — it's duplicated in 3 places. (2) Refactor [`DebrisField.js`](js/entities/DebrisField.js) (2093 LOC, 50+ methods) — split background, welcome, queries, update. (3) Extract R1–R7 new-user guidance recommendations from the SK Research subtask output (flagged as pending retrieval below).

---

## 1. What Changed — File by File

### 1.1 Core / Constants

| File | Changes | Task |
|------|---------|------|
| [`Constants.js`](js/core/Constants.js) | `STATION_KEEP.MIN_STANDOFF` 8→4 m, `MAX_STANDOFF` 15→12 m, new `WHEEL_STEP_M: 0.5` (m/tick) | Polish #1 |

### 1.2 Entities

| File | Changes | Task |
|------|---------|------|
| [`ArmUnit.js`](js/entities/ArmUnit.js) | `ARM_ORBIT_ADJUST` radiusStep wired to `WHEEL_STEP_M` | Polish #1 |
| [`DebrisField.js`](js/entities/DebrisField.js) | (a) `_generateDebrisData()` mass-fraction → `sizeMid` coupling. (b) `backgroundPoints.visible = false` on M1. (c) Per-frame 2 km distance cutoff in `update()`. (d) `MISSION_START` reset. (e) `welcomeSpawn` filter in [`getDebrisNear()`](js/entities/DebrisField.js:1560) and [`getEnhancedTargetList()`](js/entities/DebrisField.js:1762) | Polish #6, M1 cull, Bug 2 |

### 1.3 Systems

| File | Changes | Task |
|------|---------|------|
| [`InputManager.js`](js/systems/InputManager.js) | (a) Capture-phase `wheel` listener (`{ passive: false, capture: true }`) + `preventDefault()` for SK zoom. (b) Arrow-key AP-disengage guard: skips when SK active | Polish #1, #3 |
| [`AutopilotSystem.js`](js/systems/AutopilotSystem.js) | (a) [`hasLockedTarget`](js/systems/AutopilotSystem.js:678) HOLD-timer suppression — prevents ARRIVED disengage when target is locked. (b) `[DBG-AP-DISENGAGE]` diagnostic log at [line 279](js/systems/AutopilotSystem.js:279) | Bug 1, Diagnostics |
| [`GameFlowManager.js`](js/systems/GameFlowManager.js) | `deployArm()` fallback with reason categorisation → COMMS_MESSAGE on G-key fail | Polish #5 |

### 1.4 UI

| File | Changes | Task |
|------|---------|------|
| [`DockingReticle.js`](js/ui/DockingReticle.js) | [`_updateApproachAudio()`](js/ui/DockingReticle.js:261) restored sonar-ping during APPROACH. Two tiers: close (1000 Hz / 0.4 s), mid (900 Hz / 0.5 s). Smooth fade into SK | Polish #2 |
| [`TargetReticle.js`](js/ui/TargetReticle.js) | [`_drawLassoCooldownArc()`](js/ui/TargetReticle.js:1651) — "Ready" green ring branch deleted entirely. Early-out when `skTargetId != null` guards both call sites | Polish #4 |
| [`MenuScreen.js`](js/ui/MenuScreen.js) | `_onKeyDown` accepts any non-modifier key ("Press any key"). ADR ecosystem credits: 4 categorised lists with native `title` tooltips (Pioneers / International / India's ADR / Partnerships) | Opening screen |

### 1.5 HUD

| File | Changes | Task |
|------|---------|------|
| [`SkillsPane.js`](js/ui/hud/SkillsPane.js) | [`_masterVisible`](js/ui/hud/SkillsPane.js:127) defaults `false`. [`GAME_STATE_CHANGE`](js/ui/hud/SkillsPane.js:178) subscription gates on `ORBITAL_VIEW | APPROACH | INTERACTION` | Polish #7 |

### 1.6 Tests

| File | Changes | Task |
|------|---------|------|
| [`test-AutopilotSystem.js`](js/test/test-AutopilotSystem.js) | Split at [line 291](js/test/test-AutopilotSystem.js:291): "locked → stays engaged" and "no locked → ARRIVED" | Bug 1 |

---

## 2. Why It Changed — Root Causes & Diagnosis Trail

### 2.1 Bug 1: Mother AP `ARRIVED` disengage with locked target

**Symptom:** Player locks a debris target, engages autopilot, mother arrives — then autopilot disengages after 1.5 s even though the player hasn't done anything. Mother drifts away.

**Root cause:** The 4-phase autopilot state machine (`RENDEZVOUS_FAR → MATCH_ORBIT → TRAIL_ALIGN → HOLD`) has a `HOLD_DURATION` timer that fires [`disengage('ARRIVED')`](js/systems/AutopilotSystem.js:683) after 1.5 s in HOLD. This is correct for "fly to a coordinate" (cluster AP, prograde hover) but wrong for "fly to a thing I want to interact with". The existing arms-active check (condition `a`) only suppressed the timer while a daughter was in flight — but before any daughter is launched, nothing prevented the timer from expiring.

**Fix:** Added condition `(b)` at [line 678](js/systems/AutopilotSystem.js:678): `const hasLockedTarget = !!(this._lockedTargetRef && this._lockedTargetRef.alive)`. While `hasLockedTarget` is true, `_holdTimer` is frozen. The timer only counts when *both* no arms are active *and* no locked target exists — i.e., the "cluster/prograde" use-case.

**Test:** Two-part split — "locked target ⇒ AP stays engaged after HOLD_DURATION" and "no locked target ⇒ AP fires ARRIVED after HOLD_DURATION".

### 2.2 Bug 2: M1 debris re-appearing at 7 km in tracked pane

**Symptom:** During Mission 1, the TRACKED TARGETS HUD panel showed debris entries at 5–7 km range, contradicting the "tight ≤ 2 km welcome cluster" contract.

**Root cause (multi-layer):**

1. **Welcome-cluster drift via differential atmospheric drag (L3).** Lighter/draggier debris objects lose SMA faster than heavier ones. Even though all welcome debris spawn within a 2 km radius of the player, lighter pieces drift to different orbits over time.

2. **Background-points cloud (L2).** [`DebrisField._generateBackground()`](js/entities/DebrisField.js) creates a 5000-particle `THREE.Points` cloud that is *not* in `debrisList`. It was rendering behind the M1 welcome cluster even though M1 should show a sparse field.

3. **No query-level M1 filter.** The per-frame 2 km cull in `update()` kills debris that have `_scenePosition` set, but catalog-loaded debris (which never enter the instance-lookup pool) never get `_scenePosition`, so the cull never marks them dead. They leak into [`getEnhancedTargetList()`](js/entities/DebrisField.js:1762).

**Fix (three layers):**

| Layer | Location | What |
|-------|----------|------|
| Render | `update()` ~line 995 | Per-frame 2 km clamp on `_scenePosition` distance — kills drifted debris |
| Render | `_generateBackground()` | `backgroundPoints.visible = false` on M1 |
| Query | [`getDebrisNear()`](js/entities/DebrisField.js:1560) + [`getEnhancedTargetList()`](js/entities/DebrisField.js:1762) | Hard-clamp radius to 2 km AND require `welcomeSpawn` flag on M1 |

### 2.3 Polish rationale summary

| # | What | Why |
|---|------|-----|
| 1 | SK standoff 4–12 m + wheel zoom | User found 8 m too far for close inspection; 15 m makes debris tiny. Wheel zoom gives instant control. |
| 2 | Sonar ping during APPROACH | Silence during approach felt broken; ping confirms range is closing |
| 3 | Mother AP continues during SK | Arrow keys were disengaging mother AP when daughter was in SK — hostile UX |
| 4 | Remove green Ready ring | Persistent green circle at screen centre obscured SK work area |
| 5 | COMMS on G-key fail | Player pressed G with no valid target and got zero feedback — silent failure |
| 6 | Debris visual size ↔ mass | Small visual debris yielding 4000 kg of salvage broke immersion |
| 7 | Hide SkillsPane on startup | Pane rendered during MENU/BRIEFING before player had any skills |

---

## 3. Lessons Learned

### L1 — Template literal + backtick trap

Embedding backtick-quoted words (e.g. `` `title` ``) inside an HTML comment inside a JS template literal **broke [`MenuScreen.js`](js/ui/MenuScreen.js) silently** — the browser hung at "Initializing VLEO systems…" with no console error. Node tests still passed because they import per-file (never execute the template).

**Rule:** Always run `node --check <file>` on every modified `.js` file before claiming completion. The test runner is not sufficient.

### L2 — Background-points cloud is a separate render layer

[`DebrisField._generateBackground()`](js/entities/DebrisField.js) creates a 5000-particle `THREE.Points` cloud that is **not** part of the tracked debris list. It must be hidden separately (`backgroundPoints.visible = false`) for missions that need a sparse field. Easy to miss because it doesn't appear in `getTargetList()`.

### L3 — Welcome-cluster drift via differential atmospheric drag

Even with a 2 km spawn radius, debris members drift apart over time because lighter/draggier objects decay SMA faster. Spawning close ≠ staying close. Need **per-frame clamps in target queries**, not just at spawn time.

### L4 — HOLD-phase ARRIVED is correct for "fly to coordinate" but wrong for "fly to thing I want to interact with"

The autopilot's `HOLD_DURATION` + `ARRIVED` disengage was designed for cluster/prograde hover. When the player explicitly locked a target and wants the mother to stay while the daughter operates, the disengage is hostile. The fix ([`hasLockedTarget`](js/systems/AutopilotSystem.js:678) suppression) introduces a **behavioural fork** in the HOLD phase:

- `hasLockedTarget = true` → hold indefinitely until manual disengage, target capture, or arm return
- `hasLockedTarget = false` → auto-disengage after `HOLD_DURATION` (1.5 s)

Future contributors modifying HOLD behaviour **must** understand this fork.

### L5 — Visibility gating pattern

[`DockingReticle`](js/ui/DockingReticle.js), [`OrbitMFD`](js/ui/OrbitMFD.js), [`NavSphere`](js/ui/NavSphere.js), and now [`SkillsPane`](js/ui/hud/SkillsPane.js) all share the same pattern:

```js
eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
    const gameplay = (to === 'ORBITAL_VIEW' || to === 'APPROACH' || to === 'INTERACTION');
    if (gameplay && !this._masterVisible) this.setVisible(true);
    else if (!gameplay && this._masterVisible) this.setVisible(false);
});
```

**Convention:** All new HUD elements that should only appear during gameplay MUST use this `GAME_STATE_CHANGE`-driven visibility gate with a `_masterVisible` default of `false` and an explicit gameplay-state whitelist.

### L6 — Capture-phase wheel listener for arm-pilot

The mouse-wheel zoom in SK uses a **capture-phase** listener:

```js
window.addEventListener('wheel', this._onWheel, { passive: false, capture: true });
```

This overrides the browser's default scroll behaviour and any non-capture listeners. Pattern for any new mouse-wheel interaction:

1. Attach with `{ passive: false, capture: true }` in [`enable()`](js/systems/InputManager.js:265)
2. Call `e.preventDefault()` inside the handler
3. Remove with matching `{ capture: true }` in `disable()`

### L7 — User feedback friction signals

Three surface bugs ("7 km debris!", "green circle centre screen!", "stuck, why is it stuck!") all stemmed from incomplete understanding of separate render layers or event branches. **Before claiming a fix, verify visually in the browser** — not just in tests. If a bug is reported as visual, the fix must be confirmed visually.

---

## 4. Project Conventions Reaffirmed

These conventions were exercised or reinforced during this cycle:

| Convention | Detail |
|-----------|--------|
| **Scene scale** | 1 scene unit = 100 km. `Constants.SCENE_SCALE = 0.01`. All Three.js positions are in scene units; gameplay logic uses metres/km. Conversion: `distanceSU * (1 / Constants.SCENE_SCALE) = distanceKm`. |
| **Event bus** | Singleton [`eventBus`](js/core/EventBus.js) — pub/sub. Events enumerated in [`Events.js`](js/core/Events.js). **Never invent new event names without adding them to the enum.** |
| **`COMMS_MESSAGE` shape** | `{ text: string, priority: 'info' | 'warning' | 'error' | 'HIGH' | 'MEDIUM' | 'LOW' }`. Used for all player-facing system feedback via [`CommsSystem`](js/systems/CommsSystem.js). |
| **`GAME_STATE_CHANGE` payload** | `{ from, to }` where `to ∈ { 'MENU', 'BRIEFING', 'ORBITAL_VIEW', 'APPROACH', 'INTERACTION', 'SHOP', 'GAME_OVER', … }`. Emitted by [`GameFlowManager`](js/systems/GameFlowManager.js). |
| **Logging convention** | `[DBG-<TAG>]` prefix for diagnostic logs (greppable, not user-facing). E.g. `[DBG-AP-DISENGAGE]`, `[DBG-AP-HOLD]`. Use `console.warn` so they appear in default DevTools filter. |
| **Test runner** | `node js/test/run-tests.js` — 460 suites, 2060 tests. Add tests for every behavioural change. Run `node --check` on every modified `.js` file. |
| **SK frozen entry triad** | θ/φ/R captured at SK entry in screen-aligned axes; never recomputed from world basis mid-SK. See [`STATION_KEEP`](js/core/Constants.js:2005) block. |
| **Autopilot 4-phase state machine** | `RENDEZVOUS_FAR → MATCH_ORBIT → TRAIL_ALIGN → HOLD`. Defined in [`AutopilotSystem.js:48`](js/systems/AutopilotSystem.js:48). HOLD now has a sub-fork based on [`hasLockedTarget`](js/systems/AutopilotSystem.js:678). |

---

## 5. Open Work & Recommendations

### 5.1 SK Research Recommendations — Pending Retrieval

> ⚠️ **R1–R7 could not be extracted from this subtask's context.** The SK Research subtask identified 9 gaps in new-user guidance and produced 7 recommendations (R1–R7), but those were generated in a prior conversation turn whose full output is not available in this subtask's scope. Before this document is considered final, a contributor must:
>
> 1. Re-run the SK Research subtask or locate its output in conversation history
> 2. Extract R1–R7 and paste them into this section
> 3. Remove this warning block
>
> The recommendations covered: first-minute onboarding, AP discoverability, SK entry cues, target-lock UX, COMMS panel guidance, zoom/orbit controls discovery, and mission-transition handholding.

### 5.2 Architectural Observations (from this cycle)

#### A. M1 enforcement logic is triplicated

The "only show welcome-cluster debris on Mission 1" predicate is now implemented in **three separate places**:

1. [`DebrisField.update()`](js/entities/DebrisField.js) — per-frame 2 km distance cull (~line 995)
2. [`getDebrisNear()`](js/entities/DebrisField.js:1560) — radius clamp + `welcomeSpawn` filter
3. [`getEnhancedTargetList()`](js/entities/DebrisField.js:1762) — radius clamp + `welcomeSpawn` filter

**Recommendation:** Extract a single `_isVisibleForCurrentMission(debris, distanceSU)` predicate method and call it from all three sites. If M1 rules change (e.g. expanding to 3 km, or adding a "discovered non-welcome debris becomes visible" rule), only one place needs updating.

#### B. [`DebrisField.js`](js/entities/DebrisField.js) is 2093 lines with 50+ methods

This file handles: background generation, welcome-cluster spawning, per-frame orbital propagation, instanced-mesh management, spatial queries (`getDebrisNear`, `getEnhancedTargetList`, `getDebrisClusters`), salvage computation, mission-number tracking, and render culling. Split candidates:

| Module | Methods to extract |
|--------|--------------------|
| `DebrisBackground.js` | `_generateBackground()`, background-points visibility logic |
| `WelcomeCluster.js` | `_spawnWelcomeField()`, `welcomeSpawn` tagging, mission-gating |
| `DebrisQueries.js` | `getDebrisNear()`, `getEnhancedTargetList()`, `getDebrisClusters()`, spatial cache |

#### C. [`SkillsPane.js`](js/ui/hud/SkillsPane.js) is 1869 lines

With compact mode, expanded mode, tech discovery tracking, experience levels, and render logic all in one file, this is a refactor candidate. However it is functional and tested — not urgent.

#### D. [`_drawLassoCooldownArc()`](js/ui/TargetReticle.js:1651) — remaining branches

The "Ready" branch was deleted (Polish #4). The cooldown-in-progress, in-flight, and denied branches remain. Verify these don't also render unwanted overlays during SK. A visual audit during SK with lasso on cooldown would confirm.

#### E. `HOLD_DURATION` is hardcoded at 1.5 s

This value lives in `Constants.AUTOPILOT.HOLD_DURATION`. Now that HOLD has a behavioural fork (`hasLockedTarget` vs. not), consider whether the non-locked case should also be tunable per context (e.g. cluster AP might want a longer dwell than prograde AP).

---

## 6. Suggested Tests to Add

### 6.1 Manual Smoke-Test Checklist

Run in-browser after any change to the files listed in §1:

| # | Test | Expected Result | Files Exercised |
|---|------|----------------|-----------------|
| 1 | Start game → M1 briefing → enter play. Check SkillsPane is invisible during MENU/BRIEFING, visible after ORBITAL_VIEW | Pane absent on MENU; appears on ORBITAL_VIEW | [`SkillsPane.js`](js/ui/hud/SkillsPane.js) |
| 2 | M1: verify all HUD debris entries are ≤ 2 km. Pan around — no 5–7 km entries in TRACKED panel | Zero entries > 2 km | [`DebrisField.js`](js/entities/DebrisField.js) |
| 3 | M1: look at background — no dense star-like particle cloud behind debris | `backgroundPoints` hidden | [`DebrisField.js`](js/entities/DebrisField.js) |
| 4 | Lock a target → engage AP → wait for HOLD → wait 5 s. Mother should NOT disengage | AP stays in HOLD while target is locked | [`AutopilotSystem.js`](js/systems/AutopilotSystem.js) |
| 5 | Engage AP to prograde (no locked target) → wait for HOLD → 1.5 s | AP fires ARRIVED + disengages | [`AutopilotSystem.js`](js/systems/AutopilotSystem.js) |
| 6 | During APPROACH, listen for sonar pings getting faster as range closes | Ping at ~800 Hz (far), 900 Hz (mid), 1000 Hz (close) | [`DockingReticle.js`](js/ui/DockingReticle.js) |
| 7 | Enter SK → verify no green ring at screen centre | Ring absent | [`TargetReticle.js`](js/ui/TargetReticle.js) |
| 8 | In SK, scroll mouse wheel up/down. Daughter should zoom in/out 0.5 m per tick | Radius changes 4–12 m range | [`InputManager.js`](js/systems/InputManager.js), [`Constants.js`](js/core/Constants.js) |
| 9 | Press G with no valid target in range. COMMS panel should show failure reason | COMMS message appears | [`GameFlowManager.js`](js/systems/GameFlowManager.js) |
| 10 | Capture debris in M1. Visual size and salvage mass should be proportional | Large visual = large mass; small visual = small mass | [`DebrisField.js`](js/entities/DebrisField.js) |

### 6.2 Headless Tests to Add

| # | Test Description | File |
|---|-----------------|------|
| 1 | `backgroundPoints.visible === false` when `_currentMissionNumber === 1` | `test-DebrisField-M1.js` (new) |
| 2 | `getDebrisNear()` returns zero non-`welcomeSpawn` debris on M1 | `test-DebrisField-M1.js` (new) |
| 3 | `getEnhancedTargetList()` returns zero entries > 2 km on M1 | `test-DebrisField-M1.js` (new) |
| 4 | `SkillsPane._masterVisible` stays `false` after construction; transitions to `true` on `GAME_STATE_CHANGE { to: 'ORBITAL_VIEW' }` | `test-SkillsPane-visibility.js` (new) |
| 5 | `_drawLassoCooldownArc()` does not draw when `data.skTargetId != null` | `test-TargetReticle-SK.js` (new) |

---

## 7. Appendix — Diagnostic Logs & Grep Targets

| Tag | Location | Purpose |
|-----|----------|---------|
| `[DBG-AP-DISENGAGE]` | [`AutopilotSystem.js:279`](js/systems/AutopilotSystem.js:279) | Captures reason, phase, holdTimer, HOLD_DURATION, ΔV remaining, posErr, target alive/id, arm states on every AP disengage |
| `[DBG-AP-HOLD]` | [`AutopilotSystem.js:492`](js/systems/AutopilotSystem.js:492) | Snapshots position, orbit elements, target, arm state at HOLD entry |

**Grep commands:**

```bash
# Find all diagnostic disengage events in a browser console export:
grep '\[DBG-AP-DISENGAGE\]' console-export.log

# Find HOLD entry snapshots:
grep '\[DBG-AP-HOLD\]' console-export.log

# Find all M1-related filters in codebase:
grep -rn 'isMission1\|welcomeSpawn\|_currentMissionNumber' js/entities/DebrisField.js
```

---

## 8. Files Modified in This Cycle — Quick Reference

```
js/core/Constants.js          — STATION_KEEP block (MIN/MAX_STANDOFF, WHEEL_STEP_M)
js/entities/ArmUnit.js        — ARM_ORBIT_ADJUST radiusStep
js/entities/DebrisField.js    — M1 cull (3 layers), sizeMid coupling, backgroundPoints
js/systems/AutopilotSystem.js — hasLockedTarget suppression, [DBG-AP-DISENGAGE] log
js/systems/GameFlowManager.js — deployArm() COMMS fallback
js/systems/InputManager.js    — capture-phase wheel listener, arrow-key SK guard
js/ui/DockingReticle.js       — _updateApproachAudio sonar-ping tiers
js/ui/MenuScreen.js           — "Press any key" + ADR credits with tooltips
js/ui/TargetReticle.js        — _drawLassoCooldownArc Ready branch removed
js/ui/hud/SkillsPane.js       — _masterVisible=false, GAME_STATE_CHANGE gating
js/test/test-AutopilotSystem.js — locked/unlocked HOLD split tests
```

---

*End of SK / Mission-1 Polish Cycle Handoff. Next shift: extract R1–R7 into §5.1, then pick up the path-forward items in §5.2.*
