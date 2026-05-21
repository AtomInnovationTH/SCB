# First Experience Design — First 90 Seconds

> **Goal:** A new player launching Space Cowboy for the first time has a satisfying scan→target→approach→capture loop within 90 seconds.
> **Context:** [`SkillsSystem`](js/systems/SkillsSystem.js) is active (`USE_SKILLS_SYSTEM = true`). The linear tutorial is disabled. Stage 9 compat bridge fires immediately, bypassing all tutorial gates. No tutorial debris spawns. Player starts alone in empty space.
> **Session:** 25 (planned)

---

## Table of Contents

1. [Problem Summary](#1-problem-summary)
2. [Welcome Field — Nearby Debris at Game Start](#2-welcome-field--nearby-debris-at-game-start)
3. [Guided Flow — The First Loop](#3-guided-flow--the-first-loop)
4. [Skills Pane — Stable Checklist Mode](#4-skills-pane--stable-checklist-mode)
5. [Scan → Target Pane Feedback Chain](#5-scan--target-pane-feedback-chain)
6. [Post-Arrival UX — Target Lock & Drift Recovery](#6-post-arrival-ux--target-lock--drift-recovery)
7. [Contextual Comms Guidance Sequence](#7-contextual-comms-guidance-sequence)
8. [HUD Dormant Opacity Tuning](#8-hud-dormant-opacity-tuning)
9. [Autopilot Transit Feedback](#9-autopilot-transit-feedback)
10. [Scan Sounds — Sonar Ping & Bong](#10-scan-sounds--sonar-ping--bong)
11. [Implementation Plan](#11-implementation-plan)
12. [Files to Modify](#12-files-to-modify)

---

## 1. Problem Summary

| # | Issue | Impact | Root Cause |
|---|-------|--------|------------|
| 1 | No debris near player | Nothing to interact with for 30–90s | [`TUTORIAL_STAGE_REQUIREMENTS`](js/entities/DebrisField.js:45) has no stage 9 entry; random debris 50–500+ km away |
| 2 | No guidance | Player stares at Earth, doesn't know what to do | SkillsSystem replaces tutorial prompts; [`awareness_beauty`](js/systems/SkillsSystem.js:73) auto-fires after 5s but gives no action guidance |
| 3 | Skills Pane distracts | Pop-in/pop-out on every discovery fragments attention | [`SkillsPane.show()`](js/ui/hud/SkillsPane.js:140) slides in for 4–8s then auto-hides; rapid discoveries = visual noise |
| 4 | Scan gives no visual payoff | Pressing S plays a sweep sound and earns $50, but target list doesn't "fill in" | Target list already shows tracked debris; scan only adds untracked contacts |
| 5 | No arrival→action bridge | "ON STATION" doesn't say what to do | [`AutopilotSystem.js:258`](js/systems/AutopilotSystem.js:258): no D/Space hint |
| 6 | No drift recovery | Player wanders after arrival, loses target | No re-approach guidance when distance increases |
| 7 | HUD too dim | 0.3 opacity dormant panels invisible | [`HUD.js:287`](js/ui/HUD.js:287): overtuned for skills revelation |
| 8 | Scan sound is weak | Rising sine sweep sounds generic, not iconic | [`AudioSystem.playScan()`](js/systems/AudioSystem.js:2706): 800→2000Hz sweep lacks punch |

### Timeline WITHOUT Changes
```
0s    — ORBITAL_VIEW starts. HUD at 0.3 opacity. No targets visible.
5s    — awareness_beauty fires. SkillsPane pops in with "Beauty" skill, auto-hides.
10s   — Player presses S. Sweep sound. $50 earned. SkillsPane pops in "Quick Scan".
12s   — Player presses Tab. SkillsPane pops in "Target Selection". Nearest: 200km.
15s   — Player presses A. SkillsPane pops in "Autopilot". Long transit begins.
60-90s — "ON STATION". Player lost. Three SkillsPane pop-ins competing for attention.
```

### Timeline WITH Changes
```
0s    — ORBITAL_VIEW starts. HUD at 0.5 opacity. Stable checklist shows:
         ○ Scan area [S]  ○ Select target [Tab]  ○ Approach [A]
3s    — Comms: "Multiple contacts nearby. Scan first — press S."
5s    — awareness_beauty fires silently (no pane pop-in).
7s    — Player presses S. PING sound. Target-list pane undims, contacts 
         stream in with staggered animation. Checklist: ✓ Scan area [S]
10s   — Player presses Tab. Nearest welcome fragment selected (200m).
         Wireframe panel undims. Checklist: ✓ Select target [Tab]
         Comms: "Fragment — 200m. Press A to approach."
12s   — Player presses A. Autopilot engages. Checklist updates:
         ✓ Approach [A]  → Lasso [Space]  ○ Next target [Tab]
20s   — Transit milestones: "Range: 500m" ... "Range: 200m"
22s   — ARRIVED. Camera TARGET_LOCK on debris.
         Comms: "On station. Press Space to lasso." Reticle brackets visible.
25s   — Player presses Space. CATCH! Slow-mo, green flash, point popup.
         Comms: "Got it! Press Tab for next target."
30s   — Player presses Tab. Second target selected (800m medium debris).
         Checklist refreshes with next 3 steps. The loop continues.
```

---

## 2. Welcome Field — Nearby Debris at Game Start

### 2.1 Concept

Spawn 7–8 debris pieces in the **exact same orbit** as the player, offset only by [`trueAnomaly`](js/entities/OrbitalMechanics.js). This ensures fast autopilot approach (5–15s, no plane changes) and immediate visibility on [`NavSphere`](js/ui/NavSphere.js) and [`TargetReticle`](js/ui/TargetReticle.js).

### 2.2 Debris Layout

| Tier | Count | Distance | Mass | Type | Purpose |
|------|-------|----------|------|------|---------|
| **Close** | 3 | 150–400m | 1–5 kg | `fragment` | Lasso range — trivial first catch |
| **Medium** | 2 | 200–600m | 10–50 kg | `fragment`/`missionDebris` | Arm deploy range |
| **Far** | 2–3 | 800–1500m | 50–200 kg | `defunctSat`/`missionDebris` | Require autopilot approach |

### 2.3 Configuration Constant

Uses **proven empirical offsets** from existing [`TUTORIAL_STAGE_REQUIREMENTS`](js/entities/DebrisField.js:45):

```javascript
/** Welcome field debris — spawned near player on first game frame */
const WELCOME_FIELD = {
  close: {
    count: 3,
    types: ['fragment'],
    massMin: 1, massMax: 5,
    offsetMin: 0.0000015, offsetMax: 0.000004,   // ~150-400m (empirical)
  },
  medium: {
    count: 2,
    types: ['fragment', 'missionDebris'],
    massMin: 10, massMax: 50,
    offsetMin: 0.00002, offsetMax: 0.00006,       // ~200-600m (reuses stage 7)
  },
  far: {
    count: 2,
    types: ['missionDebris', 'defunctSat'],
    massMin: 50, massMax: 200,
    offsetMin: 0.00008, offsetMax: 0.00015,       // ~800-1500m
  },
};
```

### 2.4 Implementation

**New method on [`DebrisField`](js/entities/DebrisField.js:134):** `_spawnWelcomeField(playerOrbit)`

**Trigger:** Called from [`DebrisField.update()`](js/entities/DebrisField.js:596) on the **first frame** where `playerOrbit` is available — same one-shot pattern as [`_ensureTutorialDebris()`](js/entities/DebrisField.js:876):

```javascript
// constructor: add flag
this._welcomeFieldSpawned = false;

// update(): before tutorial debris block
if (!this._welcomeFieldSpawned && playerPos && playerOrbit) {
  this._spawnWelcomeField(playerOrbit);
  this._welcomeFieldSpawned = true;
}
```

The method reuses the existing **reposition-far-debris** pattern from `_ensureTutorialDebris()` — finds far-away debris (>10km), clones player orbital elements, offsets `trueAnomaly`, adjusts mass/type, marks `tracked: true` and `welcomeSpawn: true`. No new instances or InstancedMesh rebuilds needed.

### 2.5 GAME_RESET

```javascript
eventBus.on(Events.GAME_RESET, () => {
  this._welcomeFieldSpawned = false;
  for (const d of this.debrisList) d.welcomeSpawn = false;
});
```

### 2.6 Design Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Constructor or update()? | **update() first frame** | Constructor runs before player orbit is initialized |
| Replace or add debris? | **Reposition far-away** | Maintains 800-count; no mesh rebuilds |
| Pre-tracked? | **Yes** (`tracked: true`) | Essential for Tab targeting without prior scan |
| USE_SKILLS_SYSTEM gated? | **Always active** | Benefits both paths; tutorial debris supplements |

---

## 3. Guided Flow — The First Loop

The core design insight: **players don't read instructions, they follow feedback chains.** Each action's visual/audio payoff must naturally suggest the next action.

### 3.1 The Feedback Chain

```
  S (Scan)           Tab (Target)         A (Autopilot)        Space (Lasso)
     │                    │                     │                     │
     ▼                    ▼                     ▼                     ▼
 ┌──────────┐     ┌──────────────┐     ┌───────────────┐     ┌──────────────┐
 │ PING!    │     │ Wireframe    │     │ Ship rotates  │     │ CATCH! Flash │
 │ Targets  │ ──→ │ panel undims │ ──→ │ Distance:     │ ──→ │ Slow-mo      │
 │ stream in│     │ Reticle      │     │ "500m...200m" │     │ Score popup  │
 │ to list  │     │ brackets     │     │ "ON STATION"  │     │              │
 └──────────┘     │ Comms hint   │     │ Comms hint    │     │ Comms: "Tab  │
                  └──────────────┘     └───────────────┘     │  for next"   │
                                                              └──────────────┘
                                                                     │
                                                                     ▼
                                                             Tab (cycle to next)
                                                             Loop continues...
```

### 3.2 What Each Key Does for a New Player

#### S — Quick Scan
1. **Sonar PING** — sharp, satisfying, distinctive (see §10)
2. **Target-list pane undims** from 0.5→1.0 opacity (data-hud-group `target-list` activates via `scan_quick` skill's `hudGroup: 'targets'`)
3. **Targets stream in** — welcome field debris appears in the target list with staggered animation (see §5)
4. **$50 credit** — cash register audio + credit flash in status panel
5. **Checklist updates** — `✓ Scan area [S]`
6. **Natural next step**: The target list is now *right there*, filled with clickable entries. Tab is the intuitive move.

#### Tab — Select Target
1. **Nearest welcome debris auto-cycles** — [`TargetSelector`](js/systems/TargetSelector.js) cycles through tracked targets by delta-V
2. **Wireframe panel undims** — `target-detail` HUD group activates via `nav_target` skill's `hudGroup: 'target-info'`
3. **Reticle brackets** appear around selected debris on [`TargetReticle`](js/ui/TargetReticle.js)
4. **Comms hint**: "Fragment — 200m. Press A to approach."
5. **Tool recommendation** fires (lasso for <10kg fragments)
6. **Checklist updates** — `✓ Select target [Tab]`

#### Z — Structural Analysis (Optional Discovery)
1. **Cycles wireframe zones** — green/yellow/red structural zones on [`DebrisWireframe`](js/ui/DebrisWireframe.js)
2. **First press comms**: "Structural scan — zones show risk levels. Cycle with Z."
3. **Emits WIREFRAME_ASSESSED** after full cycle — bonus points on capture
4. This is a **discoverable depth action**, not essential to the core loop. New players who skip Z still have a great experience.

#### A — Autopilot
1. **Ship rotates toward target** — visual confirmation of engagement
2. **Comms**: "Approach initiated. ETA ~8s."
3. **Distance milestones** in comms: "Range: 1km... 500m... 200m"
4. **Camera shifts to TARGET_LOCK** — framing the approach cinematically
5. **On arrival**: camera holds TARGET_LOCK, debris visible ahead, reticle brackets prominent
6. **Comms**: "On station. Press Space to lasso."
7. **Checklist updates** — `✓ Approach target [A]`, next: `→ Lasso debris [Space]`

#### Space — Lasso
1. **Brief windup** (150ms) then projectile fires toward target
2. **On contact**: catch flash, slow-mo, score popup, sonar-return sound
3. **Comms**: "Got it! Press Tab for next target."
4. **Checklist updates** — `✓ Lasso debris [Space]`
5. **Natural next**: Player presses Tab, selects medium debris at 500m, the loop continues with slightly harder targets

---

## 4. Skills Pane — Stable Checklist Mode

### 4.1 Problem with Current Behavior

The current [`SkillsPane`](js/ui/hud/SkillsPane.js) is designed as a **reward pop-in** — it slides in when a skill is discovered, shows for 4–8 seconds, then auto-hides. In the first 30 seconds of gameplay, the player might discover 3–5 skills rapidly, causing the pane to pop in and out repeatedly. This:

- **Fragments attention** — player looks at pane instead of the game
- **Creates anxiety** — "what was that? what did I miss?"
- **Doesn't guide** — shows what you *did*, not what to do *next*

### 4.2 Inspiration: Best-in-Class Examples

| Game | Pattern | What Works |
|------|---------|------------|
| **Outer Wilds** | Ship Log — always accessible, updates silently | Discovery never interrupts flow |
| **Subnautica** | Objectives panel — 3 items, persistent, checks off | Clear next-steps without hand-holding |
| **Hades** | Boon descriptions — appear briefly, then accessible in codex | Rewards feel organic, never block gameplay |
| **Dead Cells** | Quick tips — contextual, visible for exactly as long as needed | Duration tied to relevance, not arbitrary timeout |
| **Kerbal Space Program** | Flight checklist — persistent sidebar, sequential | Player controls pace, system confirms completion |

The common pattern: **show what's next, confirm what was done, never disappear during active learning.**

### 4.3 Redesign: Stable Checklist Mode

For the **first ~3 minutes** of a new game (approximately until first capture), the SkillsPane operates in **checklist mode** instead of pop-in mode:

```
┌──────────────────────────────────┐
│  ▸ NEXT STEPS                     │
│  ──────────────────────────────  │
│  ✓ Scan area                 [S]  │  ← completed: green checkmark
│  → Select target            [Tab] │  ← current: highlighted, arrow marker
│  ○ Approach target            [A] │  ← upcoming: dim but readable
│                                   │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│  2/34 skills discovered           │
└──────────────────────────────────┘
```

#### Visual States for Checklist Items

| State | Symbol | Color | Opacity | Meaning |
|-------|--------|-------|---------|---------|
| **Upcoming** | `○` | Tier color (dim) | 0.4 | Not yet attempted |
| **Current** | `→` | Tier color (bright) | 1.0 | Suggested next action, gently pulsing |
| **Completed** | `✓` | `#00ff88` (green) | 0.8 → fades to 0.5 after 3s | Successfully performed |

#### How It Works

1. **On first ORBITAL_VIEW entry**: Pane appears with 3 items from [`SkillsSystem.getNextSuggestions(3)`](js/systems/SkillsSystem.js:149), pre-populated and visible. The first item has the `→` current marker.

2. **When a skill is discovered**: 
   - The matching line transitions from `○` / `→` to `✓` with a brief glow animation (250ms)
   - The next undiscovered item gets the `→` marker
   - If all 3 visible items are checked, the checklist refreshes with the next 3 suggestions
   - A subtle confirmation sound plays (already: `playClick()`)

3. **Pane stays visible** — no auto-hide during checklist mode. It's positioned at `bottom: 180px; right: 10px` (existing location), always present like an objectives panel.

4. **Transition to standard mode**: After the player completes their **first capture** (`ARM_CAPTURED` or `LASSO_CAPTURED`), the pane transitions to the existing pop-in/pop-out behavior. This is the natural boundary — the player now understands the core loop and doesn't need persistent guidance.

5. **Detection**: A `_checklistMode` boolean on SkillsPane, set `true` on construction and `false` on first `ARM_CAPTURED`/`LASSO_CAPTURED` event. While `true`, `show()` keeps the pane visible and `_scheduleHide()` is a no-op.

### 4.4 Checklist Content — The First Three Sequences

The checklist shows 3 items at a time. When all 3 are checked, it refills:

**Sequence 1 (Opening):**
```
○ Scan area [S]
○ Select target [Tab]
○ Approach target [A]
```

**Sequence 2 (After approach):**
```
○ Lasso debris [Space]
○ Next target [Tab]
○ Analyze target [Z]   (optional/discoverable)
```

**Sequence 3 (After first capture → transitions to pop-in mode):**
Pane fades to standard Skills Pane behavior.

### 4.5 Implementation

Modify [`SkillsPane`](js/ui/hud/SkillsPane.js) to add checklist mode:

```javascript
// In constructor:
this._checklistMode = true;
this._checklistItems = [];      // [{skillId, label, key, state: 'upcoming'|'current'|'done'}]
this._checklistSequence = 0;

// New method: _initChecklist()
// Called on first GAME_STATE_CHANGE to ORBITAL_VIEW
_initChecklist() {
  this._checklistItems = [
    { skillId: 'scan_quick',    label: 'Scan area',       key: 'S',   state: 'current' },
    { skillId: 'nav_target',    label: 'Select target',   key: 'Tab', state: 'upcoming' },
    { skillId: 'nav_autopilot', label: 'Approach target',  key: 'A',   state: 'upcoming' },
  ];
  this._renderChecklist();
  this.show();  // Stays visible (no auto-hide in checklist mode)
}

// Modify show() to skip auto-hide in checklist mode:
show(duration) {
  // ... existing show logic ...
  if (!this._checklistMode) {
    this._scheduleHide(dur);
  }
}
```

### 4.6 Discovery Integration

When a skill is discovered (`SKILL_DISCOVERED` event), the checklist mode checks if the discovered skill matches any visible checklist item. If so:
- That item transitions to `done` state (checkmark animation)
- Next `upcoming` item transitions to `current` (arrow, pulse)
- If all 3 are done, load next sequence

This happens **instead of** the standard `_onSkillDiscovered()` pop-in render during checklist mode. The normal skill discovery tracking in [`SkillsSystem`](js/systems/SkillsSystem.js) still runs — hudGroup activation, state progression, etc. Only the **pane display** changes.

---

## 5. Scan → Target Pane Feedback Chain

### 5.1 Problem

Currently, pressing S triggers:
1. [`SensorSystem._startScan('quick')`](js/systems/SensorSystem.js) → `SCAN_INITIATED`
2. [`AudioSystem.playScan()`](js/systems/AudioSystem.js:2706) — rising sine sweep
3. [`PlayerSatellite._scanFlashTimer`](js/entities/PlayerSatellite.js) — 0.5s cyan body glow
4. On completion → `SCORING_AWARD` ($50) + `SCAN_COMPLETE`

But the **target-list HUD pane** doesn't react to the scan. It was already showing tracked debris (or not, if nothing's nearby). The scan feels disconnected from the visible results.

### 5.2 Designed Payoff Chain

When the player presses S and welcome field debris exists:

1. **PING sound** (new — see §10)
2. **Satellite cyan flash** (existing)
3. **Target-list pane activation**: The `scan_quick` skill has `hudGroup: 'targets'`, which maps to `target-list` via [`SKILL_GROUP_TO_DOM`](js/ui/HUD.js:70). On discovery, the pane undims from 0.5→1.0 opacity.
4. **Staggered target appearance**: Instead of all targets appearing instantly, they appear one by one over ~1.5 seconds. This creates a "data streaming in" feel—like a real radar sweep.

### 5.3 Staggered Target Appearance

**Location:** [`TargetPanel.update()`](js/ui/hud/TargetPanel.js)

When the target list receives fresh data and the `scan_quick` skill was just discovered (first scan), the panel delays rendering each target entry by 200ms using CSS animation:

```javascript
// In TargetPanel, when rendering target entries:
if (this._firstScanAnimation && entries.length > 0) {
  entries.forEach((el, i) => {
    el.style.animation = `spSlideIn 250ms ease-out ${i * 200}ms both`;
  });
  this._firstScanAnimation = false;
}
```

This reuses the existing [`spSlideIn`](js/ui/hud/SkillsPane.js:322) keyframe animation. After the first scan, targets render normally (no stagger).

### 5.4 The "Data Streaming In" Moment

The combined effect:
- **Ping** sound fires
- Satellite glows cyan
- Target list pane brightens (undims)
- Target entries cascade in, each one a beat apart
- $50 credit flash in status panel
- Cash register audio dings

This transforms "press S, see sweep sound" into a **multisensory discovery moment** that holds attention for 2–3 seconds and naturally draws the eye to the target list — where Tab is the obvious next step.

---

## 6. Post-Arrival UX — Target Lock & Drift Recovery

### 6.1 Arrival State

When [`AutopilotSystem`](js/systems/AutopilotSystem.js) emits `AUTOPILOT_ARRIVED`:

1. **Camera remains in TARGET_LOCK** — [`CameraSystem`](js/systems/CameraSystem.js) already switches to TARGET_LOCK on `ARM_DEPLOYED`; we extend this to autopilot arrival. If the camera is in CHASE view when autopilot is engaged, it switches to TARGET_LOCK, keeping the debris centered.

2. **Reticle brackets** — [`TargetReticle`](js/ui/TargetReticle.js) already shows brackets around the selected target. With TARGET_LOCK camera, the target is centered on screen.

3. **Comms**: "On station. Press Space to lasso." (replaces generic "ON STATION — ready for capture")

4. **Tool recommendation text** visible in comms panel (existing: [`TargetSelector._updateRecommendation()`](js/systems/TargetSelector.js:88) fires on TARGET_SELECTED)

### 6.2 Camera on Autopilot Engage

**New behavior in [`GameFlowManager.setupEventHandlers()`](js/systems/GameFlowManager.js:201):**

```javascript
eventBus.on(Events.AUTOPILOT_ENGAGE, (data) => {
  // Switch to TARGET_LOCK for cinematic approach (only from CHASE)
  if (data.mode === 'TARGET' && cameraSystem.currentView === CameraViews.CHASE) {
    const target = targetSelector.getActiveTarget();
    if (target && target.orbit) {
      const cart = orbitToSceneCartesian(target.orbit);
      cameraSystem.setLockTarget(new THREE.Vector3(cart.position.x, cart.position.y, cart.position.z));
      cameraSystem.setView(CameraViews.TARGET_LOCK);
    }
  }
});
```

This means the player watches the approach from a cinematic angle — ship framed with target, distance closing visually.

### 6.3 Drift Recovery

After autopilot disengages (`ARRIVED` reason), the player has prograde-tracking — ship naturally faces the debris ahead. But if they press arrow keys or drift:

**New listener in GameFlowManager:**

```javascript
// Track post-arrival state
this._arrivedAtTarget = null;  // debris ref
this._arrivalPos = null;       // player position at arrival

eventBus.on(Events.AUTOPILOT_ARRIVED, () => {
  this._arrivedAtTarget = targetSelector.getActiveTarget();
  this._arrivalPos = this._refs.player.getPosition().clone();
});

// In game loop (or via a periodic check), test if player has drifted:
// If distance to target > 2× arrival distance AND first-time comms flag not set:
_checkDriftRecovery() {
  if (!this._arrivedAtTarget || !this._arrivedAtTarget.alive) return;
  const cart = orbitToSceneCartesian(this._arrivedAtTarget.orbit);
  const targetPos = new THREE.Vector3(cart.position.x, cart.position.y, cart.position.z);
  const playerPos = this._refs.player.getPosition();
  const dist = playerPos.distanceTo(targetPos);
  const arrivalDist = 0.002; // ~200m in scene units
  
  if (dist > arrivalDist * 2.5 && !this._firstTimeComms.has('drift_recovery')) {
    this._firstTimeComms.add('drift_recovery');
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'SPACECRAFT',
      text: 'Target drifting — press A to re-approach.',
      priority: 'info',
    });
  }
}
```

This is a **one-shot** safety net. If the player accidentally rotates away or drifts, they get a single helpful nudge. Not nagging — fires once.

---

## 7. Contextual Comms Guidance Sequence

### 7.1 Complete Message Table

Messages fire through the existing [`CommsSystem`](js/systems/CommsSystem.js) via `Events.COMMS_MESSAGE`. Each fires **only once** per game, tracked via `Set<string>` on GameFlowManager.

| # | Trigger | Condition | Sender | Message | Timing |
|---|---------|-----------|--------|---------|--------|
| 0 | First ORBITAL_VIEW + 3s delay | `_firstOrbitalView` | SPACECRAFT | `Multiple contacts nearby. Press S to scan.` | t=3s |
| 1 | `SCAN_COMPLETE` (quick) | First time | SPACECRAFT | `{N} contacts resolved. Press Tab to select.` | t=7s |
| 2 | `TARGET_SELECTED` | First time (via Tab) | SPACECRAFT | `{type} — {dist}m. Press A to approach.` | t=10s |
| 3 | `AUTOPILOT_ENGAGE` | First time | SPACECRAFT | `Approach initiated. ETA ~{eta}s.` | t=12s |
| 4 | `AUTOPILOT_ARRIVED` | First time | SPACECRAFT | `On station. Press Space to lasso.` | t=22s |
| 5 | `ARM_CAPTURED` / `LASSO_CAPTURED` | First time | HOUSTON | `Got it! Press Tab for next target.` | t=25s |
| 6 | `TARGET_SELECTED` | Second time (post-capture) | SPACECRAFT | `Target locked. Press A to approach.` | t=30s |
| 7 | Post-arrival drift | Distance > 2.5× arrival | SPACECRAFT | `Target drifting — press A to re-approach.` | varies |

### 7.2 Auto-Target on First Orbital View

After a 3-second beauty delay, if no target is selected, the system also **auto-targets** the nearest welcome-field debris:

```javascript
// In GameFlowManager, on first ORBITAL_VIEW:
setTimeout(() => {
  if (!targetSelector.getActiveTarget()) {
    const nearby = debrisField.getDebrisNear(player.getPosition(), 0.05);
    const welcome = nearby.find(d => d.welcomeSpawn && d.alive);
    if (welcome) {
      const debris = debrisField.getDebrisById(welcome.id);
      if (debris) targetSelector.setTarget(debris);
    }
  }
  // Emit opening comms regardless of auto-target
  eventBus.emit(Events.COMMS_MESSAGE, {
    sender: 'SPACECRAFT',
    text: 'Multiple contacts nearby. Press S to scan.',
    priority: 'info',
  });
}, 3000);
```

**Why auto-target AND suggest scan?** The auto-target ensures something is visible immediately. The "press S" comms guides toward an *active action* that creates the feedback chain (§5). If the player presses Tab before S, that's fine — they skip scan and go straight to target selection.

### 7.3 Implementation

All comms guidance lives in [`GameFlowManager.setupEventHandlers()`](js/systems/GameFlowManager.js:201) as event listeners with the `_firstTimeComms` Set guard:

```javascript
// Constructor:
this._firstTimeComms = new Set();
this._firstOrbitalView = true;
this._arrivedAtTarget = null;

// resetGame():
this._firstTimeComms = new Set();
this._firstOrbitalView = true;
this._arrivedAtTarget = null;
```

---

## 8. HUD Dormant Opacity Tuning

### 8.1 Change

[`HUD.js:287`](js/ui/HUD.js:287):

```css
/* BEFORE */
.hud-dormant {
    opacity: 0.3;
    filter: saturate(0.3);
}

/* AFTER */
.hud-dormant {
    opacity: 0.5;
    filter: saturate(0.4);
}
```

At 0.5 opacity, panels are **readable but clearly dimmed** — the player can see *something is there* before skills activate it. Labels, section headers, and panel borders are visible enough to create curiosity without looking unlocked.

### 8.2 Comms Panel Dormant

[`HUD._applySkillReveal()`](js/ui/HUD.js:464):

```javascript
// BEFORE
this.panels.comms.style.opacity = commsActive ? '' : '0.3';
// AFTER
this.panels.comms.style.opacity = commsActive ? '' : '0.5';
```

Critical for first-experience: comms guidance messages (§7) must be readable even before the `manage_comms` skill is discovered.

---

## 9. Autopilot Transit Feedback

### 9.1 Distance Milestones

Add periodic distance updates to [`AutopilotSystem.update()`](js/systems/AutopilotSystem.js:203) via comms at descending milestones:

```javascript
// Constructor:
this._lastDistanceReport = Infinity;

// In update(), after computing dist to target in TARGET mode:
const distM = Math.round(dist / Constants.SCENE_SCALE * 1000);
const milestones = [5000, 2000, 1000, 500];
for (const m of milestones) {
  if (distM <= m && this._lastDistanceReport > m) {
    this._lastDistanceReport = m;
    const label = m >= 1000 ? `${(m/1000).toFixed(1)}km` : `${m}m`;
    eventBus.emit(Events.COMMS_MESSAGE, {
      sender: 'SPACECRAFT',
      text: `Range: ${label}`,
      priority: 'info',
    });
    break;
  }
}

// In disengage():
this._lastDistanceReport = Infinity;
```

These give the player confidence that autopilot is working and create a countdown feel during transit.

---

## 10. Scan Sounds — Sonar Ping & Bong

### 10.1 Current Sound

[`AudioSystem.playScan()`](js/systems/AudioSystem.js:2706): Rising sine sweep 800→2000Hz, 0.3s. Sounds generic — indistinguishable from a UI feedback tone. No personality.

### 10.2 Design References

| Sound | Real-World Reference | Character |
|-------|---------------------|-----------|
| **Quick Scan (S)** | Submarine active sonar ping | Sharp, metallic, reverberant. A single "PING" that echoes briefly. Think *Das Boot*, *The Hunt for Red October*. |
| **Wide Scan (W)** | Deep sonar search pulse | Lower, warmer, sustained. A "BONG" with harmonic overtones that sweeps outward. Think deep-ocean research sonar. |

### 10.3 Generated via Web Audio API

All existing game sounds use Web Audio API synthesis (no audio files). These follow the same pattern.

#### Quick Scan — Sonar Ping

```javascript
playScanPing() {
  if (!this.available) return;
  const ctx = this.ctx;
  const now = ctx.currentTime;
  
  // Primary tone: sharp sine at 2400Hz
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(2400, now);
  osc.frequency.exponentialRampToValueAtTime(2200, now + 0.08);  // slight downward chirp
  
  // Gain envelope: sharp attack, medium decay (sonar echo feel)
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.25, now + 0.005);   // 5ms near-instant attack
  gain.gain.exponentialRampToValueAtTime(0.08, now + 0.15); // sustain
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6); // long tail (echo feel)
  
  // Bandpass filter for metallic character
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 2400;
  filter.Q.value = 12;  // narrow band = metallic ring
  
  // Connect: osc → filter → gain → sfxBus
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(this.sfxBus);
  osc.start(now);
  osc.stop(now + 0.7);
}
```

**Character:** Sharp "PING!" with a metallic ring that decays over ~0.5s. The narrow bandpass filter creates the characteristic submarine sonar quality. The slight frequency downsweep (2400→2200Hz) adds realism — real sonar pings have a slight chirp.

#### Wide Scan — Sonar Bong

```javascript
playScanBong() {
  if (!this.available) return;
  const ctx = this.ctx;
  const now = ctx.currentTime;
  
  // Fundamental: deep sine at 400Hz
  const osc1 = ctx.createOscillator();
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(400, now);
  osc1.frequency.exponentialRampToValueAtTime(350, now + 0.8);  // slight droop
  
  // Harmonic: octave above at 800Hz (gives body)
  const osc2 = ctx.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(800, now);
  osc2.frequency.exponentialRampToValueAtTime(720, now + 0.8);
  
  // Third harmonic (subtle): 1600Hz metallic shimmer
  const osc3 = ctx.createOscillator();
  osc3.type = 'sine';
  osc3.frequency.setValueAtTime(1600, now);
  osc3.frequency.exponentialRampToValueAtTime(1400, now + 0.5);
  
  // Gain envelopes
  const gain1 = ctx.createGain();
  gain1.gain.setValueAtTime(0, now);
  gain1.gain.linearRampToValueAtTime(0.20, now + 0.02);   // 20ms soft attack
  gain1.gain.exponentialRampToValueAtTime(0.001, now + 1.2); // long decay
  
  const gain2 = ctx.createGain();
  gain2.gain.setValueAtTime(0, now);
  gain2.gain.linearRampToValueAtTime(0.10, now + 0.02);
  gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
  
  const gain3 = ctx.createGain();
  gain3.gain.setValueAtTime(0, now);
  gain3.gain.linearRampToValueAtTime(0.04, now + 0.01);
  gain3.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
  
  // Low-pass filter for warmth
  const lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.value = 3000;
  lpf.Q.value = 1;
  
  // Connect all
  osc1.connect(gain1); gain1.connect(lpf);
  osc2.connect(gain2); gain2.connect(lpf);
  osc3.connect(gain3); gain3.connect(lpf);
  lpf.connect(this.sfxBus);
  
  osc1.start(now); osc1.stop(now + 1.3);
  osc2.start(now); osc2.stop(now + 1.0);
  osc3.start(now); osc3.stop(now + 0.6);
}
```

**Character:** Deep, warm "BONG" with harmonic overtones that create a sense of depth. The 400Hz fundamental gives weight; the 800Hz and 1600Hz harmonics add shimmer. The low-pass filter keeps it warm rather than harsh. Total duration ~1.2s — noticeably longer than the quick scan, reinforcing that it's a deeper, more thorough scan.

### 10.4 Integration Points

Replace the existing [`playScan()`](js/systems/AudioSystem.js:2706) call in the `SCAN_INITIATED` listener:

```javascript
// In AudioSystem constructor listener:
eventBus.on(Events.SCAN_INITIATED, (data) => {
  if (data && data.type === 'wide') {
    this.playScanBong();
  } else {
    this.playScanPing();
  }
});
```

Check if [`SensorSystem`](js/systems/SensorSystem.js) includes scan type in the `SCAN_INITIATED` event payload. If not, add `{ type: 'quick' }` or `{ type: 'wide' }` to the emission.

---

## 11. Implementation Plan

### Step-by-Step Order

| # | Task | Files | Effort | Depends On |
|---|------|-------|--------|------------|
| 1 | **Welcome Field spawn** | [`DebrisField.js`](js/entities/DebrisField.js) | ~55 LOC | — |
| 2 | **HUD opacity tuning** | [`HUD.js`](js/ui/HUD.js) | ~4 LOC | — |
| 3 | **Scan sounds (ping + bong)** | [`AudioSystem.js`](js/systems/AudioSystem.js) | ~80 LOC | — |
| 4 | **Skills Pane checklist mode** | [`SkillsPane.js`](js/ui/hud/SkillsPane.js) | ~120 LOC | — |
| 5 | **Auto-target + contextual comms** | [`GameFlowManager.js`](js/systems/GameFlowManager.js) | ~80 LOC | Step 1 |
| 6 | **Scan→target stagger animation** | [`TargetPanel.js`](js/ui/hud/TargetPanel.js) | ~15 LOC | — |
| 7 | **Autopilot transit milestones** | [`AutopilotSystem.js`](js/systems/AutopilotSystem.js) | ~25 LOC | — |
| 8 | **Post-arrival camera + drift recovery** | [`GameFlowManager.js`](js/systems/GameFlowManager.js) | ~30 LOC | Step 5 |
| 9 | **Playtest & tune** | — | — | Steps 1–8 |

**Total estimated new code:** ~410 LOC across 6 files.

### Recommended Session Breakdown

**Session A (~60 min) — Foundation:**
1. Welcome Field spawn ([`DebrisField.js`](js/entities/DebrisField.js))
2. HUD opacity ([`HUD.js`](js/ui/HUD.js))
3. Scan sounds ([`AudioSystem.js`](js/systems/AudioSystem.js))
4. Autopilot milestones ([`AutopilotSystem.js`](js/systems/AutopilotSystem.js))

**Session B (~60 min) — Flow & Polish:**
5. Skills Pane checklist mode ([`SkillsPane.js`](js/ui/hud/SkillsPane.js))
6. Target stagger animation ([`TargetPanel.js`](js/ui/hud/TargetPanel.js))
7. Auto-target + comms + camera + drift ([`GameFlowManager.js`](js/systems/GameFlowManager.js))
8. Browser playtest of full 90-second loop

---

## 12. Files to Modify

### [`js/entities/DebrisField.js`](js/entities/DebrisField.js)

| Change | Location | Scope |
|--------|----------|-------|
| Add `WELCOME_FIELD` config constant | After `TUTORIAL_STAGE_REQUIREMENTS` (~line 58) | +15 LOC |
| Add `_welcomeFieldSpawned` flag | Constructor (~line 173) | +1 LOC |
| Add `_spawnWelcomeField()` method | After `_ensureTutorialDebris()` (~line 980) | +40 LOC |
| Call `_spawnWelcomeField()` in `update()` | Before tutorial debris block (~line 600) | +4 LOC |
| Add `GAME_RESET` listener | Constructor event listeners (~line 202) | +5 LOC |

### [`js/ui/HUD.js`](js/ui/HUD.js)

| Change | Location | Scope |
|--------|----------|-------|
| Change `.hud-dormant` opacity 0.3→0.5 | CSS block (~line 287) | 1 line |
| Change `.hud-dormant` saturate 0.3→0.4 | CSS block (~line 288) | 1 line |
| Change comms dormant opacity 0.3→0.5 | `_applySkillReveal()` (~line 464) | 1 line |

### [`js/systems/AudioSystem.js`](js/systems/AudioSystem.js)

| Change | Location | Scope |
|--------|----------|-------|
| Add `playScanPing()` method | After existing `playScan()` (~line 2729) | +30 LOC |
| Add `playScanBong()` method | After `playScanPing()` | +45 LOC |
| Update `SCAN_INITIATED` listener to dispatch by type | Constructor listener (~line 136) | +5 LOC |

### [`js/ui/hud/SkillsPane.js`](js/ui/hud/SkillsPane.js)

| Change | Location | Scope |
|--------|----------|-------|
| Add `_checklistMode` flag | Constructor (~line 70) | +3 LOC |
| Add `_initChecklist()` method | After `_initCatalog()` | +30 LOC |
| Add `_renderChecklist()` method | New render path for checklist | +40 LOC |
| Modify `show()` to skip auto-hide in checklist mode | `show()` (~line 140) | +3 LOC |
| Modify `_onSkillDiscovered()` to update checklist | `_onSkillDiscovered()` (~line 606) | +25 LOC |
| Listen for `LASSO_CAPTURED`/`ARM_CAPTURED` to exit checklist mode | `_setupListeners()` (~line 582) | +8 LOC |
| Listen for `GAME_STATE_CHANGE` to init checklist | `_setupListeners()` | +8 LOC |

### [`js/systems/GameFlowManager.js`](js/systems/GameFlowManager.js)

| Change | Location | Scope |
|--------|----------|-------|
| Add `_firstOrbitalView`, `_firstTimeComms`, `_arrivedAtTarget` | Constructor (~line 38) | +3 LOC |
| Add first-ORBITAL_VIEW listener with auto-target + comms | `setupEventHandlers()` (~line 201) | +25 LOC |
| Add contextual comms listeners (7 messages) | `setupEventHandlers()` | +50 LOC |
| Add `_checkDriftRecovery()` method | After `deployArm()` (~line 1117) | +20 LOC |
| Add camera-on-autopilot-engage listener | `setupEventHandlers()` | +10 LOC |
| Reset flags in `resetGame()` | `resetGame()` (~line 928) | +3 LOC |

### [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js)

| Change | Location | Scope |
|--------|----------|-------|
| Add `_lastDistanceReport` field | Constructor (~line 66) | +1 LOC |
| Add distance milestone reporting | `update()`, after arrival check (~line 260) | +20 LOC |
| Reset in `disengage()` | `disengage()` (~line 176) | +1 LOC |

### [`js/ui/hud/TargetPanel.js`](js/ui/hud/TargetPanel.js)

| Change | Location | Scope |
|--------|----------|-------|
| Add `_firstScanAnimation` flag | Constructor | +1 LOC |
| Add staggered entry animation on first scan | Target list render | +10 LOC |
| Reset on `GAME_RESET` | Constructor listener | +3 LOC |

### No New Files Required

All changes fit within existing modules. No new events needed.

---

## Appendix A: API Verification & Edge Cases

### A.1 Verified APIs

| API | File:Line | Signature | Notes |
|-----|-----------|-----------|-------|
| [`SensorSystem._startScan()`](js/systems/SensorSystem.js:330) | L337 | `emit(SCAN_INITIATED, { type })` | ✅ Already includes `type: 'quick'\|'wide'` in payload |
| [`CameraSystem.setView()`](js/systems/CameraSystem.js:241) | L241 | `setView(view: CameraViews)` | ✅ Takes enum string, starts transition, emits `CAMERA_VIEW_CHANGE` |
| [`CameraSystem.setLockTarget()`](js/systems/CameraSystem.js:312) | L312 | `setLockTarget(pos: Vector3\|null)` | ✅ Clones position into `targetLock.target` |
| [`SkillsSystem.getNextSuggestions()`](js/systems/SkillsSystem.js:149) | L149 | `getNextSuggestions(n=3): Object[]` | ✅ Returns CATALOG defs (`id`, `label`, `key`, `tier`), sorted by tier |
| [`TargetPanel._updateTargetList()`](js/ui/hud/TargetPanel.js:296) | L296–393 | `_updateTargetList(cached, untracked, sats)` | Rebuilds `listEl.innerHTML` via `targets.map().join('')` every 2Hz |
| [`SkillsPane._renderCompact()`](js/ui/hud/SkillsPane.js:716) | L716 | `_renderCompact(highlightId)` | Clears `_paneBody`, renders active (max 4) + suggestions (max 2) |
| [`SkillsPane._onSkillDiscovered()`](js/ui/hud/SkillsPane.js:606) | L606 | `_onSkillDiscovered({skillId, tier})` | Updates state, renders compact, shows edge glow, calls `show()` |
| [`DebrisField.getDebrisNear()`](js/entities/DebrisField.js:992) | L992 | `getDebrisNear(pos, radius): Object[]` | Distance-sorted array with `{...debris, distance, distanceKm}` |
| [`targetSelector.setTarget()`](js/systems/TargetSelector.js:47) | L47 | `setTarget(debris, ctx={})` | Emits `TARGET_SELECTED` with `{id, type, debris}` |

### A.2 Edge Cases — Out-of-Order Player Actions

The design handles players pressing keys in any order. Every action is rewarded, never punished.

| Scenario | What Happens | Design Response |
|----------|-------------|-----------------|
| **A before S** (autopilot before scan) | Autopilot engages; welcome debris already auto-targeted at t=3s | Works. Checklist marks "Approach" done, skips "Scan". Checklist smart-refreshes showing remaining unchecked items first. |
| **Tab before S** (target before scan) | Tab cycles through tracked welcome debris (all `tracked: true`) | Works. Target selected from pre-tracked list. Scan remains unchecked — player may discover later. |
| **Space before arrival** (lasso while far) | [`LassoSystem.fire()`](js/systems/LassoSystem.js) fires but target beyond 200m `LASSO_RANGE` — misses | No harm. `LASSO_MISSED` fires → `collect_lasso_miss` skill. Comms: "Missed! Get closer." |
| **Z before Tab** (wireframe before target) | [`DebrisWireframe.cycleZone()`](js/ui/DebrisWireframe.js) cycles on ADR self-view (no target selected) | Works — shows ship wireframe in self-view mode. |
| **D before Tab** (deploy before target) | [`TargetSelector._deployRecommended()`](js/systems/TargetSelector.js:165) fires "No target selected" | Existing behavior. Comms: "No target — press Tab first." |
| **Player does nothing for 30s** | `awareness_beauty` fires at 5s. Auto-target + comms at 3s. | Comms remain in panel. Checklist shows "→ Scan [S]" with gentle pulse. |
| **Player presses V** (camera cycle) | Cycles CHASE→TARGET_LOCK→ORBIT. `nav_camera` skill discovered. | No conflict with autopilot camera — AP camera switch only on `AUTOPILOT_ENGAGE`. |
| **Saved game continue** | `MENU_CONTINUE` loads save, goes to BRIEFING | Set `_firstOrbitalView = false` + pre-fill `_firstTimeComms` to skip all guidance. |

### A.3 Checklist ↔ Skill Discovery Mapping

The checklist uses **hardcoded sequences** mapped to skill IDs from [`Constants.SKILLS.CATALOG`](js/core/Constants.js:966):

**Sequence 1 (Opening):**

| Checklist Label | Skill ID | CATALOG `triggerEvent` | Key |
|-----------------|----------|----------------------|-----|
| Scan area | `scan_quick` | `SCAN_QUICK` | S |
| Select target | `nav_target` | `TARGET_SELECTED` | Tab |
| Approach target | `nav_autopilot` | `AUTOPILOT_ENGAGE` | A |

**Sequence 2 (After all of Sequence 1 checked):**

| Checklist Label | Skill ID | CATALOG `triggerEvent` | Key |
|-----------------|----------|----------------------|-----|
| Lasso debris | `collect_lasso` | `LASSO_FIRED` | Space |
| Next target | `nav_target` | `TARGET_SELECTED` | Tab |
| Wide scan | `scan_wide` | `SCAN_WIDE` | W |

**Matching logic:** When `SKILL_DISCOVERED` fires with a `skillId`, checklist scans visible items for match. Matched item transitions to `done`. Out-of-order is fine: if player discovers `nav_autopilot` before `scan_quick`, the third item checks while the first stays unchecked.

**Sequence refresh:** When all 3 items in a sequence are `done`, load the next sequence. Undone items from previous sequence are dropped (player completed the loop differently). After first capture → exit checklist mode entirely.

### A.4 Drift Detection — setTimeout Pattern

[`GameFlowManager`](js/systems/GameFlowManager.js) has no per-frame `update()`. Drift detection uses a **one-shot delayed check**:

```javascript
eventBus.on(Events.AUTOPILOT_ARRIVED, () => {
  // ... first-time comms logic ...
  
  this._arrivedAtTarget = targetSelector.getActiveTarget();
  if (this._arrivedAtTarget && !this._firstTimeComms.has('drift_recovery')) {
    setTimeout(() => {
      if (!this._arrivedAtTarget || !this._arrivedAtTarget.alive) return;
      if (this._firstTimeComms.has('first_capture')) return; // already caught it
      
      const { player } = this._refs;
      const cart = orbitToSceneCartesian(this._arrivedAtTarget.orbit);
      if (!cart || !cart.position) return;
      const targetPos = new THREE.Vector3(cart.position.x, cart.position.y, cart.position.z);
      const dist = player.getPosition().distanceTo(targetPos);
      
      if (dist > 0.005) { // > 500m = drifted significantly
        this._firstTimeComms.add('drift_recovery');
        eventBus.emit(Events.COMMS_MESSAGE, {
          sender: 'SPACECRAFT',
          text: 'Target drifting — press A to re-approach.',
          priority: 'info',
        });
      }
    }, 8000);
  }
});
```

The 8-second delay gives the player time to act. If they've already captured or re-engaged autopilot, the check silently exits.

### A.5 AudioSystem Listener Change

Current at [`AudioSystem.js:136`](js/systems/AudioSystem.js:136):
```javascript
eventBus.on(Events.SCAN_INITIATED, () => { this.playScan(); });
```

Change to:
```javascript
eventBus.on(Events.SCAN_INITIATED, (data) => {
  if (data && data.type === 'wide') {
    this.playScanBong();
  } else {
    this.playScanPing();
  }
});
```

Existing [`playScan()`](js/systems/AudioSystem.js:2706) is **kept but unused from the listener** — retained as a fallback if called elsewhere.

### A.6 Target Stagger Animation

[`TargetPanel._updateTargetList()`](js/ui/hud/TargetPanel.js:329) rebuilds via `targets.map().join('')`. Stagger animation approach:

```javascript
// In TargetPanel constructor:
this._pendingStagger = false;

// Listener (one-shot):
eventBus.on(Events.SCAN_COMPLETE, () => {
  if (!this._pendingStagger) this._pendingStagger = true;
});
eventBus.on(Events.GAME_RESET, () => { this._pendingStagger = false; });

// In _updateTargetList, line ~329, inside targets.map():
const stagger = this._pendingStagger;
if (stagger) this._pendingStagger = false;

// In the .map() callback (both selected and collapsed paths):
const animStyle = stagger
  ? ` style="animation: spSlideIn 250ms ease-out ${i * 200}ms both;"`
  : '';
// Apply to: <div class="target-row"${animStyle} data-id="${t.id}">
```

The `spSlideIn` keyframe is already [globally injected](js/ui/hud/SkillsPane.js:322) by SkillsPane. Since TargetPanel rebuilds innerHTML every 500ms, the stagger replays once then `_pendingStagger` is false — subsequent renders are instant.

### A.7 SkillsPane Checklist CSS

New classes in [`SkillsPane._injectStyles()`](js/ui/hud/SkillsPane.js:235):

```css
.sp-entry.sp-cl-upcoming { opacity: 0.45; }
.sp-entry.sp-cl-current  { opacity: 1.0; animation: spClPulse 2s ease-in-out infinite; }
.sp-entry.sp-cl-done     { opacity: 0.7; }
.sp-entry.sp-cl-done .sp-sym { color: #00ff88 !important; }
.sp-entry.sp-cl-done .sp-lbl { color: #00ff88 !important; }

@keyframes spClPulse {
  0%, 100% { opacity: 1.0; }
  50%      { opacity: 0.7; }
}
@keyframes spCheckPop {
  0%   { transform: scale(1.0); }
  30%  { transform: scale(1.3); }
  100% { transform: scale(1.0); }
}
.sp-entry.sp-check-pop .sp-sym { animation: spCheckPop 300ms ease-out; }
```

### A.8 Camera on Autopilot Engage — Scope Guard

Place in [`GameFlowManager.setupEventHandlers()`](js/systems/GameFlowManager.js:201), not AutopilotSystem (GFM has cameraSystem ref):

```javascript
eventBus.on(Events.AUTOPILOT_ENGAGE, (data) => {
  // Camera switch: only TARGET mode + CHASE view + valid target
  if (data.mode === 'TARGET') {
    const { cameraSystem } = this._refs;
    if (cameraSystem && cameraSystem.currentView === CameraViews.CHASE) {
      const target = targetSelector.getActiveTarget();
      if (target && target.orbit) {
        const cart = orbitToSceneCartesian(target.orbit);
        if (cart && cart.position) {
          cameraSystem.setLockTarget(
            new THREE.Vector3(cart.position.x, cart.position.y, cart.position.z)
          );
          cameraSystem.setView(CameraViews.TARGET_LOCK);
        }
      }
    }
  }
  // First-time ETA comms (from §7):
  if (!this._firstTimeComms.has('autopilot_engage')) {
    this._firstTimeComms.add('autopilot_engage');
    // ... ETA computation + comms emit ...
  }
});
```

### A.9 Saved Game — Skip All Guidance

In [`MENU_CONTINUE` handler](js/systems/GameFlowManager.js:233):

```javascript
eventBus.on(Events.MENU_CONTINUE, () => {
  // ... existing load logic ...
  
  // Skip first-experience for returning players
  this._firstOrbitalView = false;
  this._firstTimeComms = new Set([
    'autopilot_engage', 'autopilot_arrived',
    'first_capture', 'second_target', 'drift_recovery',
  ]);
});
```

### A.10 SkillsPane Checklist Mode — Exit Trigger

```javascript
// In SkillsPane._setupListeners():
const exitChecklist = () => {
  if (!this._checklistMode) return;
  this._checklistMode = false;
  // Transition: fade checklist content, then switch to standard render
  setTimeout(() => {
    this._renderCompact();  // Switch to standard discovery-based render
    this._scheduleHide(Constants.SKILLS.PANE_SHOW_DURATION);
  }, 2000); // 2s grace period after first capture
};
this._unsubs.push(eventBus.on(Events.ARM_CAPTURED, exitChecklist));
this._unsubs.push(eventBus.on(Events.LASSO_CAPTURED, exitChecklist));

// Also exit on GAME_STATE_CHANGE to non-gameplay states:
this._unsubs.push(eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
  if (to !== 'ORBITAL_VIEW' && to !== 'APPROACH' && to !== 'INTERACTION') {
    this._checklistMode = false;
  }
}));
```
