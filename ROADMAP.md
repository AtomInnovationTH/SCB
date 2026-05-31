# Space Cowboy — Forward Roadmap

Open follow-ups discovered during **Delegation 2 (onboarding pipeline)** —
2026-05-31.  Each item is intentionally small and self-contained so that
future sessions can pick them up without re-reading the whole onboarding
specification.

## Active follow-ups

### 1. Net-inventory HUD readout — REDESIGN NEEDED

**Status:** SUSPENDED (Delegation 4 browser-playtest, 2026-05-31).
The initial [`NetInventoryPanel`](js/ui/hud/NetInventoryPanel.js:1) was
implemented but browser testing revealed it is too cartoony and cryptic
for a space sim. The panel is currently mounted but **never displayed**
(`display:none` by default, no code path calls `setVisible(true)`).
Internal event tracking and threshold logic still function (tests pass),
so the redesign only needs to address the visual presentation.

**What needs to change.**

- **Remove emoji-like styling.** The emoji glyphs were already replaced
  with plain text labels (`LASSO`/`NETS`) but the overall chip design
  still feels out-of-place in the HUD. Redesign to match the StatusPanel
  aesthetic (monochrome, subtle borders, integrated into the right column).
- **Progressive reveal.** Don't show until the player has fired a lasso
  at least once (skills gate on `collect_lasso` → `discovered`).
- **Simplified label.** Keep inline label as `total/max`; per-arm
  breakdown only in tooltip. This was already done in the current code.
- **Threshold comms.** The `INVENTORY_LOW` event and HOUSTON comms hint
  are wired and tested. Re-enable display once the visual redesign lands.

### 2. Space-bar heuristic mode (post-onboarding)

**Why.** Today the Space key has exactly two behaviours:

1. **During onboarding** — dispatches the active hint's primary key
   (`OnboardingDirector.pressActiveHint()`).
2. **After onboarding** — falls through to the legacy
   `LASSO_FIRE` body in [`InputManager`](js/systems/InputManager.js:1).

There is **no heuristic mode** today.  Once `onboarding_v1.mastered=true`,
Space should evaluate game state and "press the next sensible action":

| Condition                                                   | Action |
|-------------------------------------------------------------|--------|
| No active target                                            | `fireScan()` (Quick Scan) |
| Target > 5 km away                                          | `engageAutopilot()` |
| Target ≤ 50 m AND `mass ≤ 50 kg`                            | `fireLasso()` |
| Target > 50 m AND in-range                                  | `deployDaughter()` |
| In `ARM_PILOT` and arm `STATION_KEEP`                       | manual net deploy |

**Where.** Wrap the existing post-onboarding fall-through in
`InputManager._handleKeyDown.case 'Space'`.  The Director already
short-circuits during the 13-beat pipeline; this new heuristic should
only run when `onboardingDirector.isMastered()` returns true.  Keep the
helper methods (`fireScan`, `engageAutopilot`, `fireLasso`, …) as the
single source of truth.

## Earlier roadmap notes (kept for context)

These were already on the team's mental backlog before Delegation 2;
listed here so the doc is the single roadmap surface.

- **Per-strut labels** during the `struts` onboarding beat — currently
  only an emissive glow is applied
  ([`PlayerSatellite.highlightStrutsForBeat`](js/entities/PlayerSatellite.js:1)).
  A screen-space "STRUT n/k — α=DDD°" label primitive next to each
  strut tip would complete Spec §J without changing the gameplay path.

- **`arm_struts` / `inspect_mother` skills** — the onboarding
  `struts` and `inspect` beats do not have matching entries in
  [`Constants.SKILLS.CATALOG`](js/core/Constants.js:1) and therefore
  cannot tier-skip via the Director's "skill already practiced" path.
  Adding two CATALOG entries (with triggerEvents
  `STRUT_DEPLOY_INPUT` / `INSPECTION_TOGGLE`) would close that gap.

- **Welcome-field public surface vs. private legacy spawner.**  The
  public [`DebrisField.spawnWelcomeField`](js/entities/DebrisField.js:1)
  returns a deterministic plan and delegates real spawn work to the
  pre-existing private `_spawnWelcomeField`.  When future delegations
  rework the mission-1 cluster they should consolidate both paths and
  drop the legacy `welcomeSpawn` flag in favour of `welcomeField:true`.

---

## Delegation 3 deferred polish (2026-05-31)

Open follow-ups from the **Delegation 3 part-callout wireframes** sprint.

### D3-1. Interactive zone click (mouse hover / click on canvas)

**Why.** Auto-rotating zone highlights are educational but passive.
Letting pilots click a zone in MotherWireframe or DaughterWireframe to
pause the auto-tour and read that zone's detail makes the panel much more
interactive.

**What.** Add `pointerEvents: 'auto'` to the canvas and install a
`mousedown` handler that ray-casts the 2D canvas coordinate back to the
3D wireframe projection — whichever edge is nearest to the click
coordinates wins, and its zone index becomes the new `_zoneIndex`.

### D3-2. Voice readouts for zone names

**Why.** The Codex uses spoken callout text in the briefing.  Part callouts
could announce the zone name via the Web Speech API every time the
auto-rotation advances — "Barrel bus — 35 percent of satellite mass."

**What.** Wire into [`AudioSystem.js`](js/systems/AudioSystem.js:1)
`speakText(text)` (or add it) and call it from `MotherWireframe._render()`
when `_zoneIndex` changes.

### D3-3. CameraSystem debris-inspection zoom (subject='debris')

**Why.** When `I` is pressed in ARM_PILOT the camera currently does nothing
(by spec — "fall back: do nothing camera-wise").  A future polish pass
should call a new `CameraSystem.enterDebrisInspection(debrisWorldPos)` that
zooms the scene camera in on the arm's current target from the mother's POV.

**Where.** Add `enterDebrisInspection()` / `exitDebrisInspection()` to
[`CameraSystem.js`](js/systems/CameraSystem.js:1) and call it from
[`InputManager.toggleInspection()`](js/systems/InputManager.js:1) for the
`subject === 'debris'` branch.

### D3-4. StrutLabels hinge-angle accuracy

**Why.** The current [`StrutLabels.js`](js/ui/hud/StrutLabels.js:1)
`_hingeAngle()` reads the Euler rotation magnitude of the pivot group as a
proxy for the hinge angle.  The actual sweep axis varies per-strut with
azimuth.  A more accurate reader should decompose the quaternion along the
tangential sweep axis `(-sin(azRad), cos(azRad), 0)`.

**Where.** Extend `_hingeAngle(pivotGroup, azRad)` and pass `sg.azRad`
from the strutGroups array.

### D3-5. MotherWireframe arm count live update

**Why.** The Crossbow Arms zone info line currently calls
`armManager.getArms()` which iterates over all arms each frame.  For
performance, cache the count and only update it on `ARM_STATE_CHANGE`
events.

**Where.** Add an `ARM_STATE_CHANGE` subscriber to MotherWireframe that
updates `_dockedArmCount`.
