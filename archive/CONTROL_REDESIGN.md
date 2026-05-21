# Control Scheme & Tutorial Redesign — Autopilot-First Paradigm

> **Status:** Design document — not yet implemented  
> **Date:** 2026-04-13 (Rev 2 — deep redesign)  
> **Supersedes:** Current WASD-thrust + backtick-autopilot scheme  
> **Philosophy:** Autopilot is primary navigation. WASD becomes a command cluster. Free flight is a 1% mastery skill — the game never requires it.

### Design North Star

> Manual piloting to debris in orbit is counterintuitive and VERY difficult for new pilots. Delta-V is a critical resource. Free flight is not practical for most pilots — just frustrating and inefficient. Let pilots enjoy treasure hunting, upgrading, attaboys from Houston, engaging missions, plate spinning, and resource management. Players should quickly realize that autopilot is great for piloting to one target, but efficiently clearing a debris field requires tactical and strategic decisions.

---

## Table of Contents

1. [Complete Key Binding Map](#1-complete-key-binding-map)
2. [WASD Command Definitions](#2-wasd-command-definitions)
3. [Auto-Tool Selection System](#3-auto-tool-selection-system)
4. [Scan System Design — Treasure Hunting](#4-scan-system-design--treasure-hunting)
5. [Three Additional Essential Keys](#5-three-additional-essential-keys)
6. [Tutorial: Curiosity-Driven Progressive Discovery](#6-tutorial-curiosity-driven-progressive-discovery)
7. [Arrow Key Rotation Rate](#7-arrow-key-rotation-rate)
8. [Manual Thrust Policy — The 1% Skill](#8-manual-thrust-policy--the-1-skill)
9. [File-by-File Change Impact](#9-file-by-file-change-impact)
10. [Risk Assessment](#10-risk-assessment)

---

## 1. Complete Key Binding Map

### Primary Command Cluster (WASD — New)

| Key | Normal Mode | Arm Pilot Mode | Mnemonic |
|-----|-------------|----------------|----------|
| **A** | **Autopilot** toggle | Arm thrust left | **A**utopilot |
| **S** | **Scan** (quick ping) | Arm thrust back | **S**can |
| **W** | **Wide scan** (deep analysis) | Arm thrust forward | **W**ide aperture |
| **D** | **Deploy** recommended tool | Arm thrust right | **D**eploy |

### Essential Companion Keys (New/Elevated)

| Key | Function | Mnemonic |
|-----|----------|----------|
| **` (Backtick)** | **Cycle tool/arm** — MW2 weapon cycle through loadout | Next weapon |
| **V** | **View cycle** — COMMAND → TACTICAL → OVERVIEW | **V**iew |
| **F** | **Focus action** — context-sensitive "smart do" | **F**ocus / Fire |

### Navigation & Targeting

| Key | Function | Notes |
|-----|----------|-------|
| **←→↑↓** | Pitch/Yaw rotation (0.2 rad/s) | Reduced from 0.3 — deliberate, spacey |
| **Tab** | Cycle target selection | Auto-recommends best tool (§3) |
| **Space** | Fire lasso / deploy net (arm pilot) | Unchanged |
| **Enter** | Begin approach (orbital view) | Unchanged |

### Arm Operations

| Key | Function | Notes |
|-----|----------|-------|
| **1–6** | Deploy/select specific arm + enter arm pilot | Existing — for manual control |
| **7** | Return to mothership view | Existing |
| **P** | Toggle arm pilot mode | Existing |

### Retained System Keys (Unchanged)

| Key | Function | Key | Function |
|-----|----------|-----|----------|
| **Escape** | Pause / back | **B** | Shop |
| **C** | Comms panel | **N** | NavSphere |
| **G** | Deploy arm (secondary) | **H** | Recall all arms |
| **R** | Forge toggle | **T** | Fuel type cycle |
| **M** | MPD toggle / orbit MFD | **L** | Codex library |
| **X** | Tether detach | **Y** | EDT toggle |
| **Z / Shift+Z** | Wireframe zone cycle | **+/−** | Throttle |
| **Shift+1/2/3** | Power bus select | **[ ]** | Power bus adjust |
| **Ctrl+D** | Debug overlay | **Ctrl+Shift+D** | Deorbit sacrifice |

### Removed

| Key | Old Function | Replacement |
|-----|--------------|-------------|
| Q | Vertical thrust +y | **Unbound** (future use) |
| E | Vertical thrust −y | **Unbound** (future use) |
| WASD (normal) | Mothership thrust | Command cluster (§2) |
| Shift+WASD (normal) | Cold gas thrust | Autopilot handles navigation |

---

## 2. WASD Command Definitions

### Core Principle: Discrete Commands, Not Continuous Input

Every WASD key is a **keydown press** action — tap to do, not hold to thrust. This is the fundamental shift: WASD goes from analog stick to command palette.

### Context Switch (Two Modes)

The WASD cluster has two behaviors gated by [`armPilotMode`](js/systems/InputManager.js:21):

```
┌─────────────────────────────────────────────┐
│  armPilotMode === false (DEFAULT)            │
│  A = Autopilot toggle                        │
│  S = Quick Scan                              │
│  W = Wide Scan                               │
│  D = Deploy recommended tool                 │
├─────────────────────────────────────────────┤
│  armPilotMode === true (ARM PILOT)           │
│  W/A/S/D = Arm thrust directions (unchanged) │
│  Shift+WASD = Fine arm steering              │
└─────────────────────────────────────────────┘
```

This is the **same context-switch pattern** already in [`processInput()`](js/systems/InputManager.js:810). The only change is what WASD does in normal mode.

### Command Definitions

| Key | Name | Trigger | Cooldown | Power | Effect |
|-----|------|---------|----------|-------|--------|
| **A** | Autopilot | keydown toggle | None | None | [`AutopilotSystem.toggle()`](js/systems/AutopilotSystem.js:91) |
| **S** | Quick Scan | keydown once | 3s | 10 Wh | Resolves selected target to MEDIUM data level |
| **W** | Wide Scan | keydown → 2s channel | 12s | 30 Wh | Resolves target to CLOSE + reveals hidden debris |
| **D** | Deploy | keydown once | 1s debounce | None | Fires auto-recommended tool at selected target |

---

## 3. Auto-Tool Selection System

### The MW2 Weapon Paradigm

**Problem:** New players face 8+ arms, lasso, trawl — how do they know what to use?

**Solution:** When the player selects a target (Tab), the game **auto-recommends** the best tool. Pressing D deploys it. Pressing ` cycles to alternatives. Just like MW2's weapon auto-select vs manual weapon wheel.

### How Auto-Recommendation Works

On `TARGET_SELECTED` event, the system evaluates:

```javascript
function recommendTool(target, playerPos, armManager, lassoSystem) {
    const distanceM = target.distanceKm * 1000;
    const mass = target.mass || 1;
    
    // Priority 1: Lasso for small stuff close by
    if (mass <= Constants.LASSO_MAX_CAPTURE_MASS && distanceM <= Constants.LASSO_RANGE * 1.5) {
        return { type: 'LASSO', reason: 'Close-range fragment — quick grab' };
    }
    
    // Priority 2: Spinner for small-medium debris
    if (mass <= Constants.SPINNER_MAX_CAPTURE_MASS) {
        const spinner = armManager.findAvailableArm('spinner');
        if (spinner) return { type: 'SPINNER', armIndex: spinner.index, 
                              reason: 'Small debris — Spinner bolt' };
    }
    
    // Priority 3: Weaver for large debris
    if (mass <= Constants.WEAVER_MAX_CAPTURE_MASS) {
        const weaver = armManager.findAvailableArm('weaver');
        if (weaver) return { type: 'WEAVER', armIndex: weaver.index,
                             reason: 'Large target — Weaver bolt' };
    }
    
    // Priority 4: Trawl for clusters
    if (target.clusterSize && target.clusterSize >= 3) {
        return { type: 'TRAWL', reason: 'Dense cluster — deploy trawl net' };
    }
    
    // Fallback: best available arm
    const any = armManager.findAvailableArm(null);
    return any ? { type: any.armType.toUpperCase(), armIndex: any.index,
                   reason: 'Best available arm' } 
               : { type: 'NONE', reason: 'No tools available' };
}
```

### Backtick Cycling (MW2 Weapon Wheel)

Pressing **`** cycles through all available tools for the current target:

```
Tab selects: Defunct Satellite (340 kg, 2.4 km away)
Auto-recommend: WEAVER-1 ✓ (large mass, needs big net)

Player presses `:
→ WEAVER-1 ✓  →  WEAVER-2  →  WEAVER-3  →  SPINNER-1 ⚠  →  LASSO ✗  →  TRAWL  →  WEAVER-1 ✓
                                                (too small)    (too far)
```

**HUD indicator:** A small weapon-style icon near the crosshair or target panel showing:
- Current selected tool name + icon
- Suitability: **✓** green (optimal), **⚠** yellow (workable), **✗** red (unsuitable but allowed)
- Available count: "WEAVER 2/3 remaining"

### Why This Is Brilliant for Learning

| Player Level | Behavior | What They Learn |
|-------------|----------|-----------------|
| **Newbie (catches 1-5)** | Always press D (auto-pick) | Tools exist. Captures happen. Dopamine. |
| **Learner (catches 5-15)** | Notice auto-pick sometimes fails | "The Weaver seems overkill for fragments" |
| **Intermediate (catches 15-30)** | Start pressing ` to cycle | "Spinners for small stuff, Weavers for big" |
| **Advanced (catches 30+)** | Use 1-6 for specific arms + arm pilot | "I need Weaver-2 on that rocket body's docking port" |
| **Expert** | Use W scan → Z wireframe → specific arm targeting subcomponent | "The structural analysis shows a weak joint — attach the Weaver HERE" |

The game never forces this progression. Players who D-spam forever still have fun. Players who optimize discover mastery.

### D Key: Deploy Behavior

1. Check: target selected? → If not: Houston "Select a target first [Tab]"
2. Check: tool recommended? → If `NONE`: Houston "No tools available — recall or wait"
3. If recommended tool is `LASSO`: fire lasso (same as Space key behavior)
4. If recommended tool is arm: call [`armManager.deployArmByIndex(armIndex, target)`](js/entities/ArmManager.js)
5. If recommended tool is `TRAWL`: emit [`Events.TRAWL_START`](js/core/Events.js:167)
6. **Does NOT enter arm pilot** — mothership stays in command mode
7. Houston: "Bolt away — [WEAVER-1] tracking target" / "Lasso cast!" / "Trawl deployed!"

**Ctrl+D** = debug overlay (unchanged), **Ctrl+Shift+D** = deorbit sacrifice (unchanged).

---

## 4. Scan System Design — Treasure Hunting

### Current State

[`SensorSystem`](js/systems/SensorSystem.js:61) is entirely **passive**. Data enrichment is distance-gated via [`_getDataLevel()`](js/systems/SensorSystem.js:249). No player action required.

### New Design: Active Scanning as Exploration

Active scanning transforms from "get better data" to **treasure hunting**. Just like MW2 missions that develop as you explore, scanning reveals the debris field is more complex than ground station charts suggest.

### S = Quick Scan ("Ping")

| Property | Value |
|----------|-------|
| **Trigger** | `KeyS` keydown |
| **Target** | Selected target, or nearest detected if none |
| **Data effect** | Force-resolves to `DATA_LEVELS.MEDIUM` (type, size, mass) for 30 seconds |
| **Discovery** | **20% chance to reveal 1 uncharted fragment** within scan range |
| **Power cost** | 10 Wh from sensor bus |
| **Cooldown** | 3 seconds |
| **Audio** | Sonar ping (rising chirp) |
| **Visual** | Radar sweep pulse on HUD, target entry flashes |

### W = Wide Aperture Scan ("Deep Scan")

| Property | Value |
|----------|-------|
| **Trigger** | `KeyW` keydown, 2-second channel (auto-completes) |
| **Target** | Selected target only (requires focus) |
| **Data effect** | Force-resolves to `DATA_LEVELS.CLOSE` (full profile + wireframe zones) for 60 seconds |
| **Discovery** | **40% chance to reveal 1-3 uncharted objects** nearby |
| **Sub-component reveal** | Reveals structural zones for Z-key wireframe analysis |
| **Mission development** | Can reveal debris history, synergy potential, or high-value sub-components |
| **Power cost** | 30 Wh from sensor bus over 2 seconds |
| **Cooldown** | 12 seconds |
| **Range limit** | 60% of sensor tier range (deeper insight requires closer range) |
| **Cancel** | Another key press, target lost, arm pilot mode entered |

### The Treasure Hunting Loop

Scanning isn't just data gathering — it's **prospecting**:

```
┌─ SCAN (S) ─────────────────────────────────────────────────────┐
│  Player scans a tracked debris cluster                          │
│  → Resolves: "Defunct communications satellite, 1200 kg"        │
│  → Discovery: "⚡ NEW CONTACT — uncharted fragment, 4.7 kg"     │
│  → Houston: "That wasn't in our database. NORAD thanks you."    │
│  → Reward: +$50 survey data credit                              │
└─────────────────────────────────────────────────────────────────┘

┌─ WIDE SCAN (W) ─────────────────────────────────────────────────┐
│  Player deep-scans the defunct sat                               │
│  [████████████████████] 2.0s ← progress bar                     │
│  → Full profile: mass, material, tumble, brittleness, orbit      │
│  → Wireframe zones: solar array (GaAs!), antenna boom, thruster  │
│  → Discovery: "⚡ 3 NEW CONTACTS — fragmentation debris behind   │
│    this target. Looks like a recent collision."                   │
│  → Houston: "Impressive scan data. This sat has GaAs solar cells │
│    — those are worth recovering intact. Target the solar array    │
│    attachment point."                                             │
│  → Reward: +$150 detailed survey credit                          │
│  → Mission develops: cluster just grew from 5 to 8 targets       │
└──────────────────────────────────────────────────────────────────┘
```

### Why Scanning Becomes Essential (Not Optional)

| Discovery | Player Reaction | Gameplay Impact |
|-----------|----------------|-----------------|
| **Uncharted fragments** | "There's more here than I thought!" | More targets = more captures = more profit |
| **Salvage preview** | "GaAs cells on that sat — I should use a Weaver, not the lasso" | Informed tool selection |
| **Structural weak points** | "If I attach to the antenna boom it'll snap. Use the main bus." | Better capture success rate |
| **Historical debris ID** | "That's from a Cosmos satellite! Diplomatic bonus!" | Special rewards for careful scanning |
| **Route intelligence** | "The deep scan found 3 more targets behind this one — I should plan my route differently" | Strategic thinking |
| **Treasure hunting** | "Every time I deep-scan I find more stuff. I should scan EVERYTHING." | Engagement loop |

### Ground Station Rewards for Scan Data

Real ADR companies need better debris catalogs. Scanning IS the service:

| Scan Type | Reward | Houston Message |
|-----------|--------|-----------------|
| Quick Scan (S) — new contact | +$50 | "New contact cataloged. Transmitting to Space Surveillance Network." |
| Quick Scan (S) — known target | +$0 | *(no message — ping confirms data)* |
| Wide Scan (W) — full profile | +$150 | "High-res scan data received. This updates our orbital elements significantly." |
| Wide Scan (W) — reveals cluster | +$100 per new contact | "Multiple new contacts! Looks like a fragmentation event. NORAD's adding them to the catalog." |
| Wide Scan (W) — historical ID | +$200 | "We've matched that to [mission name]. Historical preservation bonus." |

### Interaction with Passive System

```
PASSIVE (unchanged):
  Range-gated detection → targets appear on list
  Distance-gated enrichment → more data as you approach

ACTIVE (new layer):
  Quick Scan (S) → jump to MEDIUM data for 30s
  Wide Scan (W) → jump to CLOSE data for 60s + wireframe zones
  Both → chance to discover uncharted debris
  
OVERRIDE MODEL:
  Active scan sets a per-target override: { targetId, dataLevel, expiresAt }
  While override active: target shows scanned data level regardless of distance
  On expiry: reverts to passive distance-gated level
  Persistent: scan data from Wide Scan feeds into wireframe (Z key) analysis
```

### New Constants

```javascript
// --- Active Scan System ---
SCAN_PING_COOLDOWN: 3.0,              // seconds between quick scans
SCAN_PING_POWER: 10,                  // Wh consumed per ping
SCAN_PING_OVERRIDE_DURATION: 30,      // seconds data stays resolved
SCAN_PING_DISCOVERY_CHANCE: 0.20,     // 20% chance to find uncharted debris
SCAN_WIDE_CHANNEL_TIME: 2.0,          // seconds to complete wide scan
SCAN_WIDE_COOLDOWN: 12.0,             // seconds between wide scans
SCAN_WIDE_POWER: 30,                  // Wh consumed over channel
SCAN_WIDE_OVERRIDE_DURATION: 60,      // seconds data stays resolved
SCAN_WIDE_RANGE_FRACTION: 0.6,        // effective at 60% of tier range
SCAN_WIDE_DISCOVERY_CHANCE: 0.40,     // 40% chance to find uncharted debris
SCAN_WIDE_MAX_DISCOVERIES: 3,         // max new contacts per wide scan
SCAN_SURVEY_REWARD_PING: 50,          // credits for new contact via ping
SCAN_SURVEY_REWARD_WIDE: 150,         // credits for full profile data
SCAN_SURVEY_REWARD_PER_NEW: 100,      // credits per new contact in cluster
SCAN_HISTORICAL_REWARD: 200,          // credits for historical debris ID
```

### New Events

```javascript
// === ACTIVE SCAN ===
SCAN_PING:              'scan:ping',           // { targetId, dataLevel, discovered: [] }
SCAN_WIDE_START:        'scan:wideStart',      // { targetId }
SCAN_WIDE_COMPLETE:     'scan:wideComplete',   // { targetId, dataLevel, zones, discovered: [] }
SCAN_WIDE_CANCELLED:    'scan:wideCancelled',  // { targetId, reason }
SCAN_DISCOVERY:         'scan:discovery',      // { debrisIds: [], source: 'ping'|'wide' }

// === TOOL RECOMMENDATION ===
TOOL_RECOMMENDED:       'tool:recommended',    // { type, armIndex, reason, suitability }
TOOL_CYCLED:            'tool:cycled',         // { type, armIndex, direction }
```

---

## 5. Three Additional Essential Keys

Beyond WASD, three keys complete the player experience:

### Key 1: ` (Backtick) — Cycle Tool / Arm

**What it does:** Rotates through available tools for the current target, like MW2's weapon scroll. Shows tool name, suitability, and quantity on HUD.

**Cycle order:** LASSO → SPINNER-1 → SPINNER-2 → SPINNER-3 → WEAVER-1 → WEAVER-2 → WEAVER-3 → TRAWL → *(wrap)*

**Skips:** Arms that are EXPENDED or currently deployed. Grays out unsuitable tools but still allows cycling to them (player might know better than auto-pick).

**HUD display:**
```
┌──────────────────────┐
│ ► WEAVER-1  ✓  [2/3] │  ← current selection, suitability, available count
│   340 kg target       │  ← why recommended
└──────────────────────┘
```

**Why backtick:** It was already the autopilot key (just reassigned to A). Players who learned backtick=autopilot now learn backtick=tool cycle. The key is right next to 1, which deploys a specific arm — nearby but different intent.

**Learning gradient:**
1. Early game: player ignores ` — D auto-deploys, everything works
2. Mid game: Houston hint: "Press backtick to see what tools you have. Different arms for different jobs."
3. Late game: player reflexively ` cycles before every D deploy

### Key 2: V — Camera View Cycle

**Already exists** at [`InputManager case 'KeyV'`](js/systems/InputManager.js:253), cycles CHASE → TARGET_LOCK → OVERVIEW. Currently NOT in the tutorial.

**Why it's essential:** During autopilot transit (10-30 seconds), the player has nothing to do. V key fills the waiting time with spatial awareness:
- **COMMAND (CHASE):** See the ship from behind — comfortable home view
- **TACTICAL (TARGET_LOCK):** Camera locks onto selected target — see what you're approaching
- **OVERVIEW (ORBIT):** See the whole orbital picture — context and beauty

**Tutorial integration:** Teach V during the first autopilot transit (Stage 5 in new tutorial). Perfect timing — player is idle, curious, and receptive.

### Key 3: F — Focus Action (Context-Sensitive Smart Key)

**What it does:** The "do the right thing" button. Evaluates the current game state and performs the most useful action:

| Context | F Action | Equivalent To |
|---------|----------|---------------|
| Target selected, in lasso range | Fire lasso | Space |
| Target selected, arm deployed & piloted near debris | Deploy net | F in arm pilot (existing) |
| Target selected, not in range, autopilot off | Engage autopilot | A |
| No target selected, targets available | Select nearest target | Tab |
| Nothing happening, scan cooldown clear | Quick scan | S |
| Arm pilot mode, near debris | Deploy net | Existing F behavior |

**Why F:** It's already the net-deploy key in arm pilot mode. Expanding it to be context-sensitive in normal mode makes it the "I don't know what to do" panic button. New players can just mash F and things happen correctly.

**Learning path:**
1. Newbie: smashes F constantly, things mostly work
2. Learner: notices F does different things and starts using specific keys
3. Intermediate: rarely uses F, uses A/S/D/Space directly
4. Expert: uses F only for quick net deploys in arm pilot

**Implementation:** Pure InputManager logic — no new system needed. Just a priority chain of `if` checks in the `case 'KeyF'` handler.

### Revised Q/E Disposition

Q and E are left **unbound for now**. Future candidates:

| Future Option | Q | E |
|---------------|---|---|
| Quick arm select | Previous arm | Next arm |
| RCS nudge | For the 1% manual thrust crowd | |
| Comms quick reply | Accept mission | Decline mission |

Keeping them empty reduces cognitive load during the critical learning phase.

---

## 6. Tutorial: Curiosity-Driven Progressive Discovery

### Design Principle: Show → Touch → Learn → Reward

The tutorial is not instruction. It's **progressive curiosity fulfillment**. Each stage:
1. **Reveals** a new HUD panel (it brightens/undims)
2. The player **notices** the change (visual curiosity)
3. A **prompt** tells them the one key to try
4. They **try it** → immediate **reward** (Houston praise, credits, visual feedback)
5. The **next panel** begins to glow

This is the same pattern from [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md) §1.1 — Experience → Consequence → Explanation. But applied to controls, not physics.

### The Beauty Moment

> Newbies notice the beautifully rendered satellite, they learn to rotate it in 3D as the Earth rotates underneath.

The opening 30-60 seconds are pure visual immersion. The [`PlayerSatellite._buildModel()`](js/entities/PlayerSatellite.js:195) creates a detailed octagonal core with gold MLI, solar panels, tether reels. Earth's rotation creates constant visual change. The player's first instinct is to **look** — and arrow keys are right there.

### Stage Definitions

```javascript
export const TutorialStage = {
    BEAUTY:         0,   // Pure visual — satellite + Earth + stars
    LOOK_AROUND:    1,   // Arrow keys → undims ΔV pane
    SCAN:           2,   // S key → undims Target List
    TARGET_SELECT:  3,   // Tab → undims Target Detail
    AUTOPILOT:      4,   // A key → undims Fuel Group + AP indicator
    CAMERA:         5,   // V key (during transit) — no HUD change
    LASSO:          6,   // Space → first catch
    DEPLOY:         7,   // D key → undims Arms Group + Cargo Group
    TOOL_MASTERY:   8,   // ` cycle + Z wireframe → undims Power, Thermal
    FREE_PLAY:      9,   // Tutorial complete, all systems
};
```

### Stage-by-Stage Flow

---

#### Stage 0: BEAUTY (0–30 seconds)

**Player experience:** Game starts. The satellite appears against Earth. Stars drift. Solar panels catch the sun. It's beautiful.

**HUD state:** Nearly empty. Only a dim score counter and a subtle prompt.

**Prompt:** *(none for ~5 seconds, then)* `[←→↑↓] Look Around`

**Comms:** "Telemetry is live, Cowboy. Welcome to LEO."

**Advancement:** Enter ORBITAL_VIEW state → auto-advance to LOOK_AROUND after 3 seconds.

**HUD reveal:** `score-group` visible (dim).

---

#### Stage 1: LOOK_AROUND (arrow keys)

**Player experience:** Arrow keys rotate the satellite. Earth slides underneath. The 3D model is detailed — player rotates slowly (0.2 rad/s), taking in the gold MLI bands, the octagonal core, the docking cavities.

**Prompt:** `[←→↑↓] Look Around`

**Comms (after 3 arrow presses):** "Good eyes. See that gauge on the left? That's your ΔV — your fuel budget. Every maneuver costs some. Guard it."

**Advancement:** 3 arrow key presses (same as existing [`onArrowInput`](js/systems/TutorialSystem.js:183)).

**HUD reveal:** `deltav-group` undims. Player sees the ΔV bar for the first time. It's full and green. They understand: something is finite.

**Codex unlock:** `keplerian_orbit`

**Duration:** ~30-60 seconds. Player might spend time admiring the view.

---

#### Stage 2: SCAN (S key)

**Player experience:** After rotating for a while, the player wonders: "What else is out there?" The prompt appears.

**Prompt:** `[S] Scan the Area`

**Comms (on S press):** *(sonar ping sound)* → Target blips resolve on the target list panel.

**Comms (Houston):** "Contacts! Looks like fragments from a spent booster. Target list is live."

**Discovery reward:** +$50 survey credit. Houston: "Transmitting catalog data to ground. NORAD thanks you." ← **immediate dopamine for just pressing a button**

**Advancement:** Player presses S once.

**HUD reveal:** `target-list` brightens. 3-5 targets appear with names, distances, and type icons. Player sees the right-side panel populate for the first time.

**Codex unlock:** *(none — too early)*

**Why this works:** The player asked "what else is out there?" and the game answered with a radar ping and a populated target list. Cause → effect → understanding. Scanning is immediately established as worth doing (credits!).

---

#### Stage 3: TARGET_SELECT (Tab key)

**Player experience:** Targets are visible on the list. Player wonders: "How do I get to one?"

**Prompt:** `[TAB] Select a Target`

**Comms (Houston, on Tab press):** "Good pick. Range and data on the right panel. That one looks close — and small."

**Auto-tool recommendation:** First recommendation appears: `► LASSO ✓ (close-range fragment)`. Player doesn't know what this means yet — that's fine. It'll make sense at LASSO stage.

**Advancement:** Player presses Tab and a target is selected.

**HUD reveal:** `target-detail` undims. Selected target shows type, mass (if scanned), distance, and the tool recommendation badge.

**Codex unlock:** `delta_v`

---

#### Stage 4: AUTOPILOT (A key)

**Player experience:** Target selected, distance shown. Player wonders: "How do I fly there?"

**Prompt:** `[A] Fly to Target`

**Comms (Houston, on A press):** "Autopilot engaged. Sit back — we'll handle the flying. Watch your ΔV — every burn costs."

**Player observes:** Ship rotates toward target. Ion thrusters fire. ΔV gauge starts depleting. The number gets smaller. *Fear of loss begins.*

**Advancement:** Player presses A and autopilot engages (listens for `AUTOPILOT_ENGAGE` event).

**HUD reveal:** `fuel-group` undims (full fuel display — xenon, battery, throttle). Autopilot indicator lights up.

**Codex unlock:** `hohmann_transfer`

**Critical change:** Autopilot now available at stage 4 (was blocked until stage 8). Update:
- [`AutopilotSystem._setupListeners()`](js/systems/AutopilotSystem.js:408): `data.stage < 4` (was `< 8`)
- [`InputManager.init()`](js/systems/InputManager.js:104): `data.stage < 4` (was `< 8`)

---

#### Stage 5: CAMERA (V key — during transit)

**Player experience:** Autopilot is flying. Transit takes 10-30 seconds. Player has nothing to do. Boredom → curiosity.

**Prompt (appears 3 seconds into transit):** `[V] Change View`

**Comms (Houston, if V pressed):** "Good — different views help you understand where you are. COMMAND is your home base. TACTICAL locks onto targets."

**Player observes:** Camera cycles: CHASE (behind ship) → TARGET_LOCK (facing target) → OVERVIEW (wide orbital view). Each view is visually striking. TARGET_LOCK shows the debris getting closer. OVERVIEW shows the whole orbit.

**Advancement:** Player presses V once, OR autopilot arrives (whichever first — don't trap the player).

**HUD reveal:** None (this stage is about spatial awareness, not panels).

**Why this matters:** V teaches spatial awareness. Without V in the tutorial, many players never discover camera views. And transit time without V is dead time.

---

#### Stage 6: LASSO (Space key)

**Player experience:** Autopilot arrives and disengages: "AUTOPILOT OFF — ARRIVED." Target is close (~100m).

**Prompt:** `[SPACE] Cast Lasso`

**Comms (Houston):** "On station. Target in range — fire when ready."

**Player fires lasso.** Projectile flies. Magnetic tip contacts debris. Reel-in begins. **First catch!**

**Celebration:**
- Salvage reveal popup: metals, mass, value
- Houston: "First catch confirmed! You're one of us now, Cowboy. That salvage is real money — check your cargo."
- Score + credits animate
- Codex unlock: `kessler_syndrome`

**Advancement:** First lasso catch (`LASSO_CAPTURED` event).

**Lasso miss recovery:** Existing prompts preserved: "Get closer — watch range", "Lasso cooling down", "Missed! Try again".

---

#### Stage 7: DEPLOY (D key)

**Player experience:** Lasso catch celebrated. Player is excited. Houston introduces bigger game.

**Comms (Houston, after 3s delay):** "Nice work on the small fry. For bigger targets further out, you'll want the crossbow. Press D — we'll pick the right bolt."

**Prompt:** `[D] Deploy Crossbow Bolt`

**Auto-tool recommendation:** System auto-picks best arm for the next available target.

**Player presses D.** Arm launches from mothership. Spring-loaded thunk sound. Camera briefly follows the bolt, then returns.

**Houston:** "Bolt away — [SPINNER-2] tracking target. It'll handle approach and capture on its own."

**First arm catch happens automatically** (arm autonomous approach → netting → capture → reel-in). Player watches passively.

**Celebration:** Second catch. Score. Salvage. Houston: "Crossbow capture confirmed. Now you're a proper space cowboy."

**Advancement:** First arm catch (`ARM_CAPTURED` event) OR player presses D and arm deploys.

**HUD reveal:** `arms-group` undims (arm status display), `cargo-group` undims (salvage/cargo visible).

**Codex unlock:** `feep_thruster`

**Why D before 1-6 keys:** D auto-picks the right arm, no piloting required. Players learn arms exist as autonomous tools before learning they can manually pilot them. Lower barrier, faster dopamine.

---

#### Stage 8: TOOL_MASTERY (backtick cycle + Z wireframe)

**Player experience:** 3+ total catches. Player is getting comfortable. Houston introduces optimization.

**Comms (Houston):** "You're a natural. Press backtick to see your loadout — different arms for different targets. And press Z near a target for structural analysis. Knowledge is power out here."

**Prompt:** `` [`] Cycle Loadout  [Z] Analyze Target ``

**Player discovers:**
- Backtick cycles through tools: LASSO → SPINNER-1 → WEAVER-1 → etc. with suitability indicators
- Z shows wireframe zones on nearby targets: solar arrays, antenna masts, structural bus
- "The auto-picked a Weaver but this target is only 8 kg — a Spinner would be fine!"

**Advancement:** 15-second timer (or backtick pressed + Z pressed).

**HUD reveal:** `power-group`, `thermal-group` undim. All panels now visible.

**Codex unlock:** `space_tether`

---

#### Stage 9: FREE_PLAY

**Comms (Houston):** "That's the basics, Cowboy. You've got Shop (B), Forge (R), Comms (C), and the rest at your fingertips. We'll keep this channel open for weather and mission updates. Houston out."

**All systems active.** Tutorial deactivated. Skip button hidden.

**Delayed hints (existing pattern):**
- After first salvage: forge R-key hint (existing)
- After first upgrade: fuel T-key hint (existing)
- After tether limit: detach X-key hint (existing)

---

### HUD Progressive Reveal Map

```javascript
// In HUD.setTutorialVisibility() — replaces existing mapping
const groups = {
    'score-group':    stage >= TutorialStage.BEAUTY,          // 0 — always visible 
    'deltav-group':   stage >= TutorialStage.LOOK_AROUND,     // 1 — fuel awareness
    'target-list':    stage >= TutorialStage.SCAN,            // 2 — targets appear
    'target-detail':  stage >= TutorialStage.TARGET_SELECT,   // 3 — selected target info
    'fuel-group':     stage >= TutorialStage.AUTOPILOT,       // 4 — fuel consumption visible
    'arms-group':     stage >= TutorialStage.DEPLOY,          // 7 — arm deployment
    'cargo-group':    stage >= TutorialStage.DEPLOY,          // 7 — salvage visible
    'power-group':    stage >= TutorialStage.TOOL_MASTERY,    // 8 — advanced systems
    'thermal-group':  stage >= TutorialStage.TOOL_MASTERY,    // 8 — advanced systems
};
```

Note the gap between stage 4 (fuel visible) and stage 7 (arms visible). During stages 5-6, only navigation and basic scanning panels are active. This keeps the screen clean during the critical first-catch sequence.

### Tutorial Advancement Summary

| Stage | Name | Key Taught | Trigger to Advance | HUD Undims |
|-------|------|-----------|-------------------|------------|
| 0 | BEAUTY | *(none)* | Auto (3s) | score |
| 1 | LOOK_AROUND | ←→↑↓ | 3 arrow presses | ΔV gauge |
| 2 | SCAN | S | 1 scan press | target list |
| 3 | TARGET_SELECT | Tab | 1 target selected | target detail |
| 4 | AUTOPILOT | A | autopilot engaged | fuel group, AP indicator |
| 5 | CAMERA | V | V pressed OR AP arrival | *(none)* |
| 6 | LASSO | Space | first lasso catch | *(none)* |
| 7 | DEPLOY | D | first arm deploy/catch | arms, cargo |
| 8 | TOOL_MASTERY | `, Z | 15s timer or keys pressed | power, thermal |
| 9 | FREE_PLAY | *(all)* | from stage 8 | *(all groups at full)* |

### How Z is Learned

Z (wireframe zone cycling) is taught at Stage 8, but it's most useful **after** a Wide Scan (W). The flow:

1. Player starts using W for deep scans (discovered via Houston hints or experimentation)
2. Wide scan populates wireframe zone data for the target
3. Houston: "Deep scan data loaded into structural analyzer. Try Z to cycle through zones."
4. Player presses Z → wireframe highlights structural components
5. Player realizes: "The antenna boom is fragile — if I grab there, it'll break. Better target the main bus."
6. This informs arm targeting for experts

Z doesn't need its own tutorial stage — it's an emergent skill that develops from scan mastery.

---

## 7. Arrow Key Rotation Rate

### Recommendation: 0.2 rad/s

| Parameter | Old | New |
|-----------|-----|-----|
| [`SATELLITE_ROTATION_RATE`](js/core/Constants.js:106) | 0.3 rad/s (~17°/s) | **0.2 rad/s** (~11.5°/s) |
| [`AP_ROT_RATE`](js/systems/AutopilotSystem.js:23) | 0.2 rad/s | 0.2 rad/s *(no change)* |
| Full 360° time | ~21 seconds | ~31 seconds |

**Rationale:**
1. **Matches autopilot** — consistent feel between manual look and autopilot steering
2. **Suits the beauty moment** — slower rotation lets players admire the model during Stage 1
3. **Physically plausible** — achievable with reaction wheels on a ~260 kg satellite
4. **Doesn't need to be fast** — arrow keys are for looking, not aiming. Autopilot handles navigation.

### Optional: Two-Speed Rotation

```javascript
SATELLITE_ROTATION_RATE: 0.2,      // base rate (arrow keys)
SATELLITE_ROTATION_FAST: 0.4,      // Shift+arrow (quick look)
```

If testing reveals 0.2 is too slow for situational awareness, Shift+Arrow gives a quick-glance mode. Implementation: one line in [`processInput()`](js/systems/InputManager.js:901).

---

## 8. Manual Thrust Policy — The 1% Skill

### The Reality

> Most players may never master free piloting to debris, unless the game is very rewarding and the skill progression is satisfying and the UI is helpful and intuitive. It may be a skill for only 1% of players. Actually real debris recovery will mostly be automated, deltaV is just too valuable and space is too empty/boring.

This is exactly right. In real ADR, manual piloting is emergency-only. Orbital mechanics make "fly toward the target" counterintuitive (thrust prograde → orbit rises → you fall behind). ΔV burned on manual off-axis thrust is wasted.

### Policy: Removed from Normal Play, Hidden Expert Mode

| Context | WASD Function | Thrust Source |
|---------|---------------|---------------|
| Normal mode | Command keys (A/S/W/D) | **No mothership thrust** |
| Arm Pilot mode (P/1-6) | Arm steering | FEEP thruster on arm |
| Autopilot engaged | AP controls ship | Ion drive via [`thrustIon()`](js/entities/PlayerSatellite.js:1632) |
| **Expert mode (hidden)** | Numpad 8/4/2/6 = thrust | RCS/Cold gas (for the 1%) |

### Expert Manual Flight

For the 1% who want to try:
- **Numpad 8/4/2/6** (or arrow keys + modifier) mapped to mothership RCS
- **Hidden achievement:** "ACE PILOT — Manually navigate to and capture a target without autopilot"
- **Never required.** No mission demands it. No tutorial teaches it.
- **Houston acknowledges it:** "You just flew that manually?! That's...impressive. And incredibly inefficient. Autopilot exists for a reason, Cowboy."

### MPD Burst Routing

With WASD repurposed, MPD burst (M key armed mode) routes through autopilot:

```javascript
// In AutopilotSystem.update():
if (this._player.isMPDArmed && this._player.hasMPD) {
    this._player.thrustMPD(thrustDir, dt);
} else {
    this._player.thrustIon(thrustDir, dt);
}
```

Player experience: arm MPD → engage autopilot → watch high-thrust burn. All thermal/cooldown mechanics in [`PlayerSatellite`](js/entities/PlayerSatellite.js) still apply.

### Throttle (+/−) Remains Strategic

Throttle controls still work. Under autopilot:
- Throttle 100%: fastest transit, highest ΔV burn
- Throttle 50%: slower transit, half the fuel
- Throttle 10%: crawling — for when you're nearly out of fuel

This makes +/− a **strategic** control, not a flight control. The player manages fuel economy, not stick input.

---

## 9. File-by-File Change Impact

### Critical (Major Rewrite)

#### [`js/systems/InputManager.js`](js/systems/InputManager.js) — **HEAVY**

| Change | Description |
|--------|-------------|
| New `case 'KeyA'` in `_handleKeyDown` | Autopilot toggle (non-arm-pilot context) |
| New `case 'KeyS'` in `_handleKeyDown` | Quick scan trigger via SensorSystem |
| New `case 'KeyW'` in `_handleKeyDown` | Wide scan trigger via SensorSystem |
| Rewrite `case 'KeyD'` | Plain D = deploy recommended tool; Ctrl+D = debug; Ctrl+Shift+D = deorbit |
| New `case 'Backquote'` | Cycle tool recommendation (was autopilot — move to A) |
| Rewrite `case 'KeyF'` | Context-sensitive Focus Action (non-arm-pilot) |
| Rewrite `processInput()` | Remove mothership WASD/Q/E thrust. Keep arm pilot routing. Update control mode. |
| Add `_toolRecommendation` field | Tracks current auto-recommended tool |
| Add `_toolCycleIndex` field | Tracks backtick cycle position |
| Update tutorial gate | `data.stage < 4` instead of `data.stage < 8` |

#### [`js/systems/TutorialSystem.js`](js/systems/TutorialSystem.js) — **HEAVY**

| Change | Description |
|--------|-------------|
| Redefine `TutorialStage` enum | 10 new stages per §6 |
| Rewrite `_startStage()` | All new content (prompts, comms, highlights, HUD reveals) |
| Rewrite `_setupListeners()` | New events: SCAN_PING, TARGET_SELECTED, AUTOPILOT_ENGAGE, TOOL_CYCLED |
| Update `_onCatch()` / `_onLassoCatch()` | New thresholds for stage advancement |
| Update codex map | New stage → codex entry mapping |
| Add scan/camera stage handlers | Listen for V key press, scan events |
| Remove WASD_MOVE/THROTTLE stages | Replaced by SCAN/TARGET_SELECT/CAMERA |

#### [`js/systems/SensorSystem.js`](js/systems/SensorSystem.js) — **HEAVY**

| Change | Description |
|--------|-------------|
| New `activeScanPing(targetId)` | Quick scan implementation + discovery roll |
| New `startWideScan(targetId)` | Wide scan channel start |
| New `updateWideScan(dt)` | Per-frame channel tick |
| New `cancelWideScan()` | Abort with partial cooldown |
| New `_checkDiscovery(scanType)` | Roll for uncharted debris discovery |
| New `_scanOverrides` Map | Per-target data level overrides with expiry |
| Modify `_getDataLevel()` | Check override map first, then fall back to distance |
| Modify `update(dt)` | Expire overrides, tick wide scan, tick cooldowns |
| Add cooldown/channel state | `_pingCooldown`, `_wideCooldown`, `_wideChannelTimer`, etc. |

### Moderate Changes

#### [`js/core/Constants.js`](js/core/Constants.js) — **MODERATE**

| Change | Description |
|--------|-------------|
| `SATELLITE_ROTATION_RATE` | 0.3 → 0.2 |
| New scan constants block | All `SCAN_*` constants from §4 |

#### [`js/core/Events.js`](js/core/Events.js) — **MODERATE**

| New Events |
|------------|
| `SCAN_PING`, `SCAN_WIDE_START`, `SCAN_WIDE_COMPLETE`, `SCAN_WIDE_CANCELLED` |
| `SCAN_DISCOVERY` |
| `TOOL_RECOMMENDED`, `TOOL_CYCLED` |
| `TUTORIAL_TARGET_INPUT`, `TUTORIAL_SCAN_INPUT`, `TUTORIAL_CAMERA_INPUT` |

#### [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js) — **MODERATE**

| Change | Description |
|--------|-------------|
| Tutorial gate | `data.stage < 4` instead of `< 8` |
| Comms text | Change backtick references to A key |
| MPD routing | Check `isMPDArmed` → `thrustMPD()` in update() |

#### [`js/ui/HUD.js`](js/ui/HUD.js) — **MODERATE**

| Change | Description |
|--------|-------------|
| Rewrite `setTutorialVisibility()` | New stage → HUD group mapping per §6 |
| Add tool recommendation widget | Small icon/text near target panel or crosshair |
| Add scan cooldown indicators | S/W cooldown bars |
| Add wide scan progress bar | Channel progress during W key |

### Light Changes

#### [`js/entities/ArmManager.js`](js/entities/ArmManager.js) — **LIGHT**

| Change | Description |
|--------|-------------|
| New `findAvailableArm(preferType)` | Returns best available arm for tool recommendation. May already be covered by existing `deployArm()` logic. |

#### [`js/ui/hud/TargetPanel.js`](js/ui/hud/TargetPanel.js) — **LIGHT**

| Change | Description |
|--------|-------------|
| Scan data badge | "SCANNED" indicator when active override applies |
| Tool recommendation display | Show recommended tool for selected target |
| Discovery highlight | Flash new contacts from scan discovery |

#### [`js/ui/hud/StatusPanel.js`](js/ui/hud/StatusPanel.js) — **LIGHT**

| Change | Description |
|--------|-------------|
| Scan cooldown display | S/W cooldown timers near scan section |
| Tool loadout indicator | Current selected tool name |

#### [`js/systems/CameraSystem.js`](js/systems/CameraSystem.js) — **NO CHANGE**

V key already works. Only needs tutorial event emission (in InputManager).

#### [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js) — **NO CHANGE**

Thrust methods still called by autopilot. Removal is in InputManager.

#### [`js/systems/LassoSystem.js`](js/systems/LassoSystem.js) — **NO CHANGE**

Space key unchanged. D key's lasso-deploy wraps existing fire path.

#### [`js/entities/DebrisField.js`](js/entities/DebrisField.js) — **LIGHT**

| Change | Description |
|--------|-------------|
| Hidden debris pool | Add `_unchartedDebris` list used by scan discovery system |
| `revealUncharted(count, nearPosition)` | Spawn uncharted debris near a position when scan discovers |

---

## 10. Risk Assessment

### 🔴 High Risk

| Risk | Mitigation |
|------|------------|
| **Arm pilot WASD conflict** — S=Scan might fire during arm steering if context detection fails | [`armPilotMode`](js/systems/InputManager.js:21) is robust and battle-tested. Add `if (this.armPilotMode) return;` guard at top of each WASD handler in `_handleKeyDown`. |
| **Tutorial stage cascade** — Every system referencing stage numbers will break | Full codebase grep: `stage < 8`, `stage < 4`, `TutorialStage.AUTOPILOT`, etc. Known locations: [`InputManager:104`](js/systems/InputManager.js:104), [`AutopilotSystem:408`](js/systems/AutopilotSystem.js:408), [`SensorSystem:85`](js/systems/SensorSystem.js:85), [`HUD:340`](js/ui/HUD.js:340). |
| **Scan override data corruption** — Override map leaks or targets show wrong data | Override as `Map<targetId, { level, expiresAt }>`. `update(dt)` sweeps expired. Cap at 50 entries. |
| **Auto-tool recommendation wrong** — Players deploy wrong arm, blame the game | Recommendation is a SUGGESTION, not a constraint. Tool icon shows suitability (✓/⚠/✗). Backtick lets player override. Houston hints: "Auto-pick isn't always optimal — try backtick." |

### 🟡 Medium Risk

| Risk | Mitigation |
|------|------------|
| **Existing player muscle memory** — WASD-thrust players disoriented | Keep backtick as secondary autopilot binding *(wait, backtick is now tool cycle)*. Tutorial re-teaches. Show "Controls Updated" on first launch. Consider: Shift+WASD as hidden legacy thrust? |
| **processInput() rewrite complexity** — 140 lines of context-sensitive logic | Refactor in two steps: (1) extract arm-pilot into `_processArmPilotInput(dt)`, (2) modify normal-mode branch. |
| **F key context sensitivity** — "Smart" key might do unexpected things | Priority chain must be deterministic and predictable. Show what F will do in a small tooltip: "F: Cast Lasso" / "F: Engage AP". |
| **Scan discovery farming** — Players spam S for free money | Discovery chance is per-scan, not per-target. Cooldown prevents spam. Credits are modest ($50). Diminishing returns: uncharted pool depletes in each debris field. |
| **Wide scan channel state** — Interrupts during 2s channel | State machine: IDLE → CHANNELING → COMPLETE. All interrupts → IDLE with half cooldown. |

### 🟢 Low Risk

| Risk | Mitigation |
|------|------------|
| **Audio gaps** | Add scan ping audio (S), scan hum (W channel), data chirp (complete). Autopilot thrust hum already plays. |
| **Sensor bus at 0%** | Check `powerDistribution.sensorMultiplier > 0` before scan. Show comms warning. Pattern exists in [`getDetectedTargets()`](js/systems/SensorSystem.js:113). |
| **G key overlap** | G still deploys arms (muscle memory). D is primary, G is legacy. Both call same `deployArm()`. |

### Breaking Change Audit

```bash
# Tutorial stage references (including HUD progressive reveal)
grep -rn "stage < 8\|stage < 4\|stage < 5\|TutorialStage\.\|tutorialStage\|_tutorialStage" js/

# WASD thrust references
grep -rn "keys\['KeyW'\]\|keys\['KeyA'\]\|keys\['KeyS'\]\|keys\['KeyD'\]" js/

# Q/E vertical thrust
grep -rn "keys\['KeyQ'\]\|keys\['KeyE'\]" js/

# Backtick / autopilot toggle
grep -rn "Backquote\|backtick\|autopilot.*toggle" js/

# F key behaviors
grep -rn "case 'KeyF'" js/

# Control mode references
grep -rn "COLD_GAS\|CONTROL_MODE\|controlMode" js/

# Tutorial events that change
grep -rn "TUTORIAL_WASD_INPUT\|TUTORIAL_THROTTLE_INPUT" js/

# HUD group mapping
grep -rn "data-hud-group\|hud-group" js/
```

---

## Appendix A: Implementation Order

### Phase 1: Foundation (Non-Breaking)
1. Add scan constants to [`Constants.js`](js/core/Constants.js)
2. Add new events to [`Events.js`](js/core/Events.js)
3. Add active scan methods to [`SensorSystem.js`](js/systems/SensorSystem.js) (no key binding yet)
4. Add `findAvailableArm()` to [`ArmManager`](js/entities/ArmManager.js) if needed
5. Change `SATELLITE_ROTATION_RATE` to 0.2

### Phase 2: Auto-Tool System
6. Implement tool recommendation engine (new module or in InputManager)
7. Add tool recommendation HUD widget
8. Wire Tab key → auto-recommend
9. Wire Backtick → cycle tool

### Phase 3: InputManager Rewrite
10. Refactor `processInput()` — extract arm pilot into separate method
11. Add A/S/W/D/F keydown handlers with `armPilotMode` guards
12. Remove mothership WASD/Q/E thrust from `processInput()`
13. Update Backquote from autopilot toggle to tool cycle
14. Add D key deploy behavior

### Phase 4: Tutorial Rewrite
15. Redefine `TutorialStage` enum (10 new stages)
16. Rewrite `_startStage()` for all stages
17. Rewrite `_setupListeners()` for new advancement triggers
18. Update HUD group mapping in [`HUD.setTutorialVisibility()`](js/ui/HUD.js:334)
19. Update autopilot gate (stage 4, not 8)
20. Add V key tutorial stage

### Phase 5: Scan Discovery System
21. Add hidden debris pool to [`DebrisField`](js/entities/DebrisField.js)
22. Implement discovery rolls in SensorSystem
23. Add ground station reward messages
24. Wire scan data to wireframe zone display

### Phase 6: Polish
25. Scan audio (ping, hum, chirp)
26. Scan cooldown + progress UI
27. Tool recommendation suitability indicators (✓/⚠/✗)
28. MPD routing through autopilot
29. Expert mode numpad thrust (hidden)

---

## Appendix B: The Core Loop with New Controls

```
                    ┌──────────────────────────────────────────┐
                    │         THE SPACE COWBOY LOOP              │
                    │                                            │
                    │   [S] SCAN ──► discover targets            │
                    │       │         + earn survey credits       │
                    │       ▼                                     │
                    │   [TAB] SELECT ──► auto-recommend tool      │
                    │       │                                     │
                    │       ▼                                     │
                    │   [`] CYCLE? ──► optional: choose better    │
                    │       │          tool than auto-pick        │
                    │       ▼                                     │
                    │   [A] AUTOPILOT ──► fly to target           │
                    │       │              (watch ΔV)              │
                    │       ▼                                     │
                    │   [W] DEEP SCAN? ──► optional: reveals      │
                    │       │               zones, hidden debris   │
                    │       ▼                                     │
                    │   [D] DEPLOY ──► arm/lasso captures         │
                    │       │                                     │
                    │       ▼                                     │
                    │   CAPTURE! ──► salvage reveal               │
                    │       │        + credits + Houston praise    │
                    │       │                                     │
                    │       └──────── repeat ─────────────────────┘
                    │                                            │
                    │   MASTERY PATH:                             │
                    │   Tab→`→choose arm→1-6→pilot→F→net deploy  │
                    │   W→Z→target subcomponent→precise attach   │
                    └──────────────────────────────────────────┘
```

---

## Appendix C: Why Free Flight is the 1% Skill

In LEO:
- "Fly toward the target" doesn't work — thrust prograde raises your orbit, you go HIGHER and SLOWER, falling further behind
- To catch something ahead of you, you thrust RETROGRADE (backward) to drop lower and orbit faster
- Lateral thrust changes your orbital plane — enormously expensive (5.6 km/s for 45° change)
- Every manual burn wastes ΔV on non-optimal vectors (humans don't intuitively solve Lambert's problem)

Autopilot solves all of this. It computes the heading, applies thrust along the optimal vector, and arrives efficiently. Manual control is like parallel-parking a car by remote control while the car is on a merry-go-round.

**For the 1% who master it:** It's the most rewarding skill in the game. Codex entry: "There are pilots who navigate by feel — who can reach a debris target without autopilot, spending less ΔV than the computer would. They are very rare. And usually lying."
