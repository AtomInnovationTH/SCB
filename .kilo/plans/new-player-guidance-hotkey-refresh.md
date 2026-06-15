# New-Player Guidance Refresh — post-2026-06-14 hotkey revamp

## Goal

Audit and fix the **new-player guidance content** so it matches the current
(post 2026-06-14 "spinning plates" hotkey revamp) controls. Three buckets, as
the user framed them:

- **Update with new hotkeys** — text/glyphs that name a key that moved or was
  freed.
- **Obsolete** — guidance for an interaction model that no longer exists
  (two-key struts, `P`-to-pilot, `7`-to-return, radial menu).
- **Improvement** — guidance that still *works* but teaches a non-canonical key
  (e.g. `Tab` when the help menu now teaches `T`).

Terminology softening (net/lasso/arm wording) is **out of scope** — it is owned
by `.kilo/plans/reduce-violent-terminology.md` and that plan explicitly leaves
`net`/`lasso` as-is.

## Canonical hotkey map (source of truth)

The live bindings are owned by `js/systems/InputManager.js` and mirrored in the
hand-tuned `js/ui/HotkeyOverlay.js` (the `?` help pane). Verified this audit:

| Key | Action | Notes |
|---|---|---|
| Arrows | Rotate mother / orbit around debris in pilot | |
| `V` | Cycle camera view | |
| `S` / `Shift+S` | Quick scan / Wide scan | **`W` is freed** (was wide scan) |
| `T` | Target debris (cycle) | `Tab` still works as an undocumented alias |
| `A` / `Shift+A` | Autopilot to target / to centre + launch all | |
| `N` / `Shift+N` | Net / capture (mother lasso **and** daughter capture) / auto-target+launch | **single fire verb** (`F`/`Space` no longer fire) |
| `D` / `Shift+D` | Launch selected daughter / launch all | |
| `R` / `Shift+R` | Reel-in / recall all | |
| `1`–`4` | Select / pilot daughter | **replaces `P` / `Shift+P`** (removed) |
| `H` | Hold steady / de-spin laser (hold) | was `U` |
| `E` | Electro-Dynamic Tether | |
| `X` | Tether detach | |
| `B` `F` `J` `L` `M` | Buy / Forge / Journal / Library / Map | **Forge is `F`** (was `5`/`F4`); **Map is `M`** (backtick is an undocumented alias) |
| `5`–`0` | City names / Constellations / Comms / NavSphere / Debris pane / Target pane | toggles |
| `.` | Struts toggle (one key) | **`,` freed** (only drives Debris-Map "prev" while map open) |
| `Shift+G` | Trawl sweep | unchanged |
| `Shift+1/2/3` | Power bus select | bare `1-3` now select daughters |
| `+` / `-` | Throttle | |

Return-to-mother (leave the daughter working): **re-press the active daughter's
digit, or `Esc`, or `V`** — the old `7` return binding was removed (`7` now
toggles the Comms pane).

---

## Findings & fixes

Ordered by player-impact (chapter-1 onboarding first).

### 1. `js/systems/OnboardingDirector.js` — chapter-1 beats (highest priority)

- **`struts` beat (lines 67–78) — OBSOLETE.** Teaches the retired two-key model
  ("Stow them with comma, deploy with period", `glyph: ', .'`,
  `keys: ['Comma','Period']`, escalation ", stows them, . deploys them"). `.`
  is now the single struts toggle and is the only key that emits
  `STRUT_DEPLOY_INPUT` (verified `InputManager.js:1011-1034`); `,` is freed.
  → Rewrite `commsText`/`text`/`escalationText` to a single `.` toggle;
  `keys: ['Period']`, `glyph: '.'`.
- **`scan` beat escalation (line 157) — STALE KEY.** "S fires a Quick Scan; W is
  a wider, slower scan" → wide scan is now **`Shift+S`**.
- **`target` beat (lines 160–175) — IMPROVEMENT + STALE KEY.** Teaches `Tab`;
  the help pane now teaches **`T`** (canonical; `Tab` still aliases). Also
  `noContactNudge` (line 174) says "try a Wide scan (W)" → `Shift+S`.
  → `commsText` "press T to cycle…", `glyph: 'T'`, `keys: ['KeyT']` (optionally
  `['KeyT','Tab']`), fix the nudge.
  → **Coupling:** `pressActiveHint()` (lines 395–421) maps the beat's primary
  key for the Space smart-default; it has a `Tab` case but no `KeyT` case. Add a
  `case 'KeyT'` that calls `im.cycleTarget()` so Space-as-smart-default still
  works for this beat.

`daughter` beat (1-4 + R), `lasso` beat (N), `autopilot` (A), and the narrative
beats are already correct — no change.

### 2. `js/core/Constants.js` — `SKILLS.CATALOG` key glyphs (lines ~2190–2242)

These `key` fields render in the Skills discovery pane and in
`OnboardingDirector._onSkillReminded` reminder chips, so they are player-facing.

| Skill (line) | Current `key` | Fix |
|---|---|---|
| `arm_struts` (2199) | `', .'` | `'.'` |
| `scan_wide` (2202) | `'W'` | `'Shift+S'` |
| `nav_target` (2203) | `'Tab'` | `'T'` |
| `arm_pilot` (2218) | `'P'` | `'1-4'` |
| `strategic_map` (2223) | `` '`' `` | `'M'` |
| `manage_power` (2214) | `'1/2/3'` | `'Shift+1/2/3'` |
| `manage_forge` (2242) | `'5'` | `'F'` |

`collect_trawl` (`Shift+G`), `manage_comms` (`C`), `manage_codex` (`L`),
`collect_lasso` (`N`), `radial_menu` (`Shift+R`) are already correct.

**Verify (secondary):** `nav_orbit_mfd` (2239) `key: 'M'` / `ORBIT_MFD_TOGGLE` —
`M` is now the Debris Map. Confirm what (if anything) toggles the Orbit MFD and
correct the glyph, or set to `null` if it has no bound key.

### 3. `js/core/Constants.js` — `MISSION_COACH.BEATS_BY_MISSION`

- **`ch2_manual_capture.body` (line 2690) — STALE KEY.** "press F to net it for
  2× score" → **`press N`** (the `text` on line 2685 already correctly uses
  `N`/`H`).
- **`ch3_wide_scan` (lines 2706, 2710) — STALE KEY.** "Press W for a
  wide-aperture deep scan" / "Press W to run a wide-aperture scan" → **`Shift+S`**
  (keep the "(S)" quick-ping reference).
- **`ch4_map` (lines 2736, 2740) — IMPROVEMENT.** "Open the debris map (`)" →
  "(M)" (backtick still aliases; `,`/`.` cluster-select stays valid while the
  map is open).
- **`ch6_forge` (lines 2778, 2782) — STALE KEY.** "Open the Forge ([5])" /
  "Press 5 to open the Forge" → **`F`**.

`ch7_trawl` (`Shift+G`), `ch9_radial` (1/2/Shift+R), `ch5_burn` (`+/-`),
`ch11_hohmann` are already correct.

### 4. `js/core/Constants.js` — `ARM_IDLE_HINTS` (lines ~3088–3103)

- **`arm_pilot_return` hint (line 3103) — OBSOLETE.** "Press 7 to return to the
  mothership (or Esc to hand back control)." `7` now toggles the Comms pane.
  → Rewrite to the current return path: **re-press the daughter's number (1-4),
  `Esc`, or `V` to back out to Command view.** Also confirm the hint's
  associated `key`/trigger metadata doesn't still reference `7`.

The `sk_idle_fire_or_pilot` (N / 1-4) and `sk_out_of_nets` (R / B) hints are
correct.

### 5. `js/systems/TeachingSystem.js` — `TEACHING_MOMENTS`

- **`first_scan` (line 140) — STALE KEY.** "Press W for a Wide Scan" →
  **`Shift+S`**.

`first_high_tumble_target` ("Hold H", line 172), `first_arm_deploy` ("1-4",
line 147), and `first_target` ("A … D", line 34) are correct.

### 6. `js/ui/hud/StatusPanel.js` — Forge hint (STALE KEY)

- Line 404: `<span>[5] Forge:</span>` → `[F] Forge:`.
- Line 1739: `'▸ Press [5] to process cargo'` → `'▸ Press [F] to process cargo'`.
- Line 1733 comment ("the live Forge/Kiln binding is 5") is stale → note `F`.

### 7. `js/systems/GameFlowManager.js`

- **Line 1424 — OBSOLETE.** "Daughter deployed — WASD to steer, press its number
  again to back out to Command view" — WASD daughter thrust was removed.
  → "Daughter deployed — **arrow keys** to steer; press its number again (or
  `V`) to back out to Command view." (Mirror `InputManager.js:1473`.)
- **Line 1195 — IMPROVEMENT.** "Got it! Press Tab for next target." → "Press T
  for next target" (`Tab` still works; `T` is canonical).

Lines 1108 (S), 1127/1180 (A), 1155 (N / D) are correct.

### 8. `js/entities/ArmUnit.js`

- **Line 4219 — STALE KEY.** "Netting failed — holding standoff. Press F to
  retry." → **`Press N to retry.`** (N is the single capture verb in SK).

Lines 940 (A), 4010 (1-4), 4127 (R) are correct.

---

## Tests & validation

- Update string/key assertions where they exist and run the full suite
  (`./test.sh`; baseline 711 suites / 2880 tests / 0 fail):
  - `js/test/test-OnboardingDirector.js` — struts/target beat shape (`keys`,
    `glyph`), `pressActiveHint` `KeyT` case.
  - `js/test/test-SkillsSystem.js` — any catalog `key` assertions.
  - `js/test/test-MissionCoach.js` — beat text/`triggerEvent` integrity (the
    Phase C integrity guard checks `triggerEvent`/`skillId`, not copy, but
    confirm no test pins the old key strings).
  - `js/test/test-TeachingSystem.js` — moment body assertions.
  - `js/test/test-InputManager-Hotkeys.js` — already encodes the revamp; should
    stay green (no binding changes here, only guidance copy).
- Consider a lightweight **drift guard**: a test that scans guidance strings
  (onboarding beats, teaching moments, mission-coach beats, arm-idle hints) for
  references to freed keys (`W`, `P`, `Shift+P`, `F4`, `[5]`/`press 5` for
  forge, `press 7`/`Tab`-for-target, `WASD`) so future hotkey moves are caught.
  Optional but cheap and directly prevents this class of regression.
- Manual browser pass: run a fresh onboarding (clear
  `spacecowboy_onboarding_v1`) and walk boot→struts(`.`)→scan→target(`T`)→
  autopilot→capture; trip the chapter coach beats (2/3/4/6); open the skills
  pane and confirm the corrected key glyphs; deploy a daughter and confirm the
  "back out to Command" hint reads arrow keys.

## Out of scope / leave as-is

- Net/lasso/arm **terminology** — owned by `reduce-violent-terminology.md`.
- The undocumented power-user aliases (`Tab` for target, backtick for the Debris
  Map, backtick to cycle the SK tool, bare `I` for inspection) — intentionally
  not advertised; leave functional, don't add to the help pane.
- `DockingReticle._drawNetStatus` — already state-aware and correct
  (`[N]`/`[\`]`/`[R]`/`[Esc]`), no change.

## Files touched (summary)

- `js/systems/OnboardingDirector.js` (struts, scan, target beats + `pressActiveHint`)
- `js/core/Constants.js` (`SKILLS.CATALOG` keys, `MISSION_COACH` beats, `ARM_IDLE_HINTS`)
- `js/systems/TeachingSystem.js` (`first_scan`)
- `js/ui/hud/StatusPanel.js` (Forge hint)
- `js/systems/GameFlowManager.js` (daughter-deploy + next-target hints)
- `js/entities/ArmUnit.js` (net retry hint)
- `js/test/*` (assertions + optional drift guard)
</content>
</invoke>
