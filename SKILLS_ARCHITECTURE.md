# Skills Discovery System — Implementation Architecture

> **Replaces:** Linear 10-stage tutorial (deleted in Sprint 3 ST-3.2)
> **Foundation:** [`SKILLS_SYSTEM_DESIGN.md`](archive/SKILLS_SYSTEM_DESIGN.md) (33-skill inventory, state machine, feedback theory)
> **Philosophy:** Every first interaction is a reward. The Discovery Pane IS the reward. Minimal gates — only for irreversible/destructive actions.
> **Session:** 24 (planned)

---

## Table of Contents

- [A. Skill Tree Design](#a-skill-tree-design)
- [B. Discovery Pane UI Design](#b-discovery-pane-ui-design)
- [C. HUD Progressive Revelation Map](#c-hud-progressive-revelation-map)
- [D. Feedback & Reward Architecture](#d-feedback--reward-architecture)
- [E. Migration Plan: Tutorial → Skills](#e-migration-plan-tutorial--skills)
- [F. Technical Architecture](#f-technical-architecture)
- [G. Implementation Phases](#g-implementation-phases)
- [H. Pre-Implementation Analysis](#h-pre-implementation-analysis--gaps-risks-and-resolutions)

---

## A. Skill Tree Design

### A.1 Design Principles

The skill tree is **broad and shallow** — not a deep tree with unlock chains. Most skills are discoverable in **any order**. The tree is organized into 6 tiers for UI grouping, but tier order is never enforced. A player who presses Shift+G for trawl deploy before ever pressing an arrow key gets rewarded.

**Four dependency categories:**

| Category | Meaning | Example |
|----------|---------|---------|
| **Independent** | Can be discovered at any time, in any order | `awareness_zoom`, `sensing_scan`, `nav_camera` |
| **Soft prerequisite** | Works better after X but isn't blocked — attempt is rewarded with guidance | `nav_autopilot` (needs target → discovers `nav_autopilot_no_target` instead) |
| **Hard prerequisite** | Can't physically happen without prior game state | `collect_arm_catch` requires an arm to be deployed and catch debris |
| **Safety gate** | Action is **irreversible/destructive** — requires demonstrated competence before allowing | `mastery_detach` (severs tether permanently — requires ≥2 catches first) |

**Why safety gates exist:** The "no gates" philosophy applies to *information* and *exploration* — pressing a key should always teach you something. But **irreversible destructive actions** (detaching an arm permanently, deorbiting a daughter) need a competence gate. A newbie randomly pressing X in the first minute shouldn't lose their entire arm fleet. The gate isn't "complete step 7 first" — it's "demonstrate you understand the basics by catching at least 2 targets."

**Safety gate behavior:**
- Pressing a gated key before meeting the requirement emits a **Houston warning**, not silence
- The skill appears in the pane as `🔒` (locked) with a hint about what's needed
- Once the gate condition is met, the skill unlocks silently (no fanfare — it's a safety measure, not a reward)
- The gate check is minimal: a simple count or boolean, not a complex quest chain

### A.2 Complete Skill Inventory (33 Skills)

Adapted from [`SKILLS_SYSTEM_DESIGN.md` §2](archive/SKILLS_SYSTEM_DESIGN.md). Each skill lists its dependency type, trigger, and what it unlocks.

#### Tier 1: Awareness (3 skills — passive discoveries)

| # | Skill ID | Name | Trigger | Dependency | HUD Group | Codex |
|---|----------|------|---------|------------|-----------|-------|
| 1 | `awareness_look` | Look Around | Any arrow key × 1 | **Independent** | — | `keplerian_orbit` |
| 2 | `awareness_zoom` | Zoom Control | Scroll wheel | **Independent** | — | — |
| 3 | `awareness_mouse_look` | Mouse Camera | Mouse drag on scene | **Independent** | — | — |

**Notes:** All Awareness skills are fully independent. `awareness_beauty` was removed in the UX overhaul (2026-04-16) — the score-group HUD panel is now activated by a direct timer in [`GameFlowManager`](js/systems/GameFlowManager.js) (5 seconds after entering ORBITAL_VIEW), not by a skill discovery.

#### Tier 2: Sensing (5 skills — information gathering)

| # | Skill ID | Name | Trigger | Dependency | HUD Group | Codex |
|---|----------|------|---------|------------|-----------|-------|
| 4 | `sensing_scan` | Quick Scan | Press S | **Independent** | `target-list` | — |
| 5 | `sensing_deep_scan` | Deep Scan | Press W | **Independent** | `target-list` | — |
| 6 | `sensing_target` | Target Lock | Press Tab | **Soft**: empty list if no scan yet → hint | `target-detail` | `delta_v` |
| 7 | `sensing_analyze` | Structural Analysis | Press Z | **Soft**: no wireframe if no target → hint | — | — |
| 8 | `manage_codex` | Tech Library | Press L | **Independent** (category: manage) | — | — |

**Soft prerequisite handling for `sensing_target`:** If Tab is pressed before any scan, the target list may be empty. The system still discovers `sensing_target`, activates the `target-detail` HUD group, and Houston says: *"No contacts detected yet. Try pressing S to scan first."* — the attempt is rewarded, the guidance is contextual.

#### Tier 3: Navigation (5 skills — movement & camera)

| # | Skill ID | Name | Trigger | Dependency | HUD Group | Codex |
|---|----------|------|---------|------------|-----------|-------|
| 9 | `nav_autopilot` | Autopilot | Press A + target selected | **Soft**: no target → `nav_autopilot_no_target` | `fuel-group` | `hohmann_transfer` |
| 10 | `nav_autopilot_no_target` | Autopilot (No Target) | Press A + no target | **Independent** (attempt skill) | — | — |
| 11 | `nav_camera` | Camera Cycling | Press V | **Independent** | — | — |
| 12 | `nav_throttle` | Throttle Control | Press +/- | **Independent** | — | — |
| 13 | `nav_manual_thrust` | Manual Thrust | Arrow during autopilot | **Soft**: only if AP is engaged | — | `prograde_paradox` |

**Key edge case — `nav_autopilot` vs `nav_autopilot_no_target`:** When the player presses A, [`InputManager._handleKeyDown()`](js/systems/InputManager.js:137) routes to AutopilotSystem. If no target is selected, the existing system already handles this gracefully. The SkillsSystem listens to [`Events.AUTOPILOT_ENGAGE`](js/core/Events.js:255) for success and a new `AUTOPILOT_NO_TARGET` event (or inspects context) for the no-target case. The player discovers `nav_autopilot_no_target` — a "teaching moment" skill that says *"Autopilot needs a target. Press Tab to select one first."*

#### Tier 4: Collection (5 skills — catching debris)

| # | Skill ID | Name | Trigger | Dependency | HUD Group | Codex |
|---|----------|------|---------|------------|-----------|-------|
| 14 | `collect_lasso` | Lasso Cast | Press Space (lasso fires) | **Soft**: requires gameplay state | — | `kessler_syndrome` |
| 15 | `collect_lasso_miss` | Lasso Miss Recovery | Space, lasso misses | **Hard**: lasso must fire first | — | — |
| 16 | `collect_lasso_catch` | First Catch! | Lasso captures debris | **Hard**: lasso must hit | — | — |
| 17 | `collect_deploy` | Tool Deploy | Press D | **Soft**: needs target for useful deploy | `arms-group` | `feep_thruster` |
| 18 | `collect_arm_catch` | Arm Capture | Arm captures debris | **Hard**: arm must be deployed + catch | `cargo-group` | `space_tether` |

**Compound skills:** `collect_lasso_catch` has a hard dependency chain: fire lasso → hit target. But the intermediate steps (`collect_lasso`, `collect_lasso_miss`) are independently discoverable. Missing with the lasso still earns `collect_lasso_miss` — *"Missed! Get closer and try again."*

#### Tier 5: Economy (4 skills — resource management)

| # | Skill ID | Name | Trigger | Dependency | HUD Group | Codex |
|---|----------|------|---------|------------|-----------|-------|
| 19 | `econ_salvage` | Salvage Stowed | [`Events.CARGO_STORE`](js/core/Events.js:149) | **Hard**: catch → dock → store | `cargo-group` | `space_aluminum` |
| 20 | `econ_forge` | Forge Operation | Press R | **Soft**: needs metal cargo to be useful | — | — |
| 21 | `econ_fuel_cycle` | Fuel Cycling | Press T | **Independent** (always shows current fuel) | — | `specific_impulse_explained` |
| 22 | `econ_shop` | Shop Access | Press B (transitions to SHOP state) | **Soft**: only works in ORBITAL_VIEW | — | — |

**Economy skills naturally come later** — not because they're blocked, but because the events that trigger them (`CARGO_STORE`, forge having cargo) require completing capture actions first. This is organic pacing, not artificial gating.

#### Tier 6: Mastery (11 skills — advanced techniques)

| # | Skill ID | Name | Trigger | Dependency | HUD Group | Codex |
|---|----------|------|---------|------------|-----------|-------|
| 23 | `mastery_tool_cycle` | Tool Cycling | Press ` (backtick) | **Independent** | — | — |
| 24 | `mastery_power_mgmt` | Power Management | Press Shift+1/2/3 | **Independent** | `power-group` `thermal-group` | `power_bus_management` |
| 25 | `mastery_arm_pilot` | Arm Piloting | Press P or 1-6 + arm deployed | **Soft**: no arms → hint | — | — |
| 26 | `mastery_arm_manual` | Manual WASD in Arm | WASD while arm pilot active | **Hard**: arm pilot must be active | — | — |
| 27 | `mastery_detach` | Tether Detach | Press X + deployed arm | **🔒 Safety gate**: ≥2 catches + arm deployed | — | — |
| 28 | `mastery_edt` | EDT Deploy | Press Y | **Independent** | — | `edt_propulsion` |
| 29 | `mastery_comms` | Comms Menu | Press C | **Independent** | — | — |
| 30 | `mastery_navsphere` | NavSphere Toggle | Press N | **Independent** | — | — |
| 31 | `mastery_orbit_mfd` | Orbit MFD | Press M | **Independent** | — | — |
| 32 | `mastery_trawl` | Trawl Deploy | Press Shift+G | **🔒 Safety gate**: ≥1 catch (consumes multiple arms) | — | `orbital_inclination` |
| 33 | `mastery_dual_fire` | Dual Fire | Dual fire event | **Hard**: 2 arms deployed + aligned | — | `recoil_cancellation` |

**Safety-gated skills explained:**
- **`mastery_detach`** — Pressing X permanently severs a tether. The arm is gone forever. A newbie mashing keys in minute 1 could lose their entire fleet. **Gate: ≥2 total catches** (demonstrates basic competence). Before gate is met, X key → Houston: *"Detach is a one-way trip, Cowboy. Get some catches under your belt first."*
- **`mastery_trawl`** — Shift+G deploys a trawl net that consumes the deploying arm's resources and risks tangle with other deployed arms. **Gate: ≥1 total catch** (player understands capture basics). Before gate: *"Trawl operations require experience. Complete a capture first."*

### A.3 Dependency Summary

| Category | Count | Skills |
|----------|-------|--------|
| **Independent** | 20 | All Awareness (3), most Sensing (3), most Navigation (3), `collect_lasso`, `collect_deploy`, `econ_fuel_cycle`, most Mastery (7) |
| **Soft prerequisite** | 5 | `sensing_target`, `sensing_analyze`, `nav_autopilot`, `nav_manual_thrust`, `mastery_arm_pilot` |
| **Safety gate** | 2 | `mastery_detach` (≥2 catches), `mastery_trawl` (≥1 catch) |
| **Hard prerequisite** | 6 | `collect_lasso_miss`, `collect_lasso_catch`, `collect_arm_catch`, `econ_salvage`, `mastery_arm_manual`, `mastery_dual_fire` |

**Breakdown:** 61% independent (20/33), 15% soft prerequisite (5), 6% safety-gated (2), 18% hard prerequisite (6). The safety gates protect only **irreversible destructive actions** — everything else is freely explorable. Pressing a safety-gated key before meeting the requirement still produces a Houston message (never silence).

### A.4 Skill State Machine

Each skill progresses through four states (from [`SKILLS_SYSTEM_DESIGN.md` §2.3](archive/SKILLS_SYSTEM_DESIGN.md)):

```
UNDISCOVERED ──[trigger]──→ DISCOVERED ──[N uses]──→ PRACTICED ──[time+uses]──→ MASTERED
     │                          │                        │                        │
     │ (not shown in pane)      │ (pane popup + comms)   │ (✓ in pane)            │ (fades out)
     │                          │ (reminders begin)      │ (fewer reminders)      │ (no reminders)
```

**Thresholds** (configurable in [`Constants.js`](js/core/Constants.js)):

```javascript
SKILLS: {
  // DISCOVERED → PRACTICED: use count thresholds
  PRACTICE_COUNT_DEFAULT: 5,
  PRACTICE_COUNT_SCAN: 3,       // quick actions = lower bar
  PRACTICE_COUNT_CATCH: 3,      // significant actions = lower bar
  PRACTICE_COUNT_COMPLEX: 2,    // complex skills (arm_pilot) = lower bar

  // PRACTICED → MASTERED: total uses + minimum time since discovery
  MASTERY_COUNT_DEFAULT: 20,
  MASTERY_COUNT_CATCH: 10,
  MASTERY_MIN_TIME: 300,        // seconds (5 min minimum before mastery)

  // Blitz detection
  BLITZ_THRESHOLD: 15,          // skills discovered in BLITZ_WINDOW → expert mode
  BLITZ_WINDOW: 300,            // seconds (5 min)

  // Discovery queue
  DISCOVERY_COOLDOWN: 3,        // seconds between pane popups
  DISCOVERY_BATCH_THRESHOLD: 5, // above this → batch notification

  // Spaced repetition
  REMINDER_INITIAL_INTERVAL: 120,   // seconds
  REMINDER_MAX_INTERVAL: 86400,     // seconds (cap at 24h)
  REMINDER_MIN_INTERVAL: 30,        // seconds
  REMINDER_EASE_FACTOR: 2.5,        // SM-2 default
  REMINDER_FREQUENCY_CAP: 3,        // max reminders per 5 minutes
  REMINDER_CAP_WINDOW: 300,         // seconds

  // Feedback
  EARLY_DISCOVERY_COUNT: 10,        // first N discoveries get variable ratio
  PANE_DISPLAY_DURATION: 4,         // seconds (normal)
  PANE_FIRST_SKILL_DURATION: 8,     // seconds (first 3 discoveries)
}
```

---

## B. Discovery Pane UI Design

### B.1 Core Concept

The Discovery Pane is a **contextual reward overlay** at **bottom-left** that appears when skills are discovered or tech is unlocked. It's not a permanent HUD fixture — it slides in, celebrates the discovery, and fades away. The player can recall it with the `K` toggle key. **Clicking** the pane header opens a **full skill tree view** (see §B.8). Skills with codex entries have **clickable links** to the Tech Library. The pane includes a "NEW TECH" section showing recent codex/tech unlocks with a cyan accent. Pressing `L` opens the full "Tech Library" (renamed from "Codex").

```
┌──────────────────────────────────┐
│  ▸ DISCOVERIES             [8/33] │  ← click header for full tree
│  ──────────────────────────────  │
│  ⚡ NEW TECH                      │  ← cyan accent section
│  🔩 Kessler Syndrome              │
│                                   │
│  ✓ zoom                          │  ← green (Awareness tier)
│  ✓ rotate                        │
│  ★ scan                      📖  │  ← cyan (Sensing) + tech link
│  ○ target                        │
│  ○ autopilot                     │  ← blue (Navigation)
│  ···                              │
│                                   │
└──────────────────────────────────┘
```

### B.2 Where It Lives in the HUD Layout

The HUD layout (from [`HUD._build()`](js/ui/HUD.js:120)):

```
┌───────────────────────────────────────────────────────────┐
│  [StatusPanel: score, resources, ΔV, arms]     [NavSphere]│
│  (left column, 3 stacked panels)               (top-right)│
│                                                            │
│                                                            │
│              (gameplay area)               [Right column:  │
│                                            wireframe +    │
│                                            target list]   │
│                                                            │
│  [Discovery Pane ← HERE]                                  │
│  (bottom-left)                     [Comms Panel: bot-right]│
└───────────────────────────────────────────────────────────┘
```

**Position:** The Discovery Pane sits anchored to **true bottom-left** (`bottom: 10px; left: 10px`), creating spatial separation: **left = learning/discovery**, **right = tactical/operational**. It grows upward from the bottom; the warning strip (`bottom: 170px`, centered) and salvage reveals (`bottom: 120px`, centered) sit above its vertical span without overlap.

| Property | Value | Rationale |
|----------|-------|-----------|
| Position | `fixed; bottom: 10px; left: 10px` | True bottom-left dock (Session 27) |
| Width | `280px` | Slightly wider than status panels for readability |
| Max height | `300px` | Won't overlap status panels |
| Z-index | `200` | Same layer as other HUD overlays |
| Background | `rgba(0, 10, 20, 0.85)` | Slightly more opaque than comms panel |
| Border | `1px solid rgba(0, 255, 136, 0.25)` | Green accent (matches HUD palette) |
| Font | `'Courier New', monospace, 12px` | Consistent with HUD |
| Toggle key | `I` (info) | Mnemonic, unbound in [`InputManager`](js/systems/InputManager.js) |

### B.3 Tier Color Progression

Each tier has a **unique color** that creates a visual sense of depth and progression — from green (familiar, safe) through to deep purple (mastery, expertise). This color is used for tier headers, skill names, and progress dots.

| Tier | Name | Color | Hex | Emotional Register |
|------|------|-------|-----|-------------------|
| 1 | Awareness | 🟢 Green | `#00ff88` | Safe, natural, beginning |
| 2 | Sensing | 🔵 Cyan | `#44ddff` | Curiosity, discovery, senses |
| 3 | Navigation | 🔷 Blue | `#4488ff` | Control, direction, confidence |
| 4 | Collection | 🟣 Blue-Violet | `#8866ff` | Active skill, precision |
| 5 | Economy | 💜 Violet | `#bb44ff` | Complex systems, resource wisdom |
| 6 | Mastery | 🟪 Deep Purple | `#cc44dd` | Expertise, rarity, full command |

The progression green → cyan → blue → violet → purple gives an immediate visual read of skill depth. A pane full of green skills = beginner. A pane with purple skills = expert. The color itself becomes the reward signal — unlocking your first purple skill *feels* different from a green one.

### B.4 Visual States for Skills

Each skill line in the pane has a visual state that corresponds to the skill state machine. The **discovered/practiced** color uses the tier's color. The mastered color is always amber (gold star = universal achievement).

| Skill State | Symbol | Text Color | Opacity | Behavior |
|-------------|--------|------------|---------|----------|
| `UNDISCOVERED` | `○` | Tier color at 30% brightness | 0.35 | Dim placeholder — shows dot only, not name |
| `LOCKED` | `🔒` | `#ff4444` (red) | 0.5 | Safety-gated skill — shows name + unlock hint |
| `DISCOVERED` | `●` | **Tier color** (e.g., `#00ff88` for Awareness) | 1.0 | Just discovered — pulses in tier color |
| `PRACTICED` | `✓` | Tier color at 70% brightness | 0.75 | Comfortable, settling into background |
| `MASTERED` | `★` | `#ffaa00` (amber) for 3s, then fades | 0.4 → 0.15 | Gold star briefly, then fades nearly invisible |

**Codex links:** Skills with a codex entry show a small `📖` icon after the skill name. In the expanded view (§B.8), clicking this icon opens [`CodexViewerUI`](js/ui/CodexViewerUI.js) to that entry. In the compact contextual pane, the icon is decorative (pane has `pointer-events: none`).

**Fading mastery behavior:** Mastered skills fade to near-invisible (`opacity: 0.15`). The pane naturally becomes simpler as skills are mastered. Green fading first, then cyan, then blue — the color progression makes this visually satisfying.

### B.4 Pane Layout Modes

#### Game Start (0 skills discovered)
The pane is **not visible**. Nothing to show yet.

#### First Interaction (1st skill discovered)
Pane slides in with an explanatory header (shown once ever). Skill is in its tier color:

```
┌──────────────────────────────────┐
│  ✦ NEW SKILL DISCOVERED           │
│  Your abilities are tracked here  │
│  Click ▸ for full skill tree      │
│  ───────────────────────────────  │
│  ★ Quick Scan                 📖  │  ← cyan pulse (Sensing tier)
│  ○ ○ ○ ○ ○ ○ ○ ···               │  ← dim placeholders
└──────────────────────────────────┘
```

#### Early Game (3-10 skills)
Pane shows discovered skills by name in tier colors. Undiscovered shown as dim dots:

```
┌──────────────────────────────────┐
│  ▸ DISCOVERIES             [5/33] │  ← click to expand
│  ───────────────────────────────  │
│  AWARENESS         ●●●           │  ← green (#00ff88)
│  ✓ Look  ✓ Zoom  ● Mouse        │
│                                   │
│  SENSING           ●●○○○         │  ← cyan (#44ddff)
│  ✓ Scan  ● Target            📖  │
│                                   │
│  NAVIGATION        ○○○○○         │  ← blue (#4488ff), dim
│  COLLECTION        ○○○○○         │  ← blue-violet (#8866ff), dim
│  ECONOMY           ○○○○          │  ← violet (#bb44ff), dim
│  MASTERY           ○○🔒○○○○○○○○  │  ← purple (#cc44dd), dim + lock
└──────────────────────────────────┘
```

**Undiscovered tier names ARE visible** (Option A from [`SKILLS_SYSTEM_DESIGN.md` §10.1](archive/SKILLS_SYSTEM_DESIGN.md)). The dots say "there's more to find" without prescribing order. The `🔒` symbol indicates safety-gated skills (detach, trawl).

#### Mid-Game (15-25 skills)
Practiced skills show `✓` in their tier color (dimmed). Mastered skills get amber star then fade:

```
┌──────────────────────────────────┐
│  ▸ DISCOVERIES            [18/33] │
│  ───────────────────────────────  │
│  AWARENESS  ✓✓✓✓   (faded green)  │
│                                   │
│  SENSING    ✓✓✓●○                │  ← cyan
│  ● Tech Library              📖  │  ← still learning + tech link
│                                   │
│  NAVIGATION ✓✓✓✓○                │  ← blue, mostly faded
│                                   │
│  COLLECTION ✓✓★✓○                │  ← blue-violet
│  ★ First Catch!                   │  ← amber star, then fades
│                                   │
│  ECONOMY    ●●○○                 │  ← violet
│  ● Salvage  ● Forge              │
│                                   │
│  MASTERY    ●●●○○○○○○○○          │  ← purple
│  ● Power  ● Comms  ● NavSphere  │
└──────────────────────────────────┘
```

#### Late Game (30+ skills)
Most skills mastered and faded. Pane is minimal — only showing the few remaining discoveries:

```
┌─────────────────────────────────┐
│  ▸ DISCOVERIES            [31/33]│
│  ─────────────────────────────  │
│  MASTERY           ●●○          │
│  ● EDT  ● Trawl                  │
│  ○ Dual Fire                     │
│                                  │
│  (30 mastered — nice work!)      │
└─────────────────────────────────┘
```

### B.5 Pane Appearance/Disappearance

#### Triggers for Pane Appearance

| Trigger | Duration | Notes |
|---------|----------|-------|
| New skill discovered | 4s (8s for first 3 skills) | Auto-slide-in from right |
| Player presses `I` key | Toggle on/off | Manual review |
| Tier completion | 6s | Celebration: tier name pulses amber |
| All skills discovered | 8s | Final celebration |

#### Animation Sequence (New Discovery)

```
0ms     — Screen-edge glow in TIER COLOR (subtle, right side, 150ms)
0ms     — Pane begins slide-in from right (200ms ease-out)
200ms   — New skill name pulses in TIER COLOR (2 cycles × 600ms)
200ms   — Tier progress dots update
200ms   — Houston comms message plays (independent of pane)
200ms   — Codex 📖 icon appears next to skill name (if skill has codex entry)
4000ms  — Pane begins fade-out (800ms ease-out)
4800ms  — Pane hidden
```

**Flow protection** (from [`SKILLS_SYSTEM_DESIGN.md` §5.3](archive/SKILLS_SYSTEM_DESIGN.md)):
- Any gameplay input (arrows, space, WASD) during pane display → immediate fade-out
- ESC → immediate hide
- Min 3s between popups (discovery queue)
- Suppress during active capture sequences (check game state)
- Max 3 reminders per 5 minutes

#### Disappearance

```
Input detected during display → 200ms fade-out (immediate)
Timer expires                → 800ms fade-out (gentle)
ESC pressed                  → 0ms hide (instant)
Game state → SHOP/GAME_OVER  → 0ms hide (instant)
```

### B.6 Integration with Progressive Luminance

The Skills Pane and the HUD luminance system are driven by the **same skill state**. Currently, [`HUD.setTutorialVisibility()`](js/ui/HUD.js:334) maps stage numbers to HUD groups. The new system replaces this with a set-based approach:

```
Skill discovered
  → SkillsSystem emits SKILL_STATE_CHANGED { activeGroups: Set<string> }
  → HUD.setSkillVisibility(activeGroups)  // replaces setTutorialVisibility()
  → SkillsPane.showDiscovery(skillDef)    // pane animation
```

The existing CSS classes `hud-dormant` and `hud-active` work unchanged — they're just driven by skill set cardinality instead of stage number.

### B.7 Pane CSS

```css
/* Skills Pane — contextual overlay (compact mode) */
#skills-pane {
  position: fixed;
  bottom: 180px;
  left: 10px;
  width: 280px;
  max-height: 300px;
  overflow-y: auto;
  background: rgba(0, 10, 20, 0.85);
  border: 1px solid rgba(0, 255, 136, 0.25);
  border-radius: 4px;
  padding: 10px 14px;
  font-family: 'Courier New', monospace;
  font-size: 12px;
  color: #ccddcc;
  z-index: 200;
  pointer-events: none;     /* Compact mode: no clicks during gameplay */
  display: none;
  opacity: 0;
  transform: translateX(20px);
  transition: opacity 200ms ease-out, transform 200ms ease-out;
}

#skills-pane.visible {
  display: block;
  opacity: 1;
  transform: translateX(0);
}

#skills-pane.fading {
  opacity: 0;
  transform: translateX(10px);
  transition: opacity 800ms ease-out, transform 800ms ease-out;
}

/* Expanded mode — full skill tree overlay */
#skills-pane.expanded {
  pointer-events: auto;    /* Clicks enabled in expanded mode */
  position: fixed;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: 420px;
  max-height: 80vh;
  z-index: 300;
  border-color: rgba(0, 255, 136, 0.4);
  cursor: default;
}

/* Pane header — clickable to expand */
.skills-pane-header {
  cursor: pointer;
  padding: 4px 0;
  border-bottom: 1px solid rgba(0, 255, 136, 0.15);
  margin-bottom: 8px;
  user-select: none;
}
.skills-pane-header:hover { color: #00ff88; }

/* === TIER COLOR CLASSES === */
.tier-awareness    { color: #00ff88; } /* Green */
.tier-sensing      { color: #44ddff; } /* Cyan */
.tier-navigation   { color: #4488ff; } /* Blue */
.tier-collection   { color: #8866ff; } /* Blue-Violet */
.tier-economy      { color: #bb44ff; } /* Violet */
.tier-mastery      { color: #cc44dd; } /* Deep Purple */

/* Tier header labels use tier color at reduced opacity */
.tier-header { opacity: 0.7; font-size: 10px; letter-spacing: 1px; margin-top: 6px; }

/* Skill line base */
.skill-line { margin: 2px 0; line-height: 1.5; }
.skill-line.undiscovered { opacity: 0.30; }
.skill-line.locked { color: #ff4444; opacity: 0.5; }
.skill-line.discovered { opacity: 1.0; }
.skill-line.practiced { opacity: 0.70; }
.skill-line.mastered { color: #ffaa00 !important; opacity: 0.15; transition: opacity 3s; }

/* Codex link icon */
.skill-codex-link {
  cursor: pointer;
  opacity: 0.5;
  font-size: 11px;
  margin-left: 4px;
  transition: opacity 0.2s;
}
.skill-codex-link:hover { opacity: 1.0; }

/* Discovery pulse — uses CSS custom property for tier color */
@keyframes skill-discover-pulse {
  0%, 100% { text-shadow: 0 0 0 transparent; }
  50% { text-shadow: 0 0 10px var(--tier-color, #00ff88); }
}
.skill-line.just-discovered {
  animation: skill-discover-pulse 600ms ease-in-out 2;
}

/* Screen-edge discovery glow — color set via JS */
@keyframes skill-edge-glow {
  0% { opacity: 0; }
  30% { opacity: 0.4; }
  100% { opacity: 0; }
}
#skill-edge-glow {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: 40px;
  pointer-events: none;
  z-index: 199;
  animation: skill-edge-glow 500ms ease-out forwards;
  /* background gradient color set dynamically per tier */
}

/* Expanded mode dark backdrop */
#skills-backdrop {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 5, 10, 0.7);
  z-index: 299;
  display: none;
}
#skills-backdrop.visible { display: block; }
```

### B.8 Full Skill Tree — Expanded View

**Trigger:** Clicking the pane header (`▸ DISCOVERIES [N/33]`) OR pressing `K` while pane is already visible opens the **expanded skill tree view**. This is a centered overlay showing all 33 skills organized by tier.

**Dismiss:** `ESC` key, clicking the backdrop, or clicking the close button. Returns to compact contextual mode.

**Expanded view features:**
- **All skills visible** — undiscovered skills show name (not just dots) but dimmed
- **Tier colors** prominent — each tier section has a colored header and border-left accent
- **Codex links clickable** — `📖` icons are clickable (`pointer-events: auto` in expanded mode), opening [`CodexViewerUI`](js/ui/CodexViewerUI.js) to the relevant entry
- **Safety gates visible** — locked skills show `🔒` with unlock condition text
- **Progress bars** per tier — visual fill showing discovered/practiced/mastered ratio
- **Keyboard shortcut hints** — each skill shows its key binding in dim text

```
┌───────────────────────────────────────────────┐
│  ◂ SKILL TREE                          [18/33] │  ← click ◂ or ESC to close
│  ─────────────────────────────────────────────  │
│                                                  │
│  ██████████░░░░  AWARENESS (3/3)     #00ff88    │
│  ┊ ✓ Look Around ←↑↓→                    📖    │
│  ┊ ✓ Zoom Control  scroll                      │
│  ┊ ✓ Mouse Camera  drag                        │
│                                                  │
│  ████████░░░░░░  SENSING (3/5)       #44ddff    │
│  ┊ ✓ Quick Scan [S]                       📖    │
│  ┊ ✓ Deep Scan [W]                              │
│  ┊ ● Target Lock [TAB]                    📖    │
│  ┊ ○ Structural Analysis [Z]                    │
│  ┊ ○ Tech Library [L]                           │
│                                                  │
│  ██████░░░░░░░░  NAVIGATION (2/5)    #4488ff    │
│  ┊ ● Autopilot [A]                        📖    │
│  ┊ ✓ Camera Cycling [V]                         │
│  ┊ ○ Throttle Control [+/-]                     │
│  ┊ ○ Autopilot (No Target) [A]                  │
│  ┊ ○ Manual Thrust  arrow+AP                    │
│                                                  │
│  ████████████░░  COLLECTION (4/5)    #8866ff    │
│  ┊ ✓ Lasso Cast [SPACE]                   📖    │
│  ┊ ✓ Lasso Miss  auto                           │
│  ┊ ★ First Catch!  auto                         │
│  ┊ ● Tool Deploy [D]                      📖    │
│  ┊ ○ Arm Capture  auto                    📖    │
│                                                  │
│  ████░░░░░░░░░░  ECONOMY (2/4)       #bb44ff    │
│  ┊ ● Salvage Stowed  auto                 📖    │
│  ┊ ● Forge Operation [R]                        │
│  ┊ ○ Fuel Cycling [T]                      📖   │
│  ┊ ○ Shop Access [B]                            │
│                                                  │
│  ██████░░░░░░░░  MASTERY (3/11)      #cc44dd    │
│  ┊ ● Power Management [Shift+1/2/3]       📖    │
│  ┊ ● Comms Menu [C]                             │
│  ┊ ● NavSphere Toggle [N]                       │
│  ┊ ○ Tool Cycling [`]                            │
│  ┊ ○ Arm Piloting [P/1-6]                       │
│  ┊ ○ Manual WASD  arm mode                      │
│  ┊ 🔒 Tether Detach [X]  (need 2 catches)       │
│  ┊ ○ EDT Deploy [Y]                       📖    │
│  ┊ ○ Orbit MFD [M]                              │
│  ┊ 🔒 Trawl Deploy [Shift+G]  (need 1 catch) 📖 │
│  ┊ ○ Dual Fire  auto                      📖    │
│                                                  │
└───────────────────────────────────────────────┘
```

**Implementation notes:**
- The expanded view reuses the same DOM container (`#skills-pane`) with an `.expanded` CSS class
- A backdrop div (`#skills-backdrop`) provides the dark overlay behind the expanded pane
- Codex links dispatch `eventBus.emit(Events.CODEX_UNLOCK_REQUEST, { id })` then toggle `CodexViewerUI`
- The expanded view pauses the game (`eventBus.emit(Events.PAUSE_RESUME)`) — same as codex/shop overlays
- Keyboard shortcuts shown in dim text after skill names help "learn by reading" players

### B.9 Progression-Aware Persistence *(Session 27 — 2026-04-17)*

The pane's **persistence gradient** adapts to the player's experience level. New players need the pane as a constant reference; advanced players want a transient toast. A single axis — the count of skills in any state ≠ `'undiscovered'` — drives three behaviors:

| Level | Threshold | Idle opacity | Auto-hide (standard / first-3) | Renders when idle? |
|-------|-----------|--------------|--------------------------------|--------------------|
| **NOVICE**     | `< 5`   discovered | **0.85** | **none** — always visible                     | ✅ Yes |
| **APPRENTICE** | `5–14`  discovered | **0.45** | **15 000 ms** / **20 000 ms** → fades to 0.45 | ✅ Yes |
| **VETERAN**    | `≥ 15`  discovered | **0.00** | **4 000 ms**  / **8 000 ms**  → fades to hide | ❌ No  |

**Behavior rules:**

1. **On any discovery** (skill or tech), the pane brightens to 100% opacity, slides in if currently hidden (VETERAN idle only), and resets the auto-hide timer per the current level.
2. **Idle state** differs per level: NOVICE stays readable at 0.85 with suggested-next-skill hints visible; APPRENTICE dims to 0.45 as an ambient helper; VETERAN fully hides (`display:none`).
3. **Level-up is implicit** — crossing a threshold (e.g., 5th skill bumps NOVICE → APPRENTICE) takes effect on the next `show()`/`_fadeOut()` call. A single dev-console log marks the transition; no in-game celebration.
4. **Expanded view (`I`) and Tech Library (`L`)** behave identically at every level.
5. **Save-load aware** — `SKILLS_LOADED` recomputes level from the restored `_states` Map and applies the correct initial display so a loaded save drops the player straight into APPRENTICE/VETERAN mode.

**Implementation surface** (all in [`js/ui/hud/SkillsPane.js`](js/ui/hud/SkillsPane.js)):

- `EXPERIENCE_LEVELS` constant table — single source of truth for thresholds, idle opacities, autohide windows.
- `_getExperienceLevel()` — derives level from `_getDiscoveredSkillCount()`.
- `_fadeToIdle(opacity)` — 300 ms opacity transition that keeps `display:block`.
- `_applyInitialDisplay()` — runs 500 ms after construction (and again on `SKILLS_LOADED`) to set the initial per-level visibility without competing with briefing/menu transitions.
- `show()` — slide-in only when currently hidden; opacity-only transition when already rendered.
- `_fadeOut()` — branches on level: NOVICE/APPRENTICE call `_fadeToIdle()`, VETERAN keeps the classic fade-and-hide path.
- `reset()` — clears state and re-applies NOVICE behavior for new-game flow.

---

## C. HUD Progressive Revelation Map

### C.1 Skill → HUD Group Activation

Each skill that activates a HUD group. Multiple skills can activate the same group — whichever fires first wins.

| Skill ID | HUD Group(s) Activated | Current Tutorial Stage Equivalent | Element Behavior on Activation |
|----------|----------------------|----------------------------------|-------------------------------|
| *(timer: 5s after ORBITAL_VIEW)* | `score-group` | BEAUTY (0) | Score display, debris cleared counter undim — activated by [`GameFlowManager`](js/systems/GameFlowManager.js) timer, not a skill |
| `sensing_scan` | `target-list` | SCAN (2) | Target list panel in [`TargetPanel`](js/ui/hud/TargetPanel.js) undims, populates |
| `sensing_deep_scan` | `target-list` | SCAN (2) | Same group — fires if W pressed before S |
| `sensing_target` | `target-detail` | TARGET_SELECT (3) | Selected target info, wireframe panel undim |
| `nav_autopilot` | `fuel-group` | AUTOPILOT (4) | Fuel/ΔV bars, autopilot indicator undim |
| `collect_deploy` | `arms-group` | DEPLOY (7) | Arm fleet status panel undims |
| `collect_arm_catch` | `cargo-group` | DEPLOY (7) | Cargo hold display undims |
| `econ_salvage` | `cargo-group` | FREE_PLAY (9) | Redundant activation (same as arm_catch) |
| `mastery_power_mgmt` | `power-group`, `thermal-group` | TOOL_MASTERY (8) | Power bus sliders, thermal gauge undim |

### C.2 Complete HUD Group Mapping

Every `data-hud-group` element in the DOM and its full lifecycle:

| HUD Group | DOM Location | Initial State | Activated By | Visual on Activation |
|-----------|-------------|---------------|-------------|---------------------|
| `score-group` | [`StatusPanel`](js/ui/hud/StatusPanel.js) score section | `hud-dormant` (0.3 opacity) | Direct timer in [`GameFlowManager`](js/systems/GameFlowManager.js) (5s after ORBITAL_VIEW) | Fade to full opacity over 1s; subtle green pulse on score label |
| `target-list` | [`TargetPanel`](js/ui/hud/TargetPanel.js) list container | `hud-dormant` | `sensing_scan` OR `sensing_deep_scan` | Undim + populate targets; brief border glow |
| `target-detail` | [`TargetPanel`](js/ui/hud/TargetPanel.js) selected info + [`DebrisWireframe`](js/ui/DebrisWireframe.js) | `hud-dormant` | `sensing_target` | Undim; selected target highlights; wireframe view activates |
| `fuel-group` | [`StatusPanel`](js/ui/hud/StatusPanel.js) resource bars | `hud-dormant` | `nav_autopilot` | Fuel/ΔV bars undim; autopilot indicator pulses |
| `arms-group` | [`StatusPanel`](js/ui/hud/StatusPanel.js) arm fleet panel | `hud-dormant` | `collect_deploy` | Arm status grid undims; deployed arm highlights |
| `cargo-group` | [`StatusPanel`](js/ui/hud/StatusPanel.js) cargo line | `hud-dormant` | `collect_arm_catch` OR `econ_salvage` | Cargo summary undims; mass display activates |
| `power-group` | [`StatusPanel`](js/ui/hud/StatusPanel.js) power sliders | `hud-dormant` | `mastery_power_mgmt` | Power bus section undims |
| `thermal-group` | [`StatusPanel`](js/ui/hud/StatusPanel.js) thermal gauge | `hud-dormant` | `mastery_power_mgmt` | Thermal readout undims |

### C.3 Default State (Fresh Game, 0 Skills)

```
score-group:    hud-dormant (0.3 opacity)  → lights up via GameFlowManager timer (5s after ORBITAL_VIEW)
target-list:    hud-dormant                → lights up on sensing_scan / sensing_deep_scan
target-detail:  hud-dormant                → lights up on sensing_target
fuel-group:     hud-dormant                → lights up on nav_autopilot
arms-group:     hud-dormant                → lights up on collect_deploy
cargo-group:    hud-dormant                → lights up on collect_arm_catch / econ_salvage
power-group:    hud-dormant                → lights up on mastery_power_mgmt
thermal-group:  hud-dormant                → lights up on mastery_power_mgmt
```

**Expected fast-path:** The score-group activates automatically 5s after ORBITAL_VIEW via a GameFlowManager timer. A player pressing random keys will typically discover `awareness_look` (arrows), `sensing_scan` (S), `sensing_target` (Tab) within 30 seconds. This activates `target-list`, `target-detail` — matching the current tutorial stages 0-3 but without enforcing order.

### C.4 How Newly-Unlocked HUD Elements Draw Attention

When a `hud-dormant` element transitions to `hud-active`:

1. **Opacity transition:** `opacity: 0.3 → 1.0` over 800ms (CSS transition on `.hud-active`)
2. **Brief border glow:** 2s amber border pulse (reuse existing [`tutorial-highlight-pulse`](js/systems/TutorialSystem.js:141) keyframe)
3. **Content population:** For target list, the scan results appear simultaneously with the undim — the panel lights up AND fills with data in one moment
4. **No forced attention:** The glow is peripheral — it draws the eye without demanding focus. The player can ignore it and come back to it

### C.5 "All Groups Active" Transition

When all 8 HUD groups have been activated (doesn't require all 33 skills — just the 8 skill-based activations plus the timer-based score-group), the system enters equivalent of [`TutorialStage.FREE_PLAY`](js/systems/TutorialSystem.js:22):

```javascript
// In SkillsSystem
get allGroupsActive() {
  const required = ['score-group', 'target-list', 'target-detail',
                    'fuel-group', 'arms-group', 'power-group',
                    'thermal-group', 'cargo-group'];
  return required.every(g => this._activeGroups.has(g));
}
```

At this point, all `hud-dormant`/`hud-active` classes are removed, returning control to the camera-view system ([`HUD._applyViewConfig()`](js/ui/HUD.js:820)). The skills system continues tracking discoveries/mastery, but HUD luminance is no longer constrained.

---

## D. Feedback & Reward Architecture

### D.1 Feedback Layers

Every skill discovery fires a **layered response**. The layers combine for richer feedback without any single layer being overwhelming:

| Layer | Channel | Always | Enhanced | Celebration |
|-------|---------|--------|----------|-------------|
| **Skills Pane** | Visual (right panel) | ✓ Slide in, skill pulses | ✓ + screen-edge glow | ✓ + "NEW SKILL" header |
| **Houston Comms** | Text (comms panel) | ✓ One message per skill | ✓ Same | ✓ Same |
| **HUD Undim** | Visual (affected panel) | ✓ If skill activates a group | ✓ Same | ✓ Same + border pulse |
| **Audio** | Sound | ✓ Click (existing) | ✓ + soft chime | ✓ + ascending tone |
| **Codex** | Learning | ✓ If skill has codex entry | ✓ Same | ✓ Same |

### D.2 Variable Ratio Reinforcement (First 10 Discoveries)

**Theory:** Variable ratio reinforcement (Skinner) produces the highest, most consistent response rates. The player can't predict which key press produces the "big" feedback, creating exploration-as-slot-machine.

```javascript
// In SkillsSystem._discoverSkill()
_getFeedbackIntensity(discoveryIndex) {
  // Certain milestones ALWAYS get celebration
  const alwaysCelebration = new Set([
    'collect_lasso_catch',    // First catch — always a big moment
  ]);
  if (alwaysCelebration.has(this._currentSkillId)) return 'celebration';

  // Tier completions always celebrate
  if (this._isTierComplete()) return 'celebration';

  // Past early game, normalize
  if (discoveryIndex >= Constants.SKILLS.EARLY_DISCOVERY_COUNT) return 'standard';

  // Variable ratio: 70% standard, 20% enhanced, 10% celebration
  const roll = Math.random();
  if (roll < 0.10) return 'celebration';
  if (roll < 0.30) return 'enhanced';
  return 'standard';
}
```

**Feedback level definitions:**

| Level | Visual | Audio | Pane Duration |
|-------|--------|-------|---------------|
| `standard` | Pane popup + comms | Existing click | 4s |
| `enhanced` | Pane + amber screen-edge glow | Click + soft chime (new) | 5s |
| `celebration` | Pane + bright glow + "NEW SKILL" floating text | Click + ascending tone (new) | 6s |

### D.3 Spaced Repetition (Ongoing Learning)

After discovery, skills that are DISCOVERED (not yet PRACTICED) receive periodic reminders. The algorithm is a simplified SM-2 variant from [`SKILLS_SYSTEM_DESIGN.md` §5.2](archive/SKILLS_SYSTEM_DESIGN.md):

```javascript
class SkillReminder {
  constructor() {
    this.interval = Constants.SKILLS.REMINDER_INITIAL_INTERVAL;  // 120s
    this.easeFactor = Constants.SKILLS.REMINDER_EASE_FACTOR;     // 2.5
    this.lastReminded = 0;
    this.lastUsed = 0;
  }

  /** Player used the skill — they remember. Stretch interval. */
  onUse(now) {
    this.lastUsed = now;
    if (now < this.lastReminded + this.interval * 1000) {
      // Used before needing a reminder → interval grows
      this.interval = Math.min(
        this.interval * this.easeFactor,
        Constants.SKILLS.REMINDER_MAX_INTERVAL
      );
      this.easeFactor = Math.min(this.easeFactor + 0.1, 3.0);
    }
  }

  /** Check if a reminder is due */
  shouldRemind(now) {
    if (now - this.lastUsed < this.interval * 1000) return false;
    if (now - this.lastReminded < this.interval * 1000) return false;
    return true;
  }

  /** Reminder was shown — player needed it. Shrink interval. */
  onRemind(now) {
    this.lastReminded = now;
    this.interval = Math.max(
      this.interval / this.easeFactor,
      Constants.SKILLS.REMINDER_MIN_INTERVAL
    );
    this.easeFactor = Math.max(this.easeFactor - 0.1, 1.5);
  }
}
```

**Reminder format:** Single line, bottom-right, matches existing prompt style:

```
[S] Scan — find targets nearby
```

**Reminder rules:**
- Max 1 reminder visible at a time
- Never during active capture (check [`GameStates`](js/core/GameState.js) === `APPROACH` or `INTERACTION`)
- Never if player is in arm pilot mode
- Stop reminding once skill reaches MASTERED
- Frequency cap: max 3 per 5 minutes
- Checked at 1 Hz in `update()`, not per-frame

### D.4 "Space Sim Style" Rewards

The user explicitly said "not points/XP — think undimming panels, new capabilities, codex entries, comm messages." Here's the complete reward vocabulary:

| Reward Type | Description | Examples |
|-------------|-------------|---------|
| **HUD undim** | A panel area lights up, becoming usable | Discovering scan → target list panel appears with data |
| **Capability reveal** | The player realizes they can do something new | Pressing D → arm deploys → "I have TOOLS?" |
| **Codex entry** | A real aerospace concept unlocked for reading | `sensing_target` → Codex: "Delta-V" |
| **Houston dialogue** | In-character encouragement from mission control | *"First catch confirmed! Welcome to the cleanup crew, Cowboy."* |
| **Continued depth** | Pressing a key again reveals MORE capability | S → targets appear. S again → targets refresh. W → deeper scan reveals more |
| **Progression sense** | The pane itself shows discovery count climbing | `[8/33]` → `[9/33]` with a pulse |
| **Mastery fading** | Old skills fade, making the pane cleaner | Early chaos → clean pane = visible progress |

### D.5 Repeat Interaction Reinforcement

The user asked: *"How does pressing the same key again (e.g., S for scan a second time) provide continued reinforcement?"*

**Second-use feedback chain:**

| Use # | Feedback | Why It Works |
|-------|----------|-------------|
| 1st (discovery) | Full discovery sequence: pane + comms + HUD undim + codex | Big reward for first-time exploration |
| 2nd | Target list updates with new data; scan sound plays; credit flash if reward | The ACTION itself is rewarding — new targets appear |
| 3rd-5th | Approaching PRACTICED; each use slightly deepens mastery | Quiet competence building; no interruptions |
| 5th+ (PRACTICED) | `✓` appears in pane (brief flash if pane visible) | Milestone acknowledgment |
| 20th+ (MASTERED) | `★` gold star in pane; skill fades to near-invisible | Permanent badge of mastery |

**Key insight:** After the first discovery, the **game action itself IS the reward**. Scanning produces targets. Targeting produces info. Autopilot produces travel. The skills system doesn't need to add artificial rewards on top of naturally rewarding actions — it just needs to get out of the way and let the game reward the player.

### D.6 Veteran Blitz Detection

When a player discovers 15+ skills in under 5 minutes, the system detects "blitz mode" and reduces feedback to minimum:

```javascript
_isBlitzing() {
  if (this.discoveryCount < Constants.SKILLS.BLITZ_THRESHOLD) return false;
  const elapsed = (Date.now() - this.firstDiscoveryTime) / 1000;
  return elapsed < Constants.SKILLS.BLITZ_WINDOW;
}
```

In blitz mode:
- All discoveries use `standard` feedback (no variable ratio)
- Pane duration reduced to 2s
- Screen-edge glow suppressed
- Comms messages still fire (they're natural, not annoying)
- HUD undim still works (functional, not decorative)

---

## E. Migration Plan: Tutorial → Skills

### E.1 What Gets Replaced

| TutorialSystem Component | Replacement | Notes |
|--------------------------|-------------|-------|
| [`TutorialStage` enum](js/systems/TutorialSystem.js:12) | Skill state set | No more stage numbers |
| [`_startStage()` switch](js/systems/TutorialSystem.js:520) | Skill definitions (data-driven) | Each skill carries its own comms/codex/HUD |
| [`advanceTo()` linear progression](js/systems/TutorialSystem.js:404) | `_discoverSkill()` (any order) | No forward-only constraint |
| [`_setupListeners()`](js/systems/TutorialSystem.js:154) stage gates | SkillsSystem listens to same events, no gates | Every input rewarded |
| [`skip()`](js/systems/TutorialSystem.js:483) | Not needed — no skip button | The system itself is enjoyable |
| [`_createUI()` prompt](js/systems/TutorialSystem.js:79) | `SkillsPane` (richer pane) | Prompt pattern reused for reminders |
| [`_unlockCodexForCompletedStage()`](js/systems/TutorialSystem.js:434) | Codex entries in skill definitions | Data-driven, not switch-cased |
| [`_highlightElement()`](js/systems/TutorialSystem.js:454) | Reused for HUD group activation glow | Same CSS animation |
| Economy one-shot hints (`_salvageHintShown` etc.) | Economy skills (`econ_salvage`, `econ_forge`, `econ_fuel_cycle`) | Comms in skill defs |
| [`showPrompt()`/`hidePrompt()`](js/systems/TutorialSystem.js:356) | Reused for spaced repetition reminders | Same fade pattern |
| [`TUTORIAL_STAGE_CHANGED`](js/core/Events.js:223) | `SKILL_STATE_CHANGED` | Backward compat bridge during migration |
| [`TUTORIAL_SKIPPED`](js/core/Events.js:224) | Not needed | No skip = no skip event |

### E.2 What Happens to the Beauty Moment

The BEAUTY stage was the "wow" moment — player's first seconds in orbit. The `awareness_beauty` skill was **removed** in the UX overhaul (2026-04-16). The score-group HUD panel is now activated by a **direct timer in [`GameFlowManager`](js/systems/GameFlowManager.js)** — 5 seconds after entering ORBITAL_VIEW, it undims the score display. This is no longer a skill discovery; it's a simple timer-based activation. The experience is preserved without the gate or the misleading "skill discovered" notification.

### E.3 Phase-by-Phase Migration

#### Phase 1: Feature Flag Coexistence

```javascript
// In GameFlowManager or main.js
const USE_SKILLS_SYSTEM = true; // feature flag

if (USE_SKILLS_SYSTEM) {
  this.skillsSystem = new SkillsSystem();
  this.tutorialSystem = null;  // Don't create
} else {
  this.tutorialSystem = new TutorialSystem();
  this.skillsSystem = null;
}
```

Both systems are **never active simultaneously**. The feature flag controls which one is instantiated. During Phase 1, the skills system emits `TUTORIAL_STAGE_CHANGED` with a computed equivalent stage for backward compatibility:

```javascript
// In SkillsSystem — backward compat bridge
_emitTutorialCompat() {
  // Map active HUD groups to approximate tutorial stage
  let equivStage = 0; // BEAUTY
  if (this._activeGroups.has('score-group'))    equivStage = Math.max(equivStage, 0);
  if (this._activeGroups.has('target-list'))    equivStage = Math.max(equivStage, 2);
  if (this._activeGroups.has('target-detail'))  equivStage = Math.max(equivStage, 3);
  if (this._activeGroups.has('fuel-group'))     equivStage = Math.max(equivStage, 4);
  if (this._activeGroups.has('arms-group'))     equivStage = Math.max(equivStage, 7);
  if (this._activeGroups.has('power-group'))    equivStage = Math.max(equivStage, 8);
  if (this.allGroupsActive)                     equivStage = 9; // FREE_PLAY

  eventBus.emit(Events.TUTORIAL_STAGE_CHANGED, { stage: equivStage });
}
```

This bridge ensures [`HUD.setTutorialVisibility()`](js/ui/HUD.js:334) continues to work during transition.

#### Phase 2: Direct HUD Integration

Replace `TUTORIAL_STAGE_CHANGED` listener in [`HUD._setupEventListeners()`](js/ui/HUD.js:459) with `SKILL_STATE_CHANGED`:

```javascript
// Replace this:
eventBus.on(Events.TUTORIAL_STAGE_CHANGED, ({ stage }) => {
  this.setTutorialVisibility(stage);
});

// With this:
eventBus.on(Events.SKILL_STATE_CHANGED, ({ activeGroups }) => {
  this.setSkillVisibility(activeGroups);
});
```

The new `setSkillVisibility()` method accepts a `Set<string>` instead of a stage number:

```javascript
setSkillVisibility(activeGroups) {
  const allGroups = ['score-group', 'target-list', 'target-detail',
                     'fuel-group', 'arms-group', 'power-group',
                     'thermal-group', 'cargo-group'];

  const allActive = allGroups.every(g => activeGroups.has(g));
  if (allActive) {
    // Remove all luminance classes, return to camera-view control
    this.container.querySelectorAll('[data-hud-group]').forEach(el => {
      el.classList.remove('hud-dormant', 'hud-active');
    });
    this._applyViewConfig();
    return;
  }

  for (const group of allGroups) {
    const active = activeGroups.has(group);
    this.container.querySelectorAll(`[data-hud-group="${group}"]`).forEach(el => {
      el.classList.toggle('hud-dormant', !active);
      el.classList.toggle('hud-active', active);
    });
  }
  // Ensure panels visible during skill discovery (dormant handles dimming)
  // ... same logic as current setTutorialVisibility
}
```

#### Phase 3: Full Cleanup

- Delete [`TutorialSystem.js`](js/systems/TutorialSystem.js) (752 lines)
- Remove `TutorialStage` import from [`HUD.js`](js/ui/HUD.js:13)
- Remove `_tutorialBlocksAutopilot` from [`InputManager.js`](js/systems/InputManager.js:46)
- Remove `TUTORIAL_STAGE_CHANGED` listener from InputManager lines 102-108
- Rename `TUTORIAL_*` events to `SKILL_*` in [`Events.js`](js/core/Events.js:223-231)
- Remove skip button DOM and CSS
- Delete backward-compat `_emitTutorialCompat()` bridge

### E.4 Events to Add to [`Events.js`](js/core/Events.js)

```javascript
// === SKILLS (replaces TUTORIAL section) ===
SKILL_DISCOVERED:       'skill:discovered',       // { skillId, tier, hudGroup, name }
SKILL_PRACTICED:        'skill:practiced',         // { skillId }
SKILL_MASTERED:         'skill:mastered',          // { skillId }
SKILL_REMINDER:         'skill:reminder',          // { skillId, text }
SKILL_STATE_CHANGED:    'skill:stateChanged',      // { activeGroups: Set<string> }
SKILL_ALL_DISCOVERED:   'skill:allDiscovered',     // {} — all 33 skills found
SKILL_TIER_COMPLETE:    'skill:tierComplete',       // { tier }
SKILL_INPUT:            'skill:input',             // { skillId, context } — for non-keyboard triggers
```

**Retained (renamed in Phase 3):**
- `TUTORIAL_ARROW_INPUT` → `SKILL_ARROW_INPUT` (or keep, since [`InputManager`](js/systems/InputManager.js:151) emits it)
- `TUTORIAL_SCAN_INPUT` → `SKILL_SCAN_INPUT`
- `TUTORIAL_TAB_INPUT` → `SKILL_TAB_INPUT`
- `TUTORIAL_DEPLOY_INPUT` → `SKILL_DEPLOY_INPUT`

### E.5 Constants to Add to [`Constants.js`](js/core/Constants.js)

The `SKILLS` namespace (see §A.4 above) containing all tuning knobs. This follows the existing pattern where all balance values live in Constants.js.

### E.6 Existing Events the SkillsSystem Hooks Into

**Zero changes to [`InputManager.js`](js/systems/InputManager.js) needed.** The SkillsSystem listens to events that InputManager already emits:

| Existing Event | Skill Triggered | Source |
|---------------|-----------------|--------|
| [`TUTORIAL_ARROW_INPUT`](js/core/Events.js:226) | `awareness_look` | [`InputManager`](js/systems/InputManager.js:151) line 151 |
| [`TUTORIAL_SCAN_INPUT`](js/core/Events.js:229) | `sensing_scan` | InputManager |
| [`TUTORIAL_TAB_INPUT`](js/core/Events.js:230) | `sensing_target` | InputManager |
| [`TUTORIAL_DEPLOY_INPUT`](js/core/Events.js:231) | `collect_deploy` | InputManager |
| [`AUTOPILOT_ENGAGE`](js/core/Events.js:255) | `nav_autopilot` | [`AutopilotSystem`](js/systems/AutopilotSystem.js) |
| [`AUTOPILOT_DISENGAGE`](js/core/Events.js:256) | `nav_manual_thrust` (if reason=ARROW_INPUT) | AutopilotSystem |
| [`LASSO_FIRED`](js/core/Events.js:208) | `collect_lasso` | [`LassoSystem`](js/systems/LassoSystem.js) |
| [`LASSO_CAPTURED`](js/core/Events.js:210) | `collect_lasso_catch` | LassoSystem |
| [`LASSO_MISSED`](js/core/Events.js:212) | `collect_lasso_miss` | LassoSystem |
| [`ARM_CAPTURED`](js/core/Events.js:17) | `collect_arm_catch` | [`ArmManager`](js/entities/ArmManager.js) |
| [`CARGO_STORE`](js/core/Events.js:149) | `econ_salvage` | [`CargoSystem`](js/systems/CargoSystem.js) |
| [`FORGE_TOGGLE`](js/core/Events.js:160) | `econ_forge` | InputManager |
| [`FUEL_CYCLE`](js/core/Events.js:163) | `econ_fuel_cycle` | InputManager |
| [`TOOL_CYCLE`](js/core/Events.js:216) | `mastery_tool_cycle` | InputManager |
| [`POWER_BUS_SELECTED`](js/core/Events.js:141) | `mastery_power_mgmt` | [`PowerDistribution`](js/systems/PowerDistribution.js) |
| [`ARM_SELECT`](js/core/Events.js:32) | `mastery_arm_pilot` | InputManager |
| [`ARM_MANUAL_THRUST`](js/core/Events.js:28) | `mastery_arm_manual` | InputManager |
| [`ARM_DETACHED`](js/core/Events.js:199) | `mastery_detach` | ArmManager |
| [`EDT_DEPLOY`](js/core/Events.js:180) | `mastery_edt` | InputManager |
| [`TRAWL_START`](js/core/Events.js:173) | `mastery_trawl` | [`TrawlManager`](js/systems/TrawlManager.js) |
| [`DUAL_FIRE`](js/core/Events.js:290) | `mastery_dual_fire` | ArmManager |
| [`CAMERA_VIEW_CHANGE`](js/core/Events.js:41) | `nav_camera` | [`CameraSystem`](js/systems/CameraSystem.js) |
| [`THROTTLE_CHANGE`](js/core/Events.js:252) | `nav_throttle` | InputManager |

**New events needed from InputManager (minimal):**
- Scroll wheel → emit `SKILL_INPUT` with `{type: 'scroll'}` (for `awareness_zoom`) — OR listen to existing camera zoom behavior
- Mouse drag → emit `SKILL_INPUT` with `{type: 'mouseDrag'}` (for `awareness_mouse_look`) — OR listen to existing camera orbit events
- C key (comms) — already emits nothing; add to InputManager's keydown to emit `COMMS_TOGGLE` or listen in SkillsSystem
- N key (navsphere) — already handled; SkillsSystem can detect via NavSphere visibility events
- M key (orbit MFD) — same pattern
- B key (shop) — triggers state transition; SkillsSystem listens to `GAME_STATE_CHANGE` → `SHOP`

---

## F. Technical Architecture

### F.1 New Files

```
js/systems/SkillsSystem.js      — Core system: skill tracking, discovery, reminders, HUD bridge
js/ui/SkillsPane.js             — DOM overlay: skills pane render, animations, fade logic
```

**Two files only.** This matches the existing pattern where systems handle logic and UI files handle DOM. The [`TutorialSystem`](js/systems/TutorialSystem.js) has both logic and `_createUI()` in one file — we split that for clarity.

### F.2 SkillsSystem Class Design

```javascript
// js/systems/SkillsSystem.js

import { eventBus } from '../core/EventBus.js';
import { Events } from '../core/Events.js';
import { Constants } from '../core/Constants.js';
import { SkillsPane } from '../ui/SkillsPane.js';

/** Skill state enum */
export const SkillState = {
  UNDISCOVERED: 'UNDISCOVERED',
  DISCOVERED:   'DISCOVERED',
  PRACTICED:    'PRACTICED',
  MASTERED:     'MASTERED',
};

export class SkillsSystem {
  constructor() {
    /** @type {Map<string, SkillData>} All skills by ID */
    this.skills = new Map();

    /** @type {Set<string>} Active HUD groups based on discovered skills */
    this._activeGroups = new Set();

    /** @type {number} Session discovery count */
    this.discoveryCount = 0;

    /** @type {number} Timestamp of first discovery (ms) */
    this.firstDiscoveryTime = 0;

    /** @type {Array<string>} Pending discovery popup queue */
    this._discoveryQueue = [];

    /** @type {number} Cooldown remaining (seconds) */
    this._discoveryCooldown = 0;

    /** @type {number} Reminder check accumulator (1 Hz) */
    this._reminderAccum = 0;

    /** @type {number} Reminders shown in current cap window */
    this._reminderCapCount = 0;

    /** @type {number} Cap window start timestamp */
    this._reminderCapStart = 0;

    /** @type {number|null} Beauty timer handle */
    this._beautyTimer = null;

    /** @type {SkillsPane} UI component */
    this._pane = null;

    /** @type {Array<{event, handler}>} Registered listeners for cleanup */
    this._listeners = [];

    this._initSkills();
    this._pane = new SkillsPane();
    this._setupListeners();

    eventBus.on(Events.GAME_RESET, () => this.reset());
  }

  // --- Public API ---

  /** @returns {string} SkillState value */
  getSkillState(skillId) { /* ... */ }

  /** @returns {boolean} */
  hasDiscovered(skillId) { /* ... */ }

  /** @returns {Set<string>} Active HUD group names */
  getActiveHUDGroups() { return new Set(this._activeGroups); }

  /** @returns {number} */
  getDiscoveredCount() { /* ... */ }

  /** @returns {boolean} All 8 HUD groups activated */
  get allGroupsActive() { /* ... */ }

  /** @returns {object} Serializable state for persistence */
  getState() { /* ... */ }

  /** Restore from saved state */
  restore(data) { /* ... */ }

  /** Per-frame update (reminders, cooldowns, queue processing) */
  update(dt) { /* ... */ }

  /** Expert mode — mark all skills as MASTERED (for testing / veteran toggle) */
  setExpertMode() { /* ... */ }

  /** Reset all skills (new game) */
  reset() { /* ... */ }

  /** Cleanup DOM + listeners */
  dispose() { /* ... */ }

  // --- Internal ---

  /** @private Register skill input, discover or increment */
  _onSkillInput(skillId, context) { /* ... */ }

  /** @private First-time discovery of a skill */
  _discoverSkill(skillId) { /* ... */ }

  /** @private Process next queued discovery popup */
  _processDiscoveryQueue() { /* ... */ }

  /** @private Check spaced repetition reminders (called at 1 Hz) */
  _checkReminders(now) { /* ... */ }

  /** @private Determine feedback intensity */
  _getFeedbackIntensity(discoveryIndex) { /* ... */ }

  /** @private Is the system in blitz mode? */
  _isBlitzing() { /* ... */ }

  /** @private Check if the discovered skill's tier is now complete */
  _isTierComplete(skillId) { /* ... */ }

  /** @private Emit backward-compat TUTORIAL_STAGE_CHANGED (removed in Phase 3) */
  _emitTutorialCompat() { /* ... */ }
}
```

### F.3 SkillData Structure

```javascript
/**
 * Runtime state for a single skill.
 * Definition data comes from SKILL_DEFINITIONS constant.
 * Mutable state tracks discovery, use count, reminders.
 */
class SkillData {
  constructor(def) {
    // --- Immutable definition ---
    this.id = def.id;
    this.name = def.name;
    this.tier = def.tier;          // 'awareness'|'sensing'|'navigation'|'collection'|'economy'|'mastery'
    this.hudGroup = def.hudGroup;  // string or null
    this.codexEntry = def.codex;   // string or null
    this.commsMessage = def.comms; // string or null
    this.reminderText = def.reminder; // string or null
    this.practiceThreshold = def.practiceN || Constants.SKILLS.PRACTICE_COUNT_DEFAULT;
    this.masteryThreshold = def.masteryN || Constants.SKILLS.MASTERY_COUNT_DEFAULT;
    this.masteryMinTime = (def.masteryMinTime || Constants.SKILLS.MASTERY_MIN_TIME) * 1000; // ms

    // --- Mutable runtime state ---
    this.state = SkillState.UNDISCOVERED;
    this.useCount = 0;
    this.discoveredAt = 0;   // ms timestamp
    this.lastUsedAt = 0;     // ms timestamp
    this.commsShown = false;  // one-shot per session
    this.reminder = new SkillReminder();
  }
}
```

### F.4 SkillsPane Class Design

```javascript
// js/ui/SkillsPane.js

export class SkillsPane {
  constructor() {
    /** @type {HTMLElement} Main pane container */
    this._el = null;

    /** @type {HTMLElement} Edge glow element */
    this._glowEl = null;

    /** @type {boolean} Whether the explanatory header has been shown */
    this._headerShown = false;

    /** @type {number|null} Auto-hide timer */
    this._hideTimer = null;

    /** @type {boolean} Toggle state for I key */
    this._manualToggle = false;

    this._build();
    this._injectStyles();
    this._setupListeners();
  }

  // --- Public API ---

  /** Show discovery animation for a skill */
  showDiscovery(skillData, intensity) { /* ... */ }

  /** Show batch discovery (multiple at once) */
  showBatchDiscovery(skillIds) { /* ... */ }

  /** Show a spaced repetition reminder */
  showReminder(text) { /* ... */ }

  /** Toggle pane visibility (I key) */
  toggle() { /* ... */ }

  /** Force hide (ESC, state change) */
  hide() { /* ... */ }

  /** Update pane content from current skill states */
  render(skills, discoveredCount, totalCount) { /* ... */ }

  /** Cleanup DOM */
  dispose() { /* ... */ }

  // --- Internal ---

  /** @private Build DOM structure */
  _build() { /* ... */ }

  /** @private Inject CSS (skill states, animations) */
  _injectStyles() { /* ... */ }

  /** @private Create/show screen-edge glow */
  _showEdgeGlow() { /* ... */ }

  /** @private Auto-hide after duration */
  _scheduleHide(duration) { /* ... */ }

  /** @private Listen for gameplay input to dismiss */
  _setupListeners() { /* ... */ }
}
```

### F.5 Event Flow Diagram

```
┌─────────────────┐     ┌────────────────────┐
│  InputManager    │────→│   Existing Events   │
│  (key press)     │     │  (AUTOPILOT_ENGAGE, │
│                  │     │   LASSO_FIRED, etc.) │
└──────┬──────────┘     └────────┬─────────────┘
       │                         │
       │  TUTORIAL_ARROW_INPUT   │  AUTOPILOT_ENGAGE
       │  TUTORIAL_SCAN_INPUT    │  LASSO_CAPTURED
       │  TUTORIAL_TAB_INPUT     │  ARM_CAPTURED
       │  etc.                   │  CARGO_STORE
       │                         │  etc.
       └────────┬────────────────┘
                │
                ▼
     ┌──────────────────┐
     │   SkillsSystem   │
     │  _onSkillInput() │
     │  _discoverSkill()│
     └────┬──────┬──────┘
          │      │
     ┌────┘      └────────────────────┐
     │                                 │
     ▼                                 ▼
┌──────────────┐   SKILL_DISCOVERED   ┌──────────┐
│  SkillsPane  │◄─────────────────────│ EventBus │
│  (UI popup)  │                      │          │
└──────────────┘   SKILL_STATE_CHANGED│          │
                   ──────────────────→│          │
                                      └──┬───┬──┘
                                         │   │
                                         │   │
                              ┌──────────┘   └──────────┐
                              ▼                          ▼
                       ┌────────────┐            ┌──────────────┐
                       │    HUD     │            │ CodexSystem  │
                       │ setSkill   │            │ unlockEntry  │
                       │ Visibility │            │              │
                       └────────────┘            └──────────────┘
```

### F.6 Persistence Integration

[`PersistenceManager.js`](js/systems/PersistenceManager.js) uses the `PERSISTENCE_GATHER`/`PERSISTENCE_LOADED` pattern:

```javascript
// In SkillsSystem constructor
eventBus.on(Events.PERSISTENCE_GATHER, (saveData) => {
  saveData.skills = this.getState();
});

eventBus.on(Events.PERSISTENCE_LOADED, () => {
  const save = persistenceManager.peek();
  if (save && save.skills) {
    this.restore(save.skills);
  }
});
```

**`getState()` returns:**

```javascript
{
  version: 1,
  skills: [
    // Only non-UNDISCOVERED skills (sparse)
    { id: 'awareness_look', state: 'MASTERED', useCount: 47, discoveredAt: 1713100000000, lastUsedAt: 1713110000000 },
    { id: 'sensing_scan', state: 'PRACTICED', useCount: 12, discoveredAt: 1713100030000, lastUsedAt: 1713109000000 },
    // ...
  ],
  activeGroups: ['score-group', 'target-list', 'target-detail', 'fuel-group'],
}
```

**`restore()` handles returning players:**
- Skills are restored to their saved states
- HUD groups re-activated immediately (no re-discovery needed)
- Spaced repetition intervals are capped to prevent reminder flood after absence (max 10 min catchup from [`SKILLS_SYSTEM_DESIGN.md` §8.1](archive/SKILLS_SYSTEM_DESIGN.md))
- Discovery count is NOT restored (fresh session = fresh feedback calibration)

### F.7 GameFlowManager Integration

The SkillsSystem is instantiated in [`main.js`](js/main.js) alongside other systems. It communicates purely via EventBus — no `_refs` entry needed.

```javascript
// In main.js init()
import { SkillsSystem } from './systems/SkillsSystem.js';

// Replace: this.tutorialSystem = new TutorialSystem();
this.skillsSystem = new SkillsSystem();
```

[`GameFlowManager`](js/systems/GameFlowManager.js) does NOT reference SkillsSystem directly. The coupling points:
- `GAME_STATE_CHANGE` → SkillsSystem listens (for beauty timer, shop detection)
- `GAME_RESET` → SkillsSystem resets
- `PERSISTENCE_LOADED` → SkillsSystem restores
- The removal of `tutorialSystem` from `_refs` (it was already decoupled via EventBus at line 73)

### F.8 Shop Integration

Some skills relate to upgradeable capabilities. The SkillsSystem doesn't gate purchases, but shop upgrades can provide the context needed for soft-prerequisite skills:

| Upgrade | Enables Skill Context |
|---------|----------------------|
| Krypton/Argon fuel | `econ_fuel_cycle` — cycling shows different fuel option names |
| MPD Thruster | Unlocks MPD burst mode keys (not a skill — game capability) |
| V4 GSL Tether | Longer tether makes `mastery_detach` more relevant |
| Enhanced Sensors | More targets for `sensing_scan` to discover |

The relationship is organic: upgrades expand what the player can do, which creates more opportunities for skill discovery. No hard coupling needed.

---

## G. Implementation Phases

### G.1 Phase 1: Core Tracking + HUD Bridge (MVP)

**Goal:** Replace the linear tutorial with discovery-based tracking. Any key → reward. HUD lights up by skill.

**Estimated effort:** 2 sessions (~4-6 hours)

**Scope:**

- [ ] Create `js/systems/SkillsSystem.js` with all 33 skill definitions as data
- [ ] Implement `_initSkills()` with `SKILL_DEFINITIONS` constant (definition table)
- [ ] Implement `_onSkillInput()` → `_discoverSkill()` flow
- [ ] Listen to all existing EventBus events listed in §E.6 (zero InputManager changes)
- [ ] Emit `SKILL_DISCOVERED` and `SKILL_STATE_CHANGED` events
- [ ] Implement `_emitTutorialCompat()` bridge for backward compat
- [ ] HUD progressive luminance driven by `SKILL_STATE_CHANGED` (refactor away from stage numbers)
- [ ] Houston comms messages on first discovery (reuse `Events.COMMS_MESSAGE`)
- [ ] Codex unlocks on discovery via `Events.CODEX_UNLOCK_REQUEST`
- [ ] Score-group activation via GameFlowManager timer (5s after ORBITAL_VIEW)
- [ ] Feature flag in `main.js` to toggle between TutorialSystem and SkillsSystem
- [ ] `setExpertMode()` for testing (replaces `skip()`)
- [ ] Add `SKILLS` namespace to [`Constants.js`](js/core/Constants.js)
- [ ] Add skill events to [`Events.js`](js/core/Events.js)

**NOT in Phase 1:** Skills pane UI, spaced repetition, persistence, variable ratio feedback. Discovery is signaled via comms + HUD undim only.

**Testing:** Manual playtest — every key press produces either a comms message (first time) or natural game response (subsequent). HUD progressively lights up. No "nothing happened" moments.

**Test file:** `js/test/test-SkillsSystem.js` — test skill definitions, discovery logic, state transitions, HUD group computation. All Node-safe (no THREE.js, no DOM).

### G.2 Phase 2: Skills Pane UI

**Goal:** The visual skills pane that appears on discovery and can be toggled.

**Estimated effort:** 1-2 sessions (~3-4 hours)

**Scope:**

- [ ] Create `js/ui/SkillsPane.js` with DOM generation
- [ ] Tier-based layout with progress dots and skill names
- [ ] Skill line visual states: undiscovered, discovered, practiced, mastered
- [ ] New skill discovery animation (slide in, pulse, auto-fade)
- [ ] "First ever discovery" explanatory header (shown once)
- [ ] Screen-edge amber glow effect on discovery
- [ ] Discovery queue: min 3s gap, batch mode above 5 queued
- [ ] Flow protection: suppress during APPROACH/INTERACTION, fade on input, ESC → hide
- [ ] I key toggle in InputManager (add `Events.SKILLS_TOGGLE` or direct call)
- [ ] Mastered skills fade to near-invisible
- [ ] Tier completion visual (amber tier name pulse)

**Testing:** Discover 10 skills rapidly. Pane appears each time without visual chaos. Rapid-fire key mashing queues properly. K key toggles pane.

### G.3 Phase 3: Feedback Engine — Variable Ratio + Spaced Repetition

**Goal:** Polished feedback with variable ratio early game and spaced repetition reminders.

**Estimated effort:** 1-2 sessions (~3-4 hours)

**Scope:**

- [ ] Implement `SkillReminder` class with SM-2 variant algorithm
- [ ] 1 Hz reminder check in `update()` (not per-frame)
- [ ] Reminder format: one-line prompt at bottom-right (reuse prompt styling)
- [ ] Frequency cap enforcement (3 per 5 min)
- [ ] Active game state suppression (no reminders during APPROACH/INTERACTION)
- [ ] Skill state transitions: DISCOVERED → PRACTICED → MASTERED (use count + time thresholds)
- [ ] Variable ratio feedback for first 10 discoveries (`_getFeedbackIntensity()`)
- [ ] Three feedback levels: standard, enhanced, celebration
- [ ] Celebration overrides: `collect_lasso_catch`, tier completions
- [ ] Blitz detection (`_isBlitzing()`) → reduced feedback for veterans
- [ ] Audio: soft discovery chime (new procedural sound in `AudioSystem.playSkillDiscovery()`)
- [ ] Audio: ascending celebration tone for celebration-level discoveries

**Testing:** Play for 20 minutes. Skills used infrequently get gentle reminders. Skills used frequently stop reminding. Early game has varied feedback intensity.

### G.4 Phase 4: Persistence + Polish + Cleanup

**Goal:** Skills survive across sessions. Veterans get smooth experience. Tutorial system removed.

**Estimated effort:** 1-2 sessions (~3-4 hours)

**Scope:**

- [ ] Implement `getState()` / `restore()` persistence via PersistenceManager
- [ ] Return-after-absence handling: cap overdue reminders (§8.1 of design doc)
- [ ] Test save/load cycle: save game, reload, verify skills restored + HUD state correct
- [ ] Expert mode toggle on [`MenuScreen`](js/ui/MenuScreen.js) (optional, replaces "Skip Tutorial")
- [ ] Remove [`TutorialSystem.js`](js/systems/TutorialSystem.js) entirely (752 lines deleted)
- [ ] Remove `TutorialStage` import from [`HUD.js`](js/ui/HUD.js:13) line 13
- [ ] Remove backward-compat `_emitTutorialCompat()` and `TUTORIAL_STAGE_CHANGED` listener
- [ ] Remove `_tutorialBlocksAutopilot` from [`InputManager.js`](js/systems/InputManager.js:46)
- [ ] Update `TUTORIAL_*` events in [`Events.js`](js/core/Events.js:223-231) → rename or keep as legacy
- [ ] Remove skip button DOM from TutorialSystem
- [ ] "All skills discovered" celebration + codex entry
- [ ] Update [`HANDOFF.md`](HANDOFF.md), [`ARCHITECTURE.md`](ARCHITECTURE.md), [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md), [`GAME_DESIGN.md`](GAME_DESIGN.md) references
- [ ] Verify all 278 tests still pass (TutorialSystem tests need migration or removal)

**Testing:** Save game, close browser, reopen. Skills restored. Start new game — all fresh. Veteran pace detected, feedback minimal. Full playthrough with no tutorial system.

### G.5 Minimum Viable Version (Phases 1 + 2)

After Phases 1 and 2, the system is **fully functional as a tutorial replacement:**

✅ Every key press produces feedback (comms + HUD undim)
✅ HUD progressively reveals based on what the player has done
✅ Skills pane shows discovery progress
✅ No forced sequence — explore freely
✅ Beauty moment preserved (non-blocking)
✅ Codex entries unlock on discovery
✅ Backward-compatible with existing HUD system
✅ Feature flag allows rollback to old tutorial

This is enough to ship. Phases 3-4 are polish.

### G.6 Testing Strategy

**New test file:** `js/test/test-SkillsSystem.js`

**Node-safe tests (no THREE.js, no DOM):**

```javascript
// Suite: Skill definitions
describe('SkillsSystem definitions', () => {
  it('should have exactly 33 skills');
  it('should have unique IDs for all skills');
  it('should have valid tiers for all skills');
  it('should map every HUD-group skill to a valid group name');
  it('should have comms messages for all discovery skills');
});

// Suite: Skill state transitions
describe('SkillsSystem state machine', () => {
  it('should start all skills as UNDISCOVERED');
  it('should transition to DISCOVERED on first trigger');
  it('should not re-discover already-discovered skills');
  it('should increment useCount on repeat triggers');
  it('should transition to PRACTICED at threshold');
  it('should transition to MASTERED at threshold + time');
  it('should never go backwards in state');
});

// Suite: HUD group computation
describe('SkillsSystem HUD groups', () => {
  it('should have no active groups initially');
  it('should activate score-group via GameFlowManager timer');
  it('should activate target-list on sensing_scan');
  it('should activate multiple groups from multiple skills');
  it('should report allGroupsActive when all 8 are active');
});

// Suite: Discovery queue
describe('SkillsSystem discovery queue', () => {
  it('should queue discoveries within cooldown period');
  it('should batch when queue exceeds threshold');
  it('should process one at a time after cooldown');
});

// Suite: Spaced repetition
describe('SkillReminder', () => {
  it('should not remind before interval');
  it('should remind after interval');
  it('should grow interval on use before reminder');
  it('should shrink interval on reminder needed');
  it('should cap interval at maximum');
  it('should cap interval at minimum');
});

// Suite: Persistence
describe('SkillsSystem persistence', () => {
  it('should serialize only non-UNDISCOVERED skills');
  it('should restore skill states correctly');
  it('should restore active HUD groups');
  it('should cap overdue reminders on restore');
});

// Suite: Blitz detection
describe('SkillsSystem blitz', () => {
  it('should detect blitz when many skills discovered quickly');
  it('should not detect blitz at normal pace');
});
```

**Estimated:** ~30-40 tests in ~6 suites, all Node-safe.

---

## Appendix: Skill Definition Data

The complete skill definitions as they would appear in [`SkillsSystem._initSkills()`](js/systems/SkillsSystem.js).  This is the single source of truth for all 33 skills.

```javascript
const SKILL_DEFINITIONS = [
  // === TIER 1: AWARENESS ===
  // NOTE: awareness_beauty was removed in UX overhaul (2026-04-16).
  // Score-group is now activated by GameFlowManager timer, not a skill.
  {
    id: 'awareness_look', name: 'Look Around', tier: 'awareness',
    hudGroup: null, codex: 'keplerian_orbit',
    comms: 'Good. Use arrow keys to look around. Those contacts out there — that\'s your job.',
    reminder: '← ↑ ↓ → look around', practiceN: 10, masteryN: 50,
  },
  {
    id: 'awareness_zoom', name: 'Zoom Control', tier: 'awareness',
    hudGroup: null, codex: null,
    comms: 'Zoom adjusted. Use the scroll wheel to get a closer look at anything that catches your eye.',
    reminder: 'Scroll to zoom', practiceN: 5, masteryN: 20,
  },
  {
    id: 'awareness_mouse_look', name: 'Mouse Camera', tier: 'awareness',
    hudGroup: null, codex: null,
    comms: null, // silent — too minor
    reminder: null, practiceN: 5, masteryN: 20,
  },

  // === TIER 2: SENSING ===
  {
    id: 'sensing_scan', name: 'Quick Scan', tier: 'sensing',
    hudGroup: 'target-list', codex: null,
    comms: 'Scan complete. Contacts on your target list.',
    reminder: '[S] Scan for targets', practiceN: 3, masteryN: 15,
  },
  {
    id: 'sensing_deep_scan', name: 'Deep Scan', tier: 'sensing',
    hudGroup: 'target-list', codex: null,
    comms: 'Wide aperture scan initiated. Deeper analysis takes longer but finds more.',
    reminder: '[W] Deep scan', practiceN: 3, masteryN: 15,
  },
  {
    id: 'sensing_target', name: 'Target Lock', tier: 'sensing',
    hudGroup: 'target-detail', codex: 'delta_v',
    comms: 'Target locked. Now you can see what you\'re dealing with.',
    reminder: '[TAB] Cycle targets', practiceN: 5, masteryN: 20,
  },
  {
    id: 'sensing_analyze', name: 'Structural Analysis', tier: 'sensing',
    hudGroup: null, codex: null,
    comms: 'Wireframe analysis active. Cycle zones with Z to find capture points.',
    reminder: '[Z] Structural analysis', practiceN: 3, masteryN: 15,
  },
  {
    id: 'manage_codex', name: 'Tech Library', tier: 'manage',
    hudGroup: null, codex: null,
    comms: 'Tech Library opened. Everything you discover gets logged here.',
    reminder: '[L] Open Tech Library', practiceN: 2, masteryN: 10,
  },

  // === TIER 3: NAVIGATION ===
  {
    id: 'nav_autopilot', name: 'Autopilot', tier: 'navigation',
    hudGroup: 'fuel-group', codex: 'hohmann_transfer',
    comms: 'Autopilot engaged. Sit back — orbital mechanics does the work.',
    reminder: '[A] Autopilot to target', practiceN: 3, masteryN: 15,
  },
  {
    id: 'nav_autopilot_no_target', name: 'Autopilot (No Target)', tier: 'navigation',
    hudGroup: null, codex: null,
    comms: 'Autopilot needs a target. Press Tab to select one first.',
    reminder: 'Select a target first [TAB]', practiceN: null, masteryN: null,
  },
  {
    id: 'nav_camera', name: 'Camera Cycling', tier: 'navigation',
    hudGroup: null, codex: null,
    comms: 'Camera view changed. Cycle through views with V.',
    reminder: '[V] Cycle camera views', practiceN: 3, masteryN: 15,
  },
  {
    id: 'nav_throttle', name: 'Throttle Control', tier: 'navigation',
    hudGroup: null, codex: null,
    comms: 'Throttle adjusted. Fine-tune your burn intensity.',
    reminder: '[+/-] Adjust throttle', practiceN: 5, masteryN: 20,
  },
  {
    id: 'nav_manual_thrust', name: 'Manual Thrust', tier: 'navigation',
    hudGroup: null, codex: 'prograde_paradox',
    comms: 'Manual override. Remember — in orbit, thrusting forward makes you go higher, not faster.',
    reminder: null, practiceN: 5, masteryN: 30,
  },

  // === TIER 4: COLLECTION ===
  {
    id: 'collect_lasso', name: 'Lasso Cast', tier: 'collection',
    hudGroup: null, codex: 'kessler_syndrome',
    comms: 'Lasso deployed! Aim for close-range targets.',
    reminder: '[SPACE] Cast lasso', practiceN: 5, masteryN: 20,
  },
  {
    id: 'collect_lasso_miss', name: 'Lasso Miss Recovery', tier: 'collection',
    hudGroup: null, codex: null,
    comms: 'Missed! Get closer and try again. Watch the range indicator.',
    reminder: 'Get closer to target', practiceN: null, masteryN: null,
  },
  {
    id: 'collect_lasso_catch', name: 'First Catch!', tier: 'collection',
    hudGroup: null, codex: null,
    comms: 'First catch confirmed! Welcome to the cleanup crew, Cowboy.',
    reminder: null, practiceN: 3, masteryN: 10,
  },
  {
    id: 'collect_deploy', name: 'Tool Deploy', tier: 'collection',
    hudGroup: 'arms-group', codex: 'feep_thruster',
    comms: 'Tool deployed. The right tool for the right job.',
    reminder: '[D] Deploy tool', practiceN: 3, masteryN: 15,
  },
  {
    id: 'collect_arm_catch', name: 'Arm Capture', tier: 'collection',
    hudGroup: 'cargo-group', codex: 'space_tether',
    comms: 'Arm capture confirmed. Reeling in the catch.',
    reminder: null, practiceN: 3, masteryN: 10,
  },

  // === TIER 5: ECONOMY ===
  {
    id: 'econ_salvage', name: 'Salvage Stowed', tier: 'economy',
    hudGroup: 'cargo-group', codex: 'space_aluminum',
    comms: 'Good salvage, Cowboy. Metals stowed in cargo hold.',
    reminder: null, practiceN: 3, masteryN: 10,
  },
  {
    id: 'econ_forge', name: 'Forge Operation', tier: 'economy',
    hudGroup: null, codex: null,
    comms: 'Forge loaded. Orbital metallurgy — turning space junk into resources.',
    reminder: '[R] Open forge', practiceN: 2, masteryN: 10,
  },
  {
    id: 'econ_fuel_cycle', name: 'Fuel Cycling', tier: 'economy',
    hudGroup: null, codex: 'specific_impulse_explained',
    comms: 'Propellant type changed. Different fuels trade thrust for efficiency.',
    reminder: '[T] Cycle propellant', practiceN: 3, masteryN: 15,
  },
  {
    id: 'econ_shop', name: 'Shop Access', tier: 'economy',
    hudGroup: null, codex: null,
    comms: 'Supply depot opened. Spend wisely — every upgrade changes the mission.',
    reminder: '[B] Open supply depot', practiceN: 2, masteryN: 10,
  },

  // === TIER 6: MASTERY ===
  {
    id: 'mastery_tool_cycle', name: 'Tool Cycling', tier: 'mastery',
    hudGroup: null, codex: null,
    comms: 'Tools cycled. Match the tool to the target — Spinners for small, Weavers for big.',
    reminder: '[`] Cycle tools', practiceN: 5, masteryN: 20,
  },
  {
    id: 'mastery_power_mgmt', name: 'Power Management', tier: 'mastery',
    hudGroup: 'power-group', codex: 'power_bus_management',
    comms: 'Power bus selected. Every watt is a decision.',
    reminder: '[Shift+1/2/3] Power buses', practiceN: 3, masteryN: 15,
  },
  {
    id: 'mastery_arm_pilot', name: 'Arm Piloting', tier: 'mastery',
    hudGroup: null, codex: null,
    comms: 'ARM PILOT engaged. You\'re flying the daughter now.',
    reminder: '[P] or [1-6] Pilot arm', practiceN: 2, masteryN: 10,
  },
  {
    id: 'mastery_arm_manual', name: 'Manual WASD in Arm', tier: 'mastery',
    hudGroup: null, codex: null,
    comms: 'Manual thrust on daughter arm. Gentle inputs — FEEP thrusters are precise.',
    reminder: 'WASD for arm thrust', practiceN: 5, masteryN: 20,
  },
  {
    id: 'mastery_detach', name: 'Tether Detach', tier: 'mastery',
    hudGroup: null, codex: null,
    comms: 'Tether severed. Bold move, Cowboy. That arm\'s on its own.',
    reminder: null, practiceN: 1, masteryN: 5,
    safetyGate: { minCatches: 2, lockedComms: 'Detach is a one-way trip, Cowboy. Get some catches under your belt first.' },
  },
  {
    id: 'mastery_edt', name: 'EDT Deploy', tier: 'mastery',
    hudGroup: null, codex: 'edt_propulsion',
    comms: 'Electrodynamic tether deployed. Free thrust from Earth\'s magnetic field.',
    reminder: '[Y] EDT propulsion', practiceN: 2, masteryN: 10,
  },
  {
    id: 'mastery_comms', name: 'Comms Menu', tier: 'mastery',
    hudGroup: null, codex: null,
    comms: 'Comms channel open. Use number keys to issue commands.',
    reminder: '[C] Comms menu', practiceN: 3, masteryN: 15,
  },
  {
    id: 'mastery_navsphere', name: 'NavSphere Toggle', tier: 'mastery',
    hudGroup: null, codex: null,
    comms: 'NavSphere activated. Your 3D radar — vertical stalks show altitude offset.',
    reminder: '[N] NavSphere', practiceN: 2, masteryN: 10,
  },
  {
    id: 'mastery_orbit_mfd', name: 'Orbit MFD', tier: 'mastery',
    hudGroup: null, codex: null,
    comms: 'Orbit display opened. Plan your transfers visually.',
    reminder: '[M] Orbit display', practiceN: 2, masteryN: 10,
  },
  {
    id: 'mastery_trawl', name: 'Trawl Deploy', tier: 'mastery',
    hudGroup: null, codex: 'orbital_inclination',
    comms: 'Trawl net deployed. Cast wide, catch many.',
    reminder: '[Shift+G] Deploy trawl', practiceN: 2, masteryN: 10,
    safetyGate: { minCatches: 1, lockedComms: 'Trawl operations require experience. Complete a capture first.' },
  },
  {
    id: 'mastery_dual_fire', name: 'Dual Fire', tier: 'mastery',
    hudGroup: null, codex: 'recoil_cancellation',
    comms: 'Dual fire! Equal and opposite — Newton would approve.',
    reminder: null, practiceN: 2, masteryN: 10,
  },
];
```

---

## H. Pre-Implementation Analysis — Gaps, Risks, and Resolutions

### H.1 Event Coverage Gap — "Zero InputManager Changes" Is Inaccurate

The document claims "zero changes to [`InputManager.js`](js/systems/InputManager.js) in Phase 1." **This is wrong.** Seven skills have no existing EventBus event to trigger discovery:

| Skill | Key/Action | Problem | Resolution |
|-------|-----------|---------|------------|
| `awareness_zoom` | Scroll wheel | [`CameraSystem._onWheel()`](js/systems/CameraSystem.js:758) handles zoom but emits no event | Add `CAMERA_ZOOM` event from CameraSystem, OR add `SKILL_INPUT` emit from InputManager for wheel |
| `awareness_mouse_look` | Mouse drag | [`CameraSystem._computeOrbit()`](js/systems/CameraSystem.js:530) handles drag, no event | Listen to `CAMERA_VIEW_CHANGE` when view is ORBIT (proxy), OR add mouse-drag event |
| `sensing_analyze` | Z key | [`DebrisWireframe`](js/ui/DebrisWireframe.js) handles Z — [`WIREFRAME_ASSESSED`](js/core/Events.js:249) fires only after ALL zones cycled | Add `WIREFRAME_ZONE_CYCLED` event for first Z press, OR SkillsSystem listens to WIREFRAME_ASSESSED |
| `mastery_comms` | C key | InputManager handles C directly — no event emitted for comms toggle | Add `COMMS_TOGGLE` event from InputManager's C-key handler |
| `mastery_navsphere` | N key | InputManager handles N directly — no event | Add `NAVSPHERE_TOGGLE` event |
| `mastery_orbit_mfd` | M key | InputManager handles M directly — no event | Add `ORBIT_MFD_TOGGLE` event |
| `nav_autopilot_no_target` | A key (no target) | [`AutopilotSystem`](js/systems/AutopilotSystem.js) only emits [`AUTOPILOT_ENGAGE`](js/core/Events.js:255) on success — no event for failure | Add `AUTOPILOT_NO_TARGET` event from AutopilotSystem when engage fails due to no target |

**Resolution:** Phase 1 **does** require small InputManager/system changes — 5-7 new event emissions (1 line each). This is minimal but not zero. Update the Phase 1 scope to include these. The alternative (SkillsSystem adding its own `keydown` listener) violates the EventBus communication rule.

### H.2 Safety Gate Enforcement — Where Does the Gate Check Live?

The architecture says safety-gated keys (X for detach, Shift+G for trawl) should be blocked before the gate condition is met. But the SkillsSystem currently **listens to events after the action happens** (e.g., `ARM_DETACHED`). By the time `ARM_DETACHED` fires, the arm is already gone.

**The gate check must happen BEFORE the action, not after.**

**Resolution options:**

| Approach | Pros | Cons | Chosen |
|----------|------|------|--------|
| SkillsSystem emits `SKILL_GATE_UNLOCKED` event; InputManager listens and sets flag | Clean decoupling via EventBus | InputManager needs to know about skills | ✅ **Yes** |
| InputManager calls `skillsSystem.isGateOpen()` | Simple predicate | Direct ref coupling (violates pattern) | ❌ |
| SkillsSystem intercepts keydown directly | No InputManager changes | Violates EventBus-only rule | ❌ |

**Implementation:**

```javascript
// SkillsSystem — when catches reach threshold, unlock gates
eventBus.on(Events.LASSO_CAPTURED, () => this._checkSafetyGates());
eventBus.on(Events.ARM_CAPTURED, () => this._checkSafetyGates());

_checkSafetyGates() {
  const catches = this._totalCatches;  // track from LASSO_CAPTURED + ARM_CAPTURED
  for (const [skillId, def] of this.skills) {
    if (def.safetyGate && !def.gateUnlocked) {
      if (catches >= def.safetyGate.minCatches) {
        def.gateUnlocked = true;
        eventBus.emit(Events.SKILL_GATE_UNLOCKED, { skillId });
      }
    }
  }
}

// InputManager — listen for gate unlocks
eventBus.on(Events.SKILL_GATE_UNLOCKED, ({ skillId }) => {
  if (skillId === 'mastery_detach') this._detachGateOpen = true;
  if (skillId === 'mastery_trawl') this._trawlGateOpen = true;
});

// In InputManager X-key handler — BEFORE calling detach:
if (!this._detachGateOpen) {
  eventBus.emit(Events.COMMS_MESSAGE, {
    text: 'Detach is a one-way trip, Cowboy. Get some catches under your belt first.',
    priority: 'warning',
  });
  return; // block the action
}
```

**New event needed:** `SKILL_GATE_UNLOCKED: 'skill:gateUnlocked'` — add to [`Events.js`](js/core/Events.js).

### H.3 SkillData Class Missing `safetyGate` Field

The [`SkillData`](SKILLS_ARCHITECTURE.md) class in §F.3 doesn't include the `safetyGate` property that was added to `SKILL_DEFINITIONS` in the appendix. Add:

```javascript
// In SkillData constructor:
this.safetyGate = def.safetyGate || null;   // { minCatches: N, lockedComms: string }
this.gateUnlocked = !def.safetyGate;        // true if no gate, false if gated
```

### H.4 Expanded View Conflicts with Other Overlays

The expanded skill tree pauses the game and shows a centered overlay. Other systems do the same: [`CodexViewerUI`](js/ui/CodexViewerUI.js), [`ShopScreen`](js/ui/ShopScreen.js), pause overlay.

**Conflict scenarios:**
- Player presses `I` while codex is open → both overlays visible?
- Player presses `L` while expanded skills are open → open codex too?
- Player presses `B` while expanded skills are open → go to shop?

**Resolution:** The expanded skill tree view MUST suppress all other key handling (same as codex interceptor at [`InputManager._handleKeyDown()`](js/systems/InputManager.js:155) line 155). When expanded:
- Only `ESC` and `I` (close) are active
- Codex `📖` links route through skill tree (close tree → open codex)
- `L`, `B`, etc. are suppressed

Add this to the SkillsPane contract:
```javascript
/** @returns {boolean} Whether expanded mode is active (InputManager should check) */
isExpanded() { return this._expanded; }
```

And in InputManager, add early-return check:
```javascript
// Near line 155, after codex intercept:
if (d.skillsPane && d.skillsPane.isExpanded()) {
  if (e.code === 'KeyI' || e.code === 'Escape') {
    d.skillsPane.hide();
    e.preventDefault();
  }
  return; // block all other keys
}
```

**This requires SkillsPane as a dependency in InputManager** — or alternatively, SkillsPane handles its own key capture like CodexViewerUI does (capture-phase listener).

**Recommended:** SkillsPane adds its own `document.addEventListener('keydown', handler, true)` capture-phase listener when expanded (matching [`CodexViewerUI`](js/ui/CodexViewerUI.js) pattern). No InputManager coupling needed.

### H.5 Score-Group Timer (Previously `awareness_beauty`)

The `awareness_beauty` skill was removed in the UX overhaul (2026-04-16). The score-group HUD panel is now activated by a direct timer in [`GameFlowManager`](js/systems/GameFlowManager.js), which fires 5 seconds after entering ORBITAL_VIEW. This eliminates the race condition concerns that existed with the old SkillsSystem-based beauty timer.

### H.6 `_tutorialBlocksAutopilot` Removal Timing

[`InputManager`](js/systems/InputManager.js:46) line 46 has `_tutorialBlocksAutopilot` which prevents autopilot before tutorial stage 4. In the skills system, autopilot should ALWAYS be available (pressing A with no target is a teaching moment). But removing this flag in Phase 1 could affect backward compat if the feature flag switches back to TutorialSystem.

**Resolution:** In Phase 1, when `USE_SKILLS_SYSTEM = true`, the SkillsSystem emits `TUTORIAL_STAGE_CHANGED` with `{ stage: 9 }` (FREE_PLAY) immediately on construction. This tells InputManager that autopilot is allowed. The `_tutorialBlocksAutopilot` flag resets to `false`. No InputManager code change needed in Phase 1.

### H.7 Catch Count Tracking for Safety Gates

The SkillsSystem needs to track total catches for safety gate checks. The existing [`TutorialSystem.totalCatches`](js/systems/TutorialSystem.js:34) does this, counting both `ARM_CAPTURED` and `LASSO_CAPTURED`. The new SkillsSystem must replicate this counter:

```javascript
// In SkillsSystem constructor:
this._totalCatches = 0;

eventBus.on(Events.ARM_CAPTURED, () => { this._totalCatches++; this._checkSafetyGates(); });
eventBus.on(Events.LASSO_CAPTURED, () => { this._totalCatches++; this._checkSafetyGates(); });
```

**Persistence consideration:** `_totalCatches` should be included in `getState()` so that returning players don't have their gates re-locked:

```javascript
getState() {
  return {
    version: 1,
    totalCatches: this._totalCatches,
    skills: [...],
    activeGroups: [...],
  };
}
```

### H.8 Spaced Repetition Timing Uses Real Time vs Game Time

The SM-2 reminder algorithm uses `Date.now()` (real time). But game time runs at 10× (`TIME_SCALE_GAMEPLAY`) or 60× (`TIME_SCALE_TRANSFER`) during autopilot transit. A 2-minute real-time reminder interval corresponds to 20-120 minutes of game time.

**Is this correct?** Yes — the reminders are for the **player's** memory, not in-game time. If the player hasn't pressed S for 2 real minutes, they might have forgotten the scan key regardless of how much game time passed. Real-time tracking is appropriate.

### H.9 Tier Color Accessibility

The green→cyan→blue→violet→purple progression may be hard to distinguish for colorblind players (particularly deuteranopia: green/cyan confusion, protanopia: blue/violet confusion).

**Mitigation:** Each tier ALSO has a unique icon/prefix in the expanded view, and tier headers are labeled with text. The colors are supplementary, not the sole differentiator. The symbol progression (`○ → ● → ✓ → ★`) is colorblind-safe.

### H.10 Discovery Count in `nav_autopilot_no_target`

`nav_autopilot_no_target` is listed as having `practiceN: null, masteryN: null` — it can never be PRACTICED or MASTERED. This means it stays DISCOVERED forever and would accumulate spaced repetition reminders indefinitely. But its reminder text is *"Select a target first [TAB]"* — useful contextually but annoying as a recurring reminder.

**Resolution:** Skills with `practiceN: null` should auto-advance to PRACTICED after 1 use (the teaching moment happened) and to MASTERED after 3 uses (they clearly know this). OR mark them as `noReminder: true` — they never trigger spaced repetition. The latter is cleaner.

Add a `noReminder` field to SkillData:
```javascript
this.noReminder = def.noReminder || false;  // true for "attempt" skills
```

Skills that should be `noReminder: true`:
- `nav_autopilot_no_target`
- `collect_lasso_miss`
- `awareness_mouse_look` (too minor)

### H.11 Test Impact — Existing 278 Tests

The 278 existing tests are in 9 files covering EventBus, GameState, Constants, OrbitalMechanics, ScoringSystem, PowerDistribution, CollisionAvoidance, and Crossbow Arms/Constants. None test TutorialSystem directly.

**Risk:** Zero. No existing tests will break from adding SkillsSystem. The feature flag means TutorialSystem code is simply not instantiated, not modified.

**Phase 3 risk (deletion):** If any module imports `TutorialStage` from TutorialSystem:
- [`HUD.js`](js/ui/HUD.js:13) line 13 — imports `TutorialStage` for `setTutorialVisibility()`. Must be migrated before deletion.
- No test files import TutorialSystem.

### H.12 Missing: Tutorial Debris Spawning

The current tutorial spawns guaranteed debris near the player via [`TUTORIAL_STAGE_REQUIREMENTS`](js/entities/DebrisField.js:46) in DebrisField. The skills system has no stages, so this debris spawning mechanism needs adaptation.

**Resolution options:**
1. **Keep TUTORIAL_STAGE_REQUIREMENTS as-is** — SkillsSystem emits `TUTORIAL_STAGE_CHANGED` via the compat bridge. When target-list group activates (equiv stage 2), DebrisField spawns nearby debris. When arms-group activates (equiv stage 7), DebrisField spawns close-range debris.
2. **New SKILL_STATE_CHANGED listener in DebrisField** — instead of stage numbers, DebrisField listens for specific HUD groups activating and spawns appropriate debris.
3. **Always spawn tutorial debris at game start** — simplest; spawn 5 debris at 0.5-1.8 km when entering ORBITAL_VIEW, regardless of skill state.

**Recommended:** Option 1 in Phase 1 (compat bridge handles it). Migrate to Option 2 in Phase 3 cleanup.

### H.13 Missing: Scan Reward for First Scan

The current tutorial awards $50 for the first scan via [`SensorSystem._completeScan()`](js/systems/SensorSystem.js:349) → [`SCORING_AWARD`](js/systems/SensorSystem.js:364). This is handled by SensorSystem, not TutorialSystem, so it **continues to work** with the skills system. No migration needed.

### H.14 Edge Case: Multiple ORBITAL_VIEW Transitions

The beauty timer fires on `GAME_STATE_CHANGE → ORBITAL_VIEW`. But the game can transition to ORBITAL_VIEW multiple times (e.g., after visiting SHOP, after GAME_OVER → retry). Each transition would restart the beauty timer.

**Resolution:** The score-group timer is now a one-shot in [`GameFlowManager`](js/systems/GameFlowManager.js) that fires 5s after first ORBITAL_VIEW entry. This is simpler and eliminates the race condition concerns that existed with the old SkillsSystem-based beauty timer approach.

### H.15 Implementation Risk Summary

| Risk | Severity | Phase | Mitigation |
|------|----------|-------|-----------|
| 7 skills need new events (not zero InputManager changes) | 🟡 Medium | 1 | Add 5-7 small event emissions to InputManager / CameraSystem / AutopilotSystem |
| Safety gate check must precede action, not follow event | 🔴 High | 1 | `SKILL_GATE_UNLOCKED` event pattern; InputManager checks gate flags |
| Expanded view conflicts with codex/shop overlays | 🟡 Medium | 2 | Capture-phase keydown listener in SkillsPane (match CodexViewerUI pattern) |
| Tutorial debris spawning needs compat bridge | 🟡 Medium | 1 | Compat bridge emits TUTORIAL_STAGE_CHANGED; DebrisField works unchanged |
| `nav_autopilot_no_target` needs new AutopilotSystem event | 🟢 Low | 1 | Add `AUTOPILOT_NO_TARGET` or `AUTOPILOT_ENGAGE_FAILED` event |
| Attempt skills accumulate stale reminders | 🟢 Low | 3 | Add `noReminder` field; skip spaced repetition for teaching-moment skills |
| `_tutorialBlocksAutopilot` flag needs clearing in Phase 1 | 🟢 Low | 1 | SkillsSystem emits `TUTORIAL_STAGE_CHANGED { stage: 9 }` on construction |

---

## Decision Log

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Show undiscovered tier names | ✅ Show tiers + dot count | Hide undiscovered tiers | Creates gentle exploration incentive without being prescriptive |
| Persistent skills button on HUD | ❌ No button | Small icon | Pane is contextual reward, not a chore. `I` key toggle suffices |
| Veteran new game | Fresh skills + blitz detection | Pre-populate from save | Fresh sense of progression; blitz auto-detects skill level |
| Skip button | ❌ Removed | Keep as "Expert Mode" | No skip needed — system is enjoyable, not an obstacle |
| Audio on discovery | New procedural chime | Reuse click | Skill discovery deserves its own audio identity, distinct from UI click |
| Two files vs one | ✅ SkillsSystem.js + SkillsPane.js | Single file (like TutorialSystem) | Separation of logic and DOM follows project direction |
| InputManager changes | Zero changes in Phase 1 | Emit new SKILL_INPUT events | Listen to existing events; rename TUTORIAL_* → SKILL_* in Phase 3 |
| Beauty moment blocking | ❌ No blocking | Block input for 5s | Any input during beauty window triggers that skill AND beauty fires on timer |
| **Safety gates for destructive skills** | ✅ Gate detach (≥2 catches) + trawl (≥1 catch) | No gates at all | Newbie pressing X in minute 1 shouldn't lose their fleet; gate is minimal (catch count), not a quest |
| **Tier color progression** | ✅ Green→Cyan→Blue→Violet→Purple | Single color for all tiers | Visual depth communicates progression; unlocking first purple skill *feels* advanced |
| **Clickable codex links** | ✅ `📖` icon in expanded view opens codex | No codex links in pane | Supports "learn by reading" players; codex integration is already built |
| **Expandable full skill tree** | ✅ Click header → centered overlay, ESC returns | Pane is compact-only | Players who want to study progress or plan exploration need a full view; pauses game like shop/codex |

---

*Space Cowboy — Skills Discovery Architecture (33 skills)*
*"Every key press is a reward. Every discovery is a lesson. Safety gates protect only what's irreversible. Just play."*
