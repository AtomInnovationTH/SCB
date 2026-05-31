# Game Flow Brainstorm — Tools, Guidance, Delight, Rewards

> **Companion to:** [`DAUGHTER_ARM_CONTROLS.md`](DAUGHTER_ARM_CONTROLS.md), [`FIRST_EXPERIENCE.md`](FIRST_EXPERIENCE.md), [`BIG_PICTURE.md`](BIG_PICTURE.md), [`LEARNING_THROUGH_PLAY.md`](LEARNING_THROUGH_PLAY.md)  
> **Purpose:** Deep brainstorm on the moment-to-moment experience: why the player keeps playing, why each tool is needed, how the game guides without nagging, and how mastery feels rewarding.

---

## 0. Reading Map

| Want to know... | Go to |
|---|---|
| What does the player feel at minute 1, 5, 30, 90? | §1 |
| Why doesn't the web/net always work? | §2 |
| Which tool for which debris? | §3 |
| How does the game keep me unstuck? | §4 |
| What makes the moment **feel good**? | §5 |
| What's the tension that keeps me playing? | §6 |
| What rewards keep me coming back? | §7 |
| Five engineered "wow" moments | §8 |

---

## 1. The Player Journey — First 90 Minutes

### 1.1 Minute 0–3 — "Beautiful, but what do I do?"

Player presses START. Earth fills the screen. Stars wheel slowly. The mothership glints in sunrise terminator light. Comms whispers: *"Houston copies. Find something to clean up."*

**Goal:** Awe → curiosity. The view alone should hold attention for 30 s while the brain inventories controls.

**Mechanic active:** Stable checklist (top-left, ghosted): `○ Scan [S]  ○ Target [Tab]  ○ Approach [A]  ○ Capture`.

### 1.2 Minute 3–8 — "I caught my first piece!"

Player presses S → ping sound, target panel reveals 7 debris. Picks closest (200 m, 0.4 kg fragment). Autopilot to 100 m. Hits Space → **Bolas/Lasso** wraps it. Slow-mo, green flash, *+50 credits*. Skill discovered: "First Capture."

**The hook:** It just *worked*. The player feels competent in 5 minutes.

### 1.3 Minute 8–20 — "Why isn't this working anymore?"

Player keeps lassoing fragments. Now closest target is 1.2 km. Tries to fly mother closer — ΔV gauge moves visibly. *Wait, fuel matters?* Comms: *"Lasso range 50 m. That fragment is 1.2 km out. Try a daughter arm — press D."*

Fires daughter. Watches it deploy (visual + audio thwack). Daughter autopilots into position. **Now what?** ↑↓←→ orbit indicator appears. Player learns: I'm the brain, daughter is the body.

**The pivot:** Game stops being "press button to capture" and becomes "choose the right tool, position, capture."

### 1.4 Minute 20–45 — "Why won't the web stick to this thing?"

Player encounters a tumbling rocket body (8 m, 1500 kg, spinning 35°/s). Fires Weaver. Net deploys. **Net misses** — the rocket's spin grabs one corner and slings the net away. Comms: *"Target tumbling too fast. Detumble first — try the laser [L]."*

Player learns: tumbling is real. Tools have failure modes. The catalog deepens.

### 1.5 Minute 45–90 — "Spinning plates"

Now the player has 3 daughters out, an EDT generating 0.2 mN free thrust, a Geomagnetic storm warning (50 minutes to hit), 4 captured items in cargo waiting for the Forge, and a high-value satellite drifting toward debris cloud (8 minutes to collision).

**Decision:** Recall daughters? Burn for the satellite? Tank the storm? Forge the cargo?

This is the game. **Resource management → time pressure → spinning plates → flow state.**

---

## 2. Why the Web (Net) Fails — Specific Failure Modes

The net is the **default workhorse** ([§29 BIG_PICTURE.md](BIG_PICTURE.md)). It handles 80% of uncooperative debris. But it is *not* universal. Each failure mode teaches a real ADR lesson and unlocks a counter-tool.

### 2.1 The Eight Failure Modes

| # | Failure mode | Symptom | Root cause | Counter-tool | TRL |
|---|---|---|---|---|---|
| 1 | **High tumble (>10°/s)** | Net slings off corner | Angular momentum > net mass × tether | Laser detumble (despun) | 5 |
| 2 | **Smooth ferromagnetic surface** | Net slides off curved hull | No purchase points; no mesh entanglement | Magnetic grapple (EPM/electromagnet) | 9 |
| 3 | **Tiny fragment (<10 cm)** | Net flies past it | Fragment passes through 0.5 cm mesh | Gecko/electrostatic pad on Spinner | 4–5 |
| 4 | **Massive intact body (>2,000 kg)** | Net contacts but doesn't envelop | Bag-it-and-drag-it fails on rigid bodies | Harpoon + slow drag (RemoveDEBRIS) | 7 |
| 5 | **Solar panel / fragile structure** | Net captures but breaks panels off | Net cinch crushes thin structures | Adhesion pad (gecko, no compression) | 4 |
| 6 | **Highly conductive (charged)** | Net repelled or arcs | Triboelectric / spacecraft charging | Discharge wand → grapple, or wait for plasma equalization | 6 |
| 7 | **Tethered/cabled debris** | Net catches but cable snags | Other debris dragged into capture | Cable cutter (laser pulse) before net | 6 |
| 8 | **Active satellite (treaty-protected)** | Houston REFUSES — RED ALERT | International law (active sat in catalog) | Code-blocked, no tool helps | n/a |

### 2.2 The Decision Cascade

```
INSPECT debris (close approach in STATION_KEEP)
    │
    ├── Tumble rate?
    │     ├── < 10°/s  → net works
    │     └── > 10°/s  → laser detumble FIRST
    │
    ├── Mass?
    │     ├── < 10 kg     → Spinner with multi-modal pad
    │     ├── 10–500 kg   → Weaver with net (default)
    │     ├── 500–2000 kg → Dual-Weaver purse-seine
    │     └── > 2000 kg   → Harpoon + slow drag (or skip)
    │
    ├── Surface type?
    │     ├── Mesh-friendly (truss, panels) → net
    │     ├── Smooth ferrous (rocket body)   → magnetic grapple
    │     ├── Smooth non-ferrous (Al hull)    → gecko + electrostatic
    │     ├── Fragile (thin solar panels)    → adhesion pad only
    │     └── Conductive (active old sat)    → discharge first
    │
    └── Geometry?
          ├── Convex (envelopable)        → net
          ├── Has protruding feature      → grapple-fixture
          ├── Has cables/tethers attached → cable-cut FIRST
          └── No grip features at all     → adhesion or harpoon
```

### 2.3 Game-Mechanic Implication

The first few hours teach:
1. **Not every tool fits every debris** (lasso → daughter → net → laser → magnet → gecko)
2. **Inspection is mandatory** — you must STATION_KEEP and look before committing
3. **Tools have prerequisites** (laser requires tumble detection, magnet requires ferrous detection)

The mid-game teaches **combos**:
- Laser detumble → net capture (most common 2-step)
- Cable-cut → net (clearing a tangled fragment)
- Discharge wand → magnetic grapple (defunct sat)
- Gecko pad → reel back → forge for high-value alloys (precision salvage)

---

## 3. The Tool Catalog — When and Why

### 3.1 The Seven-Tool Kit

| Tool | Range | Best for | Mechanism | TRL |
|---|---|---|---|---|
| **Bolas** (was Lasso) | 50 m | Small, slow, near-by | Spinning weighted line wraps debris | 9 |
| **Net (Weaver)** | 2 km | Medium, tumbling, mesh-grippable | Miura-ori fold, SMA cinch | 7 |
| **Net (Spinner)** | 500 m | Small, fast-react needed | 1.5 m fast-deploy net | 7 |
| **Magnetic grapple** | 5–50 m contact | Ferrous (rocket bodies, old sat hardware) | Electromagnet/EPM | 9 |
| **Gecko pad** | Contact | Smooth, low-mass, fragile | Van der Waals dry adhesion | 5 |
| **Electrostatic pad** | Contact | Conductive, rough | 3 kV Coulombic | 4 |
| **Harpoon** | 100 m | Massive, stable, large flat surface | 1.5 kg dart, barbed | 7 |
| **Laser detumble** | 500 m (mother), 50 m (daughter) | Anything tumbling >10°/s | Photon ablation despin | 5 |
| **EDT** (propulsion) | n/a | Free orbital ΔV | Lorentz force on conductive tether | 7 |

### 3.2 Tool Acquisition Ladder

| Year | Hours | Tools unlocked | Why |
|---|---|---|---|
| Y0 start | 0–5 | Bolas, Spinner net, Weaver net | Game basics |
| Y0 mid | 5–15 | Magnetic grapple, Laser detumble | First capture failures teach the need |
| Y1 | 15–30 | Gecko pad, Multi-modal pad | TRL upgrades unlock |
| Y2 | 30–80 | Electrostatic, EDT propulsion, Harpoon | Mid-game variety |
| Y3 | 80–150 | Mussel-catechol UV-cure adhesive | Late-game flex |
| Y4 | 150+ | MPD thruster, 500 W power-beam | End-game power fantasy |

Tools are not just "more damage" — each opens **new debris types** the player couldn't capture before.

### 3.3 The Multi-Modal Pad — Octopus Sucker Inspiration

The Spinner's secondary tool is a **multi-modal capture pad** ([§29 BIG_PICTURE.md](BIG_PICTURE.md), [§7 V3 Octopus.md](archive/V3%20Octopus.md)) that combines five mechanisms in one device:

```
   ┌──────────────────────────┐
   │  Multi-modal capture pad  │
   │                           │
   │  [gecko]   [hooks]        │  ← VdW adhesion + 3M dual-lock
   │  [electro] [magnet]       │  ← Coulombic + NdFeB
   │  [UV-cure adhesive dose]  │  ← Catechol/mussel-protein
   └──────────────────────────┘

   On contact, the pad fires whichever mode the surface accepts:
     - Smooth Al hull → gecko bites
     - Fabric MLI → micro-hooks engage
     - Steel bolt → permanent magnet snaps
     - Conductive surface → electrostatic if powered
     - "Last resort" → UV adhesive dose (10 doses/Spinner)

   The player's job is to GET THE PAD TO TOUCH the debris. The pad
   figures out which adhesion mode wins. This rewards positioning
   over tool-selection.
```

**Octopus metaphor:** Like a real octopus sucker that adapts to whatever surface it touches — taste-grip-manipulate in one neuro-mechanical structure. Real engineering: JPL, Stanford, JAXA all converging on multi-modal pads as the future of small-debris capture.

---

## 4. Guidance — The Anti-Frustration System

Players get stuck. The art is keeping them unstuck **without nagging**.

### 4.1 The Five-Layer Guidance Hierarchy

| Layer | Trigger | Example | Priority |
|---|---|---|---|
| **L0 Comms ambient** | Low-priority, quiet voice | *"Beautiful aurora tonight."* | Background |
| **L1 Skills checklist** | Visible, top-left, stable | `○ Scan [S]  ✓ Target [Tab]  ○ Approach [A]` | Always-on |
| **L2 Reticle hints** | When target selected | "Range 800 m — out of net range" | On-demand |
| **L3 Failure feedback** | After failed action | "Net tangled — target tumbling too fast" | Reactive |
| **L4 Houston intervention** | After 60 s of inaction | *"Cowboy? Need a hand?"* with suggested action | Last resort |

**Rule:** Never suggest a tool the player hasn't unlocked. Never suggest the same thing twice. After 3 unhelpful suggestions, fall silent and trust the player.

### 4.2 The "5-Failure Pity Mechanic"

If the player fails 5 captures in a row (any mechanism), Houston offers a contextual escape:

```
Failure 1-2: Silent (player should explore)
Failure 3:   Subtle — "Target tumbling. [L] for laser detumble."
Failure 4:   Visible — large reticle showing "TUMBLE: 35°/s — TOO FAST"
Failure 5:   Houston: "Cowboy, that target's not your weight class. 
              Press Tab to find an easier mark."
```

This respects player agency (some players love the challenge) while preventing frustration spirals.

### 4.3 Comms Tone — Two-Channel Voice (Houston + Bangalore)

The mothership launches from **India** (ISRO), so comms is bilateral: a US partner CAPCOM and the primary Indian Mission Operations team. Both personas are **dry, encouraging, never condescending**.

#### CAPCOM Personas

| Persona | Voice | Heritage | When |
|---|---|---|---|
| **HOUSTON** | American CAPCOM, Apollo-13 dry humor | NASA/JSC tradition | Standard ops, US-side debris, treaty consults |
| **BANGALORE** (ISTRAC) | Indian Mission Ops, formal-warm | ISRO Telemetry Tracking & Command Network | Mission-critical, India-launched assets, Indian Ocean ground track |
| **HASSAN** (MCF) | Indian GEO operations | ISRO Master Control Facility | GEO missions (Thaicom 4, INSAT/GSAT cleanup), GEO transfer burns |

#### Tone Examples (Both Houston & Bangalore)

| Situation | Wrong tone | HOUSTON | BANGALORE |
|---|---|---|---|
| First capture | "🎉 GREAT JOB!!!" | *"Got it. That's one less hazard."* | *"Spacecraft, ISTRAC. Capture confirmed. Excellent."* |
| Failed net | "FAILURE" | *"Slipped through. Tumble's too fast for nets — try the laser."* | *"Spacecraft, ISTRAC. Net deployment unsuccessful. Recommend laser detumble first."* |
| Low fuel | "URGENT! REFUEL!" | *"Tank's getting light. Forge run might be overdue."* | *"Spacecraft, ISTRAC. Propellant margin critical. Suggest Forge cycle this orbit."* |
| Big catch | "AMAZING!" | *"Whew. That was 3 metric tons of dead weight. Drinks on Houston."* | *"Spacecraft, ISTRAC. Outstanding work, Cowboy. ISRO sends regards."* |
| Handoff | — | *"Cowboy, your AOS at Bangalore in 02:14. We'll hand off then."* | *"Spacecraft, Bangalore. We have the conn. Welcome, Cowboy."* |

**Voice references:**
- HOUSTON: Tom Hanks in *Apollo 13*. Mission Control humor: dry, technical, warm.
- BANGALORE/HASSAN: ISRO Mission Control during Chandrayaan-3 landing (real audio publicly available). Formal address ("Spacecraft, ..."), warm closure, technical precision.

The bilingual register makes the player feel they're piloting an **internationally-supported mission**, not a single-flag operation. ISRO ground stations + Indian launch sites are detailed in [`FINAL_ANALYSIS.md §5A`](archive/FINAL_ANALYSIS.md).

### 4.4 The "Codex Whisper"

When the player **first encounters a phenomenon** (Van Allen belt, EDT thrust, geomagnetic storm), a small icon flashes top-right. Hovering reveals a one-paragraph **Codex** entry. Click expands to full historical/technical context.

This is the **stealth education layer**. Players who want to play don't have to read. Players who want to learn get a Wikipedia-quality reference.

---

## 5. Delight Catalog — What Makes Each Moment Feel Good

### 5.1 Visual Delight

| Moment | Visual treatment | Why it works |
|---|---|---|
| Capture | 0.3 s slow-mo + green particle burst + reticle ring contracts | Marks success; cinematic without overwhelming |
| Crossbow fire | Recoil flash on mother + visible spring decompression on arm | Tactile mechanism; you SEE the energy transfer |
| Net deploy | Miura-ori unfold with ripple animation | Origami beauty; makes a 3 s wait feel like art |
| Tether under tension | Color shifts blue (slack) → yellow → red | Real-time pressure gauge as a 3D object |
| Laser detumble | Visible ablation puffs from target with soft glow | Photon thrust made visible (real plumes are invisible) |
| Sunrise terminator | Camera bias toward limb; cloud layer parallax | Astronaut moment; daily reward |
| Aurora | Earth's polar regions glow during solar storms | Ties space weather to gameplay visibly |
| Earth night side | City lights, lightning flashes, moonlit clouds | Reminds you what you're protecting |
| Forge sparks | Levitating molten metal sample with mag-field arcs | Industrial process beauty |
| Magnetic capture | Iron-filing visualization of field lines for 1 s | Makes invisible force visible |

### 5.2 Audio Delight

| Sound | Implementation | Triggers |
|---|---|---|
| **Crossbow THWACK** | Compressed-spring release + metallic reverb | Daughter launch |
| **Net silk-flutter** | High-frequency synthesis + slight Doppler | Net unfolds in vacuum (creative liberty) |
| **Tether tension hum** | Sine wave 60 Hz, pitch rises with tension | Continuous during pull |
| **Magnetic clack** | Sudden low-end thud | EPM lock |
| **FEEP whisper** | Soft hiss, barely audible | Constant station-keeping |
| **Geomagnetic storm** | Subharmonic rumble + crackle | When Kp index rises |
| **Kessler cascade** | Distant tinkles → growing roar | Late-game escalation |
| **Houston voice** | Vocoded, slight VHF compression | Comms persona |
| **Forge furnace** | Inductive heater hum + sample melt cycle | Refinement process |
| **Successful capture** | Three-note ascending chord (do-mi-sol) | Reward signal |
| **Failed capture** | Single descending tritone | Failure flag |
| **Spacewalk silence** | Total silence except suit breathing & comms | Reminds you you're alone |

### 5.3 Gameplay Delight

| Moment | Mechanic | Feeling |
|---|---|---|
| Watching daughter autopilot work | Camera follows; visible thrust corrections | "I built this thing and it's smart" |
| Plotting an EDT-only orbital change | Free thrust pulses with magnetic field strength | "I'm using physics for free" |
| Successful detumble | Spin rate ticks down on HUD | "I tamed it" |
| Multi-arm coordination | 3 daughters working different debris simultaneously | Octopus power fantasy |
| Forge yields gallium | Codex unlocks, FEEP options expand | "My choice paid off" |
| Sunrise during a capture | Lighting shift mid-action | Cinematography by physics |
| Houston quotes Apollo 13 | Random easter-egg comms callouts | Cultural pat on the back |
| Hot-key combo "D P" | Deploy + auto-pilot in one motion | Speedrun tier |

---

## 6. Tension & Spinning Plates — Why the Player Stays

### 6.1 The Three Resources

The game has **three** simultaneous resource pressures, never one:

| Resource | Refill | Drain | Tension type |
|---|---|---|---|
| **ΔV (mothership fuel)** | Forge metals → propellant | Every burn, every recall | Strategic — runs the mission |
| **FEEP fuel (per arm)** | Replaced on dock + reload | Every approach, every station-keep | Tactical — runs the capture |
| **Time / orbits** | Never refills | Real-time + accelerated time | Dramatic — sets the pace |

A skilled player optimizes all three. A new player will overspend ONE and learn.

### 6.2 The "Spinning Plates" Threshold

Around minute 30–60, a confluence of events creates the first true challenge:

```
PLATE 1: 3 daughters out, 1 returning with debris (need to dock)
PLATE 2: Geomagnetic storm in 12 minutes (degrade FEEP, crit power)
PLATE 3: High-value defunct sat drifting toward debris cloud (must intercept)
PLATE 4: Cargo bay 80% full (must Forge or drop)
PLATE 5: Mothership ΔV at 120 m/s (low — careful with burns)

Player must: triage. Dock arm. Forge. Choose: storm hide or sat chase.
```

This is the moment the game's depth becomes visible. Before: simple loop. After: real mission planning.

### 6.3 Anti-Burnout — "Cool-Down" Phases

Every 30 minutes of high-tension play, the game eases back:
- Empty sky moment (no debris in range)
- Sunrise terminator slow-pan
- Forge progress bar (4 minute idle process)
- Houston tells a Mercury-program anecdote
- "Earth from space" Cassini-style camera bias

These deliberate quiet moments **prevent fatigue** and let the player breathe. Like the lull between waves in a survival game.

---

## 7. Rewards — Why the Player Returns

### 7.1 The Seven Reward Currencies

| Currency | Source | Spent on | Feel |
|---|---|---|---|
| **Credits** | Capture, Forge | Shop upgrades | Tangible progress |
| **Skills** | First-time actions | Codex unlocks, hotkeys | Mastery proof |
| **Codex entries** | Discovery | New content; reading reward | Curiosity payoff |
| **TRL upgrades** | Game-time + credits | New tools (gecko, EDT, MPD) | Tech tree progression |
| **Forge metals** | Refining captured debris | FEEP propellant variants, structural | Crafting agency |
| **Reputation** | Mission completion, low-collateral | Houston attitude, mission types | Story payoff |
| **Easter eggs** | Hidden behaviors, perfect runs | Codex side-stories, sounds | Connoisseur reward |

### 7.2 FEEP Metal Variants — Dual-Metal Y0 Baseline (TRL 7-8)

Per [§4.3 LEARNING_THROUGH_PLAY.md](LEARNING_THROUGH_PLAY.md), FEEP can ionize many metals. **Important TRL note (corrected):** Dual-metal FEEP thrusters are **flight-demonstrated today** — Enpulsion's IFM Nano series flies indium + secondary metal as a single thruster. This is **not** future tech.

**The Y0 baseline assumption:** Every daughter arm ships from factory with a **dual-metal FEEP** capable of running indium OR a refined alternative metal. Player's task is to refine + load alt-metal cartridges from the Forge.

| Tier | Metal | Source | Isp range | Thrust per W | Special | TRL |
|---|---|---|---|---|---|---|
| **Y0 default** | **Indium** | Mined / shop / Forge from generic debris | 4,000–19,000 s | 0.032 mN/W | Solid; ambient storage; safest | 9 |
| **Y0 unlock** | **Gallium** | Forge from electronics debris | 6,000–25,000 s | 0.028 mN/W | **Melts at 30°C** — needs 2W heater | 7 |
| **Y1 unlock** | **Iodine** | Forge from medical sat debris | 2,000–4,500 s | 0.060 mN/W | Sublimes; high thrust low Isp; cheap | 7 |
| **Y1 unlock** | **Bismuth** | Forge from heatsinks | 2,500–8,000 s | 0.045 mN/W | Highest thrust per W in tier | 6 |
| **Y2 unlock** | **Mercury** | Forge from old switchgear | 3,000–10,000 s | 0.040 mN/W | Liquid; easy inject; **toxic codex warning** | 5 |
| **Y2 unlock** | **Cesium** | Forge from rare sat | 8,000–22,000 s | 0.030 mN/W | **Reactive** — codex warning | 5 |
| **Y4 endgame** | **Tungsten** | Forge from heat shields | 1,500–3,500 s | 0.080 mN/W | Requires MPD-class power | 4 |

**Player choice (Y0):** Stick with safe indium, or load a gallium cartridge for higher Isp (and budget 2 W heater power)?

**Player choice (Y1+):** Each Forge cycle is a strategic decision — bismuth for fast repositioning now, or stockpile cesium for the GEO mission later?

This is **early-game depth**, not mid-game. The dual-metal mechanic appears in the first 2 hours of play, teaching the player that **propellant choice matters as much as where you point the engine**.

### 7.3 Surprise Rewards (Easter Eggs)

| Trigger | Reward |
|---|---|
| Catch a Vanguard 1 fragment | Codex: "1958 — first solar-powered satellite. Still up there." |
| Catch a Soviet-era body | Houston: *"Cosmos something. Thanks for the language lesson."* |
| Successfully recover a Hubble panel | "Worth more than its weight in gold. NASA wants it." |
| Catch all 8 NORAD-tracked items in a session | "Achievement: Full Catalog Sweep" + cosmetic skin |
| EDT-only orbital change | Codex: "Look up Lorentz force. Free thrust." |
| Catch debris during eclipse | Visual: stars-only ambient + Houston whispering |
| Detumble + capture in single approach | Skill: "Surgeon" |
| Multi-arm 3-piece simultaneous capture | Skill: "Octopus Hands" |
| First gallium FEEP burn | Houston: *"Pretty colors, Cowboy. That's a gallium plume."* |
| Surf a tether under tension to reel home | Skill: "Yo-yo Master" |
| Catch a piece you yourself dropped | Houston: *"Oops. Glad we tracked that one down."* |

### 7.4 The Long-Tail Tech Ladder

```
Y0 → Y4 progression takes ~150 hours but has natural exit ramps:

  Y0 (0-30h):   Master core loop. Bolas + Daughter + Net.
  Y1 (30-50h):  Add detumble, magnetic, gecko. Optimize ΔV.
  Y2 (50-80h):  Multi-arm coordination. EDT propulsion. Shop refinement.
  Y3 (80-120h): Forge mastery. Ablation. Power beaming.
  Y4 (120+h):  MPD thrusters. 500W beam. Theoretical end-game.

  Each "Y" is a satisfying stopping point. The player never needs to reach Y4
  to feel complete — but the tech keeps unfolding for those who chase it.
```

---

## 8. Five Engineered "Wow" Moments

These are the deliberate set-pieces every player should encounter naturally:

### 8.1 First Daughter Deploy
- Crossbow recoil shakes mother visibly
- Daughter autonomously navigates while player watches
- Tether visibly pays out, animates
- *"I built a robot that knows where to go."*

### 8.2 First Detumble + Capture Combo
- Aim laser at tumbling rocket body
- Watch spin rate tick down on HUD: 35°/s → 30 → 25 → 18 → 8 → 4
- Comms: *"Tumble in spec. Net it."*
- Daughter shoots net, captures cleanly
- *"I just orchestrated a 3-step orbital ballet."*

### 8.3 First EDT Propulsion Burn
- Player toggles EDT (Y key)
- HUD shows: ΔV gain WITHOUT fuel consumption
- Mother gently raises orbit over minutes
- Codex: "Lorentz force. Free thrust."
- *"I'm using Earth's magnetic field as a free engine."*

### 8.4 Surviving a Geomagnetic Storm
- Storm warning: 30 min countdown
- Player triages: dock daughters, deorbit risky cargo, brace power
- Storm hits: Kp = 7, FEEP throughput drops 40%, comms degrades
- HUD goes red, ambient sound shifts to subharmonic rumble
- 30 minutes later: storm passes, systems restore, new debris from the storm itself
- *"I survived a thing I didn't know existed an hour ago."*

### 8.5 First Forge Surprise
- Player Forges captured cargo expecting aluminum
- Sample yields **gallium arsenide** (rare; from a defunct GPS sat)
- Codex unlocks: "Solar panel material. III-V semiconductor."
- Shop now offers: "GaAs panels — +25% solar efficiency"
- *"I didn't know debris could yield rare materials."*

---

## 9. The "Why Keep Playing?" Loop

```
                    ┌──────────────────┐
                    │  CAPTURE A THING  │
                    └──────────┬─────────┘
                               │
                               ▼
                    ┌──────────────────┐
                    │ DISCOVER NEW INFO │  ← Codex entry, skill, easter egg
                    └──────────┬─────────┘
                               │
                               ▼
                    ┌──────────────────┐
                    │  UPGRADE OR PIVOT  │  ← New tool, new metal, new orbit
                    └──────────┬─────────┘
                               │
                               ▼
                    ┌──────────────────┐
                    │  TARGET PROGRESSED │  ← Bigger, harder, more strategic
                    └──────────┬─────────┘
                               │
                               └─── back to top, deeper.
```

Every loop iteration adds either **mechanical depth** (a new tool to use) or **knowledge depth** (a new physical concept understood) or **emotional depth** (a new Houston moment). The game's promise: *Every 30 minutes, you will know something new about how spacecraft really work.*

---

## 10. Implementation Hooks (for Code Mode)

When this brainstorm becomes code, these are the existing systems to extend:

| Brainstorm idea | Existing system | Hook |
|---|---|---|
| Tool failure modes (§2) | [`ArmUnit.js`](js/entities/ArmUnit.js) capture states | Add `_evaluateNetCapture()` returning failure type |
| Failure feedback comms (§4) | [`CommsSystem.js`](js/systems/CommsSystem.js) | Wire failure events to contextual messages |
| Multi-modal pad (§3.3) | [`ArmUnit.js`](js/entities/ArmUnit.js) Spinner config | New tool ID + capture logic |
| FEEP metal variants (§7.2) | [`ResourceSystem.js`](js/systems/ResourceSystem.js) + [`Constants.js`](js/core/Constants.js) | Per-metal Isp/thrust constants |
| Houston anecdotes (§5.3) | [`CommsSystem.js`](js/systems/CommsSystem.js) ambient queue | Random idle-state pulls |
| Easter eggs (§7.3) | [`SkillsSystem.js`](js/systems/SkillsSystem.js) + [`CatalogLoader.js`](js/systems/CatalogLoader.js) | NORAD-keyed special triggers |
| Detumble combo (§8.2) | New laser system | Module: `LaserDetumbleSystem.js` |
| Storm survival (§8.4) | [`SpaceWeatherSystem.js`](js/systems/SpaceWeatherSystem.js) | Already partially implemented |

---

## 11. Summary

Space Cowboy's appeal is **flow through layered depth**:

1. **Minute 1**: Beautiful, intriguing.
2. **Minute 5**: First capture — competent.
3. **Minute 30**: First failure — humble.
4. **Hour 1**: First combo — skilled.
5. **Hour 5**: First spinning plates — strategic.
6. **Hour 50**: First gallium FEEP — connoisseur.
7. **Hour 150**: MPD thrusters online — legend.

The web/net **must fail** in interesting ways to create demand for the rest of the toolkit. Each tool **must teach a real engineering concept** (TRL, ΔV, electrodynamics, adhesion physics, tether dynamics). Each reward **must reveal new depth** (a Codex entry, a metal variant, a Houston quip).

The player isn't grinding — they're **learning to operate spacecraft, one elegant problem at a time**. The game is a love letter to ADR engineering disguised as an action-strategy sim.
