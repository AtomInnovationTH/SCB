# Space Cowboy — Implementation Plan V6

> **5 Feature Areas · ~905 LOC estimated · Zero new dependencies**
>
> Generated 2026-04-12 from source analysis of all referenced systems.
> All events use `Events.*` string constants. All tuning knobs in [`Constants.js`](js/core/Constants.js).

---

## Table of Contents

1. [Reward Systems — Synergistic Salvage & Field-Clearing](#1-reward-systems)
2. [Risk-Reward Detach — X Key Sacrifice](#2-risk-reward-detach)
3. [Visual Quick Fixes — Moon & Planets](#3-visual-quick-fixes)
4. [Learning Systems — Codex Expansion & Space Weather](#4-learning-systems)
5. [Tutorial Improvements](#5-tutorial-improvements)
6. [Cross-Cutting Concerns](#6-cross-cutting-concerns)

---

## 1. Reward Systems — Synergistic Salvage & Field-Clearing (~200 LOC) {#1-reward-systems}

### 1.1 Current State Assessment

| Component | File | Status |
|-----------|------|--------|
| Synergy detection | [`RewardSystem.js:277–335`](js/systems/RewardSystem.js:277) | ✅ Working — iterates `SALVAGE_SYNERGIES`, emits `Events.SYNERGY_BONUS` |
| Field clearing | [`RewardSystem.js:342–372`](js/systems/RewardSystem.js:342) | ✅ Working — 25/50/75/100% thresholds with comms |
| Sweep report compilation | [`RewardSystem.js:417–478`](js/systems/RewardSystem.js:417) | ✅ Working — emits `Events.SWEEP_REPORT` with full report object |
| SweepReportUI display | [`SweepReportUI.js:111–113`](js/ui/SweepReportUI.js:111) | ✅ ALREADY WIRED — listens to `Events.SWEEP_REPORT`, renders panel |
| SweepReportUI rendering | [`SweepReportUI.js:192–307`](js/ui/SweepReportUI.js:192) | ✅ Working — stars, synergies, stats, continue button |
| SweepReportUI dismiss | [`SweepReportUI.js:157–180`](js/ui/SweepReportUI.js:157) | ✅ Working — emits `Events.SWEEP_REPORT_DISMISSED` |

**Key Finding:** [`SweepReportUI.js`](js/ui/SweepReportUI.js) is already fully wired. At [line 111](js/ui/SweepReportUI.js:111), `_setupListeners()` subscribes to `Events.SWEEP_REPORT` and calls `this.show(data)`. The rendering at [`_renderReport()`](js/ui/SweepReportUI.js:192) displays all sweep data fields. **No additional wiring needed.**

### 1.2 Gap: Synergy Pair Alignment

**Problem:** [`Constants.SALVAGE_SYNERGIES`](js/core/Constants.js:743) defines different pairs than [`GAME_DESIGN.md:122`](GAME_DESIGN.md:122).

| Source | Pairs | Multiplier Model |
|--------|-------|-----------------|
| **Constants.js (current)** | AL+TI, CU+GA, CARBON+KEVLAR, STEEL+IR, GLASS+CU | Flat point bonuses (200–350 pts) |
| **GAME_DESIGN.md** | SolarPanel+Cu, Ti+Kevlar, Xenon+Thruster, Ga+Ir | Score multipliers (×1.3–×3.0) |

**Decision (Canonical):** Adopt GAME_DESIGN.md's **concept** pairings but keep the flat-bonus model from Constants.js (simpler, already integrated). Map design-doc concepts to actual `metalId` keys emitted by [`CARGO_STORE`](js/core/Events.js:137).

#### 1.2.1 Changes to [`Constants.js`](js/core/Constants.js)

**File:** [`js/core/Constants.js`](js/core/Constants.js) — Replace lines 743–749

```javascript
// Lines 743-749: Replace SALVAGE_SYNERGIES array
SALVAGE_SYNERGIES: [
  { metals: ['GALLIUM', 'COPPER'],           name: 'Complete Solar Array',   points: 300 },
  { metals: ['TITANIUM', 'KEVLAR'],          name: 'Shielding Kit',          points: 250 },
  { metals: ['ALUMINUM', 'STEEL'],           name: 'Structural Alloy',       points: 200 },
  { metals: ['GALLIUM', 'IRIDIUM'],          name: 'Avionics Suite',         points: 500 },
  { metals: ['CARBON_COMPOSITE', 'COPPER'],  name: 'Propulsion Package',     points: 350 },
  { metals: ['GLASS_CERAMIC', 'GALLIUM'],    name: 'Sensor Package',         points: 250 },
],
```

**LOC:** ~8 (replacement of existing lines)

**Rationale:**
- `GALLIUM + COPPER` → "Complete Solar Array" maps to GAME_DESIGN's "Solar panel + Copper wiring" (GaAs is the solar cell material)
- `TITANIUM + KEVLAR` → "Shielding Kit" directly from GAME_DESIGN
- `GALLIUM + IRIDIUM` → "Avionics Suite" (rare, highest bonus) directly from GAME_DESIGN
- `CARBON_COMPOSITE + COPPER` → "Propulsion Package" represents thruster components
- Added `GLASS_CERAMIC + GALLIUM` → "Sensor Package" for more variety
- Kept `ALUMINUM + STEEL` → "Structural Alloy" as a common low-tier synergy

#### 1.2.2 Verify CARGO_STORE metalId Values

**Verification needed:** The [`CARGO_STORE`](js/core/Events.js:137) event emits `{ metalId: string }`. The [`RewardSystem._registerMetals()`](js/systems/RewardSystem.js:283) calls `.toUpperCase()` on each key before adding to the trawl set. The synergy check at [line 303](js/systems/RewardSystem.js:303) compares against `SALVAGE_SYNERGIES[].metals` entries.

**Action:** Verify that [`CargoSystem.js`](js/systems/CargoSystem.js) or [`GameFlowManager.js`](js/systems/GameFlowManager.js) emits `CARGO_STORE` with `metalId` values that, when uppercased, match the synergy keys. The expected values are: `ALUMINUM`, `TITANIUM`, `COPPER`, `GALLIUM`, `IRIDIUM`, `STEEL`, `KEVLAR`, `CARBON_COMPOSITE`, `GLASS_CERAMIC`.

**Risk:** If `metalId` uses different naming (e.g., `gallium_arsenide` instead of `GALLIUM`), synergies will never trigger. Add a `console.warn` in [`_registerMetals()`](js/systems/RewardSystem.js:283) for unknown metal keys during development.

**LOC:** ~3 (debug logging)

### 1.3 Gap: Field Clear Threshold Alignment

**Problem:** Implementation uses 25/50/75/100% but [`GAME_DESIGN.md:195–199`](GAME_DESIGN.md:195) specifies 80/90/100%.

**Decision:** Keep the **implementation's** 25/50/75/100% thresholds. Rationale:
- 80% as the first milestone is too high for early trawls where players may only capture 3–5 of 10 targets
- 25/50/75 provides encouraging feedback during normal play; 100% is the only one with a bonus
- GAME_DESIGN.md's thresholds were conceptual; the four-tier progression tested better for pacing

**Action:** Update [`GAME_DESIGN.md`](GAME_DESIGN.md) to match implementation, documenting the decision.

#### 1.3.1 Add Tiered Field-Clear Bonuses

Currently only 100% clear awards a bonus ([`RewardSystem.js:365–371`](js/systems/RewardSystem.js:365)). Add small bonuses for lower thresholds to reward partial clears.

**File:** [`js/core/Constants.js`](js/core/Constants.js) — Add after line 750

```javascript
// Field Clearing Bonus Tiers (Phase 5 — Reward Systems)
FIELD_CLEAR_THRESHOLDS: [
  { pct: 0.50, bonus: 200,  label: 'Half Clear' },
  { pct: 0.75, bonus: 500,  label: 'Three-Quarter Clear' },
  { pct: 1.00, bonus: 2000, label: 'Perfect Sweep' },
],
```

**LOC:** ~5 (Constants) + ~25 (RewardSystem refactor of [`_checkFieldClearing()`](js/systems/RewardSystem.js:342))

**File:** [`js/systems/RewardSystem.js`](js/systems/RewardSystem.js) — Refactor lines 342–372

```javascript
_checkFieldClearing() {
  if (this._fieldTotal <= 0) return;
  const pct = this._fieldCaptured / this._fieldTotal;

  // Comms-only milestones (no bonus)
  if (pct >= 0.25 && !this._fieldThresholdsHit.has('25')) {
    this._fieldThresholdsHit.add('25');
    this._sendComms('Houston: Quarter of this cluster secured.');
  }

  // Tiered bonuses from Constants
  const tiers = Constants.FIELD_CLEAR_THRESHOLDS || [];
  for (const tier of tiers) {
    const key = String(Math.round(tier.pct * 100));
    if (pct >= tier.pct && !this._fieldThresholdsHit.has(key)) {
      this._fieldThresholdsHit.add(key);
      this._trawlBonusPoints += tier.bonus;
      eventBus.emit(Events.SCORING_AWARD, {
        points: tier.bonus,
        reason: tier.label,
      });
      if (tier.pct >= 1.0) {
        this._sendComms('Houston: Field completely cleared! Perfect sweep. Bonus authorized.');
      } else if (tier.pct >= 0.75) {
        this._sendComms('Houston: Three-quarters clean. Almost there.');
      } else if (tier.pct >= 0.50) {
        this._sendComms('Houston: Half the cluster cleared. Keep it up.');
      }
    }
  }
}
```

**LOC:** ~25 (replaces ~30 existing lines — net ~0)

### 1.4 Implementation Order

1. Update [`Constants.SALVAGE_SYNERGIES`](js/core/Constants.js:743) with new metal pairs (~8 LOC)
2. Add [`Constants.FIELD_CLEAR_THRESHOLDS`](js/core/Constants.js) (~5 LOC)
3. Refactor [`RewardSystem._checkFieldClearing()`](js/systems/RewardSystem.js:342) to use threshold array (~25 LOC)
4. Add debug logging in [`_registerMetals()`](js/systems/RewardSystem.js:283) to verify `metalId` values (~3 LOC)
5. Update [`GAME_DESIGN.md`](GAME_DESIGN.md) field clearing section (~5 LOC)
6. Verify `SweepReportUI` renders with new synergy names (manual test)

### 1.5 Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| `metalId` mismatch — synergies never trigger | HIGH | Add debug logging; verify CargoSystem emit format |
| `FIELD_CLEAR_THRESHOLDS` undefined in older saves | LOW | Fallback: `Constants.FIELD_CLEAR_THRESHOLDS \|\| []` |
| `SweepReportUI` not instantiated in game loop | MEDIUM | Verify [`main.js`](js/main.js) creates `SweepReportUI` instance |
| Synergy bonus awarded but not visible | LOW | `SweepReportUI._renderReport()` already renders synergy list |

### 1.6 LOC Summary

| File | Change | LOC |
|------|--------|-----|
| [`Constants.js`](js/core/Constants.js) | Replace synergies, add thresholds | ~13 |
| [`RewardSystem.js`](js/systems/RewardSystem.js) | Refactor field clearing, add debug | ~28 |
| [`GAME_DESIGN.md`](GAME_DESIGN.md) | Document decisions | ~10 |
| **Total** | | **~51** |

---

## 2. Risk-Reward Detach — X Key Sacrifice for ×2.5 Score (~150 LOC) {#2-risk-reward-detach}

### 2.1 Current State Assessment

| Component | File | Status |
|-----------|------|--------|
| Constants | [`Constants.js:753–760`](js/core/Constants.js:753) | ✅ DETACH_SCORE_MULT: 2.0, DETACH_SACRIFICE_MULT: 2.5, DETACH_FAIL_PENALTY: -500 |
| Events | [`Events.js:187–188`](js/core/Events.js:187) | ✅ `ARM_DETACHED`, `ARM_LOST` defined |
| ARM_STATES | [`Constants.js:174–195`](js/core/Constants.js:174) | ✅ 20 states including `TANGLED` |
| ArmUnit flags | [`ArmUnit.js:81–84`](js/entities/ArmUnit.js:81) | ✅ `isDetached`, `_detachFuelWarning25`, `_detachFuelWarning10` |
| RewardSystem listeners | [`RewardSystem.js:115–131`](js/systems/RewardSystem.js:115) | ✅ Listens for `ARM_DETACHED`, `ARM_DEORBIT` |
| RewardSystem milestones | [`RewardSystem.js:238–250`](js/systems/RewardSystem.js:238) | ✅ firstDetach, firstDetachedDeorbit milestones |
| Tutorial hint | [`TutorialSystem.js:587–597`](js/systems/TutorialSystem.js:587) | ✅ `showDetachHint()` — "[X] Detach — FREE FLIGHT" |
| ScoringSystem multipliers | [`ScoringSystem.js:137–175`](js/systems/ScoringSystem.js:137) | ⚠️ `manualCapture`, `deorbitSacrifice` exist but no `detachedCapture` path |

### 2.2 What Needs Building

#### 2.2.1 InputManager — X Key Binding (~15 LOC)

**File:** [`js/systems/InputManager.js`](js/systems/InputManager.js) — Add case in [`_handleKeyDown()`](js/systems/InputManager.js:108) switch block (after existing key handlers, ~line 300)

```javascript
// X key — TETHER DETACH (Phase 6 — Risk-Reward)
case 'KeyX':
  if (isGameplay && d.armManager) {
    const arm = d.armManager.getActiveDetachCandidate();
    if (arm) {
      d.armManager.detachArm(arm.index);
      d.audioSystem.playClick();
    } else {
      eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'No arm available for detach.',
        priority: 'warning',
      });
    }
  }
  break;
```

**LOC:** ~15

**Notes:**
- Only fires during gameplay state
- Delegates to [`ArmManager.getActiveDetachCandidate()`](js/entities/ArmManager.js) to find the right arm
- Audio feedback on success

#### 2.2.2 ArmUnit — `detach()` Method (~40 LOC)

**File:** [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js) — Add new method

**States that allow detach:** An arm must be in a state where the tether is deployed and tension is meaningful. Allowed states:

| State | Rationale |
|-------|-----------|
| `TRANSIT` | Arm in flight toward target — tether getting long |
| `APPROACH` | Close to target — tether near limit |
| `FISHING` | Deployed on tether, ambushing — tether at length |
| `TANGLED` | **Key decision point** — tangle forces choice: resolve or cut free |
| `NETTING` | Attempting capture at range — risky moment |
| `GRAPPLED` | Has debris, tether under load — sacrifice scenario |

**Disallowed states:** `DOCKED`, `LAUNCHING`, `REELING`, `DOCKING`, `RELOADING`, `ABLATING`, `SCANNING`, `EXPENDED`, `DEORBITING`

```javascript
/**
 * Sever the tether and enter free-flight mode.
 * Arm continues on current velocity + remaining FEEP fuel.
 * @returns {boolean} true if detach succeeded
 */
detach() {
  const DETACHABLE = new Set([
    S.TRANSIT, S.APPROACH, S.FISHING, S.TANGLED, S.NETTING, S.GRAPPLED
  ]);
  if (!DETACHABLE.has(this.state)) return false;
  if (this.isDetached) return false; // already detached

  this.isDetached = true;

  // If tangled, resolve the tangle by cutting
  const wasTangled = this.state === S.TANGLED;

  // Preserve current state capabilities but sever tether
  this.tetherLength = 0; // tether is gone

  // Emit detach event
  eventBus.emit(Events.ARM_DETACHED, {
    armId: this.index,
    position: this.position.clone(),
    fuelRemaining: this.fuel,
    wasTangled,
    hasDebris: this.capturedDebris !== null,
  });

  // NOTE: Slo-mo is NOT an event — it's triggered in main.js directly.
  // main.js must add a listener for ARM_DETACHED → set slowMoTimer.
  // See §2.2.6 below for main.js wiring.

  // Comms callout
  const callout = wasTangled
    ? `Houston: ${this.id} — tether cut from tangle. She's flying free.`
    : `Houston: ${this.id} — tether severed. COWBOY! Free-flight on own fuel.`;
  eventBus.emit(Events.COMMS_MESSAGE, { text: callout, priority: 'HIGH' });

  console.log(`[ArmUnit] ${this.id} DETACHED (fuel: ${this.fuel.toFixed(1)}%, tangled: ${wasTangled})`);
  return true;
}
```

**LOC:** ~40

**Free-flight behavior:** The detached arm continues using existing FEEP thrust logic in its current state's `update()`. The key difference: `tetherLength = 0` means no reel-back is possible. When fuel reaches 0, transition to `EXPENDED` and emit `ARM_LOST`.

**Additional change in ArmUnit update loop (~15 LOC):** Add fuel monitoring for detached arms.

```javascript
// In the per-frame update method, add detached-arm fuel warnings:
if (this.isDetached && this.fuel > 0) {
  if (this.fuel <= Constants.DETACH_FUEL_WARNING_10 * 100 && !this._detachFuelWarning10) {
    this._detachFuelWarning10 = true;
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Houston: ${this.id} — CRITICAL: 10% fuel. Capture now or lose her.`,
      priority: 'HIGH',
    });
  } else if (this.fuel <= Constants.DETACH_FUEL_WARNING_25 * 100 && !this._detachFuelWarning25) {
    this._detachFuelWarning25 = true;
    eventBus.emit(Events.COMMS_MESSAGE, {
      text: `Houston: ${this.id} — fuel at 25%. Running out of options.`,
      priority: 'MEDIUM',
    });
  }
}
// When fuel hits 0 and detached:
if (this.isDetached && this.fuel <= 0 && this.state !== S.EXPENDED) {
  this.state = S.EXPENDED;
  eventBus.emit(Events.ARM_LOST, { armId: this.index });
  eventBus.emit(Events.COMMS_MESSAGE, {
    text: `Houston: ${this.id} — fuel depleted. Godspeed. She's gone.`,
    priority: 'HIGH',
  });
}
```

**LOC:** ~15

#### 2.2.3 ArmManager — Route Detach & Tracking (~20 LOC)

**File:** [`js/entities/ArmManager.js`](js/entities/ArmManager.js) — Add two methods

```javascript
/**
 * Get the best candidate arm for detach.
 * Priority: TANGLED > APPROACH > TRANSIT > FISHING > NETTING > GRAPPLED.
 * If ARM PILOT is active, prefer the piloted arm.
 * @returns {ArmUnit|null}
 */
getActiveDetachCandidate() {
  const PRIORITY = ['TANGLED', 'APPROACH', 'TRANSIT', 'FISHING', 'NETTING', 'GRAPPLED'];
  // If a specific arm is selected (arm pilot mode), prefer it
  const selected = this.getSelectedDeployedArm();
  if (selected && !selected.isDetached) {
    const detachable = new Set(PRIORITY);
    if (detachable.has(selected.state)) return selected;
  }
  // Otherwise find highest-priority candidate
  for (const state of PRIORITY) {
    const arm = this.arms.find(a => a.state === state && !a.isDetached);
    if (arm) return arm;
  }
  return null;
}

/**
 * Execute detach on a specific arm by index.
 * @param {number} armIndex
 * @returns {boolean}
 */
detachArm(armIndex) {
  const arm = this.arms[armIndex];
  if (!arm) return false;
  return arm.detach();
}
```

**LOC:** ~20

#### 2.2.4 ScoringSystem — Detach Multiplier Paths (~20 LOC)

**File:** [`js/systems/ScoringSystem.js`](js/systems/ScoringSystem.js) — Add in [`awardPoints()`](js/systems/ScoringSystem.js:110) after the existing multiplier blocks (after line 175)

```javascript
// Phase 6: Detached arm capture — ×2.0 for free-flying catch
if (data.detachedCapture) {
  points = Math.round(points * Constants.DETACH_SCORE_MULT);
  eventBus.emit(Events.COMMS_MESSAGE, {
    source: 'HOUSTON',
    text: 'COWBOY! Free-flying capture! Textbook maneuver.',
    priority: 1,
  });
}

// Phase 6: Detached arm deorbit sacrifice — ×2.5
if (data.detachedSacrifice) {
  points = Math.round(points * Constants.DETACH_SACRIFICE_MULT);
  eventBus.emit(Events.COMMS_MESSAGE, {
    source: 'HOUSTON',
    text: 'Godspeed. She took the debris with her. Sacrifice noted.',
    priority: 1,
  });
}
```

**LOC:** ~16

#### 2.2.5 GameFlowManager — Wire ARM_DETACHED/ARM_LOST (~15 LOC)

**File:** [`js/systems/GameFlowManager.js`](js/systems/GameFlowManager.js) — Add listeners in event wiring section

```javascript
// Phase 6: Tether Detach scoring context
eventBus.on(Events.ARM_DETACHED, (data) => {
  // Tag subsequent captures from this arm with detach context
  // (RewardSystem already tracks this)
  console.log(`[GameFlow] Arm ${data.armId} detached, fuel: ${data.fuelRemaining}%`);
});

eventBus.on(Events.ARM_LOST, (data) => {
  // Apply fail penalty
  const penalty = Constants.DETACH_FAIL_PENALTY;
  scoringSystem.totalScore += penalty; // negative
  scoringSystem.credits += penalty;
  eventBus.emit(Events.SCORE_UPDATE, {
    total: scoringSystem.totalScore,
    credits: scoringSystem.credits,
    delta: penalty,
  });
});
```

**LOC:** ~15

#### 2.2.6 main.js — Detach Slo-Mo Wiring (~5 LOC)

**File:** [`js/main.js`](js/main.js) — Add after the existing slo-mo listeners at [line 314](js/main.js:314)

Slo-mo in this project is NOT event-driven — it's set directly via `slowMoTimer`/`slowMoFactor` variables in [`main.js`](js/main.js). The existing pattern at [line 303](js/main.js:303) listens for `Events.ARM_CAPTURED` and `Events.LASSO_CAPTURED`. Detach needs the same treatment:

```javascript
// ADD after line 314 (after LASSO_CAPTURED slo-mo):
eventBus.on(Events.ARM_DETACHED, () => {
  slowMoTimer = Constants.DETACH_SLOWMO_DURATION;
  slowMoFactor = Constants.DETACH_SLOWMO_FACTOR;
});
```

**LOC:** ~5

### 2.3 TANGLED State as Decision Point

The V5 crossbow's [`TANGLED`](js/core/Constants.js:193) state creates an organic decision fork:

```
ARM in TRANSIT/APPROACH → tether crosses another arm's tether
  ↓
State transitions to TANGLED
  ↓
Player faces choice:
  [Wait] → Auto-resolve after TANGLE_RESOLVE_TIME (Constants)
  [X]    → Cut tether, go free-flight → potential ×2.0/×2.5 score
```

This leverages existing [`Events.TETHER_TANGLE`](js/core/Events.js:258) and the tangle resolution timer in [`ArmUnit.js`](js/entities/ArmUnit.js). The `detach()` method handles `TANGLED` state specifically by setting `wasTangled: true` in the event payload — useful for achievement tracking and Houston callouts.

### 2.4 Implementation Order

1. **[`ArmUnit.detach()`](js/entities/ArmUnit.js)** — Core method, no external dependencies (~40 LOC)
2. **[`ArmUnit`](js/entities/ArmUnit.js) fuel monitoring** — Detached arm fuel warnings + ARM_LOST (~15 LOC)
3. **[`ArmManager`](js/entities/ArmManager.js) routing** — `getActiveDetachCandidate()`, `detachArm()` (~20 LOC)
4. **[`InputManager.js`](js/systems/InputManager.js) X key** — Requires ArmManager methods (~15 LOC)
5. **[`ScoringSystem.js`](js/systems/ScoringSystem.js)** — Multiplier paths (~16 LOC)
6. **[`GameFlowManager.js`](js/systems/GameFlowManager.js)** — ARM_LOST penalty wiring (~15 LOC)
7. **[`main.js`](js/main.js)** — ARM_DETACHED slo-mo listener (~5 LOC)

### 2.5 Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Detached arm drifts off-screen permanently | MEDIUM | ARM_LOST auto-fires when fuel=0; add max-distance kill (5km) |
| Capture event from detached arm missing context | HIGH | Ensure ArmUnit capture logic includes `detached: this.isDetached` in payload |
| X key fires during non-gameplay states | LOW | Guarded by `isGameplay` check |
| Slo-mo not triggered on detach | MEDIUM | FIXED: `main.js` listener for `ARM_DETACHED` sets `slowMoTimer` directly (§2.2.6) |
| Double detach on same arm | LOW | `if (this.isDetached) return false` guard |

### 2.6 LOC Summary

| File | Change | LOC |
|------|--------|-----|
| [`ArmUnit.js`](js/entities/ArmUnit.js) | `detach()` + fuel monitoring | ~55 |
| [`ArmManager.js`](js/entities/ArmManager.js) | Candidate selection + routing | ~20 |
| [`InputManager.js`](js/systems/InputManager.js) | X key binding | ~15 |
| [`ScoringSystem.js`](js/systems/ScoringSystem.js) | Detach multiplier paths | ~16 |
| [`GameFlowManager.js`](js/systems/GameFlowManager.js) | ARM_LOST penalty | ~15 |
| [`main.js`](js/main.js) | ARM_DETACHED slo-mo | ~5 |
| **Total** | | **~126** |

---

## 3. Visual Quick Fixes — Moon & Planets (~0 LOC remaining) {#3-visual-quick-fixes}

### 3.1 Current State Assessment — ALREADY COMPLETE ✅

**Key Finding:** Both the moon mesh upgrade and planet meshes are **already fully implemented** in [`SunLight.js`](js/scene/SunLight.js).

#### Moon Mesh (Lines 280–321)

| Feature | Status | Location |
|---------|--------|----------|
| `CircleGeometry` mesh (not Sprite) | ✅ | [`SunLight.js:283`](js/scene/SunLight.js:283) — `new THREE.CircleGeometry(9, 32)` |
| Canvas radial gradient texture | ✅ | [`createMoonDiscTexture()`](js/scene/SunLight.js:65) — 128px |
| Depth mask at r=398 | ✅ | [`SunLight.js:303–309`](js/scene/SunLight.js:303) — `DEPTH_MASK_DIST = 398` |
| Phase rendering (brightness) | ✅ | [`_updateMoon():477–480`](js/scene/SunLight.js:477) — `opacity = brightness * 0.7` |
| Camera-facing billboard | ✅ | [`SunLight.js:296–298`](js/scene/SunLight.js:296) — `onBeforeRender → lookAt(camera)` |
| Earth occlusion | ✅ | [`_updateMoon():496–501`](js/scene/SunLight.js:496) — geometric CPU-side test |
| Planetarium label | ✅ | [`SunLight.js:312–320`](js/scene/SunLight.js:312) — canvas text label sprite |
| `depthTest: false` (avoid self-occlusion by mask) | ✅ | [`SunLight.js:289`](js/scene/SunLight.js:289) |

#### Planet Meshes (Lines 513–603)

| Feature | Status | Location |
|---------|--------|----------|
| 5 planets defined | ✅ | [`PLANET_DEFS`](js/scene/SunLight.js:105) — Mercury, Venus, Mars, Jupiter, Saturn |
| `CircleGeometry` disc meshes | ✅ | [`_createPlanets():518–527`](js/scene/SunLight.js:518) |
| Glow halos (AdditiveBlending) | ✅ | [`_createPlanets():530–540`](js/scene/SunLight.js:530) |
| Depth masks at r=398 | ✅ | [`_createPlanets():553–559`](js/scene/SunLight.js:553) |
| Ecliptic positioning | ✅ | [`_updatePlanets():570–603`](js/scene/SunLight.js:570) — angle from sun |
| Camera-facing billboard | ✅ | [`_createPlanets():526`](js/scene/SunLight.js:526) — `onBeforeRender → lookAt(camera)` |
| Earth occlusion | ✅ | [`_updatePlanets():596–602`](js/scene/SunLight.js:596) |
| Canvas text labels | ✅ | [`_createPlanets():543–549`](js/scene/SunLight.js:543) |
| Color tints per planet | ✅ | [`PLANET_DEFS`](js/scene/SunLight.js:105) — hex colors |

### 3.2 Remaining Polish (Optional)

If any visual improvements are desired:

1. **Bloom interaction:** Planet discs use `depthTest: false` but are NOT added to the bloom layer. This is intentional (planets shouldn't bloom like the sun). No change needed.

2. **Saturn ring:** Could add a small elliptical ring sprite. ~10 LOC if desired.

3. **Moon crescent:** The current phase model uses opacity only. A crescent shadow could be achieved with a second overlaid circle. ~20 LOC if desired, but the opacity-based approach is visually sufficient.

### 3.3 LOC Summary

| Change | LOC |
|--------|-----|
| Already complete — no changes needed | **0** |
| Optional Saturn ring | ~10 |
| Optional moon crescent | ~20 |

---

## 4. Learning Systems — Codex Expansion & Space Weather (~350 LOC) {#4-learning-systems}

### 4.1 Current State Assessment

| Component | File | Status |
|-----------|------|--------|
| CodexSystem | [`CodexSystem.js`](js/systems/CodexSystem.js) (940 LOC) | ✅ 45 entries, 9 categories, event-driven unlock with 30s cooldown |
| Entry structure | [`CodexSystem.js:38–49`](js/systems/CodexSystem.js:38) | ✅ `{ id, title, category, shortText, fullText, triggerEvent, triggerCondition, unlocked, seen, icon }` |
| SpaceWeatherSystem | [`SpaceWeatherSystem.js`](js/systems/SpaceWeatherSystem.js) (421 LOC) | ✅ 4 event types, functional |
| SubsystemEvents | [`SubsystemEvents.js`](js/systems/SubsystemEvents.js) (772 LOC) | ✅ 6 subsystem generators |
| LEARNING_THROUGH_PLAY.md | [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md) (1423 LOC) | ✅ ~99 concepts defined |
| CodexViewerUI | [`CodexViewerUI.js`](js/ui/CodexViewerUI.js) | ✅ L-key toggle viewer |

### 4.2 Codex Expansion — ~54 New Entries (~250 LOC)

New entries are added to the `buildEntries()` function in [`CodexSystem.js`](js/systems/CodexSystem.js). Each entry follows the existing pattern at [line 38](js/systems/CodexSystem.js:38).

#### 4.2.1 Priority Entries by Category

##### ORBITAL_MECHANICS (6 new → 10 total)

| id | title | trigger | LOC |
|----|-------|---------|-----|
| `prograde_paradox` | The Orbital Speed Paradox | First retrograde thrust | ~4 |
| `j2_perturbation` | J2 Oblateness | After 10 orbits elapsed | ~4 |
| `atmospheric_drag` | Atmospheric Drag | Debris below 300km deorbits naturally | ~4 |
| `relative_velocity` | Relative Velocity | First approach within 100m | ~4 |
| `orbital_period_altitude` | Period vs Altitude | View OrbitMFD at different altitudes | ~4 |
| `raan_precession` | RAAN Precession | After visiting 2+ inclination bands | ~4 |

##### PROPULSION (4 new → 10 total)

| id | title | trigger | LOC |
|----|-------|---------|-----|
| `spring_energy` | Spring Energy Storage | First crossbow fire | ~4 |
| `recoil_cancellation` | Recoil Cancellation | First dual-fire | ~4 |
| `cold_gas_rcs` | Cold Gas RCS | Use WASD in RCS mode 10+ times | ~4 |
| `specific_impulse` | Specific Impulse | Cycle fuel types with T key | ~4 |

##### MATERIALS (8 new → ~10 total)

| id | title | trigger | LOC |
|----|-------|---------|-----|
| `graphene_gsl` | Graphene Structural Lattice | Web shot | ~4 |
| `hbn_coating` | Hexagonal Boron Nitride | Atomic oxygen event | ~4 |
| `kevlar_mli` | Kevlar & MLI Shielding | Capture debris with MLI material | ~4 |
| `aluminum_space` | Aluminum in Space | First aluminum salvage | ~4 |
| `gallium_arsenide` | Gallium Arsenide Solar | First gallium salvage | ~4 |
| `titanium_alloys` | Titanium Aerospace Alloys | First titanium salvage | ~4 |
| `carbon_composites` | Carbon Fiber Composites | First carbon composite salvage | ~4 |
| `iridium_avionics` | Iridium in Spacecraft | First iridium salvage | ~4 |

##### TETHERS (6 new → ~10 total)

| id | title | trigger | LOC |
|----|-------|---------|-----|
| `tether_materials` | Tether Materials: Dyneema & Zylon | First tether tier upgrade | ~4 |
| `tether_dynamics` | Tether Dynamics | First tether reel >50m | ~4 |
| `tether_tangle` | Tether Tangle Physics | First TANGLED state | ~4 |
| `edt_physics` | Electrodynamic Tether | Deploy EDT bait | ~4 |
| `miura_ori_net` | Miura-Ori Net Folding | First net deploy | ~4 |
| `reel_mechanics` | Reel Motor Mechanics | First reel-in after capture | ~4 |

##### SENSORS (5 new → ~8 total)

| id | title | trigger | LOC |
|----|-------|---------|-----|
| `gps_denied` | GPS-Denied Navigation | GPS denied subsystem event | ~4 |
| `kalman_filtering` | Kalman Filtering | After 50+ targets tracked | ~4 |
| `star_tracker` | Star Tracker Navigation | Star tracker subsystem event | ~4 |
| `pulse_scan_radar` | Pulse Scan Distributed Radar | First pulse scan | ~4 |
| `lidar_ranging` | LIDAR Ranging | First approach within 10m | ~4 |

##### SPACE_ENVIRONMENT (6 new → ~10 total)

| id | title | trigger | LOC |
|----|-------|---------|-----|
| `saa_radiation` | South Atlantic Anomaly | First SAA passage | ~4 |
| `atomic_oxygen` | Atomic Oxygen Erosion | Atomic oxygen subsystem event | ~4 |
| `uv_degradation` | UV Degradation | UV degradation subsystem event | ~4 |
| `mmod_impact` | MMOD Impacts | MMOD subsystem event | ~4 |
| `geomagnetic_storm` | Geomagnetic Storms | First geomagnetic storm | ~4 |
| `radiation_dose` | Radiation Dose Tracking | Radiation dose subsystem event | ~4 |

##### COMMS (6 new → ~8 total)

| id | title | trigger | LOC |
|----|-------|---------|-----|
| `ground_station_pass` | Ground Station Passes | First ground station event | ~4 |
| `telemetry_bandwidth` | Telemetry Bandwidth | 3+ arms deployed bandwidth warning | ~4 |
| `laser_comms` | Laser Communications | Laser comms hint from SubsystemEvents | ~4 |
| `tdrs_relay` | TDRS Relay Satellites | After 5 ground station passes | ~4 |
| `signal_propagation` | Signal Propagation Delay | Total game time > 30 min | ~4 |
| `frequency_bands` | S-Band vs Ka-Band | After first SAA comms degradation | ~4 |

##### POWER (5 new → ~8 total)

| id | title | trigger | LOC |
|----|-------|---------|-----|
| `cmg_gyroscopes` | CMGs & Reaction Wheels | Gyro check subsystem event | ~4 |
| `spin_stabilization` | Spin Stabilization | Ablation despin event | ~4 |
| `battery_cycles` | Battery Cycle Life | Battery cycle subsystem event | ~4 |
| `solar_cell_degradation` | Solar Cell Degradation | UV degradation event | ~4 |
| `power_bus_management` | Power Bus ETS | First bus switch | ~4 |

##### DEBRIS (8 new → ~12 total)

| id | title | trigger | LOC |
|----|-------|---------|-----|
| `debris_classification` | Debris Size Classification | First 5 different debris types captured | ~4 |
| `trackable_vs_untrackable` | Trackable vs Dark Debris | Sensor upgrade for untracked | ~4 |
| `conjunction_assessment` | Conjunction Assessment | First conjunction warning | ~4 |
| `breakup_events` | Breakup Events | First Kessler fragment | ~4 |
| `iridium_cosmos` | Iridium-Cosmos Collision | After 10 defunct sats captured | ~4 |
| `fengyun_test` | FengYun-1C ASAT Test | After Kessler cascade | ~4 |
| `ssa_network` | Space Situational Awareness | After 50 debris cleared | ~4 |
| `adr_methods_real` | Active Debris Removal IRL | After 100 debris cleared | ~4 |

**Total new entries:** 54
**LOC per entry:** ~4–5 lines (compact format)
**Total LOC:** ~250

#### 4.2.2 Entry Template

```javascript
{
  id: 'spring_energy',
  title: 'Spring Energy Storage',
  category: CodexCategory.PROPULSION,
  shortText: 'Crossbow arms use compressed springs — stored mechanical energy releases with zero propellant cost.',
  fullText: 'Spring-launched projectiles use stored elastic potential energy (½kx²). Your crossbow arms compress a spring via worm gear, storing 2–5 J of energy. On release, this accelerates the 2–7 kg bolt to 0.5–1.5 m/s — enough for LEO proximity ops. Zero propellant cost for the launch itself, though FEEP thrusters handle final approach.',
  triggerEvent: Events.CROSSBOW_FIRE,
  triggerCondition: () => true,
  unlocked: false,
  seen: false,
  icon: '🏹',
},
```

#### 4.2.3 Unlock Trigger Mapping

| Trigger Event | Codex Entries Unlocked |
|---------------|----------------------|
| `Events.CROSSBOW_FIRE` | spring_energy, miura_ori_net |
| `Events.DUAL_FIRE` | recoil_cancellation |
| `Events.TETHER_TANGLE` | tether_tangle |
| `Events.PULSE_SCAN_COMPLETE` | pulse_scan_radar |
| `Events.ABLATION_END` | spin_stabilization |
| `Events.CARGO_STORE` (with metalId conditions) | aluminum_space, gallium_arsenide, titanium_alloys, etc. |
| `Events.WEATHER_EFFECT_START` (type conditions) | saa_radiation, geomagnetic_storm |
| `Events.SUBSYSTEM_EVENT` (source conditions) | ground_station_pass, gps_denied, star_tracker, etc. |
| `Events.CONJUNCTION_WARNING` | conjunction_assessment |
| `Events.KESSLER_CASCADE` | breakup_events, fengyun_test |
| `Events.FUEL_CHANGED` | specific_impulse |
| `Events.ARM_DETACHED` | (no codex — already a reward event) |
| `Events.TETHER_REEL_STATE` | reel_mechanics, tether_dynamics |

### 4.3 SubsystemEvents → Codex Bridge (~100 LOC)

**Current state:** [`SubsystemEvents.js`](js/systems/SubsystemEvents.js) already emits `Events.SUBSYSTEM_EVENT` with `{ source, text }` payloads. The CodexSystem listens for arbitrary events with `triggerCondition` predicates.

**Approach:** No new system needed. Each new codex entry with a subsystem trigger uses `Events.SUBSYSTEM_EVENT` as its `triggerEvent` and checks the `source` field in `triggerCondition`.

**Example:**

```javascript
{
  id: 'gps_denied',
  title: 'GPS-Denied Navigation',
  category: CodexCategory.SENSORS,
  shortText: 'When GPS is jammed or unavailable, spacecraft rely on star trackers and inertial measurement.',
  fullText: 'GPS signals can be interrupted by solar storms, SAA passages, or deliberate jamming. Spacecraft carry backup navigation: star trackers compute attitude from star patterns, while IMUs (inertial measurement units) dead-reckon using accelerometers and gyroscopes. Kalman filters fuse these noisy measurements into usable position estimates.',
  triggerEvent: Events.SUBSYSTEM_EVENT,
  triggerCondition: (p) => p.source === 'NAVIGATION' && p.text && p.text.includes('GPS'),
  unlocked: false,
  seen: false,
  icon: '📡',
},
```

**Weather events triggering codex:** Already works via `Events.WEATHER_EFFECT_START` with type checking.

**LOC for bridge logic:** ~0 extra — the existing `triggerCondition` predicate system handles this. The LOC is in the entries themselves.

### 4.4 Implementation Order

1. **Add category entries in batches** to [`CodexSystem.js buildEntries()`](js/systems/CodexSystem.js:35):
   - Batch 1: PROPULSION + TETHERS (crossbow-related, 10 entries, ~50 LOC)
   - Batch 2: MATERIALS + DEBRIS (salvage-related, 16 entries, ~80 LOC)
   - Batch 3: SENSORS + COMMS (subsystem-triggered, 11 entries, ~55 LOC)
   - Batch 4: ORBITAL_MECHANICS + SPACE_ENVIRONMENT + POWER (11 entries, ~55 LOC)
   - Batch 5: Remaining entries (6 entries, ~30 LOC)
2. **Test unlock triggers** — verify each event correctly fires and conditions match
3. **Verify SubsystemEvents source strings** match triggerCondition checks

### 4.5 Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| 99 entries overwhelm the CodexViewerUI layout | LOW | UI already handles scrolling; categories provide organization |
| Unlock cooldown (30s) creates long queues | MEDIUM | Queue system already handles this; consider reducing to 20s for expansion |
| SubsystemEvent source strings don't match | HIGH | Audit SubsystemEvents.js source names against triggerCondition predicates |
| Save/restore breaks with new entry IDs | LOW | `restore()` gracefully skips unknown IDs |
| triggerCondition predicate errors crash game | HIGH | Wrap all triggerCondition calls in try/catch (already done in CodexSystem) |

### 4.6 LOC Summary

| File | Change | LOC |
|------|--------|-----|
| [`CodexSystem.js`](js/systems/CodexSystem.js) | 54 new entries in `buildEntries()` | ~250 |
| [`Constants.js`](js/core/Constants.js) | Possibly reduce `CODEX.UNLOCK_COOLDOWN` to 20 | ~1 |
| **Total** | | **~251** |

---

## 5. Tutorial Improvements (~100 LOC) {#5-tutorial-improvements}

### 5.1 Current State Assessment

| Component | File | Status |
|-----------|------|--------|
| 9-stage system | [`TutorialSystem.js`](js/systems/TutorialSystem.js) (638 LOC) | ✅ INTRO → FREE_PLAY |
| Skip button | [`TutorialSystem.js:95–123`](js/systems/TutorialSystem.js:95) | ✅ Working |
| Progressive HUD reveal | [`TutorialSystem.js:413–537`](js/systems/TutorialSystem.js:413) | ✅ Stage-gated groups |
| Contextual prompts | [`TutorialSystem.js:249–269`](js/systems/TutorialSystem.js:249) | ✅ `showPrompt()` with fade |
| Guaranteed debris spawning | [`DebrisField.js:44–54`](js/entities/DebrisField.js:44) | ✅ `TUTORIAL_STAGE_REQUIREMENTS` for stages 3–6 |
| Detach hint | [`TutorialSystem.js:587–597`](js/systems/TutorialSystem.js:587) | ✅ One-time "[X] Detach" prompt |
| Codex integration | [`TutorialSystem.js:327–341`](js/systems/TutorialSystem.js:327) | ✅ Stage→codex unlock map |

### 5.2 V5 Crossbow Vocabulary Update (~40 LOC)

The tutorial prompts currently use generic language ("Deploy", "Arm", "Net"). These need updating to match the V5 crossbow metaphor used everywhere else in the game.

**File:** [`js/systems/TutorialSystem.js`](js/systems/TutorialSystem.js) — Update [`_startStage()`](js/systems/TutorialSystem.js:413) prompts

| Stage | Current Prompt | New Prompt |
|-------|---------------|------------|
| `FIRST_ARM` (460) | `'[1] Deploy  [WASD] Steer  [F] Net'` | `'[1] Fire Bolt  [WASD] Steer  [F] Net'` |
| `MULTI_ARM` (476) | `'[2] Arm 2  [7] Mothership'` | `'[2] Fire Bolt 2  [7] Mothership View'` |
| `BIG_GAME` (486) | `'[4] Weaver'` | `'[4] Fire Weaver Bolt'` |

**Comms message updates in `_startStage()`:**

| Stage | Line | Current | New |
|-------|------|---------|-----|
| `FIRST_ARM` | ~469 | `'Press 1 to deploy Spinner-1. WASD steers it, F deploys the net.'` | `'Press 1 to fire your first crossbow bolt. WASD steers, F deploys the net.'` |
| `MULTI_ARM` | ~479 | `'Try pressing 2 for a second arm.'` | `'Press 2 to fire a second bolt. Press 7 for mothership view.'` |
| `BIG_GAME` | ~489 | `'Press 4 for your Weaver arms — they handle the big debris.'` | `'Press 4 to fire a Weaver bolt — heavier spring, bigger net for large debris.'` |
| `_onCatch` | ~549 | `'Arm capture confirmed. Now you\'re a proper space cowboy.'` | `'Crossbow capture confirmed. Now you\'re a proper space cowboy.'` |

**LOC:** ~40 (text replacements in existing lines)

### 5.3 Progression Threshold Evaluation (~15 LOC)

Current catch requirements for stage advancement:

| Stage | Current Threshold | Proposed | Rationale |
|-------|------------------|----------|-----------|
| FIRST_ARM → MULTI_ARM | `totalCatches >= 2` ([line 545](js/systems/TutorialSystem.js:545)) | Keep `>= 2` | First arm catch is the milestone (1 lasso + 1 arm = 2) |
| MULTI_ARM → BIG_GAME | `totalCatches >= 4` ([line 553](js/systems/TutorialSystem.js:553)) | **Reduce to `>= 3`** | 1 lasso + 1 arm + 1 multi-arm = 3 is sufficient |
| BIG_GAME → AUTOPILOT | `totalCatches >= 6` ([line 560](js/systems/TutorialSystem.js:560)) | **Reduce to `>= 5`** | Weaver catch may take time; lower threshold smooths flow |
| AUTOPILOT → FREE_PLAY | `totalCatches >= 8` ([line 563](js/systems/TutorialSystem.js:563)) | **Reduce to `>= 6`** | Also has 15s timer fallback; catch threshold rarely reached |

**File:** [`js/systems/TutorialSystem.js`](js/systems/TutorialSystem.js) — Update thresholds in [`_onCatch()`](js/systems/TutorialSystem.js:542) and optionally move thresholds to Constants.

```javascript
// Optional: Add to Constants.js for tuning
TUTORIAL: {
  FIRST_ARM_CATCHES: 2,
  MULTI_ARM_CATCHES: 3,
  BIG_GAME_CATCHES: 5,
  AUTOPILOT_CATCHES: 6,
},
```

**LOC:** ~15 (4 threshold changes + optional Constants block)

### 5.4 Guaranteed Debris During Tutorial (~20 LOC)

**Current state:** [`DebrisField.js:44–54`](js/entities/DebrisField.js:44) already defines `TUTORIAL_STAGE_REQUIREMENTS` for stages 3–6 with:
- Specific range limits per stage
- Appropriate debris types (fragments for stage 3, rocket bodies for stage 6)
- Count guarantees (1–4 debris per stage)
- Offset ranges for proximity to player

**Assessment:** The guaranteed debris system appears already implemented. What may be missing is the **trigger mechanism** that spawns tutorial debris when a stage begins.

**Action:** Verify that [`DebrisField`](js/entities/DebrisField.js) listens for `Events.TUTORIAL_STAGE_CHANGED` and spawns guaranteed debris.

```javascript
// In DebrisField — if not already present:
eventBus.on(Events.TUTORIAL_STAGE_CHANGED, (data) => {
  const req = TUTORIAL_STAGE_REQUIREMENTS[data.stage];
  if (req) {
    this._spawnTutorialDebris(req);
  }
});
```

**File:** [`js/entities/DebrisField.js`](js/entities/DebrisField.js) — Add/verify listener + spawn method

**LOC:** ~20 (if not already present; 0 if already wired)

### 5.5 Progressive Luminance (Session 16)

**Status:** Already solved per task description. The original catch-22 (can't see debris to learn → can't learn without catching) was addressed by progressive luminance that makes early tutorial debris brighter. **No changes needed.**

### 5.6 Implementation Order

1. **V5 crossbow vocabulary** — Text replacements in [`_startStage()`](js/systems/TutorialSystem.js:413) (~40 LOC)
2. **Progression thresholds** — Reduce catch counts in [`_onCatch()`](js/systems/TutorialSystem.js:542) (~15 LOC)
3. **Verify tutorial debris** — Check DebrisField stage listener (~20 LOC if missing)
4. **Manual test** — Play through all 9 stages with new text

### 5.7 Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Crossbow vocab confuses "Deploy" muscle-memory | LOW | Only tutorial text changes; key bindings unchanged |
| Reduced thresholds → tutorial too short | LOW | Players still learn each mechanic; just fewer repetitions needed |
| Tutorial debris spawns on top of player | MEDIUM | `TUTORIAL_STAGE_REQUIREMENTS` has `offsetMin/offsetMax` ranges |
| `TUTORIAL_STAGE_CHANGED` event not connected to DebrisField | MEDIUM | Verify and wire if needed |

### 5.8 LOC Summary

| File | Change | LOC |
|------|--------|-----|
| [`TutorialSystem.js`](js/systems/TutorialSystem.js) | Crossbow vocab + thresholds | ~55 |
| [`DebrisField.js`](js/entities/DebrisField.js) | Tutorial debris listener (if missing) | ~20 |
| [`Constants.js`](js/core/Constants.js) | Optional tutorial thresholds | ~6 |
| **Total** | | **~81** |

---

## 6. Cross-Cutting Concerns {#6-cross-cutting-concerns}

### 6.1 Overall Implementation Order (Dependency Chain)

```
Phase 1: Foundation (no cross-dependencies)
  ├─ 1. Constants.js synergy pairs + field thresholds
  ├─ 2. ArmUnit.detach() method
  └─ 3. Tutorial text updates

Phase 2: Wiring (depends on Phase 1)
  ├─ 4. ArmManager detach routing
  ├─ 5. InputManager X key binding
  ├─ 6. RewardSystem field clearing refactor
  └─ 7. DebrisField tutorial debris verification

Phase 3: Scoring & Rewards (depends on Phase 2)
  ├─ 8. ScoringSystem detach multiplier paths
  └─ 9. GameFlowManager ARM_LOST penalty

Phase 4: Content (independent, can parallelize)
  └─ 10. CodexSystem 54 new entries (largest single task)

Phase 5: Testing
  └─ 11. Full playthrough verification
```

### 6.2 Events Inventory — New vs Existing

| Event | Status | Used By |
|-------|--------|---------|
| `Events.ARM_DETACHED` | ✅ Already defined | InputManager→ArmUnit→RewardSystem |
| `Events.ARM_LOST` | ✅ Already defined | ArmUnit→GameFlowManager→ScoringSystem |
| `Events.SWEEP_REPORT` | ✅ Already defined | RewardSystem→SweepReportUI |
| `Events.SYNERGY_BONUS` | ✅ Already defined | RewardSystem→HUD |
| `Events.SCORING_AWARD` | ✅ Already defined | RewardSystem→ScoringSystem |
| `Events.CATCH_SLOWMO` | ⚠️ Verify exists | ArmUnit.detach()→main loop |

**No new Events.js entries needed.** All required events are already defined.

### 6.3 Constants Inventory — New Additions

| Constant | Location | Value |
|----------|----------|-------|
| `SALVAGE_SYNERGIES` | Replace existing | 6 pairs |
| `FIELD_CLEAR_THRESHOLDS` | New | `[{pct, bonus, label}]` array |
| `TUTORIAL` | New (optional) | `{FIRST_ARM_CATCHES, MULTI_ARM_CATCHES, ...}` |
| `CODEX.UNLOCK_COOLDOWN` | Modify existing | 30→20 |

### 6.4 Testing Strategy

| Test | Type | What to Verify |
|------|------|---------------|
| Synergy trigger | Manual | Capture two metals from a pair, verify comms + bonus |
| Sweep report display | Manual | Complete a trawl, verify SweepReportUI appears |
| Field clearing tiered | Manual | Capture 50%+ of field, verify bonus awarded |
| X key detach | Manual | Deploy arm, press X during TRANSIT, verify free-flight |
| Detach from TANGLED | Manual | Tangle an arm, press X, verify tangle-specific comms |
| ARM_LOST penalty | Manual | Detach arm, let fuel drain to 0, verify -500 penalty |
| Detached capture score | Manual | Detach arm, capture debris, verify ×2.0 multiplier |
| Tutorial crossbow vocab | Manual | Start new game, verify V5 language in prompts |
| Tutorial thresholds | Manual | Count catches needed per stage progression |
| Codex unlock chain | Manual | Fire crossbow → verify spring_energy entry unlocks |
| Codex subsystem trigger | Automated | Wait for ground station pass → verify codex |

### 6.5 Grand LOC Summary

| Feature Area | Estimated LOC | Status |
|-------------|--------------|--------|
| 1. Reward Systems | ~51 | Plan ready |
| 2. Risk-Reward Detach | ~126 | Plan ready |
| 3. Visual Quick Fixes | ~0 | ✅ Already complete |
| 4. Learning Systems | ~251 | Plan ready |
| 5. Tutorial Improvements | ~81 | Plan ready |
| **Total** | **~509** | |

> **Note:** Original estimate was ~905 LOC. Actual is ~509 because:
> - Visual Quick Fixes (Moon + Planets) are already fully implemented (~105 LOC saved)
> - SweepReportUI already wired (~50 LOC saved)
> - Tutorial debris spawning already connected at [`DebrisField.js:197`](js/entities/DebrisField.js:197) (~20 LOC saved)
> - Codex entries are compact (~4 LOC each vs ~8 estimated)
>
> **Verified data paths:**
> - `metalId` values flow: [`Constants.METALS.*.id`](js/core/Constants.js:373) (lowercase, e.g. `aluminum`) → [`DebrisField._calculateSalvage()`](js/entities/DebrisField.js:399) → [`GameFlowManager`](js/systems/GameFlowManager.js:763) `CARGO_STORE` emit → [`RewardSystem._registerMetals()`](js/systems/RewardSystem.js:289) `.toUpperCase()` → synergy check against `SALVAGE_SYNERGIES` (UPPERCASE keys). ✅ Confirmed matching.
> - Slo-mo is direct variable assignment in [`main.js:303`](js/main.js:303), not event-driven. Detach slo-mo needs explicit `ARM_DETACHED` listener in main.js. ✅ Addressed in §2.2.6.
> - Tutorial debris spawning already wired at [`DebrisField.js:197`](js/entities/DebrisField.js:197) via `Events.TUTORIAL_STAGE_CHANGED` listener. ✅ No additional work needed.

---

*Plan generated from source analysis of: [`RewardSystem.js`](js/systems/RewardSystem.js), [`SweepReportUI.js`](js/ui/SweepReportUI.js), [`ArmUnit.js`](js/entities/ArmUnit.js), [`ArmManager.js`](js/entities/ArmManager.js), [`InputManager.js`](js/systems/InputManager.js), [`ScoringSystem.js`](js/systems/ScoringSystem.js), [`GameFlowManager.js`](js/systems/GameFlowManager.js), [`SunLight.js`](js/scene/SunLight.js), [`CodexSystem.js`](js/systems/CodexSystem.js), [`SubsystemEvents.js`](js/systems/SubsystemEvents.js), [`SpaceWeatherSystem.js`](js/systems/SpaceWeatherSystem.js), [`TutorialSystem.js`](js/systems/TutorialSystem.js), [`DebrisField.js`](js/entities/DebrisField.js), [`Constants.js`](js/core/Constants.js), [`Events.js`](js/core/Events.js), [`GAME_DESIGN.md`](GAME_DESIGN.md), [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md).*
