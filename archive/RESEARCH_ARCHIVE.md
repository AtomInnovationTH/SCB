# ADR Spider/Octopus Satellite — Research Archive

> Consolidated findings from v1 (hard-science ADR research) and v2 (deep cross-domain research). This file is the source-of-truth for technology assessments.

---

## 1. Autonomous Microsat Mission Heritage

### ELSA-d (Astroscale, 2021) — TRL 9
- Servicer ~175kg + client ~17kg. Magnetic docking (ferromagnetic plate + electromagnet)
- Achieved: autonomous approach and capture, released and recaptured tumbling client (~0.7°/s)
- Sensors: visible cameras far-range, IR mid-range, LiDAR terminal (<10m)
- Lesson: cooperative docking (pre-installed plate) dramatically easier than non-cooperative

### RemoveDEBRIS (Surrey/SSTL, 2018) — TRL 7
- 100kg demonstrator. Net was **5m × 5m Dyneema SK78** knotless mesh, ~7cm cell size
- Corner masses: ~50g tungsten-nickel. Net+canister: ~2 kg total. Provided by Airbus Bremen.
- Harpoon: 10cm titanium, fired at ~20m/s. Worked but controversial (debris risk)
- Vision-based nav: 2D camera + flash LiDAR (CSEM, 0.5kg, 0-2m range)
- Drag sail: 10m², partially deployed

### PRISMA (OHB Sweden, 2010) — TRL 9
- Mango (150kg active) + Tango (40kg passive). Autonomous proximity ops to <1m.
- Nav: differential GPS (1m @ 10km), camera bearing (0.1m @ 100m), 6DOF pose (<2cm @ 3m)
- RF ranging: S-band, ±0.5m at 30km
- Propulsion: ECAPS HPGP green monopropellant (first in-space demo) + cold gas

### Smallest Autonomous Sat with Full ADCS + Propulsion
- NanoAvionics M6P: ~10kg (6U), 3-axis ADCS + green monoprop
- Below ~5kg: no satellite has demonstrated autonomous proximity ops — genuine gap
- Spider Spinner (3-7 kg) pushes into this gap

## 2. Adhesives & Capture Surfaces in Space

### Proven in Space (TRL 7+)
| Technology | Mechanism | Performance | Limitations |
|---|---|---|---|
| JPL/Stanford Gecko Gripper | Van der Waals (PDMS microstructure) | 3.5 N/cm² shear, works -40 to +80°C | Needs smooth surface, degrades ~50 cycles |
| 3M EC-2216 epoxy | Two-part, cures in vacuum | -196 to +177°C, 30 MPa | Must pre-mix, pot life 45 min |
| Master Bond EP21TCHT-1 | Two-part epoxy | -269 to +260°C, 24 MPa | Same pre-mix challenge |
| Kapton/Al tape | Silicone PSA | Works immediately in vacuum | Weak structural loads ~1 N/cm |

### Available (TRL 5-6)
| Technology | Mechanism | Performance | Notes |
|---|---|---|---|
| UV-cure adhesive (Norland NOA) | Acrylic/urethane, cures under UV | 20 MPa, cures in seconds | Works in sunlight! No mixing. |
| JAXA electrostatic pads | Coulombic, high-voltage electrodes | 1-5 N/cm² on conductive surfaces | Works on rough surfaces. Needs ~3kV. TRL 4. |
| Gecko + electrostatic hybrid | Combined dry + electrostatic | ~10 N/cm² on mixed surfaces | TRL 3. Stanford/JPL. |
| Mussel-inspired catechol adhesive | UV-activated, works on any surface | ~15-20 MPa | MIT 2023. Works in vacuum. TRL 5. |

### Multi-Modal Capture Pad Concept
- Gecko (smooth surfaces) + micro-hooks/Velcro (MLI/fabric) + electrostatic (rough/conductive) + permanent magnet (ferrous) + UV-cure adhesive (any surface)
- 3M Dual Lock (industrial Velcro): 35 N/cm², reusable 10,000+ cycles, ~5g per 10cm²
- Remora-inspired directional micro-fins: 40% friction grip w/o suction (Georgia Tech 2020), TRL 3-4

## 3. Net/Tether Materials

### Proven Fibers
| Fiber | Tensile (GPa) | Density (g/cm³) | Temp Range | UV Resist | Heritage |
|---|---|---|---|---|---|
| Dyneema SK78 | 3.6 | 0.97 | -150 to +80°C | Poor (needs coating) | RemoveDEBRIS ✅ |
| Kevlar 49 | 3.6 | 1.44 | -196 to +250°C | Moderate | ISS tethers ✅ |
| Zylon PBO | 5.8 | 1.56 | -196 to +300°C | Excellent | Curiosity bridle ✅ |
| Vectran LCP | 3.2 | 1.40 | -196 to +250°C | Moderate | Pathfinder airbags ✅ |

### Graphene Fiber (Current State)
- TRL 2-3 (lab only). Best achieved: ~2.2 GPa (below Dyneema!)
- GSL (spot-welded) projected: 50 GPa by end 2026 per user's lab contacts
- At 50 GPa: same strength as Dyneema at 1/14th cross-section → massive mass savings

### Tether Sizing (Back-of-Envelope)
- 100 kg debris at 1 m/s²: 100 N force. Safety factor 4×: 400 N design load
- Dyneema 0.38mm dia → 0.22 kg for 2 km. Actually overbuilt in SPIDER_DESIGN.md (6 kg!)
- Practical braided ribbon at 1 kg/km: 2 kg for Weaver, 0.5 kg for Spinner

## 4. Propulsion — Commercial Products

### Electric (High Isp)
| Product | Manufacturer | Type | Mass (kg) | Thrust | Isp | Total Impulse | TRL |
|---|---|---|---|---|---|---|---|
| NANO R3 | Enpulsion | FEEP (In) | 1.38 | 0.35 mN | 2000-6000 s | 5,500 Ns | 9 ✅ |
| IFM Nano SE | Enpulsion | FEEP (In) | 0.67 | 0.5 mN | 2000-5000 s | 1,100 Ns | 9 ✅ |
| TILE-3 | Accion | Electrospray | 0.18 | 0.1 mN | 1200-1800 s | 79 Ns | 7 ✅ |
| BIT-3 | Busek | RF ion (I₂) | 2.9 | 1.1 mN | 2500 s | 25,600 Ns | 6 |

### FEEP Thrust Vectoring (No Moving Parts)
- Segmented extractor electrode → ±10-15° beam steering
- Response: <1ms. No wear. Negligible power cost.
- Combined with magnetorquer (5g) for roll: complete 3-axis attitude
- TRL 5-6 for vectoring

## 5. Relative Navigation

### Sensor Comparison
| Tech | Mass | Power | Range | Accuracy | TRL |
|---|---|---|---|---|---|
| Flash LiDAR | 0.5-5 kg | 3-15W | 0.1-200m | ±2cm @ 10m | 7+ ✅ |
| Stereo cameras | 0.1-0.5 kg | 0.5-3W | 1-500m | ±0.5% range | 7+ ✅ |
| UWB ranging | 0.02-0.1 kg | 0.05-0.5W | 0.1-300m | ±10 cm | TRL 4-5 space |
| RF beacon | 0.1-0.5 kg | 0.5-2W | 1-30 km | ±0.5 m | 9 ✅ |
| Tether encoder | 0g extra | 0W extra | 0-2 km | ±0.1 m | 9 ✅ |
| Tether strain | 0g extra | 0W extra | bearing | ±5° | 9 ✅ |
| TDC7200 pulse ToF | 0.001 kg | 0.01W | 0-2 km | ±2 cm | 9 (chip) |

### PRISMA Demonstrated Accuracy
- 30km: ~1m (GPS). 100m: ~0.1m (camera+RF). 10m: ~2cm (camera 6DOF). 2m: ~1cm.

## 6. Comms Hardware

### ISL Radios
| Product | Band | Mass (g) | Data Rate | Range | TRL |
|---|---|---|---|---|---|
| GOMspace AX100 | UHF 437 MHz | 27 | 4.8 kbps | 20 km | 9 ✅ |
| AstroDev Lithium-2 | UHF 437 MHz | 85 | 9.6 kbps | 50 km | 9 ✅ |
| EnduroSat UHF II | UHF 435-438 | 200 | 19.2 kbps | 100 km | 9 ✅ |

### Optical Comms
| Product | Mass (kg) | Power | Data Rate | TRL |
|---|---|---|---|---|
| CLICK-A/B (MIT LL) | 1.0 | 5W | 200 Mbps | 7 ✅ |
| Mynaric OISL | 1.5 | 8W | 100 Mbps | 7 ✅ |
| CubeCat (TNO) | 0.3 | 2W | 1 Mbps | 5 |
| NRL MRR (Modulated Retro-Reflector) | 0.015 | 0.05W | 10 Mbps | 6 |

### Bandwidth Analysis
- Per arm state update: ~72 bytes. At 10Hz: 5,760 bps. 
- Delta-compressed (bee waggle dance): ~10 bytes/update. At 10Hz: 800 bps. 8 arms: 6.4 kbps.
- Optical MRR: 1+ Mbps — bandwidth problem eliminated entirely

## 7. Power Beaming

### Laser Power to Arms
- 808nm or 976nm matched to GaAs PV bandgap
- Laser efficiency: 50-65%. PV conversion at matched wavelength: 60-68%. Overall: 30-40%.
- At 200W electrical → 120W optical. At 1km: spot ~10cm. Arm PV receiver (10×10cm): ~78W delivered.
- Core can beam through eclipse (battery-powered laser)
- Option B (recommended): 1 laser + MEMS scanning mirror → time-division to 4 deployed arms → ~50W avg each
- Heritage: PowerLight (1kW @ 1km, 2019), Airbus (60W to drone, 2019), JAXA (1.8kW microwave @ 55m, 2015)
- TRL 4-5 for space laser power beaming

### Mass Impact
- Core: +~1 kg (laser + optics + MEMS + detectors)
- Arms: remove 3/4 solar faces → save 0.3-0.9 kg per arm
- Arms no longer need sun-pointing → removes attitude constraint during capture

## 8. Docking — EPM (Electro-Permanent Magnets)
- EPMs: permanent magnet + electromagnet coil. Permanent hold with ZERO power. Brief pulse to release/engage.
- Industrial: Fraunhofer IWU, Eclipse Magnetics, Stanford EPM research
- Mass: ~50-100g per dock for ~50N holding force
- vs current spec: 500g-1000g for ferromagnetic plate + electromagnet
- Combined with recessed "pouch" cavity + ball-detent mechanical backup

## 9. Biological Inspirations (Key Ones)

### Octopus
- Distributed intelligence (2/3 neurons in arms), multi-modal suckers, arm autotomy, chromatophore (light-based) communication

### Brood Carriers
- Kangaroo: recessed pouch, self-entry by joey → arms in recessed cavities
- Scorpion: texture grip (babies on back), no active latching needed in rest state
- Seahorse: pouch = umbilical life-support → tether = power/data umbilical
- Cichlid mouth-brooding: fry recognize parent → unique homing beacons per dock

### Parasites
- Remora: directional micro-fin friction grip (works on rough surfaces)
- Parasitoid wasp: micro-penetrator (ratcheting screw anchor, 10g total)
- Tick: barbed anchor + cement (combined mechanical + adhesive)

### Predators
- Peregrine falcon stoop: gravity-gradient "free" approach from higher orbit
- Osprey: adaptive 3-jaw gripper (lathe chuck concept, 150g miniaturized)
- Eagle: ratchet-lock gripper (zero power to maintain hold)

### Marine
- Mussel: DOPA adhesive on any surface, UV-curable analog exists
- Starfish: array of micro-attachments (100 × 2mm pads beats 1 × 20cm pad)
- Cuttlefish: spring-loaded rapid deployment (stored elastic energy, JWST heritage)

### Insects/Micro
- Bombardier beetle: pulsed micro-valve cold gas (MEMS, inkjet heritage)
- Trapdoor spider: passive ambush capture (deploy pad, power down, wait)
- Maple seed: passive spin-stabilization from asymmetric mass
- Diatom: hierarchical lattice (DMLS titanium, 40% lighter than solid)

## 10. Industrial Cross-Domain

### Fishing
- Purse seine: two-arm encirclement capture
- Gill net: gossamer passive entanglement (20×20m Dyneema mono @ 0.2 kg)
- Trawl: funnel net + STEM boom mouth-opening 
- Long-line: single tether with multiple micro-pod capture nodes

### ROV / Ocean
- Tether management: constant-tension PID control, Lebus grooved drum, level-wind
- USBL: acoustic positioning → adapt to optical
- Spring-loaded tensioner: clock-spring mechanism, 100g, prevents snatch loads

### Drones
- Intel swarm: pre-programmed choreography with synced clocks (near-zero comms during transit)
- Crazyflie: UWB ranging at 27g total system
- Skydio: AprilTag fiducial for precision autonomous docking → TRL 9 algorithm
- Zipline: tether-guided return (arrestor concept)

### Deployable Structures
- Miura-ori fold: net deployment in single pull, predictable geometry
- Origami wheel (BYU): compact→sphere transition for capture cage
- STEM booms (Redwire): stored elastic energy, 200g for 2m hoop deployer
- SMA (Nitinol) actuators: TRL 9 in space, used in pin-pullers. Net cinch, tendon pull, deployment.

### Mini Capture Components
- Wire-snare gripper (Canadarm LEE heritage): ~50g miniaturized
- 3-jaw mini chuck (lathe chuck): ~100-150g in titanium
- Micro-screw anchor (parasitoid wasp): ~10g
- Medical micro-dispenser (epoxy): ~50g, 10 doses

## 11. Launch Options

| Vehicle | Fairing ID | LEO Cap | Cost/kg | Notes |
|---|---|---|---|---|
| PSLV-XL | 2.8m | 1,750 kg | ~$15K | Current baseline |
| ISRO SSLV | 0.83m | 500 kg | ~$12K | Ideal for demo |
| Electron Hippo | 1.56m | 300 kg | ~$25K | Dedicated small-sat |
| Falcon 9 ride | 0.6-1.0m | 300 kg/port | ~$5K | Cheapest per kg |

## 12. V2 to V3 Key Mass Reductions Identified

| Subsystem | V2 (kg) | V3 Target (kg) | How |
|---|---|---|---|
| Spinner cold gas | 0.5/arm | ~0.005/arm | FEEP vectoring + magnetorquer |
| Spinner comms | 0.1/arm | ~0.015/arm | MRR replaces UHF |
| Spinner nav | 0.2/arm | ~0.004/arm | Lighthouse + tether nav |
| Spinner solar | 0.4/arm | ~0.05/arm | Laser power beaming |
| Spinner structure | 1.5/arm | ~0.6/arm | DMLS lattice, PCB integration |
| Weaver tether | 6.0/arm | ~2.0/arm | Proper sizing (was 10× overbuilt) |
| Weaver gripper | 0.8/arm | ~0.15/arm | 3-jaw mini chuck + ratchet |
| Docking per arm | 0.5-1.0 | ~0.1 | EPM replaces passive plate + electromagnet |
| Core UHF array | 4.0 total | ~0.5 | Optical replaces 7 of 8 UHF links |
