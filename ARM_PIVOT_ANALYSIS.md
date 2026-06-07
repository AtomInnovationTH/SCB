# Arm Pivot Geometry Analysis — Epic 9 Blocker

> **Status:** Design analysis, pending user signoff. **No code changes.**
> **Blocking:** ST-9.3 (Crossbow 1-DOF) cannot proceed until pivot configuration is decided.
> **Triggered by:** User observation that hinge position on the Mother body is a critical unresolved design decision.
> **Created:** 2026-04-26. **Author:** Architect mode.

---

## Table of Contents

1. [Executive Summary & Scoring Table](#1-executive-summary--scoring-table)
2. [ASCII Geometry Diagrams](#2-ascii-geometry-diagrams)
3. [Per-Config Analysis](#3-per-config-analysis)
4. [Antipodal-Pair Recoil-Cancellation Math](#4-antipodal-pair-recoil-cancellation-math)
5. [What Else Has Been Overlooked](#5-what-else-has-been-overlooked)
6. [Recommended Config & Rationale](#6-recommended-config--rationale)
7. [Doc Updates Required](#7-doc-updates-required)
8. [Code Rework Estimate](#8-code-rework-estimate)
9. [Open Questions for User Signoff](#9-open-questions-for-user-signoff)

---

## §1 Executive Summary & Scoring Table

### Recommendation

**Config F (Equatorial Yaw + Spacecraft Attitude)** is recommended as the primary configuration, with elements of Config C adopted as a **future upgrade path (Y3 Octo only)** for the dedicated Front/Back arms.

Config A (current equatorial yaw) is 90% correct as-is. The critical missing piece is not the hinge geometry — it is the **explicit doctrine that Mother attitude rotation provides the second aim axis**. By formally adopting Config F, we:

1. Preserve all existing ST-9.2 code ([`ArmManager.generateDockPositions()`](js/entities/ArmManager.js:41))
2. Preserve the planar-departure tether model that [`CAPTURE_NET.md §4`](CAPTURE_NET.md:519) depends on
3. Get full-hemisphere aim coverage through the combination of ±30° strut yaw + Mother attitude rotation
4. Avoid the recoil-cancellation failure inherent in barrel-axial configs (see §4)
5. Keep launch fairing complexity minimal (all arms stow radially, no long struts along the barrel)

Config C (barrel-axial, top-collar) is **genuinely superior for forward/backward engagement** and should be adopted for the Y3 Octo Front/Back arms when those are unlocked. But it introduces unresolvable recoil-cancellation issues for the main ring arms and fundamentally breaks the equatorial antipodal-pair geometry that the Y0/Y1 tiers depend on.

### Scoring Table

Scale: ★★★★★ = excellent, ★☆☆☆☆ = poor. Blank = not meaningfully different.

| Assessment Axis | A: Equatorial Yaw | B: Tangential Pitch | C: Barrel-Axial Top | D: Barrel-Axial Bottom | E: Dual-Collar | F: Equatorial + Attitude (★) |
|---|---|---|---|---|---|---|
| **Aim envelope** | ★★★☆☆ | ★★★☆☆ | ★★★★★ | ★★★★☆ | ★★★★★ | ★★★★☆ |
| **Stow geometry / fairing** | ★★★★★ | ★★★★★ | ★★☆☆☆ | ★★★☆☆ | ★★☆☆☆ | ★★★★★ |
| **Plume map** | ★★★★☆ | ★★★☆☆ | ★★★☆☆ | ★★☆☆☆ | ★★★☆☆ | ★★★★☆ |
| **Recoil cancellation** | ★★★★★ | ★★★★☆ | ★★☆☆☆ | ★★☆☆☆ | ★★★★☆ | ★★★★★ |
| **Cable/tether routing** | ★★★★★ | ★★★★☆ | ★★☆☆☆ | ★★☆☆☆ | ★★☆☆☆ | ★★★★★ |
| **CoM shift during sweep** | ★★★★★ | ★★★☆☆ | ★★☆☆☆ | ★★☆☆☆ | ★★★☆☆ | ★★★★★ |
| **Hinge hardware** | ★★★★★ | ★★★★☆ | ★★★☆☆ | ★★★☆☆ | ★★☆☆☆ | ★★★★★ |
| **Tether anchor load path** | ★★★★★ | ★★★★☆ | ★★★☆☆ | ★★★☆☆ | ★★★☆☆ | ★★★★★ |
| **Daughter-thrust integration** | ★★★☆☆ | ★★★☆☆ | ★★★★★ | ★★★★☆ | ★★★★★ | ★★★★☆ |
| **Fishing-pole metaphor** | ★★★☆☆ | ★★★☆☆ | ★★★★★ | ★★★★☆ | ★★★★★ | ★★★☆☆ |
| **Net launch geometry** | ★★★★★ | ★★★★☆ | ★★★☆☆ | ★★★☆☆ | ★★★☆☆ | ★★★★★ |
| **Mass impact** | ★★★★★ | ★★★★☆ | ★★★☆☆ | ★★★☆☆ | ★★☆☆☆ | ★★★★★ |
| **Code rework cost** | ★★★★★ | ★★★☆☆ | ★☆☆☆☆ | ★☆☆☆☆ | ★☆☆☆☆ | ★★★★★ |
| **TOTAL (out of 65)** | **58** | **48** | **41** | **37** | **42** | **61** |

---

## §2 ASCII Geometry Diagrams

### Coordinate Convention

The Mother bus is an octagonal prism:
- **Y-axis:** Up/zenith (Three.js convention; also "barrel axis" in user's framing)
- **Z-axis:** Prograde (+Z) / retrograde (-Z)
- **X-axis:** Completes right-hand system (starboard)
- [`CORE_ACROSS_FLATS: 1.0`](js/core/Constants.js:273) m, [`CORE_LENGTH: 1.2`](js/core/Constants.js:274) m

**Critical dimension note:** The Mother bus is **only 1.2 m long × 1.0 m wide** — nearly a cube. The user's "long vertical barrel" framing implies a more elongated shape. If the bus were 3:1 aspect ratio (e.g., 0.6m × 1.8m), Config C would be much more attractive. At the current 1.2:1 ratio, struts running "almost full length of barrel" are only ~1 m long, limiting Config C's advantage. This is flagged as **Open Question Q-1** in §9.

### Config A — Equatorial Yaw (current ST-9.2)

```
  FRONT VIEW (looking -Z, aft)         SIDE VIEW (looking -X, from starboard)

        +Y (zenith)                         +Y (zenith)
         ↑                                   ↑
         │                                   │    ┌──────┐
    LD ──┤── SD                              │    │ SOLAR│
   ←30°  │  →                                │    │ WING │
  ╱──────┼──────╲   ±30° yaw sweep      ┌────┼────┤──────├────┐
 SD      │      LD  in XZ plane          │    │    │ BUS  │    │
  ╲──────┼──────╱                        │-Z──┼────┤ 1.0m │────┼──+Z
         │                               │aft │    │      │fwd │
         │                               └────┼────┤──────├────┘
         ↓                                    │    │ SOLAR│
        -Y (nadir)                            │    │ WING │
                                              ↓    └──────┘
  Arms mount on equator (Y=0),               -Y
  radially outward. Sweep ±30° yaw
  in the dock-tangent plane.

  STOW: Arms extend radially, flat     STOW: Arms radial, within
  against octagonal faces.              fairing envelope.

  MID-DEPLOY: Arms swing ±30° in       MID-DEPLOY: No Y change.
  the horizontal plane.                 Arms stay at Y=0.
```

### Config B — Tangential Pitch

```
  FRONT VIEW                            SIDE VIEW

        +Y                                  +Y
         ↑                                   ↑   
         │  ↗ arm pitched up                 │   ↗
    LD ──┤── SD                              │  ╱ arm pitched
         │                                   │ ╱  up by θ
  ╱──────┼──────╲  ±θ pitch in          ┌────┼╱───────────┐
 SD      │      LD meridian plane       │    ●────────────┤
  ╲──────┼──────╱                       │    │╲   BUS     │
         │  ↘ arm pitched down          └────┼─╲──────────┘
         │                                   │  ╲ arm pitched
         ↓                                   │   ╲  down
        -Y                                   ↓    ↘
                                             -Y
  Hinge axis: tangent to equator.
  Sweep: arms tilt up/down in
  the plane containing Y and
  the dock-radial direction.
```

### Config C — Barrel-Axial, Top-Collar Mount, 180° Sweep

```
  FRONT VIEW                            SIDE VIEW (key diagram)

        +Y                                  +Y (zenith)
         ↑                                   ↑
         │   ╱ 180° deployed                 │  ╱ FULLY DEPLOYED (α=180°)
         │  ╱  (above Mother)                │ ╱  (pointing up)
    ●────┤── ●  hinges on                    │╱
    │    │   │  top collar              ┌────●════════════════╗ ←hinge
    │    │   │                          │    │    BUS 1.2m    ║ strut
    │    │   │  struts ~1.0m            │    │                ║ ~1.0m
    │    │   │  along barrel            │    │                ║
    │    │   │                          │    │                ║
    │    │   │  (daughters              └────┤                ╚═══► α=90°
    │    │   │   at tips)                    │                (radial out)
    ▼    │   ▼                               │
  STOW   │  STOW                             ╚═══════════════▼ α=0°
  (-Y)   ↓  (-Y)                             STOWED (alongside barrel,
        -Y                                   daughter near bottom)

  4 hinges on top collar, 90° apart.
  Each strut swings 0→180° in its
  own meridian plane.

  KEY ADVANTAGE: Can fire prograde (+Z),
  retrograde (-Z), radial, or along
  barrel axis — 180° of meridian
  sweep per arm.
```

### Config D — Barrel-Axial, Bottom-Collar Mount

```
  Same as Config C but mirrored:
  hinges at -Y collar, arms stow
  pointing up (+Y), sweep through
  equator to point down (-Y).

  SIDE VIEW:

        +Y
         ↑
         ╔═══════════════▲ α=0° STOW
         ║               (alongside barrel,
         ║               daughter near top)
         ║
    ┌────║───────────────┐
    │    ║    BUS         │
    │    ║                │
    │    ║                │
    └────●════════════════╝ ←hinge at bottom collar
         │╲
         │ ╲ α=90° (radial out)
         │  ╲
         ↓   ╲ α=180° (pointing down)
        -Y

  NOTE: Stowed struts near top
  place mass above CoM — unstable
  for gravity-gradient. Thrusters
  at bottom (-Z face) are
  obstructed by hinges.
```

### Config E — Dual-Collar, Opposing Pair Stow

```
  SIDE VIEW:

        +Y
         ↑
         ╔══arm 3 stow══▲ (from bottom collar)
         ║               │
    ┌────●═arm 1═════════╗ ←top collar hinge
    │    │    BUS         ║
    │    │                ║ arm 1 (top)
    │    │                ║
    └────●═arm 2═════════╝ ←bottom collar hinge
         ║               │
         ╚══arm 4 stow══▼ (from top collar)
         ↓
        -Y

  Top collar: arms 1, 3 (stow down)
  Bottom collar: arms 2, 4 (stow up)
  Interleaved along barrel when stowed.

  Each arm can sweep 180° in its
  meridian plane.
  Antipodal pairs: (top θ, bottom θ)
  — perfect cancel at matching α.
```

### Config F — Equatorial Yaw + Spacecraft Attitude (Recommended)

```
  FRONT VIEW                          OPERATIONAL CONCEPT

        +Y                           Target above (+Y):
         ↑                             Mother pitches up via RCS
         │                             Arms still aim ±30° yaw
    LD ──┤── SD                        in the rotated plane.
   ←30°  │  →
  ╱──────┼──────╲  ±30° yaw          Target off-plane:
 SD      │      LD (same as A)         Mother yaws about Y first,
  ╲──────┼──────╱                      then arms fine-aim ±30°.
         │
         ↓                           ┌─────────────────────────┐
        -Y                           │ DOF 1: Strut yaw ±30°  │
                                      │ DOF 2: Mother attitude  │
  Geometry is IDENTICAL to A.         │        (FEEP/RCS)       │
  The "second axis" is the            │ Combined: full 4π sr    │
  Mother's own attitude control.      │ (minus thruster-blocked │
                                      │  exclusion zones)       │
  Solar panel power: recovered        └─────────────────────────┘
  by returning to sun-point
  after each aim maneuver.
```

### Solar Panel & Thruster Placement (All Configs)

```
  TOP VIEW (looking down +Y axis, relevant for all configs)

                    +Z (prograde)
                        ↑
                   ┌────┤────┐
           ┌───── │  LASER   │ ─────┐
           │      │ APERTURE │      │
  SOLAR────│  W1  ├──────────┤  S1  │────SOLAR
  WING     │  ●   │  OCTA-   │   ●  │    WING
  PORT     │      │  GONAL   │      │    STBD
  3m span──│  W3  │   BUS    │  W2  │──3m span
           │  ●   │  1.0m    │   ●  │
           │      │ across   │      │
           └───── │  flats   │ ─────┘
                  ├──────────┤
                  │ HT-L  HT-R │
                  │ S-BAND ANT │
                  └────┤────┘
                       ↓
                    -Z (retrograde)

  Solar wings: mid-height (Y≈0), port+starboard, 3m span each
  Hall thrusters: aft face (-Z), 2× HT-100
  Laser aperture: forward face (+Z), 20cm Cassegrain
  S-band antenna: aft face (-Z), patch array

  For Config C: struts stowed along barrel (Y-axis) fit
  BETWEEN the solar wing plane and the bus surface.
  BUT deployed struts at α≈70-110° CROSS the solar wing plane.
  ⚠️ WING-STRUT INTERFERENCE is the principal Config C obstacle.
```

---

## §3 Per-Config Analysis

### §3.1 Config A — Equatorial Yaw, Mid-Collar Mount (Current)

**Geometry:** Arms on octagonal equator (Y=0), radially outward. 1-DOF yaw ±30° in dock-tangent plane. Currently implemented in [`ArmManager.generateDockPositions()`](js/entities/ArmManager.js:41-60).

| Axis | Assessment |
|------|-----------|
| Aim envelope | ±30° yaw per arm. Off-plane targets require Mother rotation. Effective hemisphere ≈ 2π sr with Mother rotation, but only the equatorial band is accessible without Mother maneuver. |
| Stow geometry | Excellent — arms radially compact, well within any standard fairing. |
| Plume map | Body-ring arms clear of Hall thrusters (aft). Solar wing interference at W2/S3 per [`CROSSBOW_ARMS.md §17.3`](CROSSBOW_ARMS.md:2253). Guide rails solve this. |
| Recoil cancellation | Perfect — antipodal pairs at same height produce zero net force and zero net torque (§4 proof). |
| Cable/tether routing | Simple — tether exits radially from dock face, enters bus wall to reel directly behind. Short path, no bends across moving joints. |
| CoM shift | Minimal — arms sweep ±30° at Y=0; no vertical mass displacement. |
| Hinge hardware | Single harmonic-gear joint, TRL 9 ([`BIG_PICTURE.md §12.4`](BIG_PICTURE.md:386)). |
| Tether anchor load path | Direct radial path from arm through bus wall to spool. Capture jerk loads the bus face in compression. |
| Daughter-thrust integration | Daughter Δv is perpendicular to orbit velocity (radial). Cannot directly assist prograde/retrograde acceleration. |
| Fishing-pole metaphor | Arms extend sideways like spokes, not like fishing rods from a boat. Visually distinct from fishing pole. |
| Net launch geometry | Excellent — equatorial in-plane departure matches [`CAPTURE_NET.md §4`](CAPTURE_NET.md:519) planar-departure assumption perfectly. |
| Mass impact | Zero delta from current baseline (198.4 kg Y0 dry). |
| Code rework | Zero — this IS the current implementation. |

**Verdict:** Solid, reliable, minimal risk. Weak on aim envelope without Mother rotation.

### §3.2 Config B — Tangential Pitch, Mid-Collar Mount

**Geometry:** Same equatorial dock position. Hinge axis tangent to equator at dock. Arms tilt up/down in meridian plane (Y × dockOutward).

| Axis | Assessment |
|------|-----------|
| Aim envelope | ±θ pitch in meridian plane. Better vertical coverage than A but no horizontal yaw. Complementary to A but not superior as standalone. |
| Stow geometry | Same as A (arms radially outward when stowed at θ=0). |
| Plume map | Arms pitching up could intersect solar wing plane. Arms pitching down approach nadir radiator. Medium concern. |
| Recoil cancellation | Good but imperfect — pitch introduces Y-component. Antipodal pair at angle θ: net Y-force = 2F sin θ (see §4.2). Cancels only at θ=0 (equatorial). |
| Cable/tether routing | Tether must traverse Across a pitch hinge. Flex harness needed, increasing wear. |
| CoM shift | Arms pitching up/down moves mass in Y. At ±30° pitch and 0.5m strut: δY = ±0.25m, shifting CoM ~10mm per arm. Non-trivial for attitude. |
| Hinge hardware | Same harmonic gear, different axis orientation. No additional complexity. |
| Tether anchor load path | Off-axis loads when pitched. Bus face sees shear + bending, not pure compression. |
| Daughter-thrust integration | Better than A for vertical targets but still limited. |
| Fishing-pole metaphor | Slightly better — arms tilt like fishing rods. But only in the pitch plane. |
| Net launch geometry | Tether exits the meridian plane, not the dock-tangent plane. **Breaks** the planar-departure assumption in [`CAPTURE_NET.md §4`](CAPTURE_NET.md:519)! Tangle model needs rework. |
| Mass impact | +0.5 kg for flex harnesses. |
| Code rework | Moderate — [`generateDockPositions()`](js/entities/ArmManager.js:41) needs new [`dockOutward`](js/entities/ArmManager.js:50) convention. Aim API changes. |

**Verdict:** No clear advantage over A. Introduces recoil issues and breaks CAPTURE_NET planar model.

### §3.3 Config C — Barrel-Axial, Top-Collar Mount, 180° Sweep

**Geometry:** 4 hinges at top collar (Y = +0.6m), 90° apart. Struts ~1.0m long run along barrel. Sweep 0° (stowed, daughter at Y ≈ -0.4m) → 90° (radial) → 180° (daughter at Y ≈ +1.6m, above Mother).

This is the user's proposed configuration.

| Axis | Assessment |
|------|-----------|
| Aim envelope | **Excellent** — 180° meridian sweep per arm. 4 arms at 90° azimuth intervals cover ~95% of 4π sr. Daughter thrust along any direction in the sweep plane. Best aim coverage of all configs. |
| Stow geometry | **Poor** — stowed struts extend 1.0m below the top collar, placing daughters at Y ≈ -0.4m (mid-barrel). The daughters occupy the same bus-face area where body-mounted equipment lives. Launch fairing must accommodate 1.0m struts along the barrel — tight with 1.2m barrel length. |
| Plume map | Hall thrusters at -Z face conflict with struts at α ≈ 90° when hinge is near the +Z side of the collar. Solar wing at Y=0 is crossed by every strut at α ≈ 55-125° — **MAJOR interference zone**. Requires wing fold or strut notch. |
| Recoil cancellation | **FAILS** for non-equatorial fire (see §4.3). Antipodal top-collar pair at swing angle α produces net Y-force = -2F cos α. Only cancels at α = 90° (equatorial fire). Barrel-axis fire (α = 0° or 180°) has MAXIMUM residual recoil. |
| Cable/tether routing | **Complex** — tether must route from the spine reel (inside bus) up to the top collar, then through a rotary joint across the hinge, then along the 1.0m strut to the daughter. The rotary joint must accommodate 180° of rotation while maintaining tether integrity. This is a novel mechanism with no flight heritage at this scale. |
| CoM shift | **Large** — a 6.6 kg Weaver at full 1.0m strut swinging from α=0 to α=180° moves its mass by 2.0m in Y (from -0.4m to +1.6m). CoM shift: 6.6 × 2.0 / 244.4 = 54mm. For 4 arms simultaneously: up to 216mm. This is a **major attitude disturbance**. |
| Hinge hardware | 180° rotary joint with tether pass-through. More complex than ±30° harmonic gear. Needs slip ring or cable wrap drum. ~0.8 kg per hinge (2× mass of equatorial hinge). |
| Tether anchor load path | Capture jerk at 1.0m lever arm creates bending moment on collar mounting bracket. At 500N capture load × 1.0m arm = 500 N·m at the hinge. Current bus face loads are ~250 N·m. Collar bracket must be reinforced. +1-2 kg structural mass. |
| Daughter-thrust integration | **Excellent** — daughter at α=0° (stowed) thrusts along -Y, at α=180° along +Y. Combined with Mother's own thrusters, the entire platform can coordinate acceleration/deceleration with daughter thrust vectors. This IS the user's key insight. |
| Fishing-pole metaphor | **Excellent** — a long strut sweeping from the top of the barrel looks exactly like a fishing pole hinged at the stern of a boat. Most visually evocative of all configs. |
| Net launch geometry | Net departs in the meridian plane of the strut, not the equatorial plane. **Breaks** [`CAPTURE_NET.md §4`](CAPTURE_NET.md:519) planar model at any α ≠ 90°. Tangle model needs full rework for 3D departure geometry. |
| Mass impact | +3.2 kg per arm (heavier hinge + longer strut + cable wrap + collar reinforcement). For 4 arms: +12.8 kg. Y0 dry mass rises from 198.4 to ~211 kg. **Significant.** |
| Code rework | **Major** — [`generateDockPositions()`](js/entities/ArmManager.js:41) requires complete replacement. The equatorial θ-spacing model is invalid. New arc-sweep geometry, new aim API (`setAimAlpha(α)` replacing `setAimYaw(yaw)`), new recoil math, new tether routing model. Estimated 5-7 person-days net new code. |

**Verdict:** Best aim envelope and metaphor. But recoil failure, solar wing interference, CoM shifts, tether routing complexity, and mass penalty are substantial. Not viable as the Y0 baseline. Could work as Y3 Octo Front/Back arm geometry only.

### §3.4 Config D — Barrel-Axial, Bottom-Collar Mount

Mirror of Config C with hinges at Y = -0.6m.

**Differences from C:**
- Stow: daughters point UP (+Y), away from thrusters. Better for launch lock.
- Hall thruster conflict: **worse** — hinges at bottom collar are adjacent to aft face thrusters. Struts at low α sweep directly through HT plume cone.
- Gravity gradient: stowed mass at top is destabilizing for gravity-gradient orientation.
- Daughter-thrust: at α=180° (pointing down), daughter thrust assists deorbit. Good.

**Verdict:** Strictly worse than Config C due to thruster proximity. Not recommended.

### §3.5 Config E — Dual-Collar, Opposing Pair Stow

**Geometry:** 2 arms on top collar + 2 on bottom collar (for Y0 Quad). Top arms stow down, bottom arms stow up. Interleaved along the barrel.

| Axis | Assessment |
|------|-----------|
| Aim envelope | Same as Config C — 180° per arm, full hemisphere. |
| Recoil cancellation | **Better than C** — a top-collar arm at azimuth θ paired with bottom-collar arm at same azimuth θ cancels perfectly at any swing angle α (see §4.5 proof). But requires pairing top-with-bottom, not top-with-top. |
| Stow geometry | **Worst** — arms interleave along the barrel, with top-stowed daughters near bottom and bottom-stowed daughters near top. The barrel is packed solid with folded struts. Leaves no room for body-mounted equipment on the cylindrical surface. |
| Mass impact | +~16 kg (8 heavy hinges with cable wraps, reinforced collars top and bottom). |
| Code rework | **Major** — requires completely new dock geometry model with top/bottom collar logic, paired-fire pairing rules across collars, new stow/deploy animation. |

**Verdict:** Solves recoil cancellation but at severe mass and complexity cost. The barrel becomes a strut storage tube with no room for other hardware.

### §3.6 Config F — Equatorial Yaw + Spacecraft Attitude (Recommended)

**Geometry:** Identical to Config A. The change is **doctrinal, not mechanical**: Mother attitude rotation is formally designated as the second aim axis. This is already implicitly described in [`CROSSBOW_ARMS.md §25.4`](CROSSBOW_ARMS.md:3652) and [`BIG_PICTURE.md §12.4`](BIG_PICTURE.md:386) but never explicitly called out as the primary off-axis targeting mechanism.

| Axis | Assessment |
|------|-----------|
| Aim envelope | Full 4π sr minus exclusion zones (thruster plumes, solar panel shadow). **Better than A** because it's formally documented as a capability, not an afterthought. Players understand: "Yaw the strut for fine aim, rotate the Mother for coarse aim." |
| All mechanical axes | Identical to Config A — inherits all Config A advantages. |
| Daughter-thrust integration | **Better than A** — with the doctrine explicit, daughter Δv coordination during prograde/retrograde fire is a recognized capability. Mother rotates to point arms along velocity vector, daughters fire crossbow along V-bar, then Mother rotates back. The "fishing backwards" maneuver becomes a formal procedure. |
| Code rework | **Minimal** — add attitude-aim command queue to [`AutopilotSystem`](js/systems/AutopilotSystem.js:1). Add "AIM_ROTATE" state to pre-fire sequence. UI: show aim arc on NavSphere. No changes to [`ArmManager`](js/entities/ArmManager.js:1) or [`Constants`](js/core/Constants.js:254). |
| Solar panel cost | Per [`CROSSBOW_ARMS.md §8.4`](CROSSBOW_ARMS.md:1038): rotate 90° costs 3.7 Wh from 600 Wh battery. At 10 aims per mission: 37 Wh = 6% of battery. Acceptable. |
| RCS cost | Per [`CROSSBOW_ARMS.md §8.1`](CROSSBOW_ARMS.md:996): 5.5g N₂ per 30° aim. At 10 aims: 55g from 6000g budget = 0.9%. Trivial. |

**Verdict:** All the benefits of Config A with explicit full-sphere coverage. Minimal code changes. No mass penalty. No recoil issues. Preserves all CAPTURE_NET assumptions. The "missing piece" was always doctrinal, not mechanical.

---

## §4 Antipodal-Pair Recoil-Cancellation Math

### §4.1 Setup

Let the Mother bus have mass M. An arm of mass m fires with velocity v in direction **d̂** (unit vector). The recoil impulse on the Mother is:

```
J_mother = -m·v·d̂
```

For dual-fire, two arms fire simultaneously:

```
J_total = -m₁·v₁·d̂₁ - m₂·v₂·d̂₂
```

For perfect cancellation: J_total = **0**, requiring m₁v₁**d̂₁** = -m₂v₂**d̂₂**.

If both arms are same type (m₁ = m₂, v₁ = v₂): **d̂₁ = -d̂₂** (opposite directions).

Torque cancellation additionally requires that both impulse lines pass through the CoM, or that the moment arms are equal and opposite.

### §4.2 Config A / F — Equatorial Yaw (Proof of Perfect Cancellation)

Arms on the equator at angles θ_i, firing radially outward with optional ±30° yaw:

```
Arm at azimuth θ, yaw angle ψ (|ψ| ≤ 30°):

  Dock radial: r̂ = (cos θ, 0, sin θ)
  Dock tangent: t̂ = (-sin θ, 0, cos θ)

  Fire direction: d̂ = r̂·cos ψ + t̂·sin ψ
                    = (cos θ cos ψ - sin θ sin ψ, 0, sin θ cos ψ + cos θ sin ψ)
                    = (cos(θ+ψ), 0, sin(θ+ψ))

Antipodal arm at θ + π, yaw ψ₂:
  d̂₂ = (cos(θ+π+ψ₂), 0, sin(θ+π+ψ₂))
      = (-cos(θ+ψ₂), 0, -sin(θ+ψ₂))

For cancellation: d̂₁ + d̂₂ = 0
  → cos(θ+ψ₁) = cos(θ+ψ₂) and sin(θ+ψ₁) = sin(θ+ψ₂)
  → ψ₁ = ψ₂

RESULT: Antipodal pair with EQUAL yaw angles → PERFECT force cancellation. ✓

Y-component is always 0:
  Both arms fire in the XZ plane (Y=0). No vertical force. ✓

Torque check:
  Both arms fire from the equator (Y=0) at radius R from bus center.
  Force lines are radial (pass through center) at ψ=0, or
  offset by R·sin(ψ) at yaw ψ.

  Arm 1 at (R cos θ, 0, R sin θ) firing d̂₁:
    Torque = r₁ × (m·v·d̂₁) = (R cos θ, 0, R sin θ) × m·v·(cos(θ+ψ), 0, sin(θ+ψ))
    = m·v·R·(0, cos θ sin(θ+ψ) - sin θ cos(θ+ψ), 0) [Y-component only]
    = m·v·R·(0, sin ψ, 0)

  Arm 2 at (-R cos θ, 0, -R sin θ) firing d̂₂ = -d̂₁:
    Torque = (-R cos θ, 0, -R sin θ) × m·v·(-cos(θ+ψ), 0, -sin(θ+ψ))
    = m·v·R·(0, (-cos θ)(-sin(θ+ψ)) - (-sin θ)(-cos(θ+ψ)), 0)
    = m·v·R·(0, cos θ sin(θ+ψ) - sin θ cos(θ+ψ), 0)
    = m·v·R·(0, sin ψ, 0)

  NET TORQUE = 2·m·v·R·sin ψ·ŷ

  At ψ = 0° (radial fire): NET TORQUE = 0 ✓
  At ψ = 30°: NET TORQUE = 2 × 6.6 × 10 × 0.5 × sin(30°) × ŷ = 33 N·m·ŷ

  This is a Y-axis torque (spin-up). Manageable by RCS or reaction wheels,
  but NOT zero for off-axis yaw fire. Noted as a residual.
```

**Summary for Config A/F:** Force cancellation is perfect for equal-yaw antipodal pairs. Torque cancellation is perfect at ψ=0; residual spin torque at ψ≠0, max 33 N·m·s impulse at ψ=30°. RCS handles this in <1 s per [`CROSSBOW_ARMS.md §16.1`](CROSSBOW_ARMS.md:2026).

### §4.3 Config C — Barrel-Axial, Top-Collar (Proof of Residual Recoil)

Arms hinged at top collar. Hinge at azimuth θ. Swing angle α (0=stowed pointing -Y, 90°=radial, 180°=pointing +Y).

```
Derivation (see §2 geometry):

  Hinge axis: â = (-sin θ, 0, cos θ)  [tangent to collar at azimuth θ]

  Fire direction at swing angle α:
    d̂(θ, α) = (sin α cos θ, -cos α, sin α sin θ)

  Proof: Rodrigues rotation of (0,-1,0) by α around â.
    k = â, v = (0,-1,0)
    k×v = (-sin θ, 0, cos θ) × (0,-1,0) = (0·0 - cos θ·(-1), cos θ·0 - (-sin θ)·0, (-sin θ)·(-1) - 0·0)
        = (cos θ, 0, sin θ)
    k·v = 0

    v_rot = v cos α + (k×v) sin α = (sin α cos θ,  -cos α,  sin α sin θ)  ✓

Antipodal pair: arms at θ and θ+π, both at swing angle α:

  d̂₁ = (sin α cos θ,  -cos α,  sin α sin θ)
  d̂₂ = (sin α cos(θ+π),  -cos α,  sin α sin(θ+π))
      = (-sin α cos θ,  -cos α,  -sin α sin θ)

  d̂₁ + d̂₂ = (0,  -2cos α,  0)

  NET FORCE = -m·v·(0, -2cos α, 0) = (0, 2mv cos α, 0)

  ┌──────────────────────────────────────────────────────────┐
  │ RESIDUAL RECOIL = 2mv cos α along +Y (upward)           │
  │                                                          │
  │ At α = 0° (fire down):   F_residual = 2mv = 132 N·s     │
  │ At α = 45°:              F_residual = 2mv·0.707 = 93 N·s│
  │ At α = 90° (equatorial): F_residual = 0  ← ONLY ZERO    │
  │ At α = 135°:             F_residual = -93 N·s (downward) │
  │ At α = 180° (fire up):   F_residual = -132 N·s           │
  └──────────────────────────────────────────────────────────┘
```

**For a Weaver dual-fire at α=45° (typical targeting angle):**
Residual impulse = 2 × 6.6 × 10 × cos(45°) = 93.3 kg·m/s along Y.
Mother recoil velocity: 93.3 / 244.4 = 0.38 m/s.
RCS cost to compensate: 93.3 / (60 × 9.81) = 0.159 kg N₂.

Over 15 dual-fires: 2.4 kg N₂ = 40% of budget. **Not sustainable.**

**Config C FAILS the recoil requirement for non-equatorial fire.**

### §4.4 Config B — Tangential Pitch (Residual Shown)

```
Arm at equatorial dock θ, pitched by angle φ in the meridian plane:

  d̂(θ, φ) = (cos θ cos φ,  sin φ,  sin θ cos φ)

  Antipodal pair at θ and θ+π, same pitch φ:
  d̂₁ = (cos θ cos φ,  sin φ,  sin θ cos φ)
  d̂₂ = (-cos θ cos φ,  sin φ,  -sin θ cos φ)

  d̂₁ + d̂₂ = (0,  2sin φ,  0)

  RESIDUAL RECOIL = 2mv sin φ along +Y.
```

Same structural problem as Config C. Non-zero residual for any pitch ≠ 0.

### §4.5 Config E — Dual-Collar (Proof of Cancellation)

```
Top-collar arm at azimuth θ, swing α:
  d̂_top(θ, α) = (sin α cos θ,  -cos α,  sin α sin θ)    [from §4.3]

Bottom-collar arm at SAME azimuth θ, swing β:
  Hinge axis: â = (-sin θ, 0, cos θ)  [same tangent direction]
  Stow direction: (0, +1, 0) [points up from bottom collar]

  Rodrigues rotation of (0,+1,0) by β around â:
    k×v = (-sin θ, 0, cos θ) × (0,1,0) = (0·0 - cos θ·1, cos θ·0 - (-sin θ)·0, (-sin θ)·1 - 0·0)
        = (-cos θ, 0, -sin θ)
    k·v = 0

    d̂_bot(θ, β) = (0,1,0) cos β + (-cos θ, 0, -sin θ) sin β
                 = (-sin β cos θ,  cos β,  -sin β sin θ)

  For equal swing (α = β):
    d̂_top + d̂_bot = (sin α cos θ - sin α cos θ,  -cos α + cos α,  sin α sin θ - sin α sin θ)
                    = (0, 0, 0)  ✓ PERFECT CANCELLATION

  ┌──────────────────────────────────────────────────────────┐
  │ Config E: Top-collar arm + bottom-collar arm at SAME     │
  │ azimuth + SAME swing angle → PERFECT force cancellation  │
  │ at ANY angle α.                                          │
  │                                                          │
  │ BUT: requires both arms to be at the same swing angle.   │
  │ If arms are tracking different targets at different α,    │
  │ cancellation breaks.                                     │
  └──────────────────────────────────────────────────────────┘
```

Config E works but demands coordinated fire — both arms in a pair must fire at the same swing angle. This is operationally restrictive.

### §4.6 Recoil Summary Table

| Config | Force Cancel | Torque Cancel | Constraint | Residual (max) |
|--------|-------------|---------------|-----------|---------------|
| **A/F** | ✅ Perfect | ✓ Perfect at ψ=0; residual at ψ≠0 | Same-type pair, equal yaw | 33 N·m·s (manageable) |
| **B** | ❌ Y-residual | ❌ | Same pitch | 2mv at max pitch |
| **C** | ❌ Y-residual | ❌ | Same α | 2mv at α=0/180° |
| **D** | ❌ Y-residual | ❌ | Same α | 2mv at α=0/180° |
| **E** | ✅ Perfect | ✅ Perfect | Same θ, same α, top+bottom | Zero (constrained) |
| **F** | ✅ Perfect | ✓ Same as A | Same-type pair, equal yaw | 33 N·m·s (manageable) |

---

## §5 What Else Has Been Overlooked

The user explicitly asked: *"What else has been overlooked?"* Below is a numbered gap list based on a sweep of all existing docs and code.

### BLOCKER (must resolve before ST-9.3)

| # | Gap | Details | Target ST |
|---|-----|---------|-----------|
| 1 | **Hinge position doctrine** — the gap that triggered this analysis. No doc specifies WHERE on the Mother body the arm hinges attach, only that they exist. | [`CROSSBOW_ARMS.md §25.4`](CROSSBOW_ARMS.md:3652) describes hinge DOF but not position. [`ArmManager.js:41-60`](js/entities/ArmManager.js:41) implements equatorial but the design doc doesn't mandate it. | **This doc (§6)** |
| 2 | **Solar panel configuration on Mother** — location (body-mount vs deployable), area, stow geometry, FOV exclusion zones are described qualitatively in [`CROSSBOW_ARMS.md §17.3`](CROSSBOW_ARMS.md:2253) but no dimensional drawing exists. Panel span (3m), chord (0.8m), hinge height (Y≈0) are stated in prose but never reconciled with arm geometry. **Any barrel-axial config hits the panels.** | [`CROSSBOW_ARMS.md §17.3`](CROSSBOW_ARMS.md:2253), [`Constants.OCTOPUS_V5.CORE_SOLAR_AREA`](js/core/Constants.js:279) | ST-9.2 (new) |
| 3 | **Spacecraft attitude as explicit 2nd DOF** — currently implicit. Must be formalized as doctrine before ST-9.3 codes aim logic. Without it, the aim API design is ambiguous. | [`CROSSBOW_ARMS.md §8.3`](CROSSBOW_ARMS.md:1021), [`BIG_PICTURE.md §12.4`](BIG_PICTURE.md:386) | ST-9.3 |

### MAJOR (should resolve in Epic 9)

| # | Gap | Details | Target ST |
|---|-----|---------|-----------|
| 4 | **Stow/deploy state machine** — no doc specifies when arms fold during attitude maneuvers, main engine burns, docking, or eclipse. Should arms auto-stow during Hall thruster burns? During RCS maneuvers? During Safe Mode? The only mention is [`EnvironmentSystem`](js/systems/EnvironmentSystem.js:1) blocking arm deploy during Safe Mode (ST-6.7). | Not specified | New ST-9.10 |
| 5 | **Center-of-mass shift envelope** — [`CROSSBOW_ARMS.md §16.1`](CROSSBOW_ARMS.md:2026) analyzes single-arm CoM shift (20mm). No doc analyzes the full envelope across all possible deploy combinations (e.g., 3 arms deployed starboard, 0 port). At Y3 Octo with 8 arms of varying mass asymmetrically deployed, CoM can shift 50+mm — enough to create persistent torque requiring constant RCS expenditure per [`CROSSBOW_ARMS.md §16.3`](CROSSBOW_ARMS.md:2138). | Partial in §16 | ST-9.2 |
| 6 | **Cable / tether harness across moving hinge** — the current 1-DOF yaw ±30° requires the tether to flex ±30° at the strut base. No fatigue analysis. For a 20-cycle reel limit, the tether crosses the hinge ~40 times (out + in). Dyneema flex fatigue at ±30° over a 5mm radius: bending strain = 0.1mm/(2×5mm) = 1.0%. Dyneema rated for >1M cycles at 1% strain. **OK for equatorial yaw.** For 180° barrel-axial: bending through much larger angle → fatigue concern. | Not analyzed | ST-9.5 |
| 7 | **Launch lock and launch-load path** — no doc specifies how stowed arms survive launch vibration (typically 5-20g quasi-static + random vibe). Arms must be locked to the bus during launch. For equatorial mount: arms held by EPM + spring shuttle + cavity walls. For barrel-axial: struts along barrel need their own launch retention mechanism (clamp bands or pyro pins). | Not specified | New ST-9.11 |
| 8 | **Main thruster placement vs arm geometry** — [`CROSSBOW_ARMS.md §12.4`](CROSSBOW_ARMS.md:1519) analyzes the back arm vs Hall thrusters. But no analysis exists for the interaction between Hall thruster vectoring (±15°) and deployed body-ring arm tethers. [`§13.2`](CROSSBOW_ARMS.md:1646) shows a tether routing map but doesn't account for 1-DOF yaw displacing tethers ±30° from nominal. | Partial | ST-9.7 |
| 9 | **Tether anchor point** — is the capture jerk load taken by the moving arm (through the strut hinge) or by the rigid bus hub (through the reel brake)? Current design: tether runs from reel (on bus) through guide channel to Y-harness on arm. Capture jerk loads the reel brake → bus face → primary structure. The hinge sees only strut bending from arm weight, not capture loads. This is correct for equatorial but should be explicitly stated. | Implicit | ST-9.7 |
| 10 | **Communications antenna + heat radiator FOV vs sweeping arms** — [`CROSSBOW_ARMS.md §17.2`](CROSSBOW_ARMS.md:2225) notes S-band antenna shadowing by back arm tether (~0.5 dB). No analysis for body-ring arms crossing the antenna FOV during yaw sweep. Radiator panels (if body-mounted on the bus) would be shadowed by stowed or partially deployed arms. | Partial | New ST-9.12 |

### MINOR (can resolve post-Epic 9 or during implementation)

| # | Gap | Details | Target ST |
|---|-----|---------|-----------|
| 11 | **Hinge bearing lifetime in LEO** — 5,700 thermal cycles/year at -120°C to +80°C. Ceramic bearings (Si₃N₄) rated for cryogenic use. MoS₂ dry lubricant rated to 10⁶ cycles at vacuum. At ±30° sweep, ~40 articulations per mission (20 reel cycles × 2). **Well within limits.** But no spec exists. | Not specified | Implementation |
| 12 | **Failure modes — game handling** — stuck arm (hinge frozen), severed strut, lost crossbow head. [`CROSSBOW_ARMS.md §24.2`](CROSSBOW_ARMS.md:3082) covers tether break. No analysis for frozen hinge (arm stuck at deployed angle, can't stow). Game should handle: (a) arm continues operating at fixed angle, (b) jettison arm command, (c) EVA repair mission. | Not specified | ST-9.4d (tangle) or new |
| 13 | **Spacecraft attitude as implicit second aim DOF — doctrine question** — partially answered by Config F recommendation. Needs formal write-up: "Mother rotates to aim, then strut yaw provides fine adjustment. Rotation budget: X° per mission from RCS." | Implicit in §8 | §6 of this doc |
| 14 | **Coordination of paired fire when opposing arms are in different stow/deploy states** — if one arm of an antipodal pair is deployed and the other is docked, dual-fire is impossible. The system must prefer pair-preserving deploy order. Current [`ArmManager`](js/entities/ArmManager.js:62) does not enforce this. | Not specified | ST-9.3 |
| 15 | **Bus aspect ratio** — the user imagines a "long vertical barrel" but the bus is 1.2m × 1.0m (aspect 1.2:1). If future redesign elongates the bus (e.g., 2.0m × 0.8m), Config C becomes substantially more attractive. The current near-cubic shape strongly favors equatorial geometry. | Not analyzed | Q-1 in §9 |
| 16 | **Gravity-gradient vs velocity-vector orientation** — the bus long axis is along the velocity vector (prograde). Some ADR concepts orient along the local vertical for passive stabilization. This affects which direction "barrel-axial" means. Not specified which orientation is canonical. | Ambiguous | Q-2 in §9 |

**Totals: 3 BLOCKER, 7 MAJOR, 6 MINOR = 16 items.**

---

## §6 Recommended Config & Rationale

### Primary Recommendation: Config F (Equatorial Yaw + Attitude Doctrine)

**For all tiers (Y0 Quad, Y1 Hex, Y3 Octo body-ring arms):**

Adopt **Config F** — mechanically identical to Config A (current implementation), with the formal addition of Mother attitude rotation as the second aim axis.

**Rationale:**

1. **Recoil cancellation is proven perfect** (§4.2). No residual force for equal-yaw antipodal pairs. The small torque residual at ψ≠0 is handled by existing RCS.

2. **Zero mass penalty** over current baseline. Y0 dry = 198.4 kg unchanged.

3. **Zero code rework** for [`ArmManager.generateDockPositions()`](js/entities/ArmManager.js:41). The equatorial geometry stands.

4. **Preserves CAPTURE_NET planar model.** The tether always exits in the dock-tangent plane per [`CAPTURE_NET.md §4`](CAPTURE_NET.md:519). All 5 tangle scenarios and their probabilities remain valid.

5. **Full-sphere coverage** via the two-DOF combination:
   - DOF 1: Strut yaw ±30° (fast, electrical, zero consumable)
   - DOF 2: Mother attitude via RCS/FEEP (3.5s for 30° per [`CROSSBOW_ARMS.md §8.1`](CROSSBOW_ARMS.md:988); costs 5.5g N₂)
   - Combined: any direction in 4π sr minus thruster/panel exclusion zones

6. **Explicit doctrine benefit.** Making attitude-aim a formal capability (not an afterthought) enables:
   - Pre-fire aim command queue in [`AutopilotSystem`](js/systems/AutopilotSystem.js:1)
   - NavSphere aim-arc visualization
   - HOUSTON dialogue: *"Rotating to firing attitude — 4 seconds to crossbow release."*
   - Player skill ceiling: fast-rotaters fire more shots per orbit

### Secondary Recommendation: Config C geometry for Y3 Octo Front/Back arms ONLY

When the Y3 Octo tier is implemented (ST-9.8 unlock), the dedicated **Front and Back arms** should adopt Config-C-like barrel-axial geometry:

- Front arm: hinged at the forward face (+Z), strut along the barrel, 90° sweep (stowed against bus, deployed radially or forward)
- Back arm: hinged at the aft face (-Z), offset from Hall thrusters, 90° sweep (stowed against bus, deployed radially or aft)

This gives the Y3 platform the prograde/retrograde engagement capability the user envisions, without disrupting the body-ring arms' equatorial geometry.

**Why this works for F/B but not body-ring:**
- F/B arms are singular (not paired) — no antipodal recoil constraint
- F/B arms fire along the velocity vector — single-fire RCS compensation is acceptable (per [`CROSSBOW_ARMS.md §5.3`](CROSSBOW_ARMS.md:657) Option C)
- F/B tether routing is already isolated from body-ring tether routing
- Solar panel conflict is minimal (F/B struts are on end faces, not mid-barrel)

### What Changes

| Item | Current State | Action |
|------|--------------|--------|
| Hinge position | Undocumented; code assumes equatorial | **Formalize as equatorial** for body-ring arms (all tiers) |
| 2nd aim DOF | Implicit ("whole-platform rotation") | **Codify as doctrine** with RCS budget, aim time, and NavSphere UI |
| Y3 F/B arms | Described as "Spinner-class, fires along ±Z" per [`CROSSBOW_ARMS.md §12.3`](CROSSBOW_ARMS.md:1497) | **Add 90° barrel-axial hinge** (Config C variant, limited sweep) |
| Code | [`generateDockPositions()`](js/entities/ArmManager.js:41) equatorial | **No change** for body-ring. New geometry for F/B at Y3 only. |

---

## §7 Doc Updates Required

Once the user accepts this recommendation, the following files need revision. **No edits are made now — this section identifies the scope.**

### [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md)

| Section | Current Content | Required Change |
|---------|----------------|-----------------|
| §8.3 (Hybrid Aim) | Describes gimbal vs aim-mother. Rev 5 footnote mentions 1-DOF yaw. | Add explicit "Config F" doctrine paragraph: "The Mother's attitude control system is the primary coarse-aim mechanism. The 1-DOF strut yaw provides ±30° fine adjustment. Combined, these provide full-sphere engagement capability." |
| §12.3 (Front/Back Arms) | "fires along +Z/−Z axis" | Add note: "Y3 Octo F/B arms mount on end-face hinges with 90° barrel-axial sweep (Config C variant). Limited to 90° to avoid solar panel intersection." |
| §12.5, §25.2 (Mass tables) | Y0/Y1/Y3 mass tables | No change to body-ring. Add F/B hinge mass delta for Y3: +1.6 kg (2 × 0.8 kg hinge). Y3 dry: 220.3 → 221.9 kg. Y3 wet: 266.3 → 267.9 kg. |
| §15 (Y-Harness) | Describes bridle routing for equatorial mount | Add note: "F/B arms at Y3 use a simplified single-point tether attachment (not Y-harness) since they fire along the barrel axis — no FEEP plume conflict on end faces." |
| §25.4 (1-DOF Yaw) | Describes yaw pivot at strut-bus junction | Add: "This section applies to body-ring arms (Y0/Y1/Y3). For Y3 Octo Front/Back arms, see §12.3 (barrel-axial 90° hinge)." |
| New §26 | Does not exist | Add: "§26 Aim Doctrine — Attitude as Second DOF". Formalize Config F. Include RCS budget per aim, time per aim, exclusion zones, NavSphere aim-arc spec. |

### [`CAPTURE_NET.md`](CAPTURE_NET.md)

| Section | Required Change |
|---------|-----------------|
| §4 (Tangle Mechanics) | Add note: "The planar-departure assumption holds for body-ring arms (equatorial mount). Y3 Octo Front/Back arms use barrel-axial 90° sweep — tangle analysis for these arms requires separate treatment (deferred to ST-9.4 extension when F/B arms are implemented)." |
| §5 (Launch Mechanics) | Rev 5 note on 1-DOF yaw unchanged. Add forward reference to barrel-axial F/B. |
| §6.1a (Fleet Table) | Y3 Octo row: add footnote "F/B arms use barrel-axial hinge with 90° sweep; body-ring arms retain equatorial yaw." |
| §10 (Concerns) | Add new concern: "F/B barrel-axial hinge — tangle model TBD." |

### [`BIG_PICTURE.md`](BIG_PICTURE.md)

| Section | Required Change |
|---------|-----------------|
| §12.4 (Strut Design) | This section already describes 1-DOF yaw. Add subtitle: "Body-ring arms: equatorial yaw. F/B arms (Y3): barrel-axial 90°." |
| §13.1 (Aimable Crossbow) | Add Config F doctrine. |
| §29.1 (Capture Net summary) | No change — planar departure remains valid for body-ring arms. |

### [`IMPLEMENTATION_PLAN.md`](archive/IMPLEMENTATION_PLAN_2026-06.md)

| Section | Required Change |
|---------|-----------------|
| ST-9.2 spec | Add: "Hinge position doctrine: equatorial for body-ring (all tiers). Barrel-axial 90° for F/B (Y3 Octo only). Code: `generateDockPositions()` unchanged for body-ring. New `generateFBDockPositions()` for Y3." |
| ST-9.3 spec | Add: "Pre-fire aim: `ArmUnit.setAimYaw(yaw)` for body-ring (unchanged). Mother attitude pre-aim queue: new `AutopilotSystem.requestAimRotation(targetDir)`. F/B aims: `ArmUnit.setAimAlpha(alpha)` (new, Y3 only)." |
| ST-9.7 spec | Add: "Bridle-ring geometry applies to body-ring arms. F/B arms use single-point tether attach — no bridle needed." |
| New ST-9.10 | "Stow/deploy state machine — auto-stow rules during main burns, Safe Mode, docking." |
| New ST-9.11 | "Launch lock design — retention mechanism for stowed arms during launch loads." |

### [`HANDOFF.md`](HANDOFF.md)

| Section | Required Change |
|---------|-----------------|
| §3 (Epic 9 status) | Add: "Arm pivot geometry resolved — see [`ARM_PIVOT_ANALYSIS.md`](ARM_PIVOT_ANALYSIS.md). Config F adopted (equatorial yaw + attitude doctrine). ST-9.3 unblocked." |

---

## §8 Code Rework Estimate

### Surviving Code (No Changes Needed)

| File | Function/Block | Why It Survives |
|------|---------------|-----------------|
| [`ArmManager.js:41-60`](js/entities/ArmManager.js:41) | [`generateDockPositions(armCount)`](js/entities/ArmManager.js:41) | Equatorial geometry confirmed as correct. θ-spacing, radial `dockOutward`, Y=0 plane — all valid. |
| [`Constants.js:254-289`](js/core/Constants.js:254) | `OCTOPUS_V5` block | Mass budget, arm counts, geometry dimensions — all valid. |
| [`Constants.js:296-300`](js/core/Constants.js:296) | `ARM_LADDER` block | Y0/Y1/Y3 tier definitions — valid. Minor update: Y3 mass +1.6 kg for F/B hinges. |
| [`Constants.js:330-358`](js/core/Constants.js:330) | Crossbow spring/reel/dual-fire constants | All valid for equatorial fire. |
| [`ArmUnit.js`](js/entities/ArmUnit.js:1) | Existing aim/deploy/state machine | 1-DOF yaw unchanged for body-ring arms. |

### Code to Add (New Work)

| Scope | Description | Files | Effort |
|-------|-------------|-------|--------|
| Aim doctrine | `AutopilotSystem.requestAimRotation(targetDir)` — queues Mother attitude rotation before crossbow fire. Returns promise resolved when ω < 0.5°/s at target attitude. | [`AutopilotSystem.js`](js/systems/AutopilotSystem.js:1) | 0.5 day |
| Aim UI | NavSphere aim-arc: render a dashed arc from current aim to target-required aim. Show "ROTATING TO AIM" text. | [`NavSphere.js`](js/ui/NavSphere.js:1), [`HUD.js`](js/ui/HUD.js:1) | 0.5 day |
| F/B dock geometry (Y3 only) | `generateFBDockPositions()` — places Front arm on +Z face, Back arm on -Z face, with barrel-axial hinge parameters. | [`ArmManager.js`](js/entities/ArmManager.js:1) | 0.25 day |
| F/B aim API (Y3 only) | `ArmUnit.setAimAlpha(alpha)` — barrel-axial sweep 0→90° for F/B arms. Separate from yaw. | [`ArmUnit.js`](js/entities/ArmUnit.js:1) | 0.5 day |
| Pair-preservation | Enforce antipodal-pair deploy order: if arm at θ is deployed, prefer deploying θ+π next (for dual-fire readiness). | [`ArmManager.js`](js/entities/ArmManager.js:1) | 0.25 day |
| Y3 mass update | Update `ARM_LADDER.Y3_OCTO.dryMass` from 220.3 to 221.9 kg. | [`Constants.js`](js/core/Constants.js:296) | Trivial |
| **TOTAL NEW** | | | **2.0 person-days** |

### Code to Replace (Zero)

No existing code is replaced. Config F is additive to current implementation.

### Net Assessment

- Current ST-9.2 code: **fully survives**
- Current ST-9.3 spec: **survives with addition** (aim doctrine)
- ARM_LADDER mass numbers: **minor Y3 tweak** (+1.6 kg)
- Overall rework: **2.0 person-days** (was budgeted at 2.5 days for ST-9.3)

This is **well within budget** and eliminates risk from the pivot-geometry blocker.

---

## §9 Open Questions for User Signoff

| # | Question | Context | Impact if Deferred |
|---|----------|---------|-------------------|
| **Q-1** | **Bus aspect ratio: is 1.2:1 final, or is a more elongated barrel (e.g., 2:1 or 3:1) under consideration?** A longer barrel makes Config C vastly more attractive for body-ring arms. At the current 1.2m × 1.0m, barrel-axial struts are only ~1m long — barely longer than radial-mounted struts. If the user envisions a 3m × 0.6m barrel, Config C may be the right answer after all. | [`Constants.CORE_LENGTH: 1.2`](js/core/Constants.js:274), [`CORE_ACROSS_FLATS: 1.0`](js/core/Constants.js:273) | Low — equatorial works at any aspect ratio. Config C revisit if ratio changes. |
| **Q-2** | **Bus orientation: is the long axis along the velocity vector (prograde) or along the local vertical (radial)?** The code and docs assume prograde (Z-axis). The user's "long vertical barrel" framing suggests radial. Gravity-gradient pasive stabilization favors radial. Aerodynamic drag (VLEO) favors velocity-aligned. This affects what "barrel-axial" means in practice. | [`CROSSBOW_ARMS.md §2.4`](CROSSBOW_ARMS.md:195) shows top view with +Z = prograde | Medium — affects Config C geometry mapping but not the recommendation. |
| **Q-3** | **Is the "fishing pole" visual identity important enough to accept the mass and complexity costs of Config C for Y0 body-ring arms?** Config F solves the engineering problem but doesn't deliver the long-strut fishing-pole aesthetic. If this visual is a deal-breaker, we need to revisit. | User's "fishing pole" metaphor | Medium — affects visual identity. Could be addressed with longer struts at equatorial mount (aesthetic only, no sweep). |
| **Q-4** | **Should the F/B barrel-axial hinge (recommended for Y3 Octo) use 90° sweep or the full 180° the user proposed?** 90° avoids solar panel intersection. 180° requires wing fold or panel redesign. 180° gives the full prograde-to-retrograde sweep the user envisions. | Solar panel at Y≈0, §2 diagrams | Low — can start at 90° and extend to 180° if panel redesign is done. |
| **Q-5** | **What is the solar panel stow geometry during launch?** Deployable wings fold against the bus for launch. When folded, do they block any arm dock positions? This was never specified and affects launch-lock design for all configs. | [`CROSSBOW_ARMS.md §17.3`](CROSSBOW_ARMS.md:2253) | Medium — affects ST-9.11 (launch locks). |
| **Q-6** | **Should the Mother auto-rotate to aim before crossbow fire, or should the player manually rotate?** Config F doctrine could be: (a) full auto (aim queue in autopilot), (b) semi-auto (player initiates rotation, system fires when aligned), or (c) manual (player manually rotates, fires when ready, system provides aim indicator). Each has different gameplay feel. | [`CROSSBOW_ARMS.md §8.5`](CROSSBOW_ARMS.md:1062) | Low — UI choice, doesn't affect geometry. |
| **Q-7** | **Accept the 16 "overlooked" items (§5) as the current gap list?** Some items (BLOCKER #1-3) are resolved by this analysis. The 7 MAJOR items need prioritization. User should confirm which MAJOR items are in-scope for Epic 9 vs deferred. | §5 of this doc | Medium — affects Epic 9 scope. |

---

## Appendix: Reference Links

- [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md) — V5 crossbow/tether design bible
- [`CAPTURE_NET.md`](CAPTURE_NET.md) — Net capture system (Rev 5)
- [`BIG_PICTURE.md`](BIG_PICTURE.md) — Strategic roadmap
- [`IMPLEMENTATION_PLAN.md`](archive/IMPLEMENTATION_PLAN_2026-06.md) — Epic 9 task specs
- [`HANDOFF.md`](HANDOFF.md) — Current project status
- [`js/core/Constants.js`](js/core/Constants.js) — OCTOPUS_V5, ARM_LADDER, FEATURE_FLAGS
- [`js/entities/ArmManager.js`](js/entities/ArmManager.js) — `generateDockPositions()`, arm fleet management
- [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js) — Individual arm state machine + aim API

---

## §10 Config G — Barrel-Axial Top-Collar + 3-Plane Layout + Strut-Mounted Reel (REVISED RECOMMENDATION)

> **Added 2026-04-26 after user discussion. Supersedes §6 Config F recommendation. Config G is now the target architecture.**

### §10.1 Design Summary

Config G emerged from iterative user-architect discussion and resolves the three main objections to barrel-axial arms (solar panel collision, tether routing through hinge, overcomplicated recoil analysis) with three corresponding innovations:

| Original Problem | User's Solution |
|-----------------|-----------------|
| Arm struts collide with solar wings when sweeping through equator | **3-plane layout**: panels and arms in perpendicular planes — they never intersect |
| Tether must route through a 180° rotary hinge | **Reel on strut tip**: tether never crosses hinge. Only thin flex power+data cable at hinge. |
| Recoil cancellation fails for non-equatorial fire | **Accept it**: RCS compensates at ~10% of N₂ budget. Not a mission limit. |

### §10.2 Geometry

```
  TOP VIEW (looking down barrel axis / Y):

                 +Z (prograde)
                     ↑
                     │
                  ╱──┤──╲     ROSA panels in 0°/180° plane
          ROSA  ╱    │    ╲   (extend along barrel axis, top+bottom)
         panel ╱     │     ╲
              ╱  ┌───┤───┐  ╲
             │   │   │   │   │
    strut ●──┤   │ OCTA- │   ├──● strut     Arms at 60° and 300°
    (300°)   │   │ GONAL │   │    (60°)
             │   │  BUS  │   │
    strut ●──┤   │       │   ├──● strut     Arms at 120° and 240°
    (240°)   │   │       │   │    (120°)
              ╲  └───┤───┘  ╱
               ╲     │     ╱
                ╲    │    ╱
                 ╲───┤───╱
                     │
                     ↓
                 -Z (retrograde)

  Three planes, 60° apart:
    Plane 1 (0°/180°): ROSA solar panels — long axis along barrel (Y)
    Plane 2 (60°/240°): Arm pair 1 (e.g., LD + SD)
    Plane 3 (120°/300°): Arm pair 2 (e.g., LD + SD)

  SIDE VIEW (the key diagram — arm sweep):

        +Y (zenith / "top" of barrel)
         ↑
         │     ╱ α=180° (pointing up, above Mother)
         │    ╱
         │   ╱   ROSA extends
    ┌────●══╱═══════════╗ ←── hinge at top collar
    │    │   REEL+BOW   ║     (all 4 hinges here)
    │    │ on strut tip ║
    │    │    BUS        ║ strut ~1.0m
    │    │   1.2m        ║
    │    │    tall        ║
    └────┤               ╚══● α=90° (radial/equatorial)
         │                ╲
         │                 ╲ daughter at tip
         │                  ╲
         │                   ● α=0° STOWED
         │                     (alongside barrel, daughter near bottom)
         ↓
        -Y (nadir)

  STOW DETAIL (all 4 arms folded down):

        ┌────●●●●═══════╗   4 hinges at top collar
        │    ║║║║  BUS   │
        │    ║║║║        │   4 struts running alongside barrel
        │    ║║║║        │   (between the ROSA panel plane
        │    ║║║║        │    and the bus surface)
        └────║║║║────────┘
             ▼▼▼▼
         daughters       Compact, within fairing envelope.
         at bottom        (struts interleave on 4 octagonal faces)
```

### §10.3 ROSA Solar Panel Configuration

**Roll-Out Solar Arrays (ROSA)** replace the rigid deployable wings from the original design.

```
  ROSA DEPLOYMENT (side view):

             ROSA blanket
              (rolled up)
                 ╤
        ┌────────┤────────┐
        │   CAN  │  BUS   │     Launch: ROSA rolled up at top+bottom
        │        │        │     of bus in the 0°/180° plane
        └────────┤────────┘
                 ╧
              (rolled up)

  AFTER DEPLOYMENT:

          ═══════╤═══════     ROSA extends 2-3m along barrel axis (+Y)
                 │
        ┌────────┤────────┐
        │        │        │     Bus body: GaAs cells on 6 non-panel faces
        │        │        │     (~2.4 m² → ~720W)
        └────────┤────────┘
                 │
          ═══════╧═══════     ROSA extends 2-3m along barrel axis (-Y)

  Each ROSA blanket: 0.5m wide × 3m deployed → 1.5 m²
  Two blankets: 3.0 m² × 1360 W/m² × 30% efficiency = ~1,220W
  Body-mount cells: ~720W
  TOTAL: ~1,940W (matches current 1,900W spec)

  WHY ALONG BARREL AXIS (user's suggestion):
  - ROSA panels extend in ±Y in the 0°/180° plane
  - All arm struts and tethers are in the 60°/120°/240°/300° planes
  - Minimum angular separation: 60° between any tether and any ROSA edge
  - At 2 km tether length, worst-case gravity gradient deflection: ~2.4°
  - Effective clearance: 60° - 2.4° = 57.6° → NO TANGLE RISK ✅
```

**ROSA advantages over rigid wings:**

| Factor | Rigid Deployable Wing | ROSA |
|--------|----------------------|------|
| Mass per kW | 8 kg/kW | 2.5 kg/kW |
| Stowed volume | Large (folds like accordion) | Small (rolls into cylinder) |
| Blocks arm sweep? | YES — 3m span crosses equator | NO — extends along barrel, perpendicular to arms |
| TRL | 9 (since 1960s) | 9 (ISS iROSA 2021, Starlink v2 2023) |
| Retractable? | No (one-time deploy) | Yes — can re-roll for special operations |
| Mass for ~2 kW total | ~16 kg (2 wings) | ~6 kg (2 ROSA + body cells) |
| Mass savings | — | **~10 kg lighter** |

### §10.4 Strut-Mounted Reel Architecture

```
  STRUT TIP ASSEMBLY (each of 4 struts):

  ←─── toward bus hinge
  ╔═══════════════════════════════════════╗
  ║  STRUT STRUCTURE (Al 7075 tube)       ║
  ║  50mm OD × 2mm wall × 1.6m           ║
  ║                                       ║
  ║  ┌─────────────┐  ┌────────────────┐  ║
  ║  │  TETHER REEL │  │   CROSSBOW    │  ║
  ║  │  + motor     │  │   SPRING PACK │  ║
  ║  │  + brake     │  │   + shuttle   │  ║
  ║  │  + strain ga.│  │   + EPM latch │  ║
  ║  │  1.2 kg      │  │   0.5 kg      │  ║
  ║  └─────────────┘  └────────────────┘  ║
  ║                                       ║
  ║  ┌─────────────────────────────────┐  ║
  ║  │       DAUGHTER DOCK SURFACE     │  ║
  ║  │    (EPM hold + cone alignment)  │  ║
  ║  └─────────────────────────────────┘  ║
  ╚═══════════════════════════════════════╝
                    │
                    ↓ DAUGHTER detaches here
                    │ tether pays out from reel above
                    ●
              [DAUGHTER]
              (6.6 kg LD or 2.1 kg SD)

  WHAT CROSSES THE HINGE (at bus end of strut):
  ┌─────────────────────────────────────┐
  │  Flex cable bundle:                 │
  │  • 28V power (2A max) → 2 wires    │
  │  • Data (RS-485, 9600 baud) → 2 wires │
  │  • Strain gauge signal → 2 wires   │
  │  • Hinge encoder feedback → 2 wires│
  │  Total: 8 wires, Kapton-insulated  │
  │  Flex rated: >10,000 cycles at 180°│
  │  Mass: ~50g for flex harness       │
  │  Heritage: every satellite antenna  │
  │  gimbal, every robotic arm joint   │
  └─────────────────────────────────────┘
```

### §10.5 Mass Budget — Config G vs Current (Y0 Quad)

| Component | Current (Config A) | Config G | Delta |
|-----------|-------------------|----------|-------|
| Bus core (electronics, tanks, thrusters) | 181.0 kg* | 164.2 kg | -16.8 kg |
| — *minus internal reels (4×1.2)* | *included above* | *moved to struts* | |
| — *minus internal springs (4×0.5)* | *included above* | *moved to struts* | |
| — *minus rigid solar wings (2×8)* | *included above* | *replaced by ROSA* | |
| ROSA panels (2 blankets + body-mount) | 0 (wings in core) | 6.0 kg | +6.0 kg |
| 4× strut assemblies | 0 (short strut in core) | 18.0 kg | +18.0 kg |
| — *structure (4×2.0 kg)* | | *8.0 kg* | |
| — *reel+motor+brake (4×1.2 kg)* | | *4.8 kg* | |
| — *spring pack (4×0.5 kg)* | | *2.0 kg* | |
| — *hinge+motor+brake (4×0.6 kg)* | | *2.4 kg* | |
| — *flex harness (4×0.05 kg)* | | *0.2 kg* | |
| — *launch locks (4×0.15 kg)* | | *0.6 kg* | |
| 4× daughters (2 LD + 2 SD, unchanged) | 17.4 kg | 17.4 kg | 0 |
| Propellant (Xe + N₂) | 46.0 kg | 46.0 kg | 0 |
| **TOTAL DRY** | **198.4 kg** | **205.6 kg** | **+7.2 kg** |
| **TOTAL WET** | **244.4 kg** | **251.6 kg** | **+7.2 kg** |

**+7.2 kg is within the design margin.** The 10 kg saved by eliminating rigid solar wings partially offsets the 18 kg of strut assemblies.

*Note: These numbers are estimates. Detailed mass breakdown requires mechanical CAD. The key result: Config G is in the same mass class as Config A, not dramatically heavier.*

### §10.6 Comprehensive Space-Environment Issues Assessment

Drawing on decades of flight heritage data from NASA, ESA, JAXA, and commercial operators:

#### ISSUE 1: Thermal Cycling — The Silent Fatigue Machine

**Environment:** LEO at 400 km: -120°C to +80°C every 92 minutes. 5,700 cycles/year. 11,400 cycles over a 2-year mission.

| Component | Risk | Heritage | Mitigation |
|-----------|------|----------|------------|
| **Hinge bearings** | Medium — thermal expansion creates micro-strain at bearing races. CTE mismatch between steel race and ceramic Si₃N₄ ball. | Every GEO solar array drive (SADA) survives 800 cyc/yr for 15+ years = 12,000 cycles. Same temp range. TRL 9. | Ceramic bearings (Si₃N₄) with MoS₂ dry lubricant. Pre-loaded to accommodate thermal expansion. |
| **Flex cable** | Low — Kapton flex rated >10,000 cycles at 180° bend. Our usage: ~40 deployment cycles total. | ISS robotic joints, every satellite antenna gimbal. | Standard NASA-spec flex harness (Kapton-insulated, silver-plated copper, stress-relieved routing). |
| **Strut structure** | Low — Al 7075 CTE = 23.6 µm/m/K. 1.0m strut grows/shrinks 4.7mm per cycle. | All satellite structural tubing. | Hinge bearing absorbs the 4.7mm length change as micro-rotation (<0.3°). Non-issue. |
| **ROSA panels** | Low — designed for exactly this environment. | ISS iROSA: proven 2021+, same thermal regime. Starlink v2: millions of unit-years of fleet experience. TRL 9. | Standard thin-film cell + Kapton substrate. |
| **Spring pack** | Low — maraging steel retains elastic properties -150°C to +120°C. | P-POD, Lightband, every spring-loaded deployer. TRL 9. | Select 17-7PH or Custom 455. Factory thermal-vac tested. |

**Game mechanic:** After ~10,000 thermal cycles (≈2 years), hinge bearing starts to stiffen. HUD shows "BEARING WEAR" warning. Player can buy replacement bearings at shipyard, or accept reduced slew rate.

#### ISSUE 2: Atomic Oxygen Erosion (200-700 km)

**Environment:** AO flux ~10¹³-10¹⁴ atoms/cm²/s. Destroys polymers, erodes carbon.

| Component | Exposed? | Erosion Rate | Mission Life | Mitigation |
|-----------|----------|-------------|-------------|------------|
| **Strut exterior** (Al 7075, anodized) | Yes — ram-facing | Negligible — Al₂O₃ passivation | >20 years | None needed |
| **Hinge** | Partially — housing shields bearing | None — internal | Indefinite | Housing covers bearing races |
| **Flex cable insulation** (Kapton) | At hinge exit | ~3 µm/year on 100 µm insulation | ~33 years | FEP (Teflon) overwrap if concerned |
| **ROSA substrate** (Kapton-based) | Sun-facing side: no (covered by cells). Ram-facing back: yes | ~3 µm/year with AO coating | 10+ years with ITO/SiO₂ coat | Standard ISS iROSA approach |
| **Tether** (Dyneema) | Edge-on to ram (arm planes are NOT ram-facing due to 60° offset) | 0.012 mm/year edge-on | 8+ years | HBN coating at Y1 upgrade |

**Key insight:** Because the arm struts are at 60° and 120° from the velocity vector (not directly ram-facing), AO erosion is reduced by cos(60°) = 50% versus broadside exposure. The 3-plane layout inadvertently helps with AO.

#### ISSUE 3: Cold Welding — The Moving-Parts Killer

**Risk:** In vacuum, bare metal-to-metal contact creates atomic bonds (cold weld). Mechanisms that sit still for days/weeks can seize.

| Component | Risk Level | Why |
|-----------|-----------|-----|
| **Hinge bearings** | **MEDIUM** — if strut sits at one angle for weeks without moving, bearing balls can bond to races | Standard space problem — solved by: (a) Ceramic Si₃N₄ balls on steel races (dissimilar materials don't cold-weld), (b) MoS₂ dry lube prevents metal-metal contact, (c) "Bearing exercise" routine — move each hinge ±2° weekly per ISS CMG maintenance doctrine |
| **Hinge brake** | LOW — brake surfaces designed for contact | Use friction disc of dissimilar materials (Ti against Inconel with MoS₂) |
| **EPM dock latch** | LOW — magnetic interface, no sliding surfaces | Already addressed in V3 design |

**Game mechanic:** If player doesn't exercise hinges (auto-maintenance task), there's a small probability of "hinge stiction" event — strut sticks, requires RCS torque burst to break free. Teaches real bearing maintenance doctrine.

#### ISSUE 4: Launch Loads and Retention

**Environment:** Launch: 5-20g quasi-static axial, ±3g lateral, 14.1g RMS random vibration (20-2000 Hz).

```
  LAUNCH LOCK CONFIGURATION:

  Each stowed strut is held to the barrel by TWO retention mechanisms:

  1. HINGE LOCK: Pin through hinge housing (prevents rotation)
     - Pyrotechnic pin-puller release (TRL 9, Ensign-Bickford heritage)
     - Redundant: 2 pins, either alone holds the strut

  2. TIP LOCK: Clamp at the strut tip holding daughter to barrel
     - Spring-loaded clamp, released by pyrotechnic bolt
     - Takes the cantilevered launch load (6.6 kg daughter at 1m arm × 20g = 132N)

  Structural check:
    Strut bending moment (worst case, 20g axial):
    M = m_tip × 20g × L = 6.6 × 196 × 1.0 = 1,294 N·m (during launch only)

    Strut + tip lock distributes this as:
    Hinge reaction + tip clamp → strut in simple beam, not cantilever
    M_max at midspan = 1,294/4 = 324 N·m
    50mm OD × 2mm Al 7075 tube: M_yield = 1,500 N·m
    Safety factor: 4.6× ✅

  Heritage: every satellite deployable boom, antenna, solar array
  uses exactly this approach (pin-puller + tip restraint). TRL 9.
```

#### ISSUE 5: Hinge Motor and Brake Under Capture Loads

**Critical load case:** Daughter captures 500 kg debris. Reel brake applies 500N tension. This pulls on the strut tip at 1.0m lever arm = **500 N·m bending moment at the hinge.**

```
  SOLUTION: LOCKABLE HINGE

  The hinge operates in two modes:

  MODE 1 — ROTATE (during aim/deploy/stow):
    Motor drives rotation. Brake disengaged.
    Motor torque: ~10 N·m (sufficient to swing 10 kg strut assembly)
    No external loads — daughter is docked or just launched.

  MODE 2 — LOCKED (during capture/reel-in):
    Brake ENGAGED. Motor off. Hinge is rigid structural joint.
    Brake holds: >1,000 N·m (friction disc stack, preloaded)
    500 N·m capture load → 50% of brake capacity → SF 2× ✅

  This is exactly how satellite antenna deployment works:
    Deploy → lock → operate at locked angle.
  TRL 9. Heritage: every GEO antenna reflector, ISS truss joints.
```

**What if the brake fails?** Strut free-wheels under capture load. Daughter + debris swing the strut like a pendulum. Emergency response: reel releases tension (daughter goes slack), RCS damps Mother attitude, then re-engage brake. If brake is truly broken: reel in the daughter, dock it, mark that strut as failed. Three remaining struts continue mission.

#### ISSUE 6: Tether Path After Daughter Maneuvers

The tether exits the strut-tip reel and goes to the daughter. Initially the tether follows the strut direction. As the daughter maneuvers under FEEP, the tether angles off-axis.

```
  TETHER GEOMETRY DURING OPERATION:

          hinge
           ●
           ║  strut (locked at angle α)
           ║
           ╚══[REEL]═══ tether ═══ [DAUGHTER at target]
                  ↑                    ↑
            tether exits              daughter may be
            along strut axis          off-axis due to
            initially                 FEEP maneuvering

  The tether can curve due to:
  1. Gravity gradient: deflection ≈ F_tidal/T_tension = 84mN/2N = 0.042 rad (2.4°) — small
  2. Daughter FEEP thrust: lateral component creates angle
  3. Orbital mechanics: Coriolis in rotating frame

  At 2 km range with 2 N tension: maximum off-axis angle ≈ ±75°
  (per CROSSBOW_ARMS.md §24.5 Y-bridle gimbal analysis — still valid).

  CLEARANCE TO ROSA PANELS:
  Minimum angular separation between arm plane and ROSA plane: 60°
  Maximum tether deflection from arm plane: ~15° (typical operations)
  Worst-case clearance: 60° - 15° = 45° → 1,400m lateral separation at 2 km
  ROSA panel width: 0.5m → clearance ratio: 2,800:1 ✅ ZERO RISK
```

#### ISSUE 7: MMOD Impact on Struts

```
  Strut presented area to MMOD (ram-facing):
    50mm diameter × 1.0m length × cos(60°) = 0.025 m² per strut
    (cos 60° because struts are 60° from ram direction)

  With 4 struts × 2 years:
    P(penetration by >1mm particle) = 10⁻³ × 0.025 × 4 × 2 = 0.0002 = 0.02%

  MMOD HITS A STRUT — what happens?
  1. Small particle (<1mm): surface pitting. Cosmetic only.
  2. Medium particle (1-3mm): penetrates 2mm wall. Hole in tube.
     Strut structure: thin-wall tube relies on closed cross-section for bending strength.
     A hole reduces bending capacity by ~10-15%. Still functional at SF >3×.
  3. Large particle (>3mm): potential through-and-through.
     Strut weakened significantly. Cannot sustain capture loads.
     → Mark strut as damaged. Recall daughter. Lock strut in stowed position.

  Impact probability for scenario 3: <0.001% per year.
  Heritage: ISS trusses have sustained multiple MMOD hits and remain operational.
```

#### ISSUE 8: Eclipse Thermal Shock on Thin Components

Entering eclipse: temperature drops ~200°C in 5 minutes. Exiting: rises ~200°C in seconds (direct sunlight).

| Component | Thermal Mass | Time Constant | Effect |
|-----------|-------------|---------------|--------|
| Strut (Al tube) | ~1 kg | ~2 min | Cools/heats uniformly. Length change 4.7mm — absorbed by hinge. |
| ROSA blanket | ~3 kg | ~30 sec | Rapid flex. **Designed for this** — ISS iROSA handles it. Flex substrate absorbs thermal shock. |
| Flex cable | ~50g | ~10 sec | Kapton shrinks/expands. Stress-relieved loop absorbs without fatigue. |
| Tether (Dyneema, deployed) | ~2.5 kg spread over 2 km | ~5 sec (thin ribbon) | Rapid cooling → slight shrinkage. Reel PID adjusts tension. Can cause momentary tension spike (10-20 N) — well within 500 N capacity. |

**No show-stoppers.** All components designed for or proven in this environment.

#### ISSUE 9: Electromagnetic Interference (EMI)

Flex cable carries 28V power + data. Strut-mounted reel motor draws 2A peak.

- **Motor EMI:** DC brushless motor with PWM drive at ~20 kHz. Standard solution: twisted pair power wires + ferrite chokes at both ends. ISS robotic arm heritage.
- **Data integrity:** RS-485 differential signaling is designed for noisy environments. >10 km range over twisted pair. 1m strut cable: trivial.
- **Tether as antenna:** A 2 km conducting tether (GSL or Cu-cored) IS a radio antenna. If strut electronics emit at frequencies where the tether is resonant, it could broadcast interference. **Mitigation:** ferrite bead at tether-reel interface, same as V3 design.

#### ISSUE 10: Radiation Effects (LEO, 400 km)

Annual dose at 400 km behind 2mm Al: ~5-10 krad. Over 2 years: ~20 krad.

| Component | Rad Tolerance | Status |
|-----------|--------------|--------|
| Hinge motor driver | Commercial: 30 krad | ✅ Passes with margin |
| ROSA cells (GaAs triple-junction) | 100+ krad | ✅ |
| Flex cable insulation (Kapton) | >100 Mrad | ✅ |
| Reel motor controller | Rad-tolerant FPGA: 100 krad | ✅ |

No radiation concerns at LEO. GEO would require rad-hard components — deferred to future analysis.

### §10.7 Remaining Open Issues — Honest Assessment

These are the items that **are NOT solved** by Config G and need further design work:

| # | Issue | Severity | Resolution Path |
|---|-------|----------|----------------|
| 1 | **Bus aspect ratio** — at 1.2:1, struts are only 1.0m. "Fishing pole" visual needs ≥2:1 barrel. | DESIGN CHOICE | User decides: keep 1.2m bus height or elongate. If elongated (e.g., 2.0m × 0.8m), struts become 1.6m — much more dramatic. Affects ALL subsystem packaging. Major redesign. |
| 2 | **CAPTURE_NET planar departure** — net tangle model assumes equatorial exit. Config G arms fire in meridian planes. | MAJOR | Tangle model in [`CAPTURE_NET.md §4`](CAPTURE_NET.md:519) needs revision for 3D departure geometry. Some tangle probabilities change (likely decrease — tethers are more spread out in Config G). New analysis needed. |
| 3 | **Code rework** — [`generateDockPositions()`](js/entities/ArmManager.js:41) must be rewritten for collar-mount geometry. Aim API changes from `setAimYaw(yaw)` to `setAimAlpha(alpha)`. New strut-swing animation system. | 5-7 dev days | All new code. No salvage of current equatorial dock generator. Constants block needs major revision. |
| 4 | **Fairing clearance** — 4 stowed struts + daughters + ROSA rolls must fit within launch fairing. Rough check: bus diameter 1.0m + 4 struts at ~100mm offset = 1.2m envelope. Standard LEO fairings (Falcon 9: 5.2m, LVM3: 4.0m): ✅ Fits easily. | MINOR | Verify with 3D packaging study. |
| 5 | **Hinge bearing lifetime spec** — no formal spec exists. Standard: 10,000 thermal cycles + 1,000 actuation cycles. Need to verify with bearing vendor (e.g., Timken Aerospace, SKF Space). | MINOR | Standard procurement issue. |
| 6 | **Stow/deploy state machine** — when do arms auto-stow? During Hall thruster burns? Solar panel recharge? Docking operations? | MAJOR | New state machine design needed. Not mechanically complex, but must be specified before coding. |
| 7 | **Dual-fire pairing** — with 4 arms in 2 pairs (pair at 60°/240° and pair at 120°/300°), each pair is physically separated by 120°. RCS compensates residual Y-force from non-equatorial fire. Must verify RCS response time for 500 N·s impulse compensation. | MINOR | RCS math in §4.3 already shows feasibility. Need per-pair analysis, not per-arm. |

### §10.8 Updated Scoring Table (Including Config G)

| Assessment Axis | A: Equatorial | F: Equat+Attitude | **G: Barrel-Axial 3-Plane** |
|---|---|---|---|
| Aim envelope | ★★★☆☆ | ★★★★☆ | **★★★★★** |
| Stow geometry | ★★★★★ | ★★★★★ | **★★★★☆** |
| Plume map | ★★★★☆ | ★★★★☆ | **★★★★☆** |
| Recoil cancellation | ★★★★★ | ★★★★★ | **★★★☆☆** (RCS manages) |
| Cable/tether routing | ★★★★★ | ★★★★★ | **★★★★★** (reel on tip) |
| CoM shift | ★★★★★ | ★★★★★ | **★★★☆☆** |
| Hinge hardware | ★★★★★ | ★★★★★ | **★★★★☆** |
| Tether anchor load | ★★★★★ | ★★★★★ | **★★★★☆** (lockable hinge) |
| Daughter-thrust | ★★★☆☆ | ★★★★☆ | **★★★★★** |
| Fishing-pole feel | ★★★☆☆ | ★★★☆☆ | **★★★★★** |
| Net launch geometry | ★★★★★ | ★★★★★ | **★★★☆☆** (needs model update) |
| Mass impact | ★★★★★ | ★★★★★ | **★★★★☆** (+7.2 kg) |
| Code rework | ★★★★★ | ★★★★★ | **★★☆☆☆** (5-7 days) |
| **TOTAL (out of 65)** | **58** | **61** | **53** |

Config G scores lower than F on pure engineering metrics but **wins decisively on aim envelope, daughter-thrust integration, and the fishing-pole identity** — the three axes that matter most to the game's visual and mechanical identity. The engineering costs are real but manageable.

### §10.9 Revised Recommendation

**Config G is adopted as the target architecture** per user decision (2026-04-26).

---

### §10.11 LOCKED SPECIFICATION — Config G Final Dimensions

> **Signed off 2026-04-26.** All open questions from §10.10 resolved in this section. ST-9.3 is UNBLOCKED.

#### Design Constraints — SSLV-First

The Mother is designed to fit **ISRO SSLV** (Small Satellite Launch Vehicle) as the primary launcher. SSLV offers the lowest launch cost and highest scheduling availability for a ~250 kg payload.

| SSLV Constraint | Value | Our Design | Margin |
|-----------------|-------|------------|--------|
| Fairing inner diameter | 2.1 m | Stowed envelope: ~1.2 m dia | 0.9 m ✅ |
| Fairing usable length | ~2.5 m | Stowed height: ~2.3 m (barrel + ROSA rolls) | 0.2 m (tight but fits) |
| Payload mass to 500 km SSO | 300 kg | ~252 kg wet | 48 kg margin ✅ |
| Payload adapter interface | SSLV standard | Standard 15" Marman clamp | ✅ |

PSLV rideshare is the backup option (3.2m × 5.0m fairing — unlimited margin). Design for SSLV, benefit from PSLV flexibility.

#### Barrel Dimensions

```
  ┌────────────────────────────┐
  │        LOCKED VALUES        │
  ├────────────────────────────┤
  │  Barrel height:  2.00 m    │  (was 1.2m — elongated per user decision)
  │  Barrel width:   0.80 m    │  across flats (octagonal prism)
  │  Aspect ratio:   2.5 : 1   │  (proper barrel shape, not cube)
  │  Bus volume:     ~1.0 m³   │
  │  Hinge collar:   Y = +0.90m│  (top collar, 0.10m below top face)
  │  Collar radius:  0.40 m    │  (barrel surface at collar height)
  └────────────────────────────┘
```

#### Strut Dimensions

```
  Strut length = barrel_height - hinge_offset - daughter_body_length
               = 2.00 - 0.10 - 0.30
               = 1.60 m

  ┌────────────────────────────┐
  │  Strut length:    1.60 m   │  (proper fishing-pole length)
  │  Strut tube:      50mm OD  │  × 2mm wall Al 7075
  │  Strut mass (structure):   │  ~2.0 kg each
  │  Strut tip assembly:       │  reel (1.2 kg) + crossbow (0.5 kg)
  │  Hinge assembly:           │  motor + brake + flex harness (~0.8 kg)
  │  Strut total:     4.5 kg   │  per strut (structure + tip + hinge)
  │  Sweep range:     0–180°   │  in meridian plane
  │  Hinge type:      lockable │  (free-wheel for aim, lock for capture)
  └────────────────────────────┘
```

#### ROSA Panel Specification

```
  ROSA panels run LENGTHWISE along the barrel in the 0°/180° plane.
  This keeps them perpendicular to all arm sweep planes (60°/120°/240°/300°).

  ┌────────────────────────────────────┐
  │  Panel count:      2               │  (one at 0°, one at 180°)
  │  Panel width:      1.00 m          │  (extending from barrel surface)
  │  Panel length:     2.00 m          │  (full barrel height)
  │  Panel area:       2 × 2.0 m²     │  = 4.0 m²
  │  Cell type:        GaAs triple-jn  │  30% efficiency
  │  ROSA power:       ~1,630 W        │  (4.0 × 1360 × 0.30)
  │  Body-mount power: ~610 W          │  (GaAs on 6 non-panel faces)
  │  TOTAL POWER:      ~2,240 W        │  (exceeds 1,900W V5 spec)
  │  Stowed form:      rolled cylinder │  ~0.10m dia × 1.0m
  │  TRL:              9               │  (ISS iROSA 2021+)
  └────────────────────────────────────┘

  CHAMFERED CORNERS — dual purpose:
  
  1. FAIRING FIT: Bottom corners rounded to clear SSLV fairing taper
     at the payload adapter cone.
  
  2. DAUGHTER CLEARANCE: When a strut is near the stowed position
     (α ≈ 0–15°), the daughter at the strut tip is near the bottom
     of the barrel — close to where the ROSA panel corners would be.
     Chamfering the ROSA corners at the rocket end provides extra
     clearance for the daughter bodies as struts rotate through
     the stow/deploy arc.

  SIDE VIEW — chamfer geometry:

        ┌─── ROSA ────────┐
        │                  │
        │   full width     │  ← panel at full 1.0m width for most
        │   (1.0m)         │     of the barrel length
        │                  │
        │                  │
        │        ╱         │  ← chamfer begins ~0.3m from bottom
        │      ╱           │     (matching daughter body height)
        └────╱─────────────┘
           ╱  ← rounded corner clears:
          ╱     (a) fairing adapter cone
         ╱      (b) daughter bodies during stow/deploy rotation

  Chamfer spec: 45° cut, 0.30m × 0.30m (removes triangle from each
  bottom corner of each ROSA panel). Reduces panel area by 2 × 0.045 m²
  = 0.09 m² total (2.3% loss, negligible power impact: -37W).
```

#### 3-Plane Layout (Top View)

```
                 +Z (prograde)
                     ↑
                     │
         ╱───── ROSA PANEL ─────╲      Plane 1: 0°/180° — solar only
        ╱    (1m wide each side) ╲
       ╱         ┌───┐            ╲
      ╱   strut  │   │  strut      ╲
     ●  (300°)   │BUS│   (60°)  ●     Plane 2: 60°/240° — arm pair 1
      ╲          │0.8│          ╱       (e.g., LD + SD)
       ╲  strut  │ m │  strut  ╱
        ●(240°)  │   │ (120°)●        Plane 3: 120°/300° — arm pair 2
         ╲       └───┘       ╱          (e.g., LD + SD)
          ╲                 ╱
           ╲─── ROSA PANEL ╱
                     │
                     ↓
                 -Z (retrograde)

  Angular separations:
    ROSA to nearest arm plane: 60° (guaranteed clearance)
    Between arm planes: 60°
    Between arms in same plane: 180° (antipodal)
```

#### Y0 Quad Arm Assignment

| Strut | Azimuth | Plane | Type | Role |
|-------|---------|-------|------|------|
| Strut 1 | 60° | 2 | Large Daughter (Weaver) | Primary capture |
| Strut 2 | 240° | 2 | Small Daughter (Spinner) | Fragment sweep |
| Strut 3 | 120° | 3 | Large Daughter (Weaver) | Primary capture |
| Strut 4 | 300° | 3 | Small Daughter (Spinner) | Fragment sweep |

Each plane has one LD + one SD = mixed pair. Dual-fire: (Strut 1 + Strut 2) or (Strut 3 + Strut 4) — each pair is in the same meridian plane, 180° apart azimuthally.

#### Updated Mass Budget — Config G with 2.0m Barrel

| Component | Mass | Notes |
|-----------|------|-------|
| **Bus core** (frame, electronics, tanks, thrusters, comms) | 152.0 kg | Elongated barrel (was 170 in V5 — lighter: smaller diameter 0.8m, no internal reels/springs/wing hardware) |
| **ROSA panels** (2 blankets + deployment mechanisms) | 6.0 kg | Replaces 16 kg rigid wings |
| **Body-mount GaAs cells** | 3.0 kg | On 6 octagonal faces |
| **4× strut assemblies** (structure + reel + spring + hinge + flex + launch lock) | 18.0 kg | 4 × 4.5 kg each |
| **4× daughters** (2 LD × 6.6 + 2 SD × 2.1) | 17.4 kg | Unchanged from V5 spec |
| **Propellant** (Xe + N₂) | 46.0 kg | Unchanged |
| **Y0 Dry Total** | **196.4 kg** | |
| **Y0 Wet Total** | **242.4 kg** | Under SSLV 300 kg limit ✅ |

*Note: Bus core is lighter than original 181 kg because: (a) no internal reels (-4.8 kg, moved to struts), (b) no internal springs (-2.0 kg, moved to struts), (c) no rigid wing deployment mechanism (-8.0 kg, replaced by ROSA), (d) smaller 0.8m diameter frame (-4.0 kg). Partially offset by longer barrel structure (+6.0 kg). Net core savings: ~12.8 kg, partially absorbed by strut assembly mass.*

**Result: Config G is actually 2 kg LIGHTER than the original Config A spec (242.4 vs 244.4 wet).** The ROSA mass savings and bus simplification offset the strut assemblies. The elongated barrel gains are real.

#### Config G Summary — All Tiers

| Tier | Arms | Struts | Planes | Dry Mass | Wet Mass |
|------|------|--------|--------|----------|----------|
| **Y0 Quad** | 4 (2LD + 2SD) | 4 | 2 arm planes + 1 panel plane | ~196 kg | ~242 kg |
| **Y1 Hex** | 6 (3LD + 3SD) | 6 | 3 arm planes + 1 panel plane* | ~208 kg | ~254 kg |
| **Y3 Octo** | 8 (3LD + 3SD + F + B) | 6+2** | 3 arm planes + 1 panel + F/B | ~222 kg | ~268 kg |

*Y1 Hex: 6 struts requires 3 arm planes at 40° spacing from each other, all offset from the ROSA plane. Layout: arms at 30°/90°/150°/210°/270°/330° (three planes at 60° intervals, offset 30° from ROSA 0°/180° plane). Maintains ≥30° ROSA clearance.*

**Y3 Octo Front/Back: two additional struts on end faces (+Z and -Z), with 90° barrel-axial sweep. These are in unique planes (the prograde/retrograde axis), perpendicular to ROSA. No panel conflict.*

#### Implementation Plan (Revised)

| ST Task | Description | Effort | Status |
|---------|-------------|--------|--------|
| **ST-9.2** | Replace [`generateDockPositions()`](js/entities/ArmManager.js:41) with top-collar 3-plane geometry. New [`Constants.OCTOPUS_V5`](js/core/Constants.js:254) block: barrel 2.0×0.8, collar position, strut length, 3-plane angles, ROSA spec. `ARM_LADDER` mass numbers updated. | 2 days | **UNBLOCKED** |
| **ST-9.3** | `setAimAlpha(alpha)` — 0–180° swing. Lockable hinge state (ROTATE vs LOCKED). Strut animation. Crossbow fires from strut tip. Recoil → RCS auto-compensate. | 3 days | **UNBLOCKED** |
| **ST-9.5** | Tether reel on strut tip — update reel-cycle model location. Flex cable wear tracking. | 1.5 days | UNBLOCKED |
| **ST-9.7** | Bridle ring geometry N/A for Config G (no FEEP plume at strut tip — daughter FEEP fires AWAY from strut). Simplify to tip-exit tether analysis only. | 0.5 day | SIMPLIFIED |
| **CAPTURE_NET.md** | Revise §4 tangle model for meridian-plane net departure. Re-derive tangle probabilities. | 1 day (doc only) | UNBLOCKED |
| **Constants.js** | Major revision — see §10.12 below. | Included in ST-9.2 | |

#### §10.12 Constants Changes Required

```javascript
// === CONFIG G — OCTOPUS V5 BARREL-AXIAL ===
OCTOPUS_V5: {
  // Barrel geometry (CHANGED from 1.2×1.0 to 2.0×0.8)
  CORE_LENGTH: 2.0,              // m (barrel height along Y) — was 1.2
  CORE_ACROSS_FLATS: 0.8,        // m (octagonal width) — was 1.0
  CORE_ASPECT_RATIO: 2.5,        // barrel shape factor

  // Collar (NEW)
  COLLAR_Y: 0.90,                // m from barrel center (+Y direction)
  COLLAR_RADIUS: 0.40,           // m (barrel surface radius at collar)

  // Strut (NEW — replaces short strut spec)
  STRUT_LENGTH: 1.60,            // m (hinge to daughter dock)
  STRUT_TUBE_OD: 0.050,          // m
  STRUT_TUBE_WALL: 0.002,        // m
  STRUT_MASS: 4.5,               // kg (structure + reel + spring + hinge)
  STRUT_SWEEP_MIN: 0,            // rad (stowed, alongside barrel = 0°)
  STRUT_SWEEP_MAX: Math.PI,      // rad (fully deployed above = 180°)
  STRUT_SLEW_RATE: 30 * Math.PI / 180, // rad/s (motor drive — 30°/s)

  // 3-Plane Layout (NEW)
  ROSA_PLANE_AZIMUTH: 0,         // rad (0° and 180° = ROSA panel plane)
  ARM_PLANE_OFFSET: Math.PI / 3, // rad (60° offset from ROSA)
  // Arm azimuths: [60°, 120°, 240°, 300°] for Y0 Quad

  // ROSA Panels (NEW — replaces rigid wing spec)
  ROSA_WIDTH: 1.0,               // m (extending from barrel surface)
  ROSA_LENGTH: 2.0,              // m (full barrel height)
  ROSA_CHAMFER: 0.30,            // m (corner chamfer for fairing + daughter clearance)
  ROSA_POWER: 1630,              // W (from ROSA alone)
  BODY_MOUNT_POWER: 610,         // W (GaAs on barrel faces)
  TOTAL_SOLAR_POWER: 2240,       // W (combined)

  // Hinge (NEW)
  HINGE_LOCK_TORQUE: 1000,       // N·m (brake hold capacity)
  HINGE_MOTOR_TORQUE: 10,        // N·m (drive torque for swing)
  HINGE_BEARING: 'Si3N4_MoS2',  // ceramic bearing + dry lube

  // Launch (NEW)
  LAUNCH_VEHICLE: 'SSLV',        // ISRO Small Satellite Launch Vehicle
  FAIRING_DIAMETER: 2.1,         // m (SSLV inner diameter)
  FAIRING_LENGTH: 2.5,           // m (SSLV usable length)
  STOWED_ENVELOPE_DIA: 1.2,      // m (barrel + stowed struts)
  STOWED_ENVELOPE_LEN: 2.3,      // m (barrel + ROSA roll overhang)

  // Mass budget (UPDATED for Config G)
  TOTAL_DRY_MASS: 196.4,         // Y0 Quad — was 198.4
  TOTAL_WET_MASS: 242.4,         // Y0 Quad — was 244.4
  CORE_DRY_MASS: 161.0,          // bus + ROSA + body-mount (no internal reels/springs/wings)
  // ... per-arm masses unchanged: WEAVER_MASS: 6.6, SPINNER_MASS: 2.1
},
```

### §10.10 Resolved Questions (formerly Open)

| # | Question | Resolution |
|---|----------|------------|
| Q-1 | Bus aspect ratio | **RESOLVED: 2.0m × 0.8m (2.5:1 ratio).** Gives 1.6m struts. Fits SSLV. |
| Q-2 | Arms at Y0 | **RESOLVED: 4 arms (Y0 Quad) in 2 planes.** Same count as before, new geometry. |
| Q-3 | ROSA retractability | **DEFERRED: always-deployed at Y0.** Retractability is a future gameplay option. |
| Q-4 | Config G for all tiers? | **RESOLVED: Config G for ALL tiers (Y0/Y1/Y3).** No equatorial fallback. Barrel-axial from day one. |
| Q-5 | Accept mass/rework cost? | **RESOLVED: Yes.** Mass is actually -2 kg vs old spec. Code rework ~7 days accepted. |

### §10.13 Remaining Work Items

| Item | Owner | Status |
|------|-------|--------|
| Update CROSSBOW_ARMS.md §8, §12, §17, §22, §25 with Config G dimensions | Architect (after signoff) | Ready to start |
| Update CAPTURE_NET.md §4 tangle model for meridian-plane departure | Architect | Ready to start |
| Update BIG_PICTURE.md §12, §13, §29 | Architect | Ready to start |
| Update IMPLEMENTATION_PLAN.md ST-9.2/9.3/9.5/9.7 specs | Architect | Ready to start |
| Update Constants.js OCTOPUS_V5 block | Code (ST-9.2) | Unblocked |
| Rewrite ArmManager.generateDockPositions() | Code (ST-9.2) | Unblocked |
| Implement setAimAlpha() + lockable hinge | Code (ST-9.3) | Unblocked |

---

### §10.14 Stowage Geometry — How Struts, Reels, Crossbows and Daughters Nest Against the Barrel

The barrel has 8 octagonal faces. Their assignment:

```
  BARREL FACE ASSIGNMENT (top view, looking down Y):

        +Z
         ↑
    Face 1 (0°)  ← ROSA panel mount
   ╱            ╲
  Face 8(315°)   Face 2(45°)
  │               │
  Face 7(270°)    Face 3(90°)
  │               │
  Face 6(225°)   Face 4(135°)
   ╲            ╱
    Face 5(180°) ← ROSA panel mount
         ↓
        -Z

  Face 1, 5:  ROSA panel root + deployment spool (0°/180°)
  Face 2, 6:  Arm strut channel (45°/225°) — NOT USED in Y0, reserved for Y1 Hex
  Face 3, 7:  Arm strut channel (90°/270°) — NOT USED in Y0, reserved for Y1 Hex
  Face 4, 8:  Arm strut channel at 60°-offset in Y0

  Y0 Quad uses 4 struts at 60°/120°/240°/300° — these map to
  positions between faces, straddling face edges. Each strut
  channel spans the corner between two adjacent faces.
```

**Actually, with an octagonal bus, the arm planes at 60° intervals don't align perfectly with face centers (which are at 45° intervals).** Resolution: use the octagonal CORNERS (which are at 22.5°, 67.5°, etc.) as strut mounting lines. Or: design the strut channel to straddle two faces.

**Simpler approach — the bus is octagonal in cross-section but the strut channels are independent longitudinal features:**

#### Recessed Channel Design

```
  BARREL CROSS-SECTION WITH STOWED STRUT (one of 4 channels):

              ← barrel face (~331mm wide) →
  ┌───────────────────────────────────────────┐
  │                                           │
  │    ┌──── strut channel ────┐              │
  │    │  ╔═══════════════════╗│              │
  │    │  ║ STRUT TUBE (50mm) ║│ ← tube sits │
  │    │  ║  half-recessed    ║│   in channel │
  │    │  ╚═══════════════════╝│              │
  │    └───────────────────────┘              │
  │         60mm wide × 30mm deep             │
  │                                           │
  │    remaining face area: thin-film cells    │
  └───────────────────────────────────────────┘

  Channel dimensions:
    Width:  60 mm (strut OD 50 + 5mm clearance each side)
    Depth:  30 mm (strut half-sunk into barrel wall)
    Length: ~1.70 m (from collar to daughter pocket)
    
  The strut protrudes 20mm above the barrel surface when stowed.
  Total stowed envelope increase: 20mm radial → negligible.
```

#### Daughter Pocket (at barrel bottom)

```
  Each strut channel terminates at the bottom in a DAUGHTER POCKET —
  a wider, deeper recess that cradles the daughter spacecraft body.

  SIDE VIEW — one strut channel + pocket:

  TOP COLLAR ────●═══════════════════════════╗ hinge
                 ║ strut tube (in channel)   ║
                 ║ 60mm × 30mm channel       ║
                 ║                           ║
                 ║   1.0m of channel         ║
                 ║   (strut only)            ║
                 ║                           ║
                 ╠═══════════════════════════╣ ← channel widens here
                 ║  REEL + CROSSBOW pocket   ║   0.3m from bottom
                 ║  150mm wide × 80mm deep   ║
                 ╠═══════════════════════════╣
                 ║  DAUGHTER POCKET           ║
                 ║  220mm wide × 120mm deep  ║   Weaver body: 200×200×300
                 ║  300mm tall               ║   Spinner body: smaller, padded
                 ╚═══════════════════════════╝
  BARREL BOTTOM ─────────────────────────────── payload adapter

  CROSS-SECTION AT DAUGHTER POCKET:

  ┌──────────────────────────────────────┐
  │          barrel face                 │
  │    ┌─────────────────────┐           │
  │    │  ┌───────────────┐  │ ← pocket │
  │    │  │   DAUGHTER     │  │   120mm  │
  │    │  │   (Weaver)     │  │   deep   │
  │    │  │   200×200×300  │  │          │
  │    │  └───────────────┘  │          │
  │    └─────────────────────┘           │
  │     220mm wide                       │
  └──────────────────────────────────────┘

  The daughter pocket:
  - Cradles the daughter body during launch (structural support)
  - The pocket walls act as launch restraint (lateral)
  - A single pyro pin at the pocket lip holds the daughter in place
  - On orbit: strut swings up → daughter exits pocket cleanly
```

#### Reel + Crossbow Section

```
  The reel and crossbow sit in a widened section of the channel,
  between the strut tube and the daughter pocket:

  DETAIL — REEL/CROSSBOW STOWED:

       strut tube (50mm OD)
           ║
  ═════════╬══════════════════════╗
           ║  REEL HOUSING        ║
           ║  ┌──────────────┐   ║  120mm wide × 80mm deep
           ║  │ tether spool │   ║  × 100mm long
           ║  │ + motor      │   ║  (hockey puck shape)
           ║  │ + brake      │   ║
           ║  └──────────────┘   ║
           ╠─────────────────────╣
           ║  CROSSBOW SPRING    ║
           ║  ┌──────────────┐   ║  120mm wide × 80mm deep
           ║  │ leaf spring  │   ║  × 250mm long (draw distance)
           ║  │ + shuttle    │   ║
           ║  │ + EPM latch  │   ║
           ║  └──────────────┘   ║
  ═════════╬══════════════════════╝
           ║
       DAUGHTER DOCK FACE
       (EPM + alignment cone)
           ↓
       [DAUGHTER in pocket]

  The crossbow fires ALONG the strut axis.
  When the strut swings to the desired angle,
  the crossbow fires and the daughter launches
  along that direction.
```

#### Launch Lock Summary

```
  Each stowed arm has 3 retention points:

  1. HINGE LOCK (top collar):
     2× redundant pyro pin-pullers through hinge housing
     Prevents any strut rotation during launch
     Released first on orbit

  2. CHANNEL GUIDES (along barrel):
     Strut tube sits in 30mm-deep channel
     Channel walls provide lateral restraint (±3g launch)
     No active lock needed — gravity + vibration push tube INTO channel
     (tube exits channel when strut rotates upward after hinge release)

  3. DAUGHTER POCKET LOCK (barrel bottom):
     1× pyro pin through pocket lip + daughter body
     Prevents daughter from rattling in pocket during launch
     Released simultaneously with hinge lock

  Total pyro devices per arm: 3 (2 hinge pins + 1 pocket pin)
  Total for 4 arms: 12 pyro devices
  Mass: 12 × 5g = 60g total (negligible)
  Heritage: every satellite deployable mechanism. TRL 9.
  
  DEPLOYMENT SEQUENCE (on orbit):
  1. Ground command: "ARM DEPLOY ENABLE"
  2. All 12 pyro devices fire simultaneously (50 ms)
  3. Struts are free to swing — but held at α≈0° by hinge motor brake
  4. Player commands individual arm deployment via game UI
  5. Hinge brake releases → motor swings strut to desired angle → brake locks
  6. Crossbow fires daughter from strut tip
```

#### Stowed Configuration — Complete Side View

```
  SSLV FAIRING ENVELOPE (2.1m × 2.5m):

  ╱─────────────────────────╲
  │                           │
  │    ROSA spool (rolled)    │  ~100mm dia cylinder at top
  │    ┌──────────────────┐   │
  │    │●═══strut═══╗     │   │  ● = hinge at collar
  │    │             ║     │   │  4 struts visible (2 in this plane)
  │    │ ┌─CHANNEL─┐ ║    │   │
  │    │ │ strut   │ ║    │   │  Barrel: 2.0m × 0.8m
  │    │ │ tube    │ ║    │   │
  │    │ │ in 30mm │ ║    │   │  Strut protrudes 20mm
  │    │ │ groove  │ ║    │   │  above barrel surface
  │    │ └─────────┘ ║    │   │
  │    │  ┌REEL/BOW┐ ║   │   │  Reel+crossbow in wider pocket
  │    │  └────────┘ ║    │   │
  │    │  ┌DAUGHTER┐ ║   │   │  Daughter in bottom pocket
  │    │  └────────┘ ║    │   │
  │    └──────────────────┘   │
  │    ROSA spool (rolled)    │  ~100mm dia cylinder at bottom
  │                           │
   ╲         adapter         ╱
    ╲───────┤    ├──────────╱
            └────┘
         SSLV payload adapter

  Stowed envelope:
    Width: 0.8m barrel + 2×0.02m strut protrusion = 0.84m
    Height: 2.0m barrel + 2×0.15m ROSA spools = 2.30m
    
  Fairing clearance:
    Width: 2.1m - 0.84m = 1.26m margin ✅
    Height: 2.5m - 2.30m = 0.20m margin (tight but adequate) ✅
```

---

### §10.15 Thin-Film Solar Cells on Barrel Body — Advantages and Specification

#### Why Thin-Film on the Barrel (Not Just ROSA)

The barrel has 6 non-ROSA faces (out of 8 octagonal faces). Even with strut channels cut into 4 of them, ~75% of the face area remains available for solar cells.

**Thin-film GaAs** (e.g., Alta Devices / Hanwha Q Cells heritage) is the ideal body-mount technology:

| Property | Rigid GaAs (conventional) | Thin-Film GaAs | Thin-Film CIGS |
|----------|--------------------------|----------------|----------------|
| Efficiency | 30% | 28.8% | 22% |
| Thickness | 200 µm | 2-10 µm | 2-4 µm |
| Areal mass | 0.84 kg/m² | 0.17 kg/m² | 0.10 kg/m² |
| Flexibility | Rigid (shatters) | Flexible (conforms to curves) | Flexible |
| Radiation tolerance | Excellent | Excellent | Good |
| AO tolerance | Good (coverglass) | Good (coverglass) | Needs coating |
| TRL (space) | 9 | 7 (ISS MISSE-FF test 2019) | 6 |
| Temperature coeff. | -0.25%/°C | -0.22%/°C | -0.36%/°C |

**Recommendation: Thin-film GaAs (28.8%) for all body-mount surfaces.**

#### Body-Mount Area Calculation

```
  Octagonal barrel: 0.8m across flats, 2.0m tall
  Face width: 0.8 × tan(22.5°) = 0.331m per face
  Face area: 0.331 × 2.0 = 0.662 m² per face

  8 faces total: 8 × 0.662 = 5.30 m²

  Subtract:
    2 ROSA faces (panel root hardware, blocked): 2 × 0.662 = 1.32 m²
    4 strut channels (60mm × 1.7m per channel):  4 × 0.060 × 1.7 = 0.41 m²
    4 daughter pockets (220mm × 300mm):           4 × 0.220 × 0.3 = 0.26 m²
    4 reel/bow pockets (150mm × 350mm):           4 × 0.150 × 0.35 = 0.21 m²
    Miscellaneous (ports, hatches, connectors):    ~0.30 m²

  Available body-mount area: 5.30 - 1.32 - 0.41 - 0.26 - 0.21 - 0.30 = 2.80 m²
```

#### Power from Body-Mount Thin-Film

```
  Body-mount area: 2.80 m²
  Thin-film GaAs efficiency: 28.8%
  Average illumination factor: 0.25 (octagonal barrel — at any sun angle,
    ~2 faces are fully lit, ~2 are partially lit, ~4 are shadowed)

  Body-mount power: 2.80 × 1361 × 0.288 × 0.25 = 275 W average

  But with STRUTS DEPLOYED (arms swung out, channels empty):
    Exposed channel area becomes available: +0.41 m²
    Power increases slightly: +40W = ~315 W average

  Body-mount thin-film is a SUPPLEMENT, not a replacement for ROSA.
  It provides:
    ✅ Baseline power even if ROSA fails to deploy (survival mode)
    ✅ Power during eclipse exit (barrel faces catch first dawn light
       before ROSA — faster wake from eclipse)
    ✅ Charging during attitude maneuvers (some faces always lit)
    ✅ Redundant power source (different failure modes than ROSA)
```

#### Key Advantages of Body-Mount Thin-Film

1. **No deployment mechanism** — cells are laminated directly onto the barrel panels during factory assembly. Zero moving parts. Cannot fail to deploy. TRL 9 for the application process (same as thermal blanket bonding).

2. **Conforms to octagonal faces** — thin-film GaAs is flexible enough to follow the gentle curves of the barrel face transitions. No custom mounting brackets.

3. **Survives launch without protection** — thin-film cells are bonded to the structural panel. No fragile standoff-mounted rigid arrays to worry about during vibration.

4. **Mass: ~0.5 kg total** for 2.8 m² at 0.17 kg/m². Trivial.

5. **Acts as thermal coating** — GaAs cells have an absorptivity/emissivity ratio (α/ε ≈ 0.8/0.8) similar to thermal paint. The cells functionally replace thermal coating on covered areas — dual-use mass.

6. **Operates when ROSA is stowed** — during launch vehicle separation and initial deployment, before ROSA unrolls, the body-mount cells provide immediate power. No "dead time" after separation.

7. **Eclipse recovery advantage** — the barrel rotates relative to the sun during orbit. Body-mount cells on multiple faces catch sunlight from the moment the first face exits eclipse shadow, ~30 seconds before the flat ROSA panel reaches optimal angle.

#### Updated Power Budget

| Source | Area | Efficiency | Illumination Factor | Power |
|--------|------|-----------|--------------------|----|
| ROSA (2 panels) | 4.0 m² | 30% GaAs rigid | 0.80 (tracked) | 1,306 W |
| Body-mount thin-film | 2.8 m² | 28.8% GaAs flex | 0.25 (average) | 275 W |
| **TOTAL** | | | | **~1,581 W average** |
| **PEAK** (ROSA sun-pointed) | | | | **~1,900+ W** |

*Note: ROSA efficiency is 30% (rigid GaAs cells on flexible blanket substrate — this is standard for iROSA). The blanket substrate is flexible but the cells themselves are standard rigid GaAs, cut thinner and tiled onto the flex substrate.*

*The 0.80 illumination factor for ROSA accounts for the non-tracking fixed mount — the ROSA panels are fixed in the 0°/180° plane and only get full sun when the sun is in that plane. Average over the orbit: ~80% for LEO with favorable beta angle.*

---

### §10.16 ROSA Deployment Mechanism — Simplest Reliable Option

#### Heritage: What Actually Works

The simplest, most reliable solar array deployment mechanism in space history is the **strain-energy boom** (also called STEM — Storable Tubular Extendable Member, or BIST — Bi-Stable Tape Spring):

```
  HOW A STRAIN-ENERGY BOOM WORKS:

  STOWED:                          DEPLOYED:
  
  ┌─────────┐                     ┌─────────┐
  │ coiled   │                    │         │
  │ flat     │  release pin       │         │
  │ strip    │  ────────────→     │    │    │ ← flat strip has
  │ (spring  │                    │    │    │   self-formed into
  │  steel   │                    │    │    │   a rigid TUBE
  │  or CFRP)│                    │    │    │   under its own
  └─────────┘                     │    │    │   stored strain energy
    ~100mm dia                    │    │    │
    coiled drum                   │    │    │
                                  │    │    │
                                  └────┤────┘
                                       │
                                  extended boom
                                  (rigid tube, 2-3m)

  The flat strip WANTS to be a tube (it was manufactured curved).
  When coiled on a drum, it's stored energy — like a tape measure.
  Release the retaining pin → strip uncoils → forms tube → rigid boom.
  
  NO MOTOR. NO GEARS. NO ELECTRONICS (except the release command).
  Just a pin-puller and physics.
```

**Heritage:**
| Mission | Year | Boom Type | Length | Payload | Status |
|---------|------|-----------|--------|---------|--------|
| RAE-1 (NASA) | 1968 | STEM boom | 229 m (!) | Radio astronomy antenna | ✅ Worked |
| MARSIS (ESA/Mars Express) | 2005 | BIST tape spring | 20 m × 2 | Radar sounder | ✅ Worked |
| ISS iROSA | 2021 | ROSA + composite boom | 19 m per wing | 20 kW solar | ✅ Working |
| Starlink v2 | 2023+ | Compact ROSA variant | ~6 m per wing | 2.5 kW per sat | ✅ Millions of unit-hours |
| NanoAvionics CubeSat wings | 2020+ | Tape-spring deployer | 0.5-2 m | 10-50 W CubeSat | ✅ 100+ flights |

**TRL 9.** This is not exotic. Every space agency has flown these.

#### Config G ROSA Deployment Design

```
  DEPLOYMENT SEQUENCE:

  ┌─────────────────────────────────────────────────────────┐
  │                                                         │
  │  STEP 1: RELEASE (T+0 ms)                              │
  │  Pyro pin-puller fires on ROSA spool retention latch.   │
  │  Two redundant pins (either alone releases).            │
  │  Energy: 12V pulse, 10ms. Mass: 5g per pin.            │
  │                                                         │
  │  STEP 2: BOOM EXTENDS (T+0 to T+30s)                   │
  │  Pre-stressed CFRP tape spring uncoils from spool.      │
  │  As it extends, it pulls the ROSA blanket off the drum. │
  │  The tape spring forms a rigid tube (~20mm OD) as it    │
  │  exits the spool housing — this tube IS the boom.       │
  │                                                         │
  │        spool housing                                    │
  │        ┌────────┐                                       │
  │  ══════╡ ◉ drum ╞═══════ boom extends ═══════→          │
  │        └────┬───┘                                       │
  │             │ ROSA blanket pulls off drum                │
  │             ▼                                           │
  │        ┌────────────────────────────────┐               │
  │        │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │ ← solar cells │
  │        │ ROSA BLANKET unfurling         │   face sunward │
  │        │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │               │
  │        └────────────────────────────────┘               │
  │                                                         │
  │  STEP 3: LOCK (T+30s)                                  │
  │  Boom reaches full extension.                           │
  │  Self-locking: the formed tube geometry naturally        │
  │  resists compression. No active lock needed.            │
  │  Blanket is taut between spool edge and boom tip.       │
  │                                                         │
  │  STEP 4: VERIFY (T+35s)                                │
  │  Current sensor on solar bus confirms power generation.  │
  │  If <50% expected power → "ROSA PARTIAL" flag.          │
  │  If zero power → ROSA may be stuck. Body-mount cells    │
  │  provide survival power. Ground command can retry or     │
  │  proceed on body-mount only (reduced capability).       │
  │                                                         │
  └─────────────────────────────────────────────────────────┘

  Deployment direction: along barrel Y-axis (up from top spool,
  down from bottom spool). Blanket unfurls in the 0°/180° plane.
  
  Fully deployed:
  ═══ boom (rigid tube) ═══ blanket (1m × 2m) ═══ boom tip
  extending 2-3m above and below the barrel.
```

#### Why Not a Motor-Driven Roll-Out?

A motor could unroll the ROSA more precisely. But:

| Factor | Strain-Energy Boom | Motor Drive |
|--------|-------------------|-------------|
| Moving parts | 0 (after pin release) | Motor + gearbox + encoder |
| Power needed | 0 (stored energy) | 5-15W during deploy |
| Deploy time | ~30s (self-extending) | ~60s (controlled) |
| Can jam? | Very unlikely (strain energy overcomes friction) | Motor failure = stuck panel |
| Can retract? | No (one-shot deploy) | Yes (reversible motor) |
| Mass | ~0.3 kg per boom | ~0.8 kg per motor+boom |
| Reliability | 99.9%+ (heritage) | 99%+ (heritage, but more parts) |

**For Config G: strain-energy boom is recommended.** It's the simplest, lightest, most reliable option. If ROSA retraction is desired later (Y1+ upgrade), a motor can be added to the boom housing — the design accommodates this.

#### Redundancy and Failure Modes

```
  2 ROSA panels (0° and 180°) are INDEPENDENT:
  
  - Each has its own spool, boom, pin-puller, and power bus
  - If Panel A fails to deploy, Panel B alone provides:
    ~815W ROSA + 275W body-mount = 1,090W → minimum operational power ✅
  - If BOTH ROSA panels fail: body-mount alone provides 275W
    → survival mode only (no crossbow reload, limited FEEP thrust)
    → ground command: "Configure for minimum-power operations"
    → game mechanic: "ROSA FAILURE — conserve power" challenge mode

  Pin-puller redundancy:
    Each ROSA has 2 pins. Either alone releases.
    P(both pins fail) = P(pin fail)² = (0.001)² = 10⁻⁶ per panel
    P(both panels both pins fail) = (10⁻⁶)² = 10⁻¹² → essentially impossible

  Boom jam probability:
    Heritage data: <0.1% jam rate across all STEM/BIST deployments
    With 2 independent booms (one per panel): P(both jam) = (0.001)² = 10⁻⁶
```

#### Spool Housing Location

```
  SIDE VIEW — ROSA spool locations:

        ┌─ ROSA spool housing (top) ─┐     ~120mm dia × 100mm long
        │  contains: rolled blanket   │     Sits on TOP face of barrel
        │  + coiled CFRP boom strip   │     in the 0°/180° azimuthal plane
        │  + 2× pyro pin-pullers      │
        └─────────────┬───────────────┘
                      │
              BARREL (2.0m)
                      │
        ┌─────────────┴───────────────┐
        │  ROSA spool housing (bottom)│     Mirror of top
        │  Same contents              │     Sits on BOTTOM face
        └─────────────────────────────┘

  Each spool deploys its ROSA blanket OUTWARD (away from barrel)
  along the Y-axis. Top spool → panel extends upward.
  Bottom spool → panel extends downward.
  
  Total spool mass: 2 × (blanket 1.5kg + boom 0.3kg + housing 0.5kg + pins 10g)
                  = 2 × 2.31 = 4.62 kg
  (vs current budget of 6.0 kg — under budget ✅)
```

#### Game Visual

When the player first deploys from the SSLV upper stage, the deployment sequence is:

1. **Separation** — Mother separates from SSLV adapter (pyro bolt, 1 second)
2. **Tumble stabilization** — Cold-gas RCS damps rotation (5-10 seconds)
3. **ROSA deploy** — Two golden ROSA blankets unfurl above and below the barrel, glinting in sunlight (30 seconds, dramatic time-lapse in game)
4. **Power confirmed** — HOUSTON: *"Solar arrays nominal. 2,240 watts. Your batteries are charging."*
5. **Arm release** — Pyro pins fire on all 4 strut channels. HOUSTON: *"Arms free. Ready for operations."*

This is a visually striking sequence — the compact stowed cylinder transforms into a winged, armed spacecraft. The fishing poles don't emerge until the player deploys them on command.

---

## §11 Orchestrator Implementation Handoff

> **This section is the authoritative task brief for orchestrator mode.** All design decisions are locked. No further architect review needed unless the orchestrator encounters contradictions.

### §11.1 What Changed (Config G vs Prior Spec)

The following table summarizes every parameter that differs from the previous design (Config A equatorial, [`Constants.OCTOPUS_V5`](js/core/Constants.js:254)):

| Parameter | Old Value (Config A) | New Value (Config G) | Impact |
|-----------|---------------------|---------------------|--------|
| `CORE_LENGTH` | 1.2 m | **2.0 m** | Barrel elongated. All internal systems repackaged. Visual model changes. |
| `CORE_ACROSS_FLATS` | 1.0 m | **0.8 m** | Narrower barrel. Fairing fit improved. |
| `TOTAL_DRY_MASS` | 198.4 kg | **196.4 kg** | 2 kg lighter (ROSA savings offset struts) |
| `TOTAL_WET_MASS` | 244.4 kg | **242.4 kg** | Same delta |
| Arm mount location | Equator (Y=0), radial | **Top collar (Y=+0.9m), axial** | Complete geometry rewrite |
| Arm sweep | ±30° yaw in equatorial plane | **0–180° in meridian plane** | New aim API |
| Aim method | `setAimYaw(yaw)` | **`setAimAlpha(alpha)`** | API change |
| [`dockOutward`](js/entities/ArmManager.js:50) | Radial vector in XZ plane | **Meridian-plane swing direction** | Geometry rewrite |
| Solar panels | Rigid deployable wings (3m span, port+starboard) | **ROSA (2×2m×1m, along barrel axis in 0°/180° plane) + thin-film GaAs on barrel body** | New power system model |
| Panel power | 1,900 W | **~2,240 W peak / ~1,580 W average** | Power budget improves |
| Tether reel location | Inside bus (behind dock cavity) | **On strut tip** | Reel-cycle model unchanged but physical position moves |
| Hinge type | ±30° harmonic gear | **0–180° lockable rotary joint** (free-wheel + lock modes) | New mechanism |
| Stow geometry | Arms radial, compact | **Recessed channels along barrel, daughter pockets at bottom** | New stow model + launch locks |
| Launch vehicle | PSLV (implied) | **SSLV primary** (PSLV rideshare backup) | Fairing constraint tightens |
| Recoil handling | Antipodal dual-fire = zero recoil | **RCS compensates (~10% N₂ budget)** | Recoil no longer zero, but acceptable |

### §11.2 Doc-Only Tasks (Architect Mode)

These tasks update existing design docs to reflect Config G. **No code changes.** Each is a standalone architect-mode task.

| # | Task | Files | Effort | Dependencies |
|---|------|-------|--------|-------------|
| D-1 | Update [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md) §2.4 (arm positions), §8 (aiming), §12 (8-arm config), §12.5 (mass tables), §15 (Y-harness — simplify for strut-tip reel), §17 (solar/thruster integration), §22 (migration guide), §25 (tech ladder + strut DOF) with Config G barrel dimensions, 3-plane layout, ROSA spec, strut-mounted reel, recessed channels. | CROSSBOW_ARMS.md | 1 day | None |
| D-2 | Update [`CAPTURE_NET.md`](CAPTURE_NET.md) §4 (tangle model) — revise from equatorial planar departure to meridian-plane departure. Re-derive 5 tangle scenario probabilities. Update §5 (launch mechanics) for strut-tip crossbow fire direction. | CAPTURE_NET.md | 0.5 day | D-1 |
| D-3 | Update [`BIG_PICTURE.md`](BIG_PICTURE.md) §11 (V5 goals), §12 (config trade study — Config G replaces Quad Linear / Hex Umbrella / Double Umbrella), §13 (crossbow refinements), §29 (net summary), §35 (audit — ROSA replaces rigid wings), §36 (tech ladder). | BIG_PICTURE.md | 0.5 day | D-1 |
| D-4 | Update [`IMPLEMENTATION_PLAN.md`](archive/IMPLEMENTATION_PLAN_2026-06.md) §0 (completion log — note Config G adoption), ST-9.2 spec (replace equatorial generator with collar geometry), ST-9.3 spec (setAimAlpha, lockable hinge, RCS recoil), ST-9.5 (reel on strut tip), ST-9.7 (bridle ring → simplified for strut-tip exit). Add new ST-9.10 (stow/deploy state machine), ST-9.11 (launch locks + ROSA deploy sequence). | IMPLEMENTATION_PLAN.md | 0.5 day | D-1 |
| D-5 | Update [`HANDOFF.md`](HANDOFF.md) §3 — note Config G adoption, link to this analysis doc, update Epic 9 status. | HANDOFF.md | 0.25 day | D-4 |

**Total doc-only effort: ~2.75 days.**

### §11.3 Code Tasks (Code Mode)

| # | Task | Files | Effort | Dependencies |
|---|------|-------|--------|-------------|
| C-1 | **ST-9.2 rewrite: Constants + ArmManager geometry** — Replace [`OCTOPUS_V5`](js/core/Constants.js:254) block with Config G values (§10.12). Replace [`ARM_LADDER`](js/core/Constants.js:296) mass numbers. Rewrite [`generateDockPositions()`](js/entities/ArmManager.js:41) for top-collar 3-plane geometry (azimuth 60°/120°/240°/300° at Y=+0.9m, strut length 1.6m). Add `STRUT_*`, `ROSA_*`, `COLLAR_*`, `HINGE_*` constant blocks. Add `LAUNCH_VEHICLE` spec. | Constants.js, ArmManager.js | 2 days | D-1, D-4 |
| C-2 | **ST-9.3 rewrite: Aim + Hinge + Recoil** — Implement `ArmUnit.setAimAlpha(alpha)` (0–180° meridian sweep). Add hinge state machine (ROTATE ↔ LOCKED). Strut swing animation in scene. RCS auto-compensation on crossbow fire (apply opposite impulse via PlayerSatellite). Pre-fire rotation interlock (ω < 0.5°/s). | ArmUnit.js, ArmManager.js, PlayerSatellite.js, AutopilotSystem.js | 3 days | C-1 |
| C-3 | **Stow/deploy visuals** — Strut swing animation. Recessed channel geometry on barrel model. Daughter pocket positions. Stow → deploy visual sequence. | ArmUnit.js, PlayerSatellite visual model (if applicable) | 1 day | C-1, C-2 |
| C-4 | **ROSA deployment visual** — Strain-energy boom unfurl animation on game start. Two golden panels extending along barrel axis. Power confirmation event. | New or SceneManager.js, PlayerSatellite.js, Events.js | 1 day | C-1 |
| C-5 | **Tests** — Rewrite [`test-Crossbow-ArmUnit.js`](js/test/test-Crossbow-ArmUnit.js:1) and [`test-Crossbow-Constants.js`](js/test/test-Crossbow-Constants.js:1) for new geometry. New test: collar geometry produces valid 3-plane positions. New test: `setAimAlpha` range validation. New test: recoil impulse magnitude. New test: hinge lock state prevents rotation. Target: 0 regressions on existing 1,267 tests. | js/test/*.js | 1 day | C-1, C-2 |

**Total code effort: ~8 days** (was estimated 5-7 in §10.7; revised up to include stow visuals + ROSA animation + comprehensive tests).

### §11.4 Execution Order

```
  Phase 1 — Docs (architect mode, 2.75 days):
    D-1 → D-2, D-3, D-4 (parallel after D-1) → D-5

  Phase 2 — Code (code mode, 8 days):
    C-1 (constants + geometry) → C-2 (aim + hinge) → C-3, C-4 (parallel) → C-5 (tests last)

  CRITICAL PATH: D-1 → C-1 → C-2 → C-5
  Total critical path: 1 + 2 + 3 + 1 = 7 days
  With parallel tasks: ~8-9 calendar days total.
```

### §11.5 Acceptance Criteria

| Criterion | Verification |
|-----------|-------------|
| Barrel renders at 2.0m × 0.8m | Visual inspection |
| 4 strut hinges visible at top collar | Visual inspection |
| Struts stow in recessed channels alongside barrel | Visual inspection |
| Strut swing animation 0–180° | Test: aim alpha at 0, 90, 180 |
| Daughters fire from strut tip along strut direction | Test: launch direction matches strut angle |
| Tether exits from strut-tip reel (not from bus) | Visual + test: tether origin = strut tip position |
| ROSA panels visible along barrel axis in 0°/180° plane | Visual inspection |
| Config G mass: Y0 dry ≈196 kg, wet ≈242 kg | Test: Constants values match |
| 3-plane arm layout: arms at 60°/120°/240°/300° | Test: generateDockPositions() output |
| RCS compensates crossbow recoil (non-zero impulse) | Test: PlayerSatellite receives compensating impulse on ARM_FIRE |
| Hinge locks during capture (no rotation under tether load) | Test: hinge state = LOCKED during GRAPPLED/REELING |
| Existing 1,267 tests pass with 0 regressions | `./test.sh` green |
| Stowed envelope fits SSLV: ≤2.1m dia, ≤2.5m height | Test: Constants stowed envelope values |

### §11.6 Risk Register

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Constants changes break downstream systems | Medium | High | Run full test suite after C-1 before proceeding |
| New barrel dimensions don't look right in 3D | Low | Medium | Iterate on visual proportions with user before C-3 |
| Strut swing animation performance (4 animated hinges + tethers) | Low | Medium | Use single THREE.js bone per strut, not physics sim |
| Tangle model revision (D-2) reveals new failure modes | Low | Low | Capture as open items for ST-9.4d |
| SSLV fairing fit is too tight (0.2m height margin) | Low | Medium | Fall back to PSLV rideshare (eliminates constraint) |

*End of document. Config G fully specified and ready for orchestrator implementation handoff.*
