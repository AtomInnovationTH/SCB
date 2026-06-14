# Help "?" Overlay — Reorganize into Mother / Daughter / Advanced+Maps

## Goal

Rework the `?` keyboard-shortcut overlay (`js/ui/HotkeyOverlay.js`) from its current
topic-based cards (**Essentials / Views & Maps / Advanced**) into three **mode-based**
cards that mirror how the player actually thinks about the game:

1. **🛰 MOTHER** — what the keys do while commanding the mothership (Normal / Orbital).
2. **🤖 DAUGHTER** — what the keys do while piloting a deployed arm (ARM_PILOT / STATION_KEEP).
3. **🗺 ADVANCED + MAPS** — the cross-mode controls (maps, overlays, panes, ship systems, deep tools) that behave the same in both modes.

This is data-only work in one file plus a comment/header refresh; no game logic changes.

## Why mode-based (the synergy)

`ARCHITECTURE.md §6` is the verified source of truth and already presents the hotkey map
as a **two-column table: "Normal / Orbital" vs "ARM_PILOT"**. The same physical key means
different things depending on which "chair" the player is in:

| Key | Mother (command chair) | Daughter (ARM_PILOT) |
|---|---|---|
| `↑↓←→` | Rotate ship (tether-aware spring) | Orbit the debris (θ/φ, STATION_KEEP) |
| `N` | Fire lasso / net | Capture / deploy net |
| `A` | Autopilot toggle | (held) lateral thrust |
| `R` | Recall nearest daughter / abort AP | Reel in from station-keep |
| `+ / −` | Throttle ±10% | Approach / retreat standoff |
| `V` | Cycle camera view | Exit pilot → mothership |
| `H` | De-spin laser on selected target | De-spin the piloted arm's SK target |

`D` (deploy daughter) is a **Mother** command issued from the command chair — it belongs in
the Mother card, NOT the Daughter card. The third card collapses the "same in both modes" keys
(maps, codex, journal, comms, forge, fuel, struts, shop, pause) so the two mode cards stay short.

> Note: this is the *conceptual* rationale. Because the user chose a **pure regroup** (see next
> section), shared keys are not duplicated into both cards (that would need daughter-specific
> relabels). Each existing row is placed once, keeping its current label.

## Scope: pure regroup (no label changes)

**DECISION (user): pure regroup only.** Do NOT change any labels or add/remove keys to make
them accurate. Each existing row keeps its current text verbatim; we only redistribute the
existing rows across the three new cards. The accuracy gaps below are documented for awareness
and a possible future pass — they are explicitly OUT of scope for this change.

The current overlay has stale/incorrect rows (verified against `InputManager._handleKeyDown`
and ARCHITECTURE §6) that we are intentionally leaving as-is this pass:

| Current overlay row | Reality (not fixed now) |
|---|---|
| `T` → "Target debris" | `T` actually = cycle capture tool; target-cycle is `Tab` |
| `Shift+S` → "Scan wide" | wide scan is `W`; `S` has no Shift branch |
| `Shift+N` → "launch all nets" | phantom — no handler (Shift+N freed) |
| `Shift+A` → "center + launch all" | really = engage selected Debris-Map cluster AP |
| `7 8 9 0` → "toggle displays" | `7` = return-to-mother; `8/9/0` have no handlers |
| `,` `/` `.` → "stow/deploy struts" | `/` is the Help key; struts are only `,` and `.` |

**Items the user named that are NOT in the current overlay** (so pure-regroup cannot place
them — they would be additions, deferred): `EDT` (`Y`), deorbit (`Ctrl+Shift+D`), power bus
(`[ ]` / `Shift+1-3`). Flagging so the user knows the Daughter card's "EDT" request and the
Advanced+Maps "deorbit / power-bus" requests won't appear unless added in a later pass.

## Proposed new `HOTKEY_GROUPS` (pure regroup of EXISTING rows)

Single placement: each existing row appears in exactly one card, keeping its current label.
Shared keys (`↑↓←→`, `T`, `A`, `N`) are also used in daughter mode, but echoing them into the
Daughter card would require daughter-specific relabels (= the accuracy work that's out of
scope), so they stay once, in Mother, with their existing labels.

### 🛰 MOTHER — Command chair
Existing rows that are mother command-chair verbs (incl. fleet commands — `D` deploy and `R`
recall are commands issued from the mother, per the user's note):
- `↑ ↓ ← →` — Rotate
- `V` — View
- `T` — Target debris
- `A` — Autopilot to target
- `N` — Net launch
- `S` — Scan
- `R` — Reel-in
- `D` — Daughter launch
- `F` — Focus action (deploy tool)
- *(spacer)*
- `Shift`+`A` — Autopilot to target-rich center + launch all
- `Shift`+`N` — Auto-target + launch all nets in range
- `Shift`+`S` — Scan wide
- `Shift`+`D` — Daughters launch all
- `Shift`+`R` — Reel-in all

### 🤖 DAUGHTER — Working a deployed arm
Existing rows for selecting/operating a daughter (magnet placed here per user):
- `1`–`4` — Select daughter
- `T` — Target debris attachment areas
- `M` — Magnet
- `H` — Hold debris steady — de-tumble laser pulse
- `X` — Tether detach

### 🗺 ADVANCED + MAPS
Maps & overlays (the whole current "Views & Maps" card + Shift combos):
- `?` — Help
- `J` — Journal / skills
- `L` — Library
- `O` — Toggle NavSphere
- `` ` `` — Debris map (pick clusters)
- `Shift`+`V` — Strategic overview
- *(spacer — ship systems)*
- `5` — Forge
- `6` — Thruster fuel cycle
- `G` — Trawl sweep
- `7` — toggle: debris display
- `8` — toggle: target pane
- `9` — toggle: Orb display
- `0` — toggle: Propulsion display
- `B` — Buy upgrades
- `G` — Trawl sweep
- `Z` — Cycle analysis zones
- `Shift`+`C` — City labels on Earth
- `Esc` — Pause / back / exit mode
- `,` `.` — Stow / deploy struts

(All labels above are the EXISTING overlay text, kept verbatim — pure regroup.)

## Row accounting (every current row is placed exactly once)

- **Essentials (15)** → Mother gets all 15 (the everyday verbs + the five Shift fleet combos).
- **Views & Maps (5)** → Advanced+Maps (`?`, `J`, `L`, `O`, `` ` ``); `Shift+V` from Essentials
  joins them.
- **Advanced (19)** → split: Daughter gets `1–4`, `T` attachment, `M`, `H`, `X`; everything
  else (`5`, `6`, `7`, `8`, `9`, `0`, `B`, `G`, `Z`, `Shift+C`, `Esc`, `,/.`) → Advanced+Maps.
- `F` (Focus action, currently in Advanced) → Mother.

No rows are dropped, added, or relabeled.

## Implementation steps (all in `js/ui/HotkeyOverlay.js`)

1. **Rewrite the `HOTKEY_GROUPS` array** (lines 23–85) to the three groups above, copying each
   row's existing `[keys, label]` text verbatim — only the grouping changes.
   - Titles/icons: `🛰 Mother`, `🤖 Daughter`, `🗺 Advanced + Maps`.
   - Reuse the existing `'spacer'` divider mechanism between sub-clusters.
   - Preserve chip conventions exactly as-authored today (e.g. `[['1', '–', '4'], 'Select daughter']`,
     `[[',', '/', '.'], 'Stow / deploy struts']`) since labels/keys are unchanged.
2. **Update the header comment block** (lines 13–22) to describe the new mode-based grouping
   (Mother / Daughter / Advanced+Maps) and drop the stale "Essentials / Views & Maps / flatter
   three-card" notes. Keep the "Keep in sync with InputManager…" reminder line.
3. **Verify the body grid fits** (`_buildDOM`, line 162 `gridTemplateColumns`). The Daughter
   card is now short (5 rows) and Advanced+Maps is the tallest (~18 rows). Suggested column
   weights `1.1fr 0.85fr 1.15fr`. If Advanced+Maps overflows the fixed panel
   (`height: 86% / maxHeight: 840px`), prefer splitting its two clusters into a 2-column
   sub-grid inside the card rather than shrinking the font.
4. **No changes** to `show/hide/toggle`, listeners, `_makeGroupCard`, `_makeRow`,
   `_makeKeyCap`, or `_makeSpacer` — they are layout-agnostic.

## Verification

- No automated test covers `HotkeyOverlay` (DOM/visual). Verify manually: open the game, press
  `?`, confirm three cards (Mother / Daughter / Advanced+Maps) render, fit the panel without
  clipping, and that every original row is present exactly once.
- Run `npm test` as a smoke check for import/syntax regressions (HotkeyOverlay isn't imported
  by tests).

## Notes / deferred

- **Accuracy is intentionally NOT addressed** (user chose pure regroup). The stale rows
  (`T`=target, `Shift+S`, `Shift+N`, `7/8/9/0` toggles, `,/.` chip) carry over unchanged. A
  follow-up pass could reconcile the overlay with ARCHITECTURE §6.
- **EDT (`Y`), deorbit (`Ctrl+Shift+D`), power bus (`[ ]`)** are not current overlay rows, so
  they are not placed; adding them would be a separate enhancement.
- Shared keys (`↑↓←→`, `T`, `A`, `N`) live once in Mother; echoing them into Daughter with
  orbit/capture meanings is deferred (would require new labels = accuracy work).
