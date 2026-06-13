# Review: capture-feedback & risk overhaul (uncommitted working tree)

Scope reviewed: all 23 modified + 10 untracked files implementing
`.kilo/plans/capture-feedback-and-risk-overhaul.md` (Phases 0–3c).
Test suite: **2954/2954 pass** (new suites registered in run-tests.js:170-175).
Wiring verified against real call sites (main.js loop, InputManager.processInput,
CommsSystem payload normalization, ScoringSystem.awardPoints, KesslerSystem
INTERACTION_FRAGMENTATION handler, TargetSelector.getActiveTarget,
ArmManager.getSelectedArm, DespinLaser `_despinning` lifecycle).

Verdict: the implementation is faithful to the plan and structurally sound.
Two real bugs (B1, B2), one design-honesty gap (B3), and a handful of minor
issues the tests don't cover.

---

## B1 — FRAG chip violates the "honest numbers" contract  (bug, fix before commit)

- Resolve roll: `NetProjectile._resolveCatch` now uses
  `effectiveFragility(target)` → `brittleness * 0.3` fallback (CaptureNet.js:349-355, 929).
- Pre-fire chip: `ArmUnit._refreshToolOdds` still uses
  `targetFragility: target.fragility || 0.05` (ArmUnit.js:~3445).
- Debris **never has a `fragility` field** (DebrisField.js generates only
  `brittleness`, line 666/727), so the displayed ⚠FRAG % is pinned at the 0.05
  floor while the actual roll can be ~6× higher on brittle debris. This is
  exactly the mismatch the unified ToolOdds model was built to prevent.

**Fix:** import `effectiveFragility` in ArmUnit.js and use it in
`_refreshToolOdds`. Add a test asserting chip risk == resolve risk for a
brittleness-only target.

## B2 — Eddy damp leaves `target._despinning = true` forever  (bug)

`_updateEddyDamp` (ArmUnit.js:~3470) sets `target._despinning = true` every
active frame, but every deactivation path — out of range, tool switch, tumble
reaching 0, `_exitStationKeep` (ArmUnit.js:3265-3268) — clears only
`_eddyDamping`. DespinLaser clears `_despinning` only for its own
`_beamTarget` (DespinLaser.js:104,122).

Consequences once eddy damping has ever engaged on a target:
- TargetReticle shows the "de-spinning" tumble label permanently (TargetReticle.js:927).
- `_buildNetAdvisory` shows `de-spinning N°/s → 10°/s` even when nothing is
  damping, and the ASPECT branch skips the `de-spin to freeze aspect [U]`
  advisory (DockingReticle.js:1292, 1309).

**Fix:** in the eddy deactivation branch and `_exitStationKeep`, also clear
`_despinning` (safe: the laser re-asserts it every frame while firing).

## B3 — Tension bar RIP tick is on the wrong axis  (design/legibility gap)

`_drawTensionBar` (DockingReticle.js:1180-1196) plots
`tetherTension / tetherBreakStrength` and places the RIP tick at
`NET_STRAIN_SAFE_FRACTION` (0.8) **of the tether axis**. But net-rip
probability is driven by `payloadMass / _netRatedMass` (ArmUnit.js:4614-4625) —
a different quantity. A heavy catch deep in the strain band can boost-rip while
the bar sits green below the tick; a light catch can cross the tick with zero
rip risk. The bar cannot actually be read the way the plan promises
("marked NET-RIP and TETHER-SNAP thresholds").

**Fix options:** (a) draw the RIP tick at a strain-derived position
(`strain`-scaled), (b) color the RIP tick/label by live strain, or
(c) show a second thin strain bar. Pick one in the fix pass.

---

## Minor issues

| # | Where | Issue |
|---|-------|-------|
| M1 | TargetPanel.js:371 `_renderBestToolBadge` | `computeToolOdds` called without `range` → NET % assumes 50 m for every row; panel % and reticle % can disagree (partial SSOT violation). Pass the target's actual range if cheaply available, or accept + comment. |
| M2 | DockingReticle `_easeOdds` | `_oddsEase` is never reset on target/arm change → brief false count-up + trend arrows when retargeting or switching piloted arm. Clear it in `setArmData` when arm/target changes. |
| M3 | LassoSystem.js:480-498 | Mother-net odds note ignores pod inventory/cooldown (`netCount` not passed) — can advertise "Mother net 96%" with an empty magazine. Pass `netCount: captureNetSystem._motherPodInventory[...]` or suppress when empty. |
| M4 | DebrisWireframe.js:1683-1690 | When tumble > 60°/s, brittleness row draws at `infoY+36` — same y as `_renderProfiledManifest(ctx, infoY + 36)` header → overlapping text. |
| M5 | Constants.js ASPECT_CAPTURE | `END_ON_FIT_MARGIN` is defined but never used (assessNetFit / `_netAspectChip` ignore it). Remove or wire it. |
| M6 | DossierSystem.update | Surveys only the **active selector target**; a daughter station-keeping a non-selected debris never opens its chest. Acceptable deviation from "any platform near any target", but worth a code comment so it reads as intentional. |
| M7 | Plan 1.5 "soft chime per row" | `_lastRowsShown` is tracked (DebrisWireframe.js:1745) but no audio is ever played — chime not implemented. Either wire `audioSystem` or drop the field. |
| M8 | CaptureNet.js:386-388 | `missReasonToText` doc says "Returns null for … unknown reasons" — now stale (default returns a generic line). Update the JSDoc. |
| M9 | Constants.js:2634 TOTAL_MOMENTS comment | Says +2 (Phase 0.6) +1 (Phase 1.5) but the count went 19→24 (also +first_aspect_target, +first_fragmentation). Comment under-documents. |

## Formatting regressions (edit-tool artifacts — clean up)

Joined lines where a newline was lost during editing (all harmless, all sloppy):
- HUD.js:1654 `showNetFailedAlert(data) {    // Amber radial flash…`
- ArmUnit.js:~3518 `/** Cycle \`selectedTool\` … */  cycleTool() {`
- Constants.js DOSSIER block: `// Debris Dossier — … data  // (capture-feedback…` (two comments fused on one line)
- Constants.js FRAG_SEVERITY block: same fused-comment pattern
- DebrisField.js:2658 `…(Kessler cascade event).   * @param {{ x…` (JSDoc lines fused)

## Verified-good (no action)

- main.js dossier wiring: `targetSelector.getActiveTarget()` exists; update is
  try/caught in the gameplay loop in the right order (after sensors, before Kessler).
- InputManager boost: `overlayOpen` computed before the block; set-every-frame
  pattern matches the laser intent; boost only acts in REELING+payload, so
  Shift-modifier combos are harmless. `ArmManager.setReelBoost` fans out correctly.
- DockingReticle four-state widget: `_drawToolSelectionPanel` is reached for
  NETTING/GRAPPLED/REELING because ARM_PILOT mode (and thus reticle visibility,
  main.js:1624-1634) persists through fire/reel; `_firedNet.distanceTraveled`
  is meters ✓; `blockerY/advisoryY` scoping ✓; `--` vs 0% handled ✓; null-odds
  seed state renders safely before the first 10 Hz refresh ✓.
- ToolOdds mirrors: strain band matches `_checkNetIntegrityOnReel`;
  fDistance/fSpin/tumble loss terms match `computeClingProbability` internals;
  spin-decay estimate matches the flight model; CINCH/SLAM pBase fork mirrors
  `_resolveCatch`.
- Fragmentation chain: single `INTERACTION_FRAGMENTATION` emit (no Kessler
  double-count); `DebrisField._onInteractionFragmentation` → `createFragments`
  /`removeDebris` signatures ✓; mercy + credit penalty (negative
  `SCORING_AWARD` works — ScoringSystem.awardPoints adds the delta) ✓;
  HUD flash + teaching moment wired ✓.
- Aspect capture: Rodrigues rotation in `worldLongAxis` is correct; presented
  width frozen at catch (`_catchPresentedWidthM`) and reused at reel ✓;
  `oversize_aspect` deterministic miss + message ✓; CatalogConverter derivation ✓;
  feature-flag gated everywhere ✓.
- DossierSystem: comms `sender:` is normalized by CommsSystem ✓; GAME_RESET
  listener ✓; once-per-debris bounty ✓; `discovered:false` default ✓.
- TeachingSystem: TARGET_SELECTED payload includes `debris` ✓; all 5 new
  moments gated on their feature flags; TOTAL_MOMENTS 24 == 19+5 ✓.

---

## Suggested fix pass (small, ordered)

1. B1 — use `effectiveFragility` in `ArmUnit._refreshToolOdds` (+1 test).
2. B2 — clear `_despinning` on eddy deactivate + `_exitStationKeep` (+1 test:
   flag cleared after tool switch / range exit).
3. B3 — choose a RIP-tick representation tied to actual strain; adjust
   `_drawTensionBar` (+ update widget test).
4. M1–M5, M8, M9 — one-liners.
5. Formatting cleanup (5 joined-line artifacts).
6. Re-run full suite.
