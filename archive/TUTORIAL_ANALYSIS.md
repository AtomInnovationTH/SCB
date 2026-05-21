# Tutorial System Deep Analysis — Space Cowboy "Curiosity-Driven Tutorial"

> **⚠️ ARCHIVED — 2026-04-22.** TutorialSystem was deleted in Sprint 3 (ST-3.2). Replaced by [`TeachingSystem.js`](js/systems/TeachingSystem.js) + [`SkillsSystem.js`](js/systems/SkillsSystem.js). This document is retained for historical reference only. **Move to `archive/`.**

> **Document version**: 2026-04-14 (updated after Session 23 fixes)
> **Scope**: Stage-by-stage analysis of the deleted [`TutorialSystem`](js/systems/TutorialSystem.js) with cross-cutting issues, root causes, and implementable recommendations.

---

## 1. Executive Summary

The Space Cowboy tutorial (stages 0–9) guides new players through orbital mechanics, scanning, targeting, autopilot, camera views, and debris capture. Session 23 addressed the **five critical/high-priority gaps**. Two remaining medium-priority items are polish.

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | **Skip Tutorial button visible on menu screen** — race condition at construction time | 🔴 High | ✅ DONE — button shown only via [`_startStage()`](js/systems/TutorialSystem.js:522), not at construction |
| 2 | **No debris near player during stages 2–5** — scan/Tab/autopilot may find nothing | 🔴 Critical | ✅ DONE — [`TUTORIAL_STAGE_REQUIREMENTS[2]`](js/entities/DebrisField.js:46): 5 debris at 0.5–1.8 km |
| 3 | **No scan feedback** — no visual, audio, or satellite animation when S key is pressed | 🟠 High | ✅ DONE — [`SCAN_INITIATED`](js/core/Events.js:125) triggers [`playScan()`](js/systems/AudioSystem.js:2706) + [`_scanFlashTimer`](js/entities/PlayerSatellite.js:181) cyan body glow |
| 4 | **$50 scan reward is silent** — no credit-area flash or cash register sound | 🟠 High | ✅ DONE — [`playCashRegister()`](js/systems/AudioSystem.js:2735) on `SCORING_AWARD` + credit flash in [`StatusPanel`](js/ui/hud/StatusPanel.js:592) |
| 5 | **Autopilot spin bug** — undamped rotation oscillation in orbital frame | 🟠 High | ✅ DONE — replaced P-only with lookAt quaternion + rate-limited slerp in [`_rotateTowardWorld()`](js/systems/AutopilotSystem.js:443) |
| 6 | **Camera views look too similar** — CHASE / TARGET_LOCK collapse under common conditions | 🟡 Medium | Open |
| 7 | **Arrow symbol missing** from LOOK_AROUND prompt | 🟢 Low | ✅ DONE — prompt now `'← ↑ ↓ → look around'` at [line 555](js/systems/TutorialSystem.js:555) |

Items 1–5 and 7 are resolved. Item 6 (camera differentiation) remains as next-priority polish.

---

## 2. Opening Screen — Skip Tutorial Button Bug

### Current Behavior

[`TutorialSystem`](js/systems/TutorialSystem.js) is constructed during game init. The constructor calls [`_createUI()`](js/systems/TutorialSystem.js:76) which:

1. Creates the skip button DOM element at [line 103](js/systems/TutorialSystem.js:103) with `display: none`.
2. **Immediately** checks visibility at [line 134](js/systems/TutorialSystem.js:134):
   ```js
   if (this.active && this.stage < TutorialStage.FREE_PLAY) {
       this._skipBtn.style.display = '';
   }
   ```
3. At construction time, [`this.active = true`](js/systems/TutorialSystem.js:31) and [`this.stage = TutorialStage.BEAUTY (0)`](js/systems/TutorialSystem.js:28), so the condition is **always true**.

Meanwhile, [`MenuScreen`](js/ui/MenuScreen.js) contains only "START MISSION", "CONTINUE", and keyboard hints — **no skip button** of its own.

### User's Concern

> The "Skip Tutorial" pane is visible on the "Press Return to begin" screen but SHOULD NOT be visible yet.

### Root Cause

**Race condition**: [`_createUI()`](js/systems/TutorialSystem.js:76) runs at construction time, before the game transitions out of `MENU` state. The skip button's visibility is set unconditionally at [line 134](js/systems/TutorialSystem.js:134) with no check for game state.

### Recommendation

**Option A (minimal fix)**: Gate the visibility check on game state, not just tutorial state. Replace lines 133–136:

```js
// Don't show skip button until gameplay begins (ORBITAL_VIEW)
// It will be shown by _startStage(BEAUTY) instead
```

Then in [`_startStage(TutorialStage.BEAUTY)`](js/systems/TutorialSystem.js:523) at line 523, add after the comms message:

```js
if (this._skipBtn) this._skipBtn.style.display = '';
```

**Option B (robust)**: Listen for [`Events.GAME_STATE_CHANGE`](js/core/Events.js) → `ORBITAL_VIEW` and only then show the skip button. This already exists at [line 334](js/systems/TutorialSystem.js:334) — just add the skip button show there:

```js
if (to === 'ORBITAL_VIEW' && this.active && this.stage === TutorialStage.BEAUTY) {
    this._startStage(TutorialStage.BEAUTY);
    if (this._skipBtn) this._skipBtn.style.display = '';
    eventBus.emit(Events.TUTORIAL_STAGE_CHANGED, { stage: this.stage });
}
```

And **remove** lines 133–136 entirely.

---

## 3. Stage 0 — BEAUTY (5-second admire)

### Current Behavior

[`_startStage(BEAUTY)`](js/systems/TutorialSystem.js:523) at line 523:
- Sends a Houston comms message: *"Telemetry is live, Cowboy."*
- Calls [`showPrompt('', 0)`](js/systems/TutorialSystem.js:530) — **empty prompt** (intentionally silent).
- Auto-advances to LOOK_AROUND after 5 seconds via `setTimeout` at [line 531](js/systems/TutorialSystem.js:531).
- **No zoom hints exist** for mouse scroll wheel.

### User's Concern

> Should include non-blocking hints to zoom in/out with mouse.

### Root Cause

The BEAUTY stage was designed as a pure "admire moment" with zero UI. The [`CameraSystem._onWheel()`](js/systems/CameraSystem.js:758) at line 758 does support scroll zoom in CHASE mode (5% steps, min 15m / max 100m via [`chase.offsetBehind`](js/systems/CameraSystem.js:100)), but the player has no way to discover this.

### Recommendation

Add a **delayed, non-blocking** hint after ~2.5 seconds (halfway through the beauty window). In [`_startStage(BEAUTY)`](js/systems/TutorialSystem.js:523):

```js
case TutorialStage.BEAUTY:
    eventBus.emit(Events.COMMS_MESSAGE, {
        sender: 'HOUSTON',
        text: 'Telemetry is live, Cowboy. Welcome to Low Earth Orbit.',
        priority: 'tutorial',
    });
    this.showPrompt('', 0);
    // Non-blocking zoom hint (delayed)
    setTimeout(() => {
        if (this.active && this.stage === TutorialStage.BEAUTY) {
            this.showPrompt('🔍 Scroll wheel — zoom in/out', 0);
        }
    }, 2500);
    // Auto-advance after 5s
    setTimeout(() => {
        if (this.active && this.stage === TutorialStage.BEAUTY) {
            this.advanceTo(TutorialStage.LOOK_AROUND);
        }
    }, 5000);
    break;
```

The prompt uses `duration: 0` (persistent until stage change) and will be cleared by [`advanceTo()`](js/systems/TutorialSystem.js:406) → [`hidePrompt()`](js/systems/TutorialSystem.js:381) at line 416. This is non-blocking because the prompt element has [`pointer-events: none`](js/systems/TutorialSystem.js:94).

---

## 4. Stage 1 — LOOK_AROUND (Arrow keys, 3 presses)

### Current Behavior

[`_startStage(LOOK_AROUND)`](js/systems/TutorialSystem.js:538) at line 538:
- Comms: *"Use arrow keys to look around."*
- Prompt: `'Arrow keys — look around'` at [line 545](js/systems/TutorialSystem.js:545).
- Advances after 3 arrow key presses tracked by [`Events.TUTORIAL_ARROW_INPUT`](js/systems/TutorialSystem.js:183) at line 183.

### User's Concern

> The popup should include "→ ←→↑↓" arrow symbols.

### Root Cause

The prompt text at [line 545](js/systems/TutorialSystem.js:545) uses plain text `'Arrow keys — look around'` without Unicode arrow glyphs.

### Recommendation

Replace [line 545](js/systems/TutorialSystem.js:545):

```js
this.showPrompt('←↑↓→ Arrow keys — look around', 0);
```

Also update the comms message at [line 541–543](js/systems/TutorialSystem.js:541) to match:

```js
text: 'Use ←↑↓→ arrow keys to look around. Those contacts out there — that\'s your job.',
```

---

## 5. Stage 2 — SCAN (S key)

### Current Behavior

[`_startStage(SCAN)`](js/systems/TutorialSystem.js:548) at line 548:
- Comms: *"Press S to scan the area."*
- Prompt: `'[S] Scan'`.
- On `Events.TUTORIAL_SCAN_INPUT` at [line 194](js/systems/TutorialSystem.js:194), immediately advances to TARGET_SELECT.

The scan itself is handled in [`SensorSystem._startScan('quick')`](js/systems/SensorSystem.js:330) at line 330:
- Sets [`_scanActive = true`](js/systems/SensorSystem.js:332) for [`DURATION = 1.5`](js/core/Constants.js:281) seconds.
- On completion, [`_completeScan()`](js/systems/SensorSystem.js:349) at line 349 emits [`Events.SCORING_AWARD`](js/systems/SensorSystem.js:364) at line 364 with [`REWARD: 50`](js/core/Constants.js:285).

### User's Concerns (3 sub-issues)

#### 5a. No scan feedback — "lights/sounds/action from satellite"

**Root Cause**: [`_startScan()`](js/systems/SensorSystem.js:330) only emits a [`COMMS_MESSAGE`](js/systems/SensorSystem.js:336) at line 336. There is:
- No [`playScan()`](js/systems/AudioSystem.js) method in AudioSystem (verified — only [`playClick()`](js/systems/AudioSystem.js) on keypress).
- No wavefront/sweep visual effect.
- No satellite dish rotation or antenna flash.

**Recommendation — Audio**: Add a `playScan()` method to [`AudioSystem`](js/systems/AudioSystem.js):

```js
/** Procedural scan ping — rising frequency sweep + radar blip */
playScan() {
    if (!this.available) return;
    const t = this.ctx.currentTime;
    
    // Rising frequency sweep (0.8s)
    const sweep = this.ctx.createOscillator();
    sweep.type = 'sine';
    sweep.frequency.setValueAtTime(200, t);
    sweep.frequency.exponentialRampToValueAtTime(2000, t + 0.8);
    
    // Gain envelope: fade in, sustain, fade out
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.15, t + 0.05);
    gain.gain.linearRampToValueAtTime(0.15, t + 0.6);
    gain.gain.linearRampToValueAtTime(0, t + 0.8);
    
    sweep.connect(gain).connect(this.sfxBus);
    sweep.start(t);
    sweep.stop(t + 0.8);
}
```

Wire it in [`setupEventListeners()`](js/systems/AudioSystem.js:88):

```js
eventBus.on(Events.SCAN_QUICK, () => this.playScan());
```

**Recommendation — Visual**: Emit a new event `Events.SCAN_VISUAL_START` from [`_startScan()`](js/systems/SensorSystem.js:330). The [`ActiveSatellite`](js/entities/ActiveSatellite.js) (or a new `ScanEffectSystem`) can animate the satellite's mesh — e.g., pulse the emissive material, or rotate a dish child mesh. A simple approach:

```js
// In SensorSystem._startScan():
eventBus.emit(Events.SCAN_VISUAL_START, { type, duration: cfg.DURATION });
```

Then in [`ActiveSatellite`](js/entities/ActiveSatellite.js) or main loop, listen and apply a brief emissive pulse:

```js
eventBus.on(Events.SCAN_VISUAL_START, ({ duration }) => {
    // Flash satellite emissive color from 0 → cyan → 0 over duration
    const mesh = this.mesh; // satellite mesh
    const origEmissive = mesh.material.emissive.clone();
    mesh.material.emissive.set(0x00ccff);
    setTimeout(() => mesh.material.emissive.copy(origEmissive), duration * 1000);
});
```

#### 5b. $50 should flash the credit area + cash register sound

**Root Cause**: The $50 is awarded via [`Events.SCORING_AWARD`](js/systems/SensorSystem.js:364) at line 364, which flows through [`ScoringSystem`](js/systems/ScoringSystem.js) and emits [`Events.SCORE_UPDATE`](js/systems/AudioSystem.js:129). The AudioSystem already plays [`playScoreTally()`](js/systems/AudioSystem.js:131) at line 131 on `SCORE_UPDATE` — but this is a generic "tally" sound, not a cash register.

**No credit-area flash** exists: the credits display in [`StatusPanel`](js/ui/hud/StatusPanel.js) updates the number but has no visual highlight animation.

**Recommendation — Audio**: Add a `playCashRegister()` method to [`AudioSystem`](js/systems/AudioSystem.js):

```js
/** Cash register "ka-ching" — brief metallic ring + coin click */
playCashRegister() {
    if (!this.available) return;
    const t = this.ctx.currentTime;
    
    // Click
    const click = this.ctx.createOscillator();
    click.type = 'square';
    click.frequency.value = 3000;
    const clickGain = this.ctx.createGain();
    clickGain.gain.setValueAtTime(0.2, t);
    clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    click.connect(clickGain).connect(this.sfxBus);
    click.start(t); click.stop(t + 0.03);
    
    // Ring
    const ring = this.ctx.createOscillator();
    ring.type = 'sine';
    ring.frequency.value = 1200;
    const ringGain = this.ctx.createGain();
    ringGain.gain.setValueAtTime(0.15, t + 0.03);
    ringGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    ring.connect(ringGain).connect(this.sfxBus);
    ring.start(t + 0.03); ring.stop(t + 0.3);
}
```

Replace or augment the generic `playScoreTally()` call — or emit a distinct event for scan rewards.

**Recommendation — Visual**: In [`StatusPanel`](js/ui/hud/StatusPanel.js), listen for `Events.SCORE_UPDATE` and apply a CSS flash:

```js
// In StatusPanel, on score update:
const creditsEl = document.getElementById('credits-display');
if (creditsEl) {
    creditsEl.style.transition = 'background 0.1s';
    creditsEl.style.background = 'rgba(0, 255, 136, 0.3)';
    setTimeout(() => {
        creditsEl.style.background = '';
        creditsEl.style.transition = 'background 0.8s';
    }, 200);
}
```

Or use the existing [`_highlightElement()`](js/systems/TutorialSystem.js:456) mechanism from TutorialSystem — call `this._highlightElement('credits-display')` after the scan completes.

---

## 6. Stage 3 — TARGET_SELECT (Tab key)

### Current Behavior

[`_startStage(TARGET_SELECT)`](js/systems/TutorialSystem.js:557) at line 557:
- Comms: *"Good scan. Now press TAB to lock onto a target."*
- Prompt: `'[TAB] Select Target'`.
- Advances on [`Events.TUTORIAL_TAB_INPUT`](js/systems/TutorialSystem.js:203) at line 203.

### User's Concern

> Working well. Player should start closer to debris field so they don't get bored while autopilot travels.

### Root Cause — No Debris Near Player

[`TUTORIAL_STAGE_REQUIREMENTS`](js/entities/DebrisField.js:45) at line 45 only covers **stages 6, 7, 8**:

```js
const TUTORIAL_STAGE_REQUIREMENTS = {
    6: { range: 0.001, ... },  // LASSO
    7: { range: 0.005, ... },  // DEPLOY
    8: { range: 0.01,  ... },  // TOOL_MASTERY
};
```

**Stages 2–5 have NO guaranteed nearby debris.** The 800 interactive debris are randomly distributed across orbital bands ([`ALT_BANDS`](js/entities/DebrisField.js:58), [`INC_CLUSTERS`](js/entities/DebrisField.js:67)). If none happen to be within sensor range (~10 km for basic tier per [`SENSOR_TIERS.basic.range = 0.1`](js/systems/SensorSystem.js:25)), the scan finds nothing, Tab has no targets, and autopilot has nowhere to go.

**This is a critical tutorial-breaking gap.**

### Recommendation

Add tutorial stage requirements for stages 2–5 in [`TUTORIAL_STAGE_REQUIREMENTS`](js/entities/DebrisField.js:45):

```js
const TUTORIAL_STAGE_REQUIREMENTS = {
    2: { // SCAN — spawn scannable debris at medium range
         range: 0.005, types: ['fragment', 'missionDebris'], massMin: 1, massMax: 10, count: 5,
         offsetMin: 0.00005, offsetMax: 0.0002 },
    // Stages 3, 4, 5 reuse stage 2 debris (already spawned)
    6: { range: 0.001, types: ['fragment'], massMin: 1, massMax: 5, count: 3,
         offsetMin: 0.0000015, offsetMax: 0.000003 },
    7: { range: 0.005, types: ['fragment', 'missionDebris'], massMin: 5, massMax: 50, count: 3,
         offsetMin: 0.00002, offsetMax: 0.00006 },
    8: { range: 0.01, types: ['fragment', 'missionDebris', 'defunctSat'], massMin: 10, massMax: 200, count: 3,
         offsetMin: 0.00003, offsetMax: 0.00012 },
};
```

The `offsetMin: 0.00005` (≈ 5 km) and `offsetMax: 0.0002` (≈ 20 km) ensures debris is:
- Within basic sensor range (10 km) for at least some targets
- Close enough that autopilot transit is ~30–60 seconds, not 5+ minutes

Also add a stage 2 trigger in [`DebrisField`](js/entities/DebrisField.js) to listen for `Events.TUTORIAL_STAGE_CHANGED` and call the spawn logic when `stage === 2`.

---

## 7. Stage 4 — AUTOPILOT (A key)

### Current Behavior

[`_startStage(AUTOPILOT)`](js/systems/TutorialSystem.js:566) at line 566:
- Comms: *"Press A to engage autopilot."*
- Prompt: `'[A] Autopilot'`.
- Highlights [`autopilot-indicator`](js/systems/TutorialSystem.js:573) HUD element.
- 20-second fallback auto-advance at [line 575](js/systems/TutorialSystem.js:575).
- On `Events.AUTOPILOT_ENGAGE` at [line 211](js/systems/TutorialSystem.js:211), advances to CAMERA after 2s.

The autopilot logic is in [`AutopilotSystem.update()`](js/systems/AutopilotSystem.js:166) at line 166.

### User's Concerns (3 sub-issues)

#### 7a. Autopilot causes satellite to spin

**Root Cause**: [`_rotateToward()`](js/systems/AutopilotSystem.js:345) at line 345:

```js
_rotateToward(orbitalDir, dt) {
    const yaw = -orbitalDir.x * AP_ROT_RATE * dt;
    const pitch = orbitalDir.y * AP_ROT_RATE * dt;
    if (Math.abs(yaw) > 0.0001) this._player.rotateYaw(yaw);
    if (Math.abs(pitch) > 0.0001) this._player.rotatePitch(pitch);
}
```

Issues:
1. **No angular velocity damping**: [`AP_ROT_RATE = 0.2`](js/systems/AutopilotSystem.js:23) rad/s is applied **proportionally to direction error every frame**. If the target direction oscillates (e.g., target nearly perpendicular to orbital plane), the cross-track and radial components of [`orbitalDir`](js/systems/AutopilotSystem.js:345) flip sign rapidly.
2. **No dead zone**: The 0.0001 threshold at [line 348](js/systems/AutopilotSystem.js:348) is effectively zero — any residual error triggers rotation.
3. **No smoothing/PID**: The rotation is pure proportional control (P-only) with no derivative damping.

When the target is roughly along the radial or cross-track axis, [`_worldToOrbitalFrame()`](js/systems/AutopilotSystem.js:316) at line 316 produces `orbitalDir.x` and `orbitalDir.y` values that oscillate frame-to-frame as the ship rotates past the target bearing, causing continuous spin.

**Recommendation**: Replace the P-only controller with a PD (proportional-derivative) controller:

```js
_rotateToward(orbitalDir, dt) {
    // Target bearing errors
    const yawError = -orbitalDir.x;
    const pitchError = orbitalDir.y;
    
    // Dead zone — don't correct tiny errors (prevents jitter)
    const DEAD_ZONE = 0.05;
    
    // PD gains
    const Kp = AP_ROT_RATE;        // proportional gain
    const Kd = AP_ROT_RATE * 0.6;  // derivative gain (damping)
    
    // Angular velocity estimation (from previous frame)
    const yawRate = (yawError - (this._prevYawError || 0)) / Math.max(dt, 0.001);
    const pitchRate = (pitchError - (this._prevPitchError || 0)) / Math.max(dt, 0.001);
    this._prevYawError = yawError;
    this._prevPitchError = pitchError;
    
    // PD output with dead zone
    if (Math.abs(yawError) > DEAD_ZONE) {
        const yawCmd = (Kp * yawError - Kd * yawRate) * dt;
        this._player.rotateYaw(yawCmd);
    }
    if (Math.abs(pitchError) > DEAD_ZONE) {
        const pitchCmd = (Kp * pitchError - Kd * pitchRate) * dt;
        this._player.rotatePitch(pitchCmd);
    }
}
```

Add state fields in constructor:
```js
this._prevYawError = 0;
this._prevPitchError = 0;
```

#### 7b. Autopilot target should be clearly shown in NavSphere

**Current NavSphere behavior**: The selected target in [`NavSphere._drawDebrisDot()`](js/ui/NavSphere.js:552) at line 552 gets:
- Larger dot: [`drawSize = sel ? finalSize + 2.5 : finalSize`](js/ui/NavSphere.js:586) at line 586
- Pulsing cyan ring: [lines 590–598](js/ui/NavSphere.js:590) — `Math.sin(this._time * 4)` at 4 Hz
- Distance readout: [lines 600–610](js/ui/NavSphere.js:600)

The user reports this isn't distinct enough. The +2.5px size increase and single pulsing ring are **too subtle** against a field of 800 debris dots.

**Recommendation**: Enhance selected target visibility during autopilot:

1. **Draw a connecting line** from sphere center (player) to the selected target dot — a "heading vector" line in cyan:
   ```js
   if (sel) {
       ctx.beginPath();
       ctx.moveTo(cx, cy); // sphere center
       ctx.lineTo(sx, sy); // target dot
       ctx.strokeStyle = C.selected;
       ctx.lineWidth = 1;
       ctx.setLineDash([4, 4]);
       ctx.globalAlpha = 0.4;
       ctx.stroke();
       ctx.setLineDash([]);
   }
   ```

2. **Add a second, larger ring** that pulses at a different frequency for a "radar lock" effect:
   ```js
   if (sel) {
       // Outer expanding ring
       const expandT = (this._time * 2) % 1; // 0→1 every 0.5s
       ctx.globalAlpha = alpha * (1 - expandT) * 0.5;
       ctx.beginPath();
       ctx.arc(sx, sy, finalSize + 6 + expandT * 12, 0, Math.PI * 2);
       ctx.strokeStyle = C.selected;
       ctx.lineWidth = 1;
       ctx.stroke();
   }
   ```

3. **Add a small label** like "AP→" next to the target when autopilot is engaged — listen for `Events.AUTOPILOT_ENGAGE` and set a flag.

#### 7c. Autopilot should fly within tool range, not just arrival distance

**Current behavior**: [`ARRIVAL_DISTANCE = 0.001`](js/systems/AutopilotSystem.js:20) scene units ≈ 100m. This is independent of the active tool.

Tool ranges:
- Lasso: [`LASSO_RANGE = 200m`](js/core/Constants.js:755) — 100m arrival is within range ✓
- Arms: Variable reach (~50–100m depending on tether length) — 100m arrival may be **outside** arm reach ✗

The arrival check at [line 201](js/systems/AutopilotSystem.js:201):
```js
if (dist < ARRIVAL_DISTANCE && this._headingMode === 'TARGET') {
    this.disengage('ARRIVED');
}
```

**Additionally**, the user reports autopilot seems to fly **farther away**. Analysis: If the target is in a different orbit, the autopilot applies continuous prograde thrust toward it. Due to orbital mechanics, thrusting toward a target that's ahead in the same orbit actually **raises your orbit** and makes you fall behind. The impulse is applied via [`this._player.thrustIon(thrustDir, dt)`](js/systems/AutopilotSystem.js:218) at line 218 using the orbital-frame direction — for nearby targets in a similar orbit, the prograde component dominates, causing an orbit raise that increases distance.

**Recommendation**:

1. **Make arrival distance tool-aware**. In [`update()`](js/systems/AutopilotSystem.js:166):
   ```js
   // Compute tool-specific arrival distance
   let arrivalDist = ARRIVAL_DISTANCE;
   if (this._targetSelector) {
       const tool = this._targetSelector.getRecommendedTool?.();
       if (tool === 'lasso') arrivalDist = 0.0018; // 180m (within 200m lasso range)
       else if (tool === 'arm') arrivalDist = 0.0005; // 50m (within arm reach)
   }
   if (dist < arrivalDist && this._headingMode === 'TARGET') {
       this.disengage('ARRIVED');
   }
   ```

2. **Add user feedback on arrival**: Emit a comms message with distance + tool context:
   ```js
   eventBus.emit(Events.COMMS_MESSAGE, {
       text: `ARRIVED — ${Math.round(dist * 100000)}m from target. In lasso range.`,
       priority: 'info',
   });
   ```

3. **Investigate the "flying farther" issue**: The `thrustDir` from [`_worldToOrbitalFrame()`](js/systems/AutopilotSystem.js:316) should be checked — if the target is primarily ahead in the along-track direction, the z-component (prograde) dominates, raising orbit instead of closing. Consider adding a **retrograde component** when above the target, or implementing a proper Hohmann-like two-burn approach. For the tutorial, the simpler fix is ensuring debris is spawned **very close** (per Section 6 recommendation) so the direct-thrust approach works.

---

## 8. Stage 5 — CAMERA (V key during transit)

### Current Behavior

[`_startStage(CAMERA)`](js/systems/TutorialSystem.js:582) at line 582:
- Comms: *"While autopilot flies, press V to check different camera views."*
- Prompt: `'[V] Cycle Camera'`.
- 10-second auto-advance at [line 590](js/systems/TutorialSystem.js:590).

The three views cycled by V ([`VIEW_CYCLE`](js/systems/CameraSystem.js:28) at line 28):

| View | Label | Behavior | Code |
|------|-------|----------|------|
| CHASE | 🛰 COMMAND | 25m behind, 12m above player, looking at spacecraft | [`_computeChase()`](js/systems/CameraSystem.js:510) line 510 |
| TARGET_LOCK | 🔒 TACTICAL | Perpendicular to player↔target line, look-at weighted 85% player + 15% target | [`_computeTargetLock()`](js/systems/CameraSystem.js:568) line 568 |
| ORBIT | 🌍 OVERVIEW | Free orbit, mouse drag rotates, 30m default, 45° angle | [`_computeOrbit()`](js/systems/CameraSystem.js:530) line 530 |

### User's Concern

> The 3 views seem similar and may confuse new players. They should be distinct, useful, and obviously different at a glance.

### Root Cause Analysis

**CHASE vs TARGET_LOCK can look identical** when:

1. **No target is set**: [`_computeTargetLock()`](js/systems/CameraSystem.js:568) at line 571 checks `if (!target)` and **falls back to `_computeChase()`** at [line 573](js/systems/CameraSystem.js:573). During autopilot the target _should_ be set, but if `setLockTarget()` isn't called (or target is cleared), the two views are literally the same code path.

2. **Target is directly ahead**: The perpendicular offset at [line 584](js/systems/CameraSystem.js:584) uses `crossVectors(toTarget, radialDir)`. If `toTarget` is roughly aligned with `radialDir` (target above/below player), the perpendicular vector collapses to near-zero, and the fallback at [line 586](js/systems/CameraSystem.js:586) kicks in.

3. **Small separation**: With `camDist = Math.max(0.0001, separation * 0.8 + 0.0003)` at [line 591](js/systems/CameraSystem.js:591), if the player is close to the target, the camera barely moves from chase position.

**ORBIT is more distinct** (free rotation, different default angle), but at its default `theta = π` and `phi = π/4` at [lines 124–125](js/systems/CameraSystem.js:124), the initial view is from behind and 45° above — **similar enough to CHASE** (which is also behind and above) that the difference isn't immediately obvious without dragging.

### Recommendation — Make Views Obviously Different

#### A. CHASE (🛰 COMMAND) — Keep as-is

This is the default "flying" view. It works well. 

Add subtle enhancement: Show a small **velocity vector HUD indicator** (already exists on the NavSphere, but reinforce it on-screen).

#### B. TARGET_LOCK (🔒 TACTICAL) — Make dramatically different

The current "perpendicular to line" placement is good in theory but too subtle in practice. Make it more cinematic:

1. **Increase the perpendicular offset**: Change [`offsetDistance`](js/systems/CameraSystem.js:155) from `0.0003` (30m) to `0.0008` (80m).

2. **Change the look-at blend**: The current `lerp(target, 0.15)` at [line 602](js/systems/CameraSystem.js:602) barely looks at the target (85% player). Change to `0.4` (60% player, 40% target) — this creates a visible two-point composition.

3. **Add a zoom-out**: When switching to TARGET_LOCK, temporarily increase the camera's FOV by 5° to create a wider "tactical overview" feel that feels distinct from the intimate CHASE view.

4. **Never fall back to CHASE**: Instead of `return this._computeChase(...)` when no target, show a zoomed-out overhead view:
   ```js
   if (!target) {
       // No target: overhead tactical view (distinct from chase)
       const pos = playerPos.clone()
           .add(radialDir.clone().multiplyScalar(0.0006))
           .sub(velDir.clone().multiplyScalar(0.0001));
       const look = playerPos.clone()
           .add(velDir.clone().multiplyScalar(0.0005));
       return { pos, look };
   }
   ```

#### C. ORBIT (🌍 OVERVIEW) — Make the default angle radically different

Change the default `theta` and `phi` to start from a **near-top-down** view:

```js
this.orbit = {
    theta: Math.PI / 2,    // From the side (was π — behind)
    phi: Math.PI / 6,      // 30° from vertical (was π/4 — 45°)
    distance: 0.0008,      // 80m (was 30m) — zoomed out
    ...
};
```

This creates an immediately obvious "map view" feel that's visually distinct from both CHASE and TARGET_LOCK.

#### D. Tutorial-specific hint per view

When the player cycles views during stage 5, show a brief descriptor:

```js
// In TutorialSystem, listen for CAMERA_VIEW_CHANGE during CAMERA stage:
eventBus.on(Events.CAMERA_VIEW_CHANGE, ({ view, label }) => {
    if (!this.active || this.stage !== TutorialStage.CAMERA) return;
    const hints = {
        'CHASE': '🛰 COMMAND — fly behind your ship',
        'TARGET_LOCK': '🔒 TACTICAL — see ship AND target',
        'ORBIT': '🌍 OVERVIEW — drag mouse to orbit around',
    };
    this.showPrompt(hints[view] || label, 3);
});
```

---

## 9. Stage 6 — LASSO (Space key)

### Current Behavior

[`_startStage(LASSO)`](js/systems/TutorialSystem.js:597) at line 597:
- Comms: *"You're in range. Hit SPACE to cast your lasso."*
- Prompt: `'[SPACE] Cast Lasso'`.
- [`TUTORIAL_STAGE_REQUIREMENTS[6]`](js/entities/DebrisField.js:46) spawns **3 fragments** at 100m range, 1–5 kg.
- Miss/denied recovery prompts at [lines 298–327](js/systems/TutorialSystem.js:298).

### Analysis

This stage works well mechanically. The debris spawn ensures targets are available. Recovery prompts for misses are good UX.

### Improvements (low priority)

1. **Range indicator emphasis**: When entering LASSO stage, highlight the range number on [`TargetPanel`](js/ui/hud/TargetPanel.js) so the player knows what "in range" means numerically. Use [`_highlightElement('target-range')`](js/systems/TutorialSystem.js:456) or equivalent.

2. **Success fanfare**: The catch triggers [`_onLassoCatch()`](js/systems/TutorialSystem.js:672) at line 672 with a Houston message and 3s delay before advancing. Consider adding a brief screen flash or camera shake — this event already triggers camera shake via [`Events.LASSO_CAPTURED`](js/systems/CameraSystem.js:199) at CameraSystem line 199, so the audio/visual feedback exists. Verify it's perceptible.

---

## 10. Stage 7 — DEPLOY (D key)

### Current Behavior

[`_startStage(DEPLOY)`](js/systems/TutorialSystem.js:606) at line 606:
- Comms: *"Nice catch! For bigger debris, press D to deploy the recommended tool."*
- Prompt: `'[D] Deploy Tool'`.
- [`TUTORIAL_STAGE_REQUIREMENTS[7]`](js/entities/DebrisField.js:49) spawns 3 fragments/missionDebris at 500m, 5–50 kg.
- Advances after 3s delay on [`Events.TUTORIAL_DEPLOY_INPUT`](js/systems/TutorialSystem.js:239) at line 239.

### Analysis

Works well. The 500m spawn distance is appropriate for arm deployment practice.

### Improvements (low priority)

1. **Explain _why_ D**: The comms message says "for bigger debris" but doesn't explain the relationship between mass and tool choice. Consider adding a follow-up message:
   ```js
   setTimeout(() => {
       eventBus.emit(Events.COMMS_MESSAGE, {
           sender: 'HOUSTON',
           text: 'Lasso works for small stuff. For anything over 5 kg, you\'ll want the arms.',
           priority: 'tutorial',
       });
   }, 2000);
   ```

2. **Auto-select a heavy target**: The spawned debris at 5–50 kg includes pieces too big for lasso — make sure TargetSelector auto-selects one of the heavier ones so the player sees the "D to deploy" context is meaningful.

---

## 11. Stage 8 — TOOL_MASTERY (Backtick + Z)

### Current Behavior

[`_startStage(TOOL_MASTERY)`](js/systems/TutorialSystem.js:615) at line 615:
- Comms: *"Press backtick to cycle tools. Press Z to analyze target structure."*
- Prompt: `'[`] Cycle Tools  [Z] Analyze'`.
- [`TUTORIAL_STAGE_REQUIREMENTS[8]`](js/entities/DebrisField.js:53) spawns 3 varied targets at 1 km, 10–200 kg.
- 15-second auto-advance at [line 623](js/systems/TutorialSystem.js:623).

### Analysis

The 15-second auto-advance may be too fast for this complex stage — the player needs to:
1. Press ` to see tool options
2. Press Z to analyze
3. Understand the wireframe overlay

### Improvements (low priority)

1. **Extend auto-advance timer** to 25–30 seconds, or better: advance on **successful Z analysis** instead of a timer.
2. **Split the prompt** into two sequential prompts:
   - First: `` '[`] Cycle Tools' `` (wait for tool change event)
   - Then: `'[Z] Analyze Target Structure'` (wait for analysis event or 10s)
3. **Spawn at least one large `defunctSat`** guaranteed — the current config includes it in `types` but it's random. Force at least 1 of the 3 to be `defunctSat` for a dramatic wireframe.

---

## 12. Stage 9 — FREE_PLAY

### Current Behavior

[`_startStage(FREE_PLAY)`](js/systems/TutorialSystem.js:630) at line 630:
- Comms: *"You're ready, Cowboy. Clear that debris field. Houston out."*
- Sets [`this.active = false`](js/systems/TutorialSystem.js:652) at line 652.
- Hides skip button at [line 425](js/systems/TutorialSystem.js:425).
- Delayed fuel-cycling hint at [line 640](js/systems/TutorialSystem.js:640).

### Analysis

The transition to free play is clean. The deferred fuel hint is good discovery design.

### Improvements (low priority)

1. **Brief summary overlay**: Consider a 3-second "Controls cheat sheet" overlay listing all learned keys. This helps cement the knowledge.
2. **Shop/economy teaser**: The first salvage message via [`_salvageHintShown`](js/systems/TutorialSystem.js:44) at line 44 triggers on `Events.CARGO_STORE` at [line 253](js/systems/TutorialSystem.js:253), which only fires after catching debris. If the player doesn't catch anything for a while, they may not discover the economy. Consider a timed comms hint.

---

## 13. Cross-Cutting Issues

### 13a. Missing Debris for Stages 2–5 (CRITICAL)

As detailed in Section 6, [`TUTORIAL_STAGE_REQUIREMENTS`](js/entities/DebrisField.js:45) has no entries for stages 2–5. This means:

- **Stage 2 (SCAN)**: Scan may find zero targets → player confused
- **Stage 3 (TAB)**: No targets to Tab through → stuck
- **Stage 4 (AUTOPILOT)**: No heading → autopilot defaults to prograde (no arrival)
- **Stage 5 (CAMERA)**: Transit to nothing → camera views show empty space

**Fix**: Add stage 2 entry to `TUTORIAL_STAGE_REQUIREMENTS` (see Section 6 recommendation). Stages 3–5 reuse the stage 2 debris.

### 13b. Event Name Inconsistency

The tutorial uses two event naming patterns:
- `Events.COMMS_MESSAGE` (with `sender` field) — at [line 525](js/systems/TutorialSystem.js:525)
- `Events.COMMS_SEND` (with `source` field) — at [line 258](js/systems/TutorialSystem.js:258)

This dual-path comms emission should be consolidated. Currently [`CommsSystem`](js/systems/CommsSystem.js) may handle both, but it's fragile.

### 13c. Auto-Advance Timers Can Stack

If a player is fast (e.g., presses A immediately at stage 4), the 20-second fallback timer at [line 575](js/systems/TutorialSystem.js:575) still runs. The `if (this.active && this.stage === TutorialStage.AUTOPILOT)` guard at [line 576](js/systems/TutorialSystem.js:576) prevents double-advance, but the timer wastefully persists. Consider storing timer IDs and clearing them in [`advanceTo()`](js/systems/TutorialSystem.js:406).

### 13d. Tutorial Prompt Persistence

All stage prompts use `duration: 0` (persist forever). While [`advanceTo()`](js/systems/TutorialSystem.js:416) at line 416 calls `hidePrompt()`, if any path skips `advanceTo()` (e.g., direct `skip()` call), stale prompts could remain. The [`skip()`](js/systems/TutorialSystem.js:485) method at line 485 does call `hidePrompt()`, so this is currently safe — but fragile.

### 13e. No Audio for Tutorial Progression

Stage transitions have no audio cue. Each `advanceTo()` should emit a subtle "stage complete" chime. This reinforces the learning loop. Add in [`advanceTo()`](js/systems/TutorialSystem.js:406):

```js
eventBus.emit(Events.TUTORIAL_STAGE_COMPLETE, { completedStage });
```

And in [`AudioSystem.setupEventListeners()`](js/systems/AudioSystem.js:88):

```js
eventBus.on(Events.TUTORIAL_STAGE_COMPLETE, () => this.playStageComplete());
```

---

## 14. Priority Matrix

| Priority | Issue | Stage(s) | Effort | Impact | Status |
|----------|-------|----------|--------|--------|--------|
| **P0** | Spawn debris near player for stages 2–5 | 2–5 | Medium | Blocks entire tutorial flow | ✅ S23 — `TUTORIAL_STAGE_REQUIREMENTS[2]` added with 5 debris at 0.5–1.8 km |
| **P0** | Fix skip button visible on menu | Menu | Trivial | Confuses every new player | ✅ S23 — shown only via `_startStage()`, not at construction |
| **P1** | Add scan audio/visual feedback | 2 | Medium | Dead silence is disorienting | ✅ S23 — `playScan()` (800→2000Hz sweep) + satellite cyan body flash via `SCAN_INITIATED` |
| **P1** | Fix autopilot spin (PD controller) | 4 | Medium | Visually broken, nauseating | ✅ S23 — replaced with lookAt quaternion + rate-limited slerp (no oscillation) |
| **P1** | Credit area flash + cash register sound | 2 | Small | Missing reward feedback | ✅ S23 — `playCashRegister()` on `SCORING_AWARD` + yellow credit flash in StatusPanel |
| **P2** | Make camera views visually distinct | 5 | Medium | Confusing for new players | Open |
| **P2** | NavSphere target emphasis during autopilot | 4 | Small | Hard to track AP destination | Open |
| **P2** | Add arrow symbols to LOOK_AROUND prompt | 1 | Trivial | Polish | ✅ S23 — prompt: `'← ↑ ↓ → look around'` + comms: `'Use ← → ↑ ↓ to look around'` |
| **P2** | Add zoom hint to BEAUTY stage | 0 | Trivial | Discoverability | ✅ S23 — 2.5s delayed prompt "🔍 scroll wheel — zoom in/out" in `_startStage(BEAUTY)` |
| **P3** | Tool-aware arrival distance | 4 | Small | Edge case for arm users | ✅ S23 — `TOOL_ARRIVAL_DISTANCES` map: lasso 150m, spinner/weaver 50m, trawl 200m |
| **P3** | Per-view tutorial hint text | 5 | Small | Polish | Open |
| **P3** | Stage 8 timer / sequencing | 8 | Small | Player may miss analysis | Open |
| **P4** | Controls cheat sheet on FREE_PLAY | 9 | Small | Nice-to-have | Open |
| **P4** | Stage progression audio cues | All | Small | Polish | Open |

---

## 15. Implementation Notes

### File Change Map (Updated S23)

| File | Changes | Status |
|------|---------|--------|
| [`js/systems/TutorialSystem.js`](js/systems/TutorialSystem.js) | Skip button shown only via `_startStage()` (line 522); BEAUTY zoom hint at 2.5s; LOOK_AROUND prompt with ←↑↓→; comms messages with arrow symbols | ✅ S23 |
| [`js/entities/DebrisField.js`](js/entities/DebrisField.js) | `TUTORIAL_STAGE_REQUIREMENTS[2]` added (5 debris, 0.5–1.8 km); `_ensureTutorialDebris()` repositions far-away debris; listens for `TUTORIAL_STAGE_CHANGED` | ✅ S23 |
| [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js) | Complete rewrite: lookAt quaternion + rate-limited slerp (`_rotateTowardWorld`); approach-from-behind via targetPrograde; `TOOL_ARRIVAL_DISTANCES` map; locked target ref; `AUTOPILOT_ARRIVED` event; phase correction | ✅ S23 |
| [`js/systems/CameraSystem.js`](js/systems/CameraSystem.js) | Make TARGET_LOCK and ORBIT views more distinct from CHASE | Open |
| [`js/systems/AudioSystem.js`](js/systems/AudioSystem.js) | `playScan()` (800→2000Hz sweep); `playCashRegister()` (metallic triangle-wave); `playAPArrived()` (ascending triple-beep); `playAPDisengage()` (descending tone); wired to `SCAN_INITIATED`, `SCORING_AWARD`, `AUTOPILOT_ARRIVED`, `AUTOPILOT_DISENGAGE` | ✅ S23 |
| [`js/systems/SensorSystem.js`](js/systems/SensorSystem.js) | `_startScan()` emits `Events.SCAN_INITIATED` with `{ type }` for audio/visual feedback | ✅ S23 |
| [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js) | `_scanFlashTimer` + `SCAN_INITIATED` listener → 0.5s cyan emissive flash on body material; `_animateScanFlash(dt)` | ✅ S23 |
| [`js/ui/hud/StatusPanel.js`](js/ui/hud/StatusPanel.js) | Credit flash: tracks `_lastCredits`, on increase → yellow pulse + glow text-shadow, 0.8s transition fade | ✅ S23 |
| [`js/ui/NavSphere.js`](js/ui/NavSphere.js) | Heading line from center to selected target; expanding ring effect; AP label | Open |
| [`js/core/Events.js`](js/core/Events.js) | `SCAN_INITIATED` event with `{ type }` payload; autopilot events (`ENGAGE`, `DISENGAGE`, `ARRIVED`) | ✅ S23 |

### Testing Checklist

- [x] Start new game → skip button NOT visible on menu (shown only via `_startStage`)
- [x] Enter ORBITAL_VIEW → skip button appears (triggered by `_startStage(BEAUTY)`)
- [x] BEAUTY stage shows zoom hint at ~2.5s (`_beautyZoomTimer`)
- [x] LOOK_AROUND prompt shows ←↑↓→ symbols
- [x] Press S → hear scan sound (`playScan`), see satellite flash (`_scanFlashTimer` cyan glow)
- [x] Scan completes → $50 awarded, credit area flashes yellow, hear cash register (`playCashRegister`)
- [x] Tab finds at least 1 target (debris spawned nearby via `TUTORIAL_STAGE_REQUIREMENTS[2]`)
- [x] Autopilot engages → ship rotates smoothly to heading (slerp, no spin)
- [ ] NavSphere shows dashed line to AP target *(not yet implemented)*
- [ ] V cycles through 3 visually distinct camera views *(TARGET_LOCK/ORBIT still need differentiation)*
- [x] Autopilot arrives within tool range → disengages with "ON STATION" feedback + `playAPArrived()`
- [x] Full tutorial flow (0→9) completes without getting stuck at any stage (debris + autopilot fixes)
