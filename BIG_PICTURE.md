# Space Cowboy — Big-Picture Integration & V5 Roadmap

> Companion to [`HANDOFF.md`](HANDOFF.md:1). HANDOFF covers the **next shift** (tactical fixes, 9 improvement areas, 4 sprints). This document covers the **next year** — the strategic integration of UX, simulation depth, hardware redesign (Octopus V5), and education that turns Space Cowboy into the canonical "how orbital debris removal actually works" game.
>
> **⚠️ CONFIG G ADOPTED (2026-04-27):** The V5 arm geometry is now **Config G (barrel-axial top-collar, 3-plane layout, ROSA panels, strut-mounted reel)** per [`ARM_PIVOT_ANALYSIS.md §10`](ARM_PIVOT_ANALYSIS.md:801). Sections §11–§13, §29, §35, §36 below contain references to equatorial arm geometry that are superseded by Config G. The updated V5 baseline spec is at §35.5 below. For full Config G specs see [`ARM_PIVOT_ANALYSIS.md §10.11`](ARM_PIVOT_ANALYSIS.md:1236). For Epic 9 implementation specs see [`ARM_PIVOT_GAPS_EXPLAINER.md §W`](archive/ARM_PIVOT_GAPS_EXPLAINER.md).
>
> All code citations use `[`label`](path:line)` clickable form. All physics derived from first principles — no magic numbers.

---

## Table of Contents

**PART I — USER EXPERIENCE INTEGRATION (9 topics)**

1. [Comms Pane — Taller, Smarter, C-Key Doctrine](#1-comms-pane--taller-smarter-c-key-doctrine)
2. [Real-World Data Layer — Offline-First Debris, Satellites, Weather](#2-realworld-data-layer--offlinefirst-debris-satellites-weather)
3. [Mission Architecture — ISS Boss, Ground Stations, Scavenger Economy](#3-mission-architecture--iss-boss-ground-stations-scavenger-economy)
4. [Strategic Overview Map (V hotkey)](#4-strategic-overview-map-v-hotkey)
5. [Trajectory Trails — Mother & Arms (I-War heritage)](#5-trajectory-trails--mother--arms-iwar-heritage)
6. [Debris Visualization — Wireframe Parity, Flags, Textures](#6-debris-visualization--wireframe-parity-flags-textures)
7. [Earth Visualization — 16k Textures, Limb Distortion, VLEO Missions](#7-earth-visualization--16k-textures-limb-distortion-vleo-missions)
8. [NavSphere "Orb" — Self-Awareness, Selection Prominence, I-War Stalks](#8-navsphere-orb--selfawareness-selection-prominence-iwar-stalks)
9. [Red Tracking-Line 90° Bug — Root Cause Found](#9-red-trackingline-90-bug--root-cause-found)

**PART II — OCTOPUS V5 REDESIGN**

10. [Heritage Summary — What V3 and V4 Taught Us](#10-heritage-summary--what-v3-and-v4-taught-us)
11. [V5 Design Goals & Constraints](#11-v5-design-goals--constraints)
12. [Configuration Trade Study — Three Candidates](#12-configuration-trade-study--three-candidates)
13. [Crossbow Mechanism Refinements](#13-crossbow-mechanism-refinements)
14. [GSL Tether at 10 km — Scavenge-Sphere Doctrine](#14-gsl-tether-at-10-km--scavengesphere-doctrine)
15. [Dual-Opposite Release & Elastic Momentum Transfer](#15-dualopposite-release--elastic-momentum-transfer)
16. [Ablation Propulsion for Retrograde Targets](#16-ablation-propulsion-for-retrograde-targets)
17. [BeiDou-3 Class Laser Comms & YOLO Edge Detection](#17-beidou3-class-laser-comms--yolo-edge-detection)
18. [Tether Attachment vs Ion Thruster Plume](#18-tether-attachment-vs-ion-thruster-plume)

**PART III — EDUCATIONAL VISUALIZATION SUITE**

19. [Teaching Moments Map — When to Introduce What](#19-teaching-moments-map--when-to-introduce-what)
20. [Porkchop Plots — ΔV vs Launch/Arrival Date](#20-porkchop-plots--v-vs-launcharrival-date)
21. [MOID — Minimum Orbit Intersection Distance as Risk Gauge](#21-moid--minimum-orbit-intersection-distance-as-risk-gauge)
22. [Lambert's Problem on the Strategic Map](#22-lamberts-problem-on-the-strategic-map)
23. [Clohessy-Wiltshire Accuracy Band](#23-clohessywiltshire-accuracy-band)
24. [Cluster Transfer Ellipse + Countdown](#24-cluster-transfer-ellipse--countdown)

**PART IV — SPACECRAFT ENGINEERING REALITY CHECK**

25. [TRL Classification — What Counts as "Real"](#25-trl-classification--what-counts-as-real)
26. [Docking — What Actually Works in Orbit](#26-docking--what-actually-works-in-orbit)
27. [Rendezvous — The GPS → LIDAR → Camera Ladder](#27-rendezvous--the-gps--lidar--camera-ladder)
28. [Tether Reality — The Graveyard of Failed Demos](#28-tether-reality--the-graveyard-of-failed-demos)
29. [Capture Net — Spinning Mesh Capture System](#29-capture-net--spinning-mesh-capture-system)
30. [Space Environment — What Kills Hardware](#30-space-environment--what-kills-hardware)
31. [Materials & Thrusters — The Flight-Proven Registry](#31-materials--thrusters--the-flightproven-registry)
32. [Power & Batteries — Conservative DOD Wins](#32-power--batteries--conservative-dod-wins)
33. [Redundancy Doctrine — Triple-String Where It Counts](#33-redundancy-doctrine--triplestring-where-it-counts)
34. [GSL Near-Tech — Honest Assessment of the Upgrade](#34-gsl-neartech--honest-assessment-of-the-upgrade)
35. [V5 Design Audit — Keep / Defer / Kill](#35-v5-design-audit--keep--defer--kill)

36. [Technology Upgrade Ladder — AI-Accelerated Roadmap](#36-technology-upgrade-ladder--ai-accelerated-roadmap)

**PART V — INTEGRATION PLAN**

37. [Dependency Graph — What Must Happen First](#37-dependency-graph--what-must-happen-first)
38. [Quarterly Roadmap — 12-Month View](#38-quarterly-roadmap--12month-view)
39. [Acceptance Criteria per Epic](#39-acceptance-criteria-per-epic)

---

# PART I — USER EXPERIENCE INTEGRATION

## 1. Comms Pane — ✅ Shipped Epic 5 · Full spec: [archive/BIG_PICTURE_EPIC_5_6_HISTORY.md](archive/BIG_PICTURE_EPIC_5_6_HISTORY.md#1-comms-pane--taller-smarter-c-key-doctrine)

---

## 2. Real-World Data Layer — ✅ Shipped Epic 6 · Full spec: [archive/BIG_PICTURE_EPIC_5_6_HISTORY.md](archive/BIG_PICTURE_EPIC_5_6_HISTORY.md#2-real-world-data-layer--offline-first-debris-satellites-weather)

---

## 3. Mission Architecture — ISS Boss, Ground Stations, Scavenger Economy

### 3.1 The Core Insight — Missions Are Already a Design Void

[`TrawlManager`](js/systems/TrawlManager.js:110) is the only mission-like sequence. It auto-picks `clusters[0]` at [`TrawlManager.js:55`](js/systems/TrawlManager.js:55), denying player agency. [`GAME_DESIGN.md`](GAME_DESIGN.md:1) describes "jellyfish trawl" as the core loop but the **containing narrative is absent**. §4.8 of [`HANDOFF.md`](HANDOFF.md:1) addresses this tactically; below is the **strategic content library**.

### 3.2 Mission Types (tier-gated by skill mastery)

| Tier | Type | Duration | Example |
|------|------|----------|---------|
| 1 | **Single Target** | 2–5 min | "Capture Cosmos-1408 frag #482" — 1 lasso, 1 tether pull |
| 2 | **Cluster Sweep** | 8–15 min | "SSO cluster at 780 km × 98° — mass quota 400 kg" |
| 3 | **Contract Run** | 15–30 min | "Station-keep near target, scan 3 defunct-sats, select highest-value" |
| 4 | **Rescue** | 10–20 min | "Deploy to contested altitude — recover lost daughter arm" |
| 5 | **Boss: ISS Dodge** | 30–45 min | Clear debris from ISS projected track in next 6 h |
| 6 | **Campaign: Constellation** | multi-session | Permanent clearing of a Starlink shell |

### 3.3 The ISS "Boss" Event

The ISS performs ~1–2 debris-avoidance manoeuvres per year (real historical: 35 since 1999). Make this a **recurring boss event** in-game:

**Setup** — Catalog includes ISS TLE (`norad 25544`). When game-time advances 6 months, a scripted event fires:
1. HOUSTON▸ "Conjunction alert: Cosmos-1408 debris on ISS intersect. 38 hours to TCA."
2. A glowing **red corridor** renders on the [strategic map (§4)](#4-strategic-overview-map-v-hotkey) — the ISS track with debris intersect marked.
3. Player choice:
   - **Intercept** — go to 410 km / 51.6°, clear 5–10 specific fragments before TCA. Reward: "ISS Saver" achievement + 10k credits + Codex unlock.
   - **Decline** — ISS performs an autonomous 0.5 m/s reboost (historical realism). No reward but no penalty.

**Failure mode** — if player goes to intercept but misses the timeline, ISS still reboosts BUT the simulation teaches the lesson: "ISS burned 3 kg hydrazine at ~$40k — your miss cost them."

**Ground Station Attention** — During boss events, HOUSTON chatter density triples. Ground stations (DSN, ESTRACK, GSN) get named in messages: "Canberra acquired your downlink — stand by for update." Teaches real ground-segment operations.

### 3.4 Ground Station Pass Windows

Add `ground-stations.json` with real GSN/ESTRACK locations. A [`GroundStationSystem`](js/systems/GroundStationSystem.js:1) (new) computes line-of-sight windows. When in pass:
- Data streams to Earth (salvage reports get confirmed & credited)
- HOUSTON chatter enabled (outside pass, only pre-canned voice samples and delayed priority messages)
- Firmware upgrades can be downloaded (ties into shop/upgrade system)

Teaches **contact-window ops** — real satellites only get 4-8 ground passes / day.

### 3.5 Scavenger Economy — ΔV as Lifeblood

Player starts at VLEO (220 km / 51.6°) — the scavenger origin. To reach boss-level orbits (ISS @ 410 km or GEO @ 35,786 km), player must **scavenge ΔV** from cheaper debris first:

1. **Salvage xenon** from Starlink defunct units → refuel electric thrusters
2. **Salvage hydrazine** (dangerous! [`HUD.showTetherSnapAlert`](js/ui/HUD.js:1367) heritage — HAZMAT warning) → chemical thrusters for big burns
3. **Salvage GaAs solar cells** → panel repair, higher power = longer ablation
4. **Salvage Ti/Al** → forge ingots → sell → credits → buy upgraded crossbow springs

This creates a natural **ΔV-economy curve**: VLEO (free, easy) → LEO-Mid (cheap, medium) → ISS (expensive, risky) → GEO (end-game).

Already partially scaffolded via [`Constants.FUELS`](js/core/Constants.js:547) and [`Constants.METALS`](js/core/Constants.js:407). Wire it up.

### 3.6 Dynamic Events (MW2-style)

- **Solar storm** (seeded from §2.5 replay) — sudden Kp=8, solar panel output drops 60% for 2 h. Force player to budget battery.
- **Starlink launch window** — new satellites rise through LEO-Low; player must stay clear of launch corridor for 20 minutes.
- **Cascade seed** — a high-risk debris-debris conjunction happens nearby. Player can watch the fragments spawn, or try to grab the big parent before it shatters.
- **Rival ADR** — occasional "ClearSpace-2 has acquired your primary target" — race / cooperate.

### 3.7 Files to touch
- New: `js/systems/MissionSystem.js` — mission registry, spawn, state machine
- New: `js/systems/GroundStationSystem.js`
- [`js/systems/TrawlManager.js`](js/systems/TrawlManager.js:110) — accept player-selected cluster (remove auto-pick at :55)
- [`js/ui/BriefingScreen.js`](js/ui/BriefingScreen.js:1) — real mission briefing with cluster picker
- [`js/ui/SweepReportUI.js`](js/ui/SweepReportUI.js:1) — mission debrief with ΔV cost vs reward

---

## 4. Strategic Overview Map (V hotkey)

### 4.1 Current State

[`OrbitMFD`](js/ui/OrbitMFD.js:1) renders a 320 × 320 px top-down polar orbit view, toggled with `M` at [`:1`](js/ui/OrbitMFD.js:1). It shows player + selected-target orbits as ellipses and draws Hohmann transfer arc. Good but **2D polar only** and **selected-target-centric** — doesn't convey the whole catalog.

### 4.2 The Proposal — `V` Overview Map

Add a **full-screen 3D strategic overlay** on `V` (mnemonic: "View"):

- **3D Earth** (same textures as main scene but at half res) centered
- **All 7 altitude bands** visible as translucent spheres
- **Inclination bins** shown as great-circle ribbons (color-coded by cluster density)
- **Popular orbits** labeled — ISS, Starlink, SSO, GPS, GEO ring
- **Player position** — bright dot + orbit trail (thin white line showing next ~2 orbits)
- **Selected target** — bright cyan orbit ring
- **Mission corridors** — red translucent band for ISS conjunction events
- **Ground station footprints** — green cones projected upward from surface

**Interaction:**
- Orbit controls (drag to rotate, scroll to zoom). `V` again closes.
- Click a cluster → sets it as trawl target, returns to main view.
- Keyboard: arrow keys rotate, `+` / `-` zoom.

**Not a pause** — the strategic map runs at quarter-speed game time (player can think without full halt). Inspired by [`Orbiter`'s](https://en.wikipedia.org/wiki/Orbiter_(simulator)) map view + Frontier: Elite 2's galactic map.

### 4.3 Teaching Moments Integrated

- Mouse over an orbit → readout: SMA, ecc, inc, period, revs/day
- "FIND ME A TRANSFER" hint → highlight the 2-3 cheapest-ΔV targets from current position (Hohmann approximation)
- Discoveries (§19) tooltip on first-see: "Prograde orbits (0-90°) are cheaper from Cape Canaveral"

### 4.4 Files to touch
- [`js/ui/OrbitMFD.js`](js/ui/OrbitMFD.js:1) — keep as 2D planner (M); add:
- New: `js/ui/StrategicMap.js` — full-screen 3D, `V` hotkey
- [`js/systems/InputManager.js`](js/systems/InputManager.js:1) — bind `V`
- [`js/core/Constants.js`](js/core/Constants.js:811) — add `STRATEGIC_MAP` block (zoom defaults, colors)

---

## 5. Trajectory Trails — ✅ Shipped Epic 5 · Full spec: [archive/BIG_PICTURE_EPIC_5_6_HISTORY.md](archive/BIG_PICTURE_EPIC_5_6_HISTORY.md#5-trajectory-trails--mother--arms-iwar-heritage)

---

## 6. Debris Visualization — ✅ Shipped Epic 6 · Full spec: [archive/BIG_PICTURE_EPIC_5_6_HISTORY.md](archive/BIG_PICTURE_EPIC_5_6_HISTORY.md#6-debris-visualization--wireframe-parity-flags-textures)

---

## 7. Earth Visualization — ✅ Shipped Epic 5 · Full spec: [archive/BIG_PICTURE_EPIC_5_6_HISTORY.md](archive/BIG_PICTURE_EPIC_5_6_HISTORY.md#7-earth-visualization--16k-textures-limb-distortion-vleo-missions)

---

## 8. NavSphere "Orb" — ✅ Shipped Epic 5 · Full spec: [archive/BIG_PICTURE_EPIC_5_6_HISTORY.md](archive/BIG_PICTURE_EPIC_5_6_HISTORY.md#8-navsphere-orb--self-awareness-selection-prominence-iwar-stalks)

---

## 9. Red Tracking-Line 90° Bug — ✅ Shipped Epic 5 · Full spec: [archive/BIG_PICTURE_EPIC_5_6_HISTORY.md](archive/BIG_PICTURE_EPIC_5_6_HISTORY.md#9-red-tracking-line-90-bug--root-cause-found)

---

# PART II — OCTOPUS V5 REDESIGN

## 10. Heritage Summary — What V3 and V4 Taught Us

### 10.1 V3 Octopus — The Baseline (TRL 6+)

[`archive/V3 Octopus.md`](archive/V3%20Octopus.md:1) established:
- **Distributed intelligence** — 8 arms (4 Weavers + 4 Spinners) each autonomous; central core only sets high-level intent.
- **Optical nervous system** — single 808 nm core laser + MEMS scanning mirror power-beams up to 30 W per arm (at 1 km), carries 1 Mbps data, and provides ±2 cm ranging. Replaces 8 UHF radios (no spectrum licence). Core laser 2 kg; per-arm optics 70–120 g.
- **MRR uplink** — modulated retro-reflector (15 g, 50 mW, 1-10 Mbps) at each arm returns modulated laser to core.
- **Tethers = 7 functions** — structure + power + data + EDT + nav + vibration sensing + steering tendon. 1.2 kg/km.
- **Nets beat everything** for tumbling debris (>90% of population tumbles <10°/s). RemoveDEBRIS heritage TRL 7.
- **EPM docking** — Electro-Permanent Magnet. Zero-power hold after latch. 80% mass reduction vs electromagnet.
- **System mass** 275 kg wet (30% lighter than V2 Spider).

### 10.2 V4 Opussy — The GSL Upgrade (TRL 4 → 6 by 2026)

[`archive/V4 Opussy.md`](archive/V4%20Opussy.md:1) showed:
- **Graphene Superlattice** at 50 GPa gives 9× specific strength over Dyneema.
- **Tether mass revolution** — 2 km GSL tether = 30 g of load-bearing strand (vs 2,400 g Dyneema). Plus 0.2 kg copper (still needed for conductivity) + 92 g SMA tendons = ~300 g total (8× lighter).
- **Range option** — at V3 tether mass budget (2,500 g), GSL reaches **12.5 km** (6× V3 range). Capture volume scales r³ = **244× larger sweep**.
- **Spot-welded nets** retain full strand strength (no knot loss). 5×5 m net drops from 1,265 g to **129 g** (90% lighter).
- **HBN coating** (hexagonal boron nitride) solves VdW self-adhesion, provides low friction + insulation + UV protection. One coating, four problems solved.
- **Electrostatic synergy** — GSL core + HBN dielectric = built-in JAXA electrostatic pad. 3 kV on the net mesh → 108–216 N grip on conductive debris surfaces (free hardware).

### 10.3 V5 Crossbow — The Mechanical Justification ([`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md:1))

Existing V5 work replaced the FEEP-thrust "gamified" arm launch with a spring-loaded crossbow (TRL 9). Key numbers:
- Weaver crossbow: k=17,600 N/m, draw=0.25 m → 550 J stored → launch at 10 m/s.
- Release time 40 ms. Reload 55 s base, 15 s with 60 W motor upgrade.
- FEEP thrusters retained for fine approach (0-0.5 m/s) — real engineering use.

---

## 11. V5 Design Goals & Constraints

### 11.1 Goals

1. **Same-mass, longer reach** — exploit GSL to reach 10 km without mass penalty (§14).
2. **Modular scavengability** — dead mother arms recoverable, parts cross-compatible between variants. A player late-game should harvest a derelict V3 to extend their V5.
3. **Configuration flexibility** — same bus supports multiple arm arrangements (umbrella, perimeter, linear), swappable at shipyard.
4. **Synthetic aperture when perpendicular / combined thrust when parallel** — arms can cooperate for scanning (wide baseline) or propulsion (parallel vectors). See §12.
5. **Zero silent multipliers** — every force/velocity derived from physics, no `ARM_GAMIFIED_THRUST_MULT`.

### 11.2 Constraints

- **Three.js rendering budget** — 4 arms (Y0; up to 8 at Y3) × visible tether + net pack + FEEP plume = ~40–80 draw calls. Instance aggressively.
- **Scene scale** — `M = 1e-5` (1 scene unit = 100 km). A 10 km tether = 0.1 scene units. Visible and geometrically correct.
- **Simulation budget** — @60 fps, per-frame physics for 4–8 arms (tier-dependent) + 200 debris + player = <16 ms. Current autopilot + conjunction systems already use ~3 ms (budget audit pending).

### 11.3 Constants to Introduce

Add to [`js/core/Constants.js`](js/core/Constants.js:1):

```js
OCTOPUS_V5: {
  CONFIGURATIONS: {
    QUAD_LINEAR:       { daughters: 4, armGeom: '2front+2back', bow: 'front+back' },  // game-start
    HEX_UMBRELLA:      { daughters: 6, armGeom: 'hex',       bow: 'front+back' },    // mid-game upgrade
    DOUBLE_UMBRELLA:   { daughters: 8, armGeom: 'hex',       bow: 'front+back' },    // late-game refit
    MIXED_3W_3S:       { daughters: 6, types: ['W','W','W','S','S','S'] },
    MIXED_2W_2S:       { daughters: 4, types: ['W','W','S','S'] },
    MIXED_4W_4S:       { daughters: 8, types: ['W','W','W','W','S','S','S','S'] },
  },
  DEFAULT_CONFIG: 'MIXED_2W_2S',  // game-start: Quad Linear with 2W+2S
  STRUT_DOF:          1,       // 1-DOF yaw-only pivot on each strut (Rev 5; was 2-DOF Rev 1)
  STRUT_SLEW_RATE:    60,      // °/s, maraging steel + harmonic gear (Rev 5: single axis)

  // --- Tether (honest dates per §28.3 and §36 upgrade ladder) ---
  TETHER_MATERIAL:         'DYNEEMA_SK78',  // game-start TRL 9
  TETHER_REACH_KM:         2,               // game-start; 4/6/10 via upgrade ladder §36
  TETHER_REEL_CYCLE_LIMIT: 20,              // full reel-out/reel-in cycles before fatigue lockup (per §28.3)
  TETHER_REEL_WARN_AT:     15,              // amber HUD flag at 75% wear
  TETHER_JAM_PROB:         0.01,            // per deployment, compound w/ wear (§28.3)

  // --- Feature flags, TRL-gated. Each unlocks through Shop/Codex, never at start. ---
  FEATURE_HBN_COATED:      false,  // year-1 upgrade (2026, TRL 7)
  FEATURE_GSL_ENG:         false,  // year-2 upgrade (2028, TRL 7, engineering units — expect failures)
  FEATURE_GSL_OPS:         false,  // year-3 upgrade (2030, TRL 8)
  FEATURE_GSL_10KM:        false,  // year-4+ stretch (2032+)
  FEATURE_POWER_BEAM_50W:  false,  // year-3 exotic upgrade (projected TRL 6-7)
  FEATURE_POWER_BEAM_500W: false,  // year-4 exotic upgrade (projected TRL 7-8)
  FEATURE_ABLATION_MOTHER: false,  // mid-game Shop upgrade after 3 prereqs (§16.4)
  FEATURE_MPD_THRUSTER:    false,  // end-game exotic, requires reactor + radiator prereqs
},
```

**Every feature flag above defaults `false`** — the game starts on the TRL 9 baseline (Dyneema 2 km + Hall thrusters + GaAs solar + onboard daughter batteries). Flags flip `true` only via Shop purchases or Codex-gated unlocks. This is how the game teaches "what we have now" vs "what's coming".

---

## 12. Configuration Trade Study — Three Candidates

### 12.1 Candidate A — **Hex Umbrella** (conservative evolution of V3)

```
      FRONT (+Z, prograde)
             ▲
             │
    ┌───W1───┼───S1───┐         Bow-front: W0 (centerline)
   W4        │        S4        Bow-back:  W5 (centerline)
    │       OCTA       │        6 daughters on struts at
    │     GONAL BUS    │        hex positions 60° apart
   S3        │        W2
    └───S2───┼───W3───┘
             │
             ▼
      BACK (-Z, retrograde)
```

**Pros:**
- Direct V3 evolution — minimum redesign risk
- Hex arrangement: every daughter has 2 neighbours at 60° for coordinated grabs
- 6 daughters + 2 bow-mounted = 8 total (3 W + 3 S hex + 1 W front + 1 W back)

**Cons:**
- Mass asymmetry when any 1-2 daughters deployed (RCS load)
- Limited for synthetic aperture — hex provides baselines up to 0.8 m (bus width), inadequate for radar SAR

**ΔV cost:** near-zero redesign; heritage all mass/thermal analysis from V3/V4.

### 12.2 Candidate B — **Double Umbrella** (single-ended vs double-ended)

```
   FRONT UMBRELLA                  BACK UMBRELLA
        ▲                               ▲
        │                               │
   W1 ─ W2 ─ W3                     S1 ─ S2 ─ S3
      ╲ │ ╱                            ╲ │ ╱
       BUS      ←──── centerline ────     BUS
                          │
                          │
                   (single spine, 2 m long)
                          │
                          │
                       2x bus
```

Two variants:
- **Single-ended** — only FRONT umbrella (3 W + 3 S at front); back is thruster/comms only. Best for prograde targets (vast majority of ADR encounters).
- **Double-ended** — 3 W front + 3 S back (or mixed), bow crossbows front-and-back.
- **Centered** — 4 W/S at front, 4 W/S at back, longer spine with modular service bay in middle.

**Synthetic aperture:** Daughters at 2 m baseline (bus length) give much better angular resolution for LIDAR SAR scans. **Combined thrust:** 3 front daughters + bow-front crossbow can all fire arms in the same prograde direction simultaneously for high-energy captures or boost-burns with arm tethers acting as tension lines.

**Pros:**
- Dedicated front/back reach — no umbrella shadow, each hemisphere fully served
- SAR baseline 2× hex
- Modular service bay (mid-spine) for upgrade/scavenge docking

**Cons:**
- ~15% more structural mass (spine)
- More complex reel routing (tethers must not cross spine)

### 12.3 Candidate C — **Quad Linear** (minimalist / scavenger origin)

```
     W1 ── W2 ──── BUS ──── S1 ── S2
                    │
                 (thrust)
                    │
                 ANTENNAE
```

4 daughters in a line (2 front + 2 back); perfect **tether momentum transfer** axis.

**Pros:**
- Simplest mass — ~60% of Hex Umbrella
- Best for **elastic tether transfer** (§15) — linear arrangement gives clean vector
- Ideal scavenger starting kit (2 W + 2 S fits in a Falcon 9 rideshare slot)

**Cons:**
- No synthetic aperture
- Only 4 arms — limited to small clusters

**Recommendation** — ship Candidate C as the **new-player starter**; Candidate A as **mid-game upgrade**; Candidate B as **late-game / Shipyard refit**. Player builds up through configurations matching their mission ambition.

### 12.4 Strut Design — 1-DOF Yaw Only (Rev 5)

> *(Rev 5 pivot, 2026-04-26. Rev 1 specified 2-DOF pitch+yaw, 180° range. Superseded — see footnote below.)*

Each daughter is mounted on a **short strut** (0.3–0.5 m) extending radially from one of the Mother's octagonal bus faces:
- **Yaw pivot** (±30°) — single rotary joint at the **strut-bus junction** (the base of the strut where it meets the octagonal bus face). Rotation axis = **bus face normal** (the radial direction from bus centre through the dock point). The daughter sweeps ±30° within the **dock-tangent plane** — the plane perpendicular to the face normal at the dock location. Tether always exits in this plane.
- ~~**Pitch pivot** (±90° from bus-radial)~~ — **DROPPED Rev 5.** Off-axis targeting handled by whole-platform attitude rotation (existing FEEP/RCS), not strut articulation.

```
  TOP VIEW — 1-DOF Yaw Sweep at one dock face

            bus face normal (radial) = pivot axis
                     ↑
                     │
          ╲          │          ╱   ← ±30° yaw sweep
           ╲  dock-  │  -tangent╱     in this plane
            ╲ plane  │   plane ╱
             ╲       │       ╱
    ──────────[PIVOT]─────────── bus face (octagonal)
              (strut base)
              │
              │ strut (0.3–0.5 m)
              │
           [DAUGHTER]
```

This replaces V3's fixed docking cavity with a pointable mount. Implementation: single harmonic-gear joint at the strut base (TRL 9, used on Mars Sample Return Lab arm). Power: 5 W during slew; 0 W holding. *(Rev 1 had two joints in series; Rev 5 halves actuator count.)*

**Why 1-DOF is sufficient (Rev 5 rationale):**
- **Halves actuator count** (4 at Y0, 8 at Y3 — vs 8/16 with 2-DOF) → fewer vacuum failure points
- **Tether always exits in dock-tangent plane** → deterministic; bridle math becomes 2D, plume-clearance is a planar cone test, tangle scenarios drop in count
- **Off-axis target acquisition** handled by whole-platform attitude rotation (existing FEEP/RCS) — a well-proven operation
- **Simpler player UI**: single yaw dial vs 2-axis aim widget
- **Pre-aim** — before firing, player rotates strut yaw so the bow aligns with target in-plane.
- **Post-capture drag rotation** — after netting, daughter can swing inward to dock at nearest cavity (minimum reel-in time).

> *Footnote: 2-DOF was considered Rev 1 (2026-04-26 early draft); reduced to 1-DOF Rev 2 (2026-04-26) for vacuum reliability + planar tether departure. See [`CROSSBOW_ARMS.md §25.4`](CROSSBOW_ARMS.md) and [`CAPTURE_NET.md §4`](CAPTURE_NET.md) tangle analysis.*

---

## 13. Crossbow Mechanism Refinements

### 13.1 Aimable Crossbow vs Aimable Mother vs Gimbal

Three ways to aim a crossbow shot:
1. **Aim the mother** — rotate the whole bus so the crossbow boresight points at target. Slow (RCS-limited), costs ΔV, but simplest.
2. **Aimable crossbow** — gimballed crossbow mount with ±30° range. Fast (~1 s slew), mechanically complex, small recoil correction.
3. **Aimable daughter (on strut)** — §12.4 above. Daughter's strut pivots first (1-DOF yaw, ±30° in dock-tangent plane); then daughter's own body-mounted bow fires.

**Recommendation (Rev 5):** Daughter-body crossbow on a **1-DOF yaw-only strut** (±30° in dock-tangent plane). Off-axis targets beyond ±30° are acquired by whole-platform attitude rotation (existing FEEP/RCS). The bus's Hall thrusters remain free for orbit-keeping and recoil compensation. *(Rev 1 recommended 2-DOF strut; Rev 5 reduces to 1-DOF for reliability. See [`CROSSBOW_ARMS.md §25.4`](CROSSBOW_ARMS.md).)*

### 13.2 Crossbow Reload Physics (from V5 bible)

[`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md:170) gives:
- Base motor (15 W): Weaver reload 55 s, Spinner 20 s
- Upgraded (30 W): 30 s / 10 s
- Rapid-fire (60 W): 15 s / 5 s

**Gameplay effect:** reload tension is **real physical time**, not a cooldown timer. A player who fires all 6 hex daughters in parallel has 30-55 s where the ship is defenceless and must avoid threats. High-risk, high-reward.

### 13.3 Safety Interlock

Hall thruster plume aft × crossbow firing aft = arm in plume. Current [`StatusPanel.js:1298`](js/ui/hud/StatusPanel.js:1298) already shows `THR LOCK` warning. Wire it to ArmManager: if main thruster was fired in last 60 s, block aft-crossbow launch. Ablation mode (§16) can override since it uses retrograde-facing only.

---

## 14. GSL Tether at 10 km — Scavenge-Sphere Doctrine

### 14.1 Numbers

Per V4 §2.4: at V3 mass budget (2,500 g/tether) with GSL at 50 GPa, practical reach is **12.5 km**. Call it **10 km** for design margin (covers RF/optical nav drift at extended range).

**Sphere of operation:** with 2 daughters on opposite struts at 10 km reach, the *scavenge sphere* is 20 km diameter around the mother. A single mother can sweep a 20 km × 10 km × 10 km box = **2,000 km³** of space per orbital pass. Sufficient to clear entire SSO clusters in one session.

### 14.2 GSL Reel Geometry

10 km of 0.113 mm diameter GSL fibre (V4 §2.1, 500 N breaking):
- Cross-section 0.010 mm² → volume 0.010 × 10,000 = 100 mm³ = 0.1 cm³
- With HBN coating (1 µm) and copper conductor (30 AWG, 0.05 mm²): volume ~600 mm³ = 0.6 cm³
- On a 5 cm diameter reel: required spool width **~3 cm** (packing factor 0.7).

A 10 km tether fits on a **reel the size of a hockey puck**. This is the single most dramatic engineering insight of V5: *a 10-km-reach mother has the same reel geometry as a V3 2-km-reach mother*.

### 14.3 Power Budget at 10 km

From V3 §4.2: at 10 km, laser spot Ø = 0.5 m (with 20 cm aperture). Spinner PV (10 cm) captures 4% → `P_elec ≈ 0.5 W`. Insufficient for FEEP approach. Workarounds:
1. **EDT propulsion** — 10 km tether at 100 mA in Earth's field generates ~25 mN. Enough for slow orbit matching.
2. **Battery reserve** — arms carry 50 Wh for 15-minute autonomy. Good for capture + hold.
3. **Two-shot rendezvous** — reel in to 2 km for power top-up, then re-extend. Teaches operational ΔV discipline.

### 14.4 Reel-In = Zero ΔV

[`GAME_DESIGN.md §2`](GAME_DESIGN.md:1) already highlights this as the core jellyfish-trawl insight. With 10 km tether, it's amplified: the player can throw a daughter at 10 m/s, catch a 500 kg target 5 km away, and reel back in — **all thrust work was done by the spring and the reel motor**. Propellant is only spent on fine APPROACH and detumble phases.

This teaches the most important real-world ADR lesson: **tethers are free ΔV**.

---

## 15. Dual-Opposite Release & Elastic Momentum Transfer

### 15.1 Dual-Release Stabilisation

Firing a single crossbow at 10 m/s imparts -10 m/s × (m_arm / m_mother) recoil on the mother:
- Weaver (11 kg) fired from 275 kg mother: recoil = 0.4 m/s. Measurable!
- Spinner (3.7 kg): recoil = 0.13 m/s.

Over 100 shots a mission: cumulative ΔV spent on recoil compensation = 40 m/s (Weaver). That's non-trivial.

**Solution — fire two opposite crossbows simultaneously:**
- W1 and W4 (opposite hex positions) fire within 10 ms
- Net recoil = 0 (vector sum)
- Tether drag during approach balanced by opposing tethers
- Bus attitude unperturbed → no RCS cost

**Gameplay affordance:** `Shift+1` fires opposite pair. `1` alone fires single (with RCS auto-compensation cost). Teach the player *why* dual-fire is cheaper.

### 15.2 Elastic Tether Momentum Transfer

GSL has Young's modulus ~500 GPa — essentially rigid at expected strains. But the *braid* structure is elastic in shear/torsion. Use it as a momentum transfer spring:

1. Daughter grabs debris at 10 m/s relative closing velocity.
2. Instead of decelerating via reel brake (dissipates energy as heat, costs motor power), let the tether stretch elastically — debris mass × closing velocity → elastic PE.
3. Once closure velocity = 0, lock reel. Now daughter + debris oscillate on the tether like a tetherball.
4. Reel in gradually. No energy lost.

**The payoff:** A 500 kg debris at 5 m/s closing carries 6.25 kJ. All of it can be recovered as orbital energy (transferred to mother via tether tension + pulley). Teach conservation of momentum directly.

### 15.3 Implementation Sketch

```js
// in ArmUnit._updateNetting() — replace hard reel brake with spring-damper
const springK = Constants.TETHER_SPRING_K; // N/m
const damper  = Constants.TETHER_DAMP_C;   // N·s/m
const stretch = Math.max(0, separation - tetherNominalLen);
const F_spring = springK * stretch;
const F_damp   = damper * closingVel;
const F_total  = F_spring + F_damp;
this._applyForceToArm(-F_total * tHat);       // pulls arm back
this._applyForceToMother(+F_total * tHat);    // equal+opposite, transferred
```

This is already hinted at in [`Events.TETHER_TENSION_UPDATE`](js/core/Events.js:1) — wire it up.

---

## 16. Ablation Propulsion — **Mother-Mounted Deorbit Weapon**

### 16.1 What Ablation Actually Is

Pulsed high-energy laser vaporises a thin layer of debris surface. The vapour jet is a reaction jet — **10⁻⁴ N per watt of laser power**, for each ~1 ms pulse. Over many pulses, the cumulative ΔV decelerates the debris. (NASA Ames Kellett work, Phipps 2012, JAXA LEODS studies — TRL 4.)

### 16.2 Correct Architecture — On the Mother, Not the Daughter

Earlier drafts put ablation on the daughter. **That's wrong** — daughters can't carry a 10 kW laser without tether-fed power, and tether-fed power at km scale is TRL 5 (see §32). The real architecture:

- **10 kW laser mounted on the mother**, pointed outward through a 20 cm aperture optic
- Mother has GaAs solar (dual wings, 2 kW) + Li-ion buffer (500 Wh) → 10 kW laser pulses at low duty cycle (10% = 1 kW average) are energetically feasible
- Target envelope: debris within 5 km (beam divergence + pointing stability limits)
- **Application: deorbit low-value debris.** Laser pulses drop target perigee into atmosphere. Target reenters in weeks instead of decades. No capture required, no ΔV spent on rendezvous — just steer the beam.

### 16.3 When to Use Ablation

| Scenario | Correct tool | Why |
|----------|-------------|-----|
| Large high-value target (rocket body, intact defunct) | Capture + drag (net + daughter) | Value recovery, cleaner removal |
| Small fragment < 10 kg | **Ablation deorbit** | Not worth a capture; just burn it out of orbit |
| Retrograde target | **Ablation decelerate-then-capture** | Use laser to kill retrograde velocity component; re-intercept prograde |
| Time-critical (ISS conjunction) | Ablation or autopilot chase | Whichever fits the window |

This positions ablation as a **late-game deorbiting tool** — not a primary capture mechanism. The "scavenger" archetype captures; the "sheriff" archetype deorbits. Both are legitimate player fantasies.

### 16.4 Gameplay Integration (Revised)

1. **Unlock path:** Mid-game Shop upgrade *"Laser Deorbit Module"* — requires 3 prior upgrades (solar wing upgrade, battery capacity, thermal radiator). This gates access to appropriate power budget.
2. **Shop cost:** 75k credits (late-game economy).
3. **Command:** `[8] Deorbit target` on the comms radial — works only on tracked debris within 5 km, not active sats.
4. **Visual:** Pulsed 1550 nm beam (invisible IR in reality, cyan glow in game for clarity) from mother to debris; debris reentry trail appears on Strategic Map (§4) over subsequent orbits.
5. **Codex TRL 4 flag:** entry text: *"NASA Ames / Phipps 2012 paper studies. No orbital demo as of 2025. Projected first-flight demo: 2030. AI-accelerated projection moved this left by ~5 years."*
6. **Score ledger:** Deorbited debris = positive score (environmental credit); captured debris = higher score (salvage value). Player chooses strategy.

### 16.5 What This Replaces

- Delete: ablation-from-daughter (X3 in earlier §35 kill list)
- Delete: "ablation requires power-beaming through tether" (not physical at km scale)
- Keep: laser beam visual for capture-assist on retrograde is NOT this system — if retrograde capture happens, it's via the ablation-decelerate sequence above, then standard net capture

### 16.5 Files to touch
- New: `js/systems/AblationSystem.js`
- [`js/entities/ArmUnit.js`](js/entities/ArmUnit.js:1) — already has `ABLATING` state at [`:1919`](js/entities/ArmUnit.js:1919), extend
- [`js/ui/hud/CommsPanel.js`](js/ui/hud/CommsPanel.js:1) — `[7] Ablate` entry

---

## 17. BeiDou-3 Class Laser Comms & YOLO Edge Detection

### 17.1 Laser Comms 2.0

BeiDou-3 reference: 1550 nm, 120 Gbps inter-satellite link, 2,600 km range, ±1 cm ranging. Applied to V5:
- **Mother ↔ Daughter** at 10 km: 120 Gbps is overkill. Design target **1 Gbps** (sufficient for real-time HD video from each daughter).
- **Mother ↔ Ground** during pass: 10 Gbps (limited by ground-station optics).
- **Mother ↔ Mother** (if multiple ADR platforms coexist): 100 Gbps ISL for shared catalogue sync.

### 17.2 Low-Bandwidth Fallback — YOLO Edge Detection

When laser link degrades (sun glint, pointing error, partial occlusion), daughter falls back to **RF backup** (UHF at 9.6 kbps, V3 heritage). 9.6 kbps cannot stream video. Instead:

**Daughter runs YOLOv8-nano onboard** (2 MB model, 5 ms inference on an ARM Cortex-A78):
- Input: 320×240 camera frame
- Output: bounding boxes of detected objects, class labels (satellite, fragment, debris)
- Transmit only the **annotations** (~200 bytes per frame at 1 Hz) — fits easily in 9.6 kbps
- Mother reconstructs the scene in wireframe from box + class + range data

**Gameplay effect:** When comms degrade, the player's target wireframe ([`DebrisWireframe`](js/ui/DebrisWireframe.js:1)) switches from full-fidelity to *YOLO-reconstructed boxy abstract*. Visually communicates "you're on low bandwidth — careful".

### 17.3 Files to touch
- New: `js/systems/CommLinkSystem.js` — laser vs RF fallback state machine
- [`js/ui/DebrisWireframe.js`](js/ui/DebrisWireframe.js:1) — degrade mode for low-bw

---

## 18. Tether Attachment vs Ion Thruster Plume

### 18.1 The Constraint

[`CROSSBOW_ARMS.md §3.3`](CROSSBOW_ARMS.md:314) established the Y-bridle requirement — tether must exit the arm LATERALLY, not aft, because FEEP Xe⁺ plume at 300 eV erodes the tether within hours.

V5 ion thrusters on the **mother**: BHT-600 Hall thrusters, ±15° vector range, plume half-angle ~25°. Tether attachment points on the mother bus must be outside a 40° exclusion cone from each thruster nozzle.

### 18.2 Geometric Solution — "Bridle Ring"

Surround each thruster with a titanium **bridle ring** at 0.3 m radius. Tethers attach to ring points at 90° offsets from thruster axis. Ring acts as sacrificial shield — if plume vectoring sweeps across a ring lug, the ring erodes, not the tether.

For dual-opposite release (§15), opposite thrusters' bridle rings are separated by 2 m (bus diameter), giving ~120° of clearance between opposing tether exits. Clean.

### 18.3 Retrofit Check

V3 Octopus had tethers exit through top/bottom docking cavities, clear of lateral thrusters. For V5 (more arms, more crossbows), the bridle ring architecture is required. Mass penalty: 0.5 kg per ring × 4 = 2 kg. Trivial.

---

# PART III — EDUCATIONAL VISUALIZATION SUITE

## 19. Teaching Moments Map — When to Introduce What

### 19.1 Three-Beat Pattern ([`LEARNING_THROUGH_PLAY.md §1.1`](LEARNING_THROUGH_PLAY.md:35))

1. **Experience** — player does something
2. **Consequence** — the world responds (visible / audible)
3. **Explanation** — Codex / HOUSTON paragraph (optional, dismissable)

### 19.2 When-to-Introduce Table

| Skill tier | Trigger | Visualisation | Concept |
|------------|---------|---------------|---------|
| NOVICE | First autopilot engage | Trail curves (§5) | Newtonian accel vs steering |
| NOVICE | First cluster selection | Ellipse + countdown (§24) | Orbital periodicity |
| APPRENTICE | First Hohmann transfer | Porkchop plot (§20) preview | ΔV ↔ timing tradeoff |
| APPRENTICE | First conjunction alert | MOID ring (§21) | Orbit intersection geometry |
| APPRENTICE | First ISS boss | Mission corridor + timer | Real ADR mission planning |
| VETERAN | First retrograde encounter | Lambert solver visual (§22) | Impossible-orbit lesson |
| VETERAN | First close approach (<100 m) | CW accuracy band (§23) | When linear approximation breaks |

---

## 20. Porkchop Plots — ΔV vs Launch/Arrival Date

### 20.1 What

A porkchop plot is a 2D heatmap with launch date on X, arrival date on Y, colour = required ΔV. Used by NASA for every interplanetary mission. Shape: pork-chop silhouette.

### 20.2 How to Visualise in Space Cowboy

On the strategic map (§4), when the player selects a distant target:
1. Canvas 2D overlay opens, 300×200 px, in lower-left
2. X: launch window = next 24 h of game time, sliced into 1-h bins
3. Y: arrival = next 48 h of game time
4. Colour: Hohmann + plane-change ΔV, from green (<100 m/s) to red (>2 km/s)
5. Player's current launch option marked with crosshair

Tooltip: "Fire at T+3h, arrive T+12h → 340 m/s"

### 20.3 Math

For each (launch, arrival) pair, solve Lambert's problem (§22) with the target orbit's position at arrival time. Cache the grid for 10 s (recompute when target or player orbit changes significantly).

### 20.4 Educational Payoff

Player sees **why** "go now" is often suboptimal. The green valley of the porkchop teaches: wait 6 hours, save 200 m/s of xenon. Economic + physical lesson in one image.

### 20.5 Files to touch
- New: `js/ui/PorkchopPlot.js` (canvas 2D overlay)
- [`js/entities/OrbitalMechanics.js`](js/entities/OrbitalMechanics.js:1) — add Lambert solver (already partial)

---

## 21. MOID — Minimum Orbit Intersection Distance as Risk Gauge

### 21.1 What

**MOID** = the closest possible distance between two orbits, regardless of time. If MOID = 0, the orbits intersect; collision is a timing question. If MOID = 10 km, the orbits never get closer than 10 km even in the worst geometric phase alignment.

Real-world: used for asteroid risk (PHA threshold = MOID < 0.05 AU + H < 22).

### 21.2 How to Visualise

On NavSphere (§8) and target panel:
- MOID to each debris contact computed from 6-element orbit comparison
- Shown as 2-letter risk badge: **[HI]**, **[MD]**, **[LO]**
- Colour: red <1 km, amber 1-10 km, green >10 km
- Tooltip: "MOID 3.2 km in 4 orbits"

For [`ConjunctionSystem`](js/systems/ConjunctionSystem.js:1): use MOID as primary filter (skip any debris with MOID > 10 km); use time-of-closest-approach only for low-MOID pairs. Computational saving: ~90% of debris skipped.

### 21.3 Math

For two ellipses, MOID is non-trivial but solvable in ~100 µs via [Gronchi 2002 method](https://arxiv.org/abs/math/0212149). Alternative: sample orbits at 360 points each, take pairwise distance minimum. `360² = 130k` distance computations — 2 ms per pair @ 60 Mops. Too slow for 200 debris. Solution: sample only the 8 osculating points per orbit (ap, pe, ascending node, descending node, +4 quadrature) = 64 distance comps per pair = 13k for 200 debris = OK at 10 Hz update.

### 21.4 Educational Payoff

Teaches **orbital-space intersection geometry**. A player asks "why isn't the 5 km distant debris dangerous?" — MOID shows: their orbits never get closer than 4 km even at worst phase. Calm down.

---

## 22. Lambert's Problem on the Strategic Map

### 22.1 What

**Lambert's problem:** given two position vectors and a flight time, find the orbit that connects them. Solution: Hohmann transfer is the optimal case (time-free); Lambert is the fixed-time case.

### 22.2 How to Visualise

In the strategic map (§4), when player drags "ARRIVE BY" slider:
1. Solve Lambert from current position to target-at-arrival-time
2. Draw solution orbit arc in dashed cyan
3. Display ΔV_depart + ΔV_arrive
4. Highlight **minimum-energy** case as "optimal" point on slider
5. Show **physical impossibility** — if arrival time is too short, Lambert returns hyperbolic escape; colour the slider red and warn "Requires escape velocity — re-plan"

### 22.3 Teaching Moment

Player drags slider. Sees: arrive 1 hour from now costs 4 km/s (impossibly expensive). Arrive 6 hours from now costs 340 m/s (affordable). Arrive 24 hours costs 800 m/s (you pay for the wait with extra coast maneuvering).

### 22.4 Math

Lambert solver: Izzo's method (2015) — converges in 5-10 iterations for elliptical cases. 100 µs per solve.

### 22.5 Files to touch
- [`js/entities/OrbitalMechanics.js`](js/entities/OrbitalMechanics.js:1) — add `lambertIzzo(r1, r2, tof, mu)`
- [`js/ui/OrbitMFD.js`](js/ui/OrbitMFD.js:1) & strategic map — render solution

---

## 23. Clohessy-Wiltshire Accuracy Band

### 23.1 What

**Clohessy-Wiltshire (CW) equations** (1960) linearise the two-body problem around a reference orbit. Ideal for **close proximity** operations (<few km). Errors grow with:
- Relative distance (cube of it)
- Eccentricity of reference orbit
- Time (linearly)

### 23.2 The Curtis Rendezvous Strategy

From Curtis *Orbital Mechanics for Engineering Students* §7.3: "CW accurate to 1% for ρ/a < 0.001 and t < T/10 where T is orbital period."

For LEO (a ≈ 6800 km): `ρ/a < 0.001` means ρ < 6.8 km. `t < T/10` means t < 550 s.

### 23.3 How to Visualise

During APPROACH phase (arm piloting, player within 1 km of target):
1. Render a **green "CW zone" sphere** around the target (radius 5 km — within 1%)
2. Outside: amber "quadratic-error" zone (5-20 km)
3. Further: red "non-linear" zone (>20 km) — CW predictions unreliable

When autopilot uses CW (currently no, but should for final 100 m), HUD displays: `CW ACTIVE · err < 1% · valid 90s`. Builds player trust in autopilot inside its valid envelope.

### 23.4 Educational Payoff

Teaches **when linear approximations break**. Player watches: at 2 km, CW says "arrive in 60 s at ΔV cost 8 m/s". At 15 km, same CW says "120 s, 12 m/s" — but actual Hohmann solution is 280 s, 180 m/s. The discrepancy is visible and self-correcting.

### 23.5 Files to touch
- [`js/systems/AutopilotSystem.js`](js/systems/AutopilotSystem.js:1) — use CW in HOLD phase (<100 m)
- [`js/ui/HUD.js`](js/ui/HUD.js:1) — CW zone visualisation during APPROACH

---

## 24. Cluster Transfer Ellipse + Countdown

### 24.1 What

When player selects a **cluster** (via strategic map or target panel), visualise:
1. **Transfer ellipse** — the Hohmann arc from player's current position to cluster centroid
2. **Launch countdown** — seconds until the *optimal* departure window (when player's true anomaly matches)
3. **Arrival predictor** — where the cluster will be when the player arrives (phased)

### 24.2 Rendering

On strategic map + NavSphere mini-panel:
```
CLUSTER #4 · SSO 800 km · 98°
  Mass: 3,450 kg · 17 objects
  
  [ ELLIPSE SVG with ▲ marker ]
  Depart: T+00:04:32
  Arrive: T+00:29:15
  ΔV: 340 m/s
  
  [ ENGAGE AUTOPILOT ]
```

Countdown ticks every 100 ms. At T-10 s, the countdown goes cyan + audio beep. At T-0, HOUSTON▸ "Window open." If player misses, next window shows `T+01:35:12` (next orbital period).

### 24.3 Teaching Moment

Teaches **orbital timing** — you cannot "go now" everywhere. Space is periodic. The ISS comes back to Cape Canaveral's longitude every ~91 minutes; so do cluster rendezvous windows.

### 24.4 Files to touch
- [`js/ui/OrbitMFD.js`](js/ui/OrbitMFD.js:1) — ellipse + countdown widget
- [`js/systems/TrawlManager.js`](js/systems/TrawlManager.js:1) — expose next-window calc

---

# PART IV — SPACECRAFT ENGINEERING REALITY CHECK

> **The premise of this Part.** Space is brutal. Decades of operational data from NASA, ESA, JAXA, Roscosmos, SpaceX, Northrop Grumman, and Maxar have converged on a surprisingly small set of designs that actually work long-term in orbit. Everything else is in the graveyard. This Part audits the V5 design against that reality — what parts of our ambitious roadmap rest on flight-proven foundations, what parts rest on lab demos that will probably slip by 5–10 years, and what parts should be killed. The game must *feel* futuristic but *teach* real engineering.

---

## 25. TRL Classification — What Counts as "Real"

NASA's TRL scale (1-9) is the industry lingua franca. **Every Codex entry, Shop item, Mission briefing, and tool tooltip in the game shows a TRL number.** This replaces the earlier "coloured badge" idea — a number is more informative and players learn the scale naturally.

| TRL | Meaning | Example | In-game framing |
|-----|---------|---------|------------------|
| **9** | Operated in orbit for years across many missions | Hydrazine monoprop, Ni-H₂, GPS nav, APAS docking, Dyneema SK78 | "Flight-proven" (green) |
| **7-8** | Flight-demonstrated; few missions; some integration risk | Hall thrusters, RemoveDEBRIS net capture, Starlink ISL laser, FEEP | "Mature" (yellow) |
| **4-6** | Lab / sounding-rocket / CubeSat demo; not operational | Gecko-grip, electrostatic pads, mussel-catechol adhesive, power beaming <100 m | "Research" (amber) |
| **1-3** | Paper study / early lab | MPD small-bus, GSL primary structure, synthetic-aperture LIDAR | "Speculative" (red) |

**The rule of thumb:** ADR mission success requires a critical path built entirely from TRL ≥ 7 parts, with at most one or two TRL 7-8 elements in redundant paths. Putting a TRL 4-6 component on the critical path is a mission-kill risk. Putting TRL 1-3 is science-fiction.

**AI-accelerated reality check** — TRL transitions are faster now than the historical norm. Material discovery, simulation-driven design, and foundation-model-assisted verification have compressed the 10-year TRL 4→9 ladder to 3-5 years for many specific technologies. The [Technology Upgrade Ladder §36](#36-technology-upgrade-ladder--ai-accelerated-roadmap) below maps this: **HBN-coated Dyneema is arriving in 2026, GSL first flight 2028, operational GSL 2030.** This is the in-game upgrade cadence.

Our V3 Octopus is ~70% TRL 9, 25% TRL 7-8, 5% TRL 4-6. V4 Opussy shifts that to 40% / 30% / 25% / 5%. V5 Crossbow ([`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md:1)) as written pushes ~15% TRL 1-3. **That's the audit deficit §35 closes.**

---

## 26. Docking — What Actually Works in Orbit

### 26.1 Only Four Mechanisms Have Operated Reliably

| System | First flight | Missions | Principle | Key lesson |
|--------|-------------|----------|-----------|------------|
| **Probe-and-drogue** | 1967 (Soyuz) | 300+ | Central probe enters funnel, latches mechanically | Simple, mechanical, bombproof — still used on Soyuz/Progress |
| **APAS-89** | 1995 (Shuttle-Mir) | ~100 | Androgynous: same interface on both vehicles, petals interlock | Any vehicle can dock to any — scales across international partners |
| **NDS / IDSS** | 2020 (Dragon-2) | 30+ | Soft capture first (low-force magnetic latch), then align, then hard capture (12 hooks) | *Soft-then-hard* separation is the safety innovation |
| **Canadarm2 + grapple fixture** | 2001 | 60+ berthings | Rigid robot arm grabs a standardized grapple pin (FRGF) on visiting vehicle | **Berthing, not docking.** Slow (1-2 hr), but no closing-velocity risk |

### 26.2 What This Means for V5

V5 has **no cooperative target** — debris doesn't carry mating interfaces. But the *docking between Daughter and Mother* does, and that's where flight heritage applies:

- **EPM (Electro-Permanent Magnet) latch** from V3 §8 — essentially the "soft capture" mechanic from NDS. 🟡 Mature. Keep.
- **Conical alignment funnel** — passive mechanical feature that self-aligns the daughter on re-dock. Every docking system uses some variant. 🟢 Keep.
- **Hard-capture hooks** — V5 should add a ring of 3-4 tungsten hooks that drive home once EPM is locked (redundancy in case the magnet quenches). 🟢.

### 26.3 The "Capture" Side (Debris-Facing)

For capturing uncooperative debris, operational heritage is thin:
- **Robot arm + grapple fixture attached in-flight** — impossible for legacy debris (no fixture).
- **Net capture** — RemoveDEBRIS 2018 demonstrated once. 🟡. Works on tumbling. This is the V3/V5 primary.
- **Harpoon** — RemoveDEBRIS 2019 demonstrated once on a cooperative simulated target. 🟡.
- **Magnetic end-effector** — Astroscale ELSA-d 2021 demonstrated on its own dispensed target (cooperative). 🟡 cooperative only.
- **Tentacle / gripper arms** — ClearSpace-1 planned (2026). 🟠 not yet flown.

**Ruthless verdict:** For V5 to feel real, **nets must be primary** (they're the only mechanism that handles tumbling uncooperative targets at TRL ≥7). Everything else is bonus. Crossbows launch net-bearing daughters, not grappler-arms.

---

## 27. Rendezvous — The GPS → LIDAR → Camera Ladder

### 27.1 The Standard Architecture (Unchanged Since PRISMA 2010)

Every operational rendezvous in LEO since 2010 uses some variant of this exact ladder:

| Range | Sensor | Accuracy | Heritage |
|-------|--------|----------|----------|
| 100+ km | **GPS** (absolute + differential) | ~10 m | Every LEO satellite since 1995 — 🟢 |
| 10-100 km | **Radar** (K-band or S-band) or catalog | ~100 m | Progress KURS, Dragon radar — 🟢 |
| 1-10 km | **Scanning LIDAR** | ~1 m | HERA/ATV (ESA), Dragon/Cygnus — 🟢 |
| 100 m – 1 km | **Flash LIDAR + camera** | ~10 cm | AVGS (Boeing), DragonEye — 🟢 |
| 10–100 m | **Fiducial tracking** (AprilTag equivalents) | ~1 cm | Dragon docking cam, HTV — 🟢 |
| <10 m | **Docking adapter feedback** (force, proximity switches) | contact-based | NDS/IDSS — 🟢 |

### 27.2 What V5 Should Use

V3 §4 proposed a 🔴/🟠 "optical nervous system" (808 nm laser + MEMS mirror + MRR on arms). This sounds elegant but is **speculative** — no spacecraft has ever operated a MEMS-scanned laser-power-beaming + MRR comms system at ≥1 km range.

**Ruthless fix for V5:** Replace with the proven ladder above.
- **Mother ↔ Daughter** during deployment: scanning LIDAR (Ball CubeSat LIDAR, 0.5 kg, TRL 8) for 10 m – 2 km.
- **Daughter onboard:** passive retroreflector (flight-proven for decades on Apollo laser ranging arrays) + low-power camera.
- **No exotic MRR, no power-beaming at 2 km.** Daughter has its own PV (small but real) + a Li-ion battery good for 30 min autonomy. The drama of "must dock within the hour" becomes a *power budget* constraint, teaching a real mission-ops lesson.

Power beaming at km scale is **lab-only as of 2025**. Northrop Grumman has sub-100 m demos. Putting it on a critical path is malpractice. **Kill** it from V5. Keep the *comms* laser (1550 nm Starlink-class — 🟡 mature) for Mother↔Daughter data links; but *power* comes from onboard PV.

### 27.3 What to Teach the Player

The game should show **the real ladder** — as the player closes from 100 km → 1 km → 100 m, the sensor readout on the HUD should visibly **swap instruments**:

- 100 km: `GPS → 8.2 m`
- 10 km: `GPS + RADAR → 0.9 m`
- 1 km: `LIDAR → 12 cm`
- 100 m: `FLASH LIDAR → 2.1 cm`
- 10 m: `FIDUCIAL → 0.4 cm`
- <5 m: `DOCKING FEEDBACK`

This is exactly how Dragon's HUD works in real flights. Ten seconds of play teaches an entire mission-phase concept.

---

## 28. Tether Reality — The Graveyard of Failed Demos

### 28.1 The Honest Track Record

**Every long-tether-in-LEO demonstration in history has failed or partially failed:**

| Year | Mission | Tether | Result |
|------|---------|--------|--------|
| 1992 | **TSS-1** (NASA/ASI, Shuttle) | 20 km | Jammed at 256 m. Reel failure. |
| 1996 | **TSS-1R** (re-flight) | 20 km | Deployed to 19.7 km; **broke after 5 hours** (arc-induced melt at insulation defect). |
| 1992 | **SEDS-1** (NASA) | 20 km Spectra | Deployed but post-deploy data loss. |
| 2007 | **YES2** (ESA/Delta-UTEC) | 31.7 km Dyneema | Deployed to 8 km then payload release anomaly; partial success. |
| 2010 | **T-Rex** (JAXA) | 300 m bare wire | Deployed. EDT current below theoretical. Partial success. |
| 2016 | **KITE** (JAXA/HTV-6) | 700 m | **Failed to deploy.** Reel jammed. |
| 2019 | **RemoveDEBRIS tether test** | 100 m Dyneema net-dragging | **Succeeded** but at short length. |
| 2023 | **TEPCE (Tether Electrodynamics Propulsion CubeSat)** | 1 km | Deployed; EDT current measured. Latest positive data. |
| 2026 (projected) | **HBN-coated Dyneema CubeSat demo** | 500-1000 m | AI-accelerated material processing enables HBN coating at roll-to-roll scale; multiple academic labs targeting 2026 flight. TRL 6→7 expected. |

### 28.2 The Lessons

1. **Reels jam.** More than 50% of the failure modes are the reel mechanism — the motor, the brake, the pay-out geometry. V5's 10 km reel must be simpler than any historical design, or we're betting against 30 years of failure.
2. **Insulation defects melt.** TSS-1R broke because a pinhole in the insulator allowed a few amps to arc at orbital plasma interface. **Any voltage on a long tether is dangerous.** This is relevant to V4 Opussy §6's electrostatic-adhesion concept (3 kV on the net) — 🔴 speculative, real-world versions have melted.
3. **Dynamics are hard.** Tether libration (swing) is weakly damped; any push creates 10+ minute oscillation. Control laws are subtle.
4. **Only Dyneema / Spectra have flight heritage** at tether lengths. 🟢. GSL has none. 🔴.
5. **Deployment-only is the easy mode.** Retracting a tether after deploy has only been demonstrated at <1 km (YES2 partial, TEPCE). Long-tether retract-redeploy cycles are unflown.

### 28.3 What V5 Must Honestly Assume (with AI-Accelerated Dates)

- **Baseline game start:** Dyneema SK78 at **2 km**, TRL 9. Proven, reliable. Nets deploy from daughters on spring-crossbow launch — RemoveDEBRIS-heritage, TRL 7.
- **Year-1 upgrade (2026 real-world, 30 mission-hours in-game):** **HBN-coated Dyneema** — hexagonal boron nitride thin-film coating on existing Dyneema. Gives AO + UV + thermal protection, extends life from 6-month to 3-year orbital service. TRL 6→7. Small mass penalty, same 2 km reach. **Ships as real tech.**
- **Year-2 upgrade (2028 real-world, 120 hr in-game):** **GSL first flight demo** — graphene superlattice fibre in CubeSat scale, 500 m length, ground-qual TRL 7. In-game this unlocks "GSL Engineering Units" in Shop: 4-5 km reach at same mass as 2-km Dyneema. **Marked "early-access TRL 7 — engineering units, expect failures".**
- **Year-3 upgrade (2030 real-world, 300 hr in-game):** **GSL operational** — first full-scale operational GSL at 2+ km in a free-flyer. TRL 8. Enables reliable 6-km reach.
- **Year-4+ stretch (2032+):** GSL at 10 km. Scavenge sphere doctrine from §14 finally arrives. TRL 7 at that point.
- **Reel-in cycles = game resource.** Each reel has a finite **~20 full cycles** before mechanism fatigue. This is a hard-learned real-world number (TSS-1 jam + KITE jam + manufacturer spec data). Modelled as a per-reel counter. When a reel hits cycle 15, the daughter HUD shows amber "REEL WEAR 75%"; at 20, the reel locks and the arm is effectively stranded unless the player performs an EVA-style repair mission (mid-game Shop upgrade: "Field-Replaceable Reel Cassette"). **This becomes a core mid-game resource decision.**
- **No voltage on tether.** The V4 electrostatic-net-via-tether (3 kV) is **killed** — TSS-1R melt lesson. Electrostatic grip stays on the daughter as a short-range pad.

### 28.4 The 10-km Scavenge-Sphere Claim — Phased Arrival

Earlier §14 presented 10 km reach as the V5 baseline. **Revised:** 10 km is the **Year-3-to-4 upgrade ceiling** under AI-accelerated materials development. At game start, the player flies Dyneema 2 km. By mission-hour 300 (player's 3rd campaign or so) they can unlock GSL 6 km; 10 km is a stretch goal. This is pedagogically honest (real-world progression) AND gives the player a genuine capability arc to earn.

---

## 29. Capture Net — Spinning Mesh Capture System

> **Full design document:** [`CAPTURE_NET.md`](CAPTURE_NET.md) — §1–§10 covering physical model, cling mechanism, tangle mechanics, fragmentation prevention, per-platform net classes, failure modes, visual/audio cues, and Codex entry text. This section summarises the key decisions; implementation details live in the design doc.
>
> *Re-scoped 2026-04-26. Prior §29 titled "Capture Mechanisms — Grapple Fixture Still Dominates" with "bolas" and "Paleolithic weighted cord" framing. Both the name and the behavioural model were wrong. See [`CAPTURE_NET.md §1`](CAPTURE_NET.md) for rationale.*

### 29.1 What It Is

The **Capture Net** is a rotating-open disc of Dyneema SK78 mesh, kept spread by tungsten rim weights under centripetal force, launched from a crossbow rail on a Dyneema tether. Humans have used nets to catch what we cannot grab since prehistory; spider silk and orb-weaver geometry inform the spin-open architecture. In vacuum, this is better than a bola (which only wraps limbs) or a lasso (which needs air to stay open). The spinning mesh wraps arbitrary rigid geometry, and Velcro-hook surface treatment provides self-cling adhesion (TRL 9).

**Y0 fleet = 1 Mother + 2 Large Daughters + 2 Small Daughters** (Quad-4 baseline, Rev 5). Mother carries 2 body-mounted Large Net pods. Hex (Y1) and Octo (Y3) are Tech Ladder upgrades. Three net classes serve the fleet:

| Class | Platform | Diameter | Target Envelope | Range |
|-------|----------|----------|----------------|-------|
| **Large Net** | Mother (2 body-mounted pods, all tiers) | 8.0 m | Intact stages, large dead sats (100–5000 kg) | 75 m |
| **Medium Net** | Large Daughter (Weaver) — 2 at Y0, 3 at Y1+ | 5.0 m | Dead sats, small stages (10–500 kg) | 75 m |
| **Small Net** | Small Daughter (Spinner) — 2 at Y0, 3 at Y1+ | 1.5 m | Fragments, micro-debris (0.1–50 kg) | 75 m |

### 29.2 What Agencies Actually Plan for ADR

- **ClearSpace-1 (ESA 2026 target):** 4 tentacle-arms with compliant grippers around a known target. 🟠.
- **ELSA-M (Astroscale, 2026):** magnetic docking to cooperative docking plates. 🟡.
- **ADRAS-J (Astroscale/JAXA, 2024–2026):** robotic arm capture of H-2A upper stage. 🟠.
- **RemoveDEBRIS (Surrey/SSTL, 2018):** **net capture flight demo** — the only TRL ≥7 method for uncooperative debris. ✅.

**V5 hard design principle:** The primary capture tool is the **net**. This is RemoveDEBRIS doctrine. Everything in [`GAME_DESIGN.md`](GAME_DESIGN.md:1) already aligns.

### 29.3 Secondary Tools (for Gameplay Variety)

| Tool | TRL | Usage | In-game Codex text |
|------|-----|-------|-------------------|
| **Capture Net (primary)** | 9 | All debris, all platforms | "Dyneema mesh + tungsten rim weights — TRL 9. See [`CAPTURE_NET.md`](CAPTURE_NET.md)" |
| **Harpoon** | 7 | Large intact debris with stable flat surface | "RemoveDEBRIS 2019 flight demo" |
| **Magnetic grapple** | 7 | Ferromagnetic bodies (Russian upper stages, steel hardware) | "ELSA-d 2021 docked to cooperative target" |
| **Gecko micro-setae pad** | 5 | Tiny debris, low-force VdW adhesion | "JPL Stickybot 2016; Parness lab prototype on ISS 2022" |
| **Electrostatic pad** (daughter-mounted) | 4 | Sub-kg fragments, conductive surfaces | "JAXA lab demo — 1-3 N/cm² on Al/Ti surfaces" |
| **Mussel-inspired catechol adhesive** | 3 | Future wet-adhesion analog | "UCSB/Messersmith lab; vacuum chemistry 2023+" |
| **Space-qualified structural epoxy** | 9 | *Structural only* — not for capture | "Every ISS truss bolt uses one of these" |
| **Ablation (mother-mounted deorbit)** | 4 | Small debris burn-out, retrograde deceleration | "NASA Ames Kellett / Phipps 2012 paper" |

### 29.4 Adhesives That (Might) Work in Space — The Honest Biology

The "grab-don't-drop" problem in ADR motivates biomimetic adhesion research. Reality as of 2025:

- **Gecko setae (van der Waals)** — TRL 4-5. Works in vacuum. Force scales with area — adequate for <10 kg fragments only. Appropriate for Spinner-class daughter end-effectors.
- **Mussel foot protein (catechol chemistry)** — TRL 2-3. Requires liquid water (sublimes in vacuum). Encapsulated pre-cured pads lab-stage only (UCSB Messersmith 2023).
- **Barnacle cement** — TRL 2. Water-activated.
- **Space-qualified epoxies (Hysol EA-9394, Scotch-Weld 2216)** — TRL 9, but structural bonding only (hours curing, surface prep). Model as post-capture cargo-bay attachment, not active capture.
- **Pressure-sensitive silicone (Nusil)** — TRL 8 as thermal gasket; capture use is TRL 5. Low-force temporary grip for detumble-then-net sequences.
- **Cold welding** — TRL 9 (unintentional). Bare metal-metal vacuum bond. Not recommended for capture — irreversible.

**Capture Net cling uses Velcro hook-and-loop mesh (TRL 9)** — see [`CAPTURE_NET.md §3`](CAPTURE_NET.md) for the full adhesion strategy evaluation and cling probability model.

**Game doctrine — three types of "grip" the player experiences:**
1. **Mechanical** (nets, harpoons, magnetic latch) — TRL 7-9, reliable, reversible
2. **Adhesive** (gecko, silicone, research catechol) — TRL 4-8, limited force, conditional
3. **Weld** (cold welding, structural epoxy) — TRL 9, **permanent**, strategic decision to use

### 29.5 Capture Net Key Design Features

Four major design elements are detailed in [`CAPTURE_NET.md`](CAPTURE_NET.md):

1. **Two capture modes** ([`§2.4`](CAPTURE_NET.md)) — **Slam-wrap** for durable debris (direct contact, spin-wrap, Velcro cling). **Tether-brake cinch** for delicate/frangible debris — the reel brakes the tether, rim weights carry forward on momentum past the target, mesh forms a bag, spring-loaded drawstring cinches the bag closed. Zero crushing force — the debris floats inside. This is the key innovation for gentle capture of solar-panel-bearing satellites.

2. **Smart rim weights ("edge nodes")** ([`§2.6`](CAPTURE_NET.md)) — Not passive tungsten. Each weight carries a spring-loaded cinch mechanism + solenoid pin-pull (Y0), with camera + radio mesh network upgrades (Y1+). Enables coordinated cinch timing and debris inspection from multiple angles during approach.

3. **Material upgrade path** ([`§2.7`](CAPTURE_NET.md)) — Dyneema SK78 (3.6 GPa, Y0) → Graphene-20 (20 GPa, Y1) → Graphene-40 (Y2) → Graphene-80 (Y3) → Graphene-130 (Y4). Stronger material = thinner cord = more nets per magazine pack (4 → 8 for Large Net) + longer range (75 m → 105 m). Nets come in **reloadable magazine packs** slotted into crossbow rails.

4. **Resupply model** ([`§6.5`](CAPTURE_NET.md)) — Replacement net packs via: resupply drone (reputation-gated), depot rendezvous (nav-point), or scavenging derelict Octopus wrecks (free but risky — damaged/degraded packs). Scavenging loop creates interesting risk-reward: strip a wreck for parts before deorbiting it.

Also addresses: cling probability model ([`§3`](CAPTURE_NET.md), gated by `NET_CLING_MODEL`), five tangle scenarios ([`§4`](CAPTURE_NET.md), gated by `NET_TANGLE_MECHANICS`), and fragmentation prevention ([`§5`](CAPTURE_NET.md), solved primarily by the cinch mode).

This replaces [`LassoSystem.fire()`](js/systems/LassoSystem.js:205) and §4.4–§4.7 of [`HANDOFF.md`](HANDOFF.md:1). Implementation tracked as **ST-9.4** (5 sub-tasks, 4 days) in [`IMPLEMENTATION_PLAN.md`](archive/IMPLEMENTATION_PLAN_2026-06.md). The Capture Net is the **game's starting capture tool**, available from mission 1 — TRL 9, no unlocks needed.

---

## 30. Space Environment — What Kills Hardware

### 30.1 The Five Executioners

| # | Killer | Where | Rate | Mitigation |
|---|--------|-------|------|-----------|
| 1 | **Atomic Oxygen (AO)** | 200-700 km | ~10²¹ atoms/cm²/year at ISS alt | Kapton with SiO₂ coat, AO-resistant paints, no Mylar exposed |
| 2 | **UV** | All orbits | 1 solar constant | UV-stable polymers (PTFE Teflon, PEEK), gold coatings |
| 3 | **Thermal cycling** | LEO 5,500 cyc/yr (±120°C) / GEO 800 cyc/yr | See rate | CTE-matched materials, thermal expansion joints |
| 4 | **Radiation** | 10 krad/yr LEO to 1 Mrad/yr Van Allen | See rate | Rad-hard ASICs, ECC memory, TMR voting, shielding |
| 5 | **MMOD** | Probabilistic, altitude-dependent | ~0.1% / year penetration of standard wall | Whipple shields (stuffed at ISS), redundant lines, avoidance |

### 30.2 Atomic Oxygen — The VLEO Game-Changer

At 200-400 km altitude, atomic oxygen is the **dominant erosion mechanism**. AO is a highly reactive monatomic gas created by UV photodissociation of O₂. It eats:
- Silver (turns black in hours)
- Kapton polyimide unprotected (~10 µm/year)
- Most organic polymers (Dacron, Nylon degrade in months)
- Carbon-based composites (surface erosion)

**What survives AO:** Aluminum (forms protective Al₂O₃), Titanium (TiO₂), Quartz, SiO₂-coated Kapton, Teflon (PTFE — marginal), **gold** (inert). Graphene and GSL — unknown, needs AO-chamber testing.

**Game implication:** Mother ships in VLEO (200-400 km) have **measurable hull erosion per mission**. A V5 that spends 6 months clearing VLEO debris should look visibly weathered — panels yellowed, silver backings blackened. Visual aging = teaching AO.

### 30.3 Cold Welding — The Moving-Parts Killer

In vacuum, bare metal-to-metal contact (no oxide layer) causes atoms to bond across the interface — **cold welding**. Once in contact, they weld solid. Consequences:

- Every deployable mechanism must have a **dissimilar material interface** (e.g., Ti against Al through a dry-film lube like MoS₂ or PTFE liner).
- Hubble's gyro replacement mechanisms failed partially due to cold weld.
- Tether reels must have **ceramic bearings or HBN-coated guide tubes** (V4 Opussy §3.3 already addresses this — 🟡 valid).

**Cold weld tests every moving joint.** V5 has ~24 moving joints at Y0 (struts × 1 DOF × 4 daughters + 4 reels + 4 docking hooks per cavity; up to ~40 at Y3 Octo). Any two of them welding = mission fail. Design standard: **MIL-STD-1546** (Parts, Materials, and Processes Selection).

### 30.4 Thermal Cycling — The Silent Fatigue

LEO: sun for ~60 min, eclipse for ~35 min. 16 orbits/day = 5,840 thermal cycles/year. Over 10 years: 58,400 cycles. Every cycle is -120°C → +80°C on exposed surfaces.

**What fails:**
- Solder joints (use *conformal coating* + rework-grade flux)
- Adhesives (only *space-qualified* Scotch-Weld or RTV)
- PCBs with through-hole (use SMT with underfill)
- Connector pins (use dust caps, burn-in cycles)

**Game implication:** "Panel connector fatigue" event after N cycles → HOUSTON▸ "Your starboard bus is showing intermittent power. Budget a repair spacewalk." Teaches real ISS/GEO operational reality.

### 30.5 Radiation — Van Allen Belt Navigation

| Orbit | Annual dose (behind 1 mm Al) |
|-------|------------------------------|
| 400 km ISS | 1-5 krad |
| 800 km SSO | 5-15 krad |
| 1,200 km (through inner belt edge) | 50-200 krad |
| 2,000-10,000 km (inner belt core) | 100 krad-1 Mrad |
| GEO (above belts, exposed to SEP) | 5-20 krad + SEU events |

**Commercial ("space-grade") parts** tolerate ~30-100 krad total-ionizing-dose (TID) + must be latchup-immune.
**Rad-hard** (military/space qualified) parts tolerate 300 krad to 1 Mrad + SEU-hardened.

**Game implication:** Transiting the Van Allen inner belt (unavoidable when going from LEO to MEO or GEO) should cost *mission time* (player schedules burn during favorable geomagnetic conditions, minimizes transit). Teaches a real mission-planning constraint.

### 30.6 MMOD — The Kessler Amplifier

LEO at 400-800 km: ~1 impact of >0.1 mm debris per m² per year. For a 100 m² spacecraft: 100 hits/year, most < mm-scale. ISS has been struck > 100 times, with a dozen >1 mm penetrations of outer skin. No cabin depressurization yet (Whipple shielding).

**V5 doctrine:**
- Whipple shield on fuel tanks and hab (double wall, 10 cm gap, Kevlar blanket)
- Redundant propellant lines (dual routing)
- Conjunction avoidance — [`ConjunctionSystem`](js/systems/ConjunctionSystem.js:1) already models this 🟢
- Sacrifice rules — if the mother loses a solar array to MMOD, mission continues on reduced power (game telemetry events)

---

## 31. Materials & Thrusters — The Flight-Proven Registry

### 31.1 Structural Materials (🟢 flight-proven primary structure)

| Material | Use | Notes |
|----------|-----|-------|
| Al 7075-T6 | Bus frame | Workhorse since 1960s. Stiff, light, AO-tolerant. |
| Al 6061-T6 | Brackets, secondary | Easier to machine. Slightly lower strength. |
| Ti-6Al-4V | High-load joints, bridle rings | Rad + AO tolerant, 2× density of Al. Use sparingly. |
| Invar 36 | Optical bench | Near-zero CTE for instrument mounting. |
| Magnesium AZ31 | Weight-critical brackets | ⚠ flammable in pure O₂; otherwise OK |

**Not for primary structure (yet):**
- CFRP (carbon-fiber reinforced polymer) — 🟡 used as secondary on Hubble, JWST deployables, ok but outgasses.
- Graphene/GSL — 🔴 no primary-structure flight history. Would need a decade of qualification.

### 31.2 Thermal Control (🟢 all flight-proven)

- **MLI** (Multi-Layer Insulation) — alternating Kapton + Dacron + aluminized Mylar, 15-20 layers. Every sat uses it.
- **OSR** (Optical Solar Reflector) — 2 mm fused silica tiles, high ε/α for radiator. GEO sats everywhere.
- **White paint** (AZ-93, S13-GLO) — cheap, 5-10 year UV life.
- **Second-surface silvered Teflon** — flexible radiator. GPS.

**Emerging (🟡):** aerogel blankets, variable-emissivity MEMS coatings. Not yet V5-ready.

### 31.3 Thrusters — The Flight Registry

| Thruster | Typical Isp | TRL | Notes |
|----------|-------------|-----|-------|
| Hydrazine monoprop (MR-103, MR-111) | 225 s | 🟢 9 | 50+ year heritage. Toxic. Slowly being replaced. |
| Bipropellant MMH/NTO (R-4D, MMBPS) | 320 s | 🟢 9 | Apollo SM to Orion. |
| AF-M315E ("green" monoprop) | 250 s | 🟡 8 | GPIM 2019 demonstrated. Replacing hydrazine. |
| Hall effect (BHT-200, BHT-600, PPS-1350) | 1,500-2,000 s | 🟢 9 | SMART-1, Dawn, hundreds of Starlink. Workhorse. |
| Gridded ion (NSTAR, NEXT-C) | 3,000-4,000 s | 🟢 9 | Deep Space 1, Dawn, Psyche. Deep-space staple. |
| FEEP / electrospray (Enpulsion NANO, ACCION TILE) | 2,000-5,000 s | 🟡 7 | LISA Pathfinder 2015, many CubeSats post-2018. Micro-thrust regime. |
| Cold gas (N₂, Xe) | 60-80 s | 🟢 9 | Simple, cheap, widely used. Low performance. |
| Resistojet (N₂, NH₃) | 300 s | 🟢 9 | Many GEO sats. |
| MPD thruster | 2,000-4,000 s | 🟠 5 | High power (~100 kW). No small-sat flight history. |
| Pulsed plasma (PPT) | 1,000 s | 🟡 7 | LES-6 1968, EO-1 2000. Low thrust. |
| Solar sail | N/A (photon drag) | 🟡 7 | IKAROS 2010, LightSail 2019. Large areas only. |
| Laser ablation | varies | 🔴 3 | Paper studies. Kellett NASA Ames CW laser on samples. No orbital demo. |

**V5 recommendation:** Main propulsion = **Hall (BHT-600)** 🟢 for efficient mission-class ΔV (hundreds of m/s over days). RCS = **cold-gas N₂** 🟢 for attitude. Daughter thrusters = **FEEP electrospray** 🟡 for µg-class fine maneuvering. **Kill ablation propulsion** from the primary loop — it's 🔴. Keep it as a distant-future Codex flavor entry.

---

## 32. Power & Batteries — Conservative DOD Wins

### 32.1 Solar Cells

| Cell | Efficiency | TRL | Lifetime |
|------|-----------|-----|----------|
| Silicon (Si) | 15% | 🟢 9 | 15+ yrs. GPS-era classic. |
| Triple-junction GaAs (InGaP/InGaAs/Ge) | 30% | 🟢 9 | 15+ yrs. Modern standard. Starlink, most sats. |
| Quad-junction | 32-34% | 🟡 8 | Some commercial flight. |
| Perovskite | 25% lab | 🔴 3 | **Degrades in hours under UV** in vacuum. Not space-worthy. |
| Organic PV | 10% | 🔴 2 | UV destroys in days. |

**V5 verdict:** triple-junction GaAs 🟢. Anything more exotic is hype.

### 32.2 Batteries

| Chemistry | Specific Energy | DOD Standard | TRL | Lifetime |
|-----------|-----------------|--------------|-----|----------|
| **Ni-H₂** | 60 Wh/kg | 40% | 🟢 9 | 15-25 years (HST, GPS) |
| **Li-ion** (LCO/NCA) | 150 Wh/kg | 30% | 🟢 9 | 10-15 years (ISS since 2017, Starlink) |
| Li-S | 300 Wh/kg theoretical | — | 🔴 3 | No flight. Cycle life poor. |
| Li-polymer solid-state | 250 Wh/kg | — | 🟠 5 | Early sounding rockets. |

**Hard-learned rule: conservative Depth-of-Discharge.** Keeping DOD ≤ 30% is the difference between a 10-year Li-ion and a 2-year Li-ion. V5 sims should model this — if a player runs down to 5% battery every orbit, the battery *loses capacity* in game time (a few weeks of mission time = 20% capacity loss). Teaches real op-doctrine.

### 32.3 Power Beaming — The Exotic Upgrade Path

Laser power beaming to mW-class receivers over ~100 m has been demonstrated in Northrop Grumman / Nagoya University labs (TRL 5). Active research at DARPA (POWER program, 2023-28), AFRL (2024-), Emrod (New Zealand), and Japan's JAXA SSPS studies. **AI-accelerated trajectory: first km-range power-beaming spacecraft demo projected 2029-2031.**

**Correct V5 positioning:**
- **Critical path (game-start, TRL 9):** Daughters carry onboard PV + Li-ion battery (30 min autonomy). This is how real satellites work. Kill power-beaming from the daughter primary-power architecture.
- **Exotic-tier upgrade (game year 3+, TRL 6-7 projected):** "Laser Power Beaming Module" — a late-Shop upgrade (requires: solar wing upgrade, battery cap ×2, precision pointing module, thermal radiator upgrade). Unlocks ~50 W power-beamed to a daughter within 1 km line-of-sight. Enables longer autonomous daughter ops (hours instead of 30 min). **TRL 6 in-game Codex, projected 2030 in-game fiction.**
- **End-game tier (game year 4+, TRL 7-8 projected):** Scaled to 500 W at 5 km — enables daughter sensor suites and ablation-lite. **TRL 7 in-game, projected 2032+.**

This gives power beaming a legitimate upgrade-ladder role (see §36) without putting it on the critical path. The player experiences the real arc of "power beaming is getting better every year" — exactly mirroring real-world 2025→2030 research.

---

## 33. Redundancy Doctrine — Triple-String Where It Counts

### 33.1 The Rule Book

For critical subsystems (those whose failure is mission-ending), operational spacecraft use:
- **Dual redundancy minimum** (e.g., two star trackers)
- **Triple redundancy with voting** on flight computers and attitude-control electronics (Voyager, Cassini, JWST)
- **Cross-strapping** so any failure can be isolated and routed around

For non-critical:
- Single-string acceptable (e.g., one science instrument, one experimental payload)

### 33.2 V5 Application

| Subsystem | Redundancy |
|-----------|-----------|
| Flight computer | Triple (voted) — 🟢 standard |
| Attitude determination | Dual star trackers + IMU — 🟢 |
| Comms (ground link) | Dual — 🟢 |
| Main propulsion | Dual Hall thrusters — 🟢 (Starlink has 1 only, accepts sat-loss risk) |
| RCS | Minimum 4 × 2 thrusters (quad pod with hot spare) — 🟢 |
| Solar array | Dual wings — 🟢 |
| Battery | Single bank with cell-level bypass — 🟢 |
| Daughter crossbows | 6-8 arms; loss of 1-2 acceptable — 🟢 |
| Tether reels | Per-arm; no cross-redundancy — 🟡 accepted |

**Watchdogs + safe mode**: Every subsystem has a watchdog timer. If no nominal telemetry in N seconds, enter *safe mode* — shed non-essential loads, point solar panels to sun, wait for ground command. Every real sat has this. V5 should model it as a **"MOTHER IN SAFE MODE — RESUMING IN 3 MIN"** game event after rare telemetry loss. Teaches triple-redundancy doctrine through inconvenience.

---

## 34. GSL Near-Tech — Honest Assessment of the Upgrade

### 34.1 What GSL Actually Promises (and When)

Per V4 Opussy lead-designer projections: GSL at **50 GPa by end 2026**, TRL 6 (ground qualification). First flight demo **≥2028**. Operational-grade 10 km GSL tether: **≥2032** best case, given normal TRL-step timelines.

### 34.2 What Will Still Work with GSL

| Subsystem | Benefit when GSL arrives | Risk |
|-----------|-------------------------|------|
| Tether mass | 9× lighter per metre | Novel material creep, outgassing, AO erosion unknown |
| Tether length | 6× at same mass | Reel mechanisms untested at 10 km + new material |
| Net mesh | 90% lighter | Knot strength, frame buckling recalibration |
| Structural spars | Specific stiffness improvements | Creep at operating temps, micro-crack propagation |
| Electrical conductor | **Doesn't help** (σ_GSL ~ 580× worse than Cu) | Still need copper — no mass saving |
| Electrostatic capture pad (V4 §6) | Elegant on paper | 🔴 electric arcing risk at orbital plasma interface; see §28 |

### 34.3 What Won't Work (or Still Needs Decades)

- **Native conductivity replacing Cu** — §3.1 of V4 kills this: 580× resistance gap. Copper remains. 🔴 for ≥2040.
- **GSL primary structure** — TRL 3-4. Flight heritage requires 10-year qualification campaign. 🔴 for ≥2035.
- **Graphene radiation shielding** — theoretical advantage but lab-only data. 🟠 for years.
- **Electrostatic net (V4 §6)** — elegant but plasma arcing. Needs real-world plasma-chamber testing. 🟠.

### 34.4 Honest Game Framing

**V5 ships baseline with Dyneema SK78 2 km tethers** — 🟢 heritage.
**"V5-GSL Upgrade" is a Codex-tier progression** — as the player accumulates mission hours, GSL becomes available in Shop as "projected 2028 technology". Flavor text:
> *"Graphene superlattice fibre — projected TRL 7 by 2028. Your first batch is engineering units — don't count on the 10 km reach working first try. Budget spares."*

This is the **right** way to present near-tech: aspirational, clearly labelled, earned through play.

### 34.5 GSL Benefits Worth Building the Game Around

- **Same-mass 2× reach** — if Dyneema gives 2 km, GSL gives 4-5 km (real, 🟡 near-term). Keep this goal.
- **Lighter nets** — at 50 GPa, real mass savings on the deployable frame. 🟠 near-term.
- **Lighter electrostatic pad substrate** — HBN-coated GSL for the short-range daughter grip pad (not the whole tether). 🟠.
- **Structural upgrades to daughter arm body** — 10-20% mass reduction with GSL shells. 🟠.

These are the *honest* benefits. §14's claim of "10 km scavenge sphere → 244× larger sweep" is **2030s engineering** and should be framed as such in-game.

---

## 35. V5 Design Audit — Keep / Defer / Kill

Ruthless, line-by-line verdict on every V5 element in this document and [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md:1). Classification: **KEEP** (🟢/🟡 critical path), **DEFER** (🟠 flavor-only until TRL matures), **KILL** (🔴 unworkable or misleading).

### 35.1 Keep

| # | Element | Status | Justification |
|---|---------|--------|---------------|
| K1 | Spring-loaded crossbow launch | 🟢 | TRL 9 from CubeSat P-POD, Lightband. Real physics. |
| K2 | Nets as primary capture | 🟡 | RemoveDEBRIS 2018. Only operational method for tumbling. |
| K3 | Hall thruster main propulsion | 🟢 | Workhorse. |
| K4 | Dyneema SK78 tether @ 2 km | 🟢 | Real material, real flight heritage. |
| K5 | EPM docking latch | 🟡 | Zero-power hold. Real heritage (DARPA, UMD demos). |
| K6 | Triple-junction GaAs solar | 🟢 | Standard. |
| K7 | Ni-H₂ or Li-ion batteries (conservative DOD) | 🟢 | GPS/HST heritage. |
| K8 | LIDAR + camera rendezvous ladder | 🟢 | Operational since 2010 everywhere. |
| K9 | Dual-opposite fire for zero-recoil capture | 🟢 | Simple conservation of momentum. No exotic physics. |
| K10 | Y-bridle tether attachment avoiding FEEP plume | 🟢 | Real engineering concern, real solution. |
| K11 | Titanium bridle ring around Hall thrusters | 🟢 | Sacrificial hardware, standard doctrine. |
| K12 | Aluminum 7075 primary structure | 🟢 | Default. |
| K13 | MLI thermal blanket | 🟢 | Default. |
| K14 | Whipple shields on fuel tanks | 🟢 | ISS heritage. |
| K15 | Configuration variants (Quad Linear → Hex → Double) | 🟢 | Modularity is a real engineering virtue, no exotic physics. |
| K16 | 1-DOF yaw-only strut mounts (harmonic gear) | 🟢 | JPL Mars Sample Return arm heritage. Known. Reduced from 2-DOF (Rev 5) for vacuum reliability — halves actuator count. |
| K17 | Safe mode + watchdog event occasionally firing in-game | 🟢 | Teaches real redundancy doctrine. |
| K18 | Conservative battery DOD affecting mission life | 🟢 | Real phenomenon. |
| K19 | AO-induced VLEO hull aging (visual) | 🟢 | Real. Teaching value. |
| K20 | ISS-boss event triggered on real TLE catalog | 🟢 | Real mission driver. |
| K21 | Ground station pass windows | 🟢 | Real ops constraint. |

### 35.2 Defer — Keep as Flavor / Codex / Late-Game Only

| # | Element | Current status | Target state |
|---|---------|---------------|-------------|
| D1 | GSL tether at 10 km | §14 proposes as V5 baseline | Codex entry "2028+ tech". Game baseline stays Dyneema 2 km. |
| D2 | 20 km scavenge sphere | §14 headline claim | Reframe as "projected 2030s capability" |
| D3 | Synthetic-aperture LIDAR (long baseline) | §12 candidate-B | Codex entry. Don't build sim around it. |
| D4 | Elastic-tether momentum transfer | §15 | 🟠 research — keep as late-game upgrade with imperfect dynamics (teach instability) |
| D5 | Ablation propulsion | §16 | 🔴→🟠 — keep as CODEX ENTRY only. Not a player tool. |
| D6 | BeiDou-class laser comms | §17 | 🟡 mature for large sats, NOT 270 kg bus. Reframe as "mother↔ISS" only, not mother↔daughter. |
| D7 | YOLO edge detection for low-bw fallback | §17.2 | 🟠 — keep as flavor for degraded-comms events; don't make it the primary arch |
| D8 | V4 electrostatic-net concept | V4 §6 | 🔴 plasma arcing. Delete from V5. Electrostatic **pad on daughter** (short range) is 🟠 OK. |
| D9 | MEMS scanning mirror power beaming | V3 §4 | 🔴 — delete from V5. Daughters run on onboard PV + batteries. |
| D10 | Gecko-grip / electrostatic capture pads | V3 §7 | Codex entries. Not primary. |
| D11 | Ultra-long (8+ km) Dyneema tether | | 🟠 — no flight heritage beyond 2 km. Cap at 2 km for honest gameplay. |

### 35.3 Kill (Only True Killers Remain)

| # | Element | Reason |
|---|---------|--------|
| X1 | Power beaming **as daughter critical-path power** | TRL 5 at game start. **Moved to §32.3 exotic-tier upgrade** — not killed entirely. |
| X2 | 10 km GSL **as game-start baseline** | TRL 3 at game start. **Moved to §36 Year-3+ upgrade** — not killed. |
| X3 | Ablation **on daughter arm** | Can't carry a 10 kW laser on a 3.7 kg daughter. **§16 revised — ablation lives on mother, deorbit use.** |
| X4 | Electrostatic 3 kV on tether mesh | Will arc in orbital plasma — TSS-1R lesson. Pad-on-daughter OK. |
| X5 | 120 Gbps laser comms on 270 kg mother | BeiDou-3 is 5-tonne class; optical aperture & pointing don't scale down. Use 1-10 Gbps target instead. |
| X6 | Perovskite solar cells | Degrade in hours in UV. Triple-junction GaAs. |
| X7 | MPD as V5 RCS / game-start propulsion | 100 kW-class. **Moved to §36 Year-4+ final exotic upgrade** with prerequisites (reactor power, radiator, thermal mgmt). |
| X8 | GSL as **primary structural bus member** at game start | TRL 3. **Daughter shells at Year-2, primary bus Year-4+.** |
| X9 | "Unlimited reel-in cycles" on arm tethers | Real reels degrade. **Reel-cycle-count added as game resource per §28.3 / §11.** |
| X10 | Autonomous grapple of active satellites | Policy + safety. Hard-block in code. |
| X11 | Mussel-inspired wet-chemistry adhesive at game start | Requires water; vacuum sublimes it. **Codex-only until pre-cured variants mature (TRL 3→6).** |
| X12 | Synthetic aperture LIDAR on small bus | Baseline too short. Codex entry only. |

Net effect: only the true "game-start impossibilities" remain killed. Everything else (power beaming, 10 km GSL, MPD, ablation) has a **legitimate place on the upgrade ladder** and earns an in-game TRL number that increases over campaign time as real-world tech matures in game fiction.

### 35.4 What The Audit Yields

After Keep/Defer/Kill is applied, V5 becomes:
- **~85% 🟢/🟡 flight-proven or mature** technology
- **~10% 🟠 near-term research** (carefully flagged as such in Codex)
- **<5% 🔴 speculative** (only in flavor text, never in critical path)

The game still teaches cutting-edge concepts — **but honestly**. Players learn "here's what we have now" vs "here's what we think we can have in 10 years". That's rare in sci-fi games, and it's exactly what makes Kerbal Space Program and Orbiter beloved by engineers.

### 35.5 Updated V5 Baseline Spec (One-Line Summary) — Config G (2026-04-27)

> **V5 Mothership — Game-Start Baseline (TRL 9, "Y0" per §36 ladder):**
>
> **Config G barrel-axial:** ~242 kg wet (196 kg dry), Al-7075 octagonal bus **2.0m × 0.8m**, Hall-thruster main + N₂ cold-gas RCS, **ROSA panels** (2 × 2m × 1m along barrel in 0°/180° plane) + thin-film GaAs body-mount (~2,240 W peak), Li-ion battery (30% DOD), **Quad-4 config — 2 Large Daughters + 2 Small Daughters** on **1.6m struts** at **top-collar (Y=+0.9m)** with **0–180° meridian sweep** + lockable hinge (arms at 60°/120°/240°/300° in 3-plane layout), **strut-mounted reel** (Dyneema SK78 2 km, TRL 9), reel-cycle-count 20 per reel (real resource), **Capture Net** (weighted spinning Dyneema mesh) as primary capture tool + net-equipped daughter crossbows, LIDAR+camera rendezvous ladder (TRL 9), S-band ground link + 1550 nm laser ISL to ISS (TRL 7-8). **Semi-auto aim rotation** (Mother rotates to align sweep plane with target, crossbow fires on alignment). SSLV-first launch vehicle (PSLV rideshare backup). All `FEATURE_*` flags default `false`.
>
> See [`ARM_PIVOT_ANALYSIS.md §10.11`](ARM_PIVOT_ANALYSIS.md:1236) for locked Config G dimensions and [`ARM_PIVOT_GAPS_EXPLAINER.md §W`](archive/ARM_PIVOT_GAPS_EXPLAINER.md) for Epic 9 implementation specs.
>
> **Upgrade path (§36):** Y1 HBN coating + Hex (6 arms) refit (2026, TRL 7) → Y2 GSL engineering units 4-5 km (2028, TRL 7) → Y3 GSL 6 km operational + Octo (8 arms) refit + power-beaming 50 W (2030, TRL 6-8) → Y4 GSL 10 km + power-beaming 500 W + MPD thruster (2032+, TRL 5-8). *(Ablation module and Reality Mode deferred to Epic 10.)*

This is the ship the player flies at mission 1. Everything more ambitious is earned through mission hours + Shop unlocks, each with a real TRL number and a projected real-world flight date. A **Reality Mode** toggle (Epic 10) locks all upgrades off for purist TRL 9 playthrough.

---

## 36. Technology Upgrade Ladder — AI-Accelerated Roadmap

> *"Tech we have now → tech coming this decade → stretch goals." Real-world timelines, accelerated by AI-driven materials discovery, simulation-in-the-loop design, and foundation-model-assisted verification. The game's in-fiction year advances with player mission-hours, pulling new tech into range.*

### 36.1 Five-Year In-Fiction Timeline

| Year | Real-world corresponding | In-game unlock | TRL at unlock | What it enables |
|------|-------------------------|----------------|---------------|-----------------|
| **Y0** (start) | 2026 | Baseline — Dyneema 2 km tether, Capture Net, Hall + cold-gas, GaAs PV, Li-ion, S-band + LIDAR, **Quad-4 config (2 LD + 2 SD) on 1-DOF yaw-only struts**, **dual-metal FEEP** (indium default + 1 alt slot — gallium/iodine/bismuth), STATION_KEEP orbital-crane controls | TRL 9 (primary), 7 (net), 7–8 (FEEP) | Core game playable end-to-end with honest tech; 4 arms (Y0; expandable to 8 via tech ladder); 7-metal FEEP system ships at Y0 per locked principle #2 |
| **Y1** (~30 hr) | 2026-2027 | **HBN-coated Dyneema** tether, **gecko grip pads**, **green monoprop** (AF-M315E), unlock iodine + bismuth FEEP metals (TRL 6–7), **Hex (6 arms) refit** (3 LD + 3 SD) — requires Shipyard docking + Y1 credits | 7 | 3-year tether life, small-fragment capture, cleaner ground ops, expanded FEEP metal options, +2 daughters (6 total) |
| **Y2** (~120 hr) | 2028 | **GSL engineering units** (4-5 km reach), **daughter-mounted electrostatic pad** | 7 (GSL), 5 (pad) | 2× scavenge sphere, conductive-target grip |
| **Y3** (~300 hr) | 2030 | **GSL operational** (6 km reach), **Octo (8 arms) refit** (3 LD + 3 SD + 1 F + 1 B — requires Y1 Hex unlocked + Y3 credits + ablation module prereq), **Mother Ablation Module** (deorbit), **Power Beaming 50W** (exotic) | 8 / 6 / 6 | Clear whole clusters per pass, burn fragments out of orbit, longer daughter autonomy, HOUSTON: *"Octopus-class is fully operational"* |
| **Y4** (~700 hr) | 2032 | **GSL 10 km**, **Power Beaming 500 W**, **MPD thruster** final upgrade (requires prior reactor + radiator + AI-supervised thermal), tungsten FEEP (TRL 4) | 7 / 7-8 / 5 | 20 km scavenge sphere, daughter ablation, deep-space reach, max-ISP tungsten propellant |

### 36.2 How Upgrades Are Surfaced

- **Shop** — mid-game + late-game items appear after prerequisite chain (solar wing tier, battery tier, thermal radiator, pointing module). Players see locked items with "Requires: X, Y" labels.
- **Codex** — each upgrade has a Codex entry with real-world heritage + TRL + projected flight date. Reading the entry is optional but rewards engineers.
- **HOUSTON dialogue** — periodic mission-control chatter announces new tech: *"HOUSTON▸ Word is the GSL consortium just cleared TRL 7. Expect your Shop inventory to update next port call."*
- **TRL numbers on everything** — all items and Codex entries show a TRL (1-9) with projected year. No hand-waving.

### 36.3 Pacing Rationale

This cadence maps real-world aerospace-materials progress at the **AI-accelerated rate**:

- HBN roll-to-roll coating at scale is an active 2025 research goal (multiple labs). **2026 CubeSat demo realistic.**
- GSL at 50 GPa is projected by V4 Opussy's lead designer (via direct lab contacts) as TRL 6 by end-2026. **First flight 2028 is plausible.**
- Power-beaming km-scale spacecraft demos: DARPA POWER program 2023-2028 funding; AFRL parallel; multiple commercial efforts. **2030 demo realistic.**
- MPD thruster small-bus: not happening before 2032+ without a major breakthrough (requires multi-kW+ power supply that small buses can't carry yet).

Players who play for 50 hours see ~2 years of in-fiction tech progression. Players who play 500+ hours reach the end-game upgrade tier. This maps play-time to real tech pacing — feels earned, teaches honestly.

### 36.4 Fallback: Reality Mode Toggle

A **"Reality Mode"** toggle in the Options menu **locks all FEATURE_ flags to false** and caps the player at Y0 baseline forever. Everything works at TRL 9 only. For purist engineer players (and for the pedagogical variant where every capability is flight-proven today). This is a headline selling point for aerospace classrooms.

---

# PART V — INTEGRATION PLAN

## 37. Dependency Graph — What Must Happen First

```
┌────────────────────────────────────────────────────────────────┐
│                    FOUNDATIONAL LAYER                           │
│  §2 Data Catalog       §5 Trail System       §9 Tether Fix      │
│  (unblocks §3, 6, 19)   (unblocks §19)        (ships now)        │
└───────────────────────┬────────────────────────────────────────┘
                        │
┌───────────────────────▼────────────────────────────────────────┐
│                   CORE UX LAYER                                 │
│  §1 Comms redesign    §8 Orb improvements    §4 Strategic Map    │
│  §6 Debris parity     §7 Earth quality       §21 MOID            │
└───────────────────────┬────────────────────────────────────────┘
                        │
┌───────────────────────▼────────────────────────────────────────┐
│                 MISSION & EDUCATION LAYER                       │
│  §3 Missions (ISS)   §20 Porkchop    §22 Lambert    §24 Clstr    │
│  §23 CW band                                                    │
└───────────────────────┬────────────────────────────────────────┘
                        │
┌───────────────────────▼────────────────────────────────────────┐
│                     V5 HARDWARE LAYER                           │
│  §11 V5 Constants   §12 Configs    §13 Crossbow   §14 10km GSL   │
│  §15 Dual-release   §16 Ablation   §17 Laser+YOLO  §18 Bridle    │
└────────────────────────────────────────────────────────────────┘
```

**Hard dependencies:**
- §3 (Missions/ISS) requires §2 (real catalog for ISS TLE)
- §6 (debris country flags) requires §2 (owner_country field)
- §19 (teaching map) requires §5 (trails visible) + §21 (MOID) + §22 (Lambert)
- §14 (10 km tether) requires §11 (V5 Constants block)
- §16 (ablation) requires §17 (laser hardware model)

**Soft dependencies:** §4 (strategic map) benefits from §6 (prettier debris) but not blocked.

---

## 38. Quarterly Roadmap — 12-Month View

Roadmap **revised after the §35 audit + §36 upgrade ladder** — game ships with TRL 9 baseline (Dyneema 2 km, Hall, GaAs, Li-ion, LIDAR, bolas/net capture); Y1→Y4 upgrades arrive via Shop/Codex with TRL numbers + AI-accelerated projected dates.

| Quarter | Focus | Ships |
|---------|-------|-------|
| **Q1** ✅ | Foundations & UX | §9 red-line fix, §1 comms, §5 trails, §7 Earth LOD, §8 Orb stalks — complete [`HANDOFF.md`](HANDOFF.md:1) Tier A+B |
| **Q2** ✅ | Data, Education & Honest Framing | §2 catalog (with real TLEs + NORAD), §6 wireframe parity, §21 MOID, §4 strategic map, §19 teaching map, **§25 TRL badges in Codex**, **§30-§33 environment-effect events** (AO aging, radiation belt transits, MMOD strike events, safe-mode triggers) |
| **Q3** | Missions + Rendezvous Ladder | §3 ISS boss, ground stations, scavenger economy, §20 porkchop, §22 Lambert, §24 cluster window, **§27 GPS → LIDAR → camera ladder visible in HUD** |
| **Q4** ✅ (Epic 8) | Daughter-Arm Redesign + Dual-Metal FEEP + ISRO Heritage | **COMPLETE (2026-04-25)** — STATION_KEEP orbital-crane, 7-metal FEEP (Y0 baseline), news-driven missions, ReputationSystem, ISRO comms (BANGALORE/HASSAN), 4 ISRO ground stations, DockingReticle standoff sphere. 272 suites / 1,252 tests. Original V5 hardware items (§11–§18) deferred to Epic 9. **Design pivots adopted 2026-04-26:** 1-DOF strut (yaw only); Quad-4 Y0 baseline; arm-count tech ladder Y0→Y1→Y3. |

**Deferred to post-Q4 / backlog:** GSL 10 km tether (§14 as baseline — ship Dyneema 2 km instead), ablation propulsion as player tool (§16 — Codex only), BeiDou-3-class laser comms on small bus (§17 — reframe as ISS uplink only), V4 electrostatic-net (§D8 — delete).

**Stretch:** Phase 4 debris hand-models (§6 Phase 4), online catalogue update feed, multiplayer V5-to-V5 cooperation, a **"Reality Mode"** toggle that swaps all 🟠/🔴 tech for 🟢 only (purist sim).

---

## 39. Acceptance Criteria per Epic

### Q1 — UX Foundation
- [ ] Tether line is smooth catenary at all distances and orientations (no 90° kink)
- [ ] Comms pane 20% taller, 6 filter channels, radial command menu, center popup removed
- [ ] Player trail visible for 90 s, curves on WASD, teaches Newton in 5 seconds of play
- [ ] Earth texture auto-LOD (16k/8k/2k), camera FOV 55°, VLEO intro framing on first boot
- [ ] NavSphere stalks, lock-on ring, geolocation readout visible

### Q2 — Data, Education & Honest Framing
- [ ] `/data/*.json` loads offline, 36k+ real debris entries, ISS TLE, active sats
- [ ] Debris meshes match wireframe topology; country flag decals at <500 m
- [ ] MOID badge [HI]/[MD]/[LO] on every target row; ConjunctionSystem 10× faster
- [ ] `V` opens 3D strategic map; clustering, band rings, popular orbits labelled
- [ ] Teaching overlays fire on first encounter (trail curve, ellipse, porkchop preview)
- [ ] **Every Codex entry, Shop item, and tool tooltip shows a TRL number (1-9)** per §25
- [ ] Environment-effect events fire: AO-induced hull aging (cosmetic), MMOD strike event, safe-mode trigger, radiation-belt transit cost, battery-DOD lifetime curve

### Q3 — Missions + Rendezvous Ladder
- [ ] MissionSystem spawns tier 1-5 missions; BriefingScreen has cluster picker
- [ ] ISS boss event fires twice per game-year with 6-h warning; rewards for success
- [ ] Ground-station pass windows toggle telemetry stream + HOUSTON availability
- [ ] Scavenger economy — player scavenges xenon/hydrazine/GaAs to reach ISS/GEO
- [ ] Porkchop plot, Lambert solver, cluster countdown render correctly for 10+ cases
- [ ] HUD sensor readout visibly swaps instruments (GPS → RADAR → LIDAR → FLASH LIDAR → FIDUCIAL → DOCK FEEDBACK) as player closes range

### Q4 — Epic 8: Daughter-Arm Redesign + Dual-Metal FEEP + ISRO Heritage ✅ COMPLETE

**Delivered (2026-04-25):** 272 suites / 1,252 tests / 0 failures.

- [x] **STATION_KEEP state** — `ARM_STATES.STATION_KEEP`, spherical orbit positioning with lerp, phi/radius clamping, fuel consumption
- [x] **Orbital-crane controls** — Arrow keys orbit θ/φ, +/- radial distance, Shift fine mode (¼), F capture, ESC recall, context-aware HUD strip
- [x] **Dual-metal FEEP as Y0 baseline** — 7 metals (In/Ga/Bi/I/Hg/Cs/W), `ION_THRUSTER_METALS` lookup, auto-ISP by flight phase, F2 cycles metals
- [x] **ForgeSystem FEEP metal yields** — 8 debris types → metal distributions, `refinedMetals` inventory
- [x] **News-driven missions** — `data/news-events.json` (3 real-world events), capture-count gating, NEWS_EVENT_TRIGGERED
- [x] **ReputationSystem** — 5 partners (USA/SpaceX/Thailand/ESA/India), 4 tiers, event-driven tracking
- [x] **ISRO comms** — BANGALORE/HASSAN personas, 4 ISRO ground stations, handoff dialogue
- [x] **7 FEEP Codex entries** (PROPULSION) + **3 news Codex entries** (NEWS) + **4 ISRO heritage entries** (HERITAGE)
- [x] **DockingReticle standoff sphere** — wireframe (0x00ffaa, 15% opacity), θ/φ/R readout, range bar
- [x] **NavSphere sibling markers** — amber diamonds for deployed arms in ARM_PILOT
- [x] All 3 locked principles honored: ✅ Offline-First, ✅ Dual-Metal FEEP Y0, ✅ India Launch Heritage

**Remaining Q4 items deferred to Epic 9 (V5 Hardware Baseline):**
- [ ] V5 constants block with `FEATURE_*` flags all default `false` (§11)
- [ ] Capture Net System — cling, tangle, fragmentation, per-platform nets (§29, [`CAPTURE_NET.md`](CAPTURE_NET.md))
- [ ] Arm-count tech ladder Quad Y0 → Hex Y1 → Octo Y3 (§12, Rev 5)
- [ ] 1-DOF yaw-only strut (§12.4, Rev 5) + dual-opposite fire = 0 recoil (§15)
- [ ] CW accuracy band (§23)
- [ ] Bridle-ring FEEP-plume exclusion (§18)
- [ ] Mother-mounted ablation module (§16)
- [ ] Technology Upgrade Ladder surfaced via Shop (§36)
- [ ] Reality Mode toggle (§36.4)

---

## References

- [`HANDOFF.md`](HANDOFF.md:1) — tactical next-shift brief (9 items, 4 sprints)
- [`AUTOPILOT_ANALYSIS.md`](AUTOPILOT_ANALYSIS.md:1) — trailing-rendezvous design + 3 debug retrospectives
- [`archive/V3 Octopus.md`](archive/V3%20Octopus.md:1) — V3 hardware baseline
- [`archive/V4 Opussy.md`](archive/V4%20Opussy.md:1) — GSL upgrade path
- [`CROSSBOW_ARMS.md`](CROSSBOW_ARMS.md:1) — V5 crossbow + tether design bible
- [`GAME_DESIGN.md`](GAME_DESIGN.md:1) — core loop + heritage
- [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md:1) — concept-per-skill mapping
- [`FIRST_EXPERIENCE.md`](archive/FIRST_EXPERIENCE.md:1) — 90-second onboarding design

*Document owner: Architect shift. Updates: every quarter end. Next review after Q1 closes.*
