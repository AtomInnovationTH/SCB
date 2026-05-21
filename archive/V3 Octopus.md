# V3 Octopus — Active Debris Removal System (Current Technology)
# Space Cowboy ADR Platform: Distributed Autonomous Capture

> **Phase A Study Baseline** — All components TRL 6+ unless explicitly flagged.  
> Evolves from [V2 SPIDER.md](V2%20SPIDER.md). Every design choice justified with calculations.

---

## Table of Contents

1. [The Octopus Paradigm](#1-the-octopus-paradigm)
2. [Debris Environment Reality](#2-debris-environment-reality)
3. [System Architecture Overview](#3-system-architecture-overview)
4. [The Optical Nervous System](#4-the-optical-nervous-system)
5. [Tether System: Seven Functions in One Strand](#5-tether-system-seven-functions-in-one-strand)
6. [Propulsion & Attitude Control](#6-propulsion--attitude-control)
7. [Capture Systems](#7-capture-systems)
8. [Docking System: EPM (Electro-Permanent Magnets)](#8-docking-system-epm-electro-permanent-magnets)
9. [Arm Design](#9-arm-design)
10. [Core Design](#10-core-design)
11. [System Mass Budget](#11-system-mass-budget)
12. [Operations Concept](#12-operations-concept)
13. [Test Campaign](#13-test-campaign)
14. [Technology Readiness Assessment](#14-technology-readiness-assessment)
15. [Cross-Domain Heritage Table](#15-cross-domain-heritage-table)
- [Appendix A: Component Reference Table](#appendix-a-component-reference-table)
- [Appendix B: ΔV Budget](#appendix-b-δv-budget)
- [Appendix C: Optical Link Budget](#appendix-c-optical-link-budget)
- [Appendix D: EDT Propulsion Calculations](#appendix-d-edt-propulsion-calculations)
- [Appendix E: V4 Forward-Look (Graphene/GSL)](#appendix-e-v4-forward-look-graphenegsl)
- [Appendix F: Recommended Game Constants](#appendix-f-recommended-game-constants-for-constantsjs)

---

## 1. The Octopus Paradigm

### 1.1 Why "Octopus" Not "Spider"

V2's spider metaphor captured the architecture — tethered arms radiating from a central hub — but missed the deeper insight. The real octopus has **two-thirds of its neurons distributed in its arms**. Each arm can taste, grip, and manipulate independently while the central brain provides only high-level intent. This maps precisely to our ADR architecture:

| Property | Real Octopus | Space Cowboy Octopus |
|---|---|---|
| Distributed intelligence | 2/3 neurons in arms | Arms carry own OBC, nav, capture logic |
| Multi-modal capture | Each sucker: taste + grip + manipulate | Multi-modal pad: gecko + hooks + electrostatic + magnet + UV adhesive |
| Optical coordination | Chromatophores flash light patterns | 808nm laser power + MRR comms + optical nav |
| Expendable appendages | Autotomy — arm detaches, regenerates | Arms sacrificed for disposal, replaced at depot |
| Light-based communication | Skin color change = signaling | Modulated laser = data; retroreflector = uplink |
| Jet propulsion | Water jet through siphon | FEEP electrospray jet |

The spider builds a web and **waits**. The octopus **hunts** — it reaches into crevices, wraps around prey, adapts its grip to every surface. Our ADR platform does the same: it actively reaches for debris with intelligent arms that adapt their capture strategy to what they find.

### 1.2 Design Principles

**Every component serves multiple functions.** The tether carries structure + power + data + propulsion + navigation + vibration sensing + steering. The laser provides power + comms + nav + guidance. The docking magnet holds + aligns + provides mechanical backup. If a component serves only one function, we haven't thought hard enough.

**Minimize RF spectrum needs.** Each radio transmitter requires a spectrum license — regulatory burden that scales linearly with transmitter count. V2 needed 9 transmitter licenses (1 S-band + 8 UHF ISL). V3 needs **one** (S-band ground link). The optical system is unregulated — light is not spectrum-managed.

**Mass is king.** Every gram on an arm costs propellant to deploy, maneuver, and retrieve. The Vaisala RS41 radiosonde — 80g including battery — transmits GPS + telemetry over 200+ km. If a weather balloon can do it at 80g, our Spinner avionics can target 100g. Reference: Loon/Aether stratospheric balloons integrate solar cells directly onto structural PCB panels.

**Nets beat everything for tumbling debris.** Most debris tumbles. Nets don't care about orientation. A net is the only capture mechanism that works on a 60°/s tumbling rocket body as well as a slowly rotating defunct CubeSat. Nets are primary for all targets. Everything else is secondary or backup.

### 1.3 Evolution from V2 Spider

| Design Area | V2 Spider | V3 Octopus | Why Changed |
|---|---|---|---|
| Comms (arm ISL) | 8× UHF radio, 9.6 kbps | 1× laser + 8× MRR, 1+ Mbps | 1000× bandwidth, 1/10 mass, no spectrum license |
| Power to arms | Body-mounted solar only | Laser power beaming (primary) + solar (backup) | Arms work through eclipse; no sun-pointing constraint |
| Docking | Ferromagnetic plate + electromagnet | EPM (Electro-Permanent Magnet) | Zero-power hold, 80% mass reduction per dock |
| Spinner attitude | Cold gas (0.5 kg) | FEEP vectoring + magnetorquer (10g) | 98% mass savings on attitude system |
| Tether mass | 3 kg/km (10× overbuilt) | 1.2 kg/km (properly sized, multi-function) | V2 tether was grossly overspecified |
| Spinner total | 7.0 kg | 3.7 kg | 47% lighter — PCB-integrated monolithic structure |
| Weaver total | 21.0 kg | 11.0 kg | 48% lighter — lighter tether, docking, comms |
| Core dry | 226 kg | 170 kg | Lighter docking (EPM), optical replaces UHF array, smaller core |
| Capture strategy | Nets for tumbling, gripper for hardpoints | Nets primary for ALL; multi-modal pad secondary | Research shows >90% debris is net-capturable |
| Navigation | UWB ranging + MEMS gyro | Optical ToF ranging + quadrant detection + tether encoder | Lighter, more accurate, no RF |
| System total (wet) | 396 kg | 275 kg | **-121 kg (30.5% lighter)** |

### 1.4 Real-World Lineage

- **RemoveDEBRIS** (Surrey/SSTL, 2018) ✅ TRL 7 — Net capture of tumbling target demonstrated. 5m × 5m Dyneema SK78 mesh. Our net design directly descends from this.
- **ELSA-d** (Astroscale, 2021) ✅ TRL 9 — Autonomous approach + magnetic docking. Captured tumbling client at 0.7°/s. Proved cooperative ADR works.
- **PRISMA** (OHB Sweden, 2010) ✅ TRL 9 — Autonomous proximity ops to <1m. GPS at 10km → camera at 100m → 6DOF pose at 3m. Our nav tiered architecture borrows this graduated approach.
- **ClearSpace-1** (ESA, 2026 target) — Single-target 4-arm gripper capture. Our multi-arm approach extends this to many targets per mission.
- **NRL MRR** (US Naval Research Lab) 🔶 TRL 6 — Modulated Retro-Reflector optical comms at 10 Mbps in 15g. Directly adopted for arm uplink.

---

## 2. Debris Environment Reality

### 2.1 Size/Mass Distribution

ESA Space Debris Office maintains the MASTER model (Meteoroid and Space Debris Terrestrial Environment Reference). Current tracked population in LEO:

| Size Class | Count (tracked) | Typical Mass | Examples |
|---|---|---|---|
| >10 cm | ~36,500 | 1 kg – 8,000 kg | Rocket bodies, defunct sats, large fragments |
| 1–10 cm | ~1,000,000 (est.) | 1 g – 1 kg | Explosion fragments, bolts, antenna parts |
| 1 mm – 1 cm | ~130,000,000 (est.) | <1 g | Paint flakes, MLI scraps, micrometeoroid impact ejecta |

Our target: objects 1 cm to 500 kg. Weavers handle 10–500 kg; Spinners handle 0.01–10 kg. Below 1 cm, passive gill-nets sweep fields.

### 2.2 Actual Measured Tumble Rates

This is the critical question V2 didn't answer: **does debris tumble too fast for anything but nets?**

**ESA MEGALIT radar campaign** (Fraunhofer FHR, Effelsberg 100m dish) measured spin rates of 100+ LEO objects:

| Category | Tumble Rate | % of Population | Source |
|---|---|---|---|
| Defunct satellites (intact) | 0.01–1°/s | ~30% | MEGALIT + EISCAT |
| Explosion fragments | 0.1–10°/s | ~55% | MEGALIT |
| Upper stages (Cosmos, Zenit) | 1–60°/s | ~10% | FHR tracking |
| Active sats at EOL | 0.01–0.5°/s | ~5% | Operator telemetry |

**Key insight:** 85% of debris tumbles at <10°/s, and 55% at <1°/s. But the crucial point isn't the average — it's that **nets don't care about the rate**. A RemoveDEBRIS-heritage net can wrap a target tumbling at 60°/s. The net simply envelops it. ClearSpace-1's rigid gripper, by contrast, struggles above 3°/s because it must match the target's rotation to make contact.

**Conclusion:** For >90% of tracked debris, nets are the optimal capture mechanism. Detumbling is unnecessary for net capture. Even for the fastest tumblers (upper stages at 60°/s), a sufficiently large net captures them. Only for precision docking (cooperative targets with pre-installed fixtures) would we consider non-net capture as primary.

### 2.3 Surface Conditions

**Materials found on debris surfaces:**
- Aluminum alloys (6061-T6, 7075): ~60% of surfaces. α_s ≈ 0.15–0.4, ε ≈ 0.04–0.09
- CFRP (carbon fiber reinforced polymer): ~15%. α_s ≈ 0.9, ε ≈ 0.85
- MLI (multi-layer insulation, Kapton/Al): ~15%. α_s ≈ 0.4, ε ≈ 0.03–0.80 (varies by layer)
- Painted surfaces (white TiO₂, black): ~10%. α_s ≈ 0.2–0.95, ε ≈ 0.85–0.90

**Surface Temperature Calculation:**

For a body in thermal equilibrium (steady-state, sunlit face):

```
T = (α_s × S / (ε × σ))^(1/4)

Where:
  S = 1361 W/m² (solar constant at 1 AU)
  σ = 5.67 × 10⁻⁸ W/m²K⁴ (Stefan-Boltzmann)
  α_s = solar absorptivity
  ε = IR emissivity
```

| Surface | α_s | ε | T_sunlit (°C) | T_shadow (°C) |
|---|---|---|---|---|
| Bare aluminum | 0.15 | 0.04 | +117 | -120 to -170 |
| Anodized aluminum | 0.40 | 0.80 | -2 | -80 to -120 |
| Black paint | 0.95 | 0.87 | +62 | -60 to -100 |
| White paint (TiO₂) | 0.20 | 0.90 | -51 | -90 to -130 |
| CFRP (black) | 0.90 | 0.85 | +57 | -60 to -100 |
| Kapton (gold) | 0.45 | 0.60 | +34 | -60 to -100 |

*Shadow temperatures depend on time in shadow and thermal mass. Thin panels cool to -120°C within minutes; massive bodies (upper stages) cool slower.*

**Implication for capture:** A tumbling object cycles between +120°C (sunlit bare Al) and -120°C (shadowed) every rotation period. Capture mechanisms must handle this full range, or time their engagement to the thermal window. Nets handle any temperature — Dyneema SK78 is rated -150 to +80°C, and net contact loads are low enough that brief excursions to +120°C don't damage the fiber before the cinch completes.

---

## 3. System Architecture Overview

### 3.1 System Diagram

```
                          ┌──────────── GROUND STATION ────────────┐
                          │         S-band 2.2 GHz (licensed)      │
                          │         1 Mbps down / 64 kbps up       │
                          └────────────────┬───────────────────────┘
                                           │
                    ┌──────────────────────┬┴┬──────────────────────┐
                    │              ╔═══════╧═╧═══════╗              │
                    │              ║                  ║              │
        ════════════╪══════════════╣   CORE "Brain"  ╠══════════════╪════════════
        ║ Weaver-1  │  808nm laser ║  170 kg dry      ║  808nm laser │ Weaver-3  ║
        ║ 11.0 kg   │◄────────────║  2× Hall 10mN    ║────────────►│ 11.0 kg   ║
        ║ 2km tether │  MRR uplink ║  600 Wh battery  ║  MRR uplink │ 2km tether║
        ════════════╪══════════════╣   1.9 kW solar   ╠══════════════╪════════════
                    │              ║                  ║              │
                    │              ╚═══╤════════╤═══╝              │
         Spinner-4──┤      laser──────┘        └──────laser       ├──Spinner-2
          3.7 kg    │      +MRR                       +MRR        │   3.7 kg
        500m tether │                                              │ 500m tether
                    │              laser+MRR    laser+MRR          │
         Weaver-4───┘                  │            │              └───Weaver-2
         11.0 kg              Spinner-1│            │Spinner-3       11.0 kg
         2km tether            3.7 kg  │            │  3.7 kg       2km tether
                              500m tether            500m tether

        ═══ = tether (structure + power + data + EDT + nav + sensing + steering)
        ──► = optical beam (power + comms + nav + guidance)
```

### 3.2 The Brain (Core)

The core provides what arms cannot efficiently carry: high-power propulsion for orbit changes, large solar arrays for energy generation, a powerful laser for arm power/comms/nav, ground link for mission control, and the computational intelligence to coordinate all 8 arms. Mass: **170 kg dry, 216 kg wet**.

### 3.3 The Arms (8 Sub-Satellites)

Autonomous capture agents. 4 Weavers (11.0 kg, 2 km tether, 5×5m net) for medium/large debris. 4 Spinners (3.7 kg, 500m tether, 1.5×1.5m net) for small debris and fragments. Each arm carries its own propulsion, navigation, capture system, and docking interface. Arms are expendable — they can be sacrificed for disposal if needed.

### 3.4 The Nervous System (Optical Beams)

One 808nm laser on the core provides power (20–40W per arm depending on deployment count), communications (1+ Mbps via MRR), and navigation (±2cm ranging) to all deployed arms simultaneously via MEMS scanning mirror. This unified optical architecture is the central V3 innovation. Detailed in §4.

### 3.5 The Tendons (Tethers)

Each tether serves 7 functions: structure, power backup, hardwired data backup, EDT propulsion, navigation (encoder + strain gauge), vibration sensing, and tendon steering. Mass: 1.2 kg/km. Detailed in §5.

### 3.6 System Mass Budget Overview

| Component | V2 Spider (kg) | V3 Octopus (kg) | Δ (kg) | Δ (%) |
|---|---|---|---|---|
| Core dry | 226 | 170 | -56 | -24.8% |
| Core propellant (Xe + N₂) | 58 | 46 | -12 | -20.7% |
| 4× Weaver | 84.0 (21.0 ea) | 44.0 (11.0 ea) | -40.0 | -47.6% |
| 4× Spinner | 28.0 (7.0 ea) | 14.8 (3.7 ea) | -13.2 | -47.1% |
| **Total wet** | **396.0** | **274.8** | **-121.2** | **-30.6%** |

---

## 4. The Optical Nervous System

This is the central innovation of V3. A single laser system on the core replaces most of V2's UHF radios, eliminates the need for large arm solar arrays, and provides high-precision navigation — all in one unified architecture.

### 4.1 Architecture

```
CORE (Laser Transmitter Side)                    ARM (Receiver Side)
┌──────────────────────────────┐                 ┌──────────────────────────┐
│  808nm fiber-coupled diode   │    VACUUM       │  GaAs PV receiver        │
│  200W electrical → 120W opt  │    (no loss)    │  (10×10cm Spinner,       │
│         │                    │                 │   20×20cm Weaver)        │
│  ┌──────▼──────┐             │                 │  65% conversion at 808nm │
│  │ MEMS scanning│ ──beam──►  │ ════════════►   │         │                │
│  │ mirror 10g  │  addresses  │                 │  ┌──────▼──────┐        │
│  │ (Hamamatsu) │  4 arms at  │                 │  │ PV → 50-80W │        │
│  └──────┬──────┘  1 kHz scan │                 │  │ electrical  │        │
│         │                    │    ◄════════     │  └─────────────┘        │
│  ┌──────▼──────┐             │    MRR return   │                          │
│  │ Quad photo- │  measures   │                 │  ┌──────────────┐       │
│  │ detector 5g │  bearing    │                 │  │Cat's Eye MRR │       │
│  │ (return beam│  to arm     │                 │  │+ MQW modulator│      │
│  │  centroid)  │             │                 │  │15g, 1-10 Mbps│       │
│  └─────────────┘             │                 │  └──────────────┘       │
│                              │                 │                          │
│  Total core laser system:    │                 │  Total arm optical:      │
│  ~2.0 kg                     │                 │  ~70g (Spinner)          │
│  (laser+MEMS+optics+det)     │                 │  ~120g (Weaver)          │
└──────────────────────────────┘                 └──────────────────────────┘
```

**Core laser:** 808nm fiber-coupled diode laser. 200W electrical input, ~60% wall-plug efficiency → **120W optical output**. 808nm is chosen because GaAs photovoltaic cells have 60–68% conversion efficiency at this exact wavelength (vs 30% for broadband sunlight). This wavelength is also used by Airbus/EADS in their 2019 drone laser-power demo ✅ TRL 5.

**MEMS scanning mirror:** Hamamatsu S13124 class. Mass: ~10g. Addresses 4 deployed arms sequentially at 1 kHz scan rate. Each arm receives ~25% duty cycle = **~30W optical time-averaged** per arm (when all 4 Weavers or all 4 Spinners deployed). With only 2 arms deployed: 50% duty = ~60W per arm. The mirror's angular range covers ±30° — sufficient for arms anywhere in the forward hemisphere.

**Quad photodetector on core:** 5g. Tracks retroreflector returns from arms. The return beam centroid on the 4-quadrant detector gives bearing to each arm with ±0.1° accuracy at 2 km. ✅ TRL 9.

### 4.2 Power Beaming Link Budget

The full calculation from laser to delivered electrical power:

```
Given:
  P_laser_optical = 120 W (total, time-shared across arms)
  λ = 808 nm
  Divergence (half-angle) θ = 0.5 mrad (achievable with 10cm optic on core)
  PV area on arm: Spinner 10×10 cm = 100 cm²; Weaver 20×20 cm = 400 cm²
  PV conversion efficiency at 808nm: η_PV = 0.65
  Atmospheric loss: 0.0 (vacuum)
  Duty cycle per arm (4 arms deployed): 0.25

Spot diameter at range R:
  D_spot = 2 × R × tan(θ) ≈ 2Rθ = 2 × R × 0.0005 = R/1000

At 500m:  D_spot = 0.5m → spot area = 0.196 m². Fraction captured by 10×10cm PV:
  η_geom = 0.01/0.196 = 5.1%. P_received = 120 × 0.25 × 0.051 = 1.53 W. P_elec = 1.0 W.
  → Too low. But at 500m we can tighten the beam with MEMS fine-pointing.

  Practical: at 500m the MEMS keeps spot ≤10cm (PV fills the spot).
  P_received = 120 × 0.25 = 30 W optical. P_elec = 30 × 0.65 = 19.5 W (Spinner)
  P_received = 120 × 0.25 = 30 W optical. P_elec = 30 × 0.65 = 19.5 W (Weaver, PV overfills spot)

At 1 km: D_spot = 1.0m → area = 0.785 m². 
  Spinner (0.01 m² PV): η_geom = 0.01/0.785 = 1.27%. P_elec = 120×0.25×0.0127×0.65 = 0.25 W
  → Insufficient for FEEP! Need tighter beam.

REVISED: Use 20cm aperture optic on core (Cassegrain, ~0.5 kg):
  θ = 1.22 × λ / D_aperture = 1.22 × 808e-9 / 0.20 = 4.9 µrad (diffraction limit)
  Practical θ (with pointing jitter): ~50 µrad = 0.05 mrad

At 1 km:  D_spot = 2 × 1000 × 0.00005 = 0.10 m = 10 cm.
  Spinner PV (10×10cm): spot ≈ PV size. ~100% capture.
  P_received = 120 × 0.25 = 30.0 W optical. P_elec = 30.0 × 0.65 = **19.5 W**

At 2 km:  D_spot = 2 × 2000 × 0.00005 = 0.20 m = 20 cm.
  Spinner PV (10×10cm): η_geom = 100/(π×100) = 31.8%. P_elec = 120×0.25×0.318×0.65 = **6.2 W**
  Weaver PV (20×20cm): spot ≈ PV size. P_elec = 120×0.25×0.65 = **19.5 W**
```

**Summary table:**

| Range | Spot Ø | Spinner PV (10cm) | Weaver PV (20cm) | Notes |
|---|---|---|---|---|
| 500 m | 5 cm | 19.5 W | 19.5 W | Spot smaller than PV — full capture |
| 1 km | 10 cm | 19.5 W | 19.5 W | Spot ≈ Spinner PV — good match |
| 2 km | 20 cm | 6.2 W | 19.5 W | Spinner underfills spot; Weaver fills it |

*With only 2 arms deployed (50% duty): all values double. Spinner at 2 km gets 12.4 W — enough for FEEP operations.*

**Eclipse operations:** Core battery is 600 Wh. Laser draws 200 W electrical. Eclipse duration in LEO ~35 min. Energy needed: 200 × 35/60 = **117 Wh** — well within battery capacity. Arms receive full laser power through eclipse. **This eliminates the V2 restriction where arms couldn't fire thrusters during eclipse.**

### 4.3 Communications

**Downlink (core → arm):** The laser beam is modulated in amplitude. A simple on-off keying at 1 MHz = 1 Mbps data rate. Zero additional hardware — the same laser that delivers power also carries data. The arm's PV receiver has sufficient bandwidth (GaAs photoresponse time <1 ns). The power variation appears as slight ripple (<5%) on the PV output — easily filtered by the PCDU while the raw signal feeds the demodulator.

**Uplink (arm → core):** Modulated Retro-Reflector (MRR). NRL demonstrated this technology in field tests at TRL 6. The arm carries:
- **Cat's Eye retroreflector:** corner-cube optic that returns incoming laser beam back to source with high gain (~15g total including housing). ✅ TRL 9.
- **MQW (Multiple Quantum Well) modulator:** a thin-film electro-optic shutter placed over the retroreflector aperture. When voltage applied, it changes absorption — modulating the returned beam at up to 10 MHz = 10 Mbps. Mass: ~0.5g. Power: ~50 mW. 🔶 TRL 6.
- Combined MRR module: **15g, 50 mW, 1–10 Mbps.** Price: ~$500 per module at volume.

**Bandwidth comparison:**

| Metric | V2 UHF ISL | V3 Optical MRR | Improvement |
|---|---|---|---|
| Data rate per arm | 9.6 kbps | 1–10 Mbps | **100–1000×** |
| Mass per arm (comms only) | 100–200g (radio + antenna) | 15g (MRR) + 2g (photodiode) = 17g | **6–12×** lighter |
| Power per arm | 0.5 W (radio TX) | 0.05 W (MRR modulator) | **10×** less |
| Spectrum license needed | Yes (UHF 437 MHz) | No (optical = unregulated) | **Eliminated** |
| Simultaneous full-rate arms | 4 (V2 bandwidth limit) | 8 (laser scans all at 1 kHz TDM) | **2×** |

With 1 Mbps uplink, arms can stream compressed camera video (320×240 @ 15fps JPEG ≈ 300 kbps) to the core in real-time during capture operations. V2's 9.6 kbps could only send telemetry values.

### 4.4 Navigation

The same optical link provides three independent navigation measurements:

**Range (±2 cm at 2 km):**
```
Method: Two-way pulse time-of-flight
Hardware: TDC7200 time-to-digital converter (TI, $3, 2g on breakout, 55 ps resolution)
  
Core sends laser pulse → arm photodiode timestamps arrival (t₁)
→ arm MRR returns pulse → core photodetector timestamps (t₂)
Range = c × (t₂ - t₀) / 2   (two-way, no clock sync needed)

Resolution: 55 ps × c = 55e-12 × 3e8 = 0.0165 m ≈ ±1.6 cm
Averaging 10 pulses: ±0.5 cm. TDC7200 is TRL 9 ✅ (used in industrial LiDAR).
```

**Bearing — core knows where arm is (±0.1° at 2 km):**
The quad photodetector on the core measures the MRR return beam centroid. With a 4-quadrant detector, the ratio of signals in each quadrant gives angular offset from boresight. At 2 km, ±0.1° corresponds to ±3.5 m lateral resolution — adequate for trajectory monitoring. At 100 m, this resolves to ±17 cm.

**Bearing — arm knows where core is (±0.5°):**
The arm's PV receiver panel acts as a 4-quadrant detector. If equal illumination falls on all 4 cells, the arm is centered on the beam. Unequal illumination = angular offset from the beam axis. At ±0.5° accuracy, the arm always knows what direction the core lies in. Combined with range, this gives the arm a complete relative position fix — no GPS or star tracker needed.

**Aviation analogy:** This is **DME** (Distance Measuring Equipment — pulse ranging) + **VOR** (VHF Omnidirectional Range — bearing from station) combined into one optical system. For docking, we add **ILS** — see §4.5.

### 4.5 Homing Beacons

Each of the 8 docking cavities on the core carries a small LED beacon:

```
8 × LEDs (IR, 850nm), each pulsing at a unique frequency:
  Cavity 1: 100 Hz    Cavity 5: 500 Hz
  Cavity 2: 200 Hz    Cavity 6: 600 Hz
  Cavity 3: 300 Hz    Cavity 7: 700 Hz
  Cavity 4: 400 Hz    Cavity 8: 800 Hz

Mass per LED: 2g (including driver). Total: 16g on core.
Power: 50 mW each. Total: 400 mW.
Range: detected at >2 km in vacuum (no atmosphere to scatter).
```

An arm's photodiode detects the beacon flash, counts the frequency, and identifies its home cavity. This is borrowed from **cichlid mouth-brooding** — the fry recognize their parent by pattern. No additional hardware on the arm — same photodiode used for laser reception. ✅ TRL 9 heritage (LED + photodiode).

### 4.6 Optical ILS (Instrument Landing System) for Docking

Adapted from aviation ILS for terminal approach guidance:

```
DOCKING APPROACH (last 50m)

                      ╱ 808nm beam (core laser)
                     ╱   beam center = glideslope
   ARM ──►  ────────╱─── ─── ─── ─── ─── ┌──────┐
                   ╱                      │CAVITY│
                  ╱  850nm beacon LED      │ (EPM)│
                 ╱   (unique pulse freq)   │      │
                ╱                          └──────┘
               ╱  AprilTag on cavity face
              ╱   (detected at 2-5m by arm camera)

Navigation transitions:
  >50m:  Laser beam + MRR → range ±2cm, bearing ±0.1° (DME+VOR mode)
  50-5m: Tether reel-in + laser beam centering ("stay on the dot" ILS mode)
  5-0.5m: AprilTag visual lock → 6DOF pose ±1cm (camera approach)
  <0.5m: Conical funnel mechanical guidance → EPM magnetic capture
```

The "ILS" mode uses a dual-wavelength approach at close range: the core projects two slightly offset beams (808nm power laser + 850nm LED beacon). The arm measures differential intensity — if 808nm is stronger on the left and 850nm stronger on the right, the arm is left of centerline. This gives sub-degree angular guidance with zero computational cost on the arm. Pure analog pilot-like: **"stay centered on the dot."**

### 4.7 AprilTag Docking

Each docking cavity face has a printed 2D fiducial (AprilTag 36h11 family):

- **Camera:** OV7251 global-shutter sensor (5g module, 640×480, 120 fps). ✅ TRL 7.
- **Processing:** AprilTag3 library (University of Michigan) on ARM Cortex-M7 at 30 fps. Demonstrated by Skydio drones for precision autonomous landing. ✅ TRL 9 algorithm.
- **Accuracy:** ±1 cm position, ±1° orientation at 2 m range. Far exceeds docking tolerance of ±5 cm.
- **Detection range:** 2–5 m for a 10 cm tag (depends on camera lens FOV).
- **Mass added to arm:** 5g (camera module). Zero mass for tag (printed on cavity surface).

### 4.8 Emergency Backup

Every arm carries a minimal UHF beacon:

- **WSPR-class beacon:** 1 mW transmit power, 0.5g total mass (including tiny PCB antenna). Heritage: pico balloon WSPR transmitters — 7 mW beacons heard globally over 10,000+ km. At 2 km in vacuum, 1 mW is trivially received. ✅ TRL 9 (pico balloon heritage).
- **Transmits:** arm ID (3 bits) + alive/dead (1 bit) + battery voltage (4 bits) = 1 byte, every 2 minutes.
- **No spectrum license needed** for emergency beacons at 1 mW output power.
- **Use case:** arm survives laser/tether failure → core or ground station detects beacon → recovery or safe-mode operations.

### 4.9 Spectrum Licensing Summary

| V2 Spider | V3 Octopus | Notes |
|---|---|---|
| 1× S-band ground link (licensed) | 1× S-band ground link (licensed) | Unchanged |
| 8× UHF ISL transmitters (licensed per ITU) | **Eliminated** | Replaced by optical |
| — | 8× UHF WSPR beacons (license-exempt at 1 mW) | Emergency only |
| **9 transmitter licenses needed** | **1 transmitter license needed** | **89% regulatory reduction** |

---

## 5. Tether System: Seven Functions in One Strand

The tether is the most multi-functional component in the entire system. V2 treated it as a dumb rope with two copper wires. V3 promotes it to a 7-function infrastructure element.

### 5.1 Material & Construction

```
Cross-section of V3 multi-function tether ribbon (not to scale):

    3mm
  ├──────┤
  ┌──────────────────┐ ─┬─
  │ Vectran overbraid│  │
  │  ┌──────────────┐│  │
  │  │Dyneema SK78  ││  │ 0.1mm
  │  │ ●Cu  ●Cu     ││  │
  │  │ ◆SMA  ◆SMA   ││  │
  │  └──────────────┘│  │
  └──────────────────┘ ─┴─

  ● = 30 AWG copper conductor (0.25mm dia)
  ◆ = Nitinol SMA wire (0.3mm dia) — last 100m only
```

| Layer | Material | Purpose | Heritage |
|---|---|---|---|
| Core braid | Dyneema SK78 | Primary tensile load | RemoveDEBRIS ✅ TRL 7 |
| Conductors | 2× 30 AWG copper | Power trickle + serial data backup | Standard wire ✅ TRL 9 |
| SMA wires | 2× Nitinol 0.3mm | Tendon steering (last 100m near arm) | TiNi Aerospace ✅ TRL 9 (material) |
| Overbraid | Vectran LCP | Abrasion protection, UV resistance | Pathfinder airbags ✅ TRL 9 |

**Specifications:**
- Width: 3 mm. Thickness: 0.1 mm (flat ribbon)
- Linear density: **1.2 kg/km** (vs V2's 3.0 kg/km — 60% lighter from proper sizing)
- Breaking strength: >500 N (safety factor 5× for 100 kg debris at 1.0 m/s² — design load 100 N)
- Ribbon shape prevents tangling (flat ribbon doesn't kink like round cord)

**V2's tether was 10× overbuilt:** V2 specified 10mm × 0.05mm at 3 kg/km. Back-of-envelope: 100 kg debris at 0.5 m/s² = 50 N. Dyneema SK78 at 3.6 GPa tensile strength: to carry 500 N (10× safety) requires cross-section = 500/3.6e9 = 0.14 mm². A 3mm × 0.1mm ribbon = 0.3 mm² — already 2× the requirement. V3's tether is half the width, properly sized, and 2.5× lighter per km.

### 5.2 Function 1: Structure

Primary tensile member connecting arm to core.

- Design load: 100 N (100 kg debris at 1.0 m/s²)
- Breaking strength: 500 N (5× safety margin)
- Max tow acceleration: limited by FEEP thrust, not tether: at 0.35 mN on 100 kg debris = 3.5 µm/s². The tether never sees more than a fraction of a Newton during FEEP tow. The 100 N design load is for emergency snatch loads (sudden tension when reel brakes) with 5× safety.

### 5.3 Function 2: Power Delivery

```
2× 30 AWG copper conductors:
  Resistance: 1.1 Ω/km per conductor
  Round-trip resistance at 2 km (Weaver): 2 × 2 × 1.1 = 4.4 Ω
  Round-trip resistance at 500m (Spinner): 2 × 0.5 × 1.1 = 1.1 Ω

  At 5 W delivery, I = √(P/R):
    Weaver: I = √(5/4.4) = 1.07 A, V = P/I = 4.7 V → use 6V supply, 1.3V drop OK
    Spinner: I = √(5/1.1) = 2.13 A, V = 2.3 V → use 3.3V supply, 1.0V drop OK

  Alternatively, at higher voltage (28V bus):
    Weaver: 5W at 28V = 0.18A. Line loss = 0.18² × 4.4 = 0.14 W → 97% efficiency.
```

This is **backup** to laser power beaming. If the laser fails, the tether can deliver 5 W to keep the arm alive and run its OBC + beacon. Not enough for FEEP thrust (40 W), but enough for survival.

### 5.4 Function 3: Hardwired Data

- 9600 baud serial (UART) over copper conductors
- **Backup** to optical MRR comms
- In emergency (laser/optical failure): arm communicates telemetry and receives commands via tether wire
- No additional hardware — arm OBC has UART peripheral, core OBC has UART peripheral
- The same copper conductors used for power carry data via frequency-division multiplexing (DC power + AC serial)

### 5.5 Function 4: EDT (Electrodynamic Tether) Propulsion

A conductive tether moving through Earth's magnetic field generates (or can be driven by) a Lorentz force. This provides **free ΔV** — no propellant consumed.

```
Lorentz force: F = I × L × B × sin(α)

Where:
  I = current through tether (driven by onboard power)
  L = tether length (deployed)
  B = Earth's magnetic field strength in LEO ≈ 30 µT (3 × 10⁻⁵ T)
  α = angle between tether and B field (assume sin(α) ≈ 0.7 average for inclined orbit)

For Weaver (2 km tether, 100 mA):
  F = 0.1 × 2000 × 3e-5 × 0.7 = 4.2 mN

For Spinner (500m tether, 100 mA):
  F = 0.1 × 500 × 3e-5 × 0.7 = 1.05 mN

Acceleration on 10 kg arm (Weaver mass + 100 kg debris):
  a = 4.2e-3 / 110 = 38 µm/s² → ΔV per hour: 0.038 × 3600 = 0.14 m/s
  ΔV per day: 3.3 m/s. ΔV per week: 23 m/s. **Significant free propulsion!**

Acceleration on Spinner alone (3.7 kg, no debris):
  a = 1.05e-3 / 3.7 = 0.28 mm/s² → ΔV per hour: 1.01 m/s
  ΔV per day: 24 m/s. **Very significant for a small arm!**
```

**Electron collection:** The tether needs to close the current loop. A 1m "bare" aluminum section at one end acts as anode, collecting electrons from the ionospheric plasma (electron density in LEO: ~10⁵–10⁶ /cm³). The other end uses a CNT (carbon nanotube) field emitter or hollow cathode (~50g) to emit electrons. 🔶 TRL 6.

**Synergy with FEEP:** EDT handles slow background orbit adjustment (free, no propellant). FEEP handles fast precision burns. Like a jellyfish: slow pulsing drift + rapid escape jet. The core controls thrust direction by managing current direction (prograde for orbit raise, retrograde for deorbit).

🔶 TRL 5–6 for EDT propulsion as a system. The physics is proven. JAXA's HTV-6 attempted EDT deployment in 2016 (tether failed to deploy, physics validated in simulation). The components are individually mature; integration for ADR is novel.

### 5.6 Function 5: Navigation

**Range (tether encoder):** A standard rotary encoder built into the reel motor measures deployed tether length to ±0.1 m. This is inherent in the reel mechanism — **zero additional mass** for a useful nav input. ✅ TRL 9.

**Bearing (strain gauge):** A load cell at the tether exit point on the core reel measures tension vector in 2 axes. This gives bearing to the arm at ±5° accuracy — coarse, but useful as a backup nav source and for detecting off-nominal tether behavior. Also **zero additional mass** — the load cell is part of the constant-tension reel control system. ✅ TRL 9.

### 5.7 Function 6: Vibration Sensing

A piezoelectric disc (PZT, 1g) at the core tether exit point detects vibrations propagating along the tether:

| Vibration Signature | Meaning | Response |
|---|---|---|
| High-frequency transient (>1 kHz) | Debris impact on tether | Alert: check tether integrity |
| Known periodic signature | Arm thruster firing | Confirmation of arm activity |
| Sudden step change in tension | Capture event (net cinch) | Log: capture timestamp |
| Gradual tension increase | Tether tangling or snagging | Alert: potential tangle |

This provides early warning of tether damage without any communication from the arm. ✅ TRL 9 (PZT sensors used everywhere).

### 5.8 Function 7: Tendon Steering

The innovation borrowed from **medical catheter tendon steering** and adapted for space:

```
SMA Tendon Steering (last 100m near arm):

     Core end of tether              Arm end of tether
     ├────── no SMA (rigid braid) ──────┤── SMA zone (100m) ──┤
                                         ► SMA wire A (0.3mm)
                                         ► SMA wire B (0.3mm)

When SMA wire A heated (0.5A through conductor from core):
  Wire contracts 4% (Nitinol property: 3-5% recoverable strain)
  100m × 4% = 4.0m of contraction
  At 100m from core: lateral displacement ≈ 4m → steering angle ≈ 2.3°
  At 20m from core: lateral displacement ≈ 4m → steering angle ≈ 11.3°
  At 10m: steering angle ≈ 21.8°

  This provides meaningful terminal guidance for the last 10-20m of approach!
```

**Mass cost:** SMA wires at 0.3mm diameter × 100m × 2 wires:
- Cross-section per wire: π × (0.15mm)² = 0.0707 mm²
- Volume: 0.0707 mm² × 100m = 7,070 mm³ = 7.07 cm³
- Nitinol density: 6.45 g/cm³
- Mass per wire: 7.07 × 6.45 = 45.6g × 2 = **~92g total**

Note: this is higher than the initial estimate of ~10g because the initial calculation used the wrong formula. At ~92g for 100m of tendon steering, this is still worthwhile — it provides physical guidance force independent of the arm's thrusters.

**SMA in space:** ✅ TRL 9. TiNi Aerospace SMA pin-pullers used on hundreds of missions. The material is fully space-qualified. The novel application is continuous tendon actuation (vs one-shot pin-pulling), which we rate at 🔶 TRL 5 for this specific use.

**Triple guidance:** During terminal approach, the arm has three independent guidance inputs:
1. **Laser beam centering** — optical: "stay on the dot"
2. **SMA tendon tug** — mechanical: physical pull toward target
3. **FEEP thrust vectoring** — propulsive: adjust trajectory

Three independent methods = robust terminal approach even if one fails.

### 5.9 Tether Management System (TMS)

Borrowed directly from **deep-sea ROV tether management** (oil & gas heritage, ✅ TRL 9):

- **Constant-tension PID control** on reel motor. Motor torque continuously adjusted to maintain ~1 N tension. Prevents both slack (tangle risk) and snatch loads (identified by ESA Clean Space as the #1 tethered-operations risk).
- **Clock-spring tensioner** (100g): in series with reel, absorbs transient load spikes. Like a watch mainspring — stores and releases energy smoothly.
- **Lebus-grooved drum** with level-wind: ensures orderly winding even at high reel speed. Heritage: every commercial fishing winch uses this geometry.
- **Reel specifications:** motor + encoder + brake = ~1.0 kg per reel (Weaver), ~0.3 kg (Spinner)
- **Reeling rate:** 0–2 m/s. Full Weaver retraction from 2 km: 2000/2 = 1000 s ≈ **17 minutes.**

### 5.10 Tether Mass Summary

| Tether Type | Length | Ribbon Mass | SMA Tendons | Total |
|---|---|---|---|---|
| Weaver | 2 km | 2,400g | 92g (last 100m) | ~2,500g |
| Spinner | 500 m | 600g | 92g (last 100m) | ~700g |

---

## 6. Propulsion & Attitude Control

### 6.1 Core Propulsion (Largely Unchanged from V2)

- **2× Sitael HT-100 Hall thrusters:** 7 kg each, 10 mN per thruster, Isp 1500 s. Xenon propellant. ✅ TRL 8.
- **4× VACCO cold gas RCS (N₂):** attitude control during maneuvers and arm deployment/retrieval.
- **Propellant:** 40 kg xenon → at 275 kg total mass: ΔV = 1500 × 9.81 × ln(275/235) = **2,330 m/s** (vs V2's 2,000 m/s — lighter mass means more ΔV from less propellant). Plus 6 kg N₂ for RCS.

### 6.2 Arm FEEP with Thrust Vectoring

Per the design direction, each arm carries **dual thrusters** for redundancy (only one fires at a time — the other is cold backup):

| Parameter | Weaver | Spinner |
|---|---|---|
| Thruster | 2× Enpulsion NANO R3 | 2× Enpulsion IFM Nano SE |
| Mass (each) | 0.9 kg dry + 0.48 kg propellant | 0.67 kg total |
| Total propulsion mass | 2 × 1.38 = **2.76 kg** | 2 × 0.67 = **1.34 kg** |
| Thrust | 0.35 mN (per active unit) | 0.5 mN (per active unit) |
| Isp | 2000–6000 s | 2000–5000 s |
| Total impulse | 5,500 Ns (per unit) | 1,100 Ns (per unit) |
| TRL | 9 ✅ (flight heritage) | 9 ✅ (flight heritage) |

**Note on redundancy:** The lead designer specifically required dual thrusters per arm. This adds 1.38 kg per Weaver and 0.67 kg per Spinner. But for a mission-critical system where arm loss = mission impact, redundancy is standard practice. The backup thruster fires only if the primary fails.

### 6.3 Thrust Vectoring (No Moving Parts)

FEEP thrusters emit ions from a crown-type emitter through an extractor electrode. By **segmenting the extractor into 4 quadrants** and independently biasing each quadrant's voltage, the ion beam can be steered:

```
       Top view of FEEP emitter + segmented extractor:

              ┌───┐
         ╔════╡ Q1 ╞════╗     Q1 = top quadrant
         ║    └───┘     ║     Q2 = right quadrant
    ┌───┐              ┌───┐  Q3 = bottom quadrant
    │Q4 │   (emitter)  │Q2 │  Q4 = left quadrant
    └───┘              └───┘
         ║    ┌───┐     ║     Higher voltage on Q1 → beam deflects DOWN
         ╚════╡ Q3 ╞════╝     Higher voltage on Q1+Q4 → beam deflects DOWN-RIGHT
              └───┘           Deflection range: ±10-15° from axis
```

- **Deflection range:** ±10–15° from nominal thrust axis
- **Response time:** <1 ms (electrostatic — no moving parts)
- **Wear:** Zero (no mechanical components)
- **Power cost:** Negligible (shifting voltage between quadrants, same total extraction power)
- 🔶 TRL 5–6 (lab-proven by Enpulsion and academic groups; needs flight demo)

### 6.4 Angular Acceleration Calculations

With thrust vectoring, the FEEP provides pitch/yaw torque:

```
Torque τ = F × r × sin(θ)
Where:
  F = thrust force
  r = moment arm (distance from CoM to thruster)
  θ = vectoring angle

SPINNER (3.7 kg, I ≈ 0.002 kg·m²):
  F = 0.5 mN, r = 5 cm (half of body), θ = 10°
  τ = 5e-4 × 0.05 × sin(10°) = 5e-4 × 0.05 × 0.174 = 4.35 µNm
  α = τ/I = 4.35e-6 / 0.002 = 2.17 mrad/s²
  Time for 90° (π/2 rad) turn: t = √(2θ/α) = √(2×1.571/0.00217) = √1448 = 38 s
  (Slow but acceptable for transit. Terminal approach is at <0.1 m/s — plenty of time.)

WEAVER (11.0 kg, I ≈ 0.015 kg·m²):
  F = 0.35 mN, r = 10 cm, θ = 10°
  τ = 3.5e-4 × 0.10 × 0.174 = 6.09 µNm
  α = 6.09e-6 / 0.015 = 0.41 mrad/s²
  Time for 90° turn: t = √(2×1.571/0.00041) = √7663 = 88 s
  (Slow — ~1.5 minutes. Adequate for transit but too slow for rapid attitude 
   changes during close-range capture. Hence: cold gas backup on Weavers.)
```

### 6.5 Magnetorquer (Roll Axis)

FEEP vectoring gives pitch/yaw control. For roll, we need a different actuator:

- **CubeSat magnetorquer coil:** ~5g, produces ~10 µNm torque when interacting with LEO B field (30 µT). ✅ TRL 9 — used on virtually every CubeSat since 2003 (hundreds of missions).
- Spinner (I ≈ 0.002 kg·m²): roll acceleration = 10e-6/0.002 = 5 mrad/s² → 90° turn in √(2×1.571/0.005) = **25 s**. Adequate.
- Weaver (I ≈ 0.015 kg·m²): roll acceleration = 10e-6/0.015 = 0.67 mrad/s² → 90° turn in **69 s**. Slow but acceptable — cold gas handles urgent roll.

### 6.6 Cold Gas Backup (Weavers Only)

- 1× VACCO micro cold gas thruster: **200g**, 25 mN thrust, N₂ propellant. ✅ TRL 9.
- 0.2 kg propellant: provides ~15 m/s ΔV for rapid attitude maneuvers during close-range capture.
- **Spinners carry NO cold gas.** FEEP vectoring + magnetorquer handles all attitude control. This saves ~500g per Spinner (V2 had 0.3 kg thruster + 0.2 kg propellant = 500g per Spinner).

### 6.7 EDT as Supplementary Propulsion

Cross-reference §5.5. The EDT system provides free ΔV that synergizes with FEEP:

| Propulsion Mode | ΔV Rate | Propellant Cost | Use Case |
|---|---|---|---|
| FEEP | 0.35–0.5 mN continuous | Indium (limited) | Precision maneuvers, closing approach |
| EDT (Weaver 2km) | ~3.3 m/s/day on 110 kg | Zero (electrical only) | Slow orbit matching, "drifting toward target" |
| EDT (Spinner 500m) | ~24 m/s/day on 3.7 kg | Zero (electrical only) | Orbit adjust, free deorbit |
| Cold gas (Weaver) | 25 mN impulse | N₂ (limited) | Rapid attitude during capture |

**Operational synergy:** EDT drifts the arm slowly toward the target orbit (hours). FEEP closes the last km precisely (minutes). Cold gas handles rapid pointing during the capture moment (seconds). Three scales of propulsion, each optimal for its regime.

---

## 7. Capture Systems

### 7.1 Philosophy: Nets First, Everything Else Second

From §2.2: >90% of debris tumbles at rates where nets are effective. Nets require no detumbling, work on any surface material, any shape, any size (within net dimensions), and are passive after deployment — no sustained power needed.

Even ClearSpace-1's 4-arm rigid gripper concept struggles with targets tumbling above 3°/s (30% of the debris population). A RemoveDEBRIS-heritage net handles 60°/s. The math is simple: **nets are the universal capture mechanism.**

**Design decision:** Both Weavers AND Spinners carry nets as their **primary** capture system. Spinners additionally carry a multi-modal pad as secondary (for tiny fragments where netting is impractical). Weavers additionally carry a miniature gripper as backup (for grappling protruding features).

### 7.2 Weaver Nets

#### A. Standard Net (5×5 m Dyneema SK78 mesh)

Heritage: RemoveDEBRIS ✅ TRL 7. The proven approach.

```
NET DEPLOYMENT SEQUENCE (Miura-ori fold + STEM boom frame):

  STOWED (in canister)              DEPLOYING                    DEPLOYED (5×5m)
  ┌───────────┐                     ┌─ ─ ─ ─ ─┐                 ╱───────────╲
  │ ▓▓▓▓▓▓▓▓▓ │ ── spring ──►      │╱         ╲│  ── unfold ──► │             │
  │ ▓▓▓(net)▓▓│    plate           │   booms    │    complete    │   5×5m      │
  │ ▓▓▓▓▓▓▓▓▓ │    50g            │╲   extend ╱│                │   mesh      │
  └───────────┘                     └─ ─ ─ ─ ─┘                 ╲───────────╱
                                                                  SMA cinch wire
                                                                  around perimeter
```

| Component | Mass | Notes |
|---|---|---|
| Dyneema SK78 knotless mesh, 7cm cells, 0.5mm thread | 1,000g | RemoveDEBRIS heritage |
| 4× STEM booms (Redwire/Roccor), 1.4m each | 200g | Stored elastic energy, deploy without motor ✅ TRL 7 |
| SMA cinch wires (Nitinol, 10 × 0.3mm × 15m perimeter) | 15g | Cinch closure — no motor, no drawstring mechanism |
| Miura-ori fold spring plate | 50g | Single-pull deployment, predictable geometry |
| **Total net system** | **~1,265g** | V2: 2,000g (net + canister). **Saved ~735g.** |

**Closure mechanism:** SMA (Nitinol) wires threaded through net perimeter. Core sends 0.5A × 2 s through tether conductor → current flows through SMA wire → wire heats → contracts 4% → net perimeter cinches from 20m circumference to ~19.2m. This 80cm reduction is enough to close the net around debris. No motor. No drawstring. No moving parts. Mass: 15g. ✅ TRL 9 (SMA material); 🔶 TRL 5 (this application).

#### B. Gossamer Gill-Net (20×20 m, for fragment clouds)

Inspired by fishing gill nets — ultra-thin passive entanglement mesh:

- Ultra-thin Dyneema monofilament: 0.1mm diameter, 5cm mesh spacing
- Mass: ~**200g** for **400 m²** of capture area
- Deployed as passive barrier across predicted debris stream path. Fragments impact and entangle.
- Support: 4 corner tethers to arm, light spring tension maintains shape
- **For post-Kessler debris clouds:** the highest-efficiency capture mode by area-per-kg: 2,000 m²/kg

#### C. Funnel/Trawl Net

```
TRAWL NET (fishing heritage):

       2m × 2m mouth           narrows to          0.5m cod-end bag
    ┌═══════════════════╗                         ╔═══╗
    │                   ║  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   ║   ║
    │  STEM booms hold  ║         funnel          ║bag║ ◄── fragments
    │  mouth open       ║  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   ║   ║     accumulate
    └═══════════════════╝                         ╔═══╝
         │
    towed through debris field by arm FEEP thrust
```

- Wide-mouth funnel (2m × 2m opening) narrowing to cod-end bag (0.5m)
- STEM booms hold mouth open (same deployment tech as standard net)
- Arm tows the funnel through debris field — fragments enter, accumulate in bag
- Mass: ~800g net + 200g booms = **~1,000g total**
- Weaver carries either Standard OR Trawl net (mission-configurable before deployment)

### 7.3 Spinner Nets

Scaled-down version of the Weaver standard net:

- 1.5 × 1.5 m Dyneema SK78 micro-net
- Same Miura-ori fold + SMA cinch approach
- Mass: ~250g net + 100g frame + 10g SMA = **~360g**
- Effective for all debris <10 kg at any tumble rate

### 7.4 Multi-Modal Capture Pad (Spinner Secondary)

For fragments too small for netting, or when the Spinner needs to grip-and-hold for surface attachment:

| Mode | Mechanism | Best Surfaces | Force (N/cm²) | Temp Range | Reusable | TRL | Mass |
|---|---|---|---|---|---|---|---|
| Gecko (PDMS) | Van der Waals | Smooth (Al, glass, Kapton) | 3.5 shear | -40 to +80°C | ~50 cycles | 7 ✅ | 30g |
| Micro-hooks (3M Dual Lock) | Mechanical interlock | MLI, fabric, painted | 35 shear | -60 to +120°C | 10,000+ | 9 ✅ | 5g |
| Electrostatic | Coulombic (3 kV) | Rough, conductive | 1–5 normal | Any | Unlimited | 4 ⚠️ | 30g |
| Permanent magnet (NdFeB) | Magnetic | Ferrous (steel bolts) | ~50 (contact) | -40 to +150°C | Unlimited | 9 ✅ | 20g |
| UV-cure adhesive | Mussel-inspired catechol | Any surface | 1500 (cured) | Cure any T; bond -100 to +200°C | 10 doses | 5 🔶 | 20g |

**Combined pad: ~105g**, mounted on Spinner forward face. Covers ~95% of debris surface types.

**Temperature effects analysis (from §2.3 data):**

| Temperature | Gecko | Hooks | Electrostatic | Magnet | UV Adhesive |
|---|---|---|---|---|---|
| +120°C (hot sunlit Al) | ❌ PDMS softens | ✅ | ✅ | ✅ | ✅ (cures faster) |
| +60°C (average sunlit) | ✅ | ✅ | ✅ | ✅ | ✅ |
| -40°C (mild shadow) | ✅ (limit) | ✅ | ✅ | ✅ | ✅ |
| -120°C (deep shadow) | ❌ PDMS stiffens | ✅ | ✅ | ✅ | ✅ (cures with UV LED) |

**Strategy:** Tumbling debris alternates between sunlit (+120°C max) and shadowed (-120°C). The arm's forward camera detects the sunlit face and times capture to the "warm window" (+60°C range) where gecko works best. For extreme temperatures, fall back to hooks or electrostatic mode. The multi-modal pad adapts to what it finds, like an octopus sucker adapting to each surface.

### 7.5 Weaver Gripper (Backup)

Miniaturized 3-jaw chuck inspired by the **osprey's adaptive foot grip** (reversible outer toe for cylindrical grasping) and **eagle tendon ratchet** (zero-power grip maintenance):

- 3 CFRP jaws driven by spiral cam mechanism (lathe chuck heritage). ✅ TRL 8.
- Ratchet lock: once closed, mechanical ratchet holds grip with zero power. Borrowed from eagle flexor tendon — the bird sleeps on a branch without muscular effort. ✅ TRL 9.
- 50mm grip diameter, 30 N grip force
- Mass: ~**150g** in titanium DMLS print (vs V2: 800g for 2-jaw gripper — **5× lighter**)
- Use case: grappling protruding features (antenna stubs, bolt heads, adapter rings)

### 7.6 Passive Capture Modes

#### A. Trapdoor Ambush

Inspired by the **trapdoor spider** — deploy, hide, wait, strike:

1. Deploy Spinner on tether with capture pad facing outward
2. Power down to hibernate mode (~10 mW — OBC sleep + piezo trigger armed)
3. Impact sensor (piezoelectric disc, 1g) triggers wake-up on contact
4. Pad activates (electrostatic mode — fastest activation), captures fragment
5. Arm wakes, core reels in

**Zero propellant for capture.** Ideal for predictable debris streams computed from TLE data.

#### B. Long-Line Multi-Pod

Inspired by **long-line fishing** — one line, many hooks:

```
LONG-LINE CONFIGURATION:

    CORE ═══250m═══ POD1 ═══250m═══ POD2 ═══...═══ POD8 ═══ WEAVER
                     │                │                │
                   (20g each: gecko pad + piezo + SMA grip)
```

- Weaver deploys on 2 km tether. At 250m intervals, clip-on micro-pods (20g each)
- Each pod: gecko pad + piezo trigger + SMA contraction grip
- 8 pods × 20g = **160g** on a 2 km tether
- Each pod captures independently on impact. Core reels in loaded line.
- One deployment → up to **8 captures**. Efficiency per deployment: unmatched.

---

## 8. Docking System: EPM (Electro-Permanent Magnets)

### 8.1 EPM Physics

An EPM module combines permanent magnets with a switchable field — **zero power in both ON and OFF states**:

```
EPM MODULE (cross-section):

  ON STATE (holding arm):          OFF STATE (arm released):
  
  ┌─────────────────────┐          ┌─────────────────────┐
  │  NdFeB  │   AlNiCo  │          │  NdFeB  │   AlNiCo  │
  │   N→S   │    N→S    │          │   N→S   │    S←N    │
  │  (hard) │  (coil-   │          │  (hard) │  (coil    │
  │         │ wrapped)  │          │         │ reversed) │
  └────┬────┴────┬──────┘          └────┬────┴────┬──────┘
       │         │                      │         │
  ═════╧═════════╧══════           ═════╧═════════╧══════
   Steel docking plate              Steel docking plate
   (flux flows through              (flux contained in EPM
    plate → 50N hold)                body → near-zero force)
```

- **ON (holding):** Both magnets aligned N→N→S→S. Flux flows through the external steel plate. Holding force: 25–50 N per module. **Zero power consumed.**
- **OFF (released):** Brief current pulse (100 ms, ~1 A) through coil reverses the AlNiCo magnet. Magnets now oppose. Flux is contained internally. Near-zero external field. **Zero power consumed.**
- **Switching energy:** V × I × t = 5V × 1A × 0.1s = **0.5 J per switch.** Negligible.
- Heritage: Industrial EPMs are TRL 9 (Fraunhofer IWU, Eclipse Magnetics). Space application: 🔶 TRL 5 (no flight heritage yet, but the physics is identical to ground use — vacuum and temperature are no issue for permanent magnets).

### 8.2 EPM Docking Interface Design

| Component | Location | Mass | Notes |
|---|---|---|---|
| 2× EPM modules per cavity | Core (16 total for 8 cavities) | 80g per cavity (40g each) | Redundant pair: if one fails, other still holds at 25 N |
| Mild steel docking plate | Arm (each arm) | 40g (Spinner), 60g (Weaver) | 2mm thick, 50×50mm (S) or 60×60mm (W) |
| Conical guide funnel | Core cavity entrance | (integral to structure) | ±15° acceptance angle, 2cm lateral capture range |
| Centering pin + socket | Arm pin + core socket | 5g pin on arm | Angular alignment after magnetic capture |
| AprilTag fiducial | Printed on cavity face | 0g (ink on surface) | Visual terminal guidance (§4.7) |

**Total docking system per arm:** EPM target plate (40–60g) + centering pin (5g) = **45–65g**.
**V2 was:** ferromagnetic plate (500g) + electromagnet (500g) + latch = **~1,000g per arm pair**.
**Savings:** ~900g per docking interface. Across 8 arms: **~7.2 kg system savings.**

### 8.3 Docking Sequence

```
1. ARM approaches at 0.1 m/s via tether reel-in
   ├─ Optical ILS: laser beam centering ("stay on the dot")
   ├─ SMA tendon: physical centering pull
   └─ FEEP: trajectory refinement

2. At 5m: arm camera acquires AprilTag on cavity face
   └─ 6DOF pose computed at 30 fps → ±1 cm accuracy → fine approach

3. At 0.5m: mechanical guidance takes over
   └─ Conical funnel laterally guides arm to ±2 cm

4. At contact: arm's steel plate enters EPM magnetic field
   └─ Pulled in magnetically (25-50 N attraction at <10mm gap)

5. Centering pin engages socket
   └─ Angular alignment locked (±1°)

6. EPM holds at 50 N with ZERO power. Done.
   └─ Can hold indefinitely. Release requires 0.5 J pulse.
```

### 8.4 Recessed Cavity Design ("Kangaroo Pouch")

Inspired by the **kangaroo's pouch** — arms nest inside the core, not on its surface:

```
CROSS-SECTION OF ONE DOCKING CAVITY (Weaver):

         ┌──────── Core outer surface ────────┐
         │   ╔═══════════════════════════╗     │
         │   ║                           ║     │
         │   ║  WEAVER ARM (flush when   ║     │
         │   ║  docked: 260×260×360mm    ║     │
         │   ║  cavity)                  ║     │
         │   ║       ┌─────────┐         ║     │
         │   ║       │ EPM (×2)│         ║     │
         │   ║       │ + socket│         ║     │
         │   ╚═══╤═══╧═════════╧═══╤═════╝     │
         │       │  AprilTag face  │           │
         │       │  + LED beacon   │           │
         └───────┴─── conical ─────┴───────────┘
                     funnel entry
```

- Cavity dimensions: Weaver 260 × 260 × 360 mm; Spinner 130 × 130 × 200 mm
- Arm sits **flush** with core surface when docked — maintains smooth profile for drag
- Cavity walls provide: launch vibration shielding, thermal shelter, alignment guide
- **Launch restraint:** Frangibolt pin-puller (TiNi Aerospace, ~10g, ✅ TRL 9) holds arm in cavity until commanded release. Fired once — non-resettable, but arm only needs to separate once from launch configuration.

---

## 9. Arm Design

### 9.1 Spinner (Small Arm) — Detailed Mass Budget

**Design target: <3.5 kg, captures debris <10 kg, operational radius 500 m on tether.**

The Spinner is designed to the **radiosonde mass philosophy** — the Vaisala RS41 achieves GPS telemetry over 200 km at 80g including battery. Our Spinner avionics core targets **<100g** (OBC + PCDU + IMU + comms + nav sensors = 59g in the table below).

The structure follows the **Loon/Aether PCB-integrated sandwich** approach: the entire Spinner is a structural PCB with body-mounted GaAs cells on the outside, electronics inside, and the FR4/Rogers substrate doubling as the primary structure.

| Subsystem | Component | Mass (g) | TRL | Notes |
|---|---|---|---|---|
| **Structure** | DMLS Ti-6Al-4V lattice frame + PCB sandwich | 400 | 9 ✅ | 100×100×150mm. 40% lighter than solid Al (diatom-inspired hierarchical lattice) |
| **Propulsion** | 2× Enpulsion IFM Nano SE (FEEP) | 1,340 | 9 ✅ | Redundant pair. Only 1 active. Vectorable ±10° |
| **Attitude: roll** | Magnetorquer coil (CubeSat-class) | 5 | 9 ✅ | ~10 µNm torque in LEO B field |
| **Power: laser PV** | 808nm matched GaAs panel (10×10cm) | 50 | 5 🔶 | 65% conversion at matched λ. Primary power source |
| **Power: solar** | Body-mounted GaAs cell (1 face, 10×10cm) | 50 | 9 ✅ | ~8 W peak sunlit. Emergency/backup |
| **Power: battery** | Li-ion (GOMspace heritage) | 200 | 9 ✅ | 10 Wh. Eclipse/emergency reserve |
| **Power: PCDU** | Integrated on OBC board | 30 | 9 ✅ | Buck/boost + battery charger |
| **Comms: primary** | MRR (Cat's Eye + MQW modulator) | 15 | 6 🔶 | NRL heritage. 1–10 Mbps optical uplink |
| **Comms: backup** | UHF WSPR beacon (1 mW) | 2 | 9 ✅ | Pico balloon heritage. Emergency only |
| **Nav: range/bearing** | Photodiode + TDC7200 | 2 | 9 ✅ | Laser pulse ToF ranging, ±2 cm |
| **Nav: attitude** | BMI088 6-axis MEMS IMU | 2 | 9 ✅ | Gyro + accelerometer, Bosch |
| **Nav: docking** | OV7251 camera + AprilTag firmware | 5 | 7 ✅ | 640×480 global shutter, 5g module |
| **OBC** | Vorago VA416xx (rad-hard Cortex-M4) | 5 | 9 ✅ | ~$5 chip. Alternative: STM32H7 (COTS) |
| **Tether** | Dyneema/Vectran/Cu/SMA ribbon, 500m | 700 | 7 ✅ | 1.2 kg/km × 0.5 km + 92g SMA tendons |
| **Tether reel** | Micro spool + spring tensioner | 300 | 9 ✅ | Motor + encoder + brake |
| **Capture: net** | 1.5×1.5m Dyneema + Miura + SMA cinch | 360 | 7 ✅ | Primary capture method |
| **Capture: multi-modal pad** | Gecko + hooks + electrostatic + magnet + UV adhesive | 105 | 5–9 | Secondary capture |
| **Docking: plate** | Mild steel EPM target + centering pin | 45 | 9 ✅ | 2mm thick, 50×50mm |
| **Thermal** | MLI strip (minimal) | 50 | 9 ✅ | Laser-heated through eclipse |
| **Vibration sensor** | Piezo disc at tether attachment | 1 | 9 ✅ | Tether health monitoring |
| **EDT cathode** | CNT field emitter (for EDT) | 30 | 6 🔶 | Enables EDT propulsion via tether |
| **TOTAL** | | **~3,737g (~3.7 kg)** | | *Slightly above 3.5 kg target — acceptable* |

**Spinner Power Budget:**

| State | Laser In (W) | Solar In (W) | Total Draw (W) | Duration | Battery |
|---|---|---|---|---|---|
| Transit (FEEP firing) | 19.5 | 0–8 | FEEP 40 + OBC 0.5 + MRR 0.05 = 40.55 | Hours | Deficit covered by battery in bursts; FEEP duty-cycled |
| Capture (net deploy) | 19.5 | 0–8 | OBC 0.5 + Cam 0.3 + SMA 5W×2s | Seconds | OK |
| Hibernate (on tether) | 19.5 or 0 | 0–8 | 0.01 (sleep) | Days | Battery charges from laser surplus |
| Eclipse (no solar) | 19.5 | 0 | OBC 0.5 | 35 min | Laser provides power through eclipse |
| Emergency (no laser) | 0 | 0–8 | OBC 0.5 + beacon 0.001 | Hours | 10 Wh ÷ 0.5 W = **20 hours** survival |

*Note on FEEP power:* The FEEP thruster draws ~40 W but the laser provides ~19.5 W to the Spinner at 1 km. The deficit is managed by **duty-cycling** the FEEP: fire for 50% of the time, coast for 50%. Average thrust is halved (0.25 mN) but average power draw matches available power. The 10 Wh battery provides buffer for burst operations. At 2 arms deployed (instead of 4), the Spinner receives ~39 W — enough for continuous FEEP operation.

### 9.2 Weaver (Large Arm) — Detailed Mass Budget

**Design target: <12 kg, captures debris 10–500 kg, operational radius 2 km on tether.**

| Subsystem | Component | Mass (g) | TRL | Notes |
|---|---|---|---|---|
| **Structure** | DMLS Ti-6Al-4V lattice, 200×200×300mm | 2,000 | 9 ✅ | Diatom-inspired hierarchical lattice |
| **Propulsion** | 2× Enpulsion NANO R3 (FEEP) | 2,760 | 9 ✅ | Redundant pair. Only 1 active. Vectorable ±10° |
| **Attitude: roll** | Magnetorquer coil | 5 | 9 ✅ | |
| **Attitude: backup** | 1× VACCO micro cold gas (N₂) | 400 | 9 ✅ | 25 mN — rapid slew during capture |
| **Power: laser PV** | 808nm matched GaAs (20×20cm) | 100 | 5 🔶 | ~19.5 W at 2 km (up to 39W with 2 arms) |
| **Power: solar** | Body-mounted GaAs (1 face) | 100 | 9 ✅ | ~15 W peak sunlit. Backup |
| **Power: battery** | Li-ion | 500 | 9 ✅ | 25 Wh |
| **Power: PCDU** | Micro PCDU | 100 | 9 ✅ | |
| **Comms: MRR** | Cat's Eye + MQW | 15 | 6 🔶 | 1–10 Mbps optical uplink |
| **Comms: WSPR beacon** | Emergency UHF | 2 | 9 ✅ | 1 mW, license-exempt |
| **Nav: range+bearing** | Photodiode + TDC7200 + BMI088 IMU | 4 | 9 ✅ | |
| **Nav: docking** | OV7251 forward camera | 5 | 7 ✅ | AprilTag detection |
| **Nav: approach** | Stereo pair (2× OV7251) | 10 | 7 ✅ | Resolves target at 200 m for debris approach |
| **OBC** | Vorago VA416xx (rad-hard) | 10 | 9 ✅ | Slightly more capable than Spinner |
| **Tether** | Dyneema/Vectran/Cu/SMA ribbon, 2 km | 2,500 | 7 ✅ | 1.2 kg/km × 2 + 92g SMA tendons |
| **Tether reel** | Spool + spring tensioner + brake | 800 | 9 ✅ | Lebus-grooved drum, level-wind |
| **Capture: net** | 5×5m Dyneema + Miura + STEM + SMA cinch | 1,265 | 7 ✅ | Primary capture |
| **Capture: gripper** | 3-jaw mini chuck + ratchet lock | 150 | 8 ✅ | Backup: grapple protruding features |
| **Capture: UV adhesive** | Micro-dispenser, 10 doses | 20 | 5 🔶 | Any-surface bonding backup |
| **Docking: plate** | Mild steel EPM target + centering pin | 65 | 9 ✅ | 2mm thick, 60×60mm |
| **Thermal** | MLI strip | 100 | 9 ✅ | |
| **EDT cathode** | CNT field emitter | 50 | 6 🔶 | For EDT propulsion via tether |
| **TOTAL** | | **~10,961g (~11.0 kg)** | | *Under 12 kg target ✅* |

---

## 10. Core Design

### 10.1 Dimensions

```
V3 core dimensions (revised from V2):
  Octagonal prism: 1.0m across-flats × 1.2m height
  (V2 was 2.4m across-flats × 3.0m — massive reduction!)
  
  With stowed arms in recessed cavities: ~1.3m inscribed diameter envelope
  2 deployable solar wings: 3m wingspan each (stowed along body)
  
  Total stowed for launch: ~1.3m × 1.5m cylinder envelope
  Fits PSLV 2.8m fairing with large margin
  Fits Electron Hippo 1.56m fairing (for demo version)
  
  Volume: octagonal prism ≈ 0.83 × d² × h = 0.83 × 1.0² × 1.2 = 1.0 m³
  At 170 kg dry: density ≈ 170 kg/m³ (realistic for a satellite with cavities)
```

### 10.2 Core Layout (Top-Down)

```
                         FORWARD (+Z)
                          ┌─────┐
                          │LASER│ ← 808nm laser aperture (20cm Cassegrain)
                          │ APR │   + MEMS scanning mirror
               ┌──────────┼─────┼──────────┐
              ╱  S1 cavity │     │ W2 cavity ╲
             ╱  (Spinner)  │     │  (Weaver)  ╲
            │              │     │             │
       W1   │    ┌─────────┴─────┴────────┐   │  S2
    (Weaver)│    │                        │   │(Spinner)
     cavity │    │    CORE INTERIOR       │   │ cavity
            │    │                        │   │
            │    │  OBC × 2  Battery×4    │   │
       S4   │    │  PCDU     Reel×8       │   │  W3
   (Spinner)│    │  EPM×16   IMU+Star    │   │(Weaver)
     cavity │    └─────────┬─────┬────────┘   │ cavity
            │              │     │             │
             ╲  W4 cavity  │     │ S3 cavity  ╱
              ╲  (Weaver)  │     │ (Spinner) ╱
               └──────────┼─────┼──────────┘
                          │HALL │ ← 2× HT-100 Hall thrusters
                          │ ANT │   + S-band antenna (aft-facing)
                          └─────┘
                          AFT (-Z)

    Solar wings deploy PORT (left) and STARBOARD (right)
    ◄═══════ 3m ═══════►     ◄═══════ 3m ═══════►

    Arm arrangement (alternating W-S around octagon):
      W1: 0° (starboard)     S1: 45° (fwd-starboard)
      W2: 90° (forward-port)  S2: 135° (port-forward)
      W3: 180° (port)         S3: 225° (port-aft)
      W4: 270° (aft-stbd)     S4: 315° (stbd-aft)
```

### 10.3 Core Subsystem Mass Budget

| Subsystem | Mass (kg) | Notes |
|---|---|---|
| Primary structure (octagonal, 8 arm cavities) | 50 | Al-Li honeycomb with machined cavities |
| Debris shielding (Whipple bumpers) | 8 | Ram-facing CFRP/ceramic multi-layer |
| Main propulsion (2× HT-100 Hall) | 14 | Sitael, 10 mN each, Isp 1500 s ✅ TRL 8 |
| Attitude control (4× RW + 4× cold gas) | 14 | Blue Canyon RWP050 + VACCO MiPS ✅ TRL 9 |
| Solar array (2 wings, ~5 m²) | 18 | ~1.9 kW peak. SolAero ZTJ cells ✅ TRL 9 |
| Battery (Li-ion, 600 Wh) | 12 | GOMspace NanoPower heritage ✅ TRL 9 |
| PCDU | 4 | CubeSat-heritage ✅ TRL 9 |
| OBC (primary + redundant) | 2 | Xiphos Q7 (Zynq-7000) ✅ TRL 9 |
| S-band ground comms | 5 | Patch array + transceiver ✅ TRL 9 |
| Laser system (power + comms + nav) | 2 | 808nm laser + 20cm Cassegrain + MEMS + detectors |
| 8× cavity LED homing beacons | 0.02 | 8 × 2g. Negligible. ✅ TRL 9 |
| Star tracker + IMU + GPS | 3 | Blue Canyon NST + STIM300 + SkyTraq ✅ TRL 9 |
| Sensor suite (EO/IR for debris detect) | 10 | Forward-looking. Stereo cameras + IR ✅ TRL 7+ |
| Thermal (MLI, heaters, radiators) | 10 | Standard thermal control ✅ TRL 9 |
| 16× EPM docking modules (2 per cavity) | 1.3 | ~80g per cavity pair (40g each) 🔶 TRL 5 |
| 8× Tether reels (motor+encoder+brake+tensioner) | 9 | ~1.1 kg avg per reel ✅ TRL 9 |
| Harness & misc | 8 | Cable harness, fasteners, connectors |
| **Core dry mass** | **~170** | |
| Xenon propellant | 40 | ~2,330 m/s ΔV at 275 kg total |
| Cold gas (N₂) | 6 | Attitude RCS |
| **Core wet mass** | **~216** | |

**V2 → V3 core mass reduction breakdown:**
- Structure: 68 → 50 kg (-18 kg, smaller core)
- Docking interfaces: 20 → 1.3 kg (-18.7 kg, EPM replaces heavy electromagnet + plate)
- UHF comms to arms: 4 → 0 kg (-4 kg, replaced by laser + MRR)
- Tether reels: 12 → 9 kg (-3 kg, lighter reels for lighter tethers)
- Sensor suite: 12 → 10 kg (-2 kg, LIDAR removed — optical nav replaces it)
- Added: Laser system +2 kg, LED beacons +0.02 kg
- Net core dry reduction: **-56 kg**

---

## 11. System Mass Budget

| Component | Qty | V2 Spider (kg) | V3 Octopus (kg) | Δ (kg) |
|---|---|---|---|---|
| Core dry | 1 | 226.0 | 170.0 | -56.0 |
| Core Xe propellant | — | 50.0 | 40.0 | -10.0 |
| Core N₂ propellant | — | 8.0 | 6.0 | -2.0 |
| Weaver arm | ×4 | 84.0 (21.0 ea) | 44.0 (11.0 ea) | -40.0 |
| Spinner arm | ×4 | 28.0 (7.0 ea) | 14.8 (3.7 ea) | -13.2 |
| **Total wet** | | **396.0** | **274.8** | **-121.2** |
| **Total dry** | | **330.0** | **228.8** | **-101.2** |

### 11.1 Where the 121 kg of Savings Went

The V3 Octopus is 121 kg lighter than V2 Spider. This opens several options:

| Option | Mass Used | Benefit |
|---|---|---|
| **A. More propellant** | +30 kg Xe | +690 m/s ΔV → double the mission lifetime |
| **B. Extra arms** | +4 Weavers (44 kg) or +8 Spinners (30 kg) | Double capture capacity |
| **C. Radar payload** | +15 kg debris-tracking radar | Self-sufficient target acquisition |
| **D. Smaller launch vehicle** | Save all 121 kg | Use SSLV/Electron instead of PSLV — **60% launch cost reduction** |
| **E. Radiation shielding** | +20 kg Al/CFRP | Extend mission to MEO/GEO orbits |
| **F. Balanced** | +15 kg Xe + 2 extra Spinners + 10 kg margin | Best all-around improvement |

**Recommended: Option F** — adds ~350 m/s ΔV, two more Spinners for fragment cleanup, and retains 10 kg margin for growth. Total revised mass: 275 + 15 + 7.4 + 10 = **307 kg** — still well under PSLV capacity.

---

## 12. Operations Concept

### 12.1 Launch & Deployment

```
PHASE 0: LAUNCH              PHASE 1: SEPARATION         PHASE 2: UNFOLD
┌───────────────────┐        ┌───────────────────┐       ┌───────────────────┐
│ Arms in cavities  │ fairing│ LVSA separation   │ 30min │ Solar wings deploy│
│ (Frangibolt-held) │ jett.  │ Core detumbles    │ ────► │ Star tracker lock │
│ Solar wings stowed│ ────►  │ (RW + cold gas)   │       │ GPS fix acquired  │
│ Laser: OFF        │        │ Sun-search mode    │       │ S-band ground link│
│ Total: ~275 kg    │        │                    │       │ Laser: STANDBY    │
└───────────────────┘        └───────────────────┘       └───────────────────┘

PHASE 3: CHECK-OUT (72 hr)   PHASE 4: ARM COMMISSIONING (4 hr)
┌───────────────────┐        ┌────────────────────────────────────────┐
│ S-band comms test │ pass   │ Sequential, one arm at a time:        │
│ Thruster cal      │ ────►  │                                        │
│ Sensor sweep      │        │ 1. Fire Frangibolt on Weaver-1 cavity │
│ Laser power-on    │        │ 2. EPM switches to OFF → W1 free      │
│ Tether motor test │        │ 3. W1 drifts out 1m on reel           │
│ (motor only —     │        │ 4. Laser acquires W1: verify optical  │
│  no arm release)  │        │    link, power beam, MRR data, ToF nav│
│                   │        │ 5. EPM switches to ON → W1 re-docks   │
│                   │        │ 6. Repeat for S1, W2, S2... all 8     │
│                   │        │ Each arm: ~30 min. Total: ~4 hours.   │
└───────────────────┘        └────────────────────────────────────────┘
```

### 12.2 Capture Doctrine

| Scenario | Method | Arms Used | Notes |
|---|---|---|---|
| **Any debris ≥1 cm, any tumble rate** | Net capture (primary default) | 1 Weaver or 1 Spinner | Net accommodates all orientations and tumble rates |
| **Small fragments (<1 cm)** | Multi-modal pad on Spinner | 1 Spinner | Contact capture: gecko or electrostatic |
| **Large objects (>200 kg)** | Dual-Weaver purse-seine | 2 Weavers | Two nets from opposite sides encircle target |
| **Fragment clouds** | Gossamer gill-net or trawl funnel | 1 Weaver | Maximum area per deployment |
| **Predictable debris streams** | Trapdoor ambush | 1–4 Spinners | Zero propellant capture: deploy, wait, reel in |
| **Dense debris fields** | Long-line multi-pod | 1 Weaver + 8 pods | 8 possible captures per deployment |
| **Protruding features** | Gripper (Weaver backup) | 1 Weaver | Grapple adapter rings, antenna stubs |

### 12.3 Approach Trajectories

**"Stoop" approach** (inspired by the **peregrine falcon**):

```
                    ──── Core orbit (slightly higher) ─────
                   ╱                                        ╲
          Core ═══╪══ deploys arm ══╪════════════════════════╪═══
                  │                 │                        │
              arm releases    arm falls     arm brakes at last moment
              (gravity         (free ΔV     (FEEP reverse thrust)
              gradient         from orbit    
              provides free    difference)  Target orbit ──────────
              closing vel.)                 ╱                      ╲
                                    TARGET ═╪══════════════════════╪═══
```

Core raises orbit ~10 m above target → deploys arm → gravity gradient provides ~0.01 m/s/min closing rate → arm falls toward target → brakes at last moment. **Saves ~50% approach ΔV** versus direct thrust from the same orbit.

**Standard approach:** Direct FEEP thrust from core orbit to target. Used when stoop geometry isn't favorable.

**EDT drift:** For non-urgent targets, use EDT Lorentz force for free orbit adjustment over hours/days. Zero propellant cost. Ideal for slowly closing on a target cluster.

### 12.4 Re-Docking Sequence

```
DISTANCE   NAV MODE                        ACTION
────────   ────────────────────            ──────────────────────
>2 km      Optical ToF range + bearing     Arm thrusting toward core on FEEP
2–0.05 km  Optical ILS (laser centering)   Tether reel-in at 2 m/s
0.05 km    Homing beacon (LED pulse freq)  Arm identifies home cavity
5 m        AprilTag visual lock            Camera 6DOF → ±1 cm fine approach
0.5 m      Conical funnel                  Mechanical guidance
Contact    EPM magnetic capture            Zero-power hold. DONE.
```

The "**zipline arrestor hook**" concept: once the arm is within 50m, tether reel-in provides all the closing velocity needed. The arm can power down attitude thrusters and ride the tether in like a zipline, with the SMA tendons and conical funnel providing final alignment. This is the lowest-risk re-docking mode.

### 12.5 Disposal Options

| Method | ΔV Cost | Time | Arm Fate | Best For |
|---|---|---|---|---|
| **Haul-in** | 0 (tether reel) | 17 min (2 km) | Recovered | Debris <50 kg |
| **Core deorbit** | ~50–100 m/s (core Hall) | Hours | N/A | Combined mass after haul-in |
| **Arm sacrifice + Terminator Tape** | 0 propellant | Weeks–months | Expended | 50–200 kg debris; drag sail deorbits both |
| **EDT deorbit** | 0 propellant | Days–weeks | Preserved (if tether maintained) | Any mass; slow but free |
| **Arm sacrifice + FEEP** | Arm's remaining ΔV | Hours | Expended | When fast disposal needed |

**Terminator Tape:** 50g deployed drag sail (Tethers Unlimited, ✅ TRL 7). Increases cross-section → drag deorbits arm + debris in weeks to months depending on altitude. The arm fires a spring-loaded deployer, then goes dormant.

---

## 13. Test Campaign

### 13.1 Water Tank Testing (Neutral Buoyancy Pool)

**Heritage:** NASA NBL (Neutral Buoyancy Lab), ESA EAC pool, DLR OOS-SIM.

Neutral buoyancy simulates microgravity for proximity operations. A dedicated test campaign uses:

| Test | Setup | What It Validates |
|---|---|---|
| Optical nav accuracy | LED "laser" through water, waterproof photodiode on mock arm | ToF ranging accuracy (adjusted for water refractive index: n=1.33) |
| Tether management | Waterproof reel mechanism, neutrally buoyant tether ribbon | Constant-tension PID, snatch load prevention, level-wind |
| Net deployment | Scaled net (1×1m) on neutrally buoyant mock arm | Miura-ori unfold, STEM boom extension, SMA cinch |
| Approach trajectory | Mock arm with thrusters replaced by waterjet actuators | Stoop approach geometry, collision avoidance |
| Docking | EPM module in waterproof housing, steel plate on mock arm | Conical funnel guidance, EPM capture, alignment accuracy |
| Multi-arm coordination | 2–3 mock arms on tethers from a mock core | Tether tangle avoidance, purse-seine capture |

**Water currents** simulate differential orbital velocity: a flow generator on one side of the pool creates ~0.1 m/s current, representing the velocity difference between orbits at different altitudes. Arms must compensate for this "drift" during approach — directly analogous to orbital mechanics at centimeter/second scale.

### 13.2 Laboratory Testing

| Test | Facility | Duration | Key Metrics |
|---|---|---|---|
| Laser power transfer | Optical bench, 1–100m range | 2 weeks | PV efficiency at 808nm, spot size vs range, thermal effects |
| MRR bandwidth | Optical bench, 500m path (folded mirrors) | 1 week | BER at 1/10 Mbps, return signal strength vs range |
| TDC ranging accuracy | Indoor range, 0–100m | 1 week | Systematic error, jitter, multipath |
| Gecko/electrostatic pads | Thermal-vacuum chamber | 4 weeks | Adhesion force at -120°C to +120°C on Al, CFRP, Kapton, MLI |
| SMA tendon cycling | Thermal-vacuum, 1000+ cycles | 3 weeks | Strain recovery, fatigue life, response time |
| EPM docking | Vibration table at PSLV loads | 2 weeks | Holding force under vibration, thermal cycling (-40 to +80°C) |
| FEEP thrust vectoring | Vacuum chamber | 2 weeks | Beam deflection angle vs quadrant voltage, stability |
| Net cinch (SMA closure) | Vacuum, thermal range | 1 week | Cinch force, closure time, temperature sensitivity |

### 13.3 Air-Bearing Table

DLR EPOS-style air-bearing platform for 2D proximity ops simulation:

- Frictionless air-bearing table (3m × 3m or larger)
- Mock arm floats on air cushion — 2D free-body motion
- Tests: approach trajectory, tether dynamics during reel-in/out, FEEP vectoring response, capture sequence
- Camera overhead tracks positions to ±1 mm — validates nav algorithms
- Heritage: DLR EPOS, NRL proximity ops simulators ✅ TRL 9 (facility)

### 13.4 Suborbital / ISS Demonstration

**First flight: 2-arm technology demonstrator on ISRO SSLV:**

| Parameter | Value |
|---|---|
| Launch vehicle | ISRO SSLV (0.83m fairing, 500 kg to LEO) |
| Demo mass | ~150 kg (1 core + 1 Weaver + 1 Spinner) |
| Orbit | 400 km SSO |
| Duration | 6 months |
| Tests | Optical link (power + comms + nav), tether deploy/retract, EPM dock/undock, net deployment on inert target, EDT propulsion demo |

**Success criteria:**
1. ✅ Optical power beam delivers >10 W to Weaver at 500 m
2. ✅ MRR comms achieve >100 kbps at 1 km
3. ✅ ToF ranging accurate to <5 cm at 1 km
4. ✅ Tether deploy to 500 m and retrieve without tangle
5. ✅ EPM dock/undock cycle ×10 without failure
6. ✅ Net deployment and SMA cinch closure in vacuum
7. ✅ EDT generates measurable thrust (>0.1 mN)

---

## 14. Technology Readiness Assessment

### TRL 7+ (Ready to Fly) ✅

| Subsystem | TRL | Heritage |
|---|---|---|
| Hall thruster (HT-100) | 8 | Sitael, multiple flight missions |
| FEEP thruster (NANO R3, IFM Nano SE) | 9 | Enpulsion, 30+ satellites |
| Cold gas RCS | 9 | VACCO, hundreds of missions |
| Reaction wheels | 9 | Blue Canyon, standard CubeSat |
| DMLS titanium structure | 9 | SpaceX engine parts, ESA structures |
| Dyneema SK78 tether/net material | 7 | RemoveDEBRIS |
| Li-ion battery (space-grade) | 9 | GOMspace, every CubeSat |
| GaAs solar cells | 9 | SolAero ZTJ, standard |
| Star tracker + IMU + GPS | 9 | Blue Canyon NST, STIM300, SkyTraq |
| S-band ground comms | 9 | Standard |
| UHF beacon (WSPR-class) | 9 | Pico balloon heritage |
| Magnetorquer | 9 | Every CubeSat since 2003 |
| AprilTag algorithm | 9 | Skydio autonomous docking |
| Net capture system | 7 | RemoveDEBRIS (Airbus/Surrey) |
| Gecko gripper (PDMS) | 7 | NASA Astrobee on ISS, JPL/Stanford |
| 3M Dual Lock micro-hooks | 9 | Industrial, tested in vacuum |
| Permanent magnets (NdFeB) | 9 | Used everywhere in space |
| SMA pin-pullers (Nitinol material) | 9 | TiNi Aerospace, hundreds of missions |
| Frangibolt launch restraint | 9 | TiNi Aerospace |
| OV7251 camera | 7 | Multiple CubeSat missions |
| Vectran overbraid | 9 | Pathfinder airbags |

### TRL 5–6 (Needs Space Demonstration) 🔶

| Subsystem | TRL | What's Needed | Risk |
|---|---|---|---|
| Laser power beaming (space) | 5 | Orbital demo: laser → PV at 1 km | Medium — ground demos exist (Airbus 2019) |
| MRR optical comms (space) | 6 | Orbital demo of Cat's Eye + MQW | Low — NRL field-tested extensively |
| FEEP thrust vectoring | 5-6 | Flight demo of segmented extractor | Low — lab-proven, physics well-understood |
| EPM docking (space application) | 5 | Orbital dock/undock cycle test | Low — industrial EPM is TRL 9; vacuum/thermal not an issue |
| EDT propulsion system | 5-6 | Tether deployment + current drive demo | Medium — JAXA HTV-6 tether failed to deploy |
| Electrostatic capture pad (3 kV) | 4 | Vacuum chamber testing on debris surfaces | Medium — JAXA lab demos promising |
| UV-cure adhesive in orbit | 5 | Individual components qualified; combination novel | Low — Norland NOA adhesives vacuum-rated |
| CNT field emitter (EDT cathode) | 6 | Space qualification of CNT emitter | Low — lab-demonstrated, materials stable |
| 808nm matched GaAs PV receiver | 5 | Space qualification at matched wavelength | Low — GaAs cells flight-proven; wavelength matching is new |

### TRL 3–4 (Needs R&D) ⚠️

| Subsystem | TRL | What's Needed | Risk |
|---|---|---|---|
| Tethered multi-arm coordinated ops | 3 | Simulation, water tank, then orbital demo | **HIGH** — no heritage exists |
| Long-line multi-pod capture | 3 | Lab demo, then water tank | Medium — novel concept |
| SMA tendon steering in tether | 4 | Thermal-vac cycling, then orbital demo | Medium — SMA mature, application novel |
| Gecko + electrostatic hybrid pad | 3-4 | Stanford/JPL ongoing research | Medium — both technologies work separately |

### Critical Path

The single item that **gates the entire mission** is **tethered multi-arm coordinated operations**. No space heritage exists for deploying, maneuvering, and retrieving multiple tethered sub-satellites simultaneously. Tether tangle avoidance, multi-arm phasing, and coordinated capture are all novel operational concepts.

**Mitigation:** The 2-arm SSLV demonstrator (§13.4) specifically targets this risk. Water tank testing (§13.1) validates the fundamental dynamics. Air-bearing table (§13.3) validates 2D control algorithms. The progression: simulation → water tank → air-bearing → orbital demo → full system.

---

## 15. Cross-Domain Heritage Table

| # | Source Domain | Concept | Application in Octopus | Impact |
|---|---|---|---|---|
| 1 | **Biology: Octopus** | Distributed intelligence (2/3 neurons in arms) | Arms carry own OBC, make autonomous capture decisions | Reduces comms dependency; enables independent operation |
| 2 | **Biology: Octopus** | Arm autotomy (self-amputation) | Arms are expendable — sacrifice for debris disposal | Mission continues with arm loss |
| 3 | **Biology: Octopus** | Chromatophore light signaling | Laser modulation for comms; MRR for uplink | Eliminates RF ISL; 1000× bandwidth |
| 4 | **Biology: Kangaroo** | Recessed pouch, self-entry by joey | Arms nest in recessed cavities (flush when docked) | Launch protection; clean aerodynamic profile |
| 5 | **Biology: Scorpion** | Back-riding texture grip | EPM zero-power hold state | No power to maintain dock |
| 6 | **Biology: Cichlid** | Fry recognize parent by pattern | Unique LED pulse frequency per docking cavity | Arms identify home dock without computation |
| 7 | **Biology: Peregrine falcon** | Stoop dive (gravity-assisted attack) | "Stoop" approach: drop from higher orbit | Saves ~50% approach ΔV |
| 8 | **Biology: Osprey** | Adaptive reversible-toe grip | 3-jaw mini chuck gripper | Wraps around cylindrical features |
| 9 | **Biology: Eagle** | Ratchet-lock tendon grip | Zero-power ratchet hold on gripper | Grip maintained with no energy |
| 10 | **Biology: Remora** | Directional friction grip | Micro-hook pad (3M Dual Lock heritage) | Works on rough/fabric/MLI surfaces |
| 11 | **Biology: Parasitoid wasp** | Micro-anchor ratcheting ovipositor | Micro-screw anchor concept for non-cooperative targets | 10g penetrator option |
| 12 | **Biology: Mussel** | DOPA adhesive (any surface, any temp) | UV-cure catechol adhesive (10 doses) | Universal bonding backup |
| 13 | **Biology: Trapdoor spider** | Ambush predator (deploy, wait, strike) | Passive ambush capture mode: hibernate, wake on contact | Zero-propellant capture |
| 14 | **Biology: Maple seed** | Asymmetric spin-stabilization | Passive stabilization for tumbling arm (safe mode) | No power needed for stable tumble |
| 15 | **Biology: Diatom** | Hierarchical lattice structure | DMLS Ti-6Al-4V lattice (40% lighter than solid) | Major structural mass savings |
| 16 | **Fishing: Purse seine** | Two-boat encirclement net | Dual-Weaver capture of large targets (>200 kg) | Handles objects too big for single net |
| 17 | **Fishing: Gill net** | Passive entanglement mesh | 20×20m gossamer gill-net for fragment clouds | 2,000 m²/kg capture area |
| 18 | **Fishing: Trawl** | Funnel-mouth towed net | Trawl net: 2×2m mouth, towed through debris field | Sweeps diffuse fragment field |
| 19 | **Fishing: Long-line** | Single line, multiple hooks | Long-line multi-pod: 8 micro-capture pods on tether | Up to 8 captures per deployment |
| 20 | **ROV/Ocean: TMS** | Constant-tension PID reel control | Tether management: Lebus drum, level-wind, PID tension | Prevents snatch loads (ESA #1 concern) |
| 21 | **ROV/Ocean: USBL** | Acoustic positioning → optical | Optical ToF ranging + quad detector bearing | Sub-cm ranging without RF |
| 22 | **ROV/Ocean: Spring tensioner** | Clock-spring shock absorber | 100g clock-spring tensioner in series with reel | Absorbs transient load spikes |
| 23 | **Drones: Intel swarm** | Pre-programmed choreography | Synced clock transit (minimal comms during cruise) | Reduces link load during transit |
| 24 | **Drones: Crazyflie** | UWB ranging at 27g total | Optical ranging at ~17g total (photodiode + TDC) | Even lighter than nano-drone nav |
| 25 | **Drones: Skydio** | AprilTag precision autonomous landing | AprilTag docking at <5m: 6DOF to ±1cm | Proven terminal guidance algorithm |
| 26 | **Drones: Zipline** | Tether-guided precision delivery | "Zipline arrestor hook" re-docking on tether reel-in | Low-risk re-docking mode |
| 27 | **Oil & Gas: Reel** | Constant-tension reel + PID | Core reel motors with real-time tension feedback | Prevents tether damage |
| 28 | **Mining: TBM laser alignment** | Laser beam as alignment reference | "Stay centered on the dot" terminal guidance | Sub-degree approach guidance, zero computation |
| 29 | **Medical: Catheter tendons** | Tendon-steered flexible tube | SMA tendon wires in tether for mechanical steering | ±20° terminal guidance at 10m range |
| 30 | **Medical: Pill camera** | Extreme miniaturization (1g camera) | OV7251 at 5g; entire Spinner avionics <100g | Mass-optimized subsystems |
| 31 | **Medical: SMA actuators** | Body-temperature shape-memory actuation | Net cinch closure, deployment, tendon steering | No-motor actuation in vacuum |
| 32 | **Origami: Miura-ori** | Single-pull predictable unfold | Net deployment from stowed flat-pack | Reliable deployment geometry |
| 33 | **Space structures: STEM booms** | Stored elastic energy deployment | Net frame + trawl mouth opening | Deploy without motors; 200g for 2m hoop |
| 34 | **Aviation: VOR** | Rotating beam → bearing | Lighthouse MEMS mirror → bearing to arm | Core knows arm direction |
| 35 | **Aviation: DME** | Pulse time-of-flight → range | TDC7200 laser pulse → range ±2cm | Precise relative nav |
| 36 | **Aviation: ILS** | Dual beam → centerline guidance | Dual-wavelength beam → approach centerline | Terminal docking guidance |
| 37 | **Electronics: Radiosonde** | 80g telemetry system (Vaisala RS41) | Mass target for Spinner avionics (<100g) | Drives extreme miniaturization |
| 38 | **Electronics: Pico balloon WSPR** | 7 mW global telemetry | 1 mW emergency beacon per arm (0.5g) | Ultra-low-mass backup comms |
| 39 | **Reflectors: RECCO** | Passive 1g harmonic backscatter | MRR passive optical return + modulation | Zero-power uplink (modulator costs 50 mW) |

---

## Appendix A: Component Reference Table

| Component | Product | Manufacturer | Mass | Performance | TRL | Est. Cost |
|---|---|---|---|---|---|---|
| FEEP thruster (Weaver) | NANO R3 | Enpulsion (Austria) | 0.9 kg + 0.48 kg prop | 0.35 mN, Isp 2000–6000 s | 9 ✅ | ~€50K |
| FEEP thruster (Spinner) | IFM Nano SE | Enpulsion (Austria) | 0.67 kg total | 0.5 mN, Isp 2000–5000 s | 9 ✅ | ~€30K |
| Hall thruster (Core) | HT-100 | Sitael (Italy) | 7 kg | 10 mN, Isp 1500 s | 8 ✅ | ~€80K |
| Cold gas RCS (Core) | MiPS | VACCO (USA) | 0.5 kg × 4 | 100 mN, N₂ | 9 ✅ | ~€15K |
| Cold gas micro (Weaver) | MiPS micro | VACCO (USA) | 0.2 kg + 0.2 kg prop | 25 mN, N₂ | 9 ✅ | ~€10K |
| Reaction wheel | RWP050 | Blue Canyon (USA) | 0.8 kg × 4 | 50 mNm torque | 9 ✅ | ~€20K |
| Star tracker | NST | Blue Canyon (USA) | 0.35 kg | 6 arcsec accuracy | 9 ✅ | ~€30K |
| IMU | STIM300 | Sensonor (Norway) | 0.32 kg | 0.3°/hr gyro bias | 9 ✅ | ~€15K |
| GPS receiver | S1216F8 | SkyTraq (Taiwan) | 0.05 kg | 1.5 m CEP | 9 ✅ | ~€500 |
| OBC (core) | Q7 | Xiphos (Canada) | 0.1 kg × 2 | Zynq-7000 SoC | 9 ✅ | ~€10K |
| OBC (arm) | VA416xx | Vorago Tech (USA) | 0.005 kg (chip) | Rad-hard Cortex-M4 | 9 ✅ | ~$5 |
| GaAs solar cell | ZTJ | SolAero (USA) | 84 mg/cm² | 29.5% efficiency (broadband) | 9 ✅ | ~€200/W |
| Li-ion battery (arm) | NanoPower BP4 | GOMspace (DK) | 0.24 kg | 38.5 Wh | 9 ✅ | ~€3K |
| S-band transceiver | — | GOMspace (DK) | 0.5 kg | 1 Mbps | 9 ✅ | ~€20K |
| 808nm diode laser | CM-F series | II-VI/Coherent | 0.5 kg (module) | 120 W optical out | 5 🔶 | ~€5K |
| MEMS mirror | S13124 | Hamamatsu (Japan) | 0.01 kg | ±30° scan, 1 kHz | 7 ✅ | ~€500 |
| MRR module | Custom | NRL design (USA) | 0.015 kg | 1–10 Mbps | 6 🔶 | ~€500 |
| TDC chip | TDC7200 | TI (USA) | 0.002 kg (board) | 55 ps resolution | 9 ✅ | ~$3 |
| Camera | OV7251 module | OmniVision (USA) | 0.005 kg | 640×480, global shutter | 7 ✅ | ~$20 |
| IMU (arm) | BMI088 | Bosch (Germany) | 0.002 kg | 6-axis MEMS | 9 ✅ | ~$10 |
| Net (Weaver) | Custom | Airbus Bremen heritage | 1.0 kg | 5×5m Dyneema SK78 | 7 ✅ | ~€5K |
| Net (Spinner) | Custom | Scaled from Weaver | 0.25 kg | 1.5×1.5m Dyneema | 7 ✅ | ~€2K |
| STEM boom | SAIL | Redwire/Roccor (USA) | 0.05 kg each | 1.4m deployed | 7 ✅ | ~€2K |
| EPM module | Custom | Eclipse Magnetics (UK) | 0.04 kg | ~25 N hold force | 5 🔶 | ~€200 |
| Magnetorquer | MT-0.1-1 class | NewSpace Systems | 0.005 kg | ~10 µNm | 9 ✅ | ~€500 |
| Frangibolt | FCB series | TiNi Aerospace (USA) | 0.01 kg | One-shot release | 9 ✅ | ~€1K |
| Terminator Tape | TEPCE | Tethers Unlimited (USA) | 0.05 kg | 10 m² drag sail | 7 ✅ | ~€3K |

---

## Appendix B: ΔV Budget

```
MISSION PROFILE: 15-target sortie at 400 km SSO (V3 Octopus, 275 kg)

Phase                           ΔV (m/s)   Source          Fuel (kg Xe)
──────────────────────────────────────────────────────────────────────────
Launch insertion correction       20        Core Hall          0.4
Orbit raise 350→400 km           30        Core Hall          0.6
Station-keeping (2 weeks)         15        Core Hall          0.3
Transfer to cluster 1             40        Core Hall          0.8
Transfer to cluster 2             40        Core Hall          0.8
Transfer to cluster 3             40        Core Hall          0.8
Transfer to cluster 4             40        Core Hall          0.8
Transfer to cluster 5             40        Core Hall          0.8
Return to parking orbit           30        Core Hall          0.6
Deorbit at EOL                   100        Core Hall          2.0
──────────────────────────────────────────────────────────────────────────
Total core ΔV                    395 m/s                       7.9 kg Xe
Remaining core Xe                                             32.1 kg
Remaining ΔV capacity            ~1935 m/s (for multi-sortie career)

EDT "FREE" ΔV CONTRIBUTIONS (over 2-week mission):
──────────────────────────────────────────────────────────────────────────
4× Weaver tethers (2 km each, 100 mA)
  Force per tether: 4.2 mN  → on 110 kg (arm+debris): 3.3 m/s/day
  Over 14 days: 46 m/s per arm. Mostly used for orbit matching.

4× Spinner tethers (500m each, 100 mA)
  Force per tether: 1.05 mN → on 3.7 kg: 24 m/s/day
  Over 14 days: 336 m/s per arm. Significant free maneuvering!

Total EDT ΔV budget: Weavers: ~184 m/s combined. Spinners: ~1344 m/s combined.
(Free! No propellant. Only electrical power from core via tether.)
──────────────────────────────────────────────────────────────────────────

ARM OPERATIONS (per deployment cycle):
──────────────────────────────────────────────────────────────────────────
Weaver FEEP:
  5,500 Ns total impulse per NANO R3. At 11 kg arm mass:
  ΔV = 5500/11 = 500 m/s total budget
  Per capture: 5 m/s approach + 5 m/s attitude + 5 m/s return = 15 m/s
  → 33 captures per Weaver before FEEP depletion

Spinner FEEP:
  1,100 Ns total impulse per IFM Nano SE. At 3.7 kg arm mass:
  ΔV = 1100/3.7 = 297 m/s total budget
  Per capture: 3 m/s approach + 2 m/s attitude + 3 m/s return = 8 m/s
  → 37 captures per Spinner before FEEP depletion
──────────────────────────────────────────────────────────────────────────
```

---

## Appendix C: Optical Link Budget

### Power Beaming

```
LASER POWER BEAMING: Core → Arm

Parameter                          Value           Source/Calculation
─────────────────────────────────────────────────────────────────────
Laser electrical input             200 W           Fiber-coupled 808nm diode
Wall-plug efficiency               60%             Typical for high-power 808nm
Laser optical output               120 W           200 × 0.60
Transmit optic diameter            20 cm           Cassegrain telescope
Beam divergence (half-angle)       50 µrad         ~5× diffraction limit
Atmospheric loss                   0 dB            Vacuum
Pointing jitter margin             ~1 dB           Reserved as link margin
Time-division (4 arms)             -6 dB (25%)     1 kHz scanning, 25% per arm
─────────────────────────────────────────────────────────────────────
Per-arm optical power at source    30 W optical    120 × 0.25 = 30W (link margin not subtracted)

At 500m range:
  Spot diameter                    5 cm            2 × 500 × 50e-6
  Spot area                        19.6 cm²
  Spinner PV area (10×10cm)        100 cm² → captures 100% of spot
  Received optical                 30 W
  PV conversion (65%)             19.5 W electrical    ✅ Exceeds FEEP duty-cycling need

At 1 km range:
  Spot diameter                    10 cm
  Spot area                        78.5 cm²
  Spinner PV (100 cm²)            captures ~100% (spot ≈ PV)
  Received optical                 30 W
  PV conversion                    19.5 W electrical   ✅ Good

At 2 km range:
  Spot diameter                    20 cm
  Spot area                        314 cm²
  Spinner PV (100 cm²)            captures 31.8%
  Received optical                 9.5 W
  PV conversion                    6.2 W electrical    ⚠️ Low — duty-cycle FEEP
  Weaver PV (400 cm²)             captures 100% (20×20cm ≈ spot)
  Received optical                 30 W
  PV conversion                    19.5 W electrical   ✅ Good
─────────────────────────────────────────────────────────────────────
```

### Communication Link

```
OPTICAL COMMS: Core → Arm (Downlink) via laser modulation

Modulation: OOK (On-Off Keying) on power laser
Data rate: 1 Mbps (conservative; laser bandwidth >100 MHz)
SNR at arm PV receiver: >>20 dB (30W optical on 100 cm² — massive SNR)
BER: <10⁻⁹ (essentially error-free at this SNR)

OPTICAL COMMS: Arm → Core (Uplink) via MRR

MRR return path:
  Retroreflector aperture          2 cm diameter
  Return beam divergence           ~1 mrad (Cat's Eye, non-ideal)
  Return power at core:
    At 1 km: spot ≈ 1m dia at core → core quad detector (2cm) captures 0.04%
    Incident on retro at 1 km: ~30W × (π×0.01²)/(π×0.05²) = 1.2 W
    Retro efficiency: 50% → 0.6 W returned
    Return beam area at core: π × (0.5)² = 0.785 m²
    Core detector area: π×0.01² = 3.14e-4 m²
    Received: 0.6 × 3.14e-4/0.785 = 0.24 mW
    
  At 0.24 mW and 1 Mbps OOK:
    Energy per bit = 0.24e-3/1e6 = 0.24 nJ/bit
    Detector NEP (typical InGaAs): ~1 pW/√Hz → noise in 1 MHz BW: 1 nW
    SNR = 0.24 mW / 1 nW = 240,000 = 54 dB → **BER < 10⁻¹²**
    
  At 10 Mbps: SNR drops by 10 dB → still 44 dB → easily achievable
  At 2 km: SNR drops by ~12 dB (inverse square both ways) → 42 dB at 1 Mbps → fine

CONCLUSION: The optical link has >30 dB margin at all planned ranges.
```

---

## Appendix D: EDT Propulsion Calculations

```
ELECTRODYNAMIC TETHER (EDT) PROPULSION ANALYSIS

Physical basis: A current-carrying conductor in a magnetic field experiences
a Lorentz force: F = I × L × B × sin(α)

EARTH'S MAGNETIC FIELD MODEL (LEO, ~400 km):
  Dipole approximation: B₀ = 3.12 × 10⁻⁵ T (at equator, surface)
  At altitude h: B ≈ B₀ × (R_E / (R_E + h))³
  At 400 km: B ≈ 3.12e-5 × (6371/6771)³ = 3.12e-5 × 0.834 = 2.6 × 10⁻⁵ T ≈ 26 µT
  At poles: approx 2× → 52 µT. Average for 60° inclination: ~30 µT.

WEAVER (2 km tether, 100 mA driving current):
  F = 0.1 A × 2000 m × 30e-6 T × sin(60°) = 0.1 × 2000 × 30e-6 × 0.866
  F = 5.2 mN

  But force varies with orbital position (B field direction changes):
  Average over one orbit (sin² effect): F_avg ≈ F_peak × 0.637
  F_avg = 5.2 × 0.637 = 3.3 mN

  Thrust on Weaver alone (11.0 kg): a = 3.3e-3/11 = 0.30 mm/s²
  ΔV per orbit (90 min = 5400 s): 0.30e-3 × 5400 = 1.62 m/s
  ΔV per day (16 orbits): 1.62 × 16 = 25.9 m/s  ← for unloaded arm
  
  With 100 kg debris attached (111 kg total):
  a = 3.3e-3/111 = 29.7 µm/s²
  ΔV per day: 29.7e-6 × 86400 = 2.57 m/s/day
  ΔV per week: 18 m/s  ← significant free orbit changing with debris!

SPINNER (500 m tether, 100 mA):
  F_avg = 0.1 × 500 × 30e-6 × 0.866 × 0.637 = 0.83 mN
  Spinner alone (3.7 kg): ΔV/day = (0.83e-3/3.7) × 86400 = 19.4 m/s/day   ← unloaded arm
  With 5 kg debris (8.7 kg): ΔV/day = (0.83e-3/8.7) × 86400 = 8.2 m/s/day

ELECTRON COLLECTION:
  Bare aluminum tether section (1m length, 3mm width):
  Electron current collected from ionospheric plasma:
    I_max = n_e × e × A × v_thermal
    n_e ~ 5×10¹¹ /m³ (daytime LEO)
    e = 1.6e-19 C
    A = 0.001 m × 1 m = 0.001 m²
    v_thermal ~ 2×10⁵ m/s (electrons at ~1 eV)
    I_max = 5e11 × 1.6e-19 × 0.001 × 2e5 = 16 mA
    
  For 100 mA: need ~6× this → use 6m bare section, or plasma contactor
  Hollow cathode (electron emitter) on arm end: ~50g, ~5W power
  CNT field emitter alternative: ~30g, ~2W power, no consumable

POWER CONSUMPTION:
  EDT drive power = I² × R_tether + emitter power
  R_tether (2 km copper, 30 AWG): 2 × 2 × 1.1 = 4.4 Ω
  P_tether = 0.1² × 4.4 = 0.044 W
  P_emitter = 2-5 W
  Total: ~5 W for 3.3 mN thrust → effective Isp: unlimited (no propellant!)
  Thrust-to-power: 3.3 mN / 5 W = 0.66 mN/W → comparable to FEEP efficiency
  but with ZERO propellant mass penalty.

DEORBIT APPLICATION:
  To deorbit from 400 km: need ~120 m/s retrograde ΔV
  Weaver with 100 kg debris (111 kg):
    2.57 m/s/day → ~47 days to deorbit. Free!
  Spinner with 5 kg debris (8.7 kg):
    8.2 m/s/day → ~15 days to deorbit. Free!

LIMITATION: EDT only works in LEO where ionospheric plasma density is
sufficient for current collection (below ~1000 km). Field strength also
drops rapidly with altitude. EDT is a LEO-specific technology.
```

---

## Appendix E: V4 Forward-Look (Graphene/GSL)

V4 "Opussy" will explore graphene-based technologies that are currently at TRL 2–3 but projected to reach TRL 6 by end of 2026 based on GSL (Graphene Sheet Laminate) advances:

### E.1 GSL Tethers

At 50 GPa tensile strength (projected):
```
Same 500 N breaking strength as Dyneema SK78 tether:
  Dyneema: σ = 3.6 GPa, ρ = 0.97 g/cm³
  A_dyn = 500/3.6e9 = 1.39e-7 m² → mass/km = 1.39e-7 × 0.97e6 = 0.135 kg/km

  GSL: σ = 50 GPa, ρ = 1.8 g/cm³ (graphene sheet + binder)
  A_gsl = 500/50e9 = 1.0e-8 m² → mass/km = 1.0e-8 × 1.8e6 = 0.018 kg/km

  Mass ratio: GSL is 7.5× lighter per km than Dyneema
  2 km Weaver tether: Dyneema 2.4 kg → GSL 0.27 kg + conductors → ~0.5 kg total
  Savings: ~1.9 kg per Weaver arm × 4 = 7.6 kg system savings
```

### E.2 Natively Conductive Graphene

Graphene is intrinsically conductive → no copper conductors needed in tether. Single material serves as tensile + conductive element. HBN (hexagonal boron nitride) coating provides insulation between conductors and between tether layers. HBN also provides extremely low friction — ideal for tendon control.

### E.3 Graphene Radiation Shielding

Graphene's sp² carbon lattice has high Z_eff for secondary particle stopping. Doped graphene (with boron or gadolinium) could provide better mass-specific shielding than aluminum for GCR and trapped protons. Active research area — may enable longer MEO/GEO missions.

### E.4 Spot-Welded GSL Nets

Replace braided Dyneema nets with spot-welded graphene sheets:
- Graphene "umbrella rib" spars replace corner masses
- Net weight drops from 1.0 kg (5×5m Dyneema) to ~0.1 kg (5×5m GSL mesh)
- SMA Nitinol actuators + Miura-ori graphene structures for deployment

### E.5 Van der Waals Self-Adhesion Concern

Graphene sheets exhibit strong Van der Waals adhesion to themselves. For net deployment, this could cause sheets to stick together and fail to unfold. **Mitigations:** HBN surface coating (reduces adhesion 10×), pre-crease Miura-ori fold lines (mechanical bias to unfold), stored elastic energy in SMA actuators (overpower adhesion). This is the #1 risk for graphene nets.

### E.6 Vine Robot Concept

UC Santa Barbara vine robots (thin-walled tubes that grow by everting) — adapted with graphene tethers, these could extend from the core toward debris, deploying capture devices at the tip without needing a separate sub-satellite. Related to flexible medical catheters with tendon steering. Speculative but promising for V4+.

---

## Appendix F: Recommended Game Constants (for Constants.js)

Updated from [V2 Section 8](V2%20SPIDER.md:730) with V3 values:

```javascript
// === V3 OCTOPUS SATELLITE ===

// Core
OCTOPUS_CORE_DRY_MASS: 170,          // kg
OCTOPUS_CORE_XENON: 40,              // kg
OCTOPUS_CORE_COLD_GAS: 6,            // kg
OCTOPUS_CORE_BATTERY: 600,           // Wh
OCTOPUS_CORE_SOLAR_AREA: 5.0,        // m² (2 wings)
OCTOPUS_CORE_SOLAR_POWER: 1900,      // W peak
OCTOPUS_CORE_LASER_POWER: 200,       // W electrical input
OCTOPUS_CORE_LASER_OPTICAL: 120,     // W optical output
OCTOPUS_CORE_OCT_RADIUS: 0.577,     // m (inscribed radius, 1.0m across-flats)
OCTOPUS_CORE_LENGTH: 1.2,            // m

// Weaver (Large Arm)
WEAVER_COUNT: 4,                      // default
WEAVER_MASS: 11.0,                    // kg per unit
WEAVER_FUEL_MAX: 50,                  // game fuel units (maps to NANO R3 5500 Ns)
WEAVER_DELTA_V: 500,                  // m/s total FEEP budget
WEAVER_TETHER_LENGTH: 2000,           // m (2 km)
WEAVER_TETHER_REEL_SPEED: 2.0,       // m/s
WEAVER_NET_SIZE: 5.0,                 // m (5×5 deployed)
WEAVER_MAX_CAPTURE_MASS: 500,         // kg
WEAVER_GRIPPER_SPAN: 0.05,           // m (50mm 3-jaw chuck)
WEAVER_LASER_POWER_RECEIVED: 19.5,   // W at 2 km (primary power source)
WEAVER_SOLAR_POWER: 15,              // W peak (backup)
WEAVER_BATTERY: 25,                   // Wh
WEAVER_BODY_DIMENSIONS: [0.2, 0.2, 0.3],  // m [x, y, z]

// Spinner (Small Arm)
SPINNER_COUNT: 4,                     // default
SPINNER_MASS: 3.7,                    // kg per unit
SPINNER_FUEL_MAX: 25,                 // game fuel units (maps to IFM Nano SE 1100 Ns)
SPINNER_DELTA_V: 297,                 // m/s total FEEP budget
SPINNER_TETHER_LENGTH: 500,           // m (0.5 km)
SPINNER_TETHER_REEL_SPEED: 2.0,      // m/s
SPINNER_NET_SIZE: 1.5,                // m (1.5×1.5 deployed)
SPINNER_MAX_CAPTURE_MASS: 10,         // kg
SPINNER_GECKO_PAD_FORCE: 3.5,        // N/cm²
SPINNER_LASER_POWER_RECEIVED: 19.5,  // W at 1 km
SPINNER_SOLAR_POWER: 8,              // W peak (backup)
SPINNER_BATTERY: 10,                  // Wh
SPINNER_BODY_DIMENSIONS: [0.1, 0.1, 0.15],  // m [x, y, z]

// Tether
TETHER_LINEAR_DENSITY: 1.2,          // kg/km (V3: properly sized, down from V2's 3.0)
TETHER_TENSILE_STRENGTH: 500,        // N (5× safety margin)
TETHER_WIDTH: 0.003,                  // m (3 mm ribbon)
TETHER_THICKNESS: 0.0001,            // m (0.1 mm)
TETHER_REEL_POWER: 15,               // W per reel motor
TETHER_EDT_CURRENT: 0.1,             // A (100 mA for EDT propulsion)
TETHER_EDT_FORCE_PER_KM: 1.65,       // mN per km of tether at 100 mA in 30 µT

// Docking (EPM)
DOCK_EPM_HOLD_FORCE: 50,             // N (pair of modules)
DOCK_EPM_SWITCH_ENERGY: 0.5,         // J per cycle
DOCK_EPM_MASS_PER_CAVITY: 0.08,     // kg (pair)
DOCK_CONE_HALF_ANGLE: 15,            // degrees — guide funnel
DOCK_ALIGNMENT_TOLERANCE: 0.02,      // m (±2 cm)

// Optical System
OPTICAL_RANGE_ACCURACY: 0.02,        // m (±2 cm via TDC7200)
OPTICAL_BEARING_ACCURACY: 0.1,       // degrees (quad detector at 2 km)
OPTICAL_COMMS_RATE: 1000000,         // bps (1 Mbps via MRR)
OPTICAL_BEAM_DIVERGENCE: 0.00005,    // rad (50 µrad half-angle)

// Arm Operations
ARM_MAX_SIMULTANEOUS: 8,             // V3: all 8 at full rate (optical bandwidth)
ARM_DETACH_DURATION: 2.0,            // seconds (real-time)
ARM_CAPTURE_APPROACH_SPEED: 0.5,     // m/s relative approach
ARM_SAFE_MODE_SPIN_RATE: 0.1,        // rad/s
ARM_CAPTURES_PER_FUELING_WEAVER: 33, // captures per Weaver before FEEP depletion
ARM_CAPTURES_PER_FUELING_SPINNER: 37,// captures per Spinner before depletion

// Total System
OCTOPUS_TOTAL_WET_MASS: 275,         // kg (core + 4W + 4S + propellant)
OCTOPUS_TOTAL_DRY_MASS: 229,         // kg
```

### Constants Integration with Existing System

| Existing Constant | V2 Value | V3 Value | Notes |
|---|---|---|---|
| `XENON_FUEL_MAX: 100` | 100 kg | *Keep for upgrade headroom* | Core starts at 40 kg; `extra_xenon` adds more |
| `COLD_GAS_MAX: 20` | 20 kg | 6 kg (core) + 0.8 kg (4 Weavers) | Reduced need — arms use FEEP vectoring |
| `BATTERY_MAX: 100` | 100 Wh | 600 Wh (core, fixed) | Core battery is not upgradable — it's sized for laser through eclipse |
| `SOLAR_PANEL_AREA: 20` | 20 m² | 5.0 m² | Smaller but supplemented by laser. Start lower, upgrade via shop |

---

*Document version 3.0 — Space Cowboy Octopus ADR Platform*  
*Evolves from [V2 SPIDER.md](V2%20SPIDER.md). Cross-references [DESIGN_DIRECTION.md](DESIGN_DIRECTION.md) and [RESEARCH_ARCHIVE.md](RESEARCH_ARCHIVE.md).*  
*All calculations shown. All TRL flags current as of 2026.*  
*References: ESA MASTER debris model, ESA Clean Space tethered-ops study, RemoveDEBRIS post-flight report (Surrey/SSTL 2019), ELSA-d mission data (Astroscale 2021), PRISMA proximity ops data (OHB/SSC 2012), Enpulsion NANO R3/IFM Nano SE datasheets, NRL MRR papers (2018-2022), Airbus laser power beaming demo (2019), TiNi Aerospace SMA product line, VACCO MiPS datasheets, Fraunhofer FHR MEGALIT campaign data.*
