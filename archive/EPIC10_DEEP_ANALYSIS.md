# Epic 10 — Deep Architectural Analysis: 9 Concerns + Remaining Tasks

> **Created:** 2026-05-01 · **Status:** ANALYSIS COMPLETE
> **Scope:** V-7 (Launch Cinematic), V-8 (Capture Net Visual), V-9 (Tier Progression) + 9 Player-Reported Concerns
> **Source files analyzed:** 22 JS modules, 4 design documents, 2 Epic 10 plans

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Concern 1: Visual Fidelity of Mechanical Parts](#2-concern-1-visual-fidelity-of-mechanical-parts)
3. [Concern 2: Deploy All 4 Struts + Hotkey](#3-concern-2-deploy-all-4-struts--hotkey)
4. [Concern 3: Camera Near-Clip Cutting Solar Panels](#4-concern-3-camera-near-clip-cutting-solar-panels)
5. [Concern 4: Unnecessary Shadows](#5-concern-4-unnecessary-shadows)
6. [Concern 5: Daughter Launch Transition Too Abrupt](#6-concern-5-daughter-launch-transition-too-abrupt)
7. [Concern 6: Comms Panel Dimming](#7-concern-6-comms-panel-dimming)
8. [Concern 7: Auto-Target After 2nd Capture](#8-concern-7-auto-target-after-2nd-capture)
9. [Concern 8: Scan Reward Gaming](#9-concern-8-scan-reward-gaming)
10. [Concern 9: Reticle Text Flashing](#10-concern-9-reticle-text-flashing)
11. [Revised Task Plan](#11-revised-task-plan)
12. [Recommended Implementation Order](#12-recommended-implementation-order)
13. [Visual Design Specification (Concern 1)](#13-visual-design-specification)
    - 13.1 [S3.1 Hinge Design Specification](#131-s31-hinge-design-specification--double-a-clevis-with-weight-saved-a-frames) — materials, topology-optimized A-frames, collar/barrel attachment, Three.js geometry

---

## 1. Executive Summary

### Concern Categorization

| # | Concern | Category | Severity | Effort | Maps To |
|---|---------|----------|----------|--------|---------|
| 1 | Visual fidelity of mechanical parts | 🎨 Visual Design | Medium | XL (5–8 days) | V-7, V-8, new V-12 |
| 2 | Deploy all struts + hotkey | 🎮 UX / Controls | Medium | S (0.5 day) | New V-13 |
| 3 | Camera near-clip cutting panels | 🐛 Bug | High | XS (1 hour) | Hotfix |
| 4 | ROSA "shadows" (bloom halo) | 🐛 Bug (REVISED) | High | S (30 min) | Hotfix-E |
| 5 | Daughter launch transition abrupt | 🎮 UX / Cinematic | Medium | M (1 day) | V-7 |
| 6 | Comms panel dimming | 🎮 UX / HUD | Low | S (2 hours) | Hotfix |
| 7 | Auto-target after 2nd capture | 🐛 Bug | High | S (2 hours) | Hotfix |
| 8 | Scan reward gaming | 🎮 Gameplay Balance | Medium | S (0.5 day) | New V-14 |
| 9 | Reticle text flashing | 🐛 Bug | High | S (2 hours) | Hotfix |

### Key Findings

1. **"Shadows" are bloom-pass dark halos, not shadow maps** — While `renderer.shadowMap.enabled = false` at [`SceneManager.js:39`](js/scene/SceneManager.js:39), the `UnrealBloomPass` (threshold=1.2) at [`SceneManager.js:107`](js/scene/SceneManager.js:107) creates **negative halos** around dark ROSA panels silhouetted against bright Earth. The extraction step subtracts bloom energy near dark objects, producing visible dark outlines on Earth AND in space. Fix: raise threshold to 1.5 + boost ROSA emissive slightly.
2. **Auto-target after capture has TWO competing handlers** — [`InputManager.js:122`](js/systems/InputManager.js:122) and [`GameFlowManager.js:812`](js/systems/GameFlowManager.js:812) both try to auto-select next target. GameFlowManager unconditionally calls `setTarget(null)`, overriding InputManager's selection on 2nd+ capture.
3. **Scan rewards have NO per-target deduplication** — Quick scan awards 50cr every 3s with zero per-target tracking. Redesign: reward **new information** (first-scan bonus, close-range characterization, tumble determination) — modeling real SST data value for ground station contracts.
4. **Near-clip + zoom needs an Inspection Camera** — `CAMERA_NEAR` at [`Constants.js:32`](js/core/Constants.js:32) is 0.0001 (10m), orbit min distance at [`CameraSystem.js:127`](js/systems/CameraSystem.js:127) is 15m. Player can't zoom close enough to see mechanical details. Solution: new INSPECTION view (2–50m, dynamic near-plane at 5% of distance, narrow 35° FOV).
5. **Bridle must be wishbone shape** — Feature flag [`BRIDLE_RING_GEOMETRY`](js/core/Constants.js:394) explicitly describes "Y-harness FEEP plume exclusion." Two legs at ±Y route around the rear FEEP plume cone. Co-rotates with ROSA panels during yaw. Gimbal is spring-loaded return-to-center.
6. **Cable routing is external** — 50mm CFRP tube has no internal cavity. Power/data bundle (~8mm) routes along strut exterior with 3–4 P-clips, realistic per ISS/Hubble precedent.

---

## 2. Concern 1: Visual Fidelity of Mechanical Parts

### Overview

The user wants improved visuals for 8 mechanical subsystems: hinge, cable/tether, struts, reel, crossbow bracket, tether-to-daughter attachment, bridle, and daughter satellites.

---

### 2.1 Hinge — Current State & Proposed "Double-A" Design

**Current State** ([`PlayerSatellite._buildCollar()`](js/entities/PlayerSatellite.js:462)):
- **Bearing housing**: `CylinderGeometry(M*0.025, M*0.025, M*0.035, 8)` — a squat cylinder at each collar azimuth
- **Axle pin**: `CylinderGeometry(M*0.005, M*0.005, M*0.07, 6)` — thin rod through housing, tangentially oriented
- **Flanges**: `CylinderGeometry(M*0.018, M*0.018, M*0.004, 8)` — disc caps at ±33mm from center
- **LED**: `SphereGeometry(M*0.01, 4, 4)` — green indicator forward of mount

**Problem**: The current hinge is just a cylinder + pin — it looks like a generic journal bearing, not the "Double-A" frame described in the design docs. A Double-A hinge has two A-shaped frames (clevis brackets) straddling a pivot pin, like the hinge on a spacecraft solar array deployment mechanism (e.g., the Northrop Grumman Astro Aerospace hinge used on ISS ROSA arrays).

**Proposed Double-A Hinge Geometry**:

```
  Top View (looking down barrel axis):
  
     ╱╲     ╱╲
    ╱  ╲   ╱  ╲     ← Two A-frames (clevis brackets)
   ╱    ╲ ╱    ╲
  ╱______╳______╲   ← Pivot pin axis (tangential to collar)
         │
    [STRUT continues down]
```

Each hinge assembly consists of:
1. **Two A-frame clevis brackets** (triangular prisms) — mounted to collar, straddle strut root
2. **Pivot pin** — cylindrical rod through both A-frame peaks
3. **Bearing bushings** — small torus at each A-frame/pin intersection
4. **Brake disc** — thin cylinder on pin for lockable hinge
5. **LED indicator** — sphere mounted on outboard A-frame

**Three.js Approach**: See **[§13.1 S3.1 Hinge Design Specification](#131-s31-hinge-design-specification--double-a-clevis-with-weight-saved-a-frames)** for full geometry constructors, material table, and assembly diagrams. Summary:
- A-frame: `ExtrudeGeometry` from rounded `Shape` with `bezierCurveTo()` + lightening hole (§13.1.5B)
- Pin: `CylinderGeometry(M*0.005, M*0.005, M*0.070, 8)` + C-clip retainers (§13.1.5C)
- Bushings: `TorusGeometry(M*0.008, M*0.003, 6, 8)` — Vespel SP-1 amber (§13.1.5D)
- Brake disc: `CylinderGeometry(M*0.015, M*0.015, M*0.003, 12)` (§13.1.5E)
- Collar-to-barrel: bolted flange with inner ring + 12× Ti bolt heads (§13.1.3)
- A-frame-to-collar: 2× M4 Ti bolts per bracket into machined pads (§13.1.4)

**Estimated LOC**: ~130 lines replacing current ~85 lines in [`_buildCollar()`](js/entities/PlayerSatellite.js:462) (+helper `_aframeShape()` ~25 LOC). Total ~5,150 triangles for all 4 hinges.

---

### 2.2 Strut Shape

**Current State** ([`PlayerSatellite._buildStruts()`](js/entities/PlayerSatellite.js:568)):
- `CylinderGeometry(strutR, strutR, strutLen, 8)` — simple round tube
- `strutR = (STRUT_TUBE_OD / 2) * M` = 0.025m radius (50mm OD tube)
- Length: 1.60m, hangs from pivot at collar

**Research — Real Deployable Space Struts**:
- **ATK/Northrop Grumman ADAM (Able Deployable Articulated Mast)**: Uses triangular cross-section longerons with diagonal battens. Too complex for game visuals.
- **Astro Aerospace AstroMast**: Round-tube with joint articulations. Closest to current.
- **ISS truss segments**: I-beam or square tube cross-sections.
- **ROSA blanket support booms** (e.g., DSS Roll-Out Solar Array): Thin-walled composite tubes with tape-spring hinges.

**Recommendation**: **Oval/elliptical cross-section tube** — visually distinct from round, suggests aerodynamic CFRP composite boom, easy to implement.

**Proposed Design**:
- Cross-section: elliptical, 50mm × 30mm (radial × tangential)
- Material: dark carbon-fiber appearance (matte dark gray, low metalness)
- Detail: 3 thin "rib rings" along length at 25%, 50%, 75% marks
- Joint collars at each end (slightly wider cylinder sections)

**Three.js Approach**:
- Replace `CylinderGeometry` with `LatheGeometry` using an elliptical profile, OR use `ExtrudeGeometry` with an elliptical `Shape` extruded along path
- Simplest: keep `CylinderGeometry` but add `scale.x = 0.6` to achieve oval appearance (60% compression on one axis)
- Rib rings: 3 × `TorusGeometry` at fixed Y positions along strut

**Estimated LOC**: ~30 lines change in [`_buildStruts()`](js/entities/PlayerSatellite.js:568)

---

### 2.3 Reel Size and Integration

**Current State** ([`PlayerSatellite._buildStruts()`](js/entities/PlayerSatellite.js:617)):
- `CylinderGeometry(M*0.06, M*0.06, M*0.08, 8)` — 60mm radius × 80mm height
- Located at 85% of strut length from pivot
- Material: gray metal (`0x666677`, metalness 0.7)

**Research — Tether Deployer Mechanisms**:
- **JAXA EDT deployer** (Kounotori): Cylindrical drum with friction brake, ~150mm diameter
- **ESA YES2 reel**: 200mm diameter drum, separate from bracket
- **Tethers Unlimited KRAKEN deployer**: Modular cartridge system, replaceable spools

**Recommendation**: **Separate replaceable cartridge** design — the reel housing is a self-contained cylindrical module that clips into a bracket on the strut. This supports the gameplay mechanic of tether tier upgrades (swapping cartridges).

**Proposed Design**:
- **Reel drum**: `CylinderGeometry(M*0.05, M*0.05, M*0.06, 10)` — 50mm R × 60mm H
- **Housing shell**: `CylinderGeometry(M*0.055, M*0.055, M*0.065, 10, 1, true)` — open-ended shell around drum
- **Cartridge latch**: Small box at base (`BoxGeometry(M*0.03, M*0.015, M*0.03)`)
- **Tether exit guide**: Small ring at top of housing (`TorusGeometry(M*0.02, M*0.004, 4, 8)`)
- Relative to barrel: drum radius is 12.5% of barrel radius (0.05/0.40) — proportionate

**Estimated LOC**: ~40 lines replacing current ~10 lines

---

### 2.4 Tether-to-Daughter Attachment (EPM Mechanism)

**Current State**: Tether connects to daughter via [`ArmUnit._createTether()`](js/entities/ArmUnit.js:466) — a `LineDashedMaterial` line from mother to arm position. The docking plate is at [`ArmUnit._createMesh():451`](js/entities/ArmUnit.js:451) — a simple flat box (`BoxGeometry(plateSize*M, 0.002*M, plateSize*M)`).

**EPM (Electro-Permanent Magnet) Research**:
Constants confirm EPM usage at [`Constants.js:177`](js/core/Constants.js:177):
- `DOCK_EPM_HOLD_FORCE: 50` N (zero-power hold)
- `DOCK_EPM_SWITCH_ENERGY: 0.5` J per toggle
- `DOCK_EPM_MASS_PER_CAVITY: 0.08` kg

EPMs use a combination of permanent magnets and electromagnet coils. When pulsed, the magnetic field can be switched on/off without continuous power. This is ideal for space (no power drain while holding).

**Proposed Attachment Mechanism Visual**:
1. **Daughter side**: EPM docking collar — circular ring with 4 visible magnet poles (alternating gold/dark sectors)
2. **Mother/strut side**: Matching receptacle plate on strut tip, with alignment guide pins
3. **Visual feedback**: When attached, EPM ring glows faint blue; when released, brief red flash pulse
4. **Tether routing**: Tether exits reel housing, runs along strut to tip, connects to bridle ring (not directly to EPM plate)

**Three.js Approach**:
- EPM ring on daughter: `RingGeometry(M*0.04, M*0.06, 8)` with custom UV for alternating sectors, or 4 × small box segments
- Receptacle: `CylinderGeometry(M*0.05, M*0.05, M*0.005, 8)` on strut tip
- Guide pins: 2 × `CylinderGeometry(M*0.004, M*0.004, M*0.015, 4)`

**Estimated LOC**: ~50 lines across [`ArmUnit._createMesh()`](js/entities/ArmUnit.js:280) and [`PlayerSatellite._buildStruts()`](js/entities/PlayerSatellite.js:568)

---

### 2.5 Daughter Shape and External Equipment

**Current State** ([`ArmUnit._createMesh()`](js/entities/ArmUnit.js:280)):
- **Body**: `BoxGeometry` — Weaver: 0.2×0.2×0.3m (blue), Spinner: 0.1×0.1×0.15m (green)
- **Solar**: ROSA-style chamfered wings extending ±Y
- **Thruster**: Single rear FEEP nozzle + plume cone
- **Net canister**: Forward cylindrical canister
- **Other**: PV panel, MRR reflector, status LED, EPM dock plate

**What's Missing for Full Daughter Design**:

| Equipment | Purpose | Current | Needed |
|-----------|---------|---------|--------|
| **Fore thruster** | Braking/attitude | None | Smaller nozzle at +Z face |
| **Aft thruster (larger)** | Main propulsion | Single nozzle | Confirm size correct, add glow ring |
| **Scanning sensor** | Debris inspection | None | Forward-facing dish/aperture |
| **Visual camera** | Close-range inspection | None | Small cylinder lens barrel |
| **Comms antenna** | 10km link to mother | MRR reflector exists | Add small patch antenna or horn |
| **Scavenging tools** | Material recovery | None | Gripper jaws or manipulator arm |
| **Bridle attachment** | Load distribution | Not visual | Ring/gimbal at tether attach point |

**Proposed Daughter Form Factor**:

**Weaver (large, 11kg)**:
- Elongated hexagonal prism body (not box) — `CylinderGeometry(bx*M, bx*M, bz*M, 6)`
- Fore thruster: 2 × small RCS nozzles at ±X on front face
- Aft thruster: Main FEEP nozzle (existing) + glow ring + outer glow halo
- Scanner: Small parabolic dish on top-forward (hemisphere + ring)
- Camera: Tiny cylinder barrel on front face offset from centerline
- Comms: Patch antenna (flat square) on top surface
- Gripper: 2-jaw mechanism at front underside (2 × angled box primitives)

**Spinner (small, 3.7kg)**:
- Compact elongated box is appropriate for mass — keep `BoxGeometry` but with chamfered edges (beveled `ExtrudeGeometry`)
- Single rear thruster + 2 RCS
- Camera lens barrel on front
- Gecko pad surface visible on bottom face (textured plane with grid pattern)

**ROSA Clearance with Bridle**:
Per current code, ROSA wings extend ±Y from daughter body. The bridle ring would be at the tether attach point (top of daughter or strut tip). Since ROSA extends perpendicular to the tether axis, there is no geometric interference — **ROSA clears the bridle by design**.

**Estimated LOC**: ~120 lines rewrite of [`_createMesh()`](js/entities/ArmUnit.js:280)

---

### 2.6 Bridle Design — Geometry and Gimbal

**Current State** ([`BridleRing.js`](js/entities/BridleRing.js:1)):
- **Pure data module** — no visual geometry. Tracks attach points, load distribution, balance factor.
- 3 attach points per ring (configurable), load per point max, overload detection.
- States: IDLE, LOADED, OVERLOADED.

**Proposed Bridle Visual Design**:

```
  Tether from reel
        │
        ▼
   ┌─── GIMBAL ───┐    ← 1-axis or 2-axis gimbal joint
   │   (ball/socket)│
   └───────┬───────┘
           │
    ╱──────┼──────╲
   ╱       │       ╲    ← Bridle ring (triangular or Y-harness)
  ◯────────◯────────◯   ← 3 attach points
  │        │        │
  [Daughter body]       ← connects to daughter's top EPM docking collar
```

**Gimbal specification**:
- **Location**: At tether-to-bridle junction (top of daughter assembly)
- **Type**: 2-axis gimbal (pitch + yaw), allowing ±30° freedom in each axis
- **Geometry**: Small sphere or torus representing the ball joint
- **Spring return**: Yes — spring-loaded return to center on gimbal failure (passive safety)
- **One gimbal, not two**: Single gimbal between tether and bridle ring. The bridle ring itself distributes load to 3 points on the daughter.

**Three.js Approach**:
- Gimbal ball: `SphereGeometry(M*0.015, 6, 6)` at tether termination
- Bridle lines: 3 × `Line2` from gimbal to attach points on daughter body
- Attach point markers: 3 × `SphereGeometry(M*0.005, 4, 4)` at 120° spacing around daughter top
- Ring (optional): `RingGeometry(M*0.03, M*0.035, 12)` horizontal ring below gimbal

**Estimated LOC**: ~60 lines new visual code, added to daughter mesh hierarchy

---

### 2.7 Crossbow Bracket

**Current State** ([`PlayerSatellite._buildStruts()`](js/entities/PlayerSatellite.js:628)):
- `BoxGeometry(M*0.04, M*0.08, M*0.03)` — simple rectangular bracket at 95% strut length
- Named `SpringMount_${i}`

**Proposed Design**:
The crossbow bracket is the spring-loaded launch mechanism. It should look like a rail guide with a compressed spring visible:
- **Rail channels**: 2 parallel thin boxes (the guide rails daughter slides along)
- **Spring coil**: Helix geometry or stacked disc representation between rail end and daughter back
- **Latch pin**: Small cylinder across the rails (holds daughter until fire command)
- **Recoil buffer**: Small box at spring base

**Three.js Approach**:
- Rails: 2 × `BoxGeometry(M*0.005, M*0.10, M*0.01)` at ±12mm offset
- Spring visual: `TorusGeometry(M*0.01, M*0.003, 4, 8)` stacked 3x, or single stretched torus
- Latch: `CylinderGeometry(M*0.003, M*0.003, M*0.03, 4)` across rails

**Estimated LOC**: ~45 lines replacing current ~8 lines

---

### Concern 1 Summary

| Part | Current LOC | New LOC | Δ | File |
|------|------------|---------|---|------|
| Double-A Hinge | ~50 | ~80 | +30 | [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:462) |
| Oval Strut | ~15 | ~30 | +15 | [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:568) |
| Reel Cartridge | ~10 | ~40 | +30 | [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:617) |
| EPM Attachment | ~10 | ~50 | +40 | [`ArmUnit.js`](js/entities/ArmUnit.js:451), [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:610) |
| Daughter Redesign | ~180 | ~300 | +120 | [`ArmUnit.js`](js/entities/ArmUnit.js:280) |
| Bridle Visual | 0 | ~60 | +60 | New section in [`ArmUnit.js`](js/entities/ArmUnit.js:280) |
| Crossbow Bracket | ~8 | ~45 | +37 | [`PlayerSatellite.js`](js/entities/PlayerSatellite.js:628) |
| **Total** | **~273** | **~605** | **+332** | |

**Risk**: High — touching the visual model can break existing strut sweep animation, dock offsets, and tether attachment points. Integration testing with all 25 feature flags is essential.

---

## 3. Concern 2: Deploy All 4 Struts + Hotkey

### Current State

**Deploy flow**:
1. [`ArmManager.strutDeployArm(armIndex, targetAlpha)`](js/entities/ArmManager.js:972) — deploys single arm's strut
2. [`ArmManager.strutDeployAll(targetAlpha, staggerMs=200)`](js/entities/ArmManager.js:1012) — deploys ALL arms with stagger delay
3. Both delegate to [`ArmUnit.strutDeploy(targetAlpha)`](js/entities/ArmUnit.js:1340) which transitions `STOWED → DEPLOYING → DEPLOYED`
4. Gated by `FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE`

**Current hotkeys** ([`InputManager.js`](js/systems/InputManager.js:448)):
- `G` — deploy arm (fire daughter toward target)
- `Shift+G` — deploy trawl net
- `H` — recall all arms
- `1-8` — select arm by index (number keys)
- **No hotkey exists for "deploy all struts" or "open struts"**

**How `strutDeployAll()` is called**: Currently only from [`LaunchSequence.js`](js/systems/LaunchSequence.js:1) during the launch phase LAUNCH_LOCK_RELEASE, NOT from any player hotkey.

### Proposed Design

**Hotkey**: `O` for "Open" (strut deploy all)

**Behavior**:
1. Press `O` → calls `armManager.strutDeployAll(Math.PI/2)` — deploys all struts to equatorial (α=π/2, pointing radially outward)
2. If a target is selected and a specific strut is selected (number key), that strut should orient toward the target azimuth before firing
3. `Shift+O` → stow all struts (reverse)

**"Orient toward target" behavior**:
- When pressing `G` to fire a daughter, the selected strut's `targetAlpha` should be computed from the target's position relative to the mother
- [`AimDecomposition.js`](js/systems/AimDecomposition.js) already computes aim alpha from target position
- The deploy sequence: `strutDeploy(computedAlpha)` → wait for DEPLOYED → then `deployArm(target)`

### Implementation Approach

```
InputManager._handleKeyDown():
  case 'KeyO':
    if (isGameplay && armManager) {
      if (e.shiftKey) {
        armManager.strutStowAll();  // needs new method
      } else {
        armManager.strutDeployAll(Math.PI / 2, 200);
      }
    }
```

**Files to modify**:
- [`InputManager.js`](js/systems/InputManager.js:448) — add `KeyO` handler (~15 LOC)
- [`ArmManager.js`](js/entities/ArmManager.js:1012) — add `strutStowAll()` method (~20 LOC)

**Estimated effort**: 0.5 day · **Risk**: Low — additive, no existing code modified

---

## 4. Concern 3: Camera Near-Clip Cutting Solar Panels

### Current State

**Camera configuration**:
- Near plane: `CAMERA_NEAR = 0.0001` (~10m) at [`Constants.js:32`](js/core/Constants.js:32)
- `logarithmicDepthBuffer: true` at [`SceneManager.js:27`](js/scene/SceneManager.js:27) — this should handle the extreme near/far ratio

**Orbit camera zoom**:
- `minDistance: 0.00015` (~15m) at [`CameraSystem.js:127`](js/systems/CameraSystem.js:127)
- `maxDistance: 0.01` at [`CameraSystem.js:128`](js/systems/CameraSystem.js:128)

**ROSA panel extent**:
- Panel width: `ROSA_WIDTH = 1.0m`, length: `ROSA_LENGTH = 2.0m`
- Barrel radius: 0.4m
- Total span from center: 0.4m (barrel) + 1.0m (panel) + chamfer = ~1.5m each side
- In scene units: `1.5 * M = 0.000015`

**The Problem**:
At minimum zoom distance (0.00015 = 15m), the camera is ~15m from the spacecraft center. The ROSA panels extend ~1.5m from center (0.000015 in scene units). At this distance, the panels are well within the near clipping plane distance. The issue is likely that in **ORBIT view**, the camera can orbit freely and approach from the side, putting it very close to the panel tips.

However, the real issue is more subtle: when zoomed in close and the camera is near the panel plane, the near clip distance of 0.0001 (10m) means any geometry within 10m of the camera is clipped. If the camera is 15m from center and a panel extends 1.5m toward the camera, the panel tip is 13.5m from camera — still within the near plane. But if the player orbits to look at the panels edge-on from close range, parts of the panel geometry may fall inside the 10m near clip.

### Proposed Fix

**Option A: Reduce near plane** (simplest):
```javascript
CAMERA_NEAR: 0.00001,  // ~1m minimum (was 10m)
```
With `logarithmicDepthBuffer: true`, this is safe — log depth buffer handles extreme near/far ratios.

**Option B: Increase minimum orbit distance**:
```javascript
orbit.minDistance: 0.0003,  // ~30m (was 15m)
```
This keeps the camera farther from the spacecraft but may feel restrictive.

**Option C: Dynamic near plane** (best UX):
In [`CameraSystem.update()`](js/systems/CameraSystem.js), compute near plane based on camera distance to player:
```javascript
const distToPlayer = camera.position.distanceTo(playerPos);
camera.near = Math.max(0.00001, distToPlayer * 0.1);  // 10% of distance, min 1m
camera.updateProjectionMatrix();
```

**Recommendation**: **Option A** — just reduce `CAMERA_NEAR` to `0.00001`. The logarithmic depth buffer makes this safe with no performance cost. The existing far plane of 500 means a near/far ratio of 50,000,000:1 which is exactly what logZ was designed for.

**Files to modify**: [`Constants.js:32`](js/core/Constants.js:32) — 1 line change

**Estimated effort**: 15 minutes · **Risk**: Very Low

---

## 5. Concern 4: ROSA "Shadows" — Bloom Pass Dark Halo (REVISED)

### Current State

Shadow maps ARE disabled (`renderer.shadowMap.enabled = false` at [`SceneManager.js:39`](js/scene/SceneManager.js:39)). No lights have `castShadow = true`. But the user sees **dark outlines around ROSA panels on Earth AND in space**.

### Root Cause — UnrealBloomPass Extraction Artifact

The `UnrealBloomPass` at [`SceneManager.js:107`](js/scene/SceneManager.js:107) (threshold=1.2, strength=0.15, radius=0.4) extracts bright pixels and creates a glow texture. Dark objects (ROSA panels: color `0x0a1133`) silhouetted against bright backgrounds (Earth dayside, specular ocean glints) create a **negative bloom zone** — the extraction subtracts bloom energy from neighboring pixels, producing visible dark halos. This is a known Three.js UnrealBloomPass artifact.

Visible against Earth (panel crosses bright surface) and in space (panel edge near sun sprites or emissive materials).

### Proposed Fix

**Part A**: Raise bloom threshold from 1.2 → 1.5 at [`SceneManager.js:107`](js/scene/SceneManager.js:107) — fewer Earth-surface pixels trigger bloom
**Part B**: Boost ROSA panel emissive from `0x050520/0.15` → `0x080830/0.20` at [`PlayerSatellite.js:794`](js/entities/PlayerSatellite.js:794) — reduces contrast dip
**Part C** (if needed): Bloom isolation render layer for satellite group (~40 LOC)

See **§14.1** for full technical analysis.

**Estimated effort**: 30 min (A+B) · **Risk**: Low — test sun disc bloom visually after threshold change

---

## 6. Concern 5: Daughter Launch Transition Too Abrupt

### Current State

**G key launch flow** ([`InputManager.js:448`](js/systems/InputManager.js:448)):
1. Player presses `G`
2. `deployArm()` is called → [`GameFlowManager.deployArm()`](js/systems/GameFlowManager.js:1334) → `armManager.deployArm(target)`
3. After 2500ms timeout, `_enterArmPilotCamera(arm)` is called
4. Camera transitions to ARM_PILOT view via `setView(CameraViews.ARM_PILOT)` with a standard 0.5s transition

**The problem**: The 2.5s delay exists but:
- There's no visual cue that a daughter is launching (no camera movement toward it)
- The camera suddenly snaps to following the tiny daughter unit
- The 0.5s view transition (`_transitionDuration = 0.5`) is too fast for such a dramatic perspective change
- No "launch ceremony" — no zoom or dolly to show the daughter separating

**Camera ARM_PILOT transition** ([`CameraSystem.js:647`](js/systems/CameraSystem.js:647)):
```javascript
enterArmPilot(arm) {
    this.armPilot.arm = arm;
    // Smooth look-direction blend (1.5s)
    this.armPilot._lookBlendTime = 0;
    this.armPilot._lookBlendDuration = 1.5;
    this.armPilot._prevForward = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(this.camera.quaternion);
    // Narrow FOV for arm camera
    this.setView(CameraViews.ARM_PILOT);
}
```

There IS a look-blend (1.5s), but the position jump (from chase offset to arm offset) happens in one 0.5s transition.

### Proposed Design — "Launch Ceremony" Camera Sequence

**3-phase transition over ~5 seconds total**:

| Phase | Duration | Camera Behavior | Player Sees |
|-------|----------|----------------|------------|
| 1. **Hold** | 1.0s | Stay in current view, zoom slightly toward active strut | Strut deploys, daughter separates |
| 2. **Dolly** | 2.0s | Smooth camera dolly from mother toward daughter's trajectory | Following the daughter's path outward |
| 3. **Lock** | 2.0s | Transition to ARM_PILOT with extended look-blend | Camera settles behind daughter |

**Implementation**:
1. Add `_launchCeremonyState` to CameraSystem: `{ phase: 0, timer: 0, arm: null }`
2. On G key, instead of raw `setTimeout`, emit `LAUNCH_CEREMONY_START` event
3. CameraSystem enters a 3-phase interpolation in its `update()` loop
4. Phase 1: Lerp chase offset to zoom toward strut tip (compute strut tip world position)
5. Phase 2: Lerp camera position from strut tip vicinity toward arm position along its velocity vector
6. Phase 3: Call `enterArmPilot()` with extended `_lookBlendDuration = 2.0`

**Comms integration**: At each phase, emit contextual messages:
- Phase 1: `"Daughter XX separating..."`
- Phase 2: `"Tracking daughter XX..."`
- Phase 3: `"ARM PILOT engaged — following XX"`

**Files to modify**:
- [`CameraSystem.js`](js/systems/CameraSystem.js) — new `_launchCeremony*` methods (~80 LOC)
- [`InputManager.js:448`](js/systems/InputManager.js:448) — replace `setTimeout` with event emission (~10 LOC)
- [`GameFlowManager.js`](js/systems/GameFlowManager.js) — wire ceremony event (~15 LOC)

**Estimated effort**: 1 day · **Risk**: Medium — camera state machine changes are delicate

---

## 7. Concern 6: Comms Panel Dimming

### Current State

**Dimming mechanism** ([`HUD.js`](js/ui/HUD.js)):
- All HUD panels use a **skill-based progressive reveal** system
- Panels have `data-hud-group` attributes (e.g., `manage_comms`)
- CSS class `hud-dormant` applies `opacity: 0.5` at [`HUD.js:310`](js/ui/HUD.js:310)
- CSS class `hud-active` applies `opacity: 1.0`
- Comms panel starts dormant at [`CommsPanel.js:115`](js/ui/hud/CommsPanel.js:115): `this.panels.comms.classList.add('hud-dormant')`

**Activation trigger**:
- The comms panel's `hudGroup` is `manage_comms`
- It becomes active when the `COMMS_OPENED` event fires (from C-key press or boot sequence)
- The boot sequence emits `COMMS_OPENED` after 1000ms at [`GameFlowManager.js:191`](js/systems/GameFlowManager.js:191)

**The problem**: If the `COMMS_OPENED` event fires but the skills system doesn't register `manage_comms` as discovered, or if the HUD `_applyRevealGroups()` doesn't include it, the panel stays dimmed.

Looking at [`HUD.js:491`](js/ui/HUD.js:491):
```javascript
const commsActive = this._skillActiveGroups.has('comms');
this.panels.comms.style.opacity = commsActive ? '' : '0.5';
```
The comms panel has **separate** opacity handling — it checks for the `comms` group (not `manage_comms`), which may be a mismatch.

### Proposed Fix

**Option A: Ensure `manage_comms` maps correctly**:
Check that `COMMS_OPENED` event triggers skill discovery for `manage_comms`, and that the HUD `_skillActiveGroups` set includes it.

**Option B: Force comms always active** (simpler):
Remove the dormant class from comms panel initialization — comms should always be visible since the game starts with boot messages appearing.

```javascript
// CommsPanel.js:115 — remove:
// this.panels.comms.classList.add('hud-dormant');
```

And in HUD.js, always show comms at full opacity:
```javascript
// HUD.js:491 — change to:
this.panels.comms.style.opacity = '';  // always full
```

**Recommendation**: Option B — comms is a primary information channel and should never be dimmed. The progressive reveal should apply to other panels (fleet, orbit MFD) but not comms.

**Files to modify**:
- [`CommsPanel.js:115`](js/ui/hud/CommsPanel.js:115) — remove dormant class (~1 LOC)
- [`HUD.js:491`](js/ui/HUD.js:491) — force comms opacity to always be 1.0 (~2 LOC)

**Estimated effort**: 30 minutes · **Risk**: Very Low

---

## 8. Concern 7: Auto-Target After 2nd Capture

### Current State

**There are TWO auto-target handlers**:

**Handler 1** — [`InputManager.js:110`](js/systems/InputManager.js:110) (runs on `ARM_CAPTURED` / `LASSO_CAPTURED`):
```javascript
const handleCaptureAdvance = (capturedId) => {
    // Mark captured, clear current target
    d.targetSelector.clearTarget();
    // Get enhanced target list, filter captured, pick best
    const targets = d.debrisField.getEnhancedTargetList(...)
        .filter(t => t.id !== capturedId && !t._captured);
    if (targets.length > 0) {
        const next = targets[0];
        d.targetSelector.setTarget(debris, { distanceKm, deltaV });
        // Also update wireframe, HUD, reticle, navSphere
    }
};
```

**Handler 2** — [`GameFlowManager.js:811`](js/systems/GameFlowManager.js:811) (runs on `DEBRIS_CAPTURED`):
```javascript
targetSelector.setTarget(null);
const nearby = debrisField.getDebrisNear(playerPos, 0.5);
const nextTarget = nearby.find(d => d.discovered);
if (nextTarget) {
    targetSelector.setTarget(original, { autoTarget: true });
}
```

### The Bug

The event flow after capture is:
1. `ARM_CAPTURED` / `LASSO_CAPTURED` fires → InputManager Handler 1 runs → auto-selects next target ✓
2. Later, when debris is delivered to mother: `DEBRIS_CAPTURED` fires → GameFlowManager Handler 2 runs → **clears target** (`setTarget(null)`) then tries to re-select

**For the 1st capture**: Both handlers run. Handler 1 picks a target. Handler 2 may also pick one (or the same one). Works by accident.

**For the 2nd capture**: Handler 1 runs. But if `getEnhancedTargetList()` throws (e.g., because the debris field has been modified between captures and data is stale), it's caught by the empty `catch (err) {}` block and silently fails. Then Handler 2 runs, clears the target again, and `getDebrisNear()` may not find a `discovered` target if discovery state is inconsistent.

**Root cause candidates**:
1. `getEnhancedTargetList()` may fail on 2nd+ capture when orbital elements are stale
2. Handler 2 unconditionally calls `setTarget(null)` — overrides Handler 1's selection
3. The `_captured` flag set by Handler 1 may not prevent the debris from appearing in Handler 2's `getDebrisNear()` results
4. Race condition: if Handler 1 and Handler 2 fire on different frames, the target may be cleared after being set

### Proposed Fix

**Consolidate to single handler**: Remove the auto-target logic from `GameFlowManager.js` Handler 2. The InputManager handler fires on the actual capture event (immediate), which is the right time to select next target. The `DEBRIS_CAPTURED` handler should only handle delivery accounting (cargo, scoring, save), not target selection.

```javascript
// GameFlowManager.js:811 — REMOVE these lines:
// targetSelector.setTarget(null);           // ← DELETE
// const nearby = debrisField.getDebrisNear(...);  // ← DELETE
// ... nextTarget logic ...                 // ← DELETE
```

Also **add error reporting** to the InputManager handler:
```javascript
} catch (err) {
    console.warn('[InputManager] Auto-target failed:', err.message);
}
```

**Files to modify**:
- [`GameFlowManager.js:811`](js/systems/GameFlowManager.js:811) — remove duplicate auto-target (~12 LOC removed)
- [`InputManager.js:141`](js/systems/InputManager.js:141) — add error logging (~1 LOC)

**Estimated effort**: 2 hours · **Risk**: Medium — must verify both `ARM_CAPTURED` and `LASSO_CAPTURED` paths work after consolidation

---

## 9. Concern 8: Scan Reward Gaming

### Current State

**Scan reward logic** ([`SensorSystem.js:384`](js/systems/SensorSystem.js:384)):
```javascript
eventBus.emit(Events.SCORING_AWARD, {
    points: cfg.REWARD,
    reason: type === 'quick' ? 'Quick scan survey data' : 'Deep scan survey data',
});
```

**Reward values** ([`Constants.js:574`](js/core/Constants.js:574)):
- Quick scan: **50 credits**, 3s cooldown, 0.3s duration → **~16.7 credits/second** sustained
- Wide scan: **150 credits**, 8s cooldown, 4s duration → **~12.5 credits/second** sustained

**Anti-spam protections currently in place**:
- Quick scan has 3s cooldown (so max 20 scans/minute = 1000 credits/minute)
- Wide scan has 8s cooldown (max 7.5 scans/minute)
- Both require sensor bus power (gated by `powerDistribution.sensorMultiplier`)

**What's missing**:
- No per-target deduplication — scanning the same area repeatedly awards full credits
- No diminishing returns — 100th scan pays same as 1st
- No cap on total scan income per mission

### Proposed Anti-Spam Design

**Tiered approach** (implement all three):

| Protection | Mechanism | Values |
|-----------|-----------|--------|
| **Per-target one-time bonus** | Track scanned debris IDs; 1st scan of new target awards bonus (+25 credits), subsequent scans of same debris award 0 bonus | `Set<debrisId>` in SensorSystem |
| **Diminishing returns** | Each successive scan in a session multiplies reward by 0.95^n (where n = total quick scans) | Floor at 10 credits minimum |
| **Session cap** | Total scan credits capped at 2000 per mission | Counter in SensorSystem, emit warning at 80% |

**Example reward curve**:
- Scan 1: 50 credits + 25 new-target bonus = 75
- Scan 5: 50 × 0.95⁴ = 41 credits
- Scan 10: 50 × 0.95⁹ = 31 credits  
- Scan 20: 50 × 0.95¹⁹ = 19 credits
- Scan 33+: 10 credits (floor)

### Implementation

```javascript
// SensorSystem.js additions:
this._scanCount = 0;
this._scanCreditsTotal = 0;
this._scannedIds = new Set();
const SCAN_CREDIT_CAP = 2000;
const SCAN_DECAY = 0.95;
const SCAN_FLOOR = 10;
const SCAN_NEW_TARGET_BONUS = 25;

// In _completeScan():
this._scanCount++;
let reward = cfg.REWARD * Math.max(SCAN_FLOOR / cfg.REWARD, SCAN_DECAY ** (this._scanCount - 1));
reward = Math.floor(reward);

// New-target bonus
let newTargetBonus = 0;
for (const d of this.detectedTargets) {
    if (!this._scannedIds.has(d.id)) {
        this._scannedIds.add(d.id);
        newTargetBonus += SCAN_NEW_TARGET_BONUS;
    }
}
reward += newTargetBonus;

// Session cap
if (this._scanCreditsTotal + reward > SCAN_CREDIT_CAP) {
    reward = Math.max(0, SCAN_CREDIT_CAP - this._scanCreditsTotal);
}
this._scanCreditsTotal += reward;
```

**Files to modify**:
- [`SensorSystem.js:369`](js/systems/SensorSystem.js:369) — add diminishing returns + cap (~30 LOC)
- [`Constants.js:569`](js/core/Constants.js:569) — add `SCAN_CREDIT_CAP`, `SCAN_DECAY`, `SCAN_FLOOR`, `SCAN_NEW_TARGET_BONUS` (~5 LOC)

**Estimated effort**: 0.5 day · **Risk**: Low

---

## 10. Concern 9: Reticle Text Flashing

### Current State

**Two separate Canvas2D overlays exist**:
1. [`TargetReticle.js`](js/ui/TargetReticle.js:1) — full-screen canvas at z-index unspecified (created via DOM append)
2. [`DockingReticle.js`](js/ui/DockingReticle.js:1) — full-screen canvas at z-index 12 (`_createCanvas()` at line [108](js/ui/DockingReticle.js:108))

**DockingReticle visibility** ([`DockingReticle.js:91`](js/ui/DockingReticle.js:91)):
```javascript
eventBus.on(Events.GAME_STATE_CHANGE, ({ to }) => {
    const gameplay = (to === ORBITAL_VIEW || to === APPROACH || to === INTERACTION);
    if (!gameplay) this.setVisible(false);
});
```
It's shown/hidden based on ARM_PILOT mode, but the visibility is managed externally by InputManager when entering/exiting arm pilot mode.

**TargetReticle visibility**: Controlled by view config — it renders for ALL debris targets when visible.

**The flashing problem**: When both canvases render simultaneously (which shouldn't normally happen since DockingReticle is ARM_PILOT-only), text from both overlays at similar screen positions would alternate each frame. But even outside ARM_PILOT, the TargetReticle renders:
- Distance text: `${distKm}m` at [`TargetReticle.js:818`](js/ui/TargetReticle.js:818)
- Closure rate: `m/s` at [`TargetReticle.js:832`](js/ui/TargetReticle.js:832)
- Metal loot: at [`TargetReticle.js:853`](js/ui/TargetReticle.js:853)

**Likely root cause**: The "flashing" is probably caused by the **TargetReticle** drawing text labels that overlap with the **selected target's** different frame computations. Specifically:

1. The TargetReticle draws closure rate text that includes "m/s" — if the closure rate oscillates near zero, the text toggles between `▼0 m/s` and `~0 m/s` each frame (different arrow + text width = position jitter)
2. The `_closureRate` computation uses frame-to-frame distance differences, which with orbital mechanics can oscillate sign rapidly at close range
3. The "spent" text likely comes from deltav spent indicator near the prograde marker, which also updates per-frame

### Proposed Fix

**Two-part fix**:

**Part A — Hysteresis for closure rate display**:
```javascript
// TargetReticle.js — add smoothing to closure rate text:
if (Math.abs(rate) < 1.0) {
    // Deadband: don't flip arrow direction for tiny rates
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillText('~0 m/s', x, y + half + 26);
} else {
    // Only change arrow/color when rate is significant
}
```
The current threshold is 0.5 m/s — increase to **1.0 m/s** deadband.

**Part B — Ensure DockingReticle hides when not in ARM_PILOT**:
Add an explicit guard in DockingReticle's update/render:
```javascript
if (!this._visible || !this._arm) {
    this._canvas.style.display = 'none';
    return;
}
```

**Part C — Text position stability**:
Use fixed-width formatting for distance/rate text to prevent position jitter:
```javascript
const distText = distKm < 1
    ? `${(distKm * 1000).toFixed(0).padStart(4)}m`
    : `${distKm.toFixed(1).padStart(5)}km`;
```

**Files to modify**:
- [`TargetReticle.js:826`](js/ui/TargetReticle.js:826) — increase deadband, add padStart formatting (~10 LOC)
- [`DockingReticle.js`](js/ui/DockingReticle.js) — add visibility guard (~3 LOC)

**Estimated effort**: 2 hours · **Risk**: Low

---

## 11. Revised Task Plan

### How the 9 Concerns Map to V-7, V-8, V-9 and New Tasks

| Existing Task | Original Scope | Added Concerns | New Scope |
|---------------|---------------|----------------|-----------|
| **V-7: Launch Cinematic** | Fairing sep, orbit insertion camera work | Concern 5 (daughter launch transition) | Cinematic + daughter launch ceremony camera |
| **V-8: Capture Net Visual** | Net mesh, flight trail, tangle visual | Concern 1 (partial: bridle visual) | Net visual + bridle geometry |
| **V-9: Tier Progression** | Y0→Y1→Y3 visual upgrade animations | Concern 1 (partial: strut/hinge design matters for tier vis) | Tier progression + ensure parts look right at each tier |

| New Task | Source | Scope | Priority |
|----------|--------|-------|----------|
| **V-12: Mechanical Part Visual Upgrade** | Concern 1 | Double-A hinge, oval strut, reel cartridge, crossbow bracket, daughter redesign, EPM | High |
| **V-13: Strut Deploy Hotkey** | Concern 2 | `O` key → strutDeployAll, `Shift+O` → strutStowAll | Medium |
| **V-14: Scan Economy Balance** | Concern 8 | Diminishing returns, per-target bonus, session cap | Medium |
| **Hotfix-A: Near Clip** | Concern 3 | Reduce CAMERA_NEAR to 0.00001 | High |
| **Hotfix-B: Auto-Target Fix** | Concern 7 | Remove duplicate handler in GameFlowManager | High |
| **Hotfix-C: Reticle Flash** | Concern 9 | Closure rate deadband, text formatting | High |
| **Hotfix-D: Comms Dimming** | Concern 6 | Force comms always active | Medium |
| **Hotfix-E: Bloom Shadow** | Concern 4 (REVISED) | Raise bloom threshold + ROSA emissive | High |
| **V-15: Inspection Camera** | Concern 3 (expanded) | 2m–50m orbit mode with dynamic near-plane | Medium |
| **V-16: ROSA Gold Edge** | Concern 1 (addl.) | Gold anodized frame on all ROSA panels | Medium |
| **V-17: Cable Harness** | Concern 1 (addl.) | External cable tube + clips along struts | Low |
| **V-18: SST Database** | Concern 8 (expanded) | Per-target scan gating + catalog counter HUD | Medium |

---

## 12. Recommended Implementation Order

### Phase 1: Hotfixes (Day 1, morning)

These are quick wins that immediately improve the player experience:

| # | Task | Est. Time | Rationale |
|---|------|-----------|-----------|
| 1 | **Hotfix-A**: Near clip (`Constants.js:32`) | 15 min | Visible bug, 1-line fix |
| 2 | **Hotfix-B**: Auto-target fix (`GameFlowManager.js:811`) | 1 hour | Gameplay-breaking on repeat captures |
| 3 | **Hotfix-C**: Reticle flash (`TargetReticle.js:826`) | 1 hour | Distracting visual noise |
| 4 | **Hotfix-D**: Comms dimming (`CommsPanel.js:115`, `HUD.js:491`) | 30 min | HUD readability |
| 5 | **Hotfix-E**: Bloom shadow fix (`SceneManager.js:107`, `PlayerSatellite.js:794`) | 30 min | Dark halo around panels on Earth |

**Total Phase 1**: ~4 hours

### Phase 2: Controls + Economy + Camera (Day 1, afternoon → Day 2)

| # | Task | Est. Time | Rationale |
|---|------|-----------|-----------|
| 6 | **V-13**: Strut deploy hotkey (`InputManager.js`, `ArmManager.js`) | 4 hours | Enables strut management UX before visual upgrade |
| 7 | **V-15**: Inspection camera mode (`CameraSystem.js`) | 4 hours | Required to see detail work from Phase 3 |
| 8 | **V-18**: Scan reward redesign — per-target gating + SST database (`SensorSystem.js`) | 8 hours | Sustainable economy for Epic 11 mission architecture |

**Total Phase 2**: ~2 days

### Phase 3: Mechanical Visual Upgrade (Days 3–7)

| # | Task | Est. Time | Rationale |
|---|------|-----------|-----------|
| 9 | **V-12a**: Double-A hinge replacement | 4 hours | Foundation — all struts attach here |
| 10 | **V-12b**: Oval strut + rib details | 2 hours | Visual upgrade, minimal risk |
| 11 | **V-16**: ROSA gold anodized edge frame | 2 hours | Visual clarity against Earth/space |
| 12 | **V-12c**: Reel cartridge redesign | 3 hours | New reel visual on struts |
| 13 | **V-17**: External cable harness + clips | 3 hours | Power/data routing along strut exterior |
| 14 | **V-12d**: Crossbow bracket redesign | 3 hours | Spring mount at strut tip |
| 15 | **V-12e**: EPM attachment mechanism | 4 hours | Both mother (strut tip) and daughter sides |
| 16 | **V-12f**: Daughter body redesign (hex Weaver, beveled Spinner) | 8 hours | Full ArmUnit mesh replacement — largest single task |
| 17 | **V-12g**: Wishbone bridle + gimbal (FEEP plume exclusion) | 5 hours | Y-harness routes around ion exhaust cone |

**Total Phase 3**: ~4.25 days

### Phase 4: Cinematic + Net Visual (Days 7–10)

| # | Task | Est. Time | Rationale |
|---|------|-----------|-----------|
| 18 | **V-7**: Launch cinematic (expanded with Concern 5 — 3-phase launch ceremony camera) | 8 hours | Camera system + daughter launch ceremony |
| 19 | **V-8**: Capture net visual + bridle integration | 8 hours | Net mesh + flight particle trail + existing bridle |
| 20 | **V-9**: Tier progression visual | 6 hours | Y0→Y1→Y3 arm count changes + collar resize |

**Total Phase 4**: ~2.75 days

### Grand Total: ~10 days (including hotfixes, expanded scope)

Critical path: Phase 1 hotfixes → Phase 2 camera + scan → Phase 3 visuals → Phase 4 cinematic.
Phase 3 is the longest and highest-risk segment. The wishbone bridle (V-12g) and daughter redesign (V-12f) are the two most complex sub-tasks and should be paired for integration testing.

---

## 13. Visual Design Specification

### 13.1 S3.1 Hinge Design Specification — Double-A Clevis with Weight-Saved A-Frames

> **Sprint 3, Task 1** · Replaces the current cylinder-pin hinge in [`_buildCollar()`](js/entities/PlayerSatellite.js:462)
> with a mechanically-detailed Double-A clevis assembly using topology-optimized bracket profiles.

---

#### 13.1.1 Material Selection Table

Real spacecraft hinge engineering drives every choice below. The collar is the primary
structural ring; A-frames are bolted clevis brackets; the pin is a hardened journal
rotating in polymer bushings (not metal-on-metal, to prevent vacuum cold-welding).

| Part | Material | Alloy / Grade | Rationale | Color Hex | Metalness | Roughness |
|------|----------|--------------|-----------|-----------|-----------|-----------|
| **Collar ring** | Machined aluminum | 7075-T6 | Standard spacecraft bus structural ring (Boeing 702, Northrop LM400, ESA Eurostar). Highest-strength aluminum alloy (UTS 572 MPa). Clear-anodized finish. | `0x8888a0` | 0.75 | 0.28 |
| **Collar flange bolts** | Titanium | Ti-6Al-4V | Lightweight fasteners at collar-barrel interface. 12× M4 cap-head per collar quadrant. | `0x99aabb` | 0.80 | 0.20 |
| **A-frame brackets** | Forged + CNC aluminum | 6061-T6 | Better fatigue life than 7075 at bolt holes. Same alloy as bicycle fork dropouts — the closest terrestrial analogue to a clevis hinge bracket. CFRP rejected: stress concentrations at bolt holes require metal inserts, eliminating weight advantage at this scale. | `0x9090a8` | 0.72 | 0.30 |
| **Pivot pin** | Precipitation-hardened stainless | 17-4PH (H1025) | Harder than bracket (42 HRC vs. Al), so pin wears the cheap replaceable bushing. Standard aerospace hinge pin material. ∅10mm × 70mm span. Mass: ~43g. | `0xaabbcc` | 0.85 | 0.15 |
| **Bushings** | Polyimide | Vespel SP-1 (DuPont) | **Critical for vacuum**: bronze-on-steel cold-welds without lubrication. Vespel is the standard aerospace journal bushing — used on JWST deployment hinges, ISS SARJ alpha joint, Hubble solar array drive. Self-lubricating, -240°C to +300°C, no outgassing. | `0x8b6914` | 0.15 | 0.70 |
| **Brake disc** | Hardened stainless | 440C | Wear-resistant disc for friction brake. Prevents free-swing during reel operations. | `0x555566` | 0.70 | 0.35 |
| **Mounting pad (on collar)** | Integral with collar | 7075-T6 | CNC-machined flat on collar OD. Not a separate part — just a faced surface on the ring forging. | (same as collar) | — | — |
| **LED indicator** | — | — | Status LED forward of mount (green=stowed, amber=transit, red=locked). | `0x00ff44` | — (Basic) | — |

**Why not titanium A-frames?** Ti-6Al-4V would save ~40% mass per bracket, but at this scale (each bracket ~60g in 6061-T6, would be ~35g in Ti) the 25g saving × 8 brackets = 200g total is trivial for a 242 kg spacecraft. The 5× material cost and 3× machining cost aren't justified. Titanium is reserved for the pin where hardness matters.

**Why not carbon fiber A-frames?** CFRP brackets require bonded metal inserts at every bolt hole and pin bore. At the 50mm scale, the insert-to-CFRP bond area is tiny, creating peel-stress failures. Real CFRP spacecraft brackets (e.g., JWST backplane struts) work because they're long tubes loaded in axial tension. Short clevis ears loaded in bearing/shear around a pin bore are aluminum's domain.

---

#### 13.1.2 A-Frame Shape — Topology-Optimized Weight-Saved Profile

The A-frame bracket profile is inspired by real CNC-machined spacecraft hinge brackets
(Northrop Grumman Astro Aerospace hinge line, L3Harris solar array deployment hinges,
ESA Proba-3 formation-flying hinge brackets). Key design features:

1. **Rounded outer profile** — no sharp corners (stress risers). All external edges use ≥3mm fillet radii.
2. **Lightening hole** — oval/circular window cutout in the web, removing ~30% of web mass.
3. **Pin bore at apex** — cylindrical bore for the ∅10mm pivot pin with Vespel bushing pressed in.
4. **Mounting flange at base** — wider rectangular foot with 2× bolt holes for collar attachment.
5. **Gusset fillets** — smooth radius where flange meets web (prevents fatigue cracking at load path transition).

```
  A-FRAME BRACKET — SIDE PROFILE (one of two per hinge)
  Scale: 1 grid square = 5mm

              ┌──∅10mm pin bore──┐
              │   (Vespel bush)  │
          ╭───┴───╮
         ╱    ●    ╲          ← Rounded apex: R=8mm fillet
        ╱           ╲            Pin bore center: 40mm above collar
       ╱    ╭───╮    ╲       ← Lightening hole: 15mm × 10mm oval
      ╱     │   │     ╲         Removes ~30% web mass
     ╱      ╰───╯      ╲        Centered 22mm above base
    ╱                    ╲    ← Web: 8mm thick, tapers 50mm base → 20mm apex
   ╱  R3 gusset fillet    ╲
  ╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱  ← Mounting flange: 50mm wide × 12mm tall × 8mm thick
  ┌──●──────────────────●──┐     2× M4 bolt holes at ±18mm from center
  │  ○  COLLAR SURFACE  ○  │     ○ = bolt holes ∅4.5mm (clearance for M4)
  └────────────────────────┘
  
  THICKNESS (looking from front, into the page):
  ├── 8mm ──┤  uniform plate thickness
  With 1mm bevel chamfer on all exposed edges
```

```
  ASSEMBLED HINGE — TOP VIEW (looking down barrel axis, radially outward)
  
  ──────── COLLAR RING (TorusGeometry, r=0.40m) ────────
  
       A-frame L              A-frame R
        ╱╲       ╱╲
       ╱  ╲     ╱  ╲       ← Two brackets straddle strut root
      ╱  ○ ╲   ╱ ○  ╲         Gap between inner faces: 30mm
     ╱      ╲ ╱      ╲        (clears strut tube 25mm major axis)
    ╱________╳________╲
     flange  ║  flange     ← Pin runs through both apexes
     (bolted ║  (bolted       Exposed pin ends: 5mm each side
      to     ║   to           with retaining C-clips
     collar) ║  collar)
             ║
       [STRUT ROOT]
             ║ ← Strut tube inserts between A-frames
             ║    Welded/bonded to a clevis fork fitting
             ║    that wraps the pin
             │
             │ 1.60m CFRP tube
             │
       [STRUT TIP + REEL]
```

```
  HINGE EXPLODED VIEW — ALL PARTS (per hinge point)
  
  ×2 A-frame brackets ──────╮
                             │
  ×4 M4 Ti bolts ──────────╮│   (2 per bracket, into collar)
                            ││
  ×2 Vespel bushings ─────╮││   (pressed into A-frame bores)
                           │││
  ×1 Pivot pin (17-4PH) ──┤││   (through both bushings)
                           ││
  ×2 C-clip retainers ────┤│    (snap onto pin grooves)
                           │
  ×1 Brake disc ───────────┤    (keyed to strut fork, between A-frames)
                           │
  ×1 Brake caliper pad ────┤    (spring-loaded, on inboard A-frame)
                           │
  ×1 LED (status) ─────────┘    (forward of outboard A-frame)
  
  TOTAL PARTS PER HINGE: 10 (+ strut fork fitting)
  TOTAL FOR 4 HINGES: 40 parts
```

---

#### 13.1.3 Collar-to-Barrel Attachment

The collar ring attaches to the barrel cylinder via a **bolted flange** interface.
This is the most common spacecraft structural interface (used on every satellite bus
where the service module meets the payload module).

**Mechanism**: The collar ring has an integral **inboard shelf** (flat ledge protruding
inward from the torus) that sits against the barrel outer surface. Twelve titanium
M5 bolts in a bolt circle fasten the shelf to the barrel's structural ring frame
(an internal stiffener ring welded to the barrel skin at Z = +0.90m).

```
  COLLAR-TO-BARREL CROSS-SECTION (single cut through collar at one azimuth)
  
  ← Radially outward                              Radially inward →
  
              ┌─── Collar main torus (R_major=400mm, r_tube=15mm)
              │
         ╭────┴────╮
        ╱  ○    ○  ╲      ← Collar torus cross-section (circular)
       │            │         ○ = decorative panel lines
        ╲    ┌──┐  ╱
         ╰───┤  ├──╯
              │  │         ← Inboard shelf: 8mm thick, 20mm radial depth
              │  │            Extends inward from torus toward barrel
         ┌────┤  ├────┐
    ○────┤    │  │    ├────○  ← Bolt heads (Ti M5 × 12mm socket cap)
         │    │  │    │          Visible as small hexagonal bumps
         └────┤  ├────┘
              │  │
     ═════════╧══╧═════════   ← Barrel skin (0.4m radius cylinder)
     ║                    ║      2mm aluminum skin + internal ring frame
     ║   BARREL INTERIOR  ║
     ║                    ║
```

**Visible details for Three.js rendering:**
- Collar torus ring (existing `TorusGeometry`)
- **NEW**: Inner flange ring — `TorusGeometry(collarR - M*0.01, M*0.006, 4, 32)` — thin ring just inside the collar
- **NEW**: 12× bolt-head cylinders — `CylinderGeometry(M*0.004, M*0.004, M*0.005, 6)` — sitting on the flange at 30° intervals
- **NEW**: Barrel interface ring — `TorusGeometry(collarR, M*0.008, 4, 32)` — a visible raised ring on the barrel at Z=+0.90m where the collar seats

**Why bolted, not welded?**
Friction-stir welding (FSW) the collar to barrel skin is flight-realistic (SpaceX Falcon 9
inter-stage, Blue Origin New Shepard), but produces NO visible detail — just a smooth joint.
Bolted flange gives us visible hardware (bolt heads, flange step) that reads as "engineered
structure" to the player, which is the design goal.

---

#### 13.1.4 A-Frame-to-Collar Attachment

Each A-frame bracket is a **separate CNC-machined part bolted to a machined mounting pad
on the collar ring**. This matches real solar array hinge mounting practice (separate
hinge brackets bolted to dedicated interface pads on the bus structure).

```
  A-FRAME MOUNTING — DETAIL VIEW (one bracket, looking tangentially)
  
       ╭─── A-frame bracket (6061-T6)
       │
       │     ●  ← pin bore
       │    ╱ ╲
       │   ╱ ○ ╲    ← lightening hole
       │  ╱     ╲
       │ ╱       ╲
       │╱  R3 fillet╲
  ─────┤░░░░░░░░░░░░├─────  ← Mounting flange (shaded)
       │  ○      ○  │         2× M4 Ti bolts through bracket flange
  ═════╪════════════╪═════     into collar mounting pad
       │ COLLAR PAD │       ← Machined flat on collar OD
  ╭────┴────────────┴────╮     (integral with collar ring forging)
  │    COLLAR TORUS      │     Pad dimensions: 50mm tangential × 15mm axial
  ╰──────────────────────╯
  
  BOLT PATTERN:
  ○────18mm────○         2× M4 Ti socket-cap bolts
       ↕                 Torque: 2.5 N·m (with thread-locking patch)
      12mm               Installed from outboard (bolt heads visible)
  (flange height)
```

**Why bolted, not integral?**
Making the A-frames integral with the collar (single monolithic ring) would be structurally
optimal but:
1. Requires 5-axis CNC from a massive billet (waste ratio > 15:1)
2. Any bracket damage requires replacing the entire collar
3. Eliminates visible fastener detail (design goal: "look like a bicycle frame")
4. Real flight hardware uses bolted interfaces at hinge points for replaceability

The bolted approach gives visible M4 bolt heads at each bracket base — 2 per bracket,
8 per hinge (2 brackets × 4 bolts total), 32 bolts across 4 hinges.

---

#### 13.1.5 Three.js Geometry Specification

All dimensions use `M` scale factor (ship-frame units). Actual meters are shown in comments.

##### Component A: Collar Ring (enhanced from current)

Currently: `TorusGeometry(collarR, M*0.015, 8, 32)` — **keep as-is**, add flange details.

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| Main torus | `TorusGeometry` | `(collarR, M*0.015, 8, 32)` | `0x8888a0`, met=0.75, rgh=0.28 |
| Inner flange ring | `TorusGeometry` | `(collarR - M*0.012, M*0.006, 4, 32)` | Same as collar |
| Barrel seat ring | `TorusGeometry` | `(collarR + M*0.002, M*0.008, 4, 32)` | `0x777788`, met=0.70, rgh=0.32 |
| Flange bolts (×12) | `CylinderGeometry` | `(M*0.004, M*0.004, M*0.005, 6)` | `0x99aabb`, met=0.80, rgh=0.20 |

Estimated triangles: torus 512 + torus 256 + torus 256 + 12×(12×2) = **1,312 tris**

##### Component B: A-Frame Bracket (×8 total: 2 per hinge × 4 hinges)

**Geometry approach**: `ExtrudeGeometry` from a `THREE.Shape` with `bezierCurveTo()` for
the rounded profile and a `THREE.Path` hole for the lightening cutout.

```javascript
// A-frame bracket side profile — defines the 2D Shape
const aframeShape = new THREE.Shape();
const W = M * 0.025;  // half-width at base (50mm total)
const H = M * 0.040;  // total height (40mm)
const FH = M * 0.012; // flange height (12mm)
const AW = M * 0.010; // half-width at apex (20mm total)
const R = M * 0.008;  // apex fillet radius

// Start at bottom-left of flange
aframeShape.moveTo(-W, 0);
// Flange left edge up
aframeShape.lineTo(-W, FH);
// Left web taper — bezier curve from flange to apex
aframeShape.bezierCurveTo(
  -W, FH + M*0.010,       // CP1: slight outward bulge
  -AW - R, H - R,         // CP2: approach apex tangent
  -AW, H                  // End: apex left edge
);
// Apex arc (rounded top around pin bore)
aframeShape.bezierCurveTo(
  -AW + R*0.5, H + R*0.4, // CP1: arc control
   AW - R*0.5, H + R*0.4, // CP2: arc control
   AW, H                  // End: apex right edge
);
// Right web taper (mirror of left)
aframeShape.bezierCurveTo(
   AW + R, H - R,
   W, FH + M*0.010,
   W, FH
);
// Flange right edge down
aframeShape.lineTo(W, 0);
// Base (close shape)
aframeShape.lineTo(-W, 0);

// Lightening hole — oval cutout in web center
const hole = new THREE.Path();
const holeY = M * 0.022;  // center at 22mm above base
const holeRx = M * 0.007; // 14mm wide
const holeRy = M * 0.005; // 10mm tall
hole.ellipse(0, holeY, holeRx, holeRy, 0, Math.PI * 2, false, 0);
aframeShape.holes.push(hole);

// Extrude to plate thickness with edge bevel
const aframeGeo = new THREE.ExtrudeGeometry(aframeShape, {
  depth:         M * 0.008,  // 8mm plate thickness
  bevelEnabled:  true,
  bevelThickness: M * 0.001, // 1mm bevel
  bevelSize:     M * 0.001,
  bevelSegments: 1,          // single chamfer (not rounded — machined look)
  curveSegments: 8,          // smoothness of bezier curves
});
aframeGeo.center();  // center on origin, then position per hinge
```

| Property | Value |
|----------|-------|
| Base width | 50mm (`M * 0.050`) |
| Total height | 40mm (`M * 0.040`) |
| Apex width | 20mm (`M * 0.020`) |
| Plate thickness | 8mm (`M * 0.008`) |
| Lightening hole | 14mm × 10mm oval at Y=22mm |
| Bevel chamfer | 1mm, 1 segment |
| Curve segments | 8 |
| Material | `MeshStandardMaterial({ color: 0x9090a8, metalness: 0.72, roughness: 0.30 })` |

Estimated triangles per bracket: ~180 (shape outline ~30 segments × 2 faces + depth sides + bevel + hole)
Total for 8 brackets: **~1,440 tris**

##### Component C: Pivot Pin (×4)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| Pin shaft | `CylinderGeometry` | `(M*0.005, M*0.005, M*0.070, 8)` | `0xaabbcc`, met=0.85, rgh=0.15 |
| C-clip L | `TorusGeometry` | `(M*0.007, M*0.0015, 4, 8)` | `0xaabbcc`, met=0.85, rgh=0.15 |
| C-clip R | `TorusGeometry` | `(M*0.007, M*0.0015, 4, 8)` | (same) |

Estimated triangles per pin: 32 + 64 + 64 = **160 tris × 4 = 640 tris**

##### Component D: Vespel Bushings (×8: 2 per hinge)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| Bushing | `TorusGeometry` | `(M*0.008, M*0.003, 6, 8)` | `0x8b6914`, met=0.15, rgh=0.70 |

Estimated: 96 tris × 8 = **768 tris**

##### Component E: Brake Disc (×4)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| Disc | `CylinderGeometry` | `(M*0.015, M*0.015, M*0.003, 12)` | `0x555566`, met=0.70, rgh=0.35 |

Estimated: 48 tris × 4 = **192 tris**

##### Component F: Mounting Bolts (×16: 4 per hinge, 2 per bracket)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| Bolt head | `CylinderGeometry` | `(M*0.003, M*0.003, M*0.004, 6)` | `0x99aabb`, met=0.80, rgh=0.20 |

Estimated: 24 tris × 16 = **384 tris** (use `InstancedMesh` for batch)

##### Component G: LED Indicator (×4, existing)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| LED sphere | `SphereGeometry` | `(M*0.010, 4, 4)` | `MeshBasicMaterial({ color: 0x00ff44 })` |

Estimated: 32 tris × 4 = **128 tris**

---

#### 13.1.6 Total Polygon Budget

| Component | Count | Tris Each | Total Tris |
|-----------|-------|-----------|------------|
| Collar (enhanced) | 1 | 1,312 | 1,312 |
| A-frame brackets | 8 | 180 | 1,440 |
| Pivot pins + C-clips | 4 | 160 | 640 |
| Vespel bushings | 8 | 96 | 768 |
| Brake discs | 4 | 48 | 192 |
| Mounting bolts (brackets) | 16 | 24 | 384 |
| Flange bolts (collar) | 12 | 24 | 288 |
| LEDs | 4 | 32 | 128 |
| **TOTAL** | **57** | — | **~5,150** |

This is **well within budget** for a game focal point. For comparison, a single Three.js
`SphereGeometry(1, 32, 32)` produces 1,984 triangles. The entire hinge assembly is ~2.5 spheres.

**LOC estimate**: ~130 lines replacing current ~85 lines in [`_buildCollar()`](js/entities/PlayerSatellite.js:462).
Net addition: ~45 LOC. The `Shape` definition for the A-frame can be factored to a
helper `_aframeShape()` method (~25 LOC), keeping `_buildCollar()` itself at ~105 LOC.

---

#### 13.1.7 Full Assembly Diagram

```
  COMPLETE HINGE ASSEMBLY — ISOMETRIC EXPLODED VIEW
  (one of 4 hinge points at azimuths 60°, 120°, 240°, 300°)
  
  
         LED ◉ (green, forward)
              ╲
               ╲
    A-frame L   ╲    A-frame R
      ╭─╮  ┃    ╲     ╭─╮
     ╱ ● ╲ ┃     ╲   ╱ ● ╲      ● = pin bore with Vespel bushing
    ╱  ○  ╲┃      ╲ ╱  ○  ╲     ○ = lightening hole
   ╱      ╱┃       ╳       ╲
  ╱______╱ ┃ BRAKE ╱╲_______╲
  │ ○  ○ │ ┃ DISC ╱  │ ○  ○ │   ○ = M4 bolt holes
  └──────┘ ┃    ╱    └──────┘
     ↓     ┃  ╱        ↓
   bolts   ┃╱        bolts
     ↓     ┃           ↓
  ─────────╨──────────────────── COLLAR MOUNTING PADS
  ══════════════════════════════ COLLAR TORUS (r=400mm)
  ──────────────────────────────  inner flange ring
      ○  ○  ○  ○  ○  ○  ○  ○   flange bolts (Ti M5, ×12 around ring)
  ────────────────────────────── barrel seat ring
  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ BARREL SKIN (Z = +0.90m)
  
  
  PIVOT AXIS DETAIL (section view cutting through pin):
  
       ┌── C-clip ──┐
       │             │
  ═════╪═════════════╪═════ ← Pin (17-4PH, ∅10mm)
       │             │
  ┌────┤  A-frame L  ├────┐
  │ [Vespel]      [Vespel] │  ← Bushings (pressed into bracket bores)
  └────┤  A-frame R  ├────┘
       │             │
       │ ┌─BRAKE ──┐ │       ← Disc keyed to strut fork
       │ │  DISC   │ │         Caliper pad on inboard A-frame
       │ └─────────┘ │
       │             │
       ╠═══STRUT ════╣       ← Strut fork fitting wraps pin
       ║   FORK      ║         (integral with strut tube root)
       ║             ║
       ║  STRUT TUBE ║
       ║  (CFRP 50mm)║
       ╚═════════════╝
```

```
  COLLAR RING — TOP VIEW (looking down +Z barrel axis)
  Showing all 4 hinge points with A-frames
  
                    0° (top)
                     │
              ╱╲     │
             ╱  ╲    │     Collar torus
            ╱    ╲   │     (r = 400mm)
      300°╱______╳___|____________╲ 60°
         ╱╲     ╱ ╲  │   ╱╲      ╱╲
        ╱  ╲   ╱   ╲ │  ╱  ╲    ╱  ╲
       ╱    ╲ ╱     ╲│ ╱    ╲  ╱    ╲
      ╱──────╳───────●╳──────╳╱──────╲
     │               │                │
     │    BARREL     │                │
     │   (looking    │   ←0.40m→      │
     │    down)      │                │
      ╲──────╳───────●╳──────╳╲──────╱
       ╲    ╱ ╲     ╱│ ╲    ╱  ╲    ╱
        ╲  ╱   ╲   ╱ │  ╲  ╱    ╲  ╱
         ╲╱     ╲ ╱  │   ╲╱      ╲╱
      240°╲______╳___|____________╱ 120°
            ╲    ╱   │
             ╲  ╱    │
              ╲╱     │
                     │
                   180° (bottom)
  
  ARM_LADDER.Y0_QUAD azimuths: [60°, 120°, 240°, 300°]
  Avoids 0°/180° (ROSA panel plane) and 90°/270° (thruster plane)
```

---

#### 13.1.8 Color Palette Reference (Visual)

```
  MATERIAL SWATCHES (approximate monitor appearance)
  
  Collar ring    ░░░░░  #8888a0  Silvery blue-gray (clear-anodized 7075)
  A-frame        ▒▒▒▒▒  #9090a8  Slightly lighter (machined 6061 face)
  Pin / Ti bolts ▓▓▓▓▓  #aabbcc  Bright polished steel/titanium
  Bushings       ████░  #8b6914  Warm amber-brown (Vespel polyimide)
  Brake disc     ████▓  #555566  Dark gunmetal (hardened 440C)
  LED (stowed)   ◉◉◉◉◉  #00ff44  Bright green (BasicMaterial, no shading)
  Barrel body    ░░░░░  #1a1a2e  Dark blue-black (per existing _matBody)
  Gold MLI       ▒▓▒▓▒  #aa8833  Warm gold (per existing _matGoldMLI)
```

---

#### 13.1.9 Implementation Notes

1. **Shared geometries**: All 8 A-frame brackets share ONE `ExtrudeGeometry` instance.
   All 16 bracket bolts share ONE `CylinderGeometry`. Use `mesh.clone()` for instances
   (shares geometry + material, unique transform).

2. **Bracket orientation**: Each bracket's local +Y axis points radially outward from
   collar center. The two brackets at each hinge are offset ±`M*0.019` along the
   tangent direction (total gap = 38mm, clearing the 25mm strut tube + 6mm×2 bushing).

3. **Pin alignment**: Pin cylinder axis = tangent to collar at the hinge azimuth.
   Use same `quaternion.setFromUnitVectors(_yUp, tangent)` pattern from the current code.

4. **Brake disc position**: Centered on pin, between the two A-frames. Radius slightly
   smaller than A-frame web width so it's partially occluded — realistic (brake disc
   is internal to the hinge, not a visible external feature).

5. **Flange bolts instancing**: 12 collar-flange bolts + 16 bracket bolts = 28 identical
   cylinders. Consider `InstancedMesh(boltGeo, boltMat, 28)` if profiling shows draw-call
   pressure (unlikely at this count, but good practice).

6. **LOD consideration**: At ORBIT camera distance (15–50m), the A-frame internal detail
   (lightening hole, bolt heads) is sub-pixel. For INSPECTION camera (2–15m), it's visible.
   No runtime LOD needed — the polygon count is low enough to always render full detail.

### 13.2 S3.2 Strut CFRP Material + Rib Ring Collars + ROSA Gold Edge Frames

> **Sprint 3, Task 2** · Upgrades the current struts in [`_buildStruts()`](js/entities/PlayerSatellite.js:733)
> with correct CFRP composite material properties, adds machined aluminum rib ring collars
> and end fittings for visual authenticity, and adds gold anodized edge frames to the ROSA
> solar panels in [`_buildSolarPanels()`](js/entities/PlayerSatellite.js:948).

---

#### 13.2.1 Material Selection Table

Real spacecraft deployable booms drive every material choice below. The strut tube is a
pultruded CFRP composite — the same material used for ISS ADAM mast longerons, JWST
sunshield support tubes, and every modern deployable solar array boom. Rib rings are
machined aluminum interface collars at field-joint locations. The ROSA gold edges match
the anodized aluminum deployment rails on ISS ROSA arrays (DSS Roll-Out Solar Array).

| Part | Material | Grade | Rationale | Color Hex | Metalness | Roughness |
|------|----------|-------|-----------|-----------|-----------|-----------|
| **Strut round tube** | Pultruded CFRP | T800/M21 (Hexcel) | Industry standard for deployable space structures. Toray T800 carbon fiber in toughened epoxy matrix. Clear-coat finish shows woven carbon texture as dark, slightly blue-gray surface. Used on JWST sunshield tubes, Northrop Grumman AstroMesh reflector booms. | `0x2a2a30` | 0.15 | 0.65 |
| **Rib ring collars** | Machined aluminum | 6061-T6 | Interface collars at field-joint locations. Same alloy as A-frame brackets (§13.1.1) for supply-chain commonality. Bright machined finish. | `0x8899aa` | 0.72 | 0.28 |
| **Root joint collar** | Machined aluminum | 7075-T6 | Clevis fork fitting bonded to strut root. Interfaces with hinge pin from §13.1. Higher-strength alloy at the loaded joint. Same finish as collar ring. | `0x8888a0` | 0.75 | 0.28 |
| **Tip joint collar** | Machined aluminum | 6061-T6 | Daughter-arm dock fitting at strut tip. Lighter alloy — lower loads than root. Houses bridle ring attach points. | `0x8899aa` | 0.72 | 0.28 |
| **ROSA gold edge frame** | Anodized aluminum | 6063-T5 | Gold chromate conversion coating (MIL-DTL-5541F, Type I, Class 1A). Standard for ISS ROSA deployment rail edges. 6063 chosen for extrudability (rail profile). Unlit material for maximum visibility in all lighting. | `0xccaa44` | — (Basic) | — |

**Why not titanium struts?** At 1.60m length and ∅50mm cross-section, Ti-6Al-4V saves ~25% mass versus CFRP (density 4.43 vs ~1.55 g/cm³ — but Young's modulus 114 vs 181 GPa means CFRP is stiffer per unit mass). Real deployable booms are universally CFRP composite for this reason. Titanium is reserved for fittings (root/tip collars, hinge pin bores) where bearing loads on bolt holes favor metal.

**Why round tube, not oval or I-beam?** The original §2.2 proposed an oval tube and the initial draft of this spec specified an I-beam, but both are structurally wrong for this application:

1. **This is a sweeping boom.** The strut hinge sweeps α = 0 to π (180°). Bending loads from the daughter arm mass (6.6 kg at tip), tether tension, and reaction torques arrive from **every direction** relative to the cross-section as the strut rotates. Any non-circular cross-section (oval, I-beam, channel) creates a **weak axis** — a direction where buckling resistance is lower. A round tube has **equal bending stiffness (EI) in all planes**, which is the only correct choice when the loading direction is not fixed.

2. **Proven flight heritage.** Every operational deployable boom on every spacecraft uses a round tubular cross-section: JWST sunshield booms, ISS ROSA (DSS) deployment rails, Northrop Grumman ADAM mast longerons, Hubble SA booms, SMAP antenna boom, every CubeSat deployer (ISIS, Tethers Unlimited). Zero I-beams. Zero ovals. The aerospace industry converged on round tubes because they are optimal for multi-axis loading with minimal manufacturing complexity.

3. **Simple, robust, proven, reliable, lightweight.** A round CFRP tube is pultruded through a circular die — the cheapest, simplest composite manufacturing process. No stress concentrations at web-flange junctions (which I-beams have). Well-characterized Euler + local buckling behavior. Trivial quality inspection (ultrasonic C-scan of a cylinder wall).

4. **Visual authenticity for the sim.** This game tests real spacecraft concepts. The strut should look like what an engineer would actually build. The visual upgrade comes not from changing the cross-section, but from adding the **real hardware details** that make a round tube look "aerospace": CFRP material finish, field-joint rib ring collars, and machined metallic end fittings.

---

#### 13.2.2 Round Tube Cross-Section

```
  ROUND CFRP TUBE CROSS-SECTION (looking down strut axis, toward tip)

            ╭─────────╮
          ╱    ╭───╮    ╲         OD: 50mm (M*0.050) = STRUT_TUBE_OD
         │   ╱     ╲    │        Wall: 2mm (M*0.002) = STRUT_TUBE_WALL
         │  │ hollow │   │        ID: 46mm
         │   ╲     ╱    │
          ╲    ╰───╯    ╱         Material: T800/M21 CFRP
            ╰─────────╯          Color: 0x2a2a30 (dark carbon fiber)

  ← ∅50mm (M*0.050) →

  Equal bending stiffness (EI) in all planes.
  Critical for a sweeping boom: α = 0 → π loading from all directions.
```

The round tube uses the existing [`STRUT_TUBE_OD: 0.050`](js/core/Constants.js:266) and
[`STRUT_TUBE_WALL: 0.002`](js/core/Constants.js:267) constants directly. No new constants
needed. This is the same geometry the current code already creates — the visual upgrade
comes from material properties (§13.2.1), rib ring collars (§13.2.4), and end fittings (§13.2.5).

| Dimension | Real (mm) | Scene (`M` units) | Constant |
|-----------|-----------|--------------------| ---------|
| Outer diameter | 50 | `M * 0.050` | `STRUT_TUBE_OD` |
| Radius | 25 | `M * 0.025` | `STRUT_TUBE_OD / 2` |
| Wall thickness | 2 | `M * 0.002` | `STRUT_TUBE_WALL` |
| Length | 1600 | `M * 1.600` | `STRUT_LENGTH` |

---

#### 13.2.3 Strut Body Geometry Construction

**Approach**: `CylinderGeometry` — the same primitive as the current code, with increased
segment count (12 vs 8) for a smoother round profile at inspection distances, and the
correct CFRP material replacing the generic gray.

```javascript
// In _buildStruts() — create once, share across all 4 struts
const strutGeo = new THREE.CylinderGeometry(strutR, strutR, strutLen, 12);
//                                                                    ^^
//                     current code uses 8 segments → upgrade to 12 for
//                     smoother profile at inspection camera (2-15m)

const strutMat = new THREE.MeshStandardMaterial({
  color: 0x2a2a30, metalness: 0.15, roughness: 0.65,  // CFRP T800/M21
});
// Replaces current: { color: 0x999999, metalness: 0.6, roughness: 0.4 }

const strut = new THREE.Mesh(strutGeo, strutMat);
strut.position.y = -strutLen / 2;  // hang from pivot (unchanged)
```

**Why keep `CylinderGeometry` instead of `ExtrudeGeometry` or `LatheGeometry`?**
A `CylinderGeometry` IS a round tube. It's the simplest, cheapest geometry for the
structurally correct cross-section. No shape helpers, no axis rotations, no translate
corrections. The visual delta comes from the material swap (CFRP dark composite vs
generic gray metal) and the added rib ring / collar detail — not from the tube shape.

**Segment count: 12 vs 8.** At inspection camera (2–15m), an 8-segment cylinder shows
visible faceting. 12 segments produce a visually smooth round tube while adding only
4 × 2 = 8 triangles per strut (48→72 tris). At orbit camera (15–50m), both look identical.

---

#### 13.2.4 Rib Ring Collars

Real deployable booms have field-joint collars at regular intervals — these are the
connection points between boom segments during deployment. On SCARLET-era ROSA booms
and ISS truss longerons, these appear as bright metallic rings clamped around the dark
CFRP tube. They provide visual rhythm and structural authenticity.

**Configuration**: 3 rib rings per strut at 25%, 50%, 75% of strut length.

```
  STRUT SIDE VIEW with rib rings (local Y axis, pivot at top)

  Y=0  ──┬── PIVOT (hinge pin center)
         │
         │   Root joint collar (25mm tall)
         ╠══╣
         │
         │
   25%   ╠══╣  Rib Ring₁ (6mm tall × ∅57.5mm round)
         │
         │
   50%   ╠══╣  Rib Ring₂
         │
         │
   75%   ╠══╣  Rib Ring₃
         │
         │
   85%   ╠══╣  [Reel housing — existing, unchanged]
         │
   95%   ╠══╣  [Spring mount — existing, unchanged]
         │
  Y=-L ──┴── TIP NODE (daughter dock)
              Tip joint collar (20mm tall)
```

**Rib ring geometry**: `TorusGeometry` — round, matching strut tube profile.

```javascript
// Create once, share across all 4 struts × 3 rings = 12 instances
const ribGeo = new THREE.TorusGeometry(
  strutR * 1.15,  // major radius: 15% larger than strut (clears tube + 4mm gap)
  M * 0.003,      // tube radius: 3mm (6mm visible ring thickness)
  4,              // radial segments (square tube profile — machined look)
  12,             // tubular segments (dodecagonal — matches 12-seg cylinder)
);
const ribMat = new THREE.MeshStandardMaterial({
  color: 0x8899aa, metalness: 0.72, roughness: 0.28,  // machined 6061-T6
});

// Per-ring placement (inside the per-strut forEach loop):
for (const frac of [0.25, 0.50, 0.75]) {
  const ring = new THREE.Mesh(ribGeo, ribMat);
  ring.position.y = -strutLen * frac;
  ring.rotation.x = Math.PI / 2;   // torus plane ⊥ strut Y-axis
  ring.name = `RibRing_${i}_${frac * 100}`;
  pivotGroup.add(ring);
}
```

| Property | Value | Notes |
|----------|-------|-------|
| Count | 3 per strut, 12 total | At 25%, 50%, 75% strut length |
| Major radius | `strutR * 1.15` = 28.75mm | Clears ∅50mm tube + ~4mm gap |
| Tube radius | 3mm (`M * 0.003`) | Visible collar ring thickness |
| Radial segments | 4 | Square-section tube (machined aluminum collar) |
| Tubular segments | 12 | Matches strut cylinder segments (smooth circle) |
| Material | `ribMat` | `0x8899aa`, met=0.72, rgh=0.28 (6061-T6) |

---

#### 13.2.5 Joint Collars (Root + Tip End Fittings)

Both ends of the strut have machined aluminum end fittings that transition from the
CFRP round tube to the metallic joint hardware (hinge pin at root, dock interface
at tip). These are realistic: real CFRP boom tubes always have bonded-in metallic
end fittings (clevis forks, tang fittings, or threaded inserts). The metal-to-composite
transition is the most loaded point on the structure and must be aluminum or titanium.

##### Root Joint Collar (Clevis Fork Fitting)

This is the "strut fork fitting" referenced in §13.1.7 — the machined aluminum piece
bonded onto the CFRP tube root that wraps around the hinge pin. It appears as a
slightly-wider round collar at the strut's hinge end.

```javascript
const rootCollarGeo = new THREE.CylinderGeometry(
  strutR * 1.20,  // radius: 120% of strut (30mm vs 25mm) — visible step-up
  strutR * 1.20,  // same top and bottom (parallel sided)
  M * 0.025,      // height: 25mm
  12,              // segments: matches strut (smooth circle)
);
const rootCollarMat = new THREE.MeshStandardMaterial({
  color: 0x8888a0, metalness: 0.75, roughness: 0.28,  // 7075-T6, matches collar ring
});
const rootCollar = new THREE.Mesh(rootCollarGeo, rootCollarMat);
rootCollar.position.y = -M * 0.0125; // flush with pivot origin (top at Y=0)
rootCollar.name = `RootCollar_${i}`;
pivotGroup.add(rootCollar);
```

| Property | Value |
|----------|-------|
| Radius | `strutR * 1.20` = 30mm |
| Height | 25mm (`M * 0.025`) |
| Segments | 12 (matches strut cylinder) |
| Material | `0x8888a0`, met=0.75, rgh=0.28 (7075-T6, matches collar ring) |

##### Tip Joint Collar (Dock Fitting)

Machined fitting at strut tip. Interfaces with bridle ring and daughter-arm dock.

```javascript
const tipCollarGeo = new THREE.CylinderGeometry(
  strutR * 1.10,  // radius: 110% of strut (27.5mm vs 25mm) — subtle step
  strutR * 1.10,
  M * 0.020,      // height: 20mm
  12,              // segments: matches strut
);
const tipCollarMat = new THREE.MeshStandardMaterial({
  color: 0x8899aa, metalness: 0.72, roughness: 0.28,  // 6061-T6, matches rib rings
});
const tipCollar = new THREE.Mesh(tipCollarGeo, tipCollarMat);
tipCollar.position.y = -strutLen + M * 0.010; // at strut tip, flush with tip node
tipCollar.name = `TipCollar_${i}`;
pivotGroup.add(tipCollar);
```

| Property | Value |
|----------|-------|
| Radius | `strutR * 1.10` = 27.5mm |
| Height | 20mm (`M * 0.020`) |
| Segments | 12 (matches strut cylinder) |
| Material | `0x8899aa`, met=0.72, rgh=0.28 (6061-T6, matches rib rings) |

---

#### 13.2.6 ROSA Gold Anodized Edge Frames

**Real-world reference**: ISS ROSA arrays (DSS for ISS channels 1A, 3A, 2B, 4B) have
gold chromate-conversion-coated aluminum deployment rails visible as bright gold outlines
along each wing's edges. The ATK/Northrop UltraFlex arrays (InSight, Lucy) show the same
gold spar edges. These create a distinctive boundary outline that makes panel geometry
readable in all lighting conditions — critical when the panel surface itself is near-black
(GaAs cells at `0x0a1133`).

**Implementation**: `EdgesGeometry` + `LineSegments` with `LineBasicMaterial`.

This approach was selected over thin extruded box frame geometry because:
1. **Zero triangle cost** — leaves full polygon budget for strut detail
2. **Constant screen-space width** — 1px gold line is visible at all camera distances
3. **Unlit rendering** — `LineBasicMaterial` is not affected by scene lighting, so the
   gold outline remains visible even when the panel is in shadow (matching real ISS
   imagery where ROSA gold edges catch earthshine when the panel face is dark)
4. **Trivial code** — ~6 lines per panel, no edge offset computation

```javascript
// In _buildSolarPanels(), after creating panel meshes (line ~1019):

const goldEdgeMat = new THREE.LineBasicMaterial({
  color: 0xccaa44,     // gold anodized aluminum (MIL-DTL-5541F Type I)
  depthTest: true,     // respect scene depth (don't draw through barrel)
  transparent: false,
});

// Panel 1 (+X wing) — edges on chamfered ShapeGeometry
const edgeGeo1 = new THREE.EdgesGeometry(panelGeo1, 1);  // thresholdAngle=1°
const edge1 = new THREE.LineSegments(edgeGeo1, goldEdgeMat);
edge1.position.z = 0.001;    // tiny offset above panel surface (avoid z-fight)
edge1.name = 'ROSA_GoldEdge_0deg';
this._rosaPanelWrapper1.add(edge1);

// Panel 2 (-X wing) — same treatment
const edgeGeo2 = new THREE.EdgesGeometry(panelGeo2, 1);  // thresholdAngle=1°
const edge2 = new THREE.LineSegments(edgeGeo2, goldEdgeMat);
edge2.position.z = 0.001;
edge2.name = 'ROSA_GoldEdge_180deg';
this._rosaPanelWrapper2.add(edge2);
```

**Threshold angle**: `1` degree — catches all boundary edges of the chamfered
`ShapeGeometry`. Since the panel is planar (single face), every boundary edge has a
dihedral angle of exactly 0° (boundary), so any threshold below 90° detects all edges.

**Grid overlay interaction**: The existing wireframe grid (`gridMat`, 30% opacity blue)
remains unchanged. The gold edges render on top of the grid via the slight Z-offset.
Gold frame outlines the panel boundary while the grid shows internal cell structure —
matching ISS imagery where gold rails frame the blue-black cell blanket.

**Performance**: `EdgesGeometry` is computed once at construction. Each `LineSegments`
mesh is a single draw call. Two draw calls total for both wings — negligible.

##### Future Upgrade Path: Fat Lines

If testing reveals the 1px line is too thin at orbit distances (15–50m), upgrade to
`Line2` / `LineGeometry` / `LineMaterial` from `three/examples/jsm/lines/`:
```javascript
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
// world-space linewidth: 0.015 * M = 15mm frame rail width
```
This is backward-compatible (same edge positions, just thicker rendering) and costs
~100 tris per panel for the line strip triangulation. Defer unless 1px proves insufficient.

##### Daughter Panel Consistency (ArmUnit — Follow-On)

For visual consistency across the fleet, the same gold edge treatment should be applied
to daughter arm ROSA panels in [`ArmUnit._createMesh()`](js/entities/ArmUnit.js:304).
This is a **separate follow-on task** (~15 LOC) using the identical `goldEdgeMat` color
(`0xccaa44`). Not in scope for S3.2 but noted for design consistency.

---

#### 13.2.7 Three.js Geometry Specification Summary

All dimensions use the file-local `const M = 0.00001` (1 meter in scene units, defined at [`PlayerSatellite.js:30`](js/entities/PlayerSatellite.js:30)).

##### Component A: Strut Round CFRP Tube (×4, shared geometry)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| Round tube | `CylinderGeometry` | `(strutR, strutR, strutLen, 12)` | `0x2a2a30`, met=0.15, rgh=0.65 |

Estimated triangles per strut: 72 (12 sides × 2 tris + 2 caps × 12 tris each)

##### Component B: Root Joint Collar (×4, shared geometry)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| Root collar | `CylinderGeometry` | `(strutR*1.20, strutR*1.20, M*0.025, 12)` | `0x8888a0`, met=0.75, rgh=0.28 |

Estimated triangles per collar: 72

##### Component C: Tip Joint Collar (×4, shared geometry)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| Tip collar | `CylinderGeometry` | `(strutR*1.10, strutR*1.10, M*0.020, 12)` | `0x8899aa`, met=0.72, rgh=0.28 |

Estimated triangles per collar: 72

##### Component D: Rib Rings (×12, shared geometry)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| Rib ring | `TorusGeometry` | `(strutR*1.15, M*0.003, 4, 12)` | `0x8899aa`, met=0.72, rgh=0.28 |

Estimated triangles per ring: 96 (4 radial × 12 tubular × 2 tris)

##### Component E: ROSA Gold Edges (×2 panels)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| Edge lines | `EdgesGeometry` + `LineSegments` | `(panelGeo, 1)` | `LineBasicMaterial({ color: 0xccaa44 })` |

Estimated triangles: 0 (line primitives, not triangle primitives)

---

#### 13.2.8 Total Polygon Budget

| Component | Count | Tris Each | Total Tris |
|-----------|-------|-----------|------------|
| Round CFRP strut tubes | 4 | 72 | 288 |
| Root joint collars | 4 | 72 | 288 |
| Tip joint collars | 4 | 72 | 288 |
| Rib ring collars | 12 | 96 | 1,152 |
| ROSA gold edges | 2 | 0 (lines) | 0 |
| **TOTAL** | **26 meshes** | — | **~2,016** |

This is **well within the ≤3,000 triangle budget**. For comparison, the existing 4×
`CylinderGeometry(strutR, strutR, strutLen, 8)` struts produce 4 × 32 = 128 triangles.
The new design adds ~1,888 triangles (net: 128 → 2,016) for significantly improved
visual fidelity through CFRP material, rib ring segmentation, and metallic end fittings.
The entire strut assembly equals one 32×32 sphere (1,984 tris).

**Draw calls**: 4 strut meshes + 4 root collars + 4 tip collars + 12 rib rings + 2 ROSA
edge LineSegments = 26 draw calls. Shared geometries and materials minimize GPU state
changes (5 unique material instances: strutMat, ribMat, rootCollarMat, tipCollarMat, goldEdgeMat).

**LOC estimate**: ~60 lines replacing current ~50 lines in [`_buildStruts()`](js/entities/PlayerSatellite.js:733)
(geometry change is minimal — main additions are rib ring + collar loops), plus ~12 lines
in [`_buildSolarPanels()`](js/entities/PlayerSatellite.js:948) for gold edges.
Net addition: ~22 LOC across 2 methods. No new helper method needed.

---

#### 13.2.9 Assembly Diagrams

```
  COMPLETE STRUT ASSEMBLY — SIDE VIEW (one of 4 struts)
  Local Y axis: pivot at top (Y=0), tip at bottom (Y = -strutLen)

  ═══════════════════════════════  COLLAR RING (§13.1)
       ╱╲  A-frames (§13.1)  ╱╲
      ╱●●╲══════════════════╱●●╲  ← Hinge pins (17-4PH §13.1)
     └────┘                └────┘
         ╔══════════════╗          ← Root joint collar (7075-T6)
         ║   ┌──────┐   ║            ∅60mm round × 25mm tall
    Y=0  ╚═══╡PIVOT ╞═══╝            (bonded to CFRP tube root)
              └──┬───┘
                 │
                 │  ←── Round CFRP tube ∅50mm
           ┌─┐  │  ┌─┐               Dark carbon fiber (0x2a2a30)
   25%  ───┤R├──┼──┤R├───            1600mm length
           └─┘  │  └─┘  ← Rib Ring₁ (6061-T6, 0x8899aa)
                 │
                 │
           ┌─┐  │  ┌─┐
   50%  ───┤R├──┼──┤R├───  ← Rib Ring₂
           └─┘  │  └─┘
                 │
                 │
           ┌─┐  │  ┌─┐
   75%  ───┤R├──┼──┤R├───  ← Rib Ring₃
           └─┘  │  └─┘
                 │
           ╔═══╧═══╗
   85%     ║ REEL  ║       ← Reel housing (→ redesigned in §13.3)
           ╚═══╤═══╝         ∅120mm × 80mm, (0x666677)
                 │
           ┌────┼────┐
   95%     │SPRING MT│     ← Spring mount (existing, unchanged)
           └────┼────┘       40mm × 80mm × 30mm box
                 │
         ╔══════╧══════╗
  Y=-L   ║  TIP COLLAR ║   ← Tip joint collar (6061-T6)
         ╚══════╤══════╝      ∅55mm round × 20mm tall
                │
          [DAUGHTER ARM DOCK]
          [BRIDLE RING]
```

```
  STRUT ROUND TUBE CROSS-SECTION — END VIEW
  (looking toward tip, -Y, with rib ring collar shown)

                  ┌── Rib ring collar (6061-T6) ──┐
                  │   TorusGeometry, ∅57.5mm       │
                  │   tube r=3mm, 4×12 segments    │
                ╭─┴────────────────────────────╮   │
              ╱                                  ╲  │
            ╱         ╭──────────────╮             ╲│
           │        ╱   ╭────────╮    ╲             │
           │       │   │          │    │            │
           │       │   │  HOLLOW  │    │            │
           │       │   │  (air)   │    │            │
           │       │   │          │    │            │
           │        ╲   ╰────────╯    ╱             │
            ╲         ╰──────────────╯             ╱
              ╲        CFRP tube wall            ╱
                ╰──────── 2mm thick ───────────╯
                       ← ∅50mm OD →

  Tube: 0x2a2a30 (dark CFRP, met=0.15, rgh=0.65)
  Rib ring: 0x8899aa (machined 6061-T6, met=0.72, rgh=0.28)

  Equal EI in all planes — correct for variable-angle loading.
```

```
  ROSA PANEL WITH GOLD EDGE — TOP VIEW (looking down +Z barrel axis)

                        BARREL
                    ┌────────────┐
                    │            │
  ╔═════════════════╪════════════╪═════════════════╗
  ║                 │            │                 ║  ← Gold edge (0xccaa44)
  ║  ┌─────────────────────────────────────────┐  ║    LineBasicMaterial
  ║  │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│  ║    (unlit, always visible)
  ║  │░░░░░░░░░░░ROSA PANEL░░░░░░░░░░░░░░░░░░│  ║
  ║  │░░░░░░░░░░░(0x0a1133)░░░░░░░░░░░░░░░░░░│  ║
  ║  │░░░░░░░░░░░+ blue grid░░░░░░░░░░░░░░░░░│  ║
  ║  │░░░░░░░░░░░(0x2244aa)░░░░░░░░░░░░░░░░░░│  ║
  ║  │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│  ║
  ║  └─────╲░░░░░░░░░░░░░░░░░░░░░░░░╱─────────┘  ║
  ║         ╲░░░░░░░░░░░░░░░░░░░░░░╱              ║  ← Chamfered corners
  ╚══════════╲══════════════════════╱══════════════╝
              ╲                    ╱
               └──────────────────┘

  Panel: ShapeGeometry (existing, unchanged)
  Grid: PlaneGeometry wireframe (existing, unchanged)
  Gold edge: EdgesGeometry → LineSegments (NEW)

  Width: 1.0m (rosaW)    Length: 2.0m (rosaL)
  Chamfer: 0.30m on outboard bottom corners
```

---

#### 13.2.10 Integration Points

##### A. Collar End — Connection to Double-A Hinge (§13.1)

The strut's [`pivotGroup`](js/entities/PlayerSatellite.js:761) origin is at the collar ring surface:
```javascript
pivotGroup.position.set(
  Math.cos(azRad) * collarR,   // on collar ring circle
  Math.sin(azRad) * collarR,
  collarY,                     // Z = 0.90m
);
```

The §13.1 hinge pin is offset `M * 0.040` radially outward from the collar. The root
joint collar (25mm tall, 30mm radius) visually bridges this gap — its envelope overlaps
the inner A-frame faces. No mechanical re-alignment needed; the existing pivot position
remains at the collar surface (the collar is the structural attachment datum, and the
A-frame brackets project outward from it).

**No changes to [`_buildCollar()`](js/entities/PlayerSatellite.js:518) or `hingeMounts[]`.**

##### B. Tip End — Connection to Daughter Arm

The strut tip node is a `THREE.Group` at [`pivotGroup.localY = -strutLen`](js/entities/PlayerSatellite.js:778):
```javascript
const tipNode = new THREE.Group();
tipNode.position.y = -strutLen;
pivotGroup.add(tipNode);
```

The daughter arm's [`dockOffset`](js/entities/ArmUnit.js:53) is updated each frame by
[`_updateStruts(dt)`](js/entities/PlayerSatellite.js:2769) to match the strut tip world
position. The tip joint collar sits at the visual strut tip but does not affect the
functional tip node position.

**No changes to `strutTipNodes[]` or `ArmUnit.dockOffset` interface.**

##### C. Animation — `_updateStruts(dt)` Compatibility

The current [`_updateStruts(dt)`](js/entities/PlayerSatellite.js:2769) rotates the
`pivotGroup` quaternion to sweep the strut between stowed (α=0, −Z) and deployed
(α=π/2, radial). It does NOT modify strut geometry, scale, or sub-mesh positions.

**The new rib rings and joint collars are all children of `pivotGroup` alongside the
strut mesh (unchanged `CylinderGeometry`).** They rotate as a rigid assembly when
`pivotGroup.setRotationFromQuaternion()` is called. No changes to `_updateStruts(dt)`.

##### D. Preserved Interfaces (Must Not Change)

| Interface | Type | Location | Used By |
|-----------|------|----------|---------|
| `this.strutPivots[]` | `THREE.Group[]` | [`_buildStruts()`](js/entities/PlayerSatellite.js:750) | `_updateStruts()` |
| `this.strutMeshes[]` | `THREE.Mesh[]` | [`_buildStruts()`](js/entities/PlayerSatellite.js:751) | Cosmetic reference only |
| `this.strutTipNodes[]` | `THREE.Group[]` | [`_buildStruts()`](js/entities/PlayerSatellite.js:752) | `ArmManager` docking |
| `this.strutGroups[]` | `Array<{pivotGroup, strut, tipNode, azRad, baseQuat, strutDir}>` | [`_buildStruts()`](js/entities/PlayerSatellite.js:755) | `_updateStruts()`, `postArmUpdate()` |
| `this._strutLen` | `number` | [`_buildStruts()`](js/entities/PlayerSatellite.js:742) | `_updateStruts()` dock offset calc |
| `this._solarArrayPivot` | `THREE.Group` | [`_buildSolarPanels()`](js/entities/PlayerSatellite.js:1002) | Sun-tracking |
| `this.panelRightPivot` | `THREE.Group` | [`_buildSolarPanels()`](js/entities/PlayerSatellite.js:1007) | ROSA deploy anim |
| `this.panelLeftPivot` | `THREE.Group` | [`_buildSolarPanels()`](js/entities/PlayerSatellite.js:1033) | ROSA deploy anim |
| `this._rosaPanelWrapper1` | `THREE.Group` | [`_buildSolarPanels()`](js/entities/PlayerSatellite.js:1012) | ROSA deploy anim |
| `this._rosaPanelWrapper2` | `THREE.Group` | [`_buildSolarPanels()`](js/entities/PlayerSatellite.js:1038) | ROSA deploy anim |
| `this.hingeMounts[]` | `THREE.Mesh[]` | [`_buildCollar()`](js/entities/PlayerSatellite.js:609) | `postArmUpdate()` — **do not touch** |
| `this.hingeLEDs[]` | `THREE.Mesh[]` | [`_buildCollar()`](js/entities/PlayerSatellite.js:610) | `postArmUpdate()` — **do not touch** |

**The `strut` reference in `strutGroups[].strut` continues to point to the `CylinderGeometry`
mesh — the geometry type is unchanged (only segment count 8→12 and material change).
All references through `strutGroups[]` remain identical.**

##### E. Reel Housing + Spring Mount (Unchanged in S3.2 — Reel Redesigned in §13.3)

The reel housing (at 85% strut length, [line 783](js/entities/PlayerSatellite.js:783)) and
spring mount bracket (at 95%, [line 793](js/entities/PlayerSatellite.js:793)) are currently
direct children of `pivotGroup`. They remain as-is **within S3.2 scope** — their
`CylinderGeometry` / `BoxGeometry` and positioning are unaffected by the material/segment
change. The reel housing's ∅120mm diameter is larger than the ∅50mm strut tube, so it
visually "wraps" the strut correctly.

**Note:** The reel housing is **replaced** in S3.3 (§13.3) with a detailed cartridge
assembly (housing shell, spool drum, exit guide, latch, LED). The spring mount is
unchanged in both S3.2 and S3.3 (crossbow-mechanism scope, S3.4/S3.5).

---

#### 13.2.11 Color Palette Reference

```
  MATERIAL SWATCHES (approximate monitor appearance)

  NEW in S3.2:
  Strut CFRP      ▓▓▓▓▓  #2a2a30  Very dark gray-blue (CFRP carbon weave, met=0.15)
  Rib rings       ░▒░▒░  #8899aa  Cool silver-blue (machined 6061-T6, met=0.72)
  Root collar     ░░░░░  #8888a0  Silvery blue-gray (7075-T6, matches collar ring)
  Tip collar      ░▒░▒░  #8899aa  Cool silver-blue (6061-T6, matches rib rings)
  ROSA gold edge  ▒▓▒▓▒  #ccaa44  Warm gold (MIL-DTL-5541F chromate, unlit Basic)

  EXISTING (unchanged, shown for context):
  Reel housing    ░░▒▒░  #666677  Medium gray (existing reelMat)
  Strut old gray  ░░░░░  #999999  Generic gray (REPLACED by #2a2a30 above)
  Panel surface   █████  #0a1133  Near-black navy (existing panelMat)
  Grid wireframe  ─ ─ ─  #2244aa  Blue at 30% opacity (existing gridMat)
  Barrel body     █████  #1a1a2e  Dark blue-black (existing _matBody)
  Collar ring     ░░░░░  #8888a0  Silvery blue-gray (§13.1)
  A-frame bracket ▒▒▒▒▒  #9090a8  Lighter machined aluminum (§13.1)
  Gold MLI        ▒▓▒▓▒  #aa8833  Warm gold (existing _matGoldMLI)
```

---

#### 13.2.12 Implementation Notes

1. **Shared geometries**: All 4 struts share ONE `CylinderGeometry` (same as current,
   just 12 segments instead of 8). All 12 rib rings share ONE `TorusGeometry`. All 4
   root collars share ONE `CylinderGeometry`, same for tip collars. Use
   `new THREE.Mesh(sharedGeo, sharedMat)` for each instance (Three.js reference-shares
   geometry + material, unique transform).

2. **No new helper methods**: Unlike §13.1 (`_aframeShape()`), this change requires no
   new Shape helpers. The strut body stays `CylinderGeometry`. The only code additions
   are the rib ring loop, two collar constructors, and the gold edge lines.

3. **Minimal strut geometry change**: The `strutMeshes[]` array and `strutGroups[].strut`
   entries continue to point to `CylinderGeometry` meshes. Only the segment count (8→12)
   and material change. No structural code refactoring needed.

4. **Material replacement**: Current [`strutMat`](js/entities/PlayerSatellite.js:746) is
   `{ color: 0x999999, metalness: 0.6, roughness: 0.4 }` (generic gray metal). Replace
   with CFRP material `{ color: 0x2a2a30, metalness: 0.15, roughness: 0.65 }`. This is a
   **separate** material instance from the rib ring / collar materials (different metalness
   and roughness values reflect composite vs machined metal).

5. **Gold edge Z-offset**: The `edge.position.z = 0.001` offset places the `LineSegments`
   fractionally above the panel surface in the wrapper's local frame (which has
   `rotation.x = -PI/2` mapping local Z to world Y). This prevents z-fighting with the
   panel `ShapeGeometry` and grid `PlaneGeometry` underneath.

6. **LOD consideration**: At ORBIT distances (15–50m), the round tube cross-section is
   sub-pixel, but the rib rings and joint collars (bright aluminum `0x8899aa` vs dark
   CFRP `0x2a2a30`) provide clearly visible light/dark segmentation along the strut at
   all camera distances. The CFRP dark material reads as "not metal" even at range. The
   gold ROSA edges (`0xccaa44`) are always visible due to unlit `LineBasicMaterial`.
   No runtime LOD swap needed.

7. **Reel + spring mount preservation (S3.2 only)**: Leave the existing `reelGeo`,
   `reelMat`, `springGeo` code blocks ([lines 783–797](js/entities/PlayerSatellite.js:783))
   completely untouched **during S3.2 implementation**. Only change the strut
   `CylinderGeometry` segment count and material, then add the new sub-meshes (root
   collar, tip collar, 3 rib rings) as additional children of `pivotGroup`. The reel mesh
   is **replaced in the subsequent S3.3** task (§13.3) with a detailed cartridge assembly.

---

### 13.3 S3.3 Cable Routing + Reel Cartridge — Strut-Mounted Tether Deployment Module

> **Sprint 3, Task 3** · Replaces the current placeholder reel cylinder in
> [`_buildStruts()`](js/entities/PlayerSatellite.js:804) with a mechanically-detailed
> replaceable cartridge assembly (housing, spool drum, exit guide, latch, LED indicator),
> and adds external power/data cable routing along each strut with P-clips at rib ring
> positions. Integrates with [`getTetherReelPosition()`](js/entities/PlayerSatellite.js:1395)
> and [`_animateTetherIndicators()`](js/entities/PlayerSatellite.js:1892) by populating the
> currently-empty [`tetherReels[]`](js/entities/PlayerSatellite.js:263) and
> [`_tetherIndicators[]`](js/entities/PlayerSatellite.js:264) arrays.

---

#### 13.3.1 Material Selection Table

Real tether deployer mechanisms drive every material choice below. The housing is a
precision-machined aluminum enclosure with hard-anodized finish for cable wear resistance.
The drum is the visible wound tether spool whose color indicates the tether tier material.
Cable harness and P-clips use standard spacecraft harness hardware.

| Part | Material | Grade | Rationale | Color Hex | Metalness | Roughness |
|------|----------|-------|-----------|-----------|-----------|-----------|
| **Reel housing shell** | Hard-anodized aluminum | 6061-T6 (MIL-A-8625 Type III) | Standard enclosure for cable management hardware. Hard anodize (50µm coating) provides wear resistance at cable contact surfaces. Darker than bare aluminum — reads as "mechanism" vs "structure." Used on JAXA EDT deployer housings, TUI KRAKEN cartridge bodies. | `0x505868` | 0.40 | 0.50 |
| **Spool drum** | Wound tether material | (varies by tier) | Visible wound cable on the spool core. Color indicates tether material grade (see §13.3.3 tier color table). Core is aluminum hub with tether wound over it. Visual appearance dominated by cable material, not hub. | (per tier) | (per tier) | (per tier) |
| **Exit guide ring** | Machined aluminum | 6061-T6 | Fairlead ring preventing cable abrasion at housing exit. Polished bore for low-friction cable passage. Same alloy as rib ring collars for manufacturing commonality. Bright machined finish (not anodized — needs smooth polish at contact surface). | `0x8899aa` | 0.72 | 0.28 |
| **Cartridge latch** | Hard-anodized aluminum | 6061-T6 | Quick-release tab for cartridge swap during tether tier upgrades. Spring-loaded detent engages housing slot. Same finish as housing. | `0x505868` | 0.40 | 0.50 |
| **Status LED** | — | — | State indicator on housing forward face. Color changes with [`REEL_STATES`](js/core/Constants.js:444) (§13.3.3). Unlit material for visibility in all lighting conditions. | (per state) | — (Basic) | — |
| **Cable harness** | Teflon-jacketed bundle | Raychem DR-25 | Standard spacecraft harness jacket over power + data conductors. ∅8mm bundle (4× 22AWG power + 2× shielded data pairs + 1× tether signal). Black outer jacket reads as dark cable against CFRP strut. | `0x222228` | 0.10 | 0.80 |
| **P-clips** | Machined aluminum | 6061-T6 | Standard cable retention hardware (MIL-DTL-85052 P-clamps). Bonded to strut CFRP surface via FM-300 film adhesive. Same alloy as rib ring collars for visual consistency — clip reads as a small metallic accent on the dark strut. | `0x8899aa` | 0.72 | 0.28 |

**Why hard-anodized housing, not bare aluminum?** Real cable management hardware (wire
rope sheaves, tether fairleads, cable drums) uses hard-anodized surfaces at every point
where cable contacts metal. The MIL-A-8625 Type III coating (50µm Boehmite layer)
achieves 70+ Rockwell C surface hardness, essential for preventing cable abrasion from
gouging soft bare aluminum. The darker visual appearance (`0x505868` vs rib ring
`0x8899aa`) provides a clear material distinction between structural collars (§13.2)
and mechanism housings.

**Why not titanium?** The reel housing mass is 1.2 kg (already allocated in
[`REEL_MASS_KG`](js/core/Constants.js:351)). At this mass, Ti-6Al-4V saves ~0.5 kg but
costs 5× more and requires EDM for the precision cable guide bore. Aluminum is the
standard choice for this class of mechanism.

---

#### 13.3.2 Reel Cartridge Assembly — Geometry

The reel cartridge is a self-contained cylindrical module that clips into a bracket
position on the strut at 85% of strut length from the pivot. The cartridge concept
supports the gameplay mechanic of tether tier upgrades — swapping the entire cartridge
rather than respooling cable (matching TUI KRAKEN modular deployers and ESA YES2
replaceable drums in real practice).

**Position:** `Y = -strutLen * 0.85` in strut local coordinates (same as
[current reel](js/entities/PlayerSatellite.js:810)). This places the cartridge
between rib ring 3 (75%, 127mm clearance) and the spring mount (95%, 160mm clearance).

**Orientation:** Drum cylinder axis parallel to strut Y axis. The open housing faces
are visible from the root-ward and tip-ward directions.

**Cartridge = `THREE.Group` containing 5 child meshes in this exact order:**

| Index | Child | Purpose | Why This Order |
|-------|-------|---------|----------------|
| 0 | Housing shell | Outer enclosure (open-ended cylinder) | Largest part = index 0 convention |
| 1 | Spool drum | Wound cable visible inside housing | **Must be index 1** — keyed by [`_animateTetherIndicators():1908`](js/entities/PlayerSatellite.js:1908) for rotation |
| 2 | Exit guide ring | Fairlead torus at tip-ward face | Added after drum for draw order |
| 3 | Cartridge latch | Quick-release tab on housing side | Detail element |
| 4 | Status LED | State indicator plane on housing face | Last = easy pop/access |

```
  REEL CARTRIDGE — CROSS-SECTION (looking along strut local X-axis)
  
  Strut local Y axis: ↑ toward pivot (root), ↓ toward tip
  
              ROOT-WARD FACE
         ╭──────────────────────╮
         │    ╭──────────╮      │   Housing shell (open-ended)
         │    │  ▓▓▓▓▓▓  │      │   ∅110mm (R=55mm) × 65mm H
         │    │  ▓DRUM▓  │      │
         │    │  ▓▓▓▓▓▓  │      │   Drum: ∅90mm (R=45mm) × 55mm H
         │    ╰──────────╯      │   Color varies by TETHER_TIER
         ╰──────────┬───────────╯
                    │
              ╭─────┴─────╮         Exit guide ring
              │  ○     ○  │         TorusGeometry ∅40mm major, ∅6mm minor
              ╰───────────╯         (tether exits through center hole)
              TIP-WARD FACE
  
  ┌──┐ ← Latch tab (one side)     LED ← ● (forward face of housing)
  └──┘   25mm × 12mm × 20mm            8mm × 8mm plane
```

##### Housing Shell

```javascript
// Create once before azimuths loop — shared across all 4 struts
const housingGeo = new THREE.CylinderGeometry(
  M * 0.055, M * 0.055, M * 0.065, 8, 1, true  // open-ended
);
const housingMat = new THREE.MeshStandardMaterial({
  color: 0x505868, metalness: 0.40, roughness: 0.50,  // hard-anodized 6061-T6
});

// Inside azimuths loop:
const housing = new THREE.Mesh(housingGeo, housingMat);
housing.name = `ReelHousing_${i}`;
```

| Property | Value |
|----------|-------|
| Radius | 55mm (`M * 0.055`) |
| Height | 65mm (`M * 0.065`) |
| Radial segments | 8 |
| Height segments | 1 |
| Open-ended | `true` (drum visible inside through open top/bottom) |
| Triangles | **16** |

##### Spool Drum (children[1] — keyed for rotation animation)

```javascript
// Create once — shared geometry, material cloned per strut for tier color
const drumGeo = new THREE.CylinderGeometry(
  M * 0.045, M * 0.045, M * 0.055, 8  // closed (caps = visible flanges)
);
const drumMatBase = new THREE.MeshStandardMaterial({
  color: 0xddddee, metalness: 0.20, roughness: 0.60,  // Dyneema T0 default
});

// Inside azimuths loop — clone material so each drum can change tier color independently:
const drum = new THREE.Mesh(drumGeo, drumMatBase.clone());
drum.name = `ReelDrum_${i}`;
```

| Property | Value |
|----------|-------|
| Radius | 45mm (`M * 0.045`) — 10mm clearance to housing shell |
| Height | 55mm (`M * 0.055`) — 5mm inset from each housing face |
| Radial segments | 8 |
| Caps | `true` (closed — top/bottom caps act as visual spool flanges) |
| Triangles | **32** |

**Drum cap flanges:** The closed-end caps of the drum cylinder serve as the visual
flanges of the spool. At 45mm radius, they extend beyond the wound cable area
(~35mm radius at full spool) creating the familiar fishing-reel appearance. No
separate flange geometry needed — the 10mm clearance gap between drum caps (45mm R)
and housing wall (55mm R) provides the visual "flange overhanging the wound cable"
look when viewed through the open housing ends.

##### Exit Guide Ring

```javascript
// Create once — shared across all 4 struts
const exitGuideGeo = new THREE.TorusGeometry(M * 0.020, M * 0.003, 3, 6);
const exitGuideMat = ribMat;  // reuse rib ring material (polished 6061-T6, §13.2)

// Inside azimuths loop:
const exitGuide = new THREE.Mesh(exitGuideGeo, exitGuideMat);
exitGuide.position.y = -M * 0.035;  // tip-ward face of housing (half housing H + small gap)
exitGuide.rotation.x = Math.PI / 2; // ring plane ⊥ strut Y axis (same as rib rings)
exitGuide.name = `ReelExitGuide_${i}`;
```

| Property | Value |
|----------|-------|
| Major radius | 20mm (`M * 0.020`) — tether exits through 40mm ∅ hole |
| Minor radius (tube) | 3mm (`M * 0.003`) — thin polished ring |
| Radial segments | 3 |
| Tubular segments | 6 |
| Material | Shared `ribMat` from §13.2 (`0x8899aa`, met=0.72, rgh=0.28) |
| Triangles | **36** |

##### Cartridge Latch

```javascript
// Create once — shared geometry + material (reuse housingMat)
const latchGeo = new THREE.BoxGeometry(M * 0.025, M * 0.012, M * 0.020);

// Inside azimuths loop:
const latch = new THREE.Mesh(latchGeo, housingMat);
latch.position.set(M * 0.055, 0, 0);  // protruding from +X face of housing
latch.name = `ReelLatch_${i}`;
```

| Property | Value |
|----------|-------|
| Width (radial, X) | 25mm (`M * 0.025`) |
| Height (along strut, Y) | 12mm (`M * 0.012`) |
| Depth (tangential, Z) | 20mm (`M * 0.020`) |
| Material | Shared `housingMat` (same hard-anodized finish) |
| Triangles | **12** |

##### Status LED

```javascript
// Create once — shared geometry, material cloned per strut for state color
const ledGeo = new THREE.PlaneGeometry(M * 0.008, M * 0.008);
const ledMatBase = new THREE.MeshBasicMaterial({
  color: 0x00ff44,        // default: green (STOWED)
  side: THREE.DoubleSide, // visible from both directions
});

// Inside azimuths loop:
const led = new THREE.Mesh(ledGeo, ledMatBase.clone());
led.position.set(0, M * 0.034, M * 0.056);  // forward face of housing, near top edge
led.rotation.x = Math.PI / 2;               // face outward (Z-forward in local frame)
led.name = `ReelLED_${i}`;
```

| Property | Value |
|----------|-------|
| Size | 8mm × 8mm (`M * 0.008`) |
| Material | `MeshBasicMaterial` (unlit — visible in shadow, like §13.1 hinge LEDs) |
| Triangles | **2** |

##### Cartridge Group Assembly

```javascript
// Inside azimuths loop — assemble cartridge group
const reelCartridge = new THREE.Group();
reelCartridge.add(housing);     // children[0]
reelCartridge.add(drum);        // children[1] ← MUST be index 1 (rotation keyed here)
reelCartridge.add(exitGuide);   // children[2]
reelCartridge.add(latch);       // children[3]
reelCartridge.add(led);         // children[4]

reelCartridge.position.y = -strutLen * 0.85;  // same position as current reel
reelCartridge.name = `ReelCartridge_${i}`;
pivotGroup.add(reelCartridge);

// ── Register for getTetherReelPosition() API ──
this.tetherReels.push(reelCartridge);

// ── Register LED for _animateTetherIndicators() ──
this._tetherIndicators.push(led);
```

**This replaces the current reel mesh code** at
[`_buildStruts():804-812`](js/entities/PlayerSatellite.js:804). The current code creates
a single `CylinderGeometry(M*0.06, M*0.06, M*0.08, 8)` mesh and adds it directly to
`pivotGroup`. The new code creates a `THREE.Group` of 5 children at the same Y position,
and populates `tetherReels[]` and `_tetherIndicators[]` for API integration.

---

#### 13.3.3 Reel State Visualization (REEL_STATES Mapping)

The reel cartridge communicates state through three visual channels: LED color, drum
rotation, and drum material color (tier). State is read from
[`REEL_STATES`](js/core/Constants.js:444) via the
[`TetherReelSystem`](js/systems/TetherReel.js:67) state machine:
`STOWED → PAYING_OUT → STATIC ↔ REELING_IN → STOWED` (any → JAMMED or CUT).

##### A. LED State Colors

| REEL_STATE | LED Color | Hex | Behavior |
|------------|-----------|-----|----------|
| `STOWED` | Green | `0x00ff44` | Solid — cable fully spooled, reel ready |
| `PAYING_OUT` | Amber | `0xffaa00` | Pulsing (opacity 0.5–1.0, 2 Hz sinusoid) |
| `STATIC` | Dim amber | `0x886600` | Solid — cable out, tension steady |
| `REELING_IN` | Amber | `0xffaa00` | Pulsing (opacity 0.5–1.0, 2 Hz sinusoid) |
| `JAMMED` | Red | `0xff2222` | Fast pulse (4 Hz sinusoid) — attention required |
| `CUT` | Dark red | `0xff0000` | Solid — terminal failure, reel inoperative |

##### B. Drum Rotation Animation

| REEL_STATE | Drum Rotation | Rate | Direction |
|------------|---------------|------|-----------|
| `STOWED` | None | 0 | — |
| `PAYING_OUT` | `drum.rotation.y += dt * 3.0` | 3.0 rad/s | CCW from above (paying out) |
| `STATIC` | None | 0 | — |
| `REELING_IN` | `drum.rotation.y -= dt * 2.0` | 2.0 rad/s | CW (reeling in — slower motor) |
| `JAMMED` | None (stuck) | 0 | — |
| `CUT` | None | 0 | — |

**Existing animation compatibility:** The current
[`_animateTetherIndicators(dt):1908`](js/entities/PlayerSatellite.js:1908) already
rotates `tetherReels[i].children[1].rotation.z` during `'deployed'` state. S3.3 shifts
rotation to `.rotation.y` because the drum's cylinder axis aligns with the strut's
local Y. The animation code must be updated from `.rotation.z` to `.rotation.y`.

**Legacy state mapping:** The existing `_animateTetherIndicators` uses the legacy state
strings (`'ready'`, `'deployed'`, `'empty'`). When [`FEATURE_FLAGS.TETHER_REEL`](js/core/Constants.js)
is enabled, map the new [`REEL_STATES`](js/core/Constants.js:444) to visual behavior:

| Legacy State | Equivalent REEL_STATES | LED | Drum |
|-------------|------------------------|-----|------|
| `'ready'` | `STOWED` | Green solid | Static |
| `'deployed'` | `PAYING_OUT`, `STATIC`, `REELING_IN` | Amber | Rotating (PAYING_OUT/REELING_IN) or static (STATIC) |
| `'empty'` | `CUT`, `JAMMED` | Red | Static |

##### C. Drum Color by Tether Tier

When the player upgrades to a new [`TETHER_TIERS`](js/core/Constants.js:618) tier, the
drum material color updates to reflect the wound cable material appearance:

| Tier | Material | Drum Color | Hex | Metalness | Roughness | Real-World Appearance |
|------|----------|------------|-----|-----------|-----------|----------------------|
| T0 | Dyneema SK78 | White | `0xddddee` | 0.20 | 0.60 | UHMWPE braided fiber — white/cream |
| T1 | Zylon PBO | Gold-amber | `0xcc9933` | 0.25 | 0.55 | PBO fiber is characteristic golden-brown |
| T2 | CNT yarn | Near-black | `0x333344` | 0.30 | 0.50 | Carbon nanotube rope — very dark |
| T3 | GSL-50 | Silver-blue | `0x8899bb` | 0.45 | 0.40 | Graphene superlattice composite — exotic appearance |
| T4 | GSL-100 | Metallic blue | `0x5577aa` | 0.55 | 0.35 | High-grade GSL — distinctive blue sheen |

**Implementation:** On tier change, update the drum material properties:
```javascript
drum.material.color.setHex(tierColor);
drum.material.metalness = tierMetalness;
drum.material.roughness = tierRoughness;
```
This is a cosmetic property swap — no geometry change, no allocation, no material rebuild.

---

#### 13.3.4 Cable Harness Routing

The power/data cable harness runs along the exterior of each strut from the root collar
area to the reel housing entry point. This represents the real-world cable bundle carrying
motor power, sensor data, and tether tension signals from the mother bus to the strut-tip
reel mechanism and onward to the daughter arm.

**Real-world precedent:**
- **ISS truss segments**: External cable harnesses with P-clamps every ~30cm, visible
  bundles with black Teflon outer jacket and gold Kapton thermal wrap segments
- **Hubble**: External cable trays with thermal wrap (visible gold cable bundles)
- **Small composite tube (50mm OD, ~2mm wall)**: No internal cavity for routing — external
  harness is the only option (confirmed in §14.4)

**Routing path** (in strut local coordinates, Y=0 at pivot, Y=-strutLen at tip):

```
  Root collar exit (Y = -M*0.015, near pivot)
        │
        │  Cable harness (∅8mm TubeGeometry)
        │  Offset: +X by 30mm from strut centerline
        │  (strut surface radius 25mm + 5mm standoff)
        │
   ─────┼── P-Clip₁ at 25% strutLen (Y = -0.40m)
        │
        │
   ─────┼── P-Clip₂ at 50% strutLen (Y = -0.80m)
        │
        │
   ─────┼── P-Clip₃ at 75% strutLen (Y = -1.20m)
        │
        ▼
  Reel housing entry (Y = -strutLen*0.85 + M*0.0325 = -1.328m)
```

**Offset from strut surface:** Cable center is offset
`strutR + M * 0.005 = M * 0.030` (30mm) from the strut centerline in the local +X
direction. This places the cable 5mm above the strut outer surface, on the radially
outward face of the strut relative to the barrel.

##### TubeGeometry Construction

```javascript
// Create once before azimuths loop — shareable (identical local-space path)
const cableR = M * 0.004;                // ∅8mm cable bundle radius
const cableOffset = strutR + M * 0.005;  // 30mm from strut center (25mm R + 5mm standoff)

const cablePoints = [
  new THREE.Vector3(cableOffset, -M * 0.015, 0),                       // root collar exit
  new THREE.Vector3(cableOffset, -strutLen * 0.25, 0),                  // clip 1
  new THREE.Vector3(cableOffset, -strutLen * 0.50, 0),                  // clip 2
  new THREE.Vector3(cableOffset, -strutLen * 0.75, 0),                  // clip 3
  new THREE.Vector3(cableOffset, -strutLen * 0.85 + M * 0.0325, 0),    // reel housing entry
];
const cablePath = new THREE.CatmullRomCurve3(cablePoints);
const cableGeo = new THREE.TubeGeometry(cablePath, 4, cableR, 3, false);
const cableMat = new THREE.MeshStandardMaterial({
  color: 0x222228, metalness: 0.10, roughness: 0.80,  // black Teflon-jacketed bundle
});

// Inside azimuths loop:
const cable = new THREE.Mesh(cableGeo, cableMat);
cable.name = `CableHarness_${i}`;
pivotGroup.add(cable);
```

| Property | Value |
|----------|-------|
| Bundle diameter | 8mm (`cableR = M * 0.004`) |
| Tubular segments | 4 (along 1.35m path length) |
| Radial segments | 3 (triangular cross-section — minimum for tube) |
| Closed | `false` (open-ended, terminating into housing) |
| Path type | `CatmullRomCurve3` through 5 waypoints |
| Offset from strut center | 30mm in local +X |
| Triangles | **24** |

**Why `TubeGeometry`, not `Line`?** A `Line` primitive (1px screen-space) would be
invisible against the dark CFRP strut (`0x2a2a30` strut vs `0x222228` cable — nearly
the same brightness at 1px). The `TubeGeometry` catches scene lighting and casts subtle
shading, making the cable visible at inspection distance (2–15m) without significant
polygon cost. At orbit distance (15–50m) the cable is sub-pixel either way. The 24-tri
cost per strut (96 total) is justified by the visual upgrade at the primary inspection
viewing distance.

**Why `CatmullRomCurve3` for a nearly-straight line?** The cable path is nearly straight
(all points share the same X offset and Z=0), but `CatmullRomCurve3` produces smooth
parameter distribution along the tube, preventing segment bunching at waypoints. A
`LineCurve3` would work but `CatmullRomCurve3` allows future curvature (e.g., cable droop
modeling under thermal expansion) with zero code change.

**Shared geometry:** Since all 4 cables have identical local-space paths (same offset,
same strut length), create ONE `cableGeo` and ONE `cableMat` before the loop. Each
`new THREE.Mesh(cableGeo, cableMat)` instance shares the geometry/material; only the
parent `pivotGroup` transform differs.

---

#### 13.3.5 Cable P-Clips

Three cable retention clips at each rib ring position (25%, 50%, 75% of strut length).
Each clip is a simplified P-clamp bracket bonded to the CFRP strut surface, co-located
with the corresponding rib ring collar from §13.2.

```
  P-CLIP CROSS-SECTION (looking down strut Y-axis toward tip)
  
         STRUT SURFACE (round, ∅50mm)
              ╱────╲
       ┌────╱──┐    ╲
       │  ╱ ○○ │     │      ← Cable bundle (∅8mm)
       │ │  ○○ │     │         inside clip bracket
       │  ╲ ○○ │     │      ← P-Clip: 12mm × 8mm × 6mm box
       └────╲──┘     ╱         (simplified from U-bracket)
              ╲────╱
         
         ← 30mm → from strut center axis
```

```javascript
// Create once before azimuths loop — shared across all 12 clips
const clipGeo = new THREE.BoxGeometry(M * 0.012, M * 0.008, M * 0.006);
// Reuse ribMat from §13.2 (same 6061-T6 machined aluminum)

// Inside azimuths loop:
for (const frac of [0.25, 0.50, 0.75]) {
  const clip = new THREE.Mesh(clipGeo, ribMat);
  clip.position.set(
    strutR + M * 0.005,   // same X offset as cable center (30mm from strut center)
    -strutLen * frac,      // co-located with rib ring Y position
    0,                     // centered on cable Z plane
  );
  clip.name = `PClip_${i}_${frac * 100}`;
  pivotGroup.add(clip);
}
```

| Property | Value |
|----------|-------|
| Width (radial, X) | 12mm (`M * 0.012`) |
| Height (along strut, Y) | 8mm (`M * 0.008`) — matches cable ∅ |
| Depth (tangential, Z) | 6mm (`M * 0.006`) |
| Material | Shared `ribMat` from §13.2 (`0x8899aa`, met=0.72, rgh=0.28) |
| Count per strut | 3 |
| Triangles per clip | **12** |
| Triangles per strut (3 clips) | **36** |

**Shared geometry:** All 12 P-clips (3 per strut × 4 struts) share ONE `BoxGeometry`
instance and the existing `ribMat`. Clips appear as small bright metallic accents on the
dark CFRP strut — the same visual "tick mark" pattern as the rib rings, reinforcing the
field-joint segmentation rhythm at each 25% interval.

---

#### 13.3.6 Three.js Geometry Specification Summary

All dimensions use `const M = 0.00001` (1 meter in scene units, defined at
[`PlayerSatellite.js:30`](js/entities/PlayerSatellite.js:30)).

##### Component A: Reel Housing Shell (×4, shared geometry)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| Housing | `CylinderGeometry` | `(M*0.055, M*0.055, M*0.065, 8, 1, true)` | `0x505868`, met=0.40, rgh=0.50 |

Estimated triangles per housing: 16

##### Component B: Spool Drum (×4, shared geometry, cloned material)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| Drum | `CylinderGeometry` | `(M*0.045, M*0.045, M*0.055, 8)` | Per tier (default `0xddddee`, met=0.20, rgh=0.60) |

Estimated triangles per drum: 32

##### Component C: Exit Guide Ring (×4, shared geometry)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| Guide | `TorusGeometry` | `(M*0.020, M*0.003, 3, 6)` | `0x8899aa`, met=0.72, rgh=0.28 (shared `ribMat`) |

Estimated triangles per guide: 36

##### Component D: Cartridge Latch (×4, shared geometry)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| Latch | `BoxGeometry` | `(M*0.025, M*0.012, M*0.020)` | `0x505868`, met=0.40, rgh=0.50 (shared `housingMat`) |

Estimated triangles per latch: 12

##### Component E: Status LED (×4, shared geometry, cloned material)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| LED | `PlaneGeometry` | `(M*0.008, M*0.008)` | `MeshBasicMaterial` (per state, cloned) |

Estimated triangles per LED: 2

##### Component F: Cable Harness Tube (×4, shared geometry)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| Cable | `TubeGeometry` | `(cablePath, 4, M*0.004, 3, false)` | `0x222228`, met=0.10, rgh=0.80 |

Estimated triangles per cable: 24

##### Component G: P-Clips (×12, shared geometry)

| Sub-part | Geometry | Parameters | Material |
|----------|----------|------------|----------|
| P-clip | `BoxGeometry` | `(M*0.012, M*0.008, M*0.006)` | `0x8899aa`, met=0.72, rgh=0.28 (shared `ribMat`) |

Estimated triangles per clip: 12

---

#### 13.3.7 Total Polygon Budget

| Component | Count | Tris Each | Total Tris |
|-----------|-------|-----------|------------|
| Reel housing shells | 4 | 16 | 64 |
| Spool drums | 4 | 32 | 128 |
| Exit guide rings | 4 | 36 | 144 |
| Cartridge latches | 4 | 12 | 48 |
| Status LEDs | 4 | 2 | 8 |
| Cable harness tubes | 4 | 24 | 96 |
| P-clips | 12 | 12 | 144 |
| **TOTAL** | **36 meshes** | — | **632** |

**Budget: ≤800 triangles. Actual: 632. Headroom: 168 tris (21%).**

**Removed geometry:** The current reel mesh per strut is
`CylinderGeometry(M*0.06, M*0.06, M*0.08, 8)` = 32 tris × 4 struts = 128 tris. These
are replaced. Net addition: 632 − 128 = **504 new triangles** for full cartridge
assemblies + cable routing + clips.

**Draw calls:** 4×housing + 4×drum + 4×exitGuide + 4×latch + 4×LED + 4×cable + 12×clips
= **36 draw calls** (replacing 4 previous reel cylinder draw calls, net +32). Shared
geometries minimize GPU state changes: 7 unique geometry instances (`housingGeo`,
`drumGeo`, `exitGuideGeo`, `latchGeo`, `ledGeo`, `cableGeo`, `clipGeo`) and 5 unique
material instances (`housingMat`, `drumMat`, `ribMat` reused, `cableMat`, `ledMat`).

**LOC estimate:** ~65 lines replacing current ~10 lines for the reel mesh block, plus
~25 lines for cable + clips construction. ~15 lines of modifications to
[`_animateTetherIndicators()`](js/entities/PlayerSatellite.js:1892) for expanded LED/drum
state mapping. **Net addition: ~95 LOC across 2 methods.**

---

#### 13.3.8 Assembly Diagrams

```
  COMPLETE STRUT WITH REEL CARTRIDGE + CABLE — SIDE VIEW (one of 4)
  Local Y axis: pivot at top (Y=0), tip at bottom (Y = -strutLen)
  Cable harness shown on right side (+X offset from strut center)

  ═══════════════════════════════  COLLAR RING (§13.1)
       ╱╲  A-frames (§13.1)  ╱╲
      ╱●●╲═══════════════════╱●●╲  ← Hinge pins
     └────┘               └────┘
         ╔═════════════╗              ← Root joint collar (§13.2)
    Y=0  ╚═════╤═══════╝
               │ ┄┄┄┄┄┄┄ ┬           ← Cable exit from root collar area
               │          │             (power + data harness, ∅8mm)
               │          │
         ┌─┐   │    ┌─┐  ┌┤
  25% ───┤R├───┼────┤R├──┤C├──        ← Rib Ring₁ + P-Clip₁
         └─┘   │    └─┘  └┤
               │          │
               │          │
         ┌─┐   │    ┌─┐  ┌┤
  50% ───┤R├───┼────┤R├──┤C├──        ← Rib Ring₂ + P-Clip₂
         └─┘   │    └─┘  └┤
               │          │
               │          │
         ┌─┐   │    ┌─┐  ┌┤
  75% ───┤R├───┼────┤R├──┤C├──        ← Rib Ring₃ + P-Clip₃
         └─┘   │    └─┘  └┤
               │          │
               │ ┄┄┄┄┄┄┄ ┘           ← Cable enters reel housing
         ╔═════╧═══════╗
  85%    ║   ╭─────╮   ║             ← REEL CARTRIDGE (§13.3)
         ║   │▓▓▓▓▓│   ║ ┌──┐          Housing: ∅110mm × 65mm H
         ║   │▓DRUM▓│  ╠═┤LT├          Drum: ∅90mm × 55mm H (tier color)
         ║   │▓▓▓▓▓│   ║ └──┘          Latch tab (housing side, +X)
         ║   ╰──┬──╯   ║         ●  ← LED (forward face, 8mm sq)
         ╚═════╤═══════╝
             ╭─┴─╮                   ← Exit guide ring (∅40mm torus)
             ╰───╯                      Tether exits here → via bridle ring
               │
         ┌─────┼─────┐
  95%    │ SPRING MT  │               ← Spring mount (existing, §S3.4 scope)
         └─────┼─────┘                  40mm × 80mm × 30mm box
               │
         ╔═════╧═══════╗
  ~100%  ║  TIP COLLAR ║             ← Tip joint collar (§13.2)
         ╚═════╤═══════╝                ∅55mm × 20mm, 6061-T6
               │
         [DAUGHTER ARM DOCK]
         [BRIDLE RING → S3.4/S3.5]
```

```
  REEL CARTRIDGE — END VIEW (looking toward tip, -Y direction)
  Showing housing shell, drum (visible through open end), latch, and LED

                 ╭──────────────────╮
               ╱     HOUSING SHELL    ╲     Housing: hard-anodized 6061-T6
             ╱        ∅110mm            ╲    0x505868, met=0.40
            │     ╭──────────╮           │
            │   ╱    DRUM      ╲         │   Drum: per-tier color
            │  │    ∅90mm       │ ┌──┐   │   Default: Dyneema 0xddddee
            │  │   (color =     │ │LT│   │   ← Latch tab (protruding
            │  │  tether tier)  │ └──┘   │      from housing +X side)
            │   ╲              ╱         │
            │     ╰──────────╯           │   10mm gap (drum → housing)
             ╲                          ╱
               ╲                      ╱
                 ╰──────────────────╯
                      ● LED (8mm sq, forward Z face)

  Housing: 0x505868 (hard-anodized, met=0.40)
  Drum:    0xddddee (Dyneema T0, met=0.20) — varies by tier
  Latch:   0x505868 (same as housing)
  LED:     0x00ff44 (green = STOWED, MeshBasicMaterial)
```

```
  CABLE HARNESS ROUTING — CROSS-SECTION (at rib ring position)
  Looking down strut Y-axis toward tip

                        RIB RING (torus ∅57.5mm, §13.2)
                    ╭────┴────╮
                  ╱              ╲
                ╱   CFRP TUBE      ╲     Strut: 0x2a2a30
               │    ∅50mm OD        │
               │                    │
               │                    ├── ○  ← Cable (∅8mm)
               │                    │   │    TubeGeometry, 0x222228
               │                    ├──┌┤    (3 radial × 4 tubular segs)
                ╲                  ╱   └┤ ← P-Clip (12×8×6mm box, 0x8899aa)
                  ╲              ╱
                    ╰─────────╯
         
                ← ──── 30mm ──── →  (cable offset from strut center)

  Cable offset = strutR (25mm) + 5mm standoff = 30mm from center
  Clip material matches rib ring (shared ribMat from §13.2)
```

```
  EXPLODED PARTS LIST — PER STRUT (S3.3 additions only)

  ×1 Reel housing shell ────────╮
                                │
  ×1 Spool drum ─────────────╮  │   Reel cartridge group
                             │  │   (children[0..4])
  ×1 Exit guide ring ──────╮ │  │
                           │ │  │
  ×1 Cartridge latch ────╮ │ │  │
                         │ │ │  │
  ×1 Status LED ───────╮ │ │ │  │
                       │ │ │ │  │
  ×1 Cable harness ────┤ │ │ │  │   Direct pivotGroup children
                       │ │ │ │  │
  ×3 P-clips ──────────┘ │ │ │  │   Direct pivotGroup children
                         │ │ │  │
  TOTAL PARTS PER STRUT:  5 meshes (in group) + 1 cable + 3 clips = 9 meshes + 1 group
  TOTAL FOR 4 STRUTS:    36 meshes + 4 groups
```

---

#### 13.3.9 Integration with Strut Deployment Animation

##### A. Rigid-Body Parenting

All S3.3 additions (reel cartridge group, cable tube, P-clips) are children of
[`pivotGroup`](js/entities/PlayerSatellite.js:783). When
[`_updateStruts(dt)`](js/entities/PlayerSatellite.js:2831) calls
`pivotGroup.setRotationFromQuaternion(_strutQuat)`, every child rotates as a rigid
assembly. **No per-frame position updates needed for any S3.3 component.**

This is the same parenting strategy used by §13.2 rib rings and joint collars, and
the existing reel + spring mount meshes.

```
  pivotGroup (THREE.Group) — complete child hierarchy after S3.3
    ├─ strut (CylinderGeometry)          ← existing (§13.2 material)
    ├─ tipNode (THREE.Group)             ← existing
    ├─ rootCollar (CylinderGeometry)     ← §13.2
    ├─ tipCollar (CylinderGeometry)      ← §13.2
    ├─ ribRing × 3 (TorusGeometry)       ← §13.2
    ├─ springMount (BoxGeometry)         ← existing (crossbow, not S3.3 scope)
    ├─ reelCartridge (THREE.Group)       ← §13.3 NEW (replaces old reel mesh)
    │    ├─ [0] housing (CylinderGeo)       16 tris
    │    ├─ [1] drum (CylinderGeo)          32 tris ← rotated by animation
    │    ├─ [2] exitGuide (TorusGeo)        36 tris
    │    ├─ [3] latch (BoxGeo)              12 tris
    │    └─ [4] led (PlaneGeo)               2 tris ← color by state
    ├─ cableHarness (TubeGeometry)       ← §13.3 NEW, 24 tris
    ├─ pClip_25 (BoxGeometry)            ← §13.3 NEW, 12 tris
    ├─ pClip_50 (BoxGeometry)            ← §13.3 NEW, 12 tris
    └─ pClip_75 (BoxGeometry)            ← §13.3 NEW, 12 tris
```

##### B. Strut Sweep Behavior

When α sweeps from 0 (stowed, −Z) to π (zenith, +Z), the entire `pivotGroup` rotates.
The cable harness route (along strut +X face) and reel cartridge rotate identically.
From the camera's perspective:

- **α = 0 (stowed):** Strut points aft (−Z). Cable visible on the radially outward face.
  Reel cartridge near the aft end of the barrel.
- **α = π/2 (radial):** Strut points outward. Cable runs along the trailing face.
  Reel cartridge at the tip, perpendicular to barrel axis.
- **α = π (zenith):** Strut points forward (+Z). Cable on the radially outward face.
  Reel cartridge near the forward end.

No special per-frame handling needed — rigid-body rotation handles all orientations
automatically. The cable, clips, and reel cartridge are fixed in the strut's local frame.

##### C. No Cable Geometry Morphing

The cable harness is a rigid tube bonded to the strut via P-clips. There is **no cable
droop, slack, or flex animation**. This is physically correct: the P-clips bond the cable
to the strut structure, and at ∅8mm over a 1.35m run, the harness has negligible sag
under zero-g conditions. The `TubeGeometry` is created once at construction and never
modified.

##### D. No Changes to `_updateStruts(dt)`

The existing [`_updateStruts(dt)`](js/entities/PlayerSatellite.js:2831) method is
**unchanged**. It rotates `pivotGroup` via quaternion and updates `arm.dockOffset`.
All S3.3 components, being children of `pivotGroup`, inherit the rotation automatically.
The `dockOffset` calculation references `pivotGroup.position` and `_strutTo` direction —
neither are affected by the new child meshes.

---

#### 13.3.10 Preserved Interfaces

The following interfaces **must not change** and are confirmed compatible with S3.3:

| Interface | Type | Location | How S3.3 Interacts |
|-----------|------|----------|--------------------|
| `this.tetherReels[]` | `THREE.Group[]` | [`constructor:263`](js/entities/PlayerSatellite.js:263) | **Populated** — each `reelCartridge` group pushed here. Previously empty. |
| `this._tetherIndicators[]` | `THREE.Mesh[]` | [`constructor:264`](js/entities/PlayerSatellite.js:264) | **Populated** — each LED mesh pushed here. Previously empty. |
| `this._tetherStates[]` | `string[]` | constructor | Unchanged — state strings set by `setTetherState()`. |
| [`getTetherReelPosition(index)`](js/entities/PlayerSatellite.js:1395) | → `THREE.Vector3` | line 1395 | **Now returns correct reel world position** (was fallback to satellite center when array empty). `reelCartridge.getWorldPosition()` provides actual reel position accounting for strut sweep angle. |
| [`setTetherState(index, state)`](js/entities/PlayerSatellite.js:1427) | `void` | line 1427 | Unchanged — sets `_tetherStates[index]`. LED color and drum rotation driven by `_animateTetherIndicators` reading this. |
| `this.strutTipNodes[]` | `THREE.Group[]` | [line 774](js/entities/PlayerSatellite.js:774) | Unchanged — tip nodes remain at Y=-strutLen. Reel cartridge is separate at Y=-strutLen*0.85. |
| `this.strutGroups[]` | `Array<{}>` | [line 856](js/entities/PlayerSatellite.js:856) | Unchanged — no new fields added. Reel is a pivotGroup child, not a strutGroups field. |
| `this.strutPivots[]` | `THREE.Group[]` | [line 772](js/entities/PlayerSatellite.js:772) | Unchanged — pivotGroups gain new children but identity/position unmodified. |
| `this.strutMeshes[]` | `THREE.Mesh[]` | [line 773](js/entities/PlayerSatellite.js:773) | Unchanged — still references the strut CylinderGeometry mesh. |

**Key behavioral change:** Before S3.3, [`getTetherReelPosition()`](js/entities/PlayerSatellite.js:1395)
always falls back to `this.getWorldPosition()` (satellite center) because
`tetherReels[]` is empty. After S3.3, it returns the actual reel cartridge world position
at ~85% of strut length from the pivot. This is the **correct and intended** behavior —
tether origin is at the physical reel, not at the satellite center of mass.

**`_animateTetherIndicators` activation:** Before S3.3, the guard
`if (!this._tetherIndicators || this._tetherIndicators.length === 0) return;` at
[line 1894](js/entities/PlayerSatellite.js:1894) causes immediate exit (both arrays
empty). After S3.3, `_tetherIndicators` contains 4 LED meshes, so the animation loop
engages. The drum rotation code at
[line 1907](js/entities/PlayerSatellite.js:1907) also activates because
`tetherReels[i]` is now populated.

---

#### 13.3.11 Color Palette Reference

```
  MATERIAL SWATCHES (approximate monitor appearance)

  NEW in S3.3:
  Reel housing    ▓▓▓▓▓  #505868  Dark blue-gray (hard-anodized 6061-T6, met=0.40)
  Spool drum T0   ░░░░░  #ddddee  White (Dyneema SK78, met=0.20)
  Spool drum T1   ▒▓▒▓▒  #cc9933  Gold-amber (Zylon PBO, met=0.25)
  Spool drum T2   █████  #333344  Near-black (CNT yarn, met=0.30)
  Spool drum T3   ░▒░▒░  #8899bb  Silver-blue (GSL-50, met=0.45)
  Spool drum T4   ▒░▒░▒  #5577aa  Metallic blue (GSL-100, met=0.55)
  Cable harness   █████  #222228  Near-black (Teflon jacket, met=0.10)
  LED (STOWED)    ●      #00ff44  Bright green (MeshBasicMaterial)
  LED (PAYING)    ●      #ffaa00  Amber, pulsing 2 Hz
  LED (STATIC)    ●      #886600  Dim amber, solid
  LED (REELING)   ●      #ffaa00  Amber, pulsing 2 Hz
  LED (JAMMED)    ●      #ff2222  Red, fast pulse 4 Hz
  LED (CUT)       ●      #ff0000  Dark red, solid

  REUSED from §13.2 (shared material instances):
  Exit guide      ░▒░▒░  #8899aa  Polished 6061-T6 (shared ribMat)
  P-clips         ░▒░▒░  #8899aa  Machined 6061-T6 (shared ribMat)
  Latch tab       ▓▓▓▓▓  #505868  Hard-anodized (shared housingMat)

  EXISTING (unchanged, shown for context):
  CFRP strut      ▓▓▓▓▓  #2a2a30  Dark carbon fiber (§13.2)
  Rib rings       ░▒░▒░  #8899aa  Machined 6061-T6 (§13.2)
  Root collar     ░░░░░  #8888a0  7075-T6 (§13.2)
  Tip collar      ░▒░▒░  #8899aa  6061-T6 (§13.2)
  Spring mount    ▓▓▓▓▓  #2a2a30  CFRP reuse (existing strutMat)
  Old reel        ░░▒▒░  #666677  REMOVED — replaced by S3.3 cartridge
```

---

#### 13.3.12 Implementation Notes

1. **Replaces existing reel code.** Remove the current
   [`reelGeo/reelMat/reel`](js/entities/PlayerSatellite.js:804) block (lines 804–812) and
   replace with the reel cartridge group assembly. The Y position (`-strutLen * 0.85`) is
   identical — only the geometry changes from a single cylinder to a 5-child group.

2. **Shared geometries.** All 4 reel cartridges share `housingGeo`, `drumGeo`,
   `exitGuideGeo`, `latchGeo`, `ledGeo`. All 12 P-clips share `clipGeo`. The cable
   `TubeGeometry` is shareable (identical local-space path). Create ALL shared geometries
   and materials **once** before the `tier.azimuths.forEach()` loop — same pattern as
   §13.2 `ribGeo`, `rootCollarGeo`, `tipCollarGeo`.

3. **Shared materials.** Exit guide and P-clips reuse `ribMat` from §13.2 (6061-T6,
   `0x8899aa`). Housing and latch share a new `housingMat`. Cable uses a new `cableMat`.
   Drum material is **cloned** per strut (`drumMatBase.clone()`) so each drum can
   independently change tier color. LED material is **cloned** per strut for independent
   state color. **Total new material instances:** 3 shared (`housingMat`, `cableMat`,
   `drumMatBase`) + 4 drum clones + 4 LED clones = 11.

4. **`tetherReels[]` population.** Push each `reelCartridge` group to `this.tetherReels`
   inside the `azimuths.forEach` loop, after adding to `pivotGroup`. This enables
   [`getTetherReelPosition()`](js/entities/PlayerSatellite.js:1395) to return the correct
   world position. Index order matches `strutGroups` (i.e., `tetherReels[0]` corresponds
   to strut 0 at azimuth 60°).

5. **`_tetherIndicators[]` population.** Push each LED mesh to `this._tetherIndicators`.
   This activates the [`_animateTetherIndicators(dt)`](js/entities/PlayerSatellite.js:1892)
   code path — the guard condition `if (this._tetherIndicators.length === 0) return;` on
   [line 1894](js/entities/PlayerSatellite.js:1894) will now pass, enabling LED color
   animation and drum rotation.

6. **Animation code update.** The existing `_animateTetherIndicators` rotates
   `tetherReels[i].children[1].rotation.z`. Since the drum cylinder axis is along strut
   local Y, update the rotation axis from `.rotation.z` to `.rotation.y` for correct
   visual spin. Also extend the state-color `switch` to handle
   [`REEL_STATES`](js/core/Constants.js:444) values in addition to the legacy
   `'ready'/'deployed'/'empty'` strings (dual mapping, see §13.3.3 table).

7. **Spring mount unchanged.** The
   [`springMount`](js/entities/PlayerSatellite.js:814) at 95% strut length is a
   crossbow-mechanism component (S3.4/S3.5 scope). Leave it completely untouched. The reel
   cartridge at 85% has 160mm clearance (10% of 1.6m strut) to the spring mount — no
   visual overlap.

8. **LOD consideration.** At orbit distance (15–50m), the housing + drum reads as a single
   bright-ish lump on the dark strut — similar to the current reel cylinder but with more
   geometric detail that catches specular highlights. The cable harness is sub-pixel at
   orbit distance but the P-clips (bright `0x8899aa` aluminum) add to the field-joint
   "tick mark" visual pattern established by the rib rings. At inspection distance
   (2–15m), all components are individually resolved. No runtime LOD swap needed.

9. **Tier upgrade visual.** When the player upgrades tether tier via the shop, update
   drum color: `reelCartridge.children[1].material.color.setHex(tierHex)` with matching
   `metalness`/`roughness` (see §13.3.3 tier table). Can be wired via an event listener
   on `Events.TETHER_UPGRADED` or called directly from the shop/forge system. Per-drum
   cloned materials ensure independent color per reel (e.g., if arms have different tiers).

10. **No changes outside `_buildStruts()` and `_animateTetherIndicators()`.** All other
    methods, interfaces, and files remain untouched. The reel cartridge is purely a visual
    upgrade to the existing strut assembly with API population that enables already-written
    but previously no-op code paths (`getTetherReelPosition`, LED animation, drum rotation).

---

#### 13.3.13 Sprint Build Simplifications — What to Actually Implement

The full spec above (§13.3.1–§13.3.12) documents the complete engineering design. For
Sprint 3 implementation, four simplifications reduce complexity with negligible visual
impact at game distances (2–50m):

##### Simplification Analysis

| Component | Full Spec | Simplified | Why Simplify | Impact |
|-----------|-----------|------------|--------------|--------|
| **Exit guide ring** | `TorusGeometry` ×4 = 144 tris | **DROP** | ∅40mm torus at strut tip is sub-pixel at orbit (15–50m) and barely a speck at inspection (2–15m). The tether visual is drawn by [`TetherReel`](js/systems/TetherReel.js) as a separate `LineDashedMaterial` line — it doesn't visually thread through this ring. Zero gameplay function. | −144 tris, −1 geometry type |
| **Cartridge latch** | `BoxGeometry` ×4 = 48 tris | **DROP** | 25mm tab is invisible at all game distances. No matching gameplay animation (tier swap is instant, no latch-open visual). Pure aspirational detail with no viewer payoff. | −48 tris, −1 geometry type |
| **Cable harness** | `TubeGeometry` + `CatmullRomCurve3` ×4 = 96 tris | **`Line` + `LineBasicMaterial`** | `CatmullRomCurve3` + `TubeGeometry` construction is the most complex code in S3.3 for a nearly-invisible feature (dark cable on dark strut). Replace with a simple `Line` using `BufferGeometry` + `LineBasicMaterial({color: 0x555566})`. Lighter gray makes the 1px line visible against CFRP (`0x2a2a30`) without needing 3D tube geometry. The P-clips (bright `0x8899aa` boxes) provide the primary cable-route visual cue. | −96 tris, −1 geometry, −1 material, −15 LOC |
| **Drum material** | Cloned per strut (4 instances) | **Shared** (1 instance) | All 4 reels upgrade tether tier simultaneously (no per-reel tier mixing in Y0 Quad). One shared `drumMat` suffices. If Y1/Y3 mixed tiers are added later, clone at that point. | −3 material clones |

##### What Gets Built (Final Implementation Spec)

**Reel cartridge = `THREE.Group` with 3 children:**

| Index | Child | Geometry | Tris |
|-------|-------|----------|------|
| 0 | Housing shell | `CylinderGeometry(M*0.055, M*0.055, M*0.065, 8, 1, true)` | 16 |
| 1 | Spool drum | `CylinderGeometry(M*0.045, M*0.045, M*0.055, 8)` | 32 |
| 2 | Status LED | `PlaneGeometry(M*0.008, M*0.008)` | 2 |

**Cable harness = `Line` (zero triangles):**

```javascript
// Create once before loop — shared across all 4 struts
const cableOffset = strutR + M * 0.005;  // 30mm from strut center
const cableVerts = new Float32Array([
  cableOffset, -M * 0.015, 0,                       // root collar exit
  cableOffset, -strutLen * 0.25, 0,                  // clip 1
  cableOffset, -strutLen * 0.50, 0,                  // clip 2
  cableOffset, -strutLen * 0.75, 0,                  // clip 3
  cableOffset, -strutLen * 0.85 + M * 0.0325, 0,    // reel housing entry
]);
const cableGeo = new THREE.BufferGeometry();
cableGeo.setAttribute('position', new THREE.BufferAttribute(cableVerts, 3));
const cableMat = new THREE.LineBasicMaterial({ color: 0x555566 });

// Inside loop:
const cable = new THREE.Line(cableGeo, cableMat);
cable.name = `CableHarness_${i}`;
pivotGroup.add(cable);
```

**P-clips = unchanged** (3 × `BoxGeometry` per strut, shared geometry + `ribMat`)

##### Simplified Polygon Budget

| Component | Count | Tris Each | Total Tris |
|-----------|-------|-----------|------------|
| Reel housing shells | 4 | 16 | 64 |
| Spool drums | 4 | 32 | 128 |
| Status LEDs | 4 | 2 | 8 |
| Cable harness (Line) | 4 | 0 | 0 |
| P-clips | 12 | 12 | 144 |
| **TOTAL** | **24 meshes + 4 Lines** | — | **344** |

**Budget: ≤800. Actual: 344. Headroom: 456 tris (57%).**

Compared to full spec (632 tris): **saves 288 tris** (46% reduction).

##### Simplified Material Inventory

| Material | Instance | Shared By |
|----------|----------|-----------|
| `housingMat` | 1 shared | 4 housings |
| `drumMat` | 1 shared | 4 drums (same tier, no cloning needed) |
| `ledMat` | 4 cloned | 1 per LED (independent state color) |
| `cableMat` | 1 shared | 4 cable Lines |
| `ribMat` | from §13.2 | 12 P-clips (already exists) |
| **Total** | **7 + 1 reused** | |

##### Simplified Scene Graph (per strut)

```
  pivotGroup (existing)
    ├─ strut, tipNode, rootCollar, tipCollar, ribRings×3, springMount  (existing/§13.2)
    ├─ reelCartridge (THREE.Group)       ← S3.3 NEW (replaces old reel mesh)
    │    ├─ [0] housing (CylinderGeo)       16 tris
    │    ├─ [1] drum (CylinderGeo)          32 tris ← rotation + tier color
    │    └─ [2] led (PlaneGeo)               2 tris ← state color
    ├─ cableHarness (THREE.Line)         ← S3.3 NEW, 0 tris
    ├─ pClip_25 (BoxGeo)                ← S3.3 NEW, 12 tris
    ├─ pClip_50 (BoxGeo)                ← S3.3 NEW, 12 tris
    └─ pClip_75 (BoxGeo)                ← S3.3 NEW, 12 tris
```

**Drum stays at `children[1]`** — existing animation code
[`_animateTetherIndicators():1908`](js/entities/PlayerSatellite.js:1908) references
`tetherReels[i].children[1]` for rotation. With exit guide and latch removed, LED
shifts from `children[4]` to `children[2]`, but LED is accessed via
`_tetherIndicators[i]` (separate array reference), not by children index. No conflict.

##### Implementation Task Breakdown (for Orchestrator)

**Task 1: Reel cartridge construction** (~40 LOC in [`_buildStruts()`](js/entities/PlayerSatellite.js:733))
- Create shared geometries (`housingGeo`, `drumGeo`, `ledGeo`, `clipGeo`) + materials before loop
- Inside `azimuths.forEach`: assemble 3-child group, position at `Y = -strutLen * 0.85`
- Replace existing [`reelGeo/reelMat/reel` block](js/entities/PlayerSatellite.js:804) (lines 804–812)
- Push `reelCartridge` → `this.tetherReels[]`
- Push `led` → `this._tetherIndicators[]`

**Task 2: Cable + clips** (~20 LOC in [`_buildStruts()`](js/entities/PlayerSatellite.js:733))
- Create `BufferGeometry` + `LineBasicMaterial` for cable (shared before loop)
- Create `clipGeo` `BoxGeometry` (shared before loop, reuse `ribMat`)
- Inside loop: add `THREE.Line` + 3 clip meshes to `pivotGroup`

**Task 3: Animation update** (~10 LOC in [`_animateTetherIndicators()`](js/entities/PlayerSatellite.js:1892))
- Change `children[1].rotation.z` → `children[1].rotation.y` (drum axis = strut Y)
- Keep legacy state mapping (`'ready'`/`'deployed'`/`'empty'`) — defer `REEL_STATES` integration to feature-flag enablement

**Total: ~70 LOC** across 2 methods. No new files. No new helper methods.

##### Deferred to Future Sprints

| Feature | Spec Section | Why Defer |
|---------|-------------|-----------|
| Exit guide torus | §13.3.2 | Add when tether visual threads through it |
| Cartridge latch | §13.3.2 | Add when tier-swap animation exists |
| TubeGeometry cable | §13.3.4 | Upgrade from Line if 1px proves invisible in playtesting |
| Per-drum material cloning | §13.3.12 note 3 | Add when Y1/Y3 mixed tiers are implemented |
| Full REEL_STATES LED mapping | §13.3.3 | Add when `FEATURE_FLAGS.TETHER_REEL` enabled |

---

### 13.4 S3.4 Crossbow Launcher Mechanism + EPM Docking Collar

> **Sprint 3, Task 4** · Upgrades the strut-mounted crossbow launcher bracket
> ([`SpringMount_${i}`](js/entities/PlayerSatellite.js:868)) from a placeholder box to a
> visible spring mechanism with guide rails, and replaces the daughter-side EPM dock plate
> ([`ArmUnit.js:451-459`](js/entities/ArmUnit.js:451)) with a detailed ElectroPermanent
> Magnet docking collar with power/data pogo pins. Adds bridle hardpoints on the daughter
> body for the 3-point bridle load distribution (S3.6 visual hook). Covers both
> [`PlayerSatellite._buildStruts()`](js/entities/PlayerSatellite.js:733) (strut-side) and
> [`ArmUnit._createMesh()`](js/entities/ArmUnit.js:280) (daughter-side).

---

#### 13.4.1 Engineering Analysis — How the Crossbow Actually Works

The "crossbow" is a **linear coil-spring launcher housed inside the strut**, not a pair of
curved limbs on the daughter arm. The daughter arm IS the projectile — the entire 6.6 kg
Weaver (or 2.1 kg Spinner) is the "bolt." The strut is the "stock." The spring is the "prod."

##### Launch Sequence (from code: [`_updateLaunching()`](js/entities/ArmUnit.js:2070))

```
  Phase 0 — DOCKED:  Daughter at strut tip, EPM engaged, spring compressed
  Phase 1 — EPM RELEASE (0 .. 0.3 s):  EPM pulse demagnetizes (CROSSBOW_UNDOCK_TIME)
            Daughter held by friction only; spring still compressed
  Phase 2 — SPRING FIRE (0.3 .. 0.35 s):  Latch releases, spring extends
            _applyLaunchImpulse() → velocity = launchSpeed × launchDirection
            Daughter accelerates outward along strut axis at up to 10 m/s
  Phase 3 — FREE FLIGHT (0.35+ s):  Daughter flying, tether paying out from reel
            TRANSIT state: FEEP thrusters correct course toward target
```

**Key physics** ([`_applyLaunchImpulse()`](js/entities/ArmUnit.js:1936)):
- Spring energy: `E = ½ × m × v²` = ½ × 6.6 × 10² = **330 J** (Weaver at 10 m/s)
- Spring constant: [`CROSSBOW_SPRING_K_WEAVER: 17600`](js/core/Constants.js:527) N/m
- Draw distance: [`CROSSBOW_DRAW_DISTANCE: 0.25`](js/core/Constants.js:526) m
- Stored spring energy: ½ × 17600 × 0.25² = **550 J** (η ≈ 60% → 330 J kinetic)
- Reload: worm gear motor at 15 W, 80% efficiency → **37 s** to recharge Weaver at 10 m/s

##### Tether Is Mechanical-Only — No Power, No Data

The tether is a **Dyneema SK78 tensile member only**. It carries no electrical power or
data signals. This is the correct aerospace design for several reasons:

| Concern | Why Mechanical-Only Is Right |
|---------|------------------------------|
| **Mass** | Running copper alongside 2 km of Dyneema adds 0.3 kg/km — +0.6 kg per tether. At 4 arms that's 2.4 kg wasted from the 242 kg mass budget. |
| **Reel complexity** | Power/data conductors require slip rings on the reel drum for continuous rotation. Slip rings are failure-prone in vacuum (cold welding, wear debris). A pure tensile cable needs only a smooth drum. |
| **Fatigue** | Copper fatigues after ~1000 bend cycles at reel drum radius. Dyneema survives 10,000+. Mixed cable fails at copper's limit. |
| **EDT conflict** | The tether may carry 100 mA EDT current ([`TETHER_EDT_CURRENT`](js/core/Constants.js:165)) for Lorentz propulsion. Power/data lines would require isolation from the EDT drive. |
| **Precedent** | ESA YES2 tether deployer, JAXA STARS-C, NASA TSS-1R — all mechanical-only tethers. Astroscale ELSA-d uses wireless comms during tethered operations. |

**Daughter autonomous power**: Each daughter has [`ROSA solar panels`](js/entities/ArmUnit.js:304) (8–15 W),
[`battery`](js/core/Constants.js:155) (10–20 Wh), and [`MRR laser comms`](js/entities/ArmUnit.js:435)
(1 Mbps via retroreflector). Fully autonomous when deployed.

**Power/data when docked**: Transfers through **EPM contact pogo pins** on the docking
collar face. This is standard spacecraft practice — ISS SSRCA/PDGF connectors, Astroscale
ELSA-d probe-drogue, and every CubeSat magnetic docking port (NanoRacks, Tyvak) transfer
power + data through spring-loaded pogo pins at the docking interface. EPM engagement
preloads the pogo pins for reliable contact.

##### The Bridle Chain: Tether → Gimbal → 3 Lines → Daughter

The complete mechanical load path from mother to daughter:

```
  Reel drum (strut 85%)
       │
       ▼ tether pays out through exit guide (§13.3)
  Exit guide ring (strut tip-ward face of reel)
       │
       │  ── single Dyneema cable, 3mm ribbon ──
       │
       ▼
  Gimbal ball joint (near strut tip, §13.7)
       │  ±30° pitch/yaw, spring-return-to-center
       ├──── Bridle line A (120°)
       ├──── Bridle line B (240°)
       └──── Bridle line C (0°)
              │  │  │
              ▼  ▼  ▼
         3 hardpoints on daughter body upper perimeter (120° spacing)
```

**Why a bridle, not direct tether-to-body?** A single tether attached to one point on
the daughter creates a moment arm — any off-axis tension torques the daughter, requiring
constant FEEP correction (wastes fuel). The 3-point bridle distributes tension evenly
across the daughter body regardless of tether angle, reducing attitude disturbance to near
zero. Real fishing trawlers use bridle harnesses for the same reason — load distribution
on a towed body.

**When docked**: Bridle lines are **slack**, looped in the ~160 mm gap between the reel
cartridge (strut 85%) and the spring mount (strut 95%). The gimbal ball is parked against
the strut tip collar. Total tether + bridle slack when docked: ~0.3 m.

**On launch**: Spring pushes daughter body **directly** (aft pusher plate → daughter −Z
face). Bridle/tether are slack at the moment of fire. After the daughter travels ~0.3 m
(using up the slack), the bridle lines snap taut and the gimbal engages. From this point,
all tension loads flow through bridle → gimbal → tether → reel brake.

##### Strut-Side vs Daughter-Side Components

| Component | Location | File | Visual Function |
|-----------|----------|------|-----------------|
| **Spring housing** | Strut at 95% length | [`PlayerSatellite._buildStruts()`](js/entities/PlayerSatellite.js:868) | Upgraded `SpringMount` — visible coil spring + guide rails |
| **Guide rails** | Strut 95% → 100% | [`PlayerSatellite._buildStruts()`](js/entities/PlayerSatellite.js:868) | 2× parallel bars from spring housing to tip collar |
| **EPM docking collar** | Daughter −Y face | [`ArmUnit._createMesh()`](js/entities/ArmUnit.js:451) | Replaces flat dock plate with cylinder + coil + pole ring + pogo pins |
| **Bridle hardpoints** | Daughter +Y perimeter | [`ArmUnit._createMesh()`](js/entities/ArmUnit.js:280) | 3× small brackets at 120° for bridle lines (S3.6 forward ref) |
| **Aft pusher plate** | Daughter −Z face | [`ArmUnit._createMesh()`](js/entities/ArmUnit.js:280) | Flat plate where spring contacts during launch stroke |

---

#### 13.4.2 Material Selection Table

| Part | Material | Grade | Rationale | Color Hex | Metalness | Roughness |
|------|----------|-------|-----------|-----------|-----------|-----------|
| **Spring housing** | Hard-anodized aluminum | 6061-T6 (MIL-A-8625 Type III) | Standard mechanism enclosure. Same finish as reel housing (§13.3) — visual consistency across strut mechanisms. | `0x505868` | 0.40 | 0.50 |
| **Coil spring** | Maraging steel | C-300 vacuum-melted | High yield (2000 MPa), 1.8% elastic strain — standard for precision springs. Matches [`SPRING_TIERS[1]`](js/core/Constants.js:629) "Maraging T2" baseline. Bright steel reads as "mechanism" vs dark CFRP strut. | `0x889999` | 0.82 | 0.28 |
| **Guide rails** | Hard-anodized aluminum | 6061-T6 | Daughter slides along these during launch stroke. Same as housing for manufacturing commonality. | `0x505868` | 0.40 | 0.50 |
| **EPM housing** | Mild steel | AISI 1018 cold-drawn | Ferromagnetic (µr >> 1) — required for EPM flux circuit. Titanium/aluminum are paramagnetic and would not work. Low-carbon steel standard for EPM housings (Astroscale ELSA-d). | `0x606068` | 0.85 | 0.40 |
| **EPM coil** | Copper windings | OFHC Cu (C10100) | Switching coil, 50–100 turns 28AWG. Warm copper accent against dark steel housing. | `0xcc7744` | 0.70 | 0.35 |
| **EPM pole face ring** | AlNiCo + NdFeB | (alternating) | Permanent magnet poles — gold (AlNiCo) / dark (NdFeB) sectors. Sprint: simplified to single gold ring. | `0xbbaa55` | 0.75 | 0.25 |
| **Pogo pins** | BeCu (beryllium copper) | C17200 | Spring-loaded contacts for power + data transfer when docked. Gold-plated tip for low contact resistance. Tiny (∅1.5mm) — barely visible, reads as gold dots. | `0xddbb44` | 0.80 | 0.20 |
| **Bridle hardpoints** | Machined aluminum | 6061-T6 | Small eyelet brackets on daughter body. Same alloy as rib rings (§13.2) for visual consistency. | `0x8899aa` | 0.72 | 0.28 |
| **Aft pusher plate** | 17-4PH stainless | H900 condition | Contact surface for spring. Must withstand 4400 N peak force (17600 N/m × 0.25 m). Precipitation-hardened stainless — Rc 44 hardness prevents surface damage. | `0x777788` | 0.78 | 0.32 |

**Why maraging steel for spring, not music wire?** Maraging C-300 achieves 1.8% elastic
strain vs 0.5% for high-carbon music wire (ASTM A228). At the same stored energy (550 J),
maraging allows a shorter spring stack (more compact in the strut tube). The
[`SPRING_TIERS`](js/core/Constants.js:627) upgrade path (Steel T1 → Maraging T2 →
Composite T3 → Nanolam T4 → Metamat T5) progresses through real material science
milestones; the visual updates spring color per tier (§13.4.10).

---

#### 13.4.3 Crossbow Spring Mechanism — Strut-Side (Upgrades SpringMount)

The existing [`SpringMount_${i}`](js/entities/PlayerSatellite.js:868) is a single
`BoxGeometry(M*0.04, M*0.08, M*0.03)` placeholder at 95% strut length. S3.4 replaces
it with a 4-child group: spring housing, visible coil spring, and 2 guide rails.

**Position**: Same as current SpringMount: `Y = -strutLen * 0.95` in strut local
coordinates (1.52 m from pivot on a 1.60 m strut).

**Spring mechanism group = `THREE.Group` containing 4 children:**

| Index | Child | Purpose |
|-------|-------|---------|
| 0 | Housing | Cylindrical enclosure around spring (open-ended, reveals spring inside) |
| 1 | Spring coil | Visible compression spring (stacked torus rings) |
| 2 | Guide rail +X | Parallel bar from housing to strut tip collar |
| 3 | Guide rail −X | Mirror of rail +X |

##### Spring Housing

```javascript
// Create once before azimuths loop — shared across all 4 struts
const springHousingGeo = new THREE.CylinderGeometry(
  M * 0.030, M * 0.030, M * 0.060, 8, 1, true   // open-ended, reveals spring
);
// Reuse housingMat from §13.3 (hard-anodized 6061-T6, 0x505868)

// Inside azimuths loop:
const springHousing = new THREE.Mesh(springHousingGeo, housingMat);
springHousing.name = `SpringHousing_${i}`;
```

| Property | Value |
|----------|-------|
| Radius | 30mm (`M * 0.030`) — fits inside the 50mm strut OD clearance zone |
| Height | 60mm (`M * 0.060`) — compact mechanism housing |
| Radial segments | 8 |
| Open-ended | `true` (spring visible through open ends) |
| **Triangles** | **16** |

##### Visible Coil Spring (Torus Stack)

The spring is represented by 3 stacked `TorusGeometry` rings inside the housing,
simulating a compressed coil spring:

```javascript
// Create once — shared geometry
const springRingGeo = new THREE.TorusGeometry(M * 0.018, M * 0.003, 3, 6);
const springMat = new THREE.MeshStandardMaterial({
  color: 0x889999, metalness: 0.82, roughness: 0.28,  // maraging steel
});

// Inside azimuths loop — 3 rings at different Y offsets inside housing:
for (let r = 0; r < 3; r++) {
  const ring = new THREE.Mesh(springRingGeo, springMat);
  ring.position.y = (r - 1) * M * 0.016;   // −16mm, 0, +16mm (16mm spacing)
  ring.rotation.x = Math.PI / 2;             // torus plane ⊥ strut Y
  ring.name = `SpringCoil_${i}_${r}`;
  springGroup.add(ring);                     // Note: added to group, not pivotGroup
}
```

| Property | Value |
|----------|-------|
| Major radius | 18mm (`M * 0.018`) — nestles inside 30mm housing |
| Minor radius (wire) | 3mm (`M * 0.003`) — thick enough to read as steel wire |
| Radial segments | 3 |
| Tubular segments | 6 |
| Count | 3 rings |
| **Triangles (3 rings)** | **54** (18 per ring) |

##### Guide Rails

Two parallel bars extend from the spring housing to the strut tip collar, representing
the linear guide track the daughter slides along during launch:

```javascript
// Create once — shared geometry
const guideLen = strutLen * 0.05;  // 5% of strut = 80mm (spring mount to tip)
const guideGeo = new THREE.BoxGeometry(M * 0.005, guideLen, M * 0.005);

// Inside azimuths loop — 2 rails at ±12mm from strut center:
const railPosX = M * 0.012;
const railY = -strutLen * 0.975;  // midpoint between 95% and 100%

const railL = new THREE.Mesh(guideGeo, housingMat);
railL.position.set(-railPosX, railY, 0);
railL.name = `GuideRail_${i}_L`;
springGroup.add(railL);

const railR = new THREE.Mesh(guideGeo, housingMat);
railR.position.set(+railPosX, railY, 0);
railR.name = `GuideRail_${i}_R`;
springGroup.add(railR);
```

| Property | Value |
|----------|-------|
| Rail length | 80mm (5% of 1.60m strut) |
| Rail cross-section | 5mm × 5mm |
| Count | 2 rails |
| **Triangles (2 rails)** | **24** (12 per box) |

##### Spring Mechanism Group Assembly

```javascript
// Inside azimuths loop — assemble spring mechanism group
const springGroup = new THREE.Group();
springGroup.add(springHousing);   // children[0]
// 3 spring coil rings added to group above   children[1..3]
springGroup.add(railL);           // children[4]
springGroup.add(railR);           // children[5]

springGroup.position.y = -strutLen * 0.95;  // same as current SpringMount
springGroup.name = `CrossbowSpring_${i}`;
pivotGroup.add(springGroup);
```

**This replaces** the current [`SpringMount` block](js/entities/PlayerSatellite.js:868)
(lines 868–873). The Y position is identical. The old `BoxGeometry` is removed entirely.

##### Spring Mechanism Sub-Total (per strut)

| Part | Count | Tris Each | Total |
|------|-------|-----------|-------|
| Housing (CylinderGeo) | 1 | 16 | 16 |
| Spring coil rings (TorusGeo) | 3 | 18 | 54 |
| Guide rails (BoxGeo) | 2 | 12 | 24 |
| **Spring sub-total** | **6 meshes** | — | **94** |
| **×4 struts** | — | — | **376** |

---

#### 13.4.4 EPM Docking Collar — Daughter-Side (Replaces Dock Plate)

The EPM replaces the current flat `BoxGeometry` dock plate
([`ArmUnit._createMesh():451-459`](js/entities/ArmUnit.js:451)) with a detailed
electromagnetic docking collar. The EPM sits on the **−Y (bottom) face** of the arm
body — this is the face that mates with the strut tip collar when docked AND the face
that grapples metallic debris.

**Dual role (critical design constraint):**
1. **Strut docking**: EPM holds daughter to strut tip at 50 N
   ([`DOCK_EPM_HOLD_FORCE`](js/core/Constants.js:177)) with zero continuous power.
   Pogo pins transfer power (battery charging) + data (sensor dump, firmware) when mated.
2. **Debris grapple**: Same EPM face orients toward metallic debris for magnetic capture.
   50 N hold is sufficient for debris up to ~500 kg in microgravity (limited by daughter
   FEEP thrust, not magnet force).

**EPM dimensions:**

| Dimension | Weaver | Spinner | Description |
|-----------|--------|---------|-------------|
| Housing diameter | 50mm | 40mm | Cylindrical core housing OD |
| Housing height | 15mm | 12mm | Shallow cylinder (flush with body bottom face) |
| Coil ring major R | 30mm | 24mm | Copper coil torus center radius |
| Coil ring minor R | 4mm | 3mm | Coil cross-section radius |
| Pole face ring OD | 50mm | 40mm | Matches housing OD |
| Pole face ring ID | 25mm | 20mm | Inner hole for central alignment pin |
| Pogo pin count | 4 | 4 | 2× power (28V, 2A) + 2× data (RS-485 differential pair) |
| Pogo pin diameter | 1.5mm | 1.5mm | Standard spring-loaded BeCu contact |

##### EPM Housing (Core Cylinder)

```javascript
const epmR  = (isWeaver ? 0.025 : 0.020) * M;
const epmH  = (isWeaver ? 0.015 : 0.012) * M;
const epmGeo = new THREE.CylinderGeometry(epmR, epmR, epmH, 8);
const epmMat = new THREE.MeshStandardMaterial({
  color: 0x606068, metalness: 0.85, roughness: 0.40,  // mild steel (ferromagnetic)
});

const epmHousing = new THREE.Mesh(epmGeo, epmMat);
epmHousing.position.y = -by * 0.52 * M;  // same Y as current dock plate
epmHousing.name = `${this.id}-epm-housing`;
this.mesh.add(epmHousing);
```

| **Triangles** | **32** |
|----------|-------|

##### EPM Copper Coil

```javascript
const coilMajR = (isWeaver ? 0.030 : 0.024) * M;
const coilMinR = (isWeaver ? 0.004 : 0.003) * M;
const coilGeo  = new THREE.TorusGeometry(coilMajR, coilMinR, 4, 8);
const coilMat  = new THREE.MeshStandardMaterial({
  color: 0xcc7744, metalness: 0.70, roughness: 0.35,  // OFHC copper
});

const coil = new THREE.Mesh(coilGeo, coilMat);
coil.position.y = -by * 0.52 * M;
coil.rotation.x = Math.PI / 2;
coil.name = `${this.id}-epm-coil`;
this.mesh.add(coil);
```

| **Triangles** | **64** |
|----------|-------|

##### EPM Pole Face Ring (Status Indicator)

```javascript
const poleOR = (isWeaver ? 0.025 : 0.020) * M;
const poleIR = (isWeaver ? 0.0125 : 0.010) * M;
const poleGeo = new THREE.RingGeometry(poleIR, poleOR, 8, 1);
const poleMat = new THREE.MeshStandardMaterial({
  color: 0xbbaa55, metalness: 0.75, roughness: 0.25,  // AlNiCo gold
  emissive: 0x000000, emissiveIntensity: 0.0,
});

const poleFace = new THREE.Mesh(poleGeo, poleMat);
poleFace.position.y = -by * 0.52 * M - epmH * 0.51;
poleFace.rotation.x = Math.PI / 2;
poleFace.name = `${this.id}-epm-pole`;
this.mesh.add(poleFace);
this._epmPoleMat = poleMat;  // store for state-driven animation
```

| **Triangles** | **16** |
|----------|-------|

##### Pogo Pins (4× Power + Data Contacts)

```javascript
const pogoGeo = new THREE.CylinderGeometry(M * 0.00075, M * 0.00075, M * 0.004, 4);
const pogoMat = new THREE.MeshStandardMaterial({
  color: 0xddbb44, metalness: 0.80, roughness: 0.20,  // gold-plated BeCu
});

// 4 pins at 90° intervals on a 20mm radius (Weaver) / 16mm (Spinner)
const pogoR = (isWeaver ? 0.020 : 0.016) * M;
for (let p = 0; p < 4; p++) {
  const angle = p * Math.PI / 2;
  const pin = new THREE.Mesh(pogoGeo, pogoMat);
  pin.position.set(
    Math.cos(angle) * pogoR,
    -by * 0.52 * M - epmH * 0.3,   // below housing, protruding toward mating surface
    Math.sin(angle) * pogoR
  );
  pin.name = `${this.id}-pogo-${p}`;
  this.mesh.add(pin);
}
```

| **Triangles (4 pins)** | **32** (8 per pin) |
|----------|-------|

**Why 4 pins, 90° spacing?** Rotational symmetry means any 90° alignment docks
correctly — no rotational alignment constraint (same principle as USB-C orientation
independence). This is critical because the daughter floats back to the strut tip on FEEP
thrust without precise rotational control.

##### EPM State Visualization

| EPM State | Pole Face Emissive | Intensity | Trigger |
|-----------|--------------------|-----------|---------|
| **De-energized** | `0x000000` (off) | 0.0 | DOCKED, spring charged, ready |
| **Energizing** (pulse) | `0x2244ff` (blue flash) | 1.0 → 0.0 (0.3s) | LAUNCHING Phase 1 |
| **Holding** (zero-power) | `0x113355` (cool blue) | 0.4 | GRAPPLED / REELING |
| **Releasing** (pulse) | `0xff2200` (red flash) | 1.0 → 0.0 (0.2s) | Debris release |
| **Standby** | `0x111122` (faint) | 0.15 | TRANSIT / APPROACH |

##### EPM Assembly Sub-Total (per arm)

| Part | Count | Tris Each | Total |
|------|-------|-----------|-------|
| Housing cylinder | 1 | 32 | 32 |
| Copper coil torus | 1 | 64 | 64 |
| Pole face ring | 1 | 16 | 16 |
| Pogo pins | 4 | 8 | 32 |
| **EPM sub-total** | **7 meshes** | — | **144** |

---

#### 13.4.5 Bridle Hardpoints + Aft Pusher Plate — Daughter-Side

##### Bridle Hardpoints (3× at 120° on upper body perimeter)

Three small eyelet brackets on the daughter body's upper perimeter (+Y face edge)
provide the attachment points for the future bridle lines (S3.6). For S3.4, they are
visual-only — no bridle lines connect yet. When S3.6 adds the bridle ring and gimbal,
`Line2` bridle lines will terminate at these hardpoint world positions.

**Position**: At `Y = +by * 0.48` (just below top face), at 120° spacing around the
body perimeter. Radius from body center: `bx * 0.45` (near body edge).

```javascript
const hpGeo = new THREE.SphereGeometry(M * 0.004, 4, 4);  // tiny sphere
const hpMat = ribMat || new THREE.MeshStandardMaterial({
  color: 0x8899aa, metalness: 0.72, roughness: 0.28,
});

const hpR = bx * 0.45 * M;  // near body edge
for (let h = 0; h < 3; h++) {
  const angle = h * (2 * Math.PI / 3);  // 0°, 120°, 240°
  const hp = new THREE.Mesh(hpGeo, hpMat);
  hp.position.set(
    Math.cos(angle) * hpR,
    by * 0.48 * M,
    Math.sin(angle) * hpR
  );
  hp.name = `${this.id}-bridle-hp-${h}`;
  this.mesh.add(hp);
}
```

| **Triangles (3 hardpoints)** | **48** (16 per sphere) |
|----------|-------|

##### Aft Pusher Plate (Spring Contact Surface)

A flat plate on the daughter's −Z (aft) face where the crossbow spring makes contact
during the launch stroke. When docked, the spring's pusher face presses against this
plate; on fire, the spring extends and pushes the daughter outward along the strut axis.

**Why push on −Z, not on −Y?** The daughter docks at the strut TIP with its −Y face
against the tip collar (EPM mating surface). The strut's local Y axis (pivot→tip) maps
to the daughter's body axis during docked orientation. The spring at 95% pushes along
the strut's local Y axis, which projects onto the daughter's aft face. The exact push
axis depends on the strut sweep angle, but since the daughter body is small relative to
the strut, the spring contact can be modeled as a centered disc on the body aft face.

```javascript
const pushR = (isWeaver ? 0.025 : 0.018) * M;
const pushH = M * 0.003;
const pushGeo = new THREE.CylinderGeometry(pushR, pushR, pushH, 6);
const pushMat = new THREE.MeshStandardMaterial({
  color: 0x777788, metalness: 0.78, roughness: 0.32,  // 17-4PH stainless
});

const pusher = new THREE.Mesh(pushGeo, pushMat);
pusher.position.set(0, 0, -bz * 0.52 * M);  // aft face, centered
pusher.rotation.x = Math.PI / 2;              // disc face toward −Z
pusher.name = `${this.id}-pusher-plate`;
this.mesh.add(pusher);
```

| **Triangles** | **24** |
|----------|-------|

##### Bridle + Pusher Sub-Total (per arm)

| Part | Count | Tris Each | Total |
|------|-------|-----------|-------|
| Bridle hardpoint spheres | 3 | 16 | 48 |
| Aft pusher plate | 1 | 24 | 24 |
| **Sub-total** | **4 meshes** | — | **72** |

---

#### 13.4.6 Assembly Diagrams

```
  STRUT TIP — CROSSBOW LAUNCHER MECHANISM (strut local frame)
  Looking from side (+X direction)

  Strut Y-axis: ↑ toward pivot (root),  ↓ toward tip
  
       ── Reel cartridge (85% strut) ──
           ╔═══════════╗
           ║  Spool ▓▓ ║
           ╚═════╤═════╝
                 │
      Cable harness  │  P-clips at 25/50/75%
                 │
                 ▼
       ── Spring housing (95% strut) ──
           ╔═══════════╗
           ║ ◎ coil  ◎ ║  ← 3× torus spring rings
           ║ ◎ spring◎ ║    inside open cylinder
           ╚═════╤═════╝
            ┃    │    ┃    ← 2× guide rails (±X, 12mm offset)
            ┃    │    ┃      rails span 80mm from housing to tip
            ┃    │    ┃
       ── Tip collar (100% strut) ──
           ╔═════╧═════╗
           ║  TipCollar ║  ← existing from §13.2
           ╚═══════════╝
                 │
           ═══ EPM ═══    ← daughter's EPM face docks here
           │ Daughter  │
           │   body    │
           └───────────┘

  DAUGHTER ARM — DOCKED CONFIGURATION (side view)
  
    Strut extends toward pivot (local +Y ↑)
    
       Guide rail ┃          ┃ Guide rail
                  ┃  Spring  ┃
                  ┃ coils ◎◎ ┃
                  ┃──────────┃ ← Spring housing (95%)
                  ┃          ┃
                  ┃==========┃ ← Tip collar (100%)
    ──────────────┃══════════┃──────────────
    Bridle hp ○   ┃EPM══════ ┃   ○ Bridle hp
              │   ┃ coil pogo┃   │
              │   ┃ pole pins┃   │
    ┌─────────┼───╨══════════╨───┼─────────┐
    │  ROSA   │      Body        │  ROSA   │
    │  wing   │    [pusher plt]  │  wing   │
    │         │  ← aft (−Z)      │         │
    │         │    Net canister → │         │
    └─────────┼──────────────────┼─────────┘
              │         │        │
              ○ Bridle  │ FEEP   ○ Bridle hp
                hp      nozzle (aft)

  DAUGHTER ARM — DEPLOYED (side view, looking from +X)
  
    Bridle hp ○──────── bridle line to gimbal ──────── to tether/reel
              │
    ┌─────────┤────────────────────────────────┐
    │ ROSA    │         ╔═Body═╗               │  ← top (+Y)
    │ pivot   │         ║      ║               │
    │         │         ║ MLI  ║               │
    │         │         ╚══╤═══╝               │
    │         │            │                   │
    │ FEEP ◄──┤ nozzle     │  canister ────────├──► +Z (forward)
    │         │            │    NET            │
    │  [pusher plt]        │                   │
    └─────────┤────────────┤───────────────────┘
              │            │
        ╔═════╧═════╗     │
        ║ EPM coil  ║     │  ← bottom (−Y) — docks to strut OR grapples debris
        ╚═════╤═════╝     │
        │pogo │pole │     │
        └─────┴─────┘     │

  ASSEMBLY HIERARCHY — STRUT-SIDE (per strut, in PlayerSatellite):
  
    pivotGroup (existing)
      ├─ strut, tipNode, rootCollar, tipCollar, ribRings×3     (existing/§13.2)
      ├─ reelCartridge (§13.3)
      ├─ cableHarness + pClips (§13.3)
      ├─ ██ springMount (old BoxGeo) ██                        ← REMOVED
      └─ crossbowSpring (THREE.Group)                         ← S3.4 NEW
           ├─ [0] springHousing (CylinderGeo, open)               16 tris
           ├─ [1] springCoil_0 (TorusGeo)                         18 tris
           ├─ [2] springCoil_1 (TorusGeo)                         18 tris
           ├─ [3] springCoil_2 (TorusGeo)                         18 tris
           ├─ [4] guideRail_L (BoxGeo)                            12 tris
           └─ [5] guideRail_R (BoxGeo)                            12 tris

  ASSEMBLY HIERARCHY — DAUGHTER-SIDE (per arm, in ArmUnit):
  
    this.group
      └─ this.mesh (arm body — UNCHANGED except dock plate removed)
           ├─ mli (gold band)
           ├─ topPivot → ROSA wing
           ├─ botPivot → ROSA wing
           ├─ nozzle (FEEP)
           ├─ plume (thruster glow)
           ├─ canister (net)
           ├─ pvPanel (laser PV)
           ├─ mrr (retroreflector)
           ├─ statusLight (state LED)
           ├─ ██ dockPlate ██                           ← REMOVED (12 tris)
           ├─ epmHousing (CylinderGeo, −Y)             ← S3.4 NEW, 32 tris
           ├─ epmCoil (TorusGeo)                        ← S3.4 NEW, 64 tris
           ├─ epmPole (RingGeo, cloned mat)             ← S3.4 NEW, 16 tris
           ├─ pogo_0..3 (CylinderGeo × 4)              ← S3.4 NEW, 32 tris
           ├─ bridleHp_0..2 (SphereGeo × 3)            ← S3.4 NEW, 48 tris
           └─ pusherPlate (CylinderGeo, −Z)             ← S3.4 NEW, 24 tris
```

---

#### 13.4.7 Polygon Budget (Full Spec)

**Strut-side (per strut):**

| Component | Count | Tris Each | Total |
|-----------|-------|-----------|-------|
| Spring housing (CylinderGeo, open) | 1 | 16 | 16 |
| Spring coil rings (TorusGeo) | 3 | 18 | 54 |
| Guide rails (BoxGeo) | 2 | 12 | 24 |
| **Strut sub-total** | **6 meshes** | — | **94** |
| **×4 struts** | — | — | **376** |

**Daughter-side (per arm):**

| Component | Count | Tris Each | Total |
|-----------|-------|-----------|-------|
| EPM housing (CylinderGeo) | 1 | 32 | 32 |
| EPM coil (TorusGeo) | 1 | 64 | 64 |
| EPM pole face (RingGeo) | 1 | 16 | 16 |
| Pogo pins (CylinderGeo) | 4 | 8 | 32 |
| Bridle hardpoints (SphereGeo) | 3 | 16 | 48 |
| Aft pusher plate (CylinderGeo) | 1 | 24 | 24 |
| **Daughter sub-total** | **11 meshes** | — | **216** |
| **×4 arms** | — | — | **864** |

**Combined total: 376 (strut) + 864 (daughter) = 1,240 tris.**

**Budget check: ≤600 per arm.** Daughter-side is 216 tris/arm — well within budget.
Strut-side is 94 tris/strut — replaces the old 12-tri SpringMount box, net add +82.

**Existing meshes removed:** SpringMount box (12 tris × 4 struts = 48) + dock plate
box (12 tris × 4 arms = 48) = **−96 tris**. Net system increase: **+1,144 tris**.

---

#### 13.4.8 Integration Points

**Strut-side — [`PlayerSatellite._buildStruts()`](js/entities/PlayerSatellite.js:733):**

| Line Range | Current Code | S3.4 Change |
|------------|-------------|-------------|
| [`868-873`](js/entities/PlayerSatellite.js:868) | SpringMount `BoxGeometry` | **REPLACE** with crossbow spring group (housing + 3 coils + 2 rails) |

**Daughter-side — [`ArmUnit._createMesh()`](js/entities/ArmUnit.js:280):**

| Line Range | Current Code | S3.4 Change |
|------------|-------------|-------------|
| [`451-459`](js/entities/ArmUnit.js:451) | EPM dock plate `BoxGeometry` | **REPLACE** with EPM collar (housing + coil + pole + 4 pogo pins) |
| After 459 | (nothing) | **ADD** 3 bridle hardpoints + aft pusher plate |

**What is preserved (no changes):**

| Line Range | Component | Why Untouched |
|------------|-----------|---------------|
| [`284-293`](js/entities/ArmUnit.js:284) | Main body box | S3.5 scope (body redesign) |
| [`295-384`](js/entities/ArmUnit.js:295) | MLI + ROSA wings | S3.2/S3.5 scope |
| [`386-449`](js/entities/ArmUnit.js:386) | FEEP + net canister + PV + MRR + LED | S3.5 scope |

**Applicability**: ALL arm types (Weaver + Spinner). The crossbow spring mechanism
is universal — all daughters are launched by spring. All daughters dock via EPM. All
daughters have bridle connections. Dimensions scale via existing `isWeaver` branch.

---

#### 13.4.9 Spring Tier Visual (Color by Upgrade)

When the player upgrades [`SPRING_TIERS`](js/core/Constants.js:627), the spring coil
ring material color updates (same pattern as §13.3 drum tier color):

| Tier | Material | Spring Coil Color | Hex | Metalness | Roughness |
|------|----------|-------------------|-----|-----------|-----------|
| T1 | Steel | Medium gray | `0x778888` | 0.78 | 0.32 |
| T2 | Maraging | Bright steel | `0x889999` | 0.82 | 0.28 |
| T3 | Composite | Dark olive | `0x556644` | 0.60 | 0.45 |
| T4 | Nanolam | Gunmetal blue | `0x555566` | 0.88 | 0.20 |
| T5 | Metamat | Iridescent dark | `0x445577` | 0.92 | 0.15 |

```javascript
springMat.color.setHex(tierColor);
springMat.metalness = tierMetalness;
springMat.roughness = tierRoughness;
```

---

#### 13.4.10 Color Palette Reference

```
  MATERIAL SWATCHES (approximate monitor appearance)

  NEW in S3.4 — STRUT-SIDE:
  Spring housing  ▓▓▓▓▓  #505868  Hard-anodized 6061-T6 (shared §13.3 housingMat)
  Spring coil T1  ░▒░▒░  #778888  Medium gray steel (met=0.78)
  Spring coil T2  ░▒░▒░  #889999  Bright maraging steel (met=0.82)
  Guide rails     ▓▓▓▓▓  #505868  Hard-anodized (shared housingMat)

  NEW in S3.4 — DAUGHTER-SIDE:
  EPM housing     █▓█▓█  #606068  Mild steel ferromagnetic (met=0.85)
  EPM coil        ▒░▒░▒  #cc7744  Copper OFHC (met=0.70)
  EPM pole (off)  ░▒░▒░  #bbaa55  AlNiCo gold (met=0.75, no emissive)
  EPM pole (hold) ░▒░▒░  #bbaa55  + emissive #113355 @ 0.4 (cool blue glow)
  EPM pole (fire) ░▒░▒░  #bbaa55  + emissive #2244ff @ 1.0 (blue flash)
  EPM pole (rel)  ░▒░▒░  #bbaa55  + emissive #ff2200 @ 1.0 (red flash)
  Pogo pins       ░░░░░  #ddbb44  Gold-plated BeCu (met=0.80)
  Bridle hps      ░▒░▒░  #8899aa  Polished 6061-T6 (shared ribMat §13.2)
  Pusher plate    ▓▒▓▒▓  #777788  17-4PH stainless (met=0.78)

  EXISTING (unchanged):
  Old SpringMount ▓▓▓▓▓  #2a2a30  REMOVED — replaced by S3.4 crossbow spring
  Old dock plate  ▓▓▓▓▓  #888888  REMOVED — replaced by S3.4 EPM collar
```

---

#### 13.4.11 Implementation Notes

1. **Strut-side: Replaces SpringMount.** Remove the current
   [`springGeo/spring` block](js/entities/PlayerSatellite.js:868) (lines 868–873)
   and replace with the crossbow spring group. Same Y position (`-strutLen * 0.95`).
   Shared geometries (`springHousingGeo`, `springRingGeo`, `guideGeo`) created once
   before the `azimuths.forEach` loop, same pattern as §13.3 reel cartridge.

2. **Daughter-side: Replaces dock plate.** Remove
   [`plateGeo/plateMat/dockPlate` block](js/entities/ArmUnit.js:451) (lines 451–459).
   Replace with EPM housing + coil + pole + pogo pins. Same Y position
   (`-by * 0.52 * M`). Materials shared as module-level constants.

3. **Daughter-side: Add bridle hardpoints + pusher.** After the EPM block. Purely
   additive — no existing geometry modified. Uses lazy-init shared geometries.

4. **EPM pole material cloning.** Clone `poleMat` per arm instance for independent
   emissive animation. Store as `this._epmPoleMat`. Same pattern as §13.3 LED.

5. **Spring coil material shared.** All 4 struts share one `springMat`. Updated on
   tier change via `springMat.color.setHex(tierColor)`.

6. **No changes outside `_buildStruts()` and `_createMesh()`.** EPM state animation
   added to `_updateVisuals()` or state-transition handler inside `ArmUnit` — no
   external API changes. Spring mechanism is visual-only — no physics interaction
   (launch physics handled by [`_applyLaunchImpulse()`](js/entities/ArmUnit.js:1936)).

7. **Tether path unchanged.** [`ArmUnit._createTether()`](js/entities/ArmUnit.js:466)
   still draws a `LineDashedMaterial` line from mother position to arm position.
   Future S3.6 (bridle) will split this into tether + gimbal + 3 bridle lines
   terminating at the hardpoint world positions.

---

#### 13.4.12 Sprint Build Simplifications — What to Actually Implement

The full spec (§13.4.1–§13.4.11) documents complete engineering design. Sprint
simplifications reduce code complexity with negligible visual impact:

##### Simplification Analysis

| Component | Full Spec | Simplified | Why | Impact |
|-----------|-----------|------------|-----|--------|
| **Spring coil (3 tori)** | 3 × `TorusGeometry(3, 6)` = 54 tris | **1 × `TorusGeometry(3, 6)`** = 18 tris | Single coil ring inside housing reads identically to 3 at game distances. Spring visual is "something metallic inside the housing." | −36 tris, −2 meshes |
| **Guide rails** | 2 × `BoxGeometry` = 24 tris | **KEEP** | Rails are the primary visual cue that "this bracket launches something." Dropping them makes it look like another reel cartridge. | 0 |
| **Pogo pins (4×)** | 4 × `CylinderGeometry(4)` = 32 tris | **DROP** | ∅1.5mm pins are invisible at all game distances. The EPM housing + coil copper accent communicates "docking mechanism" adequately. | −32 tris, −4 meshes |
| **Bridle hardpoints** | 3 × `SphereGeometry(4, 4)` = 48 tris | **DROP** for sprint | No bridle lines connect to them yet (S3.6 scope). Without visual lines, floating spheres look like rendering artifacts. Add with bridle. | −48 tris, −3 meshes |
| **Aft pusher plate** | `CylinderGeometry(6)` = 24 tris | **DROP** for sprint | On the aft face (−Z), only visible from behind the arm — rare camera angle. Spring contact is a physics concept, not a visual necessity. | −24 tris, −1 mesh |
| **EPM coil** | `TorusGeometry(4, 8)` = 64 tris | **`TorusGeometry(3, 6)`** = 36 tris | Lower segment count. Copper ring still clearly visible at 60mm diameter. | −28 tris |
| **EPM state animation** | 5-state emissive | **2 states only** | HOLDING (blue) vs OFF. Skip flash transitions until EPM toggle command exists. | −8 LOC |

##### What Gets Built (Final Sprint Spec)

**Strut-side: Crossbow Spring = `THREE.Group` with 4 children:**

| Index | Child | Geometry | Tris |
|-------|-------|----------|------|
| 0 | Spring housing | `CylinderGeometry(M*0.030, M*0.030, M*0.060, 8, 1, true)` | 16 |
| 1 | Spring coil | `TorusGeometry(M*0.018, M*0.003, 3, 6)` | 18 |
| 2 | Guide rail L | `BoxGeometry(M*0.005, guideLen, M*0.005)` | 12 |
| 3 | Guide rail R | (same geo) | 12 |

**Daughter-side: EPM Collar = 3 meshes (replaces dock plate):**

| — | Child | Geometry | Tris |
|---|-------|----------|------|
| — | EPM housing | `CylinderGeometry(epmR, epmR, epmH, 8)` | 32 |
| — | EPM coil | `TorusGeometry(coilMajR, coilMinR, 3, 6)` | 36 |
| — | EPM pole face | `RingGeometry(poleIR, poleOR, 8, 1)` | 16 |

##### Simplified Polygon Budget

| Location | Component | Count | Tris Each | Total |
|----------|-----------|-------|-----------|-------|
| **Strut** | Spring housing | 1 | 16 | 16 |
| | Spring coil | 1 | 18 | 18 |
| | Guide rails | 2 | 12 | 24 |
| | **Per strut** | **4** | — | **58** |
| | **×4 struts** | — | — | **232** |
| **Daughter** | EPM housing | 1 | 32 | 32 |
| | EPM coil (3×6) | 1 | 36 | 36 |
| | EPM pole face | 1 | 16 | 16 |
| | **Per arm** | **3** | — | **84** |
| | **×4 arms** | — | — | **336** |
| **TOTAL** | | | | **568** |

**Budget: ≤600 per arm. Actual daughter: 84. Headroom: 516 tris (86%).**

Replaces old SpringMount (12 × 4 = 48 tris) + dock plate (12 × 4 = 48 tris) = 96 tris.
Net system add: **+472 tris**.

##### Implementation Task Breakdown (for Orchestrator)

**Task 1: Crossbow spring mechanism** (~25 LOC in [`_buildStruts()`](js/entities/PlayerSatellite.js:733))
- Create shared `springHousingGeo`, `springRingGeo`, `guideGeo`, `springMat` before loop
- Replace SpringMount block (lines 868–873) with 4-child group
- Position at `Y = -strutLen * 0.95`

**Task 2: EPM collar** (~25 LOC in [`_createMesh()`](js/entities/ArmUnit.js:280))
- Create module-level `epmGeo`, `coilGeo`, `poleGeo`, `epmMat`, `coilMat`, `poleMat`
- Replace dock plate block (lines 451–459) with housing + coil + pole
- Clone `poleMat`, store as `this._epmPoleMat`

**Task 3: EPM state animation** (~8 LOC in [`ArmUnit`](js/entities/ArmUnit.js) state handler)
- GRAPPLED/REELING → emissive `0x113355` @ 0.4 (blue glow)
- All other states → emissive `0x000000` @ 0.0 (off)

**Total: ~58 LOC.** Touches 2 files: [`PlayerSatellite.js`](js/entities/PlayerSatellite.js)
and [`ArmUnit.js`](js/entities/ArmUnit.js). No new files. No Constants changes.

##### Deferred to Future Sprints

| Feature | Spec Section | Why Defer |
|---------|-------------|-----------|
| 3-ring spring coil stack | §13.4.3 | Upgrade from 1 ring if inspection camera reveals hollow housing |
| Pogo pins (4×) | §13.4.4 | Add when EPM charge animation shows power transfer |
| Bridle hardpoints (3×) | §13.4.5 | Add when bridle ring (S3.6) connects lines to them |
| Aft pusher plate | §13.4.5 | Add when spring compression animation shows contact |
| High-segment EPM coil (4×8) | §13.4.4 | Upgrade from 3×6 if copper detail matters at game distance |
| EPM flash transitions | §13.4.4 | Add when EPM toggle command exists in gameplay |
| Per-strut spring tier color | §13.4.9 | Add when mixed-tier arms are possible (Y1/Y3) |

---

### 13.5 S3.5 Daughter Body Enhancements — Shape, Equipment, and Visual Identity

**Sprint**: S3.5 — Mechanical Visual Upgrades (Epic 10 Visualization)
**Scope**: Replace daughter body primitives + add external spacecraft equipment
**Files touched**: [`ArmUnit.js`](js/entities/ArmUnit.js) — [`_createMesh()`](js/entities/ArmUnit.js:280)
**Replaces**: Previous §13.5 Daughter Weaver brief + §13.6 Daughter Spinner brief
**Prerequisite**: S3.4 (EPM docking collar + pusher plate) — complete

---

#### 13.5.1 Engineering Analysis — What Makes a Daughter Look Like a Spacecraft

The daughters currently read as **"textureless game tokens"** — a blue or green box with
appendages. Real small spacecraft (~0.3m class) share these visual hallmarks that
distinguish "manufactured spacecraft" from "geometric primitive":

1. **Faceted body** — not a smooth cylinder, not a box. Hexagonal or octagonal prisms are
   standard for small satellite bus structures.

2. **MLI thermal blanket zones** — gold/silver Kapton creating visible panel boundaries.
   The existing gold accent band is correct in concept but wrong shape (box on box).

3. **Matched thruster pair** — real FEEP-propelled small sats have fore + aft nozzles on
   vectorable mounts (e.g., Enpulsion IFM Nano SE, ±15° gimbal). Not a single central
   bell, not a ring of RCS stubs.

4. **Body-mounted equipment** — solar cells on bus faces, antenna/reflector patches,
   sensor windows. These break up the body silhouette and communicate function.

5. **Panel lines** — edges between thermal blanket zones, structural panels, equipment
   bays. In Three.js, `EdgesGeometry` on a low-poly hex body produces these for zero
   triangle cost.

##### Body Shape Comparison — Why Hexagonal Prism?

| Shape | Three.js Geometry | Tris | Pros | Cons |
|-------|-------------------|------|------|------|
| **Box** (current) | `BoxGeometry` | 12 | Simplest; CubeSat-standard form factor | Reads as placeholder; no visual interest; all faces identical |
| **Hex prism** ★ | `CylinderGeometry(R,R,H,6)` | 24 | 6 distinct panels for equipment zones; strong edge definition in `EdgesGeometry` (60° dihedral); structurally efficient (hex tubes resist bending); differentiated from mother's **octagonal** barrel; common in real microsats (Astro Digital Corvus, SSTL platforms) | +12 tris vs box; hex-to-EPM collar junction slightly larger circumradius |
| **Oct prism** | `CylinderGeometry(R,R,H,8)` | 32 | Smoother silhouette; 8 equipment faces; also common IRL | **Same shape as the mother ship's barrel** — daughters look like tiny mothers, losing visual identity; edges less prominent (22.5° vs hex's 30° between faces); +20 tris vs box |
| **Chamfered box** | `ExtrudeGeometry(shape)` | 40–80 | Most industrial-looking; preserves flat major faces | Complex code (`Shape` + `ExtrudeGeometry` path); variable tri count; harder to maintain; `EdgesGeometry` less clean |
| **Cylinder** (12+ seg) | `CylinderGeometry(R,R,H,12)` | 48+ | Smooth — reads as pressure vessel / fuel tank | **Too smooth** — no panel lines; `EdgesGeometry` yields nothing visible; reads as "tank" not "spacecraft bus" |
| **Tapered hex** | `CylinderGeometry(R1,R2,H,6)` | 24 | Suggests directionality (wider aft = thrust end) | More complex child positioning; less standard; fore/aft dimension ambiguity |

**Decision: Hexagonal prism.** The key argument is **visual differentiation**: the mother
ship barrel is octagonal ([`BIG_PICTURE.md:1333`](BIG_PICTURE.md:1333) — "Al-7075
octagonal bus 2.0×0.8m"). Making daughters hexagonal creates an instant silhouette
distinction at any distance. The 6-face layout also maps cleanly to equipment zones:
+Y top (PV/MRR), −Y bottom (EPM dock), ±X sides (solar cells), +Z fore (end-effector),
−Z aft (thrusters).

**Design philosophy**: Hex body shape + edge lines + fore/aft FEEP nozzle pair achieves
80% of the visual improvement for near-zero polygon cost. The MRR sphere-to-patch
replacement actually *saves* triangles. Net result: the body upgrade is polygon-neutral
or negative.

**Both arm types** (weaver and spinner) receive the same topological upgrade. They differ
only in scale and color — identical to the current differentiation strategy. This keeps
the implementation as a single code path with `isWeaver` conditionals for dimensions.

---

#### 13.5.2 Material Selection Table

| Material | Purpose | Color | Metal | Rough | Hex Code | Notes |
|----------|---------|-------|-------|-------|----------|-------|
| **Body shell (W)** | Hex hull | Blue-grey metallic | 0.80 | 0.30 | `0x4488aa` | Weaver identity color |
| **Body shell (S)** | Hex hull | Green-grey metallic | 0.80 | 0.30 | `0x88aa44` | Spinner identity color |
| **MLI band** | Gold kapton stripe | Warm gold | 0.90 | 0.20 | `0xccaa44` | Unchanged from current |
| **FEEP nozzle** | Emitter tips (fore+aft) | Dark tungsten | 0.85 | 0.25 | `0x444455` | W-Mo alloy appearance |
| **Solar cell** | Body-mount GaAs | Near-black blue | 0.40 | 0.50 | `0x0a1133` | Reuse ROSA `panelMat` |
| **MRR patch** | Laser comm Rx | Bright aluminum | 0.95 | 0.15 | `0xccccdd` | Flat reflective disc |
| **Panel lines** | Hull edge wireframe | Cool blue-grey | — | — | `0x667788` | `LineBasicMaterial`, α=0.5 |

---

#### 13.5.3 Body Shape — Hexagonal Prism (Replaces BoxGeometry)

The box body at [`ArmUnit.js:285`](js/entities/ArmUnit.js:285) (`BoxGeometry(bx*M, by*M,
bz*M)`) is replaced with a hexagonal prism. The hex cross-section sits in the XY plane,
with the prism long axis along Z (forward/aft).

##### Body Coordinate System (unchanged)

```
     +Y (top — PV panel, ROSA wings)
      │
      │    +Z (forward — net canister, nose)
      │   ╱
      │  ╱
      │ ╱
      └──────── +X (starboard)
     
     −Y = dock face (EPM collar, S3.4)
     −Z = aft face (thrusters, pusher plate)
```

##### Hex Prism Dimensions

| Parameter | Weaver | Spinner | Derivation |
|-----------|--------|---------|------------|
| `bx, by, bz` (from Constants) | 0.2, 0.2, 0.3 | 0.1, 0.1, 0.15 | [`WEAVER_BODY`](js/core/Constants.js:138), [`SPINNER_BODY`](js/core/Constants.js:156) |
| Flat-to-flat distance (XY) | 200mm | 100mm | = `bx` (matches original box width) |
| Apothem (center→flat) | 100mm | 50mm | = `bx / 2` |
| Circumradius R (center→vertex) | 115.5mm | 57.7mm | = `apothem / cos(π/6)` |
| Prism height along Z | 300mm | 150mm | = `bz` |

##### `this.mesh` Type Change (Critical)

[`this.mesh`](js/entities/ArmUnit.js:291) changes from a `THREE.Mesh` to a `THREE.Group`.
The hex body shell becomes a child mesh. All other children (ROSA pivots, nozzle,
canister, EPM collar, etc.) continue to be added via `this.mesh.add()` with **unchanged
position offsets**. This is safe because:

- [`this.mesh.visible`](js/entities/ArmUnit.js:491): ✅ Works on Group
- [`this.mesh.add()`](js/entities/ArmUnit.js:302): ✅ Works on Group
- [`this.mesh.name`](js/entities/ArmUnit.js:292): ✅ Works on Group
- `this.mesh.geometry`: ❌ Not accessed externally — verified safe
- `this.mesh.material`: ❌ Not accessed externally — verified safe

##### Code

```javascript
// --- Body container (Group replaces Mesh) ---
this.mesh = new THREE.Group();
this.mesh.name = `${this.id}-body`;
this.group.add(this.mesh);

// --- Hex prism body shell ---
const apothem = (bx / 2) * M;
const hexR = apothem / Math.cos(Math.PI / 6);  // circumradius
const hexGeo = new THREE.CylinderGeometry(hexR, hexR, bz * M, 6);
const bodyMat = new THREE.MeshStandardMaterial({
  color: isWeaver ? 0x4488aa : 0x88aa44,
  metalness: 0.80,
  roughness: 0.30,
});
const bodyShell = new THREE.Mesh(hexGeo, bodyMat);
bodyShell.rotation.x = Math.PI / 2;   // align CylinderGeometry Y-axis → Z-axis
bodyShell.name = `${this.id}-hex-shell`;
this.mesh.add(bodyShell);
this._bodyShell = bodyShell;           // store for potential LOD swap
```

**Hex orientation**: With `rotation.x = π/2` and 6 radial segments, the default
`CylinderGeometry` vertex layout places one flat face pointing +Y (top) and one pointing
−Y (bottom). This gives flat mating surfaces for:
- **+Y flat**: PV panel, MRR antenna receiver — faces zenith/sun
- **−Y flat**: EPM docking collar — faces strut tip when docked
- **±X flats**: Solar cell patches — catch oblique sunlight once per orbit rotation

| **Triangles** | **24** (6 sides × 2 + 2 caps × 6) |
|----------|-------|

**Replaces**: `BoxGeometry` = 12 tris. **Delta**: +12 tris.

---

#### 13.5.4 MLI Thermal Blanket Band (Reshaped for Hex Body)

The existing gold MLI accent at [`ArmUnit.js:296–302`](js/entities/ArmUnit.js:296) changes
from a `BoxGeometry` overlay to a matching hex cylinder section, creating a gold Kapton
stripe around the body at the forward-of-center zone — where MLI wraps are typically
visible on real CubeSats.

```javascript
// --- Gold MLI thermal blanket band (hex-matched) ---
const mliBandGeo = new THREE.CylinderGeometry(
  hexR * 1.02, hexR * 1.02,   // 2% proud of body surface (prevents z-fight)
  bz * 0.25 * M,              // 25% of body length
  6                            // match body hex segment count
);
const mliMat = new THREE.MeshStandardMaterial({
  color: 0xccaa44, metalness: 0.90, roughness: 0.20,
});
const mliBand = new THREE.Mesh(mliBandGeo, mliMat);
mliBand.rotation.x = Math.PI / 2;     // same orientation as body shell
mliBand.position.z = bz * 0.12 * M;   // offset slightly forward of center
mliBand.name = `${this.id}-mli-band`;
this.mesh.add(mliBand);
```

| **Triangles** | **24** |
|----------|-------|

**Replaces**: Box MLI band = 12 tris. **Delta**: +12 tris.

---

#### 13.5.5 FEEP Thruster Nozzle Pair (Fore + Aft, ±15° Vectorable)

The existing design specifies **2 FEEP thrusters per arm** on **swivel yokes** with
**±15° thrust vectoring** ([`ION_THRUSTER.THRUSTER_COUNT: 2`](js/core/Constants.js:1991),
[`VECTOR_ANGLE_MAX: 15`](js/core/Constants.js:1989),
[`DAUGHTER_ARM_CONTROLS.md:284`](DAUGHTER_ARM_CONTROLS.md:284)). This is NOT 4 RCS stubs
— it is a matched pair of gimballed FEEP nozzles that together provide full 3-axis
authority without any separate RCS system:

| Role | How | Which Nozzle |
|------|-----|-------------|
| **Forward acceleration** | Aft nozzle fires along −Z | Aft (main) |
| **Braking / deceleration** | Fore nozzle fires along +Z | Fore (braking) |
| **Pitch / yaw attitude** | Either nozzle vectors ±15° off-axis | Both (vectored) |
| **Lateral translation** | Both nozzles vector same direction | Both (coordinated) |
| **Tether tension hold** | Fore nozzle fires gently toward debris | Fore (stationkeep) |

Spinners carry NO cold gas — FEEP vectoring + magnetorquer handles all attitude
([`V3 Octopus.md:699`](archive/V3%20Octopus.md:699)). Weavers carry
[`0.2 kg N₂ cold gas`](js/core/Constants.js:137) for rapid attitude slews during capture.

##### Aft Nozzle (Main Propulsion — Replaces Current Single Nozzle)

The existing single aft nozzle at [`ArmUnit.js:386–395`](js/entities/ArmUnit.js:386) is
**kept in position** but reshaped. FEEP emitters are NOT bell/cone nozzles — they are
short cylindrical stubs with a flat or needle-array tip. The visual is a stubby metal
cylinder, not a flared cone.

| Parameter | Weaver | Spinner | Notes |
|-----------|--------|---------|-------|
| Nozzle radius | 15mm | 10mm | FEEP emitter assembly OD |
| Nozzle length | 25mm | 15mm | Stub protruding from aft face |
| Position | (0, 0, −bz×0.52) | same | Centered on aft face (−Z) |
| Material | Tungsten-molybdenum | same | Refractory metal (withstands ion erosion) |

```javascript
// --- Aft FEEP nozzle (main propulsion, centered on −Z face) ---
const aftNozR = (isWeaver ? 0.015 : 0.010) * M;
const aftNozL = (isWeaver ? 0.025 : 0.015) * M;
const aftNozGeo = new THREE.CylinderGeometry(aftNozR, aftNozR * 1.1, aftNozL, 6, 1, true);
const feepMat = new THREE.MeshStandardMaterial({
  color: 0x444455, metalness: 0.85, roughness: 0.25,  // tungsten-molybdenum
});
const aftNozzle = new THREE.Mesh(aftNozGeo, feepMat);
aftNozzle.position.set(0, 0, -bz * 0.52 * M);
aftNozzle.rotation.x = Math.PI / 2;
aftNozzle.name = `${this.id}-feep-aft`;
this.mesh.add(aftNozzle);
```

| **Triangles (aft nozzle)** | **12** (`CylinderGeometry(6, 1, true)`) |
|----------|-------|

##### Fore Nozzle (Braking / Attitude — NEW)

A **smaller** fore nozzle on the +Z face provides braking thrust and attitude authority.
This was identified as missing in [§2.5](EPIC10_DEEP_ANALYSIS.md:200) ("Fore thruster:
Braking/attitude — None — Smaller nozzle at +Z face"). The fore nozzle is offset from
center to avoid blocking the net canister aperture.

| Parameter | Weaver | Spinner | Notes |
|-----------|--------|---------|-------|
| Nozzle radius | 10mm | 7mm | ~67% of aft nozzle (lower thrust rating) |
| Nozzle length | 15mm | 10mm | Shorter than aft |
| Position | (bx×0.25, 0, +bz×0.45) | same ratio | Offset starboard, clears net canister |
| Material | Same tungsten-moly | same | Shared `feepMat` |

```javascript
// --- Fore FEEP nozzle (braking/attitude, offset on +Z face) ---
const foreNozR = (isWeaver ? 0.010 : 0.007) * M;
const foreNozL = (isWeaver ? 0.015 : 0.010) * M;
const foreNozGeo = new THREE.CylinderGeometry(foreNozR, foreNozR * 1.1, foreNozL, 6, 1, true);
const foreNozzle = new THREE.Mesh(foreNozGeo, feepMat);
foreNozzle.position.set(bx * 0.25 * M, 0, bz * 0.45 * M);
foreNozzle.rotation.x = -Math.PI / 2;   // open end faces forward (+Z)
foreNozzle.name = `${this.id}-feep-fore`;
this.mesh.add(foreNozzle);
```

| **Triangles (fore nozzle)** | **12** (`CylinderGeometry(6, 1, true)`) |
|----------|-------|

##### Nozzle Arrangement Diagram

```
    Side view (looking along +X):
    
         +Y
          │
    ┌─────┤─────────────────────────────┤─────┐
    │     │         HEX BODY            │     │
    │     │                             │     │
    └─────┤─────┬───────────────┬───────┤─────┘
          │     │               │       │
          │                             │
          │   +Z ◄══════════════════► −Z
          │ (fore)                   (aft)
          │     │               │       │
          │   ┌─┤               ├──┐    │
          │   │F│  net canister │ A│    │     F = fore FEEP nozzle
          │   └─┘               └──┘    │     A = aft FEEP nozzle
          │                             │
         −Y
    
    Both nozzles vector ±15° via swivel yoke for attitude control.
    Fore nozzle offset to starboard (+X) to clear net canister bore.
```

##### Plume Cones (1 Aft, 1 Fore)

The existing aft plume cone at [`ArmUnit.js:397–409`](js/entities/ArmUnit.js:397) is
**kept** for the aft nozzle. A matching fore plume is added (smaller, same material).
Both are hidden by default and animated in [`_updatePlumes()`](js/entities/ArmUnit.js:3261).

```javascript
// Aft plume (existing, position adjusted)
plume.position.set(0, 0, -bz * 0.75 * M);
this._thrusterPlumes.push(plume);   // index 0 = aft

// Fore plume (new, smaller)
const forePlumeGeo = new THREE.ConeGeometry(foreNozR * 2, bz * 0.3 * M, 6, 1, true);
const forePlume = new THREE.Mesh(forePlumeGeo, plumeMat.clone());
forePlume.position.set(bx * 0.25 * M, 0, bz * 0.65 * M);
forePlume.rotation.x = Math.PI / 2;   // cone points forward (+Z)
forePlume.visible = false;
this.mesh.add(forePlume);
this._thrusterPlumes.push(forePlume); // index 1 = fore
```

**Animation hook**: `this._thrusterPlumes[0]` = aft plume, `this._thrusterPlumes[1]` =
fore plume. The existing [`_updatePlumes()`](js/entities/ArmUnit.js:3261) iterates all
entries — fore plume animates automatically without code changes.

##### Total Triangle Count

| Component | Tris |
|-----------|------|
| Aft nozzle (`CylinderGeometry(6, 1, true)`) | 12 |
| Fore nozzle (`CylinderGeometry(6, 1, true)`) | 12 |
| Aft plume cone (existing, repositioned) | 12 |
| Fore plume cone (new) | 12 |
| **Total thruster assembly** | **48** |

**Was**: 1 aft nozzle (12) + 1 aft plume (12) = 24 tris.
**Delta**: +24 tris (2 new meshes: fore nozzle + fore plume).

---

#### 13.5.6 Body-Mounted Solar Cell Patches (2× Side Panels) + Power Budget Analysis

Real small satellites have GaAs triple-junction cells bonded directly to bus panels.
These supplement the deployment-critical ROSA wings with passive power harvesting from
any sun-facing body side.

##### Daughter Power Budget — Is Battery Enough? How Much Does Solar Help?

| Parameter | Weaver | Spinner | Source |
|-----------|--------|---------|--------|
| Battery capacity | 25 Wh | 10 Wh | [`WEAVER_BATTERY`](js/core/Constants.js:136), [`SPINNER_BATTERY`](js/core/Constants.js:155) |
| FEEP beam power (thrusting) | 40 W | 25 W | [`ION_THRUSTER.BEAM_POWER_WEAVER`](js/core/Constants.js:1986) |
| ROSA wing solar (peak) | 15 W | 8 W | [`WEAVER_SOLAR_POWER`](js/core/Constants.js:135), [`SPINNER_SOLAR_POWER`](js/core/Constants.js:154) |
| Laser power received (PV panel) | 19.5 W | 19.5 W | [`WEAVER_LASER_POWER_RECV`](js/core/Constants.js:134), [`SPINNER_LASER_POWER_RECV`](js/core/Constants.js:153) |
| Dock charge rate (pogo pins) | 56 W | 56 W | S3.4 spec: 28V × 2A through 2 power pogo pins |

**Battery-only runtime** (no solar, no laser — worst case: eclipse + mother occluded):
- Weaver: 25 Wh ÷ 40 W = **37.5 min** continuous thrusting
- Spinner: 10 Wh ÷ 25 W = **24 min** continuous thrusting
- Both sufficient for a typical capture mission (transit + approach + capture = 20–40 min)

**With ROSA solar only** (daylight, no laser link):
- Weaver: net drain = 40 − 15 = 25 W → battery lasts 25 ÷ 25 = **60 min**
- Spinner: net drain = 25 − 8 = 17 W → battery lasts 10 ÷ 17 = **35 min**
- Solar extends battery life by 60–47% — significant backup

**With solar + laser power** (daylight, mother laser active — nominal ops):
- Weaver: net drain = 40 − 15 − 19.5 = **5.5 W** → battery lasts **4.5 hours**
- Spinner: net drain = 25 − 8 − 19.5 = **−2.5 W (surplus!)** → **indefinite operation**
- Laser power beaming is the PRIMARY power source during missions. The mother's 200W
  laser ([`CORE_LASER_POWER`](js/core/Constants.js:329)) at 60% wall-plug efficiency
  → 120W optical → 19.5W at daughter (16% end-to-end link efficiency at 2 km)

**Dock charging** (between missions, pogo pins at 56W):
- Weaver: 25 Wh ÷ 56 W = **27 min** to full charge
- Spinner: 10 Wh ÷ 56 W = **11 min** to full charge
- Typical docking interval (return + dock + prep) is 5–10 min → **25–47% recharge**
  between captures even without waiting

**Body-mounted solar cell contribution** (the patches below):
- 2 patches at 60×100mm each = 0.012 m² total GaAs area
- At 30% efficiency, 1360 W/m² AM0 irradiance: 0.012 × 1360 × 0.30 = **4.9 W**
- But only one patch faces the sun at a time → effective **~2.5 W average**
- That's 6% of weaver's 40W demand — **marginal but nonzero**
- Real value: provides trickle power if ROSA wings happen to be edge-on to the sun

**Bottom line**: Battery alone is sufficient for single missions. ROSA solar extends
runtime by ~50%. Laser power beaming enables near-indefinite operation. Body solar cells
add ~2.5W — cosmetically accurate detail with marginal power contribution. Dock charging
replenishes 25–47% capacity in typical inter-mission intervals.

##### Placement and Dimensions

| Parameter | Weaver | Spinner | Notes |
|-----------|--------|---------|-------|
| Cell width (along-body Z) | 100mm | 50mm | ~33% of bz |
| Cell height (along-body Y) | 120mm | 60mm | ~60% of by |
| Side offset (X) | ±100mm (apothem) | ±50mm | Flush with ±X hex flat face |
| Z center | 0 (mid-body) | 0 | Centered on body |

##### Code

```javascript
// --- 2× body-mounted solar cell patches (±X hex faces) ---
const cellW = bz * 0.33 * M;     // along Z
const cellH = by * 0.60 * M;     // along Y
const cellGeo = new THREE.PlaneGeometry(cellW, cellH);
// Reuse ROSA panelMat (0x0a1133, dark blue GaAs appearance)

for (let side = 0; side < 2; side++) {
  const signX = side === 0 ? 1 : -1;
  const cell = new THREE.Mesh(cellGeo, panelMat);
  cell.position.set(
    signX * apothem * 1.005,     // just proud of hex face (anti z-fight)
    0,                            // vertically centered
    0                             // longitudinally centered
  );
  cell.rotation.y = signX * Math.PI / 2;  // face outward ±X
  cell.name = `${this.id}-solar-cell-${side}`;
  this.mesh.add(cell);
}
```

| **Triangles (2 patches)** | **4** (2 per `PlaneGeometry`) |
|----------|-------|

**Delta**: +4 tris (new geometry, nothing replaced).

---

#### 13.5.7 Patch Antenna / MRR Upgrade (Replaces SphereGeometry)

The current MRR retroreflector at [`ArmUnit.js:435–442`](js/entities/ArmUnit.js:435) is a
**60-triangle** `SphereGeometry(0.01*M, 6, 6)`. This is the most over-tessellated part
on the entire daughter body — 60 triangles for a ∅20mm detail. It is replaced by a
**flat hexagonal patch antenna** — more accurate for an optical MRR (Modulated
RetroReflector) and dramatically cheaper.

##### What Is an MRR? (Modulated RetroReflector — Plain English)

A **retroreflector** is a mirror that bounces light straight back to its source regardless
of angle — like highway sign reflectors that shine your headlights back at you. In space,
these are built as **corner cube** prisms (three mutually perpendicular mirrors forming an
internal corner). The Apollo astronauts left retroreflector arrays on the Moon; we still
bounce lasers off them 55 years later.

A **modulated** retroreflector adds a fast **shutter** in front of the corner cubes —
typically a liquid crystal (LC) cell or a Multiple Quantum Well (MQW) absorber. The
shutter switches between "reflecting" and "absorbing" at up to megahertz rates. By
toggling the shutter rapidly, the daughter **encodes binary data onto the reflected
laser beam** — essentially optical Morse code at very high speed.

**How daughter→mother comms work:**
1. Mother fires continuous 808nm laser at daughter (same laser used for power beaming
   and rangefinding — [`CORE_LASER_POWER: 200W`](js/core/Constants.js:329))
2. Laser hits daughter's MRR on the top-aft face
3. Corner cubes retroreflect the beam straight back to mother
4. LC shutter modulates the return beam to encode telemetry: battery %, fuel state,
   sensor data, arm state, captured debris mass
5. Mother's laser receiver decodes the modulated return signal

**Why not a radio?** The MRR draws **milliwatts** vs watts for a UHF transmitter
([`archive/RESEARCH_ARCHIVE.md:230`](archive/RESEARCH_ARCHIVE.md:230) — "MRR replaces
UHF, 0.015W/arm vs 0.1W/arm"). At 2 km range, the laser link provides higher bandwidth
than UHF with 85% less power. The mother already has the laser — the MRR is a ~10g
passive optical component.

**Real-world examples:** MIT Lincoln Lab MRR for UAV laser comms, Naval Research
Laboratory ORCA (Optical Retroreflector Cross-link Architecture), various CubeSat laser
comm demos. TRL 6 for space application
([`archive/V3 Octopus.md:1355`](archive/V3%20Octopus.md:1355)).

**Physical appearance:** A small flat array of micro corner cubes (∅15–30mm) with a thin
dark LC film over the front face. When the laser hits it, the face flashes bright
aluminum; otherwise it appears dark/matte. A flat hexagonal disc is the correct game
visual — the current white metallic sphere is physically inaccurate (retroreflectors are
flat arrays, not spheres).

##### Code

```javascript
// --- MRR patch antenna (flat hex disc, replaces 60-tri sphere) ---
const mrrR = (isWeaver ? 0.015 : 0.010) * M;
const mrrGeo = new THREE.CircleGeometry(mrrR, 6);
const mrrMat = new THREE.MeshStandardMaterial({
  color: 0xccccdd, metalness: 0.95, roughness: 0.15,  // polished aluminum
  side: THREE.DoubleSide,
});
const mrr = new THREE.Mesh(mrrGeo, mrrMat);
mrr.position.set(
  bx * 0.25 * M,       // offset starboard from center
  by * 0.52 * M,       // on top face (+Y), just above body shell
  -bz * 0.20 * M       // aft-of-center (faces zenith toward mother ship)
);
mrr.rotation.x = -Math.PI / 2;  // face upward (+Y)
mrr.name = `${this.id}-mrr-patch`;
this.mesh.add(mrr);
```

| **Triangles** | **6** (`CircleGeometry(r, 6)` = 6 triangular fan segments) |
|----------|-------|

**Replaces**: `SphereGeometry(0.01*M, 6, 6)` = 60 tris.
**Delta**: **−54 tris** (single largest savings in the entire S3.5 scope).

---

#### 13.5.8 Panel Line Detail (EdgesGeometry — Zero Triangle Cost)

The single most impactful "free" visual upgrade. Three.js `EdgesGeometry` extracts edges
above a dihedral angle threshold from the hex body and renders them as thin lines,
creating visible panel seams between hex faces.

```javascript
// --- Panel line edges (line geometry, zero triangle cost) ---
const edgeGeo = new THREE.EdgesGeometry(hexGeo, 30);  // 30° dihedral threshold
const edgeMat = new THREE.LineBasicMaterial({
  color: 0x667788,
  transparent: true,
  opacity: 0.5,
});
const edges = new THREE.LineSegments(edgeGeo, edgeMat);
edges.rotation.x = Math.PI / 2;  // match body shell orientation
edges.name = `${this.id}-panel-lines`;
this.mesh.add(edges);
```

| **Triangles** | **0** (line geometry only) |
|----------|-------|

**Visual impact**: Massive. Panel lines break up the flat-shaded hex faces into distinct
structural zones, making the daughter read as a manufactured object rather than a
geometric primitive. At game camera distances (5–50m), these edge lines are the primary
shape cue that distinguishes "spacecraft hull" from "game token."

**Why 30° threshold?** A hex prism with 6 sides has 120° interior angles at each edge,
producing 60° dihedral angles at all longitudinal edges and 90° at cap-to-side edges.
A 30° threshold captures ALL hex edges (all exceed 30°), giving the complete wireframe
outline without noise from coplanar triangle edges within faces.

---

#### 13.5.9 Forward End-Effector Differentiation — Scope Decision

**Decision: OUT OF SCOPE for S3.5.**

The forward equipment (net canister at +Z) is identical geometry for both arm types in
the current code at [`ArmUnit.js:411–421`](js/entities/ArmUnit.js:411). Differentiating
weavers (larger net launcher, grappler jaws) from spinners (smaller net, gecko pad)
requires:

1. New geometry for grappler/gripper mechanism (weaver)
2. Gecko pad texture or geometry (spinner)
3. Distinct net launcher housings by size class

These are better addressed in a dedicated **S3.7 End-Effector Visual Identity** sprint
after the body shape and equipment baseline is established. S3.5 focuses on the **hull
and external equipment** visible from all viewing angles.

**What stays unchanged in S3.5:**
- Net canister geometry (`CylinderGeometry`, 8 segments, open-ended)
- Net canister position (`z = bz * 0.55 * M`, forward)
- Net canister material (`0x666677`)

---

#### 13.5.10 Integration with S3.4 (EPM Collar + Pusher Plate)

##### S3.4 Components on the Daughter (Unchanged)

| Component | Position | Code Lines | Attached To |
|-----------|----------|------------|-------------|
| EPM housing | `y = −by × 0.52 × M` | [`ArmUnit.js:451–460`](js/entities/ArmUnit.js:451) | `this.mesh` |
| EPM pole face | `y = −by × 0.52 × M − epmH × 0.51` | [`ArmUnit.js:462–476`](js/entities/ArmUnit.js:462) | `this.mesh` |
| Pusher plate | `z = −bz × 0.52 × M` | [`ArmUnit.js:478–488`](js/entities/ArmUnit.js:478) | `this.mesh` |

##### Integration Verification

Because `this.mesh` changes from `Mesh` → `Group` (§13.5.3), and all S3.4 children are
added via `this.mesh.add()` with position offsets in the same XYZ coordinate frame,
**no position changes are needed**. The S3.4 code blocks remain exactly as-is.

##### Geometric Clearance

The EPM housing cylinder (∅50mm weaver / ∅40mm spinner) sits on the hex body's −Y flat
face. The hex flat-to-flat dimension (200mm / 100mm) greatly exceeds the EPM diameter —
**no clipping**. The pusher plate on the −Z face is well within the hex aft cap area.

##### Deferred: Connector Ring

A thin transition ring mesh at the −Y face junction between hex body and EPM housing
would add mechanical realism. **Not needed for sprint** — the EPM housing already sits
proud of the body face with sufficient visual separation.

---

#### 13.5.11 Assembly Diagrams

##### Weaver — Top View (Looking Down +Y Axis)

```
                       +Z (forward)
                           │
                ┌──────────┼──────────┐
               ╱  Net canister (cyl)   ╲
              ╱            │            ╲
       ╔═════╬═════════════╪═════════════╬═════╗
       ║Solar│             │             │Solar║  ← GaAs cell patch (X hex face)
       ║Cell ╱─────────────┼─────────────╲Cell ║
       ║    ╱    Hex Body  │  (6-sided)   ╲    ║
       ╚═══╱═══════════════╪═══════╤═══════╲═══╝
           ╲   MLI gold    │  MRR ─┘        ╱     ← MRR patch (top-aft)
            ╲   band       │              ╱
             ╲─────────────┼─────────────╱
              ╲            ┼    [F]    ╱           ← Fore FEEP nozzle (+Z, offset +X)
               ╲      ─── ─┼── [A]   ╱            ← Aft FEEP nozzle (−Z, centered)
                └──────────┼──────────┘
                           │
                       −Z (aft)
                       
       Hex body: ∅200mm flat-to-flat × 300mm Z-length
```

##### Weaver — Side View (Looking Along +X Axis)

```
        +Y (top)
         │   ┌─ PV Panel ─┐   ┌─ MRR patch
         │   │  Laser Rcvr │   │
   ┌─────┤───┴─────────────┴───┴───┤─────┐
   │     │                         │     │
  ROSA   │      HEX BODY SHELL    │    ROSA     ← ROSA wings ±Y
  wing   │       (6-sided)        │    wing
   │     │                         │     │
   └─────┤───┬─────────────────────┤─────┘
         │   │    EPM Housing      │
         │   │   ╔══ Pole ══╗      │            ← S3.4 EPM collar (−Y face)
         │   └───╚══════════╝──────┘
         │
         │
         │          +Z ──────────────── −Z
         │       (forward)              (aft)
         │
         │  ┌─────┬────────────────────────────┐
         │  │ Net │    Body Z-extent            │
         │  │ can │      ┌─MLI gold band─┐      │
         │  │     │      └───────────────┘      │
         │  └─────┴────────────────────┬───────┘
         │                             │◄─ Aft FEEP nozzle (centered)
         │                             │◄─ Pusher plate (S3.4)
         │
        −Y (dock face)
```

##### Spinner — Same Layout, Smaller

```
  Identical topology, scaled by Spinner/Weaver ratio:
  - Hex body: ∅100mm flat-to-flat × 150mm Z-length  (50% scale)
  - FEEP nozzles: aft 10mm, fore 7mm radius          (67% scale)
  - Solar cells: 50×60mm patches                    (50% scale)
  - MRR patch: ∅20mm disc                           (67% scale)
  - Color: 0x88aa44 (olive green) vs 0x4488aa (steel blue)
  - EPM collar: ∅40mm vs ∅50mm                      (per S3.4 §13.4.4)
```

---

#### 13.5.12 Polygon Budget (Full Spec)

##### Per-Component Triangle Count

| # | Component | Geometry | Segs | Tris | Was | Delta | Status |
|---|-----------|----------|------|------|-----|-------|--------|
| 1 | Hex body shell | `CylinderGeometry(hexR, hexR, bz*M, 6)` | 6 | 24 | 12 | +12 | CHANGED |
| 2 | MLI thermal band | `CylinderGeometry(hexR*1.02, …, 6)` | 6 | 24 | 12 | +12 | CHANGED |
| 3 | Panel line edges | `EdgesGeometry` → `LineSegments` | — | 0 | 0 | 0 | NEW |
| 4 | Aft FEEP nozzle | `CylinderGeometry(…, 6, 1, true)` | 6 | 12 | 12 | 0 | RESHAPED |
| 5 | Fore FEEP nozzle | `CylinderGeometry(…, 6, 1, true)` | 6 | 12 | 0 | +12 | NEW |
| 6 | Aft plume cone | `ConeGeometry(…, 6, 1, true)` | 6 | 12 | 12 | 0 | REPOSITIONED |
| 7 | Fore plume cone | `ConeGeometry(…, 6, 1, true)` | 6 | 12 | 0 | +12 | NEW |
| 8 | 2× solar cell patches | `PlaneGeometry` ×2 | — | 4 | 0 | +4 | NEW |
| 9 | MRR patch antenna | `CircleGeometry(mrrR, 6)` | 6 | 6 | 60 | **−54** | CHANGED |
| 10 | Net canister | `CylinderGeometry(8, 1, true)` | 8 | 16 | 16 | 0 | UNCHANGED |
| 11 | PV panel | `PlaneGeometry` | — | 2 | 2 | 0 | UNCHANGED |
| 12 | Status light | `SphereGeometry(4, 4)` | 4 | 24 | 24 | 0 | UNCHANGED |
| 13 | ROSA top wing | ShapeGeo + PlaneGeo + CylGeo | — | ~56 | ~56 | 0 | UNCHANGED |
| 14 | ROSA bot wing | ShapeGeo + PlaneGeo + CylGeo | — | ~56 | ~56 | 0 | UNCHANGED |
| 15 | EPM housing | `CylinderGeometry(8)` | 8 | 32 | 32 | 0 | S3.4 |
| 16 | EPM pole face | `RingGeometry(8, 1)` | 8 | 16 | 16 | 0 | S3.4 |
| 17 | Pusher plate | `CylinderGeometry(6)` | 6 | 24 | 24 | 0 | S3.4 |

##### Summary

| Metric | Value |
|--------|-------|
| **Total tris (new)** | **356** |
| **Total tris (old)** | **~334** |
| **Net delta per arm** | **+22 tris** |
| **Budget ceiling** | ≤400 additional per arm |
| **Budget status** | **5.5% of budget used — massive headroom** |
| **×4 arms system delta** | **+88 tris total** |

Additions (+52: hex +12, MLI +12, fore nozzle +12, fore plume +12, solar +4) are largely
offset by the MRR sphere→patch replacement (−54). **Net cost is only +22 tris/arm**, well
under the ≤400 budget with 94% headroom for S3.7 end-effector differentiation.

---

#### 13.5.13 Color Palette Reference

| Component | Hex Code | RGB | Metalness | Roughness | Visual Description |
|-----------|----------|-----|-----------|-----------|-------------------|
| Weaver body | `0x4488aa` | 68, 136, 170 | 0.80 | 0.30 | Steel blue — team identity |
| Spinner body | `0x88aa44` | 136, 170, 68 | 0.80 | 0.30 | Olive green — team identity |
| MLI band | `0xccaa44` | 204, 170, 68 | 0.90 | 0.20 | Kapton gold — thermal blanket |
| FEEP nozzle | `0x444455` | 68, 68, 85 | 0.85 | 0.25 | Dark tungsten — W-Mo refractory |
| Solar cell | `0x0a1133` | 10, 17, 51 | 0.40 | 0.50 | Near-black blue — GaAs wafer |
| MRR patch | `0xccccdd` | 204, 204, 221 | 0.95 | 0.15 | Polished aluminum — corner cube |
| Panel edges | `0x667788` | 102, 119, 136 | — | — | Blue-grey @ 50% alpha — subtle |
| Plume (W) | `0x4488ff` | 68, 136, 255 | — | — | Blue ion exhaust |
| Plume (S) | `0x44ff88` | 68, 255, 136 | — | — | Green ion exhaust |

---

#### 13.5.14 Implementation Notes

##### 1. Shared Geometry Pattern (Module-Level)

Create shared geometries ONCE before any `ArmUnit` construction, following the pattern
from §13.4.12. Shared across all arms of the same type:

```javascript
// Module-level shared geometry (lazy init, called from _createMesh)
let _sharedHexW = null, _sharedHexS = null;

function _ensureSharedGeo() {
  if (_sharedHexW) return;
  const Mval = Constants.SCENE_SCALE;
  
  // --- Weaver geometries ---
  const wApothem = 0.1 * Mval;
  const wR = wApothem / Math.cos(Math.PI / 6);
  const wHexGeo = new THREE.CylinderGeometry(wR, wR, 0.3 * Mval, 6);
  _sharedHexW = {
    hex:     wHexGeo,
    edges:   new THREE.EdgesGeometry(wHexGeo, 30),
    mli:     new THREE.CylinderGeometry(wR * 1.02, wR * 1.02, 0.075 * Mval, 6),
    aftNoz:  new THREE.CylinderGeometry(0.015 * Mval, 0.0165 * Mval, 0.025 * Mval, 6, 1, true),
    foreNoz: new THREE.CylinderGeometry(0.010 * Mval, 0.011 * Mval, 0.015 * Mval, 6, 1, true),
    cell:    new THREE.PlaneGeometry(0.10 * Mval, 0.12 * Mval),
    mrr:     new THREE.CircleGeometry(0.015 * Mval, 6),
  };
  
  // --- Spinner geometries (same topology, smaller) ---
  const sApothem = 0.05 * Mval;
  const sR = sApothem / Math.cos(Math.PI / 6);
  const sHexGeo = new THREE.CylinderGeometry(sR, sR, 0.15 * Mval, 6);
  _sharedHexS = {
    hex:     sHexGeo,
    edges:   new THREE.EdgesGeometry(sHexGeo, 30),
    mli:     new THREE.CylinderGeometry(sR * 1.02, sR * 1.02, 0.0375 * Mval, 6),
    aftNoz:  new THREE.CylinderGeometry(0.010 * Mval, 0.011 * Mval, 0.015 * Mval, 6, 1, true),
    foreNoz: new THREE.CylinderGeometry(0.007 * Mval, 0.0077 * Mval, 0.010 * Mval, 6, 1, true),
    cell:    new THREE.PlaneGeometry(0.05 * Mval, 0.06 * Mval),
    mrr:     new THREE.CircleGeometry(0.010 * Mval, 6),
  };
}
```

##### 2. Property Storage for Animation

| Property | Type | Purpose | New/Existing |
|----------|------|---------|--------------|
| `this._bodyShell` | `Mesh` | Hex body shell ref (LOD swap future) | NEW |
| `this._feepAft` | `Mesh` | Aft FEEP nozzle (vectoring animation future) | NEW |
| `this._feepFore` | `Mesh` | Fore FEEP nozzle (vectoring animation future) | NEW |
| `this._epmPoleMat` | `Material` | EPM emissive state control | EXISTING (S3.4) |
| `this._thrusterPlumes` | `Mesh[]` | Plume cones [0]=aft, [1]=fore if built | EXISTING (extended) |
| `this._statusLightMat` | `Material` | Status blink color swap | EXISTING |

##### 3. Existing Code Removal Checklist

The following [`_createMesh()`](js/entities/ArmUnit.js:280) blocks are **replaced**:

| Lines | What | Replaced By |
|-------|------|-------------|
| [`284–293`](js/entities/ArmUnit.js:284) | `BoxGeometry` body + `MeshStandardMaterial` | §13.5.3 — `Group` + hex shell |
| [`296–302`](js/entities/ArmUnit.js:296) | `BoxGeometry` MLI band | §13.5.4 — hex MLI band |
| [`386–395`](js/entities/ArmUnit.js:386) | Single FEEP bell nozzle | §13.5.5 — reshaped aft FEEP stub + new fore nozzle |
| [`397–408`](js/entities/ArmUnit.js:397) | Plume cone (position only) | §13.5.5 — repositioned plume |
| [`435–442`](js/entities/ArmUnit.js:435) | `SphereGeometry` MRR | §13.5.7 — `CircleGeometry` patch |

**Unchanged blocks** (no modifications):

| Lines | What |
|-------|------|
| [`304–384`](js/entities/ArmUnit.js:304) | ROSA wings (±Y, both wings) |
| [`411–421`](js/entities/ArmUnit.js:411) | Net canister (forward) |
| [`423–433`](js/entities/ArmUnit.js:423) | PV panel (top face) |
| [`444–449`](js/entities/ArmUnit.js:444) | Status light (top-aft) |
| [`451–488`](js/entities/ArmUnit.js:451) | S3.4 EPM collar + pusher plate |

##### 4. Edge Case: Raycasting

If any external system performs raycasting against `this.mesh` expecting a `Mesh`
geometry (for hit detection), it will fail on a `Group`. The `recursive: true` option in
`raycaster.intersectObject(this.mesh, true)` handles this — it raycasts against all
child meshes in the group. Verify any raycasting callsites use `recursive: true`.

---

#### 13.5.15 Sprint Build Simplifications — What to Actually Implement

The full spec (§13.5.1–§13.5.14) documents complete design. Sprint simplifications reduce
code complexity with negligible visual impact at game camera distances:

##### Simplification Analysis

| Component | Full Spec | Simplified | Why | Tri Impact |
|-----------|-----------|------------|-----|------------|
| **Hex body (6-seg)** | `CylinderGeometry(6)` = 24 tris | **KEEP** | This IS the upgrade. Hex body is the core visual improvement — without it, S3.5 has no purpose. | 0 |
| **Panel line edges** | `EdgesGeometry` → `LineSegments` | **KEEP** | Zero tri cost, massive visual impact. The hex body without panel lines looks like a smooth plastic hexagon; lines make it read as "manufactured hull." | 0 |
| **MLI thermal band** | Hex CylinderGeo = 24 tris | **DROP as separate mesh** | The hex body already has 6 distinct flat faces. Gold thermal blanket zones are better communicated by the body material itself. The band was necessary when the body was a featureless box — with a hex shape + panel lines, it's redundant. | −24 tris, −1 mesh |
| **Aft FEEP nozzle** | Reshaped CylGeo(6, open) = 12 tris | **KEEP** | Already exists — only shape change (bell → stub). No new mesh, just reshape the existing nozzle. Correct FEEP emitter visual. | 0 (reshape in place) |
| **Fore FEEP nozzle** | New CylGeo(6, open) = 12 tris | **KEEP** | The fore nozzle is the key "spacecraft" cue — it communicates bidirectional thrust capability. Without it, daughter looks like a one-way projectile. Matches `ION_THRUSTER.THRUSTER_COUNT: 2`. | +12 tris, +1 mesh |
| **Fore plume cone** | ConeGeo(6, open) = 12 tris | **DROP** | Single aft plume is adequate for sprint. Fore plume only matters when braking animation is implemented. Plume array iteration already handles variable length. | −12 tris, −1 mesh |
| **2× body solar cells** | 2 × PlaneGeo = 4 tris | **DROP** | ROSA wings dominate the solar visual. Body cells add ~2.5W out of 40W demand (§13.5.6 power budget). Invisible at 10–50m camera distance. | −4 tris, −2 meshes |
| **MRR patch antenna** | `CircleGeometry(6)` = 6 tris | **KEEP** | Replaces 60-tri sphere — net savings of 54 tris. Must change — the MRR sphere is the single most wasteful geometry on the daughter body. | −54 tris net |
| **Shared geometries** | Module-level lazy init | **KEEP** | Essential for Y3 Octo (8 arms). 2 geometry sets reused across all arms. | 0, cleaner code |

##### What Gets Built (Final Sprint Spec)

**Body group = `THREE.Group` with children:**

| Index | Child | Geometry | Tris |
|-------|-------|----------|------|
| 0 | Hex body shell | `CylinderGeometry(hexR, hexR, bz*M, 6)` | 24 |
| 1 | Panel line edges | `EdgesGeometry(hexGeo, 30)` → `LineSegments` | 0 |
| 2 | MRR patch antenna | `CircleGeometry(mrrR, 6)` | 6 |

**FEEP thruster pair (fore + aft):**

| — | Child | Geometry | Tris |
|---|-------|----------|------|
| 3 | Aft FEEP nozzle | `CylinderGeometry(aftR, aftR*1.1, aftL, 6, 1, true)` | 12 |
| 4 | Fore FEEP nozzle | `CylinderGeometry(foreR, foreR*1.1, foreL, 6, 1, true)` | 12 |
| 5 | Aft plume cone | (existing, repositioned) | 12 |

##### Simplified Polygon Budget

| Location | Component | Op | Count | Tris Each | Total |
|----------|-----------|----|-------|-----------|-------|
| **New** | Hex body shell | add | 1 | 24 | 24 |
| | Panel edges | add | 1 | 0 | 0 |
| | MRR patch | add | 1 | 6 | 6 |
| | Fore FEEP nozzle | add | 1 | 12 | 12 |
| | **Subtotal new** | | **4** | — | **42** |
| **Removed** | Box body | del | 1 | 12 | −12 |
| | Box MLI band | del | 1 | 12 | −12 |
| | Old MRR sphere | del | 1 | 60 | −60 |
| | **Subtotal removed** | | **3** | — | **−84** |
| **Reshaped** | Aft nozzle (bell → stub) | mod | 1 | 12→12 | 0 |
| | Aft plume (repositioned) | mod | 1 | 12→12 | 0 |
| **NET** | | | | | **−42** |
| **Per arm** | | | | | **saves 42 tris** |
| **×4 arms (Y0 Quad)** | | | | | **saves 168 tris** |

**The sprint body upgrade saves ~168 system triangles** while adding a hex body, panel
lines, fore thruster, and MRR patch. Exceptional headroom for S3.6 (bridle) and S3.7+
(end-effectors).

##### Implementation Task Breakdown (for Orchestrator)

**Task 1: Hex body + panel edges** (~18 LOC in [`_createMesh()`](js/entities/ArmUnit.js:280))
- Create module-level `_ensureSharedGeo()` with hex, edges, nozzle, mrr geometries
- Change `this.mesh` from `Mesh` to `Group`
- Add hex body shell as child with `rotation.x = π/2`
- Add `EdgesGeometry` → `LineSegments` as child with matching rotation
- Remove `BoxGeometry` body block ([lines 284–293](js/entities/ArmUnit.js:284))
- Remove `BoxGeometry` MLI band block ([lines 296–302](js/entities/ArmUnit.js:296))
- Store `this._bodyShell` reference

**Task 2: FEEP nozzle pair** (~15 LOC in [`_createMesh()`](js/entities/ArmUnit.js:280))
- Reshape existing aft nozzle ([lines 386–395](js/entities/ArmUnit.js:386)) from conical
  bell to cylindrical stub (change radii, keep position)
- Add new fore nozzle at (+bx×0.25, 0, +bz×0.45), open end facing +Z
- Reposition aft plume cone to `z = -bz * 0.75 * M`
- Both nozzles share `feepMat` (tungsten-moly `0x444455`)

**Task 3: MRR replacement** (~8 LOC in [`_createMesh()`](js/entities/ArmUnit.js:280))
- Replace `SphereGeometry` MRR ([lines 435–442](js/entities/ArmUnit.js:435)) with
  `CircleGeometry` patch antenna
- Same position (top-aft), rotated to face +Y
- Shared `mrrGeo` from `_ensureSharedGeo()`

**Total: ~41 LOC net change.** Touches 1 file: [`ArmUnit.js`](js/entities/ArmUnit.js).
No new files. No Constants changes. No test changes (tests don't inspect body geometry).

##### Deferred to Future Sprints

| Feature | Spec Section | Why Defer |
|---------|-------------|-----------|
| MLI thermal band (hex) | §13.5.4 | Hex shape + panel lines already communicate structure. Add when LOD system shows close-up detail. |
| Fore plume cone | §13.5.5 | Aft plume alone is adequate. Add fore plume when directional braking visualization implemented. |
| Per-nozzle vectoring animation | §13.5.5 | ±15° swivel yoke rotation. Add when ARM PILOT mode shows thrust direction indicator. |
| Body solar cell patches | §13.5.6 | ROSA wings dominate solar visual. Only ~2.5W contribution (§13.5.6 power budget). |
| Connector ring (EPM junction) | §13.5.10 | Clean mechanical transition at body↔EPM. Add when inspection camera reveals junction detail. |
| End-effector differentiation | §13.5.9 | Weaver grappler vs spinner gecko. Dedicated S3.7 sprint scope. |

### 13.7 S3.6 Wishbone Bridle + Gimbal Ring (Concern 1.6)

S3.6 is the final Sprint 3 task. It adds the visual **wishbone (Y-harness) bridle** and
**gimbal ring** connecting the single tether line from the strut-mounted reel (S3.3) to
the daughter arm body (S3.5). The bridle distributes tether tension across 2 lateral
hardpoints and prevents the daughter from spinning around the tether axis. The gimbal
ring at the Y-junction allows the tether to swivel relative to the bridle without wrap.

**Load chain**: Reel drum (strut 85%) → tether cable → gimbal ring → Y-fork legs ×2 →
daughter hardpoints ×2.

**Key design change from §2.6 / §13.4.1**: The original design specified a **3-leg
tripod** bridle at 120° spacing. §14.5 analysis shows this places one leg directly in the
aft FEEP plume cone (15° half-angle, −Z axis). S3.6 adopts the **2-leg wishbone** from
§14.5, with legs at ±X lateral positions — completely outside the −Z plume cone. The
[`BridleRing.js`](js/entities/BridleRing.js:1) data module retains
[`ATTACH_POINTS_PER_RING: 3`](js/core/Constants.js:360) for future Config G flexibility
(e.g., canted plume or forward-attach scenarios). The visual system renders 2 legs only.

---

#### 13.7.1 Engineering Analysis — Why a Wishbone Bridle

##### The Problem with Direct Tether Attachment

A single tether attached to one point on the daughter creates a moment arm. Any
off-axis tension torques the daughter, requiring constant FEEP correction (wastes fuel).
This is identical to why trawled vessels in maritime use bridle harnesses — load
distribution on a towed body.

##### Why 2 Legs (Wishbone), Not 3 (Tripod)

| Factor | 3-Leg Tripod | 2-Leg Wishbone |
|--------|-------------|----------------|
| **FEEP plume** | 1 leg in −Z plume cone → Dyneema degradation | Both legs at ±X → clear |
| **ROSA clearance** | 1 leg may cross ROSA root | Both legs between ROSA ±Y roots |
| **Anti-spin** | Over-constrained (3-point → attitude locked) | 2-point prevents roll, allows pitch/yaw via gimbal |
| **Mass** | 3 × leg + 3 × hardpoint | 2 × leg + 2 × hardpoint |
| **Geometry complexity** | 3 lines + 3 brackets | 2 lines + 2 brackets |
| **Load distribution** | Better (3-way) | Adequate (2-way symmetric) |

Conclusion: The 2-leg wishbone is the correct choice for this FEEP-equipped daughter. The
3-leg tripod is reserved for future non-FEEP towed payloads (passive debris capture).

##### Bridle Chain — Complete Mechanical Load Path

```
  Reel drum (strut 85%)
       │
       ▼  tether pays out through exit guide (§13.3)
  Exit guide ring (strut tip-ward face of reel)
       │
       │  ── single Dyneema SK78 cable, 3mm flat ribbon ──
       │
       ▼
  ╔════════════╗    Gimbal ring (torus, §13.7.3)
  ║ GIMBAL RING ║    Free rotation around tether axis
  ╚═════╤══════╝    ±30° pitch/yaw, spring-return-to-center
     ╱──┴──╲
    ╱       ╲         Y-fork legs (2× Dyneema, §13.7.4)
   ╱         ╲        200–280mm length depending on ring offset
  ◯           ◯      Hardpoint brackets (2×, §13.7.5)
  │ HEX BODY  │      At ±X lateral faces, upper region
  │  (S3.5)   │
  │     ◄══►  │      Aft FEEP plume exits −Z center
  └─────┴─────┘      Y-fork legs completely clear
```

##### When Docked vs Deployed

| Phase | Bridle State | Visual |
|-------|-------------|--------|
| **DOCKED** | Bridle legs slack, folded against daughter body. Gimbal ring parked at +Y face. | Lines hidden or zero-length. Gimbal ring visible but tight to body. |
| **LAUNCHING** (0–0.35s) | Spring pushes daughter directly (aft pusher plate). Tether + bridle slack. | Lines hidden. Gimbal ring moves with body. |
| **SLACK** (0.35–0.65s) | Daughter traveling outward, using up ~0.3m slack. | Lines hidden or very short/curved. |
| **TAUT** (post 0.65s) | Bridle lines snap taut. Gimbal engages. All tension through bridle chain. | Lines rendered straight, nominal color. |
| **LOADED** (high tension) | Tether strain > 0.7. Gimbal under load. | Lines change to stressed/critical color. |

---

#### 13.7.2 Material Selection Table

| Part | Material | Grade | Rationale | Color Hex | Metalness | Roughness |
|------|----------|-------|-----------|-----------|-----------|-----------|
| **Gimbal ring** | Ti-6Al-4V titanium | Grade 5, annealed | Standard aerospace bearing race material. Light (4.43 g/cm³), strong (1000 MPa yield), corrosion-immune in atomic oxygen environment. Self-lubricating MoS₂ dry-film coating for vacuum operation (no wet lubricants in LEO). | `0x8899aa` | 0.75 | 0.30 |
| **Y-fork legs** | Dyneema SK78 | 12-strand braid, 2mm ∅ | Same fiber as main tether but thinner (2mm vs 3mm main cable). White UHMWPE — visually distinct from the blue-tinted tether line. Breaking strength: 340 kg per leg (2mm braid), total system: 680 kg — within [`MAX_LOAD_PER_POINT_KG: 200`](js/core/Constants.js:361) ×2 = 400 kg working load. | `0xccccdd` | 0.10 | 0.60 |
| **Hardpoint brackets** | Machined aluminum | 6061-T6 (MIL-A-8625 Type III) | Small eyelet/cleat brackets. Same alloy and finish as rib rings (§13.2) and existing bridle hardpoints (§13.4.5). Hard-anodized for wear resistance at cable contact point. | `0x8899aa` | 0.72 | 0.28 |
| **Gimbal bearing** | MoS₂ dry-film | (coating on Ti ring) | Molybdenum disulfide (MIL-PRF-46010) — standard space mechanism dry lubricant. Coefficient of friction 0.03–0.06 in vacuum. No outgassing. | — | — | — |

---

#### 13.7.3 Gimbal Ring — Torus at Y-Junction

The gimbal ring sits at the transition point where the single tether terminates and the
two Y-fork legs begin. It is a small torus (ring shape) that the tether passes through.
The ring can rotate freely around the tether axis, preventing tether twist from
transmitting to the daughter body.

##### Geometry

The gimbal ring is a `TorusGeometry` — the most natural Three.js primitive for a ring.

| Parameter | Weaver | Spinner | Derivation |
|-----------|--------|---------|------------|
| Ring major radius `R` | 15mm | 10mm | ~7.5% of body width. Large enough to be visible at 15m camera distance. |
| Tube cross-section radius `r` | 3mm | 2mm | R/r = 5:1 — reads as a ring, not a donut |
| Radial segments | 8 | 8 | Minimum for smooth torus appearance |
| Tubular segments | 6 | 6 | Low-poly aesthetic matching 6-segment hex body |
| **Triangles** | **96** | **96** | 8 × 6 × 2 = 96 |

##### Position and Orientation

When the daughter is deployed and the tether is taut, the gimbal ring floats between
the daughter body and the strut tip. Rather than computing a free-floating world-space
position each frame, the gimbal ring is **parented to the daughter mesh group** at a
fixed offset above the body's +Y face (the face toward the tether when docked). During
gameplay, this means the ring moves with the daughter body, which is correct — the ring
is attached to the bridle legs, which are attached to the daughter.

```javascript
// Position in daughter mesh local space:
const gimbalY = by * 0.70 * M;  // 70% above body center — clears ROSA pivot
const gimbalRingPos = new THREE.Vector3(0, gimbalY, 0);

// Ring lies in the XZ plane (normal along Y — tether direction when docked)
// rotation.x = Math.PI / 2 aligns torus plane with XZ
```

| Parameter | Weaver | Spinner | Notes |
|-----------|--------|---------|-------|
| Y offset from center | +70mm | +35mm | `by * 0.70` — above body, clears ROSA top pivot at `by * 0.50` |
| Ring normal direction | +Y (local) | +Y (local) | Aligned with tether direction |

##### Gimbal Freedom and Visual Rotation

In the full spec, the gimbal ring would rotate based on `atan2(tetherDir.x, tetherDir.z)`
to orient its normal toward the tether. For the sprint build, the ring is **static** —
fixed orientation relative to daughter body. The ring shape inherently communicates
"swivel joint" without needing animation.

**Future upgrade**: In [`_updateBridle()`](js/entities/ArmUnit.js:3148), compute tether
direction in daughter-local space and `slerp` the ring quaternion toward the tether vector.
This would visually show the gimbal tracking the tether angle as the daughter rotates.

##### Code

```javascript
// --- S3.6: Gimbal ring (torus at Y-junction) ---
const gimbalR = (isWeaver ? 0.015 : 0.010) * M;   // major radius
const gimbalTubeR = (isWeaver ? 0.003 : 0.002) * M; // tube radius
const gimbalGeo = new THREE.TorusGeometry(gimbalR, gimbalTubeR, 8, 6);
const gimbalMat = new THREE.MeshStandardMaterial({
  color: 0x8899aa,    // Ti-6Al-4V titanium
  metalness: 0.75,
  roughness: 0.30,
});
const gimbalRing = new THREE.Mesh(gimbalGeo, gimbalMat);
gimbalRing.position.set(0, by * 0.70 * M, 0);
gimbalRing.rotation.x = Math.PI / 2;   // ring plane in XZ (normal = +Y)
gimbalRing.name = `${this.id}-gimbal-ring`;
this.mesh.add(gimbalRing);
this._gimbalRing = gimbalRing;  // store for future gimbal rotation animation
```

| **Triangles** | **96** |
|----------|-------|

---

#### 13.7.4 Y-Fork Legs — Wishbone Dyneema Lines

Two Dyneema lines run from the gimbal ring down to the ±X hardpoints on the daughter
hex body. These are the "arms" of the wishbone. They spread laterally to route completely
outside the aft FEEP plume cone (15° half-angle from −Z axis).

##### Geometry Choice: `THREE.Line` (BufferGeometry)

The Y-fork legs are rendered as `THREE.Line` with `LineBasicMaterial` — the same
technology as the existing tether line. Each leg is a 2-point line (start → end).

**Why not `TubeGeometry`?** The 2mm Dyneema braid is sub-pixel at all gameplay camera
distances (15–50m). A `TubeGeometry` would waste triangles on invisible cross-section
detail. A 1px `THREE.Line` is the correct visual for a thin cable at these distances. If
future inspection camera (§14.2) requires visible cable thickness, upgrade to
`Line2`/`LineMaterial` for screen-space-width lines (same path as tether upgrade, §14.4).

**Why not reuse the tether `LineDashedMaterial`?** The Y-fork legs are Dyneema braid (white),
visually distinct from the main tether (blue-white dashed). Solid white lines vs dashed
blue tether communicates "this is a different cable system." The color difference also
helps players distinguish the short bridle from the long tether at a glance.

##### Leg Endpoints

Each leg runs from the gimbal ring center to a hardpoint bracket position:

| Endpoint | Weaver Position (local) | Spinner Position (local) |
|----------|------------------------|--------------------------|
| **Start** (gimbal ring) | (0, +by×0.70, 0) × M = (0, +0.14, 0) mm | (0, +0.035, 0) mm |
| **End A** (+X hardpoint) | (+bx×0.45, +by×0.30, 0) × M | same ratios |
| **End B** (−X hardpoint) | (−bx×0.45, +by×0.30, 0) × M | same ratios |

**Leg length** (computed):
- Weaver: √((0.09)² + (0.08)²) = √(0.0081 + 0.0064) = √0.0145 ≈ 0.120m = **120mm**
- Spinner: √((0.045)² + (0.04)²) ≈ 0.060m = **60mm**

**Y-fork half-angle**: `atan2(bx×0.45, by×0.40)` ≈ `atan2(0.09, 0.08)` ≈ **48°**
Total fork angle ≈ **96°** — a wide V that reads clearly as "wishbone" at game distances.

##### FEEP Plume Exclusion Verification

```
  Top view (looking down +Y axis):

         +Z (forward)
            │
            │    Fore FEEP
     ┌──────┼──────────┐
     │      │          │
  +X ━━━━━━━╋━━━━━━━━━━━━━━ −X
     │      │          │
     │      │   HEX    │
     │  ◯───┼───◯      │    ← Hardpoints at ±X × 0.45
     │  ╲   │   ╱      │      (on lateral hex flats)
     │   ╲  │  ╱       │
     │    Gimbal       │
     └──────┼──────────┘
            │
         −Z (aft)
            │
           ╱│╲
          ╱ │ ╲  ← Aft FEEP plume cone (15° half-angle)
         ╱  │  ╲
        ╱   │   ╲   Both hardpoints at ±X = ±90° from −Z axis
                     → FULLY OUTSIDE plume cone
```

The hardpoint brackets sit at ±X on the hex body (at ±90° from the −Z thrust axis). The
FEEP plume half-angle is 15°. Angular clearance: 90° − 15° = **75°** — massive margin.
Even with ±15° thrust vectoring, the worst-case plume boundary reaches only 30° from −Z,
still 60° clear of the hardpoints.

##### Material and Visual State

```javascript
// --- S3.6: Y-fork leg material ---
const bridleLegMat = new THREE.LineBasicMaterial({
  color: 0xccccdd,      // white Dyneema — distinct from blue tether
  transparent: true,
  opacity: 0.85,
});
```

**Visual state integration** — the leg material color/opacity changes based on tether
strain (from [`_updateTether()`](js/entities/ArmUnit.js:3148)):

| State | strain | Color | Opacity | Visual Cue |
|-------|--------|-------|---------|------------|
| **Hidden** (docked) | N/A | — | 0 | Lines not rendered |
| **Slack** (just launched) | 0 | `0xccccdd` | 0.4 | Faint, barely visible |
| **Nominal** (normal ops) | 0–0.7 | `0xccccdd` | 0.85 | Bright white |
| **Stressed** (approaching limit) | 0.7–0.9 | `0xffaa44` | 0.95 | Amber warning |
| **Critical** (near breaking) | 0.9–1.0 | `0xff4444` | 1.0 | Red alert |

These thresholds match the existing tether color scheme
([`TETHER_COLOR_NOMINAL`](js/core/Constants.js), `STRESSED`, `CRITICAL`) so the bridle
and tether flash red/amber at the same time — consistent visual language.

##### Code

```javascript
// --- S3.6: Y-fork bridle legs (2× Line from gimbal ring to hardpoints) ---
const bridleLegMat = new THREE.LineBasicMaterial({
  color: 0xccccdd, transparent: true, opacity: 0.85,
});

// Leg A: gimbal ring → +X hardpoint
const legAGeo = new THREE.BufferGeometry();
const legAPositions = new Float32Array([
  0, by * 0.70 * M, 0,                           // gimbal ring center
  bx * 0.45 * M, by * 0.30 * M, 0,              // +X hardpoint
]);
legAGeo.setAttribute('position', new THREE.BufferAttribute(legAPositions, 3));
const legA = new THREE.Line(legAGeo, bridleLegMat);
legA.name = `${this.id}-bridle-leg-A`;
legA.visible = false;  // hidden when docked
this.mesh.add(legA);

// Leg B: gimbal ring → −X hardpoint
const legBGeo = new THREE.BufferGeometry();
const legBPositions = new Float32Array([
  0, by * 0.70 * M, 0,                           // gimbal ring center
  -bx * 0.45 * M, by * 0.30 * M, 0,             // −X hardpoint
]);
legBGeo.setAttribute('position', new THREE.BufferAttribute(legBPositions, 3));
const legB = new THREE.Line(legBGeo, bridleLegMat);
legB.name = `${this.id}-bridle-leg-B`;
legB.visible = false;  // hidden when docked
this.mesh.add(legB);

// Store references for dynamic updates
this._bridleLegA = legA;
this._bridleLegB = legB;
this._bridleLegMat = bridleLegMat;
```

| **Triangles (2 legs)** | **0** (line geometry = zero triangles) |
|----------|-------|

---

#### 13.7.5 Bridle-to-Daughter Hardpoints (2× Eyelet Brackets)

Two small eyelet brackets on the daughter hex body's ±X lateral faces provide the
attachment points for the Y-fork legs. These replace the 3× tripod hardpoints from
§13.4.5 — that section now becomes a **forward reference** to these 2 wishbone hardpoints.

##### Position — Lateral Hex Flats, Upper Region

The hex body (§13.5.3) has flat faces at ±Y (top/bottom), ±X (lateral), and two angled
faces. The hardpoints sit on the ±X flat faces, in the upper-forward region:

| Parameter | Weaver | Spinner | Derivation |
|-----------|--------|---------|------------|
| X offset | ±bx×0.45 = ±90mm | ±45mm | Near hex edge, on ±X flat face |
| Y offset | +by×0.30 = +60mm | +30mm | Upper region (above center, below ROSA root) |
| Z offset | 0mm | 0mm | Body center along Z (balanced fore/aft) |

**Why ±X, not ±Y?** The ±Y faces are occupied: +Y has PV panel + ROSA wing pivots,
−Y has EPM docking collar. The ±X hex flats have only the solar cell patches (§13.5.6,
deferred) and ample clear surface for small brackets. ±X also provides the maximum
lateral spread for the Y-fork, outside the −Z plume cone.

**Why Y = +0.30 (not +0.48)?** Moving the hardpoints down from near the +Y edge to +Y×0.30
creates a steeper Y-fork angle — the legs approach the body at ~48° from vertical instead
of nearly horizontal. This:
1. Reduces lateral force component when tether pulls along +Y
2. Provides more mechanical advantage for anti-spin torque
3. Creates a clearer visual "V" shape that reads as bridle at distance

##### Geometry

Small sphere markers (same as §13.4.5 but only 2, repositioned):

```javascript
// --- S3.6: Bridle hardpoint brackets (2× at ±X, replaces 3× tripod from §13.4.5) ---
const hpGeo = new THREE.SphereGeometry(M * 0.005, 4, 4);  // ∅10mm sphere
const hpMat = new THREE.MeshStandardMaterial({
  color: 0x8899aa, metalness: 0.72, roughness: 0.28,  // anodized aluminum
});

// +X hardpoint
const hpA = new THREE.Mesh(hpGeo, hpMat);
hpA.position.set(bx * 0.45 * M, by * 0.30 * M, 0);
hpA.name = `${this.id}-bridle-hp-A`;
this.mesh.add(hpA);

// −X hardpoint
const hpB = new THREE.Mesh(hpGeo, hpMat);
hpB.position.set(-bx * 0.45 * M, by * 0.30 * M, 0);
hpB.name = `${this.id}-bridle-hp-B`;
this.mesh.add(hpB);

// Store references for dynamic line updates
this._bridleHpA = hpA;
this._bridleHpB = hpB;
```

| **Triangles (2 hardpoints)** | **32** (16 per `SphereGeometry(4, 4)`) |
|----------|-------|

---

#### 13.7.6 Visual States — Bridle Appearance per Game Phase

The bridle visual tracks the arm state machine and tether strain. All state transitions
use the existing [`_updateTether()`](js/entities/ArmUnit.js:3148) strain value — no new
state detection logic needed.

##### State Table

| Arm State | Bridle Lines | Gimbal Ring | Hardpoints | Rationale |
|-----------|-------------|-------------|------------|-----------|
| `DOCKED` | `visible: false` | `visible: true` (dim) | `visible: true` | Lines hidden — slack bridle folded against body. Ring/hardpoints visible as static hardware. |
| `LAUNCHING` | `visible: false` | `visible: true` | `visible: true` | Spring pushing daughter — bridle still slack. |
| `TRANSIT` (early, <0.3m) | `visible: false` | `visible: true` | `visible: true` | Using up slack — no tension yet. |
| `TRANSIT` (taut) | `visible: true`, nominal color | `visible: true` | `visible: true` | Bridle engaged. Lines straight. |
| `APPROACH` | `visible: true`, nominal color | `visible: true` | `visible: true` | Tether paying out, bridle under nominal load. |
| `NETTING` / `GRAPPLED` | `visible: true`, strain-colored | `visible: true` | `visible: true` | May enter stressed/critical under capture loads. |
| `REELING` | `visible: true`, strain-colored | `visible: true` | `visible: true` | Reel-in tension — highest load phase. |
| `DOCKING` | `visible: true` → fade | `visible: true` | `visible: true` | Bridle goes slack as daughter approaches strut tip. |
| `EXPENDED` | `visible: true`, opacity 0.2 | `visible: true` | `visible: true` | Dimmed to match tether expended visual. |

##### Color Transition Code

```javascript
// Inside _updateBridle(dt, strain) — called from update() after _updateTether():
_updateBridle(dt, strain) {
  const isDocked = this.state === S.DOCKED || this.state === S.RELOADING;
  const isDetached = this.isDetached;

  // Hide bridle lines when docked or detached
  const showLines = !isDocked && !isDetached && this.tetherLine.visible;
  this._bridleLegA.visible = showLines;
  this._bridleLegB.visible = showLines;

  if (!showLines) return;

  // Match tether strain colors (same thresholds as _updateTether)
  const mat = this._bridleLegMat;
  if (strain > 0.9) {
    mat.color.setHex(0xff4444);   // critical red
    mat.opacity = 1.0;
  } else if (strain > 0.7) {
    mat.color.setHex(0xffaa44);   // stressed amber
    mat.opacity = 0.95;
  } else {
    mat.color.setHex(0xccccdd);   // nominal white
    mat.opacity = 0.85;
  }
}
```

**No separate bridle states needed**: The bridle visual is purely driven by the existing
tether strain value + arm state machine. No new state enums, no new event bus events.

---

#### 13.7.7 Integration with Existing [`BridleRing.js`](js/entities/BridleRing.js:1)

[`BridleRing.js`](js/entities/BridleRing.js:1) is a **pure data module** — it tracks
attach points, load distribution, balance factor, and overload detection. It has NO
visual geometry. S3.6 does not modify `BridleRing.js`.

##### What Stays the Same

| Aspect | Status | Notes |
|--------|--------|-------|
| [`BridleRing.create(armIndex, numAttachPoints)`](js/entities/BridleRing.js:85) | **Unchanged** | Still creates 3 attach points per ring |
| [`computeLoadBalance(points)`](js/entities/BridleRing.js:57) | **Unchanged** | σ/μ balance factor calculation |
| [`BRIDLE_STATES`](js/core/Constants.js:456) (IDLE, ATTACHED, OVERLOADED, DAMAGED) | **Unchanged** | Visual bridle doesn't read these — uses tether strain instead |
| [`ATTACH_POINTS_PER_RING: 3`](js/core/Constants.js:360) | **Unchanged** | Data model supports 3 for flexibility |
| [`attach()`](js/entities/BridleRing.js:108) / [`detach()`](js/entities/BridleRing.js:143) | **Unchanged** | Payload attachment API |
| [`getStatus()`](js/entities/BridleRing.js:173) / [`checkOverload()`](js/entities/BridleRing.js:208) | **Unchanged** | Load monitoring API |
| [`FEATURE_FLAGS.BRIDLE_RING`](js/core/Constants.js:413) | **Unchanged** | Gates data module (not visuals) |

##### Relationship Between Data Module and Visual

```
  BridleRing.js (data layer)          ArmUnit.js (visual layer, S3.6)
  ┌─────────────────────────┐         ┌──────────────────────────────┐
  │ 3 attach points (data)  │         │ 2 hardpoint meshes (visual)  │
  │ Load per point (kg)     │         │ 2 Y-fork lines (visual)      │
  │ Balance factor (0–1)    │         │ 1 gimbal ring torus (visual) │
  │ State: IDLE/ATTACHED/…  │         │ Color driven by tether strain │
  │                         │         │                              │
  │ No visual geometry      │    ──→  │ strain-colored bridle lines  │
  │ Gated by BRIDLE_RING    │         │ Always rendered (no gate)    │
  └─────────────────────────┘         └──────────────────────────────┘

  Future integration hook: When BRIDLE_RING flag is ON, _updateBridle()
  could ALSO read BridleRing.getStatus().loadBalanceFactor and
  skew leg opacity (heavier-loaded leg brighter) for load visualization.
```

**Why not gate the visual behind `BRIDLE_RING` flag?** The visual bridle is a purely
cosmetic upgrade — it has no gameplay effect. Feature flags gate *gameplay mechanics*
(load distribution, overload detection). The visual exists to make the mechanical design
readable to the player. This matches S3.1–S3.5 pattern: visual upgrades are not
feature-flagged.

---

#### 13.7.8 Integration with [`ArmUnit.js`](js/entities/ArmUnit.js:1) (S3.5 Hex Body)

##### Where Bridle Visual Code Lives

All bridle visual geometry is created inside
[`ArmUnit._createMesh()`](js/entities/ArmUnit.js:280), appended after the existing S3.5
components. All dynamic updates go in a new `_updateBridle(dt, strain)` private method
called from the main [`update()`](js/entities/ArmUnit.js:1838) method.

##### New Instance Properties

```javascript
// Added to ArmUnit constructor / _createMesh():
this._gimbalRing = null;        // THREE.Mesh (TorusGeometry)
this._bridleLegA = null;        // THREE.Line (gimbal ring → +X hardpoint)
this._bridleLegB = null;        // THREE.Line (gimbal ring → −X hardpoint)
this._bridleLegMat = null;      // THREE.LineBasicMaterial (shared, color-animated)
this._bridleHpA = null;         // THREE.Mesh (SphereGeometry, +X bracket)
this._bridleHpB = null;         // THREE.Mesh (SphereGeometry, −X bracket)
```

##### Tether-to-Bridle Visual Transition

Currently, [`_updateTether()`](js/entities/ArmUnit.js:3148) draws a line from strut tip
(`anchorPos`) to arm position (`this.position`). With the bridle, the visual chain is:

```
  strut tip ──── tether line ────── arm.position (≈ gimbal ring world pos)
                                         │
                                    ╱────┴────╲
                                   ╱           ╲
                                  ◯ hardpoint A  ◯ hardpoint B
```

The existing tether line endpoint (`this.position`) is the arm group origin, which is
near the gimbal ring's world position. The bridle legs are children of `this.mesh`
(parented to `this.group`), so they automatically transform to the correct world position.

**No change to `_updateTether()` tether endpoint** — the tether still terminates at
`this.position` (daughter group center). The gimbal ring is at a slight +Y offset from
group center, but at tether lengths of 10–2000m, this 70mm offset is sub-pixel and
indistinguishable from the group center. The visual transition from tether to bridle
lines is seamless.

##### Dynamic Line Update (Full Spec, Deferred)

For future gimbal rotation animation, the Y-fork leg start points would need to update
each frame based on gimbal ring orientation:

```javascript
// FUTURE — Dynamic gimbal rotation:
_updateBridleGeometry(tetherDirLocal) {
  // Rotate gimbal ring to face tether direction
  const targetQuat = new THREE.Quaternion();
  targetQuat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tetherDirLocal);
  this._gimbalRing.quaternion.slerp(targetQuat, 0.1);

  // Update leg start points to match rotated gimbal ring center
  const ringWorldPos = new THREE.Vector3();
  this._gimbalRing.getWorldPosition(ringWorldPos);
  // ... update BufferGeometry positions
}
```

For the sprint build, **static geometry is correct** — lines don't move relative to the
daughter body. The gimbal ring's ability to rotate is communicated by its shape (torus),
not by animation.

---

#### 13.7.9 Assembly Diagrams

##### Weaver — Front View (Looking Along −Z, Toward Aft)

```
                    Tether from strut
                         │
                    ╔════╧════╗
                    ║ GIMBAL  ║  ← Ti-6Al-4V torus, ∅30mm
                    ║  RING   ║    MoS₂ dry-film bearing
                    ╚════╤════╝
                    ╱────┴────╲
                   ╱           ╲      ← 2× Dyneema SK78 legs
                  ╱             ╲       2mm braid, white
                 ╱               ╲
         ◯──────╱──  HEX BODY  ──╲──────◯
         │     ╱    (top view)    ╲     │    ← 2× Hardpoint brackets
     +X  │    ╱                    ╲    │ −X   Al 6061-T6, ∅10mm sphere
   face  │   ╱   +Y (PV panel)     ╲   │ face
         │  ╱   ROSA ──── ROSA       ╲ │
         │ ╱        wings ±Y          ╲│
         ├╱─────────────────────────────╲┤
         │  Solar    ┌──┐     Solar     │
         │  Cell     │  │     Cell      │    ← GaAs patches on ±X flats
         │  (+X)     │  │     (−X)      │
         │           │  │               │
         └───────────┼──┼───────────────┘
                     │  │
                   EPM Collar                ← S3.4, −Y face (dock)
```

##### Weaver — Side View (Looking Along +X, From Starboard)

```
         +Y (top)
          │
          │   ┌─ PV Panel ─┐
          │   │             │
    ──────┤───┴─────────────┴───────────┤──────
   ROSA   │                             │   ROSA
   wing   │         HEX BODY            │   wing
    ──────┤─────────────────────────────┤──────
          │                             │
          │     EPM Collar (−Y)         │
          └─────────────────────────────┘
          │
         −Y
               +Z ◄──────────────────► −Z
            (forward)                  (aft)
                                         │
                             Gimbal      │
                              ring ◎     │
                             ╱    ╲      │
              Hardpoint ◯───╱      ╲───◯ Hardpoint
              (+X, not      │       (−X, not
               visible      │       visible from
               from +X)     │       this angle)
                             │
                          Aft FEEP
                          nozzle ─┐
                                  │  ← plume exits −Z
                                ╱╱╱
                              ╱╱╱ plume cone
                            ╱╱╱   (15° half-angle)

  Y-fork legs attach at ±X — perpendicular to this view.
  Legs and hardpoints NOT in plume path.
```

##### Weaver — Top View (Looking Down +Y, Updated from §13.5.11)

```
                       +Z (forward)
                           │
                ┌──────────┼──────────┐
               ╱  Net canister (cyl)   ╲
              ╱            │            ╲
       ╔═════╬═════════════╪═════════════╬═════╗
       ║Solar│             │             │Solar║
       ║Cell ╱─────────────┼─────────────╲Cell ║
       ║ ◯──╱──────────────┼──────────────╲──◯ ║  ← Hardpoints at ±X×0.45
       ║  ╲╱     Y-fork    │    Y-fork     ╲╱  ║    Y-fork legs visible
       ║   ╲    leg(+X)    ◎     leg(−X)   ╱   ║    ◎ = gimbal ring center
       ╚════╲══════════════╪═══════╤══════╱════╝
             ╲   MLI gold  │  MRR ─┘    ╱
              ╲    band    │           ╱
               ╲───────────┼──────────╱
                ╲          ┼    [F] ╱     ← Fore FEEP nozzle
                 ╲    ─── ─┼── [A]╱      ← Aft FEEP nozzle (−Z center)
                  └────────┼──────┘
                           │
                        −Z (aft)
                           │
                          ╱│╲
                         ╱ │ ╲    ← 15° half-angle plume cone
                        ╱  │  ╲     Y-fork legs at ±90° = CLEAR
```

---

#### 13.7.10 Polygon Budget (Full Spec)

##### Per-Component Triangle Count

| # | Component | Geometry | Segs | Tris | Status |
|---|-----------|----------|------|------|--------|
| 1 | Gimbal ring torus | `TorusGeometry(gimbalR, gimbalTubeR, 8, 6)` | 8×6 | 96 | NEW |
| 2 | Y-fork leg A | `BufferGeometry` (2-point line) | — | 0 | NEW |
| 3 | Y-fork leg B | `BufferGeometry` (2-point line) | — | 0 | NEW |
| 4 | Hardpoint bracket A | `SphereGeometry(0.005*M, 4, 4)` | 4×4 | 16 | NEW |
| 5 | Hardpoint bracket B | `SphereGeometry(0.005*M, 4, 4)` | 4×4 | 16 | NEW |
| | **Total per arm** | | | **128** | |

##### System Budget

| Metric | Value |
|--------|-------|
| **Per-arm bridle assembly** | 128 tris |
| **Budget ceiling** | ≤200 tris per arm |
| **Budget utilization** | **64%** (72 tris headroom per arm) |
| **×4 arms (Y0 Quad)** | **512 tris total** |
| **System budget** | ≤800 tris |
| **System utilization** | **64%** (288 tris headroom) |
| **Draw calls per arm** | +4 new (1 torus, 2 lines, implicit: lines share material) |
| **Materials per arm** | +2 new (gimbalMat, bridleLegMat) |

**Within budget**: 128 tris per arm is well under the 200-tri ceiling, leaving 72 tris
of headroom per arm for future polish (e.g., eyelet shape upgrade from sphere to torus
bracket, gimbal rotation indicator ring).

---

#### 13.7.11 Color Palette Reference

| Component | Hex Code | RGB | Metalness | Roughness | Visual Description |
|-----------|----------|-----|-----------|-----------|-------------------|
| Gimbal ring | `0x8899aa` | 136, 153, 170 | 0.75 | 0.30 | Titanium — warm bluish-gray, brushed finish |
| Y-fork legs (nominal) | `0xccccdd` | 204, 204, 221 | — | — | White Dyneema braid — bright against dark space |
| Y-fork legs (stressed) | `0xffaa44` | 255, 170, 68 | — | — | Amber warning — matches tether stress color |
| Y-fork legs (critical) | `0xff4444` | 255, 68, 68 | — | — | Red alert — matches tether critical color |
| Hardpoint brackets | `0x8899aa` | 136, 153, 170 | 0.72 | 0.28 | Anodized aluminum — matches rib rings (§13.2) |

---

#### 13.7.12 Implementation Notes

##### Shared Geometries

Following the pattern from §13.5.14, create shared geometries once at module level:

```javascript
// Module-level shared geometry cache (populated on first ArmUnit construction):
let _sharedBridleGeo = null;

function _ensureSharedBridleGeo() {
  if (_sharedBridleGeo) return _sharedBridleGeo;
  _sharedBridleGeo = {
    gimbalW: new THREE.TorusGeometry(0.015 * M, 0.003 * M, 8, 6),
    gimbalS: new THREE.TorusGeometry(0.010 * M, 0.002 * M, 8, 6),
    hpSphere: new THREE.SphereGeometry(0.005 * M, 4, 4),
  };
  return _sharedBridleGeo;
}
```

Two torus geometries (Weaver/Spinner) + one hardpoint sphere, shared across all 4–8 arms.

##### File Touch List

| File | Changes | LOC Estimate |
|------|---------|-------------|
| [`ArmUnit.js`](js/entities/ArmUnit.js) `_createMesh()` | Add gimbal ring, 2× hardpoints, 2× Y-fork legs | ~35 LOC |
| [`ArmUnit.js`](js/entities/ArmUnit.js) `_updateBridle()` | New method — visibility + color animation | ~20 LOC |
| [`ArmUnit.js`](js/entities/ArmUnit.js) `update()` | Call `_updateBridle(dt, strain)` after `_updateTether()` | ~2 LOC |
| [`ArmUnit.js`](js/entities/ArmUnit.js) module-level | `_ensureSharedBridleGeo()` cache | ~12 LOC |
| **Total** | | **~69 LOC** |

**No new files.** No Constants.js changes. No BridleRing.js changes. No test changes
(existing [`test-BridleRing.js`](js/test/test-BridleRing.js) tests the data module, not
visuals).

##### Render Order Considerations

The bridle lines render on TOP of the daughter body (same draw order as tether line).
`LineBasicMaterial` is unlit — the white Dyneema lines remain visible even when the body
is in Earth shadow, matching real-world bright Dyneema braids catching earthshine.

---

#### 13.7.13 Sprint Build Simplifications — What to Actually Implement

The full spec (§13.7.1–§13.7.12) documents complete engineering design. Sprint
simplifications reduce code complexity with negligible visual impact at game distances:

##### Simplification Analysis

| Component | Full Spec | Simplified | Why | Tri Impact |
|-----------|-----------|------------|-----|------------|
| **Gimbal ring torus** | `TorusGeometry(8, 6)` = 96 tris | **SIMPLIFY to (6, 4)** = 48 tris | At 15–50m camera distance, 48-tri torus is indistinguishable from 96-tri. 6 radial × 4 tubular is minimum for recognizable torus shape. Saves 48 tris/arm = 192 tris system. | −48 tris |
| **Gimbal rotation** | `slerp` toward tether direction each frame | **DROP** — static orientation | Ring shape communicates "swivel joint" without animation. Add rotation when inspection camera can see it. | 0, −15 LOC |
| **Y-fork legs (2× Line)** | `THREE.Line` + `LineBasicMaterial` | **KEEP** | These ARE the bridle. Without them, there's nothing connecting tether to daughter. Zero tri cost. | 0 |
| **Hardpoint brackets** | 2× `SphereGeometry(4, 4)` = 32 tris | **KEEP** | Cheap (32 tris total), mark where legs terminate on body. Without them, legs end in mid-air. | 0 |
| **Strain color animation** | 3-tier color matching tether | **SIMPLIFY to 2-tier** | Drop the intermediate "stressed amber" tier. Just nominal white + critical red. Simpler branch, same game-feel. | 0, −4 LOC |
| **Dynamic line update** | BufferGeometry attribute update per frame | **DROP** — static lines | Lines are fixed in daughter-local space. Only visibility toggles. Add dynamic endpoints when gimbal rotation is implemented. | 0, −20 LOC |
| **Shared geometry cache** | Module-level `_ensureSharedBridleGeo()` | **KEEP** | 2 torus + 1 sphere shared across all arms. Essential for 8-arm (Y3 Octo). | 0, +12 LOC |
| **`_updateBridle()` method** | Full state table with all arm states | **SIMPLIFY** — visibility only | Show when `tetherLine.visible`, hide when docked/detached. Color matches tether material directly. ~8 LOC. | 0, −12 LOC |

##### What Gets Built (Final Sprint Spec)

**Bridle assembly = 5 children added to `this.mesh`:**

| Index | Child | Geometry | Tris |
|-------|-------|----------|------|
| 0 | Gimbal ring torus | `TorusGeometry(gimbalR, gimbalTubeR, 6, 4)` | 48 |
| 1 | Y-fork leg A (+X) | `BufferGeometry` (2-point line) | 0 |
| 2 | Y-fork leg B (−X) | `BufferGeometry` (2-point line) | 0 |
| 3 | Hardpoint bracket A (+X) | `SphereGeometry(M*0.005, 4, 4)` | 16 |
| 4 | Hardpoint bracket B (−X) | `SphereGeometry(M*0.005, 4, 4)` | 16 |
| | **Total per arm** | | **80** |

##### Simplified Polygon Budget

| Metric | Full Spec | Sprint Build | Savings |
|--------|-----------|-------------|---------|
| Per arm | 128 tris | **80 tris** | −48 (−37.5%) |
| Budget ceiling | ≤200 | ≤200 | — |
| Utilization | 64% | **40%** | Massive headroom |
| ×4 arms (Y0 Quad) | 512 | **320** | −192 system tris |
| System ceiling | ≤800 | ≤800 | — |
| System utilization | 64% | **40%** | 480 tris headroom |

##### Simplified Visual State

```javascript
_updateBridle() {
  const show = this.tetherLine && this.tetherLine.visible;
  if (this._bridleLegA) this._bridleLegA.visible = show;
  if (this._bridleLegB) this._bridleLegB.visible = show;
  // Color: match tether material directly (they share the same strain logic)
  if (show && this._bridleLegMat && this.tetherMaterial) {
    this._bridleLegMat.color.copy(this.tetherMaterial.color);
    this._bridleLegMat.opacity = this.tetherMaterial.opacity;
  }
}
```

This is **8 LOC** — the bridle legs simply mirror the tether line's visibility and color.
When the tether turns red, the bridle legs turn red. When the tether is hidden (docked),
the bridle legs are hidden. Zero new state logic.

##### Sprint Implementation Task Breakdown (For Orchestrator)

**Task 1: Shared geometries** (~12 LOC, module-level in [`ArmUnit.js`](js/entities/ArmUnit.js))
- Add `_sharedBridleGeo` cache with Weaver/Spinner torus + hardpoint sphere
- Pattern: identical to existing `_ensureSharedGeo()` if present, or standalone function

**Task 2: Bridle geometry creation** (~25 LOC in [`_createMesh()`](js/entities/ArmUnit.js:280))
- Add gimbal ring torus at `(0, by*0.70, 0)` with `rotation.x = π/2`
- Add 2× hardpoint spheres at `(±bx*0.45, by*0.30, 0)`
- Add 2× `THREE.Line` from gimbal center to each hardpoint
- Set lines `visible = false` initially (docked state)
- Store all 6 references on `this._*` properties

**Task 3: Dynamic visibility** (~10 LOC, new [`_updateBridle()`](js/entities/ArmUnit.js) method)
- Toggle lines visible when `tetherLine.visible`
- Copy tether material color and opacity to bridle leg material
- Call from [`update()`](js/entities/ArmUnit.js:1838) after `_updateTether()`

**Total: ~47 LOC net.** Single file: [`ArmUnit.js`](js/entities/ArmUnit.js).

##### Deferred to Future Sprints

| Feature | Spec Section | Why Defer |
|---------|-------------|-----------|
| Gimbal rotation animation | §13.7.3 | Requires per-frame quaternion slerp. Add when inspection camera reveals gimbal detail. |
| Independent bridle strain coloring | §13.7.6 | 3-tier amber/red. Sprint uses tether color mirror (simpler). |
| Dynamic line endpoint update | §13.7.8 | Static lines in daughter-local space are adequate. Add when gimbal rotates. |
| BridleRing.js data integration | §13.7.7 | Read `loadBalanceFactor` for per-leg opacity. Add when load visualization is gameplay-relevant. |
| High-segment torus (8×6 → 96 tris) | §13.7.3 | Sprint torus (6×4 = 48 tris) is adequate at game distance. Upgrade for inspection camera. |
| Eyelet bracket (torus) replacing sphere | §13.7.5 | Sphere reads as "attachment point" at distance. Torus eyelet for close-up inspection. |

---

#### 13.7.14 Cross-Component Integration Analysis

This section documents every integration point between the S3.6 bridle visual and existing
components. Each gap is analyzed with a specific fix for the sprint build.

##### Integration Point 1: Tether Line Endpoint → Gimbal Ring Position

**Components**: [`_updateTether()`](js/entities/ArmUnit.js:3148) ↔ gimbal ring mesh

**Issue**: The tether line's final vertex (segment N-1) renders at `(0, 0, 0)` in group-local
space ([line 3270](js/entities/ArmUnit.js:3270)), which is the arm group center. The gimbal
ring sits at `(0, by×0.70×M, 0)` — a 70mm offset (Weaver) above group center. At gameplay
distances (15–50m), this 70mm gap is sub-pixel (<1.4% of separation). At ARM_PILOT view
(~0.3m behind arm), the gap becomes visible — the tether line would terminate 70mm below
the gimbal ring, creating a visual disconnect.

**Sprint fix** (~3 LOC in [`_updateTether()`](js/entities/ArmUnit.js:3270)):
```javascript
// Line 3270–3278: Shift final vertex to gimbal ring position (group-local)
// Instead of ending at (0, 0, 0), end at gimbal ring offset
const gimbalOff = this._gimbalRing
  ? { x: 0, y: this._gimbalRing.position.y, z: 0 }
  : { x: 0, y: 0, z: 0 };

for (let i = 0; i < segments; i++) {
  const t = i / (segments - 1);
  const invT = 1 - t;
  const bell = Math.sin(t * Math.PI);
  const idx = i * 3;
  // End at gimbal offset (t=1), not (0,0,0)
  posArr[idx]     = dx * invT + gimbalOff.x * t + sagX * bell * sagAmp;
  posArr[idx + 1] = dy * invT + gimbalOff.y * t + sagY * bell * sagAmp;
  posArr[idx + 2] = dz * invT + gimbalOff.z * t + sagZ * bell * sagAmp;
}
```

**Impact**: +3 LOC. Tether now terminates at the gimbal ring center. The existing
catenary sag interpolation handles the new endpoint naturally. No material or visibility
changes needed.

##### Integration Point 2: LAUNCHING State — Bridle Slack Phase

**Components**: [`_updateLaunching()`](js/entities/ArmUnit.js:2122) ↔ `_updateBridle()`

**Issue**: In `_updateLaunching()` ([line 2124](js/entities/ArmUnit.js:2124)),
`this.tetherLine.visible = true` is set immediately. The sprint `_updateBridle()` mirrors
tether visibility, so bridle lines would show during the launch sequence. But physically,
the bridle is SLACK during the first ~0.3m of separation (per §13.4.1: "After the daughter
travels ~0.3m, the bridle lines snap taut and the gimbal engages"). Showing taut bridle
lines during the slack phase is visually incorrect.

**Sprint fix** (~2 LOC in `_updateBridle()`):
```javascript
_updateBridle() {
  const show = this.tetherLine && this.tetherLine.visible;
  // Hide bridle during slack phase (first 0.3m after launch)
  const pastSlack = this.tetherLength > 0.3;  // meters
  const visible = show && pastSlack;
  if (this._bridleLegA) this._bridleLegA.visible = visible;
  if (this._bridleLegB) this._bridleLegB.visible = visible;
  // ... color mirror code
}
```

**Impact**: +2 LOC. Bridle lines hidden during first 0.3m of separation, then snap to
visible as the physical bridle would snap taut. Clean visual transition.

##### Integration Point 3: Daughter Attitude Rotation vs Gimbal Ring Orientation

**Components**: Attitude control ([line 1861](js/entities/ArmUnit.js:1861)) ↔ gimbal ring

**Issue**: When the daughter rotates to face a target (APPROACH, NETTING states), the
entire `this.group` (and thus `this.mesh`) rotates. The gimbal ring is a child of
`this.mesh`, so it rotates with the body. Physically, the gimbal ring should remain
oriented toward the tether (its purpose is to decouple daughter attitude from tether
direction). When the daughter yaws 90° to face debris, the gimbal ring should stay
pointing along the tether — but instead it rotates 90° with the body.

**Sprint acceptance**: This inaccuracy is **acceptable for sprint**. The gimbal ring's
shape (torus) communicates "swivel joint" regardless of orientation. At 15–50m camera
distance, the ring is ~3 pixels across — orientation is imperceptible. The deferred
"gimbal rotation animation" (§13.7.3) is the proper fix when inspection camera is added.

**Known limitation**: Document in code comment:
```javascript
// KNOWN: gimbal ring rotates with daughter body. Physically incorrect — should
// track tether direction. Acceptable at gameplay camera distances. Future fix:
// read tether direction in _updateBridle() and counter-rotate the ring.
```

##### Integration Point 4: §13.4.5 Hardpoint Supersession

**Components**: §13.4.5 (3× tripod hardpoints) ↔ §13.7.5 (2× wishbone hardpoints)

**Issue**: §13.4.5 specifies 3× `SphereGeometry(0.004*M, 4, 4)` hardpoints at 120°
spacing on the upper body perimeter. §13.4.12 sprint build defers them: "Add when bridle
ring (S3.6) connects lines to them". S3.6 now specifies 2× hardpoints at ±X positions
with different geometry (`SphereGeometry(0.005*M, 4, 4)` — slightly larger for visibility).

**Resolution**: §13.4.5's 3× tripod hardpoints are **superseded** by §13.7.5's 2×
wishbone hardpoints. The 3× code block in §13.4.5 MUST NOT be implemented. This is
consistent with §13.4.12's deferral and the §14.5 design change from tripod to wishbone.

**Sprint action**: No code needed — §13.4.5 hardpoints were never built (deferred).
S3.6's `_createMesh()` additions create the 2× hardpoints fresh. Add a code comment:
```javascript
// S3.6: 2× wishbone hardpoints at ±X (supersedes §13.4.5 3× tripod design)
// See §14.5 for FEEP plume exclusion rationale
```

##### Integration Point 5: Strut-Side Visual Adjacency When Docked

**Components**: [`PlayerSatellite._buildStruts()`](js/entities/PlayerSatellite.js:731) ↔
ArmUnit bridle meshes

**Flow when DOCKED**:
- [`_updateDocked()`](js/entities/ArmUnit.js:2048) sets `this.mesh.visible = false`
  ([line 2055](js/entities/ArmUnit.js:2055))
- ALL bridle children (gimbal ring, hardpoints, legs) inherit `visible = false`
- Strut-side components (reel at 85%, spring at 95%, tip collar at 100%) are always visible
- **No visual clash** — daughter mesh (including bridle) is completely hidden when docked

**Flow on LAUNCH**:
- [`_updateLaunching()`](js/entities/ArmUnit.js:2122) sets `this.mesh.visible = true`
  ([line 2123](js/entities/ArmUnit.js:2123))
- Daughter separates from strut tip at 10 m/s (crossbow spring)
- By the time bridle lines become visible (0.3m separation per Integration Point 2),
  the daughter is ~30ms post-spring-fire — at 10m/s that's 0.3m, already 6× body length
  from the strut tip
- **No overlap** between bridle visuals and strut-side components

**No changes needed.** The existing visibility gating handles this correctly.

##### Integration Point 6: Insertion Point in `_createMesh()`

**Components**: [`ArmUnit._createMesh()`](js/entities/ArmUnit.js:280) structure

**Current `_createMesh()` layout** (lines 280–515):
```
280  _createMesh() {
284    // Hex body shell (S3.5)
302    // Panel line edges (S3.5)
312    // ROSA solar wings
394    // Aft FEEP nozzle (S3.5)
421    // Fore FEEP nozzle (S3.5)
431    // Net canister
443    // Laser PV panel
455    // MRR patch antenna (S3.5)
467    // Status light
474    // EPM docking collar (S3.4)
485    // EPM pole face ring (S3.4)
501    // Aft pusher plate (S3.4)
513    // this.mesh.visible = false  ← end of _createMesh()
515  }
```

**S3.6 insertion point**: Before line 513, after all S3.4 components:
```
501    // Aft pusher plate (S3.4)
       //
       // --- S3.6: Wishbone bridle + gimbal ring ---
       // Gimbal ring torus         (line ~502+)
       // Hardpoint bracket A (+X)  (line ~510+)
       // Hardpoint bracket B (−X)  (line ~515+)
       // Y-fork leg A              (line ~520+)
       // Y-fork leg B              (line ~530+)
       // --- end S3.6 ---
       //
513    this.mesh.visible = false;
515  }
```

This keeps S3.1–S3.6 components in chronological sprint order within the method.

##### Integration Point 7: `update()` Call Site for `_updateBridle()`

**Components**: [`ArmUnit.update()`](js/entities/ArmUnit.js:1749) call chain

**Current `update()` flow** ([line 1749](js/entities/ArmUnit.js:1749)):
```
1749  update(dt, parentPos, parentQuat) {
1750    stateTimer += dt
1753    _tickHingeSettle(dt)
1756    _tickDeployState(dt)
1758    switch(state) { ... }  // state-specific updates
1850    _updateTether(parentPos, parentQuat)  ← tether visual + strain calc
1853    group.position.copy(position)
1861    // Attitude control (heading)
      }
```

`_updateBridle()` must be called AFTER `_updateTether()` because it reads
`this.tetherLine.visible` and `this.tetherMaterial.color`. Insert at line ~1852:
```javascript
1850    this._updateTether(parentPos, parentQuat);
1851    this._updateBridle();  // ← S3.6: bridle visibility + color mirror
1853    this.group.position.copy(this.position);
```

**Impact**: +1 LOC call site.

##### Integration Point 8: ArmManager — No Changes Needed

**Verification**: `grep -c 'bridle\|BridleRing\|hardpoint'` in `ArmManager.js` = **0 results**.

ArmManager iterates `this.arms[]` and calls `arm.update(dt, pos, quat)`. The bridle
visual update is fully encapsulated inside ArmUnit. No ArmManager changes needed.

##### Integration Point 9: Reset / Reload Flow

**Components**: [`ArmUnit.reset()`](js/entities/ArmUnit.js:1677) ↔ bridle state

**Current reset** ([line 1739](js/entities/ArmUnit.js:1739)):
```javascript
this.mesh.visible = false;
this.tetherLine.visible = false;
```

Bridle children (gimbal ring, hardpoints, legs) inherit `mesh.visible = false` via
Three.js group visibility propagation. The next `_updateBridle()` call will also set
`bridleLeg.visible = false` (mirrors tetherLine). **No reset code needed.**

##### Integration Point 10: TetherReel Module — CUT State

**Components**: [`TetherReel`](js/systems/TetherReel.js:1) ↔ bridle visibility

**Issue**: When `FEATURE_FLAGS.TETHER_REEL` is ON and the reel state is `CUT`
([line 3162](js/entities/ArmUnit.js:3162)), `_updateTether()` sets
`this.tetherLine.visible = false`. Since `_updateBridle()` mirrors tether visibility,
bridle lines are also hidden. This is correct — if the tether is cut, there is no
tension through the bridle, so the bridle would be slack/invisible.

**No changes needed.** CUT state correctly propagates through the existing mirror logic.

##### Integration Point 11: Existing `test-BridleRing.js`

**Components**: [`test-BridleRing.js`](js/test/test-BridleRing.js) ↔ visual changes

[`test-BridleRing.js`](js/test/test-BridleRing.js) tests the **data module** API:
`create()`, `attach()`, `detach()`, `getStatus()`, `checkOverload()`, etc. It does NOT
test Three.js geometry or visual rendering. Since S3.6 does not modify `BridleRing.js`,
**no test changes are needed**.

Future tests: Add visual regression test when inspection camera (§14.2) is implemented —
verify gimbal ring mesh exists, hardpoint count, bridle line visibility states.

---

#### 13.7.15 Complete Sprint Implementation Checklist (For Orchestrator)

This checklist integrates all sprint tasks + integration fixes from §13.7.14 into a
single ordered implementation guide. Total: **~56 LOC** in **1 file**.

##### Pre-Conditions
- [x] S3.5 hex body shell merged ([`ArmUnit._createMesh()`](js/entities/ArmUnit.js:280))
- [x] S3.4 EPM collar + pusher plate merged
- [x] S3.3 reel cartridge on struts merged
- [x] §13.4.5 tripod hardpoints NOT implemented (deferred in §13.4.12) — confirmed clean

##### Task 1: Shared Geometry Cache (~12 LOC)
**File**: [`ArmUnit.js`](js/entities/ArmUnit.js), module level (before class)
```javascript
let _sharedBridleGeo = null;
function _ensureSharedBridleGeo() {
  if (_sharedBridleGeo) return _sharedBridleGeo;
  _sharedBridleGeo = {
    gimbalW: new THREE.TorusGeometry(0.015 * M, 0.003 * M, 6, 4),   // Weaver
    gimbalS: new THREE.TorusGeometry(0.010 * M, 0.002 * M, 6, 4),   // Spinner
    hpSphere: new THREE.SphereGeometry(0.005 * M, 4, 4),
  };
  return _sharedBridleGeo;
}
```
**Verify**: Shared geometries initialized once, reused across all 4–8 arms.

##### Task 2: Bridle Geometry in `_createMesh()` (~25 LOC)
**File**: [`ArmUnit.js`](js/entities/ArmUnit.js), inside `_createMesh()` after
[line 511](js/entities/ArmUnit.js:511) (aft pusher plate), before
[line 513](js/entities/ArmUnit.js:513) (`this.mesh.visible = false`)

Add in order:
1. **Gimbal ring torus** at `(0, by*0.70*M, 0)`, `rotation.x = π/2`
   - Use `_sharedBridleGeo.gimbalW` or `.gimbalS` based on `isWeaver`
   - Material: `0x8899aa`, metalness 0.75, roughness 0.30
   - Store `this._gimbalRing`
2. **Hardpoint A** (+X) at `(bx*0.45*M, by*0.30*M, 0)`
   - Use `_sharedBridleGeo.hpSphere`
   - Material: `0x8899aa`, metalness 0.72, roughness 0.28
   - Store `this._bridleHpA`
3. **Hardpoint B** (−X) at `(-bx*0.45*M, by*0.30*M, 0)`
   - Same geo/mat as Hardpoint A
   - Store `this._bridleHpB`
4. **Y-fork leg A** — `THREE.Line` from gimbal center `(0, by*0.70*M, 0)` to
   hardpoint A `(bx*0.45*M, by*0.30*M, 0)`
   - Material: `new THREE.LineBasicMaterial({ color: 0xccccdd, transparent: true, opacity: 0.85 })`
   - `visible = false` (initial docked state)
   - Store `this._bridleLegA`, `this._bridleLegMat`
5. **Y-fork leg B** — `THREE.Line` from gimbal center to hardpoint B
   - Share `this._bridleLegMat`
   - `visible = false`
   - Store `this._bridleLegB`

**Comment**: `// S3.6: 2× wishbone hardpoints at ±X (supersedes §13.4.5 3× tripod)`

##### Task 3: `_updateBridle()` Method (~12 LOC)
**File**: [`ArmUnit.js`](js/entities/ArmUnit.js), new private method

```javascript
/** @private S3.6: Update bridle visibility + color to mirror tether state */
_updateBridle() {
  if (!this._bridleLegA) return;
  const show = this.tetherLine && this.tetherLine.visible;
  // Hide during slack phase (first 0.3m post-launch, per §13.4.1)
  const pastSlack = this.tetherLength > 0.3;
  const visible = show && pastSlack;
  this._bridleLegA.visible = visible;
  this._bridleLegB.visible = visible;
  // Color: mirror tether material (same strain logic drives both)
  if (visible && this._bridleLegMat && this.tetherMaterial) {
    this._bridleLegMat.color.copy(this.tetherMaterial.color);
    this._bridleLegMat.opacity = this.tetherMaterial.opacity;
  }
  // KNOWN: gimbal ring rotates with daughter body (physically should track
  // tether direction). Acceptable at gameplay distances. Future: §13.7.3.
}
```

##### Task 4: Call Site in `update()` (~1 LOC)
**File**: [`ArmUnit.js`](js/entities/ArmUnit.js), [line ~1851](js/entities/ArmUnit.js:1851)
```javascript
this._updateTether(parentPos, parentQuat);
this._updateBridle();  // S3.6 — after tether, before group.position.copy
```

##### Task 5: Tether Endpoint Fix (~3 LOC)
**File**: [`ArmUnit.js`](js/entities/ArmUnit.js), [line ~3270](js/entities/ArmUnit.js:3270)

Adjust the tether line interpolation to end at gimbal ring position:
```javascript
// S3.6: tether endpoint at gimbal ring, not group center
const endY = this._gimbalRing ? this._gimbalRing.position.y : 0;
// ... in the segment loop:
posArr[idx]     = dx * invT + 0 * t + sagX * bell * sagAmp;
posArr[idx + 1] = dy * invT + endY * t + sagY * bell * sagAmp;
posArr[idx + 2] = dz * invT + 0 * t + sagZ * bell * sagAmp;
```

##### Task 6: Constructor Init (~6 LOC)
**File**: [`ArmUnit.js`](js/entities/ArmUnit.js), constructor (after [line 267](js/entities/ArmUnit.js:267))

Initialize null references so `_updateBridle()` can safely check:
```javascript
// S3.6: Bridle visual references (populated in _createMesh)
this._gimbalRing = null;
this._bridleLegA = null;
this._bridleLegB = null;
this._bridleLegMat = null;
this._bridleHpA = null;
this._bridleHpB = null;
```

##### Verification Checklist (Manual Smoke Test)

| # | Test | Expected Result |
|---|------|----------------|
| 1 | Game loads, 4 arms DOCKED | Daughter meshes hidden. No bridle visible. No console errors. |
| 2 | Fire arm (crossbow launch) | Daughter mesh appears. Tether visible immediately. Bridle lines hidden (slack phase). |
| 3 | Daughter at 0.3m separation | Bridle lines snap to visible. White Y-fork from gimbal ring to ±X hardpoints. |
| 4 | Daughter in TRANSIT | Tether + bridle both visible. Tether ends at gimbal ring (not body center). |
| 5 | Tether strain > 0.7 | Tether turns amber/red. Bridle lines mirror same color change. |
| 6 | Daughter docks (RELOADING) | Tether hidden. Bridle lines hidden. Gimbal ring + hardpoints hidden (mesh off). |
| 7 | Zoom to ARM_PILOT view | Gimbal ring torus visible. Y-fork legs visible. Tether connects to ring center. |
| 8 | Detach tether (free-flight) | Tether hidden. Bridle lines hidden. |
| 9 | Reel CUT (TetherReel flag ON) | Tether hidden. Bridle lines hidden. |
| 10 | 4 arms simultaneously deployed | All 4 bridles render. Shared geometries work. No geometry duplication warnings. |

##### Final LOC Summary

| Task | LOC | File Location |
|------|-----|---------------|
| Task 1: Shared geometry cache | 12 | Module level |
| Task 2: Bridle geometry in `_createMesh()` | 25 | After line 511 |
| Task 3: `_updateBridle()` method | 12 | New private method |
| Task 4: Call site in `update()` | 1 | After line 1851 |
| Task 5: Tether endpoint fix | 3 | Line ~3270 |
| Task 6: Constructor init | 6 | After line 267 |
| **Total** | **59** | **1 file: ArmUnit.js** |

No Constants.js changes. No BridleRing.js changes. No PlayerSatellite.js changes.
No ArmManager.js changes. No test file changes.

---

## 14. Deep-Dive Addendum — Expanded Analysis

### 14.1 The "Shadow" Issue — Bloom Pass Dark Halo Artifact (Concern 4 REVISED)

**Previous analysis was wrong.** While `renderer.shadowMap.enabled = false` IS set at [`SceneManager.js:39`](js/scene/SceneManager.js:39), the user is seeing a **real visual artifact** — not shadow maps, but **bloom-pass dark halos**.

**Root cause — UnrealBloomPass extraction darkening**:

The post-processing pipeline at [`SceneManager.js:103`](js/scene/SceneManager.js:103) runs:
```
RenderPass → UnrealBloomPass(strength=0.15, radius=0.4, threshold=1.2) → SMAAPass
```

UnrealBloomPass works by: (1) extracting bright fragments above `threshold` (1.2), (2) blurring them into a glow texture, (3) compositing the bloom back using additive blending.

The artifact occurs at step 1: the extraction pass computes `max(0, pixel_brightness - threshold)`. For ROSA panels (material color `0x0a1133`, near-black with low emissive `0x050520`), brightness is **far below** the 1.2 threshold. When these dark panels are silhouetted against Earth's dayside surface (which CAN exceed the bloom threshold from specular ocean glints or bright clouds), the bloom extraction creates a **negative halo** — the dark panel subtracts bloom energy from its neighborhood, producing a visible dark outline that reads as a "shadow" cast onto the Earth behind it.

This is especially noticeable when:
- ROSA panels cross the bright Earth limb (maximum contrast)
- The sun creates specular glints on ocean below the panel
- Camera is in ORBIT view looking past the satellite toward Earth

**Against black space**: The dark panel edges create bloom-extraction boundary artifacts with nearby bright objects (sun disc, lens flare elements, spacecraft emissive materials), producing a shadow-like halo in space too.

**Proposed fix — Two-part**:

**Part A: Bloom threshold adjustment**:
```javascript
// SceneManager.js:107 — increase threshold to reduce Earth surface triggering
bloomPass.threshold = 1.5;  // was 1.2 — only truly emissive objects bloom
```

**Part B: ROSA panel emissive boost** — make panels faintly bright enough to not create a contrast dip:
```javascript
// PlayerSatellite.js:794 — raise ROSA emissive slightly
emissive: 0x080830, emissiveIntensity: 0.20,  // was 0x050520, 0.15
```

**Part C (if A+B insufficient): Bloom isolation layer** — move the satellite group to a separate render layer that bypasses bloom extraction. This is heavier (~40 LOC) but eliminates the artifact completely.

**Files**: [`SceneManager.js:107`](js/scene/SceneManager.js:107) (1 LOC), [`PlayerSatellite.js:794`](js/entities/PlayerSatellite.js:794) (2 LOC)
**Estimated effort**: 30 min (Part A+B), 3 hours (Part C if needed)

---

### 14.2 Zoom-to-Detail Without Clipping — Inspection Camera Mode

The user needs to zoom in close enough to **see mechanical details** (hinge teeth, reel cartridge, crossbow spring) without geometry clipping. This requires more than a near-plane number change — it's a new camera mode.

**Current zoom constraints**:

| View | Min Distance | Real Terms | Can See Detail? |
|------|-------------|------------|-----------------|
| CHASE | Fixed ~15m behind | 15m | No — too far for mm-scale parts |
| ORBIT | [`minDistance: 0.00015`](js/systems/CameraSystem.js:127) (~15m) | 15m orbit radius | No — same issue |
| FIRST_PERSON | Inside satellite | N/A | Panels only, no exterior |
| ARM_PILOT | ~0.3m behind arm | Near arm body | Yes for arm, no for mother |

**Proposed "INSPECTION" camera mode** — dedicated close-orbit for viewing mechanical detail:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Min distance | 0.00002 (2m) | Close enough to see hinge bearing teeth |
| Max distance | 0.0005 (50m) | Pull back to see full spacecraft |
| **Dynamic near plane** | `distance × 0.05` | At 2m → near=0.1m; at 50m → near=2.5m. Never clips. |
| FOV | 35° | Narrow FOV reduces perspective distortion of small parts |
| Mouse control | Same as ORBIT (drag to orbit, scroll to zoom) | Familiar |
| Activation | `I` key | "Inspect" |
| LVLH frame | Same as ORBIT | Prevents roll artifacts |

**Dynamic near-plane is the key insight**: Instead of a fixed `CAMERA_NEAR`, compute near from camera-to-subject distance each frame:
```javascript
// In _computeInspection():
camera.near = Math.max(0.000001, this.inspection.distance * 0.05);
camera.updateProjectionMatrix();
```

With `logarithmicDepthBuffer: true`, extreme near/far ratios are handled correctly — there is zero performance cost.

**Also reduce orbit.minDistance** from 0.00015 (15m) to 0.00005 (5m) for the standard orbit camera, with the same dynamic near-plane. This improves non-inspection zooming.

**Files**: [`CameraSystem.js`](js/systems/CameraSystem.js) (~60 LOC new mode), [`Constants.js`](js/core/Constants.js) (~5 LOC)
**Estimated effort**: 0.5 day

---

### 14.3 ROSA Panel Visual Clarity — Gold Anodized Edge Frame

Current ROSA panels are near-invisible in some lighting: dark navy `0x0a1133` with a faint blue wireframe grid at 30% opacity. The user suggests a **thin gold edge** for visual clarity.

**Real-world reference**: ISS ROSA arrays have visible gold-colored aluminum deployment boom edges. ATK UltraFlex arrays (InSight, Lucy) have anodized gold spar edges that catch specular light and make panem boundaries clearly visible in all lighting conditions.

**Proposed design**: Gold anodized frame (2cm width) around each ROSA wing using `EdgesGeometry`:
```javascript
// After creating panel ShapeGeometry:
const edgeGeo = new THREE.EdgesGeometry(panelGeo1);
const edgeMat = new THREE.LineBasicMaterial({
    color: 0xccaa44,       // gold anodized aluminum
});
const edgeLine = new THREE.LineSegments(edgeGeo, edgeMat);
wrapper.add(edgeLine);
```

**Also add to daughter ROSA panels**: Same gold edge on [`ArmUnit._createMesh()`](js/entities/ArmUnit.js:304) wings. This creates visual consistency across the entire fleet — mother and daughter panels share the same design language.

**Files**: [`PlayerSatellite.js:852`](js/entities/PlayerSatellite.js:852) (~20 LOC), [`ArmUnit.js:348`](js/entities/ArmUnit.js:348) (~15 LOC)
**Estimated effort**: 2 hours

---

### 14.4 Cable/Harness Routing — External with Clips

**Design question**: Is the power/data cable routed inside the strut or attached to the outside?

**Real-world precedent**:
- **ISS truss segments**: External cable harnesses with P-clamps every ~30cm, visible bundles
- **Hubble**: External cable trays with thermal wrap (visible gold cable bundles)
- **Small composite tube (50mm OD, ~2mm wall)**: No internal cavity large enough for routing

**Recommendation: External routing with cable clips** — more visually interesting, more physically realistic for a thin CFRP strut.

**Proposed cable harness**:
```
  [HINGE]
     ║──┤ cable exit port
     ║  ├─ clip₁ (25%)          Cable specs:
     ║  ├─ clip₂ (50%)          • Bundle ∅8mm (power + data + tether signal)
     ║  ├─ clip₃ (75%)          • Dark gray with gold thermal wrap segments
     ╠══╧═ cable entry port      • 3-4 P-clips bonded to strut surface
  [REEL]──→ to strut tip        • Offset 5mm from strut surface
```

**Three.js**: `TubeGeometry` following a `CatmullRomCurve3` path along the strut's outer face, with 3-4 small `BoxGeometry` clips at intervals.

**Files**: [`PlayerSatellite._buildStruts()`](js/entities/PlayerSatellite.js:568) (~35 LOC)
**Estimated effort**: 3 hours

---

### 14.5 Bridle Shape — Wishbone (Y-Harness) with FEEP Plume Exclusion

**Critical constraint**: Feature flag [`BRIDLE_RING_GEOMETRY`](js/core/Constants.js:394) is described as *"Y-harness FEEP plume exclusion"*. The bridle MUST route around the daughter's rear-facing FEEP thruster plume cone.

**The problem**:
- Daughter's main FEEP nozzle exhausts backward (−Z) with ~15° half-angle plume cone
- Tether attaches above the daughter (from strut tip)
- A straight tether through center would intersect the plume → degradation/breakage

**The solution — Wishbone (inverted-Y) bridle**:
```
         Tether from reel
              │
         ╔════╧════╗         ← Gimbal ball (2-axis, ±30°, spring-return)
         ╚════╤════╝
          ╱───┼───╲           ← Two wishbone legs spread laterally (±Y)
         ╱    │    ╲             routing OUTSIDE the aft plume cone
        ◯     │     ◯        ← Attach at ±Y sides of daughter body
        │  DAUGHTER  │           (inboard of ROSA panel root)
        │     │      │
        │  ◄ FEEP ►  │       ← Plume exits between legs — CLEAR
        └─────┴──────┘
  
  TOP VIEW (looking down -Y):
        Tether
          │
     ╱────┼────╲
    ╱  <PLUME>  ╲            ← 15° half-angle exclusion zone
   ◯     ///     ◯           ← Legs attach at ±90° from thrust axis
         ▼▼▼                    completely outside the cone
```

**Why 2 legs (wishbone), not 3 (tripod)**:
- 3 legs would place one directly in the plume path
- 2 legs at ±Y (lateral) clear the plume entirely
- 2 legs also co-rotate with ROSA panels (both on ±Y axis) → no collision during yaw

**ROSA clearance during daughter rotation**: ROSA extends ±Y; bridle legs also attach at ±Y but INBOARD of panel roots. During yaw rotation, both legs and panels rotate together. The gimbal at the tether junction absorbs rotation without twisting the tether.

**Spring-loaded gimbal return**: If the gimbal jams (locks up), the tether applies a restoring torque that yaw-aligns the daughter to the tether direction — degraded but safe. The spring return center-finds within ~2 seconds.

**Files**: New visual code in [`ArmUnit.js`](js/entities/ArmUnit.js) (~50 LOC)
**Estimated effort**: 3–5 hours (includes integration with tether attachment point)

---

### 14.6 Scan Rewards — Full Game Design Analysis

**The deeper question**: Scanning isn't just for credits — it provides a **Space Surveillance and Tracking (SST) database service** to ground stations. How should the reward system model this real-world value chain?

#### Real-World Context

The ESA SST programme, US Space Surveillance Network (18th SDS), and commercial trackers (LeoLabs, ExoAnalytic) all pay for **orbital characterization data**: material composition, tumble rate, structural integrity, fragmentation risk. Ground radar gives approximate orbits; close-range sensor data (what the player provides) is high-value intelligence.

```
Ground radar   → coarse TLE           → public catalog (free)
Player sensors → material, tumble,     → characterization data ($$)
                 structural analysis
Visual inspect → fragility zones,      → capture feasibility ($$$$)
                 safe grapple points
```

#### Redesigned Reward Structure — Reward NEW Information

Instead of flat 50 credits per scan, reward based on **novelty of data**:

| Scan Action | Real-World Analog | Credits | Repeatable? |
|-------------|------------------|---------|-------------|
| **First scan of new target** | Orbit determination | 100 | Once per target |
| **Quick scan (S)** — repeat | Track refinement | 10 | Yes (diminished) |
| **Wide scan (W)** — first | Constellation survey | 150 | Once per session |
| **Wide scan** — repeat | Re-survey | 20 | Yes (diminished) |
| **Scan reveals hidden debris** | Hidden object discovery | 150/find | Once per object |
| **Close-range scan (<500m)** | Detailed characterization | 200 | Once per target |
| **Scan tumbling target (>5°/s)** | Attitude determination | 50 | Once per target |
| **Scan during conjunction** | Collision assessment | ×1.5 multiplier | Per event |

#### Training Value — Why Scanning Matters Beyond Credits

1. **Discovery**: Scanning reveals targets on NavSphere + TargetReticle — teaches players "there's more than you initially see"
2. **Risk assessment**: Wide scan near conjunction previews Kessler risk
3. **Capture planning**: Scan data populates target panel with tumble, material, recommended tool — **teaches assess-before-engage**
4. **Muscle memory**: Quick scan (S key, 0.3s) is the fastest rewarding action near WASD — trains finger placement
5. **Flow state**: Between captures (dead time while daughter transits), scanning is valuable productive work
6. **SST career path**: Accumulated characterizations create a visible "Survey Expert" progression

#### Anti-Spam: Reward New Information, Not Button Presses

```javascript
// Per-target tracking (Set<debrisId> in SensorSystem):
this._scannedTargets = new Map();  // debrisId → { quick, wide, close, tumble }

// On scan completion:
const targetStatus = this._scannedTargets.get(targetId) || {};
let reward = 0;
if (!targetStatus.firstScan) {
    reward += 100;  // First scan discovery bonus
    targetStatus.firstScan = true;
}
if (range < 500 && !targetStatus.close) {
    reward += 200;  // Close characterization
    targetStatus.close = true;
}
// ... etc.
reward = Math.max(reward, type === 'quick' ? 10 : 20);  // Floor: always get something
```

#### SST Database HUD — Catalog Contribution Counter

New HUD element showing scan career progression:
```
CATALOG: 14/47 characterized  │  SST Contract: $2,400 earned
```

Mission-end bonus tiers based on unique characterizations:
- 10 targets: $1,000 bonus
- 25 targets: $3,000 bonus + sensor upgrade discount
- 50 targets: $8,000 bonus + "Survey Expert" rank

This data feeds directly into **Epic 11 mission architecture** — ground station contracts rewarding large, diverse catalogs.

**Files**: [`SensorSystem.js`](js/systems/SensorSystem.js) (~60 LOC), [`Constants.js`](js/core/Constants.js) (~20 LOC), optional HUD widget (~30 LOC)
**Estimated effort**: 1.5 days

---

### 14.7 Big Picture — How These Issues Fit Into the Project

#### Where We Are

```
Epic 1–4:  Core Loop      ✅ (orbital mechanics, debris, capture)
Epic 5–6:  UX Polish       ✅ (comms, data layer, HUD)
Epic 7–8:  Economy         ✅ (cargo, forge, market, missions)
Epic 9:    Config G Logic  ✅ (25 feature flags, 1995 tests, all OFF)
Epic 10:   Visualization   🔧 (V-1..V-6 done. V-7..V-9 + concerns remain)
Epic 11:   Mission Arch    ⏳ (tier-gated missions, ISS boss, campaign)
Epic 12:   Flag Activation ⏳ (turn on all 25 flags, integration test)
```

**Epic 10 is the visual bridge.** Until the player can SEE Config G — struts swinging, ROSA deploying, nets flying, wishbone bridles routing around exhaust — none of the Epic 9 logic matters to the player experience. The 9 concerns are real friction points that, if left unaddressed, will undermine that moment.

#### Strategic Impact of Each Concern

| Concern | Blocks | Unlocks |
|---------|--------|---------|
| 1. Mechanical fidelity | V-7 cinematic (looks wrong with simple parts) | Player comprehension of Config G; inspection mode value |
| 2. Strut hotkey | Nothing (API exists, no keybind) | Player agency over physical configuration |
| 3+Inspection | Detail viewing of all new parts | Verification of Phase 3 visual work; teaching moments |
| 4. Bloom shadow | Player trust in rendering quality | Clean Earth+satellite compositing |
| 5. Launch transition | V-7 scope | Core cinematic gameplay moment |
| 6. Comms dimming | New player sees nothing at game start | Immediate mission context |
| 7. Auto-target bug | 2nd+ capture workflow | Smooth multi-capture sessions |
| 8. Scan rewards + SST | Game economy balance → Epic 11 missions | Sustainable exploration loop; SST contract pillar |
| 9. Reticle flash | HUD visual polish | Clean presentation |

#### What Comes After Epic 10

**Epic 11 — Mission Architecture** (per [`BIG_PICTURE.md §3`](BIG_PICTURE.md:80)):
- Tier-gated missions: Single Target → Cluster Sweep → Contract → Rescue → ISS Boss
- Ground station SST contracts (Concern 8's database feeds directly into this)
- The scan reward redesign lays groundwork for mission scoring

**Epic 12 — Feature Flag Activation**:
- All 25 flags turned ON (tested in batches)
- Visual work from Concern 1 must be correct BEFORE flags activate
- Inspection camera essential for flag verification

**Epic 13+ — Educational Suite** (per [`BIG_PICTURE.md Part III`](BIG_PICTURE.md:37)):
- Teaching moments tied to mechanical parts (hinge = deployable structures, reel = tether physics)
- Codex entries for each subsystem — visual fidelity makes these meaningful

---

### 14.8 S4.1 — V-7 Launch Cinematic Camera Sequence

> **Sprint 4, Task 4A** · Replaces the abrupt camera snap described in §6 (Concern 5)
> with a 4-phase cinematic camera sequence that dramatizes the crossbow spring fire
> and daughter arm separation. Integrates with the existing camera transition system
> in [`CameraSystem.js`](js/systems/CameraSystem.js) and the `KeyG` launch trigger
> in [`InputManager.js:558`](js/systems/InputManager.js:558).

---

#### 14.8.1 Problem Recap

When the player presses **G** to deploy a daughter arm, the current flow is:

1. [`InputManager.js:565`](js/systems/InputManager.js:565) — calls `d.deployArm()`
2. [`ArmManager.deployArm()`](js/entities/ArmManager.js:285) — finds docked arm, calls `arm.deploy(target)`
3. [`ArmUnit.deploy()`](js/entities/ArmUnit.js:678) — transitions to `LAUNCHING` state
4. [`_updateLaunching()`](js/entities/ArmUnit.js:2189) — 0.3s clamp release → spring fires → 0.55s total → `TRANSIT`
5. After a raw `setTimeout(4000)` ([`InputManager.js:583`](js/systems/InputManager.js:583)), `_enterArmPilotCamera(arm)` is called with a 1.5s `_transitionDuration` override

**Result**: The camera sits in CHASE mode for 4 seconds showing nothing special, then
lurches 1.5s into ARM_PILOT. The most exciting gameplay moment — crossbow spring fire,
daughter separating from strut tip, tether deploying — is invisible.

---

#### 14.8.2 Cinematic Sequence Design — 4 Phases

The ceremony is a **camera position/look override** driven by a state machine inside
[`CameraSystem`](js/systems/CameraSystem.js). It does NOT create a new `CameraViews`
enum value — instead, it temporarily overrides the position/lookAt computed by the
current view's `_compute*()` method during `update()`. This avoids disrupting
the existing view cycling, indicator, and transition systems.

| Phase | Name | Time Range | Duration | Camera Position | Camera LookAt | FOV |
|-------|------|-----------|----------|-----------------|---------------|-----|
| 1 | **PRE_LAUNCH** | 0.0–0.5s | 0.5s | Lerp from current chase position toward strut-profile view: offset sideways from mother ship to show the active strut in profile | Lerp toward strut tip world position | Narrow from current (55°) toward 45° (slight zoom) |
| 2 | **LAUNCH** | 0.5–2.0s | 1.5s | Track the daughter as it separates: position lerps from strut-profile view to a point behind + above the daughter along its velocity vector | LookAt tracks daughter position (smooth lerp) | Hold 45° |
| 3 | **COAST** | 2.0–4.0s | 2.0s | Follow daughter from behind at ARM_PILOT-like offset (but 3× further back for context), show tether trailing back toward mother | LookAt blends from daughter toward daughter's forward (target direction), revealing debris field context | Ease from 45° toward 40° (ARM_PILOT FOV) |
| 4 | **HANDOFF** | 4.0–5.0s | 1.0s | Lerp from ceremony position to ARM_PILOT computed position | Lerp lookAt toward ARM_PILOT computed lookAt | Finalize at 40° (ARM_PILOT FOV) |

**Total duration: 5.0 seconds** (matches the existing 4s delay + 1.5s transition feel,
but now every second has visual content).

---

#### 14.8.3 Camera Path — Keyframe Lerp in World Space

**Approach**: Linear interpolation between keyframe positions computed each frame, NOT
pre-baked Bézier curves. This is necessary because the mother ship is orbiting at ~7.7
km/s — any absolute-position curve would be invalid within frames. Each phase computes
a **target position and lookAt** relative to the orbiting player/arm, then lerps from
the previous phase's final state.

**Reference frame**: World space, but positions are computed as **offsets from the player
position** (same pattern as [`_computeChase()`](js/systems/CameraSystem.js:573) and the
existing transition system at [`update():438`](js/systems/CameraSystem.js:438) which lerps
offsets not absolute positions).

**Easing**: Smoothstep (`t² × (3 - 2t)`) per phase for organic feel. Same function
already used in [`_computeArmPilot()`](js/systems/CameraSystem.js:898) look-blend.

**Clipping avoidance**:
- Phase 1 offset is computed perpendicular to the active strut's outward direction,
  ensuring the camera never passes through the strut or mother body.
- Minimum offset distance: `0.00008` scene units (~8m) — above the
  [`orbit.minDistance`](js/systems/CameraSystem.js:129) floor.
- If the offset would place the camera inside the mother ship bounding sphere
  (radius ≈ `0.00005`), clamp outward along the radial direction.

**Phase 1 — strut-profile view computation**:
```
strutTip = armManager.getStrutTipPosition(arm._slotIndex, arm._deployAlpha) // meters
strutTipScene = strutTip * M_SCALE + parentPos  // convert to scene coords
strutOutward = dockPosition.dockOutward  // unit vector pointing away from hub
lateral = cross(strutOutward, radialDir).normalize()

profileOffset = lateral * 0.00012 + radialDir * 0.00005  // ~12m sideways, ~5m above
cameraPos = playerPos + profileOffset
cameraLook = strutTipScene
```

**Phase 2 — daughter tracking**:
```
armPos = arm.position  // scene coords (updated by _updateLaunching)
armVel = arm.velocity.clone().normalize()
behindOffset = -armVel * 0.00006 + localUp * 0.00003  // 6m behind, 3m above

cameraPos = lerp(phase1FinalPos, armPos + behindOffset, smoothstep(phaseT))
cameraLook = armPos
```

**Phase 3 — coast following**:
```
// Wider ARM_PILOT offset — 3× normal for context
behindOffset = -armForward * (armPilot.offsetBehind * 3) + localUp * (armPilot.offsetAbove * 3)
coastPos = armPos + behindOffset
coastLook = armPos + armForward * 0.001  // look ahead of daughter

cameraPos = lerp(phase2FinalPos, coastPos, smoothstep(phaseT))
cameraLook = lerp(armPos, coastLook, smoothstep(phaseT))
```

**Phase 4 — handoff to ARM_PILOT**:
```
// Compute what ARM_PILOT _would_ produce this frame
armPilotResult = _computeArmPilot(dt, playerPos, velDir, radialDir)

cameraPos = lerp(phase3FinalPos, armPilotResult.pos, smoothstep(phaseT))
cameraLook = lerp(phase3FinalLook, armPilotResult.look, smoothstep(phaseT))
```

When Phase 4 completes, the camera is exactly at the ARM_PILOT position — the
handoff to the regular `_computeArmPilot()` code path is seamless with zero discontinuity.

---

#### 14.8.4 State Machine — `_launchCeremony` Object

Add to [`CameraSystem`](js/systems/CameraSystem.js) constructor:

```javascript
// Launch ceremony state (V-7)
this._launchCeremony = {
  active: false,
  phase: 0,       // 0=inactive, 1=PRE_LAUNCH, 2=LAUNCH, 3=COAST, 4=HANDOFF
  timer: 0,       // seconds elapsed in current phase
  arm: null,      // ArmUnit reference
  armManager: null,
  prevPos: new THREE.Vector3(),  // camera pos at end of previous phase
  prevLook: new THREE.Vector3(), // camera lookAt at end of previous phase
};
```

**Phase durations** (as constants):

```javascript
const CEREMONY_PHASE_DURATIONS = [0, 0.5, 1.5, 2.0, 1.0]; // index = phase
```

---

#### 14.8.5 Integration with Existing Systems

##### A. Trigger Event

Add new event to [`Events.js`](js/core/Events.js):

```javascript
LAUNCH_CEREMONY_START: 'camera:launchCeremonyStart',  // { arm, armManager }
```

##### B. InputManager.js — Replace setTimeout

Replace the `setTimeout(4000)` block in the [`KeyG` handler](js/systems/InputManager.js:569)
with a single event emission:

```javascript
// OLD (lines 569-601): setTimeout + _enterArmPilotCamera
// NEW:
if (deployed.length > 0) {
  const arm = deployed[deployed.length - 1];
  eventBus.emit(Events.COMMS_MESSAGE, {
    text: `Arm ${arm.id} deployed — tracking…`,
    priority: 'info',
  });
  eventBus.emit(Events.LAUNCH_CEREMONY_START, { arm });
}
```

This removes the raw `setTimeout` entirely. The ceremony handles the full timing
and ends by calling `_enterArmPilotCamera()` internally.

##### C. CameraSystem — Event Listener + Methods

In the constructor, add listener:

```javascript
eventBus.on(Events.LAUNCH_CEREMONY_START, ({ arm }) => {
  this.startLaunchCeremony(arm);
});
```

**New public method** — `startLaunchCeremony(arm)`:

```javascript
startLaunchCeremony(arm) {
  if (!arm) return;
  const c = this._launchCeremony;
  c.active = true;
  c.phase = 1;  // PRE_LAUNCH
  c.timer = 0;
  c.arm = arm;
  c.prevPos.copy(this.camera.position);
  c.prevLook.set(0, 0, -1).applyQuaternion(this.camera.quaternion)
    .multiplyScalar(0.001).add(this.camera.position);

  // Begin FOV narrowing (45° target for Phase 1-2)
  this._fovTransitionStart = this._baseFov;
  this._fovTransitionEnd = 45;
}
```

**New public method** — `skipLaunchCeremony()`:

```javascript
skipLaunchCeremony() {
  const c = this._launchCeremony;
  if (!c.active) return;
  // Jump straight to ARM_PILOT
  c.active = false;
  c.phase = 0;
  if (c.arm) {
    this.setPilotArm(c.arm);
  }
}
```

##### D. Update Integration

In [`update()`](js/systems/CameraSystem.js:371), add **before** the existing view
switch statement (line ~380):

```javascript
// Launch ceremony override
if (this._launchCeremony.active) {
  const result = this._updateLaunchCeremony(dt, playerPos, velDir, radialDir);
  if (result) {
    this.camera.position.copy(result.pos);
    this.camera.up.copy(radialDir);
    this.camera.lookAt(result.look);
    // Skip normal view computation + transition
    // (still run shake, indicator, FOV breath below)
    goto afterViewComputation;  // pseudocode — in practice, use early return pattern or flag
  }
}
```

Implementation note: Since JS has no `goto`, wrap the view-switch + transition
block in an `if (!this._launchCeremony.active) { ... }` guard.

##### E. _updateLaunchCeremony() — Core Logic (~60 LOC)

```javascript
_updateLaunchCeremony(dt, playerPos, velDir, radialDir) {
  const c = this._launchCeremony;
  const DURATIONS = [0, 0.5, 1.5, 2.0, 1.0];
  c.timer += dt;

  // Phase complete? Advance.
  if (c.timer >= DURATIONS[c.phase]) {
    c.prevPos.copy(this.camera.position);
    // Store current lookAt
    const lookDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    c.prevLook.copy(this.camera.position).add(lookDir.multiplyScalar(0.001));
    c.timer -= DURATIONS[c.phase];
    c.phase++;

    if (c.phase === 3) {
      // Entering COAST: start narrowing FOV toward ARM_PILOT 40°
      this._fovTransitionStart = 45;
      this._fovTransitionEnd = this.armPilot.fovNarrow;
    }
    if (c.phase > 4) {
      // Ceremony complete — enter ARM_PILOT
      c.active = false;
      c.phase = 0;
      this.setPilotArm(c.arm);  // triggers ARM_PILOT view + final FOV
      return null;
    }
  }

  const t = c.timer / DURATIONS[c.phase];
  const ease = t * t * (3 - 2 * t);  // smoothstep
  const arm = c.arm;
  if (!arm || !arm.position) { this.skipLaunchCeremony(); return null; }

  const armPos = arm.position.clone();
  const localUp = armPos.clone().normalize();
  let pos, look;

  switch (c.phase) {
    case 1: { // PRE_LAUNCH — profile view of strut
      const lateral = new THREE.Vector3().crossVectors(velDir, radialDir).normalize();
      const profileOffset = lateral.clone().multiplyScalar(0.00012)
        .add(radialDir.clone().multiplyScalar(0.00005));
      const targetPos = playerPos.clone().add(profileOffset);
      pos = new THREE.Vector3().lerpVectors(c.prevPos, targetPos, ease);
      look = new THREE.Vector3().lerpVectors(c.prevLook, armPos, ease);
      break;
    }
    case 2: { // LAUNCH — track separating daughter
      const armVel = arm.velocity.lengthSq() > 1e-16
        ? arm.velocity.clone().normalize() : velDir.clone();
      const behind = armPos.clone()
        .sub(armVel.clone().multiplyScalar(0.00006))
        .add(localUp.clone().multiplyScalar(0.00003));
      pos = new THREE.Vector3().lerpVectors(c.prevPos, behind, ease);
      look = armPos.clone();
      break;
    }
    case 3: { // COAST — wider follow with context
      let fwd = velDir.clone();
      if (arm.target?._scenePosition) {
        fwd = arm.target._scenePosition.clone().sub(armPos).normalize();
      } else if (arm.velocity.lengthSq() > 1e-16) {
        fwd = arm.velocity.clone().normalize();
      }
      const coastBehind = armPos.clone()
        .sub(fwd.clone().multiplyScalar(this.armPilot.offsetBehind * 3))
        .add(localUp.clone().multiplyScalar(this.armPilot.offsetAbove * 3));
      const coastLook = armPos.clone().add(fwd.clone().multiplyScalar(0.001));
      pos = new THREE.Vector3().lerpVectors(c.prevPos, coastBehind, ease);
      look = new THREE.Vector3().lerpVectors(c.prevLook, coastLook, ease);
      break;
    }
    case 4: { // HANDOFF — converge to ARM_PILOT
      const apResult = this._computeArmPilot(dt, playerPos, velDir, radialDir);
      pos = new THREE.Vector3().lerpVectors(c.prevPos, apResult.pos, ease);
      look = new THREE.Vector3().lerpVectors(c.prevLook, apResult.look, ease);
      break;
    }
  }
  return { pos, look };
}
```

##### F. Comms Messages at Phase Transitions

Emit contextual comms messages when each phase begins (in the phase-advance block):

| Phase | Message | Priority |
|-------|---------|----------|
| 2 (LAUNCH) | `"${arm.id}: Spring fired — separating"` | `info` |
| 3 (COAST) | `"Tracking ${arm.id} — tether deploying"` | `info` |
| 4 (HANDOFF) | — (silent, camera settling) | — |
| Complete | `"ARM PILOT engaged — following ${arm.id}"` | `info` |

---

#### 14.8.6 Interruption / Skip Handling

The cinematic **must be skippable**. Two mechanisms:

1. **Any key press during ceremony** — [`InputManager`](js/systems/InputManager.js) calls
   `cameraSystem.skipLaunchCeremony()` if `_launchCeremony.active` is true. Add a
   guard at the top of the `keydown` handler:
   ```javascript
   if (d.cameraSystem?._launchCeremony?.active && code !== 'Escape') {
     d.cameraSystem.skipLaunchCeremony();
     return;  // consume the keypress
   }
   ```
   ESC also skips but additionally cancels ARM_PILOT entry (returns to CHASE).

2. **Second arm fire during ceremony** — If player presses G again while ceremony is
   active, skip the current ceremony, the new deploy proceeds, and a new ceremony
   starts for the new arm.

3. **Arm death during ceremony** — If the arm transitions to `EXPENDED` or `DOCKED`
   during the ceremony (e.g., immediate collision), `_updateLaunchCeremony()` detects
   this via `arm.state` check and calls `skipLaunchCeremony()`.

4. **Mouse click** — Left-click during ceremony also skips (same `skipLaunchCeremony()`
   call from a mousedown listener check).

---

#### 14.8.7 Visual Enhancements During Cinematic

These are **optional polish** items. The MVP cinematic works without any of them.

| Enhancement | Description | Effort | Deferred? |
|-------------|-------------|--------|-----------|
| **Spring flash** | Brief emissive flash on the crossbow bracket mesh when `_springFired` becomes true (Phase 2 of LAUNCHING). Set bracket material emissive to `0xffaa44` for 0.1s, then decay. | 5 LOC in ArmUnit | ✅ Defer to polish |
| **Tether trail** | The tether line already exists ([`tetherLine`](js/entities/ArmUnit.js:2191)) and is visible during LAUNCHING. No extra work needed for basic visibility. | 0 LOC | ✅ Already works |
| **FOV narrowing** | Built into the ceremony spec (55° → 45° → 40°). Creates subtle speed sensation without post-processing. | 0 LOC (included) | ❌ Core spec |
| **Motion blur** | Post-processing motion blur. Requires UnrealBloomPass extension or custom shader. Far too expensive for ≤150 LOC budget. | 100+ LOC | ✅ Defer indefinitely |
| **Camera shake on spring fire** | Reuse existing `_catchShakeTimer` system. Set `_catchShakeTimer = 0.15` when Phase 2 begins. | 2 LOC | ❌ Include in MVP |
| **Strut-tip particle burst** | Spawn 20 short-lived particles at strut tip on spring release. Requires particle system not currently in project. | 80+ LOC | ✅ Defer to polish |

**MVP visual additions** (included in LOC budget):
- FOV narrowing (already in core spec)
- Camera shake on spring fire (2 LOC — set `_catchShakeTimer = 0.15` at Phase 2 entry)

---

#### 14.8.8 Files to Modify — LOC Estimates

| File | Change | LOC | Details |
|------|--------|-----|---------|
| [`js/systems/CameraSystem.js`](js/systems/CameraSystem.js) | Add `_launchCeremony` state, `startLaunchCeremony()`, `skipLaunchCeremony()`, `_updateLaunchCeremony()`, ceremony guard in `update()` | ~90 | Largest change — new state machine + 4 phase computation |
| [`js/systems/InputManager.js`](js/systems/InputManager.js:558) | Replace `setTimeout(4000)` in KeyG handler with `LAUNCH_CEREMONY_START` emission; add skip guard in keydown handler | ~15 | Remove 30 LOC of setTimeout, add 15 LOC of event emission + skip |
| [`js/core/Events.js`](js/core/Events.js) | Add `LAUNCH_CEREMONY_START` event constant | ~1 | Trivial |
| [`js/systems/InputManager.js`](js/systems/InputManager.js) | Add `_launchCeremony.active` skip check at top of keydown | ~5 | Guard clause |

**Total: ~111 LOC** (well within 150 LOC budget)

**Files NOT modified**:
- [`GameFlowManager.js`](js/systems/GameFlowManager.js) — No changes needed. The ceremony is self-contained in CameraSystem. Comms messages are emitted from within `_updateLaunchCeremony()` via eventBus, no GameFlowManager wiring required.
- [`LaunchSequence.js`](js/systems/LaunchSequence.js) — This handles the satellite's initial launch from fairing, not daughter arm launch. No changes.
- [`ArmUnit.js`](js/entities/ArmUnit.js) — No changes to the arm state machine. The ceremony reads arm state but doesn't modify it.
- [`ArmManager.js`](js/entities/ArmManager.js) — No changes. `deployArm()` is still called identically from InputManager.

---

#### 14.8.9 Sprint Build Simplification — MVP vs Polish

##### MVP (Sprint 4A — must ship)

The **minimum viable launch cinematic** is the 4-phase camera sequence described above:

1. Camera moves to strut-profile view (0.5s)
2. Tracks daughter separation (1.5s)
3. Follows from behind with tether visible (2.0s)
4. Hands off to ARM_PILOT (1.0s)

Plus:
- ESC / any-key skip
- FOV narrowing (55° → 45° → 40°)
- Comms messages at phase transitions
- Camera shake on spring fire (2 LOC)

**Total MVP: ~111 LOC across 3 files**

##### Polish (deferred — post-Sprint 4 or Epic 11)

- Spring flash emissive effect on crossbow bracket (5 LOC in ArmUnit)
- Strut-tip particle burst on spring release (80+ LOC, needs particle system)
- Motion blur shader (100+ LOC, needs post-processing pipeline)
- Configurable ceremony duration (player settings menu)
- "First launch only" mode — play full ceremony on first-ever launch, abbreviated (2s) on subsequent

##### Simplification Ladder (if ≤150 LOC is too tight)

If implementation runs long, cut in this order:

1. **Drop Phase 1** (PRE_LAUNCH strut-profile view) — start directly at Phase 2 tracking the daughter. Saves ~15 LOC. Total becomes 3-phase, 4.5s.
2. **Drop Phase 3** (COAST) — go directly from LAUNCH tracking to HANDOFF. Saves ~15 LOC. Total becomes 2-phase, 3.5s.
3. **Hardcode offsets** — instead of computing strut-tip positions via `getStrutTipPosition()`, use fixed offsets from the player. Saves ~10 LOC but loses per-strut accuracy.

Even at maximum simplification (Phase 2 + Phase 4 only), the result is dramatically
better than the current "4s of nothing → 1.5s camera lurch" flow.

---

#### 14.8.10 Testing Protocol

| Test | Steps | Expected Result |
|------|-------|-----------------|
| **Basic ceremony** | Press G to deploy daughter arm toward selected target | Camera smoothly moves to strut profile, tracks daughter separation, follows with tether visible, settles into ARM_PILOT. No sudden snaps. Total ~5s. |
| **Skip with key** | Press G to deploy, then press any key during Phase 2 | Ceremony aborts, camera jumps to ARM_PILOT immediately via `setPilotArm()`. |
| **Skip with ESC** | Press G to deploy, then press ESC during ceremony | Ceremony aborts, camera returns to CHASE (no ARM_PILOT entry). |
| **Double fire** | Press G to deploy, then G again during ceremony | First ceremony aborts, second arm deploys, new ceremony starts. |
| **No target deploy** | Press G with no target selected | If arm deploys in free-fly mode, ceremony still plays (arm has velocity from spring). |
| **Arm dies mid-ceremony** | Deploy arm that immediately hits something | `_updateLaunchCeremony()` detects arm state change, calls `skipLaunchCeremony()`. |
| **View cycle during ceremony** | Press V during ceremony | Ceremony skips (consumed by skip guard). |
| **FOV continuity** | Watch full ceremony, note FOV transitions | FOV narrows smoothly from 55° → 45° (Phase 1–2) → 40° (Phase 3–4). No FO V jumps. |

**Acceptance criteria**: No sudden camera snaps. 5-second total transition with visible
daughter separation. Skippable. Tether visible during coastphase. FOV narrows smoothly.

---

#### 14.8.11 Deep Implementation Analysis — Critical Integration Points

This section resolves every integration hazard identified during code analysis. Each
subsection names the exact conflict, the exact lines involved, and the exact resolution.
An orchestrator-spawned code task should be able to implement from this section alone.

---

##### 14.8.11.1 Problem: `_enterArmPilotCamera()` Ownership Split

**The conflict**: [`_enterArmPilotCamera()`](js/systems/InputManager.js:1111) lives on
InputManager and does 4 things:
1. Line 1117-1120: Disables previous arm's manual mode
2. Line 1123: Sets `this.armPilotMode = true` (InputManager state)
3. Line 1124: Calls `arm.enableManual()` (ArmUnit state)
4. Line 1125: Calls `d.cameraSystem.setPilotArm(arm)` (CameraSystem state)

CameraSystem cannot call `_enterArmPilotCamera()` because it doesn't own InputManager.
If the ceremony only calls `setPilotArm(arm)`, then `armPilotMode` stays false and
`arm.enableManual()` is never called → arm pilot controls won't work.

**Resolution — `LAUNCH_CEREMONY_COMPLETE` event**:

Add to [`Events.js:43`](js/core/Events.js:43) (CAMERA section):
```javascript
LAUNCH_CEREMONY_START:    'camera:launchCeremonyStart',    // { arm }
LAUNCH_CEREMONY_COMPLETE: 'camera:launchCeremonyComplete', // { arm }
```

CameraSystem emits `LAUNCH_CEREMONY_COMPLETE` when Phase 4 ends (or on skip-to-ARM_PILOT).
InputManager listens:

```javascript
// In InputManager.init() (after line 88):
eventBus.on(Events.LAUNCH_CEREMONY_COMPLETE, ({ arm }) => {
  if (arm && !this.armPilotMode) {
    this._enterArmPilotCamera(arm);
  }
});
```

**But this creates a double-call problem**: `_enterArmPilotCamera()` calls
`setPilotArm(arm)` which starts a view transition. But the ceremony already placed
the camera at the ARM_PILOT position. Solution: CameraSystem does **not** call
`setPilotArm()` itself at ceremony end — it only emits the event and lets InputManager
do the full arm-pilot setup.

Updated `_updateLaunchCeremony()` phase-advance block:
```javascript
if (c.phase > 4) {
  c.active = false;
  c.phase = 0;
  // DON'T call setPilotArm here — let InputManager handle it
  eventBus.emit(Events.LAUNCH_CEREMONY_COMPLETE, { arm: c.arm });
  eventBus.emit(Events.COMMS_MESSAGE, {
    text: `ARM PILOT engaged — following ${c.arm.id}`,
    priority: 'info',
  });
  return null;
}
```

Updated `skipLaunchCeremony()`:
```javascript
skipLaunchCeremony(enterPilot = true) {
  const c = this._launchCeremony;
  if (!c.active) return;
  const arm = c.arm;
  c.active = false;
  c.phase = 0;
  // Restore FOV to base
  this.camera.fov = this._baseFov;
  this.camera.updateProjectionMatrix();
  if (enterPilot && arm) {
    eventBus.emit(Events.LAUNCH_CEREMONY_COMPLETE, { arm });
  }
}
```

For ESC skip (no ARM_PILOT), InputManager calls `skipLaunchCeremony(false)`:
```javascript
// In Escape handler (after line 410, before the armPilotMode check):
if (d.cameraSystem?._launchCeremony?.active) {
  d.cameraSystem.skipLaunchCeremony(false); // false = don't enter ARM_PILOT
  break;
}
```

---

##### 14.8.11.2 Problem: `setPilotArm()` Resets Look-Blend After Ceremony

**The conflict**: When InputManager calls `_enterArmPilotCamera(arm)` →
[`setPilotArm(arm)`](js/systems/CameraSystem.js:726), line 739 resets
`_lookBlendTime = 0`, starting a fresh 1.5s look-blend. But the ceremony Phase 4
already converged the camera direction to ARM_PILOT's direction → this blend is
redundant and may cause a visible stutter.

**Resolution**: After `setPilotArm(arm)` is called (by InputManager via the event),
skip the look-blend by immediately marking it complete. Add to the event handler:

```javascript
eventBus.on(Events.LAUNCH_CEREMONY_COMPLETE, ({ arm }) => {
  if (arm && !this.armPilotMode) {
    this._enterArmPilotCamera(arm);
    // Skip look-blend — ceremony already converged direction
    if (d.cameraSystem) {
      d.cameraSystem.armPilot._lookBlendTime = d.cameraSystem.armPilot._lookBlendDuration;
    }
  }
});
```

---

##### 14.8.11.3 Problem: FOV Transition Piggybacking Won't Work During Ceremony

**The conflict**: The spec's original design used `_fovTransitionStart`/`_fovTransitionEnd`
for FOV changes. But these are applied ONLY inside the `if (this._transitioning)` block
at [`CameraSystem.js:431-436`](js/systems/CameraSystem.js:431). The ceremony bypasses
this block (it computes its own camera position). Result: FOV stays frozen during ceremony.

Additionally, [`setPilotArm()`](js/systems/CameraSystem.js:735) sets
`_fovTransitionStart = this._baseFov` and `_fovTransitionEnd = fovNarrow`. If called
after ceremony, `_baseFov` might still be 55° (never changed) → FOV snaps.

**Resolution — ceremony manages FOV directly**:

In `_updateLaunchCeremony()`, after computing `pos` and `look`, add:
```javascript
// FOV: 55° → 45° (phases 1-2), 45° → 40° (phases 3-4)
let targetFov;
if (c.phase <= 2) {
  targetFov = 45;
} else {
  targetFov = this.armPilot.fovNarrow; // 40°
}
const fovEaseRate = 3.0; // ~330ms to 63% of target
this._baseFov += (targetFov - this._baseFov) * Math.min(1, fovEaseRate * dt);
this.camera.fov = this._baseFov;
this.camera.updateProjectionMatrix();
```

This ensures `_baseFov` arrives at 40° by ceremony end. When `setPilotArm()` later
sets `_fovTransitionStart = this._baseFov` (now 40°) and `_fovTransitionEnd = 40°`,
the transition is a no-op → no FOV jump.

---

##### 14.8.11.4 Problem: FOV Breath System Fights Ceremony FOV

**The conflict**: The FOV breath system ([`CameraSystem.js:480-516`](js/systems/CameraSystem.js:480))
modifies `camera.fov` every frame based on thrust input. It's only skipped when
`currentView === ARM_PILOT` (line 482). During the ceremony, `currentView` is still
`CHASE` → breath system will overwrite ceremony's FOV.

**Resolution**: Add ceremony guard to the FOV breath condition.

Change line 482 from:
```javascript
if (this.currentView !== CameraViews.ARM_PILOT) {
```
to:
```javascript
if (this.currentView !== CameraViews.ARM_PILOT && !this._launchCeremony.active) {
```

This is a 1-line edit (add `&& !this._launchCeremony.active`).

---

##### 14.8.11.5 Problem: `update()` Structure — Ceremony Must Bypass View Computation

**The conflict**: The ceremony computes its own camera position, but the existing
`update()` method at lines [`383-461`](js/systems/CameraSystem.js:383) unconditionally
computes the view position and applies either the transition or direct copy.

**Resolution — `if/else` wrapper**:

Restructure [`update()`](js/systems/CameraSystem.js:371) lines 379-461 as:

```javascript
// Compute target camera state
if (this._launchCeremony.active) {
  // ── Launch ceremony override ──
  const result = this._updateLaunchCeremony(dt, playerPos, velDir, radialDir);
  if (result) {
    this.camera.position.copy(result.pos);
    this.camera.up.copy(radialDir);
    this.camera.lookAt(result.look);
  }
  // result === null means ceremony just ended; fall through to shared post-processing
} else {
  // ── Normal view computation (existing code, indented) ──
  let targetPos;
  let targetLook;

  switch (this.currentView) {
    // ... (existing cases, unchanged) ...
  }

  // Handle smooth transition between views
  if (this._transitioning) {
    // ... (existing transition code, unchanged) ...
  } else {
    // ... (existing direct copy, unchanged) ...
  }
}

// ── Shared post-processing (always runs) ──
// Phase 8: Camera shake ...
// View indicator timer ...
// FOV breath ...
// VLEO intro decay ...
// Fill light sync ...
```

The structural change is: wrap lines 380-461 in `else { }` and add the ceremony
branch above. All code inside the else is unchanged (just indented +2 spaces).
All code after line 461 (shake, indicator, FOV breath, VLEO, fill light) stays at
the same indentation level and always runs.

---

##### 14.8.11.6 Problem: Active Transition State on Ceremony Start

**The conflict**: If the player presses G during a view transition (e.g., just pressed V),
`_transitioning` is true. The ceremony bypasses it, but when ceremony ends and
`setPilotArm()` calls `setView()`, the transition `_transitionStartOffset` will be
stale (captured from a pre-ceremony camera position).

**Resolution**: In `startLaunchCeremony()`, cancel any active transition:
```javascript
startLaunchCeremony(arm) {
  if (!arm) return;
  const c = this._launchCeremony;
  c.active = true;
  c.phase = 1;
  c.timer = 0;
  c.arm = arm;
  c.prevPos.copy(this.camera.position);
  const lookDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
  c.prevLook.copy(this.camera.position).add(lookDir.multiplyScalar(0.001));

  // Cancel any active view transition — ceremony takes over
  this._transitioning = false;
  this._transitionProgress = 0;

  // Cancel FOV transition — ceremony manages FOV directly
  this._fovTransitionStart = undefined;
  this._fovTransitionEnd = undefined;
}
```

---

##### 14.8.11.7 Exact ARM_STATES Available During Ceremony Phases

Cross-reference between ceremony phases and [`ArmUnit._updateLaunching()`](js/entities/ArmUnit.js:2189):

| Ceremony Time | ArmUnit Phase | `arm.state` | `arm.velocity` | `arm.position` |
|---------------|--------------|-------------|----------------|----------------|
| 0.0–0.3s | Clamp release | `LAUNCHING` | Zero | At strut tip (set by prior `_updateDocked`) |
| 0.3–0.35s | Spring fires | `LAUNCHING` | Set by `_applyLaunchImpulse()` — ~10 m/s along `launchDirection` | Moving outward |
| 0.35–0.55s | Flying | `LAUNCHING` | Non-zero, constant | Updating via `position += velocity × dt` |
| 0.55s+ | Transit | `TRANSIT` | Non-zero, modified by FEEP thrust | Updating via orbital mechanics |

**Ceremony phase mapping**:
- Phase 1 PRE_LAUNCH (0–0.5s): Arm is in `LAUNCHING`, position is at/near strut tip. `arm.velocity` is zero for first 0.3s, then non-zero. Use `arm.position` as lookAt target — it's correct in all frames.
- Phase 2 LAUNCH (0.5–2.0s): Arm is in `TRANSIT` (after 0.55s). `arm.velocity` is non-zero. Camera can safely compute behind-the-arm offset using velocity.
- Phase 3 COAST (2.0–4.0s): Arm is firmly in `TRANSIT` or `APPROACH`. Full velocity + target data available.
- Phase 4 HANDOFF (4.0–5.0s): Arm is in `TRANSIT`/`APPROACH`. `_computeArmPilot()` works correctly.

---

##### 14.8.11.8 Exact Arm Field References for Camera Computation

All fields on `arm` (type `ArmUnit`) used by the ceremony:

| Field | Type | Source Line | Used In Phase | Notes |
|-------|------|-------------|---------------|-------|
| [`arm.position`](js/entities/ArmUnit.js:91) | `THREE.Vector3` | Constructor:91 | All | World-space scene position. Always valid. |
| [`arm.velocity`](js/entities/ArmUnit.js:92) | `THREE.Vector3` | Constructor:92 | 2, 3, 4 | World velocity. Zero during Phase 1 (first 0.3s). |
| [`arm.state`](js/entities/ArmUnit.js:88) | `string` | ARM_STATES enum | Guard | Check for `EXPENDED`/`DOCKED` to detect death. |
| [`arm.id`](js/entities/ArmUnit.js:58) | `string` | Constructor:58 | Comms | `"S-001"` etc. For comms messages. |
| [`arm.index`](js/entities/ArmUnit.js:59) | `number` | Set by ArmManager | — | Slot index. Not needed for camera math. |
| [`arm._dockOutward`](js/entities/ArmManager.js:215) | `THREE.Vector3` | ArmManager._initArms | 1 | Unit vector pointing radially outward from hub. For lateral offset in Phase 1. |
| [`arm.target`](js/entities/ArmUnit.js:83) | `object\|null` | deploy():689 | 3, 4 | Target debris. Has `_scenePosition` if set. |
| [`arm.target._scenePosition`](js/entities/ArmUnit.js:883) | `THREE.Vector3` | DebrisField | 3, 4 | World position of target debris. |

**Not used** (previously referenced in error): `arm._slotIndex` (doesn't exist),
`arm._deployAlpha` (doesn't exist — deploy angle is `arm._aimAlpha`).

---

##### 14.8.11.9 Phase 1 Strut-Profile View — Corrected Computation

The original spec computed the lateral offset using `cross(strutOutward, radialDir)`.
But [`arm._dockOutward`](js/entities/ArmManager.js:215) is in **local space** of the
parent satellite. It must be transformed to world space using the parent quaternion.

However, during the ceremony, CameraSystem does not have a reference to the parent
quaternion. The `update()` method receives `playerPos` and `playerVel` but not
`playerQuat`.

**Simpler approach**: Don't use `arm._dockOutward` at all. Instead, compute the
lateral direction from the velocity direction:

```javascript
case 1: { // PRE_LAUNCH — profile view of strut
  // Lateral offset perpendicular to velocity direction (shows strut in profile)
  const lateral = new THREE.Vector3().crossVectors(velDir, radialDir).normalize();
  const profileOffset = lateral.clone().multiplyScalar(0.00012)  // 12m sideways
    .add(radialDir.clone().multiplyScalar(0.00005));              // 5m above
  const targetPos = playerPos.clone().add(profileOffset);
  pos = new THREE.Vector3().lerpVectors(c.prevPos, targetPos, ease);
  look = new THREE.Vector3().lerpVectors(c.prevLook, armPos, ease);
  break;
}
```

This is valid because struts deploy radially outward — the lateral view will always
show the strut in profile regardless of which specific strut is active. The mother
ship is at `playerPos`, the strut extends outward, and the camera is 12m to the
side viewing across the body.

**Clipping check**: Camera is 12m from spacecraft center. Mother body radius ≈ 5m.
Clearance is 7m. Near clip is `0.000003` scene units (0.3m) in ARM_PILOT mode, or
default `Constants.CAMERA_NEAR` in other modes. No clipping risk.

---

##### 14.8.11.10 Skip Guard — Exact Insertion in InputManager._handleKeyDown

Insert **after** the debris map intercept (line 337 `}`) and **before** the main
switch statement (line 342 `switch (e.code)`):

```javascript
    // V-7: Launch ceremony skip — any key (except Escape, handled below) skips to ARM_PILOT
    if (d.cameraSystem?._launchCeremony?.active) {
      if (e.code === 'Escape') {
        d.cameraSystem.skipLaunchCeremony(false); // false = return to CHASE, no ARM_PILOT
        e.preventDefault();
        return;
      }
      if (e.code === 'KeyG') {
        // Second G press: skip ceremony, new deploy will start its own ceremony
        d.cameraSystem.skipLaunchCeremony(false);
        // Fall through to KeyG handler to deploy new arm
      } else {
        d.cameraSystem.skipLaunchCeremony(true); // true = enter ARM_PILOT
        e.preventDefault();
        return;
      }
    }
```

Insert at line 338 (after debris map intercept closing `}`), before line 339 comment.

**Line changes**: InputManager.js lines 338..338 → insert 14 LOC.

---

##### 14.8.11.11 Events.js — Exact Insertion

Insert at line 43 (after `VIEW_CONFIG_CHANGE`):

```javascript
  LAUNCH_CEREMONY_START:    'camera:launchCeremonyStart',    // { arm }
  LAUNCH_CEREMONY_COMPLETE: 'camera:launchCeremonyComplete', // { arm }
```

Insert between lines 43 and 44 (between `VIEW_CONFIG_CHANGE` and `// === GAME STATE ===`).

---

##### 14.8.11.12 KeyG Handler — Exact Replacement

Replace [`InputManager.js:569-601`](js/systems/InputManager.js:569) (the `if (d.armManager)`
block with setTimeout):

**Remove** (lines 569-601):
```javascript
            if (d.armManager && !this.armPilotMode) {
              const deployed = d.armManager.arms.filter(a =>
                a.state !== 'DOCKED' && a.state !== 'EXPENDED' &&
                a.state !== 'RETURNING' && a.state !== 'DOCKING'
              );
              if (deployed.length > 0) {
                const arm = deployed[deployed.length - 1];
                // [...30 lines of setTimeout...]
              }
            }
```

**Replace with** (lines 569-583, ~14 LOC):
```javascript
            if (d.armManager && !this.armPilotMode) {
              const deployed = d.armManager.arms.filter(a =>
                a.state !== 'DOCKED' && a.state !== 'EXPENDED' &&
                a.state !== 'RETURNING' && a.state !== 'DOCKING'
              );
              if (deployed.length > 0) {
                const arm = deployed[deployed.length - 1];
                eventBus.emit(Events.COMMS_MESSAGE, {
                  text: `Arm ${arm.id} deployed — tracking…`,
                  priority: 'info',
                });
                eventBus.emit(Events.LAUNCH_CEREMONY_START, { arm });
              }
            }
```

Net change: remove 32 LOC, add 14 LOC = **−18 LOC** (the file gets shorter).

---

##### 14.8.11.13 CameraSystem Constructor — Exact Insertion Point

Add `_launchCeremony` state at line 210 (after `_tmpVecC` pre-allocation, before
HUD overlay section):

```javascript
    // V-7: Launch ceremony state
    this._launchCeremony = {
      active: false,
      phase: 0,       // 0=inactive, 1=PRE_LAUNCH, 2=LAUNCH, 3=COAST, 4=HANDOFF
      timer: 0,
      arm: null,
      prevPos: new THREE.Vector3(),
      prevLook: new THREE.Vector3(),
    };
```

Add event listener at line 231 (after `THRUST_VISUAL` listener, before mouse bindings):

```javascript
    eventBus.on(Events.LAUNCH_CEREMONY_START, ({ arm }) => {
      this.startLaunchCeremony(arm);
    });
```

---

##### 14.8.11.14 Timing Synchronization Truth Table

| Wall Clock | Ceremony Phase | ArmUnit State | Camera Shows | FOV |
|------------|---------------|---------------|--------------|-----|
| 0.0s | G pressed → `deployArm()` called, `LAUNCH_CEREMONY_START` emitted | `DOCKED` → `LAUNCHING` | Chase view (pre-lerp) | 55° |
| 0.0–0.3s | Phase 1 PRE_LAUNCH | `LAUNCHING` (clamp hold) | Camera lerps sideways to strut-profile; looks toward arm (at strut tip) | 55→48° |
| 0.3s | Phase 1 continues | Spring fires, arm gets velocity | Camera continues lerp; arm starts moving | 48° |
| 0.5s | Phase 1→2 transition | `LAUNCHING` (flying) | Camera lerps to behind-arm position | 45° |
| 0.55s | Phase 2 | `LAUNCHING` → `TRANSIT` | Following daughter, tether visible | 45° |
| 2.0s | Phase 2→3 transition | `TRANSIT` | Camera widens to 3× ARM_PILOT offset | 45→42° |
| 4.0s | Phase 3→4 transition | `TRANSIT`/`APPROACH` | Camera converges to exact ARM_PILOT position | 41° |
| 5.0s | Phase 4 complete | `TRANSIT`/`APPROACH` | `LAUNCH_CEREMONY_COMPLETE` emitted → InputManager enters ARM_PILOT | 40° |

---

##### 14.8.11.15 Revised LOC Estimate with Precise Counts

| File | Change | Exact LOC |
|------|--------|-----------|
| [`CameraSystem.js`](js/systems/CameraSystem.js) | `_launchCeremony` state (8), constructor listener (3), `startLaunchCeremony()` (14), `skipLaunchCeremony()` (10), `_updateLaunchCeremony()` (55), `update()` if/else wrapper (6), FOV breath guard (1 modified) | **~97** |
| [`InputManager.js`](js/systems/InputManager.js) | Skip guard in `_handleKeyDown()` (14), `LAUNCH_CEREMONY_COMPLETE` listener in `init()` (8), KeyG handler replacement (net −18) | **~4 net** (22 added, 18 removed) |
| [`Events.js`](js/core/Events.js) | Two event constants | **2** |

**Grand total: ~103 LOC added** (within 150 LOC budget).

---

## 15. Game Flow Synthesis — The Coherent Experience

### 15.1 The Player Experience Arc

Every element in this analysis serves a specific moment in the player's journey. The power of these changes comes not from any single fix, but from how they **chain together** into a coherent progression:

```
 WONDER           DISCOVERY         COMPREHENSION       MASTERY            FLOW STATE
 (0-30s)          (1-5 min)         (5-15 min)          (15-30 min)        (30+ min)
 ─────────────────────────────────────────────────────────────────────────────────────
 Launch           First scan        Deploy struts        Fire daughter      Plate-spinning:
 cinematic →      reveals debris →  → see mechanical →   → launch           scan → deploy →
 VLEO Earth       target brackets   parts animate        ceremony →         capture → scan →
 establishing     appear            (hinges, reels,      ARM PILOT with     characterize →
 shot                               cables visible)      wishbone bridle    repeat
                                                         visible
 ┌─────────┐     ┌─────────┐       ┌─────────┐         ┌─────────┐       ┌─────────┐
 │Bloom fix│     │Comms    │       │Mech.    │         │Launch   │       │Auto-    │
 │ROSA edge│     │undim    │       │visuals  │         │ceremony │       │target   │
 │Clean    │     │Scan     │       │Inspect  │         │Bridle   │       │Reticle  │
 │render   │     │rewards  │       │camera   │         │design   │       │fix      │
 └─────────┘     └─────────┘       └─────────┘         └─────────┘       └─────────┘
  Hotfix-E        Hotfix-D          V-12,V-15-17         V-7,V-12g         Hotfix-B,C
                  V-18              V-13
```

### 15.2 The Synergy Chain

Each improvement amplifies the next. This is not a flat task list — it's a **compounding value chain**:

1. **Bloom fix + ROSA gold edge** → Clean, polished rendering → Player trusts the visuals → Inspection camera feels premium, not broken
2. **Comms always active** → Player reads "SYSTEM: Comm link online" immediately → Understands the game talks to them → Scan reward messages land with context
3. **Scan rewards redesigned (SST)** → Scanning is the FIRST rewarding action (before any capture) → Teaches sensor awareness → Populates target brackets → Motivates approach and capture planning
4. **Strut deploy hotkey + mechanical visuals** → Player presses `O`, sees 4 struts sweep outward with oval cross-sections, cable harnesses, reel cartridges → "This is a REAL spacecraft" → Inspection camera zoom reveals engineering detail → Codex entries will link to these visible parts
5. **Daughter redesign + wishbone bridle** → Hex-prism Weaver with visible FEEP nozzles, scanner dish, gripper jaws → Player understands what the daughter CAN DO → Wishbone bridle routing around exhaust is visible proof of engineering thought
6. **Launch ceremony camera** → 3-phase dolly from mother → daughter → ARM PILOT → Most cinematic moment in the game → Player feels the autonomy of the fleet → Motivates deploying more daughters
7. **Auto-target fix + reticle stability** → After capture, next target selected automatically → No gameplay interruption → Sustains flow state across 5+ capture chains

### 15.3 The Three Pillars Completing

The game has always had three experiential pillars. Epic 10 + these concerns complete two of them and set up the third:

| Pillar | Description | Status After This Work |
|--------|-------------|----------------------|
| **See It** | The spacecraft looks and behaves like a real ADR platform | ✅ Complete — Config G visible, mechanical detail, proper engineering |
| **Feel It** | Camera, controls, HUD communicate physical reality | ✅ Complete — launch ceremony, inspection zoom, clean reticles, responsive scan |
| **Master It** | Mission progression, economy, tier upgrades | 🔧 Set Up — SST database lays groundwork, tier visuals ready for Epic 11 |

### 15.4 How Scanning Becomes the Core Discovery Loop

The current game flow has a gap: between approach and capture, there's dead time. Scanning fills this and creates a **parallel progression track**:

```
PRIMARY LOOP (capture):     Approach → Deploy arm → Capture → Sell
SECONDARY LOOP (survey):    Scan → Characterize → Catalog → SST Contract bonus

The two loops INTERLEAVE:
  1. Autopilot toward cluster          (primary: transit)
  2. Quick scan reveals 5 targets      (secondary: discover)
  3. Select nearest, deploy daughter    (primary: engage)
  4. While daughter transits, scan next (secondary: characterize - 200cr close-range)
  5. Daughter captures target           (primary: reward)
  6. Auto-target selects next           (primary: flow maintenance)
  7. Wide scan reveals 3 hidden debris  (secondary: bonus discovery)
  8. ...repeat until cluster cleared
  9. Mission end: SST catalog bonus     (secondary: bulk reward)
```

This interleaving eliminates dead time, rewards attention during autonomous arm transits, and creates a visible progression metric (catalog counter) separate from the capture score.

### 15.5 The ADR Realism Signature

What makes Space Cowboy a *great ADR sim* rather than just a space game:

| Detail | Why It Matters | Which Task |
|--------|---------------|-----------|
| **Double-A hinge with brake disc** | Real deployable mechanism — ISS ROSA uses this class of hinge | V-12a |
| **Oval CFRP strut with rib rings** | Composite boom technology — ATK, DSS heritage | V-12b |
| **External cable P-clips** | Every space structure has visible harnesses — ISS, Hubble, GPS | V-17 |
| **Reel cartridge (replaceable)** | YES2, JAXA EDT reel heritage; enables tether tier upgrades as gameplay | V-12c |
| **Wishbone bridle ≠ straight tether** | FEEP plume exclusion is a real constraint; shows engineering tradeoffs | V-12g |
| **EPM docking (zero-power hold)** | NdFeB + AlNiCo bistable magnets — genuine TRL 6 technology | V-12e |
| **Scanning = SST data** | Real revenue stream for ADR operators (LeoLabs, ExoAnalytic business model) | V-18 |
| **Gold anodized edges on ROSA** | ISS ROSA arrays genuinely have gold boom edges — visual authenticity | V-16 |
| **Launch ceremony** | Every real satellite deployment has a separation + solar array deploy sequence | V-7 |

Each detail is defensible — a player who looks up the real technology will find matching hardware. This is the game's educational DNA made visible.

---

## 16. Orchestrator Implementation Plan

This section provides **concrete subtask specifications** for an orchestrator to delegate to code-mode workers. Each subtask is self-contained, specifies exact files and line ranges, and has clear acceptance criteria.

### Sprint 1: Hotfixes (1 session, ~4 hours)

All five fixes are independent and can be parallelized.

#### Task 1A: Near-Clip Reduction
- **File**: [`js/core/Constants.js:32`](js/core/Constants.js:32)
- **Change**: `CAMERA_NEAR: 0.0001` → `CAMERA_NEAR: 0.00001`
- **Also**: [`js/systems/CameraSystem.js:127`](js/systems/CameraSystem.js:127) — reduce `orbit.minDistance` from `0.00015` to `0.00005`
- **Test**: Orbit camera zoom to 5m distance, no panel clipping
- **AC**: ROSA panels fully visible at minimum orbit zoom in all angles

#### Task 1B: Bloom Shadow Fix
- **File**: [`js/scene/SceneManager.js:107`](js/scene/SceneManager.js:107)
- **Change**: `bloomPass` threshold `1.2` → `1.5`
- **File**: [`js/entities/PlayerSatellite.js:794`](js/entities/PlayerSatellite.js:794)
- **Change**: ROSA panel emissive `0x050520` → `0x080830`, emissiveIntensity `0.15` → `0.20`
- **Test**: ROSA panels silhouetted against bright Earth — no dark halo outline
- **AC**: No visible dark outline around any spacecraft geometry against Earth or space

#### Task 1C: Auto-Target Fix
- **File**: [`js/systems/GameFlowManager.js:811-823`](js/systems/GameFlowManager.js:811)
- **Change**: Remove the `targetSelector.setTarget(null)` and auto-select logic from the `DEBRIS_CAPTURED` handler. Leave only the accounting code (cargo, scoring, save, shop trigger). The auto-target is already handled by [`InputManager.js:110-149`](js/systems/InputManager.js:110).
- **File**: [`js/systems/InputManager.js:141`](js/systems/InputManager.js:141)
- **Change**: Replace empty `catch (err) {}` with `catch (err) { console.warn('[InputManager] Auto-target failed:', err.message); }`
- **Test**: Capture 3+ debris in sequence (lasso and arm). After each capture, next target auto-selects.
- **AC**: Auto-target works on 1st, 2nd, 3rd+ captures without clearing

#### Task 1D: Reticle Text Stability
- **File**: [`js/ui/TargetReticle.js:826`](js/ui/TargetReticle.js:826)
- **Change**: Increase closure rate deadband from `0.5` to `1.0` m/s. Use fixed-width text formatting with `padStart` for distance and rate text.
- **File**: [`js/ui/DockingReticle.js`](js/ui/DockingReticle.js) — add visibility guard: if `!this._visible || !this._arm` → set `display:none` and return early from render.
- **Test**: Select target, observe reticle text at various closure rates. No flashing/flickering.
- **AC**: Text near reticle never flickers between frames

#### Task 1E: Comms Always Active
- **File**: [`js/ui/hud/CommsPanel.js:115`](js/ui/hud/CommsPanel.js:115)
- **Change**: Remove `this.panels.comms.classList.add('hud-dormant')`
- **File**: [`js/ui/HUD.js:491-492`](js/ui/HUD.js:491)
- **Change**: Force comms opacity: `this.panels.comms.style.opacity = '';` (always full, ignore skill gating)
- **Test**: Start new game — comms panel visible at full opacity from first frame
- **AC**: Comms panel never dimmed, boot messages immediately visible

---

### Sprint 2: Camera + Controls + Scan Economy (2 sessions, ~2 days)

#### Task 2A: Inspection Camera Mode
- **File**: [`js/systems/CameraSystem.js`](js/systems/CameraSystem.js)
- **Add**: `CameraViews.INSPECTION` to view enum. New `inspection` config block (distance 0.00005, min 0.00002, max 0.0005, fov 35). New `_computeInspection()` method (same as orbit but with dynamic near-plane: `camera.near = Math.max(0.000001, distance * 0.05)`). Include in view cycle or separate `I` key binding.
- **File**: [`js/systems/InputManager.js`](js/systems/InputManager.js)
- **Add**: `KeyI` handler → `cameraSystem.setView(CameraViews.INSPECTION)`
- **Test**: Press `I`, zoom to 2m, orbit around spacecraft. All geometry visible, no clipping.
- **AC**: Can orbit spacecraft at 2m distance, see hinge detail, ROSA panel surfaces, no near-clip artifacts

#### Task 2B: Strut Deploy Hotkey
- **File**: [`js/systems/InputManager.js`](js/systems/InputManager.js)
- **Add**: `KeyO` handler — `if (e.shiftKey) armManager.strutStowAll() else armManager.strutDeployAll(Math.PI/2, 200)`
- **File**: [`js/entities/ArmManager.js`](js/entities/ArmManager.js)
- **Add**: `strutStowAll(staggerMs=200)` method — mirrors `strutDeployAll()` but calls `arm.strutStow()` on each DEPLOYED arm
- **Test**: Press `O` → all 4 struts sweep to equatorial. `Shift+O` → all stow back to barrel.
- **AC**: All struts deploy/stow on hotkey. Works only when `STOW_DEPLOY_STATE_MACHINE` flag is true.

#### Task 2C: Scan Reward Redesign (SST Database)
- **File**: [`js/systems/SensorSystem.js`](js/systems/SensorSystem.js)
- **Add**: `_scannedTargets` Map (debrisId → scan status object), `_scanCatalogCount` counter, `_scanCreditsTotal` accumulator.
- **Modify**: `_completeScan()` — replace flat `cfg.REWARD` emission with per-target gated rewards: first-scan +100, close-range (<500m scene dist) +200, tumble (>5°/s) +50. Repeats floor at 10/20. Session cap 5000.
- **File**: [`js/core/Constants.js`](js/core/Constants.js)
- **Add**: New `SCAN.REWARDS` block with `FIRST_SCAN: 100`, `CLOSE_RANGE: 200`, `TUMBLE_BONUS: 50`, `REPEAT_QUICK: 10`, `REPEAT_WIDE: 20`, `SESSION_CAP: 5000`, `CLOSE_RANGE_THRESHOLD: 500` (meters)
- **Test**: Scan same target 3x — rewards decrease. Scan new target — full discovery bonus. Scan within 500m — close-range bonus (once).
- **AC**: Spamming S key on same target yields diminishing returns. Scanning new targets yields full rewards. Credits stop at session cap.

---

### Sprint 3: Mechanical Visual Upgrade (3-4 sessions, ~4 days)

#### Task 3A: Double-A Hinge + Brake Disc
- **File**: [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js) — replace hinge geometry in `_buildCollar()` (lines ~487-546)
- **Replace**: Current cylinder + pin + flanges with: 2× `ExtrudeGeometry` A-frame clevis brackets per hinge (triangular shape, 50mm base × 40mm height × 8mm thick), extended pin (90mm span), 2× `TorusGeometry` bearing bushings, 1× `CylinderGeometry` brake disc.
- **Keep**: LED sphere, collar torus unchanged.
- **Test**: Visual inspection in INSPECTION camera — two A-frames straddling each strut root with visible pin.
- **AC**: Each of 4 hinges shows Double-A frame geometry. Pin visible through both frames.

#### Task 3B: Oval Strut + Rib Rings + ROSA Gold Edge
- **File**: [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js) — modify `_buildStruts()` (lines ~568-650)
- **Change**: Apply `strut.scale.x = 0.6` to achieve oval cross-section (or use `LatheGeometry` with elliptical profile). Add 3× `TorusGeometry` rib rings at 25%, 50%, 75% positions. Change material to dark carbon fiber (`0x333340`, metalness 0.3, roughness 0.6).
- **File**: [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js) — modify `_buildSolarPanels()` (after line ~854)
- **Add**: `EdgesGeometry` + gold `LineBasicMaterial(0xccaa44)` for each ROSA panel.
- **File**: [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js) — modify `_createMesh()` (after line ~350)
- **Add**: Same gold edge treatment on daughter ROSA panels.
- **Test**: INSPECTION camera — struts have oval cross-section, 3 rib rings visible, ROSA panels have gold border.
- **AC**: Struts visually distinct from round, rib rings visible, gold edges on all ROSA panels (mother + daughter)

#### Task 3C: Cable Harness + Reel Cartridge
- **File**: [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js) — modify `_buildStruts()` (within each strut's pivotGroup)
- **Add**: Per strut: `TubeGeometry` cable following `CatmullRomCurve3` path along outer face (hinge port → reel entry), 3× `BoxGeometry` P-clips at 25/50/75%.
- **Replace**: Current reel `CylinderGeometry(M*0.06...)` with cartridge assembly: drum cylinder, open-ended housing shell, cartridge latch box, tether exit guide `TorusGeometry`.
- **Test**: INSPECTION camera — cables visible along each strut, reel housing shows drum + guide ring.
- **AC**: Cable harness runs from hinge to reel on each strut with visible clips. Reel looks like separable cartridge.

#### Task 3D: Crossbow Bracket + EPM Mechanism
- **File**: [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js) — replace `SpringMount_${i}` in `_buildStruts()`
- **Replace**: Current single box with: 2× parallel rail guides (thin boxes), spring visual representation (stacked torus or coil), latch pin (thin cylinder across rails).
- **File**: [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js) — add to each strut tip node
- **Add**: EPM receptacle plate (`CylinderGeometry` ∅50mm × 5mm) with 2× alignment guide pins.
- **File**: [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js) — modify `_createMesh()` docking plate section
- **Replace**: Flat plate with EPM docking collar: `RingGeometry(M*0.04, M*0.06, 8)` with alternating gold/dark sectors (4 `BoxGeometry` magnet pole visuals).
- **Test**: INSPECTION camera on strut tip — crossbow rails, spring, latch visible. Daughter EPM ring visible.
- **AC**: Crossbow bracket shows launch mechanism detail. EPM ring on daughter matches receptacle on strut tip.

#### Task 3E: Daughter Body Redesign
- **File**: [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js) — rewrite `_createMesh()` (lines ~280-463)
- **Weaver (large)**: Replace `BoxGeometry` body with `CylinderGeometry(bx*M, bx*M, bz*M, 6)` (hexagonal prism). Add: 2× fore RCS nozzles at ±X on front face, glow ring on main FEEP, scanner dish (hemisphere + ring on top-forward), camera barrel (tiny cylinder on front face), comms patch antenna (flat square on top), 2-jaw gripper at front underside.
- **Spinner (small)**: Keep box body but add chamfered edges via `ExtrudeGeometry` with beveled `Shape`. Add: gecko pad texture on bottom face (wireframe grid plane), camera lens on front.
- **Keep**: Existing ROSA panels (now with gold edge from 3B), net canister, PV panel, MRR, status LED.
- **Test**: Deploy daughter via G key, enter ARM PILOT, inspect daughter mesh. Weaver = hex body with scanner/gripper visible. Spinner = beveled box with gecko pad.
- **AC**: Weaver has hexagonal body, visible scanner, gripper, 2 RCS. Spinner has beveled edges, gecko pad.

#### Task 3F: Wishbone Bridle + Gimbal
- **File**: [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js) — add new method `_createBridle()` called from constructor
- **Add**: Gimbal sphere at tether termination point (top of daughter). 2× wishbone leg `TubeGeometry` from gimbal to ±Y attach points on daughter body (inboard of ROSA). 2× attach point marker spheres. Visual updates in `_updateTether()` or new `_updateBridle()` — bridle legs orient between gimbal world position and daughter ±Y positions.
- **Constraint**: Legs must route OUTSIDE the aft FEEP plume cone (15° half-angle from -Z axis). Attach at ±Y ensures clearance.
- **Test**: Deploy daughter with tether visible. Zoom in — wishbone legs visible going from gimbal to daughter sides, plume passes between legs.
- **AC**: Bridle shows 2 legs at ±Y, gimbal sphere at top, legs do not intersect FEEP plume volume.

---

### Sprint 4: Cinematic + Remaining V-Tasks (2 sessions, ~3 days)

#### Task 4A: Launch Ceremony Camera (V-7)
- **File**: [`js/systems/CameraSystem.js`](js/systems/CameraSystem.js)
- **Add**: `_launchCeremonyState` object, `startLaunchCeremony(arm)` method. 3-phase interpolation: Phase 1 (1s, zoom toward active strut tip), Phase 2 (2s, dolly from strut tip toward arm trajectory), Phase 3 (2s, enter ARM_PILOT with extended lookBlendDuration=2.0).
- **File**: [`js/systems/InputManager.js:448`](js/systems/InputManager.js:448)
- **Change**: G key handler — instead of raw `setTimeout(2500)` for arm pilot entry, emit `Events.LAUNCH_CEREMONY_START` with arm reference. CameraSystem handles the ceremony.
- **File**: [`js/systems/GameFlowManager.js`](js/systems/GameFlowManager.js)
- **Add**: Wire `LAUNCH_CEREMONY_START` → `cameraSystem.startLaunchCeremony(arm)`. Emit comms messages at phase transitions: "Daughter separating...", "Tracking daughter...", "ARM PILOT engaged".
- **Test**: Press G to deploy daughter. Camera smoothly zooms to strut, follows daughter outward, settles into ARM PILOT.
- **AC**: No sudden camera snaps. 5-second total transition with visible daughter separation.

#### Task 4B: Capture Net Visual (V-8)
- **File**: New or within [`js/entities/CaptureNet.js`](js/entities/CaptureNet.js)
- **Add**: Net mesh visualization — spinning disc mesh during SPINNING_UP state, expanding mesh during FLIGHT, contact flash at CONTACT, cinching animation during CINCH_CLOSING, particle trail during flight.
- **Wire**: NetProjectile state changes emit visual update events. CaptureNet visual component listens and updates Three.js meshes.
- **Integrate**: Bridle ring visual from BridleRing.js data — show load distribution on attach points.
- **Test**: Fire net from daughter → visible spinning disc → flies toward target → contact flash → cinch → reel back.
- **AC**: All 14 net FSM states have corresponding visual representation.

#### Task 4C: Tier Progression Visual (V-9)
- **File**: [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js), [`js/entities/ArmManager.js`](js/entities/ArmManager.js)
- **Add**: `upgradeTier(tierKey)` method that: removes old hinge/strut/reel meshes, rebuilds with new count (Y0=4, Y1=6, Y3=8), adjusts collar ring radius if needed, triggers strut deploy animation for new arms.
- **Wire**: `TIER_UPGRADE` event → visual rebuild. Shop purchase → emit event.
- **Test**: Start at Y0 (4 arms). Purchase Y1 upgrade. 6 struts appear with new hinge positions.
- **AC**: Tier upgrade visually adds struts/hinges in correct positions. Existing deployed daughters not disrupted.

---

### Sprint Dependency Graph

```
Sprint 1 (hotfixes) ─── all independent, parallelize
    │
    ▼
Sprint 2 (camera + controls + scan)
    │   2A (inspection) ── independent
    │   2B (strut hotkey) ── independent
    │   2C (scan rewards) ── independent
    │
    ▼
Sprint 3 (mechanical visuals) ── SEQUENTIAL within sprint
    3A (hinge) → 3B (strut + ROSA edge) → 3C (cable + reel)
       → 3D (crossbow + EPM) → 3E (daughter body) → 3F (bridle)
    │
    ▼
Sprint 4 (cinematic + remaining)
    4A (launch ceremony) ── depends on 3E (daughter visible)
    4B (net visual) ── depends on 3F (bridle)
    4C (tier progression) ── depends on 3A-3C (hinge/strut/reel)
```

---

## Appendix A: Files Referenced

| File | LOC | Concerns |
|------|-----|----------|
| [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js) | 3125 | 1 (hinge, strut, reel, bracket) |
| [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js) | 3351 | 1 (daughter mesh, EPM, bridle) |
| [`js/entities/ArmManager.js`](js/entities/ArmManager.js) | 1660 | 2 (deploy hotkey) |
| [`js/entities/CaptureNet.js`](js/entities/CaptureNet.js) | 886 | V-8 (net visual) |
| [`js/entities/BridleRing.js`](js/entities/BridleRing.js) | 359 | 1 (bridle visual) |
| [`js/systems/CameraSystem.js`](js/systems/CameraSystem.js) | 979 | 3, 5 (near clip, launch camera) |
| [`js/systems/InputManager.js`](js/systems/InputManager.js) | 1200 | 2, 5, 7 (hotkey, launch, auto-target) |
| [`js/systems/GameFlowManager.js`](js/systems/GameFlowManager.js) | 1362 | 5, 7 (launch flow, auto-target) |
| [`js/systems/SensorSystem.js`](js/systems/SensorSystem.js) | 574 | 8 (scan rewards) |
| [`js/systems/ScoringSystem.js`](js/systems/ScoringSystem.js) | 630 | 8 (award points) |
| [`js/systems/LaunchSequence.js`](js/systems/LaunchSequence.js) | 446 | V-7 (launch phases) |
| [`js/scene/SceneManager.js`](js/scene/SceneManager.js) | 239 | 4 (shadows) |
| [`js/scene/SunLight.js`](js/scene/SunLight.js) | 715 | 4 (lighting) |
| [`js/ui/TargetReticle.js`](js/ui/TargetReticle.js) | 1707 | 9 (text flashing) |
| [`js/ui/DockingReticle.js`](js/ui/DockingReticle.js) | 748 | 9 (overlapping) |
| [`js/ui/hud/CommsPanel.js`](js/ui/hud/CommsPanel.js) | 486 | 6 (dimming) |
| [`js/ui/HUD.js`](js/ui/HUD.js) | ~1100 | 6 (reveal groups) |
| [`js/core/Constants.js`](js/core/Constants.js) | 2130 | 3, 8 (camera, scan) |

## Appendix B: Feature Flag Dependencies

The following feature flags must be ON for the visual work to be testable:

| Flag | Required For |
|------|-------------|
| `STOW_DEPLOY_STATE_MACHINE` | Concern 2 (strut deploy hotkey) |
| `LOCKABLE_HINGE` | Concern 1 (brake disc visual on hinge) |
| `CAPTURE_NET` | V-8 (net visual) |
| `BRIDLE_RING` | Concern 1 (bridle visual) |
| `LAUNCH_SEQUENCE` | V-7 (launch cinematic) |
