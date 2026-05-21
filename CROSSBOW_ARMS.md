# V5 Crossbow Arms — Spring-Loaded Tethered Capture System
# Redesign of V3/V4 FEEP-Thrust Arm Deployment to Mechanically-Justified Stored-Energy Launch

> **⚠️ CONFIG G ADOPTED (2026-04-27)** — This document was written for equatorial-mount arm geometry (Config A/F).
> **Config G (barrel-axial top-collar, 3-plane layout, strut-mounted reel)** is now the target architecture
> per [`ARM_PIVOT_ANALYSIS.md §10`](ARM_PIVOT_ANALYSIS.md:801). Key differences:
> - **Arm mount:** Top collar (Y=+0.9m), not equatorial (Y=0)
> - **Sweep:** 0–180° meridian, not ±30° yaw — API: `setAimAlpha(alpha)` replaces `setAimYaw(yaw)`
> - **Barrel:** 2.0m × 0.8m (was 1.2m × 1.0m)
> - **Solar:** ROSA panels in 0°/180° plane (replaces rigid wings)
> - **Reel:** On strut tip (not inside bus) — Y-harness bridle (§15) superseded
> - **Mass:** Y0 dry=196.4, wet=242.4 (was 198.4/244.4)
>
> Sections marked with ⚠️ CONFIG G below contain notes on what changed. Cross-bow spring physics (§1–§5),
> tether material (§6–§7), and senior engineering review (§24) remain valid.
> For full Config G specs see [`ARM_PIVOT_ANALYSIS.md §10.11`](ARM_PIVOT_ANALYSIS.md:1236).
> For Epic 9 implementation specs see [`ARM_PIVOT_GAPS_EXPLAINER.md §W`](ARM_PIVOT_GAPS_EXPLAINER.md).
>
> **Design replacement for** [`ARM_GAMIFIED_THRUST_MULT: 200`](js/core/Constants.js:625) and [`ARM_LAUNCH_SPEED: 10.0`](js/core/Constants.js:626).
> Every velocity, force, and energy value in this document is derived from first principles — no magic multipliers.
> Baseline: [V3 Octopus.md](archive/V3%20Octopus.md) architecture. GSL upgrade path: [V4 Opussy.md](archive/V4%20Opussy.md).

---

## Table of Contents

1. [Executive Summary & Problem Statement](#1-executive-summary--problem-statement)
2. [Reload Time & Arm Position/Orientation](#2-reload-time--arm-positionorientation)
3. [Tether Attachment & Reel on Mother to Slow Arm](#3-tether-attachment--reel-on-mother-to-slow-arm)
4. [Reel-In for Minimum Propellant Use](#4-reel-in-for-minimum-propellant-use)
5. [Dual-Release Stabilization](#5-dual-release-stabilization)
6. [GSL Tether Specifications](#6-gsl-tether-specifications)
7. [Tether Material Upgrade Path](#7-tether-material-upgrade-path)
8. [Aimable Crossbows vs Aimable Mother](#8-aimable-crossbows-vs-aimable-mother)
9. [Synthetic Aperture Scanning — Simultaneous Fire](#9-synthetic-aperture-scanning--simultaneous-fire)
10. [Forward Target — Fire Ahead, Reel for Momentum Transfer](#10-forward-target--fire-ahead-reel-for-momentum-transfer)
11. [Rear Target — Fire Past, Ablation Propulsion](#11-rear-target--fire-past-ablation-propulsion)
12. [8-Arm Configuration & Arrangement](#12-8-arm-configuration--arrangement)
13. [Tether Routing to Avoid Ion Thruster Damage](#13-tether-routing-to-avoid-ion-thruster-damage)
14. [8 Tether Reels — Placement, Orientation, Tension, Tangles](#14-8-tether-reels--placement-orientation-tension-tangles)
15. [Y-Harness Tether Bridle — Geometry, FEEP Clearance & Materials](#15-y-harness-tether-bridle--geometry-feep-clearance--materials)
16. [Mother Attitude & Force Management During Launch/Reel](#16-mother-attitude--force-management-during-launchreel)
17. [Integration with Mother Systems — Thrusters, Solar, Sensors, Comms](#17-integration-with-mother-systems--thrusters-solar-sensors-comms)
18. [Space Environment Threats — AO, UV, Thermal, MMOD](#18-space-environment-threats--ao-uv-thermal-mmod)
19. [Zero-Gravity Tether Tension — Always Taut or Tangle](#19-zero-gravity-tether-tension--always-taut-or-tangle)
20. [GSL Conductivity, HBN Coating & Electrical Architecture](#20-gsl-conductivity-hbn-coating--electrical-architecture)
21. [Crossbow Value Proposition — Is Mother Redesign Justified?](#21-crossbow-value-proposition--is-mother-redesign-justified)
22. [V3 → V5 Migration Guide](#22-v3--v5-migration-guide)
23. [System Comparison: Current vs Crossbow](#23-system-comparison-current-vs-crossbow)
24. [Senior Engineering Review — Edge Cases, Trades & Operational Limits](#24-senior-engineering-review--edge-cases-trades--operational-limits)

---

## 1. Executive Summary & Problem Statement

### 1.1 What's Wrong with V3 Arm Deployment

The V3 Octopus uses FEEP ion thrusters (Enpulsion NANO R3) producing **0.35 mN** real thrust on an 11 kg Weaver arm. Real acceleration:

```
a_real = F/m = 0.00035 / 11.0 = 0.0000318 m/s² = 31.8 µm/s²

Time to reach 1 m/s:  t = v/a = 1.0 / 0.0000318 = 31,400 seconds ≈ 8.7 hours
Time to reach 10 m/s: t = 10.0 / 0.0000318 = 314,000 seconds ≈ 3.6 days
```

This is physically correct for ion propulsion — FEEP thrusters are for *orbit maintenance*, not rapid deployment. The current code solves this with two hacks:

| Hack | Constant | Value | Problem |
|---|---|---|---|
| Thrust multiplier | [`ARM_GAMIFIED_THRUST_MULT`](js/core/Constants.js:625) | `200` | Makes FEEP 200× stronger than real — completely fake |
| Launch velocity | [`ARM_LAUNCH_SPEED`](js/core/Constants.js:626) | `10.0 m/s` | Arbitrary initial kick with no mechanism |

**Result:** The game's core identity — "simulation of real technology" — breaks at the most visible mechanic: arm deployment. Every time a player fires an arm, they're watching fantasy physics.

### 1.2 The Crossbow Solution

Replace the gamified FEEP launch with a **spring-loaded crossbow mechanism** — stored mechanical energy released on command. This is:

- **Physically real**: Springs/elastic bands store energy, release it as kinetic energy. ½mv² is exact.
- **Mechanically justified**: Crossbow mechanisms are TRL 9 (every spring-loaded satellite deployer uses this principle).
- **Tunable**: Spring constant k and draw distance d set the launch velocity precisely: v = √(kd²/m).
- **Dramatically satisfying**: The crossbow metaphor fits the "Space Cowboy" identity far better than invisible ion thrust.

FEEP thrusters remain — they provide **fine maneuvering** during APPROACH and NETTING states, exactly what ion propulsion is designed for. The crossbow handles UNDOCKING → TRANSIT (the high-ΔV phase).

### 1.3 Heritage

| Mechanism | TRL | Reference | Relevance |
|---|---|---|---|
| Spring-loaded CubeSat deployer (P-POD) | 9 | Cal Poly / NanoRacks | Kangaroo spring ejects 1.3 kg CubeSat at 1.5–2.0 m/s |
| Lightband separation system (PSC) | 9 | Planetary Systems Corp | Spring pushes payloads up to 300 kg at 0.3–1.5 m/s |
| ISIPOD deployer | 9 | ISISpace | Spring mechanism, 0.5–2.5 m/s deployment |
| Crossbow prod limb | 9 | Ancient technology | Stored elastic energy → projectile. Same physics. |
| RemoveDEBRIS net launcher | 7 | Surrey/SSTL | Compressed gas fires net at ~5 m/s |

---

## 2. Reload Time & Arm Position/Orientation

### 2.1 Crossbow Mechanism Design

```
CROSSBOW MECHANISM — SIDE CUTAWAY (single docking cavity)

     ◄── FIRE DIRECTION ──►

  ┌─────────────────────────────────────────────┐
  │  ARM (docked position)                      │
  │  ┌───────────┐                              │
  │  │ ████ ARM  │◄──────── Shuttle plate       │
  │  │ ████ BODY │         (slides in groove)   │
  │  └───────────┘                              │
  │       │                                     │
  │       ▼                                     │
  │  ═══[SPRING PACK]═══                        │
  │  │   3× leaf springs  │                     │
  │  │   or torsion bar   │                     │
  │  │   draw = 0.25 m    │                     │
  │  ═══════════════════════                    │
  │       │                                     │
  │       ▼                                     │
  │  ┌─[RATCHET PAWL]──┐                        │
  │  │  Worm gear motor │                        │
  │  │  (irreversible)  │                        │
  │  └──────────────────┘                        │
  │                                             │
  │  ┌─[EPM LATCH]──────┐                       │
  │  │  Holds arm until  │                       │
  │  │  fire command     │                       │
  │  └──────────────────┘                        │
  └─────────────────────────────────────────────┘
                    DOCKING CAVITY (in octagonal bus)
```

**Spring pack design:**

```
Target: Weaver arm (11.0 kg) at selectable launch velocity

Energy stored: E = ½mv²
  At  5 m/s:  E = ½ × 11.0 × 25   = 137.5 J
  At 10 m/s:  E = ½ × 11.0 × 100  = 550.0 J  ← default
  At 15 m/s:  E = ½ × 11.0 × 225  = 1237.5 J ← maximum
  At 20 m/s:  E = ½ × 11.0 × 400  = 2200.0 J ← requires V5 spring upgrade

Spring sizing: E = ½kd²  →  k = 2E/d²
  Draw distance d = 0.25 m (fits within 0.3m-deep cavity)
  
  At 550 J:  k = 2 × 550 / 0.0625 = 17,600 N/m  (17.6 kN/m)
  Peak force: F_max = k × d = 17,600 × 0.25 = 4,400 N (4.4 kN)

Spinner arm (3.7 kg) at 10 m/s:
  E = ½ × 3.7 × 100 = 185 J
  k = 2 × 185 / 0.0625 = 5,920 N/m
  F_max = 5,920 × 0.25 = 1,480 N (1.48 kN)
```

**Spring material:** Maraging steel (17-7PH or Custom 455). Proven in space deployers. Maintains elastic properties across -150°C to +120°C vacuum thermal cycling. ✅ TRL 9.

### 2.2 Release Time

The actual spring release is **near-instantaneous** — the arm accelerates through 0.25 m of draw distance:

```
Assuming constant force (idealized spring with pre-load):
  t_release = d / (v/2) = 0.25 / 5.0 = 0.050 seconds (50 ms)
  
More accurately, for linear spring from rest:
  t = π/2 × √(m/k) = π/2 × √(11.0/17600) = π/2 × 0.025 = 0.039 s ≈ 40 ms

For Spinner:
  t = π/2 × √(3.7/5920) = π/2 × 0.025 = 0.039 s ≈ 40 ms
```

The EPM latch demagnetizes in ~1 ms. Total **UNDOCKING time: 0.05 s** mechanical + 0.25 s for clearance check + animation = **~0.3 s** gameplay (vs current [`ARM_DETACH_DURATION: 2.0`](js/core/Constants.js:192)).

### 2.3 Reload Time (Rearm the Crossbow)

Reloading requires:
1. Reel arm back into cavity via tether reel (~10 s at 2 m/s for last 20 m)
2. Guide arm into shuttle plate (magnetic alignment, ~2 s)
3. Worm gear motor compresses spring (main time cost)

```
Motor reload calculation:
  Energy to store: 550 J (for 10 m/s launch)
  Motor: 15 W electric (same as tether reel motor — TETHER_REEL_POWER)
  Mechanical efficiency: 70% (worm gear + friction)
  Effective power: 15 × 0.70 = 10.5 W
  
  Reload time = E / P_eff = 550 / 10.5 = 52.4 seconds ≈ 55 s with margin
  
  For Spinner (185 J):
  Reload time = 185 / 10.5 = 17.6 seconds ≈ 20 s

  With upgraded 30 W motor:
  Weaver: 550 / 21 = 26.2 s ≈ 30 s
  Spinner: 185 / 21 = 8.8 s ≈ 10 s
```

| Config | Weaver Reload | Spinner Reload | Motor |
|---|---|---|---|
| Base (15 W) | 55 s | 20 s | Standard reel motor |
| Upgraded (30 W) | 30 s | 10 s | High-torque upgrade |
| Rapid-fire (60 W) | 15 s | 5 s | V5 shop purchase |

### 2.4 Arm Position & Firing Lines

> **⚠️ CONFIG G:** Arm positions below (equatorial hex ring at Y=0) are superseded. Config G mounts 4 struts at **top collar (Y=+0.9m)** at azimuths **60°/120°/240°/300°** in a 3-plane layout. Each strut sweeps 0–180° in its meridian plane. See [`ARM_PIVOT_ANALYSIS.md §10.11`](ARM_PIVOT_ANALYSIS.md:1337) for Config G layout diagram.

```
TOP VIEW — V3 hexagonal arrangement (view from +Z, forward)

                    +Z (forward / prograde)
                     ↑
                     │
           W1 ───── │ ───── S1        60° spacing
          /    ╱────┼────╲    \       W = Weaver (11 kg)
         /   ╱ OCTA │GONAL╲   \      S = Spinner (3.7 kg)
   S3 ──┤  ╱  BUS   │  1.0m ╲  ├── W2
         ╲ ╲  BODY  │       ╱ ╱
          ╲  ╲──────┼──────╱ ╱
           W3 ───── │ ───── S2
                     │
                     ↓
                    -Z (aft / retrograde)
                    [Hall thrusters + antenna]

  Arm positions (angle from +X, CCW viewed from +Z):
    W1: 30°    S1: 90°   (→ starboard forward quadrant)
    W2: 150°   S2: 210°  (→ port-aft quadrant)  
    W3: 270°   S3: 330°  (→ port-forward quadrant)
```

**Firing line analysis:**

| Arm | Position | Clear Firing Arc | Obstructions | Rating |
|---|---|---|---|---|
| W1 (30°) | Starboard-fwd | 120° forward-starboard | Solar wing edge at ±60° | ★★★★ |
| S1 (90°) | Starboard | 120° broadside | Solar wing (main obstruction) | ★★★ |
| W2 (150°) | Port-aft | 120° aft-port | Hall thruster plume at aft | ★★ |
| S2 (210°) | Port-aft | 120° aft-port | Hall thruster plume at aft | ★★ |
| W3 (270°) | Port | 120° broadside | Solar wing (main obstruction) | ★★★ |
| S3 (330°) | Starboard-fwd | 120° forward-starboard | Solar wing edge at ±60° | ★★★★ |

**Key insight:** Forward-facing arms (W1, S3) have the best firing lines for prograde targets (most common engagement geometry). Aft-facing arms (W2, S2) must avoid Hall thruster plume — requires thruster interlock or tether routing (see §13).

### 2.5 Gameplay Implications

- **"Reload" creates tension**: After firing a Weaver crossbow, 55 seconds of vulnerability before it's ready again. Player must choose shots carefully.
- **Selectable launch speed**: Low power (5 m/s) for close targets = fast reload. Full power (15 m/s) for distant targets = long reload. Risk/reward trade.
- **Audio/visual**: Ratchet winding sound during reload. Spring tension indicator on HUD. Satisfying *thwack* on release.
- **Replaces** [`ARM_LAUNCH_DURATION: 0.5`](js/core/Constants.js:627) with physics-correct 0.05 s release + 0.25 s clearance.

---

## 3. Tether Attachment & Reel on Mother to Slow Arm

### 3.1 Architecture: Reel on Mothership

The tether reel lives on the mothership, not the arm. The arm carries only the tether attachment point. This is critical because:

1. Reel mass (motor + spool + electronics) stays on the mother, not the arm
2. Braking force is applied by the reel, controlled by the mother's OBC
3. The arm is as light as possible for maximum launch velocity

```
TETHER REEL SYSTEM — SCHEMATIC

MOTHERSHIP                                          ARM
┌──────────────────┐                               ┌─────────┐
│                  │          TETHER                │         │
│  ┌────────────┐  │   (pays out from reel)        │  ┌───┐  │
│  │ REEL MOTOR │──┤═══════════════════════════════├──│ATT│  │
│  │ + SPOOL    │  │                               │  │PT │  │
│  │ + CLUTCH   │  │   Brake applies progressive   │  └───┘  │
│  │ + STRAIN   │  │   tension to decelerate arm   │         │
│  │   GAUGE    │  │                               │  Net    │
│  └────────────┘  │                               │  FEEP   │
│                  │                               │  Sensors│
│  Reel mass: ~1.2kg│                              │         │
│  (per cavity)    │                               └─────────┘
└──────────────────┘
```

### 3.2 Braking Physics

After crossbow launch, the arm flies outward at launch velocity. The tether pays out freely during initial flight (free-spool mode), then the magnetic clutch progressively engages to brake the arm as it approaches the target distance.

```
Weaver at 10 m/s launch, target at 1500 m (75% of 2 km tether max):

Phase 1 — Free flight (0 → 500 m): tether unreels freely
  Duration: 500 / 10 = 50 s
  Arm velocity: 10 m/s (constant, negligible drag in vacuum)

Phase 2 — Progressive braking (500 → 1500 m): 
  Must decelerate from 10 m/s to ~0.5 m/s (approach speed)
  Braking distance: 1000 m
  
  Using v² = v₀² - 2a×d:
  (0.5)² = (10)² - 2a × 1000
  0.25 = 100 - 2000a
  a = 99.75 / 2000 = 0.0499 m/s² ≈ 50 mm/s²
  
  Braking force: F = m × a = 11.0 × 0.0499 = 0.549 N
  
  Duration of braking: t = (v₀ - v) / a = 9.5 / 0.0499 = 190.4 s ≈ 190 s

Phase 3 — FEEP fine approach (1500 → target): 
  Standard APPROACH state at 0.5 m/s under FEEP guidance
  
Total transit time: 50 + 190 = 240 s ≈ 4 minutes to 1.5 km
```

**Braking force context:** 0.55 N is **well within** the tether's 500 N breaking strength — safety factor of 909×. The reel clutch need only apply gentle friction.

**Spinner at 10 m/s, target at 400 m (80% of 500 m):**

```
Phase 1 — Free flight (0 → 100 m): 10 s
Phase 2 — Braking (100 → 400 m): 
  Decel from 10 → 0.5 m/s over 300 m
  a = 99.75 / 600 = 0.166 m/s²
  F = 3.7 × 0.166 = 0.615 N
  Duration: 9.5 / 0.166 = 57.2 s
Total: ~67 s ≈ 1.1 minutes
```

### 3.3 Y-Harness Tether Bridle on Arm

A single-point aft-center tether attachment is **fatally flawed** for a crossbow-launched arm:

1. **FEEP exhaust conflict**: The arm's FEEP thrusters fire from the aft face. A centerline tether runs directly through the ion exhaust cone (Xe⁺ at 300 eV, ±20° plume). The tether would erode within hours of cumulative thrust.
2. **Pendulum instability**: A single attachment behind the CoG creates pendulum oscillation during lateral FEEP maneuvers. The arm swings under the tether.
3. **Zero redundancy**: One attachment point failure = arm loss.

**Solution: Y-bridle harness.** The main tether splits into two bridle legs that attach on opposite sides of the arm body, well clear of all thruster exhausts.

```
Y-HARNESS TETHER BRIDLE — TOP VIEW (Weaver arm)

                     FORWARD (toward target)
                        ↑
                  ┌─────┴─────┐
                  │  NET PACK  │
                  ├────────────┤
   Port bridle    │            │   Starboard bridle
   hardpoint ●────┤   ARM      ├────● hardpoint
   (titanium)     │   BODY     │    (titanium)
                  │  200×200   │
                  │  ×300 mm   │
                  ├────────────┤
                  │  FEEP ×2   │ ← Thrusters fire AFT (clear of bridle)
                  └─────┬──────┘
                        │ (exhaust zone — NO tether here)
                        ↓
                     AFT

   Bridle legs converge 0.5m behind arm:

   ●─────PORT LEG (0.52m)─────╮
                               ◆ Y-JUNCTION (titanium swivel)
   ●────STBD LEG (0.52m)──────╯
                               │
                          Main tether to mother
                          (single ribbon, 2 km)
```

**Y-bridle geometry:**

```
Bridle calculation for FEEP exhaust clearance:

  Arm body width: 200 mm (Weaver)
  FEEP plume half-angle: 20° + vectoring 10° = 30° worst case
  
  Hardpoint offset from centerline: 100 mm (half body width)
  Bridle leg length: L_leg
  Y-junction distance behind aft face: d_junct
  
  At Y-junction, tether centerline must be OUTSIDE the 30° plume cone:
    Plume radius at d_junct: r_plume = d_junct × tan(30°) = 0.577 × d_junct
    Tether centerline at d_junct: at center (both legs converge to center)
    → Tether IS at center... but the legs are offset!
    
  The key: each bridle LEG must clear the plume where it passes the aft face.
  At the aft face plane (d=0): leg is at 100mm offset from center.
  Plume radius at d=0: 0 mm (nozzle exit).
  Plume radius at 50mm aft: 50 × tan(30°) = 29 mm.
  Leg at 50mm aft: still ~95mm from center (nearly straight).
  → CLEAR by 66 mm. ✓
  
  At Y-junction (d = 500mm aft):
    Plume radius: 500 × tan(30°) = 289 mm
    Leg convergence point: at center (0 mm offset)
    → Junction IS inside the plume cone!
    
  Solution: Set Y-junction at 400 mm, legs converge to 50mm offset
  (not full center — slight V shape maintained):
    Plume radius at 400mm: 231 mm
    Tether at 400mm: 50 mm from center
    → 50 mm < 231 mm → STILL INSIDE!
    
  REAL solution: Y-junction at 250 mm behind aft face:
    Plume radius at 250mm: 144 mm
    Each leg at 250mm: interpolated from 100mm to center
    = 100 × (1 - 250/500) = 50 mm from center
    → 50 mm < 144 mm → Inside plume.
    
  CONCLUSION: The Y-junction CANNOT be on the FEEP thrust axis.
  The tether must exit LATERALLY, not aft.
  
  REVISED DESIGN: Bridle legs exit from PORT and STARBOARD faces,
  not from the aft face. They converge below/beside the arm,
  perpendicular to the thrust axis:
  
  Leg exit angle from arm surface: 45° outward + aft
  D_junct = 350mm behind and 150mm outboard of center
  Plume at this point: 350 × tan(30°) = 202mm radius FROM THRUST AXIS
  Offset from thrust axis: 150mm outboard
  → 150mm < 202mm... still marginal!
  
  FINAL DESIGN: Legs exit laterally + forward-angled:
  Legs route along arm's lateral faces, exit at MID-BODY (not aft),
  converge 500mm aft where the plume has dissipated.
  
  At 500mm aft, plume ion density drops as 1/r² from nozzle.
  Ion flux at 500mm: ~1% of nozzle flux.
  Tether tension keeps it aligned → minimal dwell time in residual plume.
  
  With HBN-coated GSL bridle legs: ceramic-like AO/ion resistance.
  Acceptable for the brief intervals of FEEP firing.
```

**Revised Y-bridle layout for arm:**

```
ARM BODY — SIDE VIEW WITH Y-BRIDLE

       FORWARD (toward target)
          ↑
    ┌─────┴─────┐
    │  NET PACK  │ ← Miura-ori folded net
    │  or GECKO  │
    ├────────────┤
    │   SENSORS  │
    │   BATTERY  │
    ●   OBC      ● ← Bridle hardpoints (port + stbd, mid-body)
    ├────────────┤     ABOVE the FEEP thrusters
    │  FEEP ×2   │ ← Thrusters (aft face, exhaust goes DOWN)
    └────────────┘
          ↓
       AFT (exhaust zone)
    
       ●────────────╮
       (port leg     ◆ Y-junction (500mm aft, 50mm below arm CG)
       ●────────────╯   Titanium swivel + Dyneema/GSL splice
                     │
                Main tether to mother reel
```

**Y-harness specifications:**

| Parameter | Weaver | Spinner |
|---|---|---|
| Hardpoint location | Mid-body lateral, ±100mm from center | Mid-body lateral, ±50mm |
| Leg length | 520 mm each | 310 mm each |
| Leg material | Same as main tether (Dyneema / GSL + HBN) | Same |
| Junction fitting | Ti-6Al-4V swivel + crimp sleeve | Ti-6Al-4V micro swivel |
| Junction mass | 45 g | 25 g |
| Total harness mass | 80 g (including legs + fitting) | 45 g |
| FEEP clearance at junction | >50 mm from 30° plume edge | >30 mm |

**Docked configuration:** When the arm is in its docking cavity, the Y-bridle legs fold flat against the arm's lateral faces, held by small EPM clips (2 g each). The main tether feeds from the Y-junction through a guide channel in the cavity wall to the reel behind. On crossbow launch, the EPM clips release simultaneously with the main EPM dock latch — the arm exits cleanly with bridle legs streaming behind, opening under tether tension into their V-shape within the first 0.5 m of travel.

### 3.4 Catenary Sag → Dynamic Tension Profile

Current code renders the tether with [`TETHER_SEGMENTS: 24`](js/core/Constants.js:158) segments in a catenary curve. With the crossbow system, tether shape becomes **physically meaningful**:

| Phase | Tether Shape | Physics |
|---|---|---|
| Launch (0–0.5 s) | Straight, slack near mother | Arm outruns tether payout briefly |
| Free flight | Straight, slight vibration | Steady payout, near-zero tension |
| Braking | Straight, taut | Progressive tension from clutch |
| Station-keeping | Parabolic sag | Gravity gradient + vibration |
| Reel-in | Straight, taut | Motor tension |

### 3.5 Gameplay Implications

- Tether now has **visual tension indicator**: color shifts from [`TETHER_COLOR_NOMINAL`](js/core/Constants.js:155) (green) through [`TETHER_COLOR_STRESSED`](js/core/Constants.js:156) (amber) to [`TETHER_COLOR_CRITICAL`](js/core/Constants.js:157) (red) based on actual load vs breaking strength.
- Players see the tether go taut during braking — visceral feedback that physics is working.
- The 24-segment catenary now renders real sag during station-keeping, adding visual realism.
- Braking creates a gameplay choice: brake early (arm arrives slow but safe) vs brake late (faster transit but higher peak loads).

---

## 4. Reel-In for Minimum Propellant Use

### 4.1 The Propellant Problem

In V3, the HAULING state uses FEEP thrust to bring arm+debris back to the mothership. For a Weaver hauling 500 kg debris:

```
Current HAULING — FEEP return trip:
  Total mass: 11 kg arm + 500 kg debris = 511 kg
  FEEP thrust: 0.35 mN (real) × 200 (gamified) = 70 mN
  
  Even with gamified thrust:
  a = 0.070 / 511 = 0.000137 m/s² — painfully slow
  
  At real thrust (0.35 mN):
  a = 0.00035 / 511 = 6.85 × 10⁻⁷ m/s² — essentially zero

  Time to return 2 km at 0.25 m/s haul speed:
  t = 2000 / 0.25 = 8000 s ≈ 2.2 hours (game time)

  FEEP fuel consumed: ΔV = 0.5 m/s (accelerate + decelerate)
  Fuel mass = m × ΔV / (Isp × g₀) = 511 × 0.5 / (6000 × 9.81) = 0.0043 kg = 4.3 g
  As fraction of FEEP budget: 4.3g is ~3% of the Enpulsion NANO R3's 150g propellant
  Per-capture fuel cost: ~3% per haul = only 33 captures before FEEP depletion
```

This matches [`WEAVER_CAPTURES_PER_FUEL: 33`](js/core/Constants.js:126) — the math is consistent but the mechanism is fake.

### 4.2 Reel-In: Zero-Propellant Return

The tether reel motor simply winches the arm (+ captured debris) back:

```
Reel-in power calculation:
  Mass to reel: 511 kg (Weaver + 500 kg debris)
  Reel speed: 1.4 m/s (max safe loaded — see §6.3 dynamic load analysis)
  <!-- V5 AUDIT FIX: C4 — reel speed reduced from 2.0 to 1.4 m/s per §6.3 sudden-stop limit -->
  
  In microgravity, the only force needed is to accelerate the mass:
  Phase 1 — Accelerate to reel speed:
    F = m × a = 511 × 0.1 = 51.1 N (gentle 0.1 m/s² start)
    Duration: 1.4 / 0.1 = 14 s
    Distance: ½ × 0.1 × 196 = 9.8 m
  
  Phase 2 — Steady reel at 1.4 m/s:
    Force needed: ~0 N (vacuum, no friction on arm)
    Reel motor force: only spool friction + tether guide = ~2 N
    Power: F × v = 2 × 1.4 = 2.8 W
    Distance: 1980 m (remainder of 2 km)
    Duration: 1980 / 1.4 = 1414 s ≈ 23.6 min
  
  Phase 3 — Decelerate for docking:
    F = 511 × 0.1 = 51.1 N braking
    Power: 51.1 × 1.4 = 71.5 W peak (brief, ~14 s)
    Regenerative: motor acts as generator, charges battery

  Total energy: ~2.8 W × 1414 s + transients ≈ 4.0 kJ ≈ ~3 Wh
  Barely touches the core's 600 Wh battery (OCTOPUS_CORE_BATTERY)
  
  Note: Unloaded reel-in (empty arm return) may use up to 3.0 m/s
  (see §6.3: v_max = 9.5 m/s for 11 kg arm, 3.0 m/s chosen as practical limit)
```

### 4.3 FEEP Savings Comparison

<!-- V5 AUDIT FIX: C4 — comparison table updated for 1.4 m/s loaded reel speed -->
| Metric | V3 FEEP Return | V5 Reel-In Return | Savings |
|---|---|---|---|
| Propellant per capture | 4.3 g FEEP fuel | 0 g | **100%** |
| Energy per capture | 4.3 g × cost/g | ~3 Wh electrical | Regenerative on solar |
| Captures before depletion | 33 (Weaver) | ∞ (limited by net, not fuel) | **∞** |
| Time for 2 km return | 2.2 hr (133 min) | 23.8 min (at 1.4 m/s loaded) | **5.6× faster** |
| Arm fuel preserved for | Return trip (wasted) | APPROACH maneuvering | Better captures |

**Key insight:** Reel-in eliminates the biggest fuel consumer. FEEP fuel is now reserved *exclusively* for fine maneuvering during APPROACH and NETTING — exactly what ion thrusters were designed for. A Weaver's 500 m/s ΔV budget, no longer wasted on transit, could support **100+ captures** in FEEP maneuvering alone. (Still a **5.6× improvement** over FEEP return — the speed limit comes from §6.3 tether dynamic loading, not motor capability.)

### 4.4 Reel-In Speed Profile

```
REEL-IN TENSION PROFILE (loaded, 1.4 m/s — see §6.3)

Tension (N)
   51 │   ╱╲                                    ╱╲
      │  ╱  ╲                                  ╱  ╲
      │ ╱    ╲                                ╱    ╲
   20 │╱      ╲                              ╱      ╲
      │        ──────────────────────────────        ──→ dock
    2 │        Phase 2: steady reel (low tension)
    0 ┼────────┬──────────────────────────────┬──────┬──
      0       14s                            1429s  1443s  t
           Phase 1                                Phase 3
        Gentle accel                           Gentle decel
```

**Safety protocol:** If strain gauge reads >100 N during steady reel (indicating debris snagged, tether wrapping, or unexpected resistance), the reel automatically pauses and alerts the player. Options: continue reel (risk snap), release tension (let arm maneuver), or sever tether (lose arm+debris).

### 4.5 Gameplay Implications

- **Eliminates HAULING fuel consumption**: Current code probably consumes fuel during HAULING state. V5 reel-in uses *zero* arm propellant.
- **Faster capture cycles**: 8× faster return = more captures per mission = higher scores.
- **FEEP fuel now purely tactical**: Arm fuel gauge becomes a skill resource for precision maneuvering, not a tax on transit.
- **Tension minigame (optional)**: During reel-in, player could manage tension — too fast risks snap, too slow wastes time. Or automate with strain gauge feedback.
- **New ARM_STATE**: `REELING` replaces `HAULING` — mechanically distinct operation.

---

## 5. Dual-Release Stabilization

### 5.1 Newton's Third Law Problem

Firing a crossbow arm imparts momentum to the arm and equal-opposite momentum to the mothership:

```
Single Weaver launch at 10 m/s:
  p_arm = 11.0 × 10.0 = 110 kg·m/s
  p_mother = -110 kg·m/s
  
  Mother recoil: v = p/m = 110 / 216 = 0.509 m/s
  
  This is SIGNIFICANT — 0.5 m/s is comparable to RCS_MAX_SPEED (0.5 m/s)!
  The mothership lurches backward at the moment of firing.

Single Spinner at 10 m/s:
  p_arm = 3.7 × 10.0 = 37 kg·m/s
  Mother recoil: 37 / 216 = 0.171 m/s — less but still noticeable.
```

### 5.2 Dual-Fire Cancellation

Fire two arms on **opposite sides** simultaneously → net momentum = zero, net torque = zero (if co-linear).

```
6-arm opposite pairs (current hex arrangement):

  Arm 0 (W1, 30°)  ↔  Arm 3 (S2, 210°)   ← W vs S: MISMATCHED
  Arm 1 (S1, 90°)  ↔  Arm 4 (W3, 270°)   ← S vs W: MISMATCHED  
  Arm 2 (W2, 150°) ↔  Arm 5 (S3, 330°)   ← W vs S: MISMATCHED

Problem: With alternating W-S arrangement, every opposite pair 
has different mass. Momentum cancellation is IMPOSSIBLE without 
matching launch velocities.
```

### 5.3 Solutions

**Option A — Velocity Matching (Recommended):**

Adjust spring force so that each arm in a pair has equal momentum:

```
Equal momentum: m_W × v_W = m_S × v_S
  11.0 × v_W = 3.7 × v_S
  
If Weaver at 10 m/s: Spinner must fire at 10 × 11/3.7 = 29.7 m/s
  → Spinner spring energy: ½ × 3.7 × 29.7² = 1632 J — very high!
  → Spinner net may not survive 30 m/s launch shock.

If Spinner at 10 m/s: Weaver must fire at 10 × 3.7/11 = 3.36 m/s
  → Weaver too slow — 3.36 m/s for a 2 km tether takes forever.
```

Velocity matching is impractical for the extreme mass ratio (2.97:1).

**Option B — Compensating Mass (Ballast Slug):**

Eject a disposable mass slug from the opposite cavity:

```
Weaver fires at 10 m/s (p = 110 kg·m/s):
  Compensating slug: 110 / 10 = 11 kg at 10 m/s (opposite direction)
  → That's another entire Weaver! Too expensive in mass.
  
  Or: 1 kg slug at 110 m/s — feasible with a small gas cartridge
  → Slug mass budget: 6 × 1 kg = 6 kg total. Acceptable.
  → Slug is recovered by tether or left as micro-debris (bad)
```

**Option C — RCS Compensation (Simplest — Recommended for V5):**

Use cold gas RCS to absorb recoil:

```
RCS impulse needed: 110 kg·m/s (Weaver recoil)
  RCS thrust: 10 N (cold gas)
  Burn duration: 110 / 10 = 11 seconds
  
  N₂ mass consumed: p / (Isp × g₀) = 110 / (60 × 9.81) = 0.187 kg
  Core N₂ budget: 6.0 kg (OCTOPUS_CORE_COLD_GAS)
  Launches before RCS depletion: 6.0 / 0.187 = 32 launches
  
  This is very reasonable — 32 Weaver launches is more than a full mission.
```

**Option D — Sequential Same-Type Fire (Best for zero-cost cancellation):**

Rearrange arms so same-type are opposite:

```
Rearranged hex (3W + 3S):
  0°: W1    180°: W2     ← MATCHED (11 kg ↔ 11 kg)
  60°: W3   240°: S1     ← mixed
  120°: S2  300°: S3     ← MATCHED (3.7 kg ↔ 3.7 kg)

  Dual-fire: W1+W2 → perfect cancellation
  Dual-fire: S2+S3 → perfect cancellation
  W3 and S1 must fire with RCS compensation or as singles
```

### 5.4 8-Arm Configuration (Preview — see §12)

```
8-arm arrangement:
  Front (0°): Special arm (prograde)
  Back (180°): Special arm (retrograde)
  Body ring at 60° intervals: W1, S1, W2, S2, W3, S3

  Front ↔ Back: if same mass → perfect cancellation
  Body pairs: same analysis as 6-arm hex
```

### 5.5 Torque Analysis

Even with equal momentum, torque cancellation requires arms to fire along a line passing through the CoM:

```
If arms fire radially outward from the bus surface:
  Moment arm ≈ 0.5 m (bus radius)
  Torque per arm: τ = F × r × sin(angle_offset)
  
  For opposite co-linear fire: sin(180°) = 0 → zero torque ✓
  But if arms are staggered vertically (helix config §12):
  Offset creates a couple → net torque even with equal momentum
  
  Solution: fire in pairs at the SAME height on the bus
```

### 5.6 Gameplay Implications

- **Dual-fire mode**: Player holds fire button → two arms launch simultaneously. Visual: symmetric deployment, zero recoil. Cool.
- **Single-fire penalty**: Ship lurches when firing one arm. Player must stabilize with RCS. Small cold gas cost.
- **Strategic choice**: Dual-fire uses two arms but is clean. Single-fire preserves one arm but costs RCS fuel and disrupts aim.
- **Recommended default**: RCS compensation (Option C). Simple, costs minimal N₂, works for any arm combination.

---

## 6. GSL Tether Specifications

### 6.1 Graphene Superlattice — Structural Analysis

Per [V4 Opussy.md §1](V4%20Opussy.md:10), GSL at 50 GPa projected tensile strength with 1.5 g/cm³ density.

**The "<1000 atoms thick" claim:**

```
Graphene interlayer spacing: 0.335 nm
1000 layers: 1000 × 0.335 nm = 335 nm ≈ 340 nm

This is a film ~1/3 of a micrometer thick — thinner than a 
wavelength of visible light (400-700 nm). You could not SEE 
a single strand of pure GSL tether.
```

### 6.2 Breaking Force Calculation

For the V3 design load of 500 N (5× safety factor on 100 N working load):

```
Required cross-section at 50 GPa:
  A = F / σ = 500 / (50 × 10⁹) = 1.0 × 10⁻⁸ m² = 0.01 mm²
  
At 340 nm thickness:
  Width = A / t = 1.0 × 10⁻⁸ / 340 × 10⁻⁹ = 0.0294 m ≈ 30 mm
  
So: a 30 mm wide × 340 nm thick GSL ribbon holds 500 N.
```

### 6.3 Dynamic Load Analysis — Crossbow Launch

The crossbow adds **dynamic loading** that V3's gentle FEEP deployment never had:

```
Worst case: Weaver at 15 m/s, emergency braking over 200 m
  a = v² / (2d) = 225 / 400 = 0.5625 m/s²
  F_brake = 11.0 × 0.5625 = 6.19 N
  
With 500 kg captured debris, emergency brake:
  F = 511 × 0.5625 = 287.4 N — within 500 N capacity

Absolute worst case: 511 kg mass, tether snags (stops in 1 m):
  F = ½mv² / d = ½ × 511 × 0.25 / 1.0 = 63.9 N (at 0.5 m/s approach)
  F = ½ × 511 × 4.0 / 1.0 = 1022 N (at 2 m/s reel speed!)
  → Exceeds 500 N! Tether SNAPS.
  
  Solution: Reel-in must NEVER exceed speeds where a sudden stop 
  could overload the tether. At 500 N limit:
  v_max = √(2 × F × d / m) = √(2 × 500 × 1.0 / 511) = 1.40 m/s
  
  → With 500 kg payload, max safe reel speed = 1.4 m/s (not 2.0)
  → Empty arm (11 kg): v_max = √(2 × 500 / 11) = 9.5 m/s — no limit
```

### 6.4 Mass for 10 km Tether

```
GSL ribbon: 30 mm wide × 340 nm thick × 10,000 m long
  Volume = 0.030 × 340 × 10⁻⁹ × 10000 = 1.02 × 10⁻⁴ m³
  Mass = 1500 kg/m³ × 1.02 × 10⁻⁴ = 0.153 kg = 153 g

But practical tether includes additional layers (see §20 for copper-free analysis):

  V4 HYBRID (with copper — legacy):
  + Abrasion braid (HBN/Vectran): ~0.05 kg/km → 0.5 kg for 10 km
  + Copper conductors (EDT/power): ~0.2 kg/km → 2.0 kg for 10 km
  + SMA tendons (last 100m only): 0.092 kg
  Total practical 10 km: ~2.75 kg

  V5 COPPER-FREE (thickened doped GSL — see §20):
  Thicken GSL ribbon from 340 nm → 11.1 µm (still thinner than a hair)
  + HBN coating (10 nm × 2 faces): 0.013 kg for 10 km
  + SMA tendons (last 100m only): 0.092 kg
  + Optical fiber (SM, 125 µm, ~0.2 g/m): 2.0 kg for 10 km, 0.4 kg for 2 km
  <!-- V5 AUDIT FIX: G5 — optical fiber mass added to tether budget -->
  Total practical 10 km: ~5.10 kg (ribbon) + 0.092 + 2.0 kg (fiber) = ~7.19 kg
  Total practical 2 km:  ~1.02 kg (ribbon) + 0.092 + 0.4 kg (fiber) = ~1.51 kg
  BUT: 16,650 N strength (33×) + carries EDT + power + data + laser relay. No copper.

Pure GSL structural strand (340 nm): 153 g (5.6% of V4 hybrid)
```

### 6.5 Reel Diameter

```
10 km of GSL ribbon (30 mm × 340 nm) on a spool:

  Core radius: r₀ = 25 mm (reasonable minimum for bend radius)
  
  Tape volume: 1.02 × 10⁻⁴ m³
  Wound cross-section = π(r_outer² - r₀²)  (annular ring)
  
  But tape is 30 mm wide, so spool width = 30 mm:
  Volume = π(r_outer² - r₀²) × 0.030
  1.02 × 10⁻⁴ = π(r_outer² - 6.25 × 10⁻⁴) × 0.030
  r_outer² - 6.25 × 10⁻⁴ = 1.02 × 10⁻⁴ / (π × 0.030) = 1.082 × 10⁻³
  r_outer² = 1.082 × 10⁻³ + 6.25 × 10⁻⁴ = 1.707 × 10⁻³
  r_outer = 0.0413 m = 41.3 mm

  Spool dimensions: 83 mm diameter × 30 mm wide
  That's smaller than a hockey puck! For 10 km of tether!
```

```
GSL TETHER SPOOL — CROSS SECTION

        ┌── 83 mm ──┐
        │            │
    ┌───┤ ╔════════╗ ├───┐
    │   │ ║  GSL   ║ │   │ 30 mm
    │   │ ║ 10 km  ║ │   │ wide
    └───┤ ╚════════╝ ├───┘
        │  ┌──50──┐  │
        │  │ CORE │  │
        │  └──────┘  │
        └────────────┘
        
  vs. V3 Dyneema spool for 2 km:
  ~150 mm diameter × 40 mm wide
```

**However:** the V4 hybrid tether includes copper conductors and abrasion braid, which dominate spool volume (practical 10 km hybrid spool: ~120 mm diameter × 40 mm wide). The V5 copper-free variant (§20) eliminates these — the 11.1 µm thick GSL spool for 10 km is ~90 mm diameter × 30 mm wide, even more compact.

### 6.6 HBN (Hexagonal Boron Nitride) Coating — Essential for GSL

GSL tethers in LEO **require** a white HBN (hexagonal boron nitride) coating. Without it, the tether is vulnerable to atomic oxygen erosion, electrostatic charging, and plasma arcing.

```
GSL TETHER CROSS-SECTION (with HBN coating)

    ┌─ HBN coating (10 nm) ── white, insulating
    │  ┌─ GSL structural layer (340 nm) ── black, conductive
    │  │  └─ HBN coating (10 nm) ── white, insulating
    │  │
    ▼  ▼
  ┌────────────────────────────────────┐
  │ HBN │████████ GSL ████████│ HBN   │  Total: 360 nm
  └────────────────────────────────────┘
         30 mm wide ribbon
```

**HBN properties:**

| Property | Value | Why it matters |
|---|---|---|
| Crystal structure | Hexagonal layered (like graphene) | Bonds well to GSL surface |
| Band gap | ~6 eV | Excellent electrical insulator |
| AO erosion rate | Near zero (forms stable B₂O₃ passivation) | Protects GSL from atomic oxygen |
| UV stability | Transparent, no degradation | Survives LEO UV flux indefinitely |
| Thermal stability | >900°C in vacuum | Exceeds any LEO thermal extreme |
| Density | 2,100 kg/m³ | Close to GSL density |
| Nickname | "White graphene" | Same structure, opposite electrical properties |

**Mass addition for HBN (10 km tether):**
```
Volume: 2 × 10e-9 m × 0.030 m × 10000 m = 6.0 × 10⁻⁴ m³
Mass: 2100 × 6.0 × 10⁻⁴ = 1.26 kg...

Wait — that's significant! Let me recalculate:
  → 2 faces × 10 nm × 30 mm × 10 km
  = 2 × 10⁻⁸ m × 0.03 m × 10000 m
  = 6.0 × 10⁻⁶ m³
  = 6.0 cm³
  Mass = 2100 × 6.0 × 10⁻⁶ = 0.0126 kg = 12.6 g

Negligible (0.005% of practical tether mass). ✓
```

HBN coating is applied via chemical vapor deposition (CVD) directly onto the GSL ribbon during manufacturing. The entire GSL tether (structural ribbon + HBN insulation) is manufactured as a single laminate. 🔶 TRL 2–3 (laboratory process demonstrated for small areas; no km-scale production yet).

**Without HBN:** bare GSL in LEO would accumulate surface charge from ionospheric plasma (electron density ~10⁵–10⁶ /cm³), causing arcing. In the V5 copper-free design (§20), HBN insulation is even more critical: it defines the controlled current path through the thickened GSL ribbon. EDT current flows through the GSL body, and HBN prevents the ionospheric plasma from shorting the circuit. A 1 m bare (HBN-stripped) section at the arm end serves as the EDT anode for electron collection.

### 6.7 Gameplay Implications

- GSL tethers are **V4/V5 shop upgrade** — player starts with Dyneema (TRL 9), unlocks GSL
- 10 km tether on a hockey-puck spool is visually striking — show in loadout screen
- GSL tether is nearly invisible at game distances — use visual enhancement (glow shader) for gameplay clarity
- Tether mass savings → arm carries less → higher launch velocity at same spring force

---

## 7. Tether Material Upgrade Path

### 7.1 Complete Upgrade Table

| Material | TRL | σ (GPa) | ρ (g/cm³) | Width for 500N (at 340nm thick) | Mass/10km (structural only) | Spool Ø | Breaking Length (km) | 
|---|---|---|---|---|---|---|---|
| **Spectra (UHMWPE)** | 9 | 3.5 | 0.97 | N/A — use 3mm × 0.1mm ribbon | 0.97 kg/km × 10 = 9.7 kg | 200 mm | 368 |
| **Kevlar 49 (Aramid)** | 9 | 3.6 | 1.44 | N/A — use 3mm × 0.1mm ribbon | 1.44 kg/km × 10 = 14.4 kg | 210 mm | 255 |
| **Dyneema SK78** | 9 | 3.6 | 0.97 | N/A — ribbon form | 1.2 kg/km × 10 = 12.0 kg | 200 mm | 378 |
| **Zylon (PBO)** | 7 | 5.8 | 1.56 | N/A — ribbon form | 0.86 kg/km × 10 = 8.6 kg | 180 mm | 379 |
| **CNT Yarn** | 4–5 | 3.0 (actual) | 1.3 | N/A — yarn bundle | 0.65 kg/km × 10 = 6.5 kg | 160 mm | 235 |
| **GSL (50 GPa)** | 2–3 | 50 | 1.5 | 29.4 mm | 0.015 kg/km × 10 = 0.15 kg | 83 mm | 3,400 |
| **GSL (100 GPa)** | 2 | 100 | 1.5 | 14.7 mm | 0.0075 kg/km × 10 = 0.075 kg | 70 mm | 6,800 |

*Breaking length = σ / (ρ × g), the theoretical length a material can support its own weight in 1g.*

### 7.2 Practical Tether Mass — V4 Hybrid (With Copper) vs V5 Copper-Free

**V3/V4 Legacy — copper conductors required (Dyneema/Zylon/CNT are non-conductive):**

| Material | Structural (10 km) | + Cu conductors | + Braid | + SMA | **Total** | Max Reach |
|---|---|---|---|---|---|---|
| Dyneema SK78 | 1.35 kg | +2.0 kg | +0.5 kg | +0.092 kg | **3.94 kg** | 2 km (V3 budget) |
| Zylon PBO | 0.86 kg | +2.0 kg | +0.5 kg | +0.092 kg | **3.45 kg** | 2.3 km |
| CNT Yarn | 0.65 kg | +2.0 kg | +0.4 kg | +0.092 kg | **3.14 kg** | 2.5 km |

**V5 Copper-Free — thickened doped GSL carries all electrical functions (see §20):**

| GSL Variant | Ribbon (10 km) | Cu | Braid | SMA | **Total** | Breaking Force | Max Reach |
|---|---|---|---|---|---|---|---|
| GSL 50 GPa, σ=2×10⁶ (doped) | 5.00 kg | **0** | HBN only 0.013 kg | +0.092 kg | **5.11 kg** | 16,650 N (33×) | 12.5 km |
| GSL 50 GPa, σ=5×10⁶ (N+I doped) | 2.00 kg | **0** | 0.013 kg | +0.092 kg | **2.11 kg** | 6,650 N (13×) | 12.5 km |
| GSL 50 GPa, σ=1×10⁷ (target) | 1.00 kg | **0** | 0.013 kg | +0.092 kg | **1.11 kg** | 3,350 N (6.7×) | 25 km |
| GSL 100 GPa, σ=1×10⁷ | 0.50 kg | **0** | 0.013 kg | +0.092 kg | **0.61 kg** | 3,350 N (6.7×) | 25 km (V5 endgame) |

**Key insight:** At σ ≥ 5×10⁶ S/m, copper-free GSL is **lighter** than ANY copper-hybrid tether while carrying all 7 functions. The "penalty" for using GSL as conductor disappears as doping improves — and you get 13× structural safety factor for free.

### 7.3 Gameplay Unlock Progression

| Tier | Material | Unlock Cost | Mission Req | Tether Length | Gameplay Effect |
|---|---|---|---|---|---|
| **1 (Start)** | Dyneema SK78 | Free | — | 2 km / 500 m | Baseline V3 performance |
| **2** | Zylon PBO | 500 credits | 5 captures | 2.3 km / 575 m | +15% reach, UV vulnerable (degrades in sunlight) |
| **3** | CNT Yarn | 2,000 credits | 20 captures | 2.5 km / 625 m | +25% reach, fragile (reduced snap tolerance) |
| **4** | GSL 50 GPa | 8,000 credits | 50 captures + research | 12.5 km / 3.5 km | 6× reach, enables synthetic aperture |
| **5** | GSL 100 GPa | 25,000 credits | 100 captures + rare salvage | 25 km / 7 km | 12× reach, extreme range ops |

### 7.4 Gameplay Implications

- Each tier unlocks new capture strategies: longer tethers → wider engagement envelopes
- Zylon degrades in UV = risk/reward (must keep arm in shadow or accept degradation)
- GSL unlocks "jellyfish scan" (§9) which is a game-changing ability
- Material choice visible on tether color: white (Dyneema) → gold (Kevlar) → orange (Zylon) → black (CNT) → iridescent (GSL)

---

## 8. Aimable Crossbows vs Aimable Mother

> **⚠️ CONFIG G:** Section superseded for arm geometry. Config G uses 0–180° meridian sweep via `setAimAlpha(alpha)`, not ±30° yaw. Off-plane targeting uses **semi-auto Mother rotation**: player presses Fire → `AutopilotSystem.requestAimRotation(targetDir)` rotates Mother → crossbow fires when aligned (3–7 s). See [`ARM_PIVOT_ANALYSIS.md §10.2`](ARM_PIVOT_ANALYSIS.md:817) for sweep geometry and [`ARM_PIVOT_GAPS_EXPLAINER.md §W ST-9.3`](ARM_PIVOT_GAPS_EXPLAINER.md) for implementation spec.

### 8.1 Three Options

```
OPTION A: AIMABLE CROSSBOW (gimbal mount)

                 ╱ 30° arc
    ┌───────────╱─────────┐
    │  ┌─────╱──┐         │
    │  │ARM ╱   │ GIMBAL  │
    │  │   ╱    │ ±30°    │    Adds ~0.8 kg per cavity
    │  └──╱─────┘ 2-axis  │    (gimbal ring + actuator)
    │   ╱               │
    └──╱──────────────────┘

OPTION B: AIM MOTHER (RCS rotation)

    Mother rotates →  ╲
    to point arm at    ╲  target
    target              ╲

    RCS fuel cost per aim:
    Rotate 30°: ω = 0.3 rad/s (SATELLITE_ROTATION_RATE)
    θ = 30° = 0.524 rad
    Time to rotate: 0.524 / 0.3 = 1.75 s
    But must also STOP rotation: total ~3.5 s
    
    Angular momentum: I × ω
    I_mother ≈ ½mr² = ½ × 216 × 0.5² = 27 kg·m²
    L = 27 × 0.3 = 8.1 kg·m²/s
    RCS torque: 10 N × 0.5 m = 5 N·m
    Impulse for start+stop: 2 × 8.1 / 5 = 3.24 N·s
    N₂ consumed: 3.24 / (60 × 9.81) = 0.0055 kg = 5.5 g per aim
    
    6 kg N₂ budget → ~1090 aim maneuvers — plenty!

OPTION C: HYBRID (recommended)
    
    Spinners: small gimbal (±30°) — low mass penalty (0.3 kg)
    Weavers: fixed — mother aims via RCS rotation
```

### 8.2 Detailed Comparison

| Factor | A: Aimable Crossbow | B: Aim Mother | C: Hybrid |
|---|---|---|---|
| Mass penalty | +4.8 kg (6×0.8 kg) | 0 kg | +0.9 kg (3 Spinners) |
| Aiming speed | Instant (servo) | 1.75 s per 30° | Mixed |
| Fuel cost | 0 (electric) | 5.5 g N₂ per aim | ~2 g average |
| Solar panel disruption | None | Breaks optimal sun-pointing | Only for Weaver aims |
| Mechanical complexity | High (6 gimbals in vacuum) | Low (existing RCS) | Moderate |
| Failure mode | Gimbal jam = arm stuck | RCS failure = no aiming | Graceful degradation |
| Simultaneous engagement | Each arm aims independently | One direction at a time | Spinners independent, Weavers serial |

### 8.3 Recommendation: Option C (Hybrid)

> **Rev 5 footnote (2026-04-26):** The strut articulation (daughter-to-bus mount) has been reduced from **2-DOF (pitch + yaw) to 1-DOF (yaw only)**, rotating in the dock-tangent plane. This supersedes the 2-axis gimbal described in Rev 1 Option A/C above. The 1-DOF strut provides ±30° yaw in-plane; off-axis target acquisition is handled by whole-platform attitude rotation (existing FEEP/RCS). Pitch axis dropped for vacuum reliability — halves actuator count across the platform. API: `ArmUnit.setAimYaw(yaw)` replaces `setAimYawPitch(yaw, pitch)`. Constants: `CROSSBOW_AIM_CONE_PITCH_MAX` → DROPPED. See [`CAPTURE_NET.md`](CAPTURE_NET.md) §4 tangle analysis for the reliability rationale.

**Spinners get 1-DOF yaw strut because:**
- They're small (2.1 kg V5) → low mass penalty (single actuator)
- They fire frequently at small, close debris — quick yaw aiming matters
- They're the "fast reaction" arms; mother shouldn't rotate for every fragment

**Weavers get 1-DOF yaw strut (same mechanism) because:**
- 1-DOF is simple enough to justify on all daughters (not just Spinners)
- All daughters share the same strut mechanism — commonality reduces spare parts
- Fewer Weaver shots per mission (large targets are rare) — yaw-only is sufficient
- Fixed mount was Rev 1 recommendation; Rev 2 gives all daughters 1-DOF yaw for consistency

### 8.4 Solar Panel Consideration

```
SOLAR PANEL ORIENTATION IMPACT

    SUN →  →  →  →  →  → 
               ↓
    ┌──────────┐ ← Solar wing (face toward sun)
    │ OCTOPUS  │
    │  BUS     │
    └──────────┘
    ┌──────────┐ ← Solar wing (face toward sun)

If mother rotates 90° to aim a Weaver:
  - Solar wings now EDGE-ON to sun → power drops to ~0
  - Core battery: 600 Wh, solar gen: 1900 W peak
  - At 90° off-sun: cos(90°) × 1900 = 0 W
  - Time before battery critical: 600 / 200 (laser) = 3 hours
  
  In practice: mother rotates, fires, rotates BACK to sun-pointing.
  Total off-sun time: ~7 seconds (rotate + fire + rotate back)
  Energy lost: 1900 × 7 = 13.3 kJ = 3.7 Wh — trivial.
```

### 8.5 Gameplay Implications

- **Spinners auto-aim**: Like turrets, Spinners track nearby small debris and fire automatically. Quick, satisfying pop-pop-pop.
- **Weavers require mother aiming**: Player must orient mothership toward large targets before firing. Creates "lining up the shot" tension — more like actual crossbow aiming.
- **Visual**: Spinner gimbals visibly swivel. Weaver cavities are fixed — mothership rotates to aim.
- **Replaces**: The concept of the mother always needing to be pointed at the target (aim) now has mechanical reality.

---

## 9. Synthetic Aperture Scanning — Simultaneous Fire

### 9.1 Concept: Jellyfish Pulse

All 6 (or 8) arms fire simultaneously, expanding outward on tethers. Each arm carries sensors (LIDAR, optical). As arms separate, they form a distributed sensor array with an effective aperture equal to twice the tether length.

```
JELLYFISH PULSE — TOP VIEW

       t=0 (all docked)           t=60s (expanded)           t=180s (contracted)
       
            ●                    S1                               ●
           ╱│╲                  ╱                                ╱│╲
          W S W              W1    W2                           W S W
          │●│              ╱    ● ╱                             │●│
          S W S          S3  ●╱   S2                            S W S
           ╲│╱            ╲  ╱                                   ╲│╱
            ●              W3                                     ●
                         
       Compact            5 km diameter                      Compact again
                          sensor array
```

### 9.2 Resolution Calculation

```
Angular resolution: θ = 1.22 × λ / D

At 808 nm (mother's laser wavelength) with various apertures:

| Aperture D | θ (rad) | θ (arcsec) | Spot at 100 km | Spot at 1000 km |
|---|---|---|---|---|
| 0.2 m (core optic) | 4.9 × 10⁻⁶ | 1.01" | 0.49 m | 4.9 m |
| 1 km (Spinner tether) | 9.8 × 10⁻¹⁰ | 0.0002" | 0.098 µm | 0.98 µm |
| 4 km (2× Weaver tether) | 2.5 × 10⁻¹⁰ | 0.00005" | 0.025 µm | 0.25 µm |
| 25 km (2× V5 GSL tether) | 3.95 × 10⁻¹¹ | 8 × 10⁻⁶" | 0.004 µm | 0.04 µm |

At 25 km aperture: theoretical resolution at 100 km = 4 PICOMETERS.
This is smaller than an atom. Obviously impractical.
```

### 9.3 Practical Limits

The theoretical resolution is absurd because:

1. **Phase coherence**: Arms must maintain position known to < λ/10 = 80 nm. Tether vibration is mm-scale. **Gap: 10,000×**
2. **Timing synchronization**: Light travel across 25 km aperture = 83 µs. Clock sync must be sub-ns across all arms. Achievable with optical ToF (TDC7200 at 55 ps ✅) but challenging.
3. **Tether vibration**: Fundamental mode of a 12.5 km tether under 1 N tension: f = (1/2L)√(T/µ) ≈ 0.001 Hz. Amplitude: cm to m scale.
4. **Atmosphere equivalent**: Even in vacuum, the effective resolution is limited by detector noise, not diffraction.

**Realistic useful resolution:** Treat this as **baseline interferometry**, not filled-aperture imaging. Useful for:
- **Target detection**: Identify reflecting objects by correlated returns across multiple baselines
- **Target sizing**: Resolve whether an object is 0.1 m or 10 m diameter at 100 km range
- **Doppler mapping**: Measure target rotation rate via differential Doppler across the array

### 9.4 Operational Concept

```
"PULSE SCAN" SEQUENCE:

1. All arms fire simultaneously (dual-release pairs, §5)
   Duration: 0.05 s (spring release)
   
2. Arms expand on tethers, sensors active
   Each arm carries: 808nm photodiode + LIDAR ranging
   Mother laser illuminates target volume
   Arms record reflected returns with timestamps
   
3. Peak expansion reached (1–12.5 km per arm)
   Dwell time: 10–30 seconds at full extension
   Tether brake holds position
   Mother slowly rotates → arms sweep an arc
   
4. Reel-in: all arms retract simultaneously
   Duration: matching §4 profile
   
5. Data processing: mother correlates all arm returns
   Interferometric processing reveals target positions and sizes
   
Total cycle: ~5–10 minutes
Power cost: ~50 Wh (laser + reel motors)
Tether wear: 1 cycle = 0.1% lifetime (fatigue from tension cycling)
```

### 9.5 Mother Rotation During Expansion

Would centripetal force maintain tether tension? Yes:

```
Mother rotating at ω = 0.3 rad/s (SATELLITE_ROTATION_RATE)
Arm at r = 2 km = 2000 m from center:

  Centripetal acceleration: a_c = ω²r = 0.09 × 2000 = 180 m/s²
  Centripetal force on Weaver: F = 11.0 × 180 = 1,980 N
  
  → EXCEEDS tether strength (500 N)!
  
At safe tension (500 N): ω_max = √(F/(m×r)) = √(500/(11×2000)) = 0.151 rad/s
  → ~8.6°/s rotation. Doable but must reduce rotation rate during scan.
  
At 500 m Spinner range: ω_max = √(500/(3.7×500)) = 0.52 rad/s — faster OK.
```

**Conclusion:** Scan with reduced rotation rate (~5°/s for Weavers at 2 km, faster for shorter tethers). This provides mechanical tension on tethers AND angular sweep for the sensor array.

### 9.6 Gameplay Implications

- **"Pulse Scan" ability**: Costs power + tether durability. Reveals all debris in a massive volume (up to 25 km radius with GSL).
- **Dramatic visual**: 6 or 8 arms shooting outward simultaneously, tethers stretching, then reeling back. The jellyfish metaphor.
- **Strategic use**: At start of mission, pulse scan to map the debris field. Plan captures efficiently.
- **Upgrade path**: Longer tethers (§7) → wider scans → better field awareness.
- **Audio**: Deep thrumming "whomp" on launch, tether singing during expansion, satisfying reel-in whirr.
- **New constant**: `PULSE_SCAN_COOLDOWN: 300` (5 minutes between scans, matching tether fatigue budget).

---

## 10. Forward Target — Fire Ahead, Reel for Momentum Transfer

### 10.1 Concept: Tether-Assisted Rendezvous

A target ahead in orbit (higher energy) is moving slower relative to the local horizontal. Fire an arm **prograde + slightly radially outward**, attach to target via net, then reel in. The tether transmits force — pulling the target down and the mother up — equalizing their velocities.

```
FORWARD CAPTURE MANEUVER

                      PROGRADE →
   
 Mother ●════════════════════● Target (ahead, slightly higher)
  170 kg    tether 2 km      100 kg debris
  
  Reel-in force pulls:
    Mother FORWARD (+ΔV prograde)
    Target BACKWARD (-ΔV relative)
    They meet at center of mass.
```

### 10.2 Momentum Transfer Analysis

```
System: Mother (M = 216 kg wet) + Target (m_t = 100 kg)
Connected by inextensible tether after capture.

Initial conditions (in mother's LVLH frame):
  Mother velocity: 0 m/s (reference frame)
  Target velocity: Δv (relative approach velocity)
  Typical Δv at 2 km separation in LEO: ~1-5 m/s

After reel-in (conservation of momentum):
  (M + m_t) × v_final = M × 0 + m_t × Δv
  v_final = m_t × Δv / (M + m_t) = 100 × Δv / 316 = 0.316 × Δv

If target is approaching at Δv = 3 m/s:
  v_final = 0.316 × 3 = 0.949 m/s
  
  Mother gains: 0.949 m/s prograde
  Target loses: 3.0 - 0.949 = 2.051 m/s (decelerates in mother's frame)

  Mother's orbit changes:
  ΔV = 0.949 m/s prograde
  At 400 km altitude (v_circ = 7672 m/s):
  New apogee ≈ 400 + 2 × (400+6371) × ΔV/v_circ = 400 + 2 × 6771 × 0.949/7672
  Δa ≈ 2 × 6771 × 0.000124 = 1.68 km
  → Apogee rises ~1.7 km. Small but FREE — no propellant spent!
```

### 10.3 Vis-Viva Implications

```
Vis-viva: v² = GM × (2/r - 1/a)

Before capture: mother at a₁ = 6771 km (400 km altitude circular)
  v₁ = √(398600.4 × (2/6771 - 1/6771)) = 7672 m/s

After +0.949 m/s prograde:
  v₂ = 7672.949 m/s
  New semi-major axis:
  1/a₂ = 2/r - v₂²/GM = 2/6771 - 7672.949²/398600.4 = 2.954×10⁻⁴ - 1.477×10⁻¹
  a₂ ≈ 6771.84 km
  
  New eccentricity: e = 1 - r_p/a = negligible for this small ΔV
  
Net effect: orbit raised by ~0.84 km in semi-major axis.
Equivalent Hall thruster burn time: 
  ΔV = 0.949 m/s
  m_prop = M × ΔV / (Isp × g₀) = 216 × 0.949 / (1500 × 9.81) = 0.0139 kg = 13.9 g Xenon saved
```

### 10.4 Practical Limitations

1. **Arm must reach target**: At 2 km range, target approach geometry must be within crossbow range + tether length.
2. **Arm must survive impact**: Net must capture at relative velocity. At 3 m/s, a 5×5 m net can absorb this (RemoveDEBRIS demonstrated capture at 7 m/s relative ✅).
3. **Tether dynamic load**: 511 kg × 3 m/s momentum change over ~100 m of tether stretch = peak force of 511 × 0.045 = 23 N (well within 500 N limit).
4. **Orbit change is small**: This is "free ΔV" but tiny. Value is primarily in closing relative range, not orbit modification.

### 10.5 Gameplay Implications

- **"Lasso Forward"** maneuver: Fire arm prograde, snag target, reel in. Mother gets free ΔV. Efficient cowboy gameplay.
- **Momentum display**: Show velocity change on HUD when reeling in — player sees their orbit change for free.
- **Skill ceiling**: Timing the crossbow shot to intercept a target at 2 km while both are in orbital motion is genuinely hard. Rewarding when successful.
- **Bonus score**: "Tether Slingshot" bonus for captures that also provide useful ΔV to the mother.

---

## 11. Rear Target — Fire Past, Ablation Propulsion

### 11.1 Concept: Retrograde Lasso + Laser Nudge

Target behind the mother (lower orbit, catching up). Fire arm **past** the target (retrograde overshoot), then use the mother's 808 nm laser — **relayed through the tether's optical fiber** — to perform ablation propulsion on the target surface.

```
REAR ENGAGEMENT — ABLATION PROPULSION

  ← RETROGRADE
  
  ●═══════X═════════●
  Mother    Target    Arm (overshot)
            ↑
            │ Laser via tether fiber
            │ ablates surface
            │ → creates tiny thrust
            │    pushing target 
            │    toward mother
            ↓
        Target moves →
        (prograde, toward mother)
```

### 11.2 Ablation Propulsion Physics

```
808 nm laser ablation on aluminum (most common debris surface):

  Laser power via fiber: ~10 W (limited by fiber in tether)
  Ablation coupling coefficient (C_m): ~10 dyne/W = 10⁻⁴ N/W
  (NASA reference: Phipps et al. 2010, laser ablation propulsion)
  
  Thrust generated: F = C_m × P = 10⁻⁴ × 10 = 1.0 × 10⁻³ N = 1 mN
  
  On 100 kg target:
  a = F/m = 10⁻³ / 100 = 10⁻⁵ m/s² = 10 µm/s²
  
  Time to change velocity by 1 m/s:
  t = Δv/a = 1 / 10⁻⁵ = 100,000 s ≈ 27.8 hours
  
  → Ablation with 10 W is too slow for gameplay.
```

### 11.3 Making It Work: Focused Approach

**Option 1 — Relay higher power through tether:**
```
If optical fiber in tether carries 50 W (feasible with hollow-core fiber):
  F = 10⁻⁴ × 50 = 5 mN
  On 100 kg: a = 50 µm/s², Δv = 1 m/s in 5.6 hours
  → Still slow for gameplay, but plausible for "slow cook" mechanic
```

<!-- V5 AUDIT FIX: C3 — Option 2 is now primary recommendation for base V5.
     Option 3 relabeled as TRL 2-3 speculative upgrade path ("Coherent Amplifier Module").
     Unlike the gamified thrust multiplier this replaces, the power relay has a clear
     engineering upgrade path from demonstrated 10 W fiber laser heritage to projected
     50-200 W coherent amplification. -->

**Option 2 — Arm-mounted 10 W diode laser (recommended for base V5):**
```
10 W diode laser (mass: ~300g incl. optics + heatsink, TRL 9 — fiber-coupled industrial):
  Thrust: F = C_m × P = 10⁻⁴ × 10 = 1 mN
  Useful for de-spin:
  
  De-spin a 100 kg object tumbling at 10°/s:
  I ≈ mr² = 100 × 0.5² = 25 kg·m²
  ω = 10°/s = 0.175 rad/s
  L = 25 × 0.175 = 4.375 kg·m²/s
  τ = F × r = 0.001 × 0.5 = 0.0005 N·m
  Time: L/τ = 4.375/0.0005 = 8750 s ≈ 2.4 hours
  → Slow but proven. Front/Back arms carry this as standard equipment (0.3 kg each).
  → 10 W fiber laser heritage: IPG Photonics, Lumentum — TRL 9.
```

**Option 3 — Coherent Amplifier Module (TRL 2-3 speculative upgrade path):**
```
"Coherent Amplifier Module" — shop upgrade, replaces base 10 W laser:
  Uses coherent fiber amplification through tether optical fiber.
  Effective power at target: 50-200 W (amplified relay from mother laser)
  At 200 W: F = 10⁻⁴ × 200 = 20 mN
  On 100 kg: a = 200 µm/s², Δv = 0.1 m/s in 500 s ≈ 8 min
  → Gameplay-viable at higher tiers. Player fires past target, holds laser
    for ~8 min, nudges target to capture range.
  
  Upgrade tiers:  T4 base = 10 W (arm diode)
                  T4+ shop = 50 W (fiber relay)
                  T5 research = 200 W (coherent amplification)
```

### 11.4 De-Spin via Tangential Ablation

```
ABLATION DE-SPIN — The arm fires laser tangent to target rotation

         ╭───╮  Target (tumbling)
        ╱     ╲  ω = 10°/s
       │       │
       │   ●   │ ← ablation point (tangent)
        ╲     ╱
         ╰───╯
              ↑
          laser beam from arm
    
    Ablation at tangent creates torque opposing rotation.
    20 mN at 0.5 m radius = 10 mN·m torque
    De-spin from 10°/s: ~7 minutes
    De-spin from 60°/s: ~42 minutes (upper stage)
```

### 11.5 Gameplay Implications

- **"Retrograde Lasso"** maneuver: Fire past target, activate laser ablation, slowly nudge target within capture range. The "slow cook" approach — patient cowboy gameplay.
- **De-spin ability**: Arm can de-tumble dangerous targets before net deployment. Reduces capture failure rate for fast tumblers.
- **Upgrade path**: Base laser (10 W arm diode, TRL 9) → focused relay (50 W, TRL 4-5) → coherent amplification (200 W, TRL 2-3). Each tier makes ablation propulsion more practical. Unlike the gamified thrust multiplier this replaces, every tier has a clear engineering basis.
- **Risk**: Arm is exposed beyond the target — vulnerable to collision with other debris. Timer pressure.
- **New ARM_STATE**: `ABLATING` — arm holds position beyond target, laser active, target slowly approaching.

---

## 12. 8-Arm Configuration & Arrangement

> **⚠️ CONFIG G:** Arm positions completely changed. Config G uses **top-collar mount at Y=+0.9m** with 3-plane layout: arms at 60°/120°/240°/300° azimuths (Y0 Quad). No equatorial body-ring. No front/back arms at Y0 (F/B are Y3 Octo only). See [`ARM_PIVOT_ANALYSIS.md §10.11`](ARM_PIVOT_ANALYSIS.md:1236) for locked geometry and [`§10.14`](ARM_PIVOT_ANALYSIS.md:1496) for stowage geometry. Mass tables below superseded by Config G values: Y0 dry=196.4 kg, wet=242.4 kg.

### 12.1 Proposed Layout: 1 Forward + 1 Back + 6 Body

```
SIDE VIEW — 8-ARM V5 CONFIGURATION

                      +Z (prograde)
                        ↑
                 ┌──────┤──────┐
     FRONT ARM → │ ◄──F─┤      │ ← Laser aperture (starboard of front arm)
                 │      │      │
            S3 ──┤      │      ├── W1
                 │      │      │
            W3 ──┤   OCTAGONAL ├── S1
                 │      │      │
            S2 ──┤    BUS      ├── W2
                 │      │      │
      BACK ARM → │ ◄──B─┤      │ ← Hall thrusters (flanking back arm)
                 └──────┤──────┘
                        ↓
                      -Z (retrograde)
                   [2× HT-100 + antenna]


TOP VIEW — Looking down +Y axis

                   +Z (prograde)
                       ↑
                       F  ← Front arm (0°)
                      ╱╲
                W1  ╱    ╲  S1
                  ╱  BUS   ╲
            W3 ──     ●     ── W2
                  ╲        ╱
                S3  ╲    ╱  S2
                      ╲╱
                       B  ← Back arm (180°)
                       ↓
                    -Z (retrograde)
```

### 12.2 Body Ring: Three Geometry Options

**Option A — Current Hex (60° intervals at mid-section):**

```
TOP VIEW

         W1 (30°)
        ╱    ╲
  W3 (270°)   S1 (90°)
       │  ○  │
  S2 (210°)   W2 (150°)
        ╲    ╱
         S3 (330°)

✓ Symmetric, balanced mass distribution
✓ Simple structural design  
✗ All arms at same height → limited vertical coverage
✗ All fire radially outward → no forward/aft capability (that's F/B arms' job)
```

**Option B — Helix (arms spiral around bus at different heights):**

```
SIDE VIEW (unwrapped cylinder)

  Height  │ W1        S1
   +0.4m  │  ╲        ╱
          │   ╲      ╱
   +0.2m  │    W3  W2
          │   ╱      ╲
    0.0m  │  ╱        ╲
   -0.2m  │ S3        S2
          └──────────────── angle (°)
           0   60  120  180  240  300  360

✓ Different heights → better vertical firing angles
✓ Avoids tether-tether interference  
✗ Asymmetric loading on bus
✗ Complicates dual-fire cancellation (torque couples)
```

**Option C — Flower (all arms at forward end, opening as petals):**

```
FRONT VIEW (looking aft, from +Z)

           W1
          ╱  ╲
    S3 ──╱    ╲── S1
         │ ○F │        F = front arm (center)
    W3 ──╲    ╱── W2
          ╲  ╱
           S2

✓ All arms fire into forward hemisphere — ideal for prograde intercepts
✓ Maximizes tether routing away from aft Hall thrusters
✗ All mass on one end → CoM shift forward → attitude implications
✗ Forward arm (F) surrounded by 6 others — crowded
✗ Solar panels on sides are now aft — permanent shadow on panels during sun-pointing
```

### 12.3 Recommended: Option A (Hex) + Dedicated F/B

The hex body ring is proven (V3 baseline) and structurally simplest. The dedicated forward/back arms handle the prograde/retrograde specialization that hex arms can't.

**Front arm specification:**
- Type: Spinner-class (3.7 kg) — lightweight, fast reaction
- Equipment: Standard net (1.5 m) + gecko pad + small laser relay (10 W)
- Crossbow: fires along +Z axis (prograde)
- Use case: Forward Target maneuver (§10), quick prograde intercepts
- Tether routing: along +Z face, well clear of side-mounted solar panels

**Back arm specification:**
- Type: Spinner-class (3.7 kg) — same as front for dual-fire cancellation
- Equipment: Standard net + laser (ablation) + enhanced sensors
- Crossbow: fires along -Z axis (retrograde)
- Use case: Rear Target maneuver (§11), ablation de-spin
- Tether routing: CRITICAL — must avoid Hall thruster plume (§13)
- Design: offset from center by ≥0.15 m to clear thruster exhaust cone

### 12.4 Front/Back Arm — Thruster Axis Clearance

```
AFT FACE DETAIL — Back arm vs Hall thrusters

        ┌──────────────────────────┐
        │    ┌──┐  [B]  ┌──┐      │
        │    │HT│       │HT│      │  HT = Hall Thruster
        │    │L │       │R │      │  B  = Back arm dock
        │    └──┘       └──┘      │
        │     ↕    0.12m   ↕      │
        │    15°          15°     │
        │     ╲          ╱        │
        │      exhaust cones      │
        └──────────────────────────┘

  Back arm must exit BETWEEN the two Hall thrusters.
  HT separation: ~0.6 m (on 1.0 m bus)
  HT plume half-angle: 15° vectoring + ~20° natural divergence = 35°
  Clear channel width at 0.5 m downstream: 
    0.6 - 2 × 0.5 × tan(35°) = 0.6 - 0.7 = -0.1 m → NO CLEARANCE
    
  → Back arm CANNOT exit straight aft through the thruster plane!
  
  Solution: Back arm dock offset to the SIDE (±0.3 m from center)
  and fires at 15° off-axis. Tether routes around thruster mounting bracket
  through a ceramic guide tube (§13).
```

### 12.5 Total Mass Budget (8-Arm V5)

<!-- V5 AUDIT FIX: C1+C2 — masses updated to V5 canonical values from §24.10-24.11.
     V3 arm masses (Weaver 11.0 kg, Spinner 3.7 kg, Front/Back 4.0 kg) are superseded
     by lighter V5 arms that move tether + reel to mothership. See §24.10 for derivation. -->

<!-- Rev 5 (2026-04-26): Single 8-arm table superseded by 3-tier tech ladder.
     Y3 Octo retains the original 220.3/266.3 numbers. Y0 Quad and Y1 Hex are new tiers.
     The 8-arm default (Rev 1) is replaced by 4-arm Y0 default (Rev 5). -->

**Per-arm masses** (from [`Constants.OCTOPUS_V5`](js/core/Constants.js:254)):
- Large Daughter (Weaver): [`WEAVER_MASS`](js/core/Constants.js:260) = **6.6 kg**
- Small Daughter (Spinner): [`SPINNER_MASS`](js/core/Constants.js:261) = **2.1 kg**
- Front Arm: [`FRONT_ARM_MASS`](js/core/Constants.js:262) = **6.6 kg** (dedicated front, mirrors weaver)
- Back Arm: [`BACK_ARM_MASS`](js/core/Constants.js:263) = **6.6 kg** (dedicated back)
- Core (incl. reels, springs, tethers, guides): **181.0 kg** (derived: 220.3 − 39.3 arm mass at Y3)
- Propellant (Xe + N₂): **46.0 kg**

#### Y0 Quad — Game-Start Baseline (2 LD + 2 SD)

```
Y0 dry = core 181.0 + 2×LD 6.6 + 2×SD 2.1
       = 181.0 + 13.2 + 4.2 = 198.4 kg
Y0 wet = 198.4 + 46.0 = 244.4 kg
```

| Component | Count | Unit Mass | Total Mass |
|---|---|---|---|
| Large Daughter arms | 2 | 6.6 kg | 13.2 kg |
| Small Daughter arms | 2 | 2.1 kg | 4.2 kg |
| Front arm | 0 | — | 0 kg |
| Back arm | 0 | — | 0 kg |
| **Arms subtotal** | **4** | — | **17.4 kg** |
| Core dry (+ reels, springs, guides, tethers) | 1 | 181.0 kg | 181.0 kg |
| **Y0 System dry** | — | — | **198.4 kg** |
| Propellant (Xe + N₂) | — | — | 46.0 kg |
| **Y0 System wet** | — | — | **244.4 kg** |

#### Y1 Hex — First Upgrade (3 LD + 3 SD)

```
Y1 dry = core 181.0 + 3×LD 6.6 + 3×SD 2.1
       = 181.0 + 19.8 + 6.3 = 207.1 kg
Y1 wet = 207.1 + 46.0 = 253.1 kg
```

| Component | Count | Unit Mass | Total Mass |
|---|---|---|---|
| Large Daughter arms | 3 | 6.6 kg | 19.8 kg |
| Small Daughter arms | 3 | 2.1 kg | 6.3 kg |
| Front arm | 0 | — | 0 kg |
| Back arm | 0 | — | 0 kg |
| **Arms subtotal** | **6** | — | **26.1 kg** |
| Core dry (+ reels, springs, guides, tethers) | 1 | 181.0 kg | 181.0 kg |
| **Y1 System dry** | — | — | **207.1 kg** |
| Propellant (Xe + N₂) | — | — | 46.0 kg |
| **Y1 System wet** | — | — | **253.1 kg** |

#### Y3 Octo — Full Platform (3 LD + 3 SD + 1 F + 1 B)

```
Y3 dry = core 181.0 + 3×LD 6.6 + 3×SD 2.1 + F 6.6 + B 6.6
       = 181.0 + 19.8 + 6.3 + 6.6 + 6.6 = 220.3 kg
Y3 wet = 220.3 + 46.0 = 266.3 kg
```

| Component | Count | Unit Mass | Total Mass |
|---|---|---|---|
| Large Daughter arms | 3 | 6.6 kg | 19.8 kg |
| Small Daughter arms | 3 | 2.1 kg | 6.3 kg |
| Front arm | 1 | 6.6 kg | 6.6 kg |
| Back arm | 1 | 6.6 kg | 6.6 kg |
| **Arms subtotal** | **8** | — | **39.3 kg** |
| Core dry (+ reels, springs, guides, tethers) | 1 | 181.0 kg | 181.0 kg |
| **Y3 System dry** | — | — | **220.3 kg** |
| Propellant (Xe + N₂) | — | — | 46.0 kg |
| **Y3 System wet** | — | — | **266.3 kg** |

Compared to V3 ([`OCTOPUS_TOTAL_WET_MASS: 260`](js/core/Constants.js:204) kg with 6 arms): Y3 Octo is **+6.2 kg** for 2 additional arms + crossbow mechanisms + reels — a 2.4% mass increase for a categorically different capability. Y0 Quad is **−15.7 kg lighter** than V3, giving the starting player a more agile platform. The arm mass reduction from moving tether/reel to the mothership (§24.10) nearly pays for all Y3 additions.

### 12.6 Gameplay Implications

- **8 arms = richer tactical options**: Front arm for prograde, back arm for retrograde, 6 body arms for broadside.
- **"Stance" mechanic**: Player chooses engagement posture — face target (front arm), chase-and-lasso (back arm), or broadside barrage.
- **Mass cost visible in shop**: Upgrading from 6 → 8 arms costs credits and adds mass (reduces ΔV budget). Trade-off: more arms vs more fuel.

---

## 13. Tether Routing to Avoid Ion Thruster Damage

### 13.1 The Threat: Hall Thruster Plume

The 2× HT-100 Hall thrusters at the aft face produce:
- Exhaust: Xe⁺ ions at ~300 eV = ~20 km/s
- Plume half-angle: ~20° natural + ±15° vectoring = up to 35° from axis
- Ion flux at 0.5 m downstream: ~10¹⁷ ions/cm²/s
- **Erosion rate on Dyneema**: unmeasured, but polymer materials erode at ~0.01 mm/hour under similar ion bombardment (ground testing of Hall thruster plume on Kapton)
- At 0.01 mm/hr on 0.1 mm thick tether: **complete erosion in 10 hours of thrust**

### 13.2 Tether Routing Map

```
TETHER ROUTING — AFT FACE (looking forward from -Z)

     ┌─────────────────────────┐
     │  S3 ·═══╗    ╔═══· W1  │  · = tether exit point
     │         ║    ║         │  ═ = tether path
     │  W3 ·═══╝    ╚═══· S1  │
     │                        │
     │    ┌──┐  ····  ┌──┐    │  ·· = DANGER ZONE
     │    │HT│ :::::: │HT│    │  :: = ION PLUME
     │    │L │ :::::: │R │    │
     │    └──┘ :::::: └──┘    │
     │         :::::: │       │
     │    B ·──╫──────┘       │  B exits to SIDE, not center
     │         ║              │
     └─────────╨──────────────┘
        Ceramic guide tube  ↓
        routes B-arm tether 
        wide of plume
```

### 13.3 Solutions by Arm Position

| Arm | Risk Level | Solution | Detail |
|---|---|---|---|
| W1 (30°) | Low | Natural clearance | Tether exits sideways, well above aft face |
| S1 (90°) | None | Perpendicular to thrust axis | No plume intersection possible |
| W2 (150°) | Medium | Ceramic guide tube | Tether routed along side panel, away from aft |
| S2 (210°) | Medium | Ceramic guide tube | Same as W2, opposite side |
| W3 (270°) | None | Perpendicular to thrust axis | No plume intersection |
| S3 (330°) | Low | Natural clearance | Mirror of W1 |
| Front (0°) | None | Opposite end of bus | 1.2 m from thrusters |
| **Back (180°)** | **CRITICAL** | **Offset dock + ceramic guide + interlock** | See §13.4 |

### 13.4 Back Arm Protection System

The back arm has the highest risk. Multi-layer protection:

**Layer 1 — Offset dock position:**
Back arm docking cavity is offset 0.3 m from bus centerline, between and below the two Hall thrusters. Tether exits laterally, not through the plume.

**Layer 2 — Ceramic guide tube:**
```
Alumina (Al₂O₃) ceramic tube:
  Inner Ø: 8 mm (fits 3mm × 0.1mm tether ribbon flat)
  Outer Ø: 12 mm
  Length: 0.4 m (routes tether from dock exit to clear of plume)
  Mass: ~50 g per tube
  Temperature rating: 1800°C (far above plume temperature)
  Ion erosion resistance: excellent (ceramic is what Hall thrusters are MADE of)
```

**Layer 3 — Thruster interlock:**
```
INTERLOCK LOGIC:

  IF backArm.tetherDeployed AND backArm.tetherInPlumeZone:
    Hall.maxVectorAngle = ±5° (reduced from ±15°)
    Hall.power = min(Hall.power, 50%) // reduce plume intensity
    
  IF backArm.state == REELING:
    Hall.INHIBIT = true // no thrust during back-arm reel-in
    Alert: "BACK ARM REEL — THRUSTERS INHIBITED"
    
  IF emergency:
    Sever back tether before emergency Hall thrust
```

**Layer 4 — Magnetic deflection (V5 upgrade):**
A small electromagnet coil around the back arm tether exit point creates a magnetic field (~0.01 T) that deflects low-energy Xe⁺ ions away from the tether. Ion gyroradius at 300 eV in 0.01 T:

```
r_gyro = mv / (qB) = (131 × 1.66e-27 × 20000) / (1.6e-19 × 0.01)
       = 4.35e-21 / 1.6e-21 = 2.72 m

→ Gyroradius is 2.72 m — much larger than the deflection region.
→ Magnetic deflection at 0.01 T is INEFFECTIVE for 300 eV Xe ions.
→ Need ~1 T for mm-scale deflection. Not practical.

VERDICT: Magnetic deflection fails. Rely on ceramic guide + interlock.
```

### 13.5 Automatic Tether Reel-In Before Thrust

For body-ring arms (W2, S2) that could intersect the plume at extreme vector angles:

```
THRUST SEQUENCE WITH TETHER SAFETY:

1. Player commands Hall thrust
2. System checks all deployed tether positions
3. IF any tether intersects expanded plume cone (35°):
   → Auto-reel affected arm(s) 50 m inward (5 s at 10 m/s)
   → OR constrain Hall vector angle to avoid tether
4. Thrust executes with safe vector limits
5. After thrust: tethers pay back out to previous positions
```

### 13.6 Gameplay Implications

- **Thruster interlock creates tension**: Firing the back arm means no retrograde thrust for a while. Player must plan.
- **Warning indicators**: HUD shows "TETHER IN PLUME ZONE" warning when thrust vectoring approaches deployed tethers.
- **Equipment damage**: If player overrides interlock (emergency), tether takes durability damage. Too much = snap.
- **Ceramic guide tubes visible**: On the ship model, ceramic tubes route tethers around the aft section — visual detail that communicates engineering.

---

## 14. 8 Tether Reels — Placement, Orientation, Tension, Tangles

### 14.1 Reel Specifications

| Parameter | Value | Notes |
|---|---|---|
| Reel count | 8 | One per arm (6 body + 1 front + 1 back) |
| Reel mass | 1.2 kg each | Motor + spool + clutch + electronics |
| Total reel mass | 9.6 kg | Significant budget item |
| Spool capacity (Dyneema) | 2 km × 3mm ribbon | Weaver reels |
| Spool capacity (Dyneema) | 500 m × 3mm ribbon | Spinner reels |
| Motor power | 15 W ([`TETHER_REEL_POWER`](js/core/Constants.js:150)) | Reel-in/out + spring compression |
| Max reel-in speed | 2.0 m/s | [`WEAVER_TETHER_REEL_SPEED`](js/core/Constants.js:116) |
| Braking mechanism | Magnetic clutch | Eddy-current brake (no friction wear) |
| Tension sensing | Strain gauge (1 kHz) | 0.1 N resolution |
| Level-wind mechanism | Yes | Prevents tangles during spool |

### 14.2 Placement

```
REEL PLACEMENT — OCTAGONAL BUS CUTAWAY (top view)

              +Z (forward)
                ↑
         ┌──────┤──────┐
         │  [FR]│      │  FR = Front reel (behind front arm dock)
         │      │      │
    [R6]─┤──  ┌─┴─┐  ──├─[R1]   R1–R6 = Body reels
         │    │CPU│    │         (inside bus, near their cavity)
    [R5]─┤──  │BAT│  ──├─[R2]   
         │    │   │    │
    [R4]─┤──  └─┬─┘  ──├─[R3]
         │      │      │
         │  [BR]│      │  BR = Back reel (above back arm dock)
         └──────┤──────┘
                ↓
              -Z (aft)

  Each reel sits INSIDE the bus wall, directly behind its docking cavity.
  Tether feeds through a guide port in the cavity wall.
  Reels indexed 30° off each arm dock to avoid mechanical interference.
```

### 14.3 Unreel (Free-Spool) Mode

During crossbow launch, the tether must pay out **faster than the arm flies** to avoid premature braking:

```
Free-spool specification:
  Mechanism: magnetic clutch DISENGAGED → spool spins freely
  Friction: <0.05 N (low-friction ceramic bearings)
  Max payout rate: 20 m/s (2× max launch speed)
  
  At 10 m/s arm launch: tether pays out at 10 m/s
  Spool angular velocity: v / r_spool
    At r = 50 mm (full spool): ω = 10/0.05 = 200 rad/s ≈ 1910 RPM
    At r = 25 mm (nearly empty): ω = 10/0.025 = 400 rad/s ≈ 3820 RPM
    
  Spool moment of inertia (Dyneema, full):
    I ≈ ½m_tether × r² = ½ × 2.4 × 0.05² = 0.003 kg·m²
    Energy to spin up: ½Iω² = ½ × 0.003 × 200² = 60 J
    
  This energy comes from the arm's kinetic energy — the arm 
  actually launches ~0.4 m/s slower than the spring would predict
  due to tether inertia. At 550 J launch energy, 60 J loss = 10.9%.
  
  Corrected launch speed: v = √(2 × (550-60)/11) = √(89.1) = 9.44 m/s
  (vs 10 m/s ideal — acceptable)
```

### 14.4 Constant Tension Control

```
TENSION CONTROL LOOP — Block Diagram

  ┌──────────┐     ┌──────────┐     ┌──────────┐
  │ STRAIN   │ T   │ PID      │ I   │ MAGNETIC │
  │ GAUGE    ├────►│ CONTROL  ├────►│ CLUTCH   │
  │ (1 kHz)  │     │ LOOP     │     │ (braking)│
  └──────────┘     │          │     │ + MOTOR  │
                   │ T_target │     │ (reel-in)│
                   │ T_error  │     └──────────┘
                   └──────────┘
                        ↑
  T_target varies by state:
    FREE-SPOOL:  T = 0 (clutch disengaged)
    BRAKING:     T = ramp from 0 → braking force
    STATION:     T = 2 N (light tension to prevent slack)
    REEL-IN:     T = motor force - m×a (PID-controlled)
    DOCKING:     T = 5 N (gentle pull into cavity)
```

**Tension bounds:**

| Condition | Min Tension | Max Tension | Action if exceeded |
|---|---|---|---|
| Free-spool | 0 N | 0.5 N | — |
| Station-keeping | 1 N | 10 N | Alert if >10 N (snagged) |
| Braking | 0.5 N | 50 N | Reduce brake if >50 N |
| Reel-in (empty) | 1 N | 50 N | Slow reel if >50 N |
| Reel-in (loaded 500 kg) | 5 N | 200 N | Emergency stop if >200 N |
| **CRITICAL** | — | **500 N** | **Tether SNAP** |

### 14.5 Tangle Detection & Handling

Tangles are the nightmare scenario. Detection relies on strain gauge patterns:

```
TANGLE SIGNATURES:

Normal tether:
  Tension: ──────── (steady, smooth)
  
Developing tangle:
  Tension: ──╱╲──╱╲── (oscillating, irregular)
  + Reel motor drawing excess current (tether binding on spool)
  
Full tangle:
  Tension: ──╱──────── (sudden spike, then stuck)
  + Reel motor stall (cannot reel in or out)
  + Arm reports unexpected rotation (tether wrapping around arm body)
```

**Tangle resolution protocol:**

```
TANGLE RESPONSE — DECISION TREE

  IF tangle_detected:
    1. STOP all reel operations (prevent worsening)
    2. ALERT player: "TETHER TANGLE — ARM [id]"
    3. OPTIONS displayed:
       
       [UNTANGLE] — Costs 30 seconds + arm fuel
         Mother reverses rotation slowly
         Arm FEEP counter-rotates
         Success rate: 60% for minor tangles, 20% for severe
         
       [RELEASE] — Arm goes free-flyer
         Sever tether at reel (explosive bolt)
         Arm operates on battery + FEEP only
         Limited FEEP fuel = limited lifetime
         Must self-deorbit if no fuel to return
         
       [SACRIFICE] — Lose arm entirely
         Release tether + command arm deorbit
         Arm burns all fuel retrograde
         Score: DEORBIT_MULTIPLIER bonus
         Loss: arm replacement cost ($$$)

  Captured debris (if any) goes with the arm in all cases.
```

### 14.6 Level-Wind Mechanism

Like a fishing reel's level-wind guide, a traversing arm ensures tether lays evenly on the spool:

```
LEVEL-WIND — TOP VIEW OF SPOOL

  ┌───────────────────────┐
  │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │ ← tether layers, evenly wound
  │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │
  │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │
  │  ↕ guide traverses    │
  └──────┤ ├──────────────┘
         │ │ ← tether exits through guide slot
         └─┘
  
  Guide driven by worm gear (same motor axis as spool)
  Traversal rate: 1 mm per revolution (ribbon width = 3 mm, overlap = 66%)
  Prevents: ribbon piling up on one side → jamming → tangle
```

### 14.7 Gameplay Implications

- **Reel status on HUD**: Each arm's tether reel shows: deployed length, tension (bar graph), tangle warning.
- **Tangle as failure mode**: Adds meaningful risk to tether operations. More aggressive maneuvers = higher tangle chance.
- **Fishing reel audio**: Level-wind click during reel operations. Brake whine during deceleration. Motor hum during reel-in.
- **Reel upgrades in shop**: Faster motors, better clutches, anti-tangle algorithms → fewer tangles, faster cycles.

<!-- V5 AUDIT FIX: G1 — Multi-tether interference note added per audit gap analysis -->
### 14.8 Multi-Tether Interference During Simultaneous Deployment

During Pulse Scan (§9) all 8 arms deploy simultaneously. Tether-tether contact risk:

- **Angular separation**: 8 arms at minimum 45° spacing (body ring at 60°). At 2 km deployment radius, inter-tether distance at the tips exceeds **1.5 km** (2 × 2000 × sin(22.5°) = 1,531 m). Physical contact between adjacent tethers is essentially impossible at full extension.
- **Deployment phase**: As tethers extend from ~0 m to 2 km, the minimum separation decreases near the bus. At 100 m radius, adjacent tethers are still 76 m apart (100 × 2 × sin(22.5°)). GSL ribbon width is 30 mm — three orders of magnitude smaller than the gap. No contact risk during deployment.
- **Reel-in synchronization**: Reel-in of multiple arms must be coordinated to prevent crossing trajectories. If Arm A is at 500 m and Arm B (adjacent) is at 1500 m, both on reel-in, their tethers remain in fixed angular planes (radial from bus). Crossing requires >45° lateral drift — impossible under tether tension. **However:** if one arm is maneuvering under FEEP while an adjacent arm is on reel-in, the maneuvering arm's tether could drift. Recommendation: adjacent arm reels pause during FEEP maneuver on the neighboring arm, or reel-in autopilot limits lateral excursion to <10° from radial.

---

## 15. Y-Harness Tether Bridle — Geometry, FEEP Clearance & Materials

> **⚠️ CONFIG G: SECTION SUPERSEDED.** Config G places the tether reel on the **strut tip**, not inside the bus. The tether goes straight from the strut-tip reel to the daughter — no Y-harness bridle, no junction fitting, no FEEP plume clearance geometry needed. Daughter FEEP fires AWAY from the strut tip. This entire section is retained for historical reference only. See [`ARM_PIVOT_ANALYSIS.md §10.4`](ARM_PIVOT_ANALYSIS.md:934) for Config G strut-tip assembly and [`ARM_PIVOT_GAPS_EXPLAINER.md §V-6`](ARM_PIVOT_GAPS_EXPLAINER.md) for the supersede rationale. ST-9.7 effort reduced from 1 day to 0.5 day.

The Y-harness design from §3.3 requires deeper analysis of how it integrates with the arm during all operational phases and how it connects to the mothership.

### 15.1 Arm-to-Harness Interface During Docked State

When docked in its cavity, the arm's Y-bridle must fold compactly:

```
ARM IN DOCKING CAVITY — CROSS SECTION (looking inward from bus surface)

    ┌─────────────── CAVITY WALL ───────────────┐
    │                                            │
    │  ┌──EPM clip──┐   ARM    ┌──EPM clip──┐   │
    │  │ bridle leg  │  BODY   │ bridle leg  │   │
    │  │ (folded     │ ┌────┐  │ (folded     │   │
    │  │  flat)      │ │    │  │  flat)      │   │
    │  └─────────────┘ │    │  └─────────────┘   │
    │                  │    │                     │
    │    ┌─ SPRING ────┤    ├──── SPRING ─┐      │
    │    │  SHUTTLE    │FEEP│   SHUTTLE    │      │
    │    └─────────────┤    ├─────────────┘      │
    │                  └──┬─┘                    │
    │                     │ tether guide channel  │
    │                     ▼ (to reel behind wall) │
    └─────────────────────┴──────────────────────┘
```

The tether path: **Reel → guide channel through cavity wall → Y-junction (below arm) → two bridle legs (along arm lateral faces, held by EPM clips) → hardpoints at arm mid-body.**

On launch: spring shuttle pushes arm outward. EPM clips release simultaneously with main dock EPM. Bridle legs peel off the arm's sides and open into a V under tether tension within the first 0.3 m of travel — well before the arm clears the cavity mouth.

### 15.2 Bridle Behavior Under Crossbow Acceleration

During the 40 ms spring release, the arm experiences ~250 g of acceleration (for 10 m/s launch). The bridle legs must not flail or tangle:

```
Peak launch acceleration (Weaver at 10 m/s):
  F_spring_peak = k × d = 17,600 × 0.25 = 4,400 N
  a_peak = 4,400 / 11.0 = 400 m/s² ≈ 40 g
  
  Bridle leg mass: ~15 g each
  Force on each leg at 40 g: 0.015 × 400 = 6 N
  
  This pulls each leg FORWARD (with the arm) → legs trail behind
  → natural V-opening shape under acceleration. No tangle risk. ✓
```

### 15.3 Bridle During FEEP Maneuvering (APPROACH State)

When the arm fires FEEP thrusters laterally to steer toward a target, the Y-bridle allows the arm to yaw/pitch while the tether maintains backline tension:

```
ARM LATERAL THRUST WITH Y-BRIDLE

        FEEP lateral ←──── ARM ────→ target direction
                           │╲
               port leg────│  ╲────stbd leg
                           │   ╲
                           ◆ Y-junction
                           │
                     Main tether (taut, toward mother)

  When arm yaws 20° right:
    - Starboard leg shortens (goes slack momentarily)
    - Port leg takes full load
    - Y-junction shifts slightly off-center
    - PID reel adjusts tether length to maintain tension
    
  Each leg independently handles ~250 N (half of 500 N tether strength)
  = 5× safety on typical loads. Adequate for asymmetric loading.
```

### 15.4 Gameplay Implications

- Y-harness is visually distinct — two tether lines diverging near the arm create a "bridle" look, reinforcing the crossbow/horse metaphor.
- If one bridle leg breaks (MMOD impact): arm can still operate on single leg at reduced load capacity. HUD shows "BRIDLE DAMAGE" warning.
- Bridle leg tension asymmetry during maneuvering is visible as color differential (one leg amber, one green).

---

## 16. Mother Attitude & Force Management During Launch/Reel

### 16.1 Torque Analysis — Single-Arm Crossbow Fire

When a crossbow fires, the spring pushes the arm outward. The reaction force pushes the mothership in the opposite direction. The critical question: **does this force create torque?**

```
TORQUE FROM CROSSBOW FIRE

  The spring force acts along the cavity axis (radially outward).
  If the cavity axis passes THROUGH the bus CoM:
    Torque = F × r_perp = F × 0 = 0  ← ideal case
    
  But the bus is an octagonal prism. Cavity axes are radial,
  passing through the geometric center of the octagon.
  If mass is symmetrically distributed: CoM = geometric center.
  → Zero torque from any radially-firing crossbow. ✓
  
  HOWEVER — after deploying some arms, mass distribution shifts:
  
  Example: W1 (11 kg) deployed, all others docked.
    CoM shift = m_arm × r_cavity / M_remaining
    = 11 × 0.5 / (283 - 11) = 0.020 m = 20 mm
    
    Now W2 fires from opposite side:
    Moment arm = cavity_offset_from_new_CoM
    = 0.5 - 0.020 = 0.48 m (almost unchanged)
    
    Spring impulse: p = 110 kg·m/s, over 0.04 s
    Average force: 110 / 0.04 = 2750 N
    Torque: 2750 × 0.020 = 55 N·m for 0.04 s
    
    Angular impulse: 55 × 0.04 = 2.2 N·m·s
    Bus moment of inertia: I ≈ ½Mr² = ½ × 272 × 0.5² = 34 kg·m²
    Angular velocity gained: ω = L/I = 2.2/34 = 0.065 rad/s (3.7°/s)
```

**Stabilization options:**

| Method | Available Torque | Time to counter 2.2 N·m·s | Consumable |
|---|---|---|---|
| Reaction wheels (4× RWP050) | 7 mN·m | 2.2/0.007 = 314 s | Zero (electrical) |
| Cold gas RCS (4× VACCO) | 5 N·m | 2.2/5.0 = 0.44 s | 0.0037 kg N₂ |
| Hall thrusters (2× HT-100) | 0.01 × 0.5 = 5 mN·m | 2.2/0.005 = 440 s | Xenon |

**Recommendation:** RCS burst absorbs crossbow recoil torque in <0.5 s at minimal N₂ cost (3.7 g). Reaction wheels handle residual drift over the next ~5 minutes. This layered approach (RCS for impulsive, RW for slow correction) is standard practice in satellite attitude control.

<!-- V5 AUDIT FIX: G4 — Crossbow firing under mother rotation note -->
> **Pre-fire rotation check:** If the mothership has non-zero angular velocity at fire time, the crossbow impulse adds vectorially to the existing angular momentum, potentially compounding attitude error. Pre-fire checklist requires **ω_mother < 0.5°/s**; if exceeded, RCS damps rotation before crossbow release. The fire-control software enforces this as a hard gate — crossbow trigger is inhibited until ω < 0.5°/s (displayed on HUD as "STABILIZE" warning).

### 16.2 Force Analysis — Reel-In with 500 kg Debris

Reeling in a loaded arm creates sustained force on the bus:

```
REEL-IN FORCE ON MOTHERSHIP

  Phase 1 — Acceleration (0 → 2 m/s over 20 s):
    Total system mass: M_bus + m_arm + m_debris = 216 + 11 + 500 = 727 kg
    
    In the CoM frame, the bus and arm+debris approach each other:
    v_bus = m_load/(M_bus + m_load) × v_reel = 511/727 × 2.0 = 1.41 m/s
    v_load = M_bus/(M_bus + m_load) × v_reel = 216/727 × 2.0 = 0.59 m/s
    
    Tension at tether attachment (on bus):
    F = M_bus × a_bus = M_bus × v_bus/t_accel
    = 216 × 1.41/20 = 15.2 N  (during Phase 1)
    
    Actually, more precisely:
    The reel on the bus shortens the tether. The tension accelerates
    both sides toward each other. The force is the same on both sides
    (Newton's 3rd):
    F = m_load × a_load = 511 × (0.59/20) = 15.1 N ← matches
    
  Phase 2 — Steady reel (1960 m at 2 m/s):
    Both approach at constant speed → zero net force needed
    Reel provides only friction compensation: ~2 N
    
  Phase 3 — Deceleration (last 20 m):
    Same analysis as Phase 1 reversed: ~15 N braking
    
  LINEAR ACCELERATION ON BUS:
    Phase 1: a = 15.2/216 = 0.070 m/s² for 20 s
    → Bus drifts 14 m during acceleration phase
    This is small relative to orbital mechanics but visible in-game.
```

**Torque during reel-in:**

```
If tether is perfectly radial (through bus CoM):
  Torque = 0 (force line passes through CoM)

If arm+debris is 100 m laterally offset at 2 km range:
  θ = arctan(100/2000) = 2.86°
  Torque = F × r_bus × sin(θ) = 15 × 0.5 × 0.050 = 0.375 N·m
  
  Reaction wheel capacity: 7 mN·m → would need 0.375/0.007 = 54 s
  RCS: 5 N·m → instant correction ✓
  
  RCS N₂ cost for 980 s of steady reel with ~0.4 N·m torque:
  Burn fraction: 0.4/5 = 8% duty cycle
  N₂ rate: ~0.02 kg/s at 8% = 0.0016 kg/s
  Total: 0.0016 × 980 = 1.57 kg
  → SIGNIFICANT! Uses 26% of the 6 kg N₂ budget for ONE reel-in!
  
  SOLUTION: Keep arm within ±10 m of radial during reel-in.
  The arm fires lateral FEEP to stay on the radial line.
  At ±10 m offset at 2 km: θ = 0.29°, torque = 0.038 N·m
  → Reaction wheels handle this alone. Zero RCS cost. ✓
```

### 16.3 Attitude Hold During Extended Operations

Multiple tethered arms create a **distributed force network** on the bus. Each tether applies ~2 N of tension during station-keeping. With 6 body arms deployed symmetrically, forces approximately cancel. But asymmetric deployments (some arms at 2 km, others at 500 m) create net torque.

```
Worst case: All 3 Weavers deployed at 2 km (port hemisphere),
all 3 Spinners docked (starboard hemisphere):
  
  Net lateral force: 3 × 2 N = 6 N (toward port)
  Torque about CoM: 6 × 0.3 m (average moment arm) = 1.8 N·m
  
  Reaction wheel saturation time: 50 mN·m·s / 1.8 N·m = 28 s
  → RW saturates in 28 seconds!
  
  Must dump momentum via RCS: 1.8 N·m at 5 N·m RCS = 36% duty
  N₂ consumption: ~0.006 kg/s × 0.36 = 0.0022 kg/s
  Per orbit (5556 s): 0.0022 × 5556 = 12.2 kg → EXCEEDS N₂ budget!
  
  CONCLUSION: Cannot have persistent asymmetric tether tension.
  
  Solutions:
  1. Maintain symmetric deployment (balanced arm pairs)
  2. Pre-tension trim: adjust individual reel tensions to balance net torque
  3. EDT propulsion: use Lorentz force on tethers for attitude assist
  4. Gravity gradient: deploy arms along local vertical for free stabilization
```

**Pre-tension trim** is the most practical: each reel PID adjusts its tension setpoint (1–5 N range) to null the net torque on the bus. Six reels with independent tension = 6 degrees of control. Only 3 are needed for torque balance (3-axis). The remaining 3 provide redundancy.

### 16.4 N₂ Budget for V5 Mission

| Operation | N₂ per event (g) | Events per mission | Total N₂ (g) |
|---|---|---|---|
| Crossbow recoil (single fire) | 3.7 | 30 | 111 |
| Crossbow recoil (dual fire) | 0 | 15 | 0 |
| Reel-in heavy debris (torque) | 10 (with FEEP radial hold) | 20 | 200 |
| Attitude trim (asymmetric arms) | 2 per orbit | 200 orbits | 400 |
| General attitude maneuvering | 5 per maneuver | 50 | 250 |
| Reserve (20%) | — | — | 192 |
| **Total** | | | **1,153 g = 1.15 kg** |

The 6 kg N₂ budget provides **5.2× margin** for the V5 mission profile. Comfortable.

### 16.5 Gameplay Implications

- **Bus recoil is visible**: When crossbow fires, mothership lurches. Camera shows it. Player feels the physics.
- **Asymmetric deployment penalty**: HUD shows "ATTITUDE DRIFT" warning if arms are asymmetric. Costs RCS fuel. Incentivizes balanced play.
- **"Center of Thrust" indicator** on NavSphere: Shows net tether force vector. Player balances by deploying opposite arms.
- **Reel-in approach line**: During REELING state, arm FEEP auto-corrects to stay radial. If FEEP fuel is depleted, reel-in creates torque penalty.

---

## 17. Integration with Mother Systems — Thrusters, Solar, Sensors, Comms

> **⚠️ CONFIG G:** Solar panels changed from rigid deployable wings (3m port+starboard) to **ROSA panels** in the 0°/180° plane extending along the barrel axis + thin-film GaAs on barrel body. Config G's 3-plane layout (arms at 60°/120°/240°/300°, ROSA at 0°/180°) eliminates wing-strut interference — minimum 60° angular separation. Hall thruster plume interaction greatly reduced (nearest arm plane 60° from thrust axis vs direct conflict in equatorial layout). See [`ARM_PIVOT_ANALYSIS.md §10.3`](ARM_PIVOT_ANALYSIS.md:881) (ROSA spec) and [`§10.15`](ARM_PIVOT_ANALYSIS.md:1716) (thin-film body cells).

### 17.1 Forward Face (+Z) — Laser, Sensors, Front Arm

The forward face carries the mothership's most critical systems:
- **808nm laser aperture** (20cm Cassegrain, [V3 §4](V3%20Octopus.md:217)) — primary power/comms/nav
- **MEMS scanning mirror** — addresses all deployed arms at 1 kHz
- **Forward sensor suite** — stereo cameras + IR for debris detection
- **V5 Front arm dock** — new addition

```
FORWARD FACE LAYOUT (+Z, looking aft)

    ┌─────────────────────────────────┐
    │                                 │   Octagonal face,
    │  ┌──────┐            ┌──────┐  │   ~414 mm per face
    │  │SENSOR│            │SENSOR│  │   (1.0m across flats)
    │  │(CAM) │            │ (IR) │  │
    │  └──────┘            └──────┘  │
    │          ┌──────────┐          │
    │          │  LASER   │          │
    │          │ APERTURE │          │
    │          │  (20cm)  │          │
    │          └──────────┘          │
    │  ┌──────────────────────────┐  │
    │  │     FRONT ARM DOCK       │  │ ← V5 addition
    │  │   (Spinner, below laser) │  │   offset below laser axis
    │  └──────────────────────────┘  │
    └─────────────────────────────────┘
```

**Tether routing:** Front arm tether exits downward from the dock, routes along the +Z face edge, and enters the bus interior through a guide port on the lower octagonal facet to reach the front reel. The tether does NOT cross the laser aperture FOV.

**MEMS scanner interaction:** The front arm, when deployed along +Z, is directly in the MEMS scanner's primary coverage zone (±30° from boresight per [V3 §4.1](V3%20Octopus.md:250)). The scanner can track this arm from launch to full extension — ideal for maintaining optical link throughout the mission.

### 17.2 Aft Face (-Z) — Hall Thrusters, Antenna, Back Arm

The aft face is the most congested:

```
AFT FACE LAYOUT (-Z, looking forward)

    ┌─────────────────────────────────┐
    │                                 │
    │   ┌────┐              ┌────┐   │
    │   │ HT │   S-BAND     │ HT │   │  HT = Hall Thruster
    │   │ L  │  ANTENNA     │  R │   │  (10 mN each, Xe+)
    │   │    │  ┌──────┐    │    │   │
    │   └────┘  │ PATCH│    └────┘   │
    │    ╲15°   │ARRAY │    15°╱    │
    │     ╲     └──────┘    ╱      │  ±15° vectoring range
    │      ╲               ╱       │
    │   ┌───╲─────────────╱───┐    │
    │   │  BACK ARM DOCK       │   │ ← V5 addition
    │   │  (offset 0.3m port)  │   │   offset from center
    │   └─────────────────────┘    │   to avoid both HT plumes
    └─────────────────────────────────┘
```

**Back arm dock placement:** Offset 0.3 m to port of center. This places it between the left Hall thruster and the S-band antenna. The tether exits at ~20° from the -Z axis (angled to port) through a ceramic guide tube, routing wide of both thruster plume cones.

**S-band antenna:** The patch array on the aft face is Earth-pointing during ground station passes. During these passes (30–90 s windows per [V3 §12](V3%20Octopus.md:1164)), the back arm tether could shadow ~5% of the antenna aperture if deployed. **Mitigation:** Accept 0.5 dB signal degradation during passes when back arm is out (negligible), OR auto-reel back arm during comms windows (costs 60 s of reel time).

### 17.3 Solar Wings — Clearance and Tether Routing

The two solar wings deploy from the bus mid-section, port and starboard:

```
SOLAR WING vs TETHER GEOMETRY — FRONT VIEW

              ↑ +Y (zenith)
              │
  ┌───────────┼───────────┐
  │ SOLAR     │     SOLAR │
  │ WING      │      WING │  Each wing: 3m span × 0.8m chord
  │ PORT  ────┼──── STBD  │  Hinge at bus mid-height (0.6m up)
  │           │           │
  └───────────┼───────────┘
              │
              ↓ -Y (nadir)

  Arm cavities are on the octagonal faces at various heights.
  Upper cavities (W1 at 30°, S1 at 90°): tethers exit ABOVE wing plane ✓
  Lower cavities (S2 at 210°, W3 at 270°): tethers exit BELOW wing plane ✓
  Mid-level cavities (W2 at 150°, S3 at 330°): tethers exit at wing level ⚠️
```

**Wing-level cavities (W2, S3):** These arm tethers could contact the solar wing trailing edge during deployment if the wing is fully extended. Solutions:

1. **Tether guide rails** along the wing root fairings route tethers 50 mm above/below the wing plane.
2. **Cavity exit angle** tilted 10° away from the wing plane — tether diverges from wing within 0.5 m.
3. **Wing fold protocol**: If a wing-level arm is being deployed, temporarily fold the wing 5° inward (0.5 s actuator command). Wing returns after tether clears.

**Solar power during arm operations:** Rotating the mother to aim a Weaver crossbow (§8) briefly disrupts optimal solar pointing. Worst case: 90° off-sun for ~7 s (per §8.4). Lost energy: 1900 W × 7 s = 13.3 kJ = 3.7 Wh — trivial against the 600 Wh battery.

### 17.4 MEMS Scanner Coverage vs Arm Positions

The core's MEMS scanning mirror covers ±30° from the +Z axis ([V3 §4.1](V3%20Octopus.md:250)). Not all arms fall within this cone:

| Arm | Angle from +Z | In Scanner FOV? | Optical Link | Power Source |
|---|---|---|---|---|
| Front (0°) | 0° | ✅ Always | Full laser | Laser |
| W1 (30°) | 30° | ✅ At edge | Full laser | Laser |
| S1 (90°) | 90° | ❌ Outside | Tether copper backup | Solar + battery |
| W2 (150°) | 150° | ❌ Outside | Tether copper backup | Solar + battery |
| S2 (210°) | 150° from +Z | ❌ Outside | Tether copper backup | Solar + battery |
| W3 (270°) | 90° from +Z | ❌ Outside | Tether copper backup | Solar + battery |
| S3 (330°) | 30° from +Z | ✅ At edge | Full laser | Laser |
| Back (180°) | 180° | ❌ Outside | Tether copper backup | Solar + battery |

**Only 4 of 8 arms** (Front, W1, S3, plus partial Back via aft mirror) get continuous laser service. The other 4 rely on **tether-conducted power** (5 W backup via GSL ribbon at high voltage — see §20.5; or copper in V4 legacy config) and 9600 baud data, plus their own body-mounted solar panels (8–15 W peak).

**Implication:** Broadside + aft arms must duty-cycle their FEEP thrusters more aggressively, relying on battery buffer. This is already designed for in V3 ([V3 §9.1](V3%20Octopus.md:1000)). No V5 change needed.

### 17.5 Gameplay Implications

- **"Laser-lit" vs "dark" arms**: Arms in the scanner FOV glow with a subtle 808nm indicator in-game. Dark arms show battery icon. Different tactical feel.
- **Solar panel orientation matters**: If mother rotates to aim a Weaver, solar power drops temporarily. HUD shows momentary power dip.
- **Wing fold animation**: Brief solar wing tuck during certain arm deployments — adds visual detail.
- **Back arm comms conflict**: During ground station passes, player chooses: keep back arm out (accept signal loss) or reel it in (lose tactical position).

---

## 18. Space Environment Threats — AO, UV, Thermal, MMOD

### 18.1 Atomic Oxygen (AO) Erosion in LEO

At 400 km altitude, the atmosphere is predominantly atomic oxygen (AO) with flux ~10¹³–10¹⁴ atoms/cm²/s depending on solar activity. AO chemically erodes polymer surfaces:

```
AO EROSION RATES (published values, NASA MISSE data):

  Material              Erosion yield (cm³/atom)   Rate at 10¹⁴ flux
  ─────────────────────────────────────────────────────────────────
  Kapton (polyimide)    3.0 × 10⁻²⁴              3.0 × 10⁻¹⁰ cm/s
  Dyneema (UHMWPE)     3.7 × 10⁻²⁴              3.7 × 10⁻¹⁰ cm/s
  Vectran (LCP)         1.8 × 10⁻²⁴              1.8 × 10⁻¹⁰ cm/s
  Zylon (PBO)           2.5 × 10⁻²⁴              2.5 × 10⁻¹⁰ cm/s
  Carbon/graphene       ~0.2 × 10⁻²⁴             0.2 × 10⁻¹⁰ cm/s
  HBN-coated GSL        ~0.01 × 10⁻²⁴            Near zero (passivates)

Dyneema SK78 tether (0.1 mm thickness) exposed to ram AO:
  Erosion depth per year: 3.7 × 10⁻¹⁰ × 3.15 × 10⁷ = 0.0117 mm/yr
  Time to erode through: 0.1 / 0.0117 = 8.6 years → OK for 2-year mission
  
  BUT: the Vectran overbraid erodes first (1.8 × 10⁻²⁴), then exposes
  the Dyneema. Combined: ~3 years to full tether compromise.
  
GSL + HBN tether:
  HBN forms stable B₂O₃ passivation layer in AO → erosion essentially stops.
  GSL itself is carbon-based: ~5× more resistant than polymers.
  Combined: indefinite AO survival. ✓
```

**Orientation matters:** A tether deployed **radially** (from body-mounted arms) presents its narrow edge (~0.1 mm) to the ram direction (velocity vector). AO flux integrates over the cross-section presented to the flow. Edge-on exposure is ~30× less than broadside.

The **front and back arms** deploy along the velocity vector (prograde/retrograde). Their tethers present the **broad face** (3 mm or 30 mm for GSL) to the AO flow — maximum erosion. HBN coating is **essential** for these tethers.

### 18.2 UV Photodegradation

Solar UV flux in LEO: ~130 W/m² (UV-A + UV-B + UV-C, unfiltered by atmosphere).

| Material | UV Vulnerability | Mitigation | V5 Impact |
|---|---|---|---|
| Dyneema SK78 | Moderate — cross-linking embrittlement | Vectran overbraid blocks most UV | Marginal for 2-year mission |
| Zylon PBO | **SEVERE** — loses 50% strength in weeks | No practical coating fixes this | Game mechanic: UV degrades Zylon tether |
| CNT Yarn | Low — carbon is UV stable | None needed | OK |
| GSL | None — graphene absorbs UV without damage | HBN is UV transparent | OK |
| HBN coating | None — transparent to UV, chemically inert | — | OK |

**Gameplay note:** Zylon (Tier 2 upgrade in §7) degrades in sunlight. Player must keep Zylon-tethered arms in the mother's shadow or accept progressive strength loss. This creates a meaningful trade: Zylon is +15% reach but has UV degradation risk. Strategic depth.

### 18.3 Thermal Cycling

LEO orbit period ~92 min, with ~35 min eclipse:

```
Tether thermal cycle:
  Sunlit: ~+80°C (ribbon absorbs IR, thin cross-section heats fast)
  Eclipse: ~-170°C (thin tether radiates heat rapidly — no thermal mass)
  Cycle rate: ~15.7 cycles/day, ~5,700 cycles/year, ~11,400 for 2-year mission

Material thermal limits:
  Dyneema SK78:    -150°C to +80°C  ← AT ITS LIMITS
  Kevlar 49:       -200°C to +200°C ← plenty of margin
  Zylon PBO:       -200°C to +400°C ← OK thermally (but UV kills it)
  GSL:             -270°C to +400°C ← excellent
  HBN:             -270°C to +900°C ← excellent
  
Dyneema concern: thermal creep above +70°C causes permanent elongation.
After 10,000 cycles: ~0.5% length increase (10 m on 2 km tether).
Reel encoder compensates by recalibrating deployed length. Acceptable.
```

### 18.4 MMOD (Micrometeoroid and Orbital Debris) Impact Probability

```
MMOD flux model (NASA ORDEM 3.0, 400 km altitude):

  Particle diameter  | Flux (impacts/m²/year)  | Can sever 0.1mm ribbon?
  ───────────────────┼─────────────────────────┼────────────────────────
  > 10 µm            | ~1.0                    | No (surface pitting only)
  > 100 µm           | ~5 × 10⁻²              | Marginal (partial depth)
  > 1 mm             | ~1 × 10⁻³              | YES (penetrates 0.1mm)
  > 1 cm             | ~5 × 10⁻⁵              | Catastrophic sever

Tether presented area to MMOD:
  Weaver (2 km × 3 mm ribbon, ram-facing edge):
    A_presented = 2000 × 0.0001 = 0.2 m² (edge-on to ram)
    
  Expected severs per year (>1 mm particles):
    N = 10⁻³ × 0.2 = 2 × 10⁻⁴ = 0.02% per year per tether
    
  For GSL (2 km × 30 mm ribbon, but only 340 nm thick):
    Broadside area: 2000 × 0.03 = 60 m² (if fully broadside to ram)
    Edge-on area: 2000 × 340e-9 = 0.00068 m² ← almost zero!
    
  GSL is essentially MMOD-immune when oriented edge-on to ram.
  
  With 8 tethers over 2 years:
    P(any sever) = 1 - (1 - 0.0002)^(8×2) ≈ 0.32% ← very low
    
  Acceptable risk. No special MMOD protection needed for tethers.
```

### 18.5 Gameplay Implications

- **Environment as mechanic**: AO erosion, UV degradation, thermal cycling → tether durability stat. Each tether has a "health" percentage that degrades over mission time.
- **Material choice matters**: Dyneema degrades slowly (AO, thermal). Zylon degrades fast (UV). GSL+HBN is nearly immune. Higher-tier tethers last longer.
- **Front/back tethers degrade faster** (broadside AO exposure) — flavors the cost-benefit of prograde/retrograde arms.
- **MMOD random event**: Rare chance (~0.3% per mission) of tether sever from debris strike. Dramatic, costly, drives player toward GSL upgrade.

---

## 19. Zero-Gravity Tether Tension — Always Taut or Tangle

### 19.1 The Zero-G Tangle Problem

In microgravity, a slack tether is **instantly dangerous**. Without gravity to straighten it:
- Any residual angular velocity creates spiral loops
- Loops self-intersect → knots form in milliseconds
- Once knotted, applying tension tightens the knot
- A knotted tether cannot be unknotted remotely → arm is lost

The V3 design addresses this with constant-tension PID control on the reel motor ([V3 §5.9](V3%20Octopus.md:593)). V5's crossbow launch creates **new tension challenges** that must be analyzed.

### 19.2 Tension Budget by ARM_STATE

| State | Expected Tension | Source | Risk if Tension Drops |
|---|---|---|---|
| DOCKED | N/A (tether on spool) | — | None |
| LAUNCHING | 0.5–2 N (spool friction) | Free-spool bearing drag | Low (arm moving fast, tether trails) |
| TRANSIT (free) | 0.05–0.5 N | Spool friction + tether inertia | Medium (if arm decelerates suddenly) |
| TRANSIT (braking) | 0.5–50 N | Magnetic clutch | None (actively tensioned) |
| APPROACH | 1–5 N | Reel PID setpoint | High (lateral FEEP creates slack arcs) |
| NETTING | 5–50 N impulse | Net deployment force | Low (brief transient) |
| GRAPPLED | 2–10 N | Reel PID + captured mass | Medium (debris tumble loads) |
| REELING | 2–51 N | Motor tension + acceleration | None (actively tensioned) |
| DOCKING | 5 N | Reel guides arm to cavity | None |
| FISHING | 1–2 N | Reel PID low-tension hold | High (tether length, low activity) |
| TRAWLING | 0.5–2 N | Drag + FEEP thrust | Medium (if arm stops) |
| SCANNING | 2–50 N | Centripetal or brake hold | Low (short duration) |

**Critical states:** APPROACH and FISHING have the highest tangle risk because the arm is maneuvering/stationary with only passive tension.

### 19.3 Gravity Gradient Tension (Natural)

A radially-deployed tether in orbit experiences tidal tension from Earth's gravity gradient:

```
Tidal tension on a tether:
  F_tidal = 3 × n² × m × L
  
  n = orbital rate = √(µ/r³) = √(398600/6771³) = 1.13 × 10⁻³ rad/s
  
  Weaver (11 kg) at 2 km, oriented radially:
    F = 3 × (1.13e-3)² × 11 × 2000 = 3 × 1.277e-6 × 22000 = 0.084 N = 84 mN
    
  Spinner (3.7 kg) at 500 m, radially:
    F = 3 × 1.277e-6 × 3.7 × 500 = 0.0071 N = 7.1 mN
    
  With 500 kg debris on Weaver:
    F = 3 × 1.277e-6 × 511 × 2000 = 3.91 N ← helpful!
```

**Summary:** Gravity gradient provides 7–84 mN of free tension for unloaded arms (insufficient to prevent tangling alone; 1 N minimum needed). But with captured debris (500 kg), tidal tension is ~4 N — naturally sufficient. The reel PID supplements when gravity gradient is insufficient.

### 19.4 Clock-Spring Tensioner (Passive Backup)

Per [V3 §5.9](V3%20Octopus.md:598): a clock-spring tensioner (100 g) in series with each reel provides **guaranteed minimum tension even if the motor fails**:

```
Clock-spring specification:
  Torque: 0.02 N·m constant (flat spring characteristic)
  At 25 mm spool radius: F_min = 0.02/0.025 = 0.8 N
  At 50 mm spool radius: F_min = 0.02/0.050 = 0.4 N
  
  This ensures at least 0.4–0.8 N tension at ALL times,
  even during free-spool (the spring's torque is always present).
  
  During crossbow launch at 10 m/s:
  The clock-spring adds 0.8 N to the free-spool friction (0.05 N).
  Total retarding force: 0.85 N. On 11 kg arm:
  a_retard = 0.85/11 = 0.077 m/s² → negligible impact on launch speed
  (loses 0.077 × 0.04 = 0.003 m/s during 40 ms launch. Irrelevant.)
```

### 19.5 Gameplay Implications

- **Tension is always visible**: HUD shows real-time tension bar for each deployed arm. Never zero.
- **"Slack warning"**: If tension drops below 0.5 N for >2 s, amber alert. Below 0.1 N for >5 s → tangle probability jumps to 10% per second.
- **Gravity gradient bonus**: Arms deployed along the local vertical (radial) get natural tension. Arms deployed along the velocity vector (front/back) do NOT — they rely entirely on reel PID. Different risk profiles.
- **Heavy debris = free tension**: Capturing a 500 kg target means the tether naturally maintains ~4 N tension during return. Lighter targets are higher risk for slack.

---

## 20. Copper-Free GSL Tether — Thickened Ribbon Electrical Architecture

### 20.1 The Copper Problem

V3/V4 tethers carry 2× 30 AWG copper conductors for power, data, and EDT. Copper dominates the practical tether mass:

```
V4 PRACTICAL TETHER MASS BREAKDOWN (2 km Weaver):

  Component                Mass          Fraction
  ───────────────────────────────────────────────
  GSL structural ribbon     0.031 kg       5%
  Copper conductors (2×)    0.400 kg      64%  ← THE PROBLEM
  HBN/Vectran overbraid     0.100 kg      16%
  SMA tendons (100m only)   0.092 kg      15%
  ───────────────────────────────────────────────
  TOTAL                     0.623 kg     100%
  
  At 10 km (GSL-extended Weaver):
  Copper alone = 2.00 kg of 2.75 kg total = 73% OF ALL TETHER MASS.
```

Copper is the legacy component preventing a truly revolutionary tether. The solution is not to accept copper as necessary — it is to **thicken the GSL ribbon until it can carry all electrical functions itself**.

### 20.2 V4's Analytical Error — Overspecified Resistance

[V4 Opussy.md §3.1](V4%20Opussy.md:119) concluded copper was essential by comparing GSL to copper **at copper's resistance level** (~4.4 Ω round-trip). This assumed the electrical system needs low resistance. It doesn't.

```
EDT CIRCUIT ANALYSIS — What resistance can we actually tolerate?

  A tether moving through Earth's magnetic field generates Lorentz EMF:
  V_emf = v × B × L × sin(α)
  
  v = 7,672 m/s (orbital velocity at 400 km)
  B = 30 µT = 3 × 10⁻⁵ T (LEO magnetic field)
  L = 2,000 m (Weaver tether)
  sin(α) = 0.7 (average for 51.6° ISS-like inclination)
  
  V_emf = 7,672 × 3×10⁻⁵ × 2,000 × 0.7 = 322.6 V ← FREE EMF!
  
  EDT target: I = 100 mA → F = I×L×B×sin(α) = 4.2 mN (V3 design point)
  
  Circuit: I = V_emf / (R_tether + R_plasma)
  R_plasma ≈ 100–300 Ω (ionospheric return path)
  
  For 100 mA: R_total = 323 / 0.1 = 3,230 Ω
  R_tether_max = 3,230 - 230 = 3,000 Ω
  
  V3 copper: R = 2.2 Ω. That's 0.07% of the allowable budget!
  
  WE ARE CARRYING 1.83 kg OF COPPER OPERATING AT 0.07% OF ITS CAPACITY.
  This is like using a suspension bridge cable to hang a picture frame.
```

### 20.3 Thickened GSL — The Numbers

**GSL conductivity:**

| State | σ (S/m) | ρ (kg/m³) | σ/ρ (S·m²/kg) | Ratio vs Cu |
|---|---|---|---|---|
| Copper (reference) | 5.96 × 10⁷ | 8,960 | 6,652 | 1× |
| GSL undoped | 1 × 10⁴ | 1,500 | 6.7 | 0.001× |
| GSL lab (current) | 1 × 10⁵ | 1,500 | 66.7 | 0.010× |
| **GSL doped (iodine-intercalated)** | **2 × 10⁶** | **1,500** | **1,333** | **0.200×** |
| GSL target (nitrogen+iodine) | 5 × 10⁶ | 1,500 | 3,333 | 0.500× |
| GSL break-even with Cu | 1 × 10⁷ | 1,500 | 6,667 | 1.000× |

The key metric is **σ/ρ** — conductivity per unit mass. Doped GSL is ~5× worse than copper per kg. But it's simultaneously a 50 GPa structural member — copper adds zero structural strength.

**GSL ribbon sized for EDT (R ≤ 3,000 Ω over 2 km, doped σ = 2 × 10⁶):**

```
Cross-section needed:
  A = L / (σ × R) = 2,000 / (2×10⁶ × 3,000) = 3.33 × 10⁻⁷ m² = 0.333 mm²

At 30 mm width: thickness = 0.333 / 30 = 11.1 µm (~33,000 graphene layers)

Still a FILM. Thinner than a human hair (70 µm). Spools on a small reel.

Mass for 2 km: 1,500 × 3.33×10⁻⁷ × 2,000 = 1.00 kg
Breaking force: 50 GPa × 3.33×10⁻⁷ = 16,650 N → 33× safety factor!

Mass for 10 km: 1,500 × 3.33×10⁻⁷ × 10,000 = 5.00 kg
(vs copper at 10 km: 2.00 kg — GSL is heavier for CONDUCTION alone)
```

### 20.4 Why GSL Still Wins Despite Being Heavier Per Conductance

The naive analysis says "GSL conductor is 2.5× heavier than copper for the same electrical performance." But this ignores what GSL **simultaneously provides**:

```
TOTAL FUNCTIONAL MASS COMPARISON (2 km Weaver tether):

  V4 HYBRID (GSL + Copper):
    GSL structural:    0.031 kg  (holds 500N, does nothing else)
    Cu conductors:     0.400 kg  (EDT + power + data, zero structural)
    Vectran overbraid: 0.100 kg  (abrasion protection)
    SMA tendons:       0.092 kg  (steering, last 100m)
    ─────────────────────────────
    TOTAL:             0.623 kg
    Breaking strength: 500 N (GSL only)
    EDT current:       100 mA
    
  V5 COPPER-FREE (thickened GSL):
    GSL ribbon:        1.000 kg  (EDT + power + data + structure + sensing)
    HBN coating:       0.003 kg  (AO + insulation + abrasion)
    SMA tendons:       0.092 kg  (steering, last 100m)
    ─────────────────────────────
    TOTAL:             1.095 kg
    Breaking strength: 16,650 N (33× safety!)
    EDT current:       100 mA (same)
    
  Mass penalty:   +0.47 kg per 2 km Weaver tether
  
  What +0.47 kg buys:
    ✓ 33× structural safety factor (vs 5× with Cu hybrid)
    ✓ Eliminates Vectran overbraid (HBN replaces, saves 0.10 kg)
    ✓ Single material — no bonding interfaces, no Cu fatigue failure
    ✓ Massively improved MMOD survivability (can lose 97% of cross-section)
    ✓ Manufacturing simplicity (one CVD process, not multi-layer assembly)
    ✓ Future conductivity gains reduce thickness (same cross-section, lighter)
```

**For the full V5 system (3 Weaver 2km + 3 Spinner 500m + 2 F/B Spinner 500m):**

```
Copper-free mass penalty per tether:
  Weaver 2km:  +0.47 kg × 3 = +1.41 kg
  Spinner 500m: Cu saved = 0.10 kg, GSL added = 0.25 kg → +0.15 kg × 5 = +0.75 kg
  
  Total system mass penalty: +2.16 kg
  
  Against V5 arm mass savings (§24.10): -22 kg (from tether/reel move + FEEP)
  Net: still -19.8 kg lighter than V3. Copper-free penalty is trivially absorbed.
```

### 20.5 Power, Data & SMA Through Thickened GSL

**EDT dual-use as power delivery:**

```
The EDT circuit generates power from orbital energy:
  P_emf = V_emf × I = 323V × 0.1A = 32.3 W

  Dissipation: I²R = 0.01 × 3000 = 30 W (tether heating)
  Plasma interface: ~2 W
  
  This 32 W of orbital-kinetic-to-electrical conversion is ALWAYS
  available when EDT is active. The arm can tap into this:
  
  At arm end: modulate load to draw 5 W from EDT current.
  Remaining 25 W dissipated as heat in tether (manageable:
  1W/80m of tether → ~0.012°C rise per meter. Negligible.)
  
  When EDT is inactive: power backup at high-voltage DC.
  400V bus → I = 0.0125A for 5W → V_drop = 37.5V → 91.4% efficiency.
  Requires 20g HV DC-DC converter at arm. ✅ TRL 8
```

**Data via EDT current modulation:**

```
EDT flows at 100 mA steady. Modulate ±5 mA = data signal.
Bandwidth: 9.6 kHz (9600 baud) → trivially within EDT circuit BW.
No additional hardware — same current path carries data.
Receiver: differential current sensor at arm (1g, ✅ TRL 9).

When EDT is off: current-loop signaling at 10 mA, 3,000 Ω →
  P = 0.3 W total. Driven from mother's 600 Wh battery. ✓
```

**SMA tendon heating (last 100 m):**

```
SMA needs 0.5A for 2s per actuation.
GSL R for last 100m at EDT cross-section: R = 100/(2×10⁶ × 3.33×10⁻⁷) = 150 Ω
V_drop = 0.5 × 150 = 75V, P = 37.5W, E = 75J (2s burst)

Arm battery (25 Wh = 90 kJ): 75J = 0.08%. Trivial.
Boost converter (5V → 75V) at arm: ~5g. ✅ TRL 8
```

### 20.6 Copper-Free GSL Tether — Complete Architecture

<!-- V5 AUDIT FIX: G5 — optical fiber added to tether cross-section.
     SM fiber: 125 µm diameter, ~0.2 g/m → 0.4 kg for 2 km, 2.0 kg for 10 km.
     Fiber sits inside the GSL ribbon, protected by the HBN coating. -->
```
V5 COPPER-FREE GSL TETHER — CROSS SECTION

         30 mm wide
  ├──────────────────────┤
  ┌──────────────────────────┐ ─┬─
  │  HBN coating (10 nm)     │  │
  │  ┌──────────────────────┐│  │
  │  │                      ││  │  11.1 µm thick
  │  │  DOPED GSL RIBBON    ││  │  (~33,000 graphene layers)
  │  │  Single monolithic   ││  │
  │  │  material carries:   ││  │  Still thinner than a
  │  │                      ││  │  human hair (70 µm)
  │  │  ✓ 16,650 N struct   ││  │
  │  │  ✓ EDT (100 mA)      ││  │
  │  │  ✓ Power (5-32 W)    ││  │
  │  │  ✓ Data (9.6 kbps)   ││  │
  │  │  ✓ Strain sensing    ││  │
  │  │  ✓ Laser relay       ││  │  (optical fiber — see below)
  │  │                      ││  │
  │  │  ◆ SMA wire pair     ││  │  (last 100m only, embedded)
  │  │  ○ SM fiber (125 µm) ││  │  (continuous, ~0.2 g/m)
  │  │                      ││  │
  │  └──────────────────────┘│  │
  │  HBN coating (10 nm)     │  │
  └──────────────────────────┘ ─┴─

  ZERO copper. ZERO Vectran. ZERO multi-material bonding.
  One ribbon. All eight functions. HBN-coated white.
  
  Optical fiber: single-mode 125 µm silica fiber bonded along ribbon centerline.
  Mass: ~0.2 g/m → 0.4 kg per 2 km tether, 2.0 kg per 10 km tether.
  Carries 10-200 W laser relay for ablation propulsion (§11).
  Protected from AO and UV by HBN coating on both faces.
```

### 20.7 HBN Electrical Insulation — Now Even More Critical

Without copper conductors requiring isolation from the GSL structure, HBN's role shifts:

| Function | With Copper | Copper-Free |
|---|---|---|
| AO protection | ✓ | ✓ (same) |
| Prevent plasma arcing | Isolates Cu from GSL | **Insulates GSL EDT conductor from plasma** |
| UV stability | ✓ | ✓ (same) |
| Controlled current path | Prevents GSL shorting Cu | **Prevents ionospheric plasma from shorting EDT circuit** |
| Electron collection | Bare Al anode section | **Bare GSL section (strip HBN) serves as anode** |

**EDT anode:** At the arm end of the tether, a 1 m section of HBN is stripped off, exposing bare GSL to the ionospheric plasma. This bare section acts as the electron collection anode, closing the EDT circuit. The conductive GSL at ~10⁵–10⁶ S/m is adequate for plasma contact (current density is very low at the collection surface). ✅ Simpler than the V3 separate aluminum anode.

### 20.8 GSL Conductivity Upgrade Path (Gameplay)

As GSL doping technology improves, the tether gets thinner (same electrical performance, less material):

| GSL σ (S/m) | Cross-section (mm²) | Thickness at 30mm (µm) | Mass/2km (kg) | Safety Factor | Game Tier |
|---|---|---|---|---|---|
| 2 × 10⁶ (doped, current) | 0.333 | 11.1 | 1.00 | 33× | T4 Base |
| 5 × 10⁶ (N+I doped) | 0.133 | 4.4 | 0.40 | 13× | T4+ (shop upgrade) |
| 1 × 10⁷ (break-even with Cu/kg) | 0.067 | 2.2 | 0.20 | 6.7× | T5 Research |
| 5 × 10⁷ (approaching Cu σ) | 0.013 | 0.44 | 0.040 | 1.3× | T5+ (endgame) |

**At T5+:** The tether is 0.44 µm thick (~1,300 graphene layers), masses 40g for 2 km, and **still carries full EDT + power + data + structure**. The safety factor drops to 1.3×, but at this thickness multiple parallel ribbons can provide redundancy at negligible mass.

### 20.9 Gameplay Implications

- **Copper is GONE.** The white GSL ribbon is the only tether material in the late game. Clean, simple, futuristic.
- **"All eight functions in one ribbon"** — this is the V5 marketing line. One material does structure + EDT + power + data + sensing + steering + laser relay + AO resistance. Like graphene itself: one atom thick, does everything. <!-- V5 AUDIT FIX: G5 — function count 7→8 with laser relay -->
- **Conductivity upgrades in shop:** Player unlocks better GSL doping → thinner tether at same performance → lighter system → higher ΔV → reach more debris. Ties into the research/salvage economy.
- **HBN visible:** Copper-free GSL tethers are pure WHITE (HBN coating). Visually distinct from early-game Dyneema (translucent) and mid-game hybrid (copper glints).
- **EDT power generation** displayed on HUD: "Tether generating 32 W from orbital energy" — the player sees free power from the laws of physics.
- **Codex revelation:** Early game teaches "you need copper because graphene can't conduct." Mid-game research unlocks "but if you make it thicker, the Lorentz EMF is 323V — you don't need low resistance!" The player's understanding evolves with the technology tree.

---

## 21. Crossbow Value Proposition — Is Mother Redesign Justified?

### 21.1 What Must Change on the Mother

The crossbow system requires these modifications to the V3 mothership bus:

| Modification | Mass Added | Structural Change | Risk |
|---|---|---|---|
| 8× spring mechanisms in cavities | +4.0 kg | Rail grooves + shuttle plates in each cavity | Medium (mechanical) |
| 8× Y-harness fittings | +0.6 kg | Guide channels through cavity walls | Low |
| Enhanced reel clutches (magnetic brake) | +1.6 kg | Replace friction brakes with eddy-current | Low (better hardware) |
| Front arm dock on +Z face | +0.8 kg | New cavity beside laser aperture | Medium (thermal, optical) |
| Back arm dock on -Z face | +0.8 kg | New cavity offset from Hall thrusters | High (plume interaction) |
| 8× ceramic guide tubes | +0.4 kg | Mounting brackets on bus exterior | Low |
| Thruster interlock software | +0 kg | Firmware update to Hall thruster controller | Low |
| Pre-tension trim PID upgrade | +0 kg | Software update to reel controllers | Low |
| **TOTAL** | **+8.2 kg** | | |

### 21.2 What's Lost

- **Simplicity**: V3's FEEP-only approach has zero moving parts on the arm deployment path (once the EPM releases, FEEP takes over). Crossbow adds springs, shuttles, reels, clutches, harnesses — all mechanical, all potential failure points.
- **Mass budget**: +8.2 kg is 3.5% of V3's 237 kg dry mass. Reduces ΔV by ~50 m/s (from the Tsiolkovsky equation).
- **Qualification cost**: Every new mechanism needs vibration testing, thermal-vacuum testing, MMOD survivability analysis. Springs in vacuum need outgassing verification. Estimated +6 months development.

### 21.3 What's Gained

| Benefit | Quantification | Value to Game |
|---|---|---|
| **Real physics** (no multipliers) | Eliminates `ARM_GAMIFIED_THRUST_MULT: 200` | Core identity preserved |
| **Zero-fuel return** | ∞ captures vs 33 ([`WEAVER_CAPTURES_PER_FUEL`](js/core/Constants.js:126)) | 30× more captures possible |
| **8× faster return** | 16 min vs 2.2 hr per capture cycle | Faster gameplay loop |
| **Crossbow identity** | "Space Cowboy fires crossbow" | Iconic mechanic, marketable |
| **Reload tension** | 20–55 s mechanical reload | Creates strategic pacing |
| **New maneuvers** | Forward lasso, rear ablation, pulse scan | 3 new gameplay verbs |
| **8 arms** (vs 6) | +33% capture capacity | More tactical options |
| **Tether upgrade path** | 5-tier progression | Long-term engagement |
| **Physics as gameplay** | Recoil, tension, torque all matter | Deeper simulation |

### 21.4 Verdict: Is It Worth It?

**YES.** The crossbow system:

1. **Solves the core integrity problem.** A simulation game with a ×200 fake physics multiplier at its most visible mechanic is broken at a fundamental level. The crossbow replaces the lie with truth. This alone justifies the redesign.

2. **Creates better gameplay.** The V3 arm loop is: fire → wait → wait → wait → dock. The V5 loop is: aim → fire (thwack) → watch tether brake → FEEP approach → capture → reel in (whirr) → reload (ratchet). Six distinct phases, each with audio/visual identity and player agency.

3. **Enables emergent strategy.** Dual-fire, pulse scan, forward lasso, rear ablation, tether upgrade path, material-specific degradation — these create a strategy layer that V3 doesn't have.

4. **The mass cost is trivial.** +8.2 kg on a 237 kg platform = 3.5%. The ΔV cost (~50 m/s of 2330 m/s budget = 2.1%) is barely noticeable. One fewer orbit change maneuver.

5. **Mechanical risk is manageable.** Springs, reels, and clutches are TRL 9 technology individually. The integration is novel (TRL 5-6), but every component has extensive flight heritage. The risk is **not** "will it work?" but "how long until it needs maintenance?" — and in a game simulation, maintenance IS gameplay.

**The mothership redesign is not "adding complexity for nothing." It is replacing fake physics with real physics, and the real physics happens to create better gameplay.** This is the rare engineering case where doing-it-right is also doing-it-fun.

### 21.5 Gameplay Implications

- **V5 is the "real" version of the game.** V3 → V5 is like Gran Turismo going from arcade handling to simulation handling. The player who understands the physics gets rewarded.
- **First-time player experience**: Crossbow fire feels GOOD. Spring tension. Satisfying release. Visible tether brake. Mechanical reel-in. Every phase has physical feedback.
- **Expert player experience**: Dual-fire zero-recoil. Pre-tension trim for efficiency. Pulse scan for field awareness. Material choice for mission profiles. The depth emerges over dozens of hours.
- **Marketing**: "Every shot is real physics." "The galaxy's first crossbow in space." "Lasso debris with a tethered crossbow." The concept is viscerally understandable and unique.

---

## 22. V3 → V5 Migration Guide

> **⚠️ CONFIG G:** The migration target is now Config G, not Config A/F. Key constant changes differ from those listed below. The authoritative Config G Constants block is in [`ARM_PIVOT_ANALYSIS.md §10.12`](ARM_PIVOT_ANALYSIS.md:1417). Additional changes: `CORE_LENGTH: 2.0` (was 1.2), `CORE_ACROSS_FLATS: 0.8` (was 1.0), `COLLAR_Y: 0.90`, `STRUT_LENGTH: 1.60`, `STRUT_SWEEP_MAX: Math.PI`, new ROSA/HINGE/LAUNCH blocks. `setAimYaw()` → `setAimAlpha()`. See [`ARM_PIVOT_GAPS_EXPLAINER.md §W ST-9.1`](ARM_PIVOT_GAPS_EXPLAINER.md) for ST-9.1 implementation spec.

### 22.1 Constants to Replace

| V3 Constant | Value | V5 Replacement | New Value | Rationale |
|---|---|---|---|---|
| [`ARM_GAMIFIED_THRUST_MULT`](js/core/Constants.js:625) | `200` | `CROSSBOW_LAUNCH_SPEED_DEFAULT` | `10.0` m/s | Spring-derived, not multiplied |
| [`ARM_LAUNCH_SPEED`](js/core/Constants.js:626) | `10.0` | `CROSSBOW_LAUNCH_SPEED_DEFAULT` | `10.0` m/s (same value, now justified) | E = ½mv², spring k = 17.6 kN/m |
| [`ARM_LAUNCH_DURATION`](js/core/Constants.js:627) | `0.5` | `CROSSBOW_RELEASE_TIME` | `0.05` s | Spring release physics |
| [`ARM_DETACH_DURATION`](js/core/Constants.js:192) | `2.0` | `CROSSBOW_UNDOCK_TIME` | `0.3` s | EPM unlatch + spring + clearance |
| [`ARM_HAUL_SPEED`](js/core/Constants.js:201) | `0.0000025` | `REEL_IN_SPEED` | `0.000014` (1.4 m/s loaded, 3.0 m/s unloaded) | Motor reel, not FEEP propulsion — see §6.3 |
| (fuel during haul) | ~2%/s implied | `REEL_IN_FUEL_COST` | `0` | Electrical power, zero propellant |

### 22.2 New Constants (V5 Crossbow System)

```javascript
// === V5 CROSSBOW ARM SYSTEM ===

// --- Crossbow Mechanism ---
CROSSBOW_SPRING_K_WEAVER: 17600,       // N/m spring constant
CROSSBOW_SPRING_K_SPINNER: 5920,       // N/m spring constant  
CROSSBOW_DRAW_DISTANCE: 0.25,          // m (spring compression)
CROSSBOW_RELEASE_TIME: 0.05,           // s (spring release duration)
CROSSBOW_UNDOCK_TIME: 0.3,             // s (total undock incl clearance)
CROSSBOW_LAUNCH_SPEED_DEFAULT: 10.0,   // m/s (at full spring)
CROSSBOW_LAUNCH_SPEED_MIN: 3.0,        // m/s (minimum useful)
CROSSBOW_LAUNCH_SPEED_MAX: 20.0,       // m/s (V5 spring upgrade)
CROSSBOW_LAUNCH_ENERGY_WEAVER: 550,    // J at default speed
CROSSBOW_LAUNCH_ENERGY_SPINNER: 185,   // J at default speed

// --- Reload ---
CROSSBOW_RELOAD_POWER: 15,             // W (motor power for spring compression)
CROSSBOW_RELOAD_TIME_WEAVER: 55,       // s (at 15W motor)
CROSSBOW_RELOAD_TIME_SPINNER: 20,      // s (at 15W motor)
CROSSBOW_RELOAD_EFFICIENCY: 0.70,      // mechanical efficiency

// --- Tether Reel ---
REEL_MASS_PER_UNIT: 1.2,               // kg per reel assembly
REEL_FREE_SPOOL_FRICTION: 0.05,        // N (bearing friction)
REEL_MAX_PAYOUT_SPEED: 20.0,           // m/s
REEL_BRAKE_MAX_FORCE: 50.0,            // N (clutch limit)
REEL_TENSION_NOMINAL: 2.0,             // N (station-keeping)
REEL_TENSION_CRITICAL: 500.0,          // N (snap threshold)
REEL_TANGLE_CHANCE_BASE: 0.001,        // per reel cycle (0.1%)
REEL_TANGLE_CHANCE_COMBAT: 0.005,      // during aggressive maneuvers (0.5%)

// --- Dual-Fire ---
DUAL_FIRE_RCS_COST: 0.187,             // kg N₂ per single Weaver recoil
DUAL_FIRE_RECOIL_V_WEAVER: 0.509,      // m/s mothership recoil (single fire)
DUAL_FIRE_RECOIL_V_SPINNER: 0.171,     // m/s mothership recoil (single fire)

// --- Pulse Scan ---
PULSE_SCAN_COOLDOWN: 300,              // s between scans (5 min)
PULSE_SCAN_DWELL_TIME: 20,             // s at max extension
PULSE_SCAN_TETHER_WEAR: 0.001,         // durability fraction per scan
PULSE_SCAN_POWER_COST: 50,             // Wh per scan cycle

// --- Ablation Propulsion ---
ABLATION_COUPLING: 0.0001,             // N/W (laser ablation coefficient)
ABLATION_POWER_BASE: 10,               // W (through tether fiber)
ABLATION_POWER_UPGRADED: 50,           // W (focused relay)
ABLATION_POWER_MAX: 200,               // W (coherent amplification)

// --- Arm Configuration (Rev 5: Quad-4 Y0 baseline + tech ladder) ---
ARM_COUNT_DEFAULT: 4,                   // Y0 Quad: 2 LD + 2 SD (was 8 in Rev 1)
// ARM_COUNT: 8 → SUPERSEDED by ARM_COUNT_DEFAULT: 4 (Rev 5).
// Full 8-arm (Y3 Octo) unlocked via tech ladder. See §12.5 + §25.
// <!-- V5 AUDIT FIX: C1+C2 — updated to V5 canonical values per §24.10-24.11 -->
V5_FRONT_ARM_MASS: 6.6,                // kg (per Constants.FRONT_ARM_MASS)
V5_BACK_ARM_MASS: 6.6,                 // kg (per Constants.BACK_ARM_MASS)
V5_TOTAL_DRY_MASS_Y0: 198.4,           // kg (Y0 Quad, per §12.5)
V5_TOTAL_WET_MASS_Y0: 244.4,           // kg (Y0 Quad)
V5_TOTAL_DRY_MASS_Y3: 220.3,           // kg (Y3 Octo, per §12.5 / §24.11)
V5_TOTAL_WET_MASS_Y3: 266.3,           // kg (Y3 Octo)
// Tech ladder:
// ARM_LADDER: {
//   Y0_QUAD: { large_daughters: 2, small_daughters: 2, front: 0, back: 0, total: 4 },
//   Y1_HEX:  { large_daughters: 3, small_daughters: 3, front: 0, back: 0, total: 6 },
//   Y3_OCTO: { large_daughters: 3, small_daughters: 3, front: 1, back: 1, total: 8 },
// },
```

### 22.3 ARM_STATES Changes

```javascript
// New states for V5
ARM_STATES: {
  DOCKED: 'DOCKED',
  // UNDOCKING → replaced by LAUNCHING (crossbow release)
  LAUNCHING: 'LAUNCHING',          // NEW: 0.3s spring release
  TRANSIT: 'TRANSIT',              // unchanged (tether braking)
  APPROACH: 'APPROACH',            // unchanged (FEEP fine maneuver)
  NETTING: 'NETTING',             // unchanged
  GRAPPLED: 'GRAPPLED',           // unchanged
  // HAULING → replaced by REELING (tether reel-in)
  REELING: 'REELING',             // NEW: motor reel-in, zero fuel
  RETURNING: 'RETURNING',         // deprecated (reel handles return)
  DOCKING: 'DOCKING',             // unchanged (EPM capture)
  RELOADING: 'RELOADING',         // NEW: spring compression
  FISHING: 'FISHING',              // unchanged
  TRAWLING: 'TRAWLING',           // unchanged
  ABLATING: 'ABLATING',           // NEW: laser ablation on target
  SCANNING: 'SCANNING',           // NEW: pulse scan deployment  
  WEB_SHOT: 'WEB_SHOT',           // unchanged
  DEORBITING: 'DEORBITING',       // unchanged
  EXPENDED: 'EXPENDED',           // unchanged
  TANGLED: 'TANGLED',             // NEW: tether tangle state
},
```

### 22.4 State Machine Flow (V5)

```
V5 ARM STATE MACHINE

                  ┌──────────────────────────────────────────┐
                  │                                          │
                  ▼                                          │
  ┌────────┐  fire  ┌───────────┐  clear  ┌─────────┐      │
  │ DOCKED ├───────►│ LAUNCHING ├────────►│ TRANSIT  │      │
  └───┬────┘  0.3s  └───────────┘         │(braking) │      │
      │                                    └────┬─────┘      │
      │ reload                                  │ arrive     │
      │ complete                                ▼            │
  ┌───┴──────┐                            ┌──────────┐      │
  │RELOADING │                            │ APPROACH │      │
  │ 20-55s   │                            │ (FEEP)   │      │
  └───┬──────┘                            └────┬─────┘      │
      │                                        │ range      │
      │                                        ▼            │
  ┌───┴────┐    reel complete             ┌──────────┐      │
  │DOCKING │◄──────────────────┐          │ NETTING  │      │
  │ (EPM)  │                   │          └────┬─────┘      │
  └────────┘              ┌────┴────┐          │ capture    │
                          │ REELING │          ▼            │
                          │ (motor) │    ┌──────────┐       │
                          │ 0 fuel  │    │ GRAPPLED │       │
                          └─────────┘    └────┬─────┘       │
                               ▲              │ reel cmd    │
                               └──────────────┘             │
                                                            │
  Special states: FISHING, TRAWLING, ABLATING,              │
  SCANNING, WEB_SHOT, DEORBITING, EXPENDED, TANGLED ───────┘
```

### 22.5 Files Requiring Modification

| File | Changes Required |
|---|---|
| [`Constants.js`](js/core/Constants.js) | Add V5 constants, deprecate `ARM_GAMIFIED_THRUST_MULT`, update `ARM_STATES` |
| [`ArmUnit.js`](js/entities/ArmUnit.js) | Replace launch physics, add LAUNCHING/REELING/RELOADING/TANGLED/ABLATING/SCANNING states |
| [`ArmManager.js`](js/entities/ArmManager.js) | Add dual-fire logic, pulse scan coordination, 8-arm management |
| [`PlayerSatellite.js`](js/entities/PlayerSatellite.js) | Recoil physics on crossbow fire, thruster interlock logic |
| [`HUD.js`](js/ui/HUD.js) | Reel tension display, reload progress bar, tangle warning |
| [`StatusPanel.js`](js/ui/hud/StatusPanel.js) | Arm status icons reflect new states (RELOADING, REELING, etc.) |
| [`LassoSystem.js`](js/systems/LassoSystem.js) | Integrate with crossbow launch (lasso uses same spring mechanism) |

---

## 23. System Comparison: Current vs Crossbow

### 23.1 At-a-Glance

| Feature | V3 Current | V5 Crossbow | Δ |
|---|---|---|---|
| **Launch mechanism** | Gamified FEEP (×200 fake) | Spring-loaded crossbow | Real physics |
| **Launch speed** | 10 m/s (arbitrary) | 3–20 m/s (selectable, E=½mv²) | Justified |
| **Launch energy** | Not defined | 550 J (Weaver), 185 J (Spinner) | Traceable |
| **Reload time** | Instant (no mechanic) | 20–55 s (spring compression) | Tension/strategy |
| **Arm count** | 6 (3W + 3S) | 4 at Y0 (2W + 2S); up to 8 at Y3 (3W + 3S + F + B) via tech ladder | Progression |
| **Return method** | FEEP thrust (HAULING) | Tether reel (REELING) | Zero-fuel return |
| **Return fuel cost** | ~3% FEEP per capture | 0% (electrical power) | **∞ captures** |
| **Return speed** | 0.25 m/s (8.7 hr/2km) | 2.0 m/s (16 min/2km) | **8× faster** |
| **Recoil management** | None modeled | RCS compensation / dual-fire | Realistic |
| **Tether reel** | Implied, not detailed | 8 reels, strain gauge, level-wind | Fully specified |
| **Tether material path** | Dyneema → GSL | 5-tier upgrade progression | Gameplay depth |
| **Aiming** | Mother points at target | Hybrid: Spinner gimbal, Weaver aim-mother | Tactical choice |
| **Scan capability** | None | Pulse scan (jellyfish) | New ability |
| **Forward engagement** | Approach from any angle | Fire ahead, tether momentum transfer | Free ΔV |
| **Rear engagement** | Not specialized | Ablation propulsion via laser relay | New mechanic |
| **Tangle risk** | None | 0.1–0.5% per cycle | Risk/reward |
| **Thruster safety** | Not modeled | Interlock + ceramic guide + offset routing | Engineering depth |

### 23.2 Net Impact on Gameplay Loop

**V3 loop:** Aim mother → fire arm (instant, arbitrary) → arm FEEPs to target (slow, expensive) → arm FEEPs back (slow, expensive) → repeat.

**V5 loop:** Choose engagement geometry (front/side/rear) → aim (gimbal or rotate mother) → fire crossbow (visceral *thwack*, real physics) → tether brakes arm → FEEP fine approach (quick, cheap) → capture → reel in (fast, free) → reload crossbow (tension! choose next target during wait) → repeat.

The V5 loop has **more decision points**, each grounded in physics rather than gamified multipliers. The "simulation of real technology" identity is fully intact — every velocity, force, and energy is calc'd from first principles with zero magic numbers.

---

## 24. Senior Engineering Review — Edge Cases, Trades & Operational Limits

This section addresses deep operational questions that arise from treating the crossbow system as flight hardware, not a game mechanic.

### 24.1 Spring Upgrade Path — Upgradeable Component

The crossbow spring pack is **modular and field-replaceable** (at a depot/logistics station). The spring cassette slides into the cavity's spring cradle and locks with a retaining clip. This enables an upgrade progression:

```
SPRING CASSETTE — EXPLODED VIEW

  ┌─────────────────────────┐
  │  RETAINING CLIP (top)   │
  ├─────────────────────────┤
  │  ┌───────────────────┐  │
  │  │ LEAF SPRING PACK  │  │   Interchangeable cassette
  │  │ (3 or 5 leaves)   │  │   Standard mounting interface
  │  │                   │  │   Same draw distance (0.25m)
  │  └───────────────────┘  │   Different k values
  ├─────────────────────────┤
  │  WORM GEAR INTERFACE    │   Mates with cavity motor
  └─────────────────────────┘
```

**Spring upgrade table:**

| Tier | Spring Type | k (N/m) | v_weaver (m/s) | v_spinner (m/s) | Reload Time (15W) | Shop Cost | Unlock |
|---|---|---|---|---|---|---|---|
| **T1 (Start)** | 3-leaf maraging steel | 8,800 | 7.1 | 12.2 | 28 s / 10 s | Free | — |
| **T2** | 5-leaf maraging steel | 17,600 | 10.0 | 17.3 | 55 s / 20 s | 800 Cr | 10 captures |
| **T3** | Titanium torsion bar | 39,600 | 15.0 | 25.9 | 85 s / 30 s | 3,000 Cr | 30 captures |
| **T4** | CFRP composite leaf + Ti | 70,400 | 20.0 | 34.6 | 120 s / 45 s | 10,000 Cr | 75 captures + rare salvage |
| **T5 (V5 Max)** | Nitinol SMA pre-stressed | 110,000 | 25.0 | 43.2 | 180 s / 65 s | 30,000 Cr | 150 captures + GSL research |

**Physics validation for T5:**
```
Energy at T5 (Weaver, 25 m/s): E = ½ × 11 × 625 = 3,437.5 J
Spring: k = 110,000 N/m, d = 0.25 m, E_stored = ½ × 110,000 × 0.0625 = 3,437.5 J ✓
Peak force: 110,000 × 0.25 = 27,500 N = 27.5 kN
Arm acceleration: 27,500 / 11 = 2,500 m/s² ≈ 255 g for 40 ms
→ Arm structure must handle 255 g. DMLS Ti-6Al-4V lattice: tested to
  500 g on CubeSat deployers. ✓

Spinner at T5 (43.2 m/s): E = ½ × 3.7 × 1866 = 3,452 J
→ Spinner net rated for ~15 m/s deployment. At 43 m/s, net fabric
  experiences 9× the dynamic pressure. Dyneema rated to 50 m/s impact.
  GSL net: trivially handles 43 m/s. But T5 spring on Spinner may be
  OVERKILL — no target requires 43 m/s approach speed.
  
T5 primarily benefits Weavers (long-range, heavy captures at 25 m/s).
```

**Benefit of higher launch velocity:** Faster transit to target, longer effective engagement range (arm can brake later), and higher relative closure rate for fast-moving debris.

**Gameplay:** Spring upgrades sit in the shop's "Crossbow" tab alongside tether material upgrades. Each tier is gated by credit cost + capture experience + rare material requirements. T5 requires GSL research unlocked, connecting the two upgrade trees.

### 24.2 Tether Break — Complete Failure Analysis

If the tether breaks (from MMOD, over-tension, fatigue, or AO erosion):

```
TETHER BREAK EVENT TREE

  TETHER SNAPS ────┬─── Break at MOTHER end (near reel)
                   │    → Tether + arm float free
                   │    → Reel retains stub; arm has full tether trailing
                   │    → Arm is now a FREE-FLYER
                   │
                   ├─── Break at ARM end (near Y-junction)
                   │    → Mother retains full tether (reels it in)
                   │    → Arm floats free with just Y-bridle stub
                   │    → Arm is now a FREE-FLYER
                   │
                   └─── Break at MID-SPAN
                        → Mother retains partial tether (reels in stub)
                        → Arm trails partial tether (tangle risk!)
                        → Arm is now a FREE-FLYER with trailing line
```

**Free-flyer consequences:**

```
Arm becomes untethered. Remaining resources:
  FEEP propellant: whatever remains (typically 70-90% if early in mission)
  Battery: 10-25 Wh (Spinner/Weaver)
  Solar: 8-15 W peak (if sun-lit)
  Comms: UHF WSPR beacon (emergency, 1 mW) — detectable at >2 km
  
Arm can:
  1. SELF-RETURN to mother under FEEP power (if enough ΔV)
     - Weaver: 500 m/s budget. At 2 km range, return costs ~1 m/s
     - Easily manageable — arm navigates back using optical nav
     - Re-docks in standard DOCKING sequence (EPM capture)
     - BUT: no crossbow reload possible without tether!
       Arm can only dock, not be reloaded.
       
  2. CONTINUE MISSION as free-flyer (per DETACH mechanic)
     - Existing game mechanic: DETACH_SCORE_MULT: 2.0×
     - Arm operates independently until FEEP depleted
     - High-risk, high-reward untethered captures
     
  3. SELF-DEORBIT (sacrifice)
     - Arm burns all FEEP retrograde
     - DEORBIT_MULTIPLIER_BASE: 1.5× score
     - Arm + any captured debris disposed safely
     
  4. BECOME DEBRIS (worst case)
     - If FEEP depleted AND can't return
     - Arm itself becomes orbital debris
     - Score penalty: DETACH_FAIL_PENALTY: -500
```

**Reel handling after break:** The reel on the mother detects the break via sudden tension drop to zero (strain gauge reads 0 N for >100 ms). Auto-response:
1. Motor stops immediately (prevent reel jam from slack tether)
2. Remaining tether on spool is wound in and secured
3. Reel is **NOT jettisoned** — it's still usable if the arm returns and a new tether is attached (depot operation), or repurposed for another arm
4. The docking cavity remains functional — arm can re-dock (EPM doesn't care about tether state)

### 24.3 Tangle — Cut and Consequences

When a tangle is detected (§14.5), the tether is cut at the **mother end**:

```
TANGLE CUT MECHANISM

  Inside reel housing, adjacent to spool:
  ┌────────────────────────────┐
  │         ╔═══════╗          │
  │  SPOOL  ║TETHER ║──►EXIT  │
  │         ╚═══╤═══╝          │
  │             │               │
  │      ┌──────┴──────┐       │
  │      │  PYRO CUTTER │      │  Explosive bolt cutter (TRL 9)
  │      │  (one-shot)  │      │  Fires on command from OBC
  │      └─────────────┘       │  Severs tether cleanly
  └────────────────────────────┘
  
  Mass: 5g per cutter (pyrotechnic guillotine, Ensign-Bickford heritage)
  Activation: 12V pulse, 10ms
  Reusable: NO (one-shot). Must be replaced at depot.
```

The reel is **NOT jettisoned** — only the tether is severed. The reel housing, motor, and spool remain on the bus. The spool retains whatever tether was wound on it (could be 1.5 km of the 2 km Weaver tether). This retained tether becomes **spare material** — at a depot, it can be spliced to a new arm's harness.

**Tangle + captured debris:** If the arm has captured 500 kg of debris when the tangle occurs, cutting the tether releases the arm+debris as a free-flyer. The 500 kg debris is either:
- Recovered by the arm (FEEP return to mother) — very slow with heavy load
- Sacrificed (arm deorbits with debris) — DEORBIT score but arm lost
- Abandoned (arm drops debris, returns solo) — debris remains in orbit

### 24.4 Tension Synchronization Between Mother and Arm

The mother (reel) and arm (Y-harness attachment) must agree on tension state. There is no "synchronization" — **the tether is passive; all tension control is on the mother side.**

```
TENSION CONTROL ARCHITECTURE:

  MOTHER (active control)          TETHER (passive)        ARM (passive)
  ┌──────────────────┐           ═══════════════        ┌────────────┐
  │ Strain gauge     │ measures                         │ Y-harness  │
  │ Reel motor       │ adjusts     tension              │ (no sensors│
  │ Magnetic clutch  │ brakes      transmitted           │  no motors)│
  │ Clock-spring     │ minimum    ← and forth →         │            │
  │ PID controller   │                                  │  Arm OBC   │
  └──────────────────┘                                  │  knows its │
        │                                               │  own FEEP  │
    Motor adjusts tether                                │  thrust    │
    length/tension based                                └────────────┘
    solely on strain gauge
    readings. No arm input.
```

**The arm has NO tension sensors.** It doesn't need them. The arm simply fires FEEP as needed for navigation. If the tether goes slack (arm moves TOWARD mother faster than reel takes up slack), the clock-spring on the reel provides minimum 0.4 N tension. If tension spikes (arm moves AWAY faster than reel pays out), the magnetic clutch slip-releases.

**Backup system:** If the reel motor fails (stuck motor):
1. **Clock-spring provides minimum tension** (0.4–0.8 N) — passive, always works
2. **Magnetic clutch defaults to FREE-SPOOL** on power loss — tether pays out freely, preventing snap
3. **Arm detects abnormal tension** via indirect sensing: FEEP thrust commands don't produce expected acceleration (tether is holding/dragging) → arm OBC alerts mother via optical link
4. **Manual override**: Player can command emergency reel operations or sever tether

**What the arm CAN sense:** The arm's accelerometer (BMI088 MEMS IMU) detects unexpected acceleration/deceleration caused by tether tension changes. If the arm should be in free-flight but senses a drag force, it infers "tether is under unexpected tension." This is not direct tension measurement but it provides the arm with situational awareness.

### 24.5 Y-Bridle Pivot — 360° Freedom

The Y-junction fitting includes a **full 360° swivel on two axes** (pitch + yaw relative to the tether line). This is implemented as a **gimbal ring joint**:

```
Y-JUNCTION GIMBAL DETAIL

  Tether (from mother)
      │
  ┌───┴───┐
  │OUTER  │  ← Outer ring: rotates 360° around tether axis (roll)
  │ RING  │     Ceramic ball bearing, 5g
  │ ┌───┐ │
  │ │INR│ │  ← Inner ring: pivots ±90° (pitch/yaw)
  │ │   │ │     Two orthogonal pins (gimbal)
  │ └─┬─┘ │
  └───┤───┘
      ├──── Port bridle leg
      └──── Starboard bridle leg
      
  Total deflection freedom:
    Roll:  360° continuous  (arm can spin around tether axis)
    Pitch: ±90° from tether line
    Yaw:   ±90° from tether line
    
  Combined: arm can point in ANY direction within a full hemisphere
  ahead of the tether line, and even ~90° to the side.
```

**Mass:** 45 g (Weaver), 25 g (Spinner) — titanium gimbal ring + ceramic bearings. ✅ TRL 9 (fishing swivels, towed vehicle joints use identical geometry).

**Operational limits:** The arm can maintain tension on the tether **at any angle up to ~85° from the tether line direction**:

```
Off-axis tension analysis:

  Tether tension T = 2 N (nominal station-keeping)
  Arm at angle θ from tether line:
  
  Component along tether: T_axial = T × cos(θ) → keeps tether taut
  Component perpendicular: T_perp = T × sin(θ) → pulls arm off-target
  
  At θ = 30°: T_axial = 1.73 N, T_perp = 1.0 N → tether taut ✓
  At θ = 60°: T_axial = 1.0 N, T_perp = 1.73 N → marginally taut ✓
  At θ = 80°: T_axial = 0.35 N, T_perp = 1.97 N → barely taut ⚠️
  At θ = 85°: T_axial = 0.17 N, T_perp = 1.99 N → SLACK RISK ✗
  
  PRACTICAL LIMIT: Arm can operate up to ±75° off tether line
  while maintaining sufficient axial tension (>0.5 N).
  
  At 2 km range, ±75° means the arm can reach targets within
  a cone of 150° (±75°) centered on the mother-arm radial.
  Lateral coverage at 2 km: 2000 × sin(75°) = ±1,932 m ← nearly
  the full tether length as lateral range!
```

**Maneuvering freedom for debris attachment:** During NETTING/GRAPPLE, the arm needs to orient its net/gripper toward the debris, which may be at any angle relative to the tether. The 360° gimbal swivel means the arm can point its forward face (net) in any direction while the tether pulls from behind. The Y-bridle distributes the tether load to two points, so the arm doesn't pendulum-swing — it holds its orientation under FEEP attitude control while the bridle legs accommodate the tether's pull direction through the gimbal.

### 24.6 Float Time — Low/Zero Tension During Capture

During the critical NETTING and GRAPPLE states, the arm must maneuver freely around the debris with minimal tether interference. How long can the arm "float" with near-zero tension?

```
SAFE FLOAT TIME CALCULATION

  Clock-spring minimum tension: 0.4 N (always present)
  To truly float, the arm must move TOWARD the mother faster
  than the reel takes up slack.
  
  But we DON'T want zero tension — we want LOW tension.
  During capture, reduce PID setpoint to minimum: 0.4 N (clock-spring only).
  
  At 0.4 N on 11 kg Weaver: a = 0.036 m/s² toward mother.
  Arm must use 0.036 m/s² of FEEP thrust to counteract (trivial).
  
  If we command FREE-SPOOL (zero tension, clock-spring only):
    Arm drifts toward target at its own FEEP thrust rate.
    Tether pays out slack at the drift rate.
    Clock-spring maintains 0.4 N → prevents zero-tension tangle.
    
  HOW LONG CAN THIS LAST?
    At 0.4 N tension, reel accumulates slack at rate:
    v_slack = F/m × t = (0.4/11) × t = 0.036t m/s
    Distance of slack: d = ½ × 0.036 × t²
    
    At 60 seconds: d = ½ × 0.036 × 3600 = 64.8 m of slack
    → Reel must take up 65 m of slack when capture completes
    → Takes 65/2 = 33 s at 2 m/s reel speed. Acceptable.
    
    At 120 seconds: d = 259 m of slack. 130 s to recover. Marginal.
    At 300 seconds: d = 1,620 m of slack. → EXCEEDS tether length!
    
  PRACTICAL FLOAT TIME LIMIT: 120 seconds (2 minutes)
  at low tension before slack recovery becomes problematic.
  
  After capture: reel PID setpoint returns to 2 N, motor takes
  up slack over ~30-130 s. Arm is pulled gently back toward the
  radial line while FEEP maintains attitude.
```

**Gameplay:** The NETTING state has a **2-minute timer** — a capture window. If the arm hasn't secured debris in 2 minutes of low-tension float, the reel forces a gentle retensioning that pulls the arm back toward the radial line, potentially breaking the engagement. This creates time pressure during capture sequences.

### 24.7 Aimable Crossbows vs FEEP-Only Aiming — Gimbal Reliability Trade

§8 recommended Hybrid (Spinner gimbal, Weaver fixed). The deeper question: **do we need gimbals at all, or can FEEP handle off-axis maneuvering post-launch?**

```
SCENARIO: Target is 30° off the crossbow axis.

OPTION A — Fixed crossbow, FEEP corrects:
  Crossbow fires along cavity radial axis.
  Arm launches at 10 m/s along this axis.
  FEEP then steers 30° during transit.
  
  Time to steer 30° (Spinner):
    FEEP angular accel: 2.17 mrad/s² (from V3 §6.4)
    Time for 30° (0.524 rad): t = √(2 × 0.524 / 0.00217) = 22 s
    + 22 s to stop rotation = 44 s total
    
  During 44 s, arm travels: 10 m/s × 44 s = 440 m
  → arm is 440 m along the straight line, needs to reach a point
    that's 440 × cos(30°) = 381 m radial, 440 × sin(30°) = 220 m lateral.
  → But arm has only moved 440 m along its launch axis!
  → Lateral deviation from FEEP: ½at² = ½ × (0.5e-3/3.7) × 44² ≈ 0.13 m
  → TOTAL lateral correction in 44s: 0.13 m. Target needs 220 m.
  
  FEEP CANNOT STEER THE ARM 30° IN TIME. The arm overshoots on the
  straight line and FEEP slowly corrects over hundreds of seconds.
  
  Total time to reach a target 1 km away at 30° off-axis:
  ~1000/10 = 100 s transit + unknown correction time.
  FEEP lateral thrust: 0.5 mN / 3.7 = 0.135 mm/s²
  → 220 m lateral at 0.135 mm/s²: t = √(2 × 220/0.000135) = 1805 s ≈ 30 min!
  
  → For any substantial off-axis angle, FEEP correction is FAR too slow.

OPTION B — Mother rotates, then fires fixed crossbow:
  RCS rotates 30° in 3.5 s (per §8.1). Fires. Rotates back.
  Total: ~7 s. Arm launches on correct trajectory.
  Works perfectly. Costs 5.5 g N₂ per aim.
  
OPTION C — Gimbal crossbow aims 30° before firing:
  Servo rotates crossbow to target bearing. Fires. ~0.5 s aim time.
  No RCS cost. No solar panel disruption.
  
VERDICT: FEEP ALONE CANNOT SUBSTITUTE FOR AIMING.
  For off-axis targets beyond ~5°, you MUST either:
  (a) Rotate the mother (Option B), or
  (b) Gimbal the crossbow (Option C).
```

**Gimbal reliability in space:**

| Failure Mode | Frequency | Mitigation | Risk Level |
|---|---|---|---|
| Bearing seizure (cold weld in vacuum) | 1 in 10,000 cycles | Ceramic (Si₃N₄) bearings, no lubricant needed | Very Low |
| Motor failure (stepper) | 1 in 50,000 hours | Redundant winding; if one fails, still functions at reduced range | Low |
| Encoder drift | Continuous, ~0.1°/year | Absolute encoder (no cumulative error); recalibrate monthly | Very Low |
| Radiation damage to driver | At 400 km, ~10 krad/year | Rad-tolerant driver IC (Vorago heritage) | Low |
| MMOD impact on gimbal housing | ~0.01% per year | Housing is inside docking cavity when stowed; exposed only during aim | Very Low |

**Heritage:** Spacecraft antenna gimbals (2-axis, TRL 9) have operated for 15+ years on GEO comms satellites. Camera gimbals on ISS (Canadarm2) have operated in vacuum for 20+ years. The technology is mature.

**Revised recommendation:** Keep the Hybrid approach from §8, but with stronger justification:
- **Spinner gimbals (±30°):** Essential for quick fragment engagement. Mass: 0.3 kg each. Reliability: excellent. 5 units × 0.3 kg = 1.5 kg total.
- **Weaver crossbows: FIXED.** Mother aims via RCS. The 3.5 s aim time is acceptable for large, planned captures. Saves 0.8 kg per gimbal × 3 = 2.4 kg. Eliminates 3 potential mechanical failure points on the highest-value arms.
- **Front/Back arms: FIXED along their axis** (prograde/retrograde). They fire along the velocity vector by design — no aiming needed.

### 24.8 Scanning Revenue — Ground Station Data Bonus

The Pulse Scan (§9) creates a distributed sensor array that produces **scientifically valuable debris field data**:

```
SCAN DATA VALUE CHAIN:

  1. Pulse Scan deploys all arms → distributed LIDAR/optical array
  2. Returns processed onboard:
     - Object count in scan volume
     - Size distribution (resolved to ~0.1m at 100 km)
     - Orbital element estimates for detected objects
     - Tumble rate estimates from time-series returns
  3. Data queued for downlink during next ground station pass
  4. Ground station pays BONUS for survey data:

  SCAN DATA PRICING:

  | Data Type | Value per Object | Volume Bonus | Max per Scan |
  |---|---|---|---|
  | New object detection (<10cm) | 50 Cr | ×1.5 for >20 objects | 2,000 Cr |
  | Orbit determination (TLE) | 100 Cr | ×2.0 for >10 TLEs | 3,000 Cr |
  | Tumble characterization | 75 Cr | — | 750 Cr |
  | Field density map (statistical) | 200 Cr flat | — | 200 Cr |
  | **Total possible per scan** | | | **~5,950 Cr** |
```

**Strategic value:** A single Pulse Scan at GSL tether range (12.5 km) surveys a **sphere of 25 km diameter** — enormous volume. At 400 km altitude, this covers 1/200th of the orbital shell in one scan. Doing 5 scans per orbit × 16 orbits/day = 80 scans/day → maps the entire LEO shell in ~2.5 days.

**Gameplay loop:** Scan → identify high-value targets → plan capture sequence → execute captures in priority order. The scan data ALSO generates revenue, so even "wasting" a turn on scanning pays for itself (5,950 Cr vs ~500 Cr for a fragment capture). Expert players scan first, then capture efficiently.

**Ground station contract:** "Space Situational Awareness (SSA) Contract" — a standing offer that pays for regular survey data. Player can negotiate for higher rates by proving scan quality (more objects, better TLEs). This is **real-world economics**: Space Fence (USAF), LeoLabs, and ExoAnalytic all purchase debris tracking data. The game mirrors reality.

### 24.9 Revolver Configuration — Shared Crossbows vs Dedicated

The user asks: does each arm need its own crossbow, or could a few crossbows be shared (like a revolver cylinder)?

```
REVOLVER CONCEPT — Single crossbow serves multiple arms

     ┌─────────────── REVOLVER TURRET ────────────┐
     │                                             │
     │   ARM 1 ──────────╲                         │
     │   ARM 2 ────────────╲ LOADING               │
     │   ARM 3 ──────────────╲ CAROUSEL             │
     │                         ╲                   │
     │                     [CROSSBOW]               │
     │                        ╱ (single spring)     │
     │   ARM 4 ──────────────╱                     │
     │   ARM 5 ────────────╱                       │
     │   ARM 6 ──────────╱                         │
     └─────────────────────────────────────────────┘
     
  Pros:
  - 1 spring instead of 6-8 → save ~3.5 kg (7 × 0.5 kg)
  - 1 reload motor instead of 8 → save ~1 kg
  - Simpler maintenance (one mechanism to inspect)
  
  Cons:
  ✗ SINGLE POINT OF FAILURE — if the crossbow jams, ALL arms are grounded
  ✗ Carousel mechanism adds mass (~2 kg) and complexity
  ✗ Sequential firing only — no dual-fire capability
  ✗ Arm must be loaded into crossbow before firing = extra time (~5 s)
  ✗ Carousel must handle both Weaver (11 kg) and Spinner (3.7 kg) —
    variable mass requires spring force adjustment
  ✗ Arms not in the crossbow are just sitting in their cavities —
    they need their OWN retention mechanism anyway (EPM at minimum)
  ✗ Structural redesign: the carousel needs a clear firing line in
    EVERY direction → conflicts with solar panels, thrusters, sensors
  ✗ Pulse Scan (all arms fire simultaneously) is IMPOSSIBLE with 1 crossbow
```

**Verdict: Dedicated crossbow per arm is superior.**

The mass savings of a revolver (~4.5 kg) are offset by:
- Carousel mechanism (~2 kg) = net saving only ~2.5 kg
- Single-point failure eliminates ALL arm deployment capability
- Cannot dual-fire (eliminates recoil cancellation)
- Cannot Pulse Scan (eliminates a major capability)
- Loading time adds 5 s per arm deployment
- Structural complexity of a universal firing platform is worse than 8 simple springs in existing cavities

The existing cavity design already HAS the spring mount point. Adding a spring to each cavity is **less mass and complexity** than building a shared carousel.

**However:** A **2-crossbow variant** has some merit for a smaller bus:
- 1 port crossbow + 1 starboard crossbow, each serving 3-4 arms on their side
- Each can fire independently → dual-fire possible (port+starboard)
- If one jams, only half the arms are affected
- But: still requires arm loading carousel per side
- **Verdict: not worth it for V5. Consider for future V6 miniaturized platform.**

### 24.10 Does the Crossbow Allow Lighter Arms?

**YES — significantly.** This is one of the crossbow's most important secondary benefits.

In V3, each arm carries enough FEEP propellant for the **entire mission cycle** including transit out, maneuvering, AND return transit. With the crossbow + reel:

```
Arm mass savings from crossbow system:

  TRANSIT OUT: Now handled by crossbow spring.
    FEEP fuel saved: launch ΔV × arm mass / (Isp × g₀)
    At 10 m/s launch, 11 kg Weaver: Δm = 11 × 10 / (6000 × 9.81) = 0.0019 kg per launch
    Over 33 launches: 0.063 kg. Small — FEEP is very efficient.
    
  RETURN TRANSIT: Now handled by reel.
    FEEP fuel saved: 0.5 m/s ΔV × (11 + debris mass) / (Isp × g₀)
    With 100 kg average debris: Δm = 111 × 0.5 / (6000 × 9.81) = 0.00094 kg per return
    Over 33 returns: 0.031 kg. Also small in absolute terms.
    
  BUT: the FEEP SYSTEM ITSELF can be downsized!
  
  V3 Weaver FEEP (Enpulsion NANO R3):
    Total mass per unit: 1.38 kg (dry + propellant)
    Total impulse: 5,500 Ns
    Redundant pair: 2 × 1.38 = 2.76 kg
    
  V5 Weaver — FEEP only needs to cover APPROACH maneuvering:
    Typical approach ΔV: ~2 m/s (lateral corrections over 500 m)
    Captures before FEEP depletion: 500 m/s budget / 2 m/s per capture = 250 captures
    → We only need 1/7th the FEEP budget (250 vs theoretical maximum 33 in V3)
    
    Smaller FEEP thruster: Enpulsion IFM Nano SE (Spinner's current thruster)
      Mass: 0.67 kg (single unit)
      Total impulse: 1,100 Ns → 1,100/(11×9.81) = 10.2 m/s per kg →
      ΔV for 11 kg arm: 100 m/s → 50 captures at 2 m/s each
      
    Swap redundant NANO R3 pair (2.76 kg) for single IFM Nano SE (0.67 kg):
    SAVINGS: 2.76 - 0.67 = 2.09 kg PER WEAVER ← significant!
    
    Keep one NANO R3 as backup: 1.38 + 0.67 = 2.05 kg.
    Still saves 0.71 kg vs V3's 2.76 kg.

  V5 Spinner — already uses IFM Nano SE, minimal savings from downsizing.
  But can drop to a single unit (no redundancy for expendable arm):
    Savings: 0.67 kg per Spinner.
```

**Revised arm mass with crossbow system:**

| Component | V3 Weaver | V5 Weaver | Delta |
|---|---|---|---|
| FEEP propulsion | 2.76 kg (2× NANO R3) | 2.05 kg (1× NANO R3 + 1× IFM Nano SE) | **-0.71 kg** |
| Tether reel | 0.80 kg (on arm) | **0 kg** (reel on mother!) | **-0.80 kg** |
| Tether (on arm spool) | 2.50 kg | **0 kg** (on mother spool!) | **-2.50 kg** |
| Y-harness | 0 kg | +0.08 kg | +0.08 kg |
| Crossbow spring | 0 kg | **0 kg** (spring on mother!) | 0 |
| **Net change** | **11.0 kg** | **~7.0 kg** | **-4.0 kg (36% lighter!)** |

Wait — the V3 arm mass already **includes** tether and tether reel in the arm total per [V3 §9.2](V3%20Octopus.md:1008). Let me verify:

```
V3 Weaver mass breakdown (from V3 §9.2):
  Structure: 2,000g
  Propulsion (2× FEEP): 2,760g
  Power/comms/nav: ~780g
  Tether: 2,500g              ← INCLUDED in arm mass
  Tether reel: 800g           ← INCLUDED in arm mass
  Capture systems: ~1,435g
  Docking/thermal: ~165g
  EDT: 50g
  TOTAL: 10,961g ≈ 11.0 kg
```

**In V5:** The tether (2,500g) and reel (800g) move to the MOTHER. The arm no longer carries them. The arm mass drops dramatically:

| V5 Weaver Mass Budget | Mass (g) |
|---|---|
| Structure | 2,000 |
| Propulsion (1× NANO R3 + 1× IFM Nano SE) | 2,050 |
| Power/comms/nav | 780 |
| **Tether** | **0** (on mother) |
| **Tether reel** | **0** (on mother) |
| Y-harness + junction | 80 |
| Capture systems | 1,435 |
| Docking/thermal | 165 |
| EDT cathode | 50 |
| **V5 Weaver total** | **~6,560g ≈ 6.6 kg** |

**The V5 Weaver is 40% lighter than V3!** This means:
- Same spring → **higher launch velocity**: v = √(2E/m) = √(2×550/6.6) = **12.9 m/s** (vs 10 m/s)
- Or: weaker spring → same velocity + faster reload
- Or: keep 10 m/s → spring energy only 330 J → reload in 31 s (vs 55 s)

**Similarly for Spinner:**

| V5 Spinner Mass Budget | Mass (g) |
|---|---|
| Structure | 400 |
| Propulsion (1× IFM Nano SE, no redundancy) | 670 |
| Power/comms/nav | 354 |
| **Tether** | **0** (on mother) |
| **Tether reel** | **0** (on mother) |
| Y-harness + junction | 45 |
| Capture systems | 465 |
| Docking/thermal | 96 |
| EDT cathode | 30 |
| **V5 Spinner total** | **~2,060g ≈ 2.1 kg** |

V3 Spinner was 3.7 kg → V5 Spinner is 2.1 kg = **43% lighter!**

**This is a transformative result.** Lighter arms mean faster launches, lower recoil, less RCS compensation, and the ability to carry MORE arms for the same mass budget.

### 24.11 Updated V5 System Mass Budget (With Lighter Arms)

| Component | Count | V3 Mass | V5 Mass | Delta |
|---|---|---|---|---|
| Core dry (+ 8 reels + 8 springs + guides) | 1 | 170.0 kg | 178.2 kg | +8.2 kg |
| Core propellant (Xe + N₂) | — | 46.0 kg | 46.0 kg | 0 |
| Weaver arms | 3 | 33.0 kg (11.0 ea) | 19.8 kg (6.6 ea) | **-13.2 kg** |
| Spinner arms (body ring) | 3 | 11.1 kg (3.7 ea) | 6.3 kg (2.1 ea) | **-4.8 kg** |
| Front arm (Spinner+laser) | 1 | — | 2.4 kg | +2.4 kg |
| Back arm (Spinner+laser) | 1 | — | 2.4 kg | +2.4 kg |
| Tethers (on mother spools) | 8 | (in arm mass) | 11.2 kg* | (moved) |
| **Total wet** | | **260.1 kg** | **266.3 kg** | **+6.2 kg** |
| **Total dry** | | **214.1 kg** | **220.3 kg** | **+6.2 kg** |

*Tethers: 3×2.5kg (Weaver 2km) + 3×0.7kg (Spinner 500m) + 2×0.7kg (F/B 500m) = 11.2 kg — previously counted in arm mass, now on mother spools.

**Net result:** V5 is only **+6.2 kg** heavier than V3 for: 2 extra arms, crossbow mechanisms, 8 enhanced reels, Y-harnesses, ceramic guides, AND fundamentally real physics. The arm mass reduction from moving tether/reel to mother nearly pays for all the additions.

**ΔV impact:** 266.3 kg wet, 220.3 kg dry, 40 kg Xe, Isp 1500 s:
ΔV = 1500 × 9.81 × ln(266.3/220.3) = 1500 × 9.81 × 0.189 = **2,782 m/s**

V3: 2,330 m/s. **V5 actually has MORE ΔV (+452 m/s)** because the dry mass is much lighter per arm despite the heavier core. The arm mass savings dominate.

### 24.12 Gameplay Implications

- **Spring upgrade tree**: 5 tiers from T1 (7.1 m/s) to T5 (25 m/s). Each tier costs more credits and takes longer to reload. Connects to tether material tree (T5 spring + GSL tether = ultimate kit).
- **Tether break**: Not game-over. Arm becomes free-flyer (existing DETACH mechanic). Reel stays on bus. Player chooses: recover arm, sacrifice, or abandon.
- **Tangle cut**: Pyro cutter severs at mother. One-shot — must replace at depot. Arm goes free.
- **Float timer**: 2-minute capture window during NETTING. Creates urgency. If miss, reel retensions and arm must re-approach.
- **Lighter arms**: Faster, more responsive. Player "feels" the lighter mass in snappier crossbow launches and quicker FEEP steering. The crossbow didn't just change the physics — it made the arms better.
- **Scan-for-credits**: Pulse Scan generates real revenue from ground station SSA contracts. Scanning IS gameplay, not just reconnaissance.
- **No revolver**: Each arm has its own crossbow. Simple, reliable, enables Pulse Scan simultaneous fire.

---

## 25. Arm-Count Tech Ladder (Rev 5 → Config G)

> *Added 2026-04-26 — Rev 5 design pivot. Replaces the single 8-arm default with a linear progression.*
>
> **⚠️ CONFIG G update (2026-04-27):** Arm-count ladder unchanged (Y0 Quad → Y1 Hex → Y3 Octo). But the mount geometry is Config G barrel-axial, not equatorial. **§25.4 strut DOF is superseded:** Config G uses 0–180° meridian sweep via `setAimAlpha(alpha)`, NOT ±30° yaw via `setAimYaw(yaw)`. §25.2 mass numbers superseded by Config G values (Y0: 196.4/242.4). See [`ARM_PIVOT_ANALYSIS.md §10.11`](ARM_PIVOT_ANALYSIS.md:1236).

### 25.1 Rationale

The OCTOPUS name becomes **aspirational** — the player starts with 4 arms (Y0 Quad) and earns the full 8-arm form (Y3 Octo) through tech progression. This mirrors real-world spacecraft bus development: start simple, prove the design, then add capability.

**Pair-fire balance at each tier:**
- **Y0 Quad (4):** 2 antipodal pairs (LD-LD, SD-SD) — clean recoil cancellation
- **Y1 Hex (6):** 3 antipodal pairs — same scheme, more capacity
- **Y3 Octo (8):** 3 ring pairs + F/B pair — 4 total antipodal pairs

### 25.2 Ladder Definition

| Tier | In-Game Year | Daughters | Large Daughters | Small Daughters | Front | Back | Total Arms | Dry Mass | Wet Mass | Unlock |
|------|-------------|-----------|-----------------|-----------------|-------|------|------------|----------|----------|--------|
| **Y0 Quad** | Start | 4 | 2 | 2 | 0 | 0 | 4 | 198.4 kg | 244.4 kg | Free (game start) |
| **Y1 Hex** | ~30 hr | 6 | 3 | 3 | 0 | 0 | 6 | 207.1 kg | 253.1 kg | Shipyard refit + Y1 tech credits |
| **Y3 Octo** | ~300 hr | 8 | 3 | 3 | 1 | 1 | 8 | 220.3 kg | 266.3 kg | Shipyard refit + Y3 tech credits + ablation module prereq |

### 25.3 Constants Mapping

```javascript
// In Constants.OCTOPUS_V5:
ARM_COUNT: 4,                    // Y0 baseline (was 8 in Rev 1)
LARGE_DAUGHTER_COUNT: 2,         // Y0
SMALL_DAUGHTER_COUNT: 2,         // Y0
FRONT_ARM_COUNT: 0,              // Y3 unlock
BACK_ARM_COUNT: 0,               // Y3 unlock
TOTAL_DRY_MASS: 198.4,           // Y0 recomputed
TOTAL_WET_MASS: 244.4,           // Y0 recomputed

// New tech-ladder block:
ARM_LADDER: {
    Y0_QUAD: { large_daughters: 2, small_daughters: 2, front: 0, back: 0, total: 4 },
    Y1_HEX:  { large_daughters: 3, small_daughters: 3, front: 0, back: 0, total: 6 },
    Y3_OCTO: { large_daughters: 3, small_daughters: 3, front: 1, back: 1, total: 8 },
},
```

### 25.4 Strut DOF — 1-DOF Yaw Only (Rev 5)

> *2-DOF (pitch + yaw) was considered Rev 1; reduced to 1-DOF (yaw only) Rev 2 (2026-04-26) for vacuum reliability + planar tether departure. See [`CAPTURE_NET.md`](CAPTURE_NET.md) §4 tangle analysis.*

Each daughter is mounted on a **short strut** (0.3–0.5 m) extending radially from one of the Mother's octagonal bus faces:
- **Yaw pivot** (±30°) — single rotary joint at the **strut-bus junction** (where the strut base meets the octagonal bus face). **Pivot axis = bus face normal** (the radial direction from bus centre through the dock point). The daughter sweeps ±30° within the **dock-tangent plane** — the plane perpendicular to the face normal at the dock location. Tether always exits in this plane; it cannot pitch out-of-plane toward solar panels or FEEP plumes.
- ~~**Pitch pivot** (±90° from bus-radial)~~ — **DROPPED Rev 5.** Off-axis targeting handled by whole-platform attitude rotation (existing FEEP/RCS).

Constants:
```javascript
CROSSBOW_AIM_YAW_MAX:   30 * Math.PI / 180,   // ±30° (kept)
CROSSBOW_AIM_RATE:      60 * Math.PI / 180,   // rad/s (kept)
// CROSSBOW_AIM_CONE_PITCH_MAX → REMOVED (Rev 5)
```

**Engineering rationale for 1-DOF:**
1. Halves actuator count (4 vs 8 at Y0; 8 vs 16 at Y3) → fewer vacuum failure points
2. Tether always exits in the dock-tangent plane → deterministic; bridle math becomes 2D
3. Plume-clearance is a planar cone test (simpler than 3D frustum check)
4. Tangle scenarios drop in count and probability (see [`CAPTURE_NET.md §4`](CAPTURE_NET.md))
5. Simpler player UI: single yaw dial vs 2-axis aim widget

**API:** `ArmUnit.setAimYaw(yaw)` instead of `setAimYawPitch(yaw, pitch)`.

### 25.5 Gameplay Implications

- **"Earn your arms"**: The Octopus name is aspirational at Y0 — HOUSTON announces *"Octopus-class is fully operational"* on Y3 unlock.
- **Cost curve**: Each tier requires docking at a Shipyard + credits + a "refit" mission. Not free choices — earned progression.
- **Recoil balance**: All tiers maintain clean antipodal-pair geometry for dual-fire recoil cancellation.
- **1-DOF simplicity**: Single yaw dial in ARM PILOT mode. Players learn one axis, not two. Platform rotation handles the rest.

---

## Appendix A: Crossbow Energy Table

Quick reference for spring energy and velocity at various configurations:

| Arm Type | Mass (kg) | Spring k (N/m) | Draw (m) | Energy (J) | v (m/s) | Momentum (kg·m/s) | Mother Recoil (m/s) |
|---|---|---|---|---|---|---|---|
| Weaver (low) | 11.0 | 4,400 | 0.25 | 137.5 | 5.0 | 55.0 | 0.255 |
| Weaver (default) | 11.0 | 17,600 | 0.25 | 550.0 | 10.0 | 110.0 | 0.509 |
| Weaver (high) | 11.0 | 39,600 | 0.25 | 1,237.5 | 15.0 | 165.0 | 0.764 |
| Weaver (max) | 11.0 | 70,400 | 0.25 | 2,200.0 | 20.0 | 220.0 | 1.019 |
| Spinner (low) | 3.7 | 1,480 | 0.25 | 46.3 | 5.0 | 18.5 | 0.086 |
| Spinner (default) | 3.7 | 5,920 | 0.25 | 185.0 | 10.0 | 37.0 | 0.171 |
| Spinner (high) | 3.7 | 13,320 | 0.25 | 416.3 | 15.0 | 55.5 | 0.257 |
| Spinner (max) | 3.7 | 23,680 | 0.25 | 740.0 | 20.0 | 74.0 | 0.343 |

## Appendix B: Tether Braking Profiles

| Scenario | Mass (kg) | v₀ (m/s) | Brake dist (m) | Decel (m/s²) | Brake force (N) | Duration (s) | % of 500N limit |
|---|---|---|---|---|---|---|---|
| Weaver → 1.5 km | 11.0 | 10 | 1000 | 0.050 | 0.55 | 190 | 0.11% |
| Weaver → 500 m | 11.0 | 10 | 300 | 0.167 | 1.83 | 57 | 0.37% |
| Spinner → 400 m | 3.7 | 10 | 300 | 0.166 | 0.62 | 57 | 0.12% |
| Weaver → 1.5 km (fast) | 11.0 | 15 | 1000 | 0.112 | 1.23 | 130 | 0.25% |
| Emergency stop (Weaver) | 11.0 | 10 | 50 | 1.000 | 11.0 | 9.5 | 2.2% |
| Emergency stop (loaded) | 511.0 | 2 | 50 | 0.040 | 20.4 | 47.5 | 4.1% |

All scenarios are well within the 500 N tether strength — the crossbow launch forces are gentle compared to the tether's capacity.

## Appendix C: Real-World Spring Deployer Heritage

| System | Organization | Mass Ejected | Velocity | Spring Type | TRL |
|---|---|---|---|---|---|
| P-POD | Cal Poly | 1.3 kg | 1.5–2.0 m/s | Kangaroo spring | 9 |
| ISIPOD | ISISpace | 1.3 kg | 0.5–2.5 m/s | Compression spring | 9 |
| Lightband | PSC | 1–300 kg | 0.3–1.5 m/s | Clamp band + spring | 9 |
| ESPA ring | Moog | up to 180 kg | 0.5–1.0 m/s | Spring plungers | 9 |
| RemoveDEBRIS net | SSTL | 0.6 kg (net) | ~5 m/s | Compressed gas | 7 |
| V5 Crossbow (Weaver) | Space Cowboy | 11.0 kg | 5–20 m/s | Leaf spring pack | 6* |

*TRL 6 estimated — individual components are TRL 9, but the integrated crossbow+reel+tether system as designed here has not been flight-demonstrated as a unit.*
