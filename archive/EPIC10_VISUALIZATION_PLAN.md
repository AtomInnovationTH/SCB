# Epic 10 — Config G Full Visualization

> **Created:** 2026-04-28 · **Status:** PLANNING
> **Prerequisite:** Epic 9 complete (438 suites / 1,995 tests / 0 failures)
> **Goal:** Make the player SEE the Config G spacecraft — barrel, struts, ROSA panels, hinges, capture nets, tether reels, tier progression, launch sequence — all driven by the Epic 9 logic backbone.
> **Deferred items carried forward:** ST-9.9 Reality Mode (defer to Epic 11+)
> **Dropped:** ST-9.6 Ablation (cancelled)

---

## Table of Contents

1. [Current Visual State (What the Player Sees Now)](#1-current-visual-state)
2. [Target Visual State (Config G)](#2-target-visual-state)
3. [Visual Delta — What Must Change](#3-visual-delta)
4. [Task Breakdown (V-1..V-11)](#4-task-breakdown)
5. [Execution Order + Dependency Graph](#5-execution-order)
6. [Flag Activation Strategy](#6-flag-activation-strategy)
7. [Acceptance Criteria](#7-acceptance-criteria)
8. [Risk Register](#8-risk-register)

---

## 1. Current Visual State

The player currently sees a **V3 Octopus** design in [`PlayerSatellite._buildModel()`](js/entities/PlayerSatellite.js:214):

| Component | Current Geometry | Location |
|-----------|-----------------|----------|
| **Main bus** | Octagonal prism — `CylinderGeometry(M*1.0, M*1.0, M*4.0, 8)` = 1.0m radius × 4.0m long | [`_buildMainBus()`](js/entities/PlayerSatellite.js:261) |
| **Arm cavities** | 6 flat planes on octagonal faces (3 Weaver + 3 Spinner) | [`_buildMainBus()`](js/entities/PlayerSatellite.js:305) |
| **Solar panels** | 2 large wings, 3 segments each, flat-deploy on X-axis | [`_buildSolarPanels()`](js/entities/PlayerSatellite.js:499) |
| **Thrusters** | 4 main rear + 8 attitude around body | [`_buildThrusters()`](js/entities/PlayerSatellite.js:406) |
| **Tether reels** | 8 drums evenly spaced around bus circumference | [`_buildTetherReels()`](js/entities/PlayerSatellite.js:648) |
| **Magnetic ring** | Toroidal ring at Y=0 (mid-bus) | [`_buildMagneticRing()`](js/entities/PlayerSatellite.js:711) |
| **Docking port** | Front-end torus + cone guide | [`_buildDockingPort()`](js/entities/PlayerSatellite.js:741) |
| **Sensors** | Gimbal platform + EO camera + IR + LIDAR at front | [`_buildSensors()`](js/entities/PlayerSatellite.js:591) |
| **Nav lights** | Port red, starboard green, top/bottom strobe | [`_buildNavLights()`](js/entities/PlayerSatellite.js:781) |
| **RCS puffs** | Sprite pool | [`_buildRcsPuffPool()`](js/entities/PlayerSatellite.js:818) |

[`ArmUnit._createMesh()`](js/entities/ArmUnit.js:280) renders each daughter arm as:
- Simple box body (Weaver=blue, Spinner=green)
- Gold MLI accent strip, 2 mini solar panels, nozzle + plume cone
- Canister, PV panel, MRR reflector, status light, dock plate

**None of this matches Config G.** The visual is stuck at V3/V5 while the logic underneath is now Config G.

---

## 2. Target Visual State

Config G per [`ARM_PIVOT_ANALYSIS.md §10`](ARM_PIVOT_ANALYSIS.md:801) and [`§10.14`](ARM_PIVOT_ANALYSIS.md:1495):

### Mother Spacecraft (Top-Level)

```
         [ROSA Wing 1]  [ROSA Wing 2]
              │              │
              ▼              ▼
    ┌─────────────────────────────┐
    │    BARREL (2.0m × 0.8m Ø)  │  ← cylindrical, not octagonal
    │                             │
    │   Y=+0.90 ── COLLAR ──     │  ← ring with 4 hinge mounts (Y0 Quad)
    │      ╱      ╲               │
    │    STRUT   STRUT            │  ← 1.60m, sweeps 0–180° meridian
    │    │         │              │
    │   [ARM]    [ARM]            │  ← daughter units at strut tips
    │                             │
    │  FEEP ●──────────── ● FEEP  │  ← body-mounted thrusters
    │                             │
    │   [Daughter Pocket]         │  ← barrel bottom stowage
    └─────────────────────────────┘

    Stowed configuration: struts nest in recessed channels along barrel surface.
    ROSA panels roll out from barrel surface (not large-wing deploy).
```

### Key Visual Differences from Current

| Aspect | V3 Octopus (Current) | Config G (Target) |
|--------|---------------------|-------------------|
| **Bus shape** | Octagonal prism, 1.0m radius × 4.0m | Cylinder, 0.4m radius × 2.0m |
| **Bus scale** | Large (2× game-units wide) | Compact (half the footprint) |
| **Arm mount** | Cavities on bus faces (flat) | Collar ring at Y=+0.90m with hinged struts |
| **Arm count** | 6 fixed (3+3) | 4/6/8 (tier-dependent, upgradeable) |
| **Arm motion** | None (static docks) | 0–180° meridian sweep via hinge animation |
| **Solar** | 2 large flat wings on X-axis | 2–4 ROSA roll-out panels on barrel surface |
| **Tether reels** | 8 drums on bus | 1 per strut (strut-mounted) |
| **Stowage** | None visible | Recessed channels, daughter pockets |
| **Launch** | Instant (no sequence) | Fairing → orbit → pyro-bolt → ROSA deploy cinematic |

---

## 3. Visual Delta — What Must Change

### DELETE (remove entirely)
- Octagonal prism body geometry
- Arm cavity planes on bus faces
- Large solar wing arrays
- Tether reels on bus circumference
- Magnetic ring (not in Config G spec)

### REPLACE
- Bus → cylindrical barrel (2.0m × 0.8m Ø)
- Solar wings → ROSA roll-out panels
- Tether reels → strut-mounted reels (per-arm)
- Arm positioning → collar-mounted strut-tip docks

### ADD (new visual elements)
- **Collar ring** with hinge mount points at Y=+0.90m
- **Struts** (1.60m cylindrical rods) that animate 0–180° sweep
- **Hinge joints** (visible pivot joint at collar)
- **Stowage channels** (recessed grooves along barrel for stowed struts)
- **Daughter pockets** (barrel bottom recess)
- **ROSA roll-out animation** (panel edge unfurls from barrel)
- **Launch fairing** (optional: translucent cone around spacecraft, ejected at fairing separation)
- **Capture net visual** (folded net → unfurling → deployed mesh) at strut tip
- **Bridle ring** (small toroid at strut tip)
- **Deploy state indicators** (per-strut color halo or strip)
- **Tier visual progression** (4 struts → 6 struts → 8 struts on upgrade)

### KEEP (reusable)
- Materials library (gold MLI, body metal, dark metal, panel blue)
- Nav lights system
- RCS puff sprites
- Sensor suite (relocate to barrel front)
- Docking port (relocate to barrel bottom or front)
- Thrust plume effects (relocate to Config G FEEP positions)
- Scene unit scale constant `M = 1e-5`

---

## 4. Task Breakdown

### V-1: Config G Barrel Mesh (1 day)

**Files:** [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js)

Replace [`_buildMainBus()`](js/entities/PlayerSatellite.js:261):
- New cylindrical barrel: `CylinderGeometry(M*0.4, M*0.4, M*2.0, 16)` — 16 segments for smooth cylinder
- Keep gold MLI bands at ±25% of barrel length
- Add visible end caps (top = equipment bay; bottom = daughter pocket)
- Remove arm cavity planes from bus faces
- Add body-mounted thin-film solar cells as subtle texture/material on barrel surface (per §10.15)
- Add viewport/window on barrel front face

**Test:** Visual inspection + snapshot test confirming barrel dimensions match `Constants.OCTOPUS_V5.BARREL_HEIGHT` and `BARREL_RADIUS`.

### V-2: Collar Ring + Hinge Mounts (1 day)

**Files:** [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js)

Add new method `_buildCollar()`:
- Toroidal collar ring at `Y = COLLAR_Y × M` (0.90m above barrel center)
- Collar radius matches `COLLAR_RADIUS × M` (0.40m)
- 4 hinge mount points at azimuths from `Constants.ARM_LADDER.Y0_QUAD.azimuths` (60°, 120°, 240°, 300°)
- Each mount = small cylindrical bracket + visible pivot pin
- Hinge status indicator LED (green = ROTATE, red = LOCKED, amber = DEPLOYING)
- Store references as `this.hingeMounts[i]` for animation wiring

**Test:** 4 mounts at correct azimuths; Y position matches `COLLAR_Y`.

### V-3: Strut + Sweep Animation (2 days)

**Files:** [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js), [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js), [`js/entities/ArmManager.js`](js/entities/ArmManager.js)

Add new method `_buildStrut(armIndex)` and animation system:
- Cylindrical rod: `CylinderGeometry(M*0.03, M*0.03, STRUT_LENGTH*M, 8)` — 1.60m × 3cm diameter
- Pivot at collar hinge point; strut hangs from top
- **Animation driver**: read `arm.getAimAlpha()` each frame → rotate strut around the arm's `swingAxis` by alpha
  - α=0: strut points down (−Y, stowed)
  - α=π/2: strut points outward (equatorial)
  - α=π: strut points up (+Y, zenith)
- Strut color/material: structural gray; subtle accent stripe matching arm type
- During DEPLOYING/STOWING (from C-4), alpha animates smoothly → strut sweeps visibly
- Add strut-tip node (where ArmUnit attaches)

**Performance note:** 4–8 struts × 1 cylinder each is trivial for Three.js. No instancing needed.

**Test:** Strut tip world position matches `armManager.getStrutTipPosition(i, alpha)` within `M * 0.01`.

### V-4: Arm Remount at Strut Tips (1.5 days)

**Files:** [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js), [`js/entities/ArmManager.js`](js/entities/ArmManager.js)

Modify [`ArmUnit._createMesh()`](js/entities/ArmUnit.js:280):
- Keep daughter body box but adjust dimensions for Config G scale
- Position at strut tip (child of strut group, not bus group)
- Remove old dock positioning from bus face azimuths
- Arm body orientation: "outward" from barrel center (dockOutward direction from C-2)
- Integrate with strut sweep: arm moves with strut tip as alpha changes
- Add visual for:
  - Strut-mounted tether reel (small drum near strut tip — replaces bus-mounted reel)
  - Bridle ring (small toroid at strut tip, from C-8)
  - Net canister (folded net storage indicator)

**Test:** Arms track strut tips correctly at all alpha values; arm count updates on tier change.

### V-5: ROSA Panel Roll-Out (1.5 days)

**Files:** [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js), [`js/systems/LaunchSequence.js`](js/systems/LaunchSequence.js)

Replace [`_buildSolarPanels()`](js/entities/PlayerSatellite.js:499):
- Remove large wing arrays
- Add 2 ROSA panels (1.0m × 2.0m each) on barrel surface
- **Roll-out animation**: Panel starts as rolled-up cylinder flush with barrel → unrolls to flat 1.0m × 2.0m plane
  - Driven by `LaunchSequence.getRosaProgress()` → `wing1: 0..1, wing2: 0..1`
  - Morphtarget or progressive scaling approach: start with `scaleX=0.05` → expand to `1.0` as progress ramps
- Deployed panel: blue-black solar cell material with grid lines (reuse existing panel material)
- Slight flex/curvature when fully deployed (realistic ROSA appearance)
- Body-mounted thin-film cells remain as barrel surface texture (always active, low power)

**Test:** Panel dimensions match `Constants.OCTOPUS_V5.ROSA`; full deploy matches 2240W total.

### V-6: FEEP Thruster Relocation (0.5 day)

**Files:** [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js)

Modify [`_buildThrusters()`](js/entities/PlayerSatellite.js:406):
- Relocate 4 main FEEP nozzles to positions from `Constants.THRUSTERS` array (body-mounted at ±X, ±Z at Y=0)
- Attitude thrusters: keep 8, redistribute to Config G barrel geometry
- Plume cones: direction matches `thrustDir` from Constants
- Plume interlock visual: when `THRUSTER_INTERLOCK` flag is ON and a thruster is blocked, dim its plume and add red "X" indicator

**Test:** Nozzle positions match `Constants.THRUSTERS[i].nozzlePos` × M.

### V-7: Launch Sequence Cinematic (2 days)

**Files:** New [`js/scene/LaunchCinematic.js`](js/scene/LaunchCinematic.js), [`js/systems/LaunchSequence.js`](js/systems/LaunchSequence.js)

Subscribe to `LAUNCH_PHASE_CHANGED` events and animate:

| Phase | Visual |
|-------|--------|
| `STOWED_IN_FAIRING` | Show translucent fairing cone enclosing spacecraft; struts stowed in channels |
| `LIFTOFF` | Camera shake; fairing vibration; flame particle below |
| `FAIRING_SEPARATION` | Two fairing halves fly apart (simple mesh + tween); reveal spacecraft |
| `ORBIT_INSERTION` | Gentle FEEP glow; Earth backdrop stabilizes |
| `LAUNCH_LOCK_RELEASE` | Per-strut: small flash at hinge (pyro-bolt); strut "drops" to stowed position |
| `ROSA_DEPLOY_PRIMARY` | Panel 1 unrolls (V-5 animation) |
| `ROSA_DEPLOY_SECONDARY` | Panel 2 unrolls |
| `POWER_NOMINAL` | Panel glow brightens; HUD solar indicator fills to 2240W |
| `READY` | Camera returns to normal; player control restored |

Camera work: auto-cinematic during sequence (orbit cam with slow pan); restore player camera on READY.

**Test:** Fairing visible at start, invisible after separation; ROSA panels fully deployed at READY.

### V-8: Capture Net Visual (1.5 days)

**Files:** New visual module (e.g., [`js/ui/NetVisual.js`](js/ui/NetVisual.js) or inline in [`CaptureNet.js`](js/entities/CaptureNet.js))

Visualize the 14-state NetProjectile FSM (C-6):
- **FOLDED**: Small mesh on strut tip (compressed net canister)
- **LAUNCHING → FLIGHT**: Expanding torus/disc projectile with trailing tether line
- **SPINNING_UP**: Visible spin (rotation animation on the net disc)
- **CONTACT/CINCH**: Net mesh wraps around debris (simplified: semi-transparent sphere or torus wrapping target)
- **REELING**: Tether line shortens; net + debris move toward strut tip
- **STOWED**: Disappear (net consumed or stored)
- Tether line: `THREE.Line` from strut tip to net position (use `getTetherAnchorWorldPosition()`)

Materials: translucent white/blue mesh material for net; glow edge for spinning net.

**Test:** Net visual tracks projectile state correctly; disappears on STOWED/RELEASED.

### V-9: Tier Progression Visuals (1 day)

**Files:** [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js), [`js/entities/ArmManager.js`](js/entities/ArmManager.js)

On `TIER_UPGRADED` event:
- **Y0 Quad** (4 arms): 4 struts on collar at 60°/120°/240°/300°
- **Y1 Hex** (6 arms): 6 struts at 30°/90°/150°/210°/270°/330° — collar ring slightly thicker
- **Y3 Octo** (8 arms): 6 ring struts + 2 end-face arms (±Z, barrel top/bottom)

Transition animation:
1. Fade out old struts (1s)
2. Brief "refit" flash/shimmer on barrel
3. New struts + arms fade in at new positions (1s)

End-face arms (Y3): require a different mount — not on collar ring; instead, small bracket on barrel top (+Z) and bottom (−Z). These sweep in a different plane.

**Test:** Correct arm count per tier; end-face arms at correct positions for Y3.

### V-10: Deploy State Visual Indicators (0.5 day)

**Files:** [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js), [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js)

Per-strut visual for deploy state from C-4:
- **LOCKED**: Red hinge LED; strut has faint red outline or lock-bolt visible
- **STOWED**: Amber hinge LED; strut nestled in barrel channel
- **DEPLOYING**: Cyan pulsing hinge LED; strut sweeping outward
- **DEPLOYED**: Green hinge LED; strut at operational alpha
- **STOWING**: Cyan pulsing hinge LED; strut sweeping inward

Alpha-dependent high-recoil zone indicator (from C-3 NavSphere):
- When α < 30° or α > 150°, strut glows faint amber to match NavSphere "HIGH RECOIL" warning.

**Test:** Hinge LED colors match deploy state; high-recoil glow active in correct alpha ranges.

### V-11: Stowage Channels + Daughter Pockets (0.5 day)

**Files:** [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js)

Add subtle barrel surface detail:
- **Stowage channels**: 4 slightly recessed grooves along barrel (matching strut azimuth positions) — when struts are stowed (α=0), they nest flush into these channels
- **Daughter pocket**: Wider recess at barrel bottom (−Y) for daughter stowage when not deployed
- Use `BoxGeometry` indentations or `BufferGeometry` custom shape for channels
- Visual only — no collision/physics

**Test:** Channels align with strut azimuths; pocket at barrel bottom.

---

## 5. Execution Order

```
V-1: Barrel Mesh (1d)
 │
 ├─► V-2: Collar + Hinges (1d)    V-5: ROSA Panels (1.5d)    V-6: FEEP Relocation (0.5d)
 │    │
 │    ├─► V-3: Struts + Animation (2d)
 │    │    │
 │    │    ├─► V-4: Arm Remount (1.5d)
 │    │    │    │
 │    │    │    ├─► V-8: Net Visual (1.5d)
 │    │    │    │
 │    │    │    ├─► V-9: Tier Visuals (1d)
 │    │    │    │
 │    │    │    └─► V-10: Deploy Indicators (0.5d)
 │    │    │
 │    │    └─► V-11: Stowage Channels (0.5d)
 │    │
 │    └─► V-7: Launch Cinematic (2d) [depends: V-3, V-5]
 │
 └─► Integration polish pass (1d)

Critical path: V-1 → V-2 → V-3 → V-4 → V-8 = 7.5 days
Total estimated: ~13 days (with parallel tracks)
```

```
        V-1 (Barrel)
       / │  \     \
      /  │   \     \
     ▼   ▼    ▼     ▼
   V-2  V-5  V-6  V-11
    │    │
    ▼    │
   V-3 ◄─┘ (needs ROSA for launch cinematic)
   / \
  ▼   ▼
V-4   V-7 (launch cinematic needs V-3 struts + V-5 ROSA)
 │\
 │ \
 ▼  ▼
V-8  V-9
      │
      ▼
    V-10
      │
      ▼
   Polish
```

---

## 6. Flag Activation Strategy

Epic 9 added 25 feature flags, all defaulting to `false`. Epic 10 visualization should:

1. **V-1 through V-6**: Unconditional visual replacement — the old V3 Octopus model is wrong regardless of flags. Replace `_buildModel()` entirely. No flag needed for visual.
2. **V-7 (Launch Cinematic)**: Tied to existing `FEATURE_FLAGS.LAUNCH_SEQUENCE`. Visual cinematic plays only when flag is true.
3. **V-8 (Capture Net Visual)**: Tied to existing `FEATURE_FLAGS.CAPTURE_NET`. Visual appears only when flag is true and a net is active.
4. **V-10 (Deploy Indicators)**: Tied to existing `FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE`. Shows states only when flag is true.
5. **V-9 (Tier Visuals)**: Tied to existing `FEATURE_FLAGS.TIER_UPGRADES`. Shows upgrade transitions only when flag is true.

**Recommended flag-enable order after Epic 10 visual is complete:**
1. Enable `STOW_DEPLOY_STATE_MACHINE` — struts start LOCKED
2. Enable `LAUNCH_SEQUENCE` — cinematic plays on new game
3. Enable `LOCKABLE_HINGE` + `SEMI_AUTO_AIM` — aim system active
4. Enable `TETHER_REEL` + `BRIDLE_RING` — tether/load system live
5. Enable `CAPTURE_NET` — net gameplay
6. Enable `COM_TRACKING` + `THRUSTER_INTERLOCK` + `RECOIL_PHYSICS` — full physics
7. Enable `TIER_UPGRADES` — shop progression

This is a **gameplay tuning pass** task, separate from rendering — but it makes sense to do it immediately after Epic 10 visuals land.

---

## 7. Acceptance Criteria

1. **Player sees Config G spacecraft** on game start: cylindrical barrel (not octagonal), collar ring with struts, ROSA panels, no large solar wings.
2. **Struts animate**: moving alpha slider (or deploying) visibly sweeps struts 0–180°.
3. **Launch cinematic plays** (flag ON): fairing separation, strut unlock cascade, ROSA roll-out visible with power ramp.
4. **Tier upgrade visualizes**: Y0 Quad → Y1 Hex → Y3 Octo shows correct armature count and layout.
5. **Capture net visible**: fired, flying, wrapping, reeling.
6. **Deploy state colors**: each strut/hinge shows correct LED state.
7. **All 1,995 tests still pass** (visual changes must not break logic).
8. **Performance**: 60 FPS maintained at all tier levels on a mid-range GPU.
9. **Scene scale**: barrel at `M * 2.0` height, `M * 0.4` radius — consistent with existing `M = 1e-5` scene scale.

---

## 8. Risk Register

| # | Risk | Impact | Mitigation |
|---|------|--------|------------|
| R-1 | Octagonal bus removal breaks tests that reference body geometry | Medium | Tests reference Constants and behavior, not mesh vertex counts. Verify with full test run after V-1. |
| R-2 | Strut animation at 60 FPS causes jitter | Low | Only 4–8 cylinders rotating per frame. Use `quaternion.setFromAxisAngle` for smooth interpolation. |
| R-3 | ROSA roll-out morph looks janky | Medium | Start with simple scaleX animation; iterate to mesh morph if needed. Good-enough > perfect. |
| R-4 | Capture net wrap visual is hard to make look good | Medium | Start with translucent sphere overlay on target; iterate. Net mesh wrapping is a stretch goal. |
| R-5 | Launch cinematic camera conflicts with existing camera system | Medium | Use a dedicated `CinematicCamera` state in CameraSystem that yields to player cam on READY. |
| R-6 | Tier transition visual (fade out/in) looks cheap | Low | A brief refit flash (white overlay) hides the swap. Good enough for v1. |
| R-7 | End-face arms on Y3 require different mounting | Medium | These 2 arms are barrel-mounted (±Z), not collar-mounted. Need a special bracket visual. V-9 handles this explicitly. |
| R-8 | Existing arm visual code in ArmUnit is tightly coupled to old positioning | High | V-4 must carefully restructure ArmUnit's group hierarchy: strut → arm body → accessories. This is the highest-risk task. |

---

## Summary

Epic 10 transforms the game from "logic-complete but visually V3" to "Config G is visible and alive." The 11 visual tasks (V-1..V-11) total ~13 estimated days with a 7.5-day critical path. All logic is already in place from Epic 9; the visual layer reads from existing APIs (`getAimAlpha()`, `getDeployState()`, `getRosaProgress()`, `getStrutTipPosition()`, etc.) without modifying them.

Post-Epic 10, all feature flags can be enabled for the full Config G gameplay experience.
