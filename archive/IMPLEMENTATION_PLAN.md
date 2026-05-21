# Space Cowboy — Implementation Plan (✅ COMPLETE)

> **Generated:** 2026-04-09 (Session 17 — Deep analysis + doc cross-reference)
> **Completed:** 2026-04-11 — All 11 sprints (S1–S10 + S3b) delivered. ~2,300+ LOC across 30+ files.
> **Scope:** All 6 design docs, all 45 modules (~22K LOC), every `Constants.js` constant (~700 LOC), all `Events.js` events (~135)
> **Purpose:** Implementation log — all sprints delivered. Retained as historical record of decisions made.

---

## 0. Priority Validation — What the Docs Actually Say

The initial analysis proposed this priority order:
1. Economy Visibility (~55 LOC)
2. Gameplay Balance Pass
3. Core Feel Overhaul
4. Tab/Lasso Targeting Fix
5. NavSphere Redesign Phase 1
6. Unit Test Infrastructure
7. Target Panel Redesign Phase 1
8. Trawl System

**After reading all 6 design docs and cross-referencing the source code, this order requires adjustment:**

### What the Analysis Missed

1. **Many "unwired" systems are already wired.** [`NEXT_STEPS.md`](NEXT_STEPS.md) "Verified Systems" (lines 234-258) confirms these are ✅ complete: bounty premiums in [`ScoringSystem`](js/systems/ScoringSystem.js:112), elevator contract via [`CONTRACT_COMPLETE`](js/core/Events.js:155) → `GAME_WIN`, EDT attract in [`DebrisField._onEdtAttract()`](js/entities/DebrisField.js), arm selection 1-6 via [`_handleArmKey()`](js/systems/InputManager.js), trawling via [`ArmUnit._updateTrawling()`](js/entities/ArmUnit.js), sweep reports via [`SweepReportUI`](js/ui/SweepReportUI.js). Session 15-16 implemented all of these.

2. **Economy visibility is less work than estimated.** The cargo summary line already exists at [`StatusPanel.js:214`](js/ui/hud/StatusPanel.js:214) (`#cargo-summary`). The forge inline display exists at [`StatusPanel.js:215-231`](js/ui/hud/StatusPanel.js:215) (`#forge-inline`). The `[T]` fuel hint exists at [`StatusPanel.js:204-206`](js/ui/hud/StatusPanel.js:204) (`#fuel-type-indicator`). The gap is **discovery** — these elements only appear after specific triggers and are activated too late in the tutorial (cargo-group is stage 8/FREE_PLAY per [`FULL_HUD_STRATEGY.md`](FULL_HUD_STRATEGY.md) §2.4).

3. **The ORCHESTRATOR_BRIEF timeline says "Phase 1: Core Feel" is NEXT.** Lines 336-341: `DONE: Phase 4 (Tutorial) / DONE: Phase 8 (Audio) / NEXT: Phase 1 (Core Feel)`. This aligns with [`GAMEPLAY_LOOP.md`](GAMEPLAY_LOOP.md) §1 (jellyfish trawl) which describes the *feel* the game is moving toward.

4. **The sim vs arcade identity question** ([`FULL_HUD_STRATEGY.md`](FULL_HUD_STRATEGY.md) §13) is a **strategic design decision** that affects multiple sprints. It needs a user decision before certain UI work proceeds.

### Revised Priority Order

| # | Item | Why This Order | Est. LOC | Status |
|---|------|----------------|----------|--------|
| **S1** | Bug Fixes (C2, M1, L1, L2) | Fix broken behavior before adding features | ~80 | ✅ |
| **S2** | Economy Discovery | Highest-impact, lowest-effort; reveals the hidden game | ~120 | ✅ |
| **S3** | Gameplay Balance Pass | Tune Constants.js after bugs fixed; needs playtesting | ~40 | ✅ |
| **S3b** | MPD Ludicrous Mode | Restore MPD to 150kW with power upgrade chain | ~365 | ✅ |
| **S4** | Core Feel Phase 1 | The docs say this is NEXT; transforms the game identity | ~200 | ✅ |
| **S5** | NavSphere Redesign Phase 1 | 660-line spec ready; enables jellyfish visualization | ~325 | ✅ |
| **S6** | Target Panel Redesign Phase 1 | 1,410-line spec ready; fixes 1080p cramping | ~237 | ✅ |
| **S7** | Trawl System Polish | Depends on Core Feel; the destination mechanic | ~195 | ✅ |
| **S8** | Unit Test Infrastructure | Safety net for everything above | ~530 | ✅ |
| **S9** | Sim Identity Reframe | Needs user design decision; pervades UI | ~120 | ✅ |
| **S10** | Audio Polish (Forge + Codex) | Last remaining audio gaps from NEXT_STEPS P3 | ~85 | ✅ |

---

## Sprint 1: Bug Fixes ✅

**Status:** COMPLETE — Lasso/Tab targeting unified, scoring source of truth consolidated, pause event constants added, win guard implemented. ~80 LOC.

**Goal:** Fix all confirmed bugs without changing game behavior.
**Definition of Done:** Each bug has a specific test condition that passes.
**Dependencies:** None.
**Estimated LOC:** ~60 | **Time:** 1 session

### C2: Tab vs Lasso Auto-Aim Mismatch

**Problem:** [`LassoSystem.fire()`](js/systems/LassoSystem.js:204) finds the nearest debris within a ±30° cone of the prograde direction (lines 223-252). It completely ignores the Tab-selected target from [`TargetSelector`](js/systems/TargetSelector.js). Players Tab to select a target, press Space, and the lasso flies at a different piece of debris.

**Root Cause:** [`fire()`](js/systems/LassoSystem.js:204) receives `playerPos`, `debrisField`, and `playerVelDir` but NOT the currently selected target. The auto-aim at line 223-252 runs a proximity search against all debris in range, sorted by distance within the ±30° cone.

**Fix:**

**File: [`js/systems/LassoSystem.js`](js/systems/LassoSystem.js:204)**
```
fire(playerPos, debrisField, playerVelDir, selectedTarget = null)
```

Add `selectedTarget` parameter. Before the auto-aim loop, check if the selected target is in range:

```javascript
// PRIORITY 1: If player has Tab-selected a target and it's in range, use it
if (selectedTarget) {
    const selectedPos = this._getDebrisScenePos(selectedTarget);
    if (selectedPos) {
        const dist = playerPos.distanceTo(selectedPos);
        const mass = selectedTarget.mass || 1;
        if (dist <= rangeScene && mass <= Constants.LASSO_MAX_CAPTURE_MASS) {
            bestTarget = selectedTarget;
            bestPos = selectedPos;
            bestDist = dist;
        }
    }
}

// PRIORITY 2: Fall back to auto-aim only if no selected target in range
if (!bestTarget) {
    // ... existing auto-aim loop (lines 232-252)
}
```

**File: [`js/systems/InputManager.js`](js/systems/InputManager.js)** — Where `lassoSystem.fire()` is called, pass the active target:
```javascript
const activeTarget = this._refs.targetSelector?.getActiveTarget?.();
const activeDebris = activeTarget ? this._refs.debrisField?.getDebrisById?.(activeTarget.id) : null;
lassoSystem.fire(playerPos, debrisField, playerVelDir, activeDebris);
```

**LOC:** ~20
**Test:** Tab-select a specific target → press Space → lasso flies at that target, not the nearest one in the cone.

---

### M1: Double Debris Counting

**Problem:** Two independent counters track debris cleared:
1. [`ScoringSystem.debrisCleared`](js/systems/ScoringSystem.js:172) — incremented in `awardPoints()` at line 172
2. [`gameState.debrisCleared`](js/core/GameState.js:128) — incremented via `gameState.clearDebris()` called at [`GameFlowManager.js:786`](js/systems/GameFlowManager.js:786)

Both counters check for win condition independently:
- [`ScoringSystem.js:190`](js/systems/ScoringSystem.js:190): `if (this.debrisCleared >= Constants.WIN_DEBRIS_COUNT)`
- [`GameState.js:109`](js/core/GameState.js:109): `if (this.debrisCleared >= Constants.WIN_DEBRIS_COUNT)`

Both emit [`Events.GAME_WIN`](js/core/Events.js:47). If they're not synchronized, the game could win at different counts or fire `GAME_WIN` twice.

**Fix:** Make [`gameState`](js/core/GameState.js) the single source of truth. Remove the independent counter from [`ScoringSystem`](js/systems/ScoringSystem.js).

**File: [`js/systems/ScoringSystem.js`](js/systems/ScoringSystem.js:170-192)**
```javascript
// Line 172: REMOVE this.debrisCleared += 1;
// Instead, gameState.clearDebris() (called by GameFlowManager) is the single source.
// Line 190-192: REMOVE the win condition check from here.
// The win check in GameState.clearDebris() is the canonical one.
```

Update `awardPoints()` to read `debrisCleared` from gameState instead of its own counter:

```javascript
// In SCORE_UPDATE emission (line 181-187), use gameState.debrisCleared:
import { gameState } from '../core/GameState.js';
// ...
eventBus.emit(Events.SCORE_UPDATE, {
    total: this.totalScore,
    credits: this.credits,
    delta: points,
    debrisCleared: gameState.debrisCleared,  // ← single source
    streak: this.currentStreak,
});
```

Keep `this.debrisCleared` as a read-only mirror for serialization compatibility, synced from `gameState` in `getStats()` and `restore()`.

**LOC:** ~15
**Test:** Capture 50 debris → `GAME_WIN` fires exactly once. `gameState.debrisCleared` and `scoringSystem.debrisCleared` are always equal.

---

### L1: Raw Pause Event Strings in main.js

**Problem:** [`main.js:319-320`](js/main.js:319) uses raw strings `'pause:resume'` and `'pause:menu'` instead of [`Events`](js/core/Events.js) constants.

**Fix:**

**File: [`js/core/Events.js`](js/core/Events.js)** — Add constants:
```javascript
// === PAUSE ===
PAUSE_RESUME: 'pause:resume',
PAUSE_MENU: 'pause:menu',
```

**File: [`js/main.js`](js/main.js:319-320)** — Replace raw strings:
```javascript
eventBus.on(Events.PAUSE_RESUME, () => { lastTime = performance.now(); });
eventBus.on(Events.PAUSE_MENU, () => { lastTime = performance.now(); });
```

Also search for and replace any other occurrences of these raw strings across the codebase.

**LOC:** ~10
**Test:** Pause→resume works. Grep for `'pause:resume'` and `'pause:menu'` returns zero results except Events.js definitions.

---

### L2: Win Condition Race

**Problem:** Both [`ScoringSystem.js:190`](js/systems/ScoringSystem.js:190) and [`GameState.js:109`](js/core/GameState.js:109) can emit `GAME_WIN`. If `awardPoints()` runs before `gameState.clearDebris()` in the same event chain, both fire — potentially triggering double win screens.

**Fix:** Solved as part of M1 above — removing the `GAME_WIN` emission from `ScoringSystem` makes `GameState.clearDebris()` the single emitter. Add a guard in [`GameFlowManager`](js/systems/GameFlowManager.js) to ignore duplicate `GAME_WIN`:

**File: [`js/systems/GameFlowManager.js`](js/systems/GameFlowManager.js)**
```javascript
// In the GAME_WIN handler, add idempotency guard:
if (this._winTriggered) return;
this._winTriggered = true;
```

**LOC:** ~5 (included in M1 fix)
**Test:** Win at exactly 50 debris → single win screen, no console errors.

---

### M2: Elevator Win Edge Case

**Problem:** The elevator contract win condition ([`CONTRACT_COMPLETE`](js/core/Events.js:155)) could potentially conflict with the 50-debris win condition if a player reaches 10,000 kg contributing mass before clearing 50 debris.

**Verification needed:** Read the `CONTRACT_COMPLETE` handler to confirm it properly transitions to WIN state. [`NEXT_STEPS.md`](NEXT_STEPS.md) line 255 says `CONTRACT_COMPLETE → flag → SHOP_DEPLOY → GAME_WIN` is ✅ verified. 

**Fix (if needed):** Ensure the `GAME_WIN` event includes `winType: 'elevator'` vs `winType: 'debris'` so the win screen can display the appropriate message. The [`GameFlowManager._elevatorWinTriggered`](js/systems/GameFlowManager.js:40) guard already exists.

**LOC:** ~5 (verification + minor payload enrichment)
**Test:** Contribute 10,000 kg refined metals → elevator win screen fires with correct win type.

---

## Sprint 2: Economy Discovery ✅

**Status:** COMPLETE — Cargo HUD visible after first arm capture, Houston forge/fuel hints, forge-hint panel activated. ~120 LOC.

**Goal:** Players discover and use the forge/fuel/cargo systems that already work, without code changes to the systems themselves — only to their visibility and tutorial timing.
**Definition of Done:** A new player encounters the forge within the first 10 captures. Houston comms guide them through R/T keys. Cargo summary is visible immediately after first arm capture.
**Dependencies:** Sprint 1 (bug fixes).
**Estimated LOC:** ~40 | **Time:** 0.5 session

### S2.1: Activate Cargo-Group Earlier in Tutorial

**Current state:** Per [`FULL_HUD_STRATEGY.md`](FULL_HUD_STRATEGY.md) §2.4, `cargo-group` activates at stage 8 (FREE_PLAY). This means the forge inline and cargo summary are dormant throughout the entire tutorial.

**Fix:** Activate `cargo-group` at stage 4 (FIRST_ARM) instead of stage 8. After the first arm capture, the player has metals in cargo — they should see them.

**File: [`js/ui/HUD.js`](js/ui/HUD.js)** — In [`setTutorialVisibility()`](js/ui/HUD.js), change:
```javascript
'cargo-group': stage >= TutorialStage.FIRST_ARM,  // was: TutorialStage.FREE_PLAY
```

**LOC:** ~1
**Event flow:** `ARM_RETURNED` → `CARGO_STORE` → `CARGO_UPDATED` → `_updateCargoLine()` → visible because `cargo-group` is now active.

---

### S2.2: Houston Comms for Forge Discovery

**When:** First `CARGO_STORE` event (metals stored after first arm capture).
**What:** Houston explains the forge exists.

**File: [`js/systems/GameFlowManager.js`](js/systems/GameFlowManager.js)** — In the ARM_RETURNED handler near line 754 (after `CARGO_STORE` emissions), add a one-time comms message:

```javascript
if (!this._forgeHintSent && metalSalvage.length > 0) {
    this._forgeHintSent = true;
    setTimeout(() => {
        eventBus.emit(Events.COMMS_MESSAGE, {
            text: 'Metal cargo stored. Press [R] to start the forge — process scrap into propellant or refined ingots.',
            priority: 'good',
            source: 'HOUSTON',
        });
    }, 4000); // 4s delay to let salvage reveal finish
}
```

**LOC:** ~10

---

### S2.3: Houston Comms for Fuel Cycling Discovery

**When:** First successful forge completion (propellant output mode).
**What:** Houston explains T key for fuel cycling.

**File: [`js/systems/ForgeSystem.js`](js/systems/ForgeSystem.js)** — In the `COOL → IDLE` transition (when output is propellant), emit a one-time comms prompt:

```javascript
if (this._outputMode === 'propellant' && !this._fuelCycleHintSent) {
    this._fuelCycleHintSent = true;
    eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Propellant processed. Press [T] to cycle fuel types — your Hall thruster can burn salvaged metals.',
        priority: 'good',
        source: 'HOUSTON',
    });
}
```

**LOC:** ~10

---

### S2.4: Forge Hint When Cargo Has Unprocessed Metal

**Current state:** [`StatusPanel.js:230`](js/ui/hud/StatusPanel.js:230) has a `#forge-hint` div that is always `display: none`.

**Fix:** Show "Press [R] to process" hint when forge is idle and cargo has raw metals.

**File: [`js/ui/hud/StatusPanel.js`](js/ui/hud/StatusPanel.js)** — In `_updateForgePanel()`, when forge state is `'IDLE'` and cargo has raw metals:

```javascript
const forgeHint = document.getElementById('forge-hint');
if (forgeHint) {
    if (forgeState.phase === 'IDLE' && this._cargoStatus && this._cargoStatus.totalMassKg > 0) {
        forgeHint.style.display = '';
        forgeHint.textContent = `${this._cargoStatus.totalMassKg.toFixed(0)} kg raw metal — [R] to process`;
    } else {
        forgeHint.style.display = 'none';
    }
}
```

**LOC:** ~10

---

### S2.5: Score Bar Identity Hint

**Current state:** The score bar shows `Score: X`. Per [`FULL_HUD_STRATEGY.md`](FULL_HUD_STRATEGY.md) §13.3, this is the only arcade-feeling element in a sim-native bar.

**Minimal fix (no design decision needed):** Add mass recovered next to score.

**File: [`js/ui/hud/StatusPanel.js`](js/ui/hud/StatusPanel.js:135-149)** — In the score panel HTML, add a mass recovered display:

```html
<span id="hud-mass-recovered" style="display:none;">
  │ <span style="color:#81c784;">⚖ <b id="hud-mass-total">0</b> kg</span>
</span>
```

Wire to `CARGO_UPDATED` events to show total mass in/out.

**LOC:** ~10

---

## Sprint 3: Gameplay Balance Pass ✅

**Status:** COMPLETE — Forge timings retuned (28→60s total cycle), arm thrust verified, MPD power addressed (see S3b). ~40 LOC.

**Goal:** Tune [`Constants.js`](js/core/Constants.js) values through playtesting to fix the identified balance issues.
**Definition of Done:** A playtest session runs start-to-win without friction points.
**Dependencies:** Sprint 1-2.
**Estimated LOC:** ~30 (Constants.js only) | **Time:** 1-2 sessions (mostly playtesting)

### H3: Arm FEEP Too Slow

**Problem:** Physical FEEP thrust is 0.35 mN ([`Constants.WEAVER_THRUST: 0.00035`](js/core/Constants.js:114)). The gamified multiplier [`ARM_GAMIFIED_THRUST_MULT: 200`](js/core/Constants.js:601) exists but needs verification that it's being applied consistently in [`ArmUnit`](js/entities/ArmUnit.js) for manual piloting.

**Action:** Playtest manual arm piloting. If sluggish:
- Increase `ARM_GAMIFIED_THRUST_MULT` from 200 to 400-600
- Adjust `ARM_LAUNCH_SPEED` from 10.0 to 15-20 m/s
- `ARM_LAUNCH_DURATION` from 0.5 to 0.3s for snappier deploy

---

### H4: MPD Power Budget Impossible

**Problem:** MPD draws [`MPD_POWER_DRAW: 150 kW`](js/core/Constants.js:485) but solar panels produce [`OCTOPUS_CORE_SOLAR_POWER: 1900 W`](js/core/Constants.js:99) (1.9 kW). A factor of ~80× gap.

**Options:**
1. **Reduce MPD power to 2-5 kW** — makes it battery-draining but not impossible
2. **Add a "reactor" upgrade** — nuclear/RTG providing 10+ kW, gated behind high credit cost
3. **Make MPD purely battery-powered** — runs for ~15s on full charge, cooldown to recharge

**Recommended:** Option 3 — it creates strategic tension (when to burn MPD) without new systems. Change `MPD_POWER_DRAW` from 150 to 5 (kW), representing battery draw rate. At 600 Wh battery = 0.6 kWh, running at 5 kW gives 432 seconds — reasonable.

**File: [`js/core/Constants.js:485`](js/core/Constants.js:485)**
```javascript
MPD_POWER_DRAW: 5,  // kW (was 150 — reduced for gameplay; draws from battery rapidly)
```

---

### Balance Constants to Review

| Constant | Current | Concern | Action |
|----------|---------|---------|--------|
| [`WIN_DEBRIS_COUNT`](js/core/Constants.js:45) | 50 | Too many for first playthrough? | Playtest. Consider 30 for first run, 50 for roguelite. |
| [`FORGE.PHASE_TIMES`](js/core/Constants.js:402-407) | 3/8/12/5 = 28s total | Feels slow vs capture rate? | Playtest. May reduce SEPARATE to 5s. |
| [`CARGO_CAPACITY_KG`](js/core/Constants.js:387) | 500 | Fills too fast with rocket bodies? | Playtest. Consider 1000. |
| Tutorial catch thresholds | 2/4/6/8 | Per [`NEXT_STEPS.md`](NEXT_STEPS.md) P1 | Playtest. The 800ms stage delay may feel slow. |
| [`LASSO_RANGE`](js/core/Constants.js:606) | 200m | Too short for first-time players? | Consider 300m. |
| [`CATCH_SLOWMO_DURATION`](js/core/Constants.js:616) | 0.2s | Too fast to notice? | Consider 0.4s for more impact. |

---

## Sprint 4: Core Feel Phase 1 ✅

**Status:** COMPLETE — WASD context switch (arm vs mothership), lasso windup feel, tether tension, catch juice enhanced, mode indicator. ~200 LOC.

**Goal:** Make arm piloting feel like a responsive drone-on-a-leash. Make WASD context-sensitive. This is the single biggest transformation of the game's identity from "tab-deploy-wait" to "actively fish for debris."
**Definition of Done:** Player can deploy arm with number key → auto-follow camera → WASD steers arm → F nets → slo-mo on catch. 7 returns to mothership → RCS puffs for fine positioning.
**Dependencies:** Sprint 1-3.
**Source Specs:** [`ORCHESTRATOR_BRIEF.md`](ORCHESTRATOR_BRIEF.md) Phase 1 (lines 246-259), [`GAMEPLAY_LOOP.md`](GAMEPLAY_LOOP.md) §1
**Estimated LOC:** ~200 | **Time:** 2-3 sessions

### S4.1: WASD Context Switch

**Current state:** [`InputManager.js`](js/systems/InputManager.js) routes WASD to mothership ion thrust regardless of arm selection state.

**Change:** When an arm is selected (via 1-6 keys, which already work per Verified Systems), WASD routes to `ARM_MANUAL_THRUST` event for that arm instead of mothership thrust. When no arm selected (key 7), WASD applies mothership RCS impulses.

**File: [`js/systems/InputManager.js`](js/systems/InputManager.js)** — In `processInput()`:
```javascript
if (this._selectedArmId) {
    // Route WASD to arm thrust
    eventBus.emit(Events.ARM_MANUAL_THRUST, {
        armId: this._selectedArmId,
        direction: thrustDir,
    });
} else {
    // Route WASD to mothership RCS
    player.applyRCSImpulse(thrustDir);
}
```

**Events:** [`ARM_MANUAL_THRUST`](js/core/Events.js:28) (already defined)
**Constants:** [`RCS_IMPULSE`](js/core/Constants.js:611), [`RCS_MAX_SPEED`](js/core/Constants.js:612), [`RCS_DAMPING`](js/core/Constants.js:613)

---

### S4.2: Gamified Arm Thrust Verification

**Verify:** [`ARM_GAMIFIED_THRUST_MULT: 200`](js/core/Constants.js:601) is applied in [`ArmUnit`](js/entities/ArmUnit.js) during manual thrust processing. If not applied, multiply FEEP thrust by this constant in the `_handleManualThrust()` or equivalent method.

---

### S4.3: Arm Launch/Cast Animation

**Current state:** Arm undocks and immediately begins TRANSIT at normal FEEP thrust speed.

**Change:** Add a `CAST` sub-state where the arm receives an initial impulse of [`ARM_LAUNCH_SPEED: 10 m/s`](js/core/Constants.js:602) toward the target for [`ARM_LAUNCH_DURATION: 0.5s`](js/core/Constants.js:603). This creates a satisfying "throw" feeling.

**File: [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js)** — In the UNDOCKING → TRANSIT transition, apply initial velocity burst.

---

### S4.4: Camera Auto-Switch on Arm Select

**Current state:** Arm selection (1-6) highlights in HUD but camera stays in current view.

**Change:** Selecting an arm auto-switches to ARM_PILOT camera. Pressing 7 (deselect) returns to CHASE.

**File: [`js/systems/CameraSystem.js`](js/systems/CameraSystem.js)** — Listen for `ARM_SELECT` / `ARM_DESELECT` events.

---

### S4.5: Mothership RCS Mode  

**New behavior:** With no arm selected, WASD applies small cold-gas impulses to the mothership using constants `RCS_IMPULSE`, `RCS_MAX_SPEED`, `RCS_DAMPING`.

**File: [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js)** — Add `applyRCSImpulse(direction)` method. Visible puffs (particle or sprite) at RCS nozzle positions.

---

### S4.6: Enhanced Catch Juice

**Current state:** [`CATCH_SLOWMO_DURATION: 0.2`](js/core/Constants.js:616), [`CATCH_SLOWMO_FACTOR: 0.1`](js/core/Constants.js:617). The slo-mo fires but is very brief.

**Enhancement:**
- Extend to 0.4s at 0.1× (adjust Constants)
- Gold/white flash on catch target (brief bracket pulse — per [`FULL_HUD_STRATEGY.md`](FULL_HUD_STRATEGY.md) §13.4 recommendation)
- Impact clamp sound already exists via [`AudioSystem.playCatchClamp()`](js/systems/AudioSystem.js)
- Score/mass popup (already fires)

---

### S4.7: Net Deploy on [F]

**Current state:** F key already fires arm fishing mode. Extend so that in ARM_PILOT mode with a nearby target (<50m), F deploys the net for manual capture.

**File: [`js/systems/InputManager.js`](js/systems/InputManager.js)** — F key handler routes differently based on arm pilot state.

---

## Sprint 5: NavSphere Redesign Phase 1 ✅

**Status:** COMPLETE — Log dual-zone distance encoding, type-differentiated shapes, closure coloring, zone fills, range rings. ~325 LOC.

**Goal:** Transform the NavSphere from direction-only to a true distance-encoded tactical sphere.
**Definition of Done:** Tether range rings are clearly visible. Debris dots reflect distance from center. Deployed arm tether lines appear.
**Dependencies:** Sprint 4 (arm positions needed for tether lines).
**Source Spec:** [`NAVSPHERE_REDESIGN.md`](NAVSPHERE_REDESIGN.md) (660 lines)
**Estimated LOC:** ~200 | **Time:** 1-2 sessions

### S5.1: Hybrid Log + Dual-Zone Distance Encoding

**Current state:** [`NavSphere._drawDebrisDot()`](js/ui/NavSphere.js:384) normalizes direction vectors, discarding distance (line 389).

**Change:** Per [`NAVSPHERE_REDESIGN.md`](NAVSPHERE_REDESIGN.md) §3.1, implement:
```
innerR = log(1 + distKm) / log(1 + 5) * 0.50 * R      // 0–5 km → center to 50%
outerR = log(1 + distKm - 5) / log(1 + 45) * 0.50 * R + 0.50 * R  // 5–50 km → 50% to rim
```

**File: [`js/ui/NavSphere.js`](js/ui/NavSphere.js:389)** — Replace `normalize()` with distance-encoded radial placement.

### S5.2: Tether Range Rings

Draw concentric rings at Lasso (200m), Spinner (500m), and Weaver (2km) ranges using the new distance encoding. Colors from [`Constants`](js/core/Constants.js:646-648):
- Lasso: `NAVSPHERE_LASSO_RING_COLOR` (white)
- Spinner: `NAVSPHERE_SPINNER_RING_COLOR` (green)
- Weaver: `NAVSPHERE_WEAVER_RING_COLOR` (cyan)

### S5.3: Arm Tether Lines

Draw thin lines from sphere center to deployed arm positions (jellyfish tentacles per [`GAMEPLAY_LOOP.md`](GAMEPLAY_LOOP.md) §2.4).

**File: [`js/ui/NavSphere.js`](js/ui/NavSphere.js)** — New `_drawArmTethers()` method. Needs arm position data injected from [`main.js`](js/main.js).

---

## Sprint 6: Target Panel Redesign Phase 1 ✅

**Status:** COMPLETE — CSS grid rows, color tiers, progressive reveal, range indicator, width matched to 280px. ~237 LOC.

**Goal:** Fix the target panel cramping at 1080p and improve information architecture.
**Definition of Done:** Target rows are readable at 1080p. Panel aligns with NavSphere. Key action hints visible per row.
**Dependencies:** Sprint 5 (NavSphere width change affects alignment).
**Source Spec:** [`TARGET_PANEL_REDESIGN.md`](TARGET_PANEL_REDESIGN.md) (1,410 lines)
**Estimated LOC:** ~250 | **Time:** 1-2 sessions

### S6.1: Width Match to 280px

Per [`TARGET_PANEL_REDESIGN.md`](TARGET_PANEL_REDESIGN.md) §1: change TargetPanel and DebrisWireframe from 260px to 280px to match NavSphere diameter.

**Files:**
- [`js/ui/hud/TargetPanel.js:47`](js/ui/hud/TargetPanel.js:47) — `minWidth: 260px` → `280px`
- [`js/ui/DebrisWireframe.js:16`](js/ui/DebrisWireframe.js:16) — `PANEL_WIDTH = 260` → `280`
- [`js/ui/HUD.js`](js/ui/HUD.js) — Right column `width: 280px`

### S6.2: Typography Fix

Per Target Panel spec §4: increase base font from 10px to 11-12px, selected target row to 13px bold.

### S6.3: Row Redesign

Per Target Panel spec §3: information architecture with two-row layout (name+type on line 1, distance+ΔV+action on line 2). Collapse empty sections.

### S6.4: Dynamic Max Height

```css
max-height: calc(100vh - 350px);
overflow-y: auto;
```

---

## Sprint 7: Trawl System Polish ✅

**Status:** COMPLETE — Window tracking with timing, adaptive speed, cluster generation, game loop integration. ~195 LOC.

**Goal:** Polish the jellyfish trawl mechanic into the core gameplay feel described in [`GAMEPLAY_LOOP.md`](GAMEPLAY_LOOP.md).
**Definition of Done:** Mothership drifts through debris clusters. Targets enter/exit tether range with time windows. Sweep report fires on cluster exit.
**Dependencies:** Sprint 4 (core feel), Sprint 5 (NavSphere shows tether zones).
**Source Specs:** [`ORCHESTRATOR_BRIEF.md`](ORCHESTRATOR_BRIEF.md) Phase 2, [`GAMEPLAY_LOOP.md`](GAMEPLAY_LOOP.md) §1, §4
**Estimated LOC:** ~150 | **Time:** 1-2 sessions

### S7.1: Trawl Window Tracking

**Current state:** [`TrawlManager.js`](js/systems/TrawlManager.js) exists and provides trawl state tracking.

**Enhancement:** Emit [`TRAWL_TARGET_ENTERING`](js/core/Events.js:161), [`TRAWL_TARGET_WINDOW_CLOSING`](js/core/Events.js:163), [`TRAWL_TARGET_EXITED`](js/core/Events.js:162) events with timing data. These drive NavSphere dot color transitions (green → yellow → red at zone edges per [`GAMEPLAY_LOOP.md`](GAMEPLAY_LOOP.md) §2.4).

### S7.2: Adaptive Trawl Speed

Per [`GAMEPLAY_LOOP.md`](GAMEPLAY_LOOP.md) §4.1:
- Catch ratio >80%: speed ×1.5 + comms "Increasing sweep speed"
- Catch ratio 50-80%: maintain
- Catch ratio <30%: speed ×0.6 + comms "Slowing sweep. Take your time."

### S7.3: Debris Cluster Grouping

Per [`ORCHESTRATOR_BRIEF.md`](ORCHESTRATOR_BRIEF.md) Phase 2.6: group debris by altitude band × inclination to create navigable clusters.

---

## Sprint 8: Unit Test Infrastructure ✅

**Status:** COMPLETE — TestRunner.js micro-framework, 83 tests across 6 suites (Constants, EventBus, OrbitalMechanics, GameState, ScoringSystem, PowerDistribution). CLI + browser runners. ~530 LOC.

**Goal:** Add the first unit tests to the project, targeting pure-logic modules first.
**Definition of Done:** A test runner works with zero build tools. 5+ test files covering core logic. Tests run via `start.sh` or a new `test.html`.
**Dependencies:** None (can parallel other sprints).
**Estimated LOC:** ~300 | **Time:** 2-3 sessions

### Approach

Since the project uses zero build tools and ES6 modules loaded via `<script type="module">`, the test framework should be equally simple:

1. **Create `test.html`** — loads test modules
2. **Create `js/test/TestRunner.js`** — minimal assertion library (~50 LOC)
3. **Prioritize pure-logic modules:**
   - [`OrbitalMechanics.js`](js/entities/OrbitalMechanics.js) — Math functions, zero DOM
   - [`GameState.js`](js/core/GameState.js) — FSM transitions
   - [`ScoringSystem.js`](js/systems/ScoringSystem.js) — Score calculations
   - [`Constants.js`](js/core/Constants.js) — Validate relationships between constants
   - [`CargoSystem.js`](js/systems/CargoSystem.js) — Store/remove/serialize
   - [`ForgeSystem.js`](js/systems/ForgeSystem.js) — Phase state machine

### Test File Structure
```
js/test/
  TestRunner.js       — assert(), describe(), it() (~50 LOC)
  test-GameState.js   — FSM transition validity
  test-Scoring.js     — Score calculation, bounty premiums
  test-Cargo.js       — Store, remove, capacity limits
  test-Forge.js       — Phase transitions, timing
  test-OrbitalMech.js — Hohmann ΔV, orbit conversions
```

---

## Sprint 9: Sim Identity Reframe ✅

**Status:** COMPLETE — Mass popups replace score popups, Houston narrative replaces combo text, bracket pulse, single beep, CommsPanel styling. ~120 LOC.

**Goal:** Resolve the sim-vs-arcade tension identified in [`FULL_HUD_STRATEGY.md`](FULL_HUD_STRATEGY.md) §13.
**Definition of Done:** Catch rewards feel grounded and educational rather than arcade-gamey.
**Dependencies:** Sprint 2 (economy discovery in place first). **Decision D1 resolved: Full Sim Reframe.**
**Estimated LOC:** ~150 | **Time:** 1-2 sessions

### What Changes

Per [`FULL_HUD_STRATEGY.md`](FULL_HUD_STRATEGY.md) §13.4:

| Current (Arcade) | Proposed (Sim) | File |
|------------------|---------------|------|
| `+500 ★` score popup | `+15 kg aluminum` mass popup | [`StatusPanel._showCaptureNotification()`](js/ui/hud/StatusPanel.js:955) |
| Gold screen flash | Subtle bracket pulse | [`TargetReticle.js`](js/ui/TargetReticle.js) |
| `TACTICAL BONUS ×1.3` popup | Houston: "Good assessment" | [`ScoringSystem.js:126-130`](js/systems/ScoringSystem.js:126) |
| Score bar "Score" field | "Mass Recovered: X kg" | [`StatusPanel.js:137`](js/ui/hud/StatusPanel.js:137) |
| G4→B4→D5 fanfare chime | Single confirmation beep | [`AudioSystem.js`](js/systems/AudioSystem.js) |

### What Stays (Regardless of Decision)

- Houston congratulations — perfect sim reward
- Salvage reveal card — teaches materials science
- Codex unlocks — educational
- Sweep reports — mission debrief
- Credits as economic resource — meaningful

---

## Sprint 10: Audio Polish ✅

**Status:** COMPLETE — Forge phase textures (INTAKE clank, SEPARATE clicks, MELT crackle, COOL sweep), codex unlock sound. ~85 LOC.

**Goal:** Fill the two remaining audio gaps identified in [`NEXT_STEPS.md`](NEXT_STEPS.md) Priority 3.
**Definition of Done:** Forge phase transitions have distinct sounds. Codex unlock has a notification sound.
**Dependencies:** None.
**Estimated LOC:** ~80 | **Time:** 0.5 session

### S10.1: Forge Phase Sounds

**File: [`js/systems/AudioSystem.js`](js/systems/AudioSystem.js)**

| Phase | Sound | Implementation |
|-------|-------|---------------|
| INTAKE | Metallic clank + servo whirr | `playForgeIntake()` — noise burst + bandpass 200-400 Hz |
| SEPARATE | Magnetic hum + clicking | `playForgeSeparate()` — 120 Hz hum + random clicks |
| MELT | Deep EML 60 Hz hum + crackling | `playForgeMelt()` — low sine + filtered noise bursts |
| COOL → complete | Ascending chime | `playForgeComplete()` — C5→E5→G5 triangle wave |

Wire to [`FORGE_PHASE_CHANGE`](js/core/Events.js:140) events.

### S10.2: Codex Unlock Sound

**File: [`js/systems/AudioSystem.js`](js/systems/AudioSystem.js)**

`playCodexUnlock()` — soft two-note ascending (A4→E5, sine, 100ms each, very low volume). Wire to [`CODEX_UNLOCKED`](js/core/Events.js:187) event.

---

## Risk Register

| # | Risk | Impact | Probability | Mitigation |
|---|------|--------|-------------|-----------|
| R1 | Core Feel changes break the working capture loop | HIGH | MEDIUM | Sprint 4 changes are additive (new WASD routing), not destructive. Old deploy-via-G path remains. Rollback: revert InputManager context switch. |
| R2 | NavSphere distance encoding makes far targets invisible | MEDIUM | LOW | The logarithmic outer zone still gives 65px for 5-50 km. Playtest with high debris counts. Rollback: toggle log/linear via constant. |
| R3 | Economy discovery messages feel intrusive | LOW | MEDIUM | Messages are one-time Houston comms with 4s delay. Playtest timing. Rollback: disable via `_forgeHintSent = true` in constructor. |
| R4 | Double-counting fix breaks save/load | MEDIUM | MEDIUM | After M1 fix, `ScoringSystem.debrisCleared` mirrors `gameState.debrisCleared`. Ensure `restore()` syncs both from save data. Test: save at 25, load, verify count = 25. |
| R5 | Balance pass changes make game too easy/hard | MEDIUM | HIGH | All balance changes are Constants.js-only. Easy to revert individual values. Keep a `CONSTANTS_CHANGELOG` comment block. |
| R6 | Tab/Lasso fix makes auto-aim useless | LOW | LOW | Auto-aim is fallback when no target selected. Tab-selected targets take priority but auto-aim cone still works for fast gameplay without Tab. |
| R7 | Unit tests are fragile due to EventBus coupling | MEDIUM | HIGH | Test pure-logic methods directly (calculateScore, setState). Mock EventBus for integration tests. Start with the simplest modules. |

### Rollback Strategy

All sprints are designed as additive changes. Each sprint's files can be reverted independently:

- **Sprint 1:** Bug fixes are surgical — each is 5-20 LOC in specific files
- **Sprint 2:** One-time comms + tutorial stage change — trivially reversible  
- **Sprint 3:** Constants.js only — revert individual values
- **Sprint 4:** InputManager context switch has a clean guard (`if (this._selectedArmId)`) — remove guard to revert
- **Sprint 5-6:** NavSphere/TargetPanel changes are self-contained in their respective files
- **Sprint 7-10:** Each is independent

---

## Design Decisions — RESOLVED

> All 4 decisions resolved 2026-04-09.

### D1: Sim vs Arcade Reward Identity → **Full Sim Reframe** ✅

Replace all arcade elements with sim-native ones per [`FULL_HUD_STRATEGY.md`](FULL_HUD_STRATEGY.md) §13.4:
- `+500 ★` popups → `+15 kg aluminum` mass popup
- Gold flash → subtle bracket pulse
- Score bar "Score" → "Mass Recovered"
- Combo multiplier popups → Houston narrative acknowledgment
- G4→B4→D5 fanfare chime → single confirmation beep

**Sprint 9 is now unblocked.** Implementation follows the table in Sprint 9 above.

### D2: Win Condition Threshold → **Keep 50** ✅

[`WIN_DEBRIS_COUNT`](js/core/Constants.js:45) stays at 50. No change needed.

### D3: MPD Power Budget → **Reduce to 5 kW Battery-Drain** ✅

Change [`MPD_POWER_DRAW`](js/core/Constants.js:485) from 150 to 5. MPD becomes a battery-intensive burst system — ~432 seconds of operation on full charge (600 Wh battery ÷ 5 kW = 0.12 h). Creates strategic tension: when to use MPD vs ion.

**File: [`js/core/Constants.js:485`](js/core/Constants.js:485)** — Sprint 3 implementation.

### D4: NavSphere Adaptive Zoom → **Deferred** ✅

[`NAVSPHERE_REDESIGN.md`](NAVSPHERE_REDESIGN.md) §3.0 Option C (adaptive zoom) is not planned. Sprint 5 implements the hybrid log+dual-zone approach only.

---

## Dependency Graph

```
S1 (Bug Fixes) ──────────────┐
                              ├── S2 (Economy Discovery) ──┐
                              │                             ├── S3 (Balance Pass)
                              │                             │        │
                              │                             │        ▼
                              │                             │   S4 (Core Feel) ──┐
                              │                             │                     ├── S7 (Trawl Polish)
                              │                             │                     │
S8 (Unit Tests) ──────────────┤   (parallel, any time)      │   S5 (NavSphere) ──┤
                              │                             │                     │
S10 (Audio Polish) ───────────┤   (parallel, any time)      │   S6 (Target Panel)│
                              │                             │                     │
                              └─────────────────────────────┘   S9 (Sim Identity)│← needs D1 decision
                                                                                  │
                                                                  ▼ all complete  │
                                                              GAME SHIPS ─────────┘
```

### Critical Path

```
S1 → S2 → S3 → S4 → S5 → S7
         (1 day) (1-2 days) (2-3 days) (1-2 days) (1-2 days)
```

**Total critical path:** ~7-10 session days

**Parallelizable:** S8 (tests), S10 (audio), S6 (target panel), S9 (after D1 decision)

---

## File Impact Matrix

| File | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9 | S10 |
|------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:---:|
| [`Constants.js`](js/core/Constants.js) | | | ✦ | ○ | | | ○ | ○ | | |
| [`Events.js`](js/core/Events.js) | ✦ | | | | | | | | | |
| [`GameState.js`](js/core/GameState.js) | ○ | | | | | | | ✦ | | |
| [`main.js`](js/main.js) | ○ | | | ○ | ○ | | | | | |
| [`ScoringSystem.js`](js/systems/ScoringSystem.js) | ✦ | | | | | | | ✦ | ✦ | |
| [`GameFlowManager.js`](js/systems/GameFlowManager.js) | ○ | ✦ | | | | | | | | |
| [`LassoSystem.js`](js/systems/LassoSystem.js) | ✦ | | | | | | | | | |
| [`InputManager.js`](js/systems/InputManager.js) | ○ | | | ✦ | | | | | | |
| [`StatusPanel.js`](js/ui/hud/StatusPanel.js) | | ✦ | | | | | | | ✦ | |
| [`HUD.js`](js/ui/HUD.js) | | ○ | | | | ○ | | | | |
| [`NavSphere.js`](js/ui/NavSphere.js) | | | | | ✦ | | ○ | | | |
| [`TargetPanel.js`](js/ui/hud/TargetPanel.js) | | | | | | ✦ | | | | |
| [`DebrisWireframe.js`](js/ui/DebrisWireframe.js) | | | | | | ○ | | | | |
| [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) | | | | ✦ | | | | | | |
| [`ArmUnit.js`](js/entities/ArmUnit.js) | | | | ✦ | | | | | | |
| [`CameraSystem.js`](js/systems/CameraSystem.js) | | | | ○ | | | | | | |
| [`ForgeSystem.js`](js/systems/ForgeSystem.js) | | ○ | | | | | | ✦ | | ○ |
| [`AudioSystem.js`](js/systems/AudioSystem.js) | | | | | | | | | ○ | ✦ |
| [`TrawlManager.js`](js/systems/TrawlManager.js) | | | | | | | ✦ | | | |
| [`TargetReticle.js`](js/ui/TargetReticle.js) | | | | | | | | | ○ | |
| [`RewardSystem.js`](js/systems/RewardSystem.js) | | | | | | | ○ | | ○ | |

✦ = Primary changes | ○ = Minor changes

---

## Sprint 2 Deep Dive: Economy Discovery (Wire-by-Wire)

Since this is the highest-impact, lowest-effort sprint, here's the precise step-by-step:

### Step 1: Change Tutorial Activation Map (1 LOC)

**File:** [`js/ui/HUD.js`](js/ui/HUD.js) — [`setTutorialVisibility()`](js/ui/HUD.js)

Find the line:
```javascript
'cargo-group': stage >= TutorialStage.FREE_PLAY,
```
Replace with:
```javascript
'cargo-group': stage >= TutorialStage.FIRST_ARM,
```

**Why:** After the first arm capture (stage 4), metals flow into cargo. The cargo summary and forge inline should be visible (active, not dormant) from that point.

**Event chain verified:**
1. Player deploys arm → [`ARM_DEPLOYED`](js/core/Events.js:15)
2. Arm captures → [`ARM_CAPTURED`](js/core/Events.js:17)
3. Arm returns → [`ARM_RETURNED`](js/core/Events.js:18)
4. [`GameFlowManager.js:754-765`](js/systems/GameFlowManager.js:754) — emits `CARGO_STORE` per metal
5. [`StatusPanel.js:58-64`](js/ui/hud/StatusPanel.js:58) — `CARGO_STORE` listener reveals `#forge-inline`
6. [`StatusPanel.js:67-70`](js/ui/hud/StatusPanel.js:67) — `CARGO_UPDATED` listener calls `_updateCargoLine()`
7. `#cargo-summary` and `#forge-inline` are now visible because `cargo-group` is active at stage 4+

### Step 2: Add Forge Discovery Comms (10 LOC)

**File:** [`js/systems/GameFlowManager.js`](js/systems/GameFlowManager.js)

**Location:** After the metal cargo storage loop (line ~765), add:
```javascript
// One-time forge discovery hint
if (!this._forgeHintSent && metalSalvage.length > 0) {
    this._forgeHintSent = true;
    setTimeout(() => {
        eventBus.emit(Events.COMMS_MESSAGE, {
            text: 'Metal cargo stored. Press [R] to start the forge — process scrap into propellant or refined ingots.',
            priority: 'good',
            source: 'HOUSTON',
        });
    }, 4000);
}
```

**Initialize flag:** Add `this._forgeHintSent = false;` in constructor.

### Step 3: Add Fuel Cycling Discovery Comms (10 LOC)

**File:** [`js/systems/ForgeSystem.js`](js/systems/ForgeSystem.js)

**Location:** In the phase transition handler where `COOL` → `IDLE` and output mode is `'propellant'`:
```javascript
if (this._outputMode === 'propellant' && !this._fuelCycleHintSent) {
    this._fuelCycleHintSent = true;
    eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Propellant ready. Press [T] to cycle fuel — your Hall thruster burns salvaged metals.',
        priority: 'good',
        source: 'HOUSTON',
    });
}
```

### Step 4: Activate Forge Hint (10 LOC)

**File:** [`js/ui/hud/StatusPanel.js`](js/ui/hud/StatusPanel.js)

**Location:** In `_updateForgePanel()` method, add logic to show `#forge-hint`:
```javascript
const forgeHint = document.getElementById('forge-hint');
if (forgeHint && forgeState) {
    const hasRawMetal = this._cargoStatus && this._cargoStatus.totalMassKg > 0;
    if (forgeState.phase === 'IDLE' && hasRawMetal && !forgeState.active) {
        forgeHint.style.display = '';
        forgeHint.textContent = `${this._cargoStatus.totalMassKg.toFixed(0)} kg raw — [R] process`;
    } else {
        forgeHint.style.display = 'none';
    }
}
```

### Step 5: Add Mass Recovered to Score Bar (10 LOC)

**File:** [`js/ui/hud/StatusPanel.js`](js/ui/hud/StatusPanel.js:135-149)

In the score panel HTML (line 135-149), add after the credits span:
```html
<span id="hud-mass-wrap" style="display:none;">
  <span>│</span>
  <span style="color:#81c784;">⚖ <b id="hud-mass-total">0</b> kg</span>
</span>
```

In `_updateCargoLine()`, update this element:
```javascript
const massWrap = document.getElementById('hud-mass-wrap');
const massEl = document.getElementById('hud-mass-total');
if (massWrap && this._cargoStatus && this._cargoStatus.totalMassKg > 0) {
    massWrap.style.display = '';
    if (massEl) massEl.textContent = this._cargoStatus.totalMassKg.toFixed(0);
}
```

### Verification Checklist

After Sprint 2:
- [ ] Start new game → play through tutorial to FIRST_ARM stage
- [ ] Capture first debris with arm → cargo summary appears in left panel
- [ ] Houston says "Metal cargo stored. Press [R]..."
- [ ] Press R → forge activates, progress bar visible
- [ ] Forge completes propellant → Houston says "Press [T] to cycle fuel..."
- [ ] Press T → fuel indicator changes to show salvaged metal fuel
- [ ] Score bar shows mass recovered after first metal cargo

---

## Cross-Document Coherence Check

| Document | What It Says | This Plan's Alignment |
|----------|-------------|----------------------|
| [`ORCHESTRATOR_BRIEF.md`](ORCHESTRATOR_BRIEF.md) | "Sprint A first, then Core Feel" | ✅ S1-S2 are Sprint A refined; S4 is Core Feel |
| [`NEXT_STEPS.md`](NEXT_STEPS.md) | "P1: Balance Pass, P2: Persistence, P3: Audio" | ✅ S3=P1, Persistence verified in Verified Systems, S10=P3 |
| [`FULL_HUD_STRATEGY.md`](FULL_HUD_STRATEGY.md) | "All 8 phases ✅ implemented" | ✅ Not re-doing HUD strategy. Building on it. |
| [`GAMEPLAY_LOOP.md`](GAMEPLAY_LOOP.md) | "Jellyfish trawl is the identity" | ✅ S4 (feel) → S5 (NavSphere jellyfish) → S7 (trawl polish) |
| [`MASTER_PLAN.md`](MASTER_PLAN.md) | "Phase 1: Retrograde guidance" | ⚠️ Deferred — nice-to-have after core feel. Can parallel. |
| [`ROADMAP.md`](ROADMAP.md) | "Phase 9: Future features" | ✅ Not blocking. Configurable MFD panels deferred. |
| [`NAVSPHERE_REDESIGN.md`](NAVSPHERE_REDESIGN.md) | "Hybrid log + dual-zone" | ✅ S5 implements Phase 1 of this spec. |
| [`TARGET_PANEL_REDESIGN.md`](TARGET_PANEL_REDESIGN.md) | "Width 280px, typography fix" | ✅ S6 implements Phase 1 of this spec. |

---

## H5: GameFlowManager._refs God-Object

**Not a sprint item, but noted as a refactoring opportunity.**

[`GameFlowManager._refs`](js/systems/GameFlowManager.js:38) holds ~20 references to every system and UI component. This creates tight coupling. However, refactoring it now would touch every system's initialization path — high risk for low immediate benefit.

**Recommendation:** Track as technical debt. When adding new systems, prefer EventBus-mediated communication over adding more refs. The [`Events.js`](js/core/Events.js) system (135 events) is the right pattern — `_refs` is the legacy pattern.

---

## Sprint S3b: MPD Ludicrous Mode + Power Infrastructure ✅

**Status:** COMPLETE — MPD restored to 150kW, M-key toggle, thermal management, 5 new power upgrades (Multi-Junction Solar, Solid-State Battery, Graphene Supercap, RTG, Power Beaming), HUD indicators, audio, 6 codex entries. ~365 LOC.

> **Added:** 2026-04-10 — Reverses S3 decision D3 (MPD 5 kW band-aid).
> **Goal:** Restore [`MPD_POWER_DRAW`](js/core/Constants.js:485) to the realistic **150 kW** and build a compelling power infrastructure upgrade chain that gates and sustains MPD usage. MPD becomes the capstone "Ludicrous Mode" — incredibly powerful but drains batteries fast. Players upgrade power systems through 5 new shop items to unlock and extend MPD burst duration.
>
> **Design Principle:** Every upgrade teaches a real aerospace power concept. The progression mirrors how real spacecraft missions solve the power-vs-propulsion problem.
>
> **Dependencies:** Sprint 3 (balance pass applied). Parallel with S4–S10.
> **Estimated LOC:** ~350–400 | **Time:** 2–3 sessions

---

### S3b.1 — MPD Burst Mode Mechanics

#### Activation

**Key:** `M` toggles "MPD Armed" state (mnemonic: **M**PD / **M**agnetoplasmadynamic).

When armed:
- All W/S/A/D thrust routes through [`thrustMPD()`](js/entities/PlayerSatellite.js:1443) instead of [`thrustIon()`](js/entities/PlayerSatellite.js:1332)
- HUD shows pulsing **"⚡ MPD BURST"** indicator beside the thrust level
- Thruster plume color shifts to **magenta/purple** (lithium plasma signature)
- Battery bar tints **purple** to indicate high-drain mode
- Throttle (Z/X) and autopilot still function normally

When disarmed (press `M` again, or auto-disarm):
- Thrust routes back to `thrustIon()` / cold-gas as normal
- Comms: `"MPD standby — ion drive resumed"`

**Guards (auto-disarm triggers):**

| Condition | Behavior |
|-----------|----------|
| MPD not purchased | `M` key ignored; comms "MPD not installed" |
| Lithium = 0 | Auto-disarm; comms "MPD FUEL DEPLETED — no lithium" |
| Battery ≤ 0 | Auto-disarm; comms "MPD OFFLINE — battery depleted" |
| Thermal shutdown | Auto-disarm; comms "MPD THERMAL SHUTDOWN — cooldown 15s" |
| THRUST bus = 0% | Blocked per existing [`powerDistribution.thrustMultiplier`](js/systems/PowerDistribution.js:38) check |

#### Energy Drain Math

The existing drain formula in [`thrustMPD()`](js/entities/PlayerSatellite.js:1499):

```javascript
const powerCost = (Constants.MPD_POWER_DRAW || 150) * 0.1 * dt;
// 150 kW × 0.1 = 15 Wh/s battery drain
```

At **150 kW** (`MPD_POWER_DRAW: 150`), drain = **15 Wh/s**. This is the core tension — the battery depletes rapidly, creating short intense bursts.

#### Thermal Management

MPD generates waste heat during operation. A simple heat accumulator prevents infinite rapid-fire bursts:

| Parameter | Value | Constant |
|-----------|-------|----------|
| Heat gain while firing | 1.0 heat/s | `MPD_BURST_HEAT_RATE` |
| Passive heat dissipation | 0.3 heat/s | `MPD_BURST_COOL_RATE` |
| Dissipation with supercap upgrade | 0.5 heat/s | `MPD_BURST_COOL_RATE_SUPERCAP` |
| Overheat threshold | 40 heat units | `MPD_BURST_OVERHEAT_THRESHOLD` |
| Forced cooldown duration | 15 seconds | `MPD_BURST_COOLDOWN_TIME` |

Net heat rate during firing: **+0.7 heat/s** (1.0 − 0.3). Overheat at continuous ~57s. In practice, battery runs out long before this with standard upgrades — thermal only triggers on repeated rapid bursts without full cooldown.

After a 25s burst: heat = 25 × 0.7 = 17.5 / 40. Time to cool from 17.5 to 0: 17.5 / 0.3 = **58s** (without supercap), **35s** (with supercap).

#### Graceful Degradation

| Battery Level | Effect |
|---------------|--------|
| > 15% | Full MPD thrust |
| 5%–15% | HUD warning: "⚠ MPD POWER LOW"; amber battery flash |
| 0%–5% | MPD thrust × 0.5 (degraded); comms "MPD degraded — critical power" |
| 0% | Auto-disarm → fallback to ion drive |

#### Thrust During Burst

- MPD ΔV: [`MPD_DELTA_V: 0.0015`](js/core/Constants.js:493) scene units/s² — **5× ion drive** (ion = 0.0003)
- At 25N real thrust, 260 kg ship: acceleration = 0.096 m/s²
- 20s burst: **1.92 m/s ΔV** — enough to change orbit by ~40 km altitude
- 30s burst: **2.88 m/s ΔV** — a significant orbital transfer

This makes MPD bursts "turbo boosts" for rapid intercepts, emergency maneuvers, or reaching distant debris clusters. The ion drive remains the efficient everyday engine.

---

### S3b.2 — Power Infrastructure Upgrade Chain (5 New Upgrades)

#### Tech Tree Layout

```
EXISTING                           NEW TIER 1                    NEW TIER 2              NEW TIER 3
────────                           ──────────                    ──────────              ──────────
Efficient Panels (500cr) ──────→ Multi-Junction Solar (1200cr) ──→ Power Beaming (2000cr)
                                                                 ──→ RTG Module (3500cr)

Extra Battery ×1 (400cr) ──────→ Solid-State Battery (1500cr) ──→ Graphene Supercap (2500cr)
Extra Battery ×2 (400cr)

                                 Multi-Junction Solar ─────────┐
                                                               ├──→ MPD Thruster (3000cr) [CHANGED prereqs]
                                 Solid-State Battery ──────────┘
                                 
                                 MPD Thruster ─────────────────→ Hardened Cathode (1500cr) [UNCHANGED]
```

**MPD prerequisites change:** from `['efficient_panels', 'extra_battery']` → `['solid_state_battery', 'multi_junction_solar']`. This ensures the player has invested in the power chain before accessing MPD. The minimum path to MPD costs **5,600 cr** (EP 500 + EB 400 + MJS 1200 + SSB 1500 + MPD 3000) — a significant late-game commitment.

#### Upgrade Definitions

##### 1. Multi-Junction Solar Cells

| Field | Value |
|-------|-------|
| `id` | `'multi_junction_solar'` |
| `cat` | `'Power'` |
| `name` | `'Multi-Junction Solar'` |
| `cost` | `1200` |
| `desc` | `'GaInP/GaAs/Ge triple-junction cells. +100% solar efficiency.'` |
| `effect` | `'solarEfficiency'` |
| `value` | `2.0` |
| `maxLevel` | `1` |
| `requiresAll` | `['efficient_panels']` |

**Numerical impact:** Solar rate = 0.30 × **2.0** × 1361 × 20 = **16,332 W** (16.3 kW). Up from base 8.2 kW → **2× faster battery recharge** between MPD bursts.

**Concept taught:** Triple-junction photovoltaics — three semiconductor layers (GaInP/GaAs/Ge) each absorbing different wavelength bands. Used on every interplanetary spacecraft since ~2000. Real efficiency: 39.2% (lab record: 47.6% in 2022).

**Codex entry:** *"Multi-Junction Photovoltaics"* — "Triple-junction cells stack three materials tuned to different parts of the solar spectrum. The top layer catches UV/blue, the middle catches visible, the bottom catches infrared. Combined: 39% efficiency vs 22% for silicon. Every Mars rover, every GPS satellite, and the ISS all use multi-junction GaAs cells. The tradeoff: 100× more expensive per watt than silicon — but in space, mass and area matter more than cost."

##### 2. Solid-State Battery

| Field | Value |
|-------|-------|
| `id` | `'solid_state_battery'` |
| `cat` | `'Power'` |
| `name` | `'Solid-State Battery'` |
| `cost` | `1500` |
| `desc` | `'No liquid electrolyte. +150 Wh capacity. Survives thermal cycling.'` |
| `effect` | `'batteryMax'` |
| `value` | `150` |
| `maxLevel` | `1` |
| `requiresAll` | `['extra_battery']` |

**Numerical impact:** batteryMax += 150. With base 100 + EB×1 (50) = **300 Wh total**. With EB×2: **350 Wh**. Duration at 15 Wh/s: **20–23s** MPD burst.

**Concept taught:** Solid-state lithium batteries — ceramic electrolyte replaces flammable liquid. Higher energy density (400+ Wh/kg vs 250 Wh/kg Li-ion), no fire risk, better cycle life in extreme thermal environments (-120°C to +120°C LEO cycling).

**Codex entry:** *"Solid-State Batteries"* — "Replace the liquid electrolyte with a solid ceramic or glass. No sloshing in microgravity, no fire risk from thermal runaway, and 40% more energy per kilogram. Spacecraft batteries endure 50,000+ charge/discharge cycles — once every 92-minute orbit for years. Toyota, QuantumScape, and NASA JPL are all racing to flight-qualify solid-state cells. Your battery survives what would melt a phone battery."

##### 3. Graphene Supercapacitor Bank

| Field | Value |
|-------|-------|
| `id` | `'graphene_supercap'` |
| `cat` | `'Power'` |
| `name` | `'Graphene Supercapacitor'` |
| `cost` | `2500` |
| `desc` | `'HBN-dielectric graphene bank. +100 Wh burst storage. Improved thermal dissipation.'` |
| `effect` | `'supercapUpgrade'` |
| `value` | `100` |
| `maxLevel` | `1` |
| `requiresAll` | `['solid_state_battery']` |

**Numerical impact:** batteryMax += 100 AND sets `MPD_BURST_COOL_RATE` from 0.3 → 0.5 heat/s (67% faster thermal dissipation). Total storage with full chain: **400–450 Wh** → **27–30s** MPD burst.

**Concept taught:** Graphene supercapacitors — single-atom carbon sheets with hexagonal boron nitride (HBN) dielectric. Supercaps store energy in electric fields (not chemical reactions), enabling 1000× faster discharge than batteries. Lower energy density but astronomical power density — perfect for high-drain burst systems like MPD.

**Codex entry:** *"Graphene Supercapacitors"* — "Graphene is a single layer of carbon atoms arranged in hexagons — the strongest, most conductive material ever measured. Stack graphene sheets separated by hexagonal boron nitride (HBN) insulator — graphene's crystalline twin but an insulator instead of conductor — and you get a supercapacitor that charges in seconds and survives millions of cycles. Energy density: 10× less than batteries. But power density: 1000× more. Your MPD thruster draws 150 kW — a current spike that would damage any battery. The supercap bank absorbs the peak, while batteries provide sustained baseload. Same principle as the 'ludicrous mode' battery pack in high-performance electric vehicles."

##### 4. RTG Module

| Field | Value |
|-------|-------|
| `id` | `'rtg_module'` |
| `cat` | `'Power'` |
| `name` | `'RTG Module'` |
| `cost` | `3500` |
| `desc` | `'Pu-238 radioisotope generator. +2 kW constant power, even in eclipse.'` |
| `effect` | `'rtgPower'` |
| `value` | `2.0` |
| `maxLevel` | `1` |
| `requiresAll` | `['multi_junction_solar']` |

**Numerical impact:** Adds **2 Wh/s** constant battery recharge — independent of sunlight, weather, or panel health. During eclipse (35% of orbit), this is the only recharge source. During MPD burst, offsets drain by 2 Wh/s (effective drain: 13 Wh/s → **~8% longer bursts**). Most critically: battery recharges even during eclipse, enabling back-to-back MPD bursts across day/night transitions.

**Concept taught:** Radioisotope Thermoelectric Generators — Plutonium-238 alpha decay produces heat (0.56 W/g), thermoelectric couples (Seebeck effect) convert heat differential to electricity. No moving parts, lasts decades. Powers Voyager 1 (launched 1977, still transmitting from interstellar space), Curiosity, and Perseverance Mars rovers.

**Codex entry:** *"Radioisotope Thermoelectric Generators"* — "An RTG is beautifully simple: Plutonium-238 decays, releasing heat. Thermocouples spanning the hot core and cold radiator fins generate electricity from the temperature difference — the Seebeck effect. No turbines, no moving parts, no fuel to run out (half-life: 87.7 years). Voyager 1's three RTGs have powered it for 48+ years — it's now 24 billion km from Earth, in interstellar space, still transmitting at 23 watts. Your 2 kW micro-RTG uses MMRTG technology (Multi-Mission RTG) scaled down from the Mars Curiosity rover's 110W unit. It will outlast every other component on your spacecraft."

##### 5. Power Beaming Receiver

| Field | Value |
|-------|-------|
| `id` | `'power_beaming'` |
| `cat` | `'Power'` |
| `name` | `'Power Beaming Receiver'` |
| `cost` | `2000` |
| `desc` | `'Rectenna array. +5 kW during ground station passes.'` |
| `effect` | `'powerBeaming'` |
| `value` | `5.0` |
| `maxLevel` | `1` |
| `requiresAll` | `['multi_junction_solar']` |

**Numerical impact:** Adds **5 Wh/s** battery recharge, but **only during ground station pass windows** (already implemented via [`GROUND_STATION_PASS`](js/core/Events.js:219) events, occurring every 300–400s for 30–90s per [`SUBSYSTEMS.GROUND_STATION_INTERVAL`](js/core/Constants.js:681)). During a pass + MPD burst: effective drain = 15 − 5 = 10 Wh/s → **50% longer bursts**. Tactical gameplay: time your MPD burns to coincide with ground station passes.

**Concept taught:** Wireless power transmission via microwave or laser. Rectenna (rectifying antenna) converts microwave energy to DC. JAXA's Space Solar Power program aims to beam solar energy from GEO to Earth's surface. NASA tested laser power beaming to drones. Ground-to-LEO beaming is near-term feasible at ~5 kW with phased array transmitters.

**Codex entry:** *"Wireless Power Transmission"* — "Nikola Tesla dreamed of it in 1901. A century later, it works: ground-based phased-array microwave transmitters focus a beam on your spacecraft's rectenna — a mesh of antennas that convert microwave energy directly to DC electricity. JAXA demonstrated 1.8 kW wireless power transfer over 55 meters in 2015. Your receiver operates at 5.8 GHz (ISM band) with a 1 m² rectenna panel achieving ~85% RF-to-DC conversion. The beam is only available when you're over a ground station — but during those 30–90 second windows, you get free power. The future of space infrastructure: orbital solar farms beaming terawatts to Earth."

#### Upgrade Cost Summary

| Upgrade | Cost | Prereqs | Cumulative Investment |
|---------|------|---------|----------------------|
| Efficient Panels | 500 | — | 500 |
| Extra Battery ×1 | 400 | — | 900 |
| Multi-Junction Solar | 1,200 | Efficient Panels | 1,700 |
| Solid-State Battery | 1,500 | Extra Battery | 2,400 |
| **MPD Thruster** | **3,000** | **MJ Solar + SS Battery** | **5,600** |
| Graphene Supercap | 2,500 | Solid-State Battery | 7,500 |
| RTG Module | 3,500 | MJ Solar | 8,700 |
| Power Beaming | 2,000 | MJ Solar | 9,500 |
| Extra Battery ×2 | 400 | — | 9,900 |
| Hardened Cathode | 1,500 | MPD Thruster | 11,100 |

**Total power chain (all 10 items): 16,500 cr** — roughly 55–80% of the game's ~20–30K total economy. A player fully specializing in MPD power sacrifices most other upgrade paths. This creates meaningful build diversity.

---

### S3b.3 — Power Budget Math

#### Battery Capacity Progression

| Configuration | Battery (Wh) | MPD Duration (s) | MPD ΔV (m/s) |
|---------------|-------------|-----------------|--------------|
| Base (no upgrades) | 100 | 6.7 | 0.64 |
| + Extra Battery ×1 (MPD prereq path) | 150 | 10.0 | 0.96 |
| + Solid-State Battery (MPD prereq) | 300 | 20.0 | 1.92 |
| + Extra Battery ×2 | 350 | 23.3 | 2.24 |
| + Graphene Supercap | 450 | 30.0 | 2.88 |
| With RTG (−2 Wh/s offset) | 450 / 13 Wh/s | 34.6 | 3.32 |
| With Power Beaming during pass (−5 Wh/s) | 450 / 10 Wh/s | 45.0 | 4.32 |

**Sweet spot achieved:** 20–30s bursts with the standard upgrade path. Players who invest in RTG + Power Beaming can push to 35–45s during optimal conditions.

#### Recharge Rate Progression

| Configuration | Solar Rate (Wh/s) | RTG (Wh/s) | Total Gen | Time to Full (450 Wh) |
|---------------|-------------------|------------|-----------|----------------------|
| Base solar (no upgrades) | 8.2 | 0 | 8.2 | 55s |
| + Efficient Panels (1.3×) | 10.6 | 0 | 10.6 | 42s |
| + Multi-Junction Solar (2.0×) | 16.3 | 0 | 16.3 | 28s |
| + RTG Module | 16.3 | 2.0 | 18.3 | 25s |
| Eclipse (solar = 0) + RTG | 0 | 2.0 | 2.0 | 225s (3.75 min) |
| Eclipse + no RTG | 0 | 0 | 0 | ∞ (must wait for sun) |

**Duty cycle (fully upgraded, daylight):** 30s burst → 28s recharge → **~52% uptime** possible (but thermal limits consecutive bursts).

**Duty cycle (fully upgraded, eclipse):** 30s burst → 225s recharge from RTG alone → **~12% uptime** — MPD in eclipse is an emergency tool, not sustainable.

#### Thermal Budget

| Scenario | Heat After Burst | Cooldown Time (no supercap) | Cooldown Time (with supercap) |
|----------|-----------------|----------------------------|------------------------------|
| 10s burst (minimal) | 7 | 23s | 14s |
| 20s burst (mid) | 14 | 47s | 28s |
| 30s burst (full) | 21 | 70s | 42s |
| 45s burst (max w/ beaming) | 31.5 | 105s | 63s |
| Back-to-back 20s bursts | Overheat at 3rd burst | — | Overheat at 4th burst |

The thermal system is secondary to energy — battery runs out long before overheat in single bursts. Thermal's role is preventing exploitation (e.g., rapid burst-recharge-burst cycles with full upgrades).

---

### S3b.4 — Integration with Existing Systems

#### PowerDistribution (3 Buses)

The existing [`PowerDistribution`](js/systems/PowerDistribution.js) routes power across THRUST / SENSORS / ARMS buses. MPD integration:

- **THRUST bus at 0%:** MPD blocked (already implemented in [`thrustMPD()`](js/entities/PlayerSatellite.js:1448))
- **THRUST bus multiplier affects MPD drain efficiency:** Higher allocation → lower waste heat
  `heatRate = MPD_BURST_HEAT_RATE * (1.3 - 0.3 * powerDistribution.thrustMultiplier)`
  - At 100% THRUST (mult 1.3): heat rate = 1.0 (base)
  - At 40% THRUST (mult 1.0): heat rate = 1.0 (base)
  - At 0% THRUST (mult 0.0): blocked entirely
- **Sensor bus unaffected** — sensors work independently of MPD
- **Arm bus unaffected** — arms continue operating during MPD bursts (but draw from same battery → faster total drain if arms + MPD simultaneously)

#### ResourceSystem

**File: [`js/systems/ResourceSystem.js`](js/systems/ResourceSystem.js)**

New upgrade effects to handle in [`applyUpgrade()`](js/systems/ResourceSystem.js:428):

```javascript
case 'supercapUpgrade':
  // Adds burst storage to battery max AND sets thermal flag
  this.batteryMax += data.value;  // +100 Wh
  this.battery = Math.min(this.battery + data.value, this.batteryMax);
  this._hasSupercap = true;  // flag read by PlayerSatellite for thermal dissipation
  break;

case 'rtgPower':
  // Store RTG generation rate (kW → Wh/s)
  this._rtgRate = data.value;  // 2.0 Wh/s
  break;

case 'powerBeaming':
  // Store power beaming rate (active during ground station passes)
  this._powerBeamRate = data.value;  // 5.0 Wh/s
  break;
```

New logic in [`update(dt)`](js/systems/ResourceSystem.js:378):

```javascript
// RTG constant recharge (independent of solar)
if (this._rtgRate > 0 && this.battery < this.batteryMax) {
  this.battery = Math.min(this.batteryMax, this.battery + this._rtgRate * dt);
  this._syncToPlayer();
}

// Power beaming recharge (only during ground station pass)
if (this._powerBeamRate > 0 && this._groundStationInView && this.battery < this.batteryMax) {
  this.battery = Math.min(this.batteryMax, this.battery + this._powerBeamRate * dt);
  this._syncToPlayer();
}
```

Listen for ground station events:

```javascript
eventBus.on(Events.GROUND_STATION_PASS, () => { this._groundStationInView = true; });
// Timeout after window expires — or listen for a ground_station_end event
```

#### PlayerSatellite — MPD Burst State

**File: [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js)**

New state fields (add to constructor after [line 70](js/entities/PlayerSatellite.js:70)):

```javascript
// MPD Burst Mode State
this._mpdArmed = false;           // M key toggle
this._mpdHeat = 0;                // thermal accumulator (0 to MPD_BURST_OVERHEAT_THRESHOLD)
this._mpdCooldownTimer = 0;       // seconds remaining in forced cooldown (0 = ready)
this._mpdDegraded = false;        // true when battery < 5% during burst
this._hasSupercap = false;        // set by GrapheneSupercap upgrade
```

New methods:

```javascript
/** Toggle MPD armed state. Called from InputManager on M key. */
toggleMPDArmed() {
  if (!this._hasMPD) {
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'PROPULSION', text: 'MPD thruster not installed.', priority: 'warning' });
    return;
  }
  if (this._mpdCooldownTimer > 0) {
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'PROPULSION',
      text: `MPD cooling — ${Math.ceil(this._mpdCooldownTimer)}s remaining`,
      priority: 'warning' });
    return;
  }
  
  this._mpdArmed = !this._mpdArmed;
  
  if (this._mpdArmed) {
    eventBus.emit(Events.MPD_BURST_START, { armed: true });
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'PROPULSION', text: '⚡ MPD ARMED — Ludicrous mode active', priority: 'info' });
  } else {
    eventBus.emit(Events.MPD_BURST_END, { reason: 'manual' });
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'PROPULSION', text: 'MPD standby — ion drive resumed', priority: 'info' });
  }
}

get isMPDArmed() { return this._mpdArmed; }
get mpdHeat() { return this._mpdHeat; }
get mpdHeatFraction() {
  return this._mpdHeat / (Constants.MPD_BURST_OVERHEAT_THRESHOLD || 40);
}
get mpdCooldownRemaining() { return this._mpdCooldownTimer; }
```

Modify [`thrustMPD()`](js/entities/PlayerSatellite.js:1443) to track thermal:

```javascript
// After existing thrust application, add thermal tracking:
const heatRate = Constants.MPD_BURST_HEAT_RATE || 1.0;
this._mpdHeat += heatRate * dt;

// Check overheat
if (this._mpdHeat >= (Constants.MPD_BURST_OVERHEAT_THRESHOLD || 40)) {
  this._mpdArmed = false;
  this._mpdCooldownTimer = Constants.MPD_BURST_COOLDOWN_TIME || 15;
  eventBus.emit(Events.MPD_OVERHEAT, { heat: this._mpdHeat });
  eventBus.emit(Events.MPD_BURST_END, { reason: 'overheat' });
  eventBus.emit(Events.COMMS_MESSAGE, {
    sender: 'PROPULSION',
    text: '🔥 MPD THERMAL SHUTDOWN — mandatory cooldown',
    priority: 'critical' });
}

// Battery degradation warning
const batteryFraction = this.resources.battery / this.resources.batteryMax;
if (batteryFraction < (Constants.MPD_BURST_POWER_WARN || 0.15) && batteryFraction > 0) {
  eventBus.emit(Events.MPD_POWER_WARNING, { batteryFraction });
}
```

In the main [`update()`](js/entities/PlayerSatellite.js:890) method, add thermal dissipation:

```javascript
// MPD thermal dissipation (always runs, even when not firing)
if (this._mpdHeat > 0) {
  const coolRate = this._hasSupercap
    ? (Constants.MPD_BURST_COOL_RATE_SUPERCAP || 0.5)
    : (Constants.MPD_BURST_COOL_RATE || 0.3);
  this._mpdHeat = Math.max(0, this._mpdHeat - coolRate * dt);
}

// MPD cooldown timer
if (this._mpdCooldownTimer > 0) {
  this._mpdCooldownTimer -= dt;
  if (this._mpdCooldownTimer <= 0) {
    this._mpdCooldownTimer = 0;
    this._mpdHeat = 0;
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'PROPULSION', text: 'MPD thermal nominal — ready to arm', priority: 'info' });
  }
}

// Auto-disarm if battery depleted while armed
if (this._mpdArmed && this.resources.battery <= 0) {
  this._mpdArmed = false;
  eventBus.emit(Events.MPD_BURST_END, { reason: 'battery_depleted' });
  eventBus.emit(Events.COMMS_MESSAGE, {
    sender: 'PROPULSION', text: 'MPD OFFLINE — battery depleted', priority: 'warning' });
}
```

#### InputManager — M Key + Thrust Routing

**File: [`js/systems/InputManager.js`](js/systems/InputManager.js)**

Add `M` key handler:

```javascript
case 'KeyM':
  if (player && player.hasMPD) {
    player.toggleMPDArmed();
  }
  break;
```

In thrust routing (where W/S/A/D call `thrustIon()`):

```javascript
if (player.isMPDArmed && player.hasMPD) {
  player.thrustMPD(direction, dt);
} else {
  player.thrustIon(direction, dt);
}
```

#### Events to Add

**File: [`js/core/Events.js`](js/core/Events.js:235)** — Add after existing MPD events:

```javascript
// === MPD BURST MODE (S3b) ===
MPD_BURST_START:     'mpd:burstStart',      // { armed } — player armed MPD
MPD_BURST_END:       'mpd:burstEnd',        // { reason: 'manual'|'overheat'|'battery_depleted'|'lithium_depleted' }
MPD_OVERHEAT:        'mpd:overheat',        // { heat } — thermal shutdown triggered
MPD_POWER_WARNING:   'mpd:powerWarning',    // { batteryFraction } — battery low during MPD
```

---

### S3b.5 — HUD Feedback

**File: [`js/ui/hud/StatusPanel.js`](js/ui/hud/StatusPanel.js)**

#### MPD Armed Indicator

When MPD is armed, display a pulsing indicator near the thrust/throttle display:

```
⚡ MPD BURST ████████░░ 73% HEAT
```

- Text color: **magenta** (#ff44ff) when armed, pulsing opacity
- Heat bar: green → amber → red as heat accumulates
- Battery bar tints **purple** (#aa44ff) during MPD drain
- During cooldown: shows "COOLING 12s" with a countdown

#### Battery Bar Purple Tint

In the battery bar rendering, check if MPD is armed:

```javascript
if (player.isMPDArmed) {
  barColor = '#aa44ff'; // purple for MPD drain
  // Flash amber when battery < 15%
  if (batteryFraction < 0.15) {
    barColor = (Date.now() % 500 < 250) ? '#ffaa00' : '#aa44ff';
  }
}
```

#### Heat Bar (Small, Contextual)

Only visible when MPD is armed or heat > 0. Appears as a thin bar below the battery bar:

```
BAT ████████░░ 340/450 Wh ⚡MPD
HEAT ██░░░░░░░░ 17/40       ← only when MPD armed or heat > 0
```

---

### S3b.6 — Audio Feedback

**File: [`js/systems/AudioSystem.js`](js/systems/AudioSystem.js)**

| Event | Sound Design | Method |
|-------|-------------|--------|
| MPD arm (`MPD_BURST_START`) | Deep capacitor charge-up hum (50 Hz → 200 Hz ramp, 0.5s) | `playMPDArm()` |
| MPD firing (continuous) | Electrical crackle + low rumble (pink noise filtered 30-80 Hz + random clicks at 2-5 kHz) | `startMPDHum()` |
| MPD disarm (`MPD_BURST_END`) | Power-down descending tone (200 Hz → 30 Hz, 0.3s) + relay click | `playMPDDisarm()` |
| Power warning (`MPD_POWER_WARNING`) | Descending two-tone (392→329 Hz, existing ALERT earcon) | reuse [`EARCON_FREQUENCIES.ALERT`](js/core/Constants.js:591) |
| Overheat (`MPD_OVERHEAT`) | Alarm beep (rapid 880 Hz pulses, 1s) + steam hiss (white noise burst 0.5s) | `playMPDOverheat()` |
| MPD fire event (per-frame visual) | Modify existing thrust hum: add 120 Hz undertone + pitch shift for MPD type | extend [`startThrusterHum()`](js/systems/AudioSystem.js) |

The MPD hum should be noticeably different from the ion drive hum — deeper, more powerful, with electrical crackling that conveys raw energy being discharged.

---

### S3b.7 — Codex Entries (Aerospace Concepts)

Each power upgrade unlocks a codex entry when purchased. Trigger: `UPGRADE_PURCHASED` event → check if upgrade ID matches, fire `CODEX_UNLOCK_REQUEST`.

| Upgrade | Codex ID | Title | Category | Concept |
|---------|----------|-------|----------|---------|
| Multi-Junction Solar | `multijunction_pv` | Multi-Junction Photovoltaics | Power Systems | Triple-junction GaInP/GaAs/Ge cell stacking, spectral absorption |
| Solid-State Battery | `solid_state_battery` | Solid-State Batteries | Power Systems | Ceramic electrolyte, thermal cycling, energy density |
| Graphene Supercap | `graphene_supercap` | Graphene Supercapacitors | Power Systems | Electron fluid in graphene, HBN dielectric, burst power vs energy storage |
| RTG Module | `rtg_power` | Radioisotope Generators | Power Systems | Pu-238 alpha decay, Seebeck effect, Voyager longevity |
| Power Beaming | `power_beaming` | Wireless Power Transmission | Power Systems | Rectenna, microwave beaming, JAXA SSPS program |
| MPD Armed (first use) | `mpd_burst` | Magnetoplasmadynamic Thrusters | Propulsion | Lorentz force on lithium plasma, J×B acceleration, 150 kW power challenge |

These connect to [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md) §4 (Power Systems), §15 (Power Systems Deep Dive), and §3 (Propulsion). The graphene supercapacitor entry also ties into the existing [`V4 Graphene`](LEARNING_THROUGH_PLAY.md:476) upgrade path descriptions.

---

### S3b.8 — Constants to Add/Modify

**File: [`js/core/Constants.js`](js/core/Constants.js)**

```javascript
// =========================================================================
// MPD THRUSTER — RESTORED to realistic 150 kW (S3b: reverses S3 D3 band-aid)
// =========================================================================

MPD_POWER_DRAW: 150,                    // kW — restored from 5 (S3b Ludicrous Mode redesign)

// --- MPD Burst Mode (S3b) ---
MPD_BURST_HEAT_RATE: 1.0,               // heat units/s while firing
MPD_BURST_COOL_RATE: 0.3,               // heat units/s passive dissipation
MPD_BURST_COOL_RATE_SUPERCAP: 0.5,      // heat dissipation with supercap upgrade
MPD_BURST_OVERHEAT_THRESHOLD: 40,       // heat units for thermal shutdown
MPD_BURST_COOLDOWN_TIME: 15,            // seconds forced cooldown after overheat
MPD_BURST_POWER_WARN: 0.15,             // battery fraction for MPD power warning
MPD_BURST_POWER_DEGRADE: 0.05,          // battery fraction for thrust degradation (50%)

// --- RTG (S3b) ---
RTG_POWER: 2.0,                         // kW constant generation (Wh/s)

// --- Power Beaming (S3b) ---
POWER_BEAM_RATE: 5.0,                   // kW during ground station pass (Wh/s)
```

**Modified constant:** [`MPD_POWER_DRAW`](js/core/Constants.js:485) changes from `5` → `150`.

**Comment update on line 485:**
```javascript
MPD_POWER_DRAW: 150,  // kW (S3b: restored from 5 — Ludicrous Mode with power infrastructure upgrade chain)
```

---

### S3b.9 — Shop Screen Changes

**File: [`js/ui/ShopScreen.js`](js/ui/ShopScreen.js:13)** — Add to `UPGRADES` array:

```javascript
// Power — MPD Infrastructure Chain (S3b)
{ id: 'multi_junction_solar', cat: 'Power', name: 'Multi-Junction Solar', cost: 1200,
  desc: 'GaInP/GaAs/Ge triple-junction. +100% solar efficiency.',
  effect: 'solarEfficiency', value: 2.0, maxLevel: 1,
  requiresAll: ['efficient_panels'] },

{ id: 'solid_state_battery', cat: 'Power', name: 'Solid-State Battery', cost: 1500,
  desc: 'Ceramic electrolyte. +150 Wh capacity. No fire risk.',
  effect: 'batteryMax', value: 150, maxLevel: 1,
  requiresAll: ['extra_battery'] },

{ id: 'graphene_supercap', cat: 'Power', name: 'Graphene Supercapacitor', cost: 2500,
  desc: 'HBN-dielectric graphene. +100 Wh burst. Faster MPD cooling.',
  effect: 'supercapUpgrade', value: 100, maxLevel: 1,
  requiresAll: ['solid_state_battery'] },

{ id: 'rtg_module', cat: 'Power', name: 'RTG Module', cost: 3500,
  desc: 'Pu-238 radioisotope. +2 kW constant — even in eclipse.',
  effect: 'rtgPower', value: 2.0, maxLevel: 1,
  requiresAll: ['multi_junction_solar'] },

{ id: 'power_beaming', cat: 'Power', name: 'Power Beaming Receiver', cost: 2000,
  desc: 'Rectenna array. +5 kW during ground station passes.',
  effect: 'powerBeaming', value: 5.0, maxLevel: 1,
  requiresAll: ['multi_junction_solar'] },
```

**Modify existing MPD Thruster prerequisites** ([line 25](js/ui/ShopScreen.js:25)):

```javascript
{ id: 'mpd_thruster', cat: 'Propulsion', name: 'MPD Thruster', cost: 3000,
  desc: 'Magnetoplasmadynamic thruster. 25N thrust, Isp 3000s. Requires lithium. Press M to arm burst mode.',
  effect: 'mpdThruster', value: true, maxLevel: 1,
  requiresAll: ['solid_state_battery', 'multi_junction_solar'] },  // CHANGED from ['efficient_panels', 'extra_battery']
```

**Update desc** to mention `M` key and burst mode concept.

---

### S3b.10 — File Impact Summary

| File | Changes | LOC Est. |
|------|---------|----------|
| [`Constants.js`](js/core/Constants.js) | Restore `MPD_POWER_DRAW` to 150. Add 8 new burst/RTG/beaming constants. Update MPD comment. | ~15 |
| [`Events.js`](js/core/Events.js) | Add 4 new MPD burst events | ~5 |
| [`ShopScreen.js`](js/ui/ShopScreen.js) | Add 5 new power upgrades. Change MPD prereqs. Update MPD desc. | ~30 |
| [`ResourceSystem.js`](js/systems/ResourceSystem.js) | Add `supercapUpgrade`, `rtgPower`, `powerBeaming` effect handlers in `applyUpgrade()`. Add RTG/beaming recharge in `update()`. Add `_groundStationInView` tracking. Serialize/restore new fields. | ~60 |
| [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) | Add burst state fields. Add `toggleMPDArmed()`, `isMPDArmed`, `mpdHeat` getters. Thermal tracking in `thrustMPD()`. Thermal dissipation + cooldown in `update()`. Auto-disarm logic. Include in telemetry. | ~100 |
| [`InputManager.js`](js/systems/InputManager.js) | Add `M` key handler. Modify thrust routing: if `isMPDArmed` → `thrustMPD()` else → `thrustIon()`. | ~15 |
| [`StatusPanel.js`](js/ui/hud/StatusPanel.js) | MPD armed indicator. Heat bar. Battery purple tint during burst. Cooldown display. | ~50 |
| [`AudioSystem.js`](js/systems/AudioSystem.js) | Add `playMPDArm()`, `startMPDHum()`/`stopMPDHum()`, `playMPDDisarm()`, `playMPDOverheat()`. Wire to events. | ~60 |
| [`CodexSystem.js`](js/systems/CodexSystem.js) | Add 6 new codex entry definitions with trigger conditions. | ~30 |
| **Total** | | **~365** |

---

### S3b.11 — Implementation Order

1. **Constants + Events** (~20 LOC) — Foundation. Restore MPD_POWER_DRAW, add new constants and events.
2. **ShopScreen** (~30 LOC) — Add 5 new upgrades + change MPD prereqs. Immediately testable in shop UI.
3. **ResourceSystem** (~60 LOC) — Handle new upgrade effects, RTG/beaming recharge. Battery math verified.
4. **PlayerSatellite** (~100 LOC) — Burst state, `toggleMPDArmed()`, thermal, auto-disarm. Core mechanic.
5. **InputManager** (~15 LOC) — Wire M key + thrust routing. Now playable end-to-end.
6. **StatusPanel** (~50 LOC) — HUD feedback. Visual verification of all mechanics.
7. **AudioSystem** (~60 LOC) — Sound design. Polish pass.
8. **CodexSystem** (~30 LOC) — Learning content. Final pass.

**Each step is independently testable.** After step 5, the mechanic is fully functional. Steps 6–8 are polish.

---

### S3b.12 — Design Decision Record

**D3 REVERSED:** `MPD_POWER_DRAW` returns to **150 kW** (from 5 kW S3 band-aid).

**Rationale:** The 5 kW value made MPD barely noticeable — a 432-second runtime erased the "powerful but costly" identity. At 150 kW, MPD drains battery in 7–30 seconds depending on upgrades, creating genuine strategic tension: *when* to use MPD, *whether* to invest in the power chain, and *how* to time bursts with recharge windows.

**D5 NEW:** MPD activation method → **M-key toggle** (not hold-to-fire).

**Rationale:** Toggle allows the player to arm MPD, then use standard W/S/A/D for directional control + Z/X throttle + autopilot. Hold-to-fire would require a new modifier key combo and prevent using other controls simultaneously. Toggle also enables a clear HUD state indicator.

**D6 NEW:** MPD prerequisites elevated to Tier 1 power chain.

**Rationale:** Original prereqs (Efficient Panels + Extra Battery = 900 cr) were too cheap for a 25N/3000s Isp thruster. New prereqs (Multi-Junction Solar + Solid-State Battery, requiring EP + EB as sub-prerequisites = 3,600 cr path) ensure the player has invested meaningfully in power infrastructure before accessing MPD. The minimum path to functional MPD (5,600 cr) represents ~20% of total economy — appropriate for a capstone system.

---

*Sprint S3b added 2026-04-10 after analysis of all power/resource systems. Reverses S3 D3 decision. All file paths, line numbers, constants, and event names verified against current codebase.*

---

*This plan was produced after reading all 6 design documents (ORCHESTRATOR_BRIEF, NEXT_STEPS, ROADMAP, FULL_HUD_STRATEGY, MASTER_PLAN, GAMEPLAY_LOOP), both redesign specs (NAVSPHERE_REDESIGN, TARGET_PANEL_REDESIGN), and the key source files (Constants.js, Events.js, GameState.js, GameFlowManager.js, ScoringSystem.js, StatusPanel.js, LassoSystem.js, main.js). Every file path, line number, event name, and constant reference has been verified against the actual codebase.*

---

## Implementation Complete — All Sprints Delivered

> **Completed:** 2026-04-11. All 11 sprints (S1–S10 + S3b) successfully implemented and verified.

| Sprint | Title | Status | LOC | Key Deliverables |
|--------|-------|--------|-----|-----------------|
| S1 | Bug Fixes | ✅ | ~80 | Lasso fire, scoring source of truth, event constants, win guard |
| S2 | Economy Discovery | ✅ | ~120 | Cargo HUD, cargo line, Houston tutorial hints |
| S3 | Balance Pass | ✅ | ~40 | Forge 28→60s, arm thrust verified |
| S3b | MPD Ludicrous Mode | ✅ | ~365 | MPD 150kW, M-key toggle, thermal management, 5 upgrades, HUD, audio, codex |
| S4 | Core Feel | ✅ | ~200 | WASD context switch, lasso windup, tether tension, catch juice, mode indicator |
| S5 | NavSphere Redesign | ✅ | ~325 | Log dual-zone distance, type shapes, closure coloring, zone fills, range rings |
| S6 | Target Panel Redesign | ✅ | ~237 | CSS grid rows, color tiers, progressive reveal, range indicator |
| S7 | Trawl System | ✅ | ~195 | Window tracking with timing, adaptive speed, cluster generation, game loop integration |
| S8 | Unit Tests | ✅ | ~530 | TestRunner.js, 83 tests (6 suites), CLI + browser runners |
| S9 | Sim Identity | ✅ | ~120 | Mass popups, Houston narrative, bracket pulse, single beep, CommsPanel styling |
| S10 | Audio Polish | ✅ | ~85 | Forge phase textures (INTAKE clank, SEPARATE clicks, MELT crackle, COOL sweep) |
| **Total** | | **All ✅** | **~2,300+** | |

### All Design Decisions Resolved

| ID | Decision | Resolution |
|----|----------|------------|
| D1 | Sim vs Arcade Identity | Full Sim Reframe (S9) |
| D2 | Win Condition Threshold | Keep 50 debris |
| D3 | MPD Power Budget | Restored to 150 kW with power infrastructure chain (S3b) |
| D4 | NavSphere Adaptive Zoom | Deferred — hybrid log+dual-zone implemented instead (S5) |
| D5 | MPD Activation Method | M-key toggle (S3b) |
| D6 | MPD Prerequisites | Elevated to Tier 1 power chain (S3b) |

### All Risks Mitigated

All 7 risks from the Risk Register were successfully managed. No rollbacks were required. The additive sprint design strategy proved effective — each sprint's changes were independently testable and reversible.
