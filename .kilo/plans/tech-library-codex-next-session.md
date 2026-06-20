# Tech Library / Codex — Next-Session Handover

> **Read this first, then the two companion docs:**
> - [`tech-library-codex-overhaul.md`](./tech-library-codex-overhaul.md) — master plan (phases,
>   locked decisions §5a, content specs §3.x, new-user needs §11.8). Has a live STATUS banner at §6.
> - [`tech-library-codex-phase2-handover.md`](./tech-library-codex-phase2-handover.md) — Phase 2 spec
>   + **§13 post-Phase-2 progress log** (schema, 2b/2c, viewer work).
>
> This file = the actionable to-do for the next shift, with verified state and gotchas.

---

## 0. Verified state (checked at handover, 2026-06-20)

> **UPDATE 2026-06-20 (Phase 3 done):** Backlog committed (`e2f9cf3`). Phase 3
> viewer overhaul is **complete and green** (uncommitted, pending review):
> open-from-any-screen (dropped `isGameplay` gate at `InputManager.js`),
> detail redesign (realWorld callout + formula chip + clickable Related chips +
> Prev/Next), per-category hue theming (sidebar/cards/detail tinted from each
> category's `color`), Tracks tab (Learning Paths section), filter/sort bar
> (All/Unlocked/Locked × Default/A–Z/Readiness), overall progress bar in the
> header, and keyboard nav (roving arrow focus + Enter in the grid; ←/→ =
> Prev/Next + Backspace = back in detail; ESC closes or steps back). New
> `js/test/test-CodexViewer.js` covers the pure logic (`_hexToRgb`,
> `_applyFilterSort`, `_currentListEntries`). Suite: **3376 pass / 0 fail**,
> 830 suites. **Next: Option B — fill thin categories (§4).**

- **155 entries** in `data/codex.json`. **14 `startUnlocked`**. Tests: **3360 pass / 0 fail**
  (`node js/test/run-tests.js`, 826 suites).
- **Per-category counts:** PLAYBOOK 10, WORLD_INDUSTRY 4, DEBRIS 17, CATALOG 10, ORBITAL_MECHANICS 12,
  TETHERS 10, PROPULSION 17, SENSORS 8, POWER 15, ATTITUDE 3, AVIONICS 4, COMMS 9,
  SPACE_ENVIRONMENT 10, MATERIALS 10, HERITAGE 7, NEWS 9.
- **Category order (newbie-forward):** PLAYBOOK(0) WORLD_INDUSTRY(1) DEBRIS(2) CATALOG(3)
  ORBITAL_MECHANICS(4) TETHERS(5) PROPULSION(6) SENSORS(7) POWER(8) ATTITUDE(9) AVIONICS(10)
  COMMS(11) SPACE_ENVIRONMENT(12) MATERIALS(13) HERITAGE(14) NEWS(15). (Tests pin ascending order
  only, never absolute positions.)
- **Git:** last commit `4c3812a` (Phase 2). Everything since is **UNCOMMITTED**:
  modified `data/codex.json`, `CodexSystem.js`, `codexTriggers.js`, `CodexViewerUI.js`,
  `test-CodexData.js`, `test-CodexPersistence.js`, `test-TRL.js`, `scripts/phase2-content.mjs`,
  both plan docs; untracked `scripts/phase2b-newbie-content.mjs`, `scripts/phase2c-catalog-news.mjs`.
- **`data/codex.json.categories` is an OBJECT** keyed by category, each `{order, ...}` — NOT an
  array. (Trip-wire when scripting; iterate with `Object.entries`.)

---

## 1. How the system works (mental model)

- **Source of truth = `data/codex.json`** (entries + per-category meta + `aliases` + `tracks`).
  `js/systems/CodexSystem.js` is a data-driven engine; `_buildEntry` reads `trl` (optional) and
  `startUnlocked` (optional). `getEntryTRL` is null-guarded.
- **Never hand-edit the 1788-line JSON.** Content is applied by idempotent, order-independent
  patch scripts. After running any: validate `node -e "require('./data/codex.json')"` then run tests.
  - `scripts/phase2-content.mjs` — Phase 2 (PROPULSION + concepts).
  - `scripts/phase2b-newbie-content.mjs` — PLAYBOOK/WORLD onboarding + reorder.
  - `scripts/phase2c-catalog-news.mjs` — Catalog→10, News→9.
  - (`scripts/gen-codex-json.mjs` was deleted — do not resurrect.)
- **Triggers:** `js/systems/codex/codexTriggers.js` maps entryId → unlock condition. Shared
  `isroComms` helper. `startUnlocked` entries need **NO** trigger — the data integrity test
  "every entry has a callable trigger" **exempts `e.unlocked` entries**.
- **Tests read the live JSON** via fixture `js/test/_codexFixture.js`, so content edits auto-sync.
  When count changes, update the hard-coded expected count in `js/test/test-CodexData.js`.
- **Persistence** (`js/systems/PersistenceManager.js`): SAVE_VERSION stays 1 (additive codex slice).
  PERSISTENCE_GATHER guard preserves prior codex when `entries.length===0`; uses `peek()` not
  `load()`. Don't bump SAVE_VERSION for codex content.

---

## 2. Locked decisions (do not relitigate — see master §5a)

- **Reference content is start-unlocked.** PLAYBOOK + WORLD_INDUSTRY → `startUnlocked: true`,
  readable on first open. CATALOG/NEWS = locked discovery "trading cards".
- **TRL shown only when notable.** No Tech-Level badge on cards; detail row shows **only when
  `trl < 9`** (`Constants.TRL.FLIGHT_PROVEN_MIN`). Flight-proven is the silent default.
- **Voice (user-mandated):** introduce jargon gradually; spell out acronyms on **first use**
  (LEO, ADR, ASAT, GEO…); plain-language `shortText` hook before any term.
- **§4 register rule:** humor only in framing (`shortText`/PLAYBOOK voice), **never** in
  physics/numbers/`formula`/`trlRationale`.
- **Every fact must be web-verified** against authoritative sources (Wikipedia/ESA/NASA/SpaceNews/
  McDowell) before writing. Corrections get folded back into the entry.
- **New triggers** use non-comms `SCORE_UPDATE`/`debrisCleared` thresholds to avoid the
  comms-substring reachability coupling.

---

## 3. Verified game facts (for PLAYBOOK / accuracy)

- Win = **50 debris** (`WIN_DEBRIS_COUNT`) **OR** 10,000 kg to the elevator.
- Keys: **S** scan, **T** target, **A** autopilot, **`** (backtick) tool-cycle, **1–4** daughters,
  **Shift+1/2/3** power bus, **I** opens codex. 3 ETS buses (Thrust/Sensors/Arms).
- Economy: salvage → Forge → propellant refuels ΔV. Deorbit sacrifice ≈ **×2.5**;
  capture-quality stack ≈ **×3.7**.
- Only **3** real in-game NEWS *events* exist in `data/news-events.json` (ast_spacemobile_tumble,
  starlink_breakup, thaicom4_geo_derelict). The 9 NEWS *codex cards* are real-world discovery
  entries, NOT driven by in-game events — don't conflate them.

---

## 4. Recommended next work (priority order)

### Option A — Finish Phase 3 viewer overhaul (recommended; UX leverage is highest)
Partially done already in `js/ui/CodexViewerUI.js`: larger pane (94%/1400px/1000px), bigger fonts,
"All Entries" tab removed (opens on first category via `_firstCategoryKey()` line 237), TRL off
cards, detail TRL gated to `trl < FLIGHT_PROVEN_MIN` (line 438). Remaining, per master §3.6:
1. **Per-category hue theming** (each category meta could carry an accent; cards/sidebar tinted).
2. **Detail redesign** (`_showDetail`, line 414): `realWorld` callout block, `formula` chip,
   Related chip row (clickable cross-links), Prev/Next within category.
3. **Tracks tab** (data already has `tracks`).
4. **Filters / sort bar** (locked vs unlocked, by category, by TRL).
5. **In-pane progress** (per-category bars / overall ring).
6. **Keyboard nav** (roving tabindex; arrow keys through cards; Enter opens detail).
7. **Open-from-any-screen:** drop the `isGameplay` gate. **Verified location:**
   `js/systems/InputManager.js:1302` — `if (isGameplay && d.codexViewerUI)`. The
   codex-open intercept at lines 438–447 already handles I/ESC while open. Update
   `test-InputManager-Hotkeys.js:764` accordingly. Confirm `main.js` constructs the viewer outside
   gameplay-only paths (built at `main.js:619`, toggled via `codex:toggleUI` at `main.js:807`).

### Option B — Fill thin categories (content; lower-risk, additive)
Thinnest: **ATTITUDE (3), AVIONICS (4), WORLD_INDUSTRY (4)**, then HERITAGE (7), SENSORS (8).
Use a new `scripts/phase2d-*.mjs` (idempotent, order-independent). Each entry: verified facts,
acronyms-expanded, `realWorld` source line, bidirectional `related`, and either `startUnlocked`
(reference) or a reachable non-comms trigger (discovery). Bump expected count in test-CodexData.

### Option C — Inline glossary / tooltip layer (master §11.8)
Game-wide first-use term tooltips. Larger cross-cutting feature; only after A or with explicit ask.

### Then Phases 4–5 (not started)
P4: anchoring/badge/deep-links/comms integration. P5: SM-2 spaced-resurfacing + Outer-Wilds-style
`related` connection-map view.

---

## 5. Workflow checklist for any content/code change

1. For content: edit/extend a patch script, run it, then
   `node -e "require('./data/codex.json')"` to confirm valid JSON.
2. If entry count changed: update expected count in `js/test/test-CodexData.js` (and any
   Phase 2b/2c count blocks).
3. `node js/test/run-tests.js` → must stay green.
4. Watch the two test fixes already made for start-unlocked: `test-TRL.js` and
   `test-CodexPersistence.js` use `find(e => !e.unlocked)` instead of `entries[0]` — keep that
   pattern when touching them.
5. After non-trivial work, offer `/local-review-uncommitted`. **Commit only when explicitly asked.**

---

## 6. User-decided order for next shift (confirmed at handover)

Do these in sequence:

1. **Commit the uncommitted backlog FIRST.** Stage the Phase 2b/2c content + viewer changes (the
   modified/untracked files listed in §0) and commit so subsequent diffs stay reviewable, before
   writing any new code. Follow the repo's existing commit style (see `4c3812a`).
2. **Phase 3 viewer overhaul** (master §3.6) — per-category hue, detail redesign (realWorld block +
   formula chip + Related chips + Prev/Next), Tracks tab, filters/sort, in-pane progress, keyboard
   nav, and open-from-any-screen (drop the `isGameplay` gate at `InputManager.js:1302`).
3. **Fill thin categories** (Option B) — ATTITUDE(3), AVIONICS(4), WORLD_INDUSTRY(4), then
   HERITAGE(7), SENSORS(8) — via a new idempotent `scripts/phase2d-*.mjs`, verified facts, count
   bumped in tests.
4. **Inline glossary / tooltip layer** (master §11.8) — game-wide first-use term tooltips, last.

Commit between each major step (only when the step is complete and green); never bundle 2→3→4.
