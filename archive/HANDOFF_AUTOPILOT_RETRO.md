# Handoff §2 — Recently Completed Work (Archived)

> **Archived:** 2026-04-25. This is the verbatim content of §2 "Recently Completed Work" from [`HANDOFF.md`](../HANDOFF.md) as of the Epic 5/6 + Autopilot rewrite era (Sessions 19–30). Archived to keep HANDOFF.md lean for the Epic 8 shift.
>
> Return to active document: [`HANDOFF.md §3`](../HANDOFF.md#3-key-architectural-learnings--gotchas)

---

## 2. Recently Completed Work

### 2.1 Autopilot Trailing-Rendezvous Rewrite (this shift — Sessions 28–30)

Problem statement is fully documented in [`AUTOPILOT_ANALYSIS.md`](AUTOPILOT_ANALYSIS.md) — §A current behavior, §B 10 issues, §C desired behavior, §D implementation plan, §E risks. **Three implementation retrospectives** are appended to that file, one per debugging session.

#### Controller redesign

Replaced the old single-phase proportional-only controller with a **4-phase state machine**:

```
engage → RENDEZVOUS_FAR → MATCH_ORBIT → TRAIL_ALIGN → HOLD
```

Goal pose is the **trailing-rendezvous point** behind the debris along its velocity vector:
```
P_m* = P_d − v̂_d · D_trail          V_m* = V_d          +Z_m* = v̂_d
```
with tool-aware `D_trail` ∈ { lasso 120 m, arm 35 m, trawl 150 m, default 80 m } — see [`Constants.js:907-937`](../js/core/Constants.js:907) `AUTOPILOT` block (14 tuned knobs).

#### Three bugs found and fixed

| # | Bug | File / line | Symptom | Fix |
|---|---|---|---|---|
| **1** | **Y↔Z axis mismatch** in [`cartesianToKeplerian()`](../js/entities/OrbitalMechanics.js:129) — function used textbook Z-up ECI convention while the rest of the codebase is Y-up Three.js | [`OrbitalMechanics.js:129`](../js/entities/OrbitalMechanics.js:129) | First code path to round-trip elements was [`applyCartesianImpulse()`](../js/entities/PlayerSatellite.js:2145); resulting ship jumped **~1,450 km in one tick** | Swap `y↔z` on input + fall back to circular-orbit reconstruction when `e<1e-6`. Round-trip guard test in [`test-OrbitalMechanics.js:164`](../js/test/test-OrbitalMechanics.js:164). |
| **2** | **Proportional-only control law** — no predictive braking | Old [`AutopilotSystem.js`](../js/systems/AutopilotSystem.js) body | Ship built up 40–120 m/s closing velocity from ≥500 m engage distance and could not stop it; overshot hundreds of metres | **Quadratic braking profile** `v*(r) = min(V_CAP, √(2·A_BRAKE·r))` with `A_BRAKE = MAX_ACCEL · BRAKE_FRACTION`; commanded `ΔV = KP_VEL·(v*·goalDir + relV_mps)` clamped to `MAX_ACCEL·dt`. See [`Constants.js:924-936`](../js/core/Constants.js:924). |
| **3** | **`TIME_SCALE_GAMEPLAY` (10×) not applied to impulse clamp** | [`AutopilotSystem.js`](../js/systems/AutopilotSystem.js) | Controller had **1/10th** of the braking authority it mathematically assumed | `maxDv = MAX_ACCEL · dt · TIME_SCALE_GAMEPLAY`; dead-band coast in HOLD; hysteresis widened to **4× POS_TOL**. |

#### Files modified

| File | Change |
|---|---|
| [`js/systems/AutopilotSystem.js`](../js/systems/AutopilotSystem.js) | Full rewrite — 4-phase state machine, lock emit/clear, retrospective docs inline |
| [`js/entities/PlayerSatellite.js:2145`](../js/entities/PlayerSatellite.js:2145) | New [`applyCartesianImpulse(dvWorld, dt)`](../js/entities/PlayerSatellite.js:2145) — exact Cartesian round-trip |
| [`js/entities/OrbitalMechanics.js:129`](../js/entities/OrbitalMechanics.js:129) | Y↔Z axis-swap fix + circular-orbit fallback |
| [`js/core/Constants.js:902`](../js/core/Constants.js:902) | New `AUTOPILOT` block — 14 tunable knobs |
| [`js/core/Events.js:281`](../js/core/Events.js:281) | New events: `AUTOPILOT_TARGET_LOCK`, `_UNLOCK`, `_PHASE_CHANGE`, `_ON_STATION`, `_REENGAGE` |
| [`js/systems/CollisionAvoidanceSystem.js`](../js/systems/CollisionAvoidanceSystem.js) | Exempts locked debris even without `TARGET_SELECTED` |
| [`js/ui/hud/StatusPanel.js:820`](../js/ui/hud/StatusPanel.js:820) | AP chip shows phase + range + closure |
| [`js/ui/HUD.js:754`](../js/ui/HUD.js:754), [`js/main.js:554`](../js/main.js:554) | HUD wiring |
| [`js/test/test-AutopilotSystem.js`](../js/test/test-AutopilotSystem.js) | **NEW** — 31 tests |
| [`js/test/test-OrbitalMechanics.js:164`](../js/test/test-OrbitalMechanics.js:164) | Round-trip guard |

**Test delta:** 353 → **385 pass / 0 fail**, +32 tests.

### 2.2 ST-5.2 Trail System — FAILED, disabled (this shift)

**Goal:** I-War-heritage 3D world-space ribbon/line trails showing player trajectory colored by velocity direction (prograde=green, retrograde=red, radial=amber).

**What was built (all wiring in place, `ENABLED: false`):**
- [`js/ui/TrailSystem.js`](../js/ui/TrailSystem.js) — NEW (545 LOC). Ring-buffer sample storage, `THREE.Line` with per-vertex RGBA `ShaderMaterial`, arm trail lifecycle (reel-in trim, dock/reload clear).
- [`js/entities/PlayerSatellite.js:1098`](../js/entities/PlayerSatellite.js:1098) — 10 Hz `PLAYER_TRAIL_SAMPLE` emitter gated by `Constants.TRAILS.ENABLED`.
- [`js/entities/ArmUnit.js:1038`](../js/entities/ArmUnit.js:1038) — 10 Hz `ARM_TRAIL_SAMPLE` emitter + `ARM_TRAIL_CLEAR` on dock/reload.
- [`js/main.js:251`](../js/main.js:251) — TrailSystem instantiation + `update(dt)` in game loop.
- [`js/core/Constants.js:1275`](../js/core/Constants.js:1275) — Full `TRAILS` namespace (16 tuning knobs).
- [`js/core/Events.js`](../js/core/Events.js) — 3 new events: `PLAYER_TRAIL_SAMPLE`, `ARM_TRAIL_SAMPLE`, `ARM_TRAIL_CLEAR`.
- [`js/test/test-TrailSystem.js`](../js/test/test-TrailSystem.js) — NEW (464 LOC). 54 tests for pure helpers + constants/events validation.

**What failed and why:**

| Attempt | Approach | Result |
|---|---|---|
| 1 | `THREE.Mesh` with indexed triangle-strip ribbon (2 verts/sample) + `ShaderMaterial` | **Flashing green bars** across bottom of screen. Degenerate triangles from near-identical consecutive samples during passive orbit. Ribbon width (even at 5m) visible as thick bars at orbital camera distance. |
| 2 | Thrust-gated emission via `_thrustActiveThisFrame` flag in `_applyThrust()` | **Trail invisible.** Autopilot uses `applyCartesianImpulse()` which bypasses `thrustInput` entirely — flag never set for primary mothership thrust path. |
| 3 | Flag set in both `_applyThrust()` and `applyCartesianImpulse()` | **Still invisible.** Multiple early-return guards in `applyCartesianImpulse()` exit before flag set. Game loop timing: `_applyThrust()` runs first in `update()` and overwrites flag. |
| 4 | `THREE.Line` (line strip, 1 vert/sample) replacing ribbon mesh | **Thin vertical green line flicker.** WebGL `THREE.Line` renders at 1px regardless of `linewidth` (macOS/Chrome limitation). At orbital scale (~66 scene units from origin) the 1px line is sub-pixel, barely visible, and flickers due to aliasing. |
| 5 | Visibility gated by `THRUST_VISUAL` event | **Still invisible.** Event-based visibility gating added complexity without solving the fundamental 1px line rendering problem. |
| 6 | Always-visible during gameplay (no gating) | **Vertical green line flicker persists.** Confirmed: the rendering approach (`THREE.Line` at 1px) is fundamentally inadequate at orbital scales. |

**Root causes identified:**
1. **`THREE.Line` cannot render lines wider than 1px** on most WebGL implementations (macOS Chrome, Safari). This is a well-known WebGL/OpenGL limitation.
2. **Orbital scale mismatch:** At `SCENE_SCALE = 0.01` (1 unit = 100 km), trail segments ≈ 0.007 scene units apart. Camera at typical viewing distance makes these sub-pixel.
3. **No suitable thick-line API** in the vanilla Three.js r170 core. `THREE.Line2` (fat lines) exists in `three/addons/lines/` but requires import map changes and `LineGeometry`/`LineMaterial` from the examples module.

**What needs to happen to fix (next session):**
- Option A: Use `THREE.Line2` from `three/addons/lines/` — provides GPU-instanced screen-space-width lines (2-32px). Requires adding `Line2`, `LineGeometry`, `LineMaterial` to import map in `index.html`.
- Option B: Use `THREE.Points` with `THREE.PointsMaterial({size, sizeAttenuation: true})` — point sprites along trajectory, blending into a dotted trail. Simpler, no addons needed.
- Option C: Canvas2D overlay (like `VelocityStreaks.js`, `NavSphere.js`) — project 3D trail positions to screen space, draw with `ctx.lineWidth > 1`. Consistent width, no WebGL line limitations. Proven pattern in this codebase.

**To re-enable:** Set [`Constants.TRAILS.ENABLED: true`](../js/core/Constants.js:1291). All event wiring, ring buffer logic, sample emission, and test infrastructure remain intact.

### 2.3 Prior completed work (rollup)

| Session | Area | Outcome |
|---|---|---|
| **S27** | Progression-Aware Discovery Pane Persistence | 3-level opacity gradient (NOVICE 0.85 always / APPRENTICE 0.45 / VETERAN fade-out) in [`SkillsPane.js:56-60`](../js/ui/hud/SkillsPane.js:56) |
| **S26** | UX Overhaul — Discovery Pane & Comms Rework | Removed `awareness_beauty`; Discovery Pane moved bottom-left; Tech Library rename |
| **S25** | First Experience — Welcome Field + Guidance | [`WELCOME_FIELD`](../js/entities/DebrisField.js:61), auto-target 3 s after ORBITAL_VIEW, 5 contextual comms hints |
| **S24** | Skills Discovery MVP | [`SkillsSystem.js`](../js/systems/SkillsSystem.js), [`SkillsPane.js`](../js/ui/hud/SkillsPane.js), 33-skill free-order discovery |
| **S23** | Tutorial & Autopilot Polish | Slerp rotation, scan audio/flash, credit flash, tool-aware arrival distances |
| **S22** | Control Redesign + Tutorial Resequence | WASD command cluster, backtick tool cycle |
| **S19–S21** | CA AI + refs decoupling + lasso miss recovery | 53 CA tests, 23→6 `_refs`, `LASSO_MISSED` recovery |
