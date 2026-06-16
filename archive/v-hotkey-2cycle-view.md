# Plan — Improve the "V" view hotkey (2-cycle + friendlier labels + anti-stuck guidance)

## Goal

Make the **V** camera hotkey easier to understand and harder to get lost in:

1. **2-cycle instead of 3** — `V` toggles just two views: a default flying view and a wide
   look-around view. Close inspection stays reachable by zooming in while looking around (it
   already works that way), so nothing is lost.
2. **Friendlier labels** — replace `COMMAND` / `OVERVIEW` with **`FLY`** / **`LOOK AROUND`**.
3. **Anti-stuck guidance** — while in any non-default view, keep a small **persistent** badge
   with a return hint (`🔭 LOOK AROUND · [V] to fly`) instead of the current label that fades
   after 2.5 s. The badge fades normally only in the default `FLY` view.

### Decisions (confirmed with user)
- 2-cycle = **`FLY` (chase) ↔ `LOOK AROUND` (orbit)**. Close inspection remains a zoom
  sub-state of `LOOK AROUND` (Schmitt-trigger on distance), not a discrete cycle stop.
- Labels: **`🛰 FLY`** and **`🔭 LOOK AROUND`**.
- Anti-stuck: **persistent badge + `[V] to fly` hint** whenever off the default view.

## Background / current state

- `V` is handled in `js/systems/InputManager.js:619` (`case 'KeyV'`), which calls
  `cameraSystem.cycleView(lockedId)`. `Shift+V` is a separate binding (strategic map) and is
  not touched.
- The cycle is defined by `VIEW_CYCLE` in `js/systems/CameraSystem.js:51`:
  `CHASE (COMMAND) → ORBIT (OVERVIEW) → INSPECTION → back`.
- `cycleView()` (`CameraSystem.js:370`) routes the 3rd step through `enterInspection()`.
- `LOOK AROUND` (ORBIT) **already** auto-enters an inspection sub-state when the player zooms
  in (`_evaluateInspectZoom` / `_setInspectZoom`, `CameraSystem.js:903`/`921`), emitting the
  same `INSPECTION_TOGGLE` / `MOTHER_INSPECTION_ENGAGED` events and overlays — so the discrete
  `INSPECTION` cycle stop is redundant.
- The on-screen label is shown by `_showViewIndicator()` (`CameraSystem.js:2488`) for only
  **2.5 s** (`_viewIndicatorTimer`), then `update()` fades it (`CameraSystem.js:671`). This is
  the main reason a player can sit in a non-flying view "unknowingly."
- Arrow keys always rotate the **ship** even in LOOK AROUND (`InputManager.js:1866`), while the
  mouse orbits the **camera** — so a faded indicator + detached camera is the core "stuck on the
  wrong mode" trap the persistent badge fixes.
- **The onboarding already teaches the 2-view model** ("Press V to switch view. Command flies
  the ship; Overview pulls back. V again returns to Command.", `OnboardingDirector.js:82`). The
  3rd `INSPECTION` step (added 2026-06-13b, `CameraSystem.js:35`) drifted away from that copy —
  so a player who follows the tutorial and presses `V` twice lands in `INSPECTION` instead of
  back in flight. This change re-aligns code with the existing guidance.

## Scope of edits

### 1. `js/systems/CameraSystem.js` — core behavior + labels + badge

- **`VIEW_CYCLE` (≈line 51):** drop `INSPECTION`. New value:
  `[CameraViews.CHASE, CameraViews.ORBIT]`. Update the surrounding doc comment to describe the
  2-cycle and that inspection is a zoom sub-state of LOOK AROUND (mirroring the pre-2026-06-13b
  comment that still lives at `InputManager.js:2070`).
- **`VIEW_LABELS` (≈line 58):**
  - `[CameraViews.CHASE]: '🛰 FLY'`
  - `[CameraViews.ORBIT]: '🔭 LOOK AROUND'`
  - Leave `FIRST_PERSON`, `TARGET_LOCK`, `ARM_PILOT`, `INSPECTION` (`🔍 INSPECTION`),
    `NET_CINEMATIC` unchanged — `INSPECTION` label is still used by the zoom callout and the
    legacy `I`-key path.
- **`cycleView()` (≈line 370):**
  - Keep the guard `if (cur === CameraViews.INSPECTION) { this.exitInspection(CameraViews.CHASE); return; }`
    — still correct so that if the player reached the discrete `INSPECTION` view via the legacy
    `I`/`toggleInspection()` path, `V` returns them to FLY.
  - Remove the now-unreachable `if (next === CameraViews.INSPECTION) { enterInspection(...) }`
    branch (since `INSPECTION` is no longer in `VIEW_CYCLE`).
  - Update the doc comment to: `FLY → LOOK AROUND → FLY`.
- **Persistent badge — `_showViewIndicator(view)` (≈line 2488):**
  - Treat `CameraViews.CHASE` as the default view.
  - Default (`FLY`): `text = "${VIEW_LABELS[view]}  [V]"`, opacity 1, `_viewIndicatorTimer = 2.5`,
    `_viewIndicatorPersistent = false` (auto-fades, unchanged feel).
  - Off-default (`LOOK AROUND`, and the legacy `INSPECTION`): `text = "${VIEW_LABELS[view]} · [V] to fly"`,
    opacity 1, `_viewIndicatorPersistent = true`, `_viewIndicatorTimer = 0` (no countdown).
  - Keep the existing `ARM_PILOT` `[1-4]` hint branch for safety even though `_showViewIndicator`
    is skipped for ARM_PILOT transitions.
- **New field:** add `this._viewIndicatorPersistent = false;` next to `_viewIndicatorTimer`
  (≈line 305).
- **`update()` fade (≈line 671):** only run the countdown/fade when
  `!this._viewIndicatorPersistent`. (Returning to FLY calls `_showViewIndicator(CHASE)`, which
  clears the persistent flag and starts the 2.5 s fade again.)
- **Comment cleanup:** update the file header (`CameraSystem.js:3`) and the `enterInspection`
  /`setView` comments that describe "INSPECTION is the third cycle step" so docs match the
  2-cycle reality.
- The zoom-engage callout `'🔍 INSPECTION. Overlays active'` (`CameraSystem.js:950`) stays —
  it's a distinct sub-state notification and remains accurate.

### 2. `js/systems/InputManager.js` — comment alignment only (no behavior change)

- Update the `case 'KeyV'` comment block (≈line 615) to describe the 2-cycle
  (`FLY ↔ LOOK AROUND`). The `cycleView()` smart-default helper comment (`InputManager.js:2070`)
  already states the 2-cycle intent — leave as-is (now finally true).
- ESC-from-INSPECTION handling (`InputManager.js:579`) stays — still valid for the legacy
  `I`-key inspection view.

### 3. `js/systems/OnboardingDirector.js` — copy consistency

Update the player-facing strings so the tutorial says "Fly / Look around" to match the new
on-screen labels (the structure already assumes 2 views):
- `view` beat (≈lines 82–98): e.g. `commsText` → "Press V to switch view. **Fly** to pilot the
  ship; **Look Around** to pull back. V again returns to Fly."; `commsAck` → "Copy. V toggles
  Fly and Look Around."; `escalationText` similarly.
- `look` beat (≈lines 102–115): "In **Look Around**, click and drag to study the spacecraft." /
  "Hold the left mouse button and drag in **Look Around** to orbit the camera."
- `inspect` beat (≈line 146): "In **Look Around**, keep scrolling in toward the mothership…".

### 4. `js/ui/HotkeyOverlay.js` — minor clarity (optional)

- The `[['V'], 'View']` rows (lines 36, 57) can be enriched to `'View — fly / look around'` for
  the Mother card. Low priority; keep the `Shift+V` "View big picture" row unchanged.

## Tests

- **`js/test/test-InputManager-Hotkeys.js`** — existing `V cycles the camera view` test
  (line 728) still passes (mock counts one `cycleView` call; `currentView: 'COMMAND'` mock is
  irrelevant to the assertion).
- **`js/test/test-GuidanceHotkeyDrift.js`** — unaffected (it guards freed/moved *keys*, not
  view labels).
- **Add a focused CameraSystem test** (new `js/test/test-CameraView.js`, registered in
  `js/test/run-tests.js`) asserting:
  - `VIEW_CYCLE` has length 2 and `V` toggles `CHASE ↔ ORBIT` (call `cycleView()` twice, check
    `currentView`).
  - `getViewLabel()` returns `🛰 FLY` / `🔭 LOOK AROUND`.
  - From `INSPECTION`, `cycleView()` returns to `CHASE` (regression guard for the legacy path).
  - Optional: `_showViewIndicator` sets `_viewIndicatorPersistent = true` for `ORBIT` and
    `false` for `CHASE`.
  (Headless DOM: guard `_showViewIndicator` test on `_viewIndicator` existence or stub it, since
  the indicator element is only created when `#hud-overlay` exists.)
- Run the suite via the project's existing runner (`./test.sh` / `node js/test/run-tests.js`).

## Out of scope / non-goals

- No change to `Shift+V` (strategic map) or the mouse-wheel zoom-to-inspect behavior.
- No change to arrow-key ship rotation semantics.
- The legacy bare-`I` / `toggleInspection()` discrete inspection path is preserved (not part of
  the V cycle).

## Risks / watch-outs

- Ensure leaving `LOOK AROUND` still clears the zoom-inspection sub-state (`_clearInspectZoom`
  in `setView`, `CameraSystem.js:405`) so optics/overlays don't leak into `FLY` — unchanged, but
  verify after the cycle edit.
- Persistent badge must reset to the fading behavior when returning to `FLY` (covered by clearing
  `_viewIndicatorPersistent` in `_showViewIndicator(CHASE)`).
- Keep the `INSPECTION` enum + its compute/transition code intact — only its membership in
  `VIEW_CYCLE` is removed.

## Acceptance criteria

- Pressing `V` toggles exactly two views; the badge reads `🛰 FLY` and `🔭 LOOK AROUND`.
- In `LOOK AROUND`, the badge stays on screen with `· [V] to fly`; in `FLY` it fades after ~2.5 s.
- Zooming in while in `LOOK AROUND` still engages the hull/debris callouts (inspection sub-state).
- Onboarding copy names "Fly" and "Look Around" consistently with the badge.
- Existing tests pass; new CameraView test passes.
