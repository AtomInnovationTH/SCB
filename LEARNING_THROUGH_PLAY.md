# Space Cowboy — Learning Through Play

> **Premise:** Players will absorb more real aerospace engineering in 10 hours of Space Cowboy than in a semester lecture — because every concept is tied to a gameplay consequence they CARE about.
>
> **Design rule:** Never lecture. Let the physics teach itself through cause→effect. Ground station "explains" only when the player has just EXPERIENCED the concept.
>
> **Last updated:** 2026-04-14 (Session 23 — tutorial flow updated to match 10-stage autopilot-first implementation)

---

## Table of Contents

1. [How Concepts Are Taught](#1-how-concepts-are-taught)
2. [Orbital Mechanics — The Ocean You Fish In](#2-orbital-mechanics--the-ocean-you-fish-in)
3. [Propulsion — Why Every m/s Matters](#3-propulsion--why-every-ms-matters)
4. [Power Systems — Keeping the Lights On](#4-power-systems--keeping-the-lights-on)
5. [Space Environment — The Weather Up Here](#5-space-environment--the-weather-up-here)
6. [Materials Science — What's Inside the Catch](#6-materials-science--whats-inside-the-catch)
7. [Tether Physics — Your Fishing Lines](#7-tether-physics--your-fishing-lines)
8. [Debris & Collision Physics — Why You're Here](#8-debris--collision-physics--why-youre-here)
9. [Sensors & Communications — Eyes and Ears](#9-sensors--communications--eyes-and-ears)
10. [Concept Map: When Players Learn What](#10-concept-map-when-players-learn-what)
11. [Upgrade Tree as Curriculum](#11-upgrade-tree-as-curriculum)
12. [Communications & Data — Talking Through the Void](#12-communications--data--talking-through-the-void)
13. [Navigation & Precision — Finding Your Way](#13-navigation--precision--finding-your-way)
14. [Attitude Control & Stabilization — Keeping Steady](#14-attitude-control--stabilization--keeping-steady)
15. [Power Systems Deep Dive — Every Watt Counts](#15-power-systems-deep-dive--every-watt-counts)
16. [Avionics & Reliability — The Digital Backbone](#16-avionics--reliability--the-digital-backbone)
17. [Orbital Environment Degradation — The Slow Killers](#17-orbital-environment-degradation--the-slow-killers)

---

## 1. How Concepts Are Taught

### 1.1 The Three-Beat Pattern

Every science concept follows this rhythm:

```
1. EXPERIENCE — Player encounters the concept as a gameplay event
   "Why did my solar panels just stop charging?"

2. CONSEQUENCE — The concept affects their resources/score/mission
   Battery draining rapidly. Arms losing power. Forge offline.

3. EXPLANATION — Ground station explains, NOW that the player cares
   "You've entered Earth's shadow. Eclipse period: 36 minutes.
    Solar panels resume on the day side. Manage battery."
```

The player never reads about eclipses in a manual. They LIVE through one, suffer the consequence, then get the explanation at the moment of maximum receptivity.

### 1.2 The "Codex" Radio

Ground station doubles as an encyclopedia — but only delivers entries the player has experienced:

```
After first eclipse:
  CODEX UNLOCKED: "Eclipse Periods"
  "LEO spacecraft spend ~35% of each orbit in Earth's shadow.
   At 400 km altitude, eclipse lasts ~36 minutes of the 92-minute orbit.
   ISS astronauts see 16 sunrises per day."

After first solar storm:
  CODEX UNLOCKED: "Space Weather"
  "The Sun periodically ejects billions of tons of plasma at 1000+ km/s.
   These Coronal Mass Ejections can damage electronics, degrade solar panels,
   and increase radiation exposure. Even the ISS crew shelters during severe storms."
```

Codex entries are SHORT (3-5 sentences), conversational, and always include a real-world reference (ISS, Hubble, real missions). The player builds a personal space encyclopedia through gameplay.

---

## 2. Orbital Mechanics — The Ocean You Fish In

### 2.1 Concepts Taught Through Navigation

| Concept | How Player Encounters It | Gameplay Consequence | Ground Station Explains |
|---------|------------------------|---------------------|------------------------|
| **Orbital period** | Higher debris clusters take longer to reach AND have longer orbits | Time management — high orbits mean fewer passes per mission day | "Higher orbit = slower angular velocity. At 800 km you orbit in 101 min vs 92 min at 400 km." |
| **Hohmann transfer** | Autopilot shows the transfer ellipse when moving between clusters | Player sees the physics: thrust at point A, coast, arrive at point B half an orbit later | "A Hohmann transfer uses two burns to move between circular orbits. It's the most fuel-efficient path — NASA has used it for every planetary mission." |
| **Inclination change** | Changing from ISS band (51.6°) to SSO band (97.5°) costs ENORMOUS ΔV | Player learns to PLAN which inclination to commit to — changing mid-mission is crippling | "Changing orbital plane requires thrust perpendicular to your velocity. A 45° change at LEO costs ~5.6 km/s — more than getting to orbit from Earth's surface!" |
| **Prograde/retrograde** | RCS puffs (WASD) raise or lower orbit slightly | Prograde nudge = drift ahead in the cluster. Retrograde = fall behind. Intuitive once experienced | "Thrusting prograde adds energy — your orbit rises on the far side. Counterintuitive: to catch up to something ahead of you, you thrust backward to drop lower where you orbit faster." |
| **Relative velocity** | Debris in slightly different orbits drifts past at varying speeds | Fast-movers are hard to catch. Slow drifters are easy. Player quickly grasps that matched orbits = low relative V | "In LEO, a 10 km altitude difference means ~5 m/s relative drift. Same orbit = nearly stationary relative to you." |
| **J2 perturbation** | After many orbits, debris positions shift unexpectedly from predictions | Targets not quite where expected — sensor recalibration needed | "Earth bulges at the equator. This 'J2' perturbation rotates orbital planes over time — Sun-synchronous orbits exploit this to stay in constant sunlight." |
| **Atmospheric drag** | Low-altitude debris decays faster; some targets deorbit naturally before you reach them | Player learns that patience is sometimes a strategy — wait for natural deorbit vs expensive capture | "Below ~300 km, atmospheric drag is significant. ISS loses ~2 km altitude per month and must reboost regularly." |

### 2.2 The "Orbital Pool" Moment

The biggest learning moment: player realizes **to catch something ahead of you, you thrust backward**.

This is so counterintuitive that it deserves a special tutorial beat:

```
SCENARIO: Debris is 2 km ahead along-track (same orbit)
Player instinct: thrust forward (prograde) to catch up

WHAT HAPPENS: Mothership climbs to a higher orbit → SLOWER → falls FURTHER behind

Ground: "Whoa — you're drifting further away. In orbit, going faster makes you go
higher, which makes you slower. Try the opposite: thrust retrograde to drop 
into a lower, faster orbit. You'll catch up from below."

Player thrusts retrograde → orbit drops → angular velocity increases → 
closes the gap → rises back up at target → CATCH!

Ground: "That's orbital mechanics in a nutshell. The pool player's trick:
to go right, you bank left. Welcome to space, Cowboy."
```

This single moment teaches more orbital mechanics than a chapter of textbook.

---

## 3. Propulsion — Why Every m/s Matters

### 3.1 The ΔV Budget — Your Lifeblood

Players will internalize ΔV conservation because running out = mission over.

| Concept | Gameplay Trigger | What Player Learns |
|---------|-----------------|-------------------|
| **ΔV (delta-V)** | HUD shows remaining ΔV as the PRIMARY resource | ΔV is "how much maneuvering you can still do" — like gas in the tank, but for space |
| **Tsiolkovsky equation** | Heavier cargo = less ΔV remaining (mass ratio changes) | "Every kg of debris you're hauling reduces your remaining ΔV. Full cargo hold means less maneuvering ability." |
| **Mass ratio** | Picking up a 2000 kg rocket body significantly depletes remaining ΔV | Player learns to plan: capture heavy targets when you're near a resupply/deorbit point |
| **Thrust vs Isp tradeoff** | Cold gas gives quick response but terrible efficiency. Ion gives slow push but incredible efficiency | "Cold gas: great for dodging, terrible for travel. Ion: terrible for dodging, great for travel." |

### 3.2 Propellant Types — The Upgrade Path Teaches Chemistry

The shop/upgrade tree naturally teaches why different propellants exist:

**Xenon (Xe)** — Starting propellant
```
Shop description: "Noble gas. Heavy atomic mass (131 amu) gives excellent 
thrust-to-power ratio. The gold standard for electric propulsion."

Player experience: reliable, balanced, expensive to buy

Codex: "Xenon is used by NASA's Dawn spacecraft, ESA's SMART-1, and
SpaceX's Starlink satellites. It ionizes easily and its heavy atoms
produce good thrust per watt. But it's rare — extracted from air at 
~0.087 ppm. Global production: ~70 tons/year."
```

**Krypton (Kr)** — Mid-game upgrade
```
Shop description: "Lighter noble gas (84 amu). 10% less thrust than Xenon
but 40% cheaper. Higher Isp means more ΔV per kg."

Player experience: CHOICE — do I want more thrust (Xe) or more total ΔV (Kr)?
First real propulsion tradeoff decision.

Codex: "SpaceX switched Starlink from Xenon to Krypton to cut costs.
Krypton provides ~10% lower thrust but ~15% higher specific impulse.
For missions where time isn't critical, Krypton gives more total ΔV 
from the same tank mass."

Gameplay: Krypton unlocks after Cluster 3. Players who went through
Cluster 1-2 on Xenon now have enough experience to understand the tradeoff.
```

**Argon (Ar)** — Late-game economy option
```
Shop description: "Cheapest noble gas (40 amu). Half the thrust of Xenon.
Much higher Isp. Abundant — from air liquefaction."

Player experience: unlocks when ΔV efficiency matters most (long-range missions)
Argon is the "diesel" — bad acceleration but incredible range per dollar

Codex: "Argon is 100× cheaper than Xenon ($0.50/kg vs $50/kg) and 
orders of magnitude more abundant. But its light mass means lower thrust 
per watt. ESA is testing Argon Hall thrusters for cargo tugs where speed 
doesn't matter — only total impulse per dollar."

Gameplay: Argon unlocks for players who understand that patient,
efficient orbital transfers beat brute-force approaches.
```

**Salvaged Metals as Propellant** — Forge creates this option
```
Shop description: "Your forge can ionize salvaged metals into propellant.
Aluminum Isp: 800s. Gallium Isp: 3000s (!!). Desperate times, creative solutions."

Player experience: "Wait — I can BURN my salvage as fuel?" 
This is the emergency option when stranded, and the advanced option 
when Gallium's incredible Isp makes it worth more as propellant than as cargo.

Codex: "Metal-ion propulsion is a real concept. Any conductive material
can be ionized and accelerated electromagnetically. Gallium is particularly 
interesting: it melts at just 30°C (body temperature!) and has excellent 
ionization properties. A Field-Emission Electric Propulsion (FEEP) thruster 
using Indium or Gallium achieves Isp of 2000-6000s."
```

### 3.3 Specific Impulse — The Concept That Clicks

Players don't need to learn the formula. They need to feel it:

```
EARLY GAME:
Player has 100 kg Xenon. Isp 1500s. Makes 3 inclination changes.
"I'm running low already?"

MID GAME (Krypton upgrade):
Same 100 kg tank. Isp 1800s. Makes 3.6 equivalent changes.
"Wait — same tank, more maneuvers? What changed?"

Ground: "Krypton's higher specific impulse means each kg of propellant 
delivers more total impulse. Think of it as 'miles per gallon' for 
rockets. Higher Isp = more ΔV from the same fuel mass."

Player now intuitively understands Isp. They will CHOOSE propellants 
based on mission profile — short, aggressive runs (Xe) vs long-range 
efficient campaigns (Kr/Ar).
```

### 3.4 Electrodynamic Tether (EDT) Propulsion — Free Thrust

This is the mind-blowing one. Taught late-game when players have V4 tethers:

```
SCENARIO: Player deploys a long V4 GSL tether (12.5 km)

Ground: "That tether is cutting through Earth's magnetic field at 7.5 km/s.
A conductor moving through a magnetic field generates voltage — Faraday's law.
We can reverse this: push current through the tether and the magnetic field
pushes BACK. Free thrust — no propellant consumed."

Player experience: EDT propulsion appears as a free, slow thrust option
for deployed arms. Instead of using FEEP fuel, the arm rides the magnetic 
field. It's slow but DOESN'T USE FUEL.

Codex: "Electrodynamic tethers convert electrical energy into orbital 
energy via Lorentz force: F = IL × B. A 2 km tether at 100 mA in LEO's 
~30 µT field generates ~3.3 mN of thrust. NASA's TSS-1R experiment 
(1996) demonstrated EDT thrust on the Space Shuttle — the tether generated 
3,500 volts across 20 km."
```

**Magnetic field strength varies** — this teaches real geophysics:

```
Player notices: EDT thrust is stronger at 51.6° inclination than at equator.
EDT barely works at high altitude (>1000 km).

Ground: "Earth's magnetic field is dipolar — strongest near the poles, 
weakest at the equator. At higher altitudes it falls off as 1/r³. 
Your EDT works best in low, high-inclination orbits."

Gameplay consequence: EDT propulsion is a reason to PREFER certain 
inclination bands. ISS band (51.6°) has good field strength AND good
debris density. Strategic synergy!
```

---

## 4. Power Systems — Keeping the Lights On

### 4.1 Solar Panel Concepts

| Concept | Gameplay Event | What's Learned |
|---------|---------------|----------------|
| **Photoelectric effect** | Solar panels generate power in sunlight | Light → electricity. Efficiency matters. |
| **GaAs vs Silicon** | Upgrade from Si (22%) to GaAs (30%) cells | "Gallium Arsenide cells used on Mars rovers and ISS are more efficient than your roof panels — and radiation-hard." |
| **Degradation** | Panels lose efficiency over time (radiation exposure) | "After 10 years in LEO, solar panels lose ~15% efficiency. Salvaged GaAs fragments from dead sats can repair yours." |
| **Eclipse periods** | Battery drains in Earth's shadow | 35% of each orbit is dark. Battery size and charge rate become critical. |
| **Sun angle** | Power varies as panels rotate relative to sun | "Tracking the sun with panel gimbals maximizes power. Fixed panels lose ~30% at off-axis angles." |
| **Solar storm damage** | Severe storm event degrades panel efficiency permanently | "Energetic protons penetrate cell junctions, creating defects. Panel efficiency drops 2-5% per severe event." |

**Upgrade path teaches real technology:**
```
Level 1: Silicon cells (22% efficiency) — "Standard terrestrial technology"
Level 2: GaAs cells (30%) — "What the ISS and Mars rovers use"
Level 3: Multi-junction GaInP/GaAs/Ge (39%) — "Triple-junction cells stack
         three materials, each absorbing different wavelengths. Used on 
         every interplanetary spacecraft since 2000."
Level 4: Perovskite-silicon tandem (45%) — "Bleeding edge. Lab-demonstrated
         2025. Cheap to manufacture, radiation-tolerant. The future."
```

Each upgrade comes with a ground station one-liner explaining the real technology. Player associates better gameplay performance with real engineering innovation.

### 4.2 Power Distribution — The Triage Problem

The existing [`PowerDistribution`](js/systems/PowerDistribution.js) system teaches engineering prioritization:

```
SCENARIO: Eclipse + high power demand (Forge active + 3 arms deployed)

Power available: 0W solar + 85Wh battery remaining
Power demanded: 450W (Forge 200W, Arms 3×50W, Core 100W)

Player must choose: power sliders for each bus
  CORE: [████████░░] 80% — life support, can't go below 50%
  ARMS: [██████░░░░] 60% — arms slow but still functional  
  FORGE: [░░░░░░░░░░] 0% — forge paused until sun returns
  SENSORS: [████░░░░░░] 40% — reduced detection range

Ground: "Power management is the #1 operational challenge for LEO spacecraft.
ISS has 75 kW peak solar but only ~30 kW average after eclipse losses.
Every watt is allocated by mission priority."
```

---

## 5. Space Environment — The Weather Up Here

### 5.1 Solar Storm Events

Full-featured gameplay events that teach real space weather:

```
╔═══════════════════════════════════════════════╗
║  ⚠ SPACE WEATHER ADVISORY                     ║
║  ─────────────────────────────                 ║
║  NOAA Solar Radiation Storm Warning            ║
║  Category: S3 (Strong)                         ║
║  Proton flux: >1000 pfu @ >10 MeV             ║
║  Expected duration: 8-12 hours                 ║
║  ─────────────────────────────                 ║
║  EFFECTS ON YOUR MISSION:                       ║
║  • Solar panel degradation: -2% permanent       ║
║  • Sensor noise: +40% (false targets)           ║
║  • Communication disruption: 30% packet loss    ║
║  • Radiation dose: avoid EVA/arm ops if possible ║
║  ─────────────────────────────                 ║
║  RECOMMENDED: Retract arms. Minimize exposure.  ║
║  Wait for all-clear before resuming operations.  ║
╚═══════════════════════════════════════════════╝
```

**Gameplay choice:** Continue fishing during the storm (risky — sensor noise causes false targets, arm fuel wasted on phantom debris) or retract and wait (safe — but lose 8-12 hours of mission time).

Advanced players learn to predict storms from precursor events and position defensively.

### 5.2 Van Allen Belts & Radiation

| Altitude | Radiation Level | Gameplay Effect |
|----------|----------------|-----------------|
| 200-500 km | Low | Normal operations |
| 500-1000 km | Moderate | Gradual sensor degradation, panel aging |
| 1000-2000 km | HIGH (inner belt edge) | Rapid degradation. Time-limited operations. |

```
Player first ventures to 1200 km cluster (high-value, less competition):

Ground: "Heads up — you're entering the inner Van Allen belt fringe. 
Radiation levels are 10× higher than your usual altitude. Your electronics 
and solar panels will degrade faster up here. Get in, get your catches, 
get out."

Codex: "The Van Allen belts are regions of trapped charged particles held 
by Earth's magnetic field. The inner belt (1,000-6,000 km) is mostly 
protons. Apollo astronauts passed through it in ~30 minutes. Long 
exposure degrades spacecraft electronics and solar cells."
```

### 5.3 South Atlantic Anomaly

```
Player crosses over Brazil/South Atlantic, electronics glitch:
- Sensor ghost blips
- Brief HUD static/flicker
- ARM_PILOT controls momentarily lag

Ground: "You just flew through the South Atlantic Anomaly — a dip in 
Earth's magnetic field where the inner Van Allen belt sags to 200 km 
altitude. ISS astronauts see 'shooting stars' in their eyes here from 
cosmic ray hits on their retinas. Expect increased noise for a few minutes."

Codex: "The SAA causes ISS laptops to crash, Hubble to shut down science 
instruments, and astronauts to report phosphene flashes (visual artifacts 
from particle impacts on the retina). It's the most radiation-intense 
region at LEO altitudes."
```

### 5.4 Earth's Magnetic Field — Not Uniform

Directly relevant to EDT propulsion:

```
Player at equator (28.5° inclination):
  EDT thrust: weak (~1.5 mN per km tether)
  
Player at ISS orbit (51.6°):
  EDT thrust: moderate (~3.3 mN per km)
  
Player at polar orbit (82°):
  EDT thrust: strong (~5 mN per km) but orientation harder

Ground: "Earth's magnetic field is roughly dipolar — field lines emerge 
near the south magnetic pole and loop back to the north. Field strength 
at LEO ranges from ~25 µT at the equator to ~60 µT near the poles. 
Your EDT performs best in high-inclination orbits."
```

**Gameplay consequence:** EDT propulsion adds a REASON to prefer certain inclination bands beyond just debris density. ISS band (51.6°) has decent field AND decent debris — a natural sweet spot.

### 5.5 Day/Night Thermal Cycling

```
Player inspects a metal debris fragment in sunlight: surface temp +120°C
Same fragment 40 minutes later, in shadow: -120°C

Ground: "In LEO, objects cycle between +120°C (direct sunlight) and 
-170°C (eclipse) every 90 minutes. This thermal cycling fatigues 
metals over years — which is why old debris is brittle and fragments 
more easily than fresh debris."

Gameplay: Old debris (high age stat) is more fragile — nets work better. 
Fresh debris is tougher — may need gecko/electrostatic grip.
```

---

## 6. Materials Science — What's Inside the Catch

### 6.1 Salvage as Chemistry Lesson

Every piece of debris teaches material science through the salvage reveal:

```
SALVAGE REVEAL: Defunct Communications Satellite (1,200 kg)
┌──────────────────────────────────────────────┐
│  📦 MATERIAL BREAKDOWN                        │
│  ─────────────────                            │
│  Aluminum 6061-T6   540 kg  │████████│ 45%   │
│    "Aerospace workhorse. Same alloy as        │
│    aircraft fuselage. Easy to forge."         │
│                                               │
│  GaAs Solar Cells    96 kg  │██      │  8%   │
│    "Gallium Arsenide — 3× more efficient      │
│    than silicon, but 100× more expensive.     │
│    Can repair your own panels."               │
│                                               │
│  Titanium Ti-6Al-4V  72 kg  │█       │  6%   │
│    "40% lighter than steel, twice as strong.  │
│    Used where weight matters most."           │
│                                               │
│  ⭐ Iridium contacts   0.4 kg              RARE│
│    "One of the rarest elements on Earth.      │
│    Extremely corrosion-resistant. Used in     │
│    satellite electrical contacts. Worth       │
│    $150/kg on orbit."                         │
│                                               │
│  SYNERGY: GaAs + Copper wire = Solar Array ×1.5│
└──────────────────────────────────────────────┘
```

### 6.2 The Forge Teaches Metallurgy

The [`ForgeSystem`](js/systems/ForgeSystem.js) EML furnace teaches:

```
FORGING: Aluminum → Refined Aluminum
Process: "Electromagnetic levitation suspends the sample in a magnetic 
field — no crucible needed. In microgravity, surface tension holds 
the molten ball perfectly spherical. This is how ISS experiments create 
exotic alloys impossible to make on Earth."

FORGING: Mixed metals → Alloy
Process: "Your forge can combine salvaged Titanium and Aluminum into 
Ti-6Al-4V alloy — worth 3× the raw metals individually. The ISS TEMPUS 
facility does exactly this, studying undercooling and nucleation in 
microgravity conditions."

FORGING: Gallium → Propellant slugs
Process: "Gallium melts at just 30°C — body temperature! This makes it 
perfect for FEEP thruster propellant. A liquid metal fed through an 
emitter tip, ionized by an electric field, and accelerated. Isp: 3000+ 
seconds. You're turning junk into rocket fuel."
```

### 6.3 Graphene Superlattice — V4 Upgrade Path

The V4 upgrades teach cutting-edge materials science:

```
SHOP: GSL Tether Upgrade
"Graphene Superlattice (GSL) fiber: layers of graphene spot-welded into 
a macroscopic thread. 50 GPa tensile strength — 14× stronger than Dyneema 
per unit area. Your 2 km tethers become 12.5 km tethers at the same mass.

Fun fact: a single layer of graphene is the strongest material ever 
measured — 130 GPa. But single layers are atoms-thick. GSL is the 
engineering breakthrough that makes bulk graphene usable."

SHOP: HBN-Coated GSL Net
"Hexagonal Boron Nitride coating: graphene's insulating twin. Same crystal 
structure, but a wide-bandgap insulator. The HBN coat insulates the 
conductive graphene core — and when you apply 3 kV, the net becomes a 
distributed electrostatic gripper. Every thread is a tiny JAXA capture pad."
```

---

## 7. Tether Physics — Your Fishing Lines

### 7.1 Concepts Taught Through Tether Gameplay

| Concept | Gameplay Moment | Real Physics |
|---------|----------------|--------------|
| **Tensile strength** | Tether color shifts green→yellow→red under load | "Breaking strength: 500N (5× safety factor on 100N working load)" |
| **Safety factor** | Never see the tether break (5× margin) — but heavy catches stress it | "All aerospace cables are designed with large safety margins. The tether is rated for 500N but we never load it past 100N in normal ops." |
| **Catenary curve** | Tether visibly sags/curves, not a straight line | "In microgravity, tether shape is dominated by gravity gradient and centrifugal effects, not weight. The curve you see is tidal force, not drooping." |
| **Gravity gradient** | Long V4 tethers (12.5 km) experience noticeable tidal stretching | "The top and bottom of a long vertical tether are at different altitudes → different gravity → tidal tension of ~0.35 mN per meter per km." |
| **Reel tension control** | Reel-in speed affects tether stress. Fast reel on heavy debris = high tension | "Constant-tension PID control, borrowed from oil & gas drill pipe management. The reel motor adjusts speed to maintain safe load." |
| **EDT propulsion** | Current through tether creates thrust (see §3.4) | "Lorentz force: F = IL × B. Current-carrying wire in a magnetic field experiences a force perpendicular to both." |

### 7.2 The Slingshot Moment

Advanced players discover: deploying a long tether while orbiting creates angular momentum effects:

```
Player extends Weaver on 12.5 km tether radially outward:
- The arm tip is at HIGHER altitude → slower orbital velocity
- The arm drifts backward relative to mothership
- Tether swings like a pendulum

Ground: "You're seeing gravity gradient torque. The arm is at higher 
altitude where orbital velocity is lower — so it falls behind. Over 
time, this causes the tether to 'librate' (swing) like a pendulum. 
Some spacecraft designs exploit this for propellant-free attitude control."
```

---

## 8. Debris & Collision Physics — Why You're Here

### 8.1 Kessler Syndrome — The Existential Threat

The entire game premise teaches this, but it's reinforced through gameplay events:

```
EVENT: Kessler Cascade
"Multiple fragments from a recent collision are creating secondary impacts.
Debris density in this sector increasing 3× per hour."

Player sees: debris count visibly multiplying. New fragments appearing.
Capture becomes urgent — every missed fragment might spawn more.

Ground: "This is Kessler Syndrome — named after NASA scientist Don Kessler 
who predicted in 1978 that orbital debris would eventually hit a tipping 
point where collisions create more debris faster than it deorbits naturally. 
We may have crossed that threshold in 2025."
```

### 8.2 Hypervelocity Impact

```
Player witnesses a collision between two debris objects:

VISUAL: Brief flash. Expanding cloud of tiny fragments. Doppler-shifted ping.

Ground: "Average collision velocity in LEO: 10 km/s — 25× faster than a 
rifle bullet. At that speed, a paint fleck hits like a bullet and a 1 cm 
fragment hits like a hand grenade. ISS windows have been replaced due to 
paint-fleck impacts."

HUD: New fragments appear in the NavSphere. Each one a future target... 
or a future threat.
```

### 8.3 Debris Catalog & Tracking

```
Player sees tracked (cataloged) vs untracked debris:
- Tracked: known orbit, predictable approach. Green on NavSphere.
- Untracked: surprise! Appears only on close-range sensors. Yellow flash.

Ground: "The US Space Command tracks ~36,000 objects larger than 10 cm. 
But there are an estimated 130 million fragments between 1 mm and 1 cm 
that are too small to track but large enough to damage spacecraft. 
Your sensors can detect some of these at close range."

Gameplay: Sensor upgrade (IR Scanner) lets you detect untracked debris. 
More targets = more revenue, but also more collision warnings.
```

### 8.4 Conjunction Warnings

The [`ConjunctionSystem`](js/systems/ConjunctionSystem.js) teaches real operational procedures:

```
╔══════════════════════════════════════╗
║  🔴 CONJUNCTION WARNING              ║
║  Object: COSMOS-2251 DEB #4847       ║
║  TCA: 00:14:32 (14 min)              ║
║  Miss distance: 0.8 km predicted     ║
║  Collision probability: 1.2×10⁻³     ║
║  ─────────────────────────           ║
║  RECOMMEND: Avoidance maneuver        ║
║  ΔV required: 0.3 m/s retrograde     ║
║  ACTION: [ENTER] Execute  [ESC] Risk  ║
╚══════════════════════════════════════╝

Ground: "ISS receives about 50 conjunction warnings per week, with 
~3 requiring detailed analysis and ~1-2 per year requiring an actual 
avoidance maneuver. Pro tip: maneuver early — a 0.1 m/s burn 6 hours 
before closest approach gives you a 2 km margin."
```

---

## 9. Sensors & Communications — Eyes and Ears

### 9.1 Optical vs Radio

```
Player notices: comms work everywhere except in eclipse behind Earth

Ground: "Your spacecraft uses optical communication — laser links. 
Faster than radio (1 Mbps vs 9.6 kbps) and no spectrum license needed. 
But it requires line of sight. When you're behind Earth, there's no 
ground station to talk to. This is why real spacecraft use relay satellites 
in higher orbits — NASA's TDRS constellation."
```

### 9.2 LIDAR & Time-of-Flight

```
Player uses LIDAR to scan a tumbling debris object:
3D pointcloud appears, revealing shape and tumble axis

Ground: "Your LIDAR fires 10,000 laser pulses per second. Each pulse 
bounces off the target and returns — measuring distance to ±2 cm 
precision. By building up these return measurements, we reconstruct 
the target's shape, size, and rotation state. Same technology used 
by self-driving cars and Mars rovers."
```

### 9.3 Doppler Effect

```
Player in ARM PILOT mode notices approach beep pitch rising:

Not just audio feedback — it's real Doppler:
"The radar return frequency shifts higher when closing and lower when 
receding. Your approach beeps are sonified Doppler data — the faster 
the pitch rises, the faster you're closing. Ambulance siren effect, 
but at 7 km/s."
```

---

## 10. Concept Map: When Players Learn What

### 10.1 Exposure Timeline

```
MINUTE 1-5 (Tutorial — 10-stage autopilot-first flow):
├── Stage 0 BEAUTY — Earth is beautiful from orbit (wonder)
│     └── Scroll wheel zoom hint (camera controls)
├── Stage 1 LOOK_AROUND — Arrow keys rotate view (spatial awareness)
│     └── Codex: Keplerian orbit
├── Stage 2 SCAN — S key radar ping, $50 reward (active sensing)
│     ├── Satellite flashes cyan during scan (audio/visual feedback)
│     ├── Cash register sound + credit flash on reward
│     └── Guaranteed debris spawned within 1.8 km for stages 2–5
├── Stage 3 TARGET_SELECT — Tab cycles targets (target management)
│     └── Codex: Delta-V
├── Stage 4 AUTOPILOT — A key autopilot to target (automation)
│     ├── Ship rotates smoothly toward target (slerp heading)
│     ├── Approaches from behind debris (prograde alignment)
│     └── Codex: Hohmann transfer
├── Stage 5 CAMERA — V key during transit (situational awareness)
│     └── 3 views: COMMAND / TACTICAL / OVERVIEW
├── Stage 6 LASSO — Space key to capture (first catch!)
│     ├── Miss recovery prompts ("get closer", "cooldown")
│     └── Codex: Kessler syndrome
├── Stage 7 DEPLOY — D key for bigger catches (tool selection)
│     └── Codex: FEEP thruster
├── Stage 8 TOOL_MASTERY — Backtick + Z for analysis (advanced tools)
│     └── Codex: Space tether
└── Stage 9 FREE_PLAY — Everything unlocked
      ├── Economy hints: salvage → forge → fuel cycling (delayed discovery)
      └── Deferred fuel cycling hint via Houston comms

MINUTE 5-15 (Early free play):
├── Different debris types (fragment vs defunct sat vs rocket body)
├── Mass affects capture difficulty
├── Fuel is limited (ΔV concept introduced via budget bar)
├── Solar panels charge battery (solar power)
└── Eclipse means no power (orbital shadow)

MINUTE 15-30 (Core loop):
├── Prograde/retrograde counterintuitive (orbital pool)
├── Inclination bands cluster debris (orbital planes)
├── Bigger arms for bigger targets (engineering sizing)
├── Salvage has value (materials science begins)
├── Different metals have different properties
└── Tether length limits range (tether physics)

MINUTE 30-60 (Mid game):
├── Hohmann transfers between clusters (orbital mechanics)
├── ΔV budget planning (Tsiolkovsky intuited)
├── Power distribution tradeoffs (engineering priority)
├── Kessler cascade event (exponential threat)
├── Conjunction warnings (collision avoidance)
├── Sensor upgrades reveal more targets (radar/optical)
└── Forge turns salvage into refined materials (metallurgy)

HOUR 1-3 (Late game):
├── Xenon vs Krypton vs Argon (propellant chemistry)
├── Specific impulse understood intuitively
├── EDT propulsion (electrodynamic tethers!)
├── Earth's magnetic field varies with latitude
├── Van Allen belt radiation (altitude tradeoffs)
├── Solar storm events (space weather)
├── South Atlantic Anomaly (geophysics)
├── Gravity gradient on long tethers (tidal forces)
├── Metal-ion propulsion from salvage (advanced propulsion)
└── Graphene/GSL/HBN materials (V4 upgrades)

HOUR 3+ (Mastery):
├── J2 perturbation orbit drift (astrodynamics)
├── Atmospheric drag vs altitude (orbital decay)
├── Multi-arm EDT optimization (electromagnetic engineering)
├── Synergistic salvage (applied materials science)
└── Player is now casually discussing Keplerian orbits
    and specific impulse over dinner
```

### 10.2 Total Concepts Taught

| Category | # Concepts | How Taught |
|----------|-----------|------------|
| Orbital Mechanics | 12 | Navigation consequences, orbital pool moment, autopilot visualization |
| Propulsion | 10 | ΔV conservation pressure, upgrade choice tradeoffs, forge propellant creation |
| Power Systems | 8 | Eclipse survival, power slider triage, panel upgrade path |
| Space Environment | 8 | Solar storms, SAA glitches, Van Allen radiation zones, thermal cycling |
| Materials Science | 10 | Salvage reveals, forge processing, V4 graphene upgrade descriptions |
| Tether Physics | 6 | Range constraints, tension feedback, EDT discovery, gravity gradient |
| Debris Physics | 6 | Kessler events, conjunction warnings, tracking vs untracked |
| Sensors/Comms | 5 | LIDAR scanning, optical comms eclipse blackout, Doppler sonification |
| **TOTAL** | **~65** | **All through gameplay, never through reading** |

---

## 11. Upgrade Tree as Curriculum

The shop/upgrade tree is implicitly a STEM curriculum. Each purchase comes with a one-line real-world explanation:

```
PROPULSION UPGRADES:
├── Krypton fuel option      → teaches Isp vs thrust tradeoff
├── Argon fuel option        → teaches abundance vs performance
├── Ion thruster Mk-II       → teaches Hall-effect scaling
├── Solar-electric hybrid    → teaches power-propulsion coupling
└── Metal-ion FEEP           → teaches field-emission physics

POWER UPGRADES:
├── GaAs solar cells         → teaches cell chemistry
├── Triple-junction cells    → teaches multi-spectral absorption
├── Battery expansion        → teaches energy density (Li-ion vs Li-polymer)
├── Panel gimbals            → teaches sun tracking geometry
└── Radioisotope backup      → teaches nuclear decay power (RTG)

SENSOR UPGRADES:
├── IR scanner               → teaches thermal detection bands
├── LIDAR mapping            → teaches time-of-flight ranging
├── RF triangulation         → teaches radar geometry
├── Debris radar             → teaches space surveillance networks
└── Spectrometer             → teaches spectroscopic material ID

TETHER UPGRADES:
├── V4 GSL fiber             → teaches graphene superlattice
├── HBN coating              → teaches hexagonal boron nitride
├── EDT current amplifier    → teaches Lorentz force scaling
├── Long-range reel          → teaches mechanical engineering
└── Electrostatic activation → teaches dielectric capacitor physics

ARM UPGRADES:
├── Improved FEEP thruster   → teaches field-emission propulsion
├── Larger nets              → teaches Miura-ori deployable structures
├── Gecko pads               → teaches Van der Waals dry adhesion
├── Electrostatic grip       → teaches Coulombic attraction
└── Cold gas RCS upgrade     → teaches reaction control systems
```

**Every upgrade is a mini-lesson.** But the player experiences it as "cool, my arms go further now" — the science is embedded, not imposed.

---

## 12. Communications & Data — Talking Through the Void

### 12.1 Laser Comms vs Radio

The game's existing optical architecture ([V3 §4](archive/V3%20Octopus.md)) provides rich teaching opportunities:

```
SCENARIO: Player sends arm beyond mothership line-of-sight (behind debris)

HUD: "ARM COMMS: SIGNAL DEGRADED — switching to RF backup"
Arm response becomes sluggish (250ms latency added)

Ground: "Your primary link is a 808nm infrared laser — 1 Mbps,
no spectrum license, negligible power. But it requires line of sight.
When the arm goes behind a large object, we fall back to UHF radio
at 9.6 kbps. That's 100× less bandwidth. Control latency increases."

Codex: "NASA's LCRD (Laser Communications Relay Demo, 2021) achieved
1.2 Gbps from geostationary orbit — 100× faster than the best RF links.
The tradeoff: laser beams are incredibly narrow (~50 µrad), so both
ends must point precisely at each other. Rain, clouds, and solid objects
block the signal completely."
```

### 12.2 Ground Station Windows

```
SCENARIO: Player tries to contact ground for a market price check

HUD: "NO GROUND STATION IN VIEW — next window in 14 minutes"
Player must wait — or burn ΔV to reach a different orbit with coverage

Ground (when window opens): "Contact restored via Svalbard ground station."

Codex: "LEO spacecraft see any given ground station for only 5-12 minutes
per pass. NASA's TDRS relay satellites in GEO provide near-continuous
coverage, but your mission uses direct ground links to minimize cost.
Real commercial LEO operators like Planet Labs schedule data dumps
to specific ground stations — they can't just call home whenever."
```

### 12.3 Bandwidth & Data Rates

```
SCENARIO: Player tries to download full LIDAR scan of a large target
while at maximum laser range

HUD progress bar crawls: "SCAN TRANSFER: 23% — limited bandwidth at range"

Ground: "Laser beam spreads with distance. At 2 km, your quad detector
captures the full beam — 1 Mbps. At 10 km (V4 range), the beam is
spread over 1 m² but your detector is only 4 cm². You're catching
~0.15% of the photons — effective rate: 1.5 kbps. Plan your scans
for close approach."

Codex: "Free-space optical link budget: received power drops as 1/r².
Double the distance → quarter the received power → half the data rate
(at best). This is why Starlink uses lasers only for inter-satellite
links at fixed distances, and RF for the variable ground link."
```

### 12.4 Communications Blackout

```
SCENARIO: Mothership passes behind Earth relative to all ground stations

HUD: "COMMS BLACKOUT — autonomous operations only"
No ground station guidance. No market access. No conjunction updates for ~36 min.

Ground (on restoration): "Welcome back, Cowboy. Blackout lasted 34 minutes.
Updating your conjunction database now."

Codex: "Apollo astronauts experienced total blackout for 48 minutes each
orbit around the Moon — the most isolated humans have ever been. In LEO,
blackouts are shorter but still leave you without collision warnings.
This is why autonomous collision avoidance is critical for future
spacecraft."
```

### 12.5 MRR (Modulated Retro-Reflector) — No Power Needed

```
SCENARIO: Spinner arm battery dies while deployed

HUD: "SPINNER-2 BATTERY DEPLETED — switching to passive MRR beacon"
Arm stops thrusting but remains visible on NavSphere (dim dot)

Ground: "The arm's retro-reflector bounces our laser back with encoded
telemetry — no power required. We can track it and receive basic status,
but we can't command it until battery recharges from its solar panel."

Codex: "Modulated Retro-Reflectors are spacecraft 'I'm here' beacons
that need zero power. They reflect incoming laser light with on/off
modulation encoding status data. NASA uses them on lunar ranging
experiments — Apollo reflectors are still bouncing photons 50+ years later."
```

---

## 13. Navigation & Precision — Finding Your Way

### 13.1 Star Trackers

```
SCENARIO: Player enters a region with high background light (sun angle)

HUD: "STAR TRACKER: BLINDED — attitude accuracy degraded"
Arm pilot controls become slightly less precise (small random drift added)

Ground: "Star trackers photograph star patterns and match them against
a catalog to determine your exact attitude. But when the sun or Earth
limb floods the sensor, it can't see stars. We're relying on gyros
until the tracker regains lock."

Codex: "Star trackers achieve 1-5 arcsecond accuracy — enough to point
a laser across 2 km within 1 cm. Every spacecraft from ISS to CubeSats
uses them. Cost has dropped from $500K (2010) to $5K (2025) per unit.
Your mothership has two trackers pointed in different directions for
redundancy — if one is blinded, the other likely sees clear sky."
```

### 13.2 IMU (Inertial Measurement Unit) — Dead Reckoning

```
SCENARIO: Both star trackers temporarily blinded (sun glare event)

HUD: "NAV MODE: IMU ONLY — position drift accumulating"
A small "accuracy cone" appears around target waypoints, growing over time

Ground: "We're on inertial navigation — measuring acceleration with
gyroscopes and accelerometers. It's precise for seconds but drifts
over minutes. NASA calls this 'dead reckoning.' We need star tracker
lock to reset the drift."

Codex: "MEMS gyroscopes drift ~1-10°/hour. Fiber-optic gyros: ~0.001°/hour.
Ring laser gyros (submarine/airliner grade): ~0.0001°/hour.
Your mothership uses a fiber-optic IMU — good enough for 10 minutes of
autonomous operation. The tiny daughter arms have MEMS gyros — cheaper
but they drift 100× faster, which is why the laser link provides
continuous position corrections."
```

### 13.3 Docking Precision — The Final Centimeters

```
SCENARIO: Arm returns with captured debris, approaching docking cavity

HUD: "DOCKING APPROACH — alignment ±2 cm required"
Visual: docking reticle appears with alignment guides (already in DockingReticle.js)

If auto-dock: arms self-align using laser rangefinder + quad detector
If manual: player must center crosshairs (skill challenge!)

Ground: "Docking tolerance is ±2 cm and ±15° cone angle. Our EPM
(Electro-Permanent Magnets) will grab once you're in envelope.
The guide funnel handles the last few millimeters."

Codex: "ISS docking uses a laser range-finder and camera system accurate
to ±3 cm. SpaceX Dragon uses laser eyes (LIDAR) for the final 10 meters.
Our system uses the same laser that powers the arm — it's simultaneously
the docking headlight, range-finder, and alignment beacon."
```

### 13.4 Hydrazine — The Dangerous Legacy Propellant

```
SCENARIO: Player salvages an old satellite, salvage reveals hydrazine residue

HUD: "⚠ HAZMAT: Hydrazine detected — 4.2 kg residual"
Salvage card shows orange hazard border

Ground: "Careful with that one — hydrazine is a toxic monopropellant
used by satellites for decades. It's cheap and reliable but incredibly
poisonous. We can convert it to cold gas equivalent at 60% efficiency
in the processing bay, but handle with care."

Codex: "Hydrazine (N₂H₄) has fueled spacecraft since the 1960s. It
decomposes exothermically over an iridium catalyst — no ignition needed.
But it's a suspected carcinogen that requires SCAPE suits for ground
handling. The space industry is racing to replace it with 'green'
propellants like AF-M315E and LMP-103S. Your Hall thruster uses harmless
noble gases — the future of spacecraft propulsion."

Gameplay: Hydrazine salvage carries a risk multiplier (×1.4 score)
because of the handling hazard. Converting it to cold gas is valuable
but consumes processing time.
```

---

## 14. Attitude Control & Stabilization — Keeping Steady

### 14.1 Reaction Wheels (Flywheels)

```
SCENARIO: Player needs to rotate mothership to point sensors at a debris cluster

Visual: mothership smoothly rotates without any visible thruster fire

Ground: "We're using reaction wheels — spinning flywheels inside the
spacecraft. Speed up a wheel clockwise, the spacecraft rotates
counter-clockwise. Newton's third law. No propellant consumed."

Codex: "Reaction wheels are the primary attitude control for most
spacecraft. ISS uses 4 Control Moment Gyroscopes (CMGs) weighing
300 kg each. Your mothership uses 3 miniature reaction wheels (~1 kg
each) for 3-axis control. They can saturate (spin too fast) —
that's when magnetorquers help desaturate them."

Gameplay: Reaction wheels appear in the power distribution system.
Higher power → faster slew rate (turns faster). Low power → sluggish pointing.
```

### 14.2 Magnetorquers — Earth's Field as a Brake

```
SCENARIO: HUD shows "REACTION WHEEL SATURATION: 78%"

Ground: "Wheels are spinning near max speed. We need to desaturate —
dump the stored angular momentum. Activating magnetorquers."

Visual: subtle animation of current flowing through torquer coils.
Over 2-3 orbits, wheel saturation drops to 20%.

Ground: "Magnetorquers push against Earth's magnetic field to create
torque — like a compass needle being forced off north. Slow (takes
minutes) but uses only electrical power. No fuel."

Codex: "Every CubeSat uses magnetorquers — coils of wire that create
a magnetic dipole. F = ∇(m·B): the force depends on your magnetic
moment and the local field gradient. They can't point you anywhere
instantly, but they're essential for momentum management. Your
daughters use them too — at 3.7 kg, a Spinner can't afford a
reaction wheel, so magnetorquers are its only attitude actuator."
```

### 14.3 Gyroscopes vs Gyroscopes

```
SCENARIO: Player inspects an old navigation satellite in salvage analysis

Salvage card: "Contains: fiber-optic gyroscope (FOG), heritage model"

Ground: "Don't confuse gyroscopes — there are two completely different
devices with the same name. A SENSING gyroscope measures rotation rate
(like the FOG in your IMU). A MOMENTUM gyroscope (reaction wheel)
stores angular momentum for attitude control. Same physics principle
— conservation of angular momentum — but opposite applications."

Codex: "The word 'gyroscope' appears 3 different ways in aerospace:
1) Rate-sensing gyros (MEMS, FOG, RLG) — measure rotation for navigation
2) Reaction/momentum wheels — spin mass for attitude control
3) Control moment gyros (CMGs) — gimbaled momentum wheels for rapid slewing
ISS uses all three types simultaneously."
```

### 14.4 Detumbling Captured Debris

```
SCENARIO: Weaver captures a tumbling defunct satellite (15°/s rotation)

Visual: captured debris spins wildly on the tether. Tether oscillates.
"CAPTURED — TUMBLING — not safe to reel in"

Player must wait for detumble procedure:
- Net cinch tightens (SMA wires)
- Arm's cold gas puffs brake the spin
- Tether tension damps remaining oscillation

Ground: "Tumbling debris is the #1 capture challenge. 90% of defunct objects
tumble at 1-30°/s. We can't reel in until rotation is below 2°/s —
the tether would wrap and tangle. Cold gas braking uses your limited
RCS budget, so minimize it by letting the net's flexibility absorb energy."

Codex: "ESA's MEGALIT study cataloged tumble rates of 600+ defunct objects
using ground-based light curves. Average: 5-10°/s. Worst: >60°/s
(Envisat at 2.9 rpm). Detumbling tech includes eddy current braking,
robotic contact, and net-based angular momentum absorption."
```

---

## 15. Power Systems Deep Dive — Every Watt Counts

### 15.1 Battery Chemistry

```
SCENARIO: Player buys battery upgrade in shop

UPGRADE: Li-Ion → Li-Polymer
Shop: "20% more energy density. Same mass, more Wh. The same chemistry
in your phone, ruggedized for thermal cycling."

UPGRADE: Li-Polymer → Solid-State Li
Shop: "Revolutionary. No liquid electrolyte = no fire risk, no swelling.
40% more energy density. Tested on ISS in 2025."

Codex: "Spacecraft batteries are conservative — they need 50,000+
charge cycles (ISS battery: 35,000 cycles over 15 years). Li-Ion
delivers 150-250 Wh/kg. Solid-state promises 400+ Wh/kg. But the
-120°C to +70°C thermal range in LEO is brutal on any chemistry."
```

### 15.2 Supercapacitors — Burst Power

```
SCENARIO: Player activates electrostatic net (3 kV pulse) — battery
sags momentarily but recovers instantly

Ground: "We used the supercapacitor bank for that — stored charge
at high voltage, discharged in milliseconds. Batteries can't source
that kind of peak current without damage."

Codex: "Supercapacitors store energy in electric fields, not chemical
reactions. 10-100× less energy per kg than batteries, BUT they can
discharge 1000× faster. Your arm's electrostatic capture system needs
a brief 3 kV pulse — a battery would sag, but a supercap delivers
it effortlessly. Also used in camera flashes and defibrillators."

Gameplay: Supercapacitor upgrade enables faster electrostatic activation
and ability to fire multiple net charges in sequence.
```

### 15.3 Thermal Management — The Invisible Challenge

```
SCENARIO: Player's forge overheats during aggressive smelting

HUD: "FORGE TEMP: 320°C — THERMAL LIMIT. Cooling..."
Forge pauses until radiator panels radiate excess heat

Ground: "In space, there's no air to carry heat away. The only cooling
is radiation — infrared photons emitted from radiator panels. Your
forge melts metal at 600-2400°C. All that heat must be radiated to
cold space at ~4 K. Radiator area is your real throughput limiter."

Codex: "The ISS uses 14 ammonia heat-pipe radiator panels — 2,800 ft²
total area. They reject 70 kW of waste heat. For your forge melting 5 kg
batches, you need to radiate ~200W continuously. Stefan-Boltzmann law:
P = εσAT⁴. At 300°C radiator temp with ε=0.9: need ~0.3 m² radiator area.
Your mothership's rear panel handles this."

Gameplay: Thermal management becomes relevant during intensive
operations (forge + all arms + full thrust). Overheating forces
cooldown pauses — an incentive to manage activity bursts.
```

### 15.4 Laser Power Beaming to Daughters

```
SCENARIO: Weaver at 1.5 km range — HUD shows its power source

ARM STATUS: "POWER SOURCE: Laser beamed — 19.5W received"
Arm switches to backup solar as it moves behind an obstacle

Ground: "Your 808nm laser pumps 120W of optical power as a focused beam.
At 2 km, the beam spot is ~20 cm — and the arm's photovoltaic receiver
catches 19.5W. Enough to power its FEEP thruster, sensors, and comms.
No battery needed in direct line-of-sight."

Codex: "Power beaming via laser is actively developed for spacecraft
(JAXA), drones (PowerLight Technologies), and lunar surface ops (NASA).
Key metric: wall-plug to delivered power efficiency. Your system:
60% laser efficiency × 40% PV conversion = ~24% end-to-end. At 10 km
(V4 range), beam spread reduces this to ~1% — arms need EDT propulsion
or solar backup."

Gameplay: Power beaming ties into line-of-sight mechanics. Arm behind
debris = no laser power = running on battery/solar = limited time.
Incentivizes keeping arms in clear sight lines.
```

### 15.5 MLI — Multi-Layer Insulation

```
SCENARIO: Player inspects mothership model closely — sees gold foil wrapping

Ground (if player zooms in on MLI): "That gold foil isn't decorative —
it's Multi-Layer Insulation. Dozens of aluminized Mylar sheets separated
by Dacron mesh. Each layer blocks infrared radiation. Without it, the
sun-facing side would hit +150°C while the shadow side drops to -170°C."

Codex: "MLI is on every spacecraft since the 1960s. Typical: 15-25 layers
of 6µm aluminum-coated Mylar. Effective thermal conductivity: 0.0001 W/m·K
— 5000× better insulator than styrofoam. It only works in vacuum (convection
would short-circuit the layers). Gold-colored Kapton MLI blankets are
the most recognizable feature of spacecraft — and a common salvage item."
```

---

## 16. Avionics & Reliability — The Digital Backbone

### 16.1 Triple Redundancy

```
SCENARIO: Solar particle event causes a bitflip in navigation computer

HUD: brief flicker, then "NAV COMPUTER: SEU CORRECTED — TMR voted 2:1"

Ground: "Single Event Upset — a cosmic ray flipped a bit in processor A.
Processors B and C disagreed, so the voting logic overruled A and
corrected the error. That's Triple Modular Redundancy."

Codex: "In LEO, processors suffer ~0.1-1 Single Event Upsets per MB per
day from cosmic rays and trapped protons. TMR runs three identical
processors in parallel — if one gives a different answer, it's outvoted.
Space-rated processors like the RAD750 ($200K) are designed for this.
Your mothership uses commercial processors with TMR in software —
much cheaper, nearly as reliable."
```

### 16.2 Watchdog Timers & Safe Modes

```
SCENARIO: Power surge during solar storm causes reboot

HUD: Screen goes dark for 2 seconds. Then:
"SAFE MODE ACTIVATED — minimal systems online"
Only core systems active. Arms recalled. Forge offline.

Ground: "A watchdog timer detected the primary computer hadn't checked
in for 500 ms and triggered a safe mode reboot. This is normal.
All spacecraft have this — ISS safe modes automatically configure
sun-pointing for solar power and waits for ground command."

Codex: "Hubble has entered safe mode 16+ times since 1990. Mars rovers
have had multiple safe mode events. Safe mode is NOT a failure —
it's the system working correctly, protecting itself. The spacecraft
powers down non-essential systems, points solar panels at the sun,
and waits. Your mothership recovers in ~30 seconds."
```

### 16.3 Telemetry — Everything Is Measured

```
SCENARIO: Player opens detailed arm status panel

WEAVER-1 TELEMETRY:
  Temperature:     -42°C (nominal: -60 to +80°C)
  Bus voltage:     28.1V (nominal: 28V ±2)
  FEEP current:    12 mA
  Gyro rates:      0.02°/s, -0.01°/s, 0.03°/s
  Tether tension:  14.2 N (limit: 100 N)
  Battery SOC:     73%
  Uptime:          4h 32m 17s
  Packet loss:     0.02%

Ground (first time viewing): "Every sensor, actuator, and subsystem
reports its state 10 times per second. That's telemetry — tele (distant) +
metry (measurement). Your arm sends ~500 parameters. The mothership
logs everything. If something fails, the telemetry record tells us why."

Codex: "ISS downlinks ~300,000 telemetry parameters continuously.
Ground controllers monitor ~3,000 of them in real-time. The famous
'Houston, we've had a problem' was triggered by a telemetry reading —
oxygen tank pressure dropping. Your arms transmit compressed telemetry
via the laser link at 1 Mbps."
```

### 16.4 Error-Correcting Memory

```
SCENARIO: Player upgrades computer in shop

UPGRADE: Standard SRAM → ECC SRAM
Shop: "Error-Correcting Code memory. Detects and fixes single-bit errors
automatically. 2× the mass per byte, but no more cosmic ray bitflips
crashing your targeting computer."

UPGRADE: ECC SRAM → Rad-Hard FRAM
Shop: "Ferroelectric RAM. Non-volatile — survives power loss without
backup batteries. Radiation-tolerant up to 100 krad. Your telemetry
log survives safe mode reboots."

Codex: "The Mars Curiosity rover uses RAD750 processors with 256 MB
radiation-hardened DRAM — it cost $200K for the chip alone. Commercial
ECC memory costs $0.50/MB but needs TMR software. The cost difference
is 400,000×. Your gameplay choice mirrors real mission design:
expensive rad-hard vs cheap-but-redundant."
```

---

## 17. Orbital Environment Degradation — The Slow Killers

### 17.1 Atomic Oxygen — The Silent Eater

```
SCENARIO: After many orbits at low altitude (~300 km), player notices
arm performance degradation

HUD: "SPINNER-3: Surface degradation detected — atomic oxygen erosion"
Arm efficiency drops 2% per 100 orbits below 400 km

Ground: "At low LEO altitudes, your spacecraft plows through residual
atmosphere at 7.5 km/s. Oxygen atoms hit surfaces with 5 eV energy —
enough to break chemical bonds. Polymers, silver, and unprotected
Kapton get etched away. It's like sandblasting in slow motion."

Codex: "Atomic oxygen (AO) eroded 5 mm of Hubble's thermal blankets
over 15 years. The Long Duration Exposure Facility (LDEF) satellite
(1984-1990) recorded dramatic erosion: Kapton lost 5µm per year of
exposure. Below 500 km, AO flux is significant. Your Dyneema tethers
have protective Vectran overbraid specifically for this."

Gameplay: Operating at lower altitudes (200-400 km) where debris is
dense but AO is worst creates a tradeoff. V4 GSL tethers with HBN
coating resist AO better — another upgrade incentive.
```

### 17.2 Solar Wind & UV Degradation

```
SCENARIO: Over many game-hours, solar panel efficiency slowly drops

HUD: "SOLAR PANEL EFFICIENCY: 27.3% (original: 30%)"
Gradual decline visible on power graph

Ground: "Solar UV breaks down the optical coatings on your panels.
High-energy protons from the solar wind displace atoms in the
semiconductor junction. Over 5 years, panels typically lose 10-15%
efficiency. GaAs cells resist this better than silicon — another
reason satellites use them despite 10× the cost."

Codex: "Solar cell degradation in LEO:
  Silicon: -3% per year (unshielded)
  GaAs: -1.5% per year
  Triple-junction: -1% per year
  Perovskite: unknown (not yet flown long-duration)
The ISS solar arrays were designed for 15 years but are now 24+ years
old and significantly degraded. New roll-out arrays are being installed
to compensate."

Gameplay: Panel degradation is slow but relentless. Salvaged GaAs
fragments can restore efficiency — one of the main reasons to
carefully salvage defunct satellite solar panels rather than scrap them.
```

### 17.3 Micrometeorite & Orbital Debris (MMOD) Impacts

```
SCENARIO: Random event — small impact on mothership

HUD: flash + metallic ping sound
"MMOD IMPACT — 0.4 mm particle. No penetration. Surface scoring on Panel-2."
Solar panel 2 efficiency drops 0.1%

Ground: "Micrometeorite strike. Traveling at 20+ km/s, even a grain of
sand packs a punch. Your Whipple shield — two thin aluminum sheets
with a gap — shattered the particle before it reached the pressure wall.
The solar panel took a scratch though."

Codex: "The Whipple shield (invented by Fred Whipple, 1947) is elegant:
the first thin sheet ('bumper') shatters the impactor into a cloud of
fragments that spread out before hitting the back wall. A 1 mm aluminum
bumper stops a 0.5 mm particle at 7 km/s — impossible with a single wall.
ISS has 100+ Whipple shield configurations varying by risk zone."

Gameplay: Rare random event. Very small damage per hit. But over a long
mission, cumulative MMOD scores reduce panel and sensor performance.
Incentivizes not loitering in high-density debris zones longer than needed.
```

### 17.4 Radiation Belt Traversal — Electrons and Protons

```
SCENARIO: Player climbs to 1,500 km altitude for a high-value cluster

HUD: "⚠ RADIATION: Entering inner Van Allen belt fringe"
Radiation counter starts ticking. Electronics noise increases.
Camera: subtle static/grain overlay on edges of screen.

Ground: "You're at 1,500 km — deep into trapped proton territory.
Your electronics are absorbing ~10× their usual radiation dose.
Total Ionizing Dose (TID) accumulates permanently. Every hour up here
costs you weeks of normal-altitude lifetime. Grab your targets and descend."

Codex: "The inner Van Allen belt contains protons up to 400 MeV trapped
by Earth's dipole field. Peak flux at ~3,000 km altitude. Commercial
electronics fail at 10-100 krad TID. Rad-hard parts survive 300+ krad.
Your choice: spend money on rad-hard upgrades to operate safely at
high altitude, or limit exposure time and keep replacement costs low."

Gameplay: High-altitude operations provide access to rare, untouched
debris fields. But radiation dose is a creeping cost — eventually
components need replacement (bought in shop). Rad-hard upgrades in
the avionics tree reduce this long-term maintenance cost.
```

---

## Updated Concept Count

| Category | # Concepts | Sections |
|----------|-----------|----------|
| Orbital Mechanics | 12 | §2 |
| Propulsion | 10 | §3 |
| Power Systems | 13 | §4, §15 |
| Space Environment | 8 | §5 |
| Materials Science | 10 | §6 |
| Tether Physics | 6 | §7 |
| Debris Physics | 6 | §8 |
| Sensors/Comms | 10 | §9, §12 |
| Navigation/Precision | 6 | §13 |
| Attitude Control | 6 | §14 |
| Avionics/Reliability | 6 | §16 |
| Environmental Degradation | 6 | §17 |
| **TOTAL** | **~99** | **All through gameplay** |

---

## Updated Upgrade Tree as Curriculum

Add to the existing upgrade entries in §11:

```
COMMUNICATIONS UPGRADES:
├── RF backup antenna        → teaches radio vs optical tradeoffs
├── TDRS relay access        → teaches relay satellite architecture
├── High-gain laser          → teaches beam divergence & link budget
├── Encryption module        → teaches space cybersecurity (real concern!)
└── Deep space beacon        → teaches signal propagation & attenuation

NAVIGATION UPGRADES:
├── Dual star tracker        → teaches redundancy in navigation
├── FOG IMU                  → teaches inertial navigation drift
├── GPS receiver (below 500km) → teaches GNSS constellation coverage
├── Precision docking LIDAR  → teaches time-of-flight ranging precision
└── Orbit determination kit  → teaches Kalman filtering (conceptually)

STABILIZATION UPGRADES:
├── Enhanced reaction wheels → teaches angular momentum storage
├── Magnetorquer upgrade     → teaches desaturation & Lorentz torque
├── CMG (Control Moment Gyro) → teaches gimbaled momentum control
├── Bias momentum wheel      → teaches spin stabilization
└── Daughter cold-gas upgrade → teaches reaction control authority

AVIONICS UPGRADES:
├── ECC memory               → teaches error correction in radiation
├── Rad-hard processor       → teaches radiation effects on silicon
├── Watchdog timer V2        → teaches safe mode architecture
├── Redundant flight computer → teaches TMR voting systems
└── Black box recorder       → teaches telemetry logging & forensics

THERMAL UPGRADES:
├── Extended radiator         → teaches Stefan-Boltzmann radiation law
├── Heat pipe network         → teaches capillary-driven heat transfer
├── Phase-change thermal mass → teaches latent heat energy storage
├── Cryogenic cooler (sensors)→ teaches IR sensor thermal noise
└── MLI blanket repair kit    → teaches multi-layer insulation physics
```

---

*Space Cowboy — Learning Through Play*
*~99 real aerospace concepts taught through gameplay consequences, not lectures.*
*The game doesn't teach physics. Physics teaches the game.*
*New categories: Communications (§12), Navigation (§13), Attitude Control (§14), Power Deep Dive (§15), Avionics (§16), Environmental Degradation (§17).*
