# Epic 10 — Config G Full Visualization: Implementation Plan

> **Created:** 2026-04-28 · **Status:** PLANNING
> **Prerequisite:** Epic 9 complete — 438 suites / 1,995 tests / 0 failures
> **Authoritative spec:** [`EPIC10_VISUALIZATION_PLAN.md`](EPIC10_VISUALIZATION_PLAN.md)
> **Config G locked dimensions:** [`ARM_PIVOT_ANALYSIS.md §10.11`](ARM_PIVOT_ANALYSIS.md:1235)
> **Scene scale:** `M = 1e-5` (1 metre = 0.00001 scene units)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Analysis](#2-current-state-analysis)
3. [Config G Geometry Reference](#3-config-g-geometry-reference)
4. [Task-by-Task Implementation Plan (V-1..V-11)](#4-task-by-task-implementation-plan)
5. [Dependency Graph](#5-dependency-graph)
6. [Risk Register](#6-risk-register)
7. [Test Strategy](#7-test-strategy)
8. [Recommended Execution Order](#8-recommended-execution-order)

---

## 1. Executive Summary

### What Epic 10 Accomplishes

Epic 10 transforms Space Cowboy from "logic-complete but visually V3" to "Config G is visible and alive." The player currently sees a **V3 Octopus** — a large octagonal prism with flat solar wings, 6 docking cavities, and bus-mounted tether reels. Meanwhile, the underlying logic (all of Epic 9, 25 feature flags, 1,995 tests) models a completely different spacecraft: a compact cylindrical barrel with collar-mounted struts, ROSA roll-out panels, and strut-tip equipment.

Epic 10 bridges this gap. **11 visual tasks (V-1 through V-11)** replace every mismatched visual component, wire animations to Epic 9 API outputs, and add new visual elements (launch cinematic, capture net visualization, tier progression).

### Why It Matters

- **Visual-logic coherence:** Players can't understand Config G gameplay with a V3 visual
- **Animation enables comprehension:** Strut sweep, ROSA deploy, net launch — these animate concepts that are currently invisible
- **Flag activation:** After Epic 10, all 25 feature flags can be safely turned ON; players will see the effects
- **Foundation for progression:** Tier upgrades (Y0→Y1→Y3) need visible spacecraft changes

### Overall Scope

| Metric | Value |
|--------|-------|
| Tasks | 11 (V-1 through V-11) |
| Estimated effort | ~13 developer-days (with parallel tracks) |
| Critical path | V-1 → V-2 → V-3 → V-4 → V-8 = 7.5 days |
| Files to modify | ~6 existing JS files |
| Files to create | 1–2 new JS files ([`js/scene/LaunchCinematic.js`](js/scene/LaunchCinematic.js), possibly [`js/ui/NetVisual.js`](js/ui/NetVisual.js)) |
| Test baseline | 438 suites / 1,995 tests / 0 failures (must maintain) |
| New THREE.js geometries | ~25 mesh objects, ~8 materials |

---

## 2. Current State Analysis

### 2.1 V3 Octopus Visual — What the Player Sees Now

The current model is built in [`PlayerSatellite._buildModel()`](js/entities/PlayerSatellite.js:214), which calls 9 sub-methods:

| # | Method | What It Builds | Line | Scene Scale |
|---|--------|---------------|------|-------------|
| 1 | [`_buildMainBus()`](js/entities/PlayerSatellite.js:261) | Octagonal prism `CylinderGeometry(M*1.0, M*1.0, M*4.0, 8)` + 2 gold MLI bands + 6 docking cavities + end caps + laser aperture | :261 | 1.0m radius × 4.0m long |
| 2 | [`_buildThrusters()`](js/entities/PlayerSatellite.js:406) | 4 main FEEP at rear cross-pattern + 8 attitude RCS around body | :406 | Scattered at ±0.5M offsets |
| 3 | [`_buildSolarPanels()`](js/entities/PlayerSatellite.js:499) | 2 large wings on X-axis, 3 segments each (~8m total span), accordion fold | :499 | Each segment 2.5M × 2.0M |
| 4 | [`_buildSensors()`](js/entities/PlayerSatellite.js:591) | Gimbal platform + EO camera + IR sensor + LIDAR dome at front | :591 | At Y=0.6M, Z=2.0M |
| 5 | [`_buildTetherReels()`](js/entities/PlayerSatellite.js:648) | 8 drums (6 hex + 2 front/back) on bus circumference | :648 | CylinderGeo radius 0.15M |
| 6 | [`_buildMagneticRing()`](js/entities/PlayerSatellite.js:711) | Toroidal ring at Y=0 (mid-bus) + decorative windings | :711 | TorusGeo radius 1.22M |
| 7 | [`_buildDockingPort()`](js/entities/PlayerSatellite.js:741) | Torus ring + cone guide + red/green lights at front | :741 | TorusGeo radius 0.4M at Z=2.05M |
| 8 | [`_buildNavLights()`](js/entities/PlayerSatellite.js:781) | Port red, starboard green, top/bottom white strobes | :781 | At ±1.1M |
| 9 | [`_buildRcsPuffPool()`](js/entities/PlayerSatellite.js:818) | Sprite pool for RCS puff effects | :818 | Procedural canvas texture |

**Materials** defined at [`_buildModel():216`](js/entities/PlayerSatellite.js:216):
- `_matBody` — gray metal (`0x5c5c64`, metalness 0.7, roughness 0.55)
- `_matGoldMLI` — gold thermal blanket (`0xccaa44`, metalness 0.75, roughness 0.4)
- `_matDark` — dark accent (`0x222233`, metalness 0.6)
- `_matThruster` — thruster nozzle metal (`0x555566`, metalness 0.65)

### 2.2 ArmUnit Daughter Visual — What Each Arm Looks Like

Built in [`ArmUnit._createMesh()`](js/entities/ArmUnit.js:280):

| Component | Geometry | Details |
|-----------|----------|---------|
| Main body | `BoxGeometry(bx*M, by*M, bz*M)` | Weaver=blue `0x4488aa`, Spinner=green `0x88aa44` |
| Gold MLI strip | `BoxGeometry(bx*1.02*M, by*0.25*M, bz*1.02*M)` | Gold accent at 20% Y |
| Solar panels | 2 × `PlaneGeometry` wings | Weaver: 3× body width; Spinner: 2.5× |
| FEEP nozzle | `CylinderGeometry(nozzleR*M, nozzleR*1.5*M, ...)` | Rear-mounted, 6 segments |
| Plume cone | `ConeGeometry(nozzleR*2*M, bz*0.5*M, 6)` | Additive blend, hidden initially |
| Net canister | `CylinderGeometry(canR*M, canR*M, canH*M, 8)` | Forward-mounted cylinder |
| PV panel | `PlaneGeometry(pvSize*M, pvSize*M)` | Top face, dark purple |
| MRR reflector | `CircleGeometry(mrrR*M, 6)` | Gold metallic, angled at 45° |
| Status LED | `SphereGeometry(M*0.015, 4, 4)` | Green emissive material |
| Dock plate | `CylinderGeometry(dockR*M, dockR*M, 0.02*M, 8)` | Dark metal, rear |

Arms are currently children of `this.group` (scene-level), positioned independently via orbital mechanics. **In Config G, they must become children of strut-tip nodes.**

### 2.3 What's Wrong — The Visual/Logic Mismatch

| Aspect | V3 Visual (Current) | Epic 9 Logic (Current) | Config G Target |
|--------|---------------------|------------------------|-----------------|
| Bus shape | Octagonal, 1.0m R × 4.0m | Constants: 0.4m R × 2.0m | Cylinder 0.4m R × 2.0m |
| Arm mount | 6 face cavities | `generateDockPositions()` uses collar + azimuths | Collar ring at Y=+0.90m |
| Arm count | Always 6 | `ARM_LADDER.Y0_QUAD.armCount = 4` | 4 (Y0), 6 (Y1), 8 (Y3) |
| Arm motion | Static (no sweep) | `getAimAlpha()` returns 0–π | Animated 0–180° meridian sweep |
| Solar | 2 large wings | `getRosaProgress()` returns {wing1,wing2} | ROSA roll-out panels |
| Tether reels | 8 on bus | Reel state machine on strut tip | Strut-mounted reels |
| Deploy state | Not shown | `getDeployState()` → LOCKED/STOWED/DEPLOYING/DEPLOYED/STOWING | LED indicators per hinge |
| Launch | Instant | 9-phase LaunchSequence | Fairing → separation → ROSA deploy cinematic |

---

## 3. Config G Geometry Reference

All values from [`ARM_PIVOT_ANALYSIS.md §10.11`](ARM_PIVOT_ANALYSIS.md:1235) and [`Constants.js:254`](js/core/Constants.js:254). These are **locked and canonical**.

### 3.1 Barrel Dimensions

| Parameter | Value (metres) | Scene Units (×M) | Constant Path |
|-----------|---------------|-------------------|---------------|
| Barrel height | 2.00 m | `M * 2.0 = 2e-5` | [`OCTOPUS_V5.CORE_LENGTH`](js/core/Constants.js:256) |
| Barrel across-flats | 0.80 m | `M * 0.8 = 8e-6` | [`OCTOPUS_V5.CORE_ACROSS_FLATS`](js/core/Constants.js:257) |
| Barrel radius (inscribed) | 0.40 m | `M * 0.4 = 4e-6` | [`OCTOPUS_V5.COLLAR_RADIUS`](js/core/Constants.js:262) |
| Aspect ratio | 2.5:1 | — | [`OCTOPUS_V5.CORE_ASPECT_RATIO`](js/core/Constants.js:258) |
| Bus volume | ~1.0 m³ | — | Derived |

**THREE.js geometry:** `CylinderGeometry(M*0.4, M*0.4, M*2.0, 16)` — 16 radial segments for smooth cylinder appearance. The barrel is cylindrical for the visual (even though the §10.11 spec says "octagonal" for the structural bus, the visual should read as a clean cylinder per the Visualization Plan §2).

### 3.2 Collar Dimensions

| Parameter | Value | Scene Units | Constant |
|-----------|-------|-------------|----------|
| Collar Y position | +0.90 m from barrel center | `M * 0.90` | [`COLLAR_Y`](js/core/Constants.js:261) |
| Collar radius | 0.40 m | `M * 0.40` | [`COLLAR_RADIUS`](js/core/Constants.js:262) |
| Collar offset from top | 0.10 m (barrel top is Y=+1.0m) | — | Derived (1.0 - 0.90 = 0.10) |

**THREE.js geometry:** `TorusGeometry(M*0.40, M*0.02, 8, 24)` — thin toroid ring. Hinge brackets: 4× `CylinderGeometry(M*0.02, M*0.02, M*0.04, 6)` at azimuth positions.

### 3.3 Strut Dimensions

| Parameter | Value | Scene Units | Constant |
|-----------|-------|-------------|----------|
| Strut length | 1.60 m | `M * 1.60` | [`STRUT_LENGTH`](js/core/Constants.js:265) |
| Strut tube OD | 50 mm (0.050 m) | `M * 0.050` | [`STRUT_TUBE_OD`](js/core/Constants.js:266) |
| Tube radius (visual) | 25 mm (0.025 m) | `M * 0.025` | Derived (OD/2) |
| Sweep range | 0–180° (0–π rad) | — | [`STRUT_SWEEP_MIN/MAX`](js/core/Constants.js:269) |
| Slew rate | 30°/s | — | [`STRUT_SLEW_RATE`](js/core/Constants.js:271) |

**THREE.js geometry:** `CylinderGeometry(M*0.025, M*0.025, M*1.60, 8)` — 8 segments sufficient for a thin rod.

### 3.4 ROSA Panel Dimensions

| Parameter | Value | Scene Units | Constant |
|-----------|-------|-------------|----------|
| Panel width | 1.00 m (from barrel surface) | `M * 1.0` | [`ROSA_WIDTH`](js/core/Constants.js:285) |
| Panel length | 2.00 m (full barrel height) | `M * 2.0` | [`ROSA_LENGTH`](js/core/Constants.js:286) |
| Chamfer | 0.30 m (corner cut) | `M * 0.30` | [`ROSA_CHAMFER`](js/core/Constants.js:287) |
| Panel count | 2 (at 0° and 180°) | — | Per §10.11 |
| Stowed form | Rolled cylinder ~0.10m dia × 1.0m | `M * 0.10` dia | Per §10.14 |
| Deploy duration | 6.0 s per wing | — | [`ROSA_DEPLOY_DURATION_S`](js/core/Constants.js:291) |
| ROSA power | 1,630 W | — | [`ROSA_POWER`](js/core/Constants.js:288) |
| Body-mount power | 610 W | — | [`BODY_MOUNT_POWER`](js/core/Constants.js:289) |
| Total solar | 2,240 W | — | [`TOTAL_SOLAR_POWER`](js/core/Constants.js:290) |

**THREE.js geometry (deployed):** `PlaneGeometry(M*1.0, M*2.0)` with `ShapeGeometry` for chamfered corners. Roll-out animation uses `scaleX` from 0.05→1.0 driven by [`getRosaProgress()`](js/systems/LaunchSequence.js:203).

### 3.5 Y0 Quad Arm Layout

| Strut # | Azimuth | Plane | Type | Role |
|---------|---------|-------|------|------|
| 0 | 60° | 2 | Weaver (Large Daughter) | Primary capture |
| 1 | 120° | 3 | Weaver (Large Daughter) | Primary capture |
| 2 | 240° | 2 | Spinner (Small Daughter) | Fragment sweep |
| 3 | 300° | 3 | Spinner (Small Daughter) | Fragment sweep |

Source: [`ARM_LADDER.Y0_QUAD.azimuths`](js/core/Constants.js:373) = `[60, 120, 240, 300]`

### 3.6 Tier Layouts

| Tier | Key | Arms | Azimuths | End-Face | Source |
|------|-----|------|----------|----------|--------|
| Y0 Quad | [`Y0_QUAD`](js/core/Constants.js:373) | 4 | [60°, 120°, 240°, 300°] | None | Line 373 |
| Y1 Hex | [`Y1_HEX`](js/core/Constants.js:374) | 6 | [30°, 90°, 150°, 210°, 270°, 330°] | None | Line 374 |
| Y3 Octo | [`Y3_OCTO`](js/core/Constants.js:375) | 8 | [30°, 90°, 150°, 210°, 270°, 330°] + [+Z, −Z] | 2 end-face | Line 375 |

### 3.7 Stowage Geometry (from §10.14)

| Feature | Width | Depth | Length | Source |
|---------|-------|-------|--------|--------|
| Strut channel | 60 mm | 30 mm | ~1.70 m | [`ARM_PIVOT_ANALYSIS.md:1549`](ARM_PIVOT_ANALYSIS.md:1549) |
| Reel/crossbow pocket | 150 mm | 80 mm | ~350 mm | [`ARM_PIVOT_ANALYSIS.md:1610`](ARM_PIVOT_ANALYSIS.md:1610) |
| Daughter pocket | 220 mm | 120 mm | 300 mm | [`ARM_PIVOT_ANALYSIS.md:1580`](ARM_PIVOT_ANALYSIS.md:1580) |

### 3.8 Launch Vehicle / Fairing

| Parameter | Value | Constant |
|-----------|-------|----------|
| Fairing inner diameter | 2.10 m | [`FAIRING_DIAMETER`](js/core/Constants.js:300) |
| Fairing usable length | 2.50 m | [`FAIRING_LENGTH`](js/core/Constants.js:301) |
| Stowed envelope diameter | 1.20 m | [`STOWED_ENVELOPE_DIA`](js/core/Constants.js:302) |
| Stowed envelope length | 2.30 m | [`STOWED_ENVELOPE_LEN`](js/core/Constants.js:303) |

---

## 4. Task-by-Task Implementation Plan

### V-1: Config G Barrel Mesh

| Field | Value |
|-------|-------|
| **Builds** | Cylindrical barrel replacing octagonal prism |
| **Effort** | 1 day |
| **Dependencies** | None (first task) |
| **Files to modify** | [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js) |
| **Epic 9 APIs** | None (static geometry) |

#### What Changes

Replace [`_buildMainBus()`](js/entities/PlayerSatellite.js:261) (lines 261–400). Remove:
- Octagonal prism body (`CylinderGeometry(M*1.0, M*1.0, M*4.0, 8)` at line 264)
- MLI bands (lines 275–288)
- Dark panel line rings (lines 292–302)
- 6 docking cavities (lines 304–355)
- End caps (lines 384–398)

Add new barrel geometry:

```javascript
// Config G Barrel — cylindrical, 0.4m radius × 2.0m height, 16 segments
const V5 = Constants.OCTOPUS_V5;
const barrelR = V5.COLLAR_RADIUS * M;  // 0.40m → M * 0.40
const barrelH = V5.CORE_LENGTH * M;    // 2.00m → M * 2.00

const bodyGeo = new THREE.CylinderGeometry(barrelR, barrelR, barrelH, 16);
this.body = new THREE.Mesh(bodyGeo, this._matBody);
this.body.rotation.x = Math.PI / 2; // Align Y-cylinder to Z-forward
this.body.name = 'Barrel_ConfigG';
this.add(this.body);
```

**Gold MLI bands** (2 bands at ±25% of barrel length):
```javascript
// MLI bands — 4% radius offset for Z-fighting avoidance
const bandGeo = new THREE.CylinderGeometry(
  barrelR * 1.04, barrelR * 1.04, barrelH * 0.15, 16, 1, true
);
// Position at ±0.25 of barrel (Z=±0.5m in ship frame after rotation)
```

**End caps** (top = equipment bay, bottom = daughter pocket):
```javascript
const capGeo = new THREE.CircleGeometry(barrelR, 16);
// Front cap at Z = +barrelH/2
// Rear cap at Z = -barrelH/2
```

**Body-mount thin-film solar** (per [`ARM_PIVOT_ANALYSIS.md §10.15`](ARM_PIVOT_ANALYSIS.md:1716)):
- Apply subtle blue-tint emissive to barrel material to indicate body-mount cells
- Or use a secondary material on the barrel body with slight emissive: `emissive: 0x050510, emissiveIntensity: 0.05`

**Viewport/window** — keep laser aperture, reposition to barrel front face.

#### Acceptance Criteria
- ✅ Barrel is cylindrical (not octagonal) — `radialSegments >= 16`
- ✅ Barrel dimensions: radius `M * 0.4`, height `M * 2.0`
- ✅ No arm cavities visible on barrel surface
- ✅ Gold MLI bands present
- ✅ Laser aperture relocated to barrel front
- ✅ All 1,995 tests still pass

---

### V-2: Collar Ring + Hinge Mounts

| Field | Value |
|-------|-------|
| **Builds** | Toroidal collar ring with 4 hinge mount brackets |
| **Effort** | 1 day |
| **Dependencies** | V-1 (barrel must exist) |
| **Files to modify** | [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js) |
| **Epic 9 APIs** | [`ARM_LADDER.Y0_QUAD.azimuths`](js/core/Constants.js:373) |

#### What Changes

Add new method `_buildCollar()`, called from [`_buildModel()`](js/entities/PlayerSatellite.js:214):

```javascript
_buildCollar() {
  const V5 = Constants.OCTOPUS_V5;
  const collarY = V5.COLLAR_Y * M;    // 0.90m → scene
  const collarR = V5.COLLAR_RADIUS * M; // 0.40m → scene

  // Collar ring — TorusGeometry(radius, tubeRadius, radialSegments, tubularSegments)
  const ringGeo = new THREE.TorusGeometry(collarR, M * 0.015, 8, 32);
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x888899, metalness: 0.7, roughness: 0.3,
  });
  this.collarRing = new THREE.Mesh(ringGeo, ringMat);
  // After barrel rotation (X → Z), collar Z-position = collarY
  this.collarRing.position.z = collarY;
  this.collarRing.rotation.x = Math.PI / 2;
  this.collarRing.name = 'CollarRing';
  this.add(this.collarRing);

  // Hinge mounts — one per arm azimuth
  const tier = Constants.ARM_LADDER.Y0_QUAD;
  this.hingeMounts = [];
  tier.azimuths.forEach((azDeg, i) => {
    const azRad = azDeg * Math.PI / 180;
    const mountGeo = new THREE.CylinderGeometry(
      M * 0.02, M * 0.02, M * 0.04, 6
    );
    const mount = new THREE.Mesh(mountGeo, ringMat);
    mount.position.set(
      Math.cos(azRad) * collarR,
      Math.sin(azRad) * collarR,
      collarY
    );
    mount.name = `HingeMount_${i}`;
    this.add(mount);
    this.hingeMounts.push(mount);

    // Hinge LED (status indicator)
    const ledGeo = new THREE.SphereGeometry(M * 0.01, 4, 4);
    const ledMat = new THREE.MeshBasicMaterial({ color: 0x00ff44 });
    const led = new THREE.Mesh(ledGeo, ledMat);
    led.position.copy(mount.position);
    led.position.z += M * 0.03;
    led.name = `HingeLED_${i}`;
    this.add(led);
  });
}
```

#### Key Detail: Barrel Rotation Convention

The barrel uses `rotation.x = Math.PI / 2` to align the cylinder axis (default Y in THREE.js CylinderGeometry) to the ship's Z-forward axis. This means:
- Ship +Z (forward/prograde) = Barrel +Y (top)
- Ship -Z (aft/retrograde) = Barrel -Y (bottom)
- The collar at `COLLAR_Y = +0.90m` maps to `position.z = +M*0.90` in ship frame

#### Acceptance Criteria
- ✅ Collar ring visible at Z = `M * 0.90`
- ✅ 4 hinge mounts at azimuths [60°, 120°, 240°, 300°]
- ✅ Hinge LEDs present (default green)
- ✅ `this.hingeMounts[]` array stored for V-3 wiring

---

### V-3: Strut + Sweep Animation

| Field | Value |
|-------|-------|
| **Builds** | Animated struts that sweep 0–180° driven by `getAimAlpha()` |
| **Effort** | 2 days |
| **Dependencies** | V-2 (collar + hinges must exist) |
| **Files to modify** | [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js), [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js), [`js/entities/ArmManager.js`](js/entities/ArmManager.js) |
| **Epic 9 APIs** | [`arm.getAimAlpha()`](js/entities/ArmUnit.js:1133), [`armManager.getStrutTipPosition()`](js/entities/ArmManager.js:805) |

#### What Changes

**New method `_buildStruts()`** in [`PlayerSatellite.js`](js/entities/PlayerSatellite.js):

```javascript
_buildStruts() {
  const V5 = Constants.OCTOPUS_V5;
  const strutLen = V5.STRUT_LENGTH * M;     // 1.60m
  const strutR = (V5.STRUT_TUBE_OD / 2) * M; // 0.025m
  const collarY = V5.COLLAR_Y * M;
  const collarR = V5.COLLAR_RADIUS * M;

  const strutGeo = new THREE.CylinderGeometry(strutR, strutR, strutLen, 8);
  const strutMat = new THREE.MeshStandardMaterial({
    color: 0x999999, metalness: 0.6, roughness: 0.4,
  });

  this.strutGroups = []; // Array of THREE.Group (one per arm)
  const tier = Constants.ARM_LADDER.Y0_QUAD;

  tier.azimuths.forEach((azDeg, i) => {
    const azRad = azDeg * Math.PI / 180;

    // Pivot group at hinge point on collar
    const pivotGroup = new THREE.Group();
    pivotGroup.position.set(
      Math.cos(azRad) * collarR,
      Math.sin(azRad) * collarR,
      collarY
    );
    pivotGroup.name = `StrutPivot_${i}`;

    // Strut mesh — origin at pivot, extends downward
    // CylinderGeometry default: Y-axis centered. Shift so pivot = top.
    const strut = new THREE.Mesh(strutGeo, strutMat);
    strut.position.y = -strutLen / 2; // Hang from pivot
    strut.name = `Strut_${i}`;
    pivotGroup.add(strut);

    // Strut tip node (where ArmUnit attaches)
    const tipNode = new THREE.Group();
    tipNode.position.y = -strutLen;
    tipNode.name = `StrutTip_${i}`;
    pivotGroup.add(tipNode);

    this.add(pivotGroup);
    this.strutGroups.push({ pivotGroup, strut, tipNode, azRad });
  });
}
```

**Animation in `update(dt)`** — add to existing PlayerSatellite update loop:

```javascript
// Each frame: read arm alpha and rotate strut
if (this.armManager && this.strutGroups) {
  this.armManager.arms.forEach((arm, i) => {
    if (i >= this.strutGroups.length) return;
    const sg = this.strutGroups[i];
    const alpha = arm.getAimAlpha(); // 0 = stowed (−Z), π = zenith (+Z)

    // Compute swing axis rotation in the arm's meridian plane
    // swingAxis is perpendicular to the azimuth direction and the barrel axis
    const q = new THREE.Quaternion();
    q.setFromAxisAngle(sg.swingAxis, alpha);
    sg.pivotGroup.quaternion.copy(q);
  });
}
```

**Swing axis calculation:**
The strut sweeps in a meridian plane defined by the arm's azimuth. For an arm at azimuth θ, the swing axis is tangent to the collar at that point: `swingAxis = normalize(−sin(θ), cos(θ), 0)`.

At α=0 the strut points along −Z (stowed alongside barrel).
At α=π/2 the strut points radially outward (equatorial).
At α=π the strut points along +Z (zenith).

**Performance:** 4–8 cylinders rotating per frame = trivial. No instancing needed. Use `quaternion.setFromAxisAngle()` for smooth interpolation.

#### Acceptance Criteria
- ✅ Strut visible as thin rod from collar to tip (length `M * 1.60`)
- ✅ Strut tip world position matches `armManager.getStrutTipPosition(i, alpha)` within `M * 0.01`
- ✅ Strut rotates in response to `arm.getAimAlpha()` each frame
- ✅ α=0: strut alongside barrel (stowed); α=π/2: equatorial; α=π: zenith
- ✅ Smooth animation during DEPLOYING/STOWING transitions

---

### V-4: Arm Remount at Strut Tips

| Field | Value |
|-------|-------|
| **Builds** | Reparent daughter arm meshes from scene to strut-tip nodes |
| **Effort** | 1.5 days |
| **Dependencies** | V-3 (struts must exist) |
| **Files to modify** | [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js:280), [`js/entities/ArmManager.js`](js/entities/ArmManager.js) |
| **Epic 9 APIs** | [`arm.getAimAlpha()`](js/entities/ArmUnit.js:1133), [`armManager.getStrutTipPosition()`](js/entities/ArmManager.js:805) |

#### What Changes

**Modify [`ArmUnit._createMesh()`](js/entities/ArmUnit.js:280):**
- Keep daughter body box + accessories (MLI strip, nozzle, canister, PV panel, MRR, LED, dock plate)
- Adjust dimensions for Config G scale (Weaver body: 0.2×0.2×0.3m; Spinner: smaller)
- Remove old scene-level positioning; arm `group` becomes child of `strutGroups[i].tipNode`
- Arm body orientation: "outward" from barrel center (use `dockOutward` direction from C-2)

**Add strut-tip equipment to each arm:**

```javascript
// Strut-mounted tether reel (CONFIG G: on strut near tip, not on bus)
const reelGeo = new THREE.CylinderGeometry(M * 0.06, M * 0.06, M * 0.05, 8);
const reelMat = new THREE.MeshStandardMaterial({
  color: 0x666677, metalness: 0.6, roughness: 0.4,
});
const reel = new THREE.Mesh(reelGeo, reelMat);
reel.position.y = M * 0.15; // Above arm body, near strut tip
reel.name = `StrutReel_${this.id}`;
this.group.add(reel);

// Bridle ring (from C-8) — small toroid at strut tip
const bridleGeo = new THREE.TorusGeometry(M * 0.04, M * 0.008, 6, 12);
const bridleMat = new THREE.MeshStandardMaterial({
  color: 0xaaaaaa, metalness: 0.6, roughness: 0.3,
});
const bridle = new THREE.Mesh(bridleGeo, bridleMat);
bridle.position.y = M * 0.20;
bridle.name = `BridleRing_${this.id}`;
this.group.add(bridle);

// Net canister (folded net indicator — from C-6)
// Already exists in _createMesh; reposition to strut-tip context
```

**Reparenting logic in `ArmManager._initArms()` or `PlayerSatellite`:**

```javascript
// After building struts (V-3) and creating arms:
this.armManager.arms.forEach((arm, i) => {
  if (i < this.strutGroups.length) {
    // Remove arm group from scene
    scene.remove(arm.group);
    // Add to strut tip
    this.strutGroups[i].tipNode.add(arm.group);
    // Reset local position (now relative to tip)
    arm.group.position.set(0, 0, 0);
  }
});
```

**⚠️ HIGH RISK:** This is the highest-risk task (per Risk R-8 in plan). The group hierarchy change (scene → strut tip) affects:
- Arm world position calculations
- Tether line endpoints
- Capture net projectile launch positions
- All code that reads `arm.group.position` in world space

Must verify `arm.group.getWorldPosition()` still returns correct results after reparenting.

#### Acceptance Criteria
- ✅ Arms visible at strut tips (not on bus faces)
- ✅ Arms track strut tips correctly at all alpha values [0, π]
- ✅ Arm count updates on tier change event
- ✅ Strut-mounted reel + bridle ring visible per arm
- ✅ `arm.getTetherAnchorWorldPosition()` still returns correct world-space position

---

### V-5: ROSA Panel Roll-Out

| Field | Value |
|-------|-------|
| **Builds** | 2 ROSA panels with roll-out animation |
| **Effort** | 1.5 days |
| **Dependencies** | V-1 (barrel must exist) |
| **Files to modify** | [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js), [`js/systems/LaunchSequence.js`](js/systems/LaunchSequence.js) |
| **Epic 9 APIs** | [`launchSequence.getRosaProgress()`](js/systems/LaunchSequence.js:203) |

#### What Changes

Replace [`_buildSolarPanels()`](js/entities/PlayerSatellite.js:499) (lines 499–585). Remove entire large-wing array.

**New ROSA panel geometry:**

```javascript
_buildRosaPanels() {
  const V5 = Constants.OCTOPUS_V5;
  const rosaW = V5.ROSA_WIDTH * M;     // 1.0m
  const rosaL = V5.ROSA_LENGTH * M;    // 2.0m
  const barrelR = V5.COLLAR_RADIUS * M; // 0.4m
  const chamfer = V5.ROSA_CHAMFER * M;  // 0.3m

  // Panel material — dark blue-black GaAs cells
  const panelMat = new THREE.MeshStandardMaterial({
    color: 0x0a1133, metalness: 0.4, roughness: 0.5,
    side: THREE.DoubleSide,
    emissive: 0x050520, emissiveIntensity: 0.15,
  });

  // Create chamfered panel shape (rectangle with bottom corner cuts)
  const shape = new THREE.Shape();
  shape.moveTo(0, -rosaL / 2 + chamfer);        // bottom-left + chamfer
  shape.lineTo(0, rosaL / 2);                    // top-left
  shape.lineTo(rosaW, rosaL / 2);                // top-right
  shape.lineTo(rosaW, -rosaL / 2 + chamfer);     // bottom-right + chamfer
  shape.lineTo(rosaW - chamfer, -rosaL / 2);     // chamfer corner
  shape.lineTo(chamfer, -rosaL / 2);             // chamfer corner
  shape.closePath();

  const panelGeo = new THREE.ShapeGeometry(shape);

  // ROSA Panel 1 at 0° azimuth (positive X in XZ plane after barrel rotation)
  this.rosaPanel1 = new THREE.Mesh(panelGeo, panelMat);
  this.rosaPanel1.position.set(barrelR, 0, 0); // Flush with barrel surface
  this.rosaPanel1.name = 'ROSA_Panel_0deg';
  this.add(this.rosaPanel1);

  // ROSA Panel 2 at 180° azimuth (negative X)
  this.rosaPanel2 = new THREE.Mesh(panelGeo, panelMat);
  this.rosaPanel2.position.set(-barrelR - rosaW, 0, 0); // Mirror
  this.rosaPanel2.name = 'ROSA_Panel_180deg';
  this.add(this.rosaPanel2);

  // Grid lines overlay for panel detail
  const gridMat = new THREE.MeshBasicMaterial({
    color: 0x2244aa, wireframe: true, transparent: true, opacity: 0.3,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  // Add grid overlay for each panel...

  // Initial state: scaled to rolled-up form
  this.rosaPanel1.scale.x = 0.05; // Nearly rolled up
  this.rosaPanel2.scale.x = 0.05;
}
```

**Roll-out animation in `update(dt)`:**

```javascript
// Drive ROSA panels from LaunchSequence
if (this._launchSequence) {
  const progress = this._launchSequence.getRosaProgress();
  if (this.rosaPanel1) {
    this.rosaPanel1.scale.x = 0.05 + 0.95 * progress.wing1; // 0.05 → 1.0
  }
  if (this.rosaPanel2) {
    this.rosaPanel2.scale.x = 0.05 + 0.95 * progress.wing2;
  }
}
```

**Alternative approach:** For more realistic ROSA unfurl, use a sequence of triangles that fan out from the barrel root. But `scaleX` animation is simpler and sufficient for v1 (per Risk R-3 mitigation).

#### Acceptance Criteria
- ✅ 2 ROSA panels at 0° and 180° azimuths
- ✅ Panel dimensions: 1.0m × 2.0m with chamfered bottom corners
- ✅ Roll-out animation driven by `getRosaProgress()` wing1/wing2 (0→1)
- ✅ No large solar wings visible
- ✅ Body-mount thin-film cells indicated by barrel material

---

### V-6: FEEP Thruster Relocation

| Field | Value |
|-------|-------|
| **Builds** | Repositioned thrusters to Config G barrel geometry |
| **Effort** | 0.5 day |
| **Dependencies** | V-1 (barrel dimensions) |
| **Files to modify** | [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js:406) |
| **Epic 9 APIs** | [`Constants.THRUSTERS`](js/core/Constants.js:492) |

#### What Changes

Modify [`_buildThrusters()`](js/entities/PlayerSatellite.js:406) (lines 406–493):

- **4 main FEEP nozzles:** Reposition to aft face (−Z in ship frame) at `±X * M*0.2, ±Y * M*0.2, Z = -M*1.0` (barrel bottom). Smaller nozzles matching 0.4m barrel radius.
- **8 attitude thrusters:** Redistribute around Config G barrel. 4 pairs at 45°/135°/225°/315° at two Z-stations (±0.5m from center).
- **Nozzle sizing:** Scale down from `CylinderGeometry(M*0.08, M*0.15, M*0.3, 6)` to `CylinderGeometry(M*0.03, M*0.06, M*0.15, 6)` to match smaller barrel.
- **Plume interlock visual:** When `THRUSTER_INTERLOCK` flag ON and thruster blocked, dim plume opacity + red "X" sprite.

```javascript
// Config G main thruster positions (aft face, cross pattern)
const mainPositions = [
  { x: 0,       y: M * 0.2,  z: -barrelH / 2 },  // top
  { x: 0,       y: -M * 0.2, z: -barrelH / 2 },  // bottom
  { x: M * 0.2, y: 0,        z: -barrelH / 2 },   // right
  { x: -M * 0.2, y: 0,       z: -barrelH / 2 },   // left
];
```

#### Acceptance Criteria
- ✅ Nozzle positions match Config G barrel (not V3 octagon)
- ✅ Plume cones fire in −Z direction
- ✅ Interlock visual indicator when `THRUSTER_INTERLOCK` flag is ON

---

### V-7: Launch Sequence Cinematic

| Field | Value |
|-------|-------|
| **Builds** | Animated launch sequence with fairing, pyro-bolts, ROSA deploy |
| **Effort** | 2 days |
| **Dependencies** | V-3 (struts for unlock animation), V-5 (ROSA for deploy animation) |
| **Files to create** | [`js/scene/LaunchCinematic.js`](js/scene/LaunchCinematic.js) |
| **Files to modify** | [`js/systems/LaunchSequence.js`](js/systems/LaunchSequence.js) |
| **Epic 9 APIs** | [`launchSequence.getCurrentPhase()`](js/systems/LaunchSequence.js:197), `LAUNCH_PHASE_CHANGED` event |

#### What Changes

Create new [`js/scene/LaunchCinematic.js`](js/scene/LaunchCinematic.js) — subscribes to `LAUNCH_PHASE_CHANGED` events and drives visual animations:

| Phase | Visual Effect | THREE.js Approach |
|-------|-------------|-------------------|
| `STOWED_IN_FAIRING` | Translucent cone enclosing spacecraft + stowed struts | `ConeGeometry(M*1.05, M*2.5, 16)` with `MeshStandardMaterial({ transparent: true, opacity: 0.3, color: 0xddddee })` |
| `LIFTOFF` | Camera shake + fairing vibration + flame below | Oscillate camera position ± `M*0.01`; orange `PointLight` below |
| `FAIRING_SEPARATION` | Two half-shells fly apart | Split cone into 2 half-meshes; tween position outward + rotation over 2s |
| `ORBIT_INSERTION` | Gentle FEEP glow, Earth backdrop stabilizes | Fade main thruster plume to 0.3 opacity |
| `LAUNCH_LOCK_RELEASE` | Per-strut flash at hinge (pyro-bolt) | Flash hinge LED white → settle to amber. Small `PointLight` burst (0.5s) per hinge |
| `ROSA_DEPLOY_PRIMARY` | Panel 1 unrolls | V-5 animation driven by `getRosaProgress().wing1` |
| `ROSA_DEPLOY_SECONDARY` | Panel 2 unrolls | V-5 animation driven by `getRosaProgress().wing2` |
| `POWER_NOMINAL` | Panel glow brightens | Increase panel emissive intensity 0.15 → 0.4 over 1s |
| `READY` | Camera returns to normal | Yield cinematic camera state; restore player camera |

**Camera system integration:**
- Use a dedicated `CINEMATIC` camera state in [`CameraSystem.js`](js/systems/CameraSystem.js)
- Auto-orbit camera with slow pan during sequence
- Restore player camera on `READY` phase

**Fairing mesh:**
```javascript
// Two-piece fairing (split along local XZ plane)
const fairingGeo = new THREE.ConeGeometry(
  M * 1.05,  // radius (bottom, slightly larger than stowed envelope)
  M * 2.5,   // height (fairing length)
  16,         // segments
  1,          // height segments
  false,      // open ended? no
  0,          // theta start
  Math.PI     // theta length (half cone!)
);
// Create two halves, one at θ=0→π and one at θ=π→2π
```

#### Acceptance Criteria
- ✅ Fairing visible at game start (when `LAUNCH_SEQUENCE` flag ON)
- ✅ Fairing separates into two halves and flies apart
- ✅ Per-strut pyro-bolt flash visible during `LAUNCH_LOCK_RELEASE`
- ✅ ROSA panels visibly unroll during deploy phases
- ✅ Camera returns to normal on `READY`
- ✅ Cinematic skippable (tied to existing skip logic in LaunchSequence)

---

### V-8: Capture Net Visual

| Field | Value |
|-------|-------|
| **Builds** | Net projectile visualization across 14-state FSM |
| **Effort** | 1.5 days |
| **Dependencies** | V-4 (arms at strut tips) |
| **Files to create/modify** | New visual module in [`js/entities/CaptureNet.js`](js/entities/CaptureNet.js) or [`js/ui/NetVisual.js`](js/ui/NetVisual.js) |
| **Epic 9 APIs** | [`captureNetSystem.getActiveNetForArm(i)`](js/entities/CaptureNet.js:788), [`arm.getTetherAnchorWorldPosition()`](js/entities/ArmUnit.js:1505) |

#### What Changes

Visual representation per net FSM state:

| Net State | Visual | THREE.js Geometry |
|-----------|--------|-------------------|
| **FOLDED** | Small canister on strut tip | Existing net canister mesh (from V-4) — visible |
| **LAUNCHING** | Expanding disc departing arm | `RingGeometry(M*0.05, M*0.15, 12)` at net position, scaling up |
| **FLIGHT** | Spinning disc with trailing tether | `RingGeometry` + rotation animation + `THREE.Line` tether |
| **SPINNING_UP** | Visible spin acceleration | Increase rotation speed on ring mesh |
| **CONTACT** | Net disc at target, flash | Emissive flash on impact |
| **CINCH** | Semi-transparent sphere wrapping target | `SphereGeometry(targetR * 1.2, 16, 12)` with `transparent: true, opacity: 0.4, color: 0x88bbff` |
| **REELING** | Tether line shortens, net+debris move | Update `THREE.Line` endpoints; move wrapped sphere toward strut tip |
| **STOWED** | Disappear | Set `visible = false` on all net visuals |
| **RELEASED** | Disappear | Set `visible = false` |

**Tether line:**
```javascript
// Tether from strut tip to net position
const tetherGeo = new THREE.BufferGeometry().setFromPoints([strutTipWorld, netPositionWorld]);
const tetherMat = new THREE.LineBasicMaterial({
  color: 0xcccccc, transparent: true, opacity: 0.6,
});
const tetherLine = new THREE.Line(tetherGeo, tetherMat);
```

**Net disc (spinning projectile):**
```javascript
const netGeo = new THREE.RingGeometry(M * 0.02, M * 0.10, 12);
const netMat = new THREE.MeshBasicMaterial({
  color: 0x88bbff, transparent: true, opacity: 0.6,
  side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending,
});
```

#### Acceptance Criteria
- ✅ Net visual tracks projectile state correctly for all 14 FSM states
- ✅ Tether line visible from strut tip to net (during FLIGHT through REELING)
- ✅ Spinning animation visible during SPINNING_UP
- ✅ Wrap visual (translucent sphere) appears on CINCH
- ✅ Net visual disappears on STOWED/RELEASED

---

### V-9: Tier Progression Visuals

| Field | Value |
|-------|-------|
| **Builds** | Visual tier transitions Y0→Y1→Y3 |
| **Effort** | 1 day |
| **Dependencies** | V-4 (arm remount system) |
| **Files to modify** | [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js), [`js/entities/ArmManager.js`](js/entities/ArmManager.js) |
| **Epic 9 APIs** | [`armManager.getCurrentTier()`](js/entities/ArmManager.js:769), `TIER_UPGRADED` event |

#### What Changes

Subscribe to `TIER_UPGRADED` event (emitted by [`ArmTierCatalog.js:287`](js/systems/ArmTierCatalog.js:286)):

**Tier visual configs:**

| Tier | Struts | Azimuths | Collar | Special |
|------|--------|----------|--------|---------|
| Y0 Quad | 4 | [60°, 120°, 240°, 300°] | Standard | — |
| Y1 Hex | 6 | [30°, 90°, 150°, 210°, 270°, 330°] | Slightly thicker tube radius | — |
| Y3 Octo | 6 ring + 2 end-face | Ring: same as Y1; End: [+Z, −Z] | Standard | End-face bracket mounts on barrel caps |

**Transition animation sequence (1.5s total):**
1. **Phase 1 (0–0.5s):** Old struts + arms fade out (opacity → 0)
2. **Phase 2 (0.5–0.8s):** "Refit" flash — white emissive overlay on barrel body (1 frame bright → fade over 0.3s)
3. **Phase 3 (0.8–1.5s):** New struts + arms fade in at new positions (opacity 0 → 1)

**Y3 Octo end-face arms:**
```javascript
// End-face bracket — not on collar ring, on barrel cap
const endBracketGeo = new THREE.CylinderGeometry(M * 0.03, M * 0.03, M * 0.06, 6);
const endBracket = new THREE.Mesh(endBracketGeo, strutMat);

// +Z end-face arm: mounted at barrel front (Z = +barrelH/2)
endBracket.position.set(0, 0, barrelH / 2);
// Sweep plane: perpendicular to ROSA, along prograde/retrograde axis
```

**Rebuild logic:**
```javascript
onTierUpgraded(event) {
  const newTier = event.toTier; // 'Y0_QUAD' | 'Y1_HEX' | 'Y3_OCTO'
  const tierConfig = Constants.ARM_LADDER[newTier];

  // 1. Dispose old strut meshes
  this.strutGroups.forEach(sg => {
    sg.pivotGroup.parent.remove(sg.pivotGroup);
    // Dispose geometries and materials
  });

  // 2. Rebuild with new azimuth array
  this._buildStruts();  // Uses armManager.getCurrentTier() for config
  this._remountArms();  // Reparent arm groups to new strut tips
}
```

#### Acceptance Criteria
- ✅ Y0 Quad: 4 struts at correct azimuths
- ✅ Y1 Hex: 6 struts at [30°, 90°, 150°, 210°, 270°, 330°]
- ✅ Y3 Octo: 6 ring struts + 2 end-face arms at ±Z
- ✅ Transition animation (fade out → flash → fade in) plays on `TIER_UPGRADED`
- ✅ End-face arms on Y3 use barrel-cap brackets (not collar)

---

### V-10: Deploy State Visual Indicators

| Field | Value |
|-------|-------|
| **Builds** | Per-strut LED indicators for deploy state + high-recoil glow |
| **Effort** | 0.5 day |
| **Dependencies** | V-3 (struts with hinge LEDs) |
| **Files to modify** | [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js), [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js) |
| **Epic 9 APIs** | [`arm.getDeployState()`](js/entities/ArmUnit.js:1260), [`arm.isHighRecoilZone()`](js/entities/ArmUnit.js:1185) |

#### What Changes

Update LED color per frame based on [`DEPLOY_STATES`](js/core/Constants.js:466):

```javascript
// In PlayerSatellite.update(dt):
if (this.armManager) {
  this.armManager.arms.forEach((arm, i) => {
    if (i >= this.hingeLEDs.length) return;
    const led = this.hingeLEDs[i];
    const state = arm.getDeployState();

    switch (state) {
      case 'LOCKED':    led.material.color.setHex(0xff2222); break; // Red
      case 'STOWED':    led.material.color.setHex(0xffaa22); break; // Amber
      case 'DEPLOYING': // Cyan pulsing
      case 'STOWING':
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.01);
        led.material.color.setHex(0x22ffff);
        led.material.opacity = 0.5 + 0.5 * pulse;
        break;
      case 'DEPLOYED':  led.material.color.setHex(0x22ff44); break; // Green
    }

    // High-recoil zone glow (amber warning on strut)
    if (arm.isHighRecoilZone() && this.strutGroups[i]) {
      this.strutGroups[i].strut.material.emissive.setHex(0x332200);
      this.strutGroups[i].strut.material.emissiveIntensity = 0.3;
    } else if (this.strutGroups[i]) {
      this.strutGroups[i].strut.material.emissiveIntensity = 0;
    }
  });
}
```

**Color mapping table:**

| Deploy State | LED Color | LED Behavior | Strut Glow |
|--------------|-----------|-------------|------------|
| `LOCKED` | Red `0xff2222` | Solid | None |
| `STOWED` | Amber `0xffaa22` | Solid | None |
| `DEPLOYING` | Cyan `0x22ffff` | Pulsing (sine wave) | None |
| `DEPLOYED` | Green `0x22ff44` | Solid | Amber if high-recoil zone |
| `STOWING` | Cyan `0x22ffff` | Pulsing | None |

#### Acceptance Criteria
- ✅ Hinge LED colors match deploy state for all 5 states
- ✅ DEPLOYING/STOWING LEDs pulse (not static)
- ✅ High-recoil glow appears when α < 30° or α > 150°
- ✅ Gated by `FEATURE_FLAGS.STOW_DEPLOY_STATE_MACHINE`

---

### V-11: Stowage Channels + Daughter Pockets

| Field | Value |
|-------|-------|
| **Builds** | Barrel surface detail — recessed channels and pockets |
| **Effort** | 0.5 day |
| **Dependencies** | V-1 (barrel exists) |
| **Files to modify** | [`js/entities/PlayerSatellite.js`](js/entities/PlayerSatellite.js) |
| **Epic 9 APIs** | None (static geometry) |

#### What Changes

Add subtle barrel surface details in new `_buildStowageDetails()`:

**Stowage channels** (4 grooves matching strut azimuths):
```javascript
// Per §10.14: channel = 60mm wide × 30mm deep × 1.70m long
const channelGeo = new THREE.BoxGeometry(
  M * 0.060,   // width
  M * 0.030,   // depth (recessed into barrel)
  M * 1.70     // length (collar to pocket)
);
const channelMat = new THREE.MeshStandardMaterial({
  color: 0x333344, metalness: 0.5, roughness: 0.6,
});

const tier = Constants.ARM_LADDER.Y0_QUAD;
tier.azimuths.forEach((azDeg, i) => {
  const azRad = azDeg * Math.PI / 180;
  const channel = new THREE.Mesh(channelGeo, channelMat);
  const channelR = (V5.COLLAR_RADIUS - 0.015) * M; // slightly inside barrel surface
  channel.position.set(
    Math.cos(azRad) * channelR,
    Math.sin(azRad) * channelR,
    M * 0.05 // centered vertically, slight offset toward bottom
  );
  channel.lookAt(0, 0, channel.position.z); // Face inward
  channel.name = `StowChannel_${i}`;
  this.add(channel);
});
```

**Daughter pocket** (wider recess at barrel bottom):
```javascript
// Per §10.14: pocket = 220mm wide × 120mm deep × 300mm tall
const pocketGeo = new THREE.BoxGeometry(
  M * 0.220,   // width
  M * 0.120,   // depth
  M * 0.300    // height (along barrel axis)
);
const pocket = new THREE.Mesh(pocketGeo, channelMat);
pocket.position.z = -barrelH / 2 + M * 0.15; // Near barrel bottom
pocket.name = 'DaughterPocket';
this.add(pocket);
```

**Visual only** — no collision or physics interaction.

#### Acceptance Criteria
- ✅ 4 stowage channels visible along barrel at strut azimuth positions
- ✅ Channels deeper/narrower than barrel surface
- ✅ Daughter pocket visible at barrel bottom (−Z)
- ✅ When struts stowed (α ≈ 0), struts visually align with channels

---

## 5. Dependency Graph

### ASCII Dependency Tree

```
V-1 (Barrel Mesh) ──────────────────── 1d
 │
 ├──► V-2 (Collar + Hinges) ──────── 1d
 │     │
 │     ├──► V-3 (Struts + Animation) ── 2d
 │     │     │
 │     │     ├──► V-4 (Arm Remount) ──── 1.5d    ★ HIGHEST RISK
 │     │     │     │
 │     │     │     ├──► V-8 (Net Visual) ── 1.5d
 │     │     │     │
 │     │     │     ├──► V-9 (Tier Visuals) ── 1d
 │     │     │     │     │
 │     │     │     │     └──► V-10 (Deploy LEDs) ── 0.5d
 │     │     │     │
 │     │     │     └──► V-10 (Deploy LEDs) ── 0.5d  [also from V-3]
 │     │     │
 │     │     └──► V-11 (Stowage Channels) ── 0.5d
 │     │
 │     └──► V-7 (Launch Cinematic) ── 2d  [needs V-3 struts + V-5 ROSA]
 │                    ▲
 ├──► V-5 (ROSA Panels) ───── 1.5d ──┘
 │
 ├──► V-6 (FEEP Relocation) ── 0.5d  [independent after V-1]
 │
 └──► V-11 (Stowage) ───────── 0.5d  [also depends on V-3 for alignment]
```

### Simplified DAG

```
         V-1
        / │ \  \
       /  │  \  \
      ▼   ▼   ▼  ▼
    V-2  V-5  V-6  V-11
     │    │         ▲
     ▼    │         │
    V-3 ──┼─────────┘
    / \   │
   ▼   ▼  │
 V-4   V-7◄┘  (V-7 needs V-3 + V-5)
  │\
  │ \
  ▼  ▼
V-8  V-9
      │
      ▼
    V-10
      │
      ▼
   POLISH (1d)
```

### Critical Path

```
V-1 (1d) → V-2 (1d) → V-3 (2d) → V-4 (1.5d) → V-8 (1.5d) = 7.0 days
```

With the V-7 cinematic (parallel but dependent on V-3+V-5):
```
V-1 (1d) → V-5 (1.5d) ─┐
V-1 (1d) → V-2 (1d) → V-3 (2d) ─┼→ V-7 (2d) = 6.0 days
```

**Overall critical path: 7.0–7.5 days** depending on integration polish.

### Parallel Tracks

| Track | Tasks | Duration |
|-------|-------|----------|
| **Track A (main)** | V-1 → V-2 → V-3 → V-4 → V-8 | 7.0d |
| **Track B (solar)** | V-1 → V-5 → (joins V-7) | 2.5d |
| **Track C (thrusters)** | V-1 → V-6 | 1.5d |
| **Track D (launch)** | V-3 + V-5 → V-7 | 2.0d |
| **Track E (polish)** | V-4 → V-9 → V-10; V-3 → V-11 | 2.0d |

---

## 6. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R-1 | **ArmUnit group reparenting breaks world-position calculations** | High | High | V-4 must be tested exhaustively. Verify `arm.group.getWorldPosition()` after reparenting to strut tip. Update [`getTetherAnchorWorldPosition()`](js/entities/ArmUnit.js:1505) if needed. This is the single highest-risk task. |
| R-2 | **Octagonal bus removal breaks tests referencing body geometry** | Low | Medium | Tests reference Constants and behavior, not mesh vertex counts. Full test run after V-1 to confirm. No existing test touches `_buildMainBus()` directly. |
| R-3 | **ROSA roll-out animation looks janky** | Medium | Medium | Start with `scaleX` animation (simple, reliable). Iterate to `ShapeGeometry` morph or vertex animation only if scaleX looks bad. Good-enough > perfect. |
| R-4 | **Strut animation jitter at 60 FPS** | Low | Low | Only 4–8 cylinders rotating per frame. Use `quaternion.setFromAxisAngle()` for smooth interpolation. No matrix decomposition needed. |
| R-5 | **Capture net wrap visual is hard to make look good** | Medium | Medium | Start with translucent sphere overlay on target (`SphereGeometry` + transparent material). Iterate to mesh-wrapping effect only if MVP looks poor. |
| R-6 | **Launch cinematic camera conflicts with CameraSystem** | Medium | Medium | Use dedicated `CINEMATIC` state in CameraSystem. Cinematic camera yields to player camera on `READY`. Existing camera state machine supports this pattern. |
| R-7 | **Tier transition (fade out/in) looks cheap** | Low | Low | Brief white emissive flash on barrel hides the geometry swap. This is a standard technique. |
| R-8 | **End-face arms (Y3 Octo) need different mount type** | Medium | Medium | These 2 arms are barrel-cap mounted, not collar-mounted. V-9 handles this explicitly with end-face brackets. Test separately from ring arms. |
| R-9 | **Scene scale accumulation error** | Low | High | All geometry uses `Constants.OCTOPUS_V5.* × M` (never hardcoded numbers). Consistent with existing `M = 1e-5` convention. Add regression test validating barrel dimensions. |
| R-10 | **Material disposal memory leak on tier change** | Medium | Medium | V-9 must call `.dispose()` on old geometries and materials when rebuilding struts/arms. Use helper: `disposeGroup(group)` that recursively disposes all children. |

### New Risks Identified from Code Analysis

| # | Risk | Source | Mitigation |
|---|------|--------|------------|
| R-11 | **`_buildTetherReels()` still creates bus-mounted reels** | [`PlayerSatellite.js:648`](js/entities/PlayerSatellite.js:648) — 8 reels on bus circumference | V-1 must remove this call entirely. Reel visuals move to V-4 (strut-mounted). |
| R-12 | **`_buildMagneticRing()` creates a ring not in Config G** | [`PlayerSatellite.js:711`](js/entities/PlayerSatellite.js:711) — toroidal ring at mid-bus | V-1 must remove this. Not part of Config G. Check if any logic references `this.magneticRing`. |
| R-13 | **Barrel rotation convention (`rotation.x = π/2`) affects collar/strut math** | [`PlayerSatellite.js:266`](js/entities/PlayerSatellite.js:266) — Y→Z alignment | All V-2/V-3 position math must account for this rotation. Document the convention clearly in code comments. |
| R-14 | **`_dockingCavities` array referenced elsewhere** | [`PlayerSatellite.js:315`](js/entities/PlayerSatellite.js:315) — 6 cavity planes | Search codebase for `_dockingCavities` before removing. Provide empty array as fallback. |

---

## 7. Test Strategy

### 7.1 Node Harness Tests (Automated)

These tests run in the existing Node test harness ([`js/test/run-tests.js`](js/test/run-tests.js)) **without** a browser or real THREE.js context.

| What to Test | Approach | Estimated Tests |
|-------------|----------|-----------------|
| **Config G constants unchanged** | Assert `OCTOPUS_V5` values match §10.11 spec | ~15 assertions (existing in [`test-Constants.js`](js/test/test-Constants.js)) |
| **Geometry math** | Verify strut tip positions computed from collar + azimuth + alpha match `getStrutTipPosition()` output | ~8 tests |
| **Deploy state → LED color mapping** | Unit test the color-selection logic (pure function, no THREE.js) | ~5 tests |
| **Tier layout configs** | Assert azimuth arrays and arm counts per tier | ~6 tests (existing) |
| **Launch phase sequencing** | Verify phase transitions emit correct events | Already covered by C-5 tests |
| **Net visual state mapping** | Map each net FSM state to expected visual properties (pure function) | ~14 tests (one per state) |
| **ROSA progress clamping** | Verify `getRosaProgress()` wing1/wing2 in [0,1] | Already covered |
| **No test regression** | Full suite (438 suites / 1,995 tests) must pass | 0 failures |

**New test file:** `js/test/test-Epic10-Visuals.js` — geometry math, LED mapping, tier layout validation

### 7.2 Visual Verification (Manual in Browser)

These aspects **cannot** be tested in the Node harness and require visual inspection:

| What to Verify | How | Task |
|---------------|-----|------|
| Barrel appears cylindrical | Load game, inspect spacecraft | V-1 |
| No octagonal features visible | Visual inspection | V-1 |
| Collar ring at correct height | Compare with reference diagram | V-2 |
| Strut sweep animation smooth | Trigger deploy, observe sweep | V-3 |
| Arms at strut tips, not bus faces | Visual inspection | V-4 |
| ROSA panels unfurl smoothly | Trigger launch sequence | V-5 |
| Fairing separation looks correct | Play launch cinematic | V-7 |
| Net visual tracks projectile | Fire a net at debris | V-8 |
| Tier transition animation plays | Buy Y1 Hex in shop | V-9 |
| LED colors match deploy state | Cycle through deploy states | V-10 |
| Stowage channels visible | Inspect barrel surface | V-11 |
| 60 FPS maintained | DevTools Performance panel | All |

### 7.3 Regression Guard

After each V-task completion, run `./test.sh` and verify:
```
438 suites / 1,995 tests / 0 failures
```

If any test fails, the V-task is NOT complete until the regression is fixed.

### 7.4 Snapshot Tests (Recommended Future Addition)

After Epic 10, consider adding snapshot tests that:
1. Create a headless THREE.js scene
2. Build the Config G model
3. Assert mesh counts, geometry parameter ranges, and material properties
4. Run in Node (no browser needed) using THREE.js as a library

This is a **post-Epic 10** improvement — not required for delivery.

---

## 8. Recommended Execution Order

### Phase 1: Foundation (Days 1–2)

| Day | Task | Track | What's Unlocked |
|-----|------|-------|-----------------|
| 1 (morning) | **V-1: Barrel Mesh** | A | Everything else |
| 1 (afternoon) | **V-6: FEEP Relocation** | C | Thruster visual complete |
| 2 (morning) | **V-2: Collar + Hinges** | A | Struts |
| 2 (morning) | **V-5: ROSA Panels** (parallel) | B | Launch cinematic |
| 2 (afternoon) | **V-11: Stowage Channels** | E | Surface detail complete |

**End of day 2:** Barrel + collar + ROSA + thrusters + surface detail complete. Player sees the new barrel shape with panels. Struts and arms still missing.

### Phase 2: Arms & Animation (Days 3–5)

| Day | Task | Track | What's Unlocked |
|-----|------|-------|-----------------|
| 3 | **V-3: Strut + Sweep Animation** | A | Arm remount, launch cinematic |
| 4 (morning) | **V-4: Arm Remount** (start) | A | Net visual, tiers |
| 4 (afternoon) | **V-4: Arm Remount** (complete) | A | — |
| 5 | **V-7: Launch Cinematic** (parallel with V-4) | D | Visual launch experience |

**End of day 5:** Core Config G visual complete. Struts animate, arms at tips, ROSA deploys, launch plays.

### Phase 3: Polish & Extensions (Days 6–8)

| Day | Task | Track | What's Unlocked |
|-----|------|-------|-----------------|
| 6 | **V-8: Capture Net Visual** | A | Net gameplay visual |
| 7 (morning) | **V-9: Tier Progression** | E | Shop visual feedback |
| 7 (afternoon) | **V-10: Deploy State LEDs** | E | State indicator visual |
| 8 | **Integration polish pass** | — | Bug fixes, performance tuning |

**End of day 8:** All 11 tasks complete. Full visual integration pass done.

### Priority Rationale

1. **V-1 first** because everything depends on the barrel
2. **V-6 early** because it's trivial (0.5d) and closes a track immediately
3. **V-5 parallel with V-2** because they're independent; both needed for V-7
4. **V-3 before V-4** because struts must exist before arms can mount
5. **V-4 careful and thorough** because it's high-risk (R-1, R-8)
6. **V-7 in parallel** because it only needs V-3+V-5, not V-4
7. **V-8, V-9, V-10 last** because they're leaf nodes with lower urgency
8. **Polish pass** reserves 1 full day for integration bugs

### Flag Activation Schedule (Post-Epic 10)

After all visual tasks land, enable flags in this order:

| Order | Flag | Effect |
|-------|------|--------|
| 1 | `STOW_DEPLOY_STATE_MACHINE` | Struts start LOCKED; deploy LEDs active |
| 2 | `LAUNCH_SEQUENCE` | Launch cinematic plays on new game |
| 3 | `LOCKABLE_HINGE` + `SEMI_AUTO_AIM` | Aim system goes live |
| 4 | `TETHER_REEL` + `BRIDLE_RING` | Cable physics + load distribution |
| 5 | `CAPTURE_NET` | Net projectile gameplay |
| 6 | `COM_TRACKING` + `THRUSTER_INTERLOCK` + `RECOIL_PHYSICS` | Full physics model |
| 7 | `TIER_UPGRADES` | Shop progression → Y1/Y3 |

This is a separate **gameplay tuning pass** — not part of Epic 10 itself but logically follows immediately after.

---

## Appendix A: Materials Library

Reusable materials from current codebase (keep unchanged):

| Material | Color | Properties | Source |
|----------|-------|-----------|--------|
| `_matBody` | `0x5c5c64` | metalness 0.7, roughness 0.55 | [`PlayerSatellite.js:217`](js/entities/PlayerSatellite.js:217) |
| `_matGoldMLI` | `0xccaa44` | metalness 0.75, roughness 0.4, emissive `0x332200` | [`PlayerSatellite.js:219`](js/entities/PlayerSatellite.js:219) |
| `_matDark` | `0x222233` | metalness 0.6, roughness 0.4 | [`PlayerSatellite.js:222`](js/entities/PlayerSatellite.js:222) |
| `_matThruster` | `0x555566` | metalness 0.65, roughness 0.45 | [`PlayerSatellite.js:225`](js/entities/PlayerSatellite.js:225) |
| Panel blue | `0x0a1133` | metalness 0.4, roughness 0.5, DoubleSide | [`PlayerSatellite.js:500`](js/entities/PlayerSatellite.js:500) |
| Panel grid | `0x2244aa` | wireframe, opacity 0.3 | [`PlayerSatellite.js:505`](js/entities/PlayerSatellite.js:505) |

New materials needed:

| Material | Color | Properties | Usage |
|----------|-------|-----------|-------|
| Collar ring | `0x888899` | metalness 0.7, roughness 0.3 | Collar + hinge brackets |
| Strut metal | `0x999999` | metalness 0.6, roughness 0.4 | Strut rods |
| Channel recess | `0x333344` | metalness 0.5, roughness 0.6 | Stowage channels |
| Net glow | `0x88bbff` | transparent, additive blend | Net disc + wrap |
| Fairing shell | `0xddddee` | transparent, opacity 0.3 | Launch fairing |

## Appendix B: Elements to DELETE from `_buildModel()`

These current calls in [`_buildModel()`](js/entities/PlayerSatellite.js:214) must be removed or completely rewritten:

| Call | Line | Action | Reason |
|------|------|--------|--------|
| `_buildMainBus()` | [`261`](js/entities/PlayerSatellite.js:261) | **REWRITE** | Octagonal → cylindrical barrel |
| `_buildSolarPanels()` | [`499`](js/entities/PlayerSatellite.js:499) | **REWRITE** | Large wings → ROSA panels |
| `_buildTetherReels()` | [`648`](js/entities/PlayerSatellite.js:648) | **DELETE** | Bus-mounted reels → strut-mounted (in V-4) |
| `_buildMagneticRing()` | [`711`](js/entities/PlayerSatellite.js:711) | **DELETE** | Not in Config G spec |

Keep and relocate:
| Call | Line | Action |
|------|------|--------|
| `_buildThrusters()` | [`406`](js/entities/PlayerSatellite.js:406) | **MODIFY** (V-6) |
| `_buildSensors()` | [`591`](js/entities/PlayerSatellite.js:591) | **RELOCATE** to barrel front |
| `_buildDockingPort()` | [`741`](js/entities/PlayerSatellite.js:741) | **RELOCATE** to barrel front or bottom |
| `_buildNavLights()` | [`781`](js/entities/PlayerSatellite.js:781) | **ADJUST** positions for smaller barrel |
| `_buildRcsPuffPool()` | [`818`](js/entities/PlayerSatellite.js:818) | **KEEP** (no change needed) |

New calls to add:
| Call | Task |
|------|------|
| `_buildCollar()` | V-2 |
| `_buildStruts()` | V-3 |
| `_buildRosaPanels()` | V-5 |
| `_buildStowageDetails()` | V-11 |

---

*End of Epic 10 Implementation Plan. This document is the authoritative implementation reference for all V-1..V-11 tasks.*
