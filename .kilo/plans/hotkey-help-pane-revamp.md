# Hotkey Simplification + Daughter-Selection Redesign

## Vision (from user)

Simplify and reorganize hotkeys to guide the project forward. The headline
change: **retire `P` / `Shift+P` (ARM PILOT toggle / cycle)**. Daughters are
managed directly with the number row — "spinning plates":

- **`1-4` is the single select/pilot verb.**
- Selecting a **docked** daughter → it **glows/flashes** as feedback (it is
  "selected" but still home).
- Selecting a **launched** daughter → the **view switches to that daughter** so
  the player can manage/multitask several daughters.

The help pane (`?`) must then reflect the simpler, accurate scheme. This plan
supersedes the earlier "label-fix only" plan: the pane work rides on top of a
real interaction simplification.

## Current Model (as-built)

- **`InputManager._handleArmKey(0-3)`** (digits 1-4):
  - same digit again → exit pilot + `deselectArm` (toggle home)
  - **DOCKED** → `deployArmByIndex` + `selectArm` + comms "press P to pilot"
    (NO camera switch)
  - **EXPENDED** → warn
  - **deployed** → `selectArm` + `_enterArmPilotCamera` (camera follows)
- **`P`**: toggle ARM PILOT on the selected/first-deployed arm.
  **`Shift+P`**: `_cyclePilotedArm` through all non-docked arms (the only way to
  reach arms 5-8).
- **`armPilotMode`** (InputManager flag) gates: WASD thrust, arrow-key SK orbit
  controls, and the meaning of context keys (R/N/V/H) in
  `_handleKeyDown` / `processInput`.
- **Camera**: `CameraSystem.setPilotArm(arm)` → `ARM_PILOT` view;
  `clearPilotArm()` → CHASE. Launch ceremony (`D`) auto-enters ARM_PILOT on
  completion.
- **Selection feedback today**: `selectArm` emits `ARM_SELECT` + comms line;
  `StatusPanel` re-renders a 2D arm panel. **No 3D glow/flash on the arm.**
- **Arm tiers**: `Y0_QUAD`=4, `Y1_HEX`=6, `Y3_OCTO`=8
  (`Constants.js:673-675`). `FEATURE_FLAGS.TIER_UPGRADES = false` → only 4 arms
  in play today. `Shift+P` existed to reach arms 5-8 once tiers ship.
- **Digit collisions**: `5`=Forge, `6`=fuel cycle, `7`=return-to-mother.
- **Return to mother** today: `Esc`, `P`, or `7`.
- **Onboarding**: `OnboardingDirector.js:225` says "Press P to pilot it".

## Proposed Model (decisions locked below)

1. **`1-4` = select daughter** (4 arms today; higher tiers deferred — D2).
   - Docked → select + glow/flash highlight; mother stays in view.
   - Deployed → select + switch camera to that daughter (pilot it).
   - Re-press the active daughter's digit → return to mother (toggle), replacing
     `P`'s "exit pilot" role.
2. **Remove `P` and `Shift+P`** from `_handleKeyDown`; collapse
   `armPilotMode` entry/exit into the digit + deploy paths.
3. **Keep `D` as deploy** (launch ceremony → auto-switch to the new daughter).
   Bare `D` deploys the *currently selected docked* daughter (1-4 picks which,
   D launches it) — D1.
4. **Glow/flash**: add a selection highlight on docked arm meshes driven by
   `ARM_SELECT`/`ARM_DESELECT` (new visual) + 2D panel sync — D4.
5. **Arms 5-8**: deferred until tiers ship — D2.
6. **Pane**: rebuild from a single-source-of-truth manifest reflecting the new
   scheme; drop `P`/`Shift+P`, document `1-4` select/pilot.

## Decisions (locked with user)

- **D1 — Docked `1-4` = SELECT + glow/flash only** (mother stays in view).
  `D` deploys the **selected docked** daughter. Pick-then-launch.
- **D2 — Defer arms 5-8.** `1-4` only now (`TIER_UPGRADES=false`); revisit when
  Y1_HEX/Y3_OCTO tiers ship. Do not silently regress the future path.
- **D4 — Both** 3D docked-arm mesh glow/flash **and** 2D `StatusPanel`
  highlight, kept in sync.
- **Scope — All together** (interaction redesign + pane rebuild in one change).
- **Ceremony — keep** the launch ceremony on `D`.
- **`P` / `Shift+P` — removed and left unbound.**
- **`7` — drop** its return-to-mother binding (free it).
- **`R` — unchanged context chain** (orbital: recall closest; AP engaged:
  abort; ARM_PILOT in STATION_KEEP: reel the piloted daughter home).
  **`Shift+R` — recall all** (unchanged). "R handles return to mother" =
  reeling physically brings the daughter home.
- **Return-to-mother (camera, leave daughter working)** = **re-press the active
  daughter's digit** (toggle → `_exitArmPilotCamera` + deselect, no recall);
  `Esc` also backs out (existing behavior retained). This is the canonical
  "spinning plates" pop-back path.

## Implementation Sketch (D1=select-only, D2=defer, D4=both, all-together, keep ceremony, P unbound, 7 freed, R unchanged)

### A. InputManager
- Delete the `KeyP` case (toggle) and `Shift+P` branch; delete
  `_cyclePilotedArm` (or retain privately if D2(c) chosen).
- Rework `_handleArmKey`:
  - DOCKED → `selectArm(index)` only (glow/flash via event); do **not** deploy.
  - deployed → `selectArm` + `_enterArmPilotCamera` (unchanged).
  - same-digit re-press → return to mother (`_exitArmPilotCamera` + deselect)
    WITHOUT recalling the daughter (it keeps working — spinning plates).
- Rework `KeyD`: bare `D` deploys the **selected docked** daughter
  (fallback to best-docked if none selected), preserving the ceremony +
  auto-pilot. `Shift+D` deploy-all unchanged.
- Remove `Digit7` return-to-mother binding (free the key).
- `R` / `Shift+R` unchanged (recall-closest in orbital, reel piloted in SK,
  recall-all on Shift+R).
- `armPilotMode` lifecycle now driven purely by digit-select of a deployed arm
  and ceremony completion; verify all `armPilotMode` reads still hold.
- Remove obsolete `KeyQ`/`KeyE` vertical thrust (`processInput:1628-1629`);
  fix `PlayerSatellite.js:3345` comment.

### B. Selection feedback (glow/flash)
- On `ARM_SELECT` for a DOCKED arm: apply an emissive pulse / highlight to that
  arm's meshes; clear on `ARM_DESELECT` or state change. Implement in
  `ArmUnit` (e.g. `setSelectedHighlight(bool)`) invoked by `ArmManager` or an
  HUD-side visual that reads `selectedArmIndex`.
- Keep `StatusPanel` 2D highlight in sync.

### C. Single-source-of-truth hotkey manifest + pane
- New `js/ui/HotkeyManifest.js`: structured entries
  (`{ keys, codes, mods, label, card, debug }`) reflecting the **new** scheme.
- Rebuild `HotkeyOverlay.js` to render from the manifest (keep DOM/style
  helpers + the 3-card Mother/Daughter/Advanced layout). Show all gameplay
  keys; mark `Ctrl+D`/`Ctrl+Shift+D`/`F2` as `debug` (excluded).
- Correct every wrong row found earlier (E/F/M/T/5/6/7/8/9/0, Shift+S/A/N/V),
  add the missing real keys, and remove `P`/`Shift+P`.

### D. Cleanup
- Remove deprecated `Events.TOOL_DEPLOY` (`core/Events.js:361`); keep the
  negative test, rewritten to not reference the removed constant.
- Update `OnboardingDirector.js:225` (drop "Press P to pilot"; teach `1-4`).
- Tidy low-risk obsolete breadcrumb comments.

### E. Tests
- Update `test-InputManager-Hotkeys.js`: assert `P`/`Shift+P` are now inert;
  assert digit-select behavior (docked select-only, deployed pilot, re-press
  returns home); assert `Q`/`E` no longer thrust.
- Add a manifest drift-guard test: every non-debug manifest key is actually
  bound in `InputManager`; no manifest entry references removed codes.

### F. Docs
- Update `README.md` controls table + `ARCHITECTURE.md §6` to the new scheme.

## Files Touched
- `js/systems/InputManager.js` (P removal, digit rework, D rework, Q/E removal)
- `js/entities/ArmManager.js` and/or `js/entities/ArmUnit.js` (select highlight)
- `js/ui/HotkeyManifest.js` (new), `js/ui/HotkeyOverlay.js` (render from it)
- `js/ui/hud/StatusPanel.js` (selection highlight sync, if needed)
- `js/core/Events.js` (remove `TOOL_DEPLOY`)
- `js/entities/PlayerSatellite.js` (comment fix)
- `js/systems/OnboardingDirector.js` (re-teach selection)
- `js/test/test-InputManager-Hotkeys.js` (+ new manifest test, `run-tests.js`)
- `README.md` (+ `ARCHITECTURE.md` pointer)

## Validation
- `./test.sh` — all suites green incl. new selection + drift tests.
- Manual: deploy/select multiple daughters with `1-4`, confirm docked glow,
  launched view-switch, re-press returns to mother, `?` pane matches reality,
  `Q`/`E` inert.

## Risks
- `armPilotMode` is read widely; collapsing its entry points must not strand any
  context-key branch (R/N/V/H, SK orbit controls).
- 3D docked-arm highlight needs reliable mesh/material handles on docked arms.
- Arms 5-8 selection is unresolved until tiers ship (D2) — must not regress the
  future tier path silently.
