# Tutorial Redesign — Implementation Plan

> Comprehensive design for improving the Space Cowboy tutorial onboarding experience.  
> Addresses five issues: missing WASD stage, A-key dual binding conflict, tutorial prompt positioning, sweep report suppression, and **self-paced progression with out-of-sequence handling**.

---

## A. New Tutorial Stage Sequence

### Stage Enumeration Change

The new `WASD_MOVE` stage is inserted after `LOOK_AROUND`, shifting all subsequent stages by +1.

| # | Stage Name    | Old # | Trigger to Advance                           | HUD Group Undimmed         | Houston Comms Message                                                                                      | Tutorial Prompt Text                     |
|---|---------------|-------|----------------------------------------------|----------------------------|------------------------------------------------------------------------------------------------------------|------------------------------------------|
| 0 | `INTRO`       | 0     | `GAME_STATE_CHANGE` → `ORBITAL_VIEW`          | `score-group`              | *"Telemetry is live, Cowboy. Welcome to LEO."* + *"Your cleanup zone is ahead. Let's get you oriented."*    | *(none)*                                 |
| 1 | `LOOK_AROUND` | 1     | 3× arrow key presses (`TUTORIAL_ARROW_INPUT`) | `target-list`              | *"Use arrow keys to look around. Those contacts on the right panel — that's your job."*                     | `[←→↑↓] Look Around`                    |
| 2 | `WASD_MOVE`   | *new* | 3× WASD key presses (`TUTORIAL_WASD_INPUT`)   | *(none — no new panel)*    | *"Good view. Now use W A S D to maneuver. Small nudges — watch how the contacts shift."*                    | `[WASD] Maneuver`                        |
| 3 | `THROTTLE`    | 2     | 2× throttle +/− presses                      | `fuel-group`               | *"Plus key speeds up, minus slows down. Watch the ΔV bar on the left — that's your fuel budget."*           | `[+−] Throttle`                          |
| 4 | `LASSO`       | 3     | First lasso catch (`LASSO_CAPTURED`)          | `target-detail`            | *"Highlighted target is in range. Hit SPACE to cast your lasso."*                                           | `[SPACE] Cast Lasso`                     |
| 5 | `FIRST_ARM`   | 4     | `totalCatches >= 2` (`ARM_CAPTURED`)          | `arms-group`, `cargo-group`| *"Time for the real tools. Press 1 to fire your first crossbow bolt. WASD steers, F deploys the net."*      | `[1] Fire Bolt  [WASD] Steer  [F] Net`  |
| 6 | `MULTI_ARM`   | 5     | `totalCatches >= 3`                           | `power-group`              | *"Press 2 to fire a second bolt. Press 7 for mothership view. More bolts, more power — watch your energy."* | `[2] Fire Bolt 2  [7] Mothership View`   |
| 7 | `BIG_GAME`    | 6     | `totalCatches >= 5`                           | `thermal-group`            | *"Press 4 to fire a Weaver bolt — heavier spring, bigger net. Watch your thermal readout."*                 | `[4] Fire Weaver Bolt`                   |
| 8 | `AUTOPILOT`   | 7     | 20s timeout or `totalCatches >= 6`            | *(autopilot indicator)*    | *"Press A to engage autopilot. TAB cycles through targets."*                                                | `[A] Autopilot  [TAB] Cycle`             |
| 9 | `FREE_PLAY`   | 8     | Auto after AUTOPILOT completes                | *(all remaining)*          | *"That's the basics, Cowboy. You're on your own now."*                                                      | *(none)*                                 |

### New Constant Definition

In [`TutorialSystem.js`](js/systems/TutorialSystem.js:12):

```js
export const TutorialStage = {
    INTRO: 0,
    LOOK_AROUND: 1,
    WASD_MOVE: 2,      // ← NEW
    THROTTLE: 3,        // was 2
    LASSO: 4,           // was 3
    FIRST_ARM: 5,       // was 4
    MULTI_ARM: 6,       // was 5
    BIG_GAME: 7,        // was 6
    AUTOPILOT: 8,       // was 7
    FREE_PLAY: 9,       // was 8
};
```

### Full Renumbering Map (critical for Section E)

Every raw numeric stage reference across the codebase must be updated:

| Semantic Stage | Old Value | New Value | Delta |
|---------------|-----------|-----------|-------|
| INTRO         | 0         | 0         | —     |
| LOOK_AROUND   | 1         | 1         | —     |
| **WASD_MOVE** | —         | **2**     | new   |
| THROTTLE      | 2         | **3**     | +1    |
| LASSO         | 3         | **4**     | +1    |
| FIRST_ARM     | 4         | **5**     | +1    |
| MULTI_ARM     | 5         | **6**     | +1    |
| BIG_GAME      | 6         | **7**     | +1    |
| AUTOPILOT     | 7         | **8**     | +1    |
| FREE_PLAY     | 8         | **9**     | +1    |

---

## A2. Self-Pacing & Out-of-Sequence Handling

### Design Principles

1. **No artificial gates** — Players progress at their own speed. Input thresholds exist only to confirm the player actually tried the action, not to force repetition.
2. **Competence-based skip** — If a player demonstrates a later-stage skill (e.g., catches with lasso while still in LOOK_AROUND), the tutorial recognizes the achievement and skips forward.
3. **Persistent prompts** — Key-binding prompts stay visible until the player completes the stage, supporting slow learners who need time to find the keys.
4. **Snappy transitions** — Inter-stage delay reduced from 800ms to 400ms. Fast players shouldn't feel held back.

### Reduced Input Thresholds

| Stage | Action | Old Threshold | New Threshold | Rationale |
|-------|--------|---------------|---------------|-----------|
| LOOK_AROUND | Arrow key presses | 6 | **3** | Three directions proves awareness; six is tedious |
| WASD_MOVE | WASD key frames | 4 | **3** | Emitted per-frame in `processInput()` → ~0.05s at 60fps; confirms player held a key |
| THROTTLE | +/− presses | 4 | **2** | One increase + one decrease demonstrates the concept |

### Persistent Prompts (duration: 0)

Currently, only LOOK_AROUND and LASSO use `duration: 0` (persistent). Other stages use finite durations that can expire before slow players figure out the keys:

| Stage | Current Duration | New Duration | Reason |
|-------|-----------------|--------------|--------|
| LOOK_AROUND | `0` (persistent) | `0` | ✅ Already correct |
| WASD_MOVE | `0` (new) | `0` | Persistent — wait for WASD input |
| THROTTLE | default `4s` | **`0`** | Slow players need time to find +/- |
| LASSO | `0` (persistent) | `0` | ✅ Already correct |
| FIRST_ARM | default `4s` (via `showPrompt` no arg) | **`0`** | Complex multi-key prompt needs time |
| MULTI_ARM | `8s` | **`0`** | Let player find key 2 at their pace |
| BIG_GAME | `8s` | **`0`** | Let player find key 4 at their pace |
| AUTOPILOT | `10s` | **`0`** | Stage has 20s auto-advance timeout anyway |

### Inter-Stage Delay

In [`advanceTo()`](js/systems/TutorialSystem.js:318), reduce the `setTimeout` delay:

```diff
- }, 800);
+ }, 400);
```

This keeps a brief visual pause (prompt fade-out → new prompt fade-in) while feeling snappier for fast players.

### Competence-Based Skip-Ahead Mechanism

**Problem:** The current listeners use strict `===` checks:

```js
// Current: ONLY counts arrow input when already at LOOK_AROUND
if (!this.active || this.stage !== TutorialStage.LOOK_AROUND) return;
```

If a player uses WASD during INTRO, or fires a lasso during LOOK_AROUND, or catches debris with an arm before being taught — these actions are silently ignored. The player gets stuck at a stage they've already surpassed.

**Solution: `_competenceSkip()` method + range-aware listeners.**

New private method in `TutorialSystem`:

```js
/**
 * Skip tutorial forward if the player demonstrates competence beyond current stage.
 * Uses advanceTo() which already handles "no going backward" and stage guards.
 * @private
 * @param {number} demonstratedStage - The stage this action corresponds to
 */
_competenceSkip(demonstratedStage) {
    if (!this.active) return;
    if (this.stage >= demonstratedStage) return; // already at or past
    this.advanceTo(demonstratedStage);
}
```

**Revised listener pattern — replaces strict `===` with skip-aware ranges:**

```js
// Arrow input: works at LOOK_AROUND or earlier (skip-ahead from INTRO)
const onArrowInput = () => {
    if (!this.active || this.stage > TutorialStage.LOOK_AROUND) return;
    this._competenceSkip(TutorialStage.LOOK_AROUND);
    this._lookAroundCount = (this._lookAroundCount || 0) + 1;
    if (this._lookAroundCount >= 3) {
        this.advanceTo(TutorialStage.WASD_MOVE);
    }
};

// WASD input: works at WASD_MOVE or earlier (skip-ahead from INTRO/LOOK_AROUND)
const onWASDInput = () => {
    if (!this.active || this.stage > TutorialStage.WASD_MOVE) return;
    this._competenceSkip(TutorialStage.WASD_MOVE);
    this._wasdMoveCount = (this._wasdMoveCount || 0) + 1;
    if (this._wasdMoveCount >= 3) {
        this.advanceTo(TutorialStage.THROTTLE);
    }
};

// Throttle input: works at THROTTLE or earlier (skip-ahead from any earlier stage)
const onThrottleInput = () => {
    if (!this.active || this.stage > TutorialStage.THROTTLE) return;
    this._competenceSkip(TutorialStage.THROTTLE);
    this._throttleChangeCount = (this._throttleChangeCount || 0) + 1;
    if (this._throttleChangeCount >= 2) {
        this.advanceTo(TutorialStage.LASSO);
    }
};
```

**Revised `_onLassoCatch()` — accepts lasso catches at any stage up to LASSO:**

```js
_onLassoCatch() {
    if (!this.active) return;

    if (this.stage <= TutorialStage.LASSO) {
        // Player caught with lasso — may have skipped earlier stages
        eventBus.emit(Events.COMMS_MESSAGE, {
            text: 'First catch confirmed! Welcome to the cleanup crew, Cowboy. That\'s one less piece of junk threatening the ISS.',
            priority: 'info',
        });
        setTimeout(() => this.advanceTo(TutorialStage.FIRST_ARM), 3000);
    }
}
```

**Revised `_onCatch()` — "highest applicable" pattern prevents cascading:**

The current code uses separate `if` blocks with `===` checks. With `<=`, multiple blocks could fire simultaneously, scheduling conflicting `advanceTo()` calls. Fix: use a **highest-applicable** pattern that finds the single correct target stage.

```js
_onCatch() {
    if (!this.active) return;

    // Determine the highest stage this catch count qualifies for
    let targetStage = null;
    let commsText = null;
    let delay = 3000;

    if (this.totalCatches >= 6 && this.stage <= TutorialStage.AUTOPILOT) {
        targetStage = TutorialStage.FREE_PLAY;
        delay = 3000;
    } else if (this.totalCatches >= 5 && this.stage <= TutorialStage.BIG_GAME) {
        targetStage = TutorialStage.AUTOPILOT;
        delay = 5000;
    } else if (this.totalCatches >= 3 && this.stage <= TutorialStage.MULTI_ARM) {
        targetStage = TutorialStage.BIG_GAME;
        commsText = 'Good work clearing the lane for ISS. Keep it up.';
    } else if (this.totalCatches >= 2 && this.stage <= TutorialStage.FIRST_ARM) {
        targetStage = TutorialStage.MULTI_ARM;
        commsText = 'Crossbow capture confirmed. Now you\'re a proper space cowboy.';
    } else if (this.totalCatches >= 1 && this.stage < TutorialStage.FIRST_ARM) {
        // Arm catch before FIRST_ARM stage — skip ahead
        targetStage = TutorialStage.FIRST_ARM;
        commsText = 'Crossbow bolt deployed! You\'re getting ahead of the briefing, Cowboy.';
    }

    if (targetStage !== null) {
        if (commsText) {
            eventBus.emit(Events.COMMS_MESSAGE, { text: commsText, priority: 'info' });
        }
        setTimeout(() => this.advanceTo(targetStage), delay);
    }
}
```

**Why this is safe:** Only one `else if` branch fires per call, scheduling exactly one `advanceTo()`. The `advanceTo()` method's own `newStage <= this.stage` guard prevents backward movement. The `setTimeout` guard `if (this.stage !== newStage) return` in `advanceTo` cancels stale advances if a newer advance supersedes it.

### Out-of-Sequence Scenario Walkthrough

| Scenario | Current Behavior | New Behavior |
|----------|-----------------|-------------|
| Player uses WASD during INTRO | WASD works for thrust but tutorial stays at INTRO waiting for state change | `_competenceSkip(WASD_MOVE)` → jumps to WASD_MOVE, skipping LOOK_AROUND. WASD count starts. |
| Player presses arrows during INTRO (before ORBITAL_VIEW) | Input events fire but listener returns early (`stage !== LOOK_AROUND`) | `_competenceSkip(LOOK_AROUND)` → jumps from INTRO to LOOK_AROUND. Arrow count starts. |
| Player fires lasso during LOOK_AROUND | Lasso fires but `_onLassoCatch` returns early (`stage !== LASSO`) | `stage <= LASSO` → true → catches trigger `advanceTo(FIRST_ARM)`, skipping WASD/THROTTLE/LASSO stages. |
| Player deploys arm + catches 3 debris before tutorial reaches FIRST_ARM | All catches ignored by tutorial | `_onCatch()` at LOOK_AROUND with totalCatches=3 → highest applicable = `BIG_GAME`, skips 4 stages. |
| Expert player blasts through every stage in <5 seconds | Blocked by 6+4 input threshold + 800ms×8 delays = ~12s minimum | 3+3+2 threshold + 400ms×8 delays = ~4s minimum. Skip-ahead allows even faster. |
| Slow player takes 30 seconds per stage | Prompts for THROTTLE/MULTI_ARM/BIG_GAME fade out after 4-8s, losing guidance | All prompts persist (`duration: 0`) until stage advances. Player can take as long as needed. |

### HUD Catch-Up on Multi-Stage Skips

When a player skips from stage 1 (LOOK_AROUND) to stage 5 (FIRST_ARM), the `TUTORIAL_STAGE_CHANGED` event fires with `{ stage: 5 }`. [`HUD.setTutorialVisibility(5)`](js/ui/HUD.js:360) uses `>=` comparisons:

```js
'score-group':   5 >= 0 → active ✅
'target-list':   5 >= 1 → active ✅
'fuel-group':    5 >= 3 → active ✅
'arms-group':    5 >= 5 → active ✅
'target-detail': 5 >= 4 → active ✅
'cargo-group':   5 >= 5 → active ✅
'power-group':   5 >= 6 → dormant (correct — not unlocked yet)
'thermal-group': 5 >= 7 → dormant (correct)
```

All intermediate panels light up correctly. ✅ No special handling needed.

### Codex Unlocks on Skip

[`advanceTo()`](js/systems/TutorialSystem.js:322) calls `_unlockCodexForCompletedStage(completedStage)` where `completedStage` is the stage that was active at the time of the jump. Skipped intermediate stages do **not** get codex unlocks. This is intentional — the player didn't experience those lessons, so the discovery entries shouldn't auto-unlock. They can still unlock naturally during gameplay.

### INTRO → LOOK_AROUND State Change Handling

The existing `GAME_STATE_CHANGE` listener:

```js
if (to === 'ORBITAL_VIEW' && this.active && this.stage === TutorialStage.INTRO) {
    this.advanceTo(TutorialStage.LOOK_AROUND);
}
```

Change to `<=`:

```js
if (to === 'ORBITAL_VIEW' && this.active && this.stage <= TutorialStage.INTRO) {
    this.advanceTo(TutorialStage.LOOK_AROUND);
}
```

This handles the edge case where the player somehow presses keys before the ORBITAL_VIEW transition. In practice, this listener fires on game start, at which point stage is guaranteed to be INTRO (0), so the change is a safety net.

---

## B. "A" Key Fix Design

### Problem Analysis

In [`InputManager._handleKeyDown()`](js/systems/InputManager.js:619), the `KeyA` case:

```js
case 'KeyA':
    if (isGameplay && !e.repeat && d.autopilotSystem) {
        d.autopilotSystem.toggle();       // ← fires on FIRST press
        d.audioSystem.playClick();
        this.keys['KeyA'] = false;        // ← clears held state to prevent WASD thrust
        e.preventDefault();
    }
    break;
```

This means **every** first press of A toggles autopilot. During the new `WASD_MOVE` stage (and any pre-AUTOPILOT stage), new players pressing A for leftward thrust will accidentally toggle autopilot.

### Fix Specification

**Condition:** If the tutorial is active and the current stage is less than `AUTOPILOT` (stage 8), suppress the autopilot toggle and let the keypress fall through to [`processInput()`](js/systems/InputManager.js:777) where `this.keys['KeyA']` produces lateral WASD thrust normally.

**Change in [`InputManager._handleKeyDown()`](js/systems/InputManager.js:619):**

```js
case 'KeyA':
    if (isGameplay && !e.repeat && d.autopilotSystem) {
        // TUTORIAL GUARD: During pre-AUTOPILOT stages, A = lateral thrust only.
        const tutActive = d.tutorialSystem && d.tutorialSystem.active;
        const preAutopilot = tutActive && d.tutorialSystem.stage < TutorialStage.AUTOPILOT;
        if (!preAutopilot) {
            d.autopilotSystem.toggle();
            d.audioSystem.playClick();
            this.keys['KeyA'] = false;
            e.preventDefault();
        }
        // If preAutopilot: do nothing — let WASD handle it in processInput()
    }
    break;
```

**Required import in [`InputManager.js`](js/systems/InputManager.js:1):**

```js
import { TutorialStage } from './TutorialSystem.js';
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Player presses A during `WASD_MOVE` stage | Lateral thrust only. No autopilot toggle. Counted as WASD input for stage advancement. |
| Player presses A during `LASSO` or `FIRST_ARM` stage | Lateral thrust only. No autopilot toggle. Normal gameplay movement. |
| Player reaches `AUTOPILOT` stage | A key regains full dual binding (autopilot on first press, WASD on hold). |
| Tutorial skipped (veteran) | `tutorialSystem.active` is `false` → `tutActive` is false → guard doesn't fire → normal A behavior. |
| Tutorial not present (null dep) | `d.tutorialSystem` is null → `tutActive` is false → guard doesn't fire. |
| Player somehow engages autopilot before it's taught | Impossible — A-key is the only toggle, and it's blocked. Arrow keys auto-disengage autopilot (existing [line 136](js/systems/InputManager.js:136)). |
| Player skip-aheads past AUTOPILOT via catches | Tutorial reaches FREE_PLAY → `active = false` → A key works normally (no guard). |

### Autopilot Engage Rejection (Belt-and-Suspenders)

As a secondary safeguard, add a guard in [`AutopilotSystem.engage()`](js/systems/AutopilotSystem.js:97):

```js
engage() {
    // Tutorial guard: autopilot not available until taught
    if (this._tutorialStage != null && this._tutorialStage < 8) {
        return; // silently reject
    }
    // ... existing trawl check, ΔV check, etc. ...
}
```

AutopilotSystem should subscribe to `TUTORIAL_STAGE_CHANGED` and track `this._tutorialStage`:

```js
// In constructor:
this._tutorialStage = null;

// In _setupListeners():
eventBus.on(Events.TUTORIAL_STAGE_CHANGED, ({ stage }) => {
    this._tutorialStage = stage;
});
eventBus.on(Events.TUTORIAL_SKIPPED, () => {
    this._tutorialStage = 9; // FREE_PLAY
});
```

---

## C. Tutorial Pane Repositioning

### Current Layout

| Element | Position |
|---------|----------|
| Tutorial prompt | `top: 75%; left: 50%; transform: translateX(-50%)` — bottom-center |
| Skip button | `bottom: 50px; right: 20px` |
| Comms panel | `right: 10px; bottom: 10px; width: 260px; maxHeight: 120px` |

**Problem:** The tutorial prompt at bottom-center can overlap with the comms panel or be far from it. Players need to see both simultaneously since Houston narrates in comms while the prompt shows key bindings.

### New Layout — Tutorial Prompt Above Comms

Position the tutorial prompt **directly above** the comms panel, right-aligned, forming a visual stack:

```
┌──────────────────────────────────┐
│                                  │
│                                  │
│                                  │
│                      ┌──────────┐│
│                      │ Skip ▸   ││  ← Skip button (above prompt)
│                      ├──────────┤│
│                      │[WASD]    ││  ← Tutorial prompt
│                      │Maneuver  ││
│                      ├──────────┤│
│                      │COMMS [C] ││  ← Comms panel (unchanged)
│                      │messages  ││
│                      └──────────┘│
└──────────────────────────────────┘
```

### CSS Changes in [`TutorialSystem._createUI()`](js/systems/TutorialSystem.js:75)

**Tutorial Prompt — new positioning (replaces lines 79-94):**

```js
this._promptEl.style.cssText = `
    position: fixed;
    bottom: 145px;
    right: 10px;
    width: 260px;
    color: rgba(200, 220, 200, 0.7);
    font-family: 'Courier New', monospace;
    font-size: 13px;
    text-align: center;
    pointer-events: none;
    z-index: 200;
    display: none;
    opacity: 0;
    transition: opacity 200ms ease-in;
    white-space: normal;
    background: rgba(0, 10, 20, 0.5);
    border: 1px solid rgba(0, 255, 136, 0.15);
    border-radius: 4px;
    padding: 8px 12px;
    box-sizing: border-box;
`;
```

Key changes from current:
- Removed `top: 75%; left: 50%; transform: translateX(-50%)`
- Added `bottom: 145px; right: 10px; width: 260px` — directly above comms panel (comms = `bottom: 10px`, `maxHeight: 120px`, gap = 15px → `10 + 120 + 15 = 145px`)
- Changed `white-space: nowrap` → `white-space: normal` — allows multi-word prompts like `[1] Fire Bolt  [WASD] Steer  [F] Net` to wrap naturally within the 260px width
- Added subtle background + border to match comms panel aesthetic
- Added `padding` and `box-sizing` for proper sizing

**Skip Button — repositioned above tutorial prompt (replaces lines 101-116):**

```js
this._skipBtn.style.cssText = `
    position: fixed;
    bottom: 190px;
    right: 10px;
    background: rgba(0, 20, 40, 0.7);
    border: 1px solid rgba(255, 170, 0, 0.4);
    border-radius: 4px;
    padding: 6px 14px;
    color: #ffaa00;
    font-family: 'Courier New', monospace;
    font-size: 11px;
    cursor: pointer;
    z-index: 210;
    display: none;
    transition: background 0.2s;
`;
```

Key changes:
- Removed `bottom: 50px; right: 20px`
- Added `bottom: 190px; right: 10px` — sits above the prompt (prompt bottom = 145px, prompt height ~35px + 10px gap)
- Smaller font (`11px` from `12px`) and padding to be less intrusive

### Responsive Behavior

Add responsive CSS to the `catch-effects-style` injection in [`HUD._build()`](js/ui/HUD.js:271):

```css
@media (max-width: 480px) {
    #tutorial-prompt, #tutorial-skip-btn {
        right: 5px !important;
        width: 200px !important;
        font-size: 11px !important;
    }
}
```

---

## D. Sweep Report Suppression During Tutorial

### Problem

The trawl system's [`TRAWLING.IDLE_TIMEOUT: 60s`](js/core/Constants.js:646) can trigger a sweep report via [`RewardSystem._compileSweepReport()`](js/systems/RewardSystem.js:424) → `Events.SWEEP_REPORT` → [`SweepReportUI.show()`](js/ui/SweepReportUI.js:124) during the first mission. New players see a full-screen overlay with zero useful data.

### Fix Location: [`SweepReportUI`](js/ui/SweepReportUI.js)

Add the guard in `SweepReportUI` itself, since it's the presentation layer and should own the "don't show during tutorial" decision.

**Add tutorial stage tracking:**

```js
constructor() {
    // ... existing fields ...
    /** @type {number} Current tutorial stage (suppress during tutorial) */
    this._tutorialStage = 9; // FREE_PLAY — no suppression by default
    
    this._build();
    this._setupListeners();
}
```

**Subscribe to tutorial events in [`_setupListeners()`](js/ui/SweepReportUI.js:110):**

```js
// Suppress sweep report during active tutorial
eventBus.on(Events.TUTORIAL_STAGE_CHANGED, ({ stage }) => {
    this._tutorialStage = stage;
});
eventBus.on(Events.TUTORIAL_SKIPPED, () => {
    this._tutorialStage = 9; // FREE_PLAY
});
```

**Add guard at the top of [`show()`](js/ui/SweepReportUI.js:124):**

```js
show(report) {
    if (this._visible) return;

    // Suppress during active tutorial (stages 0-8, before FREE_PLAY)
    if (this._tutorialStage < 9) {
        console.log('[SweepReportUI] Suppressed during tutorial stage', this._tutorialStage);
        return;
    }

    // ... rest of show() ...
}
```

---

## E. File-by-File Change List

### ⚠️ Critical: Raw Numeric Stage References (Renumbering Ripple)

Multiple systems track tutorial stage via `Events.TUTORIAL_STAGE_CHANGED` and compare against **raw numeric values** (not `TutorialStage` constants). Inserting `WASD_MOVE` at position 2 shifts all stages ≥ 2 by +1, silently breaking these comparisons.

**Complete inventory of raw numeric stage references:**

| File | Line(s) | Old Value | Semantic Stage | New Value | Impact if Missed |
|------|---------|-----------|----------------|-----------|------------------|
| [`DebrisField.js`](js/entities/DebrisField.js:45) | 45-54 | Keys `3,4,5,6` | LASSO→BIG_GAME | `4,5,6,7` | Wrong debris spawned for wrong stages |
| [`DebrisField.js`](js/entities/DebrisField.js:868) | 868,874 | Comments `(0-8)`, `0-2, 7-8` | — | `(0-9)`, `0-3, 8-9` | Misleading docs |
| [`Constants.js`](js/core/Constants.js:862) | 862 | `TUTORIAL_MIN_STAGE: 5` | MULTI_ARM | `6` | Collision avoidance activates 1 stage early |
| [`SensorSystem.js`](js/systems/SensorSystem.js:85) | 85 | `= 8` (default) | FREE_PLAY | `= 9` | Weather effects suppressed for veterans until first stage event |
| [`SensorSystem.js`](js/systems/SensorSystem.js:90) | 90 | `< 4` | before FIRST_ARM | `< 5` | Weather sensor suppression ends 1 stage early |
| [`SpaceWeatherSystem.js`](js/systems/SpaceWeatherSystem.js:123) | 123 | `= 8` | FREE_PLAY | `= 9` | Same default issue |
| [`SpaceWeatherSystem.js`](js/systems/SpaceWeatherSystem.js:210) | 210 | `< 4` | before FIRST_ARM | `< 5` | Storm alerts appear 1 stage early |
| [`SpaceWeatherSystem.js`](js/systems/SpaceWeatherSystem.js:211) | 211 | `< 7` | before AUTOPILOT | `< 8` | Geomagnetic storms appear 1 stage early |
| [`PowerDistribution.js`](js/systems/PowerDistribution.js:49) | 49 | `= 8` | FREE_PLAY | `= 9` | Same default issue |
| [`PowerDistribution.js`](js/systems/PowerDistribution.js:166) | 166 | `< 4` | before FIRST_ARM | `< 5` | Low-power alerts appear 1 stage early |
| [`SubsystemEvents.js`](js/systems/SubsystemEvents.js:713) | 713 | `= 8` | FREE_PLAY | `= 9` | Same default issue |
| [`SubsystemEvents.js`](js/systems/SubsystemEvents.js:744) | 744 | `< 4` | before FIRST_ARM | `< 5` | Subsystem chatter appears 1 stage early |
| [`ConjunctionSystem.js`](js/systems/ConjunctionSystem.js:82) | 82 | `= 8` | FREE_PLAY | `= 9` | Same default issue |
| [`ConjunctionSystem.js`](js/systems/ConjunctionSystem.js:360) | 360 | `< 4` | before FIRST_ARM | `< 5` | Conjunction alerts appear 1 stage early |
| [`KesslerSystem.js`](js/systems/KesslerSystem.js:55) | 55 | `= 8` | FREE_PLAY | `= 9` | Same default issue |
| [`KesslerSystem.js`](js/systems/KesslerSystem.js:297) | 297 | `< 7` | before AUTOPILOT | `< 8` | Kessler warnings appear 1 stage early |
| [`CollisionAvoidanceSystem.js`](js/systems/CollisionAvoidanceSystem.js:66) | 66 | `= Infinity` | — | No change | Uses Infinity, safe ✅ |

---

### 1. [`js/core/Events.js`](js/core/Events.js:207)

**Lines 207-211** — TUTORIAL section. Add new event constant:

```diff
  TUTORIAL_ARROW_INPUT:   'tutorial:arrowInput',
  TUTORIAL_THROTTLE_INPUT:'tutorial:throttleInput',
+ TUTORIAL_WASD_INPUT:    'tutorial:wasdInput',
```

---

### 2. [`js/core/Constants.js`](js/core/Constants.js:862)

**Line 862** — Update collision avoidance tutorial threshold:

```diff
- TUTORIAL_MIN_STAGE: 5,          // suppress during tutorial stages 0-4
+ TUTORIAL_MIN_STAGE: 6,          // suppress during tutorial stages 0-5 (before MULTI_ARM)
```

---

### 3. [`js/systems/TutorialSystem.js`](js/systems/TutorialSystem.js) (largest changeset)

#### Lines 12-22 — `TutorialStage` enum

Replace entire enum with new 10-stage numbering (Section A).

#### Constructor (~line 25-60) — Add new fields

```js
this._wasdMoveCount = 0;
```

#### Lines 79-94 — `_createUI()` prompt CSS

Replace `this._promptEl.style.cssText` (Section C). Key diff: remove center positioning, add right-aligned above-comms positioning, `white-space: normal`.

#### Lines 101-116 — `_createUI()` skip button CSS

Replace `this._skipBtn.style.cssText` (Section C). Key diff: `bottom: 190px; right: 10px; font-size: 11px`.

#### Lines 150-261 — `_setupListeners()` — Major revision

**Arrow input listener (lines 178-186):** Replace strict `===` with range-aware pattern:

```js
const onArrowInput = () => {
    if (!this.active || this.stage > TutorialStage.LOOK_AROUND) return;
    this._competenceSkip(TutorialStage.LOOK_AROUND);
    this._lookAroundCount = (this._lookAroundCount || 0) + 1;
    if (this._lookAroundCount >= 3) {      // REDUCED from 6
        this.advanceTo(TutorialStage.WASD_MOVE);
    }
};
```

**Throttle input listener (lines 189-197):** Replace strict `===` with range-aware:

```js
const onThrottleInput = () => {
    if (!this.active || this.stage > TutorialStage.THROTTLE) return;
    this._competenceSkip(TutorialStage.THROTTLE);
    this._throttleChangeCount = (this._throttleChangeCount || 0) + 1;
    if (this._throttleChangeCount >= 2) {  // REDUCED from 4
        this.advanceTo(TutorialStage.LASSO);
    }
};
```

**New WASD input listener (add after throttle listener):**

```js
const onWASDInput = () => {
    if (!this.active || this.stage > TutorialStage.WASD_MOVE) return;
    this._competenceSkip(TutorialStage.WASD_MOVE);
    this._wasdMoveCount = (this._wasdMoveCount || 0) + 1;
    if (this._wasdMoveCount >= 3) {
        this.advanceTo(TutorialStage.THROTTLE);
    }
};
eventBus.on(Events.TUTORIAL_WASD_INPUT, onWASDInput);
this._listeners.push({ event: Events.TUTORIAL_WASD_INPUT, handler: onWASDInput });
```

**State change listener (lines 247-253):** Change `===` to `<=`:

```diff
- if (to === 'ORBITAL_VIEW' && this.active && this.stage === TutorialStage.INTRO) {
+ if (to === 'ORBITAL_VIEW' && this.active && this.stage <= TutorialStage.INTRO) {
```

#### New method — `_competenceSkip()` (add near line 310, before `advanceTo`)

```js
/**
 * Skip tutorial forward when player demonstrates competence beyond current stage.
 * @private
 * @param {number} demonstratedStage - Stage this action corresponds to
 */
_competenceSkip(demonstratedStage) {
    if (!this.active) return;
    if (this.stage >= demonstratedStage) return;
    this.advanceTo(demonstratedStage);
}
```

#### `advanceTo()` (line 330) — Reduce inter-stage delay

```diff
- }, 800);
+ }, 400);
```

#### Lines 349-357 — `_unlockCodexForCompletedStage()`

Add entry for the new stage:

```js
[TutorialStage.WASD_MOVE]: 'rcs_thruster',   // Reaction control basics
```

> Verify codex entry `'rcs_thruster'` exists. If not, create one or omit.

#### Lines 434-559 — `_startStage()` — Insert new case + make prompts persistent

**Insert WASD_MOVE case** between LOOK_AROUND and THROTTLE:

```js
case TutorialStage.WASD_MOVE:
    this._wasdMoveCount = 0;
    this.showPrompt('[WASD] Maneuver', 0);  // persistent
    eventBus.emit(Events.COMMS_MESSAGE, {
        text: 'Good view. Now use W A S D to maneuver. Small nudges — watch how the contacts shift.',
        priority: 'info',
    });
    break;
```

**Make THROTTLE prompt persistent** (currently uses default 4s):

```diff
- this.showPrompt('[+−] Throttle');
+ this.showPrompt('[+−] Throttle', 0);  // persistent
```

**Make MULTI_ARM prompt persistent:**

```diff
- this.showPrompt('[2] Fire Bolt 2  [7] Mothership View', 8);
+ this.showPrompt('[2] Fire Bolt 2  [7] Mothership View', 0);  // persistent
```

**Make BIG_GAME prompt persistent:**

```diff
- this.showPrompt('[4] Fire Weaver Bolt', 8);
+ this.showPrompt('[4] Fire Weaver Bolt', 0);  // persistent
```

**Make AUTOPILOT prompt persistent + extend auto-advance timeout:**

```diff
- this.showPrompt('[A] Autopilot  [TAB] Cycle', 10);
+ this.showPrompt('[A] Autopilot  [TAB] Cycle', 0);  // persistent
```

```diff
- }, 15000);
+ }, 20000);  // 20s auto-advance (was 15s — more time for slow players)
```

#### Lines 562-601 — `_onCatch()` and `_onLassoCatch()` — Full replacement

Replace `_onCatch()` with highest-applicable pattern (Section A2).

Replace `_onLassoCatch()` with `<=` range check:

```js
_onLassoCatch() {
    if (!this.active) return;
    if (this.stage <= TutorialStage.LASSO) {
        eventBus.emit(Events.COMMS_MESSAGE, {
            text: 'First catch confirmed! Welcome to the cleanup crew, Cowboy. That\'s one less piece of junk threatening the ISS.',
            priority: 'info',
        });
        setTimeout(() => this.advanceTo(TutorialStage.FIRST_ARM), 3000);
    }
}
```

#### Lines 621-638 — `reset()`

Add `this._wasdMoveCount = 0;` alongside existing resets.

---

### 4. [`js/systems/InputManager.js`](js/systems/InputManager.js)

#### Line 1 area — imports

```js
import { TutorialStage } from './TutorialSystem.js';
```

#### Lines 618-627 — `KeyA` case in `_handleKeyDown()`

Replace with tutorial-guarded version (Section B).

#### Lines 783+ — `processInput()` inside `if (hasIon)` block

After the normalization code, add:

```js
// Notify tutorial of WASD usage (mothership control only, not arm pilot)
if (!this.armPilotMode && !(d.armManager && d.armManager.selectedArmIndex >= 0)) {
    eventBus.emit(Events.TUTORIAL_WASD_INPUT);
}
```

---

### 5. [`js/ui/HUD.js`](js/ui/HUD.js)

#### Line 358 — JSDoc update

`@param {number} tutorialStage - TutorialStage value (0-8)` → `(0-9)`.

#### Lines 271-346 — Responsive media query

Append to `catchStyle.textContent`:

```css
@media (max-width: 480px) {
    #tutorial-prompt, #tutorial-skip-btn {
        right: 5px !important;
        width: 200px !important;
        font-size: 11px !important;
    }
}
```

No changes to `setTutorialVisibility()` — already uses named constants.

---

### 6. [`js/ui/SweepReportUI.js`](js/ui/SweepReportUI.js)

Add `_tutorialStage` field, subscriber, and guard (Section D). Three changes: constructor field, `_setupListeners()` subscriptions, `show()` guard.

---

### 7. [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js)

Add `_tutorialStage` field, subscriber, and `engage()` guard (Section B belt-and-suspenders).

---

### 8. [`js/entities/DebrisField.js`](js/entities/DebrisField.js:44)

#### Lines 44-54 — `TUTORIAL_STAGE_REQUIREMENTS` keys

```diff
- /** Tutorial stage debris requirements (stages 3-6 need guaranteed nearby targets) */
+ /** Tutorial stage debris requirements (stages 4-7 need guaranteed nearby targets) */
  const TUTORIAL_STAGE_REQUIREMENTS = {
-   3: { range: 0.002, types: ['fragment'], massMin: 1, massMax: 5, count: 3,
+   4: { range: 0.002, types: ['fragment'], massMin: 1, massMax: 5, count: 3,       // LASSO
         offsetMin: 0.00001, offsetMax: 0.000025 },
-   4: { range: 0.005, types: ['fragment', 'missionDebris'], massMin: 5, massMax: 50, count: 2,
+   5: { range: 0.005, types: ['fragment', 'missionDebris'], massMin: 5, massMax: 50, count: 2,  // FIRST_ARM
         offsetMin: 0.00002, offsetMax: 0.00006 },
-   5: { range: 0.01, types: ['fragment', 'missionDebris', 'defunctSat'], massMin: 10, massMax: 100, count: 4,
+   6: { range: 0.01, types: ['fragment', 'missionDebris', 'defunctSat'], massMin: 10, massMax: 100, count: 4,  // MULTI_ARM
         offsetMin: 0.00003, offsetMax: 0.00012 },
-   6: { range: 0.02, types: ['rocketBody', 'defunctSat'], massMin: 500, massMax: 2000, count: 1,
+   7: { range: 0.02, types: ['rocketBody', 'defunctSat'], massMin: 500, massMax: 2000, count: 1,  // BIG_GAME
         offsetMin: 0.00005, offsetMax: 0.00025 },
  };
```

#### Lines 868, 874 — Comments

`(0-8)` → `(0-9)`, `"0-2, 7-8"` → `"0-3, 8-9"`.

---

### 9. [`js/systems/SensorSystem.js`](js/systems/SensorSystem.js:85)

```diff
- this._tutorialStage = 8;
+ this._tutorialStage = 9;
```
```diff
- if (this._tutorialStage < 4) return;
+ if (this._tutorialStage < 5) return;   // suppress before FIRST_ARM
```

---

### 10. [`js/systems/SpaceWeatherSystem.js`](js/systems/SpaceWeatherSystem.js:123)

```diff
- this._tutorialStage = 8;
+ this._tutorialStage = 9;
```
```diff
- if (this._tutorialStage < 4) return;
+ if (this._tutorialStage < 5) return;   // suppress before FIRST_ARM
```
```diff
- if (this._tutorialStage < 7 && type === 'GEOMAGNETIC_STORM') return;
+ if (this._tutorialStage < 8 && type === 'GEOMAGNETIC_STORM') return;  // suppress before AUTOPILOT
```

---

### 11. [`js/systems/PowerDistribution.js`](js/systems/PowerDistribution.js:49)

```diff
- this._tutorialStage = 8;
+ this._tutorialStage = 9;
```
```diff
- if (this._tutorialStage < 4) return;
+ if (this._tutorialStage < 5) return;   // suppress before FIRST_ARM
```

---

### 12. [`js/systems/SubsystemEvents.js`](js/systems/SubsystemEvents.js:713)

```diff
- this._tutorialStage = 8;
+ this._tutorialStage = 9;
```
```diff
- if (this._tutorialStage < 4) return;
+ if (this._tutorialStage < 5) return;   // suppress before FIRST_ARM
```

---

### 13. [`js/systems/ConjunctionSystem.js`](js/systems/ConjunctionSystem.js:82)

```diff
- this._tutorialStage = 8;
+ this._tutorialStage = 9;
```
```diff
- if (this._tutorialStage < 4) return;
+ if (this._tutorialStage < 5) return;   // suppress before FIRST_ARM
```

---

### 14. [`js/systems/KesslerSystem.js`](js/systems/KesslerSystem.js:55)

```diff
- this._tutorialStage = 8;
+ this._tutorialStage = 9;
```
```diff
- if (this._tutorialStage < 7) return;
+ if (this._tutorialStage < 8) return;   // suppress before AUTOPILOT
```

---

### 15. [`js/test/test-CollisionAvoidance.js`](js/test/test-CollisionAvoidance.js:545)

Line 547 uses `{ stage: 2 }` — still below new `TUTORIAL_MIN_STAGE: 6`, test passes. ✅  
Line 556 uses `CA.TUTORIAL_MIN_STAGE` — auto-correct via Constants change. ✅  
No functional changes needed.

---

### Files Confirmed Safe (No Changes Needed)

| File | Why Safe |
|------|----------|
| [`CollisionAvoidanceSystem.js`](js/systems/CollisionAvoidanceSystem.js:66) | Default `Infinity`, uses `Constants.COLLISION_AVOIDANCE.TUTORIAL_MIN_STAGE` |
| [`HUD.js`](js/ui/HUD.js:367) `setTutorialVisibility()` | Uses `TutorialStage.X` named constants |
| All `_onCatch`/`_onLassoCatch`/`_startStage` in TutorialSystem | Uses `TutorialStage.X` named constants |

---

## F. Summary of All Changes

| Item | Location | Old Value | New Value |
|------|----------|-----------|-----------|
| `Events.TUTORIAL_WASD_INPUT` | [`Events.js`](js/core/Events.js:211) | *(new)* | `'tutorial:wasdInput'` |
| `TutorialStage.WASD_MOVE` | [`TutorialSystem.js`](js/systems/TutorialSystem.js:14) | *(new)* | `2` |
| `TutorialStage.FREE_PLAY` | [`TutorialSystem.js`](js/systems/TutorialSystem.js:21) | `8` | `9` |
| `COLLISION_AVOIDANCE.TUTORIAL_MIN_STAGE` | [`Constants.js`](js/core/Constants.js:862) | `5` | `6` |
| `TUTORIAL_STAGE_REQUIREMENTS` keys | [`DebrisField.js`](js/entities/DebrisField.js:45) | `{3,4,5,6}` | `{4,5,6,7}` |
| 7× `_tutorialStage` defaults | Various systems | `8` | `9` |
| 5× suppression thresholds `< 4` | Various systems | `< 4` | `< 5` |
| 3× suppression thresholds `< 7` | Various systems | `< 7` | `< 8` |
| Arrow threshold | `TutorialSystem._setupListeners` | `>= 6` | `>= 3` |
| Throttle threshold | `TutorialSystem._setupListeners` | `>= 4` | `>= 2` |
| Inter-stage delay | `TutorialSystem.advanceTo` | `800ms` | `400ms` |
| AUTOPILOT auto-advance | `TutorialSystem._startStage` | `15000ms` | `20000ms` |
| Prompt durations | `TutorialSystem._startStage` | `4s/8s/10s` | `0` (persistent) |
| Listener checks | `TutorialSystem._setupListeners` | `=== Stage` | `<= Stage` (skip-aware) |
| `_onCatch()` pattern | `TutorialSystem._onCatch` | Separate `if` + `===` | Highest-applicable `else if` + `<=` |
| `_onLassoCatch()` check | `TutorialSystem._onLassoCatch` | `=== LASSO` | `<= LASSO` |
| New method | `TutorialSystem._competenceSkip` | *(new)* | Skip-ahead helper |

**Total files modified: 15**

---

## G. Testing Checklist

### Core Tutorial Flow — Normal Progression
1. **Full in-order flow**: INTRO → LOOK (arrows 3×) → WASD (hold W briefly) → THROTTLE (+, −) → LASSO (SPACE + catch) → ARM (1 key + catch) → MULTI → BIG → AUTOPILOT → FREE
2. **Prompt persistence**: At THROTTLE stage, wait 30+ seconds — prompt `[+−] Throttle` stays visible until player presses keys
3. **Prompt persistence at MULTI_ARM/BIG_GAME**: Same — prompt stays until catches advance the stage

### Self-Pacing — Fast Player
4. **Rapid progression**: Expert player can complete LOOK → WASD → THROTTLE in under 2 seconds (3+3+2 inputs + 400ms×2 delays)
5. **Skip via lasso**: At INTRO stage, player catches lasso → jumps directly to FIRST_ARM, skipping LOOK_AROUND/WASD/THROTTLE/LASSO
6. **Skip via arm catches**: Player deploys arm during LOOK_AROUND and catches 3 debris → jumps to BIG_GAME

### Self-Pacing — Slow Player
7. **No prompt timeout**: At every stage, prompts persist indefinitely. Player can take 5 minutes at LASSO stage and the `[SPACE] Cast Lasso` prompt stays visible
8. **AUTOPILOT patience**: Auto-advance timeout is 20s, giving slow players time to find the A key

### Out-of-Sequence Actions
9. **WASD before arrows**: Player presses W during INTRO → `_competenceSkip(WASD_MOVE)` fires → jumps from INTRO(0) to WASD_MOVE(2), skipping LOOK_AROUND(1). WASD count starts.
10. **Throttle before WASD**: Player presses + during LOOK_AROUND → `_competenceSkip(THROTTLE)` fires → jumps to THROTTLE(3), skipping WASD_MOVE(2). Throttle count starts.
11. **Lasso catch during LOOK_AROUND**: Player catches with lasso while at stage 1 → `_onLassoCatch` fires (`stage <= LASSO`) → jumps to FIRST_ARM(5).
12. **Arm catch at wrong stage**: Player catches with arm while at THROTTLE(3) → `_onCatch` finds highest applicable: catches>=1, stage < FIRST_ARM → skips to FIRST_ARM(5).
13. **HUD panel catch-up on skip**: After skip from stage 0 to stage 5 → verify ALL panels through arms-group/cargo-group are lit (via `setTutorialVisibility(5)` with `>=` checks)
14. **Multiple stage jump**: Player at INTRO catches 5 debris without tutorial guidance → `_onCatch` with catches=5, stage<=BIG_GAME → jumps to AUTOPILOT(8)

### A-Key Behavior
15. **A during WASD stage**: Pressing A produces leftward thrust, NOT autopilot toggle
16. **A during any pre-AUTOPILOT**: Same lateral thrust behavior
17. **A at AUTOPILOT stage**: Toggles autopilot
18. **A after skip to FREE_PLAY**: `active = false` → normal A behavior

### Tutorial UI Positioning
19. **Prompt position**: Visible directly above comms panel, right-aligned
20. **Skip button position**: Above prompt, right-aligned, clickable
21. **Multi-line wrap**: Long prompt wraps within 260px
22. **Responsive**: < 480px viewport → 200px width

### Sweep Report Suppression
23. **Suppressed during tutorial**: Trawl idle timeout fires → no overlay
24. **Works in FREE_PLAY**: Normal sweep report overlay appears

### Skip & Veteran Paths  
25. **Skip button**: Any stage → immediate FREE_PLAY, all panels lit, A key normal
26. **Veteran load**: `PERSISTENCE_LOADED` → skip → full unsuppressed behavior

### Renumbering Regression
27. **Debris spawning**: At LASSO(4) stage, fragments appear. At BIG_GAME(7), rocket bodies appear. No spawning during WASD_MOVE(2).
28. **Collision avoidance**: Suppressed stages 0-5, active from MULTI_ARM(6) onward
29. **Weather alerts**: Suppressed stages 0-4, active from FIRST_ARM(5). Geomagnetic: suppressed to BIG_GAME(7).
30. **Kessler warnings**: Suppressed through BIG_GAME(7), active from AUTOPILOT(8)
31. **All system suppressions**: Sensor, power, subsystem, conjunction — all suppressed stages 0-4, active from FIRST_ARM(5)

### Catch Thresholds
32. **Catch advancement**: catches≥2 → MULTI_ARM, ≥3 → BIG_GAME, ≥5 → AUTOPILOT, ≥6 → FREE_PLAY

### Codex & Existing Tests
33. **Codex unlocks**: Each completed stage unlocks expected entry (skipped stages don't unlock)
34. **`test-CollisionAvoidance.js`**: Suppression tests pass with `TUTORIAL_MIN_STAGE: 6`

---

## H. Architectural Recommendations

### Eliminating Raw Numeric Fragility

**Problem:** 8 system files use raw numbers instead of `TutorialStage` constants. This made renumbering fragile and will cause silent regressions on future stage changes.

**Recommended follow-up (out of scope for this change):**

1. Import `TutorialStage` in all affected systems
2. Replace all raw numbers with named references:
   - `this._tutorialStage = 8` → `this._tutorialStage = TutorialStage.FREE_PLAY`
   - `< 4` → `< TutorialStage.FIRST_ARM`
   - `< 7` → `< TutorialStage.AUTOPILOT`
3. Move `COLLISION_AVOIDANCE.TUTORIAL_MIN_STAGE` to reference `TutorialStage.MULTI_ARM`

### Input Counting Approach

The WASD event emission in `processInput()` fires per-frame while keys are held. At 60fps, holding W for 0.05s = 3 emissions → threshold met. This is intentional for fast progression but means the "3 presses" threshold isn't 3 discrete key presses — it's 3 frames of key-held state. For even more precise measurement, emit `TUTORIAL_WASD_INPUT` from `_handleKeyDown` on `KeyW/A/S/D` instead. Trade-off: per-frame is smoother for the player (any held key counts); per-keydown requires 3 discrete press-release cycles. **Recommendation: keep per-frame** for WASD (natural feel), per-keydown for arrows and throttle (already implemented that way).
