# ROSA Solar Panels — Fidelity Upgrade + Furl/Unfurl Hotkey

## Goal
1. Make the Mother's ROSA (Roll-Out Solar Array) panels look and behave more like
   the real hardware: the **canister/spool**, **edge booms**, **blanket**, **tip
   spreader bar**, **root yoke**, plus accurate **position / rotation / furl /
   unfurl**.
2. Add a `,` (Comma) hotkey that **furls / unfurls** the panels at runtime — mirroring
   how `.` (Period) deploys / stows the struts — so the player can retract the arrays
   to avoid debris or tether strikes.

---

## 1. Analysis — current implementation vs. real ROSA

### Where it lives
- Geometry: `js/entities/PlayerSatellite.js` → `_buildSolarPanels()` (lines ~1486–1702),
  `_setRosaWingProgress()` (~1709), `_updateRosaPanels()` (~1720), `_animateSolarTracking()` (~2254).
- Spec constants: `js/core/Constants.js` → `OCTOPUS_V5.ROSA_*` (lines ~634–645).
- Deploy progress source: `js/systems/LaunchSequence.js` → `getRosaProgress()` (~203).
- The **menu hero scene reuses the real `PlayerSatellite`** (`js/ui/MenuScene3D.js:1038`),
  so any model improvement here automatically upgrades the hero scene. (Note: the
  table in `MOTHER_MODEL_UPGRADES.md` §2 lists "tip spreader/root yoke" as if present —
  it is **aspirational**; the current `_buildSolarPanels` has none of that. This plan
  closes that gap.)

### Current model (two wings at 0°/180°, ±X)
Per wing the hierarchy is: `panelRightPivot` (tilt) → `_rosaPanelWrapper1` (`scale.x`
drives roll-out) → front cell `ShapeGeometry` + back Kapton `ShapeGeometry` + gold
`EdgesGeometry` outline + wireframe grid; plus a thin `_rosaRoll1` cylinder at the root.

What real ROSA actually looks like — **verified** against the NASA/Redwire facts
(en.wikipedia.org/wiki/Roll_Out_Solar_Array, Redwire/Deployable Space Systems design):
- **Shape:** a flexible PV **"center wing" blanket** carrying strings of PV cells, with
  **one narrow arm running the full length along EACH long edge** — the *high-strain
  composite boom*. The booms look like **split/slit tubes** of stiff composite, flattened
  and rolled up lengthwise. These two edge spars are ROSA's signature silhouette (NOT a
  central spine).
- **Storage:** the whole wing **rolls up into a compact cylinder** around a root
  **spool/mandrel** — "operates the same way a measuring tape unwinds on its spool."
  Compact roll = launch config; it's a **drum/roller, not a thick enclosed canister**.
- **Deployment:** **passive — no motor.** Strain energy stored in the two coiled booms
  releases as each boom transitions from coil → straight, tensioning the blanket flat.
- **Size (reference):** the 2017 ISS test wing was **1.6 m wide**; DART arrays extend to
  **8.53 m (28 ft) long**; iROSA are roughly **half the width of the old ISS wings** and
  cant **~10°** off the legacy array plane. The game's `1.0 m × 2.0 m` compact wing is a
  fair scaled-down servicer array (could nudge width toward 1.6 m for a nod to the test).
- **Appearance:** dark blue/black cells (sun side), light Kapton/composite back, visible
  cell-string grid; the two slit-tube booms read as pale composite rails down both edges.
- **Reusability / re-stow — IMPORTANT CAVEAT:** real ROSA is **one-way passive** and is
  **not designed to reliably re-roll**. In the 2017 ISS test, ground controllers **could
  not re-lock it in the stowed configuration and the array was jettisoned.** So a
  furl-on-demand control is a **gameplay/sci-fi liberty**: the Mother is a next-gen
  *motorized re-furlable* array (plausible future tech), but this diverges from current
  flight ROSA. We accept the divergence for the debris/tether-dodge mechanic and document
  it (e.g. a one-line Codex note) rather than pretend it's flight-accurate.

### Gaps to fix
| # | Gap | Current | Target |
|---|-----|---------|--------|
| G1 | No edge booms | single thin root rod | **two** slit-tube composite booms along **both long edges**, full length, growing with deploy |
| G2 | No tip spreader bar | absent | thin cross-bar at the outboard tip holding blanket width |
| G3 | No root spool/mount | thin `rollGeo` cyl, binary `visible` toggle | root **roller drum/mandrel** (blanket+booms wind onto it) + short mounting **bracket** to the bus mast (not a big canister/yoke) |
| G4 | Roll-out is pure x-scale | wrapper.scale.x 0.05→1.0 | keep scale-driven roll-out but have booms + spreader track the deployed fraction; the root drum shows the stowed **roll** (fat when stowed → bare mandrel when deployed) |
| G5 | No runtime furl control | progress only from LaunchSequence | player-controllable furl state (see §3) |
| G6 | Tracking clamp ±30° | single-axis tilt | keep (clearance-driven) — only confirm furled panels stop tracking |

---

## 2. Model fidelity upgrades (`PlayerSatellite._buildSolarPanels`)

Refactor the per-wing build into a reusable helper so wing 1 (+X) and wing 2 (−X)
share code (currently duplicated). Per wing, add child meshes parented to the same
`_rosaPanelWrapper{1,2}` so they inherit the `scale.x` roll-out (or are scaled/positioned
from the deploy fraction in `_setRosaWingProgress`):

1. **Root roller drum + stowed roll (G3).** Replace the thin `_rosaRoll{1,2}` rod with a
   short **drum/mandrel** at the wing root (radius ≈ `0.05 m`, length ≈ `ROSA_WIDTH`),
   oriented along the width axis. Render the **stowed blanket roll** as a slightly larger
   coaxial cylinder whose radius shrinks as deploy progresses (fat roll when stowed →
   bare mandrel when deployed). Dark composite material (`rollMat`).
2. **Root mounting bracket (G3).** A small bracket/strut between the barrel surface
   (`barrelR`) and the drum so the wing reads as standing off the bus mast (matches the
   real "support bracket on the mast can" mounting — not a big yoke/gimbal arm).
3. **Two edge booms (G1).** Two thin tubes/`CylinderGeometry` running the **full length**
   along **both long edges** (`±rosaW/2` in wrapper-local space — i.e. the `0` and `rosaW`
   edges of the shape), pale composite tint to read as slit-tube spars. Parent them so
   `scale.x` extends them with the blanket; their visible length tracks deploy progress.
4. **Tip spreader bar (G2).** A thin cross-bar `CylinderGeometry` at the blanket's
   outboard edge spanning the width, parented to the wrapper so it rides to full extension.
5. **Material/visual polish.** Keep existing front cell / back Kapton / gold edge / grid
   shader stack (it has hard-won depth-fighting fixes — see the `FIX_PLAN §2-followup`
   comments; do NOT regress those `depthTest/depthWrite/renderOrder` settings).
6. Keep wing azimuths at 0°/180° (±X) and the shared `_solarArrayPivot`. No layout move.

`_setRosaWingProgress(wing, progress)` extends to: scale the wrapper as today, AND shrink
the stowed-roll cylinder radius with progress. Keep it cheap (transform/scale only; no
geometry rebuilds).

### New constants (`Constants.OCTOPUS_V5`)
- `ROSA_BOOM_OD` (≈ 0.02 m), `ROSA_DRUM_R` (≈ 0.05 m), `ROSA_SPREADER_OD` (≈ 0.015 m),
  `ROSA_BRACKET_LEN` (≈ 0.06 m).
- `ROSA_FURL_RATE` — furl/unfurl speed. **Decision: snappy ~2.5 s full cycle** (fraction/s
  ≈ 0.4), matching the responsive `.` strut feel rather than the 6 s launch roll-out.

---

## 3. Runtime furl/unfurl state (decouple from LaunchSequence)

Today `_updateRosaPanels()` **overwrites** wing progress from `LaunchSequence.getRosaProgress()`
every frame, so any manual change would be clobbered. Introduce a player-owned furl state:

- Add fields in `PlayerSatellite` ctor: `this._rosaFurlTarget = 1.0` (1 = unfurled,
  0 = furled), `this._rosaFurlProgress = 1.0` (animated current value), and a flag
  `this._rosaManualControl = false`.
- `_updateRosaPanels(dt)` logic:
  - If the launch sequence is **active** (`LaunchSequence.isActive()` / not READY),
    keep current behavior (read `getRosaProgress()`), and keep `_rosaFurlProgress` synced
    to that so there's no jump when control hands over.
  - Once launch is **READY** (or no launch sequence), drive `_rosaFurlProgress` toward
    `_rosaFurlTarget` at `ROSA_FURL_RATE * dt`, then call
    `_setRosaWingProgress(1/2, _rosaFurlProgress)`.
- Public API (mirrors strut toggle ergonomics):
  - `toggleRosaFurl()` → flips `_rosaFurlTarget` between 0 and 1 based on current
    progress (`>= 0.5 ? furl(0) : unfurl(1)`), sets `_rosaManualControl = true`,
    returns the new target. Used by the hotkey.
  - Optionally `setRosaFurl(target)` for programmatic use/tests.
- **Sun tracking while furled:** in `_animateSolarTracking`, skip / freeze tilt when
  `_rosaFurlProgress < ~0.5` (a rolled-up blanket shouldn't gimbal).

### Power coupling — DECISION: reduce power proportionally
`PlayerSatellite._updateSolarPower()` (lines ~3935–3957) computes `resources.solarRate`
from combined `SOLAR_PANEL_AREA`. Split it so only the **ROSA share** is gated by furl:
- ROSA fraction = `ROSA_POWER / TOTAL_SOLAR_POWER` ≈ `1630/2450` ≈ 0.665; body-mount
  fraction (≈0.335, the 820 W GaAs body cells) stays always-on (they can't furl).
- Scale the ROSA portion of `solarRate` by `_rosaFurlProgress`, e.g.
  `solarRate *= (bodyFrac + rosaFrac * _rosaFurlProgress)`.
- Net effect: fully furled ≈ keeps ~33% (body cells) of peak solar; full sun + unfurled
  unchanged. Makes "furl to dodge debris" a real power tradeoff. Add a small
  `ROSA_BODY_POWER_FRACTION` (or derive from existing constants) — no magic numbers.
- StatusPanel `solarRate` readout updates for free (it reads `resources.solarRate`).

---

## 4. `,` (Comma) hotkey — furl/unfurl

`js/systems/InputManager.js`, `case 'Comma':` (currently only handles Debris Map "prev"
at ~line 997, and the map-open intercept at ~line 481). Mirror the `case 'Period':`
strut pattern:

```
case 'Comma':
  if (isGameplay && d.debrisMap && d.debrisMap.isVisible()) {
    d.debrisMap.selectPrev();           // keep existing map nav
    e.preventDefault();
  } else if (isGameplay && d.player && typeof d.player.toggleRosaFurl === 'function') {
    d.player.toggleRosaFurl();
    d.audioSystem?.playClick();
    eventBus.emit(Events.ROSA_FURL_INPUT);   // new event (onboarding/telemetry parity)
    e.preventDefault();
  }
  break;
```
- The Debris-Map-open intercept (line ~481) already returns early for `Comma`, so map
  navigation is preserved exactly as for `Period`.
- Guard with `!e.repeat` so holding the key doesn't thrash the toggle.

### Supporting wiring (parity with the `.` strut skill)
- `js/core/Events.js`: add `ROSA_FURL_INPUT: 'tutorial:rosa_furl_input'` near
  `STRUT_DEPLOY_INPUT` (line ~411).
- `js/ui/HotkeyOverlay.js`: add `[[','], 'toggle: Panels']` right after the
  `[['.'], 'toggle: Struts']` entry (line ~91).
- `js/core/Constants.js` hotkey/skill registry (~line 2287): **DECISION — plain hotkey,
  NOT a tracked skill.** Do **not** add a skill-registry entry, and do **not** touch
  `OnboardingDirector`. `,` stays a documented-but-undiscovered power-user control (still
  emits `ROSA_FURL_INPUT` for audio/telemetry parity, just nothing watches it for skills).
- (No `OnboardingDirector` change — see decision above.)

---

## 5. Files to change
- `js/entities/PlayerSatellite.js` — model upgrade (`_buildSolarPanels`, helper refactor),
  `_setRosaWingProgress`, `_updateRosaPanels`, new furl state + `toggleRosaFurl`,
  tracking-while-furled guard in `_animateSolarTracking`, ROSA-share power scaling in
  `_updateSolarPower`.
- `js/core/Constants.js` — new `ROSA_*` geometry + `ROSA_FURL_RATE` + power-fraction
  constants. (No hotkey-registry skill entry — plain hotkey.)
- `js/core/Events.js` — `ROSA_FURL_INPUT`.
- `js/systems/InputManager.js` — `Comma` furl handler.
- `js/ui/HotkeyOverlay.js` — help legend entry.
- (Optional) a one-line Codex note documenting the motorized re-furl as a Mother upgrade
  vs. passive flight ROSA (see §1 caveat) — only if a Codex entry fits cleanly.
- Tests: extend `js/test/test-InputManager-Hotkeys.js` (Comma fires furl + still maps
  prev when debris map open), and add a `PlayerSatellite` furl-state unit test (toggle
  flips target; `_updateRosaPanels` respects manual control when launch READY; respects
  LaunchSequence while active; furled → ROSA power share drops, body share stays).

## 6. Decisions (resolved)
1. **Power coupling:** furling **reduces power proportionally** — ROSA share gated by furl
   progress, body-mount cells stay on (§3 Power coupling).
2. **Onboarding:** `,` is a **plain hotkey**, not a tracked skill (no registry/Onboarding
   changes).
3. **Furl speed:** **snappy ~2.5 s** full cycle (`ROSA_FURL_RATE` ≈ 0.4/s).
4. **Realism caveat (accepted):** real flight ROSA is passive/one-way and was not
   re-stowable (2017 test jettison); the Mother's re-furlable motorized array is a
   deliberate gameplay liberty, optionally noted in the Codex.

## 7. Validation
- `npm test` (or `./test.sh`) — existing ROSA / LaunchSequence / InputManager suites must
  stay green; add the new cases above.
- Manual: launch sequence still ramps ROSA as before; after READY, `,` furls/unfurls both
  wings smoothly; panels stop sun-tracking while furled; furled cuts ~ROSA power share but
  body cells keep generating; `,` still navigates the Debris Map when it's open; hero menu
  scene shows the new edge booms / spreader / root drum detail.
- Watch for the known depth-fighting regressions on the grid/gold-edge (don't touch their
  `depthTest/depthWrite/renderOrder`).
