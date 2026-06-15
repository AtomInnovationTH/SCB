# Hotkey remap: De-spin laser H → L, Info (Codex/Tech Library) L → I

## Goal

Swap two existing hotkeys and propagate the change through every binding,
intercept, help pane, on-screen legend, hint, comms line, skill-catalog entry,
the guidance⇄hotkey drift-guard test, and the behavioral tests:

- **De-spin laser** (a *hold* key): `H` → `L`
- **Info** — the Codex / Tech-Library viewer (a *press toggle*): `L` → `I`

After the swap, **`H` becomes unbound** (free, mirroring how `U` was freed when
the laser previously moved U → H).

## Architecture notes (verified by reading the code)

- **Hotkeys are hardcoded in `InputManager._handleKeyDown` + `processInput`.**
  There is no remap/keybinding layer — `SettingsManager.js` has no key bindings,
  so InputManager is the only binding site to change.
- The de-spin laser is a *held* key: keydown only emits a no-target affordance
  (`InputManager.js:790` `case 'KeyH'`); the continuous beam is driven each frame
  by `processInput()` reading `this.keys['KeyH']` (`InputManager.js:1686`). It is
  the only `this.keys[...]` poll for the laser.
- The Codex viewer is a *press toggle* on `L` (`InputManager.js:1302`
  `case 'KeyL'`) plus a "toggle-to-close while open" intercept
  (`InputManager.js:437`). `CodexViewerUI` owns only an `Esc` capture-phase
  listener (`:475`); no separate document-level key listener and no "press L"
  footer — so InputManager is the single toggle site.
- `I` is currently **not** a live gameplay hotkey (no `case 'KeyI'` in the
  switch; inspection was folded into the `V` cycle). The only `KeyI` remnants are
  harmless: the anti-ASR guard `InputManager.js:387` (gated by
  `Constants.INPUT.SUPPRESS_BARE_I`, default **false** — `Constants.js:20`), an
  orphan helper `toggleInspection()` (`InputManager.js:2048`), and the
  OnboardingDirector smart-default branch `case 'KeyI'` (`:418`). No onboarding
  beat declares `keys:['I']`/`['H']`/`['L']`, so the badge-rendering HintTicker
  path is unaffected and `I` is safe to claim.
- **SkillsPane auto-renders the catalog `key`** as a `[..]` badge
  (`SkillsPane.js:1170/1185/1192/1293/1441`), so changing `manage_codex.key`
  flows through automatically; only the two hardcoded `"L. Tech Library"` hint
  strings (`:825/:1119`) need manual edits.
- **A drift-guard test already exists** (`test-GuidanceHotkeyDrift.js`): it scans
  onboarding beats, teaching moments, `MISSION_COACH.BEATS_BY_MISSION`, idle
  hints, and the skills catalog for stale/forbidden key strings. It must be
  extended so it protects this remap instead of going stale.

## Decisions captured

- **"Info" only on key-facing labels** — the help-pane row, the SkillsPane terse
  key hint, and the coach phrase "Press I to open Info". **Keep the proper noun
  "Codex" / "Tech Library"** everywhere else: the viewer title/tabs, codex entry
  content, comms/teaching flavor prose, the HUD `[?]` tooltip, and the skill
  catalog `label`. In those places, only swap the embedded key letter L→I.
- **Docs scope = README.md + ARCHITECTURE.md only** (HANDOFF.md / GAME_DESIGN.md
  hotkey references left as historical notes).
- `H` left unbound (no re-use this task).
- Minor accepted inconsistency: the SkillsPane terse hint will read "I. Info"
  while the catalog skill name stays "Tech Library" (badge `[I]`). Flag at
  implementation if the reviewer prefers "I. Tech Library" instead.

## Changes by file

### 1. Binding logic — `js/systems/InputManager.js`
- `:437` codex-open intercept: toggle-to-close key `KeyL` → `KeyI`; update the
  `:435` comment ("except L (toggle)" → "except I (toggle)").
- `:790` `case 'KeyH'` → `case 'KeyL'` (laser keydown no-target affordance);
  rewrite the `:783-789` header comment ("H key … hold H, 'H = Hold'") to "L key
  — CP-2 de-spin laser (hold L)", noting the H→L move + date.
- `:1302` `case 'KeyL'` → `case 'KeyI'` (Codex toggle); update the
  `// --- F17: Toggle Codex Library (L key) ---` comment to "(I key)".
- `:1686` held-key poll `this.keys['KeyH']` → `this.keys['KeyL']`.
- Update narrative comments `:1665-1672` (laser hold-H) and `:1645-1646`
  (`_getPilotedSkDespinTarget`, "KeyH no-target affordance") to reference L.
- `:382-388` SUPPRESS_BARE_I guard comment: the "bare I = Inspection" note is
  stale — replace with "bare I = Info/Codex toggle"; note enabling the guard
  would suppress the Info key.

### 2. Help pane — `js/ui/HotkeyOverlay.js`
- `:66` `[['H'], 'Hold steady with laser']` → `[['L'], 'Hold steady with laser']`.
- `:79` `[['L'], 'Library']` → `[['I'], 'Info']`.

### 3. On-screen controls legend — `js/ui/hud/StatusPanel.js`
- `:525` `… Shift+R All &ensp;H De-spin` → `… Shift+R All &ensp;L De-spin`.

### 4. Skill catalog + tutorial/coach comms — `js/core/Constants.js`
- `:2220` `manage_codex`: `key: 'L'` → `key: 'I'`. **Keep** `label: 'Tech
  Library'` (proper-noun skill name; the `[I]` badge is the key-facing part).
- `:2698` MISSION_COACH beat text `de-spin (H)` → `de-spin (L)`.
- `:2729` `… logged to the Tech Library. Press L to open the Codex.` →
  `… logged to the Tech Library. Press I to open Info.`
- `:2733` `Press L to open the Tech Library and read up…` →
  `Press I to open Info and read up…` (title `THE CODEX` at `:2732` unchanged).
- `:703` `LASER_DESPIN` flag comment `(hold H)` → `(hold L)` (comment only).

### 5. Reticle / odds advisories
- `js/ui/DockingReticle.js:1265` `'de-spin to freeze aspect [H]'` → `[L]`.
- `js/ui/DockingReticle.js:1285` `… de-spin [H]` → `… de-spin [L]`.
- `js/systems/ToolOdds.js:201` `… de-spin [H]` → `… de-spin [L]`.

### 6. Comms / guidance / teaching / UI strings
- `js/systems/GameFlowManager.js:1146` `Codex [L] updated.` → `Codex [I] updated.`
  (proper noun kept; key letter only).
- `js/ui/StrategicMap.js:935` `de-spin (hold H)` → `de-spin (hold L)`.
- `js/systems/TeachingSystem.js:48` `Open the Codex (L)` → `Open the Codex (I)`
  (proper noun kept).
- `js/systems/TeachingSystem.js:172` `Hold H to fire the de-spin laser` →
  `Hold L to fire the de-spin laser`.
- `js/systems/TeachingSystem.js:363` comment `(hold H)` → `(hold L)`.
- `js/entities/CaptureNet.js:398` `de-spin the target (hold H)` → `(hold L)`.
- `js/entities/CaptureNet.js:97` comment `de-spin [H]` → `de-spin [L]`.
- `js/ui/hud/SkillsPane.js:825` `'L. Tech Library  ·  J to close'` →
  `'I. Info  ·  J to close'` (key-facing hint → Info).
- `js/ui/hud/SkillsPane.js:1119` `'L. Tech Library'` → `'I. Info'`.
- `js/ui/CodexViewerUI.js:3` header comment `Toggle with L key ("Library")` →
  `Toggle with I key ("Library")`.
- `js/systems/DespinLaser.js:4` stale comment `default key: U` → `default key: L`.
- `js/systems/DespinLaser.js:60` comment `de-spin [H]` → `de-spin [L]`.
- `js/ui/HUD.js:1469` — **no change**: keep tooltip `title="Open Tech Library"`
  (proper noun, no key letter).

(No key letter to change in `OnboardingDirector.js:192` or
`SubsystemEvents.js:319` — they describe de-spin without naming a key.)

### 7. Drift-guard test — `js/test/test-GuidanceHotkeyDrift.js`
- Add FORBIDDEN rules so the remap is enforced against future guidance drift:
  - `/\bhold h\b/i` → "de-spin laser moved to L (H freed)"
  - `/de-spin \(h\)/i` → "de-spin laser is L, not H"
  - `/\bpress l\b/i` → "Info/Codex moved to I (L is the de-spin laser)"
- Extend the skills-catalog glyph assertion (`:88`) with `manage_codex: 'I'` to
  lock the new binding.
- (Confirm the new rules don't trip on the already-fixed strings — they won't,
  since the fixed copy uses L / I.)

### 8. Behavioral test — `js/test/test-InputManager-Hotkeys.js`
- Header comment `:10-12`: rewrite the "H = Hold" narrative → laser on `L`; note
  `H` is freed (and `U` remains freed).
- `:134-141` "H no longer recalls … de-spin laser" → send `KeyL`; assert
  laser-on-L emits no `ARM_RECALL_ALL`; rename.
- `:143-154` "H with no target emits de-spin warning" → send `KeyL`; rename.
- `:156-…` "U is now inert" → keep; fix the note "(now on H)" → "(now on L)";
  optionally add a test that bare `H` is now inert.
- `:741-744` "L toggles the codex Library" → send `KeyI`; rename to "I toggles
  the codex"; optionally assert `KeyL` no longer toggles the codex.
- `:776-781` "H is the de-spin 'Hold steady' laser" → send `KeyL`; rename.

### 9. Cosmetic test fixtures (consistency only)
- `js/test/test-DockingReticle-ToolPanel.js:41` fixture hint `… de-spin [H]` →
  `[L]` (input fixture, not an `[H]` assertion).
- `js/test/test-CaptureNet.js:2160` assertion *comment* `de-spin (H)` → `(L)`
  (the assert checks `includes('de-spin')`; no behavioral change).

### 10. Docs — `README.md` + `ARCHITECTURE.md` only
- `README.md`: controls summary `:18` (`H` hold de-spin laser → `L`; `L` codex →
  `I`), "The Codex is `L`" `:167` → "The Codex is `I`", full-table rows `:180`
  (H laser → L), `:190` (H SK laser → L), `:199` (`L · Codex / Library` → `I`).
- `ARCHITECTURE.md` §6 hotkey map: `:186` (H → L), `:194` (L → I); add a
  migration-log line near `:368-369` recording "de-spin laser `H`→`L`;
  Codex/Info `L`→`I`"; refresh the verified-date note `:5` if appropriate.
- HANDOFF.md / GAME_DESIGN.md hotkey references **left as-is** (historical).

## Validation
- Run the full Node test suite (`test.sh` / `js/test/run-tests.js`) — expect
  `test-InputManager-Hotkeys`, `test-GuidanceHotkeyDrift`, reticle/odds and
  capture-net suites green.
- Manual smoke: **hold L** → laser fires on a tumbling target; warns when no
  target selected. **Press I** → Info/Codex opens; **I again / Esc** closes; only
  `I`+`Esc` pass through while it's open. `?` overlay shows `L` = laser, `I` =
  Info. Daughters legend shows `L De-spin`. SkillsPane hint reads `I. Info`.
  Bare `H` does nothing.

## Out of scope (unless requested)
- Repointing the freed `H` key to a new action.
- Removing the orphan `toggleInspection` helper + OnboardingDirector `KeyI`
  smart-default branch (recommend a separate cleanup).
