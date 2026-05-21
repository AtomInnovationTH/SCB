# Skills Discovery System — Architectural Design

> **⚠️ ARCHIVED — 2026-04-22.** Superseded by [`SKILLS_ARCHITECTURE.md`](SKILLS_ARCHITECTURE.md) which is the as-built implementation reference. This document is the earlier design spec retained for historical reference. **Move to `archive/`.**

> **Replaces:** Linear 10-stage tutorial (deleted in Sprint 3 ST-3.2)
> **Philosophy:** Every first interaction is a reward. No gates. No lectures. The player teaches themselves.
> **Last updated:** 2026-04-14

---

## Table of Contents

1. [Problem Analysis](#1-problem-analysis)
2. [Skill Inventory](#2-skill-inventory)
3. [Skill Discovery Mechanics](#3-skill-discovery-mechanics)
4. [Skills Pane UI Design](#4-skills-pane-ui-design)
5. [Feedback & Reward Theory](#5-feedback--reward-theory)
6. [Technical Architecture](#6-technical-architecture)
7. [HUD Progressive Unlock Mapping](#7-hud-progressive-unlock-mapping)
8. [Edge Cases & Robustness](#8-edge-cases--robustness)
9. [Implementation Phases](#9-implementation-phases)
10. [Open Questions](#10-open-questions)

---

## 1. Problem Analysis

### 1.1 What's Wrong with Linear Tutorials

The current [`TutorialSystem.js`](js/systems/TutorialSystem.js) implements a strict 10-stage sequence:

```
BEAUTY(0) → LOOK_AROUND(1) → SCAN(2) → TARGET_SELECT(3) → AUTOPILOT(4)
→ CAMERA(5) → LASSO(6) → DEPLOY(7) → TOOL_MASTERY(8) → FREE_PLAY(9)
```

**Structural problems:**

| Problem | Evidence in Code | Player Experience |
|---------|-----------------|-------------------|
| **Hard gates** | [`onScanInput`](js/systems/TutorialSystem.js:193) returns if `stage !== SCAN` | Player presses S before arrows → nothing happens → confusion |
| **Ignored curiosity** | Each listener checks `this.stage !== X` before acting | Natural explorers are punished for trying things early |
| **Binary state** | `this.active = true/false` — either "in tutorial" or "done" | No ongoing learning support after stage 9 |
| **Skip = symptom** | [`skip()`](js/systems/TutorialSystem.js:483) exists because the tutorial is boring | The solution to a bad tutorial is a skip button; the solution to a good one is to not need one |
| **No replay value** | Veterans get `PERSISTENCE_LOADED → skip()` | Returning players get zero learning support |
| **No out-of-order** | Stage advancement is monotonic: `if (newStage <= this.stage) return` | Can't reward early discovery |

### 1.2 What Already Works (Keep These)

The codebase already has excellent infrastructure that the new system should absorb:

1. **Progressive HUD luminance** — [`setTutorialVisibility()`](js/ui/HUD.js:334) with `hud-dormant`/`hud-active` CSS classes on `data-hud-group` elements. This is the right idea; it just needs to be driven by skill state instead of linear stage numbers.

2. **Codex unlock on skill completion** — [`_unlockCodexForCompletedStage()`](js/systems/TutorialSystem.js:434) maps stages to codex entries. The new system should integrate codex unlocks with skill discovery.

3. **Comms-based feedback** — Houston messages via [`Events.COMMS_MESSAGE`](js/core/Events.js:91) provide in-character feedback. The tone is already right.

4. **Tutorial event emissions** — [`InputManager.js`](js/systems/InputManager.js:151) already emits `TUTORIAL_ARROW_INPUT`, `TUTORIAL_SCAN_INPUT`, `TUTORIAL_TAB_INPUT`, `TUTORIAL_DEPLOY_INPUT`. These become skill trigger events.

5. **Economy discovery hints** — One-shot flags (`_salvageHintShown`, `_forgeHintShown`, `_fuelHintShown`) in [`TutorialSystem.js`](js/systems/TutorialSystem.js:43) already implement post-tutorial learning. This pattern generalizes to the skills system.

6. **First-time tracking** — `this.firsts = new Set()` exists but is underused. The new system is *all* firsts.

### 1.3 Design Principles (Non-Negotiable)

1. **Any key, any time, rewarded** — pressing any key for the first time always produces positive feedback
2. **No sequence enforced** — scanning before looking around is valid and rewarded
3. **Progressive disclosure, not progressive gating** — HUD elements light up as skills are discovered, but nothing is *locked*
4. **Ongoing learning** — the system never "completes" — there are always deeper skills to discover
5. **Veteran-friendly** — returning players see their skills restored, with gentle reminders for forgotten ones
6. **Codex integration** — skill discovery feeds the codex; codex entries reference skills
7. **Houston stays in character** — all feedback comes through the comms system, not UI popups

---

## 2. Skill Inventory

### 2.1 Skill Tiers

Skills are organized into tiers for UI grouping and feedback calibration, but **tier order is not enforced**. A player can discover a Mastery skill before an Awareness skill.

#### Tier 1: Awareness (Passive Discoveries)

These trigger from natural exploration — no specific intent required.

| Skill ID | Name | Trigger | HUD Group Activated | Codex Entry | Houston Message |
|----------|------|---------|-------------------|-------------|-----------------|
| `awareness_zoom` | Zoom Control | Scroll wheel input | — | — | "Zoom adjusted. Use the scroll wheel to get a closer look at anything that catches your eye." |
| `awareness_look` | Look Around | Any arrow key × 1 | — | `keplerian_orbit` | "Good. Use arrow keys to look around. Those contacts out there — that's your job." |
| `awareness_beauty` | Admire the View | 5 seconds without input after game start | `score-group` | — | "Telemetry is live, Cowboy. Welcome to Low Earth Orbit." |
| `awareness_mouse_look` | Mouse Camera | Mouse drag on scene | — | — | — (silent — too minor for comms) |

**Design note:** `awareness_beauty` is the only time-based skill. It fires automatically to establish the "beauty moment" — the player's first seconds in orbit. This is equivalent to the current BEAUTY stage but doesn't *gate* anything.

#### Tier 2: Sensing (Information Gathering)

| Skill ID | Name | Trigger | HUD Group Activated | Codex Entry | Houston Message |
|----------|------|---------|-------------------|-------------|-----------------|
| `sensing_scan` | Quick Scan | Press S key | `target-list` | — | "Scan complete. Contacts on your target list." |
| `sensing_deep_scan` | Deep Scan | Press W key | `target-list` | — | "Wide aperture scan initiated. Deeper analysis takes longer but finds more." |
| `sensing_target` | Target Lock | Press Tab key | `target-detail` | `delta_v` | "Target locked. Now you can see what you're dealing with." |
| `sensing_analyze` | Structural Analysis | Press Z key | — | — | "Wireframe analysis active. Cycle zones with Z to find capture points." |
| `manage_codex` | Tech Library Access | Press L key | — | — | "Tech Library opened. Everything you discover gets logged here." |

#### Tier 3: Navigation (Movement & Camera)

| Skill ID | Name | Trigger | HUD Group Activated | Codex Entry | Houston Message |
|----------|------|---------|-------------------|-------------|-----------------|
| `nav_autopilot` | Autopilot | Press A key (with target) | `fuel-group` | `hohmann_transfer` | "Autopilot engaged. Sit back — orbital mechanics does the work." |
| `nav_autopilot_no_target` | Autopilot (No Target) | Press A key (no target) | — | — | "Autopilot needs a target. Press Tab to select one first." |
| `nav_camera` | Camera Cycling | Press V key | — | — | "Camera view changed. Cycle through views with V." |
| `nav_throttle` | Throttle Control | Press +/- keys | — | — | "Throttle adjusted. Fine-tune your burn intensity." |
| `nav_manual_thrust` | Manual Thrust | Arrow key during autopilot (disengage) | — | `prograde_paradox` | "Manual override. Remember — in orbit, thrusting forward makes you go higher, not faster." |

**Important edge case:** `nav_autopilot_no_target` is a "soft failure" skill — the player tried something before having the prerequisite context (a target). The system rewards the *attempt* with a helpful hint rather than ignoring the input. This is key to the philosophy: there are no wrong buttons, only teaching moments.

#### Tier 4: Collection (Catching Debris)

| Skill ID | Name | Trigger | HUD Group Activated | Codex Entry | Houston Message |
|----------|------|---------|-------------------|-------------|-----------------|
| `collect_lasso` | Lasso Cast | Press Space (lasso fires) | — | `kessler_syndrome` | "Lasso deployed! Aim for close-range targets." |
| `collect_lasso_miss` | Lasso Miss Recovery | Space pressed, lasso misses | — | — | "Missed! Get closer and try again. Watch the range indicator." |
| `collect_lasso_catch` | First Catch! | Lasso captures debris | — | — | "First catch confirmed! Welcome to the cleanup crew, Cowboy." |
| `collect_deploy` | Tool Deploy | Press D key | `arms-group` | `feep_thruster` | "Tool deployed. The right tool for the right job." |
| `collect_arm_catch` | Arm Capture | Arm captures debris | `cargo-group` | `space_tether` | "Arm capture confirmed. Reeling in the catch." |

#### Tier 5: Economy (Resource Management)

| Skill ID | Name | Trigger | HUD Group Activated | Codex Entry | Houston Message |
|----------|------|---------|-------------------|-------------|-----------------|
| `econ_salvage` | Salvage Stowed | `CARGO_STORE` event | `cargo-group` | `space_aluminum` | "Good salvage, Cowboy. Metals stowed in cargo hold." |
| `econ_forge` | Forge Operation | Press R key | — | — | "Forge loaded. Orbital metallurgy — turning space junk into resources." |
| `econ_fuel_cycle` | Fuel Cycling | Press T key | — | `specific_impulse_explained` | "Propellant type changed. Different fuels trade thrust for efficiency." |
| `econ_shop` | Shop Access | Press B key (in orbital view) | — | — | "Supply depot opened. Spend wisely — every upgrade changes the mission." |

#### Tier 6: Mastery (Advanced Techniques)

| Skill ID | Name | Trigger | HUD Group Activated | Codex Entry | Houston Message |
|----------|------|---------|-------------------|-------------|-----------------|
| `mastery_tool_cycle` | Tool Cycling | Press ` (backtick) | — | — | "Tools cycled. Match the tool to the target — Spinners for small, Weavers for big." |
| `mastery_power_mgmt` | Power Management | Press Shift+1/2/3 | `power-group` `thermal-group` | `power_bus_management` | "Power bus selected. Every watt is a decision." |
| `mastery_arm_pilot` | Arm Piloting | Press P or 1-6 key | — | — | "ARM PILOT engaged. You're flying the daughter now." |
| `mastery_arm_manual` | Manual WASD in Arm | WASD while arm pilot active | — | — | "Manual thrust on daughter arm. Gentle inputs — FEEP thrusters are precise." |
| `mastery_detach` | Tether Detach | Press X key | — | — | "Tether severed. Bold move, Cowboy. That arm's on its own." |
| `mastery_edt` | EDT Deploy | Press Y key | — | `edt_propulsion` | "Electrodynamic tether deployed. Free thrust from Earth's magnetic field." |
| `mastery_comms` | Comms Menu | Press C key | — | — | "Comms channel open. Use number keys to issue commands." |
| `mastery_navsphere` | NavSphere Toggle | Press N key | — | — | "NavSphere activated. Your 3D radar — vertical stalks show altitude offset." |
| `mastery_orbit_mfd` | Orbit MFD | Press M key | — | — | "Orbit display opened. Plan your transfers visually." |
| `mastery_trawl` | Trawl Deploy | Press Shift+G | — | `orbital_inclination` | "Trawl net deployed. Cast wide, catch many." |
| `mastery_dual_fire` | Dual Fire | Dual fire event | — | `recoil_cancellation` | "Dual fire! Equal and opposite — Newton would approve." |

### 2.2 Skill Count Summary

| Tier | Count | Notes |
|------|-------|-------|
| Awareness | 4 | Passive, effortless |
| Sensing | 5 | Active information gathering |
| Navigation | 5 | Movement and camera |
| Collection | 5 | Core gameplay |
| Economy | 4 | Resource management |
| Mastery | 11 | Advanced techniques |
| **Total** | **34** | Broad and shallow — most discoverable in first session |

### 2.3 Skill State Machine

Each skill progresses through states:

```
UNDISCOVERED ──[trigger]──→ DISCOVERED ──[repeated use]──→ PRACTICED ──[time+use]──→ MASTERED
     │                          │                              │                        │
     │ (not visible in UI)      │ (pane popup + comms)         │ (no popup)             │ (permanent)
     │                          │ (spaced reminders begin)     │ (reminders fade)       │ (no reminders)
     └──────────────────────────┴──────────────────────────────┴────────────────────────┘
```

**State definitions:**

| State | Meaning | UI Signal | Reminder Behavior |
|-------|---------|-----------|-------------------|
| `UNDISCOVERED` | Player hasn't triggered this skill | Not shown in pane | N/A |
| `DISCOVERED` | First trigger occurred | Pane popup, HUD group activates | Active reminders via spaced repetition |
| `PRACTICED` | Used N times (skill-specific threshold) | Checkmark in pane | Fewer, spaced reminders |
| `MASTERED` | Used consistently over time | Gold star in pane | No reminders |

**Transition thresholds (configurable per skill):**

```javascript
const SKILL_THRESHOLDS = {
  // DISCOVERED → PRACTICED: number of uses
  practiceCount: {
    default: 5,
    sensing_scan: 3,        // scans are quick, lower bar
    collect_lasso_catch: 3, // catches are significant
    mastery_arm_pilot: 2,   // complex skill, lower bar
  },
  // PRACTICED → MASTERED: total uses AND minimum time since discovery (seconds)
  masteryCount: {
    default: 20,
    collect_lasso_catch: 10,
  },
  masteryMinTime: {
    default: 300,  // 5 minutes minimum before mastery
  },
};
```

---

## 3. Skill Discovery Mechanics

### 3.1 "Any First Interaction = Reward" — Technical Implementation

The core mechanic: **every first-time input produces positive feedback**, even if the action "fails" in gameplay terms.

**Event flow:**

```
Player presses key
    → InputManager emits game event (SCAN_QUICK, AUTOPILOT_ENGAGE, etc.)
    → InputManager ALSO emits SKILL_INPUT event { inputType, context }
    → SkillsSystem._onSkillInput() checks:
        1. Is this input mapped to a skill?
        2. Is the skill UNDISCOVERED?
        3. Are any soft prerequisites met? (see §3.3)
        → YES: trigger discovery
        → NO (already discovered): increment use count, check state transitions
```

**Key principle:** The `SKILL_INPUT` event fires *regardless* of whether the gameplay action succeeds. If the player presses A with no target, the autopilot doesn't engage — but the skills system still registers `nav_autopilot_no_target` and provides helpful feedback.

### 3.2 Input-to-Skill Mapping

```javascript
const INPUT_SKILL_MAP = {
  // Key-based triggers (from InputManager keydown events)
  'ArrowUp':    'awareness_look',
  'ArrowDown':  'awareness_look',
  'ArrowLeft':  'awareness_look',
  'ArrowRight': 'awareness_look',
  'KeyS':       'sensing_scan',
  'KeyW':       'sensing_deep_scan',
  'Tab':        'sensing_target',
  'KeyZ':       'sensing_analyze',
  'KeyL':       'manage_codex',
  'KeyA':       { default: 'nav_autopilot', noTarget: 'nav_autopilot_no_target' },
  'KeyV':       'nav_camera',
  'Equal':      'nav_throttle',
  'Minus':      'nav_throttle',
  'Space':      'collect_lasso',
  'KeyD':       'collect_deploy',
  'KeyR':       'econ_forge',
  'KeyT':       'econ_fuel_cycle',
  'KeyB':       'econ_shop',
  'Backquote':  'mastery_tool_cycle',
  'KeyP':       'mastery_arm_pilot',
  'KeyC':       'mastery_comms',
  'KeyN':       'mastery_navsphere',
  'KeyM':       'mastery_orbit_mfd',
  'KeyX':       'mastery_detach',
  'KeyY':       'mastery_edt',
  'KeyG':       { default: null, shift: 'mastery_trawl' },

  // Event-based triggers (from EventBus, not keydown)
  'LASSO_CAPTURED':     'collect_lasso_catch',
  'LASSO_MISSED':       'collect_lasso_miss',
  'ARM_CAPTURED':       'collect_arm_catch',
  'CARGO_STORE':        'econ_salvage',
  'DUAL_FIRE':          'mastery_dual_fire',
  'ARM_MANUAL_THRUST':  'mastery_arm_manual',
  'SCROLL_WHEEL':       'awareness_zoom',
  
  // Time-based triggers
  'BEAUTY_TIMER':       'awareness_beauty',  // 5s after ORBITAL_VIEW
};
```

### 3.3 Soft Prerequisites (Contextual Guidance, Not Hard Gates)

Some skills need context to be meaningful. Instead of *preventing* discovery, the system provides **contextual guidance** when a skill is attempted without its prerequisite.

| Skill | Prerequisite Context | If Missing | Feedback |
|-------|---------------------|------------|----------|
| `nav_autopilot` | Active target selected | No target | Discovers `nav_autopilot_no_target` instead: "Autopilot needs a target. Press Tab to select one." |
| `collect_lasso` | In gameplay state | Not in gameplay | No feedback (key suppressed by InputManager) |
| `collect_deploy` | In gameplay state | Not in gameplay | No feedback |
| `collect_lasso_catch` | Lasso hit a target | Lasso missed | Discovers `collect_lasso_miss` first |
| `mastery_arm_manual` | Arm pilot mode active | Not in arm pilot | WASD does nothing (no confusing feedback) |
| `mastery_detach` | Deployed arm exists | No arms deployed | "No arm available for detach." (existing behavior in InputManager) |

**No skill is ever blocked.** The system discovers "attempt" skills (like `nav_autopilot_no_target`) to reward the attempt and teach what's missing. This converts frustrating "nothing happened" moments into teaching moments.

### 3.4 Out-of-Order Discovery

The system handles out-of-order discovery naturally because there are no hard dependencies:

**Scenario: Player presses S (scan) before using arrow keys**

```
1. SCAN_QUICK event fires
2. SkillsSystem discovers 'sensing_scan'
3. HUD group 'target-list' activates (was dormant)
4. Houston: "Scan complete. Contacts on your target list."
5. Codex: no codex entry for scan (optional)
6. Skills pane briefly flashes showing new skill
```

The `awareness_look` skill remains UNDISCOVERED — no penalty. When the player eventually presses an arrow key, they'll discover it then and get appropriate feedback.

**Scenario: Player presses Tab before scanning**

```
1. TUTORIAL_TAB_INPUT event fires
2. SkillsSystem notes: target list might be empty (no scan yet)
3. Discovers 'sensing_target' anyway
4. HUD group 'target-detail' activates
5. If no targets exist: Houston gives hint: "No contacts detected. Try pressing S to scan first."
6. If targets exist (from auto-populated list): normal target lock
```

### 3.5 Compound Skills (Multiple Requirements)

Some skills require multiple inputs to "fully" discover:

| Skill | Full Discovery | Partial Award |
|-------|---------------|---------------|
| `nav_autopilot` | A key + target selected + autopilot actually engages | A key with no target → `nav_autopilot_no_target` |
| `collect_lasso_catch` | Space + lasso hits target | Space fires lasso but misses → `collect_lasso_miss` |
| `mastery_arm_pilot` | P key or 1-6 key + arm enters pilot mode | P key but no arms deployed → helpful message only (no skill awarded) |

**Design decision:** Compound skills award partial credit for the attempt. The player has to complete the full action at least once for the primary skill, but partial attempts are recognized as separate "attempt" skills to prevent the "I pressed the button and nothing happened" frustration.

---

## 4. Skills Pane UI Design

### 4.1 Visual Design

The Skills Pane is a **contextual overlay** — not always visible. It appears briefly when a new skill is discovered, and can be opened on demand.

```
┌──────────────────────────────────────┐
│  ▸ SKILLS                     [14/34] │
│  ─────────────────────────────────── │
│                                       │
│  AWARENESS          ●●●○             │
│  Look Around ✓  Zoom ✓  Beauty ✓     │
│                                       │
│  SENSING            ●●○○○            │
│  Quick Scan ✓  Target Lock ✓         │
│                                       │
│  NAVIGATION         ●○○○○            │
│  Autopilot ✓                          │
│                                       │
│  COLLECTION         ●●●○○            │
│  Lasso ✓  First Catch! ★  Deploy ✓   │
│                                       │
│  ECONOMY            ○○○○             │
│  (undiscovered)                       │
│                                       │
│  MASTERY            ●●○○○○○○○○○      │
│  Tool Cycle ✓  Comms ✓               │
│                                       │
└──────────────────────────────────────┘
```

**Visual language:**

| Element | Meaning |
|---------|---------|
| `○` | Undiscovered skill in tier (count shown, not names) |
| `●` | Discovered skill |
| `✓` | Practiced skill |
| `★` | Mastered skill |
| Amber text (`#f5a623`) | Skill name (matches existing HUD palette) |
| Green glow (`#00ff88`) | Just-discovered skill (fades after 3s) |
| Dormant (`opacity: 0.3`) | Undiscovered tier |

### 4.2 Positioning & Behavior

| Property | Value | Rationale |
|----------|-------|-----------|
| Position | Bottom-right, above comms panel | Near existing tutorial prompt location [`_promptEl`](js/systems/TutorialSystem.js:83) |
| Max width | 280px | Matches right column width in [`HUD.js`](js/ui/HUD.js:129) |
| Z-index | 200 | Same as current tutorial prompt |
| Background | `rgba(0,0,0,0.8)` with `border: 1px solid rgba(245,166,35,0.3)` | Matches existing HUD panel style |
| Font | `'Courier New', monospace, 12px` | Consistent with HUD |

**Appearance triggers:**

1. **New skill discovered** → Pane slides in, shows for 4 seconds, fades out
2. **Player presses a "skills" key** (proposal: hold `?` or `I`) → Pane toggles on/off 
3. **First 3 skills** → Pane stays visible for 8 seconds (longer at start)
4. **All skills in a tier discovered** → Pane flashes tier name with celebration color

**Disappearance:**
- Auto-fades after display duration
- Any gameplay input (arrows, WASD, space) during fade → immediate hide (don't obstruct)
- ESC → immediate hide

### 4.3 New Skill Discovery Animation

When a skill is first discovered:

```
1. Brief screen-edge glow (subtle amber, 150ms — like catch flash but amber/gold)
2. Skills pane slides in from right edge (200ms ease-out)
3. New skill name pulses with green glow (#00ff88, 2 pulses)
4. Tier progress dots update
5. Houston comms message plays (independent of pane)
6. Pane holds for 4s, then fades out (800ms)
```

**For the very first skill:** An additional "NEW SKILL" header appears above the pane with a brief explanation:

```
┌──────────────────────────────────────┐
│  ✦ NEW SKILL DISCOVERED              │
│  Your abilities are tracked here.    │
│  ─────────────────────────────────── │
│  SENSING            ●○○○○            │
│  Quick Scan ✓                        │
└──────────────────────────────────────┘
```

This header only appears once (first skill ever discovered). After that, the pane shows without the explanatory text.

### 4.4 Interaction with HUD Progressive Luminance

The Skills Pane and HUD luminance are driven by the **same skill state**:

```
Skill discovered → SkillsSystem emits SKILL_DISCOVERED { skillId, hudGroup }
    → HUD.setSkillVisibility() activates the hudGroup
    → SkillsPane.showDiscovery() displays the pane animation
```

The existing [`setTutorialVisibility()`](js/ui/HUD.js:334) method is refactored into `setSkillVisibility()` that accepts a set of active HUD groups instead of a linear stage number.

### 4.5 Mobile/Responsive Considerations

The game is primarily desktop web, but the pane should degrade gracefully:

- **Small screens (< 768px):** Pane shows as a thin bottom banner instead of right-side overlay
- **Touch devices:** No keyboard skills; touch-based skill equivalents (tap = scan, drag = look, etc.) would need separate mapping (out of scope for Phase 1)
- **Pane never overlaps** the right column (wireframe + target list) — positions adjust based on HUD layout

---

## 5. Feedback & Reward Theory

### 5.1 Variable Ratio Reinforcement (Early Game)

**Theory:** B.F. Skinner demonstrated that variable ratio reinforcement schedules (reward after an unpredictable number of responses) produce the highest, most consistent response rates. Contrast with fixed ratio (reward after exactly N responses) which produces post-reinforcement pauses.

**Application to skill discovery:**

The first ~10 skills are where variable ratio matters most. The player is exploring, pressing random keys, discovering what things do. We want to ensure that **no matter which keys they press, they get rewarded quickly** — but not on an exactly predictable schedule.

**Implementation:**

```javascript
// Feedback intensity varies semi-randomly for the first N discoveries
const EARLY_DISCOVERY_COUNT = 10;

function getFeedbackIntensity(discoveryIndex) {
  if (discoveryIndex >= EARLY_DISCOVERY_COUNT) return 'standard';
  
  // Variable ratio: 70% standard, 20% enhanced, 10% celebration
  const roll = Math.random();
  if (roll < 0.10) return 'celebration';  // Big: screen glow + sound + longer pane
  if (roll < 0.30) return 'enhanced';     // Medium: screen glow + sound
  return 'standard';                       // Normal: pane + comms
}
```

**Feedback levels:**

| Level | Visual | Audio | Duration | When |
|-------|--------|-------|----------|------|
| `standard` | Pane popup + comms message | Click sound (existing) | 4s | Most discoveries |
| `enhanced` | Pane + subtle amber screen-edge glow | Click + soft chime | 5s | ~20% of early discoveries |
| `celebration` | Pane + bright glow + floating text "NEW SKILL" | Click + ascending tone | 6s | ~10% of early discoveries, always for first catch |

**Why variable ratio works here:** The player can't predict which key press will produce the "big" feedback. This creates a sense of exploration-as-slot-machine — every new key *might* produce a celebration. Once the player has found ~10 skills, the novelty dopamine is replaced by competence motivation, and feedback normalizes.

**Override:** Certain milestones always get `celebration` level regardless of roll:
- `collect_lasso_catch` (first catch — always a big moment)
- `awareness_beauty` (first seconds in space — wonder moment)
- All skills in a tier completed (tier completion)

### 5.2 Spaced Repetition (Ongoing Learning)

**Theory:** The Ebbinghaus forgetting curve shows that newly learned information decays exponentially without review. Spaced repetition systems (Leitner, SM-2) optimize review intervals to maintain retention with minimum effort.

**Application:** After a skill is DISCOVERED but before it's MASTERED, the system occasionally shows reminders. The interval between reminders *increases* with each successful use.

**Algorithm (simplified SM-2 variant):**

```javascript
class SkillReminder {
  constructor() {
    this.interval = 120;      // seconds until next reminder (starts at 2 min)
    this.easeFactor = 2.5;    // how fast interval grows (SM-2 default)
    this.lastReminded = 0;    // timestamp of last reminder
    this.lastUsed = 0;        // timestamp of last use
  }
  
  /**
   * Called when the skill is used. Increases interval (the player remembers).
   */
  onUse(now) {
    this.lastUsed = now;
    // If used before reminder was needed, they remembered — stretch interval
    if (now < this.lastReminded + this.interval * 1000) {
      this.interval = Math.min(this.interval * this.easeFactor, 86400); // cap at 24h
      this.easeFactor = Math.min(this.easeFactor + 0.1, 3.0); // gets easier
    }
  }
  
  /**
   * Called every update. Returns true if a reminder should show.
   */
  shouldRemind(now) {
    if (now - this.lastUsed < this.interval * 1000) return false; // used recently
    if (now - this.lastReminded < this.interval * 1000) return false; // reminded recently
    return true;
  }
  
  /**
   * Called when reminder is shown.
   */
  onRemind(now) {
    this.lastReminded = now;
    // If player needed a reminder, shrink interval
    this.interval = Math.max(this.interval / this.easeFactor, 30); // min 30s
    this.easeFactor = Math.max(this.easeFactor - 0.1, 1.5);
  }
}
```

**Reminder format:** Same as existing [`showPrompt()`](js/systems/TutorialSystem.js:356) — brief text at bottom-right that fades:

```
[S] Scan — find targets nearby
```

**Reminder rules:**
- Max 1 reminder visible at a time
- Never during active combat/capture (check game state)
- Never if player is clearly busy (autopilot engaged, arm pilot mode)
- Stop reminding once skill reaches MASTERED
- Reminders are SHORT (one line) and use the existing prompt style

### 5.3 Flow State Protection

**Theory:** Csikszentmihalyi's flow state requires a balance between challenge and skill. Interruptions destroy flow. The skills system must avoid becoming an interruption engine.

**Flow protection rules:**

1. **Suppression during action:** When the player is in a capture sequence (arm approaching, lasso deployed, autopilot final approach), suppress all pane popups and reminders. Queue them for after the action resolves.

2. **Cooldown between discoveries:** Minimum 3 seconds between skill discovery popups. If two skills are discovered within 3s (e.g., both scan and target lock), queue the second.

3. **Fade on input:** Any gameplay input during a pane display → begin fade immediately. Don't force the player to wait.

4. **Frequency cap:** Maximum 3 reminders per 5 minutes. If more are queued, defer.

5. **Audio restraint:** Discovery sounds are **ambient** (soft chimes), not attention-grabbing alarms. They should blend with the existing soundscape, not interrupt it.

### 5.4 Avoiding Annoyance for Experienced Players

**Problem:** Veterans who know the game don't need encouragement for pressing S. How do we avoid being patronizing?

**Solutions:**

1. **Fast mastery path:** If a veteran blitzes through 20 skills in 5 minutes, the system recognizes this pace and switches to "expert mode" — minimal feedback, no reminders, just quiet pane updates.

```javascript
const BLITZ_THRESHOLD = 15;     // skills discovered
const BLITZ_WINDOW = 300;       // within 5 minutes
const isBlitzing = (discoveredCount, elapsed) => 
  discoveredCount >= BLITZ_THRESHOLD && elapsed < BLITZ_WINDOW;
```

2. **Persistence-based detection:** If save data exists, pre-populate skills as MASTERED (see §8.2).

3. **Reduced feedback for PRACTICED/MASTERED skills:** Once a skill is practiced, its reminder text is shorter and less frequent. Mastered skills never remind.

4. **No "tutorial mode" flag:** There's no binary "tutorial active" state. The system behavior is purely a function of individual skill states. A veteran with all skills mastered sees zero feedback.

### 5.5 Integration with Existing Comms System

Houston messages serve as the primary feedback channel, maintaining immersion:

**Tone guidelines (matching existing [`CommsSystem`](js/systems/CommsSystem.js) style):**
- **Tier 1-2 (Awareness/Sensing):** Instructional but encouraging. "Good. Now try..." tone.
- **Tier 3-4 (Navigation/Collection):** Operational. "Autopilot engaged." Mission control brevity.
- **Tier 5 (Economy):** Informational. "Metals stowed in cargo hold."
- **Tier 6 (Mastery):** Respectful. Brief. "Power bus selected." No hand-holding.

**Comms priority:** Skill discovery messages use `priority: 'tutorial'` (matching current system). This means they queue behind CRITICAL and WARNING messages — if a conjunction alert fires during a skill discovery, the alert takes priority.

**Duplicate suppression:** Each Houston message associated with a skill fires **once per session** (once ever if the skill reaches MASTERED and is restored from save). The `commsShown` flag is stored per skill.

---

## 6. Technical Architecture

### 6.1 System Class Design

```
SkillsSystem (replaces TutorialSystem)
├── SkillState              — Individual skill tracking
├── SkillReminder           — Spaced repetition per skill
├── SkillsPaneUI            — DOM overlay (replaces _createUI)
├── SkillFeedback           — Visual/audio feedback orchestration
└── SkillHUDBridge          — Drives HUD progressive luminance
```

**File structure:**

```
js/systems/SkillsSystem.js      — Core system (replaces TutorialSystem.js)
js/ui/SkillsPane.js             — Skills pane DOM component
```

Two files only. The SkillsSystem is the orchestrator; the SkillsPane handles DOM. This matches the existing pattern where [`TutorialSystem.js`](js/systems/TutorialSystem.js) owns both logic and a `_createUI()` method, but we separate the UI into its own module for clarity.

### 6.2 SkillsSystem Class API

```javascript
export class SkillsSystem {
  constructor() {
    /** @type {Map<string, SkillState>} All skills by ID */
    this.skills = new Map();
    
    /** @type {number} Total discoveries in this session */
    this.discoveryCount = 0;
    
    /** @type {number} Timestamp of first discovery (for blitz detection) */
    this.firstDiscoveryTime = 0;
    
    /** @type {Array<string>} Queue of pending discovery popups */
    this._discoveryQueue = [];
    
    /** @type {number} Cooldown timer for discovery popups */
    this._discoveryCooldown = 0;
    
    /** @type {SkillsPane} UI component */
    this._pane = null;
    
    /** @type {Array<{event, handler}>} Registered listeners for cleanup */
    this._listeners = [];
    
    this._initSkills();
    this._createUI();
    this._setupListeners();
  }
  
  // --- Public API ---
  
  /** @returns {string} Skill state: 'UNDISCOVERED'|'DISCOVERED'|'PRACTICED'|'MASTERED' */
  getSkillState(skillId) {}
  
  /** @returns {boolean} Whether the skill has been discovered (any state past UNDISCOVERED) */
  hasDiscovered(skillId) {}
  
  /** @returns {Set<string>} All active HUD groups based on discovered skills */
  getActiveHUDGroups() {}
  
  /** @returns {number} Count of discovered skills */
  getDiscoveredCount() {}
  
  /** @returns {object} Serializable state for persistence */
  getState() {}
  
  /** Restore from saved state */
  restore(data) {}
  
  /** Per-frame update (reminders, cooldowns) */
  update(dt) {}
  
  /** Clean up DOM + listeners */
  dispose() {}
  
  /** Reset all skills to UNDISCOVERED (new game) */
  reset() {}
  
  // --- Internal ---
  
  /** @private Process a skill input event */
  _onSkillInput(skillId, context) {}
  
  /** @private Discover a skill (first trigger) */
  _discoverSkill(skillId) {}
  
  /** @private Show next queued discovery popup */
  _processDiscoveryQueue() {}
  
  /** @private Check if a reminder should show */
  _checkReminders(now) {}
}
```

### 6.3 SkillState Data Structure

```javascript
class SkillState {
  constructor(definition) {
    /** @type {string} Skill ID */
    this.id = definition.id;
    
    /** @type {string} Display name */
    this.name = definition.name;
    
    /** @type {string} Tier: 'awareness'|'sensing'|'navigation'|'collection'|'economy'|'mastery' */
    this.tier = definition.tier;
    
    /** @type {string} Current state */
    this.state = 'UNDISCOVERED'; // 'UNDISCOVERED'|'DISCOVERED'|'PRACTICED'|'MASTERED'
    
    /** @type {string|null} HUD group to activate on discovery */
    this.hudGroup = definition.hudGroup || null;
    
    /** @type {string|null} Codex entry to unlock on discovery */
    this.codexEntry = definition.codexEntry || null;
    
    /** @type {string|null} Houston comms message on discovery */
    this.commsMessage = definition.commsMessage || null;
    
    /** @type {string|null} Short reminder text for spaced repetition */
    this.reminderText = definition.reminderText || null;
    
    /** @type {number} Times this skill has been used */
    this.useCount = 0;
    
    /** @type {number} Timestamp of first discovery (ms) */
    this.discoveredAt = 0;
    
    /** @type {number} Timestamp of last use (ms) */
    this.lastUsedAt = 0;
    
    /** @type {boolean} Whether comms message has been shown this session */
    this.commsShown = false;
    
    /** @type {SkillReminder} Spaced repetition tracker */
    this.reminder = new SkillReminder();
    
    /** @type {number} Practice threshold (uses to reach PRACTICED) */
    this.practiceThreshold = definition.practiceThreshold || 5;
    
    /** @type {number} Mastery threshold (uses to reach MASTERED) */
    this.masteryThreshold = definition.masteryThreshold || 20;
    
    /** @type {number} Minimum time after discovery before mastery (ms) */
    this.masteryMinTime = definition.masteryMinTime || 300000;
  }
}
```

### 6.4 Event Flow

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ InputManager │────→│ SkillsSystem │────→│  SkillsPane  │     │     HUD      │
│ (key press)  │     │  (check/     │     │  (UI popup)  │     │  (luminance) │
│              │     │   discover)  │     │              │     │              │
└─────────────┘     └──────┬───────┘     └──────────────┘     └──────┬───────┘
                           │                                         │
                    ┌──────┴───────┐                                 │
                    │   EventBus   │─────────────────────────────────┘
                    │              │
                    │ SKILL_DISCOVERED { skillId, hudGroup }
                    │ SKILL_PRACTICED  { skillId }
                    │ SKILL_MASTERED   { skillId }
                    │ SKILL_REMINDER   { skillId, text }
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │ CodexSystem  │
                    │ (unlock entry)│
                    └──────────────┘
```

**New events to add to [`Events.js`](js/core/Events.js):**

```javascript
// === SKILLS (replaces TUTORIAL) ===
SKILL_DISCOVERED:       'skill:discovered',       // { skillId, tier, hudGroup, name }
SKILL_PRACTICED:        'skill:practiced',         // { skillId }
SKILL_MASTERED:         'skill:mastered',          // { skillId }
SKILL_REMINDER:         'skill:reminder',          // { skillId, text }
SKILL_STATE_CHANGED:    'skill:stateChanged',      // { activeGroups: Set } — replaces TUTORIAL_STAGE_CHANGED
SKILL_ALL_DISCOVERED:   'skill:allDiscovered',     // {} — all 34 skills found
```

**Backward compatibility:** During migration, `TUTORIAL_STAGE_CHANGED` is emitted alongside `SKILL_STATE_CHANGED` with a computed "equivalent stage number" so that any systems still listening on the old event continue to work. This is a **temporary bridge** removed in Phase 4.

### 6.5 Integration with Existing Systems

#### HUD Integration

[`HUD.js`](js/ui/HUD.js:334) currently listens to `TUTORIAL_STAGE_CHANGED` and maps stage numbers to HUD group activation. The new system replaces this with `SKILL_STATE_CHANGED` carrying a Set of active group names:

```javascript
// In HUD._setupEventListeners()
eventBus.on(Events.SKILL_STATE_CHANGED, ({ activeGroups }) => {
  this.setSkillVisibility(activeGroups);
});

// New method replacing setTutorialVisibility
setSkillVisibility(activeGroups) {
  const allGroups = [
    'score-group', 'target-list', 'target-detail',
    'fuel-group', 'arms-group', 'power-group',
    'thermal-group', 'cargo-group'
  ];
  for (const group of allGroups) {
    const active = activeGroups.has(group);
    const els = this.container.querySelectorAll(`[data-hud-group="${group}"]`);
    els.forEach(el => {
      el.classList.toggle('hud-dormant', !active);
      el.classList.toggle('hud-active', active);
    });
  }
}
```

#### CodexSystem Integration

[`CodexSystem.js`](js/systems/CodexSystem.js:1407) already listens to `CODEX_UNLOCK_REQUEST`. The SkillsSystem emits this when a skill with a codex entry is discovered:

```javascript
// In SkillsSystem._discoverSkill()
if (skill.codexEntry) {
  eventBus.emit(Events.CODEX_UNLOCK_REQUEST, { id: skill.codexEntry });
}
```

This replaces [`_unlockCodexForCompletedStage()`](js/systems/TutorialSystem.js:434) cleanly.

#### InputManager Integration

[`InputManager.js`](js/systems/InputManager.js) currently emits `TUTORIAL_ARROW_INPUT`, `TUTORIAL_SCAN_INPUT`, etc. These are renamed to generic `SKILL_INPUT` events or the SkillsSystem listens to the **existing** gameplay events directly:

**Preferred approach (minimal InputManager changes):** The SkillsSystem listens to the existing `TUTORIAL_*` events AND direct gameplay events (`SCAN_QUICK`, `AUTOPILOT_ENGAGE`, etc.). No new events need to be emitted from InputManager — the SkillsSystem observes what's already being emitted.

```javascript
// SkillsSystem._setupListeners() — listens to EXISTING events
eventBus.on(Events.TUTORIAL_ARROW_INPUT, () => this._onSkillInput('awareness_look'));
eventBus.on(Events.TUTORIAL_SCAN_INPUT, () => this._onSkillInput('sensing_scan'));
eventBus.on(Events.TUTORIAL_TAB_INPUT, () => this._onSkillInput('sensing_target'));
eventBus.on(Events.TUTORIAL_DEPLOY_INPUT, () => this._onSkillInput('collect_deploy'));
eventBus.on(Events.AUTOPILOT_ENGAGE, () => this._onSkillInput('nav_autopilot'));
eventBus.on(Events.LASSO_FIRED, () => this._onSkillInput('collect_lasso'));
eventBus.on(Events.LASSO_CAPTURED, () => this._onSkillInput('collect_lasso_catch'));
eventBus.on(Events.LASSO_MISSED, () => this._onSkillInput('collect_lasso_miss'));
eventBus.on(Events.ARM_CAPTURED, () => this._onSkillInput('collect_arm_catch'));
eventBus.on(Events.CARGO_STORE, () => this._onSkillInput('econ_salvage'));
// ... etc.
```

This approach means **zero changes to InputManager** in Phase 1. The `TUTORIAL_*` event names can be renamed to `SKILL_*` later (Phase 4 cleanup).

#### PersistenceManager Integration

[`PersistenceManager.js`](js/systems/PersistenceManager.js) already has a `subsystemEvents` slot in its save format plus the `PERSISTENCE_GATHER` event pattern. The SkillsSystem adds its state to saves:

```javascript
// In SkillsSystem constructor
eventBus.on(Events.PERSISTENCE_GATHER, (saveData) => {
  saveData.skills = this.getState();
});

// getState() returns:
[
  { id: 'awareness_look', state: 'MASTERED', useCount: 47, discoveredAt: 1713100000000 },
  { id: 'sensing_scan', state: 'PRACTICED', useCount: 12, discoveredAt: 1713100030000 },
  // ... only skills that aren't UNDISCOVERED
]

// restore() called on PERSISTENCE_LOADED:
eventBus.on(Events.PERSISTENCE_LOADED, () => {
  const save = persistenceManager.peek();
  if (save && save.skills) {
    this.restore(save.skills);
  }
});
```

### 6.6 Migration Path from TutorialSystem

**Phase 1 (coexistence):**
- `SkillsSystem` is created alongside `TutorialSystem`
- Both listen to the same events
- `TutorialSystem` is disabled (`this.active = false`) when `SkillsSystem` is present
- `SkillsSystem` emits `TUTORIAL_STAGE_CHANGED` with computed equivalent stage for backward compat

**Phase 2 (gradual removal):**
- Systems that listen to `TUTORIAL_STAGE_CHANGED` are migrated to `SKILL_STATE_CHANGED`
- HUD's [`setTutorialVisibility()`](js/ui/HUD.js:334) is replaced by `setSkillVisibility()`
- TutorialSystem's one-shot economy hints (`_salvageHintShown` etc.) are absorbed into economy skills

**Phase 3 (cleanup):**
- `TutorialSystem.js` is deleted
- `TutorialStage` export is removed from HUD.js import
- `TUTORIAL_*` events renamed to `SKILL_*` in Events.js
- Skip button removed (no longer needed — there's nothing to skip)

### 6.7 What Can Be Reused vs. New

| Component | Reuse | Change | New |
|-----------|-------|--------|-----|
| `_createUI()` prompt element | ✅ Style/positioning | Content driven by skills | — |
| `_setupListeners()` pattern | ✅ Event listener array for cleanup | Different events | — |
| `showPrompt()` / `hidePrompt()` | ✅ Fade in/out mechanics | — | — |
| `_highlightElement()` | ✅ CSS pulsing | — | — |
| `skip()` | ❌ Remove | — | — |
| `advanceTo()` linear progression | ❌ Remove | — | `_discoverSkill()` |
| `_startStage()` switch block | ❌ Remove | — | Skill definition data |
| `_unlockCodexForCompletedStage()` | ✅ Concept | Codex entries in skill defs | — |
| Progressive luminance groups | ✅ CSS classes | Driven by skill set | — |
| Economy one-shot hints | ✅ Concept | Absorbed into skill defs | — |
| `firsts` Set tracking | ✅ Concept | Expanded to full skill map | — |
| `hud-dormant` / `hud-active` CSS | ✅ As-is | — | — |
| Tutorial highlight CSS animation | ✅ As-is | — | — |
| Skip button DOM element | ❌ Remove | — | — |
| — | — | — | Skills pane DOM |
| — | — | — | Spaced repetition logic |
| — | — | — | Variable ratio feedback |
| — | — | — | Skill persistence |

---

## 7. HUD Progressive Unlock Mapping

### 7.1 Skill → HUD Group Mapping

Each skill that activates a HUD group:

| Skill ID | HUD Group Activated | Current Tutorial Stage Equivalent |
|----------|-------------------|----------------------------------|
| `awareness_beauty` | `score-group` | BEAUTY (0) |
| `sensing_scan` | `target-list` | SCAN (2) |
| `sensing_target` | `target-detail` | TARGET_SELECT (3) |
| `nav_autopilot` | `fuel-group` | AUTOPILOT (4) |
| `collect_deploy` | `arms-group` | DEPLOY (7) |
| `collect_arm_catch` | `cargo-group` | DEPLOY (7) |
| `econ_salvage` | `cargo-group` (redundant with above) | FREE_PLAY (9) |
| `mastery_power_mgmt` | `power-group`, `thermal-group` | TOOL_MASTERY (8) |

**Key difference from current system:** Multiple skills can activate the same group. `cargo-group` activates from either `collect_arm_catch` OR `econ_salvage` — whichever happens first. This means the player who scans and catches before ever deploying an arm still sees their cargo panel light up.

### 7.2 Default Visibility (Game Start)

On a fresh game with no skills discovered:

```
score-group:    dormant (0.3 opacity)  — lights up on awareness_beauty (auto, 5s)
target-list:    dormant                — lights up on sensing_scan or sensing_target
target-detail:  dormant                — lights up on sensing_target
fuel-group:     dormant                — lights up on nav_autopilot
arms-group:     dormant                — lights up on collect_deploy
power-group:    dormant                — lights up on mastery_power_mgmt
thermal-group:  dormant                — lights up on mastery_power_mgmt
cargo-group:    dormant                — lights up on collect_arm_catch or econ_salvage
```

**Expected fast path:** A player pressing random keys will likely discover `awareness_beauty` (auto-5s), `awareness_look` (arrows), `sensing_scan` (S), `sensing_target` (Tab) within 30 seconds. This activates `score-group`, `target-list`, and `target-detail` — the same panels that the current tutorial activates in stages 0-3, but without enforcing order.

### 7.3 "All Groups Active" State

When all HUD groups have been activated, the system enters the equivalent of current `FREE_PLAY` — all `hud-dormant`/`hud-active` classes are removed, and camera view controls resume panel visibility as in [`_applyViewConfig()`](js/ui/HUD.js:820).

```javascript
// In SkillsSystem
get allGroupsActive() {
  const required = ['score-group', 'target-list', 'target-detail',
                    'fuel-group', 'arms-group', 'power-group',
                    'thermal-group', 'cargo-group'];
  return required.every(g => this._activeGroups.has(g));
}
```

---

## 8. Edge Cases & Robustness

### 8.1 Player Returns After Days — Spaced Repetition Handling

**Problem:** The spaced repetition algorithm tracks intervals in seconds. If a player leaves for 3 days, all DISCOVERED skills will be "overdue" for reminders.

**Solution: Decay with cap**

```javascript
// On session start, cap the "time since last use" to prevent reminder flood
const MAX_OVERDUE = 600; // 10 minutes max "catchup"

restore(data) {
  const now = Date.now();
  for (const saved of data) {
    const skill = this.skills.get(saved.id);
    if (!skill) continue;
    // ... restore state ...
    // Cap overdue time
    if (skill.state === 'DISCOVERED' || skill.state === 'PRACTICED') {
      const overdue = now - skill.lastUsedAt;
      if (overdue > MAX_OVERDUE * 1000) {
        // Reset reminder to "show once soon, then resume normal schedule"
        skill.reminder.interval = 60; // 1 minute
        skill.reminder.lastReminded = now - 50000; // remind in ~10s
      }
    }
  }
}
```

**Result:** After a long absence, the player gets at most one gentle reminder per recently-discovered skill, spread over the first few minutes. Not a flood.

### 8.2 New Game+ / Reset — Veteran Handling

**Scenario:** Player starts a new game with an existing save.

**Option A (chosen): Fresh skills, fast mastery**
- All skills reset to UNDISCOVERED
- But the `blitzDetection` kicks in immediately — veterans will discover 15+ skills in minutes
- System detects blitz pace and reduces feedback to minimum
- Result: veterans "re-discover" skills with minimal friction, get to full HUD quickly

**Option B (considered, rejected): Pre-populate from save**
- Skills are pre-populated as MASTERED from save data
- Problem: no sense of progression on replay
- Problem: new game feels identical to returning to old save

**Option C (hybrid, future consideration):**
- Offer "Expert Mode" toggle on menu — pre-populates all skills as MASTERED
- Equivalent to current "Skip Tutorial" but without the stigma
- Implementation: `SkillsSystem.setExpertMode()` marks all as MASTERED

### 8.3 Player Discovers Advanced Skills Early

**Scenario:** Player watches a YouTube video, immediately presses Shift+G to deploy a trawl net on their first game.

**This is fine.** The system discovers `mastery_trawl`, shows the skill pane, and activates whatever HUD group it needs. Houston says something helpful. The player has proven they know this exists — reward them.

**The pane does *not* confuse them** because it shows only discovered skills. It doesn't show the full 34-skill tree with locked/unlocked states. You can't see what you haven't found. The pane just shows: "Oh cool, I found Trawl Deploy!" with no implication that they "should have" found other things first.

### 8.4 Performance Impact of Tracking All Interactions

**Concern:** Tracking every keystroke for skill discovery — is there overhead?

**Analysis:**
- The system checks a HashMap lookup (`this.skills.get(skillId)`) on each input event
- HashMap lookup is O(1); 34 skills is trivial
- State transition checks are simple comparisons
- No per-frame iteration over all skills (reminders are checked at 1 Hz, not 60 Hz)
- The existing TutorialSystem does the same thing (listen to events, check stage)

**Verdict:** Negligible performance impact. The existing system already processes every relevant input event. The new system has *more* skills to track but each operation is O(1).

### 8.5 Rapid-Fire Discovery (Many Skills in Seconds)

**Scenario:** Player mashes random keys and discovers 8 skills in 10 seconds.

**Handling:**
1. Discovery queue holds pending popups
2. Minimum 3-second gap between popups
3. If queue exceeds 5, batch remaining into one "multiple skills discovered" notification
4. Houston messages are also queued (existing CommsPanel handles this naturally via display timing)

```javascript
_processDiscoveryQueue() {
  if (this._discoveryQueue.length === 0) return;
  if (this._discoveryCooldown > 0) return;
  
  if (this._discoveryQueue.length > 5) {
    // Batch mode: show summary
    const count = this._discoveryQueue.length;
    this._pane.showBatchDiscovery(this._discoveryQueue);
    this._discoveryQueue = [];
    this._discoveryCooldown = 4; // 4s cooldown
  } else {
    // Normal: show one at a time
    const skillId = this._discoveryQueue.shift();
    this._pane.showDiscovery(this.skills.get(skillId));
    this._discoveryCooldown = 3; // 3s cooldown
  }
}
```

### 8.6 What If All Keys Are Rebound?

The game currently uses fixed key bindings (no rebind system). If a rebind system is added later, the skill trigger would need to be based on *action* rather than *key code*. The current design uses event names (e.g., `SCAN_QUICK`) which are action-level, not key-level. The key-to-skill mapping in §3.2 is used only for direct keydown observation; the EventBus-based triggers are already action-level and would survive rebinding.

### 8.7 Concurrent Systems Issue

**Risk:** If both TutorialSystem and SkillsSystem are active during migration, they might both respond to the same events.

**Mitigation:**
```javascript
// In GameFlowManager or main.js initialization
if (useSkillsSystem) {
  this.skillsSystem = new SkillsSystem();
  this.tutorialSystem = null; // Don't create
} else {
  this.tutorialSystem = new TutorialSystem();
  this.skillsSystem = null;
}
```

Feature flag (`useSkillsSystem`) controls which system is instantiated. Both are never active simultaneously.

---

## 9. Implementation Phases

### Phase 1: Core Skills Tracking + First-Interaction Rewards (MVP)

**Goal:** Replace the linear tutorial with discovery-based skills. Minimum viable product.

**Scope:**
- [ ] Create `SkillsSystem` class with all 34 skill definitions
- [ ] Implement `_onSkillInput()` → `_discoverSkill()` flow
- [ ] Listen to existing EventBus events (zero InputManager changes)
- [ ] Emit `SKILL_DISCOVERED` and `SKILL_STATE_CHANGED` events
- [ ] HUD progressive luminance driven by skill state (refactor `setTutorialVisibility`)
- [ ] Houston comms messages on discovery (reuse existing `COMMS_MESSAGE` pattern)
- [ ] Codex unlock on discovery (reuse existing `CODEX_UNLOCK_REQUEST` pattern)
- [ ] `awareness_beauty` 5-second auto-trigger (replaces BEAUTY stage)
- [ ] Feature flag to switch between TutorialSystem and SkillsSystem
- [ ] Basic contextual prompt for skill reminders (reuse `showPrompt` pattern)
- [ ] `skip()` equivalent: no skip needed, but provide `setExpertMode()` for testing

**NOT in Phase 1:**
- Skills pane UI (feedback is via comms + prompts only)
- Spaced repetition
- Persistence
- Variable ratio reinforcement (all discoveries use standard feedback)

**Estimated effort:** 2-3 focused sessions. ~400 lines of new code.

**Validation:** Play through first 5 minutes. Every key press should produce feedback. HUD should progressively light up in whatever order the player explores. No "nothing happened" moments.

### Phase 2: Skills Pane UI

**Goal:** Visual skills pane that appears on discovery and can be toggled.

**Scope:**
- [ ] Create `SkillsPane` class with DOM generation
- [ ] Tier-based layout with progress dots
- [ ] New skill discovery animation (slide in, glow, auto-fade)
- [ ] "First ever" explanatory header
- [ ] Discovery queue and batch handling (§8.5)
- [ ] Flow protection (suppress during action, fade on input)
- [ ] Toggle key binding (proposal: `I` or `?`)
- [ ] Screen-edge glow effect on discovery (amber, subtle)

**Estimated effort:** 1-2 sessions. ~300 lines of UI code.

**Validation:** Discover 10 skills. Pane appears each time without being annoying. Rapid-fire pressing doesn't cause visual chaos.

### Phase 3: Spaced Repetition + Variable Ratio Feedback

**Goal:** Ongoing learning support for discovered-but-not-mastered skills.

**Scope:**
- [ ] Implement `SkillReminder` class with SM-2 variant algorithm
- [ ] 1 Hz reminder check in `update()` (not per-frame)
- [ ] Reminder format: brief prompt text at bottom-right
- [ ] Frequency cap (max 3 per 5 minutes)
- [ ] Skill state transitions: DISCOVERED → PRACTICED → MASTERED
- [ ] Variable ratio reinforcement for first 10 discoveries
- [ ] Three feedback intensity levels (standard / enhanced / celebration)
- [ ] Audio integration (soft chimes on discovery, existing click sounds)
- [ ] Blitz detection for reduced feedback

**Estimated effort:** 1-2 sessions. ~200 lines of logic.

**Validation:** Play for 20 minutes. Skills that aren't reused get gentle reminders. Skills used frequently stop reminding. Feedback intensity varies pleasantly in early game.

### Phase 4: Persistence, Veteran Handling, Polish

**Goal:** Skills survive across sessions. Veterans see a smooth experience. Cleanup.

**Scope:**
- [ ] `getState()` / `restore()` persistence via PersistenceManager
- [ ] Return-after-absence handling (§8.1)
- [ ] Expert mode toggle on menu screen
- [ ] Remove TutorialSystem.js entirely
- [ ] Remove backward-compat `TUTORIAL_STAGE_CHANGED` emission
- [ ] Rename `TUTORIAL_*` events to `SKILL_*` in Events.js
- [ ] Remove skip button DOM element
- [ ] Update LEARNING_THROUGH_PLAY.md references
- [ ] Update GAME_DESIGN.md references
- [ ] Tier completion celebrations
- [ ] "All skills discovered" celebration + codex entry

**Estimated effort:** 1 session for core, 1 session for cleanup/docs.

**Validation:** Save game, close browser, reopen. Skills are restored. Start new game — all skills are fresh but veteran pace is detected and feedback is minimal.

---

## 10. Open Questions

These are unresolved design questions to be answered during implementation:

### 10.1 Should Undiscovered Skills' Tier Names Be Visible?

**Option A:** Show tier names and empty dots (current design). Player sees "ECONOMY ○○○○" and knows there are 4 skills to find. Creates curiosity/completionism.

**Option B:** Hide entire undiscovered tiers. Player only sees what they've found. Simpler, less overwhelming.

**Recommendation:** Option A — showing tier names is a gentle nudge toward exploration without being prescriptive. The dots say "there's more here" without saying "you must find it."

### 10.2 Should There Be a "Skills" Button on the HUD?

The pane appears contextually. But should there be a persistent small icon/button to open it on demand?

**Arguments for:** Discoverability. Player might want to check progress.
**Arguments against:** HUD clutter. The pane is supposed to be contextual, not a permanent fixture.

**Recommendation:** No persistent button. Toggle via `I` key (info). Add a small tooltip on first discovery: "[I] View Skills". The pane is a reward, not a chore.

### 10.3 How Does This Interact with Future Touch/Mobile Support?

All skill triggers are currently keyboard-based. Touch equivalents would require a separate mapping layer. This is out of scope but the architecture (action-based events, not key-based) supports it.

### 10.4 Should Skills Replace the Existing Skill Progression Table in GAME_DESIGN.md?

The current [GAME_DESIGN.md §5](GAME_DESIGN.md) has a player skill progression table (Newbie → Expert). This table describes *player behavior* at different experience levels. The Skills system tracks *discovered mechanics*. They're complementary:

- Player behavior progression stays in GAME_DESIGN.md
- Skills system tracks mechanic discovery in code
- The two are correlated but not identical (a player can discover all skills but still be a "Learner" in terms of effective play)

### 10.5 What Happens to the Economy One-Shot Hints?

The current TutorialSystem has one-shot flags for salvage, forge, and fuel hints ([`_salvageHintShown`](js/systems/TutorialSystem.js:43), [`_forgeHintShown`](js/systems/TutorialSystem.js:46), [`_fuelHintShown`](js/systems/TutorialSystem.js:48)). These are replaced by:

- `_salvageHintShown` → `econ_salvage` skill discovery
- `_forgeHintShown` → `econ_forge` skill discovery
- `_fuelHintShown` → `econ_fuel_cycle` skill discovery

The comms messages are absorbed into the skill definitions. The delayed timing (e.g., forge hint 12s after first salvage) is handled by the discovery queue cooldown.

### 10.6 How to Handle the "Beauty Moment" Without Blocking?

The current BEAUTY stage blocks all input for 5 seconds, then auto-advances. Is this still desired?

**Recommendation:** Keep the 5-second timer for `awareness_beauty` — it fires automatically. But **don't block input**. If the player presses S during the beauty moment, they get both `awareness_beauty` AND `sensing_scan`. The beauty moment is a *gift* of wonder, not a *gate*.

---

## Appendix A: Learning Theory References

| Theory | Application | Source |
|--------|-------------|--------|
| **Variable ratio reinforcement** | Random feedback intensity for early discoveries | Skinner, B.F. (1938). *The Behavior of Organisms* |
| **Ebbinghaus forgetting curve** | Spaced repetition intervals | Ebbinghaus, H. (1885). *Über das Gedächtnis* |
| **SM-2 algorithm** | Reminder interval calculation | Wozniak, P.A. (1990). SuperMemo algorithm |
| **Flow state** | Suppression of interruptions during action | Csikszentmihalyi, M. (1990). *Flow* |
| **Scaffolding** | Soft prerequisites provide context without gates | Vygotsky, L.S. (1978). *Mind in Society* |
| **Zone of Proximal Development** | Skills just beyond current ability get more feedback | Vygotsky, L.S. (1978) |
| **Self-Determination Theory** | Autonomy (no forced sequence), competence (mastery tracking), relatedness (Houston dialogue) | Deci, E.L. & Ryan, R.M. (1985) |
| **Constructivism** | Player constructs knowledge through exploration, not instruction | Piaget, J. (1936) |

## Appendix B: Full Skill Definition Table

For implementation reference — complete source of truth for all 34 skills:

| # | Skill ID | Tier | Trigger Event | HUD Group | Codex | Practice N | Mastery N | Reminder Text |
|---|----------|------|---------------|-----------|-------|------------|-----------|---------------|
| 1 | `awareness_beauty` | awareness | BEAUTY_TIMER (5s) | `score-group` | — | — | — | — |
| 2 | `awareness_look` | awareness | TUTORIAL_ARROW_INPUT | — | `keplerian_orbit` | 10 | 50 | `← ↑ ↓ → look around` |
| 3 | `awareness_zoom` | awareness | SCROLL_WHEEL | — | — | 5 | 20 | `Scroll to zoom` |
| 4 | `awareness_mouse_look` | awareness | MOUSE_DRAG | — | — | 5 | 20 | — |
| 5 | `sensing_scan` | sensing | TUTORIAL_SCAN_INPUT / SCAN_QUICK | `target-list` | — | 3 | 15 | `[S] Scan for targets` |
| 6 | `sensing_deep_scan` | sensing | SCAN_WIDE | `target-list` | — | 3 | 15 | `[W] Deep scan` |
| 7 | `sensing_target` | sensing | TUTORIAL_TAB_INPUT | `target-detail` | `delta_v` | 5 | 20 | `[TAB] Cycle targets` |
| 8 | `sensing_analyze` | sensing | Z key (wireframe) | — | — | 3 | 15 | `[Z] Structural analysis` |
| 9 | `manage_codex` | manage | L key | — | — | 2 | 10 | `[L] Open tech library` |
| 10 | `nav_autopilot` | navigation | AUTOPILOT_ENGAGE | `fuel-group` | `hohmann_transfer` | 3 | 15 | `[A] Autopilot to target` |
| 11 | `nav_autopilot_no_target` | navigation | A key + no target | — | — | — | — | `Select a target first [TAB]` |
| 12 | `nav_camera` | navigation | V key | — | — | 3 | 15 | `[V] Cycle camera views` |
| 13 | `nav_throttle` | navigation | +/- keys | — | — | 5 | 20 | `[+/-] Adjust throttle` |
| 14 | `nav_manual_thrust` | navigation | Arrow during AP | — | `prograde_paradox` | 5 | 30 | — |
| 15 | `collect_lasso` | collection | LASSO_FIRED | — | `kessler_syndrome` | 5 | 20 | `[SPACE] Cast lasso` |
| 16 | `collect_lasso_miss` | collection | LASSO_MISSED | — | — | — | — | `Get closer to target` |
| 17 | `collect_lasso_catch` | collection | LASSO_CAPTURED | — | — | 3 | 10 | — |
| 18 | `collect_deploy` | collection | TUTORIAL_DEPLOY_INPUT / TOOL_DEPLOY | `arms-group` | `feep_thruster` | 3 | 15 | `[D] Deploy tool` |
| 19 | `collect_arm_catch` | collection | ARM_CAPTURED | `cargo-group` | `space_tether` | 3 | 10 | — |
| 20 | `econ_salvage` | economy | CARGO_STORE | `cargo-group` | `space_aluminum` | 3 | 10 | — |
| 21 | `econ_forge` | economy | FORGE_TOGGLE | — | — | 2 | 10 | `[R] Open forge` |
| 22 | `econ_fuel_cycle` | economy | FUEL_CYCLE | — | `specific_impulse_explained` | 3 | 15 | `[T] Cycle propellant` |
| 23 | `econ_shop` | economy | B key (SHOP state) | — | — | 2 | 10 | `[B] Open supply depot` |
| 24 | `mastery_tool_cycle` | mastery | TOOL_CYCLE | — | — | 5 | 20 | `` [`] Cycle tools `` |
| 25 | `mastery_power_mgmt` | mastery | POWER_BUS_SELECTED | `power-group` `thermal-group` | `power_bus_management` | 3 | 15 | `[Shift+1/2/3] Power buses` |
| 26 | `mastery_arm_pilot` | mastery | ARM_SELECT or P+arm | — | — | 2 | 10 | `[P] or [1-6] Pilot arm` |
| 27 | `mastery_arm_manual` | mastery | ARM_MANUAL_THRUST | — | — | 5 | 20 | `WASD for arm thrust` |
| 28 | `mastery_detach` | mastery | ARM_DETACHED | — | — | 1 | 5 | — |
| 29 | `mastery_edt` | mastery | EDT_DEPLOY | — | `edt_propulsion` | 2 | 10 | `[Y] EDT propulsion` |
| 30 | `mastery_comms` | mastery | C key | — | — | 3 | 15 | `[C] Comms menu` |
| 31 | `mastery_navsphere` | mastery | N key | — | — | 2 | 10 | `[N] NavSphere` |
| 32 | `mastery_orbit_mfd` | mastery | M key | — | — | 2 | 10 | `[M] Orbit display` |
| 33 | `mastery_trawl` | mastery | TRAWL_START | — | `orbital_inclination` | 2 | 10 | `[Shift+G] Deploy trawl` |
| 34 | `mastery_dual_fire` | mastery | DUAL_FIRE | — | `recoil_cancellation` | 2 | 10 | — |

---

*Space Cowboy — Skills Discovery System*
*"Every key press is a reward. Every discovery is a lesson. No gates. No lectures. Just play."*
