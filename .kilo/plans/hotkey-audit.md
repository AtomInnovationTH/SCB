# Hotkey Audit & Implementation Plan

Source of truth: the `?` help overlay — `js/ui/HotkeyOverlay.js` (`HOTKEY_GROUPS`).
Implementation: `js/systems/InputManager.js` (`_handleKeyDown` one-shots + `processInput` held-keys).

## Method

I extracted every row from the three help-pane cards (Mother / Daughter / Advanced)
and matched each to its `case` in `InputManager._handleKeyDown` (or the held-key
poll in `processInput`). "Mode" = whether `armPilotMode` is active (piloting a
daughter) vs. mother command-chair.

---

## 1. Full audit table (help pane → implementation)

### Mother card (`HotkeyOverlay.js:34-49`)
| Key | Help label | Implemented? | Where |
| --- | --- | --- | --- |
| ↑↓←→ | Rotate | yes | `processInput` mother rotation (`InputManager.js:1738-1819`) |
| V | View | yes | `KeyV` cycleView (`:617`) |
| S | Scan | yes | `KeyS` SCAN_QUICK (`:880`) |
| T | Target debris | yes | `KeyT` `_cycleTarget` (`:1047`) |
| A | Autopilot to target | yes | `KeyA` toggle (`:869`) |
| N | Net launch | yes | `KeyN` mother lasso `fireLasso` (`:991`) |
| D | Daughter launch | yes | `KeyD` deploy selected/auto (`:815`) |
| R | Reel-in | yes (context-chained) | `KeyR` recallClosest (`:709`) |
| Shift+V | View big picture | yes | strategic map toggle (`:619`) |
| Shift+S | Scan big area | yes | SCAN_WIDE (`:882`) |
| Shift+A | Autopilot to debris center + launch all | **partial — see §2.2** | `:856` |
| Shift+N | Auto-target + launch at debris in range | yes | `_autoTargetAndLaunch` (`:945`) |
| Shift+D | Daughters launch all | yes | `deployAllToTarget` (`:809`) |
| Shift+R | Reel-in all | yes | ARM_RECALL_ALL (`:666`) |

### Daughter card (`HotkeyOverlay.js:55-68`)
| Key | Help label | Implemented? | Where |
| --- | --- | --- | --- |
| ↑↓←→ | Rotate around debris | yes | SK orbit controls (`processInput :1610-1641`) |
| V | View | yes | V cycles in ARM_PILOT too (`:617`) |
| S | Scan | yes | not mode-gated (`:880`) |
| T | Target debris with tools | yes | not mode-gated (`:1047`) |
| A | Autopilot to target | yes | not mode-gated (`:854`) |
| N | Net launch | yes | SK capture / TRANSIT net (`:949`) |
| D | Daughter launch | yes | not mode-gated (`:802`) |
| R | Reel-in | yes (piloted daughter) | `:679` |
| 1–4 | Select daughter | yes | `_handleArmKey` (`:1123-1158`) |
| H | Hold steady with laser | yes | de-spin laser (`:768`, held-poll `:1552`) |
| E | Electro Dynamic Tether | yes | EDT_DEPLOY (`:753`) |
| X | Tether detach | yes | `:1076` |

### Advanced card (`HotkeyOverlay.js:76-90`)
| Key | Help label | Implemented? | Where |
| --- | --- | --- | --- |
| B | Buy | yes | shop (`:636`) |
| F | Forge | yes | FORGE_TOGGLE (`:899`) |
| J | Journal | yes | SkillsPane (`:1004`) |
| L | Library | yes | codex (`:1284`) |
| M | Map | yes | debris map (`:645`) |
| ? | Help | yes | Slash (`:1297`) |
| Esc | Pause / back | yes | `:558` |
| 5 | toggle: City names | yes | `:1164` |
| 6 | toggle: Constellation names | yes | `:1171` |
| 7 | toggle: Comms | yes | `:1178` |
| 8 | toggle: NavSphere | yes | `:1186` |
| 9 | toggle: Debris pane | yes | `:1193` |
| 0 | toggle: Target pane | yes | `:1200` |
| . | toggle: Struts | yes | `:1020` |

**Headline finding:** every help-pane binding has a code path. The real work is
not "missing bindings" but **two behavioral gaps the user flagged**, plus the
mother-mode `R` overload described below.

---

## 2. Work items

### 2.1 `R` / `Shift+R` — Reel-in must work in mother AND daughter (Example 1)

**User confirmation:** `R` / `Shift+R` *do nothing in some mode* — a dead/silent
binding, not just the AP-abort overload.

Current behavior (`InputManager.js:662-731`):

- **Daughter (armPilotMode):** `R` reels the *piloted* daughter from any live
  state (`:679`); when the piloted arm is DOCKED/EXPENDED it emits a "No daughter
  to reel in" notice.
- **Mother, autopilot ON:** `R` aborts autopilot, does NOT reel (`:697`).
- **Mother, autopilot OFF:** `R` recalls the closest deployed daughter (`:709`);
  when none are deployed it emits "No deployed daughters to reel in".
- **Shift+R:** emits `ARM_RECALL_ALL` globally before the mode chain (`:666`);
  the `ARM_RECALL_ALL` handler is `ArmManager.recallAll` (`ArmManager.js:264`,
  `:738`) which silently no-ops when no arms are deployed.

**Step A — pin the dead mode (first implementation task).** All branches *look*
reachable, so the silent case is a gating/feedback gap. Candidate dead modes to
verify at runtime / by reading the guards:
  - the `if (isGameplay)` guard (`:663`) — `R` is inert outside gameplay states;
  - mother mode with a daughter *selected but DOCKED* (armPilotMode false) → falls
    to `recallClosestDeployed` which finds no DEPLOYED arm → feels dead;
  - `Shift+R` when `recallAll` iterates zero deployed arms → no comms feedback;
  - any open overlay/map intercept that returns before the `KeyR` switch
    (`:426-501`).

**Step B — fix.** Make the reel verbs behave consistently and always give
feedback:
  - bare `R` always attempts a reel-in first in both modes (daughter → piloted;
    mother → closest deployed), and only falls through to autopilot-abort when
    there is **no daughter to reel**; keep `Esc` as the dedicated AP/pause back-out;
  - `Shift+R` recall-all works in both mother and daughter and always emits a
    comms result (including the "nothing to recall" case) so it is never silent;
  - ensure no overlay/intercept silently swallows `R`/`Shift+R` during gameplay.

**Step C — tests** (`test-InputManager-Hotkeys.js`):
  - `R` in armPilotMode reels piloted daughter (incl. while AP engaged);
  - `R` in mother with AP engaged + a deployed daughter → recalls (does not just
    abort AP);
  - `R`/`Shift+R` always emit a comms message rather than silently no-op when
    there is nothing to reel, in BOTH modes;
  - `Shift+R` reel-all fires in mother and daughter mode.

### 2.2 `Shift+A` — field-center + mother net + spread daughters (Example 2)

Current behavior (`InputManager.js:854-875`): `engageSelectedCluster()` (AP to the
selected cluster centroid) + `deployAllToTarget(activeTarget)` — every daughter
is sent to the **same single** active target, and the **mother net is never
fired**. The help label ("Autopilot to debris center + launch all") documents
this weaker behavior, so the help text will also need a wording update.

Desired behavior (user): one keypress that maximizes quick, high-risk salvage —

1. **Move mother to the center of the debris field.** Reuse the cluster
   autopilot, but auto-select the densest/highest-value cluster (the field
   center) rather than relying on whatever cluster is currently highlighted in
   the map. `DebrisMap` already ranks clusters (`_rankedClusters`,
   `getSelectedCluster` at `DebrisMap.js:176-191`); add a "select best then
   engage" helper or call `engageSelectedCluster` after forcing index 0.
2. **Fire the Mother Net** at a **separate** debris — distinct from the ones the
   daughters are assigned (user choice). Acquire the best in-range debris not
   already claimed by a daughter, then `fireLasso()` at it. Reuse the
   target-acquire logic in `_autoTargetAndLaunch` (`:1364`) but exclude the
   daughters' assigned debris IDs.
3. **Launch each daughter at a *different* debris (all docked daughters).** New
   ArmManager method, e.g. `deployAllToDistinctTargets(targets)`, that:
   - pulls the top-N in-range debris from
     `debrisField.getEnhancedTargetList(...)` (TPI-sorted, tracked/IR filtered —
     same source as `_cycleTarget`/`_autoTargetAndLaunch`),
   - assigns the i-th docked daughter to the i-th distinct debris (every docked
     daughter fans out — no cap),
   - falls back to the mother's active target if fewer debris than daughters.
   This replaces the single-target `deployAllToTarget(activeTarget)` in the
   Shift+A path only (Shift+D keeps its "all to one target" semantics).
4. Update the Mother-card help row text (`HotkeyOverlay.js:46`) to describe the
   new behavior, e.g. "Autopilot to field center + net + fan-out daughters".
5. Tests: new `ArmManager.deployAllToDistinctTargets` unit test (distinct
   assignment + fallback) and an InputManager Shift+A test asserting (a) cluster
   autopilot engaged, (b) mother net fired, (c) daughters got distinct targets.

---

## 3. Guidance drift (keep in sync)

`test-GuidanceHotkeyDrift.js` already guards onboarding/teaching/coach copy and
the skills-catalog glyphs against stale keys. Any binding change above must keep
these green; if `R` semantics change, check arm-idle / onboarding copy that
mentions reel-in, and update the skills catalog glyph if a new verb is added for
the Shift+A fan-out.

---

## 4. Scope & confirmed decisions

- **Scope:** implement both flagged items (`R`/`Shift+R`, `Shift+A`) **and add
  regression tests hardening every audited binding** in §1 against drift — i.e.
  extend `test-InputManager-Hotkeys.js` so each help-pane row has an assertion
  that its `case` still fires the expected event/effect, in the correct mode.
- **Example 1 (`R`):** treated as a dead/silent binding in some mode — see §2.1
  Step A (pin the mode) → Step B (make reel-in work + always give feedback in
  both mother and daughter) → Step C (tests).
- **Shift+A fan-out:** **all docked daughters** fan out to distinct debris; the
  **mother net fires at a separate nearby debris** (not one of the daughters'
  targets), after autopiloting to the field center.
- **Help text:** update the Mother-card Shift+A row (`HotkeyOverlay.js:46`) to
  match the new behavior, and re-run `test-GuidanceHotkeyDrift.js` after any
  binding/copy change.

## 5. Implementation order

1. §2.1 Step A — investigate and pin the dead `R`/`Shift+R` mode.
2. §2.1 Step B/C — fix reel-in cross-mode + feedback, add tests.
3. §2.2 — add `ArmManager.deployAllToDistinctTargets`, rework Shift+A
   (field-center autopilot + separate-target mother net + fan-out), update help
   text, add tests.
4. §1 — backfill regression assertions for every audited binding.
5. Run the full suite incl. `test-GuidanceHotkeyDrift.js`.
