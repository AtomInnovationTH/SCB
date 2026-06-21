# M1 First-Mission UX: pre-scan visibility + Tracked-Targets ranking

## Goal

Improve the Mission-1 first-contact experience by making the two guided net-catch
targets discoverable up front and by ranking the Tracked Targets list in the order
a new player actually works it (nearest first). This is a focused follow-up to
`.kilo/plans/m1-debris-1-2-visibility.md` (which fixed the #1/#2 mesh visibility,
selection, capture-reel, and reticle tracking).

## Locked product decisions (from planning session)

- **D1 — Pre-scan visibility = 2.** Pre-discover BOTH pinned net-catch pieces
  (#1 ~22 m dead-centre, #2 ~48 m off-side). The remaining #3–#7 stay hidden until
  the player presses **S** to scan. Rationale: both pinned pieces are guaranteed,
  in-range, guided catches; it's confusing for #2 to be a visible mesh + reticle
  bracket yet absent from the list. Scan still teaches "find more".
- **D2 — Ranking = near→far on Mission 1; composite TPI on later missions.** The
  M1 cluster is authored so distance AND value both climb #1→#7, so a pure
  distance sort makes the list read top-to-bottom in catch / reward order. Real
  prioritization (TPI) is retained where it matters (M2+).
- **D3 — No change to the scan mechanic itself.** A quick scan reveals up to 5
  undiscovered welcome pieces nearest-first; with 2 pre-discovered, one quick scan
  reveals exactly #3–#7. (Wide scan reveals up to 10.) This is a clean fit; keep it.

## Verified current behavior (anchors)

- **WELCOME_FIELD** = 7 specs, `DebrisField.js:227-271`:
  - #1 ~22 m (pinned, dead-centre, net catch) — pre-discovered
  - #2 ~48 m (pinned, off-side, net catch) — hidden until scan
  - #3 ~130–180 m (RANGE WALL, free orbit, teaches Autopilot)
  - #4 ~200–400 m, #5 ~400–670 m, #6 ~670–1075 m
  - #7 cubesat ~1075–1475 m ("graduation" catch)
- **Pre-discover gate:** only `i === 0` is pre-discovered; all others
  `discovered = false` until scan — `DebrisField.js:2327-2332`.
- **Tracked Targets list source + ranking:** `HUD.js:1064` →
  `DebrisField.getEnhancedTargetList(...)`, which returns
  `results.sort((a, b) => a.tpi - b.tpi)` (composite TPI) at
  `DebrisField.js:2966`. `isMission1` is already computed in that method
  (`DebrisField.js:~2812`). Each result already carries `distance` and
  `distanceKm` fields (`DebrisField.js:~2920`).
- **getEnhancedTargetList is ALSO the T/Tab cycle source** via InputManager
  (`InputManager.js:185, 1357, 1394, 1456, 1981`), so the upstream M1 sort change
  also makes Tab cycle nearest-first — desirable.
- **TargetPanel re-sort layer:** `TargetPanel.js:20` default `_sortMode = 'tpi'`;
  `:460-467` re-sorts the cached list when `_sortMode` is `'distance' | 'points'
  | 'deltaV'` (a SORT_CYCLE toggle, `:292-294`). `'tpi'` mode trusts the upstream
  order. So the visible HUD order = upstream sort UNLESS the player toggled a mode.
- **Scan reveal:** `SensorSystem._revealNearbyDebris` `:567-602` — quick
  `MAX_REVEALS = 5`, wide `= 10`, nearest-first, welcomeSpawn-gated, M1-clamped.
- **Diagnostics:** `DebrisField.getWelcomeFieldDiagnostics()` + Ctrl+D overlay
  (`DebugOverlay.js`) report per-piece discovered/tracked/visible/range — the
  verification tool for this work.

## Proposed changes

### Change 1 — pre-discover #1 AND #2 (D1)
`DebrisField.js:2327`. Pre-discover the first two spec rows instead of only the
first:

```js
// Pre-discover the two PINNED guided net-catch pieces (#1 dead-centre ~22 m,
// #2 off-side ~48 m). #3–#7 stay hidden until the player scans (S). With two
// pre-discovered, a single quick scan (MAX_REVEALS=5) reveals exactly #3–#7.
if (i <= 1) {
  debris.discovered = true;
  eventBus.emit(Events.TARGET_DISCOVERED, { target: debris });
} else {
  debris.discovered = false;
}
```
- Note: `i` is the spec index in the placement loop; spec #2 (`pin:true`,
  `latM>0`) is index 1. Both pinned pieces become listable immediately.
- Update the explanatory comment block at `DebrisField.js:2318-2326` to say "two
  obvious targets visible, learn to scan to find more."

### Change 2 — near→far ranking on M1 (D2)
`DebrisField.js:2966`. Mission-gate the final sort using the already-computed
`isMission1`:

```js
// Mission 1 is a guided cluster authored near→far == catch order == reward ramp,
// so sort purely by distance for a new player. Later missions keep the composite
// Target Priority Index (distance + ΔV + threat + value).
return results.sort((a, b) =>
  isMission1 ? (a.distance - b.distance) : (a.tpi - b.tpi));
```

### Change 3 — make the HUD panel honor near→far on M1 (D2, second layer)
The panel's default `_sortMode = 'tpi'` trusts upstream, so Change 2 already makes
the visible list near→far on M1 in the default mode. BUT confirm/adjust so the
displayed order can't silently diverge:
- Preferred: in `TargetPanel`, when on Mission 1, treat `'tpi'` mode as the
  upstream (now distance) order — no code change needed beyond Change 2, since
  `'tpi'` mode does not re-sort. **Verify** the panel is in `'tpi'` mode by default
  at M1 start and that nothing forces another mode.
- Optional polish: default `_sortMode` to `'distance'` on M1 so the sort-mode
  label shown to the player reads "DISTANCE" rather than "PRIORITY" (cosmetic
  truth-in-labeling). Decide during implementation; not required for correctness.

## Test impact

- `js/test/test-WelcomeField.js`: no current assertion pins discovered-count to 1
  (verified — only lowValue/flag assertions touch #1/#2). ADD a test: exactly #1
  and #2 are `discovered` at spawn, #3–#7 are not.
- `js/test/test-InputManager-Hotkeys.js`: mocks `getEnhancedTargetList` entirely →
  unaffected by Change 2.
- ADD a ranking test: on `isMission1`, `getEnhancedTargetList` returns results in
  non-decreasing `distance`; on a non-M1 mission, order follows `tpi`.
- Run `node js/test/run-tests.js`; suite was green at 3428 after the prior plan.

## Verification (playtest)

1. Clear `localStorage['spacecowboy_onboarding_v1']`, start M1.
2. **Before scan:** Tracked Targets shows exactly 2 entries (#1 then #2), nearest
   first. Tab cycles #1→#2 in range order. Ctrl+D shows #1/#2 `discovered`,
   #3–#7 not.
3. Press **S**: #3–#7 fade in (nearest-first), list grows to 7, still near→far.
4. Catch #1 then #2 with the net; confirm list re-orders sanely as pieces leave.
5. Sanity on a later mission (M2+): list still ranks by TPI (not pure distance).

## Risks / watch-items

- **OnboardingDirector beats** (`js/systems/OnboardingDirector.js`,
  script ids `tease_lock`/`second_catch`/`range_wall`): confirm no beat asserts
  "exactly 1 discovered" or gates progression on discovered count. Pre-discovering
  #2 should only make the `second_catch` beat easier (it's now listable).
- **#3 RANGE WALL beat:** #3 remains hidden until scan, so the Autopilot-teaching
  "out of range" beat still requires a scan first — confirm the beat ordering
  (catch #1, catch #2, THEN scan reveals #3 and teaches A) still reads correctly.
  If the script expects #3 visible before scan, either pre-discover #3 too or
  reorder the beat. Decide during implementation.
- **TPI fields still computed on M1:** Change 2 only swaps the comparator; the
  per-result `tpi` is still computed (cheap, harmless). No perf concern.

## Implementation checklist

- [x] Change 1: pre-discover #1 + #2 (`DebrisField.js:2327`), update comment.
- [x] Change 2: mission-gated near→far sort (`DebrisField.js:2966`).
- [x] Change 3: verify TargetPanel default mode shows upstream order on M1;
      optionally default `_sortMode='distance'` on M1 for label accuracy.
      VERIFIED: `_sortMode` defaults to `'tpi'` (TargetPanel.js:20) which does
      NOT re-sort (trusts upstream, :467); only ever changed by the user's
      SORT_CYCLE button click. So Change 2 makes the default M1 panel order
      near→far with no panel code change. Cosmetic label polish skipped (would
      hardcode a distance/distanceKm divergence; not required for correctness).
- [x] Confirm OnboardingDirector beats don't depend on discovered-count==1 and that
      the #3 range-wall/Autopilot beat still sequences correctly.
      VERIFIED: no beat asserts a discovered count; beats advance on
      LASSO_FIRED/DEBRIS_CAPTURED/AUTOPILOT_ENGAGE events. The `range_wall` beat
      is gated by `requiresOutOfRange` (OnboardingDirector.js:117,762-767), set
      from `TARGET_OUT_OF_RANGE`. That event comes from AutoLockController, which
      acquires via `getDebrisNear` (AutoLockController.js:182) — NOT filtered on
      `discovered`. So autolock hops to the hidden #3 after #1/#2 are cleared and
      fires OUT_OF_RANGE regardless of discovered state. #3 does NOT need
      pre-discovering and no beat reorder is required (the key open risk).
- [x] Add tests: discovered set = {#1,#2} at spawn; M1 list sorted near→far; non-M1
      list sorted by TPI. (test-WelcomeField.js: 3 new tests.)
- [x] `node js/test/run-tests.js` green. (847 suites, 3431 tests, 0 fail.)
- [ ] Playtest per the checklist above (Ctrl+D verification).
