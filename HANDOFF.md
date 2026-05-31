# Space Cowboy — Next-Shift Handoff Brief

*Updated: 2026-05-30 · Four-fix architectural sprint complete. Prior shift archived to [`archive/HANDOFF_2026-05-29_post-cinch-qa.md`](archive/HANDOFF_2026-05-29_post-cinch-qa.md). Earlier shifts at [`archive/HANDOFF_AUTOPILOT_RETRO.md`](archive/HANDOFF_AUTOPILOT_RETRO.md), [`archive/SK_M1_POLISH_HANDOFF.md`](archive/SK_M1_POLISH_HANDOFF.md), [`archive/CEREMONY_REDESIGN.md`](archive/CEREMONY_REDESIGN.md).*

---

## 🚀 Next Shift? Start Here

### Step 1 — Orient (15 min)

| # | Read | Why |
|---|------|-----|
| 1 | [`§1 Session Summary`](#1-session-summary-2026-05-2930) + [`§5 Recommended Next Steps`](#5-recommended-next-steps) | What just shipped + what's ready to pick up |
| 2 | [`§9 THREE.js Convention SSOT`](#9-threejs-convention-ssot-load-bearing) + [`§10 Post-Cinch Learnings`](#10-post-cinch-fix-learnings-load-bearing) | Load-bearing rules — read BEFORE touching orientation, FSM, or visual code |
| 3 | [`README.md`](README.md:1) | Quick start, controls, controls reference |
| 4 | [`GAME_DESIGN.md`](GAME_DESIGN.md:1) §1–§3 | Core loop, jellyfish identity, ΔV economy |
| 5 | [`ARCHITECTURE.md`](ARCHITECTURE.md:1) | File structure, module design, state machine (⚠️ needs Epic 9/10 update) |

### Step 2 — Verify baseline

```bash
node js/test/run-tests.js | tail -3    # expect: 556 suites / 2364 tests / 0 failures
```

If red, see [`archive/SK_M1_POLISH_HANDOFF.md §7 Appendix`](archive/SK_M1_POLISH_HANDOFF.md) for diagnostic-log grep targets.

### Step 3 — Pick a task

See [`§5 Recommended Next Steps`](#5-recommended-next-steps). Top 7 are ordered by effort/impact and ready for Orchestrator to research+architect+code.

---

## §1 Session Summary (2026-05-29/30)

**Four-fix architectural sprint.** All issues from [`archive/FIX_PLAN.md`](archive/FIX_PLAN.md) implemented across 2 days. Test delta: **+44 tests** (2320 → **2364**). 0 regressions. Service worker bumped to **v4**.

### Issues shipped

| # | Issue | Severity | One-line outcome |
|---|---|---|---|
| 4 | Solar panel "shadow" on Earth | Medium | Split DoubleSide into FrontSide (PV cells) + BackSide (Kapton/silver substrate) with flipped-normal geometry clone; custom ShaderMaterial for grid wireframe (GL_LINES has no face culling) |
| 2 | Rotation limits when daughters tethered | High | Exponential spring-resistance model with 3 tiers (none/soft/block); new canonical [`ArmManager.hasTetheredArm()`](js/entities/ArmManager.js:1) + [`getRotationLockTier()`](js/entities/ArmManager.js:1) predicates covering all 20+ ARM_STATES |
| 1 | Z-layer fixes + aft rendering | High | New [`RENDER_ORDER`](js/core/Constants.js:1) 6-tier enum; 50+ renderOrder annotations across barrel/collar/struts/viewport/hinge/sensors/dock/thrusters; FEEP thruster upgrade (mounting boss + accelerator grid disc per nozzle) |
| 3 | Target ranking (TPI) | Medium-High | Composite Target Priority Index: `TPI = 0.35×dist + 0.30×ΔV + 0.20×MOID + 0.15×value`; MOID badges propagated into enhanced target objects; 4-way sort cycle |

### Test suite

**556 suites / 2364 tests / 0 failures** as of 2026-05-30. New file: [`test-RotationLock.js`](js/test/test-RotationLock.js:1) — 7 suites, **44 tests**.

---

## §2 Architecture Changes

### 2.1 New Constants ([`js/core/Constants.js`](js/core/Constants.js:1))

| Block | Purpose | Used by |
|---|---|---|
| `RENDER_ORDER` | 6-tier enum for Three.js renderOrder: `EARTH=0, SPACECRAFT_OPAQUE=1, DETAIL=2, TRANSPARENT=3, ADDITIVE=4, HUD=10` | [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:1), [`ArmUnit.js`](js/entities/ArmUnit.js:1), [`MenuScene3D.js`](js/ui/MenuScene3D.js:1) |
| `TETHER_ROTATION` | Spring model: `MAX_DISPLACEMENT_SOFT/BLOCK`, `STIFFNESS_EXPONENT`, `SPRINGBACK` rates, `COMMS_THROTTLE_MS` | [`InputManager.js`](js/systems/InputManager.js:1) |
| `TARGET_RANKING` | TPI weights, reference values, `MOID_THREAT_MAP` | [`DebrisField.js`](js/entities/DebrisField.js:1), [`TargetPanel.js`](js/ui/hud/TargetPanel.js:1) |

### 2.2 New methods on `ArmManager` (canonical predicates)

```js
// js/entities/ArmManager.js
hasTetheredArm()        → bool                      // Any non-detached arm not in {DOCKED, RELOADING, EXPENDED}
getRotationLockTier()   → 'none' | 'soft' | 'block' // Max-severity tier across all arms
```

These replace **inline `.some()` state checks** at multiple call sites. **Two known remaining inline sites need migration** ([`AutopilotSystem.js:697`](js/systems/AutopilotSystem.js:697), [`RadialMenu.js:306`](js/ui/hud/RadialMenu.js:306)) — see [`§4 Architecture Opportunities #20`](#42-architecture-opportunities).

**Tier mapping** (canonical — defined in [`ArmManager.js`](js/entities/ArmManager.js:1) module-scope sets):

| Tier | States | Behaviour |
|---|---|---|
| `block` (zero rotation) | NETTING, GRAPPLED, STATION_KEEP, REELING, HAULING, RETURNING, DOCKING, TANGLED, DEORBITING | Arrow keys consume input but apply no rotation; comms warning emitted |
| `soft` (~0.3°/s max) | LAUNCHING, TRANSIT, APPROACH, FISHING, TRAWLING, SCANNING, ABLATING, UNDOCKING, WEB_SHOT | Exponential spring resistance; player can build displacement, releases trigger springback |
| `none` (full 0.08 rad/s) | DOCKED, RELOADING, EXPENDED; OR any arm with `isDetached === true` | Legacy unrestricted behaviour |

### 2.3 Emergent skill-based mechanic

The **spring-resistance model has a discoverable depth**: a skilled pilot can build displacement against soft-tier resistance, then release the arrow keys for a boost-assist rotation as the spring snaps back. Worth surfacing via a tutorial moment or Codex entry — see [`§5 #6 Teaching moment`](#5-recommended-next-steps).

### 2.4 RENDER_ORDER convention

**Project-wide.** Replaces the prior ad-hoc polygonOffset-only layering. Any new mesh in spacecraft hierarchies MUST declare a `renderOrder` from the enum. **Not yet extended** to 5 modules still using ad-hoc values: [`Earth.js`](js/scene/Earth.js:1), [`Starfield.js`](js/scene/Starfield.js:1), [`TrailSystem.js`](js/ui/TrailSystem.js:1), [`TargetReticle.js`](js/ui/TargetReticle.js:1), [`NavSphere.js`](js/ui/NavSphere.js:1), [`DockingReticle.js`](js/ui/DockingReticle.js:1) — see [`§5 #5`](#5-recommended-next-steps).

### 2.5 ROSA panel two-mesh pattern

`THREE.ShapeGeometry` cannot be split into material groups (one face range). Solution: **two coincident meshes sharing the same geometry instance** — one `FrontSide` PV material (dark blue), one `BackSide` Kapton material (bright Kapton 0xccccdd, emissive 0.4). For the back, geometry is cloned with **flipped normals** so lighting is correct on the back face. Grid wireframe uses a custom `ShaderMaterial` with view-dot-normal discard (workaround: GL_LINES primitives have no face culling, so DoubleSide-discard at the fragment level is the only way to hide back-facing grid lines).

Same pattern applied to both:
- Mother ROSA panels in [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:1)
- Daughter ROSA panels in [`ArmUnit.js`](js/entities/ArmUnit.js:1)

**Material duplication is a known refactor opportunity** — `panelMatFront`, `panelMatBack`, `gridMat`, `goldEdgeMat` are duplicated between the two files (10 materials where 4 suffice). See [`§5 #3`](#5-recommended-next-steps).

### 2.6 TPI ranking

```
TPI = 0.35 × distScore + 0.30 × dvScore + 0.20 × moidThreatScore + 0.15 × valueScore
```

- `distScore`, `dvScore`, `valueScore` normalized to [0, 1]; descending sort.
- `moidThreatScore` from [`TARGET_RANKING.MOID_THREAT_MAP`](js/core/Constants.js:1): `HI=1.0`, `MD=0.5`, `LO=0.2`, `null=0`.
- Implemented in [`DebrisField.getEnhancedTargetList()`](js/entities/DebrisField.js:1); MOID badges now propagated from `debris.moidBadge` into row.
- **Default sort changed from ΔV to TPI across all consumers** — Tab cycling, auto-advance after capture, panel rendering.
- **4-way sort cycle:** TPI ↑ → ΔV ↑ → Dist ↑ → Pts ↓ (was 3-way ΔV/Dist/Pts).
- [`DebrisField.getTargetList()`](js/entities/DebrisField.js:1) (route planner) **deliberately preserves ΔV sort** — appropriate for fuel-cost planning.

### 2.7 Service worker

Bumped to **v4**. Forces clients to fetch updated [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:1) and [`ArmUnit.js`](js/entities/ArmUnit.js:1) panel materials.

---

## §3 State of the Code

### 3.1 Test suite

```bash
$ node js/test/run-tests.js | tail -3
556 suites / 2364 tests / 0 failures
```

Run with `./test.sh` or `node js/test/run-tests.js`. Pattern filter: `node js/test/run-tests.js --filter RotationLock`.

### 3.2 Files modified this sprint

See [`§7 Files Modified This Sprint`](#7-files-modified-this-sprint) for the complete list with issue numbers.

### 3.3 Active terminals / running processes

None expected. If a browser dev session was left open, `Cmd+Shift+R` to force-reload past the SW v4 bump.

---

## §4 Known Issues & Deferred Items

> **21 items total**, organized by priority. Items 1-3 are in-plan deferrals from [`archive/FIX_PLAN.md`](archive/FIX_PLAN.md) that didn't make this sprint. Items 4-9 are explicitly out-of-scope per the original plan §7. Items 10-11 are feature-flag risks for when flags eventually flip ON. Items 12-15 are test coverage gaps. Items 16-20 are architecture opportunities. Item 21 is an emergent product opportunity.

### 4.1 Silently deferred (in plan, not implemented)

| # | Item | Effort | Notes |
|---|---|---|---|
| 1 | **`setThrusterFire(axis, sign, magnitude)` on PlayerSatellite** — Differential FEEP plume firing per rotation axis. All 4 FEEPs still fire together. | ~1-2h | **Highest visible value deferred item.** [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:1) `_animateThrusters` currently lerps all 4 nozzles together. Per-axis mapping spec: pitch+ → HT_BOTTOM, pitch- → HT_TOP, yaw+ → HT_LEFT, yaw- → HT_RIGHT. |
| 2 | **Dynamic `DIST_REF_KM` from sensor tier** — TPI uses fixed 100km reference; sensor upgrades don't affect ranking sensitivity. | ~30 min | Gameplay progression hook. Read `SENSOR_TIERS[d.sensorSystem.tier].rangeKm` and scale `DIST_REF_KM` (×0.7). |
| 3 | **`TARGET_PANEL_MAX_ROWS` constant** — Magic `7` persists in [`TargetPanel.js:362`](js/ui/hud/TargetPanel.js:362). | ~5 min | Hoist to `Constants.TARGET_RANKING.PANEL_MAX_ROWS` or similar. |

### 4.2 Out of scope (per plan §7)

| # | Item | Notes |
|---|---|---|
| 4 | Real CSG stowage grooves | Cosmetic only; current polygonOffset planes are stable with new renderOrder ordering |
| 5 | Three.js shadow-mapping for ship-on-Earth shadows | Needs perf budget — separate fix from Issue 4 panel back-face (which solved the *symptom*) |
| 6 | Earth shader integration with spacecraft lighting | Custom day/night ShaderMaterial does not receive Three.js standard light |
| 7 | Tether geometric collision detection against mother body | Issue 2 prevents the *scenario* (lock when tethered); does not physically simulate tether-vs-body collision |
| 8 | 1000km search radius as mission-level setting | Intentionally larger than sensor max — tracked debris > sensor range; should be documented constant rather than inline literal |
| 9 | Duplicated `tracked !== false` filter | Currently in [`InputManager.js`](js/systems/InputManager.js:1) Tab cycle AND [`TargetPanel.js`](js/ui/hud/TargetPanel.js:1); should consolidate into `getEnhancedTargetList` |

### 4.3 Feature flag risks (document for when flags flip ON)

| # | Flag | Risk | Mitigation |
|---|---|---|---|
| 10 | **`TETHER_REEL` flip ON** | [`getRotationLockTier()`](js/entities/ArmManager.js:1) doesn't consult reel state — STATION_KEEP arm with CUT tether still blocks rotation | Add reel-state downgrade: if `armUnit.tetherSevered === true`, treat as detached (tier `none`) |
| 11 | **`STOW_DEPLOY_STATE_MACHINE` flip ON** | Minor — DOCKED + DEPLOYING = tier `'none'`, physically correct but could use a `'warn'` tier for the transient swing | Optional: add 4th tier `'warn'` with no rotation block but a comms hint |

### 4.4 Test coverage gaps

| # | Gap | Suggested test file |
|---|---|---|
| 12 | TPI math (formula, weights, MOID null fallback) | New `test-TargetRanking.js` — see [`§5 #2`](#5-recommended-next-steps) |
| 13 | InputManager spring dynamics (most novel code in the sprint) | Extend `test-RotationLock.js` or new `test-InputSpring.js` |
| 14 | MOID badge propagation through `getEnhancedTargetList` | Extend `test-DebrisField.js` |
| 15 | AutopilotSystem's `hasTetheredArm()` adoption (regression: AP must not auto-disengage after ARRIVED while REELING) | Extend [`test-AutopilotSystem.js`](js/test/test-AutopilotSystem.js:1) |

### 4.5 Architecture opportunities

| # | Opportunity | Effort | Notes |
|---|---|---|---|
| 16 | **Extract `js/scene/SpacecraftMaterials.js`** | ~1.5h | `panelMatFront/Back`, `gridMat`, `goldEdgeMat` duplicated between [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:1) and [`ArmUnit.js`](js/entities/ArmUnit.js:1) — 10 materials where 4 suffice |
| 17 | **Extend `RENDER_ORDER` to Earth, Starfield, TrailSystem, TargetReticle, NavSphere, DockingReticle** | ~2h | All use ad-hoc renderOrder; full convention coverage |
| 18 | **Wire TPI into AutopilotSystem fallback** | ~30 min | Replace "nearest Tier 3/4" inline pick with `getEnhancedTargetList()[0]` |
| 19 | **Teaching moment for rotation lock** | ~45 min | Subscribe [`TeachingSystem.js`](js/systems/TeachingSystem.js:1) to `COMMS_MESSAGE`, once-per-session "Rotation locked — recall with H" |
| 20 | **Consolidate inline ARM_STATES checks to named predicates** | ~30 min | [`AutopilotSystem.js:697`](js/systems/AutopilotSystem.js:697), [`RadialMenu.js:306`](js/ui/hud/RadialMenu.js:306) still inline |

### 4.6 Emergent product opportunity

| # | Finding | Why it matters |
|---|---|---|
| 21 | **Spring rotation has skill-based mechanic** — player can build displacement then release arrows for boost-assist rotation as spring snaps back | Worth surfacing via tutorial or Codex. Couples nicely with teaching-moment work in #19. |

---

## §5 Recommended Next Steps

Ordered by effort/impact. Each is ready for Orchestrator to research+architect+code.

| Rank | Task | Effort | Acceptance |
|---|---|---|---|
| 1 | **`setThrusterFire` differential firing** (defer [#1](#41-silently-deferred-in-plan-not-implemented)) | ~1-2h | Holding ↑ fires only HT_BOTTOM plume; ↑+← fires HT_BOTTOM + HT_LEFT independently; existing CoMCalculator + FEEPMetals tests stay green |
| 2 | **`test-TargetRanking.js`** (gap [#12](#44-test-coverage-gaps)) | ~1h | Covers TPI formula, weight normalization, threat multiplier, MOID null fallback, sensor-tier scaling stub |
| 3 | **Extract `SpacecraftMaterials.js`** (opp [#16](#45-architecture-opportunities)) | ~1.5h | 4 materials exported; [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:1) and [`ArmUnit.js`](js/entities/ArmUnit.js:1) both import from it; no behaviour change |
| 4 | **Wire TPI into AutopilotSystem fallback** (opp [#18](#45-architecture-opportunities)) | ~30 min | AP's "nearest Tier 3/4" replaced with `getEnhancedTargetList()[0]`; AutopilotSystem tests still pass |
| 5 | **Extend `RENDER_ORDER` to 5 more modules** (opp [#17](#45-architecture-opportunities)) | ~2h | [`Earth.js`](js/scene/Earth.js:1), [`Starfield.js`](js/scene/Starfield.js:1), [`TrailSystem.js`](js/ui/TrailSystem.js:1), [`TargetReticle.js`](js/ui/TargetReticle.js:1), [`NavSphere.js`](js/ui/NavSphere.js:1), [`DockingReticle.js`](js/ui/DockingReticle.js:1) all reference the enum |
| 6 | **Teaching moment for rotation lock** (opp [#19](#45-architecture-opportunities) + emergent [#21](#46-emergent-product-opportunity)) | ~45 min | [`TeachingSystem.js`](js/systems/TeachingSystem.js:1) once-per-profile entry on first `COMMS_MESSAGE` with rotation-locked priority; bonus codex entry for spring-snap-back skill |
| 7 | **Dynamic `DIST_REF_KM` from sensor tier** (defer [#2](#41-silently-deferred-in-plan-not-implemented)) | ~30 min | TPI reference scales with `SENSOR_TIERS[tier].rangeKm × 0.7`; manual playtest confirms far targets stay competitive as player upgrades sensors |

### Dependencies

```
#1 setThrusterFire ─────────────────→ #6 teaching moment (visual reinforcement)
#2 test-TargetRanking ──┬────────────→ #4 TPI in AP
                        └────────────→ #7 dynamic DIST_REF_KM
#3 SpacecraftMaterials ─── (independent)
#5 RENDER_ORDER extend ─── (independent)
```

### Suggested ordering for next sprint

```
Day 1: #2 test-TargetRanking → #7 dynamic DIST_REF_KM → #4 TPI in AP
Day 2: #1 setThrusterFire → #6 teaching moment
Day 3: #3 SpacecraftMaterials → #5 RENDER_ORDER extend
```

---

## §6 Feature Flag Watch List

These flags are currently OFF but landed code in this sprint must behave correctly when they flip ON. **Audit before flipping.**

### 6.1 `TETHER_REEL`

**Risk.** [`getRotationLockTier()`](js/entities/ArmManager.js:1) checks `arm.state` + `arm.isDetached`, but does NOT consult [`TetherReel.js`](js/systems/TetherReel.js:1) state. An arm in STATION_KEEP with a CUT tether will still report tier `'block'` despite being physically severed.

**Fix when flipping.** Inside [`getRotationLockTier()`](js/entities/ArmManager.js:1) iteration loop, after the `isDetached` early-return, add:

```js
if (arm.tetherSevered === true) continue; // or arm.reelState === 'CUT'
```

**Test coverage.** Add `test-RotationLock.js` case: arm in REELING with `tetherSevered: true` → tier `'none'` (down from `'block'`).

### 6.2 `STOW_DEPLOY_STATE_MACHINE`

**Risk.** [`ArmUnit.deployState`](js/entities/ArmUnit.js:1) (LOCKED/STOWED/DEPLOYING/DEPLOYED/STOWING per ST-9.10) is independent of `arm.state` (LAUNCHING/TRANSIT/…). When the flag flips ON, a DOCKED arm in DEPLOYING transient = tier `'none'` per current logic. Physically correct (still inside the pocket) but could give the player a "free rotation" window during the swing animation.

**Fix when flipping.** Optional 4th tier `'warn'`: full rotation rate but a comms hint emitted at higher cooldown. Or: simply add DEPLOYING/STOWING to `_SOFT_ROT_STATES`.

**Test coverage.** Add `test-RotationLock.js` cases for each `deployState` × `armState` cross-product (5 × 22 = 110 cells — sample the 10-20 most likely combinations).

---

## §7 Files Modified This Sprint

### 7.1 Production code

| Issue | File | Change summary |
|---|---|---|
| 4 | [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js:1) | ROSA panel front/back split (FrontSide PV + BackSide Kapton with flipped-normal geometry clone), custom ShaderMaterial for grid (view-dot-normal discard), front emissive 0.25→0.15 |
| 4 | [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js:1) | Daughter ROSA panel front/back split (parity with mother) |
| 4 | [`sw.js`](sw.js:1) | Cache version bumped to v4 |
| 2 | [`js/entities/ArmManager.js`](js/entities/ArmManager.js:1) | New methods `hasTetheredArm()`, `getRotationLockTier()`; module-scope `_HIGH_RISK_ROT_STATES`, `_SOFT_ROT_STATES` sets |
| 2 | [`js/systems/InputManager.js`](js/systems/InputManager.js:1) | Exponential spring-resistance model in rotation block (lines ~1581-1595); AP-disengage guard widened to tier-aware (lines ~413-427); `_maybeEmitTetherLockMsg()` |
| 2 | [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js:1) | `armsActive` predicate replaced with `armManager.hasTetheredArm()` (was incomplete 4-state list) |
| 2 | [`js/core/Constants.js`](js/core/Constants.js:1) | New `TETHER_ROTATION` block (spring model: MAX_DISPLACEMENT_SOFT/BLOCK, STIFFNESS_EXPONENT, SPRINGBACK, COMMS_THROTTLE_MS) |
| 1 | [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js:1) | 50+ renderOrder annotations; pocket radius 1.006→1.012; pyro pin polygonOffset (-2.5); MLI bands 1.04→1.07; stowage channels 1.005→1.008; accent rings -1.5; FEEP nozzle upgrade (mounting boss + accelerator grid disc); collar ring triple-stack, sensor baseplate, laser viewport (was occluded by front cap!), strut rib ring, hinge cluster, docking port lights |
| 1 | [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js:1) | Daughter chassis renderOrders (parity with mother) |
| 1 | [`js/ui/MenuScene3D.js`](js/ui/MenuScene3D.js:1) | Menu spacecraft model renderOrder pass |
| 1 | [`js/core/Constants.js`](js/core/Constants.js:1) | New `RENDER_ORDER` 6-tier enum |
| 3 | [`js/entities/DebrisField.js`](js/entities/DebrisField.js:1) | `getEnhancedTargetList`: TPI computation + MOID badge propagation + descending sort; `getTargetList` (route planner) preserved on ΔV sort |
| 3 | [`js/ui/hud/TargetPanel.js`](js/ui/hud/TargetPanel.js:1) | 4-way sort cycle (TPI/ΔV/Dist/Pts), default 'tpi', MOID badge rendering in row |
| 3 | [`js/core/Constants.js`](js/core/Constants.js:1) | New `TARGET_RANKING` block (weights, references, MOID_THREAT_MAP) |
| 3 | [`js/systems/InputManager.js`](js/systems/InputManager.js:1) | Tab cycling uses TPI-sorted list (no change to call site — `getEnhancedTargetList` now returns TPI-sorted by default) |

### 7.2 Tests

| File | Suites | Tests | Coverage |
|---|---|---|---|
| [`js/test/test-RotationLock.js`](js/test/test-RotationLock.js:1) **NEW** | 7 | 44 | All ARM_STATES tier mapping, isDetached override, multi-arm escalation, hasTetheredArm() edge cases, constant sanity |
| [`js/test/run-tests.js`](js/test/run-tests.js:1) | — | — | Imports new test file |

**Test count delta:** 2320 → **2364** (+44).

---

## §8 Locked Product Principles (2026-04-25 — Non-Negotiable)

### 8.1 Offline-First — No Auto-Fetch

The game **plays great offline and stays offline**. No background HTTP requests. No live TLE feeds. No telemetry.

- **News-driven content** enters via manual edits to [`data/news-events.json`](data/news-events.json) — user-driven, not API-driven.
- Optional Codex links to NASA/Celestrak open in user-clicked new tabs; never automatic.
- 2026-05-17 switched the importmap to local `node_modules/three` for offline boot.

**Live TLE feeds, auto-fetch APIs, and online sync features are explicitly OFF the roadmap.**

### 8.2 Dual-Metal FEEP Is Y0 Baseline (TRL 7–8)

Multimetal FEEP thrusters are **flight-demonstrated today** (Enpulsion IFM Nano series, 2024–2025). The V5 daughter arm ships from factory with a dual-metal FEEP capable of running indium (default) OR a Forge-refined alternative metal cartridge.

- **Y0 baseline:** indium + 1 alt slot
- **Y1 unlock:** iodine, bismuth (TRL 6–7)
- **Y2 unlock:** mercury, cesium (TRL 5)
- **Y4 endgame:** tungsten + MPD-class power (TRL 4)

See [`DAUGHTER_ARM_CONTROLS.md §5`](DAUGHTER_ARM_CONTROLS.md:1) and [`GAME_FLOW_BRAINSTORM.md §7.2`](GAME_FLOW_BRAINSTORM.md:1).

### 8.3 Mother Launches from India — ISRO Heritage

The V5 mothership launches on a cost-optimised ISRO LVM3 / SSLV mission. Indian Mission Operations are part of the comms loop alongside Houston.

- **Launch sites:** Satish Dhawan Space Centre (Sriharikota) and Kulasekarapattinam Spaceport (Tamil Nadu).
- **Comms personas:** **BANGALORE** (ISTRAC) for mission-critical ops, **HASSAN** (MCF) for GEO operations. **Houston** retained for US-side context.

Implementation in [`data/ground-stations.json`](data/ground-stations.json) and [`CommsSystem.js`](js/systems/CommsSystem.js:1).

---

## §9 THREE.js Convention SSOT (load-bearing)

> **READ BEFORE TOUCHING ANY ORIENTATION / ROTATION / VISIBILITY CODE.** Carried forward from prior shift. A single-character convention bug at [`CaptureNetVisual.js:952`](js/ui/CaptureNetVisual.js:952) made the capture-net cinch render on the DAUGHTER side of the debris for the entire life of the ceremony visual. Multiple sessions worked AROUND the bug without seeing it because every prior test inspected only LOCAL coordinates — never `getWorldPosition()`. **The Issue 4 ROSA fix this sprint hit the SAME class of bug** (DoubleSide hiding back-face semantics until the ship inverted): the panel-back appeared as a "shadow on Earth" because the back-face material was a single material doing double duty. Pattern repeats.

### Rule 1 — `Object3D.lookAt` and `Camera.lookAt` use OPPOSITE conventions

| Receiver type | After `obj.lookAt(target)`, local **forward** axis is... |
|---|---|
| `Camera`, `Light` | local **−Z** points TOWARD `target` (OpenGL camera convention) |
| `Object3D`, `Group`, `Mesh` | local **+Z** points TOWARD `target` |

**Pre-flight checklist before calling `.lookAt(point)`:**
1. Is the receiver a `Camera`/`Light`? Local −Z = "forward" (faces target).
2. Is the receiver a `Group`/`Mesh`? Local **+Z** = "forward" (faces target).
3. Does your geometry's "front face" axis match the receiver's convention?
4. If a Group must have its **mouth on local −Z**, pass `lookAt(position − dir × ε)` — NOT `+`.

### Rule 2 — `Matrix4.lookAt(eye, target, up)` — z = `eye − target`

When you build rotation manually with `mat.lookAt(eye, target, up)` and apply via `quaternion.setFromRotationMatrix`:
- The matrix's local **+Z** in world = `(eye − target).normalize()` ⇒ points AWAY from `target`, TOWARD `eye`.
- `local +Z = forward` is **always** the convention for the resulting quaternion (receiver-type branching is `Object3D.lookAt`-only, not `Matrix4.lookAt`).

**When using `Matrix4.lookAt` directly: declare what your mesh's "default forward" axis is (named constant), and pass eye/target in the order that aligns matrix +Z with that intent.**

### Rule 3 — Scene units: `M = 1e-5` everywhere

- **1 metre** = `M = 1e-5` scene units. **1 scene unit** = **100 km**.
- Entity `position` fields (`NetProjectile.position`, `ArmUnit.position`, `_scenePosition`, `target._scenePosition`) are in **metres**.
- Object3D `position` (`mesh.position`, `group.position`) is in **scene units**.
- The conversion happens at the boundary: `group.position.set(net.position.x * M, ...)`.
- If you see an unexpected `1e+5` or `* M` factor, suspect a unit-frame mismatch.

### Rule 4 — Default geometry axes & how to align them

| Geometry | Default symmetry axis | To align with launchDir / forward |
|---|---|---|
| `ConeGeometry(r, h)` | Y (apex at +Y, base at −Y) | `geo.rotateX(PI/2)` ⇒ apex at +Z, base at −Z |
| `CylinderGeometry(r1, r2, h)` | Y | `geo.rotateX(PI/2)` ⇒ axis along Z |
| `TorusGeometry(r, t)` | normal = +Z (ring in XY plane) | typically no rotation |
| `PlaneGeometry(w, h)` | normal = +Z | no rotation for billboarded sprites |
| `ShapeGeometry(shape)` | normal = +Z | **single face range — cannot split into front/back via material groups; use two coincident meshes (Issue 4 pattern)** |

`geo.rotateX(PI/2)` and `geo.translate(x, y, z)` mutate the GEOMETRY (vertex positions) — applied once at construction. The Object3D's `.rotateX(angle)` rotates the OBJECT (frame-relative).

### Rule 5 — Quaternion setters: always with named source/target constants

Use module-scope const vectors:

```js
const _armForward  = new THREE.Vector3(0, 0, 1);  // PlayerSatellite.js:40
const _strutFrom   = new THREE.Vector3(0, -1, 0); // PlayerSatellite.js:33
const _yUpCollar   = new THREE.Vector3(0, 1, 0);  // PlayerSatellite.js:521
```

Then `_armQuat.setFromUnitVectors(_armForward, sg.strutDir)` reads as "rotate the arm's local +Z forward to point along strut direction." Self-documenting. **Don't inline raw `new THREE.Vector3(0, 0, 1)` calls.**

### Rule 6 (NEW this sprint) — RENDER_ORDER is the deterministic tiebreaker

`polygonOffset` is a finer-grained tool but cannot order across transparency passes and varies across GPUs. **Every mesh in a spacecraft hierarchy MUST declare a `renderOrder` from the [`RENDER_ORDER`](js/core/Constants.js:1) enum.** The 6-tier convention:

```
EARTH=0  →  SPACECRAFT_OPAQUE=1  →  DETAIL=2  →  TRANSPARENT=3  →  ADDITIVE=4  →  HUD=10
```

Within the same renderOrder, Three.js sorts opaque front-to-back automatically; renderOrder is the explicit override for z-fight tiebreaking AND the only way to order Additive transparency.

### Rule 7 (NEW this sprint) — GL_LINES has no face culling

If your wireframe must hide on back-facing surfaces (e.g., to avoid back-side grid bleeding through a panel-back substrate), `BufferGeometry` + `LineSegments` with `side: FrontSide` does **not** cull — GL_LINES primitives have no face. Solution: **custom ShaderMaterial with view-dot-normal discard at the fragment level** (Issue 4 implementation in [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:1) and [`ArmUnit.js`](js/entities/ArmUnit.js:1)).

### Diagnostic workflow (re-usable)

1. Add `globalThis.<FLAG>`-gated `console.log` at suspected frame-conversion sites.
2. Enable: `globalThis.<FLAG> = true`. Capture log.
3. Compare predicted vs observed values — look for sign flips, magnitude mismatches, unit-scale errors.
4. Locate conversion site producing wrong sign/magnitude. Apply fix.
5. **Mutation-test the regression:** revert fix, run tests, confirm they FAIL with localized error. Re-apply.
6. Remove ALL instrumentation. Grep-clean.
7. Add SSOT note here if a new convention is established.

---

## §10 Post-Cinch-Fix Learnings (load-bearing)

*Companion SSOT to §9. Captured during the post-cinch QA shift; reinforced by this sprint.*

### Rule A — Hotkey rebinding requires ≥ 6 sites of audit

1. [`InputManager.js`](js/systems/InputManager.js:1) handler (the binding itself)
2. [`Constants.js`](js/core/Constants.js:1) SkillsSystem definitions (`SKILLS.*.key`)
3. [`StatusPanel.js`](js/ui/hud/StatusPanel.js:1) inline HUD labels
4. [`StatusPanel.js`](js/ui/hud/StatusPanel.js:1) idle-state hints
5. Module-level docstrings in the affected system
6. [`README.md`](README.md:1) — controls summary AND systems paragraph AND key-bindings table (3 sites in README alone)

### Rule B — When extending FSM-state coverage, audit ALL conditional blocks for that FSM

```js
// AVOID — easy to forget one state when adding a new state:
if (state === A || state === B || ...) { /* sync */ }

// PREFER — canonical set lookup, single source of truth:
if (POST_FLIGHT_STATES.has(state)) { /* sync */ }
```

**This sprint's Issue 2 fix is the textbook application** — `_HIGH_RISK_ROT_STATES` and `_SOFT_ROT_STATES` sets in [`ArmManager.js`](js/entities/ArmManager.js:1), with `getRotationLockTier()` and `hasTetheredArm()` as the named predicates. The bonus AutopilotSystem `armsActive` fix is the *third* discovered inline-state-list bug this codebase has shipped.

### Rule C — Visual geometry constants couple to camera offsets

Bumping a geometry constant (e.g., `CONE_LENGTH_FRAC`) requires matching updates at all hard-coded sites in [`CameraSystem.js`](js/systems/CameraSystem.js:1). Either (a) read the constant lazily in the lookAt function, or (b) bullet-comment the coupling at BOTH ends.

### Rule D — LOD guards must enumerate all "actively engaged" debris states

Any "user is engaged with this debris" predicate must be a function over multiple flags, not a single field. Future variants — debris-being-trawled, ablated, lassoed — will need adding. Candidate refactor: `_isUserEngaged(debris)` helper that ORs all relevant flags.

### Rule E — Empty-action feedback needs all 3 components

1. The gameplay event (e.g. [`Events.NET_EMPTY_CLICK`](js/core/Events.js:1))
2. The audio cue ([`audioSystem.playClickFail()`](js/systems/AudioSystem.js:1))
3. The on-screen comms message ([`Events.COMMS_MESSAGE`](js/core/Events.js:1) warning)

This sprint's Issue 2 rotation-blocked feedback applied this pattern (comms warning when blocked).

### Rule F (NEW this sprint) — Spring/exponential models need a release path

A novel "spring resistance" gameplay mechanic was added to InputManager's rotation block. The model needs *both* an opposing force (resistance) AND a release/recovery path (springback). Both were implemented. Test: holding arrows builds displacement; releasing arrows triggers springback to zero. **The springback creates emergent skill-based depth** (see [`§4.6 emergent #21`](#46-emergent-product-opportunity)).

### Cross-rule diagnostic workflow

When the user reports a visual symptom (e.g. "X is invisible during state Y" or "X reads as a shadow"), walk the visual pipeline:

1. **Position** — being POSITIONED correctly? (FSM-state position sync — Rule B)
2. **Scale** — being SCALED correctly? (LOD downscale — Rule D)
3. **Lifecycle** — being REMOVED prematurely? (state-transition cleanup)
4. **Material/Face** — back face vs front face, DoubleSide hiding semantics? (Issue 4 this sprint)
5. **Camera framing** — is the CAMERA actually showing it? (offsets + lookAt — Rule C)
6. **Feedback** — user expected feedback but got none? (empty-action 3-component — Rule E)

The "panel renders as shadow on Earth when inverted" symptom (Issue 4) collapsed into a step-4 root cause: the DoubleSide material was painting the back face with the front material's dark colour. Walking the pipeline from position → scale → material identified it.

---

## §11 Key Architectural Learnings & Gotchas

These are **load-bearing** rules. Violating them silently breaks physics without triggering any existing test.

### 11.1 Y-up (Three.js) vs Z-up (ECI) — the axis convention trap

The scene frame uses **Three.js Y-up**. Classical orbital-mechanics textbooks use **ECI Z-up**. The original [`orbitToSceneCartesian()`](js/entities/OrbitalMechanics.js:469) was Y-up. The inverse [`cartesianToKeplerian()`](js/entities/OrbitalMechanics.js:129) was Z-up. The swap `y↔z` makes them a faithful round-trip.

- **Rule.** Any NEW code that round-trips `(position, velocity) → elements → (position, velocity)` MUST call the corrected function.
- **Guard test** — [`test-OrbitalMechanics.js:164`](js/test/test-OrbitalMechanics.js:164).

### 11.2 `TIME_SCALE_GAMEPLAY` (10×) — the silent multiplier

[`Constants.TIME_SCALE_GAMEPLAY`](js/core/Constants.js:1) scales orbital propagation so one real second advances orbits ~10 s. Any physics quantity that is "per tick" must account for this or be **10× too small**.

**Rule.** Grep: `regex: TIME_SCALE_GAMEPLAY|gameDt`. Any physics loop computing impulses/velocities in m/s AND using `dt` (not `gameDt`) is suspect.

### 11.3 `_applyThrust()` vs `applyCartesianImpulse()` — when to use which

| API | Semantics | Use from |
|---|---|---|
| [`PlayerSatellite._applyThrust()`](js/entities/PlayerSatellite.js:2125) | Treats `(x, y, z)` as orbital-element rate channels: `x→Δe`, `y→Δi`, `z→Δa`. | Player input (`thrustIon`, RCS) — legacy contract |
| [`PlayerSatellite.applyCartesianImpulse(dvWorld, dt)`](js/entities/PlayerSatellite.js:2145) | Cartesian world-frame ΔV (m/s). Full round-trip via `cartesianToKeplerian`. | Autopilot, any new physically-consistent controller |

### 11.4 Collision-Avoidance exemption — two axes

[`CollisionAvoidanceSystem`](js/systems/CollisionAvoidanceSystem.js:1) maintains TWO exempt IDs: `_activeTargetId` (Tab-selection) and `_autopilotLockId` (autopilot lock event). **Any new "pursuit" system emits a LOCK event so CA stops fighting you.**

### 11.5 Test-stub blindness

**Stubs hide bugs.** Prefer integration tests over stubs. Factor-of-10 error? Suspect `TIME_SCALE_GAMEPLAY`. 90°/180° error? Suspect a local-to-world transform missing.

### 11.6 Scene-unit scale `M = 1e-5`

`M = 0.00001` = "1 metre in scene units" (scene unit = 100 km). Collisions have occurred. **Distances in metres in Constants; multiply by `M` at the boundary.**

### 11.7 Wiring-gap pattern (2026-05-17)

A system class can be imported in `main.js` and have full `init()` / `update(dt)` methods, but if `main.js` doesn't actually CALL them, the system is **silently dead**. Tests pass because they instantiate modules directly; the bug is browser-only.

**Confirmed orphaned wiring (still pending):** [`TetherReel.js`](js/systems/TetherReel.js:1), [`BridleRing.js`](js/entities/BridleRing.js:1) — neither imported nor init'd/update'd in [`main.js`](js/main.js:1). See [`DAUGHTER_RETRIEVAL_AUDIT.md §4`](DAUGHTER_RETRIEVAL_AUDIT.md:1).

**Rule.** Add `test-main-wiring.js` smoke test that asserts every system imported in `main.js` has `init()` OR `update()` called at least once during a mock boot cycle.

### 11.8 Inline ARM_STATES checks — three known bugs, two remain

**Pattern:** code that enumerates a subset of `ARM_STATES` inline with `||` chains is a recurring source of bugs. Three known cases:

1. ✅ **AutopilotSystem `armsActive`** — fixed this sprint; now uses `armManager.hasTetheredArm()`.
2. ⚠️ **AutopilotSystem inline list at line ~697** — still inline. Different semantic from `hasTetheredArm()` (it checks "active maneuver" not "tethered"); needs a separate named predicate.
3. ⚠️ **RadialMenu inline check at line ~306** — still inline. Probably can adopt `hasTetheredArm()` directly.

**Rule.** Any inline `state === A || state === B || ...` over ARM_STATES is a code smell; promote to a named predicate on `ArmManager`.

---

## §12 Project State Summary

### 12.1 What the game is

Browser-based orbital-debris-capture sim. The player pilots a V5 Crossbow mothership in LEO, finds & analyses tracked debris, flies the autopilot into a trailing rendezvous, then captures via Capture Net, Spinner/Weaver crossbow arms, or the Trawl sweep. Salvage refines into fuel/parts; a Skills Discovery system surfaces 33 gameplay techniques organically. The game teaches real aerospace concepts through play.

Core identity is **Jellyfish Fisherman** ([`GAME_DESIGN.md §2`](GAME_DESIGN.md:1)). ΔV is the master resource.

### 12.2 Tech stack

| Layer | Choice |
|---|---|
| Rendering | [`three@^0.170`](package.json:1) (WebGL, no engine) |
| Language | ES Modules, no bundler (native `<script type="module">`) |
| Server | Python `http.server` on port 8081 via [`start.sh`](start.sh:1) |
| Tests | Node-based harness, no browser; see [`js/test/TestRunner.js`](js/test/TestRunner.js:1) |

### 12.3 Test suite status

**556 suites / 2364 tests / 0 failures** as of 2026-05-30. Harness uses the real `three` runtime (not stubbed) for physics tests.

### 12.4 Systems & maturity

| System | File | Maturity |
|---|---|---|
| OrbitalMechanics | [`OrbitalMechanics.js`](js/entities/OrbitalMechanics.js:1) | Stable |
| PlayerSatellite | [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:1) | Stable — Config G + 2026-05-30 renderOrder pass + ROSA front/back |
| ArmManager / ArmUnit | [`ArmManager.js`](js/entities/ArmManager.js:1), [`ArmUnit.js`](js/entities/ArmUnit.js:1) | Stable — 2026-05-30 added canonical state predicates + daughter ROSA front/back |
| AutopilotSystem | [`AutopilotSystem.js`](js/systems/AutopilotSystem.js:1) | Stable — `armsActive` adopts `hasTetheredArm()` 2026-05-30 |
| InputManager | [`InputManager.js`](js/systems/InputManager.js:1) | Stable — spring-resistance rotation model 2026-05-30 |
| DebrisField | [`DebrisField.js`](js/entities/DebrisField.js:1) | Stable — TPI ranking 2026-05-30. 2093 LOC (split candidate) |
| TargetPanel | [`TargetPanel.js`](js/ui/hud/TargetPanel.js:1) | Stable — 4-way sort + MOID badges 2026-05-30 |
| CollisionAvoidance | [`CollisionAvoidanceSystem.js`](js/systems/CollisionAvoidanceSystem.js:1) | Stable |
| LassoSystem | [`LassoSystem.js`](js/systems/LassoSystem.js:1) | OK but slow — §4 backlog (was in prior shift) |
| CaptureNet + CaptureNetVisual | [`CaptureNet.js`](js/entities/CaptureNet.js:1), [`CaptureNetVisual.js`](js/ui/CaptureNetVisual.js:1) | Stable — Q2 ceremony shipped |
| ConjunctionSystem | [`ConjunctionSystem.js`](js/systems/ConjunctionSystem.js:1) | OK — MOID badges now consumed by TPI |
| TrawlManager | [`TrawlManager.js`](js/systems/TrawlManager.js:1) | OK |
| SkillsSystem / SkillsPane | [`SkillsSystem.js`](js/systems/SkillsSystem.js:1), [`SkillsPane.js`](js/ui/hud/SkillsPane.js:1) | Functional. 1869 LOC (split candidate) |
| ForgeSystem | [`ForgeSystem.js`](js/systems/ForgeSystem.js:1) | OK |
| TeachingSystem | [`TeachingSystem.js`](js/systems/TeachingSystem.js:1) | Functional — see §5 #6 next-step opportunity |

---

## §13 Active Docs Index

### 🟢 Canonical (6) — read first

| Doc | Purpose |
|---|---|
| [`README.md`](README.md:1) | Entry point, quick start, controls |
| [`HANDOFF.md`](HANDOFF.md:1) | **This file** — current shift, gotchas, next steps |
| [`GAME_DESIGN.md`](GAME_DESIGN.md:1) | Design vision — core loop, jellyfish identity, ΔV economy |
| [`ARCHITECTURE.md`](ARCHITECTURE.md:1) | As-built technical reference (⚠️ Epic 9/10 update pending) |
| [`BIG_PICTURE.md`](BIG_PICTURE.md:1) | 12-month strategic roadmap |
| [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md:1) | Sprint tracker — Sprints 1–4, Epics 5–10 + 2026-05-30 sprint |

### 🟡 Active references — read when touching their area

[`ARM_PIVOT_ANALYSIS.md`](ARM_PIVOT_ANALYSIS.md:1), [`CAPTURE_NET.md`](CAPTURE_NET.md:1), [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md:1), [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md:1), [`DAUGHTER_MULTITOOL_SPEC.md`](DAUGHTER_MULTITOOL_SPEC.md:1), [`DAUGHTER_RETRIEVAL_AUDIT.md`](DAUGHTER_RETRIEVAL_AUDIT.md:1), [`FIRST_EXPERIENCE.md`](FIRST_EXPERIENCE.md:1), [`GAME_FLOW_BRAINSTORM.md`](GAME_FLOW_BRAINSTORM.md:1), [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md:1), [`SKILLS_ARCHITECTURE.md`](SKILLS_ARCHITECTURE.md:1).

### 🟠 Archives

[`archive/FIX_PLAN.md`](archive/FIX_PLAN.md:1) (this sprint), [`archive/HANDOFF_2026-05-29_post-cinch-qa.md`](archive/HANDOFF_2026-05-29_post-cinch-qa.md:1) (prior shift), and the rest under [`archive/`](archive/).

---

## §14 Heritage — Prior Work Summaries

### 14.1 Post-Cinch QA Pass + Doc Consolidation (2026-05-28/29, COMPLETE)

9 of 11 QA items resolved (cinch ring leading edge, net visibility during REELING, captured-debris LOD skip, reticle range font 2×, empty-net comms, R=reel + K=forge hotkey swap, spin-rate physics doc). Items 6/10/11 design content folded into [`GAME_DESIGN.md`](GAME_DESIGN.md:1). Tests +4, 2316→2320. Doc consolidation pass: 35 root .md → 16 canonical+active. Full write-up at [`archive/HANDOFF_2026-05-29_post-cinch-qa.md`](archive/HANDOFF_2026-05-29_post-cinch-qa.md:1).

### 14.2 Q2 Net-Launch Ceremony (2026-05-24, SHIPPED)

[`FEATURE_FLAGS.NET_CEREMONY`](js/core/Constants.js:1) default ON. 6 stages, [`NET_CINEMATIC`](js/systems/CameraSystem.js:1) camera mode with 7 beats / 3 beats on repeat. Tests 2207→2281 (+74). Full spec: [`archive/CEREMONY_REDESIGN.md`](archive/CEREMONY_REDESIGN.md:1).

### 14.3 Epic 10 — Config G Full Visualization (2026-05-08, COMPLETE)

V3 Octopus replaced with Config G: cylindrical barrel, collar-mounted struts, ROSA roll-out panels, FEEP nozzle polish, deploy-state LEDs, full stowage visual, launch cinematic, capture net visual, tier progression visual. 11 V-tasks delivered. Spacecraft anatomy: Barrel (0.4m R × 2.0m H) + Collar (Z=+0.90m, 4 hinge brackets at 60°/120°/240°/300°) + Struts (1.60m, sweep 0–180°) + ROSA panels. Archive specs in [`archive/EPIC10_VISUALIZATION_PLAN.md`](archive/EPIC10_VISUALIZATION_PLAN.md:1), [`archive/BIG_PICTURE_EPIC_5_6_HISTORY.md`](archive/BIG_PICTURE_EPIC_5_6_HISTORY.md:1).

### 14.4 Epic 9 — Config G Arm System (2026-04-28, COMPLETE)

All 11 C-tasks delivered. Mass budget canonical: Y0 dry = 196.4 kg, wet = 242.4 kg. **25 feature flags** (11 new), **~25 new events**.

### 14.5 Epic 8 — Daughter-Arm Redesign + Dual-Metal FEEP + ISRO Heritage (2026-04-25, COMPLETE)

5 sprints, ~6 dev days. STATION_KEEP state, orbital-crane controls, dual-metal FEEP (7 metals), news-driven missions, ISRO comms personas (BANGALORE/HASSAN), ReputationSystem. Sets up Locked Principle #3.

### 14.6 SK / Mission-1 Polish (2026-05-16) + Daughter SK Wiring (2026-05-17)

SK standoff zoom, sonar-ping restoration, mother AP HOLD suppression, M1 2 km debris cull, SkillsPane visibility gating. **Biggest lesson:** A backtick inside a template literal broke the browser silently — `node --check <file>` catches this; the test runner does not. Salvage state chain (capture path): `STATION_KEEP --F--> NETTING --(net.CAPTURED)--> GRAPPLED --(stabilize 1.5s)--> REELING --(reach mother)--> DOCKING --> RELOADING --> DOCKED`. See [`archive/SK_M1_POLISH_HANDOFF.md`](archive/SK_M1_POLISH_HANDOFF.md:1).

### 14.7 Sessions S19–S30 — Autopilot Rewrite + Trail System

See [`archive/HANDOFF_AUTOPILOT_RETRO.md`](archive/HANDOFF_AUTOPILOT_RETRO.md:1).

---

## §15 Convention Reference Card (quick lookup)

| Rule | Source | TL;DR |
|---|---|---|
| Object3D vs Camera lookAt | §9 Rule 1 | Camera: −Z forward; Group/Mesh: +Z forward |
| Matrix4 lookAt sign | §9 Rule 2 | `mat.lookAt(eye, target, up)` ⇒ local +Z = `eye − target` |
| Scene units | §9 Rule 3 + §11.6 | `M = 1e-5` (metres → scene units). Entity `.position` in metres; Object3D `.position` in scene units |
| Geometry default axes | §9 Rule 4 | Cone/Cylinder: Y-axis → `geo.rotateX(PI/2)` for Z-aligned; ShapeGeometry single face range → use two coincident meshes for front/back |
| Quaternion sources | §9 Rule 5 | Use named module-scope const vectors |
| RENDER_ORDER | §9 Rule 6 (**NEW**) | Every spacecraft mesh declares `renderOrder` from the 6-tier enum |
| GL_LINES face culling | §9 Rule 7 (**NEW**) | No face culling on line primitives; use ShaderMaterial view-dot-normal discard |
| Hotkey audit | §10 Rule A | 6 sites: InputManager + Constants + 2× StatusPanel + system docstring + README (×3) |
| FSM state lookup | §10 Rule B | Use `Set.has(state)` not `||` chains |
| Visual ↔ camera coupling | §10 Rule C | Geometry constants and camera offsets must reference each other in comments |
| LOD predicate | §10 Rule D | `_isUserEngaged(debris)` ORs all engagement flags |
| Empty-action feedback | §10 Rule E | (event, audio, comms) — all three or it feels broken |
| Spring/exponential models | §10 Rule F (**NEW**) | Resistance + release/recovery path; release behaviour creates emergent skill depth |
| Y-up vs Z-up | §11.1 | Three.js Y-up; orbital textbooks Z-up; round-trip needs `y↔z` swap |
| `gameDt` vs `dt` | §11.2 | `gameDt = dt × TIME_SCALE_GAMEPLAY` (10×). Physics-per-tick MUST use `gameDt` |
| AP impulse API | §11.3 | `_applyThrust` = element rates (legacy); `applyCartesianImpulse` = world-frame ΔV (modern) |
| CA exemption | §11.4 | Both `_activeTargetId` and `_autopilotLockId` must be set |
| Wiring-gap | §11.7 | A system imported in `main.js` is silently dead if `init()`/`update()` never called |
| Inline ARM_STATES | §11.8 (**NEW**) | Three known bugs from this anti-pattern; promote to named predicate on ArmManager |

---

*End of HANDOFF.md (2026-05-30 rewrite). Current sprint: 4-fix architectural pass complete. Next sprint: see [`§5`](#5-recommended-next-steps).*
