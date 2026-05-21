# Capture Net — Spinning Mesh Capture System Design

> **Rev 6 — 2026-04-27 — Config G barrel-axial geometry adopted.**
> Arms now mount at top-collar (Y=+0.9m) with 0–180° meridian sweep (not ±30° equatorial yaw).
> Tether reel moved to strut tip. Net departures follow meridian planes (60°/120°/240°/300°),
> not equatorial plane. Tangle model §4 updated for meridian-plane geometry.
> Config G mass: Y0 dry=196.4 kg, wet=242.4 kg (was 198.4/244.4).
> See [`ARM_PIVOT_ANALYSIS.md §10`](ARM_PIVOT_ANALYSIS.md:801) for Config G locked spec.
>
> **Rev 5 — 2026-04-26 — 1-DOF strut adopted; Quad-4 Y0 baseline; tech ladder.**
> Strut reduced from 2-DOF (pitch+yaw) to 1-DOF (yaw only, dock-tangent plane). Tether exit is now deterministic in-plane.
> Arm count baseline changed from 8 to 4 (Y0 Quad: 2 Large Daughters + 2 Small Daughters).
> Tech ladder: Y0 Quad → Y1 Hex → Y3 Octo (unlocked via Shipyard refit + tech credits).
> Mother retains 2 body-mounted Large Net pods at all tiers. See §6 per-platform table.
>
> **Rev 4 — 2026-04-26 — Folded QA decisions; §10 closed; mercy rule adopted.**
> All 12 open questions from Rev 3 resolved. See [`CAPTURE_NET_QA.md`](CAPTURE_NET_QA.md) for analysis history.
> SMA cinch replaced with spring-loaded hub (Q-1). Material naming → Graphene-N (Q-8).
> Net class names → Large / Medium / Small (Q-9). First-fragmentation mercy rule adopted (§5.7).

> **Peer document to** [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md). All physics derived from first principles — no magic numbers.
> Replaces the "Lasso" / "Bolas" terminology from prior iterations.
> Implementation tracked as **ST-9.4** in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).
>
> **Current code:** [`LassoSystem.js`](js/systems/LassoSystem.js:1) (1,094 LOC). Constants: [`NET_*`](js/core/Constants.js:854), [`LASSO_*`](js/core/Constants.js:838), [`BOLAS_*`](js/core/Constants.js:876) (legacy aliases).
> **Feature flags:** `FEATURE_FLAGS.NET_TERMINOLOGY` (renamed from `BOLA_RENAME`), `NET_PRIMARY_DOCTRINE`, `NET_CLING_MODEL`, `NET_TANGLE_MECHANICS`, `PER_PLATFORM_NETS`.
>
> Created: 2026-04-26. Status: Design complete, pending implementation.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Physical Model](#2-physical-model)
3. [Cling Mechanism](#3-cling-mechanism)
4. [Tangle Mechanics](#4-tangle-mechanics)
5. [Fragmentation Prevention](#5-fragmentation-prevention)
6. [Per-Platform Net Classes](#6-per-platform-net-classes)
7. [Failure / Edge Cases](#7-failure--edge-cases)
8. [Visual / Audio Cues](#8-visual--audio-cues)
9. [Codex Entry Text](#9-codex-entry-text)
10. [Resolved Questions](#10-resolved-questions)

---

## §1 Executive Summary

The **Capture Net** is the game's primary debris-capture tool — a rotating-open mesh of Dyneema SK78 cord fired from a crossbow rail on a tether, designed to wrap and secure uncooperative orbital debris. It replaces the prior "Lasso" and "Bolas" terminology, which were misnomers: a lasso is a rigid loop requiring atmosphere-dependent aerodynamics to stay open; a bola is a set of weighted cords that entangle limbs — neither describes a spinning mesh disc that wraps arbitrary rigid geometry in vacuum. The Capture Net works *because* there is no air resistance: once spun up, the mesh disc stays open indefinitely via centripetal force from rim weights, with zero drag losses. Spin-open mesh capture is the only TRL ≥7 method for grasping uncooperative legacy debris of arbitrary shape (RemoveDEBRIS 2018 flight demo, Surrey/SSTL).

Two capture modes serve different target types:
- **Slam-wrap** (simple debris) — net hits target, spin momentum wraps mesh around it, Velcro cling holds. Fast, reliable for durable metal fragments and rocket bodies.
- **Tether-brake cinch** (delicate/frangible debris) — as the net approaches the target, the reel brakes the tether; the net's centre decelerates while the rim weights carry forward on momentum, sweeping around the debris like a purse seine closing. A drawstring cinch (spring-loaded hub with solenoid pin-pull) seals the bag behind the target. Zero crushing force — the debris sits inside a closed bag, not pressed against a spinning disc. This is how you catch a satellite with intact solar panels.

The rim weights are not passive tungsten — they are **edge nodes** carrying spring-loaded cinch mechanisms (Y0), with camera/radio upgrades in later years. The mesh material upgrades from Dyneema SK78 (3.6 GPa, Y0) through graphene-enhanced tiers up to 130 GPa (Y4), enabling more nets per magazine pack and longer range at each tier. Nets are carried in **reloadable magazine packs** slotted into crossbow rails, resupplied via drone delivery, depot rendezvous, or scavenging derelict platforms.

> *SMA (shape-memory alloy) cinch actuation was considered and rejected at design Rev 4 — the thermal budget is fundamentally broken in eclipse conditions (−150 °C). Spring-loaded hub with solenoid pin-pull is TRL 9, temperature-independent, and fires in <100 ms. See [`CAPTURE_NET_QA.md`](CAPTURE_NET_QA.md) Q-1 for full analysis.*

Every platform in the fleet — Mother, Large Daughter (Weaver), and Small Daughter (Spinner) — carries a net class sized to its target envelope. The net is the game's starting capture tool, available from mission 1, requiring no unlocks. TRL 9 — just Dyneema and tungsten and a spring.

**Player-facing net class names:** Large Net (Mother), Medium Net (Large Daughter), Small Net (Small Daughter). Internal code retains M-NET / LD-NET / SD-NET prefixes.

---

## §2 Physical Model

### §2.1 Geometry

The deployed net forms a **shallow cone** of woven Dyneema SK78 mesh, kept open by centripetal force acting on **rim weights** (tungsten alloy spheres) distributed evenly around the perimeter. The mesh topology is octagonal with cross-bracing diameters:

| Parameter | Symbol | Large Net | Medium Net | Small Net | Unit |
|-----------|--------|-----------|------------|-----------|------|
| Mesh diameter (deployed) | D_mesh | 8.0 | 5.0 | 1.5 | m |
| Rim weight count | N_w | 8 | 4 | 4 | — |
| Rim weight mass (each) | m_w | 75 | 50 | 15 | g |
| Total rim weight mass | M_rim | 600 | 200 | 60 | g |
| Mesh cord diameter | d_cord | 1.5 | 1.0 | 0.5 | mm |
| Mesh aperture (hole size) | a_mesh | 50 | 30 | 10 | mm |
| Cone half-angle (deployed) | θ_cone | 15 | 12 | 10 | ° |
| Octagonal segments | N_seg | 8 | 8 | 8 | — |
| Cross-mesh diameters | N_cross | 4 | 4 | 4 | — |

*(Internal code names: Large Net = M-NET, Medium Net = LD-NET, Small Net = SD-NET)*

Current code constants (apply to what will become Medium Net): [`NET_WEIGHT_COUNT: 4`](js/core/Constants.js:855), [`NET_PERIMETER_RADIUS: 4`](js/core/Constants.js:857) (metres, ≈Medium Net radius), [`NET_SEGMENTS: 8`](js/core/Constants.js:858), [`NET_CROSS_LINES: 4`](js/core/Constants.js:859).

The mesh is **not flat** — it forms a shallow cone because the tether attachment is at the apex (centre), pulling the centre aft relative to the spinning rim. This geometry is desirable: the cone funnels around convex debris on contact rather than bouncing off.

### §2.2 Tether

The net is attached at its centre apex to a **Dyneema SK78** tether that pays out from the launching platform's reel.

| Property | Value | Source |
|----------|-------|--------|
| Material | Dyneema SK78 (UHMWPE) | Y0 baseline, TRL 9 |
| Linear density | 1.2 kg/km | [`TETHER_LINEAR_DENSITY`](js/core/Constants.js:160) |
| Tensile strength | 500 N (5× safety margin) | [`TETHER_TENSILE_STRENGTH`](js/core/Constants.js:161) |
| Width | 3 mm ribbon | [`TETHER_WIDTH`](js/core/Constants.js:162) |
| Thickness | 0.1 mm | [`TETHER_THICKNESS`](js/core/Constants.js:163) |
| Max length (Mother) | 500 m | Net-specific; shorter than arm tether |
| Max length (Large Daughter) | 200 m | Subset of Weaver's 2 km arm tether |
| Max length (Small Daughter) | 100 m | Subset of Spinner's 500 m arm tether |

Reel-cycle wear is shared with **ST-9.5** (Dyneema tether + reel-cycle resource). Each deploy/reel cycle contributes 1 wear unit toward the 20-cycle replacement threshold — see [`ResourceSystem`](js/systems/ResourceSystem.js:1).

### §2.3 Mass Budget

| Component | Large Net | Medium Net | Small Net | Unit |
|-----------|-----------|------------|-----------|------|
| Mesh (Dyneema) | 1200 | 400 | 40 | g |
| Rim weights (tungsten) | 600 | 200 | 60 | g |
| Hub/swivel | 150 | 80 | 20 | g |
| Tether (per 100 m) | 120 | 120 | 120 | g |
| **Total (net only)** | **1950** | **680** | **120** | **g** |
| **Total (net + 100 m tether)** | **2070** | **800** | **240** | **g** |

Current code: [`LASSO_PROJECTILE_MASS: 2.5`](js/core/Constants.js:851) kg — this maps to Large Net (≈2.07 kg net + hub + partial tether).

### §2.4 Launch Sequence

The full capture cycle has 8 phases, with **Phase 5 branching** based on target fragility:

| # | Phase | Duration | Description |
|---|-------|----------|-------------|
| 1 | **Crossbow release** | 0.15 s | Spring-loaded rail fires net package. Recoil impulse applied to platform. See [`CROSSBOW_ARMS.md §1`](CROSSBOW_ARMS.md:39). Windup: [`LASSO_CAST_WINDUP: 0.15`](js/core/Constants.js:848). **Rev 6 (Config G):** Net fires from **strut tip** along the strut's **meridian plane** (0–180° sweep). Exit angle is deterministic in-plane. *(Rev 5 said "dock-tangent plane / 1-DOF yaw" — superseded by Config G meridian sweep.)* See [`ARM_PIVOT_ANALYSIS.md §10.4`](ARM_PIVOT_ANALYSIS.md:934) for strut-tip assembly. |
| 2 | **Spin-up** | 0.5 s | Net package spins up via **pre-loaded angular momentum** (the package is wound with a twisted cord that unwinds on release, like a yo-yo despin mechanism — TRL 9, used on every spin-stabilised spacecraft since Explorer 1). Gas torquer not needed at Y0. |
| 3 | **Tether pay-out** | 2–8 s | Tether unreels from platform reel. Net travels at launch velocity (10–40 m/s depending on net class). Current: [`LASSO_SPEED: 10`](js/core/Constants.js:840) m/s. Max flight: [`LASSO_MAX_FLIGHT_TIME: 8`](js/core/Constants.js:842) s. |
| 4 | **Approach monitor** | continuous | Edge-node cameras (Y1+) or tether tension sensors (Y0) track closing distance to target. System auto-selects capture mode: **slam-wrap** (durable) or **tether-brake cinch** (delicate) — see §3.6 for mode selection logic. Player can override with `Tab`. |
| 5a | **Slam-wrap** (durable targets) | 0.5–2 s | Net contacts target directly. Spin momentum wraps rim weights inward around target. Mesh conforms to surface via capstan friction + Velcro cling. Simple, fast, reliable for metal fragments and rocket bodies. |
| 5b | **Tether-brake cinch** (delicate targets) | 2–4 s | At optimal distance (~2× target diameter), **reel brakes the tether**. Net centre decelerates sharply. Rim weights, carrying forward momentum, sweep past the target on both sides. Mesh forms a bag around the debris. Edge-node spring-loaded cinch hubs fire — solenoid pin-pull releases pre-tensioned spring, drawstring cord through mesh eyelets contracts, closing the bag mouth behind the target. Debris floats inside a closed net bag with **zero crushing contact force**. See §2.4.1. |
| 6 | **Secure check** | 0.2 s | System evaluates capture probability (§3). For slam-wrap: cling adhesion check. For cinch: bag-closure integrity check (higher P_success). Failure → empty net, proceed to reel-in. |
| 7 | **Reel-in** | 1–5 s | Tether motor reels net (+ captured debris if successful) back to platform. Current: [`LASSO_REEL_SPEED: 0.33`](js/core/Constants.js:844) (progress/s, ~3 s total). |
| 8 | **Magazine advance** | 0.5 s | Next net in magazine pack rotates into launch position. If pack empty → "PACK EMPTY" warning. |

#### §2.4.1 Tether-Brake Cinch — Detailed Sequence

This is the key innovation for **gentle capture of frangible debris** (satellites with solar panels, composite tanks, antenna arrays). The physics:

```
Phase A — Approach:
  Net flies toward target, open cone forward, spinning.
  Edge nodes monitor closing distance via camera (Y1+) or
  ground-computed timing from launch parameters (Y0).

Phase B — Brake:
  At distance d_brake ≈ 2 × D_target, reel motor applies hard brake.
  Tether goes taut. Net centre decelerates: a = F_brake / m_net.
  Rim weights at perimeter have angular + linear momentum — they
  continue forward (Newton's 1st law, no air drag to slow them).

Phase C — Envelop:
  Rim weights sweep forward past the debris on all sides.
  Mesh, still attached at centre (tether) and rim (weights),
  forms a bag shape — open mouth facing the platform,
  debris inside the bag.

  Top-down view at d_brake moment:
     ← tether —— [centre] ——— mesh ——— (weights →→→)
                              ↕
                           [DEBRIS]
                              ↕
     ← tether —— [centre] ——— mesh ——— (weights →→→)

  After weights pass debris:
     ← tether —— [centre]    [DEBRIS]   (weights)
                      \___mesh___↕___mesh___/
                           bag closes →

Phase D — Cinch:
  Solenoid in each edge node fires a pin-pull (25 mJ), releasing
  a pre-tensioned spring. Spring contracts drawstring cord through
  mesh eyelets. Bag mouth diameter shrinks from D_mesh to ~0.3×D_mesh.
  Debris cannot escape through the cinched opening.

  Spring force spec'd at 3× required drawstring tension for robust
  first-fire closure. Single-fire mechanism — no retry needed because
  3× margin makes partial closure mechanically impossible.
  Cinch-confirm sensor (limit switch on drawstring, TRL 9) reports
  closed/not-closed to platform.

  Temperature-independent: works from −150 °C (eclipse) to +120 °C
  (sunlit) without modification. No thermal budget required.

Phase E — Settle:
  Net bag with debris inside drifts on tether. Tension stabilises.
  Reel-in begins at gentle speed (0.5 m/s initially, ramping to full).
```

**Why this works in space:** No air resistance means the rim weights lose zero momentum after the brake — they carry forward at full speed. On Earth, air drag would slow the net edges and the bag would never form. In vacuum, it's guaranteed. The brake manoeuvre is essentially a **momentum transfer from tether to net perimeter** — the tether absorbs the centre's momentum while the edges keep theirs.

#### §2.4.2 Cinch Timing Precision

The brake must fire when the net is at distance d_brake ≈ 2×D_target from debris. How accurate is the timing?

**Known quantities at fire time:**
- Target distance: ±0.02 m from optical range sensor ([`OPTICAL_RANGE_ACCURACY: 0.02`](js/core/Constants.js:184))
- Tether paid out: ±0.01 m from reel encoder (rotary encoder on axle, TRL 9)
- Net launch velocity: ±1% from spring consistency (calibrated spring, known draw distance)
- Net position at time t: `p(t) = v_launch × t` (no air drag in vacuum) → error ≈ ±(0.01×v) × t

**Position uncertainty at brake moment (worst case):**
For Large Net at 75 m range, t_flight ≈ 7.5 s at 10 m/s: position uncertainty ≈ ±(0.1 × 7.5) = **±0.75 m**. For d_brake = 6 m (3m-diameter satellite), this is ±12.5% — workable but marginal for composite tanks.

**Precision improvement: apex camera (Y0+):**
A tiny camera (640×480 CMOS, 1 g, 50 mW) mounted at the **tether-to-net junction** (apex of the cone) looks forward along the approach axis. It sees the debris directly from the net's perspective — no accumulated position error.

- At 6 m closing: a 3 m target spans ~280 pixels → centroid accuracy ±0.02 m
- Camera sends brake-trigger signal via the tether's thin copper conductor (already present for solenoid power delivery)
- **Result: ±0.05 m brake precision** — excellent for all target types including fragile composites

The apex camera also enables **debris geometry assessment** during final approach — the system can detect solar panels and auto-select cinch mode vs slam-wrap (see §3.6).

**For high-value targets (Y2+): daughter triangulation.** Deploy one daughter radially to provide a second viewing angle. Daughter's sensor + Mother's ranging = stereo triangulation with sub-centimetre accuracy. Also gives 3D tumble-rate measurement for optimal brake window timing on rotating targets. Operationally expensive (burns a daughter deploy cycle) but justified for intact satellites worth thousands of credits.

### §2.5 Spin Physics

The net must spin fast enough that centripetal force keeps the mesh taut. Required spin rate:

```
F_centripetal = m_w × ω² × r
F_centripetal > T_mesh (mesh tension to hold shape)

For Medium Net: m_w = 0.05 kg, r = 2.5 m, target F = 0.5 N
  ω = √(F / (m_w × r)) = √(0.5 / (0.05 × 2.5)) = √4.0 = 2.0 rad/s ≈ 0.32 Hz

For safety margin (3×): ω_design = 6.0 rad/s ≈ 1.0 Hz
```

Current code: [`NET_SPIN_HZ: 4`](js/core/Constants.js:854) — this is higher than minimum (provides visual drama + cling force margin). Acceptable for gameplay; real spin would be 1–2 Hz.

### §2.6 Smart Rim Weights ("Edge Nodes")

The rim weights are not passive tungsten spheres — they are **edge nodes**: miniaturised smart modules that enable the tether-brake cinch (§2.4.1) and provide situational awareness.

| Component | Function | Mass | TRL | Unlock |
|-----------|----------|------|-----|--------|
| **Tungsten core** | Centripetal mass (keeps mesh open) | 40–60 g | 9 | Y0 |
| **Spring-loaded cinch + solenoid pin-pull** | Pre-tensioned drawstring spring held by a solenoid-actuated pin. On command, solenoid fires pin-pull (25 mJ), releasing the spring. Spring contracts drawstring cord through mesh eyelets. Closes the bag mouth to ~0.3×D_mesh. Single-fire, temperature-independent (<100 ms actuation). Force spec'd at 3× required drawstring tension. | 3 g | 9 | Y0 |
| **CR2032 primary cell** | 3 V, 0.7 Wh factory-sealed lithium coin cell. Powers solenoid pin-pull (25 mJ) + radio beacon sync pulse (Y1+). No recharge required — disposable with net. 10-year shelf life. | 2 g | 9 | Y0 |
| **Radio beacon** | 915 MHz ISM-band mesh network between nodes. Coordinated cinch timing — all nodes fire solenoid within 50 ms of each other for symmetric closure. Transmits node status (battery, cinch success) to platform. | 1 g | 8 | Y1 |
| **Micro-camera** | 640×480 CMOS, 120° FOV. Each node's camera sees the debris from a different angle during approach. Composite image enables dynamic brake timing for tumbling targets. Data sent to platform via radio mesh. | 2 g | 6 | Y1 |
| **Spring latch** | Mechanical latch connecting node to mesh. When cinch fires, latch allows node to slide inward on guide cord — reduces bag mouth diameter. Passive mechanical, no power needed. | 1 g | 9 | Y0 |

**Y0 edge-node mass per unit:** ~46 g (tungsten core + spring cinch + solenoid + CR2032 + spring latch). 4 nodes × 46 g = 184 g total rim weight for Medium Net.

**Y1+ edge-node mass per unit:** ~52 g (add radio + camera). Marginal mass increase, major capability gain — camera-guided cinch timing handles tumbling debris that Y0's timer-based approach cannot.

The edge-node concept turns the net from a passive mesh into a **sensor-equipped smart trap**. Future upgrades (Y2+) could add accelerometers for impact detection, IR sensors for thermal mapping of debris, or micro-thrusters for last-second trajectory correction of individual weights.

### §2.7 Material Upgrade Path

The baseline net uses **Dyneema SK78** (UHMWPE, 3.6 GPa tensile strength). As the player progresses, graphene-enhanced materials become available that are **stronger per unit mass** — enabling thinner cord at the same breaking strength. Thinner cord = less mass per net = more nets per magazine pack + longer range (lighter net = higher launch velocity for same spring energy) + more compact storage.

| Tier | Material | Tensile (GPa) | Mesh mass (Large Net) | Total Large Net mass | Total Medium Net mass | Nets per Large Net pack | TRL | Unlock |
|------|----------|--------------|----------------------|---------------------|----------------------|------------------------|-----|--------|
| **Y0** | Dyneema SK78 | 3.6 | 1200 g | 1950 g | 680 g | 4 | 9 | Start |
| **Y1** | Graphene-20 | 20 | 216 g | 966 g | 380 g | 5 | 6 | Unlock |
| **Y2** | Graphene-40 | 40 | 108 g | 858 g | 340 g | 6 | 5 | Unlock |
| **Y3** | Graphene-80 | 80 | 54 g | 804 g | 316 g | 7 | 4 | Unlock |
| **Y4** | Graphene-130 | 130 | 33 g | 783 g | 305 g | 8 | 3 | Unlock |

**Mass scaling note:** Only the **mesh cord mass** reduces with better material (cord diameter d ∝ 1/√σ, mass ∝ 1/σ). The tungsten rim weights (600 g for Large Net) and hub (150 g) are unchanged — they're there for centripetal force, not tensile strength. This means diminishing returns: at Graphene-40+, the mesh is already negligible and further material improvement barely reduces total net mass. The real benefit of better material at higher tiers is **smaller folded volume** (thinner cord packs tighter) → more nets per magazine pack, and **better fatigue life** → more reel cycles.

**Graphene-N naming convention:** Dyneema is the Y0 baseline (real product name). Upgrade tiers use "Graphene-N" where N = tensile strength in GPa. Player sees "Graphene-20", "Graphene-40", etc. in the HUD, Shop, and Codex. The number communicates performance directly — bigger number = stronger material. Real graphene fibre research (Rice University, 2018–) has demonstrated 1.5 GPa fibres at lab scale with theoretical limits near 130 GPa.

**Tether material follows the same upgrade path** — shared with ST-9.5. A Graphene-20 tether at 2 km weighs 0.43 kg instead of 2.4 kg (Dyneema), enabling longer tethers or more reel cycles before wear-out.

### §2.8 Range Analysis (From First Principles)

Net range is determined by **spring energy** and **net mass**. The existing crossbow springs provide benchmark energy values (from [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md) and [`Constants.js`](js/core/Constants.js:317)):

```
Weaver crossbow:  k = 17,600 N/m, d = 0.25 m → E = ½kd² = 550 J (launches 11 kg arm at 10 m/s)
Spinner crossbow: k =  5,920 N/m, d = 0.25 m → E = ½kd² = 185 J (launches 3.7 kg arm at 10 m/s)
```

The **Mother net launcher** uses a dedicated spring in each pod. A moderate spring (E ≈ 100 J, roughly half the Spinner crossbow) balances launch speed vs mechanical complexity:

```
Large Net range derivation:
  E_spring = 100 J
  m_net    = 1.95 kg (Dyneema Y0)
  v_launch = √(2E/m) = √(200/1.95) = 10.1 m/s
  t_flight = 8 s max (LASSO_MAX_FLIGHT_TIME)
  range    = v × t = 10.1 × 7.5 ≈ 75 m (reserving 0.5s for cinch brake)
```

**Range by net class and material tier (E_spring fixed per platform):**

| Platform | Spring E | Net class | Dyneema mass | Dyneema v | Dyneema range | Graphene-20 mass | Graphene-20 range |
|----------|----------|-----------|-------------|-----------|---------------|------------------|-------------------|
| Mother pod | 100 J | Large Net | 1.95 kg | 10.1 m/s | **75 m** | 0.97 kg | **105 m** |
| Weaver daughter | 34 J | Medium Net | 0.68 kg | 10.0 m/s | **75 m** | 0.38 kg | **13.4 m/s → 100 m** |
| Spinner daughter | 6 J | Small Net | 0.12 kg | 10.0 m/s | **75 m** | 0.07 kg | **13.1 m/s → 100 m** |

**Key insight:** All three net classes converge on **~75 m Dyneema range** — this is not coincidence; the springs are sized to give ~10 m/s launch speed for each class's mass. 75 m is a close-quarters engagement distance, consistent with the station-keeping approach doctrine.

**Why not longer range?** Range beyond 100 m creates problems:
- Tether mass: 100 m Dyneema = 0.12 kg (fine), but 500 m = 0.60 kg (+31% to Large Net mass)
- Cross-debris risk: flight time scales linearly — 8× longer in a Kessler zone means 8× tangle probability
- Cinch precision: apex camera accuracy degrades at distance (target subtends fewer pixels)
- Gameplay: forces the player to close the distance — this IS the core loop (approach → station-keep → capture)

**Engagement envelope:** Target must be within **100 m** to be selectable for net fire (current [`LASSO_RANGE: 200`](js/core/Constants.js:839) → revise to 100 m). The engagement envelope is slightly larger than effective range to allow for target motion during flight.

### §2.9 Magazine Pod Integration on Mother

The Mother's hex body ([`OCTOPUS_CORE_ACROSS_FLATS: 1.0`](js/core/Constants.js:116) m, [`LENGTH: 1.2`](js/core/Constants.js:117) m) already carries 8 daughter crossbow rails around its perimeter. The net magazine must integrate without blocking crossbow rails, sensors, or thrusters.

#### §2.9.1 Design: Two Symmetric Pods

> **Rev 5 note:** The Mother retains her 2 body-mounted Large Net pods at **all arm-count tiers** (Y0 Quad through Y3 Octo). Daughter count changes with the tech ladder (§6); Mother pod count does not. The Mother's net capacity is independent of how many daughters are docked.

**Two magazine pods** mounted on the Mother's forward face, **180° apart**, each containing:
- 1 magazine pack slot (holds 4 Dyneema nets at Y0, up to 8 at Y4)
- 1 tether reel (shared by all nets in the pack — sequential fire)
- 1 launch spring (E = 100 J)
- Apex camera per-net (factory-installed on each net at the tether junction)

```
  Mother hex body (forward view, looking aft):

           ╱╲
       CB ╱    ╲ CB       CB = Crossbow daughter rail (8 total)
         ╱  ●  ╲         ● = Forward sensor cluster
     CB ╱ [POD_A] ╲ CB
       │     ◎     │      ◎ = Centre-line guide ring
     CB ╲ [POD_B] ╱ CB
         ╲      ╱
       CB ╲    ╱ CB
           ╲╱

  POD_A and POD_B are 180° apart, fitting
  between crossbow rail pairs.
```

**Pod dimensions:** ~0.15 m diameter × 0.5 m long (cylindrical). Fits within the gaps between adjacent crossbow rails in the octagonal arrangement. Total mass per pod (loaded Dyneema Y0): ~8.3 kg (4 nets × 1.95 kg + reel 0.5 kg + spring 0.3 kg + housing 0.2 kg).

**Pod shutter:** Each pod has a spring-loaded cap (TRL 9, ~20 g) protecting the first net's Velcro hooks from atomic oxygen erosion at VLEO altitudes. Shutter opens on first fire command. This eliminates AO degradation as a Y0 concern — see §7.6.

#### §2.9.2 Reel Architecture: One Shared Reel Per Pod

**Shared reel per pod** (not individual reels per net):

| Trade | Shared reel | Individual reels |
|-------|-------------|------------------|
| Simultaneous ops | ❌ Must reel before next fire | ✅ Fire while reeling |
| Motor count | 1 per pod (2 total) | 4 per pod (8 total) |
| Mass | 2 × ~0.5 kg = 1 kg | 8 × ~0.3 kg = 2.4 kg |
| Peak power | 2 × 15 W = 30 W | Up to 8 × 15 W = 120 W |
| Failure mode | Pod offline if reel jams | Only 1 net offline |
| Complexity | Low | High |

**Recommendation: shared reel.** The 30 s reload time between nets already serializes operations. Having two pods provides redundancy (Pod A jams → Pod B still works). Alternating Pod A / Pod B fire gives faster cycle time than reloading from one pod.

**Tether routing:** Net fires from pod → tether pays out → passes through a **centre-line guide ring** (low-friction ceramic, 30 mm bore, TRL 9) on the forward centreline → continues to the net.

#### §2.9.3 Centre-Line Guide Ring — Torque-Free Reel-In

**The critical problem:** Reel-in tension from an off-axis pod (0.3 m from centreline) creates torque:
```
τ = F × r = 500 N × 0.3 m = 150 N·m
```
Mother's RCS can produce ~0.5 N·m — completely inadequate. The Mother would spin.

**Solution:** Route all tethers through a **shared centre-line guide ring** on the forward face:
- The guide ring sits on the Mother's longitudinal axis (CG line)
- Tether exits the pod's reel, runs ~0.3 m laterally to the guide ring, then exits forward
- Reel-in tension acts along the centreline → **zero torque** on the Mother
- The 0.3 m lateral section inside the hull is under low tension (just friction through the ring)

```
  Side view:
      ┌──────────────────────┐
      │  Mother hex body      │
      │                       │
   POD_A ─── tether ──→ ◎ ───→ to net ───→ [debris]
      │  (inside hull)  (guide ring)
      │                       │
      └──────────────────────┘
```

**Guide ring specification:**
- Bore: 30 mm (accommodates tether + net folded through it during launch)
- Material: alumina ceramic (Al₂O₃) — low friction, vacuum-stable, AO-resistant
- Tether contact surface: polished to <0.1 µm Ra (minimise abrasion wear on Dyneema)
- Mass: 80 g
- TRL: 9 (ceramic tether guides used on every tethered satellite experiment since TSS-1)

**CG analysis:**
- Two pods at ±0.3 m off-axis, symmetric → CG stays on centreline ✅
- Full Dyneema load: 2 × 8.3 kg = 16.6 kg on 216 kg wet-mass Mother (7.7%)
- CG shift forward: ~0.04 m — within Mother's RCS trim capability
- As nets are fired and packs lighten, CG shifts aft automatically

---

## §3 Cling Mechanism

### §3.1 Two Capture Modes, Two Secure Mechanisms

The capture mode (§2.4) determines how the net secures the debris:

**Mode A — Slam-wrap (durable debris):** Net contacts target directly. The net must **self-cling** using surface forces:
1. **Residual spin momentum** — rim weights swing around the target, mesh tightens via capstan friction (cord-on-surface friction amplified by wrapping angle).
2. **Velcro hook adhesion** — micro-hook fibres on the cord surface grip textured debris surfaces.
3. **Mechanical entanglement** — mesh catches on protrusions, solar panel edges, antenna struts.

**Mode B — Tether-brake cinch (delicate/frangible debris):** Net envelops target as a bag (§2.4.1). The debris is secured by **mechanical enclosure**, not surface adhesion:
1. **Drawstring cinch** — spring-loaded hubs in edge nodes release pre-tensioned drawstring via solenoid pin-pull, closing the bag mouth to ~30% open diameter. Debris physically cannot exit.
2. **Mesh tension** — tether tension distributes evenly through the closed bag. Debris floats freely inside — no crushing force, no surface grinding.
3. **Velcro cling (bonus)** — any incidental contact with the bag interior adds adhesion, but it's not required for retention.

The cinch mode has **higher capture success** because it doesn't depend on surface texture (a polished aluminium satellite is just as easy to bag as an MLI-wrapped one). The trade-off: it takes longer (2–4 s for bag formation vs 0.5 s for slam-wrap) and requires functional spring-loaded cinch mechanisms in the edge nodes.

### §3.2 Adhesion Strategy Evaluation

| Option | Mechanism | TRL | Pros | Cons | Y0 viable? |
|--------|-----------|-----|------|------|-------------|
| **A. Velcro hook-and-loop** | Nylon hooks on mesh snag textured surfaces (MLI blankets, insulation, micro-roughness) | **9** | Flight-proven on every EVA suit, ISS cargo strap. Works in vacuum, thermal extremes (−150° to +150°C rated). Reversible. Zero power. | Low shear strength (~1 N/cm²). Requires target surface texture — fails on polished aluminium. | **✅ YES — Y0 default** |
| **B. Gecko-style PDMS microstructures** | Van der Waals adhesion via micro-pillar arrays bonded to mesh nodes | **5** | Works on ALL surfaces including polished metal. No consumables. Direction-dependent (peel easy, shear hard). | Lab-only at useful scale. Temperature cycling degrades pillars. Not flight-qualified. | ❌ Defer to Y2+ |
| **C. Active electrostatic pads** | Charged mesh nodes attract conductive debris surfaces | **4** | Strong force on conductive targets (Al, Ti, steel). | Requires power (3 kV supply per node), fails on non-conductive composites, arc risk in plasma environment. | ❌ Defer to Y3+ |

**Y0 decision: Option A (Velcro hook-and-loop mesh).** Each Dyneema cord in the mesh has micro-hook fibres woven into the outer surface — a variant of Velcro's "hook tape" applied to braided cord. This is mature textile technology (TRL 9). The hooks snag on:
- MLI (Multi-Layer Insulation) blanket fabric — present on >80% of all spacecraft surfaces
- Paint/thermal coating micro-roughness
- Solar cell micro-texture
- Any protruding geometry (antenna feeds, struts, bolt heads)

The hooks do NOT grip on:
- Polished bare aluminium (rare — most aluminium is anodised or painted)
- Glass (solar cell cover glass, if exposed)
- Smooth carbon-fibre composite (increasingly common on modern spacecraft)

### §3.3 Cling Probability Model

Cling probability `P_cling` is a function of six factors:

```
P_cling = P_base × f_velocity × f_contact × f_roughness × f_spin × f_tension × f_distance

Where:
  P_base    = base cling probability for net class + target match (see §3.4)
  f_velocity = clamp(1.0 - |v_rel - v_optimal| / v_range, 0.3, 1.0)
               Too slow = weak wrap; too fast = bounce-off
  f_contact  = min(A_contact / A_target_surface, 1.0)
               Fraction of target wrapped by mesh
  f_roughness = surface roughness modifier (0.4 for smooth, 0.7 for painted, 1.0 for MLI/fabric)
  f_spin     = clamp(ω_impact / ω_design, 0.5, 1.2)
               Net must still be spinning at impact for wrap
  f_tension  = clamp(T_tether / T_nominal, 0.6, 1.0)
               Slack tether = poor wrap force transfer
  f_distance = clamp(1.1 - 0.003 × range_m, 0.85, 1.1)
               Closer approach = higher capture probability
```

**Distance modifier** (Q-4 decision): Risk increases with distance, rewarding the player's investment of time and delta-v to close the gap:

| Range (m) | f_distance | Capture % effect | Frag risk effect | Why |
|-----------|-----------|------------------|-----------------|-----|
| <30 m | 1.1 (bonus) | ×1.1 | ×0.5 (halved) | Close = precise |
| 30–75 m | 1.0 (baseline) | ×1.0 | ×1.0 (baseline) | Design range |
| 75–100 m | 0.85 (reduced) | ×0.85 | ×1.5 (increased) | Edge of envelope |

This creates the core skill loop: experienced players close to <30 m for the bonus, accepting the delta-v cost. Beginners fire at baseline range (30–75 m) where everything works fine on easy targets.

**Performance note:** The cling probability calculation has 6 multiplicative factors. Pre-compute surface-roughness and spin factors at target-lock time, not per-frame. Must run **≤1 ms/frame** to avoid HUD stutter — see §10 concern #3.

### §3.4 Default Cling Probabilities (Y0)

With the beginner-first philosophy and distance-based modifiers, baseline values are tuned so that **well-matched targets at design range give ≥85% capture** in slam-wrap:

| Net + Target Match | Slam P_base | Cinch P_base | Notes |
|--------------------|-------------|--------------|-------|
| Right net, right target (e.g., Small Net → fragment) | **0.90** | 0.95 | Easy — the player used the right tool |
| Right net, harder target (e.g., Medium Net → dead sat) | **0.80** | 0.93 | Good — standard challenge |
| Right net, fragile target (e.g., Medium Net → sat with panels) | **0.70** | 0.92 | Player should consider cinch |
| Wrong net (too big or too small) | **0.45–0.55** | 0.85 | Feedback: "Use a different net next time" |

At <30 m with the ×1.1 distance bonus, even the "harder target" case reaches 0.88 — comfortable. The distance modifier does the work that complex tiering would have done, with a simpler constant set.

**Beginner progression:** Per [`FIRST_EXPERIENCE.md`](FIRST_EXPERIENCE.md:1), early targets are durable metal fragments at close range:

| Mission stage | Target type | Capture % | Frag risk % | Player experience |
|---------------|-------------|-----------|-------------|-------------------|
| **Mission 1–3** (onboarding) | Metal fragments, close range (<50 m) | **90–95%** | **<1%** | "This is easy!" |
| **Mission 4–6** (learning) | Mixed debris, medium range | 75–85% | 5–10% | "Hmm, that one was harder." |
| **Mission 7+** (mastery) | Satellites with panels, variable range | 60–80% (slam) / 90%+ (cinch) | 10–25% (slam) / <2% (cinch) | "I need to choose carefully." |

### §3.5 Failure Mode: Empty-Net Reel-In

When `P_cling` check fails (random roll > P_cling):

1. **Net releases target** — mesh slides off, debris continues on original trajectory (no capture, no damage).
2. **Empty net signal** — system sets `_reelingIn = true`, `_reelProgress = 0`. Visual: net goes to compact form ([`NET_COMPACT_SCALE: 0.45`](js/core/Constants.js:860)).
3. **Reel-in** — motor reels empty net back. Time cost: same as loaded reel (~3 s). Tether wear cost: 1 reel-cycle (shared with ST-9.5).
4. **Cooldown** — [`LASSO_COOLDOWN_MISS: 1`](js/core/Constants.js:850) second before re-fire.
5. **Comms feedback** — "Net didn't cling — reeling in for retry."

Net resource is NOT consumed on miss — the net is reusable. Only tether wear increases.

### §3.6 Capture Mode Selection

**Auto-recommend with manual override** (Q-10 decision). The system auto-selects slam-wrap or cinch based on target data; experienced players can override with `Tab`.

**How it works, beginner-first:**

| Player experience level | What happens |
|------------------------|--------------|
| **Missions 1–3** (fragments, easy) | System auto-selects slam-wrap. Reticle shows 🔨 icon. Player just hits Fire. **Zero decisions required.** |
| **First satellite target** (medium difficulty) | System auto-selects cinch (detects solar panels via [`SensorSystem`](js/systems/SensorSystem.js:1)). Reticle shows 🎒 icon. Ground station explains: *"Cinch mode — gentler capture for delicate targets."* |
| **Experienced player** | Player sees the auto-recommendation, overrides with `Tab` toggle to slam-wrap for speed on a target they judge durable. Accepts the higher frag risk. Their call. |

**Auto-recommendation logic:**
1. If target has solar panels → cinch
2. If v_rel > soft-catch limit (§5.3) → cinch
3. If target surface is "smooth" (low roughness) → cinch
4. Else → slam-wrap

This uses data already available from [`SensorSystem`](js/systems/SensorSystem.js:1) target scan. No new sensors needed.

**Key binding:** `Tab` toggles capture mode when net is ready to fire. [`TargetReticle`](js/ui/TargetReticle.js:1) shows mode icon (🔨 SLAM / 🎒 CINCH). [`InputManager`](js/systems/InputManager.js:1) routes the toggle.

---

## §4 Tangle Mechanics

> **⚠️ Rev 6 (Config G) geometry note:** Config G uses barrel-axial top-collar mount with 0–180° meridian sweep. Net departures follow the strut's **meridian plane** (not the equatorial dock-tangent plane). The 4 struts at 60°/120°/240°/300° fire into 2 perpendicular meridian planes. Tangle analysis below incorporates Rev 5 planar-departure benefits (deterministic exit) AND Rev 6 meridian-plane geometry. The key change: "equatorial planar departure" → "meridian-plane departure." Since meridian planes are still deterministic single-plane exits, all Rev 5 probability reductions carry forward. The tethers are more spread out in Config G (60° angular separation vs 60° in equatorial), further reducing cross-tether contact probability.

### §4.1 Scenario 1: Self-Tangle (Net Mesh Wraps Own Tether)

**Description.** During spin, mesh cord whips around and snags the tether line running through the centre apex. Most likely when spin axis is misaligned with tether axis (tumble during flight).

> **Rev 6 (Config G):** Net fires from strut tip along the strut's meridian plane. The tether exit is deterministic in-plane (same Rev 5 benefit). Self-tangle probability unchanged from Rev 5.
>
> **Rev 5 (1-DOF):** With yaw-only strut articulation, the tether exit angle is deterministic (dock-tangent plane). Self-tangle probability is reduced because the net always departs in-plane — no conical sweep can wrap the tether around the strut. The primary remaining risk factor is spin-axis precession from asymmetric rim-weight mass. *(2-DOF Rev 1 had additional pitch-axis precession modes that are now eliminated.)*

| Attribute | Value |
|-----------|-------|
| **Detection** | Spin rate drops >50% without target contact; tether tension oscillates |
| **Severity** | Medium — net loses capture ability but tether intact |
| **Recovery** | Reel in; on-reel mechanical separator (spring-loaded cone) untangles. 10 s recovery. |
| **Fail-state** | If reel-in tension exceeds 200 N → auto-cut tether to prevent reel damage. Net lost. |
| **Probability factors** | Deploy angle relative to platform velocity vector (>30° off-axis increases risk 3×); platform attitude rate during launch (FEEP firing during net flight); spin-axis precession from asymmetric mass. *(Rev 5: pitch-axis deploy errors eliminated by 1-DOF constraint.)* |
| **Base probability** | 0.015 per launch (1.5%) — reduced from 2% (Rev 4) by 1-DOF deterministic exit angle |

### §4.2 Scenario 2: Mother-Tangle (Tether Wraps Mother Body)

**Description.** Tether wraps around mother's hex body, FEEP thruster plumes, solar array edges, or sensor booms during reel-in or platform manoeuvre.

> **Rev 5 (1-DOF):** With 1-DOF yaw-only strut, the tether always exits in the dock-tangent plane. This makes the exit geometry **deterministic** — the tether cannot pitch into the solar panel plane or FEEP plume cone unless the Mother rotates during reel-in. Mother-tangle around solar panels/FEEP is much less likely than with the 2-DOF design, where a pitch-axis error could direct the tether straight into a panel edge. *(2-DOF Rev 1 "strut-pitch-into-solar-panel" failure mode is eliminated.)*

| Attribute | Value |
|-----------|-------|
| **Detection** | Tether angle sensor reads >90° from expected reel direction; tension spike |
| **Severity** | High — may foul FEEP thrusters or solar arrays |
| **Recovery** | Halt reel. Reverse reel 5 m. Mother rotates to reduce wrap angle. Retry reel. If 3 retries fail → cut tether. |
| **Fail-state** | Tether fouls FEEP plume → tether ablation → snap. Or tether wraps solar array hinge → array stuck. |
| **Probability factors** | Mother attitude rate during reel-in (should be near-zero); FEEP burn during reel (prohibited by interlock — see [`CollisionAvoidanceSystem`](js/systems/CollisionAvoidanceSystem.js:1)); tether exit angle from reel housing. *(Rev 5: in-plane exit reduces off-axis tangle vectors.)* |
| **Base probability** | 0.02 per reel-in (2%) — reduced from 3% (Rev 4) by deterministic in-plane exit; mitigated by attitude-hold interlock |

### §4.3 Scenario 3: Daughter-Tangle (Sibling Tether Cross)

**Description.** In multi-arm operations, one daughter's net tether crosses another daughter's tether or net. Especially dangerous during fleet deploys (multiple Small Nets fired in rapid sequence).

| Attribute | Value |
|-----------|-------|
| **Detection** | Tether load cell on either daughter reads unexpected lateral force; reel-in of one daughter drags the other |
| **Severity** | Critical — can bind two daughters, losing both |
| **Recovery** | Both daughters halt reel. Mother commands sequential reel-in (one at a time, slowest first). If tension >300 N on either → cut the more-expendable tether. |
| **Fail-state** | Both tethers snap → two daughters lost (most expensive failure mode). |
| **Probability factors** | Angular separation between deployed daughters (<20° separation = high risk); timing overlap of simultaneous deploys; debris density causing evasive manoeuvres |
| **Base probability** | 0.05 per simultaneous multi-deploy (5%) — mitigated by requiring >30° angular separation between fire solutions |

### §4.4 Scenario 4: Cross-Debris (Flight-Path Debris Contact)

**Description.** During flight to target, net or tether contacts non-target debris. The spinning mesh may wrap incidental debris.

> **Rev 5 (1-DOF):** With deterministic in-plane tether departure, the cross-debris sweep volume is a **planar disc** rather than a conical volume. This reduces the probability of contacting off-plane debris. The net's flight corridor is narrower and more predictable. *(2-DOF Rev 1 had a conical sweep that could contact debris above/below the dock-tangent plane.)*

| Attribute | Value |
|-----------|-------|
| **Detection** | Unexpected deceleration or deflection of net projectile; mass-on-tether increases unexpectedly |
| **Severity** | Low-to-Medium — unintended capture is annoying but not dangerous. Could be beneficial (bonus catch). |
| **Recovery** | If unintended-capture mass < net class max → accept as bonus. If mass > max → reel-in overload → cut tether. |
| **Fail-state** | Net wraps a much-larger-than-expected object → tether snap on reel-in. |
| **Probability factors** | Debris density along flight path (high-density Kessler zones); net flight distance (longer = more exposure); relative velocity of cross-debris. *(Rev 5: planar exit reduces sweep volume vs conical.)* |
| **Base probability** | 0.008 per launch in normal density (0.8%) — reduced from 1% (Rev 4) by planar sweep; up to 0.06 (6%) in Kessler cascade zones |

### §4.5 Scenario 5: Reel-In Tangle (Asymmetric Cone Collapse)

**Description.** During reel-in, the mesh cone collapses asymmetrically — one side folds over the other, creating a tangled bundle that jams the reel inlet.

| Attribute | Value |
|-----------|-------|
| **Detection** | Reel motor current spike (jam); reel-in progress stalls |
| **Severity** | Medium — net stuck at reel inlet, blocking further use until cleared |
| **Recovery** | Reverse reel 2 m (payout). Spin up net briefly (1 s burst via residual angular momentum or cold-gas puff). Retry reel. 2 retries before declaring net fouled. |
| **Fail-state** | Net permanently jammed in reel → that net is out of service until EVA/dock maintenance (game: return to shop for net replacement). |
| **Probability factors** | Loaded vs empty reel-in (loaded is worse — debris mass pulls asymmetrically); reel-in speed (slower = safer); remaining spin at reel-in start |
| **Base probability** | 0.04 per reel-in (4%); doubled (0.08) if captured debris is tumbling |

### §4.6 Tangle Probability Summary

| Scenario | Base P | Mitigation | Residual P | Feature flag |
|----------|--------|------------|-----------|-------------|
| Self-tangle | 0.02 | Yo-yo despin alignment | 0.02 | `NET_TANGLE_MECHANICS` |
| Mother-tangle | 0.03 | Attitude-hold interlock | 0.01 | `NET_TANGLE_MECHANICS` |
| Daughter-tangle | 0.05 | 30° separation rule | 0.02 | `NET_TANGLE_MECHANICS` |
| Cross-debris | 0.01–0.08 | Flight path CA check | 0.005–0.04 | `NET_TANGLE_MECHANICS` |
| Reel-in tangle | 0.04–0.08 | Slow reel + spin maintenance | 0.02–0.04 | `NET_TANGLE_MECHANICS` |

All tangle scenarios gated behind `FEATURE_FLAGS.NET_TANGLE_MECHANICS` (default `false`). Y0 baseline play has **zero tangle risk** — tangles are an advanced-difficulty mechanic for players who opt in.

### §4.7 Daughter Tether Routing — Parallel with Software Interlock

**Q-11 decision.** A deployed daughter has two tethers: the arm tether (daughter → Mother's reel, up to 2 km) and the net tether (daughter → target, up to 100 m). These run **parallel on independent axes** with a software interlock preventing crossing.

```
  Mother ←── arm tether ──── [Daughter] ──── net tether ──→ Target
                              (positioned between)
```

The daughter positions *between* Mother and target. Arm tether runs backward (to Mother). Net tether runs forward (to target). These naturally don't cross. The only tangle risk is during reorientation manoeuvres (daughter rotates to aim at a different target while both tethers are deployed).

**Software interlock:** Before net fire, check that the net fire vector won't cross the arm tether within 8 s of flight time. Simple dot-product geometry: `dot(net_fire_direction, arm_tether_direction) > cos(150°)` → BLOCK with "TETHER CROSS — pick a different angle". Same math as the 30° exclusion rule in §4.3.

The 1-DOF yaw-only crossbow aim on the daughter (from [`CROSSBOW_ARMS.md §8`](CROSSBOW_ARMS.md:19)) allows ±30° off the arm-tether axis in the dock-tangent plane. The interlock limits this to angles that don't create a tether crossing geometry. In practice, most captures fire within ±15° of the forward axis — well clear. *(Rev 4 specified 2-DOF ±60°; Rev 5 reduced to 1-DOF ±30° yaw-only. See [`CAPTURE_NET.md`](CAPTURE_NET.md) Rev 5 changelog.)*

---

## §5 Fragmentation Prevention

### §5.1 Impact Energy Budget

The net must not shatter brittle debris on contact. Maximum allowable kinetic energy transfer:

```
ΔKE_max = ½ × m_net × v_rel²

For Medium Net at v_rel = 2 m/s:
  ΔKE = ½ × 0.68 × 4.0 = 1.36 J

For Medium Net at v_rel = 10 m/s:
  ΔKE = ½ × 0.68 × 100 = 34 J
```

Fragmentation thresholds (from [`CATASTROPHIC_THRESHOLD: 40`](js/core/Constants.js:68) J/g):

| Debris class | Material | Approx. fragmentation energy | Max safe v_rel (Medium Net) |
|-------------|----------|------------------------------|---------------------------|
| Composite tank stage | CFRP/Al honeycomb | 5–15 J/g | 5 m/s (at 1000 g contact area) |
| Aluminium bus | Al 6061-T6 | 40 J/g | 15 m/s |
| Solar panel | Si cell on Al substrate | 2–5 J/g | 3 m/s |
| MLI blanket | Mylar/Dacron layers | 50+ J/g (flexible, doesn't shatter) | No limit |
| Tungsten ballast | W alloy | 200+ J/g (ductile metal) | No limit |

**Key insight:** Solar panels are the most fragile common debris component. For slam-wrap mode, the net must approach solar-panel-bearing targets at ≤3 m/s relative velocity. **For delicate targets, the tether-brake cinch (§2.4.1) eliminates this problem entirely** — the net never contacts the debris surface with impact force; it forms a bag around the target via momentum transfer through the tether brake. The cinch mode is the **primary answer to the fragmentation problem**, making the velocity table below a slam-wrap-only concern.

### §5.2 Spin-Down Profile (Slam-Wrap Mode)

On contact, the net's spin must **decay** — rim weights swing inward around the target, converting rotational KE into wrapping work (cord-on-surface friction). The spin-down prevents the net from acting as a rigid spinning disc that grinds the target surface.

```
Spin-down time ≈ I_net × ω / τ_friction

Where:
  I_net = Σ(m_w × r²) = 4 × 0.05 × 2.5² = 1.25 kg·m² (Medium Net)
  ω = 2π × 4 = 25.1 rad/s (at 4 Hz spin)
  τ_friction ≈ μ × F_contact × r ≈ 0.3 × 2 × 2.5 = 1.5 N·m

  t_spindown = 1.25 × 25.1 / 1.5 ≈ 20.9 s
```

This is long — the net stays spinning for ~20 s after contact. **Mitigation:** rim weights are attached via **inward-biased hinges** that allow weights to swing toward centre on contact but not outward. Think of an umbrella inverting in wind — the weights fold inward, reducing moment of inertia rapidly and dumping spin energy into wrap tension. With hinge mechanism:

```
  t_spindown_hinged ≈ 2–4 s (empirical estimate, rapid I reduction)
```

### §5.3 "Soft Catch" Doctrine

Maximum relative velocity limits before the approach system aborts:

| Net Class | Target | Max v_rel (m/s) | Action if exceeded |
|-----------|--------|------------------|--------------------|
| Large Net | Spent stage | 5.0 | Abort → reel-in empty |
| Large Net | Dead satellite | 3.0 | Abort |
| Large Net | Any with solar panels visible | 2.0 | Abort |
| Medium Net | Spent stage | 8.0 | Abort |
| Medium Net | Dead satellite | 5.0 | Abort |
| Medium Net | Fragment | 10.0 | Fire (fragments are durable) |
| Small Net | Any | 15.0 | Fire (small net, low KE) |

The soft-catch velocity check interfaces with [`CollisionAvoidanceSystem`](js/systems/CollisionAvoidanceSystem.js:1) — the approach phase must achieve station-keeping at the required relative velocity before the net fires.

### §5.4 Per-Debris-Class Fragmentation Risk

| Debris class | Fragile components | Fragmentation risk at 5 m/s | Risk at 2 m/s | Risk at 1 m/s |
|-------------|-------------------|------------------------------|----------------|----------------|
| Aluminium rocket body | Tank walls (pressurised = strong) | Low (0.05) | Negligible (0.01) | Negligible |
| Composite tank stage | CFRP overwrap, honeycomb core | **High (0.30)** | Medium (0.10) | Low (0.03) |
| Dead satellite with panels | Solar cells, antenna dishes | **High (0.25)** | Low (0.08) | Negligible (0.02) |
| Dead satellite (no panels) | Bus structure only | Low (0.05) | Negligible | Negligible |
| Fragment (metal) | N/A — already fragment | Negligible | Negligible | Negligible |
| Fragment (composite) | Fibre splinters possible | Low (0.08) | Negligible | Negligible |
| Micro-debris (< 1 kg) | N/A | Negligible | Negligible | Negligible |

Fragmentation events generate **new debris objects** (1–5 micro-fragments) — feeding into [`KesslerSystem`](js/systems/KesslerSystem.js:1). This creates a risk-reward tension: aggressive captures are faster but may create more debris than they remove.

### §5.5 Fragmentation Consequences

When the player causes fragmentation, consequences are **severe and escalating** (Q-5 decision):

| Consequence | Mechanic | Teaching moment |
|-------------|----------|-----------------|
| **Ground station scold** | [`CommsSystem`](js/systems/CommsSystem.js:1) delivers a sharp rebuke: *"HOUSTON: You just created 3 new fragments. That's the opposite of our job."* | Experience → explanation (three-beat pattern from [`LEARNING_THROUGH_PLAY.md §1.1`](LEARNING_THROUGH_PLAY.md:37)) |
| **Reputation penalty** | −10 reputation per fragment via [`ReputationSystem`](js/systems/ReputationSystem.js:1) (vs +10 per clean capture). A 5-fragment shatter = −50 rep. | Consequence — contracts require minimum rep |
| **Credit deduction** | −50 credits per fragment (insurance/liability charge). Ground station explains: *"Liability clause 7.3 — you break it, you buy the cleanup."* | Consequence — hits the wallet |
| **Kessler contribution** | Fragments count toward global [`KESSLER_FRAGMENT_LIMIT: 50`](js/core/Constants.js:69). Player-caused fragments accelerate the cascade. Not tracked separately — they ARE the cascade. | The ultimate consequence — sloppy work creates the apocalypse |
| **Demotion** (repeat offenders) | After 3 fragmentation events in one mission: contract downgrade. Ground station: *"Your capture license is under review."* | Escalating consequence |

**Teaching sequence:** First fragmentation → mild scold + warning (see §5.7 mercy rule). Second fragmentation → harder scold + full penalty. Third → contract consequences. This mirrors real mission ops where debris creation is a career-ending event for a flight controller.

### §5.6 Pre-Fire Risk Display

When the player has a target selected and the net is ready to fire, the [`TargetReticle`](js/ui/TargetReticle.js:1) shows two numbers:

```
  ┌───────────────────────┐
  │  Fragment XR-2194      │
  │  ──────────────────    │
  │  Capture:  92%  ████▓░ │
  │  Frag risk: 3%  █░░░░░ │
  │                        │
  │  Mode: 🔨 SLAM [Tab]  │
  │  [FIRE - Space]        │
  └───────────────────────┘
```

- **Capture %** = P_cling from §3.3, computed from net class match, relative velocity, distance, surface type.
- **Frag risk %** = fragmentation probability from §5.4, based on target fragility × impact energy.

Both numbers change in real-time as the player adjusts approach distance and velocity. **Closer approach = higher capture %, lower frag risk. Farther = riskier.** This creates the core skill loop: do you spend the delta-v and time to close distance, or fire from far and risk consequences?

### §5.7 First-Fragmentation Mercy Rule

**Consistent with beginner-first design.** The player's very first lifetime fragmentation event **waives all penalties** and instead triggers a HOUSTON warning + teaching tip:

**Mechanic:**
- Persist `playerHasFragmented: false` flag (default `false`) via [`PersistenceManager`](js/systems/PersistenceManager.js:1).
- On first fragmentation event in player's lifetime:
  - **Waive** all penalties: no Kessler injection, no reputation hit, no credit deduction.
  - **Emit** HOUSTON warning comms: *"First miss is on us. Next one costs."*
  - **Trigger** [`TeachingSystem`](js/systems/TeachingSystem.js:1) tip explaining frag mechanics and the Frag Risk % display.
- Set flag `playerHasFragmented: true`.
- From second event onward: apply full consequences per §5.5.

**Rationale:** Teaching without punishment on first offence. The player sees the consequences system (scold text, display of what *would* have happened), learns what fragmentation means, but isn't financially ruined by their first mistake. This matches the three-beat pattern: experience (fragments fly), consequence (warning message), explanation (teaching tip about Frag Risk %).

---

## §6 Per-Platform Net Classes

### §6.1 Class Definitions

| Property | Large Net (Mother) | Medium Net (Large Daughter) | Small Net (Small Daughter) |
|----------|-------------------|-----------------------------|---------------------------|
| **Internal code** | M-NET | LD-NET | SD-NET |
| **Launch platform** | Mother hex body (pod) | Weaver (Large Daughter) | Spinner (Small Daughter) |
| **Target envelope** | Intact stages, large dead sats (100–5000 kg) | Dead sats, small stages (10–500 kg) | Fragments, micro-debris, small parts (0.1–50 kg) |
| **Net diameter (deployed)** | 8.0 m | 5.0 m | 1.5 m |
| **Net mass (total)** | 1.95 kg | 0.68 kg | 0.12 kg |
| **Launch velocity** | 10 m/s | 10 m/s | 10 m/s |
| **Effective range (Dyneema Y0)** | 75 m | 75 m | 75 m |
| **Engagement envelope** | 100 m | 100 m | 100 m |
| **Spin rate** | 2 Hz | 4 Hz | 6 Hz |
| **Max capture mass** | 5000 kg | 500 kg | 50 kg |
| **Magazine pack (Dyneema Y0)** | 4 nets/pack | 2 nets/pack | 4 nets/pack |
| **Reload time** | 30 s (mechanical reload from magazine) | 15 s | 5 s |
| **Tether length** | 100 m (pod reel via centre-line guide ring, §2.9) | 100 m (daughter-mounted reel) | 100 m (daughter-mounted reel) |
| **Reel-in speed** | 2.0 m/s | 2.0 m/s | 3.0 m/s |
| **Tether reel-cycles (lifetime)** | 20 | 20 | 20 |
| **Replacement cost** | High (250 salvage credits) | Medium (100 credits) | Low (25 credits) |
| **Cling probability (typical)** | 0.65–0.80 | 0.55–0.80 | 0.75–0.90 (on appropriate targets) |
| **Feature flag** | `NET_TERMINOLOGY` (basic), `PER_PLATFORM_NETS` (class selection) | `PER_PLATFORM_NETS` | `PER_PLATFORM_NETS` |

### §6.1a Fleet Composition — Arm-Count Tech Ladder (Rev 5)

The Mother always carries **2 body-mounted Large Net pods** (§2.9). Daughter count varies by tech tier:

> **⚠️ Rev 6 (Config G) mass update:** Config G changes the mass breakdown — bus core is lighter (152.0 kg, smaller diameter, no internal reels), strut assemblies add 18.0 kg, ROSA replaces rigid wings. Net result: Y0 is 2 kg lighter. Config G canonical masses from [`ARM_PIVOT_ANALYSIS.md §10.11`](ARM_PIVOT_ANALYSIS.md:1385) supersede the Rev 5 values below.

| Tier | Daughters | Layout | Large Daughters (Medium Net) | Small Daughters (Small Net) | Front/Back Arms | Total Capture Platforms | Dry Mass | Wet Mass |
|------|-----------|--------|-----------------------------|-----------------------------|-----------------|------------------------|----------|----------|
| **Y0 Quad** (start) | 4 | 3-plane barrel-axial | 2 | 2 | 0 | **5** (1M + 2LD + 2SD) | **196.4 kg** | **242.4 kg** |
| **Y1 Hex** (unlock) | 6 | 3-plane barrel-axial | 3 | 3 | 0 | **7** (1M + 3LD + 3SD) | ~208 kg | ~254 kg |
| **Y3 Octo** (unlock) | 8 | 3-plane + F/B | 3 | 3 | 1F + 1B | **9** (1M + 3LD + 3SD + F + B) | ~222 kg | ~268 kg |

*Config G mass breakdown from [`ARM_PIVOT_ANALYSIS.md §10.11`](ARM_PIVOT_ANALYSIS.md:1375): bus core 152.0 kg + ROSA 6.0 kg + body-mount cells 3.0 kg + 4× strut assemblies 18.0 kg + daughters 17.4 kg = 196.4 dry. Propellant 46.0 kg → 242.4 wet. Daughter masses unchanged: [`WEAVER_MASS`](js/core/Constants.js:260) = 6.6 kg/LD; [`SPINNER_MASS`](js/core/Constants.js:261) = 2.1 kg/SD.*

**Y0 fleet composition (game start):** 1 Mother (2 Large Net pods) + 2 Large Daughters (Medium Net each) + 2 Small Daughters (Small Net each) = **5 capture platforms, 10 total nets at Y0 Dyneema** (8 Mother + 2×2 LD Medium + 2×4 SD Small = 8+4+8 = 20 nets at Y0... but more practically: 8 Large + 4 Medium + 8 Small = 20 nets across the fleet).

**Hex (Y1) and Octo (Y3) are Tech Ladder upgrades** unlocked via Shop + Shipyard (ST-9.8). Each upgrade requires docking at a Shipyard + credits + a "refit" mission. These are NOT free configuration choices — they are earned progression. See [`CROSSBOW_ARMS.md §16`](CROSSBOW_ARMS.md) and [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) ST-9.2 / ST-9.8.

### §6.2 Current Code Mapping

| Net class | Current code constant | Current value | New value (ST-9.4e) |
|-----------|----------------------|---------------|---------------------|
| Medium Net diameter | [`WEAVER_NET_SIZE`](js/core/Constants.js:131) | 5.0 m | 5.0 m (unchanged) |
| Medium Net max mass | [`WEAVER_MAX_CAPTURE_MASS`](js/core/Constants.js:132) | 500 kg | 500 kg (unchanged) |
| Small Net diameter | [`SPINNER_NET_SIZE`](js/core/Constants.js:150) | 1.5 m | 1.5 m (unchanged) |
| Small Net max mass | [`SPINNER_MAX_CAPTURE_MASS`](js/core/Constants.js:151) | 10 kg → 50 kg | Update to match Small Net spec |
| Large Net (Mother lasso) | [`LASSO_MAX_CAPTURE_MASS`](js/core/Constants.js:845) | 10 kg → 5000 kg | Dramatic upgrade — Mother net is the heavy-lifter |
| Large Net range | [`LASSO_RANGE`](js/core/Constants.js:839) | 200 m → 100 m | Engagement envelope; effective range ~75 m (§2.8) |
| Large Net speed | [`LASSO_SPEED`](js/core/Constants.js:840) | 10 m/s | 10 m/s (derived from 100 J spring ÷ 1.95 kg, §2.8) |

### §6.3 Tactical Doctrine

- **Multi-daughter clearing** (Small Net fleet sweep): Deploy daughters one at a time to different targets in a fragment cloud. Each daughter carries Small Nets and fires them under player command from ARM PILOT mode. The fleet operates sequentially — player cycles between daughters as they reach STATION_KEEP. Fast cycle time (5 s reload) enables high throughput. This is the "fishing fleet" operation. **Note:** 90% of this mechanic already exists in the [`ArmUnit.js`](js/entities/ArmUnit.js:1) FSM (DOCKED → LAUNCHING → TRANSIT → APPROACH → STATION_KEEP → NETTING → REELING → DOCKING) and [`ArmManager.js`](js/entities/ArmManager.js:1). ST-9.4e new work limited to: (1) Space fires daughter's net in ARM PILOT, (2) 30° angular check on deploy, (3) net-ammo count in fleet panel. **Do NOT** build swarm-AI, multi-agent coordination, or NavSphere arcs — the fleet management gameplay emerges from the existing arm state machine + sequential player attention.

- **Medium Net precision**: Single Large Daughter approaches a dead satellite, stations at 50 m, fires Medium Net with soft-catch velocity (≤3 m/s). Careful, deliberate capture — the "spearfishing" operation.

- **Large Net heavy lift**: Mother positions alongside an intact rocket stage, fires Large Net from pod at close range (≤100 m). The biggest net wraps the biggest targets. Rare — Mother typically delegates to daughters. The "harpoon whale" operation.

### §6.4 Magazine Pack System

Nets are stored in **standardised cylindrical magazine packs** that slot into the crossbow magazine rail. Each pack is a self-contained unit: pre-folded nets, each with its own tether spool section, stacked in launch order. When a net fires, the next rotates into position. When the pack is empty, it can be jettisoned (saves mass) or retained for scrap material ([`ForgeSystem`](js/systems/ForgeSystem.js:1)).

**Pack capacity scales with material tier** — thinner cord packs tighter (even though total net mass reduction is modest due to tungsten weights dominating):

| Material tier | Large Net pack | Medium Net pack | Small Net pack | Pack mass (Large Net, loaded) | Cost per pack |
|--------------|----------------|-----------------|----------------|-------------------------------|---------------|
| **Dyneema SK78** (Y0) | 4 nets | 2 nets | 4 nets | 8.3 kg | 250 credits |
| **Graphene-20** (Y1) | 5 nets | 3 nets | 6 nets | 5.3 kg | 400 credits |
| **Graphene-40** (Y2) | 6 nets | 4 nets | 8 nets | 5.6 kg | 600 credits |
| **Graphene-80** (Y3) | 7 nets | 5 nets | 10 nets | 6.1 kg | 900 credits |
| **Graphene-130** (Y4) | 8 nets | 6 nets | 12 nets | 6.8 kg | 1500 credits |

*(Pack mass increases at higher tiers because more nets per pack — the per-net mass drops but total pack mass grows with count. Cost reflects graphene manufacturing expense.)*

**Pack slot count per platform (see §2.9 for Mother pod integration):**

| Platform | Pack slots | Max nets at Y0 | Max nets at Y4 |
|----------|-----------|----------------|----------------|
| Mother | 2 Large Net pod slots (see §2.9) | 2 × 4 = 8 | 2 × 8 = 16 |
| Large Daughter | 1 Medium Net slot | 2 | 6 |
| Small Daughter | 1 Small Net slot | 4 | 12 |

The pack is a standard mechanical interface — no electronics, just a spring-fed tube with alignment pins. Swapping packs is a 30-second operation at a dock or resupply point.

### §6.5 Resupply Model *(DEFERRED — roadmap item, not Y0)*

> Resupply mechanics (drone delivery, depot rendezvous, scavenging derelict platforms) are deferred to a future design pass. At Y0, net packs are replenished between missions at the shop screen. The three resupply concepts (drone, depot, scavenging) are captured in the deferred work section of §10. The scavenging-wrecked-Octopus gameplay loop is particularly promising — "someone else tried this job and didn't make it" — but needs its own design doc.

### §6.6 Interface to ST-9.5 (Tether Wear)

Each net class shares the 20-reel-cycle lifetime tracked by [`ResourceSystem`](js/systems/ResourceSystem.js:1). Tether wear per operation:

| Operation | Wear cost (cycles) |
|-----------|-------------------|
| Net deploy + reel-in (success) | 1 |
| Net deploy + miss + reel-in | 1 |
| Net deploy + tangle + recovery reel | 2 (stress from tangle forces) |
| Tether cut (any cause) | Net lost; new net required |

**Material tier affects tether longevity:** Graphene tethers have higher fatigue resistance — reel-cycle limits increase: Dyneema 20 cycles → Graphene-20: 35 cycles → Graphene-40: 60 cycles → Graphene-80: 100 cycles → Graphene-130: 200 cycles.

---

## §7 Failure / Edge Cases

### §7.1 Net Snags on Tether Bridle

**Interface: ST-9.7** (Bridle-ring FEEP-plume exclusion geometry, [`CROSSBOW_ARMS.md §15`](CROSSBOW_ARMS.md:26)).

> **Rev 5 (1-DOF):** With planar tether exit (1-DOF yaw-only), the bridle snag geometry simplifies to a **2D check** in the dock-tangent plane. The plume-clearance test becomes a planar cone intersection rather than a 3D frustum check. This reduces computational cost and false-positive interlock triggers. The "strut-pitch-into-solar-panel" failure mode from 2-DOF Rev 1 is eliminated — the tether cannot pitch out of the dock-tangent plane under normal operation. *(2-DOF pitch-axis failure modes superseded by Rev 5 1-DOF adoption.)*

The Y-harness bridle connects a daughter's tether to the mother reel. If the net's tether runs close to the bridle ring during reel-in, the net or its rim weights can snag the bridle junction. Detection: tether load cell reads lateral force + reel stall. Recovery: reverse reel 5 m, daughter nudges laterally (FEEP cold-gas puff), retry. Fail-state: bridle tether damage → daughter recall for inspection.

### §7.2 Net Deploys But Fails to Spin Up

**Cause:** Rim-weight imbalance (manufacturing defect or prior micro-impact damage to a weight), or yo-yo despin cord jams.

Detection: optical spin sensor on launch rail reads < 0.5 Hz within 1 s of launch. Recovery: abort immediately — reel in unspun net. An unspun net cannot wrap or cling. Time cost: ~5 s (short tether payout + fast reel). No tangle risk from unspun net (mesh stays bundled).

Probability: 0.01 per launch (1%) — mechanical reliability.

### §7.3 Tether Snaps Mid-Reel

**Interface: ST-9.5** (Dyneema tether reel-cycle wear model).

If tether has accumulated >18 reel-cycles (approaching the 20-cycle limit), each subsequent reel-in has an increasing snap probability. Snap during loaded reel-in = net + captured debris lost. Snap during empty reel-in = net lost only.

Detection: sudden zero tension. Recovery: none — net is gone. The severed tether end reels in (the reel-side portion). Debris continues on its trajectory with a net wrapped around it (visual: drifting netted debris — future environmental storytelling).

Player mitigation: monitor tether wear via [`ResourceSystem`](js/systems/ResourceSystem.js:1) HUD indicator. Replace tethers before cycle 18.

### §7.4 Hostile Collision During Flight

**Interface:** [`CollisionAvoidanceSystem`](js/systems/CollisionAvoidanceSystem.js:1).

While the net is in flight (phases 2–4), a non-target debris object may cross the net's flight path. The existing CA system should:

1. Track the net projectile as a "friendly" object (exempt from dodge manoeuvres).
2. If CA detects an imminent cross-debris collision, emit `NET_CROSS_DEBRIS_WARNING`.
3. Player can choose: (a) let it happen (possible bonus catch per §4.4), or (b) trigger early reel-in to abort.

CA integration requires the net projectile position to be fed into the CA scan loop — currently [`CollisionAvoidanceSystem`](js/systems/CollisionAvoidanceSystem.js:1) only scans platform positions.

### §7.5 Daughter Tether Routing

See §4.7 for the parallel-routing + software-interlock design (Q-11 decision). The daughter's arm tether (to Mother) and net tether (to target) run on independent parallel axes. A fire-angle interlock prevents tether crossing. The 1-DOF yaw-only crossbow aim from [`CROSSBOW_ARMS.md §8`](CROSSBOW_ARMS.md:19) constrains net fire to ±30° in the dock-tangent plane — the interlock only blocks geometries that would create a physical crossing within that plane. *(Rev 4 referenced 2-DOF aim; Rev 5 reduces to 1-DOF yaw-only per Pivot A.)*

### §7.6 Velcro AO Protection (Pod Shutter)

**Q-12 decision.** Atomic oxygen erodes nylon Velcro hooks at ~1 µm/day at 350 km. Hooks are 100–200 µm tall — unprotected exposure would degrade them in 100–200 days. **Y0 mitigation: pod shutter.**

Each magazine pod has a spring-loaded cap (TRL 9, ~20 g) that seals the first net's Velcro hooks against AO erosion. Shutter opens on first fire command. Magazine-internal nets are sealed behind each other. **Result: zero AO degradation concern at Y0.**

**Y1+ roadmap:** For extended multi-mission campaigns, nets stored for long periods could accumulate slow degradation tracked by [`ResourceSystem`](js/systems/ResourceSystem.js:1) — e.g., −1% cling effectiveness per 30 in-game days on orbit. A pod shutter upgrade (Shop item) slows or eliminates degradation. Defer design to the environmental-effects sprint (BIG_PICTURE Q2, §30–§33).

---

## §8 Visual / Audio Cues

| Phase | Visual | Audio | Duration |
|-------|--------|-------|----------|
| **Windup** | Crossbow rail glows cyan; net package visible in cradle | Mechanical tension creak (rising pitch, 0.15 s) | 0.15 s |
| **Launch** | Muzzle flash (existing [`_muzzleFlash`](js/systems/LassoSystem.js:91)); net package streaks outward | Spring release "thwip" + tether unwind hiss | 0.2 s |
| **Flight** | Spinning octagonal mesh visible; 4–8 rim weight dots orbit the perimeter; tether line trails behind (coaxial: dark sheath + bright core, existing [`_tetherMesh`](js/systems/LassoSystem.js:63) / [`_tetherCore`](js/systems/LassoSystem.js:66)) | Low hum from spin (fades with distance) | 2–8 s |
| **Slam-wrap contact** | Radial spark burst (existing [`NET_SPARK_COUNT: 12`](js/core/Constants.js:869)); mesh deforms/wraps around target outline | Impact "clang" (metal-on-metal); Velcro "rip" sound (cling) | 0.4 s |
| **Tether brake** (cinch mode) | Tether flashes white (tension); net centre decelerates visibly; rim weights streak forward past debris | Sharp "twang" (tether tension snap); rising tone (weights accelerating forward) | 0.5 s |
| **Cinch closing** | **Drawstring line** (bright cyan) shrinks from full mesh diameter to 0.3× diameter. Edge-node positions (small bright dots) converge inward. Mesh goes **semi-transparent** behind the target (opacity shift). Combined with confirmation chime. No vertex-level mesh animation at Y0. | Mechanical "zip" sound (drawstring); click of solenoid latch | 2 s |
| **Secure success** | Green pulse travels along tether → platform; net tightens visually on target (slam) or bag gently settles (cinch); "SECURED" text flash | Confirmation chime (2-tone ascending) | 1 s |
| **Secure fail** | Red pulse; net goes limp / translucent; "MISSED" text flash | Sad descending tone | 0.5 s |
| **Reel-in** | Tether shortens; net (± debris) moves toward platform; pulse beads travel along tether (existing [`NET_PULSE_HZ: 2.0`](js/core/Constants.js:867)) | Reel motor whir (pitch rises as speed increases) | 1–5 s |
| **Tangle** | Tether turns amber/red; affected object(s) highlighted amber | Warning klaxon (brief) + "Tangle detected" comms | Until resolved |

**Cinch teaching animation — deferred to roadmap** (Q-3 decision). The tether-brake cinch is a novel concept that would benefit from a real-time PIP (picture-in-picture) inset in the bottom-right corner, showing the net from a side angle during cinch. This is a visual-polish sprint item, not Y0 scope. For Y0: the cinch simply works — drawstring line shrinks, confirmation chime plays. The Codex entry (§9) describes the concept in words. A stub event (`CINCH_FIRST_SUCCESS`) should be placed for [`TeachingSystem`](js/systems/TeachingSystem.js:1) to bind to later.

Visual details defer to a UX implementation sprint — this section establishes what information each cue must communicate, not pixel-level art direction.

---

## §9 Codex Entry Text

**Category:** TECHNOLOGY
**Title:** Capture Net
**Unlock trigger:** First net deploy (any class)

### Heritage

> Humans have used nets to catch what we cannot grab since prehistory. Cast nets, gill nets, trawl nets — every fishing culture independently invented mesh capture because it solves the fundamental problem: the target is irregularly shaped, possibly tumbling, and you can't predict exactly where you'll make contact. Orbital debris cleanup converged on the same solution.
>
> In 2018, the RemoveDEBRIS mission (University of Surrey / SSTL) demonstrated net capture in orbit for the first time — a spring-launched Dyneema mesh successfully wrapped a deployed CubeSat target at low relative velocity. JAXA's EDDE (Electro-Dynamic Debris Eliminator) concept proposed a net-dragging spacecraft sweeping through debris bands like an orbital trawler. ESA's ClearSpace-1 grappling demos explored robotic arms — but rigid arms need a specific grasp geometry. A net just *wraps*. The mesh conforms to whatever it touches, and friction-based cling holds it. No precision alignment, no force-torque sensing, no cooperative docking fixture required.
>
> Mesh beats rigid arms for the same reason fishing nets beat fishing rods: when the catch is unpredictable, cast wide.

### Operating Principle

> The Capture Net is a spinning disc of Dyneema SK78 mesh, kept open by tungsten rim weights under centripetal force. Launched from a crossbow rail, it spins up via a yo-yo despin mechanism (the same principle that stabilised Explorer 1 in 1958). In vacuum, with no air drag, the spinning disc stays open indefinitely.
>
> For durable debris — metal fragments, solid rocket bodies — the net slams into the target and wraps on contact. Velcro-hook fibres in the cord grip the surface, and the tether reels the bundle home. Simple, fast, proven.
>
> For delicate targets — a dead satellite with intact solar panels, a composite tank that would shatter on impact — the net uses a different trick: the **tether-brake cinch**. As the spinning disc approaches the target, the reel brakes the tether hard. The centre of the net stops, but the rim weights keep flying — Newton's first law, no air to slow them. They sweep past the debris on all sides, the mesh forms a bag, and a spring-loaded drawstring cinches the mouth closed behind the target. The debris floats inside a net bag with zero crushing contact. It's a purse seine in orbit.
>
> Three net sizes serve different targets: the Small Net for fragments and small parts (fast, deployable as a fleet), the Medium Net for dead satellites (precision cinch), and the Large Net for intact rocket stages (heavy lift). Nets come in reloadable magazine packs — Dyneema at launch, with Graphene-20 through Graphene-130 upgrades unlocking more nets per pack and longer range as the player progresses.

### Trivia

> *"Spider orb-weaver silk has a tensile strength of 1.1 GPa. Dyneema SK78 reaches 3.6 GPa — over three times stronger. Graphene fibre could reach 130 GPa. The spider builds a better shape; we build a stronger thread — and keep upgrading it."*

> *"The 'Octopus' name is aspirational at Y0 — the platform earns its arms through tech progression. Start with four, grow into eight. HOUSTON announces 'Octopus-class is fully operational' when the Y3 Octo refit completes."*

---

## §10 Resolved Questions

> **All design questions resolved at signoff 2026-04-26.** See [`CAPTURE_NET_QA.md`](CAPTURE_NET_QA.md) for analysis history.
> Twelve open items from Rev 3 §10 were reviewed, decided, and folded into §1–§9 above.

### Newly-Surfaced Concerns (from QA review)

| # | Concern | Status | Owner | Notes |
|---|---------|--------|-------|-------|
| 1 | **Spring-hub single-fire** — no retry if partial closure | **OPEN** | ST-9.4c | Spec 3× force margin + limit-switch confirm sensor (TRL 9). Partial closure is mechanically impossible at 3× margin. |
| 2 | **Solenoid EMI cross-talk** — 4–8 solenoids firing within 100 ms | **OPEN** | ST-9.4c | Stagger node fire 10 ms/node (total spread 40–80 ms). Energy trivial (25 mJ/node) but prevents radio beacon (Y1) interference. |
| 3 | **Pre-fire P_cling calc ≤1 ms/frame** — HUD real-time display | **OPEN** | ST-9.4c | Pre-compute surface-roughness and spin factors at target-lock time, not per-frame. 6 multiplicative factors must not stutter HUD. |
| 4 | **Reputation penalty calibration** — −10 rep / +10 rep ratio | **OPEN** | Playtest | A 5-fragment shatter = net −40 rep (−50 fragments + +10 capture). Playtest whether this feels fair for early-game mistakes. |
| 5 | **First-fragmentation mercy rule** | **✓ ACCEPTED** | §5.7 | First lifetime fragmentation waives penalties; HOUSTON warning + teaching tip instead. Integrated into §5.7. |

### Deferred to future design pass

- **Resupply model** (§6.5): Drone delivery, depot rendezvous, scavenging derelict platforms. Y0 = replenish at shop between missions.
- **Smart rim weight upgrade progression**: Y0 = basic edge nodes (tungsten + spring cinch + CR2032). Camera + radio = Y1 unlocks. Y2+ possibilities (accelerometers, IR, micro-thrusters) need dedicated upgrade-tree design.
- **Centre-line guide ring wear model**: Ceramic ring handles all reel-in tension. Should it be a replaceable part? Defer to resource-system sprint.
- **Cinch teaching animation** (Q-3): Real-time PIP inset preferred (bottom-right, side-angle view during cinch). Deferred to visual-polish sprint post-ST-9.4. Stub event `CINCH_FIRST_SUCCESS` for [`TeachingSystem`](js/systems/TeachingSystem.js:1).
- **Velcro AO slow-decay** (Q-12): Y1+ mechanic — −1% cling/30 days tracked by [`ResourceSystem`](js/systems/ResourceSystem.js:1). Pod shutter upgrade as Shop item.

---

### Resolved at Rev 5 (2026-04-26)

- **Strut DOF (Rev 5):** 1-DOF yaw-only adopted. Pitch axis dropped for vacuum reliability + planar tether departure. Halves actuator count (4 vs 8 at Y0; 8 vs 16 at Y3). Bridle math becomes 2D. Plume clearance is a planar cone test. Tangle scenarios reduce in count and probability. Off-axis target acquisition handled by whole-platform attitude rotation (existing FEEP/RCS). See Pivot A in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) completion log.
- **Arm count baseline (Rev 5):** Quad-4 Y0 with Hex Y1 / Octo Y3 tech ladder. Y0 fleet = 1 Mother (2 Large Net pods) + 2 Large Daughters (Medium Net) + 2 Small Daughters (Small Net). Hex and Octo unlocked via Shipyard refit + tech credits. See §6.1a and Pivot B in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) completion log.

*End of document. Implementation tracked as ST-9.4a through ST-9.4e in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).*
