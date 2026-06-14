# Hotkey Cleanup & Audit

Goal: remove redundant key bindings, remap the de-spin laser to a mnemonic key,
make "net = N" the single capture verb, and bring every hotkey reference
(overlay, in-game hints, README, ARCHITECTURE, skills catalog) into agreement
with `InputManager.js` (the source of truth).

## Decisions (from user)
1. **De-spin laser: `U` → `H`** ("H = Hold", the laser is a hold action). `U`
   becomes free/reserved. **Library/Codex stays on `L`** (no relocation).
2. **Capture = `N` only.** `N` is the single net/capture key in BOTH mother
   (lasso) and daughter (ARM_PILOT / STATION_KEEP) modes. Remove `F`'s and
   `Space`'s capture roles. "Net is net."
3. **Drop the `Space` lasso alias.** Keep the OnboardingDirector "smart-default"
   (`pressActiveHint`) — it contextually dispatches the active hint's own key
   and is a teaching affordance, not a permanent lasso binding. Remove the
   explicit lasso-fire + daughter-net branches from the `Space` handler.
4. **Remove the standalone "Shift — Fine control" row** from the `?` overlay's
   "Piloting a daughter" card (note "(Shift = fine)" inline on the orbit row).

`F` keeps its mother-mode role (**Focus action → `_deployRecommended()`** in
`TargetSelector`, a real smart-dispatch button). Only `F`'s *daughter-mode net*
role is removed.

---

## Critical implementation note (don't regress multi-tool capture)
Today the daughter SK capture logic differs by key:
- **`F`** (InputManager ~988): `DAUGHTER_MULTITOOL` ON → `arm.dispatchSelectedTool()`
  (NET / MAGNET / GRIPPER / PAD); else `arm.captureFromStationKeep()`.
- **`N`** (InputManager ~1091): only `arm.captureFromStationKeep()` (net only).

Making `N` the sole capture key REQUIRES moving the `dispatchSelectedTool()`
branch into the `N` SK handler, otherwise magnet/gripper/pad tools stop working.

---

## Changes by file

### 1. `js/systems/InputManager.js` (source of truth)
- **`KeyU` case (~685–705):** delete. The KeyU keydown affordance (no-target
  warning) moves to `KeyH`.
- **`KeyH` case (~888–890):** replace the `// no-op (reserved)` body with the
  de-spin laser keydown affordance currently under `KeyU` (no-target warning +
  `playClickFail`, gated by `Constants.isFeatureEnabled('LASER_DESPIN')`,
  ARM_PILOT vs mother target resolution via `_getPilotedSkDespinTarget()`).
- **`processInput()` (~1699–1704):** change the held-key poll from
  `this.keys['KeyU']` → `this.keys['KeyH']` for `despinLaser.setFiring(...)`.
- **`KeyN` SK branch (~1087–1095):** adopt the multi-tool dispatch — when
  `DAUGHTER_MULTITOOL` is enabled and `dispatchSelectedTool` exists, call it;
  else `captureFromStationKeep()` (mirror the old `F` branch). Keep the
  TRANSIT/APPROACH `manualNetDeploy` path that `N` already has.
- **`KeyF` case (~983–1030):** remove BOTH ARM_PILOT branches (the SK
  dispatch/capture and the TRANSIT/APPROACH `manualNetDeploy`). In ARM_PILOT,
  `F` becomes inert. Keep the mother-mode `else` branch
  (`eventBus.emit(Events.FOCUS_ACTION)`) unchanged.
- **`Space` case (~1217–1267):** remove the ARM_PILOT `manualNetDeploy` branch
  and the final `lassoSystem.fire(...)` windup branch. KEEP the
  `onboardingDirector.pressActiveHint(this)` smart-default branch. (Lasso
  windup now lives only in the `KeyN` handler — also removes a duplicated
  windup block.)
- Update the large explanatory comments on `KeyU`/`KeyH`/`KeyF`/`KeyN`/`Space`
  to match (these comments are load-bearing project documentation).

### 2. `js/ui/DockingReticle.js` (in-game contextual hint panel)
- **Line ~659** SK net-status: `● [F] {tool} · [\`] cycle · [R] reel · [Esc] recall`
  → change `[F]` to `[N]`.
- **Line ~669** ready: `● NET READY — [F]/[N] fire` → `● NET READY — [N] fire`
  (single key; fixes the F/N duplication).
- **Line ~1008** tool-odds footer: `[\`] cycle   [F] fire` → `[\`] cycle   [N] fire`
  (this is the second on-screen `[F]` you flagged — now deduped to `[N]`).
- **Lines ~1324 / ~1344** de-spin advisories: `de-spin to freeze aspect [U]`
  and `tumbling … — de-spin [U]` → `[H]`.
- Update the method doc comment (~640–646) that says "SK fire verbs are F and N"
  → "SK fire verb is N".

### 3. `js/systems/ToolOdds.js`
- **Line ~201:** `tumbling … — de-spin [U]` → `[H]`.

### 4. `js/entities/CaptureNet.js`
- **Line ~398:** `…or de-spin the target (hold U)…` → `(hold H)`.
- **Line ~97** comment: `de-spin [U]` → `[H]`.

### 5. `js/systems/TeachingSystem.js`
- **Line ~172:** `Hold U to fire the de-spin laser…` → `Hold H …`.

### 6. `js/core/Constants.js`
- **SKILLS_CATALOG line ~2196** `inspect_mother`: `key: 'V'` → `key: 'I'`
  (inspection is bound to `I`; `V` only cycles Command/Overview — stale glyph).
- **SKILLS_CATALOG line ~2215** `arm_pilot_capture`: `key: 'F'` → `key: 'N'`
  (manual capture is now N).
- **Line ~2681** narrative copy `…de-spin (U) or close in…` → `(H)`.

### 7. `js/ui/HotkeyOverlay.js` (the `?` reference overlay)
- **"Essentials" card:** `N` "Fire lasso / net" — keep (now the universal net key).
- **"Capture & Tools" card:**
  - `[['U'], 'Hold: de-spin laser …']` → `[['H'], 'Hold: de-spin laser …']`.
  - `[['Space'], 'Smart action / fire lasso']` → `[['Space'], 'Smart action (does the current hint)']`
    (no longer a lasso alias).
  - `[['F'], 'Focus action']` — keep (mother-mode smart-dispatch).
- **"Piloting a daughter" card:**
  - Remove `[['Shift'], 'Fine control (hold)']`.
  - Change `[['F'], 'Net deploy / capture']` → `[['N'], 'Net / capture']`.
  - Append "(Shift = fine)" to the orbit row text:
    `[['↑','↓','←','→'], 'Orbit (station-keep) · Shift = fine']`.
- Update the header sync comment block (~19–22) to record the U→H, F→N,
  Space-alias-drop changes.

### 8. `README.md`
- **Controls one-liner (line ~18):** drop `Space alias` framing for lasso; ensure
  `N lasso/net` is the single net verb; `U` → `H` for de-spin.
- **Full reference (lines ~177, ~190, ~204, ~228–229):**
  - Remove `N alias = Space` line (~190).
  - `U · De-spin laser (hold …)` (~204) → `H · De-spin laser (hold …)`.
  - DAUGHTER block: `N · Deploy net / capture` stays; remove/Ë‡adjust
    `F · Smart focus (also deploys net)` (~229) → `F · (unbound in ARM_PILOT)`;
    `Shift = fine ¼` note stays on the Arrows row (~226).
  - Reserved list (~199–201): `U` joins `G/H? no` — note `U` now reserved, `H`
    now = de-spin laser.

### 9. `ARCHITECTURE.md` §6 (the "verified" map)
- **Row `U` (line ~201):** retitle to **`H`** = hold de-spin laser (mother +
  ARM_PILOT SK target). 
- **Row `Space / N` (line ~183):** N = lasso/net (both modes); drop the "Space
  alias" / "Space auto-exits" net framing — Space is now only the onboarding
  smart-default.
- **Row `F` (line ~184):** mother = focus action; ARM_PILOT = (inert).
- **Capture-FSM row (line ~248):** `(F/N in STATION_KEEP; F/N/Space manual…)`
  → `(N in STATION_KEEP; N manual in TRANSIT/APPROACH)`.
- **Inert/reserved line (line ~210):** add `U` (freed); remove `H` from the
  freed list (now de-spin laser).
- Bump the "verified against code" note/date.

### 10. `js/test/test-InputManager-Hotkeys.js`
- The `'H emits nothing (freed key, reserved)'` test (lines 87–94) is now stale.
  Repurpose it: assert `H` does NOT emit `ARM_RECALL_ALL`/recall (still true)
  AND that holding `H` is the de-spin path (e.g. after `_handleKeyDown('KeyH')`
  with no target it emits the de-spin warning COMMS_MESSAGE / `playClickFail`,
  not a recall). Add a small case asserting `U` is now inert.
- (Optional) add a case asserting daughter-mode `N` triggers capture and `F`
  does not, if the harness can stub a STATION_KEEP piloted arm.

---

## Redundancies resolved (summary)
| Before | After |
|---|---|
| Capture on `F`, `N`, `Space` (daughter) | `N` only (multi-tool dispatch preserved) |
| Lasso on `N` + `Space` (mother) | `N` only; `Space` = onboarding smart-default |
| `[F]` shown twice in DockingReticle (SK line + footer) | `[N]` shown once |
| `F` listed twice in `?` overlay (Focus action / Net deploy) | `F` = Focus action; net row = `N` |
| `Shift — Fine control` row in overlay | removed (inline note on orbit row) |
| `U` = de-spin laser (non-mnemonic) | `H` = Hold de-spin laser; `U` freed |
| Doc-only "Shift+I alias" noise | removed from README |
| Skill `inspect_mother` key `V` (stale) | `I` |
| Skill `arm_pilot_capture` key `F` | `N` |

## Out of scope / left as-is
- Skill id `radial_menu` (label "Fleet Recall", key `Shift+R`) — kept for
  save-compat; already documented.
- Throttle `+/-` in mother mode (vestigial under autopilot-first) — not touched.
- `K`, `G`, `H`(now used), `U`(now freed) reserved keys — no new features added.

## Verification
- `node js/test/run-tests.js` (or `./test.sh`) — all suites green, especially
  `test-InputManager-Hotkeys`, `test-StationKeep`, `test-ArmUnit-NetInventory`,
  `test-CaptureNet`, `test-TeachingSystem`, skills/HUD activate-key tests.
- Manual grep sweep: no remaining `[U]`, "hold U", or daughter-mode `[F]` /
  "F … net" references outside git history.
- In-game smoke: pilot a daughter to STATION_KEEP → `N` captures (and dispatches
  the selected multi-tool); `H` (hold) runs the de-spin laser with the SK target;
  `F` does nothing while piloting; mother-mode `F` still deploys recommended tool;
  `?` overlay matches; README/ARCHITECTURE match.
