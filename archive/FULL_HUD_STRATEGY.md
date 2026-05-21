# Full HUD Strategy: Progressive Luminance & Feedback Ceremony

**Status**: ✅ Implemented
**Date**: 2026-04-07
**Implemented**: 2026-04-09 (Session 16 — 5 delegate tasks, ~960 LOC across 16 files)
**Supersedes**: GAMEPLAY_ANALYSIS.md §5.3, TUTORIAL_DESIGN.md §3 (tutorial visibility model)  
**Heritage**: Modern Warfare 2, Independence War, FreeSpace 2, F-35 HMD, Elite Dangerous, Orbiter

---

## 1. Executive Summary

Three interconnected problems degrade the new player experience:

1. **HUD panels are hidden during tutorial** — players can't build spatial awareness and three reward channels are muted during the critical first minutes
2. **Tutorial guidance uses a viewport-blocking overlay** instead of the immersive comms channel that's already built and perfectly positioned
3. **Five critical feedback ceremonies are missing** — acceleration has no screen-space visual, target lock has no animation/sound, lasso has minimal feedback, docking approach is silent, and autopilot gives no heading indicator

This document proposes a unified solution drawing from 40 years of sim and game design: **show the full HUD from frame 1 using progressive luminance**, **route all guidance through the comms panel**, and **add the five missing feedback ceremonies**.

---

## 2. The Full HUD: Progressive Luminance

### 2.1 Core Principle

Replace `display: none` with `opacity` + `filter` + `pointer-events`. Every panel is visible from frame 1. The tutorial ACTIVATES elements as it teaches them — like a cockpit powering up subsystems.

This is how the F-35 HMD works: nothing hides, brightness controls attention. It's how MW2 works: full HUD from training mission 1. It's how I-War works: full cockpit from the first tutorial sortie.

### 2.2 Three Visual States

| State | Opacity | Saturation | Pointer Events | Hover-expand |
|-------|---------|-----------|----------------|-------------|
| **Dormant** | 0.3 | 0.3 (near-grayscale) | none | disabled |
| **Activating** | 0.3→1.0 (600ms ease-out) | 0.3→1.0 | enabling | enabling |
| **Active** | 1.0 | 1.0 | auto | enabled |

CSS classes:
```css
.hud-dormant {
    opacity: 0.3;
    pointer-events: none;
    filter: saturate(0.3);
    transition: opacity 600ms ease-out, filter 600ms ease-out;
}
.hud-active {
    opacity: 1.0;
    pointer-events: auto;
    filter: saturate(1.0);
    transition: opacity 600ms ease-out, filter 600ms ease-out;
}
```

The dormant state creates a "powered down" cockpit look. Spatial awareness builds subconsciously. When a panel activates, the 600ms glow + amber `.tutorial-highlight` pulse creates a "subsystem coming online" feeling — the UI itself becomes a reward.

### 2.3 Element Groups and Activation Map

Panels need sub-group granularity. Add `data-hud-group` attributes:

**StatusPanel sub-groups:**
- `score-group` — Score bar (top center)
- `fuel-group` — ΔV bar, Xenon/Gas/Bat bars, throttle gauge
- `cargo-group` — Cargo summary, forge inline
- `power-group` — Energy distribution buses (ENG/WPN/SEN)
- `thermal-group` — Thermal gauge
- `arms-group` — Fleet panel (arm rows, footer)

**TargetPanel sub-groups:**
- `target-list` — Tracked/untracked/satellite lists
- `target-detail` — Expanded selected-target info (ΔV, action hints)

**CommsPanel:** Always active (never dormant) — see §3

**NavSphere, OrbitMFD, DebrisWireframe:** Follow camera-view info levels (existing system, unchanged)

### 2.4 Tutorial Stage → Activation Map

| Stage | Newly Activated Groups | Houston Comms Message | Contextual Prompt |
|-------|----------------------|----------------------|-------------------|
| **INTRO (0)** | `score-group` | "Telemetry is live, Cowboy. Welcome to orbit." | — |
| **LOOK_AROUND (1)** | `target-list` | "Use arrow keys to look around. See those debris contacts on the right? That's your job." | `[←→↑↓] Look Around` |
| **THROTTLE (2)** | `fuel-group` (ΔV bar, fuel bars, throttle) | "Time for throttle. Plus speeds up, minus slows down. Watch your fuel on the left." | `[+−] Throttle` |
| **LASSO (3)** | `target-detail` (wireframe, closure rate, lead indicator) | "Target in range. SPACE casts your lasso. Aim for the highlighted one." | `[SPACE] Cast Lasso` |
| **FIRST_ARM (4)** | `arms-group` (fleet panel) | "Now the real tools. Press 1 to deploy Spinner-1. WASD steers, F nets." | `[1] Deploy  [WASD] Steer  [F] Net` |
| **MULTI_ARM (5)** | `power-group` (energy buses) | "More arms means more power draw. Your energy buses show the balance." | `[2] Arm 2  [7] Mothership` |
| **BIG_GAME (6)** | `thermal-group` | "Weaver arms for the big targets. Watch thermal — heavy work heats up." | `[4] Weaver` |
| **AUTOPILOT (7)** | Autopilot indicator | "Press A for autopilot. TAB cycles targets. The nav system handles the rest." | `[A] Autopilot  [TAB] Cycle` |
| **FREE_PLAY (8)** | `cargo-group`, all remaining | "You're on your own, Cowboy. Shop [B], Forge [R], Camera [V]. Houston out." | — |

### 2.5 Implementation: HUD.js Changes

[`setTutorialVisibility(stage)`](js/ui/HUD.js:346) currently uses `display: none`. Replace with:

```javascript
setTutorialVisibility(stage) {
    const groups = {
        'score-group':    stage >= TutorialStage.INTRO,
        'target-list':    stage >= TutorialStage.LOOK_AROUND,
        'target-detail':  stage >= TutorialStage.LASSO,
        'fuel-group':     stage >= TutorialStage.THROTTLE,
        'arms-group':     stage >= TutorialStage.FIRST_ARM,
        'power-group':    stage >= TutorialStage.MULTI_ARM,
        'thermal-group':  stage >= TutorialStage.BIG_GAME,
        'cargo-group':    stage >= TutorialStage.FREE_PLAY,
    };
    for (const [group, active] of Object.entries(groups)) {
        const els = this.container.querySelectorAll(`[data-hud-group="${group}"]`);
        els.forEach(el => {
            el.classList.toggle('hud-dormant', !active);
            el.classList.toggle('hud-active', active);
        });
    }
    // Comms: ALWAYS visible (never dormant)
    // Hotkey bar: REMOVED (see §4)
}
```

### 2.6 Camera View Integration

The existing [`VIEW_INFO_LEVELS`](js/ui/HUD.js:19) system for camera-view-based visibility remains **unchanged** for post-tutorial play. During tutorial, the dormant/active states take precedence — a dormant panel stays dormant regardless of camera view. Once FREE_PLAY is reached, camera view logic controls as before.

---

## 3. Comms Panel as Mission Control

### 3.1 The Perfect Position Nobody Uses

The comms log sits at `right: 10px, bottom: 10px, 260×120px` — the exact position that aviation, I-War, FreeSpace 2, and Elite Dangerous use for the communications/guidance channel. It's:
- **Non-blocking**: Bottom-right corner, away from the 3D action at center
- **In-universe**: HOUSTON talking to the player is narratively justified
- **Persistent**: The same channel that guides tutorial will later deliver weather warnings, milestone rewards, and mission updates
- **Already built**: [`CommsSystem.js`](js/systems/CommsSystem.js) (617 LOC) has message routing, priority-based audio, color coding, 15+ message sources, and cooldown management

**But it's hidden until tutorial stage 7 (AUTOPILOT)**. The richest, most immersive guidance channel is muted during the period when guidance is most needed.

### 3.2 What Changes

| Aspect | Current | Proposed |
|--------|---------|----------|
| Comms log visibility | Hidden until stage 7 | **Always visible from stage 0** |
| `C` key during tutorial | No effect (hidden) | Toggles command MENU only; log stays visible |
| Tutorial instructions | Floating overlay `#tutorial-hint` at `top: 30%`, 500px box | Houston messages in comms log (bottom-right) |
| Key prompt | `#tutorial-keybar` at `bottom: 12px` | Brief contextual prompt (§3.3) |
| Reward messages | Sent but invisible | Visible from first capture |
| Stage completion | Silent advancement | Houston congratulation message |

### 3.3 Brief Contextual Key Prompts (MW2-Style)

Replace the persistent `#tutorial-hint` overlay and `#tutorial-keybar` with a single brief prompt element:

**Position**: `top: 75%`, centered horizontally (below center viewport, above where hotkey bar was)  
**Style**: One line, 13px, opacity 0.7, no background box, `pointer-events: none`  
**Content**: Just the key hint — `[SPACE] Cast Lasso` or `[←→↑↓] Look Around`  
**Timing**: Fade in 200ms → hold 4s → fade out 800ms  
**Re-show**: If no progress detected for 15 seconds, re-appears  
**Reference**: MW2's "Press F to pay respects" — appears once, briefly, fades away

The EXPLANATION lives in the comms log ("Target in range. SPACE casts your lasso."). The PROMPT lives at the action point. Two complementary channels, no viewport blocking.

### 3.4 Comms Message Design Per Stage

Each tutorial stage sends 2-3 messages through [`CommsSystem.addMessage()`](js/systems/CommsSystem.js):

**Stage 0 → INTRO:**
```
[12:00:01] HOUSTON: Telemetry is live, Cowboy. Welcome to LEO.
[12:00:02] HOUSTON: Your cleanup zone is ahead. Let's get you oriented.
```

**LOOK_AROUND (1) — Entry:**
```
[12:00:05] HOUSTON: Use arrow keys to look around. Those contacts on the right panel — that's your job.
```
**LOOK_AROUND (1) — Completion:**
```
[12:00:18] HOUSTON: Good situational awareness. Now let's get moving.
```

**THROTTLE (2) — Entry:**
```
[12:00:19] HOUSTON: Plus key speeds up, minus slows down. Watch the ΔV bar on the left — that's your fuel budget.
```
**THROTTLE (2) — Completion:**
```
[12:00:32] HOUSTON: Throttle confirmed. Fuel management is everything up here.
```

**LASSO (3) — Entry:**
```
[12:00:33] HOUSTON: Highlighted target is in range. Hit SPACE to cast your lasso.
```
**LASSO (3) — Catch:**
```
[12:00:41] HOUSTON: First catch confirmed! Welcome to the cleanup crew, Cowboy. That's one less piece of junk threatening the ISS.
```

**FIRST_ARM (4) — Entry:**
```
[12:01:00] HOUSTON: Time for the real tools. Press 1 to deploy Spinner-1. WASD steers it, F deploys the net.
```
**FIRST_ARM (4) — Catch:**
```
[12:01:25] HOUSTON: Arm capture confirmed. Now you're a proper space cowboy.
```

**MULTI_ARM (5):**
```
[12:01:26] HOUSTON: Try pressing 2 for a second arm. Press 7 to see the mothership view. More arms, more power — watch your energy buses.
```

**BIG_GAME (6):**
```
[12:02:00] HOUSTON: Press 4 for your Weaver arms — they handle the big debris. Watch your thermal readout.
```

**AUTOPILOT (7):**
```
[12:03:00] HOUSTON: Press A to engage autopilot. TAB cycles through targets. The nav system will plot your approach.
```

**FREE_PLAY (8):**
```
[12:04:00] HOUSTON: That's the basics, Cowboy. You're on your own now. Check the Shop with B, Forge with R. Houston out.
[12:04:01] HOUSTON: We'll keep this channel open for weather and mission updates.
```

### 3.5 Reward Visibility: All 13 Channels Open

With comms visible from stage 0, the full reward stack fires on every capture:

| # | Channel | Timing | Visibility |
|---|---------|--------|-----------|
| 1 | Gold screen flash | 0-300ms | ✅ Always |
| 2 | Catch impact sound | 0-100ms | ✅ Always |
| 3 | Score popup (+500 ★) | 0-2s | ✅ Always |
| 4 | Success chime (G4→B4→D5) | 300ms-1s | ✅ Always |
| 5 | Score tick sound | 500ms | ✅ Always |
| 6 | Score bar update | 500ms | ✅ Always |
| 7 | Salvage reveal card | 1-3s | ✅ Always |
| 8 | Houston congratulations | 2-4s | ✅ **NOW visible** (was hidden) |
| 9 | Milestone message | 2-4s | ✅ **NOW visible** (was hidden) |
| 10 | Bonus multiplier text | 2-4s | ✅ **NOW visible** (was hidden) |
| 11 | Codex badge | 3-5s | ✅ Always |
| 12 | Fleet state update | immediate | ✅ **NOW visible** (dormant→active glow if first arm catch) |
| 13 | Synergy popup | on combos | ✅ Always |

---

## 4. Remove the Hotkey Bar

### 4.1 Why

The bottom-center hotkey bar (`WASD Thrust | Tab Target | V Camera | T Fuel | P Pilot | B Shop` at [`HUD.js:161-173`](js/ui/HUD.js:161)) and the tutorial keybar (`#tutorial-keybar` at [`TutorialSystem.js`](js/systems/TutorialSystem.js)) should both be removed:

1. **No sim or cockpit game does this.** Elite Dangerous, I-War, FreeSpace 2, KSP, Orbiter, DCS — none show a persistent keyboard reference on the HUD.
2. **Redundant.** Every hotkey is already shown contextually in its panel:
   - Fleet footer: `1-6 Select  7 Mother  G Deploy  F Fish  H Recall  D Deorbit`
   - Propulsion: `[T] Xenon · 1600s`, `[R] Forge: Idle`
   - Target row: `[G] Deploy  [Z] Analyze  [D] Deorbit`
   - Comms header: `GROUND COMMS [C]`
   - Energy hint: `⇧1-3: select · [ ] ±10%`
3. **Bottom-center should be clean.** The brief contextual prompt (§3.3) appears here temporarily and fades.
4. **Two competing systems** (tutorial keybar vs HUD keybar) in the same space create a jarring transition at stage 8.

### 4.2 What Replaces It

| Was | Replacement |
|-----|------------|
| Tutorial keybar | Comms messages (§3.4) + contextual prompt (§3.3) |
| HUD hotkey bar | Panel-embedded hints (already exist) + optional Help screen |
| First encounter key | Houston comms message includes the key |
| Persistent reminder | Nothing — trust the player (MW2/I-War model) |

### 4.3 Implementation

- Remove `#hud-hotkeys-panel` creation in [`HUD.js:156-180`](js/ui/HUD.js:156)
- Remove hotkey bar visibility toggle from [`setTutorialVisibility()`](js/ui/HUD.js:346)
- Remove `#tutorial-keybar` creation in [`TutorialSystem.js:102-115`](js/systems/TutorialSystem.js:102)
- Remove `_updateKeyBar()` in [`TutorialSystem.js`](js/systems/TutorialSystem.js)
- Add brief contextual prompt element in TutorialSystem (§3.3)
- Net code delta: approximately -80 LOC (removal > addition)

---

## 5. Five Missing Feedback Ceremonies

### 5.1 Acceleration Visual Feedback (I-War Heritage) — CRITICAL

**The problem**: Player presses +/- or WASD, thruster plumes fire backward (often invisible in CHASE cam), but there is ZERO screen-space indication of velocity change. The prograde marker shows speed as text but doesn't animate the change. The player cannot FEEL acceleration.

**I-War's solution**: Streaming star lines colored by acceleration direction — blue streaks when accelerating prograde, red when retrograde. Speed of streak animation proportional to thrust magnitude. This is the single most iconic I-War visual.

**Proposed implementation — Velocity Streak Overlay:**

Add a new full-screen Canvas2D overlay (like [`TargetReticle`](js/ui/TargetReticle.js)) that draws radial streaks from screen center outward when accelerating.

Parameters per frame:
- `thrustMagnitude` — from `PlayerSatellite.currentThrust` (0-1 normalized)
- `thrustDirection` — prograde (+1), retrograde (-1), lateral (0)
- `streakCount` — `floor(thrustMagnitude × 30)` particles
- `streakColor` — prograde: blue `#4488ff` → cyan `#44ffff` | retrograde: red `#ff4444` → orange `#ff8844` | lateral: white `#aacccc`
- `streakLength` — proportional to throttle percentage (10-80px)
- `streakSpeed` — proportional to thrust magnitude
- `streakAlpha` — 0.15 base, up to 0.4 at full thrust
- `distribution` — Random points on screen, streaks radiate from look-direction center + parallax

Where it hooks in:
- [`PlayerSatellite.thrustIon()`](js/entities/PlayerSatellite.js:1331) / `thrustColdGas()` / `thrustMPD()` already emit `RESOURCE_CONSUME` events with direction info
- New event `THRUST_VISUAL` with `{ magnitude, direction, type }` emitted per frame during thrusting
- Canvas overlay subscribes and renders streaks
- Also works for autopilot thrusting (same event path)

**Subtle enhancement — FOV breathe:**
During sustained thrust (>500ms): FOV narrows by 2-3° (prograde) or widens by 2-3° (retrograde). Eases back on release. This is what I-War did for boost mode. Implementation in [`CameraSystem.setFOV()`](js/systems/CameraSystem.js) — add a thrust-based FOV offset.

**Files**: New `js/ui/VelocityStreaks.js` (~200 LOC), modifications to [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) (~10 LOC event emit), [`CameraSystem.js`](js/systems/CameraSystem.js) (~20 LOC FOV offset)

### 5.2 Target Lock Ceremony (FS2/MW2 Heritage) — HIGH

**The problem**: Tab selects a target. [`TargetSelector.js`](js/systems/TargetSelector.js) stores the ID and emits `TARGET_SELECTED`. [`TargetReticle.js`](js/ui/TargetReticle.js) picks it up next frame — the cyan brackets just appear. No animation, no sound, no ceremony. FS2 had a dramatic bracket-shrink with a "target acquired" ping. MW2's hitmarker is instant but has a distinct audio+visual punch.

**Proposed — Lock-On Sequence (300ms):**

Frame 0: `TARGET_SELECTED` fires  
Frame 0-150ms: Brackets start at 2.5× normal size, shrink to 1.0× (cubic ease-out)  
Frame 0-100ms: Brief white flash on bracket corners (one-frame brighten)  
Frame 100ms: Lock tone plays — ascending two-note (C5→E5, 60ms each, sine wave, slight reverb)  
Frame 150-300ms: Brackets settle to normal pulsing behavior  
Frame 300ms: Detail panel data populates (name, distance, ΔV, etc.)

**Target LOST sequence (200ms):**  
Frame 0: `TARGET_CLEARED` fires  
Frame 0-200ms: Brackets expand to 2× and fade to 0 opacity  
Frame 100ms: Descending tone (E5→C5, 40ms each)

**Implementation in [`TargetReticle.js`](js/ui/TargetReticle.js):**
- Add `lockAnimT` float (0-1, advances at 1/300ms per frame)
- During `lockAnimT < 1`: scale bracket size by `1 + 1.5 × (1 - easeOutCubic(lockAnimT))`
- Add white corner flash at `lockAnimT < 0.05`
- Add to [`AudioSystem.js`](js/systems/AudioSystem.js): `playTargetLock()` and `playTargetLost()` (~30 LOC each)

**Files**: [`TargetReticle.js`](js/ui/TargetReticle.js) (~40 LOC), [`AudioSystem.js`](js/systems/AudioSystem.js) (~60 LOC), [`TargetSelector.js`](js/systems/TargetSelector.js) (unchanged — events already correct)

### 5.3 Lasso Feedback Overhaul — HIGH

**Current state**: [`LassoSystem.js`](js/systems/LassoSystem.js) fires a 5m yellow sphere with zero trail, generic click sound, no contact visual, no miss animation, no cooldown indicator. GAMEPLAY_ANALYSIS.md identified this as the #1 silent failure.

**Proposed — 5-layer feedback stack:**

**A. Fire feedback** (Frame 0):
- **Sound**: New `playLassoFire()` — electromagnetic "THWIP" (noise burst + resonant filter sweep, 150ms). Replace generic click.
- **Visual**: Bright white flash at muzzle point (200ms fade), lasso line starts thick (3px) and bright (`#ffff88`)
- **Camera**: Micro-shake (2px, 100ms) — subtle recoil

**B. Flight feedback** (Frame 0-1500ms):
- **Visual**: Projectile gets a comet trail — 8-point trailing position history, each drawn as diminishing-opacity circles. Total trail length ~30m.
- **Line**: Tether line pulses gently (opacity 0.4-0.7 at 2Hz) as it extends
- **Sound**: Subtle wire-whistle (filtered noise, 800Hz, very low volume, panning with projectile screen position)

**C. Contact/Hit feedback** (on `LASSO_CONTACT`):
- **Sound**: Metallic "CLANK" (existing `playCatchClamp()` is good — just wire it to LASSO_CONTACT as well as ARM_CAPTURED)
- **Visual**: Bright white/cyan flash at impact point (300ms), ring expanding outward (500ms)
- **Reticle**: Target bracket briefly flashes white

**D. Reel-in feedback** (contact → catch, ~500ms):
- **Visual**: Tether line shortens smoothly, oscillates (sine wave on line midpoint)
- **Sound**: Mechanical winch/reel sound (rising-pitch filtered noise, 500ms)

**E. Cooldown indicator**:
- **Visual**: After fire, small arc/ring around crosshair center fills from 0% to 100% over 2s cooldown. Green when ready, gray while cooling.
- **Denied feedback**: If Space pressed during cooldown or no target: brief red flash on crosshair arc + denied buzz sound (50ms square wave, low pitch)

**Files**: [`LassoSystem.js`](js/systems/LassoSystem.js) visual upgrades (~80 LOC), [`AudioSystem.js`](js/systems/AudioSystem.js) new sounds (~80 LOC), [`TargetReticle.js`](js/ui/TargetReticle.js) cooldown arc (~40 LOC)

### 5.4 Docking Approach Audio (Orbiter Heritage) — MEDIUM

**The problem**: [`DockingReticle.js`](js/ui/DockingReticle.js) shows range, closure rate, alignment bars — but the approach is silent. Every docking sim from Orbiter to KSP has proximity beeping that accelerates with closing distance.

**Proposed — Approach Beep System:**

| Range | Beep Interval | Frequency | Volume |
|-------|--------------|-----------|--------|
| >200m | No beeping | — | — |
| 100-200m | 2.0s | 600Hz | 0.1 |
| 50-100m | 1.0s | 800Hz | 0.15 |
| 20-50m | 0.5s | 1000Hz | 0.2 |
| <20m (NET READY) | 0.2s | 1200Hz | 0.25 |

Implementation: [`AudioSystem.playApproachBeep(distance)`](js/systems/AudioSystem.js) already exists (4 tiers by distance fraction) but is only wired to ArmUnit approach events. Wire it to DockingReticle's computed range during ARM_PILOT view.

**Alignment success**: When both H and V alignment are within 5m AND range < 25m, play a sustained soft tone (confirmation hum, 440Hz, 0.1 volume) — the player knows they're on perfect approach without looking at numbers.

**Files**: [`DockingReticle.js`](js/ui/DockingReticle.js) (~20 LOC), [`AudioSystem.js`](js/systems/AudioSystem.js) (existing method, ~10 LOC wiring)

### 5.5 Autopilot Feedback — MEDIUM

**The problem**: [`AutopilotSystem.js`](js/systems/AutopilotSystem.js) engages with a comms message and click sound. No visual indicator of heading, no mode icon, no arrival/disengage ceremony.

**Proposed:**

**A. Engaged indicator**: Amber text "◉ AUTOPILOT" in prograde marker area (near existing prograde readout in [`TargetReticle.js`](js/ui/TargetReticle.js)). Pulses gently at 0.5Hz. Shows target name: "◉ AP → Cosmos 2251 fragment"

**B. Heading line**: Dashed line from prograde marker toward target on-screen position. Color: amber. This shows WHERE autopilot is steering in 3D space, projected to screen.

**C. Disengage ceremony**: When AP disengages (manual input, low ΔV, arrived), the indicator fades over 500ms + single descending tone.

**Files**: [`TargetReticle.js`](js/ui/TargetReticle.js) (~30 LOC), [`AutopilotSystem.js`](js/systems/AutopilotSystem.js) (~10 LOC event data), [`AudioSystem.js`](js/systems/AudioSystem.js) (~15 LOC)

---

## 6. Alarm Suppression: The Right Lever

With the full HUD visible, alarm EVENT suppression during early tutorial prevents noise without hiding UI. The dormant panels are there — they just don't fire distracting alerts the player can't respond to yet.

| Stages | Suppressed Events |
|--------|-------------------|
| 0-3 | SpaceWeatherSystem storms, ConjunctionSystem alerts, KesslerSystem cascades, PowerDistribution low-power, SensorSystem overload |
| 4-6 | KesslerSystem cascades, geomagnetic storms |
| 7+ | Nothing suppressed — full game experience |

**Implementation**: Each system checks `tutorialSystem.stage` before emitting alert events. Simple gate: `if (tutorialStage < threshold) return;` (~5 LOC per system × 5 systems = ~25 LOC)

---

## 7. What's Already Built and Excellent (Keep As-Is)

| System | LOC | Quality | Notes |
|--------|-----|---------|-------|
| [`TargetReticle.js`](js/ui/TargetReticle.js) | 1366 | Exceptional | I-War/FS2 quality. Prograde/retrograde, lead indicators, educational callouts, metal previews. Just needs lock-on animation (§5.2). |
| [`NavSphere.js`](js/ui/NavSphere.js) | 684 | Excellent | Full I-War heritage. Stalks, zone colors, arm tethers, glass-sphere. Complete. |
| [`OrbitMFD.js`](js/ui/OrbitMFD.js) | 1244 | Excellent | Orbiter heritage. Hohmann transfer, route planner, debris density. Educational. Complete. |
| [`DockingReticle.js`](js/ui/DockingReticle.js) | 558 | Very good | Orbiter-quality proximity display. Just needs audio (§5.4). |
| [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) | 1863 | Exceptional | 65-mesh model, 9 animation systems, 4 thrust modes. Just needs to emit visual events (§5.1). |
| [`AudioSystem.js`](js/systems/AudioSystem.js) | 2049 | Excellent | 30+ procedural generators, zero external files. Comprehensive. Needs 4 new sounds (§5.2-5.5). |
| [`CommsSystem.js`](js/systems/CommsSystem.js) | 617 | Very good | Message routing, priority audio, 15+ sources, cooldowns. Just needs tutorial message injection (§3.4). |
| [`RewardSystem.js`](js/systems/RewardSystem.js) | 539 | Very good | 13-channel reward stack. Just needs all channels OPEN (§3.5). |
| [`StatusPanel.js`](js/ui/hud/StatusPanel.js) | 1198 | Very good | Comprehensive propulsion/energy/fleet display. Needs `data-hud-group` attributes (§2.3). |
| Spatial layout (left/center/right/bottom-right) | — | Correct | Matches aviation cockpit conventions perfectly |
| 5-color system (green/amber/red/blue/white × 3 brightness) | — | Correct | Clean, proven, readable |
| Camera-view info levels | — | Correct | Excellent post-tutorial context management |

---

## 8. What's Built But Needs Wiring/Polish

| System | Status | What's Needed |
|--------|--------|--------------|
| **Tutorial 9-stage** ([`TutorialSystem.js`](js/systems/TutorialSystem.js)) | Coded, active | Reroute guidance through comms. Remove floating overlay + keybar. Add contextual prompt. Add stage completion messages. |
| **Comms panel** ([`CommsPanel.js`](js/ui/hud/CommsPanel.js)) | Coded, hidden during tutorial | Remove tutorial visibility gating. Show log always. C toggles menu only. |
| **Tutorial debris spawning** ([`DebrisField._ensureTutorialDebris()`](js/entities/DebrisField.js:872)) | Coded | Verify it positions ideal targets for each stage. |
| **Approach beeping** ([`AudioSystem.playApproachBeep()`](js/systems/AudioSystem.js)) | Coded (4-tier) | Wire to DockingReticle ARM_PILOT view range data. |
| **Tutorial highlight** (`.tutorial-highlight`) | Coded | Use for panel activation (dormant→active). Already has amber pulse CSS. |
| **Codex unlock per stage** | Coded | Working. No changes needed. |
| **Skip button** | Coded | Keep. Skip → set all groups to active, skip to FREE_PLAY. |
| **BriefingScreen** ([`BriefingScreen.js`](js/ui/BriefingScreen.js)) | Coded, bypassed (MENU→ORBITAL directly) | Could be re-enabled post-tutorial as mission selection. Not blocking. |
| **Sensor system** ([`SensorSystem.js`](js/systems/SensorSystem.js)) | Coded | Already gates NavSphere untracked visibility. Working correctly. |
| **Forge inline** ([`StatusPanel`](js/ui/hud/StatusPanel.js)) | Coded, hidden until first CARGO_STORE | Correct behavior — event-gated, not tutorial-gated. Keep. |

---

## 9. Spatial Layout Reference (Updated)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Weather Badges         SCORE BAR (always active from stage 0)            │
│ (top-left)     Score │ Cleared │ Orbit │ Credits │ ⚓ Anchor             │
│                                                                          │
│ ┌──────────────┐                                        ┌──────────────┐ │
│ │ LEFT COLUMN  │                                        │  NavSphere   │ │
│ │  260px       │       [Conjunction Alert area]          │  (top-right) │ │
│ │              │                                        ├──────────────┤ │
│ │ PROPULSION   │                                        │ RIGHT COLUMN │ │
│ │  dormant→    │                                        │  280px       │ │
│ │  active      │         3D VIEWPORT                    │              │ │
│ │  fuel-group  │                                        │  Wireframe   │ │
│ │  cargo-group │         (center, unobstructed)         │  (target-    │ │
│ ├──────────────┤                                        │   detail)    │ │
│ │ ⚡ ENERGY    │         Score Popup (top: 45%)         │              │ │
│ │  dormant→    │         Synergy Popup (top: 38%)       │  Target List │ │
│ │  active      │         Salvage Reveal (bottom: 120px)  │  (target-    │ │
│ │  power-group │                                        │   list)      │ │
│ ├──────────────┤                                        │              │ │
│ │ 🐙 FLEET    │                                        │  Untracked   │ │
│ │  dormant→    │                                        │  Satellites  │ │
│ │  active      │                                        └──────────────┘ │
│ │  arms-group  │                                                         │
│ └──────────────┘                                                         │
│                                                                          │
│               [Contextual prompt — brief, fades]                         │
│               [SPACE] Cast Lasso                                         │
│                (top: 75%, center, 13px, fades)                           │
│                                                                          │
│                                                          COMMS LOG       │
│                                                          (ALWAYS VISIBLE)│
│                                                          260×120px       │
│                                                          bottom-right    │
│                                                          Codex badges    │
│  Skip btn (tutorial only)                                (above comms)   │
└──────────────────────────────────────────────────────────────────────────┘
```

**Removed**: Hotkey bar, Tutorial keybar, Tutorial floating overlay  
**Added**: Contextual prompt (transient), Comms log (always visible)  
**Changed**: All panels dormant→active instead of hidden→shown

---

## 10. Implementation Phases

### Phase 1: Comms Always Visible + Tutorial Through Comms (~180 LOC)

**Priority**: HIGHEST — unlocks all reward channels, provides guidance foundation

| File | Changes |
|------|---------|
| [`HUD.js`](js/ui/HUD.js) | `setTutorialVisibility()`: Remove comms panel hiding. Comms = always visible. |
| [`CommsPanel.js`](js/ui/hud/CommsPanel.js) | During tutorial: log visible without `C` toggle. `C` toggles command menu only. |
| [`TutorialSystem.js`](js/systems/TutorialSystem.js) | Route all stage messages through `CommsSystem.addMessage()` with source "HOUSTON". Add stage-entry and stage-completion messages per §3.4. |
| [`TutorialSystem.js`](js/systems/TutorialSystem.js) | Replace `#tutorial-hint` with brief contextual prompt element per §3.3 (single line, fades). |
| [`TutorialSystem.js`](js/systems/TutorialSystem.js) | Remove `#tutorial-keybar` creation and update logic. |

### Phase 2: Progressive Luminance (~200 LOC)

**Priority**: HIGH — eliminates hide/show entirely

| File | Changes |
|------|---------|
| [`HUD.js`](js/ui/HUD.js) | Add `.hud-dormant` / `.hud-active` CSS classes. Rewrite `setTutorialVisibility()` per §2.5. |
| [`StatusPanel.js`](js/ui/hud/StatusPanel.js) | Add `data-hud-group` attributes to sub-sections: `score-group`, `fuel-group`, `cargo-group`, `power-group`, `thermal-group`, `arms-group`. |
| [`TargetPanel.js`](js/ui/hud/TargetPanel.js) | Add `data-hud-group` attributes: `target-list`, `target-detail`. |

### Phase 3: Remove Hotkey Bar (~-80 LOC net)

**Priority**: HIGH — cleans bottom of screen

| File | Changes |
|------|---------|
| [`HUD.js`](js/ui/HUD.js) | Remove `#hud-hotkeys-panel` creation (lines 156-180). Remove visibility toggle in `setTutorialVisibility()`. |
| [`TutorialSystem.js`](js/systems/TutorialSystem.js) | Remove `#tutorial-keybar` (already done in Phase 1). |

### Phase 4: Acceleration Visual Feedback (~230 LOC)

**Priority**: HIGH — the single biggest feel gap

| File | Changes |
|------|---------|
| New: `js/ui/VelocityStreaks.js` | Full-screen Canvas2D velocity streak overlay per §5.1 (~200 LOC) |
| [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) | Emit `THRUST_VISUAL` event with `{ magnitude, direction, type }` from thrust methods (~10 LOC) |
| [`CameraSystem.js`](js/systems/CameraSystem.js) | Add thrust-based FOV breathe offset (±2-3°, 500ms ease) (~20 LOC) |
| [`main.js`](js/main.js) | Wire VelocityStreaks into render loop |

### Phase 5: Target Lock Ceremony (~130 LOC)

**Priority**: HIGH — Tab key needs to feel significant

| File | Changes |
|------|---------|
| [`TargetReticle.js`](js/ui/TargetReticle.js) | Lock-on animation: bracket shrink 2.5×→1× over 300ms. White corner flash. Target-lost expand+fade. (~40 LOC) |
| [`AudioSystem.js`](js/systems/AudioSystem.js) | `playTargetLock()`: C5→E5 ascending. `playTargetLost()`: E5→C5 descending. (~60 LOC) |
| [`TargetSelector.js`](js/systems/TargetSelector.js) or listener | Wire audio to TARGET_SELECTED/CLEARED events (~10 LOC) |

### Phase 6: Lasso Feedback Overhaul (~200 LOC)

**Priority**: MEDIUM-HIGH — key to first catch satisfaction

| File | Changes |
|------|---------|
| [`LassoSystem.js`](js/systems/LassoSystem.js) | Comet trail (8-point history), tether pulse, muzzle flash, miss retraction. (~80 LOC) |
| [`AudioSystem.js`](js/systems/AudioSystem.js) | `playLassoFire()` (thwip), `playLassoDenied()` (buzz), `playLassoReel()` (winch). (~80 LOC) |
| [`TargetReticle.js`](js/ui/TargetReticle.js) | Cooldown arc around crosshair, denied flash. (~40 LOC) |

### Phase 7: Docking Audio + Autopilot Feedback (~75 LOC)

**Priority**: MEDIUM

| File | Changes |
|------|---------|
| [`DockingReticle.js`](js/ui/DockingReticle.js) | Wire approach beeps from computed range to existing `AudioSystem.playApproachBeep()`. Add alignment confirm tone. (~20 LOC) |
| [`TargetReticle.js`](js/ui/TargetReticle.js) | Autopilot indicator + heading line when AP active. (~30 LOC) |
| [`AutopilotSystem.js`](js/systems/AutopilotSystem.js) | Emit heading data for indicator. (~10 LOC) |
| [`AudioSystem.js`](js/systems/AudioSystem.js) | AP disengage tone. (~15 LOC) |

### Phase 8: Alarm Suppression (~25 LOC)

**Priority**: MEDIUM — cleanup, prevents noise during tutorial

| File | Changes |
|------|---------|
| [`SpaceWeatherSystem.js`](js/systems/SpaceWeatherSystem.js) | Tutorial stage gate on alert emission (~5 LOC) |
| [`ConjunctionSystem.js`](js/systems/ConjunctionSystem.js) | Tutorial stage gate (~5 LOC) |
| [`KesslerSystem.js`](js/systems/KesslerSystem.js) | Tutorial stage gate (~5 LOC) |
| [`PowerDistribution.js`](js/systems/PowerDistribution.js) | Tutorial stage gate (~5 LOC) |
| [`SensorSystem.js`](js/systems/SensorSystem.js) | Tutorial stage gate (~5 LOC) |

---

## 11. Total Estimated Scope

| Phase | LOC | Priority | Dependencies |
|-------|-----|----------|-------------|
| 1. Comms always visible + tutorial through comms | ~180 | HIGHEST | None |
| 2. Progressive luminance | ~200 | HIGH | Phase 1 |
| 3. Remove hotkey bar | ~-80 | HIGH | Phase 1 |
| 4. Acceleration visual (velocity streaks) | ~230 | HIGH | None |
| 5. Target lock ceremony | ~130 | HIGH | None |
| 6. Lasso feedback overhaul | ~200 | MEDIUM-HIGH | None |
| 7. Docking audio + autopilot feedback | ~75 | MEDIUM | None |
| 8. Alarm suppression | ~25 | MEDIUM | Phase 1 |
| **Total** | **~960 LOC** | | |

Phases 1-3 form a coherent "HUD Strategy" block (~300 LOC net). Phases 4-6 are independent "Feedback Ceremony" blocks. Phase 7-8 are polish.

---

## 12. Design Principles

1. **Show everything, dim what's not yet taught** — F-35 declutter model
2. **Guide through comms, not overlays** — MW2 radio / I-War command bridge
3. **Brief prompts, not persistent bars** — MW2 contextual "Press F"
4. **Reduce situational complexity, not interface complexity** — universal sim principle
5. **Open all feedback channels from minute one** — every capture tells a story about what you recovered, what it's worth, and how it extends your mission
6. **The UI itself is a reward** — panel activation = ability unlock
7. **Spatial consistency is sacred** — nothing moves, nothing disappears
8. **Acceleration must be FELT** — I-War velocity streaks
9. **Every player action deserves feedback** — lock-on, lasso, approach — but feedback, not celebration
10. **Trust the player** — sim players learn fast when the UI provides information, not dopamine
11. **Teach through consequence, not numbers** — "+15 kg aluminum" teaches more than "+500 ★"
12. **Houston is the reward channel** — narrative acknowledgment over abstract popups

---

## 13. Sim Immersion vs Arcade Gamification

### 13.1 The Identity Question

This game contains two competing reward philosophies:

**Sim-native rewards** (already built, tonally correct):
- Houston milestone messages — "Confirmed first capture. Welcome to the cleanup crew, Cowboy."
- Salvage reveal cards — what metals are inside the debris, teaching materials science
- Cargo accumulation → forge → propellant → extended mission — Tsiolkovsky made visceral
- Codex unlocks — "CODEX UNLOCKED: Eclipse Periods" — real science, earned through experience
- Sweep reports — mission debriefing with efficiency metrics
- Field clearing percentages — real mission metrics
- Credits as an economic resource — purchasing power for equipment

**Arcade-layered rewards** (built, tonally dissonant):
- "+500 ★" floating score popup — no space sim shows floating point numbers
- Gold screen flash — mobile game catch celebration
- "TACTICAL BONUS ×1.3" / "SALVAGE BONUS ×1.15" / "FUEL EFFICIENCY BONUS ×1.25" — multiplier stacking popups
- Synergy combo popups ("Solar Array ×1.5" for GaAs+Cu) — crafting game dopamine
- Rapid-catch streak detection — combo system from fighting games
- Score bar "Score" field — abstract number with no world meaning
- Musical success chime fanfare (G4→B4→D5) — gamey

### 13.2 What Real Space Sims Do

| Game | Score System | Catch/Kill Reward | Post-Mission |
|------|-------------|-------------------|-------------|
| **I-War** | None | Mission objective complete. You survived. | Mission debrief |
| **Orbiter** | None | You docked. You landed. The physics was the game. | — |
| **KSP** | Science points (feel like a resource, not a score) | No popups | Tech tree progress |
| **Elite Dangerous** | Credits from missions | Transaction appears in panel (no popup) | Check your balance |
| **MW2** | C-bills per mission | Damage dealt shown in mechlab | Kill/salvage summary |
| **FreeSpace 2** | None in-flight | — | Mission debrief: kills, objectives |
| **DCS World** | None | You completed the mission or you didn't | Debrief |

The pattern: **serious sims reward through mission outcomes and narrative acknowledgment, not floating numbers and combo multipliers.**

### 13.3 The Score Bar Problem

The score bar currently shows: `Score | Cleared | Orbit | Credits | ⚓ Anchor`

- **"Score"** (point total) — Arcade. What does 5,000 ★ mean? Nothing in the real world. Nothing about orbital cleanup.
- **"Cleared"** (debris count) — Sim. This is a real mission metric. ADR operators track objects removed.
- **"Orbit"** (altitude/inclination) — Sim. Real telemetry.
- **"Credits"** — Sim-adjacent. Money for equipment. Economically meaningful.
- **"⚓ Anchor"** (mass) — Sim. Anchor mass for the space elevator contract. kg contributed.

"Score" is the odd one out. Everything else has game-world meaning. Score is points-for-points-sake — a number that teaches nothing about space.

### 13.4 Proposed Reframe: From Points to Physics

**Replace abstract score with meaningful metrics:**

| Current (Arcade) | Proposed (Sim) | What It Teaches |
|------------------|---------------|----------------|
| "+500 ★" score popup | "+15 kg aluminum" or "+2.3 kg recovered" | Mass matters — heavier captures are more valuable |
| Gold screen flash (300ms) | Brief bracket pulse on target (like I-War contact blink) | Confirmation, not celebration |
| "TACTICAL BONUS ×1.3" popup | Houston: "Good assessment before capture. That's how the pros do it." | Technique acknowledged through narrative, not numbers |
| "SALVAGE BONUS ×1.15" popup | Salvage reveal card (already built) shows what you recovered | Materials science — let the card speak |
| "FUEL EFFICIENCY BONUS ×1.25" popup | Houston: "Efficient approach — gravity gradient assist. Textbook." | Real orbital mechanics technique named |
| Synergy combo popup | Let the forge/market discover value naturally — "Processed: 12 kg Al → 10.2 kg propellant. 800s more ion burn." | In-situ resource utilization, mass ratios |
| Score bar "Score" field | "Mass Recovered: 234 kg" or "Cleared: 17/50" | Real mission metric |
| Success chime (G4→B4→D5 fanfare) | Single confirmation tone (like Orbiter docking confirm) | Professional, not celebratory |
| Rapid-catch streak | Houston: "Three in quick succession. Ground team is impressed." | Acknowledged by narrative, no multiplier shown |

### 13.5 The Deeper Reward Loop Is Already Beautiful

The game's REAL reward loop doesn't need arcade scaffolding:

```
CAPTURE DEBRIS
    │
    ├── Reduces Kessler risk → Houston contextualizes: "That fragment was on a
    │   collision course with ISS. You just bought the crew another safe orbit."
    │
    ├── Yields metals → Salvage reveal card shows what's inside
    │   └── "Cosmos 2251 fragment: 8.2 kg aluminum, 0.3 kg copper, 0.1 kg GaAs"
    │       Player learns what satellites are MADE of
    │
    ├── Metals → Forge → Propellant
    │   └── "Processed: 8.2 kg aluminum → 7.0 kg thrust propellant"
    │       "Ion drive: +560 seconds burn time"
    │       Player learns: their catch literally fuels their next maneuver
    │       The Tsiolkovsky equation becomes FELT, not taught
    │
    ├── Metals → Forge → Refined ingots → Market sell → Credits
    │   └── Credits buy better arms, sensors, tethers
    │       The scavenger economy sustains itself
    │
    └── Mass → Anchor contract → Space elevator endgame
        └── "Anchor mass contribution: 8.2 kg / 10,000 kg target"
            Real mega-engineering becomes the endgame goal
```

Every step teaches real aerospace engineering. Every step has world-meaning. No step needs "+500 ★" to feel rewarding.

### 13.6 What This Means for §3.5 (Reward Visibility)

The "All 13 Channels Open" table in §3.5 should be reconsidered. Updated assessment:

| # | Channel | Keep/Reframe | Reasoning |
|---|---------|-------------|-----------|
| 1 | Gold screen flash | **Reframe** → subtle bracket pulse | Sim-appropriate confirmation, not celebration |
| 2 | Catch impact sound | **Keep** — but consider a professional "clamp confirmed" tone | Physical feedback is appropriate |
| 3 | Score popup (+500 ★) | **Reframe** → mass recovered popup "+15 kg" | Mass teaches physics; points teach nothing |
| 4 | Success chime (G4→B4→D5) | **Reframe** → single confirmation beep | Professional tone, not fanfare |
| 5 | Score tick sound | **Remove** or reduce to subtle UI click | Arcade DNA |
| 6 | Score bar update | **Reframe** → "Cleared: N" and "Mass: Xkg" update | Mission metrics, not points |
| 7 | Salvage reveal card | **Keep** — this is the star of the show | Teaches materials science |
| 8 | Houston congratulations | **Keep** — this is perfect | Narrative reward, mission context |
| 9 | Milestone message | **Keep** — but reframe from streaks to mission context | "That's 10 objects this sweep" is sim; "combo ×3!" is arcade |
| 10 | Bonus multiplier text | **Remove** or move to sweep report | Multipliers are arcade; efficiency belongs in debrief |
| 11 | Codex badge | **Keep** — educational reward | Learning IS the reward |
| 12 | Fleet state update | **Keep** — operational feedback | Sim-native |
| 13 | Synergy popup | **Reframe** → forge/market discovery | Let the economy tell the story, not a popup |

### 13.7 The Credits Reframe

Credits currently = Score (same number, same system in [`ScoringSystem.js`](js/systems/ScoringSystem.js)). This is wrong. Credits should come from:

1. **Government cleanup bounties** — per-piece payments based on debris type and hazard level (already in `Constants.MARKET.BOUNTY_PREMIUMS`)
2. **Material sales** — selling refined metals at market prices (already in `CARGO_SELL` handler)
3. **Anchor contract milestones** — bonus payments for mass delivered (already in `Constants.ELEVATOR_CONTRACT`)

NOT from: abstract point calculations with streak bonuses and tactical multipliers. Those belong in the sweep report as efficiency ratings, not as real-time popups.

Houston should say: "Cleanup bounty credited: ₡1,200 for that rocket body fragment. Hazardous object premium applied." — This teaches the player that different debris has different value, and WHY (hazard to active satellites).

### 13.8 The Teaching Moments in Every Catch

With the arcade layer removed, each catch becomes a micro-lecture delivered through experience:

**First small fragment catch:**
```
[Sound: confirmation beep]
[Visual: bracket pulse on caught target]
[Salvage card]: Fragment A-2281: 2.1 kg aluminum, 0.05 kg copper
[Comms]: HOUSTON: Fragment secured. 2.1 kg recovered — mostly aluminum bus structure.
         That's enough to process 1.8 kg of ion propellant.
[Codex badge appears silently in corner]
```

**First rocket body catch:**
```
[Sound: heavier confirmation tone — lower pitch, longer sustain]
[Visual: bracket pulse]
[Salvage card]: Cosmos 2251 Stage 2: 180 kg aluminum, 12 kg steel, 3 kg copper,
                0.5 kg GaAs (solar cells), trace iridium
[Comms]: HOUSTON: Big one confirmed. 180 kg of aluminum alone — that rocket body
         is mostly propellant tanks. The GaAs from its solar panels is worth more
         per gram than gold. Good prioritization, Cowboy.
```

**First forge completion:**
```
[Forge panel]: REFINE COMPLETE: 8.2 kg aluminum → 20.5 kg refined aluminum ingot (×2.5 value)
[Comms]: HOUSTON: Forge cycle complete. You just turned scrap aluminum into aerospace-grade
         ingot. In-situ resource utilization — same principle NASA plans for Mars missions.
[Codex]: CODEX UNLOCKED: "In-Situ Resource Utilization (ISRU)"
```

**First propellant processing:**
```
[Forge panel]: PROPELLANT: 8.2 kg aluminum → 7.0 kg aluminum propellant (85% mass)
[Fuel display updates]: Ion Drive: +560s burn time (Al propellant: Isp 800s, ×1.4 thrust)
[Comms]: HOUSTON: Aluminum propellant loaded. Lower specific impulse than xenon, but you
         made it from scrap. That's 560 more seconds of thrust you didn't have five
         minutes ago.
```

Every single one of these teaches real-world concepts. "+500 ★" teaches nothing.

### 13.9 Guiding Principle Update

Replace Design Principle #5 from §12:

**Old**: "Open all reward channels from minute one — dopamine architecture"

**New**: "Open all feedback channels from minute one — every capture tells a story about what you recovered, what it's worth, and how it extends your mission"

The difference: "reward channels" implies Skinner box dopamine hits. "Feedback channels" implies information-rich responses that build understanding. The satisfaction comes from COMPREHENSION, not from abstract number-go-up.

This is what [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md) §1.1 already articulates as the Three-Beat Pattern: EXPERIENCE → CONSEQUENCE → EXPLANATION. The catch is the experience. The mass/metal/fuel consequence follows. Houston explains. Points short-circuit this by providing a fake consequence (number goes up) that requires no explanation.

---

## 14. Document Hierarchy

```
LEARNING_THROUGH_PLAY.md     ← Educational philosophy (what to teach, when)
        │
        ▼
GAMEPLAY_ANALYSIS.md         ← Diagnosis (what's broken, why)
        │
        ├──→ FULL_HUD_STRATEGY.md    ← THIS DOCUMENT (supersedes §5.3)
        │           │                   Supersedes: ORCHESTRATOR_BRIEF Phase 4+8,
        │           │                               MASTER_PLAN §1D,
        │           │                               TUTORIAL_DESIGN §3+§6+§7,
        │           │                               NEXT_STEPS Priority 4 R8
        │           │
        ├──→ TUTORIAL_DESIGN.md      ← Tutorial spec (update §3, §6, §7 to match)
        │
        ├──→ HUD_REDESIGN.md         ← HUD architecture (layout/color — unchanged)
        │
        └──→ ORCHESTRATOR_BRIEF.md   ← Economy/systems work (Sprints A/C/D unchanged)
                    │                   Phase 4+8 superseded by this document
                    │
                    └──→ MASTER_PLAN.md  ← §1A/1B compatible, §1D superseded
```

---

## 15. Cross-Document Conflicts & Resolutions

This document was written after reading all existing design docs. Several conflicts exist with prior documents. Each is deliberate and justified below.

### 15.1 vs ORCHESTRATOR_BRIEF.md (Session 12)

| ORCHESTRATOR_BRIEF Section | Conflict | Resolution |
|---------------------------|----------|------------|
| **Phase 4: Tutorial & Onboarding** — "Progressive HUD reveal, progressive key-hint bar" | FULL_HUD_STRATEGY replaces hide/show with progressive luminance (§2) and removes key-hint bar (§4) | **This document supersedes.** Phase 4's spec was written before the 9-stage tutorial was implemented (Session 15) and before the feedback gap analysis. Progressive luminance is strictly better than binary visibility. |
| **Phase 8: Audio & Polish** — "8 procedural sounds (approach beeps→net fwip→clamp→twang→reel→dock→salvage sting)" | FULL_HUD_STRATEGY §5.1-5.5 specifies the same sounds with more precise parameters | **This document supersedes.** Phase 8 was a wish list; §5 has frame-level timing, frequency specs, and file-level integration points. |
| **Sprint A3** — "Add T key to hotkey bar" | §4 removes the hotkey bar entirely | **This document supersedes.** T key discovery moves to Houston comms message when player first forges propellant + panel-embedded `[T]` hint in fuel display. |
| **Sprint B5** — "Energy panel auto-collapse" | Already implemented per NEXT_STEPS.md Session 15 | **No conflict.** B5 is done. |
| **Sprint structure (A/B/C/D)** | FULL_HUD_STRATEGY phases 1-8 don't map 1:1 to sprints A-D | **Complementary.** ORCHESTRATOR_BRIEF sprints A-D cover the *economy visibility* and *new systems* work. FULL_HUD_STRATEGY phases 1-8 cover the *tutorial/HUD/feedback* work. They're orthogonal. An orchestrator should treat them as **two parallel workstreams**: Economy (ORCHESTRATOR_BRIEF A/C/D) and Experience (FULL_HUD_STRATEGY 1-8). Sprint B visual fixes remain independent. |

### 15.2 vs MASTER_PLAN.md Phase 1

| MASTER_PLAN Section | Conflict | Resolution |
|--------------------|----------|------------|
| **§1D: Screen-Center Thrust Direction Arrow** — draws an arrow from center toward projected thrust direction | FULL_HUD_STRATEGY §5.1 proposes velocity streaks (I-War heritage) + FOV breathe instead | **This document supersedes.** An arrow is informational (shows WHERE you thrust). Velocity streaks are *visceral* (make you FEEL acceleration). Both solve "no screen-space thrust feedback," but streaks create the immersion that I-War proved works. The arrow approach is salvageable as a low-thrust-magnitude fallback if streaks prove too noisy at low throttle. |
| **§1C: Directional Thrust Sounds** — pitch shift thruster hum by prograde/retrograde dot | Compatible with §5.1 | **No conflict.** Directional pitch shift is a sound design detail that complements visual streaks. Implement both. |
| **§1A: Live ΔV-to-Match on Retrograde Reticle** | Not addressed by FULL_HUD_STRATEGY | **No conflict.** ΔV-to-match is a TargetReticle enhancement independent of HUD strategy. Implement per MASTER_PLAN. |
| **§1B: Prograde ΔV-Spent Counter** | Not addressed by FULL_HUD_STRATEGY | **No conflict.** Independent TargetReticle feature. |

### 15.3 vs NEXT_STEPS.md (Session 15)

| NEXT_STEPS Item | Conflict | Resolution |
|----------------|----------|------------|
| **"Hotkey bar ✅ Done"** — listed as verified completed work | §4 proposes removing it | **Deliberate reversal.** Session 15 polished the hotkey bar. This document, after deeper analysis of MW2/I-War/FS2/Elite heritage, concludes the hotkey bar is the wrong pattern for a sim. Every key it shows is already shown contextually in its panel. The ~80 LOC of hotkey bar creation becomes ~0 LOC. Net simplification. The Session 15 work was correct for *that session's design model* — this document changes the model. |
| **Priority 3: Audio Polish** — "Thruster audio feedback, forge phase sounds, urgency ramp, tutorial chime, codex unlock sound" | §5.1-5.5 overlaps on thruster feedback and tutorial advancement | **Partially superseded.** This document's §5 provides more specific audio specs for thrust, lock-on, lasso, docking, and autopilot. Forge phase sounds and codex unlock sounds remain as defined in NEXT_STEPS Priority 3 — they're orthogonal. |
| **Priority 4: HUD Redesign R8** — "Hotkey bar polish ✅ Done" | §4 removes it | **Same as hotkey bar conflict above.** R8 is now irrelevant. R9 (responsive breakpoints) and R3-R7 verification remain valid. |
| **Tutorial flow (9 stages)** | §2.4 uses same 9 stages but changes the mechanism | **Compatible evolution.** The 9-stage structure, catch thresholds, Codex unlocks, skip button, guaranteed debris spawning — all remain. Only the *visibility mechanism* changes (luminance vs hide/show) and the *guidance channel* changes (comms vs floating overlay). The stage logic in [`TutorialSystem.js`](js/systems/TutorialSystem.js) is preserved. |

### 15.4 vs TUTORIAL_DESIGN.md

| Section | Conflict | Resolution |
|---------|----------|------------|
| **§3: Target List Visibility** — "showTargets = true during all tutorial stages" | §2.3 uses dormant/active states for target-list group instead | **This document supersedes.** The `showTargets = true` fix from Session 15 was a band-aid for the hide/show problem. Progressive luminance eliminates the need — the target list is always *visible* (dormant), becoming *interactive* (active) at LOOK_AROUND. |
| **§6: Improved Step Flow** — floating hint overlay + key bar | §3.2-3.3 replaces with comms messages + brief contextual prompts | **This document supersedes.** The floating overlay blocks viewport. The comms channel is narratively appropriate, non-blocking, and already built. |
| **§7: UI Integration** — "#tutorial-hint centered at 30% top" | §3.3 moves to "top: 75%, centered, 13px, fades" | **This document supersedes.** MW2 showed that brief, low-screen prompts train faster than large centered boxes. |

### 15.5 vs GAMEPLAY_ANALYSIS.md

| Section | Status |
|---------|--------|
| **§1.4: Silent Failures** — lasso cooldown, no target, at max/min throttle | **Directly addressed** by §5.3 (lasso denied feedback) and §5.1 (throttle clamp indicator via streak absence) |
| **§1.3: Tab-Select vs Auto-Aim Disagreement** | **NOT addressed** by this document. Remains an open issue. The lasso auto-aim cone (±30° prograde) vs Tab-selected target mismatch needs a separate fix: either lasso should fire at Tab-selected target, or the reticle should show which target the auto-aim will hit. |
| **§2: Lasso Targeting — Zero Pre-fire Feedback** | **Directly addressed** by §5.3A (fire feedback) and §5.3E (cooldown indicator) |
| **§5.3: Beginner Distractions — HUD visibility model** | **Superseded** by §2 (progressive luminance) |
| **§6: Sound Design Gaps** | **Partially addressed** by §5.1-5.5 feedback ceremonies |

---

## 16. Orchestrator Readiness Assessment

### 16.1 Is This Ready for Orchestrator?

**Yes**, with the following structure:

**Workstream A — Experience (this document):**
- Phases 1-3 as a single delegate task ("HUD Strategy Block" — ~300 LOC net, touches 5 files)
- Phases 4-6 as three independent delegate tasks (each ~130-230 LOC, each touches 2-4 files)
- Phases 7-8 as a single delegate task ("Polish Block" — ~100 LOC, touches 6 files)

**Workstream B — Economy (ORCHESTRATOR_BRIEF):**
- Sprints A, C, D remain valid and independent of this document
- Sprint B visual fixes remain valid and independent

### 16.2 Delegate Task Specifications

**Task HUD-1: Comms + Luminance + Hotkey Removal (Phases 1-3)**
```
Input:   This document §2, §3, §4
Files:   HUD.js, CommsPanel.js, TutorialSystem.js, StatusPanel.js, TargetPanel.js
LOC:     ~300 net (+380, -80)
Test:    Start new game → comms visible immediately → Houston messages appear per stage
         → panels start dimmed, glow on activation → no hotkey bar → no floating overlay
         → brief key prompts fade in/out at bottom center
Depends: Nothing
```

**Task HUD-2: Velocity Streaks (Phase 4)**
```
Input:   This document §5.1
Files:   NEW VelocityStreaks.js, PlayerSatellite.js, CameraSystem.js, main.js
LOC:     ~230
Test:    Press + → blue streaks radiate from center, FOV narrows slightly
         → release → streaks fade, FOV returns → press - → red streaks, FOV widens
         → autopilot thrust shows same streaks
Depends: Nothing
```

**Task HUD-3: Target Lock Ceremony (Phase 5)**
```
Input:   This document §5.2
Files:   TargetReticle.js, AudioSystem.js
LOC:     ~130
Test:    Press Tab → brackets shrink from 2.5× with ascending tone
         → Tab again → old brackets expand+fade, new brackets shrink
         → clear target → descending tone + fade
Depends: Nothing
```

**Task HUD-4: Lasso Feedback (Phase 6)**
```
Input:   This document §5.3
Files:   LassoSystem.js, AudioSystem.js, TargetReticle.js
LOC:     ~200
Test:    Press Space → THWIP sound + muzzle flash + comet trail
         → hit → CLANK + flash + reel-in winch sound
         → miss → retraction animation
         → Space during cooldown → red flash + denied buzz
         → cooldown arc fills around crosshair
Depends: Nothing
```

**Task HUD-5: Docking Audio + Autopilot + Alarm Suppression (Phases 7-8)**
```
Input:   This document §5.4, §5.5, §6
Files:   DockingReticle.js, TargetReticle.js, AutopilotSystem.js, AudioSystem.js,
         SpaceWeatherSystem.js, ConjunctionSystem.js, KesslerSystem.js,
         PowerDistribution.js, SensorSystem.js
LOC:     ~100
Test:    ARM_PILOT view → approach beeps accelerate with closing distance
         → alignment confirm hum when centered
         → press A → "◉ AP → [target]" indicator + heading line
         → disengage → fade + descending tone
         → tutorial stages 0-3 → no weather/conjunction/kessler alerts
Depends: Nothing (but lower priority — do after HUD-1 through HUD-4)
```

### 16.3 Execution Order for Orchestrator

```
PARALLEL TRACK 1 (Experience):
  HUD-1 (Comms + Luminance + Hotkey Removal)     ← START HERE, highest impact
    → HUD-5 (Docking + Autopilot + Alarms)       ← after HUD-1 (needs tutorial stage gates)

PARALLEL TRACK 2 (Feedback Ceremonies):
  HUD-2 (Velocity Streaks)                        ← independent, any time
  HUD-3 (Target Lock Ceremony)                    ← independent, any time
  HUD-4 (Lasso Feedback)                          ← independent, any time

PARALLEL TRACK 3 (Economy — from ORCHESTRATOR_BRIEF):
  Sprint A (Economy Visibility)                    ← independent of all HUD work
  Sprint C (New Systems)                           ← after Sprint A
  Sprint D (Polish)                                ← after Sprint C
```

HUD-2, HUD-3, and HUD-4 have zero dependencies on each other or on HUD-1. An orchestrator can dispatch all four Track 1+2 tasks simultaneously if code workers are available, though HUD-1 should be prioritized because it unlocks reward channels and changes the tutorial feel fundamentally.

### 16.4 Open Issues NOT Addressed (for future documents)

1. **Tab-Select vs Auto-Aim mismatch** ([`GAMEPLAY_ANALYSIS.md`](GAMEPLAY_ANALYSIS.md) §1.3) — Lasso fires at auto-aim target, not Tab-selected target. Needs separate design decision.
2. **BriefingScreen re-enablement** ([`BriefingScreen.js`](js/ui/BriefingScreen.js)) — Currently bypassed. Could serve as mission selection post-tutorial. Not blocking.
3. **Responsive breakpoints** ([`NEXT_STEPS.md`](NEXT_STEPS.md) Priority 4 R9) — Mobile/tablet layout. Orthogonal to this document.
4. **MASTER_PLAN Phase 1A/1B** (retrograde ΔV-to-match, prograde ΔV-spent counter) — Compatible enhancements to [`TargetReticle.js`](js/ui/TargetReticle.js) that can be implemented independently.
5. **Forge phase transition sounds** ([`NEXT_STEPS.md`](NEXT_STEPS.md) Priority 3) — Not covered here. Independent [`AudioSystem.js`](js/systems/AudioSystem.js) work.

---

## 17. Implementation Notes (2026-04-09)

All 8 phases were implemented across 5 delegate tasks in Session 16. ~960 LOC across 16 files.

### Delegate Task Summary

| Task | Phases | Files Modified | Key Outcomes |
|------|--------|---------------|-------------|
| **HUD-1** | 1–3 | [`HUD.js`](js/ui/HUD.js), [`CommsPanel.js`](js/ui/hud/CommsPanel.js), [`TutorialSystem.js`](js/systems/TutorialSystem.js), [`StatusPanel.js`](js/ui/hud/StatusPanel.js), [`TargetPanel.js`](js/ui/hud/TargetPanel.js) | Comms always visible from stage 0; `.hud-dormant`/`.hud-active` CSS classes replace `display: none`; `data-hud-group` attributes on all panel sub-sections; hotkey bar + tutorial keybar removed; MW2-style contextual prompts; all 9 tutorial stages route through Houston comms |
| **HUD-2** | 4 | New [`VelocityStreaks.js`](js/ui/VelocityStreaks.js), [`PlayerSatellite.js`](js/entities/PlayerSatellite.js), [`CameraSystem.js`](js/systems/CameraSystem.js), [`main.js`](js/main.js) | Full-screen Canvas2D radial streak overlay (blue prograde, red retrograde, white lateral); FOV breathe ±2-3° based on sustained thrust |
| **HUD-3** | 5 | [`TargetReticle.js`](js/ui/TargetReticle.js), [`AudioSystem.js`](js/systems/AudioSystem.js) | Lock-on bracket shrink 2.5×→1× over 300ms + white corner flash + ascending C5→E5 tones; lock-lost expand+fade + descending E5→C5 |
| **HUD-4** | 6 | [`LassoSystem.js`](js/systems/LassoSystem.js), [`AudioSystem.js`](js/systems/AudioSystem.js), [`TargetReticle.js`](js/ui/TargetReticle.js), [`Events.js`](js/core/Events.js) | 5-layer feedback stack (fire/flight/contact/reel-in/cooldown); `LASSO_DENIED` event added |
| **HUD-5** | 7–8 | [`DockingReticle.js`](js/ui/DockingReticle.js), [`AutopilotSystem.js`](js/systems/AutopilotSystem.js), [`TargetReticle.js`](js/ui/TargetReticle.js), [`AudioSystem.js`](js/systems/AudioSystem.js), [`SpaceWeatherSystem.js`](js/systems/SpaceWeatherSystem.js), [`ConjunctionSystem.js`](js/systems/ConjunctionSystem.js), [`KesslerSystem.js`](js/systems/KesslerSystem.js), [`PowerDistribution.js`](js/systems/PowerDistribution.js), [`SensorSystem.js`](js/systems/SensorSystem.js) | 4-tier proximity beeping + alignment tone; amber autopilot indicator + heading line + disengage tone; tutorial-stage-gated alarm suppression across 5 systems |

### Notable Deviations from Spec

- **Hotkey bar removal** was a deliberate reversal of Session 15's work (which had polished the hotkey bar). The MW2/I-War/FS2 analysis in §4 justified this.
- **§13 (Sim Immersion vs Arcade Gamification)** remains a design proposal — the score/reward reframe was NOT implemented in this pass. The current arcade reward channels (score popups, gold flash, multiplier text) remain active. This is a future design decision.
- All audio uses procedural Web Audio API synthesis — zero external sound files, consistent with the existing [`AudioSystem.js`](js/systems/AudioSystem.js) architecture.
