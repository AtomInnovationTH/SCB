# FIX_PLAN.md — Space Cowboy: Four-Issue Deep-Dive Architecture & Fix Plan

> **📦 ARCHIVED 2026-05-30.** All four issues in this plan were implemented in the 2026-05-29/30 sprint. Test suite ended at **556 suites / 2364 tests / 0 failures**. Deferred items + emergent findings captured in [`HANDOFF.md`](../HANDOFF.md:1). The plan is preserved here in full as the canonical architectural reference for the four fixes — useful when revisiting any of the touched subsystems or extending the patterns established (`RENDER_ORDER` enum, canonical arm-state predicates, TPI ranking, two-mesh panel front/back).
>
> **Implementation outcome map** (what shipped, what slipped — quick reference):
>
> | Section | Status | Notes |
> |---|---|---|
> | §0 Critical findings | ✅ All four facts informed the fix design as written |
> | §2 Issue 1 (Z-layer + aft) | ✅ Shipped — 3-round comprehensive sweep, 50+ renderOrder annotations across barrel, collar, struts, viewport, hinge, sensors, dock, thrusters |
> | §2.2.C `setThrusterFire` differential firing | ❌ **Deferred** — all 4 FEEPs still fire together. Highest-value deferred item (~1-2h). |
> | §3 Issue 2 (Rotation lock) | ✅ Shipped — extended to exponential spring-resistance model (skill-based emergent mechanic discovered) |
> | §3.2.D AutopilotSystem `armsActive` bonus | ✅ Shipped — now uses canonical `hasTetheredArm()` predicate |
> | §4 Issue 3 (TPI) | ✅ Shipped — final weights `0.35/0.30/0.20/0.15` (dist/ΔV/MOID/value); MOID badges propagated through enhanced target list |
> | §4.2 dynamic `DIST_REF_KM` from sensor tier | ❌ **Deferred** — fixed 100km reference, no sensor coupling yet (~30min) |
> | §4.3 `TARGET_PANEL_MAX_ROWS` constant | ❌ **Deferred** — magic `7` still in [`TargetPanel.js:362`](../js/ui/hud/TargetPanel.js:362) (~5min) |
> | §5 Issue 4 (Panel back) | ✅ Shipped — FrontSide (PV 0x0a1133) + BackSide (Kapton 0xccccdd emissive 0.4) with flipped-normal geometry clone + custom ShaderMaterial for grid wireframe (GL_LINES face-culling workaround) |
> | §7 Out-of-scope items | Still out of scope — see [`HANDOFF.md`](../HANDOFF.md:1) "Known Issues & Deferred Items" |
>
> **Original plan follows unchanged below.** See [`HANDOFF.md §1`](../HANDOFF.md:1) for the sprint write-up.

---

> Implementation-ready specification grounded in **direct source-code inspection**, not just research summaries. Covers four production issues:
>
> 1. Mother/Daughter rendering & z-layer issues
> 2. Tether/strut cutting through mother during rotation
> 3. Target ranking ignores distance & threat
> 4. Solar panel "shadow" on Earth when ship is inverted
>
> Each section: **Verified Root Cause → Fix Strategy → Surgical Code Changes (with verified file/line refs) → New Constants → Testing → Risk → Side-Effects on existing systems**.

---

## 0. Critical Findings Missed in Initial Research

Before diving in, four facts from the actual code that change the fix design:

1. **There are 12 thrusters, not 4.** [`PlayerSatellite._buildThrusters()`](../js/entities/PlayerSatellite.js:944) creates **4 main FEEPs** at the aft (cross pattern, z = -M*1.0) **AND 8 RCS attitude thrusters** ([`PlayerSatellite.js:1016-1050`](../js/entities/PlayerSatellite.js:1016)) at the barrel sides (4 quadrants × 2 z-offsets). Any "aft redesign" must account for the RCS thrusters, which provide the visual reading of "this is a real spacecraft."
2. **The 4 main FEEPs are wired into a plume-interlock physics system.** Each carries `_thrusterId` ∈ {`HT_TOP`, `HT_BOTTOM`, `HT_RIGHT`, `HT_LEFT`} matching [`Constants.THRUSTERS`](../js/core/Constants.js:513). [`CoMCalculator.getActiveBlocks()`](../js/systems/CoMCalculator.js:472) and [`test-CoMCalculator.js`](../js/test/test-CoMCalculator.js:417) hard-depend on the 4-cross topology. **Re-topologising would cascade through CoM, interlock, and tests.** Fix must preserve the 4-thruster logical layout.
3. **MOID badges are already stamped onto debris objects.** [`ConjunctionSystem.updateMOID():256-257`](../js/systems/ConjunctionSystem.js:256) writes `debris.moidBadge` ∈ {`'HI'`,`'MD'`,`'LO'`,`null`} and `debris.moid_m`. **No new API surface needed** for Issue 3 — just read them from the existing debris reference inside `getEnhancedTargetList`.
4. **The autopilot's own `armsActive` predicate is incomplete.** [`AutopilotSystem.js:677-683`](../js/systems/AutopilotSystem.js:677) only counts `LAUNCHING / TRANSIT / APPROACH / STATION_KEEP` as "active". It misses `REELING / HAULING / RETURNING / GRAPPLED / FISHING / TRAWLING / NETTING / DOCKING / ABLATING / SCANNING / TANGLED / DEORBITING`. The Issue 2 fix should introduce a **shared canonical predicate** that AutopilotSystem also adopts — fixing two bugs with one helper.

These four facts are the spine of everything below.

---

## 1. Overview

| # | Issue | Severity | True user-visible symptom | Single-sentence verified root cause |
|---|-------|----------|---------------------------|--------------------------------------|
| 1 | Mother/Daughter rendering & z-layer | High | Flickering grids; aft thruster cluster reads as "toy"; pyro pin shimmers | Cell grid (radius `1.006`) and daughter pocket (`1.006`) share the same radius; pyro pin (`1.02`) and accent ring torus (`1.02`) share the same radius and pyro has no polygonOffset; panels lack `renderOrder`. |
| 2 | Rotation cuts through mother | High | Arrow keys whip the mother around while a daughter is on a tether, slicing the strut/tether through the body | [`InputManager.js:1589`](../js/systems/InputManager.js:1589) only blocks rotation when the SINGLE camera-piloted arm is in `STATION_KEEP`. Every other deployed state allows full 0.08 rad/s rotation. |
| 3 | Target ranking | Medium-High | Close, obvious debris hidden because pure-ΔV sort fills the 7-slot panel with deep-space cheap targets | [`DebrisField.js:2015`](../js/entities/DebrisField.js:2015) sorts purely by `deltaV` ascending; distance, MOID threat, and points are display-only. |
| 4 | Solar panel "shadow" on Earth | Medium | Dark blue rectangle smear on Earth when mother is inverted | [`PlayerSatellite.js:1079-1083`](../js/entities/PlayerSatellite.js:1079) uses `DoubleSide` + dark navy `color: 0x0a1133` + dim navy `emissive: 0x0a0a40`. The opaque back face occludes Earth and reads as a "shadow." |

---

*[Sections 2-8 of the original plan are 1000+ lines of architecture detail — preserved verbatim in the pre-archive root `FIX_PLAN.md` (commit prior to 2026-05-30). The implementation outcome map at the top of this file maps each section to its shipped/deferred status. For the architectural patterns established by this plan — `RENDER_ORDER` enum, canonical `hasTetheredArm()`/`getRotationLockTier()` predicates, TPI weighted ranking, two-mesh FrontSide/BackSide panel split with cloned flipped-normal geometry — read those sections directly in the [`HANDOFF.md`](../HANDOFF.md:1) "Architecture Changes" summary, or restore from git history if implementing related future work.]*

> **Why a stub instead of full text?** The plan totalled 1094 lines and has been fully implemented. The architectural patterns are now codified in the live source (search `RENDER_ORDER`, `hasTetheredArm`, `getRotationLockTier`, `TARGET_RANKING`, `TETHER_ROTATION` in [`Constants.js`](../js/core/Constants.js:1) and [`ArmManager.js`](../js/entities/ArmManager.js:1)) and the rules-of-thumb are documented in [`HANDOFF.md`](../HANDOFF.md:1). The deferred portions (§2.2.C `setThrusterFire`, §4 dynamic DIST_REF_KM, §4.3 `TARGET_PANEL_MAX_ROWS`) are tracked in [`HANDOFF.md`](../HANDOFF.md:1) "Recommended Next Steps". The seven out-of-scope items from the original §7 are tracked in [`HANDOFF.md`](../HANDOFF.md:1) "Known Issues & Deferred Items".

---

## 8. Cross-Cutting Architectural Lessons (preserved verbatim)

Two themes that emerged from the deep-dive and inform future PRs:

1. **`renderOrder` should be a project-wide convention from day 1.** The current pattern of "add polygonOffset here, hope it works" causes ten different layer pairs to conflict over time. The `RENDER_ORDER` enum (now shipped in [`Constants.js`](../js/core/Constants.js:1)) makes layering an explicit architectural concern rather than per-mesh trial-and-error.
2. **Arm-state checks should live on `ArmManager` as named predicates, never as inline `.some()` calls.** The bug in [`AutopilotSystem.js:677-683`](../js/systems/AutopilotSystem.js:677) (incomplete state list) was the *third* such inline check found in the codebase — anyone adding a new state to `ARM_STATES` had to remember to update each one. The `getRotationLockTier()` / `hasTetheredArm()` helpers (now shipped on [`ArmManager.js`](../js/entities/ArmManager.js:1)) start the centralisation; future PRs should migrate other call sites to the same pattern. **Two known remaining inline sites:** [`AutopilotSystem.js:697`](../js/systems/AutopilotSystem.js:697) and [`RadialMenu.js:306`](../js/ui/hud/RadialMenu.js:306) — see [`HANDOFF.md`](../HANDOFF.md:1) "Architecture Opportunities" #20.

---

*End of archived FIX_PLAN.md. Forward work tracked in [`HANDOFF.md`](../HANDOFF.md:1) and [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md:1).*
