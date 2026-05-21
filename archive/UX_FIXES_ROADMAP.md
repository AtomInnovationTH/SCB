# Sprint UX — Pre-Epic 7 UX Polish Roadmap

## Completion Summary

| Field | Detail |
|-------|--------|
| **Date** | April 24, 2026 |
| **Status** | ✅ All 4 sprints complete (16 issues + jitter spike) |
| **Test baseline** | 238 suites / 1,160 tests / 0 failures |
| **Files modified** | ~25+ across all sprints |
| **Key findings** | Float32 jitter confirmed and fixed via floating origin pattern |

> **16 targeted UX fixes** for the Space Cowboy orbital debris removal sim.
> Estimated total effort: **~4–5 developer-days** across 4 sprints.
> UX-1 through UX-3 can partially parallelize. UX-4 is independent.

---

## Status

| ID | Issue | Sprint | Complexity | Est. | Status |
|----|-------|--------|------------|------|--------|
| 0 | De-Jargon All Player-Facing Text | UX-1 | Small | 30 min | ✅ Complete |
| 5 | Simplify Target Reticle (Remove Arcade Pulsing) | UX-1 | Trivial | 15 min | ✅ Complete |
| 6 | Spiderman Web Tether Visual | UX-1 | Small | 45 min | ✅ Complete |
| N2 | CommsPanel Progressive Luminance | UX-1 | Trivial | 10 min | ✅ Complete |
| 11 | Comms Pane: Top-Right, Wider, No Timestamps, 3 Lines | UX-2 | Small | 30 min | ✅ Complete |
| 2 | Conjunction Alerts Route Through Comms | UX-2 | Small | 20 min | ✅ Complete |
| 10 | C-Key Toggles Expanded Comms | UX-2 | Small | 20 min | ✅ Complete |
| 10B | Comms Boot Sequence | UX-2 | Small | 30 min | ✅ Complete |
| 12 | Unified Notification Zone (Bottom Center) | UX-2 | Medium | 1 hr | ✅ Complete |
| 8 | Decouple Arm Deploy from Camera Switch | UX-3 | Small | 20 min | ✅ Complete |
| 4 | Web Tether Forward-Only + Beginner Tool Framing | UX-3 | Small | 30 min | ✅ Complete |
| 7 | Lasso Ammo System (20 shots) | UX-3 | Small | 30 min | ✅ Complete |
| N1 | Missing Teaching Moments | UX-3 | Small | 30 min | ✅ Complete |
| N3 | Expose Arm 2× Manual Score | UX-3 | Trivial | 15 min | ✅ Complete |
| 1 | Freeze Net ΔV at Discovery Time | UX-3 | Small | 30 min | ✅ Complete |
| 9 | Targets Hidden Until Scanned (Staggered Reveal) | UX-3 | Medium | 1 hr | ✅ Complete |
| 3 | Debris Jitter: Float32 Precision Spike | UX-4 | Med-High | 1 day | ✅ Complete |

---

## Design Decisions

These decisions are **locked in** and must not be revisited during implementation:

1. **Comms is the primary teaching channel.** All context-sensitive hints, tool suggestions, and progression nudges route through the comms panel — not center-screen overlays.
2. **Progressive disclosure via `.hud-dormant` / `.hud-active`.** New HUD groups start at 30 % opacity and brighten on skill discovery. Only exception: comms boot sequence auto-discovers `manage_comms`.
3. **Web tether is the beginner tool; crossbow arms are the expert tool.** Ammo pressure on the web tether and 2× manual-pilot score bonus on arms form the natural progression ladder.
4. **Scan is the reward loop.** Targets are hidden until scanned. Staggered reveal with audio blips makes S-key the most satisfying action.
5. **One notification zone, bottom-center.** Transient pilot messages (autopilot, capture, view change, tool change) share a single slot that auto-fades. Nothing blocks the targeting reticle.
6. **RED conjunctions keep center overlay; GREEN/YELLOW go to comms only.**
7. **Jitter fix is a spike** (branch-only, proof-of-concept). Do not merge until hypothesis is confirmed.

---

## Sprint UX-1: Visual & Label Quick Wins (0.5 day)

> ✅ **Complete** — 7 files modified

### Issue 0 — De-Jargon All Player-Facing Text
**Complexity**: Small (30 min)

Replace cryptic abbreviations everywhere a new player would see them. The game is educational — it should teach terminology, not assume it.

#### [`TargetPanel.js`](../js/ui/hud/TargetPanel.js) changes

- [`_getShortTypeName()`](../js/ui/hud/TargetPanel.js:532) at line 532 — update the switch/map:
  - `'rocketBody'` → `'Rocket Body'` (currently `"R/B"`)
  - `'missionDebris'` → `'Mission Deb'` (currently `"MRD"`)
  - `'fragment'` → `'Fragment'` (currently `"Frag"`)
  - `'defunctSat'` → `'Defunct Sat'` (keep as-is)
- [`_getFullTypeName()`](../js/ui/hud/TargetPanel.js:543) at line 543 — verify `'missionDebris'` maps to `'Mission Debris'` (already expected; confirm).
- [Line 604](../js/ui/hud/TargetPanel.js:604) — MOID badges `[HI] [MD] [LO]`: add `title="Minimum Orbit Intersection Distance"` on the badge `<span>`.
- [Lines 519–524](../js/ui/hud/TargetPanel.js:519) — Chemical element hint icons (`Xe` at 519, `In` at 520, `☀` at 521, `⚡` at 522, `⚠` at 523, `Li` at 524): add `title` tooltips:
  | Symbol | Tooltip |
  |--------|---------|
  | `Xe` | `title="Xenon fuel"` |
  | `In` | `title="Indium metal"` |
  | `Li` | `title="Lithium"` |
  | `☀` | `title="Solar panel (GaAs)"` |
  | `⚡` | `title="Battery"` |
  | `⚠` | `title="Hydrazine (hazardous)"` |

#### [`TargetReticle.js`](../js/ui/TargetReticle.js) changes

- [`_getTypeName()`](../js/ui/TargetReticle.js:1686) at line 1686 — update:
  - `'missionDebris'` → `'MISSION DEB'` (currently `"MRD"` at line 1690)
  - `'rocketBody'` — already returns `'ROCKET BODY'` ✅ (no change needed)

#### [`StatusPanel.js`](../js/ui/hud/StatusPanel.js) changes

- [Line 297](../js/ui/hud/StatusPanel.js:297): `Xe` → `Xenon`, `Gs` → `ColdGas`, `Bt` → `Battery` (or 4-char labels with `title` tooltips)
- [Line 304](../js/ui/hud/StatusPanel.js:304): `[AP: OFF]` → `[Autopilot: OFF]`
- [Line 328](../js/ui/hud/StatusPanel.js:328): `EDT` → `E-Tether` with `title="Electrodynamic Tether"`
- [Line 336](../js/ui/hud/StatusPanel.js:336): Add `title="MPD engine wear indicator"` to CATHODE label
- [Line 356](../js/ui/hud/StatusPanel.js:356): `THR` → `Throttle`
- [Line 381](../js/ui/hud/StatusPanel.js:381): Add `title="Fuel mass breakdown (Tsiolkovsky)"` to MASS BUDGET

#### [`CommsSystem.js`](../js/systems/CommsSystem.js) changes

- [Line 109](../js/systems/CommsSystem.js:109): `CME approaching` → `Coronal Mass Ejection approaching`
- [Line 115](../js/systems/CommsSystem.js:115): `Kp={kp}` → `Geomagnetic storm index Kp={kp}`
- [Line 146](../js/systems/CommsSystem.js:146): `source: '18 SDS'` → `source: '18th Space Defense Squadron'`
- [Line 136](../js/systems/CommsSystem.js:136): `source: 'SDA'` → `source: 'Space Domain Awareness'`

#### [`TeachingSystem.js`](../js/systems/TeachingSystem.js) changes

- [Line 55](../js/systems/TeachingSystem.js:55): `first_conjunction` moment body text — replace `"CA system"` with `"Collision Avoidance system"`

#### Acceptance criteria

- No abbreviation appears without either (a) being spelled out on first use, or (b) having a `title` tooltip.
- Run the full game and verify every HUD element.

---

### Issue 5 — Simplify Target Reticle (Remove Arcade Pulsing)
**Complexity**: Trivial (15 min)

The reticle has 5 simultaneous animated effects. Keep the informational ones, remove the decorative ones.

#### [`TargetReticle.js`](../js/ui/TargetReticle.js) changes

| Line | Effect | Action |
|------|--------|--------|
| [693](../js/ui/TargetReticle.js:693) | Bracket breathing | Reduce amplitude from `0.06` to `0.015` (barely perceptible) |
| [713](../js/ui/TargetReticle.js:713) | Alpha pulse | Replace `0.7 + 0.3 * Math.sin(this._time * PULSE_SPEED * 2π)` with constant `globalAlpha = 0.85` |
| [725–726](../js/ui/TargetReticle.js:725) | Shadow glow | Reduce `shadowBlur` from `8` to `2` (or set `shadowBlur = 0` to remove entirely) |
| [904](../js/ui/TargetReticle.js:904) | Lead indicator pulsing | Replace `0.6 + 0.4 * Math.sin(this._time * 4)` with constant `globalAlpha = 0.8` |
| [910–921](../js/ui/TargetReticle.js:910) | Tumble tick | **KEEP** — communicates tumble rate, critical for capture planning |

**Keep**: Tumble tick rotation (informational), lead indicator *position* (informational), bracket shape, info text.
**Remove**: Alpha pulsing, aggressive breathing, glow shadow, lead indicator pulsing.

#### Acceptance criteria

- Reticle is steady with subtle bracket breathing.
- Tumble tick rotates at the debris tumble rate.
- Lead indicator is a steady cyan dot.

---

### Issue 6 — Spiderman Web Tether Visual
**Complexity**: Small (45 min)

Replace arcade tether visuals with a taut, fast, clean web-style shot.

#### [`LassoSystem.js`](../js/systems/LassoSystem.js) changes

- [Line 749](../js/systems/LassoSystem.js:749): Remove sheath breathing — set `opacity = 0.5` constant (currently `0.55 + 0.08 * Math.sin(...)`).
- [Lines 757–769](../js/systems/LassoSystem.js:757): Remove energy pulse bead entirely — delete the sphere mesh creation and its per-frame position update.
- Remove trail spheres (the 8 yellow diminishing spheres) — they add arcade feel.
- **Keep**: Net geometry with weight spheres (this IS the "web spread"), catenary sag (`NET_TETHER_SAG: 2.0m`), contact flash (brief, informational).
- **Consider**: Replace thick `TubeGeometry` tether with thinner `BufferGeometry` `Line2` — 2 px white line that appears instantly on fire and stays taut. This gives the "Spiderman web line" feel — fast, straight, thin, purposeful.

**Visual goal**: Fire → thin white line snaps taut → net spreads at target → reel in with line staying taut. No pulsing, no beads, no trails.

#### Acceptance criteria

- Tether fires as a clean thin line.
- No animated effects on the tether itself.
- Net spreads at target end.

---

### NEW-2 — CommsPanel Progressive Luminance
**Complexity**: Trivial (10 min)

#### [`CommsPanel.js`](../js/ui/hud/CommsPanel.js) changes

- [Line 106](../js/ui/hud/CommsPanel.js:106): Add `data-hud-group="manage_comms"` attribute and `hud-dormant` CSS class to the container `<div>`.
- Ensure the `manage_comms` skill discovery adds `hud-active` class (already handled by the HUD's generic [`_activateGroup()`](../js/ui/HUD.js) mechanism).

#### Acceptance criteria

- CommsPanel starts at 30 % opacity, brightens to 100 % when the player first presses C.

---

## Sprint UX-2: Comms & Notification Overhaul (1.5 days)

> ✅ **Complete** — 12 files modified

### Issue 11 — Comms Pane: Top-Right, Wider, No Timestamps, 3 Lines
**Complexity**: Small (30 min)

#### [`CommsPanel.js`](../js/ui/hud/CommsPanel.js) changes

- [Lines 106–113](../js/ui/hud/CommsPanel.js:106): Move from `right: 10px; bottom: 10px` to `top: 10px; right: 10px`.
- Align right edge with [`TargetPanel`](../js/ui/hud/TargetPanel.js) (also `right: 10px`).

#### [`Constants.js`](../js/core/Constants.js) changes

- `COMMS.PANE_WIDTH_PX`: Change from `400` to `480` (fits ~70 chars per line at `10px` monospace — enough for 95 % of messages on one line).
- `COMMS.PANE_HEIGHT_PX`: Set to fit exactly 3 visible message lines (approx. 72 px at 10 px font + 6 px padding each ≈ 48 px content + header). This is the "default" height; C-tap expands.

#### [`CommsPanel.js`](../js/ui/hud/CommsPanel.js) timestamp removal

- [Line 446](../js/ui/hud/CommsPanel.js:446): Remove the `[${msg.timestamp}]` `<span>` entirely. Saves ~80 px horizontal space per line.
- **Keep** channel color stripe (left border) — it's informational and uses almost no space.

#### Acceptance criteria

- Comms is top-right, 3 lines visible, no timestamps.
- Most messages fit one line.
- Right edge aligns with the Tracked Targets pane.

---

### Issue 2 — Conjunction Alerts Route Through Comms
**Complexity**: Small (20 min)

GREEN/YELLOW conjunction alerts should appear as comms messages, not center-screen overlays. RED alerts keep the center overlay (they're critical).

#### [`ConjunctionSystem.js`](../js/systems/ConjunctionSystem.js) changes

- [`_doEmitAlert()`](../js/systems/ConjunctionSystem.js:562) around line 562 — after the existing `CONJUNCTION_WARNING` emit, add:

```js
eventBus.emit(Events.COMMS_MESSAGE, {
  source: '18th Space Defense Squadron',
  channel: 'ALERT',
  priority: tier === 'RED' ? 'CRITICAL' : tier === 'YELLOW' ? 'WARNING' : 'INFO',
  text: `CONJUNCTION ${tier}: ${type} at ${Math.round(distMeters)}m in ${Math.round(tca)}s`
});
```

#### [`HUD.js`](../js/ui/HUD.js) changes

- [`_showConjunctionAlert()`](../js/ui/HUD.js:1125) at line 1125 — only show the center-screen overlay if `detail.tier === 'RED'`. GREEN/YELLOW are suppressed from center overlay.

#### Acceptance criteria

- GREEN/YELLOW conjunctions appear **only** in comms.
- RED conjunctions appear in comms **AND** center overlay.

---

### Issue 10 — C-Key Toggles Expanded Comms
**Complexity**: Small (20 min)

#### [`CommsPanel.js`](../js/ui/hud/CommsPanel.js) changes

- [`_expandPane()`](../js/ui/hud/CommsPanel.js:326) at line 326: Change from auto-collapse timer to toggle.
  - Add `this._expanded` boolean state.
  - C-tap toggles between 3-line (default) and 10-line (expanded).
  - Remove the `setTimeout` auto-collapse.
- Visual feedback: When expanded, brighten border (`border-color` from `rgba(0, 255, 255, 0.6)` → `rgba(0, 255, 255, 1.0)`).
- C-hold continues to open radial menu (unchanged).

#### Acceptance criteria

- C-tap toggles comms between 3 lines and 10 lines.
- State persists until toggled again.
- C-hold opens radial menu.

---

### Issue 10B — Comms Boot Sequence
**Complexity**: Small (30 min)

Comms is the first system to boot during the VLEO intro.

#### [`GameFlowManager.js`](../js/systems/GameFlowManager.js) changes

- [Lines 161–192](../js/systems/GameFlowManager.js:161): During the VLEO intro hold (first 4 seconds), emit 2–3 comms messages with 1-second spacing:

| Delay | Payload |
|-------|---------|
| T+1 s | `{ source: 'SYSTEM', channel: 'CMD', text: 'Comm link online' }` |
| T+2 s | `{ source: 'HOUSTON', channel: 'CMD', text: 'Reading you five-by-five, Cowboy' }` |
| T+3 s | `{ source: 'SYSTEM', channel: 'CMD', text: 'Sensor array calibrating...' }` |

#### [`SkillsSystem.js`](../js/systems/SkillsSystem.js) changes

- Auto-discover `manage_comms` skill at game start (move from Tier 3 to Tier 0 / auto-grant). This ensures the comms panel activates from dormant state during boot.

#### [`AudioSystem.js`](../js/systems/AudioSystem.js) changes

- Add a `playTerminalBlip()` generator — short 800 Hz → 400 Hz FM sweep, 50 ms, low volume.
- Fire once per boot message.

#### Acceptance criteria

- During VLEO intro, comms panel lights up and 2–3 messages trickle in with blip sounds.
- Player has something to read during the cinematic.

---

### Issue 12 — Unified Notification Zone (Bottom Center)
**Complexity**: Medium (1 hour)

Create a single notification area for transient pilot messages.

#### [`HUD.js`](../js/ui/HUD.js) changes

- Add a new `#notification-zone` div:

```css
#notification-zone {
  position: fixed;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
  z-index: 100;
}
```

- This zone holds **ONE** message at a time with auto-fade (2–3 seconds).
- Priority system: `CRITICAL` replaces `INFO`; same-priority replaces previous.

#### Route these through the notification zone

| Message | Current location | Action |
|---------|-----------------|--------|
| "AUTOPILOT ACTIVE" / "AUTOPILOT DISENGAGED" | Inline in score panel at [`StatusPanel.js:929`](../js/ui/hud/StatusPanel.js:929) | Keep the persistent `[Autopilot: ...]` badge; add a transient notification on engage/disengage |
| Capture notification | `top: 15%` at [`StatusPanel.js:544`](../js/ui/hud/StatusPanel.js:544) | Move to notification zone |
| Scan complete | "3 targets discovered" | Route to notification zone |
| Tool mode changes | "Web Tether selected", "Crossbow Arm selected" | Route to notification zone |
| View changes | "COMMAND VIEW", "TACTICAL VIEW" — currently at [`CameraSystem.js:840`](../js/systems/CameraSystem.js:840) `top: 60px` | Move to notification zone |

#### Keep at current positions (do NOT move)

- **ΔV alarm bar** — always-visible resource indicator.
- **Warning strip** at `bottom: 170px` (STABILIZE, etc.) — urgent and persistent.
- **Score popup** at center — momentary reward feedback.

#### [`Constants.js`](../js/core/Constants.js) additions

- `NOTIFICATION.FADE_MS`: `2500` (default auto-fade duration)

#### [`Events.js`](../js/core/Events.js) additions

- `NOTIFICATION_SHOW`: New event constant for the notification zone.

#### Acceptance criteria

- One notification zone bottom-center.
- Transient messages appear and fade.
- Nothing blocks the targeting reticle or score bar.

---

## Sprint UX-3: Tool Progression & Scan Experience (1.5 days)

> ✅ **Complete** — multiple files modified

### Issue 8 — Decouple Arm Deploy from Camera Switch
**Complexity**: Small (20 min)

#### [`InputManager.js`](../js/systems/InputManager.js) changes

- [`_handleArmKey()`](../js/systems/InputManager.js:836) at line 836: Inside the deploy branch (line 850–857), remove the call to [`this._enterArmPilotCamera(arm)`](../js/systems/InputManager.js:856) at line 856. The arm deploys; the player watches from their current camera view.
- [Line 358](../js/systems/InputManager.js:358): `P` key still enters `ARM_PILOT` mode for the last-deployed arm.
- After deploy, emit a comms message:

```js
eventBus.emit(Events.COMMS_MESSAGE, {
  source: 'SYSTEM',
  channel: 'CMD',
  text: `Arm ${id} deployed — press P to pilot`
});
```

#### Acceptance criteria

- Number keys 1–6 deploy an arm without a camera switch.
- Player sees the crossbow launch from their current view.
- `P` enters arm pilot mode separately.

---

### Issue 4 — Web Tether Forward-Only + Beginner Tool Framing
**Complexity**: Small (30 min)

#### [`ArmUnit.js`](../js/entities/ArmUnit.js) changes

- [`deploy()`](../js/entities/ArmUnit.js:393) at line 393 (launchDirection computed at [line 425](../js/entities/ArmUnit.js:425)): After computing `launchDirection`, add a dot-product check against the mothership's prograde (forward) vector:

```js
const dot = launchDirection.dot(progradeVector);
if (dot < 0.3) {
  eventBus.emit(Events.COMMS_MESSAGE, {
    source: 'FLIGHT',
    channel: 'CMD',
    text: 'Target not in forward arc — align with autopilot first'
  });
  return; // reject deploy
}
```

- Only applies to lasso / web tether launches, **not** arm deploys.

#### [`LassoSystem.js`](../js/systems/LassoSystem.js) changes

- [`fire()`](../js/systems/LassoSystem.js:402) at line 402: Add same forward-arc check. Lasso should only fire forward.

#### [`CommsSystem.js`](../js/systems/CommsSystem.js) teaching messages

- When lasso is used on a target > 10 kg (too heavy): `"Target too massive for web tether — try deploying a Crossbow arm with G"`
- When lasso ammo is at 5 remaining: `"Web tether nets running low — Crossbow arms are reusable"`

#### Acceptance criteria

- Web tether only fires within ~72° forward cone (`dot ≥ 0.3`).
- Rejection shows a comms message explaining why.
- Heavy targets prompt arm suggestions.

---

### Issue 7 — Lasso Ammo System (20 shots)
**Complexity**: Small (30 min)

#### [`Constants.js`](../js/core/Constants.js) changes

- Add `LASSO.AMMO_MAX: 20` (in the existing `LASSO` section around line 769).
- Add lasso refill to shop items.

#### [`Events.js`](../js/core/Events.js) changes

- Add `LASSO_AMMO_CHANGED` event constant.

#### [`LassoSystem.js`](../js/systems/LassoSystem.js) changes

- Add property: `this._ammo = Constants.LASSO.AMMO_MAX`
- [`fire()`](../js/systems/LassoSystem.js:402) at line 402:
  - Check `if (this._ammo <= 0)` → reject with comms: `"Web tether depleted"`
  - On fire: `this._ammo--`
  - Emit `LASSO_AMMO_CHANGED` event with remaining count.

#### [`StatusPanel.js`](../js/ui/hud/StatusPanel.js) changes

- [Around line 488](../js/ui/hud/StatusPanel.js:488): Show `WEB: 17/20` instead of just `READY/COOLDOWN`.

#### Acceptance criteria

- Lasso starts with 20 shots.
- Count shown in HUD.
- Depleted lasso shows message suggesting arms.
- Refillable at shop.

---

### NEW-1 — Missing Teaching Moments
**Complexity**: Small (30 min)

#### [`TeachingSystem.js`](../js/systems/TeachingSystem.js) additions

Add to the moments array (around line 30):

| Moment ID | Trigger | Text |
|-----------|---------|------|
| `first_scan` | First S-key press (`SENSOR_SCAN_START` event) | "Quick Scan reveals nearby debris. Deep Scan (hold S) finds more targets at longer range." |
| `first_arm_deploy` | First G-key or number-key deploy (arm deploy event) | "Crossbow arms capture heavier targets at longer range. Manual piloting (P) earns 2× score." |

- Add corresponding event listeners for `SENSOR_SCAN_START` and arm deploy events in the TeachingSystem constructor.

#### Acceptance criteria

- First scan and first arm deploy show contextual teaching overlays.

---

### NEW-3 — Expose Arm 2× Manual Score
**Complexity**: Trivial (15 min)

#### [`CommsSystem.js`](../js/systems/CommsSystem.js) or [`ScoringSystem.js`](../js/systems/ScoringSystem.js) changes

- On first `ARM_CAPTURE` event where `method === 'manual'`:
  - Emit comms: `"Manual arm capture: 2× score bonus! Press P to pilot deployed arms."`
- On first `ARM_CAPTURE` event where `method === 'auto'`:
  - Emit comms: `"Auto-capture complete. Manual piloting with P earns 2× score."`

#### Acceptance criteria

- Player learns about the 2× bonus via comms on first arm capture (manual or auto).

---

### Issue 1 — Freeze Net ΔV at Discovery Time
**Complexity**: Small (30 min)

#### [`SensorSystem.js`](../js/systems/SensorSystem.js) changes

- [`_enrichData()`](../js/systems/SensorSystem.js:292) around line 292: When a target first reaches `"CLOSE"` data level, snapshot:

```js
debris.discoveredDeltaV = currentDeltaV; // set once, never updated
```

This field is computed via `totalDeltaV()` and frozen permanently.

#### [`TargetPanel.js`](../js/ui/hud/TargetPanel.js) changes

- [Lines 355–366](../js/ui/hud/TargetPanel.js:355): Use `t.discoveredDeltaV` (frozen) instead of live `t.deltaV` for the net computation.
- Update label: `"Net ΔV (at scan)"` to make it clear this is a scan-time estimate.
- Optionally show current ΔV alongside for comparison: `"Net: +45 m/s (scan) | Current cost: 12 m/s"`

#### Acceptance criteria

- Net ΔV value freezes at scan/discovery time.
- Label explains it's a scan-time estimate.

---

### Issue 9 — Targets Hidden Until Scanned (Staggered Reveal)
**Complexity**: Medium (1 hour)

#### [`Events.js`](../js/core/Events.js) changes

- Add `TARGET_DISCOVERED` event constant.

#### [`DebrisField.js`](../js/entities/DebrisField.js) changes

- [`_createDebrisData()`](../js/entities/DebrisField.js:334) around line 334: Add `discovered: false` flag to each debris entry.
- Auto-discover the single nearest debris at game start (so the player always has one target).
- [`getEnhancedTargetList()`](../js/entities/DebrisField.js:1438) at line 1438: Filter to only return `debris.discovered === true`.

#### [`SensorSystem.js`](../js/systems/SensorSystem.js) changes

- [`_completeScan()`](../js/systems/SensorSystem.js:354) around line 354: Set `discovered = true` on each newly detected target. Emit per-target `TARGET_DISCOVERED` events with 150 ms spacing (use a queue).

#### [`TargetPanel.js`](../js/ui/hud/TargetPanel.js) changes

- [`_updateTargetList()`](../js/ui/hud/TargetPanel.js:299) at line 299: Add CSS slide-in animation for newly discovered entries:
  - Each entry fades in with `opacity 0→1` + `translateX(20px)→0` over 200 ms.

#### [`AudioSystem.js`](../js/systems/AudioSystem.js) changes

- Add `playDiscoveryBlip()` — short ascending pip (200 Hz → 800 Hz, 40 ms). Fire per discovered target on the 150 ms interval.

#### Acceptance criteria

- Target panel starts with 1 nearest target.
- S-key scan reveals 1–3 additional targets with staggered 150 ms blip animations.
- Discovering targets feels like a radar sweep reward.

---

## Sprint UX-4: Jitter Spike & Architecture (1 day spike + TBD fix)

> ✅ **Complete** — Root cause confirmed (float32 precision), floating origin implemented

### Issue 3 — Debris Jitter: Float32 Precision Spike
**Complexity**: Medium-High (1 day spike)

**Root cause hypothesis**: Three.js float32 GPU instance matrices at ~66 scene units from origin give ±0.4 m precision. Camera tracks the player smoothly but debris positions are absolute.

#### Spike task (proof-of-concept, NOT final implementation)

1. In [`DebrisField._updateInstanceTransform()`](../js/entities/DebrisField.js:931) at line 931: Subtract camera position from debris world position before writing to the instance matrix. This makes all debris positions camera-relative, eliminating float32 precision loss at large world coordinates.
2. In [`SceneManager.js`](../js/scene/SceneManager.js): Set `instancedMesh.position` to camera position each frame (offsets the camera-relative matrix).
3. **Test**: Does jitter disappear? Measure with a static camera to confirm.

#### Files to modify (spike only)

- [`DebrisField.js:931–983`](../js/entities/DebrisField.js:931) — `_updateInstanceTransform()`
- [`SceneManager.js`](../js/scene/SceneManager.js) — frame loop

#### Risk mitigation

- Do this as a **branch**. If it works, implement properly. If not, investigate alternative causes (dt variance, propagation instability).

#### Acceptance criteria

- Spike confirms or refutes the float32 hypothesis.
- If confirmed, file a follow-up ticket for proper floating-origin implementation.

---

## Synergy Map

```
Sprint UX-1 (Visual Quick Wins)          Sprint UX-2 (Comms & Notifications)
┌─────────────────────────┐              ┌──────────────────────────────────┐
│ #0  De-jargon labels    │              │ #11 Comms top-right, wider,     │
│ #5  Simplify reticle    │              │     no timestamps, 3 lines      │
│ #6  Spiderman web tether│              │          ↓                      │
│ N2  CommsPanel luminance│              │ #2  Conjunction → Comms ALERT   │
└─────────────────────────┘              │ #10 C-key toggle expand         │
                                         │ #10B Comms boot sequence        │
                                         │          ↓                      │
                                         │ #12 Notification zone (bottom)  │
                                         └──────────────────────────────────┘
                                                    ↓
Sprint UX-3 (Tool Progression & Scan)    Sprint UX-4 (Spike)
┌─────────────────────────────────┐      ┌─────────────────────┐
│ #8  Decouple arm deploy/camera  │      │ #3  Jitter spike    │
│ #4  Web tether forward-only     │      │     (floating       │
│ #7  Lasso ammo (20 shots)       │      │      origin test)   │
│ N1  Teaching: scan + arm deploy │      └─────────────────────┘
│ N3  Expose 2× arm score         │
│ #1  Freeze Net ΔV at scan      │
│ #9  Staggered target reveal     │
│         ↑ depends on #1         │
└─────────────────────────────────┘
```

### "Comms as Teacher" chain

`N2` → `#11` → `#2` → `#10` → `#10B` → `#4 hints` → `N1` → `N3`

All tool progression messaging flows through the improved comms panel.

### "Scan as Reward" chain

`#1` → `#9` → `N1`

Freezing ΔV + staggered reveal + teaching moment makes S-key the most satisfying action.

### "Tool Ladder" chain

`#7` → `#4` → `N3` → `#8`

Ammo pressure + forward-only + score visibility + arm spectating creates natural progression.

---

## Cross-Cutting Rules

Every implementer **must** follow these rules for all Sprint UX changes:

### 1. EventBus pub/sub

All inter-module communication via [`EventBus.js`](../js/core/EventBus.js). 100 % event constants from [`Events.js`](../js/core/Events.js) — **zero raw strings**. Any new events (e.g., `LASSO_AMMO_CHANGED`, `TARGET_DISCOVERED`, `NOTIFICATION_SHOW`) must be added to [`Events.js`](../js/core/Events.js) first.

### 2. Constants-first

Every new tuning knob goes in [`Constants.js`](../js/core/Constants.js) with a named comment. **No magic numbers in system code.** Examples:

- `LASSO.AMMO_MAX`
- `NOTIFICATION.FADE_MS`
- `COMMS.BOOT_DELAY_MS`
- `COMMS.PANE_WIDTH_PX`
- `COMMS.PANE_HEIGHT_PX`

### 3. Regression test per change

Each issue that modifies behaviour needs at least one test. Add to existing test files where possible:

| Change | Test file |
|--------|-----------|
| LassoSystem ammo | [`test-LassoSystem.js`](../js/test/test-LassoSystem.js) |
| TargetPanel labels | [`test-CommsPanel.js`](../js/test/test-CommsPanel.js) or new `test-TargetPanel.js` |
| Teaching moments | [`test-TeachingSystem.js`](../js/test/test-TeachingSystem.js) |
| Notification zone | New `test-NotificationZone.js` |

### 4. Test suite must stay green

Baseline: **238 suites / 1,158 tests / 0 failures**. Run `node js/test/run-tests.js` after every change.

### 5. Scene scale M = 1e-5

Distances in metres in [`Constants.js`](../js/core/Constants.js); multiply by `M` at rendering boundary. **Never** store scene-unit values where km are expected.

### 6. TIME_SCALE_GAMEPLAY (10×)

Any physics per-tick must multiply `dt * TIME_SCALE_GAMEPLAY`. Factor-of-10 bugs → suspect this.

### 7. Progressive disclosure

New HUD elements start dormant (`.hud-dormant`, 30 % opacity) and activate on skill discovery. **Only exception**: comms boot sequence auto-discovers `manage_comms` (Issue 10B).

---

## Acceptance Criteria Summary

| ID | Issue | Sprint | Key Metric | Status |
|----|-------|--------|------------|--------|
| 0 | De-jargon | UX-1 | Zero unexplained abbreviations in gameplay | ✅ |
| 5 | Reticle | UX-1 | No pulsing; tumble tick + lead indicator steady | ✅ |
| 6 | Web visual | UX-1 | Thin line, no beads/trails/breathing | ✅ |
| N2 | Comms luminance | UX-1 | Panel starts at 30 % opacity | ✅ |
| 11 | Comms layout | UX-2 | Top-right, 480 px, 3 lines, no timestamps | ✅ |
| 2 | Conjunction | UX-2 | GREEN/YELLOW in comms only; RED keeps overlay | ✅ |
| 10 | C-key | UX-2 | Toggle 3 ↔ 10 lines; hold opens radial | ✅ |
| 10B | Comms boot | UX-2 | 2–3 messages during VLEO intro + blip sounds | ✅ |
| 12 | Notifications | UX-2 | Single zone bottom-center; AP/capture/view msgs | ✅ |
| 8 | Arm deploy | UX-3 | No camera switch on deploy; P enters pilot | ✅ |
| 4 | Forward-only | UX-3 | Web rejects targets outside ~72° forward cone | ✅ |
| 7 | Lasso ammo | UX-3 | 20/20 counter in HUD; depletion hints | ✅ |
| N1 | Teaching | UX-3 | Overlays on first scan + first arm deploy | ✅ |
| N3 | 2× score | UX-3 | Comms message on first arm capture | ✅ |
| 1 | Net ΔV | UX-3 | Frozen at scan time; labeled "(at scan)" | ✅ |
| 9 | Scan reveal | UX-3 | 1 target at start; S reveals more with blips | ✅ |
| 3 | Jitter spike | UX-4 | Float32 hypothesis confirmed or refuted | ✅ |
