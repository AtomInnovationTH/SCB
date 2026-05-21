# ARM_PIVOT_GAPS_EXPLAINER — Archived

> **Archived:** 2026-05-16 · **Reason:** All 13 gaps from [`ARM_PIVOT_ANALYSIS.md §5`](ARM_PIVOT_ANALYSIS.md) were resolved during Epic 9 (Config G Arm System — complete 2026-04-28) and Epic 10 (Config G Visualisation — complete 2026-05-08).

This file was a per-gap scoping decision aid for Epic 9 planning. All decisions are now implemented in code.

**Where the resolved gaps now live:**

| Gap topic | Implementation |
|-----------|---------------|
| Locked Config G geometry | [`ARM_PIVOT_ANALYSIS.md §10–§11`](ARM_PIVOT_ANALYSIS.md) (still authoritative) |
| Aim rotation (#13) — semi-auto | [`ArmManager.js`](js/entities/ArmManager.js), [`ArmUnit.getAimAlpha()`](js/entities/ArmUnit.js) |
| Stow/Deploy state machine (#4) | [`ArmUnit.getDeployState()`](js/entities/ArmUnit.js) |
| ROSA + launch locks (#7) | [`LaunchCinematic.js`](js/scene/LaunchCinematic.js), [`PlayerSatellite._buildROSAPanels()`](js/entities/PlayerSatellite.js) |
| Capture Net (#6) | [`CaptureNet.js`](js/entities/CaptureNet.js), [`CAPTURE_NET.md`](CAPTURE_NET.md) Rev 4 |
| Tether reel (#5) | [`TetherReel.js`](js/systems/TetherReel.js) |
| CoM + plume interlock (#8) | [`CoMCalculator.js`](js/systems/CoMCalculator.js) |
| Tech ladder (Y0→Y3) | [`ArmTierCatalog.js`](js/systems/ArmTierCatalog.js), [`TierVisualManager.js`](js/scene/TierVisualManager.js) |

**For history:** `git log --follow ARM_PIVOT_GAPS_EXPLAINER.md` or `git show HEAD~1:./ARM_PIVOT_GAPS_EXPLAINER.md` for the immediate-prior content.
