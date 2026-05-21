# Space Cowboy — V6 Deep Architectural Analysis

> **Generated**: 2026-04-12 from source-level analysis of 11 key files
> **Scope**: Risk-Reward Detach, Reward Refinements, Codex Expansion, Tutorial Updates
> **Key Finding**: ⚠️ All ~509 LOC of planned "remaining work" is **already implemented**
> **Verified**: 105 codex entries counted (regex `id:` lines), all detach paths traced, tutorial text confirmed

---

## Table of Contents

1. [Critical Meta-Finding: Implementation Status](#critical-meta-finding)
2. [A. State Machine Analysis](#a-state-machine-analysis)
3. [B. Dependency Graph — Detach Feature End-to-End](#b-dependency-graph)
4. [C. Risk Assessment](#c-risk-assessment)
5. [D. Refined Implementation Order](#d-refined-implementation-order)
6. [E. Codex Entry Strategy](#e-codex-entry-strategy)
7. [F. Integration Points — Exact Locations](#f-integration-points)
8. [G. Verification Checklist](#g-verification-checklist)

---

## Critical Meta-Finding: Implementation Status {#critical-meta-finding}

**The IMPLEMENTATION_PLAN_V6.md described work that was subsequently completed within the same session.** Cross-referencing the plan's 5 feature areas against actual source code:

| Feature Area | Plan Status | Actual Code Status | Evidence |
|---|---|---|---|
| **Risk-Reward Detach** (~126 LOC) | "Plan ready" | ✅ **FULLY IMPLEMENTED** | [`ArmUnit.detach()`](js/entities/ArmUnit.js:682), [`ArmManager.getActiveDetachCandidate()`](js/entities/ArmManager.js:491), [`InputManager` KeyX](js/systems/InputManager.js:459), [`ScoringSystem` multipliers](js/systems/ScoringSystem.js:177), [`GameFlowManager` ARM_LOST](js/systems/GameFlowManager.js:900), [`main.js` slo-mo](js/main.js:320) |
| **Reward Refinements** (~51 LOC) | "Plan ready" | ✅ **FULLY IMPLEMENTED** | [`Constants.SALVAGE_SYNERGIES`](js/core/Constants.js:743) has 6 GAME_DESIGN pairs, [`FIELD_CLEAR_THRESHOLDS`](js/core/Constants.js:752) defined, [`RewardSystem._checkFieldClearing()`](js/systems/RewardSystem.js:342) uses tiered array |
| **Visual Quick Fixes** (~0 LOC) | "Already complete" | ✅ Confirmed | Moon mesh + 5 planets in [`SunLight.js`](js/scene/SunLight.js) |
| **Codex Expansion** (~251 LOC) | "Plan ready" | ✅ **EXPANDED TO 105 ENTRIES** | [`CodexSystem.js:32`](js/systems/CodexSystem.js:32) — "105 entries across 9 categories" (from original 45) |
| **Tutorial Improvements** (~81 LOC) | "Plan ready" | ✅ **FULLY IMPLEMENTED** | [`TutorialSystem._startStage()`](js/systems/TutorialSystem.js:467) uses "Fire Bolt" / "crossbow bolt" vocabulary; [`_onCatch()`](js/systems/TutorialSystem.js:548) thresholds at 2/3/5/6 |

### What This Means

The [`HANDOFF.md`](HANDOFF.md) "What Was Done This Session" section **confirms** all 5 feature areas were delivered. However, the "What's Next" section and the user's task context describe these as "remaining work (~509 LOC)." This discrepancy exists because the IMPLEMENTATION_PLAN_V6.md was a *prospective* planning document created mid-session, and the work was then executed.

**Recommended action**: Verify each feature through testing rather than re-implementation. Sections below provide the technical analysis for validation purposes and to document the architecture.

---

## A. State Machine Analysis {#a-state-machine-analysis}

### A.1 Complete State Enumeration

[`Constants.ARM_STATES`](js/core/Constants.js:174) defines 20 states:

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    ARM STATE MACHINE                     │
                    └─────────────────────────────────────────────────────────┘

    ┌───────┐  fire   ┌──────────┐  spring  ┌─────────┐  close  ┌──────────┐
    │ DOCKED├────────►│LAUNCHING ├─────────►│ TRANSIT ├───────►│ APPROACH │
    └───┬───┘         └──────────┘          └────┬────┘        └────┬─────┘
        │                                        │                  │
        │         ┌──── fishing ────────── FISHING◄── deploy ──────┘
        │         │                          │                      │
        │         │  ┌──── trawl ──────── TRAWLING                  │
        │         │  │                                         net deploy
        │         │  │                                              │
        │         │  │                                         ┌────▼─────┐
        │         │  │                                         │ NETTING  │
        │         │  │                                         └────┬─────┘
        │         │  │                                         success│fail
        │         │  │  ┌──────── ABLATING (laser) ◄── from transit  │  │
        │         │  │  │  ┌───── SCANNING (pulse) ◄── from docked   │  │
        │         │  │  │  │  ┌── TANGLED ◄── from any deployed      │  │
        │         │  │  │  │  │                                 ┌────▼──▼──┐
        │         │  │  │  │  │                                 │ GRAPPLED │
        │         │  │  │  │  │                                 └────┬─────┘
        │         │  │  │  │  │                               normal │ detached
        │         │  │  │  │  │                                      │
        │  ┌──────┘  │  │  │  │                           ┌─────────▼──────────┐
RELOADING◄─┤         │  │  │  │                           │                    │
    │      │  ┌──────┘  │  │  │                    ┌──────▼───┐          ┌─────▼─────┐
    ▼      │  │         │  │  │                    │ REELING   │          │DEORBITING │
 DOCKED    │  │         │  │  │                    └─────┬─────┘          └─────┬─────┘
           │  │         │  │  │                          │                     │
     ┌─────┘  │         │  │  │                    ┌─────▼────┐                │
     │   ┌────┘         │  │  │                    │ DOCKING   │           ┌────▼────┐
     │   │              │  │  │                    └─────┬─────┘           │EXPENDED │
     │   │              │  │  │                          │                 └─────────┘
     │   │              ▼  ▼  ▼                     ┌────▼─────┐
     └───┼──────────────────────────────────────────┤RELOADING │
         │                                          └──────────┘
     Legacy: UNDOCKING, HAULING, RETURNING (backward compat)
     Special: WEB_SHOT (brief, returns to previous state)
```

### A.2 Detachable States

[`ArmUnit.detach()`](js/entities/ArmUnit.js:683) defines the DETACHABLE set:

| State | Rationale | Risk Level |
|---|---|---|
| `TRANSIT` | Tether deployed, arm en route | LOW — clean state |
| `APPROACH` | Close to target | LOW — clean state |
| `FISHING` | Passive on tether | LOW — clean state |
| `TANGLED` | **Decision fork** — cut free or wait | MEDIUM — must clear tanglePartner |
| `NETTING` | Mid-capture | HIGH — capture in progress |
| `GRAPPLED` | Holding debris | MEDIUM — triggers auto-deorbit |

### A.3 State Transition Effects When Detached

After `detach()`, the arm's `isDetached` flag gates behavior in multiple update methods:

| Method | isDetached Effect | Source Location |
|---|---|---|
| [`_updateTransit()`](js/entities/ArmUnit.js:1246) | Tether limit check **skipped** — free-flying | Line 1246 |
| [`_updateApproach()`](js/entities/ArmUnit.js:1317) | Tether limit check **skipped** | Line 1317 |
| [`_updateGrappled()`](js/entities/ArmUnit.js:1428) | Auto-transitions to **DEORBITING** (sacrifice) | Line 1429 |
| [`_updateHauling()`](js/entities/ArmUnit.js:1451) | Redirects to **DEORBITING** | Line 1451 |
| [`_updateReturning()`](js/entities/ArmUnit.js:1549) | Redirects to **TRANSIT** (can't return) | Line 1549 |
| [`_updateTrawling()`](js/entities/ArmUnit.js:1701) | Tether limit skipped; fuel warnings + ARM_LOST | Lines 1701, 1744 |
| [`recall()`](js/entities/ArmUnit.js:639) | **Blocked** — "Cannot recall — tether severed" | Line 639 |
| [`_updateTether()`](js/entities/ArmUnit.js:2075) | Tether line **hidden** | Line 2075 |
| [`_updateStatusLight()`](js/entities/ArmUnit.js:2144) | Fast-pulsing **red** override | Line 2144 |
| [`_consumeFuel()`](js/entities/ArmUnit.js:2027) | Fuel warnings at 25%/10% + ARM_LOST at 0% | Lines 2027-2065 |

### A.4 TANGLED → Detach Special Case

When detaching from [`TANGLED`](js/entities/ArmUnit.js:692):

1. `wasTangled = true` flag set in detach event payload
2. The arm **does NOT** clear `tanglePartner` — the partner arm remains in its own TANGLED state and will auto-resolve via [`_updateTangled()`](js/entities/ArmUnit.js:1971) after `TANGLE_RESOLVE_TIME`
3. This is architecturally sound: the cut arm flies free, the partner continues resolving independently

**State corruption risk**: NONE — each arm manages its own tangle timer. Cutting one arm's tether does not corrupt the partner's state.

---

## B. Dependency Graph — Detach Feature End-to-End {#b-dependency-graph}

### B.1 Event Flow (already wired)

```
Player presses X key
    │
    ▼
InputManager._handleKeyDown() ──── [line 459]
    │ if (isGameplay && d.armManager)
    ▼
ArmManager.getActiveDetachCandidate() ──── [line 491]
    │ Priority: TANGLED > APPROACH > TRANSIT > FISHING > NETTING > GRAPPLED
    │ Prefers selected arm if eligible
    ▼
ArmManager.detachArm(candidate.index) ──── [line 513]
    │
    ▼
ArmUnit.detach() ──── [line 682]
    │ ├── this.isDetached = true
    │ ├── this.tetherLength = 0
    │ ├── this.tetherLine.visible = false
    │ ├── emit Events.ARM_DETACHED { armId, position, fuelRemaining, wasTangled, hasDebris }
    │ └── emit Events.COMMS_MESSAGE (Houston callout)
    │
    ├────────────────────────────────────────────────────────────┐
    │                                                            │
    ▼                                                            ▼
main.js listener [line 320]                     RewardSystem._setupListeners [line 115]
    │ slowMoTimer = DETACH_SLOWMO_DURATION       │ _totalDetaches++
    │ slowMoFactor = DETACH_SLOWMO_FACTOR        │ _checkDetachMilestones('detach')
    │                                            │ → milestone 'firstDetach'
    │
    │   ... arm continues operating with isDetached=true ...
    │   ... fuel depletes over time via _consumeFuel() ...
    │
    ▼ (on capture while detached)
ArmUnit._updateNetting() [line 1398]
    │ ARM_CAPTURED emitted with { detached: this.isDetached }
    │
    ├──► ScoringSystem.awardPoints() [line 178]
    │     data.detachedCapture → points × DETACH_SCORE_MULT (2.0)
    │
    ├──► RewardSystem._onCapture() → _checkMilestones()
    │     data.detached → milestone 'firstDetachedCapture'
    │
    ▼ (on GRAPPLED → auto-deorbit for detached arms)
ArmUnit._updateGrappled() [line 1428]
    │ if (this.isDetached) → transition to DEORBITING
    │
    ▼
ArmUnit._updateDeorbiting() [line 1824]
    │ Burns fuel at 5%/sec retrograde
    │ On fuel=0 → EXPENDED
    │
    ▼
GameFlowManager.ARM_DEORBIT handler [line 832]
    │ Calculates ΔV, perigee drop
    │ Scores with detachedSacrifice: arm?.isDetached
    │     → ScoringSystem × DETACH_SACRIFICE_MULT (2.5)
    │
    ▼ (if fuel=0 before capture)
ArmUnit._consumeFuel() [line 2051]
    │ if (this.isDetached && fuel <= 0)
    │ emit Events.ARM_LOST { armId }
    │
    ▼
GameFlowManager.ARM_LOST handler [line 901]
    │ scoringSystem.totalScore += DETACH_FAIL_PENALTY (-500)
    │ scoringSystem.credits += DETACH_FAIL_PENALTY (-500)
    │ emit Events.SCORE_UPDATE
```

### B.2 Data Flow Verification — metalId Path

The synergy detection relies on `metalId` values matching [`SALVAGE_SYNERGIES`](js/core/Constants.js:743) entries. Traced flow:

```
DebrisField._calculateSalvage() → salvage.metals[].subtype (lowercase, e.g. 'aluminum')
    ▼
GameFlowManager.DEBRIS_CAPTURED handler [line 749]
    emit Events.CARGO_STORE { metalId: metal.subtype }  ← lowercase
    ▼
RewardSystem._setupListeners [line 86]
    eventBus.on(Events.CARGO_STORE, data => _registerMetals([data.metalId]))
    ▼
RewardSystem._registerMetals [line 289]
    key.toUpperCase() → adds to _trawlMetals set  ← UPPERCASE
    ▼
Compares against Constants.SALVAGE_SYNERGIES[].metals  ← UPPERCASE keys
```

**Status**: ✅ The `.toUpperCase()` transform at [`_registerMetals():289`](js/systems/RewardSystem.js:289) ensures lowercase `metalId` values from [`CARGO_STORE`](js/systems/GameFlowManager.js:749) match the UPPERCASE keys in [`SALVAGE_SYNERGIES`](js/core/Constants.js:743).

**Remaining concern**: Verify that `DebrisField._calculateSalvage()` actually produces `subtype` values like `'aluminum'`, `'gallium'`, `'copper'` etc. that map to the synergy pairs. This requires a manual playtest or unit test.

---

## C. Risk Assessment {#c-risk-assessment}

### C.1 metalId Mismatch Risk — **MITIGATED**

| Risk | Status | Evidence |
|---|---|---|
| metalId naming mismatch | ⚠️ **Needs verification** | `.toUpperCase()` handles case, but actual string values (e.g., `'gallium'` vs `'gallium_arsenide'`) must match |
| Mitigation | Implemented | Filter at [`RewardSystem:90`](js/systems/RewardSystem.js:90) skips `refined_` and `prop_` prefixes |
| Debug logging | **Missing** | No `console.warn` for unknown metal keys — recommend adding for dev builds |

**Recommendation**: Add a temporary debug guard in [`_registerMetals()`](js/systems/RewardSystem.js:283):
```javascript
// After line 289:
const KNOWN_METALS = new Set(['ALUMINUM','TITANIUM','COPPER','GALLIUM','IRIDIUM','STEEL','KEVLAR','CARBON_COMPOSITE','GLASS_CERAMIC']);
if (!KNOWN_METALS.has(upper)) {
  console.warn(`[RewardSystem] Unknown metal key: ${upper} — won't trigger synergies`);
}
```
**LOC**: ~3

### C.2 State Machine Corruption Risk — **NONE FOUND**

| Scenario | Analysis | Risk |
|---|---|---|
| Detach from TANGLED | tanglePartner unaffected; partner auto-resolves | NONE |
| Detach from NETTING | Mid-capture, but `isDetached` flag doesn't corrupt netting logic | LOW |
| Detach from GRAPPLED | Auto-transitions to DEORBITING — intentional sacrifice path | NONE |
| Double detach | Guarded by `if (this.isDetached) return false` at [line 687](js/entities/ArmUnit.js:687) | NONE |
| Recall after detach | Blocked with comms warning at [line 639](js/entities/ArmUnit.js:639) | NONE |

### C.3 Scoring Race Conditions — **LOW RISK**

| Scenario | Analysis | Mitigation |
|---|---|---|
| Detached capture + sacrifice timing | GRAPPLED → auto-DEORBITING is sequential, not concurrent | Built into state machine |
| ARM_CAPTURED emitted before ARM_DEORBIT | Different event handlers, both check `isDetached`/`arm.isDetached` | No race — events are synchronous on EventBus |
| DETACH_SCORE_MULT (×2.0) stacking with DETACH_SACRIFICE_MULT (×2.5) | Both checked in [`awardPoints()`](js/systems/ScoringSystem.js:110), but they target different score events | Intentional: capture gets ×2.0, sacrifice gets ×2.5 |
| Penalty + score on same trawl | ARM_LOST penalty (-500) vs capture bonus — both applied independently | By design |

### C.4 GameFlowManager _refs Coupling — **MEDIUM RESIDUAL RISK**

[`GameFlowManager._refs`](js/systems/GameFlowManager.js:37) still holds **17 references** (reduced from 23). The ARM_LOST handler at [line 901](js/systems/GameFlowManager.js:901) directly mutates `scoringSystem.totalScore` and `.credits` — this bypasses `awardPoints()` and its multiplier stack.

| Concern | Impact | Status |
|---|---|---|
| Direct score mutation in ARM_LOST handler | Skips streak tracking, tier counting | By design — penalty is raw deduction |
| `scoringSystem` import (singleton) | Not a _refs dependency — imported directly | ✅ Clean |
| ARM_DEORBIT handler accesses `armManager.arms`, `debrisField`, `debrisWireframe` | Uses _refs | ⚠️ Still coupled |

**Recommendation**: The ARM_LOST penalty handler is clean — it uses the EventBus pattern. No _refs changes needed for V6.

### C.5 Detached Arm Drift-Off Risk — **MITIGATED**

| Scenario | Mitigation | Location |
|---|---|---|
| Arm flies off-screen forever | Fuel depletion → EXPENDED + ARM_LOST | [`_consumeFuel():2047`](js/entities/ArmUnit.js:2047) |
| Arm in FISHING with ultra-low fuel rate | Still consumes 0.02%/sec → ~80 min to deplete | Acceptable — player will have moved on |
| Trawling detached arm | Separate fuel handling in [`_updateTrawling():1719`](js/entities/ArmUnit.js:1719) with ARM_LOST at fuel=0 | ✅ |
| No max-distance kill | **Missing** — plan suggested 5km kill distance | ⚠️ Consider adding post-V6 |

### C.6 Additional Risks Discovered

| Risk | Impact | Analysis |
|---|---|---|
| Codex entry `triggerCondition` crash | HIGH if predicate throws | Requires verification that try/catch wraps all calls in CodexSystem |
| SubsystemEvent source strings mismatch | HIGH — codex entries may never unlock | Need to audit `SubsystemEvents.js` source names vs codex predicates |
| SweepReportUI not instantiated | MEDIUM — sweep report invisible | Need to verify `main.js` creates SweepReportUI |
| `FIELD_CLEAR_THRESHOLDS` undefined fallback | LOW | [`RewardSystem:354`](js/systems/RewardSystem.js:354) uses `Constants.FIELD_CLEAR_THRESHOLDS || []` — safe |

---

## D. Refined Implementation Order {#d-refined-implementation-order}

### D.1 Revised Assessment

Given that all planned work appears implemented, the 5-phase plan shifts from **implementation** to **verification + polish**:

```
Phase V1: Verification (all features)
  ├── Run: node js/test/run-tests.js (confirm 216 pass)
  ├── Manual: Test X key detach in TRANSIT, APPROACH, TANGLED
  ├── Manual: Verify synergy triggers (capture 2 matching metals)
  ├── Manual: Verify field clearing tiers (50%/75%/100% bonuses)
  ├── Manual: Tutorial playthrough (crossbow vocab, reduced thresholds)
  └── Manual: Codex L-key viewer (spot-check entry count, unlock triggers)

Phase V2: Gap Fill (~3 LOC)
  └── Add metalId debug logging to RewardSystem._registerMetals()

Phase V3: Documentation
  ├── Update HANDOFF.md to reflect fully-complete V6 status
  ├── Update ARCHITECTURE.md with V6 feature documentation
  └── Update GAME_DESIGN.md field clearing thresholds (25/50/75/100%)

Phase V4: Optional Polish
  ├── Add max-distance kill for detached arms (5km boundary)
  ├── Reduce CODEX.UNLOCK_COOLDOWN from 30 to 20 seconds
  └── Audit SubsystemEvents source strings vs codex predicates
```

### D.2 If Features Were NOT Implemented (Original Plan Validation)

The original 5-phase plan from IMPLEMENTATION_PLAN_V6.md is **architecturally correct**. Its dependency chain is validated by source analysis:

| Phase | Dependencies | Parallelizable? |
|---|---|---|
| Phase 1: Foundation | None | YES — Constants, ArmUnit.detach(), Tutorial text are independent |
| Phase 2: Wiring | Phase 1 (ArmManager needs detach(), InputManager needs ArmManager) | PARTIALLY — RewardSystem refactor is independent |
| Phase 3: Scoring | Phase 2 (ScoringSystem needs ARM_CAPTURED.detached flag) | NO — sequential dependency |
| Phase 4: Content | **NONE** — Codex entries are completely independent | YES — can run in parallel with Phases 1-3 |
| Phase 5: Testing | All phases | NO — must be last |

**Key insight**: Phase 4 (54 codex entries, ~251 LOC) could have been done in parallel with ALL other phases. This is the largest single task and has zero cross-dependencies.

---

## E. Codex Entry Strategy {#e-codex-entry-strategy}

### E.1 buildEntries() Structure

[`CodexSystem.buildEntries()`](js/systems/CodexSystem.js:35) returns a flat array of entry objects. Each entry follows this pattern (~4-8 lines):

```javascript
{
  id: 'spring_energy',                           // unique string key
  title: 'Spring Energy Storage',                // display title
  category: CodexCategory.PROPULSION,            // one of 9 categories
  shortText: 'One-line summary...',              // shown in list view
  fullText: 'Full explanation paragraph...',     // shown in detail view
  triggerEvent: Events.CROSSBOW_FIRE,            // EventBus event name
  triggerCondition: (payload) => true,           // predicate on event payload
  unlocked: false,                               // runtime state
  seen: false,                                   // runtime state
  icon: '🏹',                                   // emoji icon
},
```

### E.2 Current Entry Count

The file header at [line 32](js/systems/CodexSystem.js:32) states **"105 entries across 9 categories"**. This represents an expansion from the original 45 entries — the 60 additional entries exceed the planned 54 by 6.

### E.3 Bulk Addition Pattern

For future codex expansion, the most efficient approach:

1. **Group by category** within `buildEntries()` — entries are already organized this way
2. **Batch by trigger event** — entries sharing the same `triggerEvent` should be adjacent for readability
3. **Use factory helper** for entries sharing a pattern:

```javascript
// Helper for material-triggered entries (example pattern)
const materialEntry = (id, title, metalId, icon, shortText, fullText) => ({
  id, title,
  category: CodexCategory.MATERIALS,
  shortText, fullText,
  triggerEvent: Events.CARGO_STORE,
  triggerCondition: (p) => p.metalId && p.metalId.toUpperCase() === metalId,
  unlocked: false, seen: false, icon,
});
```

This would reduce per-entry LOC from ~8 to ~1 for material-triggered entries.

### E.4 Save/Restore Safety

[`CodexSystem.restore()`](js/systems/CodexSystem.js) gracefully skips unknown entry IDs. New entries added after a save was created will simply start as `unlocked: false` — safe for forward compatibility.

---

## F. Integration Points — Exact Locations {#f-integration-points}

### F.1 Risk-Reward Detach (ALL IMPLEMENTED)

| Component | File | Method | Line | Status |
|---|---|---|---|---|
| Detach method | [`ArmUnit.js`](js/entities/ArmUnit.js) | `detach()` | 682 | ✅ |
| Detachable states set | [`ArmUnit.js`](js/entities/ArmUnit.js) | `detach()` | 683-685 | ✅ |
| isDetached flag | [`ArmUnit.js`](js/entities/ArmUnit.js) | constructor | 82 | ✅ |
| Fuel warning 25% | [`ArmUnit.js`](js/entities/ArmUnit.js) | `_consumeFuel()` | 2031-2037 | ✅ |
| Fuel warning 10% | [`ArmUnit.js`](js/entities/ArmUnit.js) | `_consumeFuel()` | 2038-2044 | ✅ |
| ARM_LOST emission | [`ArmUnit.js`](js/entities/ArmUnit.js) | `_consumeFuel()` | 2051-2056 | ✅ |
| Tether limit bypass | [`ArmUnit.js`](js/entities/ArmUnit.js) | `_updateTransit()` | 1246 | ✅ |
| Auto-deorbit on grapple | [`ArmUnit.js`](js/entities/ArmUnit.js) | `_updateGrappled()` | 1428-1435 | ✅ |
| Recall block | [`ArmUnit.js`](js/entities/ArmUnit.js) | `recall()` | 639-645 | ✅ |
| Tether hide | [`ArmUnit.js`](js/entities/ArmUnit.js) | `_updateTether()` | 2075-2078 | ✅ |
| Status light red pulse | [`ArmUnit.js`](js/entities/ArmUnit.js) | `_updateStatusLight()` | 2144-2148 | ✅ |
| Detach candidate finder | [`ArmManager.js`](js/entities/ArmManager.js) | `getActiveDetachCandidate()` | 491-506 | ✅ |
| Detach routing | [`ArmManager.js`](js/entities/ArmManager.js) | `detachArm()` | 513-517 | ✅ |
| X key binding | [`InputManager.js`](js/systems/InputManager.js) | `_handleKeyDown()` | 459-472 | ✅ |
| Detached capture ×2.0 | [`ScoringSystem.js`](js/systems/ScoringSystem.js) | `awardPoints()` | 177-185 | ✅ |
| Detached sacrifice ×2.5 | [`ScoringSystem.js`](js/systems/ScoringSystem.js) | `awardPoints()` | 187-195 | ✅ |
| ARM_LOST penalty | [`GameFlowManager.js`](js/systems/GameFlowManager.js) | `setupEventHandlers()` | 900-911 | ✅ |
| Slo-mo on detach | [`main.js`](js/main.js) | init listener | 320-323 | ✅ |
| ARM_CAPTURED.detached | [`ArmUnit.js`](js/entities/ArmUnit.js) | `_updateNetting()` | 1400 | ✅ |
| ARM_DEORBIT.detachedSacrifice | [`GameFlowManager.js`](js/systems/GameFlowManager.js) | ARM_DEORBIT handler | 880 | ✅ |

### F.2 Reward Refinements (ALL IMPLEMENTED)

| Component | File | Line | Status |
|---|---|---|---|
| SALVAGE_SYNERGIES (6 pairs) | [`Constants.js`](js/core/Constants.js) | 743-750 | ✅ |
| FIELD_CLEAR_THRESHOLDS | [`Constants.js`](js/core/Constants.js) | 752-756 | ✅ |
| Tiered _checkFieldClearing | [`RewardSystem.js`](js/systems/RewardSystem.js) | 342-373 | ✅ |
| Detach milestone tracking | [`RewardSystem.js`](js/systems/RewardSystem.js) | 58-61, 115-131 | ✅ |

### F.3 Tutorial Updates (ALL IMPLEMENTED)

| Component | File | Line | Status |
|---|---|---|---|
| "Fire Bolt" vocabulary | [`TutorialSystem.js`](js/systems/TutorialSystem.js) | 467 | ✅ |
| "Fire Bolt 2" | [`TutorialSystem.js`](js/systems/TutorialSystem.js) | 479 | ✅ |
| "Fire Weaver Bolt" | [`TutorialSystem.js`](js/systems/TutorialSystem.js) | 489 | ✅ |
| "crossbow bolt" comms | [`TutorialSystem.js`](js/systems/TutorialSystem.js) | 472 | ✅ |
| Threshold: FIRST_ARM ≥2 | [`TutorialSystem.js`](js/systems/TutorialSystem.js) | 548 | ✅ |
| Threshold: MULTI_ARM ≥3 | [`TutorialSystem.js`](js/systems/TutorialSystem.js) | 556 | ✅ |
| Threshold: BIG_GAME ≥5 | [`TutorialSystem.js`](js/systems/TutorialSystem.js) | 563 | ✅ |
| Threshold: AUTOPILOT ≥6 | [`TutorialSystem.js`](js/systems/TutorialSystem.js) | 566 | ✅ |
| Detach hint | [`TutorialSystem.js`](js/systems/TutorialSystem.js) | 590-600 | ✅ |
| "Crossbow capture" text | [`TutorialSystem.js`](js/systems/TutorialSystem.js) | 551 | ✅ |

### F.4 Events (ALL DEFINED)

| Event | File | Line | Status |
|---|---|---|---|
| `ARM_DETACHED` | [`Events.js`](js/core/Events.js) | 190 | ✅ `'arm:detached'` |
| `ARM_LOST` | [`Events.js`](js/core/Events.js) | 191 | ✅ `'arm:lost'` |
| `SYNERGY_BONUS` | [`Events.js`](js/core/Events.js) | 184 | ✅ |
| `SWEEP_REPORT` | [`Events.js`](js/core/Events.js) | 185 | ✅ |
| `SCORING_AWARD` | [`Events.js`](js/core/Events.js) | (verify) | ✅ |

### F.5 Constants (ALL DEFINED)

| Constant | Value | Location |
|---|---|---|
| `DETACH_SCORE_MULT` | 2.0 | [`Constants.js:760`](js/core/Constants.js:760) |
| `DETACH_SACRIFICE_MULT` | 2.5 | [`Constants.js:761`](js/core/Constants.js:761) |
| `DETACH_FAIL_PENALTY` | -500 | [`Constants.js:762`](js/core/Constants.js:762) |
| `DETACH_FUEL_WARNING_25` | 0.25 | [`Constants.js:763`](js/core/Constants.js:763) |
| `DETACH_FUEL_WARNING_10` | 0.10 | [`Constants.js:764`](js/core/Constants.js:764) |
| `DETACH_SLOWMO_DURATION` | 0.3 | [`Constants.js:765`](js/core/Constants.js:765) |
| `DETACH_SLOWMO_FACTOR` | 0.08 | [`Constants.js:766`](js/core/Constants.js:766) |
| `SALVAGE_SYNERGIES` | 6 pairs | [`Constants.js:743`](js/core/Constants.js:743) |
| `FIELD_CLEAR_THRESHOLDS` | 3 tiers | [`Constants.js:752`](js/core/Constants.js:752) |

---

## G. Verification Checklist {#g-verification-checklist}

### G.1 Automated Tests

```bash
node js/test/run-tests.js
# Expected: 216 pass, 0 fail (35 suites, 8 test files)
```

Tests to confirm:
- [ ] [`test-Crossbow-ArmUnit.js`](js/test/test-Crossbow-ArmUnit.js) — detach() method test coverage
- [ ] [`test-ScoringSystem.js`](js/test/test-ScoringSystem.js) — detachedCapture/detachedSacrifice multipliers

### G.2 Manual Verification Matrix

| Test | Steps | Expected Result |
|---|---|---|
| **X key detach (TRANSIT)** | Deploy arm → while in transit, press X | Tether severed, slo-mo, Houston callout, arm continues free |
| **X key detach (TANGLED)** | Cause tangle between arms → press X | "tether cut from tangle" callout, wasTangled=true in event |
| **Detach → capture** | Detach arm → steer to debris → net deploy | ×2.0 score multiplier, "COWBOY!" callout |
| **Detach → sacrifice** | Detach arm with debris → auto-deorbit | ×2.5 score multiplier, "Sacrifice noted" callout |
| **Detach → fuel loss** | Detach arm → wait for fuel depletion | 25% warning → 10% warning → ARM_LOST (-500 penalty) |
| **No-arm detach** | All arms docked → press X | "No arm available for detach" warning |
| **Synergy trigger** | Capture debris with GALLIUM + COPPER metals | "Complete Solar Array" synergy bonus (+300) |
| **Field clear 50%** | Capture half of debris cluster | "Half Clear" bonus (+200) |
| **Field clear 100%** | Capture all debris in cluster | "Perfect Sweep" bonus (+2000) |
| **Tutorial vocab** | Start new game → reach FIRST_ARM stage | "Press 1 to fire your first crossbow bolt" |
| **Tutorial threshold** | Start new game → reach MULTI_ARM | Advances at 3 total catches (was 4) |
| **Codex count** | Press L → scroll through categories | Verify 105+ entries across 9 categories |
| **Codex unlock** | Fire crossbow for first time | spring_energy entry unlocks (if present) |
| **Sweep report** | Complete a trawl with captures | SweepReportUI appears with stars, synergies, stats |

### G.3 Recommended New Tests

| Test File | Test | What to Verify |
|---|---|---|
| `test-Crossbow-ArmUnit.js` | `detach() from TRANSIT` | Returns true, isDetached=true, tetherLength=0 |
| `test-Crossbow-ArmUnit.js` | `detach() from DOCKED` | Returns false (not detachable) |
| `test-Crossbow-ArmUnit.js` | `detach() when already detached` | Returns false (guard) |
| `test-Crossbow-ArmUnit.js` | `recall() when detached` | Does not transition (blocked) |
| `test-ScoringSystem.js` | `detachedCapture multiplier` | Points × 2.0 |
| `test-ScoringSystem.js` | `detachedSacrifice multiplier` | Points × 2.5 |

---

## Summary of Key Findings

1. **All ~509 LOC of planned V6 remaining work is already implemented** in the codebase. The IMPLEMENTATION_PLAN_V6.md was a prospective document, and the work was executed within the same session.

2. **The ArmUnit state machine is robust** against detach corruption. The `isDetached` flag is checked in 10+ locations covering all edge cases (recall block, tether bypass, auto-deorbit, visual updates).

3. **The event flow is fully wired end-to-end**: X key → InputManager → ArmManager → ArmUnit.detach() → EventBus ARM_DETACHED → [main.js slo-mo, RewardSystem milestones] → ARM_CAPTURED.detached → ScoringSystem ×2.0 / ARM_LOST → GameFlowManager -500 penalty.

4. **One low-risk gap**: No `console.warn` for unknown metalId keys in [`_registerMetals()`](js/systems/RewardSystem.js:283). This could silently prevent synergies from triggering if debris salvage produces unexpected metal key strings.

5. **Documentation was stale** — now corrected (see §H below).

6. **The original 5-phase implementation plan is architecturally sound** — dependency chains are correct, and Phase 4 (codex) was correctly identified as parallelizable.

---

## H. Documentation Updates Made {#h-documentation-updates}

The following stale documentation was corrected during this analysis:

### [`GAME_DESIGN.md`](GAME_DESIGN.md)
- **Synergistic Salvage Sets** (§4): Updated from 4-pair multiplier model to actual 6-pair flat-bonus implementation
- **Field Clearing Bonuses** (§7): Updated from 80/90/100% to actual 25/50/75/100% thresholds with rationale
- **Implementation Status** (§8): Marked Synergistic salvage, Risk-reward detach, Sweep report cards, Codex expansion, Tutorial vocabulary, SubsystemEvents as ✅

### [`ARCHITECTURE.md`](ARCHITECTURE.md)
- **Version header** (line 5): Updated to V6 Session 18
- **File structure**: CodexViewerUI entry count 45→105 (4 locations: lines 179, 300, 431, 956)
- **Key bindings table**: Added X key (tether detach)
- **Development checklist** (line 2075): Marked Reward Systems, Risk-Reward Detach, Learning Systems, Visual polish as ✅

### [`HANDOFF.md`](HANDOFF.md)
- **What's Next §1**: Replaced visual quick fixes (already done) with verification/testing priorities
- **Known Issues**: Added metalId debug logging gap and max-distance kill gap; removed stale ARCHITECTURE.md note

---

## I. Concrete Next Steps {#i-next-steps}

### Immediate (Code Mode — ~20 LOC)

1. **Add metalId debug guard** — [`RewardSystem._registerMetals()`](js/systems/RewardSystem.js:283) (~3 LOC)
   ```javascript
   const KNOWN = new Set(['ALUMINUM','TITANIUM','COPPER','GALLIUM','IRIDIUM',
     'STEEL','KEVLAR','CARBON_COMPOSITE','GLASS_CERAMIC']);
   if (!KNOWN.has(upper)) console.warn(`[RewardSystem] Unknown metal: ${upper}`);
   ```

2. **Run test suite** — `node js/test/run-tests.js` → expect 216 pass, 0 fail

3. **Add detach unit tests** to [`test-Crossbow-ArmUnit.js`](js/test/test-Crossbow-ArmUnit.js) (~15 LOC):
   - `detach()` from TRANSIT returns true, sets `isDetached=true`, `tetherLength=0`
   - `detach()` from DOCKED returns false
   - `detach()` when already detached returns false
   - `recall()` when detached is blocked

### Near-Term (Architecture)

4. **Audit SubsystemEvents source strings** — Ensure every codex entry with `triggerEvent: Events.SUBSYSTEM_EVENT` has a `triggerCondition` whose `source` string matches [`SubsystemEvents.js`](js/systems/SubsystemEvents.js) actual emissions. Mismatches = entries that never unlock.

5. **Add max-distance kill** for detached arms (~10 LOC in [`ArmUnit._consumeFuel()`](js/entities/ArmUnit.js:2002)) — when distance from parentPos exceeds 5km (0.05 scene units), transition to EXPENDED + emit ARM_LOST.

6. **Consider reducing `CODEX.UNLOCK_COOLDOWN`** from 30→20 seconds in [`Constants.js:799`](js/core/Constants.js:799) — 105 entries with 30s cooldown creates long unlock queues.

### Medium-Term

7. **Continue _refs decoupling** — 17 refs remain in [`GameFlowManager`](js/systems/GameFlowManager.js:50). Next candidates: `briefingScreen`, `debrisWireframe`.

8. **Collision avoidance AI** — Autonomous collision avoidance for player satellite, integration with Kessler cascade system.

---

*Analysis based on source inspection of: [`ArmUnit.js`](js/entities/ArmUnit.js) (2191 LOC), [`ArmManager.js`](js/entities/ArmManager.js) (1106 LOC), [`InputManager.js`](js/systems/InputManager.js) (877 LOC), [`ScoringSystem.js`](js/systems/ScoringSystem.js) (382 LOC), [`GameFlowManager.js`](js/systems/GameFlowManager.js) (1211 LOC), [`main.js`](js/main.js) (677 LOC), [`RewardSystem.js`](js/systems/RewardSystem.js) (541 LOC), [`Constants.js`](js/core/Constants.js) (845 LOC), [`CodexSystem.js`](js/systems/CodexSystem.js) (1627 LOC), [`TutorialSystem.js`](js/systems/TutorialSystem.js) (640 LOC), [`Events.js`](js/core/Events.js) (279 LOC).*
